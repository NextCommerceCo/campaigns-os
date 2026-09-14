// QA verdict discovery: the one walk over the local verdicts a campaign has
// written, with the projections each reader needs.
//
// `qa run` writes full verdicts to `<target repo>/qa-output/<campaign_slug>/
// <run_id>.json`, and the Assembly Report's qa stage records the paths it
// produced. Three readers walked that on their own — the ledger-divergence
// check (repo-relative list), run-record inference (the best candidate by
// identity score and time) and closeout (digests of the recorded paths) —
// each with its own copy of the identity rule and the directory spelling.
//
// A leaf: node built-ins and the workspace constant only.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { QA_OUTPUT_REL_PATH } from "./campaign-workspace.mjs";

const optionalString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// The names a campaign's verdicts are filed and stamped under: the map id and
// the public route slug (as identity: trimmed, no slashes). A verdict is this
// campaign's when its campaign_slug is one of them.
export function qaVerdictIdentifiers(packet) {
  const slug = String(packet?.campaign?.public_route_slug || "").trim().replace(/^\/+|\/+$/g, "");
  return [...new Set([optionalString(packet?.spec?.map_id), slug || null].filter(Boolean))];
}

export function qaVerdictIdentityMatch(verdict, packet) {
  const slug = optionalString(verdict?.campaign_slug);
  return Boolean(slug) && qaVerdictIdentifiers(packet).includes(slug);
}

// `<root>/qa-output/<identifier>` — the directory `qa run` writes under.
export function qaVerdictDir(root, identifier) {
  return join(root, QA_OUTPUT_REL_PATH, identifier);
}

// The verdict paths the Assembly Report's qa stage records (any `*.json`
// string under a path/file/verdict/output-named key, or inside outputs[] /
// artifacts[] / qa), relative to the report unless absolute.
export function qaVerdictPathHints(report) {
  const paths = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === "string" && /(?:path|file|verdict|output)$/i.test(key)) visit(item);
        else if (key === "outputs" || key === "artifacts" || key === "qa") visit(item);
      }
      return;
    }
    if (typeof value === "string" && /\.json(?:[?#].*)?$/i.test(value.trim())) paths.push(value.trim());
  };
  visit(report?.qa || null);
  visit(report?.stages?.qa || null);
  return [...new Set(paths)];
}

function readVerdictFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Every verdict candidate for a campaign: the files the report records
// (source "assembly_report", resolved against the report) and every `*.json`
// under `qa-output/<identifier>/` beneath each root (source "qa_output").
//   { path, repoRelPath, source, verdict, sha256, mtimeMs, identityMatch, trusted }
// `verdict` is null for a recorded path that exists but is not a JSON object
// (it still has a digest: closeout compares bytes, not shape). `trusted` is
// false only for a verdict the receiver stamped `trusted: false` (an
// anonymous submission); locally written verdicts never carry the field.
// Best-effort throughout: an unreadable directory or file is no candidate.
export function discoverQaVerdicts({ packet = null, report = null, reportPath = null, roots = [], withDigest = false } = {}) {
  const found = [];
  const seen = new Set();
  const add = (path, source, repoRelPath) => {
    const absolute = resolve(path);
    if (seen.has(absolute)) return;
    let stats;
    try {
      if (!existsSync(absolute)) return;
      stats = statSync(absolute);
      if (!stats.isFile()) return;
    } catch {
      return;
    }
    seen.add(absolute);
    const verdict = readVerdictFile(absolute);
    let sha256 = null;
    if (withDigest) {
      try {
        sha256 = sha256File(absolute);
      } catch {
        sha256 = null;
      }
    }
    found.push({
      path: absolute,
      repoRelPath,
      source,
      verdict,
      sha256,
      mtimeMs: stats.mtimeMs,
      identityMatch: verdict ? qaVerdictIdentityMatch(verdict, packet) : false,
      trusted: verdict?.trusted !== false,
    });
  };

  const reportBase = reportPath ? dirname(resolve(reportPath)) : null;
  for (const hint of qaVerdictPathHints(report)) {
    add(reportBase ? resolve(reportBase, hint) : hint, "assembly_report", null);
  }

  const uniqueRoots = [...new Set(roots.filter((root) => typeof root === "string" && root).map((root) => resolve(root)))];
  for (const root of uniqueRoots) {
    for (const identifier of qaVerdictIdentifiers(packet)) {
      const dir = qaVerdictDir(root, identifier);
      let names = [];
      try {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
        names = readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) => entry.name)
          .sort();
      } catch {
        continue;
      }
      for (const name of names) {
        const path = join(dir, name);
        // Repo-relative on purpose: divergence evidence must read the same
        // wherever the repo sits on disk.
        add(path, "qa_output", relative(root, path).split("\\").join("/"));
      }
    }
  }
  return found;
}

// Run-record inference: how well a candidate answers "this campaign, this
// deployment". Identity first, then the verdict schema, then a deploy origin
// the assertions actually visited.
export function qaVerdictCandidateScore(candidate, packet) {
  const verdict = candidate?.verdict || {};
  const mapId = optionalString(packet?.spec?.map_id);
  const slug = String(packet?.campaign?.public_route_slug || "").trim().replace(/^\/+|\/+$/g, "") || null;
  let score = 0;
  if (mapId && verdict.campaign_slug === mapId) score += 100;
  if (slug && verdict.campaign_slug === slug) score += 80;
  if (verdict.schema_version === "1.0" || verdict.schema_version === "campaigns-os-qa-verdict/v0") score += 10;
  const deployOrigins = [optionalString(packet?.deploy?.preview_url), optionalString(packet?.deploy?.production_url)].filter(Boolean);
  const assertionUrls = Array.isArray(verdict.assertions)
    ? verdict.assertions.map((assertion) => optionalString(assertion?.url)).filter(Boolean)
    : [];
  if (deployOrigins.some((origin) => assertionUrls.some((url) => url.startsWith(origin)))) score += 25;
  return score;
}

export function qaVerdictCandidateTime(candidate) {
  const completedAt = Date.parse(candidate?.verdict?.completed_at || "");
  if (Number.isFinite(completedAt)) return completedAt;
  return Number(candidate?.mtimeMs || 0);
}
