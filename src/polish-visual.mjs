import { mkdirSync, writeFileSync, realpathSync, lstatSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute, sep, dirname } from "node:path";
import { aggregateQcResults, buildQcResult } from "./qc-results.mjs";
import { readPngStructure, sha256Hex, boundedDimensions, VISUAL_MAX_DECODE_PIXELS } from "./png-header.mjs";
import { CAPTURES_SCHEMA, CAPTURES_PRODUCER, capturesIntegrity } from "./polish-captures-record.mjs";
import { pairCompatibility, pageCompatibility, compareImages, compareBands, readRgba, releaseComparison, DIFF_OPTIONS } from "./visual-diff.mjs";
import { loadVisualDependencies, encodeHeatmap } from "./visual-diff.mjs";
import { verifyReference, classifyProvenance } from "./visual-reference.mjs";
import { computeDesignSourcePackageMaterialFingerprint } from "./design-source-package.mjs";
import { currentSourcePackageMaterialFingerprint } from "./polish-gate.mjs";
import { startSourceHtmlServer, readRegularFileSync, isRegularFileSync } from "./source-html-server.mjs";
import { boundedPolishDeadline, runWithPolishProducerDeadline, POLISH_PRODUCER_TIMEOUT_ERROR_CODE,
  POLISH_CAPTURE_CELL_DEADLINE_MS, POLISH_CAPTURE_STARTUP_DEADLINE_MS, POLISH_CAPTURE_CLOSE_DEADLINE_MS,
  VISUAL_CAPTURE_RUN_MS, VISUAL_DIFF_RUN_MS, VISUAL_ADDED_RUN_MS } from "./polish-deadline.mjs";

const object = (value) => value !== null && typeof value === "object"
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : undefined;

export { CAPTURES_SCHEMA, CAPTURES_PRODUCER, capturesIntegrity };
export const VISUAL_STATE = "default_load";
export const VISUAL_MASKS = "visual-masks/v1";
export const VISUAL_SECTION_KEYS = "visual-sections/v1";
export const VISUAL_TREATMENT = "visual-treatment/v1";
export { VISUAL_MAX_DECODE_PIXELS };
export const VISUAL_LIMITS = Object.freeze({ readiness_fonts_ms: 3000, readiness_await_ms: 5000, shot_ms: 10000,
  capture_ms_per_run: 240000, diff_ms_per_run: 60000, added_ms_per_run: 300000,
  capture_height_px: 12000, decode_pixels: VISUAL_MAX_DECODE_PIXELS, bands_per_page: 40,
  references_per_cell: 4, reference_bytes: 67108864, tile_px: 32, worst_tiles_per_band: 3, artifact_bands: 3 });
export const VISUAL_VIEWPORTS = Object.freeze([
  Object.freeze({ key: "desktop", width: 1440, height: 1200 }), Object.freeze({ key: "mobile", width: 390, height: 844 }),
]);
export const VISUAL_VOCABULARY = Object.freeze({
  side: ["build", "source_html"], state: [VISUAL_STATE],
  cell_status: ["rendered", "navigation_failed", "http_error", "run_budget_exhausted", "producer_timeout", "browser_unavailable", "source_html_missing", "source_root_unavailable"],
  shot_status: ["captured", "timeout", "failed", "skipped"], dependency_status: ["available", "missing", "failed"],
  verification_level: ["decoded", "header_checked", "unverifiable"], provenance_class: ["declared_source", "self_referential", "unknown"],
  comparison_status: ["compared", "unsupported", "unavailable", "not_run"],
  section_status: ["measured", "no_section_keys", "probe_failed"],
  fonts_status: ["settled", "timeout"], await_status: ["settled", "not_present", "timeout"],
  networkidle_status: ["settled", "timeout", "invalid"],
  verification_reason: ["file_missing", "path_outside_source_root", "remote_not_fetched", "too_large", "not_png", "ihdr_invalid", "truncated", "chunk_crc_mismatch", "image_too_large", "decode_failed", "verify_budget_exhausted", "recorded_hash_mismatch", "recorded_dimensions_mismatch"],
  startup: ["ok", "failed", "producer_timeout"], close: ["ok", "failed", "producer_timeout", "not_started"],
  source_status: ["available", "missing"], mask_group: ["timer", "price"],
  part_reason: ["capture_truncated", "section_mapping_missing", "section_mapping_duplicate", "section_not_rendered", "beyond_capture_height", "band_cap_reached", "source_section_offsets_unrecorded", "no_section_keys"],
});

export function planVisualCapture(plan, viewports = plan?.viewports) {
  if (!plan) return null;
  if (!Array.isArray(plan.routes) || !Array.isArray(viewports)) throw new TypeError("A computed page_load plan and viewports are required");
  if (plan.routes.some((route) => !object(route)) || viewports.some((v) => !object(v)
      || !VISUAL_VIEWPORTS.some((fixed) => fixed.key === own(v, "key") && fixed.width === v.width && fixed.height === v.height))) return null;
  return { route_scope: plan.route_scope, routes: structuredClone(plan.routes), viewports: structuredClone(viewports),
    cells: plan.routes.flatMap((route) => viewports.flatMap((viewport) => ["build", "source_html"].map((side) => ({
      side, page_id: route.page_id, route: route.requested_route ?? route.route ?? route,
      viewport: viewport.key, width: viewport.width, height: viewport.height, device_scale_factor: 1, state: VISUAL_STATE,
    })))) };
}

