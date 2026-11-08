// Doctor golden outputs: pre-refactor characterization for #730 milestone 1.
//
// #730 moves doctor's built-output checks onto a shared, bounded input layer
// and promises output equivalence while it does: codes, messages, severities,
// ordering, ready[], derived.doctor_checks, checkpoint gates, waiver
// assessments, QC rows (ids, state fingerprints, coverage), causes and `next`
// all stay as they are. Existing tests assert pieces of that; these cases pin
// the whole output of each entry point (doctorBuiltOutput, doctorPacket with
// and without outputBaseDir, and doctorCommand --ci) for every case class
// #730 names: initial/pre-build, partial/unreadable, capped, conflicting-role,
// waived and failing.
//
// The goldens under fixtures/doctor-golden/doctor/ were captured at base
// e1c5bc9c6dc2745d6f2bd54f37f89319ce7f915a, before the refactor. A refactor
// change must reproduce them exactly; a diff is a regression to fix, never a
// reason to regenerate. Regenerating is only for a separately reviewed
// behavior change, and the diff is read before it is committed:
//
//   UPDATE_GOLDEN=1 node --test src/doctor-golden.test.mjs
//
// Normalization is limited to three things. The clock is frozen (Date mocked
// to FROZEN_NOW), so generated_at, measured_at and waiver-expiry decisions are
// fixed at run time rather than rewritten afterwards. Every temp fixture root
// is reached through a symlink: the symlink form is written "<fixture>", the
// real path "<fixture-real>", and the repository root "<toolkit>", in every
// string. In outputBaseDir cases only, the exact root-escape run of "../"
// segments (one per segment of the base's real path) is written "<fsroot>/".
// Nothing else is touched. See fixtures/doctor-golden/README.md.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { formatDoctorCi } from "./doctor/ci.mjs";
import { doctorBuiltOutput, doctorCommand, doctorPacket } from "./doctor/inspect.mjs";
import { disabledLiveRead } from "./live-campaign-refs.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN_DIR = join(ROOT, "fixtures", "doctor-golden", "doctor");
const BASE_SHA = "e1c5bc9c6dc2745d6f2bd54f37f89319ce7f915a";
const FROZEN_NOW = "2026-01-01T00:00:00.000Z";
const REGEN = "UPDATE_GOLDEN=1 node --test src/doctor-golden.test.mjs";
// Only the exact value "1" regenerates, and never under CI: a CI run that
// rewrote the goldens would compare doctor with itself and pass.
const UPDATE = process.env.UPDATE_GOLDEN === "1";
if (UPDATE && process.env.CI) {
  throw new Error(`doctor golden: ${REGEN} is refused while CI is set; regenerate locally and read the diff before committing.`);
}
// A regeneration names the commit it ran on, never BASE_SHA, and refuses
// uncommitted non-test source, so a golden's base_sha is the code that
// produced it. The suite then fails until BASE_SHA is moved to that commit.
const STAMP = UPDATE ? captureCommit() : BASE_SHA;
function captureCommit() {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
  const dirty = git("status", "--porcelain", "--", "src", ":(exclude)*.test.mjs").trim();
  if (dirty) throw new Error(`doctor golden: commit or discard these src/ changes before regenerating, so base_sha names the code that produced the goldens:\n${dirty}`);
  return git("rev-parse", "HEAD").trim();
}

const CERTIFIED_ROOT = join(ROOT, "fixtures", "certified-families");
const SDK_MARKUP_ROOT = join(ROOT, "fixtures", "sdk-markup");
const CART_PLACEHOLDERS_ROOT = join(ROOT, "fixtures", "cart-placeholders");
const FIXTURE_SLUG = "example-campaign";
const PACKET_SLUG = "runtime-packet-demo";
const MiB = 1024 * 1024;
const RUNS_AS_ROOT = process.getuid?.() === 0;

// ---------------------------------------------------------------------------
// Hermetic environment: frozen clock, no network, no sibling private
// template checkouts, no campaign key from the shell.

const ENV_KEYS = ["PRIVATE_TEMPLATE_SOURCES_ROOT", "PRIVATE_TEMPLATE_SOURCES_PATH", "CAMPAIGNS_API_KEY"];

function hermetic(t) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(FROZEN_NOW) });
  const privateRoot = mkdtempSync(join(tmpdir(), "campaigns-os-doctor-golden-private-"));
  const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  // Private families resolve under sibling checkouts by default; an empty
  // root keeps a developer machine's siblings out of the output.
  process.env.PRIVATE_TEMPLATE_SOURCES_ROOT = privateRoot;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    throw new Error(`doctor golden: unexpected network request to ${String(input?.url || input)}`);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(privateRoot, { recursive: true, force: true });
  });
  return { privateRoot };
}

// A temp fixture root, always reached through a symlink: <parent>/via-link
// points at <parent>/root. The symlink form and the real path are therefore
// different strings on every platform (on Linux /tmp is already real, on
// macOS /var is itself a link), so a change that canonicalizes a path doctor
// prints fails the same way on both.
function tempRoot(t, topic) {
  const parent = mkdtempSync(join(tmpdir(), `campaigns-os-doctor-golden-${topic}-`));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(join(parent, "root"));
  symlinkSync("root", join(parent, "via-link"), "dir");
  return join(parent, "via-link");
}

// ---------------------------------------------------------------------------
// Normalization and golden comparison.

// The JSON-replacer pattern from scripts/performance/worker.mjs, minus its
// timestamp rewrite (the clock is frozen instead): each temp fixture root's
// symlink form becomes "<fixture>", its real path "<fixture-real>", and the
// repo root "<toolkit>", in every string, longest form first. `baseDir` is
// set only for outputBaseDir cases (see stripRootEscape).
function normalize(value, fixtureDirs, { baseDir = null, extraForbidden = [] } = {}) {
  const swaps = [];
  for (const dir of fixtureDirs) {
    const real = realpathSync(dir);
    assert.notEqual(real, dir, `setup: fixture root ${dir} is reached through a symlink`);
    swaps.push([dir, "<fixture>"], [real, "<fixture-real>"]);
  }
  for (const form of new Set([ROOT, realpathSync(ROOT)])) swaps.push([form, "<toolkit>"]);
  swaps.sort((a, b) => b[0].length - a[0].length);
  const escape = baseDir ? stripRootEscape(baseDir) : (entry) => entry;
  const text = JSON.stringify(value, (key, entry) => (typeof entry === "string"
    ? swaps.reduce((current, [from, to]) => current.split(from).join(to), escape(entry))
    : entry));
  // A path in an object key, or another temp directory, would escape the
  // replacer; fail rather than commit it.
  const tmp = tmpdir();
  const forbidden = [...swaps.map(([from]) => from), tmp, realpathSync(tmp), ...extraForbidden];
  for (const needle of new Set(forbidden)) {
    assert.equal(text.includes(needle), false, `normalized doctor output still contains ${needle}`);
  }
  return JSON.parse(text);
}

// outputBaseDir cases: base relFromDir relativizes every absolute-looking
// string against the real path of the base, root-relative public routes and
// URLs included ("/runtime-packet-demo/landing" becomes
// "../../…/runtime-packet-demo/landing"), so their "../" run is as long as
// the temp directory is deep. Exactly that run, one "../" per segment of the
// base's real path and no longer or shorter, is written "<fsroot>/"; paths
// inside the fixture carry fewer and stay as they are. This pins a base quirk
// (root-relative public routes treated as local paths) that #730 does not
// change. POSIX separators only: the suite, like CI, runs on macOS and Linux.
function stripRootEscape(baseDir) {
  const depth = realpathSync(baseDir).split(sep).filter(Boolean).length;
  const run = new RegExp(`(?<!\\.\\./)(?:\\.\\./){${depth}}(?!\\.\\./)`, "g");
  return (entry) => entry.replace(run, "<fsroot>/");
}

// Size, not volatility: a case whose output would push its golden past the
// private-strings scan limit (2,000,000 bytes) keeps the listed arrays as
// their length, the sha256 of their full normalized JSON and the entries
// `keep` selects, each with its index. Any change to any entry still fails.
function compactArrays(output, { paths, keep }) {
  const copy = structuredClone(output);
  for (const path of paths) {
    const parent = path.slice(0, -1).reduce((node, key) => node[key], copy);
    const key = path[path.length - 1];
    const array = parent[key];
    assert.ok(Array.isArray(array), `compaction target ${path.join(".")} is an array`);
    parent[key] = {
      compacted: {
        length: array.length,
        sha256: createHash("sha256").update(JSON.stringify(array)).digest("hex"),
        kept: array.flatMap((entry, index) => (keep(entry) ? [{ index, entry }] : [])),
      },
    };
  }
  return copy;
}

