// `campaigns-os tooling status`: the pin checks (ADR 0002, campaigns-os#466).
//
// One executable per project: the project's exact devDependency first, the
// kernel version the Build Packet records second. Every case spawns a real
// package install of this checkout staged inside a temporary project, so the
// running version is the installed copy's own package.json and the project
// pin is read the way it would be in a campaign repo — from the nearest
// package.json above the working directory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { stageRealPackageInstall } from "./package-install-fixture.mjs";
import { evaluatePin } from "./cli.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNNING = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const OLDER = "1.0.0";
const PACKAGE = "@nextcommerce/campaigns-os";

let scratch;
let skillsTarget;

before(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "campaigns-os-pin-checks-")));
  // A skills target that is already fresh, so a clean pin exits 0 on its own
  // account rather than 2 for stale skills the disposable target would have.
  skillsTarget = join(scratch, "skills");
  mkdirSync(skillsTarget);
  const install = spawnSync(process.execPath, [join(ROOT, "bin", "campaigns-os.mjs"), "install-skills", "--target", skillsTarget, "--json"], { encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
});

after(() => rmSync(scratch, { recursive: true, force: true }));

let projectCount = 0;
// A campaign project with this package installed under node_modules, an
// optional pin in package.json and an optional packet at the contracted home.
function project({ devDependency, dependency, packetVersion } = {}) {
  const dir = join(scratch, `project-${projectCount += 1}`);
  mkdirSync(dir);
  const cli = join(stageRealPackageInstall(dir), "bin", "campaigns-os.mjs");
  const manifest = { name: "campaign-fixture", private: true };
  if (devDependency !== undefined) manifest.devDependencies = { [PACKAGE]: devDependency };
  if (dependency !== undefined) manifest.dependencies = { [PACKAGE]: dependency };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (packetVersion !== undefined) {
    writeFileSync(join(dir, "campaign-runtime.build.json"), `${JSON.stringify({
      schema_version: "campaign-runtime-build-packet/v0",
      ...(packetVersion === null ? {} : { campaigns_os_version: packetVersion }),
    }, null, 2)}\n`);
  }
  return { dir, cli };
}

function status({ dir, cli }, extra = [], { cwd = dir } = {}) {
  const run = spawnSync(process.execPath, [cli, "tooling", "status", "--target", skillsTarget, ...extra], { cwd, encoding: "utf8" });
  const stdout = run.stdout ?? "";
  return { ...run, stdout, json: stdout.trimStart().startsWith("{") ? JSON.parse(stdout) : null };
}

test("pin-checks: an exact project pin equal to the running version is a match", () => {
  const fixture = project({ devDependency: RUNNING });
  const run = status(fixture, ["--json"]);
  assert.deepEqual(run.json.pin, {
    source: "project",
    version: RUNNING,
    running: RUNNING,
    status: "match",
    range: null,
    packet_version: null,
    project_version: RUNNING,
    forced: false,
    message: `match (${RUNNING}, project devDependency)`,
  }, run.stderr);
  assert.equal(run.status, 0, run.stdout);

  const text = status(fixture);
  assert.match(text.stdout, new RegExp(`^Pin: match \\(${RUNNING.replace(/\./g, "\\.")}, project devDependency\\)$`, "m"));
});

test("pin-checks: dependencies is the fallback when devDependencies does not name the package", () => {
  const run = status(project({ dependency: RUNNING }), ["--json"]);
  assert.equal(run.json.pin.status, "match", run.stderr);
  assert.equal(run.json.pin.source, "project");
});

test("pin-checks: a project pin behind the running version is stale_pin, exits 2 and names package.json", () => {
  const fixture = project({ devDependency: OLDER });
  const run = status(fixture, ["--json"]);
  assert.equal(run.json.pin.status, "stale_pin", run.stderr);
  assert.equal(run.json.pin.version, OLDER);
  assert.equal(run.json.pin.running, RUNNING);
  assert.equal(run.json.pin.forced, false);
  assert.equal(run.status, 2);
  assert.ok(
    run.json.actions.some((action) => action.includes(join(fixture.dir, "package.json")) && action.includes("--force")),
    `the action names the file to change: ${JSON.stringify(run.json.actions)}`,
  );

  const text = status(fixture);
  assert.equal(text.status, 2);
  assert.match(text.stdout, new RegExp(`^Pin: stale_pin — project pins ${OLDER.replace(/\./g, "\\.")}, running ${RUNNING.replace(/\./g, "\\.")}$`, "m"));
  assert.match(text.stdout, /Install mode:/, "the full status still prints");
});

