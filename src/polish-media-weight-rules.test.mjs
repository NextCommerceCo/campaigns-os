// The 1.3 rules (src/polish-media-weight.mjs) and the media_weight subjects
// the Polish reader accepts beyond resources, videos and probed images: an
// <img> with no ledger entry, an image-free cell, a cell whose probe did not
// complete, and a spec page Polish did not capture. Synthetic stored records
// from src/qc-test-factories.mjs, read through readMediaWeight with the real
// rules.
import assert from "node:assert/strict";
import test from "node:test";

import { MEDIA_WEIGHT_QC_RULES, evaluateMediaWeight } from "./polish-media-weight.mjs";
import { loadQcRederivers } from "./qc-check-registry.mjs";
import { readMediaWeight } from "./qc-results.mjs";
import { BUILD_FP, ORIGIN, ROUTES, VIEWPORT, mediaWeightFixture, resourceIdOf, withRecomputedIntegrity } from "./qc-test-factories.mjs";

const HERO = "/runtime-packet-demo/img/hero.jpg";
const HERO_KEY = resourceIdOf(`${ORIGIN}${HERO}`);
const UNCAPTURED = "/runtime-packet-demo/unmapped/";

async function read({ record, pageLoad }) {
  const rederivers = await loadQcRederivers({ legs: ["polish"] });
  return readMediaWeight({ record, pageLoad, currentBuild: BUILD_FP, rederivers });
}

const sorted = (rows) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const summary = (results) => sorted(results.map((row) => [row.subject.page, row.subject.key, row.check, row.result, row.reason_code, row.accept_eligible]));
const sameRows = (results, expected) => assert.deepEqual(summary(results), sorted(expected));

function heroCell(edit) {
  const evidence = mediaWeightFixture({ cells: [{ route: ROUTES[0], resources: [{ path: HERO, bytes: 300_000 }] }] });
  edit(evidence.record.cells[0], evidence.record);
  evidence.record = withRecomputedIntegrity(evidence.record);
  return evidence;
}

test("object-fit scale-down and none follow the scale table at the observed pixel ratio", () => {
  const cell = (fit, rendered, dpr = 1) => ({
    route: ROUTES[0],
    viewport: "desktop",
    dpr,
    capture_status: "complete",
    probe_status: "complete",
    resources: [],
    videos: [],
    images: [{ resource_id: null, element_path: "body>img:nth-of-type(1)", complete: true, natural: [1000, 1000], rendered, object_fit: fit, loading: "eager", hidden: false }],
  });
  const oversize = (value) => evaluateMediaWeight(value).find((row) => row.check === "media.oversize");
  // scale-down never enlarges: s = min(1, contain) = 0.25, F = 4.
  assert.deepEqual([oversize(cell("scale-down", [250, 250])).result, oversize(cell("scale-down", [250, 250])).reason_code], ["warning", "image_oversized"]);
  // none renders at natural size: s = 1, F = 1 at DPR 1 and 0.5 at DPR 2.
  assert.equal(oversize(cell("none", [10, 10])).result, "pass");
  assert.equal(oversize(cell("none", [10, 10], 2)).result, "pass");
  // DPR 2 halves F: contain at s = 0.25 gives F = 2, still oversized.
  assert.equal(oversize(cell("contain", [250, 250], 2)).result, "warning");
  assert.equal(oversize(cell("contain", [500, 500], 2)).result, "pass");
});

test("a completed probe without image geometry does not re-derive; a probe that did not complete keeps each image's identity with null geometry", async () => {
  const complete = heroCell((cell) => Object.assign(cell.images[0], { natural: null }));
  sameRows(await read(complete), [
    [ROUTES[0], HERO_KEY, "media.weight", "unexercised", "evidence_not_reproducible", false],
    [ROUTES[0], `${HERO_KEY}:body>img:nth-of-type(1)`, "media.oversize", "unexercised", "evidence_not_reproducible", false],
  ]);
  const discarded = heroCell((cell) => {
    cell.probe_status = "probe_timeout";
    Object.assign(cell.images[0], { complete: null, natural: null, rendered: null, object_fit: null, hidden: null });
  });
  sameRows(await read(discarded), [
    [ROUTES[0], HERO_KEY, "media.weight", "unexercised", "probe_timeout", false],
    [ROUTES[0], `${HERO_KEY}:body>img:nth-of-type(1)`, "media.oversize", "unexercised", "probe_timeout", false],
  ]);
});

