// How `run-record` picks its run_id once no session names one.
//
// `run end` clears the session. Every run-record after that used to mint a
// fresh id, so the closeout action `next` prints and any re-emit after a
// sidecar fix filed a SECOND Run Record for a run that already had one. With
// no --run-id and no session the command now re-emits the most recent Run
// Record for this packet's campaign in place (a remitted one is final and left
// as written); --new-run mints on request; --list reports the ids on disk and
// writes nothing. The source of the id travels on the stdout envelope only.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

import { RUN_RECORDS_DIR_REL_PATH, resolveRunRecordPath } from "./run-record.mjs";

const execFileAsync = promisify(execFile);

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

function seedTarget(t) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-run-id-resolution-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "run-id-resolution-target", private: true }));
  const packetPath = join(dir, "campaign-runtime.build.json");
  cpSync(join(ROOT, "examples/build-packet.basic.json"), packetPath);
  return { dir, packetPath };
}

async function runCli(argv, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...argv], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: cwd, CAMPAIGNS_OS_TELEMETRY: "off", CAMPAIGNS_OS_LIFECYCLE_LOG: "" },
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: error.code ?? 1, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

function recordFiles(dir) {
  const records = join(dir, RUN_RECORDS_DIR_REL_PATH);
  return existsSync(records) ? readdirSync(records).filter((name) => name.endsWith(".json")).sort() : [];
}

test("after run end, consecutive run-record calls without --run-id re-emit the closed run's record instead of minting", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const start = await runCli(["run", "start", "--packet", packetPath, "--json"], dir);
  assert.equal(start.status, 0, start.stderr);
  const sessionRunId = JSON.parse(start.stdout).session.run_id;
  const end = await runCli(["run", "end", "--packet", packetPath, "--no-remit", "--json"], dir);
  assert.equal(end.status, 0, end.stderr);
  assert.deepEqual(recordFiles(dir), [`${sessionRunId}.json`]);

  const first = await runCli(["run-record", "--packet", packetPath, "--no-remit", "--json"], dir);
  assert.equal(first.status, 0, first.stderr);
  const firstOut = JSON.parse(first.stdout);
  assert.equal(firstOut.record.run_id, sessionRunId, "the first re-emit after close reuses the closed run's id");
  assert.equal(firstOut.run_id_source, "latest_record");

  const second = await runCli(["run-record", "--packet", packetPath, "--no-remit", "--json"], dir);
  assert.equal(second.status, 0, second.stderr);
  const secondOut = JSON.parse(second.stdout);
  assert.equal(secondOut.record.run_id, firstOut.record.run_id, "two consecutive calls after close write the same run_id");
  assert.equal(secondOut.run_id_source, "latest_record");
  assert.deepEqual(recordFiles(dir), [`${sessionRunId}.json`], "one record on disk, not three");
  assert.equal("run_id_source" in secondOut.record, false, "the source rides the envelope, never the record");

  const text = await runCli(["run-record", "--packet", packetPath, "--no-remit"], dir);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`Run ID ${sessionRunId} is the most recent Run Record for this campaign; re-emitting it in place\\. Pass --new-run`));
  assert.match(text.stdout, new RegExp(`Run ID: ${sessionRunId} \\(latest_record\\)`));
});

test("--new-run mints a fresh run_id even when a record exists for the campaign", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const seeded = await runCli(["run-record", "--packet", packetPath, "--no-remit", "--json"], dir);
  assert.equal(seeded.status, 0, seeded.stderr);
  const seededOut = JSON.parse(seeded.stdout);
  assert.equal(seededOut.run_id_source, "minted", "with no record on disk the id is minted");

  const fresh = await runCli(["run-record", "--packet", packetPath, "--new-run", "--no-remit", "--json"], dir);
  assert.equal(fresh.status, 0, fresh.stderr);
  const freshOut = JSON.parse(fresh.stdout);
  assert.equal(freshOut.run_id_source, "minted");
  assert.notEqual(freshOut.record.run_id, seededOut.record.run_id);
  assert.equal(recordFiles(dir).length, 2);

  const explicit = await runCli(["run-record", "--packet", packetPath, "--run-id", seededOut.record.run_id, "--no-remit", "--json"], dir);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).run_id_source, "explicit");

  const both = await runCli(["run-record", "--packet", packetPath, "--run-id", seededOut.record.run_id, "--new-run", "--no-remit", "--json"], dir);
  assert.notEqual(both.status, 0, "--run-id and --new-run together are refused");
  assert.match(both.stderr, /--new-run and --run-id are exclusive/);
});

