import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  appendDeviation,
  buildRecommendation,
  detectDeviation,
  DEVIATION_SCHEMA,
  expectedCommandsForStage,
  readDeviations,
} from "./deviation.mjs";
import { buildRunSession, writeRunSession } from "./run-session.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

test("expectedCommandsForStage merges stage defaults with gate action commands", () => {
  assert.deepEqual(expectedCommandsForStage("qa"), ["qa", "theme"]);
  assert.deepEqual(expectedCommandsForStage("deploy"), []);
  const withActions = expectedCommandsForStage("polish", [
    { command: "campaigns-os theme generate --packet p.json" },
    { command: "npm run qa:install-browser" },
    { command: null },
  ]);
  assert.deepEqual(withActions, ["polish", "theme"]);
});

test("polish capture is a registered stage command for recommendation and deviation tracking", () => {
  assert.deepEqual(expectedCommandsForStage("polish"), ["polish", "theme"]);
  const rec = buildRecommendation({ stage: "qa", status: "ready", expectedCommands: ["qa", "theme"] });
  assert.equal(detectDeviation({ lastRecommendation: rec, command: "polish" })?.actual_command, "polish");
});

test("hosted QA keeps polish capture as a deviation", () => {
  const expectedCommands = expectedCommandsForStage("qa", [], {
    packet: { deploy: { target: "hosted" } }, report: {}, polishGate: { status: "carried_forward" },
  });
  const rec = buildRecommendation({ stage: "qa", status: "ready", expectedCommands });
  assert.deepEqual(expectedCommands, ["qa", "theme"]);
  assert.equal(detectDeviation({ lastRecommendation: rec, command: "polish", subcommand: "capture" })?.actual_command, "polish");
});

test("local-serve carried-forward QA allows polish capture without a deviation", () => {
  const expectedCommands = expectedCommandsForStage("qa", [], {
    packet: { deploy: { target: "local-serve" } }, report: { stages: { polish: { status: "required" } } },
    polishGate: { status: "carried_forward" },
  });
  const rec = buildRecommendation({ stage: "qa", status: "ready", expectedCommands });
  assert.deepEqual(expectedCommands, ["qa", "theme", "polish"]);
  assert.equal(detectDeviation({ lastRecommendation: rec, command: "polish", subcommand: "capture" }), null);
});

test("detectDeviation flags a tracked command outside the recommendation", () => {
  const rec = buildRecommendation({ stage: "polish", status: "ready", expectedCommands: ["theme"], now: new Date("2026-06-11T00:00:00Z") });
  const entry = detectDeviation({
    lastRecommendation: rec,
    command: "qa",
    argvShape: ["qa", "run"],
    runId: "run_x",
    now: new Date("2026-06-11T00:05:00Z"),
  });
  assert.equal(entry.schema_version, DEVIATION_SCHEMA);
  assert.equal(entry.recommended_stage, "polish");
  assert.equal(entry.actual_command, "qa");
  assert.equal(entry.deviation_reason, null);
});

test("detectDeviation stays quiet for expected, untracked, or unrecommended states", () => {
  const rec = buildRecommendation({ stage: "qa", status: "ready", expectedCommands: ["qa", "theme"] });
  assert.equal(detectDeviation({ lastRecommendation: rec, command: "qa" }), null, "expected command");
  assert.equal(detectDeviation({ lastRecommendation: rec, command: "doctor" }), null, "untracked command");
  assert.equal(detectDeviation({ lastRecommendation: null, command: "qa" }), null, "no recommendation yet");
});

test("deviation journal round-trips and tolerates junk lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-deviation-"));
  try {
    const journal = join(dir, ".campaign-runtime/agent-deviations.jsonl");
    const rec = buildRecommendation({ stage: "polish", status: "ready", expectedCommands: ["theme"] });
    const entry = detectDeviation({ lastRecommendation: rec, command: "qa", deviationReason: "operator asked for early QA" });
    appendDeviation(journal, entry);
    appendDeviation(journal, { ...entry, deviation_reason: null });
    const entries = readDeviations(journal);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].deviation_reason, "operator asked for early QA");
    assert.deepEqual(readDeviations(join(dir, "missing.jsonl")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commandWord reads the verb through every install prefix", async () => {
  const { commandWord } = await import("./deviation.mjs");
  assert.equal(commandWord("campaigns-os next --packet p.json"), "next");
  assert.equal(commandWord("npx --no-install campaigns-os qa run --packet p.json"), "qa");
  // What versions before 1.41.2 printed, still read from older sessions.
  assert.equal(commandWord("npx campaigns-os qa run --packet p.json"), "qa");
  assert.equal(commandWord("npm run campaigns-os -- polish capture"), "polish");
  assert.equal(commandWord("npx --yes github:NextCommerceCo/campaigns-os#236d7fc454c8 theme generate"), "theme");
  assert.equal(commandWord("npm run qa:install-browser"), null);
  assert.equal(commandWord(null), null);
});

