import assert from "node:assert/strict";
import { test } from "node:test";

import { applyMapPin, mapPinWritebackDecision, writeMapSdkPin } from "./map-pin-writeback.mjs";

const jsonResponse = (body, status = 200, statusText = "OK") => ({
  ok: status >= 200 && status < 300,
  status,
  statusText,
  json: async () => body,
});

// A Map as the proxy hands it back: the spec plus the store's envelope.
function mapRecord(patch = null) {
  const record = {
    version: "42",
    campaign: { name: "Demo", slug: "demo", campaigns_api_key: "fixture-campaigns-key" },
    global_config: { sdk_version: "0.4.37", currency: "USD" },
    funnels: [{ id: "f1", pages: [{ id: "landing", page_url: "landing/" }] }],
    slug: "demo-k9x2",
    map_id: "demo-k9x2",
    saved_at: "2026-09-10T10:00:00.000Z",
    spec_identity: { map_id: "demo-k9x2", spec_hash: "hash-before", saved_at: "2026-09-10T10:00:00.000Z" },
  };
  if (patch) patch(record);
  return record;
}

// A mock proxy: GET answers with the record, PUT records the request and
// answers as the Worker does (ok, spec_identity with the new hash).
function mockProxy({ record = mapRecord(), putStatus = 200, putBody = null, getStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if ((init.method || "GET") === "GET") {
      if (getStatus !== 200) return jsonResponse({ ok: false, error: "Campaign map not found." }, getStatus, "Not Found");
      return jsonResponse({ ok: true, data: record, expires_at: null });
    }
    if (putStatus !== 200) return jsonResponse(putBody || { ok: false, error: `refused ${putStatus}` }, putStatus, "Refused");
    return jsonResponse(putBody || {
      ok: true, map_id: record.map_id, updated: true,
      spec_identity: { map_id: record.map_id, spec_hash: "hash-after", saved_at: "2026-09-17T09:00:00.000Z" },
      warnings: [],
    });
  };
  return { calls, fetchImpl };
}

test("mapPinWritebackDecision: a newer repo pin writes, an equal pin is a no-op, a newer Map pin refuses, and an unorderable Map pin refuses", () => {
  assert.equal(mapPinWritebackDecision({ repoPin: "0.4.38", mapSpec: { global_config: { sdk_version: "0.4.37" } } }).decision, "write");
  assert.equal(mapPinWritebackDecision({ repoPin: "0.4.38", mapSpec: { global_config: {} } }).decision, "write", "an absent Map pin is recorded");
  assert.equal(mapPinWritebackDecision({ repoPin: "0.4.38", mapSpec: {} }).decision, "write");
  assert.equal(mapPinWritebackDecision({ repoPin: "0.4.38", mapSpec: { global_config: { sdk_version: "0.4.38" } } }).decision, "unchanged");
  const ahead = mapPinWritebackDecision({ repoPin: "0.4.38", mapSpec: { global_config: { sdk_version: "0.4.40" } } });
  assert.equal(ahead.decision, "map_ahead");
  assert.equal(ahead.map_pin, "0.4.40");
  assert.match(ahead.detail, /ahead of the repo pin 0\.4\.38/);
  // Major/minor order, not string order.
  assert.equal(mapPinWritebackDecision({ repoPin: "0.10.0", mapSpec: { global_config: { sdk_version: "0.9.9" } } }).decision, "write");
  assert.equal(mapPinWritebackDecision({ repoPin: "0.9.9", mapSpec: { global_config: { sdk_version: "0.10.0" } } }).decision, "map_ahead");
  // A pin the rule cannot order is never overwritten silently.
  const unreleased = mapPinWritebackDecision({ repoPin: "0.4.38", mapSpec: { global_config: { sdk_version: "latest" } } });
  assert.equal(unreleased.decision, "map_pin_unreadable");
  assert.match(unreleased.detail, /"latest" is not a released/);
  const conflict = mapPinWritebackDecision({ repoPin: "0.4.38", mapSpec: { global_config: { sdk_version: "0.4.30" }, runtime: { sdk_version: "0.4.31" } } });
  assert.equal(conflict.decision, "map_pin_unreadable");
  assert.match(conflict.detail, /disagree/);
  // The alias alone is a readable pin.
  assert.equal(mapPinWritebackDecision({ repoPin: "0.4.38", mapSpec: { runtime: { sdk_version: "0.4.30" } } }).decision, "write");
  // An unreleased repo pin never reaches the Map, whatever the Map says.
  assert.equal(mapPinWritebackDecision({ repoPin: "0.4.38-beta.1", mapSpec: { global_config: { sdk_version: "0.4.30" } } }).decision, "repo_pin_invalid");
  assert.equal(mapPinWritebackDecision({ repoPin: undefined, mapSpec: {} }).decision, "repo_pin_invalid");
});

