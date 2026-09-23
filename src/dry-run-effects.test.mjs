// The effect test behind `--dry-run`: for each mutating command that carries
// the flag, the target tree is byte-identical before and after, and a loopback
// receiver standing in for the remit/publish endpoint is never contacted.
//
// Everything runs through the real CLI, so the flag, the exit code and the
// printed envelope are the ones an operator gets. The claim is negative
// ("nothing was written, nothing was sent"), which a broken snapshot would
// satisfy vacuously — so every command also has a POSITIVE control in the same
// seeded target: the same invocation WITHOUT --dry-run, whose write the
// snapshot must see and whose POST the receiver must receive.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { commitWaiverToAssemblyReport } from "./cli.mjs";
import { createVerdict, SEVERITY, STATUS } from "./qa-verdict.mjs";
import { buildRunSession, resolveRunSessionPath, writeRunSession } from "./run-session.mjs";
import { specMaterialHash } from "./spec-identity.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const EXAMPLES = join(ROOT, "examples");
const VERDICT_RUN_ID = "MTXEUVC6732A9UV8365MBTDNAA";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The lifecycle journal as entries; an absent file is no entries. */
function readJournal(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Every file under `dir`, as path -> content digest. Deep-equal is the assertion. */
function snapshot(dir) {
  const files = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[relative(dir, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(dir);
  return files;
}

/**
 * A loopback stand-in for the remit/publish endpoint.
 *
 * `onRequest` runs while the POST is still in flight, which is how the
 * write-ordering test below observes the target's state mid-remit without a
 * file watcher.
 */
async function startReceiver({ onRequest = null } = {}) {
  const posts = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      posts.push({ method: request.method, url: request.url, payload: JSON.parse(body || "null") });
      if (onRequest) onRequest(posts[posts.length - 1]);
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { posts, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
}

/**
 * The real CLI, spawned. `nodeArgs` are node's own flags, ahead of the entry
 * point — see noFetchNodeArgs for the runtime-without-a-fetch rows.
 */
async function runCli(argv, { cwd, telemetry = "off", lifecycleLog = "", nodeArgs = [] } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [...nodeArgs, CLI, ...argv], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: telemetry, CAMPAIGNS_OS_LIFECYCLE_LOG: lifecycleLog },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

/**
 * Node's own flags for a child runtime that has no global fetch, as a preload
 * module the test writes into a temp directory of its own.
 *
 * NOT `--no-experimental-fetch`. That flag removes the global on Node 22, where
 * these tests are developed, and is a no-op on Node 24, where CI runs them:
 * fetch is stable there and the flag no longer takes it away. The rows that use
 * this compare a dry run against a REAL invocation, so a flag that silently
 * stops working does not weaken the runtime — it breaks the row, because the
 * real invocation keeps its transport and never reaches the refusal the dry run
 * is being compared against. Deleting the global in a preload module is the
 * same runtime on every version. Verified with
 * `node --import no-fetch.mjs -e 'console.log(typeof fetch)'` -> `undefined`.
 */
function noFetchNodeArgs(t) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-no-fetch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, "no-fetch.mjs");
  writeFileSync(preload, "delete globalThis.fetch;\n");
  // A file URL rather than a bare path: `--import` resolves its argument as a
  // module specifier, and the URL form is the one that cannot be mistaken for
  // a package name on any platform.
  return ["--import", pathToFileURL(preload).href];
}

/**
 * A target seeded from the shipped examples: a packet whose target repo is a
 * Page Kit checkout, its CampaignSpec, an Assembly Report, and a stored QA
 * verdict for the current spec. The SDK pin in the target lags the spec's, so
 * `page_kit.sdk_version` is a blocked-and-waivable checkpoint gate — which is
 * what `checkpoint waive` needs in order to validate anything at all.
 *
 * (`contracts/fixtures/sidecar-bundle/production-shaped/` is a complete packet
 * with sidecars, but it ships no CampaignSpec file and no blocked checkpoint
 * gate, so neither `qa publish` nor `checkpoint waive` can get past their own
 * preconditions there.)
 */
function seedTarget(t) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-dry-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of ["build-packet.basic.json", "campaignspec.v42.basic.json"]) {
    cpSync(join(EXAMPLES, file), join(dir, file));
  }
  cpSync(join(EXAMPLES, "source-html"), join(dir, "source-html"), { recursive: true });
  cpSync(join(EXAMPLES, "target-page-kit"), join(dir, "target-page-kit"), { recursive: true });
  cpSync(join(ROOT, "contracts/commerce-surface-catalog.json"), join(dir, "contracts/commerce-surface-catalog.json"));

  const packetPath = join(dir, "build-packet.basic.json");
  const packet = readJson(packetPath);
  packet.assembly.commerce_catalog.path = "contracts/commerce-surface-catalog.json";
  packet.assembly.commerce_catalog.required = false;
  writeJson(packetPath, packet);
  const targetRepo = join(dir, "target-page-kit");

  const specPath = join(dir, "campaignspec.v42.basic.json");
  const spec = readJson(specPath);
  spec.runtime = { sdk_version: "0.4.37" };
  delete spec.global_config.sdk_version;
  for (const funnel of spec.funnels || []) {
    for (const page of funnel.pages || []) delete page.sdk_hints;
  }
  writeJson(specPath, spec);

  const campaignsPath = join(targetRepo, "_data/campaigns.json");
  const campaigns = readJson(campaignsPath);
  campaigns[packet.campaign.public_route_slug].sdk_version = "0.4.36";
  writeJson(campaignsPath, campaigns);

  const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
  const report = readJson(join(EXAMPLES, "assembly-report.example.json"));
  report.identity.map_id = packet.spec.map_id;
  report.identity.public_route_slug = packet.campaign.public_route_slug;
  report.stages.deploy.status = "skipped";
  report.evidence = [];
  writeJson(reportPath, report);
  // A retained doctor sidecar, so "the dry run did not stamp it stale" is an
  // assertion about a file that exists.
  writeJson(join(targetRepo, ".campaign-runtime/doctor-output.json"), { ok: true, status: "ready" });

  // The stored verdict `qa publish` would post, judged against the spec as it
  // now stands, plus the committed projection beside the packet.
  const verdict = createVerdict({
    runId: VERDICT_RUN_ID,
    mapId: packet.spec.map_id,
    publicRouteSlug: packet.campaign.public_route_slug,
    specVersion: "4.2",
    specHash: specMaterialHash(readJson(specPath)),
    startedAt: "2026-09-20T10:00:00.000Z",
    completedAt: "2026-09-20T10:05:00.000Z",
    runtime: "campaigns-os-node-qa@test",
    baseUrl: "https://preview.example/runtime-packet-demo/",
    assertions: [{ id: "route:entry", family: "funnel-flow", page: "entry", status: STATUS.pass, severity: SEVERITY.blocker, expected: "200", actual: "200", evidence: [] }],
  });
  const verdictPath = join(dir, "qa-output", packet.spec.map_id, `${VERDICT_RUN_ID}.json`);
  writeJson(verdictPath, verdict);
  writeJson(join(dir, ".campaign-runtime/qa-verdict.json"), {
    ...verdict, entry_urls: [], page_urls: [], tested_urls: [], test_orders: [], generated_at: "2026-09-20T10:06:00.000Z",
  });

  return { dir, packetPath, targetRepo, reportPath, specPath, verdictPath, verdict };
}

