import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ADVISORY_DETAIL_MAX, singleLineDetail, singleLineField, singleLineFragment } from "./text-safety.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = (relPath) => JSON.parse(readFileSync(resolve(ROOT, relPath), "utf8"));

const ESC = "\u001b";
const REPLACEMENT = "\uFFFD";

// The point of publishing these: a consumer rendering a toolkit-derived value
// into its own single-line notice must be able to flatten it the same way
// rather than reimplement the escape set. Resolve through the package's own
// exports map (self-reference), which is the mechanism a consumer's bare
// specifier uses too — a test that imported "./text-safety.mjs" here would pass
// with the export missing from package.json entirely.
test("./text-safety resolves through the package exports map", async () => {
  const mod = await import("@nextcommerce/campaigns-os/text-safety");
  assert.equal(typeof mod.singleLineField, "function");
  assert.equal(typeof mod.singleLineDetail, "function");
  assert.equal(typeof mod.singleLineFragment, "function");
  // Same module instance, not a second copy resolved from a stale path.
  assert.equal(mod.singleLineField, singleLineField);
  assert.equal(mod.singleLineDetail, singleLineDetail);
  assert.equal(mod.singleLineFragment, singleLineFragment);
});

test("the export is declared in package.json and on the supported surface", () => {
  const pkg = readJson("package.json");
  assert.ok(
    "./text-safety" in (pkg.exports ?? {}),
    'package.json exports must declare "./text-safety"',
  );
  assert.ok(
    pkg.files.includes("src"),
    "package.json files[] must ship src/ or the export is absent from the installed package",
  );
  const surface = readJson("contracts/supported-surface.json");
  assert.ok(
    surface.package_exports.includes("./text-safety"),
    'contracts/supported-surface.json package_exports must list "./text-safety"',
  );
});

test("singleLineField replaces control characters instead of dropping them", () => {
  const flattened = singleLineField(`run\n1\rid\tx${ESC}[2K`);
  assert.equal(flattened, `run${REPLACEMENT}1${REPLACEMENT}id${REPLACEMENT}x${REPLACEMENT}[2K`);
  // Replaced, never dropped: a mangled value must stay visibly mangled and the
  // same length, so the notice cannot be silently shortened.
  assert.equal(flattened.length, `run\n1\rid\tx${ESC}[2K`.length);
  assert.doesNotMatch(flattened, /[\n\r\t\u001b]/);
});

test("singleLineField covers C1 and DEL, not only the C0 block", () => {
  assert.equal(singleLineField("a\u007fb\u0085c"), `a${REPLACEMENT}b${REPLACEMENT}c`);
});

test("singleLineField returns the fallback only for an empty or absent value", () => {
  assert.equal(singleLineField("", "(unnamed)"), "(unnamed)");
  assert.equal(singleLineField(null, "(unnamed)"), "(unnamed)");
  assert.equal(singleLineField(undefined, "(unnamed)"), "(unnamed)");
  assert.equal(singleLineField(""), "");
  // A non-string is stringified, not dropped: 0 and false are real values.
  assert.equal(singleLineField(0, "(unnamed)"), "0");
  assert.equal(singleLineField(false, "(unnamed)"), "false");
  // A safe value passes through byte for byte, including a target path.
  assert.equal(singleLineField("/srv/example/target-cpk"), "/srv/example/target-cpk");
});

test("singleLineFragment reads whitespace as a sentence does and every other control as mangling", () => {
  // Line breaks and tabs are word boundaries; runs of whitespace are one space;
  // the ends are trimmed. This is the reading a value folded into a sentence
  // gets, and it is why a repair instruction wrapped across lines reads as one.
  assert.equal(singleLineFragment("Correct the waiver's\n expires_at on the report."), "Correct the waiver's expires_at on the report.");
  assert.equal(singleLineFragment("  a\r\n\tb   c  "), "a b c");
  // ESC, DEL, BEL and C1 have no reading as text: replaced, never folded into
  // a space, so the mangling stays visible in the sentence.
  assert.equal(singleLineFragment(`cmd${ESC}[2K --flag`), `cmd${REPLACEMENT}[2K --flag`);
  assert.equal(singleLineFragment("\u0007a\u007fb\u009cc"), `${REPLACEMENT}a${REPLACEMENT}b${REPLACEMENT}c`);
  // No Markdown escaping and no cap: a command must stay pasteable.
  const command = "campaigns-os checkpoint waive --packet <packet> --gate page_kit.sdk_version";
  assert.equal(singleLineFragment(command), command);
  assert.equal(singleLineFragment("x".repeat(400)).length, 400);
});