test("applyMapPin moves the canonical pin, the alias only when declared, and nothing else", () => {
  const record = mapRecord();
  const next = applyMapPin(record, "0.4.38");
  assert.equal(next.global_config.sdk_version, "0.4.38");
  assert.equal(next.global_config.currency, "USD");
  assert.equal("runtime" in next, false, "the alias is never created");
  assert.equal(record.global_config.sdk_version, "0.4.37", "the input is not mutated");
  const { global_config: _a, ...restNext } = next;
  const { global_config: _b, ...restRecord } = record;
  assert.deepEqual(restNext, restRecord);
  const aliased = applyMapPin(mapRecord((draft) => { draft.runtime = { sdk_version: "0.4.37", other: true }; }), "0.4.38");
  assert.deepEqual(aliased.runtime, { sdk_version: "0.4.38", other: true });
  assert.deepEqual(applyMapPin({}, "0.4.38"), { global_config: { sdk_version: "0.4.38" } });
});

test("writeMapSdkPin reads the Map, re-states it with only the pin moved, and PUTs under the campaign key and the Map's spec_hash", async () => {
  const { calls, fetchImpl } = mockProxy();
  const result = await writeMapSdkPin({ mapId: " demo-k9x2 ", repoPin: "0.4.38", campaignKey: "fixture-campaigns-key", proxyBase: "https://proxy.example/", fetchImpl });
  assert.equal(result.status, "written");
  assert.equal(result.reason, "written");
  assert.equal(result.map_id, "demo-k9x2");
  assert.equal(result.proxy_base, "https://proxy.example");
  assert.equal(result.before, "0.4.37");
  assert.equal(result.after, "0.4.38");
  assert.deepEqual(result.spec_identity, {
    before: { spec_hash: "hash-before", saved_at: "2026-09-10T10:00:00.000Z" },
    after: { spec_hash: "hash-after", saved_at: "2026-09-17T09:00:00.000Z" },
  });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ["GET", "https://proxy.example/api/spec/demo-k9x2"],
    ["PUT", "https://proxy.example/api/maps/demo-k9x2"],
  ]);
  const put = calls[1];
  assert.equal(put.headers["X-Campaign-Key"], "fixture-campaigns-key");
  assert.equal(put.headers["X-Spec-Hash"], "hash-before");
  assert.equal(put.headers["Content-Type"], "application/json");
  assert.deepEqual(put.body, applyMapPin(mapRecord(), "0.4.38"), "the body is the read-back with exactly the pin moved");
  assert.equal(put.body.funnels[0].pages[0].page_url, "landing/");
});