const registered = new Set();

function goldenCase(entry, id, description, run, { compact = null, skip = false } = {}) {
  const name = `${entry}-${id}`;
  assert.equal(registered.has(name), false, `duplicate golden case ${name}`);
  registered.add(name);
  test(`doctor golden ${name}: ${description}`, { skip }, (t) => {
    const env = hermetic(t);
    const { output, dirs = [], baseDir = null } = run(t, env);
    const normalized = normalize(output, dirs, { baseDir, extraForbidden: [env.privateRoot] });
    // DOCTOR_GOLDEN_DUMP=<dir> writes each full normalized output there,
    // uncompacted, for diffing two checkouts when a compacted array differs.
    if (process.env.DOCTOR_GOLDEN_DUMP) {
      mkdirSync(process.env.DOCTOR_GOLDEN_DUMP, { recursive: true });
      writeFileSync(join(process.env.DOCTOR_GOLDEN_DUMP, `${name}.json`), `${JSON.stringify(normalized, null, 2)}\n`);
    }
    const record = {
      base_sha: STAMP,
      case: id,
      entry,
      description,
      output: compact ? compactArrays(normalized, compact) : normalized,
    };
    const file = join(GOLDEN_DIR, `${name}.json`);
    const rel = `fixtures/doctor-golden/doctor/${name}.json`;
    if (UPDATE) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    }
    assert.ok(existsSync(file), `${rel} is missing. Goldens are captured once, before the #730 refactor; see fixtures/doctor-golden/README.md.`);
    const golden = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(record, golden, `Doctor output for ${name} differs from ${rel}. For a #730 refactor change this is a regression: fix the code, do not regenerate. Only a separately reviewed behavior change regenerates, with ${REGEN}, and its diff is read before commit.`);
  });
}

// ---------------------------------------------------------------------------
// Entry-point runners.

const built = (args) => doctorBuiltOutput(args);

// Live campaign refs are not_run/disabled, as with the CLI's --no-live-refs.
// outputBaseDir null is the CLI without --strip-paths (absolute paths, written
// "<fixture>" by normalize()); dirname(packetPath) is --strip-paths, and what
// `start` passes for its generated doctor output.
const packetDoctor = (packetPath, { outputBaseDir = null, ...options } = {}) => doctorPacket(packetPath, {
  outputBaseDir,
  liveCampaign: disabledLiveRead(),
  ...options,
});

function ciDoctor(packetPath) {
  const result = doctorCommand({ _: ["doctor"], packet: packetPath, ci: true }, { liveCampaign: disabledLiveRead() });
  return { result, markdown: formatDoctorCi(result) };
}

