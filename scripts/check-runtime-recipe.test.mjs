import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  COMMAND_AUTHORITY_ALLOWLIST,
  REQUIRED_DETECTIONS,
  validateCommandAuthority,
  validateFixtures,
  validateInputSet,
  validateInternalCoherence,
  validateSurfaceRegistration,
  validateTargetAgreement,
} from "./check-runtime-recipe.mjs";
import {
  FIXTURE_DIR,
  FIXTURE_MANIFEST_PATH,
  HOSTILE_FIXTURE_MANIFEST_PATH,
  HOSTILE_FIXTURE_ROOT,
  READINESS_DOC_PATH,
  RECIPE_PATH,
  RECIPE_SCHEMA_PATH,
  expectedOutputInventory,
  fingerprintInputs,
  moduleInputs,
  stepArgv,
  stepById,
  verifyPreparedRuntime,
  versionInRange,
} from "./runtime-recipe.mjs";
import { classifyPaths } from "./orientation-contract.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

const recipe = readJson(RECIPE_PATH);
const schema = readJson(RECIPE_SCHEMA_PATH);
const surface = readJson("contracts/supported-surface.json");
const fixtures = readJson(FIXTURE_MANIFEST_PATH);
const distStates = readJson(`${FIXTURE_DIR}/dist-states.json`);
const hostile = readJson(HOSTILE_FIXTURE_MANIFEST_PATH);
const packageJson = readJson("package.json");
const lockfile = readJson("package-lock.json");

/* ================================================================== */
/* Required fields, commands, ranges, policy, bounds                   */
/* ================================================================== */

test("the published recipe validates and is internally coherent", () => {
  assert.deepEqual(validateInternalCoherence(recipe), []);
  assert.equal(recipe.schema, "campaigns-os-runtime-recipe/v1");
  assert.equal(recipe.fail_closed, true);
  assert.equal(recipe.unperformable_check_disposition, "failed");
});

test("every field the schema requires is present, and the minimal accept fixture proves the required set is sufficient on its own", () => {
  for (const field of schema.required) assert.ok(field in recipe, `recipe is missing required field ${field}`);
  const minimal = readJson(`${FIXTURE_DIR}/accept/minimal.json`);
  assert.deepEqual(Object.keys(minimal).sort(), [...schema.required].sort());
});

test("the two steps are exactly the commands the contract declares, read from the contract rather than written down again", () => {
  assert.deepEqual(recipe.steps.map((step) => step.id), ["install", "build"]);
  const install = stepArgv(recipe, "install");
  const build = stepArgv(recipe, "build");

  // Structural assertions, not literal ones: the point is that the flags which make
  // preparation safe are present, whatever the rest of the argv happens to be.
  assert.equal(install[0], "npm");
  assert.equal(install[1], "ci");
  assert.ok(install.includes("--ignore-scripts"), "the install step must suppress lifecycle scripts");
  assert.equal(build[0], "npm");
  assert.equal(build[1], "run");
  assert.ok(build.includes("--ignore-scripts"), "the build step must suppress pre/post scripts");
  assert.equal(build.at(-1), "build:spec");

  for (const step of recipe.steps) {
    assert.equal(step.cwd, "target_root");
    assert.equal(step.stdin, "closed");
    assert.equal(step.lifecycle_scripts, "disabled");
  }
});

test("tool ranges accept what was verified and refuse what is outside them", () => {
  for (const version of recipe.tooling.node.verified) assert.ok(versionInRange(version, recipe.tooling.node), `${version} should be accepted`);
  for (const version of recipe.tooling.npm.verified) assert.ok(versionInRange(version, recipe.tooling.npm), `${version} should be accepted`);

  assert.equal(versionInRange("20.18.0", recipe.tooling.node), false, "below the declared minimum");
  assert.equal(versionInRange("25.0.0", recipe.tooling.node), false, "at the exclusive maximum");
  assert.equal(versionInRange("12.0.0", recipe.tooling.npm), false, "a major outside accepted_majors");
  assert.equal(versionInRange(undefined, recipe.tooling.node), false, "an unreadable version is not an approved one");
  assert.equal(versionInRange("not-a-version", recipe.tooling.npm), false);
  // A prerelease must not satisfy a range on the strength of its numeric prefix.
  // fail_closed means an unparseable version is outside every range, not inside one.
  assert.equal(versionInRange("22.0.0-rc.1", recipe.tooling.node), false, "a Node prerelease is not an accepted version");
  assert.equal(versionInRange("11.0.0-next.1", recipe.tooling.npm), false, "an npm prerelease is not an accepted version");
  assert.equal(versionInRange("v22.23.1", recipe.tooling.node), true, "a leading v is still accepted");
});

