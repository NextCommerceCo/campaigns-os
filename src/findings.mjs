// Workflow Findings Sidecar — local Finding Capture for the Campaigns OS
// Learning Trail. See docs/workflow-findings-sidecar.md.
//
// This module owns the PUBLIC capture surface only: validate, append, list,
// and export Workflow Findings. It deliberately does NOT cluster, route,
// create Linear issues, or phone home — that is internal aggregation's job.
// Capturing a finding must never require Linear access or NEXT internal
// context, so this module has no network or credential dependencies.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const WORKFLOW_FINDING_SCHEMA = "campaigns-os-workflow-finding/v0";
export const FINDINGS_JOURNAL_REL_PATH = ".campaign-runtime/workflow-findings.jsonl";

export const FINDING_STAGES = [
  "overall",
  "intake",
  "start",
  "doctor",
  "setup",
  "build",
  "polish",
  "deploy",
  "qa",
  "test-order",
  "next",
];

export const FINDING_KINDS = [
  "positive_signal",
  "friction",
  "missing_prompt",
  "blocker",
  "docs_gap",
  "automation_gap",
  "idea",
];

export const FINDING_AUTHOR_TYPES = ["operator", "agent", "system"];

export const FINDING_EVIDENCE_QUALITY = [
  "operator_report",
  "artifact_referenced",
  "artifact_attached",
  "system_observed",
];

