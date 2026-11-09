// Campaign Cart SDK 0.5 tolerance (campaign-cart v0.5.0). A campaign pinned to
// 0.5 writes a type="module" loader with data-campaign, the 0.5 checkout field
// names and data-next-field, and acceptUpsell / skipUpsell actions. Doctor and
// the static QA reads must take that page as it is, and keep judging a 0.4.x
// page exactly as before.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { AnalyticsContractShape } from "../campaign-spec/dist/rules/analytics-contract-shape.js";
import { REMOVED_IN_05, checkoutFieldSelector, checkoutFieldSelectors, isSdk05 } from "./campaign-cart-05.mjs";
import { collectPageIdentity, evaluateCampaignIdentity } from "./campaign-identity.mjs";
import { inspectCheckoutFields, loadCheckoutFieldContract } from "./campaign-ecosystem.mjs";
import { doctorBuiltOutput } from "./doctor/inspect.mjs";
import { observeBinding } from "./qa-binding-evidence.mjs";
import { UPSELL_ACTION_SPELLINGS } from "./qa-browser.mjs";
import { SDK_MARKUP, scanPageMarkup } from "./sdk-markup.mjs";
import { planSdkRepin } from "./sdk-repin.mjs";

const FIXTURE = resolve(new URL("../fixtures/sdk-05", import.meta.url).pathname);
const SLUG = "example-campaign";
const LOADER_05 = '<script type="module" src="https://cdn.jsdelivr.net/gh/NextCommerceCo/campaign-cart@v0.5.0/dist/loader.js" data-campaign="pk_example_sdk05" data-funnel="example"></script>';
const LOADER_04 = '<script src="https://cdn.jsdelivr.net/gh/NextCommerceCo/campaign-cart@v0.4.43/dist/loader.js"></script>';
const page = (loader, body) => ({ page_id: "p", file: "p.html", content: `<html><head>${loader}</head><body>${body}</body></html>` });
const codeNames = (scan) => scan.findings.map((item) => item.code_name).sort();

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-sdk-05-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- The 0.5 fixture through `doctor --built` --------------------------------

test("a 0.5 funnel (module loader, data-campaign, v2 fields, acceptUpsell) passes built doctor's SDK markup and identity gates", () => {
  const result = doctorBuiltOutput({ built: FIXTURE, slug: SLUG });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const sdkIssues = [...result.errors, ...result.warnings].filter((issue) => issue.code.startsWith(SDK_MARKUP) || issue.code.startsWith("built_output.campaign_identity"));
  assert.deepEqual(sdkIssues, []);
  const gate = result.derived.checkpoint_gates.find((entry) => entry.id === SDK_MARKUP);
  assert.equal(gate.status, "pass");
  assert.deepEqual(gate.unknown_attributes, [], "every 0.5 attribute the fixture writes is one 0.5 reads");
  assert.ok(result.ready.some((line) => /agree on campaign identity \(next-funnel "example", API key consistent\)/.test(line)), result.ready.join("\n"));
});

test("the fixture's checkout binds every field the checkout contract reads, as supported, on its 0.5 pin", () => {
  const contract = loadCheckoutFieldContract();
  const findings = [];
  const file = join(FIXTURE, "_site", SLUG, "checkout", "index.html");
  const result = inspectCheckoutFields(FIXTURE, [file], contract, findings, { sdkVersionForFile: () => ({ version: "0.5.0", source: "loader" }) });
  assert.deepEqual(findings, []);
  const values = result.bindings.map((entry) => entry.value).sort();
  assert.deepEqual(values, ["billing_same_as_shipping", "card.cvv", "card.expiry", "card.number", "city", "country", "email", "first_name", "last_name", "line1", "line2", "payment_method", "phone_number", "postcode", "state"]);
  assert.ok(result.bindings.every((entry) => entry.supported && entry.attribute === "data-next-field"));

  // The same file judged on a 0.4.x pin: data-next-field is not scanned.
  const legacy = inspectCheckoutFields(FIXTURE, [file], contract, [], { sdkVersionForFile: () => ({ version: "0.4.43", source: "loader" }) });
  assert.deepEqual(legacy.bindings, []);
});

