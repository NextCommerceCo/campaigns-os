#!/usr/bin/env node

/**
 * Release-ledger gate: the two-way completeness check behind
 * campaigns-os-tooling-orientation/v1.
 *
 * Why it exists: contracts/supported-surface.json already makes a hashed-file
 * change loud, but a downstream agent orients on more than hashed bytes. A
 * renamed CLI flag, a rewritten contract doc, a new skill, or a changed
 * generated-runtime input can all leave the surface version untouched while
 * changing what the agent must do. A surface-version-only changelog misses
 * exactly those, so an agent that reads only the changelog cannot tell whether
 * it is safe to proceed.
 *
 * What it enforces:
 *   - structure:      the ledger validates against its schema, ids are unique,
 *                     sequence and date are ordered, each change identity is
 *                     recorded once, and no entry names the commit containing
 *                     it (introducing commits are derived from Git history);
 *   - changelog:      every entry links to exactly one CHANGELOG.md section and
 *                     carries that section body's hash;
 *   - consistency:    the schemas, the change policy, the reason codes, and the
 *                     limits agree with each other exactly;
 *   - limits:         the orientation source stays inside the declared bounds;
 *                     exceeding one is a refusal (orientation_too_large), never
 *                     a truncation;
 *   - --base REF:     the two-way gate. Every agent-relevant changed path has
 *                     exactly one ledger change item, every new change item
 *                     maps to a classified change or a reviewed amendment, and
 *                     historical entries are byte-identical to base.
 *
 * Without --base this validates the ledger as it stands. The completeness gate
 * needs a comparison point, so CI must pass --base; `npm run check` runs the
 * structural half locally.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  CHANGELOG_PATH,
  LEDGER_PATH,
  LEDGER_SCHEMA_PATH,
  LIMITS_PATH,
  ORIENTATION_SCHEMA_PATH,
  POLICY_PATH,
  REASON_CODES_PATH,
  SURFACE_PATH,
  classifyPaths,
  deriveIntroducingCommits,
  evaluateLimits,
  newEntriesSince,
  parseChangelogSections,
  validateAppendOnly,
  validateContractConsistency,
  validateLedgerStructure,
  validateTwoWayGate,
} from "./orientation-contract.mjs";

// fileURLToPath, never URL.pathname — see check-supported-surface.mjs.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const readText = (path) => readFileSync(join(root, path), "utf8");
const readJson = (path) => JSON.parse(readText(path));

function git(...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function gitSucceeds(...args) {
  try {
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function loadContracts(read = readJson, readRaw = readText) {
  return {
    ledger: read(LEDGER_PATH),
    policy: read(POLICY_PATH),
    limits: read(LIMITS_PATH),
    reasonCodes: read(REASON_CODES_PATH),
    surface: read(SURFACE_PATH),
    orientationSchema: read(ORIENTATION_SCHEMA_PATH),
    ledgerSchema: read(LEDGER_SCHEMA_PATH),
    changelogText: readRaw(CHANGELOG_PATH),
  };
}

/** Validate the ledger document against schemas/campaigns-os-release-ledger.v1.schema.json. */
export function validateAgainstSchema(ledger, ledgerSchema) {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(ledgerSchema);
  if (validate(ledger)) return [];
  return validate.errors.map((error) => `${LEDGER_PATH}${error.instancePath}: ${error.message}${error.params?.additionalProperty ? ` (${error.params.additionalProperty})` : ""}`);
}

/**
 * Measure the orientation source the way a consumer would: the bytes it reads
 * from Git objects at the target commit, plus the section and entry counts.
 */
export function measureOrientationSource({ changelogText, sections, ledger, contractBytes }) {
  return {
    source_bytes: Buffer.byteLength(changelogText, "utf8") + contractBytes,
    section_count: sections.length,
    max_observed_section_bytes: sections.reduce((max, section) => Math.max(max, section.bytes), 0),
    envelope_bytes: Buffer.byteLength(JSON.stringify(ledger), "utf8"),
    ledger_entries: (ledger.entries ?? []).length,
  };
}

function changedPathsSince(base) {
  const mergeBase = git("merge-base", base, "HEAD").trim();
  const paths = new Set(
    [
      ...git("diff", "--name-only", `${mergeBase}..HEAD`).split("\n"),
      ...git("diff", "--name-only", "HEAD").split("\n"),
      ...git("ls-files", "--others", "--exclude-standard").split("\n"),
    ].filter(Boolean),
  );
  return { mergeBase, paths: [...paths] };
}

function ledgerAt(ref) {
  if (!gitSucceeds("cat-file", "-e", `${ref}:${LEDGER_PATH}`)) return null;
  return JSON.parse(git("show", `${ref}:${LEDGER_PATH}`));
}

/**
 * Report which commit introduced each entry, derived from history rather than
 * stored. Entries that exist only in the working tree are reported as pending:
 * an uncommitted entry has no introducing commit yet, and pretending otherwise
 * is exactly the self-reference the contract forbids.
 */
