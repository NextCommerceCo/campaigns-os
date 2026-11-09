import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseJs } from 'acorn';
import { defaultTreeAdapter, parse } from 'parse5';

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
// Parsed documents get their own budget, estimated per profile at the dense
// end of what a tree costs in heap per UTF-8 source byte (PARSE_PROFILES).
const MAX_RETAINED_PARSE_COST = 64 * 1024 * 1024;
const MAX_MEMOS = 256;
const MAX_PATHS = 4 * MAX_RETAINED_FILES;
const MAX_DEPTH = 4;
// Parse profiles, keyed into the cache with the source's identity. A tree
// parsed with other options (locations, bounds) is a different input.
//   noloc    parse5's defaults. 20-23x its source in heap on the
//            certified-family pages, up to 30x on element-dense markup: a page
//            set shares trees while its HTML totals about 2.1 MiB.
//   bounded  parseBounded: source locations, nesting bounded. 27x on the
//            certified-family pages, 54x on element-dense markup: about
//            1.1 MiB of HTML.
const PARSE_PROFILES = Object.freeze({
  noloc: { parse: (text) => parse(text), costPerByte: 30 },
  bounded: { parse: (text) => parseBounded(text), costPerByte: 56 },
});

// Nesting deeper than a browser's HTML parser builds (Blink stops nesting at
// 512) is not the DOM a shopper gets, so the bounded profile does not build it.
export const MAX_ELEMENT_DEPTH = 512;

export class TooDeep extends Error {}

// parse5 with source locations and a tree adapter that stops the parse once an
// element would sit deeper than MAX_ELEMENT_DEPTH (template content counts
// from its <template>). parse5's own cost grows with the square of the
// nesting, so the bound has to hold during the parse, not after it. Throws
// TooDeep past the bound.
export function parseBounded(html) {
  const templateOf = new WeakMap();
  const check = (parent, node) => {
    if (!node.tagName) return;
    let depth = 1;
    for (let at = parent; at; at = at.parentNode || templateOf.get(at)) {
      if (at.tagName) depth += 1;
      if (depth > MAX_ELEMENT_DEPTH) throw new TooDeep();
    }
  };
  const treeAdapter = {
    ...defaultTreeAdapter,
    appendChild(parent, node) {
      check(parent, node);
      defaultTreeAdapter.appendChild(parent, node);
    },
    insertBefore(parent, node, reference) {
      check(parent, node);
      defaultTreeAdapter.insertBefore(parent, node, reference);
    },
    setTemplateContent(template, content) {
      templateOf.set(content, template);
      defaultTreeAdapter.setTemplateContent(template, content);
    },
  };
  return parse(html, { sourceCodeLocationInfo: true, treeAdapter });
}

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
  // documents: profile -> { document } or { error } (null until first parsed).
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

