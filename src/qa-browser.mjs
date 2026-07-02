import { SEVERITY, STATUS } from "./qa-verdict.mjs";
import { attachAnalyticsCapture, diffAnalyticsParity } from "./qa-analytics-parity.mjs";
import { assessAnalyticsCorrectness } from "./qa-analytics-correctness.mjs";
import {
  demoAssetConfig,
  forbiddenComputedColors,
  normalizeCssColor,
  placeholderTextResidueConfig,
  placeholderTextResidueMatches,
  referencedDemoAssetBasenames,
  repeatedIconSrcs,
  summarizePlaceholderTerms,
} from "./template-brand-contract.mjs";

const DEFAULT_BROWSER_TIMEOUT_MS = 30000;
const DEFAULT_SETTLE_TIMEOUT_MS = 5000;
const DEFAULT_STEP_TIMEOUT_MS = 45000;
const DEFAULT_ORDER_TIMEOUT_MS = 240000;
// Grace on the outer race so per-step timeouts get first chance to record cleanly.
const ORDER_TIMEOUT_GRACE_MS = 5000;
const HOSTED_CHECKOUT_PATH = "/accounts/complete-order/";
const DEFAULT_TEST_CARD = "6011111111111117";
const DEFAULT_TEST_CVV = "123";
const DEFAULT_TEST_EXP_MONTH = "12";
const DEFAULT_TEST_EXP_YEAR = "2030";
const DEFAULT_MAX_TEST_ORDERS = 6;
// Stable fallback customer email for test orders. Two intents, deliberately split:
//
// (b) STABILITY — Test Orders use global test cards that bypass the gateway and
// create no transactions, but the resulting Customer/user record is NOT deletable.
// Every run must therefore reuse ONE address rather than mint a unique one (which
// would litter the customer list). Hence a single stable default, never per-run.
//
// (a) DELIVERABILITY — a test order STILL fires the store's transactional Order
// Confirmation email to this address (confirmed against the platform's published
// test-order behavior: only third-party tracking postbacks are suppressed for test
// orders, not the native receipt — there is even a configurable 0-10 min send delay
// so post-sale upsells fold into one confirmation). `.test` is an RFC 6761 reserved
// TLD that never resolves, so the ESP HARD-BOUNCES it against the *store's* sending
// reputation. Acceptable for low-volume self-QA, but harmful at the volume internal/
// agency runs reach across many merchant stores — those runs MUST set --test-email
// or CAMPAIGNS_OS_QA_TEST_EMAIL to a real monitored inbox (one stable, deliverable
// address, injected at runtime by the private operator skill).
//
// Do NOT "fix" the bounce by hardcoding a real inbox HERE. This is a public package:
// no real domain can be responsibly baked in (it would receive strangers' test
// receipts; RFC 2606 example.* domains are equally undeliverable), and the private-
// string guard bans the internal one by design. The trade-off is intentional —
// public default = stable + unroutable, deliverability is opt-in at runtime. Swapping
// in a real address silently re-breaks both intent (a) and the public/private boundary.
const DEFAULT_QA_TEST_EMAIL = "qa-test@campaigns-os.test";
const SDK_DEBUGGER_PAGE_TYPES = Object.freeze(["checkout", "upsell", "downsell", "thankyou", "receipt"]);
const ORDER_UPSELLS_RESPONSE_PATTERN = /\/api\/v1\/orders\/[^/?#]+\/upsells\/?(?:[?#].*)?$/i;

export async function runBrowserChecks(topologies, args = {}, options = {}) {
  const browser = await launchChromium(args);
  const context = await browser.newContext({
    viewport: viewportFromArgs(args),
    extraHTTPHeaders: args["auth-cookie"] ? { Cookie: String(args["auth-cookie"]) } : undefined,
  });

  try {
    const assertions = [];
    for (const topology of topologies) {
      for (const page of topology.pages) {
        assertions.push(...await runPageBrowserChecks(context, page, args, options));
      }
    }
    return assertions;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export async function runBrowserTestOrders(topologies, args = {}, runId = "local") {
  const checkoutPage = findPage(topologies, "checkout");
  if (!checkoutPage?.url) {
    return {
      orders: [],
      assertions: [assertion({
        id: "browser-test-order:checkout",
        family: "browser-test-order",
        page: checkoutPage || { page_id: "checkout" },
        status: STATUS.FAIL,
        severity: SEVERITY.BLOCKER,
        expected: "checkout page URL",
        actual: "missing",
      })],
    };
  }

  const browser = await launchChromium(args);
  const context = await browser.newContext({
    viewport: viewportFromArgs(args),
    extraHTTPHeaders: args["auth-cookie"] ? { Cookie: String(args["auth-cookie"]) } : undefined,
  });

  const assertions = [];
  const orders = [];
  const paths = testOrderPaths(args["test-order"], topologies);
  enforceTestOrderLimit(paths, args);
  try {
    for (const path of paths) {
      const result = await runSingleBrowserTestOrder(context, checkoutPage, path, args, runId);
      orders.push(result.order);
      assertions.push(testOrderAssertion(checkoutPage, path, result));
    }
  } catch (error) {
    // Convert runner-level surprises into a blocker assertion so the run still
    // writes a verdict instead of exiting with no evidence at all.
    assertions.push(assertion({
      id: "browser-test-order:runner",
      family: "browser-test-order",
      page: checkoutPage,
      status: STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      expected: "typed-card test-order runner completes every planned path",
      actual: error instanceof Error ? error.message : String(error),
      evidence: { planned_paths: paths, completed_paths: orders.map((order) => order.path) },
    }));
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return { orders, assertions };
}

// Analytics-parity leg: capture the live dataLayer event stream + GTM/pixel
// tag-fires on a baseline (legacy) URL and a candidate (migrated) URL, then
// diff them into parity assertions. Highest-value target is the thank-you /
// receipt page, where dl_purchase fires — pass receipt URLs for both, or drive
// the same offer through each funnel so the values line up (see the PARITY QA
// phase of the campaignsjs→SDK-0.4.x migration doctrine).
export async function runAnalyticsParityChecks(args = {}) {
  const baselineUrl = trim(args["analytics-baseline"]) || null;
  const candidateUrl = trim(args["analytics-candidate"]) || trim(args["base-url"]) || null;
  const analyticsPage = { page_id: "analytics", url: candidateUrl || baselineUrl || undefined };

  if (!baselineUrl || !candidateUrl) {
    return [assertion({
      id: "analytics-parity:inputs",
      family: "analytics-parity",
      page: analyticsPage,
      status: STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      expected: "both --analytics-baseline <legacy-url> and a candidate URL (--analytics-candidate or --base-url)",
      actual: `baseline=${baselineUrl || "missing"}, candidate=${candidateUrl || "missing"}`,
    })];
  }

  const extraHosts = analyticsExtraHosts(args);
  const browser = await launchChromium(args);
  const context = await browser.newContext({
    viewport: viewportFromArgs(args),
    extraHTTPHeaders: args["auth-cookie"] ? { Cookie: String(args["auth-cookie"]) } : undefined,
  });
  try {
    const baseline = await captureAnalyticsForUrl(context, baselineUrl, args, extraHosts);
    const candidate = await captureAnalyticsForUrl(context, candidateUrl, args, extraHosts);
    const assertions = diffAnalyticsParity(baseline, candidate);
    assertions.unshift(assertion({
      id: "analytics-parity:capture",
      family: "analytics-parity",
      page: analyticsPage,
      status: STATUS.PASS,
      expected: "live dataLayer + tag-fire capture on baseline and candidate",
      actual: `baseline events=${baseline.eventNames.length}, candidate events=${candidate.eventNames.length}`,
      evidence: {
        baseline_url: baselineUrl,
        candidate_url: candidateUrl,
        baseline_event_count: baseline.eventNames.length,
        candidate_event_count: candidate.eventNames.length,
        baseline_inventory: Object.fromEntries(Object.entries(baseline.inventory).map(([k, v]) => [k, v.length])),
        candidate_inventory: Object.fromEntries(Object.entries(candidate.inventory).map(([k, v]) => [k, v.length])),
      },
    }));
    return assertions;
  } catch (error) {
    return [assertion({
      id: "analytics-parity:runner",
      family: "analytics-parity",
      page: analyticsPage,
      status: STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      expected: "analytics-parity capture completes on both URLs",
      actual: error instanceof Error ? error.message : String(error),
      evidence: { baseline_url: baselineUrl, candidate_url: candidateUrl },
    })];
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// Analytics CORRECTNESS leg: capture ONE funnel page and assess it against the
// declared CampaignSpec `analytics` contract — declared tags/pixels fire,
// Purchase fires (source-aware). This is the foundation the parity differ sits
// on; runs whenever a spec carries an `analytics` block (or --analytics-correctness).
export async function runAnalyticsCorrectnessChecks(args = {}, contract = {}) {
  const url = trim(args["analytics-candidate"]) || trim(args["base-url"]) || null;
  const correctnessPage = { page_id: "analytics", url: url || undefined };
  if (!url) {
    return [assertion({
      id: "analytics-correctness:inputs",
      family: "analytics-correctness",
      page: correctnessPage,
      status: STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      expected: "a candidate URL to capture (--analytics-candidate or --base-url)",
      actual: "missing",
    })];
  }

  // Seed the host filter with declared out-of-band vendor names so vendors whose
  // host contains their name (everflow, northbeam, …) get captured.
  const vendorHosts = ((contract && contract.out_of_band_pixels) || [])
    .map((p) => (p && p.vendor ? String(p.vendor) : null))
    .filter(Boolean);
  const extraHosts = [...analyticsExtraHosts(args), ...vendorHosts];

  const browser = await launchChromium(args);
  const context = await browser.newContext({
    viewport: viewportFromArgs(args),
    extraHTTPHeaders: args["auth-cookie"] ? { Cookie: String(args["auth-cookie"]) } : undefined,
  });
  try {
    const capture = await captureAnalyticsForUrl(context, url, args, extraHosts);
    const assertions = assessAnalyticsCorrectness(capture, contract || {});
    assertions.unshift(assertion({
      id: "analytics-correctness:capture",
      family: "analytics-correctness",
      page: correctnessPage,
      status: STATUS.PASS,
      expected: "live dataLayer + tag-fire capture on the candidate page",
      actual: `events=${capture.eventNames.length}, tags=${Object.values(capture.inventory).flat().length}`,
      // Fingerprints only — never publish raw order fields (value/transaction_id)
      // to the QA portal. Mirrors the parity capture evidence sanitization.
      evidence: {
        url,
        event_count: capture.eventNames.length,
        inventory: Object.fromEntries(Object.entries(capture.inventory).map(([k, v]) => [k, v.length])),
        purchase_signals: capture.purchaseSignals || {},
      },
    }));
    return assertions;
  } catch (error) {
    return [assertion({
      id: "analytics-correctness:runner",
      family: "analytics-correctness",
      page: correctnessPage,
      status: STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      expected: "analytics-correctness capture completes",
      actual: error instanceof Error ? error.message : String(error),
      evidence: { url },
    })];
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function analyticsExtraHosts(args) {
  const raw = args["analytics-hosts"];
  if (!raw) return [];
  return String(raw).split(",").map((h) => h.trim()).filter(Boolean);
}

async function captureAnalyticsForUrl(context, url, args, extraHosts) {
  const page = await context.newPage();
  const capture = await attachAnalyticsCapture(page, { extraHosts });
  const timeoutMs = numberArg(args["browser-timeout"], DEFAULT_BROWSER_TIMEOUT_MS);
  const settleMs = numberArg(args["analytics-settle"], DEFAULT_SETTLE_TIMEOUT_MS);
  try {
    // domcontentloaded (not "load") so a single stuck analytics beacon — exactly
    // the kind of subresource we're capturing — can't starve the goto timeout.
    // Mirrors runPageBrowserChecks; the settle wait below lets async tags fire.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: settleMs }).catch(() => {});
    // Let async GTM/pixel tags and deferred dataLayer pushes fire before reading.
    await page.waitForTimeout(settleMs);
    return await capture.collect();
  } finally {
    capture.detach();
    await page.close().catch(() => {});
  }
}

async function runPageBrowserChecks(context, page, args, options = {}) {
  const assertions = [];
  if (!page.url) {
    assertions.push(assertion({
      id: `browser-load:${page.page_id}`,
      family: "browser-runtime",
      page,
      status: STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      expected: "deployed URL",
      actual: null,
      evidence: { transport_error: { code: "missing_url", message: "No page URL could be resolved." } },
    }));
    return assertions;
  }

  const browserPage = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  browserPage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(trim(message.text()));
  });
  browserPage.on("pageerror", (error) => pageErrors.push(trim(error.message)));
  browserPage.on("requestfailed", (request) => {
    if (isIgnorableFailedRequest(request)) return;
    failedRequests.push({
      url: request.url(),
      failure: request.failure()?.errorText || "request failed",
    });
  });

  try {
    const timeoutMs = numberArg(args["browser-timeout"], DEFAULT_BROWSER_TIMEOUT_MS);
    const response = await browserPage.goto(page.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await browserPage.waitForLoadState("networkidle", { timeout: DEFAULT_SETTLE_TIMEOUT_MS }).catch(() => {});
    const status = response?.status() ?? null;
    const title = await browserPage.title().catch(() => "");
    const bodyPresent = await browserPage.locator("body").count().then((count) => count > 0).catch(() => false);

    assertions.push(assertion({
      id: `browser-load:${page.page_id}`,
      family: "browser-runtime",
      page,
      status: status && status >= 400 ? STATUS.FAIL : STATUS.PASS,
      severity: status && status >= 400 ? SEVERITY.BLOCKER : undefined,
      expected: "browser-rendered page",
      actual: status ? `HTTP ${status}` : "loaded",
      evidence: { title, body_present: bodyPresent },
    }));

    assertions.push(...await primaryCtaVisualAssertions(browserPage, page));

    if (page.page_type === "upsell") {
      assertions.push(...await renderedUpsellControlAssertions(browserPage, page));
    }
    if (page.page_type === "checkout") {
      assertions.push(...await checkoutPaymentSurfaceAssertions(browserPage, page));
    }
    assertions.push(...await templateResidueAssertions(browserPage, page, options));
    assertions.push(...await templatePlaceholderTextAssertions(browserPage, page, options));
    assertions.push(...await templateDemoAssetAssertions(browserPage, page, options));
    assertions.push(...await pricingVisibilityAssertions(browserPage, page, options));
    assertions.push(...await sdkDebuggerAssertions(context, page, args));

    if (pageErrors.length) {
      assertions.push(runtimeIssueAssertion(page, "browser-page-errors", pageErrors));
    }
    const actionableConsoleErrors = await actionableRuntimeConsoleErrors(browserPage, consoleErrors);
    if (actionableConsoleErrors.length) {
      assertions.push(runtimeIssueAssertion(page, "browser-console-errors", actionableConsoleErrors));
    }
    if (failedRequests.length) {
      assertions.push(assertion({
        id: `browser-request-failures:${page.page_id}`,
        family: "browser-runtime",
        page,
        status: STATUS.WARN,
        severity: SEVERITY.WARN,
        expected: "no failed browser requests",
        actual: `${failedRequests.length} failed request(s)`,
        evidence: { failed_requests: failedRequests.slice(0, 10) },
      }));
    }
  } catch (error) {
    assertions.push(assertion({
      id: `browser-load:${page.page_id}`,
      family: "browser-runtime",
      page,
      status: STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      expected: "browser-rendered page",
      actual: null,
      evidence: { transport_error: { code: "browser_error", message: error instanceof Error ? error.message : String(error) } },
    }));
  } finally {
    await browserPage.close().catch(() => {});
  }

  return assertions;
}

function isIgnorableFailedRequest(request) {
  const failure = request.failure()?.errorText || "";
  if (failure !== "net::ERR_ABORTED") return false;
  const resourceType = request.resourceType?.() || "";
  if (resourceType === "media") return true;
  try {
    return /\.(?:mp4|webm|mov|m4v|ogg)(?:[?#].*)?$/i.test(new URL(request.url()).pathname);
  } catch {
    return /\.(?:mp4|webm|mov|m4v|ogg)(?:[?#].*)?$/i.test(request.url());
  }
}

async function actionableRuntimeConsoleErrors(browserPage, messages) {
  if (!messages.length) return [];
  const runtimeReady = await browserPage.evaluate(() => (
    document.documentElement.classList.contains("next-display-ready")
    || Boolean(window.next && Object.keys(window.next).length)
  )).catch(() => false);
  return messages.filter((message) => {
    if (runtimeReady && isKnownSdkLoaderFalsePositive(message)) return false;
    return true;
  });
}

function isKnownSdkLoaderFalsePositive(message) {
  return /Failed to load SDK:\s*ReferenceError:\s*Cannot access 'create' before initialization/i.test(String(message || ""));
}

async function sdkDebuggerAssertions(context, page, args) {
  if (!sdkDebuggerEligible(page)) return [];

  const debugPage = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  debugPage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(trim(message.text()));
  });
  debugPage.on("pageerror", (error) => pageErrors.push(trim(error.message)));

  try {
    const timeoutMs = numberArg(args["browser-timeout"], DEFAULT_BROWSER_TIMEOUT_MS);
    const url = withQueryParam(page.url, "debugger", "true");
    const response = await debugPage.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await debugPage.waitForLoadState("networkidle", { timeout: DEFAULT_SETTLE_TIMEOUT_MS }).catch(() => {});
    await debugPage.waitForTimeout(1000).catch(() => {});
    const evidence = await debugPage.evaluate(() => ({
      url: location.href,
      displayReady: document.documentElement.classList.contains("next-display-ready"),
      overlayHost: Boolean(document.querySelector("#next-debug-overlay-host")),
      selectorContainer: Boolean(document.querySelector("#debug-selectors-container")),
      currencySelector: Boolean(document.querySelector("#debug-currency-selector")),
      countrySelector: Boolean(document.querySelector("#debug-country-selector")),
      localeSelector: Boolean(document.querySelector("#debug-locale-selector")),
      nextKeys: Object.keys(window.next || {}).slice(0, 20),
    })).catch(() => ({
      url,
      displayReady: false,
      overlayHost: false,
      selectorContainer: false,
      currencySelector: false,
      countrySelector: false,
      localeSelector: false,
      nextKeys: [],
    }));
    const status = response?.status() ?? null;
    const ok = (!status || status < 400)
      && evidence.displayReady
      && evidence.overlayHost
      && evidence.selectorContainer
      && evidence.currencySelector
      && evidence.countrySelector
      && evidence.localeSelector;

    return [assertion({
      id: `browser-sdk-debugger:${page.page_id}`,
      family: "browser-runtime",
      page,
      status: ok ? STATUS.PASS : STATUS.WARN,
      severity: ok ? undefined : SEVERITY.WARN,
      expected: "Campaign Cart SDK debugger mode mounts on SDK-owned runtime pages",
      actual: ok ? "debugger overlay and selector controls mounted" : "debugger overlay incomplete",
      evidence: {
        ...evidence,
        http_status: status,
        console_errors: consoleErrors.slice(0, 10),
        page_errors: pageErrors.slice(0, 10),
      },
    })];
  } catch (error) {
    return [assertion({
      id: `browser-sdk-debugger:${page.page_id}`,
      family: "browser-runtime",
      page,
      status: STATUS.WARN,
      severity: SEVERITY.WARN,
      expected: "Campaign Cart SDK debugger mode mounts on SDK-owned runtime pages",
      actual: "debugger navigation failed",
      evidence: { transport_error: { code: "browser_error", message: error instanceof Error ? error.message : String(error) } },
    })];
  } finally {
    await debugPage.close().catch(() => {});
  }
}

function sdkDebuggerEligible(page) {
  const pageType = String(page.page_type || "").toLowerCase();
  const metaPageType = String(page.expected_meta_tags?.["next-page-type"] || "").toLowerCase();
  return SDK_DEBUGGER_PAGE_TYPES.includes(pageType) || SDK_DEBUGGER_PAGE_TYPES.includes(metaPageType);
}

async function primaryCtaVisualAssertions(browserPage, page) {
  if (!primaryCtaCheckEligible(page)) return [];
  const evidence = await inspectPrimaryCta(browserPage, page.expected_next_url);
  return [primaryCtaAssertionFromEvidence(page, evidence)];
}

function primaryCtaCheckEligible(page) {
  if (!page?.expected_next_url) return false;
  const pageType = String(page.page_type || "").toLowerCase();
  return !["checkout", "upsell", "downsell", "thankyou", "receipt"].includes(pageType);
}

async function inspectPrimaryCta(browserPage, expectedUrl) {
  return browserPage.evaluate((routeUrl) => {
    const CTA_SELECTOR = [
      "a[href]",
      "button",
      "[role='button']",
      "[data-next-action]",
      "[data-next-checkout-action]",
      "[data-next-add-to-cart]",
    ].join(", ");

    const trim = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const compactPath = (value) => String(value || "").replace(/\/+$/, "") || "/";
    const expected = (() => {
      try {
        return new URL(routeUrl, location.href);
      } catch {
        return null;
      }
    })();
    const parseColor = (value) => {
      const raw = String(value || "").trim().toLowerCase();
      if (!raw || raw === "transparent") return null;
      const rgb = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(\d?(?:\.\d+)?|1(?:\.0+)?))?\s*\)$/);
      if (!rgb) return null;
      const parts = rgb.slice(1, 4).map((part) => Number(part));
      if (parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return null;
      const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
      return { r: parts[0], g: parts[1], b: parts[2], a: Number.isFinite(alpha) ? alpha : 1 };
    };
    const hex = (color) => color ? `#${[color.r, color.g, color.b].map((part) => Math.round(part).toString(16).padStart(2, "0")).join("")}` : null;
    const luminance = (color) => {
      const channel = (value) => {
        const normalized = value / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    };
    const contrast = (a, b) => {
      if (!a || !b) return null;
      const light = Math.max(luminance(a), luminance(b));
      const dark = Math.min(luminance(a), luminance(b));
      return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
    };
    const effectiveBackground = (element) => {
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const style = getComputedStyle(current);
        const color = parseColor(style.backgroundColor);
        if (color && color.a > 0.05) {
          return { color, source: current === element ? "element" : current.tagName.toLowerCase() };
        }
        current = current.parentElement;
      }
      return { color: { r: 255, g: 255, b: 255, a: 1 }, source: "assumed_canvas" };
    };
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") > 0.01;
    };
    const selectorFor = (element) => {
      const tag = element.tagName.toLowerCase();
      const id = element.id ? `#${element.id}` : "";
      const classes = String(element.className || "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4)
        .map((name) => `.${name}`)
        .join("");
      return `${tag}${id}${classes}`;
    };
    const hrefFor = (element) => {
      if (element instanceof HTMLAnchorElement && element.href) return element.href;
      const attr = element.getAttribute("href")
        || element.getAttribute("data-href")
        || element.getAttribute("data-next-href")
        || element.closest("form")?.getAttribute("action");
      if (!attr) return null;
      try {
        return new URL(attr, location.href).href;
      } catch {
        return attr;
      }
    };
    const routeMatches = (href) => {
      if (!href || !expected) return false;
      try {
        const actual = new URL(href, location.href);
        return compactPath(actual.pathname) === compactPath(expected.pathname);
      } catch {
        return false;
      }
    };

    const candidates = Array.from(document.querySelectorAll(CTA_SELECTOR))
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const fg = parseColor(style.color);
        const bg = effectiveBackground(element);
        const ratio = contrast(fg, bg.color);
        const href = hrefFor(element);
        const label = trim(element.innerText || element.textContent || element.getAttribute("aria-label"));
        return {
          selector: selectorFor(element),
          text: label.slice(0, 120),
          href,
          route_matches: routeMatches(href),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          foreground: hex(fg),
          background: hex(bg.color),
          background_source: bg.source,
          contrast_ratio: ratio,
          readable: typeof ratio === "number" && ratio >= 4.5,
          size_ok: rect.width >= 40 && rect.height >= 20,
        };
      })
      .filter((candidate) => candidate.text || candidate.href);

    const routeCandidates = candidates
      .filter((candidate) => candidate.route_matches)
      .sort((a, b) => {
        if (a.readable !== b.readable) return a.readable ? -1 : 1;
        if (a.size_ok !== b.size_ok) return a.size_ok ? -1 : 1;
        return (b.contrast_ratio || 0) - (a.contrast_ratio || 0);
      });
    const primary = routeCandidates[0] || null;
    const ok = Boolean(primary?.readable && primary?.size_ok);
    const reason = ok
      ? "ok"
      : !routeCandidates.length
        ? "missing_route_cta"
        : primary?.size_ok === false
          ? "cta_too_small"
          : "low_contrast";

    return {
      ok,
      reason,
      expected_url: routeUrl,
      primary,
      candidates: candidates.slice(0, 8),
    };
  }, expectedUrl).catch((error) => ({
    ok: false,
    reason: "inspection_error",
    expected_url: expectedUrl,
    error: error instanceof Error ? error.message : String(error),
    candidates: [],
  }));
}

function primaryCtaAssertionFromEvidence(page, evidence) {
  const ok = evidence?.ok === true;
  const reason = evidence?.reason || "unknown";
  return assertion({
    id: `browser-primary-cta:${page.page_id}`,
    family: "browser-runtime",
    page,
    status: ok ? STATUS.PASS : STATUS.FAIL,
    severity: ok ? undefined : SEVERITY.WARN,
    expected: "visible readable primary CTA linked to the expected next route",
    actual: ok
      ? `CTA visible (${evidence.primary?.width || 0}x${evidence.primary?.height || 0}, contrast ${evidence.primary?.contrast_ratio || "n/a"})`
      : reason,
    evidence,
  });
}

async function renderedUpsellControlAssertions(browserPage, page) {
  const checks = [
    ["accept", "add", page.expected_accept_url],
    ["decline", "skip", page.expected_decline_url],
  ];
  const assertions = [];
  for (const [kind, action, expectedUrl] of checks) {
    if (!expectedUrl) continue;
    const count = await browserPage.locator(`[data-next-upsell-action="${action}"]`).count().catch(() => 0);
    assertions.push(assertion({
      id: `browser-upsell-control:${page.page_id}:${kind}`,
      family: "browser-runtime",
      page,
      status: count > 0 ? STATUS.PASS : STATUS.MANUAL_REVIEW,
      severity: count > 0 ? undefined : SEVERITY.WARN,
      expected: `rendered SDK ${kind} control`,
      actual: count > 0 ? `${count} matching control(s)` : "not found",
      evidence: { selector: `[data-next-upsell-action="${action}"]`, expected_url: expectedUrl },
    }));
  }
  return assertions;
}

async function checkoutPaymentSurfaceAssertions(browserPage, page) {
  await settleCheckoutCommerce(browserPage);
  const cardNumberMounts = await browserPage.locator('[data-next-checkout-field="cc-number"], #spreedly-number').count().catch(() => 0);
  const cvvMounts = await browserPage.locator('[data-next-checkout-field="cvv"], #spreedly-cvv').count().catch(() => 0);
  const spreedlyFrames = browserPage.frames().filter((frame) => /spreedly/i.test(frame.url()));
  const geometry = await paymentSurfaceGeometry(browserPage);
  const geometryOk = paymentGeometryAcceptable(geometry);
  const express = await expressCheckoutGeometry(browserPage);
  const expressOk = express.buttons.length > 0 && express.buttons.every((button) => button.height >= 44 && button.height <= 64);
  const bundle = await checkoutBundleSelectorEvidence(browserPage);
  const bundleOk = bundle.cards.every((card) => card.hasVisiblePrice) && bundle.selectedCount > 0;
  const bump = await checkoutOrderBumpEvidence(browserPage);
  const bumpOk = bump.toggles.every((toggle) => toggle.statesAgree);
  const assertions = [assertion({
    id: `browser-payment-surface:${page.page_id}`,
    family: "browser-runtime",
    page,
    status: cardNumberMounts > 0 && cvvMounts > 0 ? STATUS.PASS : STATUS.MANUAL_REVIEW,
    severity: cardNumberMounts > 0 && cvvMounts > 0 ? undefined : SEVERITY.WARN,
    expected: "rendered credit-card payment field mounts",
    actual: `card_mounts=${cardNumberMounts}; cvv_mounts=${cvvMounts}; spreedly_frames=${spreedlyFrames.length}`,
    evidence: {
      card_number_selector: '[data-next-checkout-field="cc-number"], #spreedly-number',
      cvv_selector: '[data-next-checkout-field="cvv"], #spreedly-cvv',
      spreedly_frame_urls: spreedlyFrames.map((frame) => frame.url()).slice(0, 5),
      next_step: "Run --test-order common for typed-card checkout proof (test cards bypass the gateway; no approval needed).",
    },
  }), assertion({
    id: `browser-payment-geometry:${page.page_id}`,
    family: "browser-runtime",
    page,
    status: geometryOk ? STATUS.PASS : STATUS.FAIL,
    severity: geometryOk ? undefined : SEVERITY.WARN,
    expected: "native-looking card/CVV controls: fixed field height and centered hosted iframe text path",
    actual: geometry.fields.map((field) => `${field.id}: host=${field.host.height}px iframe=${field.iframe.height}px center_delta=${field.centerDelta}px`).join("; ") || "no fields measured",
    evidence: {
      fields: geometry.fields,
      rules: {
        host_height_px: "42..64",
        iframe_height_ratio_max: 0.72,
        iframe_center_delta_px_max: 8,
      },
    },
  }), assertion({
    id: `browser-express-wallets:${page.page_id}`,
    family: "browser-runtime",
    page,
    status: expressOk ? STATUS.PASS : STATUS.MANUAL_REVIEW,
    severity: expressOk ? undefined : SEVERITY.WARN,
    expected: "eligible express wallet buttons render with stable wallet-button dimensions; Apple Pay may be absent in non-eligible browsers",
    actual: express.buttons.length ? express.buttons.map((button) => `${button.kind || "unknown"}:${button.width}x${button.height}`).join("; ") : "no express wallet buttons mounted",
    evidence: {
      buttons: express.buttons,
      note: "Wallet presence is browser/device eligibility dependent; do not require Apple Pay in Chrome-only QA.",
    },
  })];
  if (bundle.cards.length) {
    assertions.push(assertion({
      id: `browser-bundle-selector:${page.page_id}`,
      family: "browser-runtime",
      page,
      status: bundleOk ? STATUS.PASS : STATUS.FAIL,
      severity: bundleOk ? undefined : SEVERITY.WARN,
      expected: "bundle cards have one selected option and visible prices for every tier",
      actual: `${bundle.selectedCount} selected; ${bundle.cards.filter((card) => card.hasVisiblePrice).length}/${bundle.cards.length} cards with visible price`,
      evidence: bundle,
    }));
  }
  if (bump.toggles.length) {
    assertions.push(assertion({
      id: `browser-order-bump-state:${page.page_id}`,
      family: "browser-runtime",
      page,
      status: bumpOk ? STATUS.PASS : STATUS.FAIL,
      severity: bumpOk ? undefined : SEVERITY.WARN,
      expected: "order bump visible checkbox state agrees with active/in-cart and hidden input state",
      actual: `${bump.toggles.filter((toggle) => toggle.statesAgree).length}/${bump.toggles.length} bump toggle(s) aligned`,
      evidence: bump,
    }));
  }
  assertions.push(...await checkoutCommerceStructureAssertions(browserPage, page));
  return assertions;
}

async function checkoutCommerceStructureAssertions(browserPage, page) {
  const family = page.template_family || null;
  const contract = page.commerce_structure_contract || null;
  const contractStatus = page.commerce_structure_contract_status || null;
  if (!family && !contractStatus) return [];
  if (!contract) {
    return [assertion({
      id: `browser-commerce-structure:${page.page_id}`,
      family: "browser-runtime",
      page,
      status: STATUS.MANUAL_REVIEW,
      severity: SEVERITY.WARN,
      expected: "template-family rendered commerce structure contract",
      actual: contractStatus || "not available",
      evidence: {
        template_family: family,
        contract_status: contractStatus,
        next_step: "Add agentContract.qaStructure for this template family before treating structure as machine-verified.",
      },
    })];
  }

  const evidence = await inspectCommerceStructure(browserPage, contract);
  return [commerceStructureAssertionFromEvidence(page, {
    template_family: family,
    contract_status: contractStatus,
    ...evidence,
  })];
}

async function inspectCommerceStructure(browserPage, contract) {
  const safeContract = isPlainObject(contract) ? contract : {};
  const checks = await browserPage.evaluate((input) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") !== 0;
    };
    const textFor = (elements) => elements
      .filter(visible)
      .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    const evaluate = (rule, mode) => {
      const selectors = Array.isArray(rule.selectors) && rule.selectors.length
        ? rule.selectors
        : [rule.selector].filter(Boolean);
      const elements = selectors.flatMap((selector) => {
        try {
          return Array.from(document.querySelectorAll(selector));
        } catch {
          return [];
        }
      });
      const visibleElements = elements.filter(visible);
      const text = textFor(elements);
      const ok = mode === "exists"
        ? elements.length > 0
        : mode === "visible"
          ? visibleElements.length > 0
          : visibleElements.length > 0 && text.length > 0;
      return {
        name: rule.name || selectors.join(", "),
        selectors,
        mode,
        status: ok ? "pass" : "fail",
        count: elements.length,
        visible_count: visibleElements.length,
        text_length: text.length,
        sample_text: text.slice(0, 120),
      };
    };
    const checks = [];
    for (const rule of input.requiredSelectors || []) checks.push(evaluate(rule, "exists"));
    for (const rule of input.requiredVisibleSelectors || []) checks.push(evaluate(rule, "visible"));
    for (const rule of input.requiredNonEmptySelectors || []) checks.push(evaluate(rule, "non_empty"));
    return checks;
  }, safeContract).catch((error) => [{
    name: "commerce structure inspection",
    selectors: [],
    mode: "inspect",
    status: "fail",
    count: 0,
    visible_count: 0,
    text_length: 0,
    sample_text: "",
    error: error instanceof Error ? error.message : String(error),
  }]);

  return {
    description: typeof safeContract.description === "string" ? safeContract.description : null,
    checks,
  };
}

function commerceStructureAssertionFromEvidence(page, evidence) {
  const checks = Array.isArray(evidence?.checks) ? evidence.checks : [];
  if (!checks.length) {
    return assertion({
      id: `browser-commerce-structure:${page.page_id}`,
      family: "browser-runtime",
      page,
      status: STATUS.MANUAL_REVIEW,
      severity: SEVERITY.WARN,
      expected: "template-family rendered commerce structure contract",
      actual: "contract has no machine-checkable selectors",
      evidence,
    });
  }
  const failed = checks.filter((check) => check.status === "fail");
  return assertion({
    id: `browser-commerce-structure:${page.page_id}`,
    family: "browser-runtime",
    page,
    status: failed.length ? STATUS.FAIL : STATUS.PASS,
    severity: failed.length ? SEVERITY.WARN : undefined,
    expected: "rendered checkout conforms to the selected template-family commerce structure contract",
    actual: failed.length
      ? `${checks.length - failed.length}/${checks.length} structure check(s) passed; missing ${failed.map((check) => check.name).join(", ")}`
      : `${checks.length}/${checks.length} structure check(s) passed`,
    evidence,
  });
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

async function settleCheckoutCommerce(browserPage) {
  await browserPage.waitForSelector([
    '[data-next-express-checkout="buttons"] .payment-btn',
    '[data-next-checkout-field="cc-number"]',
    '#spreedly-number',
    '[data-next-bundle-card]',
    '[data-next-toggle-card]',
  ].join(", "), { timeout: 8000 }).catch(() => {});
  await browserPage.waitForTimeout(1000).catch(() => {});
}

async function paymentSurfaceGeometry(browserPage) {
  return browserPage.evaluate(() => {
    const selectors = ['[data-next-checkout-field="cc-number"], #spreedly-number', '[data-next-checkout-field="cvv"], #spreedly-cvv'];
    return {
      fields: selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((field) => {
        const hostRect = field.getBoundingClientRect();
        const iframe = field.querySelector("iframe");
        const iframeRect = iframe?.getBoundingClientRect();
        const hostCenter = hostRect.y + hostRect.height / 2;
        const iframeCenter = iframeRect ? iframeRect.y + iframeRect.height / 2 : 0;
        return {
          id: field.id || field.getAttribute("data-next-checkout-field") || selector,
          host: {
            width: Math.round(hostRect.width),
            height: Math.round(hostRect.height),
          },
          iframe: {
            width: Math.round(iframeRect?.width || 0),
            height: Math.round(iframeRect?.height || 0),
          },
          centerDelta: iframeRect ? Math.round(Math.abs(hostCenter - iframeCenter)) : null,
        };
      })),
    };
  }).catch(() => ({ fields: [] }));
}

function paymentGeometryAcceptable(geometry) {
  if (!geometry.fields.length) return false;
  return geometry.fields.every((field) => {
    const hostHeight = Number(field.host?.height || 0);
    const iframeHeight = Number(field.iframe?.height || 0);
    const centerDelta = Number(field.centerDelta ?? 999);
    if (hostHeight < 42 || hostHeight > 64) return false;
    if (iframeHeight <= 0 || iframeHeight > hostHeight * 0.72) return false;
    return centerDelta <= 8;
  });
}

async function expressCheckoutGeometry(browserPage) {
  return browserPage.evaluate(() => ({
    buttons: Array.from(document.querySelectorAll('[data-next-express-checkout="buttons"] .payment-btn')).map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        kind: button.getAttribute("data-next-express-checkout") || null,
        className: button.className || "",
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }),
  })).catch(() => ({ buttons: [] }));
}

async function checkoutBundleSelectorEvidence(browserPage) {
  return browserPage.evaluate(() => {
    const hasVisibleMoney = (value) => {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      if (!text || /^[-–—]+$/.test(text)) return false;
      if (/^[\d.,\s]+%$/.test(text)) return false;
      const currency = "(?:[$€£¥₹₩₽₺₴₦₫₱₪₡₲₵]|USD|CAD|AUD|NZD|EUR|GBP|JPY|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|BGN|BRL|MXN|ARS|CLP|COP|PEN|ZAR|INR|KRW|CNY|RMB|HKD|SGD|THB|TRY|AED|SAR)";
      const number = "(?:\\d{1,3}(?:[,.\\s]\\d{3})*(?:[,.]\\d{1,2})?|\\d+(?:[,.]\\d+)?)";
      return new RegExp(`(?:${currency}\\s*${number}|${number}\\s*${currency}|${number})`, "i").test(text);
    };
    const cards = Array.from(document.querySelectorAll("[data-next-bundle-card]")).filter((card) => {
      const rect = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    }).map((card, index) => {
      const rect = card.getBoundingClientRect();
      const priceNodes = Array.from(card.querySelectorAll('[data-next-bundle-display*="price" i], [data-next-display*="price" i], .price'));
      const prices = priceNodes.map((node) => node.textContent.trim()).filter(Boolean);
      const selected = card.classList.contains("next-selected")
        || card.getAttribute("aria-checked") === "true"
        || card.querySelector('input[type="radio"], input[type="checkbox"]')?.checked === true;
      return {
        index,
        id: card.getAttribute("data-next-bundle-id") || card.getAttribute("data-next-package-id") || null,
        selected,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        prices,
        hasVisiblePrice: prices.some(hasVisibleMoney),
      };
    });
    return {
      selectedCount: cards.filter((card) => card.selected).length,
      cards,
    };
  }).catch(() => ({ selectedCount: 0, cards: [] }));
}

async function checkoutOrderBumpEvidence(browserPage) {
  return browserPage.evaluate(() => ({
    toggles: Array.from(document.querySelectorAll("[data-next-toggle-card], [data-next-bump]")).filter((toggle) => {
      const rect = toggle.getBoundingClientRect();
      const style = getComputedStyle(toggle);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    }).map((toggle, index) => {
      const input = toggle.querySelector('input[type="checkbox"]');
      const marker = toggle.querySelector(".bump-check, [data-next-toggle-check], .checkbox__icon, [os-component='check'], [aria-hidden]");
      const markerAfter = marker ? getComputedStyle(marker, "::after") : null;
      const markerStyle = marker ? getComputedStyle(marker) : null;
      const markerContainer = marker?.closest(".checkbox__icon, .bump-check, [data-next-toggle-check], [os-component='check']") || marker;
      const markerContainerStyle = markerContainer ? getComputedStyle(markerContainer) : null;
      const markerVisible = Boolean(marker) && [markerStyle, markerContainerStyle].every((style) => (
        style
        && style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || 1) > 0.5
      ));
      const markerAfterVisible = markerVisible
        && markerAfter
        && !["none", "normal", '""'].includes(markerAfter.content)
        && Number(markerAfter.opacity || 0) > 0.5;
      const markerChecked = Boolean(marker) && (
        markerAfterVisible
        || (markerVisible && /check|✓/.test(marker?.textContent || ""))
        || (markerVisible && markerStyle?.backgroundColor === "rgb(45, 148, 127)")
      );
      const active = toggle.classList.contains("next-active")
        || toggle.classList.contains("next-in-cart")
        || toggle.classList.contains("next-selected")
        || toggle.getAttribute("aria-pressed") === "true";
      const inputChecked = input ? input.checked : null;
      const inputAgrees = inputChecked === null || inputChecked === active;
      const markerAgrees = !marker || markerChecked === active;
      return {
        index,
        packageId: toggle.getAttribute("data-next-package-id") || null,
        active,
        inputChecked,
        markerChecked,
        inputAgrees,
        markerAgrees,
        statesAgree: inputAgrees && markerAgrees,
      };
    }),
  })).catch(() => ({ toggles: [] }));
}

