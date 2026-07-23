// Template slot manifests: the content-slot contract for certified template
// families. One shared content-slot core declares every content slot on the
// shared pages (semantic description, length band, source policy, proof and
// urgency flags); per-family manifests extend it with family-specific overlay
// keys and the list of commerce-owned pages the content layer never touches.
//
// Files live at contracts/template-slot-manifest.<family>.v0.json and
// contracts/template-slot-manifest.shared-content-core.v0.json. Family
// manifests `extends` the shared core; object values merge, arrays and
// scalars replace (same semantics as template brand contracts).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const TEMPLATE_SLOT_MANIFEST_SCHEMA = "template-slot-manifest/v0";

export const SLOT_SOURCE_POLICIES = Object.freeze([
  "generated",
  "merchant_asset_required",
  "spec_truth",
  "brand",
  "template_static",
]);

export function templateSlotManifestPath(family) {
  if (typeof family !== "string" || !family.trim()) return null;
  return join(ROOT, "contracts", `template-slot-manifest.${family.trim()}.v0.json`);
}

export function sharedContentCorePath() {
  return join(ROOT, "contracts", "template-slot-manifest.shared-content-core.v0.json");
}

export function loadTemplateSlotManifest(family) {
  const path = templateSlotManifestPath(family);
  if (!path || !existsSync(path)) return null;
  const manifest = loadManifestFile(path);
  if (manifest.family !== family) {
    throw slotManifestError(
      "family_mismatch",
      `Template slot manifest ${path} declares family "${manifest.family}"; expected "${family}".`,
    );
  }
  return manifest;
}

function loadManifestFile(path, seen = new Set()) {
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw slotManifestError(
      "parse_error",
      `Template slot manifest ${path} failed to parse: ${error instanceof Error ? error.message : String(error)}.`,
      error,
    );
  }
  return resolveExtendsChain(manifest, { dir: dirname(path), label: path, seen });
}

function resolveExtendsChain(manifest, { dir, label = dir, seen = new Set() } = {}) {
  if (seen.has(label)) throw slotManifestError("extends_cycle", `Template slot manifest extends cycle at ${label}.`);
  seen.add(label);
  if (!isPlainObject(manifest) || manifest.schema_version !== TEMPLATE_SLOT_MANIFEST_SCHEMA) {
    throw slotManifestError(
      "schema_mismatch",
      `Template slot manifest ${label} has schema_version "${manifest?.schema_version}"; expected "${TEMPLATE_SLOT_MANIFEST_SCHEMA}".`,
    );
  }
  const parentRef = typeof manifest.extends === "string" && manifest.extends.trim() ? manifest.extends.trim() : null;
  if (!parentRef) return manifest;
  const parentPath = join(dir, parentRef);
  if (!existsSync(parentPath)) {
    throw slotManifestError("extends_missing_parent", `Template slot manifest ${label} extends missing file "${parentRef}".`);
  }
  const merged = mergeObjects(loadManifestFile(parentPath, seen), manifest);
  delete merged.extends;
  return merged;
}

function slotManifestError(code, message, cause = undefined) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function mergeObjects(parent, child) {
  const merged = { ...parent };
  for (const [key, value] of Object.entries(child)) {
    if (isPlainObject(value) && isPlainObject(parent?.[key])) {
      merged[key] = mergeObjects(parent[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sectionsOf(pageEntry) {
  return Array.isArray(pageEntry?.sections) ? pageEntry.sections : [];
}

// Every slot entry declared for a page: shared-core slots plus the family
// overlay's slots. Returns [] for commerce-owned or unknown pages.
export function manifestPageSlots(manifest, page) {
  if (!isPlainObject(manifest)) return [];
  const slots = [];
  for (const source of [manifest.pages?.[page], manifest.overlay?.pages?.[page]]) {
    for (const section of sectionsOf(source)) {
      for (const slot of Array.isArray(section.slots) ? section.slots : []) {
        if (isPlainObject(slot) && typeof slot.key === "string") slots.push(slot);
      }
    }
  }
  return slots;
}

export function declaredSlotKeys(manifest, page) {
  return new Set(manifestPageSlots(manifest, page).map((slot) => slot.key));
}

// Pages the content layer never validates key-by-key: commerce-owned pages
// declared by the family manifest plus pages the shared core marks
// commerce_owned (checkout).
export function commerceOwnedPages(manifest) {
  const pages = new Set(
    Array.isArray(manifest?.commerce_owned_pages) ? manifest.commerce_owned_pages.map(String) : [],
  );
  for (const [page, entry] of Object.entries(manifest?.pages || {})) {
    if (isPlainObject(entry) && entry.commerce_owned === true) pages.add(page);
  }
  return pages;
}

// Slots whose chrome may render only under verified offer urgency.
export function urgencySlots(manifest, page) {
  return manifestPageSlots(manifest, page).filter((slot) => slot.enabled_by_verified_urgency === true);
}

// Proof surfaces (counts, ratings, reviews, UGC, byline identity) — the slots
// the attestation lane and the rendered-residue doctor checks care about.
export function proofSlots(manifest, page) {
  return manifestPageSlots(manifest, page).filter((slot) => slot.proof_surface === true);
}
