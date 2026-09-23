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

// Every `npx campaigns-os <command>` in `text`, whether it sits in a fenced
// block, in inline code wrapped across lines, or in bare prose. The match is
// deliberately not limited to inline code: fenced blocks hold most of the
// runnable commands. A description of the hazard names the old spelling
// without a command word (`npx campaigns-os`, `npx campaigns-os …`), so it
// never matches; one that needs a command word should show the safe spelling.
function plainInvocations(text) {
  return [...text.replace(/\s+/g, " ").matchAll(/\bnpx campaigns-os [a-z-]+/g)].map((match) => match[0]);
}

test("the guard reads fenced and wrapped commands, and not a hazard description", () => {
  assert.deepEqual(plainInvocations("```bash\nnpx campaigns-os tooling status --json\n```"), ["npx campaigns-os tooling"]);
  assert.deepEqual(plainInvocations("run `npx\ncampaigns-os next --packet p.json` from the folder"), ["npx campaigns-os next"]);
  assert.deepEqual(plainInvocations("a plain `npx campaigns-os` looks the bin name up"), []);
  assert.deepEqual(plainInvocations("releases before 1.41.2 print `npx campaigns-os …`"), []);
  assert.deepEqual(plainInvocations("`npx --no-install campaigns-os qa install-browser`"), []);
});

test("no skill or doc tells a reader to run a plain `npx campaigns-os <command>`", () => {
  assert.ok(INSTRUCTION_FILES.some((path) => path.startsWith("skills/")), "the skills were scanned");
  const offenders = INSTRUCTION_FILES.flatMap((path) =>
    plainInvocations(readFileSync(join(ROOT, path), "utf8")).map((command) => `${path}: ${command}`));
  assert.deepEqual(
    offenders,
    [],
    `spell these as \`${LOCAL_INVOCATION_PREFIX} …\`; to describe the old spelling in prose, name it without a command word (\`npx campaigns-os\` or \`npx campaigns-os …\`)`,
  );
});
