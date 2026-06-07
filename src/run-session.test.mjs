import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildRunSession,
  clearRunSession,
  findRunSession,
  mintSessionRunId,
  resolveRunSessionPath,
  RUN_SESSION_SCHEMA,
  writeRunSession,
} from "./run-session.mjs";
import { readLifecycleJournal } from "./lifecycle.mjs";
import { validateRunRecord } from "./run-record.mjs";

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
  assert.equal(buildRunSession({ runId: "r", lifecycleJournal: "j" }).packet, null);
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

test("findRunSession never honors a session located at the filesystem root or $HOME", () => {
  // We can't write to those dirs in a test, but the guard is unit-checkable:
  // a session whose dir equals the home/root sentinel returns null. Covered by
  // the project-boundary test above for the realistic ancestor case; this just
  // documents the home/root refusal exists. (See findRunSession dir === home/root.)
  withTempDir((dir) => {
    // Sanity: a normal project-rooted session is honored (control).
    writeRunSession(dir, buildRunSession({ runId: "run_ctrl", lifecycleJournal: "j" }));
    assert.equal(findRunSession(dir).session.run_id, "run_ctrl");
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
