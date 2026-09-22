/**
 * Read-only projection of one run's emitted Campaigns OS artifacts.
 *
 * `campaigns-os readback <target>` is a deterministic, side-effect-free
 * projection over files a Campaigns OS run has already emitted (the Build
 * Packet, the doctor output sidecar, the build context, the assembly report, a
 * QA verdict, and a findings export when present). It reads each named file at
 * most once, plus two fixed Git metadata files for the staleness comparison
 * (the nearest `.git` entry at the target or one of its ancestors — funnels are
 * usually subdirectories of their enclosing campaign repository — to locate the
 * Git directory, and that directory's `logs/HEAD` reflog). It writes nothing,
 * starts no process, and touches no network. That contract is why the CLI
 * exempts `readback` from lifecycle-journal capture the way it exempts doctor
 * inspection: a command declared read-only must not append a journal entry.
 *
 * Campaigns OS remains the lifecycle and verdict authority. The readback never
 * reinterprets a verdict and never proposes or performs remediation; where it
 * adds anything beyond the artifacts' own words — the contract-static warning
 * labels, the fail-to-skip cascade provenance, the staleness assessment — the
 * rendered output marks that content as the readback's own projection layer.
 *
 * The default output is the rendered human view. `--json` emits the same
 * projection as one `campaigns-os-readback/v2` object on stdout so a caller can
 * gate on it; the JSON serializes what the text view already computes and adds
 * no new interpretation. `docs/readback.md` is that contract's prose twin,
 * including the exact rule behind its `clean` flag, and
 * `schemas/campaigns-os-readback.v2.schema.json` is its shape.
 *
 * This module is a port of the Python readback this command replaces. The port
 * keeps that module's decomposition section by section so the two can be
 * diffed, and fixes one defect in it: staleness is now assessed per artifact.
 * The Python version compared only the newest loaded artifact against HEAD, so
 * a single freshly regenerated artifact hid every stale sibling behind
 * `stale: false`. Here every loaded artifact with a parseable `generated_at`
 * gets its own verdict, `stale_keys` names the stale ones in render order, and
 * the aggregate `stale` is true when ANY of them is stale. That is a change of
 * meaning in a published field, so the payload is `v2`, not `v1`.
 *
 * Same-user artifact files are inside the repository's trust boundary, so this
 * module deliberately has no symlink or tamper ceremony: a caller who wants to
 * feed it other bytes can already read those bytes directly.
 */

import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
export const MAX_GIT_METADATA_BYTES = 64 * 1024;

/** A bounded read refused because the file is larger than its limit. */
export class ReadLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReadLimitError";
  }
}

/** A file's bytes are not valid UTF-8. */
export class UnicodeDecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnicodeDecodeError";
  }
}

/** A bounded reflog read could not recover a complete final entry. */
export class ReflogTailError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReflogTailError";
  }
}

/** Raised when the caller's paths cannot form a projection at all. */
export class ReadbackUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReadbackUsageError";
  }
}

// `ignoreBOM: true` means "do not strip a leading U+FEFF", which is what the
// Python reader's `payload.decode("utf-8")` does: the BOM survives decoding as
// a character, and `json.loads` then refuses the value outright ("Unexpected
// UTF-8 BOM"). The default TextDecoder swallows that BOM instead, which made a
// BOM-prefixed packet parse here and fail there — and a packet that parses is a
// discovery candidate, so the byte order mark silently changed which artifact
// the readback projected. Keeping the BOM keeps a BOM-prefixed file unreadable
// in both implementations, which is what discovery records as rejected.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeUtf8(bytes) {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new UnicodeDecodeError("'utf-8' codec cannot decode the file's bytes: invalid UTF-8");
  }
}

function readExactly(fd, length, position) {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const read = readSync(fd, buffer, filled, length - filled, position + filled);
    if (read === 0) break;
    filled += read;
  }
  return buffer.subarray(0, filled);
}

/**
 * Read a whole file as UTF-8 text, refusing anything past `maxBytes`.
 *
 * The limit is a read bound, not a truncation: a file one byte over it is
 * refused rather than silently shortened, because a half-read artifact would
 * project as malformed JSON and read as the run's fault rather than ours.
 */
export function readBoundedText(path, maxBytes) {
  const fd = openSync(path, "r");
  let payload;
  try {
    const size = fstatSync(fd).size;
    payload = readExactly(fd, Math.min(size, maxBytes + 1), 0);
  } finally {
    closeSync(fd);
  }
  if (payload.length > maxBytes) throw new ReadLimitError(`file exceeds the ${maxBytes}-byte read limit`);
  return decodeUtf8(payload);
}

const BLANK_BYTES = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

function isBlank(bytes) {
  for (const byte of bytes) if (!BLANK_BYTES.has(byte)) return false;
  return true;
}

function splitLines(bytes) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) {
      lines.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < bytes.length) lines.push(bytes.subarray(start));
  return lines;
}

/**
 * The last complete entry of a reflog, reading only the file's final tail.
 *
 * A long-lived checkout's reflog is unbounded, and only its last line is the
 * signal, so the read is bounded from the end. The leading fragment of a
 * bounded tail may start mid-entry or mid-codepoint, so it is discarded up to
 * the first newline; only the final line is decoded, which keeps a corrupt
 * older entry from failing a read whose answer does not depend on it.
 */
export function readReflogTail(path) {
  const fd = openSync(path, "r");
  let payload;
  let start;
  try {
    const size = fstatSync(fd).size;
    start = Math.max(0, size - MAX_GIT_METADATA_BYTES);
    payload = readExactly(fd, Math.min(size - start, MAX_GIT_METADATA_BYTES), start);
  } finally {
    closeSync(fd);
  }
  if (start) {
    const newline = payload.indexOf(0x0a);
    if (newline === -1) throw new ReflogTailError("no newline found within the bounded tail");
    payload = payload.subarray(newline + 1);
    if (isBlank(payload)) throw new ReflogTailError("no complete entry remains after the leading fragment");
  }
  const entries = splitLines(payload).filter((line) => !isBlank(line));
  return entries.length ? decodeUtf8(entries[entries.length - 1]) : "";
}

// Artifact keys, in render order, with the default location of each artifact
// relative to the target repository root. The packet lives at the root; the
// sidecars live under .campaign-runtime/.
export const DEFAULT_RELATIVE_PATHS = {
  packet: "campaign-runtime.build.json",
  doctor: ".campaign-runtime/doctor-output.json",
  context: ".campaign-runtime/build-context.json",
  report: ".campaign-runtime/assembly-report.json",
  qa_verdict: ".campaign-runtime/qa-verdict.json",
  findings: ".campaign-runtime/findings-export.json",
};

export const ARTIFACT_TITLES = {
  packet: "build packet",
  doctor: "doctor output",
  context: "build context",
  report: "assembly report",
  qa_verdict: "QA verdict",
  findings: "findings export",
};

export const RECOGNIZED_SCHEMA_VERSIONS = {
  packet: ["campaign-runtime-build-packet/v0"],
  context: ["campaign-runtime-build-context/v0"],
  report: ["campaign-runtime-assembly-report/v0"],
  // Campaigns OS has emitted both spellings for the QA verdict.
  qa_verdict: ["1.0", "campaigns-os-qa-verdict/v0"],
};

// Root-level Build Packets other than the default-named one. A second run in
// the same repository leaves its record under a suffixed name; both shapes are
// discovery candidates when no `--packet` was given.
const PACKET_CANDIDATE_PATTERN = /^campaign-runtime-.*\.build\.json$/;

// Sidecar path some write-ends have used instead of the contracted root home.
// Discovery never selects this file: Campaigns OS writes the packet at the
// repository root, and auto-selecting the sidecar would paper over that
// mismatch. When no root candidate exists and this file is present, discovery
// records it as rejected so the operator can pass --packet instead of staring
// at an empty folder.
const SIDECAR_PACKET_RELATIVE = ".campaign-runtime/campaign-runtime.build.json";

// The readback's own interpretation layer, applied to doctor warning codes.
// Doctor warnings under the frontmatter.* codes restate the template family's
// shared frontmatter vocabulary (the contract), not an observation of this
// repository: they repeat verbatim on every doctor pass while the contract is
// in force, so their persistence does not mean a flagged value is still
// unfixed, and their disappearance is not how a fix is confirmed. Every other
// code is labeled repo-observed: not in the contract-static table, so its
// message reflects this repository, spec, or build as doctor saw it.
const CONTRACT_STATIC_CODE_PREFIXES = ["frontmatter."];

// Stage blockers render in full up to this cap, then collapse to a count, so a
// pathological report cannot flood the view. Known-schema object blockers
// (code/message/stage/page_id/detail) render their human-readable text in full
// — the stage cap is the volume bound — while unknown shapes fall back to a
// bounded JSON rendering.
const BLOCKER_RENDER_CAP = 10;
const NON_STRING_BLOCKER_RENDER_CAP = 120;

