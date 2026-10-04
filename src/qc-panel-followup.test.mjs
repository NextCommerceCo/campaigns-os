// Regression tests for two QC defect classes:
// - every raw page_load field the media_weight reader reads is required present
//   and well typed: a missing or ill-typed ledger counter, byte count, status
//   list, identity set, origin, media element field or capture summary field
//   never stands in for 0, false, complete or an empty list. The affected cell
//   (or record) reads unexercised / evidence_not_reproducible, and an accept
//   recorded on it lapses;
// - the accept command `next` prints runs as printed for the invocation that
//   produced it: the packet it read, and --report when it read a report other
//   than the packet's default one.
// Every setup is synthetic and uses the shared QC test factory unchanged.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test, { after, afterEach } from "node:test";

import {
  BUILD_FP,
  OPERATOR,
  ORIGIN,
  OTHER_ORIGIN,
  ROUTES,
  assertAccepted,
  assertNoNetworkAttempts,
  campaignFixture,
  delay,
  handoffOf,
  installPolishEvidence,
  mediaWeightFixture,
  polishStandIn,
  readBytes,
  readJson,
  resourceIdOf,
  runAccept,
  runCli,
  runNext,
  twoCellFixture,
  withRecomputedIntegrity,
  writeJson,
} from "./qc-test-factories.mjs";

afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const E = "evidence_not_reproducible";
const POLISH_CHECKS = ["media.oversize", "media.weight"];
const HERO = "/runtime-packet-demo/img/hero.jpg";
const HERO_KEY = resourceIdOf(`${ORIGIN}${HERO}`);
const REDIRECT_FROM = `${OTHER_ORIGIN}/img/hero.jpg`;
const REDIRECT_KEY = resourceIdOf(REDIRECT_FROM);
const CLIP = "/runtime-packet-demo/media/clip.mp4";
const CONTROL = "/runtime-packet-demo/img/control.jpg";
const CONTROL_KEY = resourceIdOf(`${ORIGIN}${CONTROL}`);
const CLIP_KEY = resourceIdOf(`${ORIGIN}${CLIP}`);
const LEDGER_COUNTS = [
  "transferred_bytes",
  "declared_bytes",
  "request_count",
  "declared_request_count",
  "failed_request_count",
  "cache_request_count",
  "unmeasured_request_count",
  "canceled_request_count",
  "partial_request_count",
  "cross_origin_request_count",
];
// A missing field and each ill type a count can take.
const BAD_COUNTS = [["deleted", undefined], ["a string", "0"], ["negative", -1], ["fractional", 0.5], ["null", null], ["a boolean", false]];

const clone = (value) => JSON.parse(JSON.stringify(value));
const setOrDelete = (object, field, value) => {
  if (value === undefined) delete object[field];
  else object[field] = value;
};

// The first cell holds a 600,000 B same-origin image reached through a
// cross-origin redirect (a two-entry chain) and one unfetched <video>; the
// second is an untouched control cell holding a 600,000 B image.
const baseEvidence = () => mediaWeightFixture({
  cells: [
    { route: ROUTES[0], resources: [{ path: HERO, bytes: 600_000, redirectFrom: REDIRECT_FROM }], videos: [{ path: CLIP }] },
    { route: ROUTES[1], resources: [{ path: CONTROL, bytes: 600_000 }] },
  ],
});
const entryOf = (capture, id) => capture.resource_ledger.entries.find((entry) => entry.resource_id === id);
// A second, audio element beside the cell's <video>, as the producer projects
// one: only its tag, index and source references are read.
const audio = (capture) => {
  const url = `${ORIGIN}/runtime-packet-demo/media/theme.mp3`;
  const element = { ...clone(capture.media[0]), tag_name: "audio", element_index: 1, src_attribute: url, source_references: [{ source_kind: "src_attribute", source_index: 0, url, resource_id: resourceIdOf(url), status: "http" }] };
  capture.media.push(element);
  return element;
};