/**
 * A run session at `dir` that idled past the 12 h TTL: invisible to
 * findRunSession, and the input the pre-dispatch stale sweep acts on.
 */
function seedStaleSession(dir, { packet = null, hoursAgo = 13 } = {}) {
  const started = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  const session = buildRunSession({
    runId: `run_stale_${started.getTime()}`,
    lifecycleJournal: join(dir, ".campaign-runtime/command-lifecycle.jsonl"),
    packet,
    now: started,
  });
  writeRunSession(dir, session);
  return session;
}

const WAIVE_ARGS = ["--reason", "Pin held for a compatibility window", "--waived-by", "Jordan Lee"];
// `checkpoint waive` demands a bound (an expiry or a review condition); `theme
// waive` does not. A dry run demands it too — see the assertion below.
const CHECKPOINT_WAIVE_ARGS = [...WAIVE_ARGS, "--review-condition", "Re-evaluate before launch"];

test("run-record --dry-run assembles the record, writes no file and contacts no receiver", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const before = snapshot(dir);
  // Consent ON, pointed at the receiver: the only thing standing between this
  // run and a POST is --dry-run itself.
  const dry = await runCli(
    ["run-record", "--packet", packetPath, "--proxy-base", receiver.base, "--dry-run", "--json"],
    { cwd: dir, telemetry: "on" },
  );
  assert.equal(dry.code, 0, dry.stderr);
  const summary = JSON.parse(dry.stdout);
  assert.equal(summary.dry_run, true);
  assert.equal(summary.written, false);
  assert.equal(summary.record_path, null);
  assert.equal(summary.would_write, join(dir, ".campaign-runtime/run-records", `${summary.record.run_id}.json`));
  assert.equal(summary.would_remit, `${receiver.base}/api/runs`);
  assert.ok(summary.record.artifacts.length > 0, "the record was really assembled, not stubbed");
  assert.equal(summary.remit.sent, false);
  assert.deepEqual(snapshot(dir), before, "a dry run wrote nothing under the target");
  assert.equal(receiver.posts.length, 0, "a dry run sent nothing");

  // Positive control: the same command without --dry-run writes the record and
  // reaches the receiver, so the snapshot and the receiver can both see effects.
  const real = await runCli(
    ["run-record", "--packet", packetPath, "--run-id", summary.record.run_id, "--proxy-base", receiver.base, "--json"],
    { cwd: dir, telemetry: "on" },
  );
  assert.equal(real.code, 0, real.stderr);
  const wrote = JSON.parse(real.stdout);
  assert.equal(wrote.written, true);
  assert.equal(wrote.record_path, summary.would_write, "would_write named the file the real run wrote");
  assert.notDeepEqual(snapshot(dir), before, "the real run is visible to the snapshot");
  assert.equal(receiver.posts.length, 1, "the real run is visible to the receiver");
  assert.equal(receiver.posts[0].url, "/api/runs");
  assert.equal(receiver.posts[0].payload.run_id, summary.record.run_id);
});

// The real path's write count, which --dry-run's "writes nothing" says nothing
// about. The record used to be written twice on every default run-record: once
// before the remit, with `remit_*` still placeholders, and once after it with
// the send's outcome. The end state on disk was right, but the interim file was
// a published record claiming a pending remit. One write now, after the remit.
//
// Counted without a file watcher: the receiver reads the records directory
// while the POST is in flight. A pre-remit write would be sitting there.
test("a real run-record writes its record exactly once, after the remit", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const recordsDir = join(dir, ".campaign-runtime/run-records");
  let duringRemit = null;
  const receiver = await startReceiver({
    onRequest: () => {
      duringRemit = existsSync(recordsDir) ? readdirSync(recordsDir) : [];
    },
  });
  t.after(() => receiver.close());

  const real = await runCli(
    ["run-record", "--packet", packetPath, "--proxy-base", receiver.base, "--json"],
    { cwd: dir, telemetry: "on" },
  );
  assert.equal(real.code, 0, real.stderr);
  const summary = JSON.parse(real.stdout);
  assert.equal(receiver.posts.length, 1, "one remit");
  assert.deepEqual(duringRemit, [], "and no record on disk while it was in flight: the first write is gone");

  const recordFile = `${summary.record.run_id}.json`;
  assert.deepEqual(readdirSync(recordsDir), [recordFile], "one record file, and no .tmp left behind by a second write");
  const onDisk = readJson(join(recordsDir, recordFile));
  assert.equal(onDisk.remit_state, "ok", "the one file that landed carries the post-remit fields");
  assert.equal(onDisk.remit_attempted, true);
  assert.equal(onDisk.remit_ok, true);
  assert.equal(onDisk.remit_endpoint, "/api/runs");
  assert.equal(onDisk.remit_result, "stored");
  assert.deepEqual(onDisk, summary.record, "and is exactly the record the envelope reported");
  assert.equal(summary.record_path, join(recordsDir, recordFile));
});

