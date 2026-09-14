// One deadline racer for every bounded asynchronous operation in the toolkit.
// An operation is a thunk; the race settles with the operation, or rejects
// with the caller's timeout error once `timeoutMs` elapses (or the owner's
// signal aborts). The timer is always cleared, so a completed race never
// keeps the process alive, and a deadline that fires runs `onTimeout`
// (best-effort cleanup: abort a controller, close a late resource) only after
// the timeout rejection has been settled, so a signal-aware operation cannot
// replace the fixed diagnostic with its own raw abort error.
export const DEADLINE_TIMEOUT_ERROR_CODE = "DEADLINE_TIMEOUT";

export function deadlineTimeoutError(timeoutMs) {
  const error = new Error(`Operation exceeded its ${timeoutMs}ms deadline.`);
  error.code = DEADLINE_TIMEOUT_ERROR_CODE;
  return error;
}

export async function runWithDeadline(operation, {
  timeoutMs,
  onTimeout,
  signal,
  unrefTimer = false,
  timeoutError = deadlineTimeoutError,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
} = {}) {
  if (typeof operation !== "function"
    || typeof timeoutMs !== "number"
    || !Number.isFinite(timeoutMs)
    || timeoutMs <= 0
    || typeof timeoutError !== "function"
    || typeof setTimer !== "function"
    || typeof clearTimer !== "function") {
    throw new Error("runWithDeadline received an invalid deadline configuration.");
  }

  // Start the operation synchronously so callers that hand it a controller
  // (or watch its first side effect) see it begin before the timer is armed;
  // a synchronous throw still settles the race as a rejection.
  const operationPromise = new Promise((resolve) => resolve(operation()));
  let abortListener = null;
  const abortPromise = signal && typeof signal.addEventListener === "function"
    ? new Promise((unusedResolve, reject) => {
        abortListener = () => reject(timeoutError(timeoutMs));
        if (signal.aborted) abortListener();
        else signal.addEventListener("abort", abortListener, { once: true });
      })
    : null;
  let timerHandle;
  let timerCreated = false;
  const deadlinePromise = new Promise((unusedResolve, reject) => {
    timerHandle = setTimer(() => {
      // Settle the authoritative fixed timeout before abort/cleanup can make a
      // signal-aware operation reject with a raw implementation error.
      reject(timeoutError(timeoutMs));
      if (typeof onTimeout === "function") {
        try {
          Promise.resolve(onTimeout()).catch(() => {});
        } catch {
          // Timeout cleanup is best-effort and must never replace the fixed diagnostic.
        }
      }
    }, timeoutMs);
    timerCreated = true;
    // An awaited deadline stays referenced so a bare unresolved Promise cannot
    // let Node exit before the caller has recorded the outcome. Only callers
    // doing best-effort late cleanup may explicitly unref their background timer.
    if (unrefTimer && typeof timerHandle?.unref === "function") timerHandle.unref();
  });

  try {
    return await Promise.race([operationPromise, deadlinePromise, ...(abortPromise ? [abortPromise] : [])]);
  } finally {
    if (timerCreated) clearTimer(timerHandle);
    if (abortListener && typeof signal?.removeEventListener === "function") {
      signal.removeEventListener("abort", abortListener);
    }
  }
}
