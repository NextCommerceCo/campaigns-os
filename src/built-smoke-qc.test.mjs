// Fixture rows for the built-output smoke checks (`built_output.smoke_qc`),
// through the real doctor entry points: `doctor --built` (doctorBuiltOutput)
// over a synthetic temp tree, and the packet registry (doctorPacket, `next`,
// `checkpoint accept`) over a synthetic packet whose _site/ pages are real
// built HTML and whose Assembly Report records the build environment.
//
// API assumption (every row): subject is exactly {check:"smoke_qc", page, key},
// subject.page is the built page path relative to the doctor target
// ("_site/example-campaign/index.html"), as in 1.5, so a result id is
// `smoke_qc:<page>:<key>`. Every row carries members[] ([] unless a cap adds
// the 1.0 capped-page member).
// API assumption (every row): keys are "<rule>:<target|host|tag>":
//   anchor:<decoded fragment>            one per distinct in-page target
//                                        ("#" is the empty target, "anchor:")
//   favicon:link                         one per page
//   og:title, og:description, og:image   one each per page (presence)
//   og:image_target                      one per page that has an og:image
//                                        (resolution; absent og:image has none)
//   tailwind_cdn:cdn.tailwindcss.com     one per page
//   asset_host:cdn.29next.store          one per page
//   loopback:loopback                    one per page
//   anchor                               the anchor rule's own row, only for a
//                                        page-level outcome (targets unknown)
// so the key of every rule but anchors is stable across its pass, warning and
// unexercised outcomes (an accept lapses rather than orphans). A page with no
// in-page anchor has no anchor row.
// API assumption (page-level outcomes): contract 1.6 applies a page-level
// non-pass "first to every rule", so page_unreadable, page_too_large and
// page_cap_reached give the page exactly one unexercised row per rule key (the
// bare "anchor" and the eight fixed keys, og:image_target included because
// whether the page has an og:image is unknown), each with that reason, and no
// other row.
// API assumption (capped pages): a page that reaches the candidate or finding
// cap reads unexercised/<cap code> on every rule key as above (for the finding
// cap, the "anchor" row is the extra cap row), keeps the warning and review
// results already found (for the finding cap, the first 50 distinct targets in
// document order) and no pass row; every result kept for the page, rule rows
// included, carries the capped-page member (contract 1.0 "Capped pages").
// API assumption (every row): coverage is
//   {observed:1, expected:1, limits:[]}           measured: pass, warning, review
//   {observed:0, expected:1, limits:[<reason>]}   unexercised for <reason>
// except that on a capped page expected is null (its truncated page leaves the
// count unknown) and limits is [<cap code>], as 1.5 records its capped results.
// API assumption (packet rows): the packet's build environment is read from
// stages.assembly.evidence.build_environment as recorded; the deploy base is
// the origin of packet.deploy.preview_url, and an absolute same-base og:image
// maps its URL path under _site/ (as resolveBuiltAssetPath maps "/x").
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, afterEach } from "node:test";

import {
  OPERATOR,
  ORIGIN,
  SLUG,
  assertNoNetworkAttempts,
  assertNothingWritten,
  assertRefused,
  campaignFixture,
  delay,
  doctorOf,
  mutateReport,
  readJson,
  refOf,
  runAccept,
  runNext,
  snapshot,
  withNoNetwork,
  writeJson,
} from "./qc-test-factories.mjs";

// No network: importing qc-test-factories.mjs (the only non-builtin static
// import) installs the guard before any module under test loads, so the
// modules below, imported dynamically after it, capture only the guarded fetch
// and http/https. Any attempt recorded during a test fails that test.
afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const { doctorBuiltOutput } = await import("./doctor/inspect.mjs");
const { computeBuildFingerprint } = await import("./built-site-scope.mjs");

const CHECK = "smoke_qc";
const GATE = "built_output.smoke_qc";
const CART_GATE = "built_output.cart_placeholders";
const CAMPAIGN = "example-campaign";
const PAGE = `_site/${CAMPAIGN}/index.html`;
const ANCHOR_RULE_KEY = "anchor";
const CAP_REASONS = new Set(["candidate_cap_reached", "finding_cap_reached"]);
const MiB = 1024 * 1024;

const KEY = Object.freeze({
  favicon: "favicon:link",
  ogTitle: "og:title",
  ogDescription: "og:description",
  ogImage: "og:image",
  ogImageTarget: "og:image_target",
  tailwind: "tailwind_cdn:cdn.tailwindcss.com",
  assetHost: "asset_host:cdn.29next.store",
  loopback: "loopback:loopback",
});
const anchorKey = (target) => `anchor:${target}`;
// Every rule key a page-level outcome applies to.
const RULE_KEYS = Object.freeze([ANCHOR_RULE_KEY, ...Object.values(KEY)]);