test("run-record --dry-run with --no-remit or --no-write still writes nothing and reports no endpoint", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const receiver = await startReceiver();
  t.after(() => receiver.close());
  const before = snapshot(dir);

  for (const extra of [["--no-remit"], ["--no-write"], ["--no-remit", "--no-write"]]) {
    const result = await runCli(
      ["run-record", "--packet", packetPath, "--proxy-base", receiver.base, "--dry-run", "--json", ...extra],
      { cwd: dir, telemetry: "on" },
    );
    assert.equal(result.code, 0, `${extra.join(" ")}: ${result.stderr}`);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.dry_run, true, extra.join(" "));
    assert.equal(summary.would_remit, null, `${extra.join(" ")} would not have remitted anyway`);
    assert.deepEqual(snapshot(dir), before, `${extra.join(" ")} wrote nothing`);
  }
  assert.equal(receiver.posts.length, 0);

  // A bare flag: `--dry-run <value>` must fail rather than quietly become a write.
  const valued = await runCli(["run-record", "--packet", packetPath, "--dry-run", "true", "--json"], { cwd: dir });
  assert.notEqual(valued.code, 0);
  assert.match(valued.stderr, /--dry-run takes no value/);
  assert.deepEqual(snapshot(dir), before);
});

test("qa publish --dry-run <value> is an up-front refusal: no post, no write, no journal entry", async (t) => {
  const { dir } = seedTarget(t);
  const receiver = await startReceiver();
  t.after(() => receiver.close());
  const before = snapshot(dir);
  const journal = join(dir, ".campaign-runtime", "command-lifecycle.jsonl");

  // The bare-flag check lives in qa-publish.mjs, not in cli.mjs's isDryRun, so
  // it must carry the same refusal tag or the journal exemption for refused
  // invocations silently does not apply to this one command.
  const valued = await runCli(
    ["qa", "publish", "--proxy-base", receiver.base, "--dry-run", "true", "--json"],
    { cwd: dir, telemetry: "on", lifecycleLog: journal },
  );
  assert.notEqual(valued.code, 0);
  assert.match(valued.stderr, /--dry-run takes no value/);
  assert.equal(receiver.posts.length, 0);
  assert.equal(existsSync(journal), false, "a refused invocation appends no lifecycle entry");
  assert.deepEqual(snapshot(dir), before);
});

test("run end carries --dry-run to run-record and leaves the session open", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const started = await runCli(["run", "start", "--packet", packetPath, "--json"], { cwd: dir });
  assert.equal(started.code, 0, started.stderr);
  const before = snapshot(dir);

  const dry = await runCli(["run", "end", "--packet", packetPath, "--proxy-base", receiver.base, "--dry-run", "--json"], { cwd: dir, telemetry: "on" });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).dry_run, true);
  assert.deepEqual(snapshot(dir), before, "no record was written and the session file is still there");
  assert.equal(receiver.posts.length, 0);

  // Positive control: the real close writes the record and clears the session.
  const real = await runCli(["run", "end", "--packet", packetPath, "--no-remit", "--json"], { cwd: dir });
  assert.equal(real.code, 0, real.stderr);
  assert.notDeepEqual(snapshot(dir), before);
});

// The lifecycle journal is a write under the target, so a command that
// implements --dry-run appends no entry. `--dry-run` reaches every handler
// through a permissive parser, though, so that exemption is scoped to the
// commands that implement the flag (DRY_RUN_COMMANDS): on any other command
// the flag is accepted and ignored exactly as it was before, telemetry
// included.
test("--dry-run skips the lifecycle entry only on the commands that implement it", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const journal = join(dir, "lifecycle.jsonl");

  // Outside the set: `tooling status` never read --dry-run, so it still
  // records its one entry. (Its exit code reports the install it inspects —
  // this machine's checkout, not the seeded target — so it is not asserted;
  // the entry is written on both the success and the error path anyway, which
  // is why the entry's own fields are checked.)
  const outside = await runCli(["tooling", "status", "--dry-run", "--json"], { cwd: dir, lifecycleLog: journal });
  const entries = readJournal(journal);
  assert.equal(entries.length, 1, `one lifecycle entry, unchanged by the flag: ${outside.stderr}`);
  assert.equal(entries[0].command, "tooling");
  assert.deepEqual(entries[0].argv_shape, ["--dry-run", "--json"]);

  // Inside the set: the close still writes nothing at all — no Run Record, no
  // lifecycle entry — and leaves the session for a real close afterwards.
  const started = await runCli(["run", "start", "--packet", packetPath, "--json"], { cwd: dir, lifecycleLog: journal });
  assert.equal(started.code, 0, started.stderr);
  const sessionPath = JSON.parse(started.stdout).session_path;
  const before = snapshot(dir);
  const journalled = readJournal(journal).length;

  const dry = await runCli(["run", "end", "--packet", packetPath, "--no-remit", "--dry-run", "--json"], { cwd: dir, lifecycleLog: journal });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).dry_run, true);
  assert.equal(readJournal(journal).length, journalled, "run end --dry-run appended no lifecycle entry");
  assert.deepEqual(snapshot(dir), before, "run end --dry-run wrote no record and cleared no session");
  assert.ok(existsSync(sessionPath), "the session is still open for a real close");

  // Positive control: the real close does write the record and clear the session.
  const real = await runCli(["run", "end", "--packet", packetPath, "--no-remit", "--json"], { cwd: dir, lifecycleLog: journal });
  assert.equal(real.code, 0, real.stderr);
  assert.equal(existsSync(sessionPath), false, "the real close cleared the session");
});

