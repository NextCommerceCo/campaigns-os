// Media weight and hosting: the sibling stages.polish.evidence.visual_review
// .media_weight record, built from the same Polish page-load observation as
// page_load, and the rules every reader re-derives its results with.
//
// The record holds measurements only. Its results are never stored: readers
// (src/qc-results.mjs readMediaWeight) check the record against its page_load
// capture first, then call MEDIA_WEIGHT_QC_RULES.evaluate on each cell
// (reached through src/qc-check-registry.mjs). The record stays out of the
// page_load capture, whose projection and integrity are unchanged.
//
// Per cell (one route × viewport):
// - resources[]: one per requested href, covering every ledger entry of the
//   capture once, each with its redirect chain in transfer order (requested
//   href first, final hop last); every byte field, `measurement`, `failed` and
//   `final_origin_equal` describe the final hop's ledger entry;
// - images[]: the <img> elements the image probe read after network
//   observation closed (at most 512), with natural and rendered size,
//   object-fit, loading and a hidden-ancestor flag; when the probe did not
//   complete each image keeps only its identity and its geometry is null;
// - videos[]: one per page_load <video> element, with the ledger entries it
//   fetched and whether a declared source has the document's origin.
//
// Two requested hrefs that share a redirect or final hop cannot each own the
// shared entry: the producer lists both chains as observed, and the reader,
// which requires every ledger entry in exactly one chain, reads that cell as
// evidence_not_reproducible (never pass). One requested href that stands for
// more than one chain (requested twice, answered once and redirected once)
// is bound to none (bindLedgerChain): the producer lists its ledger entries
// as one-hop chains, the same for either request order, and the reader
// refuses that cell the same way.
import {
  captureOrigin,
  captureProblemRecordCode,
  mediaFetchedResources,
  normalizeMediaElement,
  resourceLedgerSort,
  responseRecordResponses,
} from "./polish-capture.mjs";
import { MEDIA_WEIGHT_SCHEMA, QC_PRODUCERS, bindLedgerChain, mediaChainBinder, mediaWeightIntegrity } from "./qc-results.mjs";

export const MEDIA_WEIGHT_SCHEMA_VERSION = MEDIA_WEIGHT_SCHEMA;
export const MEDIA_WEIGHT_PRODUCER = QC_PRODUCERS.polish;

export const MEDIA_WEIGHT_THRESHOLDS = Object.freeze({ image_bytes: 500_000, oversize_factor: 2.0, min_natural_area: 250_000 });

export const MEDIA_WEIGHT_VOCABULARY = Object.freeze({
  capture_status: Object.freeze(["complete", "incomplete"]),
  probe_status: Object.freeze(["complete", "document_context_changed", "probe_timeout", "image_cap_reached", "probe_budget_exhausted"]),
  measurement: Object.freeze(["complete", "lower_bound", "unmeasured", "cached"]),
  object_fit: Object.freeze(["fill", "contain", "cover", "none", "scale-down"]),
  loading: Object.freeze(["eager", "lazy", "auto"]),
});

// The image probe's cost bounds: at most 512 <img> and 500 ms per cell, and
// at most 10 s of probe time per Polish run. Each cell's probe steps run
// inside the smaller of the cell bound and the run budget left, and the time
// they take is charged to the run budget. Cells that start after the run
// budget is spent start no probe step (probe_budget_exhausted, no images,
// so their oversize result is the one keyed "cell"). Every other cell first
// lists its <img> identities (element path, currentSrc, loading) in an
// isolated world, within listingBoundMs, so every image result of a cell
// whose probe was cut still names its image.
export const MEDIA_PROBE_LIMITS = Object.freeze({ imageCap: 512, cellBoundMs: 500, runBudgetMs: 10_000, listingBoundMs: 100 });

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const isPair = (value) => Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);

// ---------------------------------------------------------------------------
// Producer

const VISIBLE_STYLE = Object.freeze({ display: "inline", visibility: "visible" });

