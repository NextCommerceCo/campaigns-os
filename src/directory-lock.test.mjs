import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
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

test("an ownerless lock is refused after a short grace, not after the whole budget", () => withScratch(async (dir) => {
  const lock = join(dir, "lock");
  mkdirSync(lock);
  let clock = 0;
  await assert.rejects(
    withDirectoryLock(lock, () => {}, { budgetMs: 60_000, unavailable, now: () => clock, sleep: async () => { clock += 100; } }),
    /lock unavailable: EEXIST/,
  );
  assert.ok(clock <= 1100, `refused after ${clock}ms of waiting, not the 60s budget`);
  clock = 0;
  assert.throws(
    () => withDirectoryLockSync(lock, () => {}, { budgetMs: 60_000, unavailable, now: () => clock, sleep: () => { clock += 100; } }),
    /lock unavailable: EEXIST/,
  );
  assert.ok(clock <= 1100);
}));

// Two stats cannot see a lock atomically: a holder can release between the
// waiter's stat of the lock and its stat of owner.json, and the next holder
// can publish before the waiter polls again. Every such sample looks
// ownerless, but no lock ever existed without its owner, so a healthy waiter
// must not be refused by the ownerless grace.
test("holders churning between the waiter's two stats never read as one ownerless lock", () => withScratch(async (dir) => {
  const lock = join(dir, "lock");
  const ownerPath = join(lock, "owner.json");
  const publishHolder = (n) => {
    const staging = join(dir, `holder-${n}`);
    mkdirSync(staging);
    writeFileSync(join(staging, "owner.json"), `${JSON.stringify({ pid: process.ppid, token: `holder-${n}` })}\n`);
    renameSync(staging, lock);
  };
  publishHolder(0);
  let clock = 0;
  let holders = 0;
  const originalLstat = fs.lstatSync;
  fs.lstatSync = function churnBetweenStats(target, ...rest) {
    if (String(target) === ownerPath && clock < 3000 && existsSync(lock)) {
      // The current holder releases just before the owner stat...
      renameSync(lock, join(dir, `released-${holders}`));
      try {
        return originalLstat.call(fs, target, ...rest);
      } finally {
        // ...and the next one publishes before the waiter looks again.
        holders += 1;
        publishHolder(holders);
      }
    }
    return originalLstat.call(fs, target, ...rest);
  };
  syncBuiltinESMExports();
  try {
    let entered = false;
    await withDirectoryLock(lock, () => { entered = true; }, {
      budgetMs: 60_000,
      unavailable,
      now: () => clock,
      sleep: async () => {
        clock += 100;
        if (clock >= 3000) rmSync(lock, { recursive: true, force: true });
      },
    });
    assert.ok(holders >= 10, `the churn was exercised (${holders} holders)`);
    assert.equal(entered, true, "the waiter acquired once the churn stopped, instead of being refused as ownerless");
  } finally {
    clock = Infinity;
    fs.lstatSync = originalLstat;
    syncBuiltinESMExports();
  }
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

// The publishing rename fails because another writer holds the lock, and
// that writer releases before the failure is examined. That is contention,
// and the waiter keeps its remaining budget instead of failing.
test("a publish that loses to a holder who has already released retries instead of failing", () => withScratch(async (dir) => {
  const lock = join(dir, "lock");
  const originalRename = fs.renameSync;
  let raced = false;
  fs.renameSync = function racingRename(from, to, ...rest) {
    if (!raced && String(to) === lock && String(from).includes(".staging-")) {
      raced = true;
      mkdirSync(lock);
      writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, token: "brief-holder" })}\n`);
      try {
        return originalRename.call(fs, from, to, ...rest);
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    }
    return originalRename.call(fs, from, to, ...rest);
  };
  syncBuiltinESMExports();
  try {
    let entered = false;
    await withDirectoryLock(lock, () => { entered = true; }, { budgetMs: 5000, unavailable });
    assert.equal(raced, true, "the race was staged");
    assert.equal(entered, true);
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
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

// Staging, recovery-staging and released siblings outlive a process that dies
// mid-acquisition, or a release whose tomb could not be put back (#514). The
// next holder sweeps the ones whose owner is a dead process, and only those.
test("the holder sweeps lock siblings left by dead processes and keeps every other one (#514)", () => withScratch(async (dir) => {
  const lock = join(dir, "lock");
  // spawnSync returns only after the child has exited and been reaped.
  const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
  const token = () => randomBytes(16).toString("hex");
  const sibling = (name, owner) => {
    mkdirSync(join(dir, name));
    if (owner) writeFileSync(join(dir, name, "owner.json"), `${JSON.stringify(owner)}\n`);
    return name;
  };
  const deadToken = token();
  const dead = [
    sibling(`lock.staging-${deadToken}`, { pid: deadPid, token: deadToken }),
    sibling(`lock.recovery-staging-${token()}`, { pid: deadPid, token: "dead-recoverer" }),
    sibling(`lock.released-${token()}`, { pid: deadPid, token: "dead-releaser" }),
  ];
  const kept = [
    // A live process may still be staging or releasing. This process is
    // alive and can always signal itself, whatever the sandbox.
    sibling(`lock.staging-${token()}`, { pid: process.pid, token: "live" }),
    sibling(`lock.released-${token()}`, { pid: process.pid, token: "live-releaser" }),
    // No readable owner: its process may be between mkdir and owner write.
    sibling(`lock.staging-${token()}`, null),
    // Not a name this lock produces, whatever its owner.
    sibling("lock.staging-not-a-token", { pid: deadPid, token: "dead" }),
    sibling(`lock.abandoned-${token()}`, { pid: deadPid, token: "dead" }),
    sibling(`other.staging-${token()}`, { pid: deadPid, token: "dead" }),
  ];
  writeFileSync(join(dir, `lock.released-${token()}`), "not a directory");
  let seen = null;
  await withDirectoryLock(lock, () => { seen = readdirSync(dir); }, { budgetMs: 1000, unavailable });
  for (const name of dead) assert.equal(seen.includes(name), false, `${name} belongs to a dead process and was swept`);
  for (const name of kept) assert.equal(seen.includes(name), true, `${name} was left in place`);
  assert.equal(seen.filter((name) => name.startsWith("lock.released-")).length, 2, "the live releaser's tomb and the plain file stay");
  withDirectoryLockSync(lock, () => {}, { budgetMs: 1000, unavailable });
  for (const name of kept) assert.equal(existsSync(join(dir, name)), true, `${name} survives the synchronous form too`);
}));

test("the refusal names a non-lock obstruction at the lock path and leaves it there (#514)", () => withScratch(async (dir) => {
  const passThrough = (error) => error;
  const refusal = async (lock) => {
    let clock = 0;
    const options = { budgetMs: 5000, unavailable: passThrough, now: () => clock, sleep: async () => { clock += 500; } };
    const error = await withDirectoryLock(lock, () => assert.fail("entered"), options).then(() => null, (caught) => caught);
    clock = 0;
    const syncError = (() => {
      try { withDirectoryLockSync(lock, () => assert.fail("entered"), { ...options, sleep: () => { clock += 500; } }); } catch (caught) { return caught; }
      return null;
    })();
    assert.equal(syncError?.message, error?.message, "both forms refuse alike");
    return error;
  };

  const file = join(dir, "file-lock");
  writeFileSync(file, "notes");
  const fileError = await refusal(file);
  assert.equal(fileError.code, "ENOTLOCK");
  assert.equal(fileError.message, `Lock path is occupied by a regular file, not a lock: ${file}`);
  assert.equal(readFileSync(file, "utf8"), "notes", "the file is left in place");

  const foreign = join(dir, "dir-lock");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "draft.html"), "<p>work</p>");
  const foreignError = await refusal(foreign);
  assert.equal(foreignError.code, "ENOTLOCK");
  assert.equal(foreignError.message, `Lock path is occupied by a directory that is not a lock (no owner.json; it holds draft.html): ${foreign}`);
  assert.deepEqual(readdirSync(foreign), ["draft.html"], "the directory is left in place");

  // An empty directory is what an older writer leaves before its owner
  // record: an ownerless lock, not an obstruction.
  const ownerless = join(dir, "ownerless-lock");
  mkdirSync(ownerless);
  const ownerlessError = await refusal(ownerless);
  assert.equal(ownerlessError.code, "EEXIST");
  assert.match(ownerlessError.message, /no owner record/);

  const held = join(dir, "held-lock");
  mkdirSync(held);
  writeFileSync(join(held, "owner.json"), `${JSON.stringify({ pid: process.ppid, token: "foreign" })}\n`);
  const heldError = await refusal(held);
  assert.equal(heldError.code, "EEXIST");
  assert.match(heldError.message, /Lock is held/);
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
