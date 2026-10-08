export const OFFER_PAGE_TYPES = new Set(["upsell", "downsell"]);
export const RECEIPT_PAGE_TYPES = new Set(["receipt", "thankyou"]);
const ACTIONS = Object.freeze([
  ["decline", "expected_decline_url"],
  ["accept", "expected_accept_url"],
]);

// The page types of a checkout path, as pageType() spells them (lowercase, `_`
// and `-` dropped). `checkout` is the page that takes payment; `select` and
// `checkout_step` lead into it without placing an order (campaigns-os#641).
const PAYMENT_PAGE_TYPE = "checkout";
const PRE_PAYMENT_PAGE_TYPES = new Set(["select", "checkoutstep"]);

export function isPaymentTopologyPage(page) {
  return pageType(page) === PAYMENT_PAGE_TYPE;
}

export function isCheckoutStepTopologyPage(page) {
  return pageType(page) === "checkoutstep";
}

// Follow forward links (expected_next_url) from `start` to the page that takes
// payment. Null when the walk leaves the topology, loops, or reaches any page
// that is neither a pre-payment page nor the Checkout.
export function paymentPageFrom(topology, start) {
  const pages = Array.isArray(topology?.pages) ? topology.pages : [];
  const seen = new Set();
  let page = start || null;
  while (page && !seen.has(page)) {
    seen.add(page);
    if (isPaymentTopologyPage(page)) return page;
    const key = canonicalHttpUrl(page.expected_next_url);
    const next = key ? pages.find((candidate) => canonicalHttpUrl(candidate?.url) === key) : null;
    if (!next) return null;
    if (!isPaymentTopologyPage(next) && !PRE_PAYMENT_PAGE_TYPES.has(pageType(next))) return null;
    page = next;
  }
  return null;
}

// The topology's entry pages: flagged is_entry, else those no page links to
// (offer and receipt pages excluded: an orphaned upsell is not where a shopper
// starts), else the first page. Never decided by page names.
function topologyEntryPages(pages) {
  const flagged = pages.filter((page) => page?.is_entry === true);
  if (flagged.length) return flagged;
  const targeted = new Set();
  for (const page of pages) {
    for (const field of ["expected_next_url", "expected_accept_url", "expected_decline_url"]) {
      const key = canonicalHttpUrl(page?.[field]);
      if (key && key !== canonicalHttpUrl(page?.url)) targeted.add(key);
    }
  }
  const roots = pages.filter((page) => {
    const key = canonicalHttpUrl(page?.url);
    const type = pageType(page);
    return !(key && targeted.has(key)) && !OFFER_PAGE_TYPES.has(type) && !RECEIPT_PAGE_TYPES.has(type);
  });
  return roots.length ? roots : pages.slice(0, 1);
}

// Every Checkout the topology's entry paths reach, in entry order, then any
// Checkout no entry path reaches (a landing CTA into checkout declares no
// forward field). "The first page typed checkout" is never the answer on its
// own: on a multi-step path it is a step, and with split-test paths there are
// several (campaigns-os#641).
export function paymentPagesForTopology(topology) {
  const pages = Array.isArray(topology?.pages) ? topology.pages : [];
  const out = [];
  for (const entry of topologyEntryPages(pages)) {
    const checkout = paymentPageFrom(topology, entry);
    if (checkout && !out.includes(checkout)) out.push(checkout);
  }
  for (const page of pages) if (isPaymentTopologyPage(page) && !out.includes(page)) out.push(page);
  return out;
}

// The Checkout of the first entry path of the first topology that has one.
export function findPaymentPage(topologies = []) {
  for (const topology of Array.isArray(topologies) ? topologies : []) {
    const page = paymentPagesForTopology(topology)[0];
    if (page) return page;
  }
  return null;
}

