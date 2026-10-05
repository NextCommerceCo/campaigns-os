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
// `delays[step]` ms: tree (DOM.getDocument), read (the isolated-world
// Runtime.callFunctionOn) and reread (the Page.getFrameTree after the read);
// `during[step]` runs as the step starts. `worldDelay` holds
// Page.createIsolatedWorld, and `during.world` runs as it starts, once the
// probe's deadline is armed. `calls` lists the probe steps that started,
// `methods` every CDP method sent and `sent` each with the time it was sent.
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
      if (method === "DOM.getDocument") {
        await hold("tree");
        return { root: { nodeId: 1, backendNodeId: 1, children: [] } };
      }
      if (method === "Runtime.callFunctionOn") {
        await hold("read");
        return { result: { value: { ...listing, images: listing.images.map((image) => ({ ...image, complete: true, natural: [40, 30], rendered: [40, 30], object_fit: "fill", hidden: false })) } } };
      }
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
    async evaluate() {
      return { observed_element_count: 0, elements: [] };
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
      imageProbe: { remainingMs: 10_000, cellBoundMs: 100, imageCap: 512, ...imageProbe },
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

  // The cell bound (100 ms) ends a held DOM.getDocument, the read or the
  // Page.getFrameTree re-read: probe_timeout, charged the bound (a timer may
  // fire a millisecond early), not the held step. Only a probe whose read
  // returned names its image.
  for (const [step, named] of [["tree", []], ["read", []], ["reread", ["body>img:nth-of-type(1)"]]]) {
    const probe = await probeCell(probeChromium({ delays: { [step]: HELD } }), {});
    assert.equal(probe.status, "probe_timeout", `${step}: the cell bound ended the probe`);
    assert.ok(probe.spent_ms >= 90 && probe.spent_ms < HELD, `${step}: spent ${probe.spent_ms} ms, about the bound and not the held step`);
    assert.deepEqual(probe.images.map((image) => image.element_path), named, `${step}: the images the probe names`);
  }

  // The run budget left (20 ms) is the smaller bound: it bounds every step,
  // and ending them reads probe_budget_exhausted.
  for (const step of ["tree", "read", "reread"]) {
    const probe = await probeCell(probeChromium({ delays: { [step]: HELD } }), { remainingMs: 20 });
    assert.equal(probe.status, "probe_budget_exhausted", `${step}: the run budget ended the probe`);
    assert.ok(probe.spent_ms >= 15 && probe.spent_ms < HELD, `${step}: spent ${probe.spent_ms} ms, about the budget left and not the held step`);
  }

  // A step does not start once the bound has passed: DOM.getDocument spends
  // the whole bound on the probe clock, so neither the read nor the re-read
  // starts.
  let time = 0;
  const clock = { now: () => time, sleep: () => new Promise(() => {}) };
  const fake = probeChromium({ during: { tree: () => { time = 100; } } });
  const cut = await probeCell(fake, { clock });
  assert.equal(cut.status, "probe_timeout");
  assert.equal(cut.spent_ms, 100);
  assert.deepEqual(fake.calls, ["tree"], "no probe step starts after the bound passed");
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

test("a probe step its bound ends is cancelled: a probe whose Page.createIsolatedWorld settles late sends no DOM.getDocument or any later command", async () => {
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
      imageProbe: { remainingMs: 20, cellBoundMs: 100, imageCap: 512 },
    });
    boundEndedAt = performance.now();
    probe = observation.imageProbe;
  } finally {
    await adapter.close();
  }
  assert.equal(probe.status, "probe_budget_exhausted", "the run budget left ended the probe");
  assert.ok(probe.spent_ms >= 15 && probe.spent_ms < WORLD_HELD, `spent ${probe.spent_ms} ms, about the budget left and not the held step`);
  assert.deepEqual(probe.images, [], "the cut probe names no image");

  // Let the held Page.createIsolatedWorld settle, and its continuation run.
  await new Promise((resolve) => setTimeout(resolve, WORLD_HELD + 100));
  const world = fake.sent.findIndex((entry) => entry.method === "Page.createIsolatedWorld");
  assert.ok(world >= 0, "the probe started");
  assert.ok(fake.sent[world].at < boundEndedAt);
  assert.deepEqual(fake.sent.filter((entry) => entry.at >= boundEndedAt), [], "no CDP command is sent after the bound");
  assert.ok(!fake.methods.includes("DOM.getDocument"), "the probe's DOM.getDocument is never sent");
  assert.deepEqual(fake.methods.slice(world), ["Page.createIsolatedWorld"], "no probe command follows the cut world");
  assert.deepEqual(fake.calls, [], "no probe step started after the world");
});

// Each CDP command a probe issues, with the probe step that holds it.
const PROBE_COMMAND_STEPS = ["world", "tree", "read", "reread"];

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

// ---------------------------------------------------------------------------
// Repair after challenge round 2: classes I (identity binding), R (identity
// fields re-derive from page_load), T (threshold boundaries) and S (an
// unreadable source type).

const { OTHER_ORIGIN, SLUG } = await import("./qc-test-factories.mjs");
const E = "evidence_not_reproducible";

// One collector response (the polish-browser.mjs projection) for `url`.
const hop = (url, { type = "Image", mime = "image/jpeg", status = 200, bytes, ...rest } = {}) => ({
  url,
  resource_type: type,
  status,
  mime_type: mime,
  ...(bytes === undefined ? {} : { encoded_data_length: bytes }),
  source_urls: [url],
  from_disk_cache: false,
  from_prefetch_cache: false,
  from_service_worker: false,
  request_served_from_cache: false,
  failed: false,
  ...rest,
});
// One probed <img>, geometry included.
const probed = (currentSrc, index, geometry = {}) => ({
  element_path: `body>img:nth-of-type(${index})`,
  current_src: currentSrc,
  svg_data: false,
  loading: "eager",
  complete: true,
  natural: [1000, 1000],
  rendered: [1000, 1000],
  object_fit: "fill",
  hidden: false,
  ...geometry,
});