const TAILWIND_CDN = "<script src=\"https://cdn.tailwindcss.com\"></script>";
const BUILT_OG_IMAGE = `https://preview.example.invalid/${CAMPAIGN}/img/og.png`;

// A synthetic built page that meets every environment-independent rule:
// favicon link, og:title, og:description and an absolute og:image. It has no
// in-page anchor, CDN script, asset-host or loopback URL unless a test adds one.
function page({ favicon = true, ogTitle = true, ogDescription = true, ogImage = BUILT_OG_IMAGE, head = "", body = "<p>Synthetic smoke check page.</p>" } = {}) {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<title>Synthetic smoke check page</title>",
    favicon ? "<link rel=\"icon\" href=\"/favicon.ico\">" : null,
    ogTitle ? "<meta property=\"og:title\" content=\"Synthetic campaign\">" : null,
    ogDescription ? "<meta property=\"og:description\" content=\"Synthetic campaign description.\">" : null,
    ogImage == null ? null : `<meta property="og:image" content="${ogImage}">`,
    head || null,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].filter((line) => line !== null).join("\n");
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// A temp `doctor --built` target: _site/example-campaign/<file> per entry.
function tempTree(t, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "smoke-qc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) writeFile(join(dir, "_site", CAMPAIGN, file), content);
  return dir;
}
const setTreeFile = (dir, file, content) => writeFile(join(dir, "_site", CAMPAIGN, file), content);

const builtDoctor = (dir) => withNoNetwork(() => doctorBuiltOutput({ built: dir, slug: CAMPAIGN }));

const idOf = (pagePath, key) => `${CHECK}:${pagePath}:${key}`;
const rowsOf = (result) => (Array.isArray(result?.derived?.qc_results) ? result.derived.qc_results : []).filter((row) => row?.check === CHECK);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// The complete row shape the setup determines: id, check, subject, result,
// reason_code, the exact members[] and the exact coverage (a missing field
// stays undefined).
const summarize = (row) => ({ id: row.id, check: row.check, subject: row.subject, result: row.result, reason_code: row.reason_code, members: row.members, coverage: row.coverage });
const coverageOf = (result, reasonCode) => (result === "unexercised" ? { observed: 0, expected: 1, limits: [reasonCode] } : { observed: 1, expected: 1, limits: [] });
const expectRow = (pagePath, key, result, reasonCode = null, members = []) => ({ id: idOf(pagePath, key), check: CHECK, subject: { check: CHECK, page: pagePath, key }, result, reason_code: reasonCode, members, coverage: coverageOf(result, reasonCode) });
const capMember = (reasonCode) => ({ key: "page_coverage", result: "unexercised", reason_code: reasonCode });
// A result kept on a page that reached `cap`: the capped-page member, the cap
// as its coverage limit, the expected count unknown.
const capped = (row, cap) => ({ ...row, members: [...row.members, capMember(cap)], coverage: { observed: row.result === "unexercised" ? 0 : 1, expected: null, limits: [cap] } });

// A page-level outcome: one unexercised row per rule key with that reason. On
// a capped page the `kept` findings stay, and every row carries the cap.
function pageLevelRows(pagePath, reasonCode, { kept = [] } = {}) {
  const rows = [...kept, ...RULE_KEYS.map((key) => expectRow(pagePath, key, "unexercised", reasonCode))];
  return CAP_REASONS.has(reasonCode) ? rows.map((row) => capped(row, reasonCode)) : rows;
}

// The rows of one page. By default: a complete page with none of the rule
// conditions, so the environment-independent rules pass; Tailwind and
// loopback pass only under a recorded production environment and are
// unexercised otherwise; og:image resolution is unexercised while the deploy
// base is unknown (`doctor --built`) and passes for a same-base image present
// in _site/ (packet mode). `anchors` adds anchor rows by target, `set`
// replaces rows by key ([result, reason_code, members]) and `drop` removes them.
const ENV_REASON = Object.freeze({ development: "development_render", unknown: "build_environment_unknown" });
function pageRows(pagePath, { env = "unknown", anchors = {}, set = {}, drop = [] } = {}) {
  const envRow = env === "production" ? ["pass"] : ["unexercised", ENV_REASON[env]];
  const rows = {
    [KEY.favicon]: ["pass"],
    [KEY.ogTitle]: ["pass"],
    [KEY.ogDescription]: ["pass"],
    [KEY.ogImage]: ["pass"],
    [KEY.ogImageTarget]: env === "unknown" ? ["unexercised", "og_image_base_unknown"] : ["pass"],
    [KEY.tailwind]: envRow,
    [KEY.assetHost]: ["pass"],
    [KEY.loopback]: envRow,
    ...Object.fromEntries(Object.entries(anchors).map(([target, row]) => [anchorKey(target), row])),
    ...set,
  };
  for (const key of drop) delete rows[key];
  return Object.entries(rows).map(([key, [result, reasonCode = null, members = []]]) => expectRow(pagePath, key, result, reasonCode, members));
}

