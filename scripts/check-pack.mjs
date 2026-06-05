#!/usr/bin/env node
// ADR-003 (D5 shape-first): prove the package is registry-ready WITHOUT a
// registry. `npm pack` the package, extract the tarball, and confirm the
// campaign-spec subpath ships its compiled artifact (dist/index.js + .d.ts),
// that the exports map points there, that the bundle is importable and runs,
// and that no source .ts / tests / fixtures leak into the tarball. We extract
// rather than `npm install` the tarball so this stays offline and fast (a full
// install would pull the package's playwright dependency).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error(`pack check FAILED: ${msg}`);
  process.exit(1);
};

const work = mkdtempSync(join(tmpdir(), "campaigns-os-pack-"));
let tarball;
try {
  // `npm pack` runs prepare -> build:spec, so dist is fresh in the tarball.
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: ROOT, encoding: "utf8" })
  );
  tarball = join(work, packed[0].filename);
  execFileSync("tar", ["-xzf", tarball, "-C", work]);
  const pkgRoot = join(work, "package");

  // 1. Compiled artifact + types are present.
  const distEntry = join(pkgRoot, "campaign-spec/dist/index.js");
  const distTypes = join(pkgRoot, "campaign-spec/dist/index.d.ts");
  if (!existsSync(distEntry)) fail("campaign-spec/dist/index.js missing from tarball");
  if (!existsSync(distTypes)) fail("campaign-spec/dist/index.d.ts missing from tarball");

  // 2. exports map resolves the subpath to the shipped artifact.
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  const sub = pkg.exports?.["./campaign-spec"];
  if (sub?.import !== "./campaign-spec/dist/index.js") fail(`exports['./campaign-spec'].import is ${sub?.import}`);
  if (sub?.types !== "./campaign-spec/dist/index.d.ts") fail(`exports['./campaign-spec'].types is ${sub?.types}`);
  // A default/require condition keeps CJS consumers (e.g. require(subpath)) able
  // to resolve it via require(ESM) — without it, a require() call fails to
  // resolve the subpath at all.
  if (!sub?.default && !sub?.require) fail("exports['./campaign-spec'] needs a default/require condition for CJS require() resolution");

  // 3. No dev cruft leaked into the published surface.
  const specFiles = walk(join(pkgRoot, "campaign-spec"));
  const leaked = specFiles.filter(
    (f) => /\.ts$/.test(f) && !/\.d\.ts$/.test(f) || /(^|\/)(test|fixtures)\//.test(f)
  );
  if (leaked.length) fail(`dev files leaked into tarball: ${leaked.slice(0, 8).join(", ")}`);

  // 4. The packed bundle imports and runs (ESM consumer path).
  const mod = await import(distEntry);
  for (const name of ["validateSpec", "normalize", "runRules", "allRules"]) {
    if (typeof mod[name] === "undefined") fail(`packed bundle missing export: ${name}`);
  }
  const violations = mod.validateSpec({});
  if (!Array.isArray(violations) || violations[0]?.ruleId !== "Normalize") {
    fail("packed bundle validateSpec({}) did not behave as expected");
  }

  // 4b. CJS consumer path: the `default` export condition is only useful if
  // `require()` actually resolves the ESM bundle on the running node. require(ESM)
  // is supported on node >=20.19 / >=22.12 (see engines.node). This exercises it
  // for real instead of trusting the condition exists. (Codex review.)
  try {
    const requireFromPack = createRequire(join(pkgRoot, "package.json"));
    const required = requireFromPack(distEntry);
    if (typeof required.validateSpec !== "function") {
      fail("require() of the packed bundle did not expose validateSpec");
    }
  } catch (err) {
    fail(`require() of the packed bundle failed (require(ESM) on node ${process.version}): ${err.message}`);
  }

  // 5. Bundle-size visibility (Codex: a registry does nothing for bundle size).
  const kb = (statSync(distEntry).size / 1024).toFixed(1);
  console.log(`pack check passed: campaign-spec subpath ships dist (${kb} KB entry), imports clean, no dev cruft`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(full.slice(base.length + 1));
  }
  return out;
}
