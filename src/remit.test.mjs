import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { assertSecureProxyBase, remit, remitRunRecord } from "./remit.mjs";

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

test("remit times out instead of hanging forever", async () => {
  const fetchImpl = async () => new Promise(() => {});
  await assert.rejects(
    () => remit("/api/runs", {}, "https://proxy.test", { fetchImpl, timeoutMs: 5 }),
    /Remit POST timed out after 5ms/,
  );
});

test("remit bounds non-2xx response bodies included in errors", async () => {
  const { fetchImpl } = recordingFetch(fakeResponse({ ok: false, status: 500, statusText: "Server Error", body: "x".repeat(100) }));
  await assert.rejects(
    () => remit("/api/runs", {}, "https://proxy.test", { fetchImpl, maxBodyBytes: 10 }),
    /xxxxxxxxxx\.\.\.\[truncated to 10 bytes\]/,
  );
});

test("remit bounds streamed non-2xx response bodies and ignores releaseLock cleanup errors", async () => {
  let reads = 0;
  const response = {
    ok: false,
    status: 500,
    statusText: "Server Error",
    body: {
      getReader() {
        return {
          async read() {
            reads += 1;
            if (reads === 1) return { done: false, value: Buffer.from("abcdefgh") };
            if (reads === 2) return { done: false, value: Buffer.from("ijklmnop") };
            return { done: true };
          },
          async cancel() {},
          releaseLock() {
            throw new Error("releaseLock boom");
          },
        };
      },
    },
    text: async () => assert.fail("streaming response should not use text()"),
  };
  const { fetchImpl } = recordingFetch(response);
  await assert.rejects(
    () => remit("/api/runs", {}, "https://proxy.test", { fetchImpl, maxBodyBytes: 10 }),
    /Remit POST failed: 500 Server Error abcdefghij\.\.\.\[truncated to 10 bytes\]/,
  );
});

test("remitRunRecord: consent OFF makes NO network call", async () => {
  const { fetchImpl, calls } = recordingFetch();
  const status = await remitRunRecord({ run_id: "run_1" }, { proxyBase: "https://proxy.test", consent: { state: "off" }, fetchImpl });
  assert.equal(calls.length, 0);
  assert.deepEqual(status, { attempted: false, ok: null, error: null, endpoint: null, result: null, http_status: null });
});

test("remitRunRecord: missing/unresolved consent also makes no call", async () => {
  const { fetchImpl, calls } = recordingFetch();
  const status = await remitRunRecord({ run_id: "run_1" }, { proxyBase: "https://proxy.test", consent: undefined, fetchImpl });
  assert.equal(calls.length, 0);
  assert.deepEqual(status, { attempted: false, ok: null, error: null, endpoint: null, result: null, http_status: null }, "the same shape as an attempted send");
});

