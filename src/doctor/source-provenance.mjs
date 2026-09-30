// Source-provenance checkpoint (#534). A CampaignSpec page whose design_source
// is Figma makes doctor demand figma-sections-export provenance from the
// source-html manifest (source_html.producer_provenance*). When the approved
// source for that page is hand-written HTML and the Figma file is only a
// render of it, no export exists to supply that provenance. This gate lets a
// named human record that, per page, with a reason and a bound, through
// `checkpoint waive --gate source_html.producer_provenance --page <page_id>`.
//
// A waiver never suppresses a finding. Doctor reports the provenance findings
// once per Figma-typed page: as warnings carrying `waived: true` for a waived
// page, and as errors for an unwaived one. The family is the
// source_html.producer_provenance* codes plus source_html.files.partial and
// source_html.files.asset, the export's own file-inventory shape, which only
// a Figma-typed page is held to. When the manifest itself claims to be a
// figma-sections-export output, the findings are the manifest's own: they
// stay manifest-wide errors, the gate is not waivable, and any waiver
// recorded for the page is inert. Every other source check (manifest
// validity, wrapper policy, screenshot proof) is evaluated elsewhere and is
// untouched by this gate.

import {
  assessCheckpointWaivers,
  checkpointStateFingerprint,
  projectCheckpointWaiverAssessment,
} from "../checkpoint-waiver.mjs";

export const SOURCE_PROVENANCE_SCOPE = "source_html.producer_provenance";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emptyWaiverAssessment() {
  return { active: null, inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 } };
}

// True when a source-html manifest's generator names figma-sections-export in
// any form: bare, `@<version>` or another suffix, any case, surrounding
// whitespace. Such a manifest claims to be a real export, so its provenance
// findings are its own and no page waiver clears them. Every reader of the
// generator claim uses this one predicate.
export function generatorClaimsFigmaExport(generator) {
  if (typeof generator !== "string") return false;
  return /(^|[^a-z0-9_-])figma-sections-export(?![a-z0-9_-])/i.test(generator.trim());
}

export function isSourceProvenanceCode(code) {
  const value = String(code || "");
  return value === SOURCE_PROVENANCE_SCOPE || value.startsWith(`${SOURCE_PROVENANCE_SCOPE}.`);
}

// The Figma-export file inventory: a manifest behind a Figma-typed page must
// list section partials and exported assets. Hand-written HTML has neither, so
// these two findings belong to the waivable family.
export const FIGMA_EXPORT_FILE_CODES = Object.freeze(["source_html.files.partial", "source_html.files.asset"]);

// The gate code when the manifest's generator claims figma-sections-export:
// blocked, not waivable, and any waiver recorded for the page is inert.
export const SOURCE_PROVENANCE_EXPORTER_CLAIM_CODE = `${SOURCE_PROVENANCE_SCOPE}.exporter_claim`;

function waiveCommand(pageId) {
  return `campaigns-os checkpoint waive --packet <packet> --gate ${SOURCE_PROVENANCE_SCOPE} --page ${pageId} --reason "<reason>" --waived-by "<named human>" --expires-at <ISO>`;
}

/**
 * One checkpoint gate per Figma-typed page.
 *
 * @param {{
 *   pages: Array<{ page_id: string, design_source: { type: string|null, file_url: string|null } }>,
 *   blockingCodes: string[],
 *   generatorClaimsExport?: boolean,
 *   waivers?: unknown,
 *   now?: string,
 * }} input
 */
