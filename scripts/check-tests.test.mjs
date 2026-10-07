import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { discoverTests, parseShard, runTests, selectShard, shardFromArgv } from "./check-tests.mjs";

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
    writeFileSync(join(root, path), "throw new Error('nested regression');");
    assert.notEqual(runTests(root, { spawn: quietSpawn }), 0, path);
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
