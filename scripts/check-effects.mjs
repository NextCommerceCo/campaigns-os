#!/usr/bin/env node

/**
 * Effects gate: contracts/effects.v1.json says what every supported invocation
 * writes and sends, and this check makes that claim COMPLETE and PROVED.
 *
 * A declared-effects file is only worth reading if two things hold, and neither
 * is something a JSON Schema can state:
 *
 *   1. Coverage. Every command on the supported CLI surface, every subcommand
 *      the help text teaches, AND every effect-changing flag a help usage line
 *      carries has its own row. A command with no row is a command whose
 *      effects were never declared — the failure mode that makes an agent trust
 *      the file and then be surprised by it. A FLAG with no row is the same
 *      failure one level down: `doctor --write` writes three files the base
 *      form does not, so "doctor is declared" is not an answer.
 *   2. Proof. Every row names a node:test case in src/effects.test.mjs, and
 *      that case EXISTS. Because the cases are GENERATED from this file
 *      (`test(row.effect_test, …)`), "the name exists" is only meaningful if
 *      the name is also the one the generator would produce and the row has an
 *      invocation in the test's table — otherwise any string at all passes.
 *      Both are checked here. A row without its test is a claim nobody checked,
 *      so it is refused rather than published. The `test_scope: "preflight"`
 *      rows — the ones whose command cannot execute past its preflight offline
 *      — additionally have to say so in their own notes, declare exactly what
 *      the preflight may write and which request paths the test may see, and
 *      every declared effect the fixture cannot reach has to carry its reason.
 *
 * Plus the internal consistency the annotations promise: a readOnlyHint row
 * declares no effects and sits at tier none; openWorldHint is true exactly when
 * the row declares a send; a destructive row is not read-only; and no two rows
 * claim the same invocation.
 *
 * Run from `npm run check` (check:effects) and from `npm run check:contracts`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

// fileURLToPath, never URL.pathname: pathname percent-encodes, which silently
// breaks root resolution for a checkout whose path contains a space.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const EFFECTS_PATH = "contracts/effects.v1.json";
export const EFFECTS_SCHEMA_PATH = "schemas/campaigns-os-effects.v1.schema.json";
export const EFFECTS_TEST_PATH = "src/effects.test.mjs";
export const SURFACE_PATH = "contracts/supported-surface.json";
export const CLI_PATH = "src/cli.mjs";

const read = (path) => readFileSync(resolve(root, path), "utf8");

/**
 * The location tokens that name a DIRECTORY rather than one file. A preflight
 * allowance may be the bare `{lifecycle-journal}`, `{spec}` or `{packet}` —
 * each is a single file — but naming one of these licenses everything under it.
 */
const DIRECTORY_LOCATIONS = new Set(["{target}", "{cwd}", "{home}"]);

/** The invocation a row is about, as one comparable key. */
export const rowKey = (row) =>
  [[row.command, row.subcommand].filter(Boolean).join(" "), ...(row.flags?.length ? [row.flags.join(" ")] : [])].join("|");

/**
 * The `test("<name>", …)` case names declared in the effect test file. A regex
 * over the source, not an import: importing a test file RUNS it, and this gate
 * has to be cheap enough to sit in `npm run check` ahead of the suite.
 */
export function declaredTestNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/\btest\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) {
    names.add(match[2].replace(/\\(.)/g, "$1"));
  }
  // The generated cases are named from the contract itself, which the regex
  // cannot see. Recognize that ONE generator shape explicitly, so a rename of
  // the generator is a loud failure here rather than a silently empty set.
  const generated = /\btest\(\s*row\.effect_test\s*,/.test(source);
  return { names, generated };
}

/**
 * The case name the generator in src/effects.test.mjs produces for a row.
 *
 * The generator names each case `row.effect_test`, so recognizing it made the
 * "this test exists" check vacuous: ANY string, including one naming no case at
 * all, was satisfied by the generator's existence. The name is therefore a
 * FUNCTION of the row and is checked as one — a row that names
 * "effects: NONEXISTENT" is refused because that is not the name the generator
 * would give it.
 */
export function generatedTestName(row) {
  const invocation = row.command === "*refused*"
    ? "a refused invocation"
    : [row.command, row.subcommand, ...(row.flags ?? [])].filter(Boolean).join(" ");
  return `effects: ${invocation}${row.test_scope === "preflight" ? " (preflight)" : ""}`;
}