test("a probe cost cap adds the page_coverage member to every result kept for the cell: none reads pass and none is accept-eligible", async () => {
  const cappedCell = (status, images) => {
    const evidence = mediaWeightFixture({ cells: [{ route: ROUTES[0], resources: [{ path: HERO, bytes: 600_000 }, { path: "/runtime-packet-demo/img/small.png", bytes: 30_000 }] }] });
    const cell = evidence.record.cells[0];
    cell.probe_status = status;
    if (images === "none") cell.images = [];
    else for (const image of cell.images) Object.assign(image, { complete: null, natural: null, rendered: null, object_fit: null, hidden: null });
    evidence.record = withRecomputedIntegrity(evidence.record);
    return evidence;
  };
  const SMALL_KEY = resourceIdOf(`${ORIGIN}/runtime-packet-demo/img/small.png`);
  // The run budget was spent before the cell started: no <img> was listed.
  // Each status: the cap code, and whether the cell lists its images.
  for (const [status, images] of [["probe_budget_exhausted", "none"], ["probe_timeout", "listed"], ["image_cap_reached", "listed"]]) {
    const results = await read(cappedCell(status, images));
    const member = [{ key: "page_coverage", result: "unexercised", reason_code: status }];
    for (const row of results) {
      assert.deepEqual(row.members, member, `${status} ${row.check} ${row.subject.key}: the page_coverage member with the cap code`);
      assert.equal(row.accept_eligible, false, `${status} ${row.check} ${row.subject.key}: not accept-eligible`);
      assert.notEqual(row.result, "pass", `${status} ${row.check} ${row.subject.key}: never pass`);
    }
    const oversize = images === "none"
      ? [[ROUTES[0], "cell", "media.oversize", "unexercised", status, false]]
      : [HERO_KEY, SMALL_KEY].map((key, index) => [ROUTES[0], `${key}:body>img:nth-of-type(${index + 1})`, "media.oversize", "unexercised", status, false]);
    // The 600,000 B same-origin image keeps its warning (members aggregate
    // warning > review > unexercised > pass), which the unexercised member
    // makes ineligible; the 30,000 B image would pass and reads unexercised.
    sameRows(results, [
      [ROUTES[0], HERO_KEY, "media.weight", "warning", "image_over_threshold", false],
      [ROUTES[0], SMALL_KEY, "media.weight", "unexercised", status, false],
      ...oversize,
    ]);
  }
});

test("an image-free cell lists one oversize result keyed cell; an <img> with no ledger entry reads weight not_in_ledger", async () => {
  const imageFree = heroCell((cell) => { cell.images = []; });
  sameRows(await read(imageFree), [
    [ROUTES[0], "cell", "media.oversize", "pass", null, false],
    [ROUTES[0], HERO_KEY, "media.weight", "pass", null, false],
  ]);
  const unledgered = heroCell((cell) => {
    cell.images.push({ resource_id: null, element_path: "body>img:nth-of-type(2)", complete: true, natural: [40, 30], rendered: [40, 30], object_fit: "fill", loading: "eager", hidden: false });
  });
  sameRows(await read(unledgered), [
    [ROUTES[0], "img:body>img:nth-of-type(2)", "media.weight", "unexercised", "not_in_ledger", false],
    [ROUTES[0], "null:body>img:nth-of-type(2)", "media.oversize", "pass", null, false],
    [ROUTES[0], HERO_KEY, "media.weight", "pass", null, false],
    [ROUTES[0], `${HERO_KEY}:body>img:nth-of-type(1)`, "media.oversize", "pass", null, false],
  ]);
});

