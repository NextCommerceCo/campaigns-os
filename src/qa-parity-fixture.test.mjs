import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { loadParityFixture, validateParityFixture } from "./qa-parity-fixture.mjs";

const fixturePath = fileURLToPath(new URL("../fixtures/parity/heyshape-snatched-sdk04.json", import.meta.url));

function validFixture() {
  return {
    schema_version: "1",
    campaign: { name: "Fixture Campaign", slug: "fixture-campaign", shadow_campaign_ids: { root: 1 } },
    candidate_base_url: "https://example.test",
    sdk_version: "0.4.30",
    gtm_container_id: "GTM-FIXTURE",
    api_key_env: "QA_CAMPAIGNS_API_KEY",
    voucher_codes: ["FIXTURE_VOUCHER"],
    scenarios: [{
      scenario_id: "root-offer",
      scenario_type: "funnel_offer",
      shadow_campaign: "root",
      shadow_campaign_id: 1,
      offer: "offer",
      funnel_path: "accept",
      voucher_code: "FIXTURE_VOUCHER",
      currency: "USD",
      expected_order_readback: {
        line_item: {
          title: "Fixture Product",
          quantity: 1,
          is_upsell: true,
          price_field: "price_incl_tax",
          base_unit_price: 10,
          base_subtotal: 10,
          expected_line_total: 8,
        },
      },
      expected_purchase: { event: "dl_purchase", value: 8, currency: "USD" },
    }],
    expected_analytics: {
      purchase_event: "dl_purchase",
      purchase_expected: true,
      candidate_inventory: { gtm: ["GTM-FIXTURE"] },
    },
    known_good_disposition: "ready_with_exceptions",
  };
}

test("loadParityFixture loads and validates the HeyShape SDK-0.4 corpus", async () => {
  const fixture = await loadParityFixture(fixturePath);

  assert.equal(fixture.campaign.shadow_campaign_ids.root, 1712);
  assert.equal(fixture.campaign.shadow_campaign_ids.v1, 1714);
  assert.equal(fixture.api_key_env, "QA_CAMPAIGNS_API_KEY");
  assert.equal(fixture.scenarios.length, 3);
  assert.equal(fixture.scenarios[0].expected_order_readback.line_item.expected_line_total, 45);
  assert.equal(fixture.scenarios[0].expected_order_readback.line_item.dropped_voucher_line_total, 90);
  assert.deepEqual(fixture.scenarios[2].expected_pricing.map((entry) => entry.expected_total), [29.99, 53.98, 71.97]);
  assert.deepEqual(validateParityFixture(fixture), []);
});

test("validateParityFixture reports required-field failures", () => {
  const fixture = validFixture();
  fixture.campaign.name = "";
  delete fixture.candidate_base_url;
  fixture.campaign.shadow_campaign_ids.root = 0;

  const errors = validateParityFixture(fixture);
  assert.ok(errors.includes("campaign.name: required non-empty string"));
  assert.ok(errors.includes("candidate_base_url: required non-empty string"));
  assert.ok(errors.includes("campaign.shadow_campaign_ids.root: must be a positive integer"));
});

test("validateParityFixture requires at least one scenario", () => {
  const fixture = validFixture();
  fixture.scenarios = [];

  assert.ok(validateParityFixture(fixture).includes("scenarios: must contain at least one scenario"));
});

test("validateParityFixture rejects non-numeric funnel and ladder prices", () => {
  const fixture = validFixture();
  fixture.scenarios[0].expected_order_readback.line_item.expected_line_total = "8.00";
  fixture.scenarios.push({
    scenario_id: "ladder",
    scenario_type: "pricing_ladder",
    shadow_campaign: "root",
    shadow_campaign_id: 1,
    offer: "offer",
    currency: "USD",
    expected_pricing: [{ quantity: 1, expected_total: null }],
  });

  const errors = validateParityFixture(fixture);
  assert.ok(errors.includes("scenarios[0].expected_order_readback.line_item.expected_line_total: must be a non-negative finite number"));
  assert.ok(errors.includes("scenarios[1].expected_pricing[0].expected_total: must be a non-negative finite number"));
});

test("validateParityFixture rejects an inlined API key", () => {
  const fixture = validFixture();
  fixture.api_key = "literal-secret-value";

  assert.ok(validateParityFixture(fixture).includes(
    "api_key: literal values are forbidden; supply credentials at runtime via api_key_env or CLI",
  ));
});

