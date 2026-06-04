import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runBrowserChecks, runBrowserTestOrders, testEmail } from "./qa-browser.mjs";
import { createVerdict, SEVERITY, STATUS, validateVerdict } from "./qa-verdict.mjs";

const DEFAULT_PROXY_BASE = "https://campaign-map.nextcommerce.com";
const RUNTIME = "campaigns-os-node-qa@0.1.0-alpha.0";

const HELP = `campaigns-os qa — Node/npm spec-aware QA

Usage:
  campaigns-os qa resolve --packet <campaign-runtime.build.json> [--base-url <url>] [--json]
  campaigns-os qa run --packet <campaign-runtime.build.json> [--base-url <url>] [--output-dir qa-output] [--json]
  campaigns-os qa policy set --packet <campaign-runtime.build.json> [--test-orders-allowed true|false] [--sandbox-test-card-confirmed true|false] [--allowed-domains-confirmed true|false] [--json]
  campaigns-os qa resolve <map-id> --spec <campaign-spec.json> [--base-url <url>]
  campaigns-os qa run <map-id> --spec <campaign-spec.json> --base-url <url>

Options:
  --packet <path>                 Read Map ID, local CampaignSpec, deploy URL, and QA metadata from a Build Packet.
  --spec <path>                   Local exported CampaignSpec JSON. Preferred for the prepared-HTML flow.
  --proxy-base <url>              Campaign Map proxy base for fetching /api/spec/<map-id>.
  --base-url <url>                Deployed campaign root. Packet deploy URL is used when omitted.
  --output-dir <path>             Local verdict directory. Default: qa-output.
  --post-verdict                  (default) Publish the verdict to the QA portal at
                                  <proxy-base>/api/qa/verdicts and print the QA portal link.
                                  Publishing is automatic; this flag is retained for clarity.
  --no-post-verdict, --local-only Skip publishing; write only the local verdict copy (offline / dev / CI).
  --auth-cookie <cookie>          Cookie header for protected previews.
  --browser                       Run Playwright-rendered browser checks after static Node checks.
                                  Requires one-time setup: npm run qa:install-browser.
  --headed                        Show the Playwright browser window when --browser is set.
  --browser-width <px>            Browser viewport width. Default: 1440.
  --browser-height <px>           Browser viewport height. Default: 1200.
  --browser-timeout <ms>          Browser navigation timeout. Default: 30000.
  --test-order <off|common|checkout|accept|decline|both|full|accept-decline[-accept...]>
                                  Create Playwright typed-card test orders through the tested checkout page.
                                  Test cards bypass the gateway and create no transactions, so no permission
                                  flags or packet policy are needed — just pick a mode. Default mode (bare
                                  --test-order, or "common") runs a 3-5 shape sample; "full" is every permutation.
                                  Requires one-time setup: npm run qa:install-browser.
  --max-test-orders <n>           Accidental-flood guard for browser order count (not a permission gate). Default: 6.
  --allowed-domains-confirmed <bool>
                                  qa policy set: persist non-localhost SDK-origin confirmation.
                                  Localhost on any port is a global Development domain with analytics suppressed.
  --preview-url <url>             qa policy set: persist packet deploy.preview_url.
  --production-url <url>          qa policy set: persist packet deploy.production_url.
  --deploy-target <target>        qa policy set: persist packet deploy.target.
  --test-card <number>            Test card number for browser checkout. Default: Discover sandbox card 6011...1117.
  --test-cvv <cvv>                Test card CVV. Default: 123.
  --test-exp-month <mm>           Test card expiration month. Default: 12.
  --test-exp-year <yyyy>          Test card expiration year. Default: 2030.
  --test-email <email>            Customer email for browser test orders. Env CAMPAIGNS_OS_QA_TEST_EMAIL is also recognized.
  --test-email-prefix <prefix>    Legacy unique email prefix override.
  --legacy-api-test-order <off|accept|decline|both>
                                  Diagnostic-only direct Campaigns API order creation; bypasses deployed checkout.
  --api-key <key>                 Campaigns API key for legacy direct API diagnostics. Env QA_CAMPAIGNS_API_KEY is also recognized.
  --campaigns-api-base <url>      Campaigns API base URL for legacy direct API diagnostics. Env CAMPAIGNS_API_BASE is also recognized.
  --cart <package-ref:qty,...>    Optional target cart/package selector for browser or legacy diagnostics.
`;

