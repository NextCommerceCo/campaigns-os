// Loopback harness for the unit 2.4 (readability) browser rows. Imported by
// src/polish-readability.browser.test.mjs (the Polish rows) and
// src/qa-cta-contrast.browser.test.mjs (the QA P rows). It registers no
// tests of its own.
//
// Everything is synthetic: the shipped example packet and target
// (campaignFixture), stub pages written to _site/<slug>/ and served byte for
// byte from the same bytes by raw TCP stub servers on 127.0.0.1 (the 1.3
// harness's stubOrigin; a second port is "another origin").
//
// No network beyond loopback: importing src/qc-test-factories.mjs (through
// the 1.3 harness) installs the Node-side guard before any module under test
// loads; every capture runs Chromium through the 1.3 harness's loopback
// guard (any request-bearing event naming a non-loopback host fails the
// capture) and checks the Node-side guard on return.
//
// Browser gate: the 1.3 harness launches Chromium once at import; with
// CAMPAIGNS_OS_REQUIRE_BROWSER=1 a launch failure fails the file, never a
// silent skip.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { browserTest, connectionReset, loopbackGuard, respond, stubOrigin } from "./polish-media-weight-harness.browser.test.mjs";
import { SLUG, assertNoNetworkAttempts, campaignFixture, doctorOf, mutateReport, readJson, runCli, writeJson } from "./qc-test-factories.mjs";

export { SLUG, browserTest, connectionReset, respond };
export const VIEWPORTS = Object.freeze(["desktop", "mobile"]);
export const READABILITY_SCHEMA = "campaigns-os-polish-readability/v0";
export const CHECK = "readability.contrast";
export const routeOf = (name) => `/${SLUG}/${name}/`;

export const BASE_STYLE = "body{margin:0;background:#ffffff;color:#111111;font:16px/1.4 sans-serif}";
export const htmlPage = (body, { head = "", htmlAttrs = "", bodyAttrs = "", base = BASE_STYLE } = {}) => `<!doctype html><html${htmlAttrs ? ` ${htmlAttrs}` : ""}><head><meta charset="utf-8"><title>Synthetic</title><link rel="icon" href="data:,"><style>${base}</style>${head}</head><body${bodyAttrs ? ` ${bodyAttrs}` : ""}>${body}</body></html>`;

// The mapped page every capture keeps in page_load's plan, so BASE_SHA's
// `polish capture` completes (exit 0) on every site that is not all-stock.
export const LANDING = htmlPage(`<main style="padding:16px;background:#ffffff;color:#111111"><p>Synthetic landing</p></main>`);

// A response that never sends its headers (a stalled request).
export const stall = () => () => {};

// The network-idle window (capturePolish's `networkIdleMs`) for a capture
// whose site serves a stall(): each cell of a page that requests one waits
// the whole window out, 5 s in production. Every other request of these
// loopback pages completes at once, so a 2 s window closes on the same
// pending state.
export const STALLED_IDLE_MS = 2_000;

// A campaign fixture whose packet maps only `mapped` (every other example
// page carries a skip_reason: a template stock page), whose built output is
// exactly `pages` (+ the landing page when it is mapped), recorded by
// `record build`, and whose pages are served on 127.0.0.1. `pages` and
// `assets` may be functions of the other origin, for cross-origin markup.
export async function readabilitySite({ pages, mapped = ["landing"], assets = {}, otherAssets = {} } = {}) {
  const same = await stubOrigin();
  const other = await stubOrigin();
  const f = campaignFixture({ setupCompleted: true });
  const close = async () => {
    await same.close();
    await other.close();
    f.cleanup();
  };
  try {
    const packet = readJson(f.packetPath);
    for (const page of packet.source_html.pages) {
      if (!mapped.includes(page.page_id)) page.skip_reason = "Synthetic template stock page with no source mapping.";
    }
    writeJson(f.packetPath, packet);
    const built = { ...(mapped.includes("landing") ? { landing: LANDING } : {}), ...(typeof pages === "function" ? pages({ other }) : pages) };
    for (const [name, html] of Object.entries(built)) {
      const file = join(f.targetRepo, "_site", SLUG, name, "index.html");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, html);
      same.serve(routeOf(name), respond("200 OK", "text/html; charset=utf-8", html));
    }
    for (const [path, handler] of Object.entries(typeof assets === "function" ? assets({ other }) : assets)) same.serve(path, handler);
    for (const [path, handler] of Object.entries(otherAssets)) other.serve(path, handler);
    await recordBuild(f);
    return { f, same, other, names: Object.keys(built), close };
  } catch (error) {
    await close();
    throw error;
  }
}

// `record build` over the built output as it stands; returns the build
// fingerprint it stamped.
async function recordBuild(f) {
  const recorded = await runCli(["record", "build", "--packet", f.packetPath, "--json"]);
  assert.equal(recorded.exitCode, 0, `setup: record build records the synthetic _site (${recorded.error?.message || recorded.stdout.slice(0, 300)})`);
  // The report names its packet the way prepare-build records it (relative
  // to the target repo), which polish capture's binding requires.
  mutateReport(f, (report) => {
    report.inputs = { ...(report.inputs || {}), packet_path: relative(f.targetRepo, f.packetPath) };
  });
  const build = readJson(f.reportPath).stages.assembly.build_fingerprint;
  assert.match(String(build), /^sha256:[a-f0-9]{64}$/, "setup: record build stamped the build fingerprint");
  return build;
}