// --- WRONG_FIELD_NAME ----------------------------------------------------------

const API_FIELDS = '<form data-next-checkout><input data-next-checkout-field="first_name"><input data-next-checkout-field="line1"><input data-next-checkout-field="line2"><input data-next-checkout-field="state"><input data-next-checkout-field="postcode"><input data-next-checkout-field="billing-postcode"></form>';

test("WRONG_FIELD_NAME: 0.5's API field names pass on a 0.5 pin and still block, naming the 0.4 name, on 0.4.43", () => {
  assert.deepEqual(codeNames(scanPageMarkup(page(LOADER_05, API_FIELDS))), []);
  const legacy = scanPageMarkup(page(LOADER_04, API_FIELDS));
  const wrong = legacy.findings.filter((item) => item.code_name === "WRONG_FIELD_NAME");
  assert.deepEqual(wrong.map((item) => [item.detail.value, item.detail.suggestion, item.detail.since]), [
    ["line1", "address1", "0.5.0"],
    ["line2", "address2", "0.5.0"],
    ["state", "province", "0.5.0"],
    ["postcode", "postal", "0.5.0"],
  ]);
  // Any billing- suffix passes on every version, as before.
  // The campaigns.json pin stands in when the page has no exact loader pin.
  assert.deepEqual(codeNames(scanPageMarkup({ ...page("", API_FIELDS), sdk_version: "0.5.0" })), []);
  assert.ok(isSdk05("0.5.0") && isSdk05("0.6.1") && !isSdk05("0.4.43") && !isSdk05("0.5.0-beta.1") && !isSdk05(null));
});

test("WRONG_FIELD_NAME: the hint for an unknown name is the 0.5 name on a 0.5 pin and the 0.4 name below it", () => {
  const zip = '<form data-next-checkout><input data-next-checkout-field="zip"></form>';
  const on05 = scanPageMarkup(page(LOADER_05, zip)).findings[0];
  assert.equal(on05.detail.suggestion, "postcode");
  assert.match(on05.message, /the SDK 0\.5\.0 maps \(the SDK spelling is "postcode"\)/);
  assert.equal(scanPageMarkup(page(LOADER_04, zip)).findings[0].detail.suggestion, "postal");
});

// --- REMOVED_IN_SDK_05 ----------------------------------------------------------

const REMOVED_MARKUP = `
<div data-next-upsell="offer"><button data-next-action="accept-upsell">Yes</button><select data-next-upsell-select></select><div data-next-upsell-option></div><input data-next-upsell-quantity></div>
<form data-next-checkout data-prospect-config="{}" data-min-phone-digits="7"><input data-email-field><input data-phone-field></form>
<script>window.nextConfig = { apiKey: "pk_x", googleMaps: { apiKey: "" } };
next.on("upsell:accepted", () => {}); next.on('cart:package-swapped', () => {}); next.on("order:redirect-missing", () => {});
next.on("address:messages-loaded", () => {}); push({ event: "dl_package_swapped" }); next.fomo();</script>`;

test("REMOVED_IN_SDK_05: every removed 0.4 feature warns once on a 0.5 pin, and never on 0.4.43", () => {
  const on05 = scanPageMarkup(page(LOADER_05, REMOVED_MARKUP));
  const removed = on05.findings.filter((item) => item.code_name === "REMOVED_IN_SDK_05");
  assert.deepEqual(removed.map((item) => item.detail.feature).sort(), REMOVED_IN_05.map((feature) => feature.id).sort());
  assert.ok(removed.every((item) => item.severity === "warning" && item.code === `${SDK_MARKUP}.removed_in_sdk_05`));
  assert.match(removed.find((item) => item.detail.feature === "accept_upsell_action").message, /data-next-action="accept-upsell" \(<button> on p\.html\) is a 0\.4\.x feature SDK 0\.5\.0 removed, and p\.html runs SDK 0\.5\.0 \(its loader pin\)/);

  const on04 = scanPageMarkup(page(LOADER_04, REMOVED_MARKUP));
  assert.deepEqual(on04.findings.filter((item) => item.code_name === "REMOVED_IN_SDK_05"), []);
});

