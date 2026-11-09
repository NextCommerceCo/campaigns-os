// Family script divergence (#729): the bundled reference contract, the line
// diff, and the advisory through doctor --built. Advisory only: a diverged
// copy is a warning, never an error or a checkpoint gate.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { doctorBuiltOutput } from "./doctor/inspect.mjs";
import { withHtmlScanSnapshot } from "./html-scan.mjs";
import {
  FAMILY_SCRIPT_REFERENCE_BLOB_DIR,
  FAMILY_SCRIPT_REFERENCE_FILE,
  LINE_DIFF_CELL_BUDGET,
  familyScriptReferenceBlobPath,
  lineDiffSummary,
  loadFamilyScriptReference,
  sha256Hex,
} from "./family-script-reference.mjs";
import {
  FAMILY_SCRIPT_DIFF_CELL_BUDGET,
  FAMILY_SCRIPT_DIVERGED,
  FAMILY_SCRIPT_DIVERGENCE,
  collectFamilyScriptDivergence,
  resolveFamilyScriptReference,
} from "./family-script-divergence.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const CERTIFIED = join(ROOT, "fixtures", "certified-families");
const catalog = JSON.parse(readFileSync(join(ROOT, "contracts", "commerce-surface-catalog.json"), "utf8"));
const privateFamilies = Object.keys(JSON.parse(readFileSync(join(ROOT, "contracts", "private-template-sources.json"), "utf8")).sources);
const certifiedManifest = JSON.parse(readFileSync(join(CERTIFIED, "manifest.json"), "utf8"));

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "family-script-divergence-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A copy of one certified family's rendered fixture, to edit.
function familyCopy(dir, family) {
  cpSync(join(CERTIFIED, "_site", family), join(dir, "_site", family), { recursive: true });
  return join(dir, "_site", family);
}

const advisoryWarnings = (result) => result.warnings.filter((issue) => issue.code.startsWith(FAMILY_SCRIPT_DIVERGENCE));

test("the bundled reference is pinned to the catalog, names only public certified families, and every blob verifies", () => {
  const reference = loadFamilyScriptReference();
  assert.equal(reference.source.sha, catalog._synced_from_sha);
  assert.deepEqual(Object.keys(reference.families).sort(), [...certifiedManifest.families].sort());
  for (const family of privateFamilies) assert.equal(reference.families[family], undefined, `private family ${family} is bundled`);
  assert.deepEqual(reference.private_families.families, [...privateFamilies].sort());
  const named = new Set();
  for (const [family, entry] of Object.entries(reference.families)) {
    assert.match(entry.sdk_version, /^\d+\.\d+\.\d+$/);
    for (const script of entry.scripts) {
      assert.match(script.built_path, /^js\/.+\.js$/, `${family}: ${script.built_path} is not a family script`);
      assert.equal(script.source_path, `src/${family}/assets/${script.built_path}`);
      const bytes = readFileSync(join(ROOT, familyScriptReferenceBlobPath(script.sha256)));
      assert.equal(sha256Hex(bytes), script.sha256);
      assert.equal(bytes.length, script.bytes);
      named.add(`${script.sha256}.js.txt`);
    }
  }
  assert.deepEqual(readdirSync(join(ROOT, FAMILY_SCRIPT_REFERENCE_BLOB_DIR)).sort(), [...named].sort(), "every blob is named and every named blob ships");
});

test("every family script the certified render carries is byte-identical to its reference entry", () => {
  const reference = loadFamilyScriptReference();
  let compared = 0;
  for (const [file, digest] of Object.entries(certifiedManifest.files)) {
    const match = /^_site\/([^/]+)\/(.+\.js)$/.exec(file);
    if (!match || match[2] === "config.js") continue;
    const entry = reference.families[match[1]].scripts.find((script) => script.built_path === match[2]);
    assert.ok(entry, `${file} has no reference entry`);
    assert.equal(`sha256:${entry.sha256}`, digest, `${file} differs from the reference`);
    compared += 1;
  }
  assert.ok(compared > 50, `only ${compared} rendered scripts compared`);
});