test("remitRunRecord: consent ON success records ok + endpoint and sends run_id (idempotency key)", async () => {
  const { fetchImpl, calls } = recordingFetch(fakeResponse({ body: JSON.stringify({ ok: true }) }));
  const status = await remitRunRecord({ run_id: "run_idem_1", schema_version: "campaigns-os-run-record/v0" }, { proxyBase: "https://proxy.test", consent: { state: "on" }, fetchImpl });
  assert.deepEqual(status, { attempted: true, ok: true, error: null, endpoint: "/api/runs", result: "stored", http_status: 200 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://proxy.test/api/runs");
  assert.equal(JSON.parse(calls[0].init.body).run_id, "run_idem_1"); // upsert key travels with the payload
});

// The receiver keeps one record per run_id and answers a repeat POST with 409.
// That is the stored outcome the send was after, reached earlier — a retry
// after a lost answer, or a re-run — and must read as ok, never as a failure
// that a recovery would re-send forever.
test("remitRunRecord: a 409 from the receiver is already_stored — ok, no error", async () => {
  const { fetchImpl } = recordingFetch(fakeResponse({ ok: false, status: 409, statusText: "Conflict", body: JSON.stringify({ error: "run_record_conflict", run_id: "run_1" }) }));
  const status = await remitRunRecord({ run_id: "run_1" }, { proxyBase: "https://proxy.test", consent: { state: "on" }, fetchImpl });
  assert.deepEqual(status, { attempted: true, ok: true, error: null, endpoint: "/api/runs", result: "already_stored", http_status: 409 });
});

test("remitRunRecord: a 2xx whose body is not JSON is ok_unparsed_ack, with the status and an excerpt on the error", async () => {
  const { fetchImpl } = recordingFetch(fakeResponse({ status: 200, body: "<html><body>maintenance</body></html>" }));
  const status = await remitRunRecord({ run_id: "run_1" }, { proxyBase: "https://proxy.test", consent: { state: "on" }, fetchImpl });
  assert.equal(status.ok, true);
  assert.equal(status.result, "ok_unparsed_ack");
  assert.equal(status.http_status, 200);
  assert.match(status.error, /^Remit POST 200: acknowledged with a body that is not JSON: <html><body>maintenance/);
});

test("remitRunRecord: a non-2xx other than 409 is refused, with the status prefixed on the error", async () => {
  const { fetchImpl } = recordingFetch(fakeResponse({ ok: false, status: 401, statusText: "Unauthorized", body: JSON.stringify({ error: "listing_auth_required" }) }));
  const status = await remitRunRecord({ run_id: "run_1" }, { proxyBase: "https://proxy.test", consent: { state: "on" }, fetchImpl });
  assert.equal(status.ok, false);
  assert.equal(status.result, "refused");
  assert.equal(status.http_status, 401);
  assert.match(status.error, /^Remit POST 401: Unauthorized \{"error":"listing_auth_required"\}$/);
});

test("remitRunRecord: a transport failure is transport_error with no status", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  const status = await remitRunRecord({ run_id: "run_1" }, { proxyBase: "https://proxy.test", consent: { state: "on" }, fetchImpl });
  assert.equal(status.result, "transport_error");
  assert.equal(status.http_status, null);
});

// The receiver only ever holds a record whose send landed, so the copy it
// receives says so. The local file carries the pending sentinel until the
// answer arrives; that sentinel must not be what the receiver stores.
test("remitRunRecord: the body sent carries the stored outcome, not the local pending sentinel", async () => {
  const { fetchImpl, calls } = recordingFetch(fakeResponse({ body: JSON.stringify({ ok: true }) }));
  const local = { run_id: "run_1", remit_state: "pending", remit_attempted: false, remit_ok: null, remit_error: null, remit_endpoint: null };
  await remitRunRecord(local, { proxyBase: "https://proxy.test", consent: { state: "on" }, fetchImpl });
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(
    { state: sent.remit_state, attempted: sent.remit_attempted, ok: sent.remit_ok, error: sent.remit_error, endpoint: sent.remit_endpoint },
    { state: "ok", attempted: true, ok: true, error: null, endpoint: "/api/runs" },
  );
  assert.equal(local.remit_state, "pending", "the local record is stamped by the caller from the outcome, not mutated pre-flight");
});

test("remit: a 2xx with a non-JSON body throws a status-bearing error rather than a bare parse error", async () => {
  const { fetchImpl } = recordingFetch(fakeResponse({ status: 200, body: "<html>" }));
  await assert.rejects(() => remit("/api/runs", {}, "https://proxy.test", { fetchImpl }), (error) => {
    assert.equal(error.name, "RemitResponseError");
    assert.equal(error.status, 200);
    assert.equal(error.reason, "unparsed_body");
    assert.match(error.message, /^Remit POST 200 OK: response body is not JSON: <html>/);
    return true;
  });
});

test("remitRunRecord: sends X-Campaign-Key when a campaign key is supplied, never in the body", async () => {
  const { fetchImpl, calls } = recordingFetch(fakeResponse({ body: JSON.stringify({ ok: true }) }));
  await remitRunRecord({ run_id: "run_key_1", schema_version: "campaigns-os-run-record/v0" }, { proxyBase: "https://proxy.test", consent: { state: "on" }, campaignKey: " pk_public_123 ", fetchImpl });
  assert.equal(calls[0].init.headers["X-Campaign-Key"], "pk_public_123");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal("campaign_key" in JSON.parse(calls[0].init.body), false);
});

test("remitRunRecord: no campaign key means no X-Campaign-Key header at all", async () => {
  const { fetchImpl, calls } = recordingFetch(fakeResponse({ body: JSON.stringify({ ok: true }) }));
  await remitRunRecord({ run_id: "run_key_2", schema_version: "campaigns-os-run-record/v0" }, { proxyBase: "https://proxy.test", consent: { state: "on" }, fetchImpl });
  assert.equal("X-Campaign-Key" in calls[0].init.headers, false);
  await remitRunRecord({ run_id: "run_key_3", schema_version: "campaigns-os-run-record/v0" }, { proxyBase: "https://proxy.test", consent: { state: "on" }, campaignKey: "   ", fetchImpl });
  assert.equal("X-Campaign-Key" in calls[1].init.headers, false);
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

test("CLI: run-record with consent explicitly OFF skips remit and still writes the record", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    // Consent now defaults ON for the canonical endpoint, so the skip-remit
    // path needs an explicit operator OFF.
    const env = { ...process.env, XDG_CONFIG_HOME: dir, CAMPAIGNS_OS_TELEMETRY: "off" };

    const out = JSON.parse(execFileSync("node", [
      CLI, "run-record", "--packet", packetPath, "--journal", join(dir, "wf.jsonl"), "--run-id", "run_off", "--json",
    ], { encoding: "utf8", env }));

    assert.equal(out.written, true);
    assert.equal(out.record.consent_state, "off");
    assert.equal(out.record.remit_attempted, false);
    assert.equal(out.record.remit_ok, null);
  });
});

