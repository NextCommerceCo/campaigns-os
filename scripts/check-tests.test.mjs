import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DURATIONS_PATH, discoverTests, heaviestFirst, mergeDurations, parseShard, readDurations, runTests, selectShard, shardFromArgv, weightsFor } from "./check-tests.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "campaigns-test-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["src/nested", "scripts/nested"]) mkdirSync(join(root, directory), { recursive: true });
  return root;
}
const quietSpawn = (command, args, options) => {
  // These fixture processes are independent runners, not children managed by
  // this test worker. Node suppresses nested --test execution with this marker.
  const env = { ...options.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(command, args, { ...options, env, stdio: "pipe" });
};

test("nested failures in either source or scripts fail the unit lane; browser files stay separate", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "src/existing.test.mjs"), "import test from 'node:test'; test('existing', () => {});");
  for (const path of ["src/nested/feature.test.mjs", "scripts/nested/check.test.mjs"]) {
    for (const regression of ["throw new Error('nested regression');", "import test from 'node:test'; test('fails', () => { throw new Error('nested regression'); });"]) {
      writeFileSync(join(root, path), regression);
      assert.notEqual(runTests(root, { spawn: quietSpawn }), 0, `${path}: ${regression}`);
    }
    writeFileSync(join(root, path), "import test from 'node:test'; test('passes', () => {});");
  }
  writeFileSync(join(root, "src/nested/proof.browser.test.mjs"), "throw new Error('browser only');");
  assert.equal(discoverTests(root).length, 3);
  assert.equal(runTests(root, { spawn: quietSpawn }), 0);
  assert.notEqual(runTests(root, { browser: true, spawn: quietSpawn }), 0);
  writeFileSync(join(root, "src/nested/proof.browser.test.mjs"), "import assert from 'node:assert/strict'; assert.equal(process.env.CAMPAIGNS_OS_REQUIRE_BROWSER, '1');");
  assert.equal(runTests(root, { browser: true, spawn: quietSpawn }), 0);
});

test("an empty lane cannot report success", (t) => {
  const root = fixture(t);
  for (const browser of [false, true]) assert.throws(() => runTests(root, { browser }), /No .* tests discovered/);
});

test("signal termination is reported and remains a failing result", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "src/one.test.mjs"), "");
  const messages = [];
  assert.equal(runTests(root, { spawn: () => ({ status: null, signal: "SIGKILL" }), report: (message) => messages.push(message) }), 1);
  assert.deepEqual(messages, ["Test process terminated by SIGKILL"]);
});

test("shards split a lane into disjoint slices that together run every file", () => {
  const files = Array.from({ length: 7 }, (_, i) => `src/f${i}.test.mjs`);
  for (const total of [1, 2, 3, 7, 8]) {
    const slices = Array.from({ length: total }, (_, i) => selectShard(files, { index: i + 1, total }));
    assert.deepEqual(slices.flat().sort(), files, `total ${total}`);
    assert.equal(new Set(slices.flat()).size, files.length, `total ${total}: a file ran twice`);
  }
  assert.deepEqual(selectShard(files, { index: 2, total: 3 }), ["src/f1.test.mjs", "src/f4.test.mjs"]);
  assert.equal(selectShard(files, undefined), files);
});

test("a malformed or out-of-range shard is refused rather than running a partial lane", () => {
  assert.deepEqual(parseShard("2/2"), { index: 2, total: 2 });
  for (const value of ["0/2", "3/2", "1/0", "2", "1/2/3", "a/b", " 1/2", "", undefined]) {
    assert.throws(() => parseShard(value), /--shard takes <index>\/<total>/, String(value));
  }
  assert.deepEqual(shardFromArgv(["--browser", "--shard", "1/2"]), { index: 1, total: 2 });
  assert.deepEqual(shardFromArgv(["--shard=2/2"]), { index: 2, total: 2 });
  assert.equal(shardFromArgv(["--browser"]), undefined);
  // CI interpolates the matrix value; an empty one must fail, not run nothing.
  assert.throws(() => shardFromArgv(["--shard"]), /--shard takes/);
  assert.throws(() => shardFromArgv(["--shard", ""]), /--shard takes/);
});