// Evidence built the way the producer builds it (src/polish-node.mjs):
// collector response records → buildPageLoadCapture →
// buildPolishPageLoadEvidence, then buildMediaWeightCell /
// buildMediaWeightRecord, so every ledger entry, chain and integrity is the
// package's own. cells: [{ route, responses, images, mediaElements }]; each
// cell's document response is added first.
async function builtEvidence(cells) {
  const { buildPageLoadCapture } = await import("./polish-capture.mjs");
  const { buildPolishPageLoadEvidence } = await import("./polish-page-load.mjs");
  const { buildMediaWeightCell, buildMediaWeightRecord } = await import("./polish-media-weight.mjs");
  const inputs = cells.map(({ route, responses, images = [], mediaElements = [] }) => ({
    route,
    viewport: VIEWPORT,
    observation: {
      finalDocumentUrl: `${ORIGIN}${route}`,
      responseCollectionStatus: "complete",
      networkidle: { status: "settled", duration_ms: 500 },
      mediaElements,
      responses: [
        singleResponseRecord(`${route}:doc`, hop(`${ORIGIN}${route}`, { type: "Document", mime: "text/html", bytes: 4_000, is_final_main_document: true, document_context_fingerprint: `sha256:${"a".repeat(64)}` })),
        ...responses,
      ],
    },
    probe: { status: "complete", dpr: 1, images },
  }));
  const captures = inputs.map(({ route, viewport, observation }) => buildPageLoadCapture({
    buildFingerprint: BUILD_FP,
    slug: SLUG,
    requestedRoute: route,
    viewport,
    requestedDocumentUrl: observation.finalDocumentUrl,
    ...observation,
  }));
  const pageLoad = buildPolishPageLoadEvidence({ buildFingerprint: BUILD_FP, slug: SLUG, routeScope: "all", routes: cells.map((cell) => cell.route), viewports: [VIEWPORT], captures });
  const record = buildMediaWeightRecord({
    pageLoad,
    cells: inputs.map((input) => buildMediaWeightCell({
      ...input,
      capture: pageLoad.captures.find((capture) => capture.subject.requested_route === input.route),
    })),
    measuredAt: "2026-10-04T00:00:00.000Z",
  });
  return { pageLoad, record };
}

const { redirectChainRecord, singleResponseRecord } = await import("./polish-capture.mjs");

// Challenge P1-1: https://…/img/a.jpg requested twice, once answered 200
// directly (300,000 B) and once redirected 302 (200 B) to /img/final.jpg;
// the <img> keeps currentSrc /img/a.jpg. The ledger's a.jpg entry mixes 200
// and 302, so the URL stands for two chains (bindLedgerChain: ambiguous).
// Either the final transfer completed or it was canceled at 100,000 B of a
// declared 600,000 B. Both request orders give the same record and the same
// results: every result of the cell unexercised / evidence_not_reproducible
// (contract :163, :936), none pass, none accept-eligible.
test("P1-1 one image URL bound to two request chains: never pass, never accept-eligible, the same for both request orders (complete and canceled final transfer)", async () => {
  const A = `${ORIGIN}/img/a.jpg`;
  const FINAL = `${ORIGIN}/img/final.jpg`;
  const finals = {
    complete: hop(FINAL, { bytes: 300_000 }),
    canceled: hop(FINAL, { bytes: 100_000, canceled: true, declared_data_length: 600_000 }),
  };
  for (const [variant, finalHop] of Object.entries(finals)) {
    const direct = singleResponseRecord("direct", hop(A, { bytes: 300_000 }));
    const redirected = redirectChainRecord("redirected", [hop(A, { status: 302, bytes: 200, mime: "text/html" }), finalHop]);
    const read_ = {};
    for (const [order, responses] of [["direct-first", [direct, redirected]], ["redirect-first", [redirected, direct]]]) {
      const evidence = await builtEvidence([{ route: ROUTES[0], responses, images: [probed(A, 1)] }]);
      const entry = evidence.pageLoad.captures[0].resource_ledger.entries.find((candidate) => candidate.resource_id === resourceIdOf(A));
      assert.deepEqual(entry.statuses, [200, 302], `setup (${variant}, ${order}): one ledger entry mixes the direct and the redirected answer`);
      const results = await read(evidence);
      for (const row of results) {
        assert.notEqual(row.result, "pass", `${variant} ${order} ${row.check} ${row.subject.key}: never pass from one of two chains`);
        assert.equal(row.accept_eligible, false, `${variant} ${order} ${row.check} ${row.subject.key}: not accept-eligible`);
      }
      sameRows(results, [
        [ROUTES[0], resourceIdOf(`${ORIGIN}${ROUTES[0]}`), "media.weight", "unexercised", E, false],
        [ROUTES[0], resourceIdOf(A), "media.weight", "unexercised", E, false],
        [ROUTES[0], resourceIdOf(FINAL), "media.weight", "unexercised", E, false],
        [ROUTES[0], `${resourceIdOf(A)}:body>img:nth-of-type(1)`, "media.oversize", "unexercised", E, false],
      ]);
      read_[order] = { record: evidence.record, results };
    }
    assert.deepEqual(read_["redirect-first"].record, read_["direct-first"].record, `${variant}: the record does not depend on the request order`);
    assert.deepEqual(read_["redirect-first"].results, read_["direct-first"].results, `${variant}: the results do not depend on the request order`);
  }
});

