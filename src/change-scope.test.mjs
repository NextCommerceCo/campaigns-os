import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BUILD_CHANGES_LIMIT,
  campaignConfigFingerprint,
  changeSince,
  classifyDrift,
  mapLinkedAssets,
  nextBuildChanges,
  pageCommerceFacts,
  routePageIdForUrl,
  worseChangeKind,
} from "./change-scope.mjs";
import {
  applyPageOnlyChangeToCheckpoint,
  applyPageOnlyChangeToPolishGate,
  carriedForwardMessage,
  isPageOnlyCarry,
  polishCarriedForwardForLadder,
} from "./local-preview-policy.mjs";
import { evaluatePolishGate } from "./polish-gate.mjs";
import { capturePolishPageLoad, evaluateRecordedHiddenEagerMediaCheckpoint } from "./polish-node.mjs";

const UPSELL = `<!doctype html><html><head><meta name="next-page-type" content="upsell"><meta name="next-upsell-accept-url" content="../receipt/">
<script src="https://cdn.example.test/campaign-cart@0.4.40/loader.js"></script><script>window.nextConfig = { debug: false };</script></head>
<body><h1 class="hero">Add a second bottle</h1><img src="bottle.png" alt="Bottle"><p style="color: red">Only today.</p>
<div data-next-package-id="12" data-next-shipping-id="3"><a href="../receipt/" data-next-upsell-action="skip">No thanks</a></div></body></html>`;

test("the commerce signature ignores copy, images and styling, and reads every commerce-bearing change", () => {
  const base = pageCommerceFacts(UPSELL);
  assert.equal(base.page_type, "upsell");
  for (const edit of [
    ["copy", "Add a second bottle", "Add a third bottle"],
    ["image", 'src="bottle.png"', 'src="bottle-2.png"'],
    ["styling", 'class="hero"', 'class="hero hero--large"'],
    ["inline style", "color: red", "color: blue"],
  ]) {
    assert.equal(pageCommerceFacts(UPSELL.replace(edit[1], edit[2])).signature, base.signature, `${edit[0]} keeps the signature`);
  }
  for (const edit of [
    ["package ref", 'data-next-package-id="12"', 'data-next-package-id="14"'],
    ["shipping ref", 'data-next-shipping-id="3"', 'data-next-shipping-id="4"'],
    ["upsell order", 'content="../receipt/"', 'content="../upsell2/"'],
    ["SDK pin", "campaign-cart@0.4.40", "campaign-cart@0.4.41"],
    ["inline script", "debug: false", "debug: true"],
    ["route", 'href="../receipt/"', 'href="../thanks/"'],
    ["page type", 'content="upsell"', 'content="checkout"'],
    ["inline event handler", "<h1 class=\"hero\">", "<h1 class=\"hero\" onclick=\"next.addUpsell({ packageId: 99 })\">"],
    ["checkout binding", "<h1 class=\"hero\">", "<h1 class=\"hero\" os-checkout-field=\"email\">"],
  ]) {
    assert.notEqual(pageCommerceFacts(UPSELL.replace(edit[1], edit[2])).signature, base.signature, `${edit[0]} changes the signature`);
  }
  // Checkout or payment markup makes a page a checkout page whatever its type.
  assert.equal(base.checkout, false);
  for (const marker of ['data-next-checkout="form"', 'data-next-payment-method="card"', 'data-next-express-checkout="paypal"', 'os-checkout-payment="combo"']) {
    assert.equal(pageCommerceFacts(UPSELL.replace("<h1 class=\"hero\">", `<h1 class="hero" ${marker}>`)).checkout, true, marker);
  }
  assert.equal(pageCommerceFacts(UPSELL.replace("<h1 class=\"hero\">", '<h1 class="hero" data-next-checkout-review-note="x" data-next-checkoutish="x">')).checkout, true);
  assert.equal(pageCommerceFacts(UPSELL.replace("<h1 class=\"hero\">", '<h1 class="hero" data-next-checkoutish="x">')).checkout, false);
});

test("worseChangeKind ranks none, page_only, commerce_affecting, unknown", () => {
  assert.equal(["page_only", "none", "commerce_affecting", "page_only"].reduce(worseChangeKind, "none"), "commerce_affecting");
  assert.equal(worseChangeKind("page_only", "unknown"), "unknown");
  assert.equal(worseChangeKind("page_only", "bogus"), "unknown");
  assert.equal(worseChangeKind("none", "page_only"), "page_only");
});

