// Family script divergence (#729, #730 milestone 3): an advisory comparing
// the local scripts a campaign's built pages load (builtScriptReferences)
// against its template family's own scripts, so a campaign-owned edit of a
// family file is visible before the next family or SDK update lands on it.
//
// What it claims, and no more:
// - A built script is nominated as a family-file candidate by the same built
//   path (`js/upsells.js`), else by a unique file name, else by identical
//   bytes under another name. A nomination is never ancestry: nothing a build
//   records today says which family file a campaign copy came from, so every
//   comparison is labelled `ancestry: "candidate"`. An edited copy under a new
//   name is not recognized.
// - Equal SHA-256 is equality. Unequal bytes get a line diff from the
//   reference bytes: line counts and hunks.
// - Generated configuration (`config.js`) is listed apart and never compared.
// - Every result names the reference used: the bundled public reference at its
//   upstream commit and SDK, or a private family's local source. A private
//   family without a resolvable local source, or a family the bundled
//   reference does not cover, reads as unavailable.
//
// Advisory: each diverged copy is one warning; nothing blocks.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, relative, sep } from "node:path";

import { builtScriptReferences } from "./built-script-syntax.mjs";
import { htmlScanDigest, readHtmlScanText } from "./html-scan.mjs";
import {
  FAMILY_SCRIPT_REFERENCE_FILE,
  familyScriptReferenceText,
  lineDiffSummary,
  loadFamilyScriptReference,
  sha256Hex,
} from "./family-script-reference.mjs";
import { loadPrivateTemplateSources, resolvePrivateTemplateSourceFragment } from "./private-template-source.mjs";

export const FAMILY_SCRIPT_DIVERGENCE = "built_output.family_script_divergence";
export const FAMILY_SCRIPT_DIVERGED = `${FAMILY_SCRIPT_DIVERGENCE}.diverged`;

const GENERATED_CONFIGURATION = ["config.js"];

/**
 * The reference for `family`: `{ kind, repo, sha, sdk_version, label,
 * generated, scripts: [{ built_path, source_path, sha256, text() }] }`, or
 * `{ unavailable: reason }`.
 *
 * @param {string} family
 * @param {{ loadReference?: () => object }} [options] tests substitute the bundled reference
 */
export function resolveFamilyScriptReference(family, { loadReference = loadFamilyScriptReference } = {}) {
  let privateSources;
  try {
    privateSources = loadPrivateTemplateSources();
  } catch (error) {
    return { unavailable: `the private template source allowlist could not be read (${error.message})` };
  }
  if (Object.hasOwn(privateSources, family)) return privateFamilyReference(family, privateSources[family]);
  let reference;
  try {
    reference = loadReference();
  } catch (error) {
    return { unavailable: `the bundled family script reference could not be read (${error.message})` };
  }
  const entry = reference.families?.[family];
  if (!entry) {
    return { unavailable: `${FAMILY_SCRIPT_REFERENCE_FILE} has no scripts for family "${family}"; it covers ${Object.keys(reference.families || {}).sort().join(", ")}` };
  }
  const sha = reference.source.sha;
  return {
    kind: "bundled",
    repo: reference.source.repo,
    sha,
    sdk_version: entry.sdk_version ?? null,
    label: `${reference.source.repo}@${sha.slice(0, 7)}${entry.sdk_version ? ` (SDK ${entry.sdk_version})` : ""}`,
    generated: (reference.generated_configuration || []).map((rule) => rule.built_path),
    scripts: entry.scripts.map((script) => ({
      built_path: script.built_path,
      source_path: script.source_path,
      sha256: script.sha256,
      text: () => familyScriptReferenceText(reference, script),
    })),
  };
}

