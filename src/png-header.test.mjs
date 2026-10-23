import test from "node:test";
import assert from "node:assert/strict";
import { crc32, readPngStructure, rawImageBytes, boundedInflate } from "./png-header.mjs";
import { createRgbaPng, pngChunk } from "./polish-visual-fixtures.mjs";

test("PNG structure walks the full file, validates CRCs and rejects missing or trailing data", () => {
  const png = createRgbaPng(4, 3);
  const structure = readPngStructure(png);
  assert.equal(structure.level, "header_checked");
  assert.equal(structure.ihdr.width_px, 4);
  assert.equal(boundedInflate(png, structure.ihdr).length, 51);
  assert.equal(readPngStructure(png, { maxBytes: 1 }).reason, "too_large");
  assert.equal(readPngStructure(Buffer.from("text")).reason, "not_png");
  assert.equal(readPngStructure(png.subarray(0, -12)).reason, "truncated");
  assert.equal(readPngStructure(Buffer.concat([png, Buffer.from([0])])).reason, "truncated");
  const corrupt = Buffer.from(png); corrupt[45] ^= 1;
  assert.equal(readPngStructure(corrupt).reason, "chunk_crc_mismatch");
  const badHeader = Buffer.from(png); badHeader[24] = 3;
  assert.equal(readPngStructure(badHeader).reason, "ihdr_invalid");
});
test("PNG raw-size bounds account for packed samples and all seven Adam7 passes", () => {
  assert.equal(rawImageBytes({ width_px: 9, height_px: 2, bit_depth: 1, color_type: 0, interlace: 0 }), 6);
  assert.equal(rawImageBytes({ width_px: 8, height_px: 8, bit_depth: 8, color_type: 6, interlace: 1 }), 271);
  assert.equal(rawImageBytes({ width_px: 1, height_px: 1, bit_depth: 8, color_type: 6, interlace: 1 }), 5);
  const png = createRgbaPng(4, 3), header = Buffer.from(png.subarray(16, 29));
  header[9] = 3; header[8] = 4; // indexed colour is legal for structural reads
  const indexed = Buffer.concat([png.subarray(0, 8), pngChunk("IHDR", header), png.subarray(33)]);
  assert.equal(readPngStructure(indexed).ok, true);
});
test("Raw-size and inflate exports reject invalid dimensions and inherited colour keys before reading input", () => {
  const valid = { width_px: 1, height_px: 1, bit_depth: 8, color_type: 6, interlace: 0 };
  for (const value of [Infinity, NaN, -1, 0, 1.5, 17280001]) for (const axis of ["width_px", "height_px"]) {
    const header = { ...valid, [axis]: value };
    assert.throws(() => rawImageBytes(header), /image_too_large/);
    assert.throws(() => boundedInflate(null, header), /image_too_large/);
  }
  for (const color_type of ["__proto__", "constructor", "toString", null]) assert.throws(() => rawImageBytes({ ...valid, color_type }), /ihdr_invalid/);
  assert.throws(() => rawImageBytes(null), /image_too_large/);
  assert.throws(() => rawImageBytes(Object.create(valid)), /ihdr_invalid/);
  for (const maxBytes of [Infinity, NaN, -1]) assert.equal(readPngStructure(null, { maxBytes }).reason, "too_large");
  const png = createRgbaPng(1, 1);
  for (const maxBytes of [png.length + 0.5, 67108865]) assert.equal(readPngStructure(png, { maxBytes }).ok, true);
});

test("CRC32 matches standard known vectors and the bitwise algorithm across all byte values", () => {
  for (const [input, expected] of [["", 0x00000000], ["123456789", 0xcbf43926], ["The quick brown fox jumps over the lazy dog", 0x414fa339]]) {
    assert.equal(crc32(Buffer.from(input)), expected);
  }
  assert.equal(crc32(Buffer.from("IEND")), 0xae426082);
  const bitwise = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const bytes = Buffer.from(Array.from({ length: 65536 }, (_, i) => (i * 73 + (i >>> 8)) & 0xff));
  for (const length of [1, 2, 255, 256, 257, 4096, bytes.length]) {
    assert.equal(crc32(bytes.subarray(0, length)), bitwise(bytes.subarray(0, length)));
  }
});