test("writeMapSdkPin --dry-run reads the Map and reports would_write without a PUT; an equal pin is unchanged and a newer Map pin is refused, neither PUTs", async () => {
  const dry = mockProxy();
  const preview = await writeMapSdkPin({ mapId: "demo-k9x2", repoPin: "0.4.38", campaignKey: "fixture-campaigns-key", proxyBase: "https://proxy.example", dryRun: true, fetchImpl: dry.fetchImpl });
  assert.equal(preview.status, "would_write");
  assert.equal(preview.reason, "dry_run");
  assert.equal(preview.before, "0.4.37");
  assert.deepEqual(dry.calls.map((call) => call.method), ["GET"]);

  const equal = mockProxy({ record: mapRecord((draft) => { draft.global_config.sdk_version = "0.4.38"; }) });
  const same = await writeMapSdkPin({ mapId: "demo-k9x2", repoPin: "0.4.38", campaignKey: "fixture-campaigns-key", proxyBase: "https://proxy.example", fetchImpl: equal.fetchImpl });
  assert.equal(same.status, "unchanged");
  assert.deepEqual(equal.calls.map((call) => call.method), ["GET"]);

  const newer = mockProxy({ record: mapRecord((draft) => { draft.global_config.sdk_version = "0.4.40"; }) });
  const refused = await writeMapSdkPin({ mapId: "demo-k9x2", repoPin: "0.4.38", campaignKey: "fixture-campaigns-key", proxyBase: "https://proxy.example", fetchImpl: newer.fetchImpl });
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "map_ahead");
  assert.equal(refused.before, "0.4.40");
  assert.deepEqual(newer.calls.map((call) => call.method), ["GET"]);

  const unreadable = mockProxy({ record: mapRecord((draft) => { draft.global_config.sdk_version = "latest"; }) });
  const held = await writeMapSdkPin({ mapId: "demo-k9x2", repoPin: "0.4.38", campaignKey: "fixture-campaigns-key", proxyBase: "https://proxy.example", fetchImpl: unreadable.fetchImpl });
  assert.equal(held.status, "refused");
  assert.equal(held.reason, "map_pin_unreadable");
  assert.deepEqual(unreadable.calls.map((call) => call.method), ["GET"]);
});

test("writeMapSdkPin refuses before any request when the Map ID, the key or a secure proxy base is missing, and allows a loopback http proxy with a warning", async () => {
  let fetched = 0;
  const fetchImpl = async () => { fetched += 1; return jsonResponse({ ok: true, data: mapRecord() }); };
  const noId = await writeMapSdkPin({ mapId: "  ", repoPin: "0.4.38", campaignKey: "fixture-campaigns-key", fetchImpl });
  assert.deepEqual([noId.status, noId.reason], ["failed", "map_id_missing"]);
  const noKey = await writeMapSdkPin({ mapId: "demo-k9x2", repoPin: "0.4.38", campaignKey: null, fetchImpl });
  assert.deepEqual([noKey.status, noKey.reason], ["failed", "key_missing"]);
  const clear = await writeMapSdkPin({ mapId: "demo-k9x2", repoPin: "0.4.38", campaignKey: "fixture-campaigns-key", proxyBase: "http://proxy.example", fetchImpl });
  assert.deepEqual([clear.status, clear.reason], ["failed", "proxy_base_insecure"]);
  assert.match(clear.detail, /https/);
  const notUrl = await writeMapSdkPin({ mapId: "demo-k9x2", repoPin: "0.4.38", campaignKey: "fixture-campaigns-key", proxyBase: "proxy", fetchImpl });
  assert.equal(notUrl.reason, "proxy_base_insecure");
  assert.equal(fetched, 0, "nothing was requested");
  const noFetch = await writeMapSdkPin({ mapId: "demo-k9x2", repoPin: "0.4.38", campaignKey: "fixture-campaigns-key", proxyBase: "https://proxy.example", fetchImpl: null });
  assert.deepEqual([noFetch.status, noFetch.reason], ["failed", "network_error"]);

  const warnings = [];
  const local = mockProxy();
  const written = await writeMapSdkPin({ mapId: "demo-k9x2", repoPin: "0.4.38", campaignKey: "fixture-campaigns-key", proxyBase: "http://127.0.0.1:8787/", fetchImpl: local.fetchImpl, warn: (line) => warnings.push(line) });
  assert.equal(written.status, "written");
  assert.equal(written.proxy_base, "http://127.0.0.1:8787");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /spec derive --write-map: http:\/\/127\.0\.0\.1:8787 is plain http — the Campaigns API key travels in clear/);
});

