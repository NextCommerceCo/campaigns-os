// Synthetic fixtures for the F1.0 row tests (src/qc-*.test.mjs). Imported only
// by those tests. Every value here is synthetic: example.invalid hosts (one
// documentation-reserved example.org store URL, see campaignFixture), the
// synthetic operator "Jordan Lee", and stand-in records shaped like the
// package records the contract names.
//
// Stand-in override. Test-only stand-in checks reach the code
// only through one in-process object the test passes, never an environment
// variable, argv flag, file on disk or default registry entry:
//
//   qcStandIns = {
//     doctor: [ () => QcResult[] ],
//       // Synthetic doctor checks. Each is called with no arguments on every
//       // doctor recomputation (doctor, next, checkpoint accept) and returns
//       // full campaigns-os-qc-result/v0 rows (leg "doctor").
//     qa: { "<check id>": (observation) => Derived | null },
//       // Synthetic QA re-derivers keyed by check id. Derived is
//       // {check, subject, result, reason_code, members, accept_eligible,
//       // coverage, state}; the reader computes state_fingerprint as
//       // qcStateFingerprint({subject, state}). null means the observation
//       // cannot be re-derived (an enum value outside the vocabulary).
//     polish: { thresholds, vocabulary, evaluate(cell, thresholds) => Derived[] },
//       // Synthetic 1.3 thresholds, record vocabulary and per-cell rules.
//   }
//
// Passed as main(argv, { qcStandIns }), doctorPacket(path, { qcStandIns }),
// readQaResults({ ..., qcStandIns }) and readMediaWeight({ ..., qcStandIns }).
//
// No network. Importing this module, before it loads any module under test,
// turns Run Telemetry remit off by the repo's own opt-out
// (CAMPAIGNS_OS_TELEMETRY=off) and replaces globalThis.fetch and node:http /
// node:https request() and get() with stubs that record the attempt in
// networkAttempts and throw (builtin ESM bindings re-synced, so named imports
// see the stubs). The modules under test are therefore imported dynamically
// below, after the guard. Every test file registers assertNoNetworkAttempts as
// a top-level afterEach (and after) hook, so an attempt fails its test even if
// the module under test swallows the thrown error. runCli, withNoNetwork and
// doctorOf also assert no attempt around each call.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const networkAttempts = [];
function blockedRequest(kind, target) {
  networkAttempts.push(`${kind} ${target}`);
  throw new Error(`qc-test-factories: network blocked (${kind} ${target})`);
}
const requestTarget = (input) => (typeof input === "string" || input instanceof URL
  ? String(input)
  : `${input?.protocol ?? ""}//${input?.hostname ?? input?.host ?? ""}${input?.path ?? ""}`);
const blockedFetch = (input) => blockedRequest("fetch", String(input?.url ?? input));
const blockedTransports = [
  [http, "request", (input) => blockedRequest("http.request", requestTarget(input))],
  [http, "get", (input) => blockedRequest("http.get", requestTarget(input))],
  [https, "request", (input) => blockedRequest("https.request", requestTarget(input))],
  [https, "get", (input) => blockedRequest("https.get", requestTarget(input))],
];
const networkGuardInstalled = () => globalThis.fetch === blockedFetch && blockedTransports.every(([object, method, stub]) => object[method] === stub);
function installNetworkGuard() {
  process.env.CAMPAIGNS_OS_TELEMETRY = "off";
  if (networkGuardInstalled()) return;
  globalThis.fetch = blockedFetch;
  for (const [object, method, stub] of blockedTransports) object[method] = stub;
  syncBuiltinESMExports();
}
installNetworkGuard();

// The per-test check: every attempt recorded since the last check fails the
// running test, as does a guard the code under test removed (it is put back).
export function assertNoNetworkAttempts() {
  const attempts = networkAttempts.splice(0);
  const intact = networkGuardInstalled();
  installNetworkGuard();
  assert.deepEqual(attempts, [], "no outbound request was attempted");
  assert.equal(intact, true, "the no-network guard was left installed");
}

const { computeBuildFingerprint } = await import("./built-site-scope.mjs");
const { checkpointStateFingerprint } = await import("./checkpoint-waiver.mjs");
const { main } = await import("./cli.mjs");
const { doctorPacket } = await import("./doctor/inspect.mjs");
const { buildPolishCaptureIntegrity, canonicalJson } = await import("./polish-capture.mjs");
const { currentPacketInputs, inputStamps } = await import("./input-currency.mjs");

// Runs `run` (sync or async) under the guard, then asserts that no outbound
// request was attempted.
export async function withNoNetwork(run) {
  const start = networkAttempts.length;
  installNetworkGuard();
  try {
    return await run();
  } finally {
    installNetworkGuard();
    assert.deepEqual(networkAttempts.slice(start), [], "no outbound request was attempted");
  }
}
function withNoNetworkSync(run) {
  const start = networkAttempts.length;
  installNetworkGuard();
  try {
    return run();
  } finally {
    installNetworkGuard();
    assert.deepEqual(networkAttempts.slice(start), [], "no outbound request was attempted");
  }
}

// doctorPacket under the no-network guard.
export const doctorOf = (packetPath, options) => withNoNetworkSync(() => doctorPacket(packetPath, options));

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OPERATOR = "Jordan Lee";
export const ORIGIN = "https://preview.example.invalid";
export const OTHER_ORIGIN = "https://cdn.example.invalid";
export const SLUG = "runtime-packet-demo";
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
export const delay = (ms) => new Promise((done) => setTimeout(done, ms));
export const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
export const readBytes = (path) => (existsSync(path) ? readFileSync(path) : null);

// The 12-hex prefix of a sha256 state fingerprint, as `--result <id>@<fp12>`
// binds it.
export const fp12 = (fingerprint) => String(fingerprint).replace(/^sha256:/, "").slice(0, 12);
export const refOf = (row) => `${row.id}@${fp12(row.state_fingerprint)}`;

