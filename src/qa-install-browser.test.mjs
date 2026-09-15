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