// --- Template brand residue + pricing visibility (template-brand-contract driven) ---
// Browser collectors gather raw computed-style/visibility evidence; pure
// functions below turn that evidence into assertions so the decisions are
// testable without Playwright.

const RESIDUE_PAGE_TYPES = ["checkout", "upsell", "downsell", "receipt"];

function contractPageType(page) {
  const type = String(page?.page_type || "").toLowerCase();
  return type === "thankyou" ? "receipt" : type;
}

async function templateResidueAssertions(browserPage, page, options = {}) {
  const contract = options.brandContract;
  const pageType = contractPageType(page);
  if (!contract || !RESIDUE_PAGE_TYPES.includes(pageType)) return [];
  const severity = options.residueSeverity || SEVERITY.BLOCKER;
  const assertions = [];

  const forbidden = forbiddenComputedColors(contract);
  const styleChecks = (contract.qa_inspection?.computed_style_checks || [])
    .filter((check) => (check.page_types || []).includes(pageType));
  if (forbidden.length && styleChecks.length) {
    const evidence = await collectComputedStyleEvidence(browserPage, styleChecks);
    assertions.push(...computedStyleResidueAssertions({ page, evidence, forbidden, severity }));
  }

  const logo = contract.default_residue?.logo;
  if (logo?.selector && (logo.page_types || []).includes(pageType)) {
    const sources = await collectLogoSources(browserPage, logo.selector);
    assertions.push(logoResidueAssertion({ page, logo, sources, severity }));
  }

  const chrome = contract.default_residue?.payment_chrome;
  const supported = options.supportedPaymentMethods;
  if (chrome && Array.isArray(supported) && supported.length) {
    const unsupported = (chrome.methods || []).filter((method) => !supported.includes(method));
    if (unsupported.length) {
      const html = await browserPage.content().catch(() => "");
      // One evaluate for ALL unsupported methods' selectors; partition the
      // visibility results per method in JS to keep browser round-trips flat.
      const artifactsByMethod = new Map(unsupported.map((method) => [method, methodPaymentArtifacts(chrome, method)]));
      const allSelectors = [...new Set([...artifactsByMethod.values()].flatMap((artifacts) => artifacts.selectors))];
      const allVisibleMatches = await collectVisibleSelectorMatches(browserPage, allSelectors);
      for (const method of unsupported) {
        const artifacts = artifactsByMethod.get(method);
        const visibleMatches = allVisibleMatches.filter((match) => artifacts.selectors.includes(match.selector));
        assertions.push(paymentChromeResidueAssertion({
          page,
          method,
          artifacts,
          visibleMatches,
          referencedAssets: referencedAssetBasenames(html, artifacts.assets),
          severity,
        }));
      }
    }
  }

  return assertions;
}

