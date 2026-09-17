// Evaluator cases for cross-page campaign identity (#301). Pure inputs, so
// each rule is proven in isolation; the doctor wiring and the committed
// fixture trees are covered in doctor-campaign-identity.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAMPAIGN_IDENTITY,
  CAMPAIGN_IDENTITY_KINDS,
  collectPageIdentity,
  collectScriptApiKeys,
  collectSetAttributionFunnels,
  evaluateCampaignIdentity,
  externalScriptSources,
  isParkedPage,
} from "./campaign-identity.mjs";

const kinds = (gate) => gate.findings.map((finding) => finding.kind);

function html({ funnel = "Example V2", pageType = "checkout", apiKeyMeta = null, inline = "" } = {}) {
  return `<html><head>${apiKeyMeta ? `<meta name="next-api-key" content="${apiKeyMeta}">` : ""}`
    + `${funnel ? `<meta name="next-funnel" content="${funnel}">` : ""}`
    + `${pageType ? `<meta name="next-page-type" content="${pageType}">` : ""}`
    + `</head><body>${inline ? `<script>${inline}</script>` : ""}</body></html>`;
}

const config = (apiKey) => ({ src: "/example/config.js", file: "./_site/example/config.js", content: `window.nextConfig = {\n  apiKey: "${apiKey}",\n  googleMaps: { apiKey: "" },\n};` });

test("collectScriptApiKeys reads the campaign key at depth one and ignores nested, commented and legacy-less spellings", () => {
  const js = [
    "window.nextConfig = {",
    "  // apiKey: \"commented-out\"",
    "  /* apiKey: 'block-comment' */",
    "  debug: true,",
    "  addressConfig: { googleMaps: { apiKey: \"maps-key\" } },",
    "  'apiKey': 'the-campaign-key',",
    "};",
  ].join("\n");
  assert.deepEqual(collectScriptApiKeys(js), [{ source: "nextConfig.apiKey", value: "the-campaign-key" }]);
});

test("collectScriptApiKeys catches the assignment form and the legacy nextCampaign.config spelling", () => {
  assert.deepEqual(collectScriptApiKeys('window.nextConfig.apiKey = "assigned";'), [{ source: "nextConfig.apiKey", value: "assigned" }]);
  assert.deepEqual(collectScriptApiKeys("nextCampaign.config({ debug: false, apiKey: 'legacy' });"), [{ source: "nextCampaign.config apiKey", value: "legacy" }]);
  // A computed key is not a value a static check can compare; it is simply not observed.
  assert.deepEqual(collectScriptApiKeys("window.nextConfig = { apiKey: window.KEY };"), []);
});

test("collectSetAttributionFunnels reads every spelling of the call", () => {
  const js = 'next.setAttribution({ funnel: "Example V1A", utm_source: "x" }); window.next.setAttribution({funnel:\'Second\'});';
  assert.deepEqual(collectSetAttributionFunnels(js), ["Example V1A", "Second"]);
});

test("isParkedPage matches *-backup-* and *-old-* segments and nothing that merely contains the letters", () => {
  for (const parked of ["checkout-backup-2", "upsell-old", "old-upsell/index.html", "receipt-old-v1.html", "backup/checkout", "checkout-backup-2/index.htm", "upsell-old.htm", "_site\\example\\checkout-old\\index.html"]) {
    assert.equal(isParkedPage(parked), true, parked);
  }
  for (const live of ["checkout", "bold-claims", "holdout", "goldfish/index.html", "upsell-1/index.html"]) {
    assert.equal(isParkedPage(live), false, live);
  }
});

test("collectPageIdentity attributes an external script's key and setAttribution to the page that loads it", () => {
  const identity = collectPageIdentity({
    page_id: "checkout",
    file: "./_site/example/checkout/index.html",
    content: html({ inline: 'next.setAttribution({ funnel: "Example V2" })' }),
    scripts: [config("keyA")],
  });
  assert.equal(identity.funnel, "Example V2");
  assert.equal(identity.page_type, "checkout");
  assert.equal(identity.api_key_meta, null);
  assert.deepEqual(identity.api_keys.map((key) => [key.value, key.where]), [["keyA", "./_site/example/config.js"]]);
  assert.deepEqual(identity.attributions, [{ where: "./_site/example/checkout/index.html", value: "Example V2" }]);
});

