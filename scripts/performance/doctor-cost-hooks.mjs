// Preload for scripts/performance/doctor-cost.mjs (#730). It counts the work a
// doctor call does without editing src/, and guards the call against writes and
// network requests.
//
// DOCTOR_COST_MODE=count (default) installs everything below. DOCTOR_COST_MODE=plain
// installs only the guards, so the driver can time the same call without the
// counters (the counters run inside the timer and cost a few percent).
//
// - node:fs: the CommonJS fs object is wrapped and syncBuiltinESMExports()
//   pushes the wrappers into the live bindings of `import { readFileSync } from
//   "node:fs"` inside src/. A re-entrancy guard counts only the outermost call
//   (readFileSync(path) without an encoding calls openSync/readSync through the
//   same exports object). A call that returns is counted under its operation; a
//   call that throws (a missing file, say) is counted separately as failed.
//   Distinct reads and readdirs are keyed by realpath, so one file read as
//   /var/... and as /private/var/... is one file; the number of path spellings
//   is kept as well.
// - parse5 and acorn: src/ binds `parse` at link time, so the imports are
//   redirected at resolve time (module.registerHooks, Node >= 22.15) to a
//   generated wrapper that records each call and forwards to the real package.
// - Selected src/ exports (scope resolution, build fingerprint, evidence debt,
//   commerce signature, drift classification) and the doctor check registry are
//   replaced by generated wrapper modules that count or time calls made across
//   module boundaries. Calls inside the defining module are not seen; the fs and
//   parse counters still are.
//
// Counting happens only between begin() and end(), so module loading and
// fixture setup are excluded. During a measured call every fs write throws
// (path writers, write-flag opens through openSync, open, promises.open and
// createWriteStream, and descriptor writers), except under the scratch root the
// record workload names, and fetch rejects. Every refusal is also recorded, so a
// caller that swallows the error still shows up in the result.
// The driver passes the checkout under measurement in DOCTOR_COST_ROOT.
import fs from "node:fs";
import { createHash } from "node:crypto";
import * as nodeModule from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODE = process.env.DOCTOR_COST_MODE === "plain" ? "plain" : "count";
if (MODE === "count" && typeof nodeModule.registerHooks !== "function") {
  throw new Error(`doctor-cost needs Node >= 22.15 (module.registerHooks); this is ${process.version}.`);
}
const ROOT = process.env.DOCTOR_COST_ROOT;
if (!ROOT) throw new Error("doctor-cost-hooks.mjs: DOCTOR_COST_ROOT must name the campaigns-os checkout to measure.");
const SRC_URL = pathToFileURL(resolve(ROOT, "src") + sep).href;
const STACKS = process.env.DOCTOR_COST_STACKS === "1";

// src/ exports counted per call, by module path relative to src/.
export const COUNTED_EXPORTS = {
  "built-site-scope.mjs": ["resolveBuiltSiteScope", "computeBuildFingerprint"],
  "change-scope.mjs": ["buildCommerceSignature", "classifyDrift", "pageCommerceFacts", "campaignConfigFingerprint"],
  "evidence-debt.mjs": ["assessEvidenceDebt"],
  "html-scan.mjs": ["withHtmlScanSnapshot"],
  "live-campaign-refs.mjs": ["extractRenderedRefs"],
  "page-kit-campaign-config.mjs": ["loadPageKitCampaignEntry"],
};
const REGISTRY = "doctor-check-registry.mjs";
const PARSERS = new Set(["parse5", "acorn"]);
const REAL = "doctor-cost-real";
const WRAP = "doctor-cost-wrap";

const WATCHED = ["readFileSync", "readSync", "openSync", "readdirSync", "opendirSync", "statSync", "lstatSync", "existsSync", "accessSync", "realpathSync"];
// Operations whose distinct count is keyed by realpath.
const CANONICAL = new Set(["readFileSync", "readdirSync"]);
// Operations attributed to src/ call sites under --stacks.
const SITED = new Set(["readFileSync", "readdirSync", "realpathSync"]);
const WRITES = ["writeFileSync", "appendFileSync", "writeSync", "writevSync", "mkdirSync", "mkdtempSync", "renameSync", "rmSync", "rmdirSync",
  "unlinkSync", "copyFileSync", "cpSync", "symlinkSync", "linkSync", "truncateSync", "ftruncateSync", "utimesSync", "lutimesSync", "futimesSync",
  "chmodSync", "lchmodSync", "fchmodSync", "chownSync", "lchownSync", "fchownSync", "fsyncSync", "fdatasyncSync"];
