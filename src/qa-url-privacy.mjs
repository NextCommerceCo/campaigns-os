// Canonical URL projection for QA evidence and private capture attribution.
// Query strings and fragments may contain ref/order identifiers, so every
// caller gets the same conservative projection, including malformed inputs.
export function redactUrlQuery(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  try {
    const url = new URL(text);
    return `${url.origin}${url.pathname}`;
  } catch {
    return text.split(/[?#]/)[0] || null;
  }
}
