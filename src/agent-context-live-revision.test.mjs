import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCES = [
  ["CLAUDE.md", "agents/claude/CLAUDE.md"],
  ["AGENTS.md", "agents/codex/AGENTS.md"],
  ["campaigns-os.mdc", "agents/cursor/campaigns-os.mdc"],
  ["copilot-instructions.md", "agents/copilot/copilot-instructions.md"],
];
const HEADING = "## Revising a live campaign";
const REVISION_COMMANDS = [
  "npx --no-install campaigns-os record build --packet campaign-runtime.build.json",
  "npx --no-install campaigns-os polish capture --packet campaign-runtime.build.json --base-url <served-current-build-url>",
  "npx --no-install campaigns-os record polish --packet campaign-runtime.build.json --evidence <polish-evidence.json>",
  "npx --no-install campaigns-os qa run --packet campaign-runtime.build.json",
];
const STEPS = [
  "1. Before editing, run `npx --no-install campaigns-os readback .` and `npx --no-install campaigns-os next --packet campaign-runtime.build.json`. Readback's `evidence_debt` compares the build on disk with the builds Polish and QA were recorded for. Changed pages are listed against the recorded assembly build manifest; an owed stage with an empty page list still means evidence is owed.",
  "2. For pages built from a provided design, the Design Source Package is the authority, not the punch list's wording.",
  `3. Before opening the pull request, after the final edit, rebuild, then run \`${REVISION_COMMANDS[0]}\`, \`${REVISION_COMMANDS[1]}\` for the whole route, and \`${REVISION_COMMANDS[2]}\`, in that order. When QA is owed, run \`${REVISION_COMMANDS[3]}\` against that build.`,
  "4. In the pull request body, put the design reference and the preview of each changed page side by side.",
];
const STANDING_CHECK = "The standing pull-request check is `npx --no-install campaigns-os doctor --ci --packet campaign-runtime.build.json --no-live-refs`, report-only unless the repo opts in.";
const normalized = (text) => text.replace(/\s+/g, " ").trim();

