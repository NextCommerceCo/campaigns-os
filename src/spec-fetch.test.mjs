import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_PROXY_BASE, fetchSpecByMapId } from "./spec-fetch.mjs";
import { __qaNodeTestHooks } from "./qa-node.mjs";

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? "OK" : "Not Found",
  json: async () => body,
});

test("fetchSpecByMapId reads /api/spec/<id> under the proxy base and returns data on ok:true", async () => {
  const calls = [];
  const spec = await fetchSpecByMapId(" demo-1 ", {
    proxyBase: "https://proxy.example/",
    fetchImpl: async (url, init) => {
      calls.push([url, init.headers.Accept]);
      return jsonResponse({ ok: true, data: { version: "42", name: "demo" } });
    },
  });
  assert.deepEqual(spec, { version: "42", name: "demo" });
  assert.deepEqual(calls, [["https://proxy.example/api/spec/demo-1", "application/json"]]);
  assert.equal(DEFAULT_PROXY_BASE, "https://campaign-map.nextcommerce.com");
});

test("fetchSpecByMapId refuses a missing id, a non-2xx, invalid JSON and an ok:false body, each by name", async () => {
  await assert.rejects(fetchSpecByMapId("  ", { fetchImpl: async () => jsonResponse({}) }), /mapId is required/);
  await assert.rejects(fetchSpecByMapId("x", { fetchImpl: async () => { throw new Error("down"); } }), /Spec fetch network error: down/);
  await assert.rejects(fetchSpecByMapId("x", { fetchImpl: async () => jsonResponse({}, 404) }), /Spec fetch failed: 404 Not Found/);
  await assert.rejects(fetchSpecByMapId("x", { fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad"); } }) }), /Spec fetch returned invalid JSON: bad/);
  await assert.rejects(fetchSpecByMapId("x", { fetchImpl: async () => jsonResponse({ ok: false, error: "no such map" }) }), /Spec fetch returned ok=false: no such map/);
  await assert.rejects(fetchSpecByMapId("x", { fetchImpl: async () => jsonResponse({ ok: true }) }), /Spec fetch returned ok=false: unknown error/);
  // Each refusal carries kind and status as data, so a caller routes on the
  // field (a 404 is "gone", a socket error is "network") and never on prose.
  await assert.rejects(fetchSpecByMapId("x", { fetchImpl: async () => { throw new Error("down"); } }), (error) => error.kind === "network" && error.status === null);
  await assert.rejects(fetchSpecByMapId("x", { fetchImpl: async () => jsonResponse({}, 404) }), (error) => error.kind === "http" && error.status === 404);
  await assert.rejects(fetchSpecByMapId("x", { fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad"); } }) }), (error) => error.kind === "invalid_json" && error.status === 200);
  await assert.rejects(fetchSpecByMapId("x", { fetchImpl: async () => jsonResponse({ ok: false, error: "no such map" }) }), (error) => error.kind === "not_ok" && error.status === 200);
});

test("packet-less qa --map-id applies the same response rules: an ok:false 200 body is a refusal, not a spec", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return jsonResponse({ ok: false, error: "no such map" });
  };
  try {
    await assert.rejects(
      __qaNodeTestHooks.resolveQaInputs({ _: ["qa", "run"], "map-id": "missing-map", "base-url": "https://qa.example/" }),
      /Spec fetch returned ok=false: no such map/,
    );
    assert.deepEqual(requests, [`${DEFAULT_PROXY_BASE}/api/spec/missing-map`]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
