import test from "node:test";
import assert from "node:assert/strict";

import { __qaBrowserTestHooks as hooks } from "./qa-browser.mjs";

test("a response body that never finishes loading is reported as null after the bound", async () => {
  const started = Date.now();
  const body = await hooks.readJsonResponseBody({ text: () => new Promise(() => {}) }, { timeoutMs: 50 });
  assert.equal(body, null);
  assert.ok(Date.now() - started < 1000);
});

test("a loaded body is still parsed, and a failed read is null", async () => {
  assert.deepEqual(await hooks.readJsonResponseBody({ text: async () => "{\"ok\":true}" }), { ok: true });
  assert.equal(await hooks.readJsonResponseBody({ text: async () => { throw new Error("gone"); } }), null);
  assert.equal(await hooks.readJsonResponseBody({ text() { throw new Error("sync"); } }), null);
});
