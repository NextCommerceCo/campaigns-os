#!/usr/bin/env node
// Discover nested tests automatically. Browser proof is a mandatory separate lane.
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

export function runTests(root, { browser = false, spawn = spawnSync, report = console.error } = {}) {
  const files = discoverTests(root, { browser });
  if (!files.length) throw new Error(`No ${browser ? "browser" : "unit"} tests discovered`);
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
  process.exitCode = runTests(root, { browser: process.argv.includes("--browser") });
}
