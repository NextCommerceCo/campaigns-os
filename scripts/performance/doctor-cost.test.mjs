// Smoke test for the doctor cost harness (#730 milestone 1), so it cannot rot
// silently while doctor's built-output path is refactored: one certified family
// in built mode, in a child process, must produce the v1 JSON shape with
// non-zero reads and parses and no unredacted paths; a target outside the
// checkout must not leak its directory or slug; the guards must refuse and
// record writes and fetches; and the redactor must fail closed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { SCHEMA, assertRedacted, makeRedactor } from "./doctor-cost.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const DRIVER = join(ROOT, "scripts/performance/doctor-cost.mjs");
const HOOKS = join(ROOT, "scripts/performance/doctor-cost-hooks.mjs");
const skip = typeof nodeModule.registerHooks === "function" ? false : "doctor-cost needs Node >= 22.15 (module.registerHooks)";

const harness = (args) => spawnSync(process.execPath, [DRIVER, ...args], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });

function scratch(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("built mode on a certified family reports reads, parses and scope work", { skip }, () => {
  const run = harness(["built", "--built", "fixtures/certified-families", "--slug", "olympus", "--family", "olympus", "--samples", "1", "--label", "certified-olympus"]);
  assert.equal(run.status, 0, `harness exited ${run.status}: ${run.stderr}`);
  const result = JSON.parse(run.stdout);
  assert.equal(result.schema, SCHEMA, "result names the v1 schema");
  assert.equal(result.workload, "built", "workload is echoed");
  assert.equal(result.label, "certified-olympus", "label is echoed");
  assert.equal(result.redacted, true, "output is redacted by default");
  assert.equal(result.family, "olympus", "a certified family name is public and kept");
  assert.equal(result.samples, 1);
  assert.equal(result.runs.length, 1, "one counted run per sample");
  assert.equal(result.plain_runs.length, 1, "one plain run per sample");
  assert.match(result.node, /^v\d+\./, "node version recorded");
  assert.ok(typeof result.result_status === "string", "doctor status recorded");
  assert.equal(result.plain.status_matches, true, "the plain process reaches the same doctor status");
  assert.ok(result.median.wall_ms > 0 && result.plain.median.wall_ms > 0, "counted and plain wall time measured");
  assert.ok(result.plain.median.max_rss_mb > 0 && result.import_baseline.max_rss_mb > 0, "maxRSS and the import-only floor measured");
  assert.ok(result.median.heap_peak_mb > 0 && result.plain.median.heap_after_gc_mb > 0, "peak heapUsed and heap after GC measured");
  const { counters } = result;
  assert.ok(counters.reads.calls > 0 && counters.reads.distinct > 0, "file reads counted");
  assert.ok(counters.reads.calls >= counters.reads.distinct, "distinct reads never exceed total reads");
  assert.ok(counters.reads.distinct_paths >= counters.reads.distinct, "path spellings never undercount files");
  assert.ok(Number.isInteger(counters.reads.failed), "failed reads are counted apart from reads");
  assert.ok(counters.reads.mb_total > 0, "bytes read counted");
  assert.ok(counters.reads.by_extension[".html"].files > 0, "per-extension read counts reported");
  assert.ok(counters.readdir.calls > 0, "directory enumerations counted");
  assert.ok(counters.parse5.calls > 0 && counters.parse5.distinct > 0, "parse5 parses counted");
  assert.ok(Object.keys(counters.parse5.by_profile).length > 0, "parse5 parses split by options profile");
  assert.ok(counters.acorn.calls > 0, "acorn parses counted");
  assert.ok(counters.scope_resolutions > 0, "resolveBuiltSiteScope calls counted");
  for (const [name, value] of Object.entries(counters.calls)) {
    assert.ok(Number.isInteger(value), `counted export ${name} still exists in src/ (null means it moved; update COUNTED_EXPORTS)`);
  }
  assert.equal(counters.allowed_writes, 0, "built mode writes nothing");
  assert.equal(result.counters_stable, true);
  const text = JSON.stringify(result);
  assert.ok(!text.includes(ROOT) && !text.includes(homedir()), "no absolute checkout or home path survives redaction");
});

test("a target outside the checkout keeps neither its directory name nor its slug", { skip }, (t) => {
  const dir = scratch(t, "campaigns-os-doctor-cost-leak-");
  const built = join(dir, "acme-private-estate-zq");
  cpSync(join(ROOT, "fixtures/certified-families/_site/olympus"), join(built, "_site/zq-secret-slug"), { recursive: true });
  const run = harness(["built", "--built", built, "--slug", "zq-secret-slug", "--samples", "1", "--no-baseline", "--no-plain", "--label", "estate-a"]);
  assert.equal(run.status, 0, `harness exited ${run.status}: ${run.stderr}`);
  for (const secret of ["acme-private-estate-zq", "zq-secret-slug", dir, realpathSync(dir), tmpdir(), realpathSync(tmpdir()), homedir()]) {
    assert.ok(!run.stdout.includes(secret), `${secret} must not appear in the result`);
  }
  const result = JSON.parse(run.stdout);
  assert.equal(result.slug, "<slug>");
  assert.ok(result.counters.reads.top_repeated.length > 0, "repeated reads are listed");
  for (const [path] of result.counters.reads.top_repeated) {
    assert.match(path, /^<estate-a>\/_site\/<slug>(\/(h-[0-9a-f]{6}(\.[a-z0-9]+)?|index\.html|js|config\.js))+$/, "target paths keep only structure and salted hashes");
  }
});

test("the guards refuse and record every write and fetch during a measured call; failed reads and path spellings are counted apart", { skip }, (t) => {
  const dir = scratch(t, "campaigns-os-doctor-cost-guard-");
  const allowed = join(dir, "scratch");
  const real = join(dir, "real.txt");
  const link = join(dir, "link.txt");
  writeFileSync(real, "abc");
  symlinkSync(real, link);
  const probe = [
    'import fs from "node:fs";',
    'import * as fsp from "node:fs/promises";',
    "const cost = globalThis.__doctorCost;",
    `const D = ${JSON.stringify(dir)};`,
    "const out = {};",
    "const attempt = async (name, fn) => { try { await fn(); out[name] = fs.existsSync(`${D}/${name}`) ? 'wrote' : 'no file'; } catch (error) { out[name] = /doctor-cost: refused/.test(error.message) ? 'refused' : String(error); } };",
    `const readOnly = fs.openSync(${JSON.stringify(real)}, "r");`,
    "cost.begin();",
    "await attempt('writeFileSync', () => fs.writeFileSync(`${D}/writeFileSync`, 'x'));",
    "await attempt('promises.writeFile', () => fsp.writeFile(`${D}/promises.writeFile`, 'x'));",
    "await attempt('promises.open', async () => { const handle = await fs.promises.open(`${D}/promises.open`, 'w'); await handle.writeFile('x'); await handle.close(); });",
    "await attempt('open', () => new Promise((ok, no) => fs.open(`${D}/open`, 'w', (error, fd) => (error ? no(error) : fs.write(fd, 'x', (e2) => { fs.closeSync(fd); e2 ? no(e2) : ok(); })))));",
    "await attempt('createWriteStream', () => new Promise((ok, no) => { const stream = fs.createWriteStream(`${D}/createWriteStream`); stream.on('error', no); stream.end('x', ok); }));",
    "await attempt('openSync', () => fs.openSync(`${D}/openSync`, 'w'));",
    "await attempt('writeSync-fd', () => fs.writeSync(readOnly, 'x'));",
    "await attempt('fetch', () => fetch('https://example.invalid/'));",
    "try { fs.writeFileSync(`${D}/swallowed`, 'x'); } catch {}",
    "fetch('https://example.invalid/').catch(() => {});",
    `try { fs.readFileSync(${JSON.stringify(join(dir, "missing.txt"))}); } catch {}`,
    `fs.readFileSync(${JSON.stringify(real)}, "utf8"); fs.readFileSync(${JSON.stringify(link)}, "utf8");`,
    "let state = cost.end();",
    "const reads = { calls: [...state.fs.readFileSync.values()].reduce((a, b) => a + b, 0), files: state.fs.readFileSync.size, spellings: state.spellings.readFileSync.size, failed: state.failed.readFileSync.size, bytes: state.readBytes };",
    "const refused = state.refused.length;",
    `fs.mkdirSync(${JSON.stringify(allowed)});`,
    `cost.begin({ allowWritesUnder: [${JSON.stringify(allowed)}] });`,
    `fs.writeFileSync(${JSON.stringify(join(allowed, "inside.txt"))}, "x");`,
    "state = cost.end();",
    "console.log(JSON.stringify({ out, refused, reads, inside: { writes: state.writes.length, refused: state.refused.length } }));",
  ].join("\n");
  const run = spawnSync(process.execPath, ["--import", pathToFileURL(HOOKS).href, "--input-type=module", "-e", probe], {
    cwd: dir, encoding: "utf8", timeout: 30_000, env: { ...process.env, DOCTOR_COST_ROOT: ROOT },
  });
  assert.equal(run.status, 0, `probe exited ${run.status}: ${run.stderr}`);
  const result = JSON.parse(run.stdout);
  for (const [name, outcome] of Object.entries(result.out)) assert.equal(outcome, "refused", `${name} is refused`);
  assert.equal(result.refused, Object.keys(result.out).length + 2, "every refusal is recorded, including a swallowed write and an unawaited fetch");
  assert.deepEqual(result.reads, { calls: 2, files: 1, spellings: 2, failed: 1, bytes: 6 }, "a failed read is not a read; a file read through a symlink and its target is one file under two spellings");
  assert.deepEqual(result.inside, { writes: 1, refused: 0 }, "writes under the allowed root are counted, not refused");
});

test("redaction normalizes paths, respects segment boundaries and keeps no names", () => {
  const home = homedir();
  const redact = makeRedactor({ label: "estate-a", roots: ["/srv/private-estate"], slug: "secret-slug", family: "private-family", publicFamilies: ["olympus"] });
  const [path] = redact(["/srv/private-estate/_site/secret-slug/brand-route/index.html"]);
  assert.match(path, /^<estate-a>\/_site\/<slug>\/h-[0-9a-f]{6}\/index\.html$/, "root, slug and route are redacted");
  assert.equal(redact(["doctor/checks.mjs:2141 fn"])[0], "doctor/checks.mjs:2141 fn", "src call sites are not paths");
  assert.equal(redact([`${ROOT}/src/html-scan.mjs`])[0], "<toolkit>/src/html-scan.mjs", "toolkit paths stay readable");
  const cases = {
    escape: `${ROOT}/../brand-templates/contracts/private-family.json`,
    nested: `${ROOT}/fixtures/../../brand-repo/_site/x.html`,
    sibling: "/srv/private-estate-v2/src/a.html",
    space: `${home}/Downloads/campaign-spec-brand oral care bundle (1).json`,
    url: "file:///opt/data/Acme Brand/x.html",
    windows: "C:\\Users\\someone\\brand-repo\\x.html",
    relative: "../../Downloads/campaign-spec-brand.json",
    inText: "spec ../../Downloads/campaign-spec-brand.json missing",
  };
  const out = Object.fromEntries(Object.entries(cases).map(([name, value]) => [name, redact(value)]));
  for (const [name, value] of Object.entries(out)) {
    for (const word of ["brand", "Acme", "private-family", "private-estate", "someone", "Downloads", "oral"]) {
      assert.ok(!value.includes(word), `${name}: ${JSON.stringify(value)} keeps ${word}`);
    }
  }
  assert.match(out.escape, /^(<home>|<tmp>)?\/h-[0-9a-f]{6}/, "a toolkit path that escapes the checkout is hashed, not kept readable");
  assert.ok(!out.sibling.startsWith("<estate-a>"), "a sibling with a longer name is not the target root");
  assert.equal(redact({ top_repeated: [[cases.space, 2]] }).top_repeated[0][1], 2, "repeated-path lists keep their counts");
});

test("the redacted output is refused when a string has no known redacted shape", () => {
  const ok = {
    counters: {
      reads: { top_repeated: [["<estate-a>/_site/<slug>/h-0a1b2c/index.html", 3], ["<toolkit>/src/html-scan.mjs", 2], ["<fd>", 1]] },
      sites: { parse5: [["built_output.pages | doctor/checks.mjs:3086 extractRenderedRefs < doctor/checks.mjs:351 run", 4]] },
      checks: [{ id: "built_output.smoke_qc" }],
    },
    result_status: "blocked (ci: blocked)",
  };
  assert.equal(assertRedacted(ok), ok, "known shapes pass");
  for (const bad of ["template family private-family resolved from brand-co/brand-templates", "/srv/private-estate/x.html", "file:///opt/x.html",
    "<toolkit>/../brand/x.html", "<estate-a>/_site/brand-route/index.html"]) {
    assert.throws(() => assertRedacted({ counters: { note: bad } }), /refusing to emit/, `${bad} is refused`);
  }
  assert.throws(() => assertRedacted({ counters: { id: "secret-slug" } }, { secrets: ["secret-slug"] }), /refusing to emit/, "a secret word is refused");
});