// The gate ran as its own doctor check, registered right after the 1.5 entry,
// and is not a checkpoint gate.
function assertWired(result) {
  const checks = result?.derived?.doctor_checks;
  assert.ok(Array.isArray(checks) && checks.includes(GATE), `derived.doctor_checks lists ${GATE}: ${JSON.stringify(checks)}`);
  assert.equal(checks.indexOf(GATE), checks.indexOf(CART_GATE) + 1, `${GATE} runs right after ${CART_GATE}: ${JSON.stringify(checks)}`);
  assert.equal((result.derived.checkpoint_gates || []).some((gate) => String(gate?.id).startsWith(GATE)), false, `${GATE} is not in derived.checkpoint_gates`);
}

// The exact set of smoke_qc results, complete rows, each a well-formed doctor
// row; only a warning with no unresolved member is accept-eligible.
function assertRows(result, expected) {
  const rows = rowsOf(result);
  assert.deepEqual(rows.map(summarize).sort(byId), [...expected].sort(byId), "the exact set of smoke_qc results, complete rows");
  for (const row of rows) {
    assert.equal(row.schema, "campaigns-os-qc-result/v0", `${row.id} schema`);
    assert.equal(row.leg, "doctor", `${row.id} leg`);
    assert.equal(row.producer, "campaigns-os doctor", `${row.id} producer`);
    assert.match(String(row.state_fingerprint), /^sha256:[a-f0-9]{64}$/, `${row.id} state_fingerprint`);
    const eligible = row.result === "warning" && !(row.members || []).some((member) => member.result === "review" || member.result === "unexercised");
    assert.equal(row.accept_eligible, eligible, `${row.id} accept_eligible`);
  }
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

// The exact doctor issues the gate raised: warnings[] holds one
// `built_output.smoke_qc.<reason_code>` issue per expected warning or review
// result, and errors[] holds none (never escalated).
function assertIssues(result, expected) {
  const issues = (result.warnings || []).filter((issue) => String(issue?.code).startsWith(`${GATE}.`));
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.detail?.qc_result?.id]).sort(),
    expected.filter((row) => row.result === "warning" || row.result === "review").map((row) => [`${GATE}.${row.reason_code}`, row.id]).sort(),
    "the exact smoke_qc issues in warnings[]",
  );
  assert.deepEqual((result.errors || []).filter((issue) => String(issue?.code).startsWith(GATE)), [], `${GATE} never raises an error`);
}

function assertSmoke(result, expected) {
  assertWired(result);
  const rows = assertRows(result, expected);
  assertIssues(result, expected);
  return rows;
}

// An accept as `checkpoint accept` writes it (createQcAccept), for a result
// measured before it.
function acceptOf({ createQcAccept, qcAcceptAttribution }, row) {
  assert.ok(Number.isFinite(Date.parse(row.measured_at)), `the ${row.id} result carries measured_at`);
  const now = new Date(Date.parse(row.measured_at) + 1000).toISOString();
  return createQcAccept(row, { measuredAt: row.measured_at, attribution: qcAcceptAttribution({ reason: "known synthetic", acceptedBy: OPERATOR, now }) });
}
const assessed = (qcAccept, record, rows) => qcAccept.assessQcAccepts([record], Object.values(rows)).map(({ status, why }) => [status, why]);

// ---------------------------------------------------------------------------
// Packet entry point: a synthetic packet with a real built page per
// CampaignSpec route, the build fingerprint and the build environment
// recorded, and a same-base og:image present in _site/.
const PACKET_ROUTES = ["landing", "checkout", "upsell", "receipt"];
const packetRel = (route) => `_site/${SLUG}/${route}/index.html`;
const PACKET_OG_IMAGE = `${ORIGIN}/${SLUG}/img/og.png`;
const LOADER = "<script src=\"https://cdn.example.invalid/campaign-cart@v0.4.40/dist/loader.js\"></script>";
const packetPage = (route, { head = "", body = `<p class="cart-line">Synthetic ${route} page.</p>`, ...rest } = {}) => page({
  ogImage: PACKET_OG_IMAGE,
  head: [`<meta name="next-page-type" content="${route}">`, LOADER, head].filter(Boolean).join("\n"),
  body,
  ...rest,
});

function recordBuild(f, env) {
  const fingerprint = computeBuildFingerprint(join(f.targetRepo, "_site", SLUG)).fingerprint;
  mutateReport(f, (report) => {
    report.stages.assembly.build_fingerprint = fingerprint;
    report.stages.assembly.evidence = { ...(report.stages.assembly.evidence || {}), build_environment: env };
  });
}

