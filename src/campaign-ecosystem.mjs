import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "contracts");
const FIELD_CONTRACT_PATH = join(CONTRACTS_DIR, "campaign-cart-checkout-field-contract.v0.json");
const SDK_POLICY_PATH = join(CONTRACTS_DIR, "campaign-cart-sdk-support-policy.v0.json");

const SKIP_DIRS = new Set([
  ".git",
  ".campaign-runtime",
  "_site",
  "node_modules",
  "qa-output",
  "dist",
  "build",
]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts"]);
const MAX_SAMPLE_COUNT = 8;

// Any http(s) reference to a campaign-cart artifact, pinned or not. The
// semver (when pinned) is extracted separately so @latest/@main/commit pins
// are still discovered — they just can't be evaluated against version policy.
const LOADER_URL_PATTERN = /https?:\/\/[^"'\s]*campaign-cart@([^"'\s/]+)[^"'\s]*/g;
const LOADER_ARTIFACT_PATTERN = /\/loader(?:\.min)?\.js\b|\/dist\//;
const CAMPAIGN_ID_META_PATTERN = /<meta\s+[^>]*name=["']next-campaign-id["'][^>]*>/gi;
const NEXT_CONFIG_PATTERN = /window\.nextConfig\s*=/;
const DATA_NEXT_PATTERN = /\bdata-next-[a-zA-Z0-9_-]+/g;
const PAYMENT_RADIO_TAG_PATTERN = /<input\b[^>]*name=["']payment_method["'][^>]*>/gi;

// Proximity window for markup-embedded sync evidence: a payment_method
// reference and the dispatchEvent that fires the change must sit within this
// many characters of each other. ~600 chars ≈ a typical handler function body,
// so a realistic handler co-locates both tokens; the rejected alternative —
// treating any file-level co-occurrence as evidence (an analytics dispatchEvent
// elsewhere in the file) — would overclaim wiring. Script scopes below
// PAYMENT_SYNC_SCRIPT_SCOPE_MAX_CHARS are scanned whole (see hasSyncSignals) so
// a handler longer than this window still counts; over-cap script content
// (vendored bundles) is never claimed as sync evidence at all — the proof
// state stays honestly unproven instead of overclaimed. Proximity applies only
// to markup with script bodies masked out.
const PAYMENT_SYNC_PROXIMITY_WINDOW_CHARS = 600;
const PAYMENT_SYNC_SCRIPT_SCOPE_MAX_CHARS = 20000;
const SCRIPT_BLOCK_PATTERN = /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi;

export const CAMPAIGN_CART_APP_CAPABILITIES = [
  "campaign_cart_runtime_inventory",
  "sdk_loader_discovery",
  "sdk_version_policy",
  "checkout_field_contract",
  "payment_interaction_risk",
];

export function loadCheckoutFieldContract(override = null) {
  if (override && typeof override === "object") return override;
  const contract = readJson(FIELD_CONTRACT_PATH);
  if (!contract) {
    throw new Error(`Checkout field contract is missing or unparseable: ${FIELD_CONTRACT_PATH}`);
  }
  return contract;
}

export function loadSdkSupportPolicy(override = null) {
  if (override && typeof override === "object") {
    return {
      source: normalizeString(override.source) || "inline_policy",
      minimum_supported: normalizeString(override.minimum_supported),
      preferred_minimum: normalizeString(override.preferred_minimum),
    };
  }
  const policy = readJson(SDK_POLICY_PATH);
  if (!policy) {
    throw new Error(`SDK support policy contract is missing or unparseable: ${SDK_POLICY_PATH}`);
  }
  return {
    source: normalizeString(policy?.source) || "contracts/campaign-cart-sdk-support-policy.v0.json",
    minimum_supported: normalizeString(policy?.minimum_supported),
    preferred_minimum: normalizeString(policy?.preferred_minimum),
  };
}

export function discoverCampaignCartAppRoots(targetRepo, { excludeRoots = [] } = {}) {
  const target = resolve(targetRepo);
  if (!existsSync(target) || !statSync(target).isDirectory()) return [];
  const excluded = excludeRoots.map((root) => resolve(root));
  const rootEvidence = new Map();

  for (const file of listFiles(target)) {
    if (excluded.some((root) => file === root || file.startsWith(`${root}${sep}`))) continue;
    const ext = extname(file).toLowerCase();
    const isHtml = HTML_EXTENSIONS.has(ext);
    const isScript = SCRIPT_EXTENSIONS.has(ext);
    if (!isHtml && !isScript) continue;
    const raw = safeReadText(file);
    if (raw === null) continue;
    const content = isHtml ? maskHtmlComments(raw) : raw;

    const signals = [];
    for (const match of content.matchAll(withGlobal(LOADER_URL_PATTERN))) {
      if (LOADER_ARTIFACT_PATTERN.test(match[0])) {
        signals.push({ signal: "campaign_cart_loader", strength: "strong", detail: match[0] });
      }
    }
    if (isHtml && withGlobal(CAMPAIGN_ID_META_PATTERN).test(content)) {
      signals.push({ signal: "next_campaign_id_meta", strength: "strong", detail: null });
    }
    if (NEXT_CONFIG_PATTERN.test(content)) {
      signals.push({ signal: "next_config_global", strength: "strong", detail: null });
    }
    if (isHtml) {
      const anchors = content.match(DATA_NEXT_PATTERN) || [];
      if (anchors.length) {
        signals.push({ signal: "data_next_anchors", strength: "weak", count: anchors.length, detail: "data-next anchors" });
      }
    }
    if (!signals.length) continue;

    const rootPath = attributeRoot(target, file);
    if (!rootEvidence.has(rootPath)) rootEvidence.set(rootPath, []);
    const bucket = rootEvidence.get(rootPath);
    for (const entry of signals) {
      bucket.push({ ...entry, path: relPath(rootPath, file) });
    }
  }

  const roots = [];
  for (const [rootPath, evidence] of rootEvidence) {
    const strong = evidence.filter((entry) => entry.strength === "strong");
    const weakAnchorTotal = evidence
      .filter((entry) => entry.signal === "data_next_anchors")
      .reduce((total, entry) => total + (Number.isFinite(entry.count) ? entry.count : 0), 0);
    if (strong.length >= 1 || weakAnchorTotal >= 5) {
      roots.push({ rootPath, evidence: dedupeEvidence(evidence) });
    }
  }
  return roots.sort((a, b) => a.rootPath.localeCompare(b.rootPath));
}

export function scanCampaignCartAppRoot({
  targetRepo,
  rootPath,
  evidence = [],
  fieldContract = null,
  sdkSupportPolicy = null,
  excludeRoots = [],
}) {
  const target = resolve(targetRepo);
  const root = resolve(rootPath);
  const contract = loadCheckoutFieldContract(fieldContract);
  const policy = loadSdkSupportPolicy(sdkSupportPolicy);
  // Only sibling roots nested INSIDE this root are excluded; ancestors are
  // irrelevant (listFiles never leaves root) and must not mask the scan.
  const excluded = excludeRoots
    .map((entry) => resolve(entry))
    .filter((entry) => entry !== root && entry.startsWith(`${root}${sep}`));
  const files = listFiles(root)
    .filter((file) => !excluded.some((other) => file === other || file.startsWith(`${other}${sep}`)));
  const htmlFiles = files.filter((file) => HTML_EXTENSIONS.has(extname(file).toLowerCase()));
  const scriptFiles = files.filter((file) => SCRIPT_EXTENSIONS.has(extname(file).toLowerCase()));
  const findings = [];

  const frameworks = detectFrameworks(root);
  const loader = collectLoaderReferences(root, [...htmlFiles, ...scriptFiles]);
  // Delivery can be a hosted loader URL OR a bundled npm dependency. When the
  // SDK ships as a dependency there is no loader ref to discover, but the pin
  // is still a real version signal — record it and feed a resolved semver into
  // version policy like a discovered version (source-distinguishable below).
  const bundled = detectBundledSdkDependency(root);
  loader.bundled_dependency = bundled
    ? { name: bundled.name, version: bundled.version, resolved_version: bundled.resolved_version }
    : null;
  // A prerelease pin sorts strictly before its GA release, so it is never fed
  // into version policy as a clean semver — the numeric triple would wrongly
  // pass the release gate. It is recorded on sdk_loader and flagged instead.
  const bundledPolicyVersion = bundled?.resolved_version && !bundled.prerelease
    ? bundled.resolved_version
    : null;
  const versionEntries = [
    ...loader.versions.map((version) => ({ version, source: "loader" })),
    ...(bundledPolicyVersion && !loader.versions.includes(bundledPolicyVersion)
      ? [{ version: bundledPolicyVersion, source: "bundled_dependency" }]
      : []),
  ];
  const versionPolicy = evaluateVersionPolicy(versionEntries, policy, findings);
  if (bundled?.prerelease) {
    findings.push(finding({
      severity: "warning",
      category: "standardization_warning",
      code: "version.sdk_prerelease_pin",
      message: `Bundled Campaign Cart dependency pins prerelease ${bundled.resolved_version} (${bundled.name}@${bundled.version}); a prerelease sorts before its release and cannot be evaluated against the release support policy.`,
      confidence: "static_contract",
      evidence: { name: bundled.name, version: bundled.version, resolved_version: bundled.resolved_version },
      next_action: "Pin the bundled campaign-cart dependency to a released version so version policy can be evaluated.",
    }));
  }
  const checkoutFields = inspectCheckoutFields(root, htmlFiles, contract, findings);
  const payment = inspectPaymentSurfaces(root, htmlFiles, scriptFiles, findings);
  const dataNext = inspectDataNext(root, htmlFiles);
  const runtime = inspectRuntimeArtifacts(root, target, findings);
  const campaignIds = collectCampaignIds(htmlFiles);

  const unpinned = loader.references.filter((entry) => !entry.version);
  if (unpinned.length) {
    findings.push(finding({
      severity: "warning",
      category: "standardization_warning",
      code: "version.sdk_loader_unpinned",
      message: `${unpinned.length} Campaign Cart loader reference(s) use a non-semver ref (${unique(unpinned.map((entry) => entry.ref)).join(", ")}); version policy cannot be evaluated against an unpinned loader.`,
      confidence: "static_contract",
      evidence: unpinned.slice(0, MAX_SAMPLE_COUNT).map(({ path, line, url }) => ({ path, line, url })),
      next_action: "Pin the loader to an explicit supported version so version policy and QA reproducibility hold.",
    }));
  }
  if (!loader.references.length && !bundled) {
    findings.push(finding({
      severity: "operator_readiness",
      category: "operator_readiness",
      code: "version.sdk_version_unknown",
      message: "Campaign Cart evidence exists but no loader reference or bundled dependency could be discovered from source.",
      confidence: "static_inference",
      next_action: "Confirm how the SDK is delivered (bundled, self-hosted, or injected) before applying version policy.",
    }));
  }

  return {
    id: rootId(target, root),
    status: "unknown",
    ok: false,
    implementation: {
      kind: "campaign_cart_app",
      evidence,
      frameworks,
    },
    capabilities: [...CAMPAIGN_CART_APP_CAPABILITIES],
    identity: {
      repo: basename(target),
      target_repo: target,
      campaign_root: root,
      campaign_root_relative: relPath(target, root),
      campaign_ids: campaignIds,
      sdk_versions: loader.versions,
      has_campaign_runtime: runtime.present,
    },
    sdk_loader: loader,
    version_policy: versionPolicy,
    checkout_fields: checkoutFields,
    payment,
    runtime_contract: {
      data_next: dataNext.summary,
      checkout_surface: dataNext.checkout_surface,
      upsell_surface: dataNext.upsell_surface,
      receipt_surface: dataNext.receipt_surface,
      campaign_runtime: runtime.summary,
    },
    findings,
    remediation: buildRemediation({ checkoutFields, versionPolicy, payment, root }),
  };
}

// Detect a bundled Campaign Cart SDK delivered as an npm dependency. Returns
// the pin spec plus a resolved version (extracted from ranges like `^0.4.30`,
// prerelease suffix preserved: `^0.4.30-beta.1` → `0.4.30-beta.1`) or null
// when no such dependency is declared. A prerelease pin sorts strictly BEFORE
// its GA release in semver, so `prerelease: true` tells the caller the pin
// must NOT be evaluated against the release policy as if it were the release.
function detectBundledSdkDependency(root) {
  const pkg = readJson(join(root, "package.json"));
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  for (const name of ["campaign-cart", "@nextcommerce/campaign-cart"]) {
    const spec = deps[name];
    if (typeof spec !== "string" || !spec.trim()) continue;
    const semver = spec.match(/(\d+\.\d+\.\d+)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/);
    return {
      name,
      version: spec,
      resolved_version: semver ? `${semver[1]}${semver[2] || ""}` : null,
      prerelease: Boolean(semver && semver[2]),
    };
  }
  return null;
}

export function detectFrameworks(root) {
  const pkg = readJson(join(root, "package.json"));
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const known = ["vite", "react", "express", "next", "svelte", "vue", "astro"];
  return known.filter((name) => typeof deps[name] === "string");
}

function collectLoaderReferences(root, files) {
  const references = [];
  for (const file of files) {
    const raw = safeReadText(file);
    if (raw === null) continue;
    const content = HTML_EXTENSIONS.has(extname(file).toLowerCase()) ? maskHtmlComments(raw) : raw;
    for (const match of content.matchAll(withGlobal(LOADER_URL_PATTERN))) {
      if (!LOADER_ARTIFACT_PATTERN.test(match[0])) continue;
      const semver = match[1].match(/^v?(\d+\.\d+\.\d+)$/);
      references.push({
        path: relPath(root, file),
        line: lineOf(content, match.index || 0),
        url: match[0],
        ref: match[1],
        version: semver ? semver[1] : null,
      });
    }
  }
  return {
    references,
    versions: unique(references.map((entry) => entry.version)),
  };
}

function evaluateVersionPolicy(versionEntries, policy, findings) {
  const evaluations = versionEntries.map(({ version, source }) => ({
    version,
    source,
    meets_minimum: policy.minimum_supported ? compareVersions(version, policy.minimum_supported) >= 0 : null,
    meets_preferred: policy.preferred_minimum ? compareVersions(version, policy.preferred_minimum) >= 0 : null,
  }));
  for (const evaluation of evaluations) {
    if (evaluation.meets_minimum === false) {
      findings.push(finding({
        severity: "blocker",
        category: "standardization_blocker",
        code: "version.sdk_below_minimum_supported",
        message: `Campaign Cart SDK ${evaluation.version} is below the minimum supported ${policy.minimum_supported} (policy: ${policy.source}).`,
        confidence: "static_contract",
        next_action: "Upgrade the Campaign Cart loader pin to a supported version and re-run browser QA.",
      }));
    } else if (evaluation.meets_preferred === false) {
      findings.push(finding({
        severity: "warning",
        category: "standardization_warning",
        code: "version.sdk_below_preferred_policy",
        message: `Campaign Cart SDK ${evaluation.version} is below the preferred minimum ${policy.preferred_minimum} (policy: ${policy.source}).`,
        confidence: "static_contract",
        next_action: "Confirm whether the campaign intentionally pins the SDK before recommending an upgrade.",
      }));
    }
  }
  return {
    source: policy.source,
    minimum_supported: policy.minimum_supported,
    preferred_minimum: policy.preferred_minimum,
    evaluations,
  };
}

function inspectCheckoutFields(root, htmlFiles, contract, findings) {
  const bindings = [];
  const attributes = contract?.binding_attributes || ["data-next-checkout-field", "os-checkout-field"];
  const attributePattern = new RegExp(`\\b(${attributes.map(escapeRegExp).join("|")})\\s*=\\s*(["'])([^"']*)\\2`, "g");
  for (const file of htmlFiles) {
    const raw = safeReadText(file);
    if (raw === null) continue;
    const content = maskHtmlComments(raw);
    for (const match of content.matchAll(attributePattern)) {
      const value = match[3].trim();
      const verdict = classifyFieldBinding(value, contract);
      bindings.push({
        attribute: match[1],
        value,
        path: relPath(root, file),
        line: lineOf(content, match.index || 0),
        supported: verdict.classification === "supported",
        classification: verdict.classification,
        canonical: verdict.canonical,
      });
    }
  }

  const unsupported = bindings.filter((entry) => entry.classification === "stale_alias");
  const unknown = bindings.filter((entry) => entry.classification === "unknown");

  if (unsupported.length) {
    findings.push(finding({
      severity: "blocker",
      category: "standardization_blocker",
      code: "checkout.unsupported_field_binding",
      message: `${unsupported.length} checkout field binding(s) use stale aliases the Campaign Cart SDK does not consume (contract: ${contract?.schema_version || "unknown"}).`,
      confidence: "static_contract",
      evidence: dedupeBy(unsupported, (entry) => entry.value)
        .map((entry) => ({ value: entry.value, canonical: entry.canonical, path: entry.path, line: entry.line }))
        .slice(0, MAX_SAMPLE_COUNT),
      next_action: "Rewrite each stale alias to its canonical Campaign Cart field name, then prove checkout binding in browser QA.",
    }));
  }
  if (unknown.length) {
    findings.push(finding({
      severity: "warning",
      category: "standardization_warning",
      code: "checkout.unknown_field_binding",
      message: `${unknown.length} checkout field binding(s) are outside the known Campaign Cart field contract.`,
      confidence: "static_inference",
      evidence: dedupeBy(unknown, (entry) => entry.value)
        .map((entry) => ({ value: entry.value, path: entry.path, line: entry.line }))
        .slice(0, MAX_SAMPLE_COUNT),
      next_action: "Confirm the field against the Campaign Cart SDK before treating it as supported or repairing it.",
    }));
  }

  return {
    contract: contract?.schema_version || null,
    bindings,
    unsupported,
    unknown,
  };
}

function classifyFieldBinding(value, contract) {
  if (!value) return { classification: "unknown", canonical: null };
  const canonicalFields = new Set(contract?.canonical_fields || []);
  const acceptedAliases = contract?.accepted_aliases || {};
  const staleAliases = contract?.stale_aliases || {};
  const prefixes = contract?.prefixes || [];

  let base = value;
  let prefix = "";
  for (const candidate of prefixes) {
    if (value.startsWith(candidate)) {
      prefix = candidate;
      base = value.slice(candidate.length);
      break;
    }
  }
  if (canonicalFields.has(base)) return { classification: "supported", canonical: null };
  if (typeof acceptedAliases[base] === "string") return { classification: "supported", canonical: null };
  if (typeof staleAliases[base] === "string") {
    return { classification: "stale_alias", canonical: `${prefix}${staleAliases[base]}` };
  }
  return { classification: "unknown", canonical: null };
}

function inspectPaymentSurfaces(root, htmlFiles, scriptFiles, findings) {
  const radioFiles = [];
  const hiddenRadioFiles = [];
  const customTriggerFiles = [];
  const syncFiles = [];

  for (const file of htmlFiles) {
    const raw = safeReadText(file);
    if (raw === null) continue;
    const content = maskHtmlComments(raw);
    const radios = content.match(withGlobal(PAYMENT_RADIO_TAG_PATTERN)) || [];
    if (radios.length) radioFiles.push(relPath(root, file));
    if (radios.some((tag) => /display\s*:\s*none/i.test(tag) || /(?<![\w-])hidden(?![\w-])/i.test(tag))) {
      hiddenRadioFiles.push(relPath(root, file));
    }
    if (/\bdata-pay\b|\bdata-payment-method-trigger\b/i.test(content)) {
      customTriggerFiles.push(relPath(root, file));
    }
    if (hasSyncSignals(content)) syncFiles.push(relPath(root, file));
  }
  for (const file of scriptFiles) {
    const content = safeReadText(file);
    if (content === null) continue;
    if (hasSyncSignals(content, { isScript: true })) syncFiles.push(relPath(root, file));
  }

  const customControls = hiddenRadioFiles.length > 0 || customTriggerFiles.length > 0;
  const syncDetected = syncFiles.length > 0;
  // "not_applicable" only when no SDK payment radios exist at all. When radios
  // exist but no custom-control evidence was found, stay "undetermined" —
  // external CSS can hide radios in ways static scanning cannot exclude, so
  // the scanner never affirms that behavioral proof is unnecessary.
  const proofState = customControls
    ? "runtime_proof_required"
    : radioFiles.length
      ? "undetermined"
      : "not_applicable";

  if (customControls) {
    findings.push(finding({
      severity: syncDetected ? "operator_readiness" : "warning",
      category: syncDetected ? "operator_readiness" : "standardization_warning",
      code: "payment.custom_controls_proof_required",
      message: syncDetected
        ? "Custom payment controls sit over hidden SDK payment_method radios; a synchronization script that dispatches change events was detected, but the interaction still requires behavioral (DOM/browser) proof. Missing proof is not a defect claim."
        : "Custom payment controls sit over hidden SDK payment_method radios and no synchronization script was detected; the interaction requires behavioral (DOM/browser) proof before the surface can be trusted. Missing proof is not a defect claim.",
      confidence: "runtime_proof_required",
      evidence: {
        payment_method_radio_files: radioFiles.slice(0, MAX_SAMPLE_COUNT),
        hidden_radio_files: hiddenRadioFiles.slice(0, MAX_SAMPLE_COUNT),
        custom_trigger_files: customTriggerFiles.slice(0, MAX_SAMPLE_COUNT),
        synchronization_files: syncFiles.slice(0, MAX_SAMPLE_COUNT),
      },
      next_action: "Exercise the custom payment controls in a deterministic DOM/browser test and confirm the real payment_method radio state changes and dispatches change events.",
    }));
  }

  return {
    sdk_method_radios: { detected: radioFiles.length > 0, files: unique(radioFiles).slice(0, MAX_SAMPLE_COUNT) },
    hidden_radios: { detected: hiddenRadioFiles.length > 0, files: unique(hiddenRadioFiles).slice(0, MAX_SAMPLE_COUNT) },
    custom_triggers: { detected: customTriggerFiles.length > 0, files: unique(customTriggerFiles).slice(0, MAX_SAMPLE_COUNT) },
    synchronization_script: { detected: syncDetected, files: unique(syncFiles).slice(0, MAX_SAMPLE_COUNT) },
    proof_state: proofState,
  };
}

// Synchronization evidence requires a dispatchEvent co-located with a
// payment_method reference. "Co-located" is scoped, not file-global: a real
// wiring handler keeps both tokens in one handler/script body, so each script
// scope (standalone script file or inline <script> block) under the size cap
// is scanned whole. Over-cap script content is never claimed as sync evidence
// — a vendored bundle's file-level co-occurrence is not proof of wiring, and
// under-claiming keeps the proof state honest (runtime_proof_required /
// undetermined) rather than overclaimed. The proximity window applies only to
// markup, with script bodies masked out first.
function hasSyncSignals(content, { isScript = false } = {}) {
  const text = String(content || "");
  if (isScript) {
    return text.length <= PAYMENT_SYNC_SCRIPT_SCOPE_MAX_CHARS && scopeHasSyncSignals(text);
  }
  for (const match of text.matchAll(SCRIPT_BLOCK_PATTERN)) {
    const body = match[2] || "";
    if (body.length <= PAYMENT_SYNC_SCRIPT_SCOPE_MAX_CHARS && scopeHasSyncSignals(body)) return true;
  }
  return proximityHasSyncSignals(maskScriptBodies(text));
}

// Blank out <script> bodies (preserving offsets/newlines) so the markup
// proximity fallback never reads script content that the scoped scan above
// already judged — including over-cap bundles it deliberately excluded.
function maskScriptBodies(text) {
  return text.replace(SCRIPT_BLOCK_PATTERN, (_match, open, body, close) =>
    `${open}${body.replace(/[^\r\n]/g, " ")}${close}`);
}

// Whole-scope co-occurrence: both tokens present anywhere in one script scope.
function scopeHasSyncSignals(text) {
  return text.includes("payment_method") && /dispatchEvent\s*\(/.test(text);
}

// Proximity co-occurrence: a dispatchEvent within the window of a
// payment_method reference (used for markup outside a single script scope).
function proximityHasSyncSignals(text) {
  let index = text.indexOf("payment_method");
  while (index !== -1) {
    const window = text.slice(
      Math.max(0, index - PAYMENT_SYNC_PROXIMITY_WINDOW_CHARS),
      index + PAYMENT_SYNC_PROXIMITY_WINDOW_CHARS,
    );
    if (/dispatchEvent\s*\(/.test(window)) return true;
    index = text.indexOf("payment_method", index + 1);
  }
  return false;
}

// Blank out HTML comment bodies while preserving offsets/line numbers so
// commented-out markup never produces bindings, radios, or sync evidence.
function maskHtmlComments(content) {
  const masked = String(content || "").replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\r\n]/g, " "));
  // After closed comments are masked, any surviving `<!--` opens a comment
  // that never closes (truncated/corrupt file). Everything from that opener to
  // EOF is commented-out, so mask it too — otherwise a stale binding/radio/
  // loader in the unterminated tail would reintroduce false positives.
  const openIndex = masked.indexOf("<!--");
  if (openIndex === -1) return masked;
  const tail = masked.slice(openIndex).replace(/[^\r\n]/g, " ");
  return `${masked.slice(0, openIndex)}${tail}`;
}

function inspectDataNext(root, htmlFiles) {
  const counts = new Map();
  const checkoutFiles = new Set();
  const upsellFiles = new Set();
  const receiptFiles = new Set();
  for (const file of htmlFiles) {
    const raw = safeReadText(file);
    if (raw === null) continue;
    const content = maskHtmlComments(raw);
    const rel = relPath(root, file);
    for (const match of content.matchAll(DATA_NEXT_PATTERN)) {
      counts.set(match[0], (counts.get(match[0]) || 0) + 1);
    }
    if (/checkout/i.test(rel) || /data-next-checkout|data-next-action=["'](?:checkout|create-order|add-to-cart)/i.test(content)) {
      checkoutFiles.add(rel);
    }
    if (/upsell/i.test(rel) || /data-next-upsell/i.test(content)) upsellFiles.add(rel);
    if (/receipt|thank/i.test(rel) || /\bdata-next-(?:order|receipt)[a-zA-Z0-9_-]*/i.test(content)) receiptFiles.add(rel);
  }
  const attrs = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return {
    summary: {
      total_occurrences: attrs.reduce((total, [, count]) => total + count, 0),
      unique_attributes: attrs.map(([name]) => name),
      top_attributes: attrs.slice(0, 12).map(([name, count]) => ({ name, count })),
    },
    checkout_surface: { detected: checkoutFiles.size > 0, files: [...checkoutFiles].slice(0, MAX_SAMPLE_COUNT) },
    upsell_surface: { detected: upsellFiles.size > 0, files: [...upsellFiles].slice(0, MAX_SAMPLE_COUNT) },
    receipt_surface: { detected: receiptFiles.size > 0, files: [...receiptFiles].slice(0, MAX_SAMPLE_COUNT) },
  };
}

function inspectRuntimeArtifacts(rootPath, targetRepo, findings) {
  const runtimeDirs = unique([join(rootPath, ".campaign-runtime"), join(targetRepo, ".campaign-runtime")]);
  const artifacts = [];
  for (const dir of runtimeDirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    artifacts.push(...listFiles(dir, { includeRuntime: true }).map((file) => relPath(rootPath, file)));
  }
  const present = artifacts.length > 0;
  if (!present) {
    findings.push(finding({
      severity: "warning",
      category: "standardization_warning",
      code: "campaigns_os.artifacts_missing",
      message: "No .campaign-runtime artifacts were found for this root; Campaigns OS build/QA provenance is missing, which is a proof gap, not a confirmed failure.",
      confidence: "static_inference",
      next_action: "Attach Campaigns OS run artifacts (Build Packet, QA verdict) when workflow provenance matters for this campaign.",
    }));
  }
  return {
    present,
    summary: { present, artifact_count: artifacts.length, artifacts: artifacts.slice(0, 40) },
  };
}

function collectCampaignIds(htmlFiles) {
  const ids = new Set();
  for (const file of htmlFiles) {
    const raw = safeReadText(file);
    if (raw === null) continue;
    const content = maskHtmlComments(raw);
    for (const match of content.matchAll(withGlobal(CAMPAIGN_ID_META_PATTERN))) {
      const value = match[0].match(/content=["']([^"']+)["']/i);
      if (value) ids.add(value[1]);
    }
    const config = content.match(/campaignId\s*:\s*["']?(\d+)["']?/);
    if (config) ids.add(config[1]);
  }
  return [...ids];
}

function buildRemediation({ checkoutFields, versionPolicy, payment, root }) {
  const safe = [];
  const clarification = [];
  const risks = [];
  if (checkoutFields.unsupported.length) {
    safe.push("Rewrite stale checkout field aliases to their canonical Campaign Cart names (contract-backed), then prove the checkout binds in browser QA.");
  }
  if (checkoutFields.unknown.length) {
    clarification.push("Confirm unknown checkout field bindings against the Campaign Cart SDK before repair.");
  }
  const failsPolicy = versionPolicy.evaluations.some((entry) => entry.meets_minimum === false || entry.meets_preferred === false);
  if (failsPolicy) {
    risks.push("SDK loader version bumps can change runtime behavior; confirm against campaign QA scope before changing the pin.");
  }
  if (payment.proof_state === "runtime_proof_required") {
    clarification.push("Custom payment controls require deterministic DOM/browser interaction proof; do not repair or clear them from static evidence alone.");
  }
  return {
    safe_agent_repairs: unique(safe),
    clarification_needed: unique(clarification),
    product_or_merchant_risks: unique(risks),
    proof_commands: [
      `campaigns-os standardize --target ${shellQuote(root)} --json`,
    ],
  };
}

function attributeRoot(target, file) {
  let dir = dirname(file);
  while (dir.startsWith(target)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dir === target) break;
    dir = dirname(dir);
  }
  return target;
}

function dedupeEvidence(entries) {
  return dedupeBy(entries, (entry) => `${entry.signal}:${entry.path}`)
    .map(({ signal, strength, path, detail }) => ({ signal, strength, path, detail }));
}

function dedupeBy(entries, keyOf) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const key = keyOf(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function listFiles(root, options = {}) {
  const includeRuntime = options.includeRuntime === true;
  const files = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) return files;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!includeRuntime && shouldSkipDir(entry.name)) continue;
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return files.sort();
}

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name) || (name.startsWith(".") && name !== ".campaigns-os");
}

function safeReadText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function finding({ severity, category, code, message, confidence = null, evidence = null, next_action = null }) {
  return { severity, category, code, message, confidence, evidence, next_action };
}

function lineOf(content, index) {
  return content.slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

function compareVersions(a, b) {
  const left = extractVersion(a);
  const right = extractVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    const diff = left[index] - right[index];
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function extractVersion(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function withGlobal(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function relPath(from, to) {
  const rel = relative(resolve(from), resolve(to)).split(sep).join("/");
  return rel || ".";
}

function rootId(targetRepo, rootPath) {
  return relPath(targetRepo, rootPath).replace(/[^A-Za-z0-9_.-]+/g, "-") || ".";
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value) {
  const raw = String(value || "");
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(raw)) return raw;
  return `'${raw.replace(/'/g, "'\\''")}'`;
}
