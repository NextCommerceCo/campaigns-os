import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { capturesIntegrity, packageCapturesSatisfy } from "./polish-captures-record.mjs";
import { polishRecordIntegrity } from "./qc-results.mjs";
import { syntheticCapturesRecord, syntheticVisualFixture } from "./polish-visual-fixtures.mjs";

test("capturesIntegrity equals polishRecordIntegrity, ignoring only the integrity member", () => {
  const input = { z: [3, { b: false, a: null }], a: { nested: "synthetic" }, integrity: "old" };
  assert.equal(capturesIntegrity(input), polishRecordIntegrity(input));
  assert.equal(capturesIntegrity({ ...input, integrity: "changed" }), capturesIntegrity(input));
  assert.notEqual(capturesIntegrity({ ...input, new_field: true }), capturesIntegrity(input));
});
test("Package capture gate is pure data and checks current binding, crop, DPR and pixel geometry", (t) => {
  const f = syntheticVisualFixture(); t.after(f.cleanup);
  const record = syntheticCapturesRecord(f.report, { targetRepo: f.targetRepo });
  assert.equal(packageCapturesSatisfy(record, f.report), true);
  const tamper = (mutate) => {
    const copy = structuredClone(record); mutate(copy); copy.integrity = capturesIntegrity(copy);
    assert.equal(packageCapturesSatisfy(copy, f.report), false);
  };
  tamper((r) => { r.subject.build_fingerprint = "old"; });
  tamper((r) => { r.cells = []; });
  tamper((r) => { r.cells[0].state = "scrolled"; });
  tamper((r) => { r.cells[0].device_scale_factor = 2; });
  tamper((r) => { r.cells[0].width = 375; });
  tamper((r) => { r.cells[0].height = 900; });
  tamper((r) => { r.cells[0].actual.crop.y = 200; });
  tamper((r) => { r.cells[0].actual.crop.x = 10; });
  tamper((r) => { r.cells[0].actual.truncated = true; });
  tamper((r) => { r.cells[0].actual.png.width_px = 2880; });
  tamper((r) => { r.cells[0].actual.png.sha256 = "invalid"; });
  for (const viewport of ["__proto__", "constructor", "toString"]) tamper((r) => {
    r.cells[0].viewport = viewport; delete r.cells[0].width; delete r.cells[0].height;
    r.cells[0].actual = { status: "skipped" }; r.cells[0].stabilized = { status: "skipped" };
  });
  for (const value of [null, 0, "cell", [], false]) {
    tamper((r) => { r.cells[0] = value; });
    tamper((r) => { r.cells[0].actual = value; });
    tamper((r) => { r.cells[0].stabilized = value; });
  }
  const failed = structuredClone(record);
  for (const cell of failed.cells) { cell.status = "browser_unavailable"; cell.actual = { status: "skipped", png: null }; cell.stabilized = { status: "skipped", png: null }; }
  failed.integrity = capturesIntegrity(failed);
  assert.equal(packageCapturesSatisfy(failed, f.report), false);
  const absent = structuredClone(record);
  for (const cell of absent.cells) for (const shot of [cell.actual, cell.stabilized]) shot.png.path = "missing-on-this-machine.png";
  absent.integrity = capturesIntegrity(absent);
  assert.equal(packageCapturesSatisfy(absent, f.report), true);
  assert.equal(packageCapturesSatisfy({ ...record, integrity: "broken" }, f.report), false);
});
test("Capture leaf imports no QC, gate, node runner or browser module", () => {
  const source = readFileSync(new URL("./polish-captures-record.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(imports, ["node:crypto", "./polish-capture.mjs"]);
});

test("A-C4 requires a rendered actual build capture for every planned route, at either viewport", (t) => {
  const f = syntheticVisualFixture(); t.after(f.cleanup);
  const routes = [{ page_id: "first", requested_route: "/first/" }, { page_id: "second", requested_route: "/second/" }];
  const record = syntheticCapturesRecord(f.report, { targetRepo: f.targetRepo, routes });
  const satisfies = (mutate) => {
    const copy = structuredClone(record); mutate(copy); copy.integrity = capturesIntegrity(copy);
    return packageCapturesSatisfy(copy, f.report);
  };
  assert.equal(packageCapturesSatisfy(record, f.report), true);
  assert.equal(satisfies((r) => { r.subject.routes = routes.map((route) => route.requested_route); }), true,
    "production page-load subjects list routes as strings");
  for (const status of ["failed", "timeout", "skipped"]) {
    assert.equal(satisfies((r) => {
      for (const cell of r.cells.filter((c) => c.side === "build" && c.page_id === "second")) {
        cell.actual = { status }; cell.stabilized = { status };
      }
    }), false, `one route with only ${status} build shots must refuse, even with source captures`);
  }
  assert.equal(satisfies((r) => {
    for (const cell of r.cells.filter((c) => c.side === "build")) cell.status = "browser_unavailable";
  }), false, "a captured shot in a cell that was not rendered cannot qualify");
  assert.equal(satisfies((r) => {
    for (const cell of r.cells.filter((c) => c.side === "build" && c.viewport === "desktop")) {
      cell.actual = { status: "failed" }; cell.stabilized = { status: "failed" };
    }
  }), true, "one captured mobile actual per route suffices");
  assert.equal(satisfies((r) => { r.subject.routes.push({ page_id: "missing", requested_route: "/missing/" }); }), false);
  assert.equal(satisfies((r) => { r.subject.routes = []; }), false);
});