// ---------------------------------------------------------------------------
// Campaign fixture: the shipped example packet and target, made `ready` for
// doctor and next. Every doctor warning the example carries is cleared:
// SDK hints dropped, a Build Brief, a preview URL, every default-on payment
// method declared. campaign.store_url uses the documentation-reserved
// example.org host because doctor reads every .invalid/.example/.test host as
// a placeholder store and warns; no request is ever sent to it.
export function campaignFixture({ setupCompleted = false, site = false, mutateSpec = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "qc-f10-"));
  for (const file of ["build-packet.basic.json", "campaignspec.v42.basic.json"]) {
    cpSync(join(ROOT, "examples", file), join(dir, file));
  }
  cpSync(join(ROOT, "examples/source-html"), join(dir, "source-html"), { recursive: true });
  cpSync(join(ROOT, "examples/target-page-kit"), join(dir, "target-page-kit"), { recursive: true });
  mkdirSync(join(dir, "contracts"), { recursive: true });
  cpSync(join(ROOT, "contracts/commerce-surface-catalog.json"), join(dir, "contracts/commerce-surface-catalog.json"));

  const packetPath = join(dir, "build-packet.basic.json");
  const packet = readJson(packetPath);
  packet.assembly.commerce_catalog.path = "contracts/commerce-surface-catalog.json";
  packet.assembly.commerce_catalog.required = false;
  packet.deploy.preview_url = `${ORIGIN}/${SLUG}/`;
  const briefRel = "target-page-kit/.campaign-runtime/input/campaign-build-brief.normalized.json";
  packet.build_brief = { normalized_path: briefRel, status: "complete" };
  writeJson(packetPath, packet);
  writeJson(join(dir, briefRel), {
    schema_version: "campaigns-os-build-brief/v1",
    status: "complete",
    _meta: { mode: "guided_draft" },
    questions: [],
    gates: [],
    commerce_surfaces: { payment_methods_allowed: ["card"], hidden_payment_methods: [] },
    promo_urgency: { forbid_placeholders: true },
    template_residue_policy: { block_placeholders: true },
  });

  const specPath = join(dir, "campaignspec.v42.basic.json");
  const spec = readJson(specPath);
  for (const funnel of spec.funnels || []) for (const page of funnel.pages || []) delete page.sdk_hints;
  spec.campaign.store_url = "https://store.example.org";
  spec.campaign.available_express_payment_methods = ["paypal", "klarna", "apple_pay", "google_pay"];
  if (mutateSpec) mutateSpec(spec);
  writeJson(specPath, spec);

  const targetRepo = join(dir, "target-page-kit");
  const campaignsPath = join(targetRepo, "_data/campaigns.json");
  const campaigns = readJson(campaignsPath);
  campaigns[SLUG].store_url = "https://store.example.org";
  writeJson(campaignsPath, campaigns);

  const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
  const report = readJson(join(ROOT, "examples/assembly-report.example.json"));
  report.identity.map_id = packet.spec.map_id;
  report.identity.public_route_slug = packet.campaign.public_route_slug;
  report.evidence = [];
  if (setupCompleted) report.stages.setup.status = "completed";
  writeJson(reportPath, report);

  if (site) writeSitePage({ targetRepo }, "<p>synthetic build one</p>");

  const fixture = {
    dir,
    packetPath,
    specPath,
    targetRepo,
    reportPath,
    sidecarPath: join(targetRepo, ".campaign-runtime/doctor-output.json"),
    qaSidecarPath: join(dir, ".campaign-runtime/qa-verdict.json"),
    // The stand-in 1.5 check reads this synthetic built page. The real check
    // reads the built site under _site/ instead.
    builtPagePath: join(dir, "qc-built", SLUG, "index.html"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  setBuiltPage(fixture, "<p>Synthetic cart line</p>");
  return fixture;
}

export function writeSitePage(fixture, body) {
  const path = join(fixture.targetRepo, "_site", SLUG, "index.html");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `<!doctype html><html><head><title>Synthetic</title></head><body>${body}</body></html>\n`);
}

export function setBuiltPage(fixture, body) {
  mkdirSync(dirname(fixture.builtPagePath), { recursive: true });
  writeFileSync(fixture.builtPagePath, `<!doctype html><html><head><title>Synthetic</title></head><body>${body}</body></html>\n`);
}

export function mutateReport(fixture, mutate) {
  const report = readJson(fixture.reportPath);
  const next = mutate(report) || report;
  writeJson(fixture.reportPath, next);
  return next;
}

// ---------------------------------------------------------------------------
// QC result rows.
export function qcRow({ check, leg, page, key, result, reason_code = null, state, observation = {}, members = [], accept_eligible, coverage = { observed: 1, expected: 1, limits: [] }, measured_at = new Date().toISOString(), producer, viewport }) {
  const subject = { check, page, key, ...(viewport ? { viewport } : {}) };
  return {
    schema: "campaigns-os-qc-result/v0",
    id: `${check}:${page}:${key}`,
    check,
    leg,
    result,
    reason_code,
    subject,
    state_fingerprint: checkpointStateFingerprint({ scope: "qc", subject, state }),
    observation,
    members,
    accept_eligible: accept_eligible ?? (result === "warning" && !members.some((m) => m.result === "review" || m.result === "unexercised")),
    coverage,
    measured_at,
    producer,
  };
}

