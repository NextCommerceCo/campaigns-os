import { runWithDeadline } from "./deadline.mjs";

export const POLISH_PRODUCER_TIMEOUT_ERROR_CODE = "POLISH_PRODUCER_TIMEOUT";
export const POLISH_PRODUCER_CLEANUP_ERROR_CODE = "POLISH_PRODUCER_CLEANUP_FAILED";
// Shared by the browser adapter (which raises it) and polish-node (which
// classifies it) without polish-node importing the adapter module, so the
// CLI can keep lazy-loading polish-browser.
export const POLISH_BROWSER_UNAVAILABLE_ERROR_CODE = "POLISH_BROWSER_UNAVAILABLE";
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
  return runWithDeadline(operation, {
    timeoutMs,
    onTimeout,
    signal,
    unrefTimer,
    timeoutError: polishProducerTimeoutError,
    setTimer,
    clearTimer,
    label: "Campaigns OS polish capture",
  });

}
