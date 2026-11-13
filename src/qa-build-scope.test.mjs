import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyQaBuildScope, specForQaScope } from "./qa-build-scope.mjs";
import { __qaNodeTestHooks, applyQaPageScope } from "./qa-node.mjs";
import { computeDisposition } from "./qa-verdict.mjs";

const topologies = [{ funnel_id: "main", pages: ["presell", "landing", "checkout", "receipt"].map((id, order) => ({
  page_id: id, page_type: id === "receipt" ? "thankyou" : id,
  order, label: id, url: `https://preview.example.test/demo/${id}/`,
})) }];
const packet = { source_html: { pages: ["presell", "landing"].map(page_id => ({ page_id, skip_reason: "Remains on merchant host" })) } };
const report = { stages: { prepare_build: { declared_out_of_scope: packet.source_html.pages } } };
const spec = { campaign: {}, build_scope: { mode: "partial" }, funnels: [{ id: "main", pages: topologies[0].pages.map(p => ({ id: p.page_id, type: p.page_type })) }] };
const scope = options => applyQaBuildScope(topologies, { packet, report, publicRouteSlug: "demo", ...options });

test("a repo-origin page added after handoff remains in the full QA page list", () => {
  const updatedSpec = structuredClone(spec);
  updatedSpec.funnels[0].pages.push({ id: "upsell-2", type: "upsell", page_url: "upsell-2/" });
  const updatedPacket = structuredClone(packet);
  updatedPacket.source_html.pages.push({ page_id: "upsell-2", origin: "repo", page_kit: {
    public_route: "/demo/upsell-2/", spec_route: "upsell-2/", target_path: "upsell-2.html", output_path: "src/demo/upsell-2.html",
  } });
  const extracted = __qaNodeTestHooks.extractTopologies(updatedSpec, {
    baseUrl: "https://preview.example.test/demo/", publicRouteSlug: "demo",
  });
  const buildScope = applyQaBuildScope(extracted, { packet: updatedPacket, report, publicRouteSlug: "demo" });
  const full = applyQaPageScope(buildScope.topologies);
  assert.equal(full.scope, null);
  assert.deepEqual(full.topologies[0].pages.map((page) => page.page_id), ["checkout", "receipt", "upsell-2"]);
  assert.equal(full.topologies[0].pages.at(-1).url, "https://preview.example.test/demo/upsell-2/");
  assert.ok(!buildScope.excludedPages.some((page) => page.page_id === "upsell-2"));
  assert.ok(specForQaScope(updatedSpec, buildScope.excludedPages).funnels[0].pages.some((page) => page.id === "upsell-2"));
});

test("recorded partial scope selects checkout entry; missing declaration stays fail-closed", () => {
  const selected = scope();
  assert.deepEqual(selected.topologies[0].pages.map(p => p.page_id), ["checkout", "receipt"]);
  assert.equal(__qaNodeTestHooks.deriveEntryUrls(selected.topologies)[0].page_id, "checkout");
  assert.deepEqual(specForQaScope(spec, selected.excludedPages).funnels[0].pages.map(p => p.id), ["checkout", "receipt"]);
  assert.deepEqual(specForQaScope({ funnels: [], funnel_pages: spec.funnels[0].pages }, selected.excludedPages).funnel_pages.map(p => p.id), ["checkout", "receipt"]);
  assert.equal(scope({ report: {} }).topologies[0].pages.length, 4);
  assert.equal(scope({ packet: { source_html: { pages: [] } } }).topologies[0].pages.length, 4);
});

