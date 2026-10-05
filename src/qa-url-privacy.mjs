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
// "%", and its "<" ends a URL quoted before it, so that URL keeps its own
// text up to the cut and nothing after it.
export const REDACTED_QUERY = "<query-redacted>";
// A longer string is cut to this many characters, ending with TRUNCATED,
// before it is projected, so the projection's cost has a fixed bound.
const MAX_TEXT_LENGTH = 16 * 1024;
export const TRUNCATED = "[truncated]";
// Percent-decoding stops after this many rounds; a string still decoding
// then has no query start that can be located, and is replaced whole.
const MAX_DECODE_ROUNDS = 8;
const HEX_DIGIT = /^[0-9a-f]$/i;
const SCHEME_CHAR = /^[a-z0-9+.-]$/i;
const SCHEME_START = /^[a-z]$/i;
const URL_END = /^[\s"'<>]$/;
const SCHEME_RELATIVE_AFTER = /^[\s"'`(=<>]$/;
const AUTHORITY_END = /[/?#]/;

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

// `url` without its userinfo: from `authorityStart` (just after its "//") up
// to and including the last "@" before the next "/", "?" or "#".
function withoutUserinfo(url, authorityStart) {
  const length = url.slice(authorityStart).search(AUTHORITY_END);
  const at = url.lastIndexOf("@", (length < 0 ? url.length : authorityStart + length) - 1);
  return at < authorityStart ? url : `${url.slice(0, authorityStart)}${url.slice(at + 1)}`;
}

// Every scheme-relative URL quoted in `text` ("//" at its start or after a
// space, quote, "(" or "=", up to the next space, quote or angle bracket)
// stripped of its userinfo; the rest of its text, fragment included, is kept
// as written. A "//" inside a path is not one.
function withSchemeRelativeUserinfoStripped(text) {
  let projected = "";
  let from = 0;
  let slashes = text.indexOf("//");
  while (slashes >= 0) {
    let end = slashes + 2;
    if (slashes === 0 || SCHEME_RELATIVE_AFTER.test(text[slashes - 1])) {
      while (end < text.length && !URL_END.test(text[end])) end += 1;
      projected += text.slice(from, slashes) + withoutUserinfo(text.slice(slashes, end), 2);
      from = end;
    }
    slashes = text.indexOf("//", end);
  }
  return projected + text.slice(from);
}

// Every absolute URL quoted in `text` ("<scheme>://" up to the next space,
// quote or angle bracket) cut at its first "?" or "#" and stripped of its
// userinfo, and every scheme-relative URL between them stripped of its
// userinfo, in one pass over the text. What it keeps is otherwise its own
// text: the host's case, its port and its scheme are left as written.
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
      projected += withSchemeRelativeUserinfoStripped(text.slice(from, start)) + withoutUserinfo(text.slice(start, end).split(/[?#]/)[0], separator - start + 3);
      from = end;
    }
    separator = text.indexOf("://", end);
  }
  return projected + withSchemeRelativeUserinfoStripped(text.slice(from));
}

// One projection: the string capped at MAX_TEXT_LENGTH, cut at its first
// query (or replaced whole when that cannot be located), and every absolute
// URL left before the cut also cut at its fragment.
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

// A value inside itself, and a value nested deeper than MAX_DEPTH, are
// persisted as these markers instead of being projected.
export const CIRCULAR = "[circular]";
export const TOO_DEEP = "[too-deep]";
const MAX_DEPTH = 256;

// The one projection of a persisted value: every string, and every object
// key, at any depth goes through redactUrlQueriesInText. A key that a
// projection makes equal to one already written keeps its value under the
// first free "<key> [n]" (n from 2), in the object's own key order. A value
// with toJSON is projected as it would serialize: its toJSON is called once,
// and what it returns is projected without calling toJSON on it again.
export function redactPersisted(value) {
  return projectPersisted(value, new Set(), 0);
}

// `ancestors` holds every object being projected above this one (each value
// with toJSON and what its toJSON returned), so a value that holds itself is
// the CIRCULAR marker rather than an endless recursion.
function projectPersisted(input, ancestors, depth) {
  if (typeof input === "string") return redactUrlQueriesInText(input);
  if (!input || typeof input !== "object") return input;
  if (ancestors.has(input)) return CIRCULAR;
  if (depth >= MAX_DEPTH) return TOO_DEEP;
  const value = typeof input.toJSON === "function" ? input.toJSON() : input;
  if (typeof value === "string") return redactUrlQueriesInText(value);
  if (!value || typeof value !== "object") return value;
  if (ancestors.has(value)) return CIRCULAR;
  const added = value === input ? [input] : [input, value];
  for (const item of added) ancestors.add(item);
  try {
    if (Array.isArray(value)) return value.map((item) => projectPersisted(item, ancestors, depth + 1));
    const entries = new Map();
    for (const [key, item] of Object.entries(value)) {
      const projected = redactUrlQueriesInText(key);
      let name = projected;
      for (let n = 2; entries.has(name); n += 1) name = `${projected} [${n}]`;
      entries.set(name, projectPersisted(item, ancestors, depth + 1));
    }
    return Object.fromEntries(entries);
  } finally {
    for (const item of added) ancestors.delete(item);
  }
}