test("lineDiffSummary counts lines and hunks, ignores line endings, and stops at its budget", () => {
  assert.deepEqual(lineDiffSummary("a\nb\n", "a\nb\n"), { local_lines: 2, reference_lines: 2, delta: 0, hunks: { count: 0, added: 0, removed: 0, first: [] } });
  const edited = lineDiffSummary("a\nX\nY\nc\nd\nZ\n", "a\nb\nc\nd\n");
  assert.equal(edited.delta, 2);
  assert.deepEqual(edited.hunks, {
    count: 2,
    added: 3,
    removed: 1,
    first: [
      { local_start: 2, local_lines: 2, reference_start: 2, reference_lines: 1 },
      { local_start: 6, local_lines: 1, reference_start: 5, reference_lines: 0 },
    ],
  });
  assert.equal(lineDiffSummary("a\r\nb\r\n", "a\nb\n").hunks.count, 0);
  const side = Math.ceil(Math.sqrt(LINE_DIFF_CELL_BUDGET)) + 1;
  const big = (prefix) => Array.from({ length: side }, (_, index) => `${prefix}${index}`).join("\n");
  const over = lineDiffSummary(big("a"), big("b"));
  assert.equal(over.hunks, null);
  assert.equal(over.local_lines, side);
});

test("a certified family read with its own --family: every candidate identical, config.js kept apart, no warning", () => {
  const result = doctorBuiltOutput({ built: CERTIFIED, slug: "apollo", family: "apollo" });
  assert.ok(result.derived.doctor_checks.includes(FAMILY_SCRIPT_DIVERGENCE));
  const record = result.derived.family_script_divergence;
  assert.equal(record.status, "compared");
  assert.equal(record.family_source, "flag");
  assert.deepEqual(record.reference, {
    kind: "bundled",
    repo: "NextCommerceCo/campaign-cart-starter-templates",
    sha: catalog._synced_from_sha,
    sdk_version: "0.4.43",
    label: `NextCommerceCo/campaign-cart-starter-templates@${catalog._synced_from_sha.slice(0, 7)} (SDK 0.4.43)`,
  });
  assert.ok(record.scripts.length > 0);
  assert.ok(record.scripts.every((entry) => entry.result === "identical" && entry.match === "path" && entry.ancestry === "candidate"));
  assert.deepEqual(record.generated_configuration.map((entry) => entry.built_path), ["config.js"]);
  assert.deepEqual(advisoryWarnings(result), []);
  assert.ok(result.ready.some((line) => line.startsWith("Family scripts compared with apollo at NextCommerceCo/campaign-cart-starter-templates@")));
});

test("without --family the advisory does not run", () => {
  const result = doctorBuiltOutput({ built: CERTIFIED, slug: "apollo" });
  assert.equal(result.derived.doctor_checks.includes(FAMILY_SCRIPT_DIVERGENCE), false);
  assert.equal(result.derived.family_script_divergence, undefined);
});

test("an edited family copy warns with the reference, line delta and hunks; a renamed unedited copy matches by content", () => {
  withTemp((dir) => {
    const campaign = familyCopy(dir, "apollo-mv-single-step");
    const upsells = join(campaign, "js", "upsells-mv.js");
    const lines = readFileSync(upsells, "utf8").split("\n");
    lines.splice(40, 1, "// campaign edit", "window.__packageTable = [1, 2, 3];");
    writeFileSync(upsells, lines.join("\n"));
    // A renamed copy of an unedited family file, loaded from the checkout page.
    cpSync(join(campaign, "js", "checkout.js"), join(campaign, "js", "checkout-copy.js"));
    const checkout = join(campaign, "checkout", "index.html");
    writeFileSync(checkout, readFileSync(checkout, "utf8").replace("</body>", '<script src="/apollo-mv-single-step/js/checkout-copy.js"></script></body>'));

    const result = doctorBuiltOutput({ built: dir, slug: "apollo-mv-single-step", family: "apollo-mv-single-step" });
    assert.equal(result.errors.filter((issue) => issue.code.startsWith(FAMILY_SCRIPT_DIVERGENCE)).length, 0, "advisory never blocks");
    const [warning, ...rest] = advisoryWarnings(result);
    assert.deepEqual(rest, []);
    assert.equal(warning.code, FAMILY_SCRIPT_DIVERGED);
    assert.match(warning.message, /^_site\/apollo-mv-single-step\/js\/upsells-mv\.js differs from the apollo-mv-single-step family file js\/upsells-mv\.js \(candidate by same built path; ancestry is not recorded\) at NextCommerceCo\/campaign-cart-starter-templates@[0-9a-f]{7} \(SDK 0\.4\.43\), src\/apollo-mv-single-step\/assets\/js\/upsells-mv\.js: 296 line\(s\) against 295 \(\+1\), 1 hunk\(s\) adding 2 and removing 1 line\(s\), the first at line 41\./);
    assert.deepEqual(warning.detail.finding.diff.hunks.first, [{ local_start: 41, local_lines: 2, reference_start: 41, reference_lines: 1 }]);
    const renamed = result.derived.family_script_divergence.scripts.find((entry) => entry.file.endsWith("checkout-copy.js"));
    assert.deepEqual({ match: renamed.match, result: renamed.result, reference_path: renamed.reference_path }, { match: "content", result: "identical", reference_path: "js/checkout.js" });
  });
});