test("an uncaptured spec page reads page_not_captured only where page_load records a selected route scope and the route was not captured", async () => {
  const withUncaptured = (scope, routes) => {
    const evidence = mediaWeightFixture({ cells: [{ route: ROUTES[0], resources: [{ path: HERO, bytes: 300_000 }] }] });
    evidence.pageLoad.subject.route_scope = scope;
    evidence.record = withRecomputedIntegrity({ ...evidence.record, subject: { ...evidence.record.subject, route_scope: scope }, uncaptured_routes: routes });
    return evidence;
  };
  sameRows(await read(withUncaptured("selected", [UNCAPTURED])), [
    [ROUTES[0], HERO_KEY, "media.weight", "pass", null, false],
    [ROUTES[0], `${HERO_KEY}:body>img:nth-of-type(1)`, "media.oversize", "pass", null, false],
    [UNCAPTURED, "cell", "media.oversize", "unexercised", "page_not_captured", false],
    [UNCAPTURED, "cell", "media.weight", "unexercised", "page_not_captured", false],
  ]);
  const failed = [
    [ROUTES[0], HERO_KEY, "media.weight", "unexercised", "evidence_not_reproducible", false],
    [ROUTES[0], `${HERO_KEY}:body>img:nth-of-type(1)`, "media.oversize", "unexercised", "evidence_not_reproducible", false],
  ];
  // page_load captured every mapped page (route_scope all): nothing was skipped.
  sameRows(await read(withUncaptured("all", [UNCAPTURED])), failed);
  // A captured route cannot also be uncaptured.
  sameRows(await read(withUncaptured("selected", [ROUTES[0]])), failed);
});

// A cell whose final hop's request failed: the capture is incomplete, the
// final ledger entry records `statuses` and `failed_request_count` as given,
// and `edit` sets the chain's hop statuses.
async function failedHero({ statuses, failedCount, redirectFrom = null, edit }) {
  const { buildPolishCaptureIntegrity } = await import("./polish-capture.mjs");
  const evidence = mediaWeightFixture({ cells: [{ route: ROUTES[0], resources: [{ path: HERO, bytes: 0, failed: failedCount, redirectFrom }] }] });
  const capture = evidence.pageLoad.captures[0];
  Object.assign(capture.resource_ledger.entries.at(-1), { statuses, failed_request_count: failedCount });
  capture.problems = [{ code: "request_failed", count: 1 }];
  capture.measurement_status = "incomplete";
  capture.integrity = buildPolishCaptureIntegrity(capture);
  evidence.pageLoad.measurement = { ...evidence.pageLoad.measurement, status: "incomplete", incomplete: [{ route: ROUTES[0], viewport: VIEWPORT }] };
  const cell = evidence.record.cells[0];
  cell.page_load_integrity = capture.integrity.projection_fingerprint;
  cell.capture_status = "incomplete";
  cell.resources[0].failed = failedCount > 0;
  edit(cell.resources[0].chain);
  evidence.record = withRecomputedIntegrity(evidence.record);
  return evidence;
}

test("a final hop that failed with no HTTP response may carry status null; every other null status does not re-derive", async () => {
  const rows = (key, result, reason) => [
    [ROUTES[0], key, "media.weight", result, reason, false],
    [ROUTES[0], `${key}:body>img:nth-of-type(1)`, "media.oversize", result, reason, false],
  ];
  const nullFinal = (chain) => { chain.at(-1).status = null; };
  // (a) statuses [] and failed_request_count 1: the cell reads capture_incomplete.
  sameRows(await read(await failedHero({ statuses: [], failedCount: 1, edit: nullFinal })), rows(HERO_KEY, "unexercised", "capture_incomplete"));
  // (b) the final entry answered 200: a null status does not re-derive.
  sameRows(await read(await failedHero({ statuses: [200], failedCount: 1, edit: nullFinal })), rows(HERO_KEY, "unexercised", "evidence_not_reproducible"));
  // (c) a null status on a redirect hop does not re-derive, even when the final hop is the failed no-response one.
  const REDIRECT = "https://cdn.example.test/hero.jpg";
  sameRows(
    await read(await failedHero({ statuses: [], failedCount: 1, redirectFrom: REDIRECT, edit: (chain) => { chain[0].status = null; chain.at(-1).status = null; } })),
    rows(resourceIdOf(REDIRECT), "unexercised", "evidence_not_reproducible"),
  );
  // (d) statuses [] with no failed request: a null status does not re-derive.
  sameRows(await read(await failedHero({ statuses: [], failedCount: 0, edit: nullFinal })), rows(HERO_KEY, "unexercised", "evidence_not_reproducible"));
});

test("the registry resolves media.weight and media.oversize to MEDIA_WEIGHT_QC_RULES", async () => {
  const rederivers = await loadQcRederivers({ legs: ["polish"] });
  assert.equal(rederivers["media.weight"].status, "loaded");
  assert.equal(rederivers["media.weight"].rederive, MEDIA_WEIGHT_QC_RULES);
  assert.equal(rederivers["media.oversize"].rederive, MEDIA_WEIGHT_QC_RULES);
});