// A capture edited in place with every checksum recomputed: the capture's
// integrity, the cell's binding to it and the media_weight integrity. Only the
// edited field disagrees with the producer.
async function rebind(evidence, edit, { index = 0 } = {}) {
  const { buildPolishCaptureIntegrity } = await import("./polish-capture.mjs");
  const pageLoad = clone(evidence.pageLoad);
  const record = clone(evidence.record);
  edit(pageLoad.captures[index], { pageLoad, record, cell: record.cells[index] });
  for (const [i, capture] of pageLoad.captures.entries()) {
    capture.integrity = buildPolishCaptureIntegrity(capture);
    record.cells[i].page_load_integrity = capture.integrity.projection_fingerprint;
  }
  return { pageLoad, record: withRecomputedIntegrity(record) };
}

async function readMw({ record, pageLoad }) {
  const { readMediaWeight } = await import("./qc-results.mjs");
  return readMediaWeight({ record, pageLoad, currentBuild: BUILD_FP, qcStandIns: { polish: polishStandIn() } });
}

const onPage = (results, route) => results.filter((row) => row.subject?.page === route);
const weightRow = (results, route, key) => results.find((row) => row.check === "media.weight" && row.subject?.page === route && row.subject?.key === key);

// Every result on `route` reads unexercised / evidence_not_reproducible, both
// Polish checks are listed there, and none is accept-eligible.
function assertRouteUnreproduced(results, route, label) {
  const rows = onPage(results, route);
  assert.deepEqual([...new Set(rows.map((row) => row.check))].sort(), POLISH_CHECKS, `${label}: both Polish checks are listed on ${route}: ${JSON.stringify(results.map((row) => [row.subject?.page, row.check, row.result, row.reason_code]))}`);
  for (const row of rows) {
    assert.equal(row.result, "unexercised", `${label}: ${row.id} reads unexercised, never pass or warning`);
    assert.equal(row.reason_code, E, `${label}: ${row.id} reads ${E}`);
    assert.equal(row.accept_eligible, false, `${label}: ${row.id} is not accept-eligible`);
  }
}

function assertControlWarning(results, label) {
  const control = weightRow(results, ROUTES[1], CONTROL_KEY);
  assert.ok(control, `${label}: the control cell is listed`);
  assert.equal(control.result, "warning", `${label}: the untouched control cell keeps its warning`);
}

// The first cell's <video> fetched its 40,000 B same-origin source, as the
// producer projects it: the ledger entry, the element's fetched_resources
// (mediaFetchedResources over the ledger) and the cell's video resource_ids.
// The second cell is the untouched control cell.
async function fetchedVideoEvidence() {
  const { mediaFetchedResources } = await import("./polish-capture.mjs");
  const evidence = mediaWeightFixture({
    cells: [
      { route: ROUTES[0], resources: [{ path: CLIP, type: "media", bytes: 40_000 }], videos: [{ path: CLIP }] },
      { route: ROUTES[1], resources: [{ path: CONTROL, bytes: 600_000 }] },
    ],
  });
  return rebind(evidence, (capture, { cell }) => {
    const [element] = capture.media;
    Object.assign(element, { preload_attribute: "auto", preload_defers_fetch: false });
    element.fetched_resources = mediaFetchedResources(element, capture.resource_ledger.entries);
    cell.videos[0].resource_ids = element.fetched_resources.map((resource) => resource.resource_id);
  });
}

// One accept recorded by `checkpoint accept` on a first-cell warning per
// base capture, shared by the F1 tests.
const accepted = new Map();
async function acceptedOn(name, makeEvidence, id) {
  if (accepted.has(name)) return accepted.get(name);
  const f = campaignFixture();
  after(f.cleanup);
  const evidence = await makeEvidence();
  installPolishEvidence(f, evidence, { buildFingerprint: BUILD_FP });
  const qcStandIns = { polish: polishStandIn() };
  const handoff = handoffOf(await runNext(f, qcStandIns));
  const entry = (handoff.open || []).flatMap((group) => group.results || [group]).find((candidate) => String(candidate.result_ref).startsWith(`${id}@`));
  assert.ok(entry, `setup (${name}): the first cell's warning is open: ${JSON.stringify(handoff.open)}`);
  await delay(5);
  assertAccepted(await runAccept(f, [entry.result_ref], { qcStandIns }));
  const records = readJson(f.reportPath).qc_accepts;
  assert.equal(records.length, 1, `setup (${name}): one accept recorded`);
  const base = { f, evidence, id, records, qcStandIns };
  accepted.set(name, base);
  return base;
}
// The redirected image's warning, and the fetched video's warning.
const acceptedBase = () => acceptedOn("redirected image", baseEvidence, `media.weight:${ROUTES[0]}:desktop:${REDIRECT_KEY}`);
const acceptedVideo = () => acceptedOn("fetched video", fetchedVideoEvidence, `media.weight:${ROUTES[0]}:desktop:${CLIP_KEY}`);