test("a name shared by two reference files is reported as ambiguous and not diffed; unmatched scripts are only counted", () => {
  withTemp((dir) => {
    const campaign = join(dir, "_site", "camp");
    mkdirSync(join(campaign, "js", "a"), { recursive: true });
    writeFileSync(join(campaign, "index.html"), '<!doctype html><script src="/camp/js/a/landing.js"></script><script src="/camp/js/own.js"></script><script src="/camp/config.js"></script>');
    writeFileSync(join(campaign, "js", "a", "landing.js"), "edited();\n");
    writeFileSync(join(campaign, "js", "own.js"), "own();\n");
    writeFileSync(join(campaign, "config.js"), "window.config = {};\n");
    const reference = {
      kind: "bundled",
      repo: "example/templates",
      sha: "0".repeat(40),
      sdk_version: null,
      label: "example/templates@0000000",
      generated: ["config.js"],
      scripts: ["js/landing/landing.js", "js/presell/landing.js"].map((builtPath) => ({ built_path: builtPath, source_path: builtPath, sha256: sha256Hex(builtPath), text: () => builtPath })),
    };
    const scope = { site_root: join(dir, "_site"), campaign_dir: campaign, pages: [{ page_id: "index", built_path: join(campaign, "index.html") }] };
    const record = withHtmlScanSnapshot(() => collectFamilyScriptDivergence({ scope, targetRepo: dir, family: "camp", familySource: "flag", reference }));
    assert.deepEqual(record.scripts, [{ file: "_site/camp/js/a/landing.js", pages: ["index"], match: "ambiguous", ancestry: "candidate", result: "ambiguous", candidates: ["js/landing/landing.js", "js/presell/landing.js"] }]);
    assert.equal(record.not_compared, 1);
    assert.deepEqual(record.generated_configuration, [{ file: "_site/camp/config.js", built_path: "config.js", pages: ["index"] }]);
  });
});

// A one-page campaign loading the given scripts, compared against a synthetic
// reference of the given { built_path: text } files.
function syntheticRun(dir, scripts, referenceFiles) {
  const campaign = join(dir, "_site", "camp");
  for (const [path, text] of Object.entries(scripts)) {
    mkdirSync(join(campaign, path, ".."), { recursive: true });
    writeFileSync(join(campaign, path), text);
  }
  writeFileSync(join(campaign, "index.html"), `<!doctype html>${Object.keys(scripts).map((path) => `<script src="/camp/${path}"></script>`).join("")}`);
  const reference = {
    kind: "bundled",
    repo: "example/templates",
    sha: "0".repeat(40),
    sdk_version: null,
    label: "example/templates@0000000",
    generated: ["config.js"],
    scripts: Object.entries(referenceFiles).map(([builtPath, text]) => ({ built_path: builtPath, source_path: `src/x/assets/${builtPath}`, sha256: sha256Hex(text), text: () => text })),
  };
  const scope = { site_root: join(dir, "_site"), campaign_dir: campaign, pages: [{ page_id: "index", built_path: join(campaign, "index.html") }] };
  return withHtmlScanSnapshot(() => collectFamilyScriptDivergence({ scope, targetRepo: dir, family: "x", familySource: "flag", reference }));
}

test("bytes decide before names: an exact copy is identical even when its name belongs to another family file", () => {
  withTemp((dir) => {
    const record = syntheticRun(dir, { "js/checkout.js": "upsell();\n" }, { "js/checkout.js": "checkout();\n", "js/upsells.js": "upsell();\n" });
    assert.deepEqual(record.scripts.map(({ match, result, reference_path: path }) => ({ match, result, path })), [{ match: "content", result: "identical", path: "js/upsells.js" }]);
  });
});

