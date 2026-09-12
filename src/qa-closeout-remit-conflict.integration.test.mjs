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

test("the closeout command a QA run prints under an open session does not spend the session's run_id", async (t) => {
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
  const [closeout] = buildQaCloseoutActions({ packetPath, localPath: verdictPath, runSessionActive: true });
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

  const [closeout] = buildQaCloseoutActions({ packetPath, localPath: null, runSessionActive: false });
  assert.doesNotMatch(closeout.command, /--no-remit/, "a sessionless closeout owns its run id and must publish it");
  await runCli([...tokenize(closeout.command).slice(1), "--proxy-base", receiver.base], { cwd: dir });

  assert.equal(receiver.posts.length, 1);
  const [record] = readRecords(dir);
  assert.equal(record.remit_state, "ok");
  assert.equal(receiver.posts[0].run_id, record.run_id);
});
