#!/usr/bin/env node

/**
 * Contract guard: every bundled skill carries a semver in its frontmatter, the
 * root skills.json manifest agrees with it, and a changed skill package cannot
 * merge without advancing its version.
 *
 * Scenario this catches: the five bundled skills install into a SHARED global
 * path (~/.claude/skills, ~/.codex/skills) next to skills published from other
 * repos — `skills.sh` copies them in by name. Until now none carried a version,
 * so an install could silently overwrite a different skill of the same name and
 * nothing on the machine could tell which build was on disk: not this repo, and
 * not the installers, which can only compare versions that exist. An
 * unversioned skill is undiagnosable drift. This turns it into a build failure
 * instead.
 *
 * Direction of the check: manifest <-> frontmatter <-> disk must agree in BOTH
 * directions. A skill on disk with no manifest entry fails just as loudly as a
 * manifest entry with no skill — a new skill that skips the manifest is exactly
 * how the first unversioned skill got in.
 *
 * Two modes:
 *   (no --base)   parity only. Runs inside `npm run check`; needs no git.
 *   (--base REF)  additionally requires a version bump for every skill package
 *                 whose files changed since REF. CI passes the PR base sha.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SKILLS_DIR = "skills";

const root = resolve(new URL("..", import.meta.url).pathname);

export function semverTuple(value) {
  const match = SEMVER_RE.exec(String(value));
  if (!match) throw new Error(`invalid semver: ${JSON.stringify(value)}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function semverLte(a, b) {
  const left = semverTuple(a);
  const right = semverTuple(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i];
  }
  return true; // equal
}

// Reads a column-0 scalar key from the frontmatter fence. Deliberately narrow:
// `version` and `name` are flat scalars on every skill, and a nested or list
// form is a malformed frontmatter we want to fail on, not silently accept.
export function frontmatterField(text, field) {
  const lines = String(text).split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const pattern = new RegExp(`^${field}:\\s*['"]?([^'"\\s]+)`);
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const match = pattern.exec(line);
    if (match) return match[1];
  }
  return null;
}

export function loadManifest(text, label) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: invalid JSON: ${error.message}`);
  }
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.skills)) {
    throw new Error(`${label}: expected an object with a skills array`);
  }
  return manifest;
}

export function versionMap(manifest, label) {
  const versions = new Map();
  manifest.skills.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`${label}[${index}]: expected an object`);
    const { id, version } = entry;
    if (typeof id !== "string" || !id) throw new Error(`${label}[${index}]: missing id`);
    if (typeof version !== "string") throw new Error(`${label}[${index}] (${id}): missing version`);
    semverTuple(version);
    if (versions.has(id)) throw new Error(`${label}: duplicate skill id ${JSON.stringify(id)}`);
    versions.set(id, version);
  });
  return versions;
}

// A changed file belongs to a skill when it sits under that skill's package
// directory. Keyed on the manifest's declared path so a future layout change
// moves the packages without silently disabling the bump requirement.
export function changedSkillIds(paths, packagePairs) {
  const changed = new Set();
  for (const path of paths) {
    for (const [id, dir] of packagePairs) {
      if (path === dir || path.startsWith(`${dir}/`)) changed.add(id);
    }
  }
  return changed;
}

// PAIRS, deliberately not a Map: a rename keeps the id and moves the path, so
// the old and new manifests contribute two different dirs for one id. Collapsing
// them into a Map keeps only one, and changes under the other side stop counting
// as a change to that package — which would let a rename skip its own bump.
export function packageDirs(manifest) {
  return manifest.skills.map((entry) => [entry.id, dirname(entry.path ?? "")]);
}

// The package directory a manifest path belongs to, as named directly under
// skills/. Must agree with what listSkillDirs() reports, so a SKILL.md nested
// deeper than skills/<pkg>/SKILL.md still resolves to <pkg> on both sides of
// the parity check rather than to its immediate parent.
export function packageDirName(path) {
  const segments = String(path).split("/");
  return segments[0] === SKILLS_DIR && segments.length > 2 ? segments[1] : null;
}

export function validateParity(manifest, { readSkill, listSkillDirs }) {
  const errors = [];
  const declared = new Set();

  for (const entry of manifest.skills) {
    const { id, version, path } = entry;
    if (typeof path !== "string" || !path) {
      errors.push(`${id}: missing path`);
      continue;
    }
    const packageDir = packageDirName(path);
    if (packageDir) declared.add(packageDir);
    const text = readSkill(path);
    if (text === null) {
      errors.push(`${id}: SKILL.md missing at ${path}`);
      continue;
    }
    const frontmatterVersion = frontmatterField(text, "version");
    if (!frontmatterVersion) {
      errors.push(`${path}: version missing from frontmatter`);
    } else if (frontmatterVersion !== version) {
      errors.push(
        `${path}: frontmatter version ${JSON.stringify(frontmatterVersion)} does not match ` +
          `skills.json ${JSON.stringify(version)}`,
      );
    }
    const frontmatterName = frontmatterField(text, "name");
    if (frontmatterName && frontmatterName !== id) {
      errors.push(
        `${path}: frontmatter name ${JSON.stringify(frontmatterName)} does not match ` +
          `skills.json id ${JSON.stringify(id)}`,
      );
    }
  }

  // Reverse direction: a skill package that never reached the manifest is
  // unversioned everywhere it installs, which is the exact hole this guard exists to close.
  for (const dir of listSkillDirs()) {
    if (!declared.has(dir)) {
      errors.push(`${SKILLS_DIR}/${dir}: skill package is missing from skills.json`);
    }
  }

  return errors;
}

export function validateBumps(oldVersions, currentVersions, changedIds) {
  const errors = [];
  for (const id of [...changedIds].sort()) {
    if (!oldVersions.has(id) || !currentVersions.has(id)) continue; // added or removed
    const previous = oldVersions.get(id);
    const current = currentVersions.get(id);
    if (semverLte(current, previous)) {
      errors.push(`${id}: package changed but version did not advance (${previous} -> ${current})`);
    }
  }
  return errors;
}

function git(...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function gitSucceeds(...args) {
  try {
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const refExists = (ref) => gitSucceeds("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
const blobExists = (ref, path) => gitSucceeds("cat-file", "-e", `${ref}:${path}`);

function validate(base) {
  const manifestPath = join(root, "skills.json");
  let manifest;
  let currentVersions;
  try {
    manifest = loadManifest(readFileSync(manifestPath, "utf8"), "skills.json");
    currentVersions = versionMap(manifest, "skills.json.skills");
  } catch (error) {
    return [error.message];
  }

  const errors = validateParity(manifest, {
    readSkill: (path) => {
      const full = join(root, path);
      return existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : null;
    },
    listSkillDirs: () => {
      const dir = join(root, SKILLS_DIR);
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => item.name);
    },
  });

  if (!base) return errors;

  // Decide "is there a manifest at the base?" by exit code BEFORE the work,
  // rather than by pattern-matching a failure message afterwards. A message
  // test cannot tell an introducing PR from a typo'd ref or a malformed old
  // manifest, and this gate must never report green because it misread an
  // error it did not expect.
  if (!blobExists(base, "skills.json")) {
    if (!refExists(base)) {
      return [...errors, `base comparison failed: ${JSON.stringify(base)} is not a resolvable ref`];
    }
    console.log(`No skills.json at ${base}; skipping bump comparison (introducing change).`);
    return errors;
  }

  try {
    const oldManifest = loadManifest(git("show", `${base}:skills.json`), `${base}:skills.json`);
    const oldVersions = versionMap(oldManifest, `${base}:skills.json.skills`);
    const changedPaths = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
    const pairs = [...packageDirs(manifest), ...packageDirs(oldManifest)];
    errors.push(...validateBumps(oldVersions, currentVersions, changedSkillIds(changedPaths, pairs)));
  } catch (error) {
    errors.push(`base comparison failed for ${JSON.stringify(base)}: ${error.message}`);
  }

  return errors;
}

function main(argv) {
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex === -1 ? null : argv[baseIndex + 1];
  if (baseIndex !== -1 && !base) {
    console.error("--base requires a commit or ref");
    return 1;
  }

  const errors = validate(base);
  if (errors.length) {
    console.error("Skill version validation failed:");
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log(`Skill versions are valid${base ? ` against ${base}` : ""}.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exit(main(process.argv.slice(2)));
}
