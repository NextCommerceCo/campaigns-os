import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { validateMarketSensitiveCopy } from "./doctor/checks.mjs";

const finding = "copy.hardcoded_phone";

function scan(html) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-phone-scan-"));
  try {
    writeFileSync(join(dir, "index.html"), html);
    const warnings = [];
    const ready = [];
    validateMarketSensitiveCopy({ campaign: { store_phone: "(800) 555-0100" } }, warnings, ready, { source_root: dir });
    return warnings.filter((warning) => warning.code === finding);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("digit runs in CSS comments, <style> content and HTML comments are not phone numbers", () => {
  const issues = scan(`<!doctype html>
<html><head>
<style>
  /* Group 1000003339 */
  .frame-1000003339 { width: 100px; }
</style>
</head><body>
<!-- 1000003339 -->
<p>Questions? Call our team.</p>
</body></html>`);
  assert.deepEqual(issues, [], "comment and style digits must not be read as phone numbers");
});

test("a visible phone number outside comments and <style> still warns", () => {
  const issues = scan(`<!doctype html>
<html><head>
<style>/* Group 1000003339 */</style>
</head><body>
<!-- 1000003339 -->
<p>Call 555-123-4567 today.</p>
</body></html>`);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /"555-123-4567"/);
  assert.doesNotMatch(issues[0].message, /1000003339/);
  assert.match(issues[0].message, /index\.html:6 /, "line numbers survive the masking");
});
