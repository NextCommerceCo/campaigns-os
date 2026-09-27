// Where the Campaigns API key comes from, and why a candidate key was rejected.
import {
  isNonEmptyString,
  optionalString,
  firstNonEmptyString,
  readJsonIfExists,
  resolveFromFile,
} from "./cli-helpers.mjs";

// The Campaigns API key VALUE for this packet, for the remit's X-Campaign-Key
// header (the receiver's tenant join). Same precedence as the doctor's
// presence check (resolveCampaignsApiKey): packet, then the packet-local
// CampaignSpec, then the declared env source. Campaign keys are
// public-by-design; the value is sent as a header, never written into the
// record. Best-effort: any read problem resolves to null (unscoped remit).
// A campaign key is an opaque token; the receiver hashes it. The shape gate
// below is about what is NOT a campaign key: whitespace, JSON, a URL, a
// multi-kilobyte blob. The env source is additionally restricted to variable
// names that name a campaign key, so a packet cannot point `api_key_source`
// at an arbitrary secret (`env:AWS_SECRET_ACCESS_KEY`) and have its value
// travel as a header.
const CAMPAIGN_KEY_SHAPE = /^[A-Za-z0-9._-]{8,256}$/;
// A variable name that names a campaign key: upper-case, starts with a letter,
// and contains CAMPAIGN anywhere — including at the start, so the documented
// default `CAMPAIGNS_API_KEY` qualifies (a leading `[A-Z]` that consumed the C
// used to refuse exactly that name and `CAMPAIGN_KEY`).
const CAMPAIGN_KEY_ENV_NAME = /^(?=[A-Z])[A-Z0-9_]*CAMPAIGN[A-Z0-9_]*$/;

function campaignKeyOrNull(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return CAMPAIGN_KEY_SHAPE.test(trimmed) ? trimmed : null;
}

// Resolve the key AND why a present value was refused. A value that is there
// but the wrong shape is a different operator problem from no value at all —
// a typo, a quoted key, a whole JSON blob pasted into the env var, the wrong
// secret exported under a campaign-key name — and the caller must be able to
// say which, naming the SOURCE (the env var, or the packet field) and never
// the value. `rejected` is null when nothing was refused.
export function resolveCampaignsApiKeySource(packet, packetPath, env = process.env, { spec: loadedSpec = undefined } = {}) {
  const packetRaw = firstNonEmptyString(packet?.campaign?.campaigns_api_key, packet?.campaign?.api_key);
  if (isNonEmptyString(packetRaw)) {
    const packetKey = campaignKeyOrNull(packetRaw);
    if (packetKey) return { key: packetKey, origin: packet?.campaign?.campaigns_api_key ? "packet.campaign.campaigns_api_key" : "packet.campaign.api_key", rejected: null };
    return { key: null, origin: null, rejected: { kind: "malformed", source: packet?.campaign?.campaigns_api_key ? "packet.campaign.campaigns_api_key" : "packet.campaign.api_key" } };
  }
  try {
    // A caller that already holds the packet-local CampaignSpec (doctor) hands
    // it in; otherwise it is read from the packet's local_path.
    const localSpecPath = packet?.spec?.local_path;
    if (loadedSpec !== undefined || (isNonEmptyString(localSpecPath) && isNonEmptyString(packetPath))) {
      const spec = loadedSpec !== undefined ? loadedSpec : readJsonIfExists(resolveFromFile(packetPath, localSpecPath));
      // Name the field the value actually came from: a refused source the
      // operator cannot find in their CampaignSpec is worse than no name.
      const specField = [
        ["campaign.campaigns_api_key", spec?.campaign?.campaigns_api_key],
        ["campaigns_api_key", spec?.campaigns_api_key],
        ["campaign.api_key", spec?.campaign?.api_key],
      ].find(([, value]) => isNonEmptyString(value));
      if (specField) {
        const specKey = campaignKeyOrNull(specField[1]);
        if (specKey) return { key: specKey, origin: `the packet-local CampaignSpec ${specField[0]}`, rejected: null };
        return { key: null, origin: null, rejected: { kind: "malformed", source: `the packet-local CampaignSpec ${specField[0]}` } };
      }
    }
  } catch {
    // unreadable spec — fall through to env
  }
  const source = optionalString(packet?.campaign?.api_key_source);
  if (source && source.startsWith("env:")) {
    const envName = source.slice("env:".length).trim();
    if (!CAMPAIGN_KEY_ENV_NAME.test(envName)) {
      return { key: null, origin: null, rejected: { kind: "unsupported_env_name", source: `api_key_source "env:${envName}"` } };
    }
    const raw = env?.[envName];
    if (isNonEmptyString(raw)) {
      const envKey = campaignKeyOrNull(raw);
      if (envKey) return { key: envKey, origin: `env:${envName}`, rejected: null };
      return { key: null, origin: null, rejected: { kind: "malformed", source: `env:${envName}` } };
    }
  }
  return { key: null, origin: null, rejected: null };
}

// Back-compat shape: the key value or null, for callers that only need the
// header value.
export function resolveCampaignsApiKeyValue(packet, packetPath, env = process.env) {
  return resolveCampaignsApiKeySource(packet, packetPath, env).key;
}

// One sentence an operator can act on, naming the refused source and never
// its value. `null` when nothing was refused.
export function describeCampaignKeyRejection(rejected) {
  if (!rejected) return null;
  if (rejected.kind === "unsupported_env_name") {
    return `${rejected.source} does not name a campaign key, so its value was not read (an api_key_source env var must match ${CAMPAIGN_KEY_ENV_NAME.source}). No credential was taken from it.`;
  }
  return `the Campaigns API key from ${rejected.source} is not a campaign-key shape (expected ${CAMPAIGN_KEY_SHAPE.source} — 8-256 chars of letters, digits, dot, dash, underscore, one line, no whitespace) and was refused before any request. Fix the value at that source; it is not printed here.`;
}