test("qa publish --dry-run runs every refusal check and posts nothing", async (t) => {
  const { dir, packetPath, verdictPath, verdict, specPath } = seedTarget(t);
  const receiver = await startReceiver();
  t.after(() => receiver.close());
  const before = snapshot(dir);

  const dry = await runCli(
    ["qa", "publish", "--packet", packetPath, "--verdict", verdictPath, "--proxy-base", receiver.base, "--dry-run", "--json"],
    { cwd: dir },
  );
  assert.equal(dry.code, 0, dry.stderr);
  const result = JSON.parse(dry.stdout);
  assert.equal(result.dry_run, true);
  assert.equal(result.would_publish, true);
  assert.equal(result.status, "dry_run");
  assert.equal(result.would_post.endpoint, "/api/qa/verdicts");
  assert.equal(result.would_post.verdict_run_id, VERDICT_RUN_ID);
  assert.equal(result.would_post.base_kind, "loopback");
  assert.ok(result.would_post.payload_bytes > 0);
  assert.equal(result.publish.attempted, false);
  assert.equal(result.orders_placed, 0);
  assert.deepEqual(snapshot(dir), before, "a dry run wrote nothing under the target");
  assert.equal(receiver.posts.length, 0, "a dry run sent nothing");

  // Positive control: the same invocation without --dry-run does post.
  const real = await runCli(
    ["qa", "publish", "--packet", packetPath, "--verdict", verdictPath, "--proxy-base", receiver.base, "--json"],
    { cwd: dir },
  );
  assert.equal(real.code, 0, real.stderr);
  assert.equal(JSON.parse(real.stdout).status, "published");
  assert.equal(receiver.posts.length, 1, "the real publish is visible to the receiver");
  assert.equal(receiver.posts[0].url, "/api/qa/verdicts");
  assert.equal(receiver.posts[0].payload.run_id, VERDICT_RUN_ID);

  // A refusal is refused identically under --dry-run: same code, same exit 2.
  const spec = readJson(specPath);
  writeJson(specPath, { ...spec, campaign: { ...spec.campaign, name: "renamed after the run" } });
  const stale = await runCli(
    ["qa", "publish", "--packet", packetPath, "--verdict", verdictPath, "--proxy-base", receiver.base, "--dry-run", "--json"],
    { cwd: dir },
  );
  assert.equal(stale.code, 2, "a refusal exits as the real command would");
  const refusal = JSON.parse(stale.stdout);
  assert.equal(refusal.dry_run, true);
  assert.equal(refusal.would_publish, false);
  assert.equal(refusal.status, "refused");
  assert.equal(refusal.refusal.code, "spec_hash_mismatch");
  assert.equal(refusal.verdict_spec_hash, verdict.spec_hash);
  assert.equal(receiver.posts.length, 1, "the refused dry run sent nothing");
});

test("checkpoint waive --dry-run validates the gate and leaves the report alone", async (t) => {
  const { dir, packetPath, reportPath, targetRepo } = seedTarget(t);
  const before = snapshot(dir);

  const dry = await runCli(
    ["checkpoint", "waive", "--packet", packetPath, "--gate", "page_kit.sdk_version", ...CHECKPOINT_WAIVE_ARGS, "--dry-run", "--json"],
    { cwd: dir },
  );
  assert.equal(dry.code, 0, dry.stderr);
  const result = JSON.parse(dry.stdout);
  assert.equal(result.dry_run, true);
  assert.equal(result.status, "dry_run");
  assert.equal(result.would_write, reportPath);
  assert.equal(result.gate, "page_kit.sdk_version");
  assert.equal(result.waiver.waived_by, "Jordan Lee");
  assert.deepEqual(result.waiver.subject, { public_route_slug: "runtime-packet-demo", target_path: "_data/campaigns.json" });
  assert.deepEqual(snapshot(dir), before, "a dry run wrote neither the report nor a stale doctor sidecar");

  // The same validation the real command does, on the same inputs: an
  // unregistered gate and a missing named human are refused before any write.
  const unknownGate = await runCli(
    ["checkpoint", "waive", "--packet", packetPath, "--gate", "no.such.gate", ...CHECKPOINT_WAIVE_ARGS, "--dry-run", "--json"],
    { cwd: dir },
  );
  assert.equal(unknownGate.code, 1);
  assert.match(unknownGate.stderr, /no\.such\.gate/);
  const unattributed = await runCli(
    ["checkpoint", "waive", "--packet", packetPath, "--gate", "page_kit.sdk_version", "--reason", "why", "--dry-run", "--json"],
    { cwd: dir },
  );
  assert.equal(unattributed.code, 1);
  assert.match(unattributed.stderr, /waived-by/);
  const unbounded = await runCli(
    ["checkpoint", "waive", "--packet", packetPath, "--gate", "page_kit.sdk_version", ...WAIVE_ARGS, "--dry-run", "--json"],
    { cwd: dir },
  );
  assert.equal(unbounded.code, 1);
  assert.match(unbounded.stderr, /at least one of expires_at or review_condition/);
  assert.deepEqual(snapshot(dir), before, "none of the refusals wrote anything");

  // Positive control: without --dry-run the waiver lands on the report.
  const real = await runCli(
    ["checkpoint", "waive", "--packet", packetPath, "--gate", "page_kit.sdk_version", ...CHECKPOINT_WAIVE_ARGS, "--json"],
    { cwd: dir },
  );
  assert.equal(real.code, 0, real.stderr);
  assert.notDeepEqual(snapshot(dir), before, "the real waive is visible to the snapshot");
  const report = readJson(reportPath);
  assert.equal(report.waivers.length, 1);
  assert.equal(report.waivers[0].waived_by, "Jordan Lee");
  assert.equal(readJson(join(targetRepo, ".campaign-runtime/doctor-output.json")).stale, true);
});

