import test from "node:test";
import assert from "node:assert/strict";

import {
  analyticsCaptureError,
  projectAnalyticsCaptureError,
} from "./qa-analytics-errors.mjs";

test("capture errors project to one fixed code/message vocabulary and discard raw detail", () => {
  assert.deepEqual(analyticsCaptureError("collectionDeadline"), {
    code: "analytics_capture_collection_deadline_exhausted",
    message: "analytics capture collection exceeded the typed-order deadline",
  });
  assert.deepEqual(projectAnalyticsCaptureError({
    code: "analytics_capture_unreadable",
    message: "attacker-controlled replacement",
    raw: "page.evaluate failed at https://shop.example/receipt/?ref_id=secret",
  }), {
    code: "analytics_capture_unreadable",
    message: "analytics capture could not be read from the settled page",
  });
  assert.equal(projectAnalyticsCaptureError({ code: "unknown", raw: "secret" }), null);
  assert.deepEqual(
    projectAnalyticsCaptureError("raw Playwright failure", { fallbackKind: "unreadable" }),
    analyticsCaptureError("unreadable"),
  );
});
