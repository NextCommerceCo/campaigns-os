import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { discoverTests, runTests } from "./check-tests.mjs";

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
