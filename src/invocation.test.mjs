// The invocation declaration (src/invocation.mjs) bound to the effect contract.
//
// contracts/effects.v1.json is read HERE, at test time, and never by the CLI:
// the declaration describes kernel behaviour, it is not interpreted from the
// contract. These cases pin the declaration to the contract in both
// directions; src/effects.test.mjs and src/lifecycle-effects.test.mjs prove
// the behaviour itself by running the CLI.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { knownCommands, parseArgs } from "./cli.mjs";
import { commandNames, resolveInvocationPolicy, subcommandNames } from "./invocation.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readText = (path) => readFileSync(join(ROOT, path), "utf8");
const CONTRACT = JSON.parse(readText("contracts/effects.v1.json"));
// The `*refused*` row names no command; its exemption is the per-outcome rule.
const ROWS = CONTRACT.rows.filter((row) => row.command !== "*refused*");

const COMMAND_NAMES = [
  "build", "bundle", "checkpoint", "demo", "doctor", "findings", "help",
  "install-agent-context", "install-skills", "login", "logout", "next", "page-kit", "polish", "prepare-build",
  "qa", "readback", "record", "run", "run-record", "sdk", "spec", "standardize", "start",
  "telemetry", "theme", "tooling", "validate-assembly-report",
];
const DRY_RUN_IMPLEMENTERS = [
  "checkpoint accept", "checkpoint waive", "install-agent-context", "install-skills", "page-kit sync", "qa publish",
  "record brief", "record build", "record deploy", "record polish", "record setup", "record spec", "record theme", "run end", "run-record", "spec derive", "theme waive",
];

// What a row's invocation needs beyond its own tokens to be the form the row
// declares, as src/effects.test.mjs INVOCATIONS runs it.
const PREREQUISITES = {
  doctor: { packet: "campaign-runtime.build.json" },
  "doctor|--no-write": { packet: "campaign-runtime.build.json", write: true },
  "doctor|--no-live-refs": { packet: "campaign-runtime.build.json" },
  "sdk repin": { target: "static-campaign" },
};

const pairOf = (row) => [row.command, row.subcommand].filter(Boolean).join(" ");
function rowArgs(row) {
  const args = { _: pairOf(row).split(" ") };
  for (const flag of row.flags) args[flag.slice(2)] = true;
  return { ...args, ...PREREQUISITES[[pairOf(row), ...row.flags].join("|")] };
}
// Through the CLI's own parser, so these cases see the argv shape main() does.
const policyOf = (argv) => {
  const args = parseArgs(argv);
  return resolveInvocationPolicy(args._[0], args);
};

const CLI_SOURCE = readText("src/cli.mjs");
function functionSource(name) {
  const start = CLI_SOURCE.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `src/cli.mjs no longer defines ${name}()`);
  return CLI_SOURCE.slice(start, CLI_SOURCE.indexOf("\n}\n", start));
}

test("invocation: the declaration names exactly the 28 commands, and knownCommands() is that list", () => {
  assert.deepEqual([...commandNames()].sort(), COMMAND_NAMES);
  assert.deepEqual(knownCommands(), commandNames());
});

