import { PAGE_KIT_CAMPAIGNS_REL_PATH } from "./page-kit-campaign-config.mjs";
import {
  isDemoResidue,
  normalizeStoreProfileValue,
  PAGE_KIT_STORE_PROFILE_FIELDS,
  PAGE_KIT_SYNC_COMMAND,
} from "./page-kit-store-profile.mjs";
import { normalizePublicRouteSlug } from "./route-identity.mjs";
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

// The canonical bare spelling of the command that writes the repo pin back
// into the CampaignSpec (implemented in spec-derive.mjs, which imports this
// module and so cannot be imported here). The `repo_newer` advisory names it;
// printers spell it for the running install.
export const SPEC_DERIVE_COMMAND = "campaigns-os spec derive --packet <packet>";

// The one rule for reading the CampaignSpec's SDK pin. global_config
// .sdk_version is the CANONICAL home (33/33 real Map Builder exports declare
// it there); runtime.sdk_version is an accepted alias seen only in local
// drafts. Canonical first, alias as fallback. The gate below and `page-kit
// sync` both consume this, so what the gate expects and what sync writes can
// never drift apart. `status` is ok | spec_missing | spec_invalid |
// spec_conflict; `invalid_declarations` names the offending key(s).
export function resolveSpecSdkPin(spec) {
  const hasCanonical = spec?.global_config != null && Object.hasOwn(spec.global_config, "sdk_version");
  const hasAlias = spec?.runtime != null && Object.hasOwn(spec.runtime, "sdk_version");
  const base = { has_canonical: hasCanonical, has_alias: hasAlias, invalid_declarations: [] };
  if (!hasCanonical && !hasAlias) return { ...base, value: null, source: null, status: "spec_missing" };
  const invalidDeclarations = [
    ...(hasCanonical && !isReleasedSdkVersion(spec.global_config.sdk_version) ? ["global_config.sdk_version"] : []),
    ...(hasAlias && !isReleasedSdkVersion(spec.runtime.sdk_version) ? ["runtime.sdk_version"] : []),
  ];
  if (invalidDeclarations.length) {
    return { ...base, value: null, source: null, status: "spec_invalid", invalid_declarations: invalidDeclarations };
  }
  if (hasCanonical && hasAlias && spec.global_config.sdk_version !== spec.runtime.sdk_version) {
    return { ...base, value: null, source: null, status: "spec_conflict" };
  }
  return hasCanonical
    ? { ...base, value: spec.global_config.sdk_version, source: "global_config.sdk_version", status: "ok" }
    : { ...base, value: spec.runtime.sdk_version, source: "runtime.sdk_version", status: "ok" };
}
const MISSING_TARGET_STATUSES = new Set(["target_repo_missing", "file_missing", "entry_missing"]);

// An entry still carrying the starter family's demo store profile is a fresh
// scaffold: its pin is the starter's seed, not a version anyone chose. Both
// directions read this one rule — `page-kit sync` seeds the pin while it
// holds, `spec derive` refuses to copy the seed into the spec while it holds.
export function entryInScaffoldState(entry) {
  return PAGE_KIT_STORE_PROFILE_FIELDS.some((field) => (
    typeof entry?.[field] === "string" && isDemoResidue(field, normalizeStoreProfileValue(entry[field]))
  ));
}

// Whether `page-kit sync` may write the spec's pin over the target's. The
// spec is the authority for the Store Profile in every case (those values are
// authored in the Map, never in the repo), but the SDK pin is different: on an
// existing campaign the repo pin moves first and the Map/spec is stale until
// someone re-saves it, so spec -> repo would silently undo a bump. Sync
// therefore SEEDS the pin: it writes when the entry is still in scaffold
// state (the starter demo store profile is still in it) or the target pin is
// older than the spec's, and refuses to move a configured campaign's pin
// backwards. Both released versions are canonical MAJOR.MINOR.PATCH here.
export function sdkPinWriteDecision({ expected, observed, entry }) {
  if (entryInScaffoldState(entry)) return "write";
  if (!isReleasedSdkVersion(observed) || !isReleasedSdkVersion(expected)) return "write";
  return compareReleasedSdkVersions(observed, expected) > 0 ? "target_newer" : "write";
}

