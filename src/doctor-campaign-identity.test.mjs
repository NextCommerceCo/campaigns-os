// Doctor wiring for the cross-page campaign identity gate (#301).
//
// The evaluator's own cases are in campaign-identity.test.mjs. These cover
// what the issue turns on: the three committed fixture trees (clean, key
// drift, attribution drift) through the real `doctor --built` entry point, the
// funnel rules, that parked copies are skipped and named, that the gate is
// reached with no packet and no family, and that it is not waivable.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { CAMPAIGN_IDENTITY, CAMPAIGN_IDENTITY_KINDS, evaluateCampaignIdentity } from "./campaign-identity.mjs";
import { validateCampaignIdentity } from "./doctor/checks.mjs";
import { doctorBuiltOutput } from "./doctor/inspect.mjs";

const FIXTURE_ROOT = resolve(new URL("../fixtures/campaign-identity", import.meta.url).pathname);
const SLUG = "example-campaign";
const codes = (issues) => issues.map((issue) => issue.code);

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-campaign-identity-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePage(repo, route, html) {
  const dir = route ? join(repo, "_site", SLUG, route) : join(repo, "_site", SLUG);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
}

function writeConfig(repo, apiKey) {
  mkdirSync(join(repo, "_site", SLUG), { recursive: true });
  writeFileSync(join(repo, "_site", SLUG, "config.js"), `window.nextConfig = {\n  apiKey: "${apiKey}",\n};\n`);
}

function head({ funnel = "Example V2", pageType = "checkout", apiKeyMeta = null, config = true } = {}) {
  return [
    config ? `<script src="/${SLUG}/config.js"></script>` : "",
    apiKeyMeta ? `<meta name="next-api-key" content="${apiKeyMeta}">` : "",
    funnel ? `<meta name="next-funnel" content="${funnel}">` : "",
    pageType ? `<meta name="next-page-type" content="${pageType}">` : "",
  ].join("");
}

function page(headHtml, bodyHtml = "") {
  return `<html><head>${headHtml}</head><body>${bodyHtml}</body></html>`;
}

function gateOf(result) {
  return (result.derived?.checkpoint_gates || []).find((gate) => gate.id === CAMPAIGN_IDENTITY) || null;
}

function fixture(name) {
  return doctorBuiltOutput({ built: join(FIXTURE_ROOT, name), slug: SLUG });
}

// --- The committed fixture trees ---------------------------------------------

test("#301 clean fixture: three pages sharing one config.js and one funnel pass", () => {
  const result = fixture("clean");
  assert.equal(result.ok, true);
  const gate = gateOf(result);
  assert.equal(gate.status, "pass");
  assert.equal(gate.pages_scanned, 3);
  assert.equal(gate.identity.funnel, "Example V2");
  // The key is read out of the shared config.js the pages load, not the page.
  assert.match(gate.identity.api_key, /^examplekeyA+$/);
  assert.match(gate.identity.api_key_source, /config\.js nextConfig\.apiKey/);
  assert.ok(result.derived.doctor_checks.includes(CAMPAIGN_IDENTITY));
  assert.ok(result.ready.some((note) => /agree on campaign identity/.test(note)), "a pass emits a ready line");
});

test("doctor compares a built config key with the campaign key when the packet carries one", () => {
  withTempDir((repo) => {
    writeConfig(repo, "examplebuiltkey");
    writePage(repo, "checkout", page(head()));
    const packet = { campaign: { public_route_slug: SLUG, campaigns_api_key: "examplecampaignkey" } };
    const errors = [], ready = [];
    const derived = { target_repo: repo, checkpoint_gates: [] };
    validateCampaignIdentity(packet, errors, ready, derived);
    assert.deepEqual(codes(errors), [CAMPAIGN_IDENTITY_KINDS.api_key_mismatch]);
    assert.match(errors[0].message, /config\.js.*Campaigns API key/);

    writeConfig(repo, "examplecampaignkey");
    const matching = [];
    validateCampaignIdentity(packet, matching, [], { target_repo: repo, checkpoint_gates: [] });
    assert.deepEqual(matching, []);
  });
});

