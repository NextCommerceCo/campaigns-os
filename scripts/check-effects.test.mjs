// Two things are under test here.
//
// 1. The effects gate itself: coverage of the supported CLI surface, the link
//    from every row to a test case that exists, and the internal consistency
//    the annotations promise. Each rule is exercised by mutating a good
//    contract until it breaks, because a checker that passes on the repository
//    as it stands has proved nothing about what it would catch.
//
// 2. The classification of the paths this change puts on the supported surface.
//    `contracts/effects.v1.json`, `agents/**`, `src/agent/**` and `skills/**`
//    must all classify as agent-relevant, with the class the policy names. The
//    failure this guards against is specific and has happened before: a path
//    under a broad ignore prefix (`src/`, `agents/`, `contracts/`) is added to
//    the surface and is silently swallowed by the ignore, so a change to it
//    never owes a ledger entry.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkEffects, declaredTestNames, generatedTestName, helpInvocations, helpUsageLines, invocationKeys, rowKey, testConditions } from "./check-effects.mjs";
import { classifyPath } from "./orientation-contract.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (path) => readFileSync(resolve(root, path), "utf8");
const readJson = (path) => JSON.parse(read(path));

const policy = readJson("contracts/agent-relevant-change-policy.v1.json");
const surface = readJson("contracts/supported-surface.json");
const contract = readJson("contracts/effects.v1.json");
const schema = readJson("schemas/campaigns-os-effects.v1.schema.json");
const cliSource = read("src/cli.mjs");
const testSource = read("src/effects.test.mjs");

const clone = (value) => JSON.parse(JSON.stringify(value));
const run = (mutate) => {
  const mutated = clone(contract);
  mutate(mutated);
  return checkEffects({ contract: mutated, schema, surface, cliSource, testSource });
};

test("check-effects passes on the repository as it stands", () => {
  assert.deepEqual(checkEffects({ contract, schema, surface, cliSource, testSource }), []);
});

test("check-effects refuses a supported command with no row", () => {
  const errors = run((mutated) => {
    mutated.rows = mutated.rows.filter((row) => row.command !== "readback");
  });
  assert.ok(errors.some((error) => error.includes('supported command "readback" has no row')), errors.join("\n"));
});

test("check-effects refuses a documented subcommand with no row", () => {
  const errors = run((mutated) => {
    mutated.rows = mutated.rows.filter((row) => !(row.command === "page-kit" && row.subcommand === "parity"));
  });
  assert.ok(errors.some((error) => error.includes("campaigns-os page-kit parity")), errors.join("\n"));
});

test("check-effects refuses a row that names no test, and one whose test does not exist", () => {
  // The schema catches an empty name first and the gate stops there, which is
  // the behaviour we want (one structural error, not twenty symptoms) — so the
  // rule itself is exercised with the schema pass off.
  const bySchema = run((mutated) => {
    mutated.rows[0].effect_test = "";
  });
  assert.ok(bySchema.some((error) => error.includes("effect_test")), bySchema.join("\n"));
  const withoutName = checkEffects({
    contract: { ...contract, rows: [{ ...contract.rows[0], effect_test: "" }] },
    schema: null,
    surface: { cli_commands: [] },
    cliSource: "const HELP = `Campaigns OS toolkit\n`;",
    testSource,
  });
  assert.ok(withoutName.some((error) => error.includes("names no effect_test")), withoutName.join("\n"));

  // With the generator gone, the link is checked name by name — which is the
  // mode that catches a row pointing at a case nobody wrote.
  const literalOnly = checkEffects({
    contract: { ...contract, rows: [{ ...contract.rows[0], effect_test: "effects: a case nobody wrote" }] },
    schema: null,
    surface: { cli_commands: [] },
    cliSource: "const HELP = `Campaigns OS toolkit\n`;",
    testSource: 'test("effects: help", () => {});',
  });
  assert.ok(literalOnly.some((error) => error.includes("effects: a case nobody wrote")), literalOnly.join("\n"));
});

test("check-effects refuses an unreachable effect with no stated reason", () => {
  const errors = run((mutated) => {
    const row = mutated.rows.find((candidate) => candidate.writes.length > 0);
    row.writes[0].observed_in = [];
    delete row.writes[0].not_observed_reason;
  });
  assert.ok(errors.some((error) => error.includes("carries no not_observed_reason")), errors.join("\n"));
});

