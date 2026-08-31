import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { createVerdict, validateVerdict, QA_ASSERTION_FAMILY_VOCABULARY } from "./qa-verdict.mjs";
import { projectVerdictForSidecar } from "./qa-sidecar.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const verdictSchema = JSON.parse(readFileSync(resolve(ROOT, "schemas/campaigns-os-qa-verdict.v0.schema.json"), "utf8"));
const sidecarSchema = JSON.parse(readFileSync(resolve(ROOT, "schemas/campaigns-os-qa-verdict-sidecar.v0.schema.json"), "utf8"));

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateVerdictSchema = ajv.compile(verdictSchema);
const validateSidecarSchema = ajv.compile(sidecarSchema);

const NOW = "2026-08-31T12:00:00.000Z";

// A realistic full verdict assembled through the real factory — the same
// createVerdict every qa run finalizes through — carrying live URLs and
// evidence exactly where real runs put them.
function emittedVerdict(overrides = {}) {
  const verdict = createVerdict({
    runId: "MSRSCHEMATEST00000000000000",
    mapId: "demo-map-abcd",
    publicRouteSlug: "demo",
    campaignRefId: 42,
    specVersion: "4.3",
    specHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    startedAt: "2026-08-31T11:00:00.000Z",
    completedAt: "2026-08-31T11:05:00.000Z",
    runtime: "campaigns-os-node-qa@0.0.0-test",
    operator: "someuser@local",
    baseUrl: "http://localhost:8788/demo/",
    entryUrls: [{ funnel_id: "main", funnel_name: "Demo", page_id: "landing", page_type: "landing", label: "Landing", url: "http://localhost:8788/demo/landing/" }],
    pageUrls: [
      { funnel_id: "main", page_id: "landing", page_type: "landing", label: "Landing", url: "http://localhost:8788/demo/landing/" },
      { funnel_id: "main", page_id: "checkout", page_type: "checkout", label: "Checkout", url: "http://localhost:8788/demo/checkout/" },
    ],
    testedUrls: [{ funnel_id: "main", page_id: "checkout", page_type: "checkout", label: "Checkout", url: "http://localhost:8788/demo/checkout/" }],
    assertions: [
      { id: "http:checkout", family: "funnel-flow", page: "checkout", url: "http://localhost:8788/demo/checkout/", status: "pass", expected: "2xx HTTP response", actual: "200" },
      {
        id: "meta:checkout:next-success-url",
        family: "meta-tags",
        page: "checkout",
        url: "http://localhost:8788/demo/checkout/",
        status: "fail",
        severity: "blocker",
        expected: "/demo/receipt/",
        actual: "/receipt",
        evidence: { request_url: "https://api.example.com/v1/orders?key=sk_secret" },
      },
      { id: "browser-console-errors:landing", family: "browser-runtime", page: "landing", status: "manual_review", expected: "clean browser runtime", actual: "1 console warning" },
    ],
    testOrders: [{
      path: "checkout",
      ok: true,
      next_order_id: "1234",
      ref_id: "abc-ref",
      qa_email: "[redacted-qa-email]",
      is_test: true,
      payment_method: "card_token",
      card: { last4: "1117" },
      checkout_url: "http://localhost:8788/demo/checkout/",
      final_url: "http://localhost:8788/demo/receipt/?ref_id=abc-ref",
      cart_state: { packages: [] },
      receipt_line_items: [],
      vouchers: [],
      discount_total: null,
      verification: { verified: true, order_create_status: 201, order_read_status: 200, total_incl_tax: "19.99", currency: "USD", error: null },
      evidence: { order_request_seen: true, spreedly_tokenized: true, steps: [{ step: "opened_checkout", status: "ok", started_at: NOW, duration_ms: 12 }], events: { requests: [], responses: [], failed: [], console: [], pageErrors: [] } },
    }],
  });
  return { ...verdict, ...overrides };
}

function schemaErrors(validate) {
  return JSON.stringify(validate.errors, null, 2);
}

test("published schemas expose the v0 identities and the shared \"1.0\" schema_version literal", () => {
  assert.equal(verdictSchema.$id, "https://nextcommerce.com/schemas/campaigns-os-qa-verdict.v0.schema.json");
  assert.equal(sidecarSchema.$id, "https://nextcommerce.com/schemas/campaigns-os-qa-verdict-sidecar.v0.schema.json");
  // One schema_version, two files: the sidecar is a projection of the same
  // contract, never a second lineage — forking the literal would fork the
  // read end (src/qa-sidecar.mjs doctrine).
  assert.equal(verdictSchema.properties.schema_version.const, "1.0");
  assert.equal(sidecarSchema.properties.schema_version.const, "1.0");
  // The assertion family enum is the canonical vocabulary, not a hand copy
  // that can drift from the emitters.
  assert.deepEqual(
    verdictSchema.$defs.assertion.properties.family.enum,
    [...QA_ASSERTION_FAMILY_VOCABULARY],
  );
});