// Mutation M16 (an <img> bound to the first chain whose first hop URL
// matches, instead of the identity its currentSrc names): two requests for
// one origin+path that differ only in the query, an SVG and a PNG. Each
// <img> binds to its own request, in either response order.
test("M16 an <img> binds to the request its currentSrc names (query included), never to another request for the same origin+path", async () => {
  const SVG = `${ORIGIN}/img/icon?v=1`;
  const PNG = `${ORIGIN}/img/icon?v=2`;
  const svgRecord = singleResponseRecord("svg", hop(SVG, { mime: "image/svg+xml", bytes: 2_000 }));
  const pngRecord = singleResponseRecord("png", hop(PNG, { mime: "image/png", bytes: 40_000 }));
  // Both shown at a tenth of 1000×1000 (F = 10): the PNG is oversized, the SVG is vector.
  const images = [probed(PNG, 1, { rendered: [100, 100] }), probed(SVG, 2, { rendered: [100, 100] })];
  for (const responses of [[svgRecord, pngRecord], [pngRecord, svgRecord]]) {
    const evidence = await builtEvidence([{ route: ROUTES[0], responses, images }]);
    const order = responses.map((record) => record.request_id).join(" then ");
    const cell = evidence.record.cells[0];
    assert.deepEqual(cell.images.map((image) => [image.resource_id, image.vector]), [[resourceIdOf(PNG), false], [resourceIdOf(SVG), true]], `${order}: each <img> binds to its own request`);
    sameRows(await read(evidence), [
      [ROUTES[0], resourceIdOf(`${ORIGIN}${ROUTES[0]}`), "media.weight", "pass", null, false],
      [ROUTES[0], resourceIdOf(SVG), "media.weight", "pass", null, false],
      [ROUTES[0], resourceIdOf(PNG), "media.weight", "pass", null, false],
      [ROUTES[0], `${resourceIdOf(PNG)}:body>img:nth-of-type(1)`, "media.oversize", "warning", "image_oversized", true],
      [ROUTES[0], `${resourceIdOf(SVG)}:body>img:nth-of-type(2)`, "media.oversize", "unexercised", "vector_image", false],
    ]);
  }
});

// The binder the rules use: a cell (evaluated directly, before any reader
// check) in which two resources' chains share a hop. Neither resource, and
// no <img> that names the shared hop, reads a result taken from one chain.
test("the 1.3 rules read a resource that shares a hop with another, and an <img> bound to it, as evidence_not_reproducible", () => {
  const A = resourceIdOf(`${ORIGIN}/img/a.jpg`);
  const B = resourceIdOf(`${ORIGIN}/img/b.jpg`);
  const FINAL = resourceIdOf(`${ORIGIN}/img/final.jpg`);
  const resource = (id, url, chain) => ({ resource_id: id, url, type: "image", transferred_bytes: 300_000, declared_bytes: null, measurement: "complete", failed: false, final_origin_equal: true, chain });
  const cell = {
    route: ROUTES[0],
    viewport: VIEWPORT,
    dpr: 1,
    capture_status: "complete",
    probe_status: "complete",
    resources: [
      resource(A, `${ORIGIN}/img/a.jpg`, [{ url: `${ORIGIN}/img/a.jpg`, resource_id: A, status: 302 }, { url: `${ORIGIN}/img/final.jpg`, resource_id: FINAL, status: 200 }]),
      resource(B, `${ORIGIN}/img/b.jpg`, [{ url: `${ORIGIN}/img/b.jpg`, resource_id: B, status: 302 }, { url: `${ORIGIN}/img/final.jpg`, resource_id: FINAL, status: 200 }]),
    ],
    videos: [],
    images: [
      { resource_id: FINAL, element_path: "body>img:nth-of-type(1)", complete: true, natural: [1000, 1000], rendered: [1000, 1000], object_fit: "fill", loading: "eager", hidden: false },
      { resource_id: A, element_path: "body>img:nth-of-type(2)", complete: true, natural: [1000, 1000], rendered: [1000, 1000], object_fit: "fill", loading: "eager", hidden: false },
    ],
  };
  const rows = evaluateMediaWeight(cell).map((row) => [row.subject.key, row.check, row.result, row.reason_code, row.accept_eligible]).sort();
  assert.deepEqual(rows, [
    [A, "media.weight", "unexercised", E, false],
    [`${A}:body>img:nth-of-type(2)`, "media.oversize", "unexercised", E, false],
    [B, "media.weight", "unexercised", E, false],
    [`${FINAL}:body>img:nth-of-type(1)`, "media.oversize", "unexercised", E, false],
  ].sort());
});

// Candidate S, node leg: a source whose type the capture cannot read. A
// blob: currentSrc, and an http currentSrc the ledger has no entry for, keep
// resource_id null and vector null; their oversize result is unexercised /
// not_in_ledger, never pass. A data: source's type is its own (svg or not).
test("an <img> whose source type cannot be read (blob:, or http with no ledger entry) reads oversize unexercised (not_in_ledger), never pass", async () => {
  const CACHED = `${ORIGIN}/img/cached.png`;
  const images = [
    { ...probed("blob:", 1, { rendered: [300, 150], natural: [300, 150] }) },
    { ...probed(CACHED, 2, { natural: [40, 30], rendered: [40, 30] }) },
    { ...probed("data:", 3, { natural: [40, 30], rendered: [40, 30] }), svg_data: true },
    { ...probed("data:", 4, { natural: [40, 30], rendered: [40, 30] }) },
  ];
  const evidence = await builtEvidence([{ route: ROUTES[0], responses: [], images }]);
  assert.deepEqual(evidence.record.cells[0].images.map((image) => [image.resource_id, image.vector]), [[null, null], [null, null], [null, true], [null, false]]);
  const rows = await read(evidence);
  const oversize = rows.filter((row) => row.check === "media.oversize").map((row) => [row.subject.key, row.result, row.reason_code]).sort();
  assert.deepEqual(oversize, [
    ["null:body>img:nth-of-type(1)", "unexercised", "not_in_ledger"],
    ["null:body>img:nth-of-type(2)", "unexercised", "not_in_ledger"],
    ["null:body>img:nth-of-type(3)", "unexercised", "vector_image"],
    ["null:body>img:nth-of-type(4)", "pass", null],
  ]);
});

