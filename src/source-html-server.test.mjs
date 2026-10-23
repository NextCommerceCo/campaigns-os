import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { request } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSourceHtmlServer, readRegularFileSync, isRegularFileSync } from "./source-html-server.mjs";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";

const get = (port, path, method = "GET") => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
    const chunks = []; res.on("data", (bytes) => chunks.push(bytes));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
  });
  req.on("connect", (res, socket) => { socket.destroy(); resolve({ status: res.statusCode }); });
  req.on("error", reject); req.end();
});
test("Source server: decode once, contain realpaths, no directories, GET/HEAD only and no writes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "source-server-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "root"); mkdirSync(root);
  writeFileSync(join(root, "page.html"), "<!doctype html><p>Synthetic</p>");
  writeFileSync(join(dir, "secret.html"), "outside");
  symlinkSync(join(dir, "secret.html"), join(root, "escape.html"));
  const server = await startSourceHtmlServer({ root }); t.after(() => server.close());
  for (const path of ["/", "/../secret.html", "/%2e%2e/secret.html", "/escape.html", "/%00", "/%252e%252e/secret.html", "/missing"]) {
    assert.equal((await get(server.port, path)).status, 404, path);
  }
  const page = await get(server.port, "/page.html");
  assert.equal(page.status, 200); assert.equal(page.headers["cache-control"], "no-store"); assert.match(page.headers["content-type"], /text\/html/);
  assert.equal((await get(server.port, "/page.html", "HEAD")).bytes.length, 0);
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) assert.equal((await get(server.port, "/page.html", method)).status, 405);
  assert.equal(readFileSync(join(root, "page.html"), "utf8"), "<!doctype html><p>Synthetic</p>");
});
test("F3C-I12 proxy refusal: CONNECT and absolute-form requests forward zero TCP connections", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "source-proxy-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let connections = 0;
  const receiver = createServer((socket) => { connections++; socket.destroy(); });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => receiver.close(resolve)));
  const server = await startSourceHtmlServer({ root: dir }); t.after(() => server.close());
  const destination = `127.0.0.1:${receiver.address().port}`;
  assert.equal((await get(server.port, `http://${destination}/secret?discard=yes`)).status, 403);
  assert.equal((await get(server.port, destination, "CONNECT")).status, 403);
  assert.equal(connections, 0);
  assert.deepEqual(server.refused(), [{ origin: `http://${destination}`, count: 1 }, { origin: `https://${destination}`, count: 1 }]);
});
test("Declared input reader: FIFO, socket, device and directory are refused before any read; size is bounded", { skip: process.platform === "win32", timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "declared-input-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("mkfifo", [join(dir, "fifo.html")]);
  mkdirSync(join(dir, "directory.html"));
  const socket = createServer(); await new Promise((resolve) => socket.listen(join(dir, "socket.html"), resolve)); t.after(() => socket.close());
  writeFileSync(join(dir, "page.html"), "12345");
  for (const name of ["fifo.html", "directory.html"]) {
    assert.throws(() => readRegularFileSync(join(dir, name)), { code: "not_regular_file" }, name);
    assert.equal(isRegularFileSync(join(dir, name)), false, name);
  }
  assert.throws(() => readRegularFileSync("/dev/null"), { code: "not_regular_file" });
  assert.throws(() => readRegularFileSync(join(dir, "socket.html")));
  assert.equal(isRegularFileSync(join(dir, "socket.html")), false);
  assert.equal(readRegularFileSync(join(dir, "page.html"), { maxBytes: 5 }).toString(), "12345");
  assert.throws(() => readRegularFileSync(join(dir, "page.html"), { maxBytes: 4 }), { code: "too_large" });
  assert.equal(isRegularFileSync(join(dir, "page.html")), true);

  const server = await startSourceHtmlServer({ root: dir, maxBytes: 5 }); t.after(() => server.close());
  writeFileSync(join(dir, "large.html"), "123456");
  for (const path of ["/fifo.html", "/directory.html", "/socket.html", "/large.html"]) {
    assert.equal((await get(server.port, path)).status, 404, path);
    assert.equal((await get(server.port, path, "HEAD")).status, 404, path);
  }
  assert.equal((await get(server.port, "/page.html")).bytes.toString(), "12345");
});
// A worker keeps replacing page.html, alternately with an inside file and a
// link to an outside marker, while the server and the reader open it.
const swapper = (root, stop) => new Worker(`
  const { workerData, parentPort } = require("node:worker_threads");
  const fs = require("node:fs"), path = require("node:path");
  const stop = new Int32Array(workerData.stop), p = path.join(workerData.root, "page.html");
  parentPort.postMessage("ready");
  const end = Date.now() + 15000;
  while (!Atomics.load(stop, 0) && Date.now() < end) {
    fs.writeFileSync(p + ".next", "inside synthetic marker"); fs.renameSync(p + ".next", p);
    fs.symlinkSync("../marker.html", p + ".next"); fs.renameSync(p + ".next", p);
  }
`, { eval: true, workerData: { root, stop } });
const swapping = async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "source-swap-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "source"); mkdirSync(root);
  writeFileSync(join(root, "page.html"), "inside synthetic marker");
  writeFileSync(join(dir, "marker.html"), "outside-root synthetic marker");
  const stop = new SharedArrayBuffer(4), worker = swapper(root, stop);
  const exited = new Promise((done) => worker.once("exit", done));
  const halt = async () => { Atomics.store(new Int32Array(stop), 0, 1); await exited; };
  t.after(halt);
  await new Promise((done, reject) => { worker.once("message", done); worker.once("error", reject); });
  return { root, halt };
};
test("Source server: a path replaced by an outside link between open and check is never served", { skip: process.platform === "win32", timeout: 30_000 }, async (t) => {
  const { root, halt } = await swapping(t);
  const server = await startSourceHtmlServer({ root }); t.after(() => server.close());
  const served = new Set();
  for (let i = 0; i < 400; i++) {
    for (const method of ["GET", "HEAD"]) {
      const response = await get(server.port, "/page.html", method);
      assert.notEqual(response.bytes.toString(), "outside-root synthetic marker", `request ${i + 1}: outside-root bytes served`);
      if (method === "HEAD" && response.status === 200) assert.equal(response.bytes.length, 0);
      served.add(`${method} ${response.status}`);
    }
  }
  await halt();
  assert.ok(served.has("GET 200"), "the inside file is still served between swaps");
});
test("Declared input reader: with a root, a path replaced by an outside link is refused, never read", { skip: process.platform === "win32", timeout: 30_000 }, async (t) => {
  const { root, halt } = await swapping(t);
  let read = 0;
  for (let i = 0; i < 4000; i++) {
    try {
      assert.equal(readRegularFileSync(join(root, "page.html"), { root }).toString(), "inside synthetic marker", `read ${i + 1}`);
      read++;
    } catch (error) { if (error instanceof assert.AssertionError) throw error; }
  }
  await halt();
  assert.ok(read > 0);
  rmSync(join(root, "page.html")); symlinkSync("../marker.html", join(root, "page.html"));
  assert.throws(() => readRegularFileSync(join(root, "page.html"), { root }), { code: "outside_root" });
  assert.equal(isRegularFileSync(join(root, "page.html"), { root }), false);
  assert.equal(readRegularFileSync(join(root, "page.html")).toString(), "outside-root synthetic marker");
  writeFileSync(join(root, "real.html"), "inside"); symlinkSync("real.html", join(root, "alias.html"));
  assert.equal(readRegularFileSync(join(root, "alias.html"), { root }).toString(), "inside");
  assert.throws(() => readRegularFileSync(join(root, "alias.html"), { root, noFollow: true }));
});
