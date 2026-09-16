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

// The three pure comparators live in `./spec-hash.mjs`, a dependency-free
// leaf, so that browser-targeted consumers of the public
// `./commercial-journey` export can reach them without pulling this module's
// `node:crypto` import into their bundle. They are re-exported here so every
// existing importer of `./spec-identity.mjs` keeps working unchanged.
export { normalizeSpecHash, specHashesMatch, specHashOf } from "./spec-hash.mjs";
