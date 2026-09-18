#!/usr/bin/env node
// Discover new tests automatically. Browser proof is an explicit, mandatory lane.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const browser = process.argv.includes("--browser");
const files = ["src", "scripts"].flatMap((directory) =>
  readdirSync(new URL(`../${directory}/`, import.meta.url))
    .filter((name) => name.endsWith(".test.mjs") && name.endsWith(".browser.test.mjs") === browser)
    .map((name) => `${directory}/${name}`),
).sort();
if (!files.length) throw new Error(`No ${browser ? "browser" : "unit"} tests discovered`);
const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ...(browser ? { CAMPAIGNS_OS_REQUIRE_BROWSER: "1" } : {}) },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
