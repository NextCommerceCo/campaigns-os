#!/usr/bin/env node
// Doctor cost harness (#730 milestone 1). Counts what one doctor-family call
// does (wall time, scope enumerations, file reads, stat/realpath calls, HTML
// and JS parses, fingerprint/evidence-debt passes, per-check time, memory)
// without changing src/. Each sample runs the call twice, each in a fresh
// process: once preloaded with the counters (doctor-cost-hooks.mjs), once with
// only the guards ("plain"), because the counters run inside the timer. Wall
// time, maxRSS and heap after GC are reported from the plain process; peak
// heapUsed (sampled at each read and parse, garbage included) from the counted
// one. Imports and fixture setup sit outside the timer. The measured call never
// makes network requests (fetch rejects) and must not write (an fs write
// throws), except the record workload on a scratch copy; a refused write or
// fetch fails the measurement even if the caller swallowed the error.
//
//   node scripts/performance/doctor-cost.mjs <workload> [target] [options]
//
// Workloads and targets:
//   built      --built <dir> [--slug <s>] [--family <f>]   doctorBuiltOutput
//   packet     --packet <file> [--live-stub]               doctorPacket
//   ci         --packet <file>                             doctorCommand --ci, live read disabled
//   debt       --packet <file>                             assessEvidenceDebt
//   signature  --packet <file>                             buildCommerceSignature
//   record     --packet <file> [--stage build]             recordStageCommand; the packet
//              must sit under the OS temp dir (writes are allowed only there)
//   import     (no target)                                 imports only: the RSS/heap floor
//   Instead of --built/--packet, `--estate <copies>` generates a synthetic estate
//   in a temp dir: the example campaign plus <copies> copies of the
//   olympus-mv-two-step certified pages (12 pages each, unique bytes per copy so
//   parse dedup stays honest). `--estate-stage recorded` also runs a real
//   `record build` and then edits one page's copy, so evidence debt has drift to
//   classify. Record gets a fresh estate per sample.
//
// Options:
//   --samples <n>        samples (default 3), each a counted and a plain process;
//                        medians and ranges are reported
//   --no-plain           skip the plain process (wall time and memory then come
//                        from the counted process only)
//   --label <name>       names the target in the output (default "target")
//   --no-redact          keep absolute paths and slugs (default: replaced by the
//                        label, other path segments hashed, and the output
//                        refused unless every string has a known redacted shape)
//   --markdown           print a Markdown summary instead of JSON
//   --out <file>         also write the JSON result to <file>
//   --stacks             attribute reads/readdirs/realpaths/parses to src/ call sites
//   --cpu-prof <dir>     write a V8 CPU profile of each plain process to <dir>
//   --private-sources inherit   let private family sources resolve as they do
//                        locally (default: PRIVATE_TEMPLATE_SOURCES_ROOT points
//                        at an empty dir)
//   --no-baseline        skip the import-only process
//   --root <checkout>    measure another campaigns-os checkout's src/
//
// Other commands:
//   make-estate --out <dir under the OS temp dir> --copies <n> [--estate-stage recorded]
//   summarize <result.json>...   Markdown tables, one per workload (--stacks results are skipped)
//   summarize-profile <file.cpuprofile> [--top <n>]   inclusive ms per src/ or dependency function
//
// Examples (Node >= 22.15):
//   node scripts/performance/doctor-cost.mjs built --built fixtures/certified-families --slug olympus --family olympus --label certified-olympus --no-redact
//   node scripts/performance/doctor-cost.mjs packet --estate 25 --label synthetic-304 --out out/packet-304.json
//   node scripts/performance/doctor-cost.mjs summarize out/packet-304.json
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { arch, cpus, homedir, platform, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const SCHEMA = "campaigns-os-doctor-cost/v1";
export const WORKLOADS = ["built", "packet", "ci", "debt", "signature", "record", "import"];
const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(HERE, "doctor-cost-hooks.mjs");
const TOOLKIT = resolve(HERE, "../..");
const ESTATE_FAMILY = "olympus-mv-two-step";
const FIXED_TIME = new Date("2026-01-01T00:00:00.000Z");

const OPTIONS = {
  built: { type: "string" }, slug: { type: "string" }, family: { type: "string" },
  packet: { type: "string" }, "live-stub": { type: "boolean" }, stage: { type: "string" },
  estate: { type: "string" }, "estate-stage": { type: "string" }, copies: { type: "string" },
  samples: { type: "string" }, label: { type: "string" }, "no-redact": { type: "boolean" },
  markdown: { type: "boolean" }, out: { type: "string" }, stacks: { type: "boolean" },
  "private-sources": { type: "string" }, "no-baseline": { type: "boolean" }, root: { type: "string" },
  "no-plain": { type: "boolean" }, "cpu-prof": { type: "string" }, top: { type: "string" },
  child: { type: "string" },
};

// ---------------------------------------------------------------------------
// Shared helpers

const round = (value, places = 1) => (value == null ? null : Math.round(value * 10 ** places) / 10 ** places);
const mb = (bytes) => round(bytes / 2 ** 20);

function median(values) {
  const sorted = values.filter((value) => value != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// realpath of the nearest existing ancestor, with the missing tail re-appended.
function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realOrSelf(parent), basename(path));
  }
}

function isUnder(path, root) {
  const real = realOrSelf(resolve(path));
  const base = realOrSelf(resolve(root));
  return real.startsWith(base + sep);
}

// The environment every child and estate subprocess gets: no credentials,
// telemetry off, no run session found through $HOME.
function hermeticEnv(sandbox, extra = {}) {
  return {
    PATH: process.env.PATH, HOME: sandbox, TMPDIR: tmpdir(), LC_ALL: "en_US.UTF-8",
    CAMPAIGNS_OS_TELEMETRY: "off", CAMPAIGNS_OS_LIFECYCLE_LOG: "", ...extra,
  };
}

