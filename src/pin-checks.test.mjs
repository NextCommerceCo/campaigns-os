// `campaigns-os tooling status`: the pin checks (ADR 0002, campaigns-os#466).
//
// One executable per project: the project's first exact spec on the manifest
// walk first, the kernel version the Build Packet records second. Every case spawns a real
// package install of this checkout staged inside a temporary project, so the
// running version is the installed copy's own package.json and the project
// pin is read the way it would be in a campaign repo — from the nearest
// package.json above the working directory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// A further manifest on the walk: a workspace package or an enclosing root.
function writeManifest(dir, fields = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "package.json");
  writeFileSync(path, `${JSON.stringify({ name: "campaign-fixture-part", private: true, ...fields }, null, 2)}\n`);
  return path;
}

function writePacket(dir, version) {
  writeFileSync(join(dir, "campaign-runtime.build.json"), `${JSON.stringify({ schema_version: "campaign-runtime-build-packet/v0", campaigns_os_version: version }, null, 2)}\n`);
}

// The one `Pin:` line of a text run; every status names where it read from.
function pinLine(stdout) {
  const lines = stdout.split("\n").filter((line) => line.startsWith("Pin: "));
  assert.equal(lines.length, 1, stdout);
  return lines[0];
}

function assertNames(line, ...parts) {
  for (const part of parts) assert.ok(line.includes(part), `${JSON.stringify(line)} names ${part}`);
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
    packet_version_ignored: null,
    project_version: RUNNING,
    project_manifest: join(fixture.dir, "package.json"),
    project_key: "devDependencies",
    forced: false,
    message: `match (${RUNNING} — devDependencies in ${join(fixture.dir, "package.json")})`,
  }, run.stderr);
  assert.equal(run.status, 0, run.stdout);

  const text = status(fixture);
  assert.equal(pinLine(text.stdout), `Pin: match (${RUNNING} — devDependencies in ${join(fixture.dir, "package.json")})`);
});

test("pin-checks: dependencies is the fallback when devDependencies does not name the package", () => {
  const fixture = project({ dependency: RUNNING });
  const run = status(fixture, ["--json"]);
  assert.equal(run.json.pin.status, "match", run.stderr);
  assert.equal(run.json.pin.source, "project");
  assert.equal(run.json.pin.project_key, "dependencies");
  assert.equal(run.json.pin.message, `match (${RUNNING} — dependencies in ${join(fixture.dir, "package.json")})`);
  assert.equal(pinLine(status(fixture).stdout), `Pin: match (${RUNNING} — dependencies in ${join(fixture.dir, "package.json")})`);
});

