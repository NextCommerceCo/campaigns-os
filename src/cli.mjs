import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runQaCli } from "./qa-node.mjs";
import {
  appendFinding,
  buildFinding,
  exportJson as exportFindingsJson,
  exportSummaryMarkdown,
  FINDING_KINDS,
  FINDING_STAGES,
  readJournal,
  resolveJournalPath,
  WORKFLOW_FINDING_SCHEMA,
} from "./findings.mjs";
import {
  assembleRunRecord,
  mintRunId,
  validateRunRecordLifecycle,
  writeRunRecord,
} from "./run-record.mjs";
import {
  promptAndPersistConsent,
  readConfig,
  resolveConfigPath,
  resolveConsent,
  TELEMETRY_ENV_VAR,
  writeConsentConfig,
} from "./consent.mjs";
import {
  createAdapterDecisions,
  validateAdapterDecisionGates,
  validateAdapterDecisionShape,
  validateAdapterSourceFiles,
} from "./adapter-decision-contract.mjs";
import {
  createDoctorCheckRegistry,
  runDoctorCheckRegistry,
} from "./doctor-check-registry.mjs";
import { remitRunRecord } from "./remit.mjs";
import {
  aggregateLifecycleForRun,
  appendLifecycleEntry,
  LIFECYCLE_JOURNAL_REL_PATH,
  NOOP_RECORDER,
  readLifecycleJournal,
  withCommandLifecycle,
} from "./lifecycle.mjs";
import {
  buildRunSession,
  clearRunSession,
  findRunSession,
  mintSessionRunId,
  writeRunSession,
} from "./run-session.mjs";
import {
  createSourceHtmlIntake,
  normalizePageKitRoute,
  publicRouteForPage,
} from "./source-html-intake.mjs";
import {
  readSourceHtmlManifestFile,
  SOURCE_HTML_MANIFEST_SCHEMA,
} from "./source-html-manifest.mjs";
import {
  inspectBrandTheme,
  validateAssemblyReportThemeBlock,
  validateThemeContextBlock,
  writeThemeArtifacts,
} from "./brand-theme.mjs";
import {
  ASSEMBLY_REPORT_STAGE_KEYS,
  NEXT_STAGE_ORDER,
  reportKeyForCliStage,
} from "./orchestration-stage-contract.mjs";
// ADR-003: the public, canonical CampaignSpec rule registry. The doctor and any
// campaign authoring UI (e.g. a Map Builder bundle) import the same rules, so a
// spec check is authored once and reaches internal teams and agencies alike.
// Authored as pure TypeScript with no heavy deps; compiled to plain ESM by
// `npm run build:spec` (tsc -> campaign-spec/dist) so the package runs on the
// node engine in package.json without type-stripping. build runs on `prepare`,
// so a fresh install (including the git-ref consumer) always has dist.
import {
  normalize as normalizeCampaignSpec,
  runRules,
  specOnlyRules,
} from "../campaign-spec/dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKET_SCHEMA = "campaign-runtime-build-packet/v0";
const CONTEXT_SCHEMA = "campaign-runtime-build-context/v0";
const REPORT_SCHEMA = "campaign-runtime-assembly-report/v0";
const PROOF_POLICY_REQUIRED_FIELDS = Object.freeze([
  "browser_qa_required",
  "typed_card_depth",
  "localhost_development_domain_allowed",
  "non_localhost_origin_allowlist_required",
  "order_path_depth",
  "operator_approval_state",
]);

// Default proxy base for `--map-id` spec retrieval. The Map Builder
// (campaign-map.nextcommerce.com) is fronted by a backend service that
// exposes `/api/spec/<map-id>` returning the canonical saved CampaignSpec.
// Override via `--proxy-base` for staging environments or a local backend.
const DEFAULT_PROXY_BASE = "https://campaign-map.nextcommerce.com";

const KNOWN_TEMPLATE_FAMILIES = new Set([
  "undecided",
  "olympus",
  "limos",
  "demeter",
  "olympus-mv-single-step",
  "olympus-mv-two-step",
  "shop-single-step",
  "shop-three-step",
  "custom",
]);

const KNOWN_DEPLOY_TARGETS = new Set([
  "netlify",
  "cloudflare-pages",
  "vercel",
  "shopify-proxy",
  "agency-ci",
  "unknown",
]);

const REQUIRED_STORE_PROFILE_FIELDS = [
  "store_url",
];

const US_MARKET_COPY_PATTERNS = [
  { label: "USPS", regex: /\bUSPS\b/i },
  { label: "ships from the USA", regex: /\bships?\s+from\s+(?:the\s+)?(?:USA|U\.S\.A\.|US|U\.S\.|United States)\b/i },
  { label: "US warehouse", regex: /\b(?:US|U\.S\.|USA|United States)\s+warehouse\b/i },
  { label: "contiguous US", regex: /\bcontiguous\s+(?:US|U\.S\.|USA|United States)\b/i },
  { label: "US-only shipping", regex: /\b(?:US|U\.S\.|USA|United States)(?:-|\s+)?only\b/i },
  { label: "All US orders ship free", regex: /\bAll\s+(?:US|U\.S\.|USA|United States)\s+orders\s+ship\s+free\b/i },
  { label: "Made in USA", regex: /\bMade\s+in\s+(?:the\s+)?(?:USA|U\.S\.A\.|US|U\.S\.|United States)\b/i },
  { label: "manufactured in the USA", regex: /\bmanufactur(?:ed|ing)\s+in\s+(?:the\s+)?(?:USA|U\.S\.A\.|US|U\.S\.|United States)\b/i },
];

const HARDCODED_CURRENCY_REGEX = /\$\s?\d[\d,]*(?:\.\d+)?(?:\/[A-Za-z]+)?/g;
const HARDCODED_PHONE_REGEX = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

const SDK_ROUTING_META_TAGS = [
  "next-success-url",
  "next-upsell-accept-url",
  "next-upsell-decline-url",
];

const HELP = `Campaigns OS toolkit

Usage:
  campaigns-os help
  campaigns-os start (--spec <json> | --map-id <id>) --source <html-dir> --target <page-kit-dir> --template-family <family>
                     [--proxy-base <url>] [--cached-spec] [--theme-policy <inspect_only|auto|off>]
  campaigns-os prepare-build (--spec <json> | --map-id <id>) --source <html-dir> --target <page-kit-dir> --template-family <family>
                             [--proxy-base <url>] [--cached-spec] [--theme-policy <inspect_only|auto|off>]
  campaigns-os doctor --packet <campaign-runtime.build.json> [--context <json>] [--report <json>] [--strip-paths] [--json]
  campaigns-os theme inspect --packet <campaign-runtime.build.json> [--context <json>] [--theme-policy <inspect_only|auto|off>] [--json]
  campaigns-os theme generate --packet <campaign-runtime.build.json> [--context <json>] [--out-dir <dir>] [--force] [--json]
  campaigns-os validate-assembly-report --report <json> [--json]
  campaigns-os install-skills [--platform <claude|codex|agents|all>] [--target <skills-dir>] [--dry-run] [--json]
  campaigns-os install-agent-context --target <page-kit-dir> [--dry-run]
  campaigns-os next --packet <json> [--json]                       # self-decide next stage from report state
  campaigns-os next setup --packet <json> [--context <json>] [--report <json>] [--json]
  campaigns-os next build --packet <json> [--context <json>] [--report <json>] [--json]
  campaigns-os next polish --packet <json> --report <json> [--json]
  campaigns-os next deploy --packet <json> --report <json> [--json]
  campaigns-os next qa --packet <json> --report <json> [--json]
  campaigns-os qa resolve --packet <json> [--base-url <url>] [--json]
  campaigns-os qa run --packet <json> [--base-url <url>] [--browser] [--test-order <mode>] [--no-post-verdict] [--output-dir qa-output] [--json]
  campaigns-os qa policy set --packet <json> [--test-orders-allowed true|false] [--sandbox-test-card-confirmed true|false] [--allowed-domains-confirmed true|false] [--json]
  campaigns-os findings add --stage <stage> --kind <kind> --summary <text> [--details <text>] [--packet <json>] [--journal <path>] [--run-id <id>] [...context flags]
  campaigns-os findings harvest --packet <json> [--context <json>] [--report <json>] [--journal <path>] [--run-id <id>] [--write] [--json]
  campaigns-os findings list [--packet <json>] [--journal <path>] [--json]
  campaigns-os findings export [--summary | --json] [--packet <json>] [--journal <path>]
  campaigns-os run-record --packet <json> [--context <json>] [--report <json>] [--qa-verdict <path>] [--run-id <id>] [--journal <path>] [--lifecycle-journal <path>] [--surfaces <a,b>] [--primary-surface <s>] [--surface-confidence <text>] [--agent-total-tokens <n>] [--agent-elapsed-ms <n>] [--proxy-base <url>] [--no-remit] [--no-write] [--json]

  Any command accepts [--lifecycle-journal <path>] (or env CAMPAIGNS_OS_LIFECYCLE_LOG) to append a command-lifecycle entry (command, argv shape, exit status, timing) for the run; pair with --run-id so run-record can embed it.
  campaigns-os telemetry status|on|off [--json]                    # machine-level Run Telemetry consent (gates remit only; capture is always local)
  campaigns-os run start [--packet <json>] [--run-id <id>] [--lifecycle-journal <path>] [--force] [--json]   # begin an ambient run session: one run_id + journal auto-shared by every command, no per-command flags
  campaigns-os run status [--json]                                 # show the active run session, if any
  campaigns-os run end [--packet <json>] [--no-remit] [--no-write] [--json]   # assemble the aggregated Run Record for the session, then clear it

Examples:
  npm run campaigns-os -- start \\
    --spec examples/campaignspec.v42.basic.json \\
    --source examples/source-html \\
    --target examples/target-page-kit \\
    --template-family olympus

  # Fetch the spec straight from the Map Builder by Map ID (KV is source of truth):
  npm run campaigns-os -- start \\
    --map-id veyra-v1-knp4 \\
    --source examples/source-html \\
    --target examples/target-page-kit \\
    --template-family olympus

  npm run campaigns-os -- doctor --packet examples/build-packet.basic.json --json

  npm run campaigns-os -- theme inspect --packet examples/build-packet.basic.json --json
`;

export async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0] || "help";

  // Ambient run session (Tier 3): when `run start` is active, every command
  // shares its run_id WITHOUT --run-id. Explicit --run-id still wins. Resolved
  // ONCE here and threaded through dispatch + persistence so the run_id a
  // command is tagged with and the journal it writes to come from a single
  // read (no TOCTOU skew if the session changes mid-run).
  const ambient = ambientRunSession();

  // Wrap every command in the lifecycle instrumentation (T6): it captures the
  // command, its argv shape, exit status, and timing. Re-throws unchanged so
  // the CLI exit code is unaffected. Persistence runs via onFinish so it fires
  // on BOTH the success and error paths — a command that THROWS (the most
  // valuable failure telemetry) is recorded too, not just clean exits.
  // Persistence is OPT-IN — an explicit --lifecycle-journal /
  // CAMPAIGNS_OS_LIFECYCLE_LOG, or an active run session. With none, behavior
  // is identical to before.
  await withCommandLifecycle(
    {
      command,
      argvShape: argvShape(args),
      runId: optionalString(args["run-id"]) || ambient?.session?.run_id || null,
      onFinish: (lifecycle) => persistLifecycleIfRequested(args, command, lifecycle, ambient),
    },
    (recorder) => dispatch(command, args, recorder, ambient),
  );
}

function ambientRunSession() {
  try {
    return findRunSession(process.cwd());
  } catch {
    return null;
  }
}

// The lifecycle journal a command writes to: explicit flag > env > active run
// session's journal > fallback. Read and write resolve identically, so the
// journal a command WRITES is the journal run-record READS. `ambient` is the
// session resolved once in main(); `fallbackDir` is used only by run-record's
// read path (its baseDir default); persistence passes none, so with no
// flag/env/session nothing is written (default behavior).
function resolveLifecycleJournal(args, { ambient = null, fallbackDir = null } = {}) {
  if (isNonEmptyString(args["lifecycle-journal"])) return resolve(args["lifecycle-journal"]);
  if (isNonEmptyString(process.env.CAMPAIGNS_OS_LIFECYCLE_LOG)) return resolve(process.env.CAMPAIGNS_OS_LIFECYCLE_LOG);
  if (ambient && isNonEmptyString(ambient.session.lifecycle_journal)) return resolve(ambient.session.lifecycle_journal);
  return fallbackDir ? join(resolve(fallbackDir), LIFECYCLE_JOURNAL_REL_PATH) : null;
}

// Append the command's lifecycle entry only when capture is active: an explicit
// flag/env, or an ambient run session. Never throws — a lifecycle write must
// not break a command (telemetry never blocks a build). `help` is a no-op
// command and is not worth recording.
function persistLifecycleIfRequested(args, command, lifecycle, ambient) {
  if (command === "help") return;
  const journalPath = resolveLifecycleJournal(args, { ambient });
  if (!journalPath) return;
  try {
    appendLifecycleEntry(journalPath, lifecycle);
  } catch (error) {
    // Non-fatal, but leave a one-line breadcrumb on stderr so a capture failure
    // is observable rather than fully silent. stderr never pollutes --json stdout.
    process.stderr.write(`[campaigns-os] lifecycle capture skipped: ${error.message}\n`);
  }
}

async function dispatch(command, args, recorder = NOOP_RECORDER, ambient = null) {
  if (command === "help" || (args.help && command !== "qa")) {
    console.log(HELP);
    return;
  }

  if (command === "start") {
    // Tier 2: mark sub-phases so the lifecycle journal entry carries per-phase
    // timings (spec resolve vs the prepare+doctor+install build), which Tier 1
    // aggregates into `start:resolve-spec` / `start:prepare-build` stages.
    const resolved = await recorder.time("resolve-spec", () => resolveSpecPath(args));
    args.spec = resolved.specPath;
    const result = await recorder.time("prepare-build", () => prepareBuild(args, { runDoctor: true, installContext: true }));
    result.spec_source = resolved;
    printPrepareResult(result, args);
    return;
  }

  if (command === "prepare-build") {
    const resolved = await recorder.time("resolve-spec", () => resolveSpecPath(args));
    args.spec = resolved.specPath;
    const result = await recorder.time("prepare-build", () => prepareBuild(args, { runDoctor: false, installContext: false }));
    result.spec_source = resolved;
    printPrepareResult(result, args);
    return;
  }

  if (command === "doctor" || command === "validate-build-packet") {
    const result = doctorCommand(args);
    writeResult(result, args, result.ok ? 0 : 2);
    printDoctorTinyPrompt(result, args);
    return;
  }

  if (command === "theme") {
    const result = themeCommand(args);
    writeResult(result, args, result.ok ? 0 : 2);
    return;
  }

  if (command === "validate-assembly-report") {
    const reportPath = requireArg(args, "report");
    const result = validateAssemblyReport(readJson(resolve(reportPath)));
    writeResult(result, args, result.ok ? 0 : 2);
    return;
  }

  if (command === "install-agent-context") {
    const target = requireArg(args, "target");
    const result = installAgentContext(resolve(target), Boolean(args["dry-run"]));
    writeResult(result, args, 0);
    return;
  }

  if (command === "install-skills") {
    if (args.target === true) throw new Error("Missing value for --target");
    if (args.platform === true) throw new Error("Missing value for --platform");
    const result = installSkills(args.target, Boolean(args["dry-run"]), args.platform);
    writeResult(result, args, 0);
    return;
  }

  if (command === "next") {
    // Slice 3 Phase 2: `campaigns-os next` (no stage) self-decides the next
    // stage from the current report + doctor state. Existing form with an
    // explicit stage (`next build`, `next polish`, etc.) is unchanged.
    const stage = args._[1] || null;
    const result = nextStage(stage, args);
    writeResult(result, args, result.ok ? 0 : 2);
    printNextTinyPrompt(result, args);
    return;
  }

  if (command === "qa") {
    await runQaCli(args);
    return;
  }

  if (command === "findings") {
    await findingsCommand(args, ambient);
    return;
  }

  if (command === "run-record") {
    await runRecordCommand(args, ambient);
    return;
  }

  if (command === "telemetry") {
    telemetryCommand(args);
    return;
  }

  if (command === "run") {
    await runSessionCommand(args, ambient);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function requireArg(args, key) {
  const value = args[key];
  if (!isNonEmptyString(value)) throw new Error(`Missing required --${key}`);
  return value;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value, fallback = null) {
  return isNonEmptyString(value) ? value.trim() : fallback;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim();
  }
  return null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonIfExists(path) {
  return path && existsSync(path) ? readJson(path) : null;
}

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Fetch a CampaignSpec by Map ID from the proxy Worker.
 *
 * The Map Builder portal at campaign-map.nextcommerce.com is fronted by
 * a backend service that persists saved specs and exposes them via
 * GET /api/spec/<map-id>. Response shape is
 * { ok: true, data: <spec> } or { ok: false, error: <message> } on a
 * 200 with a logical failure.
 *
 * `fetchImpl` is parameterized for tests so a local mock server can
 * stand in for the deployed Worker.
 *
 * @param {string} mapId — saved Map Builder identity (e.g. "veyra-v1-knp4")
 * @param {object} [opts]
 * @param {string} [opts.proxyBase] — proxy origin without trailing slash
 * @param {Function} [opts.fetchImpl] — fetch shim for testing
 * @returns {Promise<object>} parsed CampaignSpec
 */
async function fetchSpecByMapId(mapId, opts = {}) {
  const trimmed = String(mapId || "").trim();
  if (!trimmed) throw new Error("fetchSpecByMapId: mapId is required.");
  const base = (opts.proxyBase || DEFAULT_PROXY_BASE).replace(/\/+$/, "");
  const url = `${base}/api/spec/${encodeURIComponent(trimmed)}`;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is not available. Upgrade to Node 18+ or pass fetchImpl.");
  }
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  } catch (error) {
    throw new Error(`Spec fetch network error: ${error.message} (${url})`);
  }
  if (!res.ok) {
    throw new Error(`Spec fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  let body;
  try {
    body = await res.json();
  } catch (error) {
    throw new Error(`Spec fetch returned invalid JSON: ${error.message} (${url})`);
  }
  if (!body || body.ok === false || body.data == null) {
    throw new Error(`Spec fetch returned ok=false: ${body?.error || "unknown error"} (${url})`);
  }
  return body.data;
}

/**
 * Sanitize a Map ID for use as a cache filename. Map IDs are normally
 * already filesystem-safe slugs (e.g. "veyra-v1-knp4"), but defend
 * against unexpected characters so a malformed ID can't escape the
 * cache directory.
 */
function sanitizeMapIdForFilename(mapId) {
  return String(mapId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || "unnamed";
}

/**
 * Resolve `--spec` / `--map-id` into a local file path that downstream
 * sync code (prepareBuild, doctor, etc.) can read like any other spec.
 *
 * Resolution order:
 *   --spec <path>        -> use that local file directly
 *   --map-id <id>        -> fetch from proxy, cache to disk, return cache path
 *   (neither set)        -> error
 *
 * When fetched, the spec is cached at
 *   <targetRepo>/.campaign-runtime/fetched-specs/<sanitized-id>.json
 * so subsequent stages have a stable on-disk path AND so the fetch is
 * inspectable for debugging. KV is the source of truth, so re-runs
 * always re-fetch by default; pass `--cached-spec` to reuse the cache
 * without hitting the network (useful for offline iteration).
 *
 * Returns `{ specPath, source, mapId?, proxyBase? }`. `source` is one
 * of "local" | "remote" | "cache".
 */
async function resolveSpecPath(args, opts = {}) {
  if (args.spec) {
    const specPath = resolve(args.spec);
    if (!existsSync(specPath)) throw new Error(`CampaignSpec does not exist: ${specPath}`);
    return { specPath, source: "local" };
  }
  if (args["map-id"]) {
    const mapId = String(args["map-id"]).trim();
    const targetRepo = opts.targetRepo || (args.target ? resolve(args.target) : null);
    if (!targetRepo) {
      throw new Error("--map-id requires --target (so the fetched spec can be cached under <target>/.campaign-runtime/).");
    }
    const proxyBase = optionalString(args["proxy-base"], DEFAULT_PROXY_BASE);
    const cacheDir = join(targetRepo, ".campaign-runtime", "fetched-specs");
    const cachePath = join(cacheDir, `${sanitizeMapIdForFilename(mapId)}.json`);
    if (args["cached-spec"]) {
      if (!existsSync(cachePath)) {
        throw new Error(`--cached-spec set but no cached spec found at ${cachePath}. Run without --cached-spec to fetch.`);
      }
      return { specPath: cachePath, source: "cache", mapId, proxyBase };
    }
    const spec = await fetchSpecByMapId(mapId, { proxyBase, fetchImpl: opts.fetchImpl });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(spec, null, 2)}\n`);
    return { specPath: cachePath, source: "remote", mapId, proxyBase };
  }
  throw new Error("Either --spec <path> or --map-id <id> is required.");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function relFromFile(filePath, targetPath) {
  const fromDir = dirname(resolve(filePath));
  const rel = relative(fromDir, resolve(targetPath));
  if (!rel) return ".";
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function relFromDir(dirPath, targetPath) {
  const rel = relative(resolve(dirPath), resolve(targetPath));
  if (!rel) return ".";
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function isLocalAbsolutePath(value) {
  return isNonEmptyString(value) && !isAbsoluteHttpUrl(value) && isAbsolute(value);
}

function relativizeDoctorOutput(result, baseDir) {
  const replacements = new Map();
  for (const value of Object.values(result.derived || {})) {
    if (isLocalAbsolutePath(value)) {
      replacements.set(value, relFromDir(baseDir, value));
    }
  }
  const sortedReplacements = [...replacements.entries()].sort((a, b) => b[0].length - a[0].length);

  function visit(value) {
    if (Array.isArray(value)) return value.map(visit);
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, visit(entryValue)]));
    }
    if (typeof value !== "string") return value;
    if (isLocalAbsolutePath(value)) return relFromDir(baseDir, value);
    let nextValue = value;
    for (const [absolutePath, relativePath] of sortedReplacements) {
      nextValue = nextValue.split(absolutePath).join(relativePath);
    }
    return nextValue;
  }

  return visit(result);
}

function resolveFromFile(filePath, targetPath) {
  if (!isNonEmptyString(targetPath)) return null;
  if (isAbsoluteHttpUrl(targetPath)) return targetPath;
  return resolve(dirname(resolve(filePath)), targetPath);
}

function normalizeFunnels(spec) {
  if (Array.isArray(spec?.funnels)) return spec.funnels;
  if (Array.isArray(spec?.funnel_pages)) {
    return [{ id: "default", weight: 100, pages: spec.funnel_pages }];
  }
  return [];
}

function activeSpecPages(spec) {
  const pages = [];
  for (const funnel of normalizeFunnels(spec)) {
    for (const page of Array.isArray(funnel.pages) ? funnel.pages : []) {
      if (page && page.enabled !== false && isNonEmptyString(page.id)) {
        pages.push({ ...page, funnel_id: funnel.id || "default" });
      }
    }
  }
  return pages;
}

function isAbsoluteHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function hasHtmlExtensionRoute(value) {
  if (!isNonEmptyString(value)) return false;
  const raw = value.trim();
  try {
    const url = new URL(raw);
    return /\.html$/i.test(url.pathname);
  } catch {
    return /\.html$/i.test(raw.replace(/[?#].*$/, ""));
  }
}

function collectHtmlFiles(root) {
  const files = [];
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) return files;

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".html") {
        files.push({
          path: relative(resolvedRoot, fullPath),
          name: entry.name,
          basename: basename(entry.name, ".html"),
          bytes: statSync(fullPath).size,
          sha256: sha256File(fullPath),
        });
      }
    }
  }

  walk(resolvedRoot);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function campaignIdentity(spec, args) {
  const mapId = optionalString(args["map-id"])
    || optionalString(spec.spec_identity?.map_id)
    || optionalString(spec.map_id);
  const publicRouteSlug = optionalString(args["public-route-slug"])
    || optionalString(spec.spec_identity?.public_route_slug)
    || optionalString(spec.campaign?.slug)
    || optionalString(spec.campaign?.id);
  return { mapId, publicRouteSlug };
}

function preferredTemplateFamily(spec) {
  return optionalString(spec?.spec_identity?.preferred_template_family)
    || optionalString(spec?.campaign?.preferred_template_family)
    || optionalString(spec?.preferred_template_family)
    || null;
}

function createStage(stage, status, extras = {}) {
  return {
    stage,
    status,
    inputs: [],
    outputs: [],
    commands: [],
    blockers: [],
    warnings: [],
    ...extras,
  };
}

/**
 * Create the assembly-report stage ledger emitted by prepare-build.
 *
 * Every declared stage starts pending. `prepare_build` is immediately marked
 * completed or blocked from the source/spec readiness result, while `setup` is
 * pending only when starter scaffold adoption is required and skipped otherwise.
 */