function git(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Synthetic estate (outside any measurement)

export function makeEstate(dir, { copies = 1, stage = "built", root = TOOLKIT, env = hermeticEnv(tmpdir()) } = {}) {
  assert.ok(Number.isInteger(copies) && copies >= 0 && copies <= 500, "--copies must be 0..500");
  assert.ok(["built", "recorded"].includes(stage), "--estate-stage must be built or recorded");
  assert.ok(isUnder(dir, tmpdir()), `make-estate writes only under the OS temp dir (${tmpdir()}); got ${dir}`);
  assert.ok(!existsSync(dir) || readdirSync(dir).length === 0, `make-estate needs an empty or missing directory: ${dir}`);
  const cli = join(root, "bin/campaigns-os.mjs");
  const run = (args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env });
    if (result.status !== 0) throw new Error(`campaigns-os ${args.slice(0, 2).join(" ")} failed while making the estate:\n${result.stderr || result.stdout}`);
    return result.stdout;
  };
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  const writeJson = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  };
  mkdirSync(dir, { recursive: true });
  // The recipe of src/stage-record.test.mjs: prepare-build, mark it complete,
  // write page-kit campaign data, build pages, record setup.
  const source = join(dir, "source");
  const target = join(dir, "target");
  const specPath = join(dir, "campaignspec.json");
  cpSync(join(root, "examples/source-html"), source, { recursive: true });
  const spec = readJson(join(root, "examples/campaignspec.v42.basic.json"));
  for (const funnel of spec.funnels || []) for (const page of funnel.pages || []) delete page.sdk_hints;
  writeJson(specPath, spec);
  writeJson(join(target, "package.json"), { private: true, devDependencies: { "next-campaign-page-kit": "0.2.0" } });
  run(["prepare-build", "--spec", specPath, "--source", source, "--target", target, "--template-family", "olympus", "--no-run-session", "--json"]);
  const reportPath = join(target, ".campaign-runtime/assembly-report.json");
  const report = readJson(reportPath);
  Object.assign(report.stages.prepare_build, { status: "completed", blockers: [] });
  Object.assign(report, { blockers: [], status: "prepared" });
  writeJson(reportPath, report);
  const packetPath = join(target, "campaign-runtime.build.json");
  const packet = readJson(packetPath);
  const slug = packet.campaign.public_route_slug;
  mkdirSync(resolve(target, packet.assembly.output_dir), { recursive: true });
  const storeKeys = ["store_name", "store_url", "store_terms", "store_privacy", "store_contact", "store_returns", "store_shipping", "store_phone", "store_phone_tel"];
  const entry = Object.fromEntries(storeKeys.map((key) => [key, spec.campaign[key]]));
  entry.sdk_version = spec.runtime?.sdk_version || spec.global_config?.sdk_version;
  writeJson(join(target, "_data/campaigns.json"), { [spec.campaign.slug]: entry });
  const site = join(target, "_site", slug);
  let pages = 0;
  for (const page of spec.funnels.flatMap((funnel) => funnel.pages)) {
    const route = String(page.page_url || "").replace(/^\/+|\/+$/g, "");
    const file = join(site, route, "index.html");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `<!doctype html><html><head><meta name="next-page-type" content="${page.type}"><title>${page.id}</title><script src="https://cdn.example.com/campaign-cart@v0.4.37/dist/loader.js"></script></head><body><h1>${page.id}</h1></body></html>\n`);
    pages += 1;
  }
  const family = join(root, "fixtures/certified-families/_site", ESTATE_FAMILY);
  const walk = (path) => readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((item) => (item.isDirectory() ? walk(join(path, item.name)) : [join(path, item.name)]));
  for (let index = 0; index < copies; index += 1) {
    const copy = join(site, `estate-${index}`);
    cpSync(family, copy, { recursive: true });
    for (const file of walk(copy)) {
      if (file.endsWith(".html")) {
        // Root-relative asset paths follow the copy, so its scripts resolve and are read.
        const html = readFileSync(file, "utf8").split(`/${ESTATE_FAMILY}/`).join(`/${slug}/estate-${index}/`);
        writeFileSync(file, `${html}<!-- estate-${index} -->\n`);
        pages += 1;
      } else if (file.endsWith(".js")) {
        appendFileSync(file, `\n// estate-${index}\n`);
      }
    }
  }
  for (const file of walk(join(target, "_site"))) utimesSync(file, FIXED_TIME, FIXED_TIME);
  run(["record", "setup", "--packet", packetPath, "--json"]);
  if (stage === "recorded") {
    run(["record", "build", "--packet", packetPath, "--json"]);
    // A copy-only edit after the recorded build, so evidence debt classifies drift.
    const edited = copies > 0 ? join(site, "estate-0/landing/index.html") : walk(site).find((file) => file.endsWith(".html"));
    writeFileSync(edited, readFileSync(edited, "utf8").replace("</body>", "<p>Estate copy edit.</p></body>"));
  }
  return { dir, packet: packetPath, built: target, slug, pages, copies, stage };
}

// ---------------------------------------------------------------------------
// Child: one measured call in a preloaded process

function summarizeCounts(map, top = 10) {
  if (!map) return { calls: 0, distinct: 0, ...(top ? { top_repeated: [] } : {}) };
  const calls = [...map.values()].reduce((sum, count) => sum + count, 0);
  const out = { calls, distinct: map.size };
  if (top) out.top_repeated = [...map.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, top);
  return out;
}

const total = (map) => [...(map?.values() || [])].reduce((sum, count) => sum + count, 0);

const HISTOGRAM = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 8], [9, 16], [17, Infinity]];
function repeatHistogram(map) {
  const out = {};
  for (const [low, high] of HISTOGRAM) {
    const label = low === high ? `${low}` : high === Infinity ? `${low}+` : `${low}-${high}`;
    out[label] = [...(map?.values() || [])].filter((count) => count >= low && count <= high).length;
  }
  return out;
}