test("mergePolishCaptureEvidence attaches page_load and its media_weight together and refuses a foreign or unbound record", async () => {
  const { mergePolishCaptureEvidence } = await import("./polish-node.mjs");
  const { pageLoad, record } = mediaWeightFixture({ cells: [{ route: ROUTES[0], resources: [{ path: HERO, bytes: 300_000 }] }] });
  const report = {
    schema_version: "campaign-runtime-assembly-report/v0",
    stages: {
      assembly: { status: "completed", build_fingerprint: BUILD_FP },
      polish: { stage: "polish", evidence: { visual_review: { screenshots: ["kept.png"], media_weight: { stale: true } } } },
    },
  };
  const merged = mergePolishCaptureEvidence(report, { pageLoad, mediaWeight: record });
  assert.deepEqual(merged.stages.polish.evidence.visual_review, { screenshots: ["kept.png"], page_load: pageLoad, media_weight: record });
  assert.deepEqual(report.stages.polish.evidence.visual_review.media_weight, { stale: true }, "the input report is not mutated");
  assert.deepEqual(mergePolishCaptureEvidence(report, { pageLoad }).stages.polish.evidence.visual_review, { screenshots: ["kept.png"], page_load: pageLoad }, "a capture without media_weight drops the earlier record");
  assert.throws(() => mergePolishCaptureEvidence(report, { pageLoad, mediaWeight: { ...record, performed_by: "agent" } }), /package-produced media_weight/);
  assert.throws(() => mergePolishCaptureEvidence(report, { pageLoad, mediaWeight: { ...record, subject: { ...record.subject, routes: [ROUTES[1]] } } }), /same page_load capture/);
});

// A fake Chromium for one cell's image probe. Each probe step can be held
// `delays[step]` ms: listing (the isolated-world Runtime.evaluate), enable
// (Page.enable), evaluate (the probe's page.evaluate) and reread (the
// Page.getFrameTree after the probe); `during[step]` runs as the step starts.
// `worldDelay` holds Page.createIsolatedWorld, and `during.world` runs as it
// starts, once the listing's timer is armed. `calls` lists the probe steps
// that started, `methods` every CDP method sent and `sent` each with the time
// it was sent.
function probeChromium({ delays = {}, during = {}, worldDelay = 0 } = {}) {
  const calls = [];
  const methods = [];
  const sent = [];
  const hold = async (step) => {
    calls.push(step);
    during[step]?.();
    if (delays[step]) await new Promise((resolve) => setTimeout(resolve, delays[step]));
  };
  const listing = {
    dpr: 1,
    observed_count: 1,
    images: [{ element_path: "body>img:nth-of-type(1)", current_src: `${ORIGIN}${HERO}`, svg_data: false, loading: "auto" }],
  };
  const frame = { frameTree: { frame: { id: "main-frame", loaderId: "main-loader" } } };
  let frameTrees = 0;
  const session = {
    on() {},
    off() {},
    async send(method) {
      methods.push(method);
      sent.push({ method, at: performance.now() });
      if (method === "Page.createIsolatedWorld") {
        await null;
        during.world?.();
        if (worldDelay) await new Promise((resolve) => setTimeout(resolve, worldDelay));
        return { executionContextId: 1 };
      }
      if (method === "Runtime.evaluate") {
        await hold("listing");
        return { result: { value: listing } };
      }
      if (method === "Page.enable") return hold("enable");
      if (method === "Page.getFrameTree") {
        frameTrees += 1;
        // The first two are page_load's own reads; the third is the probe's.
        if (frameTrees > 2) await hold("reread");
        return frame;
      }
      return {};
    },
    async detach() {},
  };
  const page = {
    async goto() {},
    async waitForLoadState() {},
    url: () => `${ORIGIN}${ROUTES[0]}`,
    async evaluate(callback, argument) {
      if (!argument?.geometry) return { observed_element_count: 0, elements: [] };
      await hold("evaluate");
      return { ...listing, images: listing.images.map((image) => ({ ...image, complete: true, natural: [40, 30], rendered: [40, 30], object_fit: "fill", hidden: false })) };
    },
  };
  const chromium = {
    async launch() {
      return {
        async newContext() {
          return { async newPage() { return page; }, async newCDPSession() { return session; }, async close() {} };
        },
        async close() {},
      };
    },
  };
  return { chromium, calls, methods, sent };
}

