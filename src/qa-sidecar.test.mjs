import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { projectVerdictForSidecar, promoteQaVerdict, sidecarPathForPacket, writeQaSidecar } from "./qa-sidecar.mjs";
import { validateVerdict } from "./qa-verdict.mjs";

const NOW = "2026-08-24T12:00:00.000Z";

// A synthetic full verdict shaped like real qa run output: live URLs, request
// evidence, and order references everywhere the projection must strip them.
function fullVerdict(overrides = {}) {
  return {
    schema_version: "1.0",
    run_id: "MSRTESTRUN0000000000000000",
    campaign_slug: "demo-map-abcd",
    public_route_slug: "demo",
    campaign_ref_id: 42,
    spec_version: "4.3",
    spec_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    started_at: "2026-08-24T11:00:00.000Z",
    completed_at: "2026-08-24T11:05:00.000Z",
    runtime: "campaigns-os-node-qa@0.0.0-test",
    operator: "someuser@local",
    base_url: "http://localhost:8788/demo/",
    entry_urls: [{ page_id: "landing", url: "http://localhost:8788/demo/landing/" }],
    page_urls: ["http://localhost:8788/demo/checkout/"],
    tested_urls: ["http://localhost:8788/demo/checkout/?ref_id=9911"],
    disposition: "blocked",
    assertions: [
      {
        id: "meta:checkout:next-success-url",
        family: "meta-tags",
        page: "checkout",
        url: "http://localhost:8788/demo/checkout/",
        status: "fail",
        severity: "blocker",
        expected: "/demo/receipt/",
        actual: "/receipt",
        evidence: { request_url: "https://api.example.com/v1/orders?key=sk_secret", final_url: "http://localhost:8788/demo/receipt/?order=ORD-77" },
      },
      { id: "route-link:landing:next", family: "funnel-flow", page: "landing", url: "http://localhost:8788/demo/landing/", status: "pass", severity: "warn" },
      { id: "browser-console-errors:landing", family: "browser-runtime", page: "landing", status: "skipped", severity: "warn", blocked_by: "meta:checkout:next-success-url" },
    ],
    test_orders: [{ order_ref: "ORD-77", url: "https://demo.29next.store/orders/ORD-77" }],
    exceptions: [
      { id: "meta:checkout:next-success-url", family: "meta-tags", page: "checkout", url: "http://localhost:8788/demo/checkout/", status: "fail", severity: "blocker", expected: "/demo/receipt/", actual: "/receipt" },
    ],
    ...overrides,
  };
}

function scanScalars(value, path = "$") {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [{ path, value }];
  if (typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => scanScalars(child, `${path}.${key}`));
}

function looksLeaked(value) {
  return /https?:\/\//i.test(value)
    || /ref_id=/i.test(value)
    || /ORD-77/.test(value)
    || /sk_secret/.test(value)
    || /someuser/.test(value)
    || /^\/(?:Users|home)\//.test(value);
}

// Writers refuse a sidecar anchor that is not a real Build Packet, so every
// test that writes needs one at the anchor path.
function seedPacket(packetPath) {
  writeFileSync(packetPath, `${JSON.stringify({ schema_version: "campaign-runtime-build-packet/v0" })}\n`);
}

test("projection passes validateVerdict and preserves disposition and assertion statuses", () => {
  const projected = projectVerdictForSidecar(fullVerdict(), { generatedAt: NOW });
  assert.deepEqual(validateVerdict(projected), []);
  assert.equal(projected.disposition, "blocked");
  assert.equal(projected.run_id, "MSRTESTRUN0000000000000000");
  assert.deepEqual(
    projected.assertions.map((a) => [a.id, a.status, a.severity]),
    [
      ["meta:checkout:next-success-url", "fail", "blocker"],
      ["route-link:landing:next", "pass", "warn"],
      ["browser-console-errors:landing", "skipped", "warn"],
    ],
  );
  assert.equal(projected.assertions[2].blocked_by, "meta:checkout:next-success-url");
  assert.equal(projected.generated_at, NOW);
});

test("no URL, ref, order reference, key, username, or absolute path survives projection at any depth", () => {
  const projected = projectVerdictForSidecar(fullVerdict(), { generatedAt: NOW });
  const leaks = scanScalars(projected).filter(({ value }) => looksLeaked(value));
  assert.deepEqual(leaks, []);
  assert.deepEqual(projected.entry_urls, []);
  assert.deepEqual(projected.page_urls, []);
  assert.deepEqual(projected.tested_urls, []);
  assert.deepEqual(projected.test_orders, []);
  assert.equal(projected.base_url, undefined);
  assert.equal(projected.operator, undefined);
  for (const exception of projected.exceptions) {
    assert.deepEqual(Object.keys(exception).sort(), ["family", "id", "page", "severity", "status"]);
  }
});

