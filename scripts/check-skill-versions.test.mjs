import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bundleRevisionAdvanced,
  parseBundleRevision,
  skillSurfaceChanged,
  validateBundleBump,
  validateBundleRevisionShape,
  semverTuple,
  semverLte,
  frontmatterField,
  loadManifest,
  versionMap,
  packageDirs,
  packageDirName,
  changedSkillIds,
  validateParity,
  validateBumps,
  validateReservedNames,
} from "./check-skill-versions.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

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
  const dirs = [["a", "skills/a"]];
  assert.deepEqual([...changedSkillIds(["skills/ab/SKILL.md"], dirs)], []);
  assert.deepEqual([...changedSkillIds(["skills/a/SKILL.md"], dirs)], ["a"]);
});

test("a renamed package keeps BOTH dirs, so a move still counts as a change", () => {
  // The rename case this gate has to survive: same id, path moves. Pairs (not a
  // Map) keep both dirs, so edits on either side still require the bump.
  const current = loadManifest(
    JSON.stringify({ skills: [{ id: "a", version: "1.0.0", path: "skills/new-name/SKILL.md" }] }),
    "m",
  );
  const old = loadManifest(
    JSON.stringify({ skills: [{ id: "a", version: "1.0.0", path: "skills/old-name/SKILL.md" }] }),
    "m",
  );
  const pairs = [...packageDirs(current), ...packageDirs(old)];
  assert.deepEqual([...changedSkillIds(["skills/old-name/SKILL.md"], pairs)], ["a"]);
  assert.deepEqual([...changedSkillIds(["skills/new-name/SKILL.md"], pairs)], ["a"]);
  assert.deepEqual(
    validateBumps(new Map([["a", "1.0.0"]]), new Map([["a", "1.0.0"]]), new Set(["a"])),
    ["a: package changed but version did not advance (1.0.0 -> 1.0.0)"],
  );
});

test("packageDirName resolves the package dir under skills/, however deep the SKILL.md sits", () => {
  assert.equal(packageDirName("skills/next-campaigns-os/SKILL.md"), "next-campaigns-os");
  assert.equal(packageDirName("skills/next-campaigns-os/src/SKILL.md"), "next-campaigns-os");
  assert.equal(packageDirName("elsewhere/thing/SKILL.md"), null);
  assert.equal(packageDirName("skills/SKILL.md"), null);
});

test("parity keys agree for a nested SKILL.md instead of falsely flagging the package", () => {
  const manifest = loadManifest(
    JSON.stringify({ skills: [{ id: "deep", version: "1.0.0", path: "skills/deep/src/SKILL.md" }] }),
    "m",
  );
  const errors = validateParity(manifest, {
    readSkill: (path) => (path === "skills/deep/src/SKILL.md" ? skillDoc("deep", "1.0.0") : null),
    listSkillDirs: () => ["deep"],
  });
  assert.deepEqual(errors, [], "reverse check must key on the package dir, not the SKILL.md parent");
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

test("validateReservedNames flags a skills.json id published by another repo", () => {
  const manifest = loadManifest(
    JSON.stringify({ skills: [{ id: "next-campaigns-setup", version: "1.0.0", path: "skills/next-campaigns-setup/SKILL.md" }] }),
    "m",
  );
  const reserved = { reserved: { "next-campaigns-setup": "published page-kit scaffolder" } };
  const errors = validateReservedNames(manifest, reserved, "contracts/reserved-skill-names.json");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /reserved by an externally published skill/);
  assert.match(errors[0], /published page-kit scaffolder/);
});

test("validateReservedNames passes ids outside the reserved map", () => {
  const manifest = loadManifest(
    JSON.stringify({ skills: [{ id: "next-campaigns-os-setup", version: "2.0.0", path: "skills/next-campaigns-os-setup/SKILL.md" }] }),
    "m",
  );
  const reserved = { reserved: { "next-campaigns-setup": "published page-kit scaffolder" } };
  assert.deepEqual(validateReservedNames(manifest, reserved, "contracts/reserved-skill-names.json"), []);
});

test("validateReservedNames fails on a malformed reserved contract instead of passing silently", () => {
  const manifest = loadManifest(JSON.stringify({ skills: [] }), "m");
  const errors = validateReservedNames(manifest, { reserved: [] }, "contracts/reserved-skill-names.json");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /expected an object with a reserved map/);
});

