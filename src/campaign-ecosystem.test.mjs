import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createStandardizationReport,
  formatStandardizationReportMarkdown,
} from "./standardization-report.mjs";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-ecosystem-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(path, body) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

function checkoutHtml({ sdkVersion, provinceField, postalField, paymentSyncScript = false }) {
  return `<!doctype html>
<html>
<head>
  <meta name="next-campaign-id" content="1234">
  <script>
    window.nextConfig = {
      apiKey: "test-api-key",
      campaignId: 1234,
    };
  </script>
  <script src="https://cdn.jsdelivr.net/gh/NextCommerceCo/campaign-cart@v${sdkVersion}/dist/loader.js" type="module"></script>
</head>
<body>
  <form>
    <input data-next-checkout-field="email" type="email">
    <input data-next-checkout-field="fname">
    <input data-next-checkout-field="lname">
    <input data-next-checkout-field="address1">
    <input data-next-checkout-field="city">
    <select data-next-checkout-field="${provinceField}"></select>
    <input data-next-checkout-field="${postalField}">
    <select data-next-checkout-field="country"></select>
    <div data-next-checkout-field="cc-number"></div>
    <div data-next-checkout-field="cvv"></div>
    <select data-next-checkout-field="cc-month"></select>
    <select data-next-checkout-field="cc-year"></select>
  </form>
  <div class="payopt on" data-pay="credit">
    <input type="radio" name="payment_method" value="credit" checked style="display:none;">
  </div>
  <div class="payopt" data-pay="paypal">
    <input type="radio" name="payment_method" value="paypal" style="display:none;">
  </div>
  <button data-next-action="checkout">Complete order</button>
  ${paymentSyncScript ? '<script src="/checkout/payment-methods.js"></script>' : ""}
</body>
</html>
`;
}

const PAYMENT_SYNC_SCRIPT = `(function () {
  document.querySelectorAll("[data-pay]").forEach(function (trigger) {
    trigger.addEventListener("click", function () {
      var option = trigger.closest(".payopt");
      var radio = option && option.querySelector('input[name="payment_method"]');
      if (!radio) return;
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
})();
`;

function writeCampaignCartAppFixture(root, {
  sdkVersion = "0.4.24",
  provinceField = "state",
  postalField = "postal_code",
  paymentSyncScript = false,
} = {}) {
  write(join(root, "package.json"), JSON.stringify({
    name: "quiz-funnel-app",
    type: "module",
    scripts: { dev: "vite", build: "vite build" },
    dependencies: { express: "^4.19.0", react: "^18.3.0" },
    devDependencies: { vite: "^5.4.0" },
  }, null, 2));
  write(join(root, "vite.config.ts"), "export default {};\n");
  write(join(root, "server", "index.ts"), "// express app entry\n");
  write(join(root, "client", "public", "checkout", "index.html"), checkoutHtml({
    sdkVersion,
    provinceField,
    postalField,
    paymentSyncScript,
  }));
  write(join(root, "client", "public", "checkout", "thank-you.html"), `<!doctype html>
<html><body>
  <div data-next-display="order.number">Order</div>
</body></html>
`);
  if (paymentSyncScript) {
    write(join(root, "client", "public", "checkout", "payment-methods.js"), PAYMENT_SYNC_SCRIPT);
  }
}

function writeUnrelatedAppFixture(root) {
  write(join(root, "package.json"), JSON.stringify({
    name: "plain-dashboard",
    scripts: { dev: "vite" },
    dependencies: { express: "^4.19.0" },
    devDependencies: { vite: "^5.4.0" },
  }, null, 2));
  write(join(root, "client", "index.html"), `<!doctype html>
<html><body>
  <form action="/subscribe" method="post">
    <input name="email" type="email">
    <select name="state"></select>
    <input name="postal_code">
    <button type="submit">Subscribe</button>
  </form>
</body></html>
`);
  write(join(root, "server", "index.ts"), "// express app entry\n");
}