test("pin-checks: a pin read from dependencies is labelled and remediated as dependencies", () => {
  const fixture = project({ dependency: OLDER });
  const run = status(fixture, ["--json"]);
  assert.equal(run.json.pin.status, "stale_pin", run.stderr);
  assert.equal(run.json.pin.project_key, "dependencies");
  const action = run.json.actions.find((line) => line.includes("--force"));
  assert.ok(action?.includes(`set dependencies["${PACKAGE}"] in ${join(fixture.dir, "package.json")}`), `the action names the key consulted: ${JSON.stringify(run.json.actions)}`);
  assert.ok(!action.includes("devDependencies"), action);
  // The pinned copy is named with the spelling that cannot install one.
  assert.ok(action.startsWith("Run the pinned executable (npx --no-install campaigns-os from the project)"), action);
  assert.equal(pinLine(status(fixture).stdout), `Pin: stale_pin — project pins ${OLDER} (dependencies in ${join(fixture.dir, "package.json")}), running ${RUNNING}`);
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
  assert.equal(pinLine(text.stdout), `Pin: stale_pin — project pins ${OLDER} (devDependencies in ${join(fixture.dir, "package.json")}), running ${RUNNING}`);
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
  assert.equal(pinLine(status(fixture, ["--force"]).stdout), `Pin: stale_pin — project pins ${OLDER} (devDependencies in ${join(fixture.dir, "package.json")}), running ${RUNNING} (overridden by --force)`);

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
  assert.equal(pinLine(text.stdout), `Pin: conflicting_pin — project pins ${RUNNING} (devDependencies in ${join(fixture.dir, "package.json")}), packet records ${OLDER} (campaigns_os_version in ${join(fixture.dir, "campaign-runtime.build.json")})`);

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
  const fixture = project({ packetVersion: RUNNING });
  const run = status(fixture, ["--json"]);
  assert.equal(run.json.pin.status, "match", run.stderr);
  assert.equal(run.json.pin.source, "packet");
  assert.equal(run.json.pin.version, RUNNING);
  assert.equal(run.json.pin.project_version, null);
  assert.equal(run.status, 0);
  assert.equal(pinLine(status(fixture).stdout), `Pin: match (${RUNNING} — campaigns_os_version in ${join(fixture.dir, "campaign-runtime.build.json")})`);

  const staleFixture = project({ packetVersion: OLDER });
  const stale = status(staleFixture, ["--json"]);
  assert.equal(stale.json.pin.status, "stale_pin");
  assert.equal(stale.json.pin.source, "packet");
  assert.equal(stale.status, 2);
  assert.equal(pinLine(status(staleFixture).stdout), `Pin: stale_pin — packet records ${OLDER} (campaigns_os_version in ${join(staleFixture.dir, "campaign-runtime.build.json")}), running ${RUNNING}`);
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
    packet_version_ignored: null,
    project_version: null,
    project_manifest: join(fixture.dir, "package.json"),
    project_key: null,
    forced: false,
    message: `unpinned (no project pin in ${join(fixture.dir, "package.json")}; no campaigns_os_version in ${join(fixture.dir, "campaign-runtime.build.json")})`,
  }, run.stderr);
  assert.equal(run.status, 0);

  const text = status(fixture);
  assert.equal(pinLine(text.stdout), `Pin: unpinned (no project pin in ${join(fixture.dir, "package.json")}; no campaigns_os_version in ${join(fixture.dir, "campaign-runtime.build.json")})`);

  const bare = project();
  assert.equal(pinLine(status(bare).stdout), `Pin: unpinned (no project pin in ${join(bare.dir, "package.json")}; no packet version)`);
});

test("pin-checks: a range is not a pin — unpinned, with the range reported", () => {
  const fixture = project({ devDependency: "^1.40.0" });
  const run = status(fixture, ["--json"]);
  assert.equal(run.json.pin.status, "unpinned", run.stderr);
  assert.equal(run.json.pin.range, "^1.40.0");
  assert.equal(run.json.pin.project_version, null);
  assert.equal(run.status, 0);
  const message = `unpinned (project range ^1.40.0 (devDependencies in ${join(fixture.dir, "package.json")}) is not an exact version; no packet version)`;
  assert.equal(run.json.pin.message, message);
  assert.equal(pinLine(status(fixture).stdout), `Pin: ${message}`);
});

test("pin-checks: c1 — a range in devDependencies does not mask an exact pin in dependencies", () => {
  const fixture = project({ devDependency: "^1.40.0", dependency: OLDER, packetVersion: RUNNING });
  const run = status(fixture, ["--json"]);
  assert.equal(run.json.pin.status, "conflicting_pin", run.stderr);
  assert.equal(run.json.pin.project_version, OLDER);
  assert.equal(run.json.pin.project_key, "dependencies");
  assert.equal(run.json.pin.project_manifest, join(fixture.dir, "package.json"));
  assert.equal(run.json.pin.range, null);
  assert.ok(run.json.actions.some((action) => action.includes(`set dependencies["${PACKAGE}"] in ${join(fixture.dir, "package.json")}`)), JSON.stringify(run.json.actions));
});

test("pin-checks: c2 — an empty devDependencies spec is absent, so the exact pin in dependencies is used", () => {
  const run = status(project({ devDependency: "", dependency: OLDER }), ["--json"]);
  assert.equal(run.json.pin.status, "stale_pin", run.stderr);
  assert.equal(run.json.pin.source, "project");
  assert.equal(run.json.pin.project_version, OLDER);
  assert.equal(run.json.pin.project_key, "dependencies");
  assert.equal(run.json.pin.range, null);
});