// The human-readable and identifier fields of the assembly report's object
// blocker schema, in render order. detail substitutes when message is absent.
// This tuple mirrors the upstream assembly-report schema and has to move with
// it: a renamed or removed field is skipped silently rather than reported, and
// a newly added identifier is not rendered until it is listed here.
const BLOCKER_IDENTIFIER_FIELDS = ["stage", "page_id"];

const CONTRACT_STATIC_LABEL_NOTE =
  "contract-static: restates the template-family contract; repeats verbatim " +
  "on every doctor pass, so its presence does not track this repository's " +
  "current state";
const REPO_OBSERVED_LABEL_NOTE =
  "repo-observed: reflects this repository, spec, or build as doctor saw it";

// The machine-readable projection's schema identifier. Contract and field
// semantics live in docs/readback.md and
// schemas/campaigns-os-readback.v2.schema.json; those documents and this
// constant move together.
export const JSON_SCHEMA_VERSION = "campaigns-os-readback/v2";

// Artifact states that do not, on their own, make a projection unclean: a
// loaded artifact was read and recognized, and an absent one is a file the run
// simply did not emit here. `unreadable` and `unrecognized` mean the readback
// cannot see what the artifact says, which is never clean.
const CLEAN_ARTIFACT_STATES = new Set(["loaded", "absent"]);

// Python's datetime range (year 1 through year 9999), kept so an absurd reflog
// epoch is refused with a reason instead of formatting as a nonsense instant.
const MIN_EPOCH_SECONDS = -62135596800;
const MAX_EPOCH_SECONDS = 253402300799;

// ---------------------------------------------------------------------------
// ISO-8601 acceptance, ported from CPython
//
// The Python readback parses `generated_at` with `datetime.fromisoformat`
// (runner/artifact_readback.py:192-209, `_parse_iso_timestamp`), so acceptance
// here has to match that function in BOTH directions, not merely cover the
// shapes Campaigns OS emits. A value Python parses and this does not drops the
// artifact out of the staleness map, which reports a stale sibling as clean; a
// value Python refuses and this accepts turns a required unknown-candidate
// refusal into a silent packet selection. A regex tuned to the emitted shape
// got both wrong — it capped the fraction at nine digits and never bounded the
// UTC offset — so the grammar below is a transcription of CPython's helpers
// (Lib/datetime.py, 3.11) rather than an approximation of them: one function
// per Python helper, named for it, in the same order.
//
// Where the pure-Python reference and the C accelerator disagree, this follows
// the C, because the accelerator is the implementation that actually runs when
// the Python readback calls `fromisoformat`. The disagreements this grammar
// carries, each checked against CPython 3.11's accelerator rather than inferred
// from the pure-Python source:
//
//   - `int()` accepts surrounding whitespace, a sign, non-ASCII digits, and a
//     one-digit slice where the C `parse_digits` demands an exact count; this
//     takes strict ASCII digits at exact widths.
//   - a fraction may follow `HH` or `HH:MM`, not only `HH:MM:SS`: the C parser
//     starts the fraction wherever the time components stop, so `T10.5` and
//     `T10:00.5` are instants. Pure Python calls both an invalid separator.
//   - the date/time separator is one Unicode character, not one UTF-16 code
//     unit, so an astral separator is consumed whole.
//   - a separator with no time behind it (`2026-09-22T`) is malformed. Pure
//     Python reads it as midnight; the C parser refuses it, and a bare date
//     with no separator at all is still midnight in both.
//   - an offset whose WHOLE-second part is zero is UTC, and its sub-second
//     part is discarded (`+00:00:00.5` is UTC, not half a second east). Pure
//     Python builds a half-second timezone. An offset with a non-zero
//     whole-second part keeps its fraction in both (`+00:00:01.5`).
//
// One C quirk is deliberately NOT ported: the accelerator also reads `:` as a
// fraction separator after the seconds (`T10:00:00:12` is 10:00:00.12), which
// pure Python refuses. No finding covers it, no artifact is written that way,
// and this grammar refuses it as the pure-Python reference does.
// ---------------------------------------------------------------------------

const MIN_ISO_YEAR = 1;
const MAX_ISO_YEAR = 9999;
const MICROS_PER_SECOND = 1_000_000n;
const MILLIS_PER_DAY = 86_400_000;
// The ordinal of 1970-01-01 in Python's proleptic Gregorian calendar, where
// 0001-01-01 is ordinal 1. JavaScript's Date uses the same calendar, so day
// arithmetic can cross between the two through this constant alone.
const UNIX_EPOCH_ORDINAL = 719163;
// `timezone()`'s own bound: strictly between -24h and +24h, which is at most
// 23:59:59.999999 either way (Lib/datetime.py `timezone._maxoffset`). This is
// the check the regex had no equivalent of, and the reason `+25:00` has to be
// unparseable rather than a 25-hour shift.
const MAX_OFFSET_MICROS = 24n * 3600n * MICROS_PER_SECOND - 1n;
// Scale for a fraction shorter than six digits, indexed by digits - 1
// (Lib/datetime.py `_FRACTION_CORRECTION`).
const FRACTION_CORRECTION = [100000, 10000, 1000, 100, 10];
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isAsciiDigit(code) {
  return code >= 48 && code <= 57;
}

/** CPython `parse_digits`: exactly `count` ASCII digits at `pos`, else null. */
function parseDigits(text, pos, count) {
  if (pos + count > text.length) return null;
  let value = 0;
  for (let index = 0; index < count; index += 1) {
    const code = text.charCodeAt(pos + index);
    if (!isAsciiDigit(code)) return null;
    value = value * 10 + (code - 48);
  }
  return value;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
}

/**
 * Milliseconds since the epoch for a UTC calendar date and time of day.
 *
 * `Date.UTC` maps years 0-99 onto 1900-1999, which would put every year Python
 * accepts below 100 in the wrong millennium; the round-trip through
 * `setUTCFullYear` is how the literal year is kept.
 */
function utcMillis(year, month, day, hour = 0, minute = 0, second = 0) {
  const stamp = Date.UTC(year, month - 1, day, hour, minute, second);
  if (year > 99) return stamp;
  const corrected = new Date(stamp);
  corrected.setUTCFullYear(year);
  return corrected.getTime();
}

/** CPython `_ymd2ord`: days since 0001-01-01, counting that day as 1. */
function ymdToOrdinal(year, month, day) {
  return utcMillis(year, month, day) / MILLIS_PER_DAY + UNIX_EPOCH_ORDINAL;
}

/** CPython `_ord2ymd`: the inverse of ymdToOrdinal. */
function ordinalToYmd(ordinal) {
  const moment = new Date((ordinal - UNIX_EPOCH_ORDINAL) * MILLIS_PER_DAY);
  return { year: moment.getUTCFullYear(), month: moment.getUTCMonth() + 1, day: moment.getUTCDate() };
}

/** CPython `_isoweek1monday`: the ordinal of the Monday starting ISO week 1. */
function isoWeek1Monday(year) {
  const firstDay = ymdToOrdinal(year, 1, 1);
  const firstWeekday = (firstDay + 6) % 7;
  return firstWeekday > 3 ? firstDay - firstWeekday + 7 : firstDay - firstWeekday;
}

/** CPython `_isoweek_to_gregorian`: a week date as a calendar date, else null. */
function isoWeekToGregorian(year, week, day) {
  // Bounded this way because 9999-12-31 is (9999, 52, 5).
  if (year < MIN_ISO_YEAR || year > MAX_ISO_YEAR) return null;
  if (week < 1 || week > 53) return null;
  if (week === 53) {
    // ISO years have 53 weeks when they start on a Thursday, and when a leap
    // year starts on a Wednesday. Ordinal 1 (0001-01-01) is a Monday, so the
    // ordinal modulo 7 is 1 for Monday, 3 for Wednesday, 4 for Thursday.
    const firstWeekday = ymdToOrdinal(year, 1, 1) % 7;
    if (!(firstWeekday === 4 || (firstWeekday === 3 && isLeapYear(year)))) return null;
  }
  if (day < 1 || day > 7) return null;
  return ordinalToYmd(isoWeek1Monday(year) + (week - 1) * 7 + (day - 1));
}

/**
 * CPython `_find_isoformat_datetime_separator`: the index of the character
 * between the date and the time; null where CPython raises.
 *
 * The character AT that index is never examined — `T`, a space, and any other
 * single character all separate a date from a time, which is why this returns
 * a position rather than matching a separator.
 */
function findIsoformatDatetimeSeparator(text) {
  const length = text.length;
  if (length === 7) return 7;
  if (text[4] === "-") {
    if (text[5] === "W") {
      if (length > 8 && text[8] === "-") {
        if (length === 9) return null;
        // YYYY-Www-## is ambiguous; CPython resolves it toward the hyphen at 8
        // and calls that best effort, so the port inherits the same guess.
        if (length > 10 && isAsciiDigit(text.charCodeAt(10))) return 8;
        return 10;
      }
      return 8; // YYYY-Www
    }
    return 10; // YYYY-MM-DD
  }
  if (text[4] === "W") {
    // YYYYWww (7) or YYYYWwwd (8): the run of digits decides which.
    let index = 7;
    while (index < length && isAsciiDigit(text.charCodeAt(index))) index += 1;
    if (index < 9) return index;
    return index % 2 === 0 ? 7 : 8;
  }
  return 8; // YYYYMMDD
}