function writePageKitFixture(root) {
  write(join(root, "package.json"), JSON.stringify({
    scripts: { build: "campaign-build" },
    dependencies: { "next-campaign-page-kit": "^0.1.1" },
  }, null, 2));
  write(join(root, "_data", "campaigns.json"), JSON.stringify({
    acme: { name: "Acme Funnel", sdk_version: "0.4.25", store_url: "https://acme.example/" },
  }, null, 2));
  write(join(root, "src", "acme", "checkout.html"), `
<section>
  <form data-next-checkout="form">
    <div data-next-package-id="1"></div>
  </form>
</section>
`);
}

const codes = (root) => root.findings.map((finding) => finding.code);
const findingByCode = (root, code) => root.findings.find((finding) => finding.code === code);

test("campaign cart application root is discovered and classified without Page Kit markers", () => {
  withTempDir((dir) => {
    writeCampaignCartAppFixture(dir);

    const report = createStandardizationReport({ targetRepo: dir });
    assert.equal(report.summary.root_count, 1);
    assert.equal(report.errors.length, 0);

    const [root] = report.roots;
    assert.equal(root.implementation.kind, "campaign_cart_app");
    assert.ok(root.implementation.evidence.some((entry) => entry.signal === "campaign_cart_loader"));
    assert.ok(root.capabilities.includes("checkout_field_contract"));
    assert.ok(!codes(root).includes("page_kit.campaigns_json_missing"));
  });
});

test("original funnel: loader version discovered and evaluated against the SDK support policy", () => {
  withTempDir((dir) => {
    writeCampaignCartAppFixture(dir, { sdkVersion: "0.4.24" });

    const report = createStandardizationReport({ targetRepo: dir });
    const [root] = report.roots;

    assert.deepEqual(root.identity.sdk_versions, ["0.4.24"]);
    assert.equal(root.sdk_loader.references.length, 1);
    assert.match(root.sdk_loader.references[0].url, /campaign-cart@v0\.4\.24/);

    assert.equal(root.version_policy.evaluations.length, 1);
    assert.equal(root.version_policy.evaluations[0].meets_preferred, false);
    const finding = findingByCode(root, "version.sdk_below_preferred_policy");
    assert.ok(finding, "expected version.sdk_below_preferred_policy finding");
    assert.equal(finding.confidence, "static_contract");
  });
});

test("original funnel: stale checkout field aliases are blockers with canonical replacements", () => {
  withTempDir((dir) => {
    writeCampaignCartAppFixture(dir, { provinceField: "state", postalField: "postal_code" });

    const report = createStandardizationReport({ targetRepo: dir });
    const [root] = report.roots;

    assert.equal(report.status, "blocked");
    const finding = findingByCode(root, "checkout.unsupported_field_binding");
    assert.ok(finding, "expected checkout.unsupported_field_binding finding");
    assert.equal(finding.severity, "blocker");
    assert.equal(finding.confidence, "static_contract");
    const matches = finding.evidence.map((entry) => entry.value).sort();
    assert.deepEqual(matches, ["postal_code", "state"]);
    const replacements = finding.evidence.map((entry) => entry.canonical).sort();
    assert.deepEqual(replacements, ["postal", "province"]);

    assert.equal(root.checkout_fields.unsupported.length, 2);
    assert.ok(root.checkout_fields.bindings.some((entry) => entry.value === "email" && entry.supported));
  });
});

test("original funnel: custom payment controls need behavioral proof, not a static failure claim", () => {
  withTempDir((dir) => {
    writeCampaignCartAppFixture(dir, { paymentSyncScript: false });

    const report = createStandardizationReport({ targetRepo: dir });
    const [root] = report.roots;

    assert.equal(root.payment.sdk_method_radios.detected, true);
    assert.equal(root.payment.custom_triggers.detected, true);
    assert.equal(root.payment.synchronization_script.detected, false);
    assert.equal(root.payment.proof_state, "runtime_proof_required");

    const finding = findingByCode(root, "payment.custom_controls_proof_required");
    assert.ok(finding, "expected payment.custom_controls_proof_required finding");
    assert.equal(finding.severity, "warning");
    assert.equal(finding.confidence, "runtime_proof_required");
    assert.doesNotMatch(finding.message, /broken|failed/i);
  });
});

