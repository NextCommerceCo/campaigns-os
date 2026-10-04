// Hardening rows for the built-output smoke checks (`built_output.smoke_qc`),
// one per review round 1 finding class:
//   C1 incomplete observation never yields pass or an absence finding: the
//      result cap counts pass results, a capped page keeps no absence warning,
//      any unread local script makes a missing target unexercised, and ready[]
//      gets a smoke line only when no smoke result is unexercised;
//   C2 URL and fragment readings: only the decoded fragment is matched, a
//      scheme-relative og:image is not absolute, and a local asset whose real
//      path lies outside _site/ is never read or counted;
//   C3 the anchor script hint reads scripts through
//      collectBuiltPageIdentityInputs (its bounded form), listed from the
//      page's parse5 tree;
//   C4 the certified reachability harness accepts only pass rows and, per
//      rule key, the unexercised reasons canonical output reads under
//      `doctor --built` (no deploy base, no recorded environment);
//   C5 the candidate cap counts every URL-bearing attribute value, relative
//      or absolute;
//   C6 the URL-bearing attributes are a closed list, each one counted with a
//      relative value;
//   C7 a URL names a file under _site/ only through its decoded path: a file
//      literally named with the escape (`a%23b.png`) never satisfies
//      `a%23b.png`, and a path that names no file (`%ZZ`) never passes;
//   C8 rule edges: the asset host matched whatever its case, the IPv6
//      loopback, and <meta>/<link> in <template> counted toward the cap.
// Row shapes follow src/built-smoke-qc.test.mjs (its API assumptions).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, afterEach } from "node:test";

import {
  ORIGIN,
  SLUG,
  assertNoNetworkAttempts,
  campaignFixture,
  doctorOf,
  mutateReport,
  readJson,
  withNoNetwork,
  writeJson,
} from "./qc-test-factories.mjs";

// No network: qc-test-factories.mjs installs the guard before the modules
// under test load (imported dynamically below).
afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const { doctorBuiltOutput } = await import("./doctor/inspect.mjs");
const { collectBuiltPageIdentityInputs, collectCartPlaceholderPages, resolveBuiltAssetPath } = await import("./doctor/checks.mjs");
const { computeBuildFingerprint, resolveBuiltSiteScope } = await import("./built-site-scope.mjs");
const { SMOKE_QC, SMOKE_QC_CHECK, SMOKE_QC_LIMITS, URL_ATTRIBUTES, evaluateSmokeQc } = await import("./built-smoke-qc.mjs");

const CHECK = "smoke_qc";
const GATE = "built_output.smoke_qc";
const CAMPAIGN = "example-campaign";
const PAGE = `_site/${CAMPAIGN}/index.html`;
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
const RULE_KEYS = Object.freeze(["anchor", ...Object.values(KEY)]);
const CAP_REASONS = new Set(["candidate_cap_reached", "finding_cap_reached"]);
const BUILT_OG_IMAGE = `https://preview.example.invalid/${CAMPAIGN}/img/og.png`;

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

function tempTree(t, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "smoke-qc-hardening-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) writeFile(join(dir, "_site", CAMPAIGN, file), content);
  return dir;
}

const builtDoctor = (dir) => withNoNetwork(() => doctorBuiltOutput({ built: dir, slug: CAMPAIGN }));

const idOf = (pagePath, key) => `${CHECK}:${pagePath}:${key}`;
const rowsOf = (result) => (Array.isArray(result?.derived?.qc_results) ? result.derived.qc_results : []).filter((row) => row?.check === CHECK);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const summarize = (row) => ({ id: row.id, check: row.check, subject: row.subject, result: row.result, reason_code: row.reason_code, members: row.members, coverage: row.coverage });
const coverageOf = (result, reasonCode) => (result === "unexercised" ? { observed: 0, expected: 1, limits: [reasonCode] } : { observed: 1, expected: 1, limits: [] });
const expectRow = (pagePath, key, result, reasonCode = null, members = []) => ({ id: idOf(pagePath, key), check: CHECK, subject: { check: CHECK, page: pagePath, key }, result, reason_code: reasonCode, members, coverage: coverageOf(result, reasonCode) });
const capMember = (reasonCode) => ({ key: "page_coverage", result: "unexercised", reason_code: reasonCode });
const capped = (row, cap) => ({ ...row, members: [...row.members, capMember(cap)], coverage: { observed: row.result === "unexercised" ? 0 : 1, expected: null, limits: [cap] } });

function pageLevelRows(pagePath, reasonCode, { kept = [] } = {}) {
  const rows = [...kept, ...RULE_KEYS.map((key) => expectRow(pagePath, key, "unexercised", reasonCode))];
  return CAP_REASONS.has(reasonCode) ? rows.map((row) => capped(row, reasonCode)) : rows;
}

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

// The exact set of smoke_qc results, and the exact warnings[] issues they raise.
function assertSmoke(result, expected) {
  const rows = rowsOf(result);
  assert.deepEqual(rows.map(summarize).sort(byId), [...expected].sort(byId), "the exact set of smoke_qc results, complete rows");
  const issues = (result.warnings || []).filter((issue) => String(issue?.code).startsWith(`${GATE}.`));
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.detail?.qc_result?.id]).sort(),
    expected.filter((row) => row.result === "warning" || row.result === "review").map((row) => [`${GATE}.${row.reason_code}`, row.id]).sort(),
    "the exact smoke_qc issues in warnings[]",
  );
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

// Packet entry point, as src/built-smoke-qc.test.mjs builds it.
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

function builtPacket(t, { env = "production", landing = null, files = {}, links = {} } = {}) {
  const f = campaignFixture();
  t.after(f.cleanup);
  assert.equal(readJson(f.packetPath).deploy.preview_url, `${ORIGIN}/${SLUG}/`, "setup: the packet records the deploy URL");
  for (const route of PACKET_ROUTES) writeFile(join(f.targetRepo, packetRel(route)), route === "landing" && landing ? landing : packetPage(route));
  writeFile(join(f.targetRepo, "_site", SLUG, "img", "og.png"), "synthetic og image bytes\n");
  for (const [file, content] of Object.entries(files)) writeFile(join(f.targetRepo, file), content);
  for (const [link, target] of Object.entries(links)) {
    mkdirSync(dirname(join(f.targetRepo, link)), { recursive: true });
    symlinkSync(join(f.targetRepo, target), join(f.targetRepo, link));
  }
  writeJson(join(f.targetRepo, ".campaign-runtime/page-kit-build-summary.json"), {
    pages: PACKET_ROUTES.map((route) => ({ campaignSlug: SLUG, status: "ok", inputFile: `src/${SLUG}/${route}.html`, url: `/${SLUG}/${route}/`, warnings: [] })),
  });
  const fingerprint = computeBuildFingerprint(join(f.targetRepo, "_site", SLUG)).fingerprint;
  mutateReport(f, (report) => {
    report.stages.assembly.build_fingerprint = fingerprint;
    report.stages.assembly.evidence = { ...(report.stages.assembly.evidence || {}), build_environment: env };
  });
  return f;
}

