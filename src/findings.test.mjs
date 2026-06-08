import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  appendFinding,
  buildFinding,
  exportJson,
  exportSummaryMarkdown,
  readJournal,
  resolveJournalPath,
  validateWorkflowFinding,
  WORKFLOW_FINDING_SCHEMA,
} from "./findings.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-findings-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, options = {}) {
  return execFileSync("node", [CLI, ...args], { encoding: "utf8", cwd: options.cwd });
}

function minimalFinding(overrides = {}) {
  return buildFinding({ stage: "overall", kind: "positive_signal", summary: "spec-driven dev kept checkout and upsell logic intact", ...overrides });
}

test("schema accepts a minimal valid finding", () => {
  const finding = minimalFinding();
  const result = validateWorkflowFinding(finding);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(finding.schema_version, WORKFLOW_FINDING_SCHEMA);
  assert.match(finding.id, /^wf_\d+_[0-9a-f]+$/);
});

test("schema rejects missing required fields", () => {
  const result = validateWorkflowFinding({ schema_version: WORKFLOW_FINDING_SCHEMA, id: "x", created_at: "now" });
  assert.equal(result.ok, false);
  const codes = result.errors.map((error) => error.code);
  assert.ok(codes.includes("finding.stage"));
  assert.ok(codes.includes("finding.kind"));
  assert.ok(codes.includes("finding.summary"));
});

test("schema rejects unknown enum values", () => {
  assert.equal(validateWorkflowFinding(minimalFinding({ stage: "nope" })).ok, false);
  assert.equal(validateWorkflowFinding(minimalFinding({ kind: "nope" })).ok, false);
});

test("evidence_quality infers artifact_referenced when artifact paths are supplied", () => {
  const withArtifacts = buildFinding({ stage: "qa", kind: "friction", summary: "x", artifact_paths: "a.json,b.json" });
  assert.equal(withArtifacts.evidence_quality, "artifact_referenced");
  assert.deepEqual(withArtifacts.artifact_paths, ["a.json", "b.json"]);
  const without = minimalFinding();
  assert.equal(without.evidence_quality, "operator_report");
});

test("appendFinding writes one JSONL line and is append-only", () => {
  withTempDir((dir) => {
    const journal = join(dir, "workflow-findings.jsonl");
    appendFinding(journal, minimalFinding());
    appendFinding(journal, minimalFinding({ kind: "friction", summary: "second" }));
    const lines = readFileSync(journal, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) JSON.parse(line); // each line is valid JSON
    const { findings, malformed } = readJournal(journal);
    assert.equal(findings.length, 2);
    assert.equal(malformed.length, 0);
  });
});

test("appendFinding refuses an invalid finding", () => {
  withTempDir((dir) => {
    const journal = join(dir, "workflow-findings.jsonl");
    assert.throws(() => appendFinding(journal, { schema_version: WORKFLOW_FINDING_SCHEMA, id: "x", created_at: "now", stage: "bad", kind: "friction", summary: "x" }));
    assert.equal(existsSync(journal), false);
  });
});

test("readJournal preserves malformed lines instead of throwing", () => {
  withTempDir((dir) => {
    const journal = join(dir, "workflow-findings.jsonl");
    appendFinding(journal, minimalFinding());
    appendFileSync(journal, "{not json}\n");
    const { findings, malformed } = readJournal(journal);
    assert.equal(findings.length, 1);
    assert.equal(malformed.length, 1);
    assert.equal(malformed[0].line, 2);
  });
});

