import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withDirectoryLock, withDirectoryLockSync } from "./directory-lock.mjs";

const MODULE_URL = new URL("./directory-lock.mjs", import.meta.url).href;
const unavailable = (error) => Object.assign(new Error(`lock unavailable: ${error?.code ?? error?.message}`), { cause: error });
const tick = (ms = 5) => new Promise((done) => setTimeout(done, ms));

async function withScratch(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-directory-lock-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function until(ready, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

function runChild(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`child exited ${code}: ${stderr}`))));
  });
}

test("an ownerless lock directory is never taken over, however old (#501)", () => withScratch(async (dir) => {
  // What a writer suspended between creating the lock and recording its owner
  // leaves on disk. Its age is not evidence the writer is gone.
  const lock = join(dir, "lock");
  mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  let entered = false;
  await assert.rejects(
    withDirectoryLock(lock, () => { entered = true; }, { budgetMs: 150, unavailable }),
    /lock unavailable: EEXIST/,
  );
  assert.equal(entered, false, "the critical section was not entered");
  assert.deepEqual(readdirSync(lock), [], "the ownerless directory is left for the offline procedure");
}));

// A writer is suspended (in a child process) in the middle of acquiring the
// lock, at its first owner.json write. Another writer then acquires the lock,
// with the suspended writer's directory aged past any ownerless grace period,
// and releases the suspended writer from inside its critical section. Before
// #501 the lock directory existed before its owner, so the second writer
// recovered it as abandoned, and the resumed first writer wrote its owner
// into the second writer's directory and entered alongside it. Now the owner
// is staged beside the lock and published with it, so the first writer finds
// the lock held and waits.
test("a writer suspended mid-acquisition never shares the critical section (#501)", () => withScratch(async (dir) => {
  const lock = join(dir, "lock");
  const log = join(dir, "sections.log");
  const gap = join(dir, "gap.signal");
  const resume = join(dir, "resume.signal");
  const retry = join(dir, "retry.signal");
  const preload = join(dir, "suspend-owner-write.cjs");
  writeFileSync(log, "");
  writeFileSync(preload, `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalWrite = fs.writeFileSync;
let ownerWrites = 0;
fs.writeFileSync = function suspendFirstOwnerWrite(file, ...rest) {
  if (String(file).includes("owner.json")) {
    ownerWrites += 1;
    if (ownerWrites === 1) {
      originalWrite.call(fs, process.env.LOCK_GAP, "");
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(process.env.LOCK_RESUME) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    } else if (ownerWrites === 2) {
      originalWrite.call(fs, process.env.LOCK_RETRY, "");
    }
  }
  return originalWrite.call(fs, file, ...rest);
};
syncBuiltinESMExports();
`);
  const first = runChild(`
import { appendFileSync } from "node:fs";
import { withDirectoryLock } from ${JSON.stringify(MODULE_URL)};
await withDirectoryLock(${JSON.stringify(lock)}, () => {
  appendFileSync(${JSON.stringify(log)}, "first enter\\n");
  appendFileSync(${JSON.stringify(log)}, "first exit\\n");
}, { budgetMs: 20000, unavailable: (error) => error });
`, {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${preload}`.trim(),
    LOCK_GAP: gap,
    LOCK_RESUME: resume,
    LOCK_RETRY: retry,
  });
  await until(() => existsSync(gap), "the first writer to reach its owner write");
  // Stand in for the grace period passing, deterministically.
  if (existsSync(lock)) {
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
  }

  let secondResult;
  try {
    await withDirectoryLock(lock, async () => {
      writeFileSync(log, "second enter\n", { flag: "a" });
      writeFileSync(resume, "");
      // Hold the section until the first writer has either entered (the bug)
      // or come back for a second attempt (it found the lock held).
      await until(
        () => readFileSync(log, "utf8").includes("first enter") || existsSync(retry),
        "the resumed first writer to enter or retry",
      );
      writeFileSync(log, "second exit\n", { flag: "a" });
    }, { budgetMs: 20000, unavailable });
    secondResult = "entered";
  } catch (error) {
    secondResult = error;
    writeFileSync(resume, "");
  }
  await first;
  assert.equal(secondResult, "entered", String(secondResult?.stack ?? secondResult));
  assert.deepEqual(
    readFileSync(log, "utf8").trim().split("\n"),
    ["second enter", "second exit", "first enter", "first exit"],
    "the two critical sections did not overlap",
  );
  assert.equal(existsSync(lock), false, "the lock is released");
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith("lock.")), [], "no staging or tomb directories are left");
}));

test("a writer paused between staging its owner and publishing the lock waits for the holder (#501)", () => withScratch(async (dir) => {
  const lock = join(dir, "lock");
  const events = [];
  let resumeFirst;
  const paused = new Promise((done) => { resumeFirst = done; });
  let firstReachedPublish;
  const reachedPublish = new Promise((done) => { firstReachedPublish = done; });
  let firstAttempts = 0;
  let clock = 0;
  const first = withDirectoryLock(lock, () => { events.push("first enter"); events.push("first exit"); }, {
    budgetMs: 1_000_000,
    unavailable,
    now: () => clock,
    sleep: () => tick(1),
    hooks: {
      beforePublish: async () => {
        firstAttempts += 1;
        if (firstAttempts === 1) {
          firstReachedPublish();
          await paused;
        }
      },
    },
  });
  await reachedPublish;
  // The paused writer has only a staging directory; nothing holds the lock.
  assert.equal(existsSync(lock), false);
  clock = 60_000;
  await withDirectoryLock(lock, async () => {
    events.push("second enter");
    resumeFirst();
    await until(() => firstAttempts >= 2, "the first writer to retry");
    events.push("second exit");
  }, { budgetMs: 1000, unavailable, now: () => clock });
  await first;
  assert.deepEqual(events, ["second enter", "second exit", "first enter", "first exit"]);
}));

test("release never removes a lock directory another holder now owns", () => withScratch(async (dir) => {
  const lock = join(dir, "lock");
  await withDirectoryLock(lock, () => {
    renameSync(lock, join(dir, "moved-away"));
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, token: "someone-else" })}\n`);
  }, { budgetMs: 1000, unavailable });
  assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token, "someone-else");
}));

