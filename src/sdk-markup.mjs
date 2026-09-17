// Static SDK markup checks (#303).
//
// `built_output.upsell_selector_scope` catches one shape of built markup that
// the Campaign Cart SDK binds without complaint and that then does the wrong
// thing to a shopper. This module is the rest of that family: six more
// shapes, each a static read of built HTML, each producing either a silent
// no-op (the shopper fills a field that never reaches the order; a button
// that never enables) or a double cart write. A partner agency's Campaign
// Cart skill kit listed them as stable lint codes; the codes are kept so the
// two vocabularies line up.
//
//   Blockers (not waivable — the markup provably does not do what it says)
//   SWAP_WITH_ADD_TO_CART      a bundle selector in swap mode (explicit, or
//                              the SDK default when the attribute is absent)
//                              AND an add-to-cart button linked to it by
//                              data-next-selector-id. Both write the cart: the
//                              card click swaps the bundle in, the button adds
//                              it again.
//   CHECKOUT_NOT_FORM          data-next-checkout on anything but <form>. The
//                              checkout enhancer binds to a form element;
//                              anything else never submits.
//   WRONG_FIELD_NAME           data-next-checkout-field with a value the SDK
//                              does not map (firstName, lastName, zip …). The
//                              input renders, the value never reaches the
//                              order.
//   MISSING_SELECTOR_ID_MATCH  an add-to-cart button whose data-next-selector-id
//                              names no selector on the page. The button waits
//                              for a selection that can never arrive.
//
//   Warnings (advisory)
//   DOUBLE_SELECTED            more than one data-next-selected="true" card in
//                              one selector; the SDK picks one and the page
//                              shows two.
//   TEMPLATE_DOUBLE_BRACE      `{{` inside an SDK-owned <template>. SDK tokens
//                              are single-brace and conditions are no-brace;
//                              a double brace renders literally.
//
//   Info (advisory, one note per campaign, no code)
//   unknown_attributes[]       a data-next-* name the pinned SDK's attribute
//                              index does not list. Catches an invented
//                              attribute (data-next-coupon-input) — and, on the
//                              certified templates, a handful of the templates'
//                              own data-next-* hooks, which is why it informs
//                              rather than warns.
//
// Parsed with parse5 rather than regex because four of the six turn on
// containment (a card inside a selector, a field inside a form, a template's
// content), and HTML nesting is not a regular language. Template content is
// walked too: the SDK clones it into the live DOM.
//
// Pure: callers hand in built HTML. Both doctor entry points drive it.

import { parse } from "parse5";

import {
  SDK_ATTRIBUTE_INDEX_VERSION,
  isIndexedSdkAttribute,
  isKnownCheckoutFieldName,
} from "./sdk-attribute-index.mjs";

export const SDK_MARKUP = "built_output.sdk_markup";

export const SDK_MARKUP_CODES = Object.freeze({
  SWAP_WITH_ADD_TO_CART: { code: `${SDK_MARKUP}.swap_with_add_to_cart`, severity: "error" },
  CHECKOUT_NOT_FORM: { code: `${SDK_MARKUP}.checkout_not_form`, severity: "error" },
  WRONG_FIELD_NAME: { code: `${SDK_MARKUP}.wrong_field_name`, severity: "error" },
  MISSING_SELECTOR_ID_MATCH: { code: `${SDK_MARKUP}.missing_selector_id_match`, severity: "error" },
  DOUBLE_SELECTED: { code: `${SDK_MARKUP}.double_selected`, severity: "warning" },
  TEMPLATE_DOUBLE_BRACE: { code: `${SDK_MARKUP}.template_double_brace`, severity: "warning" },
  // Unknown data-next-* names are not a finding and carry no code: they are
  // information on the gate (unknown_attributes[]) and one advisory ready line.
});

// Attributes whose value names a <template> by id. The SDK reads the template
// they point at, so that template is SDK-owned wherever it sits.
const TEMPLATE_ID_ATTRIBUTES = /^data-(?:next-)?[a-z0-9-]*template-id$/;

// Containers whose DIRECT <template> child the SDK clones (each does a
// `:scope > template` lookup at v0.4.38: cart-summary and its
// data-summary-lines / data-next-discounts sub-containers; bundle-selector,
// the card-internal data-next-bundle-slots placeholder
// (`[data-next-bundle-slots] > template`, template-state.ts) and the external
// data-next-bundle-slots-for container the enhancer resolves by selector id
// (`externalSlotsEl.querySelector(':scope > template')`); package-selector;
// package-toggle).
// Only the direct child: a vendor template nested deeper inside SDK chrome is
// never read, so it may use any syntax.
const TEMPLATE_CONTAINER_ATTRIBUTES = [
  "data-next-cart-summary",
  "data-summary-lines",
  "data-next-discounts",
  "data-next-bundle-selector",
  "data-next-bundle-slots",
  "data-next-bundle-slots-for",
  "data-next-package-selector",
  "data-next-package-toggle",
];

