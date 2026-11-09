import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'parse5';

// The shared input context of one read-only doctor inspection (#730): source
// bytes, parsed documents and memoized collections (built-site scope, source
// permalinks). A synchronous doctor's snapshot ends with the invocation. No
// file contents survive into another command, even when a host imports the
// CLI once and reuses it, and an inspection that follows a write opens a fresh
// snapshot, so it never sees bytes from before the write.
//
// Budgets are aggregate: a nested fresh snapshot (an inspection inside an
// inspection) counts against its parent's ledger. The outermost snapshot is
// depth 0; up to MAX_DEPTH nested levels below it are cached, and deeper ones
// run uncached. Beyond any budget the input is read, parsed or collected per
// use, as it was before the snapshot existed. Read failures are never
// retained, so an unavailable input stays unavailable to each consumer on its
// own terms.
const snapshots = new AsyncLocalStorage();
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_FILES = 4096;
// A parse5 tree costs 20-23x its UTF-8 source in heap on the certified-family
// pages and up to 30x on element-dense markup, so parsed documents get their
// own budget, estimated at the dense end.
const MAX_RETAINED_PARSE_COST = 64 * 1024 * 1024;
const PARSE_COST_PER_BYTE = 30;
const MAX_MEMOS = 256;
const MAX_PATHS = 4 * MAX_RETAINED_FILES;
const MAX_DEPTH = 4;
// Parse profiles, keyed into the cache with the source's identity. A tree
// parsed with other options (locations, bounds) is a different input.
const PARSE_OPTIONS = Object.freeze({ noloc: undefined });

export function withHtmlScanSnapshot(operation, { reuse = false } = {}) {
  const live = snapshots.getStore();
  const parent = live && !live.expired ? live : null;
  if (reuse && parent?.active) return operation();
  const depth = parent ? parent.depth + 1 : 0;
  const snapshot = {
    files: new Map(), paths: new Map(), memos: new Map(), depth,
    ledger: parent ? parent.ledger : { bytes: 0, files: 0, parseCost: 0, memos: 0, paths: 0 },
    active: depth <= MAX_DEPTH,
    expired: false,
  };
  return snapshots.run(snapshot, () => {
    try {
      return operation();
    } finally {
      // AsyncLocalStorage propagates to queued callbacks too. Expire the store
      // at synchronous return, even if a future caller returns a Promise.
      for (const entry of snapshot.files.values()) {
        snapshot.ledger.bytes -= entry.cost;
        snapshot.ledger.files -= 1;
        snapshot.ledger.parseCost -= entry.parseCost;
      }
      snapshot.ledger.memos -= snapshot.memos.size;
      snapshot.ledger.paths -= snapshot.paths.size;
      snapshot.active = false;
      snapshot.expired = true;
      snapshot.files.clear();
      snapshot.paths.clear();
      snapshot.memos.clear();
    }
  });
}

// The file's identity: its real path, so `/var/...` and `/private/var/...`
// are one entry. Remembered per path while the path budget lasts.
function realKey(snapshot, path) {
  const key = resolve(path);
  let real = snapshot.paths.get(key);
  if (real === undefined) {
    try {
      real = realpathSync.native(key);
    } catch {
      return key;
    }
    if (snapshot.ledger.paths < MAX_PATHS) {
      snapshot.paths.set(key, real);
      snapshot.ledger.paths += 1;
    }
  }
  return real;
}

function file(path) {
  const snapshot = snapshots.getStore();
  if (!snapshot?.active) return { bytes: readFileSync(path) };
  const key = realKey(snapshot, path);
  if (snapshot.files.has(key)) return snapshot.files.get(key);
  // documents: profile -> shared tree (null until first parsed).
  const entry = { bytes: readFileSync(path), documents: new Map(), parseCost: 0 };
  // Budget buffer + worst-case decoded UTF-16 text together. Oversize files
  // retain the original read-per-use behavior; tiny files are count-bounded.
  entry.cost = entry.bytes.length * 3;
  const { ledger } = snapshot;
  if (ledger.files < MAX_RETAINED_FILES && ledger.bytes + entry.cost <= MAX_RETAINED_BYTES) {
    snapshot.files.set(key, entry);
    ledger.bytes += entry.cost;
    ledger.files += 1;
  }
  return entry;
}

