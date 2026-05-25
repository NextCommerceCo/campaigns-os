import { SEVERITY, STATUS } from "./qa-verdict.mjs";

const DEFAULT_BROWSER_TIMEOUT_MS = 30000;
const DEFAULT_SETTLE_TIMEOUT_MS = 5000;
const DEFAULT_TEST_CARD = "6011111111111117";
const DEFAULT_TEST_CVV = "123";
const DEFAULT_TEST_EXP_MONTH = "12";
const DEFAULT_TEST_EXP_YEAR = "2030";
const DEFAULT_MAX_TEST_ORDERS = 6;
const SDK_DEBUGGER_PAGE_TYPES = Object.freeze(["checkout", "upsell", "downsell", "thankyou", "receipt"]);
const ORDER_UPSELLS_RESPONSE_PATTERN = /\/api\/v1\/orders\/[^/?#]+\/upsells\/?(?:[?#].*)?$/i;

export async function runBrowserChecks(topologies, args = {}) {
  const browser = await launchChromium(args);
  const context = await browser.newContext({
    viewport: viewportFromArgs(args),
    extraHTTPHeaders: args["auth-cookie"] ? { Cookie: String(args["auth-cookie"]) } : undefined,
  });

  try {
    const assertions = [];
    for (const topology of topologies) {
      for (const page of topology.pages) {
        assertions.push(...await runPageBrowserChecks(context, page, args));
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
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return { orders, assertions };
}

async function runPageBrowserChecks(context, page, args) {
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

    if (page.page_type === "upsell") {
      assertions.push(...await renderedUpsellControlAssertions(browserPage, page));
    }
    if (page.page_type === "checkout") {
      assertions.push(...await checkoutPaymentSurfaceAssertions(browserPage, page));
    }
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
      next_step: "Run --test-order with allowlist/sandbox confirmation for typed-card checkout proof.",
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
  return assertions;
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

async function runSingleBrowserTestOrder(context, checkoutPage, path, args, runId) {
  const page = await context.newPage();
  page.setDefaultTimeout(numberArg(args["browser-timeout"], DEFAULT_BROWSER_TIMEOUT_MS));
  const events = captureCheckoutEvents(page);
  const email = testEmail(args, runId);

  try {
    await gotoAndSettle(page, checkoutPage.url, args);
    await selectRequestedCart(page, args);
    await advanceToCheckoutForm(page);
    await fillCheckoutFields(page, args, email);
    await fillPaymentFields(page, args);
    await submitCheckout(page);
    await waitForCheckoutResult(page);

    const order = await buildOrderEvidence({ page, events, path, email, checkoutPage, args });
    const stepFailures = [];
    const upsellSteps = testOrderSteps(path);

    if (order.ok && upsellSteps.length) {
      order.upsell_steps = [];
    }

    for (let stepIndex = 0; order.ok && stepIndex < upsellSteps.length; stepIndex += 1) {
      const step = upsellSteps[stepIndex];
      const initialLineItems = order.receipt_line_items.slice();
      const initialUpsellMutationCount = upsellMutationCount(events);
      await waitForUpsellPageReady(page, args);
      const upsell = await clickUpsellPath(page, step, { events, stepIndex });
      const preferredOrderBody = upsell.api_response_order_body || null;
      delete upsell.api_response_order_body;
      order.upsell = upsell;
      order.upsell_steps.push(upsell);
      order.final_url = page.url();
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
        if (!upsell.api_response_seen) stepFailures.push(`step ${stepIndex + 1}: upsell accept did not call order upsell API`);
        if (!proof.ok) stepFailures.push(`step ${stepIndex + 1}: ${proof.reason}`);
      } else {
        const proof = declinedUpsellProof(order.receipt_line_items, initialLineItems, events, initialUpsellMutationCount);
        upsell.verification = proof;
        if (!proof.ok) stepFailures.push(`step ${stepIndex + 1}: ${proof.reason}`);
      }
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
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      order: {
        path,
        ok: false,
        next_order_id: null,
        ref_id: null,
        qa_email: email ? "[redacted-qa-email]" : null,
        final_url: page.url(),
        verification: { verified: false, error: error instanceof Error ? error.message : String(error) },
        evidence: { events: sanitizedEvents(events) },
      },
      events: sanitizedEvents(events),
    };
  } finally {
    await page.close().catch(() => {});
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
  if (normalized === "full") return ["checkout", ...testOrderPathMatrix(testOrderDepth(topologies))];
  if (normalized === "both") return ["accept", "decline"];
  if (["checkout", "accept", "decline"].includes(normalized)) return [normalized];
  if (/^(accept|decline)(-(accept|decline))+$/.test(normalized)) return [normalized];
  throw new Error(`Unknown --test-order mode: ${mode}`);
}

function enforceTestOrderLimit(paths, args) {
  const maxOrders = numberArg(args["max-test-orders"], DEFAULT_MAX_TEST_ORDERS);
  if (paths.length <= maxOrders) return;
  const preview = paths.slice(0, 8).join(", ");
  const suffix = paths.length > 8 ? ", ..." : "";
  throw new Error([
    `--test-order ${args["test-order"]} expands to ${paths.length} typed-card order(s), above --max-test-orders ${maxOrders}.`,
    `Planned paths: ${preview}${suffix}.`,
    "Choose explicit accept/decline paths for a smaller sample matrix, or rerun with a higher --max-test-orders after operator approval.",
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

function testEmail(args, runId) {
  const explicit = stringArg(args["test-email"]);
  if (explicit) return explicit;
  const prefix = stringArg(args["test-email-prefix"]) || "qa+campaigns-os";
  return `${prefix}-${String(runId).toLowerCase()}-${Date.now()}@example.com`;
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
  isOrderUpsellsUrl,
});
