import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

export const SOURCE_ASSET_CRAWL_SCHEMA = "source-asset-crawl/v0";

const ASSET_EXTENSIONS = new Set([
  ".avif",
  ".css",
  ".eot",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".mjs",
  ".mov",
  ".mp3",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".svg",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
]);

const SKIP_PROTOCOL_PATTERN = /^(?:about|blob|data|javascript|mailto|tel):/i;
const DEFAULT_MAX_CSS_FILES = 256;
const HTML_ASSET_ATTRIBUTES = new Set([
  "content",
  "data-background",
  "data-bg",
  "data-src",
  "href",
  "imagesrcset",
  "poster",
  "src",
  "srcset",
]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256Content(content) {
  return createHash("sha256").update(content).digest("hex");
}

function toPosixPath(value) {
  return String(value || "").replaceAll("\\", "/");
}

function relFromRoot(root, path) {
  return toPosixPath(relative(resolve(root), resolve(path)));
}

function isInsideRoot(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function cleanRef(value) {
  const raw = decodeHtmlEntities(String(value || "").trim().replace(/^["']|["']$/g, ""));
  if (!raw || raw.startsWith("#")) return null;
  if (raw.startsWith("{{") || raw.startsWith("{%")) return null;
  if (raw.startsWith("//")) return null;
  if (SKIP_PROTOCOL_PATTERN.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") return null;
  } catch {
    // Relative or root-relative refs are the expected input.
  }
  return raw.split("#")[0].split("?")[0].trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function looksLikeAssetRef(value) {
  const cleaned = cleanRef(value);
  if (!cleaned) return false;
  const pathname = cleaned.split(/[?#]/)[0];
  if (/^\/?assets\//i.test(pathname)) return true;
  if (/(^|\/)(images?|img|fonts?|css|js|media|products)\//i.test(pathname)) return true;
  return ASSET_EXTENSIONS.has(extname(pathname).toLowerCase());
}

function splitSrcset(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function extractCssRefs(content) {
  const refs = [];
  const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  for (const match of content.matchAll(urlPattern)) {
    refs.push({ raw: match[2], attribute: "url()" });
  }
  const importPattern = /@import\s+(?:url\()?["']?([^"')\s]+)["']?\)?/gi;
  for (const match of content.matchAll(importPattern)) {
    refs.push({ raw: match[1], attribute: "@import" });
  }
  return refs;
}

function extractHtmlRefs(content) {
  const refs = [];
  const tags = extractHtmlTags(content);

  function addRef(raw, attribute) {
    const attr = attribute.toLowerCase();
    if (attr === "srcset" || attr === "imagesrcset") {
      for (const item of splitSrcset(raw)) refs.push({ raw: item, attribute: attr });
      return;
    }
    refs.push({ raw, attribute: attr });
  }

  for (const tag of tags) {
    for (const attr of extractHtmlTagAttributes(tag)) {
      if (HTML_ASSET_ATTRIBUTES.has(attr.name)) addRef(attr.value, attr.name);
      if (attr.name === "style") {
        for (const ref of extractCssRefs(attr.value)) refs.push({ ...ref, attribute: `style:${ref.attribute}` });
      }
    }
  }

  const styleBlockPattern = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  for (const match of content.matchAll(styleBlockPattern)) {
    for (const ref of extractCssRefs(match[1])) refs.push({ ...ref, attribute: `style-block:${ref.attribute}` });
  }
  return refs;
}

function extractHtmlTagAttributes(tag) {
  const attrs = [];
  const text = String(tag || "");
  let index = 0;

  if (text[index] !== "<") return attrs;
  index += 1;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  while (index < text.length && !/[\s/>]/.test(text[index])) index += 1;

  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (index >= text.length || text[index] === ">") break;
    if (text[index] === "/" || text[index] === "?") {
      index += 1;
      continue;
    }

    const nameStart = index;
    while (index < text.length && !/[\s=/>]/.test(text[index])) index += 1;
    const name = text.slice(nameStart, index).toLowerCase();
    while (index < text.length && /\s/.test(text[index])) index += 1;

    let value = "";
    if (text[index] === "=") {
      index += 1;
      while (index < text.length && /\s/.test(text[index])) index += 1;
      const quote = text[index];
      if (quote === "\"" || quote === "'") {
        index += 1;
        const valueStart = index;
        while (index < text.length && text[index] !== quote) index += 1;
        value = text.slice(valueStart, index);
        if (text[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (index < text.length && !/[\s>]/.test(text[index])) index += 1;
        value = text.slice(valueStart, index);
      }
    }

    if (name) attrs.push({ name, value });
  }
  return attrs;
}

function extractHtmlTags(content) {
  const tags = [];
  const text = String(content || "");
  let tagStart = -1;
  let quote = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (tagStart === -1) {
      if (char === "<" && /[!/a-z?]/i.test(text[index + 1] || "")) tagStart = index;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char !== ">") continue;

    const tag = text.slice(tagStart, index + 1);
    tags.push(tag);
    const tagName = tag.match(/^<\s*([a-z0-9:-]+)/i)?.[1]?.toLowerCase();
    tagStart = -1;
    if (tagName === "script" || tagName === "style") {
      const closePattern = new RegExp(`</\\s*${tagName}\\s*>`, "ig");
      closePattern.lastIndex = index + 1;
      const closeMatch = closePattern.exec(text);
      if (closeMatch) index = closeMatch.index + closeMatch[0].length - 1;
    }
  }
  return tags;
}

function assetKindForRef(value) {
  const ext = extname(String(value || "").split(/[?#]/)[0]).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".svg", ".ico"].includes(ext)) return "image";
  if ([".css"].includes(ext)) return "style";
  if ([".js", ".mjs", ".json"].includes(ext)) return "script";
  if ([".woff", ".woff2", ".ttf", ".otf", ".eot"].includes(ext)) return "font";
  if ([".mp4", ".webm", ".mov", ".mp3", ".wav"].includes(ext)) return "media";
  return "asset";
}

function resolveAssetRef(sourceRoot, originPath, rawRef) {
  const cleaned = cleanRef(rawRef);
  if (!cleaned || !looksLikeAssetRef(cleaned)) return null;

  const rootRelative = cleaned.startsWith("/");
  const normalized = cleaned.replace(/^\/+/, "");
  const originDir = dirname(resolve(sourceRoot, originPath));
  const primaryPath = rootRelative ? resolve(sourceRoot, normalized) : resolve(originDir, cleaned);
  const fallbackPath = !rootRelative ? resolve(sourceRoot, normalized) : null;
  const primaryExists = safeIsFile(primaryPath);
  const fallbackExists = fallbackPath ? safeIsFile(fallbackPath) : false;
  const sourceRootFallback = !primaryExists && fallbackExists;
  const resolvedPath = primaryExists ? primaryPath : sourceRootFallback ? fallbackPath : primaryPath;
  const insideSourceRoot = isInsideRoot(sourceRoot, resolvedPath);
  const sourcePath = insideSourceRoot ? relFromRoot(sourceRoot, resolvedPath) : null;
  const sourceExists = insideSourceRoot && (primaryExists || sourceRootFallback);
  const pagekitAssetPath = sourcePath ? sourcePath.replace(/^assets\//i, "") : null;
  const needsRewrite = rootRelative || /^\.?\.?\/?assets\//i.test(cleaned);

  return {
    raw: rawRef,
    normalized,
    asset_kind: assetKindForRef(normalized),
    root_relative: rootRelative,
    source_path: sourcePath,
    source_exists: sourceExists,
    outside_source_root: !insideSourceRoot,
    source_root_fallback: sourceRootFallback,
    pagekit_asset_path: pagekitAssetPath,
    rewrite_required: needsRewrite,
    rewrite_hint: needsRewrite && pagekitAssetPath
      ? `Rewrite source asset ref "${cleaned}" to the Page Kit campaign asset root, e.g. campaign_asset "${pagekitAssetPath}".`
      : null,
  };
}

function safeIsFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function referenceKey(ref) {
  return [
    ref.normalized,
    ref.source_path || "",
    ref.asset_kind,
    ref.root_relative ? "root" : "relative",
  ].join("\u0000");
}

function addReference(referencesByKey, ref, referencedBy) {
  const key = referenceKey(ref);
  const existing = referencesByKey.get(key);
  if (existing) {
    const duplicate = existing.referenced_by.some((item) =>
      item.path === referencedBy.path && item.attribute === referencedBy.attribute
    );
    if (!duplicate) existing.referenced_by.push(referencedBy);
    return existing;
  }
  const next = { ...ref, referenced_by: [referencedBy] };
  referencesByKey.set(key, next);
  return next;
}

function scannedFile(path, kind, stats, content) {
  return {
    path,
    kind,
    bytes: stats.size,
    sha256: sha256Content(content),
  };
}

function readScannableFile(path, kind, sourceRoot) {
  const fullPath = resolve(sourceRoot, path);
  let stats;
  try {
    stats = statSync(fullPath);
  } catch (error) {
    return { ok: false, warning: scanWarning(path, error) };
  }
  if (!stats.isFile()) return { ok: false, warning: null };
  try {
    const content = readFileSync(fullPath);
    return {
      ok: true,
      content: content.toString("utf8"),
      file: scannedFile(path, kind, stats, content),
    };
  } catch (error) {
    return { ok: false, warning: scanWarning(path, error) };
  }
}

function scanWarning(path, error) {
  return {
    code: "source_asset.scan_file_error",
    message: `Could not scan source asset file "${path}": ${error.message}`,
    sample: [path],
  };
}

function pageIdsBySourcePath(pageMappings) {
  const map = new Map();
  for (const mapping of Array.isArray(pageMappings) ? pageMappings : []) {
    if (!isNonEmptyString(mapping?.path) || !isNonEmptyString(mapping?.page_id)) continue;
    const path = toPosixPath(mapping.path);
    if (!map.has(path)) map.set(path, []);
    map.get(path).push(mapping.page_id);
  }
  return map;
}

function summarizeWarnings(references) {
  const warnings = [];
  const rootAssetRefs = references.filter((ref) => ref.root_relative && /^assets\//i.test(ref.normalized));
  const fallbackRefs = references.filter((ref) => ref.source_root_fallback);
  const outsideRefs = references.filter((ref) => ref.outside_source_root);
  const missingRefs = references.filter((ref) => !ref.source_exists && !ref.outside_source_root);
  if (rootAssetRefs.length > 0) {
    warnings.push({
      code: "source_asset.root_assets_path",
      message: `${rootAssetRefs.length} source asset reference(s) use raw /assets/... paths. Rewrite these for Page Kit's campaign asset root during assembly.`,
      sample: rootAssetRefs.slice(0, 6).map((ref) => ref.raw),
    });
  }
  if (fallbackRefs.length > 0) {
    warnings.push({
      code: "source_asset.source_root_fallback",
      message: `${fallbackRefs.length} source asset reference(s) resolved through the source-root fallback instead of the HTML-file-relative path. Confirm these refs are intended before assembly.`,
      sample: fallbackRefs.slice(0, 6).map((ref) => ref.raw),
    });
  }
  if (outsideRefs.length > 0) {
    warnings.push({
      code: "source_asset.outside_source_root",
      message: `${outsideRefs.length} source asset reference(s) resolve outside the source root. Move these files into the source handoff before assembly.`,
      sample: outsideRefs.slice(0, 6).map((ref) => ref.raw),
    });
  }
  if (missingRefs.length > 0) {
    warnings.push({
      code: "source_asset.missing_file",
      message: `${missingRefs.length} local source asset reference(s) did not resolve to files under the source root.`,
      sample: missingRefs.slice(0, 6).map((ref) => ref.raw),
    });
  }
  return warnings;
}

export function crawlSourceAssetPaths({ sourceRoot, htmlFiles = [], pageMappings = [], maxCssFiles = DEFAULT_MAX_CSS_FILES }) {
  const root = resolve(sourceRoot);
  const referencesByKey = new Map();
  const scannedByPath = new Map();
  const cssQueue = [];
  const queuedCss = new Set();
  const scanWarnings = [];
  const pageIds = pageIdsBySourcePath(pageMappings);

  function enqueueCss(sourcePath) {
    if (!sourcePath || queuedCss.has(sourcePath)) return;
    if (!existsSync(resolve(root, sourcePath))) return;
    if (queuedCss.size >= maxCssFiles) {
      if (!scanWarnings.some((warning) => warning.code === "source_asset.css_queue_truncated")) {
        scanWarnings.push({
          code: "source_asset.css_queue_truncated",
          message: `Source asset CSS crawl reached the ${maxCssFiles} file cap. Remaining CSS imports were skipped.`,
          sample: [sourcePath],
        });
      }
      return;
    }
    queuedCss.add(sourcePath);
    cssQueue.push(sourcePath);
  }

  function scanFile(sourcePath, kind) {
    const scanned = readScannableFile(sourcePath, kind, root);
    if (!scanned.ok) {
      if (scanned.warning) scanWarnings.push(scanned.warning);
      return;
    }
    if (!scannedByPath.has(sourcePath)) scannedByPath.set(sourcePath, scanned.file);

    const extracted = kind === "css" ? extractCssRefs(scanned.content) : extractHtmlRefs(scanned.content);
    for (const item of extracted) {
      const ref = resolveAssetRef(root, sourcePath, item.raw);
      if (!ref) continue;
      const stored = addReference(referencesByKey, ref, {
        path: sourcePath,
        kind,
        attribute: item.attribute,
        page_ids: pageIds.get(sourcePath) || [],
      });
      if (stored.asset_kind === "style" && stored.source_exists && stored.source_path) enqueueCss(stored.source_path);
    }
  }

  const sourceHtmlPaths = [...new Set((htmlFiles || []).map((file) => toPosixPath(file.path)).filter(Boolean))];
  for (const sourcePath of sourceHtmlPaths) scanFile(sourcePath, "html");
  while (cssQueue.length > 0) scanFile(cssQueue.shift(), "css");

  const references = [...referencesByKey.values()].sort((a, b) =>
    String(a.source_path || a.normalized).localeCompare(String(b.source_path || b.normalized))
  );
  const scanned_files = [...scannedByPath.values()].sort((a, b) => a.path.localeCompare(b.path));

  return {
    schema_version: SOURCE_ASSET_CRAWL_SCHEMA,
    scanned_files,
    references,
    summary: {
      scanned_file_count: scanned_files.length,
      reference_count: references.length,
      missing_count: references.filter((ref) => !ref.source_exists).length,
      outside_source_root_count: references.filter((ref) => ref.outside_source_root).length,
      source_root_fallback_count: references.filter((ref) => ref.source_root_fallback).length,
      rewrite_required_count: references.filter((ref) => ref.rewrite_required).length,
      root_assets_path_count: references.filter((ref) => ref.root_relative && /^assets\//i.test(ref.normalized)).length,
    },
    warnings: [...scanWarnings, ...summarizeWarnings(references)],
  };
}
