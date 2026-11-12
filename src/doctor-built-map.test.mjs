import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { specFetchCommand } from "./cli.mjs";
import { doctorPacket } from "./doctor/inspect.mjs";
import { RUNTIME_STATE_IGNORE_MARKER, RUNTIME_STATE_REQUIRED_IGNORED_PATHS } from "./runtime-state-ignore.mjs";

const CLI = fileURLToPath(new URL("../bin/campaigns-os.mjs", import.meta.url));
const MAP_ID = "synthetic-map";
const ROUTE = "built-route";

function fixture(t, { mapRoute = "map-route", failure = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "doctor-built-map-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "target");
  const site = join(target, "_site", ROUTE);
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, "index.html"), "<!doctype html><html><head><title>Example</title></head><body><h1>Example</h1></body></html>");
  const spec = { spec_identity: { map_id: MAP_ID, public_route_slug: mapRoute }, campaign: { slug: mapRoute }, funnels: [] };
  const packetPath = join(root, "packets", "minimal.json");
  const cachePath = join(target, ".campaign-runtime", "fetched-specs", `${MAP_ID}.json`);
  const callsPath = join(root, "fetch-calls.jsonl");
  const preload = join(root, "fetch-stub.mjs");
  // Same response shim as spec-fetch-command.test.mjs, installed in the CLI
  // child so its exit code and dispatch are exercised without any network.
  writeFileSync(preload, `
    import { appendFileSync } from "node:fs";
    globalThis.fetch = async (url, options) => {
      appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ url, options }) + "\\n");
      const failure = ${JSON.stringify(failure)};
      if (failure === "network") throw new Error("synthetic network failure");
      if (failure === "http") return { ok: false, status: 503, statusText: "Unavailable" };
      if (failure === "invalid_json") return { ok: true, status: 200, json: async () => { throw new Error("synthetic invalid JSON"); } };
      return { ok: true, status: 200, json: async () => failure === "not_ok"
        ? { ok: false, error: "synthetic refusal" }
        : { ok: true, data: ${JSON.stringify(spec)} } };
    };
  `);
  const run = (flags = ["--emit-packet", packetPath, "--map-id", MAP_ID]) => spawnSync(process.execPath, [
    "--import", preload, CLI, "doctor", "--built", target, "--slug", ROUTE, "--family", "olympus", ...flags, "--json",
  ], {
    cwd: root, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, ".config"), CAMPAIGNS_OS_TELEMETRY: "off", CAMPAIGNS_OS_LIFECYCLE_LOG: "" },
  });
  return { root, target, site, spec, packetPath, cachePath, run, calls: () => existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse) : [] };
}

for (const mapRoute of ["map-route", ROUTE]) {
  test(`doctor --built --emit-packet --map-id fetches and binds a Map on ${mapRoute}`, async (t) => {
    const f = fixture(t, { mapRoute });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const packet = JSON.parse(readFileSync(f.packetPath, "utf8"));
    assert.equal(packet.spec.map_id, MAP_ID);
    assert.equal(resolve(dirname(f.packetPath), packet.spec.local_path || ""), f.cachePath, "packet must name the fetched spec on disk");
    assert.deepEqual(JSON.parse(readFileSync(f.cachePath, "utf8")), f.spec);
    assert.equal(packet._synthesized.from, "built_site");
    assert.equal(packet.campaign.public_route_slug, ROUTE);
    if (mapRoute === ROUTE) assert.equal(Object.hasOwn(packet.campaign, "map_public_route_slug"), false);
    else assert.equal(packet.campaign.map_public_route_slug, mapRoute);
    assert.deepEqual(f.calls(), [{ url: `https://campaign-map.nextcommerce.com/api/spec/${MAP_ID}`, options: { headers: { Accept: "application/json" } } }]);
    const restored = await specFetchCommand({ _: ["spec", "fetch"], packet: f.packetPath }, { fetchImpl: async () => assert.fail("present copy must not fetch") });
    assert.equal(restored.ok, true, JSON.stringify(restored.errors));
    assert.equal(restored.status, "present");
    const inspected = doctorPacket(f.packetPath, { contextPath: null, reportPath: null });
    assert.equal(inspected.errors.some((issue) => issue.code === "campaign.route_slug_identity"), false);
  });
}

