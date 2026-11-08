// #730 milestone 1: saved Assembly Reports produced by `record build` and
// `record baseline` BEFORE the doctor shared-input refactor (base
// e1c5bc9c6dc2745d6f2bd54f37f89319ce7f915a).
//
// The fixture is src/page-only-change.test.mjs's synthetic recorded campaign.
// The test drives the real record path through a fixed sequence of edits and,
// after each step, compares the full assembly-report.json, the evidence-debt
// change list, changeSince for the stage anchors and readback's evidence_debt
// with the captures in fixtures/doctor-golden/assembly-reports/. Those
// captures are the compatibility baseline for the #730 port of
// buildCommerceSignature, classifyDrift and the record/readback callers: a
// refactor PR must reproduce them, never regenerate them. Each capture is
// compared as parsed values (for a readable diff) and then byte for byte, so
// key order and formatting are pinned too. UPDATE_GOLDEN=1 with
// GOLDEN_BASE_SHA=<commit> rewrites them, which is only for a deliberate,
// reviewed behavior change.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildManifestEntries, computeBuildFingerprint } from "./built-site-scope.mjs";
import { changeSince } from "./change-scope.mjs";
import { assessEvidenceDebt } from "./evidence-debt.mjs";
import { runReadbackCommand } from "./readback.mjs";
import { recordStageCommand } from "./stage-record.mjs";

// The commit the saved captures were taken from. A capture records the
// commit named by GOLDEN_BASE_SHA when it is regenerated, never this
// constant, so a reviewed regeneration must also update this value and the
// README by hand.
const BASE_SHA = "e1c5bc9c6dc2745d6f2bd54f37f89319ce7f915a";
const GOLDEN_DIR = fileURLToPath(new URL("../fixtures/doctor-golden/assembly-reports/", import.meta.url));
const UPDATING = process.env.UPDATE_GOLDEN === "1";
// A CI run that rewrote the captures would compare the tree with itself and pass.
if (UPDATING && process.env.CI) {
  throw new Error("change-scope-v1-reports: UPDATE_GOLDEN=1 is refused while CI is set; regenerate locally and read the diff before committing.");
}
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SLUG = "synthetic-campaign";
const TEMP_PLACEHOLDER = "<fixture>";

// The PAGES fixture from src/page-only-change.test.mjs:25-30, copied byte for byte.
const PAGES = Object.freeze({
  landing: `<!doctype html><html><head><meta name="next-page-type" content="product"></head><body><h1>Landing headline</h1><a href="../checkout/">Order now</a></body></html>\n`,
  checkout: `<!doctype html><html><head><meta name="next-page-type" content="checkout"></head><body><h1>Checkout</h1><form data-next-checkout="form"><button type="submit">Pay</button></form></body></html>\n`,
  upsell1: `<!doctype html><html><head><meta name="next-page-type" content="upsell"><meta name="next-upsell-accept-url" content="../receipt/"></head><body><h1>Add a second bottle</h1><div data-next-package-id="12"><button data-next-upsell-action="add">Yes</button></div></body></html>\n`,
  receipt: `<!doctype html><html><head><meta name="next-page-type" content="receipt"></head><body><h1>Thank you</h1></body></html>\n`,
});

