import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

// ADR-003 D4: the doctor emits campaign-spec rule violations under the single
// `spec.validation` code, but preserves rule identity in `detail`. This test
// drives the real CLI against a deliberately-broken spec and asserts the
// enriched detail survives to JSON consumers.
function runDoctorJson(packetPath) {
  try {
    const out = execFileSync("node", [CLI, "doctor", "--packet", packetPath, "--json"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return JSON.parse(out);
  } catch (err) {
    // doctor exits non-zero when it finds errors; the JSON report is still on stdout.
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

test("doctor spec.validation findings carry detail {ruleId, path}", () => {
  const dir = mkdtempSync(join(tmpdir(), "adr003-specval-"));
  try {
    // empty-funnels is a known-broken fixture: it trips campaign-spec rules.
    cpSync(join(ROOT, "campaign-spec/fixtures/empty-funnels.json"), join(dir, "broken.json"));
    const packet = JSON.parse(readFileSync(join(ROOT, "examples/build-packet.basic.json"), "utf8"));
    packet.spec.local_path = "broken.json";
    writeFileSync(join(dir, "packet.json"), JSON.stringify(packet, null, 2));

    const result = runDoctorJson(join(dir, "packet.json"));
    const issues = [...(result.errors || []), ...(result.warnings || [])];
    const specValidation = issues.filter((i) => i.code === "spec.validation");

    assert.ok(specValidation.length > 0, "expected at least one spec.validation finding");
    for (const issue of specValidation) {
      assert.ok(issue.detail, "spec.validation issue should carry detail");
      assert.equal(typeof issue.detail.ruleId, "string", "detail.ruleId should be a string");
      assert.ok("path" in issue.detail, "detail should include a JSON-pointer path");
    }
    // At least one finding maps to a concrete rule id (not a generic blob).
    assert.ok(
      specValidation.some((i) => i.detail.ruleId && i.detail.ruleId.length > 0),
      "expected a concrete ruleId in detail"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed spec.local_path is reported as malformed, not as an absent path", () => {
  const dir = mkdtempSync(join(tmpdir(), "specpath-shape-"));
  try {
    const base = JSON.parse(readFileSync(join(ROOT, "examples/build-packet.basic.json"), "utf8"));

    // Present but unusable: the packet declares the field with the wrong shape.
    const malformed = JSON.parse(JSON.stringify(base));
    malformed.spec.local_path = 42;
    writeFileSync(join(dir, "malformed.json"), JSON.stringify(malformed, null, 2));
    const malformedIssue = (runDoctorJson(join(dir, "malformed.json")).errors || [])
      .find((issue) => issue.code === "spec.local_path");
    assert.ok(malformedIssue, "a malformed local_path must still block");
    assert.match(malformedIssue.message, /must be a non-empty string/);
    assert.match(malformedIssue.message, /number/);

    // Absent: the field is not declared at all.
    const missing = JSON.parse(JSON.stringify(base));
    delete missing.spec.local_path;
    writeFileSync(join(dir, "missing.json"), JSON.stringify(missing, null, 2));
    const missingIssue = (runDoctorJson(join(dir, "missing.json")).errors || [])
      .find((issue) => issue.code === "spec.local_path");
    assert.ok(missingIssue, "an absent local_path must still block");
    assert.match(missingIssue.message, /No local CampaignSpec path is present/);

    // Same blocking code, different repair — that is the whole point.
    assert.notEqual(malformedIssue.message, missingIssue.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