test("network policy is declared per step, with an allowlist on install and denial on build", () => {
  const perStep = recipe.network.per_step;
  assert.deepEqual(Object.keys(perStep).sort(), recipe.steps.map((step) => step.id).sort());
  assert.equal(perStep.install.policy, "allowlist");
  assert.deepEqual(perStep.install.hosts, ["registry.npmjs.org"]);
  assert.equal(perStep.build.policy, "deny");
  assert.deepEqual(perStep.build.hosts, []);
  assert.equal(recipe.network.cache_ownership, "consumer_profile");
  assert.equal(recipe.network.inherit_proxy, false);
  assert.equal(recipe.network.inherit_credentials, false);
  assert.equal(recipe.network.inherit_npmrc, false);
});

test("every step is bounded, and every bound states what it applies to and why", () => {
  for (const step of recipe.steps) {
    const bound = recipe.bounds[step.timeout_bound];
    assert.ok(bound, `step ${step.id} names an undeclared bound`);
    assert.ok(bound.value > 0);
  }
  for (const [name, bound] of Object.entries(recipe.bounds)) {
    assert.ok(Number.isInteger(bound.value) && bound.value > 0, `${name}: value must be a positive integer`);
    assert.ok(bound.unit?.trim(), `${name}: no unit`);
    assert.ok(bound.applies_to?.trim(), `${name}: no applies_to`);
    assert.ok(bound.rationale?.trim(), `${name}: no rationale`);
    assert.ok(bound.measured_baseline?.trim(), `${name}: no measured baseline — a bound with no measurement beside it reads as physics`);
  }
});

test("all seven output checks are mandatory and between them cover every prepared-runtime failure mode", () => {
  assert.equal(recipe.outputs.checks.length, 7);
  for (const check of recipe.outputs.checks) {
    assert.equal(check.mandatory, true, `${check.id} is not mandatory`);
    assert.ok(check.detects.length > 0);
    assert.ok(check.applies_to?.trim());
    assert.ok(check.rationale?.trim());
  }
  const detected = new Set(recipe.outputs.checks.flatMap((check) => check.detects));
  for (const mode of REQUIRED_DETECTIONS) assert.ok(detected.has(mode), `nothing detects ${mode}`);
  assert.equal(recipe.outputs.checks.find((check) => check.kind === "module_import_smoke").depth, "shallow");
});

test("a prepared runtime cannot run browser QA, and the contract says so", () => {
  assert.equal(recipe.capabilities.browser_qa, false);
  assert.equal(recipe.capabilities.build_spec, true);
  assert.equal(recipe.capabilities.type_check, true);
  assert.match(readFileSync(join(root, READINESS_DOC_PATH), "utf8"), /browser_qa[^|]*\|\s+\*\*no\*\*/);
});

/* ================================================================== */
/* The resolved input set                                              */
/* ================================================================== */

test("the enumerated input set is the compiler's RESOLVED file set, not the config's include globs", () => {
  const tsconfig = readJson("campaign-spec/tsconfig.build.json");
  const declared = moduleInputs(recipe);
  assert.equal(declared.length, 38);

  // The trap this contract exists to avoid: two compiled root modules appear in no
  // include glob and enter transitively. Assert that is still true, so if the config
  // is ever widened to name them, this test says so rather than quietly agreeing.
  const globbedRoots = tsconfig.include.filter((entry) => !entry.includes("*")).map((entry) => `campaign-spec/${entry}`);
  const transitive = declared.filter((path) => !path.startsWith("campaign-spec/rules/") && !globbedRoots.includes(path));
  assert.deepEqual(transitive.sort(), ["campaign-spec/routing.ts", "campaign-spec/sdk-version-parse.ts"]);

  // And nothing under the fixture or test trees is an input; nothing there is emitted.
  for (const path of recipe.inputs.files) {
    assert.ok(!path.startsWith("campaign-spec/fixtures/"), `${path} is not an input`);
    assert.ok(!path.startsWith("campaign-spec/test/"), `${path} is not an input`);
  }
});