test("check-effects refuses annotations that disagree with the row", () => {
  const readOnlyWithWrites = run((mutated) => {
    const row = mutated.rows.find((candidate) => candidate.command === "page-kit" && candidate.subcommand === "sync" && candidate.flags.length === 0);
    row.annotations.readOnlyHint = true;
  });
  assert.ok(readOnlyWithWrites.some((error) => error.includes("readOnlyHint: true but declares")), readOnlyWithWrites.join("\n"));

  const openWorldWithoutSend = run((mutated) => {
    mutated.rows.find((candidate) => candidate.command === "help").annotations.openWorldHint = true;
  });
  assert.ok(openWorldWithoutSend.some((error) => error.includes("openWorldHint must be true exactly")), openWorldWithoutSend.join("\n"));

  const sendOffTierA = run((mutated) => {
    const row = mutated.rows.find((candidate) => candidate.command === "page-kit" && candidate.subcommand === "sync" && candidate.flags.length === 0);
    row.annotations.openWorldHint = true;
    row.sends = [{ destination: "{proxy-base}/api/anything", what: "x", when: "y", requires_consent: false, observed_in: [], not_observed_reason: "hypothetical" }];
  });
  assert.ok(sendOffTierA.some((error) => error.includes("a row that can contact an endpoint is tier A or C")), sendOffTierA.join("\n"));

  const destructiveOffTierC = run((mutated) => {
    mutated.rows.find((candidate) => candidate.command === "page-kit" && candidate.subcommand === "sync" && candidate.flags.length === 0).annotations.destructiveHint = true;
  });
  assert.ok(destructiveOffTierC.some((error) => error.includes("destructive is tier C")), destructiveOffTierC.join("\n"));
});

test("check-effects refuses two rows claiming the same invocation", () => {
  const errors = run((mutated) => {
    mutated.rows.push(clone(mutated.rows[0]));
  });
  assert.ok(errors.some((error) => error.includes("two rows claim the invocation")), errors.join("\n"));
});

test("check-effects refuses a preflight row that does not say what it cannot reach", () => {
  const errors = run((mutated) => {
    const row = mutated.rows.find((candidate) => candidate.test_scope === "preflight");
    row.notes = "It works.";
  });
  assert.ok(errors.some((error) => error.includes("do not say what the offline fixture cannot reach")), errors.join("\n"));
});

test("check-effects refuses the deletion of an effect-changing flag's row", () => {
  // The cheapest way to make an effect disappear from the file, and the one
  // coverage-by-command missed: delete the flag row, keep the base form, and
  // the gate was satisfied. Checked on a flag row whose command has a base row
  // (so the command itself is still covered) and on one that changes nothing
  // but where the write lands.
  for (const [command, subcommand, flag] of [["page-kit", "sync", "--dry-run"], ["doctor", null, "--write"], ["qa", "run", "--browser"]]) {
    const errors = run((mutated) => {
      mutated.rows = mutated.rows.filter(
        (row) => !(row.command === command && row.subcommand === subcommand && row.flags.includes(flag)),
      );
    });
    assert.ok(
      errors.some((error) => error.includes(`${flag}" is an effect-changing flag`)),
      `deleting the ${command} ${flag} row was accepted:\n${errors.join("\n")}`,
    );
  }
});

test("check-effects refuses a row whose generated test name is not the one the generator gives it", () => {
  // Recognizing the generator made the existence check vacuous: every row's
  // case is named `row.effect_test`, so any string at all "existed".
  const errors = run((mutated) => {
    mutated.rows[0].effect_test = "effects: NONEXISTENT_REVIEW_CASE";
  });
  assert.ok(
    errors.some((error) => error.includes("effects: NONEXISTENT_REVIEW_CASE") && error.includes("names this row's case")),
    errors.join("\n"),
  );
  // …and the name is a function of the row, so a preflight row that drops the
  // suffix is caught by the same rule.
  assert.equal(generatedTestName({ command: "qa", subcommand: "run", flags: ["--browser"], test_scope: "preflight" }), "effects: qa run --browser (preflight)");
  assert.equal(generatedTestName({ command: "*refused*", subcommand: null, flags: [], test_scope: "full" }), "effects: a refused invocation");
});

