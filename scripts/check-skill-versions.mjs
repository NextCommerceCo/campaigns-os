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
const BUNDLE_REVISION_RE = /^(\d+\.\d+\.\d+)\+skills\.(0|[1-9]\d*)$/;
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

// A skills.json id that another repo already publishes into the shared install
// slots is a silent-overwrite collision, not a version problem — versioning two
// DIFFERENT skills wearing one name only makes the drift diagnosable, not safe.
// contracts/reserved-skill-names.json lists the externally published ids.
//
// Matching notes: the installer keys destination dirs on the skills/ DIRECTORY
// name, not the manifest id, so both are checked — a manifest id dodge with a
// reserved directory path still lands in the reserved slot. Comparison is
// lowercased: the default macOS filesystem (where the shared slots live) is
// case-insensitive, so `Next-Campaigns-Setup` collides with the reserved slot
// even though the strings differ. Reservation presence uses `in`, not
// truthiness — an empty-string claim is still a reservation. Retired ids from
// skills.json must themselves be reserved, so a retired name can never be
// silently reintroduced.
export function validateReservedNames(manifest, reserved, label) {
  if (!reserved || reserved.reserved === null || typeof reserved.reserved !== "object" || Array.isArray(reserved.reserved)) {
    return [`${label}: expected an object with a reserved map`];
  }
  const reservedByLower = new Map(
    Object.entries(reserved.reserved).map(([name, claim]) => [name.toLowerCase(), { name, claim }]),
  );
  const errors = [];
  for (const entry of manifest.skills) {
    const dirName = packageDirName(entry.path ?? "");
    const probes = [["id", entry.id]];
    if (dirName && dirName.toLowerCase() !== String(entry.id ?? "").toLowerCase()) {
      probes.push(["package directory", dirName]);
    }
    for (const [kind, value] of probes) {
      if (!value) continue;
      const hit = reservedByLower.get(String(value).toLowerCase());
      if (hit) {
        errors.push(
          `${entry.id}: skill ${kind} ${JSON.stringify(value)} is reserved by an externally published skill ` +
            `(${hit.claim || hit.name}) — installing it would silently overwrite that skill in the shared ` +
            `skill directories. Pick a distinct name.`,
        );
      }
    }
  }
  for (const record of Array.isArray(manifest.retired_skills) ? manifest.retired_skills : []) {
    if (record?.id && !reservedByLower.has(String(record.id).toLowerCase())) {
      errors.push(
        `retired skill id ${JSON.stringify(record.id)} is not in ${label} — reserve retired names so they ` +
          `cannot be silently reintroduced`,
      );
    }
  }
  return errors;
}

/**
 * The bundle revision: one identity for the five skills TOGETHER, spelled
 * `<package version>+skills.<n>`.
 *
 * Per-skill versions already exist and are not enough for the failure this
 * guards. An agent loads a skill's text into its context once and never re-reads
 * it, while the CLI underneath that session can be replaced by an install or a
 * pull. To notice that, the agent needs one short string it can quote back —
 * `tooling status --skills-revision <value>` — and that string has to move
 * whenever ANY bundled skill's text moves, or an agent holding stale text gets
 * told it is current. Hence a bundle-wide counter rather than five versions the
 * agent would have to reconcile.
 *
 * `<n>` is a plain counter, not a semver: it says "this is the nth skill-text
 * revision published against this package version" and resets with the prefix,
 * so `1.41.0+skills.1` is ahead of `1.40.0+skills.7`.
 */
export function parseBundleRevision(value, label) {
  const match = BUNDLE_REVISION_RE.exec(String(value ?? ""));
  if (!match) {
    throw new Error(
      `${label}: bundle_revision must be spelled <package version>+skills.<n> (got ${JSON.stringify(value ?? null)})`,
    );
  }
  return { version: match[1], revision: Number(match[2]) };
}

/** True when `current` is strictly ahead of `previous`: newer package version, or the same version with a higher counter. */
export function bundleRevisionAdvanced(previous, current) {
  const left = semverTuple(previous.version);
  const right = semverTuple(current.version);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i];
  }
  return current.revision > previous.revision;
}