// ---------------------------------------------------------------------------
// Class R: every identity-bearing field of the record re-derives from
// page_load. One package-built two-cell record: the cell under test (route
// 0) holds the document, a 300,000 B hero image, a script, a cross-origin
// 302 to a same-origin image, and a <video> that fetched its source; two
// <img> (the hero shown at 100×100, F = 10, an accept-eligible warning, and
// the redirected image). Each mutation changes one field, recomputes the
// record integrity and must leave every result of that cell unexercised /
// evidence_not_reproducible and not accept-eligible (the build fingerprint:
// stale_binding, contract :936).
async function identityEvidence() {
  const HERO_URL = `${ORIGIN}/img/hero.jpg`;
  const SCRIPT = `${ORIGIN}/app.js`;
  const HOP = `${OTHER_ORIGIN}/img/moved.jpg`;
  const MOVED = `${ORIGIN}/img/moved.jpg`;
  const CLIP = `${ORIGIN}/media/clip.mp4`;
  const video = {
    tag_name: "video",
    current_src: CLIP,
    src_attribute: CLIP,
    source_src_attributes: [],
    observed_source_urls: [],
    preload_attribute: "auto",
    computed_style: { display: "inline", visibility: "visible" },
    ancestor_styles: [],
    bounding_box: { width: 320, height: 180 },
  };
  return builtEvidence([
    {
      route: ROUTES[0],
      responses: [
        singleResponseRecord("hero", hop(HERO_URL, { bytes: 300_000 })),
        singleResponseRecord("script", hop(SCRIPT, { type: "Script", mime: "text/javascript", bytes: 9_000 })),
        redirectChainRecord("moved", [hop(HOP, { status: 302, bytes: 300, mime: "text/html" }), hop(MOVED, { bytes: 50_000 })]),
        singleResponseRecord("clip", hop(CLIP, { type: "Media", mime: "video/mp4", bytes: 80_000 })),
      ],
      images: [probed(HERO_URL, 1, { rendered: [100, 100] }), probed(HOP, 2, { natural: [40, 30], rendered: [40, 30] })],
      mediaElements: [video],
    },
    {
      route: ROUTES[1],
      responses: [singleResponseRecord("control", hop(`${ORIGIN}/img/control.jpg`, { bytes: 600_000 }))],
      images: [probed(`${ORIGIN}/img/control.jpg`, 1)],
    },
  ]);
}

const upperHex = (id) => id.replace(/^sha256:/, "").toUpperCase().replace(/^/, "sha256:");
const NOWHERE_ID = `sha256:${"0".repeat(64)}`;

