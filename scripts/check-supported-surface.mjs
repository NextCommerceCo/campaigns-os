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
 *               advance (same bump discipline as check-skill-versions.mjs).
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { semverLte, semverTuple } from "./check-skill-versions.mjs";
import { knownCommands } from "../src/cli.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const MANIFEST_PATH = "contracts/supported-surface.json";

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
  semverTuple(surface.surface_version);
  for (const field of ["package_exports", "bin", "cli_commands", "named"]) {
    if (!Array.isArray(surface[field])) throw new Error(`${label}: ${field} must be an array`);
  }
  return surface;
}

export function validateSurface(surface, { readFile, fileExists, packageJson, commands }) {
  const errors = [];

  for (const [path, entry] of Object.entries(surface.hashed)) {
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

  for (const subpath of surface.package_exports) {
    if (!packageJson.exports || !(subpath in packageJson.exports)) {
      errors.push(`package.json exports no longer declares supported subpath ${JSON.stringify(subpath)}`);
    }
  }

  for (const name of surface.bin) {
    if (!packageJson.bin || !(name in packageJson.bin)) {
      errors.push(`package.json bin no longer declares supported entry ${JSON.stringify(name)}`);
    }
  }

  // Pack coverage: a supported path that npm pack would drop is a contract the
  // installed package silently fails to honor (skills.json was exactly this).
  const files = new Set(packageJson.files ?? []);
  const surfacePaths = [...Object.keys(surface.hashed), ...surface.named];
  for (const path of surfacePaths) {
    const rootSegment = path.split("/")[0];
    if (!files.has(rootSegment) && !files.has(path)) {
      errors.push(`${path}: not covered by package.json files[] — the npm pack would not ship this surface file`);
    }
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
  const hashedPaths = new Set([...Object.keys(surface.hashed), ...Object.keys(oldSurface.hashed)]);
  const touched = changedPaths.filter((path) => hashedPaths.has(path)).sort();
  if (!touched.length) return [];
  if (semverLte(surface.surface_version, oldSurface.surface_version)) {
    return [
      `hashed surface files changed (${touched.join(", ")}) but surface_version did not advance ` +
        `(${oldSurface.surface_version} -> ${surface.surface_version})`,
    ];
  }
  return [];
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

function validate(base) {
  let surface;
  let packageJson;
  try {
    surface = loadSurface(readFileSync(join(root, MANIFEST_PATH), "utf8"), MANIFEST_PATH);
    packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch (error) {
    return [error.message];
  }

  const errors = validateSurface(surface, {
    readFile: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path)) : null),
    fileExists: (path) => existsSync(join(root, path)),
    packageJson,
    commands: knownCommands(),
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
    const oldSurface = loadSurface(git("show", `${base}:${MANIFEST_PATH}`), `${base}:${MANIFEST_PATH}`);
    const changedPaths = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
    errors.push(...validateSurfaceBump(oldSurface, surface, changedPaths));
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
    console.error("Supported-surface validation failed:");
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log(`Supported surface is intact${base ? ` against ${base}` : ""}.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exit(main(process.argv.slice(2)));
}