test("the holder re-enters its own lock, async and sync, without waiting on itself", () => withScratch(async (dir) => {
  const lock = join(dir, "lock");
  const seen = [];
  await withDirectoryLock(lock, async () => {
    const owner = readFileSync(join(lock, "owner.json"), "utf8");
    await withDirectoryLock(lock, () => { seen.push("async"); }, { budgetMs: 50, unavailable });
    withDirectoryLockSync(lock, () => { seen.push("sync"); }, { budgetMs: 50, unavailable });
    assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), owner, "re-entry leaves the holder's lock in place");
  }, { budgetMs: 1000, unavailable });
  assert.deepEqual(seen, ["async", "sync"]);
  assert.equal(existsSync(lock), false);
}));

test("the synchronous form waits out a live foreign holder and refuses a same-process holder at once", () => withScratch(async (dir) => {
  const lock = join(dir, "lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ pid: process.ppid, token: "foreign" })}\n`);
  let entered = false;
  const started = Date.now();
  assert.throws(() => withDirectoryLockSync(lock, () => { entered = true; }, { budgetMs: 100, unavailable }), /lock unavailable: EEXIST/);
  assert.ok(Date.now() - started >= 100, "a foreign live holder is waited for until the budget");
  writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, token: "same-process" })}\n`);
  const sameStart = Date.now();
  assert.throws(() => withDirectoryLockSync(lock, () => { entered = true; }, { budgetMs: 60_000, unavailable }), /lock unavailable: EEXIST/);
  assert.ok(Date.now() - sameStart < 5000, "a same-process holder cannot release while this call blocks, so it refuses at once");
  assert.equal(entered, false);
  assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token, "same-process");
}));

test("contending processes never overlap in the critical section", () => withScratch(async (dir) => {
  const lock = join(dir, "lock");
  const counter = join(dir, "counter");
  writeFileSync(counter, "0");
  const rounds = 8;
  const script = (sync) => `
import { readFileSync, writeFileSync } from "node:fs";
import { withDirectoryLock, withDirectoryLockSync } from ${JSON.stringify(MODULE_URL)};
const options = { budgetMs: 30000, unavailable: (error) => error };
const bump = () => {
  const value = Number(readFileSync(${JSON.stringify(counter)}, "utf8"));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  writeFileSync(${JSON.stringify(counter)}, String(value + 1));
};
for (let i = 0; i < ${rounds}; i += 1) {
  ${sync ? `withDirectoryLockSync(${JSON.stringify(lock)}, bump, options);` : `await withDirectoryLock(${JSON.stringify(lock)}, bump, options);`}
}
`;
  const writers = [true, false, true, false, true, false];
  await Promise.all(writers.map((sync) => runChild(script(sync))));
  assert.equal(Number(readFileSync(counter, "utf8")), writers.length * rounds, "every increment survived: no two writers overlapped");
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith("lock.")), []);
}));
