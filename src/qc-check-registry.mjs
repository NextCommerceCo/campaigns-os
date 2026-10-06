// The one map from a QC check id to the check module that re-derives its
// results. The QC readers (src/qc-results.mjs) reach every check's rules
// through here. A QA check lands by adding its module; a Polish check reads
// one package-owned visual_review record, named by `record`, and each record
// has its own reader in the Polish dispatch (POLISH_RECORDS), so a check for
// a new record also adds that reader.
//
// Each entry names a module specifier, imported lazily and relative to this
// file, and the export the reader calls:
// - QA checks: `rederiveQcResult(observation)` returns a Derived result
//   ({check, subject, result, reason_code, members, accept_eligible, coverage,
//   state}) or null when the observation cannot be re-derived.
// - Polish checks: the record's rules, {thresholds, vocabulary,
//   evaluate(cell, thresholds) => Derived[]} (MEDIA_WEIGHT_QC_RULES for
//   media_weight; READABILITY_QC_RULES for readability, which also carries
//   the record's fixed producer values, limits and route set).
// - Doctor checks recompute from the built HTML on every read and are called
//   by doctor itself; their entries name the evaluator for completeness.
//
// The table holds only the shipped QC checks. A stand-in check never comes
// from here: tests pass theirs in-process (qcStandIns).
export const QC_CHECK_REGISTRY = Object.freeze({
  // Tracking params reach the order
  "tracking.url": Object.freeze({ leg: "qa", unit: "1.1", module: "./qa-tracking-params.mjs", rederive: "rederiveQcResult" }),
  "tracking.order": Object.freeze({ leg: "qa", unit: "1.1", module: "./qa-tracking-params.mjs", rederive: "rederiveQcResult" }),
  "tracking.tag": Object.freeze({ leg: "qa", unit: "1.1", module: "./qa-tracking-params.mjs", rederive: "rederiveQcResult" }),
  // Content params
  content_param: Object.freeze({ leg: "qa", unit: "1.2", module: "./qa-content-params.mjs", rederive: "rederiveQcResult" }),
  // Media weight and oversizing
  "media.weight": Object.freeze({ leg: "polish", unit: "1.3", module: "./polish-media-weight.mjs", rederive: "MEDIA_WEIGHT_QC_RULES", record: "media_weight" }),
  "media.oversize": Object.freeze({ leg: "polish", unit: "1.3", module: "./polish-media-weight.mjs", rederive: "MEDIA_WEIGHT_QC_RULES", record: "media_weight" }),
  // Policy links
  "policy.presence": Object.freeze({ leg: "qa", unit: "1.4", module: "./qa-policy-links.mjs", rederive: "rederiveQcResult" }),
  "policy.availability": Object.freeze({ leg: "qa", unit: "1.4", module: "./qa-policy-links.mjs", rederive: "rederiveQcResult" }),
  // Text readability
  "readability.contrast": Object.freeze({ leg: "polish", unit: "2.4", module: "./polish-readability.mjs", rederive: "READABILITY_QC_RULES", record: "readability" }),
  // Cart placeholders
  cart_placeholders: Object.freeze({ leg: "doctor", unit: "1.5", module: "./cart-placeholders.mjs", rederive: "evaluateCartPlaceholders" }),
  // Built-output smoke checks
  smoke_qc: Object.freeze({ leg: "doctor", unit: "1.6", module: "./built-smoke-qc.mjs", rederive: "evaluateSmokeQc" }),
});

export const qcChecksForLeg = (leg) => Object.keys(QC_CHECK_REGISTRY).filter((check) => QC_CHECK_REGISTRY[check].leg === leg);
// The Polish checks read from one visual_review record.
export const qcChecksForRecord = (record) => Object.keys(QC_CHECK_REGISTRY).filter((check) => QC_CHECK_REGISTRY[check].leg === "polish" && QC_CHECK_REGISTRY[check].record === record);

// A module "does not exist yet" only when Node reports ERR_MODULE_NOT_FOUND
// for that exact specifier. A missing transitive import names another URL,
// and a syntax error or a throw at load has no such code: those read as a
// failed load, which the readers turn into evidence_not_reproducible, never
// not_captured_by_this_version and never pass.
function isMissingModule(error, href) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") return false;
  if (typeof error.url === "string") return error.url === href;
  const message = String(error.message || "");
  return message.startsWith(`Cannot find module '${new URL(href).pathname}' imported from `);
}

let loaded = null;

// Loads every registered module of the given legs once per process and
// returns { "<check>": {status: "loaded", rederive} | {status: "missing"} |
// {status: "failed", error} }. `importer` resolves a specifier relative to
// this file; it exists so the missing/failed distinction can be exercised.
export async function loadQcRederivers({ legs = ["qa", "polish"], registry = QC_CHECK_REGISTRY, importer = (specifier) => import(specifier) } = {}) {
  const useCache = registry === QC_CHECK_REGISTRY;
  const cache = useCache && loaded ? loaded : {};
  const modules = new Map();
  for (const [check, entry] of Object.entries(registry)) {
    if (!legs.includes(entry.leg) || Object.hasOwn(cache, check)) continue;
    const href = new URL(entry.module, import.meta.url).href;
    if (!modules.has(href)) {
      modules.set(href, importer(entry.module).then(
        (module) => ({ module }),
        (error) => ({ error, missing: isMissingModule(error, href) }),
      ));
    }
    const outcome = await modules.get(href);
    if (outcome.missing) cache[check] = Object.freeze({ status: "missing" });
    else if (outcome.error) cache[check] = Object.freeze({ status: "failed", error: String(outcome.error?.message || outcome.error) });
    else if (outcome.module?.[entry.rederive] == null) cache[check] = Object.freeze({ status: "failed", error: `${entry.module} has no export ${entry.rederive}` });
    else cache[check] = Object.freeze({ status: "loaded", rederive: outcome.module[entry.rederive] });
  }
  if (useCache) loaded = cache;
  return Object.freeze({ ...cache });
}

// The rederivers loaded so far in this process, or null before the first
// load. Synchronous readers fall back to this; a check not loaded yet reads
// as not re-derivable (evidence_not_reproducible), never as pass.
export const loadedQcRederivers = () => (loaded ? Object.freeze({ ...loaded }) : null);