// The raw bytes, for a consumer that bounds a read by its byte length. The
// Buffer is the snapshot's own, shared by every consumer of the file in this
// inspection: read it, never write to it.
export function readHtmlScanBytes(path) {
  return file(path).bytes;
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
// held text, and any other text is parsed per use. A mismatch keeps the file's
// reservation, so a later call with the held text still gets the shared tree. Template
// content and other nested contexts stay inside the tree as parse5 builds
// them; a consumer that reparses a fragment (noscript, srcdoc) does so itself.
// A parse that throws (the bounded profile past its depth bound) throws the
// same error to every consumer, as a failure is shared like a tree.
// Consumers read a shared tree and never change it.
//
// The set is shared whole or not at all: when its trees do not fit the parse
// budget, or a file's bytes are not held, every file in it is parsed per use.
// Retaining only the first few trees is worse than retaining none: V8 then
// pretenures parse5's node allocations, so every later throwaway tree is
// allocated in old space (on 304 built pages, 4 MiB of retained trees cost
// 0.2-0.4 s and 280 MiB of RSS).
export function htmlScanDocuments(paths, profile = 'noloc') {
  if (!Object.hasOwn(PARSE_PROFILES, profile)) throw new Error(`Unknown HTML parse profile: ${profile}`);
  const { parse: parseText, costPerByte } = PARSE_PROFILES[profile];
  const perUse = (path, text) => parseText(text);
  const snapshot = snapshots.getStore();
  if (!snapshot?.active) return perUse;
  const entries = new Set(paths.map((path) => snapshot.files.get(realKey(snapshot, path))));
  if (entries.has(undefined)) return perUse;
  const pending = [...entries].filter((entry) => !entry.documents.has(profile));
  const cost = pending.reduce((sum, entry) => sum + entry.bytes.length * costPerByte, 0);
  if (snapshot.ledger.parseCost + cost > MAX_RETAINED_PARSE_COST) return perUse;
  for (const entry of pending) {
    entry.documents.set(profile, null);
    entry.parseCost += entry.bytes.length * costPerByte;
  }
  snapshot.ledger.parseCost += cost;
  return (path, text) => {
    const entry = snapshot.active ? snapshot.files.get(realKey(snapshot, path)) : null;
    if (!entry?.documents.has(profile) || text !== (entry.text ??= entry.bytes.toString('utf8'))) return parseText(text);
    let parsed = entry.documents.get(profile);
    if (!parsed) {
      try {
        parsed = { document: parseText(entry.text) };
      } catch (error) {
        parsed = { error };
      }
      entry.documents.set(profile, parsed);
    }
    if (parsed.error) throw parsed.error;
    return parsed.document;
  };
}

// Shared acorn programs for a set of local scripts whose bytes the snapshot
// already holds, one per file and source type (`script` or `module`: the
// same bytes can parse differently, or fail, as either). Returns
// `(path, module, text) => program`, parsing on first use with locations, and
// throwing the parser's error for a script that does not parse (a failure is
// shared like a tree). The program always matches the `text` given, as with
// htmlScanDocuments, and consumers never change it.
//
// The same whole-set-or-none rule as htmlScanDocuments, for the same V8
// pretenuring reason, against the same parse budget. An acorn program with
// locations measured 21x its UTF-8 source in heap on the certified-family
// scripts; the estimate leaves room for denser code.
const SCRIPT_PARSE_COST_PER_BYTE = 32;
export function htmlScanScriptPrograms(scripts) {
  const parseText = (text, module) => parseJs(text, { ecmaVersion: 'latest', sourceType: module ? 'module' : 'script', locations: true, allowHashBang: true });
  const perUse = (path, module, text) => parseText(text, module);
  const snapshot = snapshots.getStore();
  if (!snapshot?.active) return perUse;
  const wanted = new Map();
  for (const { path, module } of scripts) {
    const key = realKey(snapshot, path);
    const entry = snapshot.files.get(key);
    if (!entry) return perUse;
    const type = module ? 'module' : 'script';
    wanted.set(`${key}\u0000${type}`, { entry, type });
  }
  const pending = [...wanted.values()].filter(({ entry, type }) => !entry.programs?.has(type));
  const cost = pending.reduce((sum, { entry }) => sum + entry.bytes.length * SCRIPT_PARSE_COST_PER_BYTE, 0);
  if (snapshot.ledger.parseCost + cost > MAX_RETAINED_PARSE_COST) return perUse;
  for (const { entry, type } of pending) {
    (entry.programs ??= new Map()).set(type, null);
    entry.parseCost += entry.bytes.length * SCRIPT_PARSE_COST_PER_BYTE;
  }
  snapshot.ledger.parseCost += cost;
  return (path, module, text) => {
    const type = module ? 'module' : 'script';
    const entry = snapshot.active ? snapshot.files.get(realKey(snapshot, path)) : null;
    if (!entry?.programs?.has(type) || text !== (entry.text ??= entry.bytes.toString('utf8'))) return parseText(text, module);
    let parsed = entry.programs.get(type);
    if (!parsed) {
      try {
        parsed = { program: parseText(entry.text, module) };
      } catch (error) {
        parsed = { error };
      }
      entry.programs.set(type, parsed);
    }
    if (parsed.error) throw parsed.error;
    return parsed.program;
  };
}

// A collection computed once per snapshot under `key` (built-site scope, a
// source tree's permalinks); past the memo budget, or with no snapshot, it is
// computed per use. The value is frozen either way, one level down: the value,
// its object and array children, and those arrays' items. Deeper values are
// not frozen, so a memo holds flat records.
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
