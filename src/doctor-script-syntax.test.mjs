// Built-output script syntax gate (#480): a campaign-owned script that does
// not parse blocks doctor, through both entry points, with the file, line and
// column named. The committed good/bad pair differs by exactly one trailing
// `});` in js/checkout.js, the shape that shipped.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { doctorBuiltOutput, doctorPacket } from "./cli.mjs";
import {
  SCRIPT_SYNTAX,
  SCRIPT_SYNTAX_PARSE_FAILURE,
  evaluateBuiltScriptSyntax,
  pageScriptReferences,
  parseScriptSyntax,
  scriptKind,
} from "./built-script-syntax.mjs";

const FIXTURE_ROOT = resolve(new URL("../fixtures/script-syntax", import.meta.url).pathname);
const SLUG = "example-campaign";
const EXAMPLES = new URL("../examples/", import.meta.url);
const gateOf = (result) => (result.derived?.checkpoint_gates || []).find((gate) => gate.id === SCRIPT_SYNTAX) || null;
const fixture = (variant) => doctorBuiltOutput({ built: join(FIXTURE_ROOT, variant), slug: SLUG });

test("the unmodified fixture is clean: every local script parses, remote and data-block scripts are not read", () => {
  const result = fixture("good");
  const gate = gateOf(result);
  assert.ok(gate, "the script syntax gate did not run");
  assert.ok(result.derived.doctor_checks.includes(SCRIPT_SYNTAX));
  assert.equal(gate.status, "pass", gate.reason);
  assert.equal(gate.scripts_scanned, 3, "config.js, js/checkout.js and the module script");
  assert.deepEqual(gate.scripts_unresolved, []);
  assert.deepEqual(result.errors.filter((issue) => issue.code.startsWith(SCRIPT_SYNTAX)), []);
  assert.ok(result.ready.some((line) => /All 3 campaign-owned script\(s\) loaded by built pages parse/.test(line)));
});

test("one extra `});` in the checkout script blocks doctor --built with the file and position named", () => {
  const result = fixture("bad");
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  const errors = result.errors.filter((issue) => issue.code.startsWith(SCRIPT_SYNTAX));
  assert.equal(errors.length, 1, JSON.stringify(result.errors));
  const [error] = errors;
  assert.equal(error.code, SCRIPT_SYNTAX_PARSE_FAILURE);
  assert.match(error.message, /js\/checkout\.js:8:1: Unexpected token/);
  assert.equal(error.detail.finding.line, 8);
  assert.equal(error.detail.finding.column, 1);
  assert.equal(error.detail.finding.file, "_site/example-campaign/js/checkout.js");
  assert.deepEqual(error.detail.finding.pages, ["checkout"]);
  const gate = gateOf(result);
  assert.equal(gate.status, "blocked");
  assert.equal(gate.waivable, false);
  assert.equal(gate.scripts_scanned, 3);
});