// The recorded campaign of src/page-only-change.test.mjs:32-81, with its
// first record build left to the sequence.
function seedCampaign(root) {
  const output = join(root, "_site", SLUG);
  const writePage = (page, html) => {
    mkdirSync(join(output, page), { recursive: true });
    writeFileSync(join(output, page, "index.html"), html);
  };
  for (const [page, html] of Object.entries(PAGES)) writePage(page, html);
  mkdirSync(join(root, "_data"), { recursive: true });
  const config = { [SLUG]: { sdk_version: "0.4.40", store_name: "Synthetic Store" } };
  const writeConfig = () => writeFileSync(join(root, "_data", "campaigns.json"), JSON.stringify(config));
  writeConfig();
  writeFileSync(join(root, "missing-spec.json"), JSON.stringify({}));
  mkdirSync(join(root, "src", SLUG), { recursive: true });
  const original = computeBuildFingerprint(output);
  const packet = {
    schema_version: "campaign-runtime-build-packet/v0",
    campaign: { public_route_slug: SLUG },
    spec: { map_id: "synthetic-map", local_path: "missing-spec.json" },
    assembly: { target_repo: ".", output_dir: `src/${SLUG}` },
  };
  const packetPath = join(root, "campaign-runtime.build.json");
  writeFileSync(packetPath, JSON.stringify(packet));
  const report = {
    schema_version: "campaign-runtime-assembly-report/v0",
    run_id: "synthetic-run", generated_at: "2026-10-23T00:00:00Z", status: "prepared",
    identity: { map_id: "synthetic-map", public_route_slug: SLUG, campaign_directory: SLUG, live_url_path: `/${SLUG}/`, spec_hash: "synthetic-spec" },
    inputs: { packet_path: "campaign-runtime.build.json", context_path: ".campaign-runtime/build-context.json", spec_path: "missing-spec.json", source: { kind: "html_funnel", root: "source" }, target_repo: "." },
    template_family: { value: "olympus", locked: true },
    decisions: [], evidence: [], blockers: [], warnings: [],
    next: { stage: "build", owner: "build", action: "Record build" },
    stages: {},
  };
  for (const key of ["prepare_build", "doctor", "setup", "assembly", "polish", "deploy", "qa"]) report.stages[key] = { stage: key, status: "completed" };
  Object.assign(report.stages.assembly, { build_fingerprint: original.fingerprint, build_manifest: buildManifestEntries(original) });
  Object.assign(report.stages.polish, { source_build_fingerprint: original.fingerprint });
  Object.assign(report.stages.qa, {
    evidence: { qc_build_fingerprint: original.fingerprint, qc_results: [] },
    purchase_proof: { order_paths_executed: 3, declared_depth: "common" },
  });
  mkdirSync(join(root, ".campaign-runtime"), { recursive: true });
  const reportPath = join(root, ".campaign-runtime", "assembly-report.json");
  writeFileSync(reportPath, JSON.stringify(report));
  return { root, output, packet, packetPath, reportPath, writePage, config, writeConfig, original };
}

// The steps, in order, each run against the state the previous one left.
const STEPS = [
  { step: "01-initial-record-build", description: "First record build over the seeded campaign: the output equals the seeded manifest, so the signature is computed and no build_changes entry is added." },
  { step: "02-copy-only-landing", description: "Copy-only edit to the landing headline, then record build: a page_only rebuild." },
  { step: "03-css-asset-added", description: "A CSS file added at assets/site.css, then record build: an unmapped file, so commerce_affecting." },
  { step: "04-checkout-copy-edit", description: "Copy-only edit to the checkout headline, then record build: a checkout page is commerce whatever its hash says." },
  { step: "05-upsell-package-ref", description: "The upsell's data-next-package-id changed from 12 to 14, then record build: commerce_markup_changed." },
  { step: "06-config-and-output-change", description: "The campaign's _data/campaigns.json entry changed (sdk_version 0.4.41) together with a landing copy edit, then record build: campaign_config_changed." },
  { step: "07-unchanged-rebuild", description: "record build with no output change: the signature is recomputed and build_changes is kept as it was." },
  { step: "08-pre-1-62-rebuild", description: "commerce_signature deleted from the report (a record from before Campaigns OS 1.62), a copy-only receipt edit, then record build: the rebuild is read without hashes and carries the pathless commerce_signature_unavailable reason." },
  { step: "09-record-baseline", description: "record baseline over the pre-1.62 rebuild: Polish and QA read baseline_accepted and report.commerce_baseline is written." },
  { step: "10-post-baseline-copy-only", description: "Copy-only edit to the landing headline after the baseline, then record build: a page_only rebuild read against the accepted baseline." },
  { step: "11-second-baseline-refused", refused: true, description: "A second record baseline on the same funnel: refused, a funnel gets one baseline, and the report is left byte for byte as it was." },
];

// The commit a regenerated capture names. Required, so a regeneration can
// never stamp the pre-refactor base onto output from a later tree.
function captureBaseSha() {
  if (!UPDATING) return BASE_SHA;
  const sha = process.env.GOLDEN_BASE_SHA ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("UPDATE_GOLDEN=1 needs GOLDEN_BASE_SHA=<the full 40-character commit whose behavior is being captured>, "
      + "with no uncommitted change under src/. Regenerate only for a deliberate, reviewed behavior change.");
  }
  assertSourceMatches(sha);
  return sha;
}

