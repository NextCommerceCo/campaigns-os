import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
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
  RUN_RECORD_SURFACES,
  validateRunRecordLifecycle,
  writeRunRecord,
} from "./run-record.mjs";
import {
  announceDefaultOnTelemetry,
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
  isRunSessionStale,
  isRunSessionTerminal,
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
  SOURCE_HASH_PATTERN,
  SOURCE_HTML_MANIFEST_SCHEMA,
} from "./source-html-manifest.mjs";
import { crawlSourceAssetPaths } from "./source-asset-crawl.mjs";
import {
  inspectBrandTheme,
  validateAssemblyReportThemeBlock,
  validateThemeContextBlock,
  writeThemeArtifacts,
} from "./brand-theme.mjs";
import {
  attachBuiltOutputDoctor,
  createStandardizationReport,
  formatStandardizationReportMarkdown,
} from "./standardization-report.mjs";
import { evaluateThemeGate } from "./theme-gate.mjs";
import {
  evaluatePageKitBuildSummary,
  PAGE_KIT_BUILD_SUMMARY_CAPTURE_COMMAND,
  readPageKitBuildSummary,
} from "./page-kit-build-summary.mjs";
import {
  demoAssetConfig,
  findForbiddenPriceHides,
  placeholderTextResidueConfig,
  placeholderTextResidueMatches,
} from "./template-brand-contract.mjs";
import { defaultCommerceCatalogPath, resolveCommerceCatalog, resolveTemplateBrandContract } from "./private-template-source.mjs";
import {
  resolveBuiltSiteScope,
  synthesizeMinimalBuildPacket,
} from "./built-site-scope.mjs";
import {
  BUILD_BRIEF_NORMALIZED_REL_PATH,
  BUILD_BRIEF_SCHEMA,
  createCampaignBuildBriefArtifact,
  inferBuildBriefPath,
  validateCampaignBuildBriefArtifact,
} from "./build-brief.mjs";
import {
  appendDeviation,
  buildRecommendation,
  detectDeviation,
  DEVIATION_JOURNAL_REL_PATH,
  expectedCommandsForStage,
  readDeviations,
} from "./deviation.mjs";
import {
  ASSEMBLY_REPORT_STAGE_KEYS,
  NEXT_STAGE_ORDER,
  reportKeyForCliStage,
} from "./orchestration-stage-contract.mjs";
import { evaluatePolishGate } from "./polish-gate.mjs";
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
  "apollo",
  "apollo-mv-single-step",
  "olympus",
  "demeter",
  "olympus-mv-single-step",
  "olympus-mv-two-step",
  "shop-single-step",
  "shop-three-step",
  "custom",
]);

// Certified template families: present in the commerce surface catalog AND
// carrying a template brand contract. The OS automates certified families
// only — "NEXT provides the rails": deterministic assembly, residue QA, and
// pricing contracts all assume a certified family. "custom" (or any family
// outside the catalog) is an explicit operator decision recorded as a
// waiver, never a default road the agent can wander onto.
// Recomputed per call (a handful of small JSON reads) so long-lived
// processes never serve a stale certified set after contract edits.
function certifiedTemplateFamilies() {
  const catalog = resolveCommerceCatalog();
  const certified = Object.keys(catalog.families || {}).filter((family) => {
    try {
      return resolveTemplateBrandContract(family) !== null;
    } catch {
      return false;
    }
  });
  return new Set(certified);
}

function isCertifiedTemplateFamily(family) {
  return certifiedTemplateFamilies().has(String(family || ""));
}

function isKnownTemplateFamily(family) {
  const value = String(family || "");
  return KNOWN_TEMPLATE_FAMILIES.has(value) || certifiedTemplateFamilies().has(value);
}

function isSynthesizedBuiltSitePacket(packet) {
  return packet?._synthesized?.from === "built_site";
}

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
                     [--brief <yaml|json>] [--proxy-base <url>] [--cached-spec] [--theme-policy <inspect_only|auto|off>]
                     [--allow-uncertified-template "<reason>"] [--no-run-session]
  campaigns-os prepare-build (--spec <json> | --map-id <id>) --source <html-dir> --target <page-kit-dir> --template-family <family>
                             [--brief <yaml|json>] [--proxy-base <url>] [--cached-spec] [--theme-policy <inspect_only|auto|off>]
                             [--allow-uncertified-template "<reason>"] [--no-run-session]
  campaigns-os build (--spec <json> | --map-id <id>) --source <html-dir> --target <page-kit-dir> --template-family <family>
                     [--brief <yaml|json>] [--proxy-base <url>] [--cached-spec] [--theme-policy <inspect_only|auto|off>]
                     [--allow-uncertified-template "<reason>"] [--no-run-session]   # intake alias for prepare-build + doctor
  campaigns-os doctor --packet <campaign-runtime.build.json> [--context <json>] [--report <json>] [--strip-paths] [--json]
  campaigns-os doctor --built <page-kit-target-repo> --family <family> [--slug <slug>] [--base-url <url>] [--emit-packet [path]] [--json]   # L7: doctor a built _site/ with no Build Packet
  campaigns-os standardize --target <page-kit-repo-or-cpk-repo> [--family <family>] [--slug <slug>] [--no-doctor] [--json]
  campaigns-os standardization-report --target <page-kit-repo-or-cpk-repo> [--family <family>] [--slug <slug>] [--no-doctor] [--json]   # alias for standardize
  campaigns-os theme inspect --packet <campaign-runtime.build.json> [--context <json>] [--theme-policy <inspect_only|auto|off>] [--json]
  campaigns-os theme generate --packet <campaign-runtime.build.json> [--context <json>] [--out-dir <dir>] [--force] [--json]
  campaigns-os theme waive --packet <campaign-runtime.build.json> --reason "<why>" [--waived-by <who>] [--report <json>] [--json]   # record an explicit theme-gate waiver on the assembly report
  campaigns-os validate-assembly-report --report <json> [--json]
  campaigns-os install-skills [--platform <claude|codex|agents|all>] [--target <skills-dir>] [--dry-run] [--json]
  campaigns-os tooling status [--platform <claude|codex|agents|all>] [--target <skills-dir>] [--json]   # repo/package/skill freshness preflight
  campaigns-os install-agent-context --target <page-kit-dir> [--dry-run]
  campaigns-os next --packet <json> [--json]                       # self-decide next stage; returns gates[] + next_actions[] (exact commands) alongside the prompt
  campaigns-os next setup --packet <json> [--context <json>] [--report <json>] [--json]
  campaigns-os next build --packet <json> [--context <json>] [--report <json>] [--json]
  campaigns-os next polish --packet <json> --report <json> [--json]
  campaigns-os next deploy --packet <json> --report <json> [--json]
  campaigns-os next qa --packet <json> --report <json> [--json]
  campaigns-os qa resolve --packet <json> [--base-url <url>] [--json]
  campaigns-os qa run --packet <json> [--base-url <url>] [--browser] [--test-order <mode>] [--no-post-verdict] [--no-remit] [--output-dir qa-output] [--json]
  campaigns-os qa policy set --packet <json> [--test-orders-allowed true|false] [--sandbox-test-card-confirmed true|false] [--allowed-domains-confirmed true|false] [--json]
  campaigns-os findings add --stage <stage> --kind <kind> --summary <text> [--details <text>] [--packet <json>] [--journal <path>] [--run-id <id>] [...context flags]
  campaigns-os findings harvest --packet <json> [--context <json>] [--report <json>] [--journal <path>] [--run-id <id>] [--write] [--json]
  campaigns-os findings list [--packet <json>] [--journal <path>] [--json]
  campaigns-os findings export [--summary | --json] [--packet <json>] [--journal <path>]
  campaigns-os run-record --packet <json> [--context <json>] [--report <json>] [--qa-verdict <path>] [--run-id <id>] [--journal <path>] [--lifecycle-journal <path>] [--surfaces <a,b>] [--primary-surface <s>] [--surface-confidence <text>] [--agent-total-tokens <n>] [--agent-elapsed-ms <n>] [--proxy-base <url>] [--no-remit] [--no-write] [--json]

  Any command accepts [--lifecycle-journal <path>] (or env CAMPAIGNS_OS_LIFECYCLE_LOG) to append a command-lifecycle entry (command, argv shape, exit status, timing) for the run; pair with --run-id so run-record can embed it.
  campaigns-os telemetry status|on|off [--json]                    # machine-level Run Telemetry consent (gates remit only; capture is always local)
  campaigns-os run start [--packet <json>] [--run-id <id>] [--lifecycle-journal <path>] [--force] [--json]   # begin an ambient run session: one run_id + journal auto-shared by every command, no per-command flags
  campaigns-os run status [--json]                                 # active session + incomplete stages + deviation count + exact next command
  campaigns-os run end [--packet <json>] [--no-remit] [--no-write] [--json]   # assemble the aggregated Run Record for the session, then clear it

  Gates: when theme inspect finds a generatable brand theme and the campaign ships commerce pages, \`next polish|deploy|qa\` and \`qa run\` BLOCK until the brand layer is applied after next-core.css or explicitly waived (\`theme waive\` / \`qa run --theme-waive "<reason>"\`).
  Certified templates: \`start\`/\`prepare-build\` only accept template families with a commerce-catalog entry AND a brand contract; anything else needs --allow-uncertified-template "<reason>" (recorded on the packet; deterministic assembly, residue QA, and pricing contracts will not cover the build).
  Ambient telemetry: \`start\`/\`prepare-build\` auto-open the run session in the target repo (opt out per-run with --no-run-session), and \`qa run\` auto-assembles the Run Record and clears the session. Run Telemetry remit to the canonical NEXT endpoint is ON by default — disable with \`campaigns-os telemetry off\`, CAMPAIGNS_OS_TELEMETRY=off, or per-run --no-remit. Capture is always local.
  Deviations: with an active run session, pipeline-advancing commands that don't match the last \`next\` recommendation are recorded to .campaign-runtime/agent-deviations.jsonl; declare intent with --deviation-reason "<why>".

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

  npm run campaigns-os -- standardize --target examples/target-page-kit --json
`;

// Top-level commands the CLI dispatches, used to offer a did-you-mean
// suggestion on a typo instead of a bare "Unknown command". Derived from the
// `command === "…"` literals in dispatch() itself (memoized on first use) so
// the list cannot drift as dispatch branches are added or removed. The regex
// tolerates whitespace and either quote style so common reformats don't
// silently empty the list; a known-commands test guards against a refactor
// (switch table, extracted constant) that the regex can't follow.
let knownCommandsCache = null;
export function knownCommands() {
  if (knownCommandsCache) return knownCommandsCache;
  const found = new Set(["help"]);
  for (const match of dispatch.toString().matchAll(/command\s*===\s*["']([^"']+)["']/g)) {
    found.add(match[1]);
  }
  knownCommandsCache = [...found];
  return knownCommandsCache;
}

// Levenshtein distance, capped use: only for a single short token at error
// time, so the naive O(n*m) implementation is fine.
function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dist[i][0] = i;
  for (let j = 0; j < cols; j += 1) dist[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + cost);
    }
  }
  return dist[rows - 1][cols - 1];
}

// Nearest known command within a small edit budget, or null when nothing is
// close enough to be a confident suggestion.
function closestCommand(input) {
  // Case-insensitive: commands are all lowercase, so `Doctor` should still
  // match `doctor` by intent, not by accident.
  const needle = input.toLowerCase();
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of knownCommands()) {
    const distance = editDistance(needle, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  // Tighter budget for shorter inputs: a 2-char budget on a 2-char typo would
  // confidently mis-suggest (e.g. `dr` -> `qa`, distance 2). Scale the allowed
  // edits with length so suggestions stay high-confidence.
  const len = needle.length;
  const budget = len <= 3 ? 1 : len <= 6 ? 2 : 3;
  return bestDistance <= budget ? best : null;
}

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
  //
  // `sessionHolder` is per-invocation, NOT module state: when start/
  // prepare-build auto-open a run session mid-command, they publish it here
  // so onFinish persists this command's own lifecycle entry into the new
  // session — without two interleaved invocations ever sharing a session.
  const sessionHolder = { current: ambient, autoStarted: false, qaResult: null };
  await withCommandLifecycle(
    {
      command,
      argvShape: argvShape(args),
      runId: optionalString(args["run-id"]) || ambient?.session?.run_id || null,
      onFinish: async (lifecycle, thrown) => {
        persistLifecycleIfRequested(args, command, lifecycle, sessionHolder);
        await autoEndRunSessionAfterTerminalQa(args, command, sessionHolder, thrown);
      },
    },
    (recorder) => dispatch(command, args, recorder, ambient, sessionHolder),
  );
}

function ambientRunSession() {
  try {
    return findRunSession(process.cwd());
  } catch {
    return null;
  }
}