test("validateReservedNames catches a reserved package DIRECTORY even when the id dodges", () => {
  const manifest = loadManifest(
    JSON.stringify({ skills: [{ id: "innocent-id", version: "1.0.0", path: "skills/next-campaigns-setup/SKILL.md" }] }),
    "m",
  );
  const reserved = { reserved: { "next-campaigns-setup": "published scaffolder" } };
  const errors = validateReservedNames(manifest, reserved, "contracts/reserved-skill-names.json");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /package directory "next-campaigns-setup" is reserved/);
});

test("validateReservedNames matches case-insensitively — shared slots live on case-insensitive filesystems", () => {
  const manifest = loadManifest(
    JSON.stringify({ skills: [{ id: "Next-Campaigns-Setup", version: "1.0.0", path: "skills/Next-Campaigns-Setup/SKILL.md" }] }),
    "m",
  );
  const reserved = { reserved: { "next-campaigns-setup": "published scaffolder" } };
  const errors = validateReservedNames(manifest, reserved, "contracts/reserved-skill-names.json");
  assert.equal(errors.length, 1, "one error, deduped between id and same-named dir");
});

test("validateReservedNames treats an empty-string claim as still reserved", () => {
  const manifest = loadManifest(
    JSON.stringify({ skills: [{ id: "next-campaigns-setup", version: "1.0.0", path: "skills/next-campaigns-setup/SKILL.md" }] }),
    "m",
  );
  const errors = validateReservedNames(manifest, { reserved: { "next-campaigns-setup": "" } }, "c");
  assert.equal(errors.length, 1);
});

test("validateReservedNames rejects reserved: null instead of crashing with a wrong diagnosis", () => {
  const manifest = loadManifest(JSON.stringify({ skills: [] }), "m");
  const errors = validateReservedNames(manifest, { reserved: null }, "c");
  assert.deepEqual(errors, ["c: expected an object with a reserved map"]);
});

test("a retired skill id missing from the reserved list fails — retirement must be permanent", () => {
  const manifest = loadManifest(
    JSON.stringify({
      skills: [{ id: "next-campaigns-os-setup", version: "2.0.0", path: "skills/next-campaigns-os-setup/SKILL.md" }],
      retired_skills: [{ id: "next-campaigns-setup", replaced_by: "next-campaigns-os-setup" }],
    }),
    "m",
  );
  const unreserved = validateReservedNames(manifest, { reserved: {} }, "c");
  assert.equal(unreserved.length, 1);
  assert.match(unreserved[0], /retired skill id "next-campaigns-setup" is not in c/);
  const reserved = validateReservedNames(manifest, { reserved: { "next-campaigns-setup": "published scaffolder" } }, "c");
  assert.deepEqual(reserved, []);
});

test("parseBundleRevision accepts <package version>+skills.<n> and rejects anything else", () => {
  assert.deepEqual(parseBundleRevision("1.40.0+skills.1", "m"), { version: "1.40.0", revision: 1 });
  assert.deepEqual(parseBundleRevision("1.40.0+skills.0", "m"), { version: "1.40.0", revision: 0 });
  assert.throws(() => parseBundleRevision("1.40.0", "m"), /must be spelled/);
  assert.throws(() => parseBundleRevision("1.40.0+skills", "m"), /must be spelled/);
  assert.throws(() => parseBundleRevision("1.40.0+skills.01", "m"), /must be spelled/, "a padded counter is two spellings of one revision");
  assert.throws(() => parseBundleRevision(undefined, "m"), /must be spelled/);
});

test("bundleRevisionAdvanced compares the prefix first, then the counter", () => {
  const rev = (value) => parseBundleRevision(value, "m");
  assert.equal(bundleRevisionAdvanced(rev("1.40.0+skills.1"), rev("1.40.0+skills.2")), true);
  assert.equal(bundleRevisionAdvanced(rev("1.40.0+skills.1"), rev("1.40.0+skills.1")), false, "equal is not advanced");
  assert.equal(bundleRevisionAdvanced(rev("1.40.0+skills.7"), rev("1.41.0+skills.1")), true, "the counter resets with the prefix");
  assert.equal(bundleRevisionAdvanced(rev("1.41.0+skills.1"), rev("1.40.0+skills.9")), false, "a newer counter cannot rescue an older prefix");
  assert.equal(bundleRevisionAdvanced(rev("1.40.0+skills.10"), rev("1.40.0+skills.9")), false, "10 is newer than 9");
});

