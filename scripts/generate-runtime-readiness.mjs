#!/usr/bin/env node

/**
 * Generates the runtime readiness guide AND the runtime-recipe fixtures from the
 * recipe contract itself.
 *
 * Generated rather than hand-written, following the orientation reference: staleness
 * becomes a CI failure instead of a documentation review someone has to remember. Nobody
 * edits docs/runtime-readiness.md or the fixtures under contracts/fixtures/runtime-recipe/;
 * you change contracts/runtime-recipe.campaigns-os-node-v1.json and rerun this.
 *
 *   node ./scripts/generate-runtime-readiness.mjs --write
 *   node ./scripts/generate-runtime-readiness.mjs --check   (CI; default)
 *
 * The reject fixtures are deterministic mutations of the accepted recipe, so a fixture
 * can never drift into asserting something the contract no longer says. Each one changes
 * exactly one thing and the manifest records why it must be refused.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { FIXTURE_DIR, READINESS_DOC_PATH, RECIPE_PATH, RECIPE_SCHEMA_PATH, expectedOutputInventory, sha256Hex, stepArgv } from "./runtime-recipe.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Strip every property the schema does not require, at the depth the schema requires it. */
function minimalDocument(recipe, schema) {
  const keep = new Set(schema.required);
  const out = {};
  for (const key of Object.keys(recipe)) if (keep.has(key)) out[key] = clone(recipe[key]);
  // Notes are authoring aids; a minimal accepted document carries none of them.
  for (const container of ["preconditions", "tooling", "network", "inputs", "outputs", "capabilities"]) {
    if (out[container] && typeof out[container] === "object") {
      for (const key of Object.keys(out[container])) {
        if (key.startsWith("_") && !schema.properties[container]?.required?.includes(key)) delete out[container][key];
      }
    }
  }
  return out;
}

function mutate(recipe, apply) {
  const copy = clone(recipe);
  apply(copy);
  return copy;
}

/**
 * Every reject case, as { id, reason, document }. One mutation each: a fixture that
 * changes two things cannot tell you which one the refusal was for.
 */
