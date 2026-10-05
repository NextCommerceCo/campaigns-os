// Content parameters work at runtime: for each declared
// analytics.params.content entry and applicable page, `qa run --browser` loads
// the page twice, each time in a fresh browser context: once without the
// parameter (baseline) and once with `?<name>=n` (param_n). After the SDK's
// display pass it checks that the same elements whose data-next-hide or
// data-next-show refers to the parameter are visible at baseline and hidden
// with `n`. One row per (param, page): content_param:<page>:<name>, with the
// verdict assertion qc.content_param:<name>:<page> (family browser-runtime).
//
// This module holds the pure expression classifier, the target identity
// matcher, the result rules and the browser driver. The driver gets its
// browser contexts and its URL helper from qa-browser.mjs (runBrowserChecks),
// so the launch, viewport and auth policy stay there.
//
// Privacy: expression text is read in memory only. The observation keeps the
// sha256 of each expression (expr_sha256), its form id and prediction, a
// structural element_path ("body>main[0]>section[1]"), presence, visibility,
// stability, readiness outcomes and counts. No expression text, query string
// or URL is stored; the variant is the label "param_n".
//
// rederiveQcResult(observation) is the rule the QC readers call; the producer
// builds every row through it, so a stored row only stands when its stored
// observation re-derives to the same result.
//
// SDK pin. The supported forms and their predictions follow campaign-cart
// 12ba5d14: AttributeParser.parseCondition
// (src/core/base/attribute-parser.ts lines 244-371), the param evaluator
// (src/features/display/conditional-display/conditional-display.param-conditions.ts
// lines 10-171) and the show-over-hide choice
// (src/features/display/conditional-display/conditional-display.enhancer.ts
// lines 64-75 and 128-140). Both the parser's parseCondition and the param
// evaluator are unchanged at the v0.4.38 tag, the pin of the vendored
// attribute index (src/sdk-attribute-index.mjs); the only attribute-parser.ts
// difference between the two is element-type detection outside
// parseCondition. Readiness follows the same commit:
// body[data-next-sdk-loading="false"] (src/core/sdk-initializer/sdk-initializer.ts)
// or html.next-display-ready, then one macrotask and one animation frame.
//
// Every DOM read runs in an isolated world (see "Browser driver"), never in
// the page's own world.
import { createHash } from "node:crypto";

import { runWithDeadline } from "./deadline.mjs";
import { aggregateQcResults, buildQcResult, toQaAssertion } from "./qc-results.mjs";

export const CONTENT_PARAM_CHECK = "content_param";
const FAMILY = "browser-runtime";
const PARAM_VALUE = "n";

// Cost bound: at most 8 (param, page) pairs, two loads each, in sequence; per
// load, navigation up to 20 s and readiness up to 8 s; the whole leg adds at
// most 60 s.
export const CONTENT_PARAM_LIMITS = Object.freeze({
  maxPairs: 8,
  navigationMs: 20_000,
  readinessMs: 8_000,
  budgetMs: 60_000,
});
// What the leg's budget timer settles with when it fires.
const BUDGET_CUT = Symbol("budget cut");

const READINESS = Object.freeze(["ready", "readiness_timeout", "navigation_failed", "page_not_served"]);
const VARIANTS = Object.freeze(["baseline", "param_n"]);
const ATTRS = Object.freeze(["hide", "show"]);
const FORMS = Object.freeze(["presence", "equals", "not_equals", "has", "is", "unsupported"]);
const PREDICTIONS = Object.freeze(["hidden", "visible", "unknown"]);
const LIMITS = Object.freeze(["budget_exhausted", "browser_checks_not_requested"]);
const BUDGET_EXHAUSTED = "budget_exhausted";
const NOT_REQUESTED = "browser_checks_not_requested";
const EXPR_HASH = /^sha256:[a-f0-9]{64}$/;
const ABSENT = Object.freeze({ present: false, visible: false, stable: false });

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

export const expressionHash = (text) => `sha256:${createHash("sha256").update(String(text)).digest("hex")}`;

// ---------------------------------------------------------------------------
// Declared pairs

