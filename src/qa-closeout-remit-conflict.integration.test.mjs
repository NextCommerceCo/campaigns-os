// The QA closeout command, executed exactly as printed, against a receiver
// that behaves the way the real one does.
//
// Remit is a plain POST with no replace verb, and the receiver keeps one record
// per run_id: a second POST for an id it already holds comes back 409
// run_record_conflict. A `run-record` command run while a run session is open
// inherits that session's run_id, so if the printed command remits, it spends
// the session's one accepted send on an interim record and the record that
// actually closes the run — the one carrying every QA attempt and the
// aggregated lifecycle — is refused.
//
// This test does not assert the command text and stop there. It takes the
// string the QA output prints, tokenizes it, runs it through the real CLI
// against a real HTTP receiver that enforces the conflict, then closes the
// session, and asks the receiver what it got.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

import { buildQaCloseoutActions } from "./qa-node.mjs";
import { autoEndCloseoutNotice } from "./cli.mjs";
import { assessRunRecordCloseout } from "./run-record-closeout.mjs";
import { buildRunSession, writeRunSession } from "./run-session.mjs";

// Async on purpose: the receiver below lives in THIS process, so a synchronous
// child-process call would block the event loop that has to accept its request.
const execFileAsync = promisify(execFile);

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

/** A receiver that stores one record per run_id and 409s a repeat POST for a stored id. */
async function startConflictingReceiver() {
  const posts = [];
  const stored = new Set();
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {
        payload = null;
      }
      const runId = payload?.run_id || null;
      posts.push({ method: request.method, url: request.url, run_id: runId });
      if (request.method !== "POST") {
        response.writeHead(405, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (runId && stored.has(runId)) {
        response.writeHead(409, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "run_record_conflict", run_id: runId }));
        return;
      }
      if (runId) stored.add(runId);
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, run_id: runId }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return {
    posts,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((done) => server.close(done));
    },
  };
}

/** Split a printed command into argv, honoring the single quotes shellToken adds. */
function tokenize(command) {
  const tokens = [];
  const pattern = /'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) tokens.push(match[1] ?? match[2]);
  return tokens;
}

async function runCli(argv, { cwd }) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...argv], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "on", CAMPAIGNS_OS_LIFECYCLE_LOG: "" },
  });
  return stdout;
}

function readRecords(dir) {
  const recordDir = join(dir, ".campaign-runtime", "run-records");
  return readdirSync(recordDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(recordDir, name), "utf8")));
}

test("the closeout command a blocked QA run prints does not spend the still-open session's run_id", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-closeout-remit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const receiver = await startConflictingReceiver();
  t.after(() => receiver.close());

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "closeout-remit-target", private: true }));
  const packetPath = join(dir, "campaign-runtime.build.json");
  cpSync(join(ROOT, "examples/build-packet.basic.json"), packetPath);
  const verdictPath = join(dir, "qa-verdict.json");
  writeFileSync(verdictPath, JSON.stringify({ schema_version: "campaigns-os-qa-verdict/v1", disposition: "blocked" }));

  const started = JSON.parse(await runCli(["run", "start", "--packet", packetPath, "--json"], { cwd: dir }));
  const sessionRunId = started.session.run_id;
  assert.ok(sessionRunId, "run start must mint a session run id");

  // Exactly what a blocked QA run prints, executed as printed. Only the
  // receiver base is appended, so the fake endpoint is reachable at all.
  const [closeout] = buildQaCloseoutActions({ packetPath, localPath: verdictPath, runSessionActive: true, disposition: "blocked" });
  const argv = tokenize(closeout.command);
  assert.equal(argv[0], "campaigns-os");
  await runCli([...argv.slice(1), "--proxy-base", receiver.base], { cwd: dir });

  // The session closes the way the ready auto-end closes it: run-record under
  // the session's run_id, then clear. (src/cli.mjs runs the identical pair.)
  await runCli(["run", "end", "--packet", packetPath, "--proxy-base", receiver.base, "--json"], { cwd: dir });

  const sends = receiver.posts.filter((entry) => entry.run_id === sessionRunId);
  assert.equal(
    sends.length,
    1,
    `the session's run id must be sent exactly once; the receiver saw ${sends.length} POSTs for ${sessionRunId}`,
  );

  const closing = readRecords(dir).filter((record) => record.run_id === sessionRunId);
  assert.equal(closing.length, 1, "one local record carries the session's run id");
  assert.equal(closing[0].remit_state, "ok", `the closing record must be accepted, not refused: ${closing[0].remit_error}`);
  assert.equal(closing[0].remit_ok, true);
  assert.equal(closing[0].remit_error, null);
});

