// Private template family resolution: campaigns-os recognizes/certifies a
// private template family (its design, selectors, and business logic owned
// by a third-party repo, not this one) without that family's description
// ever being committed here. The public repo holds only a thin allowlist —
// contracts/private-template-sources.json — naming which families are
// private and which repo/path to fetch their contract fragment from. The
// fragment is resolved in-memory per run and never written back to disk.
//
// v1 resolves only from a local sibling checkout (matches this environment's
// worktree convention: sibling repos share a parent directory). A hosted CI
// runner without that checkout simply cannot certify a private family today —
// that's an intentional v1 boundary, not an oversight; see the transfer
// packet this module implements.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTemplateBrandContract, resolveContractExtendsChain } from "./template-brand-contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PRIVATE_TEMPLATE_SOURCE_SCHEMA = "private-template-source/v0";
export const PRIVATE_TEMPLATE_SOURCE_FRAGMENT_SCHEMA = "private-template-source-fragment/v0";

// One JSON read + parse path for every file this module reads, so a malformed
// file surfaces as a structured parse_error (with the syntax error preserved
// as `cause`) instead of a bare SyntaxError — the same convention the on-disk
// brand-contract loader uses. Callers that want to swallow it (e.g.
// certifiedTemplateFamilies) still catch a throw; callers that surface
// diagnostics get a code to key on.
function readJsonFile(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw privateTemplateSourceError(
      "parse_error",
      `${what} ${path} failed to parse: ${error instanceof Error ? error.message : String(error)}.`,
      error,
    );
  }
}

export function defaultCommerceCatalogPath() {
  return join(ROOT, "contracts", "commerce-surface-catalog.json");
}

// Overridable so tests can sandbox the allowlist against a fixture private
// source instead of mutating (or depending on) the real production file.
function privateTemplateSourcesPath() {
  return process.env.PRIVATE_TEMPLATE_SOURCES_PATH || join(ROOT, "contracts", "private-template-sources.json");
}

// No caching, recomputed per call — matches certifiedTemplateFamilies()'s
// existing convention (cli.mjs) so a long-lived process never serves a stale
// allowlist after an edit.
export function loadPrivateTemplateSources() {
  const path = privateTemplateSourcesPath();
  if (!existsSync(path)) return {};
  const parsed = readJsonFile(path, "Private template source allowlist");
  if (!isPlainObject(parsed) || parsed.schema_version !== PRIVATE_TEMPLATE_SOURCE_SCHEMA) {
    throw privateTemplateSourceError(
      "schema_mismatch",
      `Private template source allowlist ${path} has schema_version "${parsed?.schema_version}"; expected "${PRIVATE_TEMPLATE_SOURCE_SCHEMA}".`,
    );
  }
  return isPlainObject(parsed.sources) ? parsed.sources : {};
}

// Base directory sibling repos are resolved under. One env var covers every
// private provider (there will be more than one over time) — mirrors the
// existing STARTER_TEMPLATES_PATH precedent (scripts/check-template-doctrine.mjs)
// generalized from "one specific sibling" to "wherever this environment keeps
// its siblings".
function privateTemplateSourcesRoot() {
  return process.env.PRIVATE_TEMPLATE_SOURCES_ROOT || resolve(ROOT, "..");
}

// The sibling checkout directory for a "org/name" repo string: only the final
// path segment (the repo name) is used as the directory; the org is metadata.
// The allowlist is committed in-repo and human-reviewed before merge, so the
// repo/contract_path fields are trusted input, not attacker-controlled — no
// shape/traversal guard here by design (see the module header's v1 boundary).
function siblingRepoDir(repo) {
  const name = String(repo || "").trim().split("/").pop();
  return name ? join(privateTemplateSourcesRoot(), name) : null;
}

