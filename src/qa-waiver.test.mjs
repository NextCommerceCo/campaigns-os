// Packet 01 (qa-capture-target-and-purchase-waiver), waiver-lane commit.
// The one unwaivable blocker in the estate — analytics-correctness:
// purchase-fires — gains a named, attributed waiver lane (ratified I-9/I-16):
// `qa waive` records who/why/when on the Assembly Report's qa stage, the
// correctness leg downgrades the FAILING blocker to WARN with that
// attribution, and the disposition becomes ready_with_exceptions, never
// plain ready. The two mandatory negative controls prove the lane is not a
// mask: an unwaived failure still blocks, before and after the machinery
// exists.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { qaWaive, __qaNodeTestHooks } from "./qa-node.mjs";
import { assessAnalyticsInventory, assessReceiptPurchase } from "./qa-analytics-correctness.mjs";
import { normalizeCapture } from "./qa-analytics-parity.mjs";
import { computeDisposition, SEVERITY, STATUS } from "./qa-verdict.mjs";

const { resolveQaWaivers } = __qaNodeTestHooks;

const WAIVABLE = "analytics-correctness:purchase-fires";

const byId = (assertions) => Object.fromEntries(assertions.map((a) => [a.id, a]));

// A capture with NO purchase fire from any source (dataLayer, Meta, GA4).
function noPurchaseCapture() {
  return normalizeCapture({ events: [], tagFires: [] });
}

// A contract that makes purchase-fires (and only it) the failing blocker.
const PURCHASE_ONLY_CONTRACT = { manual_events: [{ event: "dl_purchase", page: "receipt", trigger: "page-load" }] };

function assessPurchase(capture, waivers = {}) {
  return [assessReceiptPurchase({
    plannedPlanIds: ["accept-decline"],
    attempts: [{
      planId: "accept-decline",
      receiptRecognized: true,
      receiptUrl: "https://shop.example/receipt/?ref_id=redacted",
      capture,
    }],
  }, { waivers })];
}

// Minimal packet + Assembly Report pair on disk, mirroring the shapes
// prepare-build writes (target_repo "." keeps the report packet-adjacent, the
// same location resolveQaWaivers reads).
function writeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "qa-waiver-"));
  const packetPath = join(dir, "campaign-runtime.build.json");
  writeFileSync(packetPath, JSON.stringify({
    schema_version: "campaign-runtime.build/v0",
    campaign: { public_route_slug: "waiver-fixture" },
    assembly: { target_repo: "." },
  }, null, 2));
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  const reportPath = join(dir, ".campaign-runtime", "assembly-report.json");
  writeFileSync(reportPath, JSON.stringify({
    schema_version: "campaign-runtime-assembly-report/v0",
    run_id: "fixture-run",
    generated_at: "2026-08-17T00:00:00.000Z",
    status: "in_progress",
    stages: { qa: { stage: "qa", status: "pending", inputs: [], outputs: [], commands: [], blockers: [], warnings: [] } },
    evidence: [],
  }, null, 2));
  return { dir, packetPath, reportPath };
}

