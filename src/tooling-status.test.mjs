import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
