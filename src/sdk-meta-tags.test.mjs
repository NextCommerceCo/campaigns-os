import assert from "node:assert/strict";
import { test } from "node:test";

import { SDK_IGNORED_META_TAGS, describeSdkIgnoredMetaTags, sdkIgnoredMetaTag } from "./sdk-meta-tags.mjs";
import { __qaNodeTestHooks } from "./qa-node.mjs";

const { unsupportedSdkMetaHint } = __qaNodeTestHooks;

test("the SDK-ignored meta-tag list names exactly the keys the SDK does not read", () => {
  assert.deepEqual(Object.keys(SDK_IGNORED_META_TAGS).sort(), ["next-currency", "next-predictive-address"]);
  for (const entry of Object.values(SDK_IGNORED_META_TAGS)) {
    assert.match(entry.note, /^Campaign Cart does not read a next-[a-z-]+ meta tag; remove it from the Map's page hints\./);
  }
  assert.equal(sdkIgnoredMetaTag(" Next-Currency "), SDK_IGNORED_META_TAGS["next-currency"]);
  assert.equal(sdkIgnoredMetaTag("next-page-type"), null);
  assert.equal(sdkIgnoredMetaTag("next-success-url"), null);
  assert.equal(sdkIgnoredMetaTag(undefined), null);
});

test("doctor's advisory line names each ignored tag with the shared note", () => {
  const line = describeSdkIgnoredMetaTags(["next-currency", "next-page-type", "next-currency"]);
  assert.equal(line, `"next-currency" (${SDK_IGNORED_META_TAGS["next-currency"].note})`);
  assert.equal(describeSdkIgnoredMetaTags(["next-page-type"]), "");
});

test("QA's unsupported-meta hint is the shared map entry, so doctor and QA cannot disagree", () => {
  for (const [name, entry] of Object.entries(SDK_IGNORED_META_TAGS)) {
    assert.equal(unsupportedSdkMetaHint(name), entry);
    assert.equal(unsupportedSdkMetaHint(name).note, entry.note);
  }
});

test("a rendered SDK-ignored meta tag is a QA warn row with the shared note, never manual_review", async () => {
  const page = { page_id: "checkout", page_type: "checkout", url: "https://fixture.example.test/checkout" };
  for (const [name, expected] of [["next-currency", "USD"], ["next-predictive-address", "true"]]) {
    for (const rendered of [true, false]) {
      const html = rendered ? `<meta name="${name}" content="${expected}">` : "<title>x</title>";
      const { assertions } = await __qaNodeTestHooks.runPageChecks({ ...page, expected_meta_tags: { [name]: expected } }, {}, {
        sourceLoader: async () => ({ ok: true, status: 200, status_text: "OK", html }),
      });
      const row = assertions.find((a) => a.id === `meta:checkout:${name}`);
      assert.ok(row, `meta row for ${name}`);
      assert.equal(row.status, "warn");
      assert.equal(row.severity, "warn");
      assert.notEqual(row.status, "manual_review");
      assert.equal(row.evidence.note, SDK_IGNORED_META_TAGS[name].note);
      assert.equal(row.actual, rendered ? `${expected} (present but ignored by Campaign Cart)` : SDK_IGNORED_META_TAGS[name].actual);
    }
  }
});
