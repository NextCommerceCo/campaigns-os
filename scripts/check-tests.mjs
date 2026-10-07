#!/usr/bin/env node
// Discover nested tests automatically. Browser proof is a mandatory separate lane.
// `--shard <index>/<total>` runs one of `total` disjoint slices, so CI can split
// a long lane across runners; together the slices run every discovered file.
// The slices are balanced by the measured durations in scripts/test-durations.json;
// `--record-durations` runs the lane (or shard) and refreshes them.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DURATIONS_PATH = "scripts/test-durations.json";

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

// Split the files heaviest first: each goes to the shard with the least weight
// so far, ties to the lower shard and then by path, so every runner computes
// the same split and each file lands in exactly one shard. With equal weights
// this deals the sorted files round-robin.
export function selectShard(files, shard, weightOf = () => 1) {
  if (!shard) return files;
  const loads = new Array(shard.total).fill(0);
  const owner = new Map();
  const heaviestFirst = [...files].sort((a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const file of heaviestFirst) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] += weightOf(file);
    owner.set(file, lightest);
  }
  return files.filter((file) => owner.get(file) === shard.index - 1);
}

// Each file weighs its recorded duration. Nothing cheaper predicts it: on
// 2026-10-07 the alphabetical round-robin put 195s and 591s of unit test time
// in the two shards (the four slowest files sorted together), line count left
// the browser lane at 748s against 1,125s (its time is spent waiting on
// timeouts), and byte size did no better. A file recorded nowhere (added since
// the last recording) weighs the lane's median, so it unbalances little.
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

function recordDurations(root, lane, discovered, reportPath, report) {
  const measured = {};
  for (const [file, milliseconds] of Object.entries(JSON.parse(readFileSync(reportPath, "utf8")))) {
    measured[relative(root, file)] = milliseconds / 1000;
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
}

export function runTests(root, { browser = false, shard, record = false, spawn = spawnSync, report = console.error } = {}) {
  const lane = browser ? "browser" : "unit";
  const discovered = discoverTests(root, { browser });
  if (!discovered.length) throw new Error(`No ${lane} tests discovered`);
  const files = selectShard(discovered, shard, weightsFor(readDurations(root, lane)));
  if (!files.length) {
    throw new Error(`Shard ${shard.index}/${shard.total} of the ${lane} lane is empty (${discovered.length} files discovered)`);
  }
  if (shard) report(`${lane} shard ${shard.index}/${shard.total}: ${files.length} of ${discovered.length} test files`);
  const scratch = record ? mkdtempSync(join(tmpdir(), "campaigns-test-durations-")) : null;
  const reporters = scratch
    ? [
        "--test-reporter=spec", "--test-reporter-destination=stdout",
        `--test-reporter=${join(root, "scripts/test-duration-reporter.mjs")}`, `--test-reporter-destination=${join(scratch, "durations.json")}`,
      ]
    : [];
  try {
    const result = spawn(process.execPath, ["--test", ...reporters, ...files], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...(browser ? { CAMPAIGNS_OS_REQUIRE_BROWSER: "1" } : {}) },
    });
    if (result.error) throw result.error;
    if (result.signal) report(`Test process terminated by ${result.signal}`);
    const status = result.status ?? 1;
    // A failing run's timings describe failures, not the lane; keep the old ones.
    if (scratch && status === 0) recordDurations(root, lane, discovered, join(scratch, "durations.json"), report);
    if (scratch && status !== 0) report(`durations not recorded: the ${lane} lane failed`);
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
