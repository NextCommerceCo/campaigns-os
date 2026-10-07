#!/usr/bin/env node
// Discover nested tests automatically. Browser proof is a mandatory separate lane.
// `--shard <index>/<total>` runs one of `total` disjoint slices, so CI can split
// a long lane across runners; together the slices run every discovered file.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// Deal the sorted files round-robin: shard i of n takes every n-th file from
// position i-1. Each file lands in exactly one shard, and a slow file's
// neighbours spread across the others.
export function selectShard(files, shard) {
  if (!shard) return files;
  return files.filter((_, position) => position % shard.total === shard.index - 1);
}

export function shardFromArgv(argv) {
  const at = argv.findIndex((arg) => arg === "--shard" || arg.startsWith("--shard="));
  if (at < 0) return undefined;
  return parseShard(argv[at] === "--shard" ? argv[at + 1] : argv[at].slice("--shard=".length));
}

export function runTests(root, { browser = false, shard, spawn = spawnSync, report = console.error } = {}) {
  const lane = browser ? "browser" : "unit";
  const discovered = discoverTests(root, { browser });
  if (!discovered.length) throw new Error(`No ${lane} tests discovered`);
  const files = selectShard(discovered, shard);
  if (!files.length) {
    throw new Error(`Shard ${shard.index}/${shard.total} of the ${lane} lane is empty (${discovered.length} files discovered)`);
  }
  if (shard) report(`${lane} shard ${shard.index}/${shard.total}: ${files.length} of ${discovered.length} test files`);
  const result = spawn(process.execPath, ["--test", ...files], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...(browser ? { CAMPAIGNS_OS_REQUIRE_BROWSER: "1" } : {}) },
  });
  if (result.error) throw result.error;
  if (result.signal) report(`Test process terminated by ${result.signal}`);
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const argv = process.argv.slice(2);
  process.exitCode = runTests(root, { browser: argv.includes("--browser"), shard: shardFromArgv(argv) });
}