test("with no run session open the printed closeout still remits on its own run id", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-closeout-remit-solo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const receiver = await startConflictingReceiver();
  t.after(() => receiver.close());

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "closeout-remit-solo", private: true }));
  const packetPath = join(dir, "campaign-runtime.build.json");
  cpSync(join(ROOT, "examples/build-packet.basic.json"), packetPath);

  const [closeout] = buildQaCloseoutActions({ packetPath, localPath: null, runSessionActive: false, disposition: "blocked" });
  assert.doesNotMatch(closeout.command, /--no-remit/, "a sessionless closeout owns its run id and must publish it");
  await runCli([...tokenize(closeout.command).slice(1), "--proxy-base", receiver.base], { cwd: dir });

  assert.equal(receiver.posts.length, 1);
  const [record] = readRecords(dir);
  assert.equal(record.remit_state, "ok");
  assert.equal(receiver.posts[0].run_id, record.run_id);
});

// A terminal verdict auto-ends the session: the record is assembled, remitted
// and the session cleared inside the SAME process, before the operator can run
// the printed command. So a closeout printed with --no-remit there would mint a
// second, local-only record — and because the closeout assessor takes the
// newest matching record and counts `skipped` as closed, that newer record
// would bury an auto-end remit that FAILED and suppress its recovery.
//
// The auto-end itself is not reachable from a test without a deployed campaign
// to run QA against, so this drives `run end` instead: cli.mjs runs the
// identical runRecordCommand + clearRunSession pair, which is what produces the
// state under test — a session record on disk whose remit did not close.
test("a failed session remit stays recoverable: the closeout does not print a local-only record over it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-closeout-recovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // A receiver that refuses everything: the session's remit cannot close.
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "receiver_unavailable" }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "closeout-recovery", private: true }));
  const packetPath = join(dir, "campaign-runtime.build.json");
  cpSync(join(ROOT, "examples/build-packet.basic.json"), packetPath);
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));

  const started = JSON.parse(await runCli(["run", "start", "--packet", packetPath, "--json"], { cwd: dir }));
  const sessionRunId = started.session.run_id;
  await runCli(["run", "end", "--packet", packetPath, "--proxy-base", base, "--json"], { cwd: dir });

  const sessionRecord = readRecords(dir).find((record) => record.run_id === sessionRunId);
  assert.equal(sessionRecord.remit_state, "failed", "the session's record must be the failed-remit case under test");

  // With only that record on disk, the assessor still demands recovery.
  const closeout = assessRunRecordCloseout({
    records: readRecords(dir).map((record) => ({ record })),
    packet,
  });
  assert.notEqual(closeout.reason_code, "satisfied", "a failed remit is not a closed record");
  assert.equal(closeout.reason_code, "remit_failed");
  assert.equal(closeout.record_id, sessionRunId, "recovery must name the existing run id, not a new one");

  // And the printed QA closeout for a terminal verdict does not add a
  // local-only record that would become the newest and bury it.
  const [action] = buildQaCloseoutActions({ packetPath, localPath: null, runSessionActive: true, disposition: "ready" });
  assert.doesNotMatch(action.command, /--no-remit/);

  // The auto-end is where that failure is surfaced. It names the file to keep
  // and does NOT advertise a reassembling "recovery" — see the next test.
  const notice = autoEndCloseoutNotice({
    runId: sessionRunId,
    recordPath: "/t/record.json",
    remitState: sessionRecord.remit_state,
    remitError: sessionRecord.remit_error,
  });
  assert.match(notice, /remit did not complete/);
  assert.match(notice, /\/t\/record\.json/);
  assert.doesNotMatch(notice, /--run-id/);
});

test("the auto-end notice stays quiet when the remit closed", () => {
  for (const remitState of ["ok", "skipped"]) {
    const notice = autoEndCloseoutNotice({ runId: "run_1_abcd", recordPath: "/t/r.json", remitState });
    assert.doesNotMatch(notice, /--run-id/);
    assert.match(notice, /auto-ended after qa run/);
  }
});