// Observed reads per file, by extension: files, reads, and the lowest/highest count.
function repeatByExtension(map) {
  const rows = new Map();
  for (const [path, count] of map?.entries() || []) {
    const ext = extname(path).toLowerCase() || "none";
    const row = rows.get(ext) || { files: 0, reads: 0, min_reads: Infinity, max_reads: 0 };
    row.files += 1;
    row.reads += count;
    row.min_reads = Math.min(row.min_reads, count);
    row.max_reads = Math.max(row.max_reads, count);
    rows.set(ext, row);
  }
  return Object.fromEntries([...rows.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

function parseSummary(entry) {
  if (!entry) return { calls: 0, distinct: 0, distinct_content: 0, mb: 0, by_profile: {} };
  const byProfile = {};
  for (const [profile, calls] of [...entry.profiles.entries()].sort()) {
    const distinct = [...entry.inputs.keys()].filter((key) => key.slice(key.indexOf(":") + 1) === profile).length;
    byProfile[profile] = { calls, distinct };
  }
  return { calls: entry.calls, distinct: entry.inputs.size, distinct_content: entry.contents.size, mb: mb(entry.bytes), by_profile: byProfile };
}

function childCounters(cost, state) {
  const fsOp = (name, top = 0) => summarizeCounts(state.fs[name], top);
  const failed = (name) => total(state.failed[name]);
  const reads = state.fs.readFileSync;
  const spellings = state.spellings.readFileSync;
  // Files read under more than one path spelling (/var/... and /private/var/..., say).
  const perFile = new Map();
  for (const raw of spellings?.keys() || []) {
    const real = cost.canonical(raw);
    perFile.set(real, (perFile.get(real) || 0) + 1);
  }
  const calls = {};
  for (const [rel, names] of Object.entries(COUNTED)) {
    for (const name of names) calls[name] = cost.missingExports.has(`${rel}#${name}`) ? null : (state.calls[`${rel}#${name}`] || 0);
  }
  const counters = {
    scope_resolutions: calls.resolveBuiltSiteScope,
    reads: {
      ...summarizeCounts(reads),
      failed: failed("readFileSync"),
      distinct_paths: spellings?.size ?? 0,
      files_read_under_several_paths: [...perFile.values()].filter((count) => count > 1).length,
      mb_total: mb(state.readBytes),
      mb_distinct: mb([...state.firstReadBytes.values()].reduce((sum, bytes) => sum + bytes, 0)),
      repeat_histogram: repeatHistogram(reads),
      by_extension: repeatByExtension(reads),
      fd_reads: fsOp("readSync").calls,
      opens: fsOp("openSync").calls,
    },
    readdir: { ...fsOp("readdirSync", 10), failed: failed("readdirSync"), opendir: fsOp("opendirSync").calls },
    stat: {
      stat: fsOp("statSync"), lstat: fsOp("lstatSync"), exists: fsOp("existsSync"), access: fsOp("accessSync"), realpath: fsOp("realpathSync", 5),
      failed: { stat: failed("statSync"), lstat: failed("lstatSync"), access: failed("accessSync"), realpath: failed("realpathSync") },
    },
    parse5: parseSummary(state.parses.parse5),
    acorn: parseSummary(state.parses.acorn),
    calls,
    checks: [...state.checks.entries()].map(([id, row]) => ({ id, calls: row.calls, ms: round(row.ms) })),
    allowed_writes: state.writes.length,
  };
  if (Object.keys(state.sites).length) {
    counters.sites = Object.fromEntries(Object.entries(state.sites).sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([kind, map]) => [kind, [...map.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))]));
  }
  return counters;
}

let COUNTED = {};

async function runChild(spec) {
  const cost = globalThis.__doctorCost;
  if (!cost) throw new Error("doctor-cost: the child must run with --import doctor-cost-hooks.mjs; run the driver instead.");
  const counting = cost.mode === "count";
  const root = spec.root;
  const load = (rel) => import(pathToFileURL(join(root, "src", rel)).href);
  const inspect = await load("doctor/inspect.mjs");
  const live = await load("live-campaign-refs.mjs");
  const debt = await load("evidence-debt.mjs");
  const scope = await load("built-site-scope.mjs");
  const change = await load("change-scope.mjs");
  const record = await load("stage-record.mjs");
  const workspace = await load("campaign-workspace.mjs");
  const installMode = await load("install-mode.mjs");
  COUNTED = (await import(pathToFileURL(HOOKS).href)).COUNTED_EXPORTS;
  // Once-per-process git probe for the printed command prefix: paid before the
  // timer so it does not count against the first doctor call.
  installMode.invocationPrefixFor(root);

  const liveStub = spec.liveStub
    ? { status: "read", key_source: "stub", package_refs: Array.from({ length: 200 }, (_, i) => String(i + 1)), shipping_refs: Array.from({ length: 50 }, (_, i) => String(i + 1)) }
    : undefined;
  const readReport = (packetPath) => {
    const resolved = workspace.resolveCampaignWorkspace(packetPath, { followContextPointer: true });
    return { resolved, report: resolved.reportPath && existsSync(resolved.reportPath) ? JSON.parse(readFileSync(resolved.reportPath, "utf8")) : null };
  };
  // The packet's template family, so the parent can redact it when it is not a public one.
  let templateFamily = null;
  try {
    if (spec.packet) templateFamily = JSON.parse(readFileSync(spec.packet, "utf8"))?.assembly?.template_family ?? null;
  } catch {
    templateFamily = null;
  }
  let allowWritesUnder = null;
  let run;
  let slug = spec.slug || null;
  switch (spec.workload) {
    case "import":
      run = () => ({ status: "imported" });
      break;
    case "built":
      run = () => inspect.doctorBuiltOutput({ built: spec.built, ...(spec.slug ? { slug: spec.slug } : {}), ...(spec.family ? { family: spec.family } : {}) });
      break;
    case "packet":
      run = () => inspect.doctorPacket(spec.packet, liveStub ? { liveCampaign: liveStub } : {});
      break;
    case "ci":
      run = () => inspect.doctorCommand({ packet: spec.packet, ci: true }, { liveCampaign: live.disabledLiveRead() });
      break;
    case "debt": {
      const { resolved, report } = readReport(spec.packet);
      slug = resolved.packet?.campaign?.public_route_slug || slug;
      run = () => debt.assessEvidenceDebt({ packet: resolved.packet, packetPath: spec.packet, report });
      break;
    }
    case "signature": {
      const resolved = workspace.resolveCampaignWorkspace(spec.packet, { followContextPointer: false });
      slug = resolved.packet.campaign.public_route_slug;
      const outputRoot = resolve(resolved.targetRepo, "_site", slug);
      run = () => change.buildCommerceSignature({ scope: scope.resolveBuiltSiteScope(outputRoot), outputRoot, targetRepo: resolved.targetRepo, publicRouteSlug: slug });
      break;
    }
    case "record": {
      if (!isUnder(spec.packet, tmpdir())) throw new Error(`doctor-cost: record runs only on a scratch copy under ${tmpdir()}; got ${spec.packet}`);
      allowWritesUnder = [...new Set([dirname(spec.packet), realOrSelf(dirname(spec.packet))])];
      run = () => record.recordStageCommand({ _: ["record", spec.stage || "build"], packet: spec.packet });
      break;
    }
    default:
      throw new Error(`Unknown workload: ${spec.workload}`);
  }

  // The counted process starts from a collected heap so its peak is comparable;
  // the plain process does not force a collection, as the CLI does not.
  if (counting) globalThis.gc?.();
  const heapBaseline = process.memoryUsage().heapUsed;
  cost.begin({ allowWritesUnder });
  const start = performance.now();
  let result;
  let state;
  let wallMs;
  try {
    result = run();
    if (result && typeof result.then === "function") result = await result;
    wallMs = performance.now() - start;
  } finally {
    state = cost.end();
  }
  // What the call left reachable (its result is still held), after a full collection.
  globalThis.gc?.();
  const heapAfterGc = process.memoryUsage().heapUsed;
  slug = slug || result?.derived?.public_route_slug || result?.scope?.slug || null;

  return {
    mode: cost.mode,
    status: spec.workload === "ci" ? `${result?.status ?? "n/a"} (ci: ${result?.ci?.status ?? "n/a"})`
      : result?.status ?? result?.changes?.status ?? result?.algorithm ?? null,
    slug,
    template_family: templateFamily,
    wall_ms: round(wallMs),
    memory: {
      heap_baseline_mb: mb(heapBaseline),
      heap_peak_mb: counting ? mb(state.heapPeak) : null,
      heap_peak_delta_mb: counting ? mb(state.heapPeak - heapBaseline) : null,
      heap_after_gc_mb: mb(heapAfterGc),
      max_rss_mb: round(process.resourceUsage().maxRSS / 1024),
    },
    refused: [...new Set(state.refused)].sort(),
    refused_count: state.refused.length,
    counters: counting ? childCounters(cost, state) : null,
  };
}

// ---------------------------------------------------------------------------
// Redaction

const STRUCTURAL = new Set(["_site", "src", "_data", "assets", "css", "js", "images", "img", "fonts", ".campaign-runtime", "run-records",
  "index.html", "campaigns.json", "package.json", "config.js", "assembly-report.json", "node_modules", ".", ".."]);

// Salted per invocation, so a guessed name cannot be confirmed by hashing it;
// hashes are comparable within one result, not across results.
function hashSegment(segment, salt) {
  const ext = extname(segment);
  return `h-${createHash("sha256").update(salt).update(segment).digest("hex").slice(0, 6)}${/^\.[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : ""}`;
}

// A string that is one path from start to end (spaces included), redacted as one.
const WHOLE_PATH = /^(?:file:\/\/|\/|\.\.?\/|~\/|[A-Za-z]:[\\/])/;
// Paths inside other text: an absolute or ./-relative path after a delimiter.
const PATH_IN_TEXT = /(?<=^|[\s(=:'"])(?:file:\/\/\/?|[A-Za-z]:[\\/]|\.\.?\/|\/)[^\s|<>'"()]*/g;

export function makeRedactor({ label, roots = [], slug = null, family = null, publicFamilies = [], enabled = true, salt = randomBytes(16).toString("hex") }) {
  if (!enabled) return (value) => value;
  const forms = (path) => [...new Set([resolve(path), realOrSelf(resolve(path))])];
  // Longest root first, so a target inside the toolkit or the temp dir gets its own placeholder.
  const anchors = [
    ...roots.filter(Boolean).flatMap(forms).map((form) => ({ form, placeholder: `<${label}>`, readable: false })),
    ...forms(TOOLKIT).map((form) => ({ form, placeholder: "<toolkit>", readable: true })),
    ...forms(tmpdir()).map((form) => ({ form, placeholder: "<tmp>", readable: false })),
    ...(homedir() && homedir() !== "/" ? forms(homedir()).map((form) => ({ form, placeholder: "<home>", readable: false })) : []),
  ].sort((a, b) => b.form.length - a.form.length);
  const secret = [slug, family && !publicFamilies.includes(family) ? family : null].filter(Boolean);
  const placeholderFor = (word) => (word === slug ? "<slug>" : "<family>");
  const segments = (rest) => rest.split("/").map((segment) => {
    if (!segment) return segment;
    if (secret.includes(segment)) return placeholderFor(segment);
    return STRUCTURAL.has(segment) || /^estate-\d+$/.test(segment) ? segment : hashSegment(segment, salt);
  }).join("/");
  // The toolkit's own (public) paths stay readable; every other segment is hashed.
  // Paths are normalized first, so `<toolkit>/../elsewhere` cannot keep a name.
  const redactPath = (text) => {
    let path = text;
    if (path.startsWith("file://")) {
      try {
        path = fileURLToPath(path);
      } catch {
        return segments(path.slice("file://".length));
      }
    }
    if (/^[A-Za-z]:[\\/]/.test(path)) return segments(path.slice(2).replace(/\\/g, "/"));
    if (!path.startsWith("/")) return segments(path);
    const normal = resolve(path);
    for (const { form, placeholder, readable } of anchors) {
      if (normal === form || normal.startsWith(`${form}/`)) {
        const rest = normal.slice(form.length);
        return placeholder + (readable ? rest : segments(rest));
      }
    }
    return segments(normal);
  };
  // Placeholders already inserted (`<certified-olympus>`, say) are left alone.
  const replaceSecrets = (text) => text.split(/(<[a-z0-9-]+>)/).map((part, index) => (index % 2 ? part
    : secret.reduce((out, word) => out.split(word).join(placeholderFor(word)), part))).join("");
  const redactString = (text) => replaceSecrets(WHOLE_PATH.test(text) ? redactPath(text) : text.replace(PATH_IN_TEXT, redactPath));
  const walk = (value, key = null) => {
    if (typeof value === "string") return redactString(value);
    // Repeated-path lists hold [path, count]: the whole first element is one path.
    if (key === "top_repeated" && Array.isArray(value)) return value.map(([path, count]) => [replaceSecrets(path === "<fd>" ? path : redactPath(path)), count]);
    if (Array.isArray(value)) return value.map((inner) => walk(inner));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, inner]) => [redactString(name), walk(inner, name)]));
    return value;
  };
  return (value) => walk(value);
}