// Every (param, page) pair to check, one per distinct (name, page), in
// declaration order: each analytics.params.content entry in turn (its name
// trimmed), then the pages its `pages` lists, or every page of the run's
// topologies when `pages` is absent. The doctor's static content-param check
// reads every entry the same way, so a name declared twice covers the pages
// of both entries. A listed page id that is not one of the run's pages still
// gets its pair, with no URL: it reads navigation_failed, never silence.
export function contentParamPairs(spec, topologies) {
  const pages = [];
  for (const topology of Array.isArray(topologies) ? topologies : []) {
    for (const page of Array.isArray(topology?.pages) ? topology.pages : []) {
      const id = page?.page_id == null ? "" : String(page.page_id);
      if (!id || pages.some((known) => known.id === id)) continue;
      pages.push({ id, url: page.url || null });
    }
  }
  const content = spec?.analytics?.params?.content;
  const pairs = [];
  const seen = new Set();
  for (const entry of Array.isArray(content) ? content : []) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    const ids = Array.isArray(entry.pages) ? entry.pages.map(String) : pages.map((page) => page.id);
    for (const id of ids) {
      const key = JSON.stringify([name, id]);
      if (!id || seen.has(key)) continue;
      seen.add(key);
      pairs.push({ param: name, page: id, url: pages.find((page) => page.id === id)?.url ?? null });
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Expression classifier

// The reference scan and the classifier read an expression through one
// tokenizer, so every expression the classifier can classify for a param is
// one the scan lists. Tokens: identifiers (`[A-Za-z_][\w-]*`; the declared
// name is one token wherever an identifier could start, whatever characters
// it holds), quoted strings ('…', "…" or `…`, to the matching quote or the
// end), the operators ===, !==, ==, !=, >=, <=, && and ||, and any other
// character on its own. Whitespace (newlines and tabs included) separates
// tokens; each token keeps its offsets, so a form can require two tokens to
// touch.
const IDENT_CHAR = /[\w-]/;
const IDENT = /[A-Za-z_][\w-]*/y;
const OPERATORS = Object.freeze(["===", "!==", "==", "!=", ">=", "<=", "&&", "||"]);

function tokenize(expression, name) {
  const text = String(expression ?? "");
  const tokens = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (/\s/.test(char)) {
      at += 1;
      continue;
    }
    const start = at;
    if (char === "'" || char === '"' || char === "`") {
      const close = text.indexOf(char, at + 1);
      const end = close === -1 ? text.length : close + 1;
      tokens.push({ type: "string", quote: char, value: text.slice(at + 1, close === -1 ? end : close), closed: close !== -1, start, end });
      at = end;
      continue;
    }
    const identStart = at === 0 || !IDENT_CHAR.test(text[at - 1]);
    if (name && identStart && text.startsWith(name, at) && !IDENT_CHAR.test(text[at + name.length] ?? "")) {
      at += name.length;
      tokens.push({ type: "ident", value: name, name: true, start, end: at });
      continue;
    }
    IDENT.lastIndex = at;
    const ident = IDENT.exec(text);
    if (ident) {
      at += ident[0].length;
      tokens.push({ type: "ident", value: ident[0], name: false, start, end: at });
      continue;
    }
    const operator = OPERATORS.find((candidate) => text.startsWith(candidate, at));
    at += operator ? operator.length : 1;
    tokens.push({ type: operator ? "operator" : "punct", value: operator ?? char, start, end: at });
  }
  return tokens;
}

const isRoot = (token) => token?.type === "ident" && (token.value === "param" || token.value === "params");
const isPunct = (token, value) => token?.type === "punct" && token.value === value;
const touching = (tokens, from, to) => tokens.slice(from, to).every((token, index) => token.end === tokens[from + index + 1].start);
// A backslash, a backquote, a bracket or a comment marker: no supported form
// holds one, wherever it stands.
const UNRECOGNISED_CHARS = /[\\`[]|\/\*|\*\/|\/\//;

// The supported form `expression` is for the param `name`, or null when it is
// not wholly one of them naming exactly `name`.
function recognisedForm(expression, name) {
  const text = String(expression ?? "");
  return UNRECOGNISED_CHARS.test(text) ? null : supportedForm(tokenize(text, name), name);
}

// Whether `expression` is wholly a supported form naming one param other
// than `name`. The candidates are its identifiers and quoted strings.
function namesOtherParam(expression, name) {
  const candidates = new Set(tokenize(expression).filter((token) => token.type === "ident" || token.type === "string").map((token) => token.value));
  candidates.delete(name);
  return [...candidates].some((other) => other !== "" && recognisedForm(expression, other) !== null);
}

// Whether `expression` refers to the param `name`, by a closed list. It is a
// target expression only when the classifier wholly recognises it as a
// supported form naming exactly `name`. It is irrelevant to `name` only when
// it is wholly a supported form naming another param, or holds no `param`
// at all (any case, anywhere). Every other expression holding `param` (in a
// string, a comment, an escape or a template literal included) refers to
// every declared param and classifies as unsupported: a review member.
export function referencesParam(expression, name) {
  const text = String(expression ?? "");
  if (recognisedForm(text, name)) return true;
  return /param/i.test(text) && !namesOtherParam(text, name);
}

// A string literal the parser reads as one value: single or double quotes,
// none of the characters it splits conditions on. An unquoted literal is an
// identifier, except the booleans, which are no string comparison.
function literalOf(token) {
  if (token?.type === "string") return token.closed && token.quote !== "`" && !/['"=!<>&|()]/.test(token.value) ? token.value : null;
  if (token?.type === "ident" && /^[A-Za-z_][\w-]*$/.test(token.value) && !["true", "false"].includes(token.value)) return token.value;
  return null;
}
// The param's name as a function argument: bare, or in single or double
// quotes.
const namesParam = (token, name) => (token?.type === "ident" && token.name)
  || (token?.type === "string" && token.closed && token.quote !== "`" && token.value === name);