function createInitialAssemblyReportStages({ scaffoldRequired, blockers, outputs }) {
  const stages = Object.fromEntries(
    ASSEMBLY_REPORT_STAGE_KEYS.map((stage) => [stage, createStage(stage, "pending")])
  );
  stages.prepare_build = createStage("prepare_build", blockers.length ? "blocked" : "completed", {
    outputs,
    blockers,
  });
  stages.setup = createStage("setup", scaffoldRequired ? "pending" : "skipped");
  return stages;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createProofPolicy() {
  return {
    browser_qa_required: true,
    typed_card_depth: "common",
    localhost_development_domain_allowed: true,
    non_localhost_origin_allowlist_required: true,
    order_path_depth: "common",
    operator_approval_state: "not_required_global_test_cards",
    qa_portal_publish_default: true,
  };
}

function prepareBuild(args, options = {}) {
  const specPath = resolve(requireArg(args, "spec"));
  const sourceRoot = resolve(requireArg(args, "source"));
  const targetRepo = resolve(requireArg(args, "target"));
  if (!existsSync(specPath)) throw new Error(`CampaignSpec does not exist: ${specPath}`);
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) throw new Error(`Source root is not a directory: ${sourceRoot}`);
  if (!existsSync(targetRepo) || !statSync(targetRepo).isDirectory()) throw new Error(`Target repo is not a directory: ${targetRepo}`);

  const packetPath = resolve(args.out || join(targetRepo, "campaign-runtime.build.json"));
  const contextPath = resolve(args["context-out"] || join(targetRepo, ".campaign-runtime/build-context.json"));
  const reportPath = resolve(args["report-out"] || join(targetRepo, ".campaign-runtime/assembly-report.json"));
  const doctorOutPath = resolve(args["doctor-out"] || join(targetRepo, ".campaign-runtime/doctor-output.json"));
  const spec = readJson(specPath);
  const { mapId, publicRouteSlug } = campaignIdentity(spec, args);
  if (!mapId) throw new Error("CampaignSpec has no map ID. Re-export a saved Map Builder spec with spec_identity.map_id before assembly; use --map-id only for legacy diagnostics.");
  if (!publicRouteSlug) throw new Error("CampaignSpec has no public route slug. Re-export a saved Map Builder spec with spec_identity.public_route_slug or set campaign.slug.");

  const sourceKind = optionalString(args["source-kind"], "html_funnel");
  if (sourceKind !== "html_funnel") {
    throw new Error(`Unsupported source adapter "${sourceKind}". Use html_funnel for the current prepared-HTML flow.`);
  }

  const activePages = activeSpecPages(spec);
  const htmlFiles = collectHtmlFiles(sourceRoot);
  const explicitTemplateFamily = optionalString(args["template-family"]);
  const hintedTemplateFamily = preferredTemplateFamily(spec);
  const templateFamily = explicitTemplateFamily || hintedTemplateFamily || "undecided";
  const templateLocked = Boolean(explicitTemplateFamily) && templateFamily !== "undecided" && templateFamily !== "auto";
  const templateCandidates = hintedTemplateFamily
    ? [{ family: hintedTemplateFamily, source: "CampaignSpec preferred_template_family", confidence: "hint" }]
    : [];
  const outputDir = optionalString(args["output-dir"], `src/${publicRouteSlug}`);
  const sourceIntake = createSourceHtmlIntake({
    sourceRoot,
    specPages: activePages,
    htmlFiles,
    publicRouteSlug,
    outputDir,
  });
  const manifestResult = sourceIntake.manifestResult;
  const manifestWarnings = sourceIntake.manifestWarnings;
  const matched = {
    mappings: sourceIntake.mappings,
    prompts: sourceIntake.prompts,
    decisions: sourceIntake.decisions,
  };
  if (manifestResult.warning) {
    console.warn(`[campaigns-os prepare-build] ${manifestResult.warning}`);
  }
  const liveUrlPath = optionalString(args["live-url-path"], `/${publicRouteSlug}/`);
  const commerceCatalog = optionalString(args["commerce-catalog"], join(ROOT, "contracts/commerce-surface-catalog.json"));
  const themePolicy = optionalString(args["theme-policy"], "inspect_only");
  const blockers = matched.prompts.map((prompt) => ({ code: prompt.code, stage: prompt.stage, message: prompt.message }));
  const portable = (path) => relFromDir(targetRepo, path);
  const commerceZoneFindings = inspectCommerceZones(sourceRoot, htmlFiles);
  const adapterDecisions = createAdapterDecisions({ commerceZoneFindings });
  const proofPolicy = createProofPolicy();

  const packet = {
    schema_version: PACKET_SCHEMA,
    campaign: {
      public_route_slug: publicRouteSlug,
      campaign_directory: optionalString(args["campaign-directory"], basename(outputDir)),
      live_url_path: liveUrlPath,
      campaigns_app_url: optionalString(args["campaigns-app-url"]),
      api_key_source: optionalString(args["api-key-source"], "env:CAMPAIGNS_API_KEY"),
      allowed_domains_confirmed: args["allowed-domains-confirmed"] === true,
    },
    spec: {
      map_id: mapId,
      spec_url: spec.spec_identity?.spec_url || null,
      local_path: relFromFile(packetPath, specPath),
    },
    source_html: {
      root: relFromFile(packetPath, sourceRoot),
      pages: matched.mappings,
      adapter_contract: cloneJson(adapterDecisions),
    },
    assembly: {
      implementation: "next-campaigns-build",
      target_repo: relFromFile(packetPath, targetRepo),
      output_dir: outputDir,
      template_family: templateFamily === "auto" ? "undecided" : templateFamily,
      template_decision_notes: templateLocked
        ? `Template family locked by prepare-build --template-family ${templateFamily}.`
        : hintedTemplateFamily
          ? `CampaignSpec hints ${hintedTemplateFamily}; operator must still lock the template family before commerce wiring.`
          : "Template family must be locked before commerce wiring.",
      template_lock: {
        locked: templateLocked,
        locked_by: templateLocked ? "operator_flag" : null,
        confidence: templateLocked ? "high" : "none",
        evidence: templateLocked ? ["prepare-build --template-family"] : [],
      },
      commerce_catalog: {
        required: true,
        family: templateLocked ? templateFamily : null,
        version: null,
        path: relFromFile(packetPath, commerceCatalog),
      },
      compatible_outputs: ["static-html", "campaign-cart-sdk"],
    },
    deploy: {
      target: optionalString(args["deploy-target"], "unknown"),
      preview_url: optionalString(args["preview-url"]),
      production_url: optionalString(args["production-url"]),
      live_url_path: liveUrlPath,
    },
    qa: {
      test_orders_allowed: args["test-orders-allowed"] === true,
      sandbox_test_card_confirmed: args["sandbox-test-card-confirmed"] === true,
      proof_policy: proofPolicy,
      test_order_policy_notes: "Test Orders use global test cards that bypass the gateway and create no transactions. Run them any time with `qa run --test-order common` (3-5 shape sample) or `--test-order full` (every permutation). Localhost on any port is a globally allowed Development domain; non-localhost preview/production origins still need SDK origin allowlist confirmation. These flags are informational, not a permission gate.",
    },
    notes: "Generated by campaigns-os prepare-build. Replace demo refs from CampaignSpec/API before launch.",
  };

  const context = {
    schema_version: CONTEXT_SCHEMA,
    generated_at: new Date().toISOString(),
    source_adapter: sourceKind,
    status: blockers.length ? "blocked" : "prepared",
    packet_path: portable(packetPath),
    report_path: portable(reportPath),
    spec: {
      path: portable(specPath),
      hash: sha256File(specPath),
      active_pages: activePages.map((page) => ({
        id: page.id,
        type: page.type || null,
        label: page.label || null,
        page_url: publicRouteForPage(page),
      })),
    },
    source: {
      root: portable(sourceRoot),
      html_files: htmlFiles,
      manifest: manifestResult.manifest
        ? {
            path: portable(manifestResult.path),
            schema_version: manifestResult.manifest.schema_version,
            generator: manifestResult.manifest.generator || null,
            generated_at: manifestResult.manifest.generated_at || null,
            campaign_slug: manifestResult.manifest.campaign_slug || null,
            page_count: Array.isArray(manifestResult.manifest.pages) ? manifestResult.manifest.pages.length : 0,
          }
        : null,
      manifest_warnings: manifestWarnings,
    },
    page_map: matched.mappings.map((mapping) => ({
      page_id: mapping.page_id,
      source_path: mapping.path || null,
      skip_reason: mapping.skip_reason || null,
      output_path: mapping.page_kit?.output_path ? portable(resolve(targetRepo, mapping.page_kit.output_path)) : null,
      page_kit: mapping.page_kit || null,
    })),
    scaffold: {
      mode: existsSync(resolve(targetRepo, outputDir)) ? "existing" : "fresh",
      required: !existsSync(resolve(targetRepo, outputDir)),
      target_repo: ".",
      output_dir: portable(resolve(targetRepo, outputDir)),
      handoff_skill: existsSync(resolve(targetRepo, outputDir)) ? "next-campaigns-build" : "next-campaigns-setup",
      handoff_artifact: ".campaign-runtime/setup-handoff.json",
      reason: existsSync(resolve(targetRepo, outputDir))
        ? "Target campaign output directory already exists."
        : "Target campaign output directory is missing; scaffold before build.",
    },
    template: {
      family: packet.assembly.template_family,
      locked: templateLocked,
      lock: packet.assembly.template_lock,
      candidates: templateCandidates,
    },
    adapter_decisions: cloneJson(adapterDecisions),
    commerce_zone_findings: commerceZoneFindings,
    prompts_required: matched.prompts,
    decisions: matched.decisions,
  };

  const themeInspection = inspectBrandTheme({
    packet,
    packetPath,
    context,
    policy: themePolicy,
    force: args.force === true,
  });
  const shouldWriteThemeCss = themeInspection.context_theme?.generated?.can_auto_generate === true;
  const writtenTheme = writeThemeArtifacts(themeInspection, {
    writeReport: true,
    writeCss: shouldWriteThemeCss,
    force: args.force === true,
  });
  context.theme = {
    ...themeInspection.context_theme,
    wrote: writtenTheme.wrote,
  };
  if (!writtenTheme.ok && Array.isArray(writtenTheme.errors) && writtenTheme.errors.length > 0) {
    context.theme.warnings = [
      ...(context.theme.warnings || []),
      ...writtenTheme.errors.map((error) => ({ code: error.code, message: error.message, detail: error.detail || null })),
    ];
  }

  const report = createAssemblyReport({ packetPath, contextPath, reportPath, specPath, sourceRoot, sourceKind, targetRepo, packet, context, blockers });

  writeJson(packetPath, packet);
  writeJson(contextPath, context);
  writeJson(reportPath, report);

  let doctor = null;
  if (options.installContext) installAgentContext(targetRepo, false);
  if (options.runDoctor) {
    doctor = doctorPacket(packetPath, { contextPath, reportPath, outputBaseDir: targetRepo });
    writeJson(doctorOutPath, doctor);
  }

  return { packetPath, contextPath, reportPath, doctorOutPath, packet, context, report, doctor };
}

export function inspectCommerceZones(sourceRoot, htmlFiles) {
  const findings = [];
  const attrPattern = /\b(data-next-[a-zA-Z0-9-]+)/g;
  const commerceZoneAttrPattern = /\bdata-commerce-zone\s*=\s*["']([^"']+)["']/gi;
  const commerceSlotAttrPattern = /\bdata-commerce-slot\s*=\s*["']([^"']+)["']/gi;
  const sdkOwnedPattern = /sdk-owned|provided\s+by\s+the\s+(?:[a-z0-9-]+\s+)?starter-template\s+sdk\s+contract|provided\s+by\s+the\s+(?:[a-z0-9-]+\s+)?checkout\s+commerce\s+surface/i;
  for (const file of htmlFiles) {
    const content = readFileSync(join(resolve(sourceRoot), file.path), "utf8");
    const lower = content.toLowerCase();
    attrPattern.lastIndex = 0;
    commerceZoneAttrPattern.lastIndex = 0;
    commerceSlotAttrPattern.lastIndex = 0;
    const attrs = [...new Set([...content.matchAll(attrPattern)].map((match) => match[1]))];
    const commerceZones = [
      ...content.matchAll(commerceZoneAttrPattern),
      ...content.matchAll(commerceSlotAttrPattern),
    ].map((match) => match[1]).filter(Boolean);
    const sdkOwnedMarker = sdkOwnedPattern.test(content);
    const sdkOwnedDeclared = sdkOwnedMarker || commerceZones.length > 0;
    const commerceZoneText = commerceZones.join(" ");
    const checkoutCommerceZone = /(checkout|payment|order-summary|summary|cart|submit|shipping)/i.test(commerceZoneText);
    const upsellCommerceZone = /(upsell|downsell)/i.test(commerceZoneText);
    const receiptCommerceZone = /(receipt|thankyou|thank-you)/i.test(commerceZoneText);
    const pathLower = String(file.path || "").toLowerCase();
    const checkoutRuntimeHint = /(^|[/_-])checkout([./_-]|$)/i.test(pathLower)
      || /\bdata-next-checkout(?:=|-)/i.test(content)
      || /\bos-checkout-payment\b/i.test(content)
      || checkoutCommerceZone
      || (sdkOwnedMarker && /(checkout|payment|order-summary|summary|cart|submit|shipping)/i.test(content));
    const upsellRuntimeHint = /(^|[/_-])(up|down)?sell([./_-]|$)/i.test(pathLower)
      || /\bdata-next-(?:up|down)?sell(?:=|-)/i.test(content)
      || upsellCommerceZone
      || (sdkOwnedMarker && /(upsell|downsell)/i.test(content));
    const receiptRuntimeHint = /(^|[/_-])(receipt|thankyou|thank-you)([./_-]|$)/i.test(pathLower)
      || receiptCommerceZone
      || (sdkOwnedMarker && /(receipt|thankyou|thank-you)/i.test(content));
    const requiresTemplateShell = sdkOwnedDeclared && (checkoutRuntimeHint || upsellRuntimeHint || receiptRuntimeHint);
    const zones = [];
    if (checkoutRuntimeHint) zones.push("checkout");
    if (checkoutRuntimeHint && (lower.includes("payment") || lower.includes("card number"))) zones.push("payment");
    if (upsellRuntimeHint) zones.push("upsell");
    if (receiptRuntimeHint) zones.push("receipt");
    if (attrs.length > 0) zones.push("sdk_attributes");
    if (commerceZones.length > 0) zones.push("commerce_zones");
    if (sdkOwnedDeclared) zones.push("sdk_owned_declared");
    if (zones.length > 0) {
      findings.push({
        path: file.path,
        zones: [...new Set(zones)],
        commerce_zones: [...new Set(commerceZones)],
        sdk_owned_declared: sdkOwnedDeclared,
        requires_template_shell: requiresTemplateShell,
        sdk_attributes: attrs,
        action: requiresTemplateShell
          ? "adopt_selected_template_family_shell_before_assembly"
          : "review_and_preserve_catalog_surfaces",
      });
    }
  }
  return findings;
}

function assemblyThemeFromContext(theme) {
  if (!isObject(theme)) return null;
  const warnings = Array.isArray(theme.warnings) ? theme.warnings : [];
  const canApply = theme.generated?.can_generate === true && theme.generated?.stale?.stale !== true;
  const wroteCss = theme.wrote?.css === true;
  return {
    status: theme.status === "blocked"
      ? "blocked"
      : canApply || wroteCss
        ? "needs_review"
        : "skipped",
    css_path: wroteCss || canApply ? theme.generated?.css_path || null : null,
    load_order: "unknown",
    commerce_pages: [],
    evidence: wroteCss
      ? ["prepare-build auto-generated .campaign-runtime/theme/brand-theme.css; build should copy that existing artifact into campaign assets and load it after next-core.css on commerce pages."]
      : theme.generated?.can_generate
        ? ["theme inspect found a generatable brand theme; run theme generate or explicit auto policy before applying."]
        : ["theme inspect completed; no generated brand theme was applied during prepare-build."],
    warnings,
    repair_loop_defect: null,
  };
}

function createAssemblyReport({ packetPath, contextPath, reportPath, specPath, sourceRoot, sourceKind, targetRepo, packet, context, blockers }) {
  const scaffoldRequired = context.scaffold.required;
  const portable = (path) => relFromDir(targetRepo, path);
  return {
    schema_version: REPORT_SCHEMA,
    run_id: `asm_${Date.now()}`,
    generated_at: new Date().toISOString(),
    status: blockers.length ? "blocked" : "prepared",
    identity: {
      map_id: packet.spec.map_id,
      public_route_slug: packet.campaign.public_route_slug,
      campaign_directory: packet.campaign.campaign_directory,
      live_url_path: packet.campaign.live_url_path,
      spec_hash: sha256File(specPath),
    },
    inputs: {
      packet_path: portable(packetPath),
      context_path: portable(contextPath),
      spec_path: portable(specPath),
      source: { kind: sourceKind, root: portable(sourceRoot) },
      target_repo: ".",
    },
    template_family: {
      value: packet.assembly.template_family,
      locked: packet.assembly.template_lock.locked,
      locked_by: packet.assembly.template_lock.locked_by,
      commerce_catalog_version: null,
      candidates: context.template.candidates,
    },
    stages: createInitialAssemblyReportStages({
      scaffoldRequired,
      blockers,
      outputs: [portable(packetPath), portable(contextPath), portable(reportPath)],
    }),
    decisions: context.decisions,
    adapter_decisions: cloneJson(context.adapter_decisions || createAdapterDecisions()),
    proof_policy: cloneJson(packet.qa?.proof_policy || createProofPolicy()),
    theme: assemblyThemeFromContext(context.theme),
    evidence: [],
    blockers,
    warnings: context.commerce_zone_findings.length
      ? [{ code: "SOURCE_COMMERCE_REVIEW", stage: "assembly", message: "Source HTML contains possible commerce zones. Preserve catalog-owned runtime surfaces." }]
      : [],
    next: blockers.length
      ? { stage: "collect-inputs", owner: "operator", action: "Resolve source/page blockers before build." }
      : {
          stage: scaffoldRequired ? "setup" : "assembly",
          owner: scaffoldRequired ? "next-campaigns-setup" : "next-campaigns-build",
          action: scaffoldRequired ? "Run setup before build." : "Run build with this packet and context.",
        },
  };
}

function doctorCommand(args) {
  const packetPath = resolve(requireArg(args, "packet"));
  const explicitSidecarArgs = Boolean(args.context || args.report);
  return doctorPacket(packetPath, {
    contextPath: args.context ? resolve(args.context) : explicitSidecarArgs ? null : undefined,
    reportPath: args.report ? resolve(args.report) : explicitSidecarArgs ? null : undefined,
    outputBaseDir: args["strip-paths"] === true ? dirname(packetPath) : null,
  });
}

function themeCommand(args) {
  const subcommand = args._[1] || "inspect";
  if (!["inspect", "generate"].includes(subcommand)) {
    throw new Error(`Unknown theme subcommand "${subcommand}". Use: inspect | generate.`);
  }
  const packetPath = resolve(requireArg(args, "packet"));
  const packet = readJson(packetPath);
  const context = readJsonIfExists(args.context ? resolve(args.context) : null);
  const policy = optionalString(args["theme-policy"], subcommand === "generate" ? "auto" : "inspect_only");
  const inspection = inspectBrandTheme({
    packet,
    packetPath,
    context,
    policy,
    outDir: args["out-dir"] === true ? null : args["out-dir"],
    force: args.force === true,
  });
  if (subcommand === "inspect") return { ...inspection, css: undefined };
  const written = writeThemeArtifacts(inspection, {
    writeReport: true,
    writeCss: true,
    force: args.force === true,
  });
  return { ...written, css: undefined };
}

function inferredBuildSidecarPaths(packet, packetPath) {
  const targetRepo = resolveFromFile(packetPath, packet?.assembly?.target_repo) || dirname(resolve(packetPath));
  return {
    contextPath: join(targetRepo, ".campaign-runtime/build-context.json"),
    reportPath: join(targetRepo, ".campaign-runtime/assembly-report.json"),
  };
}

function doctorPacket(packetPath, { contextPath = undefined, reportPath = undefined, outputBaseDir = null } = {}) {
  const packet = readJson(packetPath);
  const sidecars = inferredBuildSidecarPaths(packet, packetPath);
  const resolvedContextPath = contextPath === undefined ? sidecars.contextPath : contextPath;
  const resolvedReportPath = reportPath === undefined ? sidecars.reportPath : reportPath;
  const context = readJsonIfExists(resolvedContextPath);
  const report = readJsonIfExists(resolvedReportPath);
  const errors = [];
  const warnings = [];
  const ready = [];
  const derived = {
    packet_path: packetPath,
    map_id: packet?.spec?.map_id || null,
    public_route_slug: packet?.campaign?.public_route_slug || null,
    template_family: packet?.assembly?.template_family || null,
    source_root: null,
    target_repo: null,
    target_output_dir: null,
    spec_path: null,
    doctor_checks: [],
    scaffold_required: false,
    scaffold_reason: null,
    scope: {
      mode: "unknown",
      built_pages: [],
      out_of_scope_pages: [],
      previewable_routes: [],
      blocked_runtime_pages: [],
    },
  };

  validatePacket(packet, packetPath, errors, warnings, ready, derived, { context, report });
  runDoctorChecks(ARTIFACT_DOCTOR_CHECKS, { context, report, errors, warnings, ready, derived });

  const next = buildNextStep(errors, warnings, derived, report);
  const status = errors.length ? "blocked" : warnings.length ? "ready_with_warnings" : "ready";
  const result = { ok: errors.length === 0, status, errors, warnings, ready, derived, next };
  return outputBaseDir ? relativizeDoctorOutput(result, outputBaseDir) : result;
}

// Doctor Check Registry: keep packet/spec/build/artifact check order as data so
// agents add new checks in one deterministic slot instead of editing a long call chain.
function runDoctorChecks(checks, registryContext, options = {}) {
  if (!isObject(registryContext?.derived) || !Array.isArray(registryContext.derived.doctor_checks)) {
    throw new Error("Doctor check registry execution needs derived.doctor_checks for deterministic trace output.");
  }
  const executed = runDoctorCheckRegistry(checks, registryContext, options);
  registryContext.derived.doctor_checks.push(...executed);
  return executed;
}

const SPEC_DOCTOR_CHECKS = createDoctorCheckRegistry([
  {
    id: "campaign-spec.rule-registry",
    phase: "spec",
    run: ({ spec, errors, warnings }) => validateCampaignSpecRuleRegistry(spec, errors, warnings),
  },
  {
    id: "spec.identity_export",
    phase: "spec",
    run: ({ spec, warnings, ready }) => validateSpecIdentityExport(spec, warnings, ready),
  },
  {
    id: "spec.public_routes",
    phase: "spec",
    run: ({ spec, errors, ready }) => validateSpecPublicRoutes(spec, errors, ready),
  },
  {
    id: "spec.store_profile",
    phase: "spec",
    run: ({ spec, errors, warnings, ready }) => validateSpecStoreProfile(spec, errors, warnings, ready),
  },
  {
    id: "page_kit.sdk_version",
    phase: "target",
    run: ({ spec, packet, targetRepo, warnings, ready }) => validateTargetCampaignSdkVersion(spec, packet, targetRepo, warnings, ready),
  },
  {
    id: "spec.shipping_countries",
    phase: "spec",
    run: ({ spec, warnings, ready }) => validateSpecShippingCountries(spec, warnings, ready),
  },
  {
    id: "spec.routing_meta_tags",
    phase: "spec",
    run: ({ spec, packet, warnings, ready, derived, buildState }) => validateSpecRoutingMetaTags(spec, packet, warnings, ready, derived, buildState),
  },
  {
    id: "source_html.coverage",
    phase: "source",
    run: ({ packet, packetPath, spec, errors, warnings, ready, derived }) => validateSourceCoverage(packet, packetPath, spec, errors, warnings, ready, derived),
  },
  {
    id: "spec.package_availability",
    phase: "spec",
    run: ({ spec, warnings, ready }) => validateSpecPackageAvailability(spec, warnings, ready),
  },
  {
    id: "built_output.pages",
    phase: "built-output",
    run: ({ spec, packet, errors, warnings, ready, derived, buildState }) => validateBuiltOutputPages(spec, packet, errors, warnings, ready, derived, buildState),
  },
  {
    id: "built_output.sdk_meta_tags",
    phase: "built-output",
    run: ({ spec, packet, errors, warnings, ready, derived, buildState }) => validateBuiltSdkMetaTags(spec, packet, errors, warnings, ready, derived, buildState),
  },
], { registryId: "packet.spec" });

const PACKET_DOCTOR_CHECKS = createDoctorCheckRegistry([
  {
    id: "campaign.api_key",
    phase: "packet",
    run: ({ packet, spec, warnings, ready }) => validateCampaignsApiKey(packet, spec, warnings, ready),
  },
  {
    id: "assembly.commerce_catalog",
    phase: "template-contract",
    run: ({ packet, packetPath, spec, errors, warnings, ready, derived, buildState }) => validateCommerceCatalog(packet, packetPath, spec, errors, warnings, ready, derived, buildState),
  },
  {
    id: "market_copy",
    phase: "copy",
    run: ({ spec, warnings, ready, derived }) => validateMarketSensitiveCopy(spec, warnings, ready, derived),
  },
  {
    id: "source_html.adapter_contract",
    phase: "source",
    run: ({ packet, packetPath, spec, errors, warnings, ready, derived, buildState }) => validateAdapterContracts(packet, packetPath, spec, errors, warnings, ready, derived, buildState),
  },
  {
    id: "qa.proof_policy",
    phase: "qa",
    run: ({ packet, warnings, ready }) => validateProofPolicy(packet, warnings, ready),
  },
], { registryId: "packet.always" });

