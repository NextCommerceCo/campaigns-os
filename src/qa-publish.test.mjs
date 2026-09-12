import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePublishVerdict, qaResolveNextProofLines } from "./qa-node.mjs";

test("qa resolve names the next proof command when a base URL is known", () => {
  const lines = qaResolveNextProofLines({
    map_id: "shw-round-2",
    packet_path: "/tmp/campaign-runtime.build.json",
    base_url: "http://localhost:4173/simple-home-watch/",
    entry_urls: [
      {
        funnel_id: "default",
        page_id: "presell",
        page_type: "presell",
        url: "http://localhost:4173/simple-home-watch/presell/",
      },
    ],
  });

  assert.match(lines[0], /Next expected proof:/);
  assert.match(lines[0], /campaigns-os qa run --packet \/tmp\/campaign-runtime\.build\.json/);
  assert.match(lines[0], /--browser --test-order common/);
  assert.match(lines[1], /Entry URL\(s\) resolved:/);
  assert.match(lines[1], /\/simple-home-watch\/presell\//);
  assert.match(lines[2], /publishes to the portal by default/);
});

test("qa resolve asks for a tested URL before browser and typed-card proof", () => {
  const lines = qaResolveNextProofLines({
    map_id: "shw-round-2",
    base_url: null,
  });

  assert.match(lines[0], /provide --base-url/);
  assert.match(lines[0], /--browser --test-order common/);
  assert.match(lines[1], /Localhost on any port/);
  assert.match(lines[1], /non-localhost preview\/production origins still need SDK origin allowlist/);
});

test("qa resolve preserves custom proxy base in the next proof command", () => {
  const lines = qaResolveNextProofLines({
    map_id: "shw-round-2",
    proxy_base: "https://campaign-map.example.test/qa proxy",
    spec_source: "https://campaign-map.example.test/qa%20proxy/api/spec/shw-round-2",
    base_url: "https://preview.example.test/simple-home-watch/",
  });

  assert.match(lines[0], /campaigns-os qa run shw-round-2/);
  assert.match(lines[0], /--proxy-base 'https:\/\/campaign-map\.example\.test\/qa proxy'/);
  assert.match(lines[0], /--base-url https:\/\/preview\.example\.test\/simple-home-watch\//);
  assert.match(lines[0], /--browser --test-order common/);
});

// #172: the default verdict POST must sit inside the telemetry consent seam.
// Consent off (CAMPAIGNS_OS_TELEMETRY=off) ⇒ local-only verdict for
// non-portal-managed runs, with the destination and opt-in flag named.
// Portal-managed campaigns (spec resolved from the portal) keep
// publish-by-default; explicit flags always win.

const CONSENT_ON = { state: "on", source: "default", resolved: true };
const CONSENT_OFF = { state: "off", source: "env", resolved: true };

test("consent off makes a non-portal run local-only", () => {
  const decision = decidePublishVerdict({ args: {}, portalManaged: false, consent: CONSENT_OFF });
  assert.equal(decision.publish, false);
  assert.equal(decision.reason, "consent_off");
});

test("portal-managed campaigns keep publish-by-default even with consent off", () => {
  const decision = decidePublishVerdict({ args: {}, portalManaged: true, consent: CONSENT_OFF });
  assert.equal(decision.publish, true);
  assert.equal(decision.reason, "portal_managed_default");
});

test("explicit --post-verdict opts in past consent off", () => {
  const decision = decidePublishVerdict({ args: { "post-verdict": true }, portalManaged: false, consent: CONSENT_OFF });
  assert.equal(decision.publish, true);
  assert.equal(decision.reason, "flag_opt_in");
});

test("explicit opt-out wins over portal-managed default", () => {
  const decision = decidePublishVerdict({ args: { "no-post-verdict": true }, portalManaged: true, consent: CONSENT_ON });
  assert.equal(decision.publish, false);
  assert.equal(decision.reason, "flag_opt_out");
});

test("consent on keeps the existing publish-by-default shape", () => {
  const decision = decidePublishVerdict({ args: {}, portalManaged: false, consent: CONSENT_ON });
  assert.equal(decision.publish, true);
  assert.equal(decision.reason, "default");
});

test("missing consent stays publish-by-default (legacy shape, never fail-open on garbage)", () => {
  assert.equal(decidePublishVerdict({ args: {}, portalManaged: false, consent: null }).publish, true);
});

test("garbage --post-verdict is never a silent opt-in: chain continues, flag_invalid surfaces", () => {
  const withConsentOff = decidePublishVerdict({ args: { "post-verdict": "banana" }, portalManaged: false, consent: CONSENT_OFF });
  assert.equal(withConsentOff.publish, false);
  assert.equal(withConsentOff.reason, "consent_off");
  assert.equal(withConsentOff.flag_invalid, true);

  const withConsentOn = decidePublishVerdict({ args: { "post-verdict": "banana" }, portalManaged: false, consent: CONSENT_ON });
  assert.equal(withConsentOn.publish, true);
  assert.equal(withConsentOn.reason, "default");
  assert.equal(withConsentOn.flag_invalid, true);
});

test("--post-verdict true-ish strings opt in explicitly", () => {
  assert.equal(decidePublishVerdict({ args: { "post-verdict": "true" }, portalManaged: false, consent: CONSENT_OFF }).publish, true);
  assert.equal(decidePublishVerdict({ args: { "post-verdict": "on" }, portalManaged: false, consent: CONSENT_OFF }).reason, "flag_opt_in");
});

test("--post-verdict false-ish strings and --local-only opt out explicitly", () => {
  for (const value of ["false", "0", "no", "n", "off"]) {
    const decision = decidePublishVerdict({ args: { "post-verdict": value }, portalManaged: true, consent: CONSENT_ON });
    assert.equal(decision.publish, false);
    assert.equal(decision.reason, "flag_opt_out");
  }
  const localOnly = decidePublishVerdict({ args: { "local-only": true }, portalManaged: true, consent: CONSENT_ON });
  assert.equal(localOnly.publish, false);
  assert.equal(localOnly.reason, "flag_opt_out");
});