// ---------------------------------------------------------------------------
// Synthetic trees.

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeJson(path, value) {
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function page({ title = "Synthetic page", head = "", body = "<p>Synthetic page.</p>" } = {}) {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n${head}</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

// A `doctor --built` target: <dir>/_site/example-campaign/<file> per entry.
function builtTree(t, topic, files) {
  const dir = tempRoot(t, topic);
  for (const [file, content] of Object.entries(files)) writeFile(join(dir, "_site", FIXTURE_SLUG, file), content);
  return dir;
}

// A committed fixture tree copied under a temp root, for a case that has to
// change one file of it.
function fixtureCopy(t, topic, from) {
  const dir = tempRoot(t, topic);
  // cpSync will not copy a directory over a symlink; copy into its target.
  cpSync(from, realpathSync(dir), { recursive: true });
  return dir;
}

const builtCase = (dir) => ({ output: built({ built: dir, slug: FIXTURE_SLUG }), dirs: [dir] });

// Make `path` unreadable for the rest of the case (a real chmod 000, so every
// read API fails as the OS fails it), restored before the temp root goes.
function lockFile(t, path) {
  chmodSync(path, 0o000);
  t.after(() => {
    try {
      chmodSync(path, 0o644);
    } catch {
      // Already removed with its temp root.
    }
  });
}

// A JavaScript file of exactly `bytes` bytes: `statement`, then a line
// comment padding it out.
function scriptOfSize(statement, bytes) {
  const head = `${statement}\n//`;
  assert.ok(bytes > head.length + 1, "setup: script size leaves room for its statement");
  const text = `${head}${"x".repeat(bytes - head.length - 1)}\n`;
  assert.equal(Buffer.byteLength(text, "utf8"), bytes, "setup: script is exactly the requested size");
  return text;
}

const UPSELL_META = '<meta name="next-page-type" content="upsell">\n';
const pageTypeMeta = (type) => `<meta name="next-page-type" content="${type}">\n`;
const UNSCOPED_SELECTOR = '<div data-next-bundle-selector data-next-selector-id="upsell-bundle-1x" style="display:none"></div>';
const EMBEDDED_OFFER = `<main><div data-next-upsell="offer">${UNSCOPED_SELECTOR}</div></main>`;

const UNSCOPED_UPSELL_PAGE = `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <meta name="next-page-type" content="upsell">
  <script src="https://cdn.example.test/campaign-cart@v0.4.18/dist/loader.js"></script>
</head><body>
  <div data-next-bundle-selector data-next-selector-id="upsell-bundle-1x" style="display:none">
    <div role="button" data-next-bundle-card data-next-bundle-id="oto-1x"
         data-next-bundle-items='[{"packageId":33,"quantity":1}]' data-next-selected="true"></div>
  </div>
  <div class="upsell-wrapper" data-next-upsell="offer">
    <div data-next-bundle-selector data-next-upsell-context data-next-selector-id="upsell-bundle"></div>
  </div>
</body></html>
`;
// The same unscoped selector with no next-page-type meta: only a route or a
// CampaignSpec declaration can make it a post-purchase page.
const UNSCOPED_UNTYPED_PAGE = UNSCOPED_UPSELL_PAGE.replace('  <meta name="next-page-type" content="upsell">\n', "");

const PACKET_LOADER = '<script src="https://cdn.example.invalid/campaign-cart@v0.4.18/dist/loader.js"></script>\n';

// One page per examples/ route, each declaring its own type: the "good"
// built site for the examples packet.
const GOOD_PACKET_PAGES = {
  landing: page({ title: "Synthetic landing", head: `${pageTypeMeta("product")}${PACKET_LOADER}`, body: `<main><h1>Synthetic product</h1><a href="/${PACKET_SLUG}/checkout/">Buy now</a></main>` }),
  checkout: page({ title: "Synthetic checkout", head: `${pageTypeMeta("checkout")}${PACKET_LOADER}`, body: '<form data-next-checkout><input data-next-checkout-field="email" type="email"><button data-next-checkout-submit>Pay</button></form>' }),
  upsell: page({ title: "Synthetic upsell", head: `${UPSELL_META}${PACKET_LOADER}`, body: '<div data-next-upsell="offer"><div data-next-bundle-selector data-next-upsell-context data-next-selector-id="upsell-bundle"></div></div>' }),
  receipt: page({ title: "Synthetic receipt", head: `${pageTypeMeta("receipt")}${PACKET_LOADER}`, body: "<main><h1>Thank you</h1></main>" }),
};

// A plain copy of examples/: the packet, its CampaignSpec, source HTML and a
// target page-kit repo with no _site (pre-build).
function examplesCopy(t, topic) {
  const dir = tempRoot(t, topic);
  for (const file of ["build-packet.basic.json", "campaignspec.v42.basic.json"]) cpSync(join(ROOT, "examples", file), join(dir, file));
  cpSync(join(ROOT, "examples", "source-html"), join(dir, "source-html"), { recursive: true });
  cpSync(join(ROOT, "examples", "target-page-kit"), join(dir, "target-page-kit"), { recursive: true });
  return { dir, packetPath: join(dir, "build-packet.basic.json"), specPath: join(dir, "campaignspec.v42.basic.json"), targetRepo: join(dir, "target-page-kit") };
}

// The examples copy prepared the way the upsell checkpoint integration test
// prepares it: commerce catalog beside the packet, a Build Brief file and an
// Assembly Report bound to this packet. The brief is written but not bound
// (the examples packet has no build_brief), so packet goldens pin doctor's
// build_brief.missing warning; brief validation is outside #730's scope. `pages` maps a built route (""
// for the campaign root) to its HTML under _site/runtime-packet-demo/;
// `files` maps any other path under that directory to its content. The
// mutators edit the packet, the CampaignSpec and the Assembly Report before
// they are written.
function preparedPacket(t, topic, { pages = {}, files = {}, waivers = [], mutatePacket = null, mutateSpec = null, mutateReport = null } = {}) {
  const fixture = examplesCopy(t, topic);
  const { dir, packetPath, specPath, targetRepo } = fixture;
  mkdirSync(join(dir, "contracts"), { recursive: true });
  cpSync(join(ROOT, "contracts", "commerce-surface-catalog.json"), join(dir, "contracts", "commerce-surface-catalog.json"));
  const packet = readJson(packetPath);
  packet.assembly.commerce_catalog.path = "contracts/commerce-surface-catalog.json";
  packet.assembly.commerce_catalog.required = false;
  if (mutatePacket) mutatePacket(packet);
  writeJson(packetPath, packet);
  if (mutateSpec) {
    const spec = readJson(specPath);
    mutateSpec(spec);
    writeJson(specPath, spec);
  }
  writeJson(join(targetRepo, ".campaign-runtime/input/campaign-build-brief.normalized.json"), {
    schema_version: "campaigns-os-build-brief/v1",
    status: "complete",
    _meta: { mode: "guided_draft" },
    questions: [],
    gates: [],
    commerce_surfaces: { payment_methods_allowed: ["card"], hidden_payment_methods: [] },
    promo_urgency: { forbid_placeholders: true },
    template_residue_policy: { block_placeholders: true },
  });
  for (const [route, html] of Object.entries(pages)) {
    if (html !== undefined) writeFile(join(targetRepo, "_site", PACKET_SLUG, route, "index.html"), html);
  }
  for (const [file, content] of Object.entries(files)) {
    writeFile(join(targetRepo, "_site", PACKET_SLUG, file), content);
  }
  const report = readJson(join(ROOT, "examples", "assembly-report.example.json"));
  report.identity.map_id = packet.spec.map_id;
  report.identity.public_route_slug = packet.campaign.public_route_slug;
  report.stages.deploy.status = "skipped";
  report.evidence = [];
  if (waivers.length) report.waivers = waivers;
  if (mutateReport) mutateReport(report);
  writeJson(join(targetRepo, ".campaign-runtime/assembly-report.json"), report);
  return fixture;
}

const reportPathOf = (targetRepo) => join(targetRepo, ".campaign-runtime", "assembly-report.json");

// The spec's page with this id, in the first (only) funnel of examples/.
const specPage = (spec, id) => spec.funnels[0].pages.find((entry) => entry.id === id);
const packetPage = (packet, id) => packet.source_html.pages.find((entry) => entry.page_id === id);

// Move one spec page (and its packet source page) to another built route.
function moveRoute(id, route) {
  return {
    mutateSpec: (spec) => { specPage(spec, id).page_url = `${route}/`; },
    mutatePacket: (packet) => {
      const kit = packetPage(packet, id).page_kit;
      kit.public_route = `/${PACKET_SLUG}/${route}/`;
      kit.spec_route = `${route}/`;
    },
  };
}

// ---------------------------------------------------------------------------
// BUILT: doctorBuiltOutput.

// Certified families, read in place exactly as the reachability test reads
// them (fixtures/certified-families is the parent of _site).
const CERTIFIED_FAMILIES = readJson(join(CERTIFIED_ROOT, "manifest.json")).families;
for (const family of CERTIFIED_FAMILIES) {
  goldenCase("built", `certified-${family}`, `certified family ${family} rendered fixture, read in place with --family ${family}`, () => ({
    output: built({ built: CERTIFIED_ROOT, slug: family, family }),
  }));
}

// Initial / pre-build.
goldenCase("built", "prebuild-missing-dir", "pre-build: the built directory does not exist (built_site.target early return)", (t) => {
  const dir = tempRoot(t, "missing");
  return { output: built({ built: join(dir, "absent") }), dirs: [dir] };
});

goldenCase("built", "prebuild-empty-site", "pre-build: _site exists with no campaign directory (built_site.scope early return)", (t) => {
  const dir = tempRoot(t, "empty-site");
  mkdirSync(join(dir, "_site"), { recursive: true });
  return { output: built({ built: dir }), dirs: [dir] };
});

// Every committed doctor fixture tree, read in place.
const subdirs = (root) => readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

goldenCase("built", "failing-script-syntax-bad", "failing: fixtures/script-syntax/bad, one campaign script does not parse (blocked, not waivable)", () => ({
  output: built({ built: join(ROOT, "fixtures", "script-syntax", "bad"), slug: FIXTURE_SLUG }),
}));

goldenCase("built", "good-script-syntax", "clean: fixtures/script-syntax/good, a classic and a module script that both parse (gate pass)", () => ({
  output: built({ built: join(ROOT, "fixtures", "script-syntax", "good"), slug: FIXTURE_SLUG }),
}));

// fixtures/sdk-markup/README.md: these four shapes warn, the other five block.
const SDK_MARKUP_ADVISORY_SHAPES = new Set(["double-selected", "page-type-attribute", "template-double-brace", "upsell-page-type-missing"]);
const sdkMarkupGate = (output) => output.derived.checkpoint_gates.find((gate) => gate.id === "built_output.sdk_markup");
for (const shape of subdirs(SDK_MARKUP_ROOT)) {
  const advisory = SDK_MARKUP_ADVISORY_SHAPES.has(shape);
  goldenCase("built", `${advisory ? "advisory" : "failing"}-sdk-markup-${shape}`, `${advisory ? "advisory: the sdk_markup gate passes with one warned shape" : "failing: the sdk_markup gate blocks"}, fixtures/sdk-markup/${shape}/bad`, () => {
    const output = built({ built: join(SDK_MARKUP_ROOT, shape, "bad"), slug: FIXTURE_SLUG });
    const gate = sdkMarkupGate(output);
    assert.equal(gate.status, advisory ? "pass" : "blocked", `setup: the ${shape} label matches the gate`);
    if (advisory) assert.ok(gate.warned.length > 0, `setup: ${shape} warns`);
    return { output };
  });
  goldenCase("built", `good-sdk-markup-${shape}`, `clean: fixtures/sdk-markup/${shape}/good, the accepted form of the shape`, () => ({
    output: built({ built: join(SDK_MARKUP_ROOT, shape, "good"), slug: FIXTURE_SLUG }),
  }));
}

for (const variant of ["clean", "key-drift", "attribution-drift"]) {
  goldenCase("built", `${variant === "clean" ? "good" : "failing"}-campaign-identity-${variant}`, `${variant === "clean" ? "clean" : "failing"}: fixtures/campaign-identity/${variant}`, () => ({
    output: built({ built: join(ROOT, "fixtures", "campaign-identity", variant), slug: FIXTURE_SLUG }),
  }));
}

goldenCase("built", "failing-upsell-selector-scope", "failing: fixtures/upsell-selector-scope (#270), an unscoped selector on a built upsell page", () => ({
  output: built({ built: join(ROOT, "fixtures", "upsell-selector-scope"), slug: FIXTURE_SLUG }),
}));

// Every fixtures/cart-placeholders case: b* warn (live tokens), i* review or
// read unexercised (unknown brace, unresolved template selector, pins), w*
// are the false-positive guards that pass.
for (const fixture of subdirs(CART_PLACEHOLDERS_ROOT)) {
  for (const variant of ["bad", "good"]) {
    const tree = join(CART_PLACEHOLDERS_ROOT, fixture, variant);
    if (!existsSync(tree)) continue;
    goldenCase("built", `cart-placeholders-${fixture}-${variant}`, `fixtures/cart-placeholders/${fixture}/${variant}, read in place`, () => ({
      output: built({ built: tree, slug: FIXTURE_SLUG }),
    }));
  }
}

// Blocked gates that also carry advisories: the advisories stay on the gate's
// warned[] and off warnings[] while the gate blocks.
goldenCase("built", "failing-script-syntax-with-missing-script", "failing: fixtures/script-syntax/bad plus a missing local script on the same page (blocked, warned[] not empty)", (t) => {
  const dir = fixtureCopy(t, "syntax-missing", join(ROOT, "fixtures", "script-syntax", "bad"));
  const checkout = join(dir, "_site", FIXTURE_SLUG, "checkout", "index.html");
  writeFileSync(checkout, readFileSync(checkout, "utf8").replace("</head>", '  <script src="../js/missing.js"></script>\n  </head>'));
  const output = built({ built: dir, slug: FIXTURE_SLUG });
  const gate = output.derived.checkpoint_gates.find((entry) => entry.id === "built_output.script_syntax");
  assert.equal(gate.status, "blocked", "setup: the syntax error blocks");
  assert.ok(gate.warned.length > 0, "setup: the missing script is warned on the blocked gate");
  return { output, dirs: [dir] };
});

goldenCase("built", "failing-sdk-markup-blocker-with-advisory", "failing: a checkout-not-form blocker and a double-selected advisory on one page (blocked, warned[] not empty)", (t) => {
  const dir = builtTree(t, "sdk-blocker-advisory", {
    "checkout/index.html": page({
      title: "Synthetic blocker with advisory",
      head: `<meta name="next-funnel" content="Example">\n${pageTypeMeta("checkout")}`,
      body: [
        '<div data-next-bundle-selector data-next-selector-id="main">',
        '  <div data-next-bundle-card data-next-bundle-id="one" data-next-selected="true">One</div>',
        '  <div data-next-bundle-card data-next-bundle-id="two" data-next-selected="true">Two</div>',
        "</div>",
        '<div data-next-checkout><input data-next-checkout-field="email" type="email"><button data-next-checkout-submit>Pay</button></div>',
      ].join("\n"),
    }),
  });
  const output = built({ built: dir, slug: FIXTURE_SLUG });
  const gate = sdkMarkupGate(output);
  assert.equal(gate.status, "blocked", "setup: checkout-not-form blocks");
  assert.ok(gate.warned.length > 0, "setup: double-selected is warned on the blocked gate");
  return { output, dirs: [dir] };
});

// Smoke QC anchor outcomes, review rows beside warning rows on one page.
goldenCase("built", "smoke-anchor-outcomes", "smoke QC: anchors missing (warning), in a <template> (review), named only by a local script (review) and resolved (pass), beside the page's og/favicon warnings", (t) => {
  const dir = builtTree(t, "anchors", {
    "index.html": page({
      head: '<script src="js/app.js"></script>\n',
      body: [
        '<a href="#gone">Gone</a>',
        '<a href="#later">Later</a>',
        '<a href="#kept">Kept</a>',
        '<template><div id="kept"></div></template>',
        '<a href="#here">Here</a>',
        '<div id="here"></div>',
      ].join("\n"),
    }),
    "js/app.js": "document.body.insertAdjacentHTML(\"beforeend\", '<div id=\"later\"></div>');\n",
  });
  return builtCase(dir);
});

// Partial / unreadable.
goldenCase("built", "partial-dangling-symlink-page", "partial: one built page is a dangling symlink beside a readable page", (t) => {
  const dir = builtTree(t, "dangling", { "index.html": page() });
  symlinkSync("missing-synthetic-page.html", join(dir, "_site", FIXTURE_SLUG, "broken.html"));
  return builtCase(dir);
});

goldenCase("built", "partial-missing-script", "partial: a page loads a local script whose file is missing, beside an in-page anchor the missing script might create", (t) => {
  const dir = builtTree(t, "missing-script", {
    "index.html": page({ head: '<script src="js/missing.js"></script>\n', body: '<a href="#features">Features</a>\n<p>Synthetic page.</p>' }),
  });
  return builtCase(dir);
});

goldenCase("built", "partial-too-deep-page", "partial: one built page nests 600 elements deep, past the bounded parser's depth limit, beside a readable page", (t) => {
  const deep = `${"<div>".repeat(600)}Synthetic deep page.${"</div>".repeat(600)}`;
  return builtCase(builtTree(t, "too-deep", { "index.html": page(), "deep.html": page({ title: "Deep page", body: deep }) }));
});

goldenCase("built", "partial-unreadable-page", "partial: one built page exists but is chmod 000 (every read fails with EACCES)", (t) => {
  const dir = builtTree(t, "unreadable", { "index.html": page(), "locked.html": page({ title: "Locked page" }) });
  lockFile(t, join(dir, "_site", FIXTURE_SLUG, "locked.html"));
  let output;
  try {
    output = built({ built: dir, slug: FIXTURE_SLUG });
  } catch (error) {
    // At base the read failure escapes doctorBuiltOutput; pin that too.
    output = { thrown: { name: error.name, code: error.code ?? null, message: error.message } };
  }
  return { output, dirs: [dir] };
}, { skip: RUNS_AS_ROOT && "root reads a chmod 000 file" });

goldenCase("built", "partial-unreadable-script", "partial: a page loads a local script that is chmod 000, beside an in-page anchor", (t) => {
  const dir = builtTree(t, "unreadable-script", {
    "index.html": page({ head: '<script src="js/locked.js"></script>\n', body: '<a href="#features">Features</a>\n<p>Synthetic page.</p>' }),
    "js/locked.js": "window.syntheticLocked = true;\n",
  });
  lockFile(t, join(dir, "_site", FIXTURE_SLUG, "js", "locked.js"));
  let output;
  try {
    output = built({ built: dir, slug: FIXTURE_SLUG });
  } catch (error) {
    output = { thrown: { name: error.name, code: error.code ?? null, message: error.message } };
  }
  return { output, dirs: [dir] };
}, { skip: RUNS_AS_ROOT && "root reads a chmod 000 file" });

// Capped (QC limits: 500 pages, 16 scripts and 1 MiB per script, 5 MiB per
// page, 2,000 candidates and 50 results per page). Each per-page cap case
// puts one page exactly at the cap beside one page just past it, so moving a
// cap by one in either direction changes the output.
goldenCase("built", "capped-page-count", "capped: 501 built pages, the 501st past the QC page cap", (t) => {
  const files = {};
  for (let index = 0; index < 501; index += 1) {
    const name = `p${String(index).padStart(3, "0")}.html`;
    files[name] = page({ body: `<p>Synthetic page ${name}.</p>` });
  }
  return builtCase(builtTree(t, "page-cap", files));
}, {
  // ~4,000 QC rows and ~2,000 warnings: kept in full for the first page, the
  // last page under the cap and the capped page, plus anything page-free.
  compact: {
    paths: [["warnings"], ["derived", "qc_results"]],
    keep: (entry) => (JSON.stringify(entry).match(/p\d{3}\.html/g) || []).every((name) => ["p000.html", "p499.html", "p500.html"].includes(name)),
  },
});

goldenCase("built", "capped-script-count", "capped: an anchor on a page that loads 17 local scripts; only the 17th would supply the id", (t) => {
  const scripts = Array.from({ length: 17 }, (_, index) => `js/s${String(index + 1).padStart(2, "0")}.js`);
  const files = {
    "index.html": page({ head: scripts.map((src) => `<script src="${src}"></script>\n`).join(""), body: '<a href="#features">Features</a>\n<p>Synthetic page.</p>' }),
  };
  for (const [index, src] of scripts.entries()) {
    files[src] = index < 16
      ? `window.syntheticScript${index + 1} = true;\n`
      : "document.body.insertAdjacentHTML(\"beforeend\", '<section id=\"features\"></section>');\n";
  }
  return builtCase(builtTree(t, "script-count", files));
});

goldenCase("built", "capped-script-bytes", "capped: one page's local script is exactly 1 MiB (read: review), another page's is 1 MiB + 1 byte (script_unreadable)", (t) => {
  const statement = (id) => `document.body.insertAdjacentHTML("beforeend", '<div id="${id}"></div>');`;
  return builtCase(builtTree(t, "script-bytes", {
    "at-cap.html": page({ head: '<script src="js/at-cap.js"></script>\n', body: '<a href="#later-a">Later</a>' }),
    "over-cap.html": page({ head: '<script src="js/over-cap.js"></script>\n', body: '<a href="#later-b">Later</a>' }),
    "js/at-cap.js": scriptOfSize(statement("later-a"), MiB),
    "js/over-cap.js": scriptOfSize(statement("later-b"), MiB + 1),
  }));
});

goldenCase("built", "capped-page-size", "capped: one 6 MiB built page, past the 5 MiB QC page cap", (t) => {
  const filler = "<p>Synthetic filler line for the page size cap.</p>\n";
  return builtCase(builtTree(t, "page-size", { "index.html": page({ body: filler.repeat(Math.ceil((6 * MiB) / filler.length)) }) }));
});

// Smoke QC result cap: 50 anchor results on one page are all kept; 51 cap
// the page, which keeps the warnings among its first 50 (the missing #gone-b)
// and drops the 51st (#gone-c).
goldenCase("built", "capped-smoke-findings", "capped: a page with 50 anchors (no cap) and a page with 51 (finding_cap_reached, earlier findings retained)", (t) => {
  const resolved = (prefix, count) => Array.from({ length: count }, (_, index) => `<a href="#${prefix}-${index + 1}">Go</a><span id="${prefix}-${index + 1}"></span>`);
  return builtCase(builtTree(t, "smoke-findings", {
    "at-cap.html": page({ body: ['<a href="#gone-a">Gone</a>', ...resolved("a", 49)].join("\n") }),
    "over-cap.html": page({ body: ['<a href="#gone-b">Gone</a>', ...resolved("b", 49), '<a href="#gone-c">Gone</a>'].join("\n") }),
  }));
});

// Smoke QC candidate cap: <meta charset>, one anchor, one primary-asset-host
// image and N relative images. 2,000 candidates are all examined; 2,001 cap
// the page, which keeps the anchor and asset-host warnings seen before it.
goldenCase("built", "capped-smoke-candidates", "capped: a page with exactly 2,000 smoke candidates (no cap) and one with 2,001 (candidate_cap_reached, earlier findings retained)", (t) => {
  const body = (fillers) => [
    '<a href="#gone">Gone</a>',
    '<img src="https://cdn.29next.store/static/synthetic.png" alt="">',
    ...Array.from({ length: fillers }, (_, index) => `<img src="img/f${index + 1}.png" alt="">`),
  ].join("\n");
  return builtCase(builtTree(t, "smoke-candidates", {
    "at-cap.html": page({ body: body(1997) }),
    "over-cap.html": page({ body: body(1998) }),
  }));
});

const CART_LOADER = '<script src="https://cdn.example.invalid/campaign-cart@v0.4.40/dist/loader.js"></script>\n';

// Cart placeholder result cap: 50 distinct live tokens are 50 results; a 51st
// caps the page, which keeps the first 50.
goldenCase("built", "capped-cart-findings", "capped: a page with 50 distinct live cart tokens (no cap) and one with 51 (finding_cap_reached, first 50 retained)", (t) => {
  const tokens = (count) => Array.from({ length: count }, (_, index) => `<p class="cart-line">{item.f${index + 1}}</p>`).join("\n");
  return builtCase(builtTree(t, "cart-findings", {
    "at-cap.html": page({ head: CART_LOADER, body: tokens(50) }),
    "over-cap.html": page({ head: CART_LOADER, body: tokens(51) }),
  }));
});

// Cart placeholder candidate cap: one live token, then template-only brace
// candidates. 2,000 candidates are all examined; 2,001 cap the page, which
// keeps the live token seen first.
goldenCase("built", "capped-cart-candidates", "capped: a page with exactly 2,000 cart candidates (no cap) and one with 2,001 (candidate_cap_reached, the earlier live token retained)", (t) => {
  const body = (templated) => `<p class="cart-line">{item.name}</p>\n<template>${Array.from({ length: templated }, (_, index) => `<span>{item.c${index + 1}}</span>`).join("")}</template>`;
  return builtCase(builtTree(t, "cart-candidates", {
    "at-cap.html": page({ head: CART_LOADER, body: body(1999) }),
    "over-cap.html": page({ head: CART_LOADER, body: body(2000) }),
  }));
});

// Conflicting role: route inference vs live page-type metadata (#529).
const ROLE_CASES = [
  ["checkout-oto-route-checkout-meta", "checkout-oto-1", pageTypeMeta("checkout"), "an offer-sounding route whose page says checkout yields to the meta (not_applicable)"],
  ["checkout-oto-route-blank-then-checkout-meta", "checkout-oto-1", `<meta name="next-page-type" content="">\n${pageTypeMeta("checkout")}`, "an offer-sounding route whose first next-page-type meta is blank and second says checkout"],
  ["upsell-route-checkout-meta", "upsell-1", pageTypeMeta("checkout"), "an explicit upsell route keeps its role over a copied checkout meta (blocked)"],
  ["oto-route-product-meta", "oto-1", pageTypeMeta("product"), "an oto route yields only to checkout; a product meta leaves it in the gate (blocked)"],
  ["upsell-route-commented-checkout-meta", "upsell-1", `<!-- ${pageTypeMeta("checkout").trim()} -->\n`, "a checkout meta inside a comment is not read (blocked)"],
  ["upsell-route-conflicting-metas", "upsell-1", `${pageTypeMeta("checkout")}${pageTypeMeta("receipt")}`, "two different next-page-type metas on an upsell route (blocked)"],
  ["generic-route-upsell-meta", "special-offer", UPSELL_META, "a route that infers nothing takes its role from an upsell meta (blocked)"],
  ["generic-route-commented-upsell-meta", "special-offer", `<!-- ${UPSELL_META.trim()} -->\n`, "a route that infers nothing, with only a commented-out upsell meta (mentioned metadata)"],
];
for (const [id, route, head, description] of ROLE_CASES) {
  goldenCase("built", `role-${id}`, `conflicting role: ${description}`, (t) => {
    const dir = tempRoot(t, "role");
    writeFile(join(dir, "_site", FIXTURE_SLUG, route, "index.html"), `<html><head>${head}</head><body>${EMBEDDED_OFFER}</body></html>`);
    return builtCase(dir);
  });
}

// ---------------------------------------------------------------------------
// PACKET: doctorPacket, live refs disabled.

goldenCase("packet", "examples-prebuild", "pre-build: a plain copy of examples/ (no _site, no Assembly Report)", (t) => {
  const { dir, packetPath } = examplesCopy(t, "packet-prebuild");
  return { output: packetDoctor(packetPath), dirs: [dir] };
});

goldenCase("packet", "examples-good-built", "the prepared examples packet with a clean four-page built site", (t) => {
  const { dir, packetPath } = preparedPacket(t, "packet-good", { pages: GOOD_PACKET_PAGES });
  return { output: packetDoctor(packetPath), dirs: [dir] };
});

function scriptSyntaxPacket(t, topic, options = {}) {
  const fixture = preparedPacket(t, topic, options);
  const siteRoot = join(fixture.targetRepo, "_site", PACKET_SLUG);
  cpSync(join(ROOT, "fixtures", "script-syntax", "bad", "_site", FIXTURE_SLUG), siteRoot, { recursive: true });
  const checkout = join(siteRoot, "checkout", "index.html");
  writeFileSync(checkout, readFileSync(checkout, "utf8").replaceAll(`/${FIXTURE_SLUG}/`, `/${PACKET_SLUG}/`));
  return fixture;
}

goldenCase("packet", "failing-script-syntax", "failing: fixtures/script-syntax/bad copied under the packet's route (blocked)", (t) => {
  const { dir, packetPath } = scriptSyntaxPacket(t, "packet-syntax");
  return { output: packetDoctor(packetPath), dirs: [dir] };
});

const ROLE_BLOCKED_PAGES = {
  upsell: UNSCOPED_UPSELL_PAGE,
  "upsell-1": `<html><head>${pageTypeMeta("checkout")}</head><body><div data-next-upsell="offer"><div data-next-bundle-selector data-next-selector-id="copied-meta"></div></div></body></html>`,
};

goldenCase("packet", "role-upsell-blocked", "conflicting role: an unscoped upsell selector plus an upsell route carrying a copied checkout meta (blocked, waivable)", (t) => {
  const { dir, packetPath } = preparedPacket(t, "packet-role", { pages: ROLE_BLOCKED_PAGES });
  return { output: packetDoctor(packetPath), dirs: [dir] };
});

// outputBaseDir = the packet directory: doctor --strip-paths, and what
// `start` writes. See stripRootEscape for the one extra normalization.
goldenCase("packet", "strip-paths-failing-script-syntax", "outputBaseDir (--strip-paths): the failing-script-syntax packet with every path relativized to the packet directory", (t) => {
  const { dir, packetPath } = scriptSyntaxPacket(t, "packet-strip-syntax");
  return { output: packetDoctor(packetPath, { outputBaseDir: dirname(packetPath) }), dirs: [dir], baseDir: dirname(packetPath) };
});

// The explicit --context names a Build Context that is not there, in a
// directory no derived path covers, so only the sidecar-argument rebasing
// (not the whole-output relativizer) keeps it relative in `next.command`.
goldenCase("packet", "strip-paths-role-upsell-blocked", "outputBaseDir (--strip-paths) with an explicit --report and --context: the role-upsell-blocked packet, sidecar arguments rebased too", (t) => {
  const { dir, packetPath, targetRepo } = preparedPacket(t, "packet-strip-role", { pages: ROLE_BLOCKED_PAGES });
  const output = packetDoctor(packetPath, {
    outputBaseDir: dirname(packetPath),
    reportPath: reportPathOf(targetRepo),
    contextPath: join(dir, "sidecars", "build-context.json"),
  });
  return { output, dirs: [dir], baseDir: dirname(packetPath) };
});

// The record `checkpoint waive` writes for the UNSCOPED_UPSELL_PAGE state,
// with literal timestamps around FROZEN_NOW: waived_at < now < expires_at.
const UPSELL_WAIVER = {
  scope: "built_output.upsell_selector_scope",
  subject: { public_route_slug: PACKET_SLUG, site_root: `./_site/${PACKET_SLUG}` },
  state_fingerprint: "sha256:853fe83c53c536ed745e56c53595fa1c3e41f27a9a714cdf7dfe9de72e0f5b79",
  reason: "Synthetic legacy offer page reuses the cart selector.",
  waived_by: "Jordan Lee",
  waived_at: "2025-12-01T00:00:00.000Z",
  expires_at: "2026-06-01T00:00:00.000Z",
  review_condition: "The offer page is rebuilt from the current template.",
};
const upsellGate = (output) => output.derived.checkpoint_gates.find((entry) => entry.id === UPSELL_WAIVER.scope);

goldenCase("packet", "waived-upsell-selector-scope", "waived: the unscoped upsell selector under a literal, unexpired checkpoint waiver", (t) => {
  const { dir, packetPath } = preparedPacket(t, "packet-waived", { pages: { upsell: UNSCOPED_UPSELL_PAGE }, waivers: [UPSELL_WAIVER] });
  const output = packetDoctor(packetPath);
  assert.equal(upsellGate(output)?.status, "waived", "setup: the literal waiver record still matches the gate state it was written for");
  return { output, dirs: [dir] };
});

goldenCase("packet", "waiver-expired", "waived, inert: the same waiver with expires_at equal to the frozen clock (expired at the boundary; the gate blocks)", (t) => {
  const waiver = { ...UPSELL_WAIVER, expires_at: FROZEN_NOW };
  const { dir, packetPath } = preparedPacket(t, "packet-waiver-expired", { pages: { upsell: UNSCOPED_UPSELL_PAGE }, waivers: [waiver] });
  const output = packetDoctor(packetPath);
  assert.equal(upsellGate(output)?.status, "blocked", "setup: a waiver expiring exactly now no longer satisfies the gate");
  return { output, dirs: [dir] };
});

goldenCase("packet", "waiver-stale", "waived, inert: the same unexpired waiver after the page gained a second unscoped selector (stale state fingerprint; the gate blocks)", (t) => {
  const edited = UNSCOPED_UPSELL_PAGE.replace("</body>", '  <div data-next-bundle-selector data-next-selector-id="upsell-bundle-2x" style="display:none"></div>\n</body>');
  const { dir, packetPath } = preparedPacket(t, "packet-waiver-stale", { pages: { upsell: edited }, waivers: [UPSELL_WAIVER] });
  const output = packetDoctor(packetPath);
  assert.equal(upsellGate(output)?.status, "blocked", "setup: a waiver for the earlier page state no longer satisfies the gate");
  return { output, dirs: [dir] };
});

goldenCase("packet", "waiver-foreign", "waived, inert: the same unexpired waiver recorded for another route slug (foreign subject; the gate blocks)", (t) => {
  const waiver = { ...UPSELL_WAIVER, subject: { public_route_slug: "another-synthetic-route", site_root: "./_site/another-synthetic-route" } };
  const { dir, packetPath } = preparedPacket(t, "packet-waiver-foreign", { pages: { upsell: UNSCOPED_UPSELL_PAGE }, waivers: [waiver] });
  const output = packetDoctor(packetPath);
  assert.equal(upsellGate(output)?.status, "blocked", "setup: a waiver for another subject does not satisfy the gate");
  return { output, dirs: [dir] };
});

goldenCase("packet", "failing-cart-placeholders-b4", "failing: the cart-placeholders b4 page as the packet's landing route beside plain pages (sdk_markup blocker plus QC warnings)", (t) => {
  const plain = (route) => page({ title: `Synthetic ${route}`, head: `${pageTypeMeta(route)}${PACKET_LOADER}`, body: `<p class="cart-line">Synthetic ${route} page.</p>` });
  const b4 = readFileSync(join(CART_PLACEHOLDERS_ROOT, "b4-live-tokens-with-sdk-markup-blocker", "bad", "_site", FIXTURE_SLUG, "index.html"), "utf8");
  const { dir, packetPath } = preparedPacket(t, "packet-b4", {
    pages: { landing: b4, checkout: plain("checkout"), upsell: plain("upsell"), receipt: plain("receipt") },
  });
  return { output: packetDoctor(packetPath), dirs: [dir] };
});

goldenCase("packet", "capped-page-size", "capped: the good built site with a 6 MiB landing page (QC page cap; past the html-scan retention budget)", (t) => {
  const filler = "<p>Synthetic filler line for the page size cap.</p>\n";
  const landing = page({ title: "Synthetic landing", head: `${pageTypeMeta("product")}${PACKET_LOADER}`, body: filler.repeat(Math.ceil((6 * MiB) / filler.length)) });
  const { dir, packetPath } = preparedPacket(t, "packet-capped", { pages: { ...GOOD_PACKET_PAGES, landing } });
  return { output: packetDoctor(packetPath), dirs: [dir] };
});

goldenCase("packet", "partial-dangling-symlink-page", "partial: the good built site plus an extra route whose index.html is a dangling symlink", (t) => {
  const { dir, packetPath, targetRepo } = preparedPacket(t, "packet-dangling", { pages: GOOD_PACKET_PAGES });
  mkdirSync(join(targetRepo, "_site", PACKET_SLUG, "upsell-2"), { recursive: true });
  symlinkSync("missing-synthetic-page.html", join(targetRepo, "_site", PACKET_SLUG, "upsell-2", "index.html"));
  return { output: packetDoctor(packetPath), dirs: [dir] };
});

// Smoke QC on a packet: the build environment comes from the Assembly
// Report's stages.assembly.evidence.build_environment and the deploy base
// from the packet. Landing: Tailwind CDN, a loopback image, a root-relative
// og:image whose file exists. Checkout: the primary NEXT asset host and a
// relative og:image with no file. Upsell and receipt: absolute og:image under
// the deploy base, file present and missing.
const DEPLOY_BASE = `https://deploy.example.test/${PACKET_SLUG}/`;
const OG_TEXT = '<meta property="og:title" content="Synthetic"><meta property="og:description" content="Synthetic page.">\n<link rel="icon" href="favicon.ico">\n';
const og = (content) => `<meta property="og:image" content="${content}">\n`;
const SMOKE_PACKET_PAGES = {
  landing: page({ title: "Synthetic landing", head: `${pageTypeMeta("product")}${PACKET_LOADER}${OG_TEXT}${og(`/${PACKET_SLUG}/og.png`)}<script src="https://cdn.tailwindcss.com"></script>\n`, body: '<main><img src="http://localhost:8080/hero.png" alt=""></main>' }),
  checkout: page({ title: "Synthetic checkout", head: `${pageTypeMeta("checkout")}${PACKET_LOADER}${OG_TEXT}${og("img/missing.png")}`, body: '<form data-next-checkout><img src="https://cdn.29next.store/static/badge.png" alt=""><input data-next-checkout-field="email" type="email"><button data-next-checkout-submit>Pay</button></form>' }),
  upsell: page({ title: "Synthetic upsell", head: `${UPSELL_META}${PACKET_LOADER}${OG_TEXT}${og(`${DEPLOY_BASE}og.png`)}`, body: '<div data-next-upsell="offer"><div data-next-bundle-selector data-next-upsell-context data-next-selector-id="upsell-bundle"></div></div>' }),
  receipt: page({ title: "Synthetic receipt", head: `${pageTypeMeta("receipt")}${PACKET_LOADER}${OG_TEXT}${og(`${DEPLOY_BASE}missing.png`)}`, body: "<main><h1>Thank you</h1></main>" }),
};
const SMOKE_PACKET_FILES = { "og.png": "synthetic image bytes\n", "favicon.ico": "synthetic icon bytes\n" };

for (const environment of ["production", "development"]) {
  goldenCase("packet", `smoke-${environment}`, `smoke QC: a recorded ${environment} build with Tailwind CDN, loopback, primary asset host and og:image relative/absolute, present/missing`, (t) => {
    const { dir, packetPath } = preparedPacket(t, `packet-smoke-${environment}`, {
      pages: SMOKE_PACKET_PAGES,
      files: SMOKE_PACKET_FILES,
      mutatePacket: (packet) => { packet.deploy.production_url = DEPLOY_BASE; },
      mutateReport: (report) => { report.stages.assembly.evidence = { build_environment: environment }; },
    });
    return { output: packetDoctor(packetPath), dirs: [dir] };
  });
}

// Content residue runs only once stages.assembly is completed. The marker
// sits on one page only: the residue walker reads directories unsorted, so a
// finding on two pages could come back in either order.
goldenCase("packet", "residue-assembly-complete-clean", "content residue: assembly completed, the good built site carries no residue", (t) => {
  const { dir, packetPath } = preparedPacket(t, "packet-residue-clean", {
    pages: GOOD_PACKET_PAGES,
    mutateReport: (report) => { report.stages.assembly.status = "completed"; },
  });
  return { output: packetDoctor(packetPath), dirs: [dir] };
});

goldenCase("packet", "residue-assembly-complete-marker", "content residue: assembly completed, the receipt page carries a needs-merchant-input marker and a demo residue term", (t) => {
  const receipt = page({ title: "Synthetic receipt", head: `${pageTypeMeta("receipt")}${PACKET_LOADER}`, body: "<main><h1>Thank you</h1><p>NEEDS MERCHANT INPUT: support hours</p><p>Sarah Mitchell</p></main>" });
  const { dir, packetPath } = preparedPacket(t, "packet-residue-marker", {
    pages: { ...GOOD_PACKET_PAGES, receipt },
    mutateReport: (report) => { report.stages.assembly.status = "completed"; },
  });
  return { output: packetDoctor(packetPath), dirs: [dir] };
});

// Live campaign refs read every built page except build noise: the route's
// 404.html and anything under a "_" or "." directory. derived.live_campaign_refs
// .checked_pages counts the four spec pages plus the off-spec extra-offer page.
goldenCase("packet", "live-refs-build-noise", "live refs: the good built site plus 404.html, _drafts/x/index.html and an off-spec extra-offer page (noise excluded from checked_pages)", (t) => {
  const { dir, packetPath } = preparedPacket(t, "packet-live-noise", {
    pages: { ...GOOD_PACKET_PAGES, "extra-offer": page({ title: "Synthetic extra offer", head: `${pageTypeMeta("product")}${PACKET_LOADER}` }), "_drafts/x": page({ title: "Synthetic draft" }) },
    files: { "404.html": page({ title: "Synthetic not found" }) },
  });
  return { output: packetDoctor(packetPath), dirs: [dir] };
});

// Spec-declared roles: the CampaignSpec's page type decides the upsell gate
// only when it is a post-purchase type.
goldenCase("packet", "role-spec-declared-upsell-generic-route", "conflicting role: the spec declares the upsell page at special-offer/, a route that infers nothing, with no meta and an unscoped selector (blocked by the declaration)", (t) => {
  const { dir, packetPath } = preparedPacket(t, "packet-declared-upsell", {
    pages: { ...GOOD_PACKET_PAGES, upsell: undefined, "special-offer": UNSCOPED_UNTYPED_PAGE },
    ...moveRoute("upsell", "special-offer"),
  });
  return { output: packetDoctor(packetPath), dirs: [dir] };
});

goldenCase("packet", "role-spec-declared-checkout-oto-route", "conflicting role: the spec declares the checkout page at checkout-oto/ with no meta and an unscoped selector (a checkout declaration does not override the route)", (t) => {
  const { dir, packetPath } = preparedPacket(t, "packet-declared-checkout", {
    pages: { ...GOOD_PACKET_PAGES, checkout: undefined, "checkout-oto": UNSCOPED_UNTYPED_PAGE },
    ...moveRoute("checkout", "checkout-oto"),
  });
  return { output: packetDoctor(packetPath), dirs: [dir] };
});

// The Assembly Report record `record build` kept for GOOD_PACKET_PAGES at
// base, written literally so the recorded side does not move with the
// implementation.
const GOOD_RECORDED_BUILD = {
  build_fingerprint: "sha256:c44f8b7e7488fd160a0ec178496a3fa5951432a070410fbd39062f28cca3bf7f",
  build_manifest: [
    { path: "checkout/index.html", sha256: "1126e4256164b700fb2761cb85d9f6d17880b0b72ed23b83bdf2cef7ad6c7878" },
    { path: "landing/index.html", sha256: "802b90dadde321f1a3b36aba813f82693bee7a3a6c0529afebf13b3773a2181b" },
    { path: "receipt/index.html", sha256: "4e928aeed861a8467577e145b7dc8cf5c7a7ba8781d700cf79e881db72ccced5" },
    { path: "upsell/index.html", sha256: "dac997c0c3f2934cd2135c50ccfea5570786d135aaef709ced8608c6e7ed71a8" },
  ],
};

goldenCase("packet", "fingerprint-current", "build fingerprint: the recorded build_fingerprint and manifest match the good built site (pass)", (t) => {
  const { dir, packetPath } = preparedPacket(t, "packet-fingerprint-current", {
    pages: GOOD_PACKET_PAGES,
    mutateReport: (report) => Object.assign(report.stages.assembly, structuredClone(GOOD_RECORDED_BUILD)),
  });
  const output = packetDoctor(packetPath);
  assert.equal(output.derived.build_output_fingerprint?.status, "pass", "setup: the literal record matches the good built site");
  return { output, dirs: [dir] };
});

goldenCase("packet", "fingerprint-stale", "build fingerprint: assembly completed, one page edited and 21 files added after the recorded build (stale, drift path lists capped at 20)", (t) => {
  const files = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`assets/extra-${String(index + 1).padStart(2, "0")}.txt`, `synthetic asset ${index + 1}\n`]));
  const { dir, packetPath } = preparedPacket(t, "packet-fingerprint-stale", {
    pages: { ...GOOD_PACKET_PAGES, receipt: GOOD_PACKET_PAGES.receipt.replace("Thank you", "Thank you again") },
    files,
    mutateReport: (report) => {
      Object.assign(report.stages.assembly, structuredClone(GOOD_RECORDED_BUILD));
      report.stages.assembly.status = "completed";
    },
  });
  const output = packetDoctor(packetPath);
  assert.equal(output.derived.build_output_fingerprint?.status, "stale", "setup: the output moved after the literal record");
  return { output, dirs: [dir] };
});

