import assert from "node:assert/strict";
import test from "node:test";

import { DEADLINE_TIMEOUT_ERROR_CODE, runWithDeadline } from "./deadline.mjs";

test("a completed operation returns its value and clears its referenced timer", async () => {
  const events = [];
  const handle = { unref: () => events.push("unref") };
  const result = await runWithDeadline(async () => "complete", {
    timeoutMs: 10,
    setTimer(callback, milliseconds) {
      events.push(["set", milliseconds, typeof callback]);
      return handle;
    },
    clearTimer(received) { events.push(["clear", received === handle]); },
  });

  assert.equal(result, "complete");
  assert.deepEqual(events, [["set", 10, "function"], ["clear", true]]);
});

test("a fired deadline rejects with the default coded error, then runs cleanup, then clears the timer", async () => {
  const events = [];
  const handle = {};
  await assert.rejects(
    runWithDeadline(() => new Promise(() => {}), {
      timeoutMs: 10,
      onTimeout: () => events.push("cleanup"),
      setTimer(callback) { queueMicrotask(callback); return handle; },
      clearTimer(received) { events.push(["clear", received === handle]); },
    }),
    (error) => {
      assert.equal(error.code, DEADLINE_TIMEOUT_ERROR_CODE);
      assert.equal(error.message, "Operation exceeded its 10ms deadline.");
      return true;
    },
  );
  assert.deepEqual(events, ["cleanup", ["clear", true]]);
});

test("the caller's timeoutError factory shapes the rejection and receives the deadline", async () => {
  const seen = [];
  await assert.rejects(
    runWithDeadline(() => new Promise(() => {}), {
      timeoutMs: 7,
      timeoutError(timeoutMs) {
        seen.push(timeoutMs);
        const error = new Error("custom deadline");
        error.code = "custom_code";
        return error;
      },
      setTimer(callback) { queueMicrotask(callback); return {}; },
      clearTimer() {},
    }),
    (error) => error.code === "custom_code" && error.message === "custom deadline",
  );
  assert.deepEqual(seen, [7]);
});

test("the fixed timeout wins over an operation that rejects on its own abort", async () => {
  const controller = new AbortController();
  await assert.rejects(
    runWithDeadline(() => new Promise((unusedResolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("raw abort")), { once: true });
    }), {
      timeoutMs: 5,
      onTimeout: () => controller.abort(),
    }),
    (error) => error.code === DEADLINE_TIMEOUT_ERROR_CODE,
  );
  assert.equal(controller.signal.aborted, true);
});

test("the operation starts synchronously and a synchronous throw settles as a rejection", async () => {
  let started = false;
  const pending = runWithDeadline(() => { started = true; return Promise.resolve("ok"); }, { timeoutMs: 1_000 });
  assert.equal(started, true);
  assert.equal(await pending, "ok");
  await assert.rejects(
    runWithDeadline(() => { throw new Error("sync failure"); }, { timeoutMs: 1_000 }),
    /sync failure/,
  );
});

test("an operation that rejects before the deadline surfaces its own error", async () => {
  const events = [];
  await assert.rejects(
    runWithDeadline(async () => { throw new Error("operation failed"); }, {
      timeoutMs: 1_000,
      setTimer() { return {}; },
      clearTimer() { events.push("clear"); },
    }),
    /operation failed/,
  );
  assert.deepEqual(events, ["clear"]);
});

test("best-effort background deadlines may unref but still clear their timer", async () => {
  const events = [];
  const handle = { unref: () => events.push("unref") };
  const result = await runWithDeadline(async () => "complete", {
    timeoutMs: 10,
    unrefTimer: true,
    setTimer() { return handle; },
    clearTimer(received) { events.push(["clear", received === handle]); },
  });

  assert.equal(result, "complete");
  assert.deepEqual(events, ["unref", ["clear", true]]);
});

test("an owner abort rejects with the timeout error immediately and clears the longer deadline", async () => {
  const controller = new AbortController();
  const events = [];
  const handle = {};
  const pending = runWithDeadline(() => new Promise(() => {}), {
    timeoutMs: 45_000,
    signal: controller.signal,
    setTimer() { return handle; },
    clearTimer(received) { events.push(["clear", received === handle]); },
  });
  controller.abort();

  await assert.rejects(pending, (error) => error.code === DEADLINE_TIMEOUT_ERROR_CODE);
  assert.deepEqual(events, [["clear", true]]);
});

test("an invalid configuration is refused before any timer exists", async () => {
  const cases = [
    [null, { timeoutMs: 10 }],
    [async () => {}, { timeoutMs: 0 }],
    [async () => {}, { timeoutMs: Number.NaN }],
    [async () => {}, { timeoutMs: "10" }],
    [async () => {}, { timeoutMs: 10, timeoutError: "nope" }],
    [async () => {}, { timeoutMs: 10, setTimer: null }],
  ];
  for (const [operation, options] of cases) {
    await assert.rejects(
      runWithDeadline(operation, { ...options, setTimer: options.setTimer === null ? null : () => assert.fail("timer created") }),
      /invalid deadline configuration/,
    );
  }
});