test("waiver round-trip: qa waive records attribution, the failing blocker downgrades to WARN, disposition is ready_with_exceptions", () => {
  const { packetPath, reportPath } = writeFixture();
  const result = qaWaive({
    _: ["qa", "waive"],
    packet: packetPath,
    assertion: WAIVABLE,
    reason: "The named operator accepts this receipt's missing Purchase signal for the current run.",
    "waived-by": "devin@local",
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, "qa-waive");
  assert.equal(result.assertion, WAIVABLE);

  // The record on disk mirrors report.theme.waiver: { reason, waived_by, waived_at }.
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const stored = report.stages.qa.waivers[WAIVABLE];
  assert.equal(stored.waived_by, "devin@local");
  assert.match(stored.reason, /missing Purchase signal/);
  assert.match(stored.waived_at, /^\d{4}-\d{2}-\d{2}T/);
  // Human-readable trace on the report evidence ledger, like theme waive.
  assert.ok(report.evidence.some((line) => line.includes(WAIVABLE) && line.includes("devin@local")));

  // The QA run's read path picks the waiver up from the same report...
  const waivers = resolveQaWaivers({ packetPath });
  assert.deepEqual(Object.keys(waivers), [WAIVABLE]);

  // ...and the correctness leg downgrades the failing blocker WITH attribution.
  const assertions = assessPurchase(noPurchaseCapture(), waivers);
  const purchase = byId(assertions)[WAIVABLE];
  assert.equal(purchase.status, STATUS.FAIL);
  assert.equal(purchase.severity, SEVERITY.WARN);
  assert.equal(purchase.waiver.waived_by, "devin@local");
  assert.equal(purchase.waiver.reason, stored.reason);
  assert.equal(purchase.waiver.waived_at, stored.waived_at);
  assert.match(purchase.actual, /waived by devin@local/);

  // Waived blocker => ready_with_exceptions, never blocked, never plain ready.
  assert.equal(computeDisposition(assertions), "ready_with_exceptions");
});

test("qa waive refuses without --reason (mirrors themeWaive)", () => {
  const { packetPath } = writeFixture();
  assert.throws(
    () => qaWaive({ _: ["qa", "waive"], packet: packetPath, assertion: WAIVABLE }),
    /--reason/,
  );
});

test("qa waive refuses assertions outside the scoped lane with a clear error", () => {
  const { packetPath } = writeFixture();
  for (const outside of ["analytics-correctness:tag:gtm", "analytics-parity:purchase-present", "theme_gate.blocked", "*"]) {
    assert.throws(
      () => qaWaive({ _: ["qa", "waive"], packet: packetPath, assertion: outside, reason: "nope" }),
      /does not accept --assertion .*scoped to exactly: analytics-correctness:purchase-fires/s,
      `expected refusal for ${outside}`,
    );
  }
});

test("qa waive refuses when no assembly report exists yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-waiver-noreport-"));
  const packetPath = join(dir, "campaign-runtime.build.json");
  writeFileSync(packetPath, JSON.stringify({ campaign: { public_route_slug: "x" }, assembly: { target_repo: "." } }));
  assert.throws(
    () => qaWaive({ _: ["qa", "waive"], packet: packetPath, assertion: WAIVABLE, reason: "r" }),
    /assembly report/,
  );
});

test("qa waive defaults waived-by to a named identity ($USER@local or operator)", () => {
  const { packetPath, reportPath } = writeFixture();
  qaWaive({ _: ["qa", "waive"], packet: packetPath, assertion: WAIVABLE, reason: "default identity check" });
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const expected = process.env.USER ? `${process.env.USER}@local` : "operator";
  assert.equal(report.stages.qa.waivers[WAIVABLE].waived_by, expected);
});

// NEGATIVE CONTROL (mandatory, packet 01): a failing purchase-fires with NO
// waiver recorded still emits a BLOCKER and a blocked disposition — through
// the same report read path a real run uses, so the machinery's existence
// cannot mask the failure.
test("negative control: failing purchase-fires with no waiver still blocks", () => {
  const { packetPath } = writeFixture();
  const waivers = resolveQaWaivers({ packetPath }); // report exists, nothing waived
  assert.deepEqual(waivers, {});
  const assertions = assessPurchase(noPurchaseCapture(), waivers);
  const purchase = byId(assertions)[WAIVABLE];
  assert.equal(purchase.status, STATUS.FAIL);
  assert.equal(purchase.severity, SEVERITY.BLOCKER);
  assert.equal(purchase.waiver, undefined);
  assert.equal(computeDisposition(assertions), "blocked");
});