// The form of one expression's tokens and the condition it reads with
// `?<name>=n`, or null when it is not a supported form. `param.<name>` and
// `param.<fn>(` are written without spaces; whitespace elsewhere is free.
function supportedForm(tokens, name) {
  const member = tokens.length >= 3 && isRoot(tokens[0]) && isPunct(tokens[1], ".") && tokens[2].type === "ident" && tokens[2].name && touching(tokens, 0, 2);
  if (member && tokens.length === 3) return { form: "presence", condition: true };
  if (member && tokens.length === 5 && tokens[3].type === "operator") {
    const literal = literalOf(tokens[4]);
    if (literal === null) return null;
    if (tokens[3].value === "==" || tokens[3].value === "===") return { form: "equals", condition: literal === PARAM_VALUE };
    if (tokens[3].value === "!=") return { form: "not_equals", condition: literal !== PARAM_VALUE };
    return null;
  }
  const call = tokens.length >= 6 && isRoot(tokens[0]) && isPunct(tokens[1], ".") && tokens[2].type === "ident" && isPunct(tokens[3], "(")
    && touching(tokens, 0, 3) && namesParam(tokens[4], name) && isPunct(tokens.at(-1), ")");
  if (!call) return null;
  if (tokens.length === 6 && ["has", "exists"].includes(tokens[2].value)) return { form: "has", condition: true };
  if (tokens.length === 8 && ["is", "equals"].includes(tokens[2].value) && isPunct(tokens[5], ",")) {
    const literal = literalOf(tokens[6]);
    return literal === null ? null : { form: "is", condition: literal === PARAM_VALUE };
  }
  return null;
}

// The form of one expression that refers to the param, and what it predicts
// for the element with `?<name>=n`: {form, prediction, mixed_cart}. Only the
// single-term forms below are supported; everything else (compound, `!`,
// parentheses, `!==`, `>=`, `<=`, numeric comparisons, more operators, a
// condition that also reads the cart) is `unsupported` with an `unknown`
// prediction.
export function classifyExpression(attr, expression, name) {
  // Any `cart.` in the text, quoted or not, reads as a cart condition.
  const mixedCart = /(?:^|[^\w.])cart\./.test(String(expression ?? ""));
  const supported = recognisedForm(expression, name);
  if (!supported || mixedCart) return { form: "unsupported", prediction: "unknown", mixed_cart: mixedCart };
  // data-next-hide hides when its condition holds; data-next-show hides when
  // its condition fails.
  const hidden = attr === "hide" ? supported.condition : !supported.condition;
  return { form: supported.form, prediction: hidden ? "hidden" : "visible", mixed_cart: false };
}

// ---------------------------------------------------------------------------
// Result rules

const isTarget = (reference) => reference.form !== "unsupported" && reference.prediction === "hidden" && reference.both_attributes !== true;
const reviewReason = (reference) => {
  if (reference.both_attributes === true) return "show_overrides_hide";
  if (reference.form === "unsupported") return reference.mixed_cart === true ? "mixed_param_cart" : "unsupported_expression";
  return null;
};

function validReference(reference) {
  if (!isPlainObject(reference)) return false;
  if (!ATTRS.includes(reference.attr) || !EXPR_HASH.test(reference.expr_sha256 || "")) return false;
  if (!FORMS.includes(reference.form) || !PREDICTIONS.includes(reference.prediction)) return false;
  if ((reference.form === "unsupported") !== (reference.prediction === "unknown")) return false;
  if (reference.element_path !== undefined && !isNonEmptyString(reference.element_path)) return false;
  if (![undefined, true, false].includes(reference.both_attributes) || ![undefined, true, false].includes(reference.mixed_cart)) return false;
  if (reference.mixed_cart === true && reference.form !== "unsupported") return false;
  // A review member is keyed by its element, so it needs one.
  return reviewReason(reference) === null || isNonEmptyString(reference.element_path);
}

const validRead = (read) => isPlainObject(read) && ["present", "visible", "stable"].every((field) => typeof read[field] === "boolean");

function validTarget(target) {
  return isPlainObject(target)
    && ATTRS.includes(target.attr)
    && EXPR_HASH.test(target.expr_sha256 || "")
    && isNonEmptyString(target.element_path)
    && VARIANTS.every((variant) => validRead(target[variant]))
    && (target.baseline.present || target.param_n.present);
}