const packetRows = ({ env = "production", landing = {} } = {}) => PACKET_ROUTES.flatMap((route) => pageRows(packetRel(route), route === "landing" ? { env, ...landing } : { env }));
const smokeReadyLines = (result) => (result.ready || []).filter((line) => /^Smoke checks on /.test(String(line)));

// ---------------------------------------------------------------------------
// C1: incomplete observation

const RESOLVED = Array.from({ length: 51 }, (_, index) => `r${index + 1}`);
const resolvedBody = RESOLVED.map((target) => `<a href="#${target}">Synthetic ${target}</a>\n<section id="${target}"><p>Synthetic ${target}.</p></section>`).join("\n");

test("C1 reviewer probe: 51 resolved in-page targets under doctor --built: the result cap counts pass results, so finding_cap_reached on every rule key and no pass row", async (t) => {
  const dir = tempTree(t, { "index.html": page({ body: resolvedBody }) });
  const rows = assertSmoke(await builtDoctor(dir), pageLevelRows(PAGE, "finding_cap_reached"));
  assert.deepEqual(Object.values(rows).filter((row) => row.result === "pass"), [], "no pass once the cap is hit");
});

test("C1 reviewer probe: 51 resolved in-page targets through evaluateSmokeQc, production environment: finding_cap_reached, no pass row", () => {
  const results = evaluateSmokeQc({ pages: [{ file: PAGE, content: page({ body: resolvedBody }) }], environment: "production", siteRoot: null, resolveAsset: () => null });
  assert.deepEqual(results.map(summarize).sort(byId), pageLevelRows(PAGE, "finding_cap_reached").sort(byId));
});

test("C1 the result cap keeps only the first 50 results' findings: 30 resolved then 21 dangling targets keep 20 warnings", async (t) => {
  const resolved = Array.from({ length: 30 }, (_, index) => `ok${index + 1}`);
  const dangling = Array.from({ length: 21 }, (_, index) => `gone${index + 1}`);
  const body = [
    ...resolved.map((target) => `<a href="#${target}">Synthetic ${target}</a><span id="${target}"></span>`),
    ...dangling.map((target) => `<a href="#${target}">Synthetic ${target}</a>`),
  ].join("\n");
  const dir = tempTree(t, { "index.html": page({ body }) });
  assertSmoke(await builtDoctor(dir), pageLevelRows(PAGE, "finding_cap_reached", {
    kept: dangling.slice(0, 20).map((target) => expectRow(PAGE, anchorKey(target), "warning", "anchor_target_missing")),
  }));
});

test("C1 reviewer probe: favicon and og tags after the candidate cap: no favicon_missing or og_*_missing, those keys unexercised (candidate_cap_reached)", async (t) => {
  const anchors = Array.from({ length: 2001 }, (_, index) => `<a href="#benefits">Benefits ${index + 1}</a>`).join("\n");
  const late = [
    "<link rel=\"icon\" href=\"/favicon.ico\">",
    "<meta property=\"og:title\" content=\"Synthetic campaign\">",
    "<meta property=\"og:description\" content=\"Synthetic campaign description.\">",
    `<meta property="og:image" content="${BUILT_OG_IMAGE}">`,
  ].join("\n");
  const content = page({ favicon: false, ogTitle: false, ogDescription: false, ogImage: null, body: `${anchors}\n<section id="benefits"><p>Synthetic benefits.</p></section>\n${late}` });
  const dir = tempTree(t, { "index.html": content });
  assertSmoke(await builtDoctor(dir), pageLevelRows(PAGE, "candidate_cap_reached"));
});

test("C1 a page with no favicon and no og:title at all over the finding cap: absence keys unexercised (finding_cap_reached), the dangling targets kept", async (t) => {
  const dangling = Array.from({ length: 51 }, (_, index) => `d${index + 1}`);
  const dir = tempTree(t, { "index.html": page({ favicon: false, ogTitle: false, body: dangling.map((target) => `<a href="#${target}">Synthetic ${target}</a>`).join("\n") }) });
  assertSmoke(await builtDoctor(dir), pageLevelRows(PAGE, "finding_cap_reached", {
    kept: dangling.slice(0, 50).map((target) => expectRow(PAGE, anchorKey(target), "warning", "anchor_target_missing")),
  }));
});

test("C1 reviewer probe: the target is named in one readable local script and another local script is missing: unexercised (script_unreadable), not review", async (t) => {
  const dir = tempTree(t, {
    "index.html": page({ head: "<script src=\"js/tabs.js\"></script>\n<script src=\"js/missing.js\"></script>", body: "<a href=\"#features\">Features</a>\n<main><p>Synthetic page.</p></main>" }),
    "js/tabs.js": "document.querySelector(\"main\").insertAdjacentHTML(\"beforeend\", '<section id=\"features\"></section>');\n",
  });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { anchors: { features: ["unexercised", "script_unreadable"] } }));
});

test("C1 the target is named in the first of 17 local scripts: the 17th is past the script cap, so unexercised (script_unreadable), not review", async (t) => {
  const scripts = Array.from({ length: 17 }, (_, index) => `js/s${String(index + 1).padStart(2, "0")}.js`);
  const files = { "index.html": page({ head: scripts.map((src) => `<script src="${src}"></script>`).join("\n"), body: "<a href=\"#features\">Features</a>\n<p>Synthetic page.</p>" }) };
  for (const [index, src] of scripts.entries()) {
    files[src] = index === 0 ? "document.body.insertAdjacentHTML(\"beforeend\", '<section id=\"features\"></section>');\n" : `window.syntheticScript${index + 1} = true;\n`;
  }
  const dir = tempTree(t, files);
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { anchors: { features: ["unexercised", "script_unreadable"] } }));
});

test("C1 ready[]: doctor --built (Tailwind and loopback always unexercised) adds no smoke ready line", async (t) => {
  const dir = tempTree(t, { "index.html": page() });
  const result = await builtDoctor(dir);
  assertSmoke(result, pageRows(PAGE));
  assert.deepEqual(smokeReadyLines(result), [], "no smoke ready line while a smoke result is unexercised");
});

