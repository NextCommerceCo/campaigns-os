import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildRunSession,
  clearRunSession,
  findRunSession,
  isRunSessionStale,
  isRunSessionTerminal,
  mintSessionRunId,
  resolveRunSessionPath,
  RUN_SESSION_SCHEMA,
  RUN_SESSION_TTL_MS,
  writeRunSession,
} from "./run-session.mjs";
import { readLifecycleJournal } from "./lifecycle.mjs";
import { resolveRunRecordPath, validateRunRecord } from "./run-record.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-run-session-"));
  // Mark the temp dir as a project root so findRunSession's upward walk STOPS
  // here and can't be contaminated by a stray ancestor session (e.g. a leftover
  // /tmp or $HOME session on CI). This mirrors a real project, which always has
  // a package.json / .git at its root.
  writeFileSync(join(dir, "package.json"), "{}\n");
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- unit -----------------------------------------------------------------

test("mintSessionRunId is correctly shaped", () => {
  assert.match(mintSessionRunId(), /^run_\d+_[0-9a-f]+$/);
});

test("buildRunSession carries schema_version, run_id, journal, packet, timestamp", () => {
  const session = buildRunSession({ runId: "run_x", lifecycleJournal: "/tmp/lc.jsonl", packet: "/tmp/p.json", now: new Date("2026-06-07T00:00:00.000Z") });
  assert.equal(session.schema_version, RUN_SESSION_SCHEMA);
  assert.equal(session.run_id, "run_x");
  assert.equal(session.lifecycle_journal, "/tmp/lc.jsonl");
  assert.equal(session.packet, "/tmp/p.json");
  assert.equal(session.started_at, "2026-06-07T00:00:00.000Z");
  assert.equal(session.updated_at, "2026-06-07T00:00:00.000Z");
  assert.equal(buildRunSession({ runId: "r", lifecycleJournal: "j" }).packet, null);
});

test("stale and terminal session helpers classify old/explicitly-terminal sessions", () => {
  const session = buildRunSession({ runId: "run_old", lifecycleJournal: "j", now: new Date("2026-06-07T00:00:00.000Z") });
  assert.equal(isRunSessionStale(session, { now: new Date("2026-06-07T11:59:59.000Z") }), false);
  assert.equal(isRunSessionStale(session, { now: new Date("2026-06-07T12:00:01.000Z") }), true);
  assert.equal(isRunSessionStale(session, { now: new Date("2026-06-30T00:00:00.000Z"), ttlMs: Infinity }), false);
  assert.equal(isRunSessionTerminal({ ...session, terminal: true }), true);
  assert.equal(isRunSessionTerminal({ ...session, status: "terminal" }), true);
  assert.equal(isRunSessionTerminal({ ...session, last_recommendation: { stage: "done" } }), false);
  assert.equal(isRunSessionTerminal(session), false);
});

test("writeRunSession + findRunSession round-trip", () => {
  withTempDir((dir) => {
    const path = writeRunSession(dir, buildRunSession({ runId: "run_rt", lifecycleJournal: join(dir, "lc.jsonl") }));
    assert.equal(path, resolveRunSessionPath(dir));
    const found = findRunSession(dir);
    assert.equal(found.session.run_id, "run_rt");
    assert.equal(found.path, path);
  });
});

