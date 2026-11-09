// Family script divergence (#729, #730 milestone 3): an advisory comparing
// the local scripts a campaign's built pages load (builtScriptReferences)
// against its template family's own scripts, so a campaign-owned edit of a
// family file is visible before the next family or SDK update lands on it.
//
// What it claims, and no more:
// - Bytes decide first: a built script identical to any family file is
//   `identical` whatever its name. Any other copy is nominated as a candidate
//   for the family file at the same built path (`js/upsells.js`), else the one
//   family file with its name, and diffed against it; a name several family
//   files share is `ambiguous`. A nomination is never ancestry: nothing a build
//   records today says which family file a campaign copy came from, so every
//   comparison is labelled `ancestry: "candidate"`. An edited copy under a new
//   name is not recognized.
// - Equal SHA-256 is equality. Unequal bytes get a line diff from the
//   reference bytes: line counts and hunks.
// - Generated configuration (`config.js`) is listed apart and never compared.
// - Every result names the reference used: the bundled public reference at its
//   upstream commit and SDK. A private family (never bundled) and a family the
//   bundled reference does not cover read as unavailable.
//
// Advisory: each diverged copy is one warning; nothing blocks.
import { basename, relative, sep } from "node:path";

import { builtScriptReferences } from "./built-script-syntax.mjs";
import { htmlScanDigest, readHtmlScanText } from "./html-scan.mjs";
import {
  FAMILY_SCRIPT_REFERENCE_FILE,
  LINE_DIFF_CELL_BUDGET,
  familyScriptReferenceText,
  lineDiffSummary,
  loadFamilyScriptReference,
} from "./family-script-reference.mjs";
import { loadPrivateTemplateSources } from "./private-template-source.mjs";

export const FAMILY_SCRIPT_DIVERGENCE = "built_output.family_script_divergence";
export const FAMILY_SCRIPT_DIVERGED = `${FAMILY_SCRIPT_DIVERGENCE}.diverged`;

const GENERATED_CONFIGURATION = ["config.js"];
// LCS cells one record may spend on line diffs, across all its pairs: the
// cells of four pairs at the per-pair bound, far more than a family's
// few-hundred-line scripts need. A pair refused for want of what remains does
// not spend it, so a later smaller pair may still be diffed.
export const FAMILY_SCRIPT_DIFF_CELL_BUDGET = 4 * LINE_DIFF_CELL_BUDGET;

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
  // Private families are never bundled. A comparison against a local private
  // checkout waits for a private template repo that declares where its
  // scripts live.
  if (Object.hasOwn(privateSources, family)) {
    return { unavailable: `"${family}" is a private family; its scripts are never bundled, and comparing against a local private checkout is not supported yet` };
  }
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
  const byHash = new Map();
  for (const script of reference.scripts) byHash.set(script.sha256, [...(byHash.get(script.sha256) || []), script]);
  const budget = { remaining: FAMILY_SCRIPT_DIFF_CELL_BUDGET };
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
    // Bytes decide before names: an exact match to any family file is
    // identical whatever the name says; only a copy that matches none is
    // diffed, against the family file at its built path, else the one file
    // with its name.
    const sameBytes = byHash.get(digest) || [];
    const atPath = local.built_path ? byBuiltPath.get(local.built_path) : null;
    if (atPath?.sha256 === digest) {
      record.scripts.push(comparison(file, local, "path", atPath, { result: "identical" }));
      continue;
    }
    if (sameBytes.length) {
      const extra = sameBytes.length > 1 ? { candidates: sameBytes.map((script) => script.built_path) } : {};
      record.scripts.push(comparison(file, local, "content", sameBytes[0], { result: "identical", ...extra }));
      continue;
    }
    const named = reference.scripts.filter((script) => basename(script.built_path) === basename(local.path));
    const [match, script] = atPath ? ["path", atPath] : named.length === 1 ? ["filename", named[0]] : [null, null];
    if (!script) {
      if (named.length > 1) record.scripts.push({ file, pages: local.pages, match: "ambiguous", ancestry: "candidate", result: "ambiguous", candidates: named.map((entry) => entry.built_path) });
      else record.not_compared += 1;
      continue;
    }
    let referenceText;
    try {
      referenceText = script.text();
    } catch (error) {
      record.scripts.push(comparison(file, local, match, script, { result: "unavailable", reason: error.message }));
      continue;
    }
    let localText;
    try {
      localText = readHtmlScanText(local.path);
    } catch {
      record.unreadable.push(file);
      continue;
    }
    record.scripts.push(comparison(file, local, match, script, { result: "diverged", diff: lineDiffSummary(localText, referenceText, budget) }));
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
    ? entry.diff.omitted === "record_budget"
      ? "hunks not listed: this record's shared diff budget was spent by the earlier diverged copies"
      : "hunks not listed: the pair is over the per-pair diff budget"
    : hunks.count === 0
      ? "the lines match apart from line endings or a final newline"
      : `${hunks.count} hunk(s) adding ${hunks.added} and removing ${hunks.removed} line(s), the first at line ${hunks.first[0].local_start}`;
  return `${entry.file} differs from the ${family} family file ${entry.reference_path} (candidate by ${nomination}; ancestry is not recorded) at ${label}, ${entry.source_path}: ${localLines} line(s) against ${referenceLines} (${delta >= 0 ? "+" : ""}${delta}), ${shape}. Advisory: confirm the campaign edit is intended before the next family or SDK update, or move it upstream.`;
}

function comparison(file, local, match, script, outcome) {
  return { file, pages: local.pages, match, ancestry: "candidate", reference_path: script.built_path, source_path: script.source_path, ...outcome };
}

function addWarning(collection, code, message, detail) {
  if (Array.isArray(collection)) collection.push({ code, message, detail });
}

function posix(path) {
  return path.split(sep).join("/");
}
