import test from "node:test";
import assert from "node:assert/strict";

import { redactUrlQuery } from "./qa-url-privacy.mjs";

test("redactUrlQuery returns one query- and fragment-free route for absolute and malformed inputs", () => {
  assert.equal(
    redactUrlQuery("https://shop.example/campaign/receipt/?ref_id=secret#order"),
    "https://shop.example/campaign/receipt/",
  );
  assert.equal(redactUrlQuery("not a url?ref_id=secret#order"), "not a url");
  assert.equal(redactUrlQuery("relative/path#secret"), "relative/path");
  assert.equal(redactUrlQuery("?ref_id=secret"), null);
  assert.equal(redactUrlQuery(null), null);
});
