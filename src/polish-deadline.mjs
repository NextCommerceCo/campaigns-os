export const POLISH_PRODUCER_TIMEOUT_ERROR_CODE = "POLISH_PRODUCER_TIMEOUT";
export const POLISH_PRODUCER_CLEANUP_ERROR_CODE = "POLISH_PRODUCER_CLEANUP_FAILED";
export const POLISH_BROWSER_CELL_DEADLINE_MS = 45_000;
export const POLISH_BROWSER_CLEANUP_DEADLINE_MS = 5_000;
export const POLISH_BROWSER_STARTUP_DEADLINE_MS = 45_000;
export const POLISH_CAPTURE_CELL_DEADLINE_MS = 55_000;
export const POLISH_CAPTURE_CLOSE_DEADLINE_MS = 10_000;
export const POLISH_CAPTURE_STARTUP_DEADLINE_MS = 55_000;

export function boundedPolishDeadline(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 && value <= fallback ? value : fallback;
}

export function polishProducerTimeoutError() {
  const error = new Error("Campaigns OS polish capture producer exceeded its bounded deadline.");
  error.code = POLISH_PRODUCER_TIMEOUT_ERROR_CODE;
  return error;
}

export function polishProducerCleanupError() {
  const error = new Error("Campaigns OS polish capture could not clean up its producer resources.");
  error.code = POLISH_PRODUCER_CLEANUP_ERROR_CODE;
  return error;
}

export async function runWithPolishProducerDeadline(operation, {
  timeoutMs,
  onTimeout,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  unrefTimer = false,
  signal,
} = {}) {
  if (typeof operation !== "function"
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || typeof setTimer !== "function"
    || typeof clearTimer !== "function") {
    throw new Error("Campaigns OS polish capture received an invalid producer deadline configuration.");
  }

  const operationPromise = Promise.resolve().then(operation);
  let abortListener = null;
  const abortPromise = signal && typeof signal.addEventListener === "function"
    ? new Promise((unusedResolve, reject) => {
        abortListener = () => reject(polishProducerTimeoutError());
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
      reject(polishProducerTimeoutError());
      if (typeof onTimeout === "function") {
        try {
          Promise.resolve(onTimeout()).catch(() => {});
        } catch {
          // Timeout cleanup is best-effort and must never replace the fixed diagnostic.
        }
      }
    }, timeoutMs);
    timerCreated = true;
    // An awaited producer deadline stays referenced so a bare unresolved Promise
    // cannot let Node exit before incomplete evidence is persisted. Only callers
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
