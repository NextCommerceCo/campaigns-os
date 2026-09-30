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
 * After a baseline rotation (the ledger's `baseline_floor`) the history
 * older than the floor lives in dated archive changelogs under
 * contracts/archive/. A rotation moves one contiguous tail of CHANGELOG.md, so
 * the live file and every archive file are each checked as a well-formed
 * changelog on their own (invariants 1-3), and a section id may appear in only
 * one of them. Invariant 4 holds for the live ledger against the live file;
 * archived entries' links are the release-ledger gate's job.
 *
 * With --base REF, one more invariant: every section present at the merge
 * base (in its CHANGELOG.md or in an archive its floor names) is still in the
 * live file or an archive. A section is never deleted; a rotation moves it.
 *
 * Exit 1 with every violation listed; exit 0 otherwise.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CHANGELOG_PATH, LEDGER_PATH, loadArchive, parseChangelogSections } from "./orientation-contract.mjs";

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
 * Invariants 2 and 3 for one changelog file: unique, well-formed section ids,
 * and each release's +agent.N sections as one descending run directly above it.
 */
function validateSectionOrder(sections, path) {
  const errors = [];

  // 2. Unique identifiers.
  const seen = new Set();
  for (const section of sections) {
    if (seen.has(section.section_id)) {
      errors.push(`${path}: section "${section.section_id}" appears more than once — section identifiers must be unique`);
    }
    seen.add(section.section_id);
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
      errors.push(`${path}: section "${section.section_id}" is neither X.Y.Z nor X.Y.Z+agent.N`);
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
          `${path}: section "${item.id}" sits above release ${release} — a +agent.N section belongs directly above its own release section`,
        );
      }
    }
    const own = run.filter((item) => item.release === release);
    for (let index = 1; index < own.length; index += 1) {
      if (own[index].n >= own[index - 1].n) {
        errors.push(
          `${path}: section "${own[index].id}" follows "${own[index - 1].id}" — +agent.N sections under one release are ordered by N descending (newest first)`,
        );
      }
    }
    run = run.filter((item) => item.release !== release);
  }
  for (const item of run) {
    errors.push(`${path}: section "${item.id}" has no release section ${item.release} below it`);
  }
  return errors;
}

/**
 * Every section id present at base that is now in no changelog file. Shared
 * with check-release-ledger.mjs, whose --base run is the one CI performs.
 */
export function findDroppedSections(baseSectionIds, presentSectionIds) {
  const present = new Set(presentSectionIds);
  return [...new Set(baseSectionIds)]
    .filter((id) => !present.has(id))
    .map(
      (id) =>
        `${CHANGELOG_PATH}: section "${id}" was present at base but is in neither ${CHANGELOG_PATH} nor an archive changelog — ` +
        `a section is never deleted; a baseline rotation moves it into a new archive file`,
    );
}

/**
 * Every section id in a tree: its CHANGELOG.md plus each archive changelog the
 * ledger's floor names. `readText(path)` returns a file's text or null.
 */
export function collectSectionIds(changelogText, ledger, readText) {
  const { archive } = loadArchive(ledger, readText);
  return [
    ...parseChangelogSections(changelogText).map((section) => section.section_id),
    ...(archive?.sections ?? []).map((section) => section.section_id),
  ];
}

/**
 * Pure validator over already-read inputs so the tests need no filesystem.
 *
 * @param {object} inputs
 * @param {string} inputs.changelogText          CHANGELOG.md contents
 * @param {Array<{path: string, text: string}>} [inputs.docs]   docs/** files
 * @param {Array<{id?: string, changelog_section?: string}>} [inputs.ledgerEntries]
 * @param {Array<{path: string, text: string}>} [inputs.archives]  archive changelogs the ledger's floor names
 * @param {string[] | null} [inputs.baseSectionIds]  every section id at the merge base; null skips that check
 * @param {string[]} [inputs.loadErrors]  failures reading the archive the floor names
 */