test("CLI: default-on consent never applies to a non-canonical proxy base", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
    const env = { ...process.env, XDG_CONFIG_HOME: dir };
    delete env.CAMPAIGNS_OS_TELEMETRY;

    // Unconsented non-canonical endpoint: remit must NOT be attempted even
    // though the default is now ON (scope safety). 127.0.0.1:1 would refuse
    // instantly if it were attempted — the assertion is on attempted=false.
    const out = JSON.parse(execFileSync("node", [
      CLI, "run-record", "--packet", packetPath, "--journal", join(dir, "wf.jsonl"),
      "--run-id", "run_scope", "--proxy-base", "http://127.0.0.1:1", "--json",
    ], { encoding: "utf8", env }));

    assert.equal(out.written, true);
    assert.equal(out.record.consent_state, "off");
    assert.equal(out.record.remit_attempted, false);
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

// --- transport gate -------------------------------------------------------
// Every credential-bearing request goes through assertSecureProxyBase before a
// socket is opened: X-Campaign-Key on this rail and the ops admin key on the
// `telemetry list` rail are request credentials, and a plain-http hop to a
// real host hands them to whatever sits on the path. https passes silently,
// loopback http passes with a warning, everything else never reaches fetch.

test("assertSecureProxyBase: https passes with no warning", () => {
  const warnings = [];
  const gate = assertSecureProxyBase("https://proxy.test/", { warn: (line) => warnings.push(line) });
  assert.equal(gate.base, "https://proxy.test");
  assert.equal(gate.loopback, false);
  assert.deepEqual(warnings, []);
});

test("assertSecureProxyBase: loopback http passes with exactly one warning naming the credential kind, not a value", () => {
  for (const base of ["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787"]) {
    const warnings = [];
    const gate = assertSecureProxyBase(base, { label: "Remit", credential: "the campaign key", warn: (line) => warnings.push(line) });
    assert.equal(gate.loopback, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /plain http/);
    assert.match(warnings[0], /the campaign key travels in clear/);
  }
});

test("assertSecureProxyBase: a credential-free request is not described as leaking one", () => {
  const warnings = [];
  assertSecureProxyBase("http://127.0.0.1:8787", { label: "QA verdict publish", credential: null, warn: (line) => warnings.push(line) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /this request and its payload travel in clear/);
  assert.match(warnings[0], /no credential is attached/);
  assert.doesNotMatch(warnings[0], /credential travels in clear/);
  assert.throws(
    () => assertSecureProxyBase("http://proxy.example.invalid", { label: "QA verdict publish", credential: null, warn: () => {} }),
    /declining to send this request and its payload/,
  );
});

test("remit: the loopback warning describes what the request actually carries", async () => {
  const stderr = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    // no headers → no credential claimed
    const bare = recordingFetch(fakeResponse({ body: "" }));
    await remit("/api/qa/verdicts", { run_id: "r" }, "http://127.0.0.1:8787", { fetchImpl: bare.fetchImpl });
    // a non-credential header alone claims nothing either
    const accepting = recordingFetch(fakeResponse({ body: "" }));
    await remit("/api/qa/verdicts", { run_id: "r" }, "http://127.0.0.1:8787", { fetchImpl: accepting.fetchImpl, headers: { Accept: "application/json" } });
    // a credential header → the request carries a credential, and the warning says so
    const keyed = recordingFetch(fakeResponse({ body: "" }));
    await remit("/api/runs", { run_id: "r" }, "http://127.0.0.1:8787", { fetchImpl: keyed.fetchImpl, headers: { "X-Campaign-Key": "pk_live_abcdefgh" } });
    assert.equal(bare.calls.length, 1);
    assert.equal(accepting.calls.length, 1);
    assert.equal(keyed.calls.length, 1);
  } finally {
    process.stderr.write = original;
  }
  const text = stderr.join("");
  assert.equal((text.match(/this request and its payload travel in clear/g) || []).length, 2);
  assert.equal((text.match(/the request credential travels in clear/g) || []).length, 1);
  assert.doesNotMatch(text, /pk_live_abcdefgh/);
});

test("assertSecureProxyBase: plain http to a real host, and a non-URL base, both throw", () => {
  const warnings = [];
  const warn = (line) => warnings.push(line);
  assert.throws(() => assertSecureProxyBase("http://proxy.example.invalid", { warn }), /must be https/);
  assert.throws(() => assertSecureProxyBase("http://proxy.example.invalid", { warn }), /http:\/\/proxy\.example\.invalid/);
  assert.throws(() => assertSecureProxyBase("not a url", { warn }), /is not a URL/);
  assert.throws(() => assertSecureProxyBase("", { warn }), /is not a URL: \(empty\)/);
  assert.deepEqual(warnings, []); // a refusal is not a warning
});

test("remit: a plain-http non-loopback proxy base is refused before any request", async () => {
  const { fetchImpl, calls } = recordingFetch();
  await assert.rejects(() => remit("/api/runs", { run_id: "r" }, "http://proxy.example.invalid", { fetchImpl }), /must be https/);
  assert.equal(calls.length, 0); // nothing was sent
});

test("remitRunRecord: a plain-http non-loopback proxy base fails non-fatally and sends nothing", async () => {
  const { fetchImpl, calls } = recordingFetch();
  const status = await remitRunRecord({ run_id: "run_http" }, {
    proxyBase: "http://proxy.example.invalid",
    consent: { state: "on" },
    campaignKey: "pk_live_abcdefgh",
    fetchImpl,
  });
  assert.equal(calls.length, 0);
  assert.equal(status.attempted, true);
  assert.equal(status.ok, false);
  assert.match(status.error, /must be https/);
  assert.doesNotMatch(status.error, /pk_live_abcdefgh/); // never the credential value
});

test("remit: an https proxy base still reaches fetch", async () => {
  const { fetchImpl, calls } = recordingFetch(fakeResponse({ body: JSON.stringify({ ok: true }) }));
  await remit("/api/runs", { run_id: "r" }, "https://proxy.test", { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://proxy.test/api/runs");
});