test("theme waive --dry-run records nothing on the assembly report", async (t) => {
  const { dir, packetPath, reportPath } = seedTarget(t);
  const before = snapshot(dir);

  const dry = await runCli(
    ["theme", "waive", "--packet", packetPath, ...WAIVE_ARGS, "--dry-run", "--json"],
    { cwd: dir },
  );
  assert.equal(dry.code, 0, dry.stderr);
  const result = JSON.parse(dry.stdout);
  assert.equal(result.dry_run, true);
  assert.equal(result.status, "dry_run");
  assert.equal(result.gate, "theme_gate");
  assert.equal(result.would_write, reportPath);
  assert.equal(result.waiver.waived_by, "Jordan Lee");
  assert.deepEqual(snapshot(dir), before, "a dry run wrote neither the report nor a stale doctor sidecar");

  // The reason is required on both paths.
  const unreasoned = await runCli(["theme", "waive", "--packet", packetPath, "--waived-by", "Jordan Lee", "--dry-run", "--json"], { cwd: dir });
  assert.equal(unreasoned.code, 1);
  assert.match(unreasoned.stderr, /--reason/);
  assert.deepEqual(snapshot(dir), before);

  // Positive control: without --dry-run the waiver lands on the report.
  const real = await runCli(["theme", "waive", "--packet", packetPath, ...WAIVE_ARGS, "--json"], { cwd: dir });
  assert.equal(real.code, 0, real.stderr);
  assert.notDeepEqual(snapshot(dir), before, "the real waive is visible to the snapshot");
  assert.equal(readJson(reportPath).theme.waiver.waived_by, "Jordan Lee");
});

// The session-preservation assertion above covers the ACTIVE session. The
// stale one is swept before dispatch ever reads the command's flags, and that
// sweep is the full closeout: it assembles a Run Record, remits it under
// consent and deletes the session file. `run end --dry-run --json` over an
// aged session therefore exited 0 having done all three — the flag's whole
// promise, broken before the handler ran.
test("run end --dry-run leaves a STALE session at cwd closed-out-free: no record, no POST, no deletion", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const stale = seedStaleSession(dir, { packet: packetPath });
  const sessionPath = resolveRunSessionPath(dir);
  const before = snapshot(dir);

  // Consent ON and pointed at the receiver: --dry-run is again the only thing
  // standing between this invocation and a written record plus a POST.
  const dry = await runCli(
    ["run", "end", "--proxy-base", receiver.base, "--dry-run", "--json"],
    { cwd: dir, telemetry: "on" },
  );
  // With the sweep skipped there is no session left to end, so the command
  // reports exactly what it reports for any root with no active session: the
  // documented "No active run session to end" refusal, exit 1. Nothing about
  // the stale session on disk has changed, and a real `run end` still closes
  // it out (the positive control below).
  assert.equal(dry.code, 1, dry.stderr);
  assert.match(dry.stderr, /No active run session to end/);
  assert.deepEqual(snapshot(dir), before, "the dry run wrote no Run Record and deleted nothing");
  assert.ok(existsSync(sessionPath), "the stale session file is still on disk");
  assert.equal(readJson(sessionPath).run_id, stale.run_id, "and it is still the same session");
  assert.equal(receiver.posts.length, 0, "the dry run sent nothing");

  // Positive control: without --dry-run the sweep closes the stale session out
  // for real — record written, session gone, one remit — so the snapshot, the
  // session file and the receiver are all able to see the effects asserted
  // absent above.
  const real = await runCli(["run", "end", "--proxy-base", receiver.base, "--json"], { cwd: dir, telemetry: "on" });
  assert.equal(real.code, 0, real.stderr);
  const closeout = JSON.parse(real.stdout).stale_closeout;
  assert.equal(closeout[0].run_id, stale.run_id);
  assert.ok(closeout[0].record_path, "the real close assembled the stale session's Run Record");
  assert.equal(existsSync(sessionPath), false, "the real close cleared the session");
  assert.equal(receiver.posts.length, 1, "the real close is visible to the receiver");
  assert.equal(receiver.posts[0].payload.run_id, stale.run_id);
});

// A dry run may never validate LESS than the real invocation: `theme waive
// --dry-run` returned on the report's mere existence, so a torn report was
// reported as a successful `would_write` with exit 0 while the real command
// refused it. Both waives now read the report the committing path reads.
test("waive --dry-run refuses a malformed assembly report exactly as the real command does", async (t) => {
  const { dir, packetPath, reportPath } = seedTarget(t);
  writeFileSync(reportPath, '{"identity": {"map_id": "truncated"');
  const before = snapshot(dir);

  for (const [label, argv] of [
    ["theme waive", ["theme", "waive", "--packet", packetPath, ...WAIVE_ARGS]],
    ["checkpoint waive", ["checkpoint", "waive", "--packet", packetPath, "--gate", "page_kit.sdk_version", ...CHECKPOINT_WAIVE_ARGS]],
  ]) {
    const real = await runCli([...argv, "--json"], { cwd: dir });
    const dry = await runCli([...argv, "--dry-run", "--json"], { cwd: dir });
    assert.equal(real.code, 1, `${label}: the real command refuses a torn report`);
    assert.equal(dry.code, real.code, `${label}: the dry run exits as the real command does`);
    assert.equal(dry.stderr, real.stderr, `${label}: and refuses by the same message`);
    assert.doesNotMatch(dry.stdout, /would_write/, `${label}: no success envelope on a refusal`);
    assert.deepEqual(snapshot(dir), before, `${label}: neither invocation wrote anything`);
  }

  // `theme waive` reaches the report through the read the commit uses, so both
  // paths name the file and the command. (`checkpoint waive` refuses earlier
  // still, on doctor's own read of the report, and so refuses by the raw parse
  // error on BOTH paths — the parity asserted above is what this test is
  // about; improving that message is separate work.)
  const themeDry = await runCli(["theme", "waive", "--packet", packetPath, ...WAIVE_ARGS, "--dry-run", "--json"], { cwd: dir });
  assert.match(themeDry.stderr, new RegExp(`Assembly Report at ${reportPath} is not valid JSON`));
});

