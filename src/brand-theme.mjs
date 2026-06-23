import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DEFAULTS_PATH = "contracts/brand-theme-source-defaults.figma-sections-export.v0.json";
const TARGET_TOKENS_PATH = "contracts/brand-theme-target-tokens.next-core.v0.json";

export const BRAND_THEME_REPORT_SCHEMA = "campaign-runtime-brand-theme/v0";
export const THEME_POLICIES = new Set(["inspect_only", "auto", "off"]);
export const THEME_CONTEXT_STATUSES = new Set(["ready", "ready_with_warnings", "missing", "blocked", "disabled"]);
export const THEME_REPORT_STATUSES = new Set(["applied", "skipped", "blocked", "needs_review"]);
export const THEME_CONFIDENCES = new Set(["high", "medium", "low", "none"]);

const SKIP_DIRS = new Set([".git", "node_modules", "_site", "dist", "build", ".next", "coverage", "qa-output"]);
const BRAND_LAYER_FILENAMES = new Set(["brand-theme.css", "checkout-brand.css"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonIfExists(path) {
  return path && existsSync(path) ? readJson(path) : null;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function resolveFromFile(filePath, targetPath) {
  if (!isNonEmptyString(targetPath)) return null;
  if (isAbsolute(targetPath)) return resolve(targetPath);
  return resolve(dirname(resolve(filePath)), targetPath);
}

function relFromDir(dirPath, targetPath) {
  const rel = relative(resolve(dirPath), resolve(targetPath));
  return rel || ".";
}

function relativeArtifactPath(targetRepo, path) {
  if (!targetRepo || !path) return path || null;
  return relFromDir(targetRepo, path);
}

function loadContracts(repoRoot = ROOT) {
  return {
    sourceDefaults: readJson(resolve(repoRoot, SOURCE_DEFAULTS_PATH)),
    targetTokens: readJson(resolve(repoRoot, TARGET_TOKENS_PATH)),
  };
}

function issue(code, message, detail = null) {
  return detail ? { code, message, detail } : { code, message };
}

function shellToken(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_/@%+=:,.-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function cleanCssRef(value) {
  const cleaned = String(value || "").trim().replace(/^["']|["']$/g, "").split("#")[0].split("?")[0];
  if (!cleaned || !cleaned.endsWith(".css")) return null;
  if (/^(?:https?:|data:|javascript:|\/\/)/i.test(cleaned)) return null;
  return cleaned.replace(/^\/+/, "");
}

function candidateRoleFromPath(path, fallback = "shared") {
  const lower = String(path || "").toLowerCase();
  if (lower.includes("presell")) return "presell";
  if (lower.includes("landing") || lower.includes("lander") || lower.includes("lp")) return "landing";
  if (lower.includes("checkout")) return "checkout";
  if (lower.includes("upsell")) return "upsell";
  return fallback;
}

function roleFromPageMapping(mapping) {
  return candidateRoleFromPath(mapping?.page_id, "page");
}

function addUniquePath(paths, path) {
  if (!path) return;
  const resolved = resolve(path);
  if (!paths.some((existing) => resolve(existing) === resolved)) paths.push(resolved);
}

function candidateCssPathsForRef(sourceRoot, htmlPath, ref) {
  const cleaned = cleanCssRef(ref);
  if (!cleaned) return [];
  const paths = [];
  addUniquePath(paths, resolve(dirname(htmlPath), cleaned));
  addUniquePath(paths, resolve(sourceRoot, cleaned));
  addUniquePath(paths, resolve(sourceRoot, "assets", cleaned));
  if (cleaned.startsWith("css/")) addUniquePath(paths, resolve(sourceRoot, "assets", cleaned));
  if (!cleaned.includes("/")) addUniquePath(paths, resolve(sourceRoot, "assets/css", cleaned));
  return paths;
}

function extractCssRefs(content) {
  const refs = [];
  const linkPattern = /<link\b[^>]*\bhref\s*=\s*["']([^"']+\.css(?:[?#][^"']*)?)["'][^>]*>/gi;
  for (const match of content.matchAll(linkPattern)) refs.push(match[1]);

  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (frontmatter) {
    const block = frontmatter[1];
    const linePattern = /(?:^|\s|-\s*)(["']?[^"'\n,\]]+\.css["']?)/g;
    for (const match of block.matchAll(linePattern)) refs.push(match[1]);
  }

  const importPattern = /@import\s+(?:url\()?["']?([^"')]+\.css(?:[?#][^"')]+)?)["']?\)?/gi;
  for (const match of content.matchAll(importPattern)) refs.push(match[1]);
  return [...new Set(refs.map(cleanCssRef).filter(Boolean))];
}

function extractRootBlocks(content) {
  const blocks = [];
  const rootPattern = /:root\s*\{([\s\S]*?)\}/g;
  let index = 0;
  for (const match of content.matchAll(rootPattern)) {
    blocks.push({ index, body: match[1], offset: match.index || 0 });
    index += 1;
  }
  return blocks;
}

function extractStyleBlocks(content) {
  const blocks = [];
  const stylePattern = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let index = 0;
  for (const match of content.matchAll(stylePattern)) {
    blocks.push({ index, body: match[1] || "", offset: match.index || 0 });
    index += 1;
  }
  return blocks;
}

export function parseRootCustomProperties(content) {
  const tokens = {};
  const warnings = [];
  for (const block of extractRootBlocks(content)) {
    const declarationPattern = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/g;
    for (const match of block.body.matchAll(declarationPattern)) {
      tokens[match[1].trim()] = match[2].trim();
    }
    const bodyWithoutMatches = block.body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(declarationPattern, "")
      .trim();
    if (bodyWithoutMatches) {
      warnings.push(`Unparsed content in :root block ${block.index}.`);
    }
  }
  return { tokens, warnings };
}

function tokenNameParts(name) {
  return String(name || "").toLowerCase().replace(/^--/, "").split(/[^a-z0-9]+/).filter(Boolean);
}

function hasTokenPart(parts, values) {
  return values.some((value) => parts.includes(value));
}

function hasTokenSequence(parts, firstValues, secondValues) {
  return parts.some((part, index) => firstValues.includes(part) && secondValues.includes(parts[index + 1]));
}

function isSurfaceBgToken(parts) {
  if (hasTokenPart(parts, ["surface", "background"])) return true;
  if (parts.length === 1 && parts[0] === "bg") return true;
  return hasTokenSequence(parts, ["page", "body", "site"], ["bg"])
    || hasTokenSequence(parts, ["bg"], ["page", "body", "site"]);
}

function isTextInverseToken(parts) {
  return hasTokenSequence(parts, ["text", "foreground"], ["inverse"])
    || hasTokenSequence(parts, ["inverse"], ["text", "foreground"])
    || hasTokenSequence(parts, ["on"], ["primary", "cta", "brand", "accent"]);
}

function isTargetContractToken(name) {
  const lower = String(name || "").toLowerCase();
  return lower.startsWith("--brand--color--") || lower.startsWith("--component--") || lower.startsWith("--system-colors--");
}

function inferDesignIntentTokens(content, rootTokens = {}) {
  const tokens = {};
  const addToken = (name, value) => {
    const color = normalizeColor(value);
    if (color && !tokens[name]) tokens[name] = color;
  };

  for (const [name, value] of Object.entries(rootTokens || {})) {
    const color = normalizeColor(value);
    if (!color) continue;
    const lower = name.toLowerCase();
    if (isTargetContractToken(lower)) continue;
    const parts = tokenNameParts(lower);
    const ctaName = hasTokenPart(parts, ["cta", "button", "btn"]);
    if (!ctaName && (hasTokenSequence(parts, ["brand"], ["primary", "main"]) || (hasTokenPart(parts, ["primary"]) && !hasTokenPart(parts, ["text", "foreground", "surface", "background", "bg", "border", "outline"])))) {
      addToken("--brand-primary", color);
    }
    if (ctaName) {
      addToken("--brand-cta", color);
    }
    if (hasTokenPart(parts, ["accent"])) {
      addToken("--brand-accent", color);
    }
    const hasCardSurfacePart = hasTokenPart(parts, ["card", "panel"]);
    if (!hasCardSurfacePart && isSurfaceBgToken(parts)) addToken("--surface-bg", color);
    if (
      hasTokenSequence(parts, ["surface"], ["card", "panel"])
      || hasTokenSequence(parts, ["card", "panel"], ["surface", "background", "bg"])
    ) {
      addToken("--surface-card", color);
    }
    if (hasTokenPart(parts, ["text"]) && hasTokenPart(parts, ["primary", "main"])) addToken("--text-primary", color);
    if (hasTokenPart(parts, ["text", "foreground"]) && hasTokenPart(parts, ["secondary", "muted", "subtle"])) addToken("--text-secondary", color);
    if (isTextInverseToken(parts)) addToken("--text-inverse", color);
    if (hasTokenPart(parts, ["border", "outline", "stroke", "ring"])) addToken("--border-default", color);
    if (hasTokenPart(parts, ["rating", "star", "review"])) addToken("--rating-star", color);
  }

  const rulePattern = /([^{}]+)\{([^{}]+)\}/g;
  for (const match of content.matchAll(rulePattern)) {
    const selector = match[1] || "";
    for (const declaration of match[2].split(";")) {
      const [rawName, ...rawValueParts] = declaration.split(":");
      const name = String(rawName || "").trim().toLowerCase();
      const rawValue = rawValueParts.join(":");
      const color = resolveDeclarationColor(rawValue, rootTokens);
      if (!color) continue;
      if (["background", "background-color"].includes(name)) {
        if (/(header|nav|announcement|brand|hero)/i.test(selector) && isStrongBrandColor(color)) {
          addToken("--brand-primary", color);
        } else if (isCtaLikeSelector(selector) && isStrongBrandColor(color)) {
          addToken("--button-primary-bg", color);
          addToken("--brand-cta", color);
          addToken("--brand-accent", color);
        } else if (/(card|panel|summary|product|form|checkout)/i.test(selector) && !isStrongBrandColor(color)) {
          addToken("--surface-card", color);
        } else if (/(body|main|page|wrapper)/i.test(selector) && !isStrongBrandColor(color)) {
          addToken("--surface-bg", color);
        }
      }
      if (["border", "border-color", "outline", "outline-color", "box-shadow"].includes(name)) {
        addToken("--border-default", color);
      }
      if (name === "color") {
        if (/(star|rating|review)/i.test(selector)) addToken("--rating-star", color);
        else if (isCtaLikeSelector(selector)) addToken("--text-inverse", color);
        else if (/(muted|secondary|sub|caption|small)/i.test(selector)) addToken("--text-secondary", color);
        else if (!isStrongBrandColor(color)) addToken("--text-primary", color);
      }
    }
  }
  if (tokens["--brand-cta"] && !tokens["--brand-accent"]) tokens["--brand-accent"] = tokens["--brand-cta"];
  if (tokens["--brand-accent"] && !tokens["--rating-star"]) tokens["--rating-star"] = tokens["--brand-accent"];
  return tokens;
}

function isCtaLikeSelector(selector) {
  return /(?:^|[.#\s:_-])(?:cta|button|btn|submit|cart|buy|order)(?:$|[.#\s:_-])/i.test(String(selector || ""));
}

function extractDeclarationColor(value) {
  const cleaned = String(value || "").replace(/!important/gi, "").trim();
  const exact = normalizeColor(cleaned);
  if (exact) return exact;
  const match = cleaned.match(/#[0-9a-f]{3,6}\b|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)/i);
  return match ? normalizeColor(match[0]) : null;
}

function resolveDeclarationColor(value, tokens = {}) {
  const direct = extractDeclarationColor(value);
  if (direct) return direct;
  const varMatch = String(value || "").match(/var\(\s*(--[A-Za-z0-9_-]+)/);
  if (!varMatch) return null;
  return extractDeclarationColor(tokens[varMatch[1]]);
}

function isStrongBrandColor(value) {
  const rgb = colorToRgb(value);
  if (!rgb) return false;
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  const spread = max - min;
  if (max < 32 || min > 242) return false;
  if (spread < 24) return false;
  const saturation = max === 0 ? 0 : spread / max;
  return saturation >= 0.16;
}

function candidateFromFile(path, role, source = "css_file", referencedBy = []) {
  const content = readFileSync(path, "utf8");
  const parsed = parseRootCustomProperties(content);
  const inferred = inferDesignIntentTokens(content, parsed.tokens);
  return {
    source,
    path,
    role,
    hash: sha256File(path),
    tokens: { ...inferred, ...parsed.tokens },
    warnings: parsed.warnings,
    referenced_by: referencedBy,
  };
}

function inlineCandidatesFromHtml(path, role) {
  const content = readFileSync(path, "utf8");
  const candidates = [];
  for (const styleBlock of extractStyleBlocks(content)) {
    for (const block of extractRootBlocks(styleBlock.body)) {
      const parsed = parseRootCustomProperties(`:root {${block.body}}`);
      if (Object.keys(parsed.tokens).length === 0) continue;
      const inferred = inferDesignIntentTokens(styleBlock.body, parsed.tokens);
      candidates.push({
        source: "html_inline_root",
        path,
        role,
        hash: sha256(`${path}:${styleBlock.index}:${block.index}:${block.body}`),
        inline_block_index: styleBlock.index,
        tokens: { ...inferred, ...parsed.tokens },
        warnings: parsed.warnings,
        referenced_by: [],
      });
    }
  }
  return candidates;
}

function collectManifestCssRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectManifestCssRefs(item, refs);
    return refs;
  }
  if (isObject(value)) {
    for (const item of Object.values(value)) collectManifestCssRefs(item, refs);
    return refs;
  }
  if (typeof value === "string") {
    const cleaned = cleanCssRef(value);
    if (cleaned) refs.push(cleaned);
  }
  return refs;
}

function discoverThemeCandidates({ sourceRoot, pageMappings = [], manifest = null }) {
  const candidates = [];
  const seenFiles = new Set();

  function addFile(path, role, source, referencedBy = []) {
    if (!path || seenFiles.has(resolve(path)) || !existsSync(path) || !statSync(path).isFile()) return;
    seenFiles.add(resolve(path));
    candidates.push(candidateFromFile(path, role, source, referencedBy));
  }

  for (const conventional of [
    "assets/css/tokens.css",
    "assets/css/landing/tokens.css",
    "assets/css/presell/tokens.css",
    "css/tokens.css",
    "css/landing/tokens.css",
    "css/presell/tokens.css",
    "tokens.css",
  ]) {
    addFile(resolve(sourceRoot, conventional), candidateRoleFromPath(conventional, "shared"), "conventional_token_path");
  }

  for (const mapping of Array.isArray(pageMappings) ? pageMappings : []) {
    if (!isNonEmptyString(mapping?.path)) continue;
    const htmlPath = resolve(sourceRoot, mapping.path);
    if (!existsSync(htmlPath) || !statSync(htmlPath).isFile()) continue;
    const role = roleFromPageMapping(mapping);
    candidates.push(...inlineCandidatesFromHtml(htmlPath, role));
    const content = readFileSync(htmlPath, "utf8");
    for (const ref of extractCssRefs(content)) {
      for (const cssPath of candidateCssPathsForRef(sourceRoot, htmlPath, ref)) {
        addFile(cssPath, candidateRoleFromPath(ref, role), "mapped_html_reference", [{ page_id: mapping.page_id || null, path: mapping.path, ref }]);
      }
    }
  }

  for (const ref of [...new Set(collectManifestCssRefs(manifest))]) {
    for (const cssPath of candidateCssPathsForRef(sourceRoot, sourceRoot, ref)) {
      addFile(cssPath, candidateRoleFromPath(ref, "shared"), "manifest_reference", [{ ref }]);
    }
  }

  return candidates;
}

function normalizeColor(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw.includes("var(")) return null;
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const valueHex = hex[1].toLowerCase();
    if (valueHex.length === 3) return `#${valueHex.split("").map((part) => `${part}${part}`).join("")}`;
    return `#${valueHex}`;
  }
  const rgb = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(\d?(?:\.\d+)?|1(?:\.0+)?))?\s*\)$/);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
    if (alpha !== 1) return null;
    const parts = rgb.slice(1, 4).map((part) => Number(part));
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}

function colorToRgb(value) {
  const normalized = normalizeColor(value);
  if (!normalized) return null;
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((part) => Math.round(part).toString(16).padStart(2, "0")).join("")}`;
}

function mixColor(value, target, amount) {
  const rgb = colorToRgb(value);
  if (!rgb) return null;
  const targetRgb = target === "white" ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  return rgbToHex({
    r: rgb.r + (targetRgb.r - rgb.r) * amount,
    g: rgb.g + (targetRgb.g - rgb.g) * amount,
    b: rgb.b + (targetRgb.b - rgb.b) * amount,
  });
}

function relativeLuminance({ r, g, b }) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(luminanceA, luminanceB) {
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

// Pick the foreground color (dark vs light) most legible on `bgValue`. A light
// brand background (yellow/white/pastel) yields a dark foreground; a dark or
// saturated background yields a light one. This is the fix for white-on-light
// CTA text: never trust a copied source --text-inverse (which defaults to
// white), always derive from the background's luminance.
function readableForeground(bgValue, choices = {}) {
  const bgRgb = colorToRgb(bgValue);
  if (!bgRgb) return null;
  // Normalize the choices once so the emitted value is always 6-digit hex,
  // regardless of how the contract spells them (e.g. "#000" -> "#000000").
  const darkValue = normalizeColor(choices.dark) || "#0a0a0a";
  const lightValue = normalizeColor(choices.light) || "#ffffff";
  const bgLuminance = relativeLuminance(bgRgb);
  const darkContrast = contrastRatio(bgLuminance, relativeLuminance(colorToRgb(darkValue)));
  const lightContrast = contrastRatio(bgLuminance, relativeLuminance(colorToRgb(lightValue)));
  const useDark = darkContrast >= lightContrast;
  return {
    value: useDark ? darkValue : lightValue,
    contrast: Math.round(Math.max(darkContrast, lightContrast) * 100) / 100,
    on: useDark ? "dark" : "light",
  };
}

// Emit foreground/on-color tokens derived from the luminance of the background
// each sits on. Pairing comes from the contract's foreground_derivations so the
// generator stays data-driven. A foreground target already mapped from a source
// token is left untouched; one whose paired backgrounds are all unmapped is
// skipped (no background to read).
function deriveForegroundMappings(existingMappings, targetTokens) {
  const config = targetTokens.foreground_derivations;
  if (!isObject(config) || !isObject(config.derivations)) return { mappings: [], warnings: [] };
  const allowedTargets = new Set(targetTokens.tokens || []);
  const choices = isObject(config.foreground_choices) ? config.foreground_choices : { dark: "#0a0a0a", light: "#ffffff" };
  const minContrast = Number(config.min_contrast_ratio) || 0;
  const valueByTarget = new Map();
  for (const mapping of existingMappings) {
    if (!valueByTarget.has(mapping.target)) valueByTarget.set(mapping.target, mapping.value);
  }
  const mappings = [];
  const warnings = [];
  for (const [foregroundTarget, backgroundCandidates] of Object.entries(config.derivations)) {
    if (!allowedTargets.has(foregroundTarget) || valueByTarget.has(foregroundTarget)) continue;
    const candidates = Array.isArray(backgroundCandidates) ? backgroundCandidates : [backgroundCandidates];
    const backgroundTarget = candidates.find((target) => valueByTarget.has(target));
    if (!backgroundTarget) continue;
    const backgroundValue = valueByTarget.get(backgroundTarget);
    const readable = readableForeground(backgroundValue, choices);
    if (!readable) continue;
    if (minContrast && readable.contrast < minContrast) {
      warnings.push(issue(
        "theme.foreground.low_contrast",
        `Derived ${foregroundTarget} on ${backgroundTarget} (${backgroundValue}) only reaches ${readable.contrast}:1 contrast (< ${minContrast}:1). Confirm the brand background or supply an explicit foreground.`,
        { foreground: foregroundTarget, background: backgroundTarget, background_value: backgroundValue, contrast: readable.contrast },
      ));
    }
    // Scale confidence by the achieved contrast so a strong derivation reads as
    // trustworthy as a direct mapping (AAA >= 7:1 high, AA >= 4.5:1 medium).
    const confidence = readable.contrast >= 7 ? "high" : readable.contrast >= 4.5 ? "medium" : "low";
    mappings.push({
      source: backgroundTarget,
      target: foregroundTarget,
      value: readable.value,
      confidence,
      derivation: { method: "foreground-from-luminance", background: backgroundTarget, background_value: backgroundValue, on: readable.on, contrast: readable.contrast },
    });
  }
  return { mappings, warnings };
}

function compareProducerDefaults(tokens, sourceDefaults) {
  const matches = [];
  const unresolved = [];
  const defaults = sourceDefaults.tokens || {};
  for (const [name, expected] of Object.entries(defaults)) {
    if (!(name in tokens)) continue;
    const actualColor = normalizeColor(tokens[name]);
    const expectedColor = normalizeColor(expected);
    if (!actualColor) {
      unresolved.push(name);
      continue;
    }
    if (actualColor === expectedColor) matches.push(name);
  }
  const coreTokens = Array.isArray(sourceDefaults.core_tokens) ? sourceDefaults.core_tokens : Object.keys(defaults);
  const presentCore = coreTokens.filter((name) => name in tokens);
  const matchedCore = presentCore.filter((name) => matches.includes(name));
  const exactCoreMatch = presentCore.length > 0 && matchedCore.length === presentCore.length;
  return {
    matched: exactCoreMatch,
    producer: sourceDefaults.producer,
    version: sourceDefaults.producer_version,
    matched_tokens: matches,
    unresolved_tokens: unresolved,
    present_core_tokens: presentCore,
  };
}

function selectSourceCandidate(candidates) {
  const withTokens = candidates.filter((candidate) => Object.keys(candidate.tokens || {}).length > 0);
  const roleRank = new Map([
    ["shared", 0],
    ["landing", 1],
    ["presell", 2],
    ["page", 3],
    ["checkout", 4],
    ["upsell", 5],
  ]);
  return withTokens.sort((a, b) => {
    const rankA = roleRank.has(a.role) ? roleRank.get(a.role) : 10;
    const rankB = roleRank.has(b.role) ? roleRank.get(b.role) : 10;
    if (rankA !== rankB) return rankA - rankB;
    return String(a.path).localeCompare(String(b.path));
  })[0] || null;
}

function collectTokenConflicts(candidates) {
  const valuesByToken = new Map();
  for (const candidate of candidates) {
    for (const [token, value] of Object.entries(candidate.tokens || {})) {
      if (!["--brand-primary", "--brand-accent", "--surface-bg", "--surface-card", "--text-primary", "--text-secondary"].includes(token)) continue;
      const normalized = normalizeColor(value) || value.trim();
      const entries = valuesByToken.get(token) || [];
      entries.push({ path: candidate.path, role: candidate.role, value: normalized });
      valuesByToken.set(token, entries);
    }
  }
  const conflicts = [];
  for (const [token, entries] of valuesByToken.entries()) {
    const unique = [...new Set(entries.map((entry) => entry.value))];
    if (unique.length > 1) conflicts.push({ token, entries });
  }
  return conflicts;
}

function mapTokens(tokens, targetTokens) {
  const allowedTargets = new Set(targetTokens.tokens || []);
  const mappings = [];
  const warnings = [];
  const sourceMappings = targetTokens.source_mappings || {};

  function addMapping(source, target, value, confidence = "high", derivation = null) {
    if (!allowedTargets.has(target)) {
      warnings.push(issue("theme.target_token.unknown", `Target token ${target} is not in the local next-core contract.`, { source }));
      return;
    }
    mappings.push({ source, target, value, confidence, derivation });
  }

  for (const [source, targets] of Object.entries(sourceMappings)) {
    if (!isNonEmptyString(tokens[source])) continue;
    for (const target of targets) addMapping(source, target, tokens[source].trim());
  }

  const derived = targetTokens.derived_mappings?.["--brand-primary"] || {};
  if (isNonEmptyString(tokens["--brand-primary"])) {
    for (const [target, config] of Object.entries(derived)) {
      const method = config.method;
      const value = method === "mix-black"
        ? mixColor(tokens["--brand-primary"], "black", Number(config.amount || 0))
        : method === "mix-white"
          ? mixColor(tokens["--brand-primary"], "white", Number(config.amount || 0))
          : null;
      if (value) addMapping("--brand-primary", target, value, "medium", config);
    }
  }

  const hasCta = mappings.some((mapping) => mapping.target === "--brand--color--cta-primary");
  if (!hasCta && isNonEmptyString(tokens["--brand-accent"])) {
    addMapping("--brand-accent", "--brand--color--cta-primary", tokens["--brand-accent"].trim(), "medium", { method: "cta-fallback-from-brand-accent" });
    warnings.push(issue("theme.cta.fallback", "No explicit CTA token was found; using --brand-accent as --brand--color--cta-primary."));
  } else if (!hasCta && isNonEmptyString(tokens["--brand-primary"])) {
    addMapping("--brand-primary", "--brand--color--cta-primary", tokens["--brand-primary"].trim(), "medium", { method: "cta-fallback-from-brand-primary" });
    warnings.push(issue("theme.cta.fallback", "No explicit CTA token was found; using --brand-primary as --brand--color--cta-primary."));
  }

  const hasSurface = mappings.some((mapping) => mapping.target === "--brand--color--surface");
  if (!hasSurface && isNonEmptyString(tokens["--surface-bg"])) {
    addMapping("--surface-bg", "--brand--color--surface", tokens["--surface-bg"].trim(), "medium", { method: "surface-fallback-from-background" });
  }

  const hasRating = mappings.some((mapping) => mapping.target === "--brand--color--rating-star");
  if (!hasRating && isNonEmptyString(tokens["--brand-accent"])) {
    addMapping("--brand-accent", "--brand--color--rating-star", tokens["--brand-accent"].trim(), "medium", { method: "rating-fallback-from-brand-accent" });
  }

  // Foreground/on-color tokens derive from the luminance of the background they
  // sit on (CTA, primary, accent), after all backgrounds are mapped above.
  const foreground = deriveForegroundMappings(mappings, targetTokens);
  for (const mapping of foreground.mappings) {
    addMapping(mapping.source, mapping.target, mapping.value, mapping.confidence, mapping.derivation);
  }
  warnings.push(...foreground.warnings);

  return { mappings, warnings };
}

function confidenceFor({ selected, defaultMatch, mappings, conflicts }) {
  if (!selected) return "none";
  if (defaultMatch.matched) return "low";
  const targets = new Set(mappings.map((mapping) => mapping.target));
  const hasCore = [
    "--brand--color--primary",
    "--brand--color--background",
    "--brand--color--text-primary",
  ].every((target) => targets.has(target));
  if (!hasCore) return "medium";
  if (conflicts.length > 0) return "medium";
  if (targets.has("--brand--color--cta-primary") || targets.has("--brand--color--accent")) return "high";
  return "medium";
}

function statusFor({ policy, selected, confidence, warnings, errors }) {
  if (policy === "off") return "disabled";
  if (errors.length) return "blocked";
  if (!selected || confidence === "none") return "missing";
  if (confidence === "low" || warnings.length) return "ready_with_warnings";
  return "ready";
}

function renderBrandThemeCss({ selected, mappings, confidence }) {
  const unique = [];
  const seen = new Set();
  for (const mapping of mappings) {
    if (seen.has(mapping.target)) continue;
    seen.add(mapping.target);
    unique.push(mapping);
  }
  const sourceLabel = selected?.path ? selected.path : "unknown source";
  const lines = [
    "/*",
    " * Generated by Campaigns OS brand-theme v0.",
    ` * Source: ${sourceLabel}`,
    ` * Confidence: ${confidence}`,
    " * Safety: :root custom-property overrides only.",
    " */",
    ":root {",
  ];
  for (const mapping of unique.sort((a, b) => a.target.localeCompare(b.target))) {
    lines.push(`  ${mapping.target}: ${mapping.value};`);
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

export function validateGeneratedCss(css) {
  const errors = [];
  const warnings = [];
  if (!isNonEmptyString(css)) {
    errors.push(issue("theme.css.empty", "Generated CSS is empty."));
    return { ok: false, errors, warnings };
  }
  if (/<\/?script\b|javascript:/i.test(css)) {
    errors.push(issue("theme.css.script", "Generated CSS contains script-like content."));
  }
  if (/url\s*\(\s*["']?(?:https?:|\/\/|data:|javascript:)/i.test(css)) {
    errors.push(issue("theme.css.remote_url", "Generated CSS must not reference remote/data/javascript URLs."));
  }

  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const rootBlocks = [];
  const residual = withoutComments.replace(/:root\s*\{([\s\S]*?)\}/g, (_match, body) => {
    rootBlocks.push(body);
    return "";
  }).trim();
  if (residual) {
    errors.push(issue("theme.css.selector", "Generated CSS must contain only :root blocks with custom properties.", { residual }));
  }
  if (rootBlocks.length === 0) {
    errors.push(issue("theme.css.root", "Generated CSS must include a :root block."));
  }
  for (const [index, block] of rootBlocks.entries()) {
    const stripped = block.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    for (const declaration of stripped.split(";")) {
      const trimmed = declaration.trim();
      if (!trimmed) continue;
      if (!/^--[A-Za-z0-9_-]+\s*:\s*[^{}<>]+$/.test(trimmed)) {
        errors.push(issue("theme.css.declaration", `Generated :root block ${index} contains a non-token declaration.`, { declaration: trimmed }));
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

function sourceFileEntry(candidate, targetRepo) {
  return {
    path: targetRepo ? relativeArtifactPath(targetRepo, candidate.path) : candidate.path,
    role: candidate.role,
    source: candidate.source,
    hash: candidate.hash,
    token_count: Object.keys(candidate.tokens || {}).length,
    inline_block_index: candidate.inline_block_index ?? null,
    referenced_by: candidate.referenced_by || [],
  };
}

function findExistingBrandLayers(targetRepo, expectedCssPath) {
  const layers = [];
  function add(path, source) {
    if (!path || !existsSync(path) || !statSync(path).isFile()) return;
    if (layers.some((layer) => resolve(layer.absolute_path) === resolve(path))) return;
    layers.push({ path: relativeArtifactPath(targetRepo, path), absolute_path: path, source });
  }
  add(expectedCssPath, "expected_artifact_path");

  function walk(dir, depth = 0) {
    if (!existsSync(dir) || !statSync(dir).isDirectory() || depth > 6) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), depth + 1);
        continue;
      }
      if (entry.isFile() && BRAND_LAYER_FILENAMES.has(entry.name)) {
        add(join(dir, entry.name), "target_repo_scan");
      }
    }
  }
  if (targetRepo && existsSync(join(targetRepo, "src"))) walk(join(targetRepo, "src"));
  return layers.map(({ absolute_path: _absolutePath, ...layer }) => layer);
}

function detectStaleArtifact({ reportPath, selected, confidence, expectedCssPath }) {
  if (!existsSync(expectedCssPath)) return { stale: false, reasons: [] };
  const reasons = [];
  if (!selected) reasons.push("no current source tokens were selected");
  if (confidence === "low" || confidence === "none") reasons.push(`current confidence is ${confidence}`);
  const prior = readJsonIfExists(reportPath);
  const priorHash = prior?.selected_source?.hash || null;
  if (priorHash && selected?.hash && priorHash !== selected.hash) {
    reasons.push("selected source hash changed since the existing theme report");
  }
  if (!prior) reasons.push("existing brand-theme.css has no paired theme-report.json");
  return { stale: reasons.length > 0, reasons };
}

function inferManifest(sourceRoot) {
  const manifestPath = resolve(sourceRoot, ".campaigns-os/source-html-manifest.json");
  return readJsonIfExists(manifestPath);
}

export function inspectBrandTheme({ packet, packetPath, context = null, policy = "inspect_only", outDir = null, force = false, repoRoot = ROOT } = {}) {
  if (!isObject(packet)) throw new Error("inspectBrandTheme requires packet object.");
  if (!isNonEmptyString(packetPath)) throw new Error("inspectBrandTheme requires packetPath.");
  const requestedPolicy = isNonEmptyString(policy) ? policy : "inspect_only";
  if (!THEME_POLICIES.has(requestedPolicy)) throw new Error(`Unsupported theme policy "${requestedPolicy}". Use inspect_only, auto, or off.`);

  const warnings = [];
  const errors = [];
  const contracts = loadContracts(repoRoot);
  const sourceRoot = resolveFromFile(packetPath, packet.source_html?.root);
  const targetRepo = resolveFromFile(packetPath, packet.assembly?.target_repo) || dirname(resolve(packetPath));
  const themeOutDir = outDir ? resolve(outDir) : resolve(targetRepo, ".campaign-runtime/theme");
  const cssPath = resolve(themeOutDir, "brand-theme.css");
  const reportPath = resolve(themeOutDir, "theme-report.json");

  if (requestedPolicy === "off") {
    const contextTheme = {
      status: "disabled",
      policy: requestedPolicy,
      source_kind: "html_funnel",
      confidence: "none",
      source_files: [],
      selected_source: null,
      generated: {
        css_path: relativeArtifactPath(targetRepo, cssPath),
        report_path: relativeArtifactPath(targetRepo, reportPath),
      },
      mappings: [],
      warnings: [],
    };
    return buildInspectionResponse({ packet, targetRepo, sourceRoot, cssPath, reportPath, contextTheme, report: null, css: null, errors, warnings });
  }

  if (!sourceRoot || !existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    errors.push(issue("theme.source_root", "Source root is missing or is not a directory."));
  }

  const contextManifest = Array.isArray(context?.source?.manifest?.pages) ? context.source.manifest : null;
  const manifest = errors.length ? null : (contextManifest || inferManifest(sourceRoot));
  const candidates = errors.length ? [] : discoverThemeCandidates({
    sourceRoot,
    pageMappings: packet.source_html?.pages || [],
    manifest,
  });
  const selected = selectSourceCandidate(candidates);
  const conflicts = collectTokenConflicts(candidates.filter((candidate) => Object.keys(candidate.tokens || {}).length > 0));
  for (const conflict of conflicts) {
    warnings.push(issue("theme.source_tokens.conflict", `Source token ${conflict.token} has conflicting values across source files.`, conflict));
  }

  const defaultMatch = selected
    ? compareProducerDefaults(selected.tokens, contracts.sourceDefaults)
    : {
        matched: false,
        producer: contracts.sourceDefaults.producer,
        version: contracts.sourceDefaults.producer_version,
        matched_tokens: [],
        unresolved_tokens: [],
        present_core_tokens: [],
      };
  if (defaultMatch.matched) {
    warnings.push(issue("theme.source_tokens.defaults", "Source tokens match figma-sections-export scaffold defaults; confirm brand values before applying to commerce pages."));
  }
  for (const token of defaultMatch.unresolved_tokens) {
    warnings.push(issue("theme.source_tokens.unresolved", `Source token ${token} uses an unresolved value; it cannot be compared to producer defaults.`));
  }

  const mapped = selected ? mapTokens(selected.tokens, contracts.targetTokens) : { mappings: [], warnings: [] };
  warnings.push(...mapped.warnings);
  const confidence = confidenceFor({ selected, defaultMatch, mappings: mapped.mappings, conflicts });
  const css = selected && mapped.mappings.length > 0 ? renderBrandThemeCss({ selected, mappings: mapped.mappings, confidence }) : null;
  const safety = css ? validateGeneratedCss(css) : { ok: false, errors: [issue("theme.css.empty", "No generated CSS because no source tokens were selected.")], warnings: [] };
  if (css && !safety.ok) errors.push(...safety.errors);

  const stale = detectStaleArtifact({ reportPath, selected, confidence, expectedCssPath: cssPath });
  if (stale.stale) {
    warnings.push(issue("theme.artifact.stale", "Existing brand-theme.css is stale or untracked; generate with --force or a new --out-dir before applying.", stale.reasons));
  }

  const status = statusFor({ policy: requestedPolicy, selected, confidence, warnings, errors });
  const canGenerate = Boolean(css && safety.ok && selected && !["low", "none"].includes(confidence));
  const canAutoGenerate = requestedPolicy === "auto" && canGenerate && confidence === "high" && (!existsSync(cssPath) || force) && !stale.stale;
  const sourceFiles = candidates.map((candidate) => sourceFileEntry(candidate, targetRepo));
  const selectedSource = selected ? sourceFileEntry(selected, targetRepo) : null;
  const generated = {
    css_path: relativeArtifactPath(targetRepo, cssPath),
    report_path: relativeArtifactPath(targetRepo, reportPath),
    safety,
    stale,
    can_generate: canGenerate,
    can_auto_generate: canAutoGenerate,
    overwrite_requires_force: existsSync(cssPath) && !force,
  };
  const contextTheme = {
    status,
    policy: requestedPolicy,
    source_kind: "html_funnel",
    producer: {
      name: selected ? contracts.sourceDefaults.producer : "unknown",
      version: selected ? contracts.sourceDefaults.producer_version : "unknown",
    },
    source_files: sourceFiles,
    selected_source: selectedSource,
    producer_defaults: defaultMatch,
    confidence,
    generated,
    mappings: mapped.mappings,
    unmapped_defaults: [],
    warnings,
  };
  const report = {
    schema_version: BRAND_THEME_REPORT_SCHEMA,
    generated_at: new Date().toISOString(),
    status,
    policy: requestedPolicy,
    source_kind: "html_funnel",
    confidence,
    source_files: sourceFiles,
    selected_source: selectedSource,
    producer_defaults: defaultMatch,
    conflicts,
    mappings: mapped.mappings,
    generated,
    existing_brand_layers: findExistingBrandLayers(targetRepo, cssPath),
    warnings,
    errors,
    next_action: nextActionForTheme({ status, confidence, canGenerate, canAutoGenerate, stale, policy: requestedPolicy }),
  };

  return buildInspectionResponse({ packet, targetRepo, sourceRoot, cssPath, reportPath, contextTheme, report, css, errors, warnings });
}

function nextActionForTheme({ status, confidence, canGenerate, canAutoGenerate, stale, policy }) {
  if (policy === "off") return "Theme discovery disabled.";
  if (status === "missing") return "Proceed without generated brand theme, or provide source tokens/design-system artifacts.";
  if (status === "blocked") return "Fix theme errors before applying a brand theme.";
  if (stale.stale) return "Regenerate brand-theme.css with --force or a clean --out-dir before applying.";
  if (canAutoGenerate) return "Auto policy can write brand-theme.css during prepare-build.";
  if (canGenerate) return "Run campaigns-os theme generate, then apply brand-theme.css after next-core.css on commerce pages.";
  if (confidence === "low") return "Confirm brand values; current source tokens look like producer defaults.";
  return "Review theme-report.json and decide whether to skip or collect stronger brand inputs.";
}

function buildInspectionResponse({ packet, targetRepo, sourceRoot, cssPath, reportPath, contextTheme, report, css, errors, warnings }) {
  return {
    ok: errors.length === 0,
    status: contextTheme.status,
    confidence: contextTheme.confidence,
    policy: contextTheme.policy,
    map_id: packet.spec?.map_id || null,
    public_route_slug: packet.campaign?.public_route_slug || null,
    source_root: sourceRoot ? relativeArtifactPath(targetRepo, sourceRoot) : null,
    paths: {
      css_path: relativeArtifactPath(targetRepo, cssPath),
      report_path: relativeArtifactPath(targetRepo, reportPath),
      out_dir: relativeArtifactPath(targetRepo, dirname(cssPath)),
    },
    absolute_paths: {
      css_path: cssPath,
      report_path: reportPath,
      out_dir: dirname(cssPath),
    },
    context_theme: contextTheme,
    report,
    css,
    errors,
    warnings,
    ready: contextTheme.status === "ready" ? [`Brand theme artifact can be generated with confidence ${contextTheme.confidence}.`] : [],
    next: {
      stage: "theme",
      owner: "campaigns-os",
      action: report?.next_action || "Review theme state.",
      actions: report?.next_action ? [report.next_action] : [],
    },
  };
}

export function writeThemeArtifacts(inspection, { writeCss = false, writeReport = true, force = false, packetPath = "<campaign-runtime.build.json>" } = {}) {
  const errors = [...(inspection.errors || [])];
  const wrote = { report: false, css: false };
  const alreadyCurrent = { css: false };
  const reportPath = resolvePathFromInspection(inspection, "report_path");
  const cssPath = resolvePathFromInspection(inspection, "css_path");

  if (writeReport && inspection.report) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(inspection.report, null, 2)}\n`);
    wrote.report = true;
  }

  if (writeCss) {
    if (!inspection.context_theme?.generated?.can_generate) {
      errors.push(issue("theme.generate.not_ready", "brand-theme.css is not ready to generate; inspect theme-report.json for missing/default/conflicting source tokens."));
    } else if (!inspection.css) {
      errors.push(issue("theme.generate.empty", "No generated CSS is available."));
    } else if (existsSync(cssPath) && !force) {
      const existingCss = readFileSync(cssPath, "utf8");
      if (existingCss === inspection.css) {
        alreadyCurrent.css = true;
      } else {
        const safeCommand = `campaigns-os theme generate --packet ${shellToken(packetPath)} --force`;
        errors.push(issue(
          "theme.generate.exists",
          `brand-theme.css already exists and differs from the current generated output; rerun \`${safeCommand}\` or pass a new --out-dir to overwrite safely.`,
          { safe_commands: [safeCommand] },
        ));
      }
    } else {
      mkdirSync(dirname(cssPath), { recursive: true });
      writeFileSync(cssPath, inspection.css);
      wrote.css = true;
    }
  }

  return {
    ...inspection,
    ok: errors.length === 0,
    status: errors.length ? "blocked" : inspection.status,
    errors,
    wrote,
    already_current: alreadyCurrent,
  };
}