const ARTIFACT_DOCTOR_CHECKS = createDoctorCheckRegistry([
  // Artifact phases are deterministic labels for inspection/filtering; artifact
  // presence is gated by `when` because context and report sidecars are optional.
  {
    id: "context.shape",
    phase: "context",
    when: ({ context }) => Boolean(context),
    run: ({ context, errors, warnings, ready, derived }) => validateContext(context, errors, warnings, ready, derived),
  },
  {
    id: "assembly_report.shape",
    phase: "report",
    when: ({ report }) => Boolean(report),
    run: ({ report, errors, warnings, ready }) => validateAssemblyReportShape(report, errors, warnings, ready),
  },
], { registryId: "artifact.optional" });

function validatePacket(packet, packetPath, errors, warnings, ready, derived, buildState = {}) {
  if (!isObject(packet)) {
    addIssue(errors, "packet.type", "Build Packet must be a JSON object.");
    return;
  }
  if (packet.schema_version !== PACKET_SCHEMA) addIssue(errors, "schema_version", `Expected ${PACKET_SCHEMA}.`);
  else ready.push(`Build Packet schema ${PACKET_SCHEMA}`);

  requireString(packet, errors, "campaign.public_route_slug");
  requireBoolean(packet, errors, "campaign.allowed_domains_confirmed");
  requireString(packet, errors, "spec.map_id");
  requireString(packet, errors, "source_html.root");
  requireArray(packet, errors, "source_html.pages");
  requireString(packet, errors, "assembly.target_repo");
  requireString(packet, errors, "assembly.output_dir");
  requireString(packet, errors, "assembly.template_family");
  requireBoolean(packet, errors, "qa.test_orders_allowed");
  requireBoolean(packet, errors, "qa.sandbox_test_card_confirmed");

  if (!KNOWN_TEMPLATE_FAMILIES.has(packet.assembly?.template_family)) {
    addIssue(errors, "assembly.template_family", `Unknown template family "${packet.assembly?.template_family}".`);
  }
  if (!KNOWN_DEPLOY_TARGETS.has(packet.deploy?.target)) {
    addIssue(errors, "deploy.target", `Unknown deploy target "${packet.deploy?.target}".`);
  }

  if (packet.assembly?.template_family === "undecided" || packet.assembly?.template_lock?.locked !== true) {
    addIssue(errors, "assembly.template_lock", "Template family must be explicitly locked before commerce wiring.");
  }

  const deployUrl = packet.deploy?.preview_url || packet.deploy?.production_url;
  if (packet.campaign?.allowed_domains_confirmed !== true) {
    if (isLocalhostDevelopmentOrigin(deployUrl)) {
      ready.push("Deploy URL is localhost; Campaigns App treats localhost on any port as a Development domain, so SDK initialization is allowed and analytics are suppressed for local QA.");
    } else {
      addIssue(warnings, "campaign.allowed_domains_confirmed", "Non-localhost preview/production origins are not confirmed in the Campaigns App SDK origin allowlist. SDK runtime checks may be blocked after deploy.");
    }
  }

  const sourceRoot = resolveFromFile(packetPath, packet.source_html?.root);
  derived.source_root = sourceRoot;
  if (!sourceRoot || !existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    addIssue(errors, "source_html.root", `Source root does not exist: ${packet.source_html?.root}`);
  }

  const targetRepo = resolveFromFile(packetPath, packet.assembly?.target_repo);
  derived.target_repo = targetRepo;
  if (!targetRepo || !existsSync(targetRepo) || !statSync(targetRepo).isDirectory()) {
    addIssue(errors, "assembly.target_repo", `Target repo does not exist: ${packet.assembly?.target_repo}`);
  } else {
    const outputDir = resolve(targetRepo, packet.assembly?.output_dir || "");
    derived.target_output_dir = outputDir;
    derived.scaffold_required = !existsSync(outputDir);
    derived.scaffold_reason = derived.scaffold_required
      ? `Target output directory does not exist: ${packet.assembly?.output_dir}`
      : null;
    if (derived.scaffold_required) {
      addIssue(warnings, "page_kit.scaffold_required", "Target campaign output directory is missing; setup should run before build.");
    } else {
      ready.push("Target campaign output directory exists");
    }
    const pkgPath = join(targetRepo, "package.json");
    if (!existsSync(pkgPath)) {
      addIssue(warnings, "page_kit.package_json", "Target repo has no package.json. Page-kit command detection is unavailable.");
    } else {
      const pkg = readJson(pkgPath);
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (!deps["next-campaign-page-kit"]) {
        addIssue(warnings, "page_kit.dependency", "Target package.json does not declare next-campaign-page-kit; page-kit may still be installed through another local path.");
      } else {
        ready.push(`Target page-kit dependency ${deps["next-campaign-page-kit"]}`);
      }
    }
  }

  const specPath = resolveFromFile(packetPath, packet.spec?.local_path);
  derived.spec_path = specPath;
  let spec = null;
  if (!packet.spec?.local_path) {
    addIssue(errors, "spec.local_path", "No local CampaignSpec path is present. Assembly must use a local exported CampaignSpec JSON so page coverage, routing, meta tags, and commerce refs are not guessed.");
  } else if (!existsSync(specPath)) {
    addIssue(errors, "spec.local_path", `CampaignSpec local_path does not exist: ${packet.spec.local_path}`);
  } else {
    spec = readJson(specPath);
    const specMapId = spec.spec_identity?.map_id || spec.map_id;
    if (specMapId && specMapId !== packet.spec.map_id) {
      addIssue(errors, "spec.map_id", `Packet map_id "${packet.spec.map_id}" does not match CampaignSpec map_id "${specMapId}".`);
    }
    ready.push("Local CampaignSpec parsed");
    runDoctorChecks(SPEC_DOCTOR_CHECKS, { packet, packetPath, spec, targetRepo, errors, warnings, ready, derived, buildState });
  }

  runDoctorChecks(PACKET_DOCTOR_CHECKS, { packet, packetPath, spec, errors, warnings, ready, derived, buildState });

  if (!packet.deploy?.preview_url && !packet.deploy?.production_url) {
    const partialScope = derived.scope?.mode === "partial";
    addIssue(
      warnings,
      "deploy.preview_url",
      partialScope
        ? "No preview or production URL yet. After deploy, mapped pages are route/visual-testable; checkout/runtime launch QA remains blocked for out-of-scope pages."
        : "No preview or production URL yet. QA remains blocked after build/polish."
    );
  }
  // Test Orders use global test cards that bypass the gateway and create no
  // transactions, so they need no per-packet permission. The packet qa.* booleans
  // are retained as informational metadata but no longer gate test orders or QA
  // stage progression.
}

function validateCampaignSpecRuleRegistry(spec, errors, warnings) {
  // ADR-003: run the shared campaign-spec rule registry — the single public
  // source of CampaignSpec validation. specOnlyRules is the right preset here:
  // the doctor runs without a deployed URL, so any rule requiring one is
  // skipped. These pure spec-shape rules are complementary to the
  // packet/build-aware spec checks; both run so internal teams and agencies get
  // identical spec-shape validation. Emitted under the single spec.validation
  // code, with rule identity preserved in detail for JSON consumers.
  try {
    for (const violation of runRules(normalizeCampaignSpec(spec), specOnlyRules)) {
      addIssue(
        violation.severity === "error" ? errors : warnings,
        "spec.validation",
        violation.message,
        { ruleId: violation.ruleId, path: violation.path, data: violation.data }
      );
    }
  } catch (error) {
    addIssue(errors, "spec.validation", `CampaignSpec validation failed: ${error.message}`);
  }
}

function validateAdapterContracts(packet, packetPath, spec, errors, warnings, ready, derived = {}, buildState = {}) {
  const packetContract = packet.source_html?.adapter_contract;
  validateAdapterDecisionShape(packetContract, "source_html.adapter_contract", warnings, ready, { addIssue });
  validateAdapterSourceFiles({
    decisions: packetContract,
    sourceRoot: resolveFromFile(packetPath, packet.source_html?.root),
    pages: packet.source_html?.pages || [],
    warnings,
    ready,
    addIssue,
  });

  const contextDecisions = buildState.context?.adapter_decisions;
  const reportDecisions = buildState.report?.adapter_decisions;

  const decisions = reportDecisions || contextDecisions || packetContract;
  validateAdapterDecisionGates({
    decisions,
    location: reportDecisions ? "report.adapter_decisions" : contextDecisions ? "context.adapter_decisions" : "source_html.adapter_contract",
    specPages: activeSpecPages(spec),
    family: packet.assembly?.template_family,
    assemblyComplete: isStageComplete(buildState.report, "assembly"),
    targetRepo: derived.target_repo,
    errors,
    warnings,
    ready,
    addIssue,
  });
}

function validateProofPolicy(packet, warnings, ready) {
  const policy = packet.qa?.proof_policy;
  if (!policy) {
    addIssue(warnings, "qa.proof_policy", "qa.proof_policy is missing. New packets make browser QA, typed-card depth, SDK origin allowlist state, order path depth, and approval state explicit.");
    return;
  }
  validateProofPolicyObject(policy, "qa.proof_policy", warnings, ready, { requireBrowserQa: true });
}

function validateProofPolicyObject(policy, location, warnings, ready, { requireBrowserQa = false } = {}) {
  if (!isObject(policy)) {
    addIssue(warnings, location, `${location} must be an object when present.`);
    return;
  }
  for (const field of PROOF_POLICY_REQUIRED_FIELDS) {
    if (!(field in policy)) {
      addIssue(warnings, `${location}.${field}`, `${location}.${field} is missing; proof policy must make browser QA, typed-card depth, SDK origin allowlist state, order path depth, and approval state explicit.`);
    }
  }
  if (policy.browser_qa_required != null && typeof policy.browser_qa_required !== "boolean") {
    addIssue(warnings, `${location}.browser_qa_required`, `${location}.browser_qa_required must be a boolean.`);
  } else if ("browser_qa_required" in policy && requireBrowserQa && policy.browser_qa_required !== true) {
    addIssue(warnings, `${location}.browser_qa_required`, "Browser QA should stay explicit in the packet/report before launch proof.");
  }
  if (!isNonEmptyString(policy.typed_card_depth)) {
    addIssue(warnings, `${location}.typed_card_depth`, `${location}.typed_card_depth should name the intended typed-card depth, usually common.`);
  }
  if ("localhost_development_domain_allowed" in policy && policy.localhost_development_domain_allowed !== true) {
    addIssue(warnings, `${location}.localhost_development_domain_allowed`, `${location}.localhost_development_domain_allowed should be true; localhost on any port is the public Development-domain QA origin.`);
  }
  if ("non_localhost_origin_allowlist_required" in policy && policy.non_localhost_origin_allowlist_required !== true) {
    addIssue(warnings, `${location}.non_localhost_origin_allowlist_required`, `${location}.non_localhost_origin_allowlist_required should be true; preview/production origins require SDK origin allowlist confirmation.`);
  }
  if (!isNonEmptyString(policy.order_path_depth)) {
    addIssue(warnings, `${location}.order_path_depth`, `${location}.order_path_depth should name checkout/upsell order-path depth.`);
  }
  if (!isNonEmptyString(policy.operator_approval_state)) {
    addIssue(warnings, `${location}.operator_approval_state`, `${location}.operator_approval_state should be explicit, e.g. not_required_global_test_cards.`);
  }
  if (policy.qa_portal_publish_default != null && typeof policy.qa_portal_publish_default !== "boolean") {
    addIssue(warnings, `${location}.qa_portal_publish_default`, `${location}.qa_portal_publish_default must be a boolean when present.`);
  }
  ready.push(`${location} loaded: browser=${policy.browser_qa_required === true}, typed_card_depth=${policy.typed_card_depth || "unspecified"}, order_path_depth=${policy.order_path_depth || "unspecified"}`);
}

export function validateSpecStoreProfile(spec, errors, warnings, ready) {
  const campaign = spec?.campaign || {};
  const missing = REQUIRED_STORE_PROFILE_FIELDS.filter((field) => !isNonEmptyString(campaign[field]));
  if (missing.length > 0) {
    addIssue(
      errors,
      "spec.store_profile",
      `CampaignSpec campaign is missing required Store Profile field for page-kit campaigns.json: ${missing.join(", ")}.`
    );
    return;
  }
  ready.push("CampaignSpec required Store Profile fields are present for page-kit campaigns.json");

  // SELL-362 / R2-B5: a store profile can pass the required-field check yet
  // still be unable to serve a real shopper — the gap neither doctor nor
  // browser QA surfaced in the Round 2 run. These are real-shopper readiness
  // *warnings* (not blockers): a routing/visual-only run is fine, and they are
  // independent of test orders (test cards bypass the gateway). The concern is
  // that a real customer cannot complete checkout against a placeholder store
  // URL or a store with no payment methods configured.
  const storeUrl = campaign.store_url;
  if (isNonEmptyString(storeUrl) && looksLikePlaceholderStoreUrl(storeUrl)) {
    addIssue(
      warnings,
      "spec.store_profile.placeholder_store_url",
      `CampaignSpec campaign.store_url "${storeUrl}" looks like a local/placeholder store, not a live storefront. Localhost is valid as a Development-domain QA origin, but a real shopper cannot transact against it. Set the merchant's production store_url before launch.`
    );
  } else if (isNonEmptyString(storeUrl)) {
    ready.push("CampaignSpec store_url points at a non-placeholder storefront");
  }

  const paymentMethods = campaign.available_payment_methods;
  if (Array.isArray(paymentMethods) && paymentMethods.length === 0) {
    addIssue(
      warnings,
      "spec.store_profile.no_payment_methods",
      "CampaignSpec campaign.available_payment_methods is empty. A real shopper would have no payment method to complete checkout. Confirm the store's payment methods before launch."
    );
  }

  // Starter-template checkout pages hard-code the payment-methods include with
  // show_paypal/show_klarna/show_apple_pay/show_google_pay = true (the include
  // itself defaults them false). So a method the spec does not support still
  // renders unless the build removes it from that include call. When the spec
  // declares its supported methods and one of those four is absent from both
  // available_payment_methods and available_express_payment_methods, warn so the
  // build disables it (or the spec adds it). Methods may be plain strings or
  // { code, label } objects.
  const normalizeMethod = (method) =>
    String(method && typeof method === "object" ? method.code : method).toLowerCase().replace(/[\s-]+/g, "_");
  const supportedMethods = new Set([
    ...(Array.isArray(paymentMethods) ? paymentMethods : []).map(normalizeMethod),
    ...(Array.isArray(campaign.available_express_payment_methods) ? campaign.available_express_payment_methods : []).map(normalizeMethod),
  ]);
  if (supportedMethods.size > 0) {
    const unsupportedDefaults = ["paypal", "klarna", "apple_pay", "google_pay"].filter(
      (method) => !supportedMethods.has(method)
    );
    if (unsupportedDefaults.length > 0) {
      addIssue(
        warnings,
        "spec.store_profile.payment_methods_default_on",
        `Starter-template checkout pages enable ${unsupportedDefaults.join(", ")} in the payment-methods include by default, but the CampaignSpec does not list ${unsupportedDefaults.length > 1 ? "them" : "it"} in available_payment_methods/available_express_payment_methods. If you build on a starter template family, remove the show_* arg(s) from the checkout payment-methods include (or add the method to the spec) so unsupported methods do not ship.`
      );
    }
  }
}

// SELL-362 / R2-B5: a best-effort check for store URLs that clearly cannot be
// a live storefront (local dev hosts, reserved test/example TLDs). Intentionally
// conservative — only obvious non-production hosts trip it, so a real merchant
// domain never false-positives. A non-URL string is left to other validators.
function looksLikePlaceholderStoreUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(host)) return true;
  if (/\.(local|test|example|invalid|localhost)$/.test(host)) return true;
  if (host === "example.com" || host.endsWith(".example.com")) return true;
  return false;
}

export function isLocalhostDevelopmentOrigin(value) {
  if (!isNonEmptyString(value)) return false;
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return false;
  }
  return url.hostname.toLowerCase() === "localhost";
}

function validateTargetCampaignSdkVersion(spec, packet, targetRepo, warnings, ready) {
  const specSdkVersion = firstNonEmptyString(spec?.global_config?.sdk_version, spec?.runtime?.sdk_version);
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  if (!targetRepo || !specSdkVersion || !publicRouteSlug) return;

  const campaignsPath = join(targetRepo, "_data", "campaigns.json");
  if (!existsSync(campaignsPath)) return;

  let campaigns;
  try {
    campaigns = readJson(campaignsPath);
  } catch (error) {
    addIssue(warnings, "page_kit.campaigns_json", `Could not parse target _data/campaigns.json to compare SDK version: ${error.message}`);
    return;
  }

  const entry = campaigns?.[publicRouteSlug];
  const targetSdkVersion = entry?.sdk_version;
  if (!isNonEmptyString(targetSdkVersion)) return;

  if (targetSdkVersion.trim() !== specSdkVersion) {
    addIssue(
      warnings,
      "page_kit.sdk_version",
      `Target _data/campaigns.json[${publicRouteSlug}].sdk_version "${targetSdkVersion}" does not match CampaignSpec sdk_version "${specSdkVersion}". Update the campaign entry or record the intentional pin before build/QA.`
    );
    return;
  }

  ready.push(`Target campaigns.json SDK version matches CampaignSpec (${specSdkVersion})`);
}

function validateSpecShippingCountries(spec, warnings, ready) {
  const countries = spec?.campaign?.available_shipping_countries;
  if (countries === "all" || (Array.isArray(countries) && countries.length === 0)) {
    ready.push("CampaignSpec shipping countries: all countries");
    return;
  }
  if (Array.isArray(countries)) {
    ready.push(`CampaignSpec shipping countries: ${countries.join(", ")}`);
    return;
  }
  if (countries == null) {
    ready.push("CampaignSpec shipping countries: all countries");
    return;
  }
  addIssue(warnings, "spec.available_shipping_countries", 'CampaignSpec campaign.available_shipping_countries should be "all" or an array of country codes.');
}

function specPackageRecords(spec) {
  const records = [];
  const add = (pkg, source) => {
    if (!isObject(pkg)) return;
    const ref = firstNonEmptyString(pkg.ref_id, pkg.package_id != null ? String(pkg.package_id) : null, pkg.id != null ? String(pkg.id) : null);
    if (!ref) return;
    records.push({ ref, source, package: pkg });
  };

  for (const page of activeSpecPages(spec)) {
    for (const pkg of Array.isArray(page.packages) ? page.packages : []) {
      add(pkg, `page:${page.id}`);
    }
  }
  for (const offer of Array.isArray(spec?.offers) ? spec.offers : []) {
    for (const pkg of Array.isArray(offer.packages) ? offer.packages : []) {
      add(pkg, `offer:${offer.ref_id || offer.code || offer.name || "unknown"}`);
    }
  }
  for (const pkg of Array.isArray(spec?.packages) ? spec.packages : []) {
    add(pkg, "packages");
  }

  return records;
}

function specPackageRefs(spec) {
  return new Set(specPackageRecords(spec).map((record) => String(record.ref)));
}

function specShippingRefs(spec) {
  const refs = new Set();
  const add = (method) => {
    const ref = firstNonEmptyString(method?.ref_id, method?.id != null ? String(method.id) : null, method?.shipping_method_id != null ? String(method.shipping_method_id) : null);
    if (ref) refs.add(String(ref));
  };

  for (const method of Array.isArray(spec?.shipping_methods) ? spec.shipping_methods : []) add(method);
  for (const offer of Array.isArray(spec?.offers) ? spec.offers : []) {
    for (const method of Array.isArray(offer.shipping_methods) ? offer.shipping_methods : []) add(method);
  }

  return refs;
}

// SELL-362 / R2-B1: the set of refs the CampaignSpec itself declares as real
// commerce entities — packages (page/offer/top-level), shipping methods, and
// offer ref_ids. A reference whose value matches one of these points at a
// genuinely-declared entity, so the demo-ref check below should not treat it
// as a starter placeholder even when the Map export omitted ref-level
// `_provenance.api` stamping (the provenance gap that produced the noise).
function specDeclaredCommerceRefs(spec) {
  const refs = new Set([...specPackageRefs(spec), ...specShippingRefs(spec)]);
  for (const offer of Array.isArray(spec?.offers) ? spec.offers : []) {
    const ref = firstNonEmptyString(offer?.ref_id, offer?.id != null ? String(offer.id) : null);
    if (ref) refs.add(String(ref));
  }
  return refs;
}

function validateSpecPackageAvailability(spec, warnings, ready) {
  const unavailable = specPackageRecords(spec).filter((record) => {
    const availability = firstNonEmptyString(
      record.package.product_purchase_availability,
      record.package.purchase_availability,
      record.package.availability
    );
    return availability && availability.toLowerCase() === "unavailable";
  });

  if (!unavailable.length) {
    ready.push("CampaignSpec package purchase availability has no unavailable package refs in active build data");
    return;
  }

  const sample = unavailable
    .slice(0, 6)
    .map((record) => `${record.ref} (${record.source})`)
    .join(", ");
  const more = unavailable.length > 6 ? `; plus ${unavailable.length - 6} more` : "";
  addIssue(
    warnings,
    "spec.package_unavailable",
    `CampaignSpec contains package refs marked product_purchase_availability=unavailable: ${sample}${more}. Checkout or upsell API calls may 403 until the store variant is available.`
  );
}

function validateSpecIdentityExport(spec, warnings, ready) {
  const identity = spec?.spec_identity;
  if (isObject(identity) && isNonEmptyString(identity.map_id) && isNonEmptyString(identity.public_route_slug)) {
    ready.push("CampaignSpec spec_identity includes map_id and public_route_slug");
    return;
  }

  addIssue(
    warnings,
    "spec_identity.export",
    "CampaignSpec is missing complete spec_identity.map_id/public_route_slug. Prefer re-exporting from a saved Map Builder map; CLI identity overrides should stay diagnostic-only."
  );
}

export function validateSpecRoutingMetaTags(spec, packet, warnings, ready, derived = {}, buildState = {}) {
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  if (!publicRouteSlug) return;

  // SELL-362 / R2-B2: the spec only carries unrooted routing-meta *hints*; the
  // page-kit build roots them when it renders _site/<slug>/. Once that built
  // output exists and assembly is complete, validateBuiltSdkMetaTags checks the
  // actual rendered values authoritatively. Re-warning on the spec literal here
  // would just repeat a "fix before QA" message the build already satisfied
  // (browser QA later proved the deployed output correct), so defer to the
  // built-output check instead of double-flagging.
  const targetRepo = derived.target_repo;
  const siteRoot = targetRepo ? join(targetRepo, "_site", publicRouteSlug) : null;
  if (isStageComplete(buildState.report, "assembly") && siteRoot && existsSync(siteRoot)) {
    ready.push(`CampaignSpec routing meta deferred to built-output verification (_site/${publicRouteSlug}/).`);
    return;
  }

  const hits = [];
  for (const page of activeSpecPages(spec)) {
    const metaTags = page.sdk_hints?.meta_tags;
    if (!isObject(metaTags)) continue;

    for (const tag of SDK_ROUTING_META_TAGS) {
      const value = metaTags[tag];
      if (!isNonEmptyString(value)) continue;
      const route = value.trim();
      if (isRuntimeRootedRoutingMeta(route, publicRouteSlug)) continue;
      hits.push(`${page.id}:${tag}=${route}`);
    }
  }

  if (!hits.length) {
    ready.push(`CampaignSpec SDK routing meta tags are runtime-rooted for /${publicRouteSlug}/`);
    return;
  }

  const sample = hits.slice(0, 5).join("; ");
  const more = hits.length > 5 ? `; plus ${hits.length - 5} more` : "";
  addIssue(
    warnings,
    "routing_meta.runtime_root",
    `CampaignSpec sdk_hints.meta_tags routing values must render as campaign-rooted paths before QA. Expected values like "/${publicRouteSlug}/upsell/" for ${SDK_ROUTING_META_TAGS.join(", ")}; found ${sample}${more}.`
  );
}

