// Nothing this repository publishes under `agents/` or `skills/` may carry a
// tool pre-approval.
//
// The failure being prevented: a harness reads those files into a session and
// honors permission keys it finds in them. A `SKILL.md` frontmatter key that
// pre-approves tools, or a settings fragment pasted into an agent context file,
// grants authority that never passed through a reviewed row of
// contracts/effects.v1.json — and it grants it silently, to whoever installed
// the bundle, in a session nobody reviewed. This repository declares what its
// commands do; it does not hand out permission to run them.
//
// It is also the wrong layer on the merits. A pre-approval written here is
// fixed at publish time and cannot see the operator, the target, or the
// session it lands in, which are exactly the things that decide whether an
// invocation is acceptable. The decision belongs to the harness and its
// operator, and the grant belongs in their configuration, not in ours.
//
// The token list is drawn from what the vendors documented in
// docs/harness-matrix.md, plus the shapes a permission fragment takes when it
// is pasted into prose rather than into a settings file.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCANNED_DIRS = ["agents", "skills"];

/**
 * Every published token, with the reason it is forbidden, so a failure says
 * what the author reached for and not only that a regex matched.
 *
 * `allowed-tools` / `disallowed-tools` are Claude Code's per-turn permission
 * grant and removal for a skill, documented on its skills page and recorded in
 * docs/harness-matrix.md. The matrix documents no pre-approval field for Codex
 * or Cursor — a cell without a citation is a claim nobody can check — so their
 * spellings are covered by the generic camelCase and `permissions` shapes
 * below rather than by a name this repository would be inventing for them.
 */
const FORBIDDEN = [
  { pattern: /allowed-tools/i, why: "Claude Code's per-turn tool pre-approval for a skill (docs/harness-matrix.md in the repository)" },
  { pattern: /disallowed-tools/i, why: "Claude Code's per-turn tool removal for a skill (docs/harness-matrix.md in the repository)" },
  { pattern: /\ballowedTools\b/, why: "the camelCase spelling of a tool pre-approval list" },
  { pattern: /\bdisallowedTools\b/, why: "the camelCase spelling of a tool denial list" },
  { pattern: /"permissions"\s*:/, why: "a settings permissions block" },
  { pattern: /^\s*permissions:\s*$/m, why: "a frontmatter or YAML permissions block" },
  { pattern: /"(allow|deny|ask)"\s*:\s*\[/, why: "a .claude/settings permission rule list" },
  { pattern: /\.claude\/settings(\.local)?\.json/, why: "a pointer into the harness's own permission settings file" },
  { pattern: /\bautoApprove\b/i, why: "an auto-approval key" },
  { pattern: /\balways_allow\b|\balwaysAllow\b/i, why: "an always-allow pre-approval key" },
  { pattern: /\bbypassPermissions\b/i, why: "a permission-bypass mode name" },
  { pattern: /\bacceptEdits\b/i, why: "a pre-accepted edit mode name" },
  { pattern: /\bdangerously-skip-permissions\b|\bdangerouslySkipPermissions\b/i, why: "a permission-skip switch" },
];

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const published = SCANNED_DIRS.flatMap(walk).sort();

test("generated-output: the scan reaches every published agent and skill file", () => {
  assert.ok(published.length >= 9, `expected the published agent/skill files; saw ${published.length}`);
  for (const directory of SCANNED_DIRS) {
    assert.ok(
      published.some((path) => path.startsWith(`${directory}/`)),
      `${directory}/ contributed no file to the scan — a silent empty walk would pass this file vacuously`,
    );
  }
  console.log(`generated-output: scanned ${published.length} files under ${SCANNED_DIRS.join("/, ")}/`);
});

test("generated-output: no published agent or skill file carries a tool pre-approval", () => {
  for (const path of published) {
    const text = readFileSync(join(ROOT, path), "utf8");
    for (const { pattern, why } of FORBIDDEN) {
      const match = pattern.exec(text);
      assert.equal(
        match,
        null,
        `${path}: carries ${JSON.stringify(match?.[0])} — ${why}. This repository declares what a command ` +
          "does in contracts/effects.v1.json; granting permission to run it belongs to the harness and its " +
          "operator, not to a file we publish.",
      );
    }
  }
});

test("generated-output: the guard is checked against a file that would fail it", () => {
  // Without this, a regex that stopped matching anything would leave the suite
  // green while the guard did nothing.
  for (const { pattern } of FORBIDDEN) {
    const sample = [
      "---\nname: x\nallowed-tools: Bash(git status:*)\n---",
      "disallowed-tools: Write",
      '{ "allowedTools": ["Bash"] }',
      '{ "disallowedTools": ["Write"] }',
      '{ "permissions": { "allow": ["Bash(npm run:*)"] } }',
      "permissions:\n  allow:\n    - Bash",
      '"deny": ["WebFetch"]',
      "see .claude/settings.json",
      "autoApprove: true",
      "always_allow: true",
      "mode: bypassPermissions",
      "mode: acceptEdits",
      "--dangerously-skip-permissions",
    ].find((candidate) => pattern.test(candidate));
    assert.ok(sample, `no sample exercises ${pattern} — the guard for it is unverified`);
  }
});

test("generated-output: relative to the repository root, the scan uses stable paths", () => {
  for (const path of published) {
    assert.equal(relative(ROOT, join(ROOT, path)), path);
    assert.ok(statSync(join(ROOT, path)).isFile());
  }
});