test("C1 ready[]: a packet recorded development (unexercised rows) adds no smoke ready line; recorded production with every rule pass adds one", async (t) => {
  const development = doctorOf(builtPacket(t, { env: "development" }).packetPath, {});
  assertSmoke(development, packetRows({ env: "development" }));
  assert.deepEqual(smokeReadyLines(development), [], "no smoke ready line while a smoke result is unexercised");

  const production = doctorOf(builtPacket(t, { env: "production" }).packetPath, {});
  assertSmoke(production, packetRows({ env: "production" }));
  assert.equal(smokeReadyLines(production).length, 1, `one smoke ready line when every smoke result passes: ${JSON.stringify(production.ready)}`);
});

// ---------------------------------------------------------------------------
// C2: URL and fragment readings

test("C2 reviewer probe: href=\"#caf%C3%A9\" with only id=\"caf%C3%A9\": the decoded target café is missing (warning), never a pass on the raw fragment", async (t) => {
  const dir = tempTree(t, { "index.html": page({ body: "<a href=\"#caf%C3%A9\">Café</a>\n<h2 id=\"caf%C3%A9\">Café</h2>" }) });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { anchors: { "café": ["warning", "anchor_target_missing"] } }));
});

test("C2 percent-decoding keeps a % without two hex digits: href=\"#a%ZZ%C3%A9\" names a%ZZé", async (t) => {
  const dir = tempTree(t, { "index.html": page({ body: "<a href=\"#a%ZZ%C3%A9\">Synthetic</a>\n<h2 id=\"a%ZZé\">Synthetic</h2>" }) });
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { anchors: { "a%ZZé": ["pass"] } }));
});

test("C2 reviewer probe: scheme-relative og:image on the deploy base host, file present in _site: warning (og_image_not_absolute), not pass", async (t) => {
  const landing = packetPage("landing", { ogImage: `//preview.example.invalid/${SLUG}/img/og.png` });
  const f = builtPacket(t, { env: "production", landing });
  const rows = assertSmoke(doctorOf(f.packetPath, {}), packetRows({ landing: { set: { [KEY.ogImageTarget]: ["warning", "og_image_not_absolute"] } } }));
  assert.equal(rows[idOf(packetRel("landing"), KEY.ogImageTarget)].observation.og.image_target, `//preview.example.invalid/${SLUG}/img/og.png`);
});

test("C2 scheme-relative og:image under doctor --built (no deploy base): warning (og_image_not_absolute), observation relative_present, not og_image_base_unknown", async (t) => {
  const dir = tempTree(t, { "index.html": page({ ogImage: `//preview.example.invalid/${CAMPAIGN}/img/og.png` }), "img/og.png": "synthetic og image bytes\n" });
  const result = await builtDoctor(dir);
  assertSmoke(result, pageRows(PAGE, { set: { [KEY.ogImageTarget]: ["warning", "og_image_not_absolute"] } }));
  const row = rowsOf(result).find((candidate) => candidate.subject.key === KEY.ogImageTarget);
  assert.equal(row.observation.og.image, "relative_present");
});

test("C2 scheme-relative og:image on a host that is not the deploy base: warning (og_image_not_absolute), observation relative_present", async (t) => {
  const landing = packetPage("landing", { ogImage: "//elsewhere.example.invalid/img/og.png" });
  const f = builtPacket(t, { env: "production", landing });
  const rows = assertSmoke(doctorOf(f.packetPath, {}), packetRows({ landing: { set: { [KEY.ogImageTarget]: ["warning", "og_image_not_absolute"] } } }));
  assert.equal(rows[idOf(packetRel("landing"), KEY.ogImageTarget)].observation.og.image, "relative_present");
});

test("C2 residual probe: absolute same-base og:image whose _site file is a symlink to a file outside _site: og_image_missing_file; an in-site symlink still passes", async (t) => {
  const f = builtPacket(t, {
    env: "production",
    landing: packetPage("landing", { ogImage: `${ORIGIN}/${SLUG}/img/linked.png` }),
    files: { "outside-og.png": "synthetic image outside the site\n" },
    links: { [`_site/${SLUG}/img/linked.png`]: "outside-og.png", [`_site/${SLUG}/img/alias.png`]: `_site/${SLUG}/img/og.png` },
  });
  assertSmoke(doctorOf(f.packetPath, {}), packetRows({ landing: { set: { [KEY.ogImageTarget]: ["warning", "og_image_missing_file"] } } }));

  const g = builtPacket(t, { env: "production", landing: packetPage("landing", { ogImage: `${ORIGIN}/${SLUG}/img/alias.png` }), links: { [`_site/${SLUG}/img/alias.png`]: `_site/${SLUG}/img/og.png` } });
  assertSmoke(doctorOf(g.packetPath, {}), packetRows());
});

test("C2 relative og:image whose file is a symlink outside _site: og_image_missing_file, not og_image_not_absolute", async (t) => {
  const dir = tempTree(t, { "index.html": page({ ogImage: "img/linked.png" }) });
  writeFile(join(dir, "outside-og.png"), "synthetic image outside the site\n");
  mkdirSync(join(dir, "_site", CAMPAIGN, "img"), { recursive: true });
  symlinkSync(join(dir, "outside-og.png"), join(dir, "_site", CAMPAIGN, "img", "linked.png"));
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { set: { [KEY.ogImageTarget]: ["warning", "og_image_missing_file"] } }));
});

test("C2 a local script whose real path is outside _site (a symlink) is never read: the id it names gives unexercised (script_unreadable), not review", async (t) => {
  const dir = tempTree(t, { "index.html": page({ head: "<script src=\"js/tabs.js\"></script>", body: "<a href=\"#features\">Features</a>\n<main><p>Synthetic page.</p></main>" }) });
  writeFile(join(dir, "outside.js"), "document.body.insertAdjacentHTML(\"beforeend\", '<section id=\"features\"></section>');\n");
  mkdirSync(join(dir, "_site", CAMPAIGN, "js"), { recursive: true });
  symlinkSync(join(dir, "outside.js"), join(dir, "_site", CAMPAIGN, "js", "tabs.js"));
  assertSmoke(await builtDoctor(dir), pageRows(PAGE, { anchors: { features: ["unexercised", "script_unreadable"] } }));
});

// ---------------------------------------------------------------------------
// C3: one script collector