test("commented-out markup is inert: a setAttribution or meta inside an HTML comment is not an observation", () => {
  const content = `<html><head><meta name="next-funnel" content="Example V2"><meta name="next-page-type" content="checkout">`
    + `<!-- <meta name="next-api-key" content="oldkey"> --></head><body><!-- <script>next.setAttribution({ funnel: "Old" })</script> --></body></html>`;
  const identity = collectPageIdentity({ page_id: "checkout", content });
  assert.deepEqual(identity.api_keys, []);
  assert.deepEqual(identity.attributions, []);
});

test("three consistent pages pass, and the meta key is reported when meta and config both exist and agree", () => {
  const gate = evaluateCampaignIdentity({
    subject: { public_route_slug: "example" },
    pages: [
      { page_id: "checkout", content: html({ apiKeyMeta: "keyA" }), scripts: [config("keyA")] },
      { page_id: "upsell-1", content: html({ pageType: "upsell" }), scripts: [config("keyA")] },
      { page_id: "receipt", content: html({ pageType: "receipt" }), scripts: [config("keyA")] },
    ],
  });
  assert.equal(gate.status, "pass");
  assert.equal(gate.id, CAMPAIGN_IDENTITY);
  assert.equal(gate.waivable, false);
  assert.equal(gate.identity.api_key, "keyA");
  assert.equal(gate.identity.api_key_source, 'meta name="next-api-key"');
});

test("meta and config disagreeing on ONE page is key drift: the SDK's precedence rule hides it, the gate does not", () => {
  const gate = evaluateCampaignIdentity({
    pages: [{ page_id: "checkout", file: "checkout.html", content: html({ apiKeyMeta: "keyB" }), scripts: [config("keyA")] }],
  });
  assert.equal(gate.status, "blocked");
  assert.deepEqual(kinds(gate), ["api_key_drift"]);
  assert.equal(gate.findings[0].code, CAMPAIGN_IDENTITY_KINDS.api_key_drift);
  assert.match(gate.findings[0].message, /checkout\.html has "keyB" \(meta name="next-api-key"\) but \.\/_site\/example\/config\.js has "keyA"/);
});

test("key drift across pages through two different config.js files names the two scripts", () => {
  const other = { ...config("keyB"), src: "/other/config.js", file: "./_site/other/config.js" };
  const gate = evaluateCampaignIdentity({
    pages: [
      { page_id: "checkout", file: "checkout.html", content: html(), scripts: [config("keyA")] },
      { page_id: "upsell-1", file: "upsell-1.html", content: html({ pageType: "upsell" }), scripts: [other] },
    ],
  });
  assert.deepEqual(kinds(gate), ["api_key_drift"]);
  assert.match(gate.findings[0].message, /example\/config\.js has "keyA".*other\/config\.js has "keyB"/);
});

test("the legacy nextCampaign.config({ apiKey }) spelling is compared like any other key source", () => {
  const gate = evaluateCampaignIdentity({
    pages: [
      { page_id: "checkout", content: html({ inline: 'nextCampaign.config({ apiKey: "keyA" })' }) },
      { page_id: "upsell-1", content: html({ pageType: "upsell", inline: 'window.nextConfig = { apiKey: "keyB" }' }) },
    ],
  });
  assert.deepEqual(kinds(gate), ["api_key_drift"]);
  assert.match(gate.findings[0].message, /nextCampaign\.config apiKey/);
});