// The pages a shopper passes through to reach `checkoutPage`, in order and
// ending with it: an optional select page, then each checkout_step, then the
// Checkout. Walks backwards over forward links, so it holds whichever path the
// Checkout sits on; where two pages lead into the same page a checkout_step is
// preferred over a select page, which can only start the chain.
export function checkoutPathPages(topology, checkoutPage) {
  const pages = Array.isArray(topology?.pages) ? topology.pages : [];
  if (!checkoutPage) return [];
  const chain = [checkoutPage];
  const seen = new Set(chain);
  let current = checkoutPage;
  for (;;) {
    const key = canonicalHttpUrl(current?.url);
    if (!key) break;
    const leading = pages.filter((page) => !seen.has(page)
      && PRE_PAYMENT_PAGE_TYPES.has(pageType(page))
      && canonicalHttpUrl(page?.expected_next_url) === key);
    const previous = leading.find(isCheckoutStepTopologyPage) || leading[0] || null;
    if (!previous) break;
    chain.unshift(previous);
    seen.add(previous);
    if (!isCheckoutStepTopologyPage(previous)) break;
    current = previous;
  }
  return chain;
}

// Only the checkout_step pages of that path, in order.
export function checkoutStepPages(topology, checkoutPage) {
  return checkoutPathPages(topology, checkoutPage).filter(isCheckoutStepTopologyPage);
}

export function resolveTestOrderTopology(topology = {}, checkoutPage = null) {
  const pages = Array.isArray(topology?.pages) ? topology.pages : [];
  // A caller may hand in a select or checkout_step page; the path's Checkout is
  // the page whose forward link leads to the offers. Starting from a step made
  // its next step a `nonterminal_target` and hid every offer path.
  const given = checkoutPage && !isPaymentTopologyPage(checkoutPage) && PRE_PAYMENT_PAGE_TYPES.has(pageType(checkoutPage))
    ? paymentPageFrom(topology, checkoutPage) || checkoutPage
    : checkoutPage;
  const checkout = given || paymentPagesForTopology(topology)[0] || null;
  const pagesByUrl = new Map();
  for (const page of pages) {
    const key = canonicalHttpUrl(page?.url);
    if (key && !pagesByUrl.has(key)) pagesByUrl.set(key, page);
  }
  const topologyOrigin = httpOrigin(checkout?.url) || pages.map((page) => httpOrigin(page?.url)).find(Boolean) || null;

  const terminalPaths = [];
  const invalidPaths = [];
  const entry = checkout ? targetNode(checkout.expected_next_url, pagesByUrl, topologyOrigin) : null;
  if (entry?.kind === "offer") {
    walkOffer(entry.page, [], new Set(), pagesByUrl, topologyOrigin, terminalPaths, invalidPaths);
  } else if (entry?.kind === "invalid") {
    invalidPaths.push({ path: "checkout", reason: entry.reason, target: entry.target });
  }
  const recognizedTerminals = dedupeTerminals([
    ...pages
      .filter((page) => RECEIPT_PAGE_TYPES.has(pageType(page)) && canonicalHttpUrl(page?.url))
      .map((page) => ({ kind: "receipt", page_id: page.page_id || null, url: page.url })),
    ...(entry?.kind === "terminal" ? [entry.terminal] : []),
    ...terminalPaths.map((candidate) => candidate.terminal),
  ]);
  // Every declared offer page with the offer page each action leads to, so a
  // planned path that stops short of a terminal can still be walked to the
  // controls it clicks.
  const offerEdges = [];
  for (const [key, page] of pagesByUrl) {
    if (!OFFER_PAGE_TYPES.has(pageType(page))) continue;
    const edge = { key, page_id: page.page_id || null, page_type: page.page_type || null, url: page.url };
    for (const [action, field] of ACTIONS) {
      const target = targetNode(page?.[field], pagesByUrl, topologyOrigin);
      edge[`${action}_key`] = target?.kind === "offer" ? canonicalHttpUrl(target.page.url) : null;
    }
    offerEdges.push(edge);
  }

  return {
    topology_id: topology?.funnel_id || "default",
    checkout_page_id: checkout?.page_id || null,
    checkout_url: checkout?.url || null,
    // Retain every declared page for diagnostics, including malformed rows.
    // pageAtUrl still matches only canonical HTTP URLs, but the resolved plan
    // does not silently erase the topology evidence that explains a miss.
    route_pages: pages.map((page) => ({
      page_id: page.page_id || null,
      page_type: page.page_type || null,
      url: page.url || null,
    })),
    has_offer_entry: entry?.kind === "offer",
    full_paths: terminalPaths.map((candidate) => candidate.path),
    terminal_paths: terminalPaths,
    invalid_paths: invalidPaths,
    recognized_terminals: recognizedTerminals,
    entry_offer_key: entry?.kind === "offer" ? canonicalHttpUrl(entry.page.url) : null,
    offer_edges: offerEdges,
  };
}

