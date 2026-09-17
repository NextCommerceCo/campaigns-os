import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  buildRunSession,
  clearRunSession,
  findRunSession,
  isRunSessionStale,
  isRunSessionTerminal,
  mintSessionRunId,
  openRunSession,
  resolveRunSessionPath,
  RUN_SESSION_SCHEMA,
  RUN_SESSION_TTL_MS,
  sessionBoundTo,
  writeRunSession,
} from "./run-session.mjs";
import { runSessionCommand, runSessionEndArgs } from "./cli.mjs";
import { LIFECYCLE_JOURNAL_REL_PATH, readLifecycleJournal } from "./lifecycle.mjs";
import { SESSION_ENDING_DISPOSITIONS } from "./qa-verdict.mjs";
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

// The example packet declares a target repo beside it (examples/target-page-kit).
// Copied elsewhere, that declaration would point at a directory that is not
// there, so the copy names its target explicitly: the directory it sits in
// unless the test wants the session rooted somewhere else.
function copyPacket(dest, { targetRepo = "." } = {}) {
  const packet = JSON.parse(readFileSync(resolve(ROOT, "examples/build-packet.basic.json"), "utf8"));
  packet.assembly.target_repo = targetRepo;
  writeFileSync(dest, `${JSON.stringify(packet, null, 2)}\n`);
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

test("CLI: doctor inspection preserves active session, journal, report and sidecar bytes", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    copyPacket(packetPath);
    const start = JSON.parse(runIn(dir, ["run", "start", "--packet", packetPath, "--json"]));
    const runtime = join(dir, ".campaign-runtime");
    const report = join(runtime, "assembly-report.json");
    const doctor = join(runtime, "doctor-output.json");
    writeFileSync(report, JSON.stringify({ stages: { qa: { status: "completed" } } }));
    writeFileSync(doctor, JSON.stringify({ status: "ready", ok: true }));
    writeFileSync(start.session.lifecycle_journal, "{\"command\":\"previous-proof\"}\n");
    const retained = [resolveRunSessionPath(dir), start.session.lifecycle_journal, report, doctor];
    const before = retained.map(path => readFileSync(path, "utf8"));
    for (const extra of [[], ["--no-write"], ["--write", "--no-write"], ["--lifecycle-journal", start.session.lifecycle_journal]]) {
      const result = JSON.parse(runIn(dir, ["doctor", "--packet", packetPath, "--json", ...extra], { allowFail: true }));
      assert.equal(result.ok, false, "synthetic packet still reports its current blockers");
      assert.deepEqual(retained.map(path => readFileSync(path, "utf8")), before);
    }
  });
});

test("CLI: with a session active, a command auto-logs with NO per-command flags", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    copyPacket(packetPath);
    const start = JSON.parse(runIn(dir, ["run", "start", "--json"]));

    // doctor with NO --run-id and NO --lifecycle-journal
    runIn(dir, ["doctor", "--write", "--packet", packetPath], { allowFail: true }); // exit 2 on synthetic packet

    const { entries } = readLifecycleJournal(start.session.lifecycle_journal);
    const doctorEntry = entries.find((e) => e.command === "doctor");
    assert.ok(doctorEntry, "doctor auto-logged to the session journal");
    assert.equal(doctorEntry.run_id, start.session.run_id); // tagged with the session run_id, no flag passed
    assert.equal(doctorEntry.exit_status, 2);
  });
});

test("CLI: an absolute packet selects its target session from toolkit and unrelated directories", () => {
  withTempDir((dir) => {
    const target = join(dir, "target");
    const unrelated = join(dir, "operator-project");
    mkdirSync(target, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(target, "package.json"), "{}\n");
    writeFileSync(join(unrelated, "package.json"), "{}\n");
    const packetPath = join(target, "campaign-runtime.build.json");
    copyPacket(packetPath);
    const start = JSON.parse(runIn(target, ["run", "start", "--packet", packetPath, "--json"]));

    runIn(ROOT, ["doctor", "--write", "--packet", packetPath], { allowFail: true });
    runIn(unrelated, ["doctor", "--write", "--packet", packetPath], { allowFail: true });
    const status = JSON.parse(runIn(unrelated, ["run", "status", "--packet", packetPath, "--json"]));
    assert.equal(status.active, true);
    assert.equal(status.session.run_id, start.session.run_id);

    const { entries } = readLifecycleJournal(start.session.lifecycle_journal);
    assert.equal(entries.filter((entry) => entry.command === "doctor").length, 2);
    assert.ok(entries.filter((entry) => entry.command === "doctor").every((entry) => entry.run_id === start.session.run_id));
  });
});