function builtPacket(t, { env = "production", landing = null } = {}) {
  const f = campaignFixture();
  t.after(f.cleanup);
  // The deploy base the og:image rule maps (set by campaignFixture).
  assert.equal(readJson(f.packetPath).deploy.preview_url, `${ORIGIN}/${SLUG}/`, "setup: the packet records the deploy URL");
  for (const route of PACKET_ROUTES) writeFile(join(f.targetRepo, packetRel(route)), route === "landing" && landing ? landing : packetPage(route));
  writeFile(join(f.targetRepo, "_site", SLUG, "img", "og.png"), "synthetic og image bytes\n");
  writeJson(join(f.targetRepo, ".campaign-runtime/page-kit-build-summary.json"), {
    pages: PACKET_ROUTES.map((route) => ({ campaignSlug: SLUG, status: "ok", inputFile: `src/${SLUG}/${route}.html`, url: `/${SLUG}/${route}/`, warnings: [] })),
  });
  recordBuild(f, env);
  return f;
}

// Every packet route page, the landing rows given by `landing`.
const packetRows = ({ env = "production", landing = {} } = {}) => PACKET_ROUTES.flatMap((route) => pageRows(packetRel(route), route === "landing" ? { env, ...landing } : { env }));

// ---------------------------------------------------------------------------
// Working rows

test("F1.6-W1 anchors resolve, favicon, og:title/og:description, absolute same-base og:image present in _site, no CDN script, no asset host, no loopback; packet env production: every rule pass", async (t) => {
  const landing = packetPage("landing", { body: "<nav><a href=\"#benefits\">Benefits</a></nav>\n<section id=\"benefits\"><p>Synthetic benefits.</p></section>" });
  const f = builtPacket(t, { env: "production", landing });
  const result = doctorOf(f.packetPath, {});
  const expected = packetRows({ landing: { anchors: { benefits: ["pass"] } } });
  assert.deepEqual(expected.filter((row) => row.result !== "pass"), [], "test bug: W1 expects pass only");
  assertSmoke(result, expected);
});

test("F1.6-W2 #, #top, <a name=\"x\">, #caf%C3%A9 to id=\"café\", <use href=\"#icon\">: anchors pass", async (t) => {
  const body = [
    "<a href=\"#\">Back to top</a>",
    "<a href=\"#top\">Top</a>",
    "<a href=\"#x\">Named target</a>",
    "<p><a name=\"x\"></a>Synthetic named section.</p>",
    "<a href=\"#caf%C3%A9\">Café</a>",
    "<h2 id=\"café\">Café</h2>",
    "<svg width=\"1\" height=\"1\"><use href=\"#icon\"></use></svg>",
  ].join("\n");
  const dir = tempTree(t, { "index.html": page({ body }) });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { anchors: { "": ["pass"], top: ["pass"], x: ["pass"], "café": ["pass"] } }));
});

// ---------------------------------------------------------------------------
// Broken rows

test("F1.6-B1 href=\"#features\" with no id: warning (anchor_target_missing)", async (t) => {
  const dir = tempTree(t, { "index.html": page({ body: "<a href=\"#features\">Features</a>\n<p>Synthetic page.</p>" }) });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { anchors: { features: ["warning", "anchor_target_missing"] } }));
});

test("F1.6-B2 no favicon link: warning (favicon_missing)", async (t) => {
  const dir = tempTree(t, { "index.html": page({ favicon: false }) });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { set: { [KEY.favicon]: ["warning", "favicon_missing"] } }));
});

test("F1.6-B3 no og:title: warning (og_title_missing)", async (t) => {
  const dir = tempTree(t, { "index.html": page({ ogTitle: false }) });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { set: { [KEY.ogTitle]: ["warning", "og_title_missing"] } }));
});

test("F1.6-B4 og:image=\"/img/missing.png\": warning (og_image_missing_file)", async (t) => {
  const dir = tempTree(t, { "index.html": page({ ogImage: "/img/missing.png" }) });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { set: { [KEY.ogImageTarget]: ["warning", "og_image_missing_file"] } }));
});

test("F1.6-B5 Tailwind CDN script, packet env production: warning (tailwind_cdn_in_production)", async (t) => {
  const f = builtPacket(t, { env: "production", landing: packetPage("landing", { head: TAILWIND_CDN }) });
  assertSmoke(doctorOf(f.packetPath, {}), packetRows({ landing: { set: { [KEY.tailwind]: ["warning", "tailwind_cdn_in_production"] } } }));
});

