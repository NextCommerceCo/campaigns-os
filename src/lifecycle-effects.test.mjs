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
import { execFile, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { main, RUN_RECORD_INHERITABLE_FLAGS, runSessionEndArgs } from "./cli.mjs";
import { resolveBuiltSiteScope } from "./built-site-scope.mjs";
import { refusalSeen, refused, runWithRefusalScope } from "./lifecycle.mjs";
import { RUN_SESSION_TTL_MS } from "./run-session.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const execFileAsync = promisify(execFile);

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

// Write `files` (relative path -> content) under `dir`. Used by the rows below
// that must get past a packet read to reach their refusal or failure; it runs
// before the "before" snapshot, so the seeded files are state, not effects.
function seedFiles(dir, files = {}) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
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
// `%DIR%` is the case's own temp directory. Most rows name no real file: a
// refusal that resolves a path but never reads it is still a refusal. The rows
// that DO carry `files` are refused after the handler has read its packet and
// nothing else. Reading its own packet is pre-work the rule allows (docs/
// effects.md, the `*refused*` row), so those rows seed the smallest packet that
// reaches the check — `{}` — and still test the refusal, not the handler. What
// the handler reads after the packet (the Assembly Report, the target) is
// where its work begins; (i'') pins that side of the line for each of them.
const EMPTY_PACKET = Object.freeze({ "p.json": "{}" });

function seedRefusalFixture(dir, fixture) {
  if (fixture === "intake" || fixture === "cached-intake") {
    cpSync(join(ROOT, "examples/campaignspec.v42.basic.json"), join(dir, "spec.json"));
    mkdirSync(join(dir, "source"));
    mkdirSync(join(dir, "target"));
    if (fixture === "cached-intake") {
      const cache = join(dir, "target/.campaign-runtime/fetched-specs/demo.json");
      mkdirSync(dirname(cache), { recursive: true });
      cpSync(join(dir, "spec.json"), cache);
    }
  }
  if (fixture === "site") {
    const page = join(dir, "site/_site/demo/index.html");
    mkdirSync(dirname(page), { recursive: true });
    writeFileSync(page, "<!doctype html><title>Demo</title>");
    assert.equal(resolveBuiltSiteScope(join(dir, "site")).ok, true, "the old check position must be reachable after the site scan");
  }
  if (fixture === "packet") {
    cpSync(join(ROOT, "examples/build-packet.basic.json"), join(dir, "p.json"));
    cpSync(join(ROOT, "examples/campaignspec.v42.basic.json"), join(dir, "campaignspec.v42.basic.json"));
    cpSync(join(ROOT, "examples/target-page-kit"), join(dir, "target-page-kit"), { recursive: true });
  }
}

const INTAKE_ARGV = ["--spec", "%DIR%/spec.json", "--source", "%DIR%/source", "--target", "%DIR%/target"];
const CACHED_INTAKE_ARGV = ["--map-id", "demo", "--cached-spec", "--source", "%DIR%/source", "--target", "%DIR%/target"];

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
  // or --map-id, so both resolveQaInputs callers refuse before any read.
  { argv: ["qa", "run"], expect: /QA requires a Map ID/ },
  { argv: ["qa", "resolve"], expect: /QA requires a Map ID/ },
  ...["run", "resolve"].flatMap((subcommand) => [
    ...["", "   "].map((value) => ({ argv: ["qa", subcommand, value], expect: /QA requires a Map ID/ })),
    ...["packet", "site", "built", "map-id"].flatMap((flag) => [
      { argv: ["qa", subcommand, `--${flag}`], expect: new RegExp(`Missing value for --${flag}`) },
      ...["", "   "].map((value) => ({ argv: ["qa", subcommand, `--${flag}`, value], expect: new RegExp(`Missing value for --${flag}`) })),
    ]),
  ]),
  // #465: flag checks raised after reading nothing but argv and the packet,
  // ahead of any report read and any write. One row per tagged site.
  { argv: ["theme", "waive", "--packet", "%DIR%/p.json"], files: EMPTY_PACKET, expect: /theme waive requires --reason/ },
  { argv: ["qa", "waive", "--packet", "%DIR%/p.json"], files: EMPTY_PACKET, expect: /qa waive requires --assertion <id>/ },
  { argv: ["qa", "waive", "--packet", "%DIR%/p.json", "--assertion", "bogus"], files: EMPTY_PACKET, expect: /qa waive does not accept --assertion "bogus"/ },
  { argv: ["qa", "waive", "--packet", "%DIR%/p.json", "--assertion", "analytics-correctness:purchase-fires"], files: EMPTY_PACKET, expect: /qa waive requires --reason/ },
  { argv: ["qa", "policy", "set", "--packet", "%DIR%/p.json", "--test-orders-allowed"], files: EMPTY_PACKET, expect: /--test-orders-allowed was removed in supported surface 1\.28\.0/ },
  { argv: ["qa", "policy", "set", "--packet", "%DIR%/p.json", "--preview-url"], files: EMPTY_PACKET, expect: /--preview-url requires a value/ },
  // `booleanArg` is shared with `qa run`'s analytics leg (mid-run, a failure);
  // this is its up-front call site, tagged there with `refusing()`.
  { argv: ["qa", "policy", "set", "--packet", "%DIR%/p.json", "--allowed-domains-confirmed", "maybe"], files: EMPTY_PACKET, expect: /--allowed-domains-confirmed must be true or false/ },
  // Shared validators called at the same position, tagged at their call sites.
  { argv: ["theme", "waive", "--packet", "%DIR%/p.json", "--reason", "an effect-test waiver"], files: EMPTY_PACKET, expect: /theme waive requires --waived-by/ },
  { argv: ["qa", "policy", "set", "--packet", "%DIR%/p.json", "--order-path-depth", "bogus"], files: EMPTY_PACKET, expect: /qa policy set: unsupported --order-path-depth "bogus"/ },
  // Each row reached a target read at its old check position. The unchanged
  // tree and absent journal, rather than the message alone, prove the move.
  { argv: ["start", "--spec", "%DIR%/spec.json", "--target", "%DIR%/target"], fixture: "intake", expect: /Missing required --source/ },
  { argv: ["build", "--spec", "%DIR%/spec.json", "--source", "%DIR%/source"], fixture: "intake", expect: /Missing required --target/ },
  { argv: ["prepare-build", ...INTAKE_ARGV, "--source-kind", "bogus"], fixture: "intake", expect: /Unsupported source adapter "bogus"/ },
  { argv: ["start", ...INTAKE_ARGV, "--wrapper-policy"], fixture: "intake", expect: /--wrapper-policy needs a value/ },
  { argv: ["build", ...CACHED_INTAKE_ARGV, "--wrapper-policy", "bogus"], fixture: "cached-intake", expect: /Unsupported --wrapper-policy/ },
  { argv: ["prepare-build", ...CACHED_INTAKE_ARGV, "--design-manifest"], fixture: "cached-intake", expect: /--design-manifest needs a value/ },
  { argv: ["prepare-build", ...INTAKE_ARGV, "--order-path-depth", "bogus"], fixture: "intake", expect: /unsupported --order-path-depth/ },
  { argv: ["run-record", "--packet", "%DIR%/p.json", "--new-run", "--run-id", "one"], fixture: "packet", expect: /--new-run and --run-id are exclusive/ },
  { argv: ["run-record", "--packet", "%DIR%/p.json", "--agent-input-tokens"], fixture: "packet", expect: /--agent-input-tokens requires a non-negative integer/ },
  { argv: ["run-record", "--packet", "%DIR%/p.json", "--agent-output-tokens", "bogus"], fixture: "packet", expect: /--agent-output-tokens must be a non-negative integer/ },
  ...["run", "resolve"].flatMap((subcommand) => ["site", "built"].flatMap((selector) => [
    { argv: ["qa", subcommand, `--${selector}`, "%DIR%/site"], fixture: "site", expect: /requires --base-url/ },
    { argv: ["qa", subcommand, `--${selector}`, "%DIR%/site", "--base-url", "http://127.0.0.1:1/"], fixture: "site", expect: /requires --family/ },
  ])),
  { argv: ["next", "bogus-stage", "--packet", "%DIR%/p.json"], fixture: "packet", expect: /Unknown next stage: bogus-stage\. Accepted stages: setup, build, polish, deploy, qa/ },
];

