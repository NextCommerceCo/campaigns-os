/**
 * Shared reader and verifier for the declarative runtime-readiness recipe.
 *
 * This module is repository implementation, exactly like scripts/orientation-contract.mjs:
 * it is not exported, not on the supported surface, and nothing a consumer installs
 * depends on it. Campaigns OS publishes the recipe as data; the installed consumer
 * bootstrap executes it. Nothing here executes a recipe step.
 *
 * Everything below reads its values from contracts/runtime-recipe.campaigns-os-node-v1.json.
 * No command, bound, version range, input path, or output rule is written as a literal in
 * this file, because the contract's own _note makes it the only authority for all of them.
 */

import { createHash } from "node:crypto";

export const RECIPE_PATH = "contracts/runtime-recipe.campaigns-os-node-v1.json";
export const RECIPE_SCHEMA_PATH = "schemas/campaigns-os-runtime-recipe.v1.schema.json";
export const FIXTURE_DIR = "contracts/fixtures/runtime-recipe";
export const FIXTURE_MANIFEST_PATH = `${FIXTURE_DIR}/manifest.json`;
export const READINESS_DOC_PATH = "docs/runtime-readiness.md";
export const HOSTILE_FIXTURE_MANIFEST_PATH = "contracts/fixtures/orientation/hostile-target/manifest.json";
export const HOSTILE_FIXTURE_ROOT = "contracts/fixtures/orientation/hostile-target";

export const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

/* ------------------------------------------------------------------ */
/* Reading the contract                                                */
/* ------------------------------------------------------------------ */

/** The step with this id, or undefined. Steps are identified, never positional. */
export const stepById = (recipe, id) => (recipe.steps ?? []).find((step) => step.id === id);

/** The exact argv a consumer executes for one step, executable first. */
export function stepArgv(recipe, id) {
  const step = stepById(recipe, id);
  if (!step) throw new Error(`${RECIPE_PATH}: no step with id ${JSON.stringify(id)}`);
  return [step.executable, ...step.args];
}

/** The input paths that are compiler sources, i.e. those under the module source root. */
export function moduleInputs(recipe) {
  const root = recipe.outputs.module_source_root;
  return (recipe.inputs?.files ?? []).filter((path) => path.startsWith(root) && path.endsWith(".ts"));
}

/**
 * The expected output inventory, DERIVED from the enumerated inputs rather than
 * listed a second time. A duplicated inventory is a literal that rots out of step
 * with the inputs that produce it, which is the exact failure the contract's
 * expected_module_derivation rule exists to avoid.
 */
export function expectedOutputInventory(recipe) {
  const root = recipe.outputs.module_source_root;
  const dir = recipe.outputs.directory;
  const extensions = recipe.outputs.expected_module_derivation.emitted_extensions;
  const out = [];
  for (const input of moduleInputs(recipe)) {
    const stem = input.slice(root.length).replace(/\.ts$/, "");
    for (const extension of extensions) out.push(`${dir}/${stem}${extension}`);
  }
  return out.sort();
}