// Read-only isolated-world section probe. Keys are sanitized on the host.
function visualSections() {
  const primary = document.querySelectorAll("[data-section]").length > 0;
  const selector = primary ? "[data-section]" : "section[id],header[id],footer[id]";
  const elements = [...document.querySelectorAll(selector)].filter((el) => !el.parentElement?.closest(selector));
  const bands = elements.slice(0, 40).map((el) => {
    const r = el.getBoundingClientRect();
    return { key: primary ? `data-section:${el.getAttribute("data-section")}` : `#${el.id}`,
      top: r.y + scrollY, height: r.height, left: r.x + scrollX, width: r.width };
  });
  return { status: elements.length ? "measured" : "no_section_keys", bands, capped: elements.length > 40 };
}
const monotonicClock = { now: () => performance.now() };
const timedOut = (error) => error?.code === POLISH_PRODUCER_TIMEOUT_ERROR_CODE;
const safeSectionKey = (key) => {
  const prefix = key.startsWith("data-section:") ? "data-section:" : "#";
  const value = key.slice(prefix.length);
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? key : `sha256:${sha256Hex(key).slice(0, 12)}`;
};
function sectionsFrom(probe) {
  if (probe?.status !== "measured" || !Array.isArray(probe.value?.bands)) return { status: "probe_failed", bands: [], duplicated_keys: [], capped: false };
  const bands = probe.value.bands.map((band) => ({ ...band, key: safeSectionKey(band.key) }));
  return { status: probe.value.status, bands, duplicated_keys: [...new Set(bands.filter((b, i) => bands.some((c, j) => j < i && c.key === b.key)).map((b) => b.key))].sort(), capped: probe.value.capped };
}
function blankCell(cell, status) {
  const shot = () => ({ status: "skipped", png: null, full_height_css: null, crop: null, truncated: false });
  return { ...cell, status, source_path_rel: null, source_sha256: null,
    networkidle: { status: "invalid", duration_ms: null },
    readiness: { fonts: { status: "timeout", failed_faces: 0, waited_ms: 0 }, await: { status: "timeout", remaining_count: 0, waited_ms: 0 } },
    external: cell.side === "source_html" ? { blocked_count: 0, blocked_websocket_count: 0, blocked_origins: [] } : null,
    sections: { status: "probe_failed", bands: [], duplicated_keys: [], capped: false }, actual: shot(),
    stabilized: { ...shot(), treatment: { animations: "disabled", caret: "hide", mask_color: "#ff00ff", mask_selectors: VISUAL_MASKS, masks: [], mask_cap_reached: false } }, captured_at: null };
}

// verifyReference opens its path with a blocking open. A declared path whose
// realpath is a FIFO, socket, device or directory is refused here, without
// blocking, as the read step's file_missing (the reason a directory reads).
async function verifyDeclared(args) {
  let resolved = null;
  try { resolved = realpathSync(resolve(args.sourceRoot || ".", args.path)); } catch { /* verifyReference reads file_missing */ }
  if (!args.path || !resolved || isRegularFileSync(resolved)) return verifyReference(args);
  const refused = await verifyReference({ ...args, path: null, url: undefined });
  return { ...refused, path_rel: relative(args.targetRepo || args.sourceRoot || ".", resolved), url_present: Boolean(args.url),
    provenance: classifyProvenance({ ...args, path: resolved, sha256: null }) };
}

export function unavailableCapturesRecord({ plan, subject, measuredAt } = {}) {
  return buildCapturesRecord({ subject, cells: planVisualCapture(plan).cells.map((cell) => blankCell(cell, "browser_unavailable")), measuredAt });
}

