#!/usr/bin/env node
// Discover nested tests automatically. Browser proof is a mandatory separate lane.
// `--shard <index>/<total>` runs one of `total` disjoint slices, so CI can split
// a long lane across runners; together the slices run every discovered file.
// The slices are balanced by the measured durations in scripts/test-durations.json,
// and a lane or slice starts its slowest files first (run-test-files.mjs);
// `--record-durations` runs the lane and refreshes its entries. Record whole
// lanes: a shard records only the files that ran in it, so a new file in another
// shard stays unrecorded (and weighs the lane's median) until that shard runs.
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DURATIONS_PATH = "scripts/test-durations.json";
const RUNNER = fileURLToPath(new URL("./run-test-files.mjs", import.meta.url));

export function discoverTests(root, { browser = false } = {}) {
  function walk(directory) {
    return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walk(path);
      if (!entry.isFile() || !entry.name.endsWith(".test.mjs")) return [];
      const isBrowserTest = entry.name.endsWith(".browser.test.mjs");
      return (browser ? isBrowserTest : !isBrowserTest) ? [path] : [];
    });
  }
  return ["src", "scripts"].flatMap(walk).sort();
}

export function parseShard(value) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value ?? "");
  const shard = match && { index: Number(match[1]), total: Number(match[2]) };
  if (!shard || shard.index > shard.total) {
    throw new Error(`--shard takes <index>/<total> with 1 <= index <= total, got ${JSON.stringify(value ?? null)}`);
  }
  return shard;
}

// Heaviest first, ties by path, so every runner computes the same order.
export function heaviestFirst(files, weightOf = () => 1) {
  return [...files].sort((a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : a > b ? 1 : 0));
}

// Split the files heaviest first: each goes to the shard with the least weight
// so far, ties to the lower shard and then by path, so every runner computes
// the same split and each file lands in exactly one shard. With equal weights
// this deals the sorted files round-robin.
export function selectShard(files, shard, weightOf = () => 1) {
  if (!shard) return files;
  const loads = new Array(shard.total).fill(0);
  const owner = new Map();
  for (const file of heaviestFirst(files, weightOf)) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] += weightOf(file);
    owner.set(file, lightest);
  }
  return files.filter((file) => owner.get(file) === shard.index - 1);
}

// Each file weighs its recorded duration: the time its process ran, start-up
// and imports included (test-duration-reporter.mjs). Nothing cheaper predicts
// it: on 2026-10-07 the alphabetical round-robin put 195s and 591s of unit
// test time in the two shards (the four slowest files sorted together), line
// count left the browser lane at 748s against 1,125s (its time is spent
// waiting on timeouts), and byte size did no better. A file recorded nowhere
// (added since the last recording) weighs the lane's median, so it unbalances
// little.
export function readDurations(root, lane) {
  try {
    return JSON.parse(readFileSync(join(root, DURATIONS_PATH), "utf8"))[lane] ?? {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export function weightsFor(durations) {
  const known = Object.values(durations).filter((seconds) => Number.isFinite(seconds)).sort((a, b) => a - b);
  const median = known.length > 0 ? known[Math.floor((known.length - 1) / 2)] : 1;
  return (file) => (Number.isFinite(durations[file]) ? durations[file] : median);
}

/** The lane's entries after a recording: measured files updated, files no longer in the lane dropped, seconds to 0.1. */
export function mergeDurations(previous, discovered, measuredSeconds) {
  const merged = {};
  for (const file of discovered) {
    const seconds = Number.isFinite(measuredSeconds[file]) ? measuredSeconds[file] : previous[file];
    if (Number.isFinite(seconds)) merged[file] = Math.round(seconds * 10) / 10;
  }
  return merged;
}

export function shardFromArgv(argv) {
  const at = argv.findIndex((arg) => arg === "--shard" || arg.startsWith("--shard="));
  if (at < 0) return undefined;
  return parseShard(argv[at] === "--shard" ? argv[at + 1] : argv[at].slice("--shard=".length));
}

// Returns false, writing nothing, when a file that ran reported no run time:
// the runner no longer reports files the way the reporter reads them, and
// recording the rest would quietly keep stale entries.
function recordDurations(root, lane, discovered, ran, reportPath, report) {
  const measured = {};
  // The runner reports real paths: its working directory is the root with any symlinks resolved.
  const realRoot = realpathSync(root);
  for (const [file, milliseconds] of Object.entries(JSON.parse(readFileSync(reportPath, "utf8")))) {
    measured[relative(realRoot, file)] = milliseconds / 1000;
  }
  const unmeasured = ran.filter((file) => !Number.isFinite(measured[file]));
  if (unmeasured.length) {
    const named = unmeasured.slice(0, 3).join(", ") + (unmeasured.length > 3 ? ", ..." : "");
    report(`durations not recorded: no run time reported for ${unmeasured.length} of ${ran.length} ${lane} files (${named})`);
    return false;
  }
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(join(root, DURATIONS_PATH), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  manifest[lane] = mergeDurations(manifest[lane] ?? {}, discovered, measured);
  writeFileSync(join(root, DURATIONS_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
  report(`recorded ${Object.keys(measured).length} ${lane} test durations in ${DURATIONS_PATH}`);
  return true;
}

// A lane starts its slowest files first, through run-test-files.mjs: `node
// --test` starts files in path order, so a slow file that sorts late starts
// late and sets the lane's end. On 2026-10-07 that made unit 1/2 take 7m50s
// against 4m30s for unit 2/2, though both weighed 393s:
// src/stage-record.test.mjs ran 291s in CI and started 167s in. Started
// first, a shard takes about as long as its slowest file or its share of the
// work, whichever is longer.
export function runTests(root, { browser = false, shard, record = false, spawn = spawnSync, report = console.error } = {}) {
  const lane = browser ? "browser" : "unit";
  const discovered = discoverTests(root, { browser });
  if (!discovered.length) throw new Error(`No ${lane} tests discovered`);
  const weightOf = weightsFor(readDurations(root, lane));
  const files = heaviestFirst(selectShard(discovered, shard, weightOf), weightOf);
  if (!files.length) {
    throw new Error(`Shard ${shard.index}/${shard.total} of the ${lane} lane is empty (${discovered.length} files discovered)`);
  }
  if (shard) report(`${lane} shard ${shard.index}/${shard.total}: ${files.length} of ${discovered.length} test files`);
  const scratch = record ? mkdtempSync(join(tmpdir(), "campaigns-test-durations-")) : null;
  const durations = scratch ? [`--durations=${join(scratch, "durations.json")}`] : [];
  try {
    const result = spawn(process.execPath, [RUNNER, ...durations, ...files], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...(browser ? { CAMPAIGNS_OS_REQUIRE_BROWSER: "1" } : {}) },
    });
    if (result.error) throw result.error;
    if (result.signal) report(`Test process terminated by ${result.signal}`);
    const status = result.status ?? 1;
    // A failing run's timings describe failures, not the lane; keep the old ones.
    if (scratch && status !== 0) report(`durations not recorded: the ${lane} lane failed`);
    if (scratch && status === 0 && !recordDurations(root, lane, discovered, files, join(scratch, "durations.json"), report)) return 1;
    return status;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const argv = process.argv.slice(2);
  process.exitCode = runTests(root, {
    browser: argv.includes("--browser"),
    shard: shardFromArgv(argv),
    record: argv.includes("--record-durations"),
  });
}
