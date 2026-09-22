// Every bundled `SKILL.md` is checked against the kernel it describes.
//
// A skill is read once into an agent's context and then acted on without
// anybody re-reading the CLI beside it. So a skill that names a flag the help
// never taught, a command whose effect row does not exist, or a doc path that
// is not in the npm tarball is not a documentation defect — it is an
// instruction the agent cannot carry out, discovered at the worst moment. This
// file turns each of those into a build failure that names the skill, the line
// and the token.
//
// The three authorities are deliberately the same ones the gates use, not
// re-derived here: the HELP blocks via scripts/check-effects.mjs (which owns
// the list of modules that print one), contracts/effects.v1.json, and
// package.json `files[]`.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { HELP_SOURCE_PATHS, allHelpUsageLines } from "../scripts/check-effects.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

const MANIFEST = JSON.parse(read("skills.json"));
const EFFECTS = JSON.parse(read("contracts/effects.v1.json"));
const PACKAGE = JSON.parse(read("package.json"));
const EFFECT_CHANGING = new Set(EFFECTS.vocabulary.effect_changing_flags);
const HELP_SOURCES = HELP_SOURCE_PATHS.map((path) => ({ path, source: read(path) }));
const USAGE = allHelpUsageLines(HELP_SOURCES);

/**
 * The flags each help block defines under its `Options:` list, as
 * `path -> Set<flag>`.
 *
 * A usage line is the primary authority for "does this flag belong to this
 * invocation" and is checked first. But `campaigns-os qa` documents most of
 * its flags in an Options list rather than on the usage lines — that is where
 * `--legacy-api-test-order` and `--max-order-creations` live — so a skill
 * naming one of them is naming a flag the CLI help really does teach.
 *
 * The residual is stated rather than hidden: an Options entry is not bound to
 * one subcommand here, because the help text does not bind it to one either.
 * What this still catches, and what the check exists for, is a flag that no
 * help block mentions at all — an invented one.
 */
const OPTION_FLAGS = new Map(
  HELP_SOURCES.map(({ path, source }) => {
    const start = source.indexOf("const HELP = `");
    const block = source.slice(start, source.indexOf("\n`;", start));
    const flags = new Set();
    for (const match of block.matchAll(/^ {2}(--[a-z][a-z0-9-]*)/gm)) flags.add(match[1]);
    for (const match of block.matchAll(/^ {2}--[a-z][a-z0-9-]*, (--[a-z][a-z0-9-]*)/gm)) flags.add(match[1]);
    return [path, flags];
  }),
);

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// The Agent Skills frontmatter this bundle publishes. `allowed-tools` is
// deliberately absent and is asserted absent below: it is a per-turn permission
// grant (docs/harness-matrix.md), and a skill that ships one hands an agent
// authority that never went through a reviewed effects row.
const ALLOWED_FRONTMATTER_KEYS = new Set(["name", "version", "description"]);

/** Every skills/<id>/SKILL.md on disk, so a package that skipped the manifest is still checked. */
function skillFiles() {
  return readdirSync(join(ROOT, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ id: entry.name, path: `skills/${entry.name}/SKILL.md` }))
    .filter((skill) => existsSync(join(ROOT, skill.path)) && statSync(join(ROOT, skill.path)).isFile())
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Split the frontmatter fence from the body, keeping the body's real line
 * numbers so an error can point at the file the way an editor does.
 */
function splitSkill(text) {
  const lines = text.split(/\r?\n/);
  assert.equal(lines[0], "---", "a SKILL.md must open with a frontmatter fence");
  const close = lines.indexOf("---", 1);
  assert.ok(close > 0, "a SKILL.md frontmatter fence must be closed");
  return { frontmatter: lines.slice(1, close), body: lines.slice(close + 1), bodyOffset: close + 2 };
}