export async function runVisualCells({ buildAdapter, sourceAdapter, pairs, sourceOrigin, probes = [],
  budget = {}, clock = monotonicClock, writePng, sources = new Map(), now = new Date(), captureCellDeadlineMs, timers = {} } = {}) {
  const cells = [], poisoned = new Set();
  const remaining = () => typeof budget.remaining === "function" ? budget.remaining() : VISUAL_CAPTURE_RUN_MS;
  for (const planned of pairs.cells || pairs) {
    const cell = blankCell(planned, "browser_unavailable");
    const source = sources.get(cell.page_id);
    if (source && cell.side === "source_html") Object.assign(cell, { source_path_rel: source.path_rel, source_sha256: source.identity?.sha256 });
    const adapter = cell.side === "build" ? buildAdapter : sourceAdapter;
    if (remaining() <= 0) cell.status = "run_budget_exhausted";
    else if (poisoned.has(cell.side)) cell.status = "producer_timeout";
    else if (cell.side === "source_html" && source?.input_reason) cell.status = source.input_reason;
    else if (adapter) {
      const route = pairs.routes?.find((r) => r.page_id === cell.page_id);
      const identity = { side: cell.side, page_id: cell.page_id, route: cell.route, viewport: cell.viewport };
      const selected = probes.map((probe) => ({ ...probe,
        select: probe.select ? () => probe.select(identity) : undefined,
        onResult: probe.onResult ? (result) => probe.onResult(identity, result) : undefined }));
      const controller = new AbortController();
      try {
        const result = await runWithPolishProducerDeadline(() => adapter.renderForCompare({
          url: cell.side === "build" ? route?.url : new URL(source.url_path, sourceOrigin).href,
          viewport: { key: cell.viewport, width: cell.width, height: cell.height }, deviceScaleFactor: 1, signal: controller.signal,
          requestPolicy: cell.side === "source_html" ? { allowOrigin: sourceOrigin } : null,
          readiness: { fontsMs: VISUAL_LIMITS.readiness_fonts_ms, awaitMs: VISUAL_LIMITS.readiness_await_ms },
          probes: [{ name: "visual_sections", source: visualSections.toString(), args: [], boundMs: 1500 }, ...selected],
          shots: { actual: true, stabilized: { masks: VISUAL_MASKS, animations: "disabled", caret: "hide", maskColor: "#ff00ff" } },
          maxHeightPx: VISUAL_LIMITS.capture_height_px, budget: { clock, addedRemainingMs: remaining() },
        }), { ...timers, timeoutMs: Math.max(1, Math.min(remaining(), boundedPolishDeadline(captureCellDeadlineMs, POLISH_CAPTURE_CELL_DEADLINE_MS))),
          onTimeout: () => controller.abort() });
        cell.status = result.status;
        for (const key of ["networkidle", "readiness", "external"]) if (result[key]) cell[key] = result[key];
        cell.sections = sectionsFrom(result.probes?.visual_sections);
        cell.probes = result.probes || {};
        for (const key of ["actual", "stabilized"]) {
          const shot = result[key];
          if (!shot) continue;
          const { bytes, ...metadata } = shot;
          // A shot skipped before capture still carries the recorded treatment.
          cell[key] = { ...metadata, png: null, ...(key === "stabilized" ? { treatment: metadata.treatment ?? cell.stabilized.treatment } : {}) };
          if (shot.status === "captured") {
            try { cell[key].png = writePng(bytes); } catch { cell[key].status = "failed"; }
          }
        }
        cell.captured_at = new Date(now).toISOString();
      } catch (error) {
        cell.status = timedOut(error) ? "producer_timeout" : "navigation_failed";
        if (timedOut(error)) poisoned.add(cell.side);
      }
    }
    cells.push(cell);
  }
  return cells;
}