test("writeMapSdkPin names every receiver refusal: 403 key mismatch, 404 gone, 409 saved in between, 422 rejected, a 5xx, an ok:false body, and a network error", async () => {
  const run = async (opts) => writeMapSdkPin({ mapId: "demo-k9x2", repoPin: "0.4.38", campaignKey: "other-campaign-key", proxyBase: "https://proxy.example", ...opts });
  const forbidden = await run({ fetchImpl: mockProxy({ putStatus: 403, putBody: { ok: false, error: "X-Campaign-Key does not match this map's campaign." } }).fetchImpl });
  assert.deepEqual([forbidden.status, forbidden.reason], ["failed", "key_mismatch"]);
  assert.match(forbidden.detail, /does not match this map's campaign/);
  const gone = await run({ fetchImpl: mockProxy({ getStatus: 404 }).fetchImpl });
  assert.deepEqual([gone.status, gone.reason], ["failed", "map_not_found"]);
  const goneOnWrite = await run({ fetchImpl: mockProxy({ putStatus: 404 }).fetchImpl });
  assert.equal(goneOnWrite.reason, "map_not_found");
  const raced = await run({ fetchImpl: mockProxy({ putStatus: 409, putBody: { ok: false, error: "Map changed since you loaded it." } }).fetchImpl });
  assert.deepEqual([raced.status, raced.reason], ["failed", "map_changed_underneath"]);
  assert.match(raced.detail, /Derive again/);
  const rejected = await run({ fetchImpl: mockProxy({ putStatus: 422, putBody: { ok: false, error: "CampaignSpec failed validation with 2 error-severity violations. Map not saved.", violations: [{ severity: "error" }, { severity: "error" }, { severity: "warning" }] } }).fetchImpl });
  assert.deepEqual([rejected.status, rejected.reason], ["failed", "map_rejected"]);
  assert.match(rejected.detail, /2 error-severity violations/);
  const bad = await run({ fetchImpl: mockProxy({ putStatus: 400, putBody: { ok: false, error: "Invalid JSON body." } }).fetchImpl });
  assert.equal(bad.reason, "map_rejected");
  const down = await run({ fetchImpl: mockProxy({ putStatus: 503 }).fetchImpl });
  assert.deepEqual([down.status, down.reason], ["failed", "http_error"]);
  assert.match(down.detail, /503/);
  const notOk = await run({ fetchImpl: mockProxy({ putBody: { ok: false, error: "stored map unreadable" } }).fetchImpl });
  assert.deepEqual([notOk.status, notOk.reason], ["failed", "response_invalid"]);
  assert.match(notOk.detail, /may or may not have been written/);
  const noBody = await run({ fetchImpl: async (url, init = {}) => ((init.method || "GET") === "GET" ? jsonResponse({ ok: true, data: mapRecord() }) : ({ ok: true, status: 200, statusText: "OK", json: async () => { throw new Error("empty"); } })) });
  assert.equal(noBody.reason, "response_invalid");
  let putCalls = 0;
  const network = await run({ fetchImpl: async (url, init = {}) => { if ((init.method || "GET") === "PUT") { putCalls += 1; throw new Error("socket hang up"); } return jsonResponse({ ok: true, data: mapRecord() }); } });
  assert.deepEqual([network.status, network.reason], ["failed", "network_error"]);
  assert.match(network.detail, /socket hang up/);
  assert.equal(putCalls, 1);
  const readDown = await run({ fetchImpl: async () => { throw new Error("ENOTFOUND"); } });
  assert.deepEqual([readDown.status, readDown.reason], ["failed", "network_error"]);
  const notASpec = await run({ fetchImpl: async () => jsonResponse({ ok: true, data: [1] }) });
  assert.deepEqual([notASpec.status, notASpec.reason], ["failed", "map_unreadable"]);
  // Validation warnings the receiver returns with an ok write are surfaced.
  const warned = await run({ fetchImpl: mockProxy({ putBody: { ok: true, spec_identity: { spec_hash: "h2", saved_at: "2026-09-17T09:00:00.000Z" }, warnings: [{ severity: "warning", message: "offer has no image" }, "plain warning"] } }).fetchImpl });
  assert.equal(warned.status, "written");
  assert.deepEqual(warned.warnings, ["offer has no image", "plain warning"]);
});