// ---------------------------------------------------------------------------
// The parity table.
//
// The negative claim above ("nothing was written, nothing was sent") is only
// half the flag's contract. The other half is that a dry run validates NEITHER
// LESS NOR MORE than the real invocation: every check the real path makes
// between argv and its first effect must run under --dry-run too, and refuse
// by the same message with the same exit code. A dry run that validates less
// hands out successful previews of invocations that cannot happen — a
// `would_write` for a record the writer refuses, a `would_publish` for a
// destination the transport declines.
//
// Each row is one input the real path stops on. The dry run goes FIRST so the
// real run that follows it sees the same tree — and therefore the same paths in
// the same messages — and so that "the dry run wrote nothing" is asserted
// against the seeded tree rather than against whatever the real run left.
// ---------------------------------------------------------------------------

/** What a --json refusal says, reduced to the fields both paths must agree on. */
function refusalFacts(stdout) {
  if (!stdout.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return stdout;
  }
  return {
    ok: parsed.ok ?? null,
    status: parsed.status ?? null,
    error: parsed.error ?? null,
    refusal: parsed.refusal?.code ?? null,
    publish_error: parsed.publish?.error ?? null,
  };
}

/** A tree snapshot without the lifecycle journal a refused command still appends to. */
function withoutLifecycleJournal(files) {
  return Object.fromEntries(Object.entries(files).filter(([path]) => !path.endsWith("command-lifecycle.jsonl")));
}

/** A packet whose stored verdict judged a spec that has since been renamed. */
function renameSpecAfterTheRun({ specPath }) {
  const spec = readJson(specPath);
  writeJson(specPath, { ...spec, campaign: { ...spec.campaign, name: "renamed after the run" } });
}

const PARITY_ROWS = [
  {
    command: "run-record",
    label: "an unknown --primary-surface: the record's own validator refuses it before the write",
    argv: ({ packetPath }) => ["run-record", "--packet", packetPath, "--primary-surface", "not-a-surface", "--no-remit", "--json"],
    refusal: /Run Record failed validation; refusing to write: \[record\.primary_surface\]/,
  },
  {
    command: "run-record",
    label: "an unknown --surfaces value",
    argv: ({ packetPath }) => ["run-record", "--packet", packetPath, "--surfaces", "not-a-surface", "--no-remit", "--json"],
    refusal: /Unknown --surfaces value/,
  },
  {
    command: "run-record",
    label: "--new-run together with --run-id",
    argv: ({ packetPath }) => ["run-record", "--packet", packetPath, "--new-run", "--run-id", "run_1700000000000_abcdef12", "--no-remit", "--json"],
    refusal: /--new-run and --run-id are exclusive/,
  },
  {
    command: "run end",
    label: "the closing path carries the same record validation (and leaves the session open)",
    seed: async ({ dir, packetPath }) => {
      const started = await runCli(["run", "start", "--packet", packetPath, "--json"], { cwd: dir });
      assert.equal(started.code, 0, started.stderr);
    },
    argv: ({ packetPath }) => ["run", "end", "--packet", packetPath, "--primary-surface", "not-a-surface", "--no-remit", "--json"],
    refusal: /Run Record failed validation; refusing to write: \[record\.primary_surface\]/,
  },
  {
    command: "qa publish",
    label: "--proxy-base not-a-url: the transport's destination gate refuses it before any request",
    argv: ({ packetPath, verdictPath }) => ["qa", "publish", "--packet", packetPath, "--verdict", verdictPath, "--proxy-base", "not-a-url", "--json"],
    refusal: /QA verdict publish: --proxy-base is not a URL: not-a-url/,
  },
  {
    command: "qa publish",
    label: "--proxy-base http://example.invalid: plain http to a host that is not loopback",
    argv: ({ packetPath, verdictPath }) => ["qa", "publish", "--packet", packetPath, "--verdict", verdictPath, "--proxy-base", "http://example.invalid", "--json"],
    refusal: /QA verdict publish: --proxy-base must be https \(or a loopback host for local testing\)/,
  },
  {
    // The destination gate is not the transport's only precondition: `remit`
    // demands something to send WITH first. A preview that skipped this one
    // approved a publish on a runtime that cannot make the request at all.
    command: "qa publish",
    label: "a runtime with no global fetch: the transport's first precondition, ahead of the destination gate",
    noFetch: true,
    argv: ({ packetPath, verdictPath }) => ["qa", "publish", "--packet", packetPath, "--verdict", verdictPath, "--proxy-base", "https://proxy.test", "--json"],
    refusal: /Global fetch is not available\. Upgrade to Node 18\+ or pass fetchImpl\./,
  },
  {
    command: "qa publish",
    label: "a verdict whose spec the packet has moved past",
    seed: renameSpecAfterTheRun,
    argv: ({ packetPath, verdictPath }) => ["qa", "publish", "--packet", packetPath, "--verdict", verdictPath, "--json"],
    refusal: /spec_hash_mismatch/,
  },
  {
    command: "qa publish",
    label: "a --verdict that is not on disk",
    argv: ({ packetPath, dir }) => ["qa", "publish", "--packet", packetPath, "--verdict", join(dir, "no-such-verdict.json"), "--json"],
    refusal: /no-such-verdict\.json/,
  },
  {
    command: "checkpoint waive",
    label: "a gate that is not registered",
    argv: ({ packetPath }) => ["checkpoint", "waive", "--packet", packetPath, "--gate", "no.such.gate", ...CHECKPOINT_WAIVE_ARGS, "--json"],
    refusal: /no\.such\.gate/,
  },
  {
    command: "checkpoint waive",
    label: "no named human to attribute the waiver to",
    argv: ({ packetPath }) => ["checkpoint", "waive", "--packet", packetPath, "--gate", "page_kit.sdk_version", "--reason", "why", "--json"],
    refusal: /waived-by/,
  },
  {
    command: "checkpoint waive",
    label: "a waiver with neither an expiry nor a review condition",
    argv: ({ packetPath }) => ["checkpoint", "waive", "--packet", packetPath, "--gate", "page_kit.sdk_version", ...WAIVE_ARGS, "--json"],
    refusal: /at least one of expires_at or review_condition/,
  },
  {
    command: "checkpoint waive",
    label: "an assembly report torn mid-write",
    seed: ({ reportPath }) => writeFileSync(reportPath, '{"identity": {"map_id": "truncated"'),
    argv: ({ packetPath }) => ["checkpoint", "waive", "--packet", packetPath, "--gate", "page_kit.sdk_version", ...CHECKPOINT_WAIVE_ARGS, "--json"],
    refusal: /JSON/,
  },
  {
    command: "theme waive",
    label: "an assembly report that is not an object: the commit's own check on the mutator's result",
    seed: ({ reportPath }) => writeFileSync(reportPath, "[]"),
    argv: ({ packetPath }) => ["theme", "waive", "--packet", packetPath, ...WAIVE_ARGS, "--json"],
    refusal: /mutate\(report\) must return an Assembly Report object/,
  },
  {
    command: "theme waive",
    label: "no --reason",
    argv: ({ packetPath }) => ["theme", "waive", "--packet", packetPath, "--waived-by", "Jordan Lee", "--json"],
    refusal: /--reason/,
  },
  {
    command: "theme waive",
    label: "a placeholder in place of a named human",
    argv: ({ packetPath }) => ["theme", "waive", "--packet", packetPath, "--reason", "Starter palette is acceptable", "--waived-by", "operator", "--json"],
    refusal: /--waived-by with the named human who approved it; placeholders are not accepted/,
  },
  {
    command: "theme waive",
    label: "an assembly report torn mid-write",
    seed: ({ reportPath }) => writeFileSync(reportPath, '{"identity": {"map_id": "truncated"'),
    argv: ({ packetPath }) => ["theme", "waive", "--packet", packetPath, ...WAIVE_ARGS, "--json"],
    refusal: /is not valid JSON/,
  },
];