// Stand-in 1.5 check (cart_placeholders / live_token): one warning per live
// token found in the synthetic built page; the state is the exact count.
export const LIVE_TOKENS = ["{item.name}", "{item.price}"];
export function liveTokenStandIn(fixture) {
  return () => {
    const html = existsSync(fixture.builtPagePath) ? readFileSync(fixture.builtPagePath, "utf8") : "";
    return LIVE_TOKENS.flatMap((token) => {
      const count = html.split(token).length - 1;
      if (count === 0) return [];
      return [qcRow({
        check: "cart_placeholders",
        leg: "doctor",
        page: "index",
        key: token,
        result: "warning",
        reason_code: "live_token",
        state: { reason_code: "live_token", token, count },
        observation: { token, count },
        producer: "campaigns-os doctor",
      })];
    });
  };
}
export const liveTokenId = (token) => `cart_placeholders:index:${token}`;

// Stand-in doctor check returning fixed rows (any result value), recomputed
// with a fresh measured_at on every call.
export function fixedDoctorStandIn(specs) {
  return () => specs.map(({ key, result, reason_code = null, members = [], accept_eligible }) => qcRow({
    check: "standin_doctor",
    leg: "doctor",
    page: "index",
    key,
    result,
    reason_code,
    state: { reason_code, key, members },
    observation: { key, members: members.length },
    members,
    accept_eligible,
    producer: "campaigns-os doctor",
  }));
}
export const fixedDoctorId = (key) => `standin_doctor:index:${key}`;

// ---------------------------------------------------------------------------
// QA stand-ins: a synthetic re-deriver and package-shaped rows, assertions,
// full verdict and stage record.
const QA_OUTCOMES = Object.freeze({
  reachable: { result: "pass", reason_code: null },
  unreachable: { result: "warning", reason_code: "policy_unreachable" },
  ambiguous: { result: "review", reason_code: "policy_wording_unclear" },
  readiness_timeout: { result: "unexercised", reason_code: "readiness_timeout" },
  not_requested: { result: "excluded", reason_code: "browser_checks_not_requested" },
});

export function qaRederive(observation) {
  const mapped = QA_OUTCOMES[observation?.outcome];
  if (!mapped || Object.prototype.hasOwnProperty.call(Object.prototype, observation?.outcome)) return null;
  const subject = { check: observation.check, page: observation.page, key: observation.key };
  return {
    check: observation.check,
    subject,
    result: mapped.result,
    reason_code: mapped.reason_code,
    members: [],
    accept_eligible: mapped.result === "warning",
    coverage: { observed: 1, expected: 1, limits: [] },
    state: { reason_code: mapped.reason_code, outcome: observation.outcome, key: observation.key },
  };
}
export const QA_STANDIN_CHECKS = ["policy.availability", "policy.presence", "content_param", "tracking.order"];
export const qaStandIns = () => Object.fromEntries(QA_STANDIN_CHECKS.map((check) => [check, qaRederive]));

const QA_ASSERTION_STATUS = Object.freeze({
  pass: ["pass", "info"],
  warning: ["warn", "warn"],
  review: ["manual_review", "warn"],
  unexercised: ["manual_review", "warn"],
  excluded: ["skipped", "info"],
});

export function qaObservation({ check = "policy.availability", page = "campaign", key = "store_terms", outcome = "unreachable" } = {}) {
  return { check, page, key, outcome };
}

export function qaRowFor(observation, { measured_at } = {}) {
  const derived = qaRederive(observation);
  return qcRow({
    check: derived.check,
    leg: "qa",
    page: derived.subject.page,
    key: derived.subject.key,
    result: derived.result,
    reason_code: derived.reason_code,
    state: derived.state,
    observation,
    members: derived.members,
    accept_eligible: derived.accept_eligible,
    coverage: derived.coverage,
    measured_at,
    producer: "campaigns-os qa run",
  });
}

export function qaAssertionFor(row, observation = row.observation) {
  const [status, severity] = QA_ASSERTION_STATUS[row.result] || ["manual_review", "warn"];
  return {
    id: `qc.${row.id}`,
    family: "browser-runtime",
    page: row.subject.page,
    status,
    severity,
    evidence: { qc: { result_id: row.id, observation } },
  };
}

