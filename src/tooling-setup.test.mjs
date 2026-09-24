import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { stageRealPackageInstall } from "./package-install-fixture.mjs";
import { setupArguments, setupTooling, setupTextLines } from "./tooling-setup.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const SOURCES = { "CLAUDE.md": "claude/CLAUDE.md", "AGENTS.md": "codex/AGENTS.md", "campaigns-os.mdc": "cursor/campaigns-os.mdc", "copilot-instructions.md": "copilot/copilot-instructions.md" };
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };

test("local setup install pins match the package version", () => {
  const doc = readFileSync(join(ROOT, "docs/local-setup.md"), "utf8");
  const pins = [...doc.matchAll(/@nextcommerce\/campaigns-os@(\d+\.\d+\.\d+)/g)];
  assert.ok(pins.length > 0, "local setup must document an exact toolkit install pin");
  for (const [, version] of pins) assert.equal(version, PKG.version, "docs/local-setup.md toolkit install pin must match package.json");
});

function fixture(t, real = false) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-setup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "campaign");
  const packageRoot = real ? stageRealPackageInstall(target) : join(target, "node_modules/@nextcommerce/campaigns-os");
  if (!real) {
    writeJson(join(packageRoot, "package.json"), PKG);
    cpSync(join(ROOT, "agents"), join(packageRoot, "agents"), { recursive: true });
    cpSync(join(ROOT, "skills.json"), join(packageRoot, "skills.json"));
  }
  writeJson(join(target, "package.json"), { devDependencies: { "@nextcommerce/campaigns-os": PKG.version, "next-campaign-page-kit": "0.2.0" } });
  writeJson(join(target, "package-lock.json"), { lockfileVersion: 3, packages: { "node_modules/@nextcommerce/campaigns-os": { version: PKG.version } } });
  writeJson(join(target, "node_modules/next-campaign-page-kit/package.json"), { name: "next-campaign-page-kit", version: "0.2.0" });
  writeFileSync(join(target, "CLAUDE.md"), "# Custom instructions\nPreserve the existing campaign.\n");
  mkdirSync(join(target, "src"));
  writeFileSync(join(target, "src", "checkout.html"), "authored checkout");
  const calls = [];
  const deps = {
    packageRoot,
    installSkills: (...args) => { calls.push(["skills", ...args]); return { ok: true }; },
    installAgentContext: (path, dryRun) => {
      calls.push(["context", path, dryRun]);
      if (!dryRun) for (const [name, src] of Object.entries(SOURCES)) {
        const dest = join(path, ".campaign-runtime/agent-context", name);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(join(packageRoot, "agents", src), dest);
      }
      return { ok: true };
    },
    installBrowser: () => { calls.push(["browser"]); return { ok: true, status: "installed" }; },
  };
  return { dir, target, packageRoot, calls, deps, args: { target, platform: "claude" } };
}

test("setup preserves authored pages and instructions across reruns and requires a session restart", (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.target, "CLAUDE.md"), "utf8");
  const first = setupTooling(f.args, f.deps);
  assert.equal(first.status, "restart_required");
  assert.match(first.next_action, /--skills-revision/);
  assert.match(first.note, /does not.*prove/);
  const instructions = readFileSync(join(f.target, "CLAUDE.md"), "utf8");
  assert.ok(instructions.startsWith(before));
  assert.equal(instructions.split("@.campaign-runtime/agent-context/CLAUDE.md").length, 2);
  setupTooling(f.args, f.deps);
  assert.equal(readFileSync(join(f.target, "CLAUDE.md"), "utf8"), instructions);
  assert.equal(readFileSync(join(f.target, "src/checkout.html"), "utf8"), "authored checkout");
});

test("setup dry run does not connect context or download the browser", (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.target, "CLAUDE.md"), "utf8");
  const result = setupTooling({ ...f.args, "dry-run": true }, f.deps);
  assert.equal(result.status, "dry_run");
  assert.match(result.next_action, /without --dry-run/);
  assert.deepEqual(f.calls.map((c) => c[0]), ["skills", "context"]);
  assert.equal(f.calls[0][2], true);
  assert.equal(f.calls[1][2], true);
  assert.equal(existsSync(join(f.target, ".campaign-runtime")), false);
  assert.equal(readFileSync(join(f.target, "CLAUDE.md"), "utf8"), before);
});

