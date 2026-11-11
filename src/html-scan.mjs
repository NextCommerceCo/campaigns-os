import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseJs } from 'acorn';
import { defaultTreeAdapter, parse } from 'parse5';

// The shared input context of one read-only doctor inspection (#730): file
// bytes, parsed trees and programs, and memoized collections. A synchronous
// doctor's snapshot ends with the invocation, so no file contents survive into
// another command, and an inspection that follows a write opens a fresh
// snapshot that never sees bytes from before the write. A snapshot opened
// inside an active one, without `reuse`, runs uncached. Past a budget a file
// is read or parsed per use, as it was before the snapshot existed. Read
// failures are never retained.
const snapshots = new AsyncLocalStorage();
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_FILES = 4096;
// Parsed trees and programs share one budget, estimated per source byte at the
// dense end of their heap cost: a parseBounded tree is 27x its UTF-8 source on
// the certified-family pages and 90x on markup made of bare attributes, an
// acorn program with locations 21x on the certified-family scripts.
const MAX_RETAINED_PARSE_COST = 64 * 1024 * 1024;
const PARSE_COST_PER_BYTE = { html: 56, script: 32, module: 32 };

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

const UNCACHED = Object.freeze({ active: false });

export function withHtmlScanSnapshot(operation, { reuse = false } = {}) {
  const live = snapshots.getStore();
  if (live === UNCACHED) return operation();
  if (live?.active) return reuse ? operation() : snapshots.run(UNCACHED, operation);
  const snapshot = { files: new Map(), paths: new Map(), memos: new Map(), bytes: 0, parseCost: 0, active: true };
  return snapshots.run(snapshot, () => {
    try {
      return operation();
    } finally {
      // AsyncLocalStorage propagates to queued callbacks too. Expire the store
      // at synchronous return, even if a future caller returns a Promise.
      snapshot.active = false;
      for (const held of [snapshot.files, snapshot.paths, snapshot.memos]) held.clear();
    }
  });
}

// The file's identity: its real path, so `/var/...` and `/private/var/...`
// are one entry.
function realKey(snapshot, path) {
  const key = resolve(path);
  try {
    if (!snapshot.paths.has(key)) snapshot.paths.set(key, realpathSync.native(key));
  } catch {
    return key;
  }
  return snapshot.paths.get(key);
}