test("singleLineFragment returns the fallback only for a value with no words in it", () => {
  assert.equal(singleLineFragment("", "(none)"), "(none)");
  assert.equal(singleLineFragment("   \n\t ", "(none)"), "(none)");
  assert.equal(singleLineFragment(null, "(none)"), "(none)");
  assert.equal(singleLineFragment(undefined), "");
  // Stringified, not dropped, like singleLineField.
  assert.equal(singleLineFragment(0, "(none)"), "0");
});

test("singleLineDetail is singleLineFragment plus Markdown escaping, a cap and a placeholder", () => {
  // The folding policy is defined once: on an input with no Markdown and no
  // excess length, the two agree byte for byte.
  for (const input of ["unexpected token\n  at line 3", `bad${ESC}[31m value`, "a\nb\tc\r\nd", "\u0007bell\u009cstring"]) {
    assert.equal(singleLineDetail(input), singleLineFragment(input).replace(/[`*_[\]<>]/g, "\\$&"), JSON.stringify(input));
  }
});

test("singleLineDetail turns line breaks into word boundaries, not replacement characters", () => {
  // A newline inside a quoted JSON fragment is a word boundary; rendering it as
  // U+FFFD would read as mojibake. Everything else control-shaped still gets
  // the replacement character.
  assert.equal(singleLineDetail("unexpected token\n  at line 3"), "unexpected token at line 3");
  // The ESC becomes U+FFFD and the bracket is Markdown-escaped on top of it.
  assert.equal(singleLineDetail(`bad${ESC}[31m value`), `bad${REPLACEMENT}\\[31m value`);
  assert.doesNotMatch(singleLineDetail("a\r\nb"), /[\r\n]/);
});

test("singleLineDetail escapes the Markdown that could restyle the rest of a bullet", () => {
  assert.equal(
    singleLineDetail("`code` *bold* _it_ [ref] <tag>"),
    "\\`code\\` \\*bold\\* \\_it\\_ \\[ref\\] \\<tag\\>",
  );
});

// Moved with the functions from src/next-theme-starter-palette.test.mjs, which
// exercised the detail sanitiser through the CLI's own export.
test("singleLineDetail flattens tabs and mixed line breaks to single spaces", () => {
  assert.equal(singleLineDetail("a\nb\tc\r\nd"), "a b c d");
  assert.equal(singleLineDetail("has `code` and [a](b)"), "has \\`code\\` and \\[a\\](b)");
  // A BEL and a C1 control both become the replacement character.
  assert.equal(singleLineDetail("\u0007bell\u009cstring"), `${REPLACEMENT}bell${REPLACEMENT}string`);
  assert.equal(singleLineDetail(undefined), "(no detail reported)");
  assert.equal(singleLineDetail("x".repeat(500)).length, ADVISORY_DETAIL_MAX);
});

test("singleLineDetail truncates at the bound with an ellipsis", () => {
  const long = "x".repeat(ADVISORY_DETAIL_MAX + 50);
  const flattened = singleLineDetail(long);
  assert.equal(flattened.length, ADVISORY_DETAIL_MAX);
  assert.ok(flattened.endsWith("\u2026"));
  // At the bound exactly, nothing is added.
  const exact = "y".repeat(ADVISORY_DETAIL_MAX);
  assert.equal(singleLineDetail(exact), exact);
  // The bound is a parameter, and it is respected.
  assert.equal(singleLineDetail("abcdefghij", 5), "abcd\u2026");
});

test("singleLineDetail reports absence rather than an empty string", () => {
  assert.equal(singleLineDetail(null), "(no detail reported)");
  assert.equal(singleLineDetail(""), "(no detail reported)");
  assert.equal(singleLineDetail("   \n\t "), "(no detail reported)");
});

test("singleLineDetail never exceeds max and never fabricates a lone ellipsis", () => {
  // A budget of one cannot hold the ellipsis, so the cut is bare; a budget
  // below one floors at one rather than printing nothing.
  assert.equal(singleLineDetail("abc", 0), "a");
  assert.equal(singleLineDetail("abc", -5), "a");
  assert.equal(singleLineDetail("abc", 1), "a");
  assert.equal(singleLineDetail("abc", 1.9), "a");
  assert.equal(singleLineDetail("a", 1), "a");
  assert.equal(singleLineDetail("abc", 2), "a\u2026");
  for (const max of [0, 1, 2, 3, 4]) {
    assert.ok(singleLineDetail("abcdef", max).length <= Math.max(1, max), `max=${max}`);
    assert.notEqual(singleLineDetail("abcdef", max), "\u2026", `max=${max}`);
  }
  assert.equal(singleLineDetail("abc", Number.NaN), "abc");
});