// Path writers with callbacks; the same names on fs.promises return promises.
const ASYNC_WRITES = ["writeFile", "appendFile", "mkdir", "mkdtemp", "rename", "rm", "rmdir", "unlink", "copyFile", "cp", "symlink", "link",
  "truncate", "utimes", "lutimes", "chmod", "lchmod", "chown", "lchown"];
// Descriptor writers with callbacks. A descriptor is writable only if a guarded open let it through.
const ASYNC_FD_WRITES = ["write", "writev", "ftruncate", "futimes", "fchmod", "fchown", "fsync", "fdatasync"];
// Path arguments a write touches, by base name (fs.renameSync, fs.rename and fs.promises.rename share one).
const PATH_ARGS = { rename: [0, 1], copyFile: [0, 1], cp: [0, 1], symlink: [1], link: [0, 1] };
const FD_WRITES = new Set(["writeSync", "writevSync", "ftruncateSync", "futimesSync", "fchmodSync", "fchownSync", "fsyncSync", "fdatasyncSync",
  ...ASYNC_FD_WRITES]);

function freshState() {
  return {
    fs: {}, failed: {}, spellings: {}, readBytes: 0, firstReadBytes: new Map(), parses: {}, calls: {}, checks: new Map(), sites: {},
    heapPeak: 0, writes: [], refused: [],
  };
}

const realRealpath = fs.realpathSync;
const canonicalCache = new Map();

const cost = {
  mode: MODE,
  active: false,
  inFs: false,
  check: null,
  allowWritesUnder: null,
  missingExports: new Set(),
  state: freshState(),
  begin({ allowWritesUnder = null } = {}) {
    this.state = freshState();
    this.allowWritesUnder = allowWritesUnder ? allowWritesUnder.map((root) => resolve(root)) : null;
    this.sample();
    this.active = true;
  },
  end() {
    this.active = false;
    this.sample();
    this.allowWritesUnder = null;
    return this.state;
  },
  sample() {
    if (MODE !== "count") return;
    const used = process.memoryUsage().heapUsed;
    if (used > this.state.heapPeak) this.state.heapPeak = used;
  },
  // realpath of a path that was just read, outside the counters; the raw path if it has none.
  canonical(path) {
    if (path === "<fd>") return path;
    let real = canonicalCache.get(path);
    if (real === undefined) {
      const outer = this.inFs;
      this.inFs = true;
      try {
        real = realRealpath(path);
        canonicalCache.set(path, real);
      } catch {
        real = path;
      } finally {
        this.inFs = outer;
      }
    }
    return real;
  },
  site() {
    if (!STACKS) return null;
    const frames = [];
    for (const line of new Error().stack.split("\n").slice(3)) {
      const match = line.match(/at (?:(\S+) )?\(?(file:\/\/[^)]+?):(\d+):\d+\)?$/);
      if (!match || !match[2].startsWith(SRC_URL)) continue;
      const rel = match[2].slice(SRC_URL.length);
      // Generated wrappers keep the plain URL; the real module carries ?doctor-cost-real.
      if (COUNTED_EXPORTS[rel] || rel === REGISTRY) continue;
      frames.push(`${rel.replace(/\?.*$/, "")}:${match[3]} ${(match[1] || "<anonymous>").replace(/^Module\./, "")}`);
      if (frames.length === 2) break;
    }
    return `${this.check || "-"} | ${frames.join(" < ") || "(outside src)"}`;
  },
  bumpSite(kind) {
    const where = this.site();
    if (!where) return;
    const map = (this.state.sites[kind] ??= new Map());
    map.set(where, (map.get(where) || 0) + 1);
  },
  refuse(kind, op) {
    if (this.active) this.state.refused.push(`${kind}:${op}`);
  },
  recordParse(parser, input, options) {
    if (!this.active) return;
    this.sample();
    const text = typeof input === "string" ? input : String(input ?? "");
    const profile = parser === "acorn"
      ? (options?.sourceType === "module" ? "module" : "script")
      : `${options?.sourceCodeLocationInfo ? "loc" : "noloc"}${options?.treeAdapter ? "+bounded" : ""}`;
    const digest = createHash("sha1").update(text).digest("hex");
    const entry = (this.state.parses[parser] ??= { calls: 0, bytes: 0, profiles: new Map(), inputs: new Map(), contents: new Set() });
    entry.calls += 1;
    entry.bytes += Buffer.byteLength(text);
    entry.profiles.set(profile, (entry.profiles.get(profile) || 0) + 1);
    const key = `${digest}:${profile}`;
    entry.inputs.set(key, (entry.inputs.get(key) || 0) + 1);
    entry.contents.add(digest);
    this.bumpSite(parser);
  },
  countCall(name) {
    if (this.active) this.state.calls[name] = (this.state.calls[name] || 0) + 1;
  },
  missingExport(name) {
    this.missingExports.add(name);
  },
  timedCheck: (() => {
    const wrapped = new WeakMap();
    return (check) => {
      if (!check || typeof check.run !== "function") return check;
      if (wrapped.has(check)) return wrapped.get(check);
      const timed = Object.freeze({
        ...check,
        run(context) {
          const outer = cost.check;
          cost.check = check.id;
          const start = performance.now();
          try {
            return check.run(context);
          } finally {
            if (cost.active) {
              const row = cost.state.checks.get(check.id) || { ms: 0, calls: 0 };
              row.ms += performance.now() - start;
              row.calls += 1;
              cost.state.checks.set(check.id, row);
            }
            cost.check = outer;
          }
        },
      });
      wrapped.set(check, timed);
      return timed;
    };
  })(),
};
globalThis.__doctorCost = cost;

