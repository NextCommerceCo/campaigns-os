// Order-bump state evidence for browser QA (campaigns-os#323).
//
// The `browser-order-bump-state` assertion asks one question: does what the
// buyer can see on a bump toggle agree with what the SDK thinks is in the cart?
// It reads three things off each toggle — the SDK's own active/in-cart state,
// the toggle's checkbox input if it has one, and the rendered state marker —
// and fails when they disagree.
//
// The marker half used to be a single `querySelector` over a selector list that
// ended in a bare `[aria-hidden]`. Two things went wrong with that:
//
//   1. `aria-hidden` is decoration vocabulary, not state vocabulary. A bump
//      toggle that carries its own visually-hidden `<input type="checkbox"
//      aria-hidden="true">` has that input match the list, and `querySelector`
//      returns document order, not selector order — so on every toggle whose
//      input precedes its tick, the "marker" resolved to the input. An input is
//      not a rendered marker: it has no `::after`, no glyph, no fill, so
//      `markerChecked` could never read true and an accepted bump reported
//      misaligned on every single run. That is the whole of #323.
//   2. The same clause matched purely decorative nodes — an arrow icon, a
//      switch slider — whose rendering says nothing about the toggle's state,
//      so the check would fail a correctly rendered toggle for the same reason.
//
// So the marker vocabulary here is only the four families that mean "this is
// the tick", the families are tried in order (rather than being collapsed into
// one document-order query), and form controls and `[hidden]` subtrees can
// never be a marker.
//
// A rendered marker is then read for a positive state signal, and the signals
// are alternatives rather than one replacing another, because the families
// express state in genuinely different ways:
//
//   - `pseudo` — the marker is a persistent box and its `::after` carries the
//     tick. The box renders in both states, so its visibility says nothing;
//     the state is whether the pseudo-element is rendered. A marker whose
//     `::after` has non-empty content belongs to this family by definition,
//     and its checked reading comes from that pseudo-element alone.
//   - `glyph` — the tick is literal text in the marker.
//   - `fill` — the marker is filled with the accepted colour.
//   - `display_toggled` — the marker *is* the tick and the CSS shows and hides
//     it: `[data-next-toggle-card] [os-component="check"] { display: none }`
//     with the active or in-cart card restoring `display: flex`. Only here is
//     the marker's own rendering the state affordance.
//
// The last one is a claim about the page's CSS, so it is tested against the
// page's CSS (`hiddenByAMatchingRule`) rather than assumed from the family
// name. That is what keeps a persistent box out of it: a box nothing hides is
// not display-toggled, and reading its visibility as "checked" would fail a
// correctly declined bump.
//
// A rendered marker carrying no positive signal is reported as unresolved, not
// as checked and not as unchecked. The harness cannot read that page's state
// vocabulary, and saying so is honest; claiming a disagreement is not.

// Bump toggle roots. Matches the SDK's toggle card and the older bump root.
export const ORDER_BUMP_TOGGLE_SELECTOR = "[data-next-toggle-card], [data-next-bump]";

// State-marker families, most specific first. Tried in order, so a generic
// match can never outrank a dedicated one just by appearing earlier in the
// document. Deliberately does NOT include a bare `[aria-hidden]`.
export const ORDER_BUMP_MARKER_FAMILIES = Object.freeze([
  ".bump-check",
  "[data-next-toggle-check]",
  "[os-component='check']",
  ".checkbox__icon",
]);

// Containers a marker may be nested in; the container must render too, so a tick
// inside a collapsed wrapper is not read as shown.
export const ORDER_BUMP_MARKER_CONTAINERS = Object.freeze([
  ".checkbox__icon",
  ".bump-check",
  "[data-next-toggle-check]",
  "[os-component='check']",
]);

// Elements that can never be a state marker, whatever they match: the toggle's
// own form control (read separately as `inputChecked`) and anything the author
// removed from rendering outright.
export const ORDER_BUMP_MARKER_EXCLUDED = "input, select, textarea, option";

export const ORDER_BUMP_PROBE_INPUT = Object.freeze({
  toggleSelector: ORDER_BUMP_TOGGLE_SELECTOR,
  markerFamilies: ORDER_BUMP_MARKER_FAMILIES,
  markerContainers: ORDER_BUMP_MARKER_CONTAINERS,
  markerExcluded: ORDER_BUMP_MARKER_EXCLUDED,
});