/** Column-0 scalar frontmatter keys. A nested or list value is a malformed skill, not a value to coerce. */
function frontmatterPairs(lines) {
  return lines
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
      assert.ok(match, `frontmatter line is not a scalar key: value pair: ${JSON.stringify(line)}`);
      return [match[1], match[2].trim().replace(/^['"]|['"]$/g, "")];
    });
}

const skills = skillFiles();

test("skills-references: at least the bundled skills are discovered", () => {
  assert.ok(skills.length >= MANIFEST.skills.length, "every manifest entry needs a package on disk");
});

test("skills-references: frontmatter validates and carries no allowed-tools", () => {
  for (const skill of skills) {
    const { frontmatter } = splitSkill(read(skill.path));
    const pairs = frontmatterPairs(frontmatter);
    const seen = new Map();
    for (const [key, value] of pairs) {
      assert.ok(
        ALLOWED_FRONTMATTER_KEYS.has(key),
        `${skill.path}: unexpected frontmatter key ${JSON.stringify(key)} — this bundle publishes ` +
          `${[...ALLOWED_FRONTMATTER_KEYS].join(", ")} and nothing else`,
      );
      assert.equal(seen.has(key), false, `${skill.path}: duplicate frontmatter key ${JSON.stringify(key)}`);
      seen.set(key, value);
    }
    for (const required of ALLOWED_FRONTMATTER_KEYS) {
      assert.ok(seen.has(required), `${skill.path}: frontmatter is missing ${JSON.stringify(required)}`);
    }
    assert.equal(seen.get("name"), skill.id, `${skill.path}: frontmatter name must be the directory id`);
    assert.match(seen.get("name"), SKILL_NAME, `${skill.path}: name must be lowercase and hyphen-separated`);
    assert.ok(seen.get("name").length <= 64, `${skill.path}: name is longer than 64 characters`);
    assert.match(seen.get("version"), SEMVER, `${skill.path}: version must be semver`);
    assert.ok(seen.get("description").length > 0, `${skill.path}: description must not be empty`);
    assert.ok(seen.get("description").length <= 1024, `${skill.path}: description is longer than 1024 characters`);
  }
});

test("skills-references: no skill carries a pre-approval key anywhere in its text", () => {
  // Narrower than src/generated-output.test.mjs (which scans agents/ and
  // skills/ wholesale); kept here too so the frontmatter case above cannot be
  // dodged by moving the grant into the body.
  for (const skill of skills) {
    const text = read(skill.path);
    for (const token of ["allowed-tools", "allowedTools", "disallowed-tools", "disallowedTools"]) {
      assert.equal(text.includes(token), false, `${skill.path}: must not carry ${token}`);
    }
  }
});

test("skills-references: the first body line states the bundle revision on disk", () => {
  for (const skill of skills) {
    const { body, bodyOffset } = splitSkill(read(skill.path));
    // The fence is followed by one blank line, then the header. Index it
    // rather than searching, because the contract is that it is FIRST: a
    // revision an agent has to scroll to find is a revision it will not quote.
    assert.equal(body[0], "", `${skill.path}: expected a blank line after the frontmatter fence`);
    assert.equal(
      body[1],
      `Bundle revision: ${MANIFEST.bundle_revision}`,
      `${skill.path}:${bodyOffset + 1}: the first body line must state skills.json's bundle_revision`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Command references                                                  */
/* ------------------------------------------------------------------ */

/**
 * A backticked `campaigns-os <command> [<sub> …] [--flag …]` reference, parsed.
 *
 * Leading bare words after the program name are the command and its
 * subcommand words; a `<placeholder>`, a quoted string or a bare value ends
 * that run. Flags are collected from the whole reference.
 */
function parseReference(reference) {
  const tokens = reference.trim().split(/\s+/);
  if (tokens[0] !== "campaigns-os") return null;
  const words = [];
  let index = 1;
  for (; index < tokens.length; index += 1) {
    if (!/^[a-z][a-z-]*$/.test(tokens[index])) break;
    words.push(tokens[index]);
  }
  if (!words.length) return null;
  const flags = [...reference.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)].map((match) => match[0]);
  return { command: words[0], subwords: words.slice(1), flags: [...new Set(flags)] };
}

/** Every backticked or fenced `campaigns-os …` reference in a skill, with its line number. */
function commandReferences(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    for (const match of line.matchAll(/`([^`]*campaigns-os[^`]*)`/g)) {
      const start = match[1].indexOf("campaigns-os");
      const parsed = parseReference(match[1].slice(start));
      if (parsed) found.push({ ...parsed, line: lineNumber, text: match[1].trim() });
    }
    // Fenced blocks carry the canonical invocation of each skill; treat a bare
    // line inside one exactly like a backticked reference.
    const bare = /^\s*campaigns-os\s/.test(line) ? parseReference(line.trim()) : null;
    if (bare) found.push({ ...bare, line: lineNumber, text: line.trim() });
  });
  return found;
}

/** Help usage records for a command, narrowed to the subcommand when the reference names one. */
function matchingUsage(reference) {
  const forCommand = USAGE.filter((record) => record.command === reference.command);
  if (!reference.subwords.length) return forCommand;
  const bySub = forCommand.filter((record) => record.subcommand === reference.subwords[0]);
  return bySub.length ? bySub : [];
}

/**
 * The effects rows a reference could be. A row's subcommand may be a
 * multi-word spelling (`policy set`), so the whole run of subwords is tried
 * before its first word, and a reference with no subwords matches a null one.
 */
function matchingRows(reference) {
  const candidates = reference.subwords.length
    ? [reference.subwords.join(" "), reference.subwords[0]]
    : [null];
  for (const candidate of candidates) {
    const rows = EFFECTS.rows.filter((row) => row.command === reference.command && row.subcommand === candidate);
    if (rows.length) return rows;
  }
  return [];
}

test("skills-references: every campaigns-os reference resolves against the CLI help", () => {
  let checked = 0;
  for (const skill of skills) {
    for (const reference of commandReferences(read(skill.path))) {
      const where = `${skill.path}:${reference.line}: \`${reference.text}\``;
      const usage = matchingUsage(reference);
      assert.ok(
        usage.length,
        `${where}: no help usage line teaches "campaigns-os ${[reference.command, ...reference.subwords].join(" ")}"`,
      );
      for (const flag of reference.flags) {
        const onUsageLine = usage.some((record) => record.flags.has(flag));
        const inOptions = usage.some((record) => OPTION_FLAGS.get(record.help)?.has(flag));
        assert.ok(
          onUsageLine || inOptions,
          `${where}: ${flag} is on no help usage line for that invocation and in no Options list of the ` +
            "help block that teaches it",
        );
      }
      checked += 1;
    }
  }
  assert.ok(checked >= 20, `expected the bundled skills to carry command references; saw ${checked}`);
  console.log(`skills-references: ${checked} command references resolved against the CLI help`);
});

/**
 * The tier a skill cites for a reference, when the reference is followed by a
 * `(tier \`X\`` parenthetical before any other backticked text (the
 * parenthetical may wrap onto the next line or two). The tier is the one
 * agent-facing value a skill restates from the contract that nothing else
 * re-derives; a re-tiered row must not leave the skill teaching the old one.
 */
function citedTier(source, reference) {
  const lines = source.split("\n");
  const window = lines.slice(reference.line - 1, reference.line + 2).join(" ");
  const start = window.indexOf(reference.text);
  if (start < 0) return null;
  const after = window.slice(start + reference.text.length);
  // The reference's own closing backtick comes first; then nothing backticked
  // may sit between it and the parenthetical.
  const match = /^`?[^`]*?\(tier `([^`]+)`/.exec(after);
  return match ? match[1] : null;
}

test("skills-references: every campaigns-os reference resolves against contracts/effects.v1.json", () => {
  let checked = 0;
  let tiersChecked = 0;
  for (const skill of skills) {
    const source = read(skill.path);
    for (const reference of commandReferences(source)) {
      const where = `${skill.path}:${reference.line}: \`${reference.text}\``;
      const rows = matchingRows(reference);
      const tier = citedTier(source, reference);
      if (tier !== null && rows.length) {
        assert.ok(
          rows.some((row) => row.tier === tier),
          `${where}: the skill cites tier \`${tier}\` but no row of contracts/effects.v1.json for that invocation ` +
            `carries it (rows: ${[...new Set(rows.map((row) => row.tier))].join(", ")})`,
        );
        tiersChecked += 1;
      }
      // `campaigns-os qa` with no subcommand and no flag names the command
      // FAMILY, not an invocation — and the contract says so itself by
      // declaring rows for qa's subcommands and none for a bare `qa`. Exempt
      // exactly that shape, so prose about a group of commands does not have
      // to invent a row, while `campaigns-os doctor` (which does have a bare
      // row) stays checked like any other invocation.
      const familyReference =
        !rows.length &&
        !reference.subwords.length &&
        !reference.flags.length &&
        EFFECTS.rows.some((row) => row.command === reference.command && row.subcommand !== null);
      if (familyReference) continue;
      assert.ok(rows.length, `${where}: contracts/effects.v1.json declares no row for that invocation`);
      // Only the effect-changing flags select a row; every other flag changes
      // no declared write or send and is checked against the help alone. The
      // contract declares one row PER such flag, not one per combination, so
      // each flag is required to be declared by some row of this invocation —
      // `qa run --browser --test-order common` is covered by the `--browser`
      // row and the `--test-order` row together, which is how the contract
      // itself is organized.
      for (const flag of reference.flags.filter((candidate) => EFFECT_CHANGING.has(candidate))) {
        assert.ok(
          rows.some((row) => row.flags.includes(flag)),
          `${where}: no row of contracts/effects.v1.json declares ${flag} for that invocation — a flag that ` +
            "changes what an invocation writes or sends is not publishable in a skill without its own row",
        );
      }
      checked += 1;
    }
  }
  assert.ok(tiersChecked >= 20, `expected the bundled skills to cite tiers beside references; saw ${tiersChecked}`);
  console.log(`skills-references: ${checked} command references resolved against the effects contract; ${tiersChecked} cited tiers match`);
});

