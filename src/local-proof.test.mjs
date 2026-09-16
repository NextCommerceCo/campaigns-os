// Local proof mode: under deploy.target local-serve the build stage renders
// the development environment, the served output is proven there, and the
// production render is proven to differ only in environment-gated output
// before commit. A capture over plain HTTP that failed on a cross-origin
// http: dependency names the rebuild, never a template edit.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

import { buildNextActions, doctorPacket, nextStage, pageKitParityCommand } from "./cli.mjs";
import { HIDDEN_EAGER_MEDIA_ACTIONS } from "./gate-actions.mjs";
import {
  compareRenderedOutputs,
  LOCAL_PROOF_BUILD_COMMAND,
  LOCAL_PROOF_NEVER_EDIT_RULE,
  renderedPagePin,
} from "./local-proof.mjs";
import { plainHttpDependencyFailures } from "./polish-capture.mjs";
import {
  capturePolishPageLoad,
  evaluateRecordedHiddenEagerMediaCheckpoint,
  mergePolishPageLoadEvidence,
} from "./polish-node.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const BUILD_FINGERPRINT = `sha256:${"a".repeat(64)}`;

// The tracked fixture is copied into a temp dir; nothing here writes into
// examples/target-page-kit (scripts/check-fixtures.mjs guards it).
function packetFixture(t, mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-local-proof-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(ROOT, "examples/target-page-kit"), join(dir, "target-page-kit"), { recursive: true });
  cpSync(join(ROOT, "examples/source-html"), join(dir, "source-html"), { recursive: true });
  cpSync(join(ROOT, "examples/campaignspec.v42.basic.json"), join(dir, "campaignspec.v42.basic.json"));
  const packetPath = join(dir, "campaign-runtime.build.json");
  const packet = JSON.parse(readFileSync(join(ROOT, "examples/build-packet.basic.json"), "utf8"));
  packet.deploy.target = "local-serve";
  mutate(packet);
  writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  return { dir, packetPath, packet, targetRepo: join(dir, "target-page-kit") };
}

function writeReport(targetRepo, mutate = () => {}) {
  const report = JSON.parse(readFileSync(join(ROOT, "examples/assembly-report.example.json"), "utf8"));
  report.stages.assembly.status = "completed";
  report.stages.assembly.build_fingerprint = BUILD_FINGERPRINT;
  if (!report.stages.assembly.evidence || Array.isArray(report.stages.assembly.evidence)) report.stages.assembly.evidence = {};
  mutate(report);
  mkdirSync(join(targetRepo, ".campaign-runtime"), { recursive: true });
  const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

async function runCli(argv, { cwd }) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...argv], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: cwd, CAMPAIGNS_OS_TELEMETRY: "off", CAMPAIGNS_OS_LIFECYCLE_LOG: "" },
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: error.code ?? 1, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

const codes = (issues) => issues.map((issue) => issue.code);

// ---------------------------------------------------------------------------
// 1. The build stage under local-serve is a development build
// ---------------------------------------------------------------------------

test("next's build actions under local-serve run page-kit in the development environment and name the parity check", () => {
  const base = { packetPath: "/campaigns/demo/campaign-runtime.build.json", themeGate: null, polishGate: null, ambient: null };
  const local = buildNextActions({ ...base, result: { stage: "build" }, packet: { deploy: { target: "local-serve" } } });
  const build = local.find((action) => action.id === "build_local_proof");
  assert.ok(build, JSON.stringify(local));
  assert.equal(build.command, "CPK_ENV=development npx campaign-build --json > .campaign-runtime/page-kit-build-summary.json");
  assert.match(build.description, /record stages\.assembly\.evidence\.build_environment as "development"/);
  assert.match(build.description, /Never edit a generated include/);
  const parity = local.find((action) => action.id === "build_production_parity");
  assert.ok(parity, JSON.stringify(local));
  assert.match(parity.command, /page-kit parity --packet \/campaigns\/demo\/campaign-runtime\.build\.json$/);
  const netlify = buildNextActions({ ...base, result: { stage: "build" }, packet: { deploy: { target: "netlify" } } });
  assert.equal(netlify.some((action) => action.id === "build_local_proof"), false, "a hosted target builds production as before");
});