// The edited capture reads the affected scope unreproducible, and the
// recorded accept on the first cell's warning lapses with that reason.
async function assertUnreproducedAndLapsed(edit, label, { scope = "cell", base = acceptedBase } = {}) {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const { evidence, id, records } = await base();
  const results = await readMw(await rebind(evidence, edit));
  assertRouteUnreproduced(results, ROUTES[0], label);
  if (scope === "cell") assertControlWarning(results, label);
  else assertRouteUnreproduced(results, ROUTES[1], label);
  assert.ok(results.some((row) => row.id === id), `${label}: the accepted result is still listed`);
  const [assessment] = assessQcAccepts(records, results, { now: new Date().toISOString() });
  assert.deepEqual([assessment.status, assessment.why], ["lapsed", E], `${label}: the recorded accept lapses (${E})`);
}

// ---------------------------------------------------------------------------
// F1: raw page_load fields never default.

test("F1 setup: the unedited producer-shaped capture re-derives (the image warning, the video and the control cell) and its accept is active", async () => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const { evidence, id, records } = await acceptedBase();
  const results = await readMw(await rebind(evidence, () => {}));
  const hero = weightRow(results, ROUTES[0], REDIRECT_KEY);
  assert.equal(hero?.result, "warning", "the redirected 600,000 B image reads warning");
  assert.equal(hero.id, id);
  assert.equal(weightRow(results, ROUTES[0], "video:0")?.result, "unexercised", "the unfetched <video> is listed");
  assert.equal(weightRow(results, ROUTES[0], "video:0")?.reason_code, "not_loaded");
  assertControlWarning(results, "unedited");
  const [assessment] = assessQcAccepts(records, results, { now: new Date().toISOString() });
  assert.equal(assessment.status, "active", "the recorded accept is active on the unedited capture");
  // A well-formed audio element beside the video changes nothing.
  const withAudio = await readMw(await rebind(evidence, (capture) => audio(capture)));
  assert.equal(weightRow(withAudio, ROUTES[0], REDIRECT_KEY)?.result, "warning", "with a well-formed audio element the image still reads warning");
  assertControlWarning(withAudio, "with audio");
  assert.equal(assessQcAccepts(records, withAudio, { now: new Date().toISOString() })[0].status, "active", "and the accept stays active");
});

test("F1: every ledger counter and byte count, on the final hop and on the redirect hop, deleted or ill typed: the cell reads evidence_not_reproducible and the accept lapses", async () => {
  for (const [hop, hopId] of [["final hop", HERO_KEY], ["redirect hop", REDIRECT_KEY]]) {
    for (const field of LEDGER_COUNTS) {
      for (const [how, value] of BAD_COUNTS) {
        await assertUnreproducedAndLapsed((capture) => setOrDelete(entryOf(capture, hopId), field, value), `${hop} ${field} ${how}`);
      }
    }
  }
});

test("F1: a ledger entry's url, resource_type, statuses and match_resource_ids deleted or ill typed: the cell reads evidence_not_reproducible and the accept lapses", async () => {
  const cases = [
    ["url deleted", (entry) => delete entry.url],
    ["url a number", (entry) => { entry.url = 42; }],
    ["resource_type deleted", (entry) => delete entry.resource_type],
    ["resource_type a number", (entry) => { entry.resource_type = 7; }],
    ["statuses deleted", (entry) => delete entry.statuses],
    ["statuses a string", (entry) => { entry.statuses = "200"; }],
    ["statuses holding a non-integer", (entry) => { entry.statuses = [...entry.statuses, "x"]; }],
    ["match_resource_ids deleted", (entry) => delete entry.match_resource_ids],
    ["match_resource_ids holding a number", (entry) => { entry.match_resource_ids = [...entry.match_resource_ids, 42]; }],
    ["match_resource_ids without the entry's own id", (entry) => { entry.match_resource_ids = entry.match_resource_ids.filter((id) => id !== entry.resource_id); }],
  ];
  for (const [hop, hopId] of [["final hop", HERO_KEY], ["redirect hop", REDIRECT_KEY]]) {
    for (const [how, edit] of cases) {
      await assertUnreproducedAndLapsed((capture) => edit(entryOf(capture, hopId)), `${hop} ${how}`);
    }
  }
});