test("F1.6-B6 <img src=\"https://cdn.29next.store/x.png\">: warning (primary_asset_host)", async (t) => {
  const dir = tempTree(t, { "index.html": page({ body: "<img src=\"https://cdn.29next.store/x.png\" alt=\"Synthetic product\">" }) });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { set: { [KEY.assetHost]: ["warning", "primary_asset_host"] } }));
});

test("F1.6-B7 <img src=\"http://localhost:8080/x.png\">, env production: warning (loopback_url)", async (t) => {
  const f = builtPacket(t, { env: "production", landing: packetPage("landing", { body: "<img src=\"http://localhost:8080/x.png\" alt=\"Synthetic product\">" }) });
  assertSmoke(doctorOf(f.packetPath, {}), packetRows({ landing: { set: { [KEY.loopback]: ["warning", "loopback_url"] } } }));
});

test("F1.6-B8 og:image absent: warning (og_image_missing)", async (t) => {
  const dir = tempTree(t, { "index.html": page({ ogImage: null }) });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { set: { [KEY.ogImage]: ["warning", "og_image_missing"] }, drop: [KEY.ogImageTarget] }));
});

test("F1.6-B9 relative og:image whose file exists: warning (og_image_not_absolute)", async (t) => {
  const dir = tempTree(t, { "index.html": page({ ogImage: "img/og.png" }), "img/og.png": "synthetic og image bytes\n" });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { set: { [KEY.ogImageTarget]: ["warning", "og_image_not_absolute"] } }));
});

test("F1.6-B10 accepted F1.6-B4; og:image changed to /img/other-missing.png: accept lapsed (state_changed)", async (t) => {
  const qcAccept = await import("./qc-accept.mjs");
  const expected = pageRows(PAGE, { set: { [KEY.ogImageTarget]: ["warning", "og_image_missing_file"] } });
  const id = idOf(PAGE, KEY.ogImageTarget);
  const dir = tempTree(t, { "index.html": page({ ogImage: "/img/missing.png" }) });
  const before = assertSmoke(await builtDoctor(dir), expected);
  const record = acceptOf(qcAccept, before[id]);
  assert.deepEqual(assessed(qcAccept, record, before), [["active", null]], "precondition: the accept is active on the measured state");

  setTreeFile(dir, "index.html", page({ ogImage: "/img/other-missing.png" }));
  const afterRows = assertSmoke(await builtDoctor(dir), expected);
  assert.notEqual(afterRows[id].state_fingerprint, before[id].state_fingerprint, "the image destination is bound in the state");
  assert.deepEqual(assessed(qcAccept, record, afterRows), [["lapsed", "state_changed"]]);
});

test("F1.6-B11 no og:description: warning (og_description_missing)", async (t) => {
  const dir = tempTree(t, { "index.html": page({ ogDescription: false }) });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { set: { [KEY.ogDescription]: ["warning", "og_description_missing"] } }));
});

test("F1.6-B12 accepted F1.6-B6; the asset-host reference moves to a different <img>: accept lapsed (state_changed)", async (t) => {
  const qcAccept = await import("./qc-accept.mjs");
  const expected = pageRows(PAGE, { set: { [KEY.assetHost]: ["warning", "primary_asset_host"] } });
  const id = idOf(PAGE, KEY.assetHost);
  const dir = tempTree(t, { "index.html": page({ body: "<img src=\"https://cdn.29next.store/x.png\" alt=\"Synthetic one\">\n<img src=\"/img/local.png\" alt=\"Synthetic two\">" }) });
  const before = assertSmoke(await builtDoctor(dir), expected);
  const record = acceptOf(qcAccept, before[id]);
  assert.deepEqual(assessed(qcAccept, record, before), [["active", null]], "precondition: the accept is active on the measured state");

  setTreeFile(dir, "index.html", page({ body: "<img src=\"/img/local.png\" alt=\"Synthetic one\">\n<img src=\"https://cdn.29next.store/x.png\" alt=\"Synthetic two\">" }));
  const afterRows = assertSmoke(await builtDoctor(dir), expected);
  assert.notEqual(afterRows[id].state_fingerprint, before[id].state_fingerprint, "the offending element is bound in the state");
  assert.deepEqual(assessed(qcAccept, record, afterRows), [["lapsed", "state_changed"]]);
});

