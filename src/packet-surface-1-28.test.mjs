// Supported surface 1.28.0: the Build Packet drops the two qa booleans no
// command read (test orders run from --test-order <mode> alone), gains
// `local-serve` as a deploy.target for the localhost QA path, and the Run
// Record carries the remit classification and base kind on the record itself.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

import { buildNextActions, doctorPacket, nextStage } from "./cli.mjs";
import { describeRemitBaseKind, stampRemittedCopy } from "./remit.mjs";
import {
  RUN_RECORD_REMIT_BASE_KINDS,
  RUN_RECORD_REMIT_RESULTS,
  assembleRunRecord,
  resolveRunRecordPath,
  validateRunRecord,
} from "./run-record.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const PACKET_SCHEMA = JSON.parse(readFileSync(join(ROOT, "schemas/campaign-runtime-build-packet.v0.schema.json"), "utf8"));
const RUN_RECORD_SCHEMA = JSON.parse(readFileSync(join(ROOT, "schemas/campaigns-os-run-record.v0.schema.json"), "utf8"));

function packetFixture(t, mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-surface-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "surface-target", private: true }));
  const packetPath = join(dir, "campaign-runtime.build.json");
  const packet = JSON.parse(readFileSync(join(ROOT, "examples/build-packet.basic.json"), "utf8"));
  // The example packet carries neither removed field; tests that need one
  // add it back explicitly.
  delete packet.qa.test_orders_allowed;
  delete packet.qa.sandbox_test_card_confirmed;
  mutate(packet);
  writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  return { dir, packetPath, packet };
}

async function runCli(argv, { cwd, telemetry = "off" }) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...argv], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: cwd, CAMPAIGNS_OS_TELEMETRY: telemetry, CAMPAIGNS_OS_LIFECYCLE_LOG: "" },
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: error.code ?? 1, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

const codes = (issues) => issues.map((issue) => issue.code);

test("doctor no longer demands qa.test_orders_allowed / qa.sandbox_test_card_confirmed", (t) => {
  const { packetPath } = packetFixture(t);
  const result = doctorPacket(packetPath, { write: false });
  const flagCodes = codes(result.errors).filter((code) => code.startsWith("qa.test_orders_allowed") || code.startsWith("qa.sandbox_test_card_confirmed"));
  assert.deepEqual(flagCodes, [], JSON.stringify(result.errors));
});

test("doctor warns once, naming the field, when a packet still carries a removed qa flag", (t) => {
  const { packetPath } = packetFixture(t, (packet) => {
    packet.qa.test_orders_allowed = false;
  });
  const result = doctorPacket(packetPath, { write: false });
  const warning = result.warnings.find((issue) => issue.code === "qa.removed_policy_fields");
  assert.ok(warning, JSON.stringify(result.warnings));
  assert.match(warning.message, /qa\.test_orders_allowed is no longer part of the Build Packet/);
  assert.match(warning.message, /1\.28\.0/);
  assert.equal(codes(result.errors).some((code) => code.startsWith("qa.")), false);
});

test("a qa block that is missing, null, or not an object is a structured doctor error, not a crash", (t) => {
  for (const qa of [true, "policy", 1, null, undefined]) {
    const { packetPath } = packetFixture(t, (packet) => {
      if (qa === undefined) delete packet.qa;
      else packet.qa = qa;
    });
    const result = doctorPacket(packetPath, { write: false });
    assert.ok(result.errors.some((issue) => issue.code === "qa" && issue.message === "qa must be an object."), `${JSON.stringify(qa)}: ${JSON.stringify(result.errors)}`);
    assert.equal(codes(result.warnings).includes("qa.removed_policy_fields"), false);
  }
});

test("the packet schema neither requires nor lists the removed qa flags", () => {
  const qa = PACKET_SCHEMA.properties.qa;
  assert.equal(qa.required, undefined);
  assert.equal("test_orders_allowed" in qa.properties, false);
  assert.equal("sandbox_test_card_confirmed" in qa.properties, false);
});