// H3.1 — Text-residue gate. Literal placeholder copy (Lorem / Placeholder /
// TODO / Product Name ...) is never shippable, so this is a fixed BLOCKER that
// does NOT soften under a theme-gate waiver the way the color-residue gate
// does. Runs on every page type the contract lists (commerce + presell +
// landing), since placeholder text is wrong everywhere — not just on commerce
// surfaces. Scans VISIBLE rendered text (body.innerText), so class names,
// comments, and data attributes can't false-trip the blocker.
async function templatePlaceholderTextAssertions(browserPage, page, options = {}) {
  const config = placeholderTextResidueConfig(options.brandContract);
  if (!config) return [];
  const pageType = contractPageType(page);
  if (config.pageTypes && !config.pageTypes.includes(pageType)) return [];
  const text = await collectVisibleText(browserPage);
  const matches = placeholderTextResidueMatches(text, config.terms);
  return [placeholderTextResidueAssertion({ page, terms: config.terms, matches, severity: SEVERITY.BLOCKER })];
}

async function collectVisibleText(browserPage) {
  return browserPage
    .evaluate(() => (document.body ? document.body.innerText || "" : ""))
    .catch(() => "");
}

function placeholderTextResidueAssertion({ page, terms, matches, severity }) {
  const found = summarizePlaceholderTerms(matches);
  const status = found.length ? STATUS.FAIL : STATUS.PASS;
  return assertion({
    id: `template-residue:${page.page_id}:placeholder-text`,
    family: "template_residue",
    page,
    status,
    severity: status === STATUS.FAIL ? severity : undefined,
    expected: "no literal template placeholder text in rendered output",
    actual: found.length ? `placeholder text rendered: ${found.join(", ")}` : "no placeholder text rendered",
    evidence: {
      terms,
      found,
      occurrences: matches.slice(0, 10).map((match) => ({ term: match.term, match: match.match })),
      page_url: page.url,
    },
  });
}