// Returns the `page.evaluate` body. Exported as a factory so the browser proof
// can drive the same function the QA runner does, instead of a copy of it.
export function orderBumpEvidenceScript() {
  return ({ toggleSelector, markerFamilies, markerContainers, markerExcluded }) => {
    const hasContent = (value) => Boolean(value) && !["none", "normal", '""', "''"].includes(value);

    // The marker's `::after`, read once for both jobs it does here. A tick that
    // is absolutely positioned can render while its host box measures zero, so
    // a zero-sized host is not on its own proof that the tick is hidden — the
    // pseudo-element has to be looked at before the size test disqualifies the
    // marker. Returns null when the element has no generated content at all.
    const pseudoTick = (element) => {
      const after = getComputedStyle(element, "::after");
      if (!hasContent(after.content)) return null;
      const size = (value) => {
        const parsed = Number.parseFloat(value || "0");
        return Number.isFinite(parsed) ? parsed : 0;
      };
      return {
        shown: after.display !== "none"
          && after.visibility !== "hidden"
          && Number.parseFloat(after.opacity || "1") > 0.5,
        boxed: size(after.width) > 0 && size(after.height) > 0,
      };
    };

    const rendered = (element) => {
      if (!(element instanceof Element) || element.hidden) return false;
      if (element.closest("[hidden]")) return false;
      const style = getComputedStyle(element);
      if (style.display === "none") return false;
      if (style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (Number.parseFloat(style.opacity || "1") <= 0.5) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0) return true;
      // Zero-sized host, rendered tick: the marker is on the page after all.
      const tick = pseudoTick(element);
      return Boolean(tick && tick.shown && tick.boxed);
    };

    // A candidate must be a plausible marker at all: not the toggle's own form
    // control, not inside a subtree the author removed from rendering.
    const eligible = (element) => !element.matches(markerExcluded) && !element.closest("[hidden]");

    // Does any stylesheet rule that *currently applies* and matches this element
    // remove it from rendering? That is the display-toggled family's signature:
    // a base rule hides the tick and a state-scoped rule restores it, so the
    // element matches the hiding rule in both states. A persistent box that
    // nothing hides matches nothing here, which is exactly why its visibility
    // must not be read as its state.
    //
    // "Currently applies" is load-bearing. A rule inside `@media print`, or
    // inside an `@supports` block for a feature this browser lacks, says
    // nothing about what the buyer sees on screen; counting it would read a
    // visible, unchecked box as a hidden tick and fail a correctly declined
    // bump. So a conditional group is descended into only while its condition
    // holds, a stylesheet whose own media attribute does not match is skipped,
    // and so is a disabled one. A stylesheet the page cannot read
    // (cross-origin, no CORS) is not evidence either way and is skipped too.
    const hiddenByAMatchingRule = (element) => {
      const hides = (style) => style.getPropertyValue("display") === "none"
        || style.getPropertyValue("visibility") === "hidden"
        || Number.parseFloat(style.getPropertyValue("opacity") || "1") <= 0.5;
      const mediaApplies = (query) => {
        if (!query || query === "all") return true;
        try {
          return window.matchMedia(query).matches;
        } catch {
          return false;
        }
      };
      const groupApplies = (rule) => {
        // CSSMediaRule carries `.media`; CSSSupportsRule carries only a
        // condition. Anything else grouping (a layer, a nested style rule) has
        // no condition to fail and applies.
        if (rule.media && typeof rule.media.mediaText === "string") {
          return mediaApplies(rule.conditionText || rule.media.mediaText);
        }
        if (typeof rule.conditionText === "string") {
          try {
            return CSS.supports(rule.conditionText);
          } catch {
            return false;
          }
        }
        return true;
      };
      const walk = (rules) => {
        for (const rule of rules) {
          if (rule.cssRules) {
            if (!groupApplies(rule)) continue;
            if (walk(Array.from(rule.cssRules))) return true;
          }
          if (!rule.selectorText || !rule.style || !hides(rule.style)) continue;
          try {
            // Pseudo-element selectors throw here; they are not this family.
            if (element.matches(rule.selectorText)) return true;
          } catch {
            // unsupported selector: no evidence
          }
        }
        return false;
      };
      for (const sheet of Array.from(document.styleSheets)) {
        if (sheet.disabled) continue;
        if (!mediaApplies(sheet.media?.mediaText)) continue;
        let rules;
        try {
          rules = Array.from(sheet.cssRules || []);
        } catch {
          continue;
        }
        if (walk(rules)) return true;
      }
      return false;
    };


    // The positive signals, in the order that settles which vocabulary the
    // marker speaks. Returns null when a rendered marker carries none.
    const checkedSignal = (marker) => {
      const style = getComputedStyle(marker);
      // A marker with pseudo-element content belongs to the pseudo family
      // whatever else is true of it, and its state is that pseudo-element's
      // rendering — never the box's.
      const tick = pseudoTick(marker);
      if (tick) return { signal: "pseudo", checked: tick.shown };
      if (/check|\u2713/.test(marker.textContent || "")) return { signal: "glyph", checked: true };
      if (style.backgroundColor === "rgb(45, 148, 127)") return { signal: "fill", checked: true };
      if (hiddenByAMatchingRule(marker)) return { signal: "display_toggled", checked: true };
      return null;
    };

    // Families in order. A rendered candidate wins outright; otherwise the
    // first eligible candidate is kept so an off toggle still reports a marker
    // (which then correctly reads unchecked) rather than reporting none.
    const resolveMarker = (toggle) => {
      let fallback = null;
      for (const family of markerFamilies) {
        const candidates = Array.from(toggle.querySelectorAll(family)).filter(eligible);
        if (!candidates.length) continue;
        const shown = candidates.find(rendered);
        if (shown) return { element: shown, family };
        if (!fallback) fallback = { element: candidates[0], family };
      }
      return fallback;
    };

    const toggles = Array.from(document.querySelectorAll(toggleSelector)).filter((toggle) => {
      const rect = toggle.getBoundingClientRect();
      const style = getComputedStyle(toggle);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    }).map((toggle, index) => {
      const input = toggle.querySelector('input[type="checkbox"]');
      const resolved = resolveMarker(toggle);
      const marker = resolved?.element || null;
      const markerContainer = marker?.closest(markerContainers.join(", ")) || marker;
      const markerVisible = Boolean(marker)
        && rendered(marker)
        && Boolean(markerContainer)
        && rendered(markerContainer);
      // A hidden marker is unchecked in every family, so it needs no signal.
      // A rendered one is read for a positive signal, and a rendered marker
      // with none is unresolved rather than checked.
      const signal = marker && markerVisible ? checkedSignal(marker) : null;
      const markerSignal = marker ? (markerVisible ? signal?.signal || null : "not_rendered") : null;
      const markerChecked = Boolean(markerVisible && signal?.checked);
      // Unresolved: the marker exists and renders, but nothing on it says
      // which state it is in. Read like an absent marker, never as a
      // disagreement.
      const markerReadable = Boolean(marker) && (!markerVisible || Boolean(signal));
      const active = toggle.classList.contains("next-active")
        || toggle.classList.contains("next-in-cart")
        || toggle.classList.contains("next-selected")
        || toggle.getAttribute("aria-pressed") === "true";
      const inputChecked = input ? input.checked : null;
      const inputAgrees = inputChecked === null || inputChecked === active;
      const markerAgrees = !markerReadable || markerChecked === active;
      return {
        index,
        packageId: toggle.getAttribute("data-next-package-id") || null,
        active,
        inputChecked,
        markerResolved: markerReadable,
        // Which family matched and what it resolved to, so an operator reading
        // a misaligned verdict can see whether the harness found the right
        // element before concluding the page is wrong.
        markerFamily: resolved?.family || null,
        markerTag: marker ? marker.tagName.toLowerCase() : null,
        // Which state vocabulary the marker was read through: "pseudo",
        // "glyph", "fill", "display_toggled", "not_rendered", or null when the
        // marker renders but says nothing.
        markerSignal,
        markerChecked,
        inputAgrees,
        markerAgrees,
        statesAgree: inputAgrees && markerAgrees,
      };
    });
    return { toggles };
  };
}