test("qa policy set refuses the removed flags by name instead of ignoring them", async (t) => {
  const { dir, packetPath } = packetFixture(t);
  const before = readFileSync(packetPath, "utf8");
  const run = await runCli(["qa", "policy", "set", "--packet", packetPath, "--test-orders-allowed", "true", "--json"], { cwd: dir });
  assert.notEqual(run.status, 0, run.stdout);
  assert.match(run.stderr, /--test-orders-allowed was removed in supported surface 1\.28\.0/);
  assert.equal(readFileSync(packetPath, "utf8"), before, "a refused command writes nothing");
  const kept = await runCli(["qa", "policy", "set", "--packet", packetPath, "--allowed-domains-confirmed", "true", "--deploy-target", "local-serve", "--json"], { cwd: dir });
  assert.equal(kept.status, 0, kept.stderr);
  const updated = JSON.parse(readFileSync(packetPath, "utf8"));
  assert.equal(updated.campaign.allowed_domains_confirmed, true);
  assert.equal(updated.deploy.target, "local-serve");
  assert.equal("test_orders_allowed" in updated.qa, false);
  assert.equal("qa" in JSON.parse(kept.stdout).policy, false);
});

test("local-serve is a known deploy target and reads a localhost deploy URL as the intended QA state", (t) => {
  const { packetPath } = packetFixture(t, (packet) => {
    packet.deploy.target = "local-serve";
    packet.deploy.preview_url = "http://localhost:4302/runtime-packet-demo/";
    packet.campaign.allowed_domains_confirmed = false;
  });
  const result = doctorPacket(packetPath, { write: false });
  assert.equal(codes(result.errors).includes("deploy.target"), false, JSON.stringify(result.errors));
  assert.equal(codes(result.warnings).includes("campaign.allowed_domains_confirmed"), false);
  assert.ok(result.ready.some((line) => line.startsWith("Deploy target is local-serve and the deploy URL http://localhost:4302/runtime-packet-demo/ is localhost")), JSON.stringify(result.ready));
  assert.ok(PACKET_SCHEMA.properties.deploy.properties.target.enum.includes("local-serve"));
});

test("local-serve with no deploy URL yet says what to record; with a non-localhost URL it warns", (t) => {
  const bare = packetFixture(t, (packet) => {
    packet.deploy.target = "local-serve";
    packet.deploy.preview_url = null;
    packet.deploy.production_url = null;
  });
  const bareResult = doctorPacket(bare.packetPath, { write: false });
  assert.ok(bareResult.ready.some((line) => line.startsWith("Deploy target is local-serve: serve the built _site/ locally")), JSON.stringify(bareResult.ready));
  assert.equal(codes(bareResult.warnings).includes("deploy.local_serve_url"), false);

  const remote = packetFixture(t, (packet) => {
    packet.deploy.target = "local-serve";
    packet.deploy.preview_url = "https://preview.example.com/runtime-packet-demo/";
  });
  const remoteResult = doctorPacket(remote.packetPath, { write: false });
  const warning = remoteResult.warnings.find((issue) => issue.code === "deploy.local_serve_url");
  assert.ok(warning, JSON.stringify(remoteResult.warnings));
  assert.match(warning.message, /is not a localhost or loopback origin/);
});