/**
 * The keys of the INVOCATIONS table in src/effects.test.mjs — the argv each row
 * is proved with. Parsed statically for the same reason the names are: the file
 * must not be imported to be checked. A row with no entry has no invocation to
 * run, which the suite would only discover at runtime.
 */
export function invocationKeys(testSource) {
  const start = testSource.indexOf("const INVOCATIONS = {");
  if (start === -1) throw new Error(`${EFFECTS_TEST_PATH}: could not find the INVOCATIONS table`);
  const end = testSource.indexOf("\n};", start);
  const table = testSource.slice(start, end === -1 ? undefined : end);
  const keys = new Set();
  for (const match of table.matchAll(/^ {2}"((?:\\.|[^"\\])*)":/gm)) keys.add(match[1].replace(/\\(.)/g, "$1"));
  return keys;
}

/** The conditions src/effects.test.mjs runs every row under, in order. */
export function testConditions(testSource) {
  const match = testSource.match(/const CONDITIONS = \[([^\]]*)\]/);
  if (!match) throw new Error(`${EFFECTS_TEST_PATH}: could not find the CONDITIONS list`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

/**
 * Every usage line the help block teaches, as `{ command, subcommand, flags }`.
 * The help block is the contract an operator reads, so it is the coverage
 * input: a subcommand or an effect-changing flag documented there and absent
 * from the effects file is exactly the gap this gate exists to catch.
 *
 * A usage line may wrap (the intake commands carry three), so a more-indented
 * line continues the one above it; any other line ends the record. The flags
 * are read from the whole record, brackets or not — `readback --example` spells
 * its flag without them.
 */
export function helpUsageLines(cliSource) {
  const start = cliSource.indexOf("const HELP = `");
  if (start === -1) throw new Error(`${CLI_PATH}: could not find the HELP block`);
  const end = cliSource.indexOf("\n`;", start);
  const help = cliSource.slice(start, end === -1 ? undefined : end);
  const records = [];
  let current = null;
  for (const line of help.split("\n")) {
    const usage = line.match(/^ {2}campaigns-os ([a-z-]+)(?: ([a-z-]+))?/);
    if (usage) {
      const [, command, second] = usage;
      // A second token that is a value placeholder or a flag is not a subcommand.
      current = { command, subcommand: second && !second.startsWith("-") ? second : null, text: line, flags: new Set() };
      records.push(current);
      continue;
    }
    if (current && /^ {4,}\S/.test(line)) {
      current.text += `\n${line}`;
      continue;
    }
    current = null;
  }
  for (const record of records) {
    for (const match of record.text.matchAll(/--[a-z0-9-]+/g)) record.flags.add(match[0]);
  }
  return records;
}

/**
 * Every `campaigns-os <command> <subcommand>` pair the help text teaches.
 */
export function helpInvocations(cliSource) {
  const found = new Map();
  for (const record of helpUsageLines(cliSource)) {
    if (!found.has(record.command)) found.set(record.command, new Set());
    if (record.subcommand) found.get(record.command).add(record.subcommand);
  }
  return found;
}

export function checkEffects({ contract, schema, surface, cliSource, testSource }) {
  const errors = [];
  const rows = contract.rows ?? [];
  if (contract.schema !== "campaigns-os-effects/v1") {
    errors.push(`${EFFECTS_PATH}: schema must be "campaigns-os-effects/v1"`);
  }

  // The shape first: the rules below read fields the schema guarantees exist,
  // so a structural break is reported as one rather than as twenty symptoms.
  if (schema) {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    if (!validate(contract)) {
      for (const error of validate.errors ?? []) {
        errors.push(`${EFFECTS_PATH}: ${error.instancePath || "/"} ${error.message}`);
      }
      return errors;
    }
  }

  // --- one row per invocation, no duplicates
  const byKey = new Map();
  for (const row of rows) {
    const key = rowKey(row);
    if (byKey.has(key)) errors.push(`${EFFECTS_PATH}: two rows claim the invocation ${key}`);
    byKey.set(key, row);
  }

  // --- coverage: the supported CLI surface
  const covered = new Set(rows.map((row) => row.command));
  for (const command of surface.cli_commands ?? []) {
    if (!covered.has(command)) {
      errors.push(`${EFFECTS_PATH}: supported command "${command}" has no row — declare its effects or drop it from ${SURFACE_PATH}`);
    }
  }

  // --- coverage: every subcommand the help text teaches
  const coveredSubcommands = new Map();
  for (const row of rows) {
    if (!coveredSubcommands.has(row.command)) coveredSubcommands.set(row.command, new Set());
    // A row's subcommand may be a multi-word spelling (`policy set`); the help
    // scan sees its first token, so index by that.
    if (row.subcommand) coveredSubcommands.get(row.command).add(row.subcommand.split(" ")[0]);
  }
  const usageLines = helpUsageLines(cliSource);
  for (const [command, subcommands] of helpInvocations(cliSource)) {
    for (const subcommand of subcommands) {
      if (!coveredSubcommands.get(command)?.has(subcommand)) {
        errors.push(`${EFFECTS_PATH}: "campaigns-os ${command} ${subcommand}" is documented in the CLI help but has no row`);
      }
    }
  }

  // --- coverage: every effect-changing flag a usage line carries
  //
  // Coverage by command alone accepted the deletion of a flag row, which is the
  // cheapest way to make an effect disappear from this file: `doctor --write`
  // writes the doctor sidecar, the report and the packet that `doctor` does not.
  // The vocabulary names which flags change what an invocation does to the
  // world; every one of them that appears on a usage line owes a row of its own.
  const effectChangingFlags = new Set(contract.vocabulary?.effect_changing_flags ?? []);
  if (effectChangingFlags.size === 0) {
    errors.push(`${EFFECTS_PATH}: vocabulary.effect_changing_flags is empty — flag coverage cannot be checked`);
  }
  for (const record of usageLines) {
    for (const flag of record.flags) {
      if (!effectChangingFlags.has(flag)) continue;
      const covered = rows.some(
        (row) =>
          row.command === record.command &&
          (record.subcommand === null || (row.subcommand ?? "").split(" ")[0] === record.subcommand) &&
          (row.flags ?? []).includes(flag),
      );
      if (!covered) {
        const invocation = `campaigns-os ${[record.command, record.subcommand].filter(Boolean).join(" ")}`;
        errors.push(
          `${EFFECTS_PATH}: "${invocation} ${flag}" is an effect-changing flag the CLI help carries but no row declares` +
            ` — a flag row is how a reader learns that ${flag} changes what the invocation does`,
        );
      }
    }
  }

  // --- proof: every row names the test case the generator gives it
  const { names, generated } = declaredTestNames(testSource);
  // A test file with no table at all is reported rather than thrown, so one
  // structural break does not hide the rest of the report.
  let tableKeys = null;
  try {
    tableKeys = invocationKeys(testSource);
  } catch (error) {
    errors.push(`${EFFECTS_TEST_PATH}: ${error.message}`);
  }
  if (!generated && rows.length > names.size) {
    errors.push(`${EFFECTS_TEST_PATH}: no per-row test generator found and not every row has a literal case — the proof link is broken`);
  }
  for (const row of rows) {
    if (!row.effect_test?.trim()) {
      errors.push(`${EFFECTS_PATH}: row ${rowKey(row)} names no effect_test — a row without its test is not publishable`);
      continue;
    }
    const key = rowKey(row);
    // A generated case is named from the row, so "the case exists" is only a
    // claim about the name being the one the generator produces. Check that,
    // rather than accepting any string because a generator was spotted.
    const expected = generatedTestName(row);
    if (generated && row.effect_test !== expected) {
      errors.push(
        `${EFFECTS_PATH}: row ${key} names the test case "${row.effect_test}", which no case declares:` +
          ` the generator in ${EFFECTS_TEST_PATH} names this row's case "${expected}"`,
      );
    }
    // A literal case must actually be there.
    if (!generated && !names.has(row.effect_test)) {
      errors.push(`${EFFECTS_PATH}: row ${key} names the test case "${row.effect_test}", which ${EFFECTS_TEST_PATH} does not declare`);
    }
    // …and the generated case is only a proof if the row has argv to run.
    if (tableKeys && !tableKeys.has(key)) {
      errors.push(`${EFFECTS_PATH}: row ${key} has no entry in the INVOCATIONS table of ${EFFECTS_TEST_PATH} — its case would have nothing to run`);
    }
  }
  for (const key of tableKeys ?? []) {
    if (!byKey.has(key)) {
      errors.push(`${EFFECTS_TEST_PATH}: the INVOCATIONS table declares ${key}, which no row in ${EFFECTS_PATH} claims`);
    }
  }

  // --- the conditions the vocabulary names are the conditions the test runs
  // A condition defined here and not exercised there would be a row claiming
  // proof it never got — which is how a consent-gated send stayed hidden.
  const declaredConditions = Object.keys(contract.vocabulary?.conditions ?? {});
  try {
    const runConditions = testConditions(testSource);
    if (declaredConditions.join(",") !== runConditions.join(",")) {
      errors.push(
        `${EFFECTS_PATH}: vocabulary.conditions names [${declaredConditions.join(", ")}] but ${EFFECTS_TEST_PATH}` +
          ` runs [${runConditions.join(", ")}] — every declared condition must be exercised`,
      );
    }
  } catch (error) {
    errors.push(`${EFFECTS_TEST_PATH}: ${error.message}`);
  }

  const locations = Object.keys(contract.vocabulary?.locations ?? {});
  for (const row of rows) {
    const key = rowKey(row);
    const effects = [...(row.writes ?? []), ...(row.sends ?? [])];

    // --- an effect the fixture cannot reach has to say why
    for (const effect of effects) {
      const label = effect.path ?? effect.destination;
      if ((effect.observed_in ?? []).length === 0 && !effect.not_observed_reason?.trim()) {
        errors.push(`${EFFECTS_PATH}: ${key}: the declared effect ${label} is observed in no condition and carries no not_observed_reason`);
      }
      if ((effect.observed_in ?? []).length > 0 && effect.not_observed_reason) {
        errors.push(`${EFFECTS_PATH}: ${key}: ${label} is both observed and carries a not_observed_reason`);
      }
    }

    // --- a preflight row states what it cannot reach, in its own notes
    if (row.test_scope === "preflight" && !/preflight/i.test(row.notes ?? "")) {
      errors.push(`${EFFECTS_PATH}: ${key} is test_scope "preflight" but its notes do not say what the offline fixture cannot reach`);
    }
    // --- and states what the preflight may touch, exactly
    //
    // A preflight row's whole claim is "the refusal writes nothing beyond
    // this and contacts nothing beyond that". Expressed only through the
    // row's `writes`, that claim was weaker than it read: a write declared
    // for the path the command takes when it SUCCEEDS (`{home}/**` for a
    // minted credential) also licensed the preflight to write anywhere under
    // the home directory, and a destination the loopback receiver only stands
    // in for licensed any request path at all. The allowances are therefore
    // declared separately from the declared effects, and exactly: a glob
    // across segments is refused, and the contacted paths are literal.
    if (row.test_scope === "preflight") {
      const allowance = row.preflight;
      if (!allowance) {
        errors.push(
          `${EFFECTS_PATH}: ${key} is test_scope "preflight" but declares no preflight allowances` +
            ` — state what the preflight may write (preflight.may_write) and which request paths the test may see (preflight.may_contact)`,
        );
      } else {
        for (const path of allowance.may_write ?? []) {
          if (!locations.some((token) => path === token || path.startsWith(`${token}/`))) {
            errors.push(`${EFFECTS_PATH}: ${key}: preflight.may_write ${path} does not open with a location token (${locations.join(", ")})`);
          }
          // A subtree allowance is fine where the preflight really does write a
          // tree (a QA attempt's evidence). What is not fine is licensing a
          // whole location — `{target}/**`, and above all anything under
          // `{home}`, where the skills directories, the credential store and
          // the consent file live. `{home}/**` is exactly how a home write
          // injected into the `logout` preflight passed.
          if (DIRECTORY_LOCATIONS.has(path) || locations.some((token) => path === `${token}/**`)) {
            errors.push(
              `${EFFECTS_PATH}: ${key}: preflight.may_write ${path} licenses a whole location — a preflight allowance names the paths it may write`,
            );
          }
          if (path.startsWith("{home}") && path.includes("**")) {
            errors.push(
              `${EFFECTS_PATH}: ${key}: preflight.may_write ${path} spans segments under the user's home directory` +
                ` — name the file the preflight may write there, or the home directory it must not write is licensed wholesale`,
            );
          }
        }
        for (const path of allowance.may_contact ?? []) {
          if (!path.startsWith("/")) {
            errors.push(`${EFFECTS_PATH}: ${key}: preflight.may_contact ${path} is not a request path — name the exact path the test may see (e.g. "/api/runs")`);
          }
        }
        // An allowance that does not cover what the row says it writes in a
        // condition is a contradiction, and the test would fail on one of the
        // two. Catch it here, where the message can say which.
        for (const write of row.writes ?? []) {
          if ((write.observed_in ?? []).length === 0) continue;
          if (!(allowance.may_write ?? []).includes(write.path)) {
            errors.push(`${EFFECTS_PATH}: ${key}: the write ${write.path} is observed but preflight.may_write does not allow it`);
          }
        }
      }
    }
    if (row.test_scope !== "preflight" && row.preflight) {
      errors.push(`${EFFECTS_PATH}: ${key} declares preflight allowances but is test_scope "${row.test_scope}"`);
    }
    // --- and a full row is one whose effects were actually seen
    if (row.test_scope === "full" && effects.length > 0 && !effects.some((effect) => (effect.observed_in ?? []).length > 0)) {
      errors.push(`${EFFECTS_PATH}: ${key} is test_scope "full" but none of its declared effects is observed in any condition — mark it "preflight" and say why`);
    }

    // --- the annotations have to agree with the row
    const { readOnlyHint, destructiveHint, openWorldHint } = row.annotations ?? {};
    if (readOnlyHint && effects.length > 0) {
      errors.push(`${EFFECTS_PATH}: ${key} is readOnlyHint: true but declares ${effects.length} effect(s)`);
    }
    if (readOnlyHint && row.tier !== "none") {
      errors.push(`${EFFECTS_PATH}: ${key} is readOnlyHint: true but sits at tier ${row.tier}`);
    }
    if (readOnlyHint && destructiveHint) {
      errors.push(`${EFFECTS_PATH}: ${key} is both readOnlyHint and destructiveHint`);
    }
    if (openWorldHint !== ((row.sends ?? []).length > 0)) {
      errors.push(`${EFFECTS_PATH}: ${key}: openWorldHint must be true exactly when the row declares a send`);
    }
    // The tier is the HIGHEST class the invocation reaches, ranked
    // none < B < A < C. A row that can contact an endpoint therefore cannot sit
    // at B, however local the rest of its effects are — the mistake this catches
    // is a writer row that quietly grew a send.
    if (openWorldHint && !["A", "C"].includes(row.tier)) {
      errors.push(`${EFFECTS_PATH}: ${key} declares a send but sits at tier ${row.tier} — a row that can contact an endpoint is tier A or C`);
    }
    if (destructiveHint && row.tier !== "C") {
      errors.push(`${EFFECTS_PATH}: ${key} is destructiveHint: true but sits at tier ${row.tier} — destructive is tier C`);
    }
    if (row.tier === "none" && effects.length > 0) {
      errors.push(`${EFFECTS_PATH}: ${key} sits at tier none but declares an effect`);
    }

    // --- every write path opens with a known location token
    for (const write of row.writes ?? []) {
      if (!locations.some((token) => write.path === token || write.path.startsWith(`${token}/`))) {
        errors.push(`${EFFECTS_PATH}: ${key}: write path ${write.path} does not open with a location token (${locations.join(", ")})`);
      }
    }
  }

  return errors;
}

export function main() {
  const contract = JSON.parse(read(EFFECTS_PATH));
  const surface = JSON.parse(read(SURFACE_PATH));
  const errors = checkEffects({
    contract,
    schema: JSON.parse(read(EFFECTS_SCHEMA_PATH)),
    surface,
    cliSource: read(CLI_PATH),
    testSource: read(EFFECTS_TEST_PATH),
  });
  if (errors.length) {
    console.error(`check-effects: ${errors.length} problem(s)\n${errors.map((error) => `  - ${error}`).join("\n")}`);
    process.exitCode = 1;
    return;
  }
  const preflight = contract.rows.filter((row) => row.test_scope === "preflight").length;
  console.log(
    `check-effects: OK — ${contract.rows.length} declared invocations ` +
      `(${contract.rows.length - preflight} proved end to end, ${preflight} proved at the preflight), ` +
      `${surface.cli_commands.length} supported commands covered`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