test("pin-checks: --force overrides stale_pin, exits as the rest of the status dictates and is on the journal entry", () => {
  const fixture = project({ devDependency: OLDER });
  const journal = join(fixture.dir, "lifecycle.jsonl");
  const run = status(fixture, ["--force", "--lifecycle-journal", journal, "--json"]);
  assert.equal(run.json.pin.status, "stale_pin", run.stderr);
  assert.equal(run.json.pin.forced, true);
  assert.equal(run.status, 0, JSON.stringify(run.json.actions));
  assert.ok(run.json.warnings.some((warning) => warning.includes("overridden by --force")));

  const entries = readFileSync(journal, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].command, "tooling");
  assert.ok(entries[0].argv_shape.includes("--force"), `argv_shape records the override: ${JSON.stringify(entries[0].argv_shape)}`);
  assert.equal(entries[0].exit_status, 0);
});

test("pin-checks: a project pin and a packet version that differ are conflicting_pin and exit 2", () => {
  // The project pin equals the running version, so the only thing wrong is
  // that the two sources disagree.
  const fixture = project({ devDependency: RUNNING, packetVersion: OLDER });
  const run = status(fixture, ["--json"]);
  assert.equal(run.json.pin.status, "conflicting_pin", run.stderr);
  assert.equal(run.json.pin.source, "project", "the project pin still has precedence");
  assert.equal(run.json.pin.project_version, RUNNING);
  assert.equal(run.json.pin.packet_version, OLDER);
  assert.equal(run.status, 2);
  assert.ok(run.json.actions.some((action) => action.includes(join(fixture.dir, "package.json")) && action.includes(join(fixture.dir, "campaign-runtime.build.json"))));

  const text = status(fixture);
  assert.match(text.stdout, new RegExp(`^Pin: conflicting_pin — project pins ${RUNNING.replace(/\./g, "\\.")}, packet records ${OLDER.replace(/\./g, "\\.")}$`, "m"));

  const forced = status(fixture, ["--force", "--json"]);
  assert.equal(forced.json.pin.forced, true);
  assert.equal(forced.status, 0);
});

test("pin-checks: equal project and packet versions report source project", () => {
  const run = status(project({ devDependency: RUNNING, packetVersion: RUNNING }), ["--json"]);
  assert.equal(run.json.pin.status, "match", run.stderr);
  assert.equal(run.json.pin.source, "project");
  assert.equal(run.json.pin.packet_version, RUNNING);
});

test("pin-checks: a packet version with no project pin is the pin, source packet", () => {
  const run = status(project({ packetVersion: RUNNING }), ["--json"]);
  assert.equal(run.json.pin.status, "match", run.stderr);
  assert.equal(run.json.pin.source, "packet");
  assert.equal(run.json.pin.version, RUNNING);
  assert.equal(run.json.pin.project_version, null);
  assert.equal(run.status, 0);

  const stale = status(project({ packetVersion: OLDER }), ["--json"]);
  assert.equal(stale.json.pin.status, "stale_pin");
  assert.equal(stale.json.pin.source, "packet");
  assert.equal(stale.status, 2);
});