test("--dry-run refuses exactly what the real path refuses before its first effect, by the same message and exit code", async (t) => {
  for (const row of PARITY_ROWS) {
    await t.test(`${row.command}: ${row.label}`, async (inner) => {
      const target = seedTarget(inner);
      if (row.seed) await row.seed(target);
      const argv = row.argv(target);
      const nodeArgs = row.noFetch ? noFetchNodeArgs(inner) : [];
      const before = snapshot(target.dir);

      const dry = await runCli([...argv, "--dry-run"], { cwd: target.dir, nodeArgs });
      assert.deepEqual(snapshot(target.dir), before, "the dry run wrote nothing");
      const real = await runCli(argv, { cwd: target.dir, nodeArgs });

      assert.notEqual(real.code, 0, `the real invocation refuses this input: ${real.stdout}${real.stderr}`);
      assert.equal(dry.code, real.code, "the dry run exits as the real invocation does");
      assert.equal(dry.stderr, real.stderr, "and refuses by the same message");
      assert.deepEqual(refusalFacts(dry.stdout), refusalFacts(real.stdout), "and by the same JSON refusal");
      assert.match(`${dry.stderr}${dry.stdout}`, row.refusal, "the refusal is the one this row is about");
      assert.doesNotMatch(dry.stdout, /"would_write"|"would_publish": true|"status": "dry_run"/, "no success preview on a refusal");
      // The real invocation still journals the command it refused where a run
      // session names a lifecycle journal (`run end`); that entry is the
      // command's own bookkeeping, not the effect under test, and the dry run's
      // "wrote nothing" is asserted strictly above.
      assert.deepEqual(withoutLifecycleJournal(snapshot(target.dir)), withoutLifecycleJournal(before), "neither invocation wrote the effect it was refused");
    });
  }
});

// The other direction of the same rule: where the real path does NOT refuse,
// the dry run may not refuse either. These two rows exit 0 on both paths — the
// dry run reports what the real invocation would do and still writes nothing.
test("--dry-run refuses no MORE than the real path does", async (t) => {
  // A report that is not an object is a refusal for `theme waive` (above) but
  // not for `checkpoint waive`, whose mutator returns a plain object built from
  // it; the real command writes. The dry run agrees — exit 0, a preview — and
  // writes nothing. (That the committing path accepts this report at all is a
  // separate defect; parity is what is asserted here.)
  const target = seedTarget(t);
  writeFileSync(target.reportPath, "[]");
  const argv = ["checkpoint", "waive", "--packet", target.packetPath, "--gate", "page_kit.sdk_version", ...CHECKPOINT_WAIVE_ARGS, "--json"];
  const before = snapshot(target.dir);

  const dry = await runCli([...argv, "--dry-run"], { cwd: target.dir });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).status, "dry_run");
  assert.deepEqual(snapshot(target.dir), before, "the dry run wrote nothing");
  const real = await runCli(argv, { cwd: target.dir });
  assert.equal(real.code, 0, real.stderr);
  assert.notDeepEqual(snapshot(target.dir), before, "the real invocation is the one that writes");
});