test("routePageIdForUrl derives the id the change lists use", () => {
  assert.equal(routePageIdForUrl("http://127.0.0.1:4000/merchant/upsell-1/", "http://127.0.0.1:4000/merchant/"), "upsell-1");
  assert.equal(routePageIdForUrl("http://127.0.0.1:4000/merchant/", "http://127.0.0.1:4000/merchant/"), "index");
  assert.equal(routePageIdForUrl("http://127.0.0.1:4000/merchant/offers/upsell.html", "http://127.0.0.1:4000/merchant/"), "offers-upsell");
});

test("classifyDrift reads a page-only drift and names every commerce reason", (t) => {
  const root = mkdtempSync(join(tmpdir(), "change-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outputRoot = join(root, "_site", "merchant");
  mkdirSync(join(outputRoot, "upsell"), { recursive: true });
  mkdirSync(join(root, "_data"), { recursive: true });
  writeFileSync(join(root, "_data", "campaigns.json"), JSON.stringify({ merchant: { sdk_version: "0.4.40" } }));
  writeFileSync(join(outputRoot, "upsell", "index.html"), UPSELL.replace("second", "third"));
  const page = { page_id: "upsell", built_path: "upsell/index.html" };
  const known = (overrides = {}) => ({ status: "known", changed_pages: [page], unmapped_files: [], extra: [], missing: [], ...overrides });
  const baseline = (overrides = {}) => ({ commerce_signature: {
    algorithm: "commerce-signature/v1",
    campaign_config: campaignConfigFingerprint(root, "merchant"),
    pages: { "upsell/index.html": pageCommerceFacts(UPSELL).signature },
    ...overrides,
  } });
  const classify = (changes, assembly) => classifyDrift({ changes, baseline: assembly, outputRoot, targetRepo: root, publicRouteSlug: "merchant" });
  assert.deepEqual(classify(known(), baseline()), { kind: "page_only", reasons: [] });
  assert.deepEqual(classify(known({ changed_pages: [] }), baseline()), { kind: "none", reasons: [] });
  assert.deepEqual(classify({ status: "unknown" }, baseline()), { kind: "unknown", reasons: [] });
  assert.deepEqual(classify(known({ unmapped_files: ["assets/app.js"] }), baseline()).reasons, [{ code: "unmapped_file", path: "assets/app.js" }]);
  assert.deepEqual(classify(known({ extra: ["upsell/index.html"] }), baseline()).reasons, [{ code: "page_added", path: "upsell/index.html" }]);
  assert.deepEqual(classify(known({ missing: ["upsell/index.html"] }), baseline()).reasons, [{ code: "page_removed", path: "upsell/index.html" }]);
  assert.deepEqual(classify(known(), {}).reasons, [{ code: "commerce_signature_unavailable" }], "a record from before signatures cannot classify");
  assert.deepEqual(classify(known(), baseline({ pages: {} })).reasons, [{ code: "commerce_signature_unavailable", path: "upsell/index.html" }]);
  assert.deepEqual(classify(known(), baseline({ campaign_config: "sha256:other" })).reasons, [{ code: "campaign_config_changed" }]);
  writeFileSync(join(outputRoot, "upsell", "index.html"), UPSELL.replace('data-next-package-id="12"', 'data-next-package-id="13"'));
  assert.deepEqual(classify(known(), baseline()).reasons, [{ code: "commerce_markup_changed", path: "upsell/index.html" }]);
  writeFileSync(join(outputRoot, "upsell", "index.html"), UPSELL.replace('content="upsell"', 'content="checkout"'));
  assert.deepEqual(classify(known(), baseline()).reasons, [{ code: "checkout_page", path: "upsell/index.html" }]);
  // A checkout page on a free-form route with no page-type meta is still a
  // checkout page: its checkout markup says so, and a copy edit owes full QA.
  const freeForm = (html) => html.replace(/<meta name="next-page-type"[^>]*>/, "")
    .replace("<h1 class=\"hero\">", "<form data-next-checkout=\"form\"><button type=\"submit\">Pay</button></form><h1 class=\"hero\">");
  writeFileSync(join(outputRoot, "upsell", "index.html"), freeForm(UPSELL).replace("second", "third"));
  assert.deepEqual(classify(known(), baseline({ pages: { "upsell/index.html": pageCommerceFacts(freeForm(UPSELL)).signature } })).reasons,
    [{ code: "checkout_page", path: "upsell/index.html" }]);
  // An inline handler that calls the SDK is commerce markup.
  writeFileSync(join(outputRoot, "upsell", "index.html"), UPSELL.replace("<h1 class=\"hero\">", "<h1 class=\"hero\" onclick=\"next.addUpsell({ packageId: 99 })\">"));
  assert.deepEqual(classify(known(), baseline()).reasons, [{ code: "commerce_markup_changed", path: "upsell/index.html" }]);
});

test("build history: each stage walks back to the build it reviewed, or reads unknown", () => {
  const entry = (from, to, kind, pages) => ({ from_build_fingerprint: from, build_fingerprint: to, recorded_at: "2026-10-30T00:00:00Z", kind,
    changed_pages: pages.map((id) => ({ page_id: id, built_path: `${id}/index.html` })), unmapped_files: [], unmapped_file_count: 0, reasons: [] });
  const none = { status: "known", changed_pages: [], unmapped_files: [] };
  let history = nextBuildChanges([], entry("A", "B", "page_only", ["upsell"]), ["A"]);
  history = nextBuildChanges(history, entry("B", "C", "page_only", ["landing"]), ["A", "B"]);
  assert.deepEqual(history.map((item) => item.build_fingerprint), ["B", "C"]);
  const assembly = { build_fingerprint: "C", build_changes: history };
  const fromA = changeSince("A", { assembly, drift: none, driftClassification: { kind: "none", reasons: [] } });
  assert.equal(fromA.kind, "page_only");
  assert.deepEqual(fromA.changed_pages.map((page) => page.page_id), ["landing", "upsell"]);
  const fromB = changeSince("B", { assembly, drift: none, driftClassification: { kind: "none", reasons: [] } });
  assert.deepEqual(fromB.changed_pages.map((page) => page.page_id), ["landing"]);
  assert.equal(changeSince("Z", { assembly, drift: none, driftClassification: { kind: "none", reasons: [] } }).kind, "unknown");
  assert.equal(changeSince("A", { assembly, drift: { status: "unknown" } }).kind, "unknown", "unreadable drift is unknown");
  // One commerce rebuild in the walk makes the whole change commerce.
  const commerce = { build_fingerprint: "D", build_changes: [...history, entry("C", "D", "commerce_affecting", ["checkout"])] };
  assert.equal(changeSince("A", { assembly: commerce, drift: none, driftClassification: { kind: "none", reasons: [] } }).kind, "commerce_affecting");
  // Once both stages reviewed C, the older entries are dropped.
  assert.deepEqual(nextBuildChanges(history, entry("C", "D", "page_only", ["receipt"]), ["C"]).map((item) => item.build_fingerprint), ["D"]);
  // With no stage anchored anywhere, nothing is kept.
  assert.deepEqual(nextBuildChanges(history, entry("C", "D", "page_only", ["receipt"]), [null]), []);
  let long = [];
  for (let index = 0; index < BUILD_CHANGES_LIMIT + 5; index += 1) long = nextBuildChanges(long, entry(`b${index}`, `b${index + 1}`, "page_only", ["upsell"]), ["b0"]);
  assert.equal(long.length, BUILD_CHANGES_LIMIT, "the kept history is bounded");
});

// The hidden eager-media checkpoint and the Polish gate, carried for a
// page-only change: record build moved the build past the captured page load
// and made Polish required.
const BUILD_A = `sha256:${"a".repeat(64)}`;
const BUILD_B = `sha256:${"b".repeat(64)}`;
const packet = {
  schema_version: "campaign-runtime-build-packet/v0",
  campaign: { public_route_slug: "merchant", route_root: "/merchant/" },
  spec: { map_id: "map-test" },
  assembly: { target_repo: "." },
  source_html: { pages: [{ page_id: "landing", path: "landing.html", page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" } }] },
};
const reportAt = (build) => ({
  schema_version: "campaign-runtime-assembly-report/v0",
  identity: { map_id: "map-test", public_route_slug: "merchant", spec_hash: `sha256:${"c".repeat(64)}` },
  stages: {
    assembly: { stage: "assembly", status: "completed", build_fingerprint: build },
    polish: { stage: "polish", status: "pending", evidence: { visual_review: { screenshots: [] } } },
  },
  waivers: [],
});

async function capturedAtA() {
  const report = reportAt(BUILD_A);
  const captured = await capturePolishPageLoad({
    packet, report, baseUrl: "https://shop.example.test",
    createBrowserAdapter: async () => ({
      async captureRoute({ url, viewport }) {
        return { finalDocumentUrl: url, responseCollectionStatus: "complete", networkidle: { status: "settled", duration_ms: 12 }, mediaElements: [],
          responses: [{ request_id: `document-${viewport.key}`, url, resource_type: "Document", status: 200, mime_type: "text/html", encoded_data_length: 1_024,
            is_final_main_document: true, document_context_fingerprint: `sha256:${"d".repeat(64)}` }] };
      },
      async close() {},
    }),
  });
  return captured.page_load;
}

test("a page-only change carries stale Polish evidence as advisory; other blocks stay blocks", async () => {
  const pageLoad = await capturedAtA();
  const rebuilt = reportAt(BUILD_B);
  rebuilt.stages.polish = { stage: "polish", status: "required", required_by: "build", owed_since_build_fingerprint: BUILD_A,
    evidence: { visual_review: { screenshots: [], page_load: pageLoad } } };
  const stale = evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report: rebuilt });
  assert.equal(stale.code, "polish.hidden_eager_media.capture_stale");
  const advisory = { polish: { advisory: true } };

  assert.equal(applyPageOnlyChangeToCheckpoint(stale, { polish: { advisory: false } }), stale, "a full change keeps the block");
  const checkpoint = applyPageOnlyChangeToCheckpoint(stale, advisory);
  assert.ok(isPageOnlyCarry(checkpoint));
  assert.equal(checkpoint.carried_forward.evidence, "stale", "the capture exists, for an older build");
  assert.match(carriedForwardMessage(checkpoint), /^Advisory for a page-only change: /);

  const gate = evaluatePolishGate({ report: rebuilt, hiddenEagerMediaGate: checkpoint });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.evidence_missing");
  const carried = applyPageOnlyChangeToPolishGate(gate, { debt: advisory, checkpointGate: checkpoint });
  assert.ok(isPageOnlyCarry(carried));
  assert.equal(carried.carried_forward.evidence, "missing", "no Polish review was recorded");
  assert.equal(polishCarriedForwardForLadder(rebuilt, carried), true, "next does not stop on advisory Polish, page load recorded or not");
  assert.equal(applyPageOnlyChangeToPolishGate(gate, { debt: advisory, checkpointGate: stale }).status, "blocked",
    "a checkpoint block that was not carried keeps Polish blocked");

  const blocked = structuredClone(rebuilt);
  blocked.stages.polish.status = "blocked";
  const blockedGate = evaluatePolishGate({ report: blocked, hiddenEagerMediaGate: checkpoint });
  assert.equal(blockedGate.code, "polish.blocked");
  assert.equal(applyPageOnlyChangeToPolishGate(blockedGate, { debt: advisory, checkpointGate: checkpoint }).status, "blocked",
    "a Polish recorded as blocked is a finding, not stale evidence");
});

// #753: a stylesheet or image built pages link directly maps to those pages.
test("mapLinkedAssets maps a linked stylesheet and image to the pages that link them, and nothing else", (t) => {
  const root = mkdtempSync(join(tmpdir(), "linked-assets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const siteRoot = join(root, "_site");
  const output = join(siteRoot, "synthetic-campaign");
  const files = {
    "landing/index.html": '<!doctype html><html><head><link rel="stylesheet" href="../css/landing.css"><link rel="Alternate StyleSheet" href="/synthetic-campaign/css/alt.css"></head><body><img src="../img/hero.png" alt=""><img srcset="../img/a.webp 1x, ../img/b,c.webp 2x" alt=""><template><img src="../img/template.png"></template><noscript><img src="../img/noscript.png"></noscript></body></html>',
    "checkout/index.html": '<!doctype html><html><head><meta name="next-page-type" content="checkout"><base href="/synthetic-campaign/"><link rel="stylesheet" href="css/shared.css"></head><body><form data-next-checkout="form"></form></body></html>',
    "upsell1/index.html": '<!doctype html><html><head><meta name="next-page-type" content="upsell"><link rel="stylesheet" href="/css/shared.css"><link rel="preload" href="../css/preloaded.css"><script src="../js/app.js"></script><img src="../js/app.js"></head><body></body></html>',
    "css/landing.css": "@import url(imported.css);\nh1 { color: red }\n",
    "css/imported.css": "h1 { margin: 0 }\n",
    "css/alt.css": "", "css/shared.css": "", "css/preloaded.css": "", "css/unlinked.css": "",
    "img/hero.png": "", "img/a.webp": "", "img/b,c.webp": "", "img/template.png": "", "img/noscript.png": "", "js/app.js": "",
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(output, path, ".."), { recursive: true });
    writeFileSync(join(output, path), body);
  }
  const pages = ["checkout", "landing", "upsell1"].map((id) => ({ page_id: id, built_path: join(output, id, "index.html") }));
  const changed = ["css/alt.css", "css/imported.css", "css/landing.css", "css/preloaded.css", "css/shared.css", "css/unlinked.css",
    "img/a.webp", "img/b,c.webp", "img/gone.png", "img/hero.png", "img/noscript.png", "img/template.png", "js/app.js"];
  // A deleted image the landing page still names maps too.
  writeFileSync(join(output, "landing", "index.html"), files["landing/index.html"].replace("</body>", '<img src="../img/gone.png"></body>'));
  const page = (id) => ({ page_id: id, built_path: `${id}/index.html` });
  const mapped = mapLinkedAssets({ files: changed, pages, outputRoot: output, siteRoot });
  assert.deepEqual(mapped.linked, [
    { path: "css/alt.css", pages: [page("landing")] },
    { path: "css/landing.css", pages: [page("landing")] },
    // Resolved against <base href> on checkout; root-served /css/ falls back to the campaign directory.
    { path: "css/shared.css", pages: [page("checkout"), page("upsell1")] },
    { path: "img/a.webp", pages: [page("landing")] },
    { path: "img/b,c.webp", pages: [page("landing")] },
    { path: "img/gone.png", pages: [page("landing")] },
    { path: "img/hero.png", pages: [page("landing")] },
  ]);
  assert.deepEqual(mapped.unmapped, ["css/imported.css", "css/preloaded.css", "css/unlinked.css", "img/noscript.png", "img/template.png", "js/app.js"],
    "@import is not followed; preload, template and noscript are not links; a script an <img> names stays a script");

  // classifyDrift: the pages a linked asset reaches are page-only, a checkout
  // or upsell page among them owes a browser run, and the asset is named.
  const known = { status: "known", changed_pages: [], unmapped_files: [], extra: [], missing: [] };
  const linked = mapped.linked.filter((asset) => asset.path === "css/landing.css");
  assert.deepEqual(classifyDrift({ changes: known, baseline: { commerce_signature: { algorithm: "commerce-signature/v1", campaign_config: "unavailable:x", pages: {} } }, outputRoot: output, linkedAssets: linked }).kind,
    "commerce_affecting", "the config reasons still apply");
  mkdirSync(join(root, "_data"));
  writeFileSync(join(root, "_data", "campaigns.json"), JSON.stringify({ "synthetic-campaign": { sdk_version: "0.4.40" } }));
  const signature = { algorithm: "commerce-signature/v1", campaign_config: campaignConfigFingerprint(root, "synthetic-campaign"), pages: {} };
  const classify = (assets, changes = known) => classifyDrift({ changes, baseline: { commerce_signature: signature }, outputRoot: output, targetRepo: root, publicRouteSlug: "synthetic-campaign", linkedAssets: assets });
  assert.deepEqual(classify(linked), { kind: "page_only", reasons: [{ code: "linked_asset_changed", path: "css/landing.css", pages: ["landing"] }] });
  const shared = mapped.linked.filter((asset) => asset.path === "css/shared.css");
  assert.deepEqual(classify(shared), { kind: "page_only", reasons: [
    { code: "linked_asset_buy_page", path: "checkout/index.html" },
    { code: "linked_asset_buy_page", path: "upsell1/index.html" },
    { code: "linked_asset_changed", path: "css/shared.css", pages: ["checkout", "upsell1"] },
  ] });
  // The checkout's own markup changed too: that still owes the full stages.
  assert.deepEqual(classify(shared, { ...known, changed_pages: [page("checkout")] }), { kind: "commerce_affecting", reasons: [
    { code: "checkout_page", path: "checkout/index.html" },
    { code: "linked_asset_buy_page", path: "upsell1/index.html" },
    { code: "linked_asset_changed", path: "css/shared.css", pages: ["checkout", "upsell1"] },
  ] });
  assert.deepEqual(classify([], { ...known, unmapped_files: ["css/unlinked.css"] }),
    { kind: "commerce_affecting", reasons: [{ code: "unmapped_file", path: "css/unlinked.css" }] }, "an unlinked asset stays commerce");
});
