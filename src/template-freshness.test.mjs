import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assessTemplateFreshness,
  compareSdkVersions,
  defaultSdkSupportPolicy,
  familyVerification,
  parseSdkVersion,
  renderTemplateFreshness,
  resolveCurrentSdkVersion,
} from "./template-freshness.mjs";

const POLICY = { provenance: { latest_known_release: "0.4.36" } };

function catalogWith(verifications) {
  const families = {};
  for (const [family, verification] of Object.entries(verifications)) {
    families[family] = verification ? { verification } : {};
  }
  return { families };
}

test("parseSdkVersion accepts only released major.minor.patch versions", () => {
  assert.deepEqual(parseSdkVersion("0.4.37"), [0, 4, 37]);
  assert.equal(parseSdkVersion("0.4"), null);
  assert.equal(parseSdkVersion("0.4.37-beta.1"), null);
  assert.equal(parseSdkVersion(null), null);
});

test("compareSdkVersions orders released versions and refuses unparseable input", () => {
  assert.equal(compareSdkVersions("0.4.34", "0.4.37"), -1);
  assert.equal(compareSdkVersions("0.4.37", "0.4.37"), 0);
  assert.equal(compareSdkVersions("0.5.0", "0.4.37"), 1);
  assert.equal(compareSdkVersions("latest", "0.4.37"), null);
});

test("current SDK is the newest release the vendored contracts record — policy or a newer verification record", () => {
  // Verification evidence at 0.4.37 proves that release exists even when the
  // policy capture still says 0.4.36, so the newer record wins.
  const catalog = catalogWith({
    olympus: { sdk_version: "0.4.37", verified_at: "2026-08-21T15:26:00Z" },
  });
  assert.deepEqual(resolveCurrentSdkVersion({ catalog, sdkSupportPolicy: POLICY }), {
    version: "0.4.37",
    source: "catalog_verification:olympus",
  });

  // With only older verification records, the policy's latest known release wins.
  const older = catalogWith({ olympus: { sdk_version: "0.4.34" } });
  assert.deepEqual(resolveCurrentSdkVersion({ catalog: older, sdkSupportPolicy: POLICY }), {
    version: "0.4.36",
    source: "sdk_support_policy.latest_known_release",
  });

  // No vendored release data at all -> no current SDK to compare against.
  assert.equal(resolveCurrentSdkVersion({ catalog: { families: {} }, sdkSupportPolicy: null }), null);
});

test("fresh: a family verified against the current SDK reads as current", () => {
  const catalog = catalogWith({
    olympus: { sdk_version: "0.4.37", verified_at: "2026-08-21T15:26:00Z" },
  });
  const assessment = assessTemplateFreshness({ family: "olympus", catalog, sdkSupportPolicy: POLICY });
  assert.equal(assessment.state, "current");
  assert.equal(assessment.verified_sdk_version, "0.4.37");
  assert.equal(assessment.current_sdk_version, "0.4.37");
  const line = renderTemplateFreshness(assessment);
  assert.match(line, /certification is current/);
  assert.match(line, /0\.4\.37/);
  assert.match(line, /2026-08-21/, "the line says when the family was last verified");
});

test("stale: an older evidence record is reported as not current certification, with the delta", () => {
  const catalog = catalogWith({
    olympus: { sdk_version: "0.4.37", verified_at: "2026-08-21T15:26:00Z" },
    demeter: { sdk_version: "0.4.34", verified_at: "2026-08-12T06:12:06Z" },
  });
  const assessment = assessTemplateFreshness({ family: "demeter", catalog, sdkSupportPolicy: POLICY });
  assert.equal(assessment.state, "stale");
  assert.equal(assessment.verified_sdk_version, "0.4.34");
  assert.equal(assessment.current_sdk_version, "0.4.37");
  assert.equal(assessment.delta, "3 patch versions behind");
  const line = renderTemplateFreshness(assessment);
  assert.match(line, /last verified against SDK 0\.4\.34/);
  assert.match(line, /current SDK is 0\.4\.37/);
  assert.match(line, /An older evidence record is not current certification/);
});

test("stale across a minor line reports both versions instead of a patch count", () => {
  const catalog = catalogWith({
    olympus: { sdk_version: "0.5.1" },
    demeter: { sdk_version: "0.4.34" },
  });
  const assessment = assessTemplateFreshness({ family: "demeter", catalog, sdkSupportPolicy: POLICY });
  assert.equal(assessment.state, "stale");
  assert.equal(assessment.delta, "0.4.34 vs 0.5.1");
});

test("missing verification data: freshness is unknown and says so, never fabricated", () => {
  const catalog = catalogWith({
    olympus: { sdk_version: "0.4.37" },
    "fixture-private-family": null,
  });
  const assessment = assessTemplateFreshness({ family: "fixture-private-family", catalog, sdkSupportPolicy: POLICY });
  assert.equal(assessment.state, "unknown");
  assert.equal(assessment.verified_sdk_version, null);
  assert.equal(assessment.current_sdk_version, "0.4.37", "the current SDK is still stated for orientation");
  const line = renderTemplateFreshness(assessment);
  assert.match(line, /no verification record/);
  assert.match(line, /freshness is unknown/);
  assert.match(line, /An older evidence record is not current certification/);
});

test("no current SDK recorded anywhere: assessment is unknown rather than a guess", () => {
  const catalog = catalogWith({ olympus: null });
  const assessment = assessTemplateFreshness({ family: "olympus", catalog, sdkSupportPolicy: null });
  assert.equal(assessment.state, "unknown");
  assert.equal(assessment.current_sdk_version, null);
  assert.doesNotMatch(renderTemplateFreshness(assessment), /current SDK:/);
});

test("ahead (injected inputs only): rendered honestly as a policy-capture problem", () => {
  const assessment = assessTemplateFreshness({
    family: "olympus",
    catalog: catalogWith({ olympus: { sdk_version: "0.4.34" } }),
    sdkSupportPolicy: POLICY,
  });
  // Under the default definition verified can never exceed current; force the
  // comparison by asserting the renderer's defensive branch directly.
  const line = renderTemplateFreshness({ ...assessment, state: "ahead", verified_sdk_version: "0.4.40", current_sdk_version: "0.4.36" });
  assert.match(line, /newer than the current SDK/);
});

test("familyVerification only accepts a well-formed vendored record", () => {
  assert.equal(familyVerification(catalogWith({ olympus: null }), "olympus"), null);
  assert.equal(familyVerification(catalogWith({ olympus: { sdk_version: "not-a-version" } }), "olympus"), null);
  assert.deepEqual(
    familyVerification(catalogWith({ olympus: { sdk_version: "0.4.37", verified_at: "2026-08-21T15:26:00Z", evidence: "sdk-0.4.37-2026-08-21", status: "certified" } }), "olympus"),
    { sdk_version: "0.4.37", verified_at: "2026-08-21T15:26:00Z", evidence: "sdk-0.4.37-2026-08-21", status: "certified" },
  );
});

test("the vendored SDK support policy loads and records a released latest_known_release", () => {
  const policy = defaultSdkSupportPolicy();
  assert.ok(policy, "the vendored contract exists in this repo");
  assert.ok(parseSdkVersion(policy.provenance?.latest_known_release), "latest_known_release is a released version");
});
