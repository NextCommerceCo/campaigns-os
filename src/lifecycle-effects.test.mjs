// Effect tests for the lifecycle journal: what a command is allowed to WRITE,
// observed from outside the process. Each case snapshots the whole target tree
// (relative path + sha256) before and after one CLI invocation and asserts the
// tree is byte-identical where nothing may be written.
//
// The properties under test (issue #459 and the refused-command case):
//   - `--no-write` suppresses the lifecycle append for every command, whichever
//     way the journal was selected (--lifecycle-journal, the env variable, or
//     an ambient run session);
//   - a refused invocation — an unknown top-level command, an unknown
//     subcommand refused before its handler runs, or a flag the command
//     refuses up front — writes nothing OF ITS OWN, with or without
//     `--no-write`; the one effect that precedes refusal is the invoked
//     command's own stale-session closeout, which (l) and (m) pin;
//   - `run status` is read-only.
// Case (f) is the positive control: the same harness DOES observe the append a
// journal-selecting command makes without `--no-write`, so a green run of the
// other cases means "nothing was written", not "the harness sees nothing".
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { main } from "./cli.mjs";
import { refusalSeen, refused, runWithRefusalScope } from "./lifecycle.mjs";
import { RUN_SESSION_TTL_MS } from "./run-session.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

// Telemetry never leaves the machine from a test: remit off in the child env,
// and every run-session command also carries --no-remit.
function childEnv(extra = {}) {
  const env = { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off" };
  delete env.CAMPAIGNS_OS_LIFECYCLE_LOG;
  return { ...env, ...extra };
}

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv(env),
  });
}