test("doctor --built without --map-id preserves the checkpoint's packet bytes", (t) => {
  const f = fixture(t);
  const result = f.run(["--emit-packet", f.packetPath]);
  assert.equal(result.status, 0, result.stderr);
  const checkpointPacket = {
    schema_version: "campaign-runtime-build-packet/v0",
    _synthesized: {
      from: "built_site",
      note: "Minimal packet auto-emitted from a built _site/. Not a full Build Packet: source_html and assembly provenance are absent.",
      site_root: join(f.target, "_site"), campaign_dir: f.site, html_count: 1,
    },
    campaign: { public_route_slug: ROUTE, allowed_domains_confirmed: false },
    spec: { map_id: ROUTE },
    assembly: { target_repo: f.target, output_dir: `_site/${ROUTE}`, template_family: "olympus" },
    deploy: { target: "unknown", preview_url: null },
    qa: {}, pages: [{ page_id: "index", type: "landing", route: "" }],
  };
  assert.equal(readFileSync(f.packetPath, "utf8"), `${JSON.stringify(checkpointPacket, null, 2)}\n`);
  assert.deepEqual(f.calls(), []);
});

for (const [failure, message] of [["network", /network error/], ["http", /503 Unavailable/], ["invalid_json", /invalid JSON/], ["not_ok", /ok=false/]]) {
  test(`doctor --built Map ${failure} failure leaves no packet or cached spec`, (t) => {
    const f = fixture(t, { failure });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(existsSync(f.packetPath), false);
    assert.equal(existsSync(f.cachePath), false);
    assert.equal(existsSync(join(f.target, ".gitignore")), false);
    assert.equal(f.calls().length, 1);
  });
}

test("doctor --built --map-id without --emit-packet remains label-only", (t) => {
  const f = fixture(t, { failure: "network" });
  const result = f.run(["--map-id", MAP_ID]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).synthesized_packet.spec.map_id, MAP_ID);
  assert.deepEqual(f.calls(), []);
  assert.equal(existsSync(f.cachePath), false);
});

test("doctor --built Map fetch honors --proxy-base and the existing managed ignore block", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.target, ".gitignore"), [RUNTIME_STATE_IGNORE_MARKER, ".campaign-runtime/fetched-specs/", ...RUNTIME_STATE_REQUIRED_IGNORED_PATHS, ""].join("\n"));
  const result = f.run(["--emit-packet", f.packetPath, "--map-id", MAP_ID, "--proxy-base", "https://proxy.example.test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls()[0].url, `https://proxy.example.test/api/spec/${MAP_ID}`);
  assert.equal(readFileSync(join(f.target, ".gitignore"), "utf8").includes("fetched-specs/"), false);
});

test("doctor --built --cached-spec emits from the saved copy without fetching or rewriting it", (t) => {
  const f = fixture(t, { failure: "network" });
  mkdirSync(dirname(f.cachePath), { recursive: true });
  const bytes = JSON.stringify(f.spec);
  writeFileSync(f.cachePath, bytes);
  const result = f.run(["--emit-packet", f.packetPath, "--map-id", MAP_ID, "--cached-spec"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(f.packetPath, "utf8")).spec.local_path, f.cachePath);
  assert.equal(readFileSync(f.cachePath, "utf8"), bytes);
  assert.deepEqual(f.calls(), []);
});

for (const link of [".campaign-runtime", ".campaign-runtime/fetched-specs", `.campaign-runtime/fetched-specs/${MAP_ID}.json`]) {
  test(`doctor --built refuses a symlink at ${link} before fetching`, (t) => {
    const f = fixture(t);
    const destination = join(f.root, "outside");
    mkdirSync(destination);
    const linkPath = join(f.target, link);
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(destination, linkPath);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink/);
    assert.deepEqual(f.calls(), []);
    assert.equal(existsSync(f.packetPath), false);
  });
}