// The observation as the rules read it, or null when it is not one they can.
function readObservation(observation) {
  if (!isPlainObject(observation)) return null;
  const { param, page, readiness, references, targets, counts } = observation;
  if (!isNonEmptyString(param) || !isNonEmptyString(page)) return null;
  if (!isPlainObject(readiness) || !Array.isArray(references) || !Array.isArray(targets) || !isPlainObject(counts)) return null;
  const limit = observation.limit ?? null;
  const pageCoverage = observation.page_coverage ?? null;
  if (limit !== null && !LIMITS.includes(limit)) return null;
  if (pageCoverage !== null && pageCoverage !== BUDGET_EXHAUSTED) return null;
  if (limit !== null) {
    // Nothing was loaded for a pair that was cut or not requested.
    const empty = VARIANTS.every((variant) => readiness[variant] === null && counts[variant] === null);
    if (!empty || references.length || targets.length || pageCoverage !== null) return null;
    return { param, page, limit, pageCoverage, readiness, references, targets, counts };
  }
  if (!VARIANTS.every((variant) => READINESS.includes(readiness[variant]))) return null;
  if (!VARIANTS.every((variant) => counts[variant] === null || isCount(counts[variant]))) return null;
  if (!references.every(validReference) || !targets.every(validTarget)) return null;
  // The target list and the target references describe the same elements:
  // every target is a supported reference predicted hidden, and every such
  // reference has its target listed. A reference without an element_path
  // resolves by (attr, expr_sha256).
  const targetRefs = references.filter(isTarget);
  if (!targets.every((target) => targetRefs.some((reference) => resolvesTo(reference, target)))) return null;
  if (!targetRefs.every((reference) => targets.some((target) => resolvesTo(reference, target)))) return null;
  const identities = targets.map((target) => `${target.attr}|${target.expr_sha256}|${target.element_path}`);
  if (new Set(identities).size !== identities.length) return null;
  return { param, page, limit, pageCoverage, readiness, references, targets, counts };
}

const resolvesTo = (reference, target) => reference.attr === target.attr
  && reference.expr_sha256 === target.expr_sha256
  && (reference.element_path === undefined || reference.element_path === target.element_path);

// Whether each context's count accounts for its targets: no target present in
// a context goes uncounted, and no count exceeds the targets listed. Where
// every target is present in both contexts (the only way to pass), this makes
// each count equal the number of target entries.
const countsReconcile = (targets, counts) => VARIANTS.every((variant) => {
  const present = targets.filter((target) => target[variant].present).length;
  return present <= counts[variant] && counts[variant] <= targets.length;
});

const projectReference = (reference) => ({
  attr: reference.attr,
  expr_sha256: reference.expr_sha256,
  form: reference.form,
  prediction: reference.prediction,
  element_path: reference.element_path ?? null,
  both_attributes: reference.both_attributes === true,
  mixed_cart: reference.mixed_cart === true,
});
const projectTarget = (target) => ({
  attr: target.attr,
  expr_sha256: target.expr_sha256,
  element_path: target.element_path,
  baseline: { present: target.baseline.present, visible: target.baseline.visible, stable: target.baseline.stable },
  param_n: { present: target.param_n.present, visible: target.param_n.visible, stable: target.param_n.stable },
});
const identityOf = (entry) => JSON.stringify([entry.attr, entry.expr_sha256, entry.element_path ?? null, entry.form ?? null, entry.both_attributes ?? null]);
const byIdentity = (a, b) => identityOf(a).localeCompare(identityOf(b));

// One target's member: identity first (present and stable in both contexts),
// then visible at baseline, then hidden with `n`.
function targetMember(target, key) {
  const matched = VARIANTS.every((variant) => target[variant].present && target[variant].stable);
  if (!matched) return { key, result: "review", reason_code: "target_identity_unresolved" };
  if (!target.baseline.visible) return { key, result: "review", reason_code: "already_hidden_at_baseline" };
  if (target.param_n.visible) return { key, result: "warning", reason_code: "target_still_visible" };
  return { key, result: "pass", reason_code: null };
}

function decide(read) {
  const { readiness, references, targets, counts, limit } = read;
  if (limit === NOT_REQUESTED) return { result: "excluded", reason_code: NOT_REQUESTED };
  if (limit === BUDGET_EXHAUSTED) return { result: "unexercised", reason_code: BUDGET_EXHAUSTED };
  for (const variant of VARIANTS) {
    if (readiness[variant] !== "ready") return { result: "unexercised", reason_code: readiness[variant] };
  }
  // Both contexts are ready: from here on the DOM was read in both.
  if (!VARIANTS.every((variant) => isCount(counts[variant]))) return null;
  if (!references.length) return targets.length || counts.baseline || counts.param_n ? null : { result: "review", reason_code: "no_resolvable_target" };
  if (counts.baseline !== counts.param_n) return { result: "review", reason_code: "target_count_changed" };
  if (!countsReconcile(targets, counts)) return null;
  const reviews = references.filter((reference) => reviewReason(reference) !== null);
  if (!reviews.length && !references.some(isTarget)) {
    // Supported handlers only, none of which hides anything with `n`.
    return { result: "warning", reason_code: "not_toggled_by_n" };
  }
  // Member keys are "<attr>:<element_path>", unique per kind: a review
  // reference at a target's attribute and path (its expression differs
  // between the two contexts) is its own member, keyed with a ":review"
  // suffix, so it is never folded into the target's. Within a kind, a shared
  // key keeps the result that ranks first by the 1.0 precedence.
  const members = new Map();
  const add = (key, member) => {
    const known = members.get(key);
    if (!known || MEMBER_RANK.indexOf(member.result) < MEMBER_RANK.indexOf(known.result)) members.set(key, { key, ...member });
  };
  const targetKeys = new Set(targets.map((target) => `${target.attr}:${target.element_path}`));
  for (const target of targets) {
    const key = `${target.attr}:${target.element_path}`;
    add(key, targetMember(target, key));
  }
  for (const reference of reviews) {
    const key = `${reference.attr}:${reference.element_path}`;
    add(targetKeys.has(key) ? `${key}:review` : key, { result: "review", reason_code: reviewReason(reference) });
  }
  return { members: [...members.values()] };
}

