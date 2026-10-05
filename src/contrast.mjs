// The shared contrast helper: colour parsing and conversion, WCAG 2.x
// luminance and ratio, the large-text and requirement rules, and the
// measurement of one text element and one document. Pages receive it as
// source text (Function.prototype.toString), so the factory references
// nothing outside itself except standard built-ins, and reaches the DOM only
// through the el / win / doc arguments it is given. It only reads the page.
export function contrastToolkit() {
  // Chromium's computed-colour serializations, exactly as Chromium writes
  // them, and nothing else: rgb(r, g, b) and rgba(r, g, b, a) with ", "
  // separators; color() in eight predefined spaces, lab, lch, oklab and oklch
  // with three single-space-separated components and an optional " / alpha".
  // Numbers carry no "+", no bare "." and no unit or percent.
  const NUMBER = "-?\\d+(?:\\.\\d+)?(?:e[+-]\\d+)?";
  const MODERN_ARG = `(${NUMBER}|none)`;
  const LEGACY_RGB = new RegExp(`^rgb(a?)\\((${NUMBER}), (${NUMBER}), (${NUMBER})(?:, (${NUMBER}))?\\)$`);
  const MODERN = new RegExp(`^(?:color\\((srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz-d50|xyz-d65) |(lab|lch|oklab|oklch)\\()${MODERN_ARG} ${MODERN_ARG} ${MODERN_ARG}(?: \\/ ${MODERN_ARG})?\\)$`);

  // CSS Color 4 conversion matrices and transfer functions.
  const XYZ_D65_TO_LINEAR_SRGB = [
    [12831 / 3959, -329 / 214, -1974 / 3959],
    [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
    [705 / 12673, -2585 / 12673, 705 / 667],
  ];
  const LINEAR_P3_TO_XYZ_D65 = [
    [608311 / 1250200, 189793 / 714400, 198249 / 1000160],
    [35783 / 156275, 247089 / 357200, 198249 / 2500400],
    [0, 32229 / 714400, 5220557 / 5000800],
  ];
  const LINEAR_A98_TO_XYZ_D65 = [
    [573536 / 994567, 263643 / 1420810, 187206 / 994567],
    [591459 / 1989134, 6239551 / 9945670, 374412 / 4972835],
    [53769 / 1989134, 351524 / 4972835, 4929758 / 4972835],
  ];
  const LINEAR_PROPHOTO_TO_XYZ_D50 = [
    [0.7977666449006423, 0.1351812974005331, 0.0313477341283922],
    [0.2880748288194013, 0.7118352342418731, 0.0000899369387256],
    [0, 0, 0.8251046025104602],
  ];
  const LINEAR_REC2020_TO_XYZ_D65 = [
    [63426534 / 99577255, 20160776 / 139408157, 47086771 / 278816314],
    [26158966 / 99577255, 472592308 / 697040785, 8267143 / 139408157],
    [0, 19567812 / 697040785, 295819943 / 278816314],
  ];
  const XYZ_D50_TO_D65 = [
    [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
    [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
    [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
  ];
  const OKLAB_TO_LMS = [
    [1, 0.3963377773761749, 0.2158037573099136],
    [1, -0.1055613458156586, -0.0638541728258133],
    [1, -0.0894841775298119, -1.2914855480194092],
  ];
  const LMS_TO_XYZ_D65 = [
    [1.2268798758459243, -0.5578149944602171, 0.2813910456659647],
    [-0.0405757452148008, 1.112286803280317, -0.0717110580655164],
    [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816],
  ];
  const D50_WHITE = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
  const REC2020_ALPHA = 1.09929682680944;
  const REC2020_BETA = 0.018053968510807;

  // Math.pow, **, exp, log, sin and cos are implementation-approximated and
  // differ in the last bits between Chromium and Node, so a page measurement
  // would not re-derive exactly elsewhere. Every value here comes from + - * /
  // alone (exactly rounded in every engine), with fixed-length series.
  const LN2 = 0.6931471805599453;
  const ln = (x) => {
    let exponent = 0;
    let m = x;
    while (m > Math.SQRT2) { m /= 2; exponent += 1; }
    while (m < Math.SQRT1_2) { m *= 2; exponent -= 1; }
    const s = (m - 1) / (m + 1);
    let term = s;
    let sum = 0;
    for (let k = 1; k <= 41; k += 2) { sum += term / k; term *= s * s; }
    return 2 * sum + exponent * LN2;
  };
  const exp = (y) => {
    const k = Math.round(y / LN2);
    const r = y - k * LN2;
    let term = 1;
    let sum = 1;
    for (let n = 1; n <= 20; n += 1) { term *= r / n; sum += term; }
    for (let i = 0; i < Math.abs(k); i += 1) sum = k < 0 ? sum / 2 : sum * 2;
    return sum;
  };
  const pow = (x, y) => (x === 0 || !Number.isFinite(x) ? x : exp(y * ln(x)));
  const cube = (x) => x * x * x;
  // [cos, sin] of a hue in degrees.
  const cosSin = (degrees) => {
    const turn = ((degrees % 360) + 360) % 360;
    const quadrant = Math.round(turn / 90);
    const x = (turn - quadrant * 90) * (Math.PI / 180);
    let c = 1;
    let s = x;
    let tc = 1;
    let ts = x;
    for (let n = 1; n <= 10; n += 1) {
      tc *= -(x * x) / ((2 * n - 1) * (2 * n));
      ts *= -(x * x) / ((2 * n) * (2 * n + 1));
      c += tc;
      s += ts;
    }
    return [[c, s], [-s, c], [-c, -s], [s, -c], [c, s]][quadrant];
  };

  const multiply = (matrix, vector) => matrix.map((row) => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]);
  const signed = (c, magnitude) => (c < 0 ? -magnitude : magnitude);
  const srgbToLinear = (c) => (Math.abs(c) <= 0.04045 ? c / 12.92 : signed(c, pow((Math.abs(c) + 0.055) / 1.055, 2.4)));
  const linearToSrgb = (c) => (Math.abs(c) > 0.0031308 ? signed(c, 1.055 * pow(Math.abs(c), 1 / 2.4) - 0.055) : 12.92 * c);
  const polarToCartesian = ([l, chroma, hue]) => {
    const [cos, sin] = cosSin(hue);
    return [l, chroma * cos, chroma * sin];
  };
  const labToXyzD50 = ([l, a, b]) => {
    const kappa = 24389 / 27;
    const epsilon = 216 / 24389;
    const fy = (l + 16) / 116;
    const fx = a / 500 + fy;
    const fz = fy - b / 200;
    const xyz = [cube(fx) > epsilon ? cube(fx) : (116 * fx - 16) / kappa, l > kappa * epsilon ? cube(fy) : l / kappa, cube(fz) > epsilon ? cube(fz) : (116 * fz - 16) / kappa];
    return xyz.map((value, i) => value * D50_WHITE[i]);
  };
  const TO_XYZ_D65 = {
    "display-p3": (c) => multiply(LINEAR_P3_TO_XYZ_D65, c.map(srgbToLinear)),
    "a98-rgb": (c) => multiply(LINEAR_A98_TO_XYZ_D65, c.map((v) => signed(v, pow(Math.abs(v), 563 / 256)))),
    "prophoto-rgb": (c) => multiply(XYZ_D50_TO_D65, multiply(LINEAR_PROPHOTO_TO_XYZ_D50, c.map((v) => (Math.abs(v) <= 16 / 512 ? v / 16 : signed(v, pow(Math.abs(v), 1.8)))))),
    rec2020: (c) => multiply(LINEAR_REC2020_TO_XYZ_D65, c.map((v) => (Math.abs(v) < REC2020_BETA * 4.5 ? v / 4.5 : signed(v, pow((Math.abs(v) + REC2020_ALPHA - 1) / REC2020_ALPHA, 1 / 0.45))))),
    "xyz-d50": (c) => multiply(XYZ_D50_TO_D65, c),
    "xyz-d65": (c) => c,
    lab: (c) => multiply(XYZ_D50_TO_D65, labToXyzD50(c)),
    lch: (c) => multiply(XYZ_D50_TO_D65, labToXyzD50(polarToCartesian(c))),
    oklab: (c) => multiply(LMS_TO_XYZ_D65, multiply(OKLAB_TO_LMS, c).map(cube)),
    oklch: (c) => multiply(LMS_TO_XYZ_D65, multiply(OKLAB_TO_LMS, polarToCartesian(c)).map(cube)),
  };

  function parseComputedColor(str) {
    const text = typeof str === "string" ? str : "";
    const component = (part) => (part === undefined ? 1 : part === "none" ? 0 : Number(part));
    // rgba() carries an alpha and rgb() does not.
    const legacy = LEGACY_RGB.exec(text);
    if (legacy && (legacy[1] === "a") === (legacy[5] !== undefined)) return { space: "rgb", coords: [Number(legacy[2]), Number(legacy[3]), Number(legacy[4])], alpha: component(legacy[5]) };
    const modern = MODERN.exec(text);
    if (modern) return { space: modern[1] || modern[2], coords: [component(modern[3]), component(modern[4]), component(modern[5])], alpha: component(modern[6]) };
    return { unparseable: str };
  }

  function toSrgb(color) {
    const { space, coords, alpha } = color;
    const encoded = space === "rgb" ? coords.map((c) => c / 255)
      : space === "srgb" ? coords
        : space === "srgb-linear" ? coords.map(linearToSrgb)
          : multiply(XYZ_D65_TO_LINEAR_SRGB, TO_XYZ_D65[space](coords)).map(linearToSrgb);
    const rgb = encoded.map((c) => Math.min(1, Math.max(0, c)));
    return { rgb, alpha, gamut_clipped: rgb.some((c, i) => c !== encoded[i]) };
  }

  function relativeLuminance([r, g, b]) {
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  }

  function contrastRatio(La, Lb) {
    return (Math.max(La, Lb) + 0.05) / (Math.min(La, Lb) + 0.05);
  }

  // Source-over in gamma-encoded sRGB, as Chromium paints.
  function compositeOver(top, bottom) {
    const alpha = top.alpha + bottom.alpha * (1 - top.alpha);
    if (alpha === 0) return { rgb: [0, 0, 0], alpha: 0 };
    return { rgb: top.rgb.map((c, i) => (c * top.alpha + bottom.rgb[i] * bottom.alpha * (1 - top.alpha)) / alpha), alpha };
  }

  function isLargeText({ fontSizePx, fontWeight }) {
    return fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
  }

  function requiredRatio(isLarge) {
    return isLarge ? 3 : 4.5;
  }

  function meetsRequirement(ratio, required) {
    return ratio >= required;
  }

  function displayRatio(ratio) {
    return Math.round(ratio * 100) / 100;
  }

  // bg_layers_raw runs from the element outwards and ends at the opaque
  // layer (or the default canvas). Without an opaque bottom there is no
  // painted background to compare against, so the colour fields are null.
  function deriveElementMeasurement({ fg_raw, fill_raw, bg_layers_raw, font_size_px, font_weight }) {
    const large = isLargeText({ fontSizePx: font_size_px, fontWeight: font_weight });
    const sized = { size_class: large ? "large" : "normal", required: requiredRatio(large) };
    const color = parseComputedColor(fg_raw);
    const fill = parseComputedColor(fill_raw);
    const layers = (Array.isArray(bg_layers_raw) ? bg_layers_raw : []).map(parseComputedColor);
    if ([color, fill, ...layers].some((parsed) => "unparseable" in parsed)) {
      return { fg_srgb: null, bg_srgb: null, gamut_clipped: null, ratio: null, ...sized, review_reason: "unparseable_color" };
    }
    const foreground = toSrgb(JSON.stringify(fill) !== JSON.stringify(color) ? fill : color);
    const backgrounds = layers.map(toSrgb);
    const gamut_clipped = [foreground, ...backgrounds].some((converted) => converted.gamut_clipped);
    const background = backgrounds.reduceRight((under, layer) => compositeOver(layer, under), { rgb: [0, 0, 0], alpha: 0 });
    if (background.alpha < 1) return { fg_srgb: null, bg_srgb: null, gamut_clipped, ratio: null, ...sized, review_reason: null };
    const fg_srgb = compositeOver(foreground, background).rgb;
    const ratio = contrastRatio(relativeLuminance(fg_srgb), relativeLuminance(background.rgb));
    return { fg_srgb, bg_srgb: background.rgb, gamut_clipped, ratio, ...sized, review_reason: null };
  }

  // Element measurement. Review reasons are indexed by trigger number; the
  // lowest-numbered trigger that holds is the element's review_reason.
  const REVIEW_REASONS = [null, "background_gradient", "background_image", "pseudo_element_background", "overlapping_layer", "opacity", "filter", "blend_mode", "text_fill_background", "unparseable_color", "canvas_unknown", "disabled_state_uncertain", "mask"];
  const CONTROL_SELECTOR = "button, input, select, textarea, a[href], [role=\"button\"], [role=\"checkbox\"], [role=\"radio\"], [role=\"switch\"], [data-next-action], [data-next-upsell-action]";
  const DISABLED_SELECTOR = ":disabled, [aria-disabled=\"true\"]";
  const LOADING_ATTRIBUTES = ["data-next-loading", "data-next-sdk-loading"];
  const STATE_SELECTORS = [
    ["selected", "[data-next-selected=\"true\"], .next-selected, [aria-checked=\"true\"]"],
    ["active", ".next-active, .next-in-cart, [aria-pressed=\"true\"]"],
  ];
  const ROLE_SELECTOR_ATTRIBUTES = [
    "data-next-action", "data-next-upsell-action", "os-checkout-payment", "type",
    "data-next-bundle-card", "data-next-selector-card", "data-next-package-id", "data-next-bundle-id",
    "data-next-toggle-card", "data-next-bump", "data-next-package-toggle",
    "data-next-display", "data-next-bundle-display", "data-next-checkout-field",
  ];
  const REPLACED_ELEMENTS = new Set(["img", "video", "canvas", "svg", "picture", "iframe", "object", "embed"]);
  const SDK_LOADER_SRC = /campaign-cart(?:@[^"']*)?\/dist\/loader\.js/i;
  const DEFAULT_CANVAS = "rgb(255, 255, 255)";
  const COLOUR_FIELDS = { fg_raw: null, fill_raw: null, bg_layers_raw: null, fg_srgb: null, bg_srgb: null, gamut_clipped: null, ratio: null };

  const isSet = (value, none = "none") => value !== "" && value !== none;
  const transparent = (value) => parseComputedColor(value).alpha === 0;
  const paintsBackground = (style) => isSet(style.getPropertyValue("background-image")) || !transparent(style.getPropertyValue("background-color"));
  const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    return el.checkVisibility({ visibilityProperty: true }) && rect.width > 0 && rect.height > 0;
  };

  // The flat tree, as the page renders it: an element slotted into an open
  // shadow root sits in its slot, and the top element of a shadow tree sits
  // in the root's host. Closed roots hide their slots, so an element slotted
  // into one steps to its light-DOM parent.
  const shadowRootOf = (el) => (el.parentNode && el.parentNode.nodeType === 11 && el.parentNode.host ? el.parentNode : null);
  const flatParent = (el) => el.assignedSlot || el.parentElement || (shadowRootOf(el) ? shadowRootOf(el).host : null);
  const flatClosest = (el, selector) => {
    for (let at = el; at && at.nodeType === 1; at = flatParent(at)) if (at.matches(selector)) return at;
    return null;
  };
  const flatContains = (ancestor, el) => {
    for (let at = el; at; at = flatParent(at)) if (at === ancestor) return true;
    return false;
  };
  // The frame element a window is shown in, when the document around it is
  // readable (same-origin); otherwise null.
  const frameOf = (view) => {
    try {
      return (view && view.frameElement) || null;
    } catch {
      return null;
    }
  };
  // The next element out from `at` as the page paints it, with that
  // element's window: its flat-tree parent, or, from the root of a
  // same-origin frame's document, the frame element in the document around
  // it.
  const outward = (at, view) => {
    const up = flatParent(at);
    if (up) return [up, view];
    const frame = at.ownerDocument && at === at.ownerDocument.documentElement ? frameOf(view) : null;
    return frame ? [frame, frame.ownerDocument.defaultView] : [null, view];
  };
  // Where an element's own text renders: the flat-tree parents of its
  // non-blank text nodes. That is the element itself, except for the host of
  // an open shadow root, whose own text renders only through the slot that
  // takes it in. Such text inherits that slot's style and is painted by the
  // shadow tree around the slot; text no slot takes in, or that its slot
  // does not show, is not rendered.
  const textParents = (el, win) => {
    const own = Array.from(el.childNodes).filter((node) => node.nodeType === 3 && /\S/.test(node.nodeValue));
    if (!el.shadowRoot) return own.length ? [el] : [];
    const range = el.ownerDocument.createRange();
    const shown = own.filter((node) => {
      if (!node.assignedSlot || win.getComputedStyle(node.assignedSlot).getPropertyValue("visibility") !== "visible") return false;
      range.selectNodeContents(node);
      return range.getClientRects().length > 0;
    });
    return [...new Set(shown.map((node) => node.assignedSlot))];
  };
  // Every element under `scope`, and under each open shadow root inside it.
  const deepElements = (scope) => {
    const found = [];
    const pending = [scope];
    while (pending.length) {
      for (const node of pending.shift().querySelectorAll("*")) {
        found.push(node);
        if (node.shadowRoot) pending.push(node.shadowRoot);
      }
    }
    return found;
  };

  // Overlap candidates are read once per document, open shadow roots
  // included.
  const overlapCandidates = new WeakMap();
  function overlapCandidatesOf(doc, win) {
    if (!overlapCandidates.has(doc)) {
      const body = doc.body;
      const elements = body ? [...(body.shadowRoot ? deepElements(body.shadowRoot) : []), ...deepElements(body)] : [];
      const candidates = elements.filter((node) => {
        if (!isVisible(node)) return false;
        if (REPLACED_ELEMENTS.has(node.localName)) return true;
        const style = win.getComputedStyle(node);
        return ["absolute", "fixed", "sticky"].includes(style.getPropertyValue("position")) && paintsBackground(style);
      });
      overlapCandidates.set(doc, candidates.map((node) => ({ node, rect: node.getBoundingClientRect() })));
    }
    return overlapCandidates.get(doc);
  }

  // The element's place in the page: up to 8 flat-tree steps, outwards
  // through each slot, each shadow host and each same-origin frame. ">>>"
  // marks a step into another tree: a slot to the element slotted into it, a
  // host to the top of its shadow tree, a frame to its document. The
  // :nth-of-type index counts the element's siblings in its own tree.
  function selectorPath(el) {
    let path = "";
    let joiner = ">";
    let steps = 0;
    for (let at = el; at && at.nodeType === 1 && steps < 8; steps += 1) {
      const tag = at.localName;
      const attributes = ROLE_SELECTOR_ATTRIBUTES.filter((name) => at.hasAttribute(name)).map((name) => `[${name}=${JSON.stringify(at.getAttribute(name))}]`).join("");
      const siblings = at.parentElement || shadowRootOf(at);
      const nth = siblings && tag !== "body" ? `:nth-of-type(${Array.from(siblings.children).filter((sibling) => sibling.localName === tag).indexOf(at) + 1})` : "";
      path = `${tag}${attributes}${nth}${path ? `${joiner}${path}` : ""}`;
      const up = flatParent(at);
      const view = at.ownerDocument && at === at.ownerDocument.documentElement ? at.ownerDocument.defaultView : null;
      joiner = up && up === at.parentElement ? ">" : ">>>";
      at = up || (view && view.frameElement) || null;
    }
    return path;
  }

  // Expanded: inside the content an aria-expanded="true" control names
  // through aria-controls, resolved in the control's own document or shadow
  // root.
  function stateOf(el) {
    for (const [state, selector] of STATE_SELECTORS) if (flatClosest(el, selector)) return state;
    if (flatClosest(el, "details[open]")) return "expanded";
    for (let at = el; at; at = flatParent(at)) {
      const root = at.id ? at.getRootNode() : null;
      if (!root || root.getElementById(at.id) !== at) continue;
      if (Array.from(root.querySelectorAll("[aria-expanded=\"true\"][aria-controls]")).some((control) => control.getAttribute("aria-controls").split(/\s+/).includes(at.id))) return "expanded";
    }
    return "default";
  }

  function isTextBearing(el, win) {
    if (!isVisible(el)) return false;
    if (el.localName === "input") return (el.type === "submit" || el.type === "button") && el.value !== "";
    return textParents(el, win).length > 0;
  }

  // The text's style, its control and state, and the paint walk start where
  // its text renders (textParents). The element's identity, its rendered
  // flag and its box are its own. A shadow host's text can render through
  // more than one slot (manual slot assignment): each slot's text is read
  // through that slot, and the first slot's reading is recorded. When another
  // slot's text sits in another control or state, or reads other colours,
  // font or backgrounds, the host's box holds text painted by a subtree
  // outside the recorded slot's ancestry: review trigger 4, never one slot's
  // measurement standing for all of it. Every slot's triggers count.
  //
  // Text in a same-origin frame's document is painted by the frame element
  // and everything around it too: the paint walk continues from the
  // document's root to the frame element in the document around it, paint
  // effects up to the top root, backgrounds through a transparent frame
  // document until an opaque layer, and overlap candidates in each
  // document the text box is shown in. A frame document whose root
  // color-scheme differs from its frame element's paints its own canvas,
  // which is not read: trigger 10.
  function measureTextElement(el, win) {
    const origins = textParents(el, win);
    const [origin = el] = origins;
    const style = win.getComputedStyle(origin);
    const font_size_px = Number.parseFloat(style.getPropertyValue("font-size"));
    const font_weight = Number(style.getPropertyValue("font-weight"));
    const large = isLargeText({ fontSizePx: font_size_px, fontWeight: font_weight });
    const control = flatClosest(origin, CONTROL_SELECTOR);
    const state = stateOf(origin);
    const mixed = origins.slice(1).some((other) => flatClosest(other, CONTROL_SELECTOR) !== control || stateOf(other) !== state);
    const disabled = el.matches(DISABLED_SELECTOR) || (!mixed && Boolean(control && control.matches(DISABLED_SELECTOR)));
    const control_loading = !mixed && Boolean(control) && LOADING_ATTRIBUTES.some((name) => control.hasAttribute(name) && control.getAttribute(name) !== "false");
    const head = { selector_path: selectorPath(el), state, disabled, rendered: isTextBearing(el, win), font_size_px, font_weight, size_class: large ? "large" : "normal" };
    if (disabled || control_loading) return { ...head, ...COLOUR_FIELDS, required: requiredRatio(large), review_reason: null, control_loading };

    const triggers = new Set();
    const paintEffects = (layer) => {
      if (Number.parseFloat(layer.getPropertyValue("opacity")) < 1) triggers.add(5);
      if (isSet(layer.getPropertyValue("filter")) || isSet(layer.getPropertyValue("backdrop-filter"))) triggers.add(6);
      if (isSet(layer.getPropertyValue("mix-blend-mode"), "normal")) triggers.add(7);
      if (isSet(layer.getPropertyValue("mask-image")) || isSet(layer.getPropertyValue("-webkit-mask-image"))) triggers.add(12);
    };
    const schemeOf = (view, at) => view.getComputedStyle(at).getPropertyValue("color-scheme");
    const light = (scheme) => scheme === "normal" || scheme === "light";
    const sameScheme = (a, b) => (light(a) ? light(b) : a === b);
    // One slot's (or the element's own) reading, adding the triggers on its
    // way out.
    const readThrough = (start) => {
      const startStyle = start === origin ? style : win.getComputedStyle(start);
      const fg_raw = startStyle.getPropertyValue("color");
      const fill_raw = startStyle.getPropertyValue("-webkit-text-fill-color");
      const fillTransparent = transparent(fill_raw);
      const bg_layers_raw = [];
      let opaque = false;
      let unread = false;
      let view = win;
      let root = el.ownerDocument.documentElement;
      for (let at = start; at && at.nodeType === 1;) {
        const layer = at === start ? startStyle : view.getComputedStyle(at);
        paintEffects(layer);
        if (!opaque && !unread) {
          const image = layer.getPropertyValue("background-image");
          if (image.includes("-gradient(")) triggers.add(1);
          else if (isSet(image)) triggers.add(2);
          if (["::before", "::after"].some((pseudo) => {
            const generated = view.getComputedStyle(at, pseudo);
            return !["none", "normal"].includes(generated.getPropertyValue("content")) && paintsBackground(generated);
          })) triggers.add(3);
          if (fillTransparent && [layer.getPropertyValue("background-clip"), layer.getPropertyValue("-webkit-background-clip")].some((clip) => /\btext\b/.test(clip))) triggers.add(8);
          const color = layer.getPropertyValue("background-color");
          bg_layers_raw.push(color);
          opaque = parseComputedColor(color).alpha >= 1;
        }
        const [next, nextView] = outward(at, view);
        if (next && nextView !== view) {
          if (!opaque && !unread && !sameScheme(schemeOf(view, root), schemeOf(nextView, next))) {
            triggers.add(10);
            unread = true;
          }
          root = next.ownerDocument.documentElement;
        }
        at = next;
        view = nextView;
      }
      if (!opaque && !unread) {
        if (light(schemeOf(view, root))) bg_layers_raw.push(DEFAULT_CANVAS);
        else triggers.add(10);
      }
      return { fg_raw, fill_raw, bg_layers_raw, font_size_px: Number.parseFloat(startStyle.getPropertyValue("font-size")), font_weight: Number(startStyle.getPropertyValue("font-weight")) };
    };
    const { fg_raw, fill_raw, bg_layers_raw } = readThrough(origin);
    const reading = JSON.stringify({ fg_raw, fill_raw, bg_layers_raw, font_size_px, font_weight });
    if (mixed) triggers.add(4);
    for (const other of origins.slice(1)) if (JSON.stringify(readThrough(other)) !== reading) triggers.add(4);

    // Overlap in the element's own document, then in each document around
    // its frames, with the text box moved into that document's viewport.
    let box = el.getBoundingClientRect();
    let inner = origin;
    let view = win;
    for (let doc = el.ownerDocument; doc;) {
      if (overlapCandidatesOf(doc, view).some(({ node, rect }) => !flatContains(node, inner) && !flatContains(inner, node) && intersects(rect, box))) triggers.add(4);
      const frame = frameOf(view);
      if (!frame) break;
      const outer = frame.ownerDocument.defaultView;
      const frameBox = frame.getBoundingClientRect();
      const frameStyle = outer.getComputedStyle(frame);
      const dx = frameBox.left + frame.clientLeft + (Number.parseFloat(frameStyle.getPropertyValue("padding-left")) || 0);
      const dy = frameBox.top + frame.clientTop + (Number.parseFloat(frameStyle.getPropertyValue("padding-top")) || 0);
      box = { left: box.left + dx, right: box.right + dx, top: box.top + dy, bottom: box.bottom + dy };
      inner = frame;
      view = outer;
      doc = frame.ownerDocument;
    }
    if (el.matches(".next-disabled") || Boolean(control && control.matches(".next-disabled"))) triggers.add(11);

    const derived = deriveElementMeasurement({ fg_raw, fill_raw, bg_layers_raw, font_size_px, font_weight });
    if (derived.review_reason) triggers.add(9);
    return {
      ...head,
      fg_raw,
      fill_raw,
      bg_layers_raw,
      fg_srgb: derived.fg_srgb,
      bg_srgb: derived.bg_srgb,
      gamut_clipped: derived.gamut_clipped,
      ratio: derived.ratio,
      required: derived.required,
      review_reason: triggers.size ? REVIEW_REASONS[Math.min(...triggers)] : null,
      control_loading,
    };
  }

  // First match: SDK readiness, then stylesheets, then fonts. The SDK and
  // stylesheet checks read every tree of the document: its own elements and
  // each open shadow root inside it. Chromium gives a stylesheet that failed
  // to load an empty sheet, so a sheet is also incomplete when its resource
  // entry reports an HTTP error status. Each @import, in a <style> or in a
  // linked or imported sheet, is a stylesheet too: incomplete while its rule
  // has no sheet. A sheet whose rules cannot be read (cross-origin) has
  // loaded, and its imports are not seen.
  function documentMeasurability(doc) {
    const body = doc.body;
    const trees = [doc, ...deepElements(doc).filter((node) => node.shadowRoot).map((node) => node.shadowRoot)];
    const everywhere = (selector) => trees.flatMap((tree) => Array.from(tree.querySelectorAll(selector)));
    const declared = Boolean(body && body.hasAttribute("data-next-sdk-loading"))
      || everywhere("script[src]").some((script) => SDK_LOADER_SRC.test(script.getAttribute("src")));
    const ready = Boolean(body && body.getAttribute("data-next-sdk-loading") === "false") || doc.documentElement.classList.contains("next-display-ready");
    if (declared && !ready) return { measurable: false, reason: "sdk_not_ready" };
    const timing = doc.defaultView ? doc.defaultView.performance : null;
    const failed = (url) => Boolean(timing) && Boolean(url) && timing.getEntriesByName(url).some((entry) => entry.responseStatus >= 400);
    const seen = new Set();
    const importsIncomplete = (sheet) => {
      if (!sheet || seen.has(sheet)) return false;
      seen.add(sheet);
      let rules;
      try {
        rules = Array.from(sheet.cssRules || []);
      } catch {
        return false;
      }
      return rules.some((rule) => rule.type === 3 && (!rule.styleSheet || failed(rule.styleSheet.href) || importsIncomplete(rule.styleSheet)));
    };
    const linkIncomplete = (link) => !link.sheet || failed(link.href) || importsIncomplete(link.sheet);
    if (everywhere("link[rel=stylesheet]").some(linkIncomplete) || everywhere("style").some((style) => importsIncomplete(style.sheet))) return { measurable: false, reason: "styles_incomplete" };
    if (doc.fonts.status !== "loaded") return { measurable: false, reason: "fonts_pending" };
    return { measurable: true };
  }

  return {
    version: "contrast/v1",
    parseComputedColor,
    toSrgb,
    relativeLuminance,
    contrastRatio,
    compositeOver,
    isLargeText,
    requiredRatio,
    meetsRequirement,
    displayRatio,
    deriveElementMeasurement,
    isTextBearing,
    measureTextElement,
    documentMeasurability,
  };
}