export function terminalAtUrl(resolvedTopology, value) {
  const key = canonicalHttpUrl(value);
  if (!key) return null;
  return (resolvedTopology?.recognized_terminals || []).find((terminal) => canonicalHttpUrl(terminal?.url) === key) || null;
}

export function pageAtUrl(resolvedTopology, value) {
  const key = canonicalHttpUrl(value);
  if (!key) return null;
  return (resolvedTopology?.route_pages || []).find((page) => canonicalHttpUrl(page?.url) === key) || null;
}

export function remainingActionDisposition(resolvedTopology, value, remainingActions = []) {
  if (!Array.isArray(remainingActions) || !remainingActions.length) return { stop: false };
  const terminal = terminalAtUrl(resolvedTopology, value);
  if (!terminal) return { stop: false };
  return { stop: true, terminal, remaining_actions: [...remainingActions] };
}

export function fullTestOrderPaths(resolvedTopology) {
  const invalid = Array.isArray(resolvedTopology?.invalid_paths) ? resolvedTopology.invalid_paths : [];
  if (invalid.length) {
    const details = invalid
      .map((candidate) => `${candidate.path || "checkout"}: ${candidate.reason}${candidate.target ? ` (${candidate.target})` : ""}`)
      .join("; ");
    throw new Error(
      `--test-order full cannot enumerate actual terminal paths for funnel ${resolvedTopology?.topology_id || "default"}: ${details}`,
    );
  }
  return ["checkout", ...(resolvedTopology?.full_paths || [])];
}

export function commonTestOrderPaths(resolvedTopology) {
  if (resolvedTopology?.has_offer_entry !== true) return ["checkout"];
  const paths = ["checkout", "accept", "decline"];
  const receiptPaths = (resolvedTopology?.terminal_paths || [])
    .filter((candidate) => candidate?.terminal?.kind === "receipt")
    .slice()
    .sort(compareCommonReceiptPaths);
  const shortest = receiptPaths[0]?.path;
  if (shortest && !paths.includes(shortest)) paths.push(shortest);
  return paths;
}

