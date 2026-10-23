// Element parity probe: one read-only isolated-world read per side of every
// visual cell, run through C's runVisualPass probe hook (RC-1 to RC-4). It
// reads text-bearing elements (readability's rule, through the shared
// contrast helper) and returns a ProbeOutput (stream P contract Appendix A).
// The output is written only to the local probe files (src/parity/snapshot.mjs),
// never to the report.
import { contrastToolkit } from "../contrast.mjs";
import { PARITY_MAX_ROUTES, PARITY_PROBE_CELL_MS, PARITY_PROBE_RUN_MS, PARITY_PROBE_WALK_MS } from "../polish-deadline.mjs";

export const PARITY_PROBE_NAME = "element_parity";
export { PARITY_PROBE_VERSION } from "./element-parity-record.mjs";
export const PARITY_PROBE_LIMITS_ARG = Object.freeze({ elements: 1500, text_chars: 500, page_text_chars: 262144, font_faces: 200, walk_ms: PARITY_PROBE_WALK_MS });

// The page-side read. It never clicks, focuses, hovers, scrolls, types or
// writes, and it never enters a frame's document or a closed shadow root:
// those are counted in `coverage`. `closedRoots` are the closed shadow roots
// the hook resolved into this world (RC-3).
//
// - page_text is assembled before element measurement:
//   body.innerText, then for each open shadow root in walk order a space and
//   the textContent of each of its child elements other than style, script
//   and template; whitespace-collapsed and cut at limits.page_text_chars.
//   If traversal exhausts the clock first, unread text is marked truncated.
// - The walk covers the document and every open shadow root, entered right
//   after its host, and stops at limits.elements text-bearing elements or
//   once limits.walk_ms has passed since the probe started. A selector path
//   is cut at 2 048 code points (the comparator's selector_path_chars).
// - font_faces are document.fonts in iteration order, at most limits.font_faces.
export function parityProbe(toolkit, limits, closedRoots) {
  const started = performance.now();
  let timeCapped = false;
  const outOfTime = () => {
    if (performance.now() - started >= limits.walk_ms) timeCapped = true;
    return timeCapped;
  };
  const win = window;
  const doc = document;
  const collapse = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  // [the first `max` code points, whether anything was cut]
  const cut = (value, max) => {
    let count = 0;
    let index = 0;
    for (const char of value) {
      if (count === max) return [value.slice(0, index), true];
      count += 1;
      index += char.length;
    }
    return [value, false];
  };
  const inOrder = [];
  const openRoots = [];
  const enter = (top) => {
    for (const el of top) {
      if (outOfTime()) return;
      inOrder.push(el);
      if (el.shadowRoot) {
        openRoots.push(el.shadowRoot);
        enter(el.shadowRoot.querySelectorAll("*"));
      }
    }
  };
  if (doc.body) enter([doc.body, ...doc.body.querySelectorAll("*")]);

  let textIncomplete = outOfTime();
  let rawText = doc.body && !textIncomplete ? doc.body.innerText : "";
  for (const root of openRoots) {
    for (const child of root.children) {
      if (outOfTime()) { textIncomplete = true; break; }
      if (!["style", "script", "template"].includes(child.localName)) rawText += ` ${child.textContent}`;
    }
    if (timeCapped) break;
  }
  const [pageText, pageTextTruncated] = cut(collapse(rawText), limits.page_text_chars);

  const fontFaces = [];
  let fontFacesCapped = false;
  for (const face of doc.fonts) {
    if (outOfTime()) { fontFacesCapped = true; break; }
    if (fontFaces.length >= limits.font_faces) {
      fontFacesCapped = true;
      break;
    }
    fontFaces.push({ family: String(face.family).replace(/^(["'])(.*)\1$/s, "$2"), status: face.status });
  }

  let framesNotRead = 0;
  for (const el of inOrder) {
    if (outOfTime()) break;
    if ((el.localName === "iframe" || el.localName === "frame") && toolkit.isVisible(el)) framesNotRead += 1;
  }

  const round1 = (value) => Math.round(value * 10) / 10;
  const length = (value) => (value === "normal" ? "normal" : Number.parseFloat(value));
  const directText = (el) => (el.localName === "input"
    ? el.value
    : Array.from(el.childNodes).filter((node) => node.nodeType === 3).map((node) => node.data).join(""));
  const subtreeText = (el) => (el.localName === "input" ? el.value : typeof el.innerText === "string" ? el.innerText : el.textContent);
  const read = (el, index) => {
    const rect = el.getBoundingClientRect();
    const style = win.getComputedStyle(el);
    const measured = toolkit.measureTextElement(el, win);
    return {
      index,
      selector_path: cut(toolkit.selectorPath(el), 2048)[0],
      text: cut(collapse(directText(el)), limits.text_chars)[0],
      ftext: cut(collapse(subtreeText(el)), limits.text_chars)[0],
      box: { x: round1(rect.left + win.scrollX), y: round1(rect.top + win.scrollY), w: round1(rect.width), h: round1(rect.height) },
      font_family: style.getPropertyValue("font-family"),
      font_size_px: Number.parseFloat(style.getPropertyValue("font-size")),
      font_weight: Number(style.getPropertyValue("font-weight")),
      font_style: style.getPropertyValue("font-style"),
      line_height: length(style.getPropertyValue("line-height")),
      letter_spacing: length(style.getPropertyValue("letter-spacing")),
      text_transform: style.getPropertyValue("text-transform"),
      fg_srgb: measured.fg_srgb,
      bg_srgb: measured.bg_srgb,
      color_review: measured.review_reason ?? null,
    };
  };
  const elements = [];
  let elementsCapped = false;
  for (const el of inOrder) {
    if (outOfTime()) break;
    if (!toolkit.isTextBearing(el, win)) continue;
    // Visibility/text classification can itself trigger layout. Do not start
    // a measurement after it has consumed the remaining budget.
    if (outOfTime()) break;
    if (elements.length >= limits.elements) {
      elementsCapped = true;
      break;
    }
    elements.push(read(el, elements.length));
    if (outOfTime()) break;
  }

  const closedShadowRoots = new Set(closedRoots.filter((root) => root && root.nodeType === 11)).size;

  const output = {
    viewport: { width: win.innerWidth, height: win.innerHeight },
    dpr: win.devicePixelRatio,
    elements,
    page_text: pageText,
    font_faces: fontFaces,
    coverage: {
      elements_capped: elementsCapped,
      time_capped: timeCapped,
      page_text_truncated: pageTextTruncated || textIncomplete,
      font_faces_capped: fontFacesCapped,
      closed_shadow_roots: closedShadowRoots,
      frames_not_read: framesNotRead,
    },
  };
  // Account for the final element, viewport reads and coverage bookkeeping.
  output.coverage.time_capped = outOfTime();
  return output;
}

// The function declaration the hook calls in the isolated world: the probe,
// composed with the shared contrast helper by source text, as
// readabilityProbeSource does.
export function parityProbeSource() {
  return `function (limits, ...closedRoots) { return (${parityProbe.toString()})((${contrastToolkit.toString()})(), limits, closedRoots); }`;
}

const cellKey = (side, route, viewport) => JSON.stringify([side, route, viewport]);

// One run's probe entry for runVisualPass({ probes }) and what it observed.
// The grid is the first `maxRoutes` plan routes; `select` refuses every other
// route's cells, and every cell once the elapsed_ms of the run's parity probes
// reaches `runMs` (those cells are remembered as run_budget_exhausted).
// `onResult` keeps each side's result by (side, route, viewport).
export function createParityProbeRun({ routes, runMs = PARITY_PROBE_RUN_MS, maxRoutes = PARITY_MAX_ROUTES } = {}) {
  const captured = new Set((Array.isArray(routes) ? routes : []).slice(0, maxRoutes).map((route) => route.requested_route));
  const results = new Map();
  const exhausted = new Set();
  let spent = 0;
  const probe = Object.freeze({
    name: PARITY_PROBE_NAME,
    source: parityProbeSource(),
    args: [PARITY_PROBE_LIMITS_ARG],
    boundMs: PARITY_PROBE_CELL_MS,
    closedRoots: true,
    select(cell) {
      if (!captured.has(cell?.route)) return false;
      if (spent >= runMs) {
        exhausted.add(cellKey(cell.side, cell.route, cell.viewport));
        return false;
      }
      return true;
    },
    onResult(cell, result) {
      if (!captured.has(cell?.route)) return;
      const elapsed = result?.elapsed_ms;
      spent += Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : PARITY_PROBE_CELL_MS;
      results.set(cellKey(cell.side, cell.route, cell.viewport), result);
    },
  });
  return {
    probe,
    spentMs: () => spent,
    result: (side, route, viewport) => results.get(cellKey(side, route, viewport)) ?? null,
    exhausted: (side, route, viewport) => exhausted.has(cellKey(side, route, viewport)),
  };
}
