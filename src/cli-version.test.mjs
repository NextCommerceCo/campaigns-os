import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "bin/campaigns-os.mjs");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

test("--version and -v print only the package version without campaign runtime state", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "campaigns-os-version-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const target = join(cwd, "target");
  mkdirSync(target);

  for (const flag of ["--version", "-v"]) {
    for (const args of [[flag], [flag, "--target", target]]) {
      const result = spawnSync(process.execPath, [CLI, ...args], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          CAMPAIGNS_OS_LIFECYCLE_LOG: join(target, ".campaign-runtime", "command-lifecycle.jsonl"),
          CAMPAIGNS_OS_TELEMETRY: "off",
        },
      });
      assert.equal(result.status, 0, `${flag}: ${result.stderr}`);
      assert.equal(result.stdout, `${version}\n`, `${flag}: stdout`);
      assert.equal(result.stderr, "", `${flag}: stderr`);
      assert.equal(existsSync(join(cwd, ".campaign-runtime")), false, `${flag}: cwd runtime`);
      assert.equal(existsSync(join(target, ".campaign-runtime")), false, `${flag}: target runtime`);
    }
  }
});

test("version tokens after a command or as flag values follow normal dispatch", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "campaigns-os-version-position-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const target = join(cwd, "target");
  mkdirSync(target);
  const env = {
    ...process.env,
    CAMPAIGNS_OS_LIFECYCLE_LOG: join(target, ".campaign-runtime", "command-lifecycle.jsonl"),
    CAMPAIGNS_OS_TELEMETRY: "off",
  };
  const invoke = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env });

  const help = invoke(["help", "--target", "-v"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Campaigns OS toolkit\n/);
  assert.notEqual(help.stdout, `${version}\n`, "-v is the --target value, not a global flag");

  for (const args of [
    ["version", "--version"],
    ["start", "--target", "-v"],
    ["start", "--target", target, "--version"],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "", `${args.join(" ")}: stdout`);
    assert.match(result.stderr, /campaigns-os:/, `${args.join(" ")}: refusal`);
  }
  assert.equal(existsSync(join(cwd, ".campaign-runtime")), false, "cwd runtime");
  assert.equal(existsSync(join(target, ".campaign-runtime")), false, "target runtime");
});
