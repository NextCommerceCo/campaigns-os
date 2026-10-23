import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = parse(read("docs/examples/campaign-repo-evidence-check.yml"));
const steps = workflow.jobs.evidence.steps;
const comment = steps.find((step) => step.uses?.startsWith("actions/github-script@"));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function postReport(root) {
  const writes = [];
  const github = {
    paginate: async () => [],
    rest: { issues: {
      listComments: "listComments",
      createComment: async (args) => writes.push(args),
      updateComment: async () => assert.fail("no existing comment"),
    } },
  };
  await new AsyncFunction("require", "github", "context", "process", comment.with.script)(
    createRequire(import.meta.url), github,
    { repo: { owner: "placeholder", repo: "placeholder" }, issue: { number: 7 } },
    { env: { RUNNER_TEMP: root } },
  );
  assert.equal(writes.length, 1);
  return writes[0].body;
}

// Run the workflow's actual shell step, with an npx shim that launches the
// local CLI without registry access (or simulates a launcher-only failure).
function inspectReport(t, { packet, stderrOnly } = {}) {
  const root = mkdtempSync(join(tmpdir(), "doctor-ci-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (packet !== undefined) writeFileSync(join(root, "campaign-runtime.build.json"), packet);
  writeFileSync(join(root, "npx"), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
if (process.env.TEST_STDERR_ONLY) {
  process.stderr.write(process.env.TEST_STDERR_ONLY);
  process.exit(1);
}
const result = spawnSync(process.execPath, [process.env.TEST_CLI, ...process.argv.slice(4)], { encoding: 'utf8' });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  const result = spawnSync("/bin/bash", ["-c", steps.find((step) => step.id === "doctor").run], {
    cwd: root, encoding: "utf8", env: {
      ...process.env, PATH: `${root}:${dirname(process.execPath)}:/usr/bin:/bin`,
      RUNNER_TEMP: root, GITHUB_OUTPUT: join(root, "outputs"),
      TEST_CLI: new URL("../bin/campaigns-os.mjs", import.meta.url).pathname,
      TEST_STDERR_ONLY: stderrOnly || "",
      CAMPAIGNS_OS_TELEMETRY: "off", CAMPAIGNS_OS_LIFECYCLE_LOG: "",
    },
  });
  assert.equal(result.error, undefined);
  return { root, result };
}

function assertNoInjectedMarkdown(body) {
  assert.doesNotMatch(body, /!\[|\[[^\]\n]*\]\(|^# PASS|<img|<script|<a\b|```/im);
  assert.doesNotMatch(body, /https?:\/\/|\/\/a\.b/);
  assert.equal((body.match(/^## /gm) || []).length, 1, "only the formatter's heading survives");
}

test("malformed packet diagnostics reach the real workflow comment only as escaped text", async (t) => {
  for (const payload of ["![](//a.b)", "\n# PASS", "[link](//a.b)", "<img src=//a.b>", "```\n# PASS\n```", "https://a.b"]) {
    await t.test(JSON.stringify(payload), async (t) => {
      const { root, result } = inspectReport(t, { packet: payload });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      assert.match(readFileSync(join(root, "outputs"), "utf8"), /^exit_code=2\n$/);
      const body = await postReport(root);
      assert.match(body, /Campaign evidence: could not evaluate \(exit 2\)/);
      assert.match(body, /doctor\.ci\.packet/);
      assertNoInjectedMarkdown(body);
    });
  }
});

test("stderr-only failure stays in the job log and out of the real workflow comment", async (t) => {
  const payload = '![](//a.b)\n# PASS\n[link](//a.b)\n<img src=//a.b>\n';
  const { root, result } = inspectReport(t, { stderrOnly: payload });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, payload, "stderr remains visible in the job log");
  assert.equal(readFileSync(join(root, "campaign-evidence.md"), "utf8"), "");
  const body = await postReport(root);
  assert.equal(body, '<!-- campaign-evidence-check -->\nCampaign evidence could not be evaluated. See the job log.');
});

test("workflow invokes doctor CI offline, reports by default and gates only on documented opt-in", async () => {
  const { DOCTOR_CI_EXIT_CODES } = await import("./doctor/ci.mjs");
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.equal(Object.hasOwn(workflow.on, "pull_request_target"), false);
  assert.deepEqual(workflow.permissions, { contents: "read", "pull-requests": "write" });
  assert.ok(steps.some((step) => step.uses?.startsWith("actions/checkout@")));
  assert.ok(steps.some((step) => step.uses?.startsWith("actions/setup-node@")));
  assert.ok(steps.some((step) => step.run === "npm ci"));
  const buildIndex = steps.findIndex((step) => step.run?.includes("npx --no-install campaign-build --json"));
  const doctorIndex = steps.findIndex((step) => step.id === "doctor");
  assert.ok(buildIndex >= 0 && buildIndex < doctorIndex);
  const doctor = steps[doctorIndex];
  assert.match(doctor.run, /npx --no-install campaigns-os doctor --packet \S+ --ci --no-live-refs/);
  assert.equal(doctor["continue-on-error"], true);
  assert.match(doctor.run, /status=\$\?/);
  assert.match(doctor.run, /echo "exit_code=\$status" >> "\$GITHUB_OUTPUT"/);
  assert.match(doctor.run, /cat "\$RUNNER_TEMP\/campaign-evidence\.md"/);
  assert.match(doctor.run, /exit "\$status"/);
  const enforcement = steps.at(-1);
  assert.match(enforcement.if, /vars\.CAMPAIGNS_OS_EVIDENCE_CHECK == 'fail'/);
  assert.match(enforcement.if, /steps\.doctor\.outputs\.exit_code != '0'/);
  assert.equal(enforcement.run, "exit 1");
  const docs = read("docs/campaigns-os-build-flow.md");
  assert.match(docs, /CAMPAIGNS_OS_EVIDENCE_CHECK` to `fail`/);
  assert.match(docs, /report-only by default/);
  for (const [status, exit] of Object.entries(DOCTOR_CI_EXIT_CODES)) {
    assert.ok(docs.includes(`| \`${status}\` | \`${exit}\` |`), `${status} exit code must match CLI's exported constant`);
  }
});

test("workflow uses the same sticky marker when searching, updating and creating", async (t) => {
  const comment = steps.find((step) => step.uses?.startsWith("actions/github-script@"));
  assert.match(comment.uses, /^actions\/github-script@v\d+$/);
  assert.equal(comment["continue-on-error"], true, "a read-only fork token must not turn report-only into enforcement");
  const marker = comment.with.script.match(/const marker = '([^']+)'/)[1];
  assert.ok(read("docs/campaigns-os-build-flow.md").includes(marker));
  const root = mkdtempSync(join(tmpdir(), "doctor-ci-comment-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "campaign-evidence.md"), "## Campaign evidence: owed (exit 3)\n");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction("require", "github", "context", "process", comment.with.script);
  for (const existing of [true, false]) {
    const writes = [];
    const github = {
      paginate: async (method, params) => {
        assert.equal(method, "listComments");
        assert.equal(params.per_page, 100);
        return [
          { id: 1, user: { login: "someone" }, body: marker },
          ...(existing ? [{ id: 42, user: { login: "github-actions[bot]" }, body: `${marker}\nold report` }] : []),
        ];
      },
      rest: { issues: {
        listComments: "listComments",
        updateComment: async (args) => writes.push({ method: "update", ...args }),
        createComment: async (args) => writes.push({ method: "create", ...args }),
      } },
    };
    await execute(createRequire(import.meta.url), github, { repo: { owner: "placeholder", repo: "placeholder" }, issue: { number: 7 } }, { env: { RUNNER_TEMP: root } });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, existing ? "update" : "create");
    assert.equal(writes[0].body, `${marker}\n## Campaign evidence: owed (exit 3)\n`);
    if (existing) assert.equal(writes[0].comment_id, 42);
    else assert.equal(writes[0].issue_number, 7);
  }
});
