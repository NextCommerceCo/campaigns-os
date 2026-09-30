// The per-page source-provenance waiver (#534), end to end through the packet
// doctor path and `campaigns-os checkpoint waive`: a Figma-typed page whose
// approved source is hand-written HTML can clear the Figma-provenance
// blockers under a named, bounded human decision, while every other source
// check keeps its severity. Only entry points that exist before the gate was
// registered are imported, so on a base without it every test fails on its
// behavioural assertion, not on a missing module.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkpointWaive, nextStage, parseArgs } from "./cli.mjs";
import { doctorPacket } from "./doctor/inspect.mjs";
// A namespace import, so a base without the export still links this file.
import * as progressNode from "./progress-node.mjs";

const SOURCE_PROVENANCE_SCOPE = "source_html.producer_provenance";
const EXAMPLES = new URL("../examples/", import.meta.url);
const FIGMA_URL = "https://www.figma.com/design/abc/Render?node-id=1-2";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// The Figma-export family a hand-written page is waived for: the provenance
// codes and the export's file inventory.
const FIGMA_EXPORT_FILE_CODES = ["source_html.files.partial", "source_html.files.asset"];
// Every finding a bare hand-written manifest raises for one Figma-typed page.
const BARE_MANIFEST_CODES = [
  SOURCE_PROVENANCE_SCOPE,
  `${SOURCE_PROVENANCE_SCOPE}.material_fingerprint`,
  `${SOURCE_PROVENANCE_SCOPE}.screenshot_fallback_used`,
  `${SOURCE_PROVENANCE_SCOPE}.section_exports`,
  `${SOURCE_PROVENANCE_SCOPE}.semantic_section_count`,
  `${SOURCE_PROVENANCE_SCOPE}.source_type`,
  ...FIGMA_EXPORT_FILE_CODES,
].sort();

// The shipped example tree with a bare, hand-written source-html manifest
// (only `role: page` files, no producer_provenance) and a Figma design_source
// on the named pages. `extraPages` adds that many more Figma-typed pages.
function fixture({ figmaPages = ["landing"], files = null, generator = "hand-written", extraPages = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "source-provenance-"));
  for (const file of ["build-packet.basic.json", "campaignspec.v42.basic.json"]) {
    cpSync(new URL(file, EXAMPLES), join(dir, file));
  }
  cpSync(new URL("source-html", EXAMPLES), join(dir, "source-html"), { recursive: true });
  cpSync(new URL("target-page-kit", EXAMPLES), join(dir, "target-page-kit"), { recursive: true });
  mkdirSync(join(dir, "contracts"), { recursive: true });
  cpSync(new URL("../contracts/commerce-surface-catalog.json", import.meta.url), join(dir, "contracts/commerce-surface-catalog.json"));

  const packetPath = join(dir, "build-packet.basic.json");
  const packet = readJson(packetPath);
  packet.assembly.commerce_catalog.path = "contracts/commerce-surface-catalog.json";
  packet.assembly.commerce_catalog.required = false;
  writeJson(packetPath, packet);

  const specPath = join(dir, "campaignspec.v42.basic.json");
  const spec = readJson(specPath);
  for (const funnel of spec.funnels) {
    for (const page of funnel.pages) {
      if (figmaPages.includes(page.id)) page.design_source = { type: "figma", file_url: FIGMA_URL };
    }
  }
  const template = spec.funnels[0].pages.find((page) => page.id === "landing");
  for (let index = 1; index <= extraPages; index += 1) {
    spec.funnels[0].pages.push({
      ...structuredClone(template),
      id: `offer-${index}`,
      order: 100 + index,
      is_entry: false,
      page_url: `offer-${index}/`,
      design_source: { type: "figma", file_url: FIGMA_URL },
    });
  }
  writeJson(specPath, spec);

  const sourceRoot = join(dir, "source-html");
  const manifestPath = join(sourceRoot, ".campaigns-os/source-html-manifest.json");
  writeJson(manifestPath, {
    schema_version: "source-html-manifest/v0",
    generator,
    files: files || packet.source_html.pages.map((page) => ({
      path: page.path,
      role: "page",
      sha256: createHash("sha256").update(readFileSync(join(sourceRoot, page.path))).digest("hex"),
    })),
    pages: packet.source_html.pages.map((page) => ({ page_id: page.page_id, path: page.path })),
  });

  const targetRepo = join(dir, "target-page-kit");
  const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
  const report = readJson(new URL("assembly-report.example.json", EXAMPLES));
  report.identity.map_id = packet.spec.map_id;
  report.identity.public_route_slug = packet.campaign.public_route_slug;
  report.stages.deploy.status = "skipped";
  report.evidence = [];
  writeJson(reportPath, report);
  return { dir, packetPath, specPath, sourceRoot, reportPath };
}