// A packet that declares a Design Source Package with no Build Context to
// bind it: the next-step picker refuses to bypass prepare-build.
goldenCase("packet", "design-source-unbound", "the good built site under a packet that declares a Design Source Package, with no Build Context binding it (next refuses to bypass prepare-build)", (t) => {
  const { dir, packetPath } = preparedPacket(t, "packet-unbound", {
    pages: GOOD_PACKET_PAGES,
    mutatePacket: (packet) => { packet.design_source_package = {}; },
  });
  const output = packetDoctor(packetPath);
  assert.match(String(output.next?.reason), /refusing to bypass prepare-build/, "setup: the picker refuses the unbound sidecars");
  return { output, dirs: [dir] };
});

const PRIOR_RUN_ID = "run_1757000000000_aaaaaaaa";
const priorRunRecord = (mapId, doctor) => ({
  schema_version: "campaigns-os-run-record/v0",
  run_id: PRIOR_RUN_ID,
  identity: { map_id: mapId },
  artifacts: [],
  observations: { doctor },
});

goldenCase("packet", "cause-prior-run", "causes: contracts/fixtures/sidecar-bundle/production-shaped with a prior Run Record, so cause, cause_reason and cause_summary compare against it", (t) => {
  const dir = tempRoot(t, "packet-cause");
  cpSync(join(ROOT, "contracts", "fixtures", "sidecar-bundle", "production-shaped"), realpathSync(dir), { recursive: true });
  writeJson(join(dir, ".campaign-runtime", "run-records", `${PRIOR_RUN_ID}.json`), priorRunRecord("runtime-packet-demo-k9x2", {
    status: "blocked", error_codes: ["source_html.root"], warning_codes: [], ready_count: 0,
  }));
  const output = packetDoctor(join(dir, "campaign-runtime.build.json"));
  assert.equal(output.cause_summary?.comparison, "prior_run", "setup: the prior Run Record is the comparison");
  return { output, dirs: [dir] };
});

