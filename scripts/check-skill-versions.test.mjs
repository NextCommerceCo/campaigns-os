import test from "node:test";
import assert from "node:assert/strict";

import {
  semverTuple,
  semverLte,
  frontmatterField,
  loadManifest,
  versionMap,
  packageDirs,
  changedSkillIds,
  validateParity,
  validateBumps,
} from "./check-skill-versions.mjs";

const manifestText = JSON.stringify({
  skills: [
    { id: "next-campaigns-os", version: "1.0.0", path: "skills/next-campaigns-os/SKILL.md" },
    { id: "next-campaigns-qa", version: "2.1.3", path: "skills/next-campaigns-qa/SKILL.md" },
  ],
});

const skillDoc = (name, version) => `---\nname: ${name}\nversion: ${version}\ndescription: x\n---\n\nbody\n`;

function harness({ docs, dirs }) {
  return {
    readSkill: (path) => (path in docs ? docs[path] : null),
    listSkillDirs: () => dirs,
  };
}

test("semverTuple rejects non-semver and leading zeroes", () => {
  assert.deepEqual(semverTuple("1.2.3"), [1, 2, 3]);
  assert.throws(() => semverTuple("1.2"), /invalid semver/);
  assert.throws(() => semverTuple("v1.2.3"), /invalid semver/);
  assert.throws(() => semverTuple("1.02.3"), /invalid semver/);
});

test("semverLte compares numerically, not lexically", () => {
  assert.equal(semverLte("1.0.10", "1.0.9"), false, "10 is newer than 9");
  assert.equal(semverLte("1.0.9", "1.0.10"), true);
  assert.equal(semverLte("1.0.0", "1.0.0"), true, "equal counts as not advanced");
  assert.equal(semverLte("2.0.0", "1.9.9"), false);
});

test("frontmatterField reads only inside the fence", () => {
  const doc = "---\nname: a\nversion: 1.0.0\n---\nversion: 9.9.9\n";
  assert.equal(frontmatterField(doc, "version"), "1.0.0");
  assert.equal(frontmatterField(doc, "name"), "a");
  assert.equal(frontmatterField(doc, "missing"), null);
});

test("frontmatterField returns null when there is no frontmatter at all", () => {
  assert.equal(frontmatterField("# Just a heading\nversion: 1.0.0\n", "version"), null);
});

test("versionMap rejects duplicate ids and missing versions", () => {
  const dup = JSON.stringify({ skills: [{ id: "a", version: "1.0.0" }, { id: "a", version: "1.0.1" }] });
  assert.throws(() => versionMap(loadManifest(dup, "m"), "m"), /duplicate skill id/);
  const missing = JSON.stringify({ skills: [{ id: "a" }] });
  assert.throws(() => versionMap(loadManifest(missing, "m"), "m"), /missing version/);
});

test("loadManifest rejects a manifest without a skills array", () => {
  assert.throws(() => loadManifest("{}", "m"), /expected an object with a skills array/);
  assert.throws(() => loadManifest("not json", "m"), /invalid JSON/);
});

test("validateParity passes when manifest, frontmatter, and disk agree", () => {
  const manifest = loadManifest(manifestText, "m");
  const errors = validateParity(
    manifest,
    harness({
      docs: {
        "skills/next-campaigns-os/SKILL.md": skillDoc("next-campaigns-os", "1.0.0"),
        "skills/next-campaigns-qa/SKILL.md": skillDoc("next-campaigns-qa", "2.1.3"),
      },
      dirs: ["next-campaigns-os", "next-campaigns-qa"],
    }),
  );
  assert.deepEqual(errors, []);
});

test("validateParity catches frontmatter drifting from the manifest", () => {
  const manifest = loadManifest(manifestText, "m");
  const errors = validateParity(
    manifest,
    harness({
      docs: {
        "skills/next-campaigns-os/SKILL.md": skillDoc("next-campaigns-os", "1.0.1"),
        "skills/next-campaigns-qa/SKILL.md": skillDoc("next-campaigns-qa", "2.1.3"),
      },
      dirs: ["next-campaigns-os", "next-campaigns-qa"],
    }),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /frontmatter version "1\.0\.1" does not match skills\.json "1\.0\.0"/);
});

