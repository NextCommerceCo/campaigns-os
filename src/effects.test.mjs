// The effect tests behind contracts/effects.v1.json.
//
// Every row in that file is a claim about ONE invocation: these are the files
// it writes, this is what it sends, and nothing else moves. This file proves
// each claim the only way a claim about effects can be proved — by running the
// real CLI in a disposable target, snapshotting the tree before and after, and
// counting the requests a loopback receiver sees.
//
// Five conditions per row, because the CLI's effects are not a function of argv
// alone: an ambient run session redirects the lifecycle journal and is touched
// by session resolution; a STALE session is closed out (Run Record assembled)
// before some commands even read argv; CAMPAIGNS_OS_LIFECYCLE_LOG moves the
// journal outside the runtime directory.
//
// The fifth condition is not a variant of the other four. Under those, consent
// is switched on only for rows that DECLARE a consent-gated send they expect to
// see — so consent was read from the row under test, and a send nobody declared
// ran with consent off and left no trace. That is how six `next` rows and three
// `qa run` rows came to declare `sends: []` while each POSTed to the endpoint.
// Under `persisted_consent` every row runs with consent PERSISTED for the
// loopback receiver's scope (the record `telemetry on --proxy-base <loopback>`
// writes — an env override is not equivalent: it carries no scope, and the
// remit refuses an unscoped grant for a non-canonical endpoint), a synthetic
// campaign key in the environment, and the receiver named wherever the command
// takes --proxy-base. Any request the receiver sees that no declared send
// covers fails the row.
//
// Nothing in this file may reach the real network, and that is enforced rather
// than intended. The remit endpoint is a hard-coded constant with no env
// override (src/spec-fetch.mjs DEFAULT_PROXY_BASE), so the control is the
// consent scope plus an observation: the persisted grant covers the loopback
// scope ONLY, which makes a canonical remit resolve OFF (scope mismatch), and
// every invocation in this condition runs under NODE_DEBUG=net, whose
// connection log is asserted to name no host but 127.0.0.1. `effects: persisted
// scoped consent never reaches the canonical endpoint` states the same claim
// for the one command that would otherwise fall back to the canonical endpoint.
//
// The assertion runs both ways and that is the point:
//   - NOTHING may change that the row does not declare, in any condition. This
//     is what makes a `readOnlyHint: true` row falsifiable: it declares no
//     writes, so any byte that moves fails it.
//   - Every declared write/send whose `observed_in` names this condition MUST
//     be seen, so a row cannot be padded with effects that never happen.
// An effect the offline fixture cannot reach carries `observed_in: []` and a
// `not_observed_reason`; check-effects.mjs refuses one without the reason, and
// those rows are `test_scope: "preflight"` — the case then proves the preflight
// refusal writes nothing beyond the declaration, and, where a loopback receiver
// can stand in for the destination, that the declared destination is the one
// contacted.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createVerdict, SEVERITY, STATUS } from "./qa-verdict.mjs";
import { buildRunSession, writeRunSession } from "./run-session.mjs";
import { specMaterialHash } from "./spec-identity.mjs";
import { stageRealPackageInstall } from "./package-install-fixture.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const EXAMPLES = join(ROOT, "examples");
const VERDICT_RUN_ID = "MTXEUVC6732A9UV8365MBTDNAA";

const CONTRACT = JSON.parse(readFileSync(join(ROOT, "contracts/effects.v1.json"), "utf8"));
const CONDITIONS = ["no_session", "ambient_session", "stale_session", "lifecycle_log", "persisted_consent"];
// A key the packet's api_key_source (env:CAMPAIGNS_API_KEY) resolves, so a
// remit that is gated on one has one. Synthetic and loopback-only by
// construction: the persisted consent scope is the loopback receiver.
const SYNTHETIC_CAMPAIGN_KEY = "campaign_effects_test_loopback_only";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Every file under `dir` as path -> content digest, paths relative to `dir`.
 * `.git` is skipped: one row needs a Git checkout to scan and the index is not
 * an effect of the CLI.
 */
