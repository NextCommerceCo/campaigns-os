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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { LOCAL_INVOCATION_PREFIX } from "./install-mode.mjs";
import { ROOT as INSTALL_ROOT } from "./install-invocation.mjs";

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

// The agent context is installed into the campaign folder and loaded into
// sessions there (tooling setup imports the Claude copy), and setup runs only
// from the folder's pinned copy. A bare `campaigns-os <command>` in it reaches
// whatever is on PATH, or nothing, so each command carries the full prefix.
function bareInvocations(text) {
  return [...text.replace(/\s+/g, " ").matchAll(/(?<![\w./@-])(?<!npx --no-install )campaigns-os [a-z][a-z-]*/g)].map((match) => match[0]);
}

test("the installed agent context spells every command the way the campaign folder runs it", () => {
  const context = filesUnder("agents", () => true);
  assert.ok(context.length >= 4, "the agent context files were scanned");
  const offenders = context.flatMap((path) =>
    bareInvocations(readFileSync(join(ROOT, path), "utf8")).map((command) => `${path}: ${command}`));
  assert.deepEqual(offenders, [], `spell these as \`${LOCAL_INVOCATION_PREFIX} …\``);
});

// The same context, and the skills it points at, tell an agent how to treat
// test orders. `qa run` has no permission flag, but each order still lands in
// the store as a real order someone may have to cancel. So the agent asks
// once, up front with its other setup questions, unless the operator already
// said test orders are fine, and never reads the missing flag as "no approval
// needed". The list is the files that teach an agent to place or plan test
// orders; every agents/ and skills/ file is scanned for approval-free wording
// below, so a new skill that mentions test orders cannot call them
// approval-free, and one that teaches them belongs on this list.
const TEST_ORDER_GUIDANCE = [
  ...filesUnder("agents", () => true),
  "skills/next-campaigns-os/SKILL.md",
  "skills/next-campaigns-os/references/session-intake.md",
  "skills/next-campaigns-qa/SKILL.md",
];

test("the agent context asks about test orders once, up front, instead of calling them approval-free", () => {
  const flat = (path) => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");
  // Phrasings that read the missing flag as "no approval needed". The tool
  // fact itself ("`qa run` has no permission flag") is allowed.
  const approvalFree = /no permission\/approval|needs? no (?:permission|approval)(?! flag)|no (?:permission|approval|sign-off)(?: or approval)?(?: step)?(?: is)? (?:needed|required)|no permission or approval|without (?:needing |asking for )?(?:permission|approval)|safe to (?:fire|run|execute|place)(?: them| test orders)? (?:at )?any ?time/gi;
  const claims = [...filesUnder("agents", () => true), ...filesUnder("skills", (name) => name.endsWith(".md"))]
    .flatMap((path) => [...flat(path).matchAll(approvalFree)].map((match) => `${path}: ${match[0]}`));
  assert.deepEqual(claims, [], "test orders land in the store as real orders; say `qa run` has no permission flag instead");
  // The two phrases are the contract wording, kept identical across these
  // files on purpose: a rewording here should be a deliberate edit of every
  // file and this test together.
  const silent = TEST_ORDER_GUIDANCE.filter((path) =>
    !/ask once, up front/i.test(flat(path)) || !/already said test orders are fine/i.test(flat(path)));
  assert.deepEqual(silent, [], "tell the agent to ask once, up front, unless the operator already said test orders are fine");
});

test("published and runtime test-order guidance does not call store orders approval-free", () => {
  const guidance = [
    "README.md",
    "CONTEXT.md",
    "docs/quickstart.md",
    "docs/campaigns-os-build-flow.md",
    "docs/developer-evaluation.md",
    "docs/qa-and-test-orders.md",
    "src/cli.mjs",
    "src/qa-node.mjs",
    "src/qa-browser.mjs",
  ];
  const approvalFree = /no permission\/approval needed|no approval (?:is needed|needed|step is involved|gate)|need no merchant setup or approval|no transactions\/no permission gate|safe to run any time/gi;
  const claims = guidance.flatMap((path) => [...readFileSync(join(ROOT, path), "utf8").matchAll(approvalFree)]
    .map((match) => `${path}: ${match[0]}`));
  assert.deepEqual(claims, []);
  const consentWording = "Unless the operator has already said test orders are fine for this campaign, ask once, up front";
  const missing = guidance.filter((path) => !readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ").toLowerCase().includes(consentWording.toLowerCase()));
  assert.deepEqual(missing, [], "carry the existing test-order clause into each changed guidance surface");
  const firstTurn = guidance.filter((path) => readFileSync(join(ROOT, path), "utf8").includes("in your first turn"));
  assert.deepEqual(firstTurn, [], "QA-time text cannot assume it is still the first turn");
});

test("done guidance names record deploy for both local-serve and hosted deploys", () => {
  const guide = readFileSync(join(ROOT, "docs/build-packet.md"), "utf8");
  const done = guide.split('**`stage: "done"`**')[1]?.split("\n-")[0] || "";
  assert.match(done, /`record build`; it makes downstream stages owed/);
  assert.match(done, /`record deploy` records the served deploy, a loopback URL for a local-serve target or an https URL for a hosted one/);
  assert.doesNotMatch(done, /never hand-edit stage status/);
});

// The printed prefix cannot show this: from a checkout it is the bare form
// wherever ROOT points. The install mode is decided from ROOT, so ROOT itself
// is pinned to the package root.
test("ROOT names the package root, not src/", () => {
  assert.equal(INSTALL_ROOT, ROOT);
  const manifest = join(INSTALL_ROOT, "package.json");
  assert.ok(existsSync(manifest), `${manifest} does not exist`);
  assert.equal(JSON.parse(readFileSync(manifest, "utf8")).name, "@nextcommerce/campaigns-os");
  assert.notEqual(basename(INSTALL_ROOT), "src");
});