// H3.2 — Demo-asset fidelity flag. WARNING (not a blocker): a built campaign
// that still references the template's own demo placeholders (1x1 spacer SVGs,
// a benefit icon repeated across every benefit) should be re-skinned, but a
// shipped placeholder is a quality flag, not a hard stop. Two signals: named
// demo assets referenced via DOM asset attributes (src/currentSrc/srcset/
// data-src/poster/href/background-image), and one icon src repeated across the
// family's icon selector (learnings L5 "four identical benefit icons").
//
// Matches against actual asset references, NOT the raw HTML string: a basename
// like "1x1_1.svg" quoted in alt text, a comment, or a JSON blob must not
// false-trip the flag — only a real asset reference counts.
async function templateDemoAssetAssertions(browserPage, page, options = {}) {
  const config = demoAssetConfig(options.brandContract);
  if (!config) return [];
  const pageType = contractPageType(page);
  if (config.pageTypes && !config.pageTypes.includes(pageType)) return [];
  const assetRefs = await collectAssetReferenceSources(browserPage);
  const namedHits = referencedDemoAssetBasenames(assetRefs.join("\n"), config.assetBasenames);
  let repeatedIcons = [];
  if (config.repeatedIcon?.selector) {
    const srcs = await collectIconSources(browserPage, config.repeatedIcon.selector);
    repeatedIcons = repeatedIconSrcs(srcs, config.repeatedIcon.minRepeats);
  }
  return [demoAssetResidueAssertion({ page, namedHits, repeatedIcons })];
}

// All real asset references on the page: src/currentSrc/srcset/data-src/poster
// on media elements, href on <link>, and inline background-image url(). Used so
// the demo-asset flag keys off actual references, not substring noise in copy.
async function collectAssetReferenceSources(browserPage) {
  return browserPage.evaluate(() => {
    const urls = [];
    const push = (value) => { if (value && typeof value === "string") urls.push(value); };
    const selector = "img, source, video, audio, iframe, embed, object, link, [style], [data-src], [poster]";
    for (const el of document.querySelectorAll(selector)) {
      push(el.getAttribute("src"));
      push(el.currentSrc);
      push(el.getAttribute("data-src"));
      push(el.getAttribute("poster"));
      push(el.getAttribute("srcset"));
      push(el.getAttribute("data"));
      if (el.tagName === "LINK") push(el.getAttribute("href"));
      const bg = el.style && el.style.backgroundImage;
      if (bg && bg !== "none") push(bg);
    }
    return urls;
  }).catch(() => []);
}

// Icon src strings for the repeated-icon check. Prefer the resolved currentSrc
// (handles <picture>/srcset/lazy-loaded imgs) over the literal src attribute,
// and drop inline data: placeholders so a shared lazy-load placeholder is not
// mistaken for "the same icon repeated".
async function collectIconSources(browserPage, selector) {
  return browserPage.evaluate((target) => {
    try {
      return Array.from(document.querySelectorAll(target))
        .map((el) => el.currentSrc || el.getAttribute("src") || el.getAttribute("data-src") || "")
        .filter((src) => src && !src.startsWith("data:"));
    } catch {
      return [];
    }
  }, selector).catch(() => []);
}

function demoAssetResidueAssertion({ page, namedHits, repeatedIcons }) {
  const named = namedHits || [];
  const repeated = repeatedIcons || [];
  const offending = named.length > 0 || repeated.length > 0;
  const parts = [];
  if (named.length) parts.push(`template demo assets still referenced: ${named.join(", ")}`);
  if (repeated.length) parts.push(`identical icon src repeated ${repeated[0].count}x (re-skin to distinct icons): ${repeated[0].src}`);
  return assertion({
    id: `template-residue:${page.page_id}:demo-asset`,
    family: "template_residue",
    page,
    status: offending ? STATUS.WARN : STATUS.PASS,
    severity: offending ? SEVERITY.WARN : undefined,
    expected: "campaign assets replace template demo placeholders (re-skin before launch)",
    actual: offending ? parts.join("; ") : "no template demo asset residue",
    evidence: { named_hits: named, repeated_icons: repeated, page_url: page.url },
  });
}

async function collectComputedStyleEvidence(browserPage, checks) {
  const input = checks.map((check) => ({
    id: check.id,
    selector: check.selector,
    properties: check.properties || [],
    optional: check.optional === true,
  }));
  return browserPage.evaluate((entries) => entries.map((entry) => {
    let element = null;
    try {
      element = document.querySelector(entry.selector);
    } catch {
      element = null;
    }
    if (!element) return { ...entry, found: false, properties: {} };
    const style = getComputedStyle(element);
    const properties = {};
    for (const property of entry.properties) properties[property] = style.getPropertyValue(property);
    return { ...entry, found: true, properties };
  }), input).catch(() => input.map((entry) => ({ ...entry, found: false, properties: {}, inspection_error: true })));
}

function computedStyleResidueAssertions({ page, evidence, forbidden, severity }) {
  return evidence.map((entry) => {
    if (!entry.found) {
      return assertion({
        id: `template-residue:${page.page_id}:style:${entry.id}`,
        family: "template_residue",
        page,
        status: entry.optional ? STATUS.SKIPPED : STATUS.WARN,
        severity: entry.optional ? undefined : SEVERITY.WARN,
        expected: `selector present for computed-style residue inspection: ${entry.selector}`,
        actual: "selector not found",
        evidence: {
          selector: entry.selector,
          page_url: page.url,
          note: entry.optional ? "optional contract selector" : "Selector drift is a contract bug, not a campaign blocker.",
        },
      });
    }
    const hits = [];
    for (const [property, raw] of Object.entries(entry.properties || {})) {
      const normalized = normalizeCssColor(raw);
      const match = normalized ? forbidden.find((color) => color.rgb === normalized) : null;
      if (match) hits.push({ property, actual: String(raw).trim(), token: match.token, rgb: match.rgb });
    }
    if (!hits.length) {
      return assertion({
        id: `template-residue:${page.page_id}:style:${entry.id}`,
        family: "template_residue",
        page,
        status: STATUS.PASS,
        expected: "no starter-default palette on inspected commerce surface",
        actual: "campaign palette applied",
        evidence: { selector: entry.selector, properties: entry.properties, page_url: page.url },
      });
    }
    const first = hits[0];
    return assertion({
      id: `template-residue:${page.page_id}:style:${entry.id}`,
      family: "template_residue",
      page,
      status: STATUS.FAIL,
      severity,
      expected: `not ${first.rgb} (starter default ${first.token})`,
      actual: first.actual,
      evidence: {
        selector: entry.selector,
        property: first.property,
        expected: `not ${first.rgb} (starter default ${first.token})`,
        actual: first.actual,
        page_url: page.url,
        matches: hits,
      },
    });
  });
}