test("check-effects refuses a row with no invocation to run, and an invocation with no row", () => {
  const orphanRow = run((mutated) => {
    mutated.rows.push({ ...clone(mutated.rows[0]), command: "standardize", subcommand: null, flags: ["--force"], effect_test: "effects: standardize --force" });
  });
  assert.ok(orphanRow.some((error) => error.includes("has no entry in the INVOCATIONS table")), orphanRow.join("\n"));

  const orphanInvocation = checkEffects({
    contract, schema, surface, cliSource,
    testSource: `${testSource}\nconst UNUSED = 0;`.replace('const INVOCATIONS = {', 'const INVOCATIONS = {\n  "sdk nonexistent-subcommand": { argv: () => [] },'),
  });
  assert.ok(orphanInvocation.some((error) => error.includes("sdk nonexistent-subcommand")), orphanInvocation.join("\n"));
});

test("check-effects refuses a preflight row whose allowances are missing or license a subtree", () => {
  // The schema catches a preflight row with no allowances first, and the gate
  // stops there — so the rule itself is exercised with the schema pass off,
  // the way the effect_test rule above is.
  const bySchema = run((mutated) => {
    delete mutated.rows.find((row) => row.test_scope === "preflight").preflight;
  });
  assert.ok(bySchema.some((error) => error.includes("must have required property 'preflight'")), bySchema.join("\n"));
  const missing = checkEffects({
    contract: { ...contract, rows: contract.rows.filter((row) => row.test_scope === "preflight").map(({ preflight, ...row }) => row) },
    schema: null,
    surface: { cli_commands: [] },
    cliSource: "const HELP = `Campaigns OS toolkit\n`;",
    testSource,
  });
  assert.ok(missing.some((error) => error.includes("declares no preflight allowances")), missing.join("\n"));

  // The exact shape that let a home write through: `{home}/**` as an allowance.
  const homeWildcard = run((mutated) => {
    mutated.rows.find((row) => row.test_scope === "preflight").preflight.may_write = ["{home}/**"];
  });
  assert.ok(homeWildcard.some((error) => error.includes("spans segments under the user's home directory")), homeWildcard.join("\n"));

  const wholeLocation = run((mutated) => {
    mutated.rows.find((row) => row.test_scope === "preflight").preflight.may_write = ["{target}"];
  });
  assert.ok(wholeLocation.some((error) => error.includes("licenses a whole location")), wholeLocation.join("\n"));

  const looseContact = run((mutated) => {
    mutated.rows.find((row) => row.test_scope === "preflight").preflight.may_contact = ["anything"];
  });
  assert.ok(looseContact.some((error) => error.includes("is not a request path")), looseContact.join("\n"));

  const uncovered = run((mutated) => {
    const row = mutated.rows.find((candidate) => candidate.test_scope === "preflight" && candidate.writes.some((write) => write.observed_in.length > 0));
    row.preflight.may_write = [];
  });
  assert.ok(uncovered.some((error) => error.includes("is observed but preflight.may_write does not allow it")), uncovered.join("\n"));

  const onFullRow = run((mutated) => {
    mutated.rows.find((row) => row.test_scope === "full").preflight = { may_write: [], may_contact: [] };
  });
  assert.ok(onFullRow.some((error) => error.includes('declares preflight allowances but is test_scope "full"')), onFullRow.join("\n"));
});

test("check-effects refuses a condition the effect test does not run", () => {
  // The schema pins the condition set, so the disagreement this rule is about
  // is checked with the schema pass off: a vocabulary that names a condition
  // the suite never runs is a row claiming proof it never got.
  const errors = checkEffects({
    contract: { ...contract, vocabulary: { ...contract.vocabulary, conditions: { ...contract.vocabulary.conditions, invented_condition: "nobody runs this" } } },
    schema: null,
    surface,
    cliSource,
    testSource,
  });
  assert.ok(errors.some((error) => error.includes("must be exercised")), errors.join("\n"));
  // The fifth condition is the one this repair added; it has to be in both.
  assert.ok(testConditions(testSource).includes("persisted_consent"), "src/effects.test.mjs no longer runs the persisted-consent condition");
  assert.ok("persisted_consent" in contract.vocabulary.conditions, "the contract no longer declares the persisted-consent condition");
});

