// Loopback harness for the unit 1.3 (media weight) browser rows. Imported by
// src/polish-media-weight.browser.test.mjs (F1.3 P rows) and
// src/qc-real-1-3.browser.test.mjs (the F1.0 rows that name
// 1.3 as producer). It registers no tests of its own.
//
// Everything here is synthetic: pages and images are generated in memory and
// served by raw TCP stub servers on 127.0.0.1, one per origin (a second port
// is "another origin"). Responses are written byte for byte, one request per
// connection (`Connection: close`), so a complete transfer's measured wire
// bytes are exactly its status line, headers and body.
//
// No network beyond loopback:
// - importing src/qc-test-factories.mjs first installs its Node-side guard
//   (fetch and node:http/https request blocked and recorded even when the
//   caller swallows the error); every capture checks it on return, and each
//   test file also registers assertNoNetworkAttempts as afterEach;
// - every capture runs Chromium through an injected launcher whose browser,
//   contexts and pages carry passive listeners on every request-bearing event
//   Playwright exposes (request, requestfailed, requestfinished, response,
//   websocket, worker, serviceworker, download, popup). Any URL with a host
//   other than 127.0.0.1/localhost/[::1] fails the capture
//   (loopbackGuard().assertLoopbackOnly), whether or not the capture threw.
// - every stub origin logs each request it receives; rows compare the
//   complete log with the exact list the setup implies (assertRequestLog),
//   so one extra request (a probe that fetches) fails the row.
//
// Browser gate: Chromium is launched once at import. Without
// CAMPAIGNS_OS_REQUIRE_BROWSER=1 a missing Chromium skips the rows (the
// repo's pattern, src/qa-order-bump.browser.test.mjs); with it, a launch
// failure fails the file, so the browser lane never reports a false green.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import net from "node:net";
import test from "node:test";
import zlib from "node:zlib";

import { BUILD_FP, SLUG, assertNoNetworkAttempts } from "./qc-test-factories.mjs";

export { BUILD_FP, SLUG };
export const VIEWPORTS = Object.freeze(["desktop", "mobile"]);
export const MEDIA_WEIGHT_SCHEMA = "campaigns-os-polish-media-weight/v0";
export const route = (name) => `/${SLUG}/${name}/`;

// The existing resource_id: sha256 of the canonical href, query included
// (src/polish-capture.mjs:167-169). Computed here from the URL the stub
// serves, never read back from the code under test.
export const rid = (url) => {
  const href = new URL(url);
  href.hash = "";
  return `sha256:${createHash("sha256").update(href.href).digest("hex")}`;
};
// URLs are persisted as origin+path only.
export const originPath = (url) => {
  const href = new URL(url);
  return `${href.origin}${href.pathname}`;
};

// ---------------------------------------------------------------------------
// Synthetic images

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

// A valid grayscale PNG of width × height natural pixels. `bodyBytes` pads it
// to exactly that many bytes with a private ancillary chunk after the image
// data, which decoders skip.
export function png(width, height, { bodyBytes = null, shade = 0x80 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  const raw = Buffer.alloc((width + 1) * height, shade);
  for (let row = 0; row < height; row += 1) raw[row * (width + 1)] = 0; // filter: none
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", zlib.deflateSync(raw))];
  const end = pngChunk("IEND", Buffer.alloc(0));
  if (bodyBytes != null) {
    const pad = bodyBytes - Buffer.concat(parts).length - end.length - 12;
    if (pad < 0) throw new Error(`png(${width}, ${height}) cannot be padded to ${bodyBytes} bytes`);
    parts.push(pngChunk("paDd", Buffer.alloc(pad)));
  }
  parts.push(end);
  return Buffer.concat(parts);
}

export const svg = (width, height) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#888"/></svg>`,
);

// ---------------------------------------------------------------------------
// Stub origins and response handlers

