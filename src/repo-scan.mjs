// Shared repository-scan helpers for the campaign scanners
// (campaign-ecosystem.mjs, standardization-report.mjs) and the brief
// extractor. One implementation of the file walk, the version compare and
// the small string helpers that used to be copied into each module.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export function safeReadDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Directory names a scan never descends into: the caller's skip set, plus
// every dot-directory except the toolkit's own `.campaigns-os`.
export function shouldSkipDir(name, skipDirs = new Set()) {
  return skipDirs.has(name) || (name.startsWith(".") && name !== ".campaigns-os");
}

// Every regular file under `root`, sorted. `.git` and `node_modules` are
// never entered; the caller's skip set applies unless includeRuntime is set.
export function listFiles(root, { includeRuntime = false, skipDirs = new Set() } = {}) {
  const files = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) return files;
  const walk = (dir) => {
    for (const entry of safeReadDir(dir)) {
      if (entry.isDirectory()) {
        if (!includeRuntime && shouldSkipDir(entry.name, skipDirs)) continue;
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return files.sort();
}

export function extractVersion(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a, b) {
  const left = extractVersion(a);
  const right = extractVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    const diff = left[index] - right[index];
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function relPath(from, to) {
  const rel = relative(resolve(from), resolve(to)).split(sep).join("/");
  return rel || ".";
}

export function rootId(targetRepo, rootPath) {
  return relPath(targetRepo, rootPath).replace(/[^A-Za-z0-9_.-]+/g, "-") || ".";
}

export function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

export function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
