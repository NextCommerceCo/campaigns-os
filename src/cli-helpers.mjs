// Small general helpers the CLI and the doctor modules share.
import { htmlScanDigest } from "./html-scan.mjs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { canonicalPath } from "./fs-identity.mjs";
import { refused } from "./lifecycle.mjs";
import { isAbsoluteHttpUrl } from "./route-identity.mjs";

// The shared "missing required flag" refusal. Every call site resolves flags
// at the top of its handler, before the command reads or writes anything, so
// this is always an up-front refusal and carries the tag.
function requireArg(args, key) {
  const value = args[key];
  if (!isNonEmptyString(value)) throw refused(`Missing required --${key}`);
  return value;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value, fallback = null) {
  return isNonEmptyString(value) ? value.trim() : fallback;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim();
  }
  return null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function filesystemPathsMatch(left, right) {
  if (!isNonEmptyString(left) || !isNonEmptyString(right)) return false;
  if (isAbsoluteHttpUrl(left) || isAbsoluteHttpUrl(right)) return left === right;
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (resolvedLeft === resolvedRight) return true;
  try {
    const leftStats = statSync(resolvedLeft);
    const rightStats = statSync(resolvedRight);
    return leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino;
  } catch {
    return false;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonIfExists(path) {
  return path && existsSync(path) ? readJson(path) : null;
}

function sha256File(path) {
  return htmlScanDigest(path);
}

// Portable output rebases every path onto the output base as the filesystem
// knows both (real paths when they exist), so a target reached through a
// symlinked checkout and a sidecar recorded by its real path relativize to
// `./…`, not to a chain of `../` that names the original machine.
function relFromDir(dirPath, targetPath) {
  const rel = relative(canonicalPath(dirPath), canonicalPath(targetPath));
  if (!rel) return ".";
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function isLocalAbsolutePath(value) {
  return isNonEmptyString(value) && !isAbsoluteHttpUrl(value) && isAbsolute(value);
}

// Commit-ready JSON has a finite set of filesystem fields. Route roots and URL
// paths are deliberately absent: a leading slash does not make one a file.
function portableArtifactPath(targetRepo, path, { baseDir = targetRepo } = {}) {
  const rel = relative(resolve(baseDir), resolve(path));
  return !rel ? "." : rel.startsWith(".") ? rel : `./${rel}`;
}

const ARTIFACT_PATH_FIELDS = Object.freeze({
  "campaign-runtime-build-packet/v0": [
    "spec.local_path", "design_source_package.path", "source_html.root",
    "source_html.pages.*.path", "source_html.pages.*.page_kit.target_path",
    "source_html.pages.*.page_kit.output_path", "build_brief.input_path",
    "build_brief.normalized_path", "assembly.target_repo", "assembly.output_dir",
    "assembly.commerce_catalog.path",
  ],
  "campaign-runtime-build-context/v0": [
    "packet_path", "report_path", "intake.spec_path", "intake.source_root",
    "intake.target_repo", "intake.brief_path", "intake.design_manifest_path",
    "intake.packet_path", "design_source_package.path", "spec.path", "source.root",
    "build_brief.input_path", "build_brief.normalized_path",
    "page_map.*.source_path", "page_map.*.output_path",
    "page_map.*.page_kit.target_path", "page_map.*.page_kit.output_path",
    "scaffold.target_repo", "scaffold.output_dir", "scaffold.handoff_artifact",
    "theme.source_files.*.path", "theme.generated.css_path", "theme.generated.report_path",
  ],
  "campaign-runtime-assembly-report/v0": [
    "inputs.packet_path", "inputs.context_path", "inputs.build_brief_path",
    "inputs.spec_path", "inputs.source.root", "inputs.target_repo",
    "design_source_package.path", "build_brief.input_path", "build_brief.normalized_path",
    // `**` also reaches each stage's archived entries.
    "theme.css_path", "stages.**.inputs.*", "stages.**.outputs.*",
  ],
  "campaigns-os-doctor-output/v0": [
    "packet_path", "assembly_report_path", "spec_path", "emitted_packet_path",
    "derived.packet_path", "derived.assembly_report_path", "derived.spec_path",
    "derived.target_repo", "derived.source_root", "derived.output_dir", "derived.target_output_dir",
    "errors.*.detail.spec_path", "errors.*.detail.input_path",
    "warnings.*.detail.spec_path", "warnings.*.detail.input_path",
  ],
  "campaigns-os-build-brief/v1": ["_meta.input_path"],
});

const ARTIFACT_COMMAND_FIELDS = Object.freeze({
  "campaign-runtime-build-packet/v0": ["source_html.pages.*.skip_reason"],
  "campaign-runtime-build-context/v0": [
    "decisions.*.decision", "decisions.*.evidence.*",
    "prompts_required.*.message", "page_map.*.skip_reason", "source.manifest_warnings.*",
  ],
  "campaign-runtime-assembly-report/v0": [
    "next.command", "stages.**.commands.*",
    "decisions.*.decision", "decisions.*.evidence.*",
    "**.message", "**.blockers.*", "**.warnings.*",
  ],
  "campaigns-os-doctor-output/v0": [
    "next.command", "next.actions.*", "next_actions.*.command", "**.message", "**.blockers.*", "**.warnings.*",
  ],
});

function fieldMatches(pattern, segments) {
  const parts = pattern.split(".");
  function matches(at, index) {
    if (at === parts.length) return index === segments.length;
    if (parts[at] === "**") return matches(at + 1, index) || (index < segments.length && matches(at, index + 1));
    return index < segments.length && (parts[at] === "*" || parts[at] === segments[index]) && matches(at + 1, index + 1);
  }
  return matches(0, 0);
}

function portableArtifactPaths(value, targetRepo, { artifactPath = null } = {}) {
  const schema = isObject(value) ? value.schema_version : null;
  const pathFields = ARTIFACT_PATH_FIELDS[schema] || [];
  const commandFields = ARTIFACT_COMMAND_FIELDS[schema] || [];
  const artifactDir = artifactPath ? dirname(resolve(artifactPath)) : null;
  const packet = schema === "campaign-runtime-build-packet/v0";
  const context = schema === "campaign-runtime-build-context/v0";
  const report = schema === "campaign-runtime-assembly-report/v0";
  const sourceField = packet ? value.source_html?.root : context ? value.source?.root : report ? value.inputs?.source?.root : null;
  const sourceBase = packet ? artifactDir : targetRepo;
  const sourceRoot = isNonEmptyString(sourceField) && sourceBase ? resolve(sourceBase, sourceField) : null;
  const outputField = packet ? value.assembly?.output_dir : context ? value.scaffold?.output_dir : null;
  const outputBase = targetRepo;
  const outputDir = isNonEmptyString(outputField) && outputBase ? resolve(outputBase, outputField) : null;
  const roots = [...new Set([targetRepo, sourceRoot].filter(Boolean).flatMap((root) => [resolve(root), canonicalPath(root)]))]
    .filter((root) => root !== "/")
    .sort((left, right) => right.length - left.length);
  function fieldBase(segments) {
    const path = segments.join(".");
    if (packet) {
      if (path === "source_html.pages.*.path") return sourceRoot;
      if (path === "source_html.pages.*.page_kit.target_path") return outputDir;
      if (path === "source_html.pages.*.page_kit.output_path") return targetRepo;
      if (path === "assembly.output_dir") return targetRepo;
      return artifactDir;
    }
    if (context) {
      if (path === "page_map.*.source_path") return sourceRoot;
      if (path === "page_map.*.page_kit.target_path") return outputDir;
      if (path === "design_source_package.path") return artifactDir;
    }
    if (report && path === "design_source_package.path") return artifactDir;
    if (schema === "campaigns-os-build-brief/v1") return artifactDir;
    return targetRepo;
  }
  function portableCommand(command) {
    let output = command;
    for (const root of roots) {
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const replacement = portableArtifactPath(targetRepo, root);
      output = output.replace(new RegExp(`(^|[\\s"'\`(=,;\\[<])${escaped}(?=$|[/\\s"'\`.,:;)\\]>])`, "g"),
        (_match, prefix) => `${prefix}${replacement}`);
    }
    return output;
  }
  function visit(entry, segments = []) {
    if (Array.isArray(entry)) return entry.map((item) => visit(item, [...segments, "*"]));
    if (isObject(entry)) return Object.fromEntries(Object.entries(entry).map(([field, item]) => [field, visit(item, [...segments, field])]));
    if (typeof entry !== "string") return entry;
    if (Array.isArray(value) && segments.length === 1 && isLocalAbsolutePath(entry)) return portableArtifactPath(targetRepo, entry);
    if (pathFields.some((pattern) => fieldMatches(pattern, segments)) && isLocalAbsolutePath(entry)) {
      const baseDir = fieldBase(segments);
      return baseDir ? portableArtifactPath(targetRepo, entry, { baseDir }) : entry;
    }
    if (commandFields.some((pattern) => fieldMatches(pattern, segments))) return portableCommand(entry);
    return entry;
  }
  return visit(value);
}

function resolveFromFile(filePath, targetPath) {
  if (!isNonEmptyString(targetPath)) return null;
  if (isAbsoluteHttpUrl(targetPath)) return targetPath;
  return resolve(dirname(resolve(filePath)), targetPath);
}

function extractFrontmatterValue(content, key) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  for (const line of match[1].split("\n")) {
    const parts = line.match(/^([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
    if (parts?.[1] === key) return parts[2].replace(/^["']|["']$/g, "");
  }
  return null;
}

function addIssue(collection, code, message, detail = null) {
  collection.push(detail ? { code, message, detail } : { code, message });
}

export {
  requireArg,
  isObject,
  isNonEmptyString,
  optionalString,
  firstNonEmptyString,
  cloneJson,
  readJson,
  readJsonIfExists,
  sha256File,
  relFromDir,
  isLocalAbsolutePath,
  portableArtifactPaths,
  resolveFromFile,
  filesystemPathsMatch,
  extractFrontmatterValue,
  addIssue,
};