test("next build under local-serve hands off the development build command and the never-edit rule in the prompt", (t) => {
  const { packetPath } = packetFixture(t);
  const result = nextStage("build", { packet: packetPath, "no-write": true });
  assert.equal(result.stage, "build");
  assert.match(result.prompt, /Local proof mode \(deploy\.target is local-serve\): run the page-kit build in the development environment — `CPK_ENV=development npx campaign-build --json > \.campaign-runtime\/page-kit-build-summary\.json`/);
  assert.match(result.prompt, /record stages\.assembly\.evidence\.build_environment as "development"/);
  assert.match(result.prompt, /page-kit parity --packet/);
  assert.match(result.prompt, /Never edit a generated include/);
});

test("doctor under local-serve warns until the completed build is recorded as a development render and parity is recorded", (t) => {
  const { packetPath, targetRepo } = packetFixture(t);
  writeReport(targetRepo);
  const unrecorded = doctorPacket(packetPath, { write: false });
  const environment = unrecorded.warnings.find((issue) => issue.code === "local_proof.build_environment");
  assert.ok(environment, JSON.stringify(unrecorded.warnings));
  assert.match(environment.message, /stages\.assembly\.evidence\.build_environment is not recorded/);
  assert.match(environment.message, /Never edit a generated include/);
  const parity = unrecorded.warnings.find((issue) => issue.code === "local_proof.production_parity");
  assert.ok(parity, JSON.stringify(unrecorded.warnings));
  assert.match(parity.message, /page-kit parity --packet/);

  writeReport(targetRepo, (report) => {
    report.stages.assembly.evidence.build_environment = "production";
  });
  const production = doctorPacket(packetPath, { write: false });
  assert.match(production.warnings.find((issue) => issue.code === "local_proof.build_environment").message, /is "production" under deploy\.target local-serve/);

  writeReport(targetRepo, (report) => {
    report.stages.assembly.evidence.build_environment = "development";
    report.stages.assembly.evidence.local_proof = {
      production_parity: { status: "pass", build_fingerprint: BUILD_FINGERPRINT, summary: "3 page(s) identical to the current development render; production differs only in environment-gated output (12 line(s)); Campaign Cart pin 0.4.18.", pages: [], first_difference: null },
    };
  });
  const recorded = doctorPacket(packetPath, { write: false });
  assert.equal(codes(recorded.warnings).some((code) => code.startsWith("local_proof.")), false, JSON.stringify(recorded.warnings));
  assert.ok(recorded.ready.some((line) => line.startsWith("Local proof production parity: PASS — 3 page(s)")), JSON.stringify(recorded.ready));
  assert.ok(recorded.ready.some((line) => line.startsWith("Local proof mode: the built _site/ is recorded as a development render")), JSON.stringify(recorded.ready));

  writeReport(targetRepo, (report) => {
    report.stages.assembly.evidence.build_environment = "development";
    report.stages.assembly.evidence.local_proof = {
      production_parity: { status: "fail", build_fingerprint: BUILD_FINGERPRINT, summary: "sdk_pin_mismatch", pages: [], first_difference: { kind: "sdk_pin_mismatch", route: "/runtime-packet-demo/checkout/", path: "checkout/index.html", line: null, detail: "Campaign Cart loader differs." } },
    };
  });
  const failed = doctorPacket(packetPath, { write: false });
  const error = failed.errors.find((issue) => issue.code === "local_proof.production_parity");
  assert.ok(error, JSON.stringify(failed.errors));
  assert.match(error.message, /^Production parity FAILED — first non-gated difference: sdk_pin_mismatch at \/runtime-packet-demo\/checkout\//);

  writeReport(targetRepo, (report) => {
    report.stages.assembly.evidence.build_environment = "development";
    report.stages.assembly.evidence.local_proof = {
      production_parity: { status: "pass", build_fingerprint: `sha256:${"b".repeat(64)}`, summary: "old", pages: [], first_difference: null },
    };
  });
  const stale = doctorPacket(packetPath, { write: false });
  assert.match(stale.warnings.find((issue) => issue.code === "local_proof.production_parity").message, /was recorded for build sha256:b+, but stages\.assembly\.build_fingerprint is now/);
});

// ---------------------------------------------------------------------------
// 2. Production parity
// ---------------------------------------------------------------------------

const LOADER = (version) => `<script src="https://cdn.jsdelivr.net/gh/NextCommerceCo/campaign-cart@v${version}/dist/loader.js" type="module"></script>`;
const GATED_BLOCK = [
  "<script>",
  "  (function(w,d,s,l,i){j.src='https://www.googletagmanager.com/gtm.js?id='+i;})(window,document,'script','dataLayer','GTM-TEST');",
  "</script>",
  "<script>(function(){var n=\"//j.northbeam.io/ota-sp/client.js\";var a=document.createElement(\"script\");a.src=n;document.head.appendChild(a);})()</script>",
];

function page({ version = "0.4.18", gated = false, extra = "" } = {}) {
  return [
    "<!DOCTYPE html>",
    "<html><head>",
    '<meta name="next-api-key" content="pk_test">',
    '<script src="/demo/config.js"></script>',
    LOADER(version),
    ...(gated ? GATED_BLOCK : []),
    '<link href="/demo/css/next-core.css" rel="stylesheet">',
    "</head><body>",
    `<main data-next-page="checkout">${extra}</main>`,
    "</body></html>",
    "",
  ].join("\n");
}

function rendered(t, layout) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-parity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const roots = {};
  for (const [root, pages] of Object.entries(layout)) {
    roots[root] = join(dir, root);
    for (const [path, html] of Object.entries(pages)) {
      mkdirSync(join(dir, root, "demo", path), { recursive: true });
      writeFileSync(join(dir, root, "demo", path, "index.html"), html);
    }
  }
  return roots;
}

