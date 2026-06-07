import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { remit, remitRunRecord } from "./remit.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

function fakeResponse({ ok = true, status = 200, statusText = "OK", body = "" } = {}) {
  return { ok, status, statusText, text: async () => body };
}

function recordingFetch(response = fakeResponse()) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (typeof response === "function") return response(url, init);
    return response;
  };
  return { fetchImpl, calls };
}

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-remit-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("remit POSTs JSON to proxyBase + path and parses the response body", async () => {
  const { fetchImpl, calls } = recordingFetch(fakeResponse({ body: JSON.stringify({ ok: true, id: "run_1" }) }));
  const result = await remit("/api/runs", { run_id: "run_1" }, "https://proxy.test", { fetchImpl });
  assert.deepEqual(result, { ok: true, id: "run_1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://proxy.test/api/runs");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), { run_id: "run_1" });
});

test("remit normalizes trailing slashes and a missing leading slash", async () => {
  const { fetchImpl, calls } = recordingFetch();
  await remit("api/runs", {}, "https://proxy.test/", { fetchImpl });
  assert.equal(calls[0].url, "https://proxy.test/api/runs");
});

test("remit returns {ok:true} for an empty 2xx body", async () => {
  const { fetchImpl } = recordingFetch(fakeResponse({ body: "" }));
  assert.deepEqual(await remit("/api/runs", {}, "https://proxy.test", { fetchImpl }), { ok: true });
});

test("remit throws on a non-2xx response", async () => {
  const { fetchImpl } = recordingFetch(fakeResponse({ ok: false, status: 500, statusText: "Server Error", body: "boom" }));
  await assert.rejects(() => remit("/api/runs", {}, "https://proxy.test", { fetchImpl }), /Remit POST failed: 500/);
});

test("remitRunRecord: consent OFF makes NO network call", async () => {
  const { fetchImpl, calls } = recordingFetch();
  const status = await remitRunRecord({ run_id: "run_1" }, { proxyBase: "https://proxy.test", consent: { state: "off" }, fetchImpl });
  assert.equal(calls.length, 0);
  assert.deepEqual(status, { attempted: false, ok: null, error: null, endpoint: null });
});

test("remitRunRecord: missing/unresolved consent also makes no call", async () => {
  const { fetchImpl, calls } = recordingFetch();
  await remitRunRecord({ run_id: "run_1" }, { proxyBase: "https://proxy.test", consent: undefined, fetchImpl });
  assert.equal(calls.length, 0);
});

test("remitRunRecord: consent ON success records ok + endpoint and sends run_id (idempotency key)", async () => {
  const { fetchImpl, calls } = recordingFetch(fakeResponse({ body: JSON.stringify({ ok: true }) }));
  const status = await remitRunRecord({ run_id: "run_idem_1", schema_version: "campaigns-os-run-record/v0" }, { proxyBase: "https://proxy.test", consent: { state: "on" }, fetchImpl });
  assert.deepEqual(status, { attempted: true, ok: true, error: null, endpoint: "/api/runs" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://proxy.test/api/runs");
  assert.equal(JSON.parse(calls[0].init.body).run_id, "run_idem_1"); // upsert key travels with the payload
});

test("remitRunRecord: a network throw is SWALLOWED — status records the failure, never rethrows", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  const status = await remitRunRecord({ run_id: "run_1" }, { proxyBase: "https://proxy.test", consent: { state: "on" }, fetchImpl });
  assert.equal(status.attempted, true);
  assert.equal(status.ok, false);
  assert.match(status.error, /ECONNREFUSED/);
  assert.equal(status.endpoint, "/api/runs");
});

test("remitRunRecord: a non-2xx response is also swallowed into ok:false", async () => {
  const { fetchImpl } = recordingFetch(fakeResponse({ ok: false, status: 503, statusText: "Unavailable", body: "" }));
  const status = await remitRunRecord({ run_id: "run_1" }, { proxyBase: "https://proxy.test", consent: { state: "on" }, fetchImpl });
  assert.equal(status.ok, false);
  assert.match(status.error, /503/);
});

test("CLI: run-record with consent OFF (default) skips remit and still writes the record", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    const env = { ...process.env, XDG_CONFIG_HOME: dir };
    delete env.CAMPAIGNS_OS_TELEMETRY;

    const out = JSON.parse(execFileSync("node", [
      CLI, "run-record", "--packet", packetPath, "--journal", join(dir, "wf.jsonl"), "--run-id", "run_off", "--json",
    ], { encoding: "utf8", env }));

    assert.equal(out.written, true);
    assert.equal(out.record.consent_state, "off");
    assert.equal(out.record.remit_attempted, false);
    assert.equal(out.record.remit_ok, null);
  });
});

test("CLI: run-record consent ON but unreachable proxy stays non-fatal (exit 0) and records the failure", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    const env = { ...process.env, XDG_CONFIG_HOME: dir, CAMPAIGNS_OS_TELEMETRY: "on" };

    // 127.0.0.1:1 refuses immediately — proves the failure path without real DNS/network latency.
    const out = JSON.parse(execFileSync("node", [
      CLI, "run-record", "--packet", packetPath, "--journal", join(dir, "wf.jsonl"),
      "--run-id", "run_fail", "--proxy-base", "http://127.0.0.1:1", "--json",
    ], { encoding: "utf8", env })); // execFileSync throws if exit code != 0 — so reaching here proves non-fatal

    assert.equal(out.record.consent_state, "on");
    assert.equal(out.record.remit_attempted, true);
    assert.equal(out.record.remit_ok, false);
    assert.ok(out.record.remit_error);
    assert.equal(out.record.remit_endpoint, "/api/runs");
    // and the local record was still written despite the failed send
    assert.equal(out.written, true);
    const onDisk = JSON.parse(readFileSync(out.record_path, "utf8"));
    assert.equal(onDisk.remit_ok, false);
  });
});

test("CLI: --no-remit skips the send even with consent ON", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    const env = { ...process.env, XDG_CONFIG_HOME: dir, CAMPAIGNS_OS_TELEMETRY: "on" };

    const out = JSON.parse(execFileSync("node", [
      CLI, "run-record", "--packet", packetPath, "--journal", join(dir, "wf.jsonl"),
      "--run-id", "run_norem", "--no-remit", "--json",
    ], { encoding: "utf8", env }));

    assert.equal(out.record.consent_state, "on"); // consent is still reported truthfully
    assert.equal(out.record.remit_attempted, false); // but no send happened
  });
});