test("CLI: packet-target sessions stay isolated and a conflicting cwd session is refused", () => {
  withTempDir((dir) => {
    const targets = ["campaign-a", "campaign-b"].map((name) => {
      const target = join(dir, name);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "package.json"), "{}\n");
      const packet = join(target, "campaign-runtime.build.json");
      copyPacket(packet);
      const start = JSON.parse(runIn(target, ["run", "start", "--packet", packet, "--json"]));
      return { target, packet, start };
    });

    runIn(ROOT, ["doctor", "--write", "--packet", targets[0].packet], { allowFail: true });
    runIn(ROOT, ["doctor", "--write", "--packet", targets[1].packet], { allowFail: true });
    for (const current of targets) {
      const doctors = readLifecycleJournal(current.start.session.lifecycle_journal).entries.filter((entry) => entry.command === "doctor");
      assert.equal(doctors.length, 1);
      assert.equal(doctors[0].run_id, current.start.session.run_id);
    }

    assert.throws(
      () => execFileSync("node", [CLI, "doctor", "--write", "--packet", targets[1].packet], { encoding: "utf8", cwd: targets[0].target, stdio: "pipe" }),
      /conflicting active run sessions/i,
    );
    clearRunSession(resolveRunSessionPath(targets[1].target));
    assert.throws(
      () => execFileSync("node", [CLI, "doctor", "--write", "--packet", targets[1].packet], { encoding: "utf8", cwd: targets[0].target, stdio: "pipe" }),
      (error) => /cwd selects .* but packet .* has no matching active target session/i.test(String(error.stderr || "")),
    );
  });
});

test("CLI: run start --packet from an unrelated directory roots the session in the packet's target and run end --packet closes it from there", () => {
  withTempDir((dir) => {
    const target = join(dir, "target");
    const unrelated = join(dir, "operator-project");
    cpSync(resolve(ROOT, "examples/target-page-kit"), target, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(unrelated, "package.json"), "{}\n");
    const packetPath = join(target, "campaign-runtime.build.json");
    copyPacket(packetPath);

    const start = JSON.parse(runIn(unrelated, ["run", "start", "--packet", packetPath, "--json"]));
    assert.equal(realpathSync(start.session_path), realpathSync(resolveRunSessionPath(target)));
    assert.equal(start.session.lifecycle_journal, join(realpathSync(target), LIFECYCLE_JOURNAL_REL_PATH));
    assert.equal(findRunSession(target).session.run_id, start.session.run_id);
    assert.equal(findRunSession(unrelated), null, "nothing was opened at cwd");
    assert.equal(existsSync(join(unrelated, ".campaign-runtime")), false);
    assert.equal(existsSync(join(unrelated, ".gitignore")), false, "the managed ignore block goes to the target, not cwd");
    assert.ok(readFileSync(join(target, ".gitignore"), "utf8").includes(".campaign-runtime/run-session.json"));

    const status = JSON.parse(runIn(target, ["run", "status", "--json"]));
    assert.equal(status.active, true);
    assert.equal(status.session.run_id, start.session.run_id);

    const end = JSON.parse(runIn(unrelated, ["run", "end", "--packet", packetPath, "--no-remit", "--no-write", "--json"]));
    assert.equal(end.action, "run-record");
    assert.equal(end.record.run_id, start.session.run_id);
    assert.equal(findRunSession(target), null, "run end --packet from elsewhere cleared the target session");
    assert.equal(existsSync(join(unrelated, ".campaign-runtime")), false);

    // The text output's advertised close works from the directory the operator
    // started in: it names the packet, since the session is not at cwd.
    const text = runIn(unrelated, ["run", "start", "--packet", packetPath]);
    assert.ok(text.includes(`Finish with: campaigns-os run end --packet ${realpathSync(packetPath)}`), text);
    assert.ok(text.includes(`Lifecycle journal: ${join(realpathSync(target), LIFECYCLE_JOURNAL_REL_PATH)}`), text);
    assert.ok(text.includes(`Every campaigns-os command in ${realpathSync(target)} —`), text);
    assert.ok(!text.includes(`${realpathSync(target)}/.campaign-runtime —`), "the project, not the storage directory, is named");
    const closed = runIn(unrelated, ["run", "end", "--packet", realpathSync(packetPath), "--no-remit", "--no-write"]);
    assert.match(closed, /ended; session cleared/);
    assert.equal(findRunSession(target), null);
  });
});

