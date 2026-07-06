import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const SOURCE_HTML_MANIFEST_REL_PATH = ".campaigns-os/source-html-manifest.json";
export const SOURCE_HTML_MANIFEST_SCHEMA = "source-html-manifest/v0";

export const SOURCE_HASH_PATTERN = /^[0-9a-f]{64}$/;
const FILE_ROLES = new Set(["page", "partial", "layout", "asset", "export_log", "support"]);

export function validateSourceHtmlManifest(manifest) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });

  if (!isObject(manifest)) {
    add("manifest.type", "Source HTML manifest must be a JSON object.");
    return { ok: false, errors };
  }

  if (manifest.schema_version !== SOURCE_HTML_MANIFEST_SCHEMA) {
    add("manifest.schema_version", `Expected schema_version "${SOURCE_HTML_MANIFEST_SCHEMA}".`);
  }
  if (manifest.generated_at != null && !isNonEmptyString(manifest.generated_at)) {
    add("manifest.generated_at", "generated_at must be a non-empty string when present.");
  }
  if (manifest.generator != null && !isNonEmptyString(manifest.generator)) {
    add("manifest.generator", "generator must be a non-empty string when present.");
  }
  if (manifest.campaign_slug != null && !isNonEmptyString(manifest.campaign_slug)) {
    add("manifest.campaign_slug", "campaign_slug must be a non-empty string when present.");
  }
  if (manifest.root != null && !isNonEmptyString(manifest.root)) {
    add("manifest.root", "root must be a non-empty string when present.");
  }
  if (manifest.producer_provenance != null) {
    validateProducerProvenance(manifest.producer_provenance, add);
  }
  if (manifest.files != null) {
    if (!Array.isArray(manifest.files)) {
      add("manifest.files", "files must be an array when present.");
    } else {
      manifest.files.forEach((entry, index) => validateManifestFile(entry, index, add));
    }
  }

  if (!Array.isArray(manifest.pages)) {
    add("manifest.pages", "pages must be an array.");
  } else {
    manifest.pages.forEach((entry, index) => validateManifestPage(entry, index, add));
  }

  return { ok: errors.length === 0, errors };
}

export function readSourceHtmlManifestFile(sourceRoot) {
  const manifestPath = resolve(sourceRoot, SOURCE_HTML_MANIFEST_REL_PATH);
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    return { manifest: null, path: null, warning: null, validation: null };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      manifest: null,
      path: manifestPath,
      warning: `Could not parse source-html manifest at ${manifestPath}: ${error.message}. Falling back to filesystem matching.`,
      validation: null,
    };
  }

  const validation = validateSourceHtmlManifest(manifest);
  if (!validation.ok) {
    const detail = validation.errors.map((error) => `[${error.code}] ${error.message}`).join("; ");
    return {
      manifest: null,
      path: manifestPath,
      warning: `Source-html manifest at ${manifestPath} failed ${SOURCE_HTML_MANIFEST_SCHEMA} validation: ${detail}. Falling back to filesystem matching.`,
      validation,
    };
  }
  return { manifest, path: manifestPath, warning: null, validation };
}

function validateManifestPage(entry, index, add) {
  const location = `manifest.pages[${index}]`;
  if (!isObject(entry)) {
    add(location, `${location} must be an object.`);
    return;
  }
  if (!isNonEmptyString(entry.page_id)) {
    add(`${location}.page_id`, `${location}.page_id is required and must be a non-empty string.`);
  }
  if (!isNonEmptyString(entry.path)) {
    add(`${location}.path`, `${location}.path is required and must be a non-empty string.`);
  }
  for (const field of ["page_type", "page_url"]) {
    if (entry[field] != null && !isNonEmptyString(entry[field])) {
      add(`${location}.${field}`, `${location}.${field} must be a non-empty string when present.`);
    }
  }
  if (entry.source_hash != null) {
    if (!isNonEmptyString(entry.source_hash) || !SOURCE_HASH_PATTERN.test(entry.source_hash)) {
      add(`${location}.source_hash`, `${location}.source_hash must be a 64-character lowercase sha256 hex string when present.`);
    }
  }
}