test("pin-checks: --packet names the packet and its project, whatever the cwd", () => {
  const fixture = project({ devDependency: RUNNING, packetVersion: OLDER });
  const run = status(fixture, ["--packet", join(fixture.dir, "campaign-runtime.build.json"), "--json"], { cwd: scratch });
  assert.equal(run.json.pin.status, "conflicting_pin", run.stderr);

  const missing = status(fixture, ["--packet", join(fixture.dir, "nowhere.build.json"), "--json"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Build Packet not found/);
});

test("pin-checks: neither source is unpinned, exits 0 and is still reported", () => {
  // A packet written before the field existed is no packet source.
  const fixture = project({ packetVersion: null });
  const run = status(fixture, ["--json"]);
  assert.deepEqual(run.json.pin, {
    source: null,
    version: null,
    running: RUNNING,
    status: "unpinned",
    range: null,
    packet_version: null,
    project_version: null,
    forced: false,
    message: "unpinned (no project devDependency, no packet version)",
  }, run.stderr);
  assert.equal(run.status, 0);

  const text = status(fixture);
  assert.match(text.stdout, /^Pin: unpinned \(no project devDependency, no packet version\)$/m);
});

test("pin-checks: a range is not a pin — unpinned, with the range reported", () => {
  const run = status(project({ devDependency: "^1.40.0" }), ["--json"]);
  assert.equal(run.json.pin.status, "unpinned", run.stderr);
  assert.equal(run.json.pin.range, "^1.40.0");
  assert.equal(run.json.pin.project_version, null);
  assert.equal(run.status, 0);
  assert.equal(run.json.pin.message, "unpinned (project range ^1.40.0 is not an exact version, no packet version)");
});

test("pin-checks: run from a subdirectory of the project, the same pin resolves", () => {
  const fixture = project({ devDependency: OLDER, packetVersion: OLDER });
  const nested = join(fixture.dir, "src", "campaign");
  mkdirSync(nested, { recursive: true });
  const fromRoot = status(fixture, ["--json"]);
  const fromNested = status(fixture, ["--json"], { cwd: nested });
  assert.equal(fromNested.json.pin.status, "stale_pin", fromNested.stderr);
  assert.deepEqual(fromNested.json.pin, fromRoot.json.pin);
});

test("pin-checks: --force takes no value", () => {
  const fixture = project({ devDependency: OLDER });
  const journal = join(fixture.dir, "lifecycle.jsonl");
  const run = status(fixture, ["--force", "true", "--lifecycle-journal", journal, "--json"]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--force takes no value/);
  assert.doesNotMatch(run.stdout, /"pin"/);
  // A refused invocation never journals, so no override is recorded either.
  assert.equal(existsSync(journal), false);
});

test("pin-checks: evaluatePin — precedence and the four statuses without a spawn", () => {
  assert.equal(evaluatePin({ projectSpec: "2.0.0", packetVersion: "2.0.0", running: "2.0.0" }).source, "project");
  assert.equal(evaluatePin({ projectSpec: "2.0.0", packetVersion: "1.9.0", running: "2.0.0" }).status, "conflicting_pin");
  assert.equal(evaluatePin({ projectSpec: "latest", packetVersion: "1.9.0", running: "2.0.0" }).status, "stale_pin");
  assert.equal(evaluatePin({ projectSpec: "latest", running: "2.0.0" }).range, "latest");
  // --force is recorded only when it overrode something.
  assert.equal(evaluatePin({ projectSpec: "2.0.0", running: "2.0.0", force: true }).forced, false);
  assert.equal(evaluatePin({ projectSpec: "1.0.0", running: "2.0.0", force: true }).forced, true);
});

test("pin-checks: prepare-build stamps campaigns_os_version, and tooling status reads it as the packet pin", () => {
  const dir = join(scratch, "prepared");
  const source = join(dir, "source");
  const target = join(dir, "target");
  const specPath = join(dir, "campaignspec.json");
  mkdirSync(join(source, ".campaigns-os"), { recursive: true });
  mkdirSync(target, { recursive: true });
  const pages = { "landing.html": "<main><h1>Landing</h1></main>\n", "checkout.html": "<main><h1>Checkout</h1></main>\n" };
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  for (const [path, content] of Object.entries(pages)) writeFileSync(join(source, path), content);
  writeFileSync(join(source, ".campaigns-os/source-html-manifest.json"), JSON.stringify({
    schema_version: "source-html-manifest/v0",
    generated_at: "2026-09-23T00:00:00.000Z",
    generator: "fixture-exporter@1.0.0",
    campaign_slug: "pin-fixture",
    files: Object.keys(pages).map((path) => ({ path, role: "page", sha256: sha(pages[path]) })),
    pages: [
      { page_id: "landing", page_type: "landing", page_url: "landing/", path: "landing.html", source_hash: sha(pages["landing.html"]) },
      { page_id: "checkout", page_type: "checkout", page_url: "checkout/", path: "checkout.html", source_hash: sha(pages["checkout.html"]) },
    ],
  }));
  writeFileSync(specPath, JSON.stringify({
    spec_identity: { map_id: "map-pin-fixture", public_route_slug: "pin-fixture" },
    campaign: { id: "pin-fixture", slug: "pin-fixture" },
    funnels: [{
      id: "default",
      weight: 100,
      pages: [
        { id: "landing", type: "landing", label: "Landing", page_url: "landing/", next_page: "checkout" },
        { id: "checkout", type: "checkout", label: "Checkout", page_url: "checkout/" },
      ],
    }],
  }));
  writeFileSync(join(target, "package.json"), JSON.stringify({ private: true }));

  const prepare = spawnSync(process.execPath, [
    join(ROOT, "bin", "campaigns-os.mjs"), "prepare-build",
    "--spec", specPath, "--source", source, "--target", target,
    "--template-family", "olympus", "--no-run-session", "--json",
  ], { cwd: dir, encoding: "utf8" });
  assert.equal(prepare.status, 0, prepare.stderr);
  const packet = JSON.parse(readFileSync(join(target, "campaign-runtime.build.json"), "utf8"));
  assert.equal(packet.campaigns_os_version, RUNNING);

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(JSON.parse(readFileSync(join(ROOT, "schemas", "campaign-runtime-build-packet.v0.schema.json"), "utf8")));
  assert.ok(validate(packet), JSON.stringify(validate.errors));
  // Packets written before the field existed stay valid.
  const { campaigns_os_version: _stamped, ...legacy } = packet;
  assert.ok(validate(legacy), JSON.stringify(validate.errors));
  assert.equal(validate({ ...packet, campaigns_os_version: "^1.0.0" }), false, "only an exact version is a recorded kernel version");

  const run = spawnSync(process.execPath, [join(ROOT, "bin", "campaigns-os.mjs"), "tooling", "status", "--target", skillsTarget, "--json"], { cwd: target, encoding: "utf8" });
  const pin = JSON.parse(run.stdout).pin;
  assert.equal(pin.source, "packet", run.stderr);
  assert.equal(pin.status, "match");
  assert.equal(pin.packet_version, RUNNING);
});