test("setup connects an active import when an existing one is only a Markdown example", (t) => {
  for (const example of ["```md\n@.campaign-runtime/agent-context/CLAUDE.md\n```", "~~~\n@.campaign-runtime/agent-context/CLAUDE.md\n~~~", "    @.campaign-runtime/agent-context/CLAUDE.md"]) {
    const f = fixture(t);
    writeFileSync(join(f.target, "CLAUDE.md"), `${example}\n`);
    setupTooling(f.args, f.deps);
    assert.equal(readFileSync(join(f.target, "CLAUDE.md"), "utf8"), `${example}\n\n@.campaign-runtime/agent-context/CLAUDE.md\n`);
  }
  const f = fixture(t);
  writeFileSync(join(f.target, "CLAUDE.md"), "```md\nunfinished example\n");
  assert.throws(() => setupTooling(f.args, f.deps), /unterminated code fence/);
  assert.deepEqual(f.calls, []);
});

test("setup reports a skipped runtime ignore block as incomplete with a recovery action", (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.target, "CLAUDE.md"), "utf8");
  const result = setupTooling(f.args, { ...f.deps, installAgentContext: () => ({ ok: true, gitignore: { action: "skipped", reason: "unwritable: EACCES" } }) });
  assert.equal(result.ok, false);
  assert.equal(result.status, "context_install_failed");
  assert.equal(result.instructions.action, "not_run");
  assert.match(setupTextLines(result).join("\n"), /EACCES.*Fix .gitignore/);
  assert.equal(readFileSync(join(f.target, "CLAUDE.md"), "utf8"), before);
});

test("setup refuses conflicting pins, missing page-kit and edited context before installing anything", (t) => {
  for (const kind of ["pin", "page-kit", "context"]) {
    const f = fixture(t);
    if (kind === "pin") writeJson(join(f.target, "package.json"), { devDependencies: { "@nextcommerce/campaigns-os": "0.0.1" } });
    if (kind === "page-kit") rmSync(join(f.target, "node_modules/next-campaign-page-kit"), { recursive: true });
    if (kind === "context") {
      const path = join(f.target, ".campaign-runtime/agent-context/CLAUDE.md");
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "authored context");
    }
    assert.throws(() => setupTooling(f.args, f.deps), /pin|not installed|differs from/);
    assert.deepEqual(f.calls, []);
  }
});

test("missing project files give recovery guidance without prescribing a replacement page-kit version", (t) => {
  for (const name of ["package.json", "package-lock.json"]) {
    const f = fixture(t);
    const manifest = readFileSync(join(f.target, "package.json"), "utf8");
    rmSync(join(f.target, name));
    assert.throws(() => setupTooling(f.args, f.deps), (error) => {
      assert.match(error.message, name === "package.json" ? /docs[/\\]local-setup\.md/ : /existing dependency pins/);
      assert.doesNotMatch(error.message, /next-campaign-page-kit@/);
      return true;
    });
    assert.deepEqual(f.calls, []);
    if (name === "package-lock.json") assert.equal(readFileSync(join(f.target, "package.json"), "utf8"), manifest);
  }
});

test("setup refuses a file where any context parent directory should be before installing anything", (t) => {
  for (const name of [".campaign-runtime", ".campaign-runtime/agent-context"]) {
    const f = fixture(t);
    const obstruction = join(f.target, name);
    mkdirSync(dirname(obstruction), { recursive: true });
    writeFileSync(obstruction, "existing file");
    assert.throws(() => setupTooling(f.args, f.deps), /expected a regular directory/);
    assert.deepEqual(f.calls, []);
    assert.equal(readFileSync(obstruction, "utf8"), "existing file");
  }
});

test("setup refuses symlink destinations, including dangling links, and leaves external files unchanged", (t) => {
  for (const name of ["CLAUDE.md", ".campaign-runtime", ".campaign-runtime/agent-context", "dangling"]) {
    const f = fixture(t);
    const outside = join(f.dir, "outside");
    if (name === "CLAUDE.md") writeFileSync(outside, "external instructions");
    else if (name !== "dangling") mkdirSync(outside);
    const destination = join(f.target, name === "dangling" ? ".campaign-runtime" : name);
    mkdirSync(dirname(destination), { recursive: true });
    rmSync(destination, { recursive: true, force: true });
    symlinkSync(outside, destination);
    assert.throws(() => setupTooling(f.args, f.deps), /symlink/);
    assert.deepEqual(f.calls, []);
    if (name === "CLAUDE.md") assert.equal(readFileSync(outside, "utf8"), "external instructions");
  }
});