/** sha256 over the enumerated input set: each path, then its bytes, in enumeration order. */
export function fingerprintInputs(recipe, readFileBytes) {
  if (recipe.inputs.fingerprint_algorithm !== "sha256") {
    throw new Error(`${RECIPE_PATH}: unsupported fingerprint algorithm ${recipe.inputs.fingerprint_algorithm}`);
  }
  const hash = createHash("sha256");
  for (const path of recipe.inputs.files) {
    const bytes = readFileBytes(path);
    if (bytes === null || bytes === undefined) throw new Error(`${RECIPE_PATH}: declared input is missing: ${path}`);
    hash.update(path);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/* ------------------------------------------------------------------ */
/* Version comparison                                                  */
/* ------------------------------------------------------------------ */

/**
 * Anchored at both ends on purpose. An unanchored pattern parses `22.0.0-rc.1` as
 * the tuple [22, 0, 0], so a prerelease would satisfy an accepted range on the
 * strength of its numeric prefix alone. Neither Node nor npm ships prereleases to
 * consumers by default today, so this costs nothing now and fails closed the day
 * one appears: an unparseable version is treated as outside every range.
 */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function versionTuple(version) {
  const match = SEMVER.exec(String(version ?? "").trim().replace(/^v/, ""));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Is `version` inside the declared range? Unparseable or absent counts as OUTSIDE,
 * per unperformable_check_disposition: a version we cannot read is not a version we
 * can approve.
 */
export function versionInRange(version, range) {
  const actual = versionTuple(version);
  if (!actual) return false;
  if (range.min_inclusive && compare(actual, versionTuple(range.min_inclusive)) < 0) return false;
  if (range.max_exclusive && compare(actual, versionTuple(range.max_exclusive)) >= 0) return false;
  if (Array.isArray(range.accepted_majors) && !range.accepted_majors.includes(actual[0])) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Output verification                                                 */
/* ------------------------------------------------------------------ */

const PASSED = "passed";
const FAILED = "failed";

const result = (check, status, detected, messages) => ({
  id: check.id,
  kind: check.kind,
  status,
  detected,
  messages,
});

/**
 * Run every mandatory output check the recipe declares against one observation of
 * a prepared generation. Pure: no filesystem, no subprocess, no clock. The caller
 * supplies both what the build recorded and what is observable now.
 *
 * `observation` fields:
 *   dist              { path -> { sha256, bytes } } observed under outputs.directory
 *   recorded          { input_fingerprint, file_hashes { path -> sha256 } } from the generation manifest
 *   current_input_fingerprint   the same digest recomputed at the target commit
 *   import_smoke      { attempted, ok, error }
 *   tools             { node, npm } that actually executed the steps
 *   generation        { cli_path, skills_path, cli_oid, skills_oid }
 *
 * A field that is absent, non-finite, or unreadable makes its check FAIL rather
 * than skip — the contract's unperformable_check_disposition, carried over from the
 * orientation limits, where an absent measurement counts as exceeded.
 */
export function verifyPreparedRuntime(recipe, observation) {
  const expected = expectedOutputInventory(recipe);
  const bounds = recipe.bounds;
  const results = [];

  for (const check of recipe.outputs.checks) {
    results.push(runCheck(check, { recipe, expected, bounds, observation }));
  }

  const failures = results.filter((entry) => entry.status === FAILED);
  return {
    ok: failures.length === 0,
    results,
    failures,
    detected: [...new Set(failures.flatMap((entry) => entry.detected))].sort(),
    refusal_reason_code: failures.length ? recipe.refusal_reason_code : null,
  };
}

function runCheck(check, context) {
  switch (check.kind) {
    case "dist_inventory":
      return checkInventory(check, context);
    case "content_hash_stability":
      return checkHashes(check, context);
    case "module_import_smoke":
      return checkImportSmoke(check, context);
    case "type_entry_presence":
      return checkTypeEntry(check, context);
    case "cli_skill_commit_agreement":
      return checkGenerationAgreement(check, context);
    case "tool_versions":
      return checkToolVersions(check, context);
    case "input_fingerprint":
      return checkInputFingerprint(check, context);
    default:
      // Fail closed. A check kind this build does not know how to perform cannot
      // be skipped; the schema's enum should have refused the document already.
      return result(check, FAILED, ["absent"], [`unknown output check kind ${JSON.stringify(check.kind)} — cannot be performed, and an unperformable check counts as failed`]);
  }
}

function checkInventory(check, { expected, bounds, observation }) {
  const dist = observation.dist;
  if (!dist || typeof dist !== "object") {
    return result(check, FAILED, ["absent"], ["no output inventory was observed — the output directory is absent or unreadable"]);
  }
  const actual = Object.keys(dist).sort();
  if (actual.length === 0) return result(check, FAILED, ["absent"], ["the output directory is empty"]);

  const messages = [];
  const detected = [];
  const missing = expected.filter((path) => !(path in dist));
  const extra = actual.filter((path) => !expected.includes(path));
  if (missing.length) {
    detected.push("absent");
    messages.push(`${missing.length} expected output(s) missing, first: ${missing[0]}`);
  }
  if (extra.length) {
    detected.push("extra");
    messages.push(`${extra.length} unexpected output(s) present, first: ${extra[0]}`);
  }

  const totalBytes = actual.reduce((sum, path) => sum + (Number(dist[path]?.bytes) || 0), 0);
  for (const [name, measured] of [
    ["max_output_files", actual.length],
    ["max_output_bytes", totalBytes],
  ]) {
    const bound = bounds[name];
    if (!bound) {
      detected.push("absent");
      messages.push(`no ${name} bound is declared, so the measurement cannot be judged`);
      continue;
    }
    if (!Number.isFinite(measured)) {
      detected.push("absent");
      messages.push(`${name} could not be measured, which counts as exceeded`);
      continue;
    }
    if (measured > bound.value) {
      detected.push("extra");
      messages.push(`${name} exceeded: ${measured} ${bound.unit} against a bound of ${bound.value}`);
    }
  }

  return messages.length ? result(check, FAILED, [...new Set(detected)], messages) : result(check, PASSED, [], []);
}

function checkHashes(check, { observation }) {
  const recorded = observation.recorded?.file_hashes;
  const dist = observation.dist;
  if (!recorded || !dist) {
    return result(check, FAILED, ["corrupt"], ["no recorded output hashes to compare against — the check cannot be performed, which counts as failed"]);
  }
  const messages = [];
  for (const [path, digest] of Object.entries(recorded)) {
    const observed = dist[path]?.sha256;
    if (!observed) {
      messages.push(`${path}: recorded at build time but absent now`);
      continue;
    }
    if (observed !== digest) messages.push(`${path}: content changed since the build recorded it`);
  }
  return messages.length ? result(check, FAILED, ["corrupt"], messages) : result(check, PASSED, [], []);
}

function checkImportSmoke(check, { observation }) {
  const smoke = observation.import_smoke;
  if (!smoke || smoke.attempted !== true) {
    return result(check, FAILED, ["corrupt"], ["the entry-module import was not attempted — an unperformable check counts as failed"]);
  }
  if (smoke.ok !== true) {
    return result(check, FAILED, ["corrupt"], [`the entry module did not import: ${smoke.error ?? "no error reported"}`]);
  }
  return result(check, PASSED, [], []);
}

function checkTypeEntry(check, { recipe, observation }) {
  const path = recipe.outputs.type_entry;
  const entry = observation.dist?.[path];
  if (!entry) return result(check, FAILED, ["absent"], [`${path}: type entry is absent`]);
  if (!Number.isFinite(Number(entry.bytes)) || Number(entry.bytes) <= 0) {
    return result(check, FAILED, ["absent"], [`${path}: type entry is present but empty or unmeasurable`]);
  }
  return result(check, PASSED, [], []);
}

/**
 * Containment with a separator boundary. A bare startsWith would accept
 * `/gen/00010/skills` as living below `/gen/0001`, which is a sibling generation
 * root, not a child — exactly the mismatch this check exists to catch.
 */
function isBelow(child, parent) {
  const norm = (p) => String(p).replace(/\/+$/, "");
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}/`);
}

function checkGenerationAgreement(check, { observation }) {
  const generation = observation.generation;
  if (!generation) {
    return result(check, FAILED, ["mismatched_generation"], ["no generation identity was observed — an unperformable check counts as failed"]);
  }
  const messages = [];
  for (const field of ["cli_path", "skills_path", "cli_oid", "skills_oid"]) {
    if (!generation[field]) messages.push(`generation.${field} is absent`);
  }
  if (!messages.length) {
    if (generation.cli_oid !== generation.skills_oid) {
      messages.push(`the executable and the skills tree resolve to different target OIDs (${generation.cli_oid} vs ${generation.skills_oid})`);
    }
    if (!isBelow(generation.skills_path, generation.cli_path)) {
      messages.push(`the skills tree (${generation.skills_path}) does not resolve below the executable's generation path (${generation.cli_path})`);
    }
  }
  return messages.length ? result(check, FAILED, ["mismatched_generation"], messages) : result(check, PASSED, [], []);
}

function checkToolVersions(check, { recipe, observation }) {
  const tools = observation.tools ?? {};
  const messages = [];
  for (const [name, range] of [
    ["node", recipe.tooling.node],
    ["npm", recipe.tooling.npm],
  ]) {
    const version = tools[name];
    if (!version) {
      messages.push(`${name}: no version was observed, which counts as out of range`);
      continue;
    }
    if (!versionInRange(version, range)) messages.push(`${name} ${version} is outside the accepted range ${range.range}`);
  }
  return messages.length ? result(check, FAILED, ["unsupported_tooling"], messages) : result(check, PASSED, [], []);
}

function checkInputFingerprint(check, { observation }) {
  const recorded = observation.recorded?.input_fingerprint;
  const current = observation.current_input_fingerprint;
  if (!recorded || !current) {
    return result(check, FAILED, ["stale"], ["an input fingerprint is missing on one side, so staleness cannot be ruled out — which counts as failed"]);
  }
  if (recorded !== current) {
    return result(check, FAILED, ["stale"], [`the inputs at the target commit no longer match the inputs recorded at build time (recorded ${recorded.slice(0, 12)}, current ${current.slice(0, 12)})`]);
  }
  return result(check, PASSED, [], []);
}
