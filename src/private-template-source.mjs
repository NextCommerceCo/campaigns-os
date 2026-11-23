// Private template family resolution: campaigns-os recognizes/certifies a
// private template family (its design, selectors, and business logic owned
// by a third-party repo, not this one) without that family's description
// ever being committed here. The public repo holds only a thin allowlist —
// contracts/private-template-sources.json — naming which families are
// private and which repo/package/path to read their contract fragment from.
// The fragment is resolved in-memory per run and never written back to disk.
//
// Where the fragment is read from, in order:
//   1. PRIVATE_TEMPLATE_SOURCES_ROOT, when set: the parent directory of a
//      checkout of the private repo. An explicit override; nothing else is
//      tried.
//   2. The private repo installed as a package (`npm install
//      git+ssh://git@github.com/<org>/<repo>.git`), found the way Node finds
//      any dependency: a node_modules/<package>/ directory in the working
//      directory or one of its parents (the campaign repo or workspace that
//      runs campaigns-os), then the same walk from this toolkit's own
//      install. The package is the allowlist entry's `package` (default: the
//      repo name). Access is whoever can clone the private repo; the version
//      is whatever the installing lockfile pins.
//   3. A sibling checkout of the private repo next to this toolkit's source
//      checkout (the source-checkout convention: sibling repos share a parent
//      directory).
// A runner with none of these cannot certify the family and gets a loud,
// specific error naming all three.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, parse as parsePath, resolve } from "node:path";
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

export const COMMERCE_CATALOG_FILE_NAME = "commerce-surface-catalog.json";

// The commerce catalog a packet reads. `assembly.commerce_catalog.path` is
// null when the packet was prepared against the toolkit's own catalog: that
// file ships with every install of the toolkit, so the packet does not record
// where one particular checkout kept it. A recorded path is an operator's
// explicit --commerce-catalog, resolved against the packet. A recorded path
// that no longer exists but names the catalog file is the pre-null shape:
// packets prepared before the catalog stopped being recorded wrote the
// toolkit's own file relative to the packet (a chain of ../ into the checkout
// that ran prepare-build), which is dead on any other machine or with the
// toolkit installed as a package. Readers resolve that to the running
// toolkit's catalog, and `source` says which of the four cases applied
// (toolkit_default, packet, stale_packet_path, missing_packet_path) so doctor
// can tell the operator without blocking.
export function resolvePacketCommerceCatalogPath(packetPath, catalogInfo = {}) {
  const recorded = typeof catalogInfo?.path === "string" && catalogInfo.path.length > 0 ? catalogInfo.path : null;
  if (!recorded) {
    return { path: defaultCommerceCatalogPath(), source: "toolkit_default", recorded: null };
  }
  const resolved = resolve(dirname(resolve(packetPath)), recorded);
  if (existsSync(resolved)) {
    return { path: resolved, source: "packet", recorded };
  }
  if (basename(recorded) === COMMERCE_CATALOG_FILE_NAME) {
    return { path: defaultCommerceCatalogPath(), source: "stale_packet_path", recorded };
  }
  // The operator named a file that is not there and is not the toolkit
  // catalog: keep the resolved path so the caller's missing-file check names
  // it, and say plainly that nothing resolved.
  return { path: resolved, source: "missing_packet_path", recorded };
}

// Overridable so tests can sandbox the allowlist against a fixture private
// source instead of mutating (or depending on) the real production file.
function privateTemplateSourcesPath() {
  return process.env.PRIVATE_TEMPLATE_SOURCES_PATH || join(ROOT, "contracts", "private-template-sources.json");
}

// No caching, recomputed per call — matches certifiedTemplateFamilies()'s
// existing convention (src/doctor/checks.mjs) so a long-lived process never serves a stale
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

// Base directory sibling repos are resolved under when the operator names
// one. One env var covers every private provider (there will be more than
// one over time) — mirrors the existing STARTER_TEMPLATES_PATH precedent
// (scripts/check-template-doctrine.mjs) generalized from "one specific
// sibling" to "wherever this environment keeps its siblings".
function explicitPrivateTemplateSourcesRoot() {
  return process.env.PRIVATE_TEMPLATE_SOURCES_ROOT || null;
}