async function probeCell(fake, imageProbe) {
  const { createPolishBrowserAdapter } = await import("./polish-browser.mjs");
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });
  try {
    const observation = await adapter.captureRoute({
      url: `${ORIGIN}${ROUTES[0]}`,
      viewport: { width: 1280, height: 800 },
      imageProbe: { remainingMs: 10_000, cellBoundMs: 100, imageCap: 512, listingBoundMs: 50, ...imageProbe },
    });
    return observation.imageProbe;
  } finally {
    await adapter.close();
  }
}

test("every image probe step runs inside the cell's bound and is charged to the run budget; a probe its bound ends never reads complete", async () => {
  const HELD = 1_000;
  const control = await probeCell(probeChromium(), {});
  assert.equal(control.status, "complete", "control: an unheld probe completes");

  // The cell bound (100 ms) ends a held Page.enable, the probe's evaluate or
  // the Page.getFrameTree re-read: probe_timeout, charged the bound (a timer
  // may fire a millisecond early), not the held step.
  for (const step of ["enable", "evaluate", "reread"]) {
    const probe = await probeCell(probeChromium({ delays: { [step]: HELD } }), {});
    assert.equal(probe.status, "probe_timeout", `${step}: the cell bound ended the probe`);
    assert.ok(probe.spent_ms >= 90 && probe.spent_ms < HELD, `${step}: spent ${probe.spent_ms} ms, about the bound and not the held step`);
    assert.deepEqual(probe.images.map((image) => image.element_path), ["body>img:nth-of-type(1)"], `${step}: the listing names the image`);
  }

  // The run budget left (20 ms) is the smaller bound: it bounds the listing
  // and every later step, and ending them reads probe_budget_exhausted.
  for (const step of ["listing", "enable", "evaluate", "reread"]) {
    const probe = await probeCell(probeChromium({ delays: { [step]: HELD } }), { remainingMs: 20 });
    assert.equal(probe.status, "probe_budget_exhausted", `${step}: the run budget ended the probe`);
    assert.ok(probe.spent_ms >= 15 && probe.spent_ms < HELD, `${step}: spent ${probe.spent_ms} ms, about the budget left and not the held step`);
  }

  // A step does not start once the bound has passed: Page.enable spends the
  // whole bound on the probe clock, so neither the evaluate nor the re-read
  // starts.
  let time = 0;
  const clock = { now: () => time, sleep: () => new Promise(() => {}) };
  const fake = probeChromium({ during: { enable: () => { time = 100; } } });
  const cut = await probeCell(fake, { clock });
  assert.equal(cut.status, "probe_timeout");
  assert.equal(cut.spent_ms, 100);
  assert.deepEqual(fake.calls, ["listing", "enable"], "no probe step starts after the bound passed");
});

test("a cell that starts once the run budget is spent starts no probe step: no CDP call, no listing, no images", async () => {
  // The CDP calls page_load makes on its own, with no image probe.
  const plain = probeChromium();
  const { createPolishBrowserAdapter } = await import("./polish-browser.mjs");
  const adapter = await createPolishBrowserAdapter({ chromium: plain.chromium });
  try {
    await adapter.captureRoute({ url: `${ORIGIN}${ROUTES[0]}`, viewport: { width: 1280, height: 800 } });
  } finally {
    await adapter.close();
  }
  for (const remainingMs of [0, -250]) {
    const fake = probeChromium();
    const probe = await probeCell(fake, { remainingMs });
    assert.deepEqual(probe, { status: "probe_budget_exhausted", dpr: null, images: [], spent_ms: 0 }, `${remainingMs} ms left: the budget ended before the cell`);
    assert.deepEqual(fake.calls, [], `${remainingMs} ms left: no probe step started`);
    assert.deepEqual(fake.methods, plain.methods, `${remainingMs} ms left: no CDP call beyond page_load's own`);
  }
});