test("CLI: run start --packet roots on the packet's declared target repo, not the packet's directory or cwd", () => {
  withTempDir((dir) => {
    const target = join(dir, "target");
    const packets = join(dir, "packets");
    const elsewhere = join(dir, "elsewhere");
    for (const path of [target, packets, elsewhere]) {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "package.json"), "{}\n");
    }
    const packetPath = join(packets, "campaign-runtime.build.json");
    copyPacket(packetPath, { targetRepo: "../target" });

    const start = JSON.parse(runIn(elsewhere, ["run", "start", "--packet", packetPath, "--json"]));
    assert.equal(realpathSync(start.session_path), realpathSync(resolveRunSessionPath(target)));
    assert.equal(findRunSession(packets), null);
    assert.equal(findRunSession(elsewhere), null);
    assert.equal(existsSync(join(target, ".gitignore")), true);
    assert.equal(existsSync(join(packets, ".gitignore")), false);
    assert.equal(existsSync(join(elsewhere, ".gitignore")), false);

    // A packet reached through a symlink roots where discovery looks: the
    // real packet's target, so run status / run end by the symlink find it.
    runIn(elsewhere, ["run", "end", "--packet", packetPath, "--no-remit", "--no-write", "--json"]);
    const link = join(elsewhere, "linked-packet.build.json");
    symlinkSync(packetPath, link);
    const viaLink = JSON.parse(runIn(elsewhere, ["run", "start", "--packet", link, "--json"]));
    assert.equal(realpathSync(viaLink.session_path), realpathSync(resolveRunSessionPath(target)));
    // The session remembers the packet in the same canonical form the root was
    // derived from, so run end's Run Record lands beside the real packet, not
    // in the link's directory.
    assert.equal(viaLink.session.packet, realpathSync(packetPath));
    assert.equal(findRunSession(elsewhere), null);
    const linkedStatus = JSON.parse(runIn(elsewhere, ["run", "status", "--packet", link, "--json"]));
    assert.equal(linkedStatus.active, true);
    assert.equal(linkedStatus.session.run_id, viaLink.session.run_id);
    runIn(elsewhere, ["run", "end", "--packet", link, "--no-remit", "--no-write", "--json"]);
    assert.equal(findRunSession(target), null);

    // The bare form is unchanged: no --packet, the session opens at cwd.
    const bare = JSON.parse(runIn(elsewhere, ["run", "start", "--json"]));
    assert.equal(realpathSync(bare.session_path), realpathSync(resolveRunSessionPath(elsewhere)));
  });
});