function pathOf(value) {
  if (typeof value === "string") return value;
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString();
  return typeof value === "number" ? `<fd>` : String(value);
}

function bump(table, op, path) {
  const map = (table[op] ??= new Map());
  map.set(path, (map.get(path) || 0) + 1);
}

function openFlagsWrite(flags) {
  if (flags == null) return false;
  if (typeof flags === "number") return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC)) !== 0;
  return /[wa+]/.test(String(flags));
}

function underAllowedRoot(path) {
  if (!cost.allowWritesUnder) return false;
  const absolute = resolve(pathOf(path));
  return cost.allowWritesUnder.some((root) => absolute === root || absolute.startsWith(root + sep));
}

function refuseWrite(name, args) {
  if (!cost.active || cost.inFs) return;
  if (FD_WRITES.has(name)) {
    // Descriptors are only writable if a guarded open let them through.
    if (cost.allowWritesUnder || args[0] === 1 || args[0] === 2) return;
  } else {
    const indexes = PATH_ARGS[name.replace(/^promises\./, "").replace(/Sync$/, "")] || [0];
    if (indexes.every((index) => underAllowedRoot(args[index]))) {
      cost.state.writes.push(name);
      return;
    }
  }
  cost.refuse("write", name);
  throw new Error(`doctor-cost: refused fs.${name}(${pathOf(args[0])}) during a measured call; the measured code must not write.`);
}

function guardOpen(name, args) {
  if (openFlagsWrite(typeof args[1] === "function" ? undefined : args[1])) refuseWrite(name, args);
}

if (MODE === "count") {
  for (const name of WATCHED) {
    const original = fs[name];
    if (typeof original !== "function") continue;
    const wrapped = function (...args) {
      if (name === "openSync") guardOpen("openSync", args);
      const outer = cost.inFs;
      const counting = cost.active && !outer;
      const path = name === "readSync" ? "<fd>" : pathOf(args[0]);
      cost.inFs = true;
      let out;
      try {
        out = original.apply(this, args);
      } catch (error) {
        if (counting) bump(cost.state.failed, name, path);
        throw error;
      } finally {
        cost.inFs = outer;
      }
      if (counting) {
        if (CANONICAL.has(name)) {
          const real = cost.canonical(path);
          bump(cost.state.fs, name, real);
          bump(cost.state.spellings, name, path);
        } else {
          bump(cost.state.fs, name, path);
        }
        if (SITED.has(name)) cost.bumpSite(name);
        if (name === "readFileSync" || name === "readSync") {
          const bytes = name === "readSync" ? (Number(out) || 0) : typeof out === "string" ? Buffer.byteLength(out) : (out?.length ?? 0);
          cost.state.readBytes += bytes;
          if (name === "readFileSync") {
            const real = cost.canonical(path);
            if (!cost.state.firstReadBytes.has(real)) cost.state.firstReadBytes.set(real, bytes);
            cost.sample();
          }
        }
      }
      return out;
    };
    if (typeof original.native === "function") {
      // realpathSync.native is a separate entry point; count it as realpathSync.
      const native = original.native;
      wrapped.native = function (...args) {
        const counting = cost.active && !cost.inFs;
        let out;
        try {
          out = native.apply(this, args);
        } catch (error) {
          if (counting) bump(cost.state.failed, name, pathOf(args[0]));
          throw error;
        }
        if (counting) {
          bump(cost.state.fs, name, pathOf(args[0]));
          if (SITED.has(name)) cost.bumpSite(name);
        }
        return out;
      };
    }
    fs[name] = wrapped;
  }
} else {
  const openSync = fs.openSync;
  fs.openSync = function (...args) {
    guardOpen("openSync", args);
    return openSync.apply(this, args);
  };
}