// The page_load ledger's identity for a URL, through the capture's own source
// normalizer so it matches the ledger exactly: resource_id (the sha256 of the
// canonical href, query included) and the origin+path it persists. Both are
// null for a URL the ledger cannot hold (data:, blob:, unresolvable, too long).
function ledgerIdentity(url, documentUrl) {
  if (!isNonEmptyString(url)) return { resource_id: null, url: null };
  const element = normalizeMediaElement({
    tag_name: "video",
    current_src: url,
    src_attribute: null,
    source_src_attributes: [],
    preload_attribute: null,
    computed_style: VISIBLE_STYLE,
    ancestor_styles: [],
  }, { documentUrl });
  const reference = element.source_references.find((candidate) => candidate.source_kind === "current_src");
  return { resource_id: reference?.resource_id ?? null, url: reference?.resource_id ? reference.url : null };
}

// The measurement class of a ledger entry, first match (contract 1.0 Polish
// reader checks): cached, unmeasured, lower_bound, complete.
function measurementOf(entry) {
  if (entry.cache_request_count > 0) return "cached";
  if (entry.unmeasured_request_count > 0) return "unmeasured";
  if (entry.canceled_request_count > 0 || entry.partial_request_count > 0) return "lower_bound";
  return "complete";
}

// Each requested href's observed hop sequences in transfer order, from the
// collector's response records (a redirect chain record keeps its hops in
// order; the ledger does not), keyed by the requested href's resource_id. A
// sequence whose hops do not all resolve to ledger entries is left out.
function observedSequences(responses, byId, documentUrl) {
  const sequences = new Map();
  for (const record of Array.isArray(responses) ? responses : []) {
    if (!isPlainObject(record) || captureProblemRecordCode(record)) continue;
    const hops = responseRecordResponses(record).map((hop) => ({
      resource_id: ledgerIdentity(hop?.url, documentUrl).resource_id,
      status: Number.isInteger(hop?.status) ? hop.status : null,
      mime_type: typeof hop?.mime_type === "string" ? hop.mime_type.toLowerCase() : null,
    }));
    if (!hops.length || hops.some((hop) => !byId.has(hop.resource_id))) continue;
    if (!sequences.has(hops[0].resource_id)) sequences.set(hops[0].resource_id, []);
    sequences.get(hops[0].resource_id).push(hops);
  }
  return sequences;
}

// The request chain of each requested href, keyed by its resource_id. The
// ledger decides which chain an href has (bindLedgerChain, the reader's own
// rule, so the producer and the reader cannot disagree and request order
// does not matter); the response records only order its hops. An href keeps
// the observed sequence with exactly the bound hop set and final hop, the
// least one in JSON order when several do. An href the ledger binds to more
// than one chain (ambiguous) keeps none: its entries are listed as one-hop
// chains below, which the reader refuses.
function requestChains(entries, byId, responses, documentUrl) {
  const chains = new Map();
  const sequences = observedSequences(responses, byId, documentUrl);
  for (const [requestedId, candidates] of sequences) {
    const binding = bindLedgerChain(requestedId, entries, byId);
    if (binding.status !== "bound") continue;
    const matching = candidates.filter((hops) => hops.at(-1).resource_id === binding.final.resource_id
      && new Set(hops.map((hop) => hop.resource_id)).size === hops.length
      && hops.length === binding.hops.size
      && hops.every((hop) => binding.hops.has(hop.resource_id)));
    if (matching.length) chains.set(requestedId, matching.map((hops) => JSON.stringify(hops)).sort()[0]);
  }
  return new Map([...chains].map(([requestedId, hops]) => [requestedId, JSON.parse(hops)]));
}

function cellResources(entries, chains) {
  const byId = new Map(entries.map((entry) => [entry.resource_id, entry]));
  const all = new Map(chains);
  const chained = new Set([...chains.values()].flatMap((hops) => hops.map((hop) => hop.resource_id)));
  for (const entry of entries) {
    if (chained.has(entry.resource_id)) continue;
    all.set(entry.resource_id, [{ resource_id: entry.resource_id, status: Array.isArray(entry.statuses) && entry.statuses.length ? entry.statuses[0] : null, mime_type: null }]);
  }
  return [...all.values()].map((hops) => {
    const first = byId.get(hops[0].resource_id);
    const final = byId.get(hops.at(-1).resource_id);
    return {
      resource_id: first.resource_id,
      url: first.url,
      type: final.resource_type,
      transferred_bytes: final.transferred_bytes,
      declared_bytes: final.declared_request_count > 0 ? final.declared_bytes : null,
      measurement: measurementOf(final),
      failed: final.failed_request_count > 0,
      chain: hops.map((hop) => ({ url: byId.get(hop.resource_id).url, resource_id: hop.resource_id, status: hop.status })),
      final_origin_equal: final.cross_origin_request_count === 0,
    };
  }).sort(resourceLedgerSort);
}