// Elements that ARE a selector an add-to-cart button can link to by id.
const SELECTOR_ATTRIBUTES = ["data-next-bundle-selector", "data-next-package-selector", "data-next-cart-selector", "data-next-upsell-selector"];

function attrs(node) {
  const map = new Map();
  for (const attr of node.attrs || []) map.set(attr.name.toLowerCase(), attr.value);
  return map;
}

// Depth-first over element nodes, descending into <template> content. The
// callback receives the element, its attribute map, and the ancestor chain
// (nearest first) so containment questions are a lookup, not a second walk.
function walkElements(root, visit, ancestors = []) {
  const children = root.content ? root.content.childNodes : root.childNodes;
  for (const node of children || []) {
    if (!node.tagName) continue;
    const entry = { node, tag: node.tagName.toLowerCase(), attrs: attrs(node), ancestors };
    visit(entry);
    walkElements(node, visit, [entry, ...ancestors]);
  }
}

function serializeTemplateText(node) {
  // Text content of a template's fragment, attributes included: `{{` can sit
  // in an attribute value (`data-next-format="{{price}}"`) as easily as in a
  // text node.
  const out = [];
  const visit = (n) => {
    if (n.value != null) out.push(n.value);
    for (const attr of n.attrs || []) out.push(attr.value);
    const kids = n.content ? n.content.childNodes : n.childNodes;
    for (const child of kids || []) visit(child);
  };
  visit(node);
  return out.join("\n");
}

function describe(entry) {
  const id = entry.attrs.get("id");
  const selectorId = entry.attrs.get("data-next-selector-id");
  const bits = [`<${entry.tag}`];
  if (id) bits.push(` id="${id}"`);
  if (selectorId) bits.push(` data-next-selector-id="${selectorId}"`);
  return `${bits.join("")}>`;
}

/**
 * Scan one built page. Returns findings with { code_name, code, severity,
 * page_id, file, message, detail } and the set of unknown data-next-* names.
 */