test("a resolved source the input set omits fails, and so does one it invents", () => {
  const resolved = moduleInputs(recipe);
  assert.deepEqual(validateInputSet(recipe, resolved), []);

  const omitted = validateInputSet({ ...recipe, inputs: { ...recipe.inputs, files: recipe.inputs.files.filter((p) => p !== "campaign-spec/routing.ts") } }, resolved);
  assert.equal(omitted.length, 1);
  assert.match(omitted[0], /does not enumerate/);

  const invented = validateInputSet(recipe, resolved.filter((p) => p !== "campaign-spec/routing.ts"));
  assert.ok(invented.some((error) => /does not read/.test(error)));
});

test("the input fingerprint changes when any enumerated input changes", () => {
  const bytes = new Map(recipe.inputs.files.map((path) => [path, readFileSync(join(root, path))]));
  const read = (path) => bytes.get(path) ?? null;
  const before = fingerprintInputs(recipe, read);
  assert.match(before, /^[0-9a-f]{64}$/);
  assert.equal(fingerprintInputs(recipe, read), before, "the fingerprint must be stable for unchanged inputs");

  bytes.set("campaign-spec/routing.ts", Buffer.concat([bytes.get("campaign-spec/routing.ts"), Buffer.from("\n")]));
  assert.notEqual(fingerprintInputs(recipe, read), before);

  // A missing input is not a smaller fingerprint; it is a refusal.
  assert.throws(() => fingerprintInputs(recipe, (path) => (path === "package.json" ? null : bytes.get(path))), /missing/);
});

/* ================================================================== */
/* Fail-closed: unknown kind, unknown revision, safety-critical enums   */
/* ================================================================== */