test("C3 collectBuiltPageIdentityInputs' bounded form lists every local script a page loads, read or unread; its identity form is unchanged", (t) => {
  const line = "// Synthetic filler line for the script size cap.\n";
  const many = Array.from({ length: 17 }, (_, index) => `js/m${String(index + 1).padStart(2, "0")}.js`);
  const files = {
    "index.html": page({ head: ["js/a.js", "js/missing.js", "js/big.js", "js/linked.js", "https://cdn.example.invalid/remote.js"].map((src) => `<script src="${src}"></script>`).join("\n") }),
    "many.html": page({ head: many.map((src) => `<script src="${src}"></script>`).join("\n") }),
    "js/a.js": "window.syntheticA = true;\n",
    "js/big.js": line.repeat(Math.ceil((2 * MiB) / line.length)),
  };
  for (const src of many) files[src] = `window.synthetic = "${src}";\n`;
  const dir = tempTree(t, files);
  writeFile(join(dir, "outside.js"), "window.syntheticOutside = true;\n");
  symlinkSync(join(dir, "outside.js"), join(dir, "_site", CAMPAIGN, "js", "linked.js"));

  const scope = resolveBuiltSiteScope(dir, { slug: CAMPAIGN });
  assert.ok(scope.ok, "setup: the built scope resolves");
  const pages = collectCartPlaceholderPages(dir, CAMPAIGN);
  const bounded = collectBuiltPageIdentityInputs(scope, dir, { pages, bounds: SMOKE_QC_LIMITS });
  // `file` as the identity form names it (relFromDir: the real path, "./"-prefixed).
  const fileOf = (src) => `./_site/${CAMPAIGN}/${src}`;
  const scriptsOf = (list, file) => list.find((item) => item.file.replace(/^\.\//, "") === file.replace(/^\.\//, "")).scripts;
  assert.deepEqual(scriptsOf(bounded, PAGE), [
    { src: "js/a.js", file: fileOf("js/a.js"), content: files["js/a.js"] },
    { src: "js/missing.js", file: fileOf("js/missing.js"), unread: "missing" },
    { src: "js/big.js", file: fileOf("js/big.js"), unread: "too_large" },
    { src: "js/linked.js", file: "./outside.js", unread: "outside_site" },
  ]);
  assert.deepEqual(scriptsOf(bounded, fileOf("many.html")), many.map((src, index) => (index < SMOKE_QC_LIMITS.scripts
    ? { src, file: fileOf(src), content: files[src] }
    : { src, file: fileOf(src), unread: "script_cap" })));

  // The identity form: read scripts only, unread ones dropped, no size or
  // site-root bound (the campaign identity gate's own reading).
  const identity = collectBuiltPageIdentityInputs(scope, dir);
  assert.deepEqual(scriptsOf(identity, PAGE).map(({ src, file }) => [src, file]), [
    ["js/a.js", fileOf("js/a.js")],
    ["js/big.js", fileOf("js/big.js")],
    ["js/linked.js", "./outside.js"],
  ]);
});

// ---------------------------------------------------------------------------
// C4: the certified reachability harness

// The harness's own gate reading, taken from the reachability test file (its
// QC_CHECKS block through gateOf) and run here on probe results, since that
// file runs against the certified tree only.
function reachabilityGateOf() {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "doctor-certified-family-reachability.test.mjs"), "utf8");
  const start = source.indexOf("const QC_CHECKS");
  const gateStart = source.indexOf("const gateOf", start);
  const end = source.indexOf("\n};\n", gateStart);
  assert.ok(start >= 0 && gateStart > start && end > gateStart, "setup: the harness block is found");
  // eslint-disable-next-line no-new-func
  return new Function("SMOKE_QC", "SMOKE_QC_CHECK", `${source.slice(start, end + 3)}\nreturn gateOf;`)(SMOKE_QC, SMOKE_QC_CHECK);
}
const harnessPasses = (gate) => Boolean(gate) && (gate.status === "pass" || gate.status === "not_applicable");

test("C4 reviewer probes: the reachability harness fails page_unreadable, candidate_cap_reached, an unknown reason, a reason on the wrong key, warning and review; it passes only pass rows plus each key's allowed unexercised reasons", async (t) => {
  const gateOf = reachabilityGateOf();
  const clean = await builtDoctor(tempTree(t, { "index.html": page() }));
  assertSmoke(clean, pageRows(PAGE));
  assert.equal(harnessPasses(gateOf(clean, SMOKE_QC)), true, "pass rows plus og_image_base_unknown and build_environment_unknown pass");

  const unreadableDir = tempTree(t, { "index.html": page() });
  symlinkSync("missing-synthetic-page.html", join(unreadableDir, "_site", CAMPAIGN, "broken.html"));
  const unreadable = await builtDoctor(unreadableDir);
  assert.ok(rowsOf(unreadable).some((row) => row.reason_code === "page_unreadable"), "setup: a page_unreadable row");
  assert.equal(harnessPasses(gateOf(unreadable, SMOKE_QC)), false, "page_unreadable fails the harness");

  const anchors = Array.from({ length: 2001 }, (_, index) => `<a href="#benefits">Benefits ${index + 1}</a>`).join("\n");
  const cappedResult = await builtDoctor(tempTree(t, { "index.html": page({ body: `${anchors}\n<section id="benefits"></section>` }) }));
  assert.ok(rowsOf(cappedResult).some((row) => row.reason_code === "candidate_cap_reached"), "setup: a candidate_cap_reached row");
  assert.equal(harnessPasses(gateOf(cappedResult, SMOKE_QC)), false, "candidate_cap_reached fails the harness");

  const probe = (key, result, reasonCode) => ({
    derived: { qc_results: rowsOf(clean).map((row) => (row.subject.key === key ? { ...row, result, reason_code: reasonCode } : row)) },
  });
  assert.equal(harnessPasses(gateOf(probe(KEY.ogImageTarget, "unexercised", "og_image_remote_not_fetched"), SMOKE_QC)), true, "og_image_remote_not_fetched on og:image_target passes");
  for (const key of Object.values(KEY).filter((candidate) => candidate !== KEY.ogImageTarget)) {
    assert.equal(harnessPasses(gateOf(probe(key, "unexercised", "og_image_remote_not_fetched"), SMOKE_QC)), false, `og_image_remote_not_fetched on ${key} fails the harness`);
  }
  for (const [key, result, reasonCode] of [
    [KEY.ogImageTarget, "unexercised", "synthetic_unknown_reason"],
    [KEY.favicon, "unexercised", "build_environment_unknown"],
    [KEY.tailwind, "unexercised", "development_render"],
    [KEY.favicon, "warning", "favicon_missing"],
    [KEY.assetHost, "review", "anchor_target_in_template"],
  ]) {
    assert.equal(harnessPasses(gateOf(probe(key, result, reasonCode), SMOKE_QC)), false, `${key} ${result}/${reasonCode} fails the harness`);
  }
  assert.equal(gateOf({ derived: { qc_results: [] } }, SMOKE_QC), null, "no smoke row reads as the check not having run");
});