function snapshot(dir) {
  const files = {};
  const walk = (current) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[relative(dir, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(dir);
  return files;
}

/** The paths that were created, changed or removed between two snapshots. */
function changedPaths(before, after) {
  const changed = new Set();
  for (const [path, hash] of Object.entries(after)) if (before[path] !== hash) changed.add(path);
  for (const path of Object.keys(before)) if (!(path in after)) changed.add(path);
  return [...changed].sort();
}

async function startReceiver() {
  const hits = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      hits.push({ method: request.method, url: request.url });
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, results: [], items: [], records: [] }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { hits, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
}

async function runCli(argv, { cwd, home, telemetry, lifecycleLog = "", campaignKey = "", traceNetwork = false, extraEnv = {}, cli = CLI }) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...argv], {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      // NODE_DEBUG=net is verbose enough to overrun the 1 MiB default on a
      // command that talks at all, and a truncated trace would fail the run
      // instead of proving anything.
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        CAMPAIGNS_OS_TELEMETRY: telemetry,
        CAMPAIGNS_OS_LIFECYCLE_LOG: lifecycleLog,
        CAMPAIGNS_API_KEY: campaignKey,
        ...(traceNetwork ? { NODE_DEBUG: "net" } : {}),
        // Per-invocation environment, for rows whose command reads the world
        // through one. `qa install-browser` drives the Playwright installer,
        // which resolves its registry from PLAYWRIGHT_BROWSERS_PATH and its
        // archive from PLAYWRIGHT_DOWNLOAD_HOST; both are pinned so the case
        // is the same on every platform and the download cannot leave the
        // machine. Applied LAST, so a value inherited from the developer's own
        // environment cannot decide what the row proves.
        ...extraEnv,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? "spawn-error", stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

/**
 * Every host the process tried to open a socket to, read from the NODE_DEBUG=net
 * trace: the `createConnection` record (which names the host BEFORE the DNS
 * lookup, so a hostname that never resolves is still seen) and the `connect:
 * attempting to connect to <address>` line that follows it.
 */
export function connectedHosts(trace) {
  const hosts = new Set();
  for (const match of trace.matchAll(/^NET \d+: .*\bhost: '([^']*)'/gm)) if (match[1]) hosts.add(match[1]);
  for (const match of trace.matchAll(/attempting to connect to (\[[^\]]+\]|[^\s:]+):\d+/g)) hosts.add(match[1]);
  return [...hosts];
}

/** The hosts above that are not the loopback receiver — the ones that would be a real network call. */
const offMachineHosts = (trace) => connectedHosts(trace).filter((host) => !LOOPBACK_HOSTS.has(host));

/**
 * A disposable target seeded from the shipped examples: a Build Packet whose
 * target repo is a Page Kit checkout, its CampaignSpec, an Assembly Report, a
 * retained doctor sidecar and a stored QA verdict for the current spec. The
 * same shape `src/dry-run-effects.test.mjs` seeds, plus an isolated HOME so
 * machine-level writes (installed skills, telemetry consent, credentials) land
 * somewhere the snapshot can see and the developer's own home cannot be
 * touched.
 */
function seedTarget() {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-effects-"));
  for (const file of ["build-packet.basic.json", "campaignspec.v42.basic.json"]) {
    cpSync(join(EXAMPLES, file), join(dir, file));
  }
  cpSync(join(EXAMPLES, "source-html"), join(dir, "source-html"), { recursive: true });
  cpSync(join(EXAMPLES, "target-page-kit"), join(dir, "target-page-kit"), { recursive: true });
  cpSync(join(ROOT, "contracts/commerce-surface-catalog.json"), join(dir, "contracts/commerce-surface-catalog.json"));

  const packetPath = join(dir, "build-packet.basic.json");
  const packet = readJson(packetPath);
  packet.assembly.commerce_catalog.path = "contracts/commerce-surface-catalog.json";
  packet.assembly.commerce_catalog.required = false;
  writeJson(packetPath, packet);
  const targetRepo = join(dir, "target-page-kit");

  const specPath = join(dir, "campaignspec.v42.basic.json");
  const spec = readJson(specPath);
  spec.runtime = { sdk_version: "0.4.37" };
  delete spec.global_config.sdk_version;
  for (const funnel of spec.funnels || []) for (const page of funnel.pages || []) delete page.sdk_hints;
  writeJson(specPath, spec);

  // The target pin lags the spec's, so `page_kit.sdk_version` is a blocked and
  // waivable checkpoint gate — which is what the waive rows need in order to
  // validate anything at all.
  const campaignsPath = join(targetRepo, "_data/campaigns.json");
  const campaigns = readJson(campaignsPath);
  campaigns[packet.campaign.public_route_slug].sdk_version = "0.4.36";
  writeJson(campaignsPath, campaigns);

  const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
  const report = readJson(join(EXAMPLES, "assembly-report.example.json"));
  report.identity.map_id = packet.spec.map_id;
  report.identity.public_route_slug = packet.campaign.public_route_slug;
  report.stages.deploy.status = "skipped";
  report.evidence = [];
  writeJson(reportPath, report);
  // A retained doctor sidecar, so "the invocation stamped it" is an assertion
  // about a file that exists.
  writeJson(join(targetRepo, ".campaign-runtime/doctor-output.json"), { ok: true, status: "ready" });

  const verdict = createVerdict({
    runId: VERDICT_RUN_ID,
    mapId: packet.spec.map_id,
    publicRouteSlug: packet.campaign.public_route_slug,
    specVersion: "4.2",
    specHash: specMaterialHash(readJson(specPath)),
    startedAt: "2026-09-20T10:00:00.000Z",
    completedAt: "2026-09-20T10:05:00.000Z",
    runtime: "campaigns-os-node-qa@test",
    baseUrl: "https://preview.example/runtime-packet-demo/",
    assertions: [{ id: "route:entry", family: "funnel-flow", page: "entry", status: STATUS.pass, severity: SEVERITY.blocker, expected: "200", actual: "200", evidence: [] }],
  });
  const verdictPath = join(dir, "qa-output", packet.spec.map_id, `${VERDICT_RUN_ID}.json`);
  writeJson(verdictPath, verdict);
  writeJson(join(dir, ".campaign-runtime/qa-verdict.json"), {
    ...verdict, entry_urls: [], page_urls: [], tested_urls: [], test_orders: [], generated_at: "2026-09-20T10:06:00.000Z",
  });

  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return { dir, home, packetPath, targetRepo, reportPath, specPath, verdictPath, sourceDir: join(dir, "source-html") };
}

/** A run session at `root` idled past the 12 h TTL: the input the pre-dispatch sweep acts on. */
function seedStaleSession(root, packet) {
  const started = new Date(Date.now() - 13 * 60 * 60 * 1000);
  writeRunSession(root, buildRunSession({
    runId: `run_stale_${started.getTime()}`,
    lifecycleJournal: join(root, ".campaign-runtime/command-lifecycle.jsonl"),
    packet,
    now: started,
  }));
}

/** The repo pin ahead of the spec's, so `spec derive` has something to derive. */
function seedDerivablePin(seed) {
  const campaignsPath = join(seed.targetRepo, "_data/campaigns.json");
  const campaigns = readJson(campaignsPath);
  campaigns[readJson(seed.packetPath).campaign.public_route_slug].sdk_version = "0.4.38";
  writeJson(campaignsPath, campaigns);
}

/** A Git checkout with a manifest, which `sdk storage-check` refuses to run without. */
function seedStorageScan(seed) {
  execFileSync("git", ["init", "-q"], { cwd: seed.targetRepo });
  writeFileSync(join(seed.targetRepo, "SDK-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    sdkVersion: "0.4.38",
    supportedSdkVersions: { min: "0.4.38", max: "0.4.38" },
    provenance: { extractor: "synthetic", registry: "synthetic", inputSha256: "a".repeat(64) },
    keys: [{
      key: "next-order{__scope}", pattern: "next-order{}", areas: ["localStorage", "sessionStorage"], scoped: true,
      migration: { since: "0.4.34", legacyKey: "next-order", releaseEvidence: { commit: "b".repeat(40), tag: "v0.4.34" } },
      replacement: { kind: "public-store", export: "useOrderStore", guide: "synthetic-guide" },
    }],
  }));
  execFileSync("git", ["add", "-A"], { cwd: seed.targetRepo });
}

/**
 * A built `_site/` under the target, which `doctor --built` resolves its scope
 * from. Without it the command is blocked before it does anything — and a row
 * proved against a command that refuses on arrival proves nothing about what
 * the command writes when it runs (`--emit-packet` emits the packet only then).
 */
function seedBuiltSite(seed) {
  const slug = readJson(seed.packetPath).campaign.public_route_slug;
  const page = (title) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
  mkdirSync(join(seed.targetRepo, "_site", slug, "checkout"), { recursive: true });
  writeFileSync(join(seed.targetRepo, "_site", slug, "index.html"), page("Landing"));
  writeFileSync(join(seed.targetRepo, "_site", slug, "checkout", "index.html"), page("Checkout"));
}