for (const { argv, expect, files, fixture } of REFUSED_INVOCATIONS) {
  test(`(i) refused up front, nothing journaled: campaigns-os ${argv.join(" ")}`, () => {
    withTempTarget((dir) => {
      seedRefusalFixture(dir, fixture);
      seedFiles(dir, files);
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

test("(i) intake value forms refuse on local, fetched, and cached spec paths before effects", async (t) => {
  let fetches = 0;
  const server = createServer((_request, response) => {
    fetches += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(readFileSync(join(ROOT, "examples/campaignspec.v42.basic.json")));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const proxyBase = `http://127.0.0.1:${server.address().port}`;
  const flags = ["spec", "source", "target", "map-id", "source-kind", "wrapper-policy", "design-manifest", "order-path-depth", "proxy-base"];
  const commands = ["start", "prepare-build", "build"];
  for (const path of ["local", "fetched", "cached"]) {
    for (const flag of flags) {
      for (const value of [null, "", "   "]) {
        await t.test(`${path}: --${flag} ${JSON.stringify(value)} refuses before read/fetch/write in all intake modes`, async () => {
          for (const command of commands) {
            const dir = mkdtempSync(join(tmpdir(), "campaigns-os-intake-argv-"));
            try {
              seedRefusalFixture(dir, path === "cached" ? "cached-intake" : "intake");
              const baseline = path === "local" ? ["--spec", join(dir, "spec.json")] : ["--map-id", "demo"];
              const argv = [command, ...baseline, "--source", join(dir, "source"), "--target", join(dir, "target"), "--proxy-base", proxyBase];
              if (path === "cached") argv.push("--cached-spec");
              const old = argv.indexOf(`--${flag}`);
              if (old >= 0) argv.splice(old, 2);
              argv.push(`--${flag}`);
              if (value !== null) argv.push(value);
              argv.push("--no-run-session", "--no-remit", "--json");
              const journal = join(dir, "x.jsonl");
              const cache = join(dir, "target/.campaign-runtime/fetched-specs/demo.json");
              const before = snapshotTree(dir);
              const fetchesBefore = fetches;
              const result = await execFileAsync(process.execPath, [CLI, ...argv], {
                cwd: dir,
                env: childEnv({ CAMPAIGNS_OS_LIFECYCLE_LOG: journal }),
              }).then(() => null, (error) => error);
              assert.ok(result, `${command} should refuse`);
              const diagnostic = `${result.stderr}${result.stdout}`;
              const expected = flag === "wrapper-policy" ? /--wrapper-policy needs a value/
                : flag === "design-manifest" ? /--design-manifest needs a value/
                  : flag === "order-path-depth" ? /--order-path-depth needs a value/
                    : new RegExp(`Missing required --${flag}`);
              assert.match(diagnostic, expected, `${command} ${path}`);
              assert.deepEqual(snapshotTree(dir), before, `${command} must not change target files`);
              assert.equal(existsSync(journal), false, `${command} must not journal`);
              assert.equal(fetches, fetchesBefore, `${command} must not fetch`);
              if (path === "fetched") assert.equal(existsSync(cache), false, `${command} must not create the spec cache`);
            } finally {
              rmSync(dir, { recursive: true, force: true });
            }
          }
        });
      }
    }
  }
  await t.test("map-id without --target retains its diagnostic and fetches nothing", async () => {
    for (const command of commands) {
      const dir = mkdtempSync(join(tmpdir(), "campaigns-os-intake-argv-"));
      try {
        const journal = join(dir, "x.jsonl");
        const before = snapshotTree(dir);
        const fetchesBefore = fetches;
        const result = await execFileAsync(process.execPath, [CLI, command, "--map-id", "demo", "--source", join(dir, "source"), "--proxy-base", proxyBase, "--no-run-session", "--no-remit", "--json"], {
          cwd: dir,
          env: childEnv({ CAMPAIGNS_OS_LIFECYCLE_LOG: journal }),
        }).then(() => null, (error) => error);
        assert.ok(result);
        assert.match(`${result.stderr}${result.stdout}`, /--map-id requires --target/);
        assert.deepEqual(snapshotTree(dir), before);
        assert.equal(existsSync(journal), false);
        assert.equal(fetches, fetchesBefore);
        assert.equal(existsSync(join(dir, ".campaign-runtime/fetched-specs/demo.json")), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

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

const RUN_END_ARGV_REFUSALS = [
  ...["bogus", "", "   "].map((value) => ({ flag: "surfaces", value, expect: /Unknown --surfaces|Missing required --surfaces/ })),
  { flag: "surfaces", value: null, expect: /Missing required --surfaces/ },
  ...["yes", "   "].map((value) => ({ flag: "dry-run", value, expect: /--dry-run takes no value/ })),
  ...["agent-input-tokens", "agent-output-tokens", "agent-tool-output-tokens", "agent-total-tokens", "agent-elapsed-ms"].flatMap((flag) => [
    { flag, value: null, expect: /requires a non-negative integer/ },
    { flag, value: "", expect: /requires a non-negative integer/ },
    { flag, value: "   ", expect: /requires a non-negative integer/ },
    { flag, value: "bogus", expect: /must be a non-negative integer/ },
    { flag, value: "-1", expect: /must be a non-negative integer/ },
  ]),
  ...["agent-model", "agent-usage-source"].flatMap((flag) => [null, "", "   "].map((value) => ({ flag, value, expect: new RegExp(`Missing required --${flag}`) }))),
];

// Keep this expectation independent of the implementation's flag classes.
// runSessionEndArgs forwards the production list; the first assertion catches
// a new inherited flag that has not been classified here.
const RUN_RECORD_VALUE_FLAGS = [
  "context", "report", "qa-verdict", "journal", "surfaces", "primary-surface", "surface-confidence",
  "agent-input-tokens", "agent-output-tokens", "agent-tool-output-tokens", "agent-total-tokens", "agent-elapsed-ms", "agent-model", "agent-usage-source", "proxy-base",
];
const RUN_RECORD_BOOLEAN_FLAGS = ["no-remit", "no-write", "dry-run", "json"];
test("(i') inherited run-record flag classes cover every forwarded flag", () => {
  const flags = [...RUN_RECORD_VALUE_FLAGS, ...RUN_RECORD_BOOLEAN_FLAGS];
  assert.deepEqual([...RUN_RECORD_INHERITABLE_FLAGS].sort(), [...flags].sort());
  const forwarded = runSessionEndArgs(
    { run_id: "test-run", lifecycle_journal: "test-journal" },
    "test-packet",
    Object.fromEntries(flags.map((flag) => [flag, "sentinel"])),
  );
  assert.deepEqual(
    Object.keys(forwarded).filter((flag) => !["_", "packet", "run-id", "lifecycle-journal"].includes(flag)).sort(),
    flags.sort(),
  );
});

for (const flag of RUN_RECORD_VALUE_FLAGS) {
  for (const value of [null, "", "   "]) {
    for (const command of ["run-record", "run end"]) {
      test(`(i') ${command} --${flag} ${JSON.stringify(value)} refuses before packet work`, () => {
        withTempTarget((dir) => {
          seedFiles(dir, EMPTY_PACKET);
          const session = command === "run end" ? startSession(dir) : null;
          const before = snapshotTree(dir);
          const journal = join(dir, "outer.jsonl");
          const argv = command === "run end" ? ["run", "end"] : ["run-record"];
          argv.push("--packet", join(dir, "p.json"), `--${flag}`);
          if (value !== null) argv.push(value);
          argv.push("--no-remit", "--json");
          const result = runCli(argv, { cwd: dir, env: { CAMPAIGNS_OS_LIFECYCLE_LOG: journal } });
          assert.notEqual(result.status, 0);
          assert.match(`${result.stderr}${result.stdout}`, new RegExp(`--${flag}.*(?:Missing required|requires a non-negative integer)|Missing required --${flag}|--${flag} requires a non-negative integer`));
          assert.deepEqual(snapshotTree(dir), before);
          assert.equal(existsSync(journal), false);
          if (session) assert.equal(existsSync(session.lifecycle_journal), false);
        });
      });
    }
  }
}

for (const flag of RUN_RECORD_BOOLEAN_FLAGS) {
  for (const value of [null, "", "   "]) {
    test(`(i') run-record --${flag} ${JSON.stringify(value)} retains boolean behavior`, () => {
      withTempTarget((dir) => {
        const argv = ["run-record", "--packet", join(dir, "missing.json"), `--${flag}`];
        if (value !== null) argv.push(value);
        const result = runCli(argv, { cwd: dir });
        assert.notEqual(result.status, 0);
        if (flag === "dry-run" && value === "   ") {
          assert.match(result.stderr, /--dry-run takes no value/);
        } else {
          assert.match(result.stderr, /missing\.json/);
          assert.doesNotMatch(result.stderr, /Missing required --|takes no value/);
        }
      });
    });
  }
}

for (const { flag, value, expect } of RUN_END_ARGV_REFUSALS) {
  test(`(i') run end --${flag} ${JSON.stringify(value)} refuses without a journal entry`, () => {
    withTempTarget((dir) => {
      seedFiles(dir, EMPTY_PACKET);
      const session = startSession(dir);
      const journal = join(dir, "outer.jsonl");
      const before = snapshotTree(dir);
      const argv = ["run", "end", "--packet", join(dir, "p.json"), `--${flag}`];
      if (value !== null) argv.push(value);
      const result = runCli([...argv, "--no-remit", "--json"], {
        cwd: dir,
        env: { CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}${result.stdout}`, expect);
      assert.deepEqual(snapshotTree(dir), before);
      assert.equal(existsSync(journal), false, "env-selected journal stays absent");
      assert.equal(existsSync(session.lifecycle_journal), false, "session journal stays absent");
    });
  });
}

for (const { flag, value, expect } of [
  ...[null, "", "   "].map((value) => ({ flag: "run-id", value, expect: /Missing required --run-id/ })),
  { flag: "new-run", value: "yes", expect: /--new-run takes no value/ },
]) {
  test(`(i') run-record --${flag} ${JSON.stringify(value)} refuses without a journal entry`, () => {
    withTempTarget((dir) => {
      seedFiles(dir, EMPTY_PACKET);
      const journal = join(dir, "outer.jsonl");
      const before = snapshotTree(dir);
      const argv = ["run-record", "--packet", join(dir, "p.json"), `--${flag}`];
      if (value !== null) argv.push(value);
      const result = runCli([...argv, "--no-remit", "--json"], {
        cwd: dir,
        env: { CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}${result.stdout}`, expect);
      assert.deepEqual(snapshotTree(dir), before);
      assert.equal(existsSync(journal), false);
    });
  });
}

const RUN_END_RUN_ID_FORMS = [
  { name: "bare", args: [] },
  { name: "empty", args: [""] },
  { name: "whitespace", args: ["   "] },
  { name: "valued", args: ["other"] },
];
const RUN_END_SAVED_ID_CASES = [
  ...["new-run", "run-id"].flatMap((flag) => RUN_END_RUN_ID_FORMS.map((form) => ({
    name: `${flag} ${form.name}`,
    args: [`--${flag}`, ...form.args],
  }))),
  ...RUN_END_RUN_ID_FORMS.flatMap((newRun) => RUN_END_RUN_ID_FORMS.map((runId) => ({
    name: `new-run ${newRun.name} and run-id ${runId.name}`,
    args: ["--new-run", ...newRun.args, "--run-id", ...runId.args],
  }))),
  ...["new-run", "run-id"].flatMap((flag) => RUN_END_RUN_ID_FORMS.map((form) => ({
    name: `${flag} ${form.name} with invalid surfaces`,
    args: [`--${flag}`, ...form.args, "--surfaces", "bogus"],
  }))),
  {
    name: "both flags with invalid surfaces",
    args: ["--new-run", "--run-id", "other", "--surfaces", "bogus"],
  },
];

for (const { name, args } of RUN_END_SAVED_ID_CASES) {
  test(`(i') run end ${name} reports its saved-ID rule without journaling`, () => {
    withTempTarget((dir) => {
      seedFiles(dir, EMPTY_PACKET);
      const session = startSession(dir);
      const before = snapshotTree(dir);
      const journal = join(dir, "outer.jsonl");
      const result = runCli(["run", "end", "--packet", join(dir, "p.json"), ...args, "--no-remit", "--json"], {
        cwd: dir,
        env: { CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /run end uses the saved session's run ID; --new-run and --run-id are not accepted\./);
      assert.doesNotMatch(result.stderr, /run-record:/);
      assert.deepEqual(snapshotTree(dir), before);
      assert.equal(existsSync(journal), false);
      assert.equal(existsSync(session.lifecycle_journal), false);
    });
  });
}

test("(i') run end journals a packet read failure once after argv passes", () => {
  withTempTarget((dir) => {
    seedFiles(dir, { "p.json": "{ invalid" });
    startSession(dir);
    const journal = join(dir, "outer.jsonl");
    const result = runCli(["run", "end", "--packet", join(dir, "p.json"), "--no-remit", "--json"], {
      cwd: dir,
      env: { CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
    });
    assert.notEqual(result.status, 0);
    assert.equal(readJournalEntries(journal).length, 1);
    assert.equal(readJournalEntries(journal)[0].command, "run");
  });
});

test("(i') QA auto-end preserves a prior handler failure and closes on blank inherited context", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-effects-autoend-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(ROOT, "examples/target-page-kit"), dir, { recursive: true });
  const packetPath = join(dir, "campaign-runtime.build.json");
  const packet = JSON.parse(readFileSync(join(ROOT, "examples/build-packet.basic.json"), "utf8"));
  packet.assembly.target_repo = ".";
  writeFileSync(packetPath, `${JSON.stringify(packet)}\n`);
  cpSync(join(ROOT, "examples/campaignspec.v42.basic.json"), join(dir, "campaignspec.v42.basic.json"));
  const reportPath = join(dir, ".campaign-runtime/assembly-report.json");
  mkdirSync(dirname(reportPath), { recursive: true });
  cpSync(join(ROOT, "contracts/fixtures/sidecar-bundle/production-shaped/.campaign-runtime/assembly-report.json"), reportPath);

  const server = createServer((request, response) => {
    const path = request.url;
    const meta = path.includes("/checkout/")
      ? '<meta name="next-page-type" content="checkout"><meta name="next-success-url" content="/runtime-packet-demo/upsell/">'
      : path.includes("/upsell/")
        ? '<meta name="next-page-type" content="upsell"><meta name="next-upsell-accept-url" content="/runtime-packet-demo/receipt/"><meta name="next-upsell-decline-url" content="/runtime-packet-demo/receipt/">'
        : "";
    const links = path.includes("/landing/")
      ? '<a href="/runtime-packet-demo/checkout/">Continue</a>'
      : path.includes("/checkout/")
        ? '<a href="/runtime-packet-demo/upsell/">Submit</a>'
        : path.includes("/upsell/")
          ? '<a href="/runtime-packet-demo/receipt/">Accept</a><a href="/runtime-packet-demo/receipt/">Decline</a>'
          : "";
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html><head><title>Fixture</title>${meta}</head><body><main>Fixture campaign</main>${links}</body></html>`);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));

  const started = runCli(["run", "start", "--packet", packetPath, "--no-remit", "--json"], { cwd: dir });
  assert.equal(started.status, 0, started.stderr);
  const session = JSON.parse(started.stdout).session;
  const before = existsSync(session.lifecycle_journal) ? readJournalEntries(session.lifecycle_journal).length : 0;
  const baseUrl = `http://127.0.0.1:${server.address().port}/runtime-packet-demo/`;
  const { stderr } = await execFileAsync(process.execPath, [CLI, "qa", "run", "--packet", packetPath, "--base-url", baseUrl, "--no-post-verdict", "--no-remit", "--agent-input-tokens", "bogus", "--json"], {
    cwd: dir,
    env: childEnv(),
  });
  assert.match(stderr, /run session auto-end skipped after QA: --agent-input-tokens must be a non-negative integer/);
  const entries = readJournalEntries(session.lifecycle_journal);
  assert.equal(entries.length, before + 1, "QA appends exactly one entry before its auto-end");
  assert.equal(entries.at(-1).command, "qa");
  assert.equal(existsSync(join(dir, ".campaign-runtime/run-session.json")), true, "failed auto-end keeps the session");

  // QA passes whitespace-only --context to terminal auto-end. Run Record
  // resolves the spaces as a literal path and still closes this run.
  const second = await execFileAsync(process.execPath, [CLI, "qa", "run", "--packet", packetPath, "--base-url", baseUrl, "--no-post-verdict", "--no-remit", "--context", "   ", "--json"], {
    cwd: dir,
    env: childEnv(),
  });
  assert.match(second.stderr, /Run session .* auto-ended after qa run/);
  assert.doesNotMatch(second.stderr, /auto-end skipped/);
  assert.equal(existsSync(join(dir, ".campaign-runtime/run-session.json")), false, "blank inherited context still closes the session");
  assert.equal(existsSync(join(dir, ".campaign-runtime/run-records", `${session.run_id}.json`)), true);
  assert.equal(readJournalEntries(session.lifecycle_journal).length, before + 2, "both QA invocations journal once");
});

// A valid local spec keeps packet QA past the checkpoint preflight's blocked
// spec path. The report is present too, so that preflight reads all three
// files before the missing packet Map ID reaches resolveQaInputs's final check.
const QA_PACKET_WITHOUT_MAP_ID = Object.freeze({
  "p.json": JSON.stringify({ spec: { local_path: "spec.json" }, assembly: { target_repo: "target" } }),
  "spec.json": "{}",
  "target/.campaign-runtime/assembly-report.json": "{}",
});

// (i'') is (i') for every handler #465 tagged a refusal in: the same
// invocation as its refusal rows above, completed so it passes every one of
// them, then failing on the first thing the handler reads past its packet (for
// `qa policy set`, after it has written the packet it changed). Each
// must still append exactly one entry — the tag must not have moved the
// boundary past the refusals. `theme waive` renders its failure through
// waiveOrRefuse under --json (no throw reaches the journal step), so it proves
// the caught path; the `qa` rows prove the thrown one. The `qa policy set` row
// passes the value checks of both tagged call sites before it fails.
const HANDLER_FAILURES = [
  {
    argv: ["theme", "waive", "--packet", "%DIR%/p.json", "--reason", "an effect-test waiver", "--waived-by", "Jordan Lee"],
    files: EMPTY_PACKET,
    command: "theme",
    expect: /theme waive needs an assembly report/,
  },
  {
    argv: ["qa", "waive", "--packet", "%DIR%/p.json", "--assertion", "analytics-correctness:purchase-fires", "--reason", "an effect-test waiver"],
    files: EMPTY_PACKET,
    command: "qa",
    expect: /qa waive needs an assembly report/,
  },
  {
    argv: ["qa", "policy", "set", "--packet", "%DIR%/p.json", "--allowed-domains-confirmed", "true", "--preview-url", "https://preview.example/", "--order-path-depth", "full"],
    files: { ...EMPTY_PACKET, ".campaign-runtime/assembly-report.json": "{ not json" },
    command: "qa",
    expect: /Assembly Report at .* is not valid JSON/,
  },
  ...["start", "prepare-build", "build"].map((command) => ({
    argv: [command, "--spec", "%DIR%/missing.json", "--source", "%DIR%/source", "--target", "%DIR%/target", "--no-run-session"],
    command,
    expect: /CampaignSpec does not exist/,
  })),
  { argv: ["run-record", "--packet", "%DIR%/p.json", "--new-run", "--agent-input-tokens", "1"], files: { "p.json": "{ invalid" }, command: "run-record", expect: /not valid JSON|Unexpected token|Expected property name/ },
  { argv: ["qa", "run", "--site", "%DIR%/missing-site", "--base-url", "http://127.0.0.1:1/", "--family", "demo"], command: "qa", expect: /Built campaign directory does not exist/ },
  ...["run", "resolve"].map((subcommand) => ({
    argv: ["qa", subcommand, "--packet", "%DIR%/p.json"],
    files: QA_PACKET_WITHOUT_MAP_ID,
    command: "qa",
    expect: /QA requires a Map ID or a local-spec packet\. The named Build Packet has no campaign identity/,
  })),
  ...["run", "resolve"].flatMap((subcommand) => [
    {
      argv: ["qa", subcommand, "--packet", "%DIR%/p.json"],
      files: { "p.json": JSON.stringify({ spec: { map_id: "saved-map", local_spec_id: "local-campaign" } }) },
      command: "qa",
      expect: /Local-spec packet QA cannot use a Map ID override or an ambiguous identity/,
    },
    {
      argv: ["qa", subcommand, "--packet", "%DIR%/p.json"],
      files: { ...QA_PACKET_WITHOUT_MAP_ID, "p.json": JSON.stringify({ spec: { map_id: null, local_spec_id: "local-campaign", local_path: "spec.json" }, assembly: { target_repo: "target" } }) },
      command: "qa",
      expect: /Local-spec QA requires the matching Assembly Report and current spec material hash/,
    },
    {
      argv: ["qa", subcommand, "saved-map", "--spec", "%DIR%/spec.json"],
      files: { "spec.json": JSON.stringify({ spec_identity: { local_spec_id: "local-campaign" } }) },
      command: "qa",
      expect: /Local-spec QA requires --packet/,
    },
  ]),
  { argv: ["run", "end"], fixture: "session-no-packet", command: "run", expect: /run end needs a build packet/ },
  { argv: ["next", "build", "--packet", "%DIR%/p.json"], files: { "p.json": "{ invalid" }, command: "next", expect: /not valid JSON|Unexpected token|Expected property name/ },
];

for (const { argv, files, fixture, command, expect } of HANDLER_FAILURES) {
  test(`(i'') passes every refusal, then fails, and IS journaled: campaigns-os ${argv.join(" ")}`, () => {
    withTempTarget((dir) => {
      seedFiles(dir, files);
      const session = fixture === "session-no-packet" ? startSession(dir) : null;
      const journal = session?.lifecycle_journal || join(dir, "x.jsonl");

      const failed = runCli([...argv.map((token) => token.replaceAll("%DIR%", dir)), "--json"], {
        cwd: dir,
        env: { CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
      });
      assert.notEqual(failed.status, 0, "a failing handler must exit non-zero");
      assert.match(`${failed.stderr}${failed.stdout}`, expect);

      assert.equal(existsSync(journal), true, "a failure after the handler began work must be captured");
      const entries = readJournalEntries(journal);
      assert.equal(entries.length, 1, JSON.stringify(entries));
      assert.equal(entries[0].command, command);
      assert.notEqual(entries[0].exit_status, 0);
    });
  });
}

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

test("(m') a stale sweep with blank inherited --proxy-base writes the old Run Record", () => {
  withStaleSessionTarget(({ dir, sessionPath, session }) => {
    const packet = join(dir, "build-packet.basic.json");
    const journal = join(dir, "outer.jsonl");
    const started = runCli(["run", "start", "--packet", packet, "--proxy-base", "   ", "--no-remit", "--json"], {
      cwd: dir,
      env: { CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
    });
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stderr, /Stale run session .* closed out: Run Record/);
    assert.doesNotMatch(started.stderr, /cleared without a Run Record/);
    assert.equal(existsSync(join(dir, ".campaign-runtime/run-records", `${session.run_id}.json`)), true, "the stale session's record is written");
    assert.equal(existsSync(sessionPath), true, "the invoking command opens its new session");
    const entries = readJournalEntries(journal);
    assert.equal(entries.length, 1, "the invoking run start journals exactly once");
    assert.equal(entries[0].command, "run");
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