// ---------------------------------------------------------------------------
// C3: scripts listed from the parsed page

// A dangling in-page link and one local script that is not in _site/: any
// script the page loads leaves the target unexercised (script_unreadable); a
// script the page does not load leaves it a warning.
const DANGLING = "<a href=\"#features\">Features</a>\n<main><p>Synthetic page.</p></main>";

for (const [label, tag] of [
  ["reviewer probe: unquoted src", "<script src=missing.js></script>"],
  ["reviewer probe: spaces around =", "<script src = \"missing.js\"></script>"],
  ["single-quoted src", "<script src='missing.js'></script>"],
  ["upper-case tag and attribute", "<SCRIPT SRC=\"missing.js\"></SCRIPT>"],
  ["type=module", "<script type=\"module\" src=\"missing.js\"></script>"],
]) {
  test(`C3 ${label}: the missing local script is loaded, so the dangling target is unexercised (script_unreadable), not anchor_target_missing`, async (t) => {
    const dir = tempTree(t, { "index.html": page({ head: tag, body: DANGLING }) });
    const result = await builtDoctor(dir);
    const rows = assertSmoke(result, pageRows(PAGE, { anchors: { features: ["unexercised", "script_unreadable"] } }));
    const row = rows[idOf(PAGE, anchorKey("features"))];
    assert.equal(row.observation.scripts_loaded, 1, "the script is listed as loaded");
    assert.equal(row.observation.scripts_read, 0, "and not read");
  });
}

for (const [label, markup] of [
  ["a non-JavaScript type", { head: "<script type=\"text/x-template\" src=\"missing.js\"></script>" }],
  ["a script inside <template>", { body: "<template><script src=\"missing.js\"></script></template>" }],
  ["a script inside <noscript>", { head: "<noscript><script src=\"missing.js\"></script></noscript>" }],
  ["an empty src", { head: "<script src=\"\"></script>" }],
]) {
  test(`C3 ${label} does not load: the dangling target is a warning (anchor_target_missing) with no script loaded`, async (t) => {
    const dir = tempTree(t, { "index.html": page({ head: markup.head || "", body: `${markup.body || ""}\n${DANGLING}` }) });
    const rows = assertSmoke(await builtDoctor(dir), pageRows(PAGE, { anchors: { features: ["warning", "anchor_target_missing"] } }));
    assert.equal(rows[idOf(PAGE, anchorKey("features"))].observation.scripts_loaded, 0);
  });
}

test("C3 the bounded form lists scripts from the parse5 tree whatever the attribute syntax; the identity form keeps its own reading", (t) => {
  const head = [
    "<script src=js/a.js></script>",
    "<script src = \"js/b.js\"></script>",
    "<SCRIPT SRC='js/c.js'></SCRIPT>",
    "<script type=\"text/x-template\" src=\"js/d.js\"></script>",
    "<noscript><script src=\"js/e.js\"></script></noscript>",
  ].join("\n");
  const files = { "index.html": page({ head, body: "<template><script src=\"js/f.js\"></script></template>" }) };
  for (const name of ["a", "b", "c", "d", "e", "f"]) files[`js/${name}.js`] = `window.synthetic${name.toUpperCase()} = true;\n`;
  const dir = tempTree(t, files);
  const scope = resolveBuiltSiteScope(dir, { slug: CAMPAIGN });
  assert.ok(scope.ok, "setup: the built scope resolves");
  const bounded = collectBuiltPageIdentityInputs(scope, dir, { pages: collectCartPlaceholderPages(dir, CAMPAIGN), bounds: SMOKE_QC_LIMITS });
  const fileOf = (src) => `./_site/${CAMPAIGN}/${src}`;
  assert.deepEqual(bounded.find((item) => item.file === PAGE).scripts, ["js/a.js", "js/b.js", "js/c.js"].map((src) => ({ src, file: fileOf(src), content: files[src] })));

  const identity = collectBuiltPageIdentityInputs(scope, dir);
  assert.deepEqual(identity[0].scripts.map(({ src }) => src), ["js/c.js", "js/d.js", "js/e.js", "js/f.js"], "the identity form's quoted-src reading is unchanged");
});

// ---------------------------------------------------------------------------
// C5: candidates counted relative or absolute

// page()'s own candidates: <meta charset>, the favicon <link> and its href,
// og:title, og:description, og:image and its absolute content.
const PAGE_CANDIDATES = 7;
const images = (count) => Array.from({ length: count }, () => "<img src=\"/synthetic.png\" alt=\"\">").join("\n");
const evaluateProduction = (content) => evaluateSmokeQc({ pages: [{ file: PAGE, content }], environment: "production", siteRoot: null, resolveAsset: () => null });
const PRODUCTION_ROWS = pageRows(PAGE, { env: "production", set: { [KEY.ogImageTarget]: ["unexercised", "og_image_base_unknown"] } });

test("C5 reviewer probe: 2,001 <img src=\"/synthetic.png\"> through evaluateSmokeQc: candidate_cap_reached on every rule key, no pass", () => {
  const results = evaluateProduction(page({ body: images(2001) }));
  assert.deepEqual(results.map(summarize).sort(byId), pageLevelRows(PAGE, "candidate_cap_reached").sort(byId));
  assert.deepEqual(results.filter((row) => row.result === "pass"), [], "no pass on a capped page");
});

test("C5 reviewer probe: 2,001 <img src=\"/synthetic.png\"> under the real doctor --built: candidate_cap_reached on every rule key, no pass", async (t) => {
  const dir = tempTree(t, { "index.html": page({ body: images(2001) }) });
  const rows = assertSmoke(await builtDoctor(dir), pageLevelRows(PAGE, "candidate_cap_reached"));
  assert.deepEqual(Object.values(rows).filter((row) => row.result === "pass"), [], "no pass on a capped page");
});