test("browser install failure is recoverable and never reports setup complete", (t) => {
  const f = fixture(t);
  const failed = setupTooling(f.args, { ...f.deps, installBrowser: () => ({ ok: false, status: "playwright_missing", note: "Install optional Playwright dependencies before retrying." }) });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, "browser_install_failed");
  assert.match(setupTextLines(failed).join("\n"), /Install optional Playwright dependencies/);
  assert.deepEqual(f.calls, []);
  assert.equal(existsSync(join(f.target, ".campaign-runtime")), false);
  assert.equal(setupTooling(f.args, f.deps).status, "restart_required");
});

test("packaged setup composes the real skills and context installers with recoverable reruns", (t) => {
  const f = fixture(t, true);
  const home = join(f.dir, "home"); mkdirSync(home);
  const journal = join(f.dir, "lifecycle.jsonl");
  // Only the browser download is stubbed. Everything written by the skills,
  // context and instruction installers is exercised through the packaged CLI.
  const stub = `import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    cp.spawnSync = (command, args) => {
      if (args[0].endsWith('/playwright/cli.js') && args[1] === 'install' && args[2] === 'chromium') return { status: 0 };
      throw new Error('Unexpected setup subprocess');
    };
    syncBuiltinESMExports();`;
  const run = () => spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, join(f.packageRoot, "bin/campaigns-os.mjs"), "tooling", "setup", "--target", f.target, "--json"], {
    cwd: f.target, encoding: "utf8", env: { ...process.env, HOME: home, CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
  });
  writeFileSync(join(f.target, ".gitignore"), "# User ignores\ncustom-output/\n");
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.status, "restart_required");
  for (const skill of result.skills.skills) assert.equal(readFileSync(skill.destination, "utf8"), readFileSync(skill.source, "utf8"));
  for (const [name, src] of Object.entries(SOURCES)) {
    assert.equal(readFileSync(join(f.target, ".campaign-runtime/agent-context", name), "utf8"), readFileSync(join(f.packageRoot, "agents", src), "utf8"));
  }
  const instructions = readFileSync(join(f.target, "CLAUDE.md"), "utf8");
  const ignores = readFileSync(join(f.target, ".gitignore"), "utf8");
  assert.ok(ignores.startsWith("# User ignores\ncustom-output/\n"));
  assert.notEqual(ignores, "# User ignores\ncustom-output/\n");
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.ok(JSON.parse(second.stdout).skills.skills.every((skill) => skill.action === "unchanged"));
  assert.equal(readFileSync(join(f.target, "CLAUDE.md"), "utf8"), instructions);
  assert.equal(readFileSync(join(f.target, ".gitignore"), "utf8"), ignores);
  assert.equal(readFileSync(join(f.target, "src/checkout.html"), "utf8"), "authored checkout");
  assert.equal(existsSync(journal), false);
});

test("setup refuses ambiguous, unsupported and effect-widening argv", () => {
  for (const extra of [["--force"], ["--dry-run", "false"], ["--target", "another"], ["--json", "--json"], ["--platform", "cursor"]]) {
    const args = { target: ".", ...(extra[0] === "--platform" ? { platform: extra[1] } : {}) };
    assert.throws(() => setupArguments(args, ["tooling", "setup", "--target", ".", ...extra]));
  }
});

test("packaged setup dry run creates no campaign runtime, global skills or lifecycle journal", (t) => {
  const f = fixture(t, true);
  const journal = join(f.dir, "lifecycle.jsonl");
  const home = join(f.dir, "home"); mkdirSync(home);
  const run = spawnSync(process.execPath, [join(f.packageRoot, "bin/campaigns-os.mjs"), "tooling", "setup", "--target", f.target, "--dry-run", "--json"], {
    cwd: f.target, encoding: "utf8", env: { ...process.env, HOME: home, CAMPAIGNS_OS_LIFECYCLE_LOG: journal },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).status, "dry_run");
  assert.equal(existsSync(journal), false);
  assert.equal(existsSync(join(f.target, ".campaign-runtime")), false);
  assert.equal(existsSync(join(home, ".claude")), false);
});
