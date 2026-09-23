// How this repository tells a reader to run the toolkit from a campaign folder.
//
// `campaigns-os` is only the bin name of @nextcommerce/campaigns-os. Where the
// folder has no installed copy, a plain `npx campaigns-os …` looks the bin name
// up as a registry package and, with no terminal to ask (the normal case for an
// agent), installs whatever it finds. `npx --no-install campaigns-os …` runs
// the pinned copy or fails. Every instruction a skill or doc gives therefore
// carries the flag; CHANGELOG.md and the release ledger are history and keep
// what each release shipped.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { LOCAL_INVOCATION_PREFIX } from "./install-mode.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function filesUnder(dir, keep) {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && keep(entry.name))
    .map((entry) => relative(ROOT, join(entry.parentPath ?? entry.path, entry.name)));
}

const INSTRUCTION_FILES = [
  "README.md",
  "AGENTS.md",
  "CONTEXT.md",
  ...filesUnder("docs", (name) => name.endsWith(".md")),
  ...filesUnder("skills", (name) => name.endsWith(".md")),
  ...filesUnder("agents", () => true),
];

test("the printed consumer prefix is the one that cannot install a package", () => {
  assert.equal(LOCAL_INVOCATION_PREFIX, "npx --no-install campaigns-os");
});

test("no skill or doc tells a reader to run a plain `npx campaigns-os <command>`", () => {
  assert.ok(INSTRUCTION_FILES.some((path) => path.startsWith("skills/")), "the skills were scanned");
  const offenders = [];
  for (const path of INSTRUCTION_FILES) {
    // Commands wrap across lines inside backticks; read them as one line. A
    // prose mention of the hazard (`npx campaigns-os` followed by a closing
    // backtick) is not a command and does not match.
    const text = readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");
    for (const match of text.matchAll(/\bnpx campaigns-os [a-z-]+/g)) offenders.push(`${path}: ${match[0]}`);
  }
  assert.deepEqual(offenders, [], `spell these as \`${LOCAL_INVOCATION_PREFIX} …\``);
});