test("materialized stock rejoins QA but missing in-scope checkout never disappears", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-scope-built-"));
  try {
    mkdirSync(join(dir, "_site/demo/landing"), { recursive: true });
    writeFileSync(join(dir, "_site/demo/landing/index.html"), "<main>Opted in</main>");
    assert.deepEqual(scope({ targetRepo: dir }).topologies[0].pages.map(p => p.page_id), ["landing", "checkout", "receipt"]);
    for (const url of [null, "not-a-url"]) {
      const unresolved = topologies.map(t => ({ ...t, pages: t.pages.map(p => p.page_id === "landing" ? { ...p, url } : p) }));
      const selected = applyQaBuildScope(unresolved, { packet, report, targetRepo: dir, publicRouteSlug: "demo" });
      assert.ok(selected.topologies[0].pages.some(p => p.page_id === "landing"), "unresolved materialized page must remain visible");
    }
    const rooted = topologies.map(t => ({ ...t, pages: t.pages.map(p => ({ ...p, url: p.url.replace("/demo/", "/") })) }));
    assert.ok(applyQaBuildScope(rooted, { packet, report, targetRepo: dir, publicRouteSlug: "demo" }).topologies[0].pages.some(p => p.page_id === "landing"), "root-served URL matches the built relative route");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("partial fixture emits skipped evidence without requesting absent routes; unfiltered mutation yields blockers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-scope-verdict-"));
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async input => {
    const url = String(input);
    requests.push(url);
    const missing = /\/(presell|landing)\//.test(url);
    return new Response(missing ? "Not found" : "<html><body><main>Built route</main></body></html>", { status: missing ? 404 : 200, headers: { "content-type": "text/html" } });
  };
  const resolved = {
    themeGate: { status: "not_applicable", code: "theme_gate.policy_off", reason: "fixture" },
    polishGate: { status: "not_applicable", code: "polish.not_applicable", reason: "fixture" },
    checkpointGates: [], qaWaivers: {}, analyticsCaptureTarget: { url: null },
    brandContract: null, brandContractStatus: "not_evaluated", packetPath: null,
    mapId: "partial-scope", publicRouteSlug: "demo", proxyBase: "https://proxy.example.test",
    baseUrl: "https://preview.example.test/demo/", spec, rawSpec: spec,
    specVersion: "4.3", specHash: "sha256:partial-scope", ...scope(),
  };
  const args = { _: ["qa", "run"], "output-dir": dir, "no-post-verdict": true, "analytics-correctness": "false", json: true };
  try {
    const result = await __qaNodeTestHooks.runResolvedQa(args, resolved);
    const verdict = JSON.parse(readFileSync(result.local_path, "utf8"));
    const excluded = verdict.assertions.filter(a => ["presell", "landing"].includes(a.page));
    assert.equal(excluded.length, 2);
    assert.ok(excluded.every(a => a.status === "skipped" && a.evidence.reason === "out_of_build_scope"));
    assert.equal(computeDisposition(excluded), "ready");
    assert.equal(computeDisposition(verdict.assertions), computeDisposition(verdict.assertions.filter(a => !excluded.includes(a))), "scope skips are neutral to disposition");
    assert.ok(requests.length > 0 && requests.every(url => !/\/(presell|landing)\//.test(url)));
    assert.equal(result.entry_urls[0].page_id, "checkout");
    // Negative control executes the same runner with only the scope filter
    // removed. The absent pages now produce the original HTTP blockers.
    const mutation = await __qaNodeTestHooks.runResolvedQa(args, { ...resolved, topologies, excludedPages: [] });
    const mutatedVerdict = JSON.parse(readFileSync(mutation.local_path, "utf8"));
    for (const page_id of ["presell", "landing"]) {
      assert.ok(mutatedVerdict.assertions.some(a => a.page === page_id && a.status === "fail" && a.severity === "blocker"));
    }
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("partial entry is the first in-scope select even if a later landing remains", () => {
  const entries = __qaNodeTestHooks.deriveEntryUrls([{ partial_build_scope: true, pages: [
    { page_id: "select", page_type: "select", url: "https://preview.example.test/select/" },
    { page_id: "landing", page_type: "landing", url: "https://preview.example.test/landing/" },
  ] }]);
  assert.equal(entries[0].page_id, "select");
});