for (const name of WRITES) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  fs[name] = function (...args) {
    refuseWrite(name, args);
    const outer = cost.inFs;
    cost.inFs = true;
    try {
      return original.apply(this, args);
    } finally {
      cost.inFs = outer;
    }
  };
}
// Doctor is synchronous; the async writers are guarded too, so a refactor that
// starts writing through them cannot slip past the guard. Streams open through
// fs.open, and FileHandle writes need a handle from the guarded promises.open.
for (const target of [fs, fs.promises]) {
  const prefix = target === fs ? "" : "promises.";
  for (const name of [...ASYNC_WRITES, ...(target === fs ? ASYNC_FD_WRITES : [])]) {
    const original = target[name];
    if (typeof original !== "function") continue;
    target[name] = function (...args) {
      refuseWrite(`${prefix}${name}`, args);
      return original.apply(this, args);
    };
  }
  const open = target.open;
  target.open = function (...args) {
    guardOpen(`${prefix}open`, args);
    return open.apply(this, args);
  };
}
const createWriteStream = fs.createWriteStream;
fs.createWriteStream = function (path, options) {
  const flags = typeof options === "object" && options ? options.flags : undefined;
  if (typeof options === "object" && options?.fd != null) refuseWrite("write", [options.fd]);
  else if (openFlagsWrite(flags ?? "w")) refuseWrite("createWriteStream", [path]);
  return createWriteStream.call(this, path, options);
};
nodeModule.syncBuiltinESMExports();

// No network during a measured call: fetch rejects, and the attempt is recorded
// even when the caller never awaits or catches it.
globalThis.fetch = function (input) {
  cost.refuse("fetch", "fetch");
  return Promise.reject(new Error(`doctor-cost: refused fetch(${input instanceof URL ? input.href : typeof input === "string" ? input : "request"}) in a doctor-cost process.`));
};

const parserWrapper = (realUrl, parser) => [
  `import * as real from ${JSON.stringify(realUrl)};`,
  `export * from ${JSON.stringify(realUrl)};`,
  `export function parse(input, options) { globalThis.__doctorCost.recordParse(${JSON.stringify(parser)}, input, options); return real.parse(input, options); }`,
].join("\n");

function exportWrapper(realUrl, rel) {
  const lines = [`import * as real from ${JSON.stringify(realUrl)};`, `export * from ${JSON.stringify(realUrl)};`];
  for (const name of COUNTED_EXPORTS[rel]) {
    const label = JSON.stringify(`${rel}#${name}`);
    lines.push(
      `if (typeof real.${name} !== "function") globalThis.__doctorCost.missingExport(${label});`,
      `export function ${name}(...args) { globalThis.__doctorCost.countCall(${label}); return real.${name}(...args); }`,
    );
  }
  return lines.join("\n");
}

const registryWrapper = (realUrl) => [
  `import * as real from ${JSON.stringify(realUrl)};`,
  `export * from ${JSON.stringify(realUrl)};`,
  `if (typeof real.runDoctorCheckRegistry !== "function") globalThis.__doctorCost.missingExport("${REGISTRY}#runDoctorCheckRegistry");`,
  "export function runDoctorCheckRegistry(checks, context, options) {",
  "  return real.runDoctorCheckRegistry(checks.map((check) => globalThis.__doctorCost.timedCheck(check)), context, options);",
  "}",
].join("\n");

const withQuery = (url, query) => `${url}${url.includes("?") ? "&" : "?"}${query}`;
const stripQuery = (url, query) => url.replace(new RegExp(`[?&]${query}(=[^&]*)?$`), "");

if (MODE === "count") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const fromSrc = typeof context.parentURL === "string" && context.parentURL.startsWith(SRC_URL);
      if (fromSrc && PARSERS.has(specifier)) {
        const real = nextResolve(specifier, context);
        return { ...real, url: withQuery(real.url, `${WRAP}=${specifier}`), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const parser = url.match(new RegExp(`[?&]${WRAP}=(parse5|acorn)$`));
      if (parser) {
        const source = parserWrapper(stripQuery(url, WRAP), parser[1]);
        return { format: "module", source, shortCircuit: true };
      }
      if (url.startsWith(SRC_URL) && !url.includes(`?${REAL}`)) {
        const rel = url.slice(SRC_URL.length);
        if (COUNTED_EXPORTS[rel]) return { format: "module", source: exportWrapper(withQuery(url, REAL), rel), shortCircuit: true };
        if (rel === REGISTRY) return { format: "module", source: registryWrapper(withQuery(url, REAL)), shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