// The default `common` depth (#530). The sample above never reached a
// downsell's decline, so a broken decline link passed QA. When every actual
// terminal path fits under the cap, `common` runs them all. Above the cap it
// keeps the sample and adds, for each offer page whose decline no planned path
// clicks yet, the shortest path that clicks it, until the cap is reached. A
// page counts as covered only when its decline is clicked: arriving at it, or
// clicking its accept, does not. Pages still uncovered are returned, not
// dropped. The sample is never trimmed, so a cap below it is still refused by
// the flood guard exactly as before.
export function commonTestOrderPlan(resolvedTopology, { cap } = {}) {
  const baseline = commonTestOrderPaths(resolvedTopology);
  let full = null;
  try {
    full = fullTestOrderPaths(resolvedTopology);
  } catch {
    full = null;
  }
  const plan = {
    requested_depth: "common",
    cap,
    full_path_count: full ? full.length : null,
    baseline_paths: baseline,
  };
  if (full && full.length <= cap) {
    // Same set as `full`; the sample's paths keep their place at the front.
    const paths = [...baseline.filter((path) => full.includes(path)), ...full.filter((path) => !baseline.includes(path))];
    return { ...plan, effective_depth: "full", reason: "under_cap", paths, coverage_paths: [], uncovered_pages: [] };
  }

  const paths = baseline.slice();
  const coveragePaths = [];
  const offers = offerPagesByReach(resolvedTopology);
  for (const offer of offers) {
    if (paths.length >= cap) break;
    const declined = declinedOfferKeys(resolvedTopology, paths);
    if (declined.has(offer.key) || !offer.reach) continue;
    const candidate = shortestDeclinePath(resolvedTopology, offer, declined);
    if (!candidate || paths.includes(candidate)) continue;
    paths.push(candidate);
    coveragePaths.push(candidate);
  }
  const declined = declinedOfferKeys(resolvedTopology, paths);
  const uncovered = offers
    .filter((offer) => !declined.has(offer.key))
    .map((offer) => ({
      page_id: offer.page_id,
      page_type: offer.page_type,
      reason: offer.reach ? "cap" : "unreachable",
    }));
  return {
    ...plan,
    effective_depth: "common",
    reason: full ? "over_cap" : "full_not_enumerable",
    paths,
    coverage_paths: coveragePaths,
    uncovered_pages: uncovered,
  };
}

// The offer pages a planned path clicks, in click order: `checkout` clicks
// none, `decline-accept` clicks the entry offer's decline and then the accept
// on whichever offer that decline leads to. A walk stops where the topology
// leaves the offer graph, as the runner does.
export function testOrderPathClicks(resolvedTopology, path) {
  const normalized = String(path || "").toLowerCase();
  const steps = !normalized || normalized === "checkout" ? [] : normalized.split("-");
  const edges = new Map((resolvedTopology?.offer_edges || []).map((edge) => [edge.key, edge]));
  const clicks = [];
  let current = edges.get(resolvedTopology?.entry_offer_key) || null;
  for (const step of steps) {
    if (!current) break;
    clicks.push({ key: current.key, page_id: current.page_id, action: step });
    current = edges.get(current[`${step}_key`]) || null;
  }
  return clicks;
}

function declinedOfferKeys(resolvedTopology, paths) {
  const keys = new Set();
  for (const path of paths) {
    for (const click of testOrderPathClicks(resolvedTopology, path)) {
      if (click.action === "decline") keys.add(click.key);
    }
  }
  return keys;
}

// Declared offer pages, shallowest first, each with the shortest action
// sequence that reaches it (accept before decline on a tie) or null when no
// path from the checkout reaches it.
function offerPagesByReach(resolvedTopology) {
  const edges = resolvedTopology?.offer_edges || [];
  const byKey = new Map(edges.map((edge) => [edge.key, edge]));
  const reach = new Map();
  const entry = resolvedTopology?.entry_offer_key;
  if (entry && byKey.has(entry)) {
    reach.set(entry, []);
    const queue = [entry];
    while (queue.length) {
      const key = queue.shift();
      for (const action of ["accept", "decline"]) {
        const next = byKey.get(key)?.[`${action}_key`];
        if (!next || reach.has(next) || !byKey.has(next)) continue;
        reach.set(next, [...reach.get(key), action]);
        queue.push(next);
      }
    }
  }
  const reached = [...reach.keys()].map((key) => ({ ...byKey.get(key), reach: reach.get(key) }));
  const unreached = edges.filter((edge) => !reach.has(edge.key)).map((edge) => ({ ...edge, reach: null }));
  return [...reached, ...unreached];
}

