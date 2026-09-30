#!/usr/bin/env node

/**
 * Shared, side-effect-free implementation of the Campaigns OS orientation
 * contract: the changed-path classifier, release-ledger validation, changelog
 * correspondence, append-only enforcement, bounded-read limits, and
 * introducing-commit derivation.
 *
 * Everything here is pure. Git and the filesystem are injected by the callers
 * (scripts/check-release-ledger.mjs, scripts/generate-orientation-reference.mjs)
 * so the whole contract is testable from fixtures without a repository.
 *
 * Single-definition rule: the meaning of "agent-relevant" lives ONLY in
 * contracts/agent-relevant-change-policy.v1.json, the size bounds ONLY in
 * contracts/orientation-limits.v1.json, and the reason-code vocabulary ONLY in
 * contracts/orientation-reason-codes.v1.json. No literal from any of those
 * files may be repeated in this module, in a checker, in the generated
 * reference, or in a test. If you find yourself typing a limit or a class name
 * as a constant, read it from the contract instead.
 */

import { createHash } from "node:crypto";

export const LEDGER_PATH = "contracts/release-ledger.json";
export const CHANGELOG_PATH = "CHANGELOG.md";
export const POLICY_PATH = "contracts/agent-relevant-change-policy.v1.json";
export const LIMITS_PATH = "contracts/orientation-limits.v1.json";
export const REASON_CODES_PATH = "contracts/orientation-reason-codes.v1.json";
export const SURFACE_PATH = "contracts/supported-surface.json";
export const ORIENTATION_SCHEMA_PATH = "schemas/campaigns-os-tooling-orientation.v1.schema.json";
export const LEDGER_SCHEMA_PATH = "schemas/campaigns-os-release-ledger.v1.schema.json";

/**
 * Where baseline rotation writes its dated archive files. An archive file is
 * immutable once merged; a later rotation writes a new dated pair beside it.
 */
export const ARCHIVE_DIR = "contracts/archive/";

/**
 * The mandatory orientation reads a consumer takes at the target commit, and
 * the exact set `source_bytes` measures (steps 1-8 of the reading order in
 * AGENTS.md). The archive files named by the ledger's `baseline_floor` are
 * deliberately absent: they hold history older than every baseline a consumer
 * may orient from, so they are optional reads and count against no bound.
 */
export const ORIENTATION_SOURCE_PATHS = Object.freeze([
  SURFACE_PATH,
  LEDGER_PATH,
  CHANGELOG_PATH,
  LIMITS_PATH,
  REASON_CODES_PATH,
  ORIENTATION_SCHEMA_PATH,
  LEDGER_SCHEMA_PATH,
  POLICY_PATH,
]);

export const sha256Hex = (input) => createHash("sha256").update(input).digest("hex");

/**
 * Deterministic serialization for content hashing: object keys sorted, no
 * incidental whitespace. Two structurally equal entries must hash equal
 * regardless of how their author happened to order the keys, or `entry_sha256`
 * would flag reformatting as tampering.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function canonicalEntryJson(entry) {
  const { entry_sha256: _ignored, ...rest } = entry;
  return canonicalJson(rest);
}

export const entryHash = (entry) => sha256Hex(canonicalEntryJson(entry));

export const changeIdentity = (change) =>
  `${change.class}|${change.path ?? ""}|${change.surface_entry ?? ""}`;

/* ------------------------------------------------------------------ */
/* Changed-path classifier                                             */
/* ------------------------------------------------------------------ */

function matches(path, match) {
  if (!match || typeof match.value !== "string") return false;
  if (match.kind === "exact") return path === match.value;
  if (match.kind === "prefix") return path.startsWith(match.value);
  return false;
}

/**
 * Classify one repository-relative path.
 *
 * Evaluation order is fixed by the policy file and is total:
 *   self_referential_exemptions -> rules -> derived supported surface
 *   -> ignored -> unclassified.
 *
 * The derived pass runs BEFORE `ignored` on purpose. A path newly added to
 * contracts/supported-surface.json must never be swallowed by a broad ignore
 * prefix such as `docs/` or `contracts/`: a surface entry born unclassified is
 * exactly the silent-drift failure this gate exists to prevent.
 *
 * Returns one of:
 *   { relevant: true,  class, source }
 *   { relevant: false, reason, source }
 *   { relevant: false, unclassified: true }
 */
export function classifyPath(path, { policy, surface }) {
  for (const rule of policy.self_referential_exemptions ?? []) {
    if (matches(path, rule.match)) return { relevant: false, reason: rule.reason, source: "self_referential_exemption" };
  }
  for (const rule of policy.rules ?? []) {
    if (!matches(path, rule.match)) continue;
    if (typeof rule.match_suffix === "string" && !path.endsWith(rule.match_suffix)) continue;
    // An exclusion does not classify the path; it makes this rule not apply, so
    // the path keeps falling through. That is how a broad "all of campaign-spec
    // is generated runtime" rule can coexist with "except its own tests".
    if ((rule.exclude ?? []).some((exclusion) => matches(path, exclusion))) continue;
    return { relevant: true, class: rule.class, source: "rule" };
  }
  const derived = policy.derived_from_supported_surface;
  if (derived && surface) {
    if (Object.prototype.hasOwnProperty.call(surface.hashed ?? {}, path)) {
      return { relevant: true, class: derived.hashed_class, source: "derived_hashed" };
    }
    if ((surface.named ?? []).includes(path)) {
      return { relevant: true, class: derived.named_class, source: "derived_named" };
    }
  }
  for (const rule of policy.ignored ?? []) {
    if (matches(path, rule.match)) return { relevant: false, reason: rule.reason, source: "ignored" };
  }
  return { relevant: false, unclassified: true };
}

export function classifyPaths(paths, context) {
  const relevant = [];
  const ignored = [];
  const unclassified = [];
  for (const path of [...paths].sort()) {
    const verdict = classifyPath(path, context);
    if (verdict.unclassified) unclassified.push(path);
    else if (verdict.relevant) relevant.push({ path, class: verdict.class, source: verdict.source });
    else ignored.push({ path, reason: verdict.reason });
  }
  return { relevant, ignored, unclassified };
}

/* ------------------------------------------------------------------ */
/* Changelog                                                           */
/* ------------------------------------------------------------------ */

const SECTION_HEADING = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})\s*$/;

/**
 * Split CHANGELOG.md into sections. `body` is the exact text from the heading
 * line through the last non-blank line before the next heading, with trailing
 * whitespace trimmed — the same frame the ledger's `changelog_sha256` covers,
 * so a body edit is detectable and editing whitespace at the end of the file is
 * not a false positive.
 */
