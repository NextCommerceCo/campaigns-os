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

// Every persisted string keeps nothing from its first query on: from the
// first "?" it holds, written literally or reached by percent-decoding it
// (any case, any depth: "%3F", "%3f", "%253F", "%%33F"), to the end of the
// string, whatever follows, is replaced by this marker. It holds no "?" or
// "%", and its "<" ends a URL quoted before it, so that URL reads as its
// origin+path alone.
export const REDACTED_QUERY = "<query-redacted>";
// A longer string is cut to this many characters, ending with TRUNCATED,
// before it is projected, so the projection's cost has a fixed bound.
const MAX_TEXT_LENGTH = 16 * 1024;
const TRUNCATED = "[truncated]";
// Percent-decoding stops after this many rounds; a string still decoding
// then has no query start that can be located, and is replaced whole.
const MAX_DECODE_ROUNDS = 8;
const HEX_DIGIT = /^[0-9a-f]$/i;
const SCHEME_CHAR = /^[a-z0-9+.-]$/i;
const SCHEME_START = /^[a-z]$/i;
const URL_END = /^[\s"'<>]$/;

// The index in `text` where its first "?" begins, literally or once
// percent-decoded repeatedly; -1 when it has none; null when the text is
// still decoding after MAX_DECODE_ROUNDS rounds. Each decoded character keeps
// the index of the first original character it came from.
function queryStart(text) {
  let chars = text.split("");
  let starts = chars.map((_, index) => index);
  for (let round = 0; ; round += 1) {
    const nextChars = [];
    const nextStarts = [];
    for (let index = 0; index < chars.length; index += 1) {
      if (chars[index] === "%" && index + 2 < chars.length && HEX_DIGIT.test(chars[index + 1]) && HEX_DIGIT.test(chars[index + 2])) {
        nextChars.push(String.fromCharCode(Number.parseInt(`${chars[index + 1]}${chars[index + 2]}`, 16)));
        nextStarts.push(starts[index]);
        index += 2;
      } else {
        nextChars.push(chars[index]);
        nextStarts.push(starts[index]);
      }
    }
    if (nextChars.length === chars.length) break;
    if (round === MAX_DECODE_ROUNDS) return null;
    chars = nextChars;
    starts = nextStarts;
  }
  const found = chars.indexOf("?");
  return found < 0 ? -1 : starts[found];
}

// Every absolute URL quoted in `text` ("<scheme>://" up to the next space,
// quote or angle bracket) as its origin+path, in one pass over the text.
function withUrlsProjected(text) {
  let projected = "";
  let from = 0;
  let separator = text.indexOf("://");
  while (separator >= 0) {
    let start = separator;
    while (start > from && SCHEME_CHAR.test(text[start - 1])) start -= 1;
    while (start < separator && !SCHEME_START.test(text[start])) start += 1;
    let end = separator + 3;
    if (start < separator) while (end < text.length && !URL_END.test(text[end])) end += 1;
    if (end > separator + 3) {
      projected += text.slice(from, start) + (redactUrlQuery(text.slice(start, end)) ?? "");
      from = end;
    }
    separator = text.indexOf("://", end);
  }
  return projected + text.slice(from);
}

// One projection: the string capped at MAX_TEXT_LENGTH, cut at its first
// query (or replaced whole when that cannot be located), and every absolute
// URL left before the cut as its origin+path.
function projectText(value) {
  const text = value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH - TRUNCATED.length)}${TRUNCATED}` : value;
  const start = queryStart(text);
  if (start === null) return REDACTED_QUERY;
  if (start < 0) return withUrlsProjected(text);
  return `${withUrlsProjected(text.slice(0, start))}${REDACTED_QUERY}`;
}

// The projection of free text that may quote URLs (an error message, a
// console line, a tag name, an object key). Its own output projects to
// itself: a string whose projection would change again is replaced whole by
// the marker.
export function redactUrlQueriesInText(value) {
  if (typeof value !== "string") return value;
  const projected = projectText(value);
  return projectText(projected) === projected ? projected : REDACTED_QUERY;
}

// The one projection of a persisted value: every string, and every object
// key, at any depth goes through redactUrlQueriesInText. A key that a
// projection makes equal to one already written keeps its value under the
// first free "<key> [n]" (n from 2), in the object's own key order. A value
// with toJSON is projected as it would serialize.
export function redactPersisted(value) {
  if (typeof value === "string") return redactUrlQueriesInText(value);
  if (Array.isArray(value)) return value.map(redactPersisted);
  if (!value || typeof value !== "object") return value;
  if (typeof value.toJSON === "function") return redactPersisted(value.toJSON());
  const entries = new Map();
  for (const [key, item] of Object.entries(value)) {
    const projected = redactUrlQueriesInText(key);
    let name = projected;
    for (let n = 2; entries.has(name); n += 1) name = `${projected} [${n}]`;
    entries.set(name, redactPersisted(item));
  }
  return Object.fromEntries(entries);
}