export async function runQaCli(args) {
  const subcommand = args._[1] || "help";
  if (subcommand === "help" || args.help) {
    console.log(HELP);
    return;
  }
  if (subcommand === "resolve") {
    const resolved = await resolveQaInputs(args);
    output(resolvePayload(resolved), args);
    return;
  }
  if (subcommand === "run") {
    const result = await runQa(args);
    output(result, args);
    process.exitCode = result.verdict.disposition === "blocked" ? 4 : 0;
    return;
  }
  if (subcommand === "policy") {
    if (args._[2] !== "set") throw new Error("Unknown qa policy command. Use: campaigns-os qa policy set --packet <campaign-runtime.build.json>");
    const result = updateQaPolicy(args);
    output(result, args);
    return;
  }
  throw new Error(`Unknown qa command: ${subcommand}`);
}

async function resolveQaInputs(args) {
  const packetPath = args.packet ? resolve(args.packet) : null;
  const packet = packetPath ? readJson(packetPath) : null;
  const mapId = stringArg(args["map-id"])
    || stringArg(args._[2])
    || stringArg(packet?.spec?.map_id);
  if (!mapId) throw new Error("QA requires a Map ID. Provide --packet or positional <map-id>.");

  const proxyBase = stringArg(args["proxy-base"]) || DEFAULT_PROXY_BASE;
  const inputBaseUrl = normalizeBaseUrl(stringArg(args["base-url"]) || packet?.deploy?.preview_url || packet?.deploy?.production_url || null);
  const specPath = args.spec
    ? resolve(args.spec)
    : packetPath && packet?.spec?.local_path
      ? resolveFromFile(packetPath, packet.spec.local_path)
      : null;

  let rawSpec;
  let specSource;
  if (specPath) {
    rawSpec = readJson(specPath);
    specSource = specPath;
  } else {
    rawSpec = await fetchSpec(mapId, proxyBase);
    specSource = `${proxyBase.replace(/\/+$/, "")}/api/spec/${encodeURIComponent(mapId)}`;
  }

  const normalized = normalizeSpec(rawSpec);
  const publicRouteSlug = resolvePublicRouteSlug({ packet, spec: normalized, rawSpec });
  const baseUrl = normalizeQaBaseUrl(inputBaseUrl, publicRouteSlug);
  const specHash = computeSpecHash(rawSpec);
  const templateFamily = stringArg(packet?.assembly?.template_family)
    || stringArg(normalized?.spec_identity?.preferred_template_family)
    || stringArg(normalized?.campaign?.preferred_template_family)
    || null;
  const commerceStructureContract = loadCommerceStructureContract({ packet, packetPath, templateFamily });
  const topologies = extractTopologies(normalized, { baseUrl, publicRouteSlug, templateFamily, commerceStructureContract });
  return {
    packetPath,
    packet,
    mapId,
    proxyBase,
    baseUrl,
    specPath,
    specSource,
    rawSpec,
    spec: normalized,
    specVersion: String(rawSpec.schema_version || rawSpec.schemaVersion || "unknown"),
    specHash,
    templateFamily,
    commerceStructureContract,
    topologies,
  };
}

function loadCommerceStructureContract({ packet, packetPath, templateFamily }) {
  if (!packet || !packetPath || !templateFamily) return null;
  const catalogPathValue = packet.assembly?.commerce_catalog?.path;
  if (!catalogPathValue) return { family: templateFamily, status: "missing_catalog_path", pages: {} };
  const catalogPath = resolveFromFile(packetPath, catalogPathValue);
  if (!catalogPath || !existsSync(catalogPath)) return { family: templateFamily, status: "missing_catalog", pages: {} };
  try {
    const catalog = readJson(catalogPath);
    const qaStructure = catalog?.families?.[templateFamily]?.agentContract?.qaStructure;
    return {
      family: templateFamily,
      status: qaStructure && typeof qaStructure === "object" ? "loaded" : "missing_family_qa_structure",
      pages: qaStructure && typeof qaStructure === "object" ? qaStructure : {},
      catalog_path: catalogPathValue,
    };
  } catch (error) {
    return {
      family: templateFamily,
      status: "catalog_parse_error",
      pages: {},
      catalog_path: catalogPathValue,
      error: serializeThrownValue(error),
    };
  }
}

function serializeThrownValue(error) {
  const diagnostic = { message: String(error) };
  if (error && typeof error === "object") {
    const record = error;
    if (typeof record.name === "string" && record.name) diagnostic.name = record.name;
    if (typeof record.message === "string" && record.message) diagnostic.message = record.message;
    if (typeof record.stack === "string" && record.stack) diagnostic.stack = record.stack;
  }
  return diagnostic;
}