// SECOND NEGATIVE CONTROL (mandatory): after the waiver machinery exists, an
// unwaived failure still blocks — the lane must not become a default. Junk on
// the report (foreign assertion ids, reason-less records) never waives.
test("negative control: the lane never becomes a default — foreign or malformed report entries do not waive", () => {
  const { packetPath, reportPath } = writeFixture();
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  report.stages.qa.waivers = {
    "analytics-correctness:tag:gtm": { reason: "outside the lane", waived_by: "devin@local", waived_at: "2026-08-17T00:00:00.000Z" },
    [WAIVABLE]: { waived_by: "devin@local", waived_at: "2026-08-17T00:00:00.000Z" }, // no reason => invalid
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const waivers = resolveQaWaivers({ packetPath });
  assert.deepEqual(waivers, {}, "foreign ids and reason-less records are inert data");
  const assertions = assessPurchase(noPurchaseCapture(), waivers);
  const purchase = byId(assertions)[WAIVABLE];
  assert.equal(purchase.severity, SEVERITY.BLOCKER);
  assert.equal(computeDisposition(assertions), "blocked");
});

test("a purchase-fires waiver downgrades ONLY purchase-fires — other blockers still block", () => {
  const waivers = { [WAIVABLE]: { reason: "accepted", waived_by: "devin@local", waived_at: "2026-08-17T00:00:00.000Z" } };
  const contract = { ...PURCHASE_ONLY_CONTRACT, providers: { gtm: { enabled: true, containerId: "GTM-MISSING" } } };
  const assertions = [
    ...assessAnalyticsInventory(noPurchaseCapture(), contract),
    ...assessPurchase(noPurchaseCapture(), waivers),
  ];
  const a = byId(assertions);
  assert.equal(a[WAIVABLE].severity, SEVERITY.WARN, "waived blocker downgrades");
  assert.equal(a["analytics-correctness:tag:gtm"].severity, SEVERITY.BLOCKER, "unwaived blocker keeps blocking");
  assert.equal(computeDisposition(assertions), "blocked");
});

test("a stale waiver on a PASSING purchase-fires is inert: no attribution, disposition can stay ready", () => {
  const waivers = { [WAIVABLE]: { reason: "stale", waived_by: "devin@local", waived_at: "2026-08-17T00:00:00.000Z" } };
  const capture = normalizeCapture({
    events: [{ layer: "dataLayer", data: { event: "dl_purchase", ecommerce: { value: 1, currency: "USD", transaction_id: "t1" } } }],
    tagFires: [],
  });
  const assertions = assessPurchase(capture, waivers);
  const purchase = byId(assertions)[WAIVABLE];
  assert.equal(purchase.status, STATUS.PASS);
  assert.equal(purchase.severity, undefined, "passing receipt proof does not carry a failure severity");
  assert.equal(purchase.waiver, undefined);
  assert.equal(computeDisposition(assertions), "ready");
});

test("computeDisposition: any assertion carrying a waiver record yields ready_with_exceptions, never plain ready", () => {
  const waived = {
    id: WAIVABLE,
    family: "analytics-correctness",
    page: "analytics",
    status: STATUS.FAIL,
    severity: SEVERITY.WARN,
    waiver: { reason: "accepted", waived_by: "devin@local", waived_at: "2026-08-17T00:00:00.000Z" },
    expected: "purchase fires",
    actual: "waived",
  };
  const pass = { id: "p", family: "analytics-correctness", page: "analytics", status: STATUS.PASS, expected: "x", actual: "x" };
  assert.equal(computeDisposition([pass, waived]), "ready_with_exceptions");
  // Belt-and-braces invariant: even a pathological PASS assertion that carries
  // a waiver record keeps the run out of plain ready.
  assert.equal(computeDisposition([{ ...pass, waiver: waived.waiver }]), "ready_with_exceptions");
  // And a waiver record never masks an unrelated blocker.
  const blocker = { id: "b", family: "analytics-correctness", page: "analytics", status: STATUS.FAIL, severity: SEVERITY.BLOCKER, expected: "x", actual: "y" };
  assert.equal(computeDisposition([waived, blocker]), "blocked");
});