test("writeQaSidecar lands beside the packet for ready and blocked dispositions alike", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-sidecar-"));
  try {
    const packetPath = join(dir, "campaign-runtime.build.json");
    seedPacket(packetPath);
    for (const disposition of ["ready", "blocked"]) {
      const result = writeQaSidecar({ verdict: fullVerdict({ disposition }), packetPath, now: () => NOW });
      assert.equal(result.path, sidecarPathForPacket(packetPath));
      const written = JSON.parse(readFileSync(result.path, "utf8"));
      assert.equal(written.disposition, disposition);
      assert.deepEqual(validateVerdict(written), []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid source fails closed and preserves the prior sidecar bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-sidecar-"));
  try {
    const packetPath = join(dir, "campaign-runtime.build.json");
    seedPacket(packetPath);
    writeQaSidecar({ verdict: fullVerdict(), packetPath, now: () => NOW });
    const before = readFileSync(sidecarPathForPacket(packetPath), "utf8");

    assert.throws(() => writeQaSidecar({ verdict: { schema_version: "1.0" }, packetPath, now: () => NOW }), /failed validation/);

    const invalidPath = join(dir, "invalid.json");
    writeFileSync(invalidPath, "{not json");
    assert.throws(() => promoteQaVerdict({ verdictPath: invalidPath, packetPath, now: () => NOW }), /could not read/);
    assert.throws(() => promoteQaVerdict({ verdictPath: join(dir, "missing.json"), packetPath, now: () => NOW }), /could not read/);

    assert.equal(readFileSync(sidecarPathForPacket(packetPath), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("promote projects the exact named source, leaves it byte-identical, and stamps promotion time", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-sidecar-"));
  try {
    const packetPath = join(dir, "campaign-runtime.build.json");
    seedPacket(packetPath);
    const outputDir = join(dir, "qa-output", "demo-map-abcd");
    mkdirSync(outputDir, { recursive: true });
    // Two verdicts on disk: promote must take the named one, never scan.
    const older = join(outputDir, "MSRAAAA.json");
    const named = join(outputDir, "MSRBBBB.json");
    writeFileSync(older, `${JSON.stringify(fullVerdict({ run_id: "MSRAAAA000000000000000000A" }), null, 2)}\n`);
    const namedBytes = `${JSON.stringify(fullVerdict({ run_id: "MSRBBBB000000000000000000B" }), null, 2)}\n`;
    writeFileSync(named, namedBytes);

    const result = promoteQaVerdict({ verdictPath: named, packetPath, now: () => NOW });
    assert.equal(result.run_id, "MSRBBBB000000000000000000B");
    assert.equal(result.disposition, "blocked");
    assert.equal(result.generated_at, NOW);
    assert.equal(readFileSync(named, "utf8"), namedBytes);
    const written = JSON.parse(readFileSync(sidecarPathForPacket(packetPath), "utf8"));
    assert.equal(written.run_id, "MSRBBBB000000000000000000B");
    assert.equal(written.generated_at, NOW);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("promote refuses the destination sidecar as its own source and requires both paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-sidecar-"));
  try {
    const packetPath = join(dir, "campaign-runtime.build.json");
    seedPacket(packetPath);
    writeQaSidecar({ verdict: fullVerdict(), packetPath, now: () => NOW });
    assert.throws(
      () => promoteQaVerdict({ verdictPath: sidecarPathForPacket(packetPath), packetPath, now: () => NOW }),
      /refuses the destination sidecar/,
    );
    assert.throws(() => promoteQaVerdict({ packetPath }), /requires both/);
    assert.throws(() => promoteQaVerdict({ verdictPath: join(dir, "v.json") }), /requires both/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generatedAt must be a Z-suffixed UTC instant, not merely Date.parse-able", () => {
  for (const bad of ["2026-01-01", "Sat Jan 01 2026", "2026-08-24T12:00:00+02:00", "2026-08-24T12:00:00"]) {
    assert.throws(() => projectVerdictForSidecar(fullVerdict(), { generatedAt: bad }), /Z suffix/);
  }
  assert.ok(projectVerdictForSidecar(fullVerdict(), { generatedAt: "2026-08-24T12:00:00Z" }));
});

test("writers refuse a sidecar anchor that is not a real Build Packet", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-sidecar-"));
  try {
    const missing = join(dir, "campaign-runtime.build.json");
    assert.throws(() => writeQaSidecar({ verdict: fullVerdict(), packetPath: missing, now: () => NOW }), /not a readable Build Packet/);
    const notPacket = join(dir, "not-a-packet.json");
    writeFileSync(notPacket, `${JSON.stringify({ schema_version: "something-else/v9" })}\n`);
    assert.throws(() => promoteQaVerdict({ verdictPath: join(dir, "v.json"), packetPath: notPacket, now: () => NOW }), /not a Build Packet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("null identity fields stay absent from the sidecar instead of serializing as null", () => {
  const projected = projectVerdictForSidecar(fullVerdict({ public_route_slug: null, campaign_ref_id: null }), { generatedAt: NOW });
  assert.ok(!("public_route_slug" in projected));
  assert.ok(!("campaign_ref_id" in projected));
  assert.deepEqual(validateVerdict(projected), []);
});