// The shortest actual terminal path that clicks this offer's decline. Among
// equally short paths, the one that also clicks the most still-undeclined
// offers wins, then accept before decline. Where no terminal path clicks it
// (the graph beyond is not enumerable), the path that reaches the offer and
// declines it.
function shortestDeclinePath(resolvedTopology, offer, declined) {
  const newlyDeclined = (path) => new Set(testOrderPathClicks(resolvedTopology, path)
    .filter((click) => click.action === "decline" && !declined.has(click.key))
    .map((click) => click.key)).size;
  const candidates = (resolvedTopology?.terminal_paths || [])
    .filter((candidate) => testOrderPathClicks(resolvedTopology, candidate.path)
      .some((click) => click.key === offer.key && click.action === "decline"))
    .map((candidate) => ({ ...candidate, gain: newlyDeclined(candidate.path) }))
    .sort((left, right) => (left.steps.length - right.steps.length)
      || (right.gain - left.gain)
      || compareActionSteps(left.steps, right.steps));
  if (candidates.length) return candidates[0].path;
  return [...offer.reach, "decline"].join("-");
}

function compareCommonReceiptPaths(left, right) {
  const lengthDelta = (left?.steps?.length || 0) - (right?.steps?.length || 0);
  if (lengthDelta) return lengthDelta;
  if (left?.path === "accept-decline" && right?.path !== "accept-decline") return -1;
  if (right?.path === "accept-decline" && left?.path !== "accept-decline") return 1;
  return compareActionSteps(left?.steps || [], right?.steps || []);
}

function compareActionSteps(left, right) {
  const rank = { accept: 0, decline: 1 };
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === right[index]) continue;
    return (rank[left[index]] ?? 2) - (rank[right[index]] ?? 2);
  }
  return left.length - right.length;
}

function walkOffer(page, steps, visited, pagesByUrl, topologyOrigin, terminalPaths, invalidPaths) {
  const pageKey = canonicalHttpUrl(page?.url) || `page:${page?.page_id || "unknown"}`;
  if (visited.has(pageKey)) {
    invalidPaths.push({ path: steps.join("-"), reason: "cycle", target: page?.url || page?.page_id || null });
    return;
  }
  const nextVisited = new Set(visited).add(pageKey);

  for (const [action, field] of ACTIONS) {
    const nextSteps = [...steps, action];
    const target = targetNode(page?.[field], pagesByUrl, topologyOrigin);
    if (target?.kind === "terminal") {
      terminalPaths.push({
        path: nextSteps.join("-"),
        steps: nextSteps,
        terminal: target.terminal,
      });
    } else if (target?.kind === "offer") {
      walkOffer(target.page, nextSteps, nextVisited, pagesByUrl, topologyOrigin, terminalPaths, invalidPaths);
    } else if (target?.kind === "invalid") {
      invalidPaths.push({ path: nextSteps.join("-"), reason: target.reason, target: target.target });
    }
  }
}

function targetNode(value, pagesByUrl, topologyOrigin) {
  const key = canonicalHttpUrl(value);
  if (!key) {
    return value == null || String(value).trim() === ""
      ? { kind: "invalid", reason: "missing_route", target: null }
      : { kind: "invalid", reason: "unresolved_target", target: String(value) };
  }
  const page = pagesByUrl.get(key);
  if (page) {
    const type = pageType(page);
    if (RECEIPT_PAGE_TYPES.has(type)) {
      return {
        kind: "terminal",
        terminal: { kind: "receipt", page_id: page.page_id || null, url: page.url || value },
      };
    }
    if (OFFER_PAGE_TYPES.has(type)) return { kind: "offer", page };
    return { kind: "invalid", reason: "nonterminal_target", target: page.url || value };
  }
  if (topologyOrigin && httpOrigin(key) !== topologyOrigin) {
    return {
      kind: "terminal",
      terminal: { kind: "external_handoff", page_id: null, url: value },
    };
  }
  return { kind: "invalid", reason: "unresolved_target", target: value };
}

function dedupeTerminals(terminals) {
  const seen = new Set();
  const deduped = [];
  for (const terminal of terminals) {
    const key = canonicalHttpUrl(terminal?.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(terminal);
  }
  return deduped;
}

export function canonicalHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol)) return null;
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname
      .replace(/\/index\.html$/i, "/")
      .replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function httpOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

function pageType(page) {
  return String(page?.page_type || "").toLowerCase().replace(/[-_]/g, "");
}
