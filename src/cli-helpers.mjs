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
  resolveFromFile,
  filesystemPathsMatch,
  extractFrontmatterValue,
  addIssue,
};
