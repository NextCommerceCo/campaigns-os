// What a re-run of run-record does to the record already on disk under that
// run_id, and how the receiver's answer is read.
//
// The receiver keeps one record per run_id and answers a repeat POST with 409.
// run-record is keyed on run_id and is what `run end`, the QA auto-end and the
// recovery action `next` prints all call, so a re-run over a record whose send
// landed must not stamp that send as failed — and a retry whose answer is 409
// must read as stored, or the recovery action re-sends the same record forever.
//
// Every send here goes to a loopback receiver in this process; telemetry is
// forced on only for the commands that carry that receiver's --proxy-base.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

import { resolveRunRecordPath } from "./run-record.mjs";

const execFileAsync = promisify(execFile);

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

/**
 * A receiver whose answer is chosen per test: `store` behaves like the real
 * one (one record per run_id, 409 on a repeat), the others answer every POST
 * the same way regardless of what they hold.
 */
async function startReceiver() {
  const posts = [];
  const stored = new Set();
  let mode = "store";
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
      posts.push({ method: request.method, url: request.url, payload });
      if (request.method === "GET") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<html><body>maintenance</body></html>");
        return;
      }
      const runId = payload?.run_id || null;
      if (mode === "conflict" || (mode === "store" && runId && stored.has(runId))) {
        response.writeHead(409, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "run_record_conflict", run_id: runId }));
        return;
      }
      if (mode === "refuse") {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "receiver_unavailable" }));
        return;
      }
      if (mode === "html") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<html><body>maintenance</body></html>");
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
    setMode(next) {
      mode = next;
    },
    async close() {
      await new Promise((done) => server.close(done));
    },
  };
}

function seedTarget(t) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-remit-rerun-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "remit-rerun-target", private: true }));
  const packetPath = join(dir, "campaign-runtime.build.json");
  cpSync(join(ROOT, "examples/build-packet.basic.json"), packetPath);
  return { dir, packetPath };
}

async function runCli(argv, { cwd, telemetry = "on" }) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...argv], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: cwd, CAMPAIGNS_OS_TELEMETRY: telemetry, CAMPAIGNS_OS_LIFECYCLE_LOG: "" },
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: error.code ?? 1, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

function readRecord(dir, runId) {
  return JSON.parse(readFileSync(resolveRunRecordPath(runId, dir), "utf8"));
}

const remitFields = (record) => ({
  state: record.remit_state,
  attempted: record.remit_attempted,
  ok: record.remit_ok,
  error: record.remit_error,
  endpoint: record.remit_endpoint,
});

test("a re-run under a run id whose record is remitted keeps that record and sends nothing", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const receiver = await startReceiver();
  t.after(() => receiver.close());
  const runId = "run_1789300000000_rerun";
  const argv = ["run-record", "--packet", packetPath, "--run-id", runId, "--proxy-base", receiver.base, "--json"];

  const first = await runCli(argv, { cwd: dir });
  assert.equal(first.status, 0, first.stderr);
  const firstOut = JSON.parse(first.stdout);
  assert.equal(firstOut.remit.result, "stored");
  assert.equal(firstOut.remit.http_status, 201);
  assert.equal(firstOut.remit.base_kind, "loopback");
  const stored = readRecord(dir, runId);
  assert.equal(stored.remit_state, "ok");

  // The same command again — what the recovery action prints, and what an
  // operator re-running by hand does. The receiver would answer 409; it is
  // not asked.
  const second = await runCli(argv, { cwd: dir });
  assert.equal(second.status, 0, second.stderr);
  const secondOut = JSON.parse(second.stdout);
  assert.deepEqual(remitFields(readRecord(dir, runId)), remitFields(stored), "a durable ok is never rewritten to failed");
  assert.deepEqual(readRecord(dir, runId), stored, "the record on disk is left exactly as written");
  assert.equal(secondOut.written, false);
  assert.equal(secondOut.remit.result, "already_stored");
  assert.equal(secondOut.remit.sent, false);
  assert.equal(receiver.posts.length, 1, "no second POST for a run id the receiver holds");

  // Nor does a local-only re-run file it as skipped.
  const local = await runCli(["run-record", "--packet", packetPath, "--run-id", runId, "--no-remit", "--json"], { cwd: dir, telemetry: "off" });
  assert.equal(local.status, 0, local.stderr);
  assert.equal(readRecord(dir, runId).remit_state, "ok", "--no-remit over a remitted record does not downgrade it to skipped");

  // The text rendering says what happened rather than reporting a fresh send.
  const text = await runCli(["run-record", "--packet", packetPath, "--run-id", runId, "--proxy-base", receiver.base], { cwd: dir });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^Run Record already closed and remitted for run run_1789300000000_rerun; left as written\.$/m);
  assert.match(text.stdout, /^Remit: ok \(already stored at the receiver for this run id; not re-sent\) -> \/api\/runs$/m);
  assert.equal(receiver.posts.length, 1);
});

