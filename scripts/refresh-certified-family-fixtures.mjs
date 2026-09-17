#!/usr/bin/env node
// Refresh fixtures/certified-families/: the rendered output of every certified
// starter family at the commit the vendored catalog was synced from.
//
// Why this exists (#206 ON-2 closeout, failure mode #5 "gate-first,
// capability-later"): a built-output doctor gate must ship with proof that it
// PASSES on real pages from every certified family before it is allowed to
// block anything. `polish.hidden_eager_media` shipped without that proof and
// could never pass on a live-SDK page; an operator found out mid-run. The
// reachability tests read this tree so the proof is executable in CI, where
// the templates checkout is present (STARTER_TEMPLATES_PATH) but page-kit is
// not installed and nothing is rendered.
//
// What it does:
//   1. Resolves the campaign-cart-starter-templates source at the catalog pin
//      (`_synced_from_sha`), the same way check-template-doctrine does.
//   2. Renders it with the page-kit install of the sibling checkout
//      (`campaign-build`), in a temp dir; the checkout's own tree is untouched.
//   3. Copies, for each certified family, every rendered *.html plus the
//      family's config.js into fixtures/certified-families/_site/<family>/.
//      CSS, images and per-page JS are not copied: no static markup gate reads
//      them, and they are most of the bytes.
//   4. Drops the `<link rel="dns-prefetch">` / `<link rel="preconnect">`
//      resource hint for the campaign API host. It carries no SDK-markup meaning and its host is on this
//      repository's private-string denylist. Nothing else is rewritten.
//   5. Writes manifest.json with the source sha, page-kit version, families
//      and per-file sha256 so the tree's provenance is checkable.
//
// Usage: node scripts/refresh-certified-family-fixtures.mjs [--sha <sha>]
//        [--note "<why this sha, when it is not the catalog pin>"]
//        [--templates <checkout with node_modules/next-campaign-page-kit>]
//
// The default sha is the catalog pin. Pass --sha when the pin is known to be
// behind a templates fix the gates depend on, and say so in --note; the
// reachability test prints a diagnostic whenever the two differ, which is the
// standing reminder to re-sync the catalog (npm run refresh:starter-catalog).

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveStarterTemplatesRoot } from "./starter-templates-path.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT = join(root, "fixtures", "certified-families");
const catalog = JSON.parse(readFileSync(join(root, "contracts", "commerce-surface-catalog.json"), "utf8"));

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const sha = argValue("--sha") || catalog._synced_from_sha;
if (!/^[0-9a-f]{40}$/.test(String(sha || ""))) {
  throw new Error(`Need a 40-char source sha; catalog _synced_from_sha is ${JSON.stringify(catalog._synced_from_sha)} and no --sha was given.`);
}
const templatesCheckout = resolve(argValue("--templates") || resolveStarterTemplatesRoot(root));
const pageKitDir = join(templatesCheckout, "node_modules", "next-campaign-page-kit");
if (!existsSync(pageKitDir)) {
  throw new Error(`No page-kit install at ${pageKitDir}; run npm ci in the templates checkout (or pass --templates) so campaign-build can render.`);
}
const pageKitVersion = JSON.parse(readFileSync(join(pageKitDir, "package.json"), "utf8")).version;

// Certified = in the catalog AND carrying a brand contract (cli.mjs
// certifiedTemplateFamilies); the same rule, read from the files.
function certifiedFamilies() {
  return Object.keys(catalog.families || {})
    .filter((family) => existsSync(join(root, "contracts", `template-brand-contract.${family}.v0.json`)))
    .sort();
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

// dns-prefetch (older renders, protocol-relative) or preconnect (current,
// https): same hint, same host, same reason to drop it.
const API_HOST_RESOURCE_HINT = /^[ \t]*<link rel="(?:dns-prefetch|preconnect)" href="(?:https?:)?\/\/campaigns\.apps\.[a-z0-9.-]+"(?: crossorigin)?>\r?\n/gm;

const work = mkdtempSync(join(tmpdir(), "certified-family-fixtures-"));
try {
  const archive = execFileSync("git", ["-C", templatesCheckout, "archive", "--format=tar", sha], { maxBuffer: 1 << 28 });
  execFileSync("tar", ["-x", "-C", work], { input: archive });
  symlinkSync(join(templatesCheckout, "node_modules"), join(work, "node_modules"));
  // page-kit logs every written page to stderr; keep it unless the build fails.
  const build = spawnSync("npx", ["campaign-build"], { cwd: work, encoding: "utf8", env: { ...process.env, CPK_ENV: "production" } });
  if (build.status !== 0) throw new Error(`campaign-build failed (${build.status}):\n${build.stderr}${build.stdout}`);

  const families = certifiedFamilies();
  const files = {};
  // Only the generated parts are replaced; README.md is hand-written.
  rmSync(join(OUT, "_site"), { recursive: true, force: true });
  rmSync(join(OUT, "manifest.json"), { force: true });
  for (const family of families) {
    const rendered = join(work, "_site", family);
    if (!existsSync(rendered)) throw new Error(`Certified family "${family}" did not render at ${relative(work, rendered)}; the catalog and the templates source disagree.`);
    for (const file of walk(rendered)) {
      const rel = relative(rendered, file);
      const keep = rel.endsWith(".html") || rel === "config.js";
      if (!keep) continue;
      let text = readFileSync(file, "utf8");
      if (rel.endsWith(".html")) text = text.replace(API_HOST_RESOURCE_HINT, "");
      const out = join(OUT, "_site", family, rel);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, text);
      files[`_site/${family}/${rel}`] = `sha256:${createHash("sha256").update(text).digest("hex")}`;
    }
  }
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify({
    schema_version: "certified-family-fixtures/v0",
    source_repo: "NextCommerceCo/campaign-cart-starter-templates",
    source_sha: sha,
    source_note: argValue("--note") || (sha === catalog._synced_from_sha ? "catalog pin (_synced_from_sha)" : "differs from the catalog pin; no --note given"),
    page_kit_version: pageKitVersion,
    rendered_with: "campaign-build (CPK_ENV=production)",
    rewrites: ["dropped the <link rel=\"dns-prefetch\"|\"preconnect\"> resource hint for the campaign API host"],
    families,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))),
  }, null, 2)}\n`);
  console.log(`Refreshed ${Object.keys(files).length} file(s) for ${families.length} certified families at ${sha.slice(0, 7)} into ${relative(root, OUT)}/`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
