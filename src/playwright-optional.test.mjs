import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Playwright is an optional dependency of the published package. An install
// without it (`--omit=optional`, or a failed optional install) must still load
// the CLI, and the three surfaces that need it (browser QA, polish capture,
// qa install-browser) must each point at the one shared recovery hint. The
// checkout always has playwright installed, so this builds a shadow of the
// package with every node_modules entry except playwright* and loads the real
// modules from there: the lazy import in browser-launch.mjs and the
// createRequire lookup in qa-node.mjs both really fail, which no in-process
// fake can reproduce.
function shadowWithoutPlaywright(t) {
  const shadow = mkdtempSync(join(tmpdir(), "campaigns-os-no-playwright-"));
  t.after(() => rmSync(shadow, { recursive: true, force: true }));
  for (const entry of readdirSync(ROOT)) {
    if (entry === "node_modules" || entry === "src" || entry === "bin" || entry === ".git") continue;
    symlinkSync(join(ROOT, entry), join(shadow, entry));
  }
  // src and bin are copied, not linked: a symlinked file resolves its imports
  // from its real path back in ROOT and finds the checkout's playwright again.
  cpSync(join(ROOT, "bin"), join(shadow, "bin"), { recursive: true });
  mkdirSync(join(shadow, "src"));
  for (const entry of readdirSync(join(ROOT, "src"))) {
    if (!entry.endsWith(".mjs") || entry.endsWith(".test.mjs")) continue;
    cpSync(join(ROOT, "src", entry), join(shadow, "src", entry));
  }
  mkdirSync(join(shadow, "node_modules"));
  for (const entry of readdirSync(join(ROOT, "node_modules"))) {
    if (entry.startsWith("playwright")) continue;
    symlinkSync(join(ROOT, "node_modules", entry), join(shadow, "node_modules", entry));
  }
  return shadow;
}

function runInShadow(shadow, body) {
  const script = `
    const src = ${JSON.stringify(join(shadow, "src"))};
    ${body}
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: shadow, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

const HINT = /Playwright is an optional dependency and is not installed beside this package\. Install it where campaigns-os is installed \(`npm install playwright` in that project, or `npm install -g playwright` for a global install\), then run `campaigns-os qa install-browser`\./;

test("without playwright, the CLI itself still loads and runs a non-browser command", (t) => {
  const shadow = shadowWithoutPlaywright(t);
  const run = spawnSync(process.execPath, [join(shadow, "bin", "campaigns-os.mjs"), "help"], { cwd: shadow, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Campaigns OS toolkit/);
  assert.doesNotMatch(run.stderr, /playwright/i);
});

test("without playwright, qa install-browser reports playwright_missing with the shared recovery hint and never spawns", (t) => {
  const shadow = shadowWithoutPlaywright(t);
  const result = runInShadow(shadow, `
    const { installQaBrowser } = await import(src + "/qa-node.mjs");
    let spawned = false;
    const result = installQaBrowser({ spawn: () => { spawned = true; return { status: 0 }; } });
    console.log(JSON.stringify({ result, spawned }));
  `);
  assert.equal(result.spawned, false);
  assert.equal(result.result.ok, false);
  assert.equal(result.result.status, "playwright_missing");
  assert.equal(result.result.command, null);
  assert.match(result.result.note, HINT);
});

test("without playwright, polish capture fails with the shared hint, its own rerun command and the original error", (t) => {
  const shadow = shadowWithoutPlaywright(t);
  const result = runInShadow(shadow, `
    const { createPolishBrowserAdapter } = await import(src + "/polish-browser.mjs");
    try {
      await createPolishBrowserAdapter();
      console.log(JSON.stringify({ threw: false }));
    } catch (error) {
      console.log(JSON.stringify({ threw: true, code: error.code, message: error.message }));
    }
  `);
  assert.equal(result.threw, true);
  assert.equal(result.code, "POLISH_BROWSER_UNAVAILABLE");
  assert.match(result.message, /^Playwright is not installed for Campaigns OS polish capture\./);
  assert.match(result.message, HINT);
  assert.match(result.message, /Then rerun `campaigns-os polish capture`\./);
  assert.match(result.message, /Original error: Cannot find package 'playwright'/);
  // The package branch must not borrow the browser branch's install hint.
  assert.doesNotMatch(result.message, /Chromium is not installed/);
});

test("without playwright, browser QA maps the failed import to the shared hint with the original error", (t) => {
  const shadow = shadowWithoutPlaywright(t);
  const result = runInShadow(shadow, `
    const { launchPackageChromium } = await import(src + "/browser-launch.mjs");
    const { __qaBrowserTestHooks } = await import(src + "/qa-browser.mjs");
    try {
      await launchPackageChromium({ onMissing: __qaBrowserTestHooks.qaBrowserMissing });
      console.log(JSON.stringify({ threw: false }));
    } catch (error) {
      console.log(JSON.stringify({ threw: true, message: error.message }));
    }
  `);
  assert.equal(result.threw, true);
  assert.match(result.message, /^Playwright is not installed for Campaigns OS\./);
  assert.match(result.message, HINT);
  assert.match(result.message, /Then rerun QA\./);
  assert.match(result.message, /Original error: Cannot find package 'playwright'/);
});
