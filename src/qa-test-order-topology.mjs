const OFFER_PAGE_TYPES = new Set(["upsell", "downsell"]);
const RECEIPT_PAGE_TYPES = new Set(["receipt", "thankyou"]);
const ACTIONS = Object.freeze([
  ["decline", "expected_decline_url"],
  ["accept", "expected_accept_url"],
]);

export function resolveTestOrderTopology(topology = {}, checkoutPage = null) {
  const pages = Array.isArray(topology?.pages) ? topology.pages : [];
  const checkout = checkoutPage || pages.find((page) => pageType(page) === "checkout") || null;
  const pagesByUrl = new Map();
  for (const page of pages) {
    const key = canonicalHttpUrl(page?.url);
    if (key && !pagesByUrl.has(key)) pagesByUrl.set(key, page);
  }
  const topologyOrigin = httpOrigin(checkout?.url) || pages.map((page) => httpOrigin(page?.url)).find(Boolean) || null;

  const terminalPaths = [];
  const invalidPaths = [];
  const entry = checkout?.expected_next_url ? targetNode(checkout.expected_next_url, pagesByUrl, topologyOrigin) : null;
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

  return {
    topology_id: topology?.funnel_id || "default",
    checkout_page_id: checkout?.page_id || null,
    checkout_url: checkout?.url || null,
    has_offer_entry: entry?.kind === "offer",
    full_paths: terminalPaths.map((candidate) => candidate.path),
    terminal_paths: terminalPaths,
    invalid_paths: invalidPaths,
    recognized_terminals: recognizedTerminals,
  };
}

export function terminalAtUrl(resolvedTopology, value) {
  const key = canonicalHttpUrl(value);
  if (!key) return null;
  return (resolvedTopology?.recognized_terminals || []).find((terminal) => canonicalHttpUrl(terminal?.url) === key) || null;
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

function canonicalHttpUrl(value) {
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