export function deriveIntroducingCommitsFromGit(entryIds, base) {
  const range = gitSucceeds("rev-parse", "--verify", "--quiet", `${base}^{commit}`) ? `${base}..HEAD` : "HEAD";
  const commits = git("rev-list", "--reverse", "--topo-order", range, "--", LEDGER_PATH)
    .split("\n")
    .filter(Boolean);
  const derived = deriveIntroducingCommits(commits, (commit) => {
    const ledger = ledgerAt(commit);
    return ledger ? (ledger.entries ?? []).map((entry) => entry.id) : null;
  });
  return entryIds.map((id) => ({ id, introducing_commit: derived.get(id) ?? null }));
}

async function validate(base) {
  const errors = [];
  let contracts;
  try {
    contracts = loadContracts();
  } catch (error) {
    return [`could not load the orientation contract files: ${error.message}`];
  }

  const { ledger, policy, limits, reasonCodes, surface, orientationSchema, ledgerSchema, changelogText } = contracts;

  errors.push(...validateContractConsistency({ orientationSchema, ledgerSchema, policy, reasonCodes, limits }));
  errors.push(...validateAgainstSchema(ledger, ledgerSchema));

  const sections = parseChangelogSections(changelogText);
  const duplicateSections = sections
    .map((section) => section.section_id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateSections.length) {
    errors.push(`${CHANGELOG_PATH}: duplicate section identifiers (${[...new Set(duplicateSections)].join(", ")}) — a ledger entry could not link to exactly one`);
  }

  errors.push(...validateLedgerStructure(ledger, { policy, surface, sections }));

  const contractBytes = [LEDGER_PATH, POLICY_PATH, LIMITS_PATH, REASON_CODES_PATH, SURFACE_PATH]
    .reduce((total, path) => total + (existsSync(join(root, path)) ? readFileSync(join(root, path)).byteLength : 0), 0);
  const measured = measureOrientationSource({ changelogText, sections, ledger, contractBytes });
  const limitResult = evaluateLimits(measured, limits);
  if (!limitResult.within_limits) {
    errors.push(
      `orientation source exceeds the declared limits in ${LIMITS_PATH} (${limitResult.detail.join("; ")}) — ` +
        `a consumer must refuse with ${limitResult.reason_code}; nothing is truncated. Adopt a newer reviewed baseline or raise the limit as a reviewed policy change.`,
    );
  }

  if (!base) {
    console.log(
      `Release ledger is structurally intact: ${(ledger.entries ?? []).length} entries, ${sections.length} changelog sections, ` +
        `${measured.source_bytes} source bytes within limits ${limits.limits_version}. ` +
        `Pass --base <ref> for the two-way completeness gate.`,
    );
    return errors;
  }

  if (!gitSucceeds("rev-parse", "--verify", "--quiet", `${base}^{commit}`)) {
    return [...errors, `base comparison failed: ${JSON.stringify(base)} is not a resolvable ref`];
  }

  const { mergeBase, paths } = changedPathsSince(base);
  const classified = classifyPaths(paths, { policy, surface });
  const baseLedger = ledgerAt(mergeBase);
  const baseEntries = baseLedger?.entries ?? [];
  const headEntries = ledger.entries ?? [];

  if (baseLedger) errors.push(...validateAppendOnly(baseEntries, headEntries));

  const newEntries = newEntriesSince(baseEntries, headEntries);

  let baseSurfaceVersion = null;
  if (gitSucceeds("cat-file", "-e", `${mergeBase}:${SURFACE_PATH}`)) {
    baseSurfaceVersion = JSON.parse(git("show", `${mergeBase}:${SURFACE_PATH}`)).surface_version;
  }
  const surfaceBumped = Boolean(baseSurfaceVersion) && baseSurfaceVersion !== surface.surface_version;

  errors.push(
    ...validateTwoWayGate({
      classified,
      newEntries,
      surfaceBumped,
      surfaceVersion: surface.surface_version,
    }),
  );

  const derived = deriveIntroducingCommitsFromGit(headEntries.map((entry) => entry.id), mergeBase);
  const pending = derived.filter((row) => !row.introducing_commit).map((row) => row.id);

  console.log(
    `Release ledger checked against ${base} (merge-base ${mergeBase.slice(0, 8)}): ` +
      `${classified.relevant.length} agent-relevant paths, ${classified.ignored.length} ignored, ` +
      `${newEntries.length} new ledger entries, ${headEntries.length} total.`,
  );
  for (const row of derived) {
    console.log(`  ${row.id}: introduced by ${row.introducing_commit ? row.introducing_commit.slice(0, 8) : "(not yet committed)"}`);
  }
  if (pending.length && process.env.CI) {
    errors.push(`${LEDGER_PATH}: entries ${pending.join(", ")} have no introducing commit in ${mergeBase}..HEAD — commit them before the gate can derive their history`);
  }

  return errors;
}

async function main(argv) {
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex === -1 ? null : argv[baseIndex + 1];
  if (baseIndex !== -1 && !base) {
    console.error("--base requires a commit or ref");
    return 1;
  }

  const errors = await validate(base);
  if (errors.length) {
    console.error("Release-ledger validation failed:");
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log(`Release ledger is complete${base ? ` against ${base}` : ""}.`);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  process.exit(await main(process.argv.slice(2)));
}