goldenCase("packet", "cause-built-output", "causes on built-output findings: a prior run had the upsell selector-scope finding as a warning (now an error: status changed) and the missing fingerprint as a warning (pre-existing)", (t) => {
  const fixture = preparedPacket(t, "packet-cause-built", { pages: ROLE_BLOCKED_PAGES });
  writeJson(join(fixture.dir, ".campaign-runtime", "run-records", `${PRIOR_RUN_ID}.json`), priorRunRecord("runtime-packet-demo-k9x2", {
    status: "ready_with_warnings", error_codes: [], warning_codes: ["built_output.upsell_selector_scope", "built_output.fingerprint_missing"], ready_count: 0,
  }));
  const output = packetDoctor(fixture.packetPath);
  assert.equal(output.cause_summary?.comparison, "prior_run", "setup: the prior Run Record is the comparison");
  return { output, dirs: [fixture.dir] };
});

// ---------------------------------------------------------------------------
// CI: doctorCommand --ci in process, live refs disabled. The result's ci
// object is attached after path stripping, so it is normalized here too.

const CI_SLUG = "synthetic-campaign";
const CI_PAGES = {
  landing: `<!doctype html><html><head><meta name="next-page-type" content="product"></head><body><main>Synthetic landing original</main><a href="/${CI_SLUG}/checkout/">Buy</a></body></html>\n`,
  checkout: '<!doctype html><html><head><meta name="next-page-type" content="checkout"></head><body><main>Synthetic checkout original</main></body></html>\n',
};
const CI_CAMPAIGNS = { [CI_SLUG]: { store_name: "Synthetic Store", store_url: "https://store.example.org", sdk_version: "0.4.18" } };
// What `record build` kept for CI_PAGES and CI_CAMPAIGNS at base, written
// literally so the recorded side does not move with the implementation.
const CI_RECORDED_ASSEMBLY = {
  status: "completed",
  build_fingerprint: "sha256:21378ddd57f1eccadb2f9a7b3e52141aa6aae0e3ff670e0c964b6d06a35e0e57",
  build_manifest: [
    { path: "checkout/index.html", sha256: "6a7761499fe4746e3a84ed1859b039687c91fd1e624e1b690dd5adf15a863566" },
    { path: "landing/index.html", sha256: "74fa29247c48d93fbef96bb02c453f5ebc3744eb72401f9213604847ab664abd" },
  ],
  commerce_signature: {
    algorithm: "commerce-signature/v1",
    campaign_config: "sha256:365c68337225bb4b9838e5fa0e3803e07bcb5f527f6f9f9039a7dec16b5139b3",
    pages: {
      "checkout/index.html": "sha256:a86e343804bebed933f1081d9b7708bfdca5317e12cc0d51dfbf2956927499d4",
      "landing/index.html": "sha256:4ac40595046675e09a41a6053d1c70bcc0f53cab622a051822ee09cf6eb46293",
    },
  },
};