// A dispatch() branch for a command the declaration does not name fails here,
// before the CLI can run it under default policy. main() branches on nothing.
test("invocation: dispatch() branches on exactly the declared commands, and main() tests no command or flag", () => {
  const literals = [...functionSource("dispatch").matchAll(/command\s*===\s*["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(literals)].sort(), [...commandNames()].sort());
  const main = functionSource("main");
  assert.doesNotMatch(main, /command\s*[!=]==/);
  assert.doesNotMatch(main, /\bargs(\.|\[)/);
});

test("invocation: every contract row resolves in the declaration, and every declared subcommand has a row", () => {
  for (const row of ROWS) {
    assert.ok(commandNames().includes(row.command), `${row.effect_test}: ${row.command} is not declared`);
    if (row.subcommand) {
      const [subcommand] = row.subcommand.split(" ");
      assert.ok(subcommandNames(row.command).includes(subcommand), `${row.effect_test}: ${row.command} ${subcommand} is not declared`);
    }
  }
  const rowPairs = new Set(ROWS.filter((row) => row.subcommand).map((row) => `${row.command} ${row.subcommand.split(" ")[0]}`));
  for (const command of commandNames()) {
    for (const subcommand of subcommandNames(command)) {
      assert.ok(rowPairs.has(`${command} ${subcommand}`), `${command} ${subcommand} is declared but has no effect row`);
    }
  }
});

test("invocation: every readOnlyHint row resolves journal-exempt", () => {
  for (const row of ROWS.filter((candidate) => candidate.annotations.readOnlyHint)) {
    const args = rowArgs(row);
    assert.equal(resolveInvocationPolicy(row.command, args).journalExempt, true, `${row.effect_test} would journal`);
  }
});

test("invocation: the --dry-run implementers are exactly the twelve, and every --dry-run row is one of them or runs inline", () => {
  const implementers = [];
  for (const command of commandNames()) {
    if (resolveInvocationPolicy(command, { _: [command] }).implementsDryRun) implementers.push(command);
    for (const subcommand of subcommandNames(command)) {
      if (resolveInvocationPolicy(command, { _: [command, subcommand] }).implementsDryRun) implementers.push(`${command} ${subcommand}`);
    }
  }
  assert.deepEqual(implementers.sort(), DRY_RUN_IMPLEMENTERS);
  for (const row of ROWS.filter((candidate) => candidate.flags.includes("--dry-run"))) {
    const policy = resolveInvocationPolicy(row.command, rowArgs(row));
    if (implementers.includes(pairOf(row))) continue;
    // The one row outside the twelve: `tooling setup --dry-run`, whose inline
    // handler owns the flag itself. Any other command is a drift.
    assert.equal(pairOf(row), "tooling setup", `${row.effect_test}: --dry-run on a command that does not implement it`);
    assert.equal(policy.class, "inline");
    assert.equal(policy.sweepRoot, null);
    assert.equal(policy.wrapper, false);
  }
});

// Declared behaviour at this revision, preserved as it is: presence of
// --dry-run suppresses the sweep but only a bare flag exempts the journal; the
// `run status` exemption needs the explicit token; `<cmd> --help` is `<cmd>`.
test("invocation: the sweep exceptions, the valued --dry-run split, bare run and help routing", () => {
  assert.equal(policyOf(["start", "--target", "t"]).sweepRoot, "target");
  assert.equal(policyOf(["start", "--target", "t", "--help"]).sweepRoot, "target");
  assert.equal(policyOf(["start", "--target", "t", "--no-write"]).sweepRoot, null);
  assert.equal(policyOf(["build", "--target", "t", "--no-run-session"]).sweepRoot, null);
  assert.equal(policyOf(["run", "start"]).sweepRoot, "session");
  assert.equal(policyOf(["run", "status"]).sweepRoot, null);
  assert.equal(policyOf(["run", "end", "--dry-run", "yes"]).sweepRoot, null);
  assert.equal(policyOf(["run", "end", "--dry-run", "yes"]).journalExempt, false);
  assert.equal(policyOf(["run", "end", "--dry-run"]).journalExempt, true);
  assert.equal(policyOf(["install-skills", "--dry-run", "x"]).journalExempt, false);
  assert.equal(policyOf(["qa", "run", "--dry-run"]).journalExempt, false);
  assert.equal(policyOf(["run", "status"]).journalExempt, true);
  assert.equal(policyOf(["run"]).journalExempt, false);
  assert.equal(policyOf(["doctor", "--packet", "p", "--write"]).journalExempt, false);
  assert.equal(policyOf(["help"]).journalExempt, true);
  assert.equal(policyOf(["tooling", "status", "--help"]).journalExempt, false);
  assert.equal(policyOf(["login", "--help"]).wrapper, false);
  assert.deepEqual(policyOf(["sdk", "storage-check"]), policyOf(["sdk", "storage-check", "extra"]));
  assert.equal(policyOf(["sdk", "storage-check"]).ambient, true);
  assert.equal(policyOf(["readback", "--packet", "p"]).ambient, false);
  assert.equal(policyOf(["qa", "run"]).autoEnd, true);
  assert.equal(policyOf(["qa", "publish"]).autoEnd, false);
});

test("invocation: the declaration is data, imports nothing from cli.mjs, and nothing in src/ reads the effect contract", () => {
  const source = readText("src/invocation.mjs");
  const declaration = source.slice(source.indexOf("const CLASS_STEPS"), source.indexOf("export const commandNames"));
  assert.doesNotMatch(declaration, /=>|\bfunction\b/, "a declaration entry is a function");
  assert.doesNotMatch(source, /from\s+["']\.\/cli\.mjs["']/);
  for (const file of readdirSync(join(ROOT, "src"), { recursive: true }).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))) {
    assert.doesNotMatch(readText(`src/${file}`), /effects\.v1\.json["'`]/, `src/${file} names the effect contract as a path`);
  }
});

test("invocation: sdk repin journals only under --apply, and never sweeps", () => {
  assert.equal(policyOf(["sdk", "repin", "--target", "t"]).journalExempt, true);
  assert.equal(policyOf(["sdk", "repin", "--target", "t", "--apply"]).journalExempt, false);
  assert.equal(policyOf(["sdk", "repin", "--target", "t", "--apply"]).sweepRoot, null);
});
