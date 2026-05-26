#!/usr/bin/env node
/**
 * Reference AI-generated producer (Slice 5b).
 *
 * Walks a directory of source HTML files and emits a Slice-6-compatible
 * source-html-manifest/v0 to <source-root>/.campaigns-os/source-html-manifest.json.
 *
 * Real AI agents that produce campaign source HTML (Claude, Codex, etc.) should
 * adopt this manifest shape so doctor's design_source-aware error messages and
 * drift detection work uniformly across producers. This script is the smallest
 * possible reference: it does not generate any HTML, it only catalogs files
 * the agent has already written.
 *
 * Usage:
 *   bun run scripts/reference-ai-producer.mjs \
 *     --source <source-root> \
 *     --campaign-slug <slug> \
 *     [--generator <name@version>] \
 *     [--page page_id=path/to/file.html ...]
 *
 * If no --page mappings are supplied, the script auto-discovers .html files in
 * <source-root> and derives page_id from the basename (e.g. landing.html →
 * page_id="landing", page_type="landing"). Explicit --page args override
 * auto-discovery and can map non-standard filenames or paths into named pages.
 *
 * The manifest pages[].source_hash is filled in from sha256(file contents) so
 * doctor's Slice 6 drift detection has something to compare against on the
 * consumer side.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  SOURCE_HTML_MANIFEST_REL_PATH as MANIFEST_REL_PATH,
  SOURCE_HTML_MANIFEST_SCHEMA as MANIFEST_SCHEMA,
} from "../src/source-html-manifest.mjs";

const DEFAULT_GENERATOR = "reference-ai-producer@1.0.0";

const PAGE_TYPE_FROM_SLUG = {
  landing: "landing",
  presell: "presell",
  checkout: "checkout",
  upsell: "upsell",
  downsell: "downsell",
  thankyou: "thankyou",
  receipt: "thankyou",
};

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: "string" },
      "campaign-slug": { type: "string" },
      generator: { type: "string", default: DEFAULT_GENERATOR },
      page: { type: "string", multiple: true, default: [] },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    printHelp();
    process.exit(0);
  }
  if (!values.source) {
    fail("--source <source-root> is required");
  }
  if (!values["campaign-slug"]) {
    fail("--campaign-slug <slug> is required");
  }
  return values;
}

function fail(message) {
  process.stderr.write(`reference-ai-producer: ${message}\n`);
  process.exit(1);
}

function printHelp() {
  process.stdout.write(`reference-ai-producer — emit a Slice-6 source-html-manifest from a folder of HTML files.

Usage:
  reference-ai-producer --source <root> --campaign-slug <slug> [--generator <name@version>] [--page page_id=path ...]

Options:
  --source           Source root that the manifest is rooted at. Must contain the HTML files.
  --campaign-slug    Public route slug (e.g. acme-v1). Written to manifest.campaign_slug.
  --generator        Generator identifier ("name@version"). Defaults to reference-ai-producer@1.0.0.
  --page             Repeatable. page_id=path mapping. Overrides auto-discovery.
                     Example: --page landing=presell-a.html --page checkout=checkout/step.html
  -h, --help         Show this help and exit.

Behavior:
  - Without --page args, walks <source> for *.html files and derives page_id from the basename
    (landing.html → "landing"). Skips files inside .campaigns-os/.
  - With --page args, only the explicitly mapped files are included. Paths must exist under <source>.
  - Each entry's source_hash is set to sha256(file contents) so doctor can detect drift.
`);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isHtmlFile(name) {
  return extname(name).toLowerCase() === ".html";
}

function walkHtmlFiles(sourceRoot) {
  const out = [];
  const queue = [sourceRoot];
  while (queue.length > 0) {
    const dir = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".campaigns-os") continue;
      if (entry.name === "node_modules") continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile() && isHtmlFile(entry.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

function derivePageId(filePath, sourceRoot) {
  const rel = relative(sourceRoot, filePath);
  const slug = basename(rel, extname(rel)).toLowerCase();
  return { page_id: slug, page_type: PAGE_TYPE_FROM_SLUG[slug] || null };
}

function buildEntriesFromAutoDiscovery(sourceRoot) {
  const htmlFiles = walkHtmlFiles(sourceRoot);
  const entries = htmlFiles.map((full) => {
    const { page_id, page_type } = derivePageId(full, sourceRoot);
    const path = relative(sourceRoot, full).replaceAll("\\", "/");
    const entry = { page_id, path, source_hash: sha256File(full) };
    if (page_type) entry.page_type = page_type;
    return entry;
  });
  // Deduplicate by page_id (last wins; warn if collisions). Standard pages
  // ship one file per page_type so collisions usually mean the operator
  // placed two files that derive the same slug.
  const seen = new Map();
  const collisions = [];
  for (const entry of entries) {
    if (seen.has(entry.page_id)) {
      collisions.push({ page_id: entry.page_id, paths: [seen.get(entry.page_id).path, entry.path] });
    }
    seen.set(entry.page_id, entry);
  }
  if (collisions.length > 0) {
    for (const collision of collisions) {
      process.stderr.write(`reference-ai-producer: page_id "${collision.page_id}" mapped to multiple files: ${collision.paths.join(", ")}. Last one wins; use --page to disambiguate.\n`);
    }
  }
  return [...seen.values()];
}

function buildEntriesFromExplicitMappings(sourceRoot, pageArgs) {
  const entries = [];
  for (const arg of pageArgs) {
    const idx = arg.indexOf("=");
    if (idx < 0) {
      fail(`--page argument "${arg}" must be page_id=path`);
    }
    const page_id = arg.slice(0, idx).trim();
    const path = arg.slice(idx + 1).trim();
    if (!page_id || !path) {
      fail(`--page argument "${arg}" must have non-empty page_id and path`);
    }
    const fullPath = resolve(sourceRoot, path);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      fail(`--page argument "${arg}" path "${path}" does not exist under source root ${sourceRoot}`);
    }
    const entry = { page_id, path, source_hash: sha256File(fullPath) };
    const inferred = PAGE_TYPE_FROM_SLUG[page_id];
    if (inferred) entry.page_type = inferred;
    entries.push(entry);
  }
  return entries;
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const sourceRoot = resolve(args.source);
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    fail(`source root does not exist or is not a directory: ${sourceRoot}`);
  }

  const pageArgs = Array.isArray(args.page) ? args.page : [];
  const entries = pageArgs.length > 0
    ? buildEntriesFromExplicitMappings(sourceRoot, pageArgs)
    : buildEntriesFromAutoDiscovery(sourceRoot);

  if (entries.length === 0) {
    fail(`no HTML files found under ${sourceRoot} (and no --page mappings supplied). Nothing to emit.`);
  }

  const manifest = {
    schema_version: MANIFEST_SCHEMA,
    generated_at: new Date().toISOString(),
    generator: args.generator || DEFAULT_GENERATOR,
    campaign_slug: args["campaign-slug"],
    root: ".",
    pages: entries,
  };

  const manifestPath = resolve(sourceRoot, MANIFEST_REL_PATH);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`reference-ai-producer: wrote ${entries.length} page entries to ${manifestPath}\n`);
}

main();