// Fail closed: every string a redacted result carries must have one of the
// shapes the harness emits. Anything else (free text, an unexpected path) stops
// the run rather than reaching a public comment.
const SAFE_SEGMENT = /^(?:h-[0-9a-f]{6}(?:\.[a-z0-9]{1,5})?|estate-\d+|<slug>|<family>)$/;
const PLACEHOLDER_PATH = /^(<[a-z0-9-]+>)(\/.*)?$/;
const SITE = /^[^\s|]+ \| (?:\(outside src\)|[\w./-]+:\d+ \S+(?: < [\w./-]+:\d+ \S+)?)$/;
const TOKEN = /^[A-Za-z0-9_.+:#<>-]*$/;
const STATUS = /^[a-z_/]+ \(ci: [a-z_/]+\)$|^[a-z0-9-]+\/v\d+$/;

export function assertRedacted(value, { roots = [], secrets = [] } = {}) {
  // A root's own directory name (a repository or brand name) is as private as its path.
  const rootForms = roots.filter(Boolean).flatMap((root) => [resolve(root), realOrSelf(resolve(root))]);
  const forbidden = [...new Set([...rootForms, ...rootForms.map((root) => basename(root)).filter((name) => name.length > 2 && !SAFE_SEGMENT.test(name)),
    TOOLKIT, realOrSelf(TOOLKIT), tmpdir(), realOrSelf(tmpdir()), ...(homedir() && homedir() !== "/" ? [homedir()] : []), ...secrets.filter(Boolean)])];
  const fits = (text) => {
    const bare = text.replace(/<[a-z0-9-]+>/g, "");
    if (forbidden.some((word) => bare.includes(word)) || /file:\/\/|[A-Za-z]:\\/.test(bare)) return false;
    if (text === "n/a" || TOKEN.test(text) || SITE.test(text) || STATUS.test(text)) return true;
    const placeholder = text.match(PLACEHOLDER_PATH);
    const rest = placeholder ? placeholder[2] ?? "" : text;
    if (placeholder?.[1] === "<toolkit>") return !/\s/.test(rest) && !rest.split("/").includes("..");
    // A hashed path: every segment is structural, hashed, an estate copy or a placeholder.
    return rest.includes("/") && rest.split("/").every((segment) => !segment || STRUCTURAL.has(segment) || SAFE_SEGMENT.test(segment));
  };
  const visit = (inner, where) => {
    if (typeof inner === "string") {
      if (!fits(inner)) throw new Error(`doctor-cost: refusing to emit ${where}: ${JSON.stringify(inner)} does not have a redacted shape (rerun with --no-redact for local use)`);
    } else if (Array.isArray(inner)) {
      inner.forEach((item, index) => visit(item, `${where}[${index}]`));
    } else if (inner && typeof inner === "object") {
      for (const [name, item] of Object.entries(inner)) {
        visit(name, `${where} key`);
        visit(item, `${where}.${name}`);
      }
    }
  };
  visit(value, "result");
  return value;
}

// ---------------------------------------------------------------------------
// Markdown

function profileText(parse) {
  const parts = Object.entries(parse.by_profile || {}).map(([profile, row]) => `${profile} ${row.calls}/${row.distinct}`);
  return parts.length ? parts.join(", ") : "-";
}

const span = (range) => (range && range[0] != null ? ` (${range[0]}–${range[1]})` : "");

function targetText(result) {
  const notes = [];
  if (result.target?.estate) notes.push(`${result.target.estate.pages} pages`);
  if (result.target?.estate?.stage === "recorded") notes.push("after record build + copy edit");
  if (result.family && result.target?.estate) notes.push(`family ${result.family}`);
  if (result.target?.live_stub) notes.push("live stub");
  return notes.length ? `${result.label} (${notes.join(", ")})` : result.label;
}

// [header, cell]; a column whose every cell is empty or zero is left out of a table.
const COLUMNS = [
  ["Target", (r) => targetText(r)],
  ["n", (r) => r.samples],
  ["Wall ms, plain (range)", (r) => (r.plain ? `${r.plain.median.wall_ms}${span(r.plain.range.wall_ms)}` : "-")],
  ["Wall ms, counted", (r) => r.median.wall_ms],
  ["maxRSS MB, plain (range)", (r) => (r.plain ? `${r.plain.median.max_rss_mb}${span(r.plain.range.max_rss_mb)}` : "-")],
  ["Heap after GC MB", (r) => (r.plain ? r.plain.median.heap_after_gc_mb : r.median.heap_after_gc_mb)],
  ["Peak heapUsed MB, counted (range)", (r) => `${r.median.heap_peak_mb}${span(r.range.heap_peak_mb)}`],
  ["Reads total/distinct", (r) => `${r.counters.reads.calls}/${r.counters.reads.distinct}`],
  ["Failed reads", (r) => r.counters.reads.failed],
  ["MB read total/distinct", (r) => `${r.counters.reads.mb_total}/${r.counters.reads.mb_distinct}`],
  ["readdir total/distinct", (r) => `${r.counters.readdir.calls}/${r.counters.readdir.distinct}`],
  ["stat+lstat / exists+access / realpath", (r) => {
    const s = r.counters.stat;
    return `${s.stat.calls + s.lstat.calls}/${s.exists.calls + s.access.calls}/${s.realpath.calls}`;
  }],
  ["parse5 total/distinct", (r) => `${r.counters.parse5.calls}/${r.counters.parse5.distinct}`],
  ["parse5 by profile (total/distinct)", (r) => profileText(r.counters.parse5)],
  ["acorn total/distinct", (r) => `${r.counters.acorn.calls}/${r.counters.acorn.distinct}`],
  ["Scope res.", (r) => r.counters.calls.resolveBuiltSiteScope ?? "n/a"],
  ["Fingerprint / debt", (r) => `${r.counters.calls.computeBuildFingerprint ?? "n/a"}/${r.counters.calls.assessEvidenceDebt ?? "n/a"}`],
  ["Signature / drift", (r) => `${r.counters.calls.buildCommerceSignature ?? "n/a"}/${r.counters.calls.classifyDrift ?? "n/a"}`],
];
const EMPTY = new Set(["", "-", "0", "0/0", "0/0/0", "0/0 (0–0)"]);

export function markdownTable(results) {
  const cells = results.map((result) => COLUMNS.map(([, cell]) => String(cell(result))));
  const keep = COLUMNS.map((_, index) => index < 2 || cells.some((row) => !EMPTY.has(row[index])));
  const line = (row) => `| ${row.filter((_, index) => keep[index]).join(" | ")} |`;
  const header = COLUMNS.map(([name]) => name);
  return [line(header), line(header.map(() => "---")), ...cells.map(line)].join("\n");
}

// One table per workload, in WORKLOADS order; --stacks results are left out
// (their counters match, but stack capture inflates their time and memory).
export function markdownTables(results) {
  return WORKLOADS.map((workload) => results.filter((result) => result.workload === workload && !result.stacks))
    .filter((group) => group.length)
    .map((group) => `**${group[0].workload}**\n\n${markdownTable(group)}`)
    .join("\n\n");
}

function markdownSummary(result) {
  const env = `${result.node} on ${result.platform}/${result.arch}, commit ${result.commit?.slice(0, 8) ?? "unknown"}${result.tree_dirty ? " (dirty)" : ""}`;
  const baseline = result.import_baseline ? `Import-only floor: maxRSS ${result.import_baseline.max_rss_mb} MB, heap ${result.import_baseline.heap_after_gc_mb} MB.` : "";
  const slowest = [...result.counters.checks].sort((a, b) => b.ms - a.ms).slice(0, 5).map((row) => `${row.id} ${row.ms} ms`).join(", ");
  return [
    `**doctor-cost ${result.workload}: ${result.label}** (${env}; status ${result.result_status ?? "n/a"}; counters stable across samples: ${result.counters_stable})`,
    "",
    markdownTable([result]),
    "",
    `Read repeats (files read N times): ${Object.entries(result.counters.reads.repeat_histogram).map(([k, v]) => `${k}×: ${v}`).join(", ")}. ${baseline}`,
    slowest ? `Slowest checks (counted process): ${slowest}.` : "",
  ].join("\n");
}

// Inclusive milliseconds per function in a V8 CPU profile, for functions in the
// measured src/ or its dependencies (node_modules) plus node:fs.
export function profileSummary(profile, { root = TOOLKIT, top = 25 } = {}) {
  const srcUrl = pathToFileURL(join(root, "src") + sep).href;
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children || []) parent.set(child, node.id);
  const keyOf = (frame) => {
    const where = frame.url.startsWith(srcUrl) ? `src/${frame.url.slice(srcUrl.length)}`
      : frame.url.includes("/node_modules/") ? `node_modules/${frame.url.split("/node_modules/").pop()}`
        : frame.url === "node:fs" || frame.url === "node:internal/fs/utils" ? frame.url : null;
    return where ? `${frame.functionName || "(anonymous)"} ${where}:${frame.lineNumber + 1}` : null;
  };
  const inclusive = new Map();
  // timeDeltas[i] is the gap before sample i, so sample i lasts until the next
  // sample (the DevTools convention); the last one lasts until endTime.
  const deltas = profile.timeDeltas || [];
  const stamps = [];
  deltas.reduce((at, delta, index) => (stamps[index] = at + delta), profile.startTime ?? 0);
  profile.samples.forEach((id, index) => {
    const end = index + 1 < stamps.length ? stamps[index + 1] : profile.endTime ?? stamps[index];
    const ms = Math.max(0, end - stamps[index]) / 1000;
    const seen = new Set();
    for (let at = id; at != null; at = parent.get(at)) {
      const key = keyOf(nodes.get(at).callFrame);
      if (key && !seen.has(key)) {
        seen.add(key);
        inclusive.set(key, (inclusive.get(key) || 0) + ms);
      }
    }
  });
  return {
    profile_ms: round((profile.endTime - profile.startTime) / 1000),
    functions: [...inclusive.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, top).map(([fn, ms]) => ({ fn, inclusive_ms: round(ms) })),
  };
}

