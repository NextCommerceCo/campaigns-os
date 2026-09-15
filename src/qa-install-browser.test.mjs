import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { installQaBrowser } from "./qa-node.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

// `campaigns-os qa install-browser` is the browser-install step that works
// from every install mode; `npm run qa:install-browser` only exists inside a
// checkout. It must drive the Playwright CLI bundled with this package, not
// whatever `npx playwright` resolves to on the operator's PATH.

test("qa install-browser runs the package-owned Playwright CLI with install chromium", () => {
  const calls = [];
  const result = installQaBrowser({
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.match(calls[0].args[0], /[\\/]node_modules[\\/]playwright[\\/]cli\.js$/);
  assert.deepEqual(calls[0].args.slice(1), ["install", "chromium"]);
  assert.equal(calls[0].options.stdio, "inherit");
  assert.equal(result.ok, true);
  assert.equal(result.status, "installed");
});

test("qa install-browser reports a non-zero Playwright exit as a failure and says to rerun", () => {
  const result = installQaBrowser({ spawn: () => ({ status: 3 }) });
  assert.equal(result.ok, false);
  assert.equal(result.status, "install_failed");
  assert.equal(result.exit_code, 3);
  assert.match(result.note, /rerun campaigns-os qa install-browser/);
});

test("qa install-browser is dispatched by the CLI and listed in qa help", () => {
  const help = spawnSync(process.execPath, [CLI, "qa", "help"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /campaigns-os qa install-browser/);
  // The unknown-subcommand path must not be what install-browser hits.
  const unknown = spawnSync(process.execPath, [CLI, "qa", "install-browsers"], { cwd: ROOT, encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown qa command: install-browsers/);
});

// The default (non-JSON) output path is the one every printed recovery
// command reaches. It must not go through the QA verdict formatter.
test("qa install-browser prints its own text lines on success and failure without --json", async () => {
  const { runQaCli } = await import("./qa-node.mjs");
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const ok = await withSpawn(() => ({ status: 0 }), () => runQaCli({ _: ["qa", "install-browser"] }));
    assert.equal(ok.ok, true);
    assert.equal(lines[0], "Status: INSTALLED");
    assert.ok(lines.some((line) => line.startsWith("Command: ")));
    assert.ok(lines.some((line) => line.includes("Playwright Chromium is installed")));
    assert.equal(lines.some((line) => /Map ID|funnels|QA resolve/.test(line)), false);

    lines.length = 0;
    const failed = await withSpawn(() => ({ status: 7 }), () => runQaCli({ _: ["qa", "install-browser"] }));
    assert.equal(failed.ok, false);
    assert.equal(lines[0], "Status: INSTALL_FAILED");
    assert.ok(lines.includes("Exit code: 7"));
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  } finally {
    console.log = original;
  }
});

// runQaCli builds installQaBrowser with the real spawnSync; swap the module
// binding for the duration of one call.
async function withSpawn(fake, run) {
  const childProcess = await import("node:child_process");
  const { syncBuiltinESMExports } = await import("node:module");
  const real = childProcess.default.spawnSync;
  childProcess.default.spawnSync = fake;
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    childProcess.default.spawnSync = real;
    syncBuiltinESMExports();
  }
}

test("qa install-browser --json keeps stdout as the result document and routes child progress to stderr", () => {
  // A real child that prints download-style progress on stdout, driven through
  // the CLI so the fd routing is exercised end to end.
  const script = `
    import { installQaBrowser } from ${JSON.stringify(new URL("./qa-node.mjs", import.meta.url).href)};
    import { spawnSync } from "node:child_process";
    const result = installQaBrowser({
      json: true,
      spawn: (_cmd, _args, options) => spawnSync(process.execPath, ["-e", "console.log('Downloading Chromium 1/3...'); console.log('Chromium downloaded')"], options),
    });
    console.log(JSON.stringify(result));
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.ok, true);
  assert.match(run.stderr, /Downloading Chromium 1\/3/);
  assert.doesNotMatch(run.stdout, /Downloading/);

  // Without --json the progress stays on stdout for the operator.
  const plain = spawnSync(process.execPath, ["--input-type=module", "-e", script.replace("json: true,", "json: false,")], { cwd: ROOT, encoding: "utf8" });
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /Downloading Chromium 1\/3/);
});

test("applyInvocationPrefix rewrites only bare command spellings", async () => {
  const { applyInvocationPrefix } = await import("./install-mode.mjs");
  const prefix = "npx campaigns-os";
  assert.equal(applyInvocationPrefix("campaigns-os next --packet p.json", prefix), "npx campaigns-os next --packet p.json");
  assert.equal(applyInvocationPrefix("Run `campaigns-os qa install-browser`, then `campaigns-os polish capture`.", prefix), "Run `npx campaigns-os qa install-browser`, then `npx campaigns-os polish capture`.");
  // Already-prefixed forms, skill names, file names and prose are untouched.
  for (const untouched of ["npx campaigns-os next", "npm run campaigns-os -- next", "next-campaigns-os-setup", "node bin/campaigns-os.mjs next", "campaigns-os is not on PATH", "Campaigns OS next stage"]) {
    assert.equal(applyInvocationPrefix(untouched, prefix), untouched);
  }
  assert.deepEqual(applyInvocationPrefix({ a: ["campaigns-os run end"], b: 1, c: null }, prefix), { a: ["npx campaigns-os run end"], b: 1, c: null });
  assert.equal(applyInvocationPrefix("campaigns-os next", "campaigns-os"), "campaigns-os next");
});
