import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findRunRecordForVerdict,
  publishStoredVerdict,
  qaPublishTextLines,
  QA_PUBLISH_EXIT_CODES,
  QA_PUBLISH_REFUSALS,
  QA_PUBLISH_STATUSES,
  resolveStoredVerdictSource,
} from "./qa-publish.mjs";
import { publishQaVerdict, qaVerdictPublishBlock, QA_VERDICT_PUBLISHERS, skippedQaVerdictPublish } from "./qa-verdict-publish.mjs";
import { RemitResponseError } from "./remit.mjs";
import { specMaterialHash } from "./spec-identity.mjs";
import { createVerdict, STATUS, SEVERITY } from "./qa-verdict.mjs";
import { assembleRunRecord, validateRunRecord, writeRunRecord } from "./run-record.mjs";

const MAP_ID = "map-example";
const SLUG = "example-route";
const RUN_ID = "MTXDEIEVL8AEL8MQR8RTT4GRNF";

function spec(extra = {}) {
  return { schema_version: "4.3", campaign: { ref_id: "ref-1", public_route_slug: SLUG }, pages: [], ...extra };
}

function verdictFor(rawSpec, overrides = {}) {
  return createVerdict({
    runId: RUN_ID,
    mapId: MAP_ID,
    publicRouteSlug: SLUG,
    campaignRefId: "ref-1",
    specVersion: "4.3",
    specHash: specMaterialHash(rawSpec),
    startedAt: "2026-09-15T10:00:00.000Z",
    completedAt: "2026-09-15T10:05:00.000Z",
    runtime: "campaigns-os-node-qa@test",
    baseUrl: "https://shop.example/",
    assertions: [{ id: "route:entry", family: "funnel-flow", page: "entry", status: STATUS.pass, severity: SEVERITY.blocker, expected: "200", actual: "200", evidence: [] }],
    ...overrides,
  });
}