test("every reject fixture is refused, and the manifest enumerates exactly the fixtures on disk", () => {
  assert.deepEqual(validateFixtures(fixtures, schema, (relative) => readJson(`${FIXTURE_DIR}/${relative}`)), []);

  const enumerated = [...fixtures.accept, ...fixtures.reject].map((entry) => entry.path).sort();
  const onDisk = execFileSync("git", ["-C", root, "ls-files", `${FIXTURE_DIR}/accept`, `${FIXTURE_DIR}/reject`], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((path) => path.slice(FIXTURE_DIR.length + 1))
    .sort();
  if (onDisk.length) assert.deepEqual(onDisk, enumerated, "a fixture on disk that no manifest names is a fixture nothing asserts against");
});

test("unknown kind and unknown revision both fail closed", () => {
  const unknownKind = readJson(`${FIXTURE_DIR}/reject/unknown-kind.json`);
  assert.ok(!schema.properties.recipe_kind.enum.includes(unknownKind.recipe_kind));

  const unknownRevision = readJson(`${FIXTURE_DIR}/reject/unknown-revision.json`);
  assert.ok(!new RegExp(schema.properties.recipe_revision.pattern).test(unknownRevision.recipe_revision));
  assert.ok(new RegExp(schema.properties.recipe_revision.pattern).test(recipe.recipe_revision));
});

test("each reject fixture differs from the accepted recipe in exactly one place, so a refusal is attributable", () => {
  for (const entry of fixtures.reject) {
    const mutated = readJson(`${FIXTURE_DIR}/${entry.path}`);
    assert.equal(diffCount(recipe, mutated), 1, `${entry.path} changes more than one thing`);
    assert.ok(entry.why?.trim(), `${entry.path} has no stated reason`);
  }
});

function diffCount(a, b) {
  if (a === b) return 0;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return 1;
  if (Array.isArray(a) !== Array.isArray(b)) return 1;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let count = 0;
  for (const key of keys) {
    if (!(key in a) || !(key in b)) count += 1;
    else count += diffCount(a[key], b[key]);
  }
  return count;
}

/* ================================================================== */
/* Drift in the target that the recipe describes                       */
/* ================================================================== */

test("the recipe agrees with the repository as it actually is", () => {
  assert.deepEqual(validateTargetAgreement(recipe, { packageJson, lockfile }), []);
});

test("changing package scripts, the lockfile policy, or the install-scripted dependency set is refused", () => {
  const cases = [
    ["a rewritten build script", { packageJson: mutate(packageJson, (p) => { p.scripts["build:spec"] = "tsc"; }), lockfile }],
    ["a deleted build script", { packageJson: mutate(packageJson, (p) => { delete p.scripts["build:spec"]; }), lockfile }],
    ["a rewritten prepare script", { packageJson: mutate(packageJson, (p) => { p.scripts.prepare = "echo nothing"; }), lockfile }],
    ["a widened engine range", { packageJson: mutate(packageJson, (p) => { p.engines.node = ">=18.0.0"; }), lockfile }],
    ["a bumped lockfile version", { packageJson, lockfile: mutate(lockfile, (l) => { l.lockfileVersion = 4; }) }],
    ["an absent lockfile", { packageJson, lockfile: null }],
    ["a lockfile with no integrity digests", { packageJson, lockfile: mutate(lockfile, (l) => { for (const entry of Object.values(l.packages)) delete entry.integrity; }) }],
    // Partial honouring is the interesting case: a .some() gate passes here while the
    // lockfile bound is off every package but one.
    ["a lockfile that pins integrity on only one entry", { packageJson, lockfile: mutate(lockfile, (l) => {
      const installable = Object.keys(l.packages).filter((k) => k.startsWith("node_modules/"));
      for (const key of installable.slice(1)) delete l.packages[key].integrity;
    }) }],
    ["a lockfile missing integrity on a single entry", { packageJson, lockfile: mutate(lockfile, (l) => {
      const first = Object.keys(l.packages).find((k) => k.startsWith("node_modules/"));
      delete l.packages[first].integrity;
    }) }],
    ["a new dependency that ships an install script", { packageJson, lockfile: mutate(lockfile, (l) => { l.packages["node_modules/newcomer"] = { hasInstallScript: true }; }) }],
  ];
  for (const [label, target] of cases) {
    const errors = validateTargetAgreement(recipe, target);
    assert.ok(errors.length > 0, `${label} should be refused`);
    for (const error of errors) assert.match(error, /revise the recipe/, `${label}: the refusal must say what to do about it`);
  }
});

function mutate(value, apply) {
  const copy = clone(value);
  apply(copy);
  return copy;
}

test("every path this contract introduces is agent-relevant, so changing one without a ledger item fails the release gate", () => {
  const paths = [
    RECIPE_PATH,
    RECIPE_SCHEMA_PATH,
    READINESS_DOC_PATH,
    FIXTURE_MANIFEST_PATH,
    `${FIXTURE_DIR}/accept/current.json`,
    "package.json",
    "package-lock.json",
    "campaign-spec/routing.ts",
    "contracts/supported-surface.json",
  ];
  const policy = readJson("contracts/agent-relevant-change-policy.v1.json");
  const { relevant, ignored, unclassified } = classifyPaths(paths, { policy, surface });
  assert.deepEqual(unclassified, [], "an unclassified path is one the release gate cannot require a ledger item for");
  assert.deepEqual(ignored, [], "none of these paths may be classified as having no agent impact");
  for (const path of paths) {
    const entry = relevant.find((item) => item.path === path);
    assert.ok(entry, `${path} was not classified as agent-relevant`);
    assert.equal(policy.semantic_classes[entry.class].requires_change_item, true, `${path} is classified as needing no ledger item`);
  }
});

/* ================================================================== */
/* Single authority                                                    */
/* ================================================================== */

test("no tracked file outside the contract and its generated output repeats a recipe command verbatim", () => {
  const tracked = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  const errors = validateCommandAuthority(recipe, tracked, (path) => readFileSync(join(root, path), "utf8"));
  assert.deepEqual(errors, []);
});

test("the authority check would actually catch a duplicated command", () => {
  const command = stepArgv(recipe, "install").join(" ");
  const errors = validateCommandAuthority(recipe, ["scripts/somewhere.mjs"], () => `run ${command} here`);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /only authority/);
  assert.ok(COMMAND_AUTHORITY_ALLOWLIST.includes(RECIPE_PATH));
});

/* ================================================================== */
/* Supported-surface registration                                      */
/* ================================================================== */

test("the recipe and its schema are hashed entries; the guide and fixtures are named entries", () => {
  const fixturePaths = [FIXTURE_MANIFEST_PATH, `${FIXTURE_DIR}/dist-states.json`, ...[...fixtures.accept, ...fixtures.reject].map((entry) => `${FIXTURE_DIR}/${entry.path}`)];
  const hostileFixturePaths = [...hostile.tripwires, ...hostile.intended_scripts].map((entry) => `${HOSTILE_FIXTURE_ROOT}/${entry.path}`);
  assert.deepEqual(validateSurfaceRegistration(surface, { fixturePaths, hostileFixturePaths }), []);

  const named = validateSurfaceRegistration(
    { ...surface, hashed: Object.fromEntries(Object.entries(surface.hashed).filter(([path]) => path !== RECIPE_PATH)) },
    { fixturePaths, hostileFixturePaths },
  );
  assert.equal(named.length, 1);
  assert.match(named[0], /must be a HASHED entry/);
});

