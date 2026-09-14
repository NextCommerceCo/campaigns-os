import test from "node:test";
import assert from "node:assert/strict";

import {
  MISSING_BROWSER_KINDS,
  isMissingBrowserError,
  launchPackageChromium,
} from "./browser-launch.mjs";

function fakeChromium({ launchError } = {}) {
  const calls = [];
  const browser = { closed: false };
  return {
    calls,
    browser,
    chromium: {
      async launch(options) {
        calls.push(options);
        if (launchError) throw launchError;
        return browser;
      },
    },
  };
}

const onMissing = (kind, error) => {
  const mapped = new Error(`mapped:${kind}`);
  mapped.cause = error;
  return mapped;
};

test("launches the injected chromium headless unless headed, and returns the browser", async () => {
  const fake = fakeChromium();
  const headless = await launchPackageChromium({ chromium: fake.chromium, onMissing });
  const headed = await launchPackageChromium({ chromium: fake.chromium, headed: true, onMissing });
  const truthyButNotTrue = await launchPackageChromium({ chromium: fake.chromium, headed: "yes", onMissing });

  assert.equal(headless, fake.browser);
  assert.equal(headed, fake.browser);
  assert.equal(truthyButNotTrue, fake.browser);
  assert.deepEqual(fake.calls, [{ headless: true }, { headless: false }, { headless: true }]);
});

test("a missing browser executable is mapped through onMissing with the browser kind and the cause", async () => {
  const launchError = new Error("Executable doesn't exist at /private/tmp/chromium?token=private");
  const fake = fakeChromium({ launchError });

  await assert.rejects(
    launchPackageChromium({ chromium: fake.chromium, onMissing }),
    (error) => {
      assert.equal(error.message, `mapped:${MISSING_BROWSER_KINDS.BROWSER}`);
      assert.equal(error.cause, launchError);
      return true;
    },
  );
});

test("any other launch failure is rethrown untouched", async () => {
  const launchError = new Error("Target page, context or browser has been closed");
  const fake = fakeChromium({ launchError });

  await assert.rejects(
    launchPackageChromium({ chromium: fake.chromium, onMissing }),
    (error) => error === launchError,
  );
});

test("onMissing is required, and is consulted before any launch", async () => {
  const fake = fakeChromium();
  await assert.rejects(
    launchPackageChromium({ chromium: fake.chromium }),
    /onMissing\(kind, error\)/,
  );
  assert.deepEqual(fake.calls, []);
});

test("the missing-browser detection recognises Playwright's install wording and nothing else", () => {
  for (const message of [
    "Executable doesn't exist at /private/tmp/ms-playwright/chromium-1234/chrome",
    "browser was not found",
    "Please run the following command to download new browsers: npx playwright install",
    "Run `npx playwright install chromium`",
    "INSTALL CHROMIUM first",
  ]) {
    assert.equal(isMissingBrowserError(new Error(message)), true, message);
    assert.equal(isMissingBrowserError(message), true, message);
  }
  for (const value of [
    new Error("Target page, context or browser has been closed"),
    new Error("net::ERR_CONNECTION_REFUSED"),
    "",
    null,
    undefined,
  ]) {
    assert.equal(isMissingBrowserError(value), false, String(value));
  }
});