test("production parity passes when production differs from the proven development output only in an environment-gated block", (t) => {
  const dev = { "": page(), checkout: page() };
  const prod = { "": page({ gated: true }), checkout: page({ gated: true }) };
  const roots = rendered(t, { proven: dev, development: dev, production: prod });
  const result = compareRenderedOutputs({ provenRoot: roots.proven, developmentRoot: roots.development, productionRoot: roots.production, slug: "demo", expectedSdkVersion: "0.4.18" });
  assert.equal(result.status, "pass", JSON.stringify(result));
  assert.equal(result.first_difference, null);
  assert.equal(result.page_count, 2);
  assert.equal(result.sdk_version, "0.4.18");
  assert.deepEqual(result.pages.map((entry) => [entry.route, entry.gated_inserted_lines, entry.gated_removed_lines, entry.gated_hosts]), [
    ["/demo/checkout/", 4, 0, ["//j.northbeam.io", "https://www.googletagmanager.com"]],
    ["/demo/", 4, 0, ["//j.northbeam.io", "https://www.googletagmanager.com"]],
  ]);
  assert.match(result.summary, /^2 page\(s\) identical to the current development render; production differs only in environment-gated output \(8 line\(s\); loaders: \/\/j\.northbeam\.io, https:\/\/www\.googletagmanager\.com\); Campaign Cart pin 0\.4\.18\.$/);
});

test("production parity fails, naming the page, when the production render pins a different Campaign Cart version", (t) => {
  const dev = { "": page(), checkout: page() };
  const prod = { "": page({ gated: true }), checkout: page({ gated: true, version: "0.4.19" }) };
  const roots = rendered(t, { proven: dev, development: dev, production: prod });
  const result = compareRenderedOutputs({ provenRoot: roots.proven, developmentRoot: roots.development, productionRoot: roots.production, slug: "demo" });
  assert.equal(result.status, "fail");
  assert.equal(result.first_difference.kind, "sdk_pin_mismatch");
  assert.equal(result.first_difference.route, "/demo/checkout/");
  assert.match(result.first_difference.detail, /campaign-cart@v0\.4\.18\/dist\/loader\.js\) and the production render \(.*campaign-cart@v0\.4\.19\/dist\/loader\.js\)/);
  assert.match(result.summary, /^sdk_pin_mismatch at \/demo\/checkout\//);
});