function validateBuiltSdkMetaTags(spec, packet, errors, warnings, ready, derived, buildState = {}) {
  const expectedPages = activeSpecPages(spec)
    .map((page) => ({
      page,
      metaTags: page.sdk_hints?.meta_tags,
    }))
    .filter(({ metaTags }) => isObject(metaTags) && Object.keys(metaTags).length > 0);
  if (expectedPages.length === 0) return;

  const allExpectedTags = [...new Set(expectedPages.flatMap(({ metaTags }) => Object.keys(metaTags)))].sort();
  const targetRepo = derived.target_repo;
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  const siteRoot = targetRepo && publicRouteSlug ? join(targetRepo, "_site", publicRouteSlug) : null;
  const assemblyComplete = isStageComplete(buildState.report, "assembly");

  if (!siteRoot || !existsSync(siteRoot)) {
    addIssue(
      warnings,
      "sdk_hints.meta_tags",
      `CampaignSpec expects SDK meta tags (${allExpectedTags.join(", ")}). Doctor cannot verify rendered output until page-kit build writes _site/${publicRouteSlug || "<slug>"}/.`
    );
    return;
  }

  let checked = 0;
  for (const { page, metaTags } of expectedPages) {
    const builtPath = builtHtmlPathForPage(targetRepo, publicRouteSlug, page, derived);
    if (!builtPath || !existsSync(builtPath)) {
      const issue = {
        code: "built_output.page_missing",
        message: `Built HTML is missing for CampaignSpec page "${page.id}" at ${builtPath ? relFromDir(targetRepo, builtPath) : "_site/<slug>/..."}.`,
      };
      (assemblyComplete ? errors : warnings).push(issue);
      continue;
    }

    checked += 1;
    const content = readFileSync(builtPath, "utf8");

    for (const [name, expectedValue] of Object.entries(metaTags)) {
      const actualValue = extractMetaContent(content, name);
      if (!isNonEmptyString(actualValue)) {
        addIssue(
          assemblyComplete ? errors : warnings,
          "sdk_hints.meta_tags.missing",
          `Built page "${page.id}" is missing SDK meta tag "${name}" expected from CampaignSpec.`,
          { page_id: page.id, file: relFromDir(targetRepo, builtPath) }
        );
        continue;
      }
      if (SDK_ROUTING_META_TAGS.includes(name) && isNonEmptyString(expectedValue)) {
        const expectedRoute = runtimeRouteForMetaValue(expectedValue, publicRouteSlug);
        if (expectedRoute && actualValue.trim() !== expectedRoute) {
          addIssue(
            assemblyComplete ? errors : warnings,
            "sdk_hints.meta_tags.route_mismatch",
            `Built page "${page.id}" emits ${name}="${actualValue}", expected "${expectedRoute}".`,
            { page_id: page.id, file: relFromDir(targetRepo, builtPath) }
          );
        }
      }
    }
  }

  if (checked > 0) ready.push(`Built SDK meta tags checked in _site/${publicRouteSlug}/ for ${checked} page(s)`);
}

function validateBuiltOutputPages(spec, packet, errors, warnings, ready, derived, buildState = {}) {
  const pages = activeSpecPages(spec);
  if (pages.length === 0) return;

  const targetRepo = derived.target_repo;
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  const siteRoot = targetRepo && publicRouteSlug ? join(targetRepo, "_site", publicRouteSlug) : null;
  if (!siteRoot || !existsSync(siteRoot)) return;

  const assemblyComplete = isStageComplete(buildState.report, "assembly");
  let checked = 0;
  for (const page of pages) {
    const builtPath = builtHtmlPathForPage(targetRepo, publicRouteSlug, page, derived);
    if (!builtPath || !existsSync(builtPath)) continue;

    checked += 1;
    validateBuiltHtmlStructure(
      readFileSync(builtPath, "utf8"),
      builtPath,
      targetRepo,
      page,
      spec,
      publicRouteSlug,
      errors,
      warnings,
      assemblyComplete
    );
  }

  if (checked > 0) ready.push(`Built HTML structure and commerce refs checked in _site/${publicRouteSlug}/ for ${checked} page(s)`);
}

function validateBuiltHtmlStructure(content, builtPath, targetRepo, page, spec, publicRouteSlug, errors, warnings, assemblyComplete) {
  const issueTarget = assemblyComplete ? errors : warnings;
  const relPath = relFromDir(targetRepo, builtPath);
  if (!/<body(?:\s|>)/i.test(content) || !/<\/body>/i.test(content)) {
    addIssue(issueTarget, "built_output.body_missing", `Built page "${page.id}" does not contain a complete <body> element.`, { page_id: page.id, file: relPath });
  }
  if (!/(data-next-|window\.next|next-page-type|campaign-cart-sdk|campaign-cart)/i.test(content)) {
    addIssue(issueTarget, "built_output.runtime_missing", `Built page "${page.id}" has no obvious Campaign Cart runtime markers.`, { page_id: page.id, file: relPath });
  }
  validateBuiltPageKitAssetPaths(content, builtPath, targetRepo, page, publicRouteSlug, issueTarget);
  validateBuiltScriptAssets(content, builtPath, targetRepo, page, publicRouteSlug, issueTarget);
  validateBuiltCommerceRefs(content, builtPath, targetRepo, page, spec, issueTarget);
}

function validateBuiltScriptAssets(content, builtPath, targetRepo, page, publicRouteSlug, issueTarget) {
  for (const tag of content.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    const src = tag[1];
    const resolved = resolveBuiltAssetPath(src, builtPath, targetRepo);
    if (!resolved || existsSync(resolved)) continue;
    if (pageKitAssetPathViolation(src, publicRouteSlug)) continue;
    addIssue(
      issueTarget,
      "built_output.script_missing",
      `Built page "${page.id}" references script "${src}", but the file does not exist in built output.`,
      { page_id: page.id, file: relFromDir(targetRepo, builtPath), script: src }
    );
  }
}

export function validateBuiltPageKitAssetPaths(content, builtPath, targetRepo, page, publicRouteSlug, issueTarget) {
  const hits = collectPageKitAssetPathViolations(content, publicRouteSlug)
    .filter((hit) => {
      const resolved = resolveBuiltAssetPath(hit.reference, builtPath, targetRepo);
      return resolved && !existsSync(resolved);
    });

  if (!hits.length) return;

  const slug = normalizePublicRouteSlug(publicRouteSlug);
  const sample = hits
    .slice(0, 5)
    .map((hit) => `${hit.reference} (${hit.kind}, line ${hit.line})`)
    .join("; ");
  const more = hits.length > 5 ? `; plus ${hits.length - 5} more` : "";
  const renderedExample = slug ? `/${slug}/config.js` : "/<slug>/config.js";
  const sourceExample = slug ? `src/${slug}/assets/config.js` : "src/<slug>/assets/config.js";

  addIssue(
    issueTarget,
    "built_output.pagekit_asset_path",
    `Built page "${page.id}" references page-kit asset path(s) that do not exist in built output: ${sample}${more}. next-campaign-page-kit copies ${sourceExample} to "${renderedExample}" (not "/assets/config.js" or "/${slug || "<slug>"}/assets/config.js"). Use "{{ 'config.js' | campaign_asset }}" in page-kit source, or rewrite raw passthrough HTML to the campaign-rooted built URL.`,
    {
      page_id: page.id,
      file: relFromDir(targetRepo, builtPath),
      references: hits.map((hit) => ({
        reference: hit.reference,
        expected: hit.expected,
        line: hit.line,
        kind: hit.kind,
      })),
    }
  );
}