// Required core fields. Strict here; permissive about optional context.
const REQUIRED_FIELDS = ["schema_version", "id", "created_at", "stage", "kind", "summary"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Hand-rolled validator matching the repo convention (no AJV). Checks the
 * required core and the closed enums; leaves optional context fields
 * permissive. Returns `{ ok, errors }` where each error is `{ code, message }`.
 */
export function validateWorkflowFinding(finding) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });

  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    add("finding.type", "Workflow Finding must be a JSON object.");
    return { ok: false, errors };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!isNonEmptyString(finding[field])) {
      add(`finding.${field}`, `Missing or empty required field "${field}".`);
    }
  }

  if (finding.schema_version != null && finding.schema_version !== WORKFLOW_FINDING_SCHEMA) {
    add("finding.schema_version", `Expected schema_version "${WORKFLOW_FINDING_SCHEMA}".`);
  }
  if (isNonEmptyString(finding.stage) && !FINDING_STAGES.includes(finding.stage)) {
    add("finding.stage", `Unknown stage "${finding.stage}". Allowed: ${FINDING_STAGES.join(", ")}.`);
  }
  if (isNonEmptyString(finding.kind) && !FINDING_KINDS.includes(finding.kind)) {
    add("finding.kind", `Unknown kind "${finding.kind}". Allowed: ${FINDING_KINDS.join(", ")}.`);
  }
  if (finding.author_type != null && !FINDING_AUTHOR_TYPES.includes(finding.author_type)) {
    add("finding.author_type", `Unknown author_type "${finding.author_type}". Allowed: ${FINDING_AUTHOR_TYPES.join(", ")}.`);
  }
  if (finding.evidence_quality != null && !FINDING_EVIDENCE_QUALITY.includes(finding.evidence_quality)) {
    add("finding.evidence_quality", `Unknown evidence_quality "${finding.evidence_quality}". Allowed: ${FINDING_EVIDENCE_QUALITY.join(", ")}.`);
  }
  if (finding.artifact_paths != null && !Array.isArray(finding.artifact_paths)) {
    add("finding.artifact_paths", "artifact_paths must be an array of strings when present.");
  }
  if (finding.command_exit_status != null && !Number.isInteger(finding.command_exit_status)) {
    add("finding.command_exit_status", "command_exit_status must be an integer when present.");
  }
  if (finding.safe_to_share != null && typeof finding.safe_to_share !== "boolean") {
    add("finding.safe_to_share", "safe_to_share must be a boolean when present.");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Resolve the journal path. Precedence:
 *   1. explicit `--journal <path>`
 *   2. packet-adjacent target repo when `--packet <path>` is supplied
 *   3. current working directory otherwise
 */
export function resolveJournalPath(args, cwd = process.cwd()) {
  if (isNonEmptyString(args.journal)) return resolve(args.journal);
  if (isNonEmptyString(args.packet)) {
    return join(dirname(resolve(args.packet)), FINDINGS_JOURNAL_REL_PATH);
  }
  return join(resolve(cwd), FINDINGS_JOURNAL_REL_PATH);
}

function generateFindingId(now) {
  return `wf_${now.getTime()}_${randomBytes(4).toString("hex")}`;
}

function coerceBoolean(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

/**
 * Build a Workflow Finding object from parsed CLI flags. Generated values
 * (id, created_at, schema_version) and sensible defaults (author_type,
 * evidence_quality) are filled here so the JSONL line is self-describing.
 */
export function buildFinding(input, { now = new Date() } = {}) {
  const finding = {
    schema_version: WORKFLOW_FINDING_SCHEMA,
    id: isNonEmptyString(input.id) ? input.id : generateFindingId(now),
    created_at: isNonEmptyString(input.created_at) ? input.created_at : now.toISOString(),
    stage: isNonEmptyString(input.stage) ? input.stage.trim() : undefined,
    kind: isNonEmptyString(input.kind) ? input.kind.trim() : undefined,
    summary: isNonEmptyString(input.summary) ? input.summary.trim() : undefined,
  };

  const artifactPaths = parseArtifactPaths(input.artifact_paths);
  const optional = {
    details: input.details,
    expected: input.expected,
    actual: input.actual,
    severity: input.severity,
    command: input.command,
    source_type: input.source_type,
    template_family: input.template_family,
    map_id: input.map_id,
    campaign_slug: input.campaign_slug,
    target_repo: input.target_repo,
    packet_path: input.packet_path,
    assembly_report_path: input.assembly_report_path,
    qa_run_id: input.qa_run_id,
    suggested_owner: input.suggested_owner,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (isNonEmptyString(value)) finding[key] = value.trim();
  }
  if (artifactPaths.length) finding.artifact_paths = artifactPaths;
  if (Number.isInteger(input.command_exit_status)) finding.command_exit_status = input.command_exit_status;

  const safeToShare = coerceBoolean(input.safe_to_share);
  if (safeToShare !== null) finding.safe_to_share = safeToShare;

  // author_type: default operator for manual CLI adds; explicit flag wins.
  finding.author_type = FINDING_AUTHOR_TYPES.includes(input.author_type) ? input.author_type : "operator";

  // evidence_quality: explicit flag wins; otherwise infer artifact_referenced
  // when artifact paths were supplied, else operator_report.
  if (FINDING_EVIDENCE_QUALITY.includes(input.evidence_quality)) {
    finding.evidence_quality = input.evidence_quality;
  } else {
    finding.evidence_quality = artifactPaths.length ? "artifact_referenced" : "operator_report";
  }

  return finding;
}

function parseArtifactPaths(value) {
  if (Array.isArray(value)) return value.filter(isNonEmptyString).map((entry) => entry.trim());
  if (isNonEmptyString(value)) {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Append exactly one validated finding as one JSONL line. Never rewrites
 * existing entries — the journal is append-only.
 */
export function appendFinding(journalPath, finding) {
  const validation = validateWorkflowFinding(finding);
  if (!validation.ok) {
    const detail = validation.errors.map((error) => `[${error.code}] ${error.message}`).join("; ");
    throw new Error(`Workflow Finding failed validation: ${detail}`);
  }
  mkdirSync(dirname(resolve(journalPath)), { recursive: true });
  appendFileSync(resolve(journalPath), `${JSON.stringify(finding)}\n`);
  return finding;
}

/**
 * Read the journal. Returns `{ findings, malformed }`. Malformed lines are
 * preserved as `{ line, raw, error }` rather than throwing, so one bad line
 * never blocks listing or export of the rest of the Learning Trail.
 */
export function readJournal(journalPath) {
  const resolved = resolve(journalPath);
  if (!existsSync(resolved)) return { findings: [], malformed: [] };
  const text = readFileSync(resolved, "utf8");
  const findings = [];
  const malformed = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    try {
      findings.push(JSON.parse(raw));
    } catch (error) {
      malformed.push({ line: index + 1, raw, error: error.message });
    }
  }
  return { findings, malformed };
}

function groupByStageThenKind(findings) {
  // Internal aggregation groups by Observation Stage first, Finding Kind
  // second. The local export mirrors that ordering so a pasted summary reads
  // the same way the dashboard will later.
  const byStage = new Map();
  for (const finding of findings) {
    const stage = isNonEmptyString(finding.stage) ? finding.stage : "(unknown)";
    const kind = isNonEmptyString(finding.kind) ? finding.kind : "(unknown)";
    if (!byStage.has(stage)) byStage.set(stage, new Map());
    const byKind = byStage.get(stage);
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(finding);
  }
  const stageOrder = (stage) => {
    const index = FINDING_STAGES.indexOf(stage);
    return index === -1 ? FINDING_STAGES.length : index;
  };
  const kindOrder = (kind) => {
    const index = FINDING_KINDS.indexOf(kind);
    return index === -1 ? FINDING_KINDS.length : index;
  };
  return [...byStage.entries()]
    .sort((a, b) => stageOrder(a[0]) - stageOrder(b[0]) || a[0].localeCompare(b[0]))
    .map(([stage, byKind]) => ({
      stage,
      kinds: [...byKind.entries()]
        .sort((a, b) => kindOrder(a[0]) - kindOrder(b[0]) || a[0].localeCompare(b[0]))
        .map(([kind, items]) => ({ kind, items })),
    }));
}

/**
 * Markdown summary grouped by Observation Stage then Finding Kind. Includes
 * counts and short summaries and references (artifact paths, run IDs) only —
 * never artifact contents. Pasteable into Linear/GitHub/Slack.
 */
export function exportSummaryMarkdown(findings) {
  const lines = ["# Campaigns OS Workflow Findings", ""];
  lines.push(`Total findings: ${findings.length}`, "");
  if (!findings.length) {
    lines.push("_No findings recorded yet._");
    return `${lines.join("\n")}\n`;
  }
  for (const { stage, kinds } of groupByStageThenKind(findings)) {
    const stageCount = kinds.reduce((sum, group) => sum + group.items.length, 0);
    lines.push(`## ${stage} (${stageCount})`, "");
    for (const { kind, items } of kinds) {
      lines.push(`### ${kind} (${items.length})`);
      for (const finding of items) {
        const refs = [];
        if (Array.isArray(finding.artifact_paths) && finding.artifact_paths.length) {
          refs.push(`artifacts: ${finding.artifact_paths.join(", ")}`);
        }
        if (isNonEmptyString(finding.qa_run_id)) refs.push(`qa_run: ${finding.qa_run_id}`);
        if (isNonEmptyString(finding.map_id)) refs.push(`map: ${finding.map_id}`);
        const refSuffix = refs.length ? ` — _${refs.join("; ")}_` : "";
        lines.push(`- ${finding.summary || "(no summary)"}${refSuffix}`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * Structured JSON export for internal ingestion. Validates each entry and
 * strips nothing but also adds nothing — artifact contents are never present
 * because findings only ever store references.
 */
export function exportJson(findings) {
  const invalid = [];
  for (const finding of findings) {
    const validation = validateWorkflowFinding(finding);
    if (!validation.ok) invalid.push({ id: finding?.id || null, errors: validation.errors });
  }
  if (invalid.length) {
    const detail = invalid
      .map((entry) => `${entry.id || "(no id)"}: ${entry.errors.map((error) => error.code).join(", ")}`)
      .join(" | ");
    throw new Error(`Findings Journal has invalid entries; refusing to export: ${detail}`);
  }
  return {
    schema_version: WORKFLOW_FINDING_SCHEMA,
    count: findings.length,
    findings,
  };
}