test("findRunSession walks UP from a subdirectory to the project session", () => {
  withTempDir((dir) => {
    writeRunSession(dir, buildRunSession({ runId: "run_up", lifecycleJournal: join(dir, "lc.jsonl") }));
    const deep = join(dir, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    const found = findRunSession(deep);
    assert.equal(found.session.run_id, "run_up");
  });
});

test("findRunSession: missing => null; malformed => null (never throws)", () => {
  withTempDir((dir) => {
    assert.equal(findRunSession(dir), null);
    mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
    writeFileSync(resolveRunSessionPath(dir), "{not json");
    assert.equal(findRunSession(dir), null);
    // present-but-no-run_id is also treated as inactive
    writeFileSync(resolveRunSessionPath(dir), JSON.stringify({ schema_version: RUN_SESSION_SCHEMA }));
    assert.equal(findRunSession(dir), null);
  });
});

test("findRunSession ignores stale sessions so old work sessions are not reused", () => {
  withTempDir((dir) => {
    writeRunSession(dir, buildRunSession({
      runId: "run_stale",
      lifecycleJournal: join(dir, "lc.jsonl"),
      now: new Date("2026-06-07T00:00:00.000Z"),
    }));
    assert.equal(
      findRunSession(dir, { now: new Date("2026-06-07T00:00:00.000Z") }).session.run_id,
      "run_stale",
    );
    assert.equal(
      findRunSession(dir, { now: new Date("2026-06-07T00:00:00.000Z"), ttlMs: RUN_SESSION_TTL_MS }).session.run_id,
      "run_stale",
    );
    assert.equal(findRunSession(dir, { now: new Date("2026-06-07T12:00:01.000Z") }), null);
  });
});

test("clearRunSession removes the session file (idempotent)", () => {
  withTempDir((dir) => {
    const path = writeRunSession(dir, buildRunSession({ runId: "run_clear", lifecycleJournal: "j" }));
    assert.equal(existsSync(path), true);
    assert.equal(clearRunSession(path), true);
    assert.equal(existsSync(path), false);
    assert.equal(clearRunSession(path), true); // no throw on already-gone
  });
});

test("findRunSession does NOT adopt a session ABOVE the project root (no cross-project hijack)", () => {
  withTempDir((parent) => {
    // A stray session in an ancestor directory...
    writeRunSession(parent, buildRunSession({ runId: "run_stray", lifecycleJournal: join(parent, "lc.jsonl") }));
    // ...and a real project nested below it (its own package.json marks the boundary).
    const project = join(parent, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), "{}\n");

    // From inside the project, the ancestor session must NOT be found.
    assert.equal(findRunSession(project), null);
    assert.equal(findRunSession(join(project, "sub", "dir")) ?? null, null);

    // A session AT the project root IS found.
    writeRunSession(project, buildRunSession({ runId: "run_own", lifecycleJournal: join(project, "lc.jsonl") }));
    assert.equal(findRunSession(project).session.run_id, "run_own");
  });
});

test("findRunSession never honors a session at $HOME or an ANCESTOR of $HOME (injected home)", () => {
  withTempDir((dir) => {
    // Session sits at `dir`; pretend $HOME is a subdir of it, making `dir` an
    // ancestor of home (the /Users-style hole). It must be refused.
    writeRunSession(dir, buildRunSession({ runId: "run_above_home", lifecycleJournal: "j" }));
    const fakeHome = join(dir, "me");
    mkdirSync(fakeHome, { recursive: true });
    assert.equal(findRunSession(join(fakeHome, "scratch"), { home: fakeHome }), null); // ancestor-of-home refused
    assert.equal(findRunSession(dir, { home: dir }), null); // dir === home refused

    // Control: a normal project-rooted session below home IS honored.
    const proj = join(fakeHome, "proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "package.json"), "{}\n");
    writeRunSession(proj, buildRunSession({ runId: "run_ok", lifecycleJournal: "j" }));
    assert.equal(findRunSession(proj, { home: fakeHome }).session.run_id, "run_ok");
  });
});

// --- CLI: the ambient experience -----------------------------------------

function runIn(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync("node", [CLI, ...args], { encoding: "utf8", cwd, stdio: "pipe" });
  } catch (error) {
    if (allowFail) return String(error.stdout || "");
    throw error;
  }
}

test("CLI: run start writes a session, run status reports it, run end clears it", () => {
  withTempDir((dir) => {
    const start = JSON.parse(runIn(dir, ["run", "start", "--json"]));
    assert.equal(start.ok, true);
    assert.match(start.session.run_id, /^run_/);
    assert.equal(existsSync(resolveRunSessionPath(dir)), true);

    const status = JSON.parse(runIn(dir, ["run", "status", "--json"]));
    assert.equal(status.active, true);
    assert.equal(status.session.run_id, start.session.run_id);
  });
});