// Orders two canonical MAJOR.MINOR.PATCH versions (negative, zero, positive);
// both sides must already have passed isReleasedSdkVersion.
export function compareReleasedSdkVersions(a, b) {
  const [am, an, ap] = a.split(".").map(Number);
  const [bm, bn, bp] = b.split(".").map(Number);
  return am - bm || an - bn || ap - bp;
}

export function evaluatePageKitSdkVersion({
  spec,
  specStatus = "ok",
  targetLoad,
  waivers = [],
  required = true,
  now = new Date().toISOString(),
} = {}) {
  const pin = resolveSpecSdkPin(spec);
  const { has_canonical: hasCanonical, has_alias: hasAlias } = pin;
  // The blocked branches below report the raw declaration the spec made, so
  // the expected version is read back from the spec, not from the resolved pin.
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
  const invalidDeclarations = pin.invalid_declarations;
  if (pin.status === "spec_invalid") {
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
  if (pin.status === "spec_conflict") {
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
        kind: "command",
        command: PAGE_KIT_SYNC_COMMAND,
        description: `Write the released CampaignSpec pin ${expected_sdk_version} into ${subject.target_path}[${subject.public_route_slug}].sdk_version, then re-run doctor.`,
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
    // Direction of authority (#413): the repo pin is what the funnel serves,
    // the spec field is a build hint. A configured campaign whose repo pin is
    // NEWER than the spec's (both released, no scaffold residue — the same
    // decision `page-kit sync` uses to refuse moving it backwards) is a
    // completed bump the Map has not been re-saved for: advisory, not a
    // blocker, with the re-save as the action. The repo BEHIND the spec, or
    // a scaffold that still carries the starter pin, stays a blocker with
    // sync as the repair; a non-released target pin was refused above.
    const checkpoint = { scope: PAGE_KIT_SDK_VERSION_SCOPE, subject, state_fingerprint };
    if (sdkPinWriteDecision({ expected: expected_sdk_version, observed: observed_sdk_version, entry: targetEntry }) === "target_newer") {
      // Nothing is waived here (there is nothing to waive), but the waiver
      // history is still assessed so a stale, foreign, malformed or expired
      // record recorded against an earlier pair keeps surfacing as inert
      // rather than silently vanishing the moment the state turns advisory.
      const waiver_assessment = projectCheckpointWaiverAssessment(
        assessCheckpointWaivers(waivers, checkpoint, { now }),
        checkpoint,
      );
      return {
        id: PAGE_KIT_SDK_VERSION_SCOPE,
        scope: PAGE_KIT_SDK_VERSION_SCOPE,
        status: "pass",
        code: "page_kit.sdk_version.repo_newer",
        reason: `Target SDK version ${observed_sdk_version} is newer than the CampaignSpec pin ${expected_sdk_version}; the repo pin is what ships, so the build proceeds. Re-derive the spec (spec derive, the refresh_spec action; add --write-map to record ${observed_sdk_version} in the Map's Build hints too) or re-save the Map's Build hints (Campaign Cart SDK version) to ${observed_sdk_version} so the exported spec stops reading stale.`,
        waivable: false,
        subject,
        state,
        state_fingerprint,
        expected_sdk_version,
        observed_sdk_version,
        expected_source,
        waiver: null,
        waiver_assessment,
        required_actions: [],
        advisory_actions: [{
          id: "refresh_spec",
          kind: "command",
          command: SPEC_DERIVE_COMMAND,
          description: `Write the repo pin ${observed_sdk_version} into the CampaignSpec's ${expected_source} (spec derive; with --write-map it is also recorded in the Map's Build hints field), or re-save the Map's Build hints field (Campaign Cart SDK version) to ${observed_sdk_version} and re-export; nothing in the repo needs to change.`,
        }],
      };
    }
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
          kind: "command",
          command: PAGE_KIT_SYNC_COMMAND,
          description: `Write the CampaignSpec pin ${expected_sdk_version} into ${subject.target_path}[${subject.public_route_slug}].sdk_version (currently ${observed_sdk_version}), then re-run doctor.`,
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