test("validateParityFixture rejects nested and aliased literal credentials", () => {
  const fixture = validFixture();
  fixture.runtime = {
    nested: [{ token: "literal-token" }],
    vendor_api_key: "literal-api-key",
  };

  const errors = validateParityFixture(fixture);
  assert.ok(errors.includes(
    "runtime.nested[0].token: literal values are forbidden; supply credentials at runtime via api_key_env or CLI",
  ));
  assert.ok(errors.includes(
    "runtime.vendor_api_key: literal values are forbidden; supply credentials at runtime via api_key_env or CLI",
  ));
});

test("validateParityFixture rejects conventional credential aliases in any casing", () => {
  const fixture = validFixture();
  fixture.integrations = {
    client_secret: "literal-secret",
    accessToken: "literal-token",
    "vendor-api-key": "literal-key",
    private_key: "-----BEGIN KEY-----",
  };

  const errors = validateParityFixture(fixture);
  for (const key of ["client_secret", "accessToken", "vendor-api-key", "private_key"]) {
    assert.ok(errors.includes(
      `integrations.${key}: literal values are forbidden; supply credentials at runtime via api_key_env or CLI`,
    ), `expected rejection for ${key}`);
  }
});

test("validateParityFixture rejects literal values smuggled through _env alias keys", () => {
  const fixture = validFixture();
  fixture.integrations = {
    client_secret_env: "literal-secret",
    accessTokenEnv: "literal token value",
    "private-key-env": "-----BEGIN KEY-----",
  };

  const errors = validateParityFixture(fixture);
  for (const key of ["client_secret_env", "accessTokenEnv", "private-key-env"]) {
    assert.ok(errors.includes(
      `integrations.${key}: must name an environment variable (UPPER_SNAKE), not carry a literal value`,
    ), `expected env-name rejection for ${key}`);
  }
  const legit = validFixture();
  legit.integrations = { client_secret_env: "VENDOR_CLIENT_SECRET" };
  assert.deepEqual(validateParityFixture(legit), []);
});

test("validateParityFixture allows environment indirection and null credential fields", () => {
  const fixture = validFixture();
  fixture.api_key_env = "QA_CAMPAIGNS_API_KEY";
  fixture.api_key = null;

  assert.deepEqual(validateParityFixture(fixture), []);
});

test("validateParityFixture rejects an undeclared shadow campaign name", () => {
  const fixture = validFixture();
  fixture.scenarios[0].shadow_campaign = "missing";

  assert.ok(validateParityFixture(fixture).includes(
    "scenarios[0].shadow_campaign: must reference campaign.shadow_campaign_ids",
  ));
});

test("validateParityFixture rejects a shadow campaign id mismatch", () => {
  const fixture = validFixture();
  fixture.scenarios[0].shadow_campaign_id = 2;

  assert.ok(validateParityFixture(fixture).includes(
    "scenarios[0].shadow_campaign_id: must match campaign.shadow_campaign_ids.root",
  ));
});

test("validateParityFixture rejects an undeclared voucher", () => {
  const fixture = validFixture();
  fixture.scenarios[0].voucher_code = "UNKNOWN_VOUCHER";

  assert.ok(validateParityFixture(fixture).includes(
    "scenarios[0].voucher_code: must be listed in voucher_codes",
  ));
});

test("validateParityFixture rejects invalid constrained string values", () => {
  const cases = [
    ["schema_version", "2", "schema_version: unsupported version; expected 1"],
    ["candidate_base_url", "ftp://example.test", "candidate_base_url: must be a valid http(s) URL"],
    ["sdk_version", "0.4", "sdk_version: must match MAJOR.MINOR.PATCH"],
    ["gtm_container_id", "GTM-invalid", "gtm_container_id: must match GTM-[A-Z0-9]+"],
    ["known_good_disposition", "unknown", "known_good_disposition: must be ready, ready_with_exceptions, or blocked"],
  ];

  for (const [field, value, expectedError] of cases) {
    const fixture = validFixture();
    fixture[field] = value;
    assert.ok(validateParityFixture(fixture).includes(expectedError), field);
  }
});

test("validateParityFixture reports scenario and analytics shape failures", () => {
  const fixture = validFixture();
  fixture.scenarios[0].scenario_type = "unknown";
  fixture.expected_analytics.purchase_expected = "yes";
  fixture.expected_analytics.candidate_inventory.gtm = [];

  const errors = validateParityFixture(fixture);
  assert.ok(errors.includes("scenarios[0].scenario_type: must be funnel_offer or pricing_ladder"));
  assert.ok(errors.includes("expected_analytics.purchase_expected: must be a boolean"));
  assert.ok(errors.includes("expected_analytics.candidate_inventory.gtm: must be a non-empty string array"));
});

test("validateParityFixture rejects non-object input", () => {
  assert.deepEqual(validateParityFixture(null), ["fixture: must be an object"]);
});