test("F1: the capture's document origin, measurement status and ledger deleted or ill typed read the cell evidence_not_reproducible; the capture summary's fields read the record so; the accept lapses", async () => {
  const cellCases = [
    ["document_response deleted", (capture) => delete capture.document_response],
    ["final_origin deleted", (capture) => delete capture.document_response.final_origin],
    ["final_origin a number", (capture) => { capture.document_response.final_origin = 42; }],
    // The cell and its video agree with the edited origin, so only the
    // origin's own form is wrong.
    ["final_origin not an http(s) origin, the cell agreeing", (capture, { cell }) => {
      capture.document_response.final_origin = "preview.example.invalid";
      cell.document_origin = "preview.example.invalid";
      cell.videos[0].declared_origin_equal = false;
    }],
    ["measurement_status deleted", (capture) => delete capture.measurement_status],
    ["measurement_status a number", (capture) => { capture.measurement_status = 1; }],
    ["resource_ledger deleted", (capture) => delete capture.resource_ledger],
    ["resource_ledger.entries a string", (capture) => { capture.resource_ledger.entries = "none"; }],
  ];
  for (const [how, edit] of cellCases) await assertUnreproducedAndLapsed(edit, how);

  const summaryCases = [
    ...["expected_capture_count", "captured_count"].flatMap((field) => [
      [`${field} deleted`, (measurement) => delete measurement[field]],
      [`${field} a string`, (measurement) => { measurement[field] = String(measurement[field]); }],
    ]),
    ...["missing", "duplicate", "unexpected", "incomplete"].flatMap((field) => [
      [`${field} deleted`, (measurement) => delete measurement[field]],
      [`${field} a string`, (measurement) => { measurement[field] = ""; }],
    ]),
    ["measurement deleted", (_measurement, pageLoad) => delete pageLoad.measurement],
  ];
  for (const [how, edit] of summaryCases) {
    await assertUnreproducedAndLapsed((_capture, { pageLoad }) => edit(pageLoad.measurement, pageLoad), `capture summary ${how}`, { scope: "record" });
  }
});

test("F1: the capture's media list and every media element field it reads deleted or ill typed: the cell reads evidence_not_reproducible and the accept lapses", async () => {
  const cases = [
    ["media deleted", (capture, { cell }) => { delete capture.media; cell.videos = []; }],
    ["media a string", (capture, { cell }) => { capture.media = "none"; cell.videos = []; }],
    ["a media entry that is not an object", (capture) => { capture.media.push(null); }],
    ["a video's tag_name deleted", (capture) => delete capture.media[0].tag_name],
    ["an audio element's tag_name deleted", (capture) => delete audio(capture).tag_name],
    ["an audio element's tag_name not video or audio", (capture) => { audio(capture).tag_name = "img"; }],
    ["an audio element's element_index deleted", (capture) => delete audio(capture).element_index],
    ["an audio element's element_index a string", (capture) => { audio(capture).element_index = "1"; }],
    ["an audio element's element_index repeating the video's", (capture) => { audio(capture).element_index = 0; }],
    ["a video's source_references deleted", (capture) => delete capture.media[0].source_references],
    ["an audio element's source_references deleted", (capture) => delete audio(capture).source_references],
    ["a video source reference's url deleted", (capture) => delete capture.media[0].source_references[0].url],
    ["an audio source reference's url deleted", (capture) => delete audio(capture).source_references[0].url],
    ["an audio source reference's resource_id deleted", (capture) => delete audio(capture).source_references[0].resource_id],
    ["an audio source reference's resource_id a number", (capture) => { audio(capture).source_references[0].resource_id = 42; }],
    ["an audio source reference that is not an object", (capture) => { audio(capture).source_references.push("x"); }],
  ];
  for (const [how, edit] of cases) await assertUnreproducedAndLapsed(edit, how);
});

