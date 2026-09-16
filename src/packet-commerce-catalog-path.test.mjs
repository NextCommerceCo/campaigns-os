import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { defaultCommerceCatalogPath, resolvePacketCommerceCatalogPath } from "./private-template-source.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin/campaigns-os.mjs");

function runCli(args) {
  try {
    return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    // prepare-build and doctor exit 2 on retained blockers; the artifacts and
    // the JSON report are still written / printed.
    return `${error.stdout || ""}`;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// A minimal campaign: spec + prepared pages + a page-kit target, so
// prepare-build writes a packet. Readiness is not under test here.
function campaignFixture() {
  const dir = mkdtempSync(join(tmpdir(), "packet-commerce-catalog-"));
  const source = join(dir, "source-html");
  const target = join(dir, "target-page-kit");
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  for (const page of ["landing", "checkout", "upsell", "receipt"]) {
    writeFileSync(join(source, `${page}.html`), `<section>${page}</section>`);
  }
  const specPath = join(dir, "campaignspec.json");
  cpSync(join(ROOT, "examples/campaignspec.v42.basic.json"), specPath);
  return { dir, source, target, specPath, packetPath: join(target, "campaign-runtime.build.json") };
}

function prepare(fixture, extraArgs = []) {
  runCli([
    "prepare-build",
    "--spec", fixture.specPath,
    "--source", fixture.source,
    "--target", fixture.target,
    "--template-family", "olympus",
    "--json",
    ...extraArgs,
  ]);
  assert.ok(existsSync(fixture.packetPath), "prepare-build should write the packet");
  return readJson(fixture.packetPath);
}

function doctorJson(packetPath) {
  return JSON.parse(runCli(["doctor", "--packet", packetPath, "--json"]));
}

test("prepare-build records a null catalog path when the catalog is the toolkit's own", () => {
  const fixture = campaignFixture();
  try {
    const packet = prepare(fixture);
    // The toolkit's catalog travels with the toolkit, not the campaign: a
    // packet-relative path to this checkout's copy would climb out of the
    // campaign repo and be dead on any other machine.
    assert.equal(packet.assembly.commerce_catalog.path, null);
    assert.equal(packet.assembly.commerce_catalog.required, true);
    const doctor = doctorJson(fixture.packetPath);
    assert.equal(doctor.errors.some((issue) => issue.code === "assembly.commerce_catalog.path"), false);
    assert.ok(doctor.ready.includes("Commerce catalog sharedFrontmatterVocabulary loaded"));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("an explicit --commerce-catalog inside the campaign still round-trips as a packet-relative path", () => {
  const fixture = campaignFixture();
  try {
    const catalogPath = join(fixture.target, "contracts/commerce-surface-catalog.json");
    mkdirSync(dirname(catalogPath), { recursive: true });
    cpSync(defaultCommerceCatalogPath(), catalogPath);
    const packet = prepare(fixture, ["--commerce-catalog", catalogPath]);
    assert.equal(packet.assembly.commerce_catalog.path, "./contracts/commerce-surface-catalog.json");
    const resolution = resolvePacketCommerceCatalogPath(fixture.packetPath, packet.assembly.commerce_catalog);
    assert.deepEqual(resolution, { path: catalogPath, source: "packet", recorded: "./contracts/commerce-surface-catalog.json" });
    const doctor = doctorJson(fixture.packetPath);
    assert.equal(doctor.errors.some((issue) => issue.code === "assembly.commerce_catalog.path"), false);
    assert.equal(doctor.ready.some((line) => line.startsWith("Commerce catalog resolved to the running toolkit's copy")), false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("doctor resolves a dead machine-local catalog path to the running toolkit's catalog without blocking", () => {
  const fixture = campaignFixture();
  try {
    const packet = prepare(fixture);
    // The pre-null shape: the toolkit's own catalog recorded relative to the
    // packet, through the checkout that ran prepare-build on another machine.
    packet.assembly.commerce_catalog.path = "../../../../elsewhere/campaigns-os/contracts/commerce-surface-catalog.json";
    writeFileSync(fixture.packetPath, `${JSON.stringify(packet, null, 2)}\n`);

    const resolution = resolvePacketCommerceCatalogPath(fixture.packetPath, packet.assembly.commerce_catalog);
    assert.equal(resolution.source, "stale_packet_path");
    assert.equal(resolution.path, defaultCommerceCatalogPath());

    const doctor = doctorJson(fixture.packetPath);
    assert.equal(doctor.errors.some((issue) => issue.code === "assembly.commerce_catalog.path"), false);
    assert.ok(doctor.ready.includes("Commerce catalog sharedFrontmatterVocabulary loaded"));
    const notice = doctor.ready.find((line) => line.startsWith("Commerce catalog resolved to the running toolkit's copy"));
    assert.ok(notice, "doctor should say the packet still carries a machine-local catalog path");
    assert.match(notice, /Re-run prepare-build to clear the machine-local path\./);
    assert.equal(doctor.warnings.some((issue) => issue.code === "assembly.commerce_catalog.path"), false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a dead path that does not name the catalog file still blocks", () => {
  const fixture = campaignFixture();
  try {
    const packet = prepare(fixture);
    packet.assembly.commerce_catalog.path = "./contracts/custom-catalog.json";
    writeFileSync(fixture.packetPath, `${JSON.stringify(packet, null, 2)}\n`);
    const doctor = doctorJson(fixture.packetPath);
    const blocker = doctor.errors.find((issue) => issue.code === "assembly.commerce_catalog.path");
    assert.ok(blocker);
    assert.equal(blocker.message, "Commerce catalog is required but not found.");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