test("setup and metadata subcommands of a tracked command never deviate; qa run still does", () => {
  const rec = buildRecommendation({ stage: "polish", status: "ready", expectedCommands: ["polish", "theme"] });
  assert.equal(detectDeviation({ lastRecommendation: rec, command: "qa", subcommand: "install-browser" }), null);
  assert.equal(detectDeviation({ lastRecommendation: rec, command: "qa", subcommand: "policy" }), null);
  assert.equal(detectDeviation({ lastRecommendation: rec, command: "qa", subcommand: "resolve" }), null);
  assert.equal(detectDeviation({ lastRecommendation: rec, command: "qa", subcommand: "run" })?.actual_command, "qa");
  assert.equal(detectDeviation({ lastRecommendation: rec, command: "qa", subcommand: "waive" })?.actual_command, "qa");
});

test("later-stage start is a valid re-intake, while help never deviates", () => {
  const rec = buildRecommendation({ stage: "qa", status: "ready", expectedCommands: expectedCommandsForStage("qa") });
  assert.equal(detectDeviation({ lastRecommendation: rec, command: "start" }), null);
  for (const command of ["qa", "start", "polish", "theme"]) {
    assert.equal(detectDeviation({ lastRecommendation: rec, command, subcommand: "run", argvShape: [command, "--help"] }), null, command);
  }
});

// A project root holding an open run session whose last `next` recommended
// the polish stage, and a copy of the example packet targeting that root.
function withRecommendedPolishSession(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-deviation-cli-"));
  writeFileSync(join(dir, "package.json"), "{}\n");
  const packet = JSON.parse(readFileSync(join(ROOT, "examples/build-packet.basic.json"), "utf8"));
  packet.assembly.target_repo = ".";
  const packetPath = join(dir, "campaign-runtime.build.json");
  writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  writeRunSession(dir, {
    ...buildRunSession({ runId: "run_deviation", lifecycleJournal: join(dir, ".campaign-runtime/command-lifecycle.jsonl") }),
    last_recommendation: buildRecommendation({ stage: "polish", status: "ready", expectedCommands: ["polish", "theme"] }),
  });
  try {
    return run({ dir, packetPath, journal: join(dir, ".campaign-runtime/agent-deviations.jsonl") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const runCli = (dir, argv) => spawnSync(process.execPath, [CLI, ...argv], { cwd: dir, encoding: "utf8" });

test("CLI: qa policy set during another stage records no deviation", () => {
  withRecommendedPolishSession(({ dir, packetPath, journal }) => {
    const run = runCli(dir, ["qa", "policy", "set", "--packet", packetPath, "--order-path-depth", "common", "--json"]);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /deviation recorded/);
    assert.equal(existsSync(journal), false);
  });
});

test("CLI: qa resolve during another stage records no deviation", () => {
  withRecommendedPolishSession(({ dir, packetPath, journal }) => {
    const run = runCli(dir, ["qa", "resolve", "--packet", packetPath, "--base-url", "http://127.0.0.1:9/runtime-packet-demo/", "--no-probe", "--json"]);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /deviation recorded/);
    assert.equal(existsSync(journal), false);
  });
});

test("CLI: help forms never append lifecycle or deviation entries in an active run", () => {
  withRecommendedPolishSession(({ dir, packetPath, journal }) => {
    const lifecycle = join(dir, ".campaign-runtime/command-lifecycle.jsonl");
    for (const argv of [["qa", "run", "--help"], ["start", "--help"], ["polish", "--help"], ["theme", "--help"]]) {
      const run = runCli(dir, [...argv, "--packet", packetPath]);
      assert.equal(run.status, 0, `${argv.join(" ")}: ${run.stderr}`);
      assert.equal(existsSync(lifecycle), false, `${argv.join(" ")} journaled`);
      assert.equal(existsSync(journal), false, `${argv.join(" ")} deviated`);
    }
  });
});

test("CLI: an out-of-turn qa run with --deviation-reason prints one confirming line and no warning", () => {
  withRecommendedPolishSession(({ dir, packetPath, journal }) => {
    const run = runCli(dir, ["qa", "run", "--packet", packetPath, "--base-url", "http://127.0.0.1:9/runtime-packet-demo/",
      "--no-post-verdict", "--no-remit", "--deviation-reason", "operator asked for early QA", "--json"]);
    const lines = run.stderr.split("\n").filter((line) => /deviation recorded/.test(line));
    assert.deepEqual(lines, ['[campaigns-os] deviation recorded with reason: `qa` ran while next recommended stage "polish"; reason: "operator asked for early QA".']);
    assert.doesNotMatch(run.stderr, /Declare intent with --deviation-reason/);
    const entries = readDeviations(journal);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].actual_command, "qa");
    assert.equal(entries[0].deviation_reason, "operator asked for early QA");
  });
});

test("CLI: an out-of-turn qa run without a reason is still recorded and warned", () => {
  withRecommendedPolishSession(({ dir, packetPath, journal }) => {
    const run = runCli(dir, ["qa", "run", "--packet", packetPath, "--base-url", "http://127.0.0.1:9/runtime-packet-demo/",
      "--no-post-verdict", "--no-remit", "--json"]);
    assert.match(run.stderr, /deviation recorded: `qa` ran while next recommended stage "polish" \(expected: polish, theme\)\. Declare intent with --deviation-reason/);
    assert.equal(readDeviations(journal).length, 1);
  });
});