// ---------------------------------------------------------------------------
// Parent

function spawnChild(spec, { sandbox, env, mode = "count", execArgv = [] }) {
  const resultFile = join(sandbox, `result-${process.hrtime.bigint()}.json`);
  const child = spawnSync(process.execPath, [...execArgv, "--expose-gc", "--import", pathToFileURL(HOOKS).href, fileURLToPath(import.meta.url), "--child", resultFile], {
    cwd: sandbox,
    env: { ...env, DOCTOR_COST_ROOT: spec.root, DOCTOR_COST_MODE: mode, DOCTOR_COST_STACKS: spec.stacks && mode === "count" ? "1" : "0", DOCTOR_COST_SPEC: JSON.stringify(spec) },
    encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (child.status !== 0 || !existsSync(resultFile)) {
    throw new Error(`doctor-cost child (${spec.workload}, ${mode}) failed with ${child.status ?? child.signal}:\n${child.stderr || child.stdout}`);
  }
  return JSON.parse(readFileSync(resultFile, "utf8"));
}

function stableCounters(counters) {
  const { checks, ...rest } = counters;
  return JSON.stringify({ ...rest, checks: checks.map(({ id, calls }) => ({ id, calls })) });
}

const medianOf = (runs, pick) => round(median(runs.map(pick)));
const rangeOf = (runs, pick) => {
  const values = runs.map(pick).filter((value) => value != null);
  return values.length ? [Math.min(...values), Math.max(...values)] : null;
};

export function measure(values) {
  const workload = values.workload;
  assert.ok(WORKLOADS.includes(workload), `workload must be one of ${WORKLOADS.join(", ")}`);
  const samples = Number(values.samples ?? 3);
  assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 30, "--samples must be 1..30");
  const root = resolve(values.root ?? TOOLKIT);
  const label = values.label ?? "target";
  assert.match(label, /^[a-z0-9][a-z0-9-]*$/, "--label must be lowercase letters, digits and dashes");
  const privateSources = values["private-sources"] ?? "none";
  assert.ok(["none", "inherit"].includes(privateSources), "--private-sources must be none or inherit");
  const estateCopies = values.estate == null ? null : Number(values.estate);
  const estateStage = values["estate-stage"] ?? "built";
  const plain = !values["no-plain"];
  const cpuProf = values["cpu-prof"] ? resolve(values["cpu-prof"]) : null;
  assert.ok(!cpuProf || plain, "--cpu-prof profiles the plain process; drop --no-plain");
  if (workload !== "import" && estateCopies == null) {
    if (workload === "built") assert.ok(values.built, "built needs --built <dir> (or --estate <copies>)");
    else assert.ok(values.packet, `${workload} needs --packet <file> (or --estate <copies>)`);
  }
  if (workload === "record" && estateCopies == null) {
    assert.ok(isUnder(values.packet, tmpdir()), `record runs only on a scratch copy under the OS temp dir (${tmpdir()}); refusing ${values.packet}`);
  }

  const sandbox = mkdtempSync(join(tmpdir(), "campaigns-os-doctor-cost-"));
  try {
    const extraEnv = {};
    if (privateSources === "none") {
      extraEnv.PRIVATE_TEMPLATE_SOURCES_ROOT = join(sandbox, "no-private-sources");
      mkdirSync(extraEnv.PRIVATE_TEMPLATE_SOURCES_ROOT);
    } else {
      for (const key of ["PRIVATE_TEMPLATE_SOURCES_ROOT", "PRIVATE_TEMPLATE_SOURCES_PATH"]) if (process.env[key]) extraEnv[key] = process.env[key];
    }
    const env = hermeticEnv(sandbox, extraEnv);
    const base = {
      workload, root, stacks: Boolean(values.stacks), liveStub: Boolean(values["live-stub"]), stage: values.stage,
      slug: values.slug, family: values.family,
      built: values.built ? resolve(values.built) : undefined, packet: values.packet ? resolve(values.packet) : undefined,
    };
    let estate = null;
    let estateIndex = 0;
    const freshEstate = () => makeEstate(join(sandbox, `estate-${estateIndex++}`), { copies: estateCopies, stage: estateStage, root, env });
    const specFor = (sampleEstate) => (sampleEstate
      ? { ...base, built: sampleEstate.built, slug: base.slug ?? sampleEstate.slug, packet: sampleEstate.packet }
      : base);
    if (estateCopies != null && workload !== "record") estate = freshEstate();
    if (cpuProf) mkdirSync(cpuProf, { recursive: true });

    const importBaseline = values["no-baseline"] ? null : spawnChild({ ...base, workload: "import" }, { sandbox, env, mode: plain ? "plain" : "count" }).memory;
    const runs = [];
    const plainRuns = [];
    const redactRoots = [];
    const sample = (mode) => {
      // Record writes, so every record process gets its own fresh estate.
      const sampleEstate = workload === "record" && estateCopies != null ? freshEstate() : estate;
      const spec = specFor(sampleEstate);
      const execArgv = mode === "plain" && cpuProf ? ["--cpu-prof", `--cpu-prof-dir=${cpuProf}`] : [];
      const run = spawnChild(spec, { sandbox, env, mode, execArgv });
      redactRoots.push(sampleEstate ? sampleEstate.dir : workload === "built" ? spec.built : spec.packet ? dirname(spec.packet) : null);
      if (sampleEstate) estate = estate ?? sampleEstate;
      (mode === "plain" ? plainRuns : runs).push(run);
    };
    for (let index = 0; index < samples; index += 1) {
      // Alternate the order, so neither process always runs on a warmer cache.
      const order = plain ? (index % 2 ? ["plain", "count"] : ["count", "plain"]) : ["count"];
      for (const mode of order) sample(mode);
    }
    const refused = [...runs, ...plainRuns].filter((run) => run.refused_count > 0);
    if (refused.length) {
      throw new Error(`doctor-cost: the measured call attempted refused operations (${[...new Set(refused.flatMap((run) => run.refused))].join(", ")}) `
        + `in ${refused.length} process(es), so it did not run as it does in production; the result is discarded.`);
    }
    const slug = runs[0].slug;
    const family = values.family ?? runs[0].template_family ?? null;
    const publicFamilies = existsSync(join(root, "fixtures/certified-families/_site"))
      ? readdirSync(join(root, "fixtures/certified-families/_site")).sort() : [];
    const redacting = !values["no-redact"];
    const redact = makeRedactor({ label, roots: redactRoots, slug, family, publicFamilies, enabled: redacting });
    const redactedRuns = runs.map((run) => redact(run.counters));
    const commit = git(root, ["rev-parse", "HEAD"]);
    const status = git(root, ["status", "--porcelain", "--untracked-files=no"]);
    const untracked = git(root, ["status", "--porcelain", "--untracked-files=all", "--", "src"]);
    const timing = plain ? plainRuns : runs;
    const result = {
      schema: SCHEMA,
      measured_at: new Date().toISOString(),
      node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? null,
      commit, tree_dirty: status == null ? null : status.length > 0,
      untracked_src_files: untracked == null ? null : untracked.split("\n").filter((line) => line.startsWith("??")).length,
      harness_sha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).update(readFileSync(HOOKS)).digest("hex"),
      workload, label, redacted: redacting, stacks: Boolean(values.stacks),
      target: redact({
        live_stub: Boolean(values["live-stub"]),
        private_sources: privateSources, stage: workload === "record" ? (values.stage ?? "build") : undefined,
        estate: estate ? { copies: estate.copies, pages: estate.pages, stage: estate.stage, family_copied: ESTATE_FAMILY } : null,
      }),
      // A certified (public) family name is kept; any other family and the slug are redacted.
      family: values.family == null ? null : !redacting || publicFamilies.includes(values.family) ? values.family : "<family>",
      slug: slug == null ? null : !redacting ? slug : "<slug>",
      samples,
      result_status: runs[0].status,
      // The counted process: its wall time includes the counters' own cost.
      median: {
        wall_ms: medianOf(runs, (run) => run.wall_ms),
        heap_peak_mb: medianOf(runs, (run) => run.memory.heap_peak_mb),
        heap_peak_delta_mb: medianOf(runs, (run) => run.memory.heap_peak_delta_mb),
        heap_after_gc_mb: medianOf(runs, (run) => run.memory.heap_after_gc_mb),
        max_rss_mb: medianOf(runs, (run) => run.memory.max_rss_mb),
      },
      range: {
        wall_ms: rangeOf(runs, (run) => run.wall_ms),
        heap_peak_mb: rangeOf(runs, (run) => run.memory.heap_peak_mb),
        max_rss_mb: rangeOf(runs, (run) => run.memory.max_rss_mb),
      },
      // The plain process: same call, guards only, no forced GC before it.
      plain: plain ? {
        median: {
          wall_ms: medianOf(plainRuns, (run) => run.wall_ms),
          max_rss_mb: medianOf(plainRuns, (run) => run.memory.max_rss_mb),
          heap_after_gc_mb: medianOf(plainRuns, (run) => run.memory.heap_after_gc_mb),
        },
        range: {
          wall_ms: rangeOf(plainRuns, (run) => run.wall_ms),
          max_rss_mb: rangeOf(plainRuns, (run) => run.memory.max_rss_mb),
          heap_after_gc_mb: rangeOf(plainRuns, (run) => run.memory.heap_after_gc_mb),
        },
        status_matches: plainRuns.every((run) => run.status === runs[0].status),
      } : null,
      counter_overhead_pct: plain ? round((median(runs.map((run) => run.wall_ms)) / median(timing.map((run) => run.wall_ms)) - 1) * 100) : null,
      import_baseline: importBaseline,
      counters_stable: redactedRuns.every((counters) => stableCounters(counters) === stableCounters(redactedRuns[0])),
      counters: redactedRuns[0],
      runs: runs.map((run) => ({ wall_ms: run.wall_ms, status: run.status, memory: run.memory })),
      plain_runs: plainRuns.map((run) => ({ wall_ms: run.wall_ms, status: run.status, memory: run.memory })),
    };
    // Per-check time is a median across samples too.
    result.counters.checks = result.counters.checks.map((row, index) => ({
      ...row, ms: round(median(redactedRuns.map((counters) => counters.checks[index]?.ms ?? null))),
    }));
    if (redacting) assertRedacted({ counters: result.counters, target: result.target, result_status: result.result_status }, { roots: redactRoots, secrets: [slug, family && !publicFamilies.includes(family) ? family : null] });
    return result;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// CLI

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  if (values.child) {
    const spec = JSON.parse(process.env.DOCTOR_COST_SPEC);
    const out = await runChild(spec);
    writeFileSync(values.child, JSON.stringify(out));
    return;
  }
  const [command, ...rest] = positionals;
  if (command === "summarize") {
    assert.ok(rest.length > 0, "summarize needs one or more saved result files");
    const results = rest.map((file) => JSON.parse(readFileSync(file, "utf8")));
    for (const result of results) assert.equal(result.schema, SCHEMA, "summarize reads doctor-cost results only");
    const skipped = results.filter((result) => result.stacks).length;
    if (skipped) console.error(`summarize: left out ${skipped} --stacks result(s)`);
    console.log(markdownTables(results));
    return;
  }
  if (command === "summarize-profile") {
    assert.equal(rest.length, 1, "summarize-profile needs one .cpuprofile file");
    console.log(JSON.stringify(profileSummary(JSON.parse(readFileSync(rest[0], "utf8")), { root: resolve(values.root ?? TOOLKIT), top: Number(values.top ?? 25) }), null, 2));
    return;
  }
  if (command === "make-estate") {
    assert.ok(values.out, "make-estate needs --out <dir>");
    const estate = makeEstate(resolve(values.out), { copies: Number(values.copies ?? 1), stage: values["estate-stage"] ?? "built" });
    console.log(JSON.stringify(estate, null, 2));
    return;
  }
  if (!command) {
    console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\nimport ")[0].replace(/^#!.*\n/, "").replace(/^\/\/ ?/gm, ""));
    process.exitCode = 2;
    return;
  }
  const result = measure({ ...values, workload: command });
  if (values.out) {
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(resolve(values.out), `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(values.markdown ? markdownSummary(result) : JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