test("CLI: run start --packet refuses a packet that exists but cannot be parsed instead of rooting on its directory", () => {
  withTempDir((dir) => {
    const target = join(dir, "target");
    const packets = join(dir, "packets");
    const elsewhere = join(dir, "elsewhere");
    for (const path of [target, packets, elsewhere]) {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "package.json"), "{}\n");
    }
    const packetPath = join(packets, "campaign-runtime.build.json");
    writeFileSync(packetPath, "{\"assembly\": {\"target_repo\": \"../target\"");

    for (const verb of ["start", "end"]) {
      assert.throws(
        () => runIn(elsewhere, ["run", verb, "--packet", packetPath, "--json"]),
        (error) => {
          const stderr = String(error.stderr || "");
          return error.status !== 0 && stderr.includes("could not be read as a build packet") && stderr.includes(realpathSync(packetPath));
        },
        `run ${verb} names the unreadable packet`,
      );
    }
    // A path that is not a readable file is refused with the OS error, not a
    // parse-error wording that would send the operator looking for bad JSON.
    assert.throws(
      () => runIn(elsewhere, ["run", "start", "--packet", packets, "--json"]),
      (error) => {
        const stderr = String(error.stderr || "");
        return stderr.includes(`--packet ${realpathSync(packets)} could not be read (`) && stderr.includes("EISDIR") && !stderr.includes("as a build packet");
      },
    );
    for (const path of [target, packets, elsewhere]) {
      assert.equal(findRunSession(path), null, `no session opened at ${path}`);
      assert.equal(existsSync(join(path, ".campaign-runtime")), false);
      assert.equal(existsSync(join(path, ".gitignore")), false);
    }

    // A packet that is not written yet is still fine: the session roots on the
    // packet's directory and the existing warning names it.
    rmSync(packetPath);
    const start = JSON.parse(runIn(elsewhere, ["run", "start", "--packet", packetPath, "--json"]));
    assert.equal(realpathSync(start.session_path), realpathSync(resolveRunSessionPath(packets)));
  });
});

test("CLI: lifecycle argv_shape preserves underscore-prefixed user flags", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    copyPacket(packetPath);
    const start = JSON.parse(runIn(dir, ["run", "start", "--json"]));

    runIn(dir, ["doctor", "--write", "--packet", packetPath, "--_custom-audit-flag"], { allowFail: true });

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

test("CLI: a repeated prepare-build from outside the target joins the session the first one opened", () => {
  withTempDir((dir) => {
    const target = join(dir, "target");
    cpSync(resolve(ROOT, "examples/target-page-kit"), target, { recursive: true });
    const intake = [
      "prepare-build",
      "--spec", resolve(ROOT, "examples/campaignspec.v42.basic.json"),
      "--source", resolve(ROOT, "examples/source-html"),
      "--target", target,
      "--template-family", "olympus",
    ];
    // Both runs from the toolkit checkout, the way an operator drives a
    // target from elsewhere; the first auto-opens the target's session.
    runIn(ROOT, intake, { allowFail: true });
    const session = findRunSession(target);
    assert.ok(session, "the first intake opened a session");
    runIn(ROOT, intake, { allowFail: true });
    runIn(ROOT, intake, { allowFail: true });

    const { entries } = readLifecycleJournal(session.session.lifecycle_journal);
    const intakes = entries.filter((entry) => entry.command === "prepare-build");
    assert.equal(intakes.length, 3, JSON.stringify(entries.map((entry) => entry.command)));
    assert.ok(intakes.every((entry) => entry.run_id === session.session.run_id));
    assert.equal(findRunSession(target).session.run_id, session.session.run_id, "no second session was opened");
  });
});

test("CLI: an intake does not join a session bound to a different packet", () => {
  withTempDir((dir) => {
    const target = join(dir, "target");
    cpSync(resolve(ROOT, "examples/target-page-kit"), target, { recursive: true });
    // A session bound to some other packet is already open at the target.
    const otherPacket = join(dir, "other-campaign-runtime.build.json");
    copyPacket(otherPacket, { targetRepo: "target" });
    const start = JSON.parse(runIn(target, ["run", "start", "--packet", otherPacket, "--json"]));
    const intake = [
      "prepare-build",
      "--spec", resolve(ROOT, "examples/campaignspec.v42.basic.json"),
      "--source", resolve(ROOT, "examples/source-html"),
      "--target", target,
      "--template-family", "olympus",
    ];
    runIn(ROOT, intake, { allowFail: true });

    assert.equal(findRunSession(target).session.run_id, start.session.run_id, "the bound session is left alone");
    const { entries } = readLifecycleJournal(start.session.lifecycle_journal);
    assert.equal(entries.filter((entry) => entry.command === "prepare-build").length, 0, "nothing was written into the foreign session");
  });
});

test("CLI: blocked qa run records an attempt and keeps the session open for repair", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    copyPacket(packetPath);
    const packet = JSON.parse(readFileSync(packetPath, "utf8"));
    packet.assembly.target_repo = ".";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
    cpSync(resolve(ROOT, "examples/campaignspec.v42.basic.json"), join(dir, "campaignspec.v42.basic.json"));
    mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
    cpSync(
      resolve(ROOT, "contracts/fixtures/sidecar-bundle/production-shaped/.campaign-runtime/assembly-report.json"),
      join(dir, ".campaign-runtime/assembly-report.json"),
    );
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
    const active = findRunSession(dir);
    assert.equal(active.session.run_id, start.session.run_id);
    assert.equal(active.session.qa_attempts.length, 1);
    assert.equal(active.session.qa_attempts[0].disposition, "blocked");
    assert.equal(realpathSync(active.session.qa_attempts[0].path), realpathSync(qa.local_path));
    const report = JSON.parse(readFileSync(join(dir, ".campaign-runtime/assembly-report.json"), "utf8"));
    assert.equal(report.stages.qa.status, "blocked");
    assert.equal(report.stages.qa.checked_at, qa.verdict.completed_at);
    assert.ok(report.stages.qa.outputs.includes(qa.local_path));
    const doctorSidecar = JSON.parse(readFileSync(join(dir, ".campaign-runtime/doctor-output.json"), "utf8"));
    assert.notEqual(doctorSidecar.stale, true);
    const recordPath = resolveRunRecordPath(start.session.run_id, dir);
    assert.equal(existsSync(recordPath), false);

    runIn(dir, ["run", "end", "--no-remit", "--json"]);
    assert.equal(findRunSession(dir), null);
    assert.equal(existsSync(recordPath), true);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.run_id, start.session.run_id);
    assert.equal(validateRunRecord(record).ok, true);
    // Toolkit provenance: this test runs from a git checkout of the toolkit, so
    // both fields resolve; the manifest is the authority for surface_version.
    const manifest = JSON.parse(readFileSync(join(ROOT, "contracts/supported-surface.json"), "utf8"));
    assert.equal(record.surface_version, manifest.surface_version);
    assert.match(record.toolkit_commit, /^[0-9a-f]{7,40}$/);
    assert.equal(record.remit_state, "skipped");
    assert.ok(record.artifacts.some((artifact) => artifact.kind === "qa_verdict"));
    assert.ok(record.lifecycle.stages.some((stage) => stage.name === "qa"));
    assert.equal(record.lifecycle.duration_ms >= 0, true);
  });
});