// The non-test source on disk must be exactly the source at `sha`, so the
// commit a capture names is the code that produced it.
function assertSourceMatches(sha) {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
  try {
    git("cat-file", "-e", `${sha}^{commit}`);
  } catch {
    throw new Error(`GOLDEN_BASE_SHA ${sha} is not a commit in this repository.`);
  }
  const source = ["--", "src", ":(exclude)*.test.mjs"];
  const changed = [git("diff", "--name-only", sha, ...source), git("ls-files", "--others", "--exclude-standard", ...source)].join("").trim();
  if (changed) throw new Error(`src/ differs from GOLDEN_BASE_SHA ${sha}; capture only from that commit's source:\n${changed}`);
}

function stepTime(index) {
  return new Date(Date.UTC(2026, 10, 1, 0, index + 1, 0));
}

// Every string in `value` with the temp-dir prefix replaced, and the paths
// that were replaced, so the test can report whether any appeared.
function normalizeTempPaths(value, prefixes, seen) {
  if (typeof value === "string") {
    let out = value;
    for (const prefix of prefixes) {
      if (out.includes(prefix)) {
        seen.add(prefix);
        out = out.split(prefix).join(TEMP_PLACEHOLDER);
      }
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeTempPaths(item, prefixes, seen));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [normalizeTempPaths(key, prefixes, seen), normalizeTempPaths(item, prefixes, seen)]));
  }
  return value;
}

