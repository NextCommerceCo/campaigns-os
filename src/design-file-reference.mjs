import { collectFigmaProvenanceFindings } from "./doctor/source-provenance.mjs";
import { createHash } from "node:crypto";
import { canonicalJson } from "./polish-capture.mjs";

const VIEWPORTS = ["desktop", "tablet", "mobile"];
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const absoluteHttps = (value) => {
  if (!nonEmpty(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch { return null; }
};

// Declared links are data. No design-file reader or network access lives here.
export function normalizeDesignFileReference(value) {
  const warnings = [];
  const url = object(value) && absoluteHttps(value.file_url);
  if (!url) return { declaration: null, warnings: ["file_url must be a non-empty absolute https: URL"] };
  const type = nonEmpty(value.type) ? value.type.toLowerCase() : (url.hostname === "figma.com" || url.hostname.endsWith(".figma.com")) ? "figma" : "other";
  let fileKey = null;
  if (type === "figma") {
    const parts = url.pathname.split("/");
    const index = parts.findIndex((part) => ["file", "design", "proto", "board"].includes(part));
    let candidate = index < 0 ? null : parts[index + 1];
    const branch = parts.indexOf("branch", index + 2);
    if (index >= 0 && branch >= 0 && /^[A-Za-z0-9]+$/.test(parts[branch + 1] ?? "")) candidate = parts[branch + 1];
    if (typeof candidate === "string" && /^[A-Za-z0-9]+$/.test(candidate)) fileKey = candidate;
  }
  const identity = fileKey == null ? { type, url: url.origin + url.pathname } : { type, file_key: fileKey };
  const file_identity_sha256 = createHash("sha256").update(canonicalJson(identity)).digest("hex");
  const frames = {};
  for (const viewport of VIEWPORTS) {
    if (!object(value.breakpoints) || !Object.hasOwn(value.breakpoints, viewport)) continue;
    const link = value.breakpoints[viewport];
    let frame;
    try { frame = nonEmpty(link) ? new URL(link) : null; } catch { frame = null; }
    if (!frame) { warnings.push(`breakpoints.${viewport} must be an absolute frame URL`); continue; }
    frames[viewport] = { url: link, node_id: frame.searchParams.get("node-id")?.replaceAll("-", ":") ?? null };
  }
  return { declaration: { type, file_url: value.file_url, file_key: fileKey, identity, file_identity_sha256, frames }, warnings };
}

export function resolveDesignFileReferences({ activePages = [], mappings = [], manifest = null, specChannel = { mode: "intake" } } = {}) {
  const pages = [];
  const files = new Map();
  // Intake records only Figma spec pointers backed by #534's provenance test.
  // Doctor also compares already-recorded spec contributions, even when today's
  // manifest or provenance is unavailable. Manifest declarations stand alone.
  const exportProvenance = manifest != null && !collectFigmaProvenanceFindings(manifest).some((finding) => finding.severity === "provenance");
  const producer = manifest?.producer_provenance;
  const producerKeys = new Set([producer?.figma_file_key, ...(Array.isArray(producer?.figma_file_keys) ? producer.figma_file_keys : [])].filter(nonEmpty));
  for (const page of activePages) {
    const mapping = mappings.find((entry) => entry?.page_id === page.id);
    if (!nonEmpty(mapping?.path)) continue;
    const matches = (Array.isArray(manifest?.pages) ? manifest.pages : []).filter((entry) => entry?.page_id === page.id && entry.path === mapping.path);
    const manifestValue = matches.length === 1 ? matches[0].design_file : null;
    const specDeclaration = normalizeDesignFileReference(page.design_source).declaration;
    const compareRecordedSpec = specChannel.mode === "doctor" && specChannel.recordedProducers?.get(page.id) === "campaign_spec";
    const fromSpec = compareRecordedSpec || (specDeclaration?.type === "figma" && exportProvenance) ? specDeclaration : null;
    const fromManifest = normalizeDesignFileReference(manifestValue);
    const declaration = fromSpec || fromManifest.declaration;
    if (!declaration) continue;
    const declared_by = fromSpec ? "campaign_spec" : "source_html_manifest";
    let conflict = null;
    if (fromSpec && fromManifest.declaration) {
      const other = fromManifest.declaration;
      const frames = VIEWPORTS.filter((viewport) => fromSpec.frames[viewport] && other.frames[viewport] && fromSpec.frames[viewport].node_id !== other.frames[viewport].node_id).sort();
      if (fromSpec.file_identity_sha256 !== other.file_identity_sha256 || frames.length) {
        conflict = { kind: "spec_vs_manifest", identities: [fromSpec.file_identity_sha256, other.file_identity_sha256].sort(), ...(frames.length ? { frames } : {}) };
      }
    }
    if (!conflict && declaration.type === "figma" && declaration.file_key && producerKeys.size && !producerKeys.has(declaration.file_key)) {
      conflict = { kind: "producer_file_key", identities: [declaration.file_identity_sha256] };
    }
    pages.push({ page_id: page.id, declaration, declared_by, conflict, warnings: manifestValue == null ? [] : fromManifest.warnings });
    const sha = declaration.file_identity_sha256;
    if (!files.has(sha)) files.set(sha, { contribution_id: `design-file-${sha.slice(0, 12)}`, identity: declaration.identity, file_url: declaration.file_url, producer: declared_by, pages: [] });
    files.get(sha).pages.push(page.id);
  }
  return { pages, files: [...files.values()] };
}
