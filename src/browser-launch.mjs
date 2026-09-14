// One launcher for the package-owned Playwright Chromium. Polish capture and
// browser QA both import `playwright` lazily (so the CLI loads without it),
// launch Chromium headless unless `--headed`, and turn the two ways that can
// fail — the package is not installed, the browser executable is not
// installed — into an actionable message. The messages differ per surface
// (each names its own rerun command), so the caller supplies them through
// `onMissing(kind, error)`; the detection lives here once.

// Playwright's own wording when the browser binary is absent, across the
// versions this package has run against.
const MISSING_BROWSER_PATTERN = /executable doesn't exist|browser.*not found|playwright install|install.*chromium/i;

export const MISSING_BROWSER_KINDS = Object.freeze({
  PACKAGE: "package",
  BROWSER: "browser",
});

export function isMissingBrowserError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return MISSING_BROWSER_PATTERN.test(message);
}

async function importChromium() {
  const playwright = await import("playwright");
  return playwright.chromium;
}

// `onMissing(kind, cause)` returns the error to throw for a missing package
// (`kind` "package": the import failed) or a missing browser executable
// (`kind` "browser": launch failed with Playwright's install wording). Any
// other launch failure is rethrown untouched. `chromium` injects a launcher
// (tests, or a caller that already resolved one) in place of the import.
// `signal` is consulted between the import and the launch: a caller whose
// deadline expired while the package was loading gets `signal.reason` back
// and no browser is started on its behalf.
export async function launchPackageChromium({
  headed = false,
  chromium: injectedChromium,
  onMissing,
  signal,
} = {}) {
  if (typeof onMissing !== "function") {
    throw new Error("Campaigns OS browser launch requires an onMissing(kind, error) handler.");
  }
  let chromium = injectedChromium;
  if (!chromium) {
    try {
      chromium = await importChromium();
    } catch (error) {
      throw onMissing(MISSING_BROWSER_KINDS.PACKAGE, error);
    }
  }
  if (signal?.aborted) throw signal.reason ?? new Error("Campaigns OS browser launch was abandoned before launch.");
  try {
    return await chromium.launch({ headless: headed !== true });
  } catch (error) {
    if (isMissingBrowserError(error)) throw onMissing(MISSING_BROWSER_KINDS.BROWSER, error);
    throw error;
  }
}
