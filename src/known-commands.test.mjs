import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { knownCommands } from "./cli.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

// Run the CLI and capture stderr, regardless of exit code.
function runCli(args) {
  try {
    execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
}

// Guards against a future dispatch refactor (switch table, extracted constant,
// quote/format change the regex can't follow) silently emptying the derived
// list. If this fails, knownCommands() stopped seeing dispatch's branches and
// did-you-mean degraded with no other signal.
test("knownCommands covers the real dispatch branches", () => {
  const commands = knownCommands();
  for (const expected of [
    "help",
    "start",
    "prepare-build",
    "build",
    "build",
    "doctor",
    "standardize",
    "standardization-report",
    "theme",
    "tooling",
    "next",
    "qa",
    "findings",
    "run-record",
    "telemetry",
    "run",
  ]) {
    assert.ok(commands.includes(expected), `knownCommands() should include "${expected}"`);
  }
});

test("did-you-mean suggests the nearest command on a close typo", () => {
  const out = runCli(["doctorr", "--packet", "x"]);
  assert.match(out, /Did you mean "doctor"\?/);
  assert.match(out, /campaigns-os --help/);
});

test("did-you-mean is case-insensitive", () => {
  const out = runCli(["Doctor", "--packet", "x"]);
  assert.match(out, /Did you mean "doctor"\?/);
});

test("a short typo does not produce a confidently-wrong suggestion", () => {
  // `dr` is edit-distance 2 from `qa`; the length-scaled budget (1 for <=3
  // chars) must reject it rather than suggest an unrelated command.
  const out = runCli(["dr"]);
  assert.match(out, /Unknown command: dr\./);
  assert.doesNotMatch(out, /Did you mean/);
});

test("an unrelated command gets no suggestion but still points at help", () => {
  const out = runCli(["frobnicate"]);
  assert.match(out, /Unknown command: frobnicate\./);
  assert.doesNotMatch(out, /Did you mean/);
  assert.match(out, /campaigns-os --help/);
});
