import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export const VISUAL_MAX_DECODE_PIXELS = 17_280_000;
export const VISUAL_MAX_REFERENCE_BYTES = 67_108_864;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const depths = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]);
const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]);
export function boundedDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
      || width * height > VISUAL_MAX_DECODE_PIXELS) throw new RangeError("image_too_large");
}
export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

export function readPngStructure(bytes, { maxBytes = VISUAL_MAX_REFERENCE_BYTES } = {}) {
  const fail = (reason) => ({ ok: false, level: "unverifiable", ihdr: null, reason });
  if (!Number.isFinite(maxBytes) || maxBytes < 0) return fail("too_large");
  maxBytes = Math.min(maxBytes, VISUAL_MAX_REFERENCE_BYTES);
  if (!Buffer.isBuffer(bytes)) return fail("not_png");
  if (bytes.length > maxBytes) return fail("too_large");
  if (bytes.length < 8 || !Buffer.from(bytes.subarray(0, 8)).equals(signature)) return fail("not_png");
  if (bytes.length < 33) return fail("truncated");
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR"
      || crc32(bytes.subarray(12, 29)) !== bytes.readUInt32BE(29)) return fail("ihdr_invalid");
  const ihdr = {
    width_px: bytes.readUInt32BE(16), height_px: bytes.readUInt32BE(20),
    bit_depth: bytes[24], color_type: bytes[25], compression: bytes[26], filter: bytes[27], interlace: bytes[28],
  };
  if (!ihdr.width_px || !ihdr.height_px || ihdr.width_px > 0x7fffffff || ihdr.height_px > 0x7fffffff
      || !depths.get(ihdr.color_type)?.includes(ihdr.bit_depth) || ihdr.compression !== 0
      || ihdr.filter !== 0 || ![0, 1].includes(ihdr.interlace)) return fail("ihdr_invalid");
  const idat = [];
  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return fail("truncated");
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return fail("truncated");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return fail("chunk_crc_mismatch");
    if (type === "IHDR" && offset !== 8) return fail("ihdr_invalid");
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, end - 4));
    if (type === "IEND") {
      if (length || end !== bytes.length || !idat.length) return fail("truncated");
      return { ok: true, level: "header_checked", ihdr, reason: null, idat };
    }
    offset = end;
  }
  return fail("truncated");
}

export function rawImageBytes(ihdr) {
  if (!ihdr || typeof ihdr !== "object") throw new RangeError("image_too_large");
  const { width_px: width, height_px: height, bit_depth, color_type, interlace } = ihdr;
  boundedDimensions(width, height);
  if (!["width_px", "height_px", "bit_depth", "color_type", "interlace"].every((key) => Object.hasOwn(ihdr, key))
      || !depths.get(color_type)?.includes(bit_depth) || ![0, 1].includes(interlace)) throw new RangeError("ihdr_invalid");
  const bits = bit_depth * channels.get(color_type);
  const passBytes = (x, y, dx, dy) => {
    const w = Math.max(0, Math.ceil((width - x) / dx));
    const h = Math.max(0, Math.ceil((height - y) / dy));
    return w && h ? h * (1 + Math.ceil(w * bits / 8)) : 0;
  };
  return interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    .reduce((sum, pass) => sum + passBytes(...pass), 0) : passBytes(0, 0, 1, 1);
}

export function boundedInflate(bytes, ihdr) {
  const expected = rawImageBytes(ihdr);
  const structure = readPngStructure(bytes);
  if (!structure.ok) throw new Error(structure.reason);
  const raw = inflateSync(Buffer.concat(structure.idat), { maxOutputLength: expected });
  if (raw.length !== expected) throw new Error("decode_failed");
  return raw;
}