test("REMOVED_IN_SDK_05: a removed call in a local script the page loads is found, and the scripts are read only on a 0.5 pin", () => {
  let reads = 0;
  const scripts = () => {
    reads += 1;
    return [{ src: "config.js", file: "_site/example-campaign/config.js", content: "window.nextConfig = { googleMaps: { apiKey: '' } };" }];
  };
  const on05 = scanPageMarkup({ ...page(LOADER_05, "<p>hi</p>"), scripts });
  assert.deepEqual(on05.findings.map((item) => [item.detail.feature, item.detail.seen]), [["google_maps", "_site/example-campaign/config.js"]]);
  assert.equal(reads, 1);
  scanPageMarkup({ ...page(LOADER_04, "<p>hi</p>"), scripts });
  assert.equal(reads, 1, "a 0.4.x page's scripts are never read");
});

test("doctor --built warns REMOVED_IN_SDK_05 for a googleMaps key in the campaign's config.js, without blocking", () => withTempDir((dir) => {
  cpSync(FIXTURE, dir, { recursive: true });
  const landing = join(dir, "_site", SLUG, "landing", "index.html");
  writeFileSync(landing, readFileSync(landing, "utf8").replace("<style>", '<script src="../config.js"></script><style>'));
  writeFileSync(join(dir, "_site", SLUG, "config.js"), "window.nextConfig = { googleMaps: { apiKey: '' } };\n");
  const result = doctorBuiltOutput({ built: dir, slug: SLUG });
  assert.equal(result.ok, true);
  const removed = result.warnings.filter((issue) => issue.code === `${SDK_MARKUP}.removed_in_sdk_05`);
  assert.equal(removed.length, 1);
  assert.match(removed[0].message, /nextConfig\.googleMaps \(in \.\/_site\/example-campaign\/config\.js\)/);
}));

// --- Campaign identity and QA binding: data-campaign ----------------------------

test("campaign identity reads the 0.5 loader's data-campaign and data-funnel, and blocks a page whose data-campaign drifts", () => {
  const identity = collectPageIdentity(page(LOADER_05, ""));
  assert.deepEqual(identity.api_keys.map((key) => [key.source, key.value]), [["loader data-campaign", "pk_example_sdk05"]]);
  assert.equal(identity.funnel, "example");
  // A 0.4 loader carries neither; the meta stays the funnel source.
  const legacy = collectPageIdentity(page(`${LOADER_04}<meta name="next-funnel" content="legacy">`, ""));
  assert.deepEqual(legacy.api_keys, []);
  assert.equal(legacy.funnel, "legacy");

  const borrowed = { page_id: "upsell", file: "upsell.html", content: `<html><head>${LOADER_05.replace("pk_example_sdk05", "pk_other_campaign")}</head><body></body></html>` };
  const gate = evaluateCampaignIdentity({ subject: {}, pages: [{ ...page(LOADER_05, ""), page_id: "checkout", file: "checkout.html" }, borrowed] });
  assert.equal(gate.status, "blocked");
  assert.deepEqual(gate.findings.map((finding) => finding.code), ["built_output.campaign_identity.api_key_drift"]);
});

test("QA binding evidence takes the 0.5 loader's data-campaign as the page's key", async () => {
  const html = `<!doctype html><html><head>${LOADER_05}</head><body></body></html>`;
  const observe = (value) => observeBinding({
    source: { ok: true, html },
    page: { url: "https://shop.example.test/example-campaign/checkout/" },
    expected: { value },
    scriptLoader: async () => ({ ok: false }),
  });
  const match = await observe("pk_example_sdk05");
  assert.equal(match.outcome, "match");
  assert.deepEqual(match.source_kinds, ["meta"]);
  assert.equal((await observe("pk_other")).outcome, "mismatch");
});