function resolvePayload(resolved) {
  return {
    ok: true,
    map_id: resolved.mapId,
    spec_source: resolved.specSource,
    spec_version: resolved.specVersion,
    spec_hash: resolved.specHash,
    base_url: resolved.baseUrl,
    campaign: {
      name: resolved.spec.campaign?.name || null,
      slug: resolved.spec.campaign?.slug || null,
      ref_id: resolved.spec.campaign?.ref_id || null,
    },
    funnels: resolved.topologies,
  };
}

function updateQaPolicy(args) {
  const packetPath = args.packet ? resolve(args.packet) : null;
  if (!packetPath) throw new Error("qa policy set requires --packet <campaign-runtime.build.json>.");
  const packet = readJson(packetPath);
  packet.campaign ||= {};
  packet.deploy ||= {};
  packet.qa ||= {};

  const changed = [];
  setOptionalBoolean(packet.qa, "test_orders_allowed", args, "test-orders-allowed", changed);
  setOptionalBoolean(packet.qa, "sandbox_test_card_confirmed", args, "sandbox-test-card-confirmed", changed);
  setOptionalBoolean(packet.campaign, "allowed_domains_confirmed", args, "allowed-domains-confirmed", changed);
  setOptionalString(packet.deploy, "preview_url", args, "preview-url", changed);
  setOptionalString(packet.deploy, "production_url", args, "production-url", changed);
  setOptionalString(packet.deploy, "target", args, "deploy-target", changed);

  if (changed.length) writeJson(packetPath, packet);
  return {
    ok: true,
    action: "qa-policy-set",
    packet_path: packetPath,
    changed,
    policy: policySnapshot(packet),
  };
}

async function runQa(args) {
  const resolved = await resolveQaInputs(args);
  const startedAt = new Date().toISOString();
  const runId = generateRunId();
  const assertions = [];
  for (const topology of resolved.topologies) {
    for (const page of topology.pages) {
      assertions.push(...await runPageChecks(page, args));
    }
  }
  if (args.browser === true) {
    assertions.push(...await runBrowserChecks(resolved.topologies, args));
  }

  const testOrders = await maybeRunTestOrders({ args, resolved, runId, assertions });
  const verdict = createVerdict({
    runId,
    mapId: resolved.mapId,
    campaignRefId: resolved.spec.campaign?.ref_id || null,
    specVersion: resolved.specVersion,
    specHash: resolved.specHash,
    startedAt,
    completedAt: new Date().toISOString(),
    runtime: RUNTIME,
    operator: process.env.USER ? `${process.env.USER}@local` : "",
    assertions,
    testOrders,
  });

  const validationErrors = validateVerdict(verdict);
  if (validationErrors.length) throw new Error(`QA verdict failed local validation:\n- ${validationErrors.join("\n- ")}`);
  const outputDir = resolve(args["output-dir"] || "qa-output");
  const localPath = writeLocalVerdict(verdict, outputDir);
  // Publish to the QA portal by default so runs land in the Campaign Map QA tab without the
  // operator needing to know a flag (LLM/agent UIs are the primary interface). Opt out with
  // --no-post-verdict / --local-only / --post-verdict false. Never fail the run if publish is unreachable.
  const shouldPublish = shouldPublishVerdict(args);
  let postResult = null;
  let postError = null;
  if (shouldPublish) {
    try {
      postResult = await postVerdict(verdict, resolved.proxyBase);
    } catch (error) {
      postError = error.message;
    }
  }
  const dashboardUrl = postResult?.ok
    ? `${resolved.proxyBase.replace(/\/+$/, "")}/qa?slug=${encodeURIComponent(resolved.mapId)}&run=${encodeURIComponent(verdict.run_id)}`
    : null;
  return {
    ok: verdict.disposition !== "blocked",
    status: verdict.disposition,
    run_id: verdict.run_id,
    map_id: resolved.mapId,
    base_url: resolved.baseUrl,
    dashboard_url: dashboardUrl,
    local_path: localPath,
    posted: postResult,
    post_error: postError,
    publish_skipped: !shouldPublish,
    counts: countAssertions(verdict.assertions),
    verdict,
  };
}