test("mismatch names every distinct wrong key source and the pages loading it alongside drift", () => {
  const built = (page_id, file, key) => ({
    page_id,
    file: `${page_id}/index.html`,
    content: '<html><script src="config.js"></script></html>',
    scripts: [{ src: "config.js", file, content: `window.nextConfig = { apiKey: "${key}" };` }],
  });
  const gate = evaluateCampaignIdentity({
    expectedApiKey: { key: "examplecampaignkey", source: "CampaignSpec campaign.campaigns_api_key" },
    pages: [
      built("checkout", "shared/config.js", "examplecampaignkey"),
      built("upsell-1", "borrowed/config.js", "examplewrongone"),
      built("upsell-2", "borrowed/config.js", "examplewrongone"),
      built("receipt", "receipt/config.js", "examplewrongtwo"),
    ],
  });
  assert.deepEqual(gate.findings.map((finding) => finding.kind), ["api_key_drift", "api_key_mismatch"]);
  const mismatch = gate.findings[1];
  assert.match(mismatch.message, /borrowed\/config\.js.*upsell-1\/index\.html.*upsell-2\/index\.html/);
  assert.match(mismatch.message, /receipt\/config\.js.*receipt\/index\.html/);
  assert.doesNotMatch(mismatch.message, /shared\/config\.js/);
  assert.equal(mismatch.message.match(/examplewrongone/g)?.length, 1);
  assert.equal(mismatch.message.match(/examplewrongtwo/g)?.length, 1);
  assert.match(gate.required_actions[0].description, /borrowed\/config\.js, receipt\/config\.js/);
});

function mismatchOnlyGate() {
  return evaluateCampaignIdentity({
    expectedApiKey: { key: "examplecampaignkey", source: "Build Packet campaign.campaigns_api_key" },
    pages: ["checkout", "receipt"].map((page_id) => ({
      page_id,
      file: `${page_id}/index.html`,
      content: '<html><script src="config.js"></script></html>',
      scripts: [{ src: "config.js", file: "shared/config.js", content: 'window.nextConfig = { apiKey: "examplebuiltkey" };' }],
    })),
  });
}

test("a mismatch alone points the repair at the key source and names its loading pages", () => {
  const gate = mismatchOnlyGate();
  assert.deepEqual(gate.findings.map((finding) => finding.kind), ["api_key_mismatch"]);
  assert.match(gate.findings[0].message, /shared\/config\.js.*checkout\/index\.html.*receipt\/index\.html/);
});

test("a mismatch alone gives a mismatch reason and a replacement action", () => {
  const gate = mismatchOnlyGate();
  assert.match(gate.reason, /API key mismatch/);
  assert.doesNotMatch(gate.reason, /drift/);
  assert.match(gate.required_actions[0].description, /Replace the built key in shared\/config\.js.*rebuild/);
  assert.doesNotMatch(gate.required_actions[0].description, /Make every page name the same campaign/);
});

test("doctor compares a built key with the CampaignSpec key source", () => {
  withTempDir((repo) => {
    writeConfig(repo, "examplebuiltkey");
    writePage(repo, "checkout", page(head()));
    const errors = [];
    validateCampaignIdentity(
      { campaign: { public_route_slug: SLUG } }, errors, [],
      { target_repo: repo, checkpoint_gates: [] },
      { campaign: { campaigns_api_key: "examplecampaignkey" } },
    );
    assert.deepEqual(codes(errors), [CAMPAIGN_IDENTITY_KINDS.api_key_mismatch]);
    assert.match(errors[0].message, /CampaignSpec.*campaign\.campaigns_api_key/);
  });
});

test("doctor compares a built key with a declared env key only when that variable is set", () => {
  withTempDir((repo) => {
    writeConfig(repo, "examplebuiltkey");
    writePage(repo, "checkout", page(head()));
    const packet = { campaign: { public_route_slug: SLUG, api_key_source: "env:CAMPAIGNS_API_KEY" } };
    const previous = process.env.CAMPAIGNS_API_KEY;
    try {
      process.env.CAMPAIGNS_API_KEY = "examplecampaignkey";
      const errors = [];
      validateCampaignIdentity(packet, errors, [], { target_repo: repo, checkpoint_gates: [] });
      assert.deepEqual(codes(errors), [CAMPAIGN_IDENTITY_KINDS.api_key_mismatch]);
      delete process.env.CAMPAIGNS_API_KEY;
      const unsetErrors = [];
      validateCampaignIdentity(packet, unsetErrors, [], { target_repo: repo, checkpoint_gates: [] });
      assert.deepEqual(unsetErrors, []);
    } finally {
      if (previous === undefined) delete process.env.CAMPAIGNS_API_KEY;
      else process.env.CAMPAIGNS_API_KEY = previous;
    }
  });
});

test("#301 key-drift fixture: a borrowed page's next-api-key meta blocks and names both files and both keys", () => {
  const result = fixture("key-drift");
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.deepEqual(codes(result.errors), [CAMPAIGN_IDENTITY_KINDS.api_key_drift]);

  const issue = result.errors[0];
  assert.match(issue.message, /config\.js has "examplekeyA+" \(.*nextConfig\.apiKey\)/);
  assert.match(issue.message, /upsell-1\/index\.html has "examplekeyB+" \(meta name="next-api-key"\)/);
  assert.equal(issue.detail.checkpoint_gate.id, CAMPAIGN_IDENTITY);
  assert.equal(gateOf(result).status, "blocked");
  assert.equal(gateOf(result).code, CAMPAIGN_IDENTITY);
});

