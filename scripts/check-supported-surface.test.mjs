import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { loadSurface, validateSurface, validateSurfaceBump } from "./check-supported-surface.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const surfaceText = (overrides = {}) =>
  JSON.stringify({
    surface_version: "1.0.0",
    package_exports: ["./campaign-spec"],
    bin: ["campaigns-os"],
    cli_commands: ["build", "qa"],
    hashed: { "schemas/demo.v0.schema.json": { sha256: sha256("demo-schema") } },
    named: ["docs/demo.md"],
    ...overrides,
  });

const packageJson = {
  exports: { "./campaign-spec": {} },
  bin: { "campaigns-os": "bin/campaigns-os.mjs" },
  files: ["schemas", "docs"],
};

const harness = (overrides = {}) => ({
  readFile: (path) => (path === "schemas/demo.v0.schema.json" ? Buffer.from("demo-schema") : null),
  fileExists: (path) => path === "docs/demo.md",
  packageJson,
  commands: ["build", "qa", "help", "extra-unsupported-is-fine"],
  ...overrides,
});

test("a fully intact surface validates clean", () => {
  const surface = loadSurface(surfaceText(), "m");
  assert.deepEqual(validateSurface(surface, harness()), []);
});

test("a hashed schema edit without a manifest update fails with the new hash in the message", () => {
  const surface = loadSurface(surfaceText(), "m");
  const errors = validateSurface(
    surface,
    harness({ readFile: () => Buffer.from("changed-schema") }),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /does not match the recorded surface hash/);
  assert.ok(errors[0].includes(sha256("changed-schema")), "message must carry the replacement hash");
});

test("a missing named surface file fails", () => {
  const surface = loadSurface(surfaceText(), "m");
  const errors = validateSurface(surface, harness({ fileExists: () => false }));
  assert.deepEqual(errors, ["docs/demo.md: named surface file missing"]);
});

test("dropping a supported export or bin entry fails", () => {
  const surface = loadSurface(surfaceText(), "m");
  const errors = validateSurface(surface, harness({ packageJson: { ...packageJson, exports: {}, bin: {} } }));
  assert.equal(errors.length, 2);
  assert.match(errors[0], /exports no longer declares supported subpath/);
  assert.match(errors[1], /bin no longer declares supported entry/);
});

test("a surface file outside package.json files[] fails pack coverage", () => {
  const surface = loadSurface(surfaceText({ named: ["skills.json"] }), "m");
  const errors = validateSurface(
    surface,
    harness({ fileExists: (path) => path === "skills.json", packageJson: { ...packageJson, files: ["schemas"] } }),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not covered by package\.json files\[\]/);
});

test("pack coverage accepts an exact-filename files[] entry (skills.json case)", () => {
  const surface = loadSurface(surfaceText({ named: ["skills.json"] }), "m");
  const errors = validateSurface(
    surface,
    harness({
      fileExists: (path) => path === "skills.json",
      packageJson: { ...packageJson, files: ["schemas", "docs", "skills.json"] },
    }),
  );
  assert.deepEqual(errors, []);
});

test("removing a supported CLI command fails; extra commands are fine", () => {
  const surface = loadSurface(surfaceText(), "m");
  const errors = validateSurface(surface, harness({ commands: ["build", "help"] }));
  assert.deepEqual(errors, ['CLI no longer dispatches supported command "qa"']);
});

test("bump gate: hashed change without a surface_version advance fails", () => {
  const oldSurface = loadSurface(surfaceText(), "m");
  const surface = loadSurface(surfaceText(), "m");
  const errors = validateSurfaceBump(oldSurface, surface, ["schemas/demo.v0.schema.json", "src/cli.mjs"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /surface_version did not advance \(1\.0\.0 -> 1\.0\.0\)/);
});

test("bump gate: hashed change with an advance passes; unrelated changes need no bump", () => {
  const oldSurface = loadSurface(surfaceText(), "m");
  const bumped = loadSurface(surfaceText({ surface_version: "1.1.0" }), "m");
  assert.deepEqual(validateSurfaceBump(oldSurface, bumped, ["schemas/demo.v0.schema.json"]), []);
  const unbumped = loadSurface(surfaceText(), "m");
  assert.deepEqual(validateSurfaceBump(oldSurface, unbumped, ["src/cli.mjs", "docs/demo.md"]), []);
});

test("bump gate: a schema REMOVED from the hashed set still requires an advance", () => {
  const oldSurface = loadSurface(
    surfaceText({
      hashed: {
        "schemas/demo.v0.schema.json": { sha256: sha256("demo-schema") },
        "schemas/gone.v0.schema.json": { sha256: sha256("gone") },
      },
    }),
    "m",
  );
  const surface = loadSurface(surfaceText(), "m");
  const errors = validateSurfaceBump(oldSurface, surface, ["schemas/gone.v0.schema.json"]);
  assert.equal(errors.length, 1);
});

test("loadSurface rejects malformed manifests", () => {
  assert.throws(() => loadSurface("not json", "m"), /invalid JSON/);
  assert.throws(() => loadSurface(JSON.stringify({ surface_version: "1.0.0" }), "m"), /malformed hashed/);
  assert.throws(() => loadSurface(surfaceText({ surface_version: "v1" }), "m"), /invalid semver/);
  assert.throws(() => loadSurface(surfaceText({ named: "docs/demo.md" }), "m"), /named must be an array/);
});