// `run-record`'s remit rail is non-fatal by contract: a destination the
// transport refuses is recorded as a failed remit and the command still exits
// 0. So parity here is not a shared refusal — it is that the preview may not
// name a destination the real run could never have reached. The gate runs, and
// `would_remit` is null with the gate's own message on the envelope.
test("run-record --dry-run puts the remit destination through the transport's gate", async (t) => {
  const { dir, packetPath } = seedTarget(t);

  for (const [proxyBase, expected] of [
    ["not-a-url", /Run Telemetry remit: --proxy-base is not a URL: not-a-url/],
    ["http://example.invalid", /Run Telemetry remit: --proxy-base must be https \(or a loopback host for local testing\)/],
  ]) {
    const before = snapshot(dir);
    const dry = await runCli(["run-record", "--packet", packetPath, "--proxy-base", proxyBase, "--dry-run", "--json"], { cwd: dir, telemetry: "on" });
    assert.equal(dry.code, 0, `${proxyBase}: the remit rail is non-fatal, as it is for real`);
    const summary = JSON.parse(dry.stdout);
    assert.equal(summary.would_remit, null, `${proxyBase}: no endpoint is previewed for a destination the transport refuses`);
    assert.match(summary.would_remit_refused, expected, `${proxyBase}: the envelope carries the gate's own refusal`);
    assert.ok(summary.would_write, `${proxyBase}: the record itself would still be written`);
    assert.deepEqual(snapshot(dir), before, `${proxyBase}: the dry run wrote nothing`);

    // The real invocation agrees: it exits 0 too, having recorded that same
    // refusal on the record it wrote.
    const real = await runCli(["run-record", "--packet", packetPath, "--new-run", "--proxy-base", proxyBase, "--json"], { cwd: dir, telemetry: "on" });
    assert.equal(real.code, 0, real.stderr);
    const record = JSON.parse(real.stdout).record;
    assert.equal(record.remit_state, "failed", `${proxyBase}: the real run's remit failed locally`);
    assert.match(record.remit_error, expected, `${proxyBase}: by the message the dry run previewed`);
  }
});

// The same rule for the transport's OTHER precondition. Without a global fetch
// there is nothing to send with, and `remit` refuses on that before it even
// looks at the destination — so a reachable https receiver is no help. The rail
// stays non-fatal on both paths (exit 0), so parity is again that the preview
// names no endpoint and carries the message the real run records in
// `remit_error`, and that neither invocation opens a connection.
test("run-record --dry-run refuses a send it has no fetch for, exactly as the real run records it", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const receiver = await startReceiver();
  t.after(() => receiver.close());
  const nodeArgs = noFetchNodeArgs(t);
  const before = snapshot(dir);

  const dry = await runCli(
    ["run-record", "--packet", packetPath, "--proxy-base", receiver.base, "--dry-run", "--json"],
    { cwd: dir, telemetry: "on", nodeArgs },
  );
  assert.equal(dry.code, 0, dry.stderr);
  const summary = JSON.parse(dry.stdout);
  assert.equal(summary.would_remit, null, "no endpoint is previewed for a send with no transport to make it");
  assert.equal(summary.would_remit_refused, "Global fetch is not available. Upgrade to Node 18+ or pass fetchImpl.");
  assert.ok(summary.would_write, "the record itself would still be written");
  assert.deepEqual(snapshot(dir), before, "the dry run wrote nothing");
  assert.equal(receiver.posts.length, 0, "and contacted nobody");

  // The real invocation agrees: exit 0, the same refusal on the record it wrote.
  const real = await runCli(
    ["run-record", "--packet", packetPath, "--new-run", "--proxy-base", receiver.base, "--json"],
    { cwd: dir, telemetry: "on", nodeArgs },
  );
  assert.equal(real.code, dry.code, "the real run exits as the dry run does — this rail is non-fatal");
  const record = JSON.parse(real.stdout).record;
  assert.equal(record.remit_state, "failed", "the real run's remit failed locally");
  assert.equal(record.remit_error, summary.would_remit_refused, "by the exact message the dry run previewed");
  assert.equal(receiver.posts.length, 0, "the real run had no transport to reach the receiver with either");
});

// The one guard in commitWaiverToAssemblyReport that no shipped input reaches:
// both waive mutators always return the report they built. commitAssemblyReport
// reads a null result as "nothing to write", so a future mutator that forgot to
// return would skip the write while the command still reported the waiver
// recorded — silently, on the REAL path. It is a bug, and it throws on both
// paths. The dry run's own "do not write" is the wrapper's return value, not
// the mutator's, so refusing the mutator's null costs that contract nothing.
test("a waive mutator that returns nothing is refused, not read as nothing-to-write", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-waive-result-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reportPath = join(dir, "assembly-report.json");
  writeJson(reportPath, { identity: { map_id: "map_test" }, stages: {} });
  const workspace = { reportPath, targetRepo: dir };
  const options = { command: "theme waive", staleReason: "A waiver was recorded after this doctor snapshot." };
  const before = snapshot(dir);

  for (const dryRun of [false, true]) {
    for (const [label, mutate] of [["undefined", () => undefined], ["null", () => null]]) {
      assert.throws(
        () => commitWaiverToAssemblyReport(workspace, mutate, options, { dryRun }),
        /mutate\(report\) must return an Assembly Report object/,
        `returning ${label} under dryRun=${dryRun}`,
      );
    }
  }
  assert.deepEqual(snapshot(dir), before, "and nothing was written on the way to any of those refusals");

  // The control: a mutator that returns the report previews under a dry run and
  // writes without one, so the guard above refuses only the bug.
  const record = (report) => ({ ...report, theme: { waiver: { waived_by: "Jordan Lee" } } });
  assert.equal(commitWaiverToAssemblyReport(workspace, record, options, { dryRun: true }).written, false);
  assert.deepEqual(snapshot(dir), before, "the dry run wrote nothing");
  assert.equal(commitWaiverToAssemblyReport(workspace, record, options).written, true);
  assert.notDeepEqual(snapshot(dir), before, "the real commit is the one that writes");
});

test("help offers --dry-run on all four mutating commands", async () => {
  const { stdout } = await execFileAsync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  for (const usage of [/campaigns-os run-record .*\[--dry-run\]/, /campaigns-os theme waive .*\[--dry-run\]/, /campaigns-os checkpoint waive .*\[--dry-run\]/, /campaigns-os qa publish .*\[--dry-run\]/]) {
    assert.match(stdout, usage);
  }
  const qa = await execFileAsync(process.execPath, [CLI, "qa", "--help"], { encoding: "utf8" });
  assert.match(qa.stdout, /campaigns-os qa publish .*\[--dry-run\]/);
});