export function validateChangelogStructure({ changelogText, docs = [], ledgerEntries = [], archives = [], baseSectionIds = null, loadErrors = [] }) {
  const errors = [...loadErrors];

  errors.push(...findConflictMarkers(changelogText, CHANGELOG_PATH));
  for (const doc of docs) errors.push(...findConflictMarkers(doc.text, doc.path));
  for (const file of archives) errors.push(...findConflictMarkers(file.text, file.path));

  // 2 and 3, for the live file and each archive on its own.
  const files = [
    { path: CHANGELOG_PATH, sections: parseChangelogSections(changelogText) },
    ...archives.map((file) => ({ path: file.path, sections: parseChangelogSections(file.text) })),
  ];
  for (const file of files) errors.push(...validateSectionOrder(file.sections, file.path));

  // A section lives in exactly one file.
  const home = new Map();
  for (const file of files) {
    for (const id of new Set(file.sections.map((section) => section.section_id))) {
      if (home.has(id)) {
        errors.push(`${file.path}: section "${id}" is also in ${home.get(id)} — a section lives in exactly one changelog file`);
      } else {
        home.set(id, file.path);
      }
    }
  }

  // 4. Every live ledger link resolves in the live file.
  const live = new Set(files[0].sections.map((section) => section.section_id));
  for (const entry of ledgerEntries) {
    if (typeof entry?.changelog_section !== "string") continue;
    if (!live.has(entry.changelog_section)) {
      errors.push(
        `${LEDGER_PATH} ${entry.id ?? "<entry with no id>"}: changelog_section "${entry.changelog_section}" names no section in ${CHANGELOG_PATH}`,
      );
    }
  }

  // 5. Nothing present at base disappeared.
  if (baseSectionIds) errors.push(...findDroppedSections(baseSectionIds, home.keys()));

  return errors;
}

export function loadInputs(base = root) {
  const changelogText = readFileSync(join(base, CHANGELOG_PATH), "utf8");
  const docs = listFiles(join(base, DOCS_DIR), base).map((path) => ({ path, text: readFileSync(join(base, path), "utf8") }));
  const ledger = JSON.parse(readFileSync(join(base, LEDGER_PATH), "utf8"));
  // The archive's hashes and entries are the release-ledger gate's job; here
  // it supplies the archive changelogs, each checked as a changelog of its own.
  const { archive, errors: loadErrors } = loadArchive(ledger, (path) => {
    try {
      return readFileSync(join(base, path), "utf8");
    } catch {
      return null;
    }
  });
  return {
    changelogText,
    docs,
    ledgerEntries: Array.isArray(ledger?.entries) ? ledger.entries : [],
    archives: (archive?.files ?? []).map((file) => ({ path: file.record.changelog_path, text: file.changelogText })),
    loadErrors,
  };
}

/** Every section id at the merge base of `ref` and HEAD, live and archived. */
export function loadBaseSectionIds(ref, base = root) {
  const git = (...args) => execFileSync("git", ["-C", base, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const mergeBase = git("merge-base", ref, "HEAD").trim();
  const readAtBase = (path) => {
    try {
      return git("show", `${mergeBase}:${path}`);
    } catch {
      return null;
    }
  };
  const changelogText = readAtBase(CHANGELOG_PATH);
  if (changelogText === null) return [];
  const ledgerText = readAtBase(LEDGER_PATH);
  return collectSectionIds(changelogText, ledgerText === null ? null : JSON.parse(ledgerText), readAtBase);
}

function main(argv = process.argv.slice(2)) {
  const baseIndex = argv.indexOf("--base");
  const ref = baseIndex === -1 ? null : argv[baseIndex + 1];
  if (baseIndex !== -1 && !ref) {
    console.error("--base requires a commit or ref");
    process.exit(2);
  }
  const errors = validateChangelogStructure({ ...loadInputs(), baseSectionIds: ref ? loadBaseSectionIds(ref) : null });
  if (errors.length > 0) {
    console.error(`check-changelog-structure: ${errors.length} error(s):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log("Changelog structure checks passed.");
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) main();