/* ================================================================== */
/* Prepared-runtime output checks: absent, stale, extra, corrupt        */
/* ================================================================== */

/** A synthetic healthy prepared generation, derived from the contract. */
function healthyObservation() {
  const dist = {};
  const fileHashes = {};
  for (const path of expectedOutputInventory(recipe)) {
    const digest = "a".repeat(64);
    dist[path] = { sha256: digest, bytes: 1024 };
    fileHashes[path] = digest;
  }
  return {
    dist,
    recorded: { input_fingerprint: "f".repeat(64), file_hashes: fileHashes },
    current_input_fingerprint: "f".repeat(64),
    import_smoke: { attempted: true, ok: true, error: null },
    tools: { node: recipe.tooling.node.verified[0], npm: recipe.tooling.npm.verified[0] },
    generation: { cli_path: "/gen/0001", skills_path: "/gen/0001/skills", cli_oid: "1".repeat(40), skills_oid: "1".repeat(40) },
  };
}

const STATE_MUTATIONS = {
  none: (observation) => observation,
  remove_all_outputs: (observation) => ({ ...observation, dist: {} }),
  add_unexpected_output: (observation) => ({
    ...observation,
    dist: { ...observation.dist, [`${recipe.outputs.directory}/leftover.js`]: { sha256: "b".repeat(64), bytes: 12 } },
  }),
  alter_output_bytes: (observation) => {
    const dist = { ...observation.dist };
    const first = Object.keys(dist)[0];
    dist[first] = { ...dist[first], sha256: "c".repeat(64) };
    return { ...observation, dist };
  },
  advance_input_fingerprint: (observation) => ({ ...observation, current_input_fingerprint: "e".repeat(64) }),
};

test("the healthy control passes every mandatory check", () => {
  const outcome = verifyPreparedRuntime(recipe, healthyObservation());
  assert.equal(outcome.ok, true, JSON.stringify(outcome.failures, null, 2));
  assert.equal(outcome.results.length, recipe.outputs.checks.length);
  assert.equal(outcome.refusal_reason_code, null);
});

test("the output checks detect absent, stale, extra and corrupt output, and each state is detected as the state it is", () => {
  for (const state of distStates.states) {
    const observation = STATE_MUTATIONS[state.mutation](healthyObservation());
    const outcome = verifyPreparedRuntime(recipe, observation);
    if (state.expect === "pass") {
      assert.equal(outcome.ok, true, `${state.id} should pass`);
      continue;
    }
    assert.equal(outcome.ok, false, `${state.id} should fail`);
    assert.equal(outcome.refusal_reason_code, recipe.refusal_reason_code);
    for (const mode of state.detects) {
      assert.ok(outcome.detected.includes(mode), `${state.id}: expected detection of ${mode}, got ${outcome.detected.join(", ")}`);
    }
  }
  // Together the four failure states must exercise every mode the contract claims.
  const covered = new Set(distStates.states.flatMap((state) => state.detects));
  for (const mode of REQUIRED_DETECTIONS) assert.ok(covered.has(mode), `no fixture state exercises ${mode}`);
});

test("stale output is invisible to every check except the input fingerprint", () => {
  const stale = STATE_MUTATIONS.advance_input_fingerprint(healthyObservation());
  const outcome = verifyPreparedRuntime(recipe, stale);
  assert.deepEqual(outcome.failures.map((failure) => failure.kind), ["input_fingerprint"]);
});

test("a check that cannot be performed counts as failed, never as skipped", () => {
  const cases = [
    ["no inventory observed", (observation) => ({ ...observation, dist: null })],
    ["no recorded hashes", (observation) => ({ ...observation, recorded: { input_fingerprint: observation.recorded.input_fingerprint } })],
    ["import never attempted", (observation) => ({ ...observation, import_smoke: { attempted: false } })],
    ["no tool versions observed", (observation) => ({ ...observation, tools: {} })],
    ["no generation identity", (observation) => ({ ...observation, generation: null })],
    ["no fingerprint recorded", (observation) => ({ ...observation, recorded: { ...observation.recorded, input_fingerprint: null } })],
  ];
  for (const [label, apply] of cases) {
    const outcome = verifyPreparedRuntime(recipe, apply(healthyObservation()));
    assert.equal(outcome.ok, false, `${label} must fail`);
    for (const result of outcome.results) assert.notEqual(result.status, "skipped", `${label}: nothing may report skipped`);
  }
});

