import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runQaCli } from "./qa-node.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKET_SCHEMA = "campaign-runtime-build-packet/v0";
const CONTEXT_SCHEMA = "campaign-runtime-build-context/v0";
const REPORT_SCHEMA = "campaign-runtime-assembly-report/v0";

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
  campaigns-os start --spec <json> --source <html-dir> --target <page-kit-dir> --template-family <family>
  campaigns-os prepare-build --spec <json> --source <html-dir> --target <page-kit-dir> --template-family <family>
  campaigns-os doctor --packet <campaign-runtime.build.json> [--context <json>] [--report <json>] [--strip-paths] [--json]
  campaigns-os validate-assembly-report --report <json> [--json]
  campaigns-os install-skills [--target <skills-dir>] [--dry-run] [--json]
  campaigns-os install-agent-context --target <page-kit-dir> [--dry-run]
  campaigns-os next setup --packet <json> [--context <json>] [--report <json>] [--json]
  campaigns-os next build --packet <json> [--context <json>] [--report <json>] [--json]
  campaigns-os next polish --packet <json> --report <json> [--json]
  campaigns-os next qa --packet <json> --report <json> [--json]
  campaigns-os qa resolve --packet <json> [--base-url <url>] [--json]
  campaigns-os qa run --packet <json> [--base-url <url>] [--browser] [--output-dir qa-output] [--json]
  campaigns-os qa policy set --packet <json> [--test-orders-allowed true|false] [--sandbox-test-card-confirmed true|false] [--allowed-domains-confirmed true|false] [--json]

Examples:
  npm run campaigns-os -- start \\
    --spec examples/campaignspec.v42.basic.json \\
    --source examples/source-html \\
    --target examples/target-page-kit \\
    --template-family olympus

  npm run campaigns-os -- doctor --packet examples/build-packet.basic.json --json