test("a shard runs only its slice, and an empty slice fails the lane", (t) => {
  const root = fixture(t);
  for (const name of ["a", "b", "c"]) writeFileSync(join(root, `src/${name}.test.mjs`), "");
  const runs = [];
  const spawn = (_command, args) => { runs.push(args.slice(1)); return { status: 0 }; };
  const report = () => {};
  assert.equal(runTests(root, { shard: { index: 1, total: 2 }, spawn, report }), 0);
  assert.equal(runTests(root, { shard: { index: 2, total: 2 }, spawn, report }), 0);
  assert.deepEqual(runs, [["src/a.test.mjs", "src/c.test.mjs"], ["src/b.test.mjs"]]);
  assert.throws(() => runTests(root, { shard: { index: 4, total: 4 }, spawn, report }), /Shard 4\/4 of the unit lane is empty/);
});

test("weighted shards separate the heaviest files and balance the rest", () => {
  const weights = { "src/a.test.mjs": 100, "src/b.test.mjs": 90, "src/c.test.mjs": 10, "src/d.test.mjs": 10, "src/e.test.mjs": 5 };
  const files = Object.keys(weights).sort();
  const weightOf = (file) => weights[file];
  const [first, second] = [1, 2].map((index) => selectShard(files, { index, total: 2 }, weightOf));
  assert.deepEqual(first, ["src/a.test.mjs", "src/d.test.mjs"]);
  assert.deepEqual(second, ["src/b.test.mjs", "src/c.test.mjs", "src/e.test.mjs"]);
  // The alphabetical round-robin this replaced put a, c and e together: 115 against 100.
  assert.deepEqual([first, second].map((shard) => shard.reduce((sum, file) => sum + weightOf(file), 0)), [110, 105]);
});

test("runTests splits by the recorded durations, and an unrecorded file weighs the lane's median", (t) => {
  const root = fixture(t);
  for (const name of ["a", "b", "c", "d"]) writeFileSync(join(root, `src/${name}.test.mjs`), "");
  writeFileSync(join(root, DURATIONS_PATH), JSON.stringify({ unit: { "src/a.test.mjs": 300, "src/b.test.mjs": 280, "src/c.test.mjs": 2 } }));
  const runs = [];
  const spawn = (_command, args) => { runs.push(args.slice(1)); return { status: 0 }; };
  for (const index of [1, 2]) runTests(root, { shard: { index, total: 2 }, spawn, report: () => {} });
  // d is unrecorded and weighs the median (280): a (300) runs with c, b with d.
  assert.deepEqual(runs, [["src/a.test.mjs", "src/c.test.mjs"], ["src/b.test.mjs", "src/d.test.mjs"]]);
  assert.equal(weightsFor({})("src/x.test.mjs"), 1);
  assert.equal(weightsFor({ "src/a.test.mjs": 3, "src/b.test.mjs": 9 })("src/x.test.mjs"), 3);
});

test("a lane or shard starts its slowest files first, whatever their paths", (t) => {
  const root = fixture(t);
  for (const name of ["a", "b", "c", "d"]) writeFileSync(join(root, `src/${name}.test.mjs`), "");
  writeFileSync(join(root, DURATIONS_PATH), JSON.stringify({ unit: { "src/a.test.mjs": 1, "src/b.test.mjs": 30, "src/c.test.mjs": 5 } }));
  const runs = [];
  const spawn = (_command, args) => { runs.push(args.slice(1)); return { status: 0 }; };
  runTests(root, { spawn, report: () => {} });
  runTests(root, { shard: { index: 2, total: 2 }, spawn, report: () => {} });
  // d is unrecorded and weighs the median (5), so it follows c by path; b alone fills shard 1.
  assert.deepEqual(runs, [
    ["src/b.test.mjs", "src/c.test.mjs", "src/d.test.mjs", "src/a.test.mjs"],
    ["src/c.test.mjs", "src/d.test.mjs", "src/a.test.mjs"],
  ]);
  assert.deepEqual(heaviestFirst(["src/b.test.mjs", "src/a.test.mjs"]), ["src/a.test.mjs", "src/b.test.mjs"]);
});