// A private family is never bundled. Its local source is the directory its
// contract fragment names (`script_reference.source_root`) in its sibling
// checkout, read as the working tree stands; the reference version is that
// checkout's HEAD commit.
function privateFamilyReference(family, entry) {
  let fragment;
  try {
    fragment = resolvePrivateTemplateSourceFragment(family);
  } catch (error) {
    return { unavailable: `"${family}" is a private family and its source did not resolve (${error.message})` };
  }
  const sourceRoot = fragment?.scriptReference?.source_root;
  if (typeof sourceRoot !== "string" || !sourceRoot) {
    return { unavailable: `"${family}" is a private family and its contract fragment names no script_reference.source_root to compare against` };
  }
  const root = join(fragment.repoDir, sourceRoot);
  if (!existsSync(join(root, "js"))) {
    return { unavailable: `"${family}" is a private family and its local source ${sourceRoot}/js is not in the ${entry.repo} checkout` };
  }
  let sha = null;
  try {
    sha = execFileSync("git", ["-C", fragment.repoDir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    sha = null;
  }
  const scripts = [];
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.isFile() && item.name.endsWith(".js")) {
        const bytes = readFileSync(full);
        const builtPath = posix(relative(root, full));
        scripts.push({ built_path: builtPath, source_path: `${sourceRoot}/${builtPath}`, sha256: sha256Hex(bytes), text: () => bytes.toString("utf8") });
      }
    }
  };
  walk(join(root, "js"));
  return {
    kind: "local_private_source",
    repo: entry.repo,
    sha,
    sdk_version: null,
    label: `the local ${entry.repo} checkout at ${sha ? sha.slice(0, 7) : "an unknown commit"} (working tree)`,
    generated: GENERATED_CONFIGURATION,
    scripts,
  };
}

/**
 * The local scripts a scope's built pages load, one entry per file in first
 * reference order: `{ path, built_path, pages }`, where `built_path` is the
 * path below the campaign directory (null for a file outside it).
 */
export function familyScriptCandidates(scope) {
  const byPath = new Map();
  for (const ref of builtScriptReferences(scope).refs) {
    if (ref.status !== "local") continue;
    if (!byPath.has(ref.path)) {
      const rel = relative(scope.campaign_dir, ref.path);
      byPath.set(ref.path, { path: ref.path, built_path: rel && !rel.startsWith("..") ? posix(rel) : null, pages: [] });
    }
    const entry = byPath.get(ref.path);
    if (!entry.pages.includes(ref.page_id)) entry.pages.push(ref.page_id);
  }
  return [...byPath.values()];
}

/**
 * Compare a scope's built scripts with the family reference. Reads script
 * bytes through the run's shared input snapshot.
 *
 * @param {{ scope: object, targetRepo: string, family: string, familySource: "packet" | "flag", reference?: object }} input
 */
export function collectFamilyScriptDivergence({ scope, targetRepo, family, familySource, reference = resolveFamilyScriptReference(family) }) {
  const record = {
    family,
    family_source: familySource,
    reference: reference.unavailable ? null : { kind: reference.kind, repo: reference.repo, sha: reference.sha, sdk_version: reference.sdk_version, label: reference.label },
    status: reference.unavailable ? "unavailable" : "compared",
    reason: reference.unavailable || null,
    scripts: [],
    generated_configuration: [],
    not_compared: 0,
    unreadable: [],
  };
  if (reference.unavailable) return record;
  const byBuiltPath = new Map(reference.scripts.map((script) => [script.built_path, script]));
  const byHash = new Map(reference.scripts.map((script) => [script.sha256, script]));
  for (const local of familyScriptCandidates(scope)) {
    const file = posix(relative(targetRepo, local.path));
    if (local.built_path && reference.generated.includes(local.built_path)) {
      record.generated_configuration.push({ file, built_path: local.built_path, pages: local.pages });
      continue;
    }
    let digest;
    try {
      digest = htmlScanDigest(local.path);
    } catch {
      record.unreadable.push(file);
      continue;
    }
    const name = basename(local.path);
    const named = reference.scripts.filter((script) => basename(script.built_path) === name);
    let match = null;
    let script = null;
    if (local.built_path && byBuiltPath.has(local.built_path)) [match, script] = ["path", byBuiltPath.get(local.built_path)];
    else if (named.length === 1) [match, script] = ["filename", named[0]];
    else if (named.length > 1) {
      record.scripts.push({ file, pages: local.pages, match: "ambiguous", ancestry: "candidate", result: "ambiguous", candidates: named.map((entry) => entry.built_path) });
      continue;
    } else if (byHash.has(digest)) [match, script] = ["content", byHash.get(digest)];
    else {
      record.not_compared += 1;
      continue;
    }
    const entry = { file, pages: local.pages, match, ancestry: "candidate", reference_path: script.built_path, source_path: script.source_path };
    if (digest === script.sha256) {
      record.scripts.push({ ...entry, result: "identical" });
      continue;
    }
    let referenceText;
    try {
      referenceText = script.text();
    } catch (error) {
      record.scripts.push({ ...entry, result: "unavailable", reason: error.message });
      continue;
    }
    record.scripts.push({ ...entry, result: "diverged", diff: lineDiffSummary(readHtmlScanText(local.path), referenceText) });
  }
  return record;
}