test("table R: each identity field of a media_weight cell, re-cased, swapped with another real value or pointed nowhere, reads evidence_not_reproducible and is never accept-eligible", async () => {
  const evidence = await identityEvidence();
  const control = await read(evidence);
  const cellRowsOf = (results) => results.filter((row) => row.subject.page !== ROUTES[1]);
  // Control: the untouched record re-derives, and the cell under test holds
  // an accept-eligible warning and passes that a mutation must not keep.
  assert.ok(cellRowsOf(control).some((row) => row.result === "warning" && row.accept_eligible), "control: the hero oversize warning is accept-eligible");
  assert.ok(cellRowsOf(control).some((row) => row.result === "pass"), "control: the cell holds passes");
  assert.ok(control.every((row) => row.reason_code !== E), "control: nothing reads evidence_not_reproducible");

  const cell0 = evidence.record.cells[0];
  const cell1 = evidence.record.cells[1];
  const byUrl = (url) => cell0.resources.find((resource) => resource.url === url);
  const hero = cell0.resources.indexOf(byUrl(`${ORIGIN}/img/hero.jpg`));
  const script = byUrl(`${ORIGIN}/app.js`);
  const moved = cell0.resources.indexOf(byUrl(`${OTHER_ORIGIN}/img/moved.jpg`));
  const documentResource = byUrl(`${ORIGIN}${ROUTES[0]}`);
  const movedChain = cell0.resources[moved].chain;
  assert.equal(movedChain.length, 2, "setup: the redirected image has a two-hop chain");
  assert.equal(cell0.videos.length, 1, "setup: one <video>");
  assert.equal(cell0.videos[0].resource_ids.length, 1, "setup: the <video> fetched its source");
  assert.equal(cell0.images[0].resource_id, cell0.resources[hero].resource_id, "setup: <img> 1 is the hero");

  // [field, mutation, edit(record)]
  const R = [
    ["cells[].route", "re-cased", (r) => { r.cells[0].route = ROUTES[0].toUpperCase(); }],
    ["cells[].route", "another real route", (r) => { r.cells[0].route = ROUTES[1]; }],
    ["cells[].route", "nowhere", (r) => { r.cells[0].route = "/runtime-packet-demo/nowhere/"; }],
    ["cells[].viewport", "re-cased", (r) => { r.cells[0].viewport = "Desktop"; }],
    ["cells[].viewport", "another real viewport", (r) => { r.cells[0].viewport = "mobile"; }],
    ["cells[].document_origin", "re-cased", (r) => { r.cells[0].document_origin = ORIGIN.toUpperCase(); }],
    ["cells[].document_origin", "another real origin", (r) => { r.cells[0].document_origin = OTHER_ORIGIN; }],
    ["cells[].document_origin", "nowhere", (r) => { r.cells[0].document_origin = "https://nowhere.example.invalid"; }],
    ["cells[].page_load_integrity", "re-cased", (r) => { r.cells[0].page_load_integrity = upperHex(cell0.page_load_integrity); }],
    ["cells[].page_load_integrity", "another real capture's", (r) => { r.cells[0].page_load_integrity = cell1.page_load_integrity; }],
    ["cells[].page_load_integrity", "nowhere", (r) => { r.cells[0].page_load_integrity = NOWHERE_ID; }],
    ["resources[].resource_id", "re-cased", (r) => { r.cells[0].resources[hero].resource_id = upperHex(cell0.resources[hero].resource_id); }],
    ["resources[].resource_id", "another real id", (r) => { r.cells[0].resources[hero].resource_id = script.resource_id; }],
    ["resources[].resource_id", "nowhere", (r) => { r.cells[0].resources[hero].resource_id = NOWHERE_ID; }],
    ["resources[].url", "re-cased", (r) => { r.cells[0].resources[hero].url = `${ORIGIN}/IMG/HERO.JPG`; }],
    ["resources[].url", "another real url", (r) => { r.cells[0].resources[hero].url = script.url; }],
    ["resources[].url", "nowhere", (r) => { r.cells[0].resources[hero].url = `${ORIGIN}/img/nowhere.jpg`; }],
    ["resources[].chain[0].resource_id", "re-cased", (r) => { r.cells[0].resources[hero].chain[0].resource_id = upperHex(cell0.resources[hero].resource_id); }],
    ["resources[].chain[0].resource_id", "another real id", (r) => { r.cells[0].resources[hero].chain[0].resource_id = script.resource_id; }],
    ["resources[].chain[0].resource_id", "nowhere", (r) => { r.cells[0].resources[hero].chain[0].resource_id = NOWHERE_ID; }],
    ["resources[].chain[0].url", "re-cased", (r) => { r.cells[0].resources[hero].chain[0].url = `${ORIGIN}/IMG/HERO.JPG`; }],
    ["resources[].chain[0].url", "another real url", (r) => { r.cells[0].resources[hero].chain[0].url = script.url; }],
    ["resources[].chain[0].url", "nowhere", (r) => { r.cells[0].resources[hero].chain[0].url = `${ORIGIN}/img/nowhere.jpg`; }],
    ["resources[].chain[final].resource_id", "re-cased", (r) => { r.cells[0].resources[moved].chain[1].resource_id = upperHex(movedChain[1].resource_id); }],
    ["resources[].chain[final].resource_id", "another real id", (r) => { r.cells[0].resources[moved].chain[1].resource_id = cell0.resources[hero].resource_id; }],
    ["resources[].chain[final].resource_id", "nowhere", (r) => { r.cells[0].resources[moved].chain[1].resource_id = NOWHERE_ID; }],
    ["resources[].chain[final].url (final_url)", "re-cased", (r) => { r.cells[0].resources[moved].chain[1].url = `${ORIGIN}/IMG/MOVED.JPG`; }],
    ["resources[].chain[final].url (final_url)", "another real url", (r) => { r.cells[0].resources[moved].chain[1].url = `${ORIGIN}/img/hero.jpg`; }],
    ["resources[].chain[final].url (final_url)", "nowhere", (r) => { r.cells[0].resources[moved].chain[1].url = `${ORIGIN}/img/nowhere.jpg`; }],
    ["images[].resource_id", "re-cased", (r) => { r.cells[0].images[0].resource_id = upperHex(cell0.images[0].resource_id); }],
    ["images[].resource_id", "another real id (the document)", (r) => { r.cells[0].images[0].resource_id = documentResource.resource_id; }],
    ["images[].resource_id", "another real id (a script)", (r) => { r.cells[0].images[0].resource_id = script.resource_id; }],
    ["images[].resource_id", "another real id (a redirect's final hop)", (r) => { r.cells[0].images[0].resource_id = movedChain[1].resource_id; }],
    ["images[].resource_id", "nowhere", (r) => { r.cells[0].images[0].resource_id = NOWHERE_ID; }],
    ["videos[].element_index", "another index", (r) => { r.cells[0].videos[0].element_index = 1; }],
    ["videos[].resource_ids", "re-cased", (r) => { r.cells[0].videos[0].resource_ids = [upperHex(cell0.videos[0].resource_ids[0])]; }],
    ["videos[].resource_ids", "another real id", (r) => { r.cells[0].videos[0].resource_ids = [cell0.resources[hero].resource_id]; }],
    ["videos[].resource_ids", "nowhere", (r) => { r.cells[0].videos[0].resource_ids = [NOWHERE_ID]; }],
    ["subject.campaign_slug", "re-cased", (r) => { r.subject.campaign_slug = SLUG.toUpperCase(); }],
    ["subject.campaign_slug", "nowhere", (r) => { r.subject.campaign_slug = "nowhere"; }],
    ["subject.routes", "re-cased", (r) => { r.subject.routes = [ROUTES[0].toUpperCase(), ROUTES[1]]; }],
    ["subject.routes", "nowhere", (r) => { r.subject.routes = [ROUTES[0], "/runtime-packet-demo/nowhere/"]; }],
    ["subject.viewports", "another real viewport", (r) => { r.subject.viewports = ["mobile"]; }],
    ["subject.build_fingerprint", "re-cased", (r) => { r.subject.build_fingerprint = BUILD_FP.toUpperCase(); }],
    ["subject.build_fingerprint", "nowhere", (r) => { r.subject.build_fingerprint = NOWHERE_ID; }],
  ];
  for (const [field, mutation, edit] of R) {
    const record = structuredClone(evidence.record);
    edit(record);
    const label = `${field} ${mutation}`;
    assert.notDeepEqual(record, evidence.record, `${label}: the mutation changes the record`);
    const results = await read({ record: withRecomputedIntegrity(record), pageLoad: evidence.pageLoad });
    const rows = cellRowsOf(results);
    const expected = field === "subject.build_fingerprint" ? "stale_binding" : E;
    for (const check of ["media.weight", "media.oversize"]) {
      assert.ok(rows.some((row) => row.check === check && row.subject.page === ROUTES[0]), `${label}: the cell still lists a ${check} result`);
    }
    for (const row of rows) {
      const where = `${label}: ${row.check} ${row.subject.page} ${row.subject.key}`;
      assert.equal(row.result, "unexercised", where);
      assert.equal(row.reason_code, expected, where);
      assert.equal(row.accept_eligible, false, `${where}: not accept-eligible`);
    }
  }
});

