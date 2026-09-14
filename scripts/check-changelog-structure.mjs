#!/usr/bin/env node

/**
 * Structural checks on CHANGELOG.md and docs/**.
 *
 * The release ledger gate (check-release-ledger.mjs) proves that every ledger
 * entry links to exactly one changelog section whose bytes still match. It
 * says nothing about the sections no entry links to, and nothing about lines
 * that are not part of any section body an entry hashes. Two things slipped
 * through that gap: a diff3 `|||||||` base marker committed at the tail of a
 * section, and +agent.N sections landing out of order under their release.
 *
 * This checker holds four invariants:
 *
 *   1. No merge-conflict marker line (`<<<<<<< `, `|||||||`, `=======`,
 *      `>>>>>>> `) in CHANGELOG.md or any file under docs/.
 *   2. Every `## [X.Y.Z]` / `## [X.Y.Z+agent.N]` section identifier is unique.
 *   3. Under one release, the +agent.N sections form one contiguous run
 *      directly above `## [X.Y.Z]`, with N strictly descending.
 *   4. Every ledger `changelog_section` names a section that exists.
 *
 * Exit 1 with every violation listed; exit 0 otherwise.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CHANGELOG_PATH, LEDGER_PATH, parseChangelogSections } from "./orientation-contract.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);

export const DOCS_DIR = "docs";

/**
 * A conflict marker is a line that STARTS with one of git's four marker runs.
 * `<<<<<<<` and `>>>>>>>` are followed by a space and a label; `|||||||`
 * (diff3 base) by a space and a label, or by end of line; `=======` stands
 * alone. The `(?: |$)` anchor after each seven-character run is what separates
 * a marker from ordinary text that happens to open with seven of the same
 * character: an eighth `<`, `|`, `=` or `>` fails the anchor, so a markdown
 * rule such as `========` or a `>>>>>>>>` quote is not a marker.
 */
export const CONFLICT_MARKER = /^(?:<{7}(?: |$)|\|{7}(?: |$)|={7}$|>{7}(?: |$))/;

const SECTION_ID = /^(\d+\.\d+\.\d+)(?:\+agent\.(\d+))?$/;

export function findConflictMarkers(text, path) {
  const errors = [];
  text.split("\n").forEach((line, index) => {
    if (CONFLICT_MARKER.test(line)) {
      errors.push(`${path}:${index + 1}: merge-conflict marker line ${JSON.stringify(line.slice(0, 20))} — resolve the conflict and delete the marker`);
    }
  });
  return errors;
}

/** Recursively list every file under `dir`, as paths relative to `root`. */
export function listFiles(dir, base = root) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(base, full));
    }
  };
  walk(dir);
  return out;
}

/**
 * Pure validator over already-read inputs so the tests need no filesystem.
 *
 * @param {object} inputs
 * @param {string} inputs.changelogText          CHANGELOG.md contents
 * @param {Array<{path: string, text: string}>} [inputs.docs]   docs/** files
 * @param {Array<{id?: string, changelog_section?: string}>} [inputs.ledgerEntries]
 */
export function validateChangelogStructure({ changelogText, docs = [], ledgerEntries = [] }) {
  const errors = [];

  errors.push(...findConflictMarkers(changelogText, CHANGELOG_PATH));
  for (const doc of docs) errors.push(...findConflictMarkers(doc.text, doc.path));

  const sections = parseChangelogSections(changelogText);

  // 2. Unique identifiers.
  const seen = new Map();
  for (const section of sections) {
    if (seen.has(section.section_id)) {
      errors.push(`${CHANGELOG_PATH}: section "${section.section_id}" appears more than once — section identifiers must be unique`);
    }
    seen.set(section.section_id, true);
  }

  // 3. Ordering under each release. Walk top to bottom collecting the +agent.N
  // run; a bare release heading closes the run for its own sections. A stray
  // section (one above a release that is not its own) is reported once, at the
  // first foreign heading it sits above, and stays in the run so its order
  // against its release's later sections is still checked when that release
  // finally closes — or so it is reported as orphaned if it never does.
  let run = [];
  for (const section of sections) {
    const match = SECTION_ID.exec(section.section_id);
    if (!match) {
      errors.push(`${CHANGELOG_PATH}: section "${section.section_id}" is neither X.Y.Z nor X.Y.Z+agent.N`);
      continue;
    }
    const [, release, agent] = match;
    if (agent !== undefined) {
      run.push({ id: section.section_id, release, n: Number(agent), stray: false });
      continue;
    }
    for (const item of run) {
      if (item.release !== release && !item.stray) {
        item.stray = true;
        errors.push(
          `${CHANGELOG_PATH}: section "${item.id}" sits above release ${release} — a +agent.N section belongs directly above its own release section`,
        );
      }
    }
    const own = run.filter((item) => item.release === release);
    for (let index = 1; index < own.length; index += 1) {
      if (own[index].n >= own[index - 1].n) {
        errors.push(
          `${CHANGELOG_PATH}: section "${own[index].id}" follows "${own[index - 1].id}" — +agent.N sections under one release are ordered by N descending (newest first)`,
        );
      }
    }
    run = run.filter((item) => item.release !== release);
  }
  for (const item of run) {
    errors.push(`${CHANGELOG_PATH}: section "${item.id}" has no release section ${item.release} below it`);
  }

  // 4. Every ledger link resolves.
  for (const entry of ledgerEntries) {
    if (typeof entry?.changelog_section !== "string") continue;
    if (!seen.has(entry.changelog_section)) {
      errors.push(
        `${LEDGER_PATH} ${entry.id ?? "<entry with no id>"}: changelog_section "${entry.changelog_section}" names no section in ${CHANGELOG_PATH}`,
      );
    }
  }

  return errors;
}

export function loadInputs(base = root) {
  const changelogText = readFileSync(join(base, CHANGELOG_PATH), "utf8");
  const docs = listFiles(join(base, DOCS_DIR), base).map((path) => ({ path, text: readFileSync(join(base, path), "utf8") }));
  const ledger = JSON.parse(readFileSync(join(base, LEDGER_PATH), "utf8"));
  return { changelogText, docs, ledgerEntries: Array.isArray(ledger?.entries) ? ledger.entries : [] };
}

function main() {
  const errors = validateChangelogStructure(loadInputs());
  if (errors.length > 0) {
    console.error(`check-changelog-structure: ${errors.length} error(s):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log("Changelog structure checks passed.");
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) main();