test("generation agreement requires real containment, not a shared path prefix", () => {
  // /gen/0001 is a string prefix of /gen/00010, but they are sibling generation roots.
  // A prefix match without a separator boundary would call this agreement.
  const sibling = healthyObservation();
  sibling.generation = { ...sibling.generation, cli_path: "/gen/0001", skills_path: "/gen/00010/skills" };
  const outcome = verifyPreparedRuntime(recipe, sibling);
  assert.equal(outcome.ok, false, "a sibling generation root must not satisfy containment");
  const agreement = outcome.results.find((result) => (result.detected ?? []).includes("mismatched_generation"));
  assert.ok(agreement, "the failure must be attributed to generation disagreement");

  // The genuine nesting still passes, including an incidental trailing slash.
  for (const cli_path of ["/gen/0001", "/gen/0001/"]) {
    const nested = healthyObservation();
    nested.generation = { ...nested.generation, cli_path, skills_path: "/gen/0001/skills" };
    assert.equal(verifyPreparedRuntime(recipe, nested).ok, true, `${cli_path} should accept its own child`);
  }
});

test("the output bounds refuse a runaway build", () => {
  const tooManyFiles = healthyObservation();
  for (let index = 0; index <= recipe.bounds.max_output_files.value; index += 1) {
    tooManyFiles.dist[`${recipe.outputs.directory}/runaway-${index}.js`] = { sha256: "d".repeat(64), bytes: 1 };
  }
  const filesOutcome = verifyPreparedRuntime(recipe, tooManyFiles);
  assert.equal(filesOutcome.ok, false);
  assert.ok(filesOutcome.failures.some((failure) => failure.messages.some((message) => message.includes("max_output_files"))));

  const tooManyBytes = healthyObservation();
  const first = Object.keys(tooManyBytes.dist)[0];
  tooManyBytes.dist[first] = { ...tooManyBytes.dist[first], bytes: recipe.bounds.max_output_bytes.value + 1 };
  const bytesOutcome = verifyPreparedRuntime(recipe, tooManyBytes);
  assert.equal(bytesOutcome.ok, false);
  assert.ok(bytesOutcome.failures.some((failure) => failure.messages.some((message) => message.includes("max_output_bytes"))));
});

test("the expected output inventory is derived from the inputs rather than listed a second time", () => {
  const inventory = expectedOutputInventory(recipe);
  assert.equal(inventory.length, moduleInputs(recipe).length * recipe.outputs.expected_module_derivation.emitted_extensions.length);
  assert.ok(inventory.includes(recipe.outputs.type_entry));
  const withOneMore = { ...recipe, inputs: { ...recipe.inputs, files: [...recipe.inputs.files, "campaign-spec/newcomer.ts"] } };
  assert.equal(expectedOutputInventory(withOneMore).length, inventory.length + 2);
});

