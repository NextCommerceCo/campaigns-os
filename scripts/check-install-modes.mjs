#!/usr/bin/env node
// Real tarball consumers, separate agent homes, competing PATH installations,
// and optional Playwright absent. No writes to the operator's npm prefix/home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "campaigns-os-install-modes-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const baseEnv = { ...process.env, npm_config_cache: join(scratch, "cache"), npm_config_userconfig: join(scratch, "empty.npmrc"), npm_config_globalconfig: join(scratch, "global.npmrc") };
writeFileSync(baseEnv.npm_config_userconfig, "");
writeFileSync(baseEnv.npm_config_globalconfig, "");
function run(command, args, cwd, env = baseEnv, status = 0) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, status, result.stderr || result.stdout || String(result.error));
  return result.stdout;
}
function json(command, args, cwd, env, status = 0) { return JSON.parse(run(command, args, cwd, env, status)); }

try {
  const pack = json(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], root);
  const tarball = join(scratch, pack[0].filename);
  const project = join(scratch, "campaign");
  const prefix = join(scratch, "global");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "campaign-install-proof", private: true, version: "1.0.0" }));
  run(npm, ["install", "--save-dev", "--save-exact", "--ignore-scripts", "--omit=optional", "--no-audit", "--fund=false", tarball], project);
  run(npm, ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--omit=optional", "--no-audit", "--fund=false", tarball], project);
  const globalBinDir = process.platform === "win32" ? prefix : join(prefix, "bin");
  const globalBin = join(globalBinDir, process.platform === "win32" ? "campaigns-os.cmd" : "campaigns-os");
  const globalScript = join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "@nextcommerce", "campaigns-os", "bin", "campaigns-os.mjs");
  const localScript = join(project, "node_modules", "@nextcommerce", "campaigns-os", "bin", "campaigns-os.mjs");
  // Some npm versions ignore optional omission in global installs. Model a
  // failed optional install explicitly, within this disposable prefix only.
  const globalRequire = createRequire(globalScript);
  for (const optional of ["playwright", "playwright-core"]) {
    try {
      const optionalRoot = dirname(globalRequire.resolve(`${optional}/package.json`));
      assert.ok(realpathSync(optionalRoot).startsWith(`${realpathSync(prefix)}${sep}`));
      rmSync(optionalRoot, { recursive: true, force: true });
    } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
  }
  for (const mode of ["local", "global"]) {
    for (const platform of ["claude", "codex"]) {
      const profileHome = join(scratch, `${mode}-${platform}`);
      mkdirSync(profileHome);
      const env = { ...baseEnv, HOME: profileHome, USERPROFILE: profileHome, PATH: [globalBinDir, dirname(process.execPath), process.env.PATH].join(delimiter) };
      const command = mode === "local" ? npx : globalBin;
      const head = mode === "local" ? ["--no-install", "campaigns-os"] : [];
      const fresh = json(command, [...head, "tooling", "status", "--platform", platform, "--json"], project, env, 2);
      assert.equal(fresh.install.mode, mode === "local" ? "node_modules" : "global");
      assert.equal(fresh.skills.ok, false);
      run(command, [...head, "install-skills", "--platform", platform, "--json"], project, env);
      const ready = json(command, [...head, "tooling", "status", "--platform", platform, "--json"], project, env);
      assert.equal(ready.skills.ok, true);
      assert.equal(ready.cli.invocation_prefix, mode === "local" ? "npx --no-install campaigns-os" : "campaigns-os");
      assert.equal(existsSync(join(profileHome, platform === "claude" ? ".codex" : ".claude")), false);
      assert.equal(existsSync(join(profileHome, ".agents")), false);
      const diagnosis = json(command, [...head, "tooling", "diagnose", "--platform", platform, "--json"], project, env);
      assert.equal(diagnosis.install_mode, mode === "local" ? "node_modules" : "global");
      const absentBrowser = spawnSync(command, [...head, "qa", "install-browser"], { cwd: project, env, encoding: "utf8", timeout: 30_000 });
      assert.notEqual(absentBrowser.status, 0);
      assert.match(absentBrowser.stderr + absentBrowser.stdout, /optional dependency.*not installed/s);
      console.log(JSON.stringify({ mode, platform, first_preflight: fresh.status, after_skills: ready.status, optional_playwright: "absent_and_actionable" }));
    }
  }
  const shadowEnv = { ...baseEnv, PATH: [join(project, "node_modules", ".bin"), globalBinDir, dirname(process.execPath), process.env.PATH].join(delimiter) };
  const shadowed = json(process.execPath, [globalScript, "tooling", "status", "--target", join(scratch, "empty-skills"), "--json"], project, shadowEnv, 2);
  assert.equal(shadowed.install.mode, "global");
  assert.equal(shadowed.cli.global_binary.status, "found_other_install");
  assert.match(shadowed.cli.invocation_prefix, /^node /);
  const invocationResult = spawnSync(`${shadowed.cli.invocation_prefix} tooling diagnose --json`, { cwd: project, env: shadowEnv, shell: true, encoding: "utf8" });
  assert.equal(invocationResult.status, 0, invocationResult.stderr);
  assert.equal(JSON.parse(invocationResult.stdout).install_mode, "global");
  const local = json(process.execPath, [localScript, "tooling", "diagnose", "--json"], project, { ...baseEnv, PATH: [globalBinDir, process.env.PATH].join(delimiter) });
  assert.equal(local.install_mode, "node_modules");
  console.log("Install-mode checks passed: local/global x Claude/Codex, optional package absent, competing PATH copies.");
} finally { rmSync(scratch, { recursive: true, force: true }); }