function inDir(options, run) {
  const paths = fixture(options);
  try {
    return run(paths);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
}

const isProvenance = (issue) => issue.code === SOURCE_PROVENANCE_SCOPE || issue.code.startsWith(`${SOURCE_PROVENANCE_SCOPE}.`)
  || FIGMA_EXPORT_FILE_CODES.includes(issue.code);
const provenanceErrors = (doctor) => doctor.errors.filter(isProvenance);
const provenanceWarnings = (doctor) => doctor.warnings.filter((issue) => isProvenance(issue) && issue.code !== `${SOURCE_PROVENANCE_SCOPE}.waiver_inert`);
const gateFor = (doctor, pageId) => doctor.derived.checkpoint_gates.find((gate) => gate.id === SOURCE_PROVENANCE_SCOPE && gate.subject.page_id === pageId);

function waiveArgs(packetPath, page, extra = {}) {
  return {
    _: ["checkpoint", "waive"],
    packet: packetPath,
    gate: SOURCE_PROVENANCE_SCOPE,
    page,
    reason: "The approved source is hand-written HTML; the Figma file only renders it.",
    "waived-by": "Jordan Lee",
    "expires-at": new Date(Date.now() + 7 * 86_400_000).toISOString(),
    ...extra,
  };
}

// A waiver the test expects to be recorded. A refusal (on a base without the
// gate: "Unknown checkpoint gate") is an assertion failure.
function waive(packetPath, page, extra = {}) {
  try {
    return checkpointWaive(waiveArgs(packetPath, page, extra));
  } catch (error) {
    assert.fail(`checkpoint waive refused ${SOURCE_PROVENANCE_SCOPE} --page ${page}: ${error.message}`);
  }
}

test("a waiver re-emits the Figma-provenance blockers as waived warnings; expired or unparseable, they block again", () => {
  inDir({}, ({ packetPath, reportPath }) => {
    const before = doctorPacket(packetPath);
    assert.deepEqual(
      provenanceErrors(before).map((issue) => issue.code).sort(),
      BARE_MANIFEST_CODES,
      "negative control: a bare hand-written manifest raises the six provenance codes and the export file inventory",
    );
    assert.deepEqual(before.errors.map((issue) => issue.code).sort(), BARE_MANIFEST_CODES, "those eight are doctor's only blockers");
    assert.equal(gateFor(before, "landing")?.status, "blocked");
    assert.deepEqual(gateFor(before, "landing")?.state.findings, BARE_MANIFEST_CODES);

    const result = waive(packetPath, "landing");
    assert.equal(result.ok, true);
    assert.equal(result.page, "landing");
    assert.equal(result.status, "ready_with_waivers");

    const after = doctorPacket(packetPath);
    assert.deepEqual(after.errors, [], "the eight blockers no longer block");
    assert.equal(after.ok, true);
    assert.equal(after.status, "ready_with_waivers");
    const warned = provenanceWarnings(after);
    assert.deepEqual(
      warned.map((issue) => issue.code).sort(),
      provenanceErrors(before).map((issue) => issue.code).sort(),
      "every blocker is still reported, as a warning",
    );
    assert.ok(warned.every((issue) => issue.detail?.waived === true && issue.detail.page_id === "landing" && issue.detail.waiver.waived_by === "Jordan Lee"));
    assert.equal(gateFor(after, "landing")?.status, "waived");

    const report = readJson(reportPath);
    report.waivers[0].waived_at = "2026-01-01T00:00:00.000Z";
    report.waivers[0].expires_at = "2026-02-01T00:00:00.000Z";
    writeJson(reportPath, report);
    const expired = doctorPacket(packetPath);
    assert.deepEqual(provenanceErrors(expired).map((issue) => issue.code).sort(), provenanceErrors(before).map((issue) => issue.code).sort());
    assert.deepEqual(provenanceWarnings(expired), []);
    assert.equal(gateFor(expired, "landing")?.waiver_assessment.inert_counts.expired, 1);

    report.waivers[0].expires_at = "next spring";
    writeJson(reportPath, report);
    const unparseable = doctorPacket(packetPath);
    assert.ok(provenanceErrors(unparseable).length > 0);
    assert.equal(gateFor(unparseable, "landing")?.waiver_assessment.inert_counts.malformed, 1);
    assert.ok(unparseable.warnings.some((issue) => issue.code === `${SOURCE_PROVENANCE_SCOPE}.waiver_inert`));
  });
});

test("a waiver is per page: page A's findings are waived warnings while page B's stay errors", () => {
  inDir({ figmaPages: ["landing", "checkout"] }, ({ packetPath }) => {
    const before = doctorPacket(packetPath);
    const codes = [...new Set(provenanceErrors(before).map((issue) => issue.code))].sort();
    assert.ok(codes.length > 0, "negative control: both pages lack Figma provenance");

    waive(packetPath, "landing");
    const partial = doctorPacket(packetPath);
    assert.equal(gateFor(partial, "landing")?.status, "waived");
    assert.equal(gateFor(partial, "checkout")?.status, "blocked");
    assert.equal(partial.status, "blocked");
    const forPage = (issues, pageId) => issues.filter((issue) => issue.detail?.page_id === pageId).map((issue) => issue.code).sort();
    assert.deepEqual(forPage(provenanceWarnings(partial), "landing"), codes, "page A's findings are re-emitted as warnings");
    assert.ok(provenanceWarnings(partial).every((issue) => issue.detail?.waived === true && issue.detail.page_id === "landing"));
    assert.deepEqual(forPage(provenanceErrors(partial), "checkout"), codes, "page B's findings stay errors");
    assert.equal(provenanceErrors(partial).length, codes.length, "no error names the waived page");
    assert.equal(partial.warnings.some((issue) => issue.code === `${SOURCE_PROVENANCE_SCOPE}.waiver_inert`), false, "another page's waiver is not inert history");

    waive(packetPath, "checkout");
    const both = doctorPacket(packetPath);
    assert.deepEqual(provenanceErrors(both), []);
    assert.deepEqual(forPage(provenanceWarnings(both), "landing"), codes);
    assert.deepEqual(forPage(provenanceWarnings(both), "checkout"), codes);
  });
});

test("a manifest whose generator claims figma-sections-export is refused a page waiver and reports the gate blocked", () => {
  inDir({ generator: "figma-sections-export@1.0.0" }, ({ packetPath, reportPath }) => {
    const before = readFileSync(reportPath, "utf8");
    assert.throws(
      () => checkpointWaive(waiveArgs(packetPath, "landing")),
      /cannot be waived for page "landing": the source-html manifest's generator claims figma-sections-export/,
    );
    assert.throws(() => checkpointWaive(waiveArgs(packetPath, "landing", { "dry-run": true })), /generator claims figma-sections-export/);
    assert.equal(readFileSync(reportPath, "utf8"), before, "nothing recorded");
    const doctor = doctorPacket(packetPath);
    const gate = gateFor(doctor, "landing");
    assert.equal(gate?.status, "blocked");
    assert.equal(gate.code, `${SOURCE_PROVENANCE_SCOPE}.exporter_claim`);
    assert.equal(gate.waivable, false);
    assert.deepEqual(gate.required_actions.map((action) => action.id), ["repair_target"]);
    assert.ok(provenanceErrors(doctor).length > 0);
    assert.ok(provenanceErrors(doctor).every((issue) => issue.detail?.generator === "figma-sections-export@1.0.0"));
    assert.deepEqual(provenanceWarnings(doctor), []);
  });
});

test("a waiver recorded before the manifest claimed figma-sections-export is inert and the gate blocks with its remediation", () => {
  inDir({}, ({ packetPath, sourceRoot }) => {
    waive(packetPath, "landing");
    const manifestPath = join(sourceRoot, ".campaigns-os/source-html-manifest.json");
    writeJson(manifestPath, { ...readJson(manifestPath), generator: "figma-sections-export@1.0.0" });
    const doctor = doctorPacket(packetPath);
    const gate = gateFor(doctor, "landing");
    assert.equal(gate?.status, "blocked", "never waived under an exporter claim");
    assert.equal(gate.waiver, null);
    assert.ok(gate.required_actions.length > 0, "the remediation is reported");
    const inert = doctor.warnings.find((issue) => issue.code === `${SOURCE_PROVENANCE_SCOPE}.waiver_inert`);
    assert.equal(inert?.detail.counts.exporter_claim, 1);
    assert.equal(doctor.status, "blocked");
    const next = nextStage(null, { packet: packetPath, _: [], "no-write": true });
    const nextGate = next.gates.find((candidate) => candidate.id === SOURCE_PROVENANCE_SCOPE && candidate.subject?.page_id === "landing");
    assert.equal(nextGate?.status, "blocked");
  });
});

test("under an exporter claim an expired waiver is counted once, as exporter_claim, not also as expired", () => {
  inDir({}, ({ packetPath, sourceRoot, reportPath }) => {
    waive(packetPath, "landing");
    const report = readJson(reportPath);
    report.waivers[0].waived_at = "2026-01-01T00:00:00.000Z";
    report.waivers[0].expires_at = "2026-02-01T00:00:00.000Z";
    writeJson(reportPath, report);
    const manifestPath = join(sourceRoot, ".campaigns-os/source-html-manifest.json");
    writeJson(manifestPath, { ...readJson(manifestPath), generator: "figma-sections-export@1.0.0" });
    const doctor = doctorPacket(packetPath);
    const inert = doctor.warnings.find((issue) => issue.code === `${SOURCE_PROVENANCE_SCOPE}.waiver_inert`);
    assert.deepEqual(inert?.detail.counts, { stale: 0, foreign: 0, malformed: 0, expired: 0, no_figma_source: 0, exporter_claim: 1 });
    assert.match(inert.message, /contains 1 inert record\(s\)/);
    assert.deepEqual(gateFor(doctor, "landing")?.waiver_assessment.inert_counts, { stale: 0, foreign: 0, malformed: 0, expired: 0 });
  });
});

test("a generator naming figma-sections-export in any form is an exporter claim no page waiver clears", () => {
  inDir({}, ({ packetPath, sourceRoot }) => {
    waive(packetPath, "landing");
    const manifestPath = join(sourceRoot, ".campaigns-os/source-html-manifest.json");
    const manifest = readJson(manifestPath);
    for (const generator of [
      "figma-sections-export",
      "figma-sections-export@1.0.0",
      "  figma-sections-export@2.1.0  ",
      "Figma-Sections-Export",
      "FIGMA-SECTIONS-EXPORT@3",
    ]) {
      writeJson(manifestPath, { ...manifest, generator });
      const doctor = doctorPacket(packetPath);
      assert.ok(provenanceErrors(doctor).length > 0, `generator=${JSON.stringify(generator)}: the provenance family blocks`);
      assert.ok(provenanceErrors(doctor).every((issue) => issue.detail?.generator === generator.trim()), `generator=${JSON.stringify(generator)}`);
      assert.deepEqual(provenanceWarnings(doctor), [], `generator=${JSON.stringify(generator)}: nothing is waived`);
      assert.equal(doctor.status, "blocked", `generator=${JSON.stringify(generator)}`);
      assert.equal(gateFor(doctor, "landing")?.status, "blocked", `generator=${JSON.stringify(generator)}: the gate is not waived`);
    }
  });
});

test("every value-taking flag refuses a bare or empty value instead of coercing it", () => {
  inDir({}, ({ packetPath, reportPath }) => {
    const before = readFileSync(reportPath, "utf8");
    // The CLI parser reads a flag followed by another flag as boolean true; a
    // bare --review-condition must not become the waiver's only bound.
    const argv = ["checkpoint", "waive", "--packet", packetPath, "--gate", SOURCE_PROVENANCE_SCOPE, "--page", "landing",
      "--reason", "hand-written", "--waived-by", "Jordan Lee", "--review-condition", "--json"];
    assert.throws(() => checkpointWaive(parseArgs(argv)), /--review-condition needs a value/);
    for (const flag of ["review-condition", "report", "expires-at", "page", "packet", "gate", "reason", "waived-by"]) {
      for (const value of [true, "", "   "]) {
        const extra = flag === "review-condition" ? { "expires-at": undefined } : {};
        assert.throws(
          () => checkpointWaive(waiveArgs(packetPath, "landing", { ...extra, [flag]: value })),
          new RegExp(`--${flag}\\b`),
          `--${flag}=${JSON.stringify(value)} is refused by name`,
        );
      }
    }
    assert.equal(readFileSync(reportPath, "utf8"), before, "no refusal writes the report");
  });
});

test("the page scope is --page only: unknown pages, the <gate>:<page_id> form and a missing --page are refused", () => {
  inDir({}, ({ packetPath, reportPath }) => {
    const base = { _: ["checkpoint", "waive"], packet: packetPath, reason: "hand-written", "waived-by": "Jordan Lee", "review-condition": "a real export exists" };
    assert.throws(
      () => checkpointWaive({ ...base, gate: SOURCE_PROVENANCE_SCOPE, page: "no-such-page" }),
      /Page "no-such-page" has no source_html\.producer_provenance checkpoint.*Pages with this checkpoint now: landing\./,
    );
    assert.throws(
      () => checkpointWaive({ ...base, gate: SOURCE_PROVENANCE_SCOPE, page: "checkout" }),
      /Page "checkout" has no source_html\.producer_provenance checkpoint/,
      "a page without a Figma design source has no gate to waive",
    );
    assert.throws(
      () => checkpointWaive({ ...base, gate: `${SOURCE_PROVENANCE_SCOPE}:landing` }),
      /uses the <gate>:<page_id> form, which is not accepted; pass --gate source_html\.producer_provenance --page landing instead/,
    );
    assert.throws(
      () => checkpointWaive({ ...base, gate: SOURCE_PROVENANCE_SCOPE }),
      /is waived per page; pass --page <page_id>/,
    );
    // A bare --page (parsed as boolean true) or an empty one is refused, never
    // read as a page called "true".
    for (const page of [true, "", "   "]) {
      assert.throws(
        () => checkpointWaive({ ...base, gate: SOURCE_PROVENANCE_SCOPE, page }),
        /--page needs a value: pass --page <page_id>/,
        `page=${JSON.stringify(page)}`,
      );
    }
    assert.throws(
      () => checkpointWaive({ ...base, gate: "page_kit.sdk_version", page: "landing" }),
      /--page applies only to per-page checkpoint gates/,
    );
    assert.equal(readJson(reportPath).waivers ?? undefined, undefined, "nothing recorded");
  });
});

test("while waived, wrapper-policy and page-file findings keep blocking", () => {
  inDir({}, ({ packetPath, sourceRoot }) => {
    waive(packetPath, "landing");
    writeFileSync(join(sourceRoot, "landing.html"), "<!doctype html>\n<html><head><title>Offer</title></head><body><main>Offer</main></body></html>\n");
    rmSync(join(sourceRoot, "receipt.html"));
    const doctor = doctorPacket(packetPath);
    assert.equal(gateFor(doctor, "landing")?.status, "waived");
    assert.deepEqual(provenanceErrors(doctor), []);
    assert.deepEqual(provenanceWarnings(doctor).map((issue) => issue.code).sort(), BARE_MANIFEST_CODES, "the export family is re-emitted as warnings");
    const errors = doctor.errors.map((issue) => issue.code);
    assert.ok(errors.includes("source_html.prep.document_wrapper"), "document wrappers under strip_document_wrappers still block");
    assert.ok(errors.includes("source_html.pages.path"), "a mapped source file that is missing still blocks");
    assert.equal(doctor.status, "blocked");
  });
});

test("per-page gates follow the campaign-wide gates, so 20 Figma pages never push theme_gate or polish_gate out of the progress projection", () => {
  inDir({ extraPages: 19 }, ({ packetPath }) => {
    const next = nextStage(null, { packet: packetPath, _: [], "no-write": true });
    const ids = next.gates.map((gate) => gate.id);
    assert.equal(ids.filter((id) => id === SOURCE_PROVENANCE_SCOPE).length, 20);
    const firstPerPage = ids.indexOf(SOURCE_PROVENANCE_SCOPE);
    assert.ok(ids.slice(firstPerPage).every((id) => id === SOURCE_PROVENANCE_SCOPE), "per-page gates come last");
    const limit = progressNode.PROGRESS_GATE_LIMIT;
    assert.ok(Number.isInteger(limit) && limit > 0 && limit < ids.length, "the progress projection truncates this gate list");
    const projected = ids.slice(0, limit);
    for (const id of ["doctor", "prepare_build", "theme_gate", "polish_gate", ...ids.slice(0, firstPerPage)]) {
      assert.ok(projected.includes(id), `${id} is inside the ${limit}-gate progress projection`);
    }
  });
});

test("a waiver for a page that no longer has a Figma design source is reported as waiver_inert", () => {
  inDir({}, ({ packetPath, specPath }) => {
    waive(packetPath, "landing");
    const spec = readJson(specPath);
    for (const funnel of spec.funnels) for (const page of funnel.pages) delete page.design_source;
    writeJson(specPath, spec);

    const doctor = doctorPacket(packetPath);
    const inert = doctor.warnings.find((issue) => issue.code === `${SOURCE_PROVENANCE_SCOPE}.waiver_inert`);
    assert.ok(inert, "inert history is a warning");
    assert.equal(doctor.errors.some((issue) => issue.code === `${SOURCE_PROVENANCE_SCOPE}.waiver_inert`), false);
    assert.equal(inert.detail.counts.no_figma_source, 1);
    assert.deepEqual(inert.detail.pages, ["landing"]);
    assert.match(inert.message, /inert record\(s\); stale, foreign, malformed, and expired decisions.*never satisfy the current checkpoint/);
  });
});

test("the shared waiver rules hold for the new gate: named human, one bound, --dry-run writes nothing", () => {
  inDir({}, ({ packetPath, reportPath }) => {
    const before = readFileSync(reportPath, "utf8");
    assert.throws(() => checkpointWaive(waiveArgs(packetPath, "landing", { "waived-by": "operator" })), /placeholders are not accepted/);
    assert.throws(() => checkpointWaive(waiveArgs(packetPath, "landing", { "expires-at": undefined })), /requires at least one of expires_at or review_condition/);
    const dry = waive(packetPath, "landing", { "dry-run": true });
    assert.equal(dry.status, "dry_run");
    assert.equal(dry.page, "landing");
    assert.equal(dry.waiver.subject.page_id, "landing");
    assert.equal(readFileSync(reportPath, "utf8"), before, "no refusal and no dry run writes the report");
    assert.equal(existsSync(reportPath), true);
  });
});

test("the missing-mapping message for a Figma page names the waiver route beside the exporter route", () => {
  inDir({}, ({ packetPath }) => {
    const packet = readJson(packetPath);
    packet.source_html.pages = packet.source_html.pages.filter((page) => page.page_id !== "landing");
    writeJson(packetPath, packet);
    const coverage = doctorPacket(packetPath).errors.find((issue) => issue.code === "source_html.pages.coverage" && issue.detail?.page_id === "landing");
    assert.ok(coverage, "the unmapped Figma page is reported");
    assert.match(coverage.message, /the exporter that produced the design emits it/);
    assert.match(coverage.message, /hand-written HTML.*checkpoint waive --packet <packet> --gate source_html\.producer_provenance --page landing /);
  });
});