test("CLI: run start refuses to clobber an active session unless --force", () => {
  withTempDir((dir) => {
    runIn(dir, ["run", "start", "--json"]);
    let threw = false;
    try {
      execFileSync("node", [CLI, "run", "start", "--json"], { encoding: "utf8", cwd: dir, stdio: "pipe" });
    } catch (error) {
      threw = true;
      assert.match(String(error.stderr || ""), /already active/);
    }
    assert.equal(threw, true);
    // --force replaces it
    const forced = JSON.parse(runIn(dir, ["run", "start", "--force", "--json"]));
    assert.equal(forced.ok, true);
  });
});

test("CLI: with a session active, a command auto-logs with NO per-command flags", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    const start = JSON.parse(runIn(dir, ["run", "start", "--json"]));

    // doctor with NO --run-id and NO --lifecycle-journal
    runIn(dir, ["doctor", "--packet", packetPath], { allowFail: true }); // exit 2 on synthetic packet

    const { entries } = readLifecycleJournal(start.session.lifecycle_journal);
    const doctorEntry = entries.find((e) => e.command === "doctor");
    assert.ok(doctorEntry, "doctor auto-logged to the session journal");
    assert.equal(doctorEntry.run_id, start.session.run_id); // tagged with the session run_id, no flag passed
    assert.equal(doctorEntry.exit_status, 2);
  });
});

test("CLI: lifecycle argv_shape preserves underscore-prefixed user flags", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    const start = JSON.parse(runIn(dir, ["run", "start", "--json"]));

    runIn(dir, ["doctor", "--packet", packetPath, "--_custom-audit-flag"], { allowFail: true });

    const { entries } = readLifecycleJournal(start.session.lifecycle_journal);
    const doctorEntry = entries.find((entry) => entry.command === "doctor");
    assert.ok(doctorEntry);
    assert.ok(doctorEntry.argv_shape.includes("--_custom-audit-flag"), JSON.stringify(doctorEntry.argv_shape));
  });
});

test("CLI: full ambient flow — run start -> prepare-build (no flags) -> run end aggregates the Run Record", () => {
  withTempDir((dir) => {
    const target = join(dir, "target");
    cpSync(resolve(ROOT, "examples/target-page-kit"), target, { recursive: true });
    const packetPath = join(target, "campaign-runtime.build.json");

    // Session rooted at the target dir; the packet is remembered so run end needs no flags.
    const start = JSON.parse(runIn(target, ["run", "start", "--packet", packetPath, "--json"]));

    // Build with NO run-telemetry flags at all.
    runIn(target, [
      "prepare-build",
      "--spec", resolve(ROOT, "examples/campaignspec.v42.basic.json"),
      "--source", resolve(ROOT, "examples/source-html"),
      "--target", target,
      "--template-family", "olympus",
    ], { allowFail: true });

    // run end: no flags — packet comes from the session.
    const end = JSON.parse(runIn(target, ["run", "end", "--no-remit", "--no-write", "--json"]));
    assert.equal(end.record.run_id, start.session.run_id);
    assert.equal(validateRunRecord(end.record).ok, true);
    const stageNames = end.record.lifecycle.stages.map((s) => s.name);
    assert.ok(stageNames.includes("prepare-build:resolve-spec"), JSON.stringify(stageNames));
    assert.ok(stageNames.includes("prepare-build:prepare-build"), JSON.stringify(stageNames));
    // session/telemetry commands never appear as build stages
    assert.ok(!stageNames.some((n) => n.startsWith("run:") || n === "run" || n === "run-record"), JSON.stringify(stageNames));

    // session is cleared after end
    assert.equal(findRunSession(target), null);
  });
});

test("CLI: qa run auto-writes Run Record and clears the active session", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    cpSync(resolve(ROOT, "examples/campaignspec.v42.basic.json"), join(dir, "campaignspec.v42.basic.json"));
    const start = JSON.parse(runIn(dir, ["run", "start", "--packet", packetPath, "--json"]));

    const qa = JSON.parse(runIn(dir, [
      "qa", "run",
      "--packet", packetPath,
      "--base-url", "http://127.0.0.1:4173/runtime-packet-demo/",
      "--no-post-verdict",
      "--no-remit",
      "--json",
    ], { allowFail: true }));

    assert.equal(qa.status, "blocked");
    assert.equal(findRunSession(dir), null);
    const recordPath = resolveRunRecordPath(start.session.run_id, dir);
    assert.equal(existsSync(recordPath), true);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.run_id, start.session.run_id);
    assert.equal(validateRunRecord(record).ok, true);
    assert.equal(record.remit_state, "skipped");
    assert.ok(record.artifacts.some((artifact) => artifact.kind === "qa_verdict"));
    assert.ok(record.lifecycle.stages.some((stage) => stage.name === "qa"));
    assert.equal(record.lifecycle.duration_ms >= 0, true);
  });
});

