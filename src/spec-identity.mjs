import { createHash } from "node:crypto";

const VOLATILE_TOP_LEVEL_FIELDS = new Set(["spec_identity", "slug", "map_id", "saved_at"]);

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function materialSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return spec;
  return Object.fromEntries(
    Object.entries(spec).filter(([key]) => !VOLATILE_TOP_LEVEL_FIELDS.has(key)),
  );
}

export function specMaterialHash(spec) {
  return `sha256:${createHash("sha256").update(canonicalJson(materialSpec(spec))).digest("hex")}`;
}

// The spec material with every page's page_url left out (funnels[].pages[]
// and the legacy funnel_pages[] mirror). Intake and record spec record it in
// the Build Context, so record spec can tell a change of routes alone from
// one that also touched anything else the build reads (#531).
export function routeMaskedSpecMaterialHash(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return specMaterialHash(spec);
  const masked = JSON.parse(JSON.stringify(spec));
  const lists = [...(Array.isArray(masked.funnels) ? masked.funnels.map((funnel) => funnel?.pages) : []), masked.funnel_pages];
  for (const pages of lists) {
    for (const page of Array.isArray(pages) ? pages : []) if (page && typeof page === "object") delete page.page_url;
  }
  return specMaterialHash(masked);
}

// The three pure comparators live in `./spec-hash.mjs`, a dependency-free
// leaf, so that browser-targeted consumers of the public
// `./commercial-journey` export can reach them without pulling this module's
// `node:crypto` import into their bundle. They are re-exported here so every
// existing importer of `./spec-identity.mjs` keeps working unchanged.
export { normalizeSpecHash, specHashesMatch, specHashOf } from "./spec-hash.mjs";
