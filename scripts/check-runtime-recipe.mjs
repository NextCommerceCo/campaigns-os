#!/usr/bin/env node

/**
 * Runtime-recipe gate: contracts/runtime-recipe.campaigns-os-node-v1.json declares how a
 * checkout of this repository becomes a usable installed runtime, and this check makes
 * every one of those declarations answerable against the repository as it actually is.
 *
 * Why it exists: a recipe is only worth anything if it is TRUE. The failure mode is not a
 * malformed document — the schema catches that — it is a well-formed document that has
 * quietly stopped describing the repository: a build script rewritten, an engine range
 * widened, a module added to the compilation, a dependency that now ships an install
 * script. Each of those changes what preparation does while the contract keeps claiming
 * otherwise, and none of them is visible to a schema.
 *
 * What it enforces:
 *   - schema:        the recipe validates against schemas/campaigns-os-runtime-recipe.v1.schema.json;
 *   - internal:      every step is bounded and has a network policy, every declared bound
 *                    is referenced, and the mandatory checks between them cover all four
 *                    prepared-runtime failure modes;
 *   - target:        the target's engines, lockfile version, package scripts, and set of
 *                    install-scripted dependencies match what the recipe says it assumed;
 *   - inputs:        the compiler's RESOLVED file set equals the enumerated input set.
 *                    Resolved, not globbed: the config's include globs are not the input
 *                    set, and a check that compared globs would agree with a fingerprint
 *                    that covers a subset of what is actually compiled;
 *   - authority:     no other tracked file repeats a recipe command verbatim, so the
 *                    contract stays the only place a command is written down;
 *   - fixtures:      every accept fixture validates and every reject fixture is refused;
 *   - surface:       the recipe and its schema are HASHED entries and the guide and
 *                    fixtures are named entries, so none of it can be born unsupported.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  FIXTURE_DIR,
  FIXTURE_MANIFEST_PATH,
  HOSTILE_FIXTURE_MANIFEST_PATH,
  READINESS_DOC_PATH,
  RECIPE_PATH,
  RECIPE_SCHEMA_PATH,
  stepArgv,
} from "./runtime-recipe.mjs";

// fileURLToPath, never URL.pathname — see check-supported-surface.mjs.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SURFACE_PATH = "contracts/supported-surface.json";

const readText = (path) => readFileSync(join(root, path), "utf8");
const readJson = (path) => JSON.parse(readText(path));

/* ------------------------------------------------------------------ */
/* Internal coherence                                                  */
/* ------------------------------------------------------------------ */

/** The four prepared-runtime failure modes the check set must cover between them. */
export const REQUIRED_DETECTIONS = ["absent", "corrupt", "extra", "stale"];

export function validateInternalCoherence(recipe) {
  const errors = [];
  const bounds = Object.keys(recipe.bounds ?? {});
  const stepIds = (recipe.steps ?? []).map((step) => step.id);

  const duplicates = stepIds.filter((id, index) => stepIds.indexOf(id) !== index);
  if (duplicates.length) errors.push(`${RECIPE_PATH}: duplicate step id(s) ${[...new Set(duplicates)].join(", ")} — steps are identified, not positional`);

  for (const step of recipe.steps ?? []) {
    if (!bounds.includes(step.timeout_bound)) {
      errors.push(`${RECIPE_PATH}: step ${step.id} names timeout_bound ${JSON.stringify(step.timeout_bound)}, which is not a declared bound`);
    }
    if (!recipe.network?.per_step?.[step.id]) {
      errors.push(`${RECIPE_PATH}: step ${step.id} has no declared network policy — a step with no policy is unbounded access nobody approved`);
    }
  }
  for (const id of Object.keys(recipe.network?.per_step ?? {})) {
    if (!stepIds.includes(id)) errors.push(`${RECIPE_PATH}: network.per_step declares a policy for ${JSON.stringify(id)}, which is not a step`);
  }

  // A bound nobody references and nothing measures is a number with no effect.
  const referenced = new Set([...(recipe.steps ?? []).map((step) => step.timeout_bound), "transaction_seconds", "max_output_bytes", "max_output_files"]);
  for (const name of bounds) {
    if (!referenced.has(name)) errors.push(`${RECIPE_PATH}: bound ${name} is declared but nothing references it`);
  }

  const detected = new Set((recipe.outputs?.checks ?? []).flatMap((check) => check.detects ?? []));
  for (const mode of REQUIRED_DETECTIONS) {
    if (!detected.has(mode)) {
      errors.push(`${RECIPE_PATH}: no declared output check detects ${JSON.stringify(mode)} — the mandatory set must cover ${REQUIRED_DETECTIONS.join(", ")}`);
    }
  }

  const checkIds = (recipe.outputs?.checks ?? []).map((check) => check.id);
  const duplicateChecks = checkIds.filter((id, index) => checkIds.indexOf(id) !== index);
  if (duplicateChecks.length) errors.push(`${RECIPE_PATH}: duplicate output-check id(s) ${[...new Set(duplicateChecks)].join(", ")}`);

  return errors;
}