/** CPython `_parse_isoformat_date`: `{ year, month, day }`, else null. */
function parseIsoformatDate(text) {
  // CPython asserts this; the C accelerator reports a parse failure instead,
  // which is what null is here.
  if (text.length !== 7 && text.length !== 8 && text.length !== 10) return null;
  const year = parseDigits(text, 0, 4);
  if (year === null) return null;
  const hasSeparator = text[4] === "-";
  let pos = 4 + (hasSeparator ? 1 : 0);
  if (text[pos] === "W") {
    pos += 1;
    const week = parseDigits(text, pos, 2);
    if (week === null) return null;
    pos += 2;
    let day = 1;
    if (text.length > pos) {
      if ((text[pos] === "-") !== hasSeparator) return null; // inconsistent dash
      pos += hasSeparator ? 1 : 0;
      day = parseDigits(text, pos, 1);
      if (day === null) return null;
    }
    return isoWeekToGregorian(year, week, day);
  }
  const month = parseDigits(text, pos, 2);
  if (month === null) return null;
  pos += 2;
  if ((text[pos] === "-") !== hasSeparator) return null; // inconsistent dash
  pos += hasSeparator ? 1 : 0;
  const day = parseDigits(text, pos, 2);
  if (day === null) return null;
  return { year, month, day };
}

/**
 * CPython `_parse_hh_mm_ss_ff`: `HH[:?MM[:?SS]][.,]f+` as
 * `[hour, minute, second, microsecond]`, else null.
 *
 * The fraction is where the regex this replaces was wrong: CPython reads the
 * first six digits, truncates the rest, and only requires that the truncated
 * remainder BE digits — so a fraction of any length parses. Capping it at nine
 * made `.0000010000Z` unparseable, and an unparseable `generated_at` is an
 * artifact that silently leaves the staleness comparison.
 */
function parseHhMmSsFf(text) {
  const length = text.length;
  const comps = [0, 0, 0, 0];
  let pos = 0;
  let hasSeparator = false;
  for (let comp = 0; comp < 3; comp += 1) {
    if (length - pos < 2) return null; // incomplete time component
    const value = parseDigits(text, pos, 2);
    if (value === null) return null;
    comps[comp] = value;
    pos += 2;
    const nextChar = text[pos] ?? "";
    if (comp === 0) hasSeparator = nextChar === ":";
    if (!nextChar || comp >= 2) break;
    // A fraction ends the time components wherever they have got to, so `10.5`
    // and `10:00.5` are half a second past the hour just as `10:00:00.5` is.
    // Reading this position as a component separator instead refused both, and
    // an unparseable generated_at drops its artifact out of the staleness
    // comparison entirely — which is how a stale artifact reads as clean.
    if (nextChar === "." || nextChar === ",") break;
    if (hasSeparator && nextChar !== ":") return null; // invalid time separator
    pos += hasSeparator ? 1 : 0;
  }
  if (pos < length) {
    // ISO-8601 allows either fraction separator and CPython takes both.
    if (text[pos] !== "." && text[pos] !== ",") return null;
    pos += 1;
    const remainder = length - pos;
    if (remainder === 0) return null; // a separator with no fraction behind it
    const parsed = Math.min(remainder, 6);
    const fraction = parseDigits(text, pos, parsed);
    if (fraction === null) return null;
    comps[3] = parsed < 6 ? fraction * FRACTION_CORRECTION[parsed - 1] : fraction;
    // Digits past the sixth are dropped rather than rounded, but they still
    // have to be digits.
    for (let index = pos + parsed; index < length; index += 1) {
      if (!isAsciiDigit(text.charCodeAt(index))) return null;
    }
  }
  return comps;
}

/**
 * CPython `_parse_isoformat_time`: the time of day and its UTC offset in whole
 * microseconds, else null.
 *
 * The offset accepts `Z`, `±HH`, `±HHMM`, `±HH:MM`, `±HHMMSS`, `±HH:MM:SS` and
 * any of the last four with a fraction, and its magnitude must stay strictly
 * under 24 hours — the bound `timezone()` enforces on the far side of the
 * Python call, which is why `+25:00` is a refusal and not an offset.
 */
function parseIsoformatTime(text) {
  const length = text.length;
  if (length < 2) return null;
  // CPython's own scan: the first `-`, else the first `+`, else the first `Z`.
  const tzPos = text.indexOf("-") + 1 || text.indexOf("+") + 1 || text.indexOf("Z") + 1;
  const comps = parseHhMmSsFf(tzPos > 0 ? text.slice(0, tzPos - 1) : text);
  if (comps === null) return null;
  let offsetMicros = 0n;
  if (tzPos === length && text.endsWith("Z")) {
    // The bare `Z` form. `_parse_iso_timestamp` rewrites a trailing `Z` to
    // `+00:00` before this sees it, so this branch carries the grammar rather
    // than any value Campaigns OS emits.
    offsetMicros = 0n;
  } else if (tzPos > 0) {
    const tzText = text.slice(tzPos);
    // Valid offset lengths are 2, 4, 5, 6, 7+, 8 and 10+; 0, 1 and 3 are not.
    if (tzText.length === 0 || tzText.length === 1 || tzText.length === 3) return null;
    const tzComps = parseHhMmSsFf(tzText);
    if (tzComps === null) return null;
    // The C accelerator's UTC special case: it converts the offset to WHOLE
    // seconds and returns UTC when that is zero, so a sub-second-only offset
    // like `+00:00:00.5` is UTC and its fraction is discarded — while an offset
    // whose whole-second part is non-zero keeps its fraction (`+00:00:01.5` is
    // one and a half seconds). Carrying the discarded half-second reordered two
    // packets recorded half a second apart, and packet order decides which run
    // the readback projects.
    const wholeSeconds = BigInt(tzComps[0]) * 3600n + BigInt(tzComps[1]) * 60n + BigInt(tzComps[2]);
    if (wholeSeconds !== 0n) {
      const magnitude = wholeSeconds * MICROS_PER_SECOND + BigInt(tzComps[3]);
      if (magnitude > MAX_OFFSET_MICROS) return null;
      offsetMicros = text[tzPos - 1] === "-" ? -magnitude : magnitude;
    }
  }
  return { hour: comps[0], minute: comps[1], second: comps[2], micros: comps[3], offsetMicros };
}

/**
 * Parse an artifact's ISO-8601 timestamp into an instant; null when unparseable.
 *
 * Ports `_parse_iso_timestamp`, which rewrites a trailing `Z` to `+00:00` and
 * hands the result to `datetime.fromisoformat`; the helpers above are that
 * function's grammar and this is its body.
 *
 * Returns `{ date, micros }`: a millisecond `Date`, which is what every
 * rendering path formats, and the same instant in whole microseconds since the
 * epoch as a BigInt, which is what every comparison and ordering path uses.
 * The two are separate because JavaScript's Date cannot hold sub-millisecond
 * precision at all, and truncating to it silently made two packets a
 * microsecond apart a tie — a refusal to choose, exit 2, over a difference the
 * artifacts had recorded. The Python readback this module ports compares with
 * `datetime.fromisoformat`, which keeps microseconds, so the truncation was a
 * parity defect as well as a defect on its own terms. Precision stops at six
 * fractional digits, and a seventh or later digit is truncated rather than
 * rounded, which is what `fromisoformat` does with the same input.
 *
 * A value without a timezone is assumed UTC. Campaigns OS emits `generated_at`
 * with a Z suffix, so the assumption is documentation for hand-authored
 * artifacts, not a branch the emitted format exercises.
 */
export function parseIsoInstant(value) {
  if (typeof value !== "string" || !value) return null;
  const text = value.endsWith("Z") ? `${value.slice(0, -1)}+00:00` : value;
  if (text.length < 7) return null;
  const separator = findIsoformatDatetimeSeparator(text);
  if (separator === null) return null;
  const date = parseIsoformatDate(text.slice(0, separator));
  if (date === null) return null;
  let time;
  if (separator >= text.length) {
    // A bare date, with no separator character at all: midnight.
    time = { hour: 0, minute: 0, second: 0, micros: 0, offsetMicros: 0n };
  } else {
    // The separator is one Unicode character, which may be a surrogate pair —
    // skipping a single UTF-16 code unit left its trailing half at the head of
    // the time string and made an otherwise valid timestamp unparseable.
    const separatorLength = text.codePointAt(separator) > 0xffff ? 2 : 1;
    const tail = text.slice(separator + separatorLength);
    // A separator with nothing behind it is malformed, not midnight: the run
    // wrote a date and started a time it never finished, and reading that as
    // 00:00:00 invents an instant no artifact recorded — one that beats every
    // real timestamp from the day before. Unparseable is the honest answer, and
    // for packet discovery it is the unknown candidate that forces a refusal.
    if (!tail) return null;
    time = parseIsoformatTime(tail);
  }
  if (time === null) return null;
  // The `datetime` constructor's own range checks, which run after parsing and
  // raise the same ValueError the caller reads as "unparseable".
  if (date.year < MIN_ISO_YEAR || date.year > MAX_ISO_YEAR) return null;
  if (date.month < 1 || date.month > 12) return null;
  if (date.day < 1 || date.day > daysInMonth(date.year, date.month)) return null;
  if (time.hour > 23 || time.minute > 59 || time.second > 59) return null;
  const stamp = utcMillis(date.year, date.month, date.day, time.hour, time.minute, time.second);
  if (!Number.isFinite(stamp)) return null;
  const micros = BigInt(stamp) * 1000n + BigInt(time.micros) - time.offsetMicros;
  // Floor rather than truncate toward zero so the rendered second of a
  // pre-epoch instant is the second it falls in, not the one after it.
  const millis = micros / 1000n - (micros % 1000n < 0n ? 1n : 0n);
  return { date: new Date(Number(millis)), micros };
}