// ---------------------------------------------------------------------------
// Class T: each threshold at, under and over its value, on the contract's
// side. Weight (contract :963-967): over is strictly greater than 500,000
// measured bytes, and strictly greater than 500,000 declared bytes. Oversize
// (:988): F ≥ 2.0 and nw·nh ≥ 250,000, both inclusive. Read through the
// reader site with the real rules.
test("table T: image_bytes 500,000 (complete and lower_bound) and declared bytes: over means strictly greater", async () => {
  const weight = async (spec) => {
    const evidence = mediaWeightFixture({ cells: [{ route: ROUTES[0], resources: [{ path: HERO, ...spec }] }] });
    const row = (await read(evidence)).find((item) => item.check === "media.weight" && item.subject.key === HERO_KEY);
    return [row.result, row.reason_code];
  };
  const cases = [
    [{ bytes: 499_999 }, ["pass", null]],
    [{ bytes: 500_000 }, ["pass", null]],
    [{ bytes: 500_001 }, ["warning", "image_over_threshold"]],
    [{ bytes: 499_999, canceled: 1 }, ["unexercised", "transfer_partial"]],
    [{ bytes: 500_000, canceled: 1 }, ["unexercised", "transfer_partial"]],
    [{ bytes: 500_001, canceled: 1 }, ["warning", "image_over_threshold"]],
    [{ bytes: 100_000, canceled: 1, declared: 499_999 }, ["unexercised", "transfer_partial"]],
    [{ bytes: 100_000, canceled: 1, declared: 500_000 }, ["unexercised", "transfer_partial"]],
    [{ bytes: 100_000, canceled: 1, declared: 500_001 }, ["review", "declared_over_threshold_unmeasured"]],
    [{ bytes: 500_000, canceled: 1, declared: 500_001 }, ["review", "declared_over_threshold_unmeasured"]],
  ];
  for (const [spec, expected] of cases) assert.deepEqual(await weight(spec), expected, JSON.stringify(spec));
});

test("table T: oversize_factor 2.0 and min_natural_area 250,000 are inclusive; the observed DPR divides F", async () => {
  const oversize = async (geometry, dpr = 1) => {
    const evidence = heroCell((cell) => {
      cell.dpr = dpr;
      Object.assign(cell.images[0], { object_fit: "contain", ...geometry });
    });
    const row = (await read(evidence)).find((item) => item.check === "media.oversize");
    return [row.result, row.reason_code];
  };
  const WARN = ["warning", "image_oversized"];
  const PASS = ["pass", null];
  const cases = [
    // F at 2.0 exactly (contain, s = 0.5), just under and just over; area 1,000,000.
    [{ natural: [1000, 1000], rendered: [500, 500] }, 1, WARN],
    [{ natural: [1000, 1000], rendered: [501, 1000] }, 1, PASS],
    [{ natural: [1000, 1000], rendered: [499, 1000] }, 1, WARN],
    // The same at DPR 2: s = 0.25 gives F = 2.0.
    [{ natural: [1000, 1000], rendered: [250, 250] }, 2, WARN],
    [{ natural: [1000, 1000], rendered: [251, 1000] }, 2, PASS],
    // Area at 250,000 exactly, one under and one over, at F = 2.0.
    [{ natural: [1, 249_999], rendered: [0.5, 249_999] }, 1, PASS],
    [{ natural: [1, 250_000], rendered: [0.5, 250_000] }, 1, WARN],
    [{ natural: [1, 250_001], rendered: [0.5, 250_001] }, 1, WARN],
    // The zero edges: no natural width is not_loaded, no rendered width is not_rendered.
    [{ natural: [0, 1000], rendered: [500, 500] }, 1, ["unexercised", "not_loaded"]],
    [{ natural: [1000, 1000], rendered: [0, 500] }, 1, ["unexercised", "not_rendered"]],
  ];
  for (const [geometry, dpr, expected] of cases) assert.deepEqual(await oversize(geometry, dpr), expected, `${JSON.stringify(geometry)} at DPR ${dpr}`);
  // scale-down clamps s at 1, so it never makes F smaller than contain does:
  // at contain s = 0.5 both read F = 2.0; above natural size both pass.
  assert.deepEqual(await oversize({ object_fit: "scale-down", natural: [1000, 1000], rendered: [500, 500] }), WARN);
  assert.deepEqual(await oversize({ object_fit: "scale-down", natural: [1000, 1000], rendered: [501, 1000] }), PASS);
});