test("a real build produces exactly the derived inventory", { skip: existsSync(join(root, "campaign-spec/dist")) ? false : "campaign-spec/dist is not built in this working tree" }, () => {
  const actual = execFileSync("git", ["-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "campaign-spec/dist"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(actual, expectedOutputInventory(recipe));
  // And it is a build output, never a committed artifact: nothing there is tracked.
  assert.equal(execFileSync("git", ["-C", root, "ls-files", "campaign-spec/dist"], { encoding: "utf8" }).trim(), "");
  assert.equal(recipe.outputs.committed, false);
});

/* ================================================================== */
/* Lifecycle-script tripwires, run for real                            */
/* ================================================================== */

function stageHostileTarget() {
  const scratch = mkdtempSync(join(tmpdir(), "campaigns-os-recipe-"));
  cpSync(join(root, HOSTILE_FIXTURE_ROOT, hostile.target_root), scratch, { recursive: true });
  const env = {
    ...process.env,
    [hostile.tripwire_log_env]: join(scratch, "tripwire.log"),
    [hostile.intended_script_log_env]: join(scratch, "intended.log"),
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  // Setup runs with scripts suppressed so the packing and lockfile steps are outside
  // the measured window; the logs are truncated afterwards regardless.
  const dependency = join(scratch, hostile.recipe_execution.dependency_package.replace(/^repo\//, ""));
  execFileSync("npm", ["pack", dependency, "--ignore-scripts"], { cwd: scratch, stdio: "ignore" });
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: scratch, stdio: "ignore" });
  writeFileSync(env[hostile.tripwire_log_env], "");
  writeFileSync(env[hostile.intended_script_log_env], "");
  return { scratch, env };
}

const lines = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean);

test("the recipe's install command runs no lifecycle script, and the control proves the fixture can fire", { timeout: 180_000 }, () => {
  const { scratch, env } = stageHostileTarget();
  try {
    const [executable, ...args] = stepArgv(recipe, "install");

    execFileSync(executable, args, { cwd: scratch, env, stdio: "ignore" });
    assert.deepEqual(lines(env[hostile.tripwire_log_env]), [], "the recipe's install step must fire no lifecycle script");

    // Control. Without it this test passes just as happily against a fixture whose
    // scripts would never have fired at all.
    rmSync(join(scratch, "node_modules"), { recursive: true, force: true });
    execFileSync(executable, args.filter((arg) => arg !== "--ignore-scripts"), { cwd: scratch, env, stdio: "ignore" });
    const fired = lines(env[hostile.tripwire_log_env]);
    assert.ok(fired.length > 0, "the control must fire lifecycle scripts, or the suppression proves nothing");
    assert.ok(fired.some((line) => line.includes("dependency:")), `a DEPENDENCY lifecycle script must fire in the control, got: ${fired.join(", ")}`);
    assert.ok(fired.some((line) => line.includes("root:")), "a root lifecycle script must fire in the control");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the recipe's build command runs the intended script but neither of its pre/post siblings", { timeout: 180_000 }, () => {
  const { scratch, env } = stageHostileTarget();
  try {
    const [executable, ...args] = stepArgv(recipe, "build");

    execFileSync(executable, args, { cwd: scratch, env, stdio: "ignore" });
    assert.deepEqual(lines(env[hostile.tripwire_log_env]), [], "no pre/post script may run");
    assert.equal(lines(env[hostile.intended_script_log_env]).length, hostile.recipe_execution.expected_intended_hit_count);

    // Control: the same command without the flag runs the whole pre/post chain.
    writeFileSync(env[hostile.intended_script_log_env], "");
    execFileSync(executable, args.filter((arg) => arg !== "--ignore-scripts"), { cwd: scratch, env, stdio: "ignore" });
    const fired = lines(env[hostile.tripwire_log_env]);
    assert.ok(fired.some((line) => line.includes("prebuild:spec")), `the control must run the pre script, got: ${fired.join(", ")}`);
    assert.ok(fired.some((line) => line.includes("postbuild:spec")), "the control must run the post script");
    assert.equal(lines(env[hostile.intended_script_log_env]).length, 1, "the intended script still runs exactly once");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the hostile fixture enumerates every tripwire it ships, and each one exists", () => {
  for (const entry of [...hostile.tripwires, ...hostile.intended_scripts]) {
    assert.ok(existsSync(join(root, HOSTILE_FIXTURE_ROOT, entry.path)), `${entry.path} is enumerated but absent`);
  }
  assert.equal(hostile.expected_hit_count, 0, "the orientation invariant is unchanged");
  assert.equal(hostile.recipe_execution.expected_lifecycle_hit_count, 0);
  assert.ok(hostile.recipe_execution.control?.trim(), "the recipe invariant must name its control");
});

/* ================================================================== */
/* Generated documentation                                             */
/* ================================================================== */

test("the readiness guide and the fixtures are current with the contract", () => {
  execFileSync(process.execPath, ["./scripts/generate-runtime-readiness.mjs"], { cwd: root, stdio: "ignore" });
});

test("the readiness guide states the values it claims to be generated from", () => {
  const guide = readFileSync(join(root, READINESS_DOC_PATH), "utf8");
  assert.match(guide, /GENERATED FILE/);
  assert.ok(guide.includes(recipe.recipe_kind));
  assert.ok(guide.includes(recipe.recipe_revision));
  assert.ok(guide.includes(surface.surface_version));
  for (const path of recipe.inputs.files) assert.ok(guide.includes(path), `the guide omits input ${path}`);
  for (const [name, bound] of Object.entries(recipe.bounds)) {
    assert.ok(guide.includes(`${bound.value} ${bound.unit}`), `the guide omits the value of ${name}`);
  }
});