test("C5 the cap is exact: 2,000 candidates with relative values read as usual, one more caps", () => {
  const fill = 2000 - PAGE_CANDIDATES;
  assert.deepEqual(evaluateProduction(page({ body: images(fill) })).map(summarize).sort(byId), [...PRODUCTION_ROWS].sort(byId));
  assert.deepEqual(evaluateProduction(page({ body: images(fill + 1) })).map(summarize).sort(byId), pageLevelRows(PAGE, "candidate_cap_reached").sort(byId));
});

test("C5 every URL-bearing attribute counts with a relative value; an in-page anchor counts once; other attributes count only with an absolute URL", () => {
  const fill = images(2000 - PAGE_CANDIDATES);
  const bearing = [
    ["href", "<a href=\"/next/\">Next</a>"],
    ["src", "<iframe src=\"frame.html\"></iframe>"],
    ["srcset", "<img srcset=\"a.png 1x, b.png 2x\" alt=\"\">"],
    ["imagesrcset", "<link rel=\"preload\" as=\"image\" imagesrcset=\"a.png 1x\">"],
    ["poster", "<video poster=\"poster.png\"></video>"],
    ["action", "<form action=\"/submit\"></form>"],
    ["formaction", "<button formaction=\"/submit\">Go</button>"],
    ["data", "<object data=\"movie.swf\"></object>"],
    ["cite", "<blockquote cite=\"/source\">Quote</blockquote>"],
    ["background", "<table background=\"bg.png\"></table>"],
    ["longdesc", "<img longdesc=\"desc.html\" alt=\"\">"],
    ["manifest", "<div manifest=\"app.manifest\"></div>"],
    ["ping", "<a ping=\"/ping\">Ping</a>"],
    ["codebase", "<object codebase=\"/plugins/\"></object>"],
    ["xlink:href", "<svg><use xlink:href=\"sprite.svg#icon\"></use></svg>"],
    ["absolute data-* value", "<div data-src=\"https://elsewhere.example.invalid/x.png\"></div>"],
  ];
  for (const [label, markup] of bearing) {
    const results = evaluateProduction(page({ body: `${fill}\n${markup}` }));
    assert.ok(results.some((row) => row.reason_code === "candidate_cap_reached"), `${label}: the 2,001st candidate caps the page`);
    assert.deepEqual(results.filter((row) => row.result === "pass"), [], `${label}: no pass`);
  }
  for (const [label, markup] of [
    ["an in-page anchor (its href is the anchor candidate)", "<a href=\"#features\">Features</a><span id=\"features\"></span>"],
    ["a relative data-* value", "<div data-src=\"/x.png\"></div>"],
    ["a relative title", "<div title=\"/x.png\"></div>"],
    ["an empty src", "<img src=\"\" alt=\"\">"],
  ]) {
    const extra = images(2000 - PAGE_CANDIDATES - 1);
    const results = evaluateProduction(page({ body: `${extra}\n${markup}` }));
    assert.ok(!results.some((row) => row.reason_code === "candidate_cap_reached"), `${label}: 2,000 candidates, not capped`);
  }
});

// ---------------------------------------------------------------------------
// C6: the closed list of URL-bearing attributes

// The list as the build's frozen rules name it, in their order.
const CLOSED_URL_ATTRIBUTES = Object.freeze([
  "href", "src", "srcset", "imagesrcset", "poster", "action", "formaction", "data", "cite", "ping", "itemid", "itemtype",
  "usemap", "background", "longdesc", "manifest", "codebase", "classid", "archive", "profile", "lowsrc", "dynsrc", "xlink:href",
]);

// One element per relative value, on an element that is not itself a
// candidate (<link>, <meta>); attributes whose usual element appears once per
// page (<html manifest>, <head profile>) or is a <link> (imagesrcset) sit on a
// <span>. SVG href and xlink:href sit inside one <svg>.
const BEARING_MARKUP = Object.freeze({
  href: [(i) => `<a href="next/${i}/">Next</a>`],
  src: [(i) => `<img src="img/${i}.png" alt="">`],
  srcset: [(i) => `<img srcset="img/${i}.png 1x, img/${i}@2x.png 2x" alt="">`],
  imagesrcset: [(i) => `<span imagesrcset="img/${i}.png 1x"></span>`],
  poster: [(i) => `<video poster="img/${i}.png"></video>`],
  action: [(i) => `<form action="submit/${i}"></form>`],
  formaction: [(i) => `<button formaction="submit/${i}">Go</button>`],
  data: [(i) => `<object data="media/${i}.svg"></object>`],
  cite: [(i) => `<q cite="sources/${i}">Quote</q>`],
  ping: [(i) => `<a ping="ping/${i}">Ping</a>`],
  itemid: [(i) => `<div itemscope itemid="items/${i}"></div>`],
  itemtype: [(i) => `<div itemscope itemtype="types/product-${i}"></div>`],
  usemap: [(i) => `<img usemap="#map-${i}" alt="">`],
  background: [(i) => `<table background="img/${i}.png"></table>`],
  longdesc: [(i) => `<img longdesc="desc/${i}.html" alt="">`],
  manifest: [(i) => `<span manifest="app-${i}.manifest"></span>`],
  codebase: [(i) => `<object codebase="plugins/${i}/"></object>`],
  classid: [(i) => `<object classid="plugins/viewer-${i}"></object>`],
  archive: [(i) => `<object archive="plugins/${i}.jar"></object>`],
  profile: [(i) => `<span profile="profiles/${i}"></span>`],
  lowsrc: [(i) => `<img lowsrc="img/low-${i}.png" alt="">`],
  dynsrc: [(i) => `<img dynsrc="media/${i}.avi" alt="">`],
  "xlink:href": [(i) => `<use xlink:href="sprite.svg#icon-${i}"></use>`, "svg"],
});
const SVG_HREF = [(i) => `<use href="sprite.svg#icon-${i}"></use>`, "svg"];

// A page whose only candidates are `count` relative values of one attribute.
function bearingPage([markup, wrapper], count) {
  const items = Array.from({ length: count }, (_, index) => markup(index + 1)).join("\n");
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head><title>Synthetic smoke check page</title></head>",
    `<body>${wrapper ? `<${wrapper}>${items}</${wrapper}>` : items}</body>`,
    "</html>",
    "",
  ].join("\n");
}

const CANDIDATE_CAP = "candidate_cap_reached";
const hasCapMember = (row) => (row.members || []).some((member) => member.key === "page_coverage" && member.reason_code === CANDIDATE_CAP);