export function evaluateSourceProvenanceGates({ pages = [], blockingCodes = [], generatorClaimsExport = false, waivers = null, now = new Date().toISOString() } = {}) {
  const records = (Array.isArray(waivers) ? waivers : [])
    .filter((record) => isPlainObject(record) && record.scope === SOURCE_PROVENANCE_SCOPE);
  const figmaPageIds = new Set(pages.map((page) => page.page_id));
  const findings = [...new Set(blockingCodes)].sort();
  let exporterClaimRecords = 0;

  const gates = pages.map((page) => {
    const subject = { page_id: page.page_id };
    const state = { design_source: page.design_source, findings };
    const base = {
      id: SOURCE_PROVENANCE_SCOPE,
      scope: SOURCE_PROVENANCE_SCOPE,
      subject,
      state,
    };
    if (findings.length === 0) {
      return {
        ...base,
        status: "pass",
        code: `${SOURCE_PROVENANCE_SCOPE}.pass`,
        reason: `Page "${page.page_id}" has a Figma design source and the source-html manifest carries semantic figma-sections-export provenance.`,
        waivable: false,
        state_fingerprint: null,
        waiver: null,
        waiver_assessment: emptyWaiverAssessment(),
        required_actions: [],
      };
    }
    // Only this page's records are assessed here. Another page's waiver is
    // not "foreign" history for this page; it belongs to that page's gate.
    const pageRecords = records.filter((record) => isPlainObject(record.subject) && record.subject.page_id === page.page_id);
    if (generatorClaimsExport) {
      exporterClaimRecords += pageRecords.length;
      return {
        ...base,
        status: "blocked",
        code: SOURCE_PROVENANCE_EXPORTER_CLAIM_CODE,
        reason: `Page "${page.page_id}" has a Figma design source and the source-html manifest's generator claims figma-sections-export, but the manifest lacks that export's provenance (${findings.join(", ")}). A real export carries it, so this is not waivable; re-run figma-sections-export, or, when the approved source is hand-written HTML, set the manifest's generator to name the real producer and record a page waiver.`,
        waivable: false,
        state_fingerprint: null,
        waiver: null,
        waiver_assessment: emptyWaiverAssessment(),
        required_actions: [
          {
            id: "repair_target",
            kind: "manual",
            command: null,
            description: "Re-run figma-sections-export so the source-html manifest carries semantic producer_provenance, or correct the manifest's generator when no export produced it, then re-run doctor.",
          },
        ],
      };
    }
    const state_fingerprint = checkpointStateFingerprint({ scope: SOURCE_PROVENANCE_SCOPE, subject, state });
    const checkpoint = { scope: SOURCE_PROVENANCE_SCOPE, subject, state_fingerprint };
    const waiver_assessment = projectCheckpointWaiverAssessment(
      assessCheckpointWaivers(pageRecords, checkpoint, { now }),
      checkpoint,
    );
    const waiver = waiver_assessment.active;
    return {
      ...base,
      status: waiver ? "waived" : "blocked",
      code: waiver ? `${SOURCE_PROVENANCE_SCOPE}.waived` : SOURCE_PROVENANCE_SCOPE,
      reason: waiver
        ? `Page "${page.page_id}" has a Figma design source but no figma-sections-export provenance (${findings.join(", ")}); accepted under a named-human decision that its approved source is hand-written HTML.`
        : `Page "${page.page_id}" has a Figma design source, so doctor requires figma-sections-export provenance in the source-html manifest (${findings.join(", ")}). Re-run figma-sections-export, or, when the approved source is hand-written HTML and the Figma file only renders it, record a named-human waiver for this page.`,
      waivable: true,
      state_fingerprint,
      waiver,
      waiver_assessment,
      required_actions: waiver ? [] : [
        {
          id: "repair_target",
          kind: "manual",
          command: null,
          description: "Re-run figma-sections-export for this page so the source-html manifest carries semantic producer_provenance, then re-run doctor.",
        },
        {
          id: "waive_checkpoint",
          kind: "command",
          command: waiveCommand(page.page_id),
          description: `When page "${page.page_id}"'s approved source is hand-written HTML, record a named-human waiver with a reason and a bound. Manifest, wrapper-policy and screenshot-proof checks still apply.`,
        },
      ],
    };
  });

  // Records naming a page that no longer has a Figma design source (the
  // page's design_source changed, or the page left the spec) can never
  // satisfy a gate again.
  const noFigmaSource = records.filter((record) => !isPlainObject(record.subject)
    || !figmaPageIds.has(record.subject.page_id));
  const counts = { stale: 0, foreign: 0, malformed: 0, expired: 0 };
  for (const gate of gates) {
    for (const kind of Object.keys(counts)) counts[kind] += gate.waiver_assessment?.inert_counts?.[kind] || 0;
  }
  counts.no_figma_source = noFigmaSource.length;
  counts.exporter_claim = exporterClaimRecords;
  const inertPages = [...new Set(noFigmaSource
    .map((record) => (isPlainObject(record.subject) && typeof record.subject.page_id === "string" ? record.subject.page_id : null))
    .filter(Boolean))].sort();

  return { gates, inert: { counts, pages: inertPages } };
}