export function collectPageKitAssetPathViolations(content, publicRouteSlug) {
  const slug = normalizePublicRouteSlug(publicRouteSlug);
  const hits = [];
  const seen = new Set();

  const record = (kind, reference, index) => {
    const hit = pageKitAssetPathViolation(reference, slug);
    if (!hit) return;
    const key = `${kind}:${hit.reference}:${lineNumberAt(content, index || 0)}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({
      ...hit,
      kind,
      line: lineNumberAt(content, index || 0),
    });
  };

  for (const match of content.matchAll(/\b(src|href)=["']([^"']+)["']/gi)) {
    record(match[1].toLowerCase(), match[2], match.index);
  }
  for (const match of content.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
    record("css-url", match[2], match.index);
  }

  return hits;
}

function pageKitAssetPathViolation(reference, publicRouteSlug) {
  const raw = String(reference || "").trim();
  if (!raw || raw.startsWith("//") || isAbsoluteHttpUrl(raw) || raw.startsWith("data:") || raw.startsWith("mailto:") || raw.startsWith("tel:")) return null;

  const clean = raw.replace(/[?#].*$/, "");
  const slugAssetsPrefix = publicRouteSlug ? `/${publicRouteSlug}/assets/` : null;
  let assetPath = null;

  if (clean.startsWith("/assets/")) {
    assetPath = clean.slice("/assets/".length);
  } else if (slugAssetsPrefix && clean.startsWith(slugAssetsPrefix)) {
    assetPath = clean.slice(slugAssetsPrefix.length);
  }

  if (!assetPath || assetPath.startsWith("../") || assetPath.includes("/../")) return null;
  return {
    reference: raw,
    asset_path: assetPath,
    expected: publicRouteSlug ? `/${publicRouteSlug}/${assetPath}` : `/<slug>/${assetPath}`,
  };
}

function resolveBuiltAssetPath(src, builtPath, targetRepo) {
  if (!isNonEmptyString(src)) return null;
  const raw = src.trim();
  if (raw.startsWith("//") || isAbsoluteHttpUrl(raw) || raw.startsWith("data:") || raw.startsWith("mailto:") || raw.startsWith("tel:")) return null;
  const clean = raw.replace(/[?#].*$/, "");
  if (!clean || clean.startsWith("#")) return null;
  if (clean.startsWith("/")) return join(targetRepo, "_site", clean.replace(/^\/+/, ""));
  return resolve(dirname(builtPath), clean);
}

function validateBuiltCommerceRefs(content, builtPath, targetRepo, page, spec, issueTarget) {
  const packageRefs = specPackageRefs(spec);
  const shippingRefs = specShippingRefs(spec);
  const relPath = relFromDir(targetRepo, builtPath);
  const badPackages = [...extractRenderedPackageRefs(content)].filter((ref) => packageRefs.size > 0 && !packageRefs.has(ref));
  const badShipping = [...extractRenderedShippingRefs(content)].filter((ref) => shippingRefs.size > 0 && !shippingRefs.has(ref));

  if (badPackages.length > 0) {
    addIssue(
      issueTarget,
      "built_output.package_ref",
      `Built page "${page.id}" references package ID(s) not present in CampaignSpec: ${[...new Set(badPackages)].join(", ")}.`,
      { page_id: page.id, file: relPath }
    );
  }
  if (badShipping.length > 0) {
    addIssue(
      issueTarget,
      "built_output.shipping_ref",
      `Built page "${page.id}" references shipping ID(s) not present in CampaignSpec: ${[...new Set(badShipping)].join(", ")}.`,
      { page_id: page.id, file: relPath }
    );
  }
}

function extractRenderedPackageRefs(content) {
  const refs = new Set();
  for (const match of content.matchAll(/\bdata-next-package-id=["']([^"']+)["']/gi)) addRenderedRef(refs, match[1]);
  for (const match of content.matchAll(/\bdata-package-id=["']([^"']+)["']/gi)) addRenderedRef(refs, match[1]);
  for (const match of content.matchAll(/["']?packageId["']?\s*:\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/gi)) {
    addRenderedRef(refs, match[1] || match[2] || match[3]);
  }
  return refs;
}

function extractRenderedShippingRefs(content) {
  const refs = new Set();
  for (const match of content.matchAll(/\bdata-next-shipping-id=["']([^"']+)["']/gi)) addRenderedRef(refs, match[1]);
  for (const match of content.matchAll(/["']?shippingId["']?\s*:\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/gi)) {
    addRenderedRef(refs, match[1] || match[2] || match[3]);
  }
  return refs;
}

function addRenderedRef(refs, value) {
  const ref = String(value || "").trim();
  if (/^[A-Za-z0-9_-]+$/.test(ref)) refs.add(ref);
}

function builtHtmlPathForPage(targetRepo, publicRouteSlug, page, derived = {}) {
  if (!targetRepo || !publicRouteSlug) return null;
  const sourcePermalink = sourcePermalinkForPage(derived?.target_output_dir, publicRouteSlug, page);
  const route = sourcePermalink || runtimeRelativeRouteForSpecValue(publicRouteForPage(page), publicRouteSlug);
  if (!route) return join(targetRepo, "_site", publicRouteSlug, "index.html");
  const clean = route.replace(/^\/+|\/+$/g, "");
  return clean ? join(targetRepo, "_site", publicRouteSlug, clean, "index.html") : join(targetRepo, "_site", publicRouteSlug, "index.html");
}

function sourcePermalinkForPage(targetOutputDir, publicRouteSlug, page) {
  if (!targetOutputDir || !existsSync(targetOutputDir) || !statSync(targetOutputDir).isDirectory()) return null;

  const expectedTerminal = terminalRouteSegment(publicRouteForPage(page));
  const candidates = [];
  for (const file of collectHtmlFiles(targetOutputDir)) {
    if (file.path.includes("_includes/") || file.path.includes("_layouts/")) continue;
    const fullPath = join(targetOutputDir, file.path);
    const content = readFileSync(fullPath, "utf8");
    const permalink = extractFrontmatterValue(content, "permalink");
    if (!isNonEmptyString(permalink)) continue;
    const relative = stripPublicRoutePrefix(normalizePageKitRoute(permalink), publicRouteSlug);
    if (terminalRouteSegment(relative) === expectedTerminal) candidates.push(relative);
  }

  return candidates.length === 1 ? candidates[0] : null;
}

function extractMetaContent(content, name) {
  const escaped = escapeRegExp(name);
  const metaTag = new RegExp(`<meta\\b(?=[^>]*\\bname=["']${escaped}["'])([^>]*)>`, "i").exec(content);
  if (!metaTag) return null;
  const contentAttr = /\bcontent=["']([^"']*)["']/i.exec(metaTag[1]);
  return contentAttr ? contentAttr[1] : "";
}

function runtimeRouteForMetaValue(value, publicRouteSlug) {
  if (!isNonEmptyString(value)) return null;
  const route = value.trim();
  if (isAbsoluteHttpUrl(route)) return route;
  if (isRuntimeRootedRoutingMeta(route, publicRouteSlug)) return route;
  const normalized = runtimeRelativeRouteForSpecValue(route, publicRouteSlug);
  return normalized ? `/${publicRouteSlug}/${normalized}` : `/${publicRouteSlug}/`;
}

function runtimeRelativeRouteForSpecValue(value, publicRouteSlug) {
  const normalized = normalizePageKitRoute(value);
  if (!normalized) return "";
  const stripped = stripPublicRoutePrefix(normalized, publicRouteSlug);
  const segments = stripped.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (segments.length > 1) return `${segments[segments.length - 1]}/`;
  return stripped;
}

function stripPublicRoutePrefix(route, publicRouteSlug) {
  const normalized = normalizePageKitRoute(route);
  const slug = normalizePublicRouteSlug(publicRouteSlug);
  if (!normalized || !slug) return normalized;
  const clean = normalized.replace(/^\/+|\/+$/g, "");
  if (clean === slug) return "";
  if (clean.startsWith(`${slug}/`)) return `${clean.slice(slug.length + 1).replace(/\/?$/, "/")}`;
  return normalized;
}

function terminalRouteSegment(route) {
  const normalized = normalizePageKitRoute(route);
  const parts = normalized.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePublicRouteSlug(value) {
  return String(value || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
}

function isRuntimeRootedRoutingMeta(value, publicRouteSlug) {
  if (isAbsoluteHttpUrl(value)) return true;
  const route = value.trim();
  if (!route.startsWith("/")) return false;
  return route === `/${publicRouteSlug}` || route.startsWith(`/${publicRouteSlug}/`);
}

export function validateMarketSensitiveCopy(spec, warnings, ready, derived) {
  const scope = deriveMarketScope(spec);
  const currencyScope = deriveCurrencyCopyScope(spec);
  const storePhone = firstNonEmptyString(spec?.campaign?.store_phone, spec?.campaign?.phone);
  if (!scope.needsCopyReview && !currencyScope.needsCopyReview && !storePhone) return;

  const scanRoots = [];
  if (derived.source_root && existsSync(derived.source_root) && statSync(derived.source_root).isDirectory()) {
    scanRoots.push({ label: "source", root: derived.source_root });
  }
  if (derived.target_output_dir && existsSync(derived.target_output_dir) && statSync(derived.target_output_dir).isDirectory()) {
    scanRoots.push({ label: "target", root: derived.target_output_dir });
  }

  const matches = scope.needsCopyReview ? collectMarketCopyMatches(scanRoots) : [];
  if (scope.needsCopyReview && !matches.length) {
    ready.push(`Market-sensitive copy scan found no obvious US-only patterns (${scope.reasons.join(", ")}).`);
  } else if (matches.length) {
    const matchSummary = summarizeCopyMatches(matches);
    addIssue(
      warnings,
      "market_copy.us_specific_claims",
      `Campaign market scope needs copy review (${scope.reasons.join(", ")}), and source/template files contain US-specific starter copy: ${matchSummary}. Confirm or replace this copy; do not remove it automatically.`
    );
  }

  if (currencyScope.needsCopyReview) {
    const currencyMatches = collectHardcodedCurrencyMatches(scanRoots);
    // SELL-362 / R2-B2: the assembled/built campaign output is the QA artifact.
    // Once the build has actually produced output and that output is
    // currency-clean, residual $ in the *source* HTML is the raw input the build
    // tokenized — not a live-page defect. Warn on the built output; downgrade
    // source-only residue to an info note so a correct build stops re-tripping
    // this warning. Guard on the target containing built HTML, not merely an
    // (empty) output directory existing — an empty target means the build has
    // not run yet, so source warnings must still stand.
    const targetScanRoot = scanRoots.find((scanRoot) => scanRoot.label === "target");
    const hasBuiltTarget = Boolean(targetScanRoot) && collectHtmlFiles(targetScanRoot.root).length > 0;
    const targetMatches = currencyMatches.filter((match) => match.surface === "target");
    const reportableMatches = hasBuiltTarget ? targetMatches : currencyMatches;
    if (!currencyMatches.length) {
      ready.push(`Hardcoded currency scan found no obvious static $ amounts (${currencyScope.reasons.join(", ")}).`);
    } else if (!reportableMatches.length) {
      ready.push(`Hardcoded currency scan: built output is currency-clean; ${currencyMatches.length} static $ amount(s) remain only in source HTML (raw input tokenized by build).`);
    } else {
      addIssue(
        warnings,
        "copy.hardcoded_currency_symbol",
        `Campaign currency scope needs copy review (${currencyScope.reasons.join(", ")}), and ${hasBuiltTarget ? "built campaign output" : "prepared HTML"} contains hardcoded $ amounts outside SDK-bound or skipped regions: ${summarizeCopyMatches(reportableMatches)}. Use SDK display tokens or remove static currency strings.`
      );
    }
  }

  if (storePhone) {
    const phoneMatches = collectHardcodedPhoneMatches(scanRoots, storePhone);
    if (!phoneMatches.length) {
      ready.push("Hardcoded phone scan found no mismatched static phone numbers.");
    } else {
      addIssue(
        warnings,
        "copy.hardcoded_phone",
        `Campaign Store Profile phone is "${storePhone}", but prepared HTML contains different hardcoded phone numbers outside skipped regions: ${summarizeCopyMatches(phoneMatches)}. Use the campaign.store_phone binding or remove static phone strings.`
      );
    }
  }
}

function deriveMarketScope(spec) {
  const campaign = spec?.campaign || {};
  const defaultCurrency = normalizeCurrency(campaign.currency);
  const currencies = [...new Set([
    ...normalizeCurrencyList(campaign.available_currencies),
    ...normalizeCurrencyList(campaign.additional_currencies),
    ...normalizeCurrencyList(campaign.additionalCurrencies),
  ])];
  const additionalCurrencies = currencies.filter((currency) => currency && currency !== defaultCurrency);
  const countries = campaign.available_shipping_countries;
  const countryList = Array.isArray(countries) ? countries.map((country) => String(country).trim()).filter(Boolean) : [];
  const nonUsCountries = countryList.filter((country) => !isUsCountryCode(country));
  const marketMode = String(campaign.market_mode || campaign.marketMode || campaign.market_scope || spec?.market_mode || "").trim();
  const reasons = [];

  if (additionalCurrencies.length) reasons.push(`additional currencies: ${additionalCurrencies.join(", ")}`);
  if (countries === "all") reasons.push("available_shipping_countries=all");
  if (nonUsCountries.length) reasons.push(`non-US shipping countries: ${nonUsCountries.join(", ")}`);
  if (/country|multi/i.test(marketMode)) reasons.push(`market mode: ${marketMode}`);

  return { needsCopyReview: reasons.length > 0, reasons };
}

function deriveCurrencyCopyScope(spec) {
  const campaign = spec?.campaign || {};
  const defaultCurrency = normalizeCurrency(campaign.currency);
  const currencies = [...new Set([
    ...normalizeCurrencyList(campaign.available_currencies),
    ...normalizeCurrencyList(campaign.additional_currencies),
    ...normalizeCurrencyList(campaign.additionalCurrencies),
  ])];
  const reasons = [];

  if (currencies.length > 1) reasons.push(`available currencies: ${currencies.join(", ")}`);
  if (defaultCurrency && defaultCurrency !== "USD") reasons.push(`default currency: ${defaultCurrency}`);

  return { needsCopyReview: reasons.length > 0, reasons };
}

function normalizeCurrency(value) {
  return isNonEmptyString(value) ? value.trim().toUpperCase() : "";
}

function normalizeCurrencyList(value) {
  if (Array.isArray(value)) return value.map(normalizeCurrency).filter(Boolean);
  if (isNonEmptyString(value)) return value.split(",").map(normalizeCurrency).filter(Boolean);
  return [];
}

function isUsCountryCode(value) {
  const country = String(value).trim().toUpperCase();
  return ["US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"].includes(country);
}

function collectMarketCopyMatches(scanRoots) {
  const matches = [];
  for (const { label: surface, root } of scanRoots) {
    for (const file of collectHtmlFiles(root)) {
      const content = maskMarketLintIgnoredRegions(readFileSync(join(root, file.path), "utf8"));
      for (const pattern of US_MARKET_COPY_PATTERNS) {
        const match = content.match(pattern.regex);
        if (match) {
          matches.push({
            surface,
            path: file.path,
            line: lineNumberAt(content, match.index || 0),
            label: pattern.label,
            text: match[0],
          });
        }
      }
    }
  }
  return matches;
}

function collectHardcodedCurrencyMatches(scanRoots) {
  const matches = [];
  for (const { label: surface, root } of scanRoots) {
    for (const file of collectHtmlFiles(root)) {
      const content = maskMarketLintIgnoredRegions(readFileSync(join(root, file.path), "utf8"));
      for (const match of content.matchAll(HARDCODED_CURRENCY_REGEX)) {
        matches.push({
          surface,
          path: file.path,
          line: lineNumberAt(content, match.index || 0),
          label: match[0].replace(/\s+/g, " ").trim(),
          text: match[0],
        });
      }
    }
  }
  return matches;
}

function collectHardcodedPhoneMatches(scanRoots, storePhone) {
  const expected = normalizePhoneNumber(storePhone);
  if (!expected) return [];

  const matches = [];
  for (const { label: surface, root } of scanRoots) {
    for (const file of collectHtmlFiles(root)) {
      const content = maskMarketLintIgnoredRegions(readFileSync(join(root, file.path), "utf8"));
      for (const match of content.matchAll(HARDCODED_PHONE_REGEX)) {
        const found = normalizePhoneNumber(match[0]);
        if (!found || found === expected) continue;
        matches.push({
          surface,
          path: file.path,
          line: lineNumberAt(content, match.index || 0),
          label: match[0].replace(/\s+/g, " ").trim(),
          text: match[0],
        });
      }
    }
  }
  return matches;
}

function maskMarketLintIgnoredRegions(content) {
  const ignoredElement =
    /<([A-Za-z][A-Za-z0-9:-]*)(?=[^>]*(?:data-next-display|data-next-bundle-display|data-skip-market-lint\s*=\s*["']true["']))[^>]*>[\s\S]*?<\/\1>/gi;
  const ignoredTag =
    /<[^>]*(?:data-next-display|data-next-bundle-display|data-skip-market-lint\s*=\s*["']true["'])[^>]*>/gi;

  return content
    .replace(ignoredElement, preserveNewlinesMask)
    .replace(ignoredTag, preserveNewlinesMask);
}

function preserveNewlinesMask(value) {
  return value.replace(/[^\n]/g, " ");
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split("\n").length;
}

function normalizePhoneNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function summarizeCopyMatches(matches) {
  const summary = matches
    .slice(0, 8)
    .map((match) => `${match.surface}:${match.path}:${match.line} "${match.label}"`)
    .join("; ");
  const more = matches.length > 8 ? `; plus ${matches.length - 8} more` : "";
  return `${summary}${more}`;
}

function validateCampaignsApiKey(packet, spec, warnings, ready) {
  const apiKey = resolveCampaignsApiKey(packet, spec, process.env);
  if (apiKey.present) {
    ready.push(`Campaigns API key available via ${apiKey.source}`);
    if (apiKey.warning) addIssue(warnings, "campaign.api_key_source", apiKey.warning);
    return;
  }

  addIssue(
    warnings,
    "campaign.api_key_source",
    apiKey.warning || "Campaigns API key was not found in the local CampaignSpec, packet, or declared env var. API-side package/shipping/offer confirmation is deferred."
  );
}

function resolveCampaignsApiKey(packet, spec, env) {
  const packetKey = firstNonEmptyString(
    packet?.campaign?.campaigns_api_key,
    packet?.campaign?.api_key
  );
  if (packetKey) {
    return {
      present: true,
      source: packet?.campaign?.campaigns_api_key ? "packet.campaign.campaigns_api_key" : "packet.campaign.api_key",
      warning: "Campaigns API key is stored directly in the Build Packet. This is allowed for local/public-client builds, but shared fixtures may prefer CampaignSpec or env sourcing.",
    };
  }

  const specKey = firstNonEmptyString(
    spec?.campaign?.campaigns_api_key,
    spec?.campaigns_api_key,
    spec?.campaign?.api_key
  );
  if (specKey) {
    return {
      present: true,
      source: spec?.campaign?.campaigns_api_key
        ? "CampaignSpec campaign.campaigns_api_key"
        : spec?.campaigns_api_key
          ? "CampaignSpec campaigns_api_key"
          : "CampaignSpec campaign.api_key",
    };
  }

  const source = packet?.campaign?.api_key_source;
  if (!isNonEmptyString(source)) {
    return {
      present: false,
      source: null,
      warning: "No Campaigns API key source is declared, and the local CampaignSpec does not include campaign.campaigns_api_key. API-side package/shipping/offer confirmation is deferred.",
    };
  }

  if (source.startsWith("env:")) {
    const envName = source.slice("env:".length).trim();
    return {
      present: isNonEmptyString(env?.[envName]),
      source,
      warning: isNonEmptyString(env?.[envName])
        ? null
        : `Environment variable ${envName} is not set, and the local CampaignSpec does not include campaign.campaigns_api_key. API-side package/shipping/offer confirmation is deferred.`,
    };
  }

  if (source === "provided-out-of-band") {
    return {
      present: false,
      source,
      warning: "API key source is declared out-of-band; doctor cannot confirm Campaigns API refs before build.",
    };
  }

  return {
    present: false,
    source,
    warning: `Unsupported API key source "${source}". Use CampaignSpec campaign.campaigns_api_key, packet campaign.campaigns_api_key, or env:<VAR>.`,
  };
}

function routeLabel(route) {
  return route === "" ? "entry route (empty page_url)" : route;
}

function validateSpecPublicRoutes(spec, errors, ready) {
  const pages = activeSpecPages(spec);
  const routeMap = new Map();
  let routeErrors = 0;

  for (const page of pages) {
    if (hasHtmlExtensionRoute(page.page_url)) {
      routeErrors += 1;
      addIssue(
        errors,
        "spec.page_url_html_extension",
        `Page "${page.label || page.id}" declares page_url "${page.page_url}". CampaignSpec page_url is a Page Kit public route, not a source filename; use "${normalizePageKitRoute(page.page_url) || "(entry route)"}" instead.`
      );
    }

    const route = publicRouteForPage(page);
    const prior = routeMap.get(route);
    if (prior) {
      routeErrors += 1;
      addIssue(
        errors,
        "spec.route_collision",
        `Pages "${prior.label || prior.id}" and "${page.label || page.id}" both resolve to ${routeLabel(route)}. Set distinct page_url values before assembly.`
      );
    } else {
      routeMap.set(route, page);
    }
  }

  if (pages.length > 0 && routeErrors === 0) ready.push("CampaignSpec public page routes are Page Kit-compatible");
}

function pageRole(type) {
  if (["checkout", "upsell", "downsell", "thankyou", "receipt", "select"].includes(type)) return "runtime";
  return "visual";
}

function summarizeScopePages(pages) {
  return pages.map((page) => `${page.type || "page"}:${page.page_id}`).join(", ");
}

/**
 * Build a context-aware error message for a CampaignSpec page that has no source mapping.
 * When `design_source` is set, point the operator at the producing pipeline so the missing
 * source HTML can be regenerated instead of leaving the operator guessing.
 *
 * Per docs/entry-points.md, today's recognized producers:
 *   - figma:        run figma-sections-export
 *   - ai-generated: re-run the producing agent (Claude/Codex/etc.)
 *   - hand-authored / template-stock: no design_source set; falls through to generic
 *
 * Future producers (Penpot, Sketch, plain Markdown converters, etc.) slot in by adding a
 * `design_source.type` value here. The fallback path emits a generic "produce the source
 * HTML for this page" message so unknown types don't crash the operator's UX.
 *
 * @param {object} page Active spec page (may carry `design_source`).
 * @returns {string}
 */
function coverageErrorMessage(page) {
  const designSource = page && isObject(page.design_source) ? page.design_source : null;
  if (designSource) {
    const fileUrl = optionalString(designSource.file_url);
    if (designSource.type === "figma" && fileUrl) {
      return `Active CampaignSpec page "${page.id}" has no source mapping. Design is in Figma at ${fileUrl}; run figma-sections-export (npm run handoff -- <slug>) to emit the source-html manifest, then rerun prepare-build.`;
    }
    if (designSource.type === "ai-generated") {
      const fileUrlHint = fileUrl ? ` (design reference: ${fileUrl})` : "";
      return `Active CampaignSpec page "${page.id}" has no source mapping. design_source.type="ai-generated"${fileUrlHint} — re-run the producing agent so the source HTML and source-html manifest land in the source root, then rerun prepare-build. See docs/entry-points.md for the AI-generated entry point contract.`;
    }
    if (!fileUrl) {
      return `Active CampaignSpec page "${page.id}" has no source mapping. design_source is set but file_url is missing — add file_url to the spec before requesting a build.`;
    }
    return `Active CampaignSpec page "${page.id}" has no source mapping. design_source.type="${designSource.type}" at ${fileUrl}; produce the source HTML for this page (or update design_source.type to a recognized producer — see docs/entry-points.md) before rerunning prepare-build.`;
  }
  return `Active CampaignSpec page "${page.id}" has no source mapping.`;
}

/**
 * Build the optional `detail` payload for a source-coverage error. Captures the design_source
 * pointer when present so downstream agents/UIs can render a clickable link without re-parsing
 * the message string.
 *
 * @param {object} page Active spec page.
 * @returns {object | null}
 */
function coverageErrorDetail(page) {
  const designSource = page && isObject(page.design_source) ? page.design_source : null;
  if (!designSource) return null;
  return {
    page_id: page.id,
    design_source: {
      type: designSource.type || null,
      file_url: optionalString(designSource.file_url) || null,
    },
  };
}

function validateSourceCoverage(packet, packetPath, spec, errors, warnings, ready, derived = {}) {
  const pages = packet.source_html?.pages || [];
  const sourceRoot = resolveFromFile(packetPath, packet.source_html?.root);
  validateSourceHtmlManifestAtRoot(sourceRoot, warnings, ready);
  const active = activeSpecPages(spec);
  const specPartialScope = spec?.build_scope?.mode === "partial";
  const specPartialReasons = Array.isArray(spec?.build_scope?.reasons) ? spec.build_scope.reasons.filter(isNonEmptyString) : [];
  const activeIds = new Set(active.map((page) => page.id));
  const mappedIds = new Set();
  const activeById = new Map(active.map((page) => [page.id, page]));
  const builtPages = [];
  const outOfScopePages = [];

  for (const page of pages) {
    if (!isNonEmptyString(page.page_id)) {
      addIssue(errors, "source_html.pages.page_id", "Every source page mapping needs page_id.");
      continue;
    }
    mappedIds.add(page.page_id);
    const specPage = activeById.get(page.page_id);
    if (!activeIds.has(page.page_id)) {
      addIssue(warnings, "source_html.pages.extra", `Source mapping "${page.page_id}" is not an active CampaignSpec page.`);
    }
    if (page.path) {
      const fullPath = resolve(sourceRoot, page.path);
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
        addIssue(errors, "source_html.pages.path", `Source page file does not exist: ${page.path}`);
      } else {
        // Slice 6: drift detection. When the packet carries a manifest-derived
        // source_hash for this page, compute the on-disk file's actual hash
        // and warn when they diverge. A mismatch means the file was edited
        // after the manifest was written, which is the signal that "design
        // handoff is stale" — operator should re-run the producer or accept
        // the local edits and regenerate the manifest.
        //
        // Silent when source_hash is absent (template-stock, hand-authored,
        // and producers that haven't adopted Slice 6 yet). Never an error —
        // drift is a warning so a build can still ship.
        const expectedHash = optionalString(page.source_hash);
        if (expectedHash) {
          const actualHash = sha256File(fullPath);
          if (actualHash !== expectedHash) {
            addIssue(
              warnings,
              "source_html.pages.source_hash",
              `Source page "${page.page_id}" hash mismatch — file at ${page.path} has changed since the manifest was written (manifest sha256=${expectedHash.slice(0, 12)}…, on-disk sha256=${actualHash.slice(0, 12)}…). Re-run the producer to refresh the manifest, or accept the local edits.`,
            );
          }
        }
        if (specPage) {
          builtPages.push({
            page_id: specPage.id,
            type: specPage.type || "page",
            role: pageRole(specPage.type),
            route: publicRouteForPage(specPage),
            source_path: page.path,
          });
        }
      }
    } else if (!page.skip_reason) {
      addIssue(errors, "source_html.pages.skip_reason", `Source mapping "${page.page_id}" needs path or skip_reason.`);
    } else {
      const skipped = specPage
        ? {
            page_id: specPage.id,
            type: specPage.type || "page",
            role: pageRole(specPage.type),
            route: publicRouteForPage(specPage),
            skip_reason: page.skip_reason,
          }
        : { page_id: page.page_id, type: "unknown", role: "unknown", route: null, skip_reason: page.skip_reason };
      outOfScopePages.push(skipped);
      addIssue(warnings, "source_html.pages.skip_reason", `CampaignSpec page "${page.page_id}" is out of scope for this partial build: ${page.skip_reason}`);
    }
  }

  for (const page of active) {
    if (!mappedIds.has(page.id)) {
      addIssue(errors, "source_html.pages.coverage", coverageErrorMessage(page), coverageErrorDetail(page));
    }
  }

  const runtimeBlocked = outOfScopePages.filter((page) => page.role === "runtime");
  derived.scope = {
    mode: outOfScopePages.length || specPartialScope ? "partial" : active.length ? "full" : "unknown",
    built_pages: builtPages,
    out_of_scope_pages: outOfScopePages,
    out_of_scope_reasons: specPartialReasons,
    previewable_routes: builtPages.map((page) => ({ page_id: page.page_id, type: page.type, route: page.route })),
    blocked_runtime_pages: runtimeBlocked,
  };

  if (outOfScopePages.length > 0 || specPartialScope) {
    const reasonSummary = specPartialReasons.length ? ` Reasons: ${specPartialReasons.join("; ")}.` : "";
    addIssue(
      warnings,
      "scope.partial_build",
      `Partial build scope detected. Built/previewable pages: ${summarizeScopePages(builtPages) || "none"}; out-of-scope pages: ${summarizeScopePages(outOfScopePages) || "declared in CampaignSpec build_scope"}.${reasonSummary}`
    );
    const buildScopeRuntimeBlocked = specPartialReasons.some((reason) => /\b(checkout|upsell|downsell|receipt|thankyou|runtime)\b/i.test(reason));
    if (runtimeBlocked.length > 0 || buildScopeRuntimeBlocked) {
      addIssue(
        warnings,
        "scope.runtime_qa_blocked",
        `Checkout/runtime launch QA is blocked for out-of-scope pages: ${summarizeScopePages(runtimeBlocked) || "declared in CampaignSpec build_scope"}. Preview QA should cover only the built routes.`
      );
    }
  }

  if (active.length > 0 && active.every((page) => mappedIds.has(page.id))) {
    ready.push(outOfScopePages.length > 0 || specPartialScope
      ? "Source mappings cover active CampaignSpec pages with explicit partial-scope skip reasons"
      : "Source mappings cover active CampaignSpec pages");
  }
  if (builtPages.length > 0) {
    ready.push(outOfScopePages.length > 0 || specPartialScope
      ? `Partial build previewable routes: ${builtPages.map((page) => routeLabel(page.route)).join(", ")}`
      : "All mapped CampaignSpec pages are build candidates");
  }
}

function validateSourceHtmlManifestAtRoot(sourceRoot, warnings, ready) {
  if (!isNonEmptyString(sourceRoot) || !existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) return;
  const result = readSourceHtmlManifestFile(sourceRoot);
  if (!result.path) return;
  if (result.validation && !result.validation.ok) {
    const detail = result.validation.errors.map((error) => `[${error.code}] ${error.message}`).join("; ");
    addIssue(warnings, "source_html.manifest", `Source-html manifest failed ${SOURCE_HTML_MANIFEST_SCHEMA} validation: ${detail}. Re-run or fix the producer before relying on manifest-derived page mappings.`);
    return;
  }
  if (result.warning) {
    addIssue(warnings, "source_html.manifest", result.warning);
    return;
  }
  ready.push(`Source-html manifest ${SOURCE_HTML_MANIFEST_SCHEMA} validated`);
}

// Helpers ported from the private build-packet doctor (ADR-003 step 2) so the
// shared-concern template-contract checks live here in the public doctor too.
function frontmatterList(contract, key) {
  const value = contract?.frontmatter?.[key];
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}
function contractMentions(contract, pattern, keys = ["requiredWhenCloning", "replaceFromSpecOrApi"]) {
  return keys.flatMap((key) => frontmatterList(contract, key)).some((value) => pattern.test(value));
}
function packageRefsFromEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => entry?.ref_id ?? entry?.package_ref_id ?? entry?.package_id ?? entry?.id)
    .filter((value) => value !== undefined && value !== null && String(value).trim().length > 0)
    .map((value) => String(value));
}
function offerRefsFromEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .flatMap((entry) => [entry?.package_ref_id, entry?.package_id, entry?.ref_id, entry?.code])
    .filter((value) => value !== undefined && value !== null && String(value).trim().length > 0)
    .map((value) => String(value));
}

export function validateCommerceCatalog(packet, packetPath, spec, errors, warnings, ready, derived = {}, buildState = {}) {
  const family = packet.assembly?.template_family;
  // Match the private doctor (build-packet.js): the ported template_contract.*
  // checks below do not apply to non-automatable families. The pre-existing
  // agentContract / demo_ref / shipping checks keep running for all families.
  const familyAutomatable = isNonEmptyString(family) && family !== "undecided" && family !== "custom";
  const catalogInfo = packet.assembly?.commerce_catalog || {};
  if (catalogInfo.required !== true) return;
  const catalogPath = resolveFromFile(packetPath, catalogInfo.path || "../contracts/commerce-surface-catalog.json");
  if (!catalogPath || !existsSync(catalogPath)) {
    addIssue(errors, "assembly.commerce_catalog.path", "Commerce catalog is required but not found.");
    return;
  }
  const catalog = readJson(catalogPath);
  if (familyAutomatable && catalog.agentContractVersion !== 1) {
    addIssue(warnings, "template_contract.catalog_version", "Commerce surface catalog agentContractVersion is not 1; verify contract semantics before build.");
  }
  if (!isObject(catalog.sharedFrontmatterVocabulary)) {
    addIssue(errors, "catalog.sharedFrontmatterVocabulary", "Commerce catalog is missing sharedFrontmatterVocabulary.");
  } else {
    ready.push("Commerce catalog sharedFrontmatterVocabulary loaded");
  }
  const contract = catalog.families?.[family]?.agentContract;
  if (!contract) {
    addIssue(errors, "template_contract.agentContract", `Template family "${family}" has no agentContract.`);
    return;
  }
  ready.push(`Template agentContract loaded for ${family}`);
  if (familyAutomatable && contract.status && contract.status !== "agent-ready") {
    addIssue(warnings, "template_contract.status", `Template family "${family}" contract status is "${contract.status}"; treat this as guided assembly, not full automation.`);
  }
  const assemblyComplete = isStageComplete(buildState.report, "assembly");
  if (assemblyComplete) {
    validateBuiltContractResidue(contract, warnings, ready, derived);
  } else {
    for (const value of contract.frontmatter?.demoOnlyValues || []) {
      addIssue(warnings, "frontmatter.demoOnlyValues", `Replace demo-only starter value before launch: ${value}`);
    }
    for (const value of contract.frontmatter?.replaceFromSpecOrApi || []) {
      addIssue(warnings, "frontmatter.replaceFromSpecOrApi", `Must be replaced from CampaignSpec/API: ${value}`);
    }
    for (const value of contract.frontmatter?.removeWhenUnsupported || []) {
      addIssue(warnings, "frontmatter.removeWhenUnsupported", `Remove when unsupported by target campaign: ${value}`);
    }
  }
  const consumesExplicitShipping = contractMentionsShipping(contract);
  if (family === "shop-three-step") {
    ready.push("shop-three-step uses dynamic shipping via window.next.getShippingMethods(); do not copy Olympus-style shipping_methods frontmatter into it.");
  }
  if (!consumesExplicitShipping) {
    validateUnsupportedShippingFrontmatter(packet, packetPath, family, warnings, ready, derived);
  } else if (spec && !Array.isArray(spec.shipping_methods)) {
    addIssue(errors, "template_contract.shipping_methods", `${family} contract references shipping_methods but CampaignSpec has no shipping_methods array.`);
  }
  if (spec) {
    const demoRefHits = collectDemoRefHits(spec, catalog.sharedFrontmatterVocabulary);
    for (const hit of demoRefHits) {
      addIssue(
        warnings,
        "template_contract.demo_ref",
        `CampaignSpec contains a starter-looking demo ref "${hit.value}" at ${hit.path}. Confirm it came from the actual Campaigns API or attach _provenance.api/source metadata.`
      );
    }

    // ADR-003 step 2: template-contract checks ported from the private doctor.
    const specPages = activeSpecPages(spec);

    const mismatchedFamilies = specPages.filter(
      (page) => isNonEmptyString(page.sdk_hints?.template_family) && page.sdk_hints.template_family !== family
    );
    if (familyAutomatable && mismatchedFamilies.length > 0) {
      addIssue(
        errors,
        "template_contract.spec_family",
        `CampaignSpec sdk_hints.template_family disagrees with packet template family on pages: ${mismatchedFamilies.map((page) => `${page.id}=${page.sdk_hints.template_family}`).join(", ")}.`
      );
    }

    const checkoutPackageRefs = specPages
      .filter((page) => page.type === "checkout" || page.type === "select")
      .flatMap((page) => packageRefsFromEntries(page.packages));
    if (familyAutomatable && contractMentions(contract, /\b(packages\.main_package|single_offer\.package_id|variant_slots)\b/) && checkoutPackageRefs.length === 0) {
      addIssue(
        errors,
        "template_contract.packages",
        `Template family "${family}" requires checkout package frontmatter, but the active CampaignSpec checkout/select pages have no package refs.`
      );
    }

    const upsellPages = specPages.filter((page) => page.type === "upsell" || page.type === "downsell");
    const upsellPackageRefs = upsellPages.flatMap((page) => [
      ...packageRefsFromEntries(page.packages),
      ...offerRefsFromEntries(page.offers),
    ]);
    if (
      familyAutomatable &&
      contractMentions(contract, /\b(upsell_offer|upsell_bundle_tiers|inline upsell)\b/, ["optionalWhenSupported", "replaceFromSpecOrApi", "demoOnlyValues"]) &&
      upsellPages.length > 0 &&
      upsellPackageRefs.length === 0
    ) {
      addIssue(
        errors,
        "template_contract.upsell_refs",
        `Template family "${family}" exposes upsell frontmatter, but active upsell/downsell pages have no package or offer refs to replace demo values.`
      );
    }
  }
}

function validateBuiltContractResidue(contract, warnings, ready, derived) {
  const targetOutputDir = derived.target_output_dir;
  if (!targetOutputDir || !existsSync(targetOutputDir) || !statSync(targetOutputDir).isDirectory()) {
    addIssue(warnings, "frontmatter.build_state", "Assembly is recorded complete, but doctor cannot scan the target output directory for remaining starter contract residue.");
    return;
  }

  const literalValues = [
    ...(contract.frontmatter?.demoOnlyValues || []),
    ...(contract.frontmatter?.removeWhenUnsupported || []),
  ].filter((value) => isNonEmptyString(String(value)) && !String(value).includes("."));
  const hits = collectLiteralMatches(targetOutputDir, literalValues);
  if (!hits.length) {
    ready.push("Built target output has no obvious demo-only or unsupported starter contract residue");
    return;
  }
  addIssue(
    warnings,
    "frontmatter.build_residue",
    `Assembly is recorded complete, but target output still contains starter contract residue: ${summarizeCopyMatches(hits)}.`
  );
}

function collectLiteralMatches(root, values) {
  if (!values.length) return [];
  const escaped = values.map((value) => escapeRegExp(String(value))).join("|");
  const regex = new RegExp(escaped, "g");
  const matches = [];
  for (const file of collectHtmlFiles(root)) {
    if (file.path.includes("_includes/") || file.path.includes("_layouts/")) continue;
    const content = readFileSync(join(root, file.path), "utf8");
    for (const match of content.matchAll(regex)) {
      matches.push({
        surface: "target",
        path: file.path,
        line: lineNumberAt(content, match.index || 0),
        label: match[0],
        text: match[0],
      });
    }
  }
  return matches;
}

function contractMentionsShipping(contract) {
  return Object.values(contract.frontmatter || {})
    .flatMap((value) => Array.isArray(value) ? value : [])
    .some((value) => String(value).includes("shipping_methods") || String(value).includes("shipping_method"));
}

function validateUnsupportedShippingFrontmatter(packet, packetPath, family, warnings, ready, derived) {
  const hits = collectShippingFrontmatterHits(packet, packetPath, derived);
  if (hits.length === 0) {
    ready.push(`${family} contract has no explicit shipping frontmatter residue in currently available mapped source/target pages`);
    return;
  }
  addIssue(
    warnings,
    "template_contract.shipping_unused",
    `${family} does not consume explicit shipping frontmatter, but mapped page frontmatter still declares ${summarizeShippingFrontmatterHits(hits)}. Remove copied shipping_methods/shipping_method values and let the family resolve shipping through its own SDK/runtime surface.`
  );
}

function collectShippingFrontmatterHits(packet, packetPath, derived = {}) {
  const hits = [];
  const seen = new Set();
  const addFile = (surface, root, relPath) => {
    if (!root || !relPath) return;
    const filePath = resolve(root, relPath);
    const key = `${surface}:${filePath}`;
    if (seen.has(key) || !existsSync(filePath) || !statSync(filePath).isFile()) return;
    seen.add(key);
    const frontmatter = extractYamlFrontmatter(readFileSync(filePath, "utf8"));
    if (!frontmatter) return;
    for (const hit of shippingFrontmatterKeys(frontmatter)) {
      hits.push({ surface, path: relFromDir(root, filePath), key: hit.key, line: hit.line });
    }
  };

  const sourceRoot = derived.source_root || resolveFromFile(packetPath, packet.source_html?.root);
  for (const page of packet.source_html?.pages || []) addFile("source", sourceRoot, page.path);

  const targetOutputDir = derived.target_output_dir;
  if (targetOutputDir && existsSync(targetOutputDir) && statSync(targetOutputDir).isDirectory()) {
    for (const file of collectHtmlFiles(targetOutputDir)) addFile("target", targetOutputDir, file.path);
  }

  return hits;
}

function extractYamlFrontmatter(content) {
  const match = String(content || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : "";
}

function shippingFrontmatterKeys(frontmatter) {
  const hits = [];
  const lines = String(frontmatter || "").split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(/^\s*(shipping_methods|shipping_method)\s*:/);
    if (match) hits.push({ key: match[1], line: index + 2 });
  });
  return hits;
}

function summarizeShippingFrontmatterHits(hits) {
  const limit = 4;
  const summary = hits.slice(0, limit).map((hit) => `${hit.surface}:${hit.path}:${hit.line} (${hit.key})`);
  const more = hits.length > limit ? ` and ${hits.length - limit} more` : "";
  return `${summary.join(", ")}${more}`;
}

export function collectDemoRefHits(spec, vocab) {
  const demoValues = new Set(
    Object.values(vocab || {})
      .flatMap((entry) => Array.isArray(entry.demoOnlyValues) ? entry.demoOnlyValues : [])
      .map((value) => String(value))
  );
  if (demoValues.size === 0) return [];
  // SELL-362 / R2-B1: a ref whose value matches a real commerce entity the
  // spec declares (package/offer/shipping_method) is legitimate, not a
  // starter placeholder. The Map exporter does not stamp `_provenance.api`
  // down to the ref level, so provenance alone was missing it and flagging
  // valid low-integer API refs (e.g. "1"/"2"). Suppressing declared refs
  // kills that noise while still flagging refs that point at nothing the
  // spec defines.
  const declaredRefs = specDeclaredCommerceRefs(spec);
  const hits = new Set();
  const results = [];
  const visit = (value, key = "", path = [], provenanceStack = []) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, key, [...path, String(index)], provenanceStack));
    } else if (isObject(value)) {
      const nextStack = [...provenanceStack, value._provenance].filter(Boolean);
      for (const [childKey, childValue] of Object.entries(value)) {
        if (childKey === "_provenance") continue;
        visit(childValue, childKey, [...path, childKey], nextStack);
      }
    } else if (["ref_id", "package_id", "package_ref_id", "shipping_method"].includes(key) && demoValues.has(String(value))) {
      const hitKey = `${path.join(".")}:${String(value)}`;
      if (!hits.has(hitKey) && !isApiSourcedProvenance(provenanceStack) && !declaredRefs.has(String(value))) {
        hits.add(hitKey);
        results.push({ value: String(value), path: path.join(".") || key });
      }
    }
  };
  visit(spec);
  return results;
}

function isApiSourcedProvenance(provenanceStack) {
  return provenanceStack.some((provenance) => {
    if (!isObject(provenance)) return false;
    if (provenance.api === true || provenance.api_sourced === true) return true;
    const source = String(provenance.source || provenance.origin || "").toLowerCase();
    return source.includes("api") || source.includes("campaigns");
  });
}

function isStageComplete(report, stage) {
  const status = report?.stages?.[stage]?.status;
  return isNonEmptyString(status) && status.startsWith("completed");
}

function validateContext(context, errors, warnings, ready, derived) {
  if (context.schema_version !== CONTEXT_SCHEMA) addIssue(warnings, "context.schema_version", `Context schema should be ${CONTEXT_SCHEMA}.`);
  else ready.push(`Build context schema ${CONTEXT_SCHEMA}`);
  if (context.source_adapter !== "html_funnel") {
    addIssue(warnings, "context.source_adapter", "Only html_funnel is supported in the current release.");
  }
  if (Array.isArray(context.prompts_required) && context.prompts_required.length > 0) {
    for (const prompt of context.prompts_required) {
      addIssue(warnings, `context.prompts_required.${prompt.code || "prompt"}`, prompt.message || "Context has unresolved prompts.");
    }
  }
  validateCommerceZoneFindings(context.commerce_zone_findings, warnings, ready);
  validateAdapterDecisionShape(context.adapter_decisions, "context.adapter_decisions", warnings, ready, { addIssue });
  if (context.scaffold?.required === true) {
    derived.scaffold_required = true;
    derived.scaffold_reason = context.scaffold.reason || "Build context says setup is required.";
  }
  const themeResult = validateThemeContextBlock(context.theme);
  for (const error of themeResult.errors) errors.push(error);
  for (const warning of themeResult.warnings) warnings.push(warning);
  ready.push(...themeResult.ready);
}

export function validateCommerceZoneFindings(findings, warnings, ready) {
  if (!Array.isArray(findings) || findings.length === 0) return;
  const shellRequired = findings.filter((finding) => finding?.requires_template_shell === true);
  if (shellRequired.length === 0) {
    ready.push("Source commerce zones inspected; no SDK-owned commerce shell placeholders declared");
    return;
  }
  for (const finding of shellRequired) {
    const zones = Array.isArray(finding.commerce_zones) && finding.commerce_zones.length
      ? finding.commerce_zones.join(", ")
      : finding.zones?.filter((zone) => zone !== "sdk_owned_declared").join(", ") || "commerce zone";
    addIssue(
      warnings,
      "source_html.commerce_shell_required",
      `Source page "${finding.path}" declares SDK-owned commerce zone(s): ${zones}. During build, adopt the selected starter-template family shell for these zones; do not wrap borrowed partials in a custom checkout/upsell structure. Browser QA will verify rendered commerce structure when the family contract declares it.`
    );
  }
}

function validateAssemblyReportShape(report, errors, warnings, ready) {
  const result = validateAssemblyReport(report);
  for (const error of result.errors) errors.push(error);
  for (const warning of result.warnings) warnings.push(warning);
  ready.push(...result.ready);
}

function validateAssemblyReport(report) {
  const errors = [];
  const warnings = [];
  const ready = [];
  if (!isObject(report)) {
    addIssue(errors, "report.type", "Assembly report must be a JSON object.");
    return { ok: false, status: "blocked", errors, warnings, ready };
  }
  if (report.schema_version !== REPORT_SCHEMA) addIssue(errors, "schema_version", `Expected ${REPORT_SCHEMA}.`);
  else ready.push(`Assembly report schema ${REPORT_SCHEMA}`);
  for (const path of ["run_id", "generated_at", "status", "identity.map_id", "identity.public_route_slug", "inputs.packet_path", "template_family.value"]) {
    requireString(report, errors, path);
  }
  const stages = report.stages;
  if (!isObject(stages)) {
    addIssue(errors, "stages", "stages object is required.");
  } else {
    for (const stage of ASSEMBLY_REPORT_STAGE_KEYS) {
      if (!isObject(stages[stage])) {
        addIssue(errors, `stages.${stage}`, `${stage} stage is required.`);
        continue;
      }
      requireString(report, errors, `stages.${stage}.status`);
      for (const field of ["inputs", "outputs", "commands", "blockers", "warnings"]) {
        if (stages[stage][field] !== undefined && !Array.isArray(stages[stage][field])) {
          addIssue(errors, `stages.${stage}.${field}`, `stages.${stage}.${field} must be an array.`);
        }
      }
    }
  }
  for (const field of ["decisions", "evidence", "blockers", "warnings"]) {
    if (!Array.isArray(report[field])) addIssue(errors, field, `${field} must be an array.`);
  }
  const themeResult = validateAssemblyReportThemeBlock(report.theme);
  for (const error of themeResult.errors) errors.push(error);
  for (const warning of themeResult.warnings) warnings.push(warning);
  ready.push(...themeResult.ready);
  validateAdapterDecisionShape(report.adapter_decisions, "report.adapter_decisions", warnings, ready, { addIssue });
  validateAssemblyProofPolicy(report.proof_policy, warnings, ready);
  const status = errors.length ? "blocked" : warnings.length ? "ready_with_warnings" : "ready";
  return { ok: errors.length === 0, status, errors, warnings, ready };
}

function validateAssemblyProofPolicy(policy, warnings, ready) {
  if (policy == null) {
    addIssue(warnings, "report.proof_policy", "report.proof_policy is missing. Assembly Reports should mirror qa.proof_policy so browser QA, typed-card depth, SDK origin allowlist state, order path depth, and approval state are inspectable.");
    return;
  }
  validateProofPolicyObject(policy, "report.proof_policy", warnings, ready);
}

// The orchestration stage contract lives in orchestration-stage-contract.mjs so
// report producers, validators, and the `next` picker share one deterministic
// source for stage order and CLI-stage/report-key translation.
/**
 * Status values that count as terminal under PREFIX matching — so
 * "completed", "completed_with_warnings", and "completed_partial" all
 * count as terminal under "completed". This matches how the existing
 * stages already report sub-statuses (see report.stages.assembly.status
 * shapes in src/cli.mjs and qa/shared/qa-verdict.js). Renamed from
 * STAGE_TERMINAL_STATUSES to make the prefix-matching contract explicit.
 */
const STAGE_TERMINAL_STATUS_PREFIXES = Object.freeze(["completed", "skipped"]);
const STAGE_BLOCKED_STATUSES = Object.freeze(new Set(["blocked"]));

/**
 * Predicate: is a polish status acceptable as a handoff into a downstream
 * stage (deploy, qa)? Polish must be terminal (completed, completed_* via
 * prefix matching, or skipped). A blocked polish record is useful evidence,
 * but it is not a deploy/QA handoff; unblock or explicitly skip it first.
 *
 * Centralized so deploy and qa stages share one source of truth. Previously
 * the qa check listed "completed_with_warnings" explicitly (redundant with
 * the prefix-match on "completed") while the deploy check omitted it,
 * leaving the appearance of drift even though both behaved the same.
 */
function polishHandoffReady(polishStatus) {
  const status = String(polishStatus || "");
  return STAGE_TERMINAL_STATUS_PREFIXES.some((t) => status.startsWith(t));
}

function stageIsTerminal(status) {
  const normalized = String(status || "");
  return STAGE_TERMINAL_STATUS_PREFIXES.some((t) => normalized.startsWith(t));
}

function reportStageBlockerIssues(reportStage, fallbackCode, fallbackMessage) {
  const blockers = Array.isArray(reportStage?.blockers) ? reportStage.blockers : [];
  if (!blockers.length) return [{ code: fallbackCode, message: fallbackMessage }];
  return blockers.map((blocker) => ({
    code: blocker.code || fallbackCode,
    message: blocker.message || fallbackMessage,
    detail: blocker,
  }));
}

function prepareBuildGateIssue(report) {
  const stage = report?.stages?.prepare_build;
  if (!stage) return null;
  const status = String(stage.status || "");
  if (stageIsTerminal(status)) return null;
  return {
    stage,
    status,
    blocked: STAGE_BLOCKED_STATUSES.has(status),
    reason: STAGE_BLOCKED_STATUSES.has(status)
      ? `Stage "prepare_build" is blocked (status="${status}"); resolve prepare-build blockers before continuing.`
      : `Stage "prepare_build" has status "${status || "(unset)"}"; rerun prepare-build before continuing.`,
  };
}

function addPrepareBuildGateErrors(errors, report) {
  const gate = prepareBuildGateIssue(report);
  if (!gate) return false;
  for (const issue of reportStageBlockerIssues(
    gate.stage,
    "next.prepare_build",
    gate.reason,
  )) {
    addIssue(errors, issue.code, issue.message, issue.detail || null);
  }
  return true;
}

/**
 * Self-decide which stage should run next given the current report + doctor
 * state. Pure function — reads no filesystem, no network.
 *
 * @param {object|null} report  Assembly report (may be null when doctor
 *                              failed before the report was written).
 * @param {object|null} doctor  Doctor result. When `doctor.ok === false`,
 *                              short-circuits with "doctor-blocked" so the
 *                              caller surfaces the doctor errors instead
 *                              of advancing the pipeline. This is an
 *                              intentional early-exit: any future
 *                              stage-specific doctor signal logic should
 *                              live AFTER this gate, not before.
 *
 * @returns {{ stage: string, reason: string, blocked?: boolean }}
 *   An object with four possible shapes:
 *
 *   1. `{ stage: "doctor-blocked", reason }` — doctor reported errors.
 *      No `blocked` field. Caller should surface the doctor errors.
 *   2. `{ stage: "prepare-build", reason, blocked: true }` —
 *      prepare-build has not reached a terminal status. Caller should
 *      surface the report blockers and ask the operator to rerun
 *      prepare-build/start before continuing.
 *   3. `{ stage: "<setup|build|polish|deploy|qa>", reason, blocked? }`
 *      — next stage to run. `blocked: true` is present and `true` when
 *      the returned stage's recorded status in the report is "blocked"
 *      (per STAGE_BLOCKED_STATUSES). The picker still returns the stage
 *      (rather than treating it as done) so the orchestrator surfaces
 *      the blocker rather than silently skipping past it. When
 *      `blocked` is absent or `false`, the stage is in its normal
 *      ready-to-run state.
 *   4. `{ stage: "done", reason }` — every stage in terminal status.
 *      No `blocked` field.
 *
 *   `reason` is a human-readable string describing why this stage was
 *   chosen, intended for direct display in CLI / JSON output so the
 *   operator can audit picker decisions.
 *
 *   CONSUMERS: always check `result.stage` first (special values
 *   "doctor-blocked" and "done" need their own handling), then read
 *   `result.blocked === true` to detect the surfaced-blocker case.
 */
function pickNextStage(report, doctor) {
  // Intentional early-exit on doctor failure: skip the rest of the
  // picker so the caller surfaces doctor errors as the primary signal
  // instead of advancing the pipeline. If future stage-specific doctor
  // signal logic needs to run (e.g. consulting doctor.derived for
  // specific stages), add it AFTER this gate, not before.
  if (doctor && !doctor.ok) {
    return {
      stage: "doctor-blocked",
      reason: `Doctor reported ${doctor.errors?.length || 0} blocker(s); resolve them before any stage runs.`,
    };
  }

  if (!report || !report.stages) {
    return {
      stage: "setup",
      reason: "No assembly report on disk yet. Start with setup (assembly report should appear after prepare-build).",
    };
  }

  const prepareBuildGate = prepareBuildGateIssue(report);
  if (prepareBuildGate) {
    return {
      stage: "prepare-build",
      reason: prepareBuildGate.reason,
      blocked: true,
    };
  }

  for (const cliStage of NEXT_STAGE_ORDER) {
    const reportKey = reportKeyForCliStage(cliStage);
    const stage = report.stages[reportKey];
    if (!stage) {
      return {
        stage: cliStage,
        reason: `Stage "${reportKey}" is not recorded in the assembly report; run "${cliStage}" next.`,
      };
    }
    const status = String(stage.status || "");
    if (STAGE_BLOCKED_STATUSES.has(status)) {
      return {
        stage: cliStage,
        reason: `Stage "${reportKey}" is blocked (status="${status}"); unblock before continuing.`,
        blocked: true,
      };
    }
    // Match by prefix so "completed_with_warnings" and future suffixes
    // (e.g. "completed_partial") count as terminal.
    const isTerminal = STAGE_TERMINAL_STATUS_PREFIXES.some((t) => status.startsWith(t));
    if (!isTerminal) {
      return {
        stage: cliStage,
        reason: `Stage "${reportKey}" has status "${status || "(unset)"}"; run "${cliStage}" next.`,
      };
    }
  }

  return {
    stage: "done",
    reason: "All stages are in a terminal status (completed / completed_with_warnings / skipped). Pipeline is complete.",
  };
}

function nextStage(stage, args) {
  const packetPath = resolve(requireArg(args, "packet"));
  const packet = readJson(packetPath);
  const targetRepo = resolveFromFile(packetPath, packet.assembly?.target_repo) || dirname(packetPath);
  const contextPath = args.context ? resolve(args.context) : join(targetRepo, ".campaign-runtime/build-context.json");
  const reportPath = args.report ? resolve(args.report) : join(targetRepo, ".campaign-runtime/assembly-report.json");
  const report = readJsonIfExists(reportPath);
  const doctor = doctorPacket(packetPath, {
    contextPath: existsSync(contextPath) ? contextPath : null,
    reportPath: report ? reportPath : null,
  });
  const errors = [];
  const warnings = [...doctor.warnings];
  const ready = [...doctor.ready];
  if (!doctor.ok) errors.push(...doctor.errors);

  // Slice 3 Phase 2: when no stage was passed, self-decide. The orchestration
  // loop is: agent calls `next`, gets a stage + prompt, does the work,
  // updates the assembly report's stages.<name>.status, then calls `next`
  // again. Each call re-reads state from disk so the loop is idempotent
  // and recoverable across sessions / machines.
  let picked = null;
  if (!stage) {
    picked = pickNextStage(report, doctor);
    if (picked.stage === "doctor-blocked") {
      return {
        ok: false,
        status: "blocked",
        stage: "doctor-blocked",
        reason: picked.reason,
        errors,
        warnings,
        ready,
        prompt: "Resolve the doctor errors above before continuing. Re-run `campaigns-os doctor --packet <path>` to confirm, then `campaigns-os next --packet <path>` to advance.",
      };
    }
    if (picked.stage === "prepare-build") {
      addPrepareBuildGateErrors(errors, report);
      return {
        ok: false,
        status: "blocked",
        stage: "prepare-build",
        reason: picked.reason,
        errors,
        warnings,
        ready,
        prompt: "Resolve the prepare-build blockers recorded in the assembly report, then rerun `campaigns-os prepare-build` or `campaigns-os start` before continuing.",
        stage_blocked: true,
      };
    }
    if (picked.stage === "done") {
      return {
        ok: true,
        status: "ready",
        stage: "done",
        reason: picked.reason,
        errors,
        warnings,
        ready,
        prompt: "Pipeline complete. All stages in the assembly report are in a terminal status. If you need to re-run a stage, set its status back to \"pending\" in the report and call `next` again.",
      };
    }
    stage = picked.stage;
  }

  let prompt = "";
  if (stage === "setup") {
    addPrepareBuildGateErrors(errors, report);
    if (!doctor.ok) addIssue(errors, "next.setup.doctor", "Doctor is blocked; resolve packet errors before setup.");
    prompt = setupPrompt(packetPath, contextPath, reportPath, packet);
  } else if (stage === "build") {
    addPrepareBuildGateErrors(errors, report);
    if (!doctor.ok) addIssue(errors, "next.build.doctor", "Doctor is blocked; resolve packet errors before build.");
    if (doctor.derived?.scaffold_required) addIssue(errors, "next.build.setup", doctor.derived.scaffold_reason || "Setup is required before build.");
    prompt = buildPrompt(packetPath, contextPath, reportPath, packet);
  } else if (stage === "polish") {
    addPrepareBuildGateErrors(errors, report);
    if (!report) addIssue(errors, "next.polish.report", "Assembly report is required before polish.");
    const assemblyStatus = report?.stages?.assembly?.status || "";
    if (!assemblyStatus.startsWith("completed")) addIssue(errors, "next.polish.assembly", `Assembly status is "${assemblyStatus || "missing"}"; polish expects completed assembly or an explicit blocked/skipped handoff.`);
    prompt = polishPrompt(packetPath, reportPath, packet);
  } else if (stage === "deploy") {
    addPrepareBuildGateErrors(errors, report);
    // Slice 3 Phase 2: deploy is an out-of-band step (Netlify / CF Pages /
    // etc.) but it's still a stage in the orchestration loop because the
    // agent needs to know when to fire it and what to record afterwards.
    if (!report) addIssue(errors, "next.deploy.report", "Assembly report is required before deploy.");
    if (!polishHandoffReady(report?.stages?.polish?.status)) {
      addIssue(errors, "next.deploy.polish", `Polish status is "${report?.stages?.polish?.status || "missing"}"; record completed/skipped before deploy, or resolve a blocked polish stage first.`);
    }
    prompt = deployPrompt(packetPath, reportPath, packet);
  } else if (stage === "qa") {
    addPrepareBuildGateErrors(errors, report);
    if (!report) addIssue(errors, "next.qa.report", "Assembly report is required before QA.");
    const deployUrl = packet.deploy?.preview_url || packet.deploy?.production_url;
    if (!deployUrl) addIssue(errors, "next.qa.deploy_url", "QA requires deploy.preview_url or deploy.production_url.");
    if (!polishHandoffReady(report?.stages?.polish?.status)) {
      addIssue(errors, "next.qa.polish", `Polish status is "${report?.stages?.polish?.status || "missing"}"; record completed/skipped before QA, or resolve a blocked polish stage first.`);
    }
    prompt = qaPrompt(packetPath, reportPath, packet);
  } else {
    throw new Error(`Unknown next stage: ${stage}`);
  }
  const status = errors.length ? "blocked" : warnings.length ? "ready_with_warnings" : "ready";
  const result = {
    ok: errors.length === 0,
    status,
    stage,
    errors,
    warnings,
    ready,
    prompt,
  };
  // When the caller invoked `next` with no stage, surface the picker's
  // reasoning so the agent / operator can see WHY this stage was chosen
  // (vs them having to re-derive it from report state themselves).
  if (picked) {
    result.picked_reason = picked.reason;
    if (picked.blocked) result.stage_blocked = true;
  }
  return result;
}

function buildPrompt(packetPath, contextPath, reportPath, packet) {
  return `Use next-campaigns-build for this Campaigns OS handoff.

Read first:
- Build Packet: ${packetPath}
- Build Context: ${contextPath || "(use packet-adjacent .campaign-runtime/build-context.json if present)"}
- Assembly Report: ${reportPath || "(use packet-adjacent .campaign-runtime/assembly-report.json if present)"}
- Template family: ${packet.assembly.template_family}

Rules:
- Treat CampaignSpec/API as the source for package, shipping, voucher, payment, tracking, footer, and SEO values.
- Read the selected template family's agentContract and sharedFrontmatterVocabulary before commerce wiring.
- Prepared AI/exported HTML must be converted into page-kit-ready source first: keep page-owned body markup, strip document wrappers, add YAML frontmatter, move shared CSS/assets into the campaign structure, and use Liquid helpers only for page-kit links/assets/includes. Page Kit publishes src/<slug>/assets/config.js as /<slug>/config.js and src/<slug>/assets/products/foo.png as /<slug>/products/foo.png; do not leave raw /assets/... or /<slug>/assets/... references in rendered pages.
- Preserve prepared source HTML for landing/presell pages when it is a real standalone design.
- For checkout/upsell/downsell/receipt, use the starter template as the SDK contract reference only: preserve required data-next controls and runtime wiring, but let the campaign/source own visual chrome, copy hierarchy, imagery, and brand layer.
- Read context.theme and .campaign-runtime/theme/theme-report.json when present. If a fresh brand-theme.css exists, copy it into the campaign assets/css folder and list it after next-core.css in checkout/upsell/downsell/receipt frontmatter styles; if policy is inspect_only, generate or skip explicitly before applying a new brand layer.
- Generated brand-theme.css v0 is root-variable-only. Do not edit SDK-owned selectors, package controls, payment fields, totals, submit controls, receipt templates, route meta tags, or SDK JavaScript as part of theme application.
- If you copy starter-template files, copy the selected family atomically with dependent pages, _includes, _layouts, assets/css, and assets/js; do not copy only checkout.html and receipt.html.
- Resolve SDK routing meta tags to campaign-root paths such as /${packet.campaign.public_route_slug}/upsell/, not source filenames or unrooted spec literals.
- For one-time prepurchase/order-bump packages outside the main bundles, default package_sync=false and show_line_total_price=false unless the spec explicitly requires quantity sync.
- Record spec-driven removals, especially unsupported payment methods, so polish does not reintroduce them.
- Replace demo refs; do not copy Olympus-style shipping_methods into shop-three-step.
- For two-step package-selection flows, treat the selector page as the pre-checkout step and pass the selected cart to checkout with forcePackageId; preserve normal tracking params and strip forcePackageId from visible checkout URLs after SDK initialization.
- After page-kit build, inspect rendered _site output before handoff: each active page should have a body, Campaign Cart runtime markers, SDK meta tags from CampaignSpec sdk_hints.meta_tags, and no stale copied funnel attribution.
- Run page-kit build and SDK/template lint, then update the assembly report before polish. If you applied a brand theme, record report.theme.status, css_path, commerce_pages, load_order=after-next-core, evidence, and any repair-loop defect.`;
}

function setupPrompt(packetPath, contextPath, reportPath, packet) {
  return `Use next-campaigns-setup for this Campaigns OS handoff.

Read first:
- Build Packet: ${packetPath}
- Build Context: ${contextPath}
- Assembly Report: ${reportPath}
- Target repo: ${packet.assembly.target_repo}
- Output dir: ${packet.assembly.output_dir}

Prepare the target page-kit structure and agent context, then update setup status in both:
- .campaign-runtime/build-context.json scaffold.required/scaffold.mode/handoff fields
- .campaign-runtime/assembly-report.json stages.setup

When copying a starter template family, copy the family as an atomic page-kit slice: pages plus required _includes, _layouts, assets/css, and assets/js. Do not copy only checkout.html and receipt.html.

Do not wire checkout, upsell, receipt, payment, package, voucher, or shipping behavior during setup.`;
}

function polishPrompt(packetPath, reportPath, packet) {
  return `Use next-campaigns-polish for this built campaign.

Read first:
- Build Packet: ${packetPath}
- Assembly Report: ${reportPath}
- Template family: ${packet.assembly.template_family}

Compare source against built page-kit output, patch only SDK-safe visual surfaces, scan source assets for logo/brand marks before leaving starter-template logos, respect spec-driven removals recorded during build, capture desktop/mobile evidence, and record polish as completed, skipped, or blocked before QA.

If report.theme/context.theme exists, verify source token parity for primary color, CTA, surface, text, font/radius when present, and verify brand-theme.css loads after next-core.css on commerce pages. If the brand layer is missing, stale, low-confidence, or unsafe to apply, record the first repair-loop defect or an explicit skipped reason.`;
}

function deployPrompt(packetPath, reportPath, packet) {
  const target = packet.deploy?.target || "unknown";
  const liveUrlPath = packet.deploy?.live_url_path || packet.campaign?.live_url_path || `/${packet.campaign?.public_route_slug || "<slug>"}/`;
  return `Deploy the built campaign to ${target}.

Read first:
- Build Packet: ${packetPath}
- Assembly Report: ${reportPath}
- Expected live URL path: ${liveUrlPath}
- Deploy target: ${target}

Deploy is currently an out-of-band step: the page-kit build produces _site/ output; you (or your CI) ship it to ${target}. Use the deploy target's normal tooling (netlify deploy, wrangler pages deploy, vercel deploy, etc.).

After deploy succeeds:
1. Record the resulting URL on the packet at deploy.preview_url (preview deploys) or deploy.production_url (production).
2. Update the assembly report's stages.deploy.status to "completed" with the URL and any relevant notes in outputs.
3. Verify the SDK initialises on the tested origin. Localhost on any port is globally available as a Campaigns App Development domain (analytics suppressed). Non-localhost preview/production hosts must be in the Campaigns App SDK origin allowlist before QA.
4. Run \`campaigns-os next --packet ${packetPath}\` to advance to QA.

If the deploy is blocked (non-localhost allowed-domain not yet added, CI permission missing, host-side outage), set stages.deploy.status to "blocked" with a clear reason in outputs so the orchestration loop surfaces it rather than skipping past.`;
}

function qaPrompt(packetPath, reportPath, packet) {
  const url = packet.deploy?.preview_url || packet.deploy?.production_url || "<preview-url>";
  return `Use next-campaigns-qa for this deployed campaign.

Map ID: ${packet.spec.map_id}
Base URL: ${url}
Build Packet: ${packetPath}
Assembly Report: ${reportPath}
Browser install command:
npm run qa:install-browser

Node QA command:
campaigns-os qa run --packet ${packetPath} --base-url ${url} --browser --test-order common

Run the browser install once after install/update before --browser or --test-order. Test-order proof must exercise the campaign through the Campaign Cart SDK with the browser typed-card flow. Do not create hand-built backend API orders as launch proof. Test Orders use global test cards that bypass the payment gateway and create no transactions, so they are safe to run any time and need no permission flags, packet policy, or merchant setup. Localhost on any port is a globally allowed Development domain for SDK initialization and suppresses Campaigns analytics events; non-localhost preview/production origins still need the SDK origin allowlist. Use --test-order common for the default 3-5 shape sample (checkout, plus accept/decline when there are upsells), an explicit path such as accept-decline-accept for a targeted matrix, or --test-order full for every permutation; then click rendered SDK upsell accept/decline controls for upsell proof. Reuse one test customer email via --test-email or CAMPAIGNS_OS_QA_TEST_EMAIL (a real monitored inbox in internal runs) so repeated QA does not litter the customer list.

Launch readiness note: Campaigns OS can prove the campaign build, SDK wiring, browser behavior, and typed-card order paths. It does not prove the merchant is ready for real shoppers. Before launch, confirm the production storefront URL, live payment methods, shipping markets, legal/support URLs, analytics expectations, and any merchant-side configuration. Treat those as real-shopper readiness items, not Campaigns OS build blockers.

For multi-market campaigns, verify at least one non-default currency/country path: currency display, shipping method names/prices, payment methods, and market-specific copy. Summarize blockers, warnings, and remaining launch risks.`;
}

function buildNextStep(errors, warnings, derived, report = null) {
  const codes = new Set([...errors, ...warnings].map((issue) => issue.code));
  const assemblyStatus = report?.stages?.assembly?.status || "";
  const polishStatus = report?.stages?.polish?.status || "";
  const deployStatus = report?.stages?.deploy?.status || "";
  const qaStatus = report?.stages?.qa?.status || "";
  const assemblyComplete = assemblyStatus.startsWith("completed");
  const polishRecorded = ["completed", "completed_with_warnings", "skipped", "blocked"].some((prefix) => polishStatus.startsWith(prefix));
  const polishBlocked = polishStatus.startsWith("blocked");
  const polishSatisfied = ["completed", "completed_with_warnings", "skipped"].some((prefix) => polishStatus.startsWith(prefix));
  const deploySatisfied = ["completed", "completed_with_warnings", "ready_with_exceptions"].some((prefix) => deployStatus.startsWith(prefix))
    || (report?.stages?.deploy?.outputs || []).some((output) => /^https?:\/\//.test(String(output)));
  const qaRecorded = ["completed", "completed_with_warnings", "ready_with_exceptions"].some((prefix) => qaStatus.startsWith(prefix));
  const blockedStages = [];
  const actions = [];
  if (errors.length) {
    actions.push("Resolve packet blockers before assembly.");
  }
  if (codes.has("deploy.preview_url") && !deploySatisfied) blockedStages.push("qa");
  if (codes.has("scope.runtime_qa_blocked")) {
    blockedStages.push("checkout-launch-ready");
    blockedStages.push("test-orders");
  }
  if (codes.has("campaign.allowed_domains_confirmed")) blockedStages.push("runtime-sdk-verification");
  if (codes.has("assembly.template_lock")) actions.push("Lock a template family before commerce wiring.");
  if (codes.has("spec.page_url_html_extension")) {
    actions.push("Update CampaignSpec page_url values to Page Kit public routes such as landing/ or checkout/, not source filenames like landing.html.");
  }
  if (codes.has("spec.route_collision")) {
    actions.push("Fix Campaign Map page_url values so every active page resolves to a unique Page Kit route.");
  }
  if (codes.has("frontmatter.demoOnlyValues") || codes.has("frontmatter.replaceFromSpecOrApi")) {
    actions.push("Use the template agentContract to replace demo values from CampaignSpec/API.");
  }
  if (codes.has("scope.partial_build")) {
    actions.push("Build and deploy only the mapped partial-scope pages; label the preview as route/visual-testable, not full-funnel launch-ready.");
  }
  if (codes.has("scope.runtime_qa_blocked")) {
    actions.push("Keep checkout/order-proof QA blocked until the out-of-scope runtime pages are built or explicitly delegated to an existing downstream URL.");
  }

  if (assemblyComplete && !polishRecorded) {
    blockedStages.push("deploy");
    blockedStages.push("qa");
    actions.push("Run next-campaigns-polish and record polish as completed, skipped, or blocked before deploy/QA handoff.");
  }
  if (assemblyComplete && polishBlocked) {
    blockedStages.push("deploy");
    blockedStages.push("qa");
    actions.push("Resolve the recorded polish blockers, then rerun polish before deploy/QA handoff.");
  }

  if (errors.length) {
    return {
      stage: "collect-inputs",
      status: "blocked",
      owner: "operator",
      default_skill: "next-campaigns-os",
      actions,
      blocked_stages: ["assembly", "polish", "deploy", "qa"],
    };
  }
  if (assemblyComplete && !polishRecorded) {
    return {
      stage: "polish",
      status: warnings.length ? "ready_with_warnings" : "ready",
      owner: "polish",
      default_skill: "next-campaigns-polish",
      command: `campaigns-os next polish --packet ${derived.packet_path}`,
      actions,
      blocked_stages: [...new Set(blockedStages)],
    };
  }
  if (assemblyComplete && polishBlocked) {
    return {
      stage: "polish",
      status: "blocked",
      owner: "polish",
      default_skill: "next-campaigns-polish",
      command: `campaigns-os next polish --packet ${derived.packet_path}`,
      actions,
      blocked_stages: [...new Set(blockedStages)],
    };
  }
  if (assemblyComplete && polishSatisfied) {
    const needsDeploy = codes.has("deploy.preview_url") && !deploySatisfied;
    if (!needsDeploy && qaRecorded) {
      return {
        stage: blockedStages.includes("test-orders") ? "test-orders" : "complete",
        status: blockedStages.includes("test-orders") ? "blocked" : (warnings.length ? "ready_with_warnings" : "ready"),
        owner: blockedStages.includes("test-orders") ? "operator" : "qa",
        default_skill: blockedStages.includes("test-orders") ? "next-campaigns-qa" : "next-campaigns-os",
        command: blockedStages.includes("test-orders")
          ? `campaigns-os next qa --packet ${derived.packet_path} --test-order common`
          : undefined,
        actions: actions.length
          ? actions
          : blockedStages.includes("test-orders")
            ? ["Out-of-scope runtime pages block checkout/order proof. Build or delegate those pages first; test orders themselves need no permission (test cards bypass the gateway)."]
            : ["Campaign assembly, polish, deploy, and QA checkpoints are recorded."],
        blocked_stages: [...new Set(blockedStages)],
      };
    }
    return {
      stage: needsDeploy ? "deploy" : "qa",
      status: warnings.length ? "ready_with_warnings" : "ready",
      owner: needsDeploy ? "operator" : "qa",
      default_skill: needsDeploy ? "next-campaigns-os" : "next-campaigns-qa",
      command: needsDeploy
        ? `Create a deploy preview for packet ${derived.packet_path}`
        : `campaigns-os next qa --packet ${derived.packet_path}`,
      actions: actions.length
        ? actions
        : needsDeploy
          ? ["Create a preview or production URL, then run QA resolve before posting a verdict."]
          : ["Run next-campaigns-qa against the deployed campaign URL."],
      blocked_stages: [...new Set(blockedStages)],
    };
  }
  return {
    stage: derived.scaffold_required ? "setup" : "assembly",
    status: warnings.length ? "ready_with_warnings" : "ready",
    owner: derived.scaffold_required ? "setup" : "build",
    default_skill: derived.scaffold_required ? "next-campaigns-setup" : "next-campaigns-build",
    command: `campaigns-os next ${derived.scaffold_required ? "setup" : "build"} --packet ${derived.packet_path}`,
    actions: actions.length ? actions : [
      derived.scaffold_required
        ? "Run next-campaigns-setup, then next-campaigns-build, polish, deploy, and QA."
        : "Run next-campaigns-build, then polish, deploy, and QA.",
    ],
    blocked_stages: [...new Set(blockedStages)],
  };
}

function installAgentContext(targetRepo, dryRun = false) {
  const outDir = resolve(targetRepo, ".campaign-runtime/agent-context");
  const files = [
    ["CLAUDE.md", join(ROOT, "agents/claude/CLAUDE.md")],
    ["AGENTS.md", join(ROOT, "agents/codex/AGENTS.md")],
    ["campaigns-os.mdc", join(ROOT, "agents/cursor/campaigns-os.mdc")],
    ["copilot-instructions.md", join(ROOT, "agents/copilot/copilot-instructions.md")],
  ];
  const written = [];
  if (!dryRun) mkdirSync(outDir, { recursive: true });
  for (const [name, source] of files) {
    const dest = join(outDir, name);
    if (!dryRun) writeFileSync(dest, readFileSync(source, "utf8"));
    written.push(dest);
  }
  return {
    ok: true,
    status: dryRun ? "dry_run" : "installed",
    target_repo: targetRepo,
    directory: outDir,
    files: written,
    note: "Context files are staged under .campaign-runtime/agent-context and do not overwrite root agent files.",
  };
}

const SKILL_PLATFORMS = [
  {
    id: "claude",
    label: "Claude Code",
    target: () => join(homedir(), ".claude", "skills"),
  },
  {
    id: "codex",
    label: "Codex",
    target: () => join(homedir(), ".codex", "skills"),
  },
  {
    id: "agents",
    label: "Shared agent skills",
    target: () => join(homedir(), ".agents", "skills"),
  },
];

function skillPlatformHelp() {
  return SKILL_PLATFORMS.map((platform) => platform.id).concat("all").join(", ");
}

function resolveSkillInstallTargets(targetArg = null, platformArg = null) {
  if (isNonEmptyString(targetArg)) {
    return [{
      platform: "custom",
      platform_label: "Custom target",
      target_directory: resolve(targetArg),
    }];
  }

  const requested = String(platformArg || "claude").trim().toLowerCase();
  const selected = requested === "all"
    ? SKILL_PLATFORMS
    : SKILL_PLATFORMS.filter((platform) => platform.id === requested);

  if (!selected.length) {
    throw new Error(`Unknown --platform ${requested}. Use one of: ${skillPlatformHelp()}.`);
  }

  return selected.map((platform) => ({
    platform: platform.id,
    platform_label: platform.label,
    target_directory: platform.target(),
  }));
}

function installSkills(targetArg = null, dryRun = false, platformArg = null) {
  const sourceDir = join(ROOT, "skills");
  const targets = resolveSkillInstallTargets(targetArg, platformArg);
  const targetResults = targets.map((target) => installSkillsToTarget({
    sourceDir,
    target,
    dryRun,
  }));

  if (targetResults.length === 1) {
    return {
      ...targetResults[0],
      available_platforms: SKILL_PLATFORMS.map((platform) => ({
        platform: platform.id,
        label: platform.label,
        target_directory: platform.target(),
      })),
    };
  }

  return {
    ok: true,
    status: dryRun ? "dry_run" : "installed",
    source_directory: sourceDir,
    targets: targetResults,
    skills: targetResults.flatMap((target) => target.skills),
    available_platforms: SKILL_PLATFORMS.map((platform) => ({
      platform: platform.id,
      label: platform.label,
      target_directory: platform.target(),
    })),
    note: dryRun
      ? "Dry run only; no skill files were written."
      : "Restart local agent sessions to pick up new or updated skills.",
  };
}

function installSkillsToTarget({ sourceDir, target, dryRun }) {
  const targetDir = target.target_directory;
  const entries = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const skills = [];

  if (!dryRun) mkdirSync(targetDir, { recursive: true });

  for (const entry of entries) {
    const name = entry.name;
    const sourceSkillDir = join(sourceDir, name);
    const source = join(sourceSkillDir, "SKILL.md");
    if (!existsSync(source)) continue;

    const destinationDir = join(targetDir, name);
    const destination = join(destinationDir, "SKILL.md");
    const sourceDescriptor = describeSkillDirectory(sourceSkillDir);
    const hasDestination = existsSync(destination);
    const destinationDescriptor = hasDestination ? describeSkillDirectory(destinationDir) : null;
    const action = !hasDestination
      ? "created"
      : destinationDescriptor?.hash === sourceDescriptor.hash
        ? "unchanged"
        : "updated";

    if (!dryRun && action !== "unchanged") {
      rmSync(destinationDir, { recursive: true, force: true });
      cpSync(sourceSkillDir, destinationDir, { recursive: true, force: true });
    }

    skills.push({
      name,
      action,
      platform: target.platform,
      platform_label: target.platform_label,
      source,
      destination,
      from: destinationDescriptor,
      to: sourceDescriptor,
    });
  }

  return {
    ok: true,
    status: dryRun ? "dry_run" : "installed",
    platform: target.platform,
    platform_label: target.platform_label,
    source_directory: sourceDir,
    target_directory: targetDir,
    skills,
    note: dryRun
      ? "Dry run only; no skill files were written."
      : `Restart ${target.platform_label} session to pick up new or updated skills.`,
  };
}

function listFilesRecursive(dir) {
  const files = [];
  const root = resolve(dir);
  if (!existsSync(root)) return files;

  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relative(root, fullPath));
      }
    }
  }

  walk(root);
  return files;
}

