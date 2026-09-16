// Local proof mode: a campaign under `deploy.target: local-serve` is built
// with the page-kit DEVELOPMENT environment, served on localhost, and proven
// there (polish capture, browser QA, typed-card orders) before anything is
// committed. The production build is never served locally: the starter
// templates gate every vendor loader on `{% unless environment ==
// "development" %}`, several of those loaders are protocol-relative
// (`//host/...`), and over a plain-HTTP local serve they resolve to http://
// and fail, which voids the capture unwaivably. Editing the generated include
// to force https: is not a repair; serving the right environment is.
//
// What this module owns:
//   - the development build command the build stage runs under local-serve;
//   - the production-parity check: the proven development output must be what
//     the current source renders in development, and the production render of
//     the same source may differ from it ONLY in what the environment gate
//     contributes. "Gated" is derived, not declared: it is the diff between a
//     development render and a production render of the same source, so no
//     vendor list lives here.
//   - the never-edit rule as one string every renderer quotes.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, sep } from "node:path";

import { PAGE_KIT_BUILD_SUMMARY_CAPTURE_COMMAND } from "./page-kit-build-summary.mjs";

export const LOCAL_PROOF_BUILD_ENVIRONMENT = "development";
export const LOCAL_PROOF_PRODUCTION_ENVIRONMENT = "production";
export const LOCAL_PROOF_BUILD_COMMAND = `CPK_ENV=${LOCAL_PROOF_BUILD_ENVIRONMENT} ${PAGE_KIT_BUILD_SUMMARY_CAPTURE_COMMAND}`;
export const LOCAL_PROOF_PARITY_SCOPE = "local_proof.production_parity";
export const LOCAL_PROOF_BUILD_ENVIRONMENT_SCOPE = "local_proof.build_environment";
export const LOCAL_PROOF_PARITY_COMMAND = "campaigns-os page-kit parity --packet <packet>";
// Where the build stage records which environment it rendered, and where the
// parity command records its result. Both live under the assembly stage's
// free-form `evidence` object, which the hashed Assembly Report schema already
// allows, so neither needs a schema change.
export const LOCAL_PROOF_BUILD_ENVIRONMENT_FIELD = "stages.assembly.evidence.build_environment";
export const LOCAL_PROOF_PARITY_FIELD = "stages.assembly.evidence.local_proof.production_parity";
export const LOCAL_PROOF_NEVER_EDIT_RULE = "Never edit a generated include (analytics-head.html, analytics-body.html, or any _includes/ file marked GENERATED) to make a local capture pass: a vendor loader that fails over plain HTTP is the production build served in the wrong environment, not a template defect.";

// The one line every renderer prints when a capture over plain HTTP failed on
// a cross-origin http: dependency — the signature of a protocol-relative
// production loader served locally.
export function localProofRebuildText() {
  return `The served build is a production build over plain HTTP: a cross-origin http: dependency failed to load, which is what a protocol-relative vendor loader (//host/...) does off an http://localhost origin. Rebuild in local proof mode — \`${LOCAL_PROOF_BUILD_COMMAND}\` — record ${LOCAL_PROOF_BUILD_ENVIRONMENT_FIELD} as "${LOCAL_PROOF_BUILD_ENVIRONMENT}", serve the development output, and recapture. ${LOCAL_PROOF_NEVER_EDIT_RULE}`;
}