test("next's deploy action under local-serve says to serve _site/ locally, not to ship it", () => {
  const base = { packetPath: "/campaigns/demo/campaign-runtime.build.json", themeGate: null, polishGate: null, ambient: null };
  const local = buildNextActions({ ...base, result: { stage: "deploy" }, packet: { deploy: { target: "local-serve" } } });
  const deploy = local.find((action) => action.id === "deploy");
  assert.match(deploy.description, /^Serve the built _site\/ output locally as the origin root \(deploy\.target is local-serve\)/);
  const rootServed = buildNextActions({ ...base, result: { stage: "deploy" }, packet: { campaign: { public_route_slug: "demo", route_root: "/" }, deploy: { target: "local-serve" } } });
  assert.match(rootServed.find((action) => action.id === "deploy").description, /^Serve the built _site\/ output locally as the origin root \(deploy\.target is local-serve\) — route_root is "\/": pages are served at site-root paths while assets keep the \/demo\/ prefix, so serve _site\/ with a rewrite of root-level page routes onto \/demo\/<route>/);
  const noSlug = buildNextActions({ ...base, result: { stage: "deploy" }, packet: { campaign: { route_root: "/" }, deploy: { target: "local-serve" } } });
  const noSlugText = noSlug.find((action) => action.id === "deploy").description;
  assert.doesNotMatch(noSlugText, /<public_route_slug>/);
  assert.match(noSlugText, /campaign\.public_route_slug is not recorded; record it before serving/);
  const netlify = buildNextActions({ ...base, result: { stage: "deploy" }, packet: { deploy: { target: "netlify" } } });
  assert.match(netlify.find((action) => action.id === "deploy").description, /^Deploy _site\/ output to netlify/);
});

test("next at the deploy stage under local-serve hands off a serve-locally prompt", (t) => {
  const { packetPath } = packetFixture(t, (packet) => {
    packet.deploy.target = "local-serve";
  });
  const result = nextStage("deploy", { packet: packetPath, "no-write": true });
  assert.equal(result.stage, "deploy");
  assert.match(result.prompt, /^Deploy the built campaign by serving it locally \(deploy\.target is local-serve\)\./);
  assert.match(result.prompt, /Nothing ships anywhere/);
  assert.match(result.prompt, /Directory to serve as the origin root: _site\/ \(the funnel is served under \/runtime-packet-demo\/\)/);
  assert.doesNotMatch(result.prompt, /netlify deploy/);
});