function file(path) {
  const snapshot = snapshots.getStore();
  if (!snapshot?.active) return { bytes: readFileSync(path) };
  const key = realKey(snapshot, path);
  if (snapshot.files.has(key)) return snapshot.files.get(key);
  // parsed: kind -> null until first parsed, then { value } or { error }.
  const entry = { bytes: readFileSync(path), parsed: new Map() };
  // Budget buffer + worst-case decoded UTF-16 text together. Oversize files
  // retain the original read-per-use behavior; tiny files are count-bounded.
  const cost = entry.bytes.length * 3;
  if (snapshot.files.size < MAX_RETAINED_FILES && snapshot.bytes + cost <= MAX_RETAINED_BYTES) {
    snapshot.files.set(key, entry);
    snapshot.bytes += cost;
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

// One shared parse per held file and kind (`html`, or a script as `script` or
// `module`: the same bytes can parse differently, or fail, as either) for
// every consumer in the snapshot, which reads it and never changes it. Returns
// `(path, kind, text) => parsed`, parsing on first use, or null when the set
// cannot be shared: no snapshot, a file whose bytes are not held, or parses
// past the budget. Text other than the held text is parsed per use. A
// script's parse error, and a page's TooDeep, is shared like a result; any
// other HTML parse error is not kept, so each consumer parses again.
//
// The set is shared whole or not at all. Retaining only the first few trees is
// worse than retaining none: V8 then pretenures parse5's node allocations, so
// every later throwaway tree is allocated in old space (on 304 built pages,
// 4 MiB of retained trees cost 0.2-0.4 s and 280 MiB of RSS).
function reserve(items, parseText) {
  const snapshot = snapshots.getStore();
  if (!snapshot?.active) return null;
  const pending = new Map();
  for (const { path, kind } of items) {
    const key = realKey(snapshot, path);
    const entry = snapshot.files.get(key);
    if (!entry) return null;
    if (!entry.parsed.has(kind)) pending.set(`${key}\u0000${kind}`, { entry, kind });
  }
  const cost = [...pending.values()].reduce((sum, { entry, kind }) => sum + entry.bytes.length * PARSE_COST_PER_BYTE[kind], 0);
  if (snapshot.parseCost + cost > MAX_RETAINED_PARSE_COST) return null;
  for (const { entry, kind } of pending.values()) entry.parsed.set(kind, null);
  snapshot.parseCost += cost;
  return (path, kind, text) => {
    const entry = snapshot.active ? snapshot.files.get(realKey(snapshot, path)) : null;
    if (!entry?.parsed.has(kind) || text !== (entry.text ??= entry.bytes.toString('utf8'))) return parseText(text, kind);
    let parsed = entry.parsed.get(kind);
    if (!parsed) {
      try {
        parsed = { value: parseText(entry.text, kind) };
      } catch (error) {
        if (kind === 'html' && !(error instanceof TooDeep)) throw error;
        parsed = { error };
      }
      entry.parsed.set(kind, parsed);
    }
    if (parsed.error) throw parsed.error;
    return parsed.value;
  };
}

const HTML_PARSERS = Object.freeze({
  noloc: (text) => parse(text),
  located: (text) => parse(text, { sourceCodeLocationInfo: true }),
  bounded: parseBounded,
});

// Shared parse5 trees for a set of held pages: one parseBounded tree per page
// for every consumer whatever its profile, since within the bound it builds
// the located tree node for node and noloc consumers ignore locations. Returns
// `(path, text) => document`. A noloc or located consumer gets its own
// unbounded parse of a page past the depth bound, so it sees every page it saw
// before trees were shared; an unshared set is parsed per use with the profile
// asked for. Template content and other nested contexts stay inside the tree
// as parse5 builds them; a consumer that reparses a fragment (noscript,
// srcdoc) does so itself.
export function htmlScanDocuments(paths, profile = 'noloc') {
  if (!Object.hasOwn(HTML_PARSERS, profile)) throw new Error(`Unknown HTML parse profile: ${profile}`);
  const parseText = HTML_PARSERS[profile];
  const shared = reserve(paths.map((path) => ({ path, kind: 'html' })), parseBounded);
  if (!shared) return (path, text) => parseText(text);
  return (path, text) => {
    try {
      return shared(path, 'html', text);
    } catch (error) {
      if (profile === 'bounded' || !(error instanceof TooDeep)) throw error;
      return parseText(text);
    }
  };
}

// Shared acorn programs, with locations, for a set of held local scripts
// (`{ path, module }`). Returns `(path, module, text) => program`, throwing
// the parser's error for a script that does not parse.
export function htmlScanScriptPrograms(scripts) {
  const parseText = (text, kind) => parseJs(text, { ecmaVersion: 'latest', sourceType: kind, locations: true, allowHashBang: true });
  const kindOf = (module) => (module ? 'module' : 'script');
  const shared = reserve(scripts.map(({ path, module }) => ({ path, kind: kindOf(module) })), parseText) || ((path, kind, text) => parseText(text, kind));
  return (path, module, text) => shared(path, kindOf(module), text);
}

// A collection computed once per snapshot under `key` (built-site scope, a
// source tree's permalinks), or per use with no snapshot. Either way the
// value, its children and its array children's items are frozen, and nothing
// deeper, so a memo holds flat records.
export function htmlScanMemo(key, compute) {
  const snapshot = snapshots.getStore();
  if (!snapshot?.active) return freezeShallow(compute());
  if (!snapshot.memos.has(key)) snapshot.memos.set(key, freezeShallow(compute()));
  return snapshot.memos.get(key);
}

function freezeShallow(value) {
  if (!value || typeof value !== 'object') return value;
  // Object.freeze returns a primitive unchanged, so children need no type check.
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach((item) => Object.freeze(item));
    Object.freeze(child);
  }
  return Object.freeze(value);
}