// The doctor-ci.test.mjs fixture shape: a minimal packet (its local spec is
// absent, so ordinary inspection reports unrelated errors), two built pages
// and a report whose polish and QA evidence bind the recorded build.
function ciFixture(t, topic, { mutateReport = null, mutateOutput = null } = {}) {
  const root = tempRoot(t, topic);
  const output = join(root, "_site", CI_SLUG);
  for (const [route, html] of Object.entries(CI_PAGES)) writeFile(join(output, route, "index.html"), html);
  writeJson(join(root, "_data", "campaigns.json"), CI_CAMPAIGNS);
  const packetPath = join(root, "campaign-runtime.build.json");
  writeJson(packetPath, {
    schema_version: "campaign-runtime-build-packet/v0",
    campaign: { public_route_slug: CI_SLUG },
    spec: { map_id: "synthetic-map", local_path: "missing-spec.json" },
    assembly: { target_repo: ".", output_dir: `src/${CI_SLUG}` },
  });
  const assembly = structuredClone(CI_RECORDED_ASSEMBLY);
  const report = { stages: {
    assembly,
    polish: { status: "completed", source_build_fingerprint: assembly.build_fingerprint },
    qa: { status: "completed", evidence: { source_build_fingerprint: assembly.build_fingerprint } },
  } };
  if (mutateReport) mutateReport(report);
  writeJson(join(root, ".campaign-runtime", "assembly-report.json"), report);
  if (mutateOutput) mutateOutput(output);
  return { root, packetPath };
}