// Allowlist miss -> null (family isn't private; caller falls through to its
// own "unknown family" handling). Allowlist hit but no local checkout ->
// throws, deliberately: a private family must fail loudly and specifically
// when it's actually needed, never silently read as "uncertified" — that's a
// confusing dead end for whoever hits it.
export function resolvePrivateTemplateSourceFragment(family) {
  const entry = loadPrivateTemplateSources()[family];
  if (!entry) return null;
  const repoDir = siblingRepoDir(entry.repo);
  const fragmentPath = repoDir && typeof entry.contract_path === "string" ? join(repoDir, entry.contract_path) : null;
  if (!fragmentPath || !existsSync(fragmentPath)) {
    throw privateTemplateSourceError(
      "private_source_not_checked_out",
      `Template family "${family}" is a private family sourced from ${entry.repo}, but no checkout was found at ` +
        `${repoDir || "(unresolved)"}. Clone ${entry.repo} as a sibling directory (or set PRIVATE_TEMPLATE_SOURCES_ROOT) to resolve it.`,
    );
  }
  const fragment = readJsonFile(fragmentPath, "Private template source fragment");
  if (!isPlainObject(fragment) || fragment.schema_version !== PRIVATE_TEMPLATE_SOURCE_FRAGMENT_SCHEMA) {
    throw privateTemplateSourceError(
      "schema_mismatch",
      `Private template source fragment ${fragmentPath} has schema_version "${fragment?.schema_version}"; expected "${PRIVATE_TEMPLATE_SOURCE_FRAGMENT_SCHEMA}".`,
    );
  }
  if (fragment.family !== family) {
    throw privateTemplateSourceError(
      "family_mismatch",
      `Private template source fragment ${fragmentPath} declares family "${fragment.family}"; expected "${family}".`,
    );
  }
  return { catalogFamily: fragment.catalog_family || null, brandContract: fragment.brand_contract || null, fragmentPath };
}

// Enriches the raw commerce catalog with private family entries. The returned
// object carries an extra `_private_source_warnings` array (not present in the
// raw catalog) documenting any private-source fetch errors encountered while
// building the merged family map — callers that spread or JSON.stringify the
// result will see this key; callers that only read `.families` are unaffected.
// Private-source fetch errors are collected as warnings, never thrown here — a
// public-family run must not fail just because some other private repo isn't
// checked out locally. Only resolveTemplateBrandContract (below), for that
// specific family, throws.
export function resolveCommerceCatalog(catalogPath = defaultCommerceCatalogPath()) {
  const catalog = existsSync(catalogPath) ? readJsonFile(catalogPath, "Commerce surface catalog") : { families: {} };
  // Valid JSON that isn't an object (null / array / scalar) would make
  // `catalog.families` throw a raw TypeError; surface it as the same
  // structured schema_mismatch the allowlist/fragment reads already use.
  if (!isPlainObject(catalog)) {
    throw privateTemplateSourceError(
      "schema_mismatch",
      `Commerce catalog ${catalogPath} is not a JSON object.`,
    );
  }
  const families = { ...(catalog.families || {}) };
  const warnings = [];
  for (const family of Object.keys(loadPrivateTemplateSources())) {
    if (Object.prototype.hasOwnProperty.call(families, family)) continue;
    try {
      const fragment = resolvePrivateTemplateSourceFragment(family);
      if (fragment?.catalogFamily) families[family] = fragment.catalogFamily;
    } catch (error) {
      warnings.push({ family, code: error.code || "load_error", message: error.message });
    }
  }
  return { ...catalog, families, _private_source_warnings: warnings };
}

// Drop-in for loadTemplateBrandContract(family): tries the public loader
// first (zero behavior change for public families), then falls back to a
// privately-sourced fragment, run through the SAME extends/merge chain
// template-brand-contract.mjs already uses — `dir` is this repo's own
// contracts/ directory, since a private family's `extends` (e.g.
// "template-brand-contract.shared-commerce.v0.json") points at a genuinely
// shared, public file that lives here, not in the private repo.
//
// If a public contract file exists but fails to parse/validate, the error is
// caught and a private fragment is tried as a fallback (a corrected private
// fragment resolves even when a stale public stub is still on disk). Error
// precedence when the public load failed: if the family is NOT privately
// allowlisted, the original public error is re-thrown so the operator sees the
// root cause; if it IS allowlisted but fragment resolution itself throws (e.g.
// the sibling checkout is missing), that more-specific error surfaces instead.
export function resolveTemplateBrandContract(family) {
  let publicContract = null;
  let publicError = null;
  try {
    publicContract = loadTemplateBrandContract(family);
  } catch (err) {
    publicError = err;
  }
  if (publicContract) return publicContract;
  const fragment = resolvePrivateTemplateSourceFragment(family);
  if (!fragment?.brandContract) {
    if (publicError) throw publicError;
    return null;
  }
  const contract = resolveContractExtendsChain(fragment.brandContract, {
    dir: join(ROOT, "contracts"),
    label: fragment.fragmentPath,
  });
  if (contract.family !== family) {
    throw privateTemplateSourceError(
      "family_mismatch",
      `Private template brand contract ${fragment.fragmentPath} declares family "${contract.family}"; expected "${family}".`,
    );
  }
  return contract;
}

function privateTemplateSourceError(code, message, cause = undefined) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