// Read the CLI's own usage table, rather than copying its required flags here.
// Checking syntax avoids running captures, remitting next, or inspecting a real campaign.
const CLI_USAGE = readFileSync(join(ROOT, "src/cli.mjs"), "utf8")
  .split("\n").filter((line) => line.startsWith("  campaigns-os "))
  .map((line) => line.trim().split(/\s+#/)[0]);

function requiredSyntax(usage) {
  let syntax = usage;
  while (/\[[^\[\]]*\]/.test(syntax)) syntax = syntax.replace(/\[[^\[\]]*\]/g, "");
  return syntax;
}

function matchesUsage(argv, usage) {
  const required = requiredSyntax(usage).replace(/^campaigns-os\s+/, "");
  const prefix = required.match(/^[a-z][a-z-]*(?:\s+[a-z][a-z-]*)*/)?.[0].split(/\s+/) ?? [];
  if (!prefix.length || prefix.some((word, i) => argv[i] !== word)) return false;
  const flagPattern = /--[a-z-]+(?:\s+<[^>]+>)?/g;
  const flags = new Map([...usage.matchAll(flagPattern)].map(([flag]) => [flag.split(/\s+/)[0], flag.includes("<")]));
  const supplied = new Set();
  const positional = [];
  for (let i = prefix.length; i < argv.length; i++) {
    const word = argv[i];
    if (!word.startsWith("--")) { positional.push(word); continue; }
    if (!flags.has(word)) return false;
    supplied.add(word);
    if (flags.get(word) && (!argv[++i] || argv[i].startsWith("--"))) return false;
  }
  const requiredFlags = [...required.matchAll(flagPattern)].map(([flag]) => flag.split(/\s+/)[0]);
  const requiredPositionals = required.replace(flagPattern, "").match(/<[^>]+>/g) ?? [];
  return requiredFlags.every((flag) => supplied.has(flag)) && positional.length === requiredPositionals.length;
}

test("every live-revision command follows the executable sequence and satisfies the CLI usage table", async (t) => {
  for (const [, source] of SOURCES) {
    const section = readFileSync(join(ROOT, source), "utf8").split(HEADING)[1].split(/\n#{1,2} /)[0];
    const step3 = section.match(/^3\.[\s\S]*?(?=^4\.)/m)?.[0] ?? "";
    const sequence = [...step3.matchAll(/`([^`]*\bcampaigns-os\s+[^`]+)`/g)].map((match) => match[1]);
    assert.deepEqual(sequence, REVISION_COMMANDS, `${source}: rebuild, record build, capture the whole route, record Polish, then run owed QA`);
  }
  const commands = [...[...STEPS, STANDING_CHECK].join("\n").matchAll(/`([^`]*\bcampaigns-os\s+[^`]+)`/g)]
    .map((match) => match[1]);
  assert.ok(commands.length > 0, "extract runnable commands from the single shared source list");
  for (const command of commands) {
    await t.test(command, () => {
      assert.ok(command.startsWith("npx --no-install campaigns-os "));
      const argv = command.replace(/^npx --no-install campaigns-os /, "").split(/\s+/);
      const usage = CLI_USAGE.find((row) => matchesUsage(argv, row));
      assert.ok(usage, `Missing required argument or unknown command: ${command}`);
      // Prove the checker rejects each omitted required flag, including doctor --packet.
      for (const [flagSyntax] of requiredSyntax(usage).matchAll(/--[a-z-]+(?:\s+<[^>]+>)?/g)) {
        const flag = flagSyntax.split(/\s+/)[0];
        const missing = [...argv];
        missing.splice(missing.indexOf(flag), flagSyntax.includes("<") ? 2 : 1);
        assert.ok(!CLI_USAGE.some((row) => matchesUsage(missing, row)), `${command}: must reject omitted ${flag}`);
      }
      assert.ok(!CLI_USAGE.some((row) => matchesUsage([argv[0], "unknown-subcommand", ...argv.slice(1)], row)), "reject unknown subcommands");
      if (requiredSyntax(usage).includes("<target-repo-root>")) {
        assert.ok(!CLI_USAGE.some((row) => matchesUsage(argv.slice(0, -1), row)), "readback requires its target root");
      }
    });
  }
});

function assertLiveRevision(text, label) {
  assert.equal(text.split(HEADING).length, 2, `${label}: one live-revision section`);
  const section = text.split(HEADING)[1].split(/\n#{1,2} /)[0];
  for (const step of [...STEPS, STANDING_CHECK]) {
    assert.ok(normalized(section).includes(step), `${label}: missing ${step}`);
  }
  assert.equal(normalized(section), normalized([...STEPS, STANDING_CHECK].join("\n")), `${label}: all four contexts agree on the revision steps`);
}

function fixture(t, populated = false) {
  const dir = mkdtempSync(join(tmpdir(), "agent-context-live-revision-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "campaign");
  if (populated) {
    mkdirSync(target);
    for (const name of ["CLAUDE.md", "AGENTS.md", ".cursor/rules/campaigns-os.mdc", ".github/copilot-instructions.md", ".gitignore", ".campaign-runtime/agent-context/CLAUDE.md"]) {
      const path = join(target, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `Existing ${name}\n`);
    }
  }
  return { dir, target };
}

function cli(f, flags) {
  const run = spawnSync(process.execPath, [join(ROOT, "bin/campaigns-os.mjs"), "install-agent-context", "--target", f.target, ...flags], {
    cwd: f.dir,
    encoding: "utf8",
    env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off", CAMPAIGNS_OS_LIFECYCLE_LOG: join(f.dir, "lifecycle.jsonl") },
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

function snapshot(path) {
  const stat = lstatSync(path, { bigint: true });
  return {
    mode: String(stat.mode),
    mtime: String(stat.mtimeNs),
    ctime: String(stat.ctimeNs),
    ...(stat.isDirectory()
      ? { entries: Object.fromEntries(readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))])) }
      : { content: readFileSync(path).toString("base64") }),
  };
}

test("install-agent-context refuses a value for --dry-run before previews or writes", (t) => {
  const f = fixture(t, true);
  const before = snapshot(f.dir);
  for (const value of ["false", "true"]) {
    for (const flags of [[], ["--json"]]) {
      const run = spawnSync(process.execPath, [join(ROOT, "bin/campaigns-os.mjs"), "install-agent-context", "--target", f.target, "--dry-run", value, ...flags], {
        cwd: f.dir, encoding: "utf8",
        env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off", CAMPAIGNS_OS_LIFECYCLE_LOG: join(f.dir, "lifecycle.jsonl") },
      });
      assert.equal(run.status, 1, run.stdout || run.stderr);
      assert.match(run.stderr, /--dry-run takes no value/);
      assert.equal(run.stdout, "", "refusal emits no misleading preview");
      assert.deepEqual(snapshot(f.dir), before, "refusal leaves files and lifecycle state untouched");
    }
  }
});

test("installed agent contexts share the live-campaign revision steps and preserve root instructions", (t) => {
  const f = fixture(t, true);
  const rootNames = ["CLAUDE.md", "AGENTS.md", ".cursor", ".github"];
  const before = rootNames.map((name) => snapshot(join(f.target, name)));
  const result = JSON.parse(cli(f, ["--json"]));
  assert.equal(result.status, "installed");
  assert.equal(result.directory, join(f.target, ".campaign-runtime/agent-context"));
  for (const [name, source] of SOURCES) {
    const path = join(result.directory, name);
    const installed = readFileSync(path, "utf8");
    assert.equal(installed, readFileSync(join(ROOT, source), "utf8"), `${name}: installs the source verbatim`);
    assertLiveRevision(installed, name);
    assert.ok(installed.includes("`next` blocks polish and QA again whenever the built output changes"), `${name}: retains the output freshness rule`);
  }
  assert.deepEqual(rootNames.map((name) => snapshot(join(f.target, name))), before);
});

for (const json of [false, true]) {
  test(`install-agent-context --dry-run${json ? " --json" : ""} previews each destination and its content without writes`, (t) => {
    for (const populated of [false, true]) {
      const f = fixture(t, populated);
      const before = snapshot(f.dir);
      const output = cli(f, ["--dry-run", ...(json ? ["--json"] : [])]);
      assert.deepEqual(snapshot(f.dir), before, "dry-run leaves all target files, directories, metadata and lifecycle state unchanged");
      if (!populated) assert.equal(existsSync(f.target), false, "dry-run does not create the target");
      if (json) {
        const result = JSON.parse(output);
        assert.equal(result.ok, true);
        assert.equal(result.status, "dry_run");
        assert.equal(result.target_repo, f.target);
        assert.equal(result.directory, join(f.target, ".campaign-runtime/agent-context"));
        assert.deepEqual(result.files, SOURCES.map(([name]) => join(result.directory, name)), "retains the existing files path list");
        assert.equal(result.gitignore.dry_run, true);
        assert.equal(typeof result.note, "string");
        assert.equal(result.file_contents?.length, SOURCES.length, "JSON previews content for every file");
        for (const [i, [name, source]] of SOURCES.entries()) {
          const preview = result.file_contents[i];
          assert.equal(preview.destination, join(result.directory, name));
          assert.equal(preview.content, readFileSync(join(ROOT, source), "utf8"));
          assertLiveRevision(preview.content, name);
        }
      } else {
        let cursor = 0;
        for (const [name, source] of SOURCES) {
          const destination = join(f.target, ".campaign-runtime/agent-context", name);
          const content = readFileSync(join(ROOT, source), "utf8");
          assert.ok(output.includes(content), `${name}: human preview includes the file content`);
          const start = output.indexOf(`Destination: ${destination}\n`, cursor);
          assert.ok(start >= cursor, `${name}: human preview names the destination`);
          const bodyStart = start + `Destination: ${destination}\n`.length;
          assert.equal(output.slice(bodyStart, bodyStart + content.length), content, `${name}: human preview prints the exact source text`);
          assertLiveRevision(content, name);
          cursor = bodyStart + content.length;
        }
      }
    }
  });
}
