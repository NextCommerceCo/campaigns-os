import { createServer } from "node:http";
import { constants, openSync, fstatSync, readSync, closeSync, realpathSync, lstatSync } from "node:fs";
import { realpath, stat, lstat, open } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname } from "node:path";
import { VISUAL_MAX_REFERENCE_BYTES } from "./png-header.mjs";

// Declared inputs (packet, manifest and campaign files) are opened without
// blocking and read only when the opened descriptor is a regular file within
// `maxBytes`: a FIFO, socket, device or directory is refused before any read,
// so no declared path can hold the event loop ahead of a deadline.
// With a `root`, the path is opened first and only then resolved: the
// descriptor must be the very file (dev and ino) the contained realpath names,
// so a path replaced between the open and the check is refused, never read.
// `noFollow` also refuses a final component that is a link.
export const DECLARED_INPUT_MAX_BYTES = VISUAL_MAX_REFERENCE_BYTES;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const refusal = (code) => Object.assign(new Error(code), { code });
const inside = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"); };
// The resolved target is read with lstat: a final component swapped for a link
// after resolution is that link's own inode, which no opened file matches.
const sameFile = (info, target) => !target.isSymbolicLink() && info.dev === target.dev && info.ino === target.ino;
export function readRegularFileSync(path, { maxBytes = DECLARED_INPUT_MAX_BYTES, statOnly = false, root = null, noFollow = false } = {}) {
  const fd = openSync(path, READ_FLAGS | (noFollow ? NO_FOLLOW : 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw refusal("not_regular_file");
    if (root !== null) {
      const resolved = realpathSync(path);
      if (!inside(realpathSync(root), resolved) || !sameFile(info, lstatSync(resolved))) throw refusal("outside_root");
    }
    if (info.size > maxBytes) throw refusal("too_large");
    if (statOnly) return null;
    const chunks = [];
    let length = 0;
    while (length <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1 - length));
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      chunks.push(chunk.subarray(0, n)); length += n;
    }
    if (length > maxBytes) throw refusal("too_large");
    return Buffer.concat(chunks, length);
  } finally { closeSync(fd); }
}
// Whether a read of `path` would reach its bytes; the size is not judged here.
export const isRegularFileSync = (path, { root = null } = {}) => {
  try { readRegularFileSync(path, { statOnly: true, maxBytes: Infinity, root }); return true; } catch { return false; }
};
// The server's read: open, fstat, then resolve and match the descriptor against
// the contained target. Returns the resolved path (for the type) and the bytes.
async function readContainedFile(base, path, { maxBytes, statOnly }) {
  const handle = await open(path, READ_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw refusal("not_served");
    const resolved = await realpath(path);
    if (!inside(base, resolved) || !sameFile(info, await lstat(resolved))) throw refusal("not_served");
    if (statOnly) return { resolved, bytes: null };
    const chunks = [];
    let length = 0;
    while (length <= maxBytes) {
      const { bytesRead, buffer } = await handle.read(Buffer.alloc(Math.min(65536, maxBytes + 1 - length)));
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead)); length += bytesRead;
    }
    if (length > maxBytes) throw refusal("not_served");
    return { resolved, bytes: Buffer.concat(chunks, length) };
  } finally { await handle.close(); }
}

const TYPES = Object.freeze({ ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".avif": "image/avif", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".ico": "image/x-icon", ".json": "application/json" });
// This listener is also the sealed browser's refusing proxy. There is no
// outbound client: even absolute-form requests to our own origin are refused.
export async function startSourceHtmlServer({ root, signal, maxBytes = DECLARED_INPUT_MAX_BYTES } = {}) {
  const base = await realpath(root);
  if (!(await stat(base)).isDirectory()) throw new Error("source_root_unavailable");
  if (signal?.aborted) throw signal.reason;
  const refusals = new Map();
  const record = (target, connect = false) => {
    try {
      const origin = new URL(connect ? `https://${target}` : target).origin;
      if (refusals.has(origin) || refusals.size < 32) refusals.set(origin, (refusals.get(origin) || 0) + 1);
    } catch { /* never persist a malformed target */ }
  };
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    const end = (code) => { res.statusCode = code; res.end(); };
    if (!req.url.startsWith("/") || req.url.startsWith("//")) { record(req.url); return end(403); }
    if (!["GET", "HEAD"].includes(req.method)) return end(405);
    try {
      const pathname = decodeURIComponent(req.url.split("?")[0]);
      if (pathname.includes("\0") || pathname.includes("\\")) return end(404);
      const { resolved, bytes } = await readContainedFile(base, resolve(base, `.${pathname}`), { maxBytes, statOnly: req.method === "HEAD" });
      res.setHeader("content-type", TYPES[extname(resolved).toLowerCase()] || "application/octet-stream");
      res.statusCode = 200;
      res.end(bytes);
    } catch { end(404); }
  });
  server.on("connect", (req, socket) => {
    record(req.url, true);
    socket.end("HTTP/1.1 403 Forbidden\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  server.on("upgrade", (req, socket) => {
    record(req.url);
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  let closing;
  const close = () => closing ||= new Promise((done, reject) => {
    server.close((error) => error ? reject(error) : done());
    for (const socket of sockets) socket.destroy();
  });
  signal?.addEventListener("abort", () => { void close().catch(() => {}); }, { once: true });
  if (signal?.aborted) { await close(); throw signal.reason; }
  const port = server.address().port;
  return { origin: `http://127.0.0.1:${port}`, port,
    refused: () => [...refusals].sort(([a], [b]) => a.localeCompare(b)).map(([origin, count]) => ({ origin, count })), close };
}
