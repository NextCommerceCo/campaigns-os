import { SEVERITY, STATUS } from "./qa-verdict.mjs";
import {
  analyticsCaptureError,
  projectAnalyticsCaptureError,
} from "./qa-analytics-errors.mjs";
import { attachAnalyticsCapture, diffAnalyticsParity } from "./qa-analytics-parity.mjs";
import { assessAnalyticsInventory } from "./qa-analytics-correctness.mjs";
import { redactUrlQuery } from "./qa-url-privacy.mjs";
import {
  commonTestOrderPaths,
  fullTestOrderPaths,
  pageAtUrl,
  remainingActionDisposition,
  resolveTestOrderTopology,
  terminalAtUrl,
} from "./qa-test-order-topology.mjs";
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
const ORDER_CREATE_RESPONSE_PATTERN = /\/api\/v1\/orders\/?(?:[?#].*)?$/i;
// Cart CREATE only. Anchored like the order patterns so a querystring still
// matches while sibling endpoints (notably /api/v1/carts/calculate/) do not —
// a repricing call is not evidence that a cart was created.
const CART_CREATE_RESPONSE_PATTERN = /\/api\/v1\/carts\/?(?:[?#].*)?$/i;

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

export async function runBrowserTestOrders(topologies, args = {}, runId = "local", options = {}) {
  const checkoutPage = findPage(topologies, "checkout");
  if (!checkoutPage?.url) {
    return {
      orders: [],
      receiptAnalytics: { plannedPlanIds: [], attempts: [] },
      journeyAnalytics: { plannedPlanIds: [], attempts: [] },
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

  // Resolve topology and enforce the accidental-flood cap before launching a
  // browser. Choosing exhaustive proof must never spend browser work only to
  // discover that the operator needs to raise --max-test-orders.
  const plans = testOrderPlans(args["test-order"], topologies, args);
  enforceTestOrderLimit(plans, args);
  const receiptAnalytics = {
    plannedPlanIds: plans.map((plan) => planId(plan)),
    attempts: [],
  };
  const journeyAnalytics = {
    plannedPlanIds: options.captureAnalytics ? plans.map((plan) => planId(plan)) : [],
    attempts: [],
  };

  const browser = await launchChromium(args);
  const context = await browser.newContext({
    viewport: viewportFromArgs(args),
    extraHTTPHeaders: args["auth-cookie"] ? { Cookie: String(args["auth-cookie"]) } : undefined,
  });

  const assertions = [];
  const orders = [];
  try {
    for (const plan of plans) {
      // Spec-driven plans name the checkout page that declares their tier or
      // coupon (multi-funnel specs); operator-mode plans drive the primary.
      const pageForPlan = (typeof plan === "object" && plan?.checkout_page?.url) ? plan.checkout_page : checkoutPage;
      const result = await runSingleBrowserTestOrder(context, pageForPlan, plan, args, runId, options);
      orders.push(result.order);
      receiptAnalytics.attempts.push(receiptAnalyticsAttempt(plan, result));
      if (options.captureAnalytics) journeyAnalytics.attempts.push(journeyAnalyticsAttempt(plan, result));
      assertions.push(testOrderAssertion(pageForPlan, plan, result));
      // Reconciliation and total parity are their own named assertions rather
      // than extra reasons for browser-test-order to fail: the order WAS
      // created, and collapsing "created" with "matches what was shown" is how
      // a mismatch ends up described as a checkout failure. Both carry blocker
      // severity, so the verdict still blocks.
      const displayParity = orderDisplayParityAssertion(pageForPlan, planId(plan), result.order);
      if (displayParity) assertions.push(displayParity);
      const totalParity = orderTotalParityAssertion(pageForPlan, planId(plan), result.order);
      if (totalParity) assertions.push(totalParity);
      const renderedReceiptAssertion = receiptRenderingAssertion(pageForPlan, planId(plan), result.order);
      if (renderedReceiptAssertion) assertions.push(renderedReceiptAssertion);
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
      evidence: { planned_paths: plans.map((plan) => planId(plan)), completed_paths: orders.map((order) => order.plan_id || order.path) },
    }));
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return { orders, assertions, receiptAnalytics, journeyAnalytics };
}

// Analytics-parity leg: capture the live dataLayer event stream + GTM/pixel
// tag-fires on a baseline (legacy) URL and a candidate (migrated) URL, then
// diff them into parity assertions. Highest-value target is the thank-you /
// receipt page, where dl_purchase fires — pass receipt URLs for both, or drive
// the same offer through each funnel so the values line up (see the PARITY QA
// phase of the campaignsjs→SDK-0.4.x migration doctrine).
// `options.target` is the capture target resolved from the campaign's
// identity (public_route_slug + route_root) in qa-node — packet 01 / INV-2:
// the candidate URL is never read from a raw --base-url again.
// --analytics-candidate survives for ONE narrow purpose: the receipt-capture
// pairing documented above needs an explicit candidate receipt URL paired
// with --analytics-baseline's legacy receipt, and identity resolution cannot
// derive a receipt page yet (receipt-aware capture is out of packet 01's
// scope). Absent that override, the candidate IS the resolved target.
function analyticsParityCaptureAssertions({ baseline, candidate, baselineUrl, candidateUrl }) {
  const baselinePublicUrl = redactUrlQuery(baselineUrl);
  const candidatePublicUrl = redactUrlQuery(candidateUrl);
  const analyticsPage = { page_id: "analytics", url: candidatePublicUrl || baselinePublicUrl || undefined };
  const assertions = diffAnalyticsParity(baseline, candidate, { url: candidatePublicUrl });
  assertions.unshift(assertion({
    id: "analytics-parity:capture",
    family: "analytics-parity",
    page: analyticsPage,
    status: STATUS.PASS,
    expected: "live dataLayer + tag-fire capture on baseline and candidate",
    actual: `baseline events=${baseline.eventNames.length}, candidate events=${candidate.eventNames.length}`,
    evidence: {
      url: candidatePublicUrl,
      baseline_url: baselinePublicUrl,
      candidate_url: candidatePublicUrl,
      baseline_event_count: baseline.eventNames.length,
      candidate_event_count: candidate.eventNames.length,
      baseline_inventory: Object.fromEntries(Object.entries(baseline.inventory).map(([k, v]) => [k, v.length])),
      candidate_inventory: Object.fromEntries(Object.entries(candidate.inventory).map(([k, v]) => [k, v.length])),
    },
  }));
  return assertions;
}

function analyticsParityRunnerFailureAssertion({ baselineUrl, candidateUrl, error }) {
  const baselinePublicUrl = redactUrlQuery(baselineUrl);
  const candidatePublicUrl = redactUrlQuery(candidateUrl);
  const captureError = projectAnalyticsCaptureError(error, { fallbackKind: "unreadable" });
  return assertion({
    id: "analytics-parity:runner",
    family: "analytics-parity",
    page: { page_id: "analytics", url: candidatePublicUrl || baselinePublicUrl || undefined },
    status: STATUS.FAIL,
    severity: SEVERITY.BLOCKER,
    expected: "analytics-parity capture completes on both URLs",
    actual: captureError.message,
    evidence: {
      url: candidatePublicUrl,
      baseline_url: baselinePublicUrl,
      candidate_url: candidatePublicUrl,
      error_code: captureError.code,
    },
  });
}

export async function runAnalyticsParityChecks(args = {}, options = {}) {
  const baselineUrl = trim(args["analytics-baseline"]) || null;
  const candidateUrl = trim(args["analytics-candidate"]) || trim(options.target?.url) || null;
  const baselinePublicUrl = redactUrlQuery(baselineUrl);
  const candidatePublicUrl = redactUrlQuery(candidateUrl);
  const analyticsPage = { page_id: "analytics", url: candidatePublicUrl || baselinePublicUrl || undefined };

  if (!baselineUrl || !candidateUrl) {
    return [assertion({
      id: "analytics-parity:inputs",
      family: "analytics-parity",
      page: analyticsPage,
      status: STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      expected: "both --analytics-baseline <legacy-url> and a candidate URL (the campaign's resolved capture target, or an explicit --analytics-candidate receipt override)",
      actual: `baseline=${baselinePublicUrl || "missing"}, candidate=${candidatePublicUrl || "missing"}`,
      ...(candidatePublicUrl ? { evidence: { url: candidatePublicUrl } } : {}),
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
    return analyticsParityCaptureAssertions({ baseline, candidate, baselineUrl, candidateUrl });
  } catch (error) {
    return [analyticsParityRunnerFailureAssertion({ baselineUrl, candidateUrl, error })];
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// Analytics CORRECTNESS inventory leg: capture ONE campaign-root page and
// assess only declared tags/pixels. Purchase is finalized later from the
// canonical typed-card order's recognized receipt; this root visit is never
// treated as Purchase authority.
// `options.target` is the capture target resolved from the campaign's
// identity (public_route_slug + route_root) in qa-node — packet 01 / INV-2:
// this leg no longer reads --analytics-candidate or --base-url; the URL it
// visits is a function of resolved identity, recorded on every assertion.
function analyticsCorrectnessCaptureAssertions({ capture, contract, url }) {
  const publicUrl = redactUrlQuery(url);
  const analyticsPage = { page_id: "analytics", url: publicUrl || undefined };
  const assertions = assessAnalyticsInventory(capture, contract || {}, { url: publicUrl });
  assertions.unshift(assertion({
    id: "analytics-correctness:capture",
    family: "analytics-correctness",
    page: analyticsPage,
    status: STATUS.PASS,
    expected: "live dataLayer + tag-fire capture on the candidate page",
    actual: `events=${capture.eventNames.length}, tags=${Object.values(capture.inventory).flat().length}`,
    // Counts only. Root capture is provider/tag inventory, never Purchase
    // authority, even if a stray Purchase happens to appear there.
    evidence: {
      url: publicUrl,
      event_count: capture.eventNames.length,
      inventory: Object.fromEntries(Object.entries(capture.inventory).map(([k, v]) => [k, v.length])),
    },
  }));
  return assertions;
}

function analyticsCorrectnessRunnerFailureAssertion({ url, error }) {
  const publicUrl = redactUrlQuery(url);
  const captureError = projectAnalyticsCaptureError(error, { fallbackKind: "unreadable" });
  return assertion({
    id: "analytics-correctness:runner",
    family: "analytics-correctness",
    page: { page_id: "analytics", url: publicUrl || undefined },
    status: STATUS.FAIL,
    severity: SEVERITY.BLOCKER,
    expected: "analytics-correctness capture completes",
    actual: captureError.message,
    evidence: { url: publicUrl, error_code: captureError.code },
  });
}

export async function runAnalyticsCorrectnessChecks(args = {}, contract = {}, options = {}) {
  const url = trim(options.target?.url) || null;
  const correctnessPage = { page_id: "analytics", url: redactUrlQuery(url) || undefined };
  if (!url) {
    return [assertion({
      id: "analytics-correctness:inputs",
      family: "analytics-correctness",
      page: correctnessPage,
      status: STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      expected: "a capture target resolved from the campaign's identity (public_route_slug + route_root composed onto --base-url or the packet deploy URL)",
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
    return analyticsCorrectnessCaptureAssertions({ capture, contract, url });
  } catch (error) {
    return [analyticsCorrectnessRunnerFailureAssertion({ url, error })];
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

export async function captureAnalyticsForUrl(context, url, args, extraHosts = []) {
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

// Batch wrapper used by fixture-driven parity capture. Browser ownership stays
// in this module so callers reuse the established Playwright launch/context
// policy instead of importing or reimplementing it.
export async function captureAnalyticsForUrls(urls = {}, args = {}) {
  const browser = await launchChromium(args);
  const context = await browser.newContext({
    viewport: viewportFromArgs(args),
    extraHTTPHeaders: args["auth-cookie"] ? { Cookie: String(args["auth-cookie"]) } : undefined,
  });
  const extraHosts = analyticsExtraHosts(args);
  try {
    const captures = {};
    for (const [name, url] of Object.entries(urls)) {
      if (url) captures[name] = await captureAnalyticsForUrl(context, url, args, extraHosts);
    }
    return captures;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
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
      assertions.push(...await checkoutOfferSurfaceAssertions(browserPage, page));
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

// --- Declared checkout offer surfaces (exit_intent / promo_code_input) ---
// CampaignSpec declares these on the checkout page and the QA contract says
// browser QA drives them. Until #271 nothing asserted them at all, so a
// campaign could declare `exit_intent` with an offer code, ship no exit-intent
// markup whatsoever, and collect a clean verdict: the absence of a check read
// as a pass. These assertions exist so a declared surface that was never built
// is a blocker, and a surface that is built but cannot be proven wired to the
// declared code is visible rather than silent.

// Exit-intent markup lives inside a <template> until the pop is triggered, so
// presence is a DOM-tree question, not a visibility one. The starter families
// ship `<template data-template="exit-intent">` wrapping `.exit-intent-popup`
// with a `[data-exit-intent-action="apply-coupon"][data-coupon-code]` CTA;
// the looser class/id selectors catch hand-rolled equivalents.
const EXIT_INTENT_SURFACE_SELECTORS = Object.freeze([
  'template[data-template="exit-intent"]',
  "[data-exit-intent-action]",
  "[data-next-exit-intent]",
  "#exit-intent-popup",
  ".exit-intent-popup",
  '[class*="exit-intent"]',
]);

// Where a built surface exposes the offer code it will apply. Reading it is
// what separates "the pop exists" from "the pop applies the declared offer".
const OFFER_CODE_ATTRIBUTES = Object.freeze([
  "data-coupon-code",
  "data-next-coupon-code",
  "data-offer-code",
  "data-next-offer-code",
]);

function declaredOfferSurface(page, surface) {
  const block = page?.[surface];
  if (!block || typeof block !== "object" || block.enabled !== true) return null;
  return { surface, offer_code: stringArg(block.offer_code) || null };
}

async function checkoutOfferSurfaceAssertions(browserPage, page) {
  const assertions = [];
  const exitIntent = declaredOfferSurface(page, "exit_intent");
  if (exitIntent) {
    const evidence = await offerSurfaceEvidence(browserPage, EXIT_INTENT_SURFACE_SELECTORS);
    assertions.push(exitIntentSurfaceAssertion({ page, declaration: exitIntent, evidence }));
  }
  const promoCodeInput = declaredOfferSurface(page, "promo_code_input");
  if (promoCodeInput) {
    const evidence = await offerSurfaceEvidence(browserPage, COUPON_INPUT_SELECTORS);
    assertions.push(promoCodeSurfaceAssertion({ page, declaration: promoCodeInput, evidence }));
  }
  return assertions;
}

// Counts matches in the live document AND inside every <template> content
// fragment. `document.querySelectorAll` does not descend into template content,
// and correctly built exit-intent markup lives nowhere else before the pop
// fires — scanning the document alone would report a wired pop as missing.
async function offerSurfaceEvidence(browserPage, selectors) {
  return browserPage.evaluate((input) => {
    const isVisible = (element) => {
      if (!element.getBoundingClientRect) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden";
    };
    const roots = [document, ...Array.from(document.querySelectorAll("template")).map((node) => node.content)];
    const matched = new Set();
    const matchedSelectors = [];
    let visibleCount = 0;
    for (const selector of input.selectors) {
      let selectorHits = 0;
      for (const root of roots) {
        let found = [];
        try {
          found = Array.from(root.querySelectorAll(selector));
        } catch {
          // An invalid selector is a bug in this list, not in the campaign.
          continue;
        }
        for (const element of found) {
          if (matched.has(element)) continue;
          matched.add(element);
          selectorHits += 1;
          // Elements inside template content are not laid out, so they are
          // never "visible" — that is the expected state for exit intent.
          if (root === document && isVisible(element)) visibleCount += 1;
        }
      }
      if (selectorHits) matchedSelectors.push(selector);
    }
    const codes = new Set();
    for (const element of matched) {
      for (const attribute of input.codeAttributes) {
        const value = element.getAttribute?.(attribute);
        if (value && value.trim()) codes.add(value.trim());
      }
      for (const attribute of input.codeAttributes) {
        let carriers = [];
        try {
          carriers = Array.from(element.querySelectorAll?.(`[${attribute}]`) || []);
        } catch {
          carriers = [];
        }
        for (const carrier of carriers) {
          const value = carrier.getAttribute(attribute);
          if (value && value.trim()) codes.add(value.trim());
        }
      }
    }
    return {
      match_count: matched.size,
      visible_count: visibleCount,
      matched_selectors: matchedSelectors,
      offer_codes: [...codes].slice(0, 10),
    };
  }, { selectors: [...selectors], codeAttributes: [...OFFER_CODE_ATTRIBUTES] })
    .catch((error) => ({
      match_count: 0,
      visible_count: 0,
      matched_selectors: [],
      offer_codes: [],
      collector_error: error instanceof Error ? error.message : String(error),
    }));
}

function offerCodeWired(declaredCode, foundCodes) {
  if (!declaredCode) return false;
  return (foundCodes || []).some((code) => normalizeLabel(code) === normalizeLabel(declaredCode));
}

function exitIntentSurfaceAssertion({ page, declaration, evidence }) {
  const selectors = [...EXIT_INTENT_SURFACE_SELECTORS];
  const base = {
    id: `browser-exit-intent-surface:${page.page_id}`,
    family: "browser-runtime",
    page,
    expected: declaration.offer_code
      ? `rendered exit-intent surface wired to declared offer code ${declaration.offer_code}`
      : "rendered exit-intent surface for the declared checkout exit_intent",
  };
  const evidenceBlock = {
    declared: declaration,
    selectors,
    ...evidence,
    next_step: "Include the family's exit-intent partial on the checkout page and wire it to the mapped offer code through the SDK coupon path, or drop exit_intent from CampaignSpec.",
  };
  if (evidence.collector_error) {
    // The collector did not find nothing; it could not look. Reporting that as
    // an absent surface would be the exact silent-failure shape these
    // assertions exist to remove, one level up.
    return assertion({
      ...base,
      status: STATUS.SKIPPED,
      actual: `exit-intent surface could not be read: ${evidence.collector_error}`,
      evidence: evidenceBlock,
    });
  }
  if (!evidence.match_count) {
    // Declared and absent. The spec promises the shopper an offer that the
    // built page cannot deliver, so this blocks rather than warns.
    return assertion({
      ...base,
      status: STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      actual: "no exit-intent markup found in the rendered document or any <template> content",
      evidence: evidenceBlock,
    });
  }
  if (offerCodeWired(declaration.offer_code, evidence.offer_codes)) {
    return assertion({
      ...base,
      status: STATUS.PASS,
      actual: `exit-intent markup present (${evidence.match_count} node(s)) carrying offer code ${declaration.offer_code}`,
      evidence: evidenceBlock,
    });
  }
  // Present but the mapped code cannot be read off the markup: the pop may
  // still apply it from page JS. Real enough to surface, not proven broken.
  return assertion({
    ...base,
    status: STATUS.MANUAL_REVIEW,
    severity: SEVERITY.WARN,
    actual: declaration.offer_code
      ? `exit-intent markup present (${evidence.match_count} node(s)) but no offer-code hook matching ${declaration.offer_code}${evidence.offer_codes.length ? ` (found ${evidence.offer_codes.join(", ")})` : ""}`
      : `exit-intent markup present (${evidence.match_count} node(s)); CampaignSpec declares no offer_code to verify against`,
    evidence: evidenceBlock,
  });
}

function promoCodeSurfaceAssertion({ page, declaration, evidence }) {
  const selectors = [...COUPON_INPUT_SELECTORS];
  const base = {
    id: `browser-promo-code-surface:${page.page_id}`,
    family: "browser-runtime",
    page,
    expected: "rendered promo/coupon code input on the checkout page for the declared promo_code_input",
  };
  const evidenceBlock = {
    declared: declaration,
    selectors,
    ...evidence,
    next_step: "Render a coupon/promo input on checkout and apply the mapped offer code through the SDK coupon path, or drop promo_code_input from CampaignSpec.",
  };
  if (evidence.collector_error) {
    // The collector did not find nothing; it could not look. Reporting that as
    // an absent surface would be the exact silent-failure shape these
    // assertions exist to remove, one level up.
    return assertion({
      ...base,
      status: STATUS.SKIPPED,
      actual: `promo/coupon code surface could not be read: ${evidence.collector_error}`,
      evidence: evidenceBlock,
    });
  }
  if (!evidence.match_count) {
    return assertion({
      ...base,
      status: STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      actual: "no coupon/promo code input found on the checkout page",
      evidence: evidenceBlock,
    });
  }
  if (evidence.visible_count > 0) {
    return assertion({
      ...base,
      status: STATUS.PASS,
      actual: `${evidence.visible_count} visible coupon/promo input(s) (${evidence.matched_selectors.join(", ")})`,
      evidence: evidenceBlock,
    });
  }
  // A collapsed "Have a coupon?" disclosure is the common shape here, and the
  // typed-card runner reveals it before typing. Present-but-hidden is not
  // provably broken from a static page read.
  return assertion({
    ...base,
    status: STATUS.MANUAL_REVIEW,
    severity: SEVERITY.WARN,
    actual: `${evidence.match_count} coupon/promo input(s) present but none visible; the surface may sit behind a disclosure control`,
    evidence: evidenceBlock,
  });
}

// --- Template brand residue + pricing visibility (template-brand-contract driven) ---
// Browser collectors gather raw computed-style/visibility evidence; pure
// functions below turn that evidence into assertions so the decisions are
// testable without Playwright.

// Template-owned commerce pages. "select" is the two-step bundle-selection
// step: it is template-owned and SDK-driven, so the brand contracts already
// scope logo and computed-style residue to it — that scoping was inert until
// "select" became a real page type, because no spec-valid page could carry it.
const RESIDUE_PAGE_TYPES = ["checkout", "select", "upsell", "downsell", "receipt"];

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
  "coupon_applied",
  "card_fields_filled",
  "cart_created",
  "hosted_redirect_observed",
  "order_submitted",
  "upsell_action",
  "receipt_reached",
  "receipt_rendered",
]);

function formatStepEvent(entry) {
  return `[qa:test-order] step=${entry.step} status=${entry.status} ${entry.duration_ms}ms`;
}

// Cart-API observation for the cart_created step. The old check was a boolean
// "did any URL contain /carts/" probe, which both told the reader nothing and
// counted /carts/calculate/ repricing calls as cart creation. This reports what
// the API actually said: the most recent create response's status and, when the
// body exposes them, how many lines the cart holds.
function cartLineCount(body) {
  if (!body || typeof body !== "object") return null;
  const candidates = [body.lines, body.items, body.cart?.lines, body.cart?.items, body.data?.lines, body.data?.items];
  const lines = candidates.find((value) => Array.isArray(value));
  return Array.isArray(lines) ? lines.length : null;
}

function cartCreationEvidence(events) {
  const responses = (events?.responses || []).filter((response) => CART_CREATE_RESPONSE_PATTERN.test(String(response?.url || "")));
  if (!responses.length) return null;
  // Last create wins, matching how rejectedOrderCreateResponse reads retries.
  const latest = responses[responses.length - 1];
  const status = Number(latest.status);
  const lineCount = cartLineCount(latest.body);
  return {
    endpoint: "cart_create",
    status: Number.isFinite(status) ? status : null,
    ok: Number.isFinite(status) ? status >= 200 && status < 300 : null,
    ...(lineCount === null ? {} : { line_count: lineCount }),
    response_count: responses.length,
    url: redactUrlQuery(latest.url),
  };
}

// Customer/address-field trace. Deliberately NOT named a checkout-field trace:
// it covers the customer and shipping/billing address fields reached through
// [data-next-checkout-field], and does NOT cover payment entry — the card
// number and CVV live in cross-origin Spreedly iframes this trace never sees.
//
// An entry is appended BEFORE its action runs and mutated in place after, so a
// step that times out mid-action leaves the offending field visible as the one
// still marked "pending". That is what turns "customer_fields_filled timed out"
// into "it was hanging on postal".
function createFieldTrace() {
  const fields = [];
  return {
    fields,
    async inspect(field, action, fn, { optional = false } = {}) {
      const entry = { field, action, status: "pending", optional, duration_ms: 0 };
      fields.push(entry);
      const startedMs = Date.now();
      try {
        const result = await fn();
        entry.duration_ms = Date.now() - startedMs;
        // An optional field that reported unusable returns false rather than
        // throwing; that is best-effort success for the step, not a failure.
        entry.status = result === false ? "unusable" : "ok";
        return result;
      } catch (error) {
        entry.duration_ms = Date.now() - startedMs;
        entry.status = "failed";
        entry.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
    // Shaped for a verdict reader: the blocking field first, then the counts.
    summary() {
      const blocking = fields.find((entry) => entry.status === "failed")
        || fields.find((entry) => entry.status === "pending")
        || null;
      return {
        coverage: "customer_and_address_fields",
        fields: fields.map((entry) => ({ ...entry })),
        field_count: fields.length,
        ...(blocking ? { blocking_field: blocking.field, blocking_status: blocking.status } : {}),
      };
    },
  };
}

// Incremental evidence for one post-purchase action. The trace is created
// before the bounded ladder step starts and updated before each operation that
// can hang. Its synchronous summary survives when the timeout wins the race.
function createUpsellActionTrace({ page, events, topologyPlan, stepIndex, path, inspectTimeoutMs = 1000 }) {
  const requestedAction = path === "accept" ? "add" : "skip";
  const selector = `[data-next-upsell-action="${requestedAction}"]`;
  let actionNavigationCount = Array.isArray(events?.navigations) ? events.navigations.length : 0;
  let actionUpsellRequestCount = (events?.requests || []).filter((request) => isOrderUpsellsUrl(request?.url)).length;
  let element = { present: null, visible: null, enabled: null };
  let sdk = { window_next_present: null, display_ready: null, sdk_loading: null };
  let clickAttempted = false;
  let clickCompleted = false;
  let stepCompleted = false;

  const inspect = async () => {
    const control = page.locator(selector).first();
    const count = await control.count().catch(() => 0);
    element = {
      present: count > 0,
      visible: count > 0 ? await control.isVisible().catch(() => false) : false,
      enabled: count > 0 ? await control.isEnabled().catch(() => false) : false,
    };
    sdk = await settleDiagnosticWithin(page.evaluate(() => ({
      window_next_present: Boolean(window.next),
      display_ready: document.documentElement.classList.contains("next-display-ready"),
      sdk_loading: document.body?.getAttribute("data-next-sdk-loading") ?? null,
    })), inspectTimeoutMs, sdk);
    return summary();
  };

  const snapshot = () => {
    const currentUrl = redactUrlQuery(safePageUrl(page));
    const routePage = pageAtUrl(topologyPlan, currentUrl);
    const navigations = Array.isArray(events?.navigations) ? events.navigations : [];
    const upsellRequests = (events?.requests || []).filter((request) => isOrderUpsellsUrl(request?.url));
    const navigationObserved = navigations.length > actionNavigationCount;
    const apiRequestObserved = upsellRequests.length > actionUpsellRequestCount;
    const basis = [
      ...(navigationObserved ? ["navigation"] : []),
      ...(apiRequestObserved ? ["upsell_api_request"] : []),
    ];
    const lastNavigation = navigations.at(-1);
    const lastUpsellRequest = upsellRequests.at(-1);
    return {
      route: {
        page_id: routePage?.page_id || null,
        page_type: routePage?.page_type || null,
        url: currentUrl,
      },
      edge_index: stepIndex,
      edge_number: stepIndex + 1,
      requested_action: requestedAction,
      selector,
      element: { ...element },
      sdk: { ...sdk },
      action_binding: {
        click_attempted: clickAttempted,
        click_completed: clickCompleted,
        observed: basis.length > 0,
        basis,
      },
      last_navigation: lastNavigation?.url
        ? { url: redactUrlQuery(lastNavigation.url) }
        : currentUrl
          ? { url: currentUrl }
          : null,
      last_upsell_api_request: lastUpsellRequest
        ? { method: lastUpsellRequest.method || null, url: redactUrlQuery(lastUpsellRequest.url) }
        : null,
    };
  };

  // Successful actions keep the established compact ladder shape. The trace
  // is failure evidence, not routine verdict noise.
  const summary = () => stepCompleted ? null : snapshot();

  const formatError = (error) => {
    const evidence = snapshot();
    const state = evidence.element;
    const sdkState = evidence.sdk;
    const lastNavigation = evidence.last_navigation?.url || "none";
    const lastRequest = evidence.last_upsell_api_request
      ? `${evidence.last_upsell_api_request.method || "(method unknown)"} ${evidence.last_upsell_api_request.url}`
      : "none";
    return [
      error instanceof Error ? error.message : String(error),
      `route=${evidence.route.url || "unknown"}`,
      `page_id=${evidence.route.page_id || "unknown"}`,
      `edge=${evidence.edge_number}`,
      `action=${evidence.requested_action}`,
      `selector=${evidence.selector}`,
      `element=present:${state.present},visible:${state.visible},enabled:${state.enabled}`,
      `sdk=window_next:${sdkState.window_next_present},display_ready:${sdkState.display_ready},loading:${sdkState.sdk_loading}`,
      `binding_observed=${evidence.action_binding.observed}`,
      `last_navigation=${lastNavigation}`,
      `last_upsell_api_request=${lastRequest}`,
    ].join("; ");
  };

  return {
    inspect,
    summary,
    formatError,
    markClickAttempted: () => {
      clickAttempted = true;
      actionNavigationCount = Array.isArray(events?.navigations) ? events.navigations.length : 0;
      actionUpsellRequestCount = (events?.requests || []).filter((request) => isOrderUpsellsUrl(request?.url)).length;
    },
    markClickCompleted: () => { clickCompleted = true; },
    markStepCompleted: () => { stepCompleted = true; },
  };
}

async function settleDiagnosticWithin(promise, timeoutMs, fallback) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Structured step evidence. Callers pass either an object or a thunk; a thunk
// is resolved at record time so a step that fails or times out still reports
// what it had gathered up to the failure (that is the whole point — the field
// trace is only useful on the path that broke). A thunk that throws yields no
// evidence rather than masking the step's own error.
function resolveStepEvidence(evidence) {
  let value = evidence;
  if (typeof evidence === "function") {
    try {
      value = evidence();
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.keys(value).length ? value : null;
}

function createStepLadder({ emit = (line) => process.stderr.write(`${line}\n`), now = () => Date.now() } = {}) {
  const steps = [];
  const record = (step, status, { startedAt = null, durationMs = 0, detail = null, error = null, evidence = null } = {}) => {
    const resolvedEvidence = resolveStepEvidence(evidence);
    const entry = {
      step,
      status,
      started_at: startedAt || new Date(now()).toISOString(),
      duration_ms: Math.max(0, Math.round(durationMs)),
      ...(detail ? { detail } : {}),
      ...(resolvedEvidence ? { evidence: resolvedEvidence } : {}),
      ...(error ? { error } : {}),
    };
    steps.push(entry);
    emit(formatStepEvent(entry));
    return entry;
  };
  return {
    steps,
    has: (step) => steps.some((entry) => entry.step === step),
    ok: (step, detail = null, evidence = null) => record(step, "ok", { detail, evidence }),
    fail: (step, error, detail = null, evidence = null) => record(step, "failed", { error, detail, evidence }),
    skip: (step, reason, evidence = null) => record(step, "skipped", { detail: reason, evidence }),
    // Run a step with a bounded timeout. A resolved string becomes the step
    // detail; a resolved { skip } object records the step as skipped.
    async run(step, fn, { timeoutMs, detail = null, evidence = null, formatError = null } = {}) {
      const startedMs = now();
      const startedAt = new Date(startedMs).toISOString();
      try {
        const value = await withStepTimeout(fn(), timeoutMs, step);
        // A step may return its own evidence alongside a detail string; an
        // explicit option still wins so callers keep a stable seam.
        const returnedEvidence = value && typeof value === "object" && !Array.isArray(value) ? value.evidence : null;
        if (value && typeof value === "object" && typeof value.skip === "string") {
          record(step, "skipped", { startedAt, durationMs: now() - startedMs, detail: value.skip, evidence: evidence || returnedEvidence });
          return value;
        }
        const returnedDetail = value && typeof value === "object" && typeof value.detail === "string" ? value.detail : null;
        record(step, "ok", {
          startedAt,
          durationMs: now() - startedMs,
          detail: typeof value === "string" ? value : returnedDetail || detail,
          evidence: evidence || returnedEvidence,
        });
        return value;
      } catch (error) {
        const formatted = formatStepError(error, formatError);
        const timedOut = formatted.error?.code === "step_timeout";
        record(step, timedOut ? "timeout" : "failed", {
          startedAt,
          durationMs: now() - startedMs,
          detail,
          evidence,
          error: formatted.message,
        });
        throw formatted.error;
      }
    },
  };
}

function formatStepError(error, formatter) {
  const originalMessage = error instanceof Error ? error.message : String(error);
  if (typeof formatter !== "function") return { error, message: originalMessage };
  let message = originalMessage;
  try {
    const candidate = formatter(error);
    if (typeof candidate === "string" && candidate.trim()) message = candidate.trim();
  } catch {
    return { error, message: originalMessage };
  }
  if (message === originalMessage) return { error, message };
  if (error instanceof Error) {
    error.message = message;
    return { error, message };
  }
  const formatted = new Error(message);
  if (error?.code) formatted.code = error.code;
  if (error?.hostedRedirect) formatted.hostedRedirect = error.hostedRedirect;
  return { error: formatted, message };
}

function recordTestOrderTerminalEvidence({ ladder, topologyPlan, finalUrl }) {
  const terminal = terminalAtUrl(topologyPlan, finalUrl);
  if (terminal?.kind === "receipt" || (!topologyPlan && /receipt|thank/i.test(finalUrl))) {
    ladder.ok("receipt_reached", redactUrlQuery(finalUrl));
    return { kind: "receipt", terminal };
  }
  if (terminal?.kind === "external_handoff") {
    ladder.skip("receipt_reached", `path ended at recognized external handoff ${redactUrlQuery(finalUrl)}`);
    return { kind: "external_handoff", terminal };
  }
  ladder.skip("receipt_reached", `path ended at ${redactUrlQuery(finalUrl) || "(unknown url)"}`);
  return { kind: "unrecognized", terminal: null };
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

async function runWithinAnalyticsDeadline(operation, { deadline, now }) {
  const remainingMs = deadline - now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return { timedOut: true };
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function collectOrderAnalytics({
  captureHandle,
  receiptRecognized,
  settleMs,
  deadline,
  now = () => Date.now(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const result = {};
  if (!captureHandle) return result;

  let settleError = null;
  let deadlineConsumed = false;
  const requestedSettleMs = Math.max(0, Number.isFinite(settleMs) ? settleMs : DEFAULT_SETTLE_TIMEOUT_MS);
  if (receiptRecognized) {
    const remainingMs = deadline - now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      settleError = analyticsCaptureError("settleDeadline");
      deadlineConsumed = true;
    } else if (requestedSettleMs > remainingMs) {
      settleError = analyticsCaptureError("settleDeadline");
    } else {
      const settling = await runWithinAnalyticsDeadline(
        () => wait(requestedSettleMs),
        { deadline, now },
      );
      if (settling.timedOut || now() > deadline) {
        settleError = analyticsCaptureError("settleDeadline");
        deadlineConsumed = true;
      } else if (settling.error) {
        settleError = analyticsCaptureError("settle");
      }
    }
  }

  const collection = deadlineConsumed
    ? { timedOut: true }
    : await runWithinAnalyticsDeadline(async () => (
      typeof captureHandle.collectScopes === "function"
        ? captureHandle.collectScopes({ strict: true })
        : {
            journey: await captureHandle.collect({ strict: true }),
            currentDocument: await captureHandle.collect({ strict: true, scope: "current-document" }),
          }
    ), { deadline, now });
  if (collection.timedOut || now() > deadline) {
    result.journeyCaptureError = analyticsCaptureError("collectionDeadline");
    if (receiptRecognized && !settleError) {
      result.receiptCaptureError = analyticsCaptureError("collectionDeadline");
    }
  } else if (collection.error) {
    result.journeyCaptureError = analyticsCaptureError("unreadable");
    if (receiptRecognized && !settleError) result.receiptCaptureError = analyticsCaptureError("unreadable");
  } else {
    result.journeyCapture = collection.value.journey;
    if (receiptRecognized && !settleError) result.receiptCapture = collection.value.currentDocument;
  }
  if (receiptRecognized && settleError) result.receiptCaptureError = settleError;
  return result;
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

async function runSingleBrowserTestOrder(context, checkoutPage, plan, args, runId, options = {}) {
  const normalizedPlan = normalizeTestOrderPlan(plan, args);
  const planArgs = argsForPlan(args, normalizedPlan);
  const path = normalizedPlan.path;
  const orderTimeoutMs = numberArg(planArgs["order-timeout-ms"], DEFAULT_ORDER_TIMEOUT_MS);
  const ladder = createStepLadder();
  let page = null;
  let analyticsCapture = null;
  let analyticsAttachError = null;
  let orderDeadline = null;
  let events = { requests: [], responses: [], failed: [], console: [], pageErrors: [] };
  const email = testEmail(planArgs);
  const finalizeResult = async (result) => {
    const finalUrl = result?.order?.final_url || null;
    const receiptRecognized = terminalAtUrl(normalizedPlan.topology_plan, finalUrl)?.kind === "receipt";
    if (analyticsCapture) {
      const captures = await collectOrderAnalytics({
        captureHandle: analyticsCapture,
        receiptRecognized,
        settleMs: numberArg(planArgs["analytics-settle"], DEFAULT_SETTLE_TIMEOUT_MS),
        deadline: orderDeadline ?? Date.now(),
      });
      if (captures.journeyCapture) result.analytics_journey_capture = captures.journeyCapture;
      if (captures.journeyCaptureError) result.analytics_journey_capture_error = captures.journeyCaptureError;
      if (captures.receiptCapture) result.receipt_analytics_capture = captures.receiptCapture;
      if (captures.receiptCaptureError) result.receipt_analytics_capture_error = captures.receiptCaptureError;
    } else if (analyticsAttachError) {
      result.analytics_journey_capture_error = analyticsAttachError;
      if (receiptRecognized) result.receipt_analytics_capture_error = analyticsAttachError;
    }
    return stampTestOrderPlan(result, normalizedPlan);
  };

  try {
    page = await context.newPage();
    if (options.captureAnalytics) {
      try {
        analyticsCapture = await attachAnalyticsCapture(page, { extraHosts: analyticsExtraHosts(planArgs) });
      } catch {
        // Analytics instrumentation must never consume the one canonical order
        // attempt. Continue the order and surface this as an explicit receipt
        // capture blocker instead of manufacturing a zero-signal capture.
        analyticsAttachError = analyticsCaptureError("attach");
      }
    }
    page.setDefaultTimeout(numberArg(planArgs["browser-timeout"], DEFAULT_BROWSER_TIMEOUT_MS));
    events = captureCheckoutEvents(page);
    // The outer race is the hard guarantee: whatever hangs inside the path,
    // this returns and the run writes a verdict instead of dying with nothing.
    orderDeadline = Date.now() + orderTimeoutMs;
    const result = await withStepTimeout(
      executeTestOrderPath({
        page,
        events,
        email,
        ladder,
        checkoutPage,
        topologyPlan: normalizedPlan.topology_plan,
        path,
        args: planArgs,
        deadline: orderDeadline,
      }),
      orderTimeoutMs + ORDER_TIMEOUT_GRACE_MS,
      `order-path:${planId(normalizedPlan)}`,
    );
    return await finalizeResult(result);
  } catch (error) {
    const result = failedTestOrderResult({ path, email, error, events, ladder, page });
    return await finalizeResult(result);
  } finally {
    analyticsCapture?.detach();
    await page?.close().catch(() => {});
  }
}

function stampTestOrderPlan(result, plan) {
  if (result?.order) {
    result.order.plan_id = planId(plan);
    if (plan?.source) result.order.plan = summarizeTestOrderPlan(plan);
  }
  return result;
}

// Convert the browser runner's private result into the private receipt capture
// envelope. Receipt recognition delegates exclusively to the topology module's
// canonical terminal classifier; this layer never guesses from URL text.
function receiptAnalyticsAttempt(plan, result) {
  const id = planId(plan);
  const finalUrl = result?.order?.final_url || null;
  const topologyPlan = typeof plan === "object" ? plan?.topology_plan : null;
  const terminal = terminalAtUrl(topologyPlan, finalUrl);
  const receiptRecognized = terminal?.kind === "receipt";
  return {
    planId: id,
    receiptRecognized,
    receiptUrl: redactUrlQuery(finalUrl),
    ...(receiptRecognized && result?.receipt_analytics_capture
      ? { capture: result.receipt_analytics_capture }
      : {}),
    ...(receiptRecognized && result?.receipt_analytics_capture_error
      ? { captureError: stablePrivateCaptureError(result.receipt_analytics_capture_error) }
      : {}),
  };
}

function journeyAnalyticsAttempt(plan, result) {
  return {
    planId: planId(plan),
    ...(result?.analytics_journey_capture ? { capture: result.analytics_journey_capture } : {}),
    ...(result?.analytics_journey_capture_error
      ? { captureError: stablePrivateCaptureError(result.analytics_journey_capture_error) }
      : {}),
  };
}

function stablePrivateCaptureError(value) {
  return projectAnalyticsCaptureError(value, { fallbackKind: "unreadable" });
}

async function executeTestOrderPath({ page, events, email, ladder, checkoutPage, topologyPlan, path, args, deadline }) {
  const stepTimeoutMs = numberArg(args["step-timeout-ms"], DEFAULT_STEP_TIMEOUT_MS);
  const budget = () => Math.min(stepTimeoutMs, deadline - Date.now());
  const hostedNow = () => hostedRedirectInfo(safePageUrl(page), checkoutPage.url);
  let checkoutDisplay = null;

  await ladder.run("opened_checkout", () => gotoAndSettle(page, checkoutPage.url, args), { timeoutMs: budget() });
  await ladder.run("selected_bundle", async () => {
    const strictSelection = await selectRequestedPackages(page, args);
    await selectRequestedCart(page, args);
    await advanceToCheckoutForm(page);
    if (strictSelection) return `selected requested package card(s): ${strictSelection}`;
    return parseCart(args.cart).length ? `requested cart ${args.cart}` : "default bundle selection";
  }, { timeoutMs: budget() });
  await ladder.run("bump_state", async () => {
    const bump = await checkoutOrderBumpEvidence(page);
    if (!bump.toggles.length) return { skip: "no order bump toggles on checkout" };
    return `${bump.toggles.length} bump toggle(s), ${bump.toggles.filter((toggle) => toggle.active).length} active`;
  }, { timeoutMs: budget() });

  try {
    const fieldTrace = createFieldTrace();
    await ladder.run("customer_fields_filled", async () => {
      ensurePageFillable(page, checkoutPage.url);
      await fillCheckoutFields(page, args, email, { trace: fieldTrace, actionTimeoutMs: budget() });
    }, { timeoutMs: budget(), evidence: () => fieldTrace.summary() });
    await ladder.run("coupon_applied", async () => {
      const code = stringArg(args["apply-coupon"]);
      if (!code) return { skip: "no --apply-coupon code requested" };
      ensurePageFillable(page, checkoutPage.url);
      return applyRequestedCoupon(page, code);
    }, { timeoutMs: budget() });
    await ladder.run("card_fields_filled", async () => {
      ensurePageFillable(page, checkoutPage.url);
      await fillPaymentFields(page, args);
    }, { timeoutMs: budget() });
    await ladder.run("cart_created", async () => {
      const cart = cartCreationEvidence(events);
      if (!cart) return { skip: "no cart API call observed; checkout posts the order directly" };
      const lines = cart.line_count === undefined ? "line count not exposed by response body" : `${cart.line_count} line(s)`;
      return { detail: `cart create responded ${cart.status ?? "(no status)"}, ${lines}`, evidence: cart };
    }, { timeoutMs: budget() });
    await ladder.run("order_submitted", async () => {
      ensurePageFillable(page, checkoutPage.url);
      // What the checkout displayed at the moment of submit. Captured here and
      // not as its own ladder step so the step contract is unchanged; the
      // collector never throws, so it cannot cost the one canonical order.
      checkoutDisplay = await checkoutDisplayEvidence(page);
      await submitCheckout(page);
      await waitForCheckoutResult(page, events);
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
  // Reconcile BEFORE any upsell step: after an accept the persisted lines carry
  // upsell product the checkout never displayed, by design. The pre-upsell
  // read-back is the only moment the two describe the same cart.
  if (checkoutDisplay) order.checkout_display = checkoutDisplay;
  order.verification.display_reconciliation = reconcileOrderAgainstDisplay({
    lines: order.receipt_line_items,
    display: checkoutDisplay,
    events,
  });
  order.verification.total_parity = assessOrderTotalParity({
    display: checkoutDisplay,
    preUpsellTotal: order.verification.total_incl_tax,
  });
  const stepFailures = [];
  const receiptFailures = [];
  const upsellSteps = testOrderSteps(path);

  if (order.ok && upsellSteps.length) {
    order.upsell_steps = [];
  }
  if (!upsellSteps.length) ladder.skip("upsell_action", "path has no upsell steps");

  for (let stepIndex = 0; order.ok && stepIndex < upsellSteps.length; stepIndex += 1) {
    const disposition = remainingActionDisposition(topologyPlan, safePageUrl(page), upsellSteps.slice(stepIndex));
    if (disposition.stop) {
      const terminal = disposition.terminal;
      order.final_url = safePageUrl(page);
      order.terminal = terminal;
      ladder.skip(
        "upsell_action",
        `recognized ${terminal.kind} terminal reached; skipped remaining planned action(s): ${disposition.remaining_actions.join("-")}`,
      );
      break;
    }
    const step = upsellSteps[stepIndex];
    const actionTrace = createUpsellActionTrace({ page, events, topologyPlan, stepIndex, path: step });
    await ladder.run("upsell_action", async () => {
      const initialLineItems = order.receipt_line_items.slice();
      const initialUpsellMutationCount = upsellMutationCount(events);
      await actionTrace.inspect();
      await waitForUpsellPageReady(page, args);
      await actionTrace.inspect();
      const upsell = await clickUpsellPath(page, step, { events, stepIndex, trace: actionTrace });
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
        order.vouchers = refreshed.vouchers;
        order.discount_total = refreshed.discount_total;
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
        stepFailures.push(...upsellActionStepFailures(stepIndex, step, upsell, proof));
        if (proof.ok && !upsell.api_response_seen) {
          upsell.verification.upsell_api_response_observation =
            "live order-upsell request not observed; confirmed via order read-back (upsell line present in persisted order)";
        }
      } else {
        const proof = declinedUpsellProof(order.receipt_line_items, initialLineItems, events, initialUpsellMutationCount);
        upsell.verification = proof;
        stepFailures.push(...upsellActionStepFailures(stepIndex, step, upsell, proof));
      }
      actionTrace.markStepCompleted();
      return `step ${stepIndex + 1}: ${step}`;
    }, {
      timeoutMs: budget(),
      evidence: actionTrace.summary,
      formatError: actionTrace.formatError,
    });
  }

  const finalUrl = safePageUrl(page) || "";
  const terminalEvidence = recordTestOrderTerminalEvidence({ ladder, topologyPlan, finalUrl });
  if (terminalEvidence.kind === "receipt") {
    if (terminalEvidence.terminal) order.terminal = terminalEvidence.terminal;
    const renderedReceipt = await receiptRenderingEvidence(page);
    const renderedReceiptAssessment = assessReceiptRendering(order.receipt_line_items.length, renderedReceipt);
    order.receipt_rendering = renderedReceipt;
    order.verification.receipt_rendering = renderedReceiptAssessment;
    order.evidence.receipt_rendering = renderedReceipt;
    if (!renderedReceiptAssessment.required) {
      ladder.skip("receipt_rendered", renderedReceiptAssessment.reason);
    } else if (renderedReceiptAssessment.ok) {
      ladder.ok("receipt_rendered", renderedReceiptAssessment.reason);
    } else {
      ladder.fail("receipt_rendered", renderedReceiptAssessment.reason);
      receiptFailures.push(`buyer-visible receipt line items: ${renderedReceiptAssessment.reason}`);
    }
  } else if (terminalEvidence.kind === "external_handoff") {
    order.terminal = terminalEvidence.terminal;
    ladder.skip("receipt_rendered", "external handoff does not expose an in-funnel receipt page");
  } else {
    ladder.skip("receipt_rendered", "receipt page was not reached");
  }

  const acceptedSteps = (order.upsell_steps || []).filter((step) => step.path === "accept");
  if (acceptedSteps.length) {
    order.verification.accepted_upsell_line_present = acceptedSteps.every((step) => step.verification?.accepted_upsell_line_present === true);
    order.verification.upsell_api_response_seen = acceptedSteps.every((step) => step.verification?.upsell_api_response_seen === true);
    order.verification.accepted_upsell_matches = acceptedSteps.map((step) => step.verification?.accepted_upsell_match).filter(Boolean);
  }
  if (stepFailures.length) order.verification.upsell_step_failures = stepFailures;
  if (receiptFailures.length) order.verification.receipt_rendering_failures = receiptFailures;

  // Coupon proof is read-back-authoritative, like accepted upsells: the click
  // mechanics live in the coupon_applied step, but the pass/fail signal is the
  // persisted order carrying the requested voucher.
  const couponFailures = [];
  const requestedCoupon = stringArg(args["apply-coupon"]);
  if (requestedCoupon) {
    const couponAssessment = assessCouponApplication(requestedCoupon, {
      vouchers: order.vouchers || [],
      totalDiscount: order.discount_total,
      lines: order.receipt_line_items || [],
      events,
    });
    order.verification.coupon = couponAssessment;
    if (order.ok && !couponAssessment.ok) {
      couponFailures.push(`coupon ${requestedCoupon}: ${couponAssessment.reason}`);
    }
  }

  const pathFailures = [...stepFailures, ...receiptFailures, ...couponFailures];
  const ok = order.ok && pathFailures.length === 0;
  return {
    ok,
    error: ok ? null : order.error || order.upsell?.error || pathFailures.join("; ") || "accepted upsell did not appear in final order lines",
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
    ["coupon_applied", "order_submitted", "upsell_action", "receipt_reached", "receipt_rendered"],
    "hosted checkout flow is platform-owned; typed-card runner stops at the handoff",
  );
  let order;
  try {
    order = await buildOrderEvidence({ page, events, path, email, checkoutPage, args, allowLateWait: false });
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

// Persisted order lines prove that the platform created the order. They do not
// prove that a buyer can see those lines on the receipt: a populated
// data-next-order-items node can still be hidden by cart-state presentation.
// Capture rendered truth separately and never include buyer/order copy in the
// evidence payload.
async function receiptRenderingEvidence(page) {
  await page.waitForFunction(() => {
    const containers = Array.from(document.querySelectorAll("[data-next-order-items]"));
    return containers.some((container) => (
      container.classList.contains("order-has-items")
      && container.childElementCount > 0
    ));
  }, null, { timeout: 3000 }).catch(() => {});

  return page.evaluate(() => {
    const cleanLength = (value) => String(value || "").replace(/\s+/g, " ").trim().length;
    const visible = (element) => {
      if (!(element instanceof Element) || element.hidden) return false;
      if (element.closest('[hidden], [aria-hidden="true"]')) return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (Number.parseFloat(style.opacity || "1") === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
    };
    const containers = Array.from(document.querySelectorAll("[data-next-order-items]"));
    const details = containers.map((container, index) => {
      const directChildren = Array.from(container.children);
      // Prefer one marker family at a time so nested aliases cannot inflate a
      // single rendered line into multiple candidates.
      const explicitItemGroups = [
        ["data-order-line-id", Array.from(container.querySelectorAll("[data-order-line-id]"))],
        ["data-next-order-item", Array.from(container.querySelectorAll("[data-next-order-item]"))],
        ["data-next-order-line", Array.from(container.querySelectorAll("[data-next-order-line]"))],
        ["data-next-line-item", Array.from(container.querySelectorAll("[data-next-line-item]"))],
        ["direct-listitem", Array.from(container.querySelectorAll(':scope > [role="listitem"]'))],
      ];
      const explicitItemGroup = explicitItemGroups.find(([, items]) => items.length > 0);
      const explicitItems = explicitItemGroup?.[1] || [];
      // OrderItemListEnhancer owns this state class. It distinguishes rendered
      // line roots from its loading/error/empty copy when a custom item
      // template does not carry an explicit line marker.
      const hasItemsState = container.classList.contains("order-has-items")
        && !container.classList.contains("order-loading")
        && !container.classList.contains("order-error")
        && !container.classList.contains("order-empty");
      const itemCandidates = explicitItems.length
        ? explicitItems
        : (hasItemsState ? directChildren : []);
      const containerVisible = visible(container);
      const visibleItemCount = itemCandidates.filter(visible).length;
      const textLength = cleanLength(container.textContent);
      const visibleTextLength = containerVisible ? cleanLength(container.innerText) : 0;
      return {
        index,
        visible: containerVisible,
        child_element_count: container.childElementCount,
        item_candidate_count: itemCandidates.length,
        visible_item_count: visibleItemCount,
        item_detection: explicitItemGroup?.[0] || (hasItemsState ? "order-has-items-direct-children" : "none"),
        has_items_state: hasItemsState,
        text_length: textLength,
        visible_text_length: visibleTextLength,
        populated: container.childElementCount > 0 || textLength > 0,
        buyer_visible_content: containerVisible && visibleItemCount > 0,
      };
    });
    const sum = (field) => details.reduce((total, detail) => total + detail[field], 0);
    return {
      selector: "[data-next-order-items]",
      container_count: details.length,
      visible_container_count: details.filter((detail) => detail.visible).length,
      populated_container_count: details.filter((detail) => detail.populated).length,
      visible_populated_container_count: details.filter((detail) => detail.buyer_visible_content).length,
      rendered_item_count: sum("item_candidate_count"),
      visible_rendered_item_count: sum("visible_item_count"),
      max_visible_rendered_item_count: Math.max(0, ...details
        .filter((detail) => detail.visible)
        .map((detail) => detail.visible_item_count)),
      visible_text_length: sum("visible_text_length"),
      containers: details,
    };
  }).catch((error) => ({
    selector: "[data-next-order-items]",
    container_count: 0,
    visible_container_count: 0,
    populated_container_count: 0,
    visible_populated_container_count: 0,
    rendered_item_count: 0,
    visible_rendered_item_count: 0,
    visible_text_length: 0,
    containers: [],
    inspection_error: error instanceof Error ? error.message : String(error),
  }));
}

function assessReceiptRendering(persistedLineCount, evidence = {}) {
  const persisted = Math.max(0, Number.parseInt(persistedLineCount, 10) || 0);
  const containerCount = Math.max(0, Number(evidence.container_count) || 0);
  const visibleContainerCount = Math.max(0, Number(evidence.visible_container_count) || 0);
  const visiblePopulatedCount = Math.max(0, Number(evidence.visible_populated_container_count) || 0);
  // Receipts commonly carry separate desktop/mobile copies. One complete
  // buyer-visible surface must cover the order; partial copies cannot be
  // added together to manufacture coverage.
  const visibleItemCount = Math.max(0, Number(
    evidence.max_visible_rendered_item_count ?? evidence.visible_rendered_item_count,
  ) || 0);
  const common = {
    persisted_line_count: persisted,
    rendered_container_count: containerCount,
    visible_container_count: visibleContainerCount,
    visible_populated_container_count: visiblePopulatedCount,
    visible_rendered_item_count: visibleItemCount,
  };
  if (persisted === 0) {
    return {
      ...common,
      required: false,
      ok: null,
      reason: "order read-back has no persisted lines; buyer-visible receipt-line assertion not applicable",
    };
  }
  if (evidence.inspection_error) {
    return {
      ...common,
      required: true,
      ok: false,
      reason: `receipt DOM inspection failed: ${evidence.inspection_error}`,
    };
  }
  if (containerCount === 0) {
    return {
      ...common,
      required: true,
      ok: false,
      reason: "persisted order has lines but [data-next-order-items] is missing",
    };
  }
  if (visibleContainerCount === 0) {
    return {
      ...common,
      required: true,
      ok: false,
      reason: "persisted order has lines but every [data-next-order-items] container is hidden",
    };
  }
  if (visiblePopulatedCount === 0) {
    return {
      ...common,
      required: true,
      ok: false,
      reason: "persisted order has lines but visible [data-next-order-items] containers have no buyer-visible line items",
    };
  }
  if (visibleItemCount < persisted) {
    return {
      ...common,
      required: true,
      ok: false,
      reason: `persisted order has ${persisted} line(s) but only ${visibleItemCount} buyer-visible receipt line item(s) rendered`,
    };
  }
  return {
    ...common,
    required: true,
    ok: true,
    reason: `${visibleItemCount} buyer-visible rendered item candidate(s) across ${visiblePopulatedCount} populated receipt container(s)`,
  };
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

// --- Strict package/bundle card selection (--select-package) ---
// `--cart` is best-effort: a ref that matches no rendered card silently falls
// through to the funnel's default tier, so a multi-tier selector can only ever
// prove the pre-selected card. `--select-package <ref[:qty][,ref...]>` is the
// strict variant: the requested card must exist, be clickable, and (when the
// selector exposes selected-state markers) actually enter the selected state —
// otherwise the selected_bundle step fails instead of driving the wrong tier.
function packageCardSelectors(ref) {
  const escaped = escapeCss(String(ref));
  return [
    `[data-next-selector-card][data-next-package-id="${escaped}"]`,
    `[data-next-bundle-card][data-next-bundle-id="${escaped}"]`,
    `[data-next-package-id="${escaped}"]`,
    `[data-next-bundle-id="${escaped}"]`,
  ];
}

async function selectRequestedPackages(page, args) {
  const requested = parseCart(args["select-package"]);
  if (!requested.length) return null;
  const details = [];
  for (const item of requested) {
    details.push(await selectPackageCard(page, item));
  }
  return details.join("; ");
}

async function selectPackageCard(page, item) {
  const selectors = packageCardSelectors(item.packageId);
  for (const selector of selectors) {
    const target = page.locator(selector).first();
    if (!await target.count().catch(() => 0)) continue;
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ timeout: 5000 }).catch(async () => {
      await target.click({ force: true, timeout: 5000 });
    });
    const state = await packageCardSelectionState(page, selector);
    if (state === "unselected") {
      throw new Error(`--select-package ${item.packageId}: card matched ${selector} but did not enter a selected state after click`);
    }
    return `${item.packageId} via ${selector}${state === "unknown" ? " (card exposes no selected-state marker; click recorded)" : ""}`;
  }
  throw new Error(`--select-package ${item.packageId}: no rendered card matched any of ${selectors.join(", ")}`);
}

// Bounded retry instead of a single fixed wait: SPA selectors can propagate
// the selected-state marker asynchronously, so "unselected" is only final
// after the polling budget is spent. "unknown" (no marker contract exposed)
// and "selected" return immediately.
async function packageCardSelectionState(page, selector, { attempts = 4, intervalMs = 500 } = {}) {
  let state = "unknown";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.waitForTimeout(intervalMs);
    state = await page.locator(selector).first().evaluate((element) => {
      const card = element.closest("[data-next-selector-card], [data-next-bundle-card]") || element;
      const isSelected = (node) => node.getAttribute("data-next-selected") === "true" || node.classList.contains("next-selected");
      if (isSelected(card) || Array.from(card.querySelectorAll("*")).some(isSelected)) return "selected";
      const group = card.closest("[data-next-bundle-selector], [data-next-selector-id], [data-next-cart-selector]");
      if (group) {
        return group.querySelector('[data-next-selected], .next-selected') ? "unselected" : "unknown";
      }
      // No known selector-group container: only same-kind sibling cards can
      // prove a selected-state contract exists. An arbitrary ancestor's
      // markers (a payment-method selector, another widget) must not turn an
      // honest "unknown" into a false "unselected".
      const siblingCards = Array.from(card.parentElement?.children || [])
        .filter((node) => node !== card && node.matches("[data-next-selector-card], [data-next-bundle-card], [data-next-package-id], [data-next-bundle-id]"));
      const siblingMarker = siblingCards.some((node) => (
        node.hasAttribute("data-next-selected")
        || node.classList.contains("next-selected")
        || node.querySelector('[data-next-selected], .next-selected')
      ));
      return siblingMarker ? "unselected" : "unknown";
    }).catch(() => "unknown");
    if (state !== "unselected") return state;
  }
  return state;
}

// --- Coupon application (--apply-coupon) ---
// The step drives the rendered promo/coupon surface like a shopper: reveal a
// collapsed disclosure if needed, type the code, click apply (or press Enter).
// It deliberately does NOT pass/fail on live DOM state — the authoritative
// proof is the persisted order carrying the voucher (assessCouponApplication),
// evaluated after the order read-back.
const COUPON_INPUT_SELECTORS = Object.freeze([
  '[data-next-checkout-field="coupon"]',
  '[os-checkout-field="coupon"]',
  "[data-next-coupon-input]",
  'input[name*="coupon" i]',
  'input[name*="voucher" i]',
  'input[name*="promo" i]',
  'input[placeholder*="coupon" i]',
  'input[placeholder*="promo" i]',
  'input[placeholder*="discount" i]',
]);

async function applyRequestedCoupon(page, code) {
  let input = await firstUsableCouponInput(page);
  if (!input) {
    // A collapsed "Have a coupon?" disclosure is common; reveal and retry
    // once. Scoped to form containers so page chrome that merely mentions
    // promos/vouchers (nav links, marketing copy) is never clicked.
    await clickVisibleControlByText(page, /coupon|promo|discount code|voucher/i, { within: "form" }).catch(() => {});
    await page.waitForTimeout(750);
    input = await firstUsableCouponInput(page);
  }
  if (!input) {
    // Some funnels have no shopper-typable coupon surface at all — the code is
    // applied by page JS (e.g. an exit-intent overlay calling
    // window.next.applyCoupon("CODE")). Fall back to the SDK's own coupon API:
    // the persisted-order voucher read-back stays the proof, but the
    // shopper-facing trigger (exit-intent click, etc.) is NOT exercised, so the
    // step detail records the mechanism for the verdict reader.
    const sdkApplied = await applyCouponViaSdkApi(page, code);
    if (sdkApplied.available) {
      await page.waitForLoadState("networkidle", { timeout: DEFAULT_SETTLE_TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(1000);
      const returned = sdkApplied.result_summary != null ? `; SDK returned ${sdkApplied.result_summary}` : "";
      return `no rendered coupon input; applied ${code} via SDK window.next.applyCoupon API (shopper-facing trigger not exercised)${returned}; proof deferred to persisted-order voucher read-back`;
    }
    throw new Error(`--apply-coupon ${code}: no coupon/promo input found on the checkout page (looked for ${COUPON_INPUT_SELECTORS.join(", ")}) and the SDK applyCoupon API is unavailable`);
  }
  await input.locator.click({ timeout: 5000 }).catch(() => {});
  await input.locator.fill("").catch(() => {});
  await input.locator.pressSequentially(code, { delay: 20 });
  const applied = await clickCouponApplyControl(page, input.locator);
  await page.waitForLoadState("networkidle", { timeout: DEFAULT_SETTLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(1000);
  return `typed ${code} into ${input.selector}, ${applied}; proof deferred to persisted-order voucher read-back`;
}

async function applyCouponViaSdkApi(page, code) {
  return page.evaluate(async (couponCode) => {
    const apply = window.next?.applyCoupon;
    if (typeof apply !== "function") return { available: false };
    const result = await apply.call(window.next, couponCode);
    // Surface the SDK's own verdict in the step detail — a resolved-but-falsy
    // or { ok: false } result means the pathway silently no-oped even though
    // nothing threw, and the read-back would otherwise be the only clue.
    let summary;
    try {
      summary = result === undefined ? "undefined" : JSON.stringify(result);
    } catch {
      summary = String(result);
    }
    return { available: true, result_summary: String(summary).slice(0, 200) };
  }, code).catch((error) => {
    throw new Error(`--apply-coupon ${code}: SDK applyCoupon API call failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function firstUsableCouponInput(page) {
  for (const selector of COUPON_INPUT_SELECTORS) {
    const locator = page.locator(selector).first();
    if (!await locator.count().catch(() => 0)) continue;
    if (await locator.isVisible().catch(() => false)) return { selector, locator };
  }
  return null;
}

async function clickCouponApplyControl(page, input) {
  const explicit = page.locator('[data-next-coupon-apply], [data-next-action="apply-coupon"], [data-next-checkout-action="apply-coupon"]').first();
  if (await explicit.count().catch(() => 0)) {
    await explicit.click({ timeout: 5000 }).catch(() => {});
    return "clicked explicit apply control";
  }
  const clicked = await clickVisibleControlByText(page, /^\s*apply\s*(?:code|coupon|discount)?\s*$/i, { within: "form" }).catch(() => false);
  if (clicked) return "clicked visible apply control";
  await input.press("Enter").catch(() => {});
  return "pressed Enter in the coupon input";
}

function extractOrderVouchers(order) {
  const buckets = [order?.vouchers, order?.voucher_discounts, order?.discounts];
  const entries = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      if (!entry || typeof entry !== "object") continue;
      const code = stringArg(entry.code) || stringArg(entry.voucher_code) || stringArg(entry?.voucher?.code) || null;
      const name = stringArg(entry.name) || stringArg(entry?.voucher?.name) || null;
      // Identity-less entries (bare amount rows) can neither prove nor
      // disprove a specific code; keeping them would only inflate
      // vouchers.length and suppress the discount_total fallback.
      if (!code && !name) continue;
      entries.push({ code, name, amount: entry.amount ?? entry.discount ?? null });
    }
  }
  return entries;
}

// total_discount_incl_tax deliberately last: it is tax-inflated relative to
// the coupon's face value, so it only speaks when no tax-neutral key exists.
function orderDiscountTotal(order) {
  for (const value of [order?.total_discounts, order?.discount_total, order?.total_discount_incl_tax]) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function assessCouponApplication(code, { vouchers = [], totalDiscount = null, lines = [], events = null } = {}) {
  const requested = normalizeLabel(code);
  const matched = vouchers.filter((voucher) => [voucher.code, voucher.name].some((value) => value && normalizeLabel(value) === requested));
  if (matched.length) {
    return { requested_code: code, ok: true, basis: "persisted_voucher_code", matched, reason: `voucher ${code} present in persisted order` };
  }
  if (vouchers.length) {
    return {
      requested_code: code,
      ok: false,
      basis: "missing",
      matched: [],
      reason: `persisted order voucher(s) (${vouchers.map((voucher) => voucher.code || voucher.name).join(", ")}) do not include ${code}`,
    };
  }
  const discount = Number(totalDiscount);
  if (Number.isFinite(discount) && discount > 0) {
    return {
      requested_code: code,
      ok: true,
      basis: "discount_total",
      weak_evidence: true,
      matched: [],
      reason: `persisted order exposes no voucher entries but carries a ${discount} discount total; treated as applied (weak evidence — the discount is not provably tied to the requested code)`,
    };
  }
  // Some platforms net the voucher into the line prices and itemize nothing:
  // no voucher collection under any key, discounts [], total_discounts "0.00",
  // and price_incl_tax already reduced. There the only persisted discount
  // signal is the delta between the charged line prices and the campaign
  // package list prices (which the run already captured from the campaign API
  // responses). Applied → charged < list; rejected → charged == list.
  const delta = linePriceDeltaEvidence(lines, events);
  if (delta) {
    if (delta.charged_total < delta.list_total - 0.009) {
      return {
        requested_code: code,
        ok: true,
        basis: "line_price_delta",
        weak_evidence: true,
        matched: [],
        evidence: delta,
        reason: `persisted order itemizes no vouchers, but charged line total ${delta.charged_total} is below the campaign package list total ${delta.list_total} (delta ${delta.delta}); treated as applied (weak evidence — the discount is not provably tied to the requested code)`,
      };
    }
    return {
      requested_code: code,
      ok: false,
      basis: "line_price_delta",
      matched: [],
      evidence: delta,
      reason: `persisted order itemizes no vouchers and charged line total ${delta.charged_total} equals the campaign package list total ${delta.list_total}; no discount evidence`,
    };
  }
  return {
    requested_code: code,
    ok: false,
    basis: "missing",
    matched: [],
    reason: "persisted order shows no voucher entries, no positive discount total, and campaign package list prices could not be resolved for a price-delta check",
  };
}

function linePriceDeltaEvidence(lines, events) {
  if (!events || !Array.isArray(lines) || !lines.length) return null;
  let listTotal = 0;
  let chargedTotal = 0;
  let unmatchedLineCount = 0;
  const matchedLines = [];
  for (const line of lines) {
    const pkg = campaignPackageMetaForLine(events, line);
    const listPrice = packageListTotal(pkg);
    const declaredPrice = Number(line.price_incl_tax ?? line.price);
    if (!pkg || !Number.isFinite(listPrice) || !Number.isFinite(declaredPrice)) {
      // Bonus/gift/trial lines with no campaign-package equivalent must not
      // defeat the delta for the lines that DO resolve.
      unmatchedLineCount += 1;
      continue;
    }
    // Persisted line-price semantics vary by platform shape: 29next stores the
    // line TOTAL in price_incl_tax, other shapes store a per-unit price. Read
    // it both ways and take the LARGEST reading that does not exceed the list
    // total — the conservative (smallest) claimed discount. A per-unit full
    // price (unit × qty == list) then correctly reads as undiscounted instead
    // of as a fake (qty−1)× discount.
    const quantity = Number(line.quantity || 1) || 1;
    const readings = [declaredPrice, round2(declaredPrice * quantity)];
    const notOverList = readings.filter((value) => value <= listPrice + 0.009);
    const chargedPrice = notOverList.length ? Math.max(...notOverList) : Math.min(...readings);
    listTotal += listPrice;
    chargedTotal += chargedPrice;
    matchedLines.push({ title: line.title, quantity: line.quantity, package_ref_id: pkg.ref_id ?? null, list_price: round2(listPrice), charged_price: round2(chargedPrice) });
  }
  if (!matchedLines.length) return null;
  return {
    list_total: round2(listTotal),
    charged_total: round2(chargedTotal),
    delta: round2(listTotal - chargedTotal),
    lines: matchedLines,
    ...(unmatchedLineCount ? { unmatched_line_count: unmatchedLineCount } : {}),
  };
}

function campaignPackageMetaForLine(events, line) {
  for (let index = events.responses.length - 1; index >= 0; index -= 1) {
    const body = events.responses[index]?.body;
    if (!Array.isArray(body?.packages)) continue;
    const match = body.packages.find((pkg) => packageMatchesLine(pkg, line));
    if (match) return match;
  }
  return null;
}

// A campaign typically carries several packages for the same product at
// different quantities (1x/3x/6x tiers), so a SKU/product match alone is
// ambiguous — the package quantity must match the persisted line quantity too.
function packageMatchesLine(pkg, line) {
  const qty = Number(pkg?.qty ?? pkg?.quantity);
  if (!Number.isFinite(qty) || qty !== Number(line?.quantity || 0)) return false;
  if (pkg?.product_sku && line?.sku) return normalizeLabel(pkg.product_sku) === normalizeLabel(line.sku);
  if (pkg?.product_variant_id != null && line?.variant_id != null) return Number(pkg.product_variant_id) === Number(line.variant_id);
  if (pkg?.product_id != null && line?.product_id != null) return Number(pkg.product_id) === Number(line.product_id);
  return false;
}

function packageListTotal(pkg) {
  const total = Number(pkg?.price_total);
  if (Number.isFinite(total) && total > 0) return total;
  const unit = Number(pkg?.price);
  const qty = Number(pkg?.qty ?? pkg?.quantity ?? 1);
  if (!Number.isFinite(unit)) return NaN;
  return unit * (Number.isFinite(qty) && qty > 0 ? qty : 1);
}

function round2(value) {
  return Math.round(value * 100) / 100;
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

async function fillCheckoutFields(page, args, email, options = {}) {
  const trace = options.trace || null;
  const actionTimeoutMs = options.actionTimeoutMs;
  await revealCheckoutForm(page, { actionTimeoutMs });
  // Field order, progressive-disclosure calls and optional/onlyVisible flags
  // below are unchanged; only the per-field recording wrapper is new.
  const track = (field, action, fn, opts = {}) => (trace ? trace.inspect(field, action, fn, opts) : fn());
  const fill = (field, value, opts = {}) =>
    track(field, "fill", () => fillByField(page, field, value, { ...opts, actionTimeoutMs }), opts);
  const select = (field, value, opts = {}) =>
    track(field, "select", () => selectByField(page, field, value, { ...opts, actionTimeoutMs }), opts);
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

  await fill("fname", address.firstName);
  await fill("lname", address.lastName);
  await fill("email", address.email);
  await fill("phone", address.phone, { optional: true });
  await select("country", address.country);
  await fill("address1", address.address1);
  await settleAddressAutocomplete(page);
  await revealProgressiveLocationFields(page, address.address1);
  await fill("city", address.city);
  await select("province", address.province);
  await fill("postal", address.postal);
  await closeAddressAutocomplete(page);

  const sameAsShipping = page.locator("#use_shipping_address").first();
  if (await sameAsShipping.count().catch(() => 0)) {
    // Best-effort with a short timeout: funnels that collapse the billing
    // section leave this checkbox hidden (already checked), and a default
    // 30s wait on it would eat most of the step budget for nothing.
    await sameAsShipping.check({ timeout: 3000 }).catch(() => {});
  }

  // Canonical billing fields share one collapsed section. Probe that section
  // once so a checked "same as shipping" toggle cannot turn eight optional
  // fields into eight separate Playwright actionability waits.
  const billingCollapsed = await billingFieldsCollapsed(page);
  const fillBilling = (field, value) => (billingCollapsed
    ? track(field, "fill", async () => false, { optional: true })
    : fill(field, value, { optional: true, onlyVisible: true }));
  const selectBilling = (field, value) => (billingCollapsed
    ? track(field, "select", async () => false, { optional: true })
    : select(field, value, { optional: true, onlyVisible: true }));

  await fillBilling("billing-fname", address.firstName);
  await fillBilling("billing-lname", address.lastName);
  await fillBilling("billing-phone", address.phone);
  await selectBilling("billing-country", address.country);
  await fillBilling("billing-address1", address.address1);
  await fillBilling("billing-city", address.city);
  await selectBilling("billing-province", address.province);
  await fillBilling("billing-postal", address.postal);
}

async function revealCheckoutForm(page, options = {}) {
  const activeForm = page.locator('.checkout-form--reveal:not(.is-revealed)').first();
  if (!await activeForm.count().catch(() => 0)) return false;

  const trigger = activeForm.locator('[data-checkout-reveal-trigger]').first();
  if (!await trigger.count().catch(() => 0)) {
    throw new Error("Checkout reveal is active, but its reveal CTA is missing.");
  }

  const timeout = Number.isFinite(options.actionTimeoutMs) && options.actionTimeoutMs > 0
    ? Math.min(options.actionTimeoutMs, 8000)
    : 8000;
  if (!await trigger.isVisible().catch(() => false)) {
    throw new Error("Checkout reveal is active, but its reveal CTA is not visible.");
  }
  await trigger.click({ timeout }).catch((error) => {
    throw new Error(`Could not open checkout reveal: ${error?.message || error}`);
  });

  const panel = page.locator('.checkout-form--reveal.is-revealed [data-checkout-reveal-panel]').first();
  await panel.waitFor({ state: "visible", timeout }).catch((error) => {
    throw new Error(`Checkout reveal CTA was clicked, but the customer form did not reveal: ${error?.message || error}`);
  });
  return true;
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

// When events are supplied (the post-submit wait), a platform-rejected order
// create fails fast with the real cause instead of burning the full step
// budget and reporting a generic timeout: a 400 on POST /api/v1/orders/ never
// navigates the page, so without this check the only symptom was
// "step order_submitted timed out after 45000ms".
async function waitForCheckoutResult(page, events = null) {
  const outcomeUrl = /ref_id=|receipt|upsell|thank|order|payment_failed/i;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error("checkout page closed during order submit");
    if (outcomeUrl.test(String(safePageUrl(page) || ""))) break;
    if (events) {
      const rejected = rejectedOrderCreateResponse(events);
      if (rejected) {
        const detail = typeof rejected.body?.detail === "string" ? `: ${trim(rejected.body.detail)}` : "";
        throw new Error(`order create rejected: HTTP ${rejected.status}${detail}`);
      }
      const failed = failedOrderCreateRequest(events);
      if (failed) throw new Error(`order create request failed: ${failed.failure || "network failure"}`);
    }
    await page.waitForTimeout(250);
  }
  await page.waitForLoadState("domcontentloaded", { timeout: DEFAULT_SETTLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: DEFAULT_SETTLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(1500);
}

// The MOST RECENT create response decides the outcome: SDKs/platforms retry
// transient create failures, so [..., 400, 201] means the retry succeeded and
// the earlier rejection is history, not the result.
function rejectedOrderCreateResponse(events) {
  for (let index = events.responses.length - 1; index >= 0; index -= 1) {
    const response = events.responses[index];
    if (!ORDER_CREATE_RESPONSE_PATTERN.test(response.url)) continue;
    return response.status >= 400 ? response : null;
  }
  return null;
}

// Network-level failures (DNS, reset, abort) land in events.failed, not
// events.responses. Only meaningful when no create response succeeded — an
// aborted duplicate alongside a 2xx create is not a failed order.
function failedOrderCreateRequest(events) {
  const succeeded = events.responses.some((response) => (
    ORDER_CREATE_RESPONSE_PATTERN.test(response.url) && response.status >= 200 && response.status < 300
  ));
  if (succeeded) return null;
  for (let index = events.failed.length - 1; index >= 0; index -= 1) {
    if (ORDER_CREATE_RESPONSE_PATTERN.test(events.failed[index].url)) return events.failed[index];
  }
  return null;
}

async function buildOrderEvidence({ page, events, path, email, checkoutPage, args, preferredOrderBody = null, allowLateWait = true }) {
  if (allowLateWait) await waitForLateOrderEvidence(page, events);
  const orderCreate = lastJsonResponse(events, ORDER_CREATE_RESPONSE_PATTERN);
  const orderRead = lastJsonResponse(events, /\/api\/v1\/orders\/[^/]+\/$/i);
  const upsellOrderResponse = lastJsonResponse(events, ORDER_UPSELLS_RESPONSE_PATTERN);
  const orderBody = preferredOrderBody || upsellOrderResponse?.body || orderRead?.body || orderCreate?.body || null;
  const refId = stringArg(orderBody?.ref_id) || refIdFromUrl(page.url());
  const number = stringArg(orderBody?.number) || stringArg(orderBody?.id) || null;
  const card = normalizeCard(stringArg(args["test-card"]) || DEFAULT_TEST_CARD);
  const proof = assessOrderCreation({ orderCreate, orderRead, upsellOrderResponse, refId });
  const ok = proof.ok;
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
    vouchers: extractOrderVouchers(orderBody),
    discount_total: orderDiscountTotal(orderBody),
    verification: {
      verified: ok,
      order_create_status: orderCreate?.status || null,
      order_read_status: orderRead?.status || null,
      total_incl_tax: orderBody?.total_incl_tax || null,
      currency: orderBody?.currency || null,
      ...(proof.observation ? { order_create_observation: proof.observation } : {}),
      error: ok ? null : await visibleErrorText(page),
    },
    evidence: {
      order_request_seen: Boolean(orderCreate),
      spreedly_tokenized: events.requests.some((request) => /spreedly.*payment_methods/i.test(request.url)),
      events: sanitizedEvents(events),
    },
  };
}

// The live order-create observation is best-effort: the response listener reads
// bodies asynchronously and a fast post-submit navigation can drop or delay the
// capture even though the platform created the order (observed in migration QA
// as a flaky "order request not observed" abort after the order existed). The
// order read-back is authoritative, mirroring the accepted-upsell rule: a
// persisted order returned for the ref_id proves creation. An observed create
// with a non-2xx status is still a real failure.
function assessOrderCreation({ orderCreate, orderRead, upsellOrderResponse, refId }) {
  if (!refId) return { ok: false, observation: null };
  if (orderCreate) {
    const createOk = orderCreate.status >= 200 && orderCreate.status < 300;
    return { ok: createOk, observation: null };
  }
  const readBack = [orderRead, upsellOrderResponse].find((response) => (
    response
    && response.status >= 200 && response.status < 300
    && response.body && typeof response.body === "object"
  ));
  if (readBack) {
    return {
      ok: true,
      observation: "live order-create request not observed; confirmed via order read-back (persisted order returned for ref_id)",
    };
  }
  return { ok: false, observation: null };
}

// Bounded wait for the async response listener to catch up before concluding
// "order request not observed": when the page already redirected with a ref_id
// (the strongest live signal an order exists) but no order API evidence has
// landed in the event log yet, poll briefly for the late capture.
async function waitForLateOrderEvidence(page, events, { timeoutMs = 4000, intervalMs = 250 } = {}) {
  const hasOrderEvidence = () => Boolean(
    lastJsonResponse(events, ORDER_CREATE_RESPONSE_PATTERN)
    || lastJsonResponse(events, /\/api\/v1\/orders\/[^/]+\/$/i)
    || lastJsonResponse(events, ORDER_UPSELLS_RESPONSE_PATTERN),
  );
  if (hasOrderEvidence()) return;
  if (!refIdFromUrl(safePageUrl(page))) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (hasOrderEvidence()) return;
  }
}

async function clickUpsellPath(page, path, { trace = null } = {}) {
  const offerUrl = safePageUrl(page);
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
  trace?.markClickAttempted();
  let clickCompleted = false;
  try {
    await control.click({ timeout: 10000 });
    clickCompleted = true;
  } catch {
    await control.click({ force: true });
    clickCompleted = true;
  }
  if (clickCompleted) trace?.markClickCompleted();
  const mutationResponse = await mutationPromise;
  const mutationBody = mutationResponse ? await readJsonResponseBody(mutationResponse) : null;
  await waitForCheckoutResult(page);
  return {
    path,
    clicked: true,
    offer_url: offerUrl,
    final_url: page.url(),
    expected_items: expectedItems,
    api_response_seen: Boolean(mutationResponse),
    api_response_status: mutationResponse?.status() || null,
    api_response_url: mutationResponse?.url() || null,
    api_response_order_body: mutationBody,
  };
}

function receiptProofEvidence(order) {
  if (!order?.verification?.receipt_rendering && !order?.receipt_rendering) return null;
  return {
    persisted_order: {
      line_count: Array.isArray(order.receipt_line_items) ? order.receipt_line_items.length : 0,
      order_read_status: order.verification?.order_read_status ?? null,
    },
    buyer_visible_rendering: order.receipt_rendering || null,
    assessment: order.verification?.receipt_rendering || null,
  };
}

function receiptRenderingAssertion(page, path, order) {
  const assessment = order?.verification?.receipt_rendering;
  if (!assessment) return null;
  const proof = receiptProofEvidence(order);
  const receiptPage = {
    page_id: `${page.page_id || "checkout"}:receipt:${path}`,
    url: redactUrlQuery(order.final_url),
  };
  return assertion({
    id: `browser-receipt-rendering:${path}`,
    family: "browser-receipt-rendering",
    page: receiptPage,
    status: assessment.required ? (assessment.ok ? STATUS.PASS : STATUS.FAIL) : STATUS.SKIPPED,
    severity: assessment.required && !assessment.ok ? SEVERITY.BLOCKER : undefined,
    expected: "persisted order lines and a visible, populated [data-next-order-items] receipt surface",
    actual: assessment.reason,
    evidence: proof,
  });
}

// --- Checkout display vs persisted order reconciliation ---
// QA proved the checkout rendered the right prices, and it proved a typed-card
// order completed. Nothing joined the two, so a package could be in the cart,
// charged on the order, and absent from every price surface the assertions read
// (#272). The order read-back already happens for accepted-upsell proof, so
// this is a comparison, not a new fetch: capture what the checkout displayed at
// submit, then reconcile the persisted order's non-upsell lines against it.

// The rendered order summary is the display authority: `[data-summary-lines]`
// rows are what the shopper is told they are buying, and the SDK stamps each
// row's package ref id into `data-package-id` from `{item.packageId}`.
async function checkoutDisplayEvidence(browserPage) {
  return browserPage.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const ID_ATTRIBUTES = ["data-package-id", "data-next-package-id", "data-next-bundle-id"];
    const readId = (element) => {
      for (const attribute of ID_ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (value && value.trim()) return value.trim();
      }
      return null;
    };
    const idOf = (element) => {
      const own = readId(element);
      if (own) return own;
      // Hand-rolled cards, toggles and rows hang the id on an inner node rather
      // than the root the selector matched. Dropping it there would push a
      // legitimately displayed package into `extra` — the false stray charge
      // this check exists to avoid. The root still wins when it carries one,
      // and querySelector does not descend into <template> content, so a row's
      // discount sub-template cannot supply an id.
      const nested = element.querySelector(ID_ATTRIBUTES.map((attribute) => `[${attribute}]`).join(","));
      return nested ? readId(nested) : null;
    };
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };

    // The SDK's list renderers clear rendered children but deliberately leave
    // the row `<template>` in place, so it is a sibling of every rendered row.
    // Counting it as a row would leave one id-less entry in every summary and
    // make an otherwise comparable checkout look uncomparable.
    const renderedChildren = (root, selector) => Array.from(root.querySelectorAll(selector))
      .flatMap((container) => Array.from(container.children))
      .filter((child) => child.tagName.toLowerCase() !== "template");

    const summaries = Array.from(document.querySelectorAll("[data-next-cart-summary]"));
    const rows = summaries.flatMap((summary) => renderedChildren(summary, "[data-summary-lines]"));
    const summaryRows = rows.map((row) => ({
      package_id: idOf(row),
      text: clean(row.textContent).slice(0, 160),
    }));

    const selectedBundles = Array.from(document.querySelectorAll("[data-next-bundle-card]"))
      .filter((card) => (
        card.classList.contains("next-selected")
        || card.getAttribute("data-next-selected") === "true"
        || card.getAttribute("aria-checked") === "true"
        || card.querySelector('input[type="radio"], input[type="checkbox"]')?.checked === true
      ))
      .map(idOf)
      .filter(Boolean);

    const activeToggles = Array.from(document.querySelectorAll("[data-next-package-toggle], [data-next-toggle-card], [data-next-bump]"))
      .filter((toggle) => (
        toggle.classList.contains("next-active")
        || toggle.classList.contains("next-in-cart")
        || toggle.classList.contains("next-selected")
        || toggle.getAttribute("aria-pressed") === "true"
        || toggle.querySelector('input[type="checkbox"]')?.checked === true
      ))
      .map(idOf)
      .filter(Boolean);

    const discountRows = summaries.flatMap((summary) => (
      renderedChildren(summary, "[data-next-discounts]")
        .filter(isVisible)
        .map((row) => ({
          scope: row.closest("[data-next-discounts]")?.getAttribute("data-next-discounts") || "",
          text: clean(row.textContent).slice(0, 160),
        }))
    ));

    const totalNode = document.querySelector('[data-next-display="cart.total"]');
    return {
      summary_present: summaries.length > 0,
      summary_rows: summaryRows.slice(0, 40),
      selected_bundle_package_ids: [...new Set(selectedBundles)],
      active_toggle_package_ids: [...new Set(activeToggles)],
      discount_rows: discountRows.slice(0, 20),
      total_text: totalNode ? clean(totalNode.textContent) : null,
    };
  }).catch((error) => ({
    summary_present: false,
    summary_rows: [],
    selected_bundle_package_ids: [],
    active_toggle_package_ids: [],
    discount_rows: [],
    total_text: null,
    collector_error: error instanceof Error ? error.message : String(error),
  }));
}

function parseDisplayedMoney(text) {
  const raw = String(text || "").replace(/[\s ]/g, "");
  if (!raw) return null;
  // Take the last number in the string: totals render as "USD $139.00" or
  // "$139.00" and the currency code must not be read as a value.
  const matches = raw.match(/\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?/g);
  if (!matches) return null;
  const value = Number(matches[matches.length - 1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

// The summary is machine-comparable only when EVERY rendered row exposes its
// package id. A template that renders rows without `data-package-id` would
// otherwise make legitimately-displayed packages look like stray charges, so
// partial id coverage is reported as not-comparable rather than guessed at.
function displayedPackageIds(display) {
  const rows = Array.isArray(display?.summary_rows) ? display.summary_rows : [];
  const rowIds = rows.map((row) => (row?.package_id == null ? null : String(row.package_id)));
  const comparable = Boolean(display?.summary_present) && rows.length > 0 && rowIds.every(Boolean);
  const corroborating = [
    ...(display?.selected_bundle_package_ids || []),
    ...(display?.active_toggle_package_ids || []),
  ].map(String);
  return {
    comparable,
    row_count: rows.length,
    summary_package_ids: comparable ? [...new Set(rowIds)] : [],
    // Widens only the "charged but never displayed" direction, never the
    // "displayed but never charged" one.
    displayed_package_ids: comparable
      ? [...new Set([...rowIds, ...corroborating])]
      : [],
  };
}

function reconcileOrderAgainstDisplay({ lines = [], display = null, events = null } = {}) {
  if (!display) {
    return { comparable: false, reason: "checkout display evidence was not captured for this order" };
  }
  if (display.collector_error) {
    return { comparable: false, reason: `checkout display evidence could not be read: ${display.collector_error}` };
  }
  const resolved = displayedPackageIds(display);
  if (!resolved.comparable) {
    return {
      comparable: false,
      reason: display.summary_present
        ? (resolved.row_count
            ? `rendered order summary exposes a package id on only some of its ${resolved.row_count} row(s); per-row data-package-id is required to reconcile`
            : "rendered order summary contains no line rows to reconcile against")
        : "checkout renders no [data-next-cart-summary] order summary to reconcile against",
      row_count: resolved.row_count,
      discount_rows: display.discount_rows || [],
    };
  }

  const nonUpsellLines = (lines || []).filter((line) => !line?.is_upsell);
  const displayed = new Set(resolved.displayed_package_ids);
  const summaryIds = new Set(resolved.summary_package_ids);
  const matchedSummaryIds = new Set();
  const extra = [];
  const unresolved = [];

  for (const line of nonUpsellLines) {
    const meta = events ? campaignPackageMetaForLine(events, line) : null;
    const ref = meta?.ref_id == null ? null : String(meta.ref_id);
    if (!ref) {
      // Bonus, gift and trial lines carry no campaign-package equivalent (the
      // same tolerance linePriceDeltaEvidence applies). An unresolvable line
      // cannot prove a stray charge, so it is reported, never counted as one.
      unresolved.push({ title: line.title, quantity: line.quantity });
      continue;
    }
    if (displayed.has(ref)) {
      if (summaryIds.has(ref)) matchedSummaryIds.add(ref);
      continue;
    }
    extra.push({
      package_ref_id: ref,
      title: line.title,
      quantity: line.quantity,
      price: line.price,
    });
  }

  const missing = [...summaryIds].filter((id) => !matchedSummaryIds.has(id));
  return {
    comparable: true,
    ok: extra.length === 0 && missing.length === 0,
    displayed_package_ids: [...displayed],
    summary_package_ids: [...summaryIds],
    non_upsell_line_count: nonUpsellLines.length,
    extra,
    missing,
    ...(unresolved.length ? { unresolved_lines: unresolved } : {}),
    ...(display.discount_rows?.length ? { discount_rows: display.discount_rows } : {}),
  };
}

function orderDisplayParityAssertion(page, planIdentifier, order) {
  const reconciliation = order?.verification?.display_reconciliation;
  const base = {
    id: `browser-order-display-parity:${planIdentifier}`,
    family: "browser-test-order",
    page,
    expected: "every non-upsell line on the persisted order corresponds to a package the checkout rendered as selected",
  };
  if (!reconciliation) {
    return null;
  }
  if (!reconciliation.comparable) {
    // Named absence rather than silence: a run that could not compare says so
    // in the verdict instead of reading as a clean pass.
    return assertion({
      ...base,
      status: STATUS.SKIPPED,
      actual: reconciliation.reason,
      evidence: reconciliation,
    });
  }
  if (reconciliation.ok) {
    return assertion({
      ...base,
      status: STATUS.PASS,
      actual: `${reconciliation.non_upsell_line_count} non-upsell line(s) reconciled against ${reconciliation.summary_package_ids.length} displayed package(s)`,
      evidence: reconciliation,
    });
  }
  const parts = [];
  if (reconciliation.extra.length) {
    parts.push(`charged but never displayed: ${reconciliation.extra.map((entry) => `${entry.package_ref_id}${entry.title ? ` (${entry.title})` : ""}`).join(", ")}`);
  }
  if (reconciliation.missing.length) {
    parts.push(`displayed but never charged: ${reconciliation.missing.join(", ")}`);
  }
  return assertion({
    ...base,
    status: STATUS.FAIL,
    severity: SEVERITY.BLOCKER,
    actual: parts.join("; "),
    evidence: reconciliation,
  });
}

function assessOrderTotalParity({ display, preUpsellTotal }) {
  if (!display) {
    return { comparable: false, reason: "checkout display evidence was not captured for this order" };
  }
  if (display.collector_error) {
    return { comparable: false, reason: `checkout display evidence could not be read: ${display.collector_error}` };
  }
  const displayedTotal = parseDisplayedMoney(display.total_text);
  if (displayedTotal == null) {
    return {
      comparable: false,
      reason: display.total_text
        ? `checkout total surface rendered "${display.total_text}", which carries no readable amount`
        : 'checkout renders no [data-next-display="cart.total"] surface to compare the order total against',
    };
  }
  // Number(null) is 0 and Number("") is 0: an absent total must not read as a
  // free order that then "mismatches" every displayed amount.
  const rawOrderTotal = typeof preUpsellTotal === "string" ? preUpsellTotal.trim() : preUpsellTotal;
  const orderTotal = rawOrderTotal === null || rawOrderTotal === undefined || rawOrderTotal === ""
    ? NaN
    : Number(rawOrderTotal);
  if (!Number.isFinite(orderTotal)) {
    return { comparable: false, reason: "persisted order carried no readable pre-upsell total" };
  }
  const delta = round2(orderTotal - displayedTotal);
  return {
    comparable: true,
    ok: Math.abs(delta) <= 0.01,
    displayed_total: displayedTotal,
    displayed_total_text: display.total_text,
    order_pre_upsell_total: round2(orderTotal),
    delta,
  };
}

function orderTotalParityAssertion(page, planIdentifier, order) {
  const parity = order?.verification?.total_parity;
  if (!parity) return null;
  const base = {
    id: `browser-order-total-parity:${planIdentifier}`,
    family: "browser-test-order",
    page,
    expected: "the persisted order's pre-upsell total matches the summary total the checkout displayed at submit",
  };
  if (!parity.comparable) {
    return assertion({ ...base, status: STATUS.SKIPPED, actual: parity.reason, evidence: parity });
  }
  return assertion({
    ...base,
    status: parity.ok ? STATUS.PASS : STATUS.FAIL,
    severity: parity.ok ? undefined : SEVERITY.BLOCKER,
    actual: `displayed ${parity.displayed_total}; order ${parity.order_pre_upsell_total}; delta ${parity.delta}`,
    evidence: parity,
  });
}

function testOrderAssertion(page, plan, result) {
  // Accepts a plan object or (legacy) a bare path string.
  const id = planId(plan);
  const path = typeof plan === "string" ? plan : plan.path;
  const planEvidence = typeof plan === "object" && plan?.source ? { plan: summarizeTestOrderPlan(plan) } : {};
  if (result.manual_review) {
    return assertion({
      id: `browser-test-order:${id}`,
      family: "browser-test-order",
      page,
      status: STATUS.MANUAL_REVIEW,
      severity: SEVERITY.WARN,
      expected: "test order created through deployed checkout page",
      actual: `hosted checkout redirect observed: ${result.order?.hosted_checkout_url || "(unknown)"}`,
      evidence: {
        ...planEvidence,
        hosted_checkout_url: result.order?.hosted_checkout_url || null,
        final_url: result.order?.final_url,
        steps: result.order?.evidence?.steps,
        note: "Hosted checkout flow is platform-owned; verify the hosted completion manually.",
      },
    });
  }
  return assertion({
    id: `browser-test-order:${id}`,
    family: "browser-test-order",
    page,
    status: result.ok ? STATUS.PASS : STATUS.FAIL,
    severity: result.ok ? undefined : SEVERITY.BLOCKER,
    expected: "test order created through deployed checkout page",
    actual: result.ok ? result.order.next_order_id || result.order.ref_id : result.error || result.order?.verification?.error || "order not created",
    evidence: result.ok
      ? {
          ...planEvidence,
          ref_id: result.order.ref_id,
          order_number: result.order.next_order_id,
          final_url: result.order.final_url,
          is_test: result.order.is_test,
          line_count: result.order.receipt_line_items.length,
          ...(receiptProofEvidence(result.order) ? { receipt_proof: receiptProofEvidence(result.order) } : {}),
          ...(path === "accept" ? { accepted_upsell_line_present: result.order.verification?.accepted_upsell_line_present } : {}),
          ...(result.order.upsell ? { upsell_clicked: result.order.upsell.clicked, upsell_final_url: result.order.upsell.final_url } : {}),
          ...(result.order.upsell_steps ? { upsell_steps: result.order.upsell_steps.map(summarizeUpsellStep) } : {}),
          ...(result.order.verification?.accepted_upsell_matches ? { accepted_upsell_matches: result.order.verification.accepted_upsell_matches } : {}),
          ...(result.order.verification?.coupon ? { coupon: result.order.verification.coupon } : {}),
          card_last4: result.order.card.last4,
        }
      : {
          ...planEvidence,
          final_url: result.order?.final_url,
          steps: result.order?.evidence?.steps,
          ...(receiptProofEvidence(result.order) ? { receipt_proof: receiptProofEvidence(result.order) } : {}),
          ...(result.order?.verification?.coupon ? { coupon: result.order.verification.coupon } : {}),
          events: result.events,
        },
  });
}

function captureCheckoutEvents(page) {
  const events = { requests: [], responses: [], failed: [], console: [], pageErrors: [], navigations: [] };
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
  page.on("framenavigated", (frame) => {
    try {
      if (typeof page.mainFrame === "function" && frame !== page.mainFrame()) return;
      events.navigations.push({ url: redactUrlQuery(frame.url()) });
    } catch {
      // Navigation evidence is diagnostic only; never break the order path.
    }
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
    navigations: (events.navigations || []).slice(-20).map((navigation) => ({
      url: redactUrlQuery(navigation.url),
    })),
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

async function clickVisibleControlByText(page, pattern, { within = null } = {}) {
  const root = within ? page.locator(within) : page;
  const controls = root.locator('button:visible, a:visible, [role="button"]:visible, input[type="submit"]:visible, input[type="button"]:visible, div[class*="button"]:visible, div[class*="btn"]:visible');
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
  // Optional fields are best-effort: a field that reports visible but cannot
  // accept input (covered by a collapsed section, disabled by the funnel's
  // billing toggle) must not eat the step budget with a full default wait —
  // the focusing click included.
  await locator.click(options.optional ? { timeout: 3000 } : requiredActionTimeout(options)).catch(() => {});
  if (options.optional) {
    return locator.fill(value, { timeout: 3000 }).then(() => true).catch(() => false);
  }
  await locator.fill(value, requiredActionTimeout(options));
  return true;
}

// Required checkout actions are bounded so one stuck field fails as that field
// rather than as an anonymous step timeout. Never LOOSER than Playwright's own
// 30s default: a caller-supplied budget only ever tightens the ceiling, so this
// cannot make a slow-but-working funnel wait longer than it does today.
const MAX_REQUIRED_ACTION_TIMEOUT_MS = 30000;
function requiredActionTimeout(options = {}) {
  const budget = options.actionTimeoutMs;
  if (!Number.isFinite(budget) || budget <= 0) return {};
  return { timeout: Math.min(budget, MAX_REQUIRED_ACTION_TIMEOUT_MS) };
}

async function selectByField(page, field, value, options = {}) {
  const locator = page.locator(`[data-next-checkout-field="${field}"]`).first();
  if (!await fieldUsable(locator, options)) {
    if (options.optional) return false;
    throw new Error(`Missing checkout select: ${field}`);
  }
  if (options.optional) {
    return locator.selectOption(value, { timeout: 3000 }).then(() => true).catch(() => false);
  }
  await locator.selectOption(value, requiredActionTimeout(options));
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

async function billingFieldsCollapsed(page) {
  const locator = page.locator('[data-next-checkout-field="billing-fname"]').first();
  if (!await locator.count().catch(() => 0)) return false;
  if (!await locator.isVisible().catch(() => false)) return true;
  return locator.evaluate((element) => {
    for (let current = element; current; current = current.parentElement) {
      const ariaHidden = current.getAttribute("aria-hidden");
      if (current.hidden || current.inert || (ariaHidden !== null && ariaHidden.toLowerCase() !== "false")) return true;
      if (current.classList.contains("billing-form-collapsed")) return true;
      const style = current.ownerDocument.defaultView.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return true;
    }
    return false;
  }).catch(() => false);
}

async function settleAddressAutocomplete(page) {
  await page.waitForTimeout(750);
  const suggestion = page.locator(".pac-item, .pac-container .pac-item, [role=option]").first();
  if (await suggestion.count().catch(() => 0) && await suggestion.isVisible().catch(() => false)) {
    await suggestion.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

// Some funnels progressively disclose city/province/postal only after real
// keystrokes land in address1 (predictive-address UIs listen for key events,
// which locator.fill() does not synthesize). When the city field exists but
// stays hidden after a plain fill, re-enter address1 with typed keystrokes and
// wait for the disclosure — generic behavior, no funnel-specific hooks.
async function revealProgressiveLocationFields(page, address1) {
  const city = page.locator('[data-next-checkout-field="city"]').first();
  if (!await city.count().catch(() => 0)) return;
  if (await city.isVisible().catch(() => false)) return;
  const input = page.locator('[data-next-checkout-field="address1"]').first();
  await input.click().catch(() => {});
  await input.fill("").catch(() => {});
  await input.pressSequentially(address1, { delay: 25 }).catch(() => {});
  // Dismiss only a predictive-address dropdown the keystrokes opened; a global
  // Escape could close unrelated modals/drawers the funnel has open.
  const suggestions = page.locator(".pac-container, [role=listbox]").first();
  if (await suggestions.isVisible().catch(() => false)) {
    await input.press("Escape").catch(() => {});
  }
  await city.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
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
  // is the default sample: at most four graph-derived shapes for everyday QA.
  // `full` is the explicit opt-in for every actual terminal path.
  if (normalized === "common" || normalized === "true") return testOrderCommonPaths(topologies);
  if (normalized === "full") return fullTestOrderPaths(resolvePrimaryTestOrderTopology(topologies));
  if (normalized === "both") return ["accept", "decline"];
  if (["checkout", "accept", "decline"].includes(normalized)) return [normalized];
  if (/^(accept|decline)(-(accept|decline))+$/.test(normalized)) return [normalized];
  throw new Error(`Unknown --test-order mode: ${mode}`);
}

function resolvePrimaryTestOrderTopology(topologies = []) {
  const checkout = findPage(topologies, "checkout");
  const topology = (topologies || []).find((candidate) => (candidate?.pages || []).includes(checkout)) || { pages: [] };
  return resolveTestOrderTopology(topology, checkout);
}

// --- Spec-driven order planning (--test-order tiers) ---
// Every planned order is a plan object: the ladder path plus the effective
// per-order --select-package / --apply-coupon values. Operator modes produce
// plans that carry the run-global flags unchanged, so the strict-selection and
// coupon read-back machinery is shared verbatim. `tiers` derives the plans
// from what the CampaignSpec itself declares on the checkout page:
//
//   tiers          one strict-selection checkout baseline per declared selector
//                  tier, plus one checkout order per declared coupon code
//   tiers:common   every declared tier crossed with the common path shapes
//   tiers:full     every declared tier crossed with the full set of actual
//                  terminal paths — single-run tier×path coverage
//
// Coupon plans stay single checkout orders on the default selection: coupon
// proof is persisted-order read-back and does not need upsell traversal.
// The --max-test-orders flood guard applies to the expanded plan count.
function testOrderPlans(mode, topologies = [], args = {}, options = {}) {
  const normalized = String(mode || "off").toLowerCase();
  const tiersMatch = /^tiers(?::(checkout|common|full))?$/.exec(normalized);
  if (tiersMatch) return specTierPlans(topologies, args, tiersMatch[1] || "checkout", options);
  const selectPackage = stringArg(args["select-package"]);
  const applyCoupon = stringArg(args["apply-coupon"]);
  const checkoutPage = findPage(topologies, "checkout");
  const topologyPlan = resolvePrimaryTestOrderTopology(topologies);
  return testOrderPaths(mode, topologies).map((path) => ({
    path,
    select_package: selectPackage,
    apply_coupon: applyCoupon,
    checkout_page: checkoutPage,
    topology_plan: topologyPlan,
  }));
}

function specTierPlans(topologies, args, variant, { warn = (line) => process.stderr.write(`${line}\n`) } = {}) {
  for (const flag of ["select-package", "apply-coupon"]) {
    if (stringArg(args[flag])) {
      throw new Error(`--test-order tiers derives package tiers and coupon codes from the CampaignSpec; drop --${flag} or use an explicit mode (common/full/...) with it.`);
    }
  }
  // Every funnel's checkout page contributes plans, and each plan carries the
  // checkout page that declares its tier/coupon so the runner drives THAT
  // page — strict-selecting a ref on a checkout that doesn't render it would
  // fail for the wrong reason. A later funnel's checkout with declarations
  // but no resolvable URL cannot be driven; it is warned about, not dropped
  // silently.
  const primary = findPage(topologies, "checkout");
  if (!primary) {
    throw new Error("--test-order tiers requires a CampaignSpec-driven run with a checkout page; this spec/topology has no checkout page to derive tiers or coupons from (non-packet --site runs have none by design).");
  }
  const plans = [];
  for (const topology of Array.isArray(topologies) ? topologies : []) {
    const pages = Array.isArray(topology?.pages) ? topology.pages : [];
    const checkoutPage = pages.find((page) => String(page?.page_type || "").toLowerCase() === "checkout");
    if (!checkoutPage) continue;
    const tiers = declaredSelectorTiers(checkoutPage);
    const coupons = declaredCheckoutCoupons(checkoutPage);
    if (!tiers.length && !coupons.length) continue;
    if (checkoutPage !== primary && !checkoutPage.url) {
      const declared = [
        ...(tiers.length ? [`tier(s) ${tiers.map((tier) => tier.ref).join(", ")}`] : []),
        ...(coupons.length ? [`coupon(s) ${coupons.map((coupon) => coupon.code).join(", ")}`] : []),
      ].join(" and ");
      warn(`[qa:test-order] checkout page "${checkoutPage.page_id || checkoutPage.label || "(unnamed)"}" declares ${declared} but has no resolvable URL — not covered by this run; fix the page URL/base-url to prove them.`);
      continue;
    }
    // Path shapes come from this checkout's own funnel: crossing tier plans
    // with another funnel's topology would plan unwalkable paths.
    const resolvedTopology = resolveTestOrderTopology(topology, checkoutPage);
    const paths = variant === "common"
      ? testOrderCommonPaths([topology])
      : variant === "full"
        ? fullTestOrderPaths(resolvedTopology)
        : ["checkout"];
    // Plans on the primary checkout keep bare ids (single-funnel specs stay
    // byte-identical); other funnels' plans are qualified by page id so the
    // same ref/code declared on two checkouts cannot collide.
    const qualifier = checkoutPage === primary ? "" : `#${checkoutPage.page_id || checkoutPage.label || "checkout"}`;
    for (const tier of tiers) {
      for (const path of paths) {
        plans.push({
          path,
          select_package: tier.ref,
          apply_coupon: null,
          checkout_page: checkoutPage,
          topology_plan: resolvedTopology,
          id_qualifier: qualifier,
          source: {
            type: "selector_tier",
            ref: tier.ref,
            declared_by: tier.declared_by,
            ...(qualifier ? { checkout_page_id: checkoutPage.page_id || checkoutPage.label || null } : {}),
          },
        });
      }
    }
    for (const coupon of coupons) {
      plans.push({
        path: "checkout",
        select_package: null,
        apply_coupon: coupon.code,
        checkout_page: checkoutPage,
        topology_plan: resolvedTopology,
        id_qualifier: qualifier,
        source: {
          type: "declared_coupon",
          code: coupon.code,
          surfaces: coupon.surfaces,
          ...(qualifier ? { checkout_page_id: checkoutPage.page_id || checkoutPage.label || null } : {}),
        },
      });
    }
  }
  if (!plans.length) {
    throw new Error([
      "--test-order tiers found nothing to iterate: no CampaignSpec checkout page declares selector-tier packages or an enabled exit_intent/promo_code_input offer code.",
      "Use --test-order common/full, or drive explicit refs with --select-package / --apply-coupon.",
    ].join(" "));
  }
  return plans;
}

// Selector tiers are the packages the spec declares on the checkout page —
// same ref tolerance as the doctor's specPackageRecords (ref_id/package_id/id).
function declaredSelectorTiers(checkoutPage) {
  const tiers = [];
  const seen = new Set();
  for (const pkg of Array.isArray(checkoutPage?.packages) ? checkoutPage.packages : []) {
    if (!pkg || typeof pkg !== "object") continue;
    const ref = [pkg.ref_id, pkg.package_id, pkg.id]
      .map((value) => (value == null ? "" : String(value).trim()))
      .find(Boolean);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    tiers.push({ ref, declared_by: stringArg(pkg.name) || stringArg(pkg.title) || undefined });
  }
  return tiers;
}

// Declared coupons follow the repo's offer-surface rule (build-brief, cli
// exit-pop gates): a surface counts only when `enabled === true` and it maps
// an offer_code. Both surfaces mapping the same code collapse into one plan.
function declaredCheckoutCoupons(checkoutPage) {
  const coupons = [];
  const add = (surface, block) => {
    if (!block || typeof block !== "object" || block.enabled !== true) return;
    const code = stringArg(block.offer_code);
    if (!code) return;
    const existing = coupons.find((entry) => normalizeLabel(entry.code) === normalizeLabel(code));
    if (existing) {
      if (!existing.surfaces.includes(surface)) existing.surfaces.push(surface);
      return;
    }
    coupons.push({ code, surfaces: [surface] });
  };
  add("exit_intent", checkoutPage?.exit_intent);
  add("promo_code_input", checkoutPage?.promo_code_input);
  return coupons;
}

function planId(plan) {
  if (typeof plan === "string") return plan;
  const suffix = plan.source?.type === "selector_tier"
    ? `@tier:${plan.source.ref}`
    : plan.source?.type === "declared_coupon"
      ? `@coupon:${plan.source.code}`
      : "";
  return `${plan.path}${suffix}${plan.id_qualifier || ""}`;
}

function normalizeTestOrderPlan(plan, args = {}) {
  if (typeof plan === "string") {
    return { path: plan, select_package: stringArg(args["select-package"]), apply_coupon: stringArg(args["apply-coupon"]) };
  }
  return plan;
}

// Per-order effective args: the plan's selection/coupon values replace the
// run-global flags so every downstream step (strict selection, coupon apply,
// read-back assessment, cart-state echo) sees exactly this order's inputs.
function argsForPlan(args, plan) {
  const merged = { ...args };
  if (plan.select_package != null) merged["select-package"] = plan.select_package;
  else delete merged["select-package"];
  if (plan.apply_coupon != null) merged["apply-coupon"] = plan.apply_coupon;
  else delete merged["apply-coupon"];
  return merged;
}

function summarizeTestOrderPlan(plan) {
  return {
    id: planId(plan),
    path: plan.path,
    ...(plan.select_package ? { select_package: plan.select_package } : {}),
    ...(plan.apply_coupon ? { apply_coupon: plan.apply_coupon } : {}),
    ...(plan.source ? { source: plan.source } : {}),
  };
}

// The default "common shapes" sample: checkout baseline, plus first-offer
// accept and decline when the checkout enters an offer graph, plus the shortest
// real receipt path when that adds coverage. Stays within 1-4 orders so it never
// trips the flood cap. Bundle/quantity and bump coverage come from `--cart`;
// every actual terminal path comes from `full`.
function testOrderCommonPaths(topologies = []) {
  return commonTestOrderPaths(resolvePrimaryTestOrderTopology(topologies));
}

function enforceTestOrderLimit(plans, args) {
  const maxOrders = numberArg(args["max-test-orders"], DEFAULT_MAX_TEST_ORDERS);
  if (plans.length <= maxOrders) return;
  const preview = plans.slice(0, 8).map((plan) => planId(plan)).join(", ");
  const suffix = plans.length > 8 ? ", ..." : "";
  throw new Error([
    `--test-order ${args["test-order"]} expands to ${plans.length} typed-card order(s), above --max-test-orders ${maxOrders}.`,
    `Planned paths: ${preview}${suffix}.`,
    `This cap guards against an accidental order flood, not a permission gate. Use --test-order common for the default sample, or rerun with --max-test-orders ${plans.length} for this exhaustive proof.`,
  ].join(" "));
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
  const packages = [...parseCart(args.cart), ...parseCart(args["select-package"])]
    .map((item) => ({ ref_id: item.packageId, quantity: item.quantity }));
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
    price_incl_tax: line.price_incl_tax ?? null,
    price_excl_tax: line.price_excl_tax ?? null,
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

function upsellActionStepFailures(stepIndex, action, upsell, proof) {
  const failures = [];
  if (upsell?.clicked === false) {
    failures.push(`step ${stepIndex + 1}: ${upsell.error || `upsell ${action} control was not clicked`}`);
  }
  if (action === "accept") {
    failures.push(...upsellAcceptStepFailures(stepIndex, proof, upsell?.api_response_seen));
  } else if (!proof?.ok) {
    failures.push(`step ${stepIndex + 1}: ${proof?.reason || "upsell decline could not be verified"}`);
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
  analyticsCorrectnessCaptureAssertions,
  analyticsCorrectnessRunnerFailureAssertion,
  analyticsParityCaptureAssertions,
  analyticsParityRunnerFailureAssertion,
  acceptedUpsellProof,
  upsellAcceptStepFailures,
  upsellActionStepFailures,
  commerceStructureAssertionFromEvidence,
  primaryCtaAssertionFromEvidence,
  isOrderUpsellsUrl,
  testEmail,
  testOrderPaths,
  testOrderPlans,
  planId,
  argsForPlan,
  enforceTestOrderLimit,
  declaredSelectorTiers,
  declaredCheckoutCoupons,
  packageCardSelectors,
  assessCouponApplication,
  linePriceDeltaEvidence,
  packageMatchesLine,
  rejectedOrderCreateResponse,
  failedOrderCreateRequest,
  extractOrderVouchers,
  orderDiscountTotal,
  assessOrderCreation,
  TEST_ORDER_STEP_LADDER,
  createStepLadder,
  createFieldTrace,
  createUpsellActionTrace,
  fillCheckoutFields,
  cartCreationEvidence,
  cartLineCount,
  requiredActionTimeout,
  recordTestOrderTerminalEvidence,
  collectOrderAnalytics,
  journeyAnalyticsAttempt,
  receiptAnalyticsAttempt,
  stampTestOrderPlan,
  formatStepEvent,
  hostedRedirectInfo,
  redactUrlQuery,
  RESIDUE_PAGE_TYPES,
  computedStyleResidueAssertions,
  logoResidueAssertion,
  methodPaymentArtifacts,
  referencedAssetBasenames,
  paymentChromeResidueAssertion,
  upsellPriceVisibilityAssertion,
  checkoutPriceVisibilityAssertion,
  assessReceiptRendering,
  receiptRenderingAssertion,
  placeholderTextResidueAssertion,
  demoAssetResidueAssertion,
  testOrderAssertion,
  extractReceiptLines,
  EXIT_INTENT_SURFACE_SELECTORS,
  COUPON_INPUT_SELECTORS,
  declaredOfferSurface,
  offerSurfaceEvidence,
  checkoutDisplayEvidence,
  exitIntentSurfaceAssertion,
  promoCodeSurfaceAssertion,
  displayedPackageIds,
  reconcileOrderAgainstDisplay,
  orderDisplayParityAssertion,
  assessOrderTotalParity,
  orderTotalParityAssertion,
  parseDisplayedMoney,
});