test("a verdict assembled by createVerdict validates against the full-verdict schema", () => {
  const verdict = emittedVerdict();
  assert.deepEqual(validateVerdict(verdict), []);
  assert.equal(validateVerdictSchema(verdict), true, schemaErrors(validateVerdictSchema));
});

test("every real qa-output verdict on disk validates against the full-verdict schema", (t) => {
  // qa-output/ is gitignored (full verdicts carry live URLs), so this leg is
  // ground-truth locally and a clean skip in CI where no runs exist.
  const outputRoot = resolve(ROOT, "qa-output");
  if (!existsSync(outputRoot)) {
    t.skip("no local qa-output/ directory");
    return;
  }
  const verdictFiles = [];
  for (const entry of readdirSync(outputRoot)) {
    const dir = join(outputRoot, entry);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      // Parity bundles live beside verdicts under qa-output/ and are a
      // different artifact; only verdict files are in scope here.
      if (!name.endsWith(".json") || name.endsWith(".parity-bundle.json")) continue;
      verdictFiles.push(join(dir, name));
    }
  }
  if (!verdictFiles.length) {
    t.skip("local qa-output/ holds no verdict files");
    return;
  }
  for (const file of verdictFiles) {
    const verdict = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(validateVerdictSchema(verdict), true, `${file}\n${schemaErrors(validateVerdictSchema)}`);
  }
});

test("the sidecar projection validates against both the sidecar schema and the full-verdict schema", () => {
  const projected = projectVerdictForSidecar(emittedVerdict(), { generatedAt: NOW });
  assert.equal(validateSidecarSchema(projected), true, schemaErrors(validateSidecarSchema));
  // Same schema ("1.0"): the projection stays readable by any full-verdict
  // consumer — the sidecar schema only pins what the projection additionally
  // guarantees (emptied URL-bearing fields, generated_at).
  assert.equal(validateVerdictSchema(projected), true, schemaErrors(validateVerdictSchema));
});

test("the sidecar schema rejects URL-bearing leaks the projection guarantees are gone", () => {
  const projected = projectVerdictForSidecar(emittedVerdict(), { generatedAt: NOW });

  const withBaseUrl = { ...projected, base_url: "http://localhost:8788/demo/" };
  assert.equal(validateSidecarSchema(withBaseUrl), false, "base_url must be impossible in a sidecar");

  const withEntryUrls = { ...projected, entry_urls: [{ page_id: "landing", url: "http://localhost:8788/demo/landing/" }] };
  assert.equal(validateSidecarSchema(withEntryUrls), false, "non-empty entry_urls must be impossible in a sidecar");

  const withAssertionUrl = {
    ...projected,
    assertions: [{ ...projected.assertions[0], url: "http://localhost:8788/demo/checkout/" }],
  };
  assert.equal(validateSidecarSchema(withAssertionUrl), false, "assertion url must be impossible in a sidecar");

  const withTrustStamp = { ...projected, trusted: false, trust_level: "anonymous", verified_at: null };
  assert.equal(validateSidecarSchema(withTrustStamp), false, "receiver trust stamps must be impossible in a sidecar");
});

// ── The forged-verdict negative control (campaigns-os#260) ──────────────────
// A forged, shape-valid verdict stamped untrusted by the readback receiver.
// (a) It PASSES schema and shape validation — shape validity is not trust.
// (b) The readback tooling still segregates it: the sidecar projection
//     refuses it, so it cannot be laundered into the committed artifact
//     campaigns-agent reads (run-record inference exclusion is proven at the
//     CLI level in src/run-record.test.mjs).
test("negative control: a forged untrusted verdict is shape-valid but refused by the sidecar projection", () => {
  const forged = emittedVerdict({
    run_id: "FORGEDRUN000000000000000000",
    disposition: "ready",
    assertions: [
      { id: "http:checkout", family: "funnel-flow", page: "checkout", url: "https://evil.example/checkout/", status: "pass", expected: "2xx HTTP response", actual: "200" },
    ],
    exceptions: [],
    // The stamps the receiver adds to a stored anonymous submission.
    trusted: false,
    trust_level: "anonymous",
    verified_at: null,
    _stored_at: NOW,
    _payload_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
  });

  // (a) Shape validity is not trust.
  assert.equal(validateVerdictSchema(forged), true, schemaErrors(validateVerdictSchema));
  assert.deepEqual(validateVerdict(forged), []);

  // (b) The committed-readback chokepoint refuses it, loudly and by name.
  assert.throws(
    () => projectVerdictForSidecar(forged, { generatedAt: NOW }),
    /trusted: false/,
  );

  // A genuine record — no stamp (fresh local emission) or a verified stamp —
  // still projects.
  const local = emittedVerdict();
  assert.equal(validateSidecarSchema(projectVerdictForSidecar(local, { generatedAt: NOW })), true);
  const verified = emittedVerdict({ trusted: true, trust_level: "shared_secret", verified_at: NOW });
  assert.equal(validateSidecarSchema(projectVerdictForSidecar(verified, { generatedAt: NOW })), true);
});