// --- QA selectors ----------------------------------------------------------------

test("QA's checkout field selectors take the 0.4 name, the API name and the 0.5 data-next-field key", () => {
  assert.deepEqual(checkoutFieldSelectors("address1"), [
    '[data-next-checkout-field="address1"]',
    '[data-next-checkout-field="line1"]',
    '[data-next-field="line1"]',
  ]);
  assert.deepEqual(checkoutFieldSelectors("cc-number"), ['[data-next-checkout-field="cc-number"]', '[data-next-field="card.number"]']);
  assert.deepEqual(checkoutFieldSelectors("phone"), ['[data-next-checkout-field="phone"]', '[data-next-checkout-field="phone_number"]', '[data-next-field="phone"]']);
  assert.equal(checkoutFieldSelector("billing-postal"), '[data-next-checkout-field="billing-postal"], [data-next-checkout-field="billing-postcode"], [data-next-address="billing"] [data-next-field="postcode"]');
  assert.equal(checkoutFieldSelector("email"), '[data-next-checkout-field="email"], [data-next-field="email"]');
});

test("QA's upsell spellings add 0.5's acceptUpsell and skipUpsell after the 0.4 spellings", () => {
  assert.deepEqual(UPSELL_ACTION_SPELLINGS, { accept: ["add", "accept", "acceptUpsell"], decline: ["skip", "decline", "skipUpsell"] });
});

// --- sdk repin: 0.4 → 0.5 --------------------------------------------------------

function staticRepo(dir, { loader, extra = "" }) {
  mkdirSync(join(dir, "funnel"), { recursive: true });
  writeFileSync(join(dir, "funnel", "index.html"), `<!doctype html><html><head>${loader}${extra}</head><body></body></html>\n`);
}

test("sdk repin refuses a 0.4 → 0.5 move while a loader is classic or a 0.4 dist file is referenced, and allows it once both are fixed", () => withTempDir((dir) => {
  staticRepo(dir, { loader: LOADER_04, extra: '<link rel="modulepreload" href="https://cdn.jsdelivr.net/gh/NextCommerceCo/campaign-cart@v0.4.43/dist/chunks/cart-abc.js">' });
  const refused = planSdkRepin({ targetRepo: dir, targetSdk: "0.5.0" });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, "refused_cross_minor");
  assert.deepEqual(refused.rewrites, []);
  assert.deepEqual(refused.blockers.map((blocker) => blocker.reason.split(":")[0]), ['loader <script> is not type="module"', "0.4 dist layout reference"]);

  // Within 0.4 nothing changes.
  assert.equal(planSdkRepin({ targetRepo: dir, targetSdk: "0.4.44" }).status, "changes");

  staticRepo(dir, { loader: LOADER_04.replace("<script ", '<script type="module" ') });
  const allowed = planSdkRepin({ targetRepo: dir, targetSdk: "0.5.0" });
  assert.equal(allowed.status, "changes");
  assert.equal(allowed.rewrites.length, 1);
}));

// --- CampaignSpec analytics -------------------------------------------------------

test("AnalyticsContractShape warns that providers blockedEvents and the custom provider do nothing on a 0.5 pin", () => {
  const spec = (sdkVersion) => ({
    runtime: { sdk_version: sdkVersion },
    analytics: { providers: { gtm: { enabled: true, containerId: "GTM-ABC", blockedEvents: ["dl_purchase"] }, custom: { enabled: true, endpoint: "https://collect.example.test" } } },
  });
  const checks = (version) => AnalyticsContractShape.check(spec(version)).map((violation) => violation.data.check).sort();
  assert.deepEqual(checks("0.5.0"), ["blocked-events-ignored-sdk-05", "custom-provider-ignored-sdk-05"]);
  assert.deepEqual(checks("0.4.43"), []);
});