// ---------------------------------------------------------------------------
// Ambiguity on every hop of a chain: an entry anywhere in a chain whose
// statuses mix a redirect and a non-redirect, or a hop that is one chain's
// final and another chain's start, makes the binding ambiguous, so the cell
// is refused (contract :163) in every request order.

// Every order of `records`.
const orders = (records) => (records.length <= 1
  ? [records]
  : records.flatMap((record, index) => orders([...records.slice(0, index), ...records.slice(index + 1)]).map((rest) => [record, ...rest])));

// Builds and reads the cell once per request order and asserts the results
// are every subject of the cell, each unexercised / evidence_not_reproducible,
// none accept-eligible, and the record and results do not depend on the order.
async function assertRefusedInEveryOrder(records, images, subjects, setup) {
  let first = null;
  for (const responses of orders(records)) {
    const order = responses.map((record) => record.request_id).join(" then ");
    const evidence = await builtEvidence([{ route: ROUTES[0], responses, images }]);
    setup(evidence.pageLoad.captures[0].resource_ledger.entries, order);
    const results = await read(evidence);
    sameRows(results, subjects.map(([key, check]) => [ROUTES[0], key, check, "unexercised", E, false]));
    if (first) {
      assert.deepEqual(evidence.record, first.record, `${order}: the record does not depend on the request order`);
      assert.deepEqual(results, first.results, `${order}: the results do not depend on the request order`);
    } else first = { record: evidence.record, results };
  }
}

const ledgerEntryOf = (entries, url) => entries.find((entry) => entry.resource_id === resourceIdOf(url));
const DOC_KEY = resourceIdOf(`${ORIGIN}${ROUTES[0]}`);

test("a chain whose final hop also redirected (A 302 to B 200, B 302 to C 200, only image A) is refused in both request orders", async () => {
  const [A, B, C] = ["a", "b", "c"].map((name) => `${ORIGIN}/img/${name}.jpg`);
  const records = [
    redirectChainRecord("a", [hop(A, { status: 302, bytes: 200, mime: "text/html" }), hop(B, { bytes: 300_000 })]),
    redirectChainRecord("b", [hop(B, { status: 302, bytes: 200, mime: "text/html" }), hop(C, { bytes: 300_000 })]),
  ];
  await assertRefusedInEveryOrder(records, [probed(A, 1)], [
    [DOC_KEY, "media.weight"],
    [resourceIdOf(A), "media.weight"],
    [resourceIdOf(B), "media.weight"],
    [resourceIdOf(C), "media.weight"],
    [`${resourceIdOf(A)}:body>img:nth-of-type(1)`, "media.oversize"],
  ], (entries, order) => {
    assert.deepEqual(ledgerEntryOf(entries, B).statuses, [200, 302], `setup (${order}): B's entry mixes the answer and the redirect`);
  });
});

test("a three-hop chain whose final hop also redirected (A 302 to B 302 to C 200, C 302 to D 200) is refused in both request orders", async () => {
  const [A, B, C, D] = ["a", "b", "c", "d"].map((name) => `${ORIGIN}/img/${name}.jpg`);
  const records = [
    redirectChainRecord("a", [hop(A, { status: 302, bytes: 200, mime: "text/html" }), hop(B, { status: 302, bytes: 200, mime: "text/html" }), hop(C, { bytes: 300_000 })]),
    redirectChainRecord("c", [hop(C, { status: 302, bytes: 200, mime: "text/html" }), hop(D, { bytes: 300_000 })]),
  ];
  await assertRefusedInEveryOrder(records, [probed(A, 1)], [
    [DOC_KEY, "media.weight"],
    [resourceIdOf(A), "media.weight"],
    [resourceIdOf(B), "media.weight"],
    [resourceIdOf(C), "media.weight"],
    [resourceIdOf(D), "media.weight"],
    [`${resourceIdOf(A)}:body>img:nth-of-type(1)`, "media.oversize"],
  ], (entries, order) => {
    assert.deepEqual(ledgerEntryOf(entries, C).statuses, [200, 302], `setup (${order}): C's entry mixes the answer and the redirect`);
  });
});

test("a hop that is also another chain's start (F answered directly too; M redirected directly too) is refused in every request order", async () => {
  const [A, M, F] = ["a", "m", "f"].map((name) => `${ORIGIN}/img/${name}.jpg`);
  // A 302 to F 200, and F requested directly (200).
  await assertRefusedInEveryOrder([
    redirectChainRecord("a", [hop(A, { status: 302, bytes: 200, mime: "text/html" }), hop(F, { bytes: 300_000 })]),
    singleResponseRecord("f", hop(F, { bytes: 300_000 })),
  ], [probed(A, 1)], [
    [DOC_KEY, "media.weight"],
    [resourceIdOf(A), "media.weight"],
    [resourceIdOf(F), "media.weight"],
    [`${resourceIdOf(A)}:body>img:nth-of-type(1)`, "media.oversize"],
  ], (entries, order) => {
    assert.deepEqual([ledgerEntryOf(entries, A).request_count, ledgerEntryOf(entries, F).request_count], [1, 2], `setup (${order}): F answered two requests`);
  });
  // A 302 to M 302 to F 200, and M requested directly (302 to F).
  await assertRefusedInEveryOrder([
    redirectChainRecord("a", [hop(A, { status: 302, bytes: 200, mime: "text/html" }), hop(M, { status: 302, bytes: 200, mime: "text/html" }), hop(F, { bytes: 300_000 })]),
    redirectChainRecord("m", [hop(M, { status: 302, bytes: 200, mime: "text/html" }), hop(F, { bytes: 300_000 })]),
  ], [probed(A, 1)], [
    [DOC_KEY, "media.weight"],
    [resourceIdOf(A), "media.weight"],
    [resourceIdOf(M), "media.weight"],
    [resourceIdOf(F), "media.weight"],
    [`${resourceIdOf(A)}:body>img:nth-of-type(1)`, "media.oversize"],
  ], (entries, order) => {
    assert.deepEqual(ledgerEntryOf(entries, M).statuses, [302], `setup (${order}): M only redirected`);
    assert.equal(ledgerEntryOf(entries, M).request_count, 2, `setup (${order}): M answered two requests`);
  });
});