// A rebuild: each named page's built file is rewritten with its new markup,
// the stub origin serves the new bytes, and `record build` records the new
// output. Returns the new build fingerprint.
export async function rebuildPages(site, pages) {
  for (const [name, html] of Object.entries(pages)) {
    assert.ok(site.names.includes(name), `setup: ${name} is a built page of the site`);
    writeFileSync(join(site.f.targetRepo, "_site", SLUG, name, "index.html"), html);
    site.same.serve(routeOf(name), respond("200 OK", "text/html; charset=utf-8", html));
  }
  return recordBuild(site.f);
}

// One real `polish capture` (the CLI command function with the existing
// createBrowserAdapter seam, src/cli.mjs:2710-2713) over the site, through
// the loopback-guarded launcher. Returns the command result (or the error it
// refused with) and the report it left.
//
// API assumption (F2.4-I49 and the shared capture of
// src/polish-readability.browser.test.mjs): `probeClock` is passed to the
// command in process, beside the existing deadline options, and reaches the
// readability probe the way capturePolishPageLoad's probeClock reaches the
// image probe (src/polish-node.mjs:565, :642-644). `networkIdleMs`, when
// given, shortens the adapter's network-idle window (5 s in production).
export async function capturePolish(site, { probeClock, onLaunch, networkIdleMs } = {}) {
  const { polishCaptureCommand } = await import("./cli.mjs");
  const { createPolishBrowserAdapter } = await import("./polish-browser.mjs");
  const guard = loopbackGuard();
  const chromium = {
    async launch(options) {
      const { chromium: real } = await import("playwright");
      const browser = guard.instrument(await real.launch(options));
      onLaunch?.(browser);
      return browser;
    },
  };
  let result = null;
  let error = null;
  try {
    result = await polishCaptureCommand(
      { _: ["polish", "capture"], packet: site.f.packetPath, "base-url": `${site.same.origin}/` },
      { createBrowserAdapter: (options) => createPolishBrowserAdapter({ ...options, chromium, networkIdleTimeoutMs: networkIdleMs }), ...(probeClock ? { probeClock } : {}) },
    );
  } catch (thrown) {
    error = thrown;
  }
  guard.assertLoopbackOnly();
  assertNoNetworkAttempts();
  return { result, error, report: readJson(site.f.reportPath) };
}

// Setup check for every capture that is not all-stock: the command completed
// (BASE_SHA does too) and attached page_load for the mapped page.
export function assertCaptureCompleted(capture) {
  assert.equal(capture.error, null, `setup: polish capture completed (${capture.error?.message})`);
  assert.equal(capture.result?.ok, true, `setup: polish capture reports ok (${JSON.stringify(capture.result?.checkpoint)?.slice(0, 300)})`);
  assert.equal(capture.report.stages.polish?.evidence?.visual_review?.page_load?.performed_by, "campaigns-os polish capture", "setup: page_load is attached");
}

// The package-owned readability record the capture attached (contract 2.4
// Record, stages.polish.evidence.visual_review.readability).
export function readabilityRecord(report) {
  const record = report?.stages?.polish?.evidence?.visual_review?.readability;
  assert.ok(record && typeof record === "object" && !Array.isArray(record), `polish capture attached visual_review.readability (visual_review keys: ${JSON.stringify(Object.keys(report?.stages?.polish?.evidence?.visual_review || {}))})`);
  assert.equal(record.schema_version, READABILITY_SCHEMA, "the record carries its schema_version");
  return record;
}

// The record's cells for one built page, both viewports, exactly.
export function cellsOf(record, name) {
  const cells = (record.cells || []).filter((cell) => cell?.route === routeOf(name));
  assert.deepEqual(cells.map((cell) => cell.viewport).sort(), [...VIEWPORTS].sort(), `the record holds one cell per viewport for ${routeOf(name)}`);
  return Object.fromEntries(cells.map((cell) => [cell.viewport, cell]));
}

// Every readability.contrast result as every reader sees it:
// readCurrentQcResults with the registry's real rules and the real doctor
// run (whose output fingerprint must read pass: the capture changed no
// built file).
export async function readabilityRows(site) {
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const rederivers = await loadQcRederivers();
  const { readCurrentQcResults } = await import("./qc-results.mjs");
  const doctor = doctorOf(site.f.packetPath);
  assert.equal(doctor.derived?.build_output_fingerprint?.status, "pass", "setup: the built output is the one record build recorded");
  const { results } = readCurrentQcResults({
    report: readJson(site.f.reportPath),
    doctor,
    spec: readJson(site.f.specPath),
    targetRepo: site.f.targetRepo,
    packetPath: site.f.packetPath,
    rederivers,
  });
  return results.filter((row) => row?.check === CHECK);
}

// A page's rows (both viewports) whose key passes `keep`, projected to
// {viewport, key, result, reason_code} and sorted. Pair keys compare in
// lower case.
export function pageRows(rows, name, keep = () => true) {
  return rows
    .filter((row) => row?.subject?.page === routeOf(name) && keep(String(row?.subject?.key ?? "")))
    .map((row) => ({ viewport: row.subject.viewport, key: String(row.subject.key).startsWith("pair:") ? String(row.subject.key).toLowerCase() : row.subject.key, result: row.result, reason_code: row.reason_code }))
    .sort((a, b) => `${a.viewport}|${a.key}`.localeCompare(`${b.viewport}|${b.key}`));
}

// The expected row in both viewports.
export const both = (row) => VIEWPORTS.map((viewport) => ({ viewport, ...row })).sort((a, b) => `${a.viewport}|${a.key}`.localeCompare(`${b.viewport}|${b.key}`));
