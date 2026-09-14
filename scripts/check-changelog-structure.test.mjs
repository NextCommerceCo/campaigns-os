import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CONFLICT_MARKER, findConflictMarkers, loadInputs, validateChangelogStructure } from "./check-changelog-structure.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const section = (id, body = `- Something about ${id}.`) => `## [${id}] - 2026-02-02\n\n### Fixed\n\n${body}\n\n`;
const changelog = (...ids) => `# Changelog\n\n${ids.map((id) => section(id)).join("")}`;

test("the repository changelog, docs and ledger pass the structural check", () => {
  assert.deepEqual(validateChangelogStructure(loadInputs(root)), []);
});

test("a well-formed changelog with descending +agent.N runs passes", () => {
  const text = changelog("1.2.0+agent.3", "1.2.0+agent.2", "1.2.0+agent.1", "1.2.0", "1.1.0", "1.0.0+agent.1", "1.0.0");
  assert.deepEqual(validateChangelogStructure({ changelogText: text }), []);
});

test("every git conflict marker shape is refused, in the changelog and in docs", () => {
  for (const line of ["<<<<<<< HEAD", "||||||| 42ba452", "|||||||", "=======", ">>>>>>> main"]) {
    assert.ok(CONFLICT_MARKER.test(line), `expected ${JSON.stringify(line)} to be a marker`);
  }
  for (const line of ["========", "--------", "| a | b |", "<<< not a marker", "=== heading ==="]) {
    assert.ok(!CONFLICT_MARKER.test(line), `expected ${JSON.stringify(line)} not to be a marker`);
  }

  const text = `${changelog("1.0.0")}||||||| 42ba452\n`;
  const errors = validateChangelogStructure({
    changelogText: text,
    docs: [{ path: "docs/example.md", text: "# Example\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> theirs\n" }],
  });
  assert.equal(errors.length, 4, errors.join("\n"));
  assert.match(errors[0], /^CHANGELOG\.md:\d+: merge-conflict marker line "\|\|\|\|\|\|\| 42ba452"/);
  assert.match(errors[1], /^docs\/example\.md:3: merge-conflict marker line "<<<<<<< HEAD"/);
  assert.match(errors[2], /^docs\/example\.md:5: merge-conflict marker line "======="/);
  assert.match(errors[3], /^docs\/example\.md:7: merge-conflict marker line ">>>>>>> theirs"/);
});

test("a diff3 base marker at the tail of a section is a marker, not section content", () => {
  const text = `${section("1.0.0+agent.1")}||||||| 2912d70\n\n${section("1.0.0")}`;
  const errors = findConflictMarkers(text, "CHANGELOG.md");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /CHANGELOG\.md:7: merge-conflict marker line/);
});

test("a duplicated section identifier is refused", () => {
  const errors = validateChangelogStructure({ changelogText: changelog("1.1.0", "1.1.0", "1.0.0") });
  assert.deepEqual(errors, ['CHANGELOG.md: section "1.1.0" appears more than once — section identifiers must be unique']);
});

test("+agent.N sections under one release must be ordered newest first", () => {
  const errors = validateChangelogStructure({ changelogText: changelog("1.1.0+agent.2", "1.1.0+agent.1", "1.1.0+agent.3", "1.1.0") });
  assert.deepEqual(errors, [
    'CHANGELOG.md: section "1.1.0+agent.3" follows "1.1.0+agent.1" — +agent.N sections under one release are ordered by N descending (newest first)',
  ]);
});

test("a +agent.N section must sit directly above its own release", () => {
  const stray = validateChangelogStructure({ changelogText: changelog("1.1.0+agent.1", "1.0.0+agent.1", "1.1.0", "1.0.0") });
  assert.deepEqual(stray, [
    'CHANGELOG.md: section "1.0.0+agent.1" sits above release 1.1.0 — a +agent.N section belongs directly above its own release section',
  ]);

  const orphan = validateChangelogStructure({ changelogText: changelog("1.1.0", "1.0.0+agent.1") });
  assert.deepEqual(orphan, ['CHANGELOG.md: section "1.0.0+agent.1" has no release section 1.0.0 below it']);
});

test("a stray +agent.N section is still ordered against its own release, and reported once", () => {
  const interleaved = validateChangelogStructure({
    changelogText: changelog("1.0.0+agent.2", "1.1.0+agent.1", "1.1.0", "1.0.0+agent.3", "1.0.0"),
  });
  assert.deepEqual(interleaved, [
    'CHANGELOG.md: section "1.0.0+agent.2" sits above release 1.1.0 — a +agent.N section belongs directly above its own release section',
    'CHANGELOG.md: section "1.0.0+agent.3" follows "1.0.0+agent.2" — +agent.N sections under one release are ordered by N descending (newest first)',
  ]);

  const carried = validateChangelogStructure({ changelogText: changelog("2.0.0+agent.1", "1.1.0", "1.0.0") });
  assert.deepEqual(carried, [
    'CHANGELOG.md: section "2.0.0+agent.1" sits above release 1.1.0 — a +agent.N section belongs directly above its own release section',
    'CHANGELOG.md: section "2.0.0+agent.1" has no release section 2.0.0 below it',
  ]);
});

test("a ledger entry linking a section that does not exist is refused", () => {
  const errors = validateChangelogStructure({
    changelogText: changelog("1.0.0+agent.1", "1.0.0"),
    ledgerEntries: [
      { id: "RL-0001", changelog_section: "1.0.0" },
      { id: "RL-0002", changelog_section: "1.0.0+agent.2" },
    ],
  });
  assert.deepEqual(errors, ['contracts/release-ledger.json RL-0002: changelog_section "1.0.0+agent.2" names no section in CHANGELOG.md']);
});

test("the command exits 1 and names every violation on a broken tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "changelog-structure-"));
  try {
    mkdirSync(join(dir, "docs", "nested"), { recursive: true });
    mkdirSync(join(dir, "contracts"));
    writeFileSync(join(dir, "CHANGELOG.md"), `${changelog("1.0.0+agent.1", "1.0.0+agent.2", "1.0.0")}||||||| base\n`);
    writeFileSync(join(dir, "docs", "nested", "page.md"), "fine\n=======\n");
    writeFileSync(join(dir, "contracts", "release-ledger.json"), JSON.stringify({ entries: [{ id: "RL-0001", changelog_section: "9.9.9" }] }));

    const script = join(root, "scripts", "check-changelog-structure.mjs");
    const runner = `import { loadInputs, validateChangelogStructure } from ${JSON.stringify(script)};\n` +
      `const errors = validateChangelogStructure(loadInputs(process.argv[1]));\n` +
      `console.log(errors.join("\\n")); process.exit(errors.length ? 1 : 0);`;
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync(process.execPath, ["--input-type=module", "-e", runner, dir], { encoding: "utf8" });
    } catch (error) {
      status = error.status;
      stdout = error.stdout;
    }
    assert.equal(status, 1);
    assert.match(stdout, /CHANGELOG\.md:\d+: merge-conflict marker line "\|\|\|\|\|\|\| base"/);
    assert.match(stdout, /docs\/nested\/page\.md:2: merge-conflict marker line "======="/);
    assert.match(stdout, /"1\.0\.0\+agent\.2" follows "1\.0\.0\+agent\.1"/);
    assert.match(stdout, /RL-0001: changelog_section "9\.9\.9" names no section/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
