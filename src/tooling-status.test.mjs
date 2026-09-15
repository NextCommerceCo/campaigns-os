import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import * as cliModule from "./cli.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const RETIRED_ID = "next-campaigns-setup";

const OUR_RETIRED_SKILL = `---
name: ${RETIRED_ID}
description: Bootstrap or prepare a target page-kit campaign repo from a doctor-cleared Campaigns OS Build Packet before full build wiring.
---

# Retired Campaigns OS skill
`;

const FOREIGN_SKILL = `---
name: ${RETIRED_ID}
description: Scaffold a campaign repo from a slug via campaign-init --non-interactive.
---

# Published page-kit scaffolder
`;

function runCli(args) {
  const run = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const stdout = run.stdout.trim();
  return {
    ...run,
    json: stdout.startsWith("{") ? JSON.parse(stdout) : null,
  };
}

function installCurrentSkills(target) {
  const run = runCli(["install-skills", "--target", target, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  return run.json;
}

function toolingStatus(target, json = true) {
  return runCli(["tooling", "status", "--target", target, ...(json ? ["--json"] : [])]);
}

function seedSkill(target, name, content) {
  const skillDir = join(target, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content);
}

function snapshotTree(root) {
  const snapshot = {};

  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        snapshot[relative(root, path)] = readFileSync(path, "utf8");
      }
    }
  }

  if (statSync(root).isDirectory()) walk(root);
  return snapshot;
}

test("tooling skill actions have an explicit actionable and warning-only vocabulary", () => {
  assert.equal(typeof cliModule.classifyToolingSkillActions, "function");

  const classified = cliModule.classifyToolingSkillActions([
    { name: "missing", action: "created" },
    { name: "stale", action: "updated" },
    { name: "current", action: "unchanged" },
    { name: "old-name", action: "retired" },
    { name: "foreign-owner", action: "occupied_by_other" },
    { name: "future-state", action: "future_action" },
  ]);

  assert.deepEqual(classified.actionable.map((skill) => skill.action), ["created", "updated", "retired"]);
  assert.deepEqual(classified.warnings.map((skill) => skill.action), ["occupied_by_other", "future_action"]);
});