test("two family files with the same bytes are both named; an edited copy of a shared name is ambiguous", () => {
  withTemp((dir) => {
    const record = syntheticRun(dir, { "js/copy.js": "same();\n", "js/a/landing.js": "edited();\n" }, { "js/one.js": "same();\n", "js/two.js": "same();\n", "js/landing/landing.js": "l1();\n", "js/presell/landing.js": "l2();\n" });
    const [copy, landing] = record.scripts;
    assert.deepEqual({ match: copy.match, result: copy.result, candidates: copy.candidates }, { match: "content", result: "identical", candidates: ["js/one.js", "js/two.js"] });
    assert.deepEqual({ match: landing.match, result: landing.result }, { match: "ambiguous", result: "ambiguous" });
  });
});

test("the record's diff budget is shared: once spent, later diverged copies report line counts without hunks", () => {
  withTemp((dir) => {
    const side = Math.floor(Math.sqrt(FAMILY_SCRIPT_DIFF_CELL_BUDGET / 4)) - 1;
    const lines = (prefix) => `${Array.from({ length: side }, (_, index) => `${prefix}${index}`).join("\n")}\n`;
    const scripts = {};
    const referenceFiles = {};
    for (let index = 0; index < 5; index += 1) {
      scripts[`js/f${index}.js`] = lines(`a${index}_`);
      referenceFiles[`js/f${index}.js`] = lines(`b${index}_`);
    }
    const record = syntheticRun(dir, scripts, referenceFiles);
    assert.deepEqual(record.scripts.map((entry) => entry.diff.hunks === null), [false, false, false, false, true]);
    assert.ok(record.scripts.every((entry) => entry.diff.local_lines === side));
  });
});