test("pin-checks: a whitespace-only spec with nothing else is unpinned, never a range", () => {
  const fixture = project({ devDependency: "   " });
  const run = status(fixture, ["--json"]);
  assert.equal(run.json.pin.status, "unpinned", run.stderr);
  assert.equal(run.json.pin.range, null);
  assert.equal(run.json.pin.project_key, null);
  assert.equal(run.json.pin.message, `unpinned (no project pin in ${join(fixture.dir, "package.json")}; no packet version)`);
});

test("pin-checks: a range in dependencies alone is reported as a dependencies range", () => {
  const fixture = project({ dependency: "^1.40.0" });
  const run = status(fixture, ["--json"]);
  assert.equal(run.json.pin.status, "unpinned", run.stderr);
  assert.equal(run.json.pin.project_key, "dependencies");
  assert.equal(run.json.pin.range, "^1.40.0");
  assert.equal(run.json.pin.project_version, null);
  const message = `unpinned (project range ^1.40.0 (dependencies in ${join(fixture.dir, "package.json")}) is not an exact version; no packet version)`;
  assert.equal(run.json.pin.message, message);
  assert.equal(pinLine(status(fixture).stdout), `Pin: ${message}`);
});

test("pin-checks: c3 — =x.y.z and vx.y.z are exact pins, as npm reads them", () => {
  for (const spec of [`=${RUNNING}`, `v${RUNNING}`]) {
    const run = status(project({ devDependency: spec }), ["--json"]);
    assert.equal(run.json.pin.status, "match", `${spec}: ${run.stderr}`);
    assert.equal(run.json.pin.project_version, RUNNING, spec);
    assert.equal(run.json.pin.range, null, spec);
  }
});

test("pin-checks: c4 — a workspace package without the entry resolves the workspace root's pin", () => {
  const root = project({ devDependency: OLDER });
  writeManifest(root.dir, { name: "campaign-fixture", private: true, workspaces: ["packages/*"], devDependencies: { [PACKAGE]: OLDER } });
  const app = join(root.dir, "packages", "app");
  writeManifest(app);
  writePacket(app, RUNNING);
  const run = status(root, ["--json"], { cwd: app });
  assert.equal(run.json.pin.status, "conflicting_pin", run.stderr);
  assert.equal(run.json.pin.project_version, OLDER);
  assert.equal(run.json.pin.packet_version, RUNNING);
  assert.equal(run.json.pin.project_manifest, join(root.dir, "package.json"));
  assert.equal(run.json.pin.project_key, "devDependencies");
  assert.ok(run.json.actions.some((action) => action.includes(join(root.dir, "package.json")) && action.includes(join(app, "campaign-runtime.build.json"))), JSON.stringify(run.json.actions));
  assertNames(pinLine(status(root, [], { cwd: app }).stdout), `devDependencies in ${join(root.dir, "package.json")}`, `campaigns_os_version in ${join(app, "campaign-runtime.build.json")}`);
});

test("pin-checks: a nested manifest that declares the entry wins over the root", () => {
  const root = project();
  writeManifest(root.dir, { name: "campaign-fixture", private: true, workspaces: ["packages/*"], devDependencies: { [PACKAGE]: OLDER } });
  const app = join(root.dir, "packages", "app");
  const appManifest = writeManifest(app, { devDependencies: { [PACKAGE]: RUNNING } });
  const run = status(root, ["--json"], { cwd: app });
  assert.equal(run.json.pin.status, "match", run.stderr);
  assert.equal(run.json.pin.project_version, RUNNING);
  assert.equal(run.json.pin.project_manifest, appManifest);
});

