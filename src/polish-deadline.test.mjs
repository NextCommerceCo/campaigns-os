import assert from "node:assert/strict";
import test from "node:test";

import {
  POLISH_PRODUCER_TIMEOUT_ERROR_CODE,
  runWithPolishProducerDeadline,
} from "./polish-deadline.mjs";

test("awaited producer deadlines keep their timer referenced and clear it after ordinary completion", async () => {
  const events = [];
  const handle = { unref: () => events.push("unref") };
  const result = await runWithPolishProducerDeadline(async () => "complete", {
    timeoutMs: 10,
    setTimer(callback, milliseconds) {
      events.push(["set", milliseconds, typeof callback]);
      return handle;
    },
    clearTimer(received) {
      events.push(["clear", received === handle]);
    },
  });

  assert.equal(result, "complete");
  assert.deepEqual(events, [["set", 10, "function"], ["clear", true]]);
});

test("producer deadlines reject with one fixed code, run cleanup, and leave no timer behind", async () => {
  const events = [];
  const handle = { unref: () => events.push("unref") };
  await assert.rejects(
    runWithPolishProducerDeadline(() => new Promise(() => {}), {
      timeoutMs: 10,
      onTimeout: () => events.push("cleanup"),
      setTimer(callback, milliseconds) {
        events.push(["set", milliseconds, typeof callback]);
        queueMicrotask(callback);
        return handle;
      },
      clearTimer(received) {
        events.push(["clear", received === handle]);
      },
    }),
    (error) => {
      assert.equal(error.code, POLISH_PRODUCER_TIMEOUT_ERROR_CODE);
      assert.equal(error.message, "Campaigns OS polish capture producer exceeded its bounded deadline.");
      return true;
    },
  );
  assert.deepEqual(events, [["set", 10, "function"], "cleanup", ["clear", true]]);
});

test("best-effort background deadlines may unref but still clear their timer", async () => {
  const events = [];
  const handle = { unref: () => events.push("unref") };
  const result = await runWithPolishProducerDeadline(async () => "complete", {
    timeoutMs: 10,
    unrefTimer: true,
    setTimer() { return handle; },
    clearTimer(received) { events.push(["clear", received === handle]); },
  });

  assert.equal(result, "complete");
  assert.deepEqual(events, ["unref", ["clear", true]]);
});

test("an owner abort rejects immediately and clears the longer internal deadline", async () => {
  const controller = new AbortController();
  const events = [];
  const handle = {};
  const pending = runWithPolishProducerDeadline(() => new Promise(() => {}), {
    timeoutMs: 45_000,
    signal: controller.signal,
    setTimer() { return handle; },
    clearTimer(received) { events.push(["clear", received === handle]); },
  });
  controller.abort();

  await assert.rejects(pending, (error) => error.code === POLISH_PRODUCER_TIMEOUT_ERROR_CODE);
  assert.deepEqual(events, [["clear", true]]);
});