export function scanPageMarkup({ page_id, file = null, content = "" }) {
  const document = parse(String(content || ""));
  const where = file || page_id;
  const findings = [];
  const unknown = new Set();

  const selectors = []; // { entry, id, mode, upsell, selectedCount }
  const addToCartButtons = []; // { entry, selectorId }
  const selectorIds = new Set(); // ids of elements that are themselves a selector
  const templates = []; // { entry, sdkOwned }
  const referencedTemplateIds = new Set();

  walkElements(document, (entry) => {
    const { tag, attrs: a, ancestors } = entry;

    for (const [name] of a) {
      if (name.startsWith("data-next-") && !isIndexedSdkAttribute(name)) unknown.add(name);
      if (TEMPLATE_ID_ATTRIBUTES.test(name) && a.get(name)) referencedTemplateIds.add(a.get(name).trim());
    }

    if (a.has("data-next-checkout") && tag !== "form") {
      findings.push(finding("CHECKOUT_NOT_FORM", page_id, where,
        `${describe(entry)} on ${where} carries data-next-checkout but is not a <form>. The checkout enhancer binds to a form element; this one never submits. Move the attribute onto the <form> that wraps the fields.`,
        { tag }));
    }

    if (a.has("data-next-checkout-field")) {
      const value = a.get("data-next-checkout-field") ?? "";
      if (!isKnownCheckoutFieldName(value)) {
        findings.push(finding("WRONG_FIELD_NAME", page_id, where,
          `data-next-checkout-field="${value}" on ${where} is not a field name the SDK ${SDK_ATTRIBUTE_INDEX_VERSION} maps (${suggestFieldName(value)}). The input renders and the value never reaches the order.`,
          { value, suggestion: suggestFieldName(value, true) }));
      }
    }

    const action = (a.get("data-next-action") || "").trim().toLowerCase();
    if (action === "add-to-cart") {
      addToCartButtons.push({ entry, selectorId: (a.get("data-next-selector-id") || "").trim() || null });
    } else if (SELECTOR_ATTRIBUTES.some((name) => a.has(name)) && (a.get("data-next-selector-id") || "").trim()) {
      // Only an element that IS a selector satisfies the link. Another element
      // merely echoing the id (a price display, a quantity control) does not
      // drive the button, and counting it would hide the missing selector.
      selectorIds.add(a.get("data-next-selector-id").trim());
    }

    if (a.has("data-next-bundle-selector") || a.has("data-next-package-selector")) {
      const mode = (a.get("data-next-selection-mode") || "").trim().toLowerCase();
      selectors.push({
        entry,
        id: (a.get("data-next-selector-id") || "").trim() || null,
        mode: mode || "swap",
        modeExplicit: Boolean(mode),
        upsell: a.has("data-next-upsell-context"),
        selectedCount: 0,
      });
    }

    if (a.has("data-next-selected") && (a.get("data-next-selected") || "").trim().toLowerCase() === "true") {
      const owner = ancestors.find((anc) => anc.attrs.has("data-next-bundle-selector") || anc.attrs.has("data-next-package-selector"));
      if (owner) {
        const selector = selectors.find((s) => s.entry === owner);
        if (selector) selector.selectedCount += 1;
      }
    }

    if (tag === "template") {
      const parent = ancestors[0];
      templates.push({ entry, sdkOwned: Boolean(parent && TEMPLATE_CONTAINER_ATTRIBUTES.some((name) => parent.attrs.has(name))) });
    }
  });

  // SWAP_WITH_ADD_TO_CART and MISSING_SELECTOR_ID_MATCH need the whole page.
  // One finding per dead id, however many buttons link to it: the root cause
  // is the selector, not each button.
  const missingReported = new Set();
  for (const button of addToCartButtons) {
    if (!button.selectorId) continue;
    const linked = selectors.filter((s) => s.id === button.selectorId);
    if (linked.length === 0 && !selectorIds.has(button.selectorId)) {
      if (missingReported.has(button.selectorId)) continue;
      missingReported.add(button.selectorId);
      const count = addToCartButtons.filter((other) => other.selectorId === button.selectorId).length;
      findings.push(finding("MISSING_SELECTOR_ID_MATCH", page_id, where,
        `${count > 1 ? `${count} add-to-cart buttons` : 'data-next-action="add-to-cart"'} on ${where} ${count > 1 ? "are" : "is"} linked to data-next-selector-id="${button.selectorId}" but no selector on the page carries that id. The button${count > 1 ? "s wait" : " waits"} for a selection that can never arrive and never enable${count > 1 ? "" : "s"}. Give the selector that id, or set data-next-package-id on the button and drop the link.`,
        { selector_id: button.selectorId, buttons: count }));
      continue;
    }
    for (const selector of linked) {
      if (selector.upsell || selector.mode !== "swap") continue;
      findings.push(finding("SWAP_WITH_ADD_TO_CART", page_id, where,
        `Selector data-next-selector-id="${selector.id}" on ${where} is in swap mode (${selector.modeExplicit ? 'data-next-selection-mode="swap"' : "the SDK default; no data-next-selection-mode set"}) and an add-to-cart button is linked to it. Both write the cart: the card click swaps the bundle in, the button adds it again. Set data-next-selection-mode="select" on the selector, or remove the button.`,
        { selector_id: selector.id, selection_mode_explicit: selector.modeExplicit }));
    }
  }

  for (const selector of selectors) {
    if (selector.selectedCount > 1) {
      findings.push(finding("DOUBLE_SELECTED", page_id, where,
        `Selector ${selector.id ? `data-next-selector-id="${selector.id}"` : "(no data-next-selector-id)"} on ${where} has ${selector.selectedCount} cards with data-next-selected="true". The SDK selects one; the page shows ${selector.selectedCount}. Leave exactly one default card selected.`,
        { selector_id: selector.id, selected_count: selector.selectedCount }));
    }
  }

  for (const template of templates) {
    const id = template.entry.attrs.get("id");
    const owned = template.sdkOwned || (id && referencedTemplateIds.has(id.trim()));
    if (!owned) continue;
    const text = serializeTemplateText(template.entry.node);
    const at = text.indexOf("{{");
    if (at === -1) continue;
    const snippet = text.slice(at, at + 40).split("\n")[0];
    const inner = /^\{\{\s*([^}\s]*)/.exec(snippet)?.[1] || "token";
    findings.push(finding("TEMPLATE_DOUBLE_BRACE", page_id, where,
      `SDK template ${id ? `id="${id}"` : "(no id)"} on ${where} contains "${snippet}". SDK template tokens are single-brace ({${inner}}) and conditions are no-brace; a double brace renders literally to the shopper.`,
      { template_id: id || null, snippet }));
  }

  return { page_id, file, findings, unknown_attributes: [...unknown].sort() };
}

function finding(codeName, page_id, file, message, detail = {}) {
  const { code, severity } = SDK_MARKUP_CODES[codeName];
  return { code_name: codeName, code, severity, page_id, file, message: `${codeName}: ${message}`, detail };
}

const FIELD_NAME_HINTS = {
  firstname: "fname", first_name: "fname", "first-name": "fname",
  lastname: "lname", last_name: "lname", "last-name": "lname",
  zip: "postal", zipcode: "postal", postcode: "postal", postal_code: "postal",
  state: "province", region: "province",
  address: "address1", street: "address1", apartment: "address2", apt: "address2", suite: "address2",
  tel: "phone", telephone: "phone", mobile: "phone",
  emailaddress: "email", "email-address": "email",
  cardnumber: "cc-number", "card-number": "cc-number", ccnumber: "cc-number",
  expmonth: "exp-month", expyear: "exp-year", cvc: "cvv", "cc-cvv": "cvv",
};

function suggestFieldName(value, bare = false) {
  const key = String(value || "").toLowerCase();
  const hint = FIELD_NAME_HINTS[key] || (isKnownCheckoutFieldName(key) ? key : null);
  if (bare) return hint;
  return hint ? `the SDK spelling is "${hint}"` : "see the SDK checkout-form field names";
}

/**
 * Evaluate the SDK markup family over built pages.
 *
 * @param {{ subject: object, pages: Array<{ page_id: string, file?: string|null, content: string }> }} input
 */
export function evaluateSdkMarkup({ subject, pages = [] } = {}) {
  const resolvedSubject = subject && typeof subject === "object" ? subject : {};
  const base = { id: SDK_MARKUP, scope: SDK_MARKUP, waivable: false, subject: resolvedSubject, waiver: null, sdk_attribute_index_version: SDK_ATTRIBUTE_INDEX_VERSION };
  const list = Array.isArray(pages) ? pages : [];

  if (list.length === 0) {
    return { ...base, status: "not_applicable", code: `${SDK_MARKUP}.not_applicable`, reason: "No built page was available to scan; SDK markup checks become mandatory once pages are built.", findings: [], warned: [], unknown_attributes: [], pages_scanned: 0, required_actions: [] };
  }

  const findings = [];
  const warned = [];
  const unknown = new Map();
  for (const page of list) {
    const scan = scanPageMarkup(page);
    for (const item of scan.findings) (item.severity === "error" ? findings : warned).push(item);
    for (const name of scan.unknown_attributes) {
      if (!unknown.has(name)) unknown.set(name, []);
      unknown.get(name).push(scan.file || scan.page_id);
    }
  }
  const unknown_attributes = [...unknown.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, files]) => ({ name, pages: files }));

  if (findings.length === 0) {
    return {
      ...base,
      status: "pass",
      code: warned.length ? `${SDK_MARKUP}.advisories` : `${SDK_MARKUP}.pass`,
      reason: `SDK markup checks passed on ${list.length} built page(s)${warned.length ? ` with ${warned.length} advisory finding(s)` : ""}.`,
      findings: [],
      warned,
      unknown_attributes,
      pages_scanned: list.length,
      required_actions: [],
    };
  }

  // Bounded summaries: a checkout with a dozen misspelled fields is a dozen
  // WRONG_FIELD_NAME findings, each already a doctor error with its full
  // message. The gate names the shape and the first few, not all of them.
  const SHOWN = 5;
  const headline = findings.slice(0, SHOWN).map((item) => `${item.code_name} on ${item.file || item.page_id}`);
  const more = findings.length > SHOWN ? `; plus ${findings.length - SHOWN} more` : "";
  return {
    ...base,
    status: "blocked",
    code: SDK_MARKUP,
    reason: `${findings.length} SDK markup blocker(s) on ${list.length} built page(s) (${headline.join("; ")}${more})${warned.length ? `, and ${warned.length} advisory finding(s) held in warned[] until the blockers clear` : ""}; each blocker is a doctor error with the repair.`,
    findings,
    warned,
    unknown_attributes,
    pages_scanned: list.length,
    required_actions: [
      {
        id: "repair_sdk_markup",
        kind: "edit",
        command: null,
        description: `Repair the markup each finding names (${headline.join("; ")}${more}), rebuild, and re-run doctor. Not waivable: the markup provably does not do what it says.`,
      },
    ],
  };
}