const CI_CASES = [
  ["current", "the recorded build fingerprint matches the output (exit 0)", {}],
  ["unknown-missing-output", "the built output is missing (exit 4)", {
    mutateOutput: (output) => rmSync(output, { recursive: true, force: true }),
  }],
  ["unknown-missing-fingerprint", "the assembly build fingerprint is missing from the report (exit 4)", {
    mutateReport: (report) => { delete report.stages.assembly.build_fingerprint; },
  }],
  ["owed-page-only", "a copy-only edit to the landing page after the recorded build (page_only, exit 3)", {
    mutateOutput: (output) => writeFileSync(join(output, "landing", "index.html"), CI_PAGES.landing.replace("Synthetic landing original", "Synthetic landing revised")),
  }],
  ["owed-commerce", "a commerce attribute added to landing and a copy edit to checkout (commerce_affecting, exit 3)", {
    mutateOutput: (output) => {
      writeFileSync(join(output, "landing", "index.html"), CI_PAGES.landing.replace("<a href=", '<a data-next-package-id="2" href='));
      writeFileSync(join(output, "checkout", "index.html"), CI_PAGES.checkout.replace("Synthetic checkout original", "Synthetic checkout revised"));
    },
  }],
  ["owed-commerce-in-template", "a commerce attribute added inside a <template> on landing (the commerce signature reads template content: commerce_affecting, exit 3)", {
    mutateOutput: (output) => writeFileSync(join(output, "landing", "index.html"), CI_PAGES.landing.replace("</main>", '</main><template><button data-next-package-id="2">Add</button></template>')),
  }],
];
for (const [id, description, options] of CI_CASES) {
  goldenCase("ci", id, description, (t) => {
    const { root, packetPath } = ciFixture(t, `ci-${id}`, options);
    return { output: ciDoctor(packetPath), dirs: [root] };
  });
}