// All resources and failures here belong solely to captures. The frozen input
// is never passed to a browser, a probe callback or an artifact writer.
export async function runVisualPass({ createBrowserAdapter, frozen, packet, packetPath, report, targetRepo,
  headed = false, authCookie = null, probes = [], budget = {}, clock = monotonicClock,
  adapterStartupDeadlineMs, adapterCloseDeadlineMs, captureCellDeadlineMs, now = new Date(), dependencies, timers = {} } = {}) {
  const plan = planVisualCapture(frozen.plan);
  // `timers` ({ setTimer, clearTimer }) lets a test fire a deadline without wall-clock time.
  const bounded = (operation, options) => runWithPolishProducerDeadline(operation, { ...timers, ...options });
  if (!plan) return null;
  const started = clock.now(), realStarted = performance.now();
  const captureMs = boundedPolishDeadline(budget.captureMs, VISUAL_CAPTURE_RUN_MS);
  const addedMs = boundedPolishDeadline(budget.addedMs, VISUAL_ADDED_RUN_MS);
  const addedLeft = () => Math.min(addedMs - (clock.now() - started), addedMs - (performance.now() - realStarted));
  const captureLeft = () => Math.min(captureMs - (clock.now() - started), captureMs - (performance.now() - realStarted), addedLeft());
  const closeMs = boundedPolishDeadline(adapterCloseDeadlineMs, POLISH_CAPTURE_CLOSE_DEADLINE_MS);
  const adapters = { build: { startup: "failed", close: "not_started" }, source: { startup: "failed", close: "not_started", sealed: true } };
  const instances = {}, sources = new Map(), references = [], comparisons = [];
  let server = null, cells = [], root = null, rootAvailable = false;
  let dsp = null, dspReason = "source_package_unavailable";
  try {
    if (typeof packet.source_html?.root === "string") root = resolve(dirname(packetPath), packet.source_html.root);
    if (root) rootAvailable = statSync(root).isDirectory();
  } catch { /* source root is absent */ }
  const source = { root_rel: root ? relative(targetRepo, root) : null, status: rootAvailable ? "available" : "missing", server: "loopback_read_only" };
  try {
    const path = packet.design_source_package?.path;
    if (path) {
      dsp = JSON.parse(readRegularFileSync(resolve(dirname(packetPath), path)).toString("utf8"));
      dspReason = computeDesignSourcePackageMaterialFingerprint(dsp) === currentSourcePackageMaterialFingerprint(report) ? null : "source_package_stale";
    }
  } catch { /* unavailable, never fetch */ }
  const builtHtmlHashes = [];
  for (const route of plan.routes) {
    const slug = report.identity.public_route_slug;
    const suffix = route.requested_route.replace(new RegExp(`^/${slug}/?`), "");
    try { builtHtmlHashes.push(`sha256:${sha256Hex(readRegularFileSync(resolve(targetRepo, "_site", slug, suffix, "index.html"), { root: targetRepo }))}`); } catch { /* missing or non-regular output */ }
  }
  const contribution = dsp?.contributions?.find((c) => c.kind === "html_funnel");
  const pageKitTargets = (packet.source_html.pages || []).map((p) => p.page_kit?.target_path).filter(Boolean);
  for (const route of plan.routes) {
    const mapping = packet.source_html.pages.find((p) => p.page_id === route.page_id);
    const declared = contribution?.source_refs?.find((ref) => ref.kind === "html_file" && ref.path === mapping.path);
    const ref = { ...await verifyDeclared({ path: mapping.path, sourceRoot: root || targetRepo, targetRepo,
      kind: "source_html", recorded: declared || {}, builtHtmlHashes, pageKitTargets }),
      page_id: route.page_id, route: route.requested_route, viewport: null, ref_id: "source_html" };
    if (!rootAvailable) ref.input_reason = "source_root_unavailable";
    else if (!ref.identity.sha256 || ref.verification.reason) ref.input_reason = "source_html_missing";
    // Only files contained by the serving root may be rendered, including a
    // self-referential source which verification can otherwise read for QC.
    try { const rel = relative(realpathSync(root), realpathSync(resolve(root, mapping.path)));
      if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) ref.input_reason = "source_html_missing";
      ref.url_path = `/${rel.split(sep).map(encodeURIComponent).join("/")}`;
    } catch { ref.input_reason ||= rootAvailable ? "source_html_missing" : "source_root_unavailable"; }
    sources.set(route.page_id, ref);
    const { url_path, ...persisted } = ref; references.push(persisted);
  }
  try {
    if (rootAvailable && captureLeft() > 0) {
      const abort = new AbortController();
      server = await bounded(() => startSourceHtmlServer({ root, signal: abort.signal }),
        { timeoutMs: Math.max(1, Math.min(closeMs, captureLeft())), onTimeout: () => abort.abort() });
    }
    for (const side of ["build", "source"]) {
      if ((side === "source" && !server) || captureLeft() <= 0) continue;
      let abandoned = false;
      const promise = Promise.resolve().then(() => createBrowserAdapter({ headed,
        authCookie: side === "build" ? authCookie : null, ...(side === "source" ? { seal: { origin: server.origin, port: server.port } } : {}) }));
      void promise.then((late) => { if (abandoned) void bounded(() => late.close(), { timeoutMs: closeMs, unrefTimer: true }).catch(() => {}); }, () => {});
      try {
        instances[side] = await bounded(() => promise, {
          timeoutMs: Math.max(1, Math.min(captureLeft(), boundedPolishDeadline(adapterStartupDeadlineMs, POLISH_CAPTURE_STARTUP_DEADLINE_MS))),
          onTimeout: () => { abandoned = true; } });
        adapters[side].startup = "ok";
      } catch (error) { adapters[side].startup = timedOut(error) ? "producer_timeout" : "failed"; }
    }
    cells = await runVisualCells({ buildAdapter: instances.build, sourceAdapter: instances.source, pairs: plan,
      sourceOrigin: server?.origin, sources, probes, clock, now, captureCellDeadlineMs, timers,
      budget: { remaining: captureLeft }, writePng: (bytes) => writePolishPng(targetRepo, "captures", bytes) });
  } catch {
    // A source listener/setup failure must still yield the complete grid.
    cells = plan.cells.map((cell) => blankCell(cell, cell.side === "source_html" ? "source_root_unavailable" : "browser_unavailable"));
  } finally {
    for (const side of ["build", "source"]) if (instances[side]) {
      try { await bounded(() => instances[side].close(), { timeoutMs: Math.max(1, Math.min(closeMs, addedLeft())) }); adapters[side].close = "ok"; }
      catch (error) { adapters[side].close = timedOut(error) ? "producer_timeout" : "failed"; }
    }
    if (server) try { await bounded(() => server.close(), { timeoutMs: Math.max(1, Math.min(closeMs, addedLeft())) }); } catch { /* listener closes all sockets synchronously */ }
  }
  const diffStarted = clock.now(), diffRealStarted = performance.now();
  const diffMs = boundedPolishDeadline(budget.diffMs, VISUAL_DIFF_RUN_MS);
  const diffLeft = () => Math.min(diffMs - (clock.now() - diffStarted), diffMs - (performance.now() - diffRealStarted), addedLeft());
  dependencies ||= await loadVisualDependencies();
  const captureHashes = cells.flatMap((c) => [c.actual?.png?.sha256, c.stabilized?.png?.sha256]).filter(Boolean);
  for (const route of plan.routes) {
    const surface = dsp?.surface_identity?.find((s) => [s.mappings?.campaign_spec_page_id, s.mappings?.source_page_id].includes(route.page_id));
    const coverage = contribution?.mappings?.find((m) => m.surface_id === surface?.id);
    const refs = (coverage?.screenshot_refs || []).map((id) => contribution.screenshot_refs?.find((r) => r.id === id)).filter(Boolean);
    const counts = new Map();
    for (const declared of refs) {
      const viewport = declared.viewport ?? null, count = counts.get(viewport) || 0; counts.set(viewport, count + 1);
      if (count >= 4) continue;
      const linkedDeclared = contribution?.source_refs?.find((r) => r.id === declared.source_ref_id && r.kind === "html_file");
      const mapping = packet.source_html.pages.find((p) => p.page_id === route.page_id);
      const linkedSource = !linkedDeclared ? null : linkedDeclared.path === mapping.path ? sources.get(route.page_id)
        : await verifyDeclared({ path: linkedDeclared.path, sourceRoot: root || targetRepo, targetRepo, kind: "html_file",
          recorded: linkedDeclared, builtHtmlHashes, pageKitTargets });
      const ref = { ...await verifyDeclared({ path: declared.path, url: declared.url, recorded: declared, sourceRoot: root || targetRepo, targetRepo,
        decoder: dependencies.decoder, budget: { remaining: diffLeft }, buildCaptureHashes: captureHashes, linkedSource }),
        page_id: route.page_id, route: route.requested_route, viewport, ref_id: declared.id };
      if (!rootAvailable) ref.input_reason = "source_root_unavailable";
      else if (dspReason) ref.input_reason = dspReason;
      if (refs.filter((r) => r.viewport === declared.viewport).length > 4) ref.reference_cap_reached = true;
      references.push(ref);
    }
  }
  const imageSource = (png) => ({ width: png.width_px, height: png.height_px,
    load: () => dependencies.decoder.decode(readRegularFileSync(resolve(targetRepo, png.path), { maxBytes: png.bytes, root: targetRepo, noFollow: true })) });
  for (const build of cells.filter((c) => c.side === "build")) {
    const basis = cells.find((c) => c.side === "source_html" && c.route === build.route && c.viewport === build.viewport);
    const refs = references.filter((r) => r.route === build.route && r.ref_id !== "source_html" && (r.viewport === build.viewport
      || (build.viewport === plan.viewports[0].key && !["desktop", "mobile"].includes(r.viewport))));
    for (const reference of [null, ...refs]) {
      let comparison = { page_id: build.page_id, route: build.route, viewport: reference?.viewport ?? build.viewport,
        basis: reference ? "reference" : "source_html", ref_id: reference?.ref_id ?? null,
        build_shot: reference ? "actual" : "stabilized", basis_shot: reference ? "image" : "stabilized",
        status: "not_run", reason: null, page: null, bands: [], members: [], artifacts: [], limits: [], diff_options: { ...DIFF_OPTIONS } };
      const ref = reference || references.find((r) => r.ref_id === "source_html" && r.route === build.route);
      const context = { record: { dependencies }, build, basis, reference: ref, budgetExhausted: diffLeft() <= 0 };
      const decision = evaluateVisualDiff(comparison, context);
      if (["visual_diff_diagnostic", "comparison_unsupported"].includes(decision.reason_code) || (decision.reason_code === "comparison_unsupported" && !reference)) {
        try {
          if (diffLeft() <= 0) { comparison.status = "unavailable"; comparison.reason = "diff_budget_exhausted"; }
          else if (build[comparison.build_shot]?.png && (reference || basis?.stabilized?.png)) {
            const artifacts = [];
            comparison = compareVisualPair({ build, basis, reference,
              buildImage: imageSource(build[comparison.build_shot].png),
              basisImage: reference ? { width: ref.verification.png.width_px, height: ref.verification.png.height_px,
                load: () => dependencies.decoder.decode(readRegularFileSync(resolve(targetRepo, ref.path_rel), { root: targetRepo })) } : imageSource(basis.stabilized.png),
              diff: dependencies.diff, onComparison: (part) => {
                if (diffLeft() <= 0) throw new Error("diff_budget_exhausted");
                // Keep at most three encoded triples; ranking is independent of QC.
                if (!part.mismatch_pixels || (!part.key && (basis?.sections?.bands?.length || build.sections?.bands?.length))) return;
                const rank = { key: part.key ?? "page", mismatch_ratio: part.mismatch_ratio, height_delta_px: part.height_delta_px };
                artifacts.push({ ...rank, images: [part.basis_crop, part.build_crop, part.heatmap].map((image) => {
                  if (diffLeft() <= 0) throw new Error("diff_budget_exhausted");
                  return encodeHeatmap(image, dependencies.decoder);
                }) });
                artifacts.sort((a, b) => b.mismatch_ratio - a.mismatch_ratio || Math.abs(b.height_delta_px) - Math.abs(a.height_delta_px) || a.key.localeCompare(b.key));
                if (artifacts.length > 3) artifacts.pop();
              } });
            comparison.artifacts = artifacts.map((artifact) => ({ band_key: artifact.key,
              ...Object.fromEntries(["basis_crop", "build_crop", "heatmap"].map((name, i) => [name, writePolishPng(targetRepo, "diff", artifact.images[i])])) }));
          }
        } catch (error) { comparison.status = "unavailable"; comparison.reason = error.message === "diff_budget_exhausted" ? error.message : "decode_failed"; }
      } else { comparison.status = "unavailable"; comparison.reason = decision.reason_code;
        if (decision.reason_code === "diff_unavailable" && diffLeft() <= 0) comparison.reason = "diff_budget_exhausted"; }
      if (reference) comparison.viewport = reference.viewport;
      comparisons.push(comparison);
    }
  }
  return buildCapturesRecord({ subject: { ...frozen.page_load.subject, source_package_material_fingerprint: currentSourcePackageMaterialFingerprint(report) }, environment: { browser: instances.build?.browserVersion ?? instances.source?.browserVersion ?? null, device_scale_factor: 1 },
    source, adapters, dependencies, cells: cells.map(({ probes: _probes, ...cell }) => cell), references, comparisons, measuredAt: now });
}