test("a probe step its bound ends is cancelled: a listing whose Page.createIsolatedWorld settles late sends no Runtime.evaluate or any later command", async () => {
  const WORLD_HELD = 650;
  const fake = probeChromium({ worldDelay: WORLD_HELD });
  const { createPolishBrowserAdapter } = await import("./polish-browser.mjs");
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });
  let probe;
  let boundEndedAt;
  try {
    const observation = await adapter.captureRoute({
      url: `${ORIGIN}${ROUTES[0]}`,
      viewport: { width: 1280, height: 800 },
      imageProbe: { remainingMs: 20, cellBoundMs: 100, imageCap: 512, listingBoundMs: 50 },
    });
    boundEndedAt = performance.now();
    probe = observation.imageProbe;
  } finally {
    await adapter.close();
  }
  assert.equal(probe.status, "probe_budget_exhausted", "the run budget left ended the listing");
  assert.ok(probe.spent_ms >= 15 && probe.spent_ms < WORLD_HELD, `spent ${probe.spent_ms} ms, about the budget left and not the held step`);
  assert.deepEqual(probe.images, [], "the cut listing names no image");

  // Let the held Page.createIsolatedWorld settle, and its continuation run.
  await new Promise((resolve) => setTimeout(resolve, WORLD_HELD + 100));
  const world = fake.sent.findIndex((entry) => entry.method === "Page.createIsolatedWorld");
  assert.ok(world >= 0, "the listing started");
  assert.ok(fake.sent[world].at < boundEndedAt);
  assert.deepEqual(fake.sent.filter((entry) => entry.at >= boundEndedAt), [], "no CDP command is sent after the bound");
  assert.ok(!fake.methods.includes("Runtime.evaluate"), "the listing's Runtime.evaluate is never sent");
  assert.deepEqual(fake.methods.slice(world), ["Page.createIsolatedWorld"], "no probe command follows the cut listing");
  assert.deepEqual(fake.calls, [], "no probe step started after the listing");
});

// Each CDP command a probe issues, with the probe step that holds it.
const PROBE_COMMAND_STEPS = ["world", "listing", "enable", "evaluate", "reread"];

test("a step that settles past its bound on the probe clock, before any timer fires, issues nothing more", async () => {
  // The run budget left (20 ms) or the cell bound (100 ms) is the bound; the
  // step moves the probe clock past it and settles at once, so neither the
  // listing's timer nor the probe's deadline has fired.
  for (const [remainingMs, past, status] of [[20, 25, "probe_budget_exhausted"], [10_000, 105, "probe_timeout"]]) {
    for (const step of PROBE_COMMAND_STEPS) {
      let time = 0;
      const clock = { now: () => time, sleep: () => new Promise(() => {}) };
      let mark;
      const fake = probeChromium({ during: { [step]: () => {
        time = past;
        mark = { methods: fake.methods.length, calls: fake.calls.length };
      } } });
      const probe = await probeCell(fake, { clock, remainingMs });
      const label = `${step} settles at ${past} ms on the probe clock`;
      assert.equal(probe.status, status, `${label}: the bound ended the probe`);
      assert.equal(probe.spent_ms, past, `${label}: charged the probe clock`);
      assert.deepEqual(fake.methods.slice(mark.methods), [], `${label}: no CDP command after the bound`);
      assert.deepEqual(fake.calls.slice(mark.calls), [], `${label}: no probe step after the bound`);
    }
  }
});

test("a step whose completion delays timer servicing past its bound issues nothing more", async () => {
  // The step blocks the event loop 40 ms, past the run budget left (20 ms),
  // so its continuation runs before the bound's timer is serviced.
  const BLOCKED = 40;
  for (const step of PROBE_COMMAND_STEPS) {
    let passedAt;
    let mark;
    const fake = probeChromium({ during: { [step]: () => {
      const until = performance.now() + BLOCKED;
      while (performance.now() < until);
      passedAt = performance.now();
      mark = { methods: fake.methods.length, calls: fake.calls.length };
    } } });
    const probe = await probeCell(fake, { remainingMs: 20 });
    // Let any late continuation run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(probe.status, "probe_budget_exhausted", `${step}: the run budget ended the probe`);
    assert.ok(probe.spent_ms >= BLOCKED, `${step}: spent ${probe.spent_ms} ms, the blocked step`);
    assert.deepEqual(fake.sent.filter((entry) => entry.at >= passedAt), [], `${step}: no CDP command after the bound`);
    assert.deepEqual(fake.methods.slice(mark.methods), [], `${step}: no CDP command after the step`);
    assert.deepEqual(fake.calls.slice(mark.calls), [], `${step}: no probe step after the bound`);
  }
});