async function collectLogoSources(browserPage, selector) {
  return browserPage.evaluate((target) => {
    try {
      const sources = [];
      for (const element of document.querySelectorAll(target)) {
        // Same discipline as collectIconSources: prefer the resolved
        // currentSrc, but also inspect src/data-src so a lazy-loaded starter
        // logo (<img loading="lazy" data-src="next-logo.png">) is still caught,
        // and drop inline data: placeholders so a lazy placeholder is not
        // treated as a real logo reference.
        for (const candidate of [element.currentSrc, element.getAttribute("src"), element.getAttribute("data-src")]) {
          if (candidate && !candidate.startsWith("data:")) sources.push(candidate);
        }
      }
      return sources;
    } catch {
      return [];
    }
  }, selector).catch(() => []);
}

function logoResidueAssertion({ page, logo, sources, severity }) {
  const basename = String(logo.asset || "").split("/").pop();
  const offenders = basename ? sources.filter((src) => String(src).includes(basename)) : [];
  const status = offenders.length ? STATUS.FAIL : sources.length ? STATUS.PASS : STATUS.SKIPPED;
  return assertion({
    id: `template-residue:${page.page_id}:logo`,
    family: "template_residue",
    page,
    status,
    severity: status === STATUS.FAIL ? severity : undefined,
    expected: `campaign brand logo, not starter ${basename}`,
    actual: offenders.length
      ? `starter logo asset still referenced (${offenders.length} element(s))`
      : sources.length
        ? "no starter logo asset referenced"
        : "no logo element matched the contract selector",
    evidence: { selector: logo.selector, asset: logo.asset, sources: sources.slice(0, 5), page_url: page.url },
  });
}

// Selectors/assets belonging to one payment method, plus shared chrome assets
// (those naming no contract method, e.g. upsell-payment-logos.svg) which count
// as implied residue for any unsupported method per the contract rule.
function methodPaymentArtifacts(chrome, method) {
  const compact = (value) => String(value || "").toLowerCase().replace(/[\s_-]+/g, "");
  const token = compact(method);
  const methodTokens = (chrome.methods || []).map(compact).filter(Boolean);
  const selectors = (chrome.selectors || []).filter((selector) => compact(selector).includes(token));
  const assets = (chrome.assets || []).filter((asset) => {
    const normalized = compact(asset);
    if (normalized.includes(token)) return true;
    return !methodTokens.some((candidate) => normalized.includes(candidate));
  });
  return { selectors, assets };
}

async function collectVisibleSelectorMatches(browserPage, selectors) {
  if (!selectors.length) return [];
  return browserPage.evaluate((targets) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const matches = [];
    for (const selector of targets) {
      try {
        const count = Array.from(document.querySelectorAll(selector)).filter(visible).length;
        if (count > 0) matches.push({ selector, visible_count: count });
      } catch {
        // invalid selector: contract bug surfaced elsewhere
      }
    }
    return matches;
  }, selectors).catch(() => []);
}

function referencedAssetBasenames(html, assets) {
  const text = typeof html === "string" ? html : "";
  const basenames = [...new Set(assets.map((asset) => String(asset || "").split("/").pop()).filter(Boolean))];
  return basenames.filter((basename) => text.includes(basename));
}

function paymentChromeResidueAssertion({ page, method, artifacts, visibleMatches, referencedAssets, severity }) {
  const offending = visibleMatches.length > 0 || referencedAssets.length > 0;
  return assertion({
    id: `template-residue:${page.page_id}:payment-chrome:${method}`,
    family: "template_residue",
    page,
    status: offending ? STATUS.FAIL : STATUS.PASS,
    severity: offending ? severity : undefined,
    expected: `no ${method} chrome: method is not in CampaignSpec available_payment_methods/available_express_payment_methods`,
    actual: offending
      ? `residue found: ${[...visibleMatches.map((match) => match.selector), ...referencedAssets].join(", ")}`
      : `no ${method} chrome rendered or referenced`,
    evidence: {
      method,
      selectors: artifacts.selectors,
      assets: artifacts.assets,
      visible_matches: visibleMatches,
      referenced_assets: referencedAssets,
      page_url: page.url,
    },
  });
}

async function pricingVisibilityAssertions(browserPage, page, options = {}) {
  const surfaces = options.brandContract?.pricing_surfaces?.surfaces;
  if (!surfaces) return [];
  const pageType = contractPageType(page);
  if (["upsell", "downsell"].includes(pageType)) {
    const selectors = surfaces.upsell?.price_row_selectors || [];
    if (!selectors.length) return [];
    const visibleCount = await countVisiblePriceRows(browserPage, selectors);
    return [upsellPriceVisibilityAssertion({ page, selectors, visibleCount })];
  }
  if (pageType === "checkout") {
    const selectors = surfaces.checkout_bundle?.price_row_selectors || [];
    if (!selectors.length) return [];
    const visibleCount = await countVisiblePriceRows(browserPage, selectors);
    return [checkoutPriceVisibilityAssertion({ page, selectors, visibleCount })];
  }
  return [];
}

// Visible = non-zero bounding box, display != none, visibility != hidden. This
// is what caught nothing in the dogfood run: a campaign CSS rule display:none'd
// the only price row on a full-price upsell and 48/48 checks still passed.
async function countVisiblePriceRows(browserPage, selectors) {
  return browserPage.evaluate((targets) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const seen = new Set();
    let count = 0;
    for (const selector of targets) {
      try {
        for (const element of document.querySelectorAll(selector)) {
          if (seen.has(element)) continue;
          seen.add(element);
          if (visible(element)) count += 1;
        }
      } catch {
        // invalid selector: contract bug surfaced elsewhere
      }
    }
    return count;
  }, selectors).catch(() => 0);
}

function upsellPriceVisibilityAssertion({ page, selectors, visibleCount }) {
  const ok = visibleCount >= 1;
  return assertion({
    id: "pricing.upsell_price_visible",
    family: "pricing",
    page,
    status: ok ? STATUS.PASS : STATUS.FAIL,
    severity: ok ? undefined : SEVERITY.BLOCKER,
    expected: "at least one visible price row on the upsell offer",
    actual: `${visibleCount} visible price row(s)`,
    evidence: { selectors, visible_count: visibleCount, page_url: page.url },
  });
}

function checkoutPriceVisibilityAssertion({ page, selectors, visibleCount }) {
  const ok = visibleCount >= 1;
  return assertion({
    id: "pricing.checkout_price_visible",
    family: "pricing",
    page,
    status: ok ? STATUS.PASS : STATUS.FAIL,
    severity: ok ? undefined : SEVERITY.WARN,
    expected: "at least one visible checkout bundle price row",
    actual: `${visibleCount} visible price row(s)`,
    evidence: { selectors, visible_count: visibleCount, page_url: page.url },
  });
}

// --- Typed-card step ladder ---
// Every test-order path executes as an ordered ladder of named, individually
// timed and bounded steps. Steps append to the ladder the moment they finish,
// so a crash or timeout still leaves the ladder up to the failure point — the
// 446s-hang-then-exit-1-with-nothing failure mode is structurally impossible.

const TEST_ORDER_STEP_LADDER = Object.freeze([
  "opened_checkout",
  "selected_bundle",
  "bump_state",
  "customer_fields_filled",
  "card_fields_filled",
  "cart_created",
  "hosted_redirect_observed",
  "order_submitted",
  "upsell_action",
  "receipt_reached",
]);

function formatStepEvent(entry) {
  return `[qa:test-order] step=${entry.step} status=${entry.status} ${entry.duration_ms}ms`;
}