export const QA_RUN_ID = "qc-synthetic-run-0001";
// The synthetic build: BUILD_FP is the fingerprint of the built output
// writeSyntheticBuild writes, so a fixture holding that output and recording
// BUILD_FP reads doctor's output fingerprint as pass. The page carries the
// head tags and the og:image file the built-output smoke checks look for, so
// it adds no doctor warning of its own.
export function writeSyntheticBuild(fixture) {
  const root = join(fixture.targetRepo, "_site", SLUG);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "og.png"), "synthetic og image\n");
  writeFileSync(join(root, "index.html"), `<!doctype html><html><head><title>Synthetic</title><link rel="icon" href="data:,"><meta property="og:title" content="Synthetic"><meta property="og:description" content="Synthetic build one"><meta property="og:image" content="${ORIGIN}/${SLUG}/og.png"></head><body><p>synthetic build one</p></body></html>\n`);
}
export const BUILD_FP = (() => {
  const dir = mkdtempSync(join(tmpdir(), "qc-build-fp-"));
  try {
    writeSyntheticBuild({ targetRepo: dir });
    return computeBuildFingerprint(join(dir, "_site", SLUG)).fingerprint;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
export const OTHER_BUILD_FP = sha256("synthetic build zero");

export function fullVerdict({ assertions, runId = QA_RUN_ID, measuredAt }) {
  return {
    schema_version: "1.0",
    run_id: runId,
    campaign_slug: SLUG,
    spec_version: "v42",
    spec_hash: sha256("synthetic spec"),
    started_at: measuredAt,
    completed_at: measuredAt,
    runtime: `campaigns-os-node-qa@${PACKAGE_VERSION}`,
    disposition: "ready_with_exceptions",
    assertions,
    test_orders: [],
    exceptions: [],
  };
}

// Writes a QA stage the way `qa run` would: the full verdict under
// {target}/qa-output/, the committed sidecar beside the packet, and
// stages.qa with outputs, identity and evidence. Returns what it wrote.
export function installQaStage(fixture, {
  observations = [qaObservation()],
  rows: givenRows = null,
  assertions: givenAssertions = null,
  qcBuildFingerprint = BUILD_FP,
  buildFingerprint = BUILD_FP,
  evidence: givenEvidence,
  verdictPatch = null,
  measuredAt = new Date(Date.now() - 60_000).toISOString(),
} = {}) {
  const rows = givenRows || observations.map((observation) => qaRowFor(observation, { measured_at: measuredAt }));
  const assertions = givenAssertions || rows.map((row) => qaAssertionFor(row));
  // verdictPatch tampers with the full verdict file only: the committed
  // sidecar and stages.qa.identity keep the run `qa run` recorded (QA_RUN_ID).
  const verdict = { ...fullVerdict({ assertions, measuredAt }), ...(verdictPatch || {}) };
  const verdictPath = join(fixture.targetRepo, "qa-output", "runtime-packet-demo-k9x2", `${QA_RUN_ID}.json`);
  writeJson(verdictPath, verdict);
  writeJson(fixture.qaSidecarPath, {
    schema_version: "campaigns-os-qa-verdict-sidecar/v0",
    run_id: QA_RUN_ID,
    disposition: verdict.disposition,
    assertions: assertions.map(({ id, family, page, status, severity }) => ({ id, family, page, status, severity })),
  });
  const evidence = givenEvidence !== undefined ? givenEvidence : { qc_results: rows, qc_build_fingerprint: qcBuildFingerprint };
  const stage = {
    stage: "qa",
    status: "completed",
    inputs: [],
    outputs: [verdictPath, fixture.qaSidecarPath],
    commands: ["campaigns-os qa run"],
    blockers: [],
    warnings: ["QA passed with explicitly attributed exceptions. Report them to the operator; do not clear or waive them, or change markup just to make them pass."],
    completed_at: measuredAt,
    identity: { verdict_run_id: QA_RUN_ID },
    evidence,
    // Stamped with the packet's inputs now, as the QA stage write stamps them.
    ...inputStamps(currentPacketInputs({ packet: readJson(fixture.packetPath), packetPath: fixture.packetPath })),
  };
  mutateReport(fixture, (report) => {
    if (buildFingerprint) report.stages.assembly.build_fingerprint = buildFingerprint;
    report.stages.qa = stage;
  });
  return { rows, assertions, verdict, verdictPath, stage };
}

// ---------------------------------------------------------------------------
// Polish stand-ins: a page_load evidence block (stored projection shape) and a
// sibling media_weight record (contract 1.3 Observations shape).
export const MEDIA_WEIGHT_THRESHOLDS = Object.freeze({ image_bytes: 500_000, oversize_factor: 2.0, min_natural_area: 250_000 });
export const MEDIA_WEIGHT_VOCABULARY = Object.freeze({
  capture_status: ["complete", "incomplete"],
  probe_status: ["complete", "document_context_changed", "probe_timeout", "image_cap_reached", "probe_budget_exhausted"],
  measurement: ["complete", "lower_bound", "unmeasured", "cached"],
  object_fit: ["fill", "contain", "cover", "none", "scale-down"],
  loading: ["eager", "lazy", "auto"],
});

// Stand-in 1.3 rules: one media.weight result per resource and per
// unfetched same-origin <video>, judged with the given thresholds.
export function polishEvaluate(cell, thresholds) {
  const results = [];
  for (const resource of cell.resources || []) {
    let result;
    let reason_code;
    if (resource.failed) [result, reason_code] = ["unexercised", "not_loaded"];
    else if (!resource.final_origin_equal) [result, reason_code] = resource.measurement === "complete" ? ["pass", null] : ["unexercised", "transfer_partial"];
    else if ((cell.videos || []).some((video) => video.resource_ids.includes(resource.resource_id))) [result, reason_code] = ["warning", "video_from_document_origin"];
    else if (resource.transferred_bytes > thresholds.image_bytes && ["complete", "lower_bound"].includes(resource.measurement)) [result, reason_code] = ["warning", "image_over_threshold"];
    else if (resource.measurement === "complete") [result, reason_code] = ["pass", null];
    else [result, reason_code] = ["unexercised", "transfer_partial"];
    const subject = { check: "media.weight", page: cell.route, viewport: cell.viewport, key: resource.resource_id };
    results.push({
      check: "media.weight",
      subject,
      result,
      reason_code,
      members: [],
      accept_eligible: result === "warning",
      coverage: { observed: 1, expected: 1, limits: [] },
      state: {
        reason_code,
        measurement: resource.measurement,
        transferred_bytes: resource.transferred_bytes,
        declared_bytes: resource.declared_bytes,
        final_url: resource.chain.at(-1).url,
        final_origin_equal: resource.final_origin_equal,
        chain: resource.chain,
      },
    });
  }
  for (const video of cell.videos || []) {
    if (video.resource_ids.length || !video.declared_origin_equal) continue;
    const subject = { check: "media.weight", page: cell.route, viewport: cell.viewport, key: `video:${video.element_index}` };
    results.push({
      check: "media.weight",
      subject,
      result: "unexercised",
      reason_code: "not_loaded",
      members: [],
      accept_eligible: false,
      coverage: { observed: 0, expected: 1, limits: [] },
      state: { reason_code: "not_loaded", element_index: video.element_index },
    });
  }
  return results;
}
export const polishStandIn = () => ({ thresholds: { ...MEDIA_WEIGHT_THRESHOLDS }, vocabulary: MEDIA_WEIGHT_VOCABULARY, evaluate: polishEvaluate });

// A media_weight resource is keyed by its first hop's resource_id.
export const resourceIdOf = (url) => sha256(url);

// media_weight integrity: unkeyed sha256 over the canonical JSON of every
// field but `integrity` (the buildPolishCaptureIntegrity pattern).
export function mediaWeightIntegrity(record) {
  const { integrity: _ignored, ...rest } = record;
  return sha256(canonicalJson(rest));
}
export function withRecomputedIntegrity(record) {
  return { ...record, integrity: mediaWeightIntegrity(record) };
}

function ledgerEntry({ url, type = "image", bytes, status = 200, crossOrigin = false, canceled = 0, failed = 0, declared = null, matchIds = [] }) {
  const id = resourceIdOf(url);
  return {
    resource_id: id,
    url,
    resource_type: type,
    resource_type_status: "known",
    transferred_bytes: bytes,
    request_count: 1,
    declared_bytes: declared ?? 0,
    canceled_request_count: canceled,
    declared_request_count: declared == null ? 0 : 1,
    unmeasured_request_count: 0,
    failed_request_count: failed,
    statuses: [status],
    partial_request_count: 0,
    cross_origin_request_count: crossOrigin ? 1 : 0,
    cache_request_count: 0,
    service_worker_request_count: 0,
    match_resource_ids: [...new Set([id, ...matchIds])].sort(),
  };
}

function measurementOf(entry) {
  if (entry.cache_request_count > 0) return "cached";
  if (entry.unmeasured_request_count > 0) return "unmeasured";
  if (entry.canceled_request_count > 0 || entry.partial_request_count > 0) return "lower_bound";
  return "complete";
}

// One resource spec → its ledger entries (one per hop) and its media_weight
// projection. `redirectFrom` adds a cross-origin 302 first hop.
function buildResource({ path, type = "image", bytes, canceled = 0, failed = 0, declared = null, redirectFrom = null }) {
  const finalUrl = `${ORIGIN}${path}`;
  const hops = [];
  if (redirectFrom) hops.push({ url: redirectFrom, status: 302, bytes: 420, crossOrigin: true, type: "other" });
  const finalMatchIds = hops.map((hop) => resourceIdOf(hop.url));
  const entries = hops.map((hop) => ledgerEntry({ url: hop.url, type: hop.type, bytes: hop.bytes, status: hop.status, crossOrigin: hop.crossOrigin }));
  const finalEntry = ledgerEntry({ url: finalUrl, type, bytes, canceled, failed, declared, matchIds: finalMatchIds });
  entries.push(finalEntry);
  const chain = entries.map((entry) => ({ url: entry.url, resource_id: entry.resource_id, status: entry.statuses[0] }));
  return {
    entries,
    resource: {
      resource_id: chain[0].resource_id,
      url: chain[0].url,
      type: finalEntry.resource_type,
      transferred_bytes: finalEntry.transferred_bytes,
      declared_bytes: finalEntry.declared_request_count > 0 ? finalEntry.declared_bytes : null,
      measurement: measurementOf(finalEntry),
      failed: finalEntry.failed_request_count > 0,
      chain,
      final_origin_equal: finalEntry.cross_origin_request_count === 0,
    },
  };
}

export const ROUTES = ["/runtime-packet-demo/", "/runtime-packet-demo/checkout/"];
export const VIEWPORT = "desktop";

// cells: [{ route, captureStatus, resources: [resourceSpec], videos: [{ path }] }]
export function mediaWeightFixture({ buildFingerprint = BUILD_FP, cells, measuredAt = new Date(Date.now() - 60_000).toISOString() }) {
  const routes = cells.map((cell) => cell.route);
  const subject = { build_fingerprint: buildFingerprint, campaign_slug: SLUG, route_scope: "all", routes, viewports: [VIEWPORT] };
  const captures = [];
  const mwCells = [];
  for (const cell of cells) {
    const built = (cell.resources || []).map(buildResource);
    const entries = built.flatMap((item) => item.entries);
    const media = (cell.videos || []).map((video, index) => {
      const url = `${ORIGIN}${video.path}`;
      return {
        tag_name: "video",
        element_index: index,
        current_src: null,
        src_attribute: url,
        source_src_attributes: [],
        observed_source_urls: [],
        source_references: [{ source_kind: "src_attribute", source_index: 0, url, resource_id: resourceIdOf(url), status: "http" }],
        preload_attribute: "none",
        preload_defers_fetch: true,
        hidden_at_load: false,
        hidden_by: [],
        zero_size_at_load: false,
        fetched_resources: [],
      };
    });
    const capture = {
      schema_version: "campaigns-os-polish-route-capture/v0",
      performed_by: "campaigns-os polish capture",
      subject: { build_fingerprint: buildFingerprint, campaign_slug: SLUG, requested_route: cell.route, final_document_route: cell.route, viewport: VIEWPORT },
      measurement_status: cell.captureStatus || "complete",
      producer_status: "complete",
      document_response: {
        status: "complete",
        url: `${ORIGIN}${cell.route}`,
        http_status: 200,
        mime_type: "text/html",
        capture_origin: ORIGIN,
        final_origin: ORIGIN,
        origin_matches_capture: true,
      },
      resource_ledger: { limit: 2048, total_resource_count: entries.length, omitted_resource_count: 0, omitted_request_count: 0, entries },
      media,
      problems: cell.captureStatus === "incomplete" ? [{ code: "transfer_size_unavailable", count: 1 }] : [],
    };
    capture.integrity = buildPolishCaptureIntegrity(capture);
    captures.push(capture);
    mwCells.push({
      route: cell.route,
      viewport: VIEWPORT,
      dpr: 1,
      document_origin: ORIGIN,
      page_load_integrity: capture.integrity.projection_fingerprint,
      capture_status: capture.measurement_status,
      probe_status: "complete",
      resources: built.map((item) => item.resource),
      images: built.filter((item) => item.resource.type === "image").map((item, index) => ({
        resource_id: item.resource.resource_id,
        element_path: `body>img:nth-of-type(${index + 1})`,
        complete: true,
        natural: [1200, 800],
        rendered: [1200, 800],
        object_fit: "fill",
        loading: "eager",
        hidden: false,
      })),
      videos: media.map((element) => ({ element_index: element.element_index, resource_ids: [], declared_origin_equal: true })),
    });
  }
  const pageLoad = {
    schema_version: "campaigns-os-polish-page-load/v0",
    performed_by: "campaigns-os polish capture",
    threshold_bytes: 1_048_576,
    subject,
    measurement: { status: captures.every((c) => c.measurement_status === "complete") ? "complete" : "incomplete", expected_capture_count: captures.length, captured_count: captures.length, missing: [], duplicate: [], unexpected: [], incomplete: [], warnings: [] },
    captures,
    findings: [],
  };
  const record = withRecomputedIntegrity({
    schema_version: "campaigns-os-polish-media-weight/v0",
    performed_by: "campaigns-os polish capture",
    measured_at: measuredAt,
    subject,
    thresholds: { ...MEDIA_WEIGHT_THRESHOLDS },
    cells: mwCells,
  });
  return { pageLoad, record };
}

// Two cells: the cell under test (route 0) and an untouched control cell
// (route 1) holding one same-origin 600,000 B complete image (F1.3-B2).
export function twoCellFixture(firstCellResources, { firstCell = {}, buildFingerprint = BUILD_FP } = {}) {
  return mediaWeightFixture({
    buildFingerprint,
    cells: [
      { route: ROUTES[0], resources: firstCellResources, ...firstCell },
      { route: ROUTES[1], resources: [{ path: "/runtime-packet-demo/img/control.jpg", bytes: 600_000 }] },
    ],
  });
}

// A fixture with no built output whose report records BUILD_FP gets the
// synthetic build, so the built output doctor fingerprints is the one
// BUILD_FP names.
export function installPolishEvidence(fixture, { pageLoad, record }, { buildFingerprint } = {}) {
  const recorded = buildFingerprint ?? readJson(fixture.reportPath).stages?.assembly?.build_fingerprint;
  if (recorded === BUILD_FP && fixture.targetRepo && !existsSync(join(fixture.targetRepo, "_site", SLUG))) writeSyntheticBuild(fixture);
  mutateReport(fixture, (report) => {
    if (buildFingerprint) report.stages.assembly.build_fingerprint = buildFingerprint;
    const polish = report.stages.polish || { stage: "polish" };
    report.stages.polish = {
      ...polish,
      evidence: {
        ...(polish.evidence || {}),
        visual_review: { ...(polish.evidence?.visual_review || {}), screenshots: [], page_load: pageLoad, media_weight: record },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// In-process CLI harness: main(argv, options) with stdout/stderr and the exit
// code captured and restored, under the no-network guard; after main()
// returns, asserts that no outbound request was attempted.
export async function runCli(argv, options = {}) {
  const out = [];
  const err = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  const originalStderrWrite = process.stderr.write;
  const networkStart = networkAttempts.length;
  installNetworkGuard();
  console.log = (...values) => out.push(values.join(" "));
  console.error = (...values) => err.push(values.join(" "));
  process.stderr.write = (chunk, ...rest) => {
    err.push(String(chunk));
    const callback = rest.find((value) => typeof value === "function");
    if (callback) callback();
    return true;
  };
  process.exitCode = undefined;
  let error = null;
  let exitCode;
  try {
    await main(argv, options);
  } catch (thrown) {
    error = thrown;
  } finally {
    exitCode = process.exitCode;
    console.log = originalLog;
    console.error = originalError;
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode;
    installNetworkGuard();
  }
  assert.deepEqual(networkAttempts.slice(networkStart), [],`no outbound request was attempted by: campaigns-os ${argv.join(" ")}`);
  const stdout = out.join("\n");
  let json = null;
  try {
    json = stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    json = null;
  }
  return { exitCode: error ? 1 : (exitCode ?? 0), stdout, stderr: err.join("\n"), json, error };
}

export async function runNext(fixture, qcStandIns) {
  const res = await runCli(["next", "--packet", fixture.packetPath, "--json"], { qcStandIns });
  assert.ok(res.json, `next --json printed JSON (exit ${res.exitCode}; ${res.error?.message || res.stderr.slice(0, 300)})`);
  return res.json;
}

export function handoffOf(next) {
  assert.ok(next?.qc_handoff && typeof next.qc_handoff === "object", "next JSON carries a qc_handoff object");
  return next.qc_handoff;
}

export async function runAccept(fixture, refs, { reason = "known synthetic", acceptedBy = OPERATOR, extra = [], qcStandIns } = {}) {
  const argv = ["checkpoint", "accept", "--packet", fixture.packetPath];
  for (const ref of refs) argv.push("--result", ref);
  if (reason != null) argv.push("--reason", reason);
  if (acceptedBy != null) argv.push("--accepted-by", acceptedBy);
  argv.push(...extra, "--json");
  return runCli(argv, { qcStandIns });
}

export function assertAccepted(res) {
  assert.equal(res.error, null, `checkpoint accept did not throw: ${res.error?.message}`);
  assert.equal(res.exitCode, 0, `checkpoint accept exits 0: ${res.stdout.slice(0, 400)} ${res.stderr.slice(0, 400)}`);
  assert.equal(res.json?.ok, true, `checkpoint accept reports ok: ${res.stdout.slice(0, 400)}`);
}

// The closed refusal-code lists (contract 1.0 codes).
export const ACCEPT_REFUSAL_CODES = Object.freeze([
  "accepted_by_required",
  "attribution_invalid",
  "no_persisted_finding",
  "changed_since_handoff",
  "target_not_warning",
  "members_unresolved",
]);
export const INGEST_REFUSAL_CODE = "package_owned_key";
const ALL_REFUSAL_CODES = Object.freeze([...ACCEPT_REFUSAL_CODES, INGEST_REFUSAL_CODE]);
const namesWord = (text, word) => new RegExp(`(^|[^A-Za-z0-9_.])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`).test(text);
const outputText = (res) => [res.stdout, res.stderr, res.error?.message || ""].join("\n");

// Asserts that no refusal code other than `allowed` (or none at all) appears
// anywhere in the command's output.
export function assertNoOtherRefusalCode(res, allowed = null, extra = []) {
  const text = outputText(res);
  for (const other of [...ALL_REFUSAL_CODES, ...extra]) {
    if (other === allowed) continue;
    assert.equal(namesWord(text, other), false, `no other refusal code is reported (found ${other}): ${text.slice(0, 600)}`);
  }
}

// API assumption (every `checkpoint accept` refusal row): a refused
// `checkpoint accept --json` exits non-zero and prints one JSON object
// { ok: false, refusal_code: "<code>", error: "<message>" }. `refusal_code`
// is the one field the code is read from, by exact equality.
export function assertRefused(res, code, { names = [] } = {}) {
  assert.ok(ACCEPT_REFUSAL_CODES.includes(code), `test bug: ${code} is a checkpoint accept refusal code`);
  assert.notEqual(res.exitCode, 0, "a refusal exits non-zero");
  assert.ok(
    res.json && typeof res.json === "object" && !Array.isArray(res.json),
    `the refusal prints one JSON object; got stdout ${JSON.stringify(res.stdout.slice(0, 300))}, error ${JSON.stringify(res.error?.message?.slice(0, 300) ?? null)}`,
  );
  assert.equal(res.json.ok, false, "a refusal reports ok: false");
  assert.equal(res.json.refusal_code, code, `refusal_code is exactly ${code}: ${res.stdout.slice(0, 600)}`);
  assertNoOtherRefusalCode(res, code);
  const text = outputText(res);
  for (const name of names) assert.ok(text.includes(name), `the refusal names ${name}`);
}

// API assumption (F1.0-B2, the ingest refusal): `record polish` keeps its
// thrown "record polish refused; nothing was written:" refusal, and the
// refusal code is the first token after that prefix (after whitespace and the
// existing "- " problem bullet, if any), ending at a non-identifier character:
//   "record polish refused; nothing was written:\n- package_owned_key: <detail naming media_weight>"
// (contract: "named in the refusal message"). No other refusal or capture
// code appears anywhere in the output.
const INGEST_REFUSAL_SHAPE = new RegExp(`^record polish refused; nothing was written:\\s*(?:- )?${INGEST_REFUSAL_CODE}(?![A-Za-z0-9_.])`);
export function assertIngestRefused(res, { names = [] } = {}) {
  assert.notEqual(res.exitCode, 0, "the ingest refusal exits non-zero");
  assert.notEqual(res.json?.ok, true, "the ingest refusal never reports ok");
  assert.ok(res.error instanceof Error, `record polish refused with an error; stdout ${res.stdout.slice(0, 300)}`);
  const message = res.error.message;
  assert.match(message, /^record polish refused; nothing was written:/, "the existing ingest refusal prefix");
  assert.match(message, INGEST_REFUSAL_SHAPE, `${INGEST_REFUSAL_CODE} is the refusal code, first after the prefix: ${message.slice(0, 600)}`);
  for (const name of names) assert.ok(message.includes(name), `the refusal message names ${name}`);
  // The Polish gate's capture code is not an ingest refusal; it must not be
  // reported in place of, or beside, package_owned_key.
  assertNoOtherRefusalCode(res, INGEST_REFUSAL_CODE, ["polish.hidden_eager_media.capture_malformed", "capture_malformed"]);
}

export function snapshot(fixture) {
  return { report: readBytes(fixture.reportPath), sidecar: readBytes(fixture.sidecarPath), qaSidecar: readBytes(fixture.qaSidecarPath) };
}
const sameBytes = (a, b) => (a === null && b === null) || Boolean(a && b && a.equals(b));
export function assertNothingWritten(fixture, before) {
  const after = snapshot(fixture);
  assert.ok(before.report && after.report && before.report.equals(after.report), "the Assembly Report bytes are unchanged");
  assert.ok(sameBytes(before.sidecar, after.sidecar), "the doctor sidecar bytes are unchanged (no stale stamp)");
  assert.ok(sameBytes(before.qaSidecar, after.qaSidecar), "the committed QA sidecar bytes are unchanged");
}

// Counts every write that lands on the Assembly Report while `run` executes:
// writeFile, appendFile, rename onto it, copyFile, cp, link and open with a
// write flag, in their sync, callback and fs.promises forms, plus each write
// made through a descriptor such an open returned (writeSync, write, writev,
// writevSync, writeFile/appendFile on the fd, and FileHandle write, writev,
// writeFile, appendFile; createWriteStream writes go through fs.write). A
// descriptor counts max(1, its writes): open + one write + close is one
// write, two writes through one descriptor are two. Paths are compared after
// resolving the parent directory's real path. A nested call made by a counted
// call (appendFileSync → writeFileSync → openSync → writeSync) is counted
// once. The builtin ESM bindings are re-synced so named imports see the
// counters.
const WRITE_OPEN_BITS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC;
const opensForWrite = (flags) => (typeof flags === "number" ? (flags & WRITE_OPEN_BITS) !== 0 : /[wa+]/.test(String(flags ?? "r")));
function canonicalFile(path) {
  const absolute = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
  try {
    return join(realpathSync(dirname(absolute)), basename(absolute));
  } catch {
    return absolute;
  }
}
export async function countReportWrites(fixture, run) {
  const target = canonicalFile(fixture.reportPath);
  const isPath = (value) => typeof value === "string" || value instanceof URL || Buffer.isBuffer(value);
  const hits = (value) => isPath(value) && canonicalFile(value) === target;
  // Descriptors (fd → writes made through it) opened for write on the report.
  const reportFds = new Map();
  const fdOf = (value) => (typeof value === "number" ? value : typeof value?.fd === "number" ? value.fd : null);
  const probeHandle = await fs.promises.open(fileURLToPath(import.meta.url), "r");
  const FileHandle = Object.getPrototypeOf(probeHandle);
  await probeHandle.close();
  let count = 0;
  let depth = 0;
  const countDescriptorWrite = (value) => {
    const writes = reportFds.get(fdOf(value));
    if (writes === undefined) return;
    reportFds.set(fdOf(value), writes + 1);
    if (writes > 0) count += 1; // the open counted the first write
  };
  const trackOpen = (value) => {
    if (fdOf(value) !== null) reportFds.set(fdOf(value), 0);
  };
  const untrack = (value) => reportFds.delete(fdOf(value));
  const opensReport = (args) => hits(args[0]) && opensForWrite(typeof args[1] === "function" ? undefined : args[1]);
  // [object, method, kind, which argument]: "path" counts a write landing on
  // that argument's path, "fd" a write through a report descriptor, "this" a
  // write through this FileHandle; "open" counts and tracks a write-open of
  // the report; "close" stops tracking a descriptor.
  const sites = [];
  for (const [object, suffix] of [[fs, "Sync"], [fs, ""], [fs.promises, ""]]) {
    sites.push([object, `writeFile${suffix}`, "path", 0]);
    sites.push([object, `appendFile${suffix}`, "path", 0]);
    sites.push([object, `rename${suffix}`, "path", 1]);
    sites.push([object, `copyFile${suffix}`, "path", 1]);
    sites.push([object, `cp${suffix}`, "path", 1]);
    sites.push([object, `link${suffix}`, "path", 1]);
    sites.push([object, `symlink${suffix}`, "path", 1]);
    sites.push([object, `open${suffix}`, "open", 0]);
  }
  for (const method of ["writeSync", "write", "writevSync", "writev", "writeFileSync", "writeFile", "appendFileSync", "appendFile"]) sites.push([fs, method, "fd", 0]);
  for (const method of ["writeFile", "appendFile"]) sites.push([fs.promises, method, "fd", 0]);
  for (const method of ["write", "writev", "writeFile", "appendFile"]) sites.push([FileHandle, method, "this"]);
  for (const method of ["closeSync", "close"]) sites.push([fs, method, "close", 0]);
  sites.push([FileHandle, "close", "close"]);
  // One counting wrapper per method, applying every rule listed for it.
  const rulesBySite = new Map();
  for (const [object, method, kind, index] of sites) {
    if (typeof object[method] !== "function") continue;
    if (!rulesBySite.has(object)) rulesBySite.set(object, new Map());
    const methods = rulesBySite.get(object);
    methods.set(method, [...(methods.get(method) || []), [kind, index]]);
  }
  const originals = [];
  for (const [object, methods] of rulesBySite) {
    for (const [method, rules] of methods) {
      const original = object[method];
      originals.push([object, method, original]);
      object[method] = function countingWrite(...args) {
        const outer = depth === 0;
        let opening = false;
        for (const [kind, index] of rules) {
          if (outer && kind === "path" && hits(args[index])) count += 1;
          if (outer && kind === "fd" && !isPath(args[index])) countDescriptorWrite(args[index]);
          if (outer && kind === "this") countDescriptorWrite(this);
          if (kind === "close") untrack(index === undefined ? this : args[index]);
          if (outer && kind === "open" && opensReport(args)) opening = true;
        }
        if (opening) count += 1;
        if (opening && object === fs && method === "open") {
          const callbackAt = args.findIndex((value) => typeof value === "function");
          const callback = args[callbackAt];
          if (callback) args[callbackAt] = (error, fd) => {
            if (!error) trackOpen(fd);
            return callback(error, fd);
          };
        }
        depth += 1;
        try {
          const value = original.apply(this, args);
          if (opening && method === "openSync") trackOpen(value);
          if (opening && object === fs.promises) return value.then((handle) => (trackOpen(handle), handle));
          return value;
        } finally {
          depth -= 1;
        }
      };
    }
  }
  syncBuiltinESMExports();
  try {
    const value = await run();
    return { value, count };
  } finally {
    for (const [object, method, original] of originals) object[method] = original;
    syncBuiltinESMExports();
  }
}

export function sidecarRow(fixture, id) {
  const sidecar = readJson(fixture.sidecarPath);
  const rows = sidecar?.derived?.qc_results;
  assert.ok(Array.isArray(rows), "the persisted doctor sidecar carries derived.qc_results[]");
  const row = rows.find((candidate) => candidate.id === id);
  assert.ok(row, `the persisted doctor sidecar holds the ${id} row`);
  return row;
}

// Hand-written accept record (contract 1.0 accept record shape).
export function handAccept(row, { measuredSource = "doctor_sidecar", acceptedAt, acceptedBy = OPERATOR, reason = "known synthetic", patch = {}, drop = [] } = {}) {
  const record = {
    schema: "campaigns-os-qc-accept/v0",
    scope: "qc_accept",
    result_id: row.id,
    check: row.check,
    leg: row.leg,
    subject: row.subject,
    state_fingerprint: row.state_fingerprint,
    result_at_accept: "warning",
    measured_at: row.measured_at,
    measured_source: measuredSource,
    reason,
    accepted_by: acceptedBy,
    accepted_at: acceptedAt ?? new Date(Date.parse(row.measured_at) + 1000).toISOString(),
    recorded_by: "campaigns-os checkpoint accept",
    ...patch,
  };
  for (const key of drop) delete record[key];
  return record;
}

export function appendAccept(fixture, record) {
  mutateReport(fixture, (report) => {
    report.qc_accepts = [...(Array.isArray(report.qc_accepts) ? report.qc_accepts : []), record];
  });
}

export const resultsOf = (value) => (Array.isArray(value) ? value : value?.results);