/**
 * Parse an artifact's ISO-8601 timestamp as a Date; null when unparseable.
 *
 * The millisecond half of parseIsoInstant, kept for callers that only render.
 * Anything that compares or orders two timestamps must use parseIsoInstant:
 * this Date cannot distinguish two artifacts less than a millisecond apart.
 */
export function parseIsoTimestamp(value) {
  return parseIsoInstant(value)?.date ?? null;
}

/** Render one instant as the readback's single timestamp format. */
export function formatUtc(value) {
  return `${value.toISOString().slice(0, 19)}Z`;
}

function statOrNull(path) {
  try {
    return statSync(path, { throwIfNoEntry: false }) ?? null;
  } catch {
    // An unreadable ancestor is "no .git here", the same answer a missing one
    // gives; the walk continues upward rather than failing the projection.
    return null;
  }
}

/**
 * Find the nearest `.git` entry at root or one of its ancestors.
 *
 * Funnel targets are usually subdirectories of their enclosing campaign
 * repository, so Git metadata rarely sits at the target itself. Walks upward
 * from the target and stops at the first `.git` entry (directory or worktree
 * pointer file). File-metadata checks only.
 */
export function discoverGitEntry(root) {
  let current = resolve(root);
  for (;;) {
    const gitEntry = join(current, ".git");
    const info = statOrNull(gitEntry);
    if (info && (info.isFile() || info.isDirectory())) {
      return { gitEntry, containingDir: current, isFile: info.isFile() };
    }
    const parent = resolve(current, "..");
    if (parent === current) return { gitEntry: null, containingDir: null, isFile: false };
    current = parent;
  }
}

/**
 * When the enclosing checkout's HEAD last moved, from the reflog.
 *
 * Returns `{ time, detail }`: an instant and an empty detail on success, or a
 * null time and a reason when the signal is unavailable. The reflog's last
 * entry advances on commit, checkout, pull, and reset alike; any of those can
 * invalidate previously emitted artifacts, so "HEAD last moved" is deliberately
 * the coarsest local signal, not "last commit authored". The checkout is the
 * nearest `.git` entry at the target or an ancestor. Reading `.git` and the
 * reflog keeps the module's no-process contract; nothing shells out to git.
 */
export function readHeadMovement(root) {
  const { gitEntry, containingDir, isFile } = discoverGitEntry(root);
  if (gitEntry === null) {
    return { time: null, detail: "the target root is not a Git checkout and no ancestor contains .git" };
  }
  let gitDir = gitEntry;
  if (isFile) {
    let pointerText;
    try {
      pointerText = readBoundedText(gitEntry, MAX_GIT_METADATA_BYTES);
    } catch (error) {
      return { time: null, detail: `could not read the .git pointer file (${error.code ?? error.name})` };
    }
    gitDir = null;
    for (const line of pointerText.split(/\r?\n/)) {
      if (!line.startsWith("gitdir:")) continue;
      const candidate = line.slice("gitdir:".length).trim();
      // A relative gitdir resolves against the .git-bearing ancestor, not the
      // nested target: were the base the target, a sibling worktree pointer
      // would resolve under the funnel directory and the signal would go dark.
      gitDir = isAbsolute(candidate) ? candidate : join(containingDir, candidate);
      break;
    }
    if (gitDir === null) return { time: null, detail: "the .git file carries no gitdir pointer" };
  }

  let raw;
  try {
    raw = readReflogTail(join(gitDir, "logs", "HEAD"));
  } catch (error) {
    if (error?.code === "ENOENT") return { time: null, detail: "the Git checkout has no HEAD reflog" };
    if (error instanceof ReflogTailError) {
      return { time: null, detail: `could not read the HEAD reflog (${error.message})` };
    }
    return { time: null, detail: `could not read the HEAD reflog (${error.code ?? error.name})` };
  }
  const entries = raw.split(/\r?\n/).filter((line) => line.trim());
  if (!entries.length) return { time: null, detail: "the HEAD reflog is empty" };
  const identity = entries[entries.length - 1].split("\t")[0];
  const words = identity.split(" ");
  if (words.length < 3) return { time: null, detail: "the last HEAD reflog entry is not in reflog format" };
  const epochText = words[words.length - 2];
  if (!/^[+-]?\d+$/.test(epochText)) {
    return { time: null, detail: "the last HEAD reflog entry carries no epoch timestamp" };
  }
  const epoch = BigInt(epochText);
  if (epoch < BigInt(MIN_EPOCH_SECONDS) || epoch > BigInt(MAX_EPOCH_SECONDS)) {
    return { time: null, detail: "the last HEAD reflog entry's timestamp is out of range" };
  }
  return { time: new Date(Number(epoch) * 1000), detail: "" };
}

/**
 * Compare EVERY loaded artifact's generated_at against the HEAD reflog.
 *
 * Part of the readback's own projection layer. Deterministic: the result is a
 * pure function of the artifact contents and two Git metadata files; no wall
 * clock is consulted.
 *
 * Per-artifact by design (the v1 defect this port fixes). v1 compared only the
 * newest loaded artifact, so one freshly regenerated artifact reported the
 * whole set fresh while its siblings predated the same HEAD movement. Each
 * artifact now carries its own verdict, and the aggregate `stale` is true when
 * any of them is stale. An artifact with no parseable `generated_at` is neither
 * fresh nor stale: it stays out of the map, and if it is the only artifact the
 * assessment is not computable.
 *
 * `headMovement` overrides the Git read for a caller that already knows the
 * answer — `--example` projects a packaged fixture directory, which is not a
 * checkout and must say so identically wherever the package is installed.
 */
export function assessStaleness(root, views, { headMovement = null } = {}) {
  const artifactTimes = {};
  // Comparison and ordering run on microseconds, never on the rendered Dates:
  // two artifacts under a millisecond apart are two instants, not one.
  const artifactMicros = {};
  for (const [key, view] of Object.entries(views)) {
    if (view.state !== "loaded") continue;
    const parsed = parseIsoInstant((view.data || {}).generated_at);
    if (parsed !== null) {
      artifactTimes[key] = parsed.date;
      artifactMicros[key] = parsed.micros;
    }
  }
  const { time: headTime, detail: headDetail } = headMovement ?? readHeadMovement(root);
  // The reflog records whole seconds, so the head instant is exact in
  // milliseconds and scaling it loses nothing: this comparison is unchanged by
  // the artifact side's added precision.
  const headMicros = headTime === null ? null : BigInt(headTime.getTime()) * 1000n;
  const keys = Object.keys(artifactTimes);
  const artifacts = {};
  const staleKeys = [];
  for (const key of keys) {
    // Absence of the HEAD signal is never evidence of freshness, but it is not
    // evidence of staleness either: with no comparison point nothing is stale.
    const stale = headMicros !== null && headMicros > artifactMicros[key];
    artifacts[key] = { generated_at: artifactTimes[key], stale };
    if (stale) staleKeys.push(key);
  }
  let newestKey = null;
  for (const key of keys) {
    if (newestKey === null || artifactMicros[key] > artifactMicros[newestKey]) newestKey = key;
  }
  const computable = keys.length > 0 && headTime !== null;
  return {
    artifact_times: artifactTimes,
    artifacts,
    stale_keys: staleKeys,
    head_time: headTime,
    head_detail: headDetail,
    computable,
    stale: computable && staleKeys.length > 0,
    newest_key: computable ? newestKey : null,
  };
}