const headerBlock = (status, type, length, extra = []) => [
  `HTTP/1.1 ${status}`,
  ...(type ? [`Content-Type: ${type}`] : []),
  ...(length == null ? [] : [`Content-Length: ${length}`]),
  ...extra,
  "Connection: close",
  "",
  "",
].join("\r\n");

export const respond = (status, type, body = Buffer.alloc(0), extra = []) => (socket) => {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  socket.end(Buffer.concat([Buffer.from(headerBlock(status, type, bytes.length, extra), "latin1"), bytes]));
};

export const page = (body, { head = "" } = {}) => respond(
  "200 OK",
  "text/html; charset=utf-8",
  `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic</title><link rel="icon" href="data:,"><style>body{margin:0}</style>${head}</head><body>${body}</body></html>`,
);

// The body length that makes a complete 200 response exactly `wireBytes`
// bytes on the wire (status line + headers + body).
export function bodyLengthForWire(wireBytes, type = "image/png") {
  let body = wireBytes;
  for (let i = 0; i < 4; i += 1) body = wireBytes - Buffer.byteLength(headerBlock("200 OK", type, body), "latin1");
  assert.equal(Buffer.byteLength(headerBlock("200 OK", type, body), "latin1") + body, wireBytes, "test bug: wire size does not solve");
  return body;
}

// A complete PNG response of exactly `wireBytes` wire bytes.
export const pngWire = (width, height, wireBytes) => respond("200 OK", "image/png", png(width, height, { bodyBytes: bodyLengthForWire(wireBytes) }));
export const pngFile = (width, height) => respond("200 OK", "image/png", png(width, height));

export const redirect = (location, status = "302 Found") => respond(status, null, Buffer.alloc(0), [`Location: ${location}`]);

// A transfer that is still in flight when the capture window closes: the
// headers (with `Content-Length: declared` when given), then `sendBytes` of a
// valid PNG paced in 16 KiB writes, then nothing more. The collector accounts
// for it as a canceled request whose bytes are a lower bound. `extra` adds
// header lines (a pad that keeps two setups' header blocks the same length).
export const stalled = ({ sendBytes, declared = null, width = 100, height = 100, extra = [] }) => (socket) => {
  const bytes = png(width, height, { bodyBytes: Math.max(declared ?? 0, sendBytes + 65_536) });
  socket.write(Buffer.from(headerBlock("200 OK", "image/png", declared, extra), "latin1"));
  let sent = 0;
  const tick = () => {
    if (sent >= sendBytes || socket.destroyed) return;
    const size = Math.min(16_384, sendBytes - sent);
    socket.write(bytes.subarray(sent, sent + size));
    sent += size;
    setTimeout(tick, 2);
  };
  tick();
};

// Response headers with no Content-Length and zero body bytes, then nothing:
// a zero-byte transfer with no measured and no declared length.
export const zeroByteStall = () => (socket) => {
  socket.write(Buffer.from(headerBlock("200 OK", "image/png", null), "latin1"));
};

// The connection is reset before any response.
export const connectionReset = () => (socket) => socket.resetAndDestroy();

const notFound = respond("404 Not Found", "text/plain", "not found");