async function runPageChecks(page, args) {
  const assertions = [];
  if (!page.url) {
    assertions.push(assertion({
      id: `route-url:${page.page_id}`,
      family: "funnel-flow",
      page,
      status: STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      expected: "deployed URL",
      actual: null,
      evidence: { transport_error: { code: "missing_url", message: "No page URL could be resolved. Provide --base-url or explicit spec page URLs." } },
    }));
    return assertions;
  }

  let html = "";
  try {
    const headers = { Accept: "text/html,application/xhtml+xml" };
    if (args["auth-cookie"]) headers.Cookie = args["auth-cookie"];
    const response = await fetch(page.url, { headers });
    if (!response.ok) {
      assertions.push(assertion({
        id: `http:${page.page_id}`,
        family: "funnel-flow",
        page,
        status: STATUS.FAIL,
        severity: SEVERITY.BLOCKER,
        expected: "2xx HTTP response",
        actual: `${response.status} ${response.statusText}`,
        evidence: { transport_error: { code: "http_status", message: `${response.status} ${response.statusText}` } },
      }));
      return assertions;
    }
    html = await response.text();
    assertions.push(assertion({
      id: `http:${page.page_id}`,
      family: "funnel-flow",
      page,
      status: STATUS.PASS,
      expected: "2xx HTTP response",
      actual: `${response.status} ${response.statusText}`,
    }));
  } catch (error) {
    assertions.push(assertion({
      id: `http:${page.page_id}`,
      family: "funnel-flow",
      page,
      status: STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      expected: "fetchable deployed page",
      actual: null,
      evidence: { transport_error: { code: "fetch_error", message: error instanceof Error ? error.message : String(error) } },
    }));
    return assertions;
  }

  const expectedMeta = page.expected_meta_tags || {};
  const actualMeta = extractMetaTags(html);
  for (const [name, expected] of Object.entries(expectedMeta)) {
    const actual = actualMeta[name] || null;
    const matches = metaTagMatches(name, actual, expected);
    assertions.push(assertion({
      id: `meta:${page.page_id}:${name}`,
      family: "meta-tags",
      page,
      status: matches ? STATUS.PASS : STATUS.FAIL,
      severity: matches ? undefined : SEVERITY.BLOCKER,
      expected,
      actual,
      evidence: matches ? undefined : { expected, actual },
    }));
  }

  for (const [kind, expectedUrl] of [
    ["next", page.expected_next_url],
    ["accept", page.expected_accept_url],
    ["decline", page.expected_decline_url],
  ]) {
    if (!expectedUrl) continue;
    const staticFound = htmlIncludesRouteReference(html, expectedUrl);
    const sdkAction = staticFound ? null : findSdkRouteAction(html, kind, page);
    const found = staticFound || Boolean(sdkAction);
    assertions.push(assertion({
      id: `route-link:${page.page_id}:${kind}`,
      family: "funnel-flow",
      page,
      status: found ? STATUS.PASS : STATUS.MANUAL_REVIEW,
      severity: found ? undefined : SEVERITY.WARN,
      expected: expectedUrl,
      actual: staticFound ? expectedUrl : sdkAction || "not found in static HTML",
      evidence: found ? (sdkAction ? { expected: expectedUrl, sdk_action: sdkAction } : undefined) : { expected: expectedUrl, note: "Route may be SDK/runtime-derived; verify manually if absent from static HTML." },
    }));
  }

  return assertions;
}

async function maybeRunTestOrders({ args, resolved, runId, assertions }) {
  const mode = String(args["test-order"] || "off").toLowerCase();
  const legacyMode = String(args["legacy-api-test-order"] || "off").toLowerCase();
  if ((!mode || mode === "off") && (!legacyMode || legacyMode === "off")) return [];
  if (mode && mode !== "off") {
    // Test Orders use global test cards: they bypass the payment gateway, create
    // no transactions, and need no merchant setup or approval. `--test-order
    // <mode>` is sufficient intent — no permission flags or packet policy gate.
    const result = await runBrowserTestOrders(resolved.topologies, args, runId);
    assertions.push(...result.assertions);
    return result.orders;
  }

  return maybeRunLegacyApiTestOrders({ args: { ...args, "test-order": legacyMode }, resolved, runId, assertions });
}