function createStepLadder({ emit = (line) => process.stderr.write(`${line}\n`), now = () => Date.now() } = {}) {
  const steps = [];
  const record = (step, status, { startedAt = null, durationMs = 0, detail = null, error = null } = {}) => {
    const entry = {
      step,
      status,
      started_at: startedAt || new Date(now()).toISOString(),
      duration_ms: Math.max(0, Math.round(durationMs)),
      ...(detail ? { detail } : {}),
      ...(error ? { error } : {}),
    };
    steps.push(entry);
    emit(formatStepEvent(entry));
    return entry;
  };
  return {
    steps,
    has: (step) => steps.some((entry) => entry.step === step),
    ok: (step, detail = null) => record(step, "ok", { detail }),
    skip: (step, reason) => record(step, "skipped", { detail: reason }),
    // Run a step with a bounded timeout. A resolved string becomes the step
    // detail; a resolved { skip } object records the step as skipped.
    async run(step, fn, { timeoutMs, detail = null } = {}) {
      const startedMs = now();
      const startedAt = new Date(startedMs).toISOString();
      try {
        const value = await withStepTimeout(fn(), timeoutMs, step);
        if (value && typeof value === "object" && typeof value.skip === "string") {
          record(step, "skipped", { startedAt, durationMs: now() - startedMs, detail: value.skip });
          return value;
        }
        record(step, "ok", { startedAt, durationMs: now() - startedMs, detail: typeof value === "string" ? value : detail });
        return value;
      } catch (error) {
        const timedOut = error?.code === "step_timeout";
        record(step, timedOut ? "timeout" : "failed", {
          startedAt,
          durationMs: now() - startedMs,
          detail,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

function withStepTimeout(promise, timeoutMs, label) {
  const stepTimeoutError = (message) => {
    const error = new Error(message);
    error.code = "step_timeout";
    return error;
  };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(stepTimeoutError(`step ${label} aborted: order timeout budget exhausted`));
  }
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(stepTimeoutError(`step ${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Hosted checkout handoff: the platform redirects to <store>/accounts/complete-order/
// on a different origin. The old page object must not be filled past this point.
function hostedRedirectInfo(currentUrl, checkoutUrl) {
  try {
    const current = new URL(String(currentUrl));
    if (!current.pathname.includes(HOSTED_CHECKOUT_PATH)) return null;
    const checkout = new URL(String(checkoutUrl));
    if (current.origin === checkout.origin) return null;
    return { origin: current.origin, redacted_url: `${current.origin}${current.pathname}` };
  } catch {
    return null;
  }
}

function safePageUrl(page) {
  try {
    return page.url();
  } catch {
    return null;
  }
}

function ensurePageFillable(page, checkoutUrl) {
  if (page.isClosed()) {
    throw new Error("page closed before fill; aborting remaining locator actions");
  }
  const hosted = hostedRedirectInfo(safePageUrl(page), checkoutUrl);
  if (hosted) {
    const error = new Error(`page navigated to hosted checkout (${hosted.redacted_url}); aborting locator fills`);
    error.hostedRedirect = hosted;
    throw error;
  }
}

function skipRemainingSteps(ladder, stepNames, reason) {
  for (const step of stepNames) {
    if (!ladder.has(step)) ladder.skip(step, reason);
  }
}

async function runSingleBrowserTestOrder(context, checkoutPage, path, args, runId) {
  const orderTimeoutMs = numberArg(args["order-timeout-ms"], DEFAULT_ORDER_TIMEOUT_MS);
  const ladder = createStepLadder();
  let page = null;
  let events = { requests: [], responses: [], failed: [], console: [], pageErrors: [] };
  const email = testEmail(args);

  try {
    page = await context.newPage();
    page.setDefaultTimeout(numberArg(args["browser-timeout"], DEFAULT_BROWSER_TIMEOUT_MS));
    events = captureCheckoutEvents(page);
    // The outer race is the hard guarantee: whatever hangs inside the path,
    // this returns and the run writes a verdict instead of dying with nothing.
    return await withStepTimeout(
      executeTestOrderPath({ page, events, email, ladder, checkoutPage, path, args, deadline: Date.now() + orderTimeoutMs }),
      orderTimeoutMs + ORDER_TIMEOUT_GRACE_MS,
      `order-path:${path}`,
    );
  } catch (error) {
    return failedTestOrderResult({ path, email, error, events, ladder, page });
  } finally {
    await page?.close().catch(() => {});
  }
}

async function executeTestOrderPath({ page, events, email, ladder, checkoutPage, path, args, deadline }) {
  const stepTimeoutMs = numberArg(args["step-timeout-ms"], DEFAULT_STEP_TIMEOUT_MS);
  const budget = () => Math.min(stepTimeoutMs, deadline - Date.now());
  const hostedNow = () => hostedRedirectInfo(safePageUrl(page), checkoutPage.url);

  await ladder.run("opened_checkout", () => gotoAndSettle(page, checkoutPage.url, args), { timeoutMs: budget() });
  await ladder.run("selected_bundle", async () => {
    await selectRequestedCart(page, args);
    await advanceToCheckoutForm(page);
    return parseCart(args.cart).length ? `requested cart ${args.cart}` : "default bundle selection";
  }, { timeoutMs: budget() });
  await ladder.run("bump_state", async () => {
    const bump = await checkoutOrderBumpEvidence(page);
    if (!bump.toggles.length) return { skip: "no order bump toggles on checkout" };
    return `${bump.toggles.length} bump toggle(s), ${bump.toggles.filter((toggle) => toggle.active).length} active`;
  }, { timeoutMs: budget() });

  try {
    await ladder.run("customer_fields_filled", async () => {
      ensurePageFillable(page, checkoutPage.url);
      await fillCheckoutFields(page, args, email);
    }, { timeoutMs: budget() });
    await ladder.run("card_fields_filled", async () => {
      ensurePageFillable(page, checkoutPage.url);
      await fillPaymentFields(page, args);
    }, { timeoutMs: budget() });
    await ladder.run("cart_created", async () => {
      const seen = events.responses.some((response) => /\/api\/v1\/carts\/?/i.test(response.url));
      return seen ? "cart API response observed" : { skip: "no cart API call observed; checkout posts the order directly" };
    }, { timeoutMs: budget() });
    await ladder.run("order_submitted", async () => {
      ensurePageFillable(page, checkoutPage.url);
      await submitCheckout(page);
      await waitForCheckoutResult(page);
    }, { timeoutMs: budget() });
  } catch (error) {
    const hosted = error?.hostedRedirect || hostedNow();
    if (!hosted) throw error;
    return hostedRedirectOutcome({ page, events, email, checkoutPage, args, path, ladder, hosted });
  }

  const hostedAfterSubmit = hostedNow();
  if (hostedAfterSubmit) {
    return hostedRedirectOutcome({ page, events, email, checkoutPage, args, path, ladder, hosted: hostedAfterSubmit });
  }
  ladder.skip("hosted_redirect_observed", "no hosted checkout redirect observed");

  const order = await buildOrderEvidence({ page, events, path, email, checkoutPage, args });
  order.evidence.steps = ladder.steps;
  const stepFailures = [];
  const upsellSteps = testOrderSteps(path);

  if (order.ok && upsellSteps.length) {
    order.upsell_steps = [];
  }
  if (!upsellSteps.length) ladder.skip("upsell_action", "path has no upsell steps");

  for (let stepIndex = 0; order.ok && stepIndex < upsellSteps.length; stepIndex += 1) {
    const step = upsellSteps[stepIndex];
    await ladder.run("upsell_action", async () => {
      const initialLineItems = order.receipt_line_items.slice();
      const initialUpsellMutationCount = upsellMutationCount(events);
      await waitForUpsellPageReady(page, args);
      const upsell = await clickUpsellPath(page, step, { events, stepIndex });
      const preferredOrderBody = upsell.api_response_order_body || null;
      delete upsell.api_response_order_body;
      order.upsell = upsell;
      order.upsell_steps.push(upsell);
      order.final_url = safePageUrl(page);
      const refreshed = await buildOrderEvidence({ page, events, path, email, checkoutPage, args, preferredOrderBody });
      order.final_receipt_line_items = refreshed.receipt_line_items;
      if (refreshed.receipt_line_items.length) {
        order.cart_state = refreshed.cart_state;
        order.receipt_line_items = refreshed.receipt_line_items;
        order.verification.order_read_status = refreshed.verification.order_read_status;
        order.verification.total_incl_tax = refreshed.verification.total_incl_tax;
        order.verification.currency = refreshed.verification.currency;
      }
      if (step === "accept") {
        const proof = acceptedUpsellProof(order.receipt_line_items, initialLineItems, upsell.expected_items, events);
        upsell.verification = {
          accepted_upsell_line_present: proof.ok,
          accepted_upsell_match: proof,
          upsell_api_response_seen: upsell.api_response_seen,
          upsell_api_response_status: upsell.api_response_status,
        };
        stepFailures.push(...upsellAcceptStepFailures(stepIndex, proof, upsell.api_response_seen));
        if (proof.ok && !upsell.api_response_seen) {
          upsell.verification.upsell_api_response_observation =
            "live order-upsell request not observed; confirmed via order read-back (upsell line present in persisted order)";
        }
      } else {
        const proof = declinedUpsellProof(order.receipt_line_items, initialLineItems, events, initialUpsellMutationCount);
        upsell.verification = proof;
        if (!proof.ok) stepFailures.push(`step ${stepIndex + 1}: ${proof.reason}`);
      }
      return `step ${stepIndex + 1}: ${step}`;
    }, { timeoutMs: budget() });
  }

  const finalUrl = safePageUrl(page) || "";
  if (/receipt|thank/i.test(finalUrl)) {
    ladder.ok("receipt_reached", redactUrlQuery(finalUrl));
  } else {
    ladder.skip("receipt_reached", `path ended at ${redactUrlQuery(finalUrl) || "(unknown url)"}`);
  }

  const acceptedSteps = (order.upsell_steps || []).filter((step) => step.path === "accept");
  if (acceptedSteps.length) {
    order.verification.accepted_upsell_line_present = acceptedSteps.every((step) => step.verification?.accepted_upsell_line_present === true);
    order.verification.upsell_api_response_seen = acceptedSteps.every((step) => step.verification?.upsell_api_response_seen === true);
    order.verification.accepted_upsell_matches = acceptedSteps.map((step) => step.verification?.accepted_upsell_match).filter(Boolean);
  }
  if (stepFailures.length) order.verification.upsell_step_failures = stepFailures;

  const ok = order.ok && stepFailures.length === 0;
  return {
    ok,
    error: ok ? null : order.error || order.upsell?.error || stepFailures.join("; ") || "accepted upsell did not appear in final order lines",
    order,
    events: sanitizedEvents(events),
  };
}

// Hosted checkout is platform-owned: reaching it is the terminal step for the
// path in v0 — recorded as manual_review, not a hard fail.
async function hostedRedirectOutcome({ page, events, email, checkoutPage, args, path, ladder, hosted }) {
  ladder.ok("hosted_redirect_observed", `redirected to hosted checkout: ${hosted.redacted_url}`);
  skipRemainingSteps(
    ladder,
    ["order_submitted", "upsell_action", "receipt_reached"],
    "hosted checkout flow is platform-owned; typed-card runner stops at the handoff",
  );
  let order;
  try {
    order = await buildOrderEvidence({ page, events, path, email, checkoutPage, args });
  } catch {
    order = {
      path,
      ok: false,
      next_order_id: null,
      ref_id: null,
      qa_email: email ? "[redacted-qa-email]" : null,
      checkout_url: checkoutPage.url,
      final_url: safePageUrl(page),
      verification: { verified: false },
      evidence: {},
    };
  }
  order.ok = false;
  order.outcome = "manual_review";
  order.hosted_checkout_url = hosted.redacted_url;
  order.verification = { ...order.verification, verified: false, hosted_redirect: true };
  order.evidence = { ...order.evidence, steps: ladder.steps, events: sanitizedEvents(events) };
  return { ok: false, manual_review: true, error: null, order, events: sanitizedEvents(events) };
}

function failedTestOrderResult({ path, email, error, events, ladder, page }) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: message,
    order: {
      path,
      ok: false,
      next_order_id: null,
      ref_id: null,
      qa_email: email ? "[redacted-qa-email]" : null,
      final_url: page ? safePageUrl(page) : null,
      verification: { verified: false, error: message },
      evidence: { steps: ladder.steps, events: sanitizedEvents(events) },
    },
    events: sanitizedEvents(events),
  };
}

function redactUrlQuery(value) {
  try {
    const url = new URL(String(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value || "").split("?")[0] || null;
  }
}

async function gotoAndSettle(page, url, args) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: numberArg(args["browser-timeout"], DEFAULT_BROWSER_TIMEOUT_MS) });
  await page.waitForLoadState("networkidle", { timeout: DEFAULT_SETTLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(750);
}

async function selectRequestedCart(page, args) {
  const cart = parseCart(args.cart);
  for (const item of cart) {
    const selector = `[data-next-selector-card][data-next-package-id="${escapeCss(String(item.packageId))}"], [data-next-package-id="${escapeCss(String(item.packageId))}"]`;
    const target = page.locator(selector).first();
    if (await target.count().catch(() => 0)) {
      await target.scrollIntoViewIfNeeded().catch(() => {});
      await target.click({ timeout: 5000 }).catch(() => {});
    }
  }
}

async function advanceToCheckoutForm(page) {
  if (await hasVisibleCheckoutFields(page)) return;
  const explicit = page.locator('[data-next-action="add-to-cart"], [data-next-checkout-action="add-to-cart"], [data-next-add-to-cart]').first();
  if (await explicit.count().catch(() => 0)) {
    await explicit.click({ timeout: 8000 }).catch(() => {});
  } else {
    await clickVisibleControlByText(page, /add to cart|checkout|continue|buy now/i);
  }
  await page.waitForTimeout(1500);
  if (!await hasVisibleCheckoutFields(page)) throw new Error("Checkout form did not become visible after cart selection.");
}

async function hasVisibleCheckoutFields(page) {
  return page.locator('[data-next-checkout-field="email"]:visible, [data-next-checkout-field="cc-number"]:visible, #spreedly-number:visible')
    .count()
    .then((count) => count > 0)
    .catch(() => false);
}

async function fillCheckoutFields(page, args, email) {
  const address = {
    firstName: stringArg(args["test-first-name"]) || "QA",
    lastName: stringArg(args["test-last-name"]) || "Playwright",
    email,
    phone: args["test-phone"] === true ? "" : stringArg(args["test-phone"]) || "",
    country: stringArg(args["test-country"]) || "US",
    address1: stringArg(args["test-address1"]) || "1600 Amphitheatre Pkwy",
    city: stringArg(args["test-city"]) || "Mountain View",
    province: stringArg(args["test-province"]) || "CA",
    postal: stringArg(args["test-postal"]) || "94043",
  };

  await fillByField(page, "fname", address.firstName);
  await fillByField(page, "lname", address.lastName);
  await fillByField(page, "email", address.email);
  await fillByField(page, "phone", address.phone, { optional: true });
  await selectByField(page, "country", address.country);
  await fillByField(page, "address1", address.address1);
  await settleAddressAutocomplete(page);
  await fillByField(page, "city", address.city);
  await selectByField(page, "province", address.province);
  await fillByField(page, "postal", address.postal);
  await closeAddressAutocomplete(page);

  const sameAsShipping = page.locator("#use_shipping_address").first();
  if (await sameAsShipping.count().catch(() => 0)) {
    await sameAsShipping.check().catch(() => {});
  }

  await fillByField(page, "billing-fname", address.firstName, { optional: true, onlyVisible: true });
  await fillByField(page, "billing-lname", address.lastName, { optional: true, onlyVisible: true });
  await fillByField(page, "billing-phone", address.phone, { optional: true, onlyVisible: true });
  await selectByField(page, "billing-country", address.country, { optional: true, onlyVisible: true });
  await fillByField(page, "billing-address1", address.address1, { optional: true, onlyVisible: true });
  await fillByField(page, "billing-city", address.city, { optional: true, onlyVisible: true });
  await selectByField(page, "billing-province", address.province, { optional: true, onlyVisible: true });
  await fillByField(page, "billing-postal", address.postal, { optional: true, onlyVisible: true });
}

async function fillPaymentFields(page, args) {
  await clickCreditPaymentMethod(page);
  await selectByField(page, "exp-month", stringArg(args["test-exp-month"]) || DEFAULT_TEST_EXP_MONTH);
  await selectYear(page, stringArg(args["test-exp-year"]) || DEFAULT_TEST_EXP_YEAR);

  const card = normalizeCard(stringArg(args["test-card"]) || DEFAULT_TEST_CARD);
  const cvv = stringArg(args["test-cvv"]) || DEFAULT_TEST_CVV;
  const numberInput = page.frameLocator('iframe[id^="spreedly-number-frame"]').locator("input").first();
  const cvvInput = page.frameLocator('iframe[id^="spreedly-cvv-frame"]').locator("input").first();
  await numberInput.click();
  await numberInput.pressSequentially(card, { delay: 20 });
  await cvvInput.click();
  await cvvInput.pressSequentially(cvv, { delay: 20 });
  await page.locator("body").click({ position: { x: 20, y: 20 } }).catch(() => {});
  await page.waitForTimeout(500);
}

async function clickCreditPaymentMethod(page) {
  const candidates = [
    "#combo_mode_credit",
    '[data-next-payment-method="credit"]',
    '[data-next-payment-method="card"]',
    'input[name="payment_method"][value="credit"]',
    'input[name="payment_method"][value="card"]',
  ];
  for (const selector of candidates) {
    const target = page.locator(selector).first();
    if (await target.count().catch(() => 0)) {
      await target.click({ force: true }).catch(() => {});
      return;
    }
  }
}

async function submitCheckout(page) {
  await closeAddressAutocomplete(page);
  const submit = page.locator('button.submit-button[os-checkout-payment="combo"], button[os-checkout-payment="combo"], button[type="submit"]').first();
  await submit.waitFor({ state: "visible" });
  await submit.scrollIntoViewIfNeeded();
  await submit.click();
}

async function waitForCheckoutResult(page) {
  await page.waitForURL((url) => /ref_id=|receipt|upsell|thank|order|payment_failed/i.test(String(url)), { timeout: 60000 }).catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: DEFAULT_SETTLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: DEFAULT_SETTLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function buildOrderEvidence({ page, events, path, email, checkoutPage, args, preferredOrderBody = null }) {
  const orderCreate = lastJsonResponse(events, /\/api\/v1\/orders\/?$/i);
  const orderRead = lastJsonResponse(events, /\/api\/v1\/orders\/[^/]+\/$/i);
  const upsellOrderResponse = lastJsonResponse(events, ORDER_UPSELLS_RESPONSE_PATTERN);
  const orderBody = preferredOrderBody || upsellOrderResponse?.body || orderRead?.body || orderCreate?.body || null;
  const refId = stringArg(orderBody?.ref_id) || refIdFromUrl(page.url());
  const number = stringArg(orderBody?.number) || stringArg(orderBody?.id) || null;
  const card = normalizeCard(stringArg(args["test-card"]) || DEFAULT_TEST_CARD);
  const ok = Boolean(orderCreate && orderCreate.status >= 200 && orderCreate.status < 300 && refId);
  return {
    path,
    ok,
    next_order_id: number,
    ref_id: refId,
    qa_email: email ? "[redacted-qa-email]" : null,
    is_test: orderBody?.is_test ?? null,
    payment_method: orderBody?.payment_method || (ok ? "card_token" : null),
    card: { last4: card.slice(-4) },
    checkout_url: checkoutPage.url,
    final_url: page.url(),
    cart_state: cartStateFromOrder(orderBody) || cartStateFromArgs(args),
    receipt_line_items: extractReceiptLines(orderBody),
    verification: {
      verified: ok,
      order_create_status: orderCreate?.status || null,
      order_read_status: orderRead?.status || null,
      total_incl_tax: orderBody?.total_incl_tax || null,
      currency: orderBody?.currency || null,
      error: ok ? null : await visibleErrorText(page),
    },
    evidence: {
      order_request_seen: Boolean(orderCreate),
      spreedly_tokenized: events.requests.some((request) => /spreedly.*payment_methods/i.test(request.url)),
      events: sanitizedEvents(events),
    },
  };
}

async function clickUpsellPath(page, path, _options = {}) {
  const action = path === "accept" ? "add" : "skip";
  const selector = `[data-next-upsell-action="${action}"]`;
  const control = page.locator(selector).first();
  if (!await control.count().catch(() => 0)) {
    return { path, clicked: false, error: `Missing upsell control ${selector}` };
  }
  const expectedItems = path === "accept" ? await selectedUpsellItems(page) : [];
  const mutationPromise = path === "accept"
    ? page.waitForResponse((response) => (
        response.request().method() === "POST"
        && isOrderUpsellsUrl(response.url())
      ), { timeout: 20000 }).catch(() => null)
    : Promise.resolve(null);
  await control.scrollIntoViewIfNeeded().catch(() => {});
  await control.click({ timeout: 10000 }).catch(async () => {
    await control.click({ force: true });
  });
  const mutationResponse = await mutationPromise;
  const mutationBody = mutationResponse ? await readJsonResponseBody(mutationResponse) : null;
  await waitForCheckoutResult(page);
  return {
    path,
    clicked: true,
    final_url: page.url(),
    expected_items: expectedItems,
    api_response_seen: Boolean(mutationResponse),
    api_response_status: mutationResponse?.status() || null,
    api_response_url: mutationResponse?.url() || null,
    api_response_order_body: mutationBody,
  };
}

function testOrderAssertion(page, path, result) {
  if (result.manual_review) {
    return assertion({
      id: `browser-test-order:${path}`,
      family: "browser-test-order",
      page,
      status: STATUS.MANUAL_REVIEW,
      severity: SEVERITY.WARN,
      expected: "test order created through deployed checkout page",
      actual: `hosted checkout redirect observed: ${result.order?.hosted_checkout_url || "(unknown)"}`,
      evidence: {
        hosted_checkout_url: result.order?.hosted_checkout_url || null,
        final_url: result.order?.final_url,
        steps: result.order?.evidence?.steps,
        note: "Hosted checkout flow is platform-owned; verify the hosted completion manually.",
      },
    });
  }
  return assertion({
    id: `browser-test-order:${path}`,
    family: "browser-test-order",
    page,
    status: result.ok ? STATUS.PASS : STATUS.FAIL,
    severity: result.ok ? undefined : SEVERITY.BLOCKER,
    expected: "test order created through deployed checkout page",
    actual: result.ok ? result.order.next_order_id || result.order.ref_id : result.error || result.order?.verification?.error || "order not created",
    evidence: result.ok
      ? {
          ref_id: result.order.ref_id,
          order_number: result.order.next_order_id,
          final_url: result.order.final_url,
          is_test: result.order.is_test,
          line_count: result.order.receipt_line_items.length,
          ...(path === "accept" ? { accepted_upsell_line_present: result.order.verification?.accepted_upsell_line_present } : {}),
          ...(result.order.upsell ? { upsell_clicked: result.order.upsell.clicked, upsell_final_url: result.order.upsell.final_url } : {}),
          ...(result.order.upsell_steps ? { upsell_steps: result.order.upsell_steps.map(summarizeUpsellStep) } : {}),
          ...(result.order.verification?.accepted_upsell_matches ? { accepted_upsell_matches: result.order.verification.accepted_upsell_matches } : {}),
          card_last4: result.order.card.last4,
        }
      : {
          final_url: result.order?.final_url,
          steps: result.order?.evidence?.steps,
          events: result.events,
        },
  });
}

function captureCheckoutEvents(page) {
  const events = { requests: [], responses: [], failed: [], console: [], pageErrors: [] };
  const interesting = /\/api\/v1\/(?:orders|upsells|carts)\/?|\/transactions|spreedly|campaigns\.apps/i;
  page.on("request", (request) => {
    if (!interesting.test(request.url())) return;
    events.requests.push({
      method: request.method(),
      url: request.url(),
      postData: summarizeRequestPostData(request.postData()),
    });
  });
  page.on("response", async (response) => {
    if (!interesting.test(response.url())) return;
    events.responses.push({
      status: response.status(),
      url: response.url(),
      body: await readJsonResponseBody(response),
    });
  });
  page.on("requestfailed", (request) => {
    if (!interesting.test(request.url())) return;
    events.failed.push({ url: request.url(), failure: request.failure()?.errorText || "request failed" });
  });
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) events.console.push({ type: message.type(), text: trim(message.text()) });
  });
  page.on("pageerror", (error) => events.pageErrors.push(trim(error.message)));
  return events;
}

async function readJsonResponseBody(response) {
  const text = await response.text().catch(() => null);
  return parseMaybeJson(redactSensitive(text));
}

function lastJsonResponse(events, pattern) {
  for (let index = events.responses.length - 1; index >= 0; index -= 1) {
    const response = events.responses[index];
    if (pattern.test(response.url) && response.body && typeof response.body === "object" && !Array.isArray(response.body)) return response;
  }
  return null;
}

function sanitizedEvents(events) {
  return {
    requests: events.requests.slice(-20),
    responses: events.responses.slice(-20).map((response) => ({
      status: response.status,
      url: response.url,
      body: summarizeResponseBody(response.body),
    })),
    failed: events.failed.slice(-20),
    console: events.console.slice(-20),
    pageErrors: events.pageErrors.slice(-20),
  };
}

function summarizeRequestPostData(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "[redacted-request-body]";
    return {
      redacted: true,
      keys: Object.keys(parsed).sort(),
      ...(Array.isArray(parsed.lines) ? { line_count: parsed.lines.length } : {}),
      ...(parsed.currency ? { currency: parsed.currency } : {}),
    };
  } catch {
    return "[redacted-request-body]";
  }
}

function summarizeResponseBody(body) {
  if (typeof body === "string") return trim(body).slice(0, 1000);
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  return {
    ...(body.number ? { number: body.number } : {}),
    ...(body.ref_id ? { ref_id: body.ref_id } : {}),
    ...(body.is_test !== undefined ? { is_test: body.is_test } : {}),
    ...(body.total_incl_tax ? { total_incl_tax: body.total_incl_tax } : {}),
    ...(body.currency ? { currency: body.currency } : {}),
    ...(body.checkout_url ? { checkout_url: body.checkout_url } : {}),
    ...(Array.isArray(body.lines) ? { lines: extractReceiptLines(body) } : {}),
    ...(body.detail ? { detail: body.detail } : {}),
  };
}

async function clickVisibleControlByText(page, pattern) {
  const controls = page.locator('button:visible, a:visible, [role="button"]:visible, input[type="submit"]:visible, input[type="button"]:visible, div[class*="button"]:visible, div[class*="btn"]:visible');
  const count = await controls.count();
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    const text = trim((await control.innerText().catch(() => "")) || (await control.getAttribute("value").catch(() => "")));
    if (!pattern.test(text)) continue;
    await control.scrollIntoViewIfNeeded().catch(() => {});
    await control.click({ timeout: 8000 });
    return true;
  }
  throw new Error(`No visible control matched ${pattern}`);
}

function parseMaybeJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return trim(text).slice(0, 1000);
  }
}

function redactSensitive(value) {
  if (typeof value !== "string") return value ?? null;
  return value
    .replace(/"number"\s*:\s*"\d{12,19}"/g, '"number":"[redacted-card]"')
    .replace(/"verification_value"\s*:\s*"[^"]+"/g, '"verification_value":"[redacted-cvv]"')
    .replace(/"card_token"\s*:\s*"[^"]+"/g, '"card_token":"[redacted-token]"')
    .replace(/01[A-Z0-9]{24}/g, "[redacted-token]");
}

async function visibleErrorText(page) {
  const messages = await page.locator('.next-error-label:visible, [class*="error"]:visible, [class*="alert"]:visible')
    .evaluateAll((elements) => elements.map((element) => element.textContent?.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 10))
    .catch(() => []);
  return messages.join("; ") || "order request not observed";
}

async function fillByField(page, field, value, options = {}) {
  const locator = page.locator(`[data-next-checkout-field="${field}"]`).first();
  if (!await fieldUsable(locator, options)) {
    if (options.optional) return false;
    throw new Error(`Missing checkout field: ${field}`);
  }
  await locator.click().catch(() => {});
  await locator.fill(value);
  return true;
}

async function selectByField(page, field, value, options = {}) {
  const locator = page.locator(`[data-next-checkout-field="${field}"]`).first();
  if (!await fieldUsable(locator, options)) {
    if (options.optional) return false;
    throw new Error(`Missing checkout select: ${field}`);
  }
  await locator.selectOption(value);
  return true;
}

async function selectYear(page, value) {
  const locator = page.locator('[data-next-checkout-field="exp-year"]').first();
  await locator.waitFor({ state: "visible" });
  const options = await locator.locator("option").evaluateAll((elements) => elements.map((option) => ({ value: option.value, text: option.textContent?.trim() })));
  const match = options.find((option) => option.value === value || option.text === value)
    || options.find((option) => option.value && !/year/i.test(option.text || ""));
  if (!match?.value) throw new Error("No usable expiration year option found.");
  await locator.selectOption(match.value);
}

async function fieldUsable(locator, options = {}) {
  const count = await locator.count().catch(() => 0);
  if (!count) return false;
  if (options.onlyVisible) return locator.isVisible().catch(() => false);
  await locator.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  return locator.isVisible().catch(() => false);
}

async function settleAddressAutocomplete(page) {
  await page.waitForTimeout(750);
  const suggestion = page.locator(".pac-item, .pac-container .pac-item, [role=option]").first();
  if (await suggestion.count().catch(() => 0) && await suggestion.isVisible().catch(() => false)) {
    await suggestion.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function closeAddressAutocomplete(page) {
  const close = page.locator(".pac-close-button").first();
  if (await close.count().catch(() => 0) && await close.isVisible().catch(() => false)) {
    await close.click({ force: true }).catch(() => {});
  }
}

function testOrderPaths(mode, topologies = []) {
  const normalized = String(mode || "off").toLowerCase();
  // `common` (also the bare `--test-order` flag, which parses to boolean true)
  // is the default sample: a sensible 3-5 shapes for everyday QA. `full` is the
  // explicit opt-in for every accept/decline permutation.
  if (normalized === "common" || normalized === "true") return testOrderCommonPaths(topologies);
  if (normalized === "full") return ["checkout", ...testOrderPathMatrix(testOrderDepth(topologies))];
  if (normalized === "both") return ["accept", "decline"];
  if (["checkout", "accept", "decline"].includes(normalized)) return [normalized];
  if (/^(accept|decline)(-(accept|decline))+$/.test(normalized)) return [normalized];
  throw new Error(`Unknown --test-order mode: ${mode}`);
}

// The default "common shapes" sample: checkout baseline, plus first-upsell
// accept and decline when the funnel has post-checkout offers, plus one deeper
// mixed path when there are two or more offers. Stays within 1-4 orders so it
// never trips the flood cap. Bundle/quantity and bump coverage come from
// `--cart`; exhaustive permutations come from `full`.
function testOrderCommonPaths(topologies = []) {
  const depth = testOrderDepth(topologies);
  const paths = ["checkout"];
  if (depth >= 1) paths.push("accept", "decline");
  if (depth >= 2) paths.push("accept-decline");
  return paths;
}

function enforceTestOrderLimit(paths, args) {
  const maxOrders = numberArg(args["max-test-orders"], DEFAULT_MAX_TEST_ORDERS);
  if (paths.length <= maxOrders) return;
  const preview = paths.slice(0, 8).join(", ");
  const suffix = paths.length > 8 ? ", ..." : "";
  throw new Error([
    `--test-order ${args["test-order"]} expands to ${paths.length} typed-card order(s), above --max-test-orders ${maxOrders}.`,
    `Planned paths: ${preview}${suffix}.`,
    "This cap guards against an accidental order flood, not a permission gate. Use --test-order common for the default sample, or rerun with a higher --max-test-orders for exhaustive proof.",
  ].join(" "));
}

function testOrderDepth(topologies = []) {
  const pages = topologies.flatMap((topology) => Array.isArray(topology?.pages) ? topology.pages : []);
  return pages.filter((page) => ["upsell", "downsell"].includes(String(page?.page_type || "").toLowerCase())).length;
}

function testOrderPathMatrix(depth) {
  const count = Math.max(0, Number(depth || 0));
  if (count === 0) return [];
  const paths = [];
  const walk = (prefix, remaining) => {
    if (remaining === 0) {
      paths.push(prefix.join("-"));
      return;
    }
    walk([...prefix, "decline"], remaining - 1);
    walk([...prefix, "accept"], remaining - 1);
  };
  walk([], count);
  return paths;
}

function testOrderSteps(path) {
  const normalized = String(path || "").toLowerCase();
  if (!normalized || normalized === "checkout") return [];
  const steps = normalized.split("-").filter(Boolean);
  if (!steps.every((step) => ["accept", "decline"].includes(step))) {
    throw new Error(`Unknown test-order path: ${path}`);
  }
  return steps;
}

export function testEmail(args) {
  const explicit = stringArg(args["test-email"]);
  if (explicit) return explicit;
  const configured = stringArg(process.env.CAMPAIGNS_OS_QA_TEST_EMAIL);
  if (configured) return configured;
  // Stable per-prefix and stable default — reuse one customer across runs.
  // (Previously appended runId + timestamp, which minted a fresh undeletable
  // customer on every run.)
  const prefix = stringArg(args["test-email-prefix"]);
  if (prefix) return prefix.includes("@") ? prefix : `${prefix}@campaigns-os.test`;
  return DEFAULT_QA_TEST_EMAIL;
}

function cartStateFromArgs(args) {
  const packages = parseCart(args.cart).map((item) => ({ ref_id: item.packageId, quantity: item.quantity }));
  return packages.length ? { packages } : { packages: [] };
}

function cartStateFromOrder(order) {
  if (!Array.isArray(order?.lines)) return null;
  return {
    packages: order.lines.map((line) => ({
      title: line.product_title || line.title || null,
      quantity: line.quantity ?? null,
      is_upsell: line.is_upsell ?? null,
    })),
  };
}

function extractReceiptLines(order) {
  if (!Array.isArray(order?.lines)) return [];
  return order.lines.map((line) => ({
    title: line.product_title || line.title || line.name || null,
    quantity: Number(line.quantity || 0),
    is_upsell: Boolean(line.is_upsell),
    price: line.price_incl_tax || line.price_excl_tax || line.price || null,
    sku: line.product_sku || line.sku || null,
    product_id: line.product_id ?? null,
    variant_id: line.variant_id ?? line.product_variant_id ?? null,
  }));
}

async function waitForUpsellPageReady(page, args) {
  const timeoutMs = numberArg(args["browser-timeout"], DEFAULT_BROWSER_TIMEOUT_MS);
  await page.locator('[data-next-upsell], [data-next-upsell-action="add"], [data-next-upsell-action="skip"]').first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: DEFAULT_SETTLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForFunction(() => document.documentElement.classList.contains("next-display-ready"), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function selectedUpsellItems(page) {
  return page.evaluate(() => {
    const offer = document.querySelector("[data-next-upsell]") || document;
    const selector = offer.querySelector("[data-next-bundle-selector][data-next-upsell-context]")
      || offer.querySelector("[data-next-bundle-selector]");
    const selectedCard = selector?.querySelector('[data-next-bundle-card][data-next-selected="true"], [data-next-bundle-card].next-selected')
      || selector?.querySelector("[data-next-bundle-card]");
    const parseJson = (value) => {
      if (!value) return null;
      try { return JSON.parse(value); } catch { return null; }
    };
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    if (selectedCard) {
      const items = parseJson(selectedCard.getAttribute("data-next-bundle-items"));
      if (Array.isArray(items) && items.length) {
        return items.map((item) => {
          const packageId = String(item.packageId ?? item.package_id ?? "");
          const displayName = clean(document.querySelector(`[data-next-display="package.${packageId}.name"]`)?.textContent);
          return {
            package_id: packageId,
            quantity: Number(item.quantity || 1),
            display_name: displayName || null,
            selector_id: selector?.getAttribute("data-next-selector-id") || null,
            bundle_id: selectedCard.getAttribute("data-next-bundle-id") || null,
            vouchers: parseJson(selectedCard.getAttribute("data-next-bundle-vouchers")) || [],
          };
        }).filter((item) => item.package_id);
      }
    }

    const directPackageId = offer.getAttribute?.("data-next-package-id")
      || offer.querySelector?.("[data-next-package-id]")?.getAttribute("data-next-package-id");
    if (directPackageId) {
      const displayName = clean(document.querySelector(`[data-next-display="package.${directPackageId}.name"]`)?.textContent);
      return [{ package_id: String(directPackageId), quantity: 1, display_name: displayName || null, selector_id: null, bundle_id: null, vouchers: [] }];
    }
    return [];
  }).catch(() => []);
}

// Decide whether an accepted-upsell step should fail. The order read-back (proof.ok)
// is authoritative: the upsell line cannot appear in the persisted order unless the
// order-upsell API added it. The live network observation (apiResponseSeen) is a
// best-effort signal that can miss the request on fast stepper-accept client nav, so
// it must not block on its own. Block only when the read-back proof also fails.
function upsellAcceptStepFailures(stepIndex, proof, apiResponseSeen) {
  const failures = [];
  if (!proof.ok) {
    failures.push(`step ${stepIndex + 1}: ${proof.reason}`);
    if (!apiResponseSeen) {
      failures.push(`step ${stepIndex + 1}: upsell accept did not call order upsell API`);
    }
  }
  return failures;
}

function acceptedUpsellProof(lines, initialLines, expectedItems, events) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { ok: false, reason: "final order lines were empty", expected_items: expectedItems || [], matched_lines: [] };
  }

  const expected = Array.isArray(expectedItems) ? expectedItems.filter((item) => item?.package_id) : [];
  if (expected.length) {
    const matchedLines = [];
    const missing = [];
    for (const item of expected) {
      const match = lines.find((line) => (
        line.is_upsell
        && Number(line.quantity || 0) === Number(item.quantity || 1)
        && lineMatchesExpectedUpsell(line, item, events)
      ));
      if (match) matchedLines.push(match);
      else missing.push(item);
    }
    return {
      ok: missing.length === 0,
      reason: missing.length ? `expected upsell package(s) not found in final order lines: ${missing.map((item) => item.package_id).join(", ")}` : null,
      expected_items: expected,
      matched_lines: matchedLines,
    };
  }

  const newLines = addedLines(lines, initialLines);
  const matchedLines = newLines.filter((line) => line.is_upsell);
  return {
    ok: matchedLines.length > 0,
    reason: matchedLines.length ? null : "no new upsell line appeared after accept",
    expected_items: [],
    matched_lines: matchedLines,
  };
}

function declinedUpsellProof(lines, initialLines, events, initialUpsellMutationCount = 0) {
  const mutationSeen = upsellMutationCount(events) > initialUpsellMutationCount;
  if (mutationSeen) return { ok: false, reason: "decline path called order upsell API" };
  const newLines = addedLines(lines, initialLines);
  if (newLines.some((line) => line.is_upsell)) return { ok: false, reason: "decline path added an upsell line", added_lines: newLines };
  return { ok: true, reason: null };
}

function addedLines(lines, initialLines) {
  const remaining = (initialLines || []).map(lineSignature);
  return (lines || []).filter((line) => {
    const signature = lineSignature(line);
    const index = remaining.indexOf(signature);
    if (index >= 0) {
      remaining.splice(index, 1);
      return false;
    }
    return true;
  });
}

function lineMatchesExpectedUpsell(line, expected, events) {
  const meta = campaignPackageMeta(events, expected.package_id);
  if (meta?.product_sku && line.sku && normalizeLabel(meta.product_sku) === normalizeLabel(line.sku)) return true;
  if (meta?.product_variant_id && Number(line.variant_id) === Number(meta.product_variant_id)) return true;
  if (meta?.product_id && Number(line.product_id) === Number(meta.product_id)) return true;

  const lineTitle = normalizeLabel(line.title);
  const names = [
    expected.display_name,
    meta?.name,
    meta?.product_name,
    meta?.product_variant_name,
  ].map(normalizeLabel).filter(Boolean);
  return names.some((name) => lineTitle.includes(name) || name.includes(lineTitle));
}

function campaignPackageMeta(events, packageId) {
  const target = String(packageId);
  for (let index = events.responses.length - 1; index >= 0; index -= 1) {
    const body = events.responses[index]?.body;
    if (!Array.isArray(body?.packages)) continue;
    const match = body.packages.find((pkg) => String(pkg.ref_id) === target);
    if (match) return match;
  }
  return null;
}

function upsellMutationCount(events) {
  return (events.responses || []).filter((response) => isOrderUpsellsUrl(response.url)).length;
}

function isOrderUpsellsUrl(url) {
  return ORDER_UPSELLS_RESPONSE_PATTERN.test(String(url || ""));
}

function summarizeUpsellStep(step) {
  return {
    path: step.path,
    clicked: step.clicked,
    final_url: step.final_url,
    expected_items: step.expected_items,
    api_response_seen: step.api_response_seen,
    api_response_status: step.api_response_status,
    accepted_upsell_line_present: step.verification?.accepted_upsell_line_present,
  };
}

function lineSignature(line) {
  return [
    normalizeLabel(line?.title),
    Number(line?.quantity || 0),
    normalizeLabel(line?.sku),
    normalizeLabel(line?.price),
    line?.is_upsell === true ? "upsell" : "base",
  ].join("|");
}

function normalizeLabel(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function refIdFromUrl(value) {
  try {
    return new URL(value).searchParams.get("ref_id");
  } catch {
    return null;
  }
}

function withQueryParam(value, key, paramValue) {
  try {
    const url = new URL(value);
    url.searchParams.set(key, paramValue);
    return url.toString();
  } catch {
    const separator = String(value || "").includes("?") ? "&" : "?";
    return `${value}${separator}${encodeURIComponent(key)}=${encodeURIComponent(paramValue)}`;
  }
}

function findPage(topologies, type) {
  for (const topology of topologies || []) {
    const page = (topology.pages || []).find((candidate) => candidate.page_type === type);
    if (page) return page;
  }
  return null;
}

function parseCart(value) {
  if (!value) return [];
  return String(value).split(",").map((part) => {
    const [packageId, quantity] = part.split(":").map((item) => item.trim());
    return { packageId, quantity: Number.parseInt(quantity || "1", 10) || 1 };
  }).filter((item) => item.packageId);
}

function normalizeCard(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function stringArg(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function escapeCss(value) {
  return value.replace(/["\\]/g, "\\$&");
}

function runtimeIssueAssertion(page, kind, messages) {
  return assertion({
    id: `${kind}:${page.page_id}`,
    family: "browser-runtime",
    page,
    status: STATUS.WARN,
    severity: SEVERITY.WARN,
    expected: "clean browser runtime",
    actual: `${messages.length} issue(s)`,
    evidence: { messages: messages.slice(0, 10) },
  });
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

function viewportFromArgs(args) {
  const width = numberArg(args["browser-width"], 1440);
  const height = numberArg(args["browser-height"], 1200);
  return { width, height };
}

function numberArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trim(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function launchChromium(args) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (error) {
    throw new Error([
      "Playwright is not installed for Campaigns OS.",
      "Run `npm install` from the campaigns-os repo, then rerun QA.",
      `Original error: ${error instanceof Error ? error.message : String(error)}`,
    ].join(" "));
  }

  try {
    return await chromium.launch({ headless: args.headed !== true });
  } catch (error) {
    if (isMissingPlaywrightBrowser(error)) {
      throw new Error([
        "Playwright Chromium is not installed for Campaigns OS browser QA.",
        "Run `npm run qa:install-browser` from the campaigns-os repo, then rerun the QA command.",
        "This is required before using `--browser` or `--test-order`.",
      ].join(" "));
    }
    throw error;
  }
}

function isMissingPlaywrightBrowser(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /executable doesn't exist|browser.*not found|playwright install|install.*chromium/i.test(message);
}

export const __qaBrowserTestHooks = Object.freeze({
  acceptedUpsellProof,
  upsellAcceptStepFailures,
  commerceStructureAssertionFromEvidence,
  primaryCtaAssertionFromEvidence,
  isOrderUpsellsUrl,
  testEmail,
  testOrderPaths,
  TEST_ORDER_STEP_LADDER,
  createStepLadder,
  formatStepEvent,
  hostedRedirectInfo,
  redactUrlQuery,
  computedStyleResidueAssertions,
  logoResidueAssertion,
  methodPaymentArtifacts,
  referencedAssetBasenames,
  paymentChromeResidueAssertion,
  upsellPriceVisibilityAssertion,
  checkoutPriceVisibilityAssertion,
  placeholderTextResidueAssertion,
  demoAssetResidueAssertion,
  testOrderAssertion,
});