/** Shape, and the prefix agreeing with package.json — a bundle revision that names another release is not an identity. */
export function validateBundleRevisionShape(manifest, packageVersion, label) {
  let parsed;
  try {
    parsed = parseBundleRevision(manifest?.bundle_revision, label);
  } catch (error) {
    return [error.message];
  }
  if (packageVersion && parsed.version !== packageVersion) {
    return [
      `${label}: bundle_revision ${JSON.stringify(manifest.bundle_revision)} is prefixed ${parsed.version}, ` +
        `which is not the package version ${packageVersion} — the prefix names the release the skills ship with`,
    ];
  }
  return [];
}

/**
 * The bump gate for the bundle as a whole. Deliberately wider than the per-skill
 * gate: any file under skills/ counts (a reference doc an agent reads is skill
 * text too), and so does any edit to the manifest's own skill entries, because a
 * renamed or re-versioned entry changes what installs without touching a
 * SKILL.md.
 */
export function skillSurfaceChanged(changedPaths, oldManifest, currentManifest) {
  if (changedPaths.some((path) => path === SKILLS_DIR || path.startsWith(`${SKILLS_DIR}/`))) return true;
  if (!changedPaths.includes("skills.json")) return false;
  return JSON.stringify(oldManifest?.skills ?? null) !== JSON.stringify(currentManifest?.skills ?? null);
}

export function validateBundleBump(oldManifest, currentManifest, changedPaths, label) {
  if (!skillSurfaceChanged(changedPaths, oldManifest, currentManifest)) return [];
  // An introducing change has nothing to advance past; the shape check still ran.
  if (oldManifest?.bundle_revision === undefined) return [];
  let previous;
  let current;
  try {
    previous = parseBundleRevision(oldManifest.bundle_revision, `${label} (base)`);
    current = parseBundleRevision(currentManifest?.bundle_revision, label);
  } catch (error) {
    return [error.message];
  }
  if (!bundleRevisionAdvanced(previous, current)) {
    return [
      `skills.json: a bundled skill changed but bundle_revision did not advance ` +
        `(${oldManifest.bundle_revision} -> ${currentManifest.bundle_revision}) — an agent holding the old ` +
        `skill text would be told it is current`,
    ];
  }
  return [];
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

/**
 * The changed set, the same three-way union check-release-ledger.mjs measures:
 * committed since the base, plus the working tree, plus untracked files. A
 * committed-only diff answers the wrong question for a bump gate — an unstaged
 * SKILL.md edit is the exact state a local `--base` run is asked about, and
 * reporting it as "nothing changed" is the gate passing because it did not look.
 */
function changedPathsSince(base) {
  return [...new Set([
    ...git("diff", "--name-only", `${base}...HEAD`).split("\n"),
    ...git("diff", "--name-only", "HEAD").split("\n"),
    ...git("ls-files", "--others", "--exclude-standard").split("\n"),
  ])].filter(Boolean);
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

  let packageVersion = null;
  try {
    packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? null;
  } catch (error) {
    return [`package.json: could not be read for the bundle_revision prefix check: ${error.message}`];
  }

  const errors = validateBundleRevisionShape(manifest, packageVersion, "skills.json");

  errors.push(...validateParity(manifest, {
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
  }));

  // Required, not optional: if the reserved-names contract goes missing the
  // guard must fail loudly rather than degrade into the pre-2026-08 state where
  // nothing could see a cross-repo name collision.
  const reservedPath = join(root, "contracts", "reserved-skill-names.json");
  if (!existsSync(reservedPath)) {
    errors.push("contracts/reserved-skill-names.json missing — the reserved-skill-name guard cannot run");
  } else {
    try {
      const reserved = JSON.parse(readFileSync(reservedPath, "utf8"));
      errors.push(...validateReservedNames(manifest, reserved, "contracts/reserved-skill-names.json"));
    } catch (error) {
      errors.push(`contracts/reserved-skill-names.json: invalid JSON: ${error.message}`);
    }
  }

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
    const changedPaths = changedPathsSince(base);
    const pairs = [...packageDirs(manifest), ...packageDirs(oldManifest)];
    errors.push(...validateBumps(oldVersions, currentVersions, changedSkillIds(changedPaths, pairs)));
    errors.push(...validateBundleBump(oldManifest, manifest, changedPaths, "skills.json"));
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
