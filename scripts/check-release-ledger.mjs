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
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
import { ENVELOPE_FIXTURE_DIR } from "./generate-orientation-reference.mjs";

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
 *
 * These are WHOLE-FILE guardrails, and contracts/orientation-limits.v1.json says
 * so in every `applies_to`. This repository has one changelog and one ledger; it
 * cannot measure the narrower baseline-to-target window a consumer chooses,
 * because it does not know the consumer's baseline. Measuring the whole file is
 * the conservative direction: a window is always a subset of it.
 *
 * `envelope_bytes` is the largest ASSEMBLED envelope this repository ships —
 * the generated per-outcome fixtures under contracts/fixtures/orientation/
 * envelope/. The real envelope is assembled by the consumer and never exists
 * here, so the shipped examples are the only honest local stand-in. It is
 * deliberately NOT the serialized ledger: the ledger is source, not envelope,
 * and measuring one against the other's bound would be a bound on nothing.
 */
export function measureOrientationSource({ changelogText, sections, ledger, contractBytes, envelopeBytes }) {
  return {
    source_bytes: Buffer.byteLength(changelogText, "utf8") + contractBytes,
    section_count: sections.length,
    max_observed_section_bytes: sections.reduce((max, section) => Math.max(max, section.bytes), 0),
    envelope_bytes: envelopeBytes,
    ledger_entries: (ledger.entries ?? []).length,
  };
}

/** Largest shipped example envelope, in bytes. */
function largestEnvelopeFixtureBytes() {
  const dir = join(root, ENVELOPE_FIXTURE_DIR);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .reduce((max, name) => Math.max(max, readFileSync(join(dir, name)).byteLength), 0);
}

/**
 * `--no-renames` is load-bearing. Git's default rename detection reports only
 * the destination of a rename, so `git mv AGENTS.md docs/notes-archive.md`
 * would arrive as one unclassified new path and the disappearance of a named
 * supported-surface entry would be invisible to the gate. With --no-renames a
 * rename is what it actually is to a downstream consumer: a delete plus an add,
 * and both halves get classified.
 *
 * `-z` is load-bearing for the same reason at a smaller scale: without it Git
 * quotes any path containing non-ASCII or special bytes, and a quoted path
 * matches no rule, no surface entry, and no ignore — so it can never be
 * classified correctly, only reported as a mystery or (worse) swallowed.
 */
const nulSeparated = (text) => text.split("\0").filter(Boolean);

function changedPathsSince(base) {
  const mergeBase = git("merge-base", base, "HEAD").trim();
  const paths = new Set([
    ...nulSeparated(git("diff", "-z", "--no-renames", "--name-only", `${mergeBase}..HEAD`)),
    ...nulSeparated(git("diff", "-z", "--no-renames", "--name-only", "HEAD")),
    ...nulSeparated(git("ls-files", "-z", "--others", "--exclude-standard")),
  ]);
  return { mergeBase, paths: [...paths] };
}

/**
 * Classification must see the union of the base and head supported surfaces.
 *
 * Deleting a supported path removes it from the head manifest, and classifying
 * the deletion against the head manifest alone would drop it into a broad
 * ignore prefix — the removal of a path a consumer pins would pass the gate in
 * silence, and an honest ledger item recording it would be rejected for naming
 * "a path the policy excludes". The union classifies removals as agent-relevant,
 * which is what they are.
 */