export function buildCapturesRecord({ subject, buildFingerprint, sourceFingerprint = null, slug, routes = [],
  routeScope = "all", cells = [], references = [], comparisons = [], environment = { browser: null, device_scale_factor: 1 },
  dependencies, adapters, source, measuredAt = new Date().toISOString() } = {}) {
  const dependencyMetadata = dependencies && Object.fromEntries(["decoder", "diff"].map((key) => {
    const dep = own(dependencies, key);
    return [key, object(dep) ? Object.fromEntries(Object.entries(dep).filter(([, value]) => typeof value !== "function")) : { status: "missing", version: null }];
  }));
  const metricsOnly = (part) => part && Object.fromEntries(Object.entries(part).filter(([key]) =>
    !["heatmap", "basis_crop", "build_crop", "mismatches", "mask", "worst_tiles"].includes(key)));
  const persistedComparisons = comparisons.map((comparison) => !object(comparison) ? comparison : ({ ...comparison, page: metricsOnly(comparison.page),
    bands: (comparison.bands || []).map((band) => !object(band) ? band : ({ ...metricsOnly(band), ...(band.worst_tiles ? { worst_tiles: band.worst_tiles } : {}) })) }));
  const record = structuredClone({ schema_version: CAPTURES_SCHEMA, performed_by: CAPTURES_PRODUCER,
    treatment_version: VISUAL_TREATMENT,
    subject: subject ?? { build_fingerprint: buildFingerprint, source_package_material_fingerprint: sourceFingerprint,
      campaign_slug: slug, route_scope: routeScope, routes, viewports: ["desktop", "mobile"] },
    environment, limits: { ...VISUAL_LIMITS }, dependencies: dependencyMetadata ?? {
      decoder: { status: "missing", version: null }, diff: { status: "missing", version: null } },
    adapters: adapters ?? { build: { startup: "failed", close: "not_started" }, source: { startup: "failed", close: "not_started", sealed: true } },
    source: source ?? { root_rel: null, status: "missing", server: "loopback_read_only" },
    cells, references, comparisons: persistedComparisons, measured_at: new Date(measuredAt).toISOString() });
  return { ...record, integrity: capturesIntegrity(record) };
}