function describeSkillDirectory(dir) {
  const skillPath = join(dir, "SKILL.md");
  const skillContent = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";
  const version = extractFrontmatterValue(skillContent, "version");
  const hash = createHash("sha256");
  const relativeFiles = listFilesRecursive(dir);
  for (const file of relativeFiles) {
    const fullPath = join(dir, file);
    hash.update(file);
    hash.update("\0");
    hash.update(existsSync(fullPath) ? readFileSync(fullPath) : "__MISSING__");
    hash.update("\0");
  }
  const digest = hash.digest("hex").slice(0, 12);
  return {
    version,
    hash: digest,
    label: version ? `v${version}` : `sha256:${digest}`,
  };
}

function extractFrontmatterValue(content, key) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  for (const line of match[1].split("\n")) {
    const parts = line.match(/^([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
    if (parts?.[1] === key) return parts[2].replace(/^["']|["']$/g, "");
  }
  return null;
}

function requireString(object, errors, path) {
  if (!isNonEmptyString(getPath(object, path))) addIssue(errors, path, `${path} is required.`);
}

function requireBoolean(object, errors, path) {
  if (typeof getPath(object, path) !== "boolean") addIssue(errors, path, `${path} must be boolean.`);
}

function requireArray(object, errors, path) {
  if (!Array.isArray(getPath(object, path))) addIssue(errors, path, `${path} must be an array.`);
}

function getPath(object, path) {
  return path.split(".").reduce((cursor, part) => {
    if (!isObject(cursor) && !Array.isArray(cursor)) return undefined;
    return cursor[part];
  }, object);
}

function addIssue(collection, code, message, detail = null) {
  collection.push(detail ? { code, message, detail } : { code, message });
}

function writeResult(result, args, failureCode) {
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result);
  }
  if (failureCode) process.exitCode = failureCode;
}

// --- Workflow Findings Sidecar -------------------------------------------
//
// Local Finding Capture for the Learning Trail. Capture is local-first and
// public-package owned; it never requires Linear access or NEXT internal
// context, and it never phones home. See docs/workflow-findings-sidecar.md.

async function findingsCommand(args, ambient = null) {
  const sub = args._[1] || "";
  if (sub === "add") return findingsAdd(args, ambient);
  if (sub === "harvest") return findingsHarvest(args, ambient);
  if (sub === "list") return findingsList(args, ambient);
  if (sub === "export") return findingsExport(args, ambient);
  throw new Error(`Unknown findings subcommand "${sub}". Use: add | harvest | list | export.`);
}

function resolveFindingsJournalPath(args, ambient = null) {
  return resolveJournalPath(args, ambient?.dir || process.cwd());
}

async function promptForFinding(current) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const stage = current.stage || (await rl.question(`Stage (${FINDING_STAGES.join("/")}): `)).trim();
    const kind = current.kind || (await rl.question(`Kind (${FINDING_KINDS.join("/")}): `)).trim();
    const summary = current.summary || (await rl.question("Summary: ")).trim();
    const details = current.details || (await rl.question("Details (optional): ")).trim() || null;
    return { stage, kind, summary, details };
  } finally {
    rl.close();
  }
}