export function unionSurface(baseSurface, headSurface) {
  const merge = (key) => [...new Set([...(baseSurface?.[key] ?? []), ...(headSurface?.[key] ?? [])])];
  return {
    ...headSurface,
    hashed: { ...(baseSurface?.hashed ?? {}), ...(headSurface?.hashed ?? {}) },
    named: merge("named"),
    cli_commands: merge("cli_commands"),
    package_exports: merge("package_exports"),
    bin: merge("bin"),
  };
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
 *
 * The walk is the FULL history ending at HEAD, never a merge-base..HEAD slice.
 * An entry introduced before the merge base was introduced by a commit outside
 * that slice, so a sliced walk either reports it as having no introducing commit
 * at all or — worse — credits the first in-range commit that touched the ledger
 * with introducing every entry that already existed. Both are wrong answers to a
 * question the contract says a consumer may rely on.
 *
 * `--full-history` is likewise not optional. Git's default history simplification
 * drops commits that are TREESAME to a parent along the chosen path, which on a
 * merged side branch can hide the commit that actually introduced an entry and
 * shift the credit to the merge. This is the same walk AGENTS.md tells a consumer
 * to perform, so the flag is documented there too.
 */
export function deriveIntroducingCommitsFromGit(entryIds) {
  const commits = git("rev-list", "--reverse", "--topo-order", "--full-history", "HEAD", "--", LEDGER_PATH)
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

  // The comparison range is resolved BEFORE structural validation, because two
  // of its inputs depend on the range: the supported surface to classify
  // against (the union of base and head, so removals classify) and which entries
  // may be path-classified at all (only the ones new in this range).
  let comparison = null;
  if (base) {
    if (!gitSucceeds("rev-parse", "--verify", "--quiet", `${base}^{commit}`)) {
      return [...errors, `base comparison failed: ${JSON.stringify(base)} is not a resolvable ref`];
    }
    const { mergeBase, paths } = changedPathsSince(base);
    const baseLedger = ledgerAt(mergeBase);
    const baseEntries = baseLedger?.entries ?? [];
    const headEntries = ledger.entries ?? [];
    const baseSurface = gitSucceeds("cat-file", "-e", `${mergeBase}:${SURFACE_PATH}`)
      ? JSON.parse(git("show", `${mergeBase}:${SURFACE_PATH}`))
      : null;
    comparison = {
      mergeBase,
      paths,
      baseLedger,
      baseEntries,
      headEntries,
      baseSurface,
      classifyingSurface: unionSurface(baseSurface, surface),
      newEntries: newEntriesSince(baseEntries, headEntries),
    };
  }

  errors.push(
    ...validateLedgerStructure(ledger, {
      policy,
      surface: comparison?.classifyingSurface ?? surface,
      sections,
      // Without a base there is no way to tell a new entry from a historical
      // one, so nothing is path-classified. Classification coverage comes from
      // the --base run CI performs and from the fixture matrix.
      classifiableEntryIds: comparison ? new Set(comparison.newEntries.map((entry) => entry.id)) : new Set(),
    }),
  );

  const contractBytes = [LEDGER_PATH, POLICY_PATH, LIMITS_PATH, REASON_CODES_PATH, SURFACE_PATH, ORIENTATION_SCHEMA_PATH, LEDGER_SCHEMA_PATH]
    .reduce((total, path) => total + (existsSync(join(root, path)) ? readFileSync(join(root, path)).byteLength : 0), 0);
  const measured = measureOrientationSource({
    changelogText,
    sections,
    ledger,
    contractBytes,
    envelopeBytes: largestEnvelopeFixtureBytes(),
  });
  const limitResult = evaluateLimits(measured, limits);
  if (!limitResult.within_limits) {
    errors.push(
      `orientation source exceeds the declared limits in ${LIMITS_PATH} (${limitResult.detail.join("; ")}) — ` +
        `a consumer must refuse with ${limitResult.reason_code}; nothing is truncated. Adopt a newer reviewed baseline or raise the limit as a reviewed policy change.`,
    );
  }

  if (!comparison) {
    console.log(
      `Release ledger is structurally intact: ${(ledger.entries ?? []).length} entries, ${sections.length} changelog sections, ` +
        `${measured.source_bytes} source bytes within limits ${limits.limits_version}. ` +
        `Pass --base <ref> for the two-way completeness gate and for path classification.`,
    );
    return errors;
  }

  const { mergeBase, paths, baseLedger, baseEntries, headEntries, baseSurface, classifyingSurface, newEntries } = comparison;
  const classified = classifyPaths(paths, { policy, surface: classifyingSurface });

  if (baseLedger) errors.push(...validateAppendOnly(baseEntries, headEntries));

  const surfaceBumped = Boolean(baseSurface?.surface_version) && baseSurface.surface_version !== surface.surface_version;

  errors.push(
    ...validateTwoWayGate({
      classified,
      newEntries,
      surfaceBumped,
      surfaceVersion: surface.surface_version,
    }),
  );

  // Derived over the full history ending at HEAD, so an entry introduced before
  // the merge base reports the commit that really introduced it.
  const derived = deriveIntroducingCommitsFromGit(headEntries.map((entry) => entry.id));
  const newIds = new Set(newEntries.map((entry) => entry.id));
  const pending = derived.filter((row) => !row.introducing_commit && newIds.has(row.id)).map((row) => row.id);

  console.log(
    `Release ledger checked against ${base} (merge-base ${mergeBase.slice(0, 8)}): ` +
      `${classified.relevant.length} agent-relevant paths, ${classified.ignored.length} ignored, ` +
      `${newEntries.length} new ledger entries, ${headEntries.length} total.`,
  );
  for (const row of derived) {
    console.log(`  ${row.id}: introduced by ${row.introducing_commit ? row.introducing_commit.slice(0, 8) : "(not yet committed)"}`);
  }
  // Only entries NEW in this range owe an introducing commit. A historical entry
  // with no derivable commit means the history was rewritten, which is the
  // append-only check's business, not this one's.
  if (pending.length && process.env.CI) {
    errors.push(`${LEDGER_PATH}: entries ${pending.join(", ")} are new in this range and have no introducing commit in history at HEAD — commit them before the gate can derive their history`);
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
