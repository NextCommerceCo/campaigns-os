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
// The state signal is the marker's own rendering. That is the mechanism the
// shared checkout CSS actually uses: `[data-next-toggle-card] [os-component=
// "check"] { display: none }` with the active/in-cart card restoring
// `display: flex`. A tick that is rendered is a rendered tick. A toggle whose
// tick is only recoloured rather than shown and hidden does not express its
// state through this vocabulary; it resolves no marker, and the check falls
// back to the input-versus-active reading instead of inventing a disagreement.

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
    const rendered = (element) => {
      if (!(element instanceof Element) || element.hidden) return false;
      if (element.closest("[hidden]")) return false;
      const style = getComputedStyle(element);
      if (style.display === "none") return false;
      if (style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (Number.parseFloat(style.opacity || "1") <= 0.5) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
    };

    // A candidate must be a plausible marker at all: not the toggle's own form
    // control, not inside a subtree the author removed from rendering.
    const eligible = (element) => !element.matches(markerExcluded) && !element.closest("[hidden]");

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
      // The marker is the tick, and the tick's rendering is the state.
      const markerChecked = markerVisible;
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
        markerResolved: Boolean(marker),
        // Which family matched and what it resolved to, so an operator reading
        // a misaligned verdict can see whether the harness found the right
        // element before concluding the page is wrong.
        markerFamily: resolved?.family || null,
        markerTag: marker ? marker.tagName.toLowerCase() : null,
        markerChecked,
        inputAgrees,
        markerAgrees,
        statesAgree: inputAgrees && markerAgrees,
      };
    });
    return { toggles };
  };
}