test("the packet-mode doctor path runs the same gate over the built output", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-script-syntax-"));
  try {
    for (const file of ["build-packet.basic.json", "campaignspec.v42.basic.json"]) cpSync(new URL(file, EXAMPLES), join(dir, file));
    cpSync(new URL("source-html", EXAMPLES), join(dir, "source-html"), { recursive: true });
    cpSync(new URL("target-page-kit", EXAMPLES), join(dir, "target-page-kit"), { recursive: true });
    const packetPath = join(dir, "build-packet.basic.json");
    const slug = JSON.parse(readFileSync(packetPath, "utf8")).campaign.public_route_slug;
    const siteRoot = join(dir, "target-page-kit", "_site", slug);
    cpSync(join(FIXTURE_ROOT, "bad", "_site", SLUG), siteRoot, { recursive: true });
    // The fixture page loads its config by the fixture slug; point it at this one.
    const page = join(siteRoot, "checkout", "index.html");
    writeFileSync(page, readFileSync(page, "utf8").replaceAll(`/${SLUG}/`, `/${slug}/`));

    const blocked = doctorPacket(packetPath);
    assert.ok(blocked.derived.doctor_checks.includes(SCRIPT_SYNTAX));
    const errors = blocked.errors.filter((issue) => issue.code === SCRIPT_SYNTAX_PARSE_FAILURE);
    assert.equal(errors.length, 1, JSON.stringify(blocked.errors.map((issue) => issue.code)));
    assert.match(errors[0].message, new RegExp(`^_site/${slug}/js/checkout\\.js:8:1: Unexpected token`));
    assert.equal(gateOf(blocked).status, "blocked");

    cpSync(join(FIXTURE_ROOT, "good", "_site", SLUG, "js", "checkout.js"), join(siteRoot, "js", "checkout.js"));
    const clean = doctorPacket(packetPath);
    assert.equal(gateOf(clean).status, "pass", gateOf(clean).reason);
    assert.equal(gateOf(clean).scripts_scanned, 3);
    assert.deepEqual(clean.errors.filter((issue) => issue.code.startsWith(SCRIPT_SYNTAX)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("module scripts parse as modules and classic scripts as scripts", () => {
  assert.equal(parseScriptSyntax('import x from "./x.js"; export default x;', { module: true }), null);
  const classic = parseScriptSyntax('import x from "./x.js";');
  assert.ok(classic, "an import statement is a syntax error in a classic script");
  assert.equal(classic.line, 1);
  assert.equal(parseScriptSyntax("#!/usr/bin/env node\nconst a = 1 ?? 2;"), null);
  assert.deepEqual(parseScriptSyntax("a();\n\n  });"), { line: 3, column: 3, message: "Unexpected token" });
});

test("script references: data blocks, template content and noscript are dropped; module is recorded", () => {
  const refs = pageScriptReferences(
    '<script src="a.js"></script><script type="text/javascript" src="b.js"></script>'
    + '<script type="module" src="c.js"></script><script type="application/ld+json" src="d.json"></script>'
    + '<script type="text/template" src="e.html"></script><noscript><script src="f.js"></script></noscript>'
    + '<template><script src="g.js"></script></template><script>inline()</script>',
  );
  assert.deepEqual(refs, [
    { src: "a.js", module: false },
    { src: "b.js", module: false },
    { src: "c.js", module: true },
  ]);
});

test("script references: a commented-out script tag is not a reference", () => {
  const refs = pageScriptReferences(
    '<!-- <script src="old.js"></script> --><script src="live.js"></script><!--<script src="x.js">-->',
  );
  assert.deepEqual(refs, [{ src: "live.js", module: false }]);
});

test("a referenced local script missing from disk is listed, not judged", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-script-syntax-"));
  try {
    const page = join(dir, "_site", SLUG, "checkout");
    mkdirSync(page, { recursive: true });
    writeFileSync(join(page, "index.html"), '<html><head><script src="/example-campaign/js/absent.js"></script><script src="//cdn.example.com/x.js"></script></head><body></body></html>');
    const gate = gateOf(doctorBuiltOutput({ built: dir, slug: SLUG }));
    assert.equal(gate.status, "not_applicable");
    assert.deepEqual(gate.scripts_unresolved, [{ src: "/example-campaign/js/absent.js", pages: ["checkout"] }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the evaluator names every unparsable file and counts the rest", () => {
  const gate = evaluateBuiltScriptSyntax({
    pages_scanned: 2,
    scripts: [
      { file: "a.js", content: "ok();", pages: ["landing"] },
      { file: "b.js", content: "if (x) {", pages: ["checkout"] },
      { file: "c.js", content: "export const y = 1;", module: false, pages: ["receipt"] },
    ],
  });
  assert.equal(gate.status, "blocked");
  assert.deepEqual(gate.findings.map((finding) => finding.file), ["b.js", "c.js"]);
  assert.match(gate.reason, /^2 of 3 campaign-owned script\(s\) do not parse: b\.js:1:9, c\.js:1:1\.$/);
  assert.equal(gate.required_actions.length, 2);
});

// Review follow-ups on #480: the gate reads the file the browser loads, and
// nothing the parser echoes from the source reaches the doctor output.
const BAD = "document.addEventListener(\"DOMContentLoaded\", () => {\n  init();\n});\n});\n";
const GOOD = "document.addEventListener(\"DOMContentLoaded\", () => {\n  init();\n});\n";
function builtSite(pageHtml, files) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-script-syntax-"));
  const site = join(dir, "_site", SLUG);
  mkdirSync(join(site, "checkout"), { recursive: true });
  writeFileSync(join(site, "checkout", "index.html"), `<!DOCTYPE html><html><head>${pageHtml}</head><body></body></html>`);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return { dir, run: () => doctorBuiltOutput({ built: dir, slug: SLUG }) };
}
const syntaxErrors = (result) => result.errors.filter((issue) => issue.code === SCRIPT_SYNTAX_PARSE_FAILURE);

test("a <base href> moves the script the gate reads to the one the browser loads", () => {
  const { dir, run } = builtSite(`<base href="/${SLUG}/assets/"><script src="checkout.js"></script>`, {
    [`_site/${SLUG}/assets/checkout.js`]: BAD,
    [`_site/${SLUG}/checkout/checkout.js`]: GOOD,
  });
  try {
    const errors = syntaxErrors(run());
    assert.equal(errors.length, 1);
    assert.equal(errors[0].detail.finding.file, `_site/${SLUG}/assets/checkout.js`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const relative = builtSite('<base href="../assets/"><script src="checkout.js"></script>', {
    [`_site/${SLUG}/assets/checkout.js`]: BAD,
    [`_site/${SLUG}/checkout/checkout.js`]: GOOD,
  });
  try {
    assert.equal(syntaxErrors(relative.run())[0]?.detail.finding.file, `_site/${SLUG}/assets/checkout.js`);
  } finally {
    rmSync(relative.dir, { recursive: true, force: true });
  }
  // A base on another origin makes a relative src remote: not campaign-owned, not read.
  const remote = builtSite('<base href="https://cdn.example.com/lib/"><script src="checkout.js"></script>', {
    [`_site/${SLUG}/checkout/checkout.js`]: BAD,
  });
  try {
    const gate = gateOf(remote.run());
    assert.equal(gate.status, "not_applicable", gate.reason);
    assert.deepEqual(gate.scripts_unresolved, []);
  } finally {
    rmSync(remote.dir, { recursive: true, force: true });
  }
});

test("a percent-encoded script path is decoded before it is mapped onto the built output", () => {
  const { dir, run } = builtSite('<script src="../js/%63heckout.js"></script><script src="/example-campaign/js/with%20space.js"></script>', {
    [`_site/${SLUG}/js/checkout.js`]: BAD,
    [`_site/${SLUG}/js/with space.js`]: GOOD,
  });
  try {
    const result = run();
    const gate = gateOf(result);
    assert.deepEqual(gate.scripts_unresolved, []);
    assert.equal(gate.scripts_scanned, 2);
    assert.deepEqual(syntaxErrors(result).map((issue) => issue.detail.finding.file), [`_site/${SLUG}/js/checkout.js`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an encoded path never reads a file outside the built output", () => {
  const { dir, run } = builtSite(
    '<script src="/%2e%2e/outside.js"></script><script src="..%2f..%2f..%2foutside.js"></script><script src="/example-campaign/%2e%2e%2f%2e%2e%2foutside.js"></script><script src="/js/%E0%A4%A.js"></script>',
    { "outside.js": BAD },
  );
  try {
    const result = run();
    const gate = gateOf(result);
    assert.equal(gate.status, "not_applicable", gate.reason);
    assert.equal(gate.scripts_unresolved.length, 4);
    assert.deepEqual(syntaxErrors(result), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a nomodule script never runs in a module-capable browser and cannot block doctor", () => {
  const { dir, run } = builtSite(`<script nomodule src="/${SLUG}/js/legacy.js"></script><script src="/${SLUG}/js/app.js"></script>`, {
    [`_site/${SLUG}/js/legacy.js`]: BAD,
    [`_site/${SLUG}/js/app.js`]: GOOD,
  });
  try {
    const result = run();
    assert.deepEqual(syntaxErrors(result), []);
    const gate = gateOf(result);
    assert.equal(gate.status, "pass", gate.reason);
    assert.equal(gate.scripts_scanned, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(pageScriptReferences('<script nomodule src="a.js"></script><script src="b.js"></script>'), [{ src: "b.js", module: false }]);
});

test("a module script ignores nomodule, so doctor still parses it and blocks on its syntax error", () => {
  const { dir, run } = builtSite(`<script type="module" nomodule src="/${SLUG}/js/app.js"></script>`, {
    [`_site/${SLUG}/js/app.js`]: BAD,
  });
  try {
    const result = run();
    assert.equal(syntaxErrors(result).length, 1);
    assert.equal(gateOf(result).status, "blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(pageScriptReferences('<script type="module" nomodule src="a.js"></script>'), [{ src: "a.js", module: true }]);
});

test("script types are ASCII-whitespace-trimmed and case-insensitive, as the browser reads them", () => {
  assert.deepEqual(
    pageScriptReferences([
      '<script type=" text/javascript " src="a.js"></script>',
      '<script type="\tTEXT/JavaScript\n" src="b.js"></script>',
      '<script type=" Module " src="c.js"></script>',
      '<script type=" MODULE " nomodule src="d.js"></script>',
      '<script type=" text/javascript " nomodule src="e.js"></script>',
      '<script type="\u00a0module" src="f.js"></script>',
      '<script type=" " src="g.js"></script>',
      '<script type="" src="h.js"></script>',
    ].join("")),
    [
      { src: "a.js", module: false },
      { src: "b.js", module: false },
      { src: "c.js", module: true },
      { src: "d.js", module: true },
      { src: "h.js", module: false },
    ],
  );
});

test("source text at the error site never reaches the doctor output", () => {
  const canary = "synthetic_canary_Zq81xT";
  const sources = {
    [`_site/${SLUG}/js/regex.js`]: `var pattern = /${canary}(/;\n`,
    [`_site/${SLUG}/js/dup.js`]: `let ${canary} = 1;\nlet ${canary} = 2;\n`,
    [`_site/${SLUG}/js/char.js`]: `var a = 1;\n@${canary}\n`,
    [`_site/${SLUG}/js/reserved.js`]: `"use strict";\nvar ${canary} = 1; var yield = "${canary}";\n`,
  };
  const { dir, run } = builtSite(Object.keys(sources).map((rel) => `<script src="/${rel.replace(/^_site\//, "")}"></script>`).join(""), sources);
  try {
    const result = run();
    assert.equal(syntaxErrors(result).length, 4);
    assert.equal(JSON.stringify(result).includes(canary), false, "a parser message echoed source text");
    for (const issue of syntaxErrors(result)) assert.match(issue.message, /^_site\/example-campaign\/js\/\w+\.js:\d+:\d+: [A-Z][a-z]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const source of [`/${canary}(/`, `let ${canary}; let ${canary};`, `"use strict"; var ${canary}; var let = "${canary}";`]) {
    const failure = parseScriptSyntax(source);
    assert.ok(failure, source);
    assert.equal(failure.message.includes(canary), false, failure.message);
  }
});

test("scriptKind follows the HTML type-string steps, including whitespace-only types and the legacy language attribute", () => {
  const cases = [
    [{}, "classic"],
    [{ type: "" }, "classic"],
    // Stripped to "", which is not a JavaScript MIME type: the browser runs nothing.
    [{ type: " " }, null],
    [{ type: "\t\n" }, null],
    // With no type, the browser builds "text/" + language.
    [{ language: "" }, "classic"],
    [{ language: "JavaScript" }, "classic"],
    [{ language: "javascript1.5" }, "classic"],
    [{ language: "vbscript" }, null],
    // language is concatenated unstripped, so trailing whitespace runs nothing.
    [{ language: "JavaScript " }, null],
    [{ language: " javascript" }, null],
    // A whitespace-only type is still a type: language is not consulted.
    [{ type: " ", language: "" }, null],
    // A type attribute wins over language.
    [{ type: "", language: "vbscript" }, "classic"],
    [{ type: "module", language: "vbscript" }, "module"],
    // nomodule only stops classic scripts; a data block stays a data block.
    [{ nomodule: "" }, null],
    [{ type: "module", nomodule: "" }, "module"],
    [{ type: "application/ld+json", nomodule: "" }, null],
  ];
  for (const [attrs, expected] of cases) assert.equal(scriptKind(attrs), expected, JSON.stringify(attrs));
});
