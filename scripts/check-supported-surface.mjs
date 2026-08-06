#!/usr/bin/env node

/**
 * Supported-surface gate: contracts/supported-surface.json names what downstream
 * consumers may depend on, and this check makes changing any of it a deliberate,
 * reviewable act instead of a silent drive-by.
 *
 * Why it exists (2026-08 delineation session): this repo stopped being an
 * implementation and became a dependency — campaigns-agent pins schemas, contract
 * docs, and a CLI argv surface; the private ops repo vendors the runtime schemas
 * behind a parity gate; page-kit repos consume the emitted artifacts. The
 * assembly-report schema had already drifted 54 lines between two copies both
 * claiming schema-version v0, precisely because nothing made contract changes
 * loud. "Solid and simple" is only checkable once the supported surface is
 * enumerated and enforced.
 *
 * What it enforces:
 *   - hashed:   file exists and matches its recorded sha256 (update the hash in
 *               the same PR that changes the file);
 *   - named:    file exists at that path (content free to evolve);
 *   - package_exports: subpath is declared in package.json exports;
 *   - bin:      entry is declared in package.json bin;
 *   - pack coverage: every surface path ships in the npm tarball (its root
 *               segment — or the exact filename — appears in package.json
 *               files[]), so "supported" can never mean "absent from the
 *               package a consumer installs";
 *   - cli_commands: each supported command resolves in the CLI dispatch
 *               (knownCommands() from src/cli.mjs) — the CLI may ADD commands
 *               freely, but renaming/removing a supported one fails here;
 *   - --base REF: any hashed file changed since REF requires surface_version to
 *               advance. Deliberately STRICTER than check-skill-versions.mjs's
 *               bump gate: adds/removes of hashed files require a bump too,
 *               because the surface itself moving is exactly what consumers
 *               need to see versioned (the skill gate skips add/remove since a
 *               new skill starts its own version lineage).
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { semverLte, semverTuple } from "./check-skill-versions.mjs";

// fileURLToPath, never URL.pathname: pathname percent-encodes (a repo path with
// a space becomes %20), which silently broke both root resolution and the
// entry-point guard in earlier checkers — the script would exit 0 having
// validated nothing.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MANIFEST_PATH = "contracts/supported-surface.json";
const SCHEMAS_DIR = "schemas";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

export function loadSurface(text, label) {
  let surface;
  try {
    surface = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: invalid JSON: ${error.message}`);
  }
  for (const [field, type] of [
    ["surface_version", "string"],
    ["hashed", "object"],
  ]) {
    if (typeof surface[field] !== type || surface[field] === null) {
      throw new Error(`${label}: missing or malformed ${field}`);
    }
  }
  // typeof [] === "object", and Object.entries([]) is empty — an accidental
  // array here would validate every hashed contract as clean. Fail instead.
  if (Array.isArray(surface.hashed)) throw new Error(`${label}: hashed must be an object map, not an array`);
  semverTuple(surface.surface_version);
  for (const field of ["package_exports", "bin", "cli_commands", "named"]) {
    if (!Array.isArray(surface[field])) throw new Error(`${label}: ${field} must be an array`);
  }
  return surface;
}

export function validateSurface(surface, { readFile, fileExists, packageJson, commands, listSchemaFiles = () => [] }) {
  const errors = [];

  for (const [path, entry] of Object.entries(surface.hashed)) {
    if (!entry || typeof entry.sha256 !== "string" || !entry.sha256) {
      errors.push(`${path}: malformed hashed entry — expected { "sha256": "<hex>" }`);
      continue;
    }
    const content = readFile(path);
    if (content === null) {
      errors.push(`${path}: hashed surface file missing`);
      continue;
    }
    const actual = sha256(content);
    if (entry.sha256 !== actual) {
      errors.push(
        `${path}: content does not match the recorded surface hash — if this change is intentional, ` +
          `update contracts/supported-surface.json (sha256 ${actual}) and bump surface_version in the same PR`,
      );
    }
  }

  for (const path of surface.named) {
    if (!fileExists(path)) errors.push(`${path}: named surface file missing`);
  }

  // Completeness direction: the doc promises "schemas/*.schema.json — the
  // portable runtime contract", the whole directory. An enumerated-only gate
  // lets schema #8 be born unsupported and drift freely — the exact
  // assembly-report failure this gate exists to prevent. Mirrors the
  // both-directions rule in check-skill-versions.mjs.
  for (const schemaFile of listSchemaFiles()) {
    const path = `${SCHEMAS_DIR}/${schemaFile}`;
    if (!(path in surface.hashed)) {
      errors.push(`${path}: schema on disk is not in the hashed supported surface — add it (with its sha256) to ${MANIFEST_PATH}`);
    }
  }

  // A declared export/bin key whose target does not exist is a supported entry
  // point that resolves nowhere — key membership alone would pass `"./x": null`.
  for (const subpath of surface.package_exports) {
    const declared = packageJson.exports?.[subpath];
    if (!packageJson.exports || !(subpath in packageJson.exports)) {
      errors.push(`package.json exports no longer declares supported subpath ${JSON.stringify(subpath)}`);
      continue;
    }
    const targets = typeof declared === "string" ? [declared] : Object.values(declared ?? {});
    const resolvable = targets.filter((t) => typeof t === "string");
    if (!resolvable.length || !resolvable.every((t) => fileExists(t.replace(/^\.\//, "")))) {
      errors.push(`package.json exports ${JSON.stringify(subpath)} does not resolve to existing files (${JSON.stringify(declared)})`);
    }
  }

  for (const name of surface.bin) {
    const target = packageJson.bin?.[name];
    if (!packageJson.bin || !(name in packageJson.bin)) {
      errors.push(`package.json bin no longer declares supported entry ${JSON.stringify(name)}`);
    } else if (typeof target !== "string" || !fileExists(target.replace(/^\.\//, ""))) {
      errors.push(`package.json bin ${JSON.stringify(name)} points at a missing file (${JSON.stringify(target)})`);
    }
  }

  // Pack coverage: a supported path that npm pack would drop is a contract the
  // installed package silently fails to honor (skills.json was exactly this).
  // The matcher below is structural (root segment or exact filename in files[])
  // and is only sound while files[] stays plain directories/filenames — npm's
  // glob and "!"-negation syntax could exclude a file this matcher thinks is
  // covered. Guard the precondition instead of emulating npm: any pattern-
  // shaped files[] entry fails loudly until this checker learns npm's rules.
  const fileEntries = packageJson.files ?? [];
  for (const entry of fileEntries) {
    if (/[*?!{}\[\]()]/.test(entry)) {
      errors.push(
        `package.json files[] entry ${JSON.stringify(entry)} uses glob/negation syntax — the supported-surface ` +
          `pack-coverage check only understands plain directory/file entries; keep files[] literal or extend the checker`,
      );
    }
  }
  const files = new Set(fileEntries);
  const surfacePaths = [...Object.keys(surface.hashed), ...surface.named];
  for (const path of surfacePaths) {
    const rootSegment = path.split("/")[0];
    if (!files.has(rootSegment) && !files.has(path)) {
      errors.push(`${path}: not covered by package.json files[] — the npm pack would not ship this surface file`);
    }
  }

  // knownCommands() derives the dispatch table from src/cli.mjs by parsing; a
  // refactor it can't follow returns an empty/short list, which would make
  // every cli_commands entry "missing" — but an EMPTY list means the derivation
  // itself broke, not the surface. Distinguish the two so the failure points at
  // the right thing (src/known-commands.test.mjs guards the same invariant).
  if (surface.cli_commands.length > 0 && commands.length === 0) {
    errors.push("knownCommands() returned no commands — the CLI dispatch derivation broke; fix that before trusting this gate");
    return errors;
  }
  const known = new Set(commands);
  for (const command of surface.cli_commands) {
    if (!known.has(command)) {
      errors.push(`CLI no longer dispatches supported command ${JSON.stringify(command)}`);
    }
  }

  return errors;
}

export function validateSurfaceBump(oldSurface, surface, changedPaths) {
  const errors = [];

  // Always-on monotonicity: consumers read surface_version as a history; a PR
  // with no surface change must not be able to move it backwards.
  if (
    surface.surface_version !== oldSurface.surface_version &&
    semverLte(surface.surface_version, oldSurface.surface_version)
  ) {
    errors.push(
      `surface_version moved backwards (${oldSurface.surface_version} -> ${surface.surface_version}) — ` +
        `the version history consumers pin against must be monotonic`,
    );
  }

  // The bump is owed when the surface MOVED, seen two ways: a hashed file
  // changed on disk since base, or the manifest's own contract content
  // (hashed map or named list) changed. The second clause closes the
  // manifest-shrink bypass: deleting entries without touching any schema file
  // is still a surface move and still owes a version advance.
  const hashedPaths = new Set([...Object.keys(surface.hashed), ...Object.keys(oldSurface.hashed)]);
  const touched = changedPaths.filter((path) => hashedPaths.has(path)).sort();
  const manifestMoved =
    JSON.stringify(surface.hashed) !== JSON.stringify(oldSurface.hashed) ||
    JSON.stringify([...surface.named].sort()) !== JSON.stringify([...oldSurface.named].sort());
  if (!touched.length && !manifestMoved) return errors;
  if (semverLte(surface.surface_version, oldSurface.surface_version)) {
    const what = touched.length ? `hashed surface files changed (${touched.join(", ")})` : "the surface manifest itself changed";
    errors.push(
      `${what} but surface_version did not advance (${oldSurface.surface_version} -> ${surface.surface_version})`,
    );
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

async function validate(base) {
  let surface;
  let packageJson;
  try {
    surface = loadSurface(readFileSync(join(root, MANIFEST_PATH), "utf8"), MANIFEST_PATH);
    packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch (error) {
    return [error.message];
  }

  // Dynamic import with a gate-shaped failure: src/cli.mjs pulls the whole CLI
  // module graph incl. the built campaign-spec/dist. On a fresh clone before
  // `npm ci` (prepare -> build:spec), or with a syntax error anywhere in that
  // graph, a static import would kill this script with an unrelated stack
  // trace blamed on the surface gate.
  let commands;
  try {
    ({ knownCommands: commands } = await import("../src/cli.mjs"));
    commands = commands();
  } catch (error) {
    return [
      `could not load the CLI to verify supported commands (${error.message}) — run \`npm ci\` ` +
        `(builds campaign-spec/dist) or fix the CLI module graph, then re-run this gate`,
    ];
  }

  const errors = validateSurface(surface, {
    readFile: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path)) : null),
    fileExists: (path) => existsSync(join(root, path)),
    packageJson,
    commands,
    listSchemaFiles: () =>
      readdirSync(join(root, SCHEMAS_DIR)).filter((name) => name.endsWith(".schema.json")),
  });

  if (!base) return errors;

  if (!gitSucceeds("cat-file", "-e", `${base}:${MANIFEST_PATH}`)) {
    if (!gitSucceeds("rev-parse", "--verify", "--quiet", `${base}^{commit}`)) {
      return [...errors, `base comparison failed: ${JSON.stringify(base)} is not a resolvable ref`];
    }
    console.log(`No ${MANIFEST_PATH} at ${base}; skipping surface bump comparison (introducing change).`);
    return errors;
  }

  try {
    // One reference frame: read the old manifest at the MERGE BASE, and diff
    // from the same point. Mixing `git show base:` (tip) with `base...HEAD`
    // (merge-base) splits local vs CI verdicts once the base branch advances.
    const mergeBase = git("merge-base", base, "HEAD").trim();
    const oldSurface = loadSurface(git("show", `${mergeBase}:${MANIFEST_PATH}`), `${mergeBase}:${MANIFEST_PATH}`);
    // Committed changes since merge-base PLUS staged/unstaged edits: parity
    // reads the working tree, so the bump gate must see the same world or a
    // locally-edited schema+hash pair sails through `--base` un-bumped.
    const changedPaths = new Set(
      [
        ...git("diff", "--name-only", `${mergeBase}..HEAD`).split("\n"),
        ...git("diff", "--name-only", "HEAD").split("\n"),
      ].filter(Boolean),
    );
    errors.push(...validateSurfaceBump(oldSurface, surface, [...changedPaths]));
  } catch (error) {
    errors.push(`base comparison failed for ${JSON.stringify(base)}: ${error.message}`);
  }

  return errors;
}

async function main(argv) {
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex === -1 ? null : argv[baseIndex + 1];
  if (baseIndex !== -1 && !base) {
    console.error("--base requires a commit or ref");
    return 1;
  }

  const errors = await validate(base);
  if (errors.length) {
    console.error("Supported-surface validation failed:");
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log(`Supported surface is intact${base ? ` against ${base}` : ""}.`);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  process.exit(await main(process.argv.slice(2)));
}