// The 1.0 aggregation precedence, used to merge members that share a key.
const MEMBER_RANK = Object.freeze(["warning", "review", "unexercised", "pass"]);

// Re-derives one row from its stored observation, or returns null when the
// observation is not one this rule can read (the reader then reports
// evidence_not_reproducible).
export function rederiveQcResult(observation) {
  try {
    return derive(observation);
  } catch {
    return null;
  }
}

function derive(observation) {
  const read = readObservation(observation);
  if (!read) return null;
  const decided = decide(read);
  if (!decided) return null;
  // A page where the budget cut another pair is a capped page: every result
  // kept for it carries the page_coverage member, so it is never
  // accept-eligible and never pass.
  const capReason = read.pageCoverage;
  let aggregate;
  if (decided.members) {
    aggregate = aggregateQcResults(decided.members, { capReason });
  } else {
    const members = capReason && decided.result !== "excluded" ? [{ key: "page_coverage", result: "unexercised", reason_code: capReason }] : [];
    aggregate = { result: decided.result, reason_code: decided.reason_code, members, accept_eligible: decided.result === "warning" && !members.length };
  }
  const subject = { check: CONTENT_PARAM_CHECK, page: read.page, key: read.param };
  const coverage = aggregate.result === "excluded"
    ? { observed: 0, expected: null, limits: [] }
    : decided.members || aggregate.result !== "unexercised"
      ? { observed: 1, expected: 1, limits: capReason ? [capReason] : [] }
      : { observed: 0, expected: 1, limits: [aggregate.reason_code] };
  return {
    check: CONTENT_PARAM_CHECK,
    subject,
    result: aggregate.result,
    reason_code: aggregate.result === "pass" ? null : aggregate.reason_code,
    members: aggregate.members,
    accept_eligible: aggregate.accept_eligible,
    coverage,
    state: {
      reason_code: aggregate.result === "pass" ? null : aggregate.reason_code,
      readiness: { baseline: read.readiness.baseline, param_n: read.readiness.param_n },
      counts: { baseline: read.counts.baseline, param_n: read.counts.param_n },
      references: read.references.map(projectReference).sort(byIdentity),
      targets: read.targets.map(projectTarget).sort(byIdentity),
      limit: read.limit,
      page_coverage: read.pageCoverage,
    },
  };
}

// ---------------------------------------------------------------------------
// Rows and assertions

export function contentParamQcRow(observation, { measuredAt = new Date().toISOString() } = {}) {
  const derived = rederiveQcResult(observation);
  if (!derived) return null;
  return buildQcResult({
    check: derived.check,
    leg: "qa",
    subject: derived.subject,
    result: derived.result,
    reason_code: derived.reason_code,
    state: derived.state,
    observation,
    members: derived.members,
    accept_eligible: derived.accept_eligible,
    coverage: derived.coverage,
    measured_at: measuredAt,
  });
}

// The row's verdict assertion, under the id qc.content_param:<name>:<page>.
// It names its row in evidence.qc.result_id, which is how readers pair them.
export function contentParamQaAssertion(row) {
  return { ...toQaAssertion(row, { family: FAMILY }), id: `qc.${CONTENT_PARAM_CHECK}:${row.subject.key}:${row.subject.page}` };
}

const unloadedObservation = (pair, limit, pageCoverage = null) => ({
  param: pair.param,
  page: pair.page,
  readiness: { baseline: null, param_n: null },
  references: [],
  targets: [],
  counts: { baseline: null, param_n: null },
  limit,
  page_coverage: pageCoverage,
});