/** A target with no prior stage evidence, which the intake commands demand. */
function seedCleanIntake(seed) {
  rmSync(join(seed.targetRepo, ".campaign-runtime"), { recursive: true, force: true });
}

/**
 * The shipped parity fixture, copied INTO the disposable target: `qa parity`
 * is fixture-driven and writes its evidence bundle beside the run, so the
 * fixture has to live where the snapshot can see anything that lands near it.
 */
function seedParityFixture(seed) {
  cpSync(join(ROOT, "fixtures/parity/example-sdk04-offers.json"), join(seed.dir, "parity-fixture.json"));
}

/**
 * The environment `qa parity` and `qa install-browser` are proved under.
 *
 * Both drive Playwright, and Playwright reads the machine: the browser
 * registry comes from PLAYWRIGHT_BROWSERS_PATH (defaulting to a per-platform
 * cache under HOME) and the browser archive from PLAYWRIGHT_DOWNLOAD_HOST.
 * Left alone, the row would prove one thing on a developer's laptop with
 * Chromium installed and another in CI, and `qa install-browser` would
 * download ~150 MB from the Playwright CDN — a real network call, in a suite
 * whose whole claim is that it makes none.
 *
 * So both are pinned. The registry is an empty directory inside the target, so
 * "no browser is installed" is a fact of the fixture rather than of the
 * machine; the download host is a closed loopback port, so the archive fetch
 * fails at connect and the only host the trace can name is 127.0.0.1.
 */
const CLOSED_LOOPBACK_PORT = "http://127.0.0.1:1";
const playwrightEnv = (seed) => ({
  PLAYWRIGHT_BROWSERS_PATH: join(seed.home, "ms-playwright"),
  PLAYWRIGHT_DOWNLOAD_HOST: CLOSED_LOOPBACK_PORT,
});

function seedSetupProject(seed) {
  const installed = stageRealPackageInstall(seed.targetRepo);
  // The effects snapshot must see real dependency files, not a symlink out of
  // its observed tree. The setup CLI must be the selected project's own copy.
  rmSync(join(installed, "node_modules"));
  cpSync(join(ROOT, "node_modules"), join(installed, "node_modules"), { recursive: true, dereference: true });
  const version = readJson(join(ROOT, "package.json")).version;
  writeJson(join(seed.targetRepo, "package.json"), { devDependencies: { "@nextcommerce/campaigns-os": version, "next-campaign-page-kit": "0.2.0" } });
  writeJson(join(seed.targetRepo, "package-lock.json"), { lockfileVersion: 3, packages: { "node_modules/@nextcommerce/campaigns-os": { version } } });
  writeJson(join(seed.targetRepo, "node_modules/next-campaign-page-kit/package.json"), { name: "next-campaign-page-kit", version: "0.2.0" });
  seed.setupCli = join(installed, "bin/campaigns-os.mjs");
}

const WAIVE = ["--reason", "Pin held for a compatibility window", "--waived-by", "Jordan Lee"];
// The one assertion `qa waive`'s lane is scoped to, and a scenario the shipped
// parity fixture declares. Both are spelled here so a rename is one edit.
const WAIVABLE_QA_ASSERTION = "analytics-correctness:purchase-fires";
const PARITY_SCENARIO = "root-accessory-oto50";
const CHECKPOINT_WAIVE = [...WAIVE, "--review-condition", "Re-evaluate before launch"];
const intake = (command, seed, extra = []) => [
  command, "--spec", seed.specPath, "--source", seed.sourceDir, "--target", seed.targetRepo,
  "--template-family", "olympus", ...extra, "--json",
];

/**
 * One entry per row, keyed the way `rowKey` keys the contract. `argv` builds
 * the invocation; `target` names the directory the row's `{target}` token
 * resolves to (the packet's target repo unless the invocation names another);
 * `prepare` adjusts the seed for rows the base fixture cannot exercise;
 * `env` pins the environment a row's command reads the machine through (the
 * Playwright registry and download host, for the two rows that drive it), so
 * the row proves the same thing on a laptop with Chromium installed as in CI;
 * `proxyBase: true` marks a command that TAKES --proxy-base, which the
 * persisted-consent condition appends so the consented endpoint is the loopback
 * receiver rather than the canonical fallback. A command that does not take the
 * flag is left alone: under that condition its consent resolves off by scope
 * mismatch, which is itself part of what the condition proves.
 */