// Telemetry is ambient by default: `start`/`prepare-build` open the run
// session themselves (in the TARGET repo, where the build happens), arm the
// initial recommendation for deviation telemetry, and tell the operator how
// to finish. The dogfood evidence demanded this: agents reliably run the
// entry point and skip the bookkeeping, so the bookkeeping cannot depend on
// them. `--no-run-session` opts a run out (CI fixtures, throwaway runs);
// an already-active session is never replaced. The session lands on the
// caller-supplied --target (the directory the operator named), never a path
// derived from packet location, so an overridden packet path cannot split
// the session from the build.
function autoStartRunSession(prepareResult, args, ambient, sessionHolder) {
  if (args["no-run-session"] === true || ambient) return null;
  try {
    const packetPath = prepareResult?.packetPath;
    const targetRepo = optionalString(args.target) ? resolve(args.target) : null;
    if (!packetPath || !targetRepo) return null;
    if (findRunSession(targetRepo)) return null;
    const runId = mintSessionRunId();
    const session = {
      ...buildRunSession({
        runId,
        lifecycleJournal: join(targetRepo, LIFECYCLE_JOURNAL_REL_PATH),
        packet: resolve(packetPath),
      }),
      last_recommendation: buildRecommendation({
        stage: "doctor",
        status: "ready",
        expectedCommands: ["start", "prepare-build", "theme"],
      }),
    };
    const sessionPath = writeRunSession(targetRepo, session);
    if (sessionHolder) {
      sessionHolder.current = { session, path: sessionPath, dir: targetRepo };
      sessionHolder.autoStarted = true;
    }
    process.stderr.write(`[campaigns-os] Run session ${runId} started automatically (run telemetry is ambient; finish with \`campaigns-os run end\`, opt out per-run with --no-run-session).\n`);
    return sessionHolder?.current || null;
  } catch (error) {
    // Telemetry never blocks a build, but a failed session write must be
    // distinguishable from a clean skip.
    process.stderr.write(`[campaigns-os] run session auto-start skipped: ${error.message}\n`);
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
function persistLifecycleIfRequested(args, command, lifecycle, sessionHolder) {
  if (command === "help") return;
  const ambient = sessionHolder?.current || null;
  // A session auto-started DURING this command (start/prepare-build) is
  // published into sessionHolder by autoStartRunSession; this command's own
  // entry is the run's first record. Its run_id was unknown when the
  // lifecycle wrapper started (the session did not exist yet), so stamp a
  // local copy now — otherwise run-record aggregation by run_id would
  // silently exclude the run's entry-point command. This stamp pairs with
  // autoStartRunSession: if that call ever moves out of dispatch, the
  // holder stays the single handoff point.
  let entry = lifecycle;
  if (sessionHolder?.autoStarted && !entry.run_id && ambient?.session?.run_id) {
    entry = { ...entry, run_id: ambient.session.run_id };
  }
  const journalPath = resolveLifecycleJournal(args, { ambient });
  if (!journalPath) return;
  try {
    appendLifecycleEntry(journalPath, entry);
  } catch (error) {
    // Non-fatal, but leave a one-line breadcrumb on stderr so a capture failure
    // is observable rather than fully silent. stderr never pollutes --json stdout.
    process.stderr.write(`[campaigns-os] lifecycle capture skipped: ${error.message}\n`);
  }
  persistDeviationIfDetected(args, command, entry, ambient);
}

// Deviation telemetry: compare every pipeline-advancing command against the
// active session's last `next` recommendation. A mismatch appends one entry to
// .campaign-runtime/agent-deviations.jsonl — measurement, not a block. An
// intentional detour can carry --deviation-reason "<why>". Never throws.
function persistDeviationIfDetected(args, command, lifecycle, ambient) {
  if (!ambient?.session?.last_recommendation) return;
  if (isRunSessionTerminal(ambient.session) || hasDoneRecommendation(ambient.session) || isRunSessionStale(ambient.session)) return;
  try {
    const entry = detectDeviation({
      lastRecommendation: ambient.session.last_recommendation,
      command,
      argvShape: lifecycle?.argv_shape || [],
      runId: ambient.session.run_id || null,
      deviationReason: optionalString(args["deviation-reason"]) || null,
    });
    if (!entry) return;
    const journalPath = join(ambient.dir, DEVIATION_JOURNAL_REL_PATH);
    appendDeviation(journalPath, entry);
    process.stderr.write(
      `[campaigns-os] deviation recorded: \`${command}\` ran while next recommended stage "${entry.recommended_stage}" (expected: ${entry.recommended_commands.join(", ") || "none"}). Declare intent with --deviation-reason, or follow \`campaigns-os next\`.\n`,
    );
  } catch {
    // telemetry never blocks a command
  }
}

function hasDoneRecommendation(session) {
  return session?.last_recommendation?.stage === "done";
}

async function autoEndRunSessionAfterTerminalQa(args, command, sessionHolder, thrown) {
  if (command !== "qa" || args._[1] !== "run" || thrown) return;
  const found = sessionHolder?.current;
  const result = sessionHolder?.qaResult;
  if (!found?.session || !result?.verdict) return;
  if (isRunSessionTerminal(found.session) || isRunSessionStale(found.session)) return;

  const packet = optionalString(args.packet) || optionalString(found.session.packet);
  if (!packet) {
    process.stderr.write("[campaigns-os] run session auto-end skipped after QA: no build packet recorded on the session.\n");
    return;
  }

  try {
    const endArgs = {
      ...args,
      _: ["run-record"],
      packet,
      "run-id": found.session.run_id,
      "lifecycle-journal": found.session.lifecycle_journal,
      "qa-verdict": result.local_path,
    };
    const summary = await runRecordCommand(endArgs, found, { silent: true, promptForConsent: false });
    clearRunSession(found.path);
    sessionHolder.current = null;
    process.stderr.write(
      `[campaigns-os] Run session ${found.session.run_id} auto-ended after qa run; Run Record ${summary?.record_path || "assembled"}.\n`,
    );
  } catch (error) {
    process.stderr.write(`[campaigns-os] run session auto-end skipped after QA: ${error.message}\n`);
  }
}

async function dispatch(command, args, recorder = NOOP_RECORDER, ambient = null, sessionHolder = null) {
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
    autoStartRunSession(result, args, ambient, sessionHolder);
    printPrepareResult(result, args);
    return;
  }

  if (command === "prepare-build") {
    const resolved = await recorder.time("resolve-spec", () => resolveSpecPath(args));
    args.spec = resolved.specPath;
    const result = await recorder.time("prepare-build", () => prepareBuild(args, { runDoctor: false, installContext: false }));
    result.spec_source = resolved;
    autoStartRunSession(result, args, ambient, sessionHolder);
    printPrepareResult(result, args);
    return;
  }

  if (command === "build") {
    const resolved = await recorder.time("resolve-spec", () => resolveSpecPath(args));
    args.spec = resolved.specPath;
    const result = await recorder.time("prepare-build", () => prepareBuild(args, { runDoctor: true, installContext: false }));
    result.spec_source = resolved;
    autoStartRunSession(result, args, ambient, sessionHolder);
    printPrepareResult(result, args);
    return;
  }

  if (command === "doctor" || command === "validate-build-packet") {
    const result = doctorCommand(args);
    writeResult(result, args, result.ok ? 0 : 2);
    printDoctorTinyPrompt(result, args);
    return;
  }

  if (command === "standardize") {
    const result = standardizationReportCommand(args);
    writeStandardizationReportResult(result, args);
    return;
  }

  if (command === "standardization-report") {
    const result = standardizationReportCommand(args);
    writeStandardizationReportResult(result, args);
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

  if (command === "tooling") {
    const result = toolingCommand(args);
    writeResult(result, args, result.ok ? 0 : 2);
    return;
  }

  if (command === "next") {
    // Slice 3 Phase 2: `campaigns-os next` (no stage) self-decides the next
    // stage from the current report + doctor state. Existing form with an
    // explicit stage (`next build`, `next polish`, etc.) is unchanged.
    const stage = args._[1] || null;
    const result = nextStage(stage, args, ambient);
    writeResult(result, args, result.ok ? 0 : 2);
    printNextTinyPrompt(result, args);
    return;
  }

  if (command === "qa") {
    const result = await runQaCli(args);
    if (sessionHolder) sessionHolder.qaResult = result;
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

  const suggestion = closestCommand(command);
  const didYouMean = suggestion ? ` Did you mean "${suggestion}"?` : "";
  throw new Error(
    `Unknown command: ${command}.${didYouMean} Run \`campaigns-os --help\` to see available commands.`,
  );
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

// Atomic JSON write (tmp + rename) for artifacts other commands may read
// concurrently — a torn assembly report would defeat the gate decision it
// records. Matches the run-session write discipline.
function writeJsonAtomic(path, value) {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  const tmp = `${resolved}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, resolved);
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
  throw new Error(
    "Either --spec <path> or --map-id <id> is required. " +
      "Pass a local CampaignSpec (--spec <path-to-campaignspec.json>) " +
      "or fetch one from Map Builder (--map-id <id> --target <page-kit-dir>).",
  );
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

const BUILT_TEXT_EXTENSIONS = new Set([".html", ".css", ".js", ".mjs", ".json"]);
const BUILT_TEXT_SCAN_IGNORED_DIRS = new Set(["node_modules", ".git", "_includes", "_layouts"]);
const DISCOUNT_CLAIM_TOLERANCE = 0.01;

function collectBuiltTextFiles(root) {
  const files = [];
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) return files;

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (BUILT_TEXT_SCAN_IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && BUILT_TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push({
          path: relative(resolvedRoot, fullPath),
          name: entry.name,
          bytes: statSync(fullPath).size,
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
  const briefPath = resolve(args["brief-out"] || join(targetRepo, BUILD_BRIEF_NORMALIZED_REL_PATH));
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
  // Certified-template gate, enforced at the entry point: a decided family
  // must be certified (commerce catalog + brand contract) or the operator
  // must record the uncertified decision explicitly. Failing HERE — before
  // any packet exists — keeps "build on an uncertified template" from ever
  // being a default road.
  const uncertifiedReason = optionalString(args["allow-uncertified-template"]);
  const familyDecided = templateFamily !== "undecided" && templateFamily !== "auto";
  const familyCertified = familyDecided && isCertifiedTemplateFamily(templateFamily);
  if (familyDecided && !familyCertified && !uncertifiedReason) {
    throw new Error(
      `Template family "${templateFamily}" is not certified. Certified families: ${[...certifiedTemplateFamilies()].sort().join(", ")}. ` +
      `Pick a certified family, or pass --allow-uncertified-template "<reason>" to record an explicit waiver (deterministic assembly, residue QA, and pricing contracts will not cover the build).`,
    );
  }
  const templateCertification = familyDecided
    ? familyCertified
      ? { certified: true }
      : { certified: false, waiver: { reason: uncertifiedReason, waived_by: optionalString(args["waived-by"], "operator"), waived_at: new Date().toISOString() } }
    : null;
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
  const commerceCatalog = optionalString(args["commerce-catalog"], defaultCommerceCatalogPath());
  const themePolicy = optionalString(args["theme-policy"], "inspect_only");
  const portable = (path) => relFromDir(targetRepo, path);
  const commerceZoneFindings = inspectCommerceZones(sourceRoot, htmlFiles);
  const sourceAssetCrawl = crawlSourceAssetPaths({
    sourceRoot,
    htmlFiles,
    pageMappings: matched.mappings,
  });
  const briefDiscovery = inferBuildBriefPath({
    explicitPath: optionalString(args.brief),
    sourceRoot,
    targetRepo,
  });
  const buildBrief = createCampaignBuildBriefArtifact({
    inputPath: briefDiscovery?.path || null,
    inputSource: briefDiscovery?.source || null,
    spec,
    activePages,
    pageMappings: matched.mappings,
    templateFamily,
    sourceAssetCrawl,
    commerceZoneFindings,
  });
  if (buildBrief.inputPath && buildBrief.artifact?._meta) {
    buildBrief.artifact._meta.input_path = relFromFile(briefPath, buildBrief.inputPath);
  }
  const buildBriefPrompts = buildBrief.mode === "prepared" ? [] : buildBrief.questions.map((question) => ({
    code: `BUILD_BRIEF_${toConstantCase(question.id)}`,
    stage: "prepare_build",
    message: question.question,
    detail: {
      field: question.field,
      reason: question.reason,
      options: question.options,
      blocking: question.blocking,
    },
  }));
  const sourceBlockers = matched.prompts.map((prompt) => ({
    code: prompt.code,
    stage: prompt.stage,
    message: prompt.message,
    ...(prompt.page_id ? { page_id: prompt.page_id } : {}),
    ...(prompt.detail ? { detail: prompt.detail } : {}),
  }));
  const briefBlockers = buildBrief.blockers.map((gate) => ({
    code: gate.code,
    stage: "prepare_build",
    message: gate.message,
    field: gate.field || null,
  }));
  const briefQuestionBlockers = buildBrief.mode === "prepared"
    ? buildBrief.questions.map((question) => ({
        code: `BUILD_BRIEF_${toConstantCase(question.id)}`,
        stage: "prepare_build",
        message: question.question,
        field: question.field,
      }))
    : [];
  const blockers = [...sourceBlockers, ...briefBlockers, ...briefQuestionBlockers];
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
    build_brief: {
      schema_version: BUILD_BRIEF_SCHEMA,
      mode: buildBrief.mode,
      status: buildBrief.artifact.status,
      input_path: buildBrief.inputPath ? relFromFile(packetPath, buildBrief.inputPath) : null,
      normalized_path: relFromFile(packetPath, briefPath),
      question_count: buildBrief.questions.length,
      gate_count: buildBrief.gates.length,
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
      template_certification: templateCertification,
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
            file_count: Array.isArray(manifestResult.manifest.files) ? manifestResult.manifest.files.length : 0,
            producer_provenance: manifestResult.manifest.producer_provenance || null,
          }
        : null,
      manifest_warnings: manifestWarnings,
      ambiguous_candidates: sourceIntake.ambiguousCandidates,
      manifest_draft: sourceIntake.manifestDraft,
      asset_crawl: sourceAssetCrawl,
    },
    build_brief: {
      schema_version: BUILD_BRIEF_SCHEMA,
      mode: buildBrief.mode,
      status: buildBrief.artifact.status,
      input_path: buildBrief.inputPath ? portable(buildBrief.inputPath) : null,
      normalized_path: portable(briefPath),
      question_count: buildBrief.questions.length,
      gate_count: buildBrief.gates.length,
      questions: buildBrief.questions,
      gates: buildBrief.gates,
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
    prompts_required: [...matched.prompts, ...buildBriefPrompts],
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
    packetPath,
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
  writeJson(briefPath, buildBrief.artifact);
  writeJson(contextPath, context);
  writeJson(reportPath, report);

  let doctor = null;
  if (options.installContext) installAgentContext(targetRepo, false);
  if (options.runDoctor) {
    doctor = doctorPacket(packetPath, { contextPath, reportPath, outputBaseDir: targetRepo });
    writeJson(doctorOutPath, doctor);
  }

  return { packetPath, contextPath, reportPath, doctorOutPath, briefPath, packet, context, report, doctor };
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
      build_brief_path: context.build_brief?.normalized_path || null,
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
      outputs: [portable(packetPath), portable(contextPath), context.build_brief?.normalized_path, portable(reportPath)].filter(Boolean),
    }),
    decisions: context.decisions,
    build_brief: cloneJson(context.build_brief || {}),
    adapter_decisions: cloneJson(context.adapter_decisions || createAdapterDecisions()),
    proof_policy: cloneJson(packet.qa?.proof_policy || createProofPolicy()),
    theme: assemblyThemeFromContext(context.theme),
    evidence: [],
    blockers,
    warnings: [
      ...(context.source?.ambiguous_candidates?.length
        ? [{
            code: "AMBIGUOUS_SOURCE_HTML_CANDIDATES",
            stage: "prepare_build",
            message: `Source HTML filename fallback found ambiguous candidates: ${context.source.ambiguous_candidates.map((entry) => `${entry.page_id}: ${(entry.candidates || []).map((candidate) => candidate.path).join(", ")}`).join("; ")}. Write .campaigns-os/source-html-manifest.json from context.source.manifest_draft, choosing the intended candidate paths before build.`,
            sample: context.source.ambiguous_candidates.map((entry) => `${entry.page_id}: ${(entry.candidates || []).map((candidate) => candidate.path).join(", ")}`),
          }]
        : []),
      ...(context.commerce_zone_findings.length
        ? [{ code: "SOURCE_COMMERCE_REVIEW", stage: "assembly", message: "Source HTML contains possible commerce zones. Preserve catalog-owned runtime surfaces." }]
        : []),
      ...(context.build_brief?.mode === "guided_draft" && context.build_brief?.question_count > 0
        ? [{ code: "BUILD_BRIEF_GUIDED_QUESTIONS", stage: "prepare_build", message: `Generated Campaign Build Brief draft has ${context.build_brief.question_count} high-impact question(s) to confirm before first-shot assembly.` }]
        : []),
      ...sourceAssetWarningsForReport(context.source?.asset_crawl),
    ],
    next: blockers.length
      ? { stage: "collect-inputs", owner: "operator", action: "Resolve source/page blockers before build." }
      : {
          stage: scaffoldRequired ? "setup" : "assembly",
          owner: scaffoldRequired ? "next-campaigns-setup" : "next-campaigns-build",
          action: scaffoldRequired ? "Run setup before build." : "Run build with this packet and context.",
        },
  };
}

function sourceAssetWarningsForReport(assetCrawl) {
  const warnings = Array.isArray(assetCrawl?.warnings) ? assetCrawl.warnings : [];
  return warnings.map((warning) => ({
    code: sourceAssetReportWarningCode(warning.code),
    stage: "assembly",
    message: warning.message,
    sample: warning.sample || [],
  }));
}

function sourceAssetReportWarningCode(code) {
  if (code === "source_asset.root_assets_path") return "SOURCE_ASSET_REWRITE";
  if (code === "source_asset.outside_source_root") return "SOURCE_ASSET_ESCAPE";
  if (code === "source_asset.missing_file") return "SOURCE_ASSET_MISSING";
  if (typeof code === "string" && code.startsWith("source_asset.")) {
    return `SOURCE_ASSET_${toConstantCase(code.slice("source_asset.".length))}`;
  }
  return "SOURCE_ASSET_WARNING";
}

function toConstantCase(value) {
  const normalized = String(value || "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized || "WARNING";
}

function doctorCommand(args) {
  // Non-packet mode (learnings L7): doctor a `campaign-build`'d page-kit
  // campaign that has only a built _site/ and no full Build Packet. Resolves
  // scope from the built output and runs the built-output residue/text/
  // demo-asset/pricing gates against the chosen family's brand contract.
  const builtArg = args.built || args.site;
  if (builtArg && !args.packet) {
    return doctorBuiltOutput(args);
  }
  const packetPath = resolve(requireArg(args, "packet"));
  const explicitSidecarArgs = Boolean(args.context || args.report);
  return doctorPacket(packetPath, {
    contextPath: args.context ? resolve(args.context) : explicitSidecarArgs ? null : undefined,
    reportPath: args.report ? resolve(args.report) : explicitSidecarArgs ? null : undefined,
    outputBaseDir: args["strip-paths"] === true ? dirname(packetPath) : null,
  });
}

// L7 non-packet doctor: resolve scope from a built _site/, run the built-output
// gates the family brand contract drives, and auto-emit a minimal Build Packet
// (optionally written with --emit-packet) so QA can run against the same
// campaign without a hand-authored packet.
export function doctorBuiltOutput(args) {
  const targetRepo = resolve(String(args.built || args.site));
  const errors = [];
  const warnings = [];
  const ready = [];
  if (!existsSync(targetRepo) || !statSync(targetRepo).isDirectory()) {
    addIssue(errors, "built_site.target", `Built campaign directory does not exist: ${targetRepo}`);
    return { ok: false, status: "blocked", mode: "built_site", errors, warnings, ready, derived: { mode: "built_site" }, next: null };
  }

  const scope = resolveBuiltSiteScope(targetRepo, { slug: optionalString(args.slug) });
  if (!scope.ok) {
    addIssue(errors, "built_site.scope", scope.error || "Could not resolve scope from the built _site/.");
    return { ok: false, status: "blocked", mode: "built_site", errors, warnings, ready, derived: { mode: "built_site", scope }, next: null };
  }

  const family = optionalString(args.family) || null;
  const baseUrl = optionalString(args["base-url"]);
  const mapId = optionalString(args["map-id"]);
  const deployTarget = optionalString(args["deploy-target"], "unknown");

  const derived = {
    mode: "built_site",
    map_id: mapId || scope.slug || null,
    public_route_slug: scope.slug || null,
    template_family: family,
    target_repo: targetRepo,
    target_output_dir: scope.campaign_dir,
    site_root: scope.site_root,
    built_pages: scope.pages.map((page) => ({ page_id: page.page_id, type: page.page_type, route: page.route })),
    doctor_checks: [],
  };
  ready.push(`Resolved ${scope.html_count} built page(s) from ${relFromDir(targetRepo, scope.campaign_dir)} (slug "${scope.slug || "(site root)"}")`);

  let brandContract = null;
  if (!family) {
    addIssue(warnings, "assembly.template_family", "No --family given; the residue/placeholder-text/demo-asset gates need a family brand contract to run. Pass --family <family> (the family the campaign was built from).");
  } else {
    try {
      brandContract = resolveTemplateBrandContract(family);
    } catch (error) {
      addIssue(warnings, "template_contract.brand_contract", `Template brand contract for "${family}" failed to load: ${error.message}`);
    }
    if (!brandContract) {
      addIssue(warnings, "template_contract.brand_contract", `No brand/residue/pricing contract found for family "${family}". Built-output residue gates cannot run; confirm the family slug.`);
    } else {
      ready.push(`Template brand/residue/pricing contract loaded for ${family}`);
      validateBuiltPlaceholderTextResidue(brandContract, warnings, ready, derived);
      validateBuiltDemoAssetFidelity(brandContract, warnings, ready, derived);
      // Pricing CSS-hide scan (report omitted -> a missing assets/css dir reads
      // as a skipped ready-line, not a false "scan did not run" warning, since
      // built page-kit output may lay CSS out differently).
      runPricingCssHideCheck({ packet: { assembly: { template_family: family } }, derived, warnings, ready, report: null });
    }
  }

  // Family-agnostic generic placeholder residue (XXCODE / Product Title /
  // next-logo.png ...) always runs against the built output.
  const genericHits = collectGenericTemplateResidueMatches(scope.campaign_dir);
  if (genericHits.length) {
    addIssue(
      warnings,
      "template_contract.literal_residue",
      `Built output contains generic starter/template placeholders: ${summarizeCopyMatches(genericHits)}. Replace these from CampaignSpec/API or remove dead template references.`,
    );
  } else {
    ready.push("Built output has no generic starter placeholder or promo-code residue");
  }

  const synthesized = synthesizeMinimalBuildPacket({
    schemaVersion: PACKET_SCHEMA,
    targetRepo,
    scope,
    family,
    mapId,
    baseUrl,
    deployTarget,
  });
  derived.synthesized_packet = synthesized;

  let emittedPacketPath = null;
  if (args["emit-packet"]) {
    emittedPacketPath = args["emit-packet"] === true
      ? join(targetRepo, ".campaign-runtime", "minimal-build-packet.json")
      : resolve(String(args["emit-packet"]));
    mkdirSync(dirname(emittedPacketPath), { recursive: true });
    writeJson(emittedPacketPath, synthesized);
    ready.push(`Emitted minimal Build Packet to ${relFromDir(targetRepo, emittedPacketPath)}`);
  }

  const next = buildNextStep(errors, warnings, derived, null);
  const status = errors.length ? "blocked" : warnings.length ? "ready_with_warnings" : "ready";
  return {
    ok: errors.length === 0,
    status,
    mode: "built_site",
    errors,
    warnings,
    ready,
    derived,
    scope: { slug: scope.slug, html_count: scope.html_count, pages: derived.built_pages, campaign_dir: scope.campaign_dir },
    synthesized_packet: synthesized,
    emitted_packet_path: emittedPacketPath,
    next,
  };
}

function standardizationReportCommand(args) {
  const target = optionalString(args.target);
  if (!target) {
    throw new Error("standardize requires --target <page-kit-repo-or-cpk-repo>.");
  }
  const family = optionalString(args.family) || optionalString(args["template-family"]);
  const slug = optionalString(args.slug);
  const report = createStandardizationReport({
    targetRepo: resolve(target),
    slug,
    templateFamily: family,
  });
  if (args["no-doctor"] === true) {
    for (const root of report.roots || []) {
      if (root.built_output?.present) {
        root.built_output.doctor = { status: "skipped", reason: "--no-doctor was provided" };
      }
    }
    return report;
  }
  for (const root of report.roots || []) {
    if (!root.built_output?.present || !root.built_output?.html_count) continue;
    const inferredFamily = optionalString(root.identity?.template_family?.value);
    if (!inferredFamily) {
      root.built_output.doctor = { status: "skipped", reason: "template family unknown" };
      continue;
    }
    if (root.identity?.template_family?.confidence === "tentative") {
      root.built_output.doctor = { status: "skipped", reason: "template family tentative" };
      continue;
    }
    try {
      const doctor = doctorBuiltOutput({
        built: root.identity.page_kit_root,
        family: inferredFamily,
        slug: slug || root.built_output.slug || undefined,
      });
      attachBuiltOutputDoctor(report, root.id, doctor);
    } catch (error) {
      attachBuiltOutputDoctor(report, root.id, {
        ok: false,
        status: "blocked",
        mode: "built_site",
        errors: [{ code: "built_site.doctor_exception", message: error.message }],
        warnings: [],
        ready: [],
      });
    }
  }
  return report;
}

function themeCommand(args) {
  const subcommand = args._[1] || "inspect";
  if (!["inspect", "generate", "waive"].includes(subcommand)) {
    throw new Error(`Unknown theme subcommand "${subcommand}". Use: inspect | generate | waive.`);
  }
  if (subcommand === "waive") return themeWaive(args);
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
    packetPath,
  });
  return { ...written, css: undefined };
}

// `theme waive`: the ONLY sanctioned way to ship commerce pages without a
// generatable brand layer. Records who/why/when on the assembly report so the
// theme gate (next/doctor/qa) reads one explicit decision instead of an agent
// improvising past advisory prose.
function themeWaive(args) {
  const packetPath = resolve(requireArg(args, "packet"));
  const packet = readJson(packetPath);
  const reason = optionalString(args.reason);
  if (!reason) throw new Error("theme waive requires --reason \"<why the starter palette is acceptable for this campaign>\".");
  const sidecars = inferredBuildSidecarPaths(packet, packetPath);
  const reportPath = args.report ? resolve(args.report) : sidecars.reportPath;
  const report = readJsonIfExists(reportPath);
  if (!report) throw new Error(`theme waive needs an assembly report at ${reportPath}; run prepare-build/start first.`);
  const waiver = {
    reason,
    waived_by: optionalString(args["waived-by"], "operator"),
    waived_at: new Date().toISOString(),
  };
  report.theme = report.theme && isObject(report.theme)
    ? { ...report.theme, waiver }
    : { status: "skipped", css_path: null, load_order: "not-applied", commerce_pages: [], evidence: [], warnings: [], repair_loop_defect: null, waiver };
  report.theme.evidence = [
    ...(Array.isArray(report.theme.evidence) ? report.theme.evidence : []),
    `Theme gate waived by ${waiver.waived_by} at ${waiver.waived_at}: ${reason}`,
  ];
  writeJsonAtomic(reportPath, report);
  return {
    ok: true,
    action: "theme-waive",
    waiver,
    report_path: reportPath,
    note: "The theme gate now reports waived for this campaign. Browser QA still runs template-residue checks at warn severity so the shipped palette stays visible in the verdict.",
  };
}

function inferredBuildSidecarPaths(packet, packetPath) {
  const targetRepo = resolveFromFile(packetPath, packet?.assembly?.target_repo) || dirname(resolve(packetPath));
  return {
    contextPath: join(targetRepo, ".campaign-runtime/build-context.json"),
    reportPath: join(targetRepo, ".campaign-runtime/assembly-report.json"),
  };
}

export function doctorPacket(packetPath, { contextPath = undefined, reportPath = undefined, outputBaseDir = null } = {}) {
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

  // Theme gate: evaluated once here so `next`, QA, and run telemetry all read
  // the same decision from derived.theme_gate. The doctor reports a blocked
  // gate as a WARNING (not an error) because the fix happens during the build
  // stage — but `next polish|deploy|qa` and `qa run` treat the same gate
  // result as a hard blocker.
  const themeGate = evaluateThemeGate({
    reportTheme: report?.theme || null,
    contextTheme: context?.theme || null,
    scope: derived.scope,
    packetPath,
  });
  derived.theme_gate = themeGate;
  if (themeGate.status === "blocked") {
    const commands = themeGate.required_actions.filter((action) => action.command).map((action) => action.command);
    addIssue(warnings, themeGate.code, `${themeGate.reason} Polish/deploy/QA are gated until resolved.${commands.length ? ` Run: ${commands.join(" | ")}` : ""}`);
  } else if (themeGate.status === "waived") {
    ready.push(`Theme gate waived: ${themeGate.waiver?.reason || "(no reason recorded)"}`);
  } else if (themeGate.status === "pass") {
    ready.push("Theme gate passed: brand layer applied after next-core.css on commerce pages.");
  }
  runPricingCssHideCheck({ packet, derived, warnings, ready, report });

  const polishGate = evaluatePolishGate({ report });
  derived.polish_gate = polishGate;
  if (polishGate.status === "blocked") {
    const commands = (polishGate.required_actions || [])
      .map((action) => action?.command)
      .filter(Boolean);
    addIssue(errors, polishGate.code, `${polishGate.reason}${commands.length ? ` Required action: ${commands.join(" | ")}.` : " Run next-campaigns-polish before QA."}`, { polish_gate: polishGate });
  } else if (polishGate.status === "waived") {
    ready.push(`Polish gate passed under waiver: ${polishGate.waiver?.reason || "(no reason recorded)"}`);
  } else if (polishGate.status === "pass") {
    ready.push("Polish gate passed: structured evidence is current for this build.");
  }

  const next = buildNextStep(errors, warnings, derived, report);
  const status = errors.length ? "blocked" : warnings.length ? "ready_with_warnings" : "ready";
  const result = { ok: errors.length === 0, status, errors, warnings, ready, derived, next };
  return outputBaseDir ? relativizeDoctorOutput(result, outputBaseDir) : result;
}

// Pricing surfaces are rendered by mode-driven partials, never hidden with
// campaign CSS — a display:none on a price wrapper is how the recovery-relief
// dogfood run shipped a full-price upsell with NO visible price. Deterministic
// static scan: campaign-owned CSS files (not the family core stylesheet, not
// the generated brand layer) must not display:none any selector the family
// brand contract lists under pricing_surfaces.forbidden_css_hides. Doctor
// reports a warning with the exact rule; browser QA enforces the outcome
// (zero visible price rows) as a blocker.
function runPricingCssHideCheck({ packet, derived, warnings, ready, report = null }) {
  const family = packet?.assembly?.template_family;
  let contract = null;
  try {
    contract = resolveTemplateBrandContract(family);
  } catch (error) {
    addIssue(warnings, "template_contract.brand_contract", `Template brand contract for "${family}" failed to load: ${error.message}`);
    return;
  }
  if (!contract?.pricing_surfaces?.forbidden_css_hides?.length) {
    ready.push(`Pricing CSS scan not applicable for template family "${family || "(none)"}" (no brand contract with forbidden_css_hides)`);
    return;
  }
  // Missing campaign output is normal before setup/build (audit ready-line),
  // but anomalous once the assembly stage is recorded terminal — at that
  // point a missing dir means the scan that should have covered built CSS
  // never ran, which the operator must see as a warning, not a footnote.
  const assemblyDone = stageIsTerminal(report?.stages?.assembly?.status);
  const skipScan = (reason) => {
    if (assemblyDone) {
      addIssue(warnings, "template_contract.price_css_scan_skipped", `Pricing CSS scan did NOT run although assembly is recorded terminal: ${reason}. Check assembly.target_repo / output_dir configuration.`);
    } else {
      ready.push(`Pricing CSS scan skipped: ${reason} (runs after setup/build)`);
    }
  };
  const outputDir = derived.target_output_dir;
  if (!outputDir || !existsSync(outputDir)) {
    skipScan("target output directory does not exist");
    return;
  }
  const cssDir = join(outputDir, "assets/css");
  if (!existsSync(cssDir)) {
    skipScan("campaign assets/css directory does not exist");
    return;
  }
  const coreStylesheet = contract.css_load_order?.core_stylesheet || "next-core.css";
  const campaignCssFiles = readdirSync(cssDir)
    .filter((name) => name.endsWith(".css") && name !== coreStylesheet && name !== "brand-theme.css");
  let hideCount = 0;
  for (const name of campaignCssFiles) {
    const cssPath = join(cssDir, name);
    let cssText = "";
    try {
      cssText = readFileSync(cssPath, "utf8");
    } catch {
      continue;
    }
    for (const hit of findForbiddenPriceHides(contract, cssText)) {
      hideCount += 1;
      addIssue(
        warnings,
        "template_contract.price_css_hide",
        `Campaign CSS ${name} hides a pricing surface: "${hit.selector}" sets display:none on ${hit.target}. Use the template's declared pricing modes instead of hiding price rows; browser QA blocks upsells with zero visible price rows.`,
      );
    }
  }
  if (hideCount === 0 && campaignCssFiles.length) {
    ready.push(`Campaign CSS has no display:none rules on ${family} pricing surfaces`);
  }
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
  {
    id: "built_output.build_summary",
    phase: "built-output",
    run: ({ spec, packet, errors, warnings, ready, derived, buildState }) => validateBuildSummary(spec, packet, errors, warnings, ready, derived, buildState),
  },
  {
    id: "built_output.route_drift",
    phase: "built-output",
    run: ({ spec, packet, errors, warnings, ready, derived, buildState }) => validateBuiltRouteDrift(spec, packet, errors, warnings, ready, derived, buildState),
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
  {
    id: "build_brief.artifact",
    phase: "brief",
    run: ({ packet, packetPath, spec, context, errors, warnings, ready }) => validateBuildBrief(packet, packetPath, spec, context, errors, warnings, ready),
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
  const synthesizedBuiltSite = isSynthesizedBuiltSitePacket(packet);
  if (packet.schema_version !== PACKET_SCHEMA) addIssue(errors, "schema_version", `Expected ${PACKET_SCHEMA}.`);
  else ready.push(`Build Packet schema ${PACKET_SCHEMA}`);

  requireString(packet, errors, "campaign.public_route_slug");
  requireBoolean(packet, errors, "campaign.allowed_domains_confirmed");
  requireString(packet, errors, "spec.map_id");
  if (!synthesizedBuiltSite) {
    requireString(packet, errors, "source_html.root");
    requireArray(packet, errors, "source_html.pages");
  } else {
    ready.push("Synthesized built-site packet: source_html provenance is absent by design");
  }
  requireString(packet, errors, "assembly.target_repo");
  requireString(packet, errors, "assembly.output_dir");
  requireString(packet, errors, "assembly.template_family");
  requireBoolean(packet, errors, "qa.test_orders_allowed");
  requireBoolean(packet, errors, "qa.sandbox_test_card_confirmed");

  if (!isKnownTemplateFamily(packet.assembly?.template_family)) {
    addIssue(errors, "assembly.template_family", `Unknown template family "${packet.assembly?.template_family}".`);
  }
  if (!KNOWN_DEPLOY_TARGETS.has(packet.deploy?.target)) {
    addIssue(errors, "deploy.target", `Unknown deploy target "${packet.deploy?.target}".`);
  }

  if (!synthesizedBuiltSite && (packet.assembly?.template_family === "undecided" || packet.assembly?.template_lock?.locked !== true)) {
    addIssue(errors, "assembly.template_lock", "Template family must be explicitly locked before commerce wiring.");
  }

  // Certified-template gate: a decided family must be certified (catalog +
  // brand contract) or carry an explicit uncertified waiver. Uncertified
  // families have no deterministic assembly path, no residue QA, and no
  // pricing contract — the OS cannot stand behind the output, so the
  // decision to leave the rails is recorded, never improvised.
  const decidedFamily = packet.assembly?.template_family;
  if (isNonEmptyString(decidedFamily) && decidedFamily !== "undecided") {
    if (isCertifiedTemplateFamily(decidedFamily)) {
      ready.push(`Template family "${decidedFamily}" is certified (commerce catalog + brand contract)`);
    } else {
      const waiver = packet.assembly?.template_certification?.waiver;
      if (waiver && isNonEmptyString(waiver.reason)) {
        addIssue(warnings, "assembly.template_certification", `Template family "${decidedFamily}" is NOT certified; proceeding under recorded waiver: ${waiver.reason}. Deterministic assembly, residue QA, and pricing contracts do not cover this family.`);
      } else {
        addIssue(errors, "assembly.template_certification", `Template family "${decidedFamily}" is not certified. Certified families: ${[...certifiedTemplateFamilies()].sort().join(", ")}. Pick a certified family, or rerun prepare-build with --allow-uncertified-template "<reason>" to record an explicit waiver.`);
      }
    }
  }

  const deployUrl = packet.deploy?.preview_url || packet.deploy?.production_url;
  if (packet.campaign?.allowed_domains_confirmed !== true) {
    if (isLocalhostDevelopmentOrigin(deployUrl)) {
      ready.push("Deploy URL is localhost; Campaigns App treats localhost on any port as a Development domain, so SDK initialization is allowed and analytics are suppressed for local QA.");
    } else {
      addIssue(warnings, "campaign.allowed_domains_confirmed", "Non-localhost preview/production origins are not confirmed in the Campaigns App SDK origin allowlist. SDK runtime checks may be blocked after deploy.");
    }
  }

  if (synthesizedBuiltSite) {
    const builtPages = (Array.isArray(packet.pages) ? packet.pages : []).map((page) => ({
      page_id: String(page?.page_id || page?.id || page?.route || "page"),
      type: String(page?.type || page?.page_type || "page"),
      role: pageRole(String(page?.type || page?.page_type || "page")),
      route: typeof page?.route === "string" ? page.route : null,
    }));
    derived.scope = {
      mode: "built_site",
      built_pages: builtPages,
      out_of_scope_pages: [],
      previewable_routes: builtPages.map((page) => ({ page_id: page.page_id, type: page.type, route: page.route })),
      blocked_runtime_pages: [],
    };
    derived.source_root = null;
  } else {
    const sourceRoot = resolveFromFile(packetPath, packet.source_html?.root);
    derived.source_root = sourceRoot;
    if (!sourceRoot || !existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
      addIssue(errors, "source_html.root", `Source root does not exist: ${packet.source_html?.root}`);
    }
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

  let spec = null;
  if (synthesizedBuiltSite) {
    derived.spec_path = null;
    ready.push("Synthesized built-site packet skips CampaignSpec/source checks; built-output gates should run through doctor --built or qa --site.");
  } else {
    const specPath = resolveFromFile(packetPath, packet.spec?.local_path);
    derived.spec_path = specPath;
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
  }

  if (synthesizedBuiltSite) {
    ready.push("Packet source/proof checks skipped for synthesized built-site packet");
  } else {
    runDoctorChecks(PACKET_DOCTOR_CHECKS, { packet, packetPath, spec, context: buildState.context, report: buildState.report, errors, warnings, ready, derived, buildState });
  }

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

function validateBuildBrief(packet, packetPath, spec, context, errors, warnings, ready) {
  const briefRef = packet.build_brief || context?.build_brief || null;
  const normalizedPath = optionalString(packet.build_brief?.normalized_path)
    || optionalString(context?.build_brief?.normalized_path);
  if (!briefRef || !normalizedPath) {
    addIssue(warnings, "build_brief.missing", "No Campaign Build Brief artifact is referenced. Existing builds may continue, but new build intake should provide or generate .campaign-runtime/input/campaign-build-brief.normalized.json so business/design decisions are durable.");
    return;
  }

  const resolvedPath = resolveFromFile(packetPath, normalizedPath);
  if (!resolvedPath || !existsSync(resolvedPath)) {
    addIssue(errors, "build_brief.normalized_path", `Campaign Build Brief normalized artifact is missing: ${normalizedPath}`);
    return;
  }

  const brief = readJson(resolvedPath);
  const result = validateCampaignBuildBriefArtifact(brief, { spec });
  for (const issue of result.errors) errors.push(issue);
  for (const issue of result.warnings) warnings.push(issue);
  ready.push(...result.ready);

  if (context?.build_brief?.status && brief.status && context.build_brief.status !== brief.status) {
    addIssue(warnings, "build_brief.context_status", `Build context says brief status is "${context.build_brief.status}" but normalized artifact says "${brief.status}". Rerun prepare-build to refresh the handoff.`);
  }
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
      `CampaignSpec campaign is missing required Store Profile field for page-kit campaigns.json: ${missing.join(", ")}. Add ${missing.map((field) => `campaign.${field}`).join(", ")} to the CampaignSpec Store Profile, then rerun start/prepare-build. Campaigns OS does not infer or silently mutate these storefront/legal values.`,
      {
        missing_fields: missing.map((field) => `campaign.${field}`),
        repair: {
          owner: "operator",
          action: "Update the CampaignSpec Store Profile export with merchant storefront metadata, then rerun campaigns-os start/prepare-build.",
          example_patch: Object.fromEntries(missing.map((field) => [field, field === "store_url" ? "https://<merchant-store-domain>" : "<merchant value>"])),
        },
      }
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

// Route drift: a CampaignSpec page whose declared route has no built page at
// that path. page-kit derives the public route from the source FILENAME, so a
// file named presell-running.html builds at /presell-running/ even if the spec
// page_url says "presell/". QA resolves page URLs from the spec page_url, so
// this drift makes QA fetch phantom URLs (404s) and misreport pages as down —
// exactly what happened on the Shield QA (presell/landing). validateBuiltOutputPages
// silently skips missing pages, so this surfaces the drift and the actual
// built routes for reconciliation. See the Shield build QA (#1).
export function validateBuiltRouteDrift(spec, packet, errors, warnings, ready, derived, buildState = {}) {
  const pages = activeSpecPages(spec);
  if (pages.length === 0) return;
  const targetRepo = derived.target_repo;
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  const siteRoot = targetRepo && publicRouteSlug ? join(targetRepo, "_site", publicRouteSlug) : null;
  if (!siteRoot || !existsSync(siteRoot)) return;

  const claimed = new Set();
  const drifted = [];
  const unverifiable = [];
  for (const page of pages) {
    const builtPath = builtHtmlPathForPage(targetRepo, publicRouteSlug, page, derived);
    if (!builtPath) {
      // No page_url / source permalink to resolve a route from: doctor cannot
      // determine the expected route, so this is "unverifiable", not drift.
      unverifiable.push({ page_id: page.id, type: page.type || "page", reason: "no page_url / source permalink to resolve an expected route" });
      continue;
    }
    if (existsSync(builtPath)) {
      claimed.add(resolve(builtPath));
      continue;
    }
    const segments = [publicRouteSlug, ...relFromDir(siteRoot, dirname(builtPath)).split("/")].filter((segment) => segment && segment !== ".");
    drifted.push({
      page_id: page.id,
      type: page.type || "page",
      expected_route: `/${segments.join("/")}/`,
    });
  }

  const verifiedNote = `${claimed.size}/${pages.length} verified${unverifiable.length ? `, ${unverifiable.length} unverifiable` : ""}`;
  if (drifted.length === 0) {
    ready.push(`Built routes match CampaignSpec page routes (${verifiedNote})`);
    if (unverifiable.length) {
      addIssue(
        warnings,
        "built_output.route_unverifiable",
        `Doctor could not determine the expected route for ${unverifiable.length} CampaignSpec page(s) (no page_url / source permalink): ${unverifiable.map((u) => `"${u.page_id}" (${u.type})`).join(", ")}.`,
        { unverifiable },
      );
    }
    return;
  }

  const scope = resolveBuiltSiteScope(targetRepo, { slug: publicRouteSlug });
  const unmatched = (scope.ok ? scope.pages : [])
    .filter((builtPage) => !claimed.has(resolve(builtPage.built_path)))
    .map((builtPage) => `/${publicRouteSlug}/${builtPage.route ? `${builtPage.route}/` : ""}`.replace(/\/{2,}/g, "/"));
  const assemblyComplete = isStageComplete(buildState.report, "assembly");
  addIssue(
    assemblyComplete ? errors : warnings,
    "built_output.route_drift",
    `CampaignSpec page(s) have no built page at their declared route: ${drifted.map((d) => `"${d.page_id}" (${d.type}) → ${d.expected_route}`).join("; ")}. `
      + (unmatched.length ? `Built output has unmatched route(s): ${unmatched.join(", ")}. ` : "")
      + (unverifiable.length ? `Unverifiable (no page_url): ${unverifiable.map((u) => `"${u.page_id}"`).join(", ")}. ` : "")
      + `page-kit routes by source filename, so reconcile the spec page_url with the built route — otherwise QA (which resolves URLs from page_url) targets phantom URLs and reports live pages as 404.`,
    { drifted, unmatched_built_routes: unmatched, unverifiable, verified_count: claimed.size },
  );
}

function validateBuildSummary(spec, packet, errors, warnings, ready, derived, buildState = {}) {
  const targetRepo = derived.target_repo;
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  const result = evaluatePageKitBuildSummary({
    targetRepo,
    publicRouteSlug,
    activePages: activeSpecPages(spec),
    assemblyComplete: isStageComplete(buildState.report, "assembly"),
    builtPathForPage: (page) => builtHtmlPathForPage(targetRepo, publicRouteSlug, page, derived),
  });
  for (const issue of result.errors) addIssue(errors, issue.code, issue.message, issue.detail ?? null);
  for (const issue of result.warnings) addIssue(warnings, issue.code, issue.message, issue.detail ?? null);
  ready.push(...result.ready);
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
  validateBuiltPreCheckoutBootstrap(content, builtPath, targetRepo, page, issueTarget);
  validateBuiltBumpPricing(content, builtPath, targetRepo, page, issueTarget);
  validateBuiltStarterLogoResidue(content, builtPath, targetRepo, page, issueTarget);
  validateBuiltPageKitAssetPaths(content, builtPath, targetRepo, page, publicRouteSlug, issueTarget);
  validateBuiltScriptAssets(content, builtPath, targetRepo, page, publicRouteSlug, issueTarget);
  validateBuiltCommerceRefs(content, builtPath, targetRepo, page, spec, issueTarget);
  validateBuiltAnalyticsContract(content, builtPath, targetRepo, page, spec, issueTarget);
}

// Build-time enforcement of the declared analytics contract (CampaignSpec
// `analytics` block). This is the static twin of the runtime QA correctness
// leg: where QA confirms a content param FIRES on a live page, this confirms the
// built page even HAS a handler for it — catching the gap before QA runs.
//
// Specifically the "?reviews=n with no handler" case from the Chamelo Shield
// build: the spec (or a synthesized one) declares a content param, but the
// built page never wired `data-next-hide="param.<name>=='n'"`, so the param
// silently no-ops. Only fires when the spec declares `analytics.params.content`;
// silent otherwise (the common case until specs carry an analytics block).
export function validateBuiltAnalyticsContract(content, builtPath, targetRepo, page, spec, issueTarget) {
  const contentParams = spec?.analytics?.params?.content;
  if (!Array.isArray(contentParams) || contentParams.length === 0) return;
  const relPath = relFromDir(targetRepo, builtPath);
  for (const cp of contentParams) {
    const name = typeof cp?.name === "string" ? cp.name.trim() : "";
    if (!name) continue;
    // A content param applies to this page when `pages` is unspecified (all
    // pages) or explicitly lists this page id. An explicit empty `pages: []`
    // (applies to no page) is a spec-shape misconfiguration flagged once at
    // spec-validation time by AnalyticsContractShape, not per built page here.
    const pages = Array.isArray(cp.pages) ? cp.pages : null;
    if (pages && !pages.includes(page.id)) continue;
    // The SDK drives content-param visibility via data-next-hide/show using
    // `param.<name>` (persisted to sessionStorage). Require the reference to sit
    // inside an actual data-next-hide/show attribute — a bare `param.<name>` in
    // a script/comment/pixel is not a handler (avoids false negatives).
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const handlerPattern = new RegExp(
      `data-next-(?:hide|show)\\s*=\\s*["'][^"']*\\bparam\\.${escaped}\\b[^"']*["']`,
      "i",
    );
    if (!handlerPattern.test(content)) {
      addIssue(
        issueTarget,
        "analytics_contract.content_param_no_handler",
        `Built page "${page.id}" declares analytics content param "?${name}" but has no data-next-hide/show="param.${name}…" handler. The param will silently no-op — the Chamelo Shield "?reviews=n with no handler" gap.`,
        { page_id: page.id, file: relPath, param: name },
      );
    }
  }
}

// Per-page starter-logo residue, scanned against the BUILT `_site/<slug>`
// output. The starter brand logo (next-logo.png on img.brand-logo) must be
// swapped for the campaign's real logo on every page.
//
// Division of responsibility vs the existing generic residue scan: the packet
// path already emits `template_contract.literal_residue` (via
// collectGenericTemplateResidueMatches, which includes the next-logo pattern),
// but that scan runs against `derived.target_output_dir` — the page-kit SOURCE
// dir (src/<slug>) — and is gated on assembly-complete. This check is the
// BUILT-output signal: per page, unconditional, over `_site/<slug>`. A logo
// that survives the page-kit build into _site (the receipt case) is caught here
// even when the source scan didn't run or was a non-blocking source-side note.
// The two can both fire for one logo (it lives in source AND built); fixing the
// source and rebuilding clears both. See the Shield build QA (#5).
export function validateBuiltStarterLogoResidue(content, builtPath, targetRepo, page, issueTarget) {
  const occurrences = (content.match(/\bnext-logo\.(?:png|svg|webp)\b/gi) || []).length;
  if (occurrences === 0) return;
  addIssue(
    issueTarget,
    "built_output.starter_logo_residue",
    `Built page "${page.id}" still references the starter logo next-logo.png (${occurrences} occurrence(s)). Replace the .brand-logo asset with the campaign's real logo before deploy.`,
    { page_id: page.id, file: relFromDir(targetRepo, builtPath), occurrences },
  );
}

// Pre-checkout pages (presell/landing — SDK page_type "product") must ship the
// Campaign Cart bootstrap, not just inert data-next attributes. Without the
// loader + next-page-type meta, every SDK feature silently no-ops: conditional
// visibility (param.banner/param.seen), utmTransfer (UTM/query carry-through to
// checkout — top-of-funnel ad attribution), and SDK analytics. The generic
// runtime-marker check above passes on a lone data-next-* attribute, so this
// dedicated check guards the pre-checkout boundary. See the Shield build
// learnings (A1): base-presell.html / base-landing.html shipped without it.
const PRE_CHECKOUT_PAGE_TYPES = new Set([
  "presell", "advertorial", "listicle", "review",
  "landing", "lander", "lp", "product",
]);

function sdkLoaderScriptPresent(content) {
  // Only the campaign-cart loader counts. A loose `loader.js` match would let an
  // unrelated bundle (analytics/lazy-image loader) falsely satisfy the check and
  // re-introduce the missing-SDK bug, so the src must identify the campaign-cart
  // loader specifically. We do not scan for inline ESM imports: that is not a
  // real bootstrap path for this SDK and is trivially spoofed by a comment or a
  // JSON <script> blob.
  for (const tag of content.matchAll(/<script\b[^>]*>/gi)) {
    const srcMatch = tag[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) continue;
    if (/campaign-cart(?:@[^"']*)?\/dist\/loader\.js/i.test(srcMatch[1])) return true;
  }
  return false;
}

// Order-bump templates (bump-check01/bump-switch01) ship BOTH a per-unit price
// row (Option A) and a line-total price row (Option B) behind Liquid guards,
// with a "pick ONE" comment. If a build leaves both rendered, the bump shows
// doubled prices. The template now defaults to per-unit only, so this guards
// the built output against a regression where both rows survive. See the
// Shield build learnings (B2). Spurious strikethrough (compare == price) is
// covered separately as a polish-gate evidence requirement.
const BUMP_BLOCK_PATTERN = /data-component\s*=\s*["']prepurchase-upsell["']/gi;
const BUMP_PER_UNIT_DISPLAYS = ["unitPrice", "originalUnitPrice"];
const BUMP_LINE_TOTAL_DISPLAYS = ["price", "originalPrice"];

function bumpDisplaysPresent(block, displays) {
  return displays.some((name) => new RegExp(`data-next-toggle-display\\s*=\\s*["']${name}["']`, "i").test(block));
}

const CHECKOUT_BUMP_PAGE_TYPES = new Set(["checkout", "select"]);

export function validateBuiltBumpPricing(content, builtPath, targetRepo, page, issueTarget) {
  const type = String(page?.type || page?.page_type || "").toLowerCase().trim();
  if (!CHECKOUT_BUMP_PAGE_TYPES.has(type)) return;

  // Slice the document into per-bump blocks at each prepurchase-upsell anchor.
  const anchorOffsets = [...content.matchAll(BUMP_BLOCK_PATTERN)].map((match) => match.index);
  if (anchorOffsets.length === 0) return;
  const relPath = relFromDir(targetRepo, builtPath);
  let doubled = 0;
  for (let i = 0; i < anchorOffsets.length; i += 1) {
    const block = content.slice(anchorOffsets[i], anchorOffsets[i + 1] ?? content.length);
    if (bumpDisplaysPresent(block, BUMP_PER_UNIT_DISPLAYS) && bumpDisplaysPresent(block, BUMP_LINE_TOTAL_DISPLAYS)) {
      doubled += 1;
    }
  }
  if (doubled > 0) {
    addIssue(
      issueTarget,
      "built_output.bump_double_price",
      `Built page "${page.id}" renders ${doubled} order bump(s) with BOTH a per-unit price row (Option A) and a line-total price row (Option B). Pick one: pass show_per_unit_price / show_line_total_price to the bump include so a single price row renders (rendering both doubles the displayed price).`,
      { page_id: page.id, file: relPath, doubled_bumps: doubled },
    );
  }
}

export function validateBuiltPreCheckoutBootstrap(content, builtPath, targetRepo, page, issueTarget) {
  const type = String(page?.type || page?.page_type || "").toLowerCase().trim();
  if (!PRE_CHECKOUT_PAGE_TYPES.has(type)) return;

  const relPath = relFromDir(targetRepo, builtPath);
  const hasLoader = sdkLoaderScriptPresent(content);
  const hasPageTypeMeta = isNonEmptyString(extractMetaContent(content, "next-page-type"));
  if (hasLoader && hasPageTypeMeta) return;

  const missing = [
    !hasLoader ? "the Campaign Cart loader script (campaign-cart@v{sdk_version}/dist/loader.js)" : null,
    !hasPageTypeMeta ? 'the <meta name="next-page-type"> tag' : null,
  ].filter(Boolean);
  addIssue(
    issueTarget,
    "built_output.pre_checkout_sdk_bootstrap",
    `SDK not bootstrapped on pre-checkout page "${page.id}" (type "${type}"): missing ${missing.join(" and ")}. Without it, conditional visibility (param.banner/param.seen), utmTransfer (UTM carry-through to checkout — ad attribution), and SDK analytics silently no-op. Emit the same config.js → loader.js → next-funnel/next-page-type bootstrap that the checkout layout uses.`,
    { page_id: page.id, file: relPath, missing: { loader: !hasLoader, page_type_meta: !hasPageTypeMeta } },
  );
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
  validateSourceHtmlManifestAtRoot(sourceRoot, { spec, errors, warnings, ready });
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

function validateSourceHtmlManifestAtRoot(sourceRoot, { spec, errors, warnings, ready } = {}) {
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
  validateSourceProducerProvenance(result.manifest, { spec, errors, warnings, ready });
  ready.push(`Source-html manifest ${SOURCE_HTML_MANIFEST_SCHEMA} validated`);
}

function validateSourceProducerProvenance(manifest, { spec, errors, warnings, ready }) {
  const generator = optionalString(manifest?.generator) || "";
  const rawProvenance = manifest?.producer_provenance;
  const provenance = isObject(rawProvenance) ? rawProvenance : {};
  const expectsFigma = generator.startsWith("figma-sections-export@") || activeSpecPages(spec).some(hasFigmaDesignSource);
  if (!expectsFigma) return;

  if (!rawProvenance) {
    addIssue(
      errors,
      "source_html.producer_provenance",
      "Figma source manifest is missing producer_provenance. Re-run figma-sections-export handoff so Campaigns OS can gate semantic exporter provenance before assembly."
    );
  }

  if (provenance.source_type !== "semantic_figma_export") {
    addIssue(
      errors,
      "source_html.producer_provenance.source_type",
      `Figma source manifest source_type is "${provenance.source_type || "missing"}"; expected "semantic_figma_export". Screenshot or hand-authored fallback output cannot satisfy the Figma provenance gate.`
    );
  }
  if (provenance.screenshot_fallback_used !== false) {
    addIssue(
      errors,
      "source_html.producer_provenance.screenshot_fallback_used",
      "Figma source manifest reports screenshot_fallback_used=true. Re-run semantic figma-sections-export before assembly."
    );
  }
  if (!Number.isInteger(provenance.semantic_section_count) || provenance.semantic_section_count <= 0) {
    addIssue(
      errors,
      "source_html.producer_provenance.semantic_section_count",
      "Figma source manifest must report semantic_section_count > 0."
    );
  }
  if (!SOURCE_HASH_PATTERN.test(String(provenance.material_fingerprint || ""))) {
    addIssue(
      errors,
      "source_html.producer_provenance.material_fingerprint",
      "Figma source manifest must include a 64-character material_fingerprint over the handed-off source package."
    );
  }

  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  if (!files.some((entry) => entry.role === "partial")) {
    addIssue(errors, "source_html.files.partial", "Figma source manifest files[] must include section partials.");
  }
  if (!files.some((entry) => entry.role === "asset")) {
    addIssue(errors, "source_html.files.asset", "Figma source manifest files[] must include exported assets.");
  }

  const sectionExports = Array.isArray(provenance.section_exports) ? provenance.section_exports : [];
  if (!sectionExports.length) {
    addIssue(errors, "source_html.producer_provenance.section_exports", "Figma source manifest must include section_exports with Figma node IDs and extraction commands.");
  } else {
    const withoutNodeIds = sectionExports
      .filter((entry) => {
        const nodeIds = isObject(entry?.node_ids) ? entry.node_ids : null;
        return !nodeIds || !Object.keys(nodeIds).length;
      })
      .map((entry) => entry?.section || "unknown");
    if (withoutNodeIds.length) {
      addIssue(
        warnings,
        "source_html.producer_provenance.section_exports.node_ids",
        `Some Figma section exports do not list node_ids: ${withoutNodeIds.slice(0, 6).join(", ")}${withoutNodeIds.length > 6 ? ", ..." : ""}.`
      );
    }
  }

  if (errors.every((issue) => !String(issue.code || "").startsWith("source_html.producer_provenance") && !["source_html.files.partial", "source_html.files.asset"].includes(issue.code))) {
    ready.push("Figma producer provenance gate passed: semantic_figma_export with package fingerprint");
  }
}

function hasFigmaDesignSource(page) {
  const designSource = page && isObject(page.design_source) ? page.design_source : null;
  return Boolean(designSource && (String(designSource.type || "").toLowerCase() === "figma" || /figma\.com\//i.test(optionalString(designSource.file_url))));
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

function isAutomatableTemplateFamily(family) {
  return isNonEmptyString(family) && family !== "undecided" && family !== "custom";
}

function loadTemplateFamilyBrandContract(family, errors, warnings, { required = false } = {}) {
  try {
    const contract = resolveTemplateBrandContract(family);
    if (!contract && required) {
      addIssue(
        errors,
        "template_contract.brand_contract",
        `Template family "${family}" has no brand/residue/pricing contract at contracts/template-brand-contract.${family}.v0.json. Add the contract before treating this family as promoted/agent-ready.`,
        {
          template_family: family,
          reason: "missing_file",
          contract_path: `contracts/template-brand-contract.${family}.v0.json`,
        },
      );
    }
    return contract;
  } catch (error) {
    addIssue(
      required ? errors : warnings,
      "template_contract.brand_contract",
      `Template brand contract for "${family}" failed to load: ${error.message}`,
      templateBrandContractErrorDetail(error, family),
    );
    return null;
  }
}

function templateBrandContractErrorDetail(error, family) {
  return {
    template_family: family || null,
    reason: typeof error?.code === "string" ? error.code : "load_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function validateCommerceCatalog(packet, packetPath, spec, errors, warnings, ready, derived = {}, buildState = {}) {
  const family = packet.assembly?.template_family;
  // Match the private doctor (build-packet.js): the ported template_contract.*
  // checks below do not apply to non-automatable families. The pre-existing
  // agentContract / demo_ref / shipping checks keep running for all families.
  const familyAutomatable = isAutomatableTemplateFamily(family);
  const catalogInfo = packet.assembly?.commerce_catalog || {};
  if (catalogInfo.required !== true) return;
  const catalogPath = resolveFromFile(packetPath, catalogInfo.path || "../contracts/commerce-surface-catalog.json");
  if (!catalogPath || !existsSync(catalogPath)) {
    addIssue(errors, "assembly.commerce_catalog.path", "Commerce catalog is required but not found.");
    return;
  }
  const catalog = resolveCommerceCatalog(catalogPath);
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
  const brandContract = loadTemplateFamilyBrandContract(family, errors, warnings, { required: familyAutomatable });
  if (brandContract) {
    ready.push(`Template brand/residue/pricing contract loaded for ${family}`);
    validateTemplateFamilyInventory(brandContract, errors, ready);
  }
  if (familyAutomatable && contract.status && contract.status !== "agent-ready") {
    addIssue(warnings, "template_contract.status", `Template family "${family}" contract status is "${contract.status}"; treat this as guided assembly, not full automation.`);
  }
  const assemblyComplete = isStageComplete(buildState.report, "assembly");
  if (assemblyComplete) {
    validateBuiltContractResidue(contract, warnings, ready, derived, spec);
    // H3.1/H3.2: pre-QA warnings off the family brand contract. Doctor warns
    // (the fix happens during build/polish); browser QA enforces the same
    // placeholder-text terms as a blocker in the verdict.
    validateBuiltPlaceholderTextResidue(brandContract, warnings, ready, derived);
    validateBuiltDemoAssetFidelity(brandContract, warnings, ready, derived);
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
    validateCodeLessUpsellOfferBinding({ familyAutomatable, contract, family, upsellPages, errors, ready });
    validateExitPopContract(brandContract, spec, family, warnings, ready, derived, buildState);
  }
}

function validateCodeLessUpsellOfferBinding({ familyAutomatable, contract, family, upsellPages, errors, ready }) {
  if (!familyAutomatable || !Array.isArray(upsellPages) || upsellPages.length === 0) return;
  const usesVoucherJson = contractMentions(contract, /\bvouchers_json\b/, ["replaceFromSpecOrApi", "demoOnlyValues", "optionalWhenSupported"]);
  const supportsOfferRef = contractMentions(contract, /\boffer_ref(?:_id)?\b/, ["replaceFromSpecOrApi", "demoOnlyValues", "optionalWhenSupported", "requiredWhenCloning"]);
  if (!usesVoucherJson || supportsOfferRef) return;

  const codeLessDiscountOffers = [];
  for (const page of upsellPages) {
    for (const offer of Array.isArray(page.offers) ? page.offers : []) {
      if (!isCodeLessDiscountOffer(offer)) continue;
      codeLessDiscountOffers.push({
        page_id: page.id,
        label: page.label || null,
        offer_ref_id: offer.ref_id || offer.id || null,
        benefit_type: offer.benefit?.type || null,
        benefit_value: offer.benefit?.value || null,
      });
    }
  }

  if (!codeLessDiscountOffers.length) {
    ready.push(`${family} upsell offers have code-backed discounts or no code-less discount offer binding requirement`);
    return;
  }

  addIssue(
    errors,
    "template_contract.upsell_offer_binding",
    `Template family "${family}" exposes post-purchase upsell vouchers_json but CampaignSpec has code-less discount offer refs: ${codeLessDiscountOffers.map((offer) => `${offer.page_id}:${offer.offer_ref_id || "unknown"}`).join(", ")}. Add a supported offer-ref binding to the template/SDK adapter, use a code-backed offer, or block assembly; otherwise accepted upsells can commit at full price.`,
    { offers: codeLessDiscountOffers, template_family: family }
  );
}

function isCodeLessDiscountOffer(offer) {
  if (!isObject(offer)) return false;
  if (isNonEmptyString(offer.code)) return false;
  if (offer.ref_id === undefined && offer.id === undefined) return false;
  const benefit = isObject(offer.benefit) ? offer.benefit : null;
  const benefitType = String(benefit?.type || "").toLowerCase();
  const value = benefit?.value;
  if (!benefit || !/(percentage|percent|discount|fixed|amount)/.test(benefitType)) return false;
  if (value === undefined || value === null) return false;
  return String(value).trim().length > 0 && Number.isFinite(Number(value));
}

export function validateTemplateFamilyInventory(contract, errors, ready) {
  const inventory = contract.family_inventory;
  if (!isObject(inventory)) {
    addIssue(errors, "template_contract.family_inventory", `Template brand contract for "${contract.family}" is missing family_inventory.`);
    return;
  }
  const required = [
    "supported_pages",
    "required_sdk_anchors",
    "theme_insertion_point",
    "default_color_residue",
    "pricing_presentation",
    "bundle_picker",
    "order_bump",
    "upsell_downsell",
    "exit_pop",
    "qa_selectors",
  ];
  const missing = required.filter((key) => !hasPopulatedInventoryValue(inventory[key]));
  if (missing.length) {
    addIssue(errors, "template_contract.family_inventory", `Template brand contract for "${contract.family}" family_inventory is missing or empty: ${missing.join(", ")}.`);
    return;
  }
  ready.push(`Template family inventory matrix loaded for ${contract.family}`);
}

function hasPopulatedInventoryValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.values(value).some((entry) => hasPopulatedInventoryValue(entry));
  return true;
}

export function validateExitPopContract(contract, spec, family, warnings, ready, derived, buildState = {}) {
  const exitPop = contract?.exit_pop;
  if (!exitPop || !spec) return;
  const hasGovernedOfferSurface = activeSpecPages(spec).some((page) => (
    page?.type === "checkout" && (page?.exit_intent?.enabled === true || page?.promo_code_input?.enabled === true)
  ));
  if (hasGovernedOfferSurface) {
    ready.push(`${family} exit-pop/promo-code behavior is governed by CampaignSpec offer-surface fields`);
    return;
  }

  const inventoryExitPop = contract.family_inventory?.exit_pop;
  if (!isStageComplete(buildState.report, "assembly")) {
    if (inventoryExitPop?.default_included === true) {
      addIssue(
        warnings,
        "template_contract.exit_pop",
        `Template family "${family}" includes an exit-pop by default, but active CampaignSpec checkout pages do not define exit_intent or promo_code_input. Strip the widget or wire a mapped offer/code through the SDK coupon path during build.`
      );
    }
    return;
  }

  const targetOutputDir = derived.target_output_dir;
  if (!targetOutputDir || !existsSync(targetOutputDir) || !statSync(targetOutputDir).isDirectory()) return;
  const residueHits = collectLiteralMatches(targetOutputDir, exitPop.residue_literals || []);
  if (residueHits.length) {
    addIssue(
      warnings,
      "template_contract.exit_pop_residue",
      `Assembly is recorded complete, but target output contains exit-pop/template offer residue while CampaignSpec has no checkout exit_intent or promo_code_input: ${summarizeCopyMatches(residueHits)}. Strip it or add a mapped offer surface.`
    );
  } else {
    ready.push(`Built target output has no ungoverned ${family} exit-pop residue`);
  }
  const blankHits = collectLiteralMatches(targetOutputDir, exitPop.blank_widget_literals || []);
  if (blankHits.length) {
    addIssue(
      warnings,
      "template_contract.exit_pop_blank_widget",
      `Assembly is recorded complete, but target output still contains default/blank exit-pop widget copy or coupon placeholders: ${summarizeCopyMatches(blankHits)}.`
    );
  }
}

function validateBuiltContractResidue(contract, warnings, ready, derived, spec = null) {
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
  } else {
    addIssue(
      warnings,
      "frontmatter.build_residue",
      `Assembly is recorded complete, but target output still contains starter contract residue: ${summarizeCopyMatches(hits)}.`
    );
  }

  const genericHits = collectGenericTemplateResidueMatches(targetOutputDir);
  if (genericHits.length) {
    addIssue(
      warnings,
      "template_contract.literal_residue",
      `Assembly is recorded complete, but built output still contains generic starter/template placeholders: ${summarizeCopyMatches(genericHits)}. Replace these from CampaignSpec/API or remove dead template references before QA.`
    );
  } else {
    ready.push("Built target output has no generic starter placeholder or promo-code residue");
  }

  const maxDiscount = maxSpecDiscountPercent(spec);
  if (maxDiscount !== null) {
    const discountHits = collectOverstatedDiscountClaimMatches(targetOutputDir, maxDiscount);
    if (discountHits.length) {
      addIssue(
        warnings,
        "template_contract.discount_claim_residue",
        `Assembly is recorded complete, but built output claims discount percentages above the CampaignSpec maximum (${formatPercent(maxDiscount)}): ${summarizeCopyMatches(discountHits)}. Generate promo/banner/timer copy from actual offers and vouchers.`
      );
    } else {
      ready.push(`Built target output has no promo discount claims above CampaignSpec max (${formatPercent(maxDiscount)})`);
    }
  } else {
    const discountClaims = collectDiscountClaimMatches(targetOutputDir);
    if (discountClaims.length) {
      addIssue(
        warnings,
        "template_contract.discount_claim_unverified",
        `Assembly is recorded complete, but built output contains promo discount percentage claims without explicit CampaignSpec percentage discount values: ${summarizeCopyMatches(discountClaims)}. Confirm the intended business logic with the build request/merchant notes or remove the claims before launch.`
      );
    } else {
      ready.push("Built target output has no promo discount percentage claims requiring CampaignSpec verification");
    }
  }
}

// H3.1 (doctor surface): literal placeholder TEXT in built HTML. Word-boundary
// matched off the family brand contract's placeholder_text_residue.terms, so
// the doctor warning and the browser QA blocker key off one declared term set.
// Scans rendered HTML (not the includes/layouts the family ships) — broad net
// pre-QA; the browser gate narrows to visible text and blocks.
export function validateBuiltPlaceholderTextResidue(brandContract, warnings, ready, derived) {
  const config = placeholderTextResidueConfig(brandContract);
  if (!config) return;
  const targetOutputDir = derived.target_output_dir;
  if (!targetOutputDir || !existsSync(targetOutputDir) || !statSync(targetOutputDir).isDirectory()) return;
  const hits = collectPlaceholderTextResidueMatches(targetOutputDir, config.terms);
  if (hits.length) {
    const terms = [...new Set(hits.map((hit) => hit.label))].join(", ");
    addIssue(
      warnings,
      "template_contract.placeholder_text_residue",
      `Assembly is recorded complete, but built output still contains literal template placeholder text (${terms}): ${summarizeCopyMatches(hits)}. Replace with CampaignSpec/design copy; browser QA blocks on these terms.`,
    );
  } else {
    ready.push("Built target output has no literal template placeholder text");
  }
}

function collectPlaceholderTextResidueMatches(root, terms) {
  const matches = [];
  for (const file of collectHtmlFiles(root)) {
    if (file.path.includes("_includes/") || file.path.includes("_layouts/")) continue;
    const content = readFileSync(join(root, file.path), "utf8");
    for (const match of placeholderTextResidueMatches(content, terms)) {
      matches.push({
        surface: "target",
        path: file.path,
        line: lineNumberAt(content, match.index || 0),
        label: match.term,
        text: match.match,
      });
    }
  }
  return matches;
}

// H3.2 (doctor surface): the family's own demo placeholder assets surviving
// into built output. Reuses the literal-match infra over the demo-asset
// basenames declared in the brand contract. Warning only — the agent re-skins.
export function validateBuiltDemoAssetFidelity(brandContract, warnings, ready, derived) {
  const config = demoAssetConfig(brandContract);
  if (!config || !config.assetBasenames.length) return;
  const targetOutputDir = derived.target_output_dir;
  if (!targetOutputDir || !existsSync(targetOutputDir) || !statSync(targetOutputDir).isDirectory()) return;
  const hits = collectLiteralMatches(targetOutputDir, config.assetBasenames);
  if (hits.length) {
    const assets = [...new Set(hits.map((hit) => hit.label))].join(", ");
    addIssue(
      warnings,
      "template_contract.demo_asset_residue",
      `Assembly is recorded complete, but built output still references template demo assets (${assets}): ${summarizeCopyMatches(hits)}. Re-skin to the campaign's real assets rather than shipping template placeholders.`,
    );
  } else {
    ready.push("Built target output references no template demo placeholder assets");
  }
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

const GENERIC_TEMPLATE_RESIDUE_PATTERNS = [
  { id: "promo_code_placeholder", label: "XXCODE", pattern: /\bXXCODE\b/gi },
  { id: "package_title_placeholder", label: "Package Title", pattern: /\bPackage Title\b/g },
  { id: "product_title_placeholder", label: "Product Title", pattern: /\bProduct Title\b/g },
  { id: "spec_ref_placeholder", label: "SPEC_*_REF", pattern: /\bSPEC_[A-Z0-9_]*_REF\b/g },
  { id: "starter_logo_asset", label: "next-logo.png", pattern: /\bnext-logo\.(?:png|svg|webp)\b/g },
];

function collectGenericTemplateResidueMatches(root) {
  return collectPatternMatches(root, GENERIC_TEMPLATE_RESIDUE_PATTERNS);
}

function collectPatternMatches(root, patterns) {
  if (!patterns.length) return [];
  const matches = [];
  const compiledPatterns = patterns.map((entry) => {
    const flags = entry.pattern.flags.includes("g") ? entry.pattern.flags : `${entry.pattern.flags}g`;
    return { ...entry, regex: new RegExp(entry.pattern.source, flags) };
  });
  for (const file of collectBuiltTextFiles(root)) {
    const content = readFileSync(join(root, file.path), "utf8");
    for (const entry of compiledPatterns) {
      entry.regex.lastIndex = 0;
      for (const match of content.matchAll(entry.regex)) {
        matches.push({
          surface: "target",
          path: file.path,
          line: lineNumberAt(content, match.index || 0),
          label: entry.label,
          text: match[0],
          kind: entry.id,
        });
      }
    }
  }
  return matches;
}

function maxSpecDiscountPercent(spec) {
  if (!spec || typeof spec !== "object") return null;
  const values = [];

  function visit(value, key = "") {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key);
      return;
    }
    if (!value || typeof value !== "object") return;

    if (isPercentDiscountBenefit(value, key)) {
      addPercentValue(values, value.value);
    }

    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (isDiscountPercentKey(entryKey)) addPercentValue(values, entryValue);
      visit(entryValue, entryKey);
    }
  }

  visit(spec);
  return values.length ? Math.max(...values) : null;
}

function isPercentDiscountBenefit(value, key) {
  if (!isObject(value) || !Object.hasOwn(value, "value")) return false;
  const type = normalizeSpecKey(value.type || "");
  if (!/(?:^|_)(?:percent|percentage)(?:_|$)/.test(type)) return false;
  const context = normalizeSpecKey(key);
  if (context === "benefit") return true;
  return /(?:^|_)(?:discount|saving|savings|save|off|offer|promo|coupon|voucher|package)(?:_|$)/.test(type);
}

function isDiscountPercentKey(key) {
  const normalized = normalizeSpecKey(key);
  const mentionsPercent = /(?:^|_)(?:percent|percentage)(?:_|$)/.test(normalized);
  const mentionsOffer = /(?:^|_)(?:discount|saving|savings|save|off|offer|promo|coupon|voucher)(?:_|$)/.test(normalized);
  return mentionsPercent && mentionsOffer;
}

function normalizeSpecKey(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function addPercentValue(values, value) {
  const parsed = Number.parseFloat(String(value ?? "").replace("%", "").trim());
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) values.push(parsed);
}

function collectDiscountClaimMatches(root) {
  const claimPattern = /\b(?:save(?:\s+up\s+to)?\s+(\d{1,3}(?:\.\d+)?)\s*(?:%|\bpercent\b)|(\d{1,3}(?:\.\d+)?)\s*(?:%|\bpercent\b)\s*(?:off|discount)\b)/gi;
  const matches = [];
  for (const file of collectBuiltTextFiles(root)) {
    const content = readFileSync(join(root, file.path), "utf8");
    for (const match of content.matchAll(claimPattern)) {
      const claimed = Number.parseFloat(match[1] || match[2]);
      if (!Number.isFinite(claimed)) continue;
      matches.push({
        surface: "target",
        path: file.path,
        line: lineNumberAt(content, match.index || 0),
        label: `${formatPercent(claimed)} claim`,
        text: match[0],
        claimed_percent: claimed,
      });
    }
  }
  return matches;
}

function collectOverstatedDiscountClaimMatches(root, maxDiscount) {
  return collectDiscountClaimMatches(root)
    .filter((match) => match.claimed_percent > maxDiscount + DISCOUNT_CLAIM_TOLERANCE)
    .map((match) => ({ ...match, max_spec_percent: maxDiscount }));
}

function formatPercent(value) {
  const rounded = Math.round(value * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2)}%`;
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
const POLISH_GATE_BUILD_RERUN_CODES = Object.freeze(new Set([
  "polish.assembly_source_package_fingerprint_missing",
  "polish.assembly_source_package_stale",
]));

function stageIsTerminal(status) {
  const normalized = String(status || "");
  return STAGE_TERMINAL_STATUS_PREFIXES.some((t) => normalized.startsWith(t));
}

function stageIsBlocked(status) {
  return String(status || "") === "blocked";
}

function polishGateRequiresBuild(polishGate) {
  return polishGate?.status === "blocked" && POLISH_GATE_BUILD_RERUN_CODES.has(polishGate.code);
}

function addPolishGateErrors(errors, polishGate, stage) {
  if (!polishGate || polishGate.status !== "blocked") return;
  const commands = (polishGate.required_actions || [])
    .map((action) => action?.command)
    .filter(Boolean);
  addIssue(
    errors,
    `next.${stage}.${polishGate.code}`,
    `${polishGate.reason}${commands.length ? ` Required action: ${commands.join(" | ")}.` : " Run next-campaigns-polish before QA."}`,
    { polish_gate: polishGate },
  );
}

function doctorErrorsAreOnlyPolishGate(errors = []) {
  return errors.length > 0 && errors.every((issue) => String(issue?.code || "").startsWith("polish."));
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
    blocked: stageIsBlocked(status),
    reason: stageIsBlocked(status)
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
   *      the returned stage's recorded status in the report is "blocked".
   *      The picker still returns the stage
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
  const polishGate = doctor?.derived?.polish_gate || evaluatePolishGate({ report });
  if (doctor && !doctor.ok && !doctorErrorsAreOnlyPolishGate(doctor.errors)) {
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

  if (polishGate.status === "blocked") {
    if (polishGateRequiresBuild(polishGate)) {
      return {
        stage: "build",
        reason: polishGate.reason,
      };
    }
    return {
      stage: "polish",
      reason: polishGate.reason,
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
    if (stageIsBlocked(status)) {
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

function nextStage(stage, args, ambient = null) {
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
  const themeGate = doctor.derived?.theme_gate || null;
  const polishGate = doctor.derived?.polish_gate || evaluatePolishGate({ report });
  // Every return path runs through this finalizer so the machine-readable
  // contract is uniform: `gates` (pass/blocked/waived/not_applicable per
  // gate) and `next_actions` (exact commands — not prose) are always present,
  // and the recommendation is recorded on the active run session for
  // deviation telemetry.
  const finalize = (result) => {
    result.gates = buildNextGates({ doctor, report, themeGate, polishGate });
    result.next_actions = buildNextActions({ result, packetPath, packet, themeGate, polishGate, ambient });
    recordNextRecommendation(ambient, result);
    return result;
  };
  const doctorHasOnlyPolishGateErrors = doctorErrorsAreOnlyPolishGate(doctor.errors);
  const errors = [];
  const warnings = [...doctor.warnings];
  const ready = [...doctor.ready];
  if (!doctor.ok && !doctorHasOnlyPolishGateErrors) errors.push(...doctor.errors);

  // Slice 3 Phase 2: when no stage was passed, self-decide. The orchestration
  // loop is: agent calls `next`, gets a stage + prompt, does the work,
  // updates the assembly report's stages.<name>.status, then calls `next`
  // again. Each call re-reads state from disk so the loop is idempotent
  // and recoverable across sessions / machines.
  let picked = null;
  if (!stage) {
    picked = pickNextStage(report, doctor);
    if (picked.stage === "doctor-blocked") {
      return finalize({
        ok: false,
        status: "blocked",
        stage: "doctor-blocked",
        reason: picked.reason,
        errors,
        warnings,
        ready,
        prompt: "Resolve the doctor errors above before continuing. Re-run `campaigns-os doctor --packet <path>` to confirm, then `campaigns-os next --packet <path>` to advance.",
      });
    }
    if (picked.stage === "prepare-build") {
      addPrepareBuildGateErrors(errors, report);
      return finalize({
        ok: false,
        status: "blocked",
        stage: "prepare-build",
        reason: picked.reason,
        errors,
        warnings,
        ready,
        prompt: "Resolve the prepare-build blockers recorded in the assembly report, then rerun `campaigns-os prepare-build` or `campaigns-os start` before continuing.",
        stage_blocked: true,
      });
    }
    if (picked.stage === "done") {
      return finalize({
        ok: true,
        status: "ready",
        stage: "done",
        reason: picked.reason,
        errors,
        warnings,
        ready,
        prompt: "Pipeline complete. All stages in the assembly report are in a terminal status. If you need to re-run a stage, set its status back to \"pending\" in the report and call `next` again. If a run session is active, finish it with `campaigns-os run end` so the Run Record is assembled and the session closes.",
      });
    }
    stage = picked.stage;
  }

  let prompt = "";
  if (stage === "setup") {
    addPrepareBuildGateErrors(errors, report);
    if (!doctor.ok && !doctorHasOnlyPolishGateErrors) addIssue(errors, "next.setup.doctor", "Doctor is blocked; resolve packet errors before setup.");
    prompt = setupPrompt(packetPath, contextPath, reportPath, packet);
  } else if (stage === "build") {
    addPrepareBuildGateErrors(errors, report);
    if (!doctor.ok && !doctorHasOnlyPolishGateErrors) addIssue(errors, "next.build.doctor", "Doctor is blocked; resolve packet errors before build.");
    if (doctor.derived?.scaffold_required) addIssue(errors, "next.build.setup", doctor.derived.scaffold_reason || "Setup is required before build.");
    prompt = buildPrompt(packetPath, contextPath, reportPath, packet);
  } else if (stage === "polish") {
    addPrepareBuildGateErrors(errors, report);
    if (!report) addIssue(errors, "next.polish.report", "Assembly report is required before polish.");
    const assemblyStatus = report?.stages?.assembly?.status || "";
    if (!assemblyStatus.startsWith("completed")) addIssue(errors, "next.polish.assembly", `Assembly status is "${assemblyStatus || "missing"}"; polish expects completed assembly or an explicit blocked/skipped handoff.`);
    if (polishGateRequiresBuild(polishGate)) addPolishGateErrors(errors, polishGate, "polish");
    addThemeGateErrors(errors, themeGate, "polish");
    prompt = polishPrompt(packetPath, reportPath, packet);
  } else if (stage === "deploy") {
    addPrepareBuildGateErrors(errors, report);
    // Slice 3 Phase 2: deploy is an out-of-band step (Netlify / CF Pages /
    // etc.) but it's still a stage in the orchestration loop because the
    // agent needs to know when to fire it and what to record afterwards.
    if (!report) addIssue(errors, "next.deploy.report", "Assembly report is required before deploy.");
    addPolishGateErrors(errors, polishGate, "deploy");
    addThemeGateErrors(errors, themeGate, "deploy");
    prompt = deployPrompt(packetPath, reportPath, packet);
  } else if (stage === "qa") {
    addPrepareBuildGateErrors(errors, report);
    if (!report) addIssue(errors, "next.qa.report", "Assembly report is required before QA.");
    const deployUrl = packet.deploy?.preview_url || packet.deploy?.production_url;
    if (!deployUrl) addIssue(errors, "next.qa.deploy_url", "QA requires deploy.preview_url or deploy.production_url.");
    addPolishGateErrors(errors, polishGate, "qa");
    addThemeGateErrors(errors, themeGate, "qa");
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
  return finalize(result);
}

// Theme gate enforcement for stages past build. A blocked theme gate is an
// ERROR (status "blocked") at polish/deploy/qa: the brand layer is applied
// during build, so once a generatable theme exists the pipeline must not
// advance past build until it is applied or explicitly waived. Mirrors the
// dogfood failure where "needs_review" stayed advisory and starter-blue
// commerce pages shipped through polish, deploy, and a green QA verdict.
function addThemeGateErrors(errors, themeGate, stage) {
  if (!themeGate || themeGate.status !== "blocked") return;
  const commands = themeGate.required_actions.filter((action) => action.command).map((action) => action.command);
  addIssue(
    errors,
    `next.${stage}.theme_gate`,
    `${themeGate.reason}${commands.length ? ` Run: ${commands.join(" | ")}` : ""}`,
    { theme_gate: themeGate },
  );
}

// Gate summary every `next` response carries: one entry per gate with a
// deterministic status, so an agent reads gate state from data instead of
// parsing error prose.
function buildNextGates({ doctor, report, themeGate, polishGate }) {
  const prepareBuildGate = prepareBuildGateIssue(report);
  return [
    {
      id: "doctor",
      status: doctor.ok ? "pass" : "blocked",
      reason: doctor.ok ? "Doctor has no blocking errors." : `Doctor reported ${doctor.errors.length} blocker(s).`,
    },
    {
      id: "prepare_build",
      status: prepareBuildGate ? "blocked" : "pass",
      reason: prepareBuildGate ? prepareBuildGate.reason : "prepare_build stage is terminal.",
    },
    {
      id: "theme_gate",
      status: themeGate?.status || "not_applicable",
      reason: themeGate?.reason || "No theme gate evaluation available.",
      code: themeGate?.code || null,
      waiver: themeGate?.waiver || null,
      required_actions: themeGate?.required_actions || [],
    },
    {
      id: "polish_gate",
      status: polishGate?.status || "not_applicable",
      reason: polishGate?.reason || "No polish gate evaluation available.",
      code: polishGate?.code || null,
      waiver: polishGate?.waiver || null,
      required_actions: polishGate?.required_actions || [],
    },
  ];
}

// Executable next actions: exact commands (or explicitly-manual steps), never
// prose-only guidance. Ordering is the execution order an agent should follow.
function buildNextActions({ result, packetPath, packet, themeGate, polishGate, ambient }) {
  const actions = [];
  const push = (id, kind, command, description) => actions.push({ id, kind, command, description, stage: result.stage });
  if (result.stage === "doctor-blocked") {
    push("doctor_recheck", "command", `campaigns-os doctor --packet ${packetPath} --json`, "Re-run the doctor after resolving the listed errors.");
    return actions;
  }
  if (result.stage === "prepare-build") {
    push("rerun_prepare_build", "command", `campaigns-os start --map-id ${packet.spec?.map_id || "<map-id>"}`, "Rerun prepare-build/start with the original spec, source, and target inputs to clear the recorded blockers.");
    return actions;
  }
  // A blocked theme gate owns the action list for any post-build stage: the
  // gate's required actions ARE the next actions.
  if (themeGate?.status === "blocked" && ["polish", "deploy", "qa"].includes(result.stage)) {
    for (const action of themeGate.required_actions) {
      push(`theme_gate.${action.id}`, action.kind, action.command, action.description);
    }
    push("recheck", "command", `campaigns-os next --packet ${packetPath} --json`, "Re-run next after resolving the theme gate to advance.");
    return actions;
  }
  if (polishGateRequiresBuild(polishGate) && ["build", "polish", "deploy", "qa"].includes(result.stage)) {
    for (const action of polishGate.required_actions || []) {
      push(`polish_gate.${action.id}`, action.kind, action.command, action.description);
    }
    push("recheck", "command", `campaigns-os next --packet ${packetPath} --json`, "Re-run next after rebuilding against the current Design Source Package.");
    return actions;
  }
  if (polishGate?.status === "blocked" && ["deploy", "qa"].includes(result.stage)) {
    for (const action of polishGate.required_actions || []) {
      push(`polish_gate.${action.id}`, action.kind, action.command, action.description);
    }
    push("recheck", "command", `campaigns-os next --packet ${packetPath} --json`, "Re-run next after recording valid Polish evidence.");
    return actions;
  }
  if (result.stage === "setup") {
    push("setup_skill", "skill", "next-campaigns-setup", "Prepare the target page-kit structure and agent context, then record stages.setup in the assembly report.");
  } else if (result.stage === "build") {
    push("build_skill", "skill", "next-campaigns-build", "Assemble the campaign per the build prompt, then record stages.assembly in the assembly report.");
    if (themeGate?.status === "blocked") {
      for (const action of themeGate.required_actions) {
        push(`theme_gate.${action.id}`, action.kind, action.command, `${action.description} (Required before polish/deploy/QA.)`);
      }
    }
  } else if (result.stage === "polish") {
    push("polish_skill", "skill", "next-campaigns-polish", "Run the visual polish pass, capture desktop/mobile evidence, then record stages.polish in the assembly report.");
  } else if (result.stage === "deploy") {
    push("deploy", "manual", null, `Deploy _site/ output to ${packet.deploy?.target || "the deploy target"}, then record deploy.preview_url (or production_url) on the packet and stages.deploy in the assembly report.`);
    push("advance", "command", `campaigns-os next --packet ${packetPath} --json`, "Advance to QA once the deploy URL is recorded.");
  } else if (result.stage === "qa") {
    const url = packet.deploy?.preview_url || packet.deploy?.production_url || "<preview-url>";
    push("install_browser", "command", "npm run qa:install-browser", "Install the Playwright browser once after install/update.");
    push("qa_run", "command", `campaigns-os qa run --packet ${packetPath} --base-url ${url} --browser --test-order common`, "Run browser + typed-card QA and publish the verdict.");
  } else if (result.stage === "done") {
    if (ambient) {
      push("run_end", "command", `campaigns-os run end${ambient.session?.packet ? "" : ` --packet ${packetPath}`}`, "Close the active run session: assemble the aggregated Run Record and clear run-session.json.");
    }
  }
  return actions;
}

// Record the recommendation on the active run session so deviation telemetry
// can compare "what next said" against "what the agent actually ran".
// Best-effort: telemetry never blocks orchestration.
function recordNextRecommendation(ambient, result) {
  if (!ambient) return;
  try {
    const expected = expectedCommandsForStage(result.stage, result.next_actions || []);
    const now = new Date();
    const session = {
      ...ambient.session,
      updated_at: now.toISOString(),
      last_recommendation: buildRecommendation({
        stage: result.stage,
        status: result.status,
        expectedCommands: expected,
        now,
      }),
    };
    writeRunSession(ambient.dir, session);
    ambient.session = session;
  } catch {
    // non-fatal
  }
}

function buildPrompt(packetPath, contextPath, reportPath, packet) {
  const briefPath = packet.build_brief?.normalized_path || "(missing; generate or confirm Campaign Build Brief before business-sensitive assembly)";
  return `Use next-campaigns-build for this Campaigns OS handoff.

Read first:
- Build Packet: ${packetPath}
- Build Context: ${contextPath || "(use packet-adjacent .campaign-runtime/build-context.json if present)"}
- Assembly Report: ${reportPath || "(use packet-adjacent .campaign-runtime/assembly-report.json if present)"}
- Campaign Build Brief: ${briefPath}
- Design Source Package: .campaign-runtime/input/design-source-package.json when present; use report.design_source_package.material_fingerprint as the source context fingerprint.
- Template family: ${packet.assembly.template_family}

Rules:
- Treat CampaignSpec/API as the source for package, shipping, voucher, payment, tracking, footer, and SEO values.
- Treat the Campaign Build Brief as the merchandising/design presentation truth: page authority, palette/CTA style, variant media rules, pricing display strategy, promo/urgency language, payment/trust surfaces, display-name policy, residue policy, and QA expectations. Agents may resolve implementation uncertainty; unresolved brief questions are business uncertainty and should be asked or recorded, not guessed.
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
- Run page-kit build and SDK/template lint, then update stages.assembly.status plus stages.assembly.build_fingerprint before polish. If report.design_source_package.material_fingerprint exists, also record the same value on stages.assembly.source_package_material_fingerprint so Polish can prove the build used the current source context. Build must set stages.polish.status to "required" or "pending" with required_by="build" and required_for=["qa"]; Build must not mark stages.polish as completed/completed_with_warnings/skipped. If you applied a brand theme, record report.theme.status, css_path, commerce_pages, load_order=after-next-core, evidence, and any repair-loop defect.
- Capture the machine-readable build summary as an artifact: \`${PAGE_KIT_BUILD_SUMMARY_CAPTURE_COMMAND}\` (requires next-campaign-page-kit >= 0.1.4). Doctor verifies it for per-page build errors and Page Kit shape warnings (NESTED_NO_PERMALINK, DUPLICATE_OUTPUT, MISSING_FRONTMATTER, LAYOUT_NOT_FOUND). If the installed page-kit predates --json, record that in the assembly report instead of skipping silently.`;
}

function setupPrompt(packetPath, contextPath, reportPath, packet) {
  const briefPath = packet.build_brief?.normalized_path || "(missing)";
  return `Use next-campaigns-setup for this Campaigns OS handoff.

Read first:
- Build Packet: ${packetPath}
- Build Context: ${contextPath}
- Assembly Report: ${reportPath}
- Campaign Build Brief: ${briefPath}
- Target repo: ${packet.assembly.target_repo}
- Output dir: ${packet.assembly.output_dir}

Prepare the target page-kit structure and agent context, then update setup status in both:
- .campaign-runtime/build-context.json scaffold.required/scaffold.mode/handoff fields
- .campaign-runtime/assembly-report.json stages.setup

When copying a starter template family, copy the family as an atomic page-kit slice: pages plus required _includes, _layouts, assets/css, and assets/js. Do not copy only checkout.html and receipt.html.

Do not wire checkout, upsell, receipt, payment, package, voucher, or shipping behavior during setup.`;
}

function polishPrompt(packetPath, reportPath, packet) {
  const briefPath = packet.build_brief?.normalized_path || "(missing)";
  return `Use next-campaigns-polish for this built campaign.

Read first:
- Build Packet: ${packetPath}
- Assembly Report: ${reportPath}
- Campaign Build Brief: ${briefPath}
- Template family: ${packet.assembly.template_family}

Compare source and Campaign Build Brief decisions against built page-kit output, patch only SDK-safe visual surfaces, scan source assets for logo/brand marks before leaving starter-template logos, respect spec-driven removals recorded during build, and capture desktop/mobile evidence.

Record Polish on stages.polish before QA:
- status: completed or completed_with_warnings (or blocked with blockers)
- performed_by: next-campaigns-polish
- source_build_fingerprint: the current stages.assembly.build_fingerprint
- source_package_material_fingerprint: the current report.design_source_package.material_fingerprint when present
- completed_at: ISO timestamp
- evidence.visual_review: representative screenshot paths/URLs
- evidence.brand_review: logo/favicon/brand color checks, including non-template favicon confirmation
- evidence.checkout_review: labels/placeholders, phone alignment, payment display, bump compare-price rule
- evidence.template_residue_review: NEXT Blue/template placeholder/starter favicon/lorem/product residue checks
- evidence.commerce_flow_review: shop single-step direct-entry force-package/product-selector limitation notes
- evidence.issues: open defects with severity and QA-blocking status
- evidence.commands: commands/tool invocations used

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
  const briefPath = packet.build_brief?.normalized_path || "(missing)";
  return `Use next-campaigns-qa for this deployed campaign.

Map ID: ${packet.spec.map_id}
Base URL: ${url}
Build Packet: ${packetPath}
Assembly Report: ${reportPath}
Campaign Build Brief: ${briefPath}
Browser install command:
npm run qa:install-browser

Node QA command:
campaigns-os qa run --packet ${packetPath} --base-url ${url} --browser --test-order common

Run the browser install once after install/update before --browser or --test-order. Test-order proof must exercise the campaign through the Campaign Cart SDK with the browser typed-card flow. Do not create hand-built backend API orders as launch proof. Compare visible placeholders, payment methods, variant media, promo/urgency copy, pricing presentation, and trust/guarantee claims against the Campaign Build Brief. Test Orders use global test cards that bypass the payment gateway and create no transactions, so they are safe to run any time and need no permission flags, packet policy, or merchant setup. Localhost on any port is a globally allowed Development domain for SDK initialization and suppresses Campaigns analytics events; non-localhost preview/production origins still need the SDK origin allowlist. Use --test-order common for the default 3-5 shape sample (checkout, plus accept/decline when there are upsells), an explicit path such as accept-decline-accept for a targeted matrix, or --test-order full for every permutation; then click rendered SDK upsell accept/decline controls for upsell proof. Reuse one test customer email via --test-email or CAMPAIGNS_OS_QA_TEST_EMAIL (a real monitored inbox in internal runs) so repeated QA does not litter the customer list.

Launch readiness note: Campaigns OS can prove the campaign build, SDK wiring, browser behavior, and typed-card order paths. It does not prove the merchant is ready for real shoppers. Before launch, confirm the production storefront URL, live payment methods, shipping markets, legal/support URLs, analytics expectations, and any merchant-side configuration. Treat those as real-shopper readiness items, not Campaigns OS build blockers.

For multi-market campaigns, verify at least one non-default currency/country path: currency display, shipping method names/prices, payment methods, and market-specific copy. Summarize blockers, warnings, and remaining launch risks.`;
}

function buildNextStep(errors, warnings, derived, report = null) {
  const codes = new Set([...errors, ...warnings].map((issue) => issue.code));
  const assemblyStatus = report?.stages?.assembly?.status || "";
  const deployStatus = report?.stages?.deploy?.status || "";
  const qaStatus = report?.stages?.qa?.status || "";
  const assemblyComplete = assemblyStatus.startsWith("completed");
  const polishGate = derived.polish_gate || evaluatePolishGate({ report });
  const polishBlocked = assemblyComplete && polishGate.status === "blocked";
  const polishSatisfied = assemblyComplete && ["pass", "waived"].includes(polishGate.status);
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
  if (codes.has("template_contract.brand_contract") || codes.has("template_contract.family_inventory")) {
    actions.push("Add or repair the selected family's contracts/template-brand-contract.<family>.v0.json, then rerun campaigns-os doctor --packet <packet>.");
  }
  if (codes.has("template_contract.exit_pop") || codes.has("template_contract.exit_pop_residue") || codes.has("template_contract.exit_pop_blank_widget")) {
    actions.push("Strip the default exit-pop widget or wire CampaignSpec checkout exit_intent/promo_code_input to the SDK coupon path before QA.");
  }
  if (codes.has("template_contract.discount_claim_unverified")) {
    actions.push("Confirm any rendered promo discount percentage claims against the build request, merchant notes, or CampaignSpec before launch.");
  }
  if (codes.has("template_contract.placeholder_text_residue")) {
    actions.push("Replace literal template placeholder text (Lorem/Placeholder/TODO/Product Name) with CampaignSpec/design copy before QA; the browser residue gate blocks on these terms.");
  }
  if (codes.has("template_contract.demo_asset_residue")) {
    actions.push("Re-skin template demo placeholder assets (spacer SVGs, repeated benefit icons, starter imagery) to the campaign's real assets before launch.");
  }
  if (codes.has("scope.partial_build")) {
    actions.push("Build and deploy only the mapped partial-scope pages; label the preview as route/visual-testable, not full-funnel launch-ready.");
  }
  if (codes.has("scope.runtime_qa_blocked")) {
    actions.push("Keep checkout/order-proof QA blocked until the out-of-scope runtime pages are built or explicitly delegated to an existing downstream URL.");
  }

  if (polishBlocked) {
    blockedStages.push("deploy");
    blockedStages.push("qa");
    actions.push(`${polishGate.reason} Run next-campaigns-polish and record structured evidence before deploy/QA handoff.`);
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
  if (polishBlocked) {
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

function toolingCommand(args) {
  const action = args._[1] || "status";
  if (action !== "status") throw new Error(`Unknown tooling command: ${action}`);
  if (args.target === true) throw new Error("Missing value for --target");
  if (args.platform === true) throw new Error("Missing value for --platform");

  const pkg = readJson(join(ROOT, "package.json"));
  const skillStatus = installSkills(args.target, true, args.platform || "all");
  const staleSkills = (skillStatus.skills || []).filter((skill) => skill.action !== "unchanged");
  const git = localGitStatus(ROOT);
  const cli = localCliStatus(pkg);
  const packageStatus = {
    name: pkg.name || null,
    version: pkg.version || null,
    private: Boolean(pkg.private),
    registry: pkg.private
      ? {
          checked: false,
          status: "not_applicable_private_package",
          note: "This checkout is private; npm does not automatically provide latest tooling.",
        }
      : {
          checked: false,
          status: "not_checked",
          note: "Registry freshness is not checked by tooling status; compare package manager lockfiles in the consuming repo.",
        },
  };
  const actions = [];
  const warnings = [];

  if (git.status === "ok" && git.behind > 0) {
    actions.push("Update this checkout before running a dogfood build: git pull --ff-only (or wt sync in a worktree).");
  } else if (git.status !== "ok") {
    warnings.push(`Git freshness unavailable: ${git.reason}.`);
  } else if (!git.upstream) {
    warnings.push("No git upstream is configured for this checkout; remote freshness is advisory only.");
  }

  if (staleSkills.length) {
    const skillArgs = args.target ? ["--target", args.target] : ["--platform", args.platform || "all"];
    actions.push(`Refresh installed skills: npm run campaigns-os -- install-skills ${skillArgs.join(" ")}. Restart local agent sessions afterwards.`);
  }

  if (cli.global_binary.status === "not_found") {
    warnings.push("No global campaigns-os binary was found; use `npm run campaigns-os -- ...` from this checkout or `node ./bin/campaigns-os.mjs ...`.");
  }

  if (git.status === "ok" && git.dirty) {
    warnings.push("This checkout has uncommitted changes; verify they are intentional before publishing or comparing freshness.");
  }

  const gitBlocks = git.status === "ok" && Number.isFinite(git.behind) && git.behind > 0;
  const ok = !gitBlocks && staleSkills.length === 0;
  return {
    ok,
    status: ok ? "ready" : "attention_required",
    package: packageStatus,
    git,
    cli,
    skills: {
      ok: staleSkills.length === 0,
      stale_count: staleSkills.length,
      status: skillStatus,
    },
    actions,
    warnings,
  };
}

function localCliStatus(pkg) {
  const binRel = isObject(pkg.bin)
    ? pkg.bin["campaigns-os"]
    : typeof pkg.bin === "string"
      ? pkg.bin
      : null;
  const localBin = binRel ? resolve(ROOT, binRel) : null;
  const globalPath = findExecutableOnPath("campaigns-os");
  return {
    local_bin: localBin,
    local_bin_exists: Boolean(localBin && existsSync(localBin)),
    invocation: "npm run campaigns-os -- <command>",
    global_binary: globalPath
      ? { status: "found", path: globalPath }
      : { status: "not_found", path: null },
  };
}

function localGitStatus(root) {
  const inside = runCommand("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return { status: "unavailable", reason: "git rev-parse failed", error: inside.error };
  if (inside.stdout !== "true") return { status: "unavailable", reason: "not a git worktree" };

  const head = runCommand("git", ["-C", root, "rev-parse", "--short", "HEAD"]);
  if (!head.ok) return { status: "unavailable", reason: "git HEAD could not be resolved", error: head.error };

  const branch = runCommand("git", ["-C", root, "branch", "--show-current"]);
  const upstream = runCommand("git", ["-C", root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const dirty = runCommand("git", ["-C", root, "status", "--porcelain"]);
  if (!dirty.ok) return { status: "unavailable", reason: "git status failed", error: dirty.error };
  let ahead = null;
  let behind = null;
  const upstreamName = upstream.ok ? upstream.stdout : "";
  if (upstreamName) {
    const counts = runCommand("git", ["-C", root, "rev-list", "--left-right", "--count", `HEAD...${upstreamName}`]);
    if (!counts.ok) return { status: "unavailable", reason: "git ahead/behind comparison failed", error: counts.error };
    const [left, right] = counts.stdout.split(/\s+/).map((value) => Number.parseInt(value, 10));
    ahead = Number.isFinite(left) ? left : null;
    behind = Number.isFinite(right) ? right : null;
  }

  return {
    status: "ok",
    root,
    branch: branch.ok && branch.stdout ? branch.stdout : null,
    head: head.stdout || null,
    upstream: upstreamName || null,
    ahead,
    behind,
    dirty: dirty.stdout.length > 0,
    note: upstreamName
      ? "Freshness is compared to the locally fetched upstream ref; run git fetch first for a network-current answer."
      : "No upstream configured; compare this checkout manually before relying on it.",
  };
}

function runCommand(command, args) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error.stdout === "string" ? error.stdout.trim() : "",
      error: error.message || String(error),
    };
  }
}

function findExecutableOnPath(name) {
  const pathEnv = process.env.PATH || "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = join(dir, process.platform === "win32" && !name.toLowerCase().endsWith(ext.toLowerCase()) ? `${name}${ext}` : name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutableFile(candidate) {
  if (!existsSync(candidate)) return false;
  if (process.platform === "win32") return true;
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
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

function writeStandardizationReportResult(result, args) {
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatStandardizationReportMarkdown(result));
  }
  if (!result.ok) process.exitCode = 2;
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
  const progress = found ? runSessionProgress(found) : null;
  if (args.json) {
    console.log(JSON.stringify({ ok: true, action: "run-status", active: Boolean(found), session: found?.session ?? null, session_path: found?.path ?? null, progress }, null, 2));
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
  if (progress) {
    if (progress.incomplete_stages.length) {
      console.log(`Incomplete stages: ${progress.incomplete_stages.map((stage) => `${stage.stage} (${stage.status || "pending"})`).join(", ")}`);
    } else {
      console.log("All assembly-report stages are terminal.");
    }
    if (progress.deviations > 0) console.log(`Agent deviations recorded: ${progress.deviations} (see ${DEVIATION_JOURNAL_REL_PATH})`);
    console.log(`Next command: ${progress.next_command}`);
  } else {
    console.log("Next command: campaigns-os next --packet <campaign-runtime.build.json> --json (no packet recorded on this session)");
  }
}

// Session progress: incomplete assembly-report stages, the deviation count,
// and the exact next command. Read-only and best-effort; the status command
// must never fail because an artifact is missing or torn.
function runSessionProgress(found) {
  const packetPath = found.session.packet;
  if (!isNonEmptyString(packetPath) || !existsSync(packetPath)) return null;
  try {
    const packet = readJson(packetPath);
    const sidecars = inferredBuildSidecarPaths(packet, packetPath);
    const report = readJsonIfExists(sidecars.reportPath);
    const incomplete = [];
    for (const key of ASSEMBLY_REPORT_STAGE_KEYS) {
      const status = String(report?.stages?.[key]?.status || "");
      if (!STAGE_TERMINAL_STATUS_PREFIXES.some((prefix) => status.startsWith(prefix))) {
        incomplete.push({ stage: key, status: status || null });
      }
    }
    const deviations = readDeviations(join(found.dir, DEVIATION_JOURNAL_REL_PATH)).length;
    return {
      incomplete_stages: incomplete,
      deviations,
      next_command: incomplete.length
        ? `campaigns-os next --packet ${packetPath} --json`
        : `campaigns-os run end --packet ${packetPath}`,
    };
  } catch {
    return null;
  }
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
async function runRecordCommand(args, ambient = null, { silent = false, promptForConsent = true } = {}) {
  const packetPath = resolve(requireArg(args, "packet"));
  const parsedSurfaces = parseRunRecordSurfaces(args.surfaces);
  const packet = readJson(packetPath);
  const baseDir = dirname(packetPath);
  const explicitTargetRepo = resolveFromFile(packetPath, packet.assembly?.target_repo);
  const targetRepo = explicitTargetRepo || baseDir;
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
  const buildBriefPath = resolveFromFile(packetPath, packet.build_brief?.normalized_path);
  const pageKitBuildSummary = explicitTargetRepo ? readPageKitBuildSummary(explicitTargetRepo) : null;
  if (buildBriefPath && existsSync(buildBriefPath)) artifacts.push(runRecordArtifactRef("build_brief", buildBriefPath, BUILD_BRIEF_SCHEMA, baseDir));
  if (contextExists) artifacts.push(runRecordArtifactRef("build_context", contextPath, CONTEXT_SCHEMA, baseDir));
  if (reportExists) artifacts.push(runRecordArtifactRef("assembly_report", reportPath, REPORT_SCHEMA, baseDir));
  if (pageKitBuildSummary?.summary || pageKitBuildSummary?.error) {
    artifacts.push(runRecordArtifactRef(
      "page_kit_build_summary",
      pageKitBuildSummary.path,
      optionalString(pageKitBuildSummary.summary?.schema_version) || "next-campaign-page-kit-build-summary/v0",
      baseDir,
    ));
  }
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
  if (promptForConsent && !consent.resolved && !remitDisabled && !args.json && process.stdin.isTTY) {
    consent = await promptAndPersistConsent({ proxyBase });
  }
  // Default-on consent is announced, never silent: the operator learns the
  // remit is happening, the exact endpoint receiving it, and how to turn it
  // off. Once per process so agent loops don't train operators to ignore it.
  if (consent.default_on === true && !remitDisabled) {
    announceDefaultOnTelemetry(consent.scope || proxyBase);
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
    surfaces: parsedSurfaces,
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

  const summary = { ok: true, action: "run-record", written: write, record_path: recordPath, record };
  if (silent) return summary;
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return summary;
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
  return summary;
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

function parseRunRecordSurfaces(value) {
  const surfaces = parseCommaList(value);
  const unknown = surfaces.filter((surface) => !RUN_RECORD_SURFACES.includes(surface));
  if (unknown.length) {
    throw new Error(`Unknown --surfaces value(s): ${unknown.join(", ")}. Use one of: ${RUN_RECORD_SURFACES.join(", ")}.`);
  }
  return surfaces;
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
  // A blocked gate owns the tiny prompt: print the exact commands so the
  // operator/agent acts on data, not on remembering doctrine.
  const blockedGate = (result.gates || []).find((gate) => gate.status === "blocked" && gate.id === "theme_gate");
  if (blockedGate) {
    console.log("");
    console.log("Theme gate is BLOCKING this stage. Resolve it with:");
    for (const action of result.next_actions || []) {
      console.log(`  - ${action.command || action.description}`);
    }
    return;
  }
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
  if (result.briefPath) {
    const brief = result.context?.build_brief;
    console.log(`Brief: ${result.briefPath}${brief ? ` (${brief.mode}, ${brief.status}, questions=${brief.question_count})` : ""}`);
  }
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
  if (result.actions?.length) {
    console.log("Actions:");
    for (const action of result.actions) console.log(`- ${action}`);
  }
  if (result.errors?.length) {
    console.log("Errors:");
    for (const issue of result.errors) console.log(`- ${formatIssueSummary(issue)}`);
  }
  if (result.warnings?.length) {
    console.log("Warnings:");
    for (const issue of result.warnings) console.log(`- ${formatIssueSummary(issue)}`);
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

function formatIssueSummary(issue) {
  if (typeof issue === "string") return issue;
  if (issue?.code && issue?.message) return `[${issue.code}] ${issue.message}`;
  if (issue?.message) return issue.message;
  return String(issue);
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