test("F1.6-B13 accepted asset-host warning on a <video src>; the reference moves to the same element's poster: accept lapsed (state_changed)", async (t) => {
  const qcAccept = await import("./qc-accept.mjs");
  const expected = pageRows(PAGE, { set: { [KEY.assetHost]: ["warning", "primary_asset_host"] } });
  const id = idOf(PAGE, KEY.assetHost);
  const dir = tempTree(t, { "index.html": page({ body: "<video src=\"https://cdn.29next.store/v.mp4\" poster=\"/img/poster.png\"></video>" }) });
  const before = assertSmoke(await builtDoctor(dir), expected);
  const record = acceptOf(qcAccept, before[id]);
  assert.deepEqual(assessed(qcAccept, record, before), [["active", null]], "precondition: the accept is active on the measured state");

  setTreeFile(dir, "index.html", page({ body: "<video src=\"/video/v.mp4\" poster=\"https://cdn.29next.store/poster.png\"></video>" }));
  const afterRows = assertSmoke(await builtDoctor(dir), expected);
  assert.notEqual(afterRows[id].state_fingerprint, before[id].state_fingerprint, "the offending attribute is bound in the state");
  assert.deepEqual(assessed(qcAccept, record, afterRows), [["lapsed", "state_changed"]]);
});

test("F1.6-B14 accepted F1.6-B5; packet env re-recorded as development: accept lapsed (state_changed)", async (t) => {
  const qcAccept = await import("./qc-accept.mjs");
  const f = builtPacket(t, { env: "production", landing: packetPage("landing", { head: TAILWIND_CDN }) });
  const id = idOf(packetRel("landing"), KEY.tailwind);
  const before = assertSmoke(doctorOf(f.packetPath, {}), packetRows({ landing: { set: { [KEY.tailwind]: ["warning", "tailwind_cdn_in_production"] } } }));
  const record = acceptOf(qcAccept, before[id]);
  assert.deepEqual(assessed(qcAccept, record, before), [["active", null]], "precondition: the accept is active on the measured state");

  recordBuild(f, "development");
  assert.equal(readJson(f.reportPath).stages.assembly.evidence.build_environment, "development", "setup: the environment is re-recorded");
  const afterRows = assertSmoke(doctorOf(f.packetPath, {}), packetRows({ env: "development" }));
  assert.deepEqual(assessed(qcAccept, record, afterRows), [["lapsed", "state_changed"]]);
});

test("F1.6-B15 <style> block with url(https://cdn.29next.store/bg.png): warning (primary_asset_host)", async (t) => {
  const dir = tempTree(t, { "index.html": page({ head: "<style>.hero { background: url(https://cdn.29next.store/bg.png); }</style>" }) });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { set: { [KEY.assetHost]: ["warning", "primary_asset_host"] } }));
});

test("F1.6-B16 <div data-src=\"https://cdn.29next.store/x.png\">: warning (primary_asset_host)", async (t) => {
  const dir = tempTree(t, { "index.html": page({ body: "<div class=\"hero\" data-src=\"https://cdn.29next.store/x.png\"></div>" }) });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { set: { [KEY.assetHost]: ["warning", "primary_asset_host"] } }));
});

test("F1.6-B17 accepted F1.6-B1; the page gains 2,001 in-page anchors, so the kept anchor_target_missing result acquires the capped-page member: accept lapsed (state_changed)", async (t) => {
  const qcAccept = await import("./qc-accept.mjs");
  const body = "<a href=\"#features\">Features</a>\n<p>Synthetic page.</p>";
  const id = idOf(PAGE, anchorKey("features"));
  const dir = tempTree(t, { "index.html": page({ body }) });
  const before = assertSmoke(await builtDoctor(dir), pageRows(PAGE, { anchors: { features: ["warning", "anchor_target_missing"] } }));
  const record = acceptOf(qcAccept, before[id]);
  assert.deepEqual(assessed(qcAccept, record, before), [["active", null]], "precondition: the accept is active on the measured state");

  const more = Array.from({ length: 2001 }, (_, index) => `<a href="#benefits">Benefits ${index + 1}</a>`).join("\n");
  setTreeFile(dir, "index.html", page({ body: `${body}\n${more}\n<section id="benefits"><p>Synthetic benefits.</p></section>` }));
  const afterRows = assertSmoke(await builtDoctor(dir), pageLevelRows(PAGE, "candidate_cap_reached", {
    kept: [expectRow(PAGE, anchorKey("features"), "warning", "anchor_target_missing")],
  }));
  assert.deepEqual(afterRows[id].members, [capMember("candidate_cap_reached")], "the kept result acquired the capped-page member");
  assert.equal(afterRows[id].accept_eligible, false, "a result kept on a capped page is not accept-eligible");
  assert.deepEqual(assessed(qcAccept, record, afterRows), [["lapsed", "state_changed"]]);
});

// ---------------------------------------------------------------------------
// Incomplete rows

test("F1.6-I1 anchor target id appears only in a loaded local script: review (anchor_target_possibly_script_created)", async (t) => {
  const dir = tempTree(t, {
    "index.html": page({ head: "<script src=\"js/tabs.js\"></script>", body: "<a href=\"#features\">Features</a>\n<main><p>Synthetic page.</p></main>" }),
    "js/tabs.js": "document.querySelector(\"main\").insertAdjacentHTML(\"beforeend\", '<section id=\"features\"><p>Synthetic features.</p></section>');\n",
  });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { anchors: { features: ["review", "anchor_target_possibly_script_created"] } }));
});