test("CLI: done recommendations suppress deviations but qa run still auto-writes the Run Record", () => {
  withTempDir((dir) => {
    const session = {
      ...buildRunSession({ runId: "run_done", lifecycleJournal: join(dir, ".campaign-runtime/command-lifecycle.jsonl") }),
      last_recommendation: {
        stage: "done",
        status: "ready",
        expected_commands: ["run-record"],
        issued_at: new Date("2026-06-07T00:00:00.000Z").toISOString(),
      },
    };
    writeRunSession(dir, session);
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    cpSync(resolve(ROOT, "examples/campaignspec.v42.basic.json"), join(dir, "campaignspec.v42.basic.json"));

    runIn(dir, [
      "qa", "run",
      "--packet", packetPath,
      "--base-url", "http://127.0.0.1:4173/runtime-packet-demo/",
      "--no-post-verdict",
      "--no-remit",
      "--json",
    ], { allowFail: true });
    assert.equal(existsSync(join(dir, ".campaign-runtime/agent-deviations.jsonl")), false);
    assert.equal(findRunSession(dir), null);
    const recordPath = resolveRunRecordPath(session.run_id, dir);
    assert.equal(existsSync(recordPath), true);
  });
});

test("CLI: findings from subdirectories use the active session journal", () => {
  withTempDir((dir) => {
    const target = join(dir, "target");
    mkdirSync(target, { recursive: true });
    const packetPath = join(target, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);

    const start = JSON.parse(runIn(target, ["run", "start", "--packet", packetPath, "--json"]));
    const subdir = join(target, "subdir");
    mkdirSync(subdir, { recursive: true });
    const added = JSON.parse(runIn(subdir, ["findings", "add", "--stage", "qa", "--kind", "friction", "--summary", "subdir finding", "--json"]));

    assert.equal(added.finding.run_id, start.session.run_id);
    assert.equal(realpathSync(added.journal), realpathSync(join(target, ".campaign-runtime", "workflow-findings.jsonl")));
    assert.equal(existsSync(join(subdir, ".campaign-runtime", "workflow-findings.jsonl")), false);

    const end = JSON.parse(runIn(target, ["run", "end", "--no-remit", "--no-write", "--json"]));
    assert.deepEqual(end.record.observations.finding_ids, [added.finding.id]);
  });
});

test("CLI: run end without a packet (and none in the session) fails clearly", () => {
  withTempDir((dir) => {
    runIn(dir, ["run", "start", "--json"]); // no --packet
    let threw = false;
    try {
      execFileSync("node", [CLI, "run", "end", "--json"], { encoding: "utf8", cwd: dir, stdio: "pipe" });
    } catch (error) {
      threw = true;
      assert.match(String(error.stderr || ""), /needs a build packet/);
    }
    assert.equal(threw, true);
  });
});

test("CLI: run end leaves the session ACTIVE when run-record fails (operator can fix + retry)", () => {
  withTempDir((dir) => {
    // Point the session at a packet that doesn't exist -> run-record throws.
    runIn(dir, ["run", "start", "--packet", join(dir, "missing.build.json"), "--json"]);
    let threw = false;
    try {
      execFileSync("node", [CLI, "run", "end", "--json"], { encoding: "utf8", cwd: dir, stdio: "pipe" });
    } catch {
      threw = true; // run-record fails reading the missing packet
    }
    assert.equal(threw, true);
    // Session must NOT be cleared on failure — the operator fixes the packet and retries.
    assert.notEqual(findRunSession(dir), null);
    assert.equal(findRunSession(dir).session.packet, join(dir, "missing.build.json"));
  });
});