async function maybeRunLegacyApiTestOrders({ args, resolved, runId, assertions }) {
  const mode = String(args["test-order"] || "off").toLowerCase();
  if (!mode || mode === "off") return [];
  // Diagnostic-only legacy path. Like the browser path, it needs no permission
  // flags or packet policy gate — test cards bypass the gateway. It still needs
  // API credentials because it talks to the Campaigns API directly.
  const apiKey = stringArg(args["api-key"]) || process.env.QA_CAMPAIGNS_API_KEY;
  const apiBase = stringArg(args["campaigns-api-base"]) || process.env.CAMPAIGNS_API_BASE;
  if (!apiKey || !apiBase) throw new Error("Legacy direct API test orders require --api-key/QA_CAMPAIGNS_API_KEY and --campaigns-api-base/CAMPAIGNS_API_BASE.");
  const cart = parseCart(args.cart);
  if (!cart.length) throw new Error("--test-order requires --cart package_id:quantity pairs.");
  const checkout = findPage(resolved.topologies, "checkout");
  if (!checkout?.url) throw new Error("--test-order requires a checkout page URL.");
  const upsell = findPage(resolved.topologies, "upsell");
  const paths = mode === "both" ? ["accept", "decline"] : [mode];
  const orders = [];
  for (const path of paths) {
    if (!["accept", "decline"].includes(path)) throw new Error(`Unknown --test-order mode: ${mode}`);
    const create = await createTestOrder({ apiBase, apiKey, cart, runId, successUrl: checkout.expected_next_url || upsell?.url || checkout.url, spec: resolved.spec, args });
    const verification = { expected_line_count: cart.length, actual_line_count: 0, diff: [], verified: false };
    if (!create.ok) {
      verification.error = create.error || "order create failed";
      assertions.push(assertion({
        id: `test-order:${path}`,
        family: "api-metadata",
        page: checkout,
        status: STATUS.FAIL,
        severity: SEVERITY.BLOCKER,
        expected: "test order created",
        actual: create.error || create.status,
      }));
    } else {
      assertions.push(assertion({
        id: `test-order:${path}`,
        family: "api-metadata",
        page: checkout,
        status: STATUS.PASS,
        expected: "test order created",
        actual: create.number || create.ref_id,
      }));
      verification.actual_line_count = Array.isArray(create.raw?.lines) ? create.raw.lines.length : cart.length;
      verification.verified = true;
    }
    orders.push({
      path,
      next_order_id: create.number,
      qa_run_id_tag: runId,
      cart_state: { packages: cart.map((item) => ({ ref_id: item.packageId, quantity: item.quantity })) },
      receipt_line_items: extractReceiptLines(create.raw),
      verification,
    });
  }
  return orders;
}

