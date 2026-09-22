// `campaigns-os tooling status --skills-revision <value>`: the skills-bundle
// identity check.
//
// The condition under test is an asymmetry, not a version comparison. A skill's
// text enters an agent's context once and is never re-read; the CLI underneath
// that session can be replaced by an install, an npx cache refresh or a pull.
// Every case here therefore spawns the real CLI, so that "the bundle on disk" is
// literally the manifest the running executable ships — and the old-context case
// runs a SECOND, separately installed copy whose bundle moved after the header
// line was captured, because that is the only way to reproduce the failure
// honestly rather than by stubbing the comparison.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { stageRealPackageInstall } from "./package-install-fixture.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = join(ROOT, "bin", "campaigns-os.mjs");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "skills.json"), "utf8"));
const BUNDLE_REVISION = MANIFEST.bundle_revision;

// The header line every SKILL.md states, read the way an agent reads it: from
// the skill text, not from the manifest.
function headerRevision(skillPath) {
  const line = readFileSync(join(ROOT, skillPath), "utf8")
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith("Bundle revision: "));
  assert.ok(line, `${skillPath} states no bundle revision on its first body line`);
  return line.slice("Bundle revision: ".length).trim();
}

function withTarget(run) {
  // A disposable skills target, so the check never touches the operator's real
  // ~/.claude/skills while `tooling status` probes skill freshness.
  const target = mkdtempSync(join(tmpdir(), "campaigns-os-skills-revision-"));
  try {
    return run(target);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

function status(target, extra = [], options = {}) {
  const run = spawnSync(process.execPath, [options.cli ?? CLI, "tooling", "status", "--target", target, ...extra], {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
  });
  const stdout = run.stdout ?? "";
  return { ...run, stdout, json: stdout.trimStart().startsWith("{") ? JSON.parse(stdout) : null };
}

test("skills-revision: match when the value a skill states is the bundle this CLI ships", () => {
  withTarget((target) => {
    const run = status(target, ["--skills-revision", BUNDLE_REVISION, "--json"]);
    assert.equal(run.json.revision_check, "match", run.stderr);
    assert.equal(run.json.skills_revision.requested, BUNDLE_REVISION);
    assert.equal(run.json.skills_revision.on_disk, BUNDLE_REVISION);
    assert.equal(run.json.skills_revision.spelling, "bundle");

    const text = status(target, ["--skills-revision", BUNDLE_REVISION]);
    assert.match(text.stdout, new RegExp(`^Skills revision: match \\(${BUNDLE_REVISION.replace(/[.+]/g, "\\$&")}\\)$`, "m"));
  });
});

test("skills-revision: mismatch reports the explicit field, names both sides, and exits 2", () => {
  withTarget((target) => {
    const run = status(target, ["--skills-revision", "1.0.0+skills.1", "--json"]);
    // The field, not only the exit code: an agent branching on `revision_check`
    // must not have to infer the answer from a status that many other
    // conditions can also turn non-zero.
    assert.equal(run.json.revision_check, "mismatch");
    assert.equal(run.json.skills_revision.requested, "1.0.0+skills.1");
    assert.equal(run.json.skills_revision.on_disk, BUNDLE_REVISION);
    assert.equal(run.status, 2, "a mismatch must not exit 0");
    // Printed in full first: the mismatch is a header on the status, not a
    // replacement for it.
    assert.match(run.stdout, /"install"/);
    assert.match(run.stdout, /"gateway_login"/);

    const text = status(target, ["--skills-revision", "1.0.0+skills.1"]);
    assert.equal(text.status, 2);
    assert.match(
      text.stdout,
      new RegExp(`^Skills revision: mismatch: loaded 1\\.0\\.0\\+skills\\.1, on disk ${BUNDLE_REVISION.replace(/[.+]/g, "\\$&")} — start a fresh session$`, "m"),
    );
    assert.match(text.stdout, /Install mode:/, "the full status still prints");
    assert.match(text.stdout, /Start a fresh session:/, "the remedy is an action, not only a header");
  });
});

test("skills-revision: unchecked when the flag is absent, with the on-disk revision still reported", () => {
  withTarget((target) => {
    const run = status(target, ["--json"]);
    assert.equal(run.json.revision_check, "unchecked");
    assert.equal(run.json.skills_revision.requested, null);
    // Absent is not an error: an operator running preflight by hand has no
    // revision to offer, and the command must still say what is installed.
    assert.equal(run.json.skills_revision.on_disk, BUNDLE_REVISION);
    // Asserted on the actions rather than the exit code: a disposable target
    // has stale skills, so this run exits 2 for a reason that is not the
    // revision check. What must hold is that no check was performed and no
    // fresh session was demanded.
    assert.equal(run.json.actions.some((action) => action.startsWith("Start a fresh session:")), false);

    const text = status(target, []);
    assert.match(text.stdout, new RegExp(`^Skills revision: unchecked \\(on disk ${BUNDLE_REVISION.replace(/[.+]/g, "\\$&")}\\)$`, "m"));
  });
});

test("skills-revision: the old-context/new-disk case — a header captured before the bundle moved reports mismatch", () => {
  // The real failure, end to end. The value comes from a skill file (what an
  // agent would still be reading), the bundle then advances in a separately
  // installed copy of this package (what an `npm install` would do underneath
  // that session), and the check runs against THAT copy.
  const loaded = headerRevision("skills/next-campaigns-os/SKILL.md");
  assert.equal(loaded, BUNDLE_REVISION, "the shipped header and manifest must agree before this case means anything");

  const installRoot = realpathSync(mkdtempSync(join(tmpdir(), "campaigns-os-skills-revision-pkg-")));
  try {
    withTarget((target) => {
      const pkgRoot = stageRealPackageInstall(installRoot);
      const manifestPath = join(pkgRoot, "skills.json");
      const onDisk = JSON.parse(readFileSync(manifestPath, "utf8"));
      onDisk.bundle_revision = "1.40.0+skills.99";
      writeFileSync(manifestPath, `${JSON.stringify(onDisk, null, 2)}\n`);

      const run = status(target, ["--skills-revision", loaded, "--json"], {
        cli: join(pkgRoot, "bin", "campaigns-os.mjs"),
        cwd: installRoot,
      });
      assert.equal(run.json.revision_check, "mismatch", run.stderr);
      assert.equal(run.json.skills_revision.requested, loaded);
      assert.equal(run.json.skills_revision.on_disk, "1.40.0+skills.99");
      assert.equal(run.status, 2);

      // And the same copy still matches the value IT ships, so the mismatch
      // above is the bundle moving, not the check failing open.
      const current = status(target, ["--skills-revision", "1.40.0+skills.99", "--json"], {
        cli: join(pkgRoot, "bin", "campaigns-os.mjs"),
        cwd: installRoot,
      });
      assert.equal(current.json.revision_check, "match");
    });
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test("skills-revision: <skill-id>@<version> is accepted as a fallback spelling", () => {
  const skill = MANIFEST.skills[0];
  withTarget((target) => {
    const run = status(target, ["--skills-revision", `${skill.id}@${skill.version}`, "--json"]);
    assert.equal(run.json.revision_check, "match", run.stderr);
    assert.equal(run.json.skills_revision.spelling, "skill");
    assert.deepEqual(run.json.skills_revision.on_disk_skill, { id: skill.id, version: skill.version });
    assert.equal(run.json.skills_revision.on_disk, BUNDLE_REVISION, "the bundle is still reported alongside the skill");

    const stale = status(target, ["--skills-revision", `${skill.id}@0.0.1`, "--json"]);
    assert.equal(stale.json.revision_check, "mismatch");
    assert.equal(stale.status, 2);

    // A skill this bundle does not ship is a mismatch, not a refusal: an agent
    // quoting it is reading text from some other bundle, which is exactly the
    // condition the flag exists to catch.
    const unknown = status(target, ["--skills-revision", "next-campaigns-nowhere@1.0.0", "--json"]);
    assert.equal(unknown.json.revision_check, "mismatch");
    assert.equal(unknown.json.skills_revision.on_disk_skill, null);
    assert.equal(unknown.status, 2);
  });
});

test("skills-revision: a bare --skills-revision is refused, not treated as unchecked", () => {
  withTarget((target) => {
    const run = status(target, ["--skills-revision", "--json"]);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Missing value for --skills-revision/);
    // Silently reading a value-less flag as "no check requested" would report
    // `unchecked` to an agent that asked for a check.
    assert.doesNotMatch(run.stdout, /revision_check/);
  });
});