// Relative path + content hash for every file under `dir`, sorted. Content, not
// mtime: a rewrite with identical bytes is not an effect worth failing on, and
// an append always changes the hash.
function snapshotTree(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(`${relative(dir, full)} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk(dir);
  return files.sort();
}

function withTempTarget(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-effects-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Open an ambient run session in `dir` and return it, with the tree snapshot
// taken AFTER the session exists (the session file itself is a legitimate write).
function startSession(dir) {
  const started = runCli(["run", "start", "--no-remit", "--json"], { cwd: dir });
  assert.equal(started.status, 0, started.stderr);
  const session = JSON.parse(started.stdout).session;
  assert.ok(session.lifecycle_journal, "run start should name a lifecycle journal");
  return session;
}

function readJournalEntries(path) {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("(a) #459: `run status --no-write` under an ambient session appends nothing", () => {
  withTempTarget((dir) => {
    const session = startSession(dir);
    const before = snapshotTree(dir);

    const status = runCli(["run", "status", "--no-write", "--no-remit", "--json"], { cwd: dir });
    assert.equal(status.status, 0, status.stderr);

    assert.deepEqual(snapshotTree(dir), before, "--no-write must leave the target tree untouched");
    assert.equal(existsSync(session.lifecycle_journal), false, "the session journal must not be created");
  });
});

test("(b) `run status` is read-only: no lifecycle entry even without --no-write", () => {
  withTempTarget((dir) => {
    const session = startSession(dir);
    const before = snapshotTree(dir);

    const status = runCli(["run", "status", "--no-remit", "--json"], { cwd: dir });
    assert.equal(status.status, 0, status.stderr);

    assert.deepEqual(snapshotTree(dir), before, "run status must leave the target tree untouched");
    assert.equal(existsSync(session.lifecycle_journal), false, "run status must not create the session journal");
  });
});

test("(c) a refused command with CAMPAIGNS_OS_LIFECYCLE_LOG set and no session writes nothing", () => {
  withTempTarget((dir) => {
    const journal = join(dir, "x.jsonl");
    const before = snapshotTree(dir);

    const refused = runCli(["frobnicate", "--no-write", "--no-remit", "--json"], {
      cwd: dir,
      env: { CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
    });
    assert.notEqual(refused.status, 0, "an unknown command must exit non-zero");
    assert.match(refused.stderr, /Unknown command: frobnicate/);

    assert.deepEqual(snapshotTree(dir), before, "a refused command must leave the target tree untouched");
    assert.equal(existsSync(journal), false, "a refused command must not create the env-selected journal");
  });
});

test("(d) a refused command under an ambient session writes nothing", () => {
  withTempTarget((dir) => {
    const session = startSession(dir);
    const before = snapshotTree(dir);

    const refused = runCli(["frobnicate", "--no-write", "--no-remit", "--json"], { cwd: dir });
    assert.notEqual(refused.status, 0, "an unknown command must exit non-zero");
    assert.match(refused.stderr, /Unknown command: frobnicate/);

    assert.deepEqual(snapshotTree(dir), before, "a refused command must leave the target tree untouched");
    assert.equal(existsSync(session.lifecycle_journal), false, "a refused command must not create the session journal");
  });
});

// (c) and (d) both pass --no-write, which would suppress the append on its own:
// they cannot tell the refusal guard apart from rule 1. (c') and (d') drop
// --no-write so only the refusal can be doing the work — removing the guard
// fails here and nowhere else.
test("(c') a refused command WITHOUT --no-write, env journal, no session writes nothing", () => {
  withTempTarget((dir) => {
    const journal = join(dir, "x.jsonl");
    const before = snapshotTree(dir);

    const refused = runCli(["frobnicate", "--json"], {
      cwd: dir,
      env: { CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
    });
    assert.notEqual(refused.status, 0, "an unknown command must exit non-zero");
    assert.match(refused.stderr, /Unknown command: frobnicate/);

    assert.deepEqual(snapshotTree(dir), before, "a refused command must leave the target tree untouched");
    assert.equal(existsSync(journal), false, "a refused command must not create the env-selected journal");
  });
});

test("(d') a refused command WITHOUT --no-write under an ambient session writes nothing", () => {
  withTempTarget((dir) => {
    const session = startSession(dir);
    const before = snapshotTree(dir);

    const refused = runCli(["frobnicate", "--no-remit", "--json"], { cwd: dir });
    assert.notEqual(refused.status, 0, "an unknown command must exit non-zero");
    assert.match(refused.stderr, /Unknown command: frobnicate/);

    assert.deepEqual(snapshotTree(dir), before, "a refused command must leave the target tree untouched");
    assert.equal(existsSync(session.lifecycle_journal), false, "a refused command must not create the session journal");
  });
});

test("(e) --no-write suppresses the env-selected journal for a generic command", () => {
  withTempTarget((dir) => {
    const journal = join(dir, "x.jsonl");
    const before = snapshotTree(dir);

    const status = runCli(["tooling", "status", "--no-write", "--json"], {
      cwd: dir,
      env: { CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
    });
    // A bare temp dir has no skills installed, so the report is
    // attention_required (exit 2); the command ran either way, which is what
    // this case is about.
    assert.ok([0, 2].includes(status.status), status.stderr);

    assert.deepEqual(snapshotTree(dir), before, "--no-write must leave the target tree untouched");
    assert.equal(existsSync(journal), false, "--no-write must not create the env-selected journal");
  });
});

test("(f) positive control: without --no-write the same command appends exactly one entry", () => {
  withTempTarget((dir) => {
    const journal = join(dir, "x.jsonl");

    const status = runCli(["tooling", "status", "--json"], {
      cwd: dir,
      env: { CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
    });
    assert.ok([0, 2].includes(status.status), status.stderr);

    assert.equal(existsSync(journal), true, "capture is opt-in but selected here, so the journal must exist");
    const entries = readJournalEntries(journal);
    assert.equal(entries.length, 1, JSON.stringify(entries));
    assert.equal(entries[0].command, "tooling");
  });
});

// The top-level command is KNOWN in (g), (h) and (i) — only the subcommand or
// the flag is refused, so nothing about the command name could suppress these.
// They are the cases the challenger found journaling an entry for an invocation
// the CLI had already refused; each one also re-asserts the refusal itself is
// unchanged. The refusal tag is what suppresses them, here and everywhere.
test("(g) a refused subcommand `tooling statuss` with the env journal writes nothing", () => {
  withTempTarget((dir) => {
    const journal = join(dir, "x.jsonl");
    const before = snapshotTree(dir);

    const refused = runCli(["tooling", "statuss", "--json"], {
      cwd: dir,
      env: { CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
    });
    assert.notEqual(refused.status, 0, "an unknown subcommand must exit non-zero");
    assert.match(refused.stderr, /Unknown tooling command: statuss/);

    assert.deepEqual(snapshotTree(dir), before, "a refused subcommand must leave the target tree untouched");
    assert.equal(existsSync(journal), false, "a refused subcommand must not create the env-selected journal");
  });
});

test("(h) a refused subcommand `run statuss` under an ambient session writes nothing", () => {
  withTempTarget((dir) => {
    const session = startSession(dir);
    const before = snapshotTree(dir);

    const refused = runCli(["run", "statuss", "--no-remit", "--json"], { cwd: dir });
    assert.notEqual(refused.status, 0, "an unknown subcommand must exit non-zero");
    assert.match(refused.stderr, /Unknown run subcommand "statuss"/);

    assert.deepEqual(snapshotTree(dir), before, "a refused subcommand must leave the target tree untouched");
    assert.equal(existsSync(session.lifecycle_journal), false, "a refused subcommand must not create the session journal");
  });
});

// (i) is the whole refusal surface, not one example of it. Every row is an
// invocation the CLI refuses on ARGUMENT SHAPE alone — an unknown top-level
// command, an unknown subcommand, or a flag the command refuses before it
// reads or writes anything — so none of them may leave a journal behind. The
// first eight rows are unknown names; the rest are the other shapes (missing
// required flag, missing flag value, disallowed flag combination, bad value
// for a flag, missing identity), which are the ones a message-matching guard
// would have missed: `telemetry off --proxy-base` is exactly the refusal that
// was found journaling after the unknown-name rows were already green.
//
// The last block is the refusals raised by a SHARED validator rather than by a
// `throw` in cli.mjs or qa-node.mjs. They journaled an entry while the tag was
// applied only to the throw sites those two files own, and they are the reason
// the position of a check — not the file it lives in — decides the verdict.
//
// `%DIR%` is the case's own temp directory. Paths that name a packet are
// deliberately absent: a refusal that resolves a path but never reads it is
// still a refusal, and a row that needed a real packet would be testing the
// handler instead.
const REFUSED_INVOCATIONS = [
  // Unknown top-level command / unknown subcommand.
  { argv: ["frobnicate"], expect: /Unknown command: frobnicate/ },
  // `readback` exists on the merged base; with no target it refuses through its own usage path.
  { argv: ["readback"], expect: /Use: campaigns-os readback/ },
  { argv: ["tooling", "statuss"], expect: /Unknown tooling command: statuss/ },
  { argv: ["run", "statuss"], expect: /Unknown run subcommand "statuss"/ },
  { argv: ["qa", "publishh"], expect: /Unknown qa command: publishh/ },
  { argv: ["qa", "policy", "sett"], expect: /Unknown qa policy command/ },
  { argv: ["checkpoint", "waiv"], expect: /Unknown checkpoint subcommand/ },
  { argv: ["theme", "inspec"], expect: /Unknown theme subcommand "inspec"/ },
  // Unknown flag.
  { argv: ["standardize", "--dryrun", "--target", "%DIR%"], expect: /Unknown flag for standardize: --dryrun/ },
  // Disallowed flag / flag combination.
  { argv: ["telemetry", "off", "--proxy-base", "https://example.test"], expect: /--proxy-base is not accepted/ },
  { argv: ["spec", "derive", "--proxy-base", "https://example.test"], expect: /--proxy-base only applies with --write-map/ },
  { argv: ["spec", "derive", "--store-token-source", "env:FOO"], expect: /--store-token-source only applies with --from-store/ },
  // Missing flag value.
  { argv: ["telemetry", "on", "--proxy-base"], expect: /--proxy-base needs a URL/ },
  { argv: ["page-kit", "parity", "--report"], expect: /Missing value for --report/ },
  { argv: ["install-skills", "--target"], expect: /Missing value for --target/ },
  // Missing required flag.
  { argv: ["doctor"], expect: /Missing required --packet/ },
  { argv: ["findings", "add"], expect: /findings add is missing required flags: --stage, --kind, --summary/ },
  { argv: ["qa", "waive"], expect: /qa waive requires --packet/ },
  { argv: ["start", "--target", "%DIR%"], expect: /Either --spec <path> or --map-id <id> is required/ },
  // Bad value for a flag.
  { argv: ["install-skills", "--platform", "bogus"], expect: /Unknown --platform bogus/ },
  { argv: ["page-kit", "sync", "--packet", "%DIR%/p.json", "--dry-run", "true"], expect: /--dry-run takes no value/ },
  { argv: ["tooling", "status", "--no-force"], expect: /--no-force is not a flag of tooling status/ },
  { argv: ["run-record", "--packet", "%DIR%/p.json", "--surfaces", "bogus"], expect: /Unknown --surfaces value\(s\): bogus/ },
  // Refused by a SHARED validator — one imported from another module and
  // called on argv before the handler reads a config, a packet or the network.
  // These are the rows the enumeration missed while it looked at `throw` sites
  // in cli.mjs and qa-node.mjs only: the refusal is raised in remit.mjs and
  // qa-browser.mjs, and reached the journal because the tag was applied where
  // the message is written rather than where the validator is called.
  //
  // `assertSecureProxyBase` (src/remit.mjs), at its three up-front call sites.
  // The same validator runs mid-remit, where a throw IS journaled; that half is
  // covered by (i') in spirit and is deliberately not listed here.
  { argv: ["telemetry", "status", "--proxy-base", "not-a-url"], expect: /--proxy-base is not a URL/ },
  { argv: ["telemetry", "on", "--proxy-base", "http://example.test"], expect: /--proxy-base must be https/ },
  { argv: ["telemetry", "list", "--proxy-base", "not-a-url"], expect: /--proxy-base is not a URL/ },
  // Refused inside the handler but ahead of the request: the destination gate
  // for the admin key, then the missing admin key itself. Neither is a handler
  // failure — nothing has been read or sent — so neither may journal.
  { argv: ["telemetry", "list", "--proxy-base", "https://example.invalid"], expect: /refusing to send the ops admin key to non-canonical/ },
  { argv: ["telemetry", "list", "--proxy-base", "https://example.invalid", "--trust-proxy-base", "--admin-key-env", "CAMPAIGNS_OS_TEST_UNSET_ADMIN_KEY"], expect: /set CAMPAIGNS_OS_TEST_UNSET_ADMIN_KEY/ },
  // `validatedOrderCreationLimit` (src/qa-browser.mjs), at both browser entries.
  { argv: ["qa", "parity", "--max-order-creations", "bogus"], expect: /--max-order-creations must be a whole number/ },
  { argv: ["qa", "run", "--max-order-creations", "0"], expect: /--max-order-creations must be at least 1/ },
  // Missing identity: no --packet, no --site/--built, no positional <map-id>,
  // so `qa run` refuses with nothing read and no spec fetched.
  { argv: ["qa", "run"], expect: /QA requires a Map ID/ },
];

for (const { argv, expect } of REFUSED_INVOCATIONS) {
  test(`(i) refused up front, nothing journaled: campaigns-os ${argv.join(" ")}`, () => {
    withTempTarget((dir) => {
      const journal = join(dir, "x.jsonl");
      const before = snapshotTree(dir);

      const refused = runCli([...argv.map((token) => token.replaceAll("%DIR%", dir)), "--json"], {
        cwd: dir,
        env: { CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
      });
      assert.notEqual(refused.status, 0, "a refused invocation must exit non-zero");
      // A refusal reaches the operator on stderr; the ones routed through
      // waiveOrRefuse also put it in the `{ ok: false, error }` body on stdout.
      assert.match(`${refused.stderr}${refused.stdout}`, expect);

      assert.deepEqual(snapshotTree(dir), before, "a refused invocation must leave the target tree untouched");
      assert.equal(existsSync(journal), false, "a refused invocation must not create the env-selected journal");
    });
  });
}

// The other half of (i): suppression must stop at the refusal boundary. A
// command whose flags are accepted and whose handler then FAILS is the most
// valuable lifecycle entry there is, so it must still be journaled. `theme
// inspect --packet <missing>` passes every argv check and throws reading the
// packet — one entry, non-zero exit.
test("(i') a handler that begins work and then fails IS still journaled", () => {
  withTempTarget((dir) => {
    const journal = join(dir, "x.jsonl");

    const failed = runCli(["theme", "inspect", "--packet", join(dir, "missing.json"), "--json"], {
      cwd: dir,
      env: { CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
    });
    assert.notEqual(failed.status, 0, "a failing handler must exit non-zero");
    assert.match(failed.stderr, /missing\.json/);

    assert.equal(existsSync(journal), true, "a failure after the handler began work must be captured");
    const entries = readJournalEntries(journal);
    assert.equal(entries.length, 1, JSON.stringify(entries));
    assert.equal(entries[0].command, "theme");
    assert.notEqual(entries[0].exit_status, 0);
  });
});

// (j) is the case the guard could not reach while `refused()` lived in
// cli.mjs: `qa` refuses its unknown subcommands from qa-node.mjs, which cli.mjs
// imports. The factory moved to lifecycle.mjs so that throw site can be tagged
// like the rest, rather than being recognized by its message.
test("(j) a refused subcommand `qa publishh` with the env journal writes nothing", () => {
  withTempTarget((dir) => {
    const journal = join(dir, "x.jsonl");
    const before = snapshotTree(dir);

    const refused = runCli(["qa", "publishh", "--json"], {
      cwd: dir,
      env: { CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
    });
    assert.notEqual(refused.status, 0, "an unknown qa subcommand must exit non-zero");
    assert.match(refused.stderr, /Unknown qa command: publishh/);

    assert.deepEqual(snapshotTree(dir), before, "a refused subcommand must leave the target tree untouched");
    assert.equal(existsSync(journal), false, "a refused subcommand must not create the env-selected journal");
  });
});

// (k) runs IN-PROCESS, unlike every case above, because that is the only way to
// interleave two invocations: one process is one CLI run, so a module-global
// refusal flag looks per-invocation from outside. `checkpoint unknown --json`
// is refused through waiveOrRefuse — it prints the envelope and RETURNS rather
// than throwing, so only refusalSeen() can suppress its journal append. With
// the verdict in a module global, the `tooling status` call starting a
// microtask later reset it before the checkpoint invocation's onFinish ran and
// the refused invocation journaled an entry. The verdict is now scoped per
// invocation (runWithRefusalScope), so each journal reflects only its own
// command.
//
// Both invocations set process.exitCode (1 for the refusal, 2 for `tooling
// status` in a bare directory) and write to the console; the test restores
// process.exitCode so the test runner's own exit code is unaffected, and
// silences the console so the two JSON bodies stay out of the TAP stream.
test("(k) two interleaved in-process invocations keep their refusal verdicts separate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-effects-"));
  const refusedJournal = join(dir, "refused.jsonl");
  const normalJournal = join(dir, "normal.jsonl");
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  const { log, error } = console;
  // A bare temp dir as cwd: no run session to sweep, nothing of the repo to touch.
  process.chdir(dir);
  console.log = () => {};
  console.error = () => {};
  try {
    const refusedRun = main(["checkpoint", "unknown", "--json", "--lifecycle-journal", refusedJournal])
      .catch(() => {});
    const normalRun = new Promise((settle, fail) => {
      queueMicrotask(() => {
        main(["tooling", "status", "--json", "--lifecycle-journal", normalJournal]).then(settle, fail);
      });
    });
    await Promise.all([refusedRun, normalRun]);
  } finally {
    console.log = log;
    console.error = error;
    process.chdir(cwd);
    process.exitCode = exitCode;
  }

  assert.equal(existsSync(refusedJournal), false, "the refused invocation must not create its journal");
  assert.equal(existsSync(normalJournal), true, "the concurrent normal invocation must still be captured");
  const entries = readJournalEntries(normalJournal);
  assert.equal(entries.length, 1, JSON.stringify(entries));
  assert.equal(entries[0].command, "tooling");
  rmSync(dir, { recursive: true, force: true });
});

// (l) and (m) are the sweep: the ONE effect that precedes argument refusal.
// `start`, `prepare-build`, `build`, `run start` and `run end` close out a
// stale run session at the root they are about to act on BEFORE dispatch, so a
// refused `start` still performs it — that closeout is an effect of the
// command, not of the refusal. What it may not do is happen under `--no-write`,
// which is the bug (l) pins: the flag was inherited by the closeout, so no Run
// Record was written, but the session file was deleted anyway and the tree
// moved. Every other refusal case above runs in a fresh directory with no
// session, which is why none of them could see this.
//
// The fixture is the real examples/ tree, copied: the sweep only assembles a
// record when the session names a packet that exists, and the packet's
// assembly.target_repo is what roots the session.
const EXAMPLES = resolve(ROOT, "examples");
const REFUSED_START = /Either --spec <path> or --map-id <id> is required/;

// A copy of examples/ with an ambient session opened at the packet's target
// repo and backdated past RUN_SESSION_TTL_MS, so the next command sweeps it.
function withStaleSessionTarget(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-stale-"));
  try {
    cpSync(EXAMPLES, dir, { recursive: true });
    const packet = join(dir, "build-packet.basic.json");
    const started = runCli(["run", "start", "--packet", packet, "--no-remit", "--json"], { cwd: dir });
    assert.equal(started.status, 0, started.stderr);
    const { session, session_path: sessionPath } = JSON.parse(started.stdout);
    const target = resolve(sessionPath, "..", "..");

    const idle = new Date(Date.now() - RUN_SESSION_TTL_MS - 60 * 60 * 1000).toISOString();
    writeFileSync(sessionPath, `${JSON.stringify({ ...session, started_at: idle, updated_at: idle }, null, 2)}\n`);

    run({ dir, target, sessionPath, session });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("(l) a refused `start --no-write` over a stale session leaves the tree byte-identical", () => {
  withStaleSessionTarget(({ dir, target, sessionPath }) => {
    const before = snapshotTree(dir);

    const refusedStart = runCli(["start", "--target", target, "--no-write", "--no-remit", "--json"], { cwd: dir });
    assert.notEqual(refusedStart.status, 0, "start without --spec/--map-id must exit non-zero");
    assert.match(`${refusedStart.stderr}${refusedStart.stdout}`, REFUSED_START);

    assert.deepEqual(snapshotTree(dir), before, "--no-write must not sweep: no Run Record, no session-file deletion");
    assert.equal(existsSync(sessionPath), true, "--no-write must leave the stale session for a run that writes");
  });
});

test("(m) the same refused `start` WITHOUT --no-write performs the closeout and still journals nothing", () => {
  withStaleSessionTarget(({ dir, target, sessionPath, session }) => {
    const recordsDir = join(dir, ".campaign-runtime", "run-records");
    assert.equal(existsSync(recordsDir), false, "the fixture starts with no Run Records");

    const refusedStart = runCli(["start", "--target", target, "--no-remit", "--json"], { cwd: dir });
    assert.notEqual(refusedStart.status, 0, "start without --spec/--map-id must exit non-zero");
    assert.match(`${refusedStart.stderr}${refusedStart.stdout}`, REFUSED_START);

    // The declared effect of `start`: the stale session is closed out into its
    // Run Record and cleared, and the operator is told on stderr.
    assert.deepEqual(readdirSync(recordsDir), [`${session.run_id}.json`]);
    assert.match(refusedStart.stderr, new RegExp(`Stale run session ${session.run_id} .* closed out`));
    assert.equal(existsSync(sessionPath), false, "the stale session file must be cleared by the closeout");

    // The refusal itself remains silent: no lifecycle entry for an invocation
    // that never reached a handler, even though the sweep ran.
    assert.equal(existsSync(session.lifecycle_journal), false, "a refused invocation must journal nothing");
  });
});

// (n) is the invariant documented at `refused()`: the scope is marked at
// CONSTRUCTION, so a refusal must be thrown or rendered and never swallowed.
// Unit-level on purpose — it states the contract the CLI cases above rely on,
// and it is the test a future `refused()` inside a discarding `try` would have
// to argue with.
test("(n) refusalSeen() is per-scope: false in a fresh scope, true once refused() is called in it", () => {
  const seen = runWithRefusalScope(() => {
    const before = refusalSeen();
    const error = refused("nope");
    return { before, after: refusalSeen(), message: error.message };
  });
  assert.equal(seen.before, false, "a fresh refusal scope starts clean");
  assert.equal(seen.after, true, "constructing a refusal marks the scope it was built in");
  assert.equal(seen.message, "nope", "the message is passed through untouched");
  // The verdict does not leak out of the scope it was recorded in.
  assert.equal(refusalSeen(), false, "outside any scope there is no verdict");
  assert.equal(runWithRefusalScope(() => refusalSeen()), false, "the next scope starts clean again");
});

// (o) pins the unknown-command case to the TAG and nothing else. (c) and (d)
// cover the same typo but pass `--no-write`, which suppresses the append one
// rule earlier — so on their own they cannot tell the refusal rule from the
// --no-write rule. Here the journal is live and the only reason nothing is
// appended is that the refusal carried its tag. This is the case a re-added
// command-list backstop would make redundant, and the case its removal has to
// keep green.
test("(o) an unknown top-level command WITHOUT --no-write journals nothing: the tag is the only suppressor", () => {
  withTempTarget((dir) => {
    const journal = join(dir, "x.jsonl");
    const before = snapshotTree(dir);

    const refusedRun = runCli(["frobnicate", "--no-remit", "--json"], {
      cwd: dir,
      env: { CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
    });
    assert.notEqual(refusedRun.status, 0, "an unknown command must exit non-zero");
    assert.match(refusedRun.stderr, /Unknown command: frobnicate/);

    assert.deepEqual(snapshotTree(dir), before, "a refused command must leave the target tree untouched");
    assert.equal(existsSync(journal), false, "a refused command must not create the env-selected journal");
  });
});
