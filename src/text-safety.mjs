// Text flattening for values this toolkit prints but did not author.
//
// A leaf module on purpose: every function here is pure string work with no
// imports, and all of them are published as the `./text-safety` package export so
// a consumer that renders toolkit-derived values (a run id, a path, a quoted
// loader message) into its own single-line notice can flatten them the same
// way instead of reimplementing the escape set and drifting from it.

// One line, no control characters. These values land in operator notices
// that are single-line by construction, so a run id or a path carrying a
// newline, a carriage return, or an ANSI escape could split a notice,
// overwrite it, or dress a fabricated line up as toolkit output. Neither value
// is toolkit-authored: the path comes from a packet-derived target directory
// and the id can be handed in with --run-id. Replaced, never dropped, so a
// mangled value stays visible as mangled rather than silently shortening the
// message.
export function singleLineField(value, fallback = "") {
  const raw = typeof value === "string" ? value : value == null ? "" : String(value);
  if (!raw) return fallback;
  // C0, DEL and C1, which covers CR, LF, TAB and the ESC that starts ANSI.
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "\uFFFD");
}

// One trimmed line for a value folded INTO a sentence rather than printed as
// its own field: a gate's repair command quoted in a notice, a loader message
// quoted in an advisory. The control-character half is `singleLineField`'s and
// is not duplicated; what is added is the reading a sentence gives whitespace.
// Line breaks and tabs become spaces — a newline inside a quoted instruction
// or JSON fragment is a word boundary, and U+FFFD there reads as mojibake —
// and runs of whitespace collapse, because the value is read as words, not
// compared as an identifier. ESC, DEL and the rest still become the
// replacement character, since those have no reading as text. A value that is
// compared against a known word (a disposition) keeps `singleLineField`.
export function singleLineFragment(value, fallback = "") {
  const spaced = String(value ?? "").replace(/[\r\n\t\v\f]+/g, " ");
  const flattened = singleLineField(spaced).replace(/\s+/g, " ").trim();
  return flattened || fallback;
}

export const ADVISORY_DETAIL_MAX = 300;

// One trimmed line, no control characters, no Markdown that could restyle the
// rest of the description or a rendered bullet.
//
// The folding is `singleLineFragment`'s. Two things are added on top of it,
// because this input is different in kind from a repair command: a loader
// message QUOTES FILE CONTENT, so it can be long and can carry Markdown.
export function singleLineDetail(detail, max = ADVISORY_DETAIL_MAX) {
  const flattened = singleLineFragment(detail).replace(/[`*_[\]<>]/g, "\\$&");
  if (!flattened) return "(no detail reported)";
  // A published export: the result never exceeds `max` characters, and it
  // never fabricates. A non-finite max means the default budget; a derived or
  // mistaken max below one floors at one character, since a budget of zero
  // would print nothing at all in place of a real message. The ellipsis
  // itself costs a character, so a budget of one cannot hold it: at that
  // width the cut is bare rather than an ellipsis standing in for the whole
  // detail.
  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : ADVISORY_DETAIL_MAX;
  if (flattened.length <= limit) return flattened;
  if (limit < 2) return flattened.slice(0, limit);
  return `${flattened.slice(0, limit - 1).trimEnd()}\u2026`;
}
