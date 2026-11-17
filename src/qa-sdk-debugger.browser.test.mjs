// QA's browser-sdk-debugger check, real Chromium: the debugger overlay the
// SDK mounts after it is ready, which can land after network idle, is waited
// for up to the SDK display-ready deadline before the page is read.
import assert from "node:assert/strict";
import { after, afterEach } from "node:test";

import { browserTest, htmlPage, respond } from "./readability-harness.browser.test.mjs";
import { stubOrigin } from "./polish-media-weight-harness.browser.test.mjs";
import { assertNoNetworkAttempts } from "./qc-test-factories.mjs";

afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

// Stands in for the SDK in debugger mode: display-ready and the overlay with
// its selectors mount `delayMs` after load, with no network traffic between.
const OVERLAY = ["next-debug-overlay-host", "debug-selectors-container", "debug-currency-selector", "debug-country-selector", "debug-locale-selector"];
const debuggerPage = (delayMs) => htmlPage("<main><p>Synthetic receipt</p></main>", {
  head: `<meta name="next-page-type" content="receipt"><script>
addEventListener("load", () => setTimeout(() => {
  document.documentElement.classList.add("next-display-ready");
  for (const id of ${JSON.stringify(OVERLAY)}) { const node = document.createElement("div"); node.id = id; document.body.append(node); }
}, ${delayMs}));
</script>`,
});

browserTest("QA SDK debugger: an overlay that mounts 2.5 s after load, past network idle, reads mounted", async () => {
  const origin = await stubOrigin();
  try {
    for (const path of ["/receipt/", "/receipt/?debugger=true"]) origin.serve(path, respond("200 OK", "text/html; charset=utf-8", debuggerPage(2500)));
    const { runBrowserChecks } = await import("./qa-browser.mjs");
    const page = { page_id: "receipt", page_type: "receipt", url: origin.url("/receipt/") };
    const assertions = await runBrowserChecks([{ pages: [page] }], {}, {});
    const row = assertions.find((entry) => entry.id === "browser-sdk-debugger:receipt");
    assert.ok(row, assertions.map((entry) => entry.id).join(", "));
    assert.equal(row.status, "pass", `${row.actual} ${JSON.stringify(row.evidence)}`);
  } finally {
    await origin.close();
  }
});