async function findingsAdd(args, ambient = null) {
  // Flags-first so agents and scripts can record findings without prompts.
  // When required flags are missing AND stdin is a TTY, fall back to a tiny
  // interactive prompt for only stage/kind/summary/details. When required
  // flags are missing and the command is non-interactive, fail clearly.
  let stage = optionalString(args.stage);
  let kind = optionalString(args.kind);
  let summary = optionalString(args.summary === true ? null : args.summary);
  let details = optionalString(args.details === true ? null : args.details);

  const missing = [];
  if (!stage) missing.push("--stage");
  if (!kind) missing.push("--kind");
  if (!summary) missing.push("--summary");

  if (missing.length) {
    if (process.stdin.isTTY) {
      const answers = await promptForFinding({ stage, kind, summary, details });
      stage = answers.stage;
      kind = answers.kind;
      summary = answers.summary;
      details = answers.details;
    } else {
      throw new Error(
        `findings add is missing required flags: ${missing.join(", ")}. `
          + `Provide them as flags (flags-first for agents/CI), e.g. `
          + `--stage ${FINDING_STAGES[0]} --kind ${FINDING_KINDS[0]} --summary "..."`,
      );
    }
  }

  const commandExitStatus = optionalString(args["command-exit-status"]);
  const finding = buildFinding({
    stage,
    kind,
    summary,
    details,
    expected: optionalString(args.expected),
    actual: optionalString(args.actual),
    severity: optionalString(args.severity),
    command: optionalString(args.command),
    command_exit_status: commandExitStatus != null ? Number.parseInt(commandExitStatus, 10) : undefined,
    source_type: optionalString(args["source-type"]),
    template_family: optionalString(args["template-family"]),
    map_id: optionalString(args["map-id"]),
    campaign_slug: optionalString(args["campaign-slug"]),
    target_repo: optionalString(args["target-repo"]),
    packet_path: optionalString(args.packet),
    assembly_report_path: optionalString(args["report"]),
    qa_run_id: optionalString(args["qa-run-id"]),
    run_id: optionalString(args["run-id"]) || optionalString(ambient?.session?.run_id),
    author_type: optionalString(args["author-type"]),
    evidence_quality: optionalString(args["evidence-quality"]),
    suggested_owner: optionalString(args["suggested-owner"]),
    safe_to_share: args["safe-to-share"],
    artifact_paths: optionalString(args["artifact-paths"]),
  });

  const journalPath = resolveFindingsJournalPath(args, ambient);
  appendFinding(journalPath, finding);

  if (args.json) {
    console.log(JSON.stringify({ ok: true, journal: journalPath, finding }, null, 2));
    return;
  }
  console.log("Workflow finding recorded.");
  console.log(`Journal: ${journalPath}`);
  console.log(`Finding: [${finding.stage}/${finding.kind}] ${finding.summary}`);
  console.log(`ID: ${finding.id}`);
}

function findingsList(args, ambient = null) {
  const journalPath = resolveFindingsJournalPath(args, ambient);
  const { findings, malformed } = readJournal(journalPath);
  if (args.json) {
    console.log(JSON.stringify({ ok: true, journal: journalPath, count: findings.length, findings, malformed }, null, 2));
    return;
  }
  console.log(`Workflow findings: ${findings.length}`);
  console.log(`Journal: ${journalPath}`);
  for (const finding of findings) {
    console.log(`- [${finding.stage || "?"}/${finding.kind || "?"}] ${finding.summary || "(no summary)"} (${finding.id || "no-id"})`);
  }
  if (malformed.length) {
    console.log(`Skipped ${malformed.length} malformed line(s): ${malformed.map((entry) => entry.line).join(", ")}`);
  }
}

function findingsHarvest(args, ambient = null) {
  const packetPath = resolve(requireArg(args, "packet"));
  const packet = readJson(packetPath);
  const targetRepo = resolveFromFile(packetPath, packet.assembly?.target_repo) || dirname(packetPath);
  const contextPath = args.context ? resolve(args.context) : join(targetRepo, ".campaign-runtime/build-context.json");
  const reportPath = args.report ? resolve(args.report) : join(targetRepo, ".campaign-runtime/assembly-report.json");
  const contextExists = existsSync(contextPath);
  const reportExists = existsSync(reportPath);
  const report = reportExists ? readJson(reportPath) : null;
  const doctor = doctorPacket(packetPath, {
    contextPath: contextExists ? contextPath : null,
    reportPath: reportExists ? reportPath : null,
  });
  const artifactPaths = [
    relFromDir(dirname(packetPath), packetPath),
    contextExists ? relFromDir(dirname(packetPath), contextPath) : null,
    reportExists ? relFromDir(dirname(packetPath), reportPath) : null,
  ].filter(Boolean);

  const proposals = proposeWorkflowFindingsFromArtifacts({
    doctor,
    report,
    packet,
    packetPath,
    reportPath: reportExists ? reportPath : null,
    artifactPaths,
    runId: optionalString(args["run-id"]) || optionalString(ambient?.session?.run_id),
  });

  let written = [];
  const journalPath = resolveFindingsJournalPath(args, ambient);
  if (args.write === true) {
    written = proposals.map((finding) => appendFinding(journalPath, finding));
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: true, action: "findings-harvest", journal: journalPath, write: args.write === true, count: proposals.length, proposals, written }, null, 2));
    return;
  }

  console.log(`Workflow findings proposed: ${proposals.length}`);
  console.log(`Journal: ${journalPath}`);
  for (const finding of proposals) {
    console.log(`- [${finding.stage}/${finding.kind}] ${finding.summary}`);
  }
  if (args.write === true) console.log(`Recorded ${written.length} finding(s).`);
  else console.log("Dry run only. Pass --write to append these proposals to the local journal.");
}

function proposeWorkflowFindingsFromArtifacts({ doctor, report, packet, packetPath, reportPath, artifactPaths, runId = null }) {
  const findings = [];
  const base = {
    artifact_paths: artifactPaths.join(","),
    packet_path: relFromDir(dirname(packetPath), packetPath),
    assembly_report_path: reportPath ? relFromDir(dirname(packetPath), reportPath) : null,
    map_id: packet.spec?.map_id,
    campaign_slug: packet.campaign?.public_route_slug,
    target_repo: packet.assembly?.target_repo,
    template_family: packet.assembly?.template_family,
    // Stamp the canonical run_id so the Run Record's findings snapshot is exact
    // (selected by ID) rather than inferred from timestamps. Optional —
    // harvesting without a run_id stays backward-compatible.
    run_id: optionalString(runId),
    author_type: "system",
    evidence_quality: "system_observed",
    safe_to_share: false,
  };

  for (const issue of doctor.errors || []) {
    findings.push(buildFinding({
      ...base,
      stage: stageFromIssueCode(issue.code),
      kind: "blocker",
      summary: `[${issue.code}] ${issue.message}`,
      details: "Proposed by campaigns-os findings harvest from doctor errors.",
      severity: "high",
    }));
  }

  for (const issue of doctor.warnings || []) {
    if (!harvestableWarning(issue.code)) continue;
    findings.push(buildFinding({
      ...base,
      stage: stageFromIssueCode(issue.code),
      kind: kindFromIssueCode(issue.code),
      summary: `[${issue.code}] ${issue.message}`,
      details: "Proposed by campaigns-os findings harvest from doctor warnings.",
      severity: "medium",
    }));
  }

  for (const [stage, record] of Object.entries(report?.stages || {})) {
    for (const blocker of Array.isArray(record.blockers) ? record.blockers : []) {
      findings.push(buildFinding({
        ...base,
        stage: normalizeFindingStage(stage),
        kind: "blocker",
        summary: `[${blocker.code || `stage.${stage}.blocker`}] ${blocker.message || `${stage} is blocked`}`,
        details: "Proposed by campaigns-os findings harvest from assembly report blockers.",
        severity: "high",
      }));
    }
  }

  return dedupeFindings(findings);
}

function harvestableWarning(code) {
  return /^(adapter\.|source_html\.|context\.prompts_required|deploy\.preview_url|campaign\.allowed_domains_confirmed|scope\.|template_contract\.|frontmatter\.|qa\.proof_policy)/.test(String(code || ""));
}

function stageFromIssueCode(code) {
  const normalized = String(code || "");
  if (normalized.startsWith("adapter.") || normalized.startsWith("source_html.") || normalized.startsWith("template_contract.") || normalized.startsWith("frontmatter.")) return "build";
  if (normalized.startsWith("deploy.")) return "deploy";
  if (normalized.startsWith("qa.")) return "qa";
  if (normalized.startsWith("scope.")) return "doctor";
  return "doctor";
}