test("F1: a command-recorded accept on a Polish warning lapses (evidence_not_reproducible) in next's handoff once cache_request_count is deleted with every checksum rebound", async (t) => {
  const f = campaignFixture();
  t.after(f.cleanup);
  const evidence = twoCellFixture([{ path: HERO, bytes: 600_000 }]);
  installPolishEvidence(f, evidence, { buildFingerprint: BUILD_FP });
  const qcStandIns = { polish: polishStandIn() };
  const id = `media.weight:${ROUTES[0]}:desktop:${HERO_KEY}`;
  const open = (handoffOf(await runNext(f, qcStandIns)).open || []).flatMap((group) => group.results || [group]);
  const entry = open.find((candidate) => String(candidate.result_ref).startsWith(`${id}@`));
  assert.ok(entry, "setup: the image warning is open");
  await delay(5);
  assertAccepted(await runAccept(f, [entry.result_ref], { qcStandIns }));
  const active = handoffOf(await runNext(f, qcStandIns));
  assert.ok((active.accepted || []).some((candidate) => candidate.result_ref === entry.result_ref), "setup: the accept is active");

  installPolishEvidence(f, await rebind(evidence, (capture) => delete entryOf(capture, HERO_KEY).cache_request_count));
  const handoff = handoffOf(await runNext(f, qcStandIns));
  assert.equal((handoff.accepted || []).some((candidate) => candidate.result_id === id || String(candidate.result_ref).startsWith(`${id}@`)), false, "the accept is no longer active");
  assert.ok((handoff.lapsed || []).some((candidate) => candidate.result_id === id && candidate.why === E && candidate.accepted_by === OPERATOR), `the accept is listed lapsed (${E}): ${JSON.stringify(handoff.lapsed)}`);
});

test("F1 setup: the unedited fetched-video capture re-derives (the video's warning and the control cell) and its accept is active", async () => {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const { evidence, id, records } = await acceptedVideo();
  const results = await readMw(await rebind(evidence, () => {}));
  const clip = weightRow(results, ROUTES[0], CLIP_KEY);
  assert.deepEqual([clip?.result, clip?.reason_code], ["warning", "video_from_document_origin"], "the fetched same-origin video reads warning");
  assert.equal(clip.id, id);
  assertControlWarning(results, "unedited fetched video");
  assert.equal(assessQcAccepts(records, results, { now: new Date().toISOString() })[0].status, "active", "the recorded accept is active on the unedited capture");
});

test("F1: the fetched video's ledger request_count (read by mediaFetchedResources) deleted or ill typed: the cell reads evidence_not_reproducible and the accept lapses", async () => {
  for (const [how, value] of [...BAD_COUNTS, ["true", true]]) {
    await assertUnreproducedAndLapsed((capture) => setOrDelete(entryOf(capture, CLIP_KEY), "request_count", value), `fetched video request_count ${how}`, { base: acceptedVideo });
  }
});

test("F1: a media source reference's source_kind or source_index deleted or ill typed: the cell reads evidence_not_reproducible and the accept lapses", async () => {
  const cases = [
    ["source_kind deleted", (reference) => delete reference.source_kind],
    ["source_kind a number", (reference) => { reference.source_kind = 1; }],
    ["source_kind null", (reference) => { reference.source_kind = null; }],
    ["source_kind not a producer kind", (reference) => { reference.source_kind = "srcset"; }],
    ...BAD_COUNTS.map(([how, value]) => [`source_index ${how}`, (reference) => setOrDelete(reference, "source_index", value)]),
  ];
  for (const [how, edit] of cases) {
    await assertUnreproducedAndLapsed((capture) => edit(capture.media[0].source_references[0]), `unfetched video ${how}`);
    await assertUnreproducedAndLapsed((capture) => edit(audio(capture).source_references[0]), `audio element ${how}`);
    await assertUnreproducedAndLapsed((capture) => edit(capture.media[0].source_references[0]), `fetched video ${how}`, { base: acceptedVideo });
  }
});