test("the lane runner starts files in the order it is given, where node --test sorts them by path", (t) => {
  const root = fixture(t);
  for (const name of ["a", "b", "c"]) writeFileSync(join(root, `src/${name}.test.mjs`), `import test from 'node:test'; test('${name} ran', () => {});`);
  writeFileSync(join(root, DURATIONS_PATH), JSON.stringify({ unit: { "src/a.test.mjs": 1, "src/b.test.mjs": 3, "src/c.test.mjs": 2 } }));
  let output = "";
  const spawn = (command, args, options) => {
    const result = quietSpawn(command, args, options);
    output = String(result.stdout);
    return result;
  };
  assert.equal(runTests(root, { spawn, report: () => {} }), 0);
  // Files report in the order they were handed to the runner, which is the order they start in.
  assert.deepEqual(output.match(/\b[abc] ran\b/g), ["b ran", "c ran", "a ran"]);
  const cli = quietSpawn(process.execPath, ["--test", "--test-reporter=spec", "src/b.test.mjs", "src/c.test.mjs", "src/a.test.mjs"], { cwd: root, env: process.env });
  assert.deepEqual(String(cli.stdout).match(/\b[abc] ran\b/g), ["a ran", "b ran", "c ran"]);
});

test("a recorded duration is the file's whole run, imports included, not the sum of its tests", (t) => {
  const root = fixture(t);
  // Half a second of module setup and one instant test: its tests sum to about 0s.
  writeFileSync(join(root, "src/slow-setup.test.mjs"), "import test from 'node:test'; await new Promise((done) => setTimeout(done, 500)); test('quick', () => {});");
  writeFileSync(join(root, "src/quick.test.mjs"), "import test from 'node:test'; test('quick', () => {});");
  assert.equal(runTests(root, { record: true, spawn: quietSpawn, report: () => {} }), 0);
  const recorded = readDurations(root, "unit");
  assert.deepEqual(Object.keys(recorded).sort(), ["src/quick.test.mjs", "src/slow-setup.test.mjs"]);
  assert.ok(recorded["src/slow-setup.test.mjs"] >= 0.5, JSON.stringify(recorded));
  assert.ok(recorded["src/slow-setup.test.mjs"] > recorded["src/quick.test.mjs"], JSON.stringify(recorded));
});

test("a missing durations file means equal weights; a malformed one fails loudly", (t) => {
  const root = fixture(t);
  assert.deepEqual(readDurations(root, "unit"), {});
  writeFileSync(join(root, DURATIONS_PATH), "{ not json");
  assert.throws(() => readDurations(root, "unit"), SyntaxError);
});

test("recording keeps unmeasured files, drops files that left the lane, and rounds to 0.1s", () => {
  assert.deepEqual(
    mergeDurations({ "src/kept.test.mjs": 4, "src/gone.test.mjs": 9 }, ["src/kept.test.mjs", "src/new.test.mjs"], { "src/new.test.mjs": 1.234 }),
    { "src/kept.test.mjs": 4, "src/new.test.mjs": 1.2 },
  );
});

test("--record-durations writes a passing run's timings, and leaves them alone after a failure or a file with no run time", (t) => {
  const root = fixture(t);
  for (const name of ["a", "b"]) writeFileSync(join(root, `src/${name}.test.mjs`), "");
  writeFileSync(join(root, DURATIONS_PATH), JSON.stringify({ browser: { "src/x.browser.test.mjs": 5 }, unit: { "src/a.test.mjs": 1 } }));
  const spawnWriting = (status, milliseconds) => (_command, args) => {
    const destination = args.find((arg) => arg.startsWith("--durations=")).slice("--durations=".length);
    // The runner reports real paths, and the fixture root may sit behind a symlink (macOS /var).
    writeFileSync(destination, JSON.stringify(Object.fromEntries(Object.entries(milliseconds).map(([file, ms]) => [join(realpathSync(root), file), ms]))));
    return { status };
  };
  const both = { "src/a.test.mjs": 1500, "src/b.test.mjs": 2500 };
  const messages = [];
  const report = (message) => messages.push(message);
  assert.equal(runTests(root, { record: true, spawn: spawnWriting(1, both), report }), 1);
  assert.deepEqual(readDurations(root, "unit"), { "src/a.test.mjs": 1 });
  assert.equal(runTests(root, { record: true, spawn: spawnWriting(0, { "src/b.test.mjs": 2500 }), report }), 1);
  assert.deepEqual(readDurations(root, "unit"), { "src/a.test.mjs": 1 });
  assert.equal(messages.at(-1), "durations not recorded: no run time reported for 1 of 2 unit files (src/a.test.mjs)");
  assert.equal(runTests(root, { record: true, spawn: spawnWriting(0, both), report }), 0);
  assert.deepEqual(readDurations(root, "unit"), { "src/a.test.mjs": 1.5, "src/b.test.mjs": 2.5 });
  assert.deepEqual(readDurations(root, "browser"), { "src/x.browser.test.mjs": 5 }, "recording one lane leaves the other");
});
