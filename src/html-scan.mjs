import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// A synchronous doctor's snapshot ends with the invocation. No file contents
// survive into another command, even when a host imports the CLI once and reuses it.
const snapshots = new AsyncLocalStorage();
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_FILES = 4096;
export function withHtmlScanSnapshot(operation, { reuse = false } = {}) {
  if (reuse && snapshots.getStore()) return operation();
  return snapshots.run({ files: new Map(), retainedBytes: 0 }, operation);
}

function file(path) {
  const snapshot = snapshots.getStore();
  if (!snapshot) return { bytes: readFileSync(path) };
  const key = resolve(path);
  if (snapshot.files.has(key)) return snapshot.files.get(key);
  const entry = { bytes: readFileSync(path) };
  // Budget buffer + worst-case decoded UTF-16 text together. Oversize files
  // retain the original read-per-use behavior; tiny files are count-bounded.
  const cost = entry.bytes.length * 3;
  if (snapshot.files.size < MAX_RETAINED_FILES && snapshot.retainedBytes + cost <= MAX_RETAINED_BYTES) {
    snapshot.files.set(key, entry);
    snapshot.retainedBytes += cost;
  }
  return entry;
}

export function readHtmlScanText(path) {
  const entry = file(path);
  return entry.text ??= entry.bytes.toString('utf8');
}

export function htmlScanDigest(path) {
  const entry = file(path);
  return entry.digest ??= createHash('sha256').update(entry.bytes).digest('hex');
}