test("pin-checks: a range at the nearest manifest yields to an exact pin at the root", () => {
  const root = project({ dependency: OLDER });
  const app = join(root.dir, "packages", "app");
  writeManifest(app, { devDependencies: { [PACKAGE]: "^1.40.0" } });
  const run = status(root, ["--json"], { cwd: app });
  assert.equal(run.json.pin.status, "stale_pin", run.stderr);
  assert.equal(run.json.pin.project_version, OLDER);
  assert.equal(run.json.pin.range, null);
  assert.equal(run.json.pin.project_manifest, join(root.dir, "package.json"));
  assert.equal(run.json.pin.project_key, "dependencies");
});

test("pin-checks: a neutral ancestor that names nothing and declares no workspaces is walked through to the pin above it", () => {
  const root = project({ devDependency: OLDER });
  const middle = join(root.dir, "vendor");
  writeManifest(middle);
  const app = join(middle, "app");
  writeManifest(app);
  const run = status(root, ["--json"], { cwd: app });
  assert.equal(run.json.pin.status, "stale_pin", run.stderr);
  assert.equal(run.json.pin.project_version, OLDER);
  assert.equal(run.json.pin.project_manifest, join(root.dir, "package.json"));
  assert.equal(run.json.pin.project_key, "devDependencies");
});

test("pin-checks: a package nested inside a workspace package resolves the workspace root's pin", () => {
  const root = project();
  writeManifest(root.dir, { name: "campaign-fixture", private: true, workspaces: ["packages/*"], devDependencies: { [PACKAGE]: OLDER } });
  const app = join(root.dir, "packages", "app");
  writeManifest(app);
  const sub = join(app, "sub");
  writeManifest(sub);
  const run = status(root, ["--json"], { cwd: sub });
  assert.equal(run.json.pin.status, "stale_pin", run.stderr);
  assert.equal(run.json.pin.project_version, OLDER);
  assert.equal(run.json.pin.project_manifest, join(root.dir, "package.json"));
  assert.equal(run.json.pin.project_key, "devDependencies");
});

test("pin-checks: object-form workspaces ({ packages: [...] }) is a workspace root — the walk ends there", () => {
  const outer = project({ devDependency: OLDER });
  const ws = join(outer.dir, "ws");
  writeManifest(ws, { workspaces: { packages: ["packages/*"] } });
  const app = join(ws, "packages", "app");
  const appManifest = writeManifest(app);
  const run = status(outer, ["--json"], { cwd: app });
  assert.equal(run.json.pin.status, "unpinned", run.stderr);
  assert.equal(run.json.pin.project_manifest, appManifest);
  assert.equal(run.json.pin.project_key, null);
  assert.equal(run.json.pin.project_version, null);
  assert.ok(!pinLine(status(outer, [], { cwd: app }).stdout).includes(join(outer.dir, "package.json")));
});

test("pin-checks: a symlinked package.json resolves through the link", () => {
  const fixture = project();
  const real = writeManifest(join(scratch, `linked-manifest-${projectCount}`), { devDependencies: { [PACKAGE]: RUNNING } });
  rmSync(join(fixture.dir, "package.json"));
  symlinkSync(real, join(fixture.dir, "package.json"));
  const run = status(fixture, ["--json"]);
  assert.equal(run.json.pin.status, "match", run.stderr);
  assert.equal(run.json.pin.project_version, RUNNING);
  assert.equal(run.json.pin.project_manifest, join(fixture.dir, "package.json"));
});