`;

export async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0] || "help";

  if (command === "help" || args.help) {
    console.log(HELP);
    return;
  }

  if (command === "start") {
    const result = prepareBuild(args, { runDoctor: true, installContext: true });
    printPrepareResult(result, args);
    return;
  }

  if (command === "prepare-build") {
    const result = prepareBuild(args, { runDoctor: false, installContext: false });
    printPrepareResult(result, args);
    return;
  }

  if (command === "doctor" || command === "validate-build-packet") {
    const result = doctorCommand(args);
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
    const result = installSkills(args.target, Boolean(args["dry-run"]));
    writeResult(result, args, 0);
    return;
  }

  if (command === "next") {
    const stage = args._[1];
    if (!stage) throw new Error("Missing next stage: build, polish, or qa.");
    const result = nextStage(stage, args);
    writeResult(result, args, result.ok ? 0 : 2);
    return;
  }

  if (command === "qa") {
    await runQaCli(args);
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

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

function normalizePageKitRoute(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (isAbsoluteHttpUrl(raw)) return raw;

  const clean = raw
    .replace(/[?#].*$/, "")
    .replace(/^\/+/, "")
    .replace(/\/?index\.html$/i, "")
    .replace(/\.html$/i, "")
    .replace(/^\/+|\/+$/g, "");

  return clean ? `${clean}/` : "";
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

function defaultRouteForType(type) {
  if (type === "thankyou") return "receipt/";
  if (["presell", "landing", "checkout", "upsell", "downsell"].includes(type)) return `${type}/`;
  return `${type || "page"}/`;
}

function publicRouteForPage(page) {
  if (isNonEmptyString(page.page_url)) return normalizePageKitRoute(page.page_url);
  if (isNonEmptyString(page.url)) return page.url.trim();
  if (page.is_entry) return "";
  return defaultRouteForType(page.type);
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

function pageMatchKeys(page, ordinal) {
  const keys = new Set([
    slugify(page.id),
    slugify(page.label),
    slugify(page.type),
  ].filter(Boolean));
  const sourceUrl = optionalString(page.page_url) || optionalString(page.url);
  if (sourceUrl) {
    const clean = sourceUrl.replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "");
    if (clean) {
      keys.add(slugify(clean));
      keys.add(slugify(basename(clean, extname(clean))));
    }
  }
  if (ordinal && page.type) keys.add(slugify(`${page.type}-${ordinal}`));
  if (page.type === "thankyou") {
    keys.add("receipt");
    keys.add("thank-you");
    keys.add("thankyou");
  }
  if (page.type === "landing" || page.type === "presell") keys.add("index");
  if (page.type === "checkout") keys.add("checkout");
  if (page.type === "upsell") keys.add("upsell");
  if (page.type === "downsell") keys.add("downsell");
  return [...keys];
}

function matchSourcePages(specPages, htmlFiles) {
  const used = new Set();
  const mappings = [];
  const prompts = [];
  const decisions = [];
  const counts = new Map();
  const ordinals = new Map();

  for (const page of specPages) {
    const key = page.type || "page";
    const next = (counts.get(key) || 0) + 1;
    counts.set(key, next);
    ordinals.set(page.id, next);
  }

  for (const page of specPages) {
    const keys = pageMatchKeys(page, ordinals.get(page.id));
    const candidates = htmlFiles.filter((file) => keys.includes(slugify(file.basename)));
    const unused = candidates.filter((file) => !used.has(file.path));
    const match = unused[0] || candidates[0] || null;
    if (match) {
      used.add(match.path);
      mappings.push({ page_id: page.id, path: match.path });
      decisions.push({
        id: `dec_page_map_${page.id}`,
        stage: "prepare_build",
        decision_type: "deterministic_derivation",
        decision: `mapped CampaignSpec page "${page.id}" to source file "${match.path}"`,
        confidence: candidates.length === 1 ? "high" : "medium",
        evidence: [`matched source filename against page keys: ${keys.join(", ")}`],
      });
    } else {
      mappings.push({ page_id: page.id, skip_reason: "No matching source HTML file found; provide a source file or an explicit skip reason before build." });
      prompts.push({
        code: "MISSING_SOURCE_PAGE",
        stage: "prepare_build",
        message: `Active CampaignSpec page "${page.id}" has no matching HTML file.`,
        page_id: page.id,
      });
    }
  }

  return { mappings, prompts, decisions };
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
  const matched = matchSourcePages(activePages, htmlFiles);
  const explicitTemplateFamily = optionalString(args["template-family"]);
  const hintedTemplateFamily = preferredTemplateFamily(spec);
  const templateFamily = explicitTemplateFamily || hintedTemplateFamily || "undecided";
  const templateLocked = Boolean(explicitTemplateFamily) && templateFamily !== "undecided" && templateFamily !== "auto";
  const templateCandidates = hintedTemplateFamily
    ? [{ family: hintedTemplateFamily, source: "CampaignSpec preferred_template_family", confidence: "hint" }]
    : [];
  const outputDir = optionalString(args["output-dir"], `src/${publicRouteSlug}`);
  const liveUrlPath = optionalString(args["live-url-path"], `/${publicRouteSlug}/`);
  const commerceCatalog = optionalString(args["commerce-catalog"], join(ROOT, "contracts/commerce-surface-catalog.json"));
  const blockers = matched.prompts.map((prompt) => ({ code: prompt.code, stage: prompt.stage, message: prompt.message }));
  const portable = (path) => relFromDir(targetRepo, path);

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
      test_order_policy_notes: "Default: SDK-driven test orders are not fired until the deployed domain is allowlisted and test_card sandbox routing is confirmed.",
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
    },
    page_map: matched.mappings.map((mapping) => ({
      page_id: mapping.page_id,
      source_path: mapping.path || null,
      skip_reason: mapping.skip_reason || null,
      output_path: mapping.path ? portable(resolve(targetRepo, outputDir, mapping.path)) : null,
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
    commerce_zone_findings: inspectCommerceZones(sourceRoot, htmlFiles),
    prompts_required: matched.prompts,
    decisions: matched.decisions,
  };

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

function inspectCommerceZones(sourceRoot, htmlFiles) {
  const findings = [];
  const attrPattern = /\b(data-next-[a-zA-Z0-9-]+)/g;
  for (const file of htmlFiles) {
    const content = readFileSync(join(resolve(sourceRoot), file.path), "utf8");
    const lower = content.toLowerCase();
    const attrs = [...new Set([...content.matchAll(attrPattern)].map((match) => match[1]))];
    const zones = [];
    if (lower.includes("checkout")) zones.push("checkout");
    if (lower.includes("payment") || lower.includes("card number")) zones.push("payment");
    if (lower.includes("upsell")) zones.push("upsell");
    if (lower.includes("receipt") || lower.includes("order summary")) zones.push("receipt");
    if (attrs.length > 0) zones.push("sdk_attributes");
    if (zones.length > 0) {
      findings.push({
        path: file.path,
        zones: [...new Set(zones)],
        sdk_attributes: attrs,
        action: "review_and_preserve_catalog_surfaces",
      });
    }
  }
  return findings;
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
    stages: {
      prepare_build: createStage("prepare_build", blockers.length ? "blocked" : "completed", {
        outputs: [portable(packetPath), portable(contextPath), portable(reportPath)],
        blockers,
      }),
      doctor: createStage("doctor", "pending"),
      setup: createStage("setup", scaffoldRequired ? "pending" : "skipped"),
      assembly: createStage("assembly", "pending"),
      polish: createStage("polish", "pending"),
      deploy: createStage("deploy", "pending"),
      qa: createStage("qa", "pending"),
    },
    decisions: context.decisions,
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
  return doctorPacket(packetPath, {
    contextPath: args.context ? resolve(args.context) : null,
    reportPath: args.report ? resolve(args.report) : null,
    outputBaseDir: args["strip-paths"] === true ? dirname(packetPath) : null,
  });
}

function doctorPacket(packetPath, { contextPath = null, reportPath = null, outputBaseDir = null } = {}) {
  const packet = readJson(packetPath);
  const context = readJsonIfExists(contextPath);
  const report = readJsonIfExists(reportPath);
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
  if (context) validateContext(context, warnings, ready, derived);
  if (report) validateAssemblyReportShape(report, errors, warnings, ready);

  const next = buildNextStep(errors, warnings, derived);
  const status = errors.length ? "blocked" : warnings.length ? "ready_with_warnings" : "ready";
  const result = { ok: errors.length === 0, status, errors, warnings, ready, derived, next };
  return outputBaseDir ? relativizeDoctorOutput(result, outputBaseDir) : result;
}

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

  if (packet.campaign?.allowed_domains_confirmed !== true) {
    addIssue(warnings, "campaign.allowed_domains_confirmed", "Allowed domains are not confirmed. SDK runtime checks may be blocked.");
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
    validateSpecIdentityExport(spec, warnings, ready);
    validateSpecPublicRoutes(spec, errors, ready);
    validateSpecStoreProfile(spec, errors, ready);
    validateTargetCampaignSdkVersion(spec, packet, targetRepo, warnings, ready);
    validateSpecShippingCountries(spec, warnings, ready);
    validateSpecRoutingMetaTags(spec, packet, warnings, ready);
    validateSourceCoverage(packet, packetPath, spec, errors, warnings, ready, derived);
    validateSpecPackageAvailability(spec, warnings, ready);
    validateBuiltSdkMetaTags(spec, packet, errors, warnings, ready, derived, buildState);
  }

  validateCampaignsApiKey(packet, spec, warnings, ready);
  validateCommerceCatalog(packet, packetPath, spec, errors, warnings, ready, derived, buildState);
  validateMarketSensitiveCopy(spec, warnings, ready, derived);

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
  if (packet.qa?.test_orders_allowed && !packet.qa?.sandbox_test_card_confirmed) {
    addIssue(errors, "qa.sandbox_test_card_confirmed", "test_orders_allowed=true requires sandbox_test_card_confirmed=true.");
  }
  if (!packet.qa?.test_orders_allowed) {
    addIssue(warnings, "qa.test_orders_allowed", "SDK-driven test orders are not enabled for this packet; QA must avoid checkout order mutations.");
  }
}

function validateSpecStoreProfile(spec, errors, ready) {
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

function validateSpecRoutingMetaTags(spec, packet, warnings, ready) {
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  if (!publicRouteSlug) return;

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
    const builtPath = builtHtmlPathForPage(targetRepo, publicRouteSlug, page);
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
    validateBuiltHtmlStructure(content, builtPath, targetRepo, page, spec, errors, warnings, assemblyComplete);

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

function validateBuiltHtmlStructure(content, builtPath, targetRepo, page, spec, errors, warnings, assemblyComplete) {
  const issueTarget = assemblyComplete ? errors : warnings;
  const relPath = relFromDir(targetRepo, builtPath);
  if (!/<body(?:\s|>)/i.test(content) || !/<\/body>/i.test(content)) {
    addIssue(issueTarget, "built_output.body_missing", `Built page "${page.id}" does not contain a complete <body> element.`, { page_id: page.id, file: relPath });
  }
  if (!/(data-next-|window\.next|next-page-type|campaign-cart-sdk|campaign-cart)/i.test(content)) {
    addIssue(issueTarget, "built_output.runtime_missing", `Built page "${page.id}" has no obvious Campaign Cart runtime markers.`, { page_id: page.id, file: relPath });
  }
  validateBuiltScriptAssets(content, builtPath, targetRepo, page, issueTarget);
  validateBuiltCommerceRefs(content, builtPath, targetRepo, page, spec, issueTarget);
}

function validateBuiltScriptAssets(content, builtPath, targetRepo, page, issueTarget) {
  for (const tag of content.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    const src = tag[1];
    const resolved = resolveBuiltAssetPath(src, builtPath, targetRepo);
    if (!resolved || existsSync(resolved)) continue;
    addIssue(
      issueTarget,
      "built_output.script_missing",
      `Built page "${page.id}" references script "${src}", but the file does not exist in built output.`,
      { page_id: page.id, file: relFromDir(targetRepo, builtPath), script: src }
    );
  }
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
  for (const match of content.matchAll(/\bdata-next-package-id=["']([^"']+)["']/gi)) addNumericRef(refs, match[1]);
  for (const match of content.matchAll(/\bdata-package-id=["']([^"']+)["']/gi)) addNumericRef(refs, match[1]);
  for (const match of content.matchAll(/["']?packageId["']?\s*:\s*["']?([0-9]+)["']?/gi)) addNumericRef(refs, match[1]);
  return refs;
}

function extractRenderedShippingRefs(content) {
  const refs = new Set();
  for (const match of content.matchAll(/\bdata-next-shipping-id=["']([^"']+)["']/gi)) addNumericRef(refs, match[1]);
  for (const match of content.matchAll(/["']?shippingId["']?\s*:\s*["']?([A-Za-z0-9_-]+)["']?/gi)) addNumericRef(refs, match[1]);
  return refs;
}

function addNumericRef(refs, value) {
  const ref = String(value || "").trim();
  if (/^[0-9]+$/.test(ref)) refs.add(ref);
}

function builtHtmlPathForPage(targetRepo, publicRouteSlug, page) {
  if (!targetRepo || !publicRouteSlug) return null;
  const route = publicRouteForPage(page);
  if (!route) return join(targetRepo, "_site", publicRouteSlug, "index.html");
  const clean = route.replace(/^\/+|\/+$/g, "");
  return clean ? join(targetRepo, "_site", publicRouteSlug, clean, "index.html") : join(targetRepo, "_site", publicRouteSlug, "index.html");
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
  const normalized = normalizePageKitRoute(route);
  return normalized ? `/${publicRouteSlug}/${normalized}` : `/${publicRouteSlug}/`;
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

function validateMarketSensitiveCopy(spec, warnings, ready, derived) {
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
    if (!currencyMatches.length) {
      ready.push(`Hardcoded currency scan found no obvious static $ amounts (${currencyScope.reasons.join(", ")}).`);
    } else {
      addIssue(
        warnings,
        "copy.hardcoded_currency_symbol",
        `Campaign currency scope needs copy review (${currencyScope.reasons.join(", ")}), and prepared HTML contains hardcoded $ amounts outside SDK-bound or skipped regions: ${summarizeCopyMatches(currencyMatches)}. Use SDK display tokens or remove static currency strings.`
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

function validateSourceCoverage(packet, packetPath, spec, errors, warnings, ready, derived = {}) {
  const pages = packet.source_html?.pages || [];
  const sourceRoot = resolveFromFile(packetPath, packet.source_html?.root);
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
      } else if (specPage) {
        builtPages.push({
          page_id: specPage.id,
          type: specPage.type || "page",
          role: pageRole(specPage.type),
          route: publicRouteForPage(specPage),
          source_path: page.path,
        });
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
      addIssue(errors, "source_html.pages.coverage", `Active CampaignSpec page "${page.id}" has no source mapping.`);
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

function validateCommerceCatalog(packet, packetPath, spec, errors, warnings, ready, derived = {}, buildState = {}) {
  const family = packet.assembly?.template_family;
  const catalogInfo = packet.assembly?.commerce_catalog || {};
  if (catalogInfo.required !== true) return;
  const catalogPath = resolveFromFile(packetPath, catalogInfo.path || "../contracts/commerce-surface-catalog.json");
  if (!catalogPath || !existsSync(catalogPath)) {
    addIssue(errors, "assembly.commerce_catalog.path", "Commerce catalog is required but not found.");
    return;
  }
  const catalog = readJson(catalogPath);
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
  if (family === "shop-three-step") {
    ready.push("shop-three-step uses dynamic shipping via window.next.getShippingMethods(); do not copy Olympus-style shipping_methods frontmatter into it.");
  } else if (contractMentionsShipping(contract) && spec && !Array.isArray(spec.shipping_methods)) {
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

function collectDemoRefHits(spec, vocab) {
  const demoValues = new Set(
    Object.values(vocab || {})
      .flatMap((entry) => Array.isArray(entry.demoOnlyValues) ? entry.demoOnlyValues : [])
      .map((value) => String(value))
  );
  if (demoValues.size === 0) return [];
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
      if (!hits.has(hitKey) && !isApiSourcedProvenance(provenanceStack)) {
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

function validateContext(context, warnings, ready, derived) {
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
  if (context.scaffold?.required === true) {
    derived.scaffold_required = true;
    derived.scaffold_reason = context.scaffold.reason || "Build context says setup is required.";
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
    for (const stage of ["prepare_build", "doctor", "setup", "assembly", "polish", "deploy", "qa"]) {
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
  const status = errors.length ? "blocked" : warnings.length ? "ready_with_warnings" : "ready";
  return { ok: errors.length === 0, status, errors, warnings, ready };
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

  let prompt = "";
  if (stage === "setup") {
    if (!doctor.ok) addIssue(errors, "next.setup.doctor", "Doctor is blocked; resolve packet errors before setup.");
    prompt = setupPrompt(packetPath, contextPath, reportPath, packet);
  } else if (stage === "build") {
    if (!doctor.ok) addIssue(errors, "next.build.doctor", "Doctor is blocked; resolve packet errors before build.");
    if (doctor.derived?.scaffold_required) addIssue(errors, "next.build.setup", doctor.derived.scaffold_reason || "Setup is required before build.");
    prompt = buildPrompt(packetPath, contextPath, reportPath, packet);
  } else if (stage === "polish") {
    if (!report) addIssue(errors, "next.polish.report", "Assembly report is required before polish.");
    const assemblyStatus = report?.stages?.assembly?.status || "";
    if (!assemblyStatus.startsWith("completed")) addIssue(errors, "next.polish.assembly", `Assembly status is "${assemblyStatus || "missing"}"; polish expects completed assembly or an explicit blocked/skipped handoff.`);
    prompt = polishPrompt(packetPath, reportPath, packet);
  } else if (stage === "qa") {
    if (!report) addIssue(errors, "next.qa.report", "Assembly report is required before QA.");
    const deployUrl = packet.deploy?.preview_url || packet.deploy?.production_url;
    if (!deployUrl) addIssue(errors, "next.qa.deploy_url", "QA requires deploy.preview_url or deploy.production_url.");
    const polishStatus = report?.stages?.polish?.status || "";
    if (!["completed", "completed_with_warnings", "skipped", "blocked"].some((prefix) => polishStatus.startsWith(prefix))) {
      addIssue(errors, "next.qa.polish", `Polish status is "${polishStatus || "missing"}"; record completed/skipped/blocked before QA.`);
    }
    prompt = qaPrompt(packetPath, reportPath, packet);
  } else {
    throw new Error(`Unknown next stage: ${stage}`);
  }
  const status = errors.length ? "blocked" : warnings.length ? "ready_with_warnings" : "ready";
  return {
    ok: errors.length === 0,
    status,
    stage,
    errors,
    warnings,
    ready,
    prompt,
  };
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
- Prepared AI/exported HTML must be converted into page-kit-ready source first: keep page-owned body markup, strip document wrappers, add YAML frontmatter, move shared CSS/assets into the campaign structure, and use Liquid helpers only for page-kit links/assets/includes.
- Preserve prepared source HTML for landing/presell pages when it is a real standalone design.
- For checkout/upsell/downsell/receipt, use the starter template as the SDK contract reference only: preserve required data-next controls and runtime wiring, but let the campaign/source own visual chrome, copy hierarchy, imagery, and brand layer.
- If you copy starter-template files, copy the selected family atomically with dependent pages, _includes, _layouts, assets/css, and assets/js; do not copy only checkout.html and receipt.html.
- Resolve SDK routing meta tags to campaign-root paths such as /${packet.campaign.public_route_slug}/upsell/, not source filenames or unrooted spec literals.
- For one-time prepurchase/order-bump packages outside the main bundles, default package_sync=false and show_line_total_price=false unless the spec explicitly requires quantity sync.
- Record spec-driven removals, especially unsupported payment methods, so polish does not reintroduce them.
- Replace demo refs; do not copy Olympus-style shipping_methods into shop-three-step.
- For two-step package-selection flows, treat the selector page as the pre-checkout step and pass the selected cart to checkout with forcePackageId; preserve normal tracking params and strip forcePackageId from visible checkout URLs after SDK initialization.
- After page-kit build, inspect rendered _site output before handoff: each active page should have a body, Campaign Cart runtime markers, SDK meta tags from CampaignSpec sdk_hints.meta_tags, and no stale copied funnel attribution.
- Run page-kit build and SDK/template lint, then update the assembly report before polish.`;
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