// Inspect the entire existing chain before making any directory. In particular,
// recursive mkdir must never traverse an unchecked .campaign-runtime symlink.
export function containedWritePath(targetRepo, path) {
  const root = realpathSync(targetRepo);
  if (!statSync(root).isDirectory()) throw new Error("path_outside_target");
  const output = resolve(root, path), rel = relative(root, output);
  const inside = (value) => { const r = relative(root, value); return !isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`); };
  if (!inside(output)) throw new Error("path_outside_target");
  let current = root;
  for (const component of rel.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    try {
      lstatSync(current);
      if (!inside(realpathSync(current))) throw new Error("path_outside_target");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // A dangling symlink is not a missing directory.
      try { if (lstatSync(current).isSymbolicLink()) throw new Error("path_outside_target"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
  }
  return output;
}

export function writePolishPng(targetRepo, dir, bytes) {
  const directory = `.campaign-runtime/polish/${dir}`;
  if (!["captures", "diff"].includes(dir)) throw new TypeError("Invalid polish PNG directory");
  const structure = readPngStructure(bytes);
  if (!structure.ok) throw new Error(structure.reason);
  const root = realpathSync(targetRepo), output = containedWritePath(root, directory);
  const hex = sha256Hex(bytes), path = `${directory}/${hex}.png`;
  containedWritePath(root, `${directory}/.gitignore`);
  containedWritePath(root, path);
  mkdirSync(output, { recursive: true });
  try { writeFileSync(resolve(output, ".gitignore"), "*\n", { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  try { writeFileSync(resolve(root, path), bytes, { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const written = readRegularFileSync(resolve(root, path), { maxBytes: bytes.length, root, noFollow: true }), checked = readPngStructure(written);
  if (!checked.ok || sha256Hex(written) !== hex) throw new Error("png_write_verification_failed");
  return { path, sha256: `sha256:${hex}`, bytes: written.length,
    width_px: checked.ihdr.width_px, height_px: checked.ihdr.height_px };
}

const member = (key, reason_code, result = "unexercised", extra = {}) => ({ key, result, reason_code, ...extra });
export function evaluateVisualReference(reference) {
  if (!object(reference)) return { result: "unexercised", reason_code: "evidence_not_reproducible", members: [], accept_eligible: false };
  if (["source_root_unavailable", "source_html_missing", "source_package_unavailable", "source_package_stale"].includes(reference.input_reason)) {
    return { result: "unexercised", reason_code: reference.input_reason, members: [], accept_eligible: false };
  }
  const level = reference.verification?.level;
  const members = [level === "decoded" ? member("verification", null, "pass")
    : member("verification", level === "header_checked" ? "decoder_unavailable" : "reference_unverifiable")];
  members.push(reference.provenance?.class === "self_referential" ? member("provenance", "self_referential", "warning")
    : reference.provenance?.class === "declared_source" ? member("provenance", null, "pass") : member("provenance", "provenance_unknown", "review"));
  if (reference.reference_cap_reached) members.push(member("reference_cap", "reference_cap_reached"));
  return aggregateQcResults(members);
}

// The only diff decision table. Scores are intentionally absent from its predicates.
export function evaluateVisualDiff(comparison, { record, reference, build, basis, readerFailure = null,
  staleBinding = false, pageMissing = false, fileAbsent = false, budgetExhausted = false } = {}) {
  const stop = (reason_code, members = []) => ({ result: "unexercised", reason_code, members, accept_eligible: false });
  if (!object(comparison) || !object(record) || ![build, basis, reference].every((cell) => cell == null || object(cell))) return stop("evidence_not_reproducible");
  if ([comparison.members, comparison.bands].some((items) => items != null && (!Array.isArray(items) || items.some((item) => !object(item))))) return stop("evidence_not_reproducible");
  if (readerFailure) return stop("evidence_not_reproducible", [member("evidence", readerFailure)]);
  if (staleBinding) return stop("stale_binding");
  if (pageMissing) return stop("page_not_captured");
  const image = comparison.basis === "reference";
  if (image && (!build || build.viewport !== reference?.viewport)) return stop("comparison_unsupported", [member("viewport", "viewport_not_captured")]);
  const deps = [own(record.dependencies, "decoder"), own(record.dependencies, "diff")];
  if (deps.some((dep) => own(dep, "status") !== "available")) return stop("diff_unavailable", [member("dependencies", deps.some((dep) => own(dep, "status") === "failed") ? "dependency_failed" : "dependency_missing")]);
  const needed = image ? [["build", build, "actual"]] : [["build", build, "stabilized"], ["source_html", basis, "stabilized"]];
  const missing = needed.filter(([, cell, shot]) => cell?.status !== "rendered" || own(cell, shot)?.status !== "captured");
  if (missing.length) return stop("capture_unavailable", missing.map(([side, cell, shot]) => member(side, cell?.status !== "rendered" ? cell?.status || "cell_missing" : own(cell, shot)?.status || "shot_missing")));
  const ref = evaluateVisualReference(reference || {});
  if (ref.members.find((m) => m.key === "verification")?.result !== "pass") return stop("reference_not_usable");
  const pair = pairCompatibility(build, image ? reference : basis, { reference: image });
  if (!pair.ok) return stop("comparison_unsupported", [member("pair", pair.reason)]);
  if (fileAbsent) return stop("capture_file_absent");
  const readiness = needed.flatMap(([side, cell]) => [
    ...(cell.readiness?.fonts?.status === "timeout" ? [member(side, "fonts_timeout")] : []),
    ...(cell.readiness?.await?.status === "timeout" ? [member(side, "await_timeout")] : []),
  ]);
  if (readiness.length) return stop("readiness_incomplete", readiness);
  if (budgetExhausted || ["diff_budget_exhausted", "image_too_large"].includes(comparison.reason)) return stop("diff_unavailable", [member("diff", budgetExhausted ? "diff_budget_exhausted" : comparison.reason)]);
  const members = [...(comparison.members || []).map((m) => member(m.key, m.reason_code ?? m.reason, m.result || "unexercised"))];
  const add = (key, reason) => { if (!members.some((m) => m.key === key && m.reason_code === reason)) members.push(member(key, reason)); };
  if (comparison.page?.status === "unsupported") add("page", comparison.page.reason);
  for (const band of comparison.bands || []) if (band.status === "unsupported") add(band.key, band.reason);
  if (ref.members.find((m) => m.key === "provenance")?.result !== "pass") members.push(member("basis", "basis_not_independent", "review"));
  if (image) members.push(member("reference_capture", "reference_capture_unrecorded", "review", {
    observation: { unrecorded: ["treatment", "state", "crop_origin", "viewport_height"] } }));
  const compared = comparison.page?.status === "compared" || comparison.bands?.some((b) => b.status === "compared");
  return { result: compared ? "review" : "unexercised", reason_code: compared ? "visual_diff_diagnostic" : "comparison_unsupported", members, accept_eligible: false };
}

export function compareVisualPair({ build, basis, reference = null, buildImage, basisImage, diff, memory, onComparison } = {}) {
  if (!object(build) || (!reference && !object(basis))) return { status: "unavailable", reason: "capture_unavailable" };
  const image = Boolean(reference);
  const comparison = { page_id: build.page_id, route: build.route, viewport: build.viewport,
    basis: image ? "reference" : "source_html", ref_id: reference?.ref_id ?? null,
    build_shot: image ? "actual" : "stabilized", basis_shot: image ? "image" : "stabilized",
    status: "not_run", reason: null, members: [], page: null, bands: [], artifacts: [],
    limits: image ? ["top_anchored", "reference_viewport_height_unrecorded"] : ["masks_unioned", "js_animation_not_frozen"], diff_options: { ...DIFF_OPTIONS } };
  const compatible = pairCompatibility(build, reference || basis, { reference: image });
  if (!compatible.ok) return { ...comparison, status: "unsupported", reason: compatible.reason };
  for (const cell of image ? [] : [build, basis]) {
    const masks = cell?.stabilized?.treatment?.masks ?? [];
    if (!Array.isArray(masks) || masks.some((group) => !object(group) || !["timer", "price"].includes(own(group, "group"))
        || !Array.isArray(group.rects) || group.rects.some((rect) => !object(rect)))) return { ...comparison, status: "unavailable", reason: "evidence_not_reproducible" };
  }
  const rects = (cell) => (cell?.stabilized?.treatment?.masks || []).flatMap((group) => group.rects)
    .map((r) => Object.fromEntries(Object.entries(r).map(([key, value]) => [key, value * cell.device_scale_factor])));
  const rectsA = image ? [] : rects(basis), rectsB = image ? [] : rects(build);
  if (basis?.external?.blocked_count > 0) comparison.limits.push("source_external_blocked");
  const page = pageCompatibility(own(build, comparison.build_shot), image ? null : basis.stabilized);
  try {
    boundedDimensions(basisImage?.width, basisImage?.height); boundedDimensions(buildImage?.width, buildImage?.height);
    const hasBands = !image && (basis.sections?.bands?.length || build.sections?.bands?.length);
    if (hasBands && [basisImage, buildImage].some((source) => typeof own(source, "load") !== "function" || source.data != null)) throw new RangeError("image_source_required");
    comparison.page = page.ok ? compareImages(readRgba(basisImage, memory), readRgba(buildImage, memory), { diff, rectsA, rectsB, memory })
      : { status: "unsupported", reason: page.reason, width_delta_px: null, height_delta_px: null,
        canvas: null, masked_pixels: null, mismatch_pixels: null, compared_pixels: null, mismatch_ratio: null };
    try { if (page.ok) onComparison?.(comparison.page); } finally { releaseComparison(comparison.page, memory); }
    if (hasBands) Object.assign(comparison, compareBands(basisImage, buildImage, { basisSections: basis.sections, buildSections: build.sections, rectsA, rectsB, diff, dpr: build.device_scale_factor, memory, onComparison }));
    else if (!image) comparison.members.push(member("sections", "no_section_keys"));
    else comparison.members.push(member("sections", "source_section_offsets_unrecorded"));
    comparison.status = comparison.page.status === "compared" || comparison.bands.some((band) => band.status === "compared") ? "compared" : "unsupported";
  } catch (error) {
    if (error.message !== "image_too_large") throw error;
    comparison.status = "unavailable"; comparison.reason = "image_too_large";
  }
  return comparison;
}

function evaluate(record, context = {}) {
  if (!object(record) || ![record.cells, record.references, record.comparisons].every(Array.isArray)) return [];
  const malformed = [record.cells, record.references, record.comparisons].some((items) => items.some((item) => !object(item)));
  if (malformed) {
    const clean = { ...record, cells: record.cells.filter(object), references: record.references.filter(object), comparisons: record.comparisons.filter(object) };
    return evaluate(clean, { ...context, readerFailure: "record_shape_invalid" });
  }
  const failure = context.readerFailure || (record.treatment_version !== VISUAL_TREATMENT
    || record.cells.some((cell) => cell.state !== VISUAL_STATE || cell.stabilized?.treatment?.mask_selectors !== VISUAL_MASKS) ? "treatment_invalid" : null);
  const rows = [];
  const row = (check, item, decision) => {
    const subject = { check, page: item.route, ...(item.viewport == null ? {} : { viewport: item.viewport }),
      key: item.ref_id === "source_html" || item.basis === "source_html" ? "source_html" : `ref:${item.ref_id}` };
    rows.push(buildQcResult({ check, leg: "polish", subject, ...decision,
      state: { binding: record.subject, item, decision }, observation: item, measured_at: record.measured_at }));
  };
  const referenceCounts = new Map(), seenReferences = new Map(), cappedReferences = new Set();
  const referenceGroup = (ref) => JSON.stringify([ref.page_id, ref.route, ref.viewport]);
  const referenceKey = (ref) => JSON.stringify([ref.route, ref.viewport, ref.ref_id]);
  for (const ref of record.references) if (ref.ref_id !== "source_html") {
    const group = referenceGroup(ref); referenceCounts.set(group, (referenceCounts.get(group) || 0) + 1);
  }
  for (const original of record.references) {
    const group = referenceGroup(original), count = seenReferences.get(group) || 0;
    if (original.ref_id !== "source_html") {
      seenReferences.set(group, count + 1);
      if (count >= VISUAL_LIMITS.references_per_cell) { cappedReferences.add(referenceKey(original)); continue; }
    }
    const ref = referenceCounts.get(group) > VISUAL_LIMITS.references_per_cell
      ? { ...original, reference_cap_reached: true } : original;
    row("visual.reference", ref, failure
    ? { result: "unexercised", reason_code: "evidence_not_reproducible", members: [member("evidence", failure)] }
    : context.staleBinding ? { result: "unexercised", reason_code: "stale_binding" } : evaluateVisualReference(ref));
  }
  for (const comparison of record.comparisons) {
    if (comparison.basis === "reference" && cappedReferences.has(referenceKey(comparison))) continue;
    const find = (side) => record.cells.find((cell) => cell.side === side && cell.route === comparison.route && cell.viewport === comparison.viewport);
    const reference = record.references.find((ref) => ref.route === comparison.route && (comparison.basis === "source_html" ? ref.ref_id === "source_html" : ref.ref_id === comparison.ref_id && ref.viewport === comparison.viewport));
    row("visual.diff", comparison, evaluateVisualDiff(comparison, { ...context, record, reference,
      build: find("build"), basis: find("source_html"), readerFailure: failure }));
  }
  return rows;
}
export const VISUAL_QC_RULES = Object.freeze({ thresholds: Object.freeze({}), vocabulary: VISUAL_VOCABULARY,
  schema_version: CAPTURES_SCHEMA, limits: VISUAL_LIMITS, viewports: ["desktop", "mobile"], evaluate,
  rowKeys: (record) => evaluate(record).map((row) => row.subject) });