/* ------------------------------------------------------------------ */
/* Path references                                                     */
/* ------------------------------------------------------------------ */

const PACKED_PATH = /(?:docs\/[A-Za-z0-9._-]+\.md|contracts\/[A-Za-z0-9._/-]+\.json|schemas\/[A-Za-z0-9._-]+\.json|AGENTS\.md)/g;

/** package.json files[] coverage: an entry names the path itself or a directory above it. */
function packed(path) {
  return PACKAGE.files.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

test("skills-references: every referenced repository path exists and ships in the npm pack", () => {
  let checked = 0;
  for (const skill of skills) {
    read(skill.path)
      .split(/\r?\n/)
      .forEach((line, index) => {
        for (const match of line.matchAll(PACKED_PATH)) {
          const path = match[0];
          const where = `${skill.path}:${index + 1}: ${path}`;
          assert.ok(existsSync(join(ROOT, path)), `${where}: referenced path does not exist in this tree`);
          assert.ok(
            packed(path),
            `${where}: referenced path is not covered by package.json files[] — a skill installs beside a ` +
              "published package and must not point at a file that package does not ship",
          );
          checked += 1;
        }
      });
  }
  assert.ok(checked >= 20, `expected the bundled skills to cite repository paths; saw ${checked}`);
  console.log(`skills-references: ${checked} repository path references exist and are packed`);
});