export function isLocalServePacket(packet) {
  return packet?.deploy?.target === "local-serve";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

export function recordedBuildEnvironment(report) {
  return nonEmptyString(report?.stages?.assembly?.evidence?.build_environment);
}

export function recordedProductionParity(report) {
  const value = report?.stages?.assembly?.evidence?.local_proof?.production_parity;
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Rendered-output readers
// ---------------------------------------------------------------------------

const SDK_LOADER_SRC = /campaign-cart(?:@v?([^"'/]*))?\/dist\/loader\.js/i;

// The pin as the rendered page carries it: the Campaign Cart loader src (with
// the version it pins) and the next-api-key meta when the page declares one.
export function renderedPagePin(html) {
  const text = typeof html === "string" ? html : "";
  let loaderSrc = null;
  let sdkVersion = null;
  for (const tag of text.matchAll(/<script\b[^>]*>/gi)) {
    const srcMatch = tag[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const loader = srcMatch[1].match(SDK_LOADER_SRC);
    if (!loader) continue;
    loaderSrc = srcMatch[1];
    sdkVersion = loader[1] || null;
    break;
  }
  let apiKeyMeta = null;
  for (const tag of text.matchAll(/<meta\b[^>]*>/gi)) {
    const name = tag[0].match(/\bname\s*=\s*["']([^"']+)["']/i);
    if (!name || name[1] !== "next-api-key") continue;
    const content = tag[0].match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    apiKeyMeta = content ? content[1] : "";
    break;
  }
  return { sdk_loader_src: loaderSrc, sdk_version: sdkVersion, api_key_meta: apiKeyMeta };
}

// Every rendered page under <root>/<slug>/, as slug-relative POSIX paths
// (`index.html`, `checkout/index.html`), sorted. Assets are not pages: page-kit
// copies them byte for byte in every environment, and the build fingerprint
// already covers them.
export function listRenderedPages(root, slug) {
  const base = join(root, slug);
  if (!existsSync(base) || !statSync(base).isDirectory()) return [];
  const pages = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === "index.html") {
        pages.push(relative(base, full).split(sep).join(posix.sep));
      }
    }
  };
  walk(base);
  return pages.sort();
}

export function renderedPageRoute(slug, pagePath) {
  const dir = posix.dirname(pagePath);
  return dir === "." ? `/${slug}/` : `/${slug}/${dir}/`;
}

// ---------------------------------------------------------------------------
// Line diff (common prefix/suffix, then LCS on the middle)
// ---------------------------------------------------------------------------

function lineDiff(aLines, bLines) {
  let start = 0;
  while (start < aLines.length && start < bLines.length && aLines[start] === bLines[start]) start += 1;
  let aEnd = aLines.length;
  let bEnd = bLines.length;
  while (aEnd > start && bEnd > start && aLines[aEnd - 1] === bLines[bEnd - 1]) {
    aEnd -= 1;
    bEnd -= 1;
  }
  const a = aLines.slice(start, aEnd);
  const b = bLines.slice(start, bEnd);
  const n = a.length;
  const m = b.length;
  // LCS table on the trimmed middle only; the gated block is small next to the page.
  const table = new Array(n + 1);
  for (let i = 0; i <= n; i += 1) table[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const removed = [];
  const inserted = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      removed.push({ line: start + i + 1, text: a[i] });
      i += 1;
    } else {
      inserted.push({ line: start + j + 1, text: b[j] });
      j += 1;
    }
  }
  for (; i < n; i += 1) removed.push({ line: start + i + 1, text: a[i] });
  for (; j < m; j += 1) inserted.push({ line: start + j + 1, text: b[j] });
  return { removed, inserted };
}

// Rendered lines, with either line ending: a CRLF render must diff and number
// exactly like an LF one, so the terminator is never part of the compared text.
function renderedLines(text) {
  return text.split(/\r?\n/);
}

function firstDifferingLine(aText, bText) {
  const a = renderedLines(aText);
  const b = renderedLines(bText);
  const limit = Math.min(a.length, b.length);
  for (let index = 0; index < limit; index += 1) {
    if (a[index] !== b[index]) return index + 1;
  }
  return a.length === b.length ? null : limit + 1;
}

// Hosts named by the lines the environment gate contributes, so the summary
// says which loaders production adds without naming any vendor here.
function gatedHosts(lines) {
  const hosts = new Set();
  for (const { text } of lines) {
    for (const match of text.matchAll(/(?<![\w.-])((?:https?:)?\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?)\//gi)) {
      hosts.add(match[1]);
    }
  }
  return [...hosts].sort();
}

// ---------------------------------------------------------------------------
// The parity comparison
// ---------------------------------------------------------------------------

function readPage(root, slug, pagePath) {
  return readFileSync(join(root, slug, pagePath), "utf8");
}

/**
 * Compare three rendered outputs of one campaign:
 *   provenRoot      — the served development build the campaign was proven on
 *                     (normally the target's _site/);
 *   developmentRoot — a fresh development render of the current source;
 *   productionRoot  — a fresh production render of the current source.
 *
 * Pass: every page in the proven output is byte-identical to the fresh
 * development render (nothing changed since the proof), the page set and
 * route slugs agree across all three, and the pin (Campaign Cart loader
 * version and next-api-key meta) is the same in the proven and production
 * pages and matches `expectedSdkVersion` when one is given. The production
 * render's remaining difference from the development render is, by
 * construction, the environment gate's output; it is summarised per page,
 * never judged.
 *
 * Fail: the first non-gated difference, named by route, path, kind and line.
 */
export function compareRenderedOutputs({ provenRoot, developmentRoot, productionRoot, slug, expectedSdkVersion = null }) {
  const proven = listRenderedPages(provenRoot, slug);
  const development = listRenderedPages(developmentRoot, slug);
  const production = listRenderedPages(productionRoot, slug);
  const pages = [];
  const fail = (difference) => ({
    status: "fail",
    campaign_slug: slug,
    page_count: proven.length,
    pages,
    first_difference: difference,
    summary: `${difference.kind} at ${difference.route}${difference.line ? ` line ${difference.line}` : ""}: ${difference.detail}`,
  });

  if (proven.length === 0) {
    return fail({ kind: "proven_output_missing", route: `/${slug}/`, path: null, line: null, detail: `no rendered pages under ${posix.join(relativeLabel(provenRoot), slug)}/; run the development build first.` });
  }
  for (const pagePath of proven) {
    const route = renderedPageRoute(slug, pagePath);
    if (!development.includes(pagePath)) {
      return fail({ kind: "page_not_in_source", route, path: pagePath, line: null, detail: "the proven output carries a page the current source no longer renders (a stale file left in the served output); rebuild before proving." });
    }
    if (!production.includes(pagePath)) {
      return fail({ kind: "page_missing_in_production", route, path: pagePath, line: null, detail: "the production render does not produce this page." });
    }
  }
  for (const pagePath of development) {
    if (!proven.includes(pagePath)) {
      return fail({ kind: "page_not_proven", route: renderedPageRoute(slug, pagePath), path: pagePath, line: null, detail: "the current source renders a page the proven output lacks; rebuild and re-prove." });
    }
  }
  for (const pagePath of production) {
    if (!proven.includes(pagePath)) {
      return fail({ kind: "page_only_in_production", route: renderedPageRoute(slug, pagePath), path: pagePath, line: null, detail: "the production render produces a page the development render does not; page routing must not depend on the environment." });
    }
  }

  let sdkVersion;
  for (const pagePath of proven) {
    const route = renderedPageRoute(slug, pagePath);
    const provenHtml = readPage(provenRoot, slug, pagePath);
    const developmentHtml = readPage(developmentRoot, slug, pagePath);
    const productionHtml = readPage(productionRoot, slug, pagePath);
    const provenPin = renderedPagePin(provenHtml);
    const productionPin = renderedPagePin(productionHtml);
    if (provenHtml !== developmentHtml) {
      const line = firstDifferingLine(provenHtml, developmentHtml);
      const developmentPin = renderedPagePin(developmentHtml);
      // The two ways this goes wrong that have a name: the pin moved after the
      // proof, or the served output is the production render itself.
      if (provenPin.sdk_loader_src !== developmentPin.sdk_loader_src) {
        return fail({ kind: "sdk_pin_drift", route, path: pagePath, line, detail: `the proven output pins Campaign Cart ${provenPin.sdk_version ?? "(none)"} but the current source renders ${developmentPin.sdk_version ?? "(none)"}; the pin changed after the proof. Rebuild in development, re-prove, then check parity again.` });
      }
      if (provenHtml === productionHtml) {
        return fail({ kind: "proven_output_is_production", route, path: pagePath, line, detail: `the served output is the production render, not a development one: the environment gate's output is present. Rebuild with ${LOCAL_PROOF_BUILD_COMMAND} and re-prove; do not serve a production build locally.` });
      }
      return fail({ kind: "proven_output_stale", route, path: pagePath, line, detail: "the proven development output differs from what the current source renders in development; the source changed after the proof (rebuild, re-prove, then check parity again)." });
    }
    if (provenPin.sdk_loader_src !== productionPin.sdk_loader_src) {
      return fail({ kind: "sdk_pin_mismatch", route, path: pagePath, line: null, detail: `Campaign Cart loader differs between the proven output (${provenPin.sdk_loader_src ?? "none"}) and the production render (${productionPin.sdk_loader_src ?? "none"}); the SDK pin must not be environment-gated.` });
    }
    if (provenPin.api_key_meta !== productionPin.api_key_meta) {
      return fail({ kind: "api_key_meta_mismatch", route, path: pagePath, line: null, detail: "the next-api-key meta differs between the proven output and the production render." });
    }
    if (expectedSdkVersion && provenPin.sdk_version && provenPin.sdk_version !== expectedSdkVersion) {
      return fail({ kind: "sdk_version_mismatch", route, path: pagePath, line: null, detail: `the rendered Campaign Cart loader pins ${provenPin.sdk_version} but _data/campaigns.json[${slug}].sdk_version is ${expectedSdkVersion}.` });
    }
    // A missing loader is a value like any other: every page must agree with
    // the first page, and a page that lost its loader fails on its own code.
    if (sdkVersion === undefined) sdkVersion = provenPin.sdk_version;
    else if (provenPin.sdk_version !== sdkVersion) {
      return fail({
        kind: provenPin.sdk_version === null || sdkVersion === null ? "sdk_loader_missing" : "sdk_version_mismatch",
        route,
        path: pagePath,
        line: null,
        detail: provenPin.sdk_version === null
          ? `this page renders no Campaign Cart loader while ${pages[0]?.route ?? "the first page"} pins ${sdkVersion}.`
          : sdkVersion === null
            ? `this page pins Campaign Cart ${provenPin.sdk_version} while ${pages[0]?.route ?? "the first page"} renders no loader.`
            : `pages pin different Campaign Cart versions (${sdkVersion} and ${provenPin.sdk_version}).`,
      });
    }
    const diff = lineDiff(renderedLines(developmentHtml), renderedLines(productionHtml));
    pages.push({
      route,
      path: pagePath,
      sdk_version: provenPin.sdk_version,
      gated_inserted_lines: diff.inserted.length,
      gated_removed_lines: diff.removed.length,
      gated_hosts: gatedHosts(diff.inserted),
    });
  }
  const gatedTotal = pages.reduce((sum, page) => sum + page.gated_inserted_lines + page.gated_removed_lines, 0);
  const hosts = [...new Set(pages.flatMap((page) => page.gated_hosts))].sort();
  return {
    status: "pass",
    campaign_slug: slug,
    page_count: pages.length,
    sdk_version: sdkVersion ?? null,
    pages,
    first_difference: null,
    summary: `${pages.length} page(s) identical to the current development render; production differs only in environment-gated output (${gatedTotal} line(s)${hosts.length ? `; loaders: ${hosts.join(", ")}` : ""}); Campaign Cart pin ${sdkVersion ?? "not rendered"}.`,
  };
}

function relativeLabel(root) {
  const rel = relative(process.cwd(), root);
  return rel && !rel.startsWith("..") ? rel : root;
}

// ---------------------------------------------------------------------------
// Rendering through the target's own page-kit
// ---------------------------------------------------------------------------

// Renders the target's source with the page-kit the target installed, into
// `outputPath`, in the given environment. `campaign-build` has no output-dir
// flag, so this goes through the package's exported build() — the same
// function the bin calls — with cwd at the target so page-kit resolves
// _data/campaigns.json and src/ exactly as `npx campaign-build` would.
export function renderPageKitOutput({ targetRepo, environment, outputPath }) {
  const script = [
    'const { build } = require("next-campaign-page-kit");',
    "build({ outputPath: process.argv[1], mode: process.argv[2] }).then((summary) => {",
    "  process.stdout.write(JSON.stringify({ built: summary.built, errors: summary.errors, skipped: summary.skipped }));",
    "  if (summary.errors > 0) process.exitCode = 1;",
    "}).catch((error) => { process.stderr.write(String((error && error.message) || error)); process.exitCode = 2; });",
  ].join("\n");
  try {
    const stdout = execFileSync(process.execPath, ["-e", script, outputPath, environment], {
      cwd: targetRepo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CPK_ENV: environment },
    });
    return { ok: true, summary: JSON.parse(stdout || "{}"), error: null };
  } catch (error) {
    const stderr = String(error?.stderr || error?.message || error).trim().split("\n")[0];
    const missing = /Cannot find module ['"]next-campaign-page-kit['"]/.test(String(error?.stderr || ""));
    return { ok: false, summary: null, error: missing ? "next-campaign-page-kit is not installed in the target repo (npm install there first)." : stderr };
  }
}

/**
 * Run the production-parity check for one packet against the proven output in
 * `provenRoot` (the served development build). Renders development and
 * production output into temp directories through the target's page-kit and
 * compares. Never writes into the target repo.
 */
export function runProductionParityCheck({ targetRepo, slug, provenRoot, expectedSdkVersion = null, now = new Date().toISOString() }) {
  const scratch = mkdtempSync(join(tmpdir(), "campaigns-os-local-proof-"));
  try {
    const developmentRoot = join(scratch, "development");
    const productionRoot = join(scratch, "production");
    for (const [environment, outputPath] of [[LOCAL_PROOF_BUILD_ENVIRONMENT, developmentRoot], [LOCAL_PROOF_PRODUCTION_ENVIRONMENT, productionRoot]]) {
      const render = renderPageKitOutput({ targetRepo, environment, outputPath });
      if (!render.ok) {
        return {
          status: "unavailable",
          checked_at: now,
          campaign_slug: slug,
          environment: { proven: LOCAL_PROOF_BUILD_ENVIRONMENT, compared: LOCAL_PROOF_PRODUCTION_ENVIRONMENT },
          pages: [],
          first_difference: null,
          summary: `could not render the ${environment} output through the target's page-kit: ${render.error}`,
        };
      }
    }
    const comparison = compareRenderedOutputs({ provenRoot, developmentRoot, productionRoot, slug, expectedSdkVersion });
    return {
      checked_at: now,
      environment: { proven: LOCAL_PROOF_BUILD_ENVIRONMENT, compared: LOCAL_PROOF_PRODUCTION_ENVIRONMENT },
      ...comparison,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