test("control: one redirect chain per href (A 302 to B 302 to C 200) still binds and reads", async () => {
  const [A, B, C] = ["a", "b", "c"].map((name) => `${ORIGIN}/img/${name}.jpg`);
  const evidence = await builtEvidence([{
    route: ROUTES[0],
    responses: [redirectChainRecord("a", [hop(A, { status: 302, bytes: 200, mime: "text/html" }), hop(B, { status: 302, bytes: 200, mime: "text/html" }), hop(C, { bytes: 300_000 })])],
    images: [probed(A, 1, { rendered: [100, 100] })],
  }]);
  assert.deepEqual(evidence.record.cells[0].resources.find((resource) => resource.resource_id === resourceIdOf(A)).chain.map((entry) => entry.resource_id), [A, B, C].map(resourceIdOf));
  sameRows(await read(evidence), [
    [ROUTES[0], DOC_KEY, "media.weight", "pass", null, false],
    [ROUTES[0], resourceIdOf(A), "media.weight", "pass", null, false],
    [ROUTES[0], `${resourceIdOf(A)}:body>img:nth-of-type(1)`, "media.oversize", "warning", "image_oversized", true],
  ]);
});

// ---------------------------------------------------------------------------
// A skipped spec page with no resolvable public route (a skipped mapping
// usually carries no page_kit) is never left out: it reads page_not_captured,
// named by its page id.

test("a skipped page whose public route cannot be resolved reads page_not_captured keyed by its page id, per viewport and check", async () => {
  const { capturePolishPageLoad, POLISH_CAPTURE_VIEWPORTS } = await import("./polish-node.mjs");
  const mapped = ROUTES[0];
  const packet = {
    campaign: { public_route_slug: SLUG },
    source_html: {
      pages: [
        { page_id: "landing", path: "landing.html", page_kit: { public_route: mapped, spec_route: "" } },
        { page_id: "checkout", skip_reason: "Template stock page." },
        { page_id: "upsell", skip_reason: "Template stock page.", page_kit: { public_route: "not a route" } },
      ],
    },
  };
  const report = { identity: { public_route_slug: SLUG }, stages: { assembly: { status: "completed", build_fingerprint: BUILD_FP } } };
  const output = await capturePolishPageLoad({
    packet,
    report,
    baseUrl: `${ORIGIN}/`,
    createBrowserAdapter: async () => ({
      async captureRoute({ url }) {
        return {
          finalDocumentUrl: url,
          responseCollectionStatus: "complete",
          networkidle: { status: "settled", duration_ms: 500 },
          mediaElements: [],
          responses: [singleResponseRecord("doc", hop(url, { type: "Document", mime: "text/html", bytes: 4_000, is_final_main_document: true, document_context_fingerprint: `sha256:${"a".repeat(64)}` }))],
          imageProbe: { status: "complete", dpr: 1, images: [], spent_ms: 0 },
        };
      },
      async close() {},
    }),
  });
  assert.deepEqual(output.media_weight.uncaptured_page_ids, ["checkout", "upsell"]);
  const results = await read({ record: output.media_weight, pageLoad: output.page_load });
  const viewports = POLISH_CAPTURE_VIEWPORTS.map((viewport) => viewport.key);
  const unnamed = results.filter((row) => row.subject.page === null).map((row) => [row.subject.key, row.subject.viewport, row.check, row.result, row.reason_code, row.accept_eligible]).sort();
  assert.deepEqual(unnamed, ["checkout", "upsell"].flatMap((pageId) => viewports.flatMap((viewport) => ["media.oversize", "media.weight"].map((check) => [`page:${pageId}`, viewport, check, "unexercised", "page_not_captured", false]))).sort());
  // A list of page ids is accepted only where page_load records a selected route scope.
  const all = withRecomputedIntegrity({ ...output.media_weight, subject: { ...output.media_weight.subject, route_scope: "all" } });
  const pageLoadAll = { ...output.page_load, subject: { ...output.page_load.subject, route_scope: "all" } };
  for (const row of await read({ record: all, pageLoad: pageLoadAll })) {
    assert.equal(row.reason_code, E, `${row.check} ${row.subject.key}: a page id list under route_scope "all" does not re-derive`);
  }
});

// The 1.3 rules refuse thresholds that are not positive numbers.
test("evaluateMediaWeight refuses a zero, negative or non-finite threshold", () => {
  const cell = { route: ROUTES[0], viewport: VIEWPORT, dpr: 1, capture_status: "complete", probe_status: "complete", resources: [], images: [], videos: [] };
  assert.doesNotThrow(() => evaluateMediaWeight(cell));
  for (const [field, value] of [["image_bytes", -1], ["oversize_factor", 0], ["min_natural_area", -250_000], ["oversize_factor", Infinity]]) {
    assert.throws(() => evaluateMediaWeight(cell, { ...MEDIA_WEIGHT_QC_RULES.thresholds, [field]: value }), /thresholds are not the 1.3 thresholds/, `${field} ${value}`);
  }
});