function cellVideos(capture, entries, documentOrigin) {
  const matchable = entries.filter((entry) => Array.isArray(entry?.match_resource_ids));
  return (Array.isArray(capture?.media) ? capture.media : [])
    .filter((element) => isPlainObject(element) && element.tag_name === "video" && Array.isArray(element.source_references))
    .map((element) => ({
      element_index: element.element_index,
      resource_ids: mediaFetchedResources(element, matchable).map((resource) => resource.resource_id).sort(),
      declared_origin_equal: element.source_references.some((reference) => captureOrigin(reference?.url) === documentOrigin),
    }));
}

const normalizedLoading = (value) => {
  const token = typeof value === "string" ? value.trim().toLowerCase() : "";
  return MEDIA_WEIGHT_VOCABULARY.loading.includes(token) ? token : "auto";
};

// The probe's <img> entries for the record. Geometry is kept only from a
// probe that completed; any other probe keeps each image's identity alone.
// An <img> binds by the identity it used: its currentSrc's resource_id (query
// included) when the ledger has that entry, else null (weight not_in_ledger).
// `vector` is whether its source is SVG: read from a data: URL's own type or
// from its request chain's final hop; null when neither can be read (a blob:
// or other non-http source, an http source with no ledger entry or no chain),
// which the rules never read as pass.
function cellImages(probe, chains, byId, documentUrl) {
  const complete = probe.status === "complete";
  return (Array.isArray(probe.images) ? probe.images : []).map((image) => {
    const identity = ledgerIdentity(image?.current_src, documentUrl);
    const resourceId = byId.has(identity.resource_id) ? identity.resource_id : null;
    const finalHop = resourceId ? chains.get(resourceId)?.at(-1) : null;
    let vector = null;
    if (image?.current_src === "data:") vector = image?.svg_data === true;
    else if (finalHop) vector = Boolean(finalHop.mime_type?.startsWith("image/svg+xml"));
    return {
      resource_id: resourceId,
      element_path: image?.element_path,
      complete: complete ? image?.complete : null,
      natural: complete ? image?.natural : null,
      rendered: complete ? image?.rendered : null,
      object_fit: complete ? image?.object_fit : null,
      loading: normalizedLoading(image?.loading),
      hidden: complete ? image?.hidden : null,
      vector,
    };
  });
}

// The probe status of a cell whose adapter returned no probe (the cell failed
// before it): the cell bound ended when the producer timed out, otherwise the
// document the probe needed was not there.
function missingProbe(capture) {
  const timedOut = (Array.isArray(capture?.problems) ? capture.problems : []).some((problem) => problem?.code === "producer_timeout");
  return { status: timedOut ? "probe_timeout" : "document_context_changed", dpr: null, images: [] };
}

export function buildMediaWeightCell({ route, viewport, capture, observation = null, probe = null }) {
  const imageProbe = isPlainObject(probe) && MEDIA_WEIGHT_VOCABULARY.probe_status.includes(probe.status) ? probe : missingProbe(capture);
  const documentUrl = observation?.finalDocumentUrl ?? capture?.document_response?.url ?? null;
  const documentOrigin = capture?.document_response?.final_origin ?? null;
  const entries = (Array.isArray(capture?.resource_ledger?.entries) ? capture.resource_ledger.entries : []).filter((entry) => isPlainObject(entry) && isNonEmptyString(entry.resource_id));
  const byId = new Map(entries.map((entry) => [entry.resource_id, entry]));
  const chains = requestChains(entries, byId, observation?.responses, documentUrl);
  return {
    route,
    viewport,
    dpr: typeof imageProbe.dpr === "number" && imageProbe.dpr > 0 ? imageProbe.dpr : null,
    document_origin: documentOrigin,
    page_load_integrity: capture?.integrity?.projection_fingerprint ?? null,
    capture_status: capture?.measurement_status ?? "incomplete",
    probe_status: imageProbe.status,
    resources: cellResources(entries, chains),
    images: cellImages(imageProbe, chains, byId, documentUrl),
    videos: cellVideos(capture, entries, documentOrigin),
  };
}