// One stub origin on 127.0.0.1. Routes match the exact request target
// (path and query). `log` lists every request received; takeLog() returns it
// as sorted "METHOD target" lines and starts a new one.
export async function stubOrigin() {
  const routes = new Map();
  const log = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let head = "";
    socket.on("data", (chunk) => {
      if (socket.handled) return;
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.handled = true;
      const [method, target] = head.slice(0, head.indexOf("\r\n")).split(" ");
      log.push({ method, target });
      (routes.get(target) || notFound)(socket);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    url: (path) => `${origin}${path}`,
    serve(path, handler) {
      routes.set(path, handler);
    },
    log,
    requested: (path) => log.some((entry) => entry.target === path),
    takeLog: () => log.splice(0).map((entry) => `${entry.method} ${entry.target}`).sort(),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// Two origins (the document's and another), closed after the test.
export async function origins(t) {
  const same = await stubOrigin();
  const other = await stubOrigin();
  t.after(async () => {
    await same.close();
    await other.close();
  });
  return { same, other };
}

// ---------------------------------------------------------------------------
// Browser: the loopback-only launcher and the availability gate

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const LOCAL_SCHEMES = new Set(["data:", "blob:", "about:"]);

// True for any URL that reaches a host other than loopback. data:, blob: and
// about: reach no host; an unparsable URL counts as off loopback.
export function offLoopback(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (LOCAL_SCHEMES.has(parsed.protocol)) return false;
  return !LOOPBACK_HOSTS.has(parsed.hostname);
}

// Every request-bearing event Playwright exposes on a page and on a context.
// Each payload names its URL through url() (Request, Response, WebSocket,
// Worker, Download, Page) or request().url().
const PAGE_EVENTS = Object.freeze(["request", "requestfailed", "requestfinished", "response", "websocket", "worker", "download", "popup"]);
const CONTEXT_EVENTS = Object.freeze(["request", "requestfailed", "requestfinished", "response", "serviceworker", "backgroundpage", "page"]);
const eventUrl = (payload) => {
  if (typeof payload?.url === "function") return payload.url();
  if (typeof payload?.request === "function") return payload.request().url();
  return null;
};

// A passive watcher over a Playwright browser: instrument(browser) wraps
// newContext and newPage so every context and page it opens carries a
// listener on each event above. It records; it never routes or alters a
// request. assertLoopbackOnly fails on anything recorded.
export function loopbackGuard() {
  const blocked = [];
  const record = (where) => (payload) => {
    let url;
    try {
      url = eventUrl(payload);
    } catch (error) {
      blocked.push(`${where}: URL unreadable (${error?.message})`);
      return;
    }
    if (url != null && offLoopback(url)) blocked.push(`${where} ${url}`);
  };
  const watchPage = (page) => {
    for (const event of PAGE_EVENTS) page.on(event, record(`page ${event}`));
  };
  const watchContext = (context) => {
    for (const event of CONTEXT_EVENTS) context.on(event, record(`context ${event}`));
    context.on("page", watchPage);
    for (const page of context.pages?.() ?? []) watchPage(page);
  };
  return {
    blocked,
    instrument(browser) {
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (...args) => {
        const context = await newContext(...args);
        watchContext(context);
        return context;
      };
      if (typeof browser.newPage === "function") {
        const newPage = browser.newPage.bind(browser);
        browser.newPage = async (...args) => {
          const page = await newPage(...args);
          watchContext(page.context());
          watchPage(page);
          return page;
        };
      }
      return browser;
    },
    assertLoopbackOnly() {
      assert.deepEqual(blocked, [], "Chromium sent nothing beyond loopback (requests, responses, WebSockets, workers, downloads)");
    },
  };
}

async function chromiumAvailable() {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch (error) {
    if (process.env.CAMPAIGNS_OS_REQUIRE_BROWSER === "1") throw error;
    return false;
  }
}

const available = await chromiumAvailable();
export const browserTest = available ? test : test.skip;
export const browserUnavailableNote = available
  ? null
  : "Playwright Chromium is unavailable; the 1.3 browser rows are skipped (run `npm run qa:install-browser`; the browser lane sets CAMPAIGNS_OS_REQUIRE_BROWSER=1)";

// ---------------------------------------------------------------------------
// The producer: one real Polish page-load capture

// Packet and report shaped like the ones `polish capture` reads, holding only
// the fields capturePolishPageLoad uses. `skipped` adds packet mappings with a
// skip_reason (spec pages with no source mapping).
export function captureInputs({ routes, skipped = [], build = BUILD_FP }) {
  const mapping = (name) => ({ page_id: name, path: `${name}.html`, page_kit: { public_route: route(name), spec_route: `${name}/` } });
  const packet = {
    source_html: {
      pages: [
        ...routes.map(mapping),
        ...skipped.map((name) => ({ page_id: name, skip_reason: "Synthetic spec page with no source mapping.", page_kit: { public_route: route(name), spec_route: `${name}/` } })),
      ],
    },
    campaign: { public_route_slug: SLUG },
  };
  const report = { identity: { public_route_slug: SLUG }, stages: { assembly: { status: "completed", build_fingerprint: build } } };
  return { packet, report };
}

// API assumption (every 1.3 browser row): the producer is
// capturePolishPageLoad (src/polish-node.mjs), which "also returns
// media_weight" (contract 1.3 Code plan): { plan, page_load, media_weight }.
// Returns the capture output plus the packet and report it ran with. The
// loopback guard and the Node-side guard are checked whether or not the
// capture threw; rows assert the record themselves. `probeClock` (F1.3-I13,
// F1.3-I14 and F1.3-I16; see the API assumption at F1.3-I16) is passed to the
// producer in process, and only when a row gives one. `onLaunch`, when given,
// receives the launched browser, so a row's probe clock can reach the page
// under capture.
export async function capture(origin, { routes, skipped = [], build = BUILD_FP, probeClock, onLaunch } = {}) {
  const { capturePolishPageLoad } = await import("./polish-node.mjs");
  const { createPolishBrowserAdapter } = await import("./polish-browser.mjs");
  const guard = loopbackGuard();
  const chromium = {
    async launch(options) {
      const { chromium: real } = await import("playwright");
      const browser = guard.instrument(await real.launch(options));
      onLaunch?.(browser);
      return browser;
    },
  };
  const { packet, report } = captureInputs({ routes, skipped, build });
  let output;
  let failure = null;
  try {
    output = await capturePolishPageLoad({
      packet,
      report,
      baseUrl: `${origin.origin}/`,
      createBrowserAdapter: (options) => createPolishBrowserAdapter({ ...options, chromium }),
      ...(probeClock ? { probeClock } : {}),
    });
  } catch (error) {
    failure = error;
  }
  guard.assertLoopbackOnly();
  assertNoNetworkAttempts();
  if (failure) throw failure;
  return { ...output, packet, report };
}

// The media_weight record the producer returned (fails until 1.3 exists).
export function recordOf(output) {
  const record = output?.media_weight;
  assert.ok(
    record && typeof record === "object" && !Array.isArray(record),
    `capturePolishPageLoad returns a media_weight record beside page_load (got keys ${JSON.stringify(Object.keys(output || {}))})`,
  );
  assert.equal(record.schema_version, MEDIA_WEIGHT_SCHEMA, "media_weight carries its schema_version");
  return record;
}

// The 1.3 results as every reader sees them: readMediaWeight (the 1.0 Polish
// reader site) with the registry's real 1.3 rules, no stand-in.
export async function readResults({ media_weight: record, page_load: pageLoad }, { currentBuild = BUILD_FP } = {}) {
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const rederivers = await loadQcRederivers({ legs: ["polish"] });
  assert.equal(rederivers["media.weight"]?.status, "loaded", `the registry loads the 1.3 rules module (media.weight: ${JSON.stringify(rederivers["media.weight"])})`);
  const { readMediaWeight } = await import("./qc-results.mjs");
  const read = readMediaWeight({ record, pageLoad, currentBuild, rederivers });
  const results = Array.isArray(read) ? read : read?.results;
  assert.ok(Array.isArray(results), "readMediaWeight returns the read 1.3 results");
  return results;
}

// ---------------------------------------------------------------------------
// Request logs

// `GET path` once per captured cell (two viewports per route by default).
export const requests = (paths, cells = VIEWPORTS.length) => paths.flatMap((path) => Array.from({ length: cells }, () => `GET ${path}`)).sort();

// Every stub origin received exactly `expected[name]` since its last check:
// the complete log, compared as a sorted list.
export function assertRequestLog(stubs, expected, label) {
  for (const [name, stub] of Object.entries(stubs)) {
    assert.deepEqual(stub.takeLog(), [...(expected[name] || [])].sort(), `${label}: the ${name} origin received exactly the requests the setup implies, nothing more`);
  }
}

// ---------------------------------------------------------------------------
// Lookups

export function pageLoadCapture(pageLoad, routePath, viewport) {
  const found = (pageLoad?.captures || []).filter((candidate) => candidate?.subject?.requested_route === routePath && candidate?.subject?.viewport === viewport);
  assert.equal(found.length, 1, `page_load holds one capture for ${routePath} ${viewport}`);
  return found[0];
}

export function ledgerEntry(capturePart, url) {
  return (capturePart?.resource_ledger?.entries || []).find((entry) => entry.resource_id === rid(url)) || null;
}

// The capture's ledger lists exactly these URLs.
export function assertLedgerUrls(capturePart, urls, label) {
  assert.deepEqual(
    (capturePart?.resource_ledger?.entries || []).map((entry) => entry.resource_id).sort(),
    urls.map(rid).sort(),
    `setup (${label}): the page_load ledger lists exactly ${JSON.stringify(urls.map(originPath))}`,
  );
}

export function mediaWeightCell(record, routePath, viewport) {
  const found = (record?.cells || []).filter((cell) => cell?.route === routePath && cell?.viewport === viewport);
  assert.equal(found.length, 1, `media_weight holds one cell for ${routePath} ${viewport}`);
  return found[0];
}

export function recordResource(cell, url) {
  const found = (cell?.resources || []).filter((resource) => resource?.resource_id === rid(url));
  assert.equal(found.length, 1, `the media_weight cell lists one resource for ${originPath(url)}`);
  return found[0];
}

export function recordImage(cell, url) {
  const found = (cell?.images || []).filter((image) => image?.resource_id === rid(url));
  assert.equal(found.length, 1, `the media_weight cell lists one probed <img> for ${originPath(url)}`);
  return found[0];
}

export const cellRows = (results, routePath, viewport) => results.filter((row) => row?.subject?.page === routePath && row?.subject?.viewport === viewport);

// The one result with exactly this subject.
export function resultRow(results, check, page, viewport, key) {
  const found = results.filter((row) => row?.check === check && row?.subject?.page === page && row?.subject?.viewport === viewport && row?.subject?.key === key);
  assert.equal(found.length, 1, `one ${check} result for ${page} ${viewport} ${key}`);
  return found[0];
}

// ---------------------------------------------------------------------------
// Subjects and exact result sets
//
// API assumptions (every row; the contract fixes the subject shape, not
// these forms):
// - weight subjects are keyed by the resource's resource_id (its first hop's,
//   contract 1.3 Accepts); resources[] covers every ledger entry of the
//   capture, so the HTML document is a resource too;
// - an unfetched <video> is keyed "video:<element_index>" and an <img> with
//   no ledger entry (an empty or data: currentSrc) "img:<element_path>", both
//   by the pattern of the 1.0 reader's cellSubjects;
// - oversize subjects are keyed "<resource_id>:<element_path>" (contract 1.3
//   Accepts), where an <img> whose currentSrc resolves to no http(s) URL has
//   resource_id null (the existing resolvedResource rule,
//   src/polish-capture.mjs:230-236), so its key starts "null:";
// - element_path is the CSS child path from <body>, every step
//   "tag:nth-of-type(n)" (the factory form "body>img:nth-of-type(1)");
// - a cell with no <img> lists one oversize result keyed "cell" (the
//   silence rule: a pass row for media.oversize on a page with no images;
//   "cell" is the 1.0 reader's key for a check with no subject);
// - a resource no 1.3 weight rule flags (the same-origin HTML document)
//   reads pass: the silence rule allows only a pass or a contract-listed
//   exclusion, and none is listed for documents.

export const THRESHOLD = 500_000;
export const imgPath = (n, parents = "body") => `${parents}>img:nth-of-type(${n})`;
export const oversizeKey = (resourceId, path) => `${resourceId}:${path}`;
export const unledgeredImageKey = (path) => `img:${path}`;
export const NO_IMAGE_KEY = "cell";

// One cell's expected results: weight and oversize lists of
// [key, result, reasonCode]. `capCode` adds the capped-page member
// (contract :154-155) to every result of the cell.
export function cellResults(page, viewport, { weight = [], oversize = [], capCode = null }) {
  const row = (check) => ([key, result, reasonCode = null]) => ({ check, page, viewport, key, result, reason_code: result === "pass" ? null : reasonCode, capCode });
  return [...weight.map(row("media.weight")), ...oversize.map(row("media.oversize"))];
}

// The same cell expectation in both viewports (`spec` may be a function of
// the viewport).
export const bothCells = (page, spec) => VIEWPORTS.flatMap((viewport) => cellResults(page, viewport, typeof spec === "function" ? spec(viewport) : spec));

// The complete members of a result, as a set (order-free); anything but an
// array is kept as is, so it fails the comparison.
const membersOf = (row) => (Array.isArray(row?.members)
  ? [...row.members].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  : row?.members);
const byId = (a, b) => String(a.id).localeCompare(String(b.id));

// The read results are exactly `expected`: the same ids (qcResultId:
// check:page:viewport:key), exact subjects with no other field, the Polish
// leg, each result and reason code, accept-eligibility (a warning is
// eligible unless its page is capped; nothing else is), and the complete
// members of every result: none where the cell is not capped, and exactly
// the page_coverage member where it is. One missing, extra or wrong result
// or member fails the row.
export function assertResultSet(results, expected, label) {
  assert.ok(Array.isArray(results), `${label}: results are an array`);
  const actual = results.map((row) => ({
    id: row?.id,
    leg: row?.leg,
    subject: row?.subject,
    result: row?.result,
    reason_code: row?.reason_code,
    accept_eligible: row?.accept_eligible,
    members: membersOf(row),
  })).sort(byId);
  const wanted = expected.map((row) => ({
    id: `${row.check}:${row.page}:${row.viewport}:${row.key}`,
    leg: "polish",
    subject: { check: row.check, page: row.page, viewport: row.viewport, key: row.key },
    result: row.result,
    reason_code: row.reason_code,
    accept_eligible: row.result === "warning" && !row.capCode,
    members: row.capCode ? [{ key: "page_coverage", result: "unexercised", reason_code: row.capCode }] : [],
  })).sort(byId);
  assert.deepEqual(actual, wanted, `${label}: the 1.3 results are exactly the setup's`);
}

// D2 lower-bound check against the raw capture (before the record exists):
// a canceled transfer whose lower bound is measured (> 0 B) and falls on the
// row's side of 500,000 B.
export function assertLedgerLowerBound(entry, side, label) {
  assert.ok(entry, `setup (${label}): the page_load ledger holds the transfer`);
  assert.equal(entry.canceled_request_count, 1, `setup (${label}): the transfer was cut off (canceled_request_count 1)`);
  assert.ok(entry.transferred_bytes > 0, `setup (${label}): a lower bound was measured (${entry.transferred_bytes} B)`);
  if (side === "over") assert.ok(entry.transferred_bytes > THRESHOLD, `setup (${label}): the lower bound is over 500,000 B (${entry.transferred_bytes})`);
  else assert.ok(entry.transferred_bytes <= THRESHOLD, `setup (${label}): the lower bound is at most 500,000 B (${entry.transferred_bytes})`);
}

// D2 lower-bound check on the record: the resource's bytes equal the
// page_load ledger entry's exactly, its class is lower_bound, and the side
// is the row's.
export function assertRecordLowerBound(resource, entry, side, label) {
  assert.equal(resource.measurement, "lower_bound", `${label}: measurement is lower_bound`);
  assert.equal(resource.transferred_bytes, entry.transferred_bytes, `${label}: the media_weight bytes equal the page_load ledger entry's exactly`);
  assertLedgerLowerBound(entry, side, label);
}