test("a 409 answer to a retry reads as stored, not failed, so recovery converges", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const receiver = await startReceiver();
  t.after(() => receiver.close());
  const runId = "run_1789300000001_retry";
  const argv = ["run-record", "--packet", packetPath, "--run-id", runId, "--proxy-base", receiver.base, "--json"];

  // The first send is refused: a failed remit on disk, the recovery case.
  receiver.setMode("refuse");
  const refused = JSON.parse((await runCli(argv, { cwd: dir })).stdout);
  assert.equal(refused.remit.result, "refused");
  assert.equal(refused.remit.http_status, 500);
  const failed = readRecord(dir, runId);
  assert.equal(failed.remit_state, "failed");
  assert.match(failed.remit_error, /^Remit POST 500: Internal Server Error \{"error":"receiver_unavailable"\}$/);

  // The retry is answered 409: the receiver holds the id (say, the first
  // answer was lost after the store). That is the stored outcome.
  receiver.setMode("conflict");
  const retried = await runCli(argv, { cwd: dir });
  assert.equal(retried.status, 0, retried.stderr);
  const out = JSON.parse(retried.stdout);
  assert.equal(out.remit.result, "already_stored");
  assert.equal(out.remit.http_status, 409);
  assert.deepEqual(remitFields(readRecord(dir, runId)), { state: "ok", attempted: true, ok: true, error: null, endpoint: "/api/runs" });
  assert.equal(receiver.posts.length, 2, "the retry was sent once");

  // And the closeout assessor now sees a closed record, not a recovery.
  const { assessRunRecordCloseout } = await import("./run-record-closeout.mjs");
  const closeout = assessRunRecordCloseout({
    records: [{ path: resolveRunRecordPath(runId, dir), record: readRecord(dir, runId) }],
    packet: JSON.parse(readFileSync(packetPath, "utf8")),
  });
  assert.equal(closeout.reason_code, "satisfied", closeout.detail);

  // Text rendering of the 409 case, on a fresh id whose first send is refused.
  const textId = "run_1789300000002_retrytext";
  receiver.setMode("refuse");
  await runCli(["run-record", "--packet", packetPath, "--run-id", textId, "--proxy-base", receiver.base, "--json"], { cwd: dir });
  receiver.setMode("conflict");
  const text = await runCli(["run-record", "--packet", packetPath, "--run-id", textId, "--proxy-base", receiver.base], { cwd: dir });
  assert.match(text.stdout, /^Remit: ok \(already stored at the receiver for this run id; HTTP 409\) -> \/api\/runs \(unscoped: .*\) \[base: loopback\]$/m);
});

test("a local-only re-run over a failed remit keeps the failure instead of filing it as skipped", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const receiver = await startReceiver();
  t.after(() => receiver.close());
  const runId = "run_1789300000003_keepfailed";
  receiver.setMode("refuse");
  await runCli(["run-record", "--packet", packetPath, "--run-id", runId, "--proxy-base", receiver.base, "--json"], { cwd: dir });
  const failed = readRecord(dir, runId);
  assert.equal(failed.remit_state, "failed");

  const local = await runCli(["run-record", "--packet", packetPath, "--run-id", runId, "--no-remit", "--json"], { cwd: dir, telemetry: "off" });
  assert.equal(local.status, 0, local.stderr);
  const out = JSON.parse(local.stdout);
  assert.equal(out.written, true, "the record is reassembled and rewritten");
  assert.equal(out.remit.preserved, true);
  assert.equal(out.remit.sent, false);
  assert.deepEqual(remitFields(readRecord(dir, runId)), remitFields(failed), "the failed send stays visible to closeout");

  const text = await runCli(["run-record", "--packet", packetPath, "--run-id", runId, "--no-remit"], { cwd: dir, telemetry: "off" });
  assert.match(text.stdout, /^Remit: not attempted this run; the prior outcome for this run id is kept \(failed: Remit POST 500: /m);
  assert.equal(receiver.posts.length, 1);
});