Compare source against built page-kit output, patch only SDK-safe visual surfaces, scan source assets for logo/brand marks before leaving starter-template logos, respect spec-driven removals recorded during build, capture desktop/mobile evidence, and record polish as completed, skipped, or blocked before QA.`;
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
campaigns-os qa run --packet ${packetPath} --base-url ${url} --browser

Run the browser install once after install/update before --browser or --test-order. Test-order proof must exercise the deployed campaign through the Campaign Cart SDK with the browser typed-card flow. Do not create hand-built backend API orders as launch proof. Only fire test orders when test_orders_allowed=true, sandbox_test_card_confirmed=true, and the deployed domain is allowlisted. Use --test-order checkout/decline/accept/both with --allow-test-orders and --sandbox-test-card-confirmed; then click rendered SDK upsell accept/decline controls for upsell proof. For multi-market campaigns, verify at least one non-default currency/country path: currency display, shipping method names/prices, payment methods, and market-specific copy. Summarize blockers, warnings, and remaining launch risks.`;
}

function buildNextStep(errors, warnings, derived) {
  const codes = new Set([...errors, ...warnings].map((issue) => issue.code));
  const blockedStages = [];
  const actions = [];
  if (errors.length) {
    actions.push("Resolve packet blockers before assembly.");
  }
  if (codes.has("deploy.preview_url")) blockedStages.push("qa");
  if (codes.has("scope.runtime_qa_blocked")) {
    blockedStages.push("checkout-launch-ready");
    blockedStages.push("test-orders");
  }
  if (codes.has("campaign.allowed_domains_confirmed")) blockedStages.push("runtime-sdk-verification");
  if (codes.has("qa.test_orders_allowed") || codes.has("qa.sandbox_test_card_confirmed")) blockedStages.push("test-orders");
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

function installSkills(targetArg = null, dryRun = false) {
  const sourceDir = join(ROOT, "skills");
  const targetDir = resolve(targetArg || join(homedir(), ".claude", "skills"));
  const entries = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const skills = [];

  if (!dryRun) mkdirSync(targetDir, { recursive: true });

  for (const entry of entries) {
    const name = entry.name;
    const source = join(sourceDir, name, "SKILL.md");
    if (!existsSync(source)) continue;

    const destinationDir = join(targetDir, name);
    const destination = join(destinationDir, "SKILL.md");
    const sourceContent = readFileSync(source, "utf8");
    const sourceDescriptor = describeSkillContent(sourceContent);
    const hasDestination = existsSync(destination);
    const destinationContent = hasDestination ? readFileSync(destination, "utf8") : null;
    const destinationDescriptor = destinationContent == null ? null : describeSkillContent(destinationContent);
    const action = !hasDestination
      ? "created"
      : destinationContent === sourceContent
        ? "unchanged"
        : "updated";

    if (!dryRun && action !== "unchanged") {
      mkdirSync(destinationDir, { recursive: true });
      writeFileSync(destination, sourceContent);
    }

    skills.push({
      name,
      action,
      source,
      destination,
      from: destinationDescriptor,
      to: sourceDescriptor,
    });
  }

  return {
    ok: true,
    status: dryRun ? "dry_run" : "installed",
    source_directory: sourceDir,
    target_directory: targetDir,
    skills,
    note: dryRun
      ? "Dry run only; no skill files were written."
      : "Restart Claude Code session to pick up new or updated skills.",
  };
}

function describeSkillContent(content) {
  const version = extractFrontmatterValue(content, "version");
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  return {
    version,
    hash,
    label: version ? `v${version}` : `sha256:${hash}`,
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

function printPrepareResult(result, args) {
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    if (result.doctor && !result.doctor.ok) process.exitCode = 2;
    return;
  }
  console.log("Campaigns OS prepare-build");
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
  if (skill.action === "created") return `${skill.name}: created (${skill.to.label})`;
  if (skill.action === "updated") {
    const from = skill.from?.label || "missing";
    return `${skill.name}: updated (${from} -> ${skill.to.label})`;
  }
  return `${skill.name}: unchanged (${skill.to.label})`;
}