function renderStaleness(staleness, lines) {
  if (!staleness) return;
  lines.push(
    "STALENESS  [the readback's own projection layer: EACH loaded artifact's " +
      "generated_at versus the checkout's HEAD reflog]",
  );
  if (staleness.computable) {
    const loaded = Object.keys(staleness.artifacts);
    const headText = formatUtc(staleness.head_time);
    if (staleness.stale) {
      lines.push("  *** STALE ARTIFACTS ***");
      lines.push(
        `  this checkout's HEAD last moved ${headText}, after ${staleness.stale_keys.length} of ` +
          `${loaded.length} loaded artifact(s):`,
      );
      for (const key of staleness.stale_keys) {
        lines.push(`    ${ARTIFACT_TITLES[key]} (generated ${formatUtc(staleness.artifacts[key].generated_at)})`);
      }
      lines.push("  Every section below describes the repository as it was when the artifacts");
      lines.push("  were generated, not necessarily as it is now; a new run must regenerate");
      lines.push("  them before this view is current.");
    } else {
      lines.push(
        `  every loaded artifact (${loaded.length}) is not older than the last recorded ` +
          `HEAD movement (${headText}).`,
      );
      const newestKey = staleness.newest_key;
      lines.push(
        `  newest: ${ARTIFACT_TITLES[newestKey]}, generated ` +
          `${formatUtc(staleness.artifacts[newestKey].generated_at)}.`,
      );
    }
  } else {
    const reasons = [];
    if (staleness.head_time === null) reasons.push(staleness.head_detail);
    if (!Object.keys(staleness.artifact_times).length) {
      reasons.push("no loaded artifact carries a parseable generated_at");
    }
    lines.push(`  not computable: ${reasons.join("; ")}.`);
    lines.push("  Treat artifact age as unknown; check the artifacts' generated_at values");
    lines.push("  against repository history before reading this view as current.");
  }
  lines.push("");
}

