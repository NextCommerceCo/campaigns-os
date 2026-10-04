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

const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const QUERY_IN_TEXT = /\?[^\s=&?#"'<>]+=[^\s"'<>]*/g;

// The same projection for free text that may quote URLs (an error message, a
// console line): every URL inside it becomes origin+path, and any remaining
// "?name=value" run is dropped.
export function redactUrlQueriesInText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(URL_IN_TEXT, (url) => redactUrlQuery(url) ?? "")
    .replace(QUERY_IN_TEXT, "");
}