test("a local-serve prompt for a packet without a public route slug asks for the slug instead of printing a placeholder", (t) => {
  const { packetPath } = packetFixture(t, (packet) => {
    packet.deploy.target = "local-serve";
    delete packet.campaign.public_route_slug;
  });
  const result = nextStage("deploy", { packet: packetPath, "no-write": true });
  assert.doesNotMatch(result.prompt, /<public_route_slug>/);
  assert.match(result.prompt, /Directory to serve as the origin root: _site\/ \(campaign\.public_route_slug is not recorded; record it before serving/);
});

test("a loopback deploy URL under local-serve is accepted with a fallback note, not warned about", (t) => {
  for (const url of ["http://127.0.0.1:4302/runtime-packet-demo/", "http://[::1]:4302/runtime-packet-demo/"]) {
    const { packetPath } = packetFixture(t, (packet) => {
      packet.deploy.target = "local-serve";
      packet.deploy.preview_url = url;
    });
    const result = doctorPacket(packetPath, { write: false });
    assert.equal(codes(result.warnings).includes("deploy.local_serve_url"), false, JSON.stringify(result.warnings));
    assert.ok(result.ready.some((line) => line.startsWith(`Deploy target is local-serve and the deploy URL ${url} is a loopback origin`) && line.includes("http://localhost:<port>/")), JSON.stringify(result.ready));
  }
});

test("a root-served campaign under local-serve keeps _site/ as the document root and names the rewrite", (t) => {
  const { packetPath } = packetFixture(t, (packet) => {
    packet.deploy.target = "local-serve";
    packet.campaign.route_root = "/";
    packet.campaign.live_url_path = "/";
  });
  const result = nextStage("deploy", { packet: packetPath, "no-write": true });
  assert.match(result.prompt, /Directory to serve as the origin root: _site\/ — route_root is "\/": pages are served at site-root paths while assets keep the \/runtime-packet-demo\/ prefix, so serve _site\/ with a rewrite of root-level page routes onto \/runtime-packet-demo\/<route>/);
  assert.match(result.prompt, /a plain directory serve of _site\/runtime-packet-demo\/ would 404 every \/runtime-packet-demo\/\.\.\. asset/);
});

test("the Run Record schema and the validator agree on remit_result and remit_base_kind", () => {
  assert.deepEqual(RUN_RECORD_SCHEMA.properties.remit_result.enum, [...RUN_RECORD_REMIT_RESULTS, null]);
  assert.deepEqual(RUN_RECORD_SCHEMA.properties.remit_base_kind.enum, [...RUN_RECORD_REMIT_BASE_KINDS, null]);
  assert.equal(RUN_RECORD_SCHEMA.required.includes("remit_result"), false);
  assert.equal(RUN_RECORD_SCHEMA.required.includes("remit_base_kind"), false);
  const record = assembleRunRecord({ runId: "run_1789300000000_surface", packageVersion: "0.1.0-alpha.0", command: "run-record", argvShape: [], consent: { state: "on", source: "env" }, remit: { attempted: true, ok: true, endpoint: "/api/runs", result: "already_stored", base_kind: "loopback" } });
  assert.equal(record.remit_result, "already_stored");
  assert.equal(record.remit_base_kind, "loopback");
  assert.equal(validateRunRecord(record).ok, true);
  assert.equal(validateRunRecord({ ...record, remit_result: "maybe" }).ok, false);
  assert.equal(validateRunRecord({ ...record, remit_base_kind: "127.0.0.1" }).ok, false);
  assert.equal(validateRunRecord({ ...record, remit_result: null, remit_base_kind: null }).ok, true);
  const absent = assembleRunRecord({ runId: "run_1789300000000_absent", packageVersion: "0.1.0-alpha.0", command: "run-record", argvShape: [], consent: { state: "off", source: "env" }, remit: null });
  assert.equal(absent.remit_result, null);
  assert.equal(absent.remit_base_kind, null);
});

test("the copy sent to the receiver states remit_result stored and the base kind", () => {
  assert.equal(describeRemitBaseKind("https://campaign-map.nextcommerce.com"), "canonical");
  assert.equal(describeRemitBaseKind("http://127.0.0.1:4310"), "loopback");
  assert.equal(describeRemitBaseKind("https://staging.example.com"), "proxy");
  const copy = stampRemittedCopy({ run_id: "run_1", remit_state: "pending" }, "/api/runs", { baseKind: "loopback" });
  assert.equal(copy.remit_result, "stored");
  assert.equal(copy.remit_base_kind, "loopback");
  assert.equal(copy.remit_state, "ok");
});

test("run-record writes remit_result and remit_base_kind onto the record", async (t) => {
  const { dir, packetPath } = packetFixture(t);
  const posts = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      posts.push(JSON.parse(body));
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const skipped = await runCli(["run-record", "--packet", packetPath, "--run-id", "run_1789300000000_skip", "--no-remit", "--json"], { cwd: dir });
  assert.equal(skipped.status, 0, skipped.stderr);
  const skippedRecord = JSON.parse(readFileSync(resolveRunRecordPath("run_1789300000000_skip", dir), "utf8"));
  assert.equal(Object.hasOwn(skippedRecord, "remit_result"), true);
  assert.equal(skippedRecord.remit_result, null);
  assert.equal(skippedRecord.remit_base_kind, null);

  const sent = await runCli(["run-record", "--packet", packetPath, "--run-id", "run_1789300000000_sent", "--proxy-base", base, "--json"], { cwd: dir, telemetry: "on" });
  assert.equal(sent.status, 0, sent.stderr);
  const sentRecord = JSON.parse(readFileSync(resolveRunRecordPath("run_1789300000000_sent", dir), "utf8"));
  assert.equal(sentRecord.remit_state, "ok");
  assert.equal(sentRecord.remit_result, "stored");
  assert.equal(sentRecord.remit_base_kind, "loopback");
  assert.equal(JSON.parse(sent.stdout).record.remit_result, "stored");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].remit_result, "stored");
  assert.equal(posts[0].remit_base_kind, "loopback");
  assert.equal(validateRunRecord(sentRecord).ok, true);
});