/** Label one doctor warning code; part of the readback's own layer. */
export function classifyDoctorWarning(code) {
  if (typeof code === "string" && CONTRACT_STATIC_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) {
    return "contract-static";
  }
  return "repo-observed";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// A field an artifact did not record renders as a named absence rather than as
// the language's word for nothing: "status: undefined" reads like a defect in
// the readback, and the Python original's "status: None" read no better.
function recorded(value, fallback = "(not recorded)") {
  return value === undefined || value === null ? fallback : value;
}

/** Load one artifact into a view object; never throws for file problems. */
export function loadArtifact(key, path, { maxBytes = MAX_ARTIFACT_BYTES } = {}) {
  const view = { key, path: String(path), state: "loaded", detail: "", data: null };
  let raw;
  try {
    raw = readBoundedText(view.path, maxBytes);
  } catch (error) {
    if (error?.code === "ENOENT") {
      view.state = "absent";
      return view;
    }
    view.state = "unreadable";
    view.detail = `${error.name}: ${error.message}`;
    return view;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    view.state = "unreadable";
    view.detail = `invalid JSON: ${error.message}`;
    return view;
  }
  if (!isPlainObject(data)) {
    view.state = "unrecognized";
    view.detail = "top-level JSON value is not an object";
    return view;
  }

  const recognized = RECOGNIZED_SCHEMA_VERSIONS[key];
  if (recognized !== undefined) {
    const declared = data.schema_version;
    if (!recognized.includes(declared)) {
      view.state = "unrecognized";
      view.detail =
        `unrecognized schema_version ${JSON.stringify(declared ?? null)}; ` +
        `this readback projects ${recognized.join(" or ")}`;
      return view;
    }
  }
  if (key === "doctor" && !(typeof data.status === "string" && Array.isArray(data.warnings))) {
    view.state = "unrecognized";
    view.detail = "doctor output must carry a status string and a warnings list";
    return view;
  }
  if (key === "qa_verdict" && !(typeof data.disposition === "string" && Array.isArray(data.assertions))) {
    view.state = "unrecognized";
    view.detail = "QA verdict must carry a disposition and an assertions list";
    return view;
  }

  view.data = data;
  return view;
}

/**
 * Load every artifact path in the fixed render order.
 *
 * `preloaded` supplies views already loaded from those same paths — Build
 * Packet discovery reads its candidates, so the chosen one would otherwise be
 * read twice. A preloaded view is used only when it names the path this call
 * would have read; anything else is loaded here.
 */
export function loadArtifacts(paths, preloaded = {}) {
  const views = {};
  for (const key of Object.keys(DEFAULT_RELATIVE_PATHS)) {
    if (!(key in paths)) continue;
    const path = String(paths[key]);
    const candidate = preloaded?.[key] ?? null;
    views[key] = candidate !== null && candidate.path === path ? candidate : loadArtifact(key, path);
  }
  return views;
}

function artifactData(views, key) {
  const view = views[key];
  if (view === undefined || view.state !== "loaded") return null;
  return view.data;
}

/**
 * Bucket the QA verdict's assertions by recorded status.
 *
 * `other` collects any status this readback does not project (it renders those
 * rows as written rather than reclassifying them). Non-object entries are
 * dropped: an assertion the readback cannot address by status is not an
 * assertion it can project. Returns empty buckets when no QA verdict loaded, so
 * every caller can treat "no verdict" as "no failures" without a separate
 * branch.
 */
export function partitionAssertions(views) {
  const buckets = { fail: [], pass: [], skipped: [], other: [] };
  const verdict = artifactData(views, "qa_verdict");
  if (verdict === null) return buckets;
  for (const assertion of verdict.assertions ?? []) {
    if (!isPlainObject(assertion)) continue;
    const status = assertion.status;
    const bucket = status === "fail" || status === "pass" || status === "skipped" ? status : "other";
    buckets[bucket].push(assertion);
  }
  return buckets;
}

/**
 * Group skipped verdict families by the failure that blocked them.
 *
 * Part of the readback's own projection layer: the grouping is derived from
 * each skipped assertion's recorded `blocked_by`, so a blocked verdict reads as
 * one cascade rather than a dozen independent skips. Returns
 * `{ blocked_by, families }` records in the order the blockers were first seen,
 * which is the order the text view renders.
 */
export function computeSkipCascades(views) {
  const cascades = new Map();
  for (const assertion of partitionAssertions(views).skipped) {
    const evidence = assertion.evidence;
    const blocker = (isPlainObject(evidence) ? evidence.blocked_by : null) || "(no blocked_by recorded)";
    if (!cascades.has(blocker)) cascades.set(blocker, []);
    cascades.get(blocker).push(assertion.family || assertion.id || "(unnamed)");
  }
  return [...cascades].map(([blocked_by, families]) => ({ blocked_by, families }));
}

/**
 * Find where two artifacts record different states for one stage.
 *
 * Part of the readback's own projection layer, and deliberately not an
 * adjudication: a divergence says the assembly report calls a stage completed
 * while the QA verdict fails an assertion named for that stage. Returns
 * `{ stage, assertion_ids }` records, one per stage, in the order the failures
 * were seen.
 */
export function computeDivergences(views) {
  const report = artifactData(views, "report");
  const failed = partitionAssertions(views).fail;
  if (report === null || !failed.length) return [];
  const stages = report.stages;
  if (!isPlainObject(stages)) return [];
  const divergent = new Map();
  for (const assertion of failed) {
    const identifier = assertion.id;
    if (typeof identifier !== "string" || !identifier.includes(".")) continue;
    const stageName = identifier.slice(0, identifier.indexOf("."));
    const stage = stages[stageName];
    if (isPlainObject(stage) && stage.status === "completed") {
      if (!divergent.has(stageName)) divergent.set(stageName, []);
      divergent.get(stageName).push(identifier);
    }
  }
  return [...divergent].map(([stage, assertion_ids]) => ({ stage, assertion_ids }));
}

/**
 * Say how the projected Build Packet was chosen, when that is not obvious.
 *
 * Silent for the ordinary target — one packet, at the default name, nothing
 * ignored — and explicit whenever discovery had more than one file in front of
 * it, so an operator can see which packet this view describes.
 */
function renderPacketSelection(selection, lines) {
  if (!selection) return;
  const indent = `  ${"".padEnd(16)} `;
  const candidates = selection.candidates_considered;
  if (candidates.length > 1) {
    lines.push(
      `${indent}chose ${selection.selected} by generated_at from ${candidates.length} ` +
        `root-level Build Packet candidate(s): ${candidates.join(", ")}`,
    );
  }
  for (const entry of selection.rejected) {
    lines.push(`${indent}ignored candidate ${entry.path}: ${entry.reason}`);
  }
}

function renderArtifactTable(views, lines, packetSelection = null) {
  lines.push("ARTIFACTS");
  for (const [key, view] of Object.entries(views)) {
    const title = ARTIFACT_TITLES[key];
    let status;
    if (view.state === "loaded") {
      const generated = (view.data || {}).generated_at;
      status = typeof generated === "string" && generated ? `loaded — generated_at ${generated}` : "loaded";
    } else if (view.state === "absent") {
      status = "absent";
    } else {
      status = `${view.state} — ${view.detail}`;
    }
    lines.push(`  ${title.padEnd(16)} ${view.path}`);
    lines.push(`  ${"".padEnd(16)} ${status}`);
    if (key === "packet") renderPacketSelection(packetSelection, lines);
  }
  lines.push("");
}

function renderIdentity(views, lines) {
  const entries = [];
  const packet = artifactData(views, "packet");
  const doctor = artifactData(views, "doctor");
  const verdict = artifactData(views, "qa_verdict");
  if (packet) {
    const spec = packet.spec || {};
    const campaign = packet.campaign || {};
    if (spec.map_id) entries.push(["map_id", spec.map_id, "build packet"]);
    if (campaign.public_route_slug) {
      entries.push(["public_route_slug", campaign.public_route_slug, "build packet"]);
    }
    const assembly = packet.assembly || {};
    if (assembly.template_family) entries.push(["template_family", assembly.template_family, "build packet"]);
  } else if (doctor) {
    const derived = doctor.derived || {};
    for (const field of ["map_id", "public_route_slug", "template_family"]) {
      if (derived[field]) entries.push([field, derived[field], "doctor output"]);
    }
  }
  if (verdict && verdict.run_id) entries.push(["qa run_id", verdict.run_id, "QA verdict"]);
  if (!entries.length) return;
  lines.push("RUN IDENTITY");
  for (const [field, value, source] of entries) lines.push(`  ${field} = ${value}  [${source}]`);
  lines.push("");
}

/** A blocker field is usable when it is a non-empty, non-blank string. */
function usableText(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Collapse embedded CR/LF so one blocker stays one rendered line. */
function oneLine(value) {
  return value
    .split(/\r\n|\r|\n/)
    .filter((part) => part.trim())
    .join(" ");
}

/**
 * Render one stage blocker as one rendered entry.
 *
 * Campaigns OS assembly reports emit blockers as plain strings or as objects
 * carrying code/message/stage/page_id/detail. Known-schema text renders in full
 * with embedded CR/LF collapsed, so an object blocker is always one line
 * (BLOCKER_RENDER_CAP is the volume bound); only unknown shapes fall back to a
 * bounded JSON rendering, and that fallback never dumps an arbitrarily large
 * object into normal output.
 *
 * A plain string blocker is returned verbatim per the rendering contract, so a
 * string that already carries newlines still spans several lines.
 */
export function renderBlocker(blocker) {
  if (typeof blocker === "string") return blocker;
  if (isPlainObject(blocker)) {
    const text = usableText(blocker.message) ?? usableText(blocker.detail);
    if (text !== null) {
      const parts = [];
      const code = usableText(blocker.code);
      if (code !== null) parts.push(`[${oneLine(code)}]`);
      parts.push(oneLine(text));
      const identifiers = [];
      for (const field of BLOCKER_IDENTIFIER_FIELDS) {
        const value = usableText(blocker[field]);
        if (value !== null) identifiers.push(`${field}=${oneLine(value)}`);
      }
      if (identifiers.length) parts.push(`(${identifiers.join(", ")})`);
      return parts.join(" ");
    }
  }
  let rendered;
  try {
    rendered = JSON.stringify(blocker);
  } catch {
    rendered = undefined;
  }
  if (rendered === undefined) rendered = String(blocker);
  if (rendered.length > NON_STRING_BLOCKER_RENDER_CAP) {
    rendered = `${rendered.slice(0, NON_STRING_BLOCKER_RENDER_CAP)}... (truncated)`;
  }
  return `(non-string entry, shown as written) ${rendered}`;
}

function renderStages(views, lines) {
  const report = artifactData(views, "report");
  if (report === null) return;
  lines.push(`STAGES  [assembly report; report status: ${recorded(report.status)}]`);
  const stages = report.stages;
  if (isPlainObject(stages)) {
    for (const [name, stage] of Object.entries(stages)) {
      if (!isPlainObject(stage)) continue;
      const status = stage.status ?? "(no status recorded)";
      const counters = [];
      const blockers = stage.blockers;
      const warnings = stage.warnings;
      if (Array.isArray(blockers) && blockers.length) counters.push(`${blockers.length} blocker(s)`);
      if (Array.isArray(warnings) && warnings.length) counters.push(`${warnings.length} warning(s)`);
      const suffix = counters.length ? `  (${counters.join(", ")})` : "";
      lines.push(`  ${name.padEnd(14)} ${status}${suffix}`);
      if (Array.isArray(blockers) && blockers.length) {
        for (const blocker of blockers.slice(0, BLOCKER_RENDER_CAP)) {
          lines.push(`    blocker: ${renderBlocker(blocker)}`);
        }
        const hidden = blockers.length - BLOCKER_RENDER_CAP;
        if (hidden > 0) lines.push(`    ... and ${hidden} more blocker(s) recorded in the assembly report`);
      }
    }
  }
  lines.push("");
}

function renderContext(views, lines) {
  const context = artifactData(views, "context");
  if (context === null) return;
  lines.push(
    `BUILD CONTEXT  [build context; source adapter: ${recorded(context.source_adapter)}, ` +
      `status: ${recorded(context.status)}]`,
  );
  const prompts = context.prompts_required;
  if (Array.isArray(prompts) && prompts.length) {
    lines.push(`  prompts recorded as required before first-shot assembly: ${prompts.length}`);
  }
  const brief = context.build_brief;
  if (isPlainObject(brief) && brief.status) {
    lines.push(
      `  build brief status: ${brief.status} (${brief.question_count ?? 0} question(s), ` +
        `${brief.gate_count ?? 0} gate(s))`,
    );
  }
  lines.push("");
}

function doctorWarningGroups(doctor) {
  const groups = { "contract-static": [], "repo-observed": [] };
  for (const warning of doctor.warnings ?? []) {
    if (!isPlainObject(warning)) continue;
    groups[classifyDoctorWarning(warning.code)].push(warning);
  }
  return groups;
}

/**
 * Summarize the doctor output: status, counts, and warning grouping.
 *
 * `present` is false when no doctor output loaded, and the counts are then zero
 * — the readback reports what it can see, and an absent doctor output is an
 * absence, not an observation of zero errors. Warnings are carried through as
 * doctor recorded them; only the two-way grouping is added.
 */
export function computeDoctorSummary(views) {
  const doctor = artifactData(views, "doctor");
  if (doctor === null) {
    return {
      present: false,
      status: null,
      error_count: 0,
      warning_count: 0,
      warning_groups: { "contract-static": [], "repo-observed": [] },
    };
  }
  const groups = doctorWarningGroups(doctor);
  const errors = doctor.errors;
  return {
    present: true,
    status: doctor.status ?? null,
    error_count: Array.isArray(errors) ? errors.length : 0,
    warning_count: groups["contract-static"].length + groups["repo-observed"].length,
    warning_groups: groups,
  };
}

function renderDoctor(views, lines) {
  const doctor = artifactData(views, "doctor");
  if (doctor === null) return;
  lines.push(`DOCTOR  [doctor output; status: ${doctor.status}]`);
  const errors = doctor.errors;
  if (Array.isArray(errors) && errors.length) {
    lines.push(`  errors (${errors.length}):`);
    for (const error of errors) {
      if (isPlainObject(error)) {
        lines.push(`    ${error.code ?? "(no code)"} — ${error.message ?? "(no message)"}`);
      }
    }
  }
  const groups = doctorWarningGroups(doctor);
  const total = groups["contract-static"].length + groups["repo-observed"].length;
  lines.push(
    `  warnings (${total}) — the contract-static / repo-observed labels are the ` +
      "readback's own projection layer, not doctor's",
  );
  for (const [label, note] of [
    ["contract-static", CONTRACT_STATIC_LABEL_NOTE],
    ["repo-observed", REPO_OBSERVED_LABEL_NOTE],
  ]) {
    const group = groups[label];
    if (!group.length) continue;
    lines.push(`  ${label} (${group.length}) — ${note}`);
    for (const warning of group) {
      lines.push(`    ${warning.code ?? "(no code)"} — ${warning.message ?? "(no message)"}`);
    }
  }
  const nextState = doctor.next;
  if (isPlainObject(nextState)) {
    const blocked = nextState.blocked_stages;
    const blockedText = Array.isArray(blocked) && blocked.length ? `; blocked stages: ${blocked.join(", ")}` : "";
    // The status parenthetical is dropped rather than filled with a placeholder
    // when doctor recorded no status: "(not recorded)" inside parentheses reads
    // as a rendering fault, and the absence is already visible without it.
    const statusText = nextState.status === undefined || nextState.status === null ? "" : ` (${nextState.status})`;
    lines.push(`  doctor's recorded next stage: ${recorded(nextState.stage)}${statusText}${blockedText}`);
  }
  lines.push("");
}

/** Show, without adjudicating, where two artifacts record different states. */
function renderDivergences(views, lines) {
  const divergences = computeDivergences(views);
  if (!divergences.length) return;
  lines.push("  cross-artifact divergence (readback's own layer):");
  for (const divergence of divergences) {
    lines.push(
      `    the assembly report records stage '${divergence.stage}' as completed, while the ` +
        `QA verdict fails ${divergence.assertion_ids.join(", ")}; both records are shown as ` +
        "written — the readback does not adjudicate between artifacts",
    );
  }
}

function renderVerdict(views, lines) {
  const verdict = artifactData(views, "qa_verdict");
  if (verdict === null) return;
  lines.push(
    `QA VERDICT  [QA verdict; disposition: ${verdict.disposition} — Campaigns OS is the verdict authority]`,
  );
  const { fail: failed, pass: passed, skipped, other } = partitionAssertions(views);
  let countLine = `  assertions: ${failed.length} fail, ${passed.length} pass, ${skipped.length} skipped`;
  if (other.length) countLine += `, ${other.length} unrecognized status`;
  lines.push(countLine);
  for (const assertion of failed) {
    const severity = assertion.severity;
    const severityText = severity ? `, severity ${severity}` : "";
    lines.push(
      `  fail  ${recorded(assertion.id, "(no id)")}  ` +
        `(family ${recorded(assertion.family, "(no family)")}${severityText})`,
    );
    const actual = assertion.actual;
    if (actual) lines.push(`        recorded by Campaigns OS: ${actual}`);
    const evidence = assertion.evidence;
    const problems = isPlainObject(evidence) ? evidence.problems : null;
    if (Array.isArray(problems) && problems.length) {
      lines.push(`        recorded problems (${problems.length}):`);
      for (const problem of problems) lines.push(`          - ${problem}`);
    }
  }
  for (const assertion of passed) {
    const family = assertion.family || assertion.id || "(no family)";
    lines.push(`  pass  ${recorded(assertion.id, "(no id)")}  (family ${family})`);
  }
  for (const assertion of other) {
    lines.push(
      `  unrecognized status ${JSON.stringify(assertion.status ?? null)}  ${recorded(assertion.id, "(no id)")}  ` +
        `(family ${assertion.family || "(no family)"}) — shown as written; this readback ` +
        "projects fail, pass, and skipped statuses",
    );
  }

  if (skipped.length) {
    lines.push(
      "  skip provenance — the cascade grouping below is the readback's own " +
        "projection layer, derived from each skipped assertion's blocked_by field:",
    );
    for (const cascade of computeSkipCascades(views)) {
      const families = cascade.families;
      lines.push(
        `    ${cascade.blocked_by} -> ${families.length} skipped ` +
          `famil${families.length === 1 ? "y" : "ies"}:`,
      );
      for (const family of families) lines.push(`      - ${family}`);
    }
  }
  renderDivergences(views, lines);
  lines.push("");
}

function renderFindings(views, lines) {
  const findingsExport = artifactData(views, "findings");
  if (findingsExport === null) return;
  const findings = (findingsExport.findings ?? []).filter((finding) => isPlainObject(finding));
  lines.push(`FINDINGS  [findings export; ${findings.length} finding(s)]`);
  for (const finding of findings) {
    lines.push(
      `  ${finding.stage ?? "(no stage)"} / ${finding.kind ?? "(no kind)"} — ` +
        `${finding.summary ?? "(no summary)"}`,
    );
  }
  lines.push("");
}

/**
 * Render the one-view projection; pure function of its arguments.
 *
 * `staleness` is the optional result of assessStaleness; when omitted the
 * projection carries no staleness section, and the CLI always supplies one.
 * `packetSelection` is the optional selectPacketPath record; when omitted the
 * artifact table says nothing about how the packet was chosen. The
 * one-argument form keeps working: the artifact table shows each loaded
 * artifact's generated_at regardless of whether an assessment was supplied.
 */
export function projectReadback(views, staleness = null, packetSelection = null) {
  const lines = [
    "CAMPAIGNS OS RUN-ARTIFACT READBACK",
    "A read-only projection of this run's emitted artifacts. Campaigns OS",
    "remains the lifecycle and verdict authority; content marked as the",
    "readback's own projection layer is interpretation added by this view,",
    "not by Campaigns OS. This readback proposes no remediation.",
    "",
  ];
  renderStaleness(staleness, lines);
  renderArtifactTable(views, lines, packetSelection);
  renderIdentity(views, lines);
  renderStages(views, lines);
  renderContext(views, lines);
  renderDoctor(views, lines);
  renderVerdict(views, lines);
  renderFindings(views, lines);
  if (Object.values(views).every((view) => view.state === "absent")) {
    lines.push(
      "No run artifacts were found at the projected paths. Either no run has " +
        "emitted artifacts here yet, or this is not a target campaign repository root.",
    );
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * Render one assessStaleness result as JSON-safe values.
 *
 * Instants become ISO-8601 UTC strings through the same formatter the text view
 * uses, so both modes name the same instants the same way.
 */
export function serializeStaleness(staleness) {
  if (!staleness) return null;
  const headTime = staleness.head_time;
  const artifacts = {};
  for (const [key, entry] of Object.entries(staleness.artifacts)) {
    artifacts[key] = { generated_at: formatUtc(entry.generated_at), stale: entry.stale };
  }
  const artifactTimes = {};
  for (const [key, value] of Object.entries(staleness.artifact_times)) artifactTimes[key] = formatUtc(value);
  return {
    computable: staleness.computable,
    stale: staleness.stale,
    stale_keys: [...staleness.stale_keys],
    artifacts,
    newest_key: staleness.newest_key,
    head_time: headTime === null ? null : formatUtc(headTime),
    head_detail: staleness.head_detail,
    artifact_times: artifactTimes,
  };
}

/**
 * Whether this projection shows nothing the readback can call wrong.
 *
 * True only when all four conditions hold: every artifact the readback found is
 * loaded and recognized (absent artifacts are not counted against it — a run
 * that emitted no findings export is not thereby unclean, while an unreadable
 * or unrecognized one always is); the staleness comparison is computable and NO
 * loaded artifact is stale; no cross-artifact divergence was found; and the
 * doctor output records zero errors.
 *
 * This is a readback-integrity flag, not a verdict. Campaigns OS remains the
 * verdict authority: a QA verdict of `blocked` whose artifacts all read cleanly
 * is still `clean: true` here, because the readback saw exactly what Campaigns
 * OS recorded. docs/readback.md states the rule and its limits for callers
 * gating on it.
 */
export function computeClean(views, staleness) {
  if (Object.values(views).some((view) => !CLEAN_ARTIFACT_STATES.has(view.state))) return false;
  if (!staleness || !staleness.computable || staleness.stale) return false;
  if (computeDivergences(views).length) return false;
  return computeDoctorSummary(views).error_count === 0;
}

/**
 * Build the campaigns-os-readback/v2 object; pure function.
 *
 * Serializes what the text projection computes and interprets nothing further.
 * Artifact rows carry the state the readback assigned and never the artifact's
 * own `data` payload: a caller who wants an artifact's contents should read
 * that artifact.
 *
 * `packet_selection` and `staleness` are `null` when a programmatic caller
 * builds a payload without them; the CLI always supplies both.
 */
export function buildJsonPayload(views, staleness = null, packetSelection = null) {
  return {
    schema_version: JSON_SCHEMA_VERSION,
    artifacts: Object.values(views).map((view) => ({
      key: view.key,
      path: view.path,
      state: view.state,
      detail: view.detail,
    })),
    packet_selection: packetSelection,
    staleness: serializeStaleness(staleness),
    doctor: computeDoctorSummary(views),
    skip_cascades: computeSkipCascades(views),
    divergences: computeDivergences(views),
    clean: computeClean(views, staleness),
  };
}

function isFilePath(path) {
  const info = statOrNull(path);
  return Boolean(info && info.isFile());
}

/** Root-level Build Packet files, default first, then suffixed by name. */
function packetCandidatePaths(rootPath) {
  const candidates = [];
  const defaultName = DEFAULT_RELATIVE_PATHS.packet;
  if (isFilePath(join(rootPath, defaultName))) candidates.push(defaultName);
  let names = [];
  try {
    names = readdirSync(rootPath);
  } catch {
    // An unreadable root has no candidates; resolveProjection has already
    // refused a root that is not a directory at all.
    names = [];
  }
  const suffixed = names.filter((name) => PACKET_CANDIDATE_PATTERN.test(name)).sort();
  for (const name of suffixed) if (isFilePath(join(rootPath, name))) candidates.push(name);
  return candidates;
}

/**
 * Choose the Build Packet to project, and record how it was chosen.
 *
 * Returns `{ path, selection, view }`: the packet to project, how it was
 * chosen, and the already-loaded view of it when discovery read it, so the
 * caller does not read the same packet a second time (`view` is null for an
 * explicit `--packet` and for a target with no valid candidate, which discovery
 * never read).
 *
 * `selection` is the record the text and JSON views both publish: `mode` is
 * `explicit` when the caller passed `--packet`, `default` when discovery landed
 * on the fixed default name (including the no-candidate case, where the default
 * path is still what the readback reports as absent), and `discovered` when
 * freshness picked a packet out of several. `signal` names what decided it —
 * `explicit`, `sole_candidate`, `generated_at`, or `none` when nothing was
 * there to choose between.
 *
 * Freshness is the packet's own recorded `generated_at`, never the file's
 * modification time: mtimes are rewritten by clones, checkouts, and copies
 * without any run having recorded anything, while `generated_at` is what the
 * emitting run wrote down. The consequence is that selection stays a pure
 * function of file contents, so two callers reading the same packets always
 * select the same one.
 *
 * Throws ReadbackUsageError when several valid candidates exist and
 * `generated_at` does not single one out — a tie, or any candidate missing a
 * parseable value. A stale packet chosen silently is the failure this refusal
 * exists to prevent, so the caller is told to pass `--packet`.
 */
export function selectPacketPath(rootPath, override) {
  if (override) {
    return {
      path: String(override),
      selection: {
        mode: "explicit",
        signal: "explicit",
        candidates_considered: [],
        rejected: [],
        selected: null,
      },
      view: null,
    };
  }

  const considered = [];
  const rejected = [];
  const views = new Map();
  const times = new Map();
  for (const name of packetCandidatePaths(rootPath)) {
    const view = loadArtifact("packet", join(rootPath, name));
    if (view.state !== "loaded") {
      rejected.push({ path: name, reason: view.detail });
      continue;
    }
    considered.push(name);
    views.set(name, view);
    times.set(name, parseIsoInstant((view.data || {}).generated_at));
  }

  if (!considered.length) {
    if (isFilePath(join(rootPath, SIDECAR_PACKET_RELATIVE))) {
      rejected.push({
        path: SIDECAR_PACKET_RELATIVE,
        reason:
          "file present at sidecar location; contracted packet home is the " +
          "repository root. Pass --packet to project it.",
      });
    }
    return {
      path: join(rootPath, DEFAULT_RELATIVE_PATHS.packet),
      selection: { mode: "default", signal: "none", candidates_considered: [], rejected, selected: null },
      view: null,
    };
  }

  const chose = (name, signal) => ({
    path: join(rootPath, name),
    selection: {
      mode: name === DEFAULT_RELATIVE_PATHS.packet ? "default" : "discovered",
      signal,
      candidates_considered: [...considered],
      rejected,
      selected: name,
    },
    view: views.get(name),
  });

  if (considered.length === 1) return chose(considered[0], "sole_candidate");

  if (considered.some((name) => times.get(name) === null)) {
    const detail = considered
      .map((name) => {
        const time = times.get(name);
        return `${name} ${time === null ? "(no parseable generated_at)" : `(generated_at ${formatUtc(time.date)})`}`;
      })
      .join(", ");
    throw new ReadbackUsageError(
      "one or more Build Packets at the target root carry no parseable generated_at, " +
        `so freshness cannot single out a packet: ${detail}. ` +
        "Pass --packet to name the Build Packet to project.",
    );
  }

  // Freshness is compared in microseconds: a tie here means the packets record
  // the same instant to the microsecond, not merely the same millisecond.
  let newest = times.get(considered[0]).micros;
  for (const name of considered) {
    if (times.get(name).micros > newest) newest = times.get(name).micros;
  }
  const freshest = considered.filter((name) => times.get(name).micros === newest);
  if (freshest.length > 1) {
    throw new ReadbackUsageError(
      `several Build Packets at the target root share the newest generated_at ` +
        `(${formatUtc(times.get(freshest[0]).date)}): ${freshest.join(", ")}. ` +
        "Pass --packet to name the Build Packet to project.",
    );
  }
  return chose(freshest[0], "generated_at");
}

/**
 * Return `{ paths, packetSelection, packetView }` for one target root.
 *
 * `packetView` is the Build Packet view discovery already loaded, ready to hand
 * to loadArtifacts as `preloaded` so no artifact is read twice; it is null when
 * discovery read no packet.
 */
export function resolveProjection(root, overrides = {}) {
  const info = statOrNull(root);
  if (!info || !info.isDirectory()) {
    throw new ReadbackUsageError(`target repository root must name an existing directory: ${root}`);
  }
  const { path: packetPath, selection, view } = selectPacketPath(root, overrides.packet);
  const paths = { packet: packetPath };
  for (const [key, relative] of Object.entries(DEFAULT_RELATIVE_PATHS)) {
    if (key === "packet") continue;
    paths[key] = overrides[key] ? String(overrides[key]) : join(root, relative);
  }
  return { paths, packetSelection: selection, packetView: view };
}

/** The artifact paths to project; discovery result discarded. */
export function resolvePaths(root, overrides = {}) {
  return resolveProjection(root, overrides).paths;
}

/** Project one target root: load every artifact once, then assess freshness. */
export function projectTarget(root, overrides = {}) {
  const { paths, packetSelection, packetView } = resolveProjection(root, overrides);
  const views = loadArtifacts(paths, { packet: packetView });
  return { views, staleness: assessStaleness(root, views), packetSelection };
}

// The bundled synthetic sample `--example` projects. It is already on the
// supported surface as the sidecar-bundle conformance fixture, so the readback
// reuses it rather than shipping a second copy of the same artifact set.
export const EXAMPLE_RELATIVE_ROOT = "contracts/fixtures/sidecar-bundle/production-shaped";
export const EXAMPLE_ROOT = fileURLToPath(
  new URL(`../${EXAMPLE_RELATIVE_ROOT}/`, import.meta.url),
);

// The sample is a packaged fixture directory, not a Git checkout, so there is
// no HEAD movement to compare its artifacts against. Stating that as a fixed
// detail keeps `--example` identical wherever the package is installed: were
// the sample's freshness read from the filesystem, the answer would depend on
// whether the installing repository happens to be a checkout.
export const EXAMPLE_HEAD_DETAIL =
  "the bundled sample is a packaged fixture directory, not a Git checkout: " +
  "freshness is not computable for it by design";

/**
 * Project the bundled synthetic sample; reads only files inside the package.
 *
 * Artifact rows report the sample's paths relative to the package root rather
 * than where the package happens to be installed. An absolute path would make
 * the sample's own output different on every machine, and the point of a
 * bundled sample is that everyone reading the docs sees what they ran.
 */
export function projectExample() {
  const { paths, packetSelection, packetView } = resolveProjection(EXAMPLE_ROOT, {});
  const views = loadArtifacts(paths, { packet: packetView });
  for (const view of Object.values(views)) {
    const within = view.path.slice(EXAMPLE_ROOT.length).replace(/\\/g, "/").replace(/^\/+/, "");
    view.path = `${EXAMPLE_RELATIVE_ROOT}/${within}`;
  }
  const staleness = assessStaleness(EXAMPLE_ROOT, views, {
    headMovement: { time: null, detail: EXAMPLE_HEAD_DETAIL },
  });
  return { views, staleness, packetSelection };
}

const OVERRIDE_FLAGS = {
  packet: "packet",
  doctor: "doctor",
  context: "context",
  report: "report",
  "qa-verdict": "qa_verdict",
  findings: "findings",
};

// `--example <anything>` parses as a flag carrying a value, so the refusal has
// to name the shape the caller probably meant: a target written after
// `--example` is swallowed as its value and never reaches the positional list.
const EXAMPLE_USAGE =
  "--example projects the bundled synthetic sample and takes no target or path override. " +
  "Use `campaigns-os readback --example [--json]`, or name a target without --example.";

function booleanFlag(args, flag, extra = "") {
  const value = args[flag];
  if (value === undefined) return false;
  if (value !== true) throw new ReadbackUsageError(`--${flag} is a boolean flag and takes no value.${extra}`);
  return true;
}

/**
 * Validate one `campaigns-os readback` invocation into a projection request.
 *
 * Throws ReadbackUsageError for anything that cannot form a projection; the
 * dispatcher turns that into the exit-2 usage path.
 */
export function readbackRequest(args) {
  const json = booleanFlag(args, "json");
  const example = booleanFlag(args, "example", ` ${EXAMPLE_USAGE}`);
  const positionals = (args._ ?? []).slice(1);
  const overrides = {};
  for (const [flag, key] of Object.entries(OVERRIDE_FLAGS)) {
    const value = args[flag];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) throw new ReadbackUsageError(`Missing value for --${flag}.`);
    overrides[key] = value;
  }
  if (example) {
    const named = Object.keys(OVERRIDE_FLAGS).filter((flag) => args[flag] !== undefined);
    if (positionals.length || named.length) {
      throw new ReadbackUsageError(
        `${EXAMPLE_USAGE} Got ${[...positionals, ...named.map((flag) => `--${flag}`)].join(", ")}.`,
      );
    }
    return { example: true, json, target: null, overrides: {} };
  }
  if (positionals.length > 1) {
    throw new ReadbackUsageError(
      `readback projects one target repository root; got ${positionals.length}: ${positionals.join(", ")}.`,
    );
  }
  if (!positionals.length) {
    throw new ReadbackUsageError(
      "Use: campaigns-os readback <target-repo-root> [--json] [--packet <path>] " +
        "[--doctor <path>] [--context <path>] [--report <path>] [--qa-verdict <path>] " +
        "[--findings <path>], or campaigns-os readback --example [--json].",
    );
  }
  return { example: false, json, target: positionals[0], overrides };
}

/**
 * Run one readback invocation and return what to print.
 *
 * Returns `{ exitCode, text }`: exit 0 with the projection for any target the
 * readback could form a view of — an unreadable artifact is a state it reports,
 * not an error — and exit 2 with a one-line reason for a caller request that
 * cannot form a projection at all.
 */
export function runReadbackCommand(args) {
  let request;
  let projection;
  try {
    request = readbackRequest(args);
    projection = request.example ? projectExample() : projectTarget(request.target, request.overrides);
  } catch (error) {
    if (error instanceof ReadbackUsageError) return { exitCode: 2, text: `${error.message}\n` };
    throw error;
  }
  const { views, staleness, packetSelection } = projection;
  const text = request.json
    ? `${JSON.stringify(buildJsonPayload(views, staleness, packetSelection), null, 2)}\n`
    : projectReadback(views, staleness, packetSelection);
  return { exitCode: 0, text };
}