test("an occupied retired slot is warning-only and tooling status remains ready", () => {
  const target = mkdtempSync(join(tmpdir(), "campaigns-os-tooling-occupied-"));
  try {
    installCurrentSkills(target);
    seedSkill(target, RETIRED_ID, FOREIGN_SKILL);
    const before = snapshotTree(target);

    const run = toolingStatus(target);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.json.ok, true);
    assert.equal(run.json.status, "ready");
    assert.equal(run.json.skills.ok, true);
    assert.equal(run.json.skills.stale_count, 0);
    assert.equal(
      run.json.skills.status.skills.find((skill) => skill.name === RETIRED_ID)?.action,
      "occupied_by_other",
    );
    assert.equal(run.json.actions.some((action) => action.includes("install-skills")), false);
    assert.ok(run.json.warnings.some((warning) => warning.includes(RETIRED_ID) && warning.includes("No Campaigns OS refresh is required")));

    const human = toolingStatus(target, false);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /Status: READY/);
    assert.match(human.stdout, /Warnings:/);
    assert.match(human.stdout, /next-campaigns-setup/);
    assert.match(human.stdout, /No Campaigns OS refresh is required/);
    assert.deepEqual(snapshotTree(target), before, "tooling status must not change the custom skills target");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("a stale bundled skill remains actionable without tooling status mutating it", () => {
  const target = mkdtempSync(join(tmpdir(), "campaigns-os-tooling-stale-"));
  try {
    installCurrentSkills(target);
    const stalePath = join(target, "next-campaigns-build", "SKILL.md");
    writeFileSync(stalePath, "stale bundled skill\n");
    const before = snapshotTree(target);

    const run = toolingStatus(target);
    assert.equal(run.status, 2);
    assert.equal(run.json.ok, false);
    assert.equal(run.json.status, "attention_required");
    assert.equal(run.json.skills.ok, false);
    assert.equal(run.json.skills.stale_count, 1);
    assert.equal(
      run.json.skills.status.skills.find((skill) => skill.name === "next-campaigns-build")?.action,
      "updated",
    );
    assert.ok(run.json.actions.some((action) => action.includes("install-skills --target")));
    assert.deepEqual(snapshotTree(target), before, "tooling status must only inspect a stale target");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("an occupied slot warning stays scoped when another skill needs refresh", () => {
  const target = mkdtempSync(join(tmpdir(), "campaigns-os-tooling-mixed-"));
  try {
    installCurrentSkills(target);
    seedSkill(target, RETIRED_ID, FOREIGN_SKILL);
    writeFileSync(join(target, "next-campaigns-build", "SKILL.md"), "stale bundled skill\n");
    const before = snapshotTree(target);

    const run = toolingStatus(target);
    assert.equal(run.status, 2);
    assert.equal(run.json.status, "attention_required");
    assert.equal(run.json.skills.stale_count, 1);
    assert.ok(run.json.actions.some((action) => action.includes("install-skills --target")));
    assert.ok(
      run.json.warnings.some((warning) =>
        warning.includes(RETIRED_ID) && warning.includes("No Campaigns OS refresh is required for this slot")),
    );
    assert.deepEqual(snapshotTree(target), before, "mixed-state tooling status must remain read-only");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("a removable retired Campaigns OS skill remains actionable", () => {
  const target = mkdtempSync(join(tmpdir(), "campaigns-os-tooling-retired-"));
  try {
    installCurrentSkills(target);
    seedSkill(target, RETIRED_ID, OUR_RETIRED_SKILL);
    const before = snapshotTree(target);

    const run = toolingStatus(target);
    assert.equal(run.status, 2);
    assert.equal(run.json.skills.stale_count, 1);
    assert.equal(
      run.json.skills.status.skills.find((skill) => skill.name === RETIRED_ID)?.action,
      "retired",
    );
    assert.ok(run.json.actions.some((action) => action.includes("install-skills --target")));
    assert.deepEqual(snapshotTree(target), before, "dry-run retirement must leave the target intact");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Install mode: a package install (npx cache, a consumer's node_modules) is a
// supported way to run the toolkit, not a broken checkout. `tooling status`
// must name it, derive the pinned commit npm recorded, and never report an
// enclosing repository that is not this toolkit's as the toolkit's own git
// state.
// ---------------------------------------------------------------------------

const PIN_SHA = "236d7fc454c877e3c07337237ee9e19303c5cc15";

function writeFakePackageInstall(installRoot, { lockfile = "hidden", resolved, gitHead } = {}) {
  const pkgRoot = join(installRoot, "node_modules", "@nextcommerce", "campaigns-os");
  mkdirSync(pkgRoot, { recursive: true });
  const pkg = { name: "@nextcommerce/campaigns-os", version: "0.1.0-alpha.0" };
  if (gitHead) pkg.gitHead = gitHead;
  writeFileSync(join(pkgRoot, "package.json"), JSON.stringify(pkg));
  const lock = {
    name: "npx",
    lockfileVersion: 3,
    packages: {
      "node_modules/@nextcommerce/campaigns-os": {
        version: "0.1.0-alpha.0",
        ...(resolved ? { resolved } : {}),
      },
    },
  };
  if (lockfile === "hidden") {
    writeFileSync(join(installRoot, "node_modules", ".package-lock.json"), JSON.stringify(lock));
  } else if (lockfile === "root") {
    writeFileSync(join(installRoot, "package-lock.json"), JSON.stringify(lock));
  }
  return pkgRoot;
}

test("derivePackagePin reads the resolved git sha npm recorded for a package install", () => {
  const installRoot = mkdtempSync(join(tmpdir(), "campaigns-os-pin-"));
  try {
    const pkgRoot = writeFakePackageInstall(installRoot, {
      resolved: `git+ssh://git@github.com/NextCommerceCo/campaigns-os.git#${PIN_SHA}`,
    });
    const pin = cliModule.derivePackagePin(pkgRoot, JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")));
    assert.equal(pin.commit, PIN_SHA);
    assert.equal(pin.version, "0.1.0-alpha.0");
    assert.equal(pin.spec, `github:NextCommerceCo/campaigns-os#${PIN_SHA.slice(0, 12)}`);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test("derivePackagePin falls back to package-lock.json, then gitHead, and reports null when nothing is recorded", () => {
  const fromRootLock = mkdtempSync(join(tmpdir(), "campaigns-os-pin-root-"));
  const fromGitHead = mkdtempSync(join(tmpdir(), "campaigns-os-pin-githead-"));
  const nothing = mkdtempSync(join(tmpdir(), "campaigns-os-pin-none-"));
  try {
    const rootLockPkg = writeFakePackageInstall(fromRootLock, {
      lockfile: "root",
      resolved: `git+https://github.com/NextCommerceCo/campaigns-os.git#${PIN_SHA}`,
    });
    assert.equal(cliModule.derivePackagePin(rootLockPkg, {}).commit, PIN_SHA);

    const gitHeadPkg = writeFakePackageInstall(fromGitHead, { lockfile: "none", gitHead: PIN_SHA });
    const gitHeadPin = cliModule.derivePackagePin(gitHeadPkg, JSON.parse(readFileSync(join(gitHeadPkg, "package.json"), "utf8")));
    assert.equal(gitHeadPin.commit, PIN_SHA);
    assert.equal(gitHeadPin.spec, `github:NextCommerceCo/campaigns-os#${PIN_SHA.slice(0, 12)}`);

    // A registry-shaped resolved URL carries no commit: honest null, not a guess.
    const nothingPkg = writeFakePackageInstall(nothing, {
      resolved: "https://registry.npmjs.org/@nextcommerce/campaigns-os/-/campaigns-os-0.1.0-alpha.0.tgz",
    });
    assert.equal(cliModule.derivePackagePin(nothingPkg, {}), null);
  } finally {
    for (const dir of [fromRootLock, fromGitHead, nothing]) rmSync(dir, { recursive: true, force: true });
  }
});

test("localInstallStatus classifies an npx cache, a consumer node_modules, and this checkout", () => {
  const npxRoot = mkdtempSync(join(tmpdir(), "campaigns-os-mode-"));
  try {
    // npx lays the package out under <cache>/_npx/<hash>/node_modules/.
    const npxInstall = join(npxRoot, "_npx", "0123abcd");
    const npxPkg = writeFakePackageInstall(npxInstall, {
      resolved: `git+ssh://git@github.com/NextCommerceCo/campaigns-os.git#${PIN_SHA}`,
    });
    const npx = cliModule.localInstallStatus(npxPkg, { version: "0.1.0-alpha.0" });
    assert.equal(npx.mode, "npx_cache");
    assert.equal(npx.pinned.commit, PIN_SHA);
    assert.match(npx.summary, /package install \(npx cache\), pinned at 0\.1\.0-alpha\.0 @ 236d7fc454c8/);

    const consumerPkg = writeFakePackageInstall(join(npxRoot, "consumer"), { lockfile: "none" });
    const consumer = cliModule.localInstallStatus(consumerPkg, { version: "0.1.0-alpha.0" });
    assert.equal(consumer.mode, "node_modules");
    assert.equal(consumer.pinned, null);
    assert.match(consumer.summary, /pinned commit not derivable/);

    const checkout = cliModule.localInstallStatus(ROOT, { version: "0.1.0-alpha.0" });
    assert.equal(checkout.mode, "checkout");
    assert.equal(checkout.pinned, null);
  } finally {
    rmSync(npxRoot, { recursive: true, force: true });
  }
});

test("a package directory inside someone else's git repository is a package install, not a checkout", () => {
  const outer = mkdtempSync(join(tmpdir(), "campaigns-os-outer-repo-"));
  try {
    // The enclosing repository (a consumer project, a dotfiles-managed home)
    // is not this toolkit's checkout; `git -C <pkg>` would answer for it.
    const init = spawnSync("git", ["-C", outer, "init", "-q"], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const pkgRoot = writeFakePackageInstall(outer, {
      resolved: `git+ssh://git@github.com/NextCommerceCo/campaigns-os.git#${PIN_SHA}`,
    });
    const status = cliModule.localInstallStatus(pkgRoot, { version: "0.1.0-alpha.0" });
    assert.equal(status.mode, "node_modules");
    assert.equal(status.pinned.commit, PIN_SHA);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

// Lay the real package out the way npm does (`<install>/node_modules/@nextcommerce/campaigns-os`)
// with its dependencies reachable, so the spawned CLI runs in package mode.
function stageRealPackageInstall(installRoot) {
  const pkgRoot = join(installRoot, "node_modules", "@nextcommerce", "campaigns-os");
  mkdirSync(pkgRoot, { recursive: true });
  for (const entry of ["bin", "src", "campaign-spec", "contracts", "schemas", "skills", "skills.json", "package.json"]) {
    cpSync(join(ROOT, entry), join(pkgRoot, entry), { recursive: true, dereference: true });
  }
  symlinkSync(join(ROOT, "node_modules"), join(pkgRoot, "node_modules"), "dir");
  writeFileSync(join(installRoot, "node_modules", ".package-lock.json"), JSON.stringify({
    name: "npx",
    lockfileVersion: 3,
    packages: {
      "node_modules/@nextcommerce/campaigns-os": {
        version: "0.1.0-alpha.0",
        resolved: `git+ssh://git@github.com/NextCommerceCo/campaigns-os.git#${PIN_SHA}`,
      },
    },
  }));
  return pkgRoot;
}

test("tooling status from a package install is ready, names the pin, and gives package-mode commands", () => {
  // realpath: node resolves the main module through symlinks (macOS /var -> /private/var),
  // and the reported bin_dir follows that resolved root.
  const installRoot = realpathSync(mkdtempSync(join(tmpdir(), "campaigns-os-pkg-e2e-")));
  const target = mkdtempSync(join(tmpdir(), "campaigns-os-pkg-e2e-skills-"));
  try {
    const pkgRoot = stageRealPackageInstall(installRoot);
    const pkgCli = join(pkgRoot, "bin", "campaigns-os.mjs");
    installCurrentSkills(target);

    // The leading `campaigns-os` token is what `npx --yes <spec> campaigns-os
    // tooling status` hands the bin; it is the program name, not a command.
    const run = spawnSync(process.execPath, [pkgCli, "campaigns-os", "tooling", "status", "--target", target, "--json"], {
      cwd: installRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });
    assert.equal(run.status, 0, run.stderr);
    const json = JSON.parse(run.stdout);
    assert.equal(json.ok, true);
    assert.equal(json.status, "ready");
    assert.equal(json.install.mode, "node_modules");
    assert.equal(json.install.pinned.commit, PIN_SHA);
    assert.equal(json.git.status, "not_applicable");
    assert.equal(json.git.head, PIN_SHA);
    assert.equal(json.package.registry.status, "not_applicable_package_install");
    // A tools-folder install runs the bare binary from node_modules/.bin.
    assert.equal(json.cli.invocation, "campaigns-os <command>");
    assert.equal(json.cli.bin_dir, join(installRoot, "node_modules", ".bin"));
    assert.ok(json.ready.some((line) => line.includes("package install (node_modules), pinned at 0.1.0-alpha.0 @ 236d7fc454c8")));
    // No checkout-only noise: no "Git freshness unavailable", no "use npm run campaigns-os".
    assert.equal(json.warnings.some((warning) => /Git freshness unavailable|npm run campaigns-os/.test(warning)), false);
    // PATH was scrubbed above, so the one useful warning is the PATH hint.
    assert.ok(json.warnings.some((warning) => warning.includes(`export PATH="${join(installRoot, "node_modules", ".bin")}:$PATH"`)));
    assert.deepEqual(json.actions, []);

    // A stale skill still surfaces, and the repair command is the package-mode one.
    writeFileSync(join(target, "next-campaigns-build", "SKILL.md"), "stale bundled skill\n");
    const stale = spawnSync(process.execPath, [pkgCli, "tooling", "status", "--target", target, "--json"], {
      cwd: installRoot,
      encoding: "utf8",
    });
    assert.equal(stale.status, 2);
    const staleJson = JSON.parse(stale.stdout);
    assert.ok(staleJson.actions.some((action) =>
      action.startsWith("Refresh installed skills: campaigns-os install-skills --target")));

    const human = spawnSync(process.execPath, [pkgCli, "tooling", "status", "--target", target], {
      cwd: installRoot,
      encoding: "utf8",
    });
    assert.match(human.stdout, /Install mode: package install \(node_modules\), pinned at 0\.1\.0-alpha\.0 @ 236d7fc454c8\./);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("a leading campaigns-os token is the program name for every command", () => {
  const withToken = runCli(["campaigns-os", "install-skills", "--target", join(tmpdir(), "campaigns-os-never-written"), "--dry-run", "--json"]);
  assert.equal(withToken.status, 0, withToken.stderr);
  assert.equal(withToken.json.status, "dry_run");
  const help = runCli(["campaigns-os"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:/);
});

test("derivePackagePin finds a nested dependency's pin in the project lockfile", () => {
  const project = mkdtempSync(join(tmpdir(), "campaigns-os-pin-nested-"));
  try {
    const nested = join(project, "node_modules", "consumer", "node_modules", "@nextcommerce", "campaigns-os");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "@nextcommerce/campaigns-os", version: "0.1.0-alpha.0" }));
    writeFileSync(join(project, "package-lock.json"), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/consumer": { version: "1.0.0" },
        "node_modules/consumer/node_modules/@nextcommerce/campaigns-os": {
          version: "0.1.0-alpha.0",
          resolved: `git+https://github.com/NextCommerceCo/campaigns-os.git#${PIN_SHA}`,
        },
      },
    }));
    assert.equal(cliModule.derivePackagePin(nested, {})?.commit, PIN_SHA);
    assert.equal(cliModule.localInstallStatus(nested, {}).pinned.commit, PIN_SHA);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("tooling status warns when the campaigns-os on PATH is a different install from the one inspected", () => {
  const installRoot = realpathSync(mkdtempSync(join(tmpdir(), "campaigns-os-pkg-other-")));
  const other = realpathSync(mkdtempSync(join(tmpdir(), "campaigns-os-other-bin-")));
  const target = mkdtempSync(join(tmpdir(), "campaigns-os-pkg-other-skills-"));
  try {
    const pkgRoot = stageRealPackageInstall(installRoot);
    installCurrentSkills(target);
    // Another install's executable, earlier on PATH.
    const foreignBin = join(other, "campaigns-os");
    writeFileSync(foreignBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const mismatch = spawnSync(process.execPath, [join(pkgRoot, "bin", "campaigns-os.mjs"), "tooling", "status", "--target", target, "--json"], {
      cwd: installRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${other}:/usr/bin:/bin` },
    });
    assert.equal(mismatch.status, 0, mismatch.stderr);
    const json = JSON.parse(mismatch.stdout);
    assert.equal(json.cli.global_binary.status, "found_other_install");
    assert.equal(json.cli.global_binary.path, foreignBin);
    assert.ok(json.warnings.some((warning) =>
      warning.includes("is a different install from the one inspected here")
      && warning.includes(`export PATH="${join(installRoot, "node_modules", ".bin")}:$PATH"`)));

    // The same install's own .bin first on PATH: found, no warning.
    const binDir = join(installRoot, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(join(pkgRoot, "bin", "campaigns-os.mjs"), join(binDir, "campaigns-os"));
    const match = spawnSync(process.execPath, [join(pkgRoot, "bin", "campaigns-os.mjs"), "tooling", "status", "--target", target, "--json"], {
      cwd: installRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${other}:/usr/bin:/bin` },
    });
    const matched = JSON.parse(match.stdout);
    assert.equal(matched.cli.global_binary.status, "found");
    assert.equal(matched.cli.global_binary.matches_local_bin, true);
    assert.equal(matched.warnings.some((warning) => /different install|not on PATH/.test(warning)), false);
  } finally {
    for (const dir of [installRoot, other, target]) rmSync(dir, { recursive: true, force: true });
  }
});