function rejectCases(recipe) {
  return [
    {
      id: "unknown-kind",
      reason: "recipe_kind names a kind this schema version does not define. An installed consumer was not released knowing how to execute it, so it fails closed rather than guessing that a v2 is a v1 with extras.",
      document: mutate(recipe, (doc) => { doc.recipe_kind = "campaigns-os-node-v2"; }),
    },
    {
      id: "unknown-revision",
      reason: "recipe_revision leaves the major line the kind defines. A revision may only re-parameterise fields the consumer already understands; a different major is a shape change wearing a revision's clothes.",
      document: mutate(recipe, (doc) => { doc.recipe_revision = "2.0.0"; }),
    },
    {
      id: "unknown-network-policy",
      reason: "A safety-critical enum: the install step declares a network policy outside the defined set. There is no allow-all value, and an unrecognized one is refused rather than treated as permissive.",
      document: mutate(recipe, (doc) => { doc.network.per_step.install.policy = "allow_all"; }),
    },
    {
      id: "allowlist-without-hosts",
      reason: "An allowlist with no hosts is not a bound, it is an empty declaration that reads like one. The schema requires a non-empty host list whenever the policy is an allowlist.",
      document: mutate(recipe, (doc) => { doc.network.per_step.install.hosts = []; }),
    },
    {
      id: "unknown-output-check",
      reason: "A safety-critical enum: an output check names a kind the consumer cannot perform. A new KIND of check is a new recipe kind, because an installed consumer cannot perform a check it was not released knowing.",
      document: mutate(recipe, (doc) => {
        doc.outputs.checks.push({ ...clone(doc.outputs.checks[0]), id: "dist_signature", kind: "dist_signature" });
      }),
    },
    {
      id: "unknown-step-id",
      reason: "A safety-critical enum: a step identity outside the defined set. Steps are identified rather than positional, so an unrecognized id is a command the consumer has no contract for.",
      document: mutate(recipe, (doc) => { doc.steps[0].id = "prefetch"; }),
    },
    {
      id: "lifecycle-scripts-enabled",
      reason: "A safety-critical enum: a step that permits lifecycle scripts. Enabling them would let the target run arbitrary code during preparation, which is the single thing the recipe's flags exist to prevent.",
      document: mutate(recipe, (doc) => { doc.steps[1].lifecycle_scripts = "enabled"; }),
    },
    {
      id: "engines-disagreement-warns",
      reason: "A safety-critical enum: disagreement between the contract's tool range and the target's declared engines resolved as a warning. An accept-with-warning path produces a build made under conditions nobody approved.",
      document: mutate(recipe, (doc) => { doc.tooling.on_disagreement = "warn"; }),
    },
    {
      id: "advisory-enforcement",
      reason: "fail_closed switched off. Advisory bounds record the right numbers and enforce nothing, so the first time a bound matters you discover it was decorative.",
      document: mutate(recipe, (doc) => { doc.fail_closed = false; }),
    },
    {
      id: "unperformable-check-skipped",
      reason: "A safety-critical enum: a check that cannot be performed treated as skipped. A skipped check reports success it never established.",
      document: mutate(recipe, (doc) => { doc.unperformable_check_disposition = "skipped"; }),
    },
    {
      id: "committed-output-claim",
      reason: "The recipe claims its output directory is a committed artifact. It is not: the directory is git-ignored and untracked, so no baseline for its contents can exist here and verification must be self-consistency.",
      document: mutate(recipe, (doc) => { doc.outputs.committed = true; }),
    },
    {
      id: "unpinned-lockfile",
      reason: "The recipe claims its lockfile is not integrity-pinned. The network allowlist bounds where bytes may come from and the lockfile's digests bound which bytes are acceptable; dropping the second leaves the first standing alone, which it was never meant to do.",
      document: mutate(recipe, (doc) => { doc.target_expectations.lockfile.integrity_pinned = false; }),
    },
    {
      id: "missing-required-field",
      reason: "The enumerated input set is absent. Without it there is nothing to fingerprint, and staleness — the one failure mode no output-side check can see — becomes undetectable.",
      document: mutate(recipe, (doc) => { delete doc.inputs; }),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Prepared-runtime state fixtures                                     */
/* ------------------------------------------------------------------ */

/**
 * The four prepared-runtime failure modes the contract's checks must detect, described
 * declaratively so a test synthesizes them from the contract instead of hand-listing
 * output paths that rot the moment a module is added.
 */
function distStates(recipe) {
  const expected = expectedOutputInventory(recipe);
  return {
    _note: "Declarative descriptions of the prepared-runtime states an output-check implementation must distinguish. A test builds each state from the accepted recipe rather than from paths written down here, so adding a module to the input set cannot leave a fixture describing an inventory that no longer exists.",
    schema: "campaigns-os-runtime-recipe-dist-states/v1",
    directory: recipe.outputs.directory,
    expected_file_count: expected.length,
    states: [
      { id: "healthy", mutation: "none", expect: "pass", detects: [], why: "The control. Without it the four failure fixtures prove only that the checker fails, not that it discriminates." },
      { id: "absent", mutation: "remove_all_outputs", expect: "fail", detects: ["absent"], why: "Nothing was built, or the output directory was removed after the build. The inventory check is the only one that can report this cleanly; every other check would report a cascade." },
      { id: "extra", mutation: "add_unexpected_output", expect: "fail", detects: ["extra"], why: "Something other than the declared build wrote into the output directory. An unexpected file is as much a signal as a missing one." },
      { id: "corrupt", mutation: "alter_output_bytes", expect: "fail", detects: ["corrupt"], why: "A file was modified after the build recorded its digest. Caught by hash stability; the import smoke is the second line for the case where the alteration also makes the module unloadable." },
      { id: "stale", mutation: "advance_input_fingerprint", expect: "fail", detects: ["stale"], why: "The output is internally consistent — complete inventory, correct hashes, imports fine — but was produced from inputs that no longer match the target commit. Only the input fingerprint sees this." },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* The readiness guide                                                 */
/* ------------------------------------------------------------------ */

const table = (headers, rows) =>
  [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");

const code = (value) => `\`${value}\``;

function renderGuide({ recipe, schema, surface, rejects, states }) {
  const lines = [];
  const p = (...text) => lines.push(...text);

  p(
    "<!--",
    "  GENERATED FILE — do not edit.",
    "  Source: contracts/runtime-recipe.campaigns-os-node-v1.json",
    "  Regenerate: node ./scripts/generate-runtime-readiness.mjs --write",
    "-->",
    "",
    "# Runtime readiness",
    "",
    `How a checkout of this repository at one commit becomes a usable installed runtime, and how a consumer decides whether a prepared one is still trustworthy. Everything below is generated from ${code(RECIPE_PATH)}, which is the only authority for these values.`,
    "",
    `Recipe kind ${code(recipe.recipe_kind)}, revision ${code(recipe.recipe_revision)}, validated by ${code(RECIPE_SCHEMA_PATH)} (${code(schema.title)}). Supported surface at generation time: ${code(surface.surface_version)}.`,
    "",
    "## What this is",
    "",
    "A recipe is data, not code. A consumer executes exactly the commands enumerated here and never a command assembled from repository data. This repository publishes the recipe; the installed consumer bootstrap executes it, using its own released parser rather than anything loaded from the checkout under evaluation.",
    "",
    `Enforcement is fail-closed. Every field is normative: ${code("fail_closed")} is ${code(String(recipe.fail_closed))} and a check that cannot be performed counts as ${code(recipe.unperformable_check_disposition)}, never as skipped. A refusal carries the stable reason code ${code(recipe.refusal_reason_code)}.`,
    "",
    "## What a prepared runtime can and cannot do",
    "",
    recipe.capabilities._note,
    "",
    table(["Capability", "Available"], Object.entries(recipe.capabilities).filter(([key]) => !key.startsWith("_")).map(([key, value]) => [code(key), value ? "yes" : "**no**"])),
    "",
    "## Preconditions",
    "",
    recipe.preconditions._note,
    "",
    ...Object.keys(recipe.preconditions).filter((key) => !key.startsWith("_")).map((key) => `- ${code(key)}`),
    "",
    "## Tool versions",
    "",
    table(["Tool", "Accepted range", "Verified against", "Rationale"], [
      ["Node", code(recipe.tooling.node.range), (recipe.tooling.node.verified ?? []).map(code).join(", ") || "—", recipe.tooling.node.rationale],
      ["npm", code(recipe.tooling.npm.range), (recipe.tooling.npm.verified ?? []).map(code).join(", ") || "—", recipe.tooling.npm.rationale],
    ]),
    "",
    `The contract declares its own ranges rather than inheriting the target's. It records the target's ${code(recipe.tooling.target_engines.field)} as ${code(recipe.tooling.target_engines.observed)}; on disagreement the disposition is ${code(recipe.tooling.on_disagreement)}. ${recipe.tooling.target_engines._note}`,
    "",
    "## Network",
    "",
    recipe.network._note,
    "",
    table(["Step", "Policy", "Hosts", "Rationale"], Object.entries(recipe.network.per_step).map(([id, policy]) => [
      code(id),
      code(policy.policy),
      (policy.hosts ?? []).map(code).join(", ") || "none",
      policy.rationale,
    ])),
    "",
    `Cache ownership is ${code(recipe.network.cache_ownership)}. Inherited proxy configuration: ${code(String(recipe.network.inherit_proxy))}. Inherited credentials: ${code(String(recipe.network.inherit_credentials))}. Inherited npm configuration file: ${code(String(recipe.network.inherit_npmrc))}.`,
    "",
    "## Steps",
    "",
  );

  for (const step of recipe.steps) {
    p(
      `### ${step.id}`,
      "",
      "```",
      stepArgv(recipe, step.id).join(" "),
      "```",
      "",
      `Working directory ${code(step.cwd)}, stdin ${code(step.stdin)}, lifecycle scripts ${code(step.lifecycle_scripts)}, bounded by ${code(step.timeout_bound)}.`,
      "",
      step.rationale,
      "",
    );
  }

  p(
    "## Inputs",
    "",
    recipe.inputs._note,
    "",
    `Fingerprint algorithm ${code(recipe.inputs.fingerprint_algorithm)}, over ${recipe.inputs.files.length} enumerated files:`,
    "",
    ...recipe.inputs.files.map((path) => `- ${code(path)}`),
    "",
    "## Outputs",
    "",
    recipe.outputs._note,
    "",
    `Directory ${code(recipe.outputs.directory)}. Committed: ${code(String(recipe.outputs.committed))}. Type entry ${code(recipe.outputs.type_entry)}.`,
    "",
    `Expected inventory is derived, never listed twice. ${recipe.outputs.expected_module_derivation.rule} Emitted extensions: ${recipe.outputs.expected_module_derivation.emitted_extensions.map(code).join(", ")}. At this revision that derivation yields ${expectedOutputInventory(recipe).length} files.`,
    "",
    "### Mandatory checks",
    "",
    "Every check below is mandatory; there is no optional check, because an optional check is an advisory bound under another name.",
    "",
    table(["Check", "Kind", "Detects", "Applies to", "Rationale"], recipe.outputs.checks.map((check) => [
      code(check.id),
      code(check.kind) + (check.depth ? ` (${check.depth})` : ""),
      check.detects.map(code).join(", "),
      check.applies_to,
      check.rationale,
    ])),
    "",
    "### Prepared-runtime states",
    "",
    states._note,
    "",
    table(["State", "Expect", "Detected as", "Why it matters"], states.states.map((state) => [
      code(state.id),
      state.expect,
      state.detects.map(code).join(", ") || "—",
      state.why,
    ])),
    "",
    "## What the recipe assumes about the target",
    "",
    recipe.target_expectations._note,
    "",
    table(["Assumption", "Value"], [
      ["Manifest", code(recipe.target_expectations.package_json)],
      ["Lockfile", `${code(recipe.target_expectations.lockfile.path)}, version ${code(String(recipe.target_expectations.lockfile.lockfile_version))}, integrity pinned ${code(String(recipe.target_expectations.lockfile.integrity_pinned))}`],
      ...Object.entries(recipe.target_expectations.scripts).map(([name, text]) => [`Script ${code(name)}`, code(text)]),
      ["Dependencies declaring an install script", recipe.target_expectations.install_script_dependencies.map(code).join(", ") || "none"],
    ]),
    "",
    "## Bounds",
    "",
    table(["Bound", "Value", "Measured baseline", "Applies to", "Rationale"], Object.entries(recipe.bounds).map(([name, bound]) => [
      code(name),
      `${bound.value} ${bound.unit}`,
      bound.measured_baseline ?? "—",
      bound.applies_to,
      bound.rationale,
    ])),
    "",
    recipe._growth_note,
    "",
    "## Changing the recipe",
    "",
    recipe._kind_versus_revision_note,
    "",
    `The recipe and its schema are both HASHED supported-surface entries, so changing either requires ${code("surface_version")} to advance in the same change. ${recipe._note}`,
    "",
    "## Refusals",
    "",
    "These documents are refused. Each is a single-mutation fixture under `contracts/fixtures/runtime-recipe/reject/`, so a refusal is always attributable to one change.",
    "",
    table(["Fixture", "Why it is refused"], rejects.map((reject) => [code(`reject/${reject.id}.json`), reject.reason])),
    "",
  );

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/* ------------------------------------------------------------------ */
/* Drive                                                               */
/* ------------------------------------------------------------------ */

export function generate() {
  const recipe = readJson(RECIPE_PATH);
  const schema = readJson(RECIPE_SCHEMA_PATH);
  const surface = readJson("contracts/supported-surface.json");

  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);

  const rejects = rejectCases(recipe);
  const states = distStates(recipe);
  const minimal = minimalDocument(recipe, schema);

  if (!validate(recipe)) {
    throw new Error(`${RECIPE_PATH} does not validate against its own schema:\n  - ${validate.errors.map((e) => `${e.instancePath} ${e.message}`).join("\n  - ")}`);
  }
  if (!validate(minimal)) {
    throw new Error(`the generated minimal accept fixture does not validate:\n  - ${validate.errors.map((e) => `${e.instancePath} ${e.message}`).join("\n  - ")}`);
  }
  for (const reject of rejects) {
    if (validate(reject.document)) {
      throw new Error(`reject fixture ${reject.id} VALIDATES — the mutation is no longer refused by ${RECIPE_SCHEMA_PATH}, so the fixture proves nothing`);
    }
  }

  const files = new Map();
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

  files.set(`${FIXTURE_DIR}/accept/current.json`, json(recipe));
  files.set(`${FIXTURE_DIR}/accept/minimal.json`, json(minimal));
  for (const reject of rejects) files.set(`${FIXTURE_DIR}/reject/${reject.id}.json`, json(reject.document));
  files.set(`${FIXTURE_DIR}/dist-states.json`, json(states));
  files.set(
    `${FIXTURE_DIR}/manifest.json`,
    json({
      _note: "Enumerates every runtime-recipe fixture with the outcome it must produce, so a consumer's parser test asserts an exact expected set instead of hand-copying a list that rots when a fixture is added. Generated from the accepted recipe: every reject case is a single-mutation copy of it, so a fixture cannot drift into asserting something the contract no longer says.",
      schema: "campaigns-os-runtime-recipe-fixtures/v1",
      fixture_version: "1.0.0",
      validates_against: RECIPE_SCHEMA_PATH,
      source: RECIPE_PATH,
      accept: [
        { path: "accept/current.json", why: "The accepted recipe as published. A consumer's parser must accept exactly these bytes." },
        { path: "accept/minimal.json", why: "Required fields only, every optional field and authoring note stripped. Proves the required set is genuinely sufficient rather than accidentally propped up by optional content." },
      ],
      reject: rejects.map((reject) => ({ path: `reject/${reject.id}.json`, mutation: reject.id, why: reject.reason })),
      prepared_runtime_states: "dist-states.json",
    }),
  );
  files.set(READINESS_DOC_PATH, renderGuide({ recipe, schema, surface, rejects, states }));
  return files;
}

function write(files) {
  for (const [path, content] of files) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function check(files) {
  const errors = [];
  for (const [path, expected] of files) {
    let actual = null;
    try {
      actual = readFileSync(join(root, path), "utf8");
    } catch {
      errors.push(`${path}: generated file is missing — run \`node ./scripts/generate-runtime-readiness.mjs --write\``);
      continue;
    }
    if (actual !== expected) {
      errors.push(
        `${path}: generated file is stale (on disk ${sha256Hex(actual).slice(0, 12)}, expected ${sha256Hex(expected).slice(0, 12)}) — ` +
          "run `node ./scripts/generate-runtime-readiness.mjs --write` and commit the result",
      );
    }
  }
  // A stray fixture nobody generates is a supported-surface path with no source.
  for (const sub of ["", "/accept", "/reject"]) {
    const dir = join(root, FIXTURE_DIR + sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (!name.isFile()) continue;
      const path = `${FIXTURE_DIR}${sub}/${name.name}`;
      if (!files.has(path)) errors.push(`${path}: fixture is not produced by the generator — remove it or add its case to the contract`);
    }
  }
  return errors;
}

function main(argv) {
  const files = generate();
  if (argv.includes("--write")) {
    write(files);
    console.log(`Wrote ${files.size} generated runtime-readiness files.`);
    return 0;
  }
  const errors = check(files);
  if (errors.length) {
    console.error("Generated runtime-readiness documentation is stale:");
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log(`Generated runtime-readiness documentation is current (${files.size} files).`);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  process.exit(main(process.argv.slice(2)));
}