test("CLI: done recommendations suppress deviations while blocked qa keeps the repair session open", () => {
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
    copyPacket(packetPath);
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
    assert.equal(findRunSession(dir).session.run_id, session.run_id);
    const recordPath = resolveRunRecordPath(session.run_id, dir);
    assert.equal(existsSync(recordPath), false);
  });
});

test("CLI: run end references every QA attempt recorded on the session", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    copyPacket(packetPath);
    const started = JSON.parse(runIn(dir, ["run", "start", "--packet", packetPath, "--json"]));
    const firstPath = join(dir, "qa-output", "first.json");
    const secondPath = join(dir, "qa-output", "second.json");
    mkdirSync(join(dir, "qa-output"), { recursive: true });
    writeFileSync(firstPath, `${JSON.stringify({ schema_version: "campaigns-os-qa-verdict/v1", disposition: "blocked" })}\n`);
    writeFileSync(secondPath, `${JSON.stringify({ schema_version: "campaigns-os-qa-verdict/v1", disposition: "ready" })}\n`);
    writeRunSession(dir, {
      ...started.session,
      qa_attempts: [
        { path: firstPath, disposition: "blocked", run_id: "qa_1" },
        { path: secondPath, disposition: "ready", run_id: "qa_2" },
      ],
    });

    const ended = JSON.parse(runIn(dir, ["run", "end", "--qa-verdict", secondPath, "--no-remit", "--no-write", "--json"]));
    const qaRefs = ended.record.artifacts.filter((artifact) => artifact.kind === "qa_verdict");
    assert.deepEqual(qaRefs.map((artifact) => artifact.path), ["./qa-output/first.json", "./qa-output/second.json"]);
  });
});