/**
 * Project the record onto doctor's output: one warning per diverged copy, one
 * ready line, and the record itself as `derived.family_script_divergence`.
 */
export function recordFamilyScriptDivergence({ record, warnings, ready, derived }) {
  if (derived && typeof derived === "object") derived.family_script_divergence = record;
  if (record.status === "unavailable") {
    ready.push(`Family script divergence not compared for ${record.family}: ${record.reason}.`);
    return record;
  }
  const label = record.reference.label;
  for (const entry of record.scripts) {
    if (entry.result !== "diverged") continue;
    addWarning(warnings, FAMILY_SCRIPT_DIVERGED, divergedMessage(record.family, label, entry), { finding: entry, reference: record.reference });
  }
  const count = (result) => record.scripts.filter((entry) => entry.result === result).length;
  const parts = [`${record.scripts.length} candidate family script(s)`, `${count("identical")} identical`, `${count("diverged")} diverged`];
  if (count("ambiguous")) parts.push(`${count("ambiguous")} matching more than one family file by name`);
  if (count("unavailable")) parts.push(`${count("unavailable")} whose reference bytes could not be read`);
  const notes = [];
  if (record.generated_configuration.length) notes.push(`generated configuration not compared: ${record.generated_configuration.map((entry) => entry.file).join(", ")}`);
  if (record.not_compared) notes.push(`${record.not_compared} other campaign script(s) match no family file`);
  if (record.unreadable.length) notes.push(`unreadable: ${record.unreadable.join(", ")}`);
  ready.push(`Family scripts compared with ${record.family} at ${label} (advisory): ${parts.join(", ")}${notes.length ? `; ${notes.join("; ")}` : ""}.`);
  return record;
}

function divergedMessage(family, label, entry) {
  const nomination = { path: "same built path", filename: "same file name", content: "same bytes" }[entry.match];
  const { local_lines: localLines, reference_lines: referenceLines, delta, hunks } = entry.diff;
  const shape = hunks === null
    ? "too large to list hunks"
    : hunks.count === 0
      ? "the lines match apart from line endings or a final newline"
      : `${hunks.count} hunk(s) adding ${hunks.added} and removing ${hunks.removed} line(s), the first at line ${hunks.first[0].local_start}`;
  return `${entry.file} differs from the ${family} family file ${entry.reference_path} (candidate by ${nomination}; ancestry is not recorded) at ${label}, ${entry.source_path}: ${localLines} line(s) against ${referenceLines} (${delta >= 0 ? "+" : ""}${delta}), ${shape}. Advisory: confirm the campaign edit is intended before the next family or SDK update, or move it upstream.`;
}

function addWarning(collection, code, message, detail) {
  if (Array.isArray(collection)) collection.push({ code, message, detail });
}

function posix(path) {
  return path.split(sep).join("/");
}