test("repaired funnel: supported fields, policy-clean SDK, and improved payment evidence stay honest", () => {
  withTempDir((dir) => {
    writeCampaignCartAppFixture(dir, {
      sdkVersion: "0.4.30",
      provinceField: "province",
      postalField: "postal",
      paymentSyncScript: true,
    });

    const report = createStandardizationReport({ targetRepo: dir });
    const [root] = report.roots;

    assert.notEqual(report.status, "blocked");
    assert.deepEqual(root.identity.sdk_versions, ["0.4.30"]);
    assert.equal(root.version_policy.evaluations[0].meets_preferred, true);
    assert.ok(!codes(root).includes("version.sdk_below_preferred_policy"));
    assert.ok(!codes(root).includes("checkout.unsupported_field_binding"));
    assert.equal(root.checkout_fields.unsupported.length, 0);

    assert.equal(root.payment.synchronization_script.detected, true);
    const finding = findingByCode(root, "payment.custom_controls_proof_required");
    assert.ok(finding, "payment behavior remains unproven until browser QA runs");
    assert.equal(finding.severity, "operator_readiness");
    assert.equal(finding.confidence, "runtime_proof_required");
  });
});

test("unrelated application is not classified as a campaign", () => {
  withTempDir((dir) => {
    writeUnrelatedAppFixture(dir);

    const report = createStandardizationReport({ targetRepo: dir });
    assert.equal(report.summary.root_count, 0);
    assert.equal(report.status, "blocked");
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].code, "campaign.root_not_found");
  });
});

test("page kit roots keep their behavior and gain an implementation classification", () => {
  withTempDir((dir) => {
    writePageKitFixture(join(dir, "funnel-cpk"));

    const report = createStandardizationReport({ targetRepo: dir });
    assert.equal(report.summary.root_count, 1);

    const [root] = report.roots;
    assert.equal(root.implementation.kind, "page_kit");
    assert.equal(root.identity.campaign_slugs[0].slug, "acme");
    assert.ok(root.capabilities.includes("page_kit_source_contract"));
  });
});

test("a parent repo can hold a page kit root and a campaign cart application side by side", () => {
  withTempDir((dir) => {
    writePageKitFixture(join(dir, "funnel-cpk"));
    writeCampaignCartAppFixture(join(dir, "quiz-app"), { sdkVersion: "0.4.30", provinceField: "province", postalField: "postal" });

    const report = createStandardizationReport({ targetRepo: dir });
    assert.equal(report.summary.root_count, 2);
    const kinds = report.roots.map((root) => root.implementation.kind).sort();
    assert.deepEqual(kinds, ["campaign_cart_app", "page_kit"]);
  });
});

test("SDK support policy is injectable", () => {
  withTempDir((dir) => {
    writeCampaignCartAppFixture(dir, { sdkVersion: "0.4.24" });

    const report = createStandardizationReport({
      targetRepo: dir,
      sdkSupportPolicy: {
        minimum_supported: "0.4.25",
        preferred_minimum: "0.4.99",
        source: "test-policy",
      },
    });
    const [root] = report.roots;
    assert.ok(codes(root).includes("version.sdk_below_minimum_supported"));
    assert.equal(root.version_policy.source, "test-policy");
  });
});

test("markdown output renders campaign cart application roots", () => {
  withTempDir((dir) => {
    writeCampaignCartAppFixture(dir);
    const report = createStandardizationReport({ targetRepo: dir });
    const markdown = formatStandardizationReportMarkdown(report);
    assert.match(markdown, /Implementation: campaign_cart_app/);
    assert.match(markdown, /Checkout Fields/);
    assert.match(markdown, /0\.4\.24/);
  });
});

test("scanning does not mutate the target repository", () => {
  withTempDir((dir) => {
    writeCampaignCartAppFixture(dir);
    const before = snapshot(dir);
    createStandardizationReport({ targetRepo: dir });
    assert.deepEqual(snapshot(dir), before);
  });
});

function snapshot(dir) {
  const entries = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else entries[path] = `${statSync(path).size}:${readFileSync(path, "utf8").length}`;
    }
  };
  walk(dir);
  return entries;
}
