import { createHash } from "node:crypto";

const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PLACEHOLDER_HUMANS = new Set([
  "agent",
  "anonymous",
  "automation",
  "bot",
  "campaigns-os",
  "ci",
  "cli flag",
  "cli_flag",
  "github actions",
  "github-actions",
  "github_actions",
  "ai",
  "none",
  "n/a",
  "na",
  "operator",
  "system",
  "unknown",
]);
const AUTOMATION_IDENTITY_TOKENS = new Set([
  "actions",
  "agent",
  "ai",
  "automation",
  "bot",
  "ci",
  "codex",
  "daemon",
  "github",
  "operator",
  "runner",
  "service",
  "system",
  "workflow",
]);
const AUTOMATION_COMPACT_ALIASES = new Set([
  "automation",
  "bot",
  "ai",
  "ci",
  "githubactions",
  "campaignsos",
  "claudecode",
  "cliflag",
  "codexagent",
  "automationrunner",
  "systemoperator",
  "githubactionsrunner",
  "servicedaemon",
  "workflowrunner",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function isValidTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function checkpointStateFingerprint({ scope, subject, state }) {
  const payload = canonicalJson({ scope, subject, state });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

export function isNamedHuman(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().replace(/\s+/g, " ");
  const letters = normalized.match(/\p{L}/gu) || [];
  if (letters.length < 2) return false;
  const lower = normalized.toLocaleLowerCase("en-US");
  const compact = lower.replace(/[^\p{L}\p{N}]+/gu, "");
  const tokens = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (PLACEHOLDER_HUMANS.has(lower)) return false;
  if (AUTOMATION_COMPACT_ALIASES.has(compact)) return false;
  if (tokens.some((token) => AUTOMATION_IDENTITY_TOKENS.has(token))) return false;
  // Claude is also a real one-word human name; reject the obvious product
  // identity without outlawing people named Claude.
  return !(tokens.includes("claude") && tokens.includes("code"));
}

function validWaiverRecord(record) {
  if (!(isPlainObject(record)
    && typeof record.scope === "string"
    && record.scope.trim() !== ""
    && isPlainObject(record.subject)
    && FINGERPRINT_PATTERN.test(record.state_fingerprint || "")
    && typeof record.reason === "string"
    && record.reason.trim() !== ""
    && isNamedHuman(record.waived_by)
    && isValidTimestamp(record.waived_at))) return false;

  const hasExpiry = record.expires_at != null;
  const hasReviewCondition = record.review_condition != null;
  if (!hasExpiry && !hasReviewCondition) return false;
  if (hasExpiry && (!isValidTimestamp(record.expires_at) || Date.parse(record.expires_at) <= Date.parse(record.waived_at))) {
    return false;
  }
  if (hasReviewCondition && (typeof record.review_condition !== "string" || record.review_condition.trim() === "")) {
    return false;
  }
  return true;
}

export function assessCheckpointWaivers(waivers, checkpoint, { now = new Date().toISOString() } = {}) {
  const assessment = {
    active: null,
    stale: [],
    foreign: [],
    malformed: [],
    expired: [],
  };
  const records = Array.isArray(waivers) ? waivers : [];
  const checkpointSubject = canonicalJson(checkpoint?.subject || {});
  const nowMs = Date.parse(now);
  let activeTime = Number.NEGATIVE_INFINITY;

  for (const record of records) {
    // Top-level Assembly Report waivers[] is shared by every checkpoint.
    // Other scopes are not foreign/malformed Store Profile history; they are
    // outside this evaluator entirely and must not create noise here.
    if (!isPlainObject(record) || record.scope !== checkpoint?.scope) continue;
    if (!validWaiverRecord(record)) {
      assessment.malformed.push(record);
      continue;
    }
    if (canonicalJson(record.subject) !== checkpointSubject) {
      assessment.foreign.push(record);
      continue;
    }
    if (record.state_fingerprint !== checkpoint?.state_fingerprint) {
      assessment.stale.push(record);
      continue;
    }
    if (record.expires_at != null && Date.parse(record.expires_at) <= nowMs) {
      assessment.expired.push(record);
      continue;
    }
    const waivedAt = Date.parse(record.waived_at);
    if (waivedAt >= activeTime) {
      assessment.active = record;
      activeTime = waivedAt;
    }
  }
  return assessment;
}

// Gate/readback/verdict artifacts must never echo arbitrary fields from an
// Assembly Report waiver record. This projection is checkpoint-generic so each
// registered gate can publish the same bounded attribution contract while the
// raw history remains private to evaluation.
export function projectCheckpointWaiver(record, checkpoint) {
  if (!validWaiverRecord(record)
    || !isPlainObject(checkpoint)
    || typeof checkpoint.scope !== "string"
    || !isPlainObject(checkpoint.subject)
    || !FINGERPRINT_PATTERN.test(checkpoint.state_fingerprint || "")) return null;
  return {
    scope: checkpoint.scope,
    subject: canonicalize(checkpoint.subject),
    state_fingerprint: checkpoint.state_fingerprint,
    reason: record.reason.trim(),
    waived_by: record.waived_by.trim().replace(/\s+/g, " "),
    waived_at: record.waived_at,
    ...(record.expires_at == null ? {} : { expires_at: record.expires_at }),
    ...(record.review_condition == null ? {} : { review_condition: record.review_condition.trim() }),
  };
}

export function projectCheckpointWaiverAssessment(assessment, checkpoint) {
  return {
    active: projectCheckpointWaiver(assessment?.active, checkpoint),
    inert_counts: {
      stale: Array.isArray(assessment?.stale) ? assessment.stale.length : 0,
      foreign: Array.isArray(assessment?.foreign) ? assessment.foreign.length : 0,
      malformed: Array.isArray(assessment?.malformed) ? assessment.malformed.length : 0,
      expired: Array.isArray(assessment?.expired) ? assessment.expired.length : 0,
    },
  };
}

export function createCheckpointWaiver(checkpoint, {
  reason,
  waivedBy,
  now = new Date().toISOString(),
  expiresAt = null,
  reviewCondition = null,
} = {}) {
  if (typeof checkpoint?.scope !== "string" || !checkpoint.scope.trim()) {
    throw new Error("Checkpoint waiver needs a non-empty scope.");
  }
  if (!isPlainObject(checkpoint?.subject)) {
    throw new Error("Checkpoint waiver needs a subject object.");
  }
  if (!FINGERPRINT_PATTERN.test(checkpoint?.state_fingerprint || "")) {
    throw new Error("Checkpoint waiver needs a current state fingerprint.");
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("Checkpoint waiver requires a non-empty reason.");
  }
  if (!isNamedHuman(waivedBy)) {
    throw new Error("Checkpoint waiver requires --waived-by with the named human who approved it; placeholders are not accepted.");
  }
  if (!isValidTimestamp(now)) throw new Error("Checkpoint waiver requires a valid waived_at timestamp.");
  if (expiresAt != null && !isValidTimestamp(expiresAt)) {
    throw new Error("Checkpoint waiver expires_at must be a valid timestamp when provided.");
  }
  if (reviewCondition != null && (typeof reviewCondition !== "string" || reviewCondition.trim() === "")) {
    throw new Error("Checkpoint waiver review_condition must be non-empty when provided.");
  }
  if (expiresAt == null && reviewCondition == null) {
    throw new Error("Checkpoint waiver requires at least one of expires_at or review_condition.");
  }
  if (expiresAt != null && Date.parse(expiresAt) <= Date.parse(now)) {
    throw new Error("Checkpoint waiver expires_at must be later than waived_at.");
  }
  return {
    scope: checkpoint.scope,
    subject: canonicalize(checkpoint.subject),
    state_fingerprint: checkpoint.state_fingerprint,
    reason: reason.trim(),
    waived_by: waivedBy.trim().replace(/\s+/g, " "),
    waived_at: new Date(now).toISOString(),
    ...(expiresAt == null ? {} : { expires_at: new Date(expiresAt).toISOString() }),
    ...(reviewCondition == null ? {} : { review_condition: reviewCondition.trim() }),
  };
}

export function appendCheckpointWaiver(report, waiver) {
  const base = isPlainObject(report) ? report : {};
  return {
    ...base,
    waivers: [...(Array.isArray(base.waivers) ? base.waivers : []), waiver],
  };
}

export function createCheckpointRegistry(entries) {
  if (!Array.isArray(entries)) throw new Error("Checkpoint registry entries must be an array.");
  const registry = {};
  for (const [index, entry] of entries.entries()) {
    if (!isPlainObject(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
      throw new Error(`Checkpoint registry entry ${index} needs a non-empty id.`);
    }
    if (typeof entry.evaluate !== "function") {
      throw new Error(`Checkpoint registry entry "${entry.id.trim()}" needs an evaluate function.`);
    }
    const id = entry.id.trim();
    if (Object.hasOwn(registry, id)) throw new Error(`Checkpoint registry has duplicate id "${id}".`);
    registry[id] = Object.freeze({ id, evaluate: entry.evaluate });
  }
  return Object.freeze(registry);
}

export function evaluateCheckpointRegistry(registry, id, context) {
  const entry = registry?.[id];
  if (!entry) throw new Error(`Unknown checkpoint gate "${id}".`);
  return entry.evaluate(context);
}