export function parseChangelogSections(text) {
  const lines = text.split("\n");
  const starts = [];
  lines.forEach((line, index) => {
    const match = SECTION_HEADING.exec(line);
    if (match) starts.push({ index, section_id: match[1], date: match[2] });
  });
  return starts.map((start, position) => {
    const end = position + 1 < starts.length ? starts[position + 1].index : lines.length;
    const body = lines.slice(start.index, end).join("\n").replace(/\s+$/, "");
    return {
      section_id: start.section_id,
      date: start.date,
      body,
      body_sha256: sha256Hex(body),
      bytes: Buffer.byteLength(body, "utf8"),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Ledger structure                                                    */
/* ------------------------------------------------------------------ */

const COMMIT_SHAPED_KEY = /commit|oid|sha1|revision/i;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const semverTuple = (version) => {
  const match = SEMVER.exec(version ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

/**
 * Structural + semantic ledger validation, independent of Git.
 *
 * `knownClasses` comes from the policy file, never from a literal list here.
 *
 * `classifiableEntryIds` scopes the one check that is NOT purely structural:
 * classifying `change.path` against the CURRENT policy and supported surface.
 * Only entries new in the comparison range may be classified that way. A
 * historical entry was classified under the policy in force when it was
 * written, and the ledger is append-only — so re-classifying it under a
 * tightened policy would fail a document nobody is allowed to edit. Everything
 * else here (shape, ordering, sequence, hashes, changelog correspondence) does
 * apply to every entry, historical ones included.
 *
 * Pass a Set to scope it; omit it (or pass null) to classify every entry, which
 * is what a fixture that has no notion of "historical" wants.
 *
 * `archive` is the result of `loadArchive` for a ledger that declares a
 * `baseline_floor`. The archived entries are validated as the head of ONE
 * logical ledger with the live entries after them: sequence runs from 1 through
 * the archive and continues at floor + 1 in the live file, ids and surface
 * versions are unique across both, an amendment may name an archived entry, and
 * each archived entry's `changelog_sha256` is checked against the archive
 * changelog it moved into. A declared floor with no archive is a failure, never
 * a skip: a floor nobody could verify would be silent deletion.
 */
export function validateLedgerStructure(ledger, { policy, surface, sections, classifiableEntryIds = null, archive = null }) {
  const errors = [];
  const knownClasses = new Set(Object.keys(policy.semantic_classes ?? {}));
  const liveEntries = Array.isArray(ledger?.entries) ? ledger.entries : null;
  const classifiableEntry = (entry) => classifiableEntryIds === null || classifiableEntryIds.has(entry.id);

  if (ledger?.schema_version !== "campaigns-os-release-ledger/v1") {
    errors.push(`${LEDGER_PATH}: schema_version must be "campaigns-os-release-ledger/v1"`);
  }
  if (!liveEntries) return [...errors, `${LEDGER_PATH}: entries must be an array`];

  const floor = ledger.baseline_floor ?? null;
  if (floor && !archive) {
    errors.push(`${LEDGER_PATH}: baseline_floor is declared but its archive was not loaded — a floor is only valid alongside the archive it names`);
  }
  if (floor && archive) errors.push(...validateBaselineFloor(ledger, archive));

  // One logical ledger: every archived entry, oldest first, then the live file.
  // Each row knows where it lives and which changelog its section is in.
  const archivedRows = floor && archive ? archive.entries.map((row) => ({ ...row, archived: true })) : [];
  const rows = [...archivedRows, ...liveEntries.map((entry) => ({ entry, path: LEDGER_PATH, sections, archived: false }))];
  const entries = rows.map((row) => row.entry);
  // Only when the archive could not be loaded (already an error above): keep
  // the live sequence check meaningful instead of reporting every entry.
  const sequenceOffset = floor && !archive && Number.isInteger(floor.last_archived_sequence) ? floor.last_archived_sequence : 0;

  if (floor && archive && sections) {
    const liveIds = new Set(sections.map((section) => section.section_id));
    for (const section of archive.sections) {
      if (liveIds.has(section.section_id)) {
        errors.push(`${CHANGELOG_PATH}: section "${section.section_id}" is also in the archive ${section.path}; a rotated section lives in exactly one place`);
      }
    }
  }

  const seenIds = new Set();
  const seenSurfaceVersions = new Map();
  const seenSections = new Map();
  let previousDate = "";

  // An amendment that links the SAME section as the entry it amends re-hashes
  // that section: it is the one way to correct a section's bytes (a stray
  // conflict-marker line, for example) without rewriting the historical entry
  // whose hash covered them. The amended entry's changelog_sha256 is then
  // superseded — the amendment's own hash, checked below like any other, keeps
  // the section pinned. An amendment linking a different section supersedes
  // nothing. Amendments chain (RL-C amends RL-B amends RL-A, all on one
  // section): each link supersedes its own predecessor, and the newest hash is
  // the one still checked. Two amendments of ONE entry on one section are not
  // a chain; the second fails the one-to-one link rule below.
  const byId = new Map(entries.map((entry) => [entry?.id, entry]));
  const superseded = new Set();
  for (const entry of entries) {
    if (entry?.kind !== "amendment" || typeof entry.amends !== "string") continue;
    const amended = byId.get(entry.amends);
    if (amended && amended.changelog_section === entry.changelog_section) superseded.add(amended.id);
  }

  for (const [index, row] of rows.entries()) {
    const { entry } = row;
    const where = `${row.path} ${entry?.id ?? "<entry with no id>"}`;
    const entrySections = row.sections;
    const changelogPath = row.archived ? row.changelogPath : CHANGELOG_PATH;
    // An archived entry is history by definition: never classified against the
    // current policy, whatever scope the caller passed.
    const classifiable = (candidate) => !row.archived && classifiableEntry(candidate);

    // The self-reference ban, enforced by name and not only by the schema's
    // additionalProperties:false, so the failure says WHY rather than
    // "unexpected property".
    for (const key of Object.keys(entry ?? {})) {
      if (COMMIT_SHAPED_KEY.test(key)) {
        errors.push(
          `${where}: property ${JSON.stringify(key)} looks like a commit identifier — a ledger entry must not ` +
            `name the commit that contains it. A consumer derives the introducing commit from Git history at the target OID.`,
        );
      }
    }

    if (seenIds.has(entry.id)) errors.push(`${where}: duplicate entry id`);
    seenIds.add(entry.id);

    // Expected sequence comes from the entry's POSITION, not from the previous
    // entry's claimed value — resyncing to a wrong claim would let every entry
    // after a gap pass while only the first violation is reported.
    const expectedSequence = index + 1 + sequenceOffset;
    if (entry.sequence !== expectedSequence) {
      errors.push(`${where}: sequence must be ${expectedSequence} (append-only order), got ${entry.sequence}`);
    }

    if (typeof entry.date === "string" && entry.date < previousDate) {
      errors.push(`${where}: date ${entry.date} is earlier than the previous entry's ${previousDate}; entries are ordered`);
    }
    if (typeof entry.date === "string") previousDate = entry.date;

    if (entry.kind === "amendment") {
      if (!entry.amends) errors.push(`${where}: an amendment must name the entry it amends`);
      else if (entry.amends === entry.id) errors.push(`${where}: an amendment cannot amend itself`);
      else if (!seenIds.has(entry.amends)) errors.push(`${where}: amends ${entry.amends}, which is not an earlier entry`);
      if (!entry.amendment_reason) errors.push(`${where}: an amendment must carry amendment_reason`);
    } else if (entry.amends || entry.amendment_reason) {
      errors.push(`${where}: amends/amendment_reason are only valid on kind "amendment"`);
    }

    if (entry.compatibility === "breaking" && String(entry.migration).trim().toLowerCase() === "none") {
      errors.push(`${where}: a breaking entry must state a migration action, not "none"`);
    }
    if (typeof entry.agent_impact !== "string" || !entry.agent_impact.trim()) {
      errors.push(`${where}: agent_impact is required — "no agent impact" must be asserted, not omitted`);
    }
    if (entry.surface_version !== null && !semverTuple(entry.surface_version)) {
      errors.push(`${where}: surface_version must be a semver string or null (same-surface change)`);
    }

    if (typeof entry.entry_sha256 === "string") {
      const expected = entryHash(entry);
      if (entry.entry_sha256 !== expected) {
        errors.push(`${where}: entry_sha256 does not match the entry contents (expected ${expected})`);
      }
    }

    // Changelog correspondence: exactly one section, matching hash. An archived
    // entry's section moved with it, so it is looked up in the archive
    // changelog, never in the live one.
    if (entrySections) {
      const linked = entrySections.filter((section) => section.section_id === entry.changelog_section);
      if (linked.length === 0) {
        errors.push(`${where}: changelog_section "${entry.changelog_section}" has no matching section in ${changelogPath}`);
      } else if (linked.length > 1) {
        errors.push(`${where}: changelog_section "${entry.changelog_section}" matches ${linked.length} sections in ${changelogPath}; section identifiers must be unique`);
      } else if (linked[0].body_sha256 !== entry.changelog_sha256 && !superseded.has(entry.id)) {
        errors.push(
          `${where}: changelog_sha256 does not match the body of ${changelogPath} section "${entry.changelog_section}" ` +
            `(actual ${linked[0].body_sha256}) — update the ledger hash in the same change that edits the section, ` +
            `or, for a historical entry, append an amendment that links the same section with its current hash`,
        );
      }
      const priorEntry = seenSections.get(entry.changelog_section);
      if (priorEntry && !(entry.kind === "amendment" && entry.amends === priorEntry)) {
        errors.push(`${where}: changelog section "${entry.changelog_section}" is already linked from ${priorEntry}; the link is one-to-one`);
      }
      seenSections.set(entry.changelog_section, entry.id);
    }

    // Surface-version entries: at most one entry per surface version. This one
    // IS ledger-wide: a surface version is minted once and can never legitimately
    // be claimed twice, however far apart the two entries are.
    if (entry.surface_version) {
      const prior = seenSurfaceVersions.get(entry.surface_version);
      if (prior) errors.push(`${where}: surface_version ${entry.surface_version} is already claimed by ${prior}; a surface change owes exactly one entry`);
      seenSurfaceVersions.set(entry.surface_version, entry.id);
    }

    // Change-identity uniqueness is scoped to ONE entry, not to the whole
    // ledger. A path is touched by many releases over a repository's life, and
    // a ledger-wide identity set would make the second release that touches a
    // path unrecordable. Recording the same change twice within one range is
    // caught by the two-way gate instead ("covered by N ledger change items"),
    // which is the check that actually knows what changed in the range.
    const seenIdentitiesInEntry = new Map();

    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      if (!change || typeof change !== "object") {
        errors.push(`${where}: change items must be objects, got ${JSON.stringify(change)}`);
        continue;
      }
      if (!knownClasses.has(change.class)) {
        errors.push(`${where}: change class ${JSON.stringify(change.class)} is not defined in ${POLICY_PATH}`);
        continue;
      }
      const identity = changeIdentity(change);
      if (seenIdentitiesInEntry.has(identity)) {
        errors.push(`${where}: change identity ${identity} is already recorded by this entry; each change is recorded once per entry`);
      }
      seenIdentitiesInEntry.set(identity, entry.id);

      if (change.path && classifiable(entry)) {
        const verdict = classifyPath(change.path, { policy, surface });
        if (!verdict.relevant) {
          errors.push(
            `${where}: change item names ${change.path}, which ${POLICY_PATH} classifies as ` +
              `${verdict.unclassified ? "unclassified" : "not agent-relevant"} — a ledger item may not claim a path the policy excludes`,
          );
        } else if (verdict.class !== change.class) {
          errors.push(`${where}: change item declares class ${change.class} for ${change.path}, but ${POLICY_PATH} classifies it as ${verdict.class}`);
        }
      }
      // Like path classification, this is a check against the CURRENT manifest,
      // so it applies only to entries new in the range. A historical entry named
      // a surface entry that existed when it was written; a later release may
      // legitimately have removed it.
      if (change.surface_entry && surface && classifiable(entry)) {
        const known =
          Object.prototype.hasOwnProperty.call(surface.hashed ?? {}, change.surface_entry) ||
          (surface.named ?? []).includes(change.surface_entry) ||
          (surface.cli_commands ?? []).includes(change.surface_entry) ||
          (surface.package_exports ?? []).includes(change.surface_entry) ||
          (surface.bin ?? []).includes(change.surface_entry);
        if (!known) {
          errors.push(`${where}: surface_entry ${JSON.stringify(change.surface_entry)} is not declared in ${SURFACE_PATH}`);
        }
      }
    }
    if (!Array.isArray(entry.changes) || entry.changes.length === 0) {
      errors.push(`${where}: an entry must carry at least one change item`);
    }
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/* Baseline rotation                                                   */
/* ------------------------------------------------------------------ */

/**
 * The ledger and the changelog grow for the life of the repository, and the
 * orientation limits bound them as whole files. Rotation is how they stay
 * inside those bounds without a quiet raise and without losing history: the
 * entries up to a reviewed cut, and the changelog from the first section they
 * link to the end of the file, move byte-for-byte into a dated archive pair
 * under ARCHIVE_DIR, and the live ledger declares the cut as its
 * `baseline_floor`:
 *
 *   {
 *     "archives": [{ ledger_path, ledger_sha256, changelog_path, changelog_sha256 }, ...],
 *     "last_archived_id", "last_archived_sequence", "first_kept_id",
 *     "rotation_entry", "refusal_reason_code"
 *   }
 *
 * Nothing is renumbered: entries keep their sequence (entry_sha256 covers it),
 * so the first live entry is last_archived_sequence + 1. `archives` only ever
 * grows; each rotation appends a new dated pair and an existing pair never
 * changes. `rotation_entry` names the live entry that recorded the rotation.
 */

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Read the archive files a ledger's `baseline_floor` names. `readText(path)`
 * returns the file's text or null when it does not exist; nothing else is read.
 * Returns `{ archive: null, errors: [] }` for a ledger with no floor.
 */
export function loadArchive(ledger, readText) {
  const floor = ledger?.baseline_floor;
  if (floor === undefined || floor === null) return { archive: null, errors: [] };
  const where = `${LEDGER_PATH} baseline_floor`;
  if (!isRecord(floor)) return { archive: null, errors: [`${where}: must be an object`] };
  const records = Array.isArray(floor.archives) ? floor.archives : [];
  if (!records.length) return { archive: null, errors: [`${where}: archives must name at least one archive file pair`] };

  const errors = [];
  const files = [];
  const entries = [];
  const sections = [];
  for (const record of records) {
    const paths = [record?.ledger_path, record?.changelog_path];
    const bad = paths.filter((path) => typeof path !== "string" || !path.startsWith(ARCHIVE_DIR) || path.split("/").includes(".."));
    if (bad.length) {
      errors.push(`${where}: archive paths must be files under ${ARCHIVE_DIR}, got ${JSON.stringify(paths)}`);
      continue;
    }
    const ledgerText = readText(record.ledger_path);
    const changelogText = readText(record.changelog_path);
    if (ledgerText === null || ledgerText === undefined) errors.push(`${record.ledger_path}: archive file named by baseline_floor is missing`);
    if (changelogText === null || changelogText === undefined) errors.push(`${record.changelog_path}: archive file named by baseline_floor is missing`);
    if (typeof ledgerText !== "string" || typeof changelogText !== "string") continue;
    let document;
    try {
      document = JSON.parse(ledgerText);
    } catch (error) {
      errors.push(`${record.ledger_path}: invalid JSON: ${error.message}`);
      continue;
    }
    if (!Array.isArray(document?.entries)) {
      errors.push(`${record.ledger_path}: entries must be an array`);
      continue;
    }
    const fileSections = parseChangelogSections(changelogText).map((section) => ({ ...section, path: record.changelog_path }));
    files.push({ record, ledgerText, changelogText, document, sections: fileSections });
    for (const entry of document.entries) {
      entries.push({ entry, path: record.ledger_path, changelogPath: record.changelog_path, sections: fileSections });
    }
    sections.push(...fileSections);
  }
  if (errors.length) return { archive: null, errors };
  return { archive: { floor, files, entries, sections }, errors: [] };
}

/** The floor's own claims, checked against the archive it names and the live file. */
export function validateBaselineFloor(ledger, archive) {
  const errors = [];
  const floor = ledger.baseline_floor;
  const where = `${LEDGER_PATH} baseline_floor`;

  const seenPaths = new Set();
  for (const file of archive.files) {
    const { record } = file;
    for (const path of [record.ledger_path, record.changelog_path]) {
      if (seenPaths.has(path)) errors.push(`${where}: ${path} is named twice; every rotation writes its own dated archive pair`);
      seenPaths.add(path);
    }
    for (const [path, text, claimed] of [
      [record.ledger_path, file.ledgerText, record.ledger_sha256],
      [record.changelog_path, file.changelogText, record.changelog_sha256],
    ]) {
      const actual = sha256Hex(text);
      if (claimed !== actual) {
        errors.push(
          `${where}: ${path} does not match its recorded sha256 (actual ${actual}) — an archive file is immutable once ` +
            `merged; a later rotation writes a new dated file instead of editing this one`,
        );
      }
    }
    if (file.document.schema_version !== ledger.schema_version) {
      errors.push(`${record.ledger_path}: schema_version must equal the live ledger's (${ledger.schema_version})`);
    }
    if (file.document.baseline_floor !== undefined) {
      errors.push(`${record.ledger_path}: an archive file carries entries only; the floor is declared once, in ${LEDGER_PATH}`);
    }
  }

  const archived = archive.entries.map((row) => row.entry);
  const last = archived.at(-1);
  if (!last) {
    errors.push(`${where}: the archive holds no entries; a floor with nothing below it is not a rotation`);
  } else {
    if (floor.last_archived_id !== last.id) {
      errors.push(`${where}: last_archived_id is ${JSON.stringify(floor.last_archived_id)} but the archive ends at ${last.id}`);
    }
    if (floor.last_archived_sequence !== last.sequence) {
      errors.push(`${where}: last_archived_sequence is ${JSON.stringify(floor.last_archived_sequence)} but the archive ends at sequence ${last.sequence}`);
    }
  }
  const firstLive = ledger.entries[0];
  if (!firstLive) {
    errors.push(`${where}: the live ledger is empty; a rotation keeps at least the entry that records it`);
  } else if (floor.first_kept_id !== firstLive.id) {
    errors.push(`${where}: first_kept_id is ${JSON.stringify(floor.first_kept_id)} but the live ledger starts at ${firstLive.id}`);
  }
  if (!ledger.entries.some((entry) => entry.id === floor.rotation_entry)) {
    errors.push(`${where}: rotation_entry ${JSON.stringify(floor.rotation_entry)} names no live entry; the rotation that set this floor must be recorded in the live ledger`);
  }
  if (typeof floor.refusal_reason_code !== "string" || !floor.refusal_reason_code) {
    errors.push(`${where}: refusal_reason_code is required — a consumer whose baseline is below the floor needs a stable code to refuse with`);
  }

  const seenSectionIds = new Set();
  for (const section of archive.sections) {
    if (seenSectionIds.has(section.section_id)) errors.push(`${section.path}: section "${section.section_id}" appears in more than one archive section`);
    seenSectionIds.add(section.section_id);
  }
  return errors;
}

/**
 * The pair rule a rotation cut must keep, shared by `rotateLedger` (which
 * refuses to write the cut) and `validateAppendOnly` (which refuses a
 * hand-authored one). `kept` are the entries that stay live, `archivedIds` the
 * entries this rotation moves, `tailSectionIds` the changelog sections it
 * moves. Returns the refusal message, or null when no pair is split.
 */
export function rotationSplitError({ lastArchivedId, archivedIds, kept, tailSectionIds = new Set() }) {
  const split = [
    ...kept.filter((entry) => entry.kind === "amendment" && archivedIds.has(entry.amends)).map((entry) => `${entry.id} amends archived ${entry.amends}`),
    ...kept.filter((entry) => tailSectionIds.has(entry.changelog_section)).map((entry) => `${entry.id} links archived section ${entry.changelog_section}`),
  ];
  return split.length ? `rotation at ${lastArchivedId} would split a pair (${split.join("; ")}); move the cut earlier` : null;
}

/**
 * Move every entry up to and including `lastArchivedId` into a new archive
 * ledger, and the changelog from the first section those entries link down to
 * the end of the file into a new archive changelog, verbatim and in order.
 * The changelog cut is one contiguous tail, widened up to the top of the
 * release group it starts in, so sections no entry links (+agent.N sections
 * inside the range, releases older than the ledger) move with their neighbours
 * and the live file stays a well-formed changelog on its own. Pure:
 * returns the new file texts and the new live ledger; the caller writes them.
 *
 * Refuses (throws) rather than splitting a pair: a kept amendment of an
 * archived entry, or a kept entry linking a section in the archived tail,
 * means the cut belongs earlier.
 */
export function rotateLedger({ ledger, changelogText, lastArchivedId, ledgerArchivePath, changelogArchivePath, rotationEntryId, refusalReasonCode, archiveNote, changelogPreamble }) {
  const entries = ledger.entries;
  const cut = entries.findIndex((entry) => entry.id === lastArchivedId);
  if (cut < 0) throw new Error(`rotation cut ${lastArchivedId} is not a live entry`);
  const archived = entries.slice(0, cut + 1);
  const kept = entries.slice(cut + 1);
  const archivedIds = new Set(archived.map((entry) => entry.id));
  const archivedSectionIds = new Set(archived.map((entry) => entry.changelog_section));

  const lines = changelogText.split("\n");
  const starts = [];
  lines.forEach((line, index) => {
    const match = SECTION_HEADING.exec(line);
    if (match) starts.push({ index, section_id: match[1] });
  });
  const found = new Set(starts.map((start) => start.section_id));
  const missing = [...archivedSectionIds].filter((id) => !found.has(id));
  if (missing.length) throw new Error(`archived entries link sections missing from the changelog: ${missing.join(", ")}`);
  // The tail starts at the top of the release group (its +agent.N run and the
  // bare release) holding the first linked section, so no +agent.N section is
  // left in the live file without its release below it.
  const releaseOf = (id) => id.replace(/\+agent\.\d+$/, "");
  let first = starts.findIndex((start) => archivedSectionIds.has(start.section_id));
  const firstRelease = releaseOf(starts[first].section_id);
  while (first > 0 && starts[first - 1].section_id !== firstRelease && releaseOf(starts[first - 1].section_id) === firstRelease) first -= 1;
  const tailIds = new Set(starts.slice(first).map((start) => start.section_id));

  const split = rotationSplitError({ lastArchivedId, archivedIds, kept, tailSectionIds: tailIds });
  if (split) throw new Error(split);

  const cutLine = starts[first].index;
  const keptLines = lines.slice(0, cutLine);
  const archivedTail = lines.slice(cutLine).join("\n").replace(/\s+$/, "");
  const archiveChangelogText = `${changelogPreamble.replace(/\s+$/, "")}\n\n${archivedTail}\n`;
  const archiveLedgerText = `${JSON.stringify({ _note: archiveNote, schema_version: ledger.schema_version, entries: archived }, null, 2)}\n`;
  const lastArchived = archived.at(-1);
  const floor = {
    archives: [
      ...(ledger.baseline_floor?.archives ?? []),
      {
        ledger_path: ledgerArchivePath,
        ledger_sha256: sha256Hex(archiveLedgerText),
        changelog_path: changelogArchivePath,
        changelog_sha256: sha256Hex(archiveChangelogText),
      },
    ],
    last_archived_id: lastArchived.id,
    last_archived_sequence: lastArchived.sequence,
    first_kept_id: kept[0]?.id ?? null,
    rotation_entry: rotationEntryId,
    refusal_reason_code: refusalReasonCode,
  };
  const { entries: _entries, baseline_floor: _floor, ...rest } = ledger;
  return {
    liveLedger: { ...rest, baseline_floor: floor, entries: kept },
    liveChangelogText: keptLines.join("\n"),
    archiveLedgerText,
    archiveChangelogText,
    floor,
  };
}

/**
 * The consumer's side of the floor. A reviewed baseline whose newest ledger
 * entry is older than the floor's last archived entry has a window that starts
 * inside the archive, which the mandatory reads no longer contain: refuse with
 * the floor's declared code rather than orient on a partial window. A baseline
 * at or after the last archived entry (every commit at or after the first kept
 * entry qualifies) reads its whole window from the live ledger. A baseline
 * position that is absent or not an integer refuses too: fail closed.
 */
export function evaluateBaselineFloor(floor, baselineLastSequence) {
  if (!floor) return { within_floor: true, reason_code: null, detail: null };
  if (!Number.isInteger(baselineLastSequence) || baselineLastSequence < floor.last_archived_sequence) {
    return {
      within_floor: false,
      reason_code: floor.refusal_reason_code,
      detail:
        `the reviewed baseline's newest ledger entry (sequence ${String(baselineLastSequence)}) is older than the floor ` +
        `(${floor.last_archived_id}, sequence ${floor.last_archived_sequence}); adopt a newer reviewed baseline whose ledger reaches ` +
        `${floor.last_archived_id} (every commit at or after ${floor.first_kept_id} does)`,
    };
  }
  return { within_floor: true, reason_code: null, detail: null };
}

/* ------------------------------------------------------------------ */
/* Two-way release gate                                                */
/* ------------------------------------------------------------------ */

/**
 * The gate is complete in both directions:
 *
 *   forward  — every agent-relevant changed path is covered by exactly one
 *              change item among the entries added in this range;
 *   backward — every change item among those entries maps to a classified
 *              changed path, or belongs to an explicit reviewed amendment.
 *
 * A path-less change item (a CLI flag, for example) satisfies the backward
 * direction when the range contains at least one classified change of the same
 * semantic class, so a flag change still has to move real bytes.
 */
export function validateTwoWayGate({ classified, newEntries, surfaceBumped, surfaceVersion }) {
  const errors = [];
  const items = [];
  for (const entry of newEntries) {
    for (const change of entry.changes ?? []) items.push({ entry, change });
  }

  const coverageByPath = new Map();
  for (const { entry, change } of items) {
    if (!change.path) continue;
    if (!coverageByPath.has(change.path)) coverageByPath.set(change.path, []);
    coverageByPath.get(change.path).push(entry.id);
  }

  for (const { path, class: cls } of classified.relevant) {
    const covering = coverageByPath.get(path) ?? [];
    if (covering.length === 0) {
      errors.push(
        `${path} is an agent-relevant change (class ${cls}) with no release-ledger change item — ` +
          `add one to ${LEDGER_PATH}, or add a reason to ${POLICY_PATH} explaining why the path is not agent-relevant`,
      );
    } else if (covering.length > 1) {
      errors.push(`${path} is covered by ${covering.length} ledger change items (${covering.join(", ")}); each path is covered exactly once`);
    }
  }

  for (const path of classified.unclassified) {
    errors.push(
      `${path} matches no rule, no supported-surface entry, and no ignore in ${POLICY_PATH} — ` +
        `classify it: either it is agent-relevant and owes a ledger item, or add it to ignored[] with a reason`,
    );
  }

  const relevantClasses = new Set(classified.relevant.map((item) => item.class));
  const relevantPaths = new Set(classified.relevant.map((item) => item.path));
  for (const { entry, change } of items) {
    if (entry.kind === "amendment") continue;
    if (change.path) {
      if (!relevantPaths.has(change.path)) {
        errors.push(
          `${LEDGER_PATH} ${entry.id}: change item names ${change.path}, which did not change in this range and is not a ` +
            `reviewed amendment — a ledger item must map to a classified change`,
        );
      }
    } else if (!relevantClasses.has(change.class)) {
      errors.push(
        `${LEDGER_PATH} ${entry.id}: path-less change item of class ${change.class} has no classified change of that class in ` +
          `this range — a flag or subcommand change still moves bytes somewhere`,
      );
    }
  }

  if (surfaceBumped) {
    const claiming = newEntries.filter((entry) => entry.surface_version === surfaceVersion);
    if (claiming.length !== 1) {
      errors.push(
        `supported_surface moved to ${surfaceVersion} but ${claiming.length} new ledger entries claim it; ` +
          `a surface version change owes exactly one entry and one changelog section`,
      );
    }
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/* Append-only                                                         */
/* ------------------------------------------------------------------ */

/**
 * Historical entries are never edited or removed — with exactly one exception,
 * baseline rotation, which moves them rather than removing them. A base entry
 * missing from the head live ledger is accepted only when ALL of these hold:
 *
 *   - the head declares a `baseline_floor` that covers the entry's sequence;
 *   - the head archive holds the entry, canonical-JSON-identical to base;
 *   - the floor moved forward in this range, and the entry it names as
 *     `rotation_entry` is new in this range.
 *
 * Every other deletion or rewrite still fails. The floor itself is
 * append-only in the same way: it never disappears, never moves back, never
 * changes without moving, and moves only with a new rotation entry. Archive
 * files are immutable across rotations — the base floor's archive records
 * must survive unchanged at the head of the head floor's list, and a new
 * record must name a file that did not exist at base. A new archive may hold
 * only entries that were live at base (byte-identical) and only changelog
 * sections that were in the base changelog (byte-identical). A base entry that
 * stays live never amends an entry this rotation archived, nor links a section
 * it archived (rotationSplitError).
 *
 * `rotation` is optional; without it (a range with no floor on either side)
 * this is the plain append-only rule.
 */
export function validateAppendOnly(baseEntries, headEntries, rotation = {}) {
  const { baseFloor = null, headFloor = null, headArchive = null, baseSections = null, existedAtBase = () => false } = rotation;
  const errors = [];
  const head = new Map(headEntries.map((entry) => [entry.id, entry]));
  const baseById = new Map(baseEntries.map((entry) => [entry.id, entry]));
  const floorWhere = `${LEDGER_PATH} baseline_floor`;
  let maxBaseSequence = 0;

  const baseFloorSequence = Number.isInteger(baseFloor?.last_archived_sequence) ? baseFloor.last_archived_sequence : 0;
  const headFloorSequence = Number.isInteger(headFloor?.last_archived_sequence) ? headFloor.last_archived_sequence : 0;
  const floorMoved = Boolean(headFloor) && headFloorSequence > baseFloorSequence;
  const rotationEntry = floorMoved
    ? headEntries.find((entry) => entry.id === headFloor.rotation_entry && !baseById.has(entry.id)) ?? null
    : null;

  if (baseFloor && !headFloor) {
    errors.push(`${floorWhere}: the floor was removed — a floor only moves forward, and the archive it names stays declared`);
  }
  if (baseFloor && headFloor) {
    if (headFloorSequence < baseFloorSequence) {
      errors.push(`${floorWhere}: the floor moved backwards (${baseFloorSequence} -> ${headFloorSequence}); a floor only moves forward`);
    } else if (!floorMoved && canonicalJson(headFloor) !== canonicalJson(baseFloor)) {
      errors.push(`${floorWhere}: the floor was rewritten without moving — it changes only when a rotation moves it forward`);
    }
    const baseRecords = Array.isArray(baseFloor.archives) ? baseFloor.archives : [];
    const headRecords = Array.isArray(headFloor.archives) ? headFloor.archives : [];
    baseRecords.forEach((record, index) => {
      if (canonicalJson(headRecords[index]) !== canonicalJson(record)) {
        errors.push(
          `${floorWhere}: archive record ${JSON.stringify(record?.ledger_path)} changed or moved — an existing archive file is immutable; ` +
            `a later rotation appends a new dated archive pair`,
        );
      }
    });
  }
  if (floorMoved && !rotationEntry) {
    errors.push(
      `${floorWhere}: the floor moved to ${headFloor.last_archived_id} without a new rotation entry — rotation_entry must name an entry ` +
        `added in this range that records the rotation`,
    );
  }

  const baseRecordCount = Array.isArray(baseFloor?.archives) ? baseFloor.archives.length : 0;
  const newRecords = floorMoved && Array.isArray(headFloor.archives) ? headFloor.archives.slice(baseRecordCount) : [];
  if (floorMoved && newRecords.length === 0) {
    errors.push(`${floorWhere}: the floor moved but names no new archive pair; a rotation writes its entries to a new dated archive file`);
  }
  for (const record of newRecords) {
    for (const path of [record?.ledger_path, record?.changelog_path]) {
      if (typeof path === "string" && existedAtBase(path)) {
        errors.push(`${floorWhere}: ${path} already existed at base — a rotation writes a new dated archive file and never rewrites an existing one`);
      }
    }
    if (rotationEntry) {
      const covered = new Set((rotationEntry.changes ?? []).map((change) => change?.path));
      for (const path of [record?.ledger_path, record?.changelog_path]) {
        if (!covered.has(path)) {
          errors.push(`${LEDGER_PATH} ${rotationEntry.id}: the rotation entry records no change item for the new archive file ${path}`);
        }
      }
    }
  }

  // Only the archive files this rotation wrote may hold entries new to the
  // archive, and every one of them must be a base entry, byte-for-byte.
  const newPaths = new Set(newRecords.map((record) => record?.ledger_path));
  const newChangelogPaths = new Set(newRecords.map((record) => record?.changelog_path));
  const archivedById = new Map();
  for (const row of headArchive?.entries ?? []) {
    archivedById.set(row.entry?.id, row.entry);
    if (!newPaths.has(row.path)) continue;
    const baseEntry = baseById.get(row.entry?.id);
    if (!baseEntry) {
      errors.push(`${row.path} ${row.entry?.id}: archived entry was not in the base ledger — an archive holds moved history, never new entries`);
    } else if (canonicalJson(row.entry) !== canonicalJson(baseEntry)) {
      errors.push(`${row.path} ${row.entry?.id}: archived copy differs from the base entry — rotation moves entries byte-for-byte; it never rewrites them`);
    }
  }
  if (baseSections) {
    const baseSectionById = new Map(baseSections.map((section) => [section.section_id, section]));
    for (const section of headArchive?.sections ?? []) {
      if (!newChangelogPaths.has(section.path)) continue;
      const original = baseSectionById.get(section.section_id);
      if (!original) {
        errors.push(`${section.path}: section "${section.section_id}" was not in the base ${CHANGELOG_PATH} — an archive holds moved history only`);
      } else if (original.body !== section.body) {
        errors.push(`${section.path}: section "${section.section_id}" differs from the base ${CHANGELOG_PATH} — rotation moves sections verbatim`);
      }
    }
  }

  for (const baseEntry of baseEntries) {
    maxBaseSequence = Math.max(maxBaseSequence, baseEntry.sequence ?? 0);
    const current = head.get(baseEntry.id);
    if (!current) {
      const archivedCopy = archivedById.get(baseEntry.id);
      const coveredByFloor = Boolean(headFloor) && Number.isInteger(baseEntry.sequence) && baseEntry.sequence <= headFloorSequence;
      if (!coveredByFloor) {
        errors.push(`${LEDGER_PATH} ${baseEntry.id}: historical entry was deleted — the ledger is append-only; ship a correction as a new amendment entry`);
      } else if (!archivedCopy) {
        errors.push(`${LEDGER_PATH} ${baseEntry.id}: historical entry was deleted — the floor covers it but no archive file holds it`);
      } else if (canonicalJson(archivedCopy) !== canonicalJson(baseEntry)) {
        errors.push(`${LEDGER_PATH} ${baseEntry.id}: historical entry was deleted — its archived copy differs from the base entry`);
      } else if (!floorMoved || !rotationEntry) {
        errors.push(`${LEDGER_PATH} ${baseEntry.id}: historical entry was deleted — archiving it needs the floor to move with a new rotation entry in this range`);
      }
      continue;
    }
    if (canonicalJson(current) !== canonicalJson(baseEntry)) {
      errors.push(`${LEDGER_PATH} ${baseEntry.id}: historical entry was rewritten — the ledger is append-only; ship a correction as a new amendment entry`);
    }
  }

  // A hand-authored rotation keeps the pair rule rotateLedger enforces: an
  // entry that was live at base and stays live never amends one this rotation
  // archived, nor links a section it archived (the sections of the archive
  // changelogs this rotation wrote). A NEW entry amending an archived one is how
  // archived history is corrected, so only base entries count as kept.
  if (floorMoved) {
    const movedIds = new Set(baseEntries.filter((entry) => !head.has(entry.id) && entry.sequence <= headFloorSequence).map((entry) => entry.id));
    const movedSectionIds = new Set((headArchive?.sections ?? []).filter((section) => newChangelogPaths.has(section.path)).map((section) => section.section_id));
    const split = rotationSplitError({
      lastArchivedId: headFloor.last_archived_id,
      archivedIds: movedIds,
      kept: headEntries.filter((entry) => baseById.has(entry.id)),
      tailSectionIds: movedSectionIds,
    });
    if (split) errors.push(`${floorWhere}: ${split}`);
  }

  for (const entry of headEntries) {
    const isNew = !baseEntries.some((baseEntry) => baseEntry.id === entry.id);
    if (isNew && (entry.sequence ?? 0) <= maxBaseSequence) {
      errors.push(`${LEDGER_PATH} ${entry.id}: new entry has sequence ${entry.sequence}, which is not after the last historical entry (${maxBaseSequence})`);
    }
  }

  return errors;
}

export const newEntriesSince = (baseEntries, headEntries) => {
  const baseIds = new Set(baseEntries.map((entry) => entry.id));
  return headEntries.filter((entry) => !baseIds.has(entry.id));
};

/* ------------------------------------------------------------------ */
/* Bounded reads                                                       */
/* ------------------------------------------------------------------ */

/**
 * The ONE mapping from a declared limit to the measurement that satisfies it.
 * The measurement names are the same ones the orientation envelope's
 * `limits.applied` object uses, so a consumer and this repository are talking
 * about the same five numbers. `validateContractConsistency` asserts that the
 * limits contract declares exactly these keys and no others, which is what stops
 * a sixth limit from being added to the contract and then never measured.
 */
export const LIMIT_MEASUREMENTS = Object.freeze({
  max_source_bytes: "source_bytes",
  max_section_count: "section_count",
  max_section_bytes: "max_observed_section_bytes",
  max_envelope_bytes: "envelope_bytes",
  max_ledger_entries: "ledger_entries",
});

/**
 * Fail closed against the declared limits. Returns every limit exceeded, not
 * the first, and never truncates or trims the measured input. The caller is
 * expected to refuse with `limits.refusal_reason_code`.
 *
 * A measurement that is absent, non-numeric, NaN, or Infinite counts as
 * EXCEEDED. Skipping it would let a broken measurement pass a bound silently,
 * which is the one outcome a fail-closed contract may not have.
 */
export function evaluateLimits(measured, limitsContract) {
  const limits = limitsContract.limits;
  const exceeded = [];
  const observed = new Map();
  for (const [name, measurement] of Object.entries(LIMIT_MEASUREMENTS)) {
    const actual = measured?.[measurement];
    observed.set(name, actual);
    if (!Number.isFinite(actual) || actual > limits[name]?.value) exceeded.push(name);
  }
  return {
    exceeded,
    within_limits: exceeded.length === 0,
    reason_code: exceeded.length ? limitsContract.refusal_reason_code : null,
    truncated: false,
    detail: exceeded.map((name) => {
      const actual = observed.get(name);
      const shown = Number.isFinite(actual) ? actual : `${LIMIT_MEASUREMENTS[name]} was not measured (${String(actual)})`;
      return `${name}: ${shown} exceeds ${limits[name]?.value} ${limits[name]?.unit}`;
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Introducing-commit derivation                                       */
/* ------------------------------------------------------------------ */

/**
 * Derive the commit that introduced each ledger entry.
 *
 * The ledger stores no commit identifier — it cannot, without being rewritten
 * after the commit that contains it exists. Instead a consumer walks the
 * commits that touched the ledger path in the range, oldest first, and credits
 * each entry id to the first commit whose ledger blob contains it. Merge
 * commits need no special case: if an entry arrived on a side branch, that
 * side-branch commit is in the walk and is credited; if the entry was first
 * assembled while resolving a merge, the merge commit is credited. Both are the
 * truthful answer.
 *
 * `commitsOldestFirst` is the ordered walk; `readEntryIdsAt(commit)` returns the
 * entry ids present in the ledger blob at that commit (or null if the file did
 * not exist yet).
 */
export function deriveIntroducingCommits(commitsOldestFirst, readEntryIdsAt) {
  const introducing = new Map();
  const seen = new Set();
  for (const commit of commitsOldestFirst) {
    const ids = readEntryIdsAt(commit);
    if (!ids) continue;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      introducing.set(id, commit);
    }
  }
  return introducing;
}

/* ------------------------------------------------------------------ */
/* Consumer dependency policy                                          */
/* ------------------------------------------------------------------ */

/**
 * A consumer manifest may depend only on the declared supported surface.
 * `src/**` is implementation: readable for context, never a dependency. This is
 * the same rule contracts/supported-surface.json states in prose, expressed so
 * a manifest checker on either side of the repository boundary can enforce it.
 */
export function validateConsumerDependencies(paths, surface) {
  const supported = new Set([
    ...Object.keys(surface.hashed ?? {}),
    ...(surface.named ?? []),
  ]);
  return paths
    .filter((path) => !supported.has(path))
    .map(
      (path) =>
        `${path} is not on the supported surface declared in ${SURFACE_PATH} — a consumer manifest may not depend on it. ` +
        `Implementation paths (src/**, scripts/**, examples/**, prompts/**, agents/**) may be read for context but never pinned.`,
    );
}

/* ------------------------------------------------------------------ */
/* Cross-file consistency                                              */
/* ------------------------------------------------------------------ */

const enumAt = (schema, pointer) =>
  pointer.split("/").reduce((node, key) => (node == null ? node : node[key]), schema)?.enum ?? null;

/**
 * The contract files and the schemas must agree exactly. This is what keeps the
 * reason-code vocabulary, the semantic classes, and the limits from being
 * maintained in two places that drift.
 */
export function validateContractConsistency({ orientationSchema, ledgerSchema, policy, reasonCodes, limits }) {
  const errors = [];
  const same = (label, actual, expected) => {
    const a = [...(actual ?? [])].sort();
    const b = [...expected].sort();
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      const missing = b.filter((v) => !a.includes(v));
      const extra = a.filter((v) => !b.includes(v));
      errors.push(
        `${label} does not match its source of truth` +
          (missing.length ? `; missing ${missing.join(", ")}` : "") +
          (extra.length ? `; unexpected ${extra.join(", ")}` : ""),
      );
    }
  };

  const codes = Object.keys(reasonCodes.codes ?? {});
  const classes = Object.keys(policy.semantic_classes ?? {});

  same(`${ORIENTATION_SCHEMA_PATH} $defs.reason_code.enum (against ${REASON_CODES_PATH})`, enumAt(orientationSchema, "$defs/reason_code"), codes);
  same(`${ORIENTATION_SCHEMA_PATH} $defs.change_class.enum (against ${POLICY_PATH})`, enumAt(orientationSchema, "$defs/change_class"), classes);
  same(`${LEDGER_SCHEMA_PATH} $defs.change.properties.class.enum (against ${POLICY_PATH})`, enumAt(ledgerSchema, "$defs/change/properties/class"), classes);

  const dispositions = enumAt(orientationSchema, "$defs/disposition") ?? [];
  for (const [code, definition] of Object.entries(reasonCodes.codes ?? {})) {
    if (!definition.remedy?.trim()) errors.push(`${REASON_CODES_PATH}: ${code} has no remedy`);
    if (!definition.meaning?.trim()) errors.push(`${REASON_CODES_PATH}: ${code} has no meaning`);
    if (!definition.test_id?.trim()) errors.push(`${REASON_CODES_PATH}: ${code} has no test_id`);
    if (!["campaigns-os", "campaigns-agent"].includes(definition.owner)) {
      errors.push(`${REASON_CODES_PATH}: ${code} owner must be campaigns-os or campaigns-agent`);
    }
    for (const outcome of definition.outcomes ?? []) {
      if (!dispositions.includes(outcome)) {
        errors.push(`${REASON_CODES_PATH}: ${code} names outcome ${JSON.stringify(outcome)}, which is not a disposition in ${ORIENTATION_SCHEMA_PATH}`);
      }
    }
  }

  const testIds = Object.values(reasonCodes.codes ?? {}).map((definition) => definition.test_id);
  const duplicateTestIds = testIds.filter((id, index) => testIds.indexOf(id) !== index);
  if (duplicateTestIds.length) errors.push(`${REASON_CODES_PATH}: duplicate test_id values (${[...new Set(duplicateTestIds)].join(", ")})`);

  for (const rule of [...(policy.rules ?? [])]) {
    if (!classes.includes(rule.class)) errors.push(`${POLICY_PATH}: rule for ${rule.match?.value} names undefined class ${rule.class}`);
  }
  const derived = policy.derived_from_supported_surface ?? {};
  for (const key of ["hashed_class", "named_class"]) {
    if (derived[key] && !classes.includes(derived[key])) errors.push(`${POLICY_PATH}: derived_from_supported_surface.${key} names undefined class ${derived[key]}`);
  }
  for (const rule of policy.ignored ?? []) {
    if (!rule.reason?.trim()) errors.push(`${POLICY_PATH}: ignore rule for ${rule.match?.value} has no reason — "no agent impact" must be asserted`);
  }

  // The limits contract and the implementation must agree on WHICH bounds
  // exist. A limit declared but never measured is a bound nobody enforces; a
  // measurement with no declared limit is an unbounded read.
  same(`${LIMITS_PATH} limits keys (against the measurements scripts/orientation-contract.mjs takes)`, Object.keys(limits.limits ?? {}), Object.keys(LIMIT_MEASUREMENTS));
  for (const [name, limit] of Object.entries(limits.limits ?? {})) {
    if (!Number.isInteger(limit?.value) || limit.value < 1) errors.push(`${LIMITS_PATH}: ${name}.value must be a positive integer`);
    if (!limit?.unit?.trim()) errors.push(`${LIMITS_PATH}: ${name} has no unit`);
    if (!limit?.applies_to?.trim()) errors.push(`${LIMITS_PATH}: ${name} has no applies_to`);
    if (!limit?.rationale?.trim()) errors.push(`${LIMITS_PATH}: ${name} has no rationale`);
  }

  if (!codes.includes(limits.refusal_reason_code)) {
    errors.push(`${LIMITS_PATH}: refusal_reason_code ${limits.refusal_reason_code} is not in the reason-code vocabulary`);
  }
  if (limits.truncation_allowed !== false) {
    errors.push(`${LIMITS_PATH}: truncation_allowed must be false — orientation refuses, it never truncates`);
  }

  return errors;
}