test("run end on a session re-opened under an already-remitted id leaves the record as written", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const receiver = await startReceiver();
  t.after(() => receiver.close());
  const runId = "run_1789300000004_session";

  await runCli(["run", "start", "--packet", packetPath, "--run-id", runId, "--json"], { cwd: dir, telemetry: "off" });
  const ended = await runCli(["run", "end", "--packet", packetPath, "--proxy-base", receiver.base, "--json"], { cwd: dir });
  assert.equal(ended.status, 0, ended.stderr);
  const stored = readRecord(dir, runId);
  assert.equal(stored.remit_state, "ok");

  await runCli(["run", "start", "--packet", packetPath, "--run-id", runId, "--json"], { cwd: dir, telemetry: "off" });
  const again = await runCli(["run", "end", "--packet", packetPath, "--proxy-base", receiver.base, "--json"], { cwd: dir });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(readRecord(dir, runId), stored);
  assert.equal(receiver.posts.length, 1);
});

test("a 2xx whose body is not JSON is recorded as ok with the anomaly on the record", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const receiver = await startReceiver();
  t.after(() => receiver.close());
  const runId = "run_1789300000005_html";
  receiver.setMode("html");
  const run = await runCli(["run-record", "--packet", packetPath, "--run-id", runId, "--proxy-base", receiver.base, "--json"], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.remit.result, "ok_unparsed_ack");
  assert.equal(out.remit.http_status, 200);
  const record = readRecord(dir, runId);
  assert.equal(record.remit_state, "ok");
  assert.equal(record.remit_ok, true);
  assert.match(record.remit_error, /^Remit POST 200: acknowledged with a body that is not JSON: <html><body>maintenance<\/body><\/html>$/);

  const text = await runCli(["run-record", "--packet", packetPath, "--run-id", "run_1789300000006_htmltext", "--proxy-base", receiver.base], { cwd: dir });
  assert.match(text.stdout, /^Remit: ok \(Remit POST 200: acknowledged with a body that is not JSON: <html>.*\) -> \/api\/runs/m);
});

test("the body the receiver stores carries the outcome of the send, not the pending sentinel", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const receiver = await startReceiver();
  t.after(() => receiver.close());
  const runId = "run_1789300000007_body";
  await runCli(["run-record", "--packet", packetPath, "--run-id", runId, "--proxy-base", receiver.base, "--json"], { cwd: dir });
  const sent = receiver.posts[0].payload;
  assert.equal(sent.run_id, runId);
  assert.deepEqual(remitFields(sent), { state: "ok", attempted: true, ok: true, error: null, endpoint: "/api/runs" });
  assert.deepEqual(remitFields(readRecord(dir, runId)), remitFields(sent), "disk and the stored copy agree");
});

test("telemetry list exits non-zero on a 200 whose body is not a runs[] listing", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const receiver = await startReceiver();
  t.after(() => receiver.close());
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  writeFileSync(packetPath, JSON.stringify({ ...packet, campaign: { ...packet.campaign, campaigns_api_key: "pk_tenant" } }));
  for (const extra of [[], ["--json"]]) {
    const listed = await runCli(["telemetry", "list", "--packet", packetPath, "--proxy-base", receiver.base, ...extra], { cwd: dir, telemetry: "off" });
    assert.notEqual(listed.status, 0, `a body without runs[] is not a listing (${extra.join(" ") || "text"})`);
    assert.match(listed.stderr, /telemetry list: 200 OK from http:\/\/127\.0\.0\.1:\d+\/api\/runs is not a Run Record listing \(no runs\[\] in the body\): \{"raw":"<html>/);
    assert.doesNotMatch(listed.stdout, /showing 0 of 0|"count": 0/);
  }
});