function validateProducerProvenance(provenance, add) {
  if (!isObject(provenance)) {
    add("manifest.producer_provenance", "producer_provenance must be an object when present.");
    return;
  }

  if (provenance.source_type != null && !isNonEmptyString(provenance.source_type)) {
    add("manifest.producer_provenance.source_type", "producer_provenance.source_type must be a non-empty string when present.");
  }
  if (provenance.screenshot_fallback_used != null && typeof provenance.screenshot_fallback_used !== "boolean") {
    add("manifest.producer_provenance.screenshot_fallback_used", "producer_provenance.screenshot_fallback_used must be a boolean when present.");
  }
  for (const field of ["generator_repo", "generator_version", "export_log", "figma_file_key", "material_fingerprint"]) {
    if (provenance[field] != null && !isNonEmptyString(provenance[field])) {
      add(`manifest.producer_provenance.${field}`, `producer_provenance.${field} must be a non-empty string when present.`);
    }
  }
  if (provenance.material_fingerprint != null && !SOURCE_HASH_PATTERN.test(provenance.material_fingerprint)) {
    add("manifest.producer_provenance.material_fingerprint", "producer_provenance.material_fingerprint must be a 64-character lowercase sha256 hex string when present.");
  }
  if (provenance.semantic_section_count != null && (!Number.isInteger(provenance.semantic_section_count) || provenance.semantic_section_count <= 0)) {
    add("manifest.producer_provenance.semantic_section_count", "producer_provenance.semantic_section_count must be a positive integer when present.");
  }
  if (provenance.breakpoint_image_count != null && (!Number.isInteger(provenance.breakpoint_image_count) || provenance.breakpoint_image_count < 0)) {
    add("manifest.producer_provenance.breakpoint_image_count", "producer_provenance.breakpoint_image_count must be a non-negative integer when present.");
  }
  if (provenance.figma_file_keys != null && !Array.isArray(provenance.figma_file_keys)) {
    add("manifest.producer_provenance.figma_file_keys", "producer_provenance.figma_file_keys must be an array when present.");
  }
  if (provenance.section_exports != null) {
    if (!Array.isArray(provenance.section_exports)) {
      add("manifest.producer_provenance.section_exports", "producer_provenance.section_exports must be an array when present.");
    } else {
      provenance.section_exports.forEach((entry, index) => validateSectionExport(entry, index, add));
    }
  }
}

function validateSectionExport(entry, index, add) {
  const location = `manifest.producer_provenance.section_exports[${index}]`;
  if (!isObject(entry)) {
    add(location, `${location} must be an object.`);
    return;
  }
  for (const field of ["section", "type"]) {
    if (!isNonEmptyString(entry[field])) {
      add(`${location}.${field}`, `${location}.${field} is required and must be a non-empty string.`);
    }
  }
  if (entry.node_ids != null && !isObject(entry.node_ids)) {
    add(`${location}.node_ids`, `${location}.node_ids must be an object when present.`);
  }
  for (const field of ["images", "warnings"]) {
    if (entry[field] != null && !Array.isArray(entry[field])) {
      add(`${location}.${field}`, `${location}.${field} must be an array when present.`);
    }
  }
}

function validateManifestFile(entry, index, add) {
  const location = `manifest.files[${index}]`;
  if (!isObject(entry)) {
    add(location, `${location} must be an object.`);
    return;
  }
  if (!isNonEmptyString(entry.path)) {
    add(`${location}.path`, `${location}.path is required and must be a non-empty string.`);
  }
  if (!isNonEmptyString(entry.role) || !FILE_ROLES.has(entry.role)) {
    add(`${location}.role`, `${location}.role is required and must be one of ${[...FILE_ROLES].join(", ")}.`);
  }
  if (!isNonEmptyString(entry.sha256) || !SOURCE_HASH_PATTERN.test(entry.sha256)) {
    add(`${location}.sha256`, `${location}.sha256 is required and must be a 64-character lowercase sha256 hex string.`);
  }
  if (entry.bytes != null && (!Number.isInteger(entry.bytes) || entry.bytes < 0)) {
    add(`${location}.bytes`, `${location}.bytes must be a non-negative integer when present.`);
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
