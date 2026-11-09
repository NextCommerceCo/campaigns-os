// The bundled family script reference (#729, #730 finding 7): the bytes,
// SHA-256 and provenance of an explicit list of public starter-family scripts,
// at the commit the vendored commerce-surface catalog was synced from. Doctor's
// family script divergence advisory compares a campaign's built copies against
// it. The rendered certified-family fixtures cannot serve: they are excluded
// from the npm package, and they are rendered output rather than the family's
// source files.
//
// Hashes establish equality; line and hunk deltas need the bytes, so each
// script's bytes ship beside the contract as one content-addressed blob per
// distinct SHA-256 (`contracts/family-script-reference/<sha256>.js.txt`; the
// .txt keeps tooling from treating vendored copies as this package's code).
// Generated configuration (`config.js`, rendered from campaign values) and
// private families are never bundled. scripts/refresh-family-script-reference.mjs
// writes both, and only from the catalog pin.
//
// Node built-ins only: scripts/check-pack.mjs imports this module from the
// extracted tarball, without node_modules, to prove an installed package can
// load every reference it names.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const FAMILY_SCRIPT_REFERENCE_SCHEMA = "family-script-reference/v0";
export const FAMILY_SCRIPT_REFERENCE_FILE = "contracts/family-script-reference.v0.json";
export const FAMILY_SCRIPT_REFERENCE_BLOB_DIR = "contracts/family-script-reference";

export function familyScriptReferenceBlobPath(sha256) {
  return `${FAMILY_SCRIPT_REFERENCE_BLOB_DIR}/${sha256}.js.txt`;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Read and validate the bundled reference. Throws on a missing file, a schema
 * mismatch or a malformed entry; blob bytes are read and verified per use by
 * familyScriptReferenceText.
 *
 * @param {{ root?: string }} [options] package root (tests and the pack check point it elsewhere)
 */
export function loadFamilyScriptReference({ root = ROOT } = {}) {
  const path = join(root, FAMILY_SCRIPT_REFERENCE_FILE);
  if (!existsSync(path)) throw referenceError("reference_missing", `Family script reference ${FAMILY_SCRIPT_REFERENCE_FILE} is not in this install.`);
  const reference = JSON.parse(readFileSync(path, "utf8"));
  if (reference?.schema_version !== FAMILY_SCRIPT_REFERENCE_SCHEMA) {
    throw referenceError("schema_mismatch", `${FAMILY_SCRIPT_REFERENCE_FILE} has schema_version ${JSON.stringify(reference?.schema_version)}; expected "${FAMILY_SCRIPT_REFERENCE_SCHEMA}".`);
  }
  if (!/^[0-9a-f]{40}$/.test(String(reference.source?.sha || ""))) {
    throw referenceError("schema_mismatch", `${FAMILY_SCRIPT_REFERENCE_FILE} names no 40-character source commit.`);
  }
  for (const [family, entry] of Object.entries(reference.families || {})) {
    for (const script of entry?.scripts || []) {
      if (!SHA256.test(String(script?.sha256 || "")) || typeof script.built_path !== "string" || typeof script.source_path !== "string") {
        throw referenceError("schema_mismatch", `${FAMILY_SCRIPT_REFERENCE_FILE} has a malformed script entry for family "${family}".`);
      }
    }
  }
  return Object.freeze({ ...reference, root });
}

/**
 * One reference script's text, read from its blob and verified against the
 * recorded hash, so a damaged install reads as unavailable, never as a diff.
 */
export function familyScriptReferenceText(reference, script) {
  const path = join(reference.root, familyScriptReferenceBlobPath(script.sha256));
  if (!existsSync(path)) throw referenceError("blob_missing", `Family script reference blob for ${script.source_path} is not in this install.`);
  const bytes = readFileSync(path);
  if (sha256Hex(bytes) !== script.sha256) throw referenceError("blob_mismatch", `Family script reference blob for ${script.source_path} does not match its recorded SHA-256.`);
  return bytes.toString("utf8");
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Lines as a reader counts them: a final newline ends the last line rather
// than starting an empty one.
export function splitLines(text) {
  const lines = String(text).split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Cells of the LCS table, after the common prefix and suffix are trimmed. The
// family scripts are a few hundred lines; a pair past this bound reports its
// line counts without hunks rather than spend seconds on an advisory. A caller
// diffing several pairs passes one shared `budget` of cells so the whole set is
// bounded too (each pair still allocates at most this many cells, 16 MB).
export const LINE_DIFF_CELL_BUDGET = 4_000_000;
const HUNKS_LISTED = 3;

/**
 * A line diff of `local` against `reference`: line counts, and the hunks
 * (maximal runs of changed lines, no context) of a longest-common-subsequence
 * alignment. A trailing carriage return is ignored when lines are compared, so
 * a copy that differs only in line endings reports no hunks; the caller has
 * the hashes to say the bytes still differ. `hunks` is null when the trimmed
 * pair exceeds LINE_DIFF_CELL_BUDGET (`omitted: "pair_budget"`) or what is
 * left of `budget.remaining` (`omitted: "record_budget"`); a diffed pair draws
 * the shared budget down by its cells, a refused one spends nothing.
 */
export function lineDiffSummary(local, reference, budget = { remaining: LINE_DIFF_CELL_BUDGET }) {
  const a = splitLines(local).map(stripCr);
  const b = splitLines(reference).map(stripCr);
  const summary = { local_lines: a.length, reference_lines: b.length, delta: a.length - b.length, hunks: null };
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const n = endA - start;
  const m = endB - start;
  const cells = (n + 1) * (m + 1);
  if (cells > LINE_DIFF_CELL_BUDGET) return { ...summary, omitted: "pair_budget" };
  if (cells > budget.remaining) return { ...summary, omitted: "record_budget" };
  budget.remaining -= cells;
  // lcs[i][j]: LCS length of a[start+i..endA) and b[start+j..endB).
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[start + i] === b[start + j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const hunks = [];
  let open = null;
  const close = () => {
    if (open) hunks.push(open);
    open = null;
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      close();
      i += 1;
      j += 1;
      continue;
    }
    open ??= { local_start: start + i + 1, local_lines: 0, reference_start: start + j + 1, reference_lines: 0 };
    if (j < m && (i === n || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) {
      open.reference_lines += 1;
      j += 1;
    } else {
      open.local_lines += 1;
      i += 1;
    }
  }
  close();
  summary.hunks = {
    count: hunks.length,
    added: hunks.reduce((sum, hunk) => sum + hunk.local_lines, 0),
    removed: hunks.reduce((sum, hunk) => sum + hunk.reference_lines, 0),
    first: hunks.slice(0, HUNKS_LISTED),
  };
  return summary;
}

function stripCr(line) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function referenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