// The run-scope rows of a QA run without browser checks: one
// excluded / browser_checks_not_requested row per declared (param, page).
export function contentParamNotRequestedRows(spec, topologies, { measuredAt = new Date().toISOString() } = {}) {
  return contentParamPairs(spec, topologies)
    .map((pair) => contentParamQcRow(unloadedObservation(pair, NOT_REQUESTED), { measuredAt }))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Browser driver

// Every DOM read the check makes runs in an isolated world of the page,
// reached through the Chrome DevTools Protocol. The page's own scripts share
// the DOM with that world but not its globals or prototypes, so a page that
// overrides getComputedStyle, getAttribute, querySelectorAll or any other DOM
// method cannot change what is read. The world's script is installed before
// navigation and runs at document start. Once the document is parsed it
// watches for the readiness signal and, when the signal appears, captures the
// live [data-next-hide] / [data-next-show] nodes and their attribute values
// (template content is not part of the document, so it is never listed).
// One macrotask and one animation frame later it re-reads those same nodes:
// a node is stable when it is still connected at the same path with the same
// attribute values, and visible per the contract's rule.
//
// Every reading carries the URL its document was loaded at (after any
// redirect) and the status of the response that document was served with
// (its navigation timing entry's responseStatus, the status a service worker
// answered with included), both taken at document start in the world of the
// document that is read. The driver uses a reading only when that URL has the
// requested origin and path and, with `?<name>=n`, carries `<name>=n` exactly
// once (the baseline: no `<name>`), and that status is known and below 400. A
// redirect that drops the parameter or lands on another path, a page that
// replaces itself with another document before it is read (the same URL
// included: the replacement reports its own status, never the one `goto`
// saw), or a document served with an error status, no status or status 0 is
// not the page that was asked for: the load reads page_not_served. The URL and
// status are compared in memory and never stored.
//
// The world's script carries its own copy of the element path rule: "body",
// then ">tag[index]" per step, index 0-based among same-tag element siblings
// (null for a detached element).
const WORLD_NAME = "campaigns-os-content-params";
const WORLD_KEY = "__campaignsOsContentParams";
// Reading covers the readiness wait, then one macrotask and one frame; this
// is the allowance for that frame and the protocol round trips.
const READ_MARGIN_MS = 1_000;

function installReader(key) {
  const url = location.href;
  const status = performance.getEntriesByType("navigation")[0]?.responseStatus ?? null;
  const pathOf = (element) => {
    const steps = [];
    let node = element;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      const parent = node.parentElement;
      if (!parent) return null;
      const index = Array.prototype.filter.call(parent.children, (sibling) => sibling.tagName === node.tagName).indexOf(node);
      steps.unshift(`${node.tagName.toLowerCase()}[${index}]`);
      node = parent;
    }
    return [node === document.body ? "body" : "html", ...steps].join(">");
  };
  const signalled = () => document.readyState !== "loading"
    && (document.body?.getAttribute("data-next-sdk-loading") === "false"
      || Boolean(document.documentElement?.classList.contains("next-display-ready")));
  const readNode = ({ element, hide, show, path }) => {
    const connected = element.isConnected;
    const stable = connected
      && pathOf(element) === path
      && element.getAttribute("data-next-hide") === hide
      && element.getAttribute("data-next-show") === show;
    let visible = false;
    if (connected) {
      const style = getComputedStyle(element);
      visible = style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    }
    return { hide, show, path, stable, visible };
  };
  let settle;
  const reading = new Promise((resolve) => {
    settle = resolve;
  });
  let captured = false;
  const observer = new MutationObserver(() => check());
  const check = () => {
    if (captured || !signalled()) return;
    captured = true;
    observer.disconnect();
    document.removeEventListener("DOMContentLoaded", check);
    const nodes = Array.from(document.querySelectorAll("[data-next-hide], [data-next-show]"), (element) => ({
      element,
      hide: element.getAttribute("data-next-hide"),
      show: element.getAttribute("data-next-show"),
      path: pathOf(element),
    }));
    setTimeout(() => requestAnimationFrame(() => settle(nodes.map(readNode))), 0);
  };
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-next-sdk-loading"] });
  document.addEventListener("DOMContentLoaded", check);
  check();
  Object.defineProperty(globalThis, key, {
    value: Object.freeze({
      // The reading, or { ready: false } when the signal has not appeared
      // within `timeoutMs`; either way with the document's URL and status.
      read: (timeoutMs) => new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ url, status, ready: false, elements: [] }), timeoutMs);
        reading.then((elements) => {
          clearTimeout(timer);
          resolve({ url, status, ready: true, elements });
        });
      }),
    }),
  });
}

const READER_SOURCE = `(${installReader})(${JSON.stringify(WORLD_KEY)});`;

// A protocol session on the page with the reader installed for every
// document it loads from here on.
async function openReader(context, page) {
  const session = await context.newCDPSession(page);
  await session.send("Page.enable");
  await session.send("Page.addScriptToEvaluateOnNewDocument", { source: READER_SOURCE, worldName: WORLD_NAME });
  return session;
}