function kindFromIssueCode(code) {
  const normalized = String(code || "");
  if (normalized.includes("missing") || normalized.includes("prompts_required")) return "missing_prompt";
  if (normalized.startsWith("adapter.") || normalized.startsWith("source_html.") || normalized.startsWith("template_contract.")) return "friction";
  return "automation_gap";
}

function normalizeFindingStage(stage) {
  if (stage === "prepare_build") return "start";
  if (stage === "assembly") return "build";
  if (FINDING_STAGES.includes(stage)) return stage;
  return "overall";
}

function dedupeFindings(findings) {
  const seen = new Set();
  const result = [];
  for (const finding of findings) {
    const key = `${finding.stage}:${finding.kind}:${finding.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
}

function findingsExport(args, ambient = null) {
  const journalPath = resolveFindingsJournalPath(args, ambient);
  const { findings } = readJournal(journalPath);
  // Structured JSON is explicit; Markdown summary is the default so a run
  // summary pastes straight into an issue tracker, PR, or chat.
  if (args.json) {
    console.log(JSON.stringify(exportFindingsJson(findings), null, 2));
    return;
  }
  process.stdout.write(exportSummaryMarkdown(findings));
}

// Ambient run session (Tier 3): `run start | end | status`. A session shares
// one run_id + one lifecycle journal across every command in the project
// without per-command flags — the experience for "talk to your agent and
// build". See src/run-session.mjs.
async function runSessionCommand(args, ambient = null) {
  const sub = args._[1] || "status";
  if (sub === "start") return runSessionStart(args);
  if (sub === "status") return runSessionStatus(args);
  if (sub === "end") return runSessionEnd(args, ambient);
  throw new Error(`Unknown run subcommand "${sub}". Use: start | end | status.`);
}

function runSessionStart(args) {
  const rootDir = process.cwd();
  const existing = findRunSession(rootDir);
  if (existing && args.force !== true) {
    throw new Error(
      `A run session is already active (${existing.session.run_id}). End it with \`campaigns-os run end\`, or pass --force to replace it.`,
    );
  }
  const runId = optionalString(args["run-id"]) || mintSessionRunId();
  const lifecycleJournal = isNonEmptyString(args["lifecycle-journal"])
    ? resolve(args["lifecycle-journal"])
    : join(resolve(rootDir), LIFECYCLE_JOURNAL_REL_PATH);
  const packet = optionalString(args.packet) ? resolve(args.packet) : null;
  // The packet is remembered for the whole session, so a typo would only surface
  // at `run end` after a full build. Warn now (non-fatal) if it isn't there yet.
  if (packet && !existsSync(packet) && !args.json) {
    console.warn(`Warning: --packet ${packet} does not exist yet; run end will need it (or pass --packet then).`);
  }
  const session = buildRunSession({ runId, lifecycleJournal, packet });
  const sessionPath = writeRunSession(rootDir, session);

  if (args.json) {
    console.log(JSON.stringify({ ok: true, action: "run-start", session, session_path: sessionPath }, null, 2));
    return;
  }
  console.log("Run session started.");
  console.log(`Run ID: ${runId}`);
  console.log(`Lifecycle journal: ${lifecycleJournal}`);
  console.log("Every campaigns-os command in this project now auto-logs to this run — no per-command flags.");
  console.log(`Finish with: campaigns-os run end${packet ? "" : " --packet <campaign-runtime.build.json>"}`);
}

function runSessionStatus(args) {
  const found = findRunSession(process.cwd());
  if (args.json) {
    console.log(JSON.stringify({ ok: true, action: "run-status", active: Boolean(found), session: found?.session ?? null, session_path: found?.path ?? null }, null, 2));
    return;
  }
  if (!found) {
    console.log("No active run session. Start one with: campaigns-os run start");
    return;
  }
  console.log(`Active run session: ${found.session.run_id}`);
  console.log(`Lifecycle journal: ${found.session.lifecycle_journal}`);
  console.log(`Started: ${found.session.started_at}`);
  if (found.session.packet) console.log(`Packet: ${found.session.packet}`);
}

async function runSessionEnd(args, ambient = null) {
  // Use the session resolved once in main() (single source of truth).
  const found = ambient;
  if (!found) {
    throw new Error("No active run session to end. Start one with: campaigns-os run start.");
  }
  const { session, path: sessionPath } = found;
  const packet = optionalString(args.packet) || session.packet;
  if (!packet) {
    throw new Error("run end needs a build packet. Pass --packet <campaign-runtime.build.json>, or set it at `run start --packet <path>`.");
  }
  // Reuse the full run-record path (aggregate lifecycle, consent-gated remit)
  // with the session's run_id + journal, so `run end` is just "assemble the
  // Run Record for this session and stop logging to it". The session is cleared
  // only AFTER run-record succeeds — if it throws, the session stays active so
  // the operator can fix the packet and re-run `run end`.
  const endArgs = {
    ...args,
    _: ["run-record"],
    packet,
    "run-id": session.run_id,
    "lifecycle-journal": session.lifecycle_journal,
  };
  await runRecordCommand(endArgs, found);
  clearRunSession(sessionPath);
  if (!args.json) console.log(`Run session ${session.run_id} ended; session cleared.`);
}

// Run Telemetry capture + remit. Thin dispatch: read this run's artifacts with
// the same readers `findings harvest` uses, hand the parsed structures to
// run-record.mjs to assemble the manifest, then (consent-gated, non-fatal)
// remit it. Capture is ALWAYS local; consent gates only the remit. See
// docs/workflow-findings-sidecar.md.
async function runRecordCommand(args, ambient = null) {
  const packetPath = resolve(requireArg(args, "packet"));
  const packet = readJson(packetPath);
  const baseDir = dirname(packetPath);
  const targetRepo = resolveFromFile(packetPath, packet.assembly?.target_repo) || baseDir;
  const contextPath = args.context ? resolve(args.context) : join(targetRepo, ".campaign-runtime/build-context.json");
  const reportPath = args.report ? resolve(args.report) : join(targetRepo, ".campaign-runtime/assembly-report.json");
  const contextExists = existsSync(contextPath);
  const reportExists = existsSync(reportPath);
  const context = contextExists ? readJson(contextPath) : null;
  const report = reportExists ? readJson(reportPath) : null;
  const doctor = doctorPacket(packetPath, {
    contextPath: contextExists ? contextPath : null,
    reportPath: reportExists ? reportPath : null,
  });

  const qaVerdictPath = args["qa-verdict"]
    ? resolve(args["qa-verdict"])
    : inferQaVerdictPath({ packet, report, reportPath: reportExists ? reportPath : null, targetRepo, baseDir });
  const qaVerdictExists = qaVerdictPath != null && existsSync(qaVerdictPath);
  const qaVerdict = qaVerdictExists ? readJson(qaVerdictPath) : null;

  const journalPath = resolveJournalPath(args);
  const journal = readJournal(journalPath);
  const agentUsage = parseAgentUsageArgs(args);

  // run_id: explicit flag > active run session > freshly minted.
  const runId = optionalString(args["run-id"]) || ambient?.session?.run_id || mintRunId();
  const proxyBase = optionalString(args["proxy-base"]) || DEFAULT_PROXY_BASE;

  // Embed the aggregated command-lifecycle signal for this run from the
  // lifecycle journal (Tier 1). Strictly BEST-EFFORT: an unreadable/directory/
  // corrupt journal, or a malformed aggregate, must never break Run Record
  // generation — on any problem we embed nothing. Exclude the session/telemetry
  // commands' OWN entries (run-record, run) so they never appear as build
  // stages, and validate the candidate so it can't produce a schema-invalid
  // record at write time. Journal resolves flag > env > session > baseDir.
  let lifecycle = null;
  try {
    const lifecycleJournalPath = resolveLifecycleJournal(args, { ambient, fallbackDir: baseDir });
    const candidate = aggregateLifecycleForRun(readLifecycleJournal(lifecycleJournalPath), runId, { excludeCommands: ["run-record", "run"] });
    if (candidate && validateRunRecordLifecycle(candidate).length === 0) lifecycle = candidate;
  } catch {
    lifecycle = null;
  }

  const artifacts = [runRecordArtifactRef("build_packet", packetPath, PACKET_SCHEMA, baseDir)];
  if (contextExists) artifacts.push(runRecordArtifactRef("build_context", contextPath, CONTEXT_SCHEMA, baseDir));
  if (reportExists) artifacts.push(runRecordArtifactRef("assembly_report", reportPath, REPORT_SCHEMA, baseDir));
  if (qaVerdictExists) artifacts.push(runRecordArtifactRef("qa_verdict", qaVerdictPath, optionalString(qaVerdict?.schema_version), baseDir));
  if (existsSync(journalPath)) artifacts.push(runRecordArtifactRef("findings_journal", journalPath, WORKFLOW_FINDING_SCHEMA, baseDir));

  const write = args["no-write"] !== true;
  // A pure local-inspection run (--no-write) or an explicit --no-remit never
  // phones home, regardless of consent.
  const remitDisabled = args["no-remit"] === true || !write;

  // Resolve consent through the shared resolver every remitting command calls.
  // When interactive, not in --json/agent mode, remit isn't disabled, and no
  // explicit choice exists yet, ask once up front and persist it.
  let consent = resolveConsent({ proxyBase });
  if (!consent.resolved && !remitDisabled && !args.json && process.stdin.isTTY) {
    consent = await promptAndPersistConsent({ proxyBase });
  }

  const record = assembleRunRecord({
    runId,
    packageVersion: packageVersion(),
    command: "run-record",
    argvShape: argvShape(args),
    consent: { state: consent.state, source: consent.source },
    identity: {
      map_id: optionalString(packet.spec?.map_id),
      campaign_slug: optionalString(packet.campaign?.public_route_slug),
      template_family: optionalString(packet.assembly?.template_family),
      entry_point_shape: "packet",
    },
    artifacts,
    packet,
    doctor,
    report,
    context,
    qaVerdict,
    journal,
    surfaces: parseCommaList(args.surfaces),
    primarySurface: optionalString(args["primary-surface"]),
    surfaceConfidence: optionalString(args["surface-confidence"]),
    lifecycle,
    agentUsage,
  });

  // Write before any network call so local capture does not depend on telemetry
  // being fast or reachable. If a crash lands before the final rewrite below,
  // the durable record is explicitly pending instead of silently skipped.
  const shouldAttemptRemit = !remitDisabled && consent.state === "on";
  if (shouldAttemptRemit) {
    record.remit_state = "pending";
    record.remit_attempted = false;
    record.remit_ok = null;
    record.remit_error = null;
    record.remit_endpoint = null;
  }

  const recordPath = write ? writeRunRecord(record, { baseDir }) : null;

  // Remit is consent-gated, non-fatal, bounded, and idempotent on run_id. Its
  // outcome is stamped into the local record so a dropped send is visible, not silent.
  const remitStatus = remitDisabled
    ? { attempted: false, ok: null, error: null, endpoint: null }
    : await remitRunRecord(record, { proxyBase, consent });
  record.remit_attempted = remitStatus.attempted;
  record.remit_ok = remitStatus.ok;
  record.remit_error = remitStatus.error;
  record.remit_endpoint = remitStatus.endpoint;
  record.remit_state = remitStatus.attempted ? (remitStatus.ok ? "ok" : "failed") : "skipped";

  if (write) writeRunRecord(record, { baseDir });

  if (args.json) {
    console.log(JSON.stringify({ ok: true, action: "run-record", written: write, record_path: recordPath, record }, null, 2));
    return;
  }
  console.log(`Run Record assembled.`);
  console.log(`Run ID: ${record.run_id}`);
  console.log(`Consent: ${record.consent_state} (${record.consent_source})`);
  console.log(`Artifacts referenced: ${record.artifacts.length}`);
  console.log(`Findings in snapshot: ${record.observations.finding_ids.length}`);
  if (record.remit_attempted) {
    console.log(`Remit: ${record.remit_ok ? "ok" : `failed (${record.remit_error})`} -> ${record.remit_endpoint}`);
  } else {
    console.log(`Remit: skipped (consent ${record.consent_state}${remitDisabled ? ", disabled for this run" : ""}).`);
  }
  if (write) console.log(`Wrote: ${recordPath}`);
  else console.log("Dry run only (--no-write). No record written, no remit.");
}

// Build one artifact reference {kind, path, schema_version, sha256}. The path
// is relativized to the run root so no contributor filesystem layout leaks;
// sha256 is best-effort (null when the file can't be hashed).
function runRecordArtifactRef(kind, filePath, schemaVersion, baseDir) {
  let sha256 = null;
  try {
    sha256 = sha256File(filePath);
  } catch {
    sha256 = null;
  }
  return {
    kind,
    path: artifactRefPath(kind, filePath, baseDir),
    schema_version: schemaVersion || null,
    sha256,
  };
}

function artifactRefPath(kind, filePath, baseDir) {
  const base = resolve(baseDir);
  const fullPath = resolve(filePath);
  const rel = relative(base, fullPath);
  if (!rel) return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return `external:${kind}`;
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function inferQaVerdictPath({ packet, report, reportPath = null, targetRepo = null, baseDir = null } = {}) {
  const candidates = [];
  const add = (path, source) => {
    if (!isNonEmptyString(path)) return;
    const resolvedPath = resolve(path);
    try {
      if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) return;
      const verdict = readJson(resolvedPath);
      if (!isObject(verdict)) return;
      candidates.push({
        path: resolvedPath,
        source,
        verdict,
        mtimeMs: statSync(resolvedPath).mtimeMs,
      });
    } catch {
      // QA verdict inference is best-effort; malformed side artifacts should not
      // make run-record fail.
    }
  };

  const reportBasePath = reportPath || (targetRepo ? join(targetRepo, ".campaign-runtime/assembly-report.json") : null);
  for (const path of qaVerdictPathHints(report)) {
    add(reportBasePath ? resolveFromFile(reportBasePath, path) : path, "assembly_report");
  }

  const roots = [...new Set([targetRepo, baseDir].filter(isNonEmptyString).map((path) => resolve(path)))];
  const slugs = [...new Set([
    optionalString(packet?.spec?.map_id),
    optionalString(packet?.campaign?.public_route_slug),
  ].filter(Boolean))];
  for (const root of roots) {
    for (const slug of slugs) {
      addQaVerdictsFromDirectory(candidates, join(root, "qa-output", slug), "qa_output", packet);
    }
  }

  candidates.sort((a, b) => {
    const scoreDelta = qaVerdictCandidateScore(b, packet) - qaVerdictCandidateScore(a, packet);
    if (scoreDelta !== 0) return scoreDelta;
    return qaVerdictCandidateTime(b) - qaVerdictCandidateTime(a);
  });
  return candidates[0]?.path || null;
}

function qaVerdictPathHints(report) {
  const paths = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === "string" && /(?:path|file|verdict|output)$/i.test(key)) visit(item);
        else if (key === "outputs" || key === "artifacts" || key === "qa") visit(item);
      }
      return;
    }
    if (typeof value === "string" && /\.json(?:[?#].*)?$/i.test(value.trim())) paths.push(value.trim());
  };
  visit(report?.qa || null);
  visit(report?.stages?.qa || null);
  return [...new Set(paths)];
}

function addQaVerdictsFromDirectory(candidates, dirPath, source, packet) {
  try {
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) return;
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(dirPath, entry.name);
      const verdict = readJson(path);
      if (!isObject(verdict)) continue;
      candidates.push({
        path: resolve(path),
        source,
        verdict,
        mtimeMs: statSync(path).mtimeMs,
      });
    }
  } catch {
    // Best-effort: unreadable qa-output directories should not block capture.
  }
}

function qaVerdictCandidateScore(candidate, packet) {
  const verdict = candidate?.verdict || {};
  const expectedMapId = optionalString(packet?.spec?.map_id);
  const expectedSlug = optionalString(packet?.campaign?.public_route_slug);
  let score = 0;
  if (expectedMapId && verdict.campaign_slug === expectedMapId) score += 100;
  if (expectedSlug && verdict.campaign_slug === expectedSlug) score += 80;
  if (verdict.schema_version === "1.0" || verdict.schema_version === "campaigns-os-qa-verdict/v0") score += 10;
  const deployOrigins = [
    optionalString(packet?.deploy?.preview_url),
    optionalString(packet?.deploy?.production_url),
  ].filter(Boolean);
  const assertionUrls = Array.isArray(verdict.assertions)
    ? verdict.assertions.map((assertion) => optionalString(assertion?.url)).filter(Boolean)
    : [];
  if (deployOrigins.some((origin) => assertionUrls.some((url) => url.startsWith(origin)))) score += 25;
  return score;
}

function qaVerdictCandidateTime(candidate) {
  const completedAt = Date.parse(candidate?.verdict?.completed_at || "");
  if (Number.isFinite(completedAt)) return completedAt;
  return Number(candidate?.mtimeMs || 0);
}

const ARGV_SHAPE_PRIVATE_FLAGS = new Set(["no-remit", "no-write", "proxy-base"]);

// argv SHAPE = selected flag NAMES present, never their values (minimization).
// Sorted + de-duplicated for deterministic records; opt-out and endpoint flags
// stay private. A `--flag=value` token parses as a single key, so split on "="
// and keep only the name — otherwise a value (e.g. --auth-cookie=SECRET) would
// leak into a persisted, potentially-remitted shape, breaking the guarantee.
function argvShape(args) {
  const names = new Set();
  for (const key of Object.keys(args)) {
    if (key === "_") continue;
    const name = key.split("=")[0];
    if (ARGV_SHAPE_PRIVATE_FLAGS.has(name)) continue;
    names.add(`--${name}`);
  }
  return [...names].sort();
}

function parseCommaList(value) {
  if (!isNonEmptyString(value)) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseAgentUsageArgs(args) {
  const fields = {
    "agent-input-tokens": "input_tokens",
    "agent-output-tokens": "output_tokens",
    "agent-tool-output-tokens": "tool_output_tokens",
    "agent-total-tokens": "total_tokens",
    "agent-elapsed-ms": "elapsed_ms",
  };
  const usage = {};
  for (const [flag, field] of Object.entries(fields)) {
    if (!(flag in args)) continue;
    usage[field] = parseNonNegativeIntegerFlag(args[flag], flag);
  }
  if (isNonEmptyString(args["agent-model"])) usage.model = args["agent-model"].trim();
  if (isNonEmptyString(args["agent-usage-source"])) usage.source = args["agent-usage-source"].trim();
  return Object.keys(usage).length ? usage : null;
}

function parseNonNegativeIntegerFlag(value, flag) {
  if (value === true || value === false || value == null || String(value).trim() === "") {
    throw new Error(`--${flag} requires a non-negative integer value.`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${flag} must be a non-negative integer.`);
  }
  return parsed;
}

function packageVersion() {
  return readJson(join(ROOT, "package.json")).version;
}

// Machine-level Run Telemetry consent. `status` reports the resolved state and
// its source; `on`/`off` persist an explicit choice to the user-level config.
// Consent gates REMIT only — local capture is unaffected.
function telemetryCommand(args) {
  const sub = args._[1] || "status";
  const configPath = resolveConfigPath();

  if (sub === "on" || sub === "off") {
    const { configPath: written } = writeConsentConfig(sub, { configPath, proxyBase: DEFAULT_PROXY_BASE, source: "telemetry-command" });
    const resolved = resolveConsent({ configPath });
    if (args.json) {
      console.log(JSON.stringify({ ok: true, action: `telemetry-${sub}`, config_path: written, state: resolved.state, source: resolved.source }, null, 2));
      return;
    }
    console.log(`Telemetry ${sub.toUpperCase()}.`);
    console.log(`Config: ${written}`);
    console.log(`Resolved: ${resolved.state} (source: ${resolved.source})`);
    if (resolved.source === "env") {
      console.log(`Note: ${TELEMETRY_ENV_VAR} is set and overrides this file until unset.`);
    }
    return;
  }

  if (sub === "status") {
    const resolved = resolveConsent({ configPath });
    const { ok: configPresent } = readConfig(configPath);
    if (args.json) {
      console.log(JSON.stringify({
        ok: true,
        action: "telemetry-status",
        config_path: configPath,
        config_present: configPresent,
        state: resolved.state,
        source: resolved.source,
        resolved: resolved.resolved,
        env_override: process.env[TELEMETRY_ENV_VAR] ?? null,
      }, null, 2));
      return;
    }
    console.log(`Telemetry: ${resolved.state} (source: ${resolved.source})`);
    console.log(`Config: ${configPath}${configPresent ? "" : " (not set)"}`);
    if (!resolved.resolved) {
      console.log("No explicit choice yet — defaults OFF. Set with: campaigns-os telemetry on|off");
    }
    return;
  }

  throw new Error(`Unknown telemetry subcommand "${sub}". Use: status | on | off.`);
}

// Tiny Prompts: skippable one-line guidance at stage boundaries. They surface
// the next Expected Proof Step and optionally point at `findings add`. They
// are TEXT-ONLY by design — JSON output stays machine-readable, so these are
// never written into the serialized result object.

function printDoctorTinyPrompt(result, args) {
  if (args.json) return;
  if (result.status === "blocked") {
    console.log("");
    console.log("Next expected proof: resolve the blockers above, then re-run doctor.");
    console.log('If a blocker is confusing or the prompt is missing, record it: campaigns-os findings add --stage doctor --kind blocker --summary "..."');
    return;
  }
  console.log("");
  console.log("Next expected proof: campaigns-os next to pick the next stage (setup/build), then polish, deploy, and QA.");
  console.log('Found workflow friction here? campaigns-os findings add --stage doctor --kind friction --summary "..."');
}

function printNextTinyPrompt(result, args) {
  if (args.json) return;
  if (result.stage !== "qa") return;
  console.log("");
  console.log("Next expected proof: browser QA + typed-card proof. Run: campaigns-os qa run --packet <packet> --base-url <url> --browser --test-order common");
  console.log("Localhost on any port is a Development domain (SDK allowed, analytics suppressed). Non-localhost origins still need SDK allowlist confirmation.");
  console.log('Build/polish done but no QA verdict yet is a Completeness Signal, not a build failure: campaigns-os findings add --stage qa --kind missing_prompt --summary "..."');
}

function printPrepareResult(result, args) {
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    if (result.doctor && !result.doctor.ok) process.exitCode = 2;
    return;
  }
  console.log("Campaigns OS prepare-build");
  if (result.spec_source) {
    const src = result.spec_source;
    if (src.source === "remote") {
      console.log(`Spec: ${src.specPath} (fetched from ${src.proxyBase}/api/spec/${src.mapId})`);
    } else if (src.source === "cache") {
      console.log(`Spec: ${src.specPath} (cached from ${src.proxyBase}/api/spec/${src.mapId}; --cached-spec)`);
    } else {
      console.log(`Spec: ${src.specPath}`);
    }
  }
  console.log(`Packet: ${result.packetPath}`);
  console.log(`Context: ${result.contextPath}`);
  console.log(`Report: ${result.reportPath}`);
  if (result.doctor) {
    console.log(`Doctor: ${result.doctorOutPath}`);
    printResult(result.doctor);
  } else {
    console.log("Next: run campaigns-os doctor, then campaigns-os next build.");
  }
  if (result.doctor && !result.doctor.ok) process.exitCode = 2;
}

function printResult(result) {
  console.log(`Status: ${String(result.status || "unknown").toUpperCase()}`);
  if (result.targets?.length) {
    console.log("Targets:");
    for (const target of result.targets) {
      console.log(`- ${target.platform_label || target.platform}: ${target.target_directory}`);
    }
  } else if (result.platform_label && result.target_directory) {
    console.log(`Target: ${result.platform_label} (${result.target_directory})`);
  }
  if (result.skills?.length) {
    console.log("Skills:");
    for (const skill of result.skills) console.log(`- ${formatSkillInstallSummary(skill)}`);
  }
  if (result.ready?.length) {
    console.log("Ready:");
    for (const item of result.ready) console.log(`- ${item}`);
  }
  if (result.errors?.length) {
    console.log("Errors:");
    for (const issue of result.errors) console.log(`- [${issue.code}] ${issue.message}`);
  }
  if (result.warnings?.length) {
    console.log("Warnings:");
    for (const issue of result.warnings) console.log(`- [${issue.code}] ${issue.message}`);
  }
  if (result.next) {
    console.log("Next:");
    console.log(`- ${result.next.stage || "unknown"} (${result.next.owner || result.next.default_skill || "owner unknown"})`);
    for (const action of result.next.actions || []) console.log(`- ${action}`);
  }
  if (result.prompt) {
    console.log("");
    console.log(result.prompt);
  }
  if (result.note) console.log(result.note);
}

function formatSkillInstallSummary(skill) {
  const prefix = skill.platform && skill.platform !== "custom" ? `${skill.platform}/` : "";
  if (skill.action === "created") return `${prefix}${skill.name}: created (${skill.to.label})`;
  if (skill.action === "updated") {
    const from = skill.from?.label || "missing";
    return `${prefix}${skill.name}: updated (${from} -> ${skill.to.label})`;
  }
  return `${prefix}${skill.name}: unchanged (${skill.to.label})`;
}