function assertCandidateCapped(results, label) {
  assert.deepEqual(results.filter((row) => row.result === "pass").map((row) => row.id), [], `${label}: no pass on any rule key`);
  assert.deepEqual(results.filter((row) => !hasCapMember(row)).map((row) => row.id), [], `${label}: every row carries the cap member`);
  assert.deepEqual(results.map(summarize).sort(byId), pageLevelRows(PAGE, CANDIDATE_CAP).sort(byId), `${label}: candidate_cap_reached on every rule key`);
}

function assertNotCandidateCapped(results, label) {
  assert.deepEqual(results.filter((row) => row.reason_code === CANDIDATE_CAP || hasCapMember(row)).map((row) => row.id), [], `${label}: not capped`);
}

test("C6 the URL-bearing attributes are exactly the closed list", () => {
  assert.deepEqual([...URL_ATTRIBUTES].sort(), [...CLOSED_URL_ATTRIBUTES].sort());
  assert.deepEqual(Object.keys(BEARING_MARKUP).sort(), [...CLOSED_URL_ATTRIBUTES].sort(), "setup: one table row per listed attribute");
});

for (const [label, row] of [...CLOSED_URL_ATTRIBUTES.map((attr) => [attr, BEARING_MARKUP[attr]]), ["SVG href", SVG_HREF]]) {
  test(`C6 ${label}: 2,001 relative values cap the page (no pass, cap member on every row); exactly 2,000 do not`, () => {
    assertCandidateCapped(evaluateProduction(bearingPage(row, 2001)), `${label} x 2,001`);
    assertNotCandidateCapped(evaluateProduction(bearingPage(row, 2000)), `${label} x 2,000`);
  });
}

for (const [label, body] of [
  ["2,001 <img usemap=\"#map\">", Array.from({ length: 2001 }, () => "<img usemap=\"#map\" alt=\"\">").join("\n")],
  ["1,001 <img> with src and usemap", Array.from({ length: 1001 }, () => "<img src=\"/synthetic.png\" usemap=\"#map\" alt=\"\">").join("\n")],
  ["1,001 itemscope <div>s with itemtype and itemid", Array.from({ length: 1001 }, (_, index) => `<div itemscope itemtype="types/product" itemid="items/${index + 1}"></div>`).join("\n")],
]) {
  test(`C6 reviewer probe: ${label}: candidate_cap_reached on every rule key, no pass, through evaluateSmokeQc and doctor --built`, async (t) => {
    assertCandidateCapped(evaluateProduction(page({ body })), label);
    const rows = assertSmoke(await builtDoctor(tempTree(t, { "index.html": page({ body }) })), pageLevelRows(PAGE, CANDIDATE_CAP));
    assert.deepEqual(Object.values(rows).filter((row) => row.result === "pass"), [], `${label} under doctor --built: no pass`);
  });
}

// ---------------------------------------------------------------------------
// C7: URL to built-file mapping

const DEPLOY = "https://preview.example.invalid/";
const pageFile = (dir) => join(dir, PAGE);
const builtResolver = (dir) => (src, builtPath) => resolveBuiltAssetPath(src, builtPath, dir);

// The smoke results evaluateSmokeQc gives a doctor --built tree, with the
// pages and scripts doctor reads (the bounded collector) and, optionally, a
// deploy base.
function evaluateTree(dir, { deployBase = null, environment = null } = {}) {
  const scope = resolveBuiltSiteScope(dir, { slug: CAMPAIGN });
  assert.ok(scope.ok, "setup: the built scope resolves");
  const pages = collectBuiltPageIdentityInputs(scope, dir, { pages: collectCartPlaceholderPages(dir, CAMPAIGN), bounds: SMOKE_QC_LIMITS });
  return evaluateSmokeQc({ pages, environment, siteRoot: join(dir, "_site"), deployBase, resolveAsset: builtResolver(dir) });
}
const boundedScriptsOf = (dir) => {
  const scope = resolveBuiltSiteScope(dir, { slug: CAMPAIGN });
  return collectBuiltPageIdentityInputs(scope, dir, { pages: collectCartPlaceholderPages(dir, CAMPAIGN), bounds: SMOKE_QC_LIMITS }).find((item) => item.file === PAGE).scripts;
};
const deployRows = (set = {}) => pageRows(PAGE, { env: "production", set });

for (const [label, escape] of [["#", "%23"], ["?", "%3F"]]) {
  const decoyName = `a${escape}b.png`;
  const realName = `a${label}b.png`;

  test(`C7 reviewer probe: absolute same-base og:image img/${decoyName} with only a file literally named ${decoyName}: og_image_missing_file through the packet doctor; the decoded ${realName} passes`, async (t) => {
    const decoy = builtPacket(t, { landing: packetPage("landing", { ogImage: `${ORIGIN}/${SLUG}/img/${decoyName}` }), files: { [`_site/${SLUG}/img/${decoyName}`]: "synthetic decoy bytes\n" } });
    assertSmoke(doctorOf(decoy.packetPath, {}), packetRows({ landing: { set: { [KEY.ogImageTarget]: ["warning", "og_image_missing_file"] } } }));

    const real = builtPacket(t, { landing: packetPage("landing", { ogImage: `${ORIGIN}/${SLUG}/img/${decoyName}` }), files: { [`_site/${SLUG}/img/${realName}`]: "synthetic image bytes\n" } });
    assertSmoke(doctorOf(real.packetPath, {}), packetRows());
  });

  test(`C7 reviewer probe: absolute same-base og:image img/${decoyName} through evaluateSmokeQc: the ${decoyName} decoy reads og_image_missing_file; the decoded ${realName} passes`, (t) => {
    const ogImage = `${DEPLOY}${CAMPAIGN}/img/${decoyName}`;
    const decoy = tempTree(t, { "index.html": page({ ogImage }), [`img/${decoyName}`]: "synthetic decoy bytes\n" });
    assert.deepEqual(evaluateTree(decoy, { deployBase: DEPLOY, environment: "production" }).map(summarize).sort(byId), deployRows({ [KEY.ogImageTarget]: ["warning", "og_image_missing_file"] }).sort(byId));
    const real = tempTree(t, { "index.html": page({ ogImage }), [`img/${realName}`]: "synthetic image bytes\n" });
    assert.deepEqual(evaluateTree(real, { deployBase: DEPLOY, environment: "production" }).map(summarize).sort(byId), deployRows().sort(byId));
  });
}