// The record for one Polish run. `subject` is the page_load subject;
// `uncapturedRoutes` are the public routes of spec pages the run skipped
// because they have no source mapping, which readers list as
// page_not_captured.
export function buildMediaWeightRecord({ pageLoad, cells, uncapturedRoutes = [], measuredAt = new Date().toISOString() }) {
  const record = {
    schema_version: MEDIA_WEIGHT_SCHEMA_VERSION,
    performed_by: MEDIA_WEIGHT_PRODUCER,
    measured_at: measuredAt,
    subject: structuredClone(pageLoad.subject),
    thresholds: { ...MEDIA_WEIGHT_THRESHOLDS },
    cells,
    uncaptured_routes: [...new Set(uncapturedRoutes)].sort(),
  };
  return { ...record, integrity: mediaWeightIntegrity(record) };
}

// ---------------------------------------------------------------------------
// Rules (contract 1.3 Result rules)

const CAPTURE_INCOMPLETE = "capture_incomplete";
// Contract 1.0 Polish reader checks (:163) and 1.3 Observations (:936): a
// result that cannot be re-derived reads unexercised / evidence_not_reproducible.
const NOT_REPRODUCIBLE = "evidence_not_reproducible";

function invalid(message) {
  throw new TypeError(`media_weight cell ${message}`);
}

// Scale s of the rendered box over the natural size, by object-fit; cover
// lets the cropped axis go uncounted.
function renderedScale(fit, [nw, nh], [rw, rh]) {
  const contain = Math.min(rw / nw, rh / nh);
  if (fit === "fill") return Math.sqrt((rw * rh) / (nw * nh));
  if (fit === "contain") return contain;
  if (fit === "scale-down") return Math.min(1, contain);
  if (fit === "cover") return Math.max(rw / nw, rh / nh);
  if (fit === "none") return 1;
  return invalid(`image object_fit ${JSON.stringify(fit)} is not in the vocabulary`);
}

// Weight per resource in a complete cell, first match.
function weightRule(resource, { video, image, thresholds }) {
  if (resource.failed) return ["unexercised", "not_loaded"];
  if (!resource.final_origin_equal) return resource.measurement === "complete" ? ["pass", null] : ["unexercised", "transfer_partial"];
  if (video) return ["warning", "video_from_document_origin"];
  if (!image) return ["pass", null];
  const over = resource.transferred_bytes > thresholds.image_bytes;
  if (resource.measurement === "complete") return over ? ["warning", "image_over_threshold"] : ["pass", null];
  if (resource.measurement === "lower_bound") {
    if (over) return ["warning", "image_over_threshold"];
    if (resource.declared_bytes !== null && resource.declared_bytes > thresholds.image_bytes) return ["review", "declared_over_threshold_unmeasured"];
  }
  return ["unexercised", "transfer_partial"];
}

// Oversizing per <img> in a cell whose probe completed, first match.
function oversizeRule(image, { requested, dpr, thresholds }) {
  if (typeof image.complete !== "boolean" || typeof image.hidden !== "boolean" || !isPair(image.natural) || !isPair(image.rendered)) {
    return invalid("image geometry is missing from a completed probe");
  }
  const [nw, nh] = image.natural;
  const [rw, rh] = image.rendered;
  if (image.loading === "lazy" && !requested && !image.complete) return { result: ["unexercised", "lazy_not_requested"] };
  if (!image.complete || nw === 0 || nh === 0) return { result: ["unexercised", "not_loaded"] };
  if (image.vector === true) return { result: ["unexercised", "vector_image"] };
  // A source whose type the capture could not read (vector null) may be SVG.
  if (image.vector === null) return { result: ["unexercised", "not_in_ledger"] };
  if (image.hidden || rw === 0 || rh === 0) return { result: ["unexercised", "not_rendered"] };
  const scale = renderedScale(image.object_fit, image.natural, image.rendered);
  const factor = 1 / (scale * dpr);
  const area = nw * nh;
  const oversized = factor >= thresholds.oversize_factor && area >= thresholds.min_natural_area;
  return { result: oversized ? ["warning", "image_oversized"] : ["pass", null], scale, factor, area };
}