test("production parity fails on a pin that moved after the proof, on a production build served as the proof, and on a page-set difference", (t) => {
  const proven = { "": page(), checkout: page() };
  const drifted = rendered(t, {
    proven,
    development: { "": page({ version: "0.4.20" }), checkout: page({ version: "0.4.20" }) },
    production: { "": page({ version: "0.4.20", gated: true }), checkout: page({ version: "0.4.20", gated: true }) },
  });
  const drift = compareRenderedOutputs({ provenRoot: drifted.proven, developmentRoot: drifted.development, productionRoot: drifted.production, slug: "demo" });
  assert.equal(drift.status, "fail");
  assert.equal(drift.first_difference.kind, "sdk_pin_drift");
  assert.match(drift.first_difference.detail, /pins Campaign Cart 0\.4\.18 but the current source renders 0\.4\.20/);

  const servedProduction = rendered(t, {
    proven: { "": page({ gated: true }), checkout: page({ gated: true }) },
    development: proven,
    production: { "": page({ gated: true }), checkout: page({ gated: true }) },
  });
  const production = compareRenderedOutputs({ provenRoot: servedProduction.proven, developmentRoot: servedProduction.development, productionRoot: servedProduction.production, slug: "demo" });
  assert.equal(production.first_difference.kind, "proven_output_is_production");
  assert.equal(production.first_difference.line, 6);
  assert.match(production.first_difference.detail, new RegExp(`Rebuild with ${LOCAL_PROOF_BUILD_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  const stale = rendered(t, {
    proven: { "": page(), checkout: page(), upsell: page() },
    development: proven,
    production: { "": page({ gated: true }), checkout: page({ gated: true }) },
  });
  const pages = compareRenderedOutputs({ provenRoot: stale.proven, developmentRoot: stale.development, productionRoot: stale.production, slug: "demo" });
  assert.equal(pages.first_difference.kind, "page_not_in_source");
  assert.equal(pages.first_difference.route, "/demo/upsell/");

  const edited = rendered(t, {
    proven,
    development: { "": page(), checkout: page({ extra: "<p>new copy</p>" }) },
    production: { "": page({ gated: true }), checkout: page({ gated: true, extra: "<p>new copy</p>" }) },
  });
  const copy = compareRenderedOutputs({ provenRoot: edited.proven, developmentRoot: edited.development, productionRoot: edited.production, slug: "demo" });
  assert.equal(copy.first_difference.kind, "proven_output_stale");
  assert.equal(copy.first_difference.route, "/demo/checkout/");
  assert.equal(copy.first_difference.line, 8);
});

test("the rendered pin reader finds the Campaign Cart loader and the next-api-key meta and ignores other loaders", () => {
  assert.deepEqual(renderedPagePin(page()), {
    sdk_loader_src: "https://cdn.jsdelivr.net/gh/NextCommerceCo/campaign-cart@v0.4.18/dist/loader.js",
    sdk_version: "0.4.18",
    api_key_meta: "pk_test",
  });
  assert.deepEqual(renderedPagePin('<script src="/demo/js/lazy-loader.js"></script>'), { sdk_loader_src: null, sdk_version: null, api_key_meta: null });
});

test("page-kit parity refuses a packet whose deploy target is not local-serve and rejects unknown flags", async (t) => {
  const { dir, packetPath } = packetFixture(t, (packet) => {
    packet.deploy.target = "netlify";
  });
  const result = pageKitParityCommand({ _: ["page-kit", "parity"], packet: packetPath });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.errors), ["local_proof.parity.not_local_serve"]);
  assert.match(result.errors[0].message, /^deploy\.target is "netlify", not local-serve\. Production parity compares the served DEVELOPMENT build in _site\//);
  assert.throws(() => pageKitParityCommand({ _: ["page-kit", "parity"], packet: packetPath, force: true }), /Unknown flag for page-kit parity: --force/);
  const run = await runCli(["page-kit", "parity", "--packet", packetPath, "--json"], { cwd: dir });
  assert.equal(run.status, 2);
  assert.equal(JSON.parse(run.stdout).errors[0].code, "local_proof.parity.not_local_serve");
});

test("page-kit parity needs a completed build and reports the target's page-kit as unavailable without touching the fixture", (t) => {
  const { packetPath, targetRepo } = packetFixture(t);
  const before = readdirSync(targetRepo).sort();
  const pending = pageKitParityCommand({ _: ["page-kit", "parity"], packet: packetPath });
  assert.equal(pending.ok, false);
  assert.deepEqual(codes(pending.errors), ["local_proof.parity.report_missing"]);
  writeReport(targetRepo, (report) => {
    report.stages.assembly.status = "pending";
  });
  const notBuilt = pageKitParityCommand({ _: ["page-kit", "parity"], packet: packetPath });
  assert.deepEqual(codes(notBuilt.errors), ["local_proof.parity.build_pending"]);
  writeReport(targetRepo, (report) => {
    report.stages.assembly.evidence.build_environment = "development";
  });
  const unavailable = pageKitParityCommand({ _: ["page-kit", "parity"], packet: packetPath });
  assert.equal(unavailable.ok, false);
  assert.deepEqual(codes(unavailable.errors), ["local_proof.parity.unavailable"]);
  assert.match(unavailable.errors[0].message, /next-campaign-page-kit is not installed in the target repo/);
  assert.deepEqual(readdirSync(targetRepo).sort(), [...before, ".campaign-runtime"].sort(), "no render lands in the target");
});

// ---------------------------------------------------------------------------
// 3. A production build captured over plain HTTP names the rebuild, not an edit
// ---------------------------------------------------------------------------

function packetWithPages(pages) {
  return {
    schema_version: "campaign-runtime-build-packet/v0",
    campaign: { public_route_slug: "merchant", route_root: "/merchant/" },
    spec: { map_id: "map-test" },
    assembly: { target_repo: "." },
    deploy: { target: "local-serve" },
    source_html: { pages },
  };
}

function completedReport() {
  return {
    schema_version: "campaign-runtime-assembly-report/v0",
    run_id: "asm_test",
    identity: { map_id: "map-test", public_route_slug: "merchant", spec_hash: `sha256:${"b".repeat(64)}` },
    inputs: { packet_path: "campaign-runtime.build.json" },
    stages: {
      assembly: { stage: "assembly", status: "completed", build_fingerprint: BUILD_FINGERPRINT },
      polish: { stage: "polish", status: "pending", evidence: { visual_review: { screenshots: [".campaign-runtime/polish/landing.png"] } } },
    },
    waivers: [],
  };
}

async function captureWithFailedLoader(baseUrl, loaderUrl) {
  const packet = packetWithPages([{ page_id: "landing", path: "landing.html", page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" } }]);
  const capture = await capturePolishPageLoad({
    packet,
    report: completedReport(),
    baseUrl,
    createBrowserAdapter: async () => ({
      async captureRoute({ url, viewport }) {
        return {
          finalDocumentUrl: url,
          responseCollectionStatus: "complete",
          networkidle: { status: "settled", duration_ms: 250 },
          mediaElements: [],
          responses: [
            {
              request_id: `${viewport.key}-document`,
              url,
              resource_type: "Document",
              status: 200,
              mime_type: "text/html",
              encoded_data_length: 1_024,
              is_final_main_document: true,
              document_context_fingerprint: `sha256:${"d".repeat(64)}`,
            },
            { request_id: `${viewport.key}-loader`, url: loaderUrl, resource_type: "Script", failed: true },
          ],
        };
      },
      async close() {},
    }),
  });
  const report = mergePolishPageLoadEvidence(completedReport(), capture.page_load);
  return { capture, checkpoint: evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report }) };
}

test("a capture over plain HTTP that failed on a cross-origin http: script names the local proof rebuild ahead of recapture", async () => {
  const { capture, checkpoint } = await captureWithFailedLoader("http://localhost:4302", "http://j.vendor.example/ota-sp/client.js");
  assert.equal(capture.page_load.measurement.status, "incomplete");
  assert.ok(capture.page_load.measurement.incomplete.every((cell) => cell.problem_codes.includes("dependency_request_failed")));
  assert.equal(plainHttpDependencyFailures(capture.page_load.captures[0]).length, 1);
  assert.equal(checkpoint.status, "blocked");
  assert.equal(checkpoint.code, "polish.hidden_eager_media.capture_incomplete");
  assert.deepEqual(checkpoint.required_actions.map((action) => action.id), [
    "polish.hidden_eager_media.local_proof_rebuild",
    "polish.hidden_eager_media.capture",
  ]);
  const rebuild = checkpoint.required_actions[0];
  assert.equal(rebuild.kind, "manual");
  assert.match(rebuild.description, /^The served build is a production build over plain HTTP/);
  assert.match(rebuild.description, /`CPK_ENV=development npx campaign-build --json > \.campaign-runtime\/page-kit-build-summary\.json`/);
  assert.match(rebuild.description, /Never edit a generated include \(analytics-head\.html, analytics-body\.html/);
});

test("the same failure off an https: origin, or a same-origin http: failure, keeps the plain recapture action", async () => {
  const https = await captureWithFailedLoader("https://preview.example.test", "http://j.vendor.example/ota-sp/client.js");
  assert.deepEqual(https.checkpoint.required_actions.map((action) => action.id), ["polish.hidden_eager_media.capture"]);
  const firstParty = await captureWithFailedLoader("http://localhost:4302", "http://localhost:4302/merchant/js/missing.js");
  assert.deepEqual(firstParty.checkpoint.required_actions.map((action) => action.id), ["polish.hidden_eager_media.capture"]);
  const secure = await captureWithFailedLoader("http://localhost:4302", "https://j.vendor.example/ota-sp/client.js");
  assert.deepEqual(secure.checkpoint.required_actions.map((action) => action.id), ["polish.hidden_eager_media.capture"]);
});

test("polish capture text prints the rebuild action with the never-edit rule", async (t) => {
  const { formatPolishCaptureText } = await import("./cli.mjs");
  const { checkpoint, capture } = await captureWithFailedLoader("http://localhost:4302", "http://j.vendor.example/ota-sp/client.js");
  const text = formatPolishCaptureText({ status: "blocked", measurement: capture.page_load.measurement, checkpoint, observed_findings: [] });
  const actions = text.split("\n").filter((line) => line.startsWith("Required action: "));
  assert.equal(actions.length, 2, text);
  assert.match(actions[0], /^Required action: The served build is a production build over plain HTTP/);
  assert.match(actions[0], /Never edit a generated include/);
  assert.match(actions[1], /polish capture --packet <packet> --base-url <url>$/);
  t.diagnostic(actions[0].length > 0 ? "rebuild action rendered" : "missing");
});

// ---------------------------------------------------------------------------
// 4. No next-action or repair text proposes editing a generated include
// ---------------------------------------------------------------------------

test("no action or next-action text proposes editing a generated include to make a capture pass", () => {
  for (const action of Object.values(HIDDEN_EAGER_MEDIA_ACTIONS)) {
    const proposesEdit = /\b(?:edit|patch|rewrite|force)\b[^.]{0,80}\b(?:analytics-head|analytics-body|_includes|https:)/i.test(action.description);
    if (proposesEdit) assert.match(action.description, /Never edit a generated include/, action.id);
  }
  assert.match(LOCAL_PROOF_NEVER_EDIT_RULE, /^Never edit a generated include/);
  const sources = readdirSync(join(ROOT, "src")).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"));
  for (const name of sources) {
    const text = readFileSync(join(ROOT, "src", name), "utf8");
    for (const line of text.split("\n")) {
      if (!/\b(?:edit|patch|rewrite|force)\b[^.\n]{0,80}\b(?:analytics-head\.html|analytics-body\.html)/i.test(line)) continue;
      assert.match(line, /[Nn]ever edit|not a repair|not a template defect/, `${name}: ${line.trim()}`);
    }
  }
});
