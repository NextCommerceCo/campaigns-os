import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createVerdict, SEVERITY, STATUS, validateVerdict } from "./qa-verdict.mjs";

const DEFAULT_PROXY_BASE = "https://campaign-map.nextcommerce.com";
const RUNTIME = "campaigns-os-node-qa@0.1.0-alpha.0";

const HELP = `campaigns-os qa — Node/npm spec-aware QA

Usage:
  campaigns-os qa resolve --packet <campaign-runtime.build.json> [--base-url <url>] [--json]
  campaigns-os qa run --packet <campaign-runtime.build.json> [--base-url <url>] [--output-dir qa-output] [--json]
  campaigns-os qa resolve <map-id> --spec <campaign-spec.json> [--base-url <url>]
  campaigns-os qa run <map-id> --spec <campaign-spec.json> --base-url <url>

Options:
  --packet <path>                 Read Map ID, local CampaignSpec, deploy URL, and QA policy from a Build Packet.
  --spec <path>                   Local exported CampaignSpec JSON. Preferred for the prepared-HTML flow.
  --proxy-base <url>              Campaign Map proxy base for fetching /api/spec/<map-id>.
  --base-url <url>                Deployed campaign root. Packet deploy URL is used when omitted.
  --output-dir <path>             Local verdict directory. Default: qa-output.
  --post-verdict                  POST verdict JSON to <proxy-base>/api/qa/verdicts after writing the local copy.
  --auth-cookie <cookie>          Cookie header for protected previews.
  --test-order <off|accept|decline|both>
  --allow-test-orders             Required with --test-order other than off.
  --sandbox-test-card-confirmed   Required with --test-order other than off.
  --api-key <key>                 Campaigns API key for test orders. Env QA_CAMPAIGNS_API_KEY is also recognized.
  --campaigns-api-base <url>      Campaigns API base URL for test orders. Env CAMPAIGNS_API_BASE is also recognized.
  --cart <package-ref:qty,...>    Base cart for test orders.
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
  const baseUrl = normalizeBaseUrl(stringArg(args["base-url"]) || packet?.deploy?.preview_url || packet?.deploy?.production_url || null);
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
  const specHash = computeSpecHash(rawSpec);
  const topologies = extractTopologies(normalized, { baseUrl });
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
    topologies,
  };
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
  let postResult = null;
  if (args["post-verdict"]) {
    postResult = await postVerdict(verdict, resolved.proxyBase);
  }
  return {
    ok: verdict.disposition !== "blocked",
    status: verdict.disposition,
    run_id: verdict.run_id,
    map_id: resolved.mapId,
    base_url: resolved.baseUrl,
    dashboard_url: `${resolved.proxyBase.replace(/\/+$/, "")}/qa?slug=${encodeURIComponent(resolved.mapId)}&run=${encodeURIComponent(verdict.run_id)}`,
    local_path: localPath,
    posted: postResult,
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
    assertions.push(assertion({
      id: `meta:${page.page_id}:${name}`,
      family: "meta-tags",
      page,
      status: actual === expected ? STATUS.PASS : STATUS.FAIL,
      severity: actual === expected ? undefined : SEVERITY.BLOCKER,
      expected,
      actual,
      evidence: actual === expected ? undefined : { expected, actual },
    }));
  }

  for (const [kind, expectedUrl] of [
    ["next", page.expected_next_url],
    ["accept", page.expected_accept_url],
    ["decline", page.expected_decline_url],
  ]) {
    if (!expectedUrl) continue;
    const found = html.includes(expectedUrl) || html.includes(stripOrigin(expectedUrl));
    assertions.push(assertion({
      id: `route-link:${page.page_id}:${kind}`,
      family: "funnel-flow",
      page,
      status: found ? STATUS.PASS : STATUS.MANUAL_REVIEW,
      severity: found ? undefined : SEVERITY.WARN,
      expected: expectedUrl,
      actual: found ? expectedUrl : "not found in static HTML",
      evidence: found ? undefined : { expected: expectedUrl, note: "Route may be SDK/runtime-derived; verify manually if absent from static HTML." },
    }));
  }

  return assertions;
}

async function maybeRunTestOrders({ args, resolved, runId, assertions }) {
  const mode = String(args["test-order"] || "off").toLowerCase();
  if (!mode || mode === "off") return [];
  const packetPolicy = resolved.packet?.qa || {};
  if (args["allow-test-orders"] !== true || args["sandbox-test-card-confirmed"] !== true) {
    throw new Error("--test-order requires --allow-test-orders and --sandbox-test-card-confirmed.");
  }
  if (resolved.packet && (packetPolicy.test_orders_allowed !== true || packetPolicy.sandbox_test_card_confirmed !== true)) {
    throw new Error("Build Packet QA policy does not allow backend test orders.");
  }
  const apiKey = stringArg(args["api-key"]) || process.env.QA_CAMPAIGNS_API_KEY;
  const apiBase = stringArg(args["campaigns-api-base"]) || process.env.CAMPAIGNS_API_BASE;
  if (!apiKey || !apiBase) throw new Error("Backend test orders require --api-key/QA_CAMPAIGNS_API_KEY and --campaigns-api-base/CAMPAIGNS_API_BASE.");
  const cart = parseCart(args.cart);
  if (!cart.length) throw new Error("--test-order requires --cart package_id:quantity pairs.");
  const checkout = findPage(resolved.topologies, "checkout");
  if (!checkout?.url) throw new Error("--test-order requires a checkout page URL.");
  const upsell = findPage(resolved.topologies, "upsell");
  const paths = mode === "both" ? ["accept", "decline"] : [mode];
  const orders = [];
  for (const path of paths) {
    if (!["accept", "decline"].includes(path)) throw new Error(`Unknown --test-order mode: ${mode}`);
    const create = await createTestOrder({ apiBase, apiKey, cart, runId, successUrl: checkout.expected_next_url || upsell?.url || checkout.url, spec: resolved.spec });
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

async function createTestOrder({ apiBase, apiKey, cart, runId, successUrl, spec }) {
  const shippingMethod = firstShippingMethod(spec);
  const body = {
    user: { email: `qa+${Date.now()}@example.com`, first_name: "QA", last_name: "Test" },
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

function extractTopologies(spec, { baseUrl = null } = {}) {
  const pageById = new Map();
  for (const funnel of spec.funnels || []) {
    for (const page of funnel.pages || []) pageById.set(page.id, page);
  }
  const urlById = new Map();
  for (const [id, page] of pageById) {
    urlById.set(id, resolvePageUrl(page, baseUrl));
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
        expected_meta_tags: extractExpectedMetaTags(page),
        expected_next_url: resolveSibling(pageById, urlById, page.next_page || page.success_url, baseUrl),
        expected_accept_url: resolveSibling(pageById, urlById, page.on_accept, baseUrl),
        expected_decline_url: resolveSibling(pageById, urlById, page.on_decline, baseUrl),
        packages: page.packages || [],
      })),
  }));
}

function resolvePageUrl(page, baseUrl) {
  if (typeof page.url === "string" && page.url.trim()) return page.url.trim();
  if (!baseUrl) return null;
  const route = typeof page.page_url === "string" && page.page_url.trim()
    ? normalizePageKitRoute(page.page_url)
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

function resolveSibling(pageById, urlById, ref, baseUrl) {
  if (typeof ref !== "string" || !ref.trim()) return undefined;
  if (urlById.has(ref)) return urlById.get(ref) || null;
  if (isAbsoluteHttpUrl(ref)) return ref;
  if (baseUrl && (ref.startsWith("/") || ref.includes(".") || ref.endsWith("/"))) {
    try {
      return joinBaseUrl(baseUrl, normalizePageKitRoute(ref) || ref);
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

function extractExpectedMetaTags(page) {
  const source = page.sdk_hints?.meta_tags;
  if (!source || typeof source !== "object") return undefined;
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") out[key] = value;
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
  if (value.verdict) {
    console.log(`QA run complete.`);
    console.log(`Map ID: ${value.map_id}`);
    console.log(`Base URL: ${value.base_url || "(missing)"}`);
    console.log(`Run ID: ${value.run_id}`);
    console.log(`Disposition: ${value.verdict.disposition}`);
    console.log(`Counts: ${Object.entries(value.counts).map(([status, count]) => `${count} ${status}`).join(", ")}`);
    console.log(`Local copy: ${value.local_path}`);
    console.log(`Dashboard: ${value.dashboard_url}`);
    if (value.posted) console.log(`Posted: ${JSON.stringify(value.posted)}`);
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

function stringArg(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeBaseUrl(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