// Why the auto-end notice names a file to keep instead of a command to run.
//
// `run-record --run-id <id>` REASSEMBLES; it does not reload the record already
// written under that id. A session's QA attempt references reach the record
// only through ambient.session.qa_attempts, and a failed auto-end has already
// cleared the session — so on a session with more than one attempt the command
// that looks like a recovery overwrites the complete record with a thinner one
// and would send that instead.
//
// This is a characterization test: it pins the behaviour that makes the advice
// correct today. If reload-and-resend of the persisted record ever lands, this
// test SHOULD fail — update it then, and the notice with it.
test("re-running run-record against a cleared session's id reassembles, and thins a multi-attempt record", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-recovery-thinning-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const refusing = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "receiver_unavailable" }));
    });
  });
  await new Promise((done) => refusing.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => refusing.close(done)));
  const accepting = await startConflictingReceiver();
  t.after(() => accepting.close());

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "recovery-thinning", private: true }));
  const packetPath = join(dir, "campaign-runtime.build.json");
  cpSync(join(ROOT, "examples/build-packet.basic.json"), packetPath);

  // Two QA attempts, the shape a repaired run leaves: one blocked, then ready.
  const attemptPaths = ["attempt-blocked.json", "attempt-ready.json"].map((name, index) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({
      schema_version: "campaigns-os-qa-verdict/v1",
      run_id: `qa_${index}`,
      disposition: index === 0 ? "blocked" : "ready",
    }));
    return path;
  });

  const runId = "run_1789300000000_multiattempt";
  const session = buildRunSession({ runId, lifecycleJournal: join(dir, ".campaign-runtime/command-lifecycle.jsonl"), packet: packetPath });
  writeRunSession(dir, {
    ...session,
    qa_attempts: attemptPaths.map((path, index) => ({ path, disposition: index === 0 ? "blocked" : "ready", run_id: `qa_${index}` })),
  });

  // The session close assembles the complete record; its remit is refused.
  await runCli(["run", "end", "--packet", packetPath, "--proxy-base", `http://127.0.0.1:${refusing.address().port}`, "--json"], { cwd: dir });
  const assembled = readRecords(dir).find((record) => record.run_id === runId);
  const qaRefs = (record) => record.artifacts.filter((artifact) => artifact.kind === "qa_verdict").length;
  assert.equal(assembled.remit_state, "failed");
  assert.equal(qaRefs(assembled), 2, "the session's record carries both attempts");

  // Now the command that looks like a recovery, against a receiver that accepts.
  await runCli(["run-record", "--packet", packetPath, "--run-id", runId, "--proxy-base", accepting.base, "--json"], { cwd: dir });
  const after = readRecords(dir).find((record) => record.run_id === runId);

  assert.equal(after.remit_state, "ok", "the send itself succeeds — which is what makes the loss quiet");
  assert.ok(
    qaRefs(after) < 2,
    "the reassembled record drops the session's attempt references; if this now holds both, reload-and-resend has landed and the notice can advertise it",
  );
  assert.equal(accepting.posts.length, 1, "and the thinner record is what reached the receiver");
});

// The notice is the operator's only signal that a remit failed, and it is
// multi-line by construction. Neither the run id nor the record path is
// toolkit-authored — the path derives from the packet's target directory, the
// id can arrive via --run-id — so a newline or an ANSI escape in either would
// split the message, overwrite a line, or forge one that reads as toolkit
// output. Each field stays on its own line, mangled-but-visible.
test("the auto-end notice keeps one clean line per field", () => {
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const ESC = String.fromCharCode(27);
  const notice = autoEndCloseoutNotice({
    runId: ["run_1_abcd", "[campaigns-os] remit ok"].join(LF),
    recordPath: ["/t/records", `${ESC}[2Krun.json`, "spoofed"].join(CR),
    remitState: "failed",
    remitError: ["boom", "[campaigns-os] and all is well"].join(LF),
  });

  // Exactly the notice's own two lines, each one the toolkit's: an injected
  // newline would either add a third or leave a line the prefix does not open.
  const lines = notice.trimEnd().split(LF);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.match(line, /^\[campaigns-os\] /);
  for (const control of [CR, ESC]) {
    assert.ok(!notice.includes(control), `notice must not carry ${JSON.stringify(control)}`);
  }
  // Replaced, not dropped: the operator still sees that the value was mangled.
  assert.match(notice, /run_1_abcd�/);
  assert.match(notice, /\/t\/records�/);
  assert.match(notice, /remit did not complete \(boom�/);
});

test("the auto-end notice survives a missing run id and record path", () => {
  const notice = autoEndCloseoutNotice({ runId: null, recordPath: null, remitState: "failed", remitError: null });
  assert.match(notice, /\(unnamed run\)/);
  assert.match(notice, /Run Record assembled\./);
  assert.match(notice, /nothing on disk to keep/);
});
