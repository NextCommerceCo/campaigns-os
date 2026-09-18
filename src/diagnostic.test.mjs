import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { diagnosticExport, diagnosticTextLines } from "./diagnostic.mjs";
import { toolingDiagnose } from "./cli.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SECRET = "seeded-support-secret-user@example.test";
const tooling = { package: { version: "1.34.1" }, install: { mode: "node_modules", pinned: { commit: "a".repeat(40) } }, status: "ready", skills: { ok: true } };

test("diagnostic exports accepted IDs and fixed recovery while dropping seeded secrets in every producer", () => {
  const doctor = { status: "blocked", next: { stage: "doctor-blocked", owner: SECRET, command: SECRET },
    errors: [{ code: "page_kit.store_profile.mismatch", message: SECRET, detail: { url: `https://user:${SECRET}@example.test`, path: `/private/${SECRET}` } }, { code: SECRET }],
    warnings: [{ code: "polish.stale", message: SECRET }], derived: { checkpoint_gates: [{ required_actions: [{ id: "repair_target", command: SECRET }, { id: SECRET }] }], content: SECRET } };
  const result = diagnosticExport({ tooling: { ...tooling, argv: SECRET, environment: SECRET, prompts: SECRET }, doctor, platform: "codex" });
  const exported = JSON.stringify(result) + diagnosticTextLines(result).join("\n");
  assert.equal(exported.includes(SECRET), false);
  assert.equal(exported.includes("https://"), false);
  assert.equal(exported.includes("/private/"), false);
  assert.deepEqual(result.reason_ids, ["diagnostic.unsupported_reason", "page_kit.store_profile.mismatch", "polish.stale"]);
  assert.deepEqual(result.action_ids, ["diagnostic.unsupported_action", "doctor", "repair_target"]);
  assert.equal(result.freshness.inspection, "observed");
  assert.ok(result.recovery.every((item) => item.owner && item.input_needed));
});

test("unsupported diagnostic enums and package version never echo their raw values", () => {
  const result = diagnosticExport({ tooling: { ...tooling, package: { version: SECRET }, install: { mode: SECRET }, status: SECRET }, doctor: { status: SECRET, next: { stage: SECRET } }, platform: SECRET });
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(result.version, null);
  for (const field of ["install_mode", "platform", "tooling_status", "doctor_status", "stage"]) assert.equal(result[field], "unknown");
  assert.ok(result.reason_ids.includes("diagnostic.unsupported_value"));
});

test("diagnose forwards only read-only inputs and suppresses sensitive producer exceptions", () => {
  let readArgs;
  const result = toolingDiagnose({ packet: SECRET, write: true, "doctor-out": SECRET, remit: true, platform: "claude" }, {
    runTooling: () => tooling,
    runDoctor: (args) => { readArgs = args; throw new Error(SECRET); },
  });
  assert.deepEqual(readArgs, { packet: SECRET, "no-write": true });
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(result.doctor_status, "unavailable");
  assert.ok(result.reason_ids.includes("diagnostic.inspection_unavailable"));
});

function snapshotTree(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? snapshotTree(join(dir, entry.name)) : [[join(dir, entry.name), readFileSync(join(dir, entry.name)).toString("base64")]]);
}

test("CLI diagnostic does not sweep stale active sessions, mutate evidence, or capture a requested lifecycle journal", () => {
  const scratch = mkdtempSync(join(tmpdir(), "campaigns-os-diagnostic-"));
  try {
    cpSync(join(ROOT, "contracts/fixtures/sidecar-bundle/production-shaped"), scratch, { recursive: true });
    const stateDir = join(scratch, ".campaign-runtime");
    writeFileSync(join(stateDir, "run-session.json"), JSON.stringify({ schema_version: "campaigns-os-run-session/v0", run_id: SECRET, opened_at: "2000-01-01T00:00:00Z", packet_path: SECRET }));
    const before = snapshotTree(scratch);
    const journal = join(scratch, "sensitive-lifecycle.jsonl");
    const result = execFileSync(process.execPath, [join(ROOT, "bin/campaigns-os.mjs"), "tooling", "diagnose", "--platform", "codex", "--packet", join(scratch, "campaign-runtime.build.json"), "--write", "--lifecycle-journal", journal, "--json"], { cwd: scratch, encoding: "utf8", env: { ...process.env, CAMPAIGNS_OS_LIFECYCLE_LOG: journal } });
    const parsed = JSON.parse(result);
    assert.equal(parsed.schema_version, "campaigns-os-diagnostic/v0");
    assert.equal(result.includes(scratch), false);
    assert.equal(result.includes(SECRET), false);
    assert.equal(existsSync(journal), false);
    assert.deepEqual(snapshotTree(scratch), before);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("toolkit freshness stays local-ref or unknown and never claims network or deployment currency", () => {
  const base = { ...tooling, install: { mode: "checkout" }, git: { status: "ok", behind: 0 } };
  assert.equal(diagnosticExport({ tooling: base }).freshness.toolkit, "local_ref_current");
  assert.equal(diagnosticExport({ tooling: { ...base, git: { status: "ok", behind: 3 } } }).freshness.toolkit, "local_ref_behind");
  assert.equal(diagnosticExport({ tooling: { ...base, git: { status: "ok", behind: null } } }).freshness.toolkit, "unknown");
});