test("F1.6-I2 og:image absolute on another host: unexercised (og_image_remote_not_fetched)", async (t) => {
  const f = builtPacket(t, { env: "production", landing: packetPage("landing", { ogImage: "https://images.example.invalid/og.png" }) });
  assertSmoke(doctorOf(f.packetPath, {}), packetRows({ landing: { set: { [KEY.ogImageTarget]: ["unexercised", "og_image_remote_not_fetched"] } } }));
});

test("F1.6-I3 Tailwind CDN script under doctor --built: unexercised (build_environment_unknown)", async (t) => {
  const dir = tempTree(t, { "index.html": page({ head: TAILWIND_CDN }) });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { env: "unknown", set: { [KEY.tailwind]: ["unexercised", "build_environment_unknown"] } }));
});

test("F1.6-I4 anchor target only inside <template>: review (anchor_target_in_template)", async (t) => {
  const dir = tempTree(t, { "index.html": page({ body: "<a href=\"#features\">Features</a>\n<template><section id=\"features\"><p>Synthetic features.</p></section></template>" }) });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { anchors: { features: ["review", "anchor_target_in_template"] } }));
});

test("F1.6-I5 loopback URL under doctor --built: unexercised (build_environment_unknown)", async (t) => {
  const dir = tempTree(t, { "index.html": page({ body: "<img src=\"http://localhost:8080/x.png\" alt=\"Synthetic product\">" }) });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { env: "unknown", set: { [KEY.loopback]: ["unexercised", "build_environment_unknown"] } }));
});

test("F1.6-I6 Tailwind CDN script, packet env development: unexercised (development_render)", async (t) => {
  const f = builtPacket(t, { env: "development", landing: packetPage("landing", { head: TAILWIND_CDN }) });
  assertSmoke(doctorOf(f.packetPath, {}), packetRows({ env: "development", landing: { set: { [KEY.tailwind]: ["unexercised", "development_render"] } } }));
});

test("F1.6-I7 loopback URL, packet env development: unexercised (development_render)", async (t) => {
  const f = builtPacket(t, { env: "development", landing: packetPage("landing", { body: "<img src=\"http://localhost:8080/x.png\" alt=\"Synthetic product\">" }) });
  assertSmoke(doctorOf(f.packetPath, {}), packetRows({ env: "development", landing: { set: { [KEY.loopback]: ["unexercised", "development_render"] } } }));
});

test("F1.6-I8 absolute same-base og:image under doctor --built (base unknown): unexercised (og_image_base_unknown)", async (t) => {
  const dir = tempTree(t, { "index.html": page({ ogImage: BUILT_OG_IMAGE }), "img/og.png": "synthetic og image bytes\n" });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { set: { [KEY.ogImageTarget]: ["unexercised", "og_image_base_unknown"] } }));
});

test("F1.6-I9 dangling-looking anchor whose candidate script is 2 MiB: unexercised (script_unreadable)", async (t) => {
  const line = "// Synthetic filler line for the script size cap.\n";
  const big = `${line.repeat(Math.ceil((2 * MiB) / line.length))}document.body.insertAdjacentHTML("beforeend", '<section id="features"></section>');\n`;
  const dir = tempTree(t, {
    "index.html": page({ head: "<script src=\"js/big.js\"></script>", body: "<a href=\"#features\">Features</a>\n<p>Synthetic page.</p>" }),
    "js/big.js": big,
  });
  const size = statSync(join(dir, "_site", CAMPAIGN, "js", "big.js")).size;
  assert.ok(size >= 2 * MiB && size < 2 * MiB + 4096, `setup: the script is 2 MiB (${size} bytes)`);
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { anchors: { features: ["unexercised", "script_unreadable"] } }));
});

test("F1.6-I10 2,001 in-page anchors on one page: unexercised (candidate_cap_reached)", async (t) => {
  const anchors = Array.from({ length: 2001 }, (_, index) => `<a href="#benefits">Benefits ${index + 1}</a>`).join("\n");
  const dir = tempTree(t, { "index.html": page({ body: `${anchors}\n<section id="benefits"><p>Synthetic benefits.</p></section>` }) });
  assertSmoke(await builtDoctor(dir), pageLevelRows(PAGE, "candidate_cap_reached"));
});