// CI on a prepared packet with a real CampaignSpec and built site, so CI's
// doctor half (gates, QC rows, ready[]) is pinned with its evidence-debt
// half: the role-blocked pages, the build recorded literally and bound by
// polish and QA.
const ROLE_BLOCKED_RECORDED_BUILD = {
  build_fingerprint: "sha256:a89fc3c745a5b7278c90c9e05254751e6c9f6c4a79e188f39edd4b046acce64e",
  build_manifest: [
    { path: "upsell-1/index.html", sha256: "1790b86691ef4a01f7895e1f5b7244d5c23eb0b4618cafcbe82b37a4e751a824" },
    { path: "upsell/index.html", sha256: "f713e9ed2831a2cd7cefefcb805cf14ee742b0bd5174a2e0bd7a4f64e0109dfb" },
  ],
};

goldenCase("ci", "packet-upsell-blocked", "a prepared examples packet with the role-blocked upsell pages, its recorded build current and bound by polish and QA", (t) => {
  const { dir, packetPath } = preparedPacket(t, "ci-packet-blocked", {
    pages: ROLE_BLOCKED_PAGES,
    mutateReport: (report) => {
      Object.assign(report.stages.assembly, structuredClone(ROLE_BLOCKED_RECORDED_BUILD), { status: "completed" });
      Object.assign(report.stages.polish, { status: "completed", source_build_fingerprint: ROLE_BLOCKED_RECORDED_BUILD.build_fingerprint });
      Object.assign(report.stages.qa, { status: "completed", evidence: { source_build_fingerprint: ROLE_BLOCKED_RECORDED_BUILD.build_fingerprint } });
    },
  });
  const output = ciDoctor(packetPath);
  assert.equal(output.result.derived.build_output_fingerprint?.status, "pass", "setup: the literal record matches the built site");
  return { output, dirs: [dir] };
});

// ---------------------------------------------------------------------------

test("doctor golden: every committed golden file belongs to a case in this suite", () => {
  const onDisk = existsSync(GOLDEN_DIR) ? readdirSync(GOLDEN_DIR).filter((name) => name.endsWith(".json")).sort() : [];
  const expected = [...registered].map((name) => `${name}.json`).sort();
  assert.deepEqual(onDisk, expected, `fixtures/doctor-golden/doctor/ must hold exactly one file per case; a removed case must not leave its capture behind (regenerate only with ${REGEN} for a reviewed behavior change).`);
});
