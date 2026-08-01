import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { doctorCommand } from "./cli.mjs";

// NEXT-114 dogfood finding wf_1785566917680: only prepare-build/start wrote
// .campaign-runtime/doctor-output.json, so every later standalone doctor run
// left the retained sidecar frozen at the intake snapshot while reporting
// fresh state on stdout. Standalone packet-mode doctor now refreshes the
// sidecar (opt out with --no-write).

function packetFixture() {
  const dir = mkdtempSync(join(tmpdir(), "doctor-sidecar-"));
  cpSync(new URL("../examples/build-packet.basic.json", import.meta.url).pathname, join(dir, "campaign-runtime.build.json"));
  return dir;
}

test("standalone doctor refreshes the doctor-output.json sidecar", () => {
  const dir = packetFixture();
  const sidecar = join(dir, ".campaign-runtime/doctor-output.json");
  assert.equal(existsSync(sidecar), false);
  const result = doctorCommand({ packet: join(dir, "campaign-runtime.build.json") });
  assert.equal(existsSync(sidecar), true);
  const written = JSON.parse(readFileSync(sidecar, "utf8"));
  assert.equal(written.ok, result.ok);
  assert.equal(written.status, result.status);
  rmSync(dir, { recursive: true, force: true });
});

test("standalone doctor honors --no-write", () => {
  const dir = packetFixture();
  doctorCommand({ packet: join(dir, "campaign-runtime.build.json"), "no-write": true });
  assert.equal(existsSync(join(dir, ".campaign-runtime/doctor-output.json")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("standalone doctor honors --doctor-out override", () => {
  const dir = packetFixture();
  const out = join(dir, "custom-doctor.json");
  doctorCommand({ packet: join(dir, "campaign-runtime.build.json"), "doctor-out": out });
  assert.equal(existsSync(out), true);
  assert.equal(existsSync(join(dir, ".campaign-runtime/doctor-output.json")), false);
  rmSync(dir, { recursive: true, force: true });
});