test("#301 attribution-drift fixture: a setAttribution call from another funnel blocks and names the call and the tag", () => {
  const result = fixture("attribution-drift");
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.errors), [CAMPAIGN_IDENTITY_KINDS.attribution_drift]);
  const issue = result.errors[0];
  assert.match(issue.message, /setAttribution\(\{ funnel: "Example V1A" \}\) in \.\/_site\/example-campaign\/upsell-1\/index\.html/);
  assert.match(issue.message, /next-funnel "Example V2"/);
});

// --- The funnel rules ----------------------------------------------------------

test("next-funnel values that differ across pages block and name the two pages", () => {
  withTempDir((repo) => {
    writeConfig(repo, "examplekey");
    writePage(repo, "checkout", page(head({ funnel: "Example V2" })));
    writePage(repo, "upsell-1", page(head({ funnel: "Example V1A", pageType: "upsell" })));
    const result = doctorBuiltOutput({ built: repo, slug: SLUG });
    assert.deepEqual(codes(result.errors), [CAMPAIGN_IDENTITY_KINDS.funnel_drift]);
    assert.match(result.errors[0].message, /checkout\/index\.html has "Example V2" but \.\/_site\/example-campaign\/upsell-1\/index\.html has "Example V1A"/);
  });
});

test("a drifting built page that no CampaignSpec page builds to is named as leftover output", () => {
  withTempDir((repo) => {
    writeConfig(repo, "examplekey");
    writePage(repo, "", page(head({ pageType: "product" })));
    writePage(repo, "checkout", page(head()));
    // A design export copied under assets/ builds as its own page and keeps
    // the design tool's funnel tag.
    writePage(repo, "assets/design", page(head({ funnel: "Design Mock", pageType: "product" })));
    const spec = {
      funnels: [{
        id: "main",
        pages: [
          { id: "landing", type: "landing", page_url: "/" },
          { id: "checkout", type: "checkout", page_url: "checkout/" },
        ],
      }],
    };
    const errors = [], ready = [];
    const derived = { target_repo: repo, checkpoint_gates: [] };
    validateCampaignIdentity({ campaign: { public_route_slug: SLUG } }, errors, ready, derived, spec);

    assert.deepEqual(codes(errors), [CAMPAIGN_IDENTITY_KINDS.funnel_drift]);
    assert.match(errors[0].message, /assets\/design\/index\.html is not the built page of any CampaignSpec page/);
    assert.match(errors[0].message, /^\.?\/?_site\/example-campaign\/assets\/design\/index\.html is not the built page/, "the stray repair leads");
    assert.match(errors[0].message, /delete the built file, then rebuild/);
    assert.match(errors[0].message, /What it causes: next-funnel differs across pages: .*\.$/);
    assert.deepEqual(errors[0].detail.finding.stray_files.map((file) => file.replace(/^\.\//, "")), [`_site/${SLUG}/assets/design/index.html`]);

    // The stray carrying the only funnel tag turns the real pages into
    // "missing" ones; the lead still sends the agent to the stray, not to
    // retag the real page.
    writePage(repo, "", page(head({ funnel: null, pageType: "product" })));
    writePage(repo, "checkout", page(head({ funnel: null })));
    const missing = [];
    validateCampaignIdentity({ campaign: { public_route_slug: SLUG } }, missing, [], { target_repo: repo, checkpoint_gates: [] }, spec);
    assert.deepEqual(codes(missing), [CAMPAIGN_IDENTITY_KINDS.funnel_missing]);
    assert.match(missing[0].message, /^\.?\/?_site\/example-campaign\/assets\/design\/index\.html is not the built page/);
    assert.doesNotMatch(missing[0].message, /add the same next-funnel meta/, "the real page is not told to retag");
    assert.doesNotMatch(errors[0].message, /set the same <meta name="next-funnel"> on both/);

    // The stray supplies the only tag, and an untagged real page calls
    // setAttribution with another funnel: the stray still leads, rather than
    // the real page being told to change its call to the stray's funnel.
    writePage(repo, "checkout", page(head({ funnel: null, pageType: null }), `<script>next.setAttribution({ funnel: "Example V2" })</script>`));
    const attribution = [];
    validateCampaignIdentity({ campaign: { public_route_slug: SLUG } }, attribution, [], { target_repo: repo, checkpoint_gates: [] }, spec);
    const drift = attribution.find((issue) => issue.code === CAMPAIGN_IDENTITY_KINDS.attribution_drift);
    assert.ok(drift, "the call disagrees with the campaign's only tag");
    assert.match(drift.message, /^\.?\/?_site\/example-campaign\/assets\/design\/index\.html is not the built page/);
    assert.doesNotMatch(drift.message, /change the call to/);

    // Without a CampaignSpec the finding is unchanged: nothing says which
    // files are the campaign's pages.
    const bare = [];
    validateCampaignIdentity({ campaign: { public_route_slug: SLUG } }, bare, [], { target_repo: repo, checkpoint_gates: [] });
    assert.doesNotMatch(bare[0].message, /not the built page of any CampaignSpec page/);
    assert.equal(bare[0].detail.finding.stray_files, undefined);
  });
});

test("a page with next-page-type but no next-funnel blocks once another page carries the tag; a page with neither does not", () => {
  withTempDir((repo) => {
    writeConfig(repo, "examplekey");
    writePage(repo, "checkout", page(head({ funnel: "Example V2" })));
    writePage(repo, "receipt", page(head({ funnel: null, pageType: "receipt" })));
    // A plain content page carries no SDK bootstrap at all and owes no tag.
    writePage(repo, "faq", page(head({ funnel: null, pageType: null, config: false })));
    const result = doctorBuiltOutput({ built: repo, slug: SLUG });
    assert.deepEqual(codes(result.errors), [CAMPAIGN_IDENTITY_KINDS.funnel_missing]);
    assert.match(result.errors[0].message, /receipt\/index\.html declares next-page-type="receipt" but no <meta name="next-funnel">, while .*checkout\/index\.html carries "Example V2"/);
  });
});

test("a campaign that tags no page at all is consistent, not missing: presence is not asserted", () => {
  withTempDir((repo) => {
    writeConfig(repo, "examplekey");
    writePage(repo, "checkout", page(head({ funnel: null })));
    writePage(repo, "upsell-1", page(head({ funnel: null, pageType: "upsell" })));
    const result = doctorBuiltOutput({ built: repo, slug: SLUG });
    assert.equal(result.ok, true);
    assert.equal(gateOf(result).status, "pass");
    assert.equal(gateOf(result).identity.funnel, null);
  });
});

// --- Skips, reach, and non-waivability ---------------------------------------

test("parked *-backup-* and *-old-* copies are skipped and named, never scanned", () => {
  withTempDir((repo) => {
    writeConfig(repo, "examplekey");
    writePage(repo, "checkout", page(head({ funnel: "Example V2" })));
    writePage(repo, "upsell-1", page(head({ funnel: "Example V2", pageType: "upsell" })));
    writePage(repo, "upsell-1-backup-2", page(head({ funnel: "Other Funnel", pageType: "upsell", apiKeyMeta: "otherkey" })));
    writePage(repo, "checkout-old", page(head({ funnel: "Other Funnel" })));
    const result = doctorBuiltOutput({ built: repo, slug: SLUG });
    assert.equal(result.ok, true);
    const gate = gateOf(result);
    assert.equal(gate.status, "pass");
    assert.equal(gate.pages_scanned, 2);
    assert.deepEqual(gate.pages_skipped.sort(), [
      "./_site/example-campaign/checkout-old/index.html",
      "./_site/example-campaign/upsell-1-backup-2/index.html",
    ]);
    assert.ok(result.ready.some((note) => /skipped 2 parked page\(s\)/.test(note)));
  });
});

test("the gate fires with no packet, no assembly report and no template family", () => {
  withTempDir((repo) => {
    writePage(repo, "checkout", page(head({ funnel: "Example V2", apiKeyMeta: "keyA", config: false })));
    writePage(repo, "upsell-1", page(head({ funnel: "Example V2", pageType: "upsell", apiKeyMeta: "keyB", config: false })));
    const result = doctorBuiltOutput({ built: repo, slug: SLUG });
    assert.equal(result.ok, false);
    assert.equal(gateOf(result).status, "blocked");
    assert.ok(result.derived.doctor_checks.includes(CAMPAIGN_IDENTITY));
  });
});

test("the gate is not waivable and offers no waiver action", () => {
  withTempDir((repo) => {
    writePage(repo, "checkout", page(head({ funnel: "Example V2", apiKeyMeta: "keyA", config: false })));
    writePage(repo, "upsell-1", page(head({ funnel: "Example V2", pageType: "upsell", apiKeyMeta: "keyB", config: false })));
    const gate = gateOf(doctorBuiltOutput({ built: repo, slug: SLUG }));
    assert.equal(gate.waivable, false);
    assert.equal(gate.waiver, null);
    assert.equal(gate.required_actions.some((action) => action.id === "waive_checkpoint"), false);
    assert.equal(gate.required_actions[0].id, "repair_identity");
  });
});

test("a built campaign with only parked pages reports not_applicable, not pass", () => {
  withTempDir((repo) => {
    writePage(repo, "checkout-old", page(head({ funnel: "Example V2" })));
    const result = doctorBuiltOutput({ built: repo, slug: SLUG });
    assert.equal(gateOf(result).status, "not_applicable");
    assert.equal(result.ok, true);
  });
});