test("F1: a media element's fetched_resources, or a fetched resource's resource_id or matched_source_resource_ids, deleted or ill typed: the cell reads evidence_not_reproducible and the accept lapses", async () => {
  const listCases = [
    ["fetched_resources deleted", (element) => delete element.fetched_resources],
    ["fetched_resources a string", (element) => { element.fetched_resources = "none"; }],
    ["fetched_resources null", (element) => { element.fetched_resources = null; }],
    ["fetched_resources holding a non-object", (element) => { element.fetched_resources.push("x"); }],
  ];
  for (const [how, edit] of listCases) {
    await assertUnreproducedAndLapsed((capture) => edit(capture.media[0]), `unfetched video ${how}`);
    await assertUnreproducedAndLapsed((capture) => edit(audio(capture)), `audio element ${how}`);
    await assertUnreproducedAndLapsed((capture) => edit(capture.media[0]), `fetched video ${how}`, { base: acceptedVideo });
  }
  const resourceCases = [
    ["resource_id deleted", (resource) => delete resource.resource_id],
    ["resource_id a number", (resource) => { resource.resource_id = 42; }],
    ["resource_id empty", (resource) => { resource.resource_id = ""; }],
    ["matched_source_resource_ids deleted", (resource) => delete resource.matched_source_resource_ids],
    ["matched_source_resource_ids a string", (resource) => { resource.matched_source_resource_ids = CLIP_KEY; }],
    ["matched_source_resource_ids holding a number", (resource) => { resource.matched_source_resource_ids = [...resource.matched_source_resource_ids, 42]; }],
  ];
  for (const [how, edit] of resourceCases) {
    await assertUnreproducedAndLapsed((capture) => edit(capture.media[0].fetched_resources[0]), `fetched video's fetched resource ${how}`, { base: acceptedVideo });
  }
});

// ---------------------------------------------------------------------------
// F2: the printed accept command runs as printed.

// POSIX shell words: bare, '…' (with '\'' escapes) and "…" without escapes.
function shellWords(text) {
  const words = [];
  let index = 0;
  while (index < text.length) {
    while (text[index] === " ") index += 1;
    if (index >= text.length) break;
    let word = "";
    while (index < text.length && text[index] !== " ") {
      const char = text[index];
      if (char === "'" || char === "\"") {
        const end = text.indexOf(char, index + 1);
        assert.notEqual(end, -1, `the command closes its ${char} quote: ${text}`);
        word += text.slice(index + 1, end);
        index = end + 1;
      } else if (char === "\\") {
        word += text[index + 1];
        index += 2;
      } else {
        word += char;
        index += 1;
      }
    }
    words.push(word);
  }
  return words;
}

const REASON = "known synthetic, accepted by the operator";
// The accept command with only the operator's reason and name filled in, as
// argv from the `checkpoint` verb on (the install prefix before it is the
// shell's business).
function filledAcceptArgv(command) {
  const words = shellWords(command);
  const verb = words.indexOf("checkpoint");
  assert.ok(verb > 0 && words[verb + 1] === "accept", `the command is a checkpoint accept with an install prefix: ${command}`);
  const argv = words.slice(verb).map((word) => (word === "<operator's reason>" ? REASON : word === "<operator's name>" ? OPERATOR : word));
  assert.equal(argv.filter((word) => /^<.*>$/.test(word)).length, 0, `only the reason and name are placeholders: ${command}`);
  return argv;
}
const flagValue = (argv, flag) => {
  const values = argv.flatMap((word, index) => (word === flag ? [argv[index + 1]] : []));
  assert.equal(values.length, 1, `${flag} is given once`);
  return values[0];
};

// Every file under the fixture with its bytes.
function fileBytes(dir) {
  const files = new Map();
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (statSync(child).isDirectory()) walk(child);
      else files.set(relative(dir, child), readBytes(child));
    }
  };
  walk(dir);
  return files;
}
const changedFiles = (dir, before) => {
  const now = fileBytes(dir);
  return [...new Set([...before.keys(), ...now.keys()])].filter((path) => !(before.get(path) && now.get(path) && before.get(path).equals(now.get(path)))).sort();
};