const INVOCATIONS = {
  "help": { argv: () => ["help"] },
  "demo": { argv: (s) => ["demo", "--target", join(s.dir, "demo-out")], target: () => "demo-out" },
  "readback": { argv: (s) => ["readback", s.targetRepo, "--json"] },
  "readback|--example": { argv: () => ["readback", "--example", "--json"] },
  "run status": { argv: () => ["run", "status", "--json"] },
  "doctor": { argv: (s) => ["doctor", "--packet", s.packetPath, "--json"] },
  "doctor|--no-write": { argv: (s) => ["doctor", "--packet", s.packetPath, "--write", "--no-write", "--json"] },
  "doctor|--write": { argv: (s) => ["doctor", "--packet", s.packetPath, "--write", "--json"] },
  "doctor|--built": { prepare: seedBuiltSite, argv: (s) => ["doctor", "--built", s.targetRepo, "--family", "olympus", "--json"] },
  "doctor|--built --emit-packet": { prepare: seedBuiltSite, argv: (s) => ["doctor", "--built", s.targetRepo, "--family", "olympus", "--emit-packet", "--json"] },
  "sdk storage-check": {
    prepare: seedStorageScan,
    argv: (s) => ["sdk", "storage-check", "--target", s.targetRepo, "--target-sdk", "0.4.38", "--manifest", join(s.targetRepo, "SDK-manifest.json"), "--scope", "_data", "--json"],
  },
  "tooling diagnose": { argv: (s) => ["tooling", "diagnose", "--packet", s.packetPath, "--json"] },
  "tooling setup": { argv: (s) => ["tooling", "setup", "--target", s.targetRepo, "--platform", "claude", "--json"], prepare: seedSetupProject, cli: (s) => s.setupCli, env: playwrightEnv },
  "tooling setup|--dry-run": { argv: (s) => ["tooling", "setup", "--target", s.targetRepo, "--platform", "claude", "--dry-run", "--json"], prepare: seedSetupProject, cli: (s) => s.setupCli },
  "tooling status": { argv: () => ["tooling", "status", "--json"] },
  "tooling status|--force": { argv: () => ["tooling", "status", "--force", "--json"] },
  "*refused*": { argv: () => ["nosuchcommand"] },
  "bundle check": { argv: (s) => ["bundle", "check", "--packet", s.packetPath, "--json"] },
  "standardize": { argv: (s) => ["standardize", "--target", s.targetRepo, "--json"] },
  "theme inspect": { argv: (s) => ["theme", "inspect", "--packet", s.packetPath, "--json"] },
  "theme generate": { argv: (s) => ["theme", "generate", "--packet", s.packetPath, "--json"] },
  "theme generate|--force": { argv: (s) => ["theme", "generate", "--packet", s.packetPath, "--force", "--json"] },
  "theme waive": { argv: (s) => ["theme", "waive", "--packet", s.packetPath, ...WAIVE, "--json"] },
  "theme waive|--dry-run": { argv: (s) => ["theme", "waive", "--packet", s.packetPath, ...WAIVE, "--dry-run", "--json"] },
  "checkpoint waive": { argv: (s) => ["checkpoint", "waive", "--packet", s.packetPath, "--gate", "page_kit.sdk_version", ...CHECKPOINT_WAIVE, "--json"] },
  "checkpoint waive|--dry-run": { argv: (s) => ["checkpoint", "waive", "--packet", s.packetPath, "--gate", "page_kit.sdk_version", ...CHECKPOINT_WAIVE, "--dry-run", "--json"] },
  "page-kit sync": { argv: (s) => ["page-kit", "sync", "--packet", s.packetPath, "--json"] },
  "page-kit sync|--dry-run": { argv: (s) => ["page-kit", "sync", "--packet", s.packetPath, "--dry-run", "--json"] },
  "page-kit parity": { argv: (s) => ["page-kit", "parity", "--packet", s.packetPath, "--json"] },
  "spec derive": { prepare: seedDerivablePin, argv: (s) => ["spec", "derive", "--packet", s.packetPath, "--json"] },
  "spec derive|--dry-run": { prepare: seedDerivablePin, argv: (s) => ["spec", "derive", "--packet", s.packetPath, "--dry-run", "--json"] },
  "spec derive|--from-store": { prepare: seedDerivablePin, argv: (s) => ["spec", "derive", "--packet", s.packetPath, "--from-store", "examplestore", "--json"] },
  "spec derive|--write-map": { prepare: seedDerivablePin, argv: (s, receiver) => ["spec", "derive", "--packet", s.packetPath, "--write-map", "--proxy-base", receiver, "--json"] },
  "polish capture": { argv: (s, receiver) => ["polish", "capture", "--packet", s.packetPath, "--base-url", receiver, "--json"] },
  "validate-assembly-report": { argv: (s) => ["validate-assembly-report", "--report", s.reportPath, "--json"] },
  "install-skills": { argv: () => ["install-skills", "--platform", "claude", "--json"], target: () => "home" },
  "install-skills|--dry-run": { argv: () => ["install-skills", "--platform", "claude", "--dry-run", "--json"], target: () => "home" },
  "install-agent-context": { argv: (s) => ["install-agent-context", "--target", s.targetRepo] },
  "install-agent-context|--dry-run": { argv: (s) => ["install-agent-context", "--target", s.targetRepo, "--dry-run"] },
  "login": { argv: () => ["login", "--store", "examplestore"] },
  "logout": { argv: () => ["logout", "--store", "examplestore"] },
  "next": { proxyBase: true, argv: (s) => ["next", "--packet", s.packetPath, "--json"] },
  "next|--no-write": { proxyBase: true, argv: (s) => ["next", "--packet", s.packetPath, "--no-write", "--json"] },
  "next|--no-remit": { proxyBase: true, argv: (s) => ["next", "--packet", s.packetPath, "--no-remit", "--json"] },
  "next setup": { proxyBase: true, argv: (s) => ["next", "setup", "--packet", s.packetPath, "--json"] },
  "next build": { proxyBase: true, argv: (s) => ["next", "build", "--packet", s.packetPath, "--json"] },
  "next polish": { proxyBase: true, argv: (s) => ["next", "polish", "--packet", s.packetPath, "--report", s.reportPath, "--json"] },
  "next deploy": { proxyBase: true, argv: (s) => ["next", "deploy", "--packet", s.packetPath, "--report", s.reportPath, "--json"] },
  "next qa": { proxyBase: true, argv: (s) => ["next", "qa", "--packet", s.packetPath, "--report", s.reportPath, "--json"] },
  "qa resolve": { argv: (s, receiver) => ["qa", "resolve", "--packet", s.packetPath, "--base-url", receiver, "--json"] },
  "qa resolve|--no-probe": { argv: (s, receiver) => ["qa", "resolve", "--packet", s.packetPath, "--base-url", receiver, "--no-probe", "--json"] },
  "qa run": { proxyBase: true, argv: (s, receiver) => ["qa", "run", "--packet", s.packetPath, "--base-url", receiver, "--json"] },
  "qa run|--no-post-verdict": { proxyBase: true, argv: (s, receiver) => ["qa", "run", "--packet", s.packetPath, "--base-url", receiver, "--no-post-verdict", "--json"] },
  "qa run|--no-remit": { proxyBase: true, argv: (s, receiver) => ["qa", "run", "--packet", s.packetPath, "--base-url", receiver, "--no-remit", "--json"] },
  "qa run|--test-order": { proxyBase: true, argv: (s, receiver) => ["qa", "run", "--packet", s.packetPath, "--base-url", receiver, "--test-order", "typed-card", "--json"] },
  "qa run|--browser": { proxyBase: true, argv: (s, receiver) => ["qa", "run", "--packet", s.packetPath, "--base-url", receiver, "--browser", "--json"] },
  "qa parity": {
    prepare: seedParityFixture, env: playwrightEnv,
    argv: (s, receiver) => ["qa", "parity", "--fixture", join(s.dir, "parity-fixture.json"), "--scenario", PARITY_SCENARIO, "--base-url", receiver, "--json"],
  },
  "qa parity|--no-post-verdict": {
    prepare: seedParityFixture, env: playwrightEnv,
    argv: (s, receiver) => ["qa", "parity", "--fixture", join(s.dir, "parity-fixture.json"), "--scenario", PARITY_SCENARIO, "--base-url", receiver, "--no-post-verdict", "--json"],
  },
  "qa waive": { argv: (s) => ["qa", "waive", "--packet", s.packetPath, "--assertion", WAIVABLE_QA_ASSERTION, ...WAIVE, "--json"] },
  "qa install-browser": { env: playwrightEnv, argv: () => ["qa", "install-browser", "--json"] },
  "qa promote": { argv: (s) => ["qa", "promote", "--packet", s.packetPath, "--verdict", s.verdictPath, "--json"] },
  "qa publish": { argv: (s, receiver) => ["qa", "publish", "--packet", s.packetPath, "--verdict", s.verdictPath, "--proxy-base", receiver, "--json"] },
  "qa publish|--dry-run": { argv: (s, receiver) => ["qa", "publish", "--packet", s.packetPath, "--verdict", s.verdictPath, "--proxy-base", receiver, "--dry-run", "--json"] },
  "qa publish|--republish": { argv: (s, receiver) => ["qa", "publish", "--packet", s.packetPath, "--verdict", s.verdictPath, "--proxy-base", receiver, "--republish", "--json"] },
  // The values are deliberately ones the seeded packet does not already hold:
  // a `qa policy set` that changes nothing writes nothing but the journal, and
  // proving THAT proves nothing about what the command does to a packet.
  "qa policy set": { argv: (s) => ["qa", "policy", "set", "--packet", s.packetPath, "--order-path-depth", "full", "--preview-url", "https://preview.example/effects-row/", "--json"] },
  "findings add": { argv: (s) => ["findings", "add", "--stage", "build", "--kind", "friction", "--summary", "an effect-test finding", "--packet", s.packetPath] },
  "findings harvest": { argv: (s) => ["findings", "harvest", "--packet", s.packetPath, "--json"] },
  "findings harvest|--write": { argv: (s) => ["findings", "harvest", "--packet", s.packetPath, "--write", "--json"] },
  "findings list": { argv: (s) => ["findings", "list", "--packet", s.packetPath, "--json"] },
  "findings export": { argv: (s) => ["findings", "export", "--packet", s.packetPath, "--json"] },
  "run-record": { argv: (s, receiver) => ["run-record", "--packet", s.packetPath, "--proxy-base", receiver, "--json"] },
  "run-record|--no-remit": { proxyBase: true, argv: (s) => ["run-record", "--packet", s.packetPath, "--no-remit", "--json"] },
  "run-record|--no-write": { proxyBase: true, argv: (s) => ["run-record", "--packet", s.packetPath, "--no-write", "--json"] },
  "run-record|--dry-run": { proxyBase: true, argv: (s) => ["run-record", "--packet", s.packetPath, "--dry-run", "--json"] },
  "run-record|--list": { proxyBase: true, argv: (s) => ["run-record", "--packet", s.packetPath, "--list", "--json"] },
  "run start": { argv: (s) => ["run", "start", "--packet", s.packetPath, "--json"] },
  "run start|--force": { argv: (s) => ["run", "start", "--packet", s.packetPath, "--force", "--json"] },
  "run end": { argv: (s, receiver) => ["run", "end", "--packet", s.packetPath, "--proxy-base", receiver, "--json"] },
  "run end|--no-remit": { argv: (s, receiver) => ["run", "end", "--packet", s.packetPath, "--proxy-base", receiver, "--no-remit", "--json"] },
  "run end|--no-write": { argv: (s, receiver) => ["run", "end", "--packet", s.packetPath, "--proxy-base", receiver, "--no-write", "--json"] },
  "run end|--dry-run": { argv: (s, receiver) => ["run", "end", "--packet", s.packetPath, "--proxy-base", receiver, "--dry-run", "--json"] },
  "telemetry status": { argv: () => ["telemetry", "status", "--json"] },
  "telemetry on": { argv: (s, receiver) => ["telemetry", "on", "--proxy-base", receiver, "--json"], target: () => "home" },
  "telemetry off": { argv: () => ["telemetry", "off", "--json"], target: () => "home" },
  "telemetry list": { argv: (s, receiver) => ["telemetry", "list", "--packet", s.packetPath, "--proxy-base", receiver, "--json"] },
  "start": { prepare: seedCleanIntake, proxyBase: true, argv: (s) => intake("start", s) },
  "start|--force": { prepare: seedCleanIntake, proxyBase: true, argv: (s) => intake("start", s, ["--force"]) },
  "start|--no-run-session": { prepare: seedCleanIntake, proxyBase: true, argv: (s) => intake("start", s, ["--no-run-session"]) },
  "prepare-build": { prepare: seedCleanIntake, proxyBase: true, argv: (s) => intake("prepare-build", s) },
  "prepare-build|--force": { prepare: seedCleanIntake, proxyBase: true, argv: (s) => intake("prepare-build", s, ["--force"]) },
  "prepare-build|--no-run-session": { prepare: seedCleanIntake, proxyBase: true, argv: (s) => intake("prepare-build", s, ["--no-run-session"]) },
  "build": { prepare: seedCleanIntake, proxyBase: true, argv: (s) => intake("build", s) },
  "build|--force": { prepare: seedCleanIntake, proxyBase: true, argv: (s) => intake("build", s, ["--force"]) },
  "build|--no-run-session": { prepare: seedCleanIntake, proxyBase: true, argv: (s) => intake("build", s, ["--no-run-session"]) },
};