function runSequence(t) {
  const root = mkdtempSync(join(tmpdir(), "campaigns-os-change-scope-reports-"));
  const privateRoot = mkdtempSync(join(tmpdir(), "campaigns-os-change-scope-private-"));
  // Same hermetic environment as src/doctor-golden.test.mjs: no sibling private
  // families, no private allowlist and no campaign key from the shell.
  const envKeys = ["PRIVATE_TEMPLATE_SOURCES_ROOT", "PRIVATE_TEMPLATE_SOURCES_PATH", "CAMPAIGNS_API_KEY"];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  for (const key of envKeys) delete process.env[key];
  process.env.PRIVATE_TEMPLATE_SOURCES_ROOT = privateRoot;
  globalThis.fetch = () => { throw new Error("change-scope-v1-reports: no network in the saved-report sequence"); };
  t.after(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    globalThis.fetch = savedFetch;
    rmSync(root, { recursive: true, force: true });
    rmSync(privateRoot, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:00.000Z") });

  const f = seedCampaign(root);
  const prefixes = [...new Set([realpathSync(root), root])].sort((a, b) => b.length - a.length);
  const readReport = () => JSON.parse(readFileSync(f.reportPath, "utf8"));
  const writeReport = (report) => writeFileSync(f.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const edits = {
    "01-initial-record-build": () => {},
    "02-copy-only-landing": () => f.writePage("landing", PAGES.landing.replace("Landing headline", "A new landing headline")),
    "03-css-asset-added": () => {
      mkdirSync(join(f.output, "assets"), { recursive: true });
      writeFileSync(join(f.output, "assets", "site.css"), "h1 { color: #0a2540; }\n");
    },
    "04-checkout-copy-edit": () => f.writePage("checkout", PAGES.checkout.replace("<h1>Checkout</h1>", "<h1>Secure checkout</h1>")),
    "05-upsell-package-ref": () => f.writePage("upsell1", PAGES.upsell1.replace('data-next-package-id="12"', 'data-next-package-id="14"')),
    "06-config-and-output-change": () => {
      f.config[SLUG].sdk_version = "0.4.41";
      f.writeConfig();
      f.writePage("landing", PAGES.landing.replace("Landing headline", "Landing headline, third draft"));
    },
    "07-unchanged-rebuild": () => {},
    "08-pre-1-62-rebuild": () => {
      const report = readReport();
      delete report.stages.assembly.commerce_signature;
      writeReport(report);
      f.writePage("receipt", PAGES.receipt.replace("Thank you", "Thank you for your order"));
    },
    "09-record-baseline": () => {},
    "10-post-baseline-copy-only": () => f.writePage("landing", PAGES.landing.replace("Landing headline", "Landing headline, after the baseline")),
    "11-second-baseline-refused": () => {},
  };
  const argsFor = (step) => step === "09-record-baseline" || step === "11-second-baseline-refused"
    ? { _: ["record", "baseline"], packet: f.packetPath, "accepted-by": "Morgan Lee", reason: "Synthetic pre-1.62 funnel accepted for the #730 characterization." }
    : { _: ["record", "build"], packet: f.packetPath };
  const anchorsFor = (report, previousBuild) => {
    const anchors = {
      seeded_build: f.original.fingerprint,
      previous_step_build: previousBuild,
      polish_owed_since: report.stages.polish?.owed_since_build_fingerprint ?? null,
      qa_evidence_build: report.stages.qa?.evidence?.qc_build_fingerprint ?? report.stages.qa?.evidence?.source_build_fingerprint ?? null,
    };
    return anchors;
  };
  const changeSinceAll = (report, debt, anchors) => Object.fromEntries(Object.entries(anchors).map(([label, anchor]) => [label, {
    anchor,
    result: changeSince(anchor, { assembly: report.stages.assembly, drift: debt.changes, driftClassification: { kind: debt.changes.kind, reasons: debt.changes.reasons } }),
  }]));

  const baseSha = captureBaseSha();
  const captures = [];
  const seen = new Set();
  let previousBuild = readReport().stages.assembly.build_fingerprint;
  STEPS.forEach(({ step, description, refused }, index) => {
    const now = stepTime(index);
    t.mock.timers.setTime(now.getTime());
    edits[step]();
    const beforeReport = readReport();
    const beforeDebt = assessEvidenceDebt({ packet: f.packet, packetPath: f.packetPath, report: beforeReport });
    const beforeAnchors = anchorsFor(beforeReport, previousBuild);
    const before = { evidence_debt_changes: beforeDebt.changes, change_since: changeSinceAll(beforeReport, beforeDebt, beforeAnchors) };
    const bytesBefore = readFileSync(f.reportPath, "utf8");
    let refusal = null;
    if (refused) {
      assert.throws(() => recordStageCommand(argsFor(step), { now: () => now }), (error) => {
        refusal = error.message;
        return true;
      }, `setup: ${step} is refused`);
      assert.equal(readFileSync(f.reportPath, "utf8"), bytesBefore, `${step}: a refused record leaves assembly-report.json byte for byte as it was`);
    } else {
      const result = recordStageCommand(argsFor(step), { now: () => now });
      assert.equal(result.ok, true, `setup: ${step} records (${JSON.stringify(result).slice(0, 400)})`);
    }
    const reportText = readFileSync(f.reportPath, "utf8");
    assert.equal(reportText, `${JSON.stringify(JSON.parse(reportText), null, 2)}\n`,
      `${step}: assembly-report.json is written as two-space JSON with a trailing newline`);
    const report = readReport();
    const debt = assessEvidenceDebt({ packet: f.packet, packetPath: f.packetPath, report });
    const readback = runReadbackCommand({ _: ["readback", f.root], json: true });
    assert.equal(readback.exitCode, 0, `setup: ${step} readback exits 0`);
    const capture = {
      base_sha: baseSha,
      step,
      description,
      recorded_at: now.toISOString(),
      record_command: argsFor(step)._.join(" "),
      assembly_report: report,
      evidence_debt_changes: debt.changes,
      change_since: changeSinceAll(report, debt, anchorsFor(report, previousBuild)),
      readback_evidence_debt: JSON.parse(readback.text).evidence_debt,
      before_record: before,
      ...(refused ? { refusal } : {}),
    };
    captures.push(normalizeTempPaths(capture, prefixes, seen));
    previousBuild = report.stages.assembly.build_fingerprint;
  });
  return { captures, normalizedPrefixes: [...seen] };
}

test("saved pre-refactor Assembly Reports: record build, readback and evidence debt reproduce the #730 captures", (t) => {
  const started = performance.now();
  const { captures, normalizedPrefixes } = runSequence(t);
  // The captures hold no machine path today; one appearing is a change to report, not to normalize away.
  assert.deepEqual(normalizedPrefixes, [], "a temp-dir path appeared in a capture (key or value)");
  t.diagnostic(`sequence wall time ${Math.round(performance.now() - started)} ms`);

  // Sanity on the sequence itself, so a capture can never silently record a
  // step that did not do what its description says.
  const latestChange = (index) => captures[index].assembly_report.stages.assembly.build_changes?.at(-1);
  assert.equal(captures[0].assembly_report.stages.assembly.commerce_signature.algorithm, "commerce-signature/v1", "step 1 keeps a v1 signature");
  assert.equal(captures[0].assembly_report.stages.assembly.build_changes, undefined, "step 1 adds no build_changes");
  assert.equal(latestChange(1).kind, "page_only", "step 2 is page-only");
  assert.deepEqual(latestChange(2).reasons, [{ code: "unmapped_file", path: "assets/site.css" }], "step 3 reads the CSS asset");
  assert.deepEqual(latestChange(3).reasons, [{ code: "checkout_page", path: "checkout/index.html" }], "step 4 reads a checkout page");
  assert.deepEqual(latestChange(4).reasons, [{ code: "commerce_markup_changed", path: "upsell1/index.html" }], "step 5 reads the package ref");
  assert.deepEqual(latestChange(5).reasons, [{ code: "campaign_config_changed" }], "step 6 reads the config change");
  assert.deepEqual(captures[6].assembly_report.stages.assembly.build_changes, captures[5].assembly_report.stages.assembly.build_changes, "step 7 keeps build_changes");
  assert.deepEqual(captures[6].assembly_report.stages.assembly.commerce_signature, captures[5].assembly_report.stages.assembly.commerce_signature, "step 7 recomputes the same signature");
  assert.deepEqual(latestChange(7).reasons, [{ code: "commerce_signature_unavailable" }], "step 8 reads the rebuild without hashes");
  assert.ok(captures[7].assembly_report.stages.assembly.commerce_signature, "step 8 keeps hashes from here on");
  assert.equal(captures[8].assembly_report.commerce_baseline?.accepted_by, "Morgan Lee", "step 9 writes the baseline");
  assert.equal(captures[8].assembly_report.stages.qa.status, "baseline_accepted");
  assert.equal(latestChange(9).kind, "page_only", "step 10 is page-only after the baseline");
  assert.deepEqual(latestChange(9).reasons, [], "step 10 has no commerce reason");
  assert.equal(captures[9].before_record.evidence_debt_changes.kind, "page_only", "step 10 reads page-only on disk before the record");
  assert.deepEqual(captures[9].assembly_report.commerce_baseline, captures[8].assembly_report.commerce_baseline, "step 10 keeps the baseline");
  const step10Qa = captures[9].readback_evidence_debt.qa;
  assert.equal(step10Qa.scope, "pages", "step 10: QA owes only the changed pages");
  assert.deepEqual(step10Qa.owed_pages, [{ page_id: "landing", built_path: "landing/index.html" }], "step 10: the landing page is owed");
  assert.equal(step10Qa.change.since_build_fingerprint, captures[8].assembly_report.commerce_baseline.build_fingerprint, "step 10: the change is read from the baseline build");
  assert.equal(step10Qa.baseline?.accepted_by, "Morgan Lee", "step 10: readback carries the baseline");
  assert.match(captures[10].refusal, /^record baseline refused; nothing was written:\n- Morgan Lee accepted a baseline for this funnel at 2026-11-01T00:09:00\.000Z, and a funnel gets one\./,
    "step 11 is refused because the funnel already has a baseline");
  assert.deepEqual(captures[10].assembly_report, captures[9].assembly_report, "step 11 leaves the report as step 10 wrote it");

  if (UPDATING) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    for (const capture of captures) writeFileSync(join(GOLDEN_DIR, `${capture.step}.json`), `${JSON.stringify(capture, null, 2)}\n`);
  }
  for (const capture of captures) {
    const file = join(GOLDEN_DIR, `${capture.step}.json`);
    const savedText = readFileSync(file, "utf8");
    const saved = JSON.parse(savedText);
    assert.equal(saved.base_sha, BASE_SHA, `${capture.step}: the saved capture names ${saved.base_sha}, not BASE_SHA ${BASE_SHA}. `
      + "After a reviewed regeneration, update BASE_SHA and the README to the GOLDEN_BASE_SHA it was captured from.");
    for (const key of ["assembly_report", "evidence_debt_changes", "change_since", "readback_evidence_debt", "before_record", "refusal"]) {
      assert.deepEqual(capture[key], saved[key],
        `${capture.step}.${key} differs from fixtures/doctor-golden/assembly-reports/${capture.step}.json. These captures predate the #730 refactor `
        + "and must be reproduced exactly; do not regenerate them to make a refactor pass. Regenerate (UPDATE_GOLDEN=1 GOLDEN_BASE_SHA=<commit> node --test src/change-scope-v1-reports.test.mjs) "
        + "only for a deliberate, reviewed behavior change, and read the diff.");
    }
    assert.deepEqual(capture, saved, `${capture.step}: the whole capture, including step metadata`);
    assert.equal(`${JSON.stringify(capture, null, 2)}\n`, savedText,
      `${capture.step}: the capture must equal fixtures/doctor-golden/assembly-reports/${capture.step}.json byte for byte, `
      + "so persisted key order is part of v1. Do not regenerate it to make a refactor pass.");
  }
});
