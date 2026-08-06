/**
 * install-skills retired-skill sweep — end-to-end through the public CLI.
 *
 * The install copy loop is additive: it never deletes a destination dir absent
 * from source, so the 2026-08 rename (next-campaigns-setup ->
 * next-campaigns-os-setup) would strand the OLD skill in every shared skill
 * directory forever, and the renamed-away slot would never be released to the
 * published scaffolder. skills.json retired_skills records fix that: install
 * removes OUR stale copy (frontmatter name + description prefix match) and
 * leaves anything else wearing the name untouched.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

const RETIRED_ID = "next-campaigns-setup";
const OUR_OLD_SKILL = `---
name: ${RETIRED_ID}
description: Bootstrap or prepare a target page-kit campaign repo from a doctor-cleared Campaigns OS Build Packet before full build wiring.
---

# Old retired body
`;
const FOREIGN_SKILL = `---
name: ${RETIRED_ID}
description: Scaffold a campaign repo from a slug via campaign-init --non-interactive.
---

# The published scaffolder — NOT ours
`;

function runInstall(target, extraArgs = []) {
  const out = execFileSync(
    "node",
    [CLI, "install-skills", "--platform", "claude", "--target", target, "--json", ...extraArgs],
    { encoding: "utf8" },
  );
  return JSON.parse(out);
}

function seedTarget(skillText) {
  const target = mkdtempSync(join(tmpdir(), "campaigns-os-install-test-"));
  const dir = join(target, RETIRED_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillText);
  return target;
}

test("install removes OUR stale retired copy and reports it", () => {
  const target = seedTarget(OUR_OLD_SKILL);
  try {
    const result = runInstall(target);
    const swept = result.skills.find((skill) => skill.name === RETIRED_ID);
    assert.ok(swept, "sweep result missing from skills output");
    assert.equal(swept.action, "retired");
    assert.equal(swept.replaced_by, "next-campaigns-os-setup");
    assert.equal(existsSync(join(target, RETIRED_ID)), false, "stale dir must be removed");
    assert.equal(existsSync(join(target, "next-campaigns-os-setup", "SKILL.md")), true, "renamed skill installs");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("install leaves a DIFFERENT skill wearing the retired name untouched", () => {
  const target = seedTarget(FOREIGN_SKILL);
  try {
    const result = runInstall(target);
    const swept = result.skills.find((skill) => skill.name === RETIRED_ID);
    assert.ok(swept, "occupied slot must still be reported");
    assert.equal(swept.action, "occupied_by_other");
    assert.equal(existsSync(join(target, RETIRED_ID, "SKILL.md")), true, "foreign skill must survive");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("dry run reports the retired sweep without deleting", () => {
  const target = seedTarget(OUR_OLD_SKILL);
  try {
    const result = runInstall(target, ["--dry-run"]);
    const swept = result.skills.find((skill) => skill.name === RETIRED_ID);
    assert.ok(swept);
    assert.equal(swept.action, "retired");
    assert.match(swept.note, /would be removed/);
    assert.equal(existsSync(join(target, RETIRED_ID, "SKILL.md")), true, "dry run must not delete");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("an absent retired slot is not reported at all", () => {
  const target = mkdtempSync(join(tmpdir(), "campaigns-os-install-test-"));
  try {
    const result = runInstall(target);
    assert.equal(
      result.skills.some((skill) => skill.name === RETIRED_ID),
      false,
      "no phantom sweep entries for empty slots",
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