// A campaign folder: packet + spec beside it, full verdict under qa-output/,
// projection sidecar, and a closed Run Record referencing the verdict.
function campaignFixture({ withRecord = true, recordPublish = null, withFullVerdict = true, currentSpec = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-qa-publish-"));
  const rawSpec = spec();
  const packet = {
    schema_version: "campaign-runtime-build-packet/v0",
    spec: { map_id: MAP_ID, local_path: "./campaign-spec.json" },
    campaign: { public_route_slug: SLUG },
    assembly: { target_repo: "." },
  };
  const packetPath = join(dir, "campaign-runtime.build.json");
  writeFileSync(packetPath, JSON.stringify(packet));
  writeFileSync(join(dir, "campaign-spec.json"), JSON.stringify(currentSpec || rawSpec));
  const verdict = verdictFor(rawSpec);
  const fullPath = join(dir, "qa-output", MAP_ID, `${RUN_ID}.json`);
  if (withFullVerdict) {
    mkdirSync(join(dir, "qa-output", MAP_ID), { recursive: true });
    writeFileSync(fullPath, JSON.stringify(verdict));
  }
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  const sidecarPath = join(dir, ".campaign-runtime", "qa-verdict.json");
  writeFileSync(sidecarPath, JSON.stringify({ ...verdict, entry_urls: [], page_urls: [], tested_urls: [], test_orders: [], generated_at: "2026-09-15T10:06:00.000Z" }));
  let recordPath = null;
  if (withRecord) {
    const record = assembleRunRecord({
      runId: "run_1757930000000_abcd1234",
      packageVersion: "1.31.0",
      command: "run-record",
      argvShape: ["--packet"],
      consent: { state: "off", source: "default" },
      remit: { attempted: false, ok: null, error: null, endpoint: null },
      identity: { map_id: MAP_ID, campaign_slug: SLUG, template_family: "fam", entry_point_shape: "packet" },
      artifacts: [
        { kind: "build_packet", path: "./campaign-runtime.build.json", schema_version: "campaign-runtime-build-packet/v0", sha256: null },
        { kind: "qa_verdict", path: `./qa-output/${MAP_ID}/${RUN_ID}.json`, schema_version: "1.0", sha256: null },
      ],
      qaVerdict: verdict,
      qaVerdictPublish: recordPublish,
    });
    recordPath = writeRunRecord(record, { baseDir: dir });
  }
  return { dir, packetPath, verdict, rawSpec, fullPath, sidecarPath, recordPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakePost(outcome = {}) {
  const calls = [];
  const post = async (verdict, proxyBase) => {
    calls.push({ verdict, proxyBase });
    return {
      attempted: true, ok: true, error: null, endpoint: "/api/qa/verdicts", result: "stored", http_status: 201, base_kind: "canonical", response: { ok: true },
      ...outcome,
    };
  };
  return { post, calls };
}

test("qa publish posts the full verdict the sidecar names, stamps the Run Record, and places no order", async () => {
  const fx = campaignFixture();
  try {
    const { post, calls } = fakePost();
    const result = await publishStoredVerdict({ packet: fx.packetPath }, { post, now: () => "2026-09-17T09:00:00.000Z" });
    assert.equal(result.status, QA_PUBLISH_STATUSES.published);
    assert.equal(result.ok, true);
    assert.equal(result.orders_placed, 0);
    assert.equal(result.source_kind, "full_verdict");
    assert.equal(result.verdict_path, fx.fullPath);
    assert.equal(calls.length, 1, "exactly one post");
    assert.equal(calls[0].verdict.run_id, RUN_ID);
    assert.match(calls[0].proxyBase, /^https:\/\//);
    assert.equal(result.publish.result, "stored");
    assert.equal(result.publish.http_status, 201);
    assert.match(result.dashboard_url, new RegExp(`/qa\\?slug=${MAP_ID}&run=${RUN_ID}$`));
    assert.equal(result.run_record.written, true);
    const record = JSON.parse(readFileSync(fx.recordPath, "utf8"));
    assert.equal(validateRunRecord(record).ok, true, "the stamped record still validates");
    assert.deepEqual(record.qa_verdict_publish, {
      verdict_run_id: RUN_ID,
      publisher: "qa publish",
      attempted: true,
      ok: true,
      error: null,
      endpoint: "/api/qa/verdicts",
      state: "ok",
      result: "stored",
      base_kind: "canonical",
      published_at: "2026-09-17T09:00:00.000Z",
    });
    assert.equal(QA_PUBLISH_EXIT_CODES[result.status], 0);
    const lines = qaPublishTextLines(result);
    assert.ok(lines.some((line) => line.startsWith("QA verdict published.")));
    assert.ok(lines.includes("Orders placed: 0 (qa publish never places orders)."));
  } finally {
    fx.cleanup();
  }
});

test("qa publish refuses a verdict whose spec_hash no longer matches the packet's spec, and sends nothing", async () => {
  const fx = campaignFixture({ currentSpec: spec({ pages: [{ id: "p1" }] }) });
  try {
    const { post, calls } = fakePost();
    const result = await publishStoredVerdict({ packet: fx.packetPath }, { post });
    assert.equal(result.status, QA_PUBLISH_STATUSES.refused);
    assert.equal(result.refusal.code, QA_PUBLISH_REFUSALS.spec_hash_mismatch);
    assert.equal(calls.length, 0, "nothing was posted");
    assert.equal(result.verdict_spec_hash, fx.verdict.spec_hash);
    assert.notEqual(result.current_spec_hash, fx.verdict.spec_hash);
    assert.match(result.refusal.detail, /re-run qa run/);
    assert.equal(QA_PUBLISH_EXIT_CODES[result.status], 2);
    const record = JSON.parse(readFileSync(fx.recordPath, "utf8"));
    assert.equal(record.qa_verdict_publish, undefined, "a refusal stamps nothing");
    const lines = qaPublishTextLines(result);
    assert.equal(lines[0], "QA publish refused (spec_hash_mismatch).");
    assert.ok(lines.includes("No order was placed and nothing was sent."));
  } finally {
    fx.cleanup();
  }
});

test("the spec-hash comparison is the shared normalising one: a prefix-less, upper-cased stored hash still matches", async () => {
  const fx = campaignFixture();
  try {
    const spelled = fx.verdict.spec_hash.replace(/^sha256:/, "").toUpperCase();
    writeFileSync(fx.fullPath, JSON.stringify({ ...fx.verdict, spec_hash: spelled }));
    const { post, calls } = fakePost();
    const result = await publishStoredVerdict({ packet: fx.packetPath }, { post });
    assert.equal(result.status, QA_PUBLISH_STATUSES.published);
    assert.equal(calls.length, 1);
  } finally {
    fx.cleanup();
  }
});

test("qa publish refuses a verdict its Run Record already records as published unless --republish", async () => {
  const published = qaVerdictPublishBlock(
    { attempted: true, ok: true, error: null, endpoint: "/api/qa/verdicts", result: "stored", base_kind: "canonical" },
    { verdictRunId: RUN_ID, publisher: QA_VERDICT_PUBLISHERS.run, publishedAt: "2026-09-15T10:05:30.000Z" },
  );
  const fx = campaignFixture({ recordPublish: published });
  try {
    const { post, calls } = fakePost();
    const refused = await publishStoredVerdict({ packet: fx.packetPath }, { post });
    assert.equal(refused.status, QA_PUBLISH_STATUSES.refused);
    assert.equal(refused.refusal.code, QA_PUBLISH_REFUSALS.already_published);
    assert.match(refused.refusal.detail, /qa run, stored at 2026-09-15T10:05:30.000Z/);
    assert.match(refused.refusal.detail, /--republish/);
    assert.ok(refused.dashboard_url, "the existing portal link is still named");
    assert.equal(calls.length, 0);

    const again = await publishStoredVerdict({ packet: fx.packetPath, republish: true }, { post, now: () => "2026-09-17T09:00:00.000Z" });
    assert.equal(again.status, QA_PUBLISH_STATUSES.published);
    assert.equal(again.republished, true);
    assert.equal(calls.length, 1);
    const record = JSON.parse(readFileSync(fx.recordPath, "utf8"));
    assert.equal(record.qa_verdict_publish.publisher, "qa publish");
    assert.equal(record.qa_verdict_publish.published_at, "2026-09-17T09:00:00.000Z");
  } finally {
    fx.cleanup();
  }
});

test("a 409 from the portal is already_stored: an ok publish, recorded as such", async () => {
  const fx = campaignFixture();
  try {
    const { post } = fakePost({ result: "already_stored", http_status: 409, response: null });
    const result = await publishStoredVerdict({ packet: fx.packetPath }, { post });
    assert.equal(result.status, QA_PUBLISH_STATUSES.published);
    assert.equal(result.publish.result, "already_stored");
    const record = JSON.parse(readFileSync(fx.recordPath, "utf8"));
    assert.equal(record.qa_verdict_publish.state, "ok");
    assert.equal(record.qa_verdict_publish.result, "already_stored");
  } finally {
    fx.cleanup();
  }
});

test("a failed post exits 1, stamps failed on a record with no prior publish, and never downgrades a prior ok", async () => {
  const fresh = campaignFixture();
  try {
    const { post } = fakePost({ ok: false, error: "Remit POST 503: Service Unavailable", result: "refused", http_status: 503, response: null });
    const result = await publishStoredVerdict({ packet: fresh.packetPath }, { post });
    assert.equal(result.status, QA_PUBLISH_STATUSES.publish_failed);
    assert.equal(result.ok, false);
    assert.equal(QA_PUBLISH_EXIT_CODES[result.status], 1);
    assert.equal(result.dashboard_url, null);
    const record = JSON.parse(readFileSync(fresh.recordPath, "utf8"));
    assert.equal(record.qa_verdict_publish.state, "failed");
    assert.equal(record.qa_verdict_publish.result, "refused");
    assert.equal(record.qa_verdict_publish.error, "Remit POST 503: Service Unavailable");
    assert.equal(record.qa_verdict_publish.published_at, null);
    assert.ok(qaPublishTextLines(result).some((line) => line.startsWith("Re-run campaigns-os qa publish")));
  } finally {
    fresh.cleanup();
  }

  const published = qaVerdictPublishBlock(
    { attempted: true, ok: true, error: null, endpoint: "/api/qa/verdicts", result: "stored", base_kind: "canonical" },
    { verdictRunId: RUN_ID, publisher: QA_VERDICT_PUBLISHERS.run, publishedAt: "2026-09-15T10:05:30.000Z" },
  );
  const prior = campaignFixture({ recordPublish: published });
  try {
    const { post } = fakePost({ ok: false, error: "fetch failed", result: "transport_error", http_status: null, response: null });
    const result = await publishStoredVerdict({ packet: prior.packetPath, republish: true }, { post });
    assert.equal(result.status, QA_PUBLISH_STATUSES.publish_failed);
    assert.equal(result.run_record.preserved, true);
    assert.equal(result.run_record.written, false);
    const record = JSON.parse(readFileSync(prior.recordPath, "utf8"));
    assert.deepEqual(record.qa_verdict_publish, published, "the stored ok block is left as written");
    assert.ok(qaPublishTextLines(result).some((line) => line.includes("kept as written (a stored publish is never downgraded)")));
  } finally {
    prior.cleanup();
  }
});

test("order flags are refused by name before anything is read or sent", async () => {
  const fx = campaignFixture();
  try {
    const { post, calls } = fakePost();
    const result = await publishStoredVerdict({ packet: fx.packetPath, "test-order": "common", browser: true }, { post });
    assert.equal(result.status, QA_PUBLISH_STATUSES.refused);
    assert.equal(result.refusal.code, QA_PUBLISH_REFUSALS.order_flags_refused);
    assert.match(result.refusal.detail, /--test-order, --browser have no meaning here/);
    assert.equal(calls.length, 0);
  } finally {
    fx.cleanup();
  }
});

test("without a full verdict on disk the sidecar projection is published and named as such", async () => {
  const fx = campaignFixture({ withFullVerdict: false });
  try {
    const { post, calls } = fakePost();
    const result = await publishStoredVerdict({ packet: fx.packetPath }, { post });
    assert.equal(result.status, QA_PUBLISH_STATUSES.published);
    assert.equal(result.source_kind, "sidecar_projection");
    assert.equal(result.verdict_path, fx.sidecarPath);
    assert.equal(calls[0].verdict.run_id, RUN_ID);
    assert.ok(qaPublishTextLines(result).some((line) => line.includes("committed projection")));
  } finally {
    fx.cleanup();
  }
});

test("--verdict names the file explicitly; a missing one and an untrusted one are named refusals", async () => {
  const fx = campaignFixture();
  try {
    const { post, calls } = fakePost();
    const missing = await publishStoredVerdict({ packet: fx.packetPath, verdict: join(fx.dir, "nope.json") }, { post });
    assert.equal(missing.refusal.code, QA_PUBLISH_REFUSALS.verdict_missing);

    const untrustedPath = join(fx.dir, "fetched.json");
    writeFileSync(untrustedPath, JSON.stringify({ ...fx.verdict, trusted: false }));
    const untrusted = await publishStoredVerdict({ packet: fx.packetPath, verdict: untrustedPath }, { post });
    assert.equal(untrusted.refusal.code, QA_PUBLISH_REFUSALS.verdict_untrusted);

    const foreignPath = join(fx.dir, "foreign.json");
    writeFileSync(foreignPath, JSON.stringify({ ...fx.verdict, campaign_slug: "someone-else" }));
    const foreign = await publishStoredVerdict({ packet: fx.packetPath, verdict: foreignPath }, { post });
    assert.equal(foreign.refusal.code, QA_PUBLISH_REFUSALS.campaign_mismatch);

    const explicit = await publishStoredVerdict({ packet: fx.packetPath, verdict: fx.fullPath }, { post });
    assert.equal(explicit.status, QA_PUBLISH_STATUSES.published);
    assert.equal(explicit.source_kind, "explicit");
    assert.equal(calls.length, 1);
  } finally {
    fx.cleanup();
  }
});

test("no stored verdict at all is a refusal that says where one comes from", async () => {
  const fx = campaignFixture({ withFullVerdict: false });
  try {
    rmSync(fx.sidecarPath);
    const result = await publishStoredVerdict({ packet: fx.packetPath }, fakePost());
    assert.equal(result.refusal.code, QA_PUBLISH_REFUSALS.verdict_missing);
    assert.match(result.refusal.detail, /--no-post-verdict/);
    assert.equal(publishStoredVerdict !== null, true);
  } finally {
    fx.cleanup();
  }
});

test("a verdict with no Run Record still publishes; the result says the outcome is unrecorded", async () => {
  const fx = campaignFixture({ withRecord: false });
  try {
    const { post, calls } = fakePost();
    const result = await publishStoredVerdict({ packet: fx.packetPath }, { post });
    assert.equal(result.status, QA_PUBLISH_STATUSES.published);
    assert.equal(result.run_record, null);
    assert.equal(calls.length, 1);
    assert.ok(qaPublishTextLines(result).some((line) => line.startsWith("Run Record: none references this verdict")));
  } finally {
    fx.cleanup();
  }
});

test("findRunRecordForVerdict matches by publish block, by digest, or by the run_id file name — never across campaigns", () => {
  const packet = { spec: { map_id: MAP_ID }, campaign: { public_route_slug: SLUG } };
  const identity = { map_id: MAP_ID, campaign_slug: SLUG };
  const byName = { path: "a", record: { run_id: "run_a", identity, artifacts: [{ kind: "qa_verdict", path: `./qa-output/${MAP_ID}/${RUN_ID}.json`, sha256: null }] } };
  const byDigest = { path: "b", record: { run_id: "run_b", identity, artifacts: [{ kind: "qa_verdict", path: "external:qa_verdict", sha256: "abc" }] } };
  const byBlock = { path: "c", record: { run_id: "run_c", identity, artifacts: [], qa_verdict_publish: { verdict_run_id: RUN_ID, state: "ok" } } };
  const foreign = { path: "d", record: { run_id: "run_d", identity: { map_id: "other", campaign_slug: "other" }, artifacts: [{ kind: "qa_verdict", path: `./qa-output/${MAP_ID}/${RUN_ID}.json`, sha256: "abc" }] } };
  assert.equal(findRunRecordForVerdict({ records: [foreign, byName], packet, verdictRunId: RUN_ID }), byName);
  assert.equal(findRunRecordForVerdict({ records: [foreign, byDigest], packet, verdictRunId: RUN_ID, verdictDigest: "abc" }), byDigest);
  assert.equal(findRunRecordForVerdict({ records: [foreign, byBlock], packet, verdictRunId: RUN_ID }), byBlock);
  assert.equal(findRunRecordForVerdict({ records: [foreign], packet, verdictRunId: RUN_ID, verdictDigest: "abc" }), null);
  assert.equal(findRunRecordForVerdict({ records: [{ path: "e", record: null }], packet, verdictRunId: RUN_ID }), null);
});

test("resolveStoredVerdictSource prefers the run's full verdict and names the projection otherwise", () => {
  const fx = campaignFixture();
  try {
    const packet = JSON.parse(readFileSync(fx.packetPath, "utf8"));
    const full = resolveStoredVerdictSource({ args: {}, packetPath: fx.packetPath, packet });
    assert.equal(full.path, fx.fullPath);
    assert.equal(full.source_kind, "full_verdict");
    rmSync(fx.fullPath);
    const projection = resolveStoredVerdictSource({ args: {}, packetPath: fx.packetPath, packet });
    assert.equal(projection.path, fx.sidecarPath);
    assert.equal(projection.source_kind, "sidecar_projection");
    const explicitSidecar = resolveStoredVerdictSource({ args: { verdict: fx.sidecarPath }, packetPath: fx.packetPath, packet });
    assert.equal(explicitSidecar.source_kind, "sidecar_projection");
  } finally {
    fx.cleanup();
  }
});

test("publishQaVerdict classifies by HTTP status through the shared remit rail and never throws", async () => {
  const verdict = { run_id: RUN_ID };
  const stored = await publishQaVerdict(verdict, "https://portal.example", {
    remitImpl: async (path, payload, base, { onResponse, credential, label }) => {
      assert.equal(path, "/api/qa/verdicts");
      assert.equal(payload, verdict);
      assert.equal(credential, null);
      assert.equal(label, "QA verdict publish");
      onResponse({ status: 201 });
      return { ok: true, id: "v1" };
    },
  });
  assert.deepEqual(stored, { attempted: true, ok: true, error: null, endpoint: "/api/qa/verdicts", result: "stored", http_status: 201, base_kind: "proxy", response: { ok: true, id: "v1" } });

  const conflict = await publishQaVerdict(verdict, "https://portal.example", {
    remitImpl: async (path, payload, base, { onResponse }) => {
      onResponse({ status: 409 });
      throw new RemitResponseError("Remit POST failed: 409 Conflict", { response: { status: 409, statusText: "Conflict" }, body: "{}", reason: "http_error" });
    },
  });
  assert.equal(conflict.ok, true);
  assert.equal(conflict.result, "already_stored");
  assert.equal(conflict.http_status, 409);
  assert.equal(conflict.response, null);

  const down = await publishQaVerdict(verdict, "https://portal.example", {
    remitImpl: async () => {
      throw new Error("fetch failed");
    },
  });
  assert.equal(down.ok, false);
  assert.equal(down.result, "transport_error");
  assert.equal(down.error, "fetch failed");

  const skipped = skippedQaVerdictPublish();
  assert.equal(skipped.attempted, false);
  const block = qaVerdictPublishBlock(skipped, { verdictRunId: RUN_ID, publisher: QA_VERDICT_PUBLISHERS.run, publishedAt: "x" });
  assert.equal(block.state, "skipped");
  assert.equal(block.published_at, null);
  assert.equal(block.result, null);
});