const rowKey = (row) => [
  [row.command, row.subcommand].filter(Boolean).join(" "),
  ...(row.flags.length ? [row.flags.join(" ")] : []),
].join("|");

/** A location token or glob pattern as a regular expression over snapshot paths. */
function patternToRegExp(pattern, tokens) {
  let expanded = pattern;
  for (const [token, value] of Object.entries(tokens)) {
    expanded = expanded.split(token).join(value);
  }
  expanded = expanded.replace(/^\/+/, "");
  const source = expanded
    .split("**").map((part) => part.split("*").map((atom) => atom.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

/** The declared writes of a row, as matchers over snapshot paths. */
function writeMatchers(row, tokens, journalPaths) {
  return row.writes.map((entry) => {
    if (entry.path === "{lifecycle-journal}") {
      const alternatives = journalPaths.map((path) => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      return { entry, matches: (path) => alternatives.some((re) => re.test(path)) };
    }
    const regexp = patternToRegExp(entry.path, tokens);
    return { entry, matches: (path) => regexp.test(path) };
  });
}

/**
 * The request path a declared destination pins down, or null when the row
 * names an endpoint off this machine that a loopback receiver only stands in
 * for (a base URL, the login gateway, a store's Admin API).
 */
function destinationMatcher(destination) {
  const match = destination.match(/^\{proxy-base\}(\/\S*)$/);
  if (!match) return null;
  return contactMatcher(match[1]);
}

/** The request path of a URL the receiver saw, and whether it is an API endpoint (never a stand-in's). */
const requestPath = (url) => new URL(url, "http://127.0.0.1").pathname;
const isApiPath = (url) => requestPath(url).startsWith("/api/");

/** A `preflight.may_contact` entry (or a pinned destination's path) as a matcher over request paths. */
function contactMatcher(path) {
  const source = path.split("{map-id}").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+");
  return new RegExp(`^${source}(\\?|$)`);
}

async function runCondition(row, invocation, condition) {
  const seed = seedTarget();
  const receiver = await startReceiver();
  const persisted = condition === "persisted_consent";
  try {
    invocation.prepare?.(seed);
    if (persisted) {
      // The grant the operator would make: consent recorded on the machine for
      // ONE endpoint, this receiver. Made through the CLI rather than by
      // writing the file, so the test grants consent exactly the way the code
      // reads it. It runs before the snapshot, so the config file it writes is
      // part of the "before" state rather than an effect of the row.
      const granted = await runCli(["telemetry", "on", "--proxy-base", receiver.base, "--json"], {
        cwd: seed.dir, home: seed.home, telemetry: "off",
      });
      assert.equal(granted.code, 0, `could not persist scoped consent: ${granted.stderr}`);
      const stored = readJson(join(seed.home, ".config/campaigns-os/config.json"));
      assert.equal(stored.telemetry.enabled, true, "the persisted consent record is not ON");
      assert.equal(stored.telemetry.scope, receiver.base, "consent was persisted for a scope other than the loopback receiver");
    }
    if (condition === "ambient_session") {
      const started = await runCli(["run", "start", "--packet", seed.packetPath, "--json"], { cwd: seed.dir, home: seed.home, telemetry: "off" });
      assert.equal(started.code, 0, `could not open the ambient session: ${started.stderr}`);
    } else if (condition === "stale_session") {
      seedStaleSession(seed.targetRepo, seed.packetPath);
      seedStaleSession(seed.dir, seed.packetPath);
    }
    const lifecycleLog = condition === "lifecycle_log" ? join(seed.dir, "lifecycle.jsonl") : "";
    // Under the first four conditions consent is off unless the row declares a
    // consent-gated send it expects to SEE — then the row runs with the env
    // override ON and the loopback receiver as its endpoint, so "nothing was
    // sent" is not an artefact of consent being off for a send that IS
    // declared. That, on its own, took the row's word for which sends exist,
    // which is what `persisted_consent` exists to stop: there the env override
    // is absent and the machine-level grant is what resolves, for every row.
    const telemetry = persisted ? "" : (row.sends.some((send) => send.requires_consent && send.observed_in.includes(condition)) ? "on" : "off");

    const before = snapshot(seed.dir);
    let argv = invocation.argv(seed, receiver.base);
    if (persisted && invocation.proxyBase && !argv.includes("--proxy-base")) {
      argv = [...argv, "--proxy-base", receiver.base];
    }
    // The guard that keeps the paragraph above true rather than merely intended.
    // Under persisted consent the guard is the SCOPE: the grant covers the
    // loopback receiver only, so a command that falls back to the canonical
    // endpoint resolves consent OFF (scope mismatch) and sends nothing — and
    // the NODE_DEBUG=net assertion below checks that rather than trusting it.
    assert.ok(
      telemetry !== "on" || argv.includes("--proxy-base"),
      `${row.effect_test}: runs with Run Telemetry consent ON but names no --proxy-base, so its remit would go to the canonical endpoint`,
    );
    const result = await runCli(argv, {
      ...(invocation.cli ? { cli: invocation.cli(seed) } : {}),
      cwd: seed.dir, home: seed.home, telemetry, lifecycleLog, traceNetwork: true,
      ...(invocation.env ? { extraEnv: invocation.env(seed) } : {}),
      ...(persisted ? { campaignKey: SYNTHETIC_CAMPAIGN_KEY } : {}),
    });
    // Every run, not only the consented ones: "no test in this repository
    // reaches the network" is a claim about all 400-odd invocations, and the
    // trace is what makes it one rather than an assumption about which of them
    // could have tried.
    assert.deepEqual(
      offMachineHosts(result.stderr),
      [],
      `${row.effect_test} [${condition}]: the invocation opened a connection off this machine`,
    );
    const changed = changedPaths(before, snapshot(seed.dir));

    const tokens = {
      "{target}": invocation.target ? invocation.target(seed) : "target-page-kit",
      "{cwd}": "",
      "{home}": "home",
      "{packet}": relative(seed.dir, seed.packetPath),
      "{spec}": relative(seed.dir, seed.specPath),
    };
    const journalPaths = [
      "target-page-kit/.campaign-runtime/command-lifecycle.jsonl",
      ".campaign-runtime/command-lifecycle.jsonl",
      "lifecycle.jsonl",
    ];
    const matchers = writeMatchers(row, tokens, journalPaths);

    // (1) Nothing undeclared moved. This is the direction that makes a
    // read-only row falsifiable and that catches an under-declared writer.
    for (const path of changed) {
      assert.ok(
        matchers.some((matcher) => matcher.matches(path)),
        `${row.effect_test} [${condition}]: ${path} changed but contracts/effects.v1.json declares no write for it` +
          ` (exit ${result.code})\n${result.stderr.split("\n").slice(0, 3).join("\n")}`,
      );
    }
    // (2) Every write this condition is supposed to show, showed. This is the
    // direction that stops a row being padded with effects that never happen.
    for (const matcher of matchers) {
      if (!matcher.entry.observed_in.includes(condition)) continue;
      assert.ok(
        changed.some((path) => matcher.matches(path)),
        `${row.effect_test} [${condition}]: declared write ${matcher.entry.path} was not observed` +
          ` (changed: ${changed.join(", ") || "nothing"}; exit ${result.code})\n${result.stderr.split("\n").slice(0, 3).join("\n")}`,
      );
    }

    // (3) Exactly the declared sends. An undeclared request fails; a declared
    // one this condition names must be seen.
    const urls = receiver.hits.map((hit) => hit.url);
    for (const url of urls) {
      assert.ok(
        row.sends.some((send) => {
          const matcher = destinationMatcher(send.destination);
          // A destination the receiver only STANDS IN for ({base-url}, the
          // login gateway) cannot pin a path down — but it must not become a
          // licence for any request at all, which is how an undeclared API
          // call could hide behind a row that declares a page fetch. Every API
          // endpoint in this contract is declared as {proxy-base}/api/…, so an
          // /api/ path is never a stand-in's: it needs its own declaration.
          return matcher ? matcher.test(url) : !isApiPath(url);
        }),
        `${row.effect_test} [${condition}]: the receiver saw ${url}, which no declared send covers`,
      );
    }
    for (const send of row.sends) {
      if (!send.observed_in.includes(condition)) continue;
      const matcher = destinationMatcher(send.destination);
      assert.ok(
        matcher ? urls.some((url) => matcher.test(url)) : urls.length > 0,
        `${row.effect_test} [${condition}]: declared send to ${send.destination} was not observed (saw: ${urls.join(", ") || "nothing"})`,
      );
    }

    // (4) A preflight row's allowances, enforced independently of what the row
    // declares for the invocation that gets PAST the preflight. Both halves
    // were holes: `logout` declared `{home}/**` for the credential a completed
    // login writes, which also licensed its refusal to write anywhere under the
    // home directory; and a destination the receiver only stands in for
    // ({base-url}, the login gateway) matched any request path at all, so a
    // request to an endpoint nobody declared passed. Here the allowance lists
    // are the whole permission: paths, exactly, and request paths, literally.
    if (row.test_scope === "preflight") {
      const allowed = row.preflight.may_write.map((path) => writeMatchers({ writes: [{ path }] }, tokens, journalPaths)[0]);
      for (const path of changed) {
        assert.ok(
          allowed.some((matcher) => matcher.matches(path)),
          `${row.effect_test} [${condition}]: the preflight wrote ${path}, which preflight.may_write does not allow` +
            ` (allowed: ${row.preflight.may_write.join(", ") || "nothing"})`,
        );
      }
      // Said again for the home directory in its own terms: the skills dirs,
      // the credential store and the consent file all live under the temp HOME
      // this run sets, and a preflight that writes one of them has to have
      // named it.
      for (const path of changed.filter((candidate) => candidate === tokens["{home}"] || candidate.startsWith(`${tokens["{home}"]}/`))) {
        assert.ok(
          row.preflight.may_write.some((allowance) => allowance.startsWith("{home}")),
          `${row.effect_test} [${condition}]: the preflight wrote ${path} under the user's home directory and preflight.may_write names nothing there`,
        );
      }
      for (const url of urls) {
        const path = requestPath(url);
        assert.ok(
          row.preflight.may_contact.some((allowance) => contactMatcher(allowance).test(path)),
          `${row.effect_test} [${condition}]: the preflight contacted ${path}, which preflight.may_contact does not allow` +
            ` (allowed: ${row.preflight.may_contact.join(", ") || "nothing"})`,
        );
      }
    }

    // (5) A read-only row is the strongest claim in the file, so state it once
    // more in its own terms rather than leaving it implied by an empty list.
    if (row.annotations.readOnlyHint) {
      assert.deepEqual(changed, [], `${row.effect_test} [${condition}]: a readOnlyHint row changed the target`);
      assert.deepEqual(urls, [], `${row.effect_test} [${condition}]: a readOnlyHint row contacted the receiver`);
    }
  } finally {
    await receiver.close();
    rmSync(seed.dir, { recursive: true, force: true });
  }
}

// Every row in the contract gets its own case, named exactly as the row's
// `effect_test` names it — which is what scripts/check-effects.mjs greps for,
// so a row can never be published with a test that does not exist.
for (const row of CONTRACT.rows) {
  const invocation = INVOCATIONS[rowKey(row)];
  test(row.effect_test, async () => {
    assert.ok(invocation, `contracts/effects.v1.json row ${rowKey(row)} has no invocation in src/effects.test.mjs`);
    // The five conditions are independent targets, so they run together: the
    // file spawns the CLI ~450 times and serialising them costs minutes.
    await Promise.all(CONDITIONS.map((condition) => runCondition(row, invocation, condition)));
  });
}

// The `*refused*` row covers three shapes and the generated case can only run
// one, so the other two are asserted here against the same claim: a refused
// invocation writes no file of its own, journal entry included.
test("effects: the other two refused shapes write nothing either", async () => {
  const shapes = [
    { argv: ["tooling", "statuss", "--json"], label: "an unknown subcommand" },
    { argv: ["standardize", "--dryrun"], label: "a flag the command refuses up front" },
  ];
  for (const condition of CONDITIONS) {
    for (const shape of shapes) {
      const seed = seedTarget();
      try {
        if (condition === "ambient_session") {
          await runCli(["run", "start", "--packet", seed.packetPath, "--json"], { cwd: seed.dir, home: seed.home, telemetry: "off" });
        } else if (condition === "stale_session") {
          seedStaleSession(seed.targetRepo, seed.packetPath);
          seedStaleSession(seed.dir, seed.packetPath);
        }
        const lifecycleLog = condition === "lifecycle_log" ? join(seed.dir, "lifecycle.jsonl") : "";
        const before = snapshot(seed.dir);
        const result = await runCli(shape.argv, { cwd: seed.dir, home: seed.home, telemetry: "off", lifecycleLog });
        assert.notEqual(result.code, 0, `${shape.label} was not refused`);
        assert.deepEqual(
          changedPaths(before, snapshot(seed.dir)),
          [],
          `${shape.label} [${condition}]: a refused invocation wrote something`,
        );
      } finally {
        rmSync(seed.dir, { recursive: true, force: true });
      }
    }
  }
});

test("effects: unknown next stage leaves a seeded packet target untouched", async () => {
  const seed = seedTarget();
  try {
    const sidecar = join(seed.targetRepo, ".campaign-runtime/doctor-output.json");
    rmSync(sidecar);
    const before = snapshot(seed.dir);
    const result = await runCli(["next", "bogus-stage", "--packet", seed.packetPath, "--no-remit"], {
      cwd: seed.dir,
      home: seed.home,
      telemetry: "off",
      lifecycleLog: join(seed.dir, "lifecycle.jsonl"),
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Accepted stages: setup, build, polish, deploy, qa/);
    assert.equal(existsSync(sidecar), false, "unknown stage must not create doctor output");
    assert.deepEqual(snapshot(seed.dir), before, "unknown stage must not change the target or journal");
  } finally {
    rmSync(seed.dir, { recursive: true, force: true });
  }
});

test("effects: next help stage list matches its refusal", async () => {
  const seed = seedTarget();
  try {
    const help = await runCli(["help"], { cwd: seed.dir, home: seed.home, telemetry: "off" });
    const refused = await runCli(["next", "bogus-stage", "--packet", seed.packetPath], { cwd: seed.dir, home: seed.home, telemetry: "off" });
    const usage = help.stdout.match(/campaigns-os next \[([^\]]+)\] --packet/);
    const accepted = refused.stderr.match(/Accepted stages: ([^.]+)\./);
    assert.ok(usage);
    assert.ok(accepted);
    assert.deepEqual(usage[1].split("|"), accepted[1].split(", "));
  } finally {
    rmSync(seed.dir, { recursive: true, force: true });
  }
});

test("effects: every invocation in the test table is a row in the contract", () => {
  const keys = new Set(CONTRACT.rows.map(rowKey));
  const orphans = Object.keys(INVOCATIONS).filter((key) => !keys.has(key));
  assert.deepEqual(orphans, [], "an invocation with no row proves nothing — add the row or drop the invocation");
});

// --- the harness under its own test -----------------------------------------
//
// Everything above is only worth its runtime if it FAILS on the things it
// claims to catch. Each case below seeds one of the defects this suite missed
// and asserts the assertion bites. They run the real CLI, like every other case
// here: a mocked failure would prove the assertion's wording, not its reach.

const fabricate = (overrides) => ({
  effect_test: "seeded defect",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  tier: "B",
  writes: [],
  sends: [],
  test_scope: "full",
  ...overrides,
});

test("effects: a send the row does not declare fails it under persisted scoped consent", async () => {
  // `next` POSTs the progress observation to {proxy-base}/api/progress once
  // consent is persisted for that endpoint. Under the four session conditions
  // that send is invisible (consent is off), which is exactly how six rows came
  // to declare none. Stripped of its sends, the row must fail — in the fifth
  // condition, and only there.
  const declared = CONTRACT.rows.find((row) => rowKey(row) === "next");
  const stripped = fabricate({ writes: declared.writes, sends: [], effect_test: "seeded: next with its progress send removed" });
  await assert.rejects(
    () => runCondition(stripped, INVOCATIONS.next, "persisted_consent"),
    /the receiver saw \/api\/progress, which no declared send covers/,
    "an undeclared consent-gated send passed under persisted scoped consent",
  );
  await runCondition(stripped, INVOCATIONS.next, "no_session");
});

test("effects: a home-directory write fails a preflight row that did not name it", async () => {
  // The defect this reproduces: `logout` declared `{home}/**` for the
  // credential a completed login writes, and that declaration also licensed its
  // PREFLIGHT to write anywhere under the home directory. `install-skills`
  // writes the skills tree under HOME, so a preflight row with the same broad
  // declaration and no allowance for it must be refused.
  const row = fabricate({
    effect_test: "seeded: a preflight row whose refusal writes the home directory",
    writes: [{ path: "{home}/**", when: "the completed command writes there", observed_in: [], not_observed_reason: "seeded" }],
    test_scope: "preflight",
    preflight: { may_write: [], may_contact: [] },
  });
  await assert.rejects(
    () => runCondition(row, INVOCATIONS["install-skills"], "no_session"),
    /the preflight wrote home\/[^ ]*, which preflight\.may_write does not allow/,
    "a home-directory write passed a preflight row that allowed nothing",
  );
});

test("effects: a request to an endpoint a preflight row did not name fails it", async () => {
  // The other half of the same hole: a destination the receiver only stands in
  // for matched any request path at all, so an injected endpoint passed. With
  // the allowance empty, the declared-and-observed GET /api/runs is still the
  // request the preflight is not allowed to make.
  const row = fabricate({
    effect_test: "seeded: a preflight row that contacts an endpoint it did not allow",
    tier: "A",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    writes: [{ path: "{lifecycle-journal}", when: "a journal is selected", observed_in: [] , not_observed_reason: "seeded" }],
    sends: [{ destination: "{proxy-base}/api/runs", what: "a read", when: "always", requires_consent: false, observed_in: ["no_session"] }],
    test_scope: "preflight",
    preflight: { may_write: ["{lifecycle-journal}"], may_contact: [] },
  });
  await assert.rejects(
    () => runCondition(row, INVOCATIONS["telemetry list"], "no_session"),
    /preflight contacted \/api\/runs, which preflight\.may_contact does not allow/,
    "an undeclared endpoint passed a preflight row that allowed none",
  );
});

test("effects: persisted scoped consent never reaches the canonical endpoint", async () => {
  // The control on the whole condition. The remit endpoint is a hard-coded
  // constant with no env override, so `next` WITHOUT --proxy-base resolves the
  // canonical endpoint — and must still send nothing, because the persisted
  // grant covers the loopback scope only and a scope mismatch resolves OFF.
  // Asserted two ways: the loopback receiver sees nothing, and the
  // NODE_DEBUG=net trace names no host but 127.0.0.1 (the same trace every
  // persisted-consent run is checked against, so its sensitivity is not
  // assumed — the run above it, which DOES contact the loopback, shows the
  // trace records connections at all).
  const seed = seedTarget();
  const receiver = await startReceiver();
  try {
    const granted = await runCli(["telemetry", "on", "--proxy-base", receiver.base, "--json"], { cwd: seed.dir, home: seed.home, telemetry: "off" });
    assert.equal(granted.code, 0, granted.stderr);

    const toLoopback = await runCli(["next", "--packet", seed.packetPath, "--proxy-base", receiver.base, "--json"], {
      cwd: seed.dir, home: seed.home, telemetry: "", campaignKey: SYNTHETIC_CAMPAIGN_KEY, traceNetwork: true,
    });
    assert.deepEqual(receiver.hits.map((hit) => hit.url), ["/api/progress"], "the consented endpoint was not contacted, so this test proves nothing about the one below");
    assert.deepEqual(connectedHosts(toLoopback.stderr), ["127.0.0.1"], "the network trace did not record the connection it was watching for");

    receiver.hits.length = 0;
    const toCanonical = await runCli(["next", "--packet", seed.packetPath, "--json"], {
      cwd: seed.dir, home: seed.home, telemetry: "", campaignKey: SYNTHETIC_CAMPAIGN_KEY, traceNetwork: true,
    });
    assert.deepEqual(receiver.hits, [], "a canonical-endpoint remit reached the loopback receiver");
    assert.deepEqual(
      offMachineHosts(toCanonical.stderr),
      [],
      "an invocation with consent persisted for the loopback scope opened a connection off this machine",
    );
  } finally {
    await receiver.close();
    rmSync(seed.dir, { recursive: true, force: true });
  }
});