test("a damaged install reads the script as unavailable, never as a diff", () => {
  withTemp((dir) => {
    mkdirSync(join(dir, "contracts"), { recursive: true });
    cpSync(join(ROOT, FAMILY_SCRIPT_REFERENCE_FILE), join(dir, FAMILY_SCRIPT_REFERENCE_FILE));
    cpSync(join(ROOT, FAMILY_SCRIPT_REFERENCE_BLOB_DIR), join(dir, FAMILY_SCRIPT_REFERENCE_BLOB_DIR), { recursive: true });
    const damaged = loadFamilyScriptReference({ root: dir });
    const upsells = damaged.families.apollo.scripts.find((script) => script.built_path === "js/upsells.js");
    writeFileSync(join(dir, familyScriptReferenceBlobPath(upsells.sha256)), "tampered\n");
    const site = mkdtempSync(join(tmpdir(), "family-script-divergence-site-"));
    try {
      const campaign = familyCopy(site, "apollo");
      writeFileSync(join(campaign, "js", "upsells.js"), `${readFileSync(join(campaign, "js", "upsells.js"), "utf8")}// edit\n`);
      const scope = { site_root: join(site, "_site"), campaign_dir: campaign, pages: [{ page_id: "upsell-single", built_path: join(campaign, "upsell-single", "index.html") }] };
      const reference = resolveFamilyScriptReference("apollo", { loadReference: () => damaged });
      const record = withHtmlScanSnapshot(() => collectFamilyScriptDivergence({ scope, targetRepo: site, family: "apollo", familySource: "flag", reference }));
      const entry = record.scripts.find((script) => script.reference_path === "js/upsells.js");
      assert.equal(entry.result, "unavailable");
      assert.match(entry.reason, /does not match its recorded SHA-256/);
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  });
});

test("a family the reference does not cover, or a missing reference file, reads as unavailable", () => {
  const unknown = resolveFamilyScriptReference("not-a-family");
  assert.match(unknown.unavailable, /has no scripts for family "not-a-family"; it covers apollo, /);
  withTemp((dir) => {
    const missing = resolveFamilyScriptReference("apollo", { loadReference: () => loadFamilyScriptReference({ root: dir }) });
    assert.match(missing.unavailable, /is not in this install/);
  });
});

// A private family: allowlisted in a sandboxed allowlist, sourced from a
// sibling checkout under a sandboxed root, never from the bundled reference.
function withPrivateFamily(dir, fragmentExtra, fn) {
  const saved = { path: process.env.PRIVATE_TEMPLATE_SOURCES_PATH, root: process.env.PRIVATE_TEMPLATE_SOURCES_ROOT };
  const siblings = join(dir, "siblings");
  mkdirSync(join(siblings, "acme-templates", "contracts"), { recursive: true });
  writeFileSync(join(dir, "allowlist.json"), JSON.stringify({ schema_version: "private-template-source/v0", sources: { acme: { repo: "example-org/acme-templates", contract_path: "contracts/acme.json" } } }));
  writeFileSync(join(siblings, "acme-templates", "contracts", "acme.json"), JSON.stringify({ schema_version: "private-template-source-fragment/v0", family: "acme", ...fragmentExtra }));
  process.env.PRIVATE_TEMPLATE_SOURCES_PATH = join(dir, "allowlist.json");
  process.env.PRIVATE_TEMPLATE_SOURCES_ROOT = siblings;
  try {
    return fn(join(siblings, "acme-templates"));
  } finally {
    for (const [key, value] of [["PRIVATE_TEMPLATE_SOURCES_PATH", saved.path], ["PRIVATE_TEMPLATE_SOURCES_ROOT", saved.root]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a private family whose script_reference.source_root leaves its checkout is unavailable and nothing outside is read", () => {
  withTemp((dir) => {
    const campaign = join(dir, "site", "_site", "acme");
    mkdirSync(join(campaign, "js"), { recursive: true });
    writeFileSync(join(campaign, "index.html"), '<!doctype html><script src="/acme/js/checkout.js"></script>');
    writeFileSync(join(campaign, "js", "checkout.js"), "start();\n");
    mkdirSync(join(dir, "outside", "js"), { recursive: true });
    writeFileSync(join(dir, "outside", "js", "checkout.js"), "secret();\n");
    for (const sourceRoot of ["../../outside", join(dir, "outside")]) {
      withPrivateFamily(dir, { script_reference: { source_root: sourceRoot } }, () => {
        const result = doctorBuiltOutput({ built: join(dir, "site"), slug: "acme", family: "acme" });
        const record = result.derived.family_script_divergence;
        assert.equal(record.status, "unavailable", sourceRoot);
        assert.match(record.reason, /script_reference\.source_root leaves the example-org\/acme-templates checkout/);
        assert.deepEqual(record.scripts, []);
      });
    }
  });
});

test("a private family without a local script source is unavailable; with one, it is compared against that checkout", () => {
  withTemp((dir) => {
    const campaign = join(dir, "site", "_site", "acme");
    mkdirSync(join(campaign, "js"), { recursive: true });
    writeFileSync(join(campaign, "index.html"), '<!doctype html><script src="/acme/js/checkout.js"></script><script src="/acme/config.js"></script>');
    writeFileSync(join(campaign, "js", "checkout.js"), "start();\nedited();\n");
    writeFileSync(join(campaign, "config.js"), "window.config = {};\n");
    withPrivateFamily(dir, {}, () => {
      const result = doctorBuiltOutput({ built: join(dir, "site"), slug: "acme", family: "acme" });
      assert.equal(result.derived.family_script_divergence.status, "unavailable");
      assert.match(result.derived.family_script_divergence.reason, /"acme" is a private family and its contract fragment names no script_reference\.source_root/);
      assert.deepEqual(advisoryWarnings(result), []);
      assert.ok(result.ready.some((line) => line.startsWith("Family script divergence not compared for acme: ")));
    });
    withPrivateFamily(dir, { script_reference: { source_root: "src/acme/assets" } }, (checkout) => {
      mkdirSync(join(checkout, "src", "acme", "assets", "js"), { recursive: true });
      writeFileSync(join(checkout, "src", "acme", "assets", "js", "checkout.js"), "start();\n");
      execFileSync("git", ["init", "-q", checkout]);
      execFileSync("git", ["-C", checkout, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A"]);
      execFileSync("git", ["-C", checkout, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "fixture"]);
      const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const result = doctorBuiltOutput({ built: join(dir, "site"), slug: "acme", family: "acme" });
      const record = result.derived.family_script_divergence;
      assert.equal(record.status, "compared");
      assert.deepEqual(record.reference, { kind: "local_private_source", repo: "example-org/acme-templates", sha: head, sdk_version: null, label: `the local example-org/acme-templates checkout at ${head.slice(0, 7)} (working tree)` });
      const [warning] = advisoryWarnings(result);
      assert.match(warning.message, /js\/checkout\.js differs from the acme family file js\/checkout\.js .* src\/acme\/assets\/js\/checkout\.js: 2 line\(s\) against 1 \(\+1\)/);
      assert.equal(existsSync(join(ROOT, FAMILY_SCRIPT_REFERENCE_BLOB_DIR, `${sha256Hex("start();\n")}.js.txt`)), false, "a private source is never written to the bundle");
    });
  });
});
