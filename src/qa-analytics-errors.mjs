const ANALYTICS_CAPTURE_ERROR_DEFINITIONS = Object.freeze({
  attach: Object.freeze({
    code: "analytics_capture_attach_failed",
    message: "analytics capture could not be attached",
  }),
  unreadable: Object.freeze({
    code: "analytics_capture_unreadable",
    message: "analytics capture could not be read from the settled page",
  }),
  settle: Object.freeze({
    code: "analytics_settle_failed",
    message: "analytics settle window could not complete",
  }),
  settleDeadline: Object.freeze({
    code: "analytics_settle_deadline_exhausted",
    message: "analytics settle window exceeded the typed-order deadline",
  }),
  collectionDeadline: Object.freeze({
    code: "analytics_capture_collection_deadline_exhausted",
    message: "analytics capture collection exceeded the typed-order deadline",
  }),
});

export function analyticsCaptureError(kind) {
  const definition = ANALYTICS_CAPTURE_ERROR_DEFINITIONS[kind]
    || ANALYTICS_CAPTURE_ERROR_DEFINITIONS.unreadable;
  return { ...definition };
}

// Only project errors from the fixed private vocabulary. Browser/Playwright
// detail can contain live URLs, query strings, and page-controlled text, so it
// must never cross into a verdict or parity bundle.
export function projectAnalyticsCaptureError(value, { fallbackKind = null } = {}) {
  const definition = Object.values(ANALYTICS_CAPTURE_ERROR_DEFINITIONS)
    .find((candidate) => candidate.code === value?.code);
  if (definition) return { ...definition };
  return fallbackKind ? analyticsCaptureError(fallbackKind) : null;
}