function resolvePathFromInspection(inspection, key) {
  if (isNonEmptyString(inspection.absolute_paths?.[key])) return resolve(inspection.absolute_paths[key]);
  const targetRepo = inspection.absolute_paths?.target_repo || null;
  const path = inspection.paths?.[key];
  if (!isNonEmptyString(path)) throw new Error(`Missing inspection path ${key}.`);
  if (isAbsolute(path)) return resolve(path);
  if (targetRepo) return resolve(targetRepo, path);
  return resolve(path);
}

export function validateThemeContextBlock(theme) {
  const errors = [];
  const warnings = [];
  if (theme === undefined || theme === null) return { ok: true, errors, warnings, ready: [] };
  if (!isObject(theme)) {
    errors.push(issue("context.theme.type", "context.theme must be an object."));
    return { ok: false, errors, warnings, ready: [] };
  }
  validateEnum(theme.status, THEME_CONTEXT_STATUSES, "context.theme.status", errors);
  validateEnum(theme.policy, THEME_POLICIES, "context.theme.policy", errors);
  validateEnum(theme.confidence, THEME_CONFIDENCES, "context.theme.confidence", errors);
  if (theme.source_kind !== "html_funnel") errors.push(issue("context.theme.source_kind", "context.theme.source_kind must be html_funnel in v0."));
  if (theme.generated) validateGeneratedPaths(theme.generated, "context.theme.generated", errors);
  if (theme.generated?.stale?.stale === true) {
    warnings.push(issue("context.theme.stale", "context.theme reports a stale brand-theme artifact."));
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    ready: errors.length ? [] : [`Brand theme context ${theme.status || "unknown"} (${theme.confidence || "unknown"} confidence)`],
  };
}

