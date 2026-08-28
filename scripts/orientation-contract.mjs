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

export function entryHash(entry) {
  const { entry_sha256: _ignored, ...rest } = entry;
  return sha256Hex(canonicalJson(rest));
}

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
 */
export function validateLedgerStructure(ledger, { policy, surface, sections }) {
  const errors = [];
  const knownClasses = new Set(Object.keys(policy.semantic_classes ?? {}));
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : null;

  if (ledger?.schema_version !== "campaigns-os-release-ledger/v1") {
    errors.push(`${LEDGER_PATH}: schema_version must be "campaigns-os-release-ledger/v1"`);
  }
  if (!entries) return [...errors, `${LEDGER_PATH}: entries must be an array`];

  const seenIds = new Set();
  const seenIdentities = new Map();
  const seenSections = new Map();
  let previousSequence = 0;
  let previousDate = "";

  for (const entry of entries) {
    const where = `${LEDGER_PATH} ${entry?.id ?? "<entry with no id>"}`;

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

    if (entry.sequence !== previousSequence + 1) {
      errors.push(`${where}: sequence must be ${previousSequence + 1} (append-only order), got ${entry.sequence}`);
    }
    previousSequence = typeof entry.sequence === "number" ? entry.sequence : previousSequence + 1;

    if (typeof entry.date === "string" && entry.date < previousDate) {
      errors.push(`${where}: date ${entry.date} is earlier than the previous entry's ${previousDate}; entries are ordered`);
    }
    if (typeof entry.date === "string") previousDate = entry.date;

    if (entry.kind === "amendment") {
      if (!entry.amends) errors.push(`${where}: an amendment must name the entry it amends`);
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

    // Changelog correspondence: exactly one section, matching hash.
    if (sections) {
      const linked = sections.filter((section) => section.section_id === entry.changelog_section);
      if (linked.length === 0) {
        errors.push(`${where}: changelog_section "${entry.changelog_section}" has no matching section in ${CHANGELOG_PATH}`);
      } else if (linked.length > 1) {
        errors.push(`${where}: changelog_section "${entry.changelog_section}" matches ${linked.length} sections in ${CHANGELOG_PATH}; section identifiers must be unique`);
      } else if (linked[0].body_sha256 !== entry.changelog_sha256) {
        errors.push(
          `${where}: changelog_sha256 does not match the body of ${CHANGELOG_PATH} section "${entry.changelog_section}" ` +
            `(actual ${linked[0].body_sha256}) — update the ledger hash in the same change that edits the section`,
        );
      }
      const priorEntry = seenSections.get(entry.changelog_section);
      if (priorEntry) {
        errors.push(`${where}: changelog section "${entry.changelog_section}" is already linked from ${priorEntry}; the link is one-to-one`);
      }
      seenSections.set(entry.changelog_section, entry.id);
    }

    // Surface-version entries: at most one entry per surface version.
    if (entry.surface_version) {
      const key = `surface:${entry.surface_version}`;
      const prior = seenIdentities.get(key);
      if (prior) errors.push(`${where}: surface_version ${entry.surface_version} is already claimed by ${prior}; a surface change owes exactly one entry`);
      seenIdentities.set(key, entry.id);
    }

    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      if (!knownClasses.has(change.class)) {
        errors.push(`${where}: change class ${JSON.stringify(change.class)} is not defined in ${POLICY_PATH}`);
        continue;
      }
      // Identity uniqueness applies to releases only. An amendment exists to
      // re-describe a change an earlier entry already recorded — requiring it to
      // invent a fresh identity would make corrections indistinguishable from
      // new work, which is the opposite of what append-only history is for.
      if (entry.kind !== "amendment") {
        const identity = `change:${changeIdentity(change)}`;
        const prior = seenIdentities.get(identity);
        if (prior) {
          errors.push(`${where}: change identity ${changeIdentity(change)} is already recorded by ${prior}; each change is recorded once`);
        }
        seenIdentities.set(identity, entry.id);
      }

      if (change.path) {
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
      if (change.surface_entry && surface) {
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

export function validateAppendOnly(baseEntries, headEntries) {
  const errors = [];
  const head = new Map(headEntries.map((entry) => [entry.id, entry]));
  let maxBaseSequence = 0;

  for (const baseEntry of baseEntries) {
    maxBaseSequence = Math.max(maxBaseSequence, baseEntry.sequence ?? 0);
    const current = head.get(baseEntry.id);
    if (!current) {
      errors.push(`${LEDGER_PATH} ${baseEntry.id}: historical entry was deleted — the ledger is append-only; ship a correction as a new amendment entry`);
      continue;
    }
    if (canonicalJson(current) !== canonicalJson(baseEntry)) {
      errors.push(`${LEDGER_PATH} ${baseEntry.id}: historical entry was rewritten — the ledger is append-only; ship a correction as a new amendment entry`);
    }
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
 * Fail closed against the declared limits. Returns every limit exceeded, not
 * the first, and never truncates or trims the measured input. The caller is
 * expected to refuse with `limits.refusal_reason_code`.
 */
export function evaluateLimits(measured, limitsContract) {
  const limits = limitsContract.limits;
  const exceeded = [];
  const compare = [
    ["max_source_bytes", measured.source_bytes],
    ["max_section_count", measured.section_count],
    ["max_section_bytes", measured.max_observed_section_bytes],
    ["max_envelope_bytes", measured.envelope_bytes],
    ["max_ledger_entries", measured.ledger_entries],
  ];
  for (const [name, actual] of compare) {
    if (typeof actual !== "number") continue;
    if (actual > limits[name].value) exceeded.push(name);
  }
  return {
    exceeded,
    within_limits: exceeded.length === 0,
    reason_code: exceeded.length ? limitsContract.refusal_reason_code : null,
    truncated: false,
    detail: exceeded.map((name) => `${name}: ${compare.find(([key]) => key === name)[1]} exceeds ${limits[name].value} ${limits[name].unit}`),
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

  if (!codes.includes(limits.refusal_reason_code)) {
    errors.push(`${LIMITS_PATH}: refusal_reason_code ${limits.refusal_reason_code} is not in the reason-code vocabulary`);
  }
  if (limits.truncation_allowed !== false) {
    errors.push(`${LIMITS_PATH}: truncation_allowed must be false — orientation refuses, it never truncates`);
  }

  return errors;
}
