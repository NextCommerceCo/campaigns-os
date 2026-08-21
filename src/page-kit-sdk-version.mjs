import { normalizePublicRouteSlug, PAGE_KIT_CAMPAIGNS_REL_PATH } from "./page-kit-campaign-config.mjs";
import {
  assessCheckpointWaivers,
  checkpointStateFingerprint,
  projectCheckpointWaiverAssessment,
} from "./checkpoint-waiver.mjs";
// Strict released-semver parsing lives in the campaign-spec module (built to
// campaign-spec/dist, same as the cli.mjs import) so the authoring-time
// SdkVersion rule and this checkpoint share exactly ONE parser.
import { isReleasedSdkVersion } from "../campaign-spec/dist/index.js";

export const PAGE_KIT_SDK_VERSION_SCOPE = "page_kit.sdk_version";
const MISSING_TARGET_STATUSES = new Set(["target_repo_missing", "file_missing", "entry_missing"]);

export function evaluatePageKitSdkVersion({
  spec,
  specStatus = "ok",
  targetLoad,
  waivers = [],
  required = true,
  now = new Date().toISOString(),
} = {}) {
  // global_config.sdk_version is the CANONICAL CampaignSpec home (33/33 real
  // Map Builder exports declare it there); runtime.sdk_version is an accepted
  // alias seen only in local drafts. Read canonical first, alias as fallback.
  const hasCanonical = spec?.global_config != null && Object.hasOwn(spec.global_config, "sdk_version");
  const hasAlias = spec?.runtime != null && Object.hasOwn(spec.runtime, "sdk_version");
  const expected_sdk_version = hasCanonical
    ? spec.global_config.sdk_version
    : spec?.runtime?.sdk_version;
  const expected_source = hasCanonical ? "global_config.sdk_version" : "runtime.sdk_version";
  const observed_sdk_version = targetLoad?.entry?.sdk_version;
  const subject = {
    public_route_slug: normalizePublicRouteSlug(targetLoad?.public_route_slug),
    target_path: targetLoad?.target_path || PAGE_KIT_CAMPAIGNS_REL_PATH,
  };
  if (specStatus !== "ok") {
    return {
      id: PAGE_KIT_SDK_VERSION_SCOPE,
      scope: PAGE_KIT_SDK_VERSION_SCOPE,
      status: "blocked",
      code: "page_kit.sdk_version.spec_unavailable",
      reason: `Local CampaignSpec SDK pin is unavailable or malformed (${specStatus}); packet QA never fetches around missing local parity evidence.`,
      waivable: false,
      subject,
      state: { spec_status: specStatus },
      state_fingerprint: null,
      expected_sdk_version: null,
      observed_sdk_version: isReleasedSdkVersion(observed_sdk_version) ? observed_sdk_version : null,
      expected_source: null,
      waiver: null,
      waiver_assessment: {
        active: null,
        inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
      },
      required_actions: [{
        id: "repair_spec",
        kind: "edit",
        command: null,
        description: "Restore a valid packet-local CampaignSpec export before build or QA.",
      }],
    };
  }
  if (!hasCanonical && !hasAlias) {
    return {
      id: PAGE_KIT_SDK_VERSION_SCOPE,
      scope: PAGE_KIT_SDK_VERSION_SCOPE,
      status: "blocked",
      code: "page_kit.sdk_version.spec_missing",
      reason: "CampaignSpec is missing global_config.sdk_version (and the runtime.sdk_version alias); add an explicit released SDK pin before build or QA.",
      waivable: false,
      subject,
      state: { spec_status: "missing" },
      state_fingerprint: null,
      expected_sdk_version: null,
      observed_sdk_version: isReleasedSdkVersion(observed_sdk_version) ? observed_sdk_version : null,
      expected_source: null,
      waiver: null,
      waiver_assessment: {
        active: null,
        inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
      },
      required_actions: [{
        id: "repair_spec",
        kind: "edit",
        command: null,
        description: "Add a released CampaignSpec SDK pin, then re-run doctor.",
      }],
    };
  }
  const invalidDeclarations = [
    ...(hasCanonical && !isReleasedSdkVersion(spec.global_config.sdk_version) ? ["global_config.sdk_version"] : []),
    ...(hasAlias && !isReleasedSdkVersion(spec.runtime.sdk_version) ? ["runtime.sdk_version"] : []),
  ];
  if (invalidDeclarations.length) {
    return {
      id: PAGE_KIT_SDK_VERSION_SCOPE,
      scope: PAGE_KIT_SDK_VERSION_SCOPE,
      status: "blocked",
      code: "page_kit.sdk_version.spec_invalid",
      reason: `CampaignSpec ${invalidDeclarations.join(" and ")} must be a released semantic version in canonical MAJOR.MINOR.PATCH form.`,
      waivable: false,
      subject,
      state: { spec_status: "invalid", invalid_declarations: invalidDeclarations },
      state_fingerprint: null,
      expected_sdk_version: null,
      observed_sdk_version: isReleasedSdkVersion(observed_sdk_version) ? observed_sdk_version : null,
      expected_source: null,
      waiver: null,
      waiver_assessment: {
        active: null,
        inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
      },
      required_actions: [{
        id: "repair_spec",
        kind: "edit",
        command: null,
        description: "Set the CampaignSpec SDK declaration to a released MAJOR.MINOR.PATCH version, then re-run doctor.",
      }],
    };
  }
  if (hasCanonical && hasAlias && spec.global_config.sdk_version !== spec.runtime.sdk_version) {
    return {
      id: PAGE_KIT_SDK_VERSION_SCOPE,
      scope: PAGE_KIT_SDK_VERSION_SCOPE,
      status: "blocked",
      code: "page_kit.sdk_version.spec_conflict",
      reason: "CampaignSpec global_config.sdk_version and runtime.sdk_version disagree; global_config is canonical — resolve the declarations before build or QA.",
      waivable: false,
      subject,
      state: { spec_status: "conflict" },
      state_fingerprint: null,
      expected_sdk_version: null,
      observed_sdk_version: isReleasedSdkVersion(observed_sdk_version) ? observed_sdk_version : null,
      expected_source: null,
      waiver: null,
      waiver_assessment: {
        active: null,
        inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
      },
      required_actions: [{
        id: "repair_spec",
        kind: "edit",
        command: null,
        description: "Make the CampaignSpec canonical (global_config) and alias (runtime) SDK declarations identical, then re-run doctor.",
      }],
    };
  }
  const loadStatus = targetLoad?.status || "target_repo_missing";
  if (loadStatus !== "ok") {
    const optionalMissing = !required && MISSING_TARGET_STATUSES.has(loadStatus);
    return {
      id: PAGE_KIT_SDK_VERSION_SCOPE,
      scope: PAGE_KIT_SDK_VERSION_SCOPE,
      status: optionalMissing ? "not_applicable" : "blocked",
      code: optionalMissing
        ? "page_kit.sdk_version.not_applicable"
        : "page_kit.sdk_version.target_unavailable",
      reason: optionalMissing
        ? `Target ${subject.target_path} entry is not present before scaffold; SDK-pin parity becomes mandatory once the target exists.`
        : `Target ${subject.target_path} entry is unavailable or malformed (${loadStatus}); packet build and QA require an explicit released SDK pin.`,
      waivable: false,
      subject,
      state: { target_status: loadStatus },
      state_fingerprint: null,
      expected_sdk_version,
      observed_sdk_version: null,
      expected_source,
      waiver: null,
      waiver_assessment: {
        active: null,
        inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
      },
      required_actions: optionalMissing ? [] : [{
        id: "repair_target",
        kind: "edit",
        command: null,
        description: `Create or repair ${subject.target_path}[${subject.public_route_slug || "<public-route-slug>"}] with a released SDK pin, then re-run doctor.`,
      }],
    };
  }
  const targetEntry = targetLoad?.entry;
  const targetHasVersion = targetEntry != null && Object.hasOwn(targetEntry, "sdk_version");
  if (!targetHasVersion || !isReleasedSdkVersion(observed_sdk_version)) {
    const missing = !targetHasVersion;
    return {
      id: PAGE_KIT_SDK_VERSION_SCOPE,
      scope: PAGE_KIT_SDK_VERSION_SCOPE,
      status: "blocked",
      code: missing
        ? "page_kit.sdk_version.target_missing"
        : "page_kit.sdk_version.target_invalid",
      reason: missing
        ? `Target ${subject.target_path}[${subject.public_route_slug}] is missing sdk_version; add the exact released CampaignSpec pin before build or QA.`
        : `Target ${subject.target_path}[${subject.public_route_slug}].sdk_version must be a released semantic version in canonical MAJOR.MINOR.PATCH form.`,
      waivable: false,
      subject,
      state: { target_status: missing ? "version_missing" : "version_invalid" },
      state_fingerprint: null,
      expected_sdk_version,
      observed_sdk_version: null,
      expected_source,
      waiver: null,
      waiver_assessment: {
        active: null,
        inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
      },
      required_actions: [{
        id: "repair_target",
        kind: "edit",
        command: null,
        description: `Set ${subject.target_path}[${subject.public_route_slug}].sdk_version to the released CampaignSpec pin, then re-run doctor.`,
      }],
    };
  }
  if (observed_sdk_version !== expected_sdk_version) {
    const state = { expected: expected_sdk_version, observed: observed_sdk_version };
    const state_fingerprint = checkpointStateFingerprint({
      scope: PAGE_KIT_SDK_VERSION_SCOPE,
      subject,
      state,
    });
    const checkpoint = { scope: PAGE_KIT_SDK_VERSION_SCOPE, subject, state_fingerprint };
    const waiver_assessment = projectCheckpointWaiverAssessment(
      assessCheckpointWaivers(waivers, checkpoint, { now }),
      checkpoint,
    );
    const waiver = waiver_assessment.active;
    return {
      id: PAGE_KIT_SDK_VERSION_SCOPE,
      scope: PAGE_KIT_SDK_VERSION_SCOPE,
      status: waiver ? "waived" : "blocked",
      code: waiver ? "page_kit.sdk_version.waived" : PAGE_KIT_SDK_VERSION_SCOPE,
      reason: waiver
        ? `Target SDK version ${observed_sdk_version} intentionally differs from the CampaignSpec pin ${expected_sdk_version} under an exact named-human decision.`
        : `Target SDK version ${observed_sdk_version} does not match the CampaignSpec pin ${expected_sdk_version}; correct the target or record an explicit intentional-pin decision before build or QA.`,
      waivable: true,
      subject,
      state,
      state_fingerprint,
      expected_sdk_version,
      observed_sdk_version,
      expected_source,
      waiver,
      waiver_assessment,
      required_actions: waiver ? [] : [
        {
          id: "repair_target",
          kind: "edit",
          command: null,
          description: `Set ${subject.target_path}[${subject.public_route_slug}].sdk_version to ${expected_sdk_version}, then re-run doctor.`,
        },
        {
          id: "waive_checkpoint",
          kind: "command",
          command: "campaigns-os checkpoint waive --packet <packet> --gate page_kit.sdk_version --reason \"<reason>\" --waived-by \"<named human>\" --review-condition \"<re-evaluation trigger>\"",
          description: "Record an explicit bounded named-human intentional-pin decision for this exact expected/observed SDK pair.",
        },
      ],
    };
  }
  return {
    id: PAGE_KIT_SDK_VERSION_SCOPE,
    scope: PAGE_KIT_SDK_VERSION_SCOPE,
    status: "pass",
    code: "page_kit.sdk_version.pass",
    reason: `Target SDK version exactly matches the CampaignSpec (${expected_sdk_version}).`,
    waivable: false,
    subject,
    state: { expected: expected_sdk_version, observed: observed_sdk_version },
    state_fingerprint: null,
    expected_sdk_version,
    observed_sdk_version,
    expected_source,
    waiver: null,
    waiver_assessment: {
      active: null,
      inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
    },
    required_actions: [],
  };
}
