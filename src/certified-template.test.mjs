import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-certified-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Prepare-build against the in-repo example fixtures into a temp target.
function prepareBuild(dir, extraArgs = [], { allowFail = false } = {}) {
  const target = join(dir, "target");
  if (!existsSync(target)) cpSync(resolve(ROOT, "examples/target-page-kit"), target, { recursive: true });
  try {
    const stdout = execFileSync("node", [
      CLI, "prepare-build",
      "--spec", resolve(ROOT, "examples/campaignspec.v42.basic.json"),
      "--source", resolve(ROOT, "examples/source-html"),
      "--target", target,
      ...extraArgs,
      "--json",
    ], { encoding: "utf8", cwd: dir, stdio: "pipe" });
    return { ok: true, target, stdout };
  } catch (error) {
    if (!allowFail) throw error;
    return { ok: false, target, stderr: String(error.stderr || ""), stdout: String(error.stdout || "") };
  }
}

test("prepare-build refuses an uncertified template family without a waiver", () => {
  withTempDir((dir) => {
    const result = prepareBuild(dir, ["--template-family", "custom"], { allowFail: true });
    assert.equal(result.ok, false);
    assert.match(result.stderr, /not certified/i);
    assert.match(result.stderr, /demeter/, "the error must list the certified families");
    assert.match(result.stderr, /--allow-uncertified-template/);
  });
});

test("prepare-build records a certification waiver for an uncertified family", () => {
  withTempDir((dir) => {
    const result = prepareBuild(dir, [
      "--template-family", "custom",
      "--allow-uncertified-template", "agency brings its own contracted design system",
      "--no-run-session",
    ]);
    const packet = readJson(join(result.target, "campaign-runtime.build.json"));
    assert.equal(packet.assembly.template_certification.certified, false);
    assert.equal(packet.assembly.template_certification.waiver.reason, "agency brings its own contracted design system");

    // Doctor surfaces the waiver as a warning, not an error. The synthetic
    // fixture may have other blockers for a custom family (no template
    // slice), so tolerate a non-zero exit and assert on the issue codes.
    const out = (() => {
      try {
        return execFileSync("node", [CLI, "doctor", "--packet", join(result.target, "campaign-runtime.build.json"), "--json"], { encoding: "utf8", cwd: dir, stdio: "pipe" });
      } catch (error) {
        return String(error.stdout || "");
      }
    })();
    const doctor = JSON.parse(out);
    assert.ok(!doctor.errors.some((issue) => issue.code === "assembly.template_certification"));
    assert.ok(doctor.warnings.some((issue) => issue.code === "assembly.template_certification"));
  });
});

test("prepare-build marks a certified family and doctor reports it ready", () => {
  withTempDir((dir) => {
    const result = prepareBuild(dir, ["--template-family", "olympus", "--no-run-session"]);
    const packet = readJson(join(result.target, "campaign-runtime.build.json"));
    assert.deepEqual(packet.assembly.template_certification, { certified: true });

    const doctor = JSON.parse(execFileSync("node", [
      CLI, "doctor", "--packet", join(result.target, "campaign-runtime.build.json"), "--json",
    ], { encoding: "utf8", cwd: dir, stdio: "pipe" }));
    assert.ok(doctor.ready.some((line) => /Template family "olympus" is certified/.test(line)));
  });
});

test("doctor treats certified private families as known template families", () => {
  withTempDir((dir) => {
    const result = prepareBuild(dir, ["--template-family", "arjuna", "--no-run-session"]);
    const packetPath = join(result.target, "campaign-runtime.build.json");

    const out = (() => {
      try {
        return execFileSync("node", [CLI, "doctor", "--packet", packetPath, "--json"], { encoding: "utf8", cwd: dir, stdio: "pipe" });
      } catch (error) {
        return String(error.stdout || "");
      }
    })();
    const doctor = JSON.parse(out);
    assert.equal(
      doctor.errors.some((issue) => issue.code === "assembly.template_family"),
      false,
      "catalog-certified private families must not be rejected by the stale known-family set",
    );
    assert.ok(doctor.ready.some((line) => /Template family "arjuna" is certified/.test(line)));
  });
});

test("doctor blocks a packet whose decided family lost certification and has no waiver", () => {
  withTempDir((dir) => {
    const result = prepareBuild(dir, ["--template-family", "olympus", "--no-run-session"]);
    const packetPath = join(result.target, "campaign-runtime.build.json");
    const packet = readJson(packetPath);
    packet.assembly.template_family = "custom";
    packet.assembly.template_certification = null;
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);

    const out = (() => {
      try {
        return execFileSync("node", [CLI, "doctor", "--packet", packetPath, "--json"], { encoding: "utf8", cwd: dir, stdio: "pipe" });
      } catch (error) {
        return String(error.stdout || "");
      }
    })();
    const doctor = JSON.parse(out);
    assert.ok(doctor.errors.some((issue) => issue.code === "assembly.template_certification"));
  });
});

test("prepare-build auto-starts the run session in the target repo", () => {
  withTempDir((dir) => {
    const result = prepareBuild(dir, ["--template-family", "olympus"]);
    const sessionPath = join(result.target, ".campaign-runtime/run-session.json");
    assert.ok(existsSync(sessionPath), "run-session.json should exist in the target repo");
    const session = readJson(sessionPath);
    assert.match(session.run_id, /^run_/);
    assert.equal(session.packet, join(result.target, "campaign-runtime.build.json"));
    assert.equal(session.last_recommendation.stage, "doctor");
    assert.deepEqual(session.last_recommendation.expected_commands, ["start", "prepare-build", "theme"]);

    // The prepare-build command itself is the run's first lifecycle entry.
    const journal = readFileSync(session.lifecycle_journal, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(journal.some((entry) => entry.command === "prepare-build" && entry.run_id === session.run_id));
  });
});

test("prepare-build --no-run-session opts out and an existing session is never replaced", () => {
  withTempDir((dir) => {
    const optedOut = prepareBuild(dir, ["--template-family", "olympus", "--no-run-session"]);
    const sessionPath = join(optedOut.target, ".campaign-runtime/run-session.json");
    assert.equal(existsSync(sessionPath), false);

    // Start an explicit session, rerun prepare-build, session must survive.
    execFileSync("node", [CLI, "run", "start", "--run-id", "run_explicit_1", "--json"], { encoding: "utf8", cwd: optedOut.target, stdio: "pipe" });
    prepareBuild(dir, ["--template-family", "olympus"]);
    const session = readJson(sessionPath);
    assert.equal(session.run_id, "run_explicit_1");
  });
});
