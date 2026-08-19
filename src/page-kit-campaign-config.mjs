import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const PAGE_KIT_CAMPAIGNS_REL_PATH = "_data/campaigns.json";

// Public doctor/next/verdict evidence must never inherit arbitrary merchant
// configuration from campaigns.json. The raw entry is validation-local; this
// fixed projection is the only loader metadata safe to retain in artifacts.
export function projectPageKitCampaignLoad(load) {
  return {
    status: typeof load?.status === "string" ? load.status : "target_repo_missing",
    public_route_slug: normalizePublicRouteSlug(load?.public_route_slug),
    target_path: typeof load?.target_path === "string" && load.target_path
      ? load.target_path
      : PAGE_KIT_CAMPAIGNS_REL_PATH,
  };
}

export function normalizePublicRouteSlug(value) {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

export function loadPageKitCampaignEntry({ targetRepo, publicRouteSlug }) {
  const public_route_slug = normalizePublicRouteSlug(publicRouteSlug);
  const base = {
    public_route_slug,
    target_path: PAGE_KIT_CAMPAIGNS_REL_PATH,
    entry: null,
  };

  if (typeof targetRepo !== "string" || !targetRepo.trim() || !existsSync(targetRepo)) {
    return { ...base, status: "target_repo_missing" };
  }
  try {
    if (!statSync(targetRepo).isDirectory()) return { ...base, status: "target_repo_missing" };
  } catch {
    return { ...base, status: "target_repo_missing" };
  }

  const campaignsPath = join(targetRepo, PAGE_KIT_CAMPAIGNS_REL_PATH);
  if (!existsSync(campaignsPath)) return { ...base, status: "file_missing" };

  let campaigns;
  try {
    campaigns = JSON.parse(readFileSync(campaignsPath, "utf8"));
  } catch {
    return { ...base, status: "invalid_json" };
  }
  if (!campaigns || typeof campaigns !== "object" || Array.isArray(campaigns)) {
    return { ...base, status: "root_not_object" };
  }
  if (!Object.hasOwn(campaigns, public_route_slug)) {
    return { ...base, status: "entry_missing" };
  }
  const entry = campaigns[public_route_slug];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { ...base, status: "entry_not_object" };
  }
  return { ...base, status: "ok", entry };
}
