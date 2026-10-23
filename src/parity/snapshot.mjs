// Element parity probe files: canonical JSON under
// .campaign-runtime/polish/parity/, named by the sha256 of their bytes (the
// writeReadabilityCrop pattern), and re-hashed on every read. The directory
// ignores itself: before its first file the writer creates its .gitignore
// (`*`) with exclusive create and never overwrites one that exists, as C's
// capture writer does for captures/ and diff/. Files carry no timestamp, so an
// unchanged probe output keeps its content address across runs.
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalJson } from "../polish-capture.mjs";
import { containedWritePath } from "../polish-visual.mjs";
import { readRegularFileSync } from "../source-html-server.mjs";

export const PARITY_DIR = ".campaign-runtime/polish/parity";
// Above every bounded ProbeOutput (1 500 elements of capped text, 256 Ki code
// points of page text) by a wide margin.
export const PARITY_FILE_MAX_BYTES = 64 * 1024 * 1024;
const FILE_PATH = /^\.campaign-runtime\/polish\/parity\/([a-f0-9]{64})\.json$/;
const FILE_SHA = /^sha256:([a-f0-9]{64})$/;
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Check every existing ancestor against the target before treating parity as
// a read root. The shared reader then opens, fstats and verifies the file's
// contained realpath/inode before reading any bytes (C A-C3).
function parityDirectory(targetRepo) {
  const root = realpathSync(targetRepo);
  return containedWritePath(root, PARITY_DIR);
}

function readProbeBytes(ref, targetRepo, maxBytes = PARITY_FILE_MAX_BYTES) {
  const directory = parityDirectory(targetRepo);
  return readRegularFileSync(resolve(directory, `${ref.sha256.slice(7)}.json`), { maxBytes, root: directory, noFollow: true });
}

// A probe file reference names its file by the sha256 of its bytes.
export function parityRefShapeOk(ref) {
  if (!isPlainObject(ref) || Object.keys(ref).length !== 2 || typeof ref.path !== "string" || typeof ref.sha256 !== "string") return false;
  const path = FILE_PATH.exec(ref.path);
  const sha = FILE_SHA.exec(ref.sha256);
  return Boolean(path && sha && path[1] === sha[1]);
}

// Writes `value` as canonical JSON and returns {path, sha256}. A file already
// at that address is re-read and must hold the same bytes; anything else
// throws, so the caller records the side as failed.
export function writeParityFile(targetRepo, value) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (bytes.length > PARITY_FILE_MAX_BYTES) throw new Error("parity_file_too_large");
  const hex = sha256Hex(bytes);
  const root = realpathSync(targetRepo);
  const path = `${PARITY_DIR}/${hex}.json`;
  const directory = containedWritePath(root, PARITY_DIR);
  containedWritePath(root, `${PARITY_DIR}/.gitignore`);
  containedWritePath(root, path);
  mkdirSync(directory, { recursive: true });
  try { writeFileSync(resolve(directory, ".gitignore"), "*\n", { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  // Exclusive create must not turn EEXIST into approval of a directory,
  // device, link, or an ignore file that exposes the probes. Preserve operator
  // bytes; refuse the write when they do not keep this directory ignored.
  try {
    const ignore = readRegularFileSync(resolve(directory, ".gitignore"), { root: directory, noFollow: true }).toString("utf8");
    const patterns = ignore.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    if (!patterns.includes("*") || patterns.some((line) => line.startsWith("!"))) throw new Error("ignore_patterns_invalid");
  } catch {
    throw new Error("parity_ignore_invalid");
  }
  try { writeFileSync(resolve(root, path), bytes, { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const written = readProbeBytes({ sha256: `sha256:${hex}` }, root, bytes.length);
  if (sha256Hex(written) !== hex) throw new Error("parity_write_verification_failed");
  return { path, sha256: `sha256:${hex}` };
}

// One referenced probe file, read beneath the parity directory and re-hashed:
// {status: "absent"} when it is not on this machine (a clone: the directory is
// ignored), {status: "invalid", detail} when the reference is malformed, the
// file's realpath leaves the directory, it is not a regular file, its bytes do
// not hash to the reference or do not parse, and {status: "ok", value}.
// Never throws.
export function readParityFile(ref, targetRepo) {
  if (!parityRefShapeOk(ref)) return { status: "invalid", detail: "ref_shape_invalid" };
  if (typeof targetRepo !== "string" || targetRepo === "") return { status: "invalid", detail: "target_unavailable" };
  let bytes;
  try {
    bytes = readProbeBytes(ref, targetRepo);
  } catch (error) {
    return error?.code === "ENOENT" ? { status: "absent" } : { status: "invalid", detail: "file_unreadable" };
  }
  if (`sha256:${sha256Hex(bytes)}` !== ref.sha256) return { status: "invalid", detail: "hash_mismatch" };
  try {
    return { status: "ok", value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return { status: "invalid", detail: "parse_failed" };
  }
}

// The parsed content of a referenced file whatever its hash, for naming the
// rows of a refused cell only (an accept then lapses instead of orphaning).
// Null when it cannot be read or parsed. Never authorizes evidence.
export function readParityFileForIdentity(ref, targetRepo) {
  if (!parityRefShapeOk(ref) || typeof targetRepo !== "string" || targetRepo === "") return null;
  try {
    const bytes = readProbeBytes(ref, targetRepo);
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}
