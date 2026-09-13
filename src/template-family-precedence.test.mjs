// prepare-build has two template-family channels — the --template-family flag
// and the CampaignSpec preferred_template_family hint — and the flag has
// always won. Before this suite the win was silent: an operator whose spec
// hinted one family and whose flag named another got a packet built on the
// flag with nothing on stderr and nothing on the assembly report. These tests
// pin the notice on both surfaces, and pin that agreement stays quiet.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const WARNING_CODE = "TEMPLATE_FAMILY_HINT_OVERRIDDEN";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// prepare-build against the in-repo example fixtures, with the spec's
// authoring hint rewritten in a temp copy so the flag and the hint can
// disagree without editing a committed fixture. Returns both the published
// artifacts and stderr, which is where the operator-facing line lands.
function prepareBuild({ hint = null, flag = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-family-precedence-"));
  try {
    const target = join(dir, "target");
    cpSync(resolve(ROOT, "examples/target-page-kit"), target, { recursive: true });
    const spec = readJson(resolve(ROOT, "examples/campaignspec.v42.basic.json"));
    if (hint) spec.spec_identity.preferred_template_family = hint;
    const specPath = join(dir, "spec.json");
    writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);

    const result = spawnSync("node", [
      CLI, "prepare-build",
      "--spec", specPath,
      "--source", resolve(ROOT, "examples/source-html"),
      "--target", target,
      ...(flag ? ["--template-family", flag] : []),
      "--no-run-session",
      "--json",
    ], { encoding: "utf8", cwd: dir });
    const stderr = String(result.stderr || "");
    assert.equal(result.status, 0, stderr);
    const packet = readJson(join(target, "campaign-runtime.build.json"));
    const report = readJson(join(target, ".campaign-runtime/assembly-report.json"));
    return { packet, report, stderr, warningCodes: report.warnings.map((warning) => warning.code) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a --template-family flag that contradicts the spec hint warns and names both values", () => {
  const run = prepareBuild({ hint: "demeter", flag: "olympus-mv-two-step" });

  assert.equal(run.packet.assembly.template_family, "olympus-mv-two-step", "the flag still wins");
  const warning = run.report.warnings.find((entry) => entry.code === WARNING_CODE);
  assert.ok(warning, `assembly report should carry ${WARNING_CODE}; got ${run.warningCodes.join(", ")}`);
  assert.equal(warning.stage, "prepare_build");
  assert.match(warning.message, /demeter/, "the warning must name the overridden hint");
  assert.match(warning.message, /olympus-mv-two-step/, "the warning must name the winning flag");

  // Pin the precedence line itself: the template-freshness line also prints the
  // resolved family and the flag name, so those alone would not catch a
  // regression that silences only this notice.
  const precedenceLine = run.stderr.split("\n").find((line) => line.includes(WARNING_CODE));
  assert.ok(precedenceLine, "stderr must carry the precedence notice naming the warning code");
  assert.match(precedenceLine, /"olympus-mv-two-step" selected by --template-family/);
  assert.match(precedenceLine, /preferred_template_family "demeter"/);
});

test("a --template-family flag that repeats the spec hint stays quiet", () => {
  const run = prepareBuild({ hint: "olympus", flag: "olympus" });
  assert.equal(run.packet.assembly.template_family, "olympus");
  assert.equal(run.warningCodes.includes(WARNING_CODE), false);
  assert.doesNotMatch(run.stderr, new RegExp(WARNING_CODE));
});

test("a spec hint with no flag stays quiet and remains an unlocked hint", () => {
  const run = prepareBuild({ hint: "olympus" });
  assert.equal(run.packet.assembly.template_family, "olympus");
  assert.equal(run.packet.assembly.template_lock.locked, false);
  assert.equal(run.warningCodes.includes(WARNING_CODE), false);
  assert.doesNotMatch(run.stderr, new RegExp(WARNING_CODE));
});