test("CLI: findings from subdirectories use the active session journal", () => {
  withTempDir((dir) => {
    const target = join(dir, "target");
    mkdirSync(target, { recursive: true });
    const packetPath = join(target, "campaign-runtime.build.json");
    copyPacket(packetPath);

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
    // Recorded as the filesystem knows it: the real path of the directory
    // that exists, with the missing packet name re-appended.
    assert.equal(findRunSession(dir).session.packet, join(realpathSync(dir), "missing.build.json"));

  });
});

// --- one opener, one binding predicate ---------------------------------------

test("sessionBoundTo: an unbound session is every packet's; a bound one is only its own, by real path", () => {
  withTempDir((dir) => {
    const packet = join(dir, "campaign-runtime.build.json");
    writeFileSync(packet, "{}\n");
    const link = join(dir, "link.build.json");
    symlinkSync(packet, link);
    const session = buildRunSession({ runId: "run_1", lifecycleJournal: join(dir, "lc.jsonl") });

    assert.deepEqual(sessionBoundTo({ ...session, packet: null }, packet), { same: true, boundPacket: null });
    assert.deepEqual(sessionBoundTo({ ...session, packet }, packet), { same: true, boundPacket: packet });
    assert.deepEqual(sessionBoundTo({ ...session, packet }, link), { same: true, boundPacket: packet });
    assert.deepEqual(sessionBoundTo({ ...session, packet }, join(dir, "other.build.json")), { same: false, boundPacket: packet });
    assert.deepEqual(sessionBoundTo({ ...session, packet }, null), { same: false, boundPacket: packet });
  });
});

test("openRunSession: writes a session with the defaults the two openers share, and honors the explicit ones", () => {
  withTempDir((dir) => {
    const opened = openRunSession(dir, { packet: join(dir, "campaign-runtime.build.json"), lastRecommendation: { stage: "doctor" } });
    assert.equal(opened.joined, false);
    assert.equal(opened.existing, null);
    assert.equal(opened.found.dir, resolve(dir));
    assert.equal(opened.found.path, resolveRunSessionPath(dir));
    assert.match(opened.found.session.run_id, /^run_\d+_[0-9a-f]{8}$/);
    assert.equal(opened.found.session.lifecycle_journal, join(resolve(dir), LIFECYCLE_JOURNAL_REL_PATH));
    assert.equal(opened.found.session.packet, join(dir, "campaign-runtime.build.json"));
    assert.deepEqual(opened.found.session.last_recommendation, { stage: "doctor" });
    assert.deepEqual(findRunSession(dir).session, opened.found.session);

    const replaced = openRunSession(dir, { runId: "run_explicit", lifecycleJournal: join(dir, "own.jsonl"), force: true });
    assert.equal(replaced.found.session.run_id, "run_explicit");
    assert.equal(replaced.found.session.lifecycle_journal, join(dir, "own.jsonl"));
    assert.equal(replaced.found.session.packet, null);
    assert.equal("last_recommendation" in replaced.found.session, false);
    assert.equal(findRunSession(dir).session.run_id, "run_explicit");
  });
});

test("openRunSession: an open session is refused, joined when bound to this packet, and stood off when bound elsewhere", () => {
  withTempDir((dir) => {
    const packet = join(dir, "campaign-runtime.build.json");
    const first = openRunSession(dir, { packet });
    const fileBefore = readFileSync(resolveRunSessionPath(dir), "utf8");

    const refused = openRunSession(dir, { packet });
    assert.equal(refused.found, null);
    assert.equal(refused.joined, false);
    assert.equal(refused.existing.session.run_id, first.found.session.run_id);
    assert.equal(refused.binding.same, true);

    const joined = openRunSession(dir, { packet, join: true, lastRecommendation: { stage: "doctor" } });
    assert.equal(joined.joined, true);
    assert.equal(joined.found.session.run_id, first.found.session.run_id);
    assert.equal("last_recommendation" in joined.found.session, false, "a join adopts the session as it is");

    const foreign = openRunSession(dir, { packet: join(dir, "other.build.json"), join: true });
    assert.equal(foreign.found, null);
    assert.equal(foreign.existing.session.run_id, first.found.session.run_id);
    assert.deepEqual(foreign.binding, { same: false, boundPacket: packet });

    assert.equal(readFileSync(resolveRunSessionPath(dir), "utf8"), fileBefore, "neither a refusal nor a join writes");
  });
});

