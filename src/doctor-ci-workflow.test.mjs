import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = parse(read("docs/examples/campaign-repo-evidence-check.yml"));
const steps = workflow.jobs.evidence.steps;
const commentSteps = workflow.jobs.comment.steps;
const comment = commentSteps.find((step) => step.uses?.startsWith("actions/github-script@"));
const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
const download = commentSteps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
const temporaryPath = (path, root) => path.replace("${{ runner.temp }}", root);
const downloadedReport = (root) => join(temporaryPath(download.with.path, root), "campaign-evidence.md");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Model Actions' file handoff using the paths in the actual upload/download steps.
function deliverReport(root) {
  mkdirSync(temporaryPath(download.with.path, root), { recursive: true });
  copyFileSync(temporaryPath(upload.with.path, root), downloadedReport(root));
}

async function postReport(root, { exitCode = "2", existing = false } = {}) {
  const writes = [];
  const github = {
    paginate: async () => existing ? [{ id: 42, user: { login: "github-actions[bot]" }, body: "<!-- campaign-evidence-check -->\n## Campaign evidence: current (exit 0)" }] : [],
    rest: { issues: {
      listComments: "listComments",
      createComment: async (args) => { assert.equal(existing, false); writes.push(args); },
      updateComment: async (args) => { assert.equal(existing, true); assert.equal(args.comment_id, 42); writes.push(args); },
    } },
  };
  await new AsyncFunction("require", "github", "context", "process", comment.with.script)(
    createRequire(import.meta.url), github,
    { repo: { owner: "placeholder", repo: "placeholder" }, issue: { number: 7 } },
    { env: { RUNNER_TEMP: root, DOCTOR_EXIT_CODE: exitCode } },
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
  deliverReport(root);
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

test("workflow replaces the sticky all-clear when install or build fails before doctor runs", async (t) => {
  // GitHub skips doctor and leaves its output empty after either earlier failure.
  assert.match(comment.if, /!cancelled\(\)/);
  assert.doesNotMatch(comment.if, /steps\.doctor\.outputs\.exit_code/,
    "a skipped doctor must not skip the comment step");
  assert.equal(comment.env.DOCTOR_EXIT_CODE, "${{ needs.evidence.outputs.exit_code }}");
  const root = mkdtempSync(join(tmpdir(), "doctor-ci-skipped-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const staleFile of [false, true]) {
    if (staleFile) {
      writeFileSync(join(root, "campaign-evidence.md"), "## Campaign evidence: current (exit 0)\n![](//a.b)\n");
      deliverReport(root);
    }
    for (const existing of [true, false]) {
      const body = await postReport(root, { exitCode: "", existing });
      assert.equal(body, "<!-- campaign-evidence-check -->\nCampaign build failed; evidence not evaluated. See the job log.");
    }
  }
});

test("workflow invokes doctor CI offline, reports by default and gates only on documented opt-in", async () => {
  const { DOCTOR_CI_EXIT_CODES } = await import("./doctor/ci.mjs");
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.equal(Object.hasOwn(workflow.on, "pull_request_target"), false);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["evidence", "comment"]);
  assert.deepEqual(workflow.jobs.evidence.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.comment.permissions, { "pull-requests": "write" });
  assert.equal(workflow.jobs.comment.needs, "evidence");
  assert.match(workflow.jobs.comment.if, /!cancelled\(\)/, "comment job runs after a failed evidence job");
  assert.deepEqual(workflow.jobs.evidence.outputs, { exit_code: "${{ steps.doctor.outputs.exit_code }}" });
  assert.ok(commentSteps.every((step) => !step.uses?.startsWith("actions/checkout@")), "write-scoped job never checks out PR code");
  assert.ok(commentSteps.every((step) => !step.run || step.run === "exit 1"), "write-scoped job never executes campaign commands");
  assert.equal(comment.with.script.includes("${{"), false, "PR expressions cannot become JavaScript source");
  assert.equal(upload.with.name, download.with.name);
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.match(upload.if, /!cancelled\(\)/);
  assert.equal(download["continue-on-error"], true, "missing artifacts must not leave a stale comment");
  assert.ok(commentSteps.indexOf(download) < commentSteps.indexOf(comment));
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
  const enforcement = commentSteps.at(-1);
  assert.match(enforcement.if, /vars\.CAMPAIGNS_OS_EVIDENCE_CHECK == 'fail'/);
  assert.match(enforcement.if, /needs\.evidence\.outputs\.exit_code != '0'/);
  assert.equal(enforcement.run, "exit 1");
  const docs = read("docs/campaigns-os-build-flow.md");
  assert.match(docs, /CAMPAIGNS_OS_EVIDENCE_CHECK` to `fail`/);
  assert.match(docs, /report-only by default/);
  for (const [status, exit] of Object.entries(DOCTOR_CI_EXIT_CODES)) {
    assert.ok(docs.includes(`| \`${status}\` | \`${exit}\` |`), `${status} exit code must match CLI's exported constant`);
  }
});