test("--list prints the run ids on disk for this packet and writes nothing", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const empty = await runCli(["run-record", "--packet", packetPath, "--list", "--json"], dir);
  assert.equal(empty.status, 0, empty.stderr);
  const emptyOut = JSON.parse(empty.stdout);
  assert.equal(emptyOut.list, true);
  assert.equal(emptyOut.written, false);
  assert.deepEqual(emptyOut.records, []);
  assert.equal(emptyOut.run_id_source, "minted");
  assert.deepEqual(recordFiles(dir), [], "--list on an empty target creates no record");

  const seeded = JSON.parse((await runCli(["run-record", "--packet", packetPath, "--no-remit", "--json"], dir)).stdout);
  const before = recordFiles(dir);
  const listed = await runCli(["run-record", "--packet", packetPath, "--list", "--json"], dir);
  assert.equal(listed.status, 0, listed.stderr);
  const listedOut = JSON.parse(listed.stdout);
  assert.equal(listedOut.written, false);
  assert.equal(listedOut.remit.sent, false);
  assert.equal(listedOut.records.length, 1);
  assert.equal(listedOut.records[0].run_id, seeded.record.run_id);
  assert.equal(listedOut.records[0].remit_state, "skipped");
  assert.ok(listedOut.records[0].created_at);
  assert.ok(listedOut.records[0].record_path.endsWith(`${seeded.record.run_id}.json`));
  assert.equal(listedOut.run_id, seeded.record.run_id);
  assert.equal(listedOut.run_id_source, "latest_record");
  assert.deepEqual(recordFiles(dir), before, "--list writes nothing");

  const text = await runCli(["run-record", "--packet", packetPath, "--list"], dir);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Run Records for this packet's campaign: 1/);
  assert.match(text.stdout, new RegExp(`${seeded.record.run_id}  created .*  remit skipped`));
  assert.match(text.stdout, /List only \(--list\)\. No record written, no remit\./);
});

test("a matching record that lost its run_id is listed as unnamed and never turns the re-emit into a mint", async (t) => {
  const { dir, packetPath } = seedTarget(t);
  const seeded = JSON.parse((await runCli(["run-record", "--packet", packetPath, "--no-remit", "--json"], dir)).stdout);
  const damaged = JSON.parse(readFileSync(resolveRunRecordPath(seeded.record.run_id, dir), "utf8"));
  delete damaged.run_id;
  damaged.created_at = "2099-01-01T00:00:00.000Z";
  writeFileSync(resolveRunRecordPath("run_9999999999999_damaged", dir), `${JSON.stringify(damaged, null, 2)}\n`);

  const listed = JSON.parse((await runCli(["run-record", "--packet", packetPath, "--list", "--json"], dir)).stdout);
  assert.deepEqual(listed.records.map((entry) => entry.run_id), [null, seeded.record.run_id], "the damaged file is listed, unnamed, newest first");
  assert.equal(listed.run_id, seeded.record.run_id);
  assert.equal(listed.run_id_source, "latest_record");

  const reemit = JSON.parse((await runCli(["run-record", "--packet", packetPath, "--no-remit", "--json"], dir)).stdout);
  assert.equal(reemit.run_id_source, "latest_record");
  assert.equal(reemit.record.run_id, seeded.record.run_id, "the id-bearing record is re-emitted; nothing is minted");
  assert.equal(recordFiles(dir).length, 2);
});