// A packet copied beside the fixture's own under a name that needs quoting,
// and a copy of the Assembly Report elsewhere holding the Polish warnings.
// The packet's default report holds none, so an accept run against it
// refuses.
function customWorkspace(t) {
  const f = campaignFixture();
  t.after(f.cleanup);
  const packetPath = join(f.dir, "custom packet (qc's).json");
  copyFileSync(f.packetPath, packetPath);
  const reportPath = join(f.dir, "custom reports", "qc report.json");
  mkdirSync(dirname(reportPath), { recursive: true });
  copyFileSync(f.reportPath, reportPath);
  installPolishEvidence({ reportPath }, twoCellFixture([{ path: HERO, bytes: 600_000 }]), { buildFingerprint: BUILD_FP });
  return { f, packetPath, reportPath, qcStandIns: { polish: polishStandIn() } };
}

async function runPrintedAccept({ f, packetPath, reportPath, qcStandIns }, nextArgv) {
  const next = await runCli([...nextArgv, "--json"], { qcStandIns });
  const handoff = handoffOf(next.json);
  const command = handoff.accept_command;
  assert.ok(typeof command === "string" && command.length > 0, "the handoff prints an accept command");
  assert.equal(command.includes("<packet>"), false, `the command names the packet, not a placeholder: ${command}`);
  const text = await runCli(nextArgv, { qcStandIns });
  assert.ok(text.stdout.split("\n").some((line) => line.trim() === `Accept only with the operator's decision: ${command}`), `the text QC handoff prints the same command: ${text.stdout.slice(-800)}`);

  const argv = filledAcceptArgv(command);
  assert.equal(flagValue(argv, "--packet"), packetPath, "the command names the packet next was given");
  assert.equal(flagValue(argv, "--report"), reportPath, "the command names the report next read");
  const refs = argv.flatMap((word, index) => (word === "--result" ? [argv[index + 1]] : []));
  assert.deepEqual(refs.map((ref) => ref.split("@")[0]).sort(), [`media.weight:${ROUTES[0]}:desktop:${HERO_KEY}`, `media.weight:${ROUTES[1]}:desktop:${resourceIdOf(`${ORIGIN}${CONTROL}`)}`].sort(), "the command lists both open image warnings");

  const before = fileBytes(f.dir);
  await delay(5);
  assertAccepted(await runCli([...argv, "--json"], { qcStandIns }));
  const records = readJson(reportPath).qc_accepts;
  assert.deepEqual(records.map((record) => `${record.result_id}@${record.state_fingerprint.replace(/^sha256:/, "").slice(0, 12)}`).sort(), [...refs].sort(), "every listed ref is recorded in the report next read");
  assert.ok(records.every((record) => record.reason === REASON && record.accepted_by === OPERATOR), "with the operator's reason and name");
  const sidecar = relative(f.dir, f.sidecarPath);
  assert.deepEqual(changedFiles(f.dir, before).filter((path) => path !== sidecar), [relative(f.dir, reportPath)], "no other file changes but the doctor sidecar's stale stamp: the packet's default report and both packets are untouched");
}

test("F2: next with a custom --packet and --report prints an accept_command that, run with a reason and name filled in, records into that report and nothing else", async (t) => {
  const workspace = customWorkspace(t);
  await runPrintedAccept(workspace, ["next", "--packet", workspace.packetPath, "--report", workspace.reportPath]);
});

test("F2: next following the Build Context pointer to a non-default report prints --report naming it, and the printed command records there", async (t) => {
  const workspace = customWorkspace(t);
  writeJson(join(workspace.f.targetRepo, ".campaign-runtime/build-context.json"), { report_path: relative(workspace.f.targetRepo, workspace.reportPath) });
  await runPrintedAccept(workspace, ["next", "--packet", workspace.packetPath]);
});

test("F2: next on the packet's default report prints no --report, and the printed command runs as printed", async (t) => {
  const f = campaignFixture();
  t.after(f.cleanup);
  installPolishEvidence(f, twoCellFixture([{ path: HERO, bytes: 600_000 }]), { buildFingerprint: BUILD_FP });
  const qcStandIns = { polish: polishStandIn() };
  const command = handoffOf(await runNext(f, qcStandIns)).accept_command;
  const argv = filledAcceptArgv(command);
  assert.equal(argv.includes("--report"), false, `no --report for the default report: ${command}`);
  assert.equal(flagValue(argv, "--packet"), f.packetPath);
  await delay(5);
  assertAccepted(await runCli([...argv, "--json"], { qcStandIns }));
  assert.equal(readJson(f.reportPath).qc_accepts.length, 2, "both open warnings are recorded in the default report");
});