test("workflow uses the same sticky marker when searching, updating and creating", async (t) => {
  const comment = commentSteps.find((step) => step.uses?.startsWith("actions/github-script@"));
  assert.match(comment.uses, /^actions\/github-script@v\d+$/);
  assert.equal(comment["continue-on-error"], true, "a read-only fork token must not turn report-only into enforcement");
  const marker = comment.with.script.match(/const marker = '([^']+)'/)[1];
  assert.ok(read("docs/campaigns-os-build-flow.md").includes(marker));
  const root = mkdtempSync(join(tmpdir(), "doctor-ci-comment-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "campaign-evidence.md"), "## Campaign evidence: owed (exit 3)\n");
  deliverReport(root);
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
    await execute(createRequire(import.meta.url), github, { repo: { owner: "placeholder", repo: "placeholder" }, issue: { number: 7 } }, { env: { RUNNER_TEMP: root, DOCTOR_EXIT_CODE: "3" } });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, existing ? "update" : "create");
    assert.equal(writes[0].body, `${marker}\n## Campaign evidence: owed (exit 3)\n`);
    if (existing) assert.equal(writes[0].comment_id, 42);
    else assert.equal(writes[0].issue_number, 7);
  }
});


test("workflow stores the build summary under RUNNER_TEMP without checkout residue", (t) => {
  const root = mkdtempSync(join(tmpdir(), "doctor-ci-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  const runnerTemp = join(root, "runner-temp");
  for (const path of [checkout, runnerTemp]) mkdirSync(path);
  writeFileSync(join(root, "npx"), `#!/bin/sh\nprintf '%s\\n' '{"built":true}'\n`, { mode: 0o755 });
  const build = steps.find((step) => step.run?.includes("npx --no-install campaign-build --json"));
  const result = spawnSync("/bin/bash", ["-e", "-c", build.run], {
    cwd: checkout, encoding: "utf8",
    env: { ...process.env, PATH: `${root}:/usr/bin:/bin`, RUNNER_TEMP: runnerTemp },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(runnerTemp, "page-kit-build-summary.json"), "utf8")), { built: true });
  assert.equal(existsSync(join(checkout, ".campaign-runtime")), false);
  assert.equal(build["continue-on-error"], undefined, "build failures still fail the evidence job");
});

test("skipped doctor fallback overwrites an old report and missing artifacts clear the comment", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "doctor-ci-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fallback = steps.find((step) => step.name === "Prepare fallback report");
  assert.match(fallback.if, /!cancelled\(\).*steps\.doctor\.outputs\.exit_code == ''/);
  writeFileSync(join(root, "campaign-evidence.md"), "old all-clear");
  const result = spawnSync("/bin/bash", ["-e", "-c", fallback.run], {
    encoding: "utf8", env: { ...process.env, RUNNER_TEMP: root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, "campaign-evidence.md"), "utf8"), "Campaign build failed; evidence not evaluated. See the job log.\n");
  assert.equal(await postReport(root, { exitCode: "3", existing: true }),
    "<!-- campaign-evidence-check -->\nCampaign evidence could not be evaluated. See the job log.");
});

test("workflow defaults an empty or unset doctor status to failure before publishing it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "doctor-ci-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "campaign-evidence.md"), "report");
  const doctor = steps.find((step) => step.id === "doctor");
  const tail = doctor.run.slice(doctor.run.indexOf("status=$?\n") + "status=$?\n".length);
  for (const status of [undefined, "", "0", "3"]) {
    const env = { ...process.env, RUNNER_TEMP: root, GITHUB_OUTPUT: join(root, "outputs") };
    delete env.status;
    if (status !== undefined) env.status = status;
    writeFileSync(env.GITHUB_OUTPUT, "");
    const result = spawnSync("/bin/bash", ["-e", "-c", tail], { encoding: "utf8", env });
    const expected = status || "1";
    assert.equal(result.status, Number(expected), result.stderr);
    assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), `exit_code=${expected}\n`);
  }
});
