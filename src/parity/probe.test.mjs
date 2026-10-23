import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

import { PARITY_MAX_ROUTES, PARITY_PROBE_CELL_MS, PARITY_PROBE_RUN_MS, PARITY_PROBE_WALK_MS } from "../polish-deadline.mjs";
import { createParityProbeRun, parityProbe, parityProbeSource, PARITY_PROBE_LIMITS_ARG, PARITY_PROBE_NAME, PARITY_PROBE_VERSION } from "./probe.mjs";

const routes = (n) => Array.from({ length: n }, (_, i) => ({ page_id: `p${i}`, requested_route: `/sample/p${i}/` }));

for (const phase of ["traversal", "page_text", "classification", "measurement", "viewport"]) {
  test(`P2-I13 repair: the real probe reports the walk cap when its final ${phase} exceeds 1500 ms`, () => {
    let now = 0, measured = 0;
    const overrun = (where) => { if (phase === where) now = 1600; };
    const body = { localName: "p", childNodes: [{ nodeType: 3, data: "Synthetic text" }],
      querySelectorAll: () => [], get shadowRoot() { overrun("traversal"); return null; },
      get innerText() { overrun("page_text"); return "Synthetic text"; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20 }) };
    const toolkit = { isVisible: () => true, isTextBearing: () => { overrun("classification"); return true; }, selectorPath: () => "body>p",
      measureTextElement: () => { measured++; overrun("measurement"); return { fg_srgb: [0, 0, 0], bg_srgb: [1, 1, 1] }; } };
    const output = runInNewContext(`(${parityProbe.toString()})(toolkit, limits, [])`, {
      toolkit, limits: PARITY_PROBE_LIMITS_ARG, performance: { now: () => now }, document: { body, fonts: [] },
      window: { get innerWidth() { overrun("viewport"); return 1440; }, innerHeight: 1200, devicePixelRatio: 1, scrollX: 0, scrollY: 0,
        getComputedStyle: () => ({ getPropertyValue: () => "16" }) },
    });
    assert.equal(output.coverage.time_capped, true);
    assert.equal(measured, ["measurement", "viewport"].includes(phase) ? 1 : 0, "no measurement begins after the deadline");
  });
}

test("the probe entry is the contract's: name, self-contained source, limits, bound and closed roots", () => {
  const { probe } = createParityProbeRun({ routes: routes(1) });
  assert.equal(probe.name, PARITY_PROBE_NAME); assert.equal(PARITY_PROBE_VERSION, "parity-probe/v1");
  assert.deepEqual(probe.args, [{ elements: 1500, text_chars: 500, page_text_chars: 262144, font_faces: 200, walk_ms: 1500 }]);
  assert.equal(probe.args[0], PARITY_PROBE_LIMITS_ARG);
  assert.equal(probe.boundMs, 2000); assert.equal(probe.closedRoots, true);
  assert.deepEqual([PARITY_MAX_ROUTES, PARITY_PROBE_CELL_MS, PARITY_PROBE_WALK_MS, PARITY_PROBE_RUN_MS], [32, 2000, 1500, 60000]);
  // Self-contained: it parses as one function declaration with no free module references.
  const source = parityProbeSource();
  assert.match(source, /^function \(limits, \.\.\.closedRoots\)/);
  assert.equal(typeof new Function(`return (${source});`)(), "function");
  assert.doesNotMatch(source, /\b(import|require)\b\s*\(/);
});

test("select refuses routes beyond the 32-route grid and, once elapsed_ms reaches the run budget, every later cell (remembered as exhausted)", () => {
  const run = createParityProbeRun({ routes: routes(33) });
  const cell = (side, i, viewport = "desktop") => ({ side, page_id: `p${i}`, route: `/sample/p${i}/`, viewport });
  assert.equal(run.probe.select(cell("build", 32)), false);
  assert.equal(run.exhausted("build", "/sample/p32/", "desktop"), false, "the route cap is not budget exhaustion");
  run.probe.onResult(cell("build", 32), { status: "measured", value: {}, elapsed_ms: 1 });
  assert.equal(run.result("build", "/sample/p32/", "desktop"), null, "results outside the grid are not kept");
  for (let i = 0; i < 3; i += 1) {
    assert.equal(run.probe.select(cell("build", i)), true);
    run.probe.onResult(cell("build", i), { status: "measured", value: { i }, elapsed_ms: 25_000 });
  }
  assert.equal(run.spentMs(), 75_000);
  assert.equal(run.probe.select(cell("source_html", 3)), false);
  assert.equal(run.exhausted("source_html", "/sample/p3/", "desktop"), true);
  assert.deepEqual(run.result("build", "/sample/p1/", "desktop"), { status: "measured", value: { i: 1 }, elapsed_ms: 25_000 });
  // A result with no usable elapsed time is charged its full bound.
  const other = createParityProbeRun({ routes: routes(1) });
  other.probe.onResult(cell("build", 0), { status: "timeout", value: null });
  assert.equal(other.spentMs(), PARITY_PROBE_CELL_MS);
});