test("C7 reviewer probe: <script src=\"real%20script.js\"> with only a file literally named real%20script.js: unexercised (script_unreadable) under doctor --built and evaluateSmokeQc, never anchor_target_missing", async (t) => {
  const content = page({ head: "<script src=\"real%20script.js\"></script>", body: "<a href=\"#x\">x</a>" });
  const decoy = tempTree(t, { "index.html": content, "real%20script.js": "const unrelated=1;\n" });
  const expected = pageRows(PAGE, { anchors: { x: ["unexercised", "script_unreadable"] } });
  assertSmoke(await builtDoctor(decoy), expected);
  assert.deepEqual(evaluateTree(decoy).map(summarize).sort(byId), [...expected].sort(byId));
  assert.deepEqual(boundedScriptsOf(decoy), [{ src: "real%20script.js", file: `./_site/${CAMPAIGN}/real script.js`, unread: "missing" }]);

  const real = tempTree(t, { "index.html": content, "real script.js": "window.x=1;\n" });
  assertSmoke(await builtDoctor(real), pageRows(PAGE, { anchors: { x: ["review", "anchor_target_possibly_script_created"] } }));
});

// Each escape names the decoded file; the decoy is a file literally named
// with the escape. `%ZZ` names no file, so no real counterpart exists.
const ESCAPES = [
  ["an encoded space", "a%20b", "a b"],
  ["an encoded #", "a%23b", "a#b"],
  ["an encoded ?", "a%3Fb", "a?b"],
  ["an encoded non-ASCII character", "caf%C3%A9", "café"],
  ["a malformed %ZZ", "a%ZZb", null],
];

for (const [label, encoded, decoded] of ESCAPES) {
  test(`C7 og:image with ${label} (img/${encoded}.png): the literal ${encoded}.png decoy never satisfies it${decoded ? `; ${decoded}.png does` : ""}`, async (t) => {
    const decoyFiles = { [`img/${encoded}.png`]: "synthetic decoy bytes\n" };
    const absolute = `${DEPLOY}${CAMPAIGN}/img/${encoded}.png`;
    const decoyAbsolute = tempTree(t, { "index.html": page({ ogImage: absolute }), ...decoyFiles });
    assert.deepEqual(evaluateTree(decoyAbsolute, { deployBase: DEPLOY, environment: "production" }).map(summarize).sort(byId), deployRows({ [KEY.ogImageTarget]: ["warning", "og_image_missing_file"] }).sort(byId), "absolute same-base, decoy only");
    const decoyRelative = tempTree(t, { "index.html": page({ ogImage: `img/${encoded}.png` }), ...decoyFiles });
    assertSmoke(await builtDoctor(decoyRelative), pageRows(PAGE, { set: { [KEY.ogImageTarget]: ["warning", "og_image_missing_file"] } }));
    if (!decoded) return;

    const realFiles = { [`img/${decoded}.png`]: "synthetic image bytes\n" };
    const realAbsolute = tempTree(t, { "index.html": page({ ogImage: absolute }), ...realFiles });
    assert.deepEqual(evaluateTree(realAbsolute, { deployBase: DEPLOY, environment: "production" }).map(summarize).sort(byId), deployRows().sort(byId), "absolute same-base, decoded file present");
    const realRelative = tempTree(t, { "index.html": page({ ogImage: `img/${encoded}.png` }), ...realFiles });
    assertSmoke(await builtDoctor(realRelative), pageRows(PAGE, { set: { [KEY.ogImageTarget]: ["warning", "og_image_not_absolute"] } }));
  });

  test(`C7 local script with ${label} (js/${encoded}.js): the literal ${encoded}.js decoy is never read, so the target it names is unexercised (script_unreadable)${decoded ? `; ${decoded}.js is read` : ""}`, async (t) => {
    const content = page({ head: `<script src="js/${encoded}.js"></script>`, body: DANGLING });
    const script = "document.body.insertAdjacentHTML(\"beforeend\", '<section id=\"features\"></section>');\n";
    const decoy = tempTree(t, { "index.html": content, [`js/${encoded}.js`]: script });
    const expected = pageRows(PAGE, { anchors: { features: ["unexercised", "script_unreadable"] } });
    assertSmoke(await builtDoctor(decoy), expected);
    assert.deepEqual(evaluateTree(decoy).map(summarize).sort(byId), [...expected].sort(byId));
    assert.deepEqual(boundedScriptsOf(decoy), [decoded
      ? { src: `js/${encoded}.js`, file: `./_site/${CAMPAIGN}/js/${decoded}.js`, unread: "missing" }
      : { src: `js/${encoded}.js`, unread: "unmappable" }]);
    if (!decoded) return;

    const real = tempTree(t, { "index.html": content, [`js/${decoded}.js`]: script });
    assertSmoke(await builtDoctor(real), pageRows(PAGE, { anchors: { features: ["review", "anchor_target_possibly_script_created"] } }));
  });
}

// ---------------------------------------------------------------------------
// C8: rule edges

const productionRows = (set) => pageRows(PAGE, { env: "production", set: { [KEY.ogImageTarget]: ["unexercised", "og_image_base_unknown"], ...set } });

test("C8 the asset host is matched whatever its case: <img src=\"https://CDN.29NEXT.STORE/x.png\"> warns primary_asset_host", () => {
  const results = evaluateProduction(page({ body: "<img src=\"https://CDN.29NEXT.STORE/x.png\" alt=\"\">" }));
  assert.deepEqual(results.map(summarize).sort(byId), productionRows({ [KEY.assetHost]: ["warning", "primary_asset_host"] }).sort(byId));
});

test("C8 the IPv6 loopback in a production build: <img src=\"http://[::1]:8080/x.png\"> warns loopback_url", () => {
  const results = evaluateProduction(page({ body: "<img src=\"http://[::1]:8080/x.png\" alt=\"\">" }));
  assert.deepEqual(results.map(summarize).sort(byId), productionRows({ [KEY.loopback]: ["warning", "loopback_url"] }).sort(byId));
});

for (const [label, markup] of [
  ["<meta>", "<template><meta name=\"synthetic\" content=\"synthetic\"></template>"],
  ["<link>", "<template><link rel=\"preload\" as=\"image\"></template>"],
]) {
  test(`C8 a ${label} inside <template> counts toward the candidate cap: as the 2,001st candidate it caps the page; as the 2,000th it does not`, () => {
    assertCandidateCapped(evaluateProduction(page({ body: `${images(2000 - PAGE_CANDIDATES)}\n${markup}` })), `${label} in <template> as candidate 2,001`);
    assertNotCandidateCapped(evaluateProduction(page({ body: `${images(2000 - PAGE_CANDIDATES - 1)}\n${markup}` })), `${label} in <template> as candidate 2,000`);
  });
}