// --- one closer ---------------------------------------------------------------

test("runSessionEndArgs: the closing argv carries the session's identity and only the flags run-record reads", () => {
  const session = { run_id: "run_1", lifecycle_journal: "/p/.campaign-runtime/command-lifecycle.jsonl" };
  const qaRunArgs = {
    _: ["qa", "run"],
    packet: "/p/other.build.json",
    "base-url": "http://127.0.0.1:4173/x/",
    browser: true,
    "test-order": "off",
    "no-post-verdict": true,
    "auth-cookie": "secret",
    "run-id": "not-the-session",
    "lifecycle-journal": "/elsewhere.jsonl",
    "no-remit": true,
    "proxy-base": "http://127.0.0.1:1",
    json: true,
    report: "/p/report.json",
    "qa-verdict": "/p/qa-output/verdict.json",
  };
  assert.deepEqual(runSessionEndArgs(session, "/p/campaign-runtime.build.json", qaRunArgs), {
    _: ["run-record"],
    report: "/p/report.json",
    "qa-verdict": "/p/qa-output/verdict.json",
    "no-remit": true,
    "proxy-base": "http://127.0.0.1:1",
    json: true,
    packet: "/p/campaign-runtime.build.json",
    "run-id": "run_1",
    "lifecycle-journal": "/p/.campaign-runtime/command-lifecycle.jsonl",
  });
  assert.deepEqual(runSessionEndArgs(session, "/p/campaign-runtime.build.json"), {
    _: ["run-record"],
    packet: "/p/campaign-runtime.build.json",
    "run-id": "run_1",
    "lifecycle-journal": "/p/.campaign-runtime/command-lifecycle.jsonl",
  });
});

// The whitelist is hand-written, so the documented run-record flags are the
// drift signal: a flag `help` names for run-record must either be carried by
// the closer or be one of the three it sets itself.
test("runSessionEndArgs: every flag help documents for run-record is carried or closer-owned", () => {
  const help = execFileSync("node", [CLI, "help"], { encoding: "utf8" });
  const line = help.split("\n").find((entry) => /^\s*campaigns-os run-record /.test(entry));
  assert.ok(line, "help names run-record");
  const documented = [...line.matchAll(/--([a-z-]+)/g)].map((match) => match[1]);
  assert.ok(documented.length > 5, `help documents run-record's flags: ${documented.join(", ")}`);
  // The closer names the run id itself, so the id-resolution flags (--new-run)
  // and the inspection-only mode (--list) are its to withhold, not to carry.
  const closerOwned = new Set(["packet", "run-id", "lifecycle-journal", "new-run", "list"]);
  const extraArgs = Object.fromEntries(documented.map((flag) => [flag, `carried:${flag}`]));
  const endArgs = runSessionEndArgs({ run_id: "run_1", lifecycle_journal: "/p/lc.jsonl" }, "/p/packet.json", extraArgs);
  const dropped = documented.filter((flag) => !closerOwned.has(flag) && endArgs[flag] !== `carried:${flag}`);
  assert.deepEqual(dropped, [], "documented run-record flags the closer does not carry");
  assert.deepEqual([endArgs.packet, endArgs["run-id"], endArgs["lifecycle-journal"]], ["/p/packet.json", "run_1", "/p/lc.jsonl"]);
});