test("funnel drift, a missing funnel under next-page-type, and attribution drift are each their own finding", () => {
  const gate = evaluateCampaignIdentity({
    pages: [
      { page_id: "checkout", file: "checkout.html", content: html({ funnel: "V2" }) },
      { page_id: "upsell-1", file: "upsell-1.html", content: html({ funnel: "V1A", pageType: "upsell" }) },
      { page_id: "receipt", file: "receipt.html", content: html({ funnel: null, pageType: "receipt" }) },
      { page_id: "upsell-2", file: "upsell-2.html", content: html({ funnel: "V2", pageType: "upsell", inline: 'next.setAttribution({ funnel: "V1A" })' }) },
    ],
  });
  assert.equal(gate.status, "blocked");
  assert.deepEqual(kinds(gate).sort(), ["attribution_drift", "funnel_drift", "funnel_missing"]);
  const byKind = Object.fromEntries(gate.findings.map((finding) => [finding.kind, finding]));
  assert.deepEqual([byKind.funnel_drift.a.file, byKind.funnel_drift.a.value, byKind.funnel_drift.b.file, byKind.funnel_drift.b.value], ["checkout.html", "V2", "upsell-1.html", "V1A"]);
  assert.deepEqual([byKind.funnel_missing.a.file, byKind.funnel_missing.b.value], ["receipt.html", "V2"]);
  assert.deepEqual([byKind.attribution_drift.a.value, byKind.attribution_drift.b.value], ["V2", "V1A"]);
  assert.equal(gate.required_actions.length, 1);
  assert.equal(gate.required_actions[0].kind, "edit");
});

test("many untagged SDK-bound pages produce one funnel_missing finding, not one per page", () => {
  const gate = evaluateCampaignIdentity({
    pages: [
      { page_id: "checkout", file: "checkout.html", content: html({ funnel: "V2" }) },
      { page_id: "upsell-1", file: "upsell-1.html", content: html({ funnel: null, pageType: "upsell" }) },
      { page_id: "upsell-2", file: "upsell-2.html", content: html({ funnel: null, pageType: "upsell" }) },
      { page_id: "receipt", file: "receipt.html", content: html({ funnel: null, pageType: "receipt" }) },
    ],
  });
  assert.deepEqual(kinds(gate), ["funnel_missing"]);
  assert.equal(gate.findings[0].a.file, "upsell-1.html");
  assert.match(gate.reason, /^1 campaign identity drift finding\(s\) across 4 built page\(s\) \(funnel_missing\); see findings\[\]/);
});

test("an empty next-api-key meta is no meta, on the record and in the comparison", () => {
  const identity = collectPageIdentity({ page_id: "checkout", content: '<html><head><meta name="next-api-key" content=""></head></html>' });
  assert.equal(identity.api_key_meta, null);
  assert.deepEqual(identity.api_keys, []);
});

test("externalScriptSources lists local and remote srcs in order and ignores commented-out tags", () => {
  const html = '<script src="/x/config.js"></script><!-- <script src="/x/old.js"></script> --><script>inline</script><script type="module" src="https://cdn.example/loader.js"></script>';
  assert.deepEqual(externalScriptSources(html), ["/x/config.js", "https://cdn.example/loader.js"]);
});

test("an untagged page's setAttribution is held to the campaign's funnel, so a borrowed script still fails", () => {
  const gate = evaluateCampaignIdentity({
    pages: [
      { page_id: "checkout", file: "checkout.html", content: html({ funnel: "V2" }) },
      { page_id: "faq", file: "faq.html", content: html({ funnel: null, pageType: null, inline: 'next.setAttribution({ funnel: "V1A" })' }) },
    ],
  });
  assert.deepEqual(kinds(gate), ["attribution_drift"]);
  assert.match(gate.findings[0].message, /in faq\.html disagrees with next-funnel "V2" in checkout\.html/);
});

test("presence is not asserted: pages with no key and no setAttribution anywhere pass on the funnel alone", () => {
  const gate = evaluateCampaignIdentity({
    pages: [
      { page_id: "checkout", content: html() },
      { page_id: "receipt", content: html({ pageType: "receipt" }) },
    ],
  });
  assert.equal(gate.status, "pass");
  assert.equal(gate.identity.api_key, null);
});

test("no pages is not_applicable, and parked pages alone are not_applicable with the skips named", () => {
  assert.equal(evaluateCampaignIdentity({ pages: [] }).status, "not_applicable");
  const gate = evaluateCampaignIdentity({ pages: [{ page_id: "checkout-old", route: "checkout-old", content: html() }] });
  assert.equal(gate.status, "not_applicable");
  assert.deepEqual(gate.pages_skipped, ["checkout-old"]);
});
