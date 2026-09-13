// Text flattening for values this toolkit prints but did not author.
//
// A leaf module on purpose: both functions are pure string work with no
// imports, and both are now published as the `./text-safety` package export so
// a consumer that renders toolkit-derived values (a run id, a path, a quoted
// loader message) into its own single-line notice can flatten them the same
// way instead of reimplementing the escape set and drifting from it.

// One line, no control characters. The operator notices these values land in
// are single-line by construction, and a run id or a path carrying a newline, a
// carriage return, or an ANSI escape could split a notice, overwrite it, or
// dress a fabricated line up as toolkit output. Neither value is
// toolkit-authored: the path comes from a packet-derived target directory and
// the id can be handed in with --run-id. Replaced, never dropped, so a mangled
// value stays visible as mangled rather than silently shortening the message.
export function singleLineField(value, fallback = "") {
  const raw = typeof value === "string" ? value : value == null ? "" : String(value);
  if (!raw) return fallback;
  // C0, DEL and C1, which covers CR, LF, TAB and the ESC that starts ANSI.
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "\uFFFD");
}

export const ADVISORY_DETAIL_MAX = 300;

// One trimmed line, no control characters, no Markdown that could restyle the
// rest of the description or a rendered bullet.
//
// The control-character half is `singleLineField`'s job and is not duplicated
// here. Two things are added on top of it, because this input is different in
// kind from a run id or a disposition: a loader message QUOTES FILE CONTENT,
// so it can be long and can carry Markdown. Line breaks are turned into spaces
// before the hand-off — a newline inside a quoted JSON fragment is a word
// boundary, and rendering it as U+FFFD would read as mojibake — while ESC, DEL
// and the rest still become the replacement character the rest of the CLI
// uses, since those have no reading as text.
export function singleLineDetail(detail, max = ADVISORY_DETAIL_MAX) {
  const spaced = String(detail ?? "").replace(/[\r\n\t\v\f]+/g, " ");
  const flattened = singleLineField(spaced)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[`*_[\]<>]/g, "\\$&");
  if (!flattened) return "(no detail reported)";
  // A published export: a derived or mistaken max below one would otherwise
  // slice to nothing and fabricate a lone ellipsis, so the budget floors at one.
  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : ADVISORY_DETAIL_MAX;
  return flattened.length > limit ? `${flattened.slice(0, limit - 1).trimEnd()}\u2026` : flattened;
}
