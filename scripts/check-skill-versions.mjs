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
export function changedSkillIds(paths, packageDirs) {
  const changed = new Set();
  for (const path of paths) {
    for (const [id, dir] of packageDirs) {
      if (path === dir || path.startsWith(`${dir}/`)) changed.add(id);
    }
  }
  return changed;
}

export function packageDirs(manifest) {
  return new Map(manifest.skills.map((entry) => [entry.id, dirname(entry.path ?? "")]));
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
    declared.add(dirname(path).split("/").pop());
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

  try {
    const oldManifest = loadManifest(git("show", `${base}:skills.json`), `${base}:skills.json`);
    const oldVersions = versionMap(oldManifest, `${base}:skills.json.skills`);
    const changedPaths = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
    const dirs = new Map([...packageDirs(manifest), ...packageDirs(oldManifest)]);
    errors.push(...validateBumps(oldVersions, currentVersions, changedSkillIds(changedPaths, dirs)));
  } catch (error) {
    // A base that predates skills.json has nothing to compare; that is the
    // introducing PR, not a violation.
    if (/does not exist|exists on disk, but not in/.test(error.message ?? "")) {
      console.log(`No skills.json at ${base}; skipping bump comparison (introducing change).`);
      return errors;
    }
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
