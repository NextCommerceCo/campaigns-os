// Local proof mode: under deploy.target local-serve the build stage renders
// the development environment, the served output is proven there, and the
// production render is proven to differ only in environment-gated output
// before commit. A capture over plain HTTP that failed on a cross-origin
// http: dependency names the rebuild, never a template edit.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

import { buildNextActions, nextStage, pageKitParityCommand } from "./cli.mjs";
import { doctorPacket } from "./doctor/inspect.mjs";
import { HIDDEN_EAGER_MEDIA_ACTIONS } from "./gate-actions.mjs";
import { currentPacketInputs, inputStamps } from "./input-currency.mjs";
import {
  compareRenderedOutputs,
  LOCAL_PROOF_BUILD_COMMAND,
  LOCAL_PROOF_NEVER_EDIT_RULE,
  renderedPagePin,
} from "./local-proof.mjs";
import { plainHttpDependencyFailures } from "./polish-capture.mjs";
import { carried, HOSTED_TEMPLATE_PREVIEW_POLICY } from "./local-preview-policy.mjs";
import { shellToken } from "./shell-token.mjs";
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
function packetFixture(t, mutate = () => {}, prefix = "campaigns-os-local-proof-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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

function posixWords(command) {
  return execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\n' "$@"`], { encoding: "utf8" }).trimEnd().split("\n");
}

// ---------------------------------------------------------------------------
// 1. The build stage under local-serve is a development build
// ---------------------------------------------------------------------------

test("next's build actions under local-serve run page-kit in the development environment and name the parity check", () => {
  const base = { packetPath: "/campaigns/demo/campaign-runtime.build.json", themeGate: null, polishGate: null, ambient: null };
  const local = buildNextActions({ ...base, result: { stage: "build" }, packet: { deploy: { target: "local-serve" } } });
  const build = local.find((action) => action.id === "build_local_proof");
  assert.ok(build, JSON.stringify(local));
  assert.equal(build.command, "CPK_ENV=development npx campaign-build --json > .campaign-runtime/page-kit-build-summary.json");
  assert.match(build.description, /record build --packet \/campaigns\/demo\/campaign-runtime\.build\.json --build-environment development, which sets stages\.assembly\.evidence\.build_environment to "development"/);
  const skill = local.find((action) => action.id === "build_skill");
  assert.match(skill.description, /record build --packet \/campaigns\/demo\/campaign-runtime\.build\.json --build-environment development\.$/);
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
  assert.match(result.prompt, /then record build before polish: `campaigns-os record build --packet \S+ --build-environment development --adapter-decision <key>=<value>\[,<key>=<value>\.\.\.\]`\. Record the value that is true for this build/);
  assert.match(result.prompt, /record build --packet \S+ --build-environment development`, which sets stages\.assembly\.evidence\.build_environment to "development"/);
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

test("CRLF renders compare like LF ones: byte-identical CRLF pages pass with zero gated lines, and line numbers count CRLF lines", (t) => {
  const crlf = (html) => html.replace(/\n/g, "\r\n");
  const dev = { "": crlf(page()), checkout: crlf(page()) };
  const identical = rendered(t, { proven: dev, development: dev, production: dev });
  const same = compareRenderedOutputs({ provenRoot: identical.proven, developmentRoot: identical.development, productionRoot: identical.production, slug: "demo" });
  assert.equal(same.status, "pass", JSON.stringify(same));
  assert.deepEqual(same.pages.map((entry) => [entry.gated_inserted_lines, entry.gated_removed_lines, entry.gated_hosts]), [[0, 0, []], [0, 0, []]]);
  assert.match(same.summary, /\(0 line\(s\)\); Campaign Cart pin 0\.4\.18\.$/);

  const gated = rendered(t, { proven: dev, development: dev, production: { "": crlf(page({ gated: true })), checkout: crlf(page({ gated: true })) } });
  const withGate = compareRenderedOutputs({ provenRoot: gated.proven, developmentRoot: gated.development, productionRoot: gated.production, slug: "demo" });
  assert.equal(withGate.status, "pass");
  assert.deepEqual(withGate.pages.map((entry) => entry.gated_inserted_lines), [4, 4]);
  assert.deepEqual(withGate.pages[0].gated_hosts, ["//j.northbeam.io", "https://www.googletagmanager.com"]);

  const stale = rendered(t, { proven: dev, development: { "": crlf(page()), checkout: crlf(page({ extra: "<p>new copy</p>" })) }, production: { "": crlf(page({ gated: true })), checkout: crlf(page({ gated: true, extra: "<p>new copy</p>" })) } });
  const edited = compareRenderedOutputs({ provenRoot: stale.proven, developmentRoot: stale.development, productionRoot: stale.production, slug: "demo" });
  assert.equal(edited.first_difference.kind, "proven_output_stale");
  assert.equal(edited.first_difference.line, 8);
});

test("a page that renders no Campaign Cart loader fails parity on its own code, whichever page comes first", (t) => {
  const noLoader = page().replace(LOADER("0.4.18"), "<!-- loader removed -->");
  const lost = rendered(t, { proven: { "": page(), checkout: noLoader }, development: { "": page(), checkout: noLoader }, production: { "": page({ gated: true }), checkout: noLoader } });
  const missing = compareRenderedOutputs({ provenRoot: lost.proven, developmentRoot: lost.development, productionRoot: lost.production, slug: "demo" });
  // Pages compare in sorted path order: checkout/index.html (no loader) is
  // read first, so the root page is the one that disagrees with it.
  assert.equal(missing.status, "fail");
  assert.equal(missing.first_difference.kind, "sdk_loader_missing");
  assert.equal(missing.first_difference.route, "/demo/");
  assert.match(missing.first_difference.detail, /^this page pins Campaign Cart 0\.4\.18 while \/demo\/checkout\/ renders no loader\.$/);

  const later = rendered(t, { proven: { "": noLoader, checkout: page() }, development: { "": noLoader, checkout: page() }, production: { "": noLoader, checkout: page() } });
  const lostLater = compareRenderedOutputs({ provenRoot: later.proven, developmentRoot: later.development, productionRoot: later.production, slug: "demo" });
  assert.equal(lostLater.first_difference.kind, "sdk_loader_missing");
  assert.equal(lostLater.first_difference.route, "/demo/");
  assert.match(lostLater.first_difference.detail, /^this page renders no Campaign Cart loader while \/demo\/checkout\/ pins 0\.4\.18\.$/);

  const none = rendered(t, { proven: { "": noLoader }, development: { "": noLoader }, production: { "": noLoader } });
  const allMissing = compareRenderedOutputs({ provenRoot: none.proven, developmentRoot: none.development, productionRoot: none.production, slug: "demo" });
  assert.equal(allMissing.status, "pass");
  assert.equal(allMissing.sdk_version, null);
  assert.match(allMissing.summary, /Campaign Cart pin not rendered\.$/);
});

test("the parity next action shell-quotes the packet path", () => {
  const base = { themeGate: null, polishGate: null, ambient: null, result: { stage: "build" }, packet: { deploy: { target: "local-serve" } } };
  const spaced = buildNextActions({ ...base, packetPath: "/campaigns/my demo/campaign-runtime.build.json" });
  assert.match(spaced.find((action) => action.id === "build_production_parity").command, /page-kit parity --packet '\/campaigns\/my demo\/campaign-runtime\.build\.json'$/);
});

test("local deploy and Polish next actions preserve a packet path with spaces", () => {
  const packetPath = "/campaigns/my demo/campaign-runtime.build.json";
  const base = { packetPath, packet: { deploy: { target: "local-serve" } }, themeGate: null, polishGate: null, ambient: null };
  const deploy = buildNextActions({ ...base, result: { stage: "deploy" } });
  const advance = deploy.find((action) => action.id === "advance");
  assert.equal(posixWords(advance.command)[3], packetPath, "local deploy advance must preserve the packet path");
  const deployRecord = deploy.find((action) => action.id === "deploy").description.match(/record deploy --packet (.+?) --base-url/);
  assert.equal(posixWords(`record deploy --packet ${deployRecord[1]} --base-url placeholder`)[3], packetPath, "local deploy record command must preserve the packet path");

  const polish = buildNextActions({ ...base, result: { stage: "polish" } });
  const polishRecord = polish.find((action) => action.id === "polish_skill").description.match(/record polish --packet (.+?) --evidence/);
  assert.equal(posixWords(`record polish --packet ${polishRecord[1]} --evidence placeholder`)[3], packetPath, "Polish record command must preserve the packet path");
});

test("hosted carried gate stays blocked without a usable preview URL", () => {
  const gate = { status: "blocked", code: "polish.report_missing", reason: "Polish evidence is missing." };
  for (const packet of [null, {}, { deploy: {} }, { deploy: { preview_url: "" } }, { deploy: { preview_url: "not a URL" } }]) {
    assert.equal(carried(gate, HOSTED_TEMPLATE_PREVIEW_POLICY, packet), gate, JSON.stringify(packet));
  }
});

test("page-kit parity records a pass on the report, and a pass it could not record is not a pass", (t) => {
  const { packetPath, targetRepo } = packetFixture(t);
  const reportPath = writeReport(targetRepo, (report) => {
    report.stages.assembly.evidence.build_environment = "development";
  });
  const passing = () => ({ status: "pass", campaign_slug: "runtime-packet-demo", page_count: 1, sdk_version: "0.4.18", pages: [], first_difference: null, summary: "1 page(s) identical …", checked_at: "2026-09-16T00:00:00.000Z", environment: { proven: "development", compared: "production" } });
  const recorded = pageKitParityCommand({ _: ["page-kit", "parity"], packet: packetPath }, { runProductionParityCheck: passing });
  assert.equal(recorded.ok, true);
  assert.equal(recorded.status, "pass");
  assert.equal(recorded.written, true);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.stages.assembly.evidence.local_proof.production_parity.status, "pass");
  assert.equal(report.stages.assembly.evidence.local_proof.production_parity.build_fingerprint, BUILD_FINGERPRINT);
  assert.equal(report.stages.assembly.evidence.build_environment, "development", "the rest of the evidence object is kept");

  const failing = () => ({ ...passing(), status: "fail", first_difference: { kind: "sdk_pin_mismatch", route: "/runtime-packet-demo/", path: "index.html", line: null, detail: "x" }, summary: "sdk_pin_mismatch at /runtime-packet-demo/: x" });
  const failed = pageKitParityCommand({ _: ["page-kit", "parity"], packet: packetPath }, { runProductionParityCheck: failing });
  assert.equal(failed.ok, false);
  assert.deepEqual(codes(failed.errors), ["local_proof.production_parity"]);
  assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).stages.assembly.evidence.local_proof.production_parity.status, "fail", "a fail is recorded too");

  // An unwritable sidecar directory: the atomic write's temp file cannot be created.
  if (process.getuid?.() === 0) return;
  chmodSync(join(targetRepo, ".campaign-runtime"), 0o500);
  let unrecorded;
  try {
    unrecorded = pageKitParityCommand({ _: ["page-kit", "parity"], packet: packetPath }, { runProductionParityCheck: passing });
  } finally {
    chmodSync(join(targetRepo, ".campaign-runtime"), 0o700);
  }
  assert.equal(unrecorded.ok, false);
  assert.equal(unrecorded.status, "record_failed");
  assert.equal(unrecorded.written, false);
  assert.equal(unrecorded.parity.status, "pass", "the comparison is still reported");
  assert.deepEqual(codes(unrecorded.errors), ["local_proof.parity.report_not_written"]);
  assert.match(unrecorded.errors[0].message, /^Parity was checked \(pass\) but could not be recorded on /);
  assert.deepEqual(codes(unrecorded.warnings), []);
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
  const sources = readdirSync(join(ROOT, "src"), { recursive: true }).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"));
  for (const name of sources) {
    const text = readFileSync(join(ROOT, "src", name), "utf8");
    for (const line of text.split("\n")) {
      if (!/\b(?:edit|patch|rewrite|force)\b[^.\n]{0,80}\b(?:analytics-head\.html|analytics-body\.html)/i.test(line)) continue;
      assert.match(line, /[Nn]ever edit|not a repair|not a template defect/, `${name}: ${line.trim()}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The local preview policy: missing polish and page-load evidence is carried
// forward as a warning on a local-serve packet served from loopback, and stays
// a blocker everywhere else.
// ---------------------------------------------------------------------------

function templateStockFixture(t, deploy, prefix) {
  const fixture = packetFixture(t, (packet) => {
    Object.assign(packet.deploy, deploy);
    packet.source_html.pages = packet.source_html.pages.map((page) => ({ page_id: page.page_id, skip_reason: "template stock: no design source" }));
  }, prefix);
  writeReport(fixture.targetRepo, (report) => {
    report.stages.assembly.evidence.build_environment = "development";
    report.stages.polish = { status: "required", required_by: "build", required_for: ["qa"] };
  });
  return fixture;
}

const POLISH_MISSING_CODES = ["polish.evidence_missing", "polish.report_missing", "polish.hidden_eager_media.no_capturable_routes"];

test("a template-stock build carries missing polish forward on local and hosted previews, but not production", async (t) => {
  const { __qaNodeTestHooks } = await import("./qa-node.mjs");
  const { computeDisposition } = await import("./qa-verdict.mjs");
  const cases = [
    { name: "local preview", deploy: { target: "local-serve", preview_url: "http://localhost:8080/runtime-packet-demo/" }, carried: true },
    { name: "hosted preview", deploy: { target: "netlify", preview_url: "https://preview.example.test/runtime-packet-demo/", production_url: "https://www.example.test/runtime-packet-demo/" }, carried: true },
    { name: "hosted preview without production URL", deploy: { target: "netlify", preview_url: "https://preview.example.test/runtime-packet-demo/", production_url: undefined }, carried: true },
    { name: "hosted preview equal to production", deploy: { target: "netlify", preview_url: "https://preview.example.test/runtime-packet-demo/", production_url: "https://preview.example.test/runtime-packet-demo/" }, carried: false },
    { name: "hosted preview equal to production after URL normalization", deploy: { target: "netlify", preview_url: "https://preview.example.test/runtime-packet-demo/", production_url: "https://preview.example.test/runtime-packet-demo" }, carried: false },
    { name: "hosted production URL with a preview query", deploy: { target: "netlify", preview_url: "https://www.example.test/runtime-packet-demo/?preview=1", production_url: "https://www.example.test/runtime-packet-demo/" }, carried: false },
    { name: "local-serve on a non-loopback host", deploy: { target: "local-serve", preview_url: "http://192.0.2.10:8080/runtime-packet-demo/" }, carried: false },
  ];
  for (const { name, deploy, carried } of cases) {
    const { packetPath } = templateStockFixture(t, deploy);
    if (name === "hosted preview without production URL") {
      assert.equal(Object.hasOwn(JSON.parse(readFileSync(packetPath, "utf8")).deploy, "production_url"), false, name);
    }
    const doctor = doctorPacket(packetPath, { write: false });
    const checkpoint = doctor.derived.polish_checkpoint_gate;
    assert.equal(checkpoint.code, "polish.hidden_eager_media.no_capturable_routes", name);
    const polishErrors = doctor.errors.filter((issue) => POLISH_MISSING_CODES.includes(issue.code));
    const polishWarnings = doctor.warnings.filter((issue) => POLISH_MISSING_CODES.includes(issue.code));
    if (carried) {
      assert.equal(checkpoint.status, "carried_forward", name);
      assert.equal(doctor.derived.polish_gate.status, "carried_forward", name);
      assert.deepEqual(polishErrors, [], name);
      assert.ok(polishWarnings.length >= 1 && polishWarnings.every((issue) => /^Carried forward on the (local|hosted) preview: .* missing, not passed/.test(issue.message)), JSON.stringify(polishWarnings));
      assert.notEqual(doctor.next?.stage, "polish", name);
      assert.equal((doctor.next?.blocked_stages || []).includes("qa"), false, name);
    } else {
      assert.equal(checkpoint.status, "blocked", name);
      assert.deepEqual(checkpoint.required_actions.map((action) => action.id), ["polish.hidden_eager_media.map_design_route"], name);
      assert.ok(polishErrors.length >= 1, `${name}: ${JSON.stringify(doctor.errors)}`);
      assert.deepEqual(polishWarnings, [], name);
      assert.doesNotMatch(JSON.stringify(doctor.next?.actions || []), /polish capture|checkpoint waive/, `${name}: no design route can be captured or waived`);
    }

    const resolved = await __qaNodeTestHooks.resolveQaInputs({ _: ["qa", "run"], packet: packetPath });
    const qaCheckpoint = resolved.checkpointGates.find((gate) => gate.id === "polish.hidden_eager_media");
    assert.equal(qaCheckpoint.status, carried ? "carried_forward" : "blocked", name);
    assert.equal(resolved.polishGate.status, carried ? "carried_forward" : "blocked", name);
    if (carried) {
      const rows = [
        __qaNodeTestHooks.polishGateAssertion(resolved.polishGate),
        __qaNodeTestHooks.hiddenEagerMediaGateAssertion(qaCheckpoint),
      ];
      assert.deepEqual(rows.map((row) => [row.status, row.severity]), [["warn", "warn"], ["warn", "warn"]], name);
      if (name.startsWith("hosted")) assert.doesNotMatch(JSON.stringify(rows.map((row) => row.actual)), /qa run|<packet>|<preview-url>/, name);
      // Missing evidence is never a pass: the verdict cannot be plain ready.
      assert.equal(computeDisposition(rows), "ready_with_exceptions", name);
    }
    if (name === "hosted preview") {
      const production = await __qaNodeTestHooks.resolveQaInputs({ _: ["qa", "run"], packet: packetPath, "base-url": deploy.production_url });
      assert.equal(production.checkpointGates.find((gate) => gate.id === "polish.hidden_eager_media").status, "blocked");
      assert.equal(production.polishGate.status, "blocked");
      const guidance = JSON.stringify([checkpoint.required_actions, doctor.derived.polish_gate.required_actions, doctor.warnings, doctor.next]);
      assert.doesNotMatch(guidance, /polish capture|checkpoint waive/);
      assert.match(guidance, /qa run --packet .* --base-url/);
      const nextActions = buildNextActions({
        result: { stage: "deploy" }, packetPath, packet: { deploy },
        polishGate: doctor.derived.polish_gate,
        polishCheckpointGate: checkpoint,
      });
      assert.ok(nextActions.some((action) => /qa run --packet .* --base-url https:\/\/preview\.example\.test/.test(action.command || "")), JSON.stringify(nextActions));
    }
  }
});

test("a hosted all-template preview prints a runnable QA handoff without a deploy ledger record", async (t) => {
  const previewUrl = "https://preview.example.test/runtime-packet-demo/?v=1&mode=qa";
  const { packetPath, targetRepo } = templateStockFixture(t, { target: "netlify" }, "campaigns-os hosted proof ");
  const packetArg = shellToken(packetPath);
  const previewArg = shellToken(previewUrl);
  const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  report.stages.setup.status = "completed";
  Object.assign(report.stages.assembly, inputStamps(currentPacketInputs({ packet: JSON.parse(readFileSync(packetPath, "utf8")), packetPath })));
  report.stages.deploy = { status: "pending" };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const before = doctorPacket(packetPath, { write: false });
  assert.match(JSON.stringify([before.errors, before.next, before.derived.polish_checkpoint_gate.required_actions, before.derived.polish_gate.required_actions]), /qa policy set --packet .* --preview-url <url>/);
  assert.doesNotMatch(JSON.stringify([before.errors, before.next, before.derived.polish_checkpoint_gate.required_actions, before.derived.polish_gate.required_actions]), /polish capture|checkpoint waive/);
  assert.ok(before.next.actions.some((action) => action.includes(`next --packet ${packetArg}`)), "doctor must quote the hosted handoff packet path");
  const pending = nextStage(null, { packet: packetPath, "no-write": true });
  assert.equal(pending.stage, "polish");
  const polish = nextStage("polish", { packet: packetPath, "no-write": true });
  const blockedDeploy = nextStage("deploy", { packet: packetPath, "no-write": true });
  const blockedQa = nextStage("qa", { packet: packetPath, "no-write": true });
  for (const output of [pending, polish, blockedDeploy, blockedQa]) {
    assert.match(JSON.stringify(output), /qa policy set --packet .* --preview-url <url>/);
    assert.doesNotMatch(JSON.stringify(output), /polish capture|checkpoint waive/);
    assert.ok(output.prompt.includes(`--packet ${packetArg}`), `${output.stage}: pending preview prompt must quote the packet path`);
  }

  const printedBefore = await runCli(["next", "--packet", packetPath, "--no-write", "--json"], { cwd: targetRepo });
  const printedSetup = JSON.parse(printedBefore.stdout).next_actions.find((action) => action.command?.includes("qa policy set --packet"));
  assert.equal(printedSetup.command, `campaigns-os qa policy set --packet ${packetArg} --preview-url <url>`);

  const set = await runCli(["qa", "policy", "set", "--packet", packetPath, "--preview-url", previewUrl, "--json"], { cwd: targetRepo });
  assert.equal(set.status, 0, set.stderr);
  const after = doctorPacket(packetPath, { write: false });
  assert.equal(after.derived.polish_checkpoint_gate.status, "carried_forward");
  assert.doesNotMatch(JSON.stringify(after.warnings.filter((issue) => POLISH_MISSING_CODES.includes(issue.code)).map((issue) => issue.message)), /qa run|<packet>|<preview-url>/);
  assert.match(after.derived.polish_checkpoint_gate.required_actions[0].command, /--browser --test-order common$/);
  const next = nextStage(null, { packet: packetPath, "no-write": true });
  assert.equal(next.stage, "qa");
  const passedPolish = nextStage("polish", { packet: packetPath, "no-write": true });
  const deploy = nextStage("deploy", { packet: packetPath, "no-write": true });
  const qa = nextStage("qa", { packet: packetPath, "no-write": true });
  for (const output of [next, passedPolish, deploy, qa]) {
    assert.equal(output.divergences?.length || 0, 0, JSON.stringify(output.divergences));
    assert.doesNotMatch(JSON.stringify(output), /polish capture|checkpoint waive/);
  }
  assert.ok(next.next_actions.some((action) => action.id === "qa_run"), JSON.stringify(next.next_actions));
  for (const output of [passedPolish, deploy, qa]) {
    const qaRun = output.next_actions.find((action) => action.id === "qa_run");
    assert.ok(qaRun, JSON.stringify(output.next_actions));
    const words = posixWords(qaRun.command);
    assert.equal(words[words.indexOf("--base-url") + 1], previewUrl, `${output.stage}: printed QA command must preserve the preview URL`);
    assert.equal(words[words.indexOf("--packet") + 1], packetPath, `${output.stage}: printed QA command must preserve the packet path`);
    assert.ok(words.includes("--browser") && words.includes("--test-order") && words.includes("common"), `${output.stage}: hosted QA must include browser and typed-card proof`);
  }
  assert.equal(deploy.next_actions.find((action) => action.id === "advance")?.command, `campaigns-os next qa --packet ${packetArg}`, "the hosted preview advance action must target QA");
  for (const output of [passedPolish, deploy, qa]) {
    assert.ok(output.prompt.includes(`--packet ${packetArg}`), `${output.stage}: prompt must quote the packet path`);
    assert.ok(output.prompt.includes(`--base-url ${previewArg}`), `${output.stage}: prompt must quote the preview URL`);
  }
  const printedNext = await runCli(["next", "--packet", packetPath, "--no-write", "--json"], { cwd: targetRepo });
  const printedQa = JSON.parse(printedNext.stdout).next_actions.find((action) => action.id === "qa_run");
  assert.equal(posixWords(printedQa.command)[posixWords(printedQa.command).indexOf("--base-url") + 1], previewUrl);
  const qaStage = await runCli(["next", "qa", "--packet", packetPath, "--no-write", "--json"], { cwd: targetRepo });
  assert.equal(qaStage.status, 0, qaStage.stderr);
  assert.ok(JSON.parse(qaStage.stdout).next_actions.some((action) => posixWords(action.command || "").includes(previewUrl)));
  const resolve = await runCli(["qa", "resolve", "--packet", packetPath, "--base-url", previewUrl, "--no-probe"], { cwd: targetRepo });
  assert.equal(resolve.status, 0, resolve.stderr);
  assert.match(resolve.stdout, /ready_unprobed/);
  const expectedProof = resolve.stdout.match(/Next expected proof: ([^\n]+)/)?.[1];
  assert.ok(expectedProof, resolve.stdout);
  const proofWords = posixWords(expectedProof);
  assert.equal(proofWords[proofWords.indexOf("--base-url") + 1], previewUrl, "qa resolve must print the same query-bearing preview URL");
  const resolvedProof = await runCli(["qa", "resolve", "--packet", packetPath, "--base-url", proofWords[proofWords.indexOf("--base-url") + 1], "--no-probe"], { cwd: targetRepo });
  assert.equal(resolvedProof.status, 0, resolvedProof.stderr);
  assert.match(resolvedProof.stdout, /ready_unprobed/);

  const recorded = JSON.parse(readFileSync(reportPath, "utf8"));
  recorded.stages.qa = {
    status: "completed_with_warnings",
    evidence: { qc_build_fingerprint: recorded.stages.assembly.build_fingerprint },
    ...inputStamps(currentPacketInputs({ packet: JSON.parse(readFileSync(packetPath, "utf8")), packetPath })),
  };
  writeFileSync(reportPath, `${JSON.stringify(recorded, null, 2)}\n`);
  const afterQa = nextStage(null, { packet: packetPath, "no-write": true });
  assert.equal(afterQa.stage, "done", "hosted preview with current-build QA must leave the deploy stage behind");
});

test("hosted template stock with only a production URL still offers the preview policy command", (t) => {
  const { packetPath, targetRepo } = templateStockFixture(t, {
    target: "netlify", production_url: "https://www.example.test/runtime-packet-demo/", preview_url: null,
  });
  const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  report.stages.setup.status = "completed";
  report.stages.deploy = { status: "pending" };
  Object.assign(report.stages.assembly, inputStamps(currentPacketInputs({ packet: JSON.parse(readFileSync(packetPath, "utf8")), packetPath })));
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const result = nextStage(null, { packet: packetPath, "no-write": true });
  assert.ok(result.next_actions.some((action) => action.command?.includes("qa policy set --packet")), JSON.stringify(result.next_actions));
});

test("template-stock Polish guidance never recommends a capture on local or strict hosted targets", (t) => {
  for (const deploy of [
    { target: "local-serve", preview_url: "http://localhost:8080/runtime-packet-demo/" },
    { target: "netlify", preview_url: "https://www.example.test/runtime-packet-demo/", production_url: "https://www.example.test/runtime-packet-demo/" },
  ]) {
    const { packetPath } = templateStockFixture(t, deploy);
    const polish = nextStage("polish", { packet: packetPath, "no-write": true });
    assert.doesNotMatch(JSON.stringify(polish), /polish capture/, JSON.stringify(deploy));
  }
});

test("hosted preview does not carry missing page-load evidence for a design route", async (t) => {
  const { __qaNodeTestHooks } = await import("./qa-node.mjs");
  const { packetPath, targetRepo } = packetFixture(t, (packet) => {
    packet.deploy.target = "netlify";
    packet.deploy.preview_url = "https://preview.example.test/runtime-packet-demo/";
  });
  writeReport(targetRepo, (report) => { report.stages.polish = { status: "required", required_by: "build", required_for: ["qa"] }; });
  const doctor = doctorPacket(packetPath, { write: false });
  assert.equal(doctor.derived.polish_checkpoint_gate.code, "polish.hidden_eager_media.capture_malformed");
  assert.equal(doctor.derived.polish_checkpoint_gate.status, "blocked");
  const resolved = await __qaNodeTestHooks.resolveQaInputs({ _: ["qa", "run"], packet: packetPath });
  assert.equal(resolved.checkpointGates.find((gate) => gate.id === "polish.hidden_eager_media").status, "blocked");
});

test("starter-template residue is a warning on the local preview only when no brand theme is generatable", async () => {
  const { starterResidueIsExpected } = await import("./local-preview-policy.mjs");
  const local = { deploy: { target: "local-serve", preview_url: "http://localhost:8080/demo/" } };
  const hosted = { deploy: { target: "netlify", preview_url: "https://preview.example.test/demo/" } };
  const nothingGeneratable = { status: "pass", code: "theme_gate.nothing_generatable" };
  assert.equal(starterResidueIsExpected(nothingGeneratable, { packet: local }), true);
  assert.equal(starterResidueIsExpected(nothingGeneratable, { packet: local, baseUrl: "http://127.0.0.1:8080/demo/" }), true);
  assert.equal(starterResidueIsExpected(nothingGeneratable, { packet: local, baseUrl: "https://preview.example.test/demo/" }), false);
  assert.equal(starterResidueIsExpected(nothingGeneratable, { packet: hosted }), false);
  assert.equal(starterResidueIsExpected({ status: "pass", code: "theme_gate.applied" }, { packet: local }), false);
});