// The probe statuses a cost cap sets: the image cap, the cell bound and the
// run budget.
const PROBE_COST_CAPS = Object.freeze(["image_cap_reached", "probe_timeout", "probe_budget_exhausted"]);

// The results of one media_weight cell, judged with `thresholds`: one
// media.weight result per resource, per unfetched <video> ("video:<index>")
// and per probed <img> whose currentSrc has no ledger entry
// ("img:<element_path>"); one media.oversize result per probed <img>
// ("<resource_id>:<element_path>"), or one keyed "cell" when the cell lists
// no <img>. Evaluation order: an incomplete capture makes every result
// capture_incomplete; a probe that did not complete makes every oversize
// result unexercised with its probe status. A cell a probe cost cap ended
// (the image cap, the cell bound or the run budget) adds the page_coverage
// member with that cap's code to every result, so none reads pass and none
// is accept-eligible.
export function evaluateMediaWeight(cell, thresholds = MEDIA_WEIGHT_THRESHOLDS) {
  if (!isPlainObject(cell)) invalid("is not an object");
  if (!isPlainObject(thresholds) || !["image_bytes", "oversize_factor", "min_natural_area"].every((field) => Number.isFinite(thresholds[field]))) {
    invalid("thresholds are not the 1.3 thresholds");
  }
  const resources = Array.isArray(cell.resources) ? cell.resources : invalid("has no resources[]");
  const images = Array.isArray(cell.images) ? cell.images : invalid("has no images[]");
  const videos = Array.isArray(cell.videos) ? cell.videos : invalid("has no videos[]");
  const incomplete = cell.capture_status !== "complete";
  const probeComplete = cell.probe_status === "complete";
  if (!incomplete && probeComplete && !(typeof cell.dpr === "number" && cell.dpr > 0)) invalid("has no observed device pixel ratio");
  const cap = PROBE_COST_CAPS.includes(cell.probe_status) ? { key: "page_coverage", result: "unexercised", reason_code: cell.probe_status } : null;

  const results = [];
  const push = (check, key, [base, baseReason], state, observation) => {
    let result = base;
    let reasonCode = baseReason;
    if (cap && result === "pass") [result, reasonCode] = ["unexercised", cap.reason_code];
    const members = cap ? [{ ...cap }] : [];
    results.push({
      check,
      subject: { check, page: cell.route, viewport: cell.viewport, key },
      result,
      reason_code: result === "pass" ? null : reasonCode,
      members,
      accept_eligible: result === "warning" && members.length === 0,
      coverage: result === "unexercised" ? { observed: 0, expected: 1, limits: [reasonCode] } : { observed: 1, expected: 1, limits: [] },
      state: { reason_code: result === "pass" ? null : reasonCode, ...state },
      observation,
    });
  };

  for (const resource of resources) {
    if (!isPlainObject(resource) || !Array.isArray(resource.chain) || !resource.chain.length) invalid("resource has no chain");
  }
  // Every element binds to its resource through the one binder: a <video>
  // by each ledger id it fetched, an <img> by its currentSrc's id. A
  // resource that shares a hop with another resource is bound to no element
  // alone: it and every element that names it read evidence_not_reproducible,
  // never a result taken from one of the chains.
  const bind = mediaChainBinder(resources);
  const shared = new Set(resources.filter((resource) => resource.chain.some((hop) => bind(hop?.resource_id).status === "ambiguous")));
  const videoBound = new Set();
  const imageBound = new Set();
  for (const video of videos) {
    for (const id of Array.isArray(video?.resource_ids) ? video.resource_ids : []) {
      const binding = bind(id);
      if (binding.status === "bound") videoBound.add(binding.resource);
    }
  }
  for (const image of images) {
    const binding = bind(image?.resource_id);
    if (binding.status === "bound") imageBound.add(binding.resource);
  }

  for (const resource of resources) {
    const video = videoBound.has(resource);
    const image = resource.type === "image" || imageBound.has(resource);
    const finalUrl = resource.chain.at(-1)?.url ?? null;
    let outcome;
    if (incomplete) outcome = ["unexercised", CAPTURE_INCOMPLETE];
    else if (shared.has(resource)) outcome = ["unexercised", NOT_REPRODUCIBLE];
    else outcome = weightRule(resource, { video, image, thresholds });
    push("media.weight", resource.resource_id, outcome, {
      measurement: resource.measurement,
      transferred_bytes: resource.transferred_bytes,
      declared_bytes: resource.declared_bytes,
      final_url: finalUrl,
      final_origin_equal: resource.final_origin_equal,
      chain: resource.chain,
    }, {
      origin: resource.final_origin_equal ? "same_origin" : "other_origin",
      role: video ? "video" : image ? "image" : "other",
      type: resource.type,
      measurement: resource.measurement,
      transferred_bytes: resource.transferred_bytes,
      declared_bytes: resource.declared_bytes,
      failed: resource.failed,
      final_url: finalUrl,
      final_origin_equal: resource.final_origin_equal,
      chain: resource.chain,
    });
  }

  for (const video of videos) {
    if (Array.isArray(video?.resource_ids) && video.resource_ids.length) continue;
    push("media.weight", `video:${video?.element_index}`, incomplete ? ["unexercised", CAPTURE_INCOMPLETE] : ["unexercised", "not_loaded"], {
      element_index: video?.element_index,
      declared_origin_equal: video?.declared_origin_equal,
    }, { role: "video", element_index: video?.element_index, declared_origin_equal: video?.declared_origin_equal });
  }

  const unledgered = new Set();
  for (const image of images) {
    if (bind(image?.resource_id).status !== "absent") continue;
    if (unledgered.has(image?.element_path)) continue;
    unledgered.add(image?.element_path);
    push("media.weight", `img:${image?.element_path}`, incomplete ? ["unexercised", CAPTURE_INCOMPLETE] : ["unexercised", "not_in_ledger"], {
      element_path: image?.element_path,
    }, { role: "image", element_path: image?.element_path, resource_id: image?.resource_id ?? null });
  }

  if (!images.length) {
    const outcome = incomplete ? ["unexercised", CAPTURE_INCOMPLETE] : probeComplete ? ["pass", null] : ["unexercised", cell.probe_status];
    push("media.oversize", "cell", outcome, { image_count: 0 }, { image_count: 0, probe_status: cell.probe_status });
  }
  for (const image of images) {
    if (!isPlainObject(image) || !isNonEmptyString(image.element_path)) invalid("image has no element_path");
    if (image.vector !== undefined && image.vector !== null && typeof image.vector !== "boolean") invalid("image vector flag is not a boolean or null");
    const binding = bind(image.resource_id);
    const matched = binding.status === "bound" ? binding.resource : null;
    const finalUrl = matched ? matched.chain.at(-1)?.url ?? null : null;
    let outcome;
    let measured = {};
    if (incomplete) outcome = ["unexercised", CAPTURE_INCOMPLETE];
    else if (binding.status === "ambiguous" || shared.has(matched)) outcome = ["unexercised", NOT_REPRODUCIBLE];
    else if (!probeComplete) outcome = ["unexercised", cell.probe_status];
    else {
      const judged = oversizeRule(image, { requested: Boolean(matched), dpr: cell.dpr, thresholds });
      outcome = judged.result;
      measured = { scale: judged.scale ?? null, factor: judged.factor ?? null, natural_area: judged.area ?? null };
    }
    push("media.oversize", `${image.resource_id ?? null}:${image.element_path}`, outcome, {
      natural: image.natural ?? null,
      rendered: image.rendered ?? null,
      object_fit: image.object_fit ?? null,
      dpr: cell.dpr ?? null,
      final_url: finalUrl,
    }, {
      element_path: image.element_path,
      natural: image.natural ?? null,
      rendered: image.rendered ?? null,
      object_fit: image.object_fit ?? null,
      dpr: cell.dpr ?? null,
      loading: image.loading,
      complete: image.complete ?? null,
      hidden: image.hidden ?? null,
      vector: image.vector === undefined ? false : image.vector,
      final_url: finalUrl,
      probe_status: cell.probe_status,
      ...measured,
    });
  }
  return results;
}

// The 1.3 rules the QC reader re-derives with (src/qc-check-registry.mjs).
export const MEDIA_WEIGHT_QC_RULES = Object.freeze({
  thresholds: MEDIA_WEIGHT_THRESHOLDS,
  vocabulary: MEDIA_WEIGHT_VOCABULARY,
  evaluate: evaluateMediaWeight,
});