test("F1.6-I11 501 built pages: the 501st page unexercised (page_cap_reached)", async (t) => {
  const names = Array.from({ length: 501 }, (_, index) => `p${String(index).padStart(3, "0")}.html`);
  const dir = tempTree(t, Object.fromEntries(names.map((name) => [name, page({ body: `<p>Synthetic page ${name}.</p>` })])));
  assertSmoke(await builtDoctor(dir), [
    ...names.slice(0, 500).flatMap((name) => pageRows(`_site/${CAMPAIGN}/${name}`)),
    ...pageLevelRows(`_site/${CAMPAIGN}/${names[500]}`, "page_cap_reached"),
  ]);
});

test("F1.6-I12 dangling anchor; page loads 17 local scripts, none of the first 16 contains the id: unexercised (script_unreadable)", async (t) => {
  const scripts = Array.from({ length: 17 }, (_, index) => `js/s${String(index + 1).padStart(2, "0")}.js`);
  const files = { "index.html": page({ head: scripts.map((src) => `<script src="${src}"></script>`).join("\n"), body: "<a href=\"#features\">Features</a>\n<p>Synthetic page.</p>" }) };
  for (const [index, src] of scripts.entries()) {
    files[src] = index < 16
      ? `window.syntheticScript${index + 1} = true;\n`
      : "document.body.insertAdjacentHTML(\"beforeend\", '<section id=\"features\"></section>');\n";
  }
  const dir = tempTree(t, files);
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { anchors: { features: ["unexercised", "script_unreadable"] } }));
});

test("F1.6-I13 dangling anchor; page loads a local script whose file is missing: unexercised (script_unreadable)", async (t) => {
  const dir = tempTree(t, { "index.html": page({ head: "<script src=\"js/missing.js\"></script>", body: "<a href=\"#features\">Features</a>\n<p>Synthetic page.</p>" }) });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { anchors: { features: ["unexercised", "script_unreadable"] } }));
});

test("F1.6-I14 a 6 MiB built page: unexercised (page_too_large)", async (t) => {
  const filler = "<p>Synthetic filler line for the page size cap.</p>\n";
  const dir = tempTree(t, { "index.html": page({ body: filler.repeat(Math.ceil((6 * MiB) / filler.length)) }) });
  const size = statSync(join(dir, "_site", CAMPAIGN, "index.html")).size;
  assert.ok(size >= 6 * MiB && size < 6 * MiB + 4096, `setup: the page is 6 MiB (${size} bytes)`);
  assertSmoke(await builtDoctor(dir), pageLevelRows(PAGE, "page_too_large"));
});

test("F1.6-I15 a built page is a dangling symlink: unexercised (page_unreadable)", async (t) => {
  const dir = tempTree(t, { "index.html": page() });
  symlinkSync("missing-synthetic-page.html", join(dir, "_site", CAMPAIGN, "broken.html"));
  assertSmoke(await builtDoctor(dir), [
    ...pageRows(PAGE),
    ...pageLevelRows(`_site/${CAMPAIGN}/broken.html`, "page_unreadable"),
  ]);
});

const DANGLING = Array.from({ length: 51 }, (_, index) => `d${index + 1}`);
const danglingBody = DANGLING.map((target) => `<a href="#${target}">Synthetic ${target}</a>`).join("\n");
// The F1.6-I16 rows of one page: the first 50 targets kept, the "anchor" cap
// row, every other rule unexercised for the cap, all with the capped-page
// member. The environment does not enter: the cap applies first.
const danglingRows = (pagePath) => pageLevelRows(pagePath, "finding_cap_reached", {
  kept: DANGLING.slice(0, 50).map((target) => expectRow(pagePath, anchorKey(target), "warning", "anchor_target_missing")),
});

test("F1.6-I16 51 distinct dangling anchors on one page: cap row unexercised (finding_cap_reached)", async (t) => {
  const dir = tempTree(t, { "index.html": page({ body: danglingBody }) });
  assertSmoke(await builtDoctor(dir), danglingRows(PAGE));
});

test("F1.6-I17 the F1.6-I16 page; checkpoint accept on one kept anchor_target_missing warning: refused; nothing written (members_unresolved)", async (t) => {
  const f = builtPacket(t, { env: "production", landing: packetPage("landing", { body: danglingBody }) });
  await runNext(f);
  // The persisted doctor sidecar holds exactly the F1.6-I16 set on the landing
  // page and the complete-page rows on each other route.
  const landing = packetRel("landing");
  const persisted = assertRows(readJson(f.sidecarPath), [
    ...danglingRows(landing),
    ...PACKET_ROUTES.filter((route) => route !== "landing").flatMap((route) => pageRows(packetRel(route), { env: "production" })),
  ]);
  const row = persisted[idOf(landing, anchorKey("d1"))];
  assert.equal(row.accept_eligible, false);
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [refOf(row)]), "members_unresolved", { names: [row.id] });
  assertNothingWritten(f, before);
  assert.equal(readJson(f.reportPath).qc_accepts, undefined, "no qc_accepts[] was written");
});