test("exportSummaryMarkdown groups by stage then kind", () => {
  const findings = [
    minimalFinding(),
    minimalFinding({ stage: "qa", kind: "missing_prompt", summary: "QA was not obvious as next step" }),
  ];
  const md = exportSummaryMarkdown(findings);
  assert.match(md, /# Campaigns OS Workflow Findings/);
  assert.match(md, /## overall \(1\)/);
  assert.match(md, /### positive_signal \(1\)/);
  assert.match(md, /## qa \(1\)/);
  // overall sorts before qa in the canonical stage order
  assert.ok(md.indexOf("## overall") < md.indexOf("## qa"));
});

test("exportJson validates and wraps entries", () => {
  const out = exportJson([minimalFinding()]);
  assert.equal(out.schema_version, WORKFLOW_FINDING_SCHEMA);
  assert.equal(out.count, 1);
  assert.throws(() => exportJson([{ id: "bad" }]));
});

test("resolveJournalPath precedence: journal > packet-adjacent > cwd", () => {
  assert.equal(resolveJournalPath({ journal: "/tmp/x.jsonl" }), resolve("/tmp/x.jsonl"));
  const packetAdjacent = resolveJournalPath({ packet: "/tmp/repo/campaign-runtime.build.json" });
  assert.equal(packetAdjacent, resolve("/tmp/repo/.campaign-runtime/workflow-findings.jsonl"));
  const cwd = resolveJournalPath({}, "/tmp/here");
  assert.equal(cwd, resolve("/tmp/here/.campaign-runtime/workflow-findings.jsonl"));
});

test("CLI: findings add appends, list reads, export emits markdown + json", () => {
  withTempDir((dir) => {
    const journal = join(dir, "wf.jsonl");
    runCli(["findings", "add", "--journal", journal, "--stage", "overall", "--kind", "positive_signal", "--summary", "spec-driven dev kept checkout and upsell logic intact"]);

    const listJson = JSON.parse(runCli(["findings", "list", "--journal", journal, "--json"]));
    assert.equal(listJson.count, 1);
    assert.equal(listJson.findings[0].stage, "overall");

    const md = runCli(["findings", "export", "--journal", journal, "--summary"]);
    assert.match(md, /## overall/);
    assert.doesNotMatch(md, /Workflow finding\?/); // no Tiny Prompt prose leaks into export

    const exportJsonOut = JSON.parse(runCli(["findings", "export", "--journal", journal, "--json"]));
    assert.equal(exportJsonOut.count, 1);
  });
});

test("run_id: stamped when provided, absent (backward-compatible) when not", () => {
  const withRunId = minimalFinding({ run_id: "run_123_abcd" });
  assert.equal(withRunId.run_id, "run_123_abcd");
  assert.equal(validateWorkflowFinding(withRunId).ok, true);

  const without = minimalFinding();
  assert.equal("run_id" in without, false); // never invents a run_id
  assert.equal(validateWorkflowFinding(without).ok, true);
});

test("run_id: validator rejects a non-string run_id but accepts null/absent", () => {
  // buildFinding only stamps non-empty strings, so test the validator on a raw
  // object to exercise the type guard directly.
  assert.equal(validateWorkflowFinding({ ...minimalFinding(), run_id: 42 }).ok, false);
  assert.equal(validateWorkflowFinding({ ...minimalFinding(), run_id: null }).ok, true);
});

test("CLI: findings add --run-id stamps the run_id onto the journal entry", () => {
  withTempDir((dir) => {
    const journal = join(dir, "wf.jsonl");
    runCli(["findings", "add", "--journal", journal, "--stage", "qa", "--kind", "friction", "--summary", "slow step", "--run-id", "run_cli_xyz"]);
    const { findings } = readJournal(journal);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].run_id, "run_cli_xyz");
  });
});

test("CLI: findings add inherits the active run session id", () => {
  withTempDir((dir) => {
    const started = JSON.parse(runCli(["run", "start", "--json"], { cwd: dir }));
    const result = JSON.parse(runCli(["findings", "add", "--stage", "qa", "--kind", "friction", "--summary", "slow step", "--json"], { cwd: dir }));
    const journal = join(dir, ".campaign-runtime", "workflow-findings.jsonl");
    const { findings } = readJournal(journal);

    assert.equal(result.finding.run_id, started.session.run_id);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].run_id, started.session.run_id);
  });
});

test("CLI: findings add fails clearly when required flags are missing (non-interactive)", () => {
  withTempDir((dir) => {
    const journal = join(dir, "wf.jsonl");
    let threw = false;
    try {
      execFileSync("node", [CLI, "findings", "add", "--journal", journal, "--stage", "overall"], { encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      threw = true;
      const stderr = String(error.stderr || "");
      assert.match(stderr, /--kind/);
      assert.match(stderr, /--summary/);
    }
    assert.equal(threw, true);
    assert.equal(existsSync(journal), false);
  });
});
