// #583: `doctor --built --base-url` reads only the local built files. The
// output must say the URL was not fetched, so nobody reads a local result as
// a check of the deployed site.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorBuiltOutput } from "./doctor/inspect.mjs";

function builtSite(t) {
  const dir = mkdtempSync(join(tmpdir(), "doctor-built-base-url-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "_site", "demo"), { recursive: true });
  writeFileSync(join(dir, "_site", "demo", "index.html"), "<!doctype html><html><head><title>Demo</title></head><body><p>Demo</p></body></html>");
  return dir;
}

test("doctor --built --base-url says the URL was not fetched and names the served-page check", (t) => {
  const dir = builtSite(t);
  const result = doctorBuiltOutput({ built: dir, family: "olympus", "base-url": "https://preview.example.com/demo/" });
  assert.deepEqual(result.derived.base_url, { value: "https://preview.example.com/demo/", fetched: false, recorded_as: "deploy.preview_url" });
  const line = result.ready.find((entry) => entry.includes("was not fetched"));
  assert.ok(line, `expected a not-fetched line in ${JSON.stringify(result.ready)}`);
  assert.match(line, /--base-url https:\/\/preview\.example\.com\/demo\/ was not fetched/);
  assert.match(line, /qa run --site .* --base-url https:\/\/preview\.example\.com\/demo\/ --family olympus --browser/);
  assert.equal(result.synthesized_packet.deploy.preview_url, "https://preview.example.com/demo/");
});

test("doctor --built without --base-url adds no base-url line", (t) => {
  const dir = builtSite(t);
  const result = doctorBuiltOutput({ built: dir, family: "olympus" });
  assert.equal(result.derived.base_url, undefined);
  assert.equal(result.ready.some((entry) => entry.includes("--base-url")), false);
});