/* ------------------------------------------------------------------ */
/* Agreement with the target                                           */
/* ------------------------------------------------------------------ */

export function validateTargetAgreement(recipe, { packageJson, lockfile }) {
  const errors = [];
  const expectations = recipe.target_expectations;
  const refuse = (message) => errors.push(`${RECIPE_PATH}: ${message} — on_disagreement is ${JSON.stringify(recipe.tooling.on_disagreement)}, so revise the recipe (a revision plus a release-ledger entry) rather than widening it silently`);

  const observedEngines = packageJson?.engines?.node;
  if (observedEngines !== recipe.tooling.target_engines.observed) {
    refuse(`the target declares ${recipe.tooling.target_engines.field} as ${JSON.stringify(observedEngines)}, but the recipe was authored against ${JSON.stringify(recipe.tooling.target_engines.observed)}`);
  }

  for (const [name, expected] of Object.entries(expectations.scripts)) {
    const actual = packageJson?.scripts?.[name];
    if (actual === undefined) refuse(`the target no longer declares the ${JSON.stringify(name)} package script the recipe depends on`);
    else if (actual !== expected) refuse(`package script ${JSON.stringify(name)} is ${JSON.stringify(actual)}, but the recipe was authored against ${JSON.stringify(expected)}`);
  }

  // The build step's script name is read off the argv, never written down twice.
  const buildScript = stepArgv(recipe, "build").at(-1);
  if (!(buildScript in (packageJson?.scripts ?? {}))) {
    refuse(`the build step runs the ${JSON.stringify(buildScript)} package script, which the target does not declare`);
  }

  if (lockfile === null) {
    refuse(`the declared lockfile ${expectations.lockfile.path} is absent, so the install step has nothing authoritative to install from`);
  } else {
    if (lockfile.lockfileVersion !== expectations.lockfile.lockfile_version) {
      refuse(`the lockfile is version ${lockfile.lockfileVersion}, but the recipe was authored against version ${expectations.lockfile.lockfile_version}`);
    }
    const integrityPinned = Object.entries(lockfile.packages ?? {}).some(([name, entry]) => name && typeof entry?.integrity === "string");
    if (expectations.lockfile.integrity_pinned && !integrityPinned) {
      refuse("the recipe claims the lockfile pins integrity digests, but no package entry carries one");
    }
    const withInstallScripts = Object.entries(lockfile.packages ?? {})
      .filter(([, entry]) => entry?.hasInstallScript)
      .map(([name]) => name.replace(/^node_modules\//, ""))
      .sort();
    const declared = [...expectations.install_script_dependencies].sort();
    if (JSON.stringify(withInstallScripts) !== JSON.stringify(declared)) {
      refuse(
        `the resolved dependency set declares install scripts for [${withInstallScripts.join(", ")}], but the recipe was authored against [${declared.join(", ")}]. ` +
          "A new install-scripted dependency is code that would run the moment the suppressing flag was dropped, so it is a reviewed change rather than a silent one",
      );
    }
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/* The resolved input set                                              */
/* ------------------------------------------------------------------ */

/**
 * Ask the compiler which files it actually reads, rather than trusting the config's
 * include globs. Two of this repository's compiled root modules enter transitively
 * through imports and appear in no glob, so a glob-derived input set would fingerprint
 * a strict subset of what is compiled and would still look correct.
 */
export function resolveCompilerInputs(tsconfigPath, { runTsc = defaultRunTsc } = {}) {
  const prefix = `${root}/`;
  return runTsc(tsconfigPath)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length))
    .filter((path) => !path.startsWith("node_modules/"))
    .sort();
}

function defaultRunTsc(tsconfigPath) {
  const tsc = join(root, "node_modules", ".bin", "tsc");
  if (!existsSync(tsc)) throw new Error("the TypeScript compiler is not installed — run the install step before this gate");
  return execFileSync(tsc, ["-p", tsconfigPath, "--listFilesOnly"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

export function validateInputSet(recipe, resolvedSources) {
  const errors = [];
  const declared = recipe.inputs.files;
  const root_ = recipe.outputs.module_source_root;

  const declaredSources = declared.filter((path) => path.startsWith(root_) && path.endsWith(".ts")).sort();
  const missing = resolvedSources.filter((path) => !declaredSources.includes(path));
  const extra = declaredSources.filter((path) => !resolvedSources.includes(path));
  if (missing.length) {
    errors.push(
      `${RECIPE_PATH}: the compiler resolves ${missing.length} source file(s) the input set does not enumerate (${missing.join(", ")}). ` +
        "A fingerprint over the declared set would not see a change to these, so staleness in them would be undetectable",
    );
  }
  if (extra.length) {
    errors.push(`${RECIPE_PATH}: the input set enumerates ${extra.length} source file(s) the compiler does not read (${extra.join(", ")})`);
  }

  const sorted = [...declared].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(declared)) {
    errors.push(`${RECIPE_PATH}: inputs.files must be sorted, so a diff of the input set is readable`);
  }
  for (const path of declared) {
    if (!existsSync(join(root, path))) errors.push(`${RECIPE_PATH}: declared input ${path} does not exist`);
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* Single authority                                                    */
/* ------------------------------------------------------------------ */

/**
 * The contract says no checker, schema, document, or test may carry its own copy of a
 * command. Enforce it literally: the exact command line may appear only in the contract,
 * in files generated from it, and in the release record that narrates it. Everything else
 * — including every test in this repository — has to read the argv from the contract.
 */
export const COMMAND_AUTHORITY_ALLOWLIST = [
  RECIPE_PATH,
  READINESS_DOC_PATH,
  "CHANGELOG.md",
  "contracts/release-ledger.json",
  `${FIXTURE_DIR}/`,
];

export function validateCommandAuthority(recipe, trackedFiles, readFileText) {
  const errors = [];
  const commands = (recipe.steps ?? []).map((step) => stepArgv(recipe, step.id).join(" "));
  for (const path of trackedFiles) {
    if (COMMAND_AUTHORITY_ALLOWLIST.some((allowed) => (allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed))) continue;
    let text;
    try {
      text = readFileText(path);
    } catch {
      continue; // unreadable or binary; nothing to match
    }
    for (const command of commands) {
      if (text.includes(command)) {
        errors.push(`${path}: repeats the recipe command \`${command}\` verbatim — read it from ${RECIPE_PATH} instead, so the contract stays the only authority for it`);
      }
    }
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

export function validateFixtures(manifest, schema, loadFixture) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);
  const errors = [];

  if (!manifest.accept?.length) errors.push(`${FIXTURE_MANIFEST_PATH}: no accept fixtures — a reject-only suite cannot tell refusal apart from always failing`);
  if (!manifest.reject?.length) errors.push(`${FIXTURE_MANIFEST_PATH}: no reject fixtures`);

  for (const entry of manifest.accept ?? []) {
    const document = loadFixture(entry.path);
    if (!validate(document)) {
      errors.push(`${FIXTURE_DIR}/${entry.path}: expected to validate, but did not — ${validate.errors.map((e) => `${e.instancePath} ${e.message}`).join("; ")}`);
    }
  }
  for (const entry of manifest.reject ?? []) {
    const document = loadFixture(entry.path);
    if (validate(document)) {
      errors.push(`${FIXTURE_DIR}/${entry.path}: expected to be refused, but validates — the mutation no longer proves anything`);
    }
    if (!entry.why?.trim()) errors.push(`${FIXTURE_MANIFEST_PATH}: reject fixture ${entry.path} has no stated reason`);
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* Supported-surface registration                                      */
/* ------------------------------------------------------------------ */

export function validateSurfaceRegistration(surface, { fixturePaths, hostileFixturePaths }) {
  const errors = [];
  for (const path of [RECIPE_PATH, RECIPE_SCHEMA_PATH]) {
    if (!(path in (surface.hashed ?? {}))) {
      errors.push(
        `${SURFACE_PATH}: ${path} must be a HASHED entry, not a named one. Any change to the commands, network policy, tool versions, inputs, or output ` +
          "verification is an agent-relevant release event, and only a hashed entry makes such a change require surface_version to advance in the same change",
      );
    }
  }
  const named = new Set(surface.named ?? []);
  for (const path of [READINESS_DOC_PATH, ...fixturePaths, ...hostileFixturePaths]) {
    if (!named.has(path)) errors.push(`${SURFACE_PATH}: ${path} is consumer-facing but is not a named surface entry, so it would be born unsupported`);
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* Drive                                                               */
/* ------------------------------------------------------------------ */

function git(...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  const recipe = readJson(RECIPE_PATH);
  const schema = readJson(RECIPE_SCHEMA_PATH);
  const surface = readJson(SURFACE_PATH);
  const packageJson = readJson("package.json");
  const manifest = readJson(FIXTURE_MANIFEST_PATH);
  const hostile = readJson(HOSTILE_FIXTURE_MANIFEST_PATH);

  const errors = [];

  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  if (!validate(recipe)) {
    for (const error of validate.errors) errors.push(`${RECIPE_PATH}${error.instancePath}: ${error.message}`);
  }

  errors.push(...validateInternalCoherence(recipe));

  const lockfilePath = recipe.target_expectations.lockfile.path;
  const lockfile = existsSync(join(root, lockfilePath)) ? readJson(lockfilePath) : null;
  errors.push(...validateTargetAgreement(recipe, { packageJson, lockfile }));

  errors.push(...validateInputSet(recipe, resolveCompilerInputs("campaign-spec/tsconfig.build.json")));

  const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
  errors.push(...validateCommandAuthority(recipe, tracked, (path) => readText(path)));

  errors.push(...validateFixtures(manifest, schema, (relative) => readJson(`${FIXTURE_DIR}/${relative}`)));

  const fixturePaths = [
    FIXTURE_MANIFEST_PATH,
    `${FIXTURE_DIR}/${manifest.prepared_runtime_states}`,
    ...(manifest.accept ?? []).map((entry) => `${FIXTURE_DIR}/${entry.path}`),
    ...(manifest.reject ?? []).map((entry) => `${FIXTURE_DIR}/${entry.path}`),
  ];
  const hostileRoot = HOSTILE_FIXTURE_MANIFEST_PATH.replace(/\/manifest\.json$/, "");
  const hostileFixturePaths = [
    ...(hostile.tripwires ?? []).map((entry) => `${hostileRoot}/${entry.path}`),
    ...(hostile.intended_scripts ?? []).map((entry) => `${hostileRoot}/${entry.path}`),
  ];
  errors.push(...validateSurfaceRegistration(surface, { fixturePaths, hostileFixturePaths }));

  for (const path of [...fixturePaths, ...hostileFixturePaths]) {
    if (!existsSync(join(root, path))) errors.push(`${path}: enumerated in a fixture manifest but absent from the tree`);
  }

  if (errors.length) {
    console.error("Runtime-recipe contract check failed:");
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log(
    `Runtime-recipe contract OK: ${recipe.recipe_kind} revision ${recipe.recipe_revision}, ` +
      `${recipe.steps.length} steps, ${recipe.inputs.files.length} inputs, ${recipe.outputs.checks.length} mandatory output checks, ` +
      `${(manifest.accept ?? []).length} accept and ${(manifest.reject ?? []).length} reject fixtures.`,
  );
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  process.exit(main());
}