// The reading of the main frame's current document, from the reader's world.
async function readDocument(session, timeoutMs) {
  const { frameTree } = await session.send("Page.getFrameTree");
  const { executionContextId } = await session.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WORLD_NAME });
  const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
    contextId: executionContextId,
    expression: `globalThis[${JSON.stringify(WORLD_KEY)}].read(${Number(timeoutMs)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error("The document could not be read.");
  return result?.value;
}

const isAttrValue = (value) => value === null || typeof value === "string";
// A reading as the driver uses it, or null when it is not a complete one.
function readElements(reading) {
  if (!isPlainObject(reading) || reading.ready !== true || !Array.isArray(reading.elements)) return null;
  const complete = reading.elements.every((element) => isPlainObject(element)
    && isAttrValue(element.hide) && isAttrValue(element.show) && isAttrValue(element.path)
    && typeof element.stable === "boolean" && typeof element.visible === "boolean");
  return complete ? reading.elements : null;
}

// The param's references among the described elements of one context.
function contextReferences(described, name) {
  const references = [];
  described.forEach((element, index) => {
    if (!element || typeof element.path !== "string") return;
    // An element that carries both attributes (even an empty one) reads review:
    // the SDK reads data-next-show when it is set and ignores data-next-hide.
    const both = typeof element.show === "string" && typeof element.hide === "string";
    for (const attr of ATTRS) {
      const expression = element[attr];
      if (!expression || !referencesParam(expression, name)) continue;
      const { form, prediction, mixed_cart } = classifyExpression(attr, expression, name);
      references.push({ index, attr, expr_sha256: expressionHash(expression), form, prediction, element_path: element.path, both_attributes: both, mixed_cart });
    }
  });
  return references;
}

// Whether the document a reading came from is the one requested for
// `variant`: its URL has the requested origin and path, and carries `<name>=n`
// once (param_n) or no `<name>` (baseline).
function servesRequested(documentUrl, requestedUrl, name, variant) {
  try {
    const loaded = new URL(documentUrl);
    const requested = new URL(requestedUrl);
    if (loaded.origin !== requested.origin || loaded.pathname !== requested.pathname) return false;
    const values = loaded.searchParams.getAll(name);
    return variant === "param_n" ? values.length === 1 && values[0] === PARAM_VALUE : values.length === 0;
  } catch {
    return false;
  }
}

// Whether the read document's own response status says it was served.
const servedStatus = (status) => Number.isInteger(status) && status > 0 && status < 400;

const withinDeadline = (operation, timeoutMs) => runWithDeadline(operation, { timeoutMs });

// Whether the leg's budget has ended: cut by the budget timer, or the clock
// already at or past the deadline (a late timer is no evidence of time left).
// There is time left only while the clock reads before the deadline.
function lapsed(run) {
  if (!run.cancelled && run.now() >= run.deadline) run.cancelled = true;
  return run.cancelled;
}

// Closes a context without waiting on it beyond the returned promise, which
// never rejects.
function closeQuietly(context) {
  try {
    return Promise.resolve(context.close()).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

// One load in a fresh context. Never throws: every failure is a readiness
// outcome. `run.cancelled` is set when the budget ends; no new context opens
// after that, and the contexts still open are closed by the budget cut. The
// clock is checked after each awaited step, so no step starts past the budget.
async function loadVariant(url, name, variant, run) {
  if (!url) return { readiness: "navigation_failed" };
  if (lapsed(run)) return { readiness: null };
  let context = null;
  try {
    context = await run.newContext();
    run.open.add(context);
    if (lapsed(run)) return { readiness: null };
    const page = await context.newPage();
    const session = await openReader(context, page);
    if (lapsed(run)) return { readiness: null };
    let response = null;
    try {
      response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: run.limits.navigationMs });
    } catch {
      return { readiness: lapsed(run) ? null : "navigation_failed" };
    }
    if (lapsed(run)) return { readiness: null };
    const status = response?.status?.() ?? null;
    if (!response || !Number.isFinite(status) || status >= 400) return { readiness: "page_not_served" };
    // A reading from a document other than the one requested, or from a
    // document whose own response was not served, is no reading of the
    // requested page. A page that does not signal readiness in time,
    // navigates away or stalls before it can be read, or returns an
    // incomplete reading did not reach a readable ready state.
    let reading = null;
    try {
      reading = await withinDeadline(() => readDocument(session, run.limits.readinessMs), run.limits.readinessMs + READ_MARGIN_MS);
    } catch {
      reading = null;
    }
    if (lapsed(run)) return { readiness: null };
    if (isPlainObject(reading) && (!servesRequested(reading.url, url, name, variant) || !servedStatus(reading.status))) return { readiness: "page_not_served" };
    const elements = readElements(reading);
    if (!elements) return { readiness: "readiness_timeout" };
    const references = contextReferences(elements, name);
    const targets = references.filter(isTarget);
    return {
      readiness: "ready",
      references,
      reads: new Map(targets.map((target) => [identityOf(target), { present: true, visible: elements[target.index].visible, stable: elements[target.index].stable }])),
    };
  } catch {
    return { readiness: lapsed(run) ? null : "navigation_failed" };
  } finally {
    if (context) {
      run.open.delete(context);
      await closeQuietly(context);
    }
  }
}

// The baseline URL carries no `?<name>=`; the variant sets it to `n`.
function baselineUrl(url, name) {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has(name)) return url;
    parsed.searchParams.delete(name);
    return parsed.toString();
  } catch {
    return url;
  }
}

// The observation of a pair whose two loads both completed.
function pairObservation(pair, baseline, paramN) {
  const readiness = { baseline: baseline.readiness, param_n: paramN.readiness };
  if (baseline.readiness !== "ready" || paramN.readiness !== "ready") {
    return { param: pair.param, page: pair.page, readiness, references: [], targets: [], counts: { baseline: null, param_n: null }, limit: null, page_coverage: null };
  }
  const references = [];
  const seen = new Set();
  for (const reference of [...baseline.references, ...paramN.references]) {
    const identity = identityOf(reference);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const { index: _index, ...stored } = reference;
    references.push(stored);
  }
  const targets = references.filter(isTarget).map((reference) => ({
    attr: reference.attr,
    expr_sha256: reference.expr_sha256,
    element_path: reference.element_path,
    baseline: { ...(baseline.reads.get(identityOf(reference)) ?? ABSENT) },
    param_n: { ...(paramN.reads.get(identityOf(reference)) ?? ABSENT) },
  }));
  return {
    param: pair.param,
    page: pair.page,
    readiness,
    references,
    targets,
    counts: { baseline: baseline.reads.size, param_n: paramN.reads.size },
    limit: null,
    page_coverage: null,
  };
}

// Both loads of one pair inside what is left of the leg's budget. A pair the
// budget cuts (whether or not a load had started) reads budget_exhausted, and
// so does a pair that completes at or past the deadline, whatever its readings
// say. A pair starts only while the clock reads before the deadline. The pair
// races `timeUp`, the leg's budget timer: once it fires the pair is left as it
// is, never awaited further.
async function runPair(pair, run, { withQueryParam, timeUp }) {
  if (lapsed(run)) return null;
  const work = (async () => {
    const baseline = await loadVariant(pair.url ? baselineUrl(pair.url, pair.param) : null, pair.param, "baseline", run);
    const paramN = await loadVariant(pair.url ? withQueryParam(baselineUrl(pair.url, pair.param), pair.param, PARAM_VALUE) : null, pair.param, "param_n", run);
    return { baseline, paramN };
  })();
  work.catch(() => {});
  const outcome = await Promise.race([work, timeUp]);
  if (outcome === BUDGET_CUT || lapsed(run)) return null;
  const { baseline, paramN } = outcome;
  if (baseline.readiness === null || paramN.readiness === null) return null;
  // An observation the rules cannot read (its counts, targets and
  // references do not reconcile) is no reading of a ready state, so it is
  // kept as readiness_timeout in both contexts rather than dropped.
  const observation = pairObservation(pair, baseline, paramN);
  if (rederiveQcResult(observation)) return observation;
  return { ...observation, readiness: { baseline: "readiness_timeout", param_n: "readiness_timeout" }, references: [], targets: [], counts: { baseline: null, param_n: null } };
}

// The limits a run uses: each field of `limits` that is a positive number
// (maxPairs: zero or more), else CONTENT_PARAM_LIMITS' field.
function runLimits(limits) {
  return Object.fromEntries(Object.entries(CONTENT_PARAM_LIMITS).map(([field, fallback]) => {
    const value = isPlainObject(limits) ? limits[field] : undefined;
    const usable = Number.isFinite(value) && (field === "maxPairs" ? value >= 0 : value > 0);
    return [field, usable ? value : fallback];
  }));
}

// The content parameter leg of `qa run --browser`, run after the page checks.
// `newContext()` opens a fresh browser context with the page checks' options;
// `withQueryParam(url, key, value)` builds the variant URL. Returns the rows
// and their verdict assertions.
//
// The leg returns within its budget, cleanup included: one timer, armed for
// budgetMs when the leg starts, cuts the pair in progress. At the cut the open
// contexts are told to close and the leg returns at once; neither those closes
// nor the cut loads are awaited (their errors are swallowed). A load's own
// close, when it completes in time, is part of its pair's work.
export async function runContentParamChecks({ topologies, spec, newContext, withQueryParam, now = () => Date.now(), limits = CONTENT_PARAM_LIMITS, measuredAt = null } = {}) {
  const pairs = contentParamPairs(spec, topologies);
  if (!pairs.length) return { rows: [], assertions: [] };
  const bounds = runLimits(limits);
  const run = { newContext, open: new Set(), cancelled: false, deadline: now() + bounds.budgetMs, now, limits: bounds };
  let timer = null;
  const timeUp = new Promise((resolve) => {
    timer = setTimeout(() => {
      run.cancelled = true;
      for (const context of run.open) closeQuietly(context);
      resolve(BUDGET_CUT);
    }, bounds.budgetMs);
  });
  const observations = [];
  try {
    for (const [index, pair] of pairs.entries()) {
      let observation = null;
      if (index < bounds.maxPairs) {
        // Loads never throw (every failure is a readiness outcome); anything
        // else leaves the pair unmeasured, which is never a pass.
        try {
          observation = await runPair(pair, run, { withQueryParam, timeUp });
        } catch {
          observation = null;
        }
      }
      observations.push(observation ?? unloadedObservation(pair, BUDGET_EXHAUSTED));
    }
  } finally {
    clearTimeout(timer);
  }
  const capped = new Set(observations.filter((observation) => observation.limit === BUDGET_EXHAUSTED).map((observation) => observation.page));
  const at = measuredAt ?? new Date().toISOString();
  const rows = observations
    .map((observation) => (observation.limit === null && capped.has(observation.page) ? { ...observation, page_coverage: BUDGET_EXHAUSTED } : observation))
    .map((observation) => contentParamQcRow(observation, { measuredAt: at }))
    .filter(Boolean);
  return { rows, assertions: rows.map(contentParamQaAssertion) };
}