test("run start/status/end return their result in-process and print nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-run-session-inproc-"));
  writeFileSync(join(dir, "package.json"), "{}\n");
  const packetPath = join(dir, "campaign-runtime.build.json");
  copyPacket(packetPath);
  const priorCwd = process.cwd();
  const originalLog = console.log;
  const printed = [];
  console.log = (...parts) => printed.push(parts.join(" "));
  process.chdir(dir);
  try {
    const started = await runSessionCommand({ _: ["run", "start"], packet: packetPath, json: true });
    assert.equal(started.exitCode, 0);
    assert.equal(started.result.action, "run-start");
    assert.equal(started.result.session.packet, realpathSync(packetPath));
    assert.equal(findRunSession(dir).session.run_id, started.result.session.run_id);

    const status = await runSessionCommand({ _: ["run", "status"], json: true });
    assert.equal(status.result.action, "run-status");
    assert.equal(status.result.active, true);
    assert.equal(status.result.session.run_id, started.result.session.run_id);

    const ended = await runSessionCommand({ _: ["run", "end"], "no-remit": true, "no-write": true, json: true }, findRunSession(dir));
    assert.equal(ended.exitCode, 0);
    assert.equal(ended.result.action, "run-record");
    assert.equal(ended.result.written, false);
    assert.equal(ended.result.record.run_id, started.result.session.run_id);
    assert.equal(findRunSession(dir), null);

    const idle = await runSessionCommand({ _: ["run", "status"], json: true });
    assert.equal(idle.result.active, false);
    assert.deepEqual(printed, []);
  } finally {
    process.chdir(priorCwd);
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

// A session-ending `qa run` closes the session by the same path `run end`
// takes. The record it writes is run-record's, so its argv_shape names
// run-record's flags — not the flags `qa run` happened to be invoked with.
// The routes are served in-process, so the CLI runs asynchronously.
test("CLI: an auto-ended Run Record's argv_shape is run-record's, not qa run's", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-run-session-autoend-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(resolve(ROOT, "examples/target-page-kit"), dir, { recursive: true });
  const packetPath = join(dir, "campaign-runtime.build.json");
  copyPacket(packetPath);
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  packet.assembly.target_repo = ".";
  writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  cpSync(resolve(ROOT, "examples/campaignspec.v42.basic.json"), join(dir, "campaignspec.v42.basic.json"));
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  cpSync(
    resolve(ROOT, "contracts/fixtures/sidecar-bundle/production-shaped/.campaign-runtime/assembly-report.json"),
    join(dir, ".campaign-runtime/assembly-report.json"),
  );
  const server = createServer((request, response) => {
    const path = request.url;
    const meta = path.includes("/checkout/")
      ? '<meta name="next-page-type" content="checkout"><meta name="next-success-url" content="/runtime-packet-demo/upsell/">'
      : path.includes("/upsell/")
        ? '<meta name="next-page-type" content="upsell"><meta name="next-upsell-accept-url" content="/runtime-packet-demo/receipt/"><meta name="next-upsell-decline-url" content="/runtime-packet-demo/receipt/">'
        : "";
    const links = path.includes("/landing/")
      ? '<a href="/runtime-packet-demo/checkout/">Continue</a>'
      : path.includes("/checkout/")
        ? '<a href="/runtime-packet-demo/upsell/">Submit</a>'
        : path.includes("/upsell/")
          ? '<a href="/runtime-packet-demo/receipt/">Accept</a><a href="/runtime-packet-demo/receipt/">Decline</a>'
          : "";
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html><head><title>Fixture</title>${meta}</head><body><main>Fixture campaign</main>${links}</body></html>`);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/runtime-packet-demo/`;
  const run = async (args) => {
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, CAMPAIGNS_OS_LIFECYCLE_LOG: "" },
    });
    return stdout;
  };

  const start = JSON.parse(await run(["run", "start", "--packet", packetPath, "--json"]));
  const qa = JSON.parse(await run(["qa", "run", "--packet", packetPath, "--base-url", baseUrl, "--no-post-verdict", "--no-remit", "--json"]));
  assert.ok(SESSION_ENDING_DISPOSITIONS.has(qa.verdict.disposition), `the fixture must end the session: ${qa.verdict.disposition}`);
  assert.equal(findRunSession(dir), null, "a session-ending verdict closes the session");

  const record = JSON.parse(readFileSync(resolveRunRecordPath(start.session.run_id, dir), "utf8"));
  assert.equal(record.command, "run-record");
  assert.deepEqual(record.argv_shape, ["--json", "--lifecycle-journal", "--packet", "--qa-verdict", "--run-id"]);
  assert.ok(record.artifacts.some((artifact) => artifact.kind === "qa_verdict"));
});
