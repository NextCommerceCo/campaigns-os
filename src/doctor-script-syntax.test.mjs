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
