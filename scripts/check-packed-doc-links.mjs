import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

// These are documentation links, not links inside illustrative code. Preserve
// newlines so failures still identify the installed file and its source line.
function prose(markdown) {
  let fence = null;
  return markdown.replace(/<!--[\s\S]*?-->/g, (text) => text.replace(/[^\n]/g, " "))
    .split("\n").map((line) => {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
        return "";
      }
      if (marker) { fence = marker[1]; return ""; }
      return line;
    }).join("\n");
}

function destination(text, offset) {
  let i = offset;
  while (/\s/.test(text[i] || "") && i < text.length) i += 1;
  if (text[i] === "<") {
    const end = text.indexOf(">", i + 1);
    return end < 0 ? null : text.slice(i + 1, end);
  }
  const start = i;
  let depth = 0;
  for (; i < text.length; i += 1) {
    if (text[i] === "\\") { i += 1; continue; }
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      if (!depth) break;
      depth -= 1;
    } else if (/\s/.test(text[i]) && !depth) break;
  }
  return text.slice(start, i).replace(/\\([\\()[\]<> ])/g, "$1");
}

function links(markdown) {
  const text = prose(markdown).replace(/(`+)([\s\S]*?)\1(?!`)/g, (code) => code.replace(/[^\n]/g, " "));
  const definitions = new Map();
  const normalize = (label) => label.trim().replace(/\s+/g, " ").toLowerCase();
  for (const match of text.matchAll(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(.*)$/gm)) {
    definitions.set(normalize(match[1]), destination(match[2], 0));
  }
  const found = [];
  for (const match of text.matchAll(/\[([^\]\n]*)\](?!:)/g)) {
    const end = match.index + match[0].length;
    let href;
    if (text[end] === "(") href = destination(text, end + 1);
    else if (text[end] === "[") {
      const close = text.indexOf("]", end + 1);
      if (close >= 0) href = definitions.get(normalize(text.slice(end + 1, close) || match[1]));
    } else href = definitions.get(normalize(match[1]));
    if (href) found.push({ href, line: text.slice(0, match.index).split("\n").length });
  }
  return found;
}

function anchors(markdown) {
  const text = prose(markdown);
  const ids = new Set();
  const counts = new Map();
  for (const match of text.matchAll(/<(?:a|[a-z][\w-]*)\b[^>]*\b(?:id|name)=["']([^"']+)["'][^>]*>/gi)) ids.add(match[1]);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const atx = lines[i].match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
    const setext = i + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1]) && lines[i].trim();
    if (!atx && !setext) continue;
    const title = (atx ? atx[1] : lines[i])
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, "")
      .replace(/[\\`*_~]/g, (char) => char === "_" ? "_" : "");
    const slug = title.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    let id = slug;
    let count = counts.get(slug) || 0;
    while (ids.has(id)) id = `${slug}-${++count}`;
    counts.set(slug, count);
    ids.add(id);
    if (setext && !atx) i += 1;
  }
  return ids;
}

/** Validate prose links in the installed documentation graph, without network reads. */
export function checkPackedDocLinks(packageRoot, entryDocs) {
  const root = resolve(packageRoot);
  const errors = [];
  const queue = [...entryDocs];
  const seen = new Set();
  const anchorCache = new Map();
  for (let index = 0; index < queue.length; index += 1) {
    const path = resolve(root, queue[index]);
    if (seen.has(path)) continue;
    seen.add(path);
    if (!existsSync(path)) { errors.push(`${queue[index]}: documentation file missing from package`); continue; }
    for (const { href, line } of links(readFileSync(path, "utf8"))) {
      // Web, mail, absolute site links and source examples linked through a
      // public URL are outside this package. Never fetch them during pack.
      if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(href)) continue;
      const [location, rawAnchor] = href.split("#", 2);
      let localPath;
      let anchor;
      try {
        localPath = decodeURIComponent(location.split("?", 1)[0]);
        anchor = rawAnchor ? decodeURIComponent(rawAnchor) : "";
      } catch {
        errors.push(`${relative(root, path)}:${line}: invalid encoded link ${href}`);
        continue;
      }
      const target = localPath ? resolve(dirname(path), localPath) : path;
      const targetName = relative(root, target);
      const label = `${relative(root, path)}:${line}: ${href}`;
      if (targetName === ".." || targetName.startsWith("../") || !existsSync(target) || !statSync(target).isFile()) {
        errors.push(`${label} is missing from the package`);
        continue;
      }
      if (/\.md$/i.test(target)) {
        queue.push(targetName);
        if (anchor) {
          if (!anchorCache.has(target)) anchorCache.set(target, anchors(readFileSync(target, "utf8")));
          if (!anchorCache.get(target).has(anchor)) errors.push(`${label} has no matching heading or HTML anchor`);
        }
      }
    }
  }
  return errors;
}