export function readHtmlScanText(path) {
  const entry = file(path);
  return entry.text ??= entry.bytes.toString('utf8');
}

// Byte-preserving generic digest; only an active read-only scan scope caches it.
// Callers that write artifacts must hash outside that scope to observe new bytes.
export function htmlScanDigest(path) {
  const entry = file(path);
  return entry.digest ??= createHash('sha256').update(entry.bytes).digest('hex');
}

// Shared parse5 trees for a set of files whose bytes the snapshot already
// holds, one whole-document tree per file and profile, for every consumer in
// the snapshot that asks with the same profile. Returns
// `(path, text) => document`, parsing on first use. The tree always matches
// the `text` given: the shared tree is handed back only when `text` is the
// held text, and any other text is parsed per use. Template
// content and other nested contexts stay inside the tree as parse5 builds
// them; a consumer that reparses a fragment (noscript, srcdoc) does so itself.
// Consumers read a shared tree and never change it.
//
// The set is shared whole or not at all: when its trees do not fit the parse
// budget, or a file's bytes are not held, every file in it is parsed per use.
// Retaining only the first few trees is worse than retaining none: V8 then
// pretenures parse5's node allocations, so every later throwaway tree is
// allocated in old space (on 304 built pages, 4 MiB of retained trees cost
// 0.2-0.4 s and 280 MiB of RSS).
export function htmlScanDocuments(paths, profile = 'noloc') {
  if (!Object.hasOwn(PARSE_OPTIONS, profile)) throw new Error(`Unknown HTML parse profile: ${profile}`);
  const parseText = (text) => parse(text, PARSE_OPTIONS[profile]);
  const perUse = (path, text) => parseText(text);
  const snapshot = snapshots.getStore();
  if (!snapshot?.active) return perUse;
  const entries = new Set(paths.map((path) => snapshot.files.get(realKey(snapshot, path))));
  if (entries.has(undefined)) return perUse;
  const pending = [...entries].filter((entry) => !entry.documents.has(profile));
  const cost = pending.reduce((sum, entry) => sum + entry.bytes.length * PARSE_COST_PER_BYTE, 0);
  if (snapshot.ledger.parseCost + cost > MAX_RETAINED_PARSE_COST) return perUse;
  for (const entry of pending) {
    entry.documents.set(profile, null);
    entry.parseCost += entry.bytes.length * PARSE_COST_PER_BYTE;
  }
  snapshot.ledger.parseCost += cost;
  return (path, text) => {
    const entry = snapshot.active ? snapshot.files.get(realKey(snapshot, path)) : null;
    if (!entry?.documents.has(profile) || text !== (entry.text ??= entry.bytes.toString('utf8'))) return parseText(text);
    let document = entry.documents.get(profile);
    if (!document) entry.documents.set(profile, document = parseText(entry.text));
    return document;
  };
}

// A collection computed once per snapshot under `key` (built-site scope, a
// source tree's permalinks); past the memo budget it is computed per use.
// Frozen one level down: the value, its object and array children, and those
// arrays' items. Deeper values are not frozen, so a memo holds flat records.
export function htmlScanMemo(key, compute) {
  const snapshot = snapshots.getStore();
  if (!snapshot?.active) return freezeShallow(compute());
  if (snapshot.memos.has(key)) return snapshot.memos.get(key);
  const value = freezeShallow(compute());
  if (snapshot.ledger.memos < MAX_MEMOS) {
    snapshot.memos.set(key, value);
    snapshot.ledger.memos += 1;
  }
  return value;
}

function freezeShallow(value) {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value)) {
    if (!child || typeof child !== 'object') continue;
    if (Array.isArray(child)) for (const item of child) if (item && typeof item === 'object') Object.freeze(item);
    Object.freeze(child);
  }
  return Object.freeze(value);
}
