import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, symlinkSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRgba, createRgbaPng, syntheticCapturesRecord, syntheticVisualFixture } from "./polish-visual-fixtures.mjs";
import { readPngStructure, boundedInflate } from "./png-header.mjs";
import { capturesIntegrity, packageCapturesSatisfy } from "./polish-captures-record.mjs";

test("Synthetic factory produces complete content-addressed captures with actual PNG dimensions", (t) => {
  const f = syntheticVisualFixture(); t.after(f.cleanup);
  const record = syntheticCapturesRecord(f.report, { targetRepo: f.targetRepo });
  assert.equal(record.cells.length, 4); assert.equal(record.integrity, capturesIntegrity(record));
  assert.equal(packageCapturesSatisfy(record, f.report), true);
  for (const cell of record.cells) {
    const png = readFileSync(resolve(f.targetRepo, cell.actual.png.path)), structure = readPngStructure(png);
    assert.equal(structure.ok, true); assert.equal(structure.ihdr.width_px, cell.width); assert.equal(structure.ihdr.height_px, cell.height);
    assert.equal(cell.status, "rendered");
  }
  const bytes = createRgbaPng(2, 3, [1, 2, 3, 255]), structure = readPngStructure(bytes);
  const raw = boundedInflate(bytes, structure.ihdr);
  assert.deepEqual([...raw.subarray(1, 5)], [1, 2, 3, 255]);
});
test("Synthetic pixel factories reject unbounded geometry before allocation", () => {
  for (const value of [Infinity, NaN, -1, 0, 1.5, 17280001]) for (const [w, h] of [[value, 1], [1, value]]) {
    assert.throws(() => createRgba(w, h), /image_too_large/);
    assert.throws(() => createRgbaPng(w, h), /image_too_large/);
  }
});
test("Synthetic fixture writes enforce the same containment boundary", (t) => {
  const f = syntheticVisualFixture(), outside = syntheticVisualFixture(); t.after(f.cleanup); t.after(outside.cleanup);
  symlinkSync(outside.targetRepo, resolve(f.sourceRoot, "escape"));
  const before = readdirSync(outside.targetRepo, { recursive: true });
  assert.equal(syntheticCapturesRecord(f.report, { targetRepo: f.targetRepo, routes: [null] }), null);
  assert.throws(() => f.write("escape/new/deep/file.png", createRgbaPng(1, 1)), /path_outside_target/);
  assert.throws(() => f.write("../outside.png", createRgbaPng(1, 1)), /path_outside_target/);
  assert.deepEqual(readdirSync(outside.targetRepo, { recursive: true }), before);
});