// The final path segment of an "org/name" repo string. The allowlist is
// committed in-repo and human-reviewed before merge, so the repo, package and
// contract_path fields are trusted input, not attacker-controlled — no
// shape/traversal guard here by design.
function repoName(repo) {
  return String(repo || "").trim().split("/").pop() || null;
}

function packageName(entry) {
  return typeof entry?.package === "string" && entry.package.trim() ? entry.package.trim() : repoName(entry?.repo);
}

// Every node_modules/<package> directory Node would consider from `start`
// upward, nearest first.
function nodeModulesCandidates(start, pkg) {
  const candidates = [];
  let dir = resolve(start);
  const { root } = parsePath(dir);
  for (;;) {
    if (basename(dir) !== "node_modules") candidates.push(join(dir, "node_modules", pkg));
    if (dir === root) break;
    dir = dirname(dir);
  }
  return candidates;
}

// The places the fragment may live, in resolution order (see the module
// header). Each carries the `source` label reported back to callers.
function fragmentCandidates(entry) {
  const contractPath = typeof entry?.contract_path === "string" ? entry.contract_path : null;
  if (!contractPath) return [];
  const explicitRoot = explicitPrivateTemplateSourcesRoot();
  const name = repoName(entry.repo);
  if (explicitRoot) {
    return name ? [{ source: "private_template_sources_root", dir: join(explicitRoot, name), contractPath }] : [];
  }
  const candidates = [];
  const pkg = packageName(entry);
  if (pkg) {
    const seen = new Set();
    for (const base of [process.cwd(), ROOT]) {
      for (const dir of nodeModulesCandidates(base, pkg)) {
        if (seen.has(dir)) continue;
        seen.add(dir);
        candidates.push({ source: "installed_package", dir, contractPath });
      }
    }
  }
  if (name) candidates.push({ source: "sibling_checkout", dir: join(resolve(ROOT, ".."), name), contractPath });
  return candidates;
}

// Allowlist miss -> null (family isn't private; caller falls through to its
// own "unknown family" handling). Allowlist hit but no readable fragment ->
// throws, deliberately: a private family must fail loudly and specifically
// when it's actually needed, never silently read as "uncertified" — that's a
// confusing dead end for whoever hits it.
export function resolvePrivateTemplateSourceFragment(family) {
  const entry = loadPrivateTemplateSources()[family];
  if (!entry) return null;
  const found = fragmentCandidates(entry).find((candidate) => existsSync(join(candidate.dir, candidate.contractPath)));
  if (!found) {
    const pkg = packageName(entry) || "(unresolved)";
    const explicitRoot = explicitPrivateTemplateSourcesRoot();
    const where = explicitRoot
      ? `no checkout was found under PRIVATE_TEMPLATE_SOURCES_ROOT (${explicitRoot}/${repoName(entry.repo) || "(unresolved)"})`
      : `no checkout was found: no installed ${pkg} package (node_modules/${pkg}) from ${process.cwd()} or from this toolkit, and no sibling checkout at ${join(resolve(ROOT, ".."), repoName(entry.repo) || "(unresolved)")}`;
    throw privateTemplateSourceError(
      "private_source_not_checked_out",
      `Template family "${family}" is a private family sourced from ${entry.repo}, but ${where}. ` +
        `Install it next to campaigns-os with \`npm install --save-dev git+ssh://git@github.com/${entry.repo}.git\` (needs read access to ${entry.repo}), ` +
        `or set PRIVATE_TEMPLATE_SOURCES_ROOT to the parent directory of a ${entry.repo} checkout (works with an installed package). ` +
        `For a source checkout of campaigns-os, cloning ${entry.repo} as a sibling directory also works.`,
    );
  }
  const fragmentPath = join(found.dir, found.contractPath);
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
  return { catalogFamily: fragment.catalog_family || null, brandContract: fragment.brand_contract || null, fragmentPath, source: found.source };
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
