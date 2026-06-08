import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const SOURCE_HTML_MANIFEST_REL_PATH = ".campaigns-os/source-html-manifest.json";
export const SOURCE_HTML_MANIFEST_SCHEMA = "source-html-manifest/v0";

const SOURCE_HASH_PATTERN = /^[0-9a-f]{64}$/;

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

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