test("validateParity catches an unversioned skill", () => {
  const manifest = loadManifest(manifestText, "m");
  const errors = validateParity(
    manifest,
    harness({
      docs: {
        "skills/next-campaigns-os/SKILL.md": "---\nname: next-campaigns-os\ndescription: x\n---\n",
        "skills/next-campaigns-qa/SKILL.md": skillDoc("next-campaigns-qa", "2.1.3"),
      },
      dirs: ["next-campaigns-os", "next-campaigns-qa"],
    }),
  );
  assert.deepEqual(errors, ["skills/next-campaigns-os/SKILL.md: version missing from frontmatter"]);
});

test("validateParity catches a name/id mismatch — the collision class this guard exists for", () => {
  const manifest = loadManifest(manifestText, "m");
  const errors = validateParity(
    manifest,
    harness({
      docs: {
        "skills/next-campaigns-os/SKILL.md": skillDoc("some-other-skill", "1.0.0"),
        "skills/next-campaigns-qa/SKILL.md": skillDoc("next-campaigns-qa", "2.1.3"),
      },
      dirs: ["next-campaigns-os", "next-campaigns-qa"],
    }),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /frontmatter name "some-other-skill" does not match skills\.json id/);
});

test("validateParity catches a skill on disk that never reached the manifest", () => {
  const manifest = loadManifest(manifestText, "m");
  const errors = validateParity(
    manifest,
    harness({
      docs: {
        "skills/next-campaigns-os/SKILL.md": skillDoc("next-campaigns-os", "1.0.0"),
        "skills/next-campaigns-qa/SKILL.md": skillDoc("next-campaigns-qa", "2.1.3"),
      },
      dirs: ["next-campaigns-os", "next-campaigns-qa", "next-campaigns-smuggled"],
    }),
  );
  assert.deepEqual(errors, ["skills/next-campaigns-smuggled: skill package is missing from skills.json"]);
});

test("validateParity reports a manifest entry whose SKILL.md is missing", () => {
  const manifest = loadManifest(manifestText, "m");
  const errors = validateParity(
    manifest,
    harness({
      docs: { "skills/next-campaigns-qa/SKILL.md": skillDoc("next-campaigns-qa", "2.1.3") },
      dirs: ["next-campaigns-qa"],
    }),
  );
  assert.deepEqual(errors, ["next-campaigns-os: SKILL.md missing at skills/next-campaigns-os/SKILL.md"]);
});

test("changedSkillIds maps changed files to their package, ignoring unrelated paths", () => {
  const dirs = packageDirs(loadManifest(manifestText, "m"));
  const changed = changedSkillIds(
    [
      "skills/next-campaigns-os/references/session-intake.md",
      "src/cli.mjs",
      "skills/next-campaigns-qa/SKILL.md",
    ],
    dirs,
  );
  assert.deepEqual([...changed].sort(), ["next-campaigns-os", "next-campaigns-qa"]);
});

test("changedSkillIds does not match a sibling directory sharing a name prefix", () => {
  const dirs = new Map([["a", "skills/a"]]);
  assert.deepEqual([...changedSkillIds(["skills/ab/SKILL.md"], dirs)], []);
  assert.deepEqual([...changedSkillIds(["skills/a/SKILL.md"], dirs)], ["a"]);
});

test("validateBumps requires an advance for every changed package", () => {
  const old = new Map([["a", "1.0.0"], ["b", "1.0.0"]]);
  const current = new Map([["a", "1.0.0"], ["b", "1.1.0"]]);
  const errors = validateBumps(old, current, new Set(["a", "b"]));
  assert.deepEqual(errors, ["a: package changed but version did not advance (1.0.0 -> 1.0.0)"]);
});

test("validateBumps rejects a version that moves backwards", () => {
  const errors = validateBumps(new Map([["a", "2.0.0"]]), new Map([["a", "1.9.9"]]), new Set(["a"]));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /did not advance \(2\.0\.0 -> 1\.9\.9\)/);
});

test("validateBumps ignores newly added and removed packages", () => {
  const old = new Map([["gone", "1.0.0"]]);
  const current = new Map([["fresh", "1.0.0"]]);
  assert.deepEqual(validateBumps(old, current, new Set(["gone", "fresh"])), []);
});