test("check-effects refuses a write path with no location token", () => {
  const errors = run((mutated) => {
    const row = mutated.rows.find((candidate) => candidate.writes.length > 0);
    row.writes[0].path = "some/relative/path.json";
  });
  assert.ok(errors.some((error) => error.includes("does not open with a location token")), errors.join("\n"));
});

test("the help scan finds the documented subcommands and the test scan finds the generator", () => {
  const invocations = helpInvocations(cliSource);
  assert.ok(invocations.get("run")?.has("status"), "the help scan missed `run status`");
  assert.ok(invocations.get("qa")?.has("publish"), "the help scan missed `qa publish`");
  assert.equal(declaredTestNames(testSource).generated, true, "the per-row generator in src/effects.test.mjs is no longer recognizable");
});

test("the help scan reads the flags off a usage line, wrapped lines included", () => {
  const lines = helpUsageLines(cliSource);
  const usage = (command, subcommand = null) => lines.find((line) => line.command === command && line.subcommand === subcommand);
  // `start` spells --force and --no-run-session on its THIRD wrapped line, so a
  // line-at-a-time scan would have seen neither.
  assert.ok(usage("start")?.flags.has("--force"), "the usage scan missed `start --force` on a wrapped line");
  assert.ok(usage("start")?.flags.has("--no-run-session"), "the usage scan missed `start --no-run-session`");
  // …and `readback --example` spells its flag without brackets.
  assert.ok(lines.some((line) => line.command === "readback" && line.flags.has("--example")), "the usage scan missed `readback --example`");
  // Prose paragraphs are not usage lines, whatever flags they mention.
  assert.equal(lines.some((line) => line.command === "commands"), false);
  // The invocation table is read the same way, statically.
  assert.ok(invocationKeys(testSource).has("qa policy set"), "the INVOCATIONS scan missed a multi-word subcommand key");
  assert.ok(invocationKeys(testSource).has("doctor|--built --emit-packet"), "the INVOCATIONS scan missed a two-flag key");
});

test("rowKey distinguishes a base form from its effect-changing flags", () => {
  assert.equal(rowKey({ command: "next", subcommand: null, flags: [] }), "next");
  assert.equal(rowKey({ command: "next", subcommand: null, flags: ["--no-write"] }), "next|--no-write");
  assert.equal(rowKey({ command: "qa", subcommand: "policy set", flags: [] }), "qa policy set");
});

// --- the classification half -------------------------------------------------

test("the paths this change declares are agent-relevant, with the class the policy names", () => {
  const expected = [
    ["contracts/effects.v1.json", "compatibility_policy"],
    ["schemas/campaigns-os-effects.v1.schema.json", "schema"],
    ["docs/effects.md", "named_surface"],
    ["agents/claude/CLAUDE.md", "documentation"],
    ["agents/codex/AGENTS.md", "documentation"],
    ["agents/copilot/copilot-instructions.md", "documentation"],
    ["agents/cursor/campaigns-os.mdc", "documentation"],
    // Hypothetical, deliberately: the rule has to be in place BEFORE the
    // subtree exists, or its first change is born unclassified.
    ["src/agent/install.mjs", "cli_surface"],
    ["skills/next-campaigns-os/SKILL.md", "skill"],
  ];
  for (const [path, expectedClass] of expected) {
    const result = classifyPath(path, { policy, surface });
    assert.equal(result.relevant, true, `${path} classified as NOT agent-relevant (${result.source}: ${result.reason ?? "unclassified"})`);
    assert.equal(result.class, expectedClass, `${path} classified as ${result.class}, expected ${expectedClass}`);
  }
});

test("a new agents/ or src/agent/ path is not swallowed by the broad ignore prefixes", () => {
  // The exact failure mode: `agents/` used to be ignored as illustrative and
  // `src/` still is. Both rules must win over their ignore, and the rule pass
  // runs before the ignore pass, so the assertion is on `source`.
  for (const path of ["agents/claude/CLAUDE.md", "agents/some-new-platform/instructions.md", "src/agent/install.mjs"]) {
    const result = classifyPath(path, { policy, surface });
    assert.equal(result.source, "rule", `${path} was classified by ${result.source}, not by an explicit rule`);
    assert.notEqual(result.source, "ignored");
  }
  // And the rest of src/ is still implementation, so the new rule is narrow.
  assert.equal(classifyPath("src/cli-loading.test.mjs", { policy, surface }).source, "ignored");
});