async function createTestOrder({ apiBase, apiKey, cart, runId, successUrl, spec, args = {} }) {
  const shippingMethod = firstShippingMethod(spec);
  const body = {
    user: { email: testEmail(args), first_name: "QA", last_name: "Test" },
    lines: cart.map((item) => ({ package_id: Number(item.packageId), quantity: item.quantity })),
    shipping_address: {
      first_name: "QA",
      last_name: "Test",
      line1: "123 Test St",
      line4: "Austin",
      state: "TX",
      postcode: "78701",
      phone_number: "+14807581224",
      country: "US",
    },
    billing_same_as_shipping_address: true,
    payment_detail: { payment_method: "card_token", card_token: "test_card" },
    shipping_method: shippingMethod,
    success_url: successUrl,
    payment_failed_url: `${successUrl}${successUrl.includes("?") ? "&" : "?"}payment_failed=true`,
    attribution: { utm_source: "agentic_qa", qa_run_id: runId },
  };
  try {
    const response = await fetch(`${apiBase.replace(/\/+$/, "")}/orders/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: apiKey },
      body: JSON.stringify(body),
    });
    const raw = await response.json().catch(() => null);
    return {
      ok: response.ok,
      status: response.status,
      raw,
      ref_id: typeof raw?.ref_id === "string" ? raw.ref_id : null,
      number: Number.isFinite(Number(raw?.number || raw?.id)) ? Number(raw?.number || raw?.id) : null,
      error: response.ok ? null : extractApiError(raw) || `${response.status} ${response.statusText}`,
    };
  } catch (error) {
    return { ok: false, status: null, raw: null, ref_id: null, number: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function normalizeSpec(raw) {
  if (Array.isArray(raw?.funnels)) return raw;
  if (Array.isArray(raw?.funnel_pages)) {
    return { ...raw, funnels: [{ id: "default", name: "Default", weight: 100, pages: raw.funnel_pages }] };
  }
  return { ...raw, funnels: [] };
}

function extractTopologies(spec, { baseUrl = null, publicRouteSlug = null, templateFamily = null, commerceStructureContract = null } = {}) {
  const pageById = new Map();
  for (const funnel of spec.funnels || []) {
    for (const page of funnel.pages || []) pageById.set(page.id, page);
  }
  const urlById = new Map();
  for (const [id, page] of pageById) {
    urlById.set(id, resolvePageUrl(page, baseUrl, publicRouteSlug));
  }
  return (spec.funnels || []).map((funnel) => ({
    funnel_id: funnel.id || "default",
    funnel_name: funnel.name || funnel.id || "Default",
    weight: Number(funnel.weight) || 0,
    pages: (funnel.pages || [])
      .filter((page) => page.enabled !== false)
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((page) => ({
        page_id: page.id,
        page_type: page.type || "page",
        order: page.order || 0,
        label: page.label || page.id,
        url: urlById.get(page.id) || null,
        is_entry: Boolean(page.is_entry),
        expected_meta_tags: extractExpectedMetaTags(page, { baseUrl, pageById, urlById, publicRouteSlug }),
        expected_next_url: resolveSibling(pageById, urlById, page.next_page || page.success_url, baseUrl, publicRouteSlug),
        expected_accept_url: resolveSibling(pageById, urlById, page.on_accept, baseUrl, publicRouteSlug),
        expected_decline_url: resolveSibling(pageById, urlById, page.on_decline, baseUrl, publicRouteSlug),
        packages: page.packages || [],
        template_family: templateFamily || undefined,
        commerce_structure_contract: commerceStructureContract?.pages?.[page.type || "page"] || undefined,
        commerce_structure_contract_status: commerceStructureContract?.status || undefined,
      })),
  }));
}

function resolvePageUrl(page, baseUrl, publicRouteSlug = null) {
  if (typeof page.url === "string" && page.url.trim()) return page.url.trim();
  if (!baseUrl) return null;
  const route = typeof page.page_url === "string" && page.page_url.trim()
    ? runtimeRelativeRouteForSpecValue(page.page_url, publicRouteSlug)
    : page.is_entry
      ? ""
      : defaultRouteForType(page.type);
  if (isAbsoluteHttpUrl(route)) return route;
  try {
    return joinBaseUrl(baseUrl, route);
  } catch {
    return null;
  }
}

function defaultRouteForType(type) {
  if (type === "thankyou") return "receipt/";
  if (["presell", "landing", "checkout", "upsell", "downsell"].includes(type)) return `${type}/`;
  return `${type || "page"}/`;
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

function resolveSibling(pageById, urlById, ref, baseUrl, publicRouteSlug = null) {
  if (typeof ref !== "string" || !ref.trim()) return undefined;
  if (urlById.has(ref)) return urlById.get(ref) || null;
  if (isAbsoluteHttpUrl(ref)) return ref;
  if (baseUrl && (ref.startsWith("/") || ref.includes(".") || ref.endsWith("/"))) {
    try {
      return joinBaseUrl(baseUrl, runtimeRelativeRouteForSpecValue(ref, publicRouteSlug) || ref);
    } catch {
      return ref;
    }
  }
  return ref;
}

function joinBaseUrl(baseUrl, route) {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const normalizedRoute = route.replace(/^\/+/, "");
  const baseSegments = base.pathname.split("/").filter(Boolean);
  const routeSegments = normalizedRoute.split("/").filter(Boolean);
  if (baseSegments.length && routeSegments.length && baseSegments.at(-1) === routeSegments[0]) {
    return new URL(normalizedRoute, `${base.origin}/`).toString();
  }
  return new URL(normalizedRoute, base).toString();
}

function extractExpectedMetaTags(page, { baseUrl, pageById, urlById, publicRouteSlug } = {}) {
  const source = page.sdk_hints?.meta_tags;
  if (!source || typeof source !== "object") return undefined;
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (isRoutingMetaTag(key)) {
      const resolved = resolveSibling(pageById || new Map(), urlById || new Map(), value, baseUrl, publicRouteSlug);
      out[key] = stripOrigin(resolved || value);
    } else {
      out[key] = value;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function extractMetaTags(html) {
  const meta = {};
  const tagPattern = /<meta\b[^>]*>/gi;
  const attrPattern = /([a-zA-Z_:.-]+)\s*=\s*["']([^"']*)["']/g;
  for (const tag of html.match(tagPattern) || []) {
    const attrs = {};
    for (const match of tag.matchAll(attrPattern)) attrs[match[1].toLowerCase()] = decodeHtml(match[2]);
    const key = attrs.name || attrs.property;
    if (key && attrs.content !== undefined) meta[key] = attrs.content;
  }
  return meta;
}

async function fetchSpec(mapId, proxyBase) {
  const url = `${proxyBase.replace(/\/+$/, "")}/api/spec/${encodeURIComponent(mapId)}`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Spec fetch failed: ${response.status} ${response.statusText} (${url})`);
  const body = await response.json();
  return body && body.ok && body.data ? body.data : body;
}

async function postVerdict(verdict, proxyBase) {
  const response = await fetch(`${proxyBase.replace(/\/+$/, "")}/api/qa/verdicts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(verdict),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Verdict POST failed: ${response.status} ${response.statusText} ${body}`);
  return body ? JSON.parse(body) : { ok: true };
}

function assertion({ id, family, page, status, severity, expected, actual, evidence }) {
  return {
    id,
    family,
    page: page.page_id || page.label || "campaign",
    url: page.url || undefined,
    status,
    ...(severity ? { severity } : {}),
    ...(expected !== undefined ? { expected } : {}),
    ...(actual !== undefined ? { actual } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

function writeLocalVerdict(verdict, outputDir) {
  const dir = join(outputDir, verdict.campaign_slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${verdict.run_id}.json`);
  writeFileSync(path, `${JSON.stringify(verdict, null, 2)}\n`);
  return path;
}

function output(value, args) {
  if (args.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (value.action === "qa-policy-set") {
    console.log(`QA metadata updated.`);
    console.log(`Packet: ${value.packet_path}`);
    console.log(`Changed: ${value.changed.length ? value.changed.join(", ") : "(none)"}`);
    return;
  }
  if (value.verdict) {
    console.log(`QA run complete.`);
    console.log(`Map ID: ${value.map_id}`);
    console.log(`Base URL: ${value.base_url || "(missing)"}`);
    console.log(`Run ID: ${value.run_id}`);
    console.log(`Disposition: ${value.verdict.disposition}`);
    console.log(`Counts: ${Object.entries(value.counts).map(([status, count]) => `${count} ${status}`).join(", ")}`);
    console.log(`Local copy: ${value.local_path}`);
    if (value.posted?.ok && value.dashboard_url) {
      console.log(`QA portal: ${value.dashboard_url}`);
    } else if (value.publish_skipped) {
      console.log(`QA portal: publish skipped (--no-post-verdict); local verdict only.`);
    } else {
      console.log(`QA portal: publish failed${value.post_error ? ` (${value.post_error})` : ""}; local verdict kept at ${value.local_path}. Re-run with network access, or pass --no-post-verdict to silence.`);
    }
    console.log(`Workflow finding? campaigns-os findings add --stage qa --kind missing_prompt --summary "..." --qa-run-id ${value.run_id}`);
    return;
  }
  console.log(`QA resolve complete.`);
  console.log(`Map ID: ${value.map_id}`);
  console.log(`Spec: ${value.spec_source}`);
  console.log(`Base URL: ${value.base_url || "(missing)"}`);
  for (const funnel of value.funnels) {
    console.log(`\n${funnel.funnel_name} (${funnel.funnel_id}, ${funnel.weight}%)`);
    for (const page of funnel.pages) console.log(`- [${page.page_type}] ${page.label}: ${page.url || "(missing)"}`);
  }
}

function countAssertions(assertions) {
  const counts = {};
  for (const assertion of assertions) counts[assertion.status] = (counts[assertion.status] || 0) + 1;
  return counts;
}

function computeSpecHash(spec) {
  return `sha256:${createHash("sha256").update(canonicalJson(stripVolatileSpecFields(spec))).digest("hex")}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function stripVolatileSpecFields(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return spec;
  const out = {};
  for (const [key, value] of Object.entries(spec)) {
    if (["spec_identity", "slug", "map_id", "saved_at"].includes(key)) continue;
    out[key] = value;
  }
  return out;
}

function generateRunId() {
  const timestamp = Date.now().toString(36).toUpperCase().padStart(8, "0");
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUV";
  const suffix = Array.from({ length: 18 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  return `${timestamp}${suffix}`;
}

function resolveFromFile(filePath, targetPath) {
  if (!targetPath) return null;
  if (isAbsoluteHttpUrl(targetPath) || targetPath.startsWith("/")) return targetPath;
  return resolve(dirname(resolve(filePath)), targetPath);
}

function readJson(path) {
  if (!existsSync(path)) throw new Error(`File does not exist: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function stringArg(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function setOptionalBoolean(target, property, args, key, changed) {
  if (!(key in args)) return;
  const value = booleanArg(args[key], key);
  setIfChanged(target, property, value, changed);
}

function setOptionalString(target, property, args, key, changed) {
  if (!(key in args)) return;
  const value = stringArg(args[key]);
  if (!value) throw new Error(`--${key} requires a value.`);
  setIfChanged(target, property, value, changed);
}

function setIfChanged(target, property, value, changed) {
  if (target[property] === value) return;
  target[property] = value;
  changed.push(property);
}

function booleanArg(value, key) {
  if (value === true) return true;
  const normalized = String(value || "").trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`--${key} must be true or false.`);
}

export function shouldPublishVerdict(args) {
  // Publishing the QA verdict to the portal is the default shape. Opt out with
  // --no-post-verdict, --local-only, or --post-verdict false (offline / dev / CI runs).
  if (args["no-post-verdict"] === true || args["local-only"] === true) return false;
  if ("post-verdict" in args) {
    const value = args["post-verdict"];
    if (value === true) return true;
    const normalized = String(value).trim().toLowerCase();
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  return true;
}

function policySnapshot(packet) {
  return {
    campaign: {
      allowed_domains_confirmed: packet.campaign?.allowed_domains_confirmed ?? null,
    },
    deploy: {
      target: packet.deploy?.target ?? null,
      preview_url: packet.deploy?.preview_url ?? null,
      production_url: packet.deploy?.production_url ?? null,
    },
    qa: {
      test_orders_allowed: packet.qa?.test_orders_allowed ?? null,
      sandbox_test_card_confirmed: packet.qa?.sandbox_test_card_confirmed ?? null,
    },
  };
}

function normalizeBaseUrl(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeQaBaseUrl(value, publicRouteSlug) {
  const baseUrl = normalizeBaseUrl(value);
  if (!baseUrl) return null;
  const slug = normalizePublicRouteSlug(publicRouteSlug);
  if (!slug) return ensureUrlTrailingSlash(baseUrl);
  try {
    const url = new URL(ensureUrlTrailingSlash(baseUrl));
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.at(-1) === slug) return ensureUrlTrailingSlash(url.toString());
    return new URL(`${slug}/`, url).toString();
  } catch {
    return ensureUrlTrailingSlash(baseUrl);
  }
}

function resolvePublicRouteSlug({ packet, spec, rawSpec }) {
  return stringArg(packet?.campaign?.public_route_slug)
    || stringArg(packet?.deploy?.live_url_path)?.replace(/^\/+|\/+$/g, "")
    || stringArg(spec?.spec_identity?.public_route_slug)
    || stringArg(rawSpec?.spec_identity?.public_route_slug)
    || stringArg(spec?.campaign?.slug)
    || stringArg(rawSpec?.campaign?.slug)
    || null;
}

function normalizePublicRouteSlug(value) {
  if (!value) return "";
  return String(value).trim().replace(/^\/+|\/+$/g, "");
}

function ensureUrlTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function isAbsoluteHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function stripOrigin(value) {
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}

function isRoutingMetaTag(name) {
  return [
    "next-success-url",
    "next-upsell-accept-url",
    "next-upsell-decline-url",
    "next-payment-failed-url",
  ].includes(String(name || "").toLowerCase());
}

function metaTagMatches(name, actual, expected) {
  if (actual === expected) return true;
  if (!isRoutingMetaTag(name)) return false;
  return comparableRoute(actual) === comparableRoute(expected);
}

function comparableRoute(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const raw = value.trim();
  try {
    const url = new URL(raw);
    return normalizeRoutePath(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    return normalizeRoutePath(raw);
  }
}

function normalizeRoutePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("/")) return normalizePathTrailingSlash(raw);
  return normalizePathTrailingSlash(normalizePageKitRoute(raw) || raw);
}

function normalizePathTrailingSlash(value) {
  if (!value || /[?#]/.test(value) || value.endsWith("/")) return value;
  return `${value}/`;
}

function htmlIncludesRouteReference(html, expectedUrl) {
  if (!expectedUrl) return false;
  const path = stripOrigin(expectedUrl);
  return html.includes(expectedUrl) || html.includes(path);
}

function findSdkRouteAction(html, kind, page) {
  if (page.page_type !== "upsell") return null;
  if (kind === "accept" && /\bdata-next-upsell-action\s*=\s*["']add["']/i.test(html)) {
    return 'SDK upsell accept control: data-next-upsell-action="add"';
  }
  if (kind === "decline" && /\bdata-next-upsell-action\s*=\s*["']skip["']/i.test(html)) {
    return 'SDK upsell decline control: data-next-upsell-action="skip"';
  }
  return null;
}

function decodeHtml(value) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseCart(value) {
  if (!value) return [];
  return String(value).split(",").map((part) => {
    const [packageId, quantity] = part.split(":").map((item) => item.trim());
    return { packageId, quantity: Number.parseInt(quantity || "1", 10) || 1 };
  }).filter((item) => item.packageId);
}

function findPage(topologies, type) {
  for (const topology of topologies) {
    const page = topology.pages.find((candidate) => candidate.page_type === type);
    if (page) return page;
  }
  return null;
}

function firstShippingMethod(spec) {
  const first = Array.isArray(spec.shipping_methods) ? spec.shipping_methods[0] : null;
  return Number(first?.ref_id || first?.id || 1);
}

function extractReceiptLines(raw) {
  const lines = Array.isArray(raw?.lines) ? raw.lines : [];
  return lines.map((line) => ({
    ref_id: line.package_id || line.ref_id || line.id || "",
    name: line.name || line.title || "Line item",
    quantity: Number(line.quantity || 1),
    price_cents: Number(line.price_cents || line.total_cents || 0),
  }));
}

function extractApiError(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.detail === "string") return raw.detail;
  if (typeof raw.error === "string") return raw.error;
  if (typeof raw.message === "string") return raw.message;
  return null;
}