export function validateAssemblyReportThemeBlock(theme) {
  const errors = [];
  const warnings = [];
  if (theme === undefined || theme === null) return { ok: true, errors, warnings, ready: [] };
  if (!isObject(theme)) {
    errors.push(issue("report.theme.type", "report.theme must be an object."));
    return { ok: false, errors, warnings, ready: [] };
  }
  validateEnum(theme.status, THEME_REPORT_STATUSES, "report.theme.status", errors);
  if (theme.css_path !== undefined && theme.css_path !== null && (!isNonEmptyString(theme.css_path) || isAbsolute(theme.css_path))) {
    errors.push(issue("report.theme.css_path", "report.theme.css_path must be a relative path when present."));
  }
  if (theme.load_order !== undefined && !["after-next-core", "not-applied", "unknown"].includes(theme.load_order)) {
    errors.push(issue("report.theme.load_order", "report.theme.load_order must be after-next-core, not-applied, or unknown."));
  }
  if (theme.status === "applied" && theme.load_order !== "after-next-core") {
    errors.push(issue("report.theme.load_order", "Applied brand theme must report load_order after-next-core."));
  }
  if (theme.commerce_pages !== undefined && !Array.isArray(theme.commerce_pages)) {
    errors.push(issue("report.theme.commerce_pages", "report.theme.commerce_pages must be an array when present."));
  }
  if (theme.evidence !== undefined && !Array.isArray(theme.evidence)) {
    errors.push(issue("report.theme.evidence", "report.theme.evidence must be an array when present."));
  }
  if (theme.warnings !== undefined && !Array.isArray(theme.warnings)) {
    errors.push(issue("report.theme.warnings", "report.theme.warnings must be an array when present."));
  }
  if (theme.repair_loop_defect !== undefined && theme.repair_loop_defect !== null) {
    if (!isObject(theme.repair_loop_defect)) {
      errors.push(issue("report.theme.repair_loop_defect", "report.theme.repair_loop_defect must be null or an object when present."));
    }
  }
  if (theme.waiver !== undefined && theme.waiver !== null) {
    if (!isObject(theme.waiver) || !isNonEmptyString(theme.waiver.reason)) {
      errors.push(issue("report.theme.waiver", "report.theme.waiver must be null or an object with a non-empty reason string."));
    }
  }
  // needs_review is an unresolved decision, never a green signal: it means a
  // generatable brand layer exists but nobody generated/applied/waived it.
  // Surfacing it under `ready` is exactly how the recovery-relief dogfood run
  // shipped starter-blue commerce pages, so it reports as a warning instead.
  if (errors.length === 0 && theme.status === "needs_review" && !theme.waiver) {
    warnings.push(issue(
      "report.theme.needs_review",
      "Assembly report theme is needs_review: a generatable brand theme has not been generated/applied. The theme gate blocks polish/deploy/QA for commerce-page campaigns until report.theme is applied (load_order after-next-core) or explicitly waived (campaigns-os theme waive).",
    ));
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    ready: errors.length || theme.status === "needs_review" ? [] : [`Assembly report theme ${theme.status || "unknown"}`],
  };
}

function validateEnum(value, allowed, code, errors) {
  if (!allowed.has(value)) {
    errors.push(issue(code, `${code} must be one of: ${[...allowed].join(", ")}.`));
  }
}

function validateGeneratedPaths(generated, prefix, errors) {
  for (const key of ["css_path", "report_path"]) {
    const value = generated[key];
    if (value !== undefined && (!isNonEmptyString(value) || isAbsolute(value))) {
      errors.push(issue(`${prefix}.${key}`, `${prefix}.${key} must be a relative path when present.`));
    }
  }
}