test("pin-checks: peerDependencies and optionalDependencies are not a project pin", () => {
  const fixture = project();
  writeManifest(fixture.dir, { name: "campaign-fixture", private: true, peerDependencies: { [PACKAGE]: RUNNING }, optionalDependencies: { [PACKAGE]: RUNNING } });
  const run = status(fixture, ["--json"]);
  assert.equal(run.json.pin.status, "unpinned", run.stderr);
  assert.equal(run.json.pin.project_key, null);
  assert.equal(run.json.pin.range, null);
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

test("pin-checks: the walk ends at a workspace root — an exact pin above it is never read", () => {
  const outer = project({ devDependency: OLDER });
  // A workspace root holding only a range: the range is reported, not the outer pin.
  const ranged = join(outer.dir, "ranged");
  const rangedManifest = writeManifest(ranged, { workspaces: ["packages/*"], devDependencies: { [PACKAGE]: "^1.40.0" } });
  const rangedApp = join(ranged, "packages", "app");
  writeManifest(rangedApp);
  const fromApp = status(outer, ["--json"], { cwd: rangedApp });
  assert.equal(fromApp.json.pin.status, "unpinned", fromApp.stderr);
  assert.equal(fromApp.json.pin.project_manifest, rangedManifest);
  assert.equal(fromApp.json.pin.range, "^1.40.0");
  assert.equal(fromApp.json.pin.project_version, null);
  assert.ok(!pinLine(status(outer, [], { cwd: rangedApp }).stdout).includes(join(outer.dir, "package.json")));

  // A workspace root naming nothing: unpinned at the root itself.
  const empty = join(outer.dir, "empty");
  const emptyManifest = writeManifest(empty, { workspaces: ["packages/*"] });
  const fromRoot = status(outer, ["--json"], { cwd: empty });
  assert.equal(fromRoot.json.pin.status, "unpinned", fromRoot.stderr);
  assert.equal(fromRoot.json.pin.project_manifest, emptyManifest);
  assert.equal(fromRoot.json.pin.project_key, null);
  assert.equal(fromRoot.json.pin.project_version, null);
  assert.equal(pinLine(status(outer, [], { cwd: empty }).stdout), `Pin: unpinned (no project pin in ${emptyManifest}; no packet version)`);
});

test("pin-checks: run from inside node_modules, the enclosing project's pin resolves", () => {
  // A plain project: the installed package's own package.json is not the project.
  const fixture = project({ devDependency: OLDER, packetVersion: OLDER });
  const installed = join(fixture.dir, "node_modules", "@nextcommerce", "campaigns-os");
  const run = status(fixture, ["--json"], { cwd: installed });
  assert.equal(run.json.pin.status, "stale_pin", run.stderr);
  assert.equal(run.json.pin.project_manifest, join(fixture.dir, "package.json"));
  assert.equal(run.json.pin.project_key, "devDependencies");
  assert.equal(run.json.pin.packet_version, OLDER, "the packet home is the enclosing project's");
  assert.deepEqual(run.json.pin, status(fixture, ["--json"]).json.pin);

  // A workspace package: its own node_modules resolves through it to the root's pin.
  const root = project();
  writeManifest(root.dir, { name: "campaign-fixture", private: true, workspaces: ["packages/*"], dependencies: { [PACKAGE]: RUNNING } });
  const app = join(root.dir, "packages", "app");
  writeManifest(app);
  const nested = join(app, "node_modules", "@nextcommerce", "campaigns-os");
  writeManifest(nested, { name: PACKAGE, version: OLDER });
  const fromNested = status(root, ["--json"], { cwd: nested });
  assert.equal(fromNested.json.pin.status, "match", fromNested.stderr);
  assert.equal(fromNested.json.pin.project_manifest, join(root.dir, "package.json"));
  assert.equal(fromNested.json.pin.project_key, "dependencies");
  assertNames(pinLine(status(root, [], { cwd: nested }).stdout), `dependencies in ${join(root.dir, "package.json")}`);
});

test("pin-checks: an installed package's own manifest is skipped, scoped or not, from a cwd inside it", () => {
  const fixture = project({ devDependency: OLDER });
  // Each would be a match if the walk read it as the project.
  for (const installed of [join(fixture.dir, "node_modules", "x"), join(fixture.dir, "node_modules", "@s", "x")]) {
    writeManifest(installed, { name: "x", version: "1.0.0", devDependencies: { [PACKAGE]: RUNNING } });
    const lib = join(installed, "lib");
    mkdirSync(lib, { recursive: true });
    for (const cwd of [installed, lib]) {
      const run = status(fixture, ["--json"], { cwd });
      assert.equal(run.json.pin.status, "stale_pin", `${cwd}: ${run.stderr}`);
      assert.equal(run.json.pin.project_manifest, join(fixture.dir, "package.json"), cwd);
      assert.equal(run.json.pin.project_version, OLDER, cwd);
    }
  }
});

test("pin-checks: a project whose own path has a node_modules segment resolves its own pin", () => {
  const fixture = project();
  const site = join(scratch, `nested-${projectCount}`, "node_modules", "work", "site");
  const siteManifest = writeManifest(site, { devDependencies: { [PACKAGE]: RUNNING } });
  writePacket(site, RUNNING);
  const run = status(fixture, ["--json"], { cwd: site });
  assert.equal(run.json.pin.status, "match", run.stderr);
  assert.equal(run.json.pin.project_version, RUNNING);
  assert.equal(run.json.pin.project_manifest, siteManifest);
  assert.equal(run.json.pin.packet_version, RUNNING, "the packet home is beside the project's own manifest");
  assert.deepEqual(run.json.warnings.filter((warning) => warning.startsWith("Project pin") || warning.startsWith("Packet")), []);
  assert.equal(pinLine(status(fixture, [], { cwd: site }).stdout), `Pin: match (${RUNNING} — devDependencies in ${siteManifest})`);
});

test("pin-checks: a packet campaigns_os_version with an = or v prefix is ignored, and the Pin line says so", () => {
  for (const recorded of [`=${RUNNING}`, `v${RUNNING}`]) {
    // No project pin: the packet would be the pin if the prefix were accepted.
    const bare = project({ packetVersion: recorded });
    const packetPath = join(bare.dir, "campaign-runtime.build.json");
    const run = status(bare, ["--json"]);
    const message = `unpinned (no project pin in ${join(bare.dir, "package.json")}; campaigns_os_version ${JSON.stringify(recorded)} in ${packetPath} is not a bare x.y.z version and was ignored)`;
    assert.equal(run.json.pin.status, "unpinned", `${recorded}: ${run.stderr}`);
    assert.equal(run.json.pin.source, null, recorded);
    assert.equal(run.json.pin.packet_version, null, recorded);
    assert.equal(run.json.pin.packet_version_ignored, recorded);
    assert.equal(run.json.pin.message, message);
    assert.ok(run.json.warnings.some((warning) => warning.includes(packetPath) && warning.includes("ignored")), JSON.stringify(run.json.warnings));
    assert.equal(pinLine(status(bare).stdout), `Pin: ${message}`);

    // A project pin: still the pin, and the packet is still no second source.
    const pinned = project({ devDependency: RUNNING, packetVersion: recorded });
    const withPin = status(pinned, ["--json"]);
    assert.equal(withPin.json.pin.status, "match", `${recorded}: ${withPin.stderr}`);
    assert.equal(withPin.json.pin.source, "project", recorded);
    assert.equal(withPin.json.pin.packet_version, null, recorded);
    assert.equal(withPin.json.pin.packet_version_ignored, recorded);
  }
  assert.equal(
    evaluatePin({ packetVersionIgnored: "v2.0.0", packetPath: "/p/campaign-runtime.build.json", running: "2.0.0" }).message,
    'unpinned (no package.json found; campaigns_os_version "v2.0.0" in /p/campaign-runtime.build.json is not a bare x.y.z version and was ignored)',
  );
});

test("pin-checks: a malformed ancestor manifest stops the walk with a warning naming it", () => {
  const outer = project({ devDependency: OLDER });
  const middle = join(outer.dir, "middle");
  mkdirSync(middle);
  const middleManifest = join(middle, "package.json");
  writeFileSync(middleManifest, "{not json\n");
  const child = join(middle, "child");
  const childManifest = writeManifest(child, { devDependencies: { [PACKAGE]: "^1.40.0" } });
  const run = status(outer, ["--json"], { cwd: child });
  assert.equal(run.json.pin.status, "unpinned", run.stderr);
  assert.equal(run.json.pin.range, "^1.40.0");
  assert.equal(run.json.pin.project_manifest, childManifest);
  assert.ok(run.json.warnings.includes(`Project pin walk stopped at ${middleManifest}: it is not valid JSON.`), JSON.stringify(run.json.warnings));
});

test("pin-checks: a package.json with a UTF-8 BOM is read as npm reads it", () => {
  const fixture = project();
  writeFileSync(join(fixture.dir, "package.json"), `\uFEFF${JSON.stringify({ name: "campaign-fixture", private: true, devDependencies: { [PACKAGE]: RUNNING } })}\n`);
  const run = status(fixture, ["--json"]);
  assert.equal(run.json.pin.status, "match", run.stderr);
  assert.equal(run.json.pin.project_version, RUNNING);
  assert.deepEqual(run.json.warnings.filter((warning) => warning.includes("package.json")), []);
});

test("pin-checks: an unreadable ancestor manifest stops the walk with a warning naming it", (t) => {
  const root = project({ devDependency: OLDER });
  const rootManifest = join(root.dir, "package.json");
  const app = join(root.dir, "app");
  writeManifest(app);
  chmodSync(rootManifest, 0o000);
  try {
    let readable = true;
    try {
      readFileSync(rootManifest);
    } catch {
      readable = false;
    }
    if (readable) {
      t.skip("this user can still read a mode-000 file");
      return;
    }
    const run = status(root, ["--json"], { cwd: app });
    assert.equal(run.json.pin.status, "unpinned", run.stderr);
    assert.equal(run.json.pin.project_manifest, join(app, "package.json"));
    assert.ok(run.json.warnings.some((warning) => warning.includes(rootManifest) && /could not be read/.test(warning)), JSON.stringify(run.json.warnings));
  } finally {
    chmodSync(rootManifest, 0o644);
  }
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

// The project's own files, node_modules aside: what a refusal must not touch.
function projectFiles(dir, prefix = "") {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .filter((entry) => entry.name !== "node_modules")
    .flatMap((entry) => {
      const path = join(prefix, entry.name);
      return entry.isDirectory() ? projectFiles(dir, path) : [[path, createHash("sha256").update(readFileSync(join(dir, path))).digest("hex")]];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

test("pin-checks: --no-force is refused up front, journals nothing and leaves the project untouched", () => {
  const fixture = project({ devDependency: OLDER });
  const journal = join(fixture.dir, "lifecycle.jsonl");
  const before = projectFiles(fixture.dir);
  const run = status(fixture, ["--no-force", "--lifecycle-journal", journal, "--json"]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--no-force is not a flag of tooling status; --force is bare and off by default/);
  assert.doesNotMatch(run.stdout, /"pin"/);
  assert.equal(existsSync(journal), false);
  assert.deepEqual(projectFiles(fixture.dir), before);
});

test("pin-checks: evaluatePin — precedence and the four statuses without a spawn", () => {
  assert.equal(evaluatePin({ projectSpec: "2.0.0", packetVersion: "2.0.0", running: "2.0.0" }).source, "project");
  assert.equal(evaluatePin({ projectSpec: "2.0.0", packetVersion: "1.9.0", running: "2.0.0" }).status, "conflicting_pin");
  assert.equal(evaluatePin({ projectSpec: "latest", packetVersion: "1.9.0", running: "2.0.0" }).status, "stale_pin");
  assert.equal(evaluatePin({ projectSpec: "latest", running: "2.0.0" }).range, "latest");
  assert.equal(evaluatePin({ projectSpec: "=2.0.0", running: "2.0.0" }).project_version, "2.0.0");
  assert.equal(evaluatePin({ projectSpec: "v2.0.0", running: "2.0.0" }).project_version, "2.0.0");
  assert.equal(evaluatePin({ projectSpec: "", running: "2.0.0" }).range, "");
  assert.equal(evaluatePin({ projectSpec: "2.0.0", projectManifest: "/p/package.json", projectKey: "dependencies", running: "2.0.0" }).message, "match (2.0.0 — dependencies in /p/package.json)");
  assert.equal(evaluatePin({ packetVersion: "2.0.0", packetPath: "/p/campaign-runtime.build.json", running: "2.0.0" }).message, "match (2.0.0 — campaigns_os_version in /p/campaign-runtime.build.json)");
  assert.equal(evaluatePin({ running: "2.0.0" }).message, "unpinned (no package.json found; no packet version)");
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
