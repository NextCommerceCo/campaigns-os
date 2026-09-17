// `qa publish` end to end through the real CLI: the verdict publish outcome a
// run session collected reaches the Run Record at `run end`, `qa publish`
// reads it back as "already published" and refuses, `--republish` posts the
// stored verdict to a real loopback receiver, and a later `run-record`
// re-emit never downgrades the stored ok.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

import { buildRunSession, writeRunSession } from "./run-session.mjs";
import { createVerdict, SEVERITY, STATUS } from "./qa-verdict.mjs";
import { specMaterialHash } from "./spec-identity.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const VERDICT_RUN_ID = "MTXEUVC6732A9UV8365MBTDN9V";

async function startReceiver() {
  const posts = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      posts.push({ method: request.method, url: request.url, payload: JSON.parse(body || "null") });
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { posts, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
}

async function runCli(argv, { cwd }) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...argv], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off", CAMPAIGNS_OS_LIFECYCLE_LOG: "" },
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

function readRecords(dir) {
  const recordDir = join(dir, ".campaign-runtime", "run-records");
  return readdirSync(recordDir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(recordDir, name), "utf8")));
}

test("qa publish: session-recorded publish refuses a repeat, --republish posts, run-record re-emit keeps the ok", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-qa-publish-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const receiver = await startReceiver();
  t.after(() => receiver.close());

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "qa-publish-target", private: true }));
  const packetPath = join(dir, "campaign-runtime.build.json");
  const packet = JSON.parse(readFileSync(join(ROOT, "examples/build-packet.basic.json"), "utf8"));
  packet.assembly.target_repo = ".";
  writeFileSync(packetPath, JSON.stringify(packet));
  cpSync(join(ROOT, "examples", packet.spec.local_path), join(dir, packet.spec.local_path));
  const rawSpec = JSON.parse(readFileSync(join(dir, packet.spec.local_path), "utf8"));

  const verdict = createVerdict({
    runId: VERDICT_RUN_ID,
    mapId: packet.spec.map_id,
    publicRouteSlug: packet.campaign.public_route_slug,
    specVersion: "4.2",
    specHash: specMaterialHash(rawSpec),
    startedAt: "2026-09-15T10:00:00.000Z",
    completedAt: "2026-09-15T10:05:00.000Z",
    runtime: "campaigns-os-node-qa@test",
    baseUrl: "https://preview.example/runtime-packet-demo/",
    assertions: [{ id: "route:entry", family: "funnel-flow", page: "entry", status: STATUS.pass, severity: SEVERITY.blocker, expected: "200", actual: "200", evidence: [] }],
  });
  mkdirSync(join(dir, "qa-output", packet.spec.map_id), { recursive: true });
  const verdictPath = join(dir, "qa-output", packet.spec.map_id, `${VERDICT_RUN_ID}.json`);
  writeFileSync(verdictPath, JSON.stringify(verdict));
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  writeFileSync(join(dir, ".campaign-runtime", "qa-verdict.json"), JSON.stringify({ ...verdict, entry_urls: [], page_urls: [], tested_urls: [], test_orders: [], generated_at: "2026-09-15T10:06:00.000Z" }));

  // The session shape the QA auto-end writes when the run's own publish landed.
  const sessionRunId = "run_1789300000000_publishflow";
  const session = buildRunSession({ runId: sessionRunId, lifecycleJournal: join(dir, ".campaign-runtime/command-lifecycle.jsonl"), packet: packetPath });
  writeRunSession(dir, {
    ...session,
    qa_attempts: [{
      path: verdictPath,
      disposition: "ready",
      run_id: VERDICT_RUN_ID,
      completed_at: verdict.completed_at,
      publish: {
        verdict_run_id: VERDICT_RUN_ID,
        publisher: "qa run",
        attempted: true,
        ok: true,
        error: null,
        endpoint: "/api/qa/verdicts",
        state: "ok",
        result: "stored",
        base_kind: "canonical",
        published_at: "2026-09-15T10:05:30.000Z",
      },
    }],
  });

  const ended = await runCli(["run", "end", "--packet", packetPath, "--no-remit", "--json"], { cwd: dir });
  assert.equal(ended.code, 0, ended.stderr);
  const closed = readRecords(dir).find((record) => record.run_id === sessionRunId);
  assert.equal(closed.qa_verdict_publish.state, "ok", "the session's publish outcome is on the closed record");
  assert.equal(closed.qa_verdict_publish.publisher, "qa run");
  assert.equal(closed.qa_verdict_publish.verdict_run_id, VERDICT_RUN_ID);

  const refused = await runCli(["qa", "publish", "--packet", packetPath, "--proxy-base", receiver.base, "--json"], { cwd: dir });
  assert.equal(refused.code, 2, "an already-published verdict is a refusal");
  const refusal = JSON.parse(refused.stdout);
  assert.equal(refusal.status, "refused");
  assert.equal(refusal.refusal.code, "already_published");
  assert.equal(receiver.posts.length, 0, "the refusal sent nothing");

  const republished = await runCli(["qa", "publish", "--packet", packetPath, "--proxy-base", receiver.base, "--republish", "--json"], { cwd: dir });
  assert.equal(republished.code, 0, republished.stderr);
  const result = JSON.parse(republished.stdout);
  assert.equal(result.status, "published");
  assert.equal(result.republished, true);
  assert.equal(result.orders_placed, 0);
  assert.equal(result.publish.result, "stored");
  assert.equal(result.publish.http_status, 201);
  assert.equal(result.publish.base_kind, "loopback");
  assert.equal(receiver.posts.length, 1);
  assert.equal(receiver.posts[0].url, "/api/qa/verdicts");
  assert.equal(receiver.posts[0].payload.run_id, VERDICT_RUN_ID);
  assert.equal(receiver.posts[0].payload.spec_hash, verdict.spec_hash, "the stored verdict went out unchanged");
  const stamped = readRecords(dir).find((record) => record.run_id === sessionRunId);
  assert.equal(stamped.qa_verdict_publish.publisher, "qa publish");
  assert.equal(stamped.qa_verdict_publish.base_kind, "loopback");

  // A sessionless re-emit of the record reassembles it; the stored publish
  // outcome rides along rather than being dropped.
  const reemitted = await runCli(["run-record", "--packet", packetPath, "--run-id", sessionRunId, "--no-remit", "--json"], { cwd: dir });
  assert.equal(reemitted.code, 0, reemitted.stderr);
  const after = readRecords(dir).find((record) => record.run_id === sessionRunId);
  assert.deepEqual(after.qa_verdict_publish, stamped.qa_verdict_publish, "re-emit carries the publish block forward");

  // A spec edit after the run: the stored verdict is no longer evidence.
  writeFileSync(join(dir, packet.spec.local_path), JSON.stringify({ ...rawSpec, campaign: { ...rawSpec.campaign, name: "renamed" } }));
  const stale = await runCli(["qa", "publish", "--packet", packetPath, "--proxy-base", receiver.base, "--republish"], { cwd: dir });
  assert.equal(stale.code, 2);
  assert.match(stale.stdout, /^QA publish refused \(spec_hash_mismatch\)\./m);
  assert.match(stale.stdout, /No order was placed and nothing was sent\./);
  assert.equal(receiver.posts.length, 1, "the stale verdict was not posted");
});