test("validateBundleRevisionShape requires the prefix to be the package version", () => {
  assert.deepEqual(validateBundleRevisionShape({ bundle_revision: "1.40.0+skills.1" }, "1.40.0", "skills.json"), []);
  const errors = validateBundleRevisionShape({ bundle_revision: "1.39.0+skills.1" }, "1.40.0", "skills.json");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /is prefixed 1\.39\.0, which is not the package version 1\.40\.0/);
  const missing = validateBundleRevisionShape({}, "1.40.0", "skills.json");
  assert.equal(missing.length, 1);
  assert.match(missing[0], /must be spelled/);
});

test("skillSurfaceChanged counts any file under skills/, and manifest skill entries, but not the rest of skills.json", () => {
  const old = { bundle_revision: "1.40.0+skills.1", skills: [{ id: "a", version: "1.0.0", path: "skills/a/SKILL.md" }] };
  const same = { bundle_revision: "1.40.0+skills.2", skills: old.skills };
  assert.equal(skillSurfaceChanged(["skills/a/references/intake.md"], old, same), true, "a reference doc is skill text too");
  assert.equal(skillSurfaceChanged(["src/cli.mjs"], old, same), false);
  assert.equal(skillSurfaceChanged(["skills.json"], old, same), false, "a description edit alone is not a skill change");
  const renamed = { bundle_revision: "1.40.0+skills.2", skills: [{ id: "a", version: "1.0.1", path: "skills/a/SKILL.md" }] };
  assert.equal(skillSurfaceChanged(["skills.json"], old, renamed), true, "a re-versioned entry changes what installs");
});

test("an edited skill without a bundle bump fails --base, and passes once the bundle advances", () => {
  // The negative control for the whole mechanism: skill text moved, the identity
  // an agent quotes back did not, so a stale agent would be told it is current.
  const base = {
    bundle_revision: "1.40.0+skills.1",
    skills: [{ id: "next-campaigns-qa", version: "1.3.3", path: "skills/next-campaigns-qa/SKILL.md" }],
  };
  const changed = ["skills/next-campaigns-qa/SKILL.md"];

  const unbumped = validateBundleBump(base, { ...base }, changed, "skills.json");
  assert.equal(unbumped.length, 1);
  assert.match(unbumped[0], /bundle_revision did not advance \(1\.40\.0\+skills\.1 -> 1\.40\.0\+skills\.1\)/);

  const bumped = validateBundleBump(base, { ...base, bundle_revision: "1.40.0+skills.2" }, changed, "skills.json");
  assert.deepEqual(bumped, []);
});

test("validateBundleBump ignores changes outside the skill surface, and an introducing manifest", () => {
  const base = { bundle_revision: "1.40.0+skills.1", skills: [] };
  assert.deepEqual(validateBundleBump(base, base, ["src/cli.mjs", "docs/effects.md"], "skills.json"), []);
  // No bundle_revision at the base: there is nothing to advance past. The shape
  // check still runs, so this cannot become a way to ship the field malformed.
  assert.deepEqual(
    validateBundleBump({ skills: [] }, { bundle_revision: "1.40.0+skills.1", skills: [] }, ["skills/a/SKILL.md"], "skills.json"),
    [],
  );
});

test("a bundle_revision that goes backwards or malformed fails rather than reading as a bump", () => {
  const base = { bundle_revision: "1.40.0+skills.4", skills: [] };
  const back = validateBundleBump(base, { bundle_revision: "1.40.0+skills.3", skills: [] }, ["skills/a/SKILL.md"], "skills.json");
  assert.equal(back.length, 1);
  assert.match(back[0], /did not advance \(1\.40\.0\+skills\.4 -> 1\.40\.0\+skills\.3\)/);
  const malformed = validateBundleBump(base, { bundle_revision: "nonsense", skills: [] }, ["skills/a/SKILL.md"], "skills.json");
  assert.equal(malformed.length, 1);
  assert.match(malformed[0], /must be spelled/);
});

test("every bundled SKILL.md states the shipped bundle revision on its first body line", () => {
  // The header line IS the identity an agent quotes back to --skills-revision. A
  // skill whose header disagrees with the manifest hands out a value that will
  // report mismatch against the very CLI it shipped with.
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "skills.json"), "utf8"));
  for (const skill of manifest.skills) {
    const text = readFileSync(join(REPO_ROOT, skill.path), "utf8");
    const body = text.split(/\r?\n/).slice(text.split(/\r?\n/).indexOf("---", 1) + 1);
    const first = body.find((line) => line.trim() !== "");
    assert.equal(first, `Bundle revision: ${manifest.bundle_revision}`, `${skill.path} first body line`);
  }
});
