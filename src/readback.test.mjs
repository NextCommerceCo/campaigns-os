/**
 * Regression corpus for `campaigns-os readback`.
 *
 * The 99 cases of the Python readback this command replaces are carried here,
 * case for case, in the source's own order (blocked-verdict projection, passing
 * projection, warning-repeat pair, malformed input, verdict edge cases, stage
 * blocker rendering, staleness, the production-shaped fixture, the JSON
 * projection, the clean flag, the command line, packet selection). The fixture
 * corpus under fixtures/readback/ is a byte copy of that module's fixtures,
 * plus the new mixed-age case.
 *
 * Deliberately adapted or dropped cases, with reasons:
 *
 * 1. `test_excessive_json_nesting_is_unreadable_and_other_artifacts_still_project`
 *    — ADAPTED. The Python case relies on CPython's recursive JSON parser
 *    raising RecursionError at ~2000 levels, which the module reported as
 *    `unreadable` with a "nesting" detail. V8's JSON.parse is iterative and
 *    parses 100k levels without complaint, so that state is unreachable here.
 *    The guarantee the case exists for — one pathological artifact never kills
 *    the projection, and the artifact is still refused — is asserted instead:
 *    the deeply nested doctor output is `unrecognized` (it carries no status or
 *    warnings) and the QA verdict beside it still projects.
 * 2. `test_non_string_blocker_entries_are_shown_as_written_not_fatal` and
 *    `test_giant_non_string_blocker_repr_is_truncated_to_one_bounded_line` —
 *    ADAPTED. The Python fallback rendered `repr(blocker)`, so the expected
 *    literals were Python repr (`{'code': 'odd'}`, `None`). The port renders
 *    the fallback as JSON (`{"code":"odd"}`, `null`); emulating Python repr in
 *    a JavaScript module would be a re-interpretation, not a port. Behaviour —
 *    shown as written, one bounded line, truncation marker past the cap — is
 *    asserted unchanged.
 * 3. `test_the_chosen_packet_is_not_read_a_second_time` — ADAPTED. The Python
 *    case monkeypatched the module's own `load_artifact` binding, which an ESM
 *    module does not expose. The same property is asserted through the public
 *    contract instead: `loadArtifacts` returns the identical preloaded view
 *    object for the packet key (strict identity), which it can only do by not
 *    re-reading the file.
 * 4. `test_projection_carries_no_remediation_commands` — CARRIED, with the
 *    forbidden command spelled for this repository (`campaigns-os next build`
 *    is already the kernel's own spelling, so the assertion is unchanged).
 *
 * No case was dropped outright. Every other Python case is carried, with the
 * rendered header line reading CAMPAIGNS OS rather than CAMPAIGNS AGENT (the
 * command now lives in the kernel) and with the staleness section's wording
 * updated for the per-artifact rule that fixes the defect this port exists to
 * fix. AGENTS.md's first rule binds these tests too: nothing here executes
 * anything from a target the readback reads.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  ARTIFACT_TITLES,
  DEFAULT_RELATIVE_PATHS,
  EXAMPLE_HEAD_DETAIL,
  EXAMPLE_RELATIVE_ROOT,
  JSON_SCHEMA_VERSION,
  MAX_ARTIFACT_BYTES,
  MAX_GIT_METADATA_BYTES,
  ReadbackUsageError,
  assessStaleness,
  buildJsonPayload,
  classifyDoctorWarning,
  computeDivergences,
  computeDoctorSummary,
  computeSkipCascades,
  formatUtc,
  loadArtifact,
  loadArtifacts,
  parseIsoInstant,
  parseIsoTimestamp,
  partitionAssertions,
  projectExample,
  projectReadback,
  projectTarget,
  readHeadMovement,
  readbackRequest,
  resolvePaths,
  resolveProjection,
  runReadbackCommand,
  selectPacketPath,
  serializeStaleness,
} from "./readback.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = join(ROOT, "bin/campaigns-os.mjs");
const FIXTURES = join(ROOT, "fixtures/readback");

// Epochs bracketing the fixture generated_at of 2026-06-23T00:00:00Z, kept at
// the Python corpus's own values so a carried assertion names the same instant.
const EPOCH_BEFORE_ARTIFACTS = 1750000000; // 2025-06-15
const EPOCH_AFTER_ARTIFACTS = 1786000000; // 2026-08-06T07:06:40Z

const BLOCKED_MAPPING = {
  packet: "campaign-runtime.build.json",
  doctor: "doctor-output.json",
  context: "build-context.json",
  report: "assembly-report.json",
  qa_verdict: "qa-verdict.json",
};

const PASSING_MAPPING = {
  doctor: "doctor-output.json",
  report: "assembly-report.json",
  qa_verdict: "qa-verdict.json",
};

function fixturePaths(caseName, mapping) {
  return Object.fromEntries(
    Object.entries(mapping).map(([key, filename]) => [key, join(FIXTURES, caseName, filename)]),
  );
}

function render(caseName, mapping) {
  return projectReadback(loadArtifacts(fixturePaths(caseName, mapping)));
}

function payloadFor(caseName, mapping) {
  return buildJsonPayload(loadArtifacts(fixturePaths(caseName, mapping)));
}

/** A content digest of a whole tree, so "wrote nothing" is checkable. */
function treeDigest(root) {
  const digest = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      digest.update(relative(root, full));
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else digest.update(readFileSync(full));
    }
  };
  walk(root);
  return digest.digest("hex");
}

function tempRoot(t, label = "readback-") {
  const dir = mkdtempSync(join(tmpdir(), label));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function reflogLine(epoch, message = "commit: change") {
  return `${"0".repeat(40)} ${"1".repeat(40)} A Contributor <contributor@example.com> ${epoch} +0000\t${message}\n`;
}

function writeReflog(gitDir, epoch) {
  mkdirSync(join(gitDir, "logs"), { recursive: true });
  writeFileSync(join(gitDir, "logs", "HEAD"), reflogLine(epoch), "utf8");
}

function writeReport(root, { generatedAt = "2026-06-23T00:00:00.000Z", stages = {} } = {}) {
  const sidecars = join(root, ".campaign-runtime");
  mkdirSync(sidecars, { recursive: true });
  const report = { schema_version: "campaign-runtime-assembly-report/v0", status: "completed", stages };
  if (generatedAt !== null) report.generated_at = generatedAt;
  writeFileSync(join(sidecars, "assembly-report.json"), JSON.stringify(report), "utf8");
}

function writeDoctor(root, { errors = [], warnings = [], status = "ready", generatedAt = null } = {}) {
  const sidecars = join(root, ".campaign-runtime");
  mkdirSync(sidecars, { recursive: true });
  const doctor = { status, warnings, errors };
  if (generatedAt !== null) doctor.generated_at = generatedAt;
  writeFileSync(join(sidecars, "doctor-output.json"), JSON.stringify(doctor), "utf8");
}

function writeVerdict(root, assertions, disposition = "blocked") {
  const sidecars = join(root, ".campaign-runtime");
  mkdirSync(sidecars, { recursive: true });
  writeFileSync(
    join(sidecars, "qa-verdict.json"),
    JSON.stringify({ schema_version: "1.0", disposition, assertions }),
    "utf8",
  );
}

function writePacket(dir, name, generatedAt, mapId) {
  const payload = {
    schema_version: "campaign-runtime-build-packet/v0",
    spec: { map_id: mapId },
    campaign: { public_route_slug: mapId },
  };
  if (generatedAt !== null) payload.generated_at = generatedAt;
  writeFileSync(join(dir, name), JSON.stringify(payload), "utf8");
}

/** Build the payload for a target root through the default layout. */
function targetPayload(root) {
  const { views, staleness, packetSelection } = projectTarget(root);
  return buildJsonPayload(views, staleness, packetSelection);
}

function states(payload) {
  return Object.fromEntries(payload.artifacts.map((row) => [row.key, row.state]));
}

function runCli(argv, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...argv], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

// ---------------------------------------------------------------------------
// Blocked-verdict projection (7 cases)
// ---------------------------------------------------------------------------

const blockedOutput = render("blocked-verdict", BLOCKED_MAPPING);

test("cascade provenance names the single blocking failure", () => {
  assert.ok(blockedOutput.includes("assertions: 1 fail, 1 pass, 11 skipped"));
  assert.ok(blockedOutput.includes("polish.evidence_incomplete -> 11 skipped families:"));
  for (const family of [
    "funnel-flow",
    "meta-tags",
    "api-metadata",
    "browser-runtime",
    "template_residue",
    "pricing",
    "browser-test-order",
    "browser-receipt-rendering",
    "analytics-correctness",
    "analytics-parity",
    "parity-capture",
  ]) {
    assert.ok(blockedOutput.includes(`      - ${family}`), family);
  }
});

test("blocked disposition and recorded problems render", () => {
  assert.ok(blockedOutput.includes("disposition: blocked"));
  assert.ok(blockedOutput.includes("stages.polish.evidence.visual_review is missing or incomplete."));
});

test("doctor warnings are labeled contract-static or repo-observed", () => {
  assert.ok(blockedOutput.includes("contract-static (19)"));
  assert.ok(blockedOutput.includes("repo-observed (10)"));
  assert.ok(blockedOutput.includes("labels are the readback's own projection layer"));
});

test("stage statuses render from the assembly report", () => {
  assert.ok(blockedOutput.includes("report status: blocked_at_qa"));
  assert.ok(blockedOutput.includes("prepare_build  completed"));
  assert.ok(blockedOutput.includes("qa             blocked"));
});

test("divergent polish records are both shown without adjudication", () => {
  assert.ok(blockedOutput.includes("cross-artifact divergence"));
  assert.ok(
    blockedOutput.includes("records stage 'polish' as completed, while the QA verdict fails polish.evidence_incomplete"),
  );
  assert.ok(blockedOutput.includes("does not adjudicate"));
});

test("absent findings export is reported, not fatal", () => {
  const views = loadArtifacts({
    ...fixturePaths("blocked-verdict", BLOCKED_MAPPING),
    findings: join(FIXTURES, "blocked-verdict", "findings-export.json"),
  });
  assert.equal(views.findings.state, "absent");
  assert.ok(projectReadback(views).includes("absent"));
});

test("the projection carries no remediation commands", () => {
  // The readback's own layer must not recommend commands; the only
  // command-like text allowed is what Campaigns OS itself recorded, quoted
  // under a "recorded by Campaigns OS" label.
  assert.ok(!blockedOutput.includes("campaigns-os next build"));
  assert.ok(!blockedOutput.includes("required_actions"));
});

test("the projection is deterministic", () => {
  assert.equal(blockedOutput, render("blocked-verdict", BLOCKED_MAPPING));
});

// ---------------------------------------------------------------------------
// Passing projection (3 cases)
// ---------------------------------------------------------------------------

const passingOutput = render("passing", PASSING_MAPPING);

test("a ready disposition renders without a cascade section", () => {
  assert.ok(passingOutput.includes("disposition: ready"));
  assert.ok(passingOutput.includes("assertions: 0 fail, 4 pass, 0 skipped"));
  assert.ok(!passingOutput.includes("skip provenance"));
  assert.ok(!passingOutput.includes("cross-artifact divergence"));
});

test("a zero-warning doctor renders zero counts", () => {
  assert.ok(passingOutput.includes("warnings (0)"));
  assert.ok(!passingOutput.includes("contract-static ("));
});

test("all stages render completed", () => {
  for (const stage of ["prepare_build", "doctor", "setup", "assembly", "polish", "deploy", "qa"]) {
    assert.match(passingOutput, new RegExp(`${stage}\\s+completed`));
  }
});

// ---------------------------------------------------------------------------
// Warning-repeat pair (3 cases): contract-static warnings repeat after a fix
// ---------------------------------------------------------------------------

const warningBefore = projectReadback(
  loadArtifacts({ doctor: join(FIXTURES, "warning-repeat", "doctor-before.json") }),
);
const warningAfter = projectReadback(
  loadArtifacts({ doctor: join(FIXTURES, "warning-repeat", "doctor-after.json") }),
);

test("contract-static warnings repeat verbatim across the fix", () => {
  for (const output of [warningBefore, warningAfter]) {
    assert.ok(output.includes("contract-static (3)"));
    assert.ok(
      output.includes(
        "frontmatter.demoOnlyValues — Replace demo-only starter value before launch: packages.main_package=1",
      ),
    );
  }
});

test("a repo-observed warning clears when the repository changes", () => {
  assert.ok(warningBefore.includes("copy.hardcoded_phone"));
  assert.ok(warningBefore.includes("repo-observed (1)"));
  assert.ok(!warningAfter.includes("copy.hardcoded_phone"));
  assert.ok(!warningAfter.includes("repo-observed ("));
});

test("the static label explains that persistence is not repository state", () => {
  assert.ok(warningAfter.includes("its presence does not track this repository's current state"));
});

// ---------------------------------------------------------------------------
// Malformed input (10 cases)
// ---------------------------------------------------------------------------

test("a deeply nested doctor output is refused and other artifacts still project", (t) => {
  // ADAPTED from the Python RecursionError case: see the header note. V8's
  // JSON parser is iterative, so the nesting parses; the artifact is still
  // refused (no status, no warnings) and the verdict beside it still projects.
  const dir = tempRoot(t);
  const path = join(dir, "doctor.json");
  writeFileSync(path, `{"nested":${"[".repeat(2000)}0${"]".repeat(2000)}}`);
  const views = loadArtifacts({
    doctor: path,
    qa_verdict: join(FIXTURES, "blocked-verdict", "qa-verdict.json"),
  });
  assert.equal(views.doctor.state, "unrecognized");
  assert.ok(views.doctor.detail.includes("status string and a warnings list"));
  assert.ok(projectReadback(views).includes("disposition: blocked"));
});

test("an oversized artifact is unreadable", (t) => {
  const dir = tempRoot(t);
  const path = join(dir, "doctor.json");
  writeFileSync(path, " ".repeat(101));
  const view = loadArtifact("doctor", path, { maxBytes: 100 });
  assert.equal(view.state, "unreadable");
  assert.ok(view.detail.includes("100-byte read limit"), view.detail);
});

test("the artifact and git-metadata read bounds are the contracted sizes", () => {
  assert.equal(MAX_ARTIFACT_BYTES, 32 * 1024 * 1024);
  assert.equal(MAX_GIT_METADATA_BYTES, 64 * 1024);
});

test("a large reflog reads only the tail and preserves the latest entry", (t) => {
  const root = tempRoot(t);
  mkdirSync(join(root, ".git", "logs"), { recursive: true });
  writeFileSync(
    join(root, ".git", "logs", "HEAD"),
    Buffer.concat([
      Buffer.concat(Array.from({ length: 10000 }, () => Buffer.from([...Buffer.from("invalid old bytes "), 0xff, 0x0a]))),
      Buffer.from(reflogLine(EPOCH_AFTER_ARTIFACTS)),
    ]),
  );
  const { time, detail } = readHeadMovement(root);
  assert.equal(time.getTime() / 1000, EPOCH_AFTER_ARTIFACTS);
  assert.equal(detail, "");
});

test("an overlong reflog entry reports unknown age", (t) => {
  const oversized = Buffer.alloc(MAX_GIT_METADATA_BYTES + 1, "x");
  for (const [suffix, diagnostic] of [
    [Buffer.alloc(0), "no newline found"],
    [Buffer.from([10, 32, 9]), "no complete entry remains"],
  ]) {
    const root = tempRoot(t);
    mkdirSync(join(root, ".git", "logs"), { recursive: true });
    writeFileSync(join(root, ".git", "logs", "HEAD"), Buffer.concat([oversized, suffix]));
    const { time, detail } = readHeadMovement(root);
    assert.equal(time, null);
    assert.ok(detail.includes(diagnostic), detail);
  }
});

test("truncated JSON is reported unreadable and the projection continues", () => {
  const views = loadArtifacts({
    doctor: join(FIXTURES, "malformed", "truncated-doctor.json"),
    qa_verdict: join(FIXTURES, "blocked-verdict", "qa-verdict.json"),
  });
  assert.equal(views.doctor.state, "unreadable");
  assert.ok(views.doctor.detail.includes("invalid JSON"));
  const output = projectReadback(views);
  assert.ok(output.includes("unreadable"));
  assert.ok(output.includes("disposition: blocked"));
});

test("a wrong schema_version is reported and not projected", () => {
  const views = loadArtifacts({ packet: join(FIXTURES, "malformed", "wrong-schema-packet.json") });
  assert.equal(views.packet.state, "unrecognized");
  assert.ok(views.packet.detail.includes("campaign-runtime-build-packet/v99"));
  assert.ok(!projectReadback(views).includes("RUN IDENTITY"));
});

test("a non-object top level is reported unrecognized", () => {
  const views = loadArtifacts({ report: join(FIXTURES, "malformed", "not-an-object.json") });
  assert.equal(views.report.state, "unrecognized");
  assert.ok(views.report.detail.includes("not an object"));
});

test("missing files produce an all-absent projection", (t) => {
  const root = tempRoot(t);
  const output = projectReadback(loadArtifacts(resolvePaths(root)));
  assert.ok(output.includes("No run artifacts were found"));
});

test("a doctor output without status or warnings is unrecognized", (t) => {
  const root = tempRoot(t);
  const path = join(root, "doctor-output.json");
  writeFileSync(path, JSON.stringify({ ok: true }));
  assert.equal(loadArtifact("doctor", path).state, "unrecognized");
});

test("non-UTF-8 bytes are reported unreadable, not raised", (t) => {
  const root = tempRoot(t);
  const path = join(root, "doctor-output.json");
  writeFileSync(path, Buffer.from([0xff, 0xfe, 0x20, 0x6e, 0x6f, 0x74, 0x20, 0x75, 0x74, 0x66, 0x38, 0x9c]));
  const view = loadArtifact("doctor", path);
  assert.equal(view.state, "unreadable");
  assert.ok(view.detail.includes("UnicodeDecodeError"), view.detail);
  assert.ok(projectReadback({ doctor: view }).includes("unreadable"));
});

// ---------------------------------------------------------------------------
// Verdict edge cases (3 cases)
// ---------------------------------------------------------------------------

function renderVerdictCase(t, verdict, report = null) {
  const root = tempRoot(t);
  const paths = { qa_verdict: join(root, "qa-verdict.json") };
  writeFileSync(paths.qa_verdict, JSON.stringify(verdict));
  if (report !== null) {
    paths.report = join(root, "assembly-report.json");
    writeFileSync(paths.report, JSON.stringify(report));
  }
  return projectReadback(loadArtifacts(paths));
}

const baseVerdict = (assertions) => ({ schema_version: "1.0", disposition: "blocked", assertions });

test("an unrecognized assertion status is counted and shown", (t) => {
  const output = renderVerdictCase(
    t,
    baseVerdict([
      { id: "a.one", family: "alpha", status: "pass" },
      { id: "b.two", family: "beta", status: "error" },
    ]),
  );
  assert.ok(output.includes("assertions: 0 fail, 1 pass, 0 skipped, 1 unrecognized status"));
  assert.ok(output.includes('unrecognized status "error"  b.two'));
});

test("a pass row without a family falls back to the assertion id", (t) => {
  const output = renderVerdictCase(t, baseVerdict([{ id: "a.one", status: "pass" }]));
  assert.ok(output.includes("pass  a.one  (family a.one)"));
  assert.ok(!output.includes("family None"));
  assert.ok(!output.includes("family null"));
});

test("a divergence note renders once per stage, not per failure", (t) => {
  const report = {
    schema_version: "campaign-runtime-assembly-report/v0",
    status: "blocked_at_qa",
    stages: { polish: { stage: "polish", status: "completed" } },
  };
  const output = renderVerdictCase(
    t,
    baseVerdict([
      { id: "polish.one", family: "polish_gate", status: "fail" },
      { id: "polish.two", family: "polish_gate", status: "fail" },
    ]),
    report,
  );
  assert.equal(output.split("records stage 'polish' as completed").length - 1, 1);
  assert.ok(output.includes("fails polish.one, polish.two"));
});

// ---------------------------------------------------------------------------
// Stage blocker rendering (9 cases)
// ---------------------------------------------------------------------------

function projectStages(blockers) {
  const views = loadArtifacts(fixturePaths("blocked-verdict", { report: "assembly-report.json" }));
  views.report.data.stages = { qa: { status: "blocked", blockers } };
  return projectReadback(views);
}

test("recorded blockers render under their stage", () => {
  const output = projectReadback(loadArtifacts(fixturePaths("blocked-verdict", BLOCKED_MAPPING)));
  assert.ok(output.includes("blocker: polish.evidence_incomplete: None"));
  assert.ok(
    output.includes("blocker: fixture API key fixture-campaigns-key has no live campaign in Campaigns App"),
  );
});

test("blockers beyond the cap collapse to a count", () => {
  const blockers = Array.from({ length: 12 }, (_unused, index) => `blocker-${String(index).padStart(2, "0")}`);
  const output = projectStages(blockers);
  assert.ok(output.includes("blocker: blocker-09"));
  assert.ok(!output.includes("blocker: blocker-10"));
  assert.ok(output.includes("... and 2 more blocker(s) recorded in the assembly report"));
});

test("non-string blocker entries are shown as written, not fatal", () => {
  // ADAPTED: the fallback renders JSON, not Python repr. See the header note.
  const output = projectStages([{ code: "odd" }, null]);
  assert.ok(output.includes('blocker: (non-string entry, shown as written) {"code":"odd"}'));
  assert.ok(output.includes("blocker: (non-string entry, shown as written) null"));
});

test("an object blocker renders its full message, code and identifiers", () => {
  const output = projectStages([
    {
      code: "MISSING_SOURCE_PAGE",
      message: "No matching source page was found",
      stage: "prepare_build",
      page_id: "page_fixture_01",
      detail: "unused when message is usable",
    },
  ]);
  assert.ok(
    output.includes(
      "blocker: [MISSING_SOURCE_PAGE] No matching source page was found (stage=prepare_build, page_id=page_fixture_01)",
    ),
  );
  assert.ok(!output.includes("non-string entry"));
  assert.ok(!output.includes("... (truncated)"));
  assert.ok(!output.includes("unused when message is usable"));
});

test("an object blocker's long message is never truncated", () => {
  const message = "a fixture explanation that keeps going ".repeat(8);
  const output = projectStages([{ message }]);
  const blockerLines = output.split("\n").filter((line) => line.includes("blocker:"));
  assert.equal(blockerLines.length, 1);
  assert.ok(blockerLines[0].includes(message.trim()));
  assert.ok(!output.includes("... (truncated)"));
});

test("an object blocker without a message uses detail", () => {
  const output = projectStages([
    { code: "ASSET_SWEEP_INCOMPLETE", detail: "Two fixture assets were not copied", page_id: "page_fixture_02" },
  ]);
  assert.ok(
    output.includes("blocker: [ASSET_SWEEP_INCOMPLETE] Two fixture assets were not copied (page_id=page_fixture_02)"),
  );
});

test("an object blocker's missing identifiers render no empty fields", () => {
  const output = projectStages([{ message: "fixture message only", code: "", stage: "  " }]);
  assert.ok(`${output}\n`.includes("blocker: fixture message only\n"));
  assert.ok(!output.includes("[]"));
  assert.ok(!output.includes("()"));
  assert.ok(!output.includes("stage="));
});

test("CRLF in an object blocker's message collapses to one line", () => {
  const output = projectStages([
    { code: "MULTILINE", message: "first fixture line\r\nsecond fixture line\n", stage: "assembly" },
  ]);
  assert.ok(output.includes("blocker: [MULTILINE] first fixture line second fixture line (stage=assembly)"));
});

test("a giant non-string blocker is truncated to one bounded line", () => {
  // ADAPTED: JSON rendering, not Python repr. See the header note.
  const output = projectStages([{ payload: Array.from({ length: 50 }, () => "x".repeat(40)) }]);
  const blockerLines = output.split("\n").filter((line) => line.includes("blocker:"));
  assert.equal(blockerLines.length, 1);
  assert.ok(blockerLines[0].length < 200);
  assert.ok(blockerLines[0].includes("... (truncated)"));
});

// ---------------------------------------------------------------------------
// Staleness projection (16 cases)
// ---------------------------------------------------------------------------

function assessReport(root) {
  const views = loadArtifacts({ report: join(root, ".campaign-runtime", "assembly-report.json") });
  return { staleness: assessStaleness(root, views), views };
}

test("HEAD movement after the newest artifact is stale", (t) => {
  const root = tempRoot(t);
  writeReport(root);
  writeReflog(join(root, ".git"), EPOCH_AFTER_ARTIFACTS);
  const { staleness, views } = assessReport(root);
  const output = projectReadback(views, staleness);
  assert.equal(staleness.stale, true);
  assert.ok(output.includes("*** STALE ARTIFACTS ***"));
  assert.ok(output.includes("HEAD last moved 2026-08-06"));
  assert.ok(output.replace(/\n {2}/g, " ").includes("a new run must regenerate"));
});

test("artifacts at or after the HEAD movement are not stale", (t) => {
  const root = tempRoot(t);
  writeReport(root);
  writeReflog(join(root, ".git"), EPOCH_BEFORE_ARTIFACTS);
  const { staleness, views } = assessReport(root);
  const output = projectReadback(views, staleness);
  assert.equal(staleness.stale, false);
  assert.ok(!output.includes("STALE ARTIFACTS"));
  assert.ok(output.includes("none of those is older than the last recorded HEAD movement"));
});

test("a sub-second artifact time leaves the whole-second HEAD comparison unchanged", (t) => {
  // The reflog records whole seconds, so the added artifact-side precision
  // cannot move this verdict either way: an artifact a microsecond INTO the
  // second HEAD moved in is still not older than that movement, and the next
  // second is still after it. Both answers are what millisecond truncation
  // gave, which is the point of asserting them.
  const sameSecond = tempRoot(t);
  writeReport(sameSecond, { generatedAt: "2026-08-06T07:06:40.000001Z" });
  writeReflog(join(sameSecond, ".git"), EPOCH_AFTER_ARTIFACTS); // 2026-08-06T07:06:40Z
  const level = assessReport(sameSecond).staleness;
  assert.equal(level.computable, true);
  assert.equal(level.stale, false);
  assert.equal(formatUtc(level.artifacts.report.generated_at), "2026-08-06T07:06:40Z");

  const nextSecond = tempRoot(t);
  writeReport(nextSecond, { generatedAt: "2026-08-06T07:06:40.000001Z" });
  writeReflog(join(nextSecond, ".git"), EPOCH_AFTER_ARTIFACTS + 1);
  assert.equal(assessReport(nextSecond).staleness.stale, true);
});

test("a missing Git checkout reports not computable", (t) => {
  const root = tempRoot(t);
  writeReport(root);
  const { staleness, views } = assessReport(root);
  const output = projectReadback(views, staleness);
  assert.equal(staleness.computable, false);
  assert.ok(output.includes("not computable"));
  assert.ok(output.includes("not a Git checkout"));
  assert.ok(output.includes("Treat artifact age as unknown"));
});

test("a nested target finds ancestor git and computes stale", (t) => {
  const repo = tempRoot(t);
  const target = join(repo, "funnels", "example");
  mkdirSync(target, { recursive: true });
  writeReport(target);
  writeReflog(join(repo, ".git"), EPOCH_AFTER_ARTIFACTS);
  const { staleness } = assessReport(target);
  assert.equal(staleness.computable, true);
  assert.equal(staleness.stale, true);
});

test("a nested target finds ancestor git and computes not stale", (t) => {
  const repo = tempRoot(t);
  const target = join(repo, "funnels", "example");
  mkdirSync(target, { recursive: true });
  writeReport(target);
  writeReflog(join(repo, ".git"), EPOCH_BEFORE_ARTIFACTS);
  const { staleness } = assessReport(target);
  assert.equal(staleness.computable, true);
  assert.equal(staleness.stale, false);
});

test("a nested target under a worktree pointer root resolves the reflog", (t) => {
  const enclosing = tempRoot(t);
  const target = join(enclosing, "funnels", "example");
  mkdirSync(target, { recursive: true });
  writeReport(target);
  const gitDir = join(enclosing, "elsewhere", "worktrees", "stream");
  writeReflog(gitDir, EPOCH_AFTER_ARTIFACTS);
  writeFileSync(join(enclosing, ".git"), `gitdir: ${gitDir}\n`, "utf8");
  const { staleness } = assessReport(target);
  assert.equal(staleness.computable, true);
  assert.equal(staleness.stale, true);
});

test("a nested target under a relative gitdir pointer resolves the reflog", (t) => {
  // A relative `gitdir:` resolves against the .git-bearing ancestor, not
  // against the nested target. Were the base the target, this pointer would
  // resolve under funnels/example/ and the signal would go dark.
  const enclosing = tempRoot(t);
  const target = join(enclosing, "funnels", "example");
  mkdirSync(target, { recursive: true });
  writeReport(target);
  writeReflog(join(enclosing, "sibling", "worktrees", "stream"), EPOCH_AFTER_ARTIFACTS);
  writeFileSync(join(enclosing, ".git"), "gitdir: sibling/worktrees/stream\n", "utf8");
  const { staleness } = assessReport(target);
  assert.equal(staleness.computable, true);
  assert.equal(staleness.stale, true);
});

test("a worktree gitdir pointer resolves to its own reflog", (t) => {
  const root = tempRoot(t);
  writeReport(root);
  const gitDir = join(root, "elsewhere", "worktrees", "stream");
  writeReflog(gitDir, EPOCH_AFTER_ARTIFACTS);
  writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`, "utf8");
  const { staleness } = assessReport(root);
  assert.equal(staleness.computable, true);
  assert.equal(staleness.stale, true);
});

test("a .git file with no gitdir pointer reports not computable", (t) => {
  const root = tempRoot(t);
  writeReport(root);
  writeFileSync(join(root, ".git"), "this file carries no pointer\n", "utf8");
  const { staleness } = assessReport(root);
  assert.equal(staleness.computable, false);
  assert.ok(staleness.head_detail.includes("no gitdir pointer"), staleness.head_detail);
});

test("a checkout with no HEAD reflog reports not computable", (t) => {
  const root = tempRoot(t);
  writeReport(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  const { staleness } = assessReport(root);
  assert.equal(staleness.computable, false);
  assert.ok(staleness.head_detail.includes("no HEAD reflog"), staleness.head_detail);
});

test("an unparseable reflog reports not computable", (t) => {
  const root = tempRoot(t);
  writeReport(root);
  mkdirSync(join(root, ".git", "logs"), { recursive: true });
  writeFileSync(join(root, ".git", "logs", "HEAD"), "not a reflog\n", "utf8");
  const { staleness } = assessReport(root);
  assert.equal(staleness.computable, false);
  assert.ok(staleness.head_detail.includes("carries no epoch timestamp"), staleness.head_detail);
});

test("a short reflog entry reports not computable", (t) => {
  const root = tempRoot(t);
  writeReport(root);
  mkdirSync(join(root, ".git", "logs"), { recursive: true });
  writeFileSync(join(root, ".git", "logs", "HEAD"), "garbage\n", "utf8");
  const { staleness } = assessReport(root);
  assert.equal(staleness.computable, false);
  assert.ok(staleness.head_detail.includes("not in reflog format"), staleness.head_detail);
});

test("an artifact without generated_at reports not computable", (t) => {
  const root = tempRoot(t);
  writeReport(root, { generatedAt: null });
  writeReflog(join(root, ".git"), EPOCH_AFTER_ARTIFACTS);
  const { staleness, views } = assessReport(root);
  const output = projectReadback(views, staleness);
  assert.equal(staleness.computable, false);
  assert.ok(output.includes("no loaded artifact carries a parseable generated_at"));
});

test("a projection without a staleness argument has no staleness section", () => {
  const output = projectReadback(loadArtifacts(fixturePaths("blocked-verdict", BLOCKED_MAPPING)));
  assert.ok(!output.includes("STALENESS"));
});

test("an out-of-range reflog epoch reports not computable", (t) => {
  const root = tempRoot(t);
  writeReport(root);
  mkdirSync(join(root, ".git", "logs"), { recursive: true });
  writeFileSync(join(root, ".git", "logs", "HEAD"), reflogLine("10000000000000000000"), "utf8");
  const { staleness } = assessReport(root);
  assert.equal(staleness.computable, false);
  assert.ok(staleness.head_detail.includes("out of range"), staleness.head_detail);
});

test("the staleness projection is deterministic", (t) => {
  const root = tempRoot(t);
  writeReport(root);
  writeReflog(join(root, ".git"), EPOCH_AFTER_ARTIFACTS);
  const { staleness, views } = assessReport(root);
  assert.equal(projectReadback(views, staleness), projectReadback(views, assessStaleness(root, views)));
});

test("loaded artifact rows show their generated_at", () => {
  const output = projectReadback(loadArtifacts(fixturePaths("blocked-verdict", { report: "assembly-report.json" })));
  assert.ok(output.includes("loaded — generated_at 2026-08-02T05:05:07.961Z"));
});

// ---------------------------------------------------------------------------
// Production-shaped fixture (4 cases)
//
// The fixture under fixtures/readback/production-shaped/ is fully synthetic —
// every name, ID, URL, hash, message, and timestamp is invented — but preserves
// the structural characteristics real campaign checkouts exposed and the
// lab-shaped fixtures missed: a campaign target nested below an enclosing
// repository root, and an assembly report whose blockers are objects
// (code/message/stage/page_id/detail), not strings. The enclosing repository
// shape and Git metadata are created per test; no .git content is a fixture.
// ---------------------------------------------------------------------------

function layoutNestedFixture(t, caseName, names, epoch) {
  const enclosing = tempRoot(t);
  const target = join(enclosing, "funnels", "example");
  const sidecars = join(target, ".campaign-runtime");
  mkdirSync(sidecars, { recursive: true });
  const source = join(FIXTURES, caseName);
  if (names.includes("campaign-runtime.build.json")) {
    copyFileSync(join(source, "campaign-runtime.build.json"), join(target, "campaign-runtime.build.json"));
  }
  for (const name of names.filter((entry) => entry !== "campaign-runtime.build.json")) {
    copyFileSync(join(source, name), join(sidecars, name));
  }
  if (epoch !== null) writeReflog(join(enclosing, ".git"), epoch);
  return target;
}

const PRODUCTION_SHAPED_FILES = [
  "campaign-runtime.build.json",
  "doctor-output.json",
  "build-context.json",
  "assembly-report.json",
];

function projectNested(t, epoch) {
  const target = layoutNestedFixture(t, "production-shaped", PRODUCTION_SHAPED_FILES, epoch);
  const paths = Object.fromEntries(
    Object.entries(DEFAULT_RELATIVE_PATHS).map(([key, relativePath]) => [key, join(target, relativePath)]),
  );
  const views = loadArtifacts(paths);
  const staleness = assessStaleness(target, views);
  return { staleness, views, output: projectReadback(views, staleness), target };
}

test("the nested layout is computable and stale after HEAD movement", (t) => {
  const { staleness, views, output } = projectNested(t, EPOCH_AFTER_ARTIFACTS);
  assert.equal(staleness.computable, true);
  assert.equal(staleness.stale, true);
  assert.ok(output.includes("*** STALE ARTIFACTS ***"));
  for (const key of ["packet", "doctor", "context", "report"]) assert.equal(views[key].state, "loaded");
});

test("the nested layout is computable and fresh before HEAD movement", (t) => {
  const { staleness, output } = projectNested(t, EPOCH_BEFORE_ARTIFACTS);
  assert.equal(staleness.computable, true);
  assert.equal(staleness.stale, false);
  assert.ok(!output.includes("STALE ARTIFACTS"));
});

test("object blockers render complete without dumping objects", (t) => {
  const { output } = projectNested(t, EPOCH_BEFORE_ARTIFACTS);
  assert.ok(
    output.includes(
      "blocker: [MISSING_SOURCE_PAGE] No matching source page was found for the declared checkout layout (stage=assembly, page_id=page_fixture_01)",
    ),
  );
  assert.ok(
    output.includes(
      "blocker: [ASSET_SWEEP_INCOMPLETE] Two fixture assets referenced by landing were not copied into the build output (stage=assembly, page_id=page_fixture_02)",
    ),
  );
  assert.ok(output.includes("blocker: assembly halted before the remaining pages were attempted"));
  assert.ok(!output.includes("non-string entry"));
  assert.ok(!output.includes("... (truncated)"));
});

test("doctor warnings group across the artifact set", (t) => {
  const { output } = projectNested(t, EPOCH_BEFORE_ARTIFACTS);
  assert.ok(output.includes("contract-static (1)"));
  assert.ok(output.includes("repo-observed (1)"));
  assert.ok(output.includes("report status: blocked_at_assembly"));
});

// ---------------------------------------------------------------------------
// JSON projection (13 cases)
// ---------------------------------------------------------------------------

test("the payload declares the v2 schema version", () => {
  const payload = payloadFor("blocked-verdict", BLOCKED_MAPPING);
  assert.equal(payload.schema_version, "campaigns-os-readback/v2");
  assert.equal(payload.schema_version, JSON_SCHEMA_VERSION);
});

test("artifact rows carry state without raw data payloads", () => {
  const payload = payloadFor("blocked-verdict", BLOCKED_MAPPING);
  assert.deepEqual(payload.artifacts.map((row) => row.key), Object.keys(BLOCKED_MAPPING));
  for (const row of payload.artifacts) {
    assert.deepEqual(Object.keys(row).sort(), ["detail", "key", "path", "state"]);
    assert.equal(row.state, "loaded");
    assert.equal(row.detail, "");
  }
});

test("absent and unreadable states are reported with detail", () => {
  const views = loadArtifacts({
    doctor: join(FIXTURES, "malformed", "truncated-doctor.json"),
    findings: join(FIXTURES, "blocked-verdict", "nothing.json"),
  });
  const rows = Object.fromEntries(buildJsonPayload(views).artifacts.map((row) => [row.key, row]));
  assert.equal(rows.doctor.state, "unreadable");
  assert.ok(rows.doctor.detail.includes("invalid JSON"));
  assert.equal(rows.findings.state, "absent");
  assert.equal(rows.findings.detail, "");
});

test("doctor group counts match the rendered view", () => {
  const { doctor } = payloadFor("blocked-verdict", BLOCKED_MAPPING);
  assert.equal(doctor.present, true);
  assert.equal(doctor.status, "ready_with_warnings");
  assert.equal(doctor.error_count, 0);
  assert.equal(doctor.warning_count, 29);
  assert.equal(doctor.warning_groups["contract-static"].length, 19);
  assert.equal(doctor.warning_groups["repo-observed"].length, 10);
});

test("an absent doctor reports absence, not an observed zero", () => {
  const payload = payloadFor("passing", { report: "assembly-report.json" });
  assert.deepEqual(payload.doctor, {
    present: false,
    status: null,
    error_count: 0,
    warning_count: 0,
    warning_groups: { "contract-static": [], "repo-observed": [] },
  });
});

test("skip cascades serialize the same grouping the text view renders", () => {
  const payload = payloadFor("blocked-verdict", BLOCKED_MAPPING);
  assert.equal(payload.skip_cascades.length, 1);
  const [cascade] = payload.skip_cascades;
  assert.equal(cascade.blocked_by, "polish.evidence_incomplete");
  assert.equal(cascade.families.length, 11);
  assert.ok(cascade.families.includes("funnel-flow"));
  assert.ok(
    render("blocked-verdict", BLOCKED_MAPPING).includes(
      `${cascade.blocked_by} -> ${cascade.families.length} skipped families:`,
    ),
  );
});

test("divergences serialize the stage and its failing assertions", () => {
  assert.deepEqual(payloadFor("blocked-verdict", BLOCKED_MAPPING).divergences, [
    { stage: "polish", assertion_ids: ["polish.evidence_incomplete"] },
  ]);
});

test("the passing fixture records no cascades and no divergences", () => {
  const payload = payloadFor("passing", PASSING_MAPPING);
  assert.deepEqual(payload.skip_cascades, []);
  assert.deepEqual(payload.divergences, []);
  assert.equal(payload.doctor.warning_count, 0);
});

test("staleness instants serialize as ISO-8601 UTC strings", (t) => {
  const root = tempRoot(t);
  writeReport(root);
  writeReflog(join(root, ".git"), EPOCH_AFTER_ARTIFACTS);
  const { staleness } = targetPayload(root);
  assert.equal(staleness.computable, true);
  assert.equal(staleness.stale, true);
  assert.equal(staleness.newest_key, "report");
  assert.equal(staleness.head_time, "2026-08-06T07:06:40Z");
  assert.equal(staleness.head_detail, "");
  assert.deepEqual(staleness.artifact_times, { report: "2026-06-23T00:00:00Z" });
  assert.deepEqual(staleness.artifacts, { report: { generated_at: "2026-06-23T00:00:00Z", stale: true } });
  assert.deepEqual(staleness.stale_keys, ["report"]);
});

test("uncomputable staleness carries its reason and a null head_time", (t) => {
  const root = tempRoot(t);
  writeReport(root);
  const { staleness } = targetPayload(root);
  assert.equal(staleness.computable, false);
  assert.equal(staleness.stale, false);
  assert.equal(staleness.head_time, null);
  assert.ok(staleness.head_detail.includes("not a Git checkout"));
});

test("a payload without a staleness assessment serializes null", () => {
  const payload = payloadFor("passing", PASSING_MAPPING);
  assert.equal(payload.staleness, null);
  assert.equal(payload.clean, false);
});

test("the payload is JSON-serializable and deterministic", () => {
  const payload = payloadFor("blocked-verdict", BLOCKED_MAPPING);
  const encoded = JSON.stringify(payload);
  assert.deepEqual(JSON.parse(encoded), payload);
  assert.equal(encoded, JSON.stringify(payloadFor("blocked-verdict", BLOCKED_MAPPING)));
});

test("the production-shaped fixture projects to JSON over a nested target", (t) => {
  const target = layoutNestedFixture(t, "production-shaped", PRODUCTION_SHAPED_FILES, EPOCH_BEFORE_ARTIFACTS);
  const payload = targetPayload(target);
  assert.deepEqual(states(payload), {
    packet: "loaded",
    doctor: "loaded",
    context: "loaded",
    report: "loaded",
    qa_verdict: "absent",
    findings: "absent",
  });
  assert.equal(payload.staleness.computable, true);
  assert.equal(payload.staleness.stale, false);
  assert.equal(payload.staleness.newest_key, "doctor");
  assert.equal(payload.doctor.warning_count, 2);
  assert.equal(payload.doctor.warning_groups["contract-static"].length, 1);
  assert.deepEqual(payload.skip_cascades, []);
  assert.deepEqual(payload.divergences, []);
  // No QA verdict here, so nothing contradicts the assembly report and the
  // projection is clean even though the report is blocked: `clean` judges the
  // readback's view, not the campaign's standing.
  assert.equal(payload.clean, true);
});

// ---------------------------------------------------------------------------
// The clean flag (11 cases): each condition failed one at a time
// ---------------------------------------------------------------------------

/**
 * A target that is clean before the test changes one thing: a loaded assembly
 * report with a parseable generated_at, a doctor output with no errors, and a
 * HEAD that last moved before both. The build packet, build context, QA verdict
 * and findings export are absent, which the clean rule tolerates.
 */
function cleanBaseline(t, epoch = EPOCH_BEFORE_ARTIFACTS) {
  const root = tempRoot(t);
  writeReport(root, { stages: { polish: { status: "completed" } } });
  writeDoctor(root);
  writeReflog(join(root, ".git"), epoch);
  return root;
}

test("a baseline with absent optional artifacts is clean", (t) => {
  const payload = targetPayload(cleanBaseline(t));
  assert.equal(payload.clean, true);
  const rows = states(payload);
  assert.equal(rows.report, "loaded");
  for (const key of ["packet", "context", "qa_verdict", "findings"]) assert.equal(rows[key], "absent");
});

test("stale artifacts are not clean", (t) => {
  const payload = targetPayload(cleanBaseline(t, EPOCH_AFTER_ARTIFACTS));
  assert.equal(payload.staleness.stale, true);
  assert.equal(payload.clean, false);
});

test("uncomputable staleness is not clean", (t) => {
  const root = cleanBaseline(t);
  rmSync(join(root, ".git"), { recursive: true, force: true });
  const payload = targetPayload(root);
  assert.equal(payload.staleness.computable, false);
  assert.equal(payload.clean, false);
});

test("a cross-artifact divergence is not clean", (t) => {
  const root = cleanBaseline(t);
  writeVerdict(root, [{ id: "polish.evidence_incomplete", family: "polish_gate", status: "fail" }]);
  const payload = targetPayload(root);
  assert.equal(payload.divergences.length, 1);
  assert.equal(payload.clean, false);
});

test("a doctor error is not clean", (t) => {
  const root = cleanBaseline(t);
  writeDoctor(root, { errors: [{ code: "spec.missing", message: "fixture error" }], status: "blocked" });
  const payload = targetPayload(root);
  assert.equal(payload.doctor.error_count, 1);
  assert.equal(payload.clean, false);
});

test("an unreadable artifact is not clean", (t) => {
  const root = cleanBaseline(t);
  writeFileSync(join(root, ".campaign-runtime", "doctor-output.json"), "{not json", "utf8");
  const payload = targetPayload(root);
  assert.equal(states(payload).doctor, "unreadable");
  assert.equal(payload.clean, false);
});

test("an unrecognized artifact is not clean", (t) => {
  const root = cleanBaseline(t);
  copyFileSync(join(FIXTURES, "malformed", "wrong-schema-packet.json"), join(root, "campaign-runtime.build.json"));
  const payload = targetPayload(root);
  assert.equal(states(payload).packet, "unrecognized");
  assert.equal(payload.clean, false);
});

test("doctor warnings alone do not make a projection unclean", (t) => {
  const root = cleanBaseline(t);
  writeDoctor(root, {
    warnings: [
      { code: "frontmatter.demoOnlyValues", message: "fixture" },
      { code: "copy.hardcoded_phone", message: "fixture" },
    ],
    status: "ready_with_warnings",
  });
  const payload = targetPayload(root);
  assert.equal(payload.doctor.warning_count, 2);
  assert.equal(payload.clean, true);
});

test("a blocked verdict without divergence stays clean", (t) => {
  // Campaigns OS remains the verdict authority: the readback saw the block
  // exactly as recorded, so its own view is still clean.
  const root = cleanBaseline(t);
  writeVerdict(root, [{ id: "deploy.unreachable", family: "deploy_gate", status: "fail" }]);
  const payload = targetPayload(root);
  assert.deepEqual(payload.divergences, []);
  assert.equal(payload.clean, true);
});

test("a target with no artifacts at all is never clean", (t) => {
  const root = tempRoot(t);
  writeReflog(join(root, ".git"), EPOCH_BEFORE_ARTIFACTS);
  const payload = targetPayload(root);
  assert.ok(payload.artifacts.every((row) => row.state === "absent"));
  assert.equal(payload.staleness.computable, false);
  assert.equal(payload.clean, false);
});

test("classifyDoctorWarning labels only the frontmatter prefix contract-static", () => {
  assert.equal(classifyDoctorWarning("frontmatter.demoOnlyValues"), "contract-static");
  assert.equal(classifyDoctorWarning("copy.hardcoded_phone"), "repo-observed");
  assert.equal(classifyDoctorWarning(null), "repo-observed");
});

// ---------------------------------------------------------------------------
// The command line (9 cases)
// ---------------------------------------------------------------------------

function runMain(argv) {
  const { exitCode, text } = runReadbackCommand(parseReadbackArgv(argv));
  return exitCode === 0 ? { code: 0, out: text, err: "" } : { code: exitCode, out: "", err: text };
}

/** The dispatcher's own argv shape, so in-process cases match a real run. */
function parseReadbackArgv(argv) {
  const args = { _: ["readback"] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[token.slice(2)] = true;
    else {
      args[token.slice(2)] = next;
      index += 1;
    }
  }
  return args;
}

function layoutDefaultTarget(root, { epoch = null, names = ["doctor-output.json", "build-context.json", "assembly-report.json", "qa-verdict.json"] } = {}) {
  const source = join(FIXTURES, "blocked-verdict");
  copyFileSync(join(source, "campaign-runtime.build.json"), join(root, "campaign-runtime.build.json"));
  const sidecars = join(root, ".campaign-runtime");
  mkdirSync(sidecars, { recursive: true });
  for (const name of names) copyFileSync(join(source, name), join(sidecars, name));
  if (epoch !== null) writeReflog(join(root, ".git"), epoch);
}

test("the CLI renders the blocked fixture and exits zero", () => {
  const dir = join(FIXTURES, "blocked-verdict");
  const { code, out } = runMain([
    dir,
    "--packet", join(dir, "campaign-runtime.build.json"),
    "--doctor", join(dir, "doctor-output.json"),
    "--context", join(dir, "build-context.json"),
    "--report", join(dir, "assembly-report.json"),
    "--qa-verdict", join(dir, "qa-verdict.json"),
  ]);
  assert.equal(code, 0);
  assert.ok(out.includes("polish.evidence_incomplete -> 11 skipped families"));
});

test("the CLI refuses a missing root with exit code two", () => {
  const { code, out, err } = runMain([join(tmpdir(), "no-such-readback-root")]);
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.ok(err.includes("existing directory"));
});

test("the CLI reads the default sidecar layout from a repository root", (t) => {
  const root = tempRoot(t);
  layoutDefaultTarget(root);
  const { code, out } = runMain([root]);
  assert.equal(code, 0);
  assert.ok(out.includes("map_id = runtime-packet-demo-k9x2"));
});

test("the CLI renders the staleness banner for a moved checkout", (t) => {
  const root = tempRoot(t);
  layoutDefaultTarget(root, { epoch: EPOCH_AFTER_ARTIFACTS, names: ["assembly-report.json"] });
  const { code, out } = runMain([root]);
  assert.equal(code, 0);
  assert.ok(out.includes("*** STALE ARTIFACTS ***"));
});

test("--json emits one parseable v2 object on stdout", (t) => {
  const root = tempRoot(t);
  layoutDefaultTarget(root, { epoch: EPOCH_AFTER_ARTIFACTS });
  const { code, out, err } = runMain([root, "--json"]);
  assert.equal(code, 0);
  assert.equal(err, "");
  const payload = JSON.parse(out);
  assert.equal(payload.schema_version, "campaigns-os-readback/v2");
  assert.equal(payload.staleness.stale, true);
  assert.equal(payload.clean, false);
  assert.equal(payload.divergences[0].stage, "polish");
});

test("--json output carries no rendered prose", (t) => {
  const root = tempRoot(t);
  layoutDefaultTarget(root, { epoch: EPOCH_AFTER_ARTIFACTS });
  const { out } = runMain([root, "--json"]);
  assert.ok(!out.includes("RUN-ARTIFACT READBACK"));
  assert.ok(!out.includes("*** STALE ARTIFACTS ***"));
  assert.ok(out.endsWith("\n"));
});

test("text output is the default and is unchanged by the JSON mode", (t) => {
  const root = tempRoot(t);
  layoutDefaultTarget(root, { epoch: EPOCH_AFTER_ARTIFACTS });
  const { out } = runMain([root]);
  const { views, staleness, packetSelection } = projectTarget(root);
  assert.equal(out, projectReadback(views, staleness, packetSelection));
  assert.ok(out.includes("CAMPAIGNS OS RUN-ARTIFACT READBACK"));
});

test("JSON mode writes nothing under the target repository", (t) => {
  const root = tempRoot(t);
  layoutDefaultTarget(root, { epoch: EPOCH_AFTER_ARTIFACTS });
  const before = treeDigest(root);
  const { code } = runMain([root, "--json"]);
  assert.equal(code, 0);
  assert.equal(treeDigest(root), before);
});

test("the projection writes nothing under the target repository", (t) => {
  const root = tempRoot(t);
  copyFileSync(
    join(FIXTURES, "blocked-verdict", "campaign-runtime.build.json"),
    join(root, "campaign-runtime.build.json"),
  );
  const before = treeDigest(root);
  const { code } = runMain([root]);
  assert.equal(code, 0);
  assert.equal(treeDigest(root), before);
});

// ---------------------------------------------------------------------------
// Packet selection (11 cases)
// ---------------------------------------------------------------------------

function jsonFor(argv) {
  const { code, out, err } = runMain(argv);
  return { code, payload: code === 0 ? JSON.parse(out) : null, err };
}

test("the newest generated_at wins over the default name", (t) => {
  const root = tempRoot(t);
  writePacket(root, "campaign-runtime.build.json", "2026-04-01T09:00:00Z", "older-run-a1b2");
  writePacket(root, "campaign-runtime-second.build.json", "2026-05-02T11:30:00Z", "newer-run-c3d4");
  const { code, payload } = jsonFor([root, "--json"]);
  const { out: text } = runMain([root]);
  assert.equal(code, 0);
  const packetRow = payload.artifacts[0];
  assert.equal(packetRow.key, "packet");
  assert.ok(packetRow.path.endsWith("campaign-runtime-second.build.json"), packetRow.path);
  assert.equal(payload.packet_selection.mode, "discovered");
  assert.equal(payload.packet_selection.signal, "generated_at");
  assert.deepEqual(payload.packet_selection.candidates_considered.slice().sort(), [
    "campaign-runtime-second.build.json",
    "campaign-runtime.build.json",
  ]);
  assert.equal(payload.packet_selection.selected, "campaign-runtime-second.build.json");
  assert.ok(text.includes("map_id = newer-run-c3d4"));
  assert.ok(
    text.includes("chose campaign-runtime-second.build.json by generated_at from 2 root-level Build Packet candidate(s)"),
  );
});

test("the chosen packet is not read a second time", (t) => {
  // ADAPTED: asserted through view identity rather than by patching the
  // module's own binding, which ESM does not expose. See the header note.
  const root = tempRoot(t);
  writePacket(root, "campaign-runtime.build.json", "2026-04-01T09:00:00Z", "read-once-w3x4");
  const { paths, packetView } = resolveProjection(root, {});
  assert.notEqual(packetView, null);
  const views = loadArtifacts(paths, { packet: packetView });
  assert.equal(views.packet, packetView);
  assert.equal(views.packet.state, "loaded");
});

test("a tied generated_at refuses and names the candidates", (t) => {
  const root = tempRoot(t);
  for (const name of ["campaign-runtime.build.json", "campaign-runtime-tied.build.json"]) {
    writePacket(root, name, "2026-04-01T09:00:00Z", "tied-e5f6");
  }
  const { code, out, err } = runMain([root, "--json"]);
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.ok(err.includes("--packet"));
  assert.ok(err.includes("campaign-runtime.build.json"));
  assert.ok(err.includes("campaign-runtime-tied.build.json"));
});

test("packets a microsecond apart are two instants, not a tie", (t) => {
  // Selection compares the recorded instants, and two packets whose
  // generated_at differ in the sixth fractional digit ARE different instants:
  // truncating them to milliseconds made this pair a tie and refused a run the
  // artifacts had already ordered. Both values render at second precision, so
  // the distinction lives only in the comparison.
  const root = tempRoot(t);
  writePacket(root, "campaign-runtime.build.json", "2026-09-22T10:00:00.000001Z", "older-micro-u1v2");
  writePacket(root, "campaign-runtime-second.build.json", "2026-09-22T10:00:00.000002Z", "newer-micro-w3x4");
  const { code, payload, err } = jsonFor([root, "--json"]);
  assert.equal(code, 0, err);
  assert.equal(payload.packet_selection.signal, "generated_at");
  assert.equal(payload.packet_selection.selected, "campaign-runtime-second.build.json");
  assert.ok(payload.artifacts[0].path.endsWith("campaign-runtime-second.build.json"));
  assert.ok(runMain([root]).out.includes("map_id = newer-micro-w3x4"));
});

test("packets equal to the microsecond still refuse to be told apart", (t) => {
  // The bound on the case above: added precision resolves a difference the
  // artifacts recorded, and invents none where they recorded none.
  const root = tempRoot(t);
  for (const name of ["campaign-runtime.build.json", "campaign-runtime-same-micro.build.json"]) {
    writePacket(root, name, "2026-09-22T10:00:00.000001Z", "same-micro-y5z6");
  }
  const { code, err } = runMain([root, "--json"]);
  assert.equal(code, 2);
  assert.ok(err.includes("share the newest generated_at"));
  assert.ok(err.includes("2026-09-22T10:00:00Z"), err);
  assert.ok(err.includes("campaign-runtime-same-micro.build.json"));
});

test("a candidate without generated_at refuses rather than guessing", (t) => {
  const root = tempRoot(t);
  writePacket(root, "campaign-runtime.build.json", "2026-04-01T09:00:00Z", "dated-g7h8");
  writePacket(root, "campaign-runtime-undated.build.json", null, "undated-i9j0");
  const { code, err } = runMain([root]);
  assert.equal(code, 2);
  assert.ok(err.includes("no parseable generated_at"));
  assert.ok(err.includes("Pass --packet"));
});

test("an explicit packet wins over a newer discovered candidate", (t) => {
  const root = tempRoot(t);
  writePacket(root, "campaign-runtime.build.json", "2026-04-01T09:00:00Z", "explicit-k1l2");
  writePacket(root, "campaign-runtime-newer.build.json", "2026-06-03T12:00:00Z", "ignored-m3n4");
  const { code, payload } = jsonFor([root, "--packet", join(root, "campaign-runtime.build.json"), "--json"]);
  assert.equal(code, 0);
  assert.ok(payload.artifacts[0].path.endsWith("campaign-runtime.build.json"));
  assert.equal(payload.packet_selection.mode, "explicit");
  assert.equal(payload.packet_selection.signal, "explicit");
  assert.deepEqual(payload.packet_selection.candidates_considered, []);
});

test("a single default packet is projected as before", (t) => {
  const root = tempRoot(t);
  writePacket(root, "campaign-runtime.build.json", "2026-04-01T09:00:00Z", "solo-o5p6");
  const { code, payload } = jsonFor([root, "--json"]);
  const { out: text } = runMain([root]);
  assert.equal(code, 0);
  assert.ok(payload.artifacts[0].path.endsWith("campaign-runtime.build.json"));
  assert.equal(payload.packet_selection.mode, "default");
  assert.equal(payload.packet_selection.signal, "sole_candidate");
  assert.ok(text.includes("map_id = solo-o5p6"));
  assert.ok(!text.includes("root-level Build Packet candidate(s)"));
});

test("a malformed suffixed packet is ignored with a recorded reason", (t) => {
  const root = tempRoot(t);
  writePacket(root, "campaign-runtime.build.json", "2026-04-01T09:00:00Z", "survivor-q7r8");
  writeFileSync(join(root, "campaign-runtime-broken.build.json"), "{not json at all", "utf8");
  writeFileSync(
    join(root, "campaign-runtime-foreign.build.json"),
    JSON.stringify({ schema_version: "some-other-thing/v9" }),
    "utf8",
  );
  const { code, payload } = jsonFor([root, "--json"]);
  const { out: text } = runMain([root]);
  assert.equal(code, 0);
  const selection = payload.packet_selection;
  assert.deepEqual(selection.candidates_considered, ["campaign-runtime.build.json"]);
  const rejected = Object.fromEntries(selection.rejected.map((entry) => [entry.path, entry.reason]));
  assert.ok("campaign-runtime-broken.build.json" in rejected);
  assert.ok(rejected["campaign-runtime-broken.build.json"].includes("invalid JSON"));
  assert.ok("campaign-runtime-foreign.build.json" in rejected);
  assert.ok(rejected["campaign-runtime-foreign.build.json"].includes("unrecognized schema_version"));
  assert.ok(text.includes("map_id = survivor-q7r8"));
  assert.ok(text.includes("ignored candidate campaign-runtime-broken"));
});

test("a target with no packet still reports the default path absent", (t) => {
  const root = tempRoot(t);
  const { code, payload } = jsonFor([root, "--json"]);
  assert.equal(code, 0);
  assert.equal(payload.artifacts[0].state, "absent");
  assert.ok(payload.artifacts[0].path.endsWith("campaign-runtime.build.json"));
  assert.equal(payload.packet_selection.mode, "default");
  assert.equal(payload.packet_selection.signal, "none");
  assert.deepEqual(payload.packet_selection.rejected, []);
});

test("a sidecar-located packet is named, not selected", (t) => {
  // Campaigns OS writes the packet at the repository root. A write-end that
  // puts it only under .campaign-runtime/ is a contract mismatch: discovery
  // must name the file so --packet can project it, and must not auto-select it
  // as if the contracted home had moved.
  const root = tempRoot(t);
  const sidecars = join(root, ".campaign-runtime");
  mkdirSync(sidecars, { recursive: true });
  writePacket(sidecars, "campaign-runtime.build.json", "2026-08-21T23:00:00Z", "sidecar-s9t0");
  const { code, payload } = jsonFor([root, "--json"]);
  const { out: text } = runMain([root]);
  assert.equal(code, 0);
  assert.equal(payload.artifacts[0].state, "absent");
  assert.ok(payload.artifacts[0].path.endsWith("campaign-runtime.build.json"));
  assert.ok(!payload.artifacts[0].path.endsWith(join(".campaign-runtime", "campaign-runtime.build.json")));
  assert.equal(payload.packet_selection.mode, "default");
  assert.equal(payload.packet_selection.signal, "none");
  assert.deepEqual(payload.packet_selection.candidates_considered, []);
  const rejected = Object.fromEntries(payload.packet_selection.rejected.map((entry) => [entry.path, entry.reason]));
  assert.ok(".campaign-runtime/campaign-runtime.build.json" in rejected);
  assert.ok(rejected[".campaign-runtime/campaign-runtime.build.json"].includes("Pass --packet"));
  assert.ok(text.includes("ignored candidate .campaign-runtime/campaign-runtime.build.json"));
  assert.ok(!text.includes("map_id = sidecar-s9t0"));
});

test("an explicit packet can project a sidecar-located packet", (t) => {
  const root = tempRoot(t);
  const sidecars = join(root, ".campaign-runtime");
  mkdirSync(sidecars, { recursive: true });
  writePacket(sidecars, "campaign-runtime.build.json", "2026-08-21T23:00:00Z", "sidecar-explicit-u1v2");
  const sidecar = join(sidecars, "campaign-runtime.build.json");
  const { code, payload } = jsonFor([root, "--packet", sidecar, "--json"]);
  const { out: text } = runMain([root, "--packet", sidecar]);
  assert.equal(code, 0);
  assert.equal(payload.artifacts[0].state, "loaded");
  assert.ok(payload.artifacts[0].path.endsWith(join(".campaign-runtime", "campaign-runtime.build.json")));
  assert.equal(payload.packet_selection.mode, "explicit");
  assert.deepEqual(payload.packet_selection.rejected, []);
  assert.ok(text.includes("map_id = sidecar-explicit-u1v2"));
});

test("a root packet does not scan the sidecar location", (t) => {
  const root = tempRoot(t);
  writePacket(root, "campaign-runtime.build.json", "2026-04-01T09:00:00Z", "root-w3x4");
  const sidecars = join(root, ".campaign-runtime");
  mkdirSync(sidecars, { recursive: true });
  writePacket(sidecars, "campaign-runtime.build.json", "2026-08-21T23:00:00Z", "sidecar-ignored-y5z6");
  const { code, payload } = jsonFor([root, "--json"]);
  const { out: text } = runMain([root]);
  assert.equal(code, 0);
  const packetPath = payload.artifacts[0].path.replace(/\\/g, "/");
  assert.ok(packetPath.endsWith("/campaign-runtime.build.json"));
  assert.ok(!packetPath.includes("/.campaign-runtime/"));
  assert.equal(payload.packet_selection.signal, "sole_candidate");
  assert.deepEqual(payload.packet_selection.rejected, []);
  assert.ok(text.includes("map_id = root-w3x4"));
  assert.ok(!text.includes("map_id = sidecar-ignored-y5z6"));
});

test("selection writes nothing under the target repository", (t) => {
  const root = tempRoot(t);
  writePacket(root, "campaign-runtime.build.json", "2026-04-01T09:00:00Z", "quiet-s9t0");
  writePacket(root, "campaign-runtime-later.build.json", "2026-04-09T09:00:00Z", "quiet-u1v2");
  const before = treeDigest(root);
  const { code } = runMain([root, "--json"]);
  assert.equal(code, 0);
  assert.equal(treeDigest(root), before);
});

test("selectPacketPath refuses a tie through its own exported error", (t) => {
  const root = tempRoot(t);
  for (const name of ["campaign-runtime.build.json", "campaign-runtime-tied.build.json"]) {
    writePacket(root, name, "2026-04-01T09:00:00Z", "tied-a1b2");
  }
  assert.throws(() => selectPacketPath(root, null), ReadbackUsageError);
});

// ===========================================================================
// New cases for this port
// ===========================================================================

// ---------------------------------------------------------------------------
// #130: per-artifact staleness. One fresh artifact cannot hide stale siblings.
// ---------------------------------------------------------------------------

const MIXED_AGE_FILES = ["assembly-report.json", "doctor-output.json"];

function mixedAgeTarget(t, epoch = EPOCH_AFTER_ARTIFACTS) {
  const root = tempRoot(t, "readback-mixed-age-");
  const sidecars = join(root, ".campaign-runtime");
  mkdirSync(sidecars, { recursive: true });
  for (const name of MIXED_AGE_FILES) copyFileSync(join(FIXTURES, "mixed-age", name), join(sidecars, name));
  if (epoch !== null) writeReflog(join(root, ".git"), epoch);
  return root;
}

test("#130: a fresh newest artifact does not hide a stale older sibling", (t) => {
  // The negative control for this port's critical claim. The doctor output is
  // NEWER than the HEAD movement and the assembly report is OLDER than it, so
  // the v1 rule — compare only the newest artifact — reported stale: false and
  // clean: true for a target whose assembly report predates the checkout. An
  // aggregate computed from the newest artifact alone fails right here.
  const root = mixedAgeTarget(t);
  const payload = targetPayload(root);
  assert.equal(payload.staleness.computable, true);
  assert.equal(payload.staleness.newest_key, "doctor");
  assert.equal(payload.staleness.artifacts.doctor.stale, false);
  assert.equal(payload.staleness.artifacts.report.stale, true);
  assert.deepEqual(payload.staleness.stale_keys, ["report"]);
  assert.equal(payload.staleness.stale, true);
  assert.equal(payload.clean, false);
});

test("#130: the text view names each stale artifact", (t) => {
  const root = mixedAgeTarget(t);
  const { views, staleness, packetSelection } = projectTarget(root);
  const output = projectReadback(views, staleness, packetSelection);
  assert.ok(output.includes("*** STALE ARTIFACTS ***"));
  assert.ok(output.includes("of 2 loaded artifact(s), 2 could be compared and 1 predate it:"));
  assert.ok(output.includes(`    ${ARTIFACT_TITLES.report} (generated 2026-06-23T00:00:00Z)`));
  assert.ok(!output.includes(`    ${ARTIFACT_TITLES.doctor} (generated`));
});

test("#130: stale_keys is in render order, not discovery order", (t) => {
  const root = tempRoot(t);
  writeReport(root, { generatedAt: "2026-06-23T00:00:00.000Z" });
  writeDoctor(root, { generatedAt: "2026-06-24T00:00:00.000Z" });
  writePacket(root, "campaign-runtime.build.json", "2026-06-25T00:00:00Z", "order-c3d4");
  writeReflog(join(root, ".git"), EPOCH_AFTER_ARTIFACTS);
  const payload = targetPayload(root);
  // Render order is packet, doctor, context, report, qa_verdict, findings.
  assert.deepEqual(payload.staleness.stale_keys, ["packet", "doctor", "report"]);
  assert.deepEqual(Object.keys(payload.staleness.artifacts), ["packet", "doctor", "report"]);
});

test("#130: every loaded artifact stale reports every key", (t) => {
  const root = tempRoot(t);
  writeReport(root, { generatedAt: "2026-06-23T00:00:00.000Z" });
  writeDoctor(root, { generatedAt: "2026-06-24T00:00:00.000Z" });
  writeReflog(join(root, ".git"), EPOCH_AFTER_ARTIFACTS);
  const payload = targetPayload(root);
  assert.deepEqual(payload.staleness.stale_keys, ["doctor", "report"]);
  assert.equal(payload.staleness.stale, true);
  assert.equal(payload.clean, false);
  const { views, staleness } = projectTarget(root);
  assert.ok(
    projectReadback(views, staleness).includes("of 2 loaded artifact(s), 2 could be compared and 2 predate it:"),
  );
});

test("#130: every loaded artifact fresh reports no stale key", (t) => {
  const root = tempRoot(t);
  writeReport(root, { generatedAt: "2026-09-01T00:00:00.000Z" });
  writeDoctor(root, { generatedAt: "2026-09-02T00:00:00.000Z" });
  writeReflog(join(root, ".git"), EPOCH_AFTER_ARTIFACTS);
  const payload = targetPayload(root);
  assert.deepEqual(payload.staleness.stale_keys, []);
  assert.equal(payload.staleness.stale, false);
  assert.equal(payload.staleness.artifacts.doctor.stale, false);
  assert.equal(payload.staleness.artifacts.report.stale, false);
  assert.equal(payload.clean, true);
  const { views, staleness } = projectTarget(root);
  assert.ok(
    projectReadback(views, staleness).includes(
      "of 2 loaded artifact(s), 2 could be compared, and none of those is older than",
    ),
  );
});

test("#130: an unparseable generated_at stays unknown while a sibling is stale", (t) => {
  // Unknown is neither fresh nor stale: the artifact stays out of the map, the
  // aggregate still reports the stale sibling, and computability is unaffected
  // because another artifact does carry a parseable value.
  const root = tempRoot(t);
  writeReport(root, { generatedAt: "2026-06-23T00:00:00.000Z" });
  writeDoctor(root, { generatedAt: "not a timestamp" });
  writeReflog(join(root, ".git"), EPOCH_AFTER_ARTIFACTS);
  const payload = targetPayload(root);
  assert.equal(states(payload).doctor, "loaded");
  assert.ok(!("doctor" in payload.staleness.artifacts));
  assert.ok(!("doctor" in payload.staleness.artifact_times));
  assert.deepEqual(payload.staleness.stale_keys, ["report"]);
  assert.deepEqual(payload.staleness.unparseable_keys, ["doctor"]);
  assert.equal(payload.staleness.stale, true);
  assert.equal(payload.staleness.computable, true);
  assert.equal(payload.clean, false);
});

test("#130: a sole artifact with no parseable generated_at is not computable", (t) => {
  const root = tempRoot(t);
  writeDoctor(root, { generatedAt: "not a timestamp" });
  writeReflog(join(root, ".git"), EPOCH_AFTER_ARTIFACTS);
  const payload = targetPayload(root);
  assert.equal(payload.staleness.computable, false);
  assert.equal(payload.staleness.stale, false);
  assert.deepEqual(payload.staleness.artifacts, {});
  assert.deepEqual(payload.staleness.stale_keys, []);
  assert.deepEqual(payload.staleness.unparseable_keys, ["doctor"]);
  assert.equal(payload.staleness.newest_key, null);
  assert.equal(payload.clean, false);
});

// ---------------------------------------------------------------------------
// Unknown age: a recorded generated_at this readback cannot parse
//
// The hole the per-artifact rule left open. An artifact whose recorded age does
// not parse leaves the comparison, so with a FRESH sibling beside it the
// aggregate found nothing stale and the projection reported clean — an artifact
// whose currency was never established, inside a payload that says every
// artifact is at least as new as the checkout. The parser is a port of
// CPython's and any value CPython refuses lands here, so the rule is stated
// over the class (recorded, did not parse) rather than over one more input
// shape: such an artifact is named and clean is false. An artifact that
// recorded NO generated_at at all is the other case and keeps its behaviour.
// ---------------------------------------------------------------------------

/** The reviewer's reproduction: one fresh artifact, one of unknown age. */
function unknownAgeTarget(t, generatedAt) {
  const root = tempRoot(t, "readback-unknown-age-");
  writeReport(root, { generatedAt });
  writeDoctor(root, { generatedAt: "2026-09-22T12:00:00Z" });
  writeReflog(join(root, ".git"), Math.floor(Date.parse("2026-09-22T11:00:00Z") / 1000));
  return root;
}

test("an unparseable generated_at beside a FRESH sibling is not clean", (t) => {
  // Verbatim from the finding: doctor generated 12:00Z, HEAD moved 11:00Z, and
  // the report's generated_at is "last Tuesday". Nothing here is stale — the
  // one artifact that could be compared is newer than the movement — and that
  // is exactly why the old rule returned clean: true for it.
  const payload = targetPayload(unknownAgeTarget(t, "last Tuesday"));
  assert.equal(payload.staleness.stale, false);
  assert.deepEqual(payload.staleness.stale_keys, []);
  assert.equal(payload.staleness.computable, true);
  assert.deepEqual(payload.staleness.unparseable_keys, ["report"]);
  assert.deepEqual(Object.keys(payload.staleness.artifacts), ["doctor"]);
  assert.equal(payload.clean, false);
});

test("the unparseable artifact's row names the value's shape, not the value", (t) => {
  const payload = targetPayload(unknownAgeTarget(t, "last Tuesday"));
  const row = payload.artifacts.find((entry) => entry.key === "report");
  assert.equal(row.state, "loaded");
  assert.ok(row.detail.includes("generated_at is a 12-character string that is not an ISO-8601 instant"), row.detail);
  assert.ok(row.detail.includes("age could not be compared"), row.detail);
  // The row describes the value; it does not reproduce it, because a foreign or
  // hand-edited artifact can carry an arbitrarily long string there.
  assert.ok(!row.detail.includes("last Tuesday"), row.detail);
  assert.equal(
    payload.artifacts.find((entry) => entry.key === "doctor").detail,
    "",
    "an artifact whose age WAS compared keeps an empty detail",
  );
});

test("the text view names the artifact of unknown age and counts loaded artifacts", (t) => {
  const { views, staleness, packetSelection } = projectTarget(unknownAgeTarget(t, "last Tuesday"));
  const output = projectReadback(views, staleness, packetSelection);
  assert.ok(output.includes("*** UNKNOWN ARTIFACT AGE ***"), output);
  const shape = "a 12-character string that is not an ISO-8601 instant";
  assert.ok(output.includes(`    ${ARTIFACT_TITLES.report} (generated_at is ${shape})`), output);
  // The summary sentence counts the LOADED artifacts and says how many of them
  // the comparison examined; rendering the comparable count as the loaded one
  // asserted something about an artifact it never looked at.
  assert.ok(output.includes("of 2 loaded artifact(s), 1 could be compared"), output);
  assert.ok(!output.includes("every loaded artifact (1)"), output);
});

test("a generated_at of the wrong type is unknown age too, described by type", (t) => {
  // The rule is over the class, not over string shapes: a number, a null, an
  // object and an array are all recorded ages that did not parse. `null` is
  // written through the fixture directly, because the helper's `null` means
  // "omit the key" — which is the other case entirely.
  for (const [value, shape] of [
    [1758542400, "a number"],
    [null, "null"],
    [{ iso: "2026-09-22T10:00:00Z" }, "an object"],
    [["2026-09-22T10:00:00Z"], "an array of 1 item(s)"],
    ["", "an empty string"],
  ]) {
    const root = unknownAgeTarget(t, value);
    if (value === null) {
      writeFileSync(
        join(root, ".campaign-runtime", "assembly-report.json"),
        JSON.stringify({
          schema_version: "campaign-runtime-assembly-report/v0",
          status: "completed",
          stages: {},
          generated_at: null,
        }),
        "utf8",
      );
    }
    const payload = targetPayload(root);
    assert.deepEqual(payload.staleness.unparseable_keys, ["report"], JSON.stringify(value));
    assert.equal(payload.clean, false, JSON.stringify(value));
    const row = payload.artifacts.find((entry) => entry.key === "report");
    assert.ok(row.detail.includes(`generated_at is ${shape}`), row.detail);
  }
});

test("an artifact with NO generated_at key at all keeps today's behaviour", (t) => {
  // The distinction the rule turns on: this artifact recorded no age, so there
  // is no claim about its currency the readback failed to check. It stays out
  // of the comparison, it is not named as unknown age, and the fresh sibling
  // carries a clean projection exactly as it did before.
  const root = tempRoot(t);
  writeReport(root, { generatedAt: null }); // the helper omits the key entirely
  writeDoctor(root, { generatedAt: "2026-09-22T12:00:00Z" });
  writeReflog(join(root, ".git"), Math.floor(Date.parse("2026-09-22T11:00:00Z") / 1000));
  const payload = targetPayload(root);
  assert.equal(states(payload).report, "loaded");
  assert.deepEqual(payload.staleness.unparseable_keys, []);
  assert.ok(!("report" in payload.staleness.artifacts));
  assert.equal(payload.artifacts.find((entry) => entry.key === "report").detail, "");
  assert.equal(payload.staleness.computable, true);
  assert.equal(payload.clean, true);
  const { views, staleness } = projectTarget(root);
  assert.ok(!projectReadback(views, staleness).includes("UNKNOWN ARTIFACT AGE"));
});

test("a sole artifact of unknown age is not computable and is still named", (t) => {
  const root = tempRoot(t);
  writeReport(root, { generatedAt: "last Tuesday" });
  writeReflog(join(root, ".git"), EPOCH_AFTER_ARTIFACTS);
  const payload = targetPayload(root);
  assert.equal(payload.staleness.computable, false);
  assert.equal(payload.staleness.stale, false);
  assert.deepEqual(payload.staleness.unparseable_keys, ["report"]);
  assert.equal(payload.clean, false);
  const { views, staleness } = projectTarget(root);
  const output = projectReadback(views, staleness);
  assert.ok(output.includes("no loaded artifact carries a parseable generated_at"), output);
  assert.ok(output.includes("*** UNKNOWN ARTIFACT AGE ***"), output);
});

test("unparseable_keys is in render order, not discovery order", (t) => {
  const root = tempRoot(t);
  writeReport(root, { generatedAt: "last Tuesday" });
  writeDoctor(root, { generatedAt: "whenever" });
  writePacket(root, "campaign-runtime.build.json", "2026-09-22T12:00:00Z", "order-e5f6");
  writeReflog(join(root, ".git"), Math.floor(Date.parse("2026-09-22T11:00:00Z") / 1000));
  const payload = targetPayload(root);
  // Render order is packet, doctor, context, report, qa_verdict, findings.
  assert.deepEqual(payload.staleness.unparseable_keys, ["doctor", "report"]);
  assert.equal(payload.clean, false);
});

test("#130: with no HEAD signal no artifact is marked stale", (t) => {
  const root = tempRoot(t);
  writeReport(root, { generatedAt: "2026-06-23T00:00:00.000Z" });
  writeDoctor(root, { generatedAt: "2026-09-02T00:00:00.000Z" });
  const payload = targetPayload(root);
  assert.equal(payload.staleness.computable, false);
  assert.equal(payload.staleness.stale, false);
  assert.deepEqual(payload.staleness.stale_keys, []);
  assert.equal(payload.staleness.artifacts.report.stale, false);
  assert.equal(payload.clean, false);
});

// ---------------------------------------------------------------------------
// --example over the bundled synthetic sample
// ---------------------------------------------------------------------------

test("--example projects the bundled sample as not computable by design", () => {
  const { views, staleness, packetSelection } = projectExample();
  const payload = buildJsonPayload(views, staleness, packetSelection);
  assert.equal(payload.schema_version, "campaigns-os-readback/v2");
  assert.deepEqual(states(payload), {
    packet: "loaded",
    doctor: "loaded",
    context: "loaded",
    report: "loaded",
    qa_verdict: "loaded",
    findings: "absent",
  });
  assert.equal(payload.staleness.computable, false);
  assert.equal(payload.staleness.stale, false);
  assert.equal(payload.staleness.head_time, null);
  assert.equal(payload.staleness.head_detail, EXAMPLE_HEAD_DETAIL);
  assert.equal(payload.clean, false);
});

test("--example renders the text view with the sample's own identity", () => {
  const { code, out } = runMain(["--example"]);
  assert.equal(code, 0);
  assert.ok(out.includes("CAMPAIGNS OS RUN-ARTIFACT READBACK"));
  assert.ok(out.includes("not computable"));
  assert.ok(out.includes("not a Git checkout"));
  assert.ok(out.includes("RUN IDENTITY"));
});

test("--example --json parses and declares v2", () => {
  const { code, out } = runMain(["--example", "--json"]);
  assert.equal(code, 0);
  const payload = JSON.parse(out);
  assert.equal(payload.schema_version, "campaigns-os-readback/v2");
  assert.equal(payload.staleness.head_detail, EXAMPLE_HEAD_DETAIL);
});

test("--example is deterministic and reads only packaged files", () => {
  const first = runMain(["--example", "--json"]);
  const second = runMain(["--example", "--json"]);
  assert.equal(first.out, second.out);
  for (const row of JSON.parse(first.out).artifacts) {
    // Package-relative, so the sample's output is the same on every machine
    // and the documented sample stays reproducible.
    assert.ok(row.path.startsWith(`${EXAMPLE_RELATIVE_ROOT}/`), row.path);
    assert.ok(statSync(join(ROOT, row.path), { throwIfNoEntry: false }) !== undefined || row.state === "absent");
  }
});

test("--example refuses a target or an override with exit code two", () => {
  // Both argv shapes refuse: a target written BEFORE --example reaches the
  // positional list, while one written after it is swallowed as the flag's
  // value by the dispatcher's parser. Each refusal names the supported shape.
  for (const argv of [
    [join(FIXTURES, "blocked-verdict"), "--example"],
    ["--example", join(FIXTURES, "blocked-verdict")],
    ["--example", "--packet", join(FIXTURES, "blocked-verdict", "campaign-runtime.build.json")],
    ["--example", "--report", join(FIXTURES, "blocked-verdict", "assembly-report.json")],
    // A target written after --json is swallowed by that flag instead, which
    // used to refuse with "--json is a boolean flag and takes no value" — true,
    // but it points at the wrong flag. The --example refusal wins, and names
    // the value it found.
    ["--example", "--json", join(FIXTURES, "blocked-verdict")],
  ]) {
    const { code, out, err } = runMain(argv);
    assert.equal(code, 2, argv.join(" "));
    assert.equal(out, "");
    assert.ok(err.includes("takes no target or path override"), err);
  }
});

test("--example names the target --json swallowed, and still refuses a bare --json value without --example", () => {
  const target = join(FIXTURES, "blocked-verdict");
  const { code, err } = runMain(["--example", "--json", target]);
  assert.equal(code, 2);
  assert.ok(err.includes(`--json ${target}`), err);
  assert.ok(!err.includes("--json is a boolean flag"), err);

  // Without --example there is no better answer than the boolean-flag one: the
  // value belongs to --json and nothing else in the argv explains it.
  const plain = runMain(["--json", target]);
  assert.equal(plain.code, 2);
  assert.ok(plain.err.includes("--json is a boolean flag and takes no value."), plain.err);
});

test("--example writes nothing under the packaged sample", () => {
  const before = treeDigest(join(ROOT, "contracts/fixtures/sidecar-bundle/production-shaped"));
  runMain(["--example"]);
  runMain(["--example", "--json"]);
  assert.equal(treeDigest(join(ROOT, "contracts/fixtures/sidecar-bundle/production-shaped")), before);
});

// ---------------------------------------------------------------------------
// Usage shape
// ---------------------------------------------------------------------------

test("readback refuses a missing target with exit code two", () => {
  const { code, err } = runMain([]);
  assert.equal(code, 2);
  assert.ok(err.includes("campaigns-os readback <target-repo-root>"));
});

test("readback refuses a second positional target", (t) => {
  const root = tempRoot(t);
  const { code, err } = runMain([root, root]);
  assert.equal(code, 2);
  assert.ok(err.includes("projects one target repository root"));
});

test("readback refuses a valueless path override", (t) => {
  const root = tempRoot(t);
  assert.throws(() => readbackRequest({ _: ["readback", root], report: true }), ReadbackUsageError);
});

test("readback refuses --json carrying a value", () => {
  assert.throws(() => readbackRequest({ _: ["readback", "."], json: "yes" }), ReadbackUsageError);
});

// ---------------------------------------------------------------------------
// Timestamp and bounded-read helpers
// ---------------------------------------------------------------------------

test("parseIsoTimestamp accepts the emitted shapes and refuses the rest", () => {
  assert.equal(parseIsoTimestamp("2026-06-23T00:00:00.000Z").toISOString(), "2026-06-23T00:00:00.000Z");
  assert.equal(parseIsoTimestamp("2026-06-23T00:00:00Z").toISOString(), "2026-06-23T00:00:00.000Z");
  // No timezone means UTC: documentation for hand-authored artifacts.
  assert.equal(parseIsoTimestamp("2026-06-23T00:00:00").toISOString(), "2026-06-23T00:00:00.000Z");
  assert.equal(parseIsoTimestamp("2026-06-23T02:00:00+02:00").toISOString(), "2026-06-23T00:00:00.000Z");
  assert.equal(parseIsoTimestamp("2026-06-23").toISOString(), "2026-06-23T00:00:00.000Z");
  for (const bad of ["", null, undefined, 17, "not a timestamp", "2026-13-01T00:00:00Z", "2026-02-30T00:00:00Z", "2026-06-23T25:00:00Z"]) {
    assert.equal(parseIsoTimestamp(bad), null, String(bad));
  }
});

test("parseIsoInstant keeps microseconds and truncates past six digits", () => {
  const micros = (value) => parseIsoInstant(value).micros;
  // The pair the millisecond truncation collapsed into one instant.
  assert.equal(micros("2026-09-22T10:00:00.000002Z") - micros("2026-09-22T10:00:00.000001Z"), 1n);
  assert.equal(micros("2026-09-22T10:00:00Z") % 1_000_000n, 0n);
  assert.equal(micros("2026-09-22T10:00:00.5Z") - micros("2026-09-22T10:00:00Z"), 500_000n);
  // Python's fromisoformat truncates a seventh digit rather than rounding it,
  // and a ported comparison has to agree with the module it replaces.
  assert.equal(micros("2026-09-22T10:00:00.0000019Z"), micros("2026-09-22T10:00:00.000001Z"));
  // An offset shifts the precise value the same way it shifts the Date.
  assert.equal(micros("2026-09-22T12:00:00.000002+02:00"), micros("2026-09-22T10:00:00.000002Z"));
  assert.equal(parseIsoInstant("not a timestamp"), null);
});

test("parseIsoTimestamp still hands back the millisecond Date renderers format", () => {
  // The rendering half is deliberately unchanged: sub-millisecond digits are
  // invisible in every projected view, second-precision or otherwise.
  assert.equal(parseIsoTimestamp("2026-09-22T10:00:00.000002Z").toISOString(), "2026-09-22T10:00:00.000Z");
  assert.equal(formatUtc(parseIsoTimestamp("2026-09-22T10:00:00.000002Z")), "2026-09-22T10:00:00Z");
  assert.equal(
    parseIsoTimestamp("2026-09-22T10:00:00.000001Z").getTime(),
    parseIsoTimestamp("2026-09-22T10:00:00.000002Z").getTime(),
  );
});

test("formatUtc renders second precision with a Z suffix", () => {
  assert.equal(formatUtc(new Date(Date.UTC(2026, 5, 23, 1, 2, 3, 456))), "2026-06-23T01:02:03Z");
});

// ---------------------------------------------------------------------------
// ISO-8601 acceptance parity with the Python this ports
//
// `_parse_iso_timestamp` (runner/artifact_readback.py:192-209) rewrites a
// trailing Z to +00:00 and calls datetime.fromisoformat, so the port has to
// accept and refuse exactly what that function does. Mis-accepting turns a
// required refusal into a silent selection; mis-refusing drops an artifact out
// of the staleness map, which is how a stale sibling gets reported clean.
//
// Every verdict below is tagged with where it comes from. READ means CPython
// 3.11's Lib/datetime.py states it directly — `fromisoformat`,
// `_find_isoformat_datetime_separator`, `_parse_isoformat_date`,
// `_parse_hh_mm_ss_ff`, `_parse_isoformat_time`, `_isoweek_to_gregorian`, and
// `timezone.__new__` with its `_maxoffset` of 24h less one microsecond. C
// means the pure-Python reference and the C accelerator disagree and this
// follows the accelerator, which is the implementation that actually runs.
//
// The C rows were originally a reading of the two implementations' source, and
// that reading was wrong in five places. They are now checked by running
// CPython 3.11.15's accelerator on each value and comparing the instant, so a C
// row states a measurement rather than an inference. Two C quirks are left
// unported and are therefore absent from both tables: the accelerator tolerates
// exactly one junk character where the time components end if an offset follows
// (`T10x+00:00`), and it reads `:` as a fraction separator after the seconds
// (`T10:00:00:12`). Both are refused here, as the pure-Python reference refuses
// them; no emitted artifact carries either shape.
// ---------------------------------------------------------------------------

// Each row is [value, the canonical form it must parse identically to, why].
const ISO_ACCEPTED = [
  [
    "2026-09-22T10:00:00.0000010000Z",
    "2026-09-22T10:00:00.000001Z",
    "READ: _parse_hh_mm_ss_ff parses six fractional digits and requires only " +
      "that the remainder be digits, so a fraction of any length parses",
  ],
  ["2026-09-22T10:00:00.999999999999999Z", "2026-09-22T10:00:00.999999Z", "READ: same rule, fifteen digits"],
  ["2026-09-22T10:00:00,000001Z", "2026-09-22T10:00:00.000001Z", "READ: `tstr[pos] not in '.,'` takes either separator"],
  ["2026-09-22T10:00:00,0000010000Z", "2026-09-22T10:00:00.000001Z", "READ: both rules at once"],
  ["2026-09-22T10:00:00+23:59", "2026-09-21T10:01:00Z", "READ: 23:59 is inside timezone()'s bound"],
  [
    "2026-09-22T10:00:00-00:00",
    "2026-09-22T10:00:00Z",
    "READ: an all-zero offset becomes timezone.utc before the bound is applied, sign and all",
  ],
  [
    "2026-09-22T10:00:00+00:60",
    "2026-09-22T09:00:00Z",
    "READ: offset components are NOT range-checked; only the total is, and 60 minutes is one hour",
  ],
  ["2026-09-22T10:00:00+05", "2026-09-22T05:00:00Z", "READ: a two-character offset is the hours-only form"],
  ["2026-09-22T10:00:00+0530", "2026-09-22T04:30:00Z", "READ: the separatorless offset form"],
  [
    "2026-09-22T10:00:00.000000500+00:00:00.000500",
    "2026-09-22T10:00:00Z",
    "C: the offset's WHOLE-second part is zero, so the accelerator returns UTC and drops its " +
      "fraction; pure Python would build a 500-microsecond timezone and land on 09:59:59.999500Z",
  ],
  [
    "2026-09-22T10:00:00+00:00:01.500000",
    "2026-09-22T09:59:58.5Z",
    "C: the bound on the row above — a non-zero whole-second part keeps its fraction, so the " +
      "UTC special case is about zero seconds and not about sub-second offsets",
  ],
  ["2026-09-22 10:00:00Z", "2026-09-22T10:00:00Z", "READ: the separator's position is found, its identity never checked"],
  ["2026-09-22x10:00:00Z", "2026-09-22T10:00:00Z", "READ: same rule; any single character separates the date from the time"],
  [
    "2026-09-22é10:00:00Z",
    "2026-09-22T10:00:00Z",
    "C: same rule with a non-ASCII separator that fits in one UTF-16 code unit",
  ],
  [
    "2026-09-22\u{1F600}10:00:00Z",
    "2026-09-22T10:00:00Z",
    "C: the separator is one Unicode character, so an astral one is consumed whole; skipping a " +
      "single UTF-16 code unit left its trailing surrogate in front of the time",
  ],
  [
    "2026-09-22T10.5Z",
    "2026-09-22T10:00:00.5Z",
    "C: a fraction may follow the hours; the accelerator starts it wherever the components stop",
  ],
  ["2026-09-22T10:00.5Z", "2026-09-22T10:00:00.5Z", "C: the same rule after the minutes"],
  ["2026-09-22T1000.5Z", "2026-09-22T10:00:00.5Z", "C: and after the minutes of the basic form"],
  ["2026-09-22T10:00,5Z", "2026-09-22T10:00:00.5Z", "C: either fraction separator, in the new position too"],
  ["20260922T100000Z", "2026-09-22T10:00:00Z", "READ: _parse_isoformat_date and _parse_hh_mm_ss_ff both take the basic form"],
  ["2026-W39-2T10:00:00Z", "2026-09-22T10:00:00Z", "READ: _isoweek_to_gregorian; 2026-W39-2 is 2026-09-22"],
  ["2026-W39", "2026-09-21T00:00:00Z", "READ: a week date with no weekday is that week's Monday"],
  ["2026-W53-1", "2026-12-28T00:00:00Z", "READ: 2026 starts on a Thursday, so it is a 53-week ISO year"],
  ["2026-09-22T10", "2026-09-22T10:00:00Z", "READ: minutes and seconds are optional"],
  ["2026-09-22T10:00", "2026-09-22T10:00:00Z", "READ: seconds are optional"],
  ["0050-09-22T10:00:00Z", "0050-09-22T10:00:00Z", "READ: MINYEAR is 1, and a two-digit year is not a shorthand"],
];

const ISO_REFUSED = [
  ["2026-09-22T10:00:00+25:00", "READ: timezone() bounds an offset strictly inside ±24h, so 25 hours raises"],
  ["2026-09-22T10:00:00-25:00", "READ: the bound is symmetric"],
  ["2026-09-22T10:00:00+24:00", "READ: the bound is strict, so exactly 24h raises too"],
  ["2026-09-22T10:00:00+23:60", "READ: 23h60m totals 24h, which is the same refusal"],
  ["2026-09-22T10:00:00+2500", "READ: the separatorless form is bounded the same way"],
  ["2026-09-22T10:00:00+25", "READ: so is the hours-only form"],
  ["2026-09-22T10:00:00+000", "READ: _parse_isoformat_time calls offset lengths 0, 1 and 3 malformed"],
  ["2026-09-22T10:00:00+00:0", "READ: an incomplete offset component"],
  ["2026-09-22T24:00:00Z", "READ: datetime's hour range is 0..23; there is no 24:00"],
  ["2026-09-22T10:60:00Z", "READ: minute range is 0..59"],
  ["2026-09-22T10:00:60Z", "READ: second range is 0..59; no leap second"],
  ["2026-13-01T00:00:00Z", "READ: month range is 1..12"],
  ["2026-02-30T00:00:00Z", "READ: day range is bounded by the month's length"],
  ["2027-02-29T00:00:00Z", "READ: 2027 is not a leap year"],
  ["2026-09-22T10:00:00.Z", "READ: int('') raises, so a fraction separator with no digits behind it is malformed"],
  ["2026-09-22T10.Z", "READ: an empty fraction is malformed in the new position too"],
  ["2026-09-22T10:00.Z", "READ: and after the minutes"],
  ["2026-09-22T10:0.5Z", "C: parse_digits still wants two digits per component; the fraction rule does not relax that"],
  [
    "2026-09-22T",
    "C: a separator with no time behind it is malformed. Pure Python reads this as midnight, " +
      "which invents an instant that outranks every real timestamp from the day before",
  ],
  ["2026-W39-2T", "C: the same refusal on a week date"],
  ["2026-09-22TZ", "C: `Z` becomes `+00:00` before parsing, and an offset is not a time"],
  ["2026-09-22T10:00:00.12a456Z", "READ: the parsed six digits must be digits"],
  ["2026-09-22T10:00:00.1234567a9Z", "READ: the truncated remainder must be digits too"],
  ["2026-09-22T10:00:00z", "READ: `tstr[-1] == 'Z'` and `value.endswith('Z')` are both uppercase-only"],
  ["2026-09-22T1:00:00Z", "READ: every time component is exactly two digits"],
  ["2026-09-2210:00:00Z", "READ: the character at the separator index is consumed, and `0:00:00` is not a time"],
  ["2026-W54-1", "READ: _isoweek_to_gregorian refuses a week above 53"],
  ["2025-W53-1", "READ: 2025 starts on a Wednesday and is not a leap year, so it has 52 weeks"],
  ["2026-W39-8", "READ: the weekday range is 1..7"],
  ["9999-W52-7T23:59:59Z", "READ: that week date lands in year 10000, past MAXYEAR"],
  ["2026-09-2", "C: parse_digits wants two day digits; the pure-Python path fails its own length assert here"],
  ["2026091", "C: same, on the basic form — pure Python would read this as 2026-09-01"],
  [" 2026-09-22T10:00:00Z", "C: parse_digits refuses the leading space that int() would strip"],
  [
    "2026-09-22T10:00+05-30",
    "READ: the offset scan picks by character and not by position — the `-` wins over the earlier " +
      "`+`, and the `10:00+05` it leaves behind is not a time",
  ],
  [
    "2026-09-22T10:00Z-05",
    "READ: same order against a `Z`: the split is at the `-`, and `10:00Z` is not a time either",
  ],
  ["2026-09-22T-10:00", "READ: an offset character at index 0 leaves an empty time, which is malformed, not absent"],
];

test("the ISO grammar accepts exactly the forms datetime.fromisoformat accepts", () => {
  for (const [value, canonical, why] of ISO_ACCEPTED) {
    const parsed = parseIsoInstant(value);
    assert.ok(parsed !== null, `${value} should parse — ${why}`);
    assert.equal(parsed.micros, parseIsoInstant(canonical).micros, `${value} => ${canonical} — ${why}`);
  }
});

test("the ISO grammar refuses exactly the forms datetime.fromisoformat refuses", () => {
  for (const [value, why] of ISO_REFUSED) {
    assert.equal(parseIsoInstant(value), null, `${value} should not parse — ${why}`);
  }
});

// The HEAD movement the two repro cases below bracket: an hour after the
// report they write and an hour before the doctor output.
const EPOCH_BETWEEN_REPRO_ARTIFACTS = 1790074800; // 2026-09-22T11:00:00Z

test("a fraction past nine digits keeps the artifact in the staleness comparison", (t) => {
  // The regression this repair exists for. A ten-digit fraction was
  // unparseable, and an artifact with no parseable generated_at is simply
  // absent from the staleness map — so the report below, an hour OLDER than
  // the checkout's HEAD, was neither fresh nor stale, the doctor output alone
  // decided the aggregate, and a stale artifact was reported clean at exit 0.
  const root = tempRoot(t);
  writeReport(root, { generatedAt: "2026-09-22T10:00:00.0000010000Z" });
  writeDoctor(root, { generatedAt: "2026-09-22T12:00:00Z" });
  writeReflog(join(root, ".git"), EPOCH_BETWEEN_REPRO_ARTIFACTS);
  const { code, payload, err } = jsonFor([root, "--json"]);
  assert.equal(code, 0, err);
  assert.deepEqual(Object.keys(payload.staleness.artifacts), ["doctor", "report"]);
  assert.equal(payload.staleness.artifacts.report.generated_at, "2026-09-22T10:00:00Z");
  assert.equal(payload.staleness.artifacts.report.stale, true);
  assert.equal(payload.staleness.artifacts.doctor.stale, false);
  assert.deepEqual(payload.staleness.stale_keys, ["report"]);
  assert.equal(payload.staleness.stale, true);
  assert.equal(payload.clean, false);
});

test("a comma fraction keeps the artifact in the staleness comparison too", (t) => {
  // ISO-8601's other fraction separator, through the same path: Python takes
  // `,` wherever it takes `.`, so an artifact written that way is an instant
  // and not an absence.
  const root = tempRoot(t);
  writeReport(root, { generatedAt: "2026-09-22T10:00:00,0000010000Z" });
  writeDoctor(root, { generatedAt: "2026-09-22T12:00:00Z" });
  writeReflog(join(root, ".git"), EPOCH_BETWEEN_REPRO_ARTIFACTS);
  const payload = targetPayload(root);
  assert.equal(payload.staleness.artifacts.report.stale, true);
  assert.deepEqual(payload.staleness.stale_keys, ["report"]);
  assert.equal(payload.clean, false);
});

test("a fraction after the minutes keeps the artifact in the staleness comparison", (t) => {
  // The same class of defect as the two above, one component earlier. The C
  // accelerator starts a fraction wherever the time components stop, so
  // `10:00.5` is half a second past ten; reading that `.` as a component
  // separator made the value unparseable, and an artifact with no parseable
  // generated_at leaves the staleness map entirely — so this report, an hour
  // OLDER than the checkout's HEAD, was omitted and the run read clean.
  const root = tempRoot(t);
  writeReport(root, { generatedAt: "2026-09-22T10:00.5Z" });
  writeDoctor(root, { generatedAt: "2026-09-22T12:00:00Z" });
  writeReflog(join(root, ".git"), EPOCH_BETWEEN_REPRO_ARTIFACTS);
  const { code, payload, err } = jsonFor([root, "--json"]);
  assert.equal(code, 0, err);
  assert.deepEqual(Object.keys(payload.staleness.artifacts), ["doctor", "report"]);
  assert.equal(payload.staleness.artifacts.report.generated_at, "2026-09-22T10:00:00Z");
  assert.equal(payload.staleness.artifacts.report.stale, true);
  assert.deepEqual(payload.staleness.stale_keys, ["report"]);
  assert.equal(payload.staleness.stale, true);
  assert.equal(payload.clean, false);
});

test("a fraction after the hours keeps the artifact in the staleness comparison", (t) => {
  // The shortest form of the same rule: minutes and seconds are optional, and
  // a fraction may follow what is left.
  const root = tempRoot(t);
  writeReport(root, { generatedAt: "2026-09-22T10.5Z" });
  writeDoctor(root, { generatedAt: "2026-09-22T12:00:00Z" });
  writeReflog(join(root, ".git"), EPOCH_BETWEEN_REPRO_ARTIFACTS);
  const { code, payload, err } = jsonFor([root, "--json"]);
  assert.equal(code, 0, err);
  assert.equal(payload.staleness.artifacts.report.generated_at, "2026-09-22T10:00:00Z");
  assert.equal(payload.staleness.artifacts.report.stale, true);
  assert.equal(payload.staleness.stale, true);
  assert.equal(payload.clean, false);
});

test("an astral date/time separator keeps the artifact in the staleness comparison", (t) => {
  // The separator's identity is never checked, only its position, and it is
  // one Unicode CHARACTER. Skipping one UTF-16 code unit left the trailing
  // half of the surrogate pair in front of the time, which made a timestamp
  // Python reads perfectly well unparseable here — and dropped its artifact
  // out of the comparison, reporting a stale report as clean.
  const root = tempRoot(t);
  writeReport(root, { generatedAt: "2026-09-22\u{1F600}10:00:00Z" });
  writeDoctor(root, { generatedAt: "2026-09-22T12:00:00Z" });
  writeReflog(join(root, ".git"), EPOCH_BETWEEN_REPRO_ARTIFACTS);
  const { code, payload, err } = jsonFor([root, "--json"]);
  assert.equal(code, 0, err);
  assert.deepEqual(Object.keys(payload.staleness.artifacts), ["doctor", "report"]);
  assert.equal(payload.staleness.artifacts.report.generated_at, "2026-09-22T10:00:00Z");
  assert.equal(payload.staleness.artifacts.report.stale, true);
  assert.deepEqual(payload.staleness.stale_keys, ["report"]);
  assert.equal(payload.clean, false);
});

test("a one-code-unit separator outside ASCII is read the same way", (t) => {
  // The bound on the case above: the repair is about counting code points, not
  // about widening or narrowing which characters may separate a date from a
  // time. A BMP separator was always accepted and still is.
  const root = tempRoot(t);
  writeReport(root, { generatedAt: "2026-09-22é10:00:00Z" });
  writeDoctor(root, { generatedAt: "2026-09-22T12:00:00Z" });
  writeReflog(join(root, ".git"), EPOCH_BETWEEN_REPRO_ARTIFACTS);
  const { code, payload, err } = jsonFor([root, "--json"]);
  assert.equal(code, 0, err);
  assert.equal(payload.staleness.artifacts.report.generated_at, "2026-09-22T10:00:00Z");
  assert.equal(payload.staleness.artifacts.report.stale, true);
});

test("a packet dated with a separator and no time refuses instead of beating a real packet", (t) => {
  // `2026-09-22T` is a date whose time was started and never written. Reading
  // it as that day's midnight — which is what the pure-Python reference does —
  // made it outrank a packet genuinely generated the day before, and the
  // readback silently projected the truncated one. The accelerator calls the
  // value malformed, which makes this an unknown candidate: freshness cannot
  // order the two, so the run is a refusal that names both files.
  const root = tempRoot(t);
  writePacket(root, "campaign-runtime.build.json", "2026-09-21T12:00:00Z", "dated-k1l2");
  writePacket(root, "campaign-runtime-truncated.build.json", "2026-09-22T", "truncated-m3n4");
  const { code, out, err } = runMain([root, "--json"]);
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.ok(err.includes("no parseable generated_at"), err);
  assert.ok(err.includes("campaign-runtime-truncated.build.json"), err);
  assert.ok(err.includes("Pass --packet"), err);
});

test("a bare date with no separator at all is still that day's midnight", (t) => {
  // The bound on the case above: a date-only generated_at was never malformed
  // and is not now. The refusal is about a separator with nothing behind it.
  const root = tempRoot(t);
  writePacket(root, "campaign-runtime.build.json", "2026-09-21T12:00:00Z", "dated-o5p6");
  writePacket(root, "campaign-runtime-dateonly.build.json", "2026-09-22", "dateonly-q7r8");
  const { code, payload, err } = jsonFor([root, "--json"]);
  assert.equal(code, 0, err);
  assert.equal(payload.packet_selection.signal, "generated_at");
  assert.equal(payload.packet_selection.selected, "campaign-runtime-dateonly.build.json");
});

test("a sub-second-only offset is UTC and does not reorder two packets", (t) => {
  // `+00:00:00.5` has a whole-second part of zero, and the C accelerator's UTC
  // special case converts the offset to whole seconds before testing it: the
  // packet below is 10:00:00Z exactly, which is the NEWER of the two. Carrying
  // the discarded half-second pushed it back to 09:59:59.5Z, behind its
  // sibling, and the readback projected the wrong run's packet.
  const root = tempRoot(t);
  writePacket(root, "campaign-runtime.build.json", "2026-09-22T10:00:00+00:00:00.5", "utc-offset-s9t0");
  writePacket(root, "campaign-runtime-earlier.build.json", "2026-09-22T09:59:59.75Z", "earlier-u1v2");
  const { code, payload, err } = jsonFor([root, "--json"]);
  assert.equal(code, 0, err);
  assert.equal(payload.packet_selection.signal, "generated_at");
  assert.equal(payload.packet_selection.selected, "campaign-runtime.build.json");
  assert.ok(runMain([root]).out.includes("map_id = utc-offset-s9t0"));
});

test("a sub-second-only offset parses to the same instant as Z", () => {
  // The rule the selection above rests on, stated directly, with its bound: a
  // zero whole-second offset is UTC whatever its fraction, while an offset
  // whose whole-second part is non-zero keeps the fraction.
  const micros = (value) => parseIsoInstant(value).micros;
  assert.equal(micros("2026-09-22T10:00:00+00:00:00.5"), micros("2026-09-22T10:00:00Z"));
  assert.equal(micros("2026-09-22T10:00:00-00:00:00.5"), micros("2026-09-22T10:00:00Z"));
  assert.equal(micros("2026-09-22T10:00:00+00:00.5"), micros("2026-09-22T10:00:00Z"));
  assert.equal(micros("2026-09-22T10:00:00+00.5"), micros("2026-09-22T10:00:00Z"));
  assert.equal(
    micros("2026-09-22T10:00:00+00:00:01.5") - micros("2026-09-22T10:00:00Z"),
    -1_500_000n,
  );
});

test("a BOM-prefixed packet is rejected, not selected over its valid sibling", (t) => {
  // The Python reader decodes with plain utf-8, which keeps a byte order mark
  // as a character, and `json.loads` refuses the value outright. A TextDecoder
  // that strips the BOM instead made this newer packet parse, which made it a
  // discovery candidate and won it the selection — the readback projected a
  // file the Python readback calls unreadable. Discovery now records it as a
  // rejected candidate and projects the valid sibling.
  const root = tempRoot(t);
  writePacket(root, "campaign-runtime.build.json", "2026-09-22T09:00:00Z", "valid-w3x4");
  writePacket(root, "campaign-runtime-bom.build.json", "2026-09-22T12:00:00Z", "bom-y5z6");
  const bomPath = join(root, "campaign-runtime-bom.build.json");
  writeFileSync(bomPath, `﻿${readFileSync(bomPath, "utf8")}`, "utf8");
  const { code, payload, err } = jsonFor([root, "--json"]);
  assert.equal(code, 0, err);
  assert.equal(payload.packet_selection.signal, "sole_candidate");
  assert.equal(payload.packet_selection.selected, "campaign-runtime.build.json");
  assert.deepEqual(payload.packet_selection.candidates_considered, ["campaign-runtime.build.json"]);
  const rejected = payload.packet_selection.rejected;
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].path, "campaign-runtime-bom.build.json");
  assert.ok(rejected[0].reason.startsWith("invalid JSON"), rejected[0].reason);
  assert.ok(runMain([root]).out.includes("map_id = valid-w3x4"));
});

test("a packet candidate whose offset overshoots 24 hours refuses instead of selecting", (t) => {
  // Python cannot parse +25:00 at all, so this candidate carries no readable
  // instant and freshness cannot order the two. Accepting it as a 25-hour
  // shift turned a contracted refusal into a silent choice between packets.
  const root = tempRoot(t);
  writePacket(root, "campaign-runtime.build.json", "2026-09-22T12:00:00Z", "bounded-a1b2");
  writePacket(root, "campaign-runtime-overshifted.build.json", "2026-09-22T10:00:00+25:00", "overshifted-c3d4");
  const { code, out, err } = runMain([root, "--json"]);
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.ok(err.includes("no parseable generated_at"), err);
  assert.ok(err.includes("campaign-runtime-overshifted.build.json"), err);
  assert.ok(err.includes("Pass --packet"), err);
});

test("a packet candidate at the largest offset Python takes still selects", (t) => {
  // The bound on the case above: the refusal is about an offset Python cannot
  // parse, not about offsets. 23:00 is inside timezone()'s range, so this
  // candidate is an instant — and the newer one, which is what selects it.
  const root = tempRoot(t);
  writePacket(root, "campaign-runtime.build.json", "2026-09-22T12:00:00Z", "bounded-e5f6");
  writePacket(root, "campaign-runtime-shifted.build.json", "2026-09-23T12:00:00+23:00", "shifted-g7h8");
  const { code, payload, err } = jsonFor([root, "--json"]);
  assert.equal(code, 0, err);
  assert.equal(payload.packet_selection.signal, "generated_at");
  assert.equal(payload.packet_selection.selected, "campaign-runtime-shifted.build.json");
});

test("serializeStaleness renders every instant through formatUtc", (t) => {
  const root = mixedAgeTarget(t);
  const { views } = projectTarget(root);
  const serialized = serializeStaleness(assessStaleness(root, views));
  for (const entry of Object.values(serialized.artifacts)) {
    assert.match(entry.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }
  assert.match(serialized.head_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

// ---------------------------------------------------------------------------
// The published schema is a gate, not a document
//
// schemas/campaigns-os-readback.v2.schema.json is hashed into the supported
// surface, but a hash only says the FILE changed. Nothing bound the emitter to
// it, so a field added, renamed or dropped in buildJsonPayload would have
// shipped as a silent v2 break with the schema still passing its own checksum.
// These cases compile the published file with the repository's own ajv and put
// the live payloads through it, including the two the unknown-age rule added.
// ---------------------------------------------------------------------------

const validateReadbackSchema = new Ajv2020({ strict: true, allErrors: true }).compile(
  JSON.parse(readFileSync(join(ROOT, "schemas/campaigns-os-readback.v2.schema.json"), "utf8")),
);

/** Assert one payload against the published schema, naming every error. */
function assertMatchesSchema(payload, label) {
  const valid = validateReadbackSchema(payload);
  assert.ok(valid, `${label}: ${JSON.stringify(validateReadbackSchema.errors, null, 2)}`);
}

test("the --example payload validates against the published v2 schema", () => {
  const { code, payload, err } = jsonFor(["--example", "--json"]);
  assert.equal(code, 0, err);
  assertMatchesSchema(payload, "--example --json");
});

test("a mixed-age payload validates against the published v2 schema", (t) => {
  // Every staleness field populated: a computable comparison, one stale key,
  // per-artifact verdicts and a head_time.
  const payload = targetPayload(mixedAgeTarget(t));
  assert.equal(payload.staleness.stale, true);
  assertMatchesSchema(payload, "mixed-age target");
});

test("an unknown-age payload validates against the published v2 schema", (t) => {
  // The fields this repair added: unparseable_keys populated, and a loaded
  // artifact row carrying a detail string where v2 previously promised "".
  const payload = targetPayload(unknownAgeTarget(t, "last Tuesday"));
  assert.deepEqual(payload.staleness.unparseable_keys, ["report"]);
  assertMatchesSchema(payload, "unparseable generated_at beside a fresh sibling");
});

test("the schema is a gate: a payload missing a staleness field is refused", (t) => {
  // The negative control. Without it these cases would pass against a schema
  // that had quietly stopped requiring anything.
  const payload = targetPayload(mixedAgeTarget(t));
  for (const field of ["stale_keys", "unparseable_keys", "artifacts", "head_time"]) {
    const { [field]: _dropped, ...rest } = payload.staleness;
    assert.equal(validateReadbackSchema({ ...payload, staleness: rest }), false, field);
  }
});

test("partitionAssertions returns empty buckets with no verdict loaded", () => {
  assert.deepEqual(partitionAssertions({}), { fail: [], pass: [], skipped: [], other: [] });
  assert.deepEqual(computeSkipCascades({}), []);
  assert.deepEqual(computeDivergences({}), []);
  assert.equal(computeDoctorSummary({}).present, false);
});

// ---------------------------------------------------------------------------
// CLI integration: dispatch, exit codes, and the read-only contract
// ---------------------------------------------------------------------------

test("`campaigns-os readback --example` prints the sample through the real CLI", () => {
  const { status, stdout } = runCli(["readback", "--example"]);
  assert.equal(status, 0);
  assert.ok(stdout.includes("CAMPAIGNS OS RUN-ARTIFACT READBACK"));
  assert.ok(stdout.includes("ARTIFACTS"));
});

test("`campaigns-os readback --example --json` emits a parseable v2 payload", () => {
  const { status, stdout } = runCli(["readback", "--example", "--json"]);
  assert.equal(status, 0);
  assert.equal(JSON.parse(stdout).schema_version, "campaigns-os-readback/v2");
});

test("the CLI exits 2 for a missing target root", () => {
  const { status, stderr } = runCli(["readback", join(tmpdir(), "no-such-readback-root-cli")]);
  assert.equal(status, 2);
  assert.ok(stderr.includes("existing directory"));
});

test("readback writes nothing under the target and appends no lifecycle entry", (t) => {
  // The read-only contract, end to end: an ambient run session is open at the
  // target and a lifecycle journal is named in the environment, which together
  // are exactly the conditions under which every other command records an
  // entry. readback must leave both untouched.
  const root = tempRoot(t);
  layoutDefaultTarget(root, { epoch: EPOCH_AFTER_ARTIFACTS });
  const sessionDir = join(root, ".campaign-runtime");
  writeFileSync(
    join(sessionDir, "run-session.json"),
    JSON.stringify({
      schema_version: "campaigns-os-run-session/v0",
      run_id: "run-fixture-readback-0001",
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      lifecycle_journal: join(root, "session-lifecycle.jsonl"),
    }),
    "utf8",
  );
  const journal = join(tempRoot(t, "readback-journal-"), "lifecycle.jsonl");
  const before = treeDigest(root);
  const { status, stdout } = runCli(["readback", root, "--json"], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      CAMPAIGNS_OS_TELEMETRY: "off",
      CAMPAIGNS_OS_LIFECYCLE_LOG: journal,
    },
  });
  assert.equal(status, 0);
  assert.equal(JSON.parse(stdout).schema_version, "campaigns-os-readback/v2");
  assert.equal(treeDigest(root), before);
  assert.equal(statSync(journal, { throwIfNoEntry: false }), undefined);
});

/** An active run session at `root`, recorded as bound to `packetPath`. */
function writeRunSession(root, packetPath, runId) {
  const now = new Date().toISOString();
  mkdirSync(join(root, ".campaign-runtime"), { recursive: true });
  writeFileSync(
    join(root, ".campaign-runtime", "run-session.json"),
    JSON.stringify({
      schema_version: "campaigns-os-run-session/v0",
      run_id: runId,
      started_at: now,
      updated_at: now,
      packet: packetPath,
    }),
    "utf8",
  );
}

/** A CLI environment with no session reachable through HOME or the ambient env. */
function isolatedEnv(home) {
  return { PATH: process.env.PATH, HOME: home, CAMPAIGNS_OS_TELEMETRY: "off" };
}

test("an oversized --packet is refused by readback's own read bound, never read whole", (t) => {
  // The dispatcher used to resolve an ambient run session from --packet before
  // readback ran, and that resolution read the named file whole through
  // readJson — so a packet past readback's 32 MiB bound was already in memory
  // by the time readback's bounded reader could refuse it. Two things are
  // asserted, and the file's shape is what makes the second observable: the
  // padding keeps it VALID JSON carrying an assembly.target_repo that points
  // at a directory holding a run session bound to some OTHER packet. A reader
  // that parsed this file would resolve that target, find that session, and
  // exit 1 on the binding conflict. Exit 0 is therefore evidence the file was
  // never read past the bound, and the ReadLimitError detail is evidence the
  // refusal is readback's own rule and not a parse failure downstream.
  //
  // Written once, one byte past the bound (32 MiB + 1), rather than as a
  // sparse file: the bytes have to be real JSON for the conflict to be
  // reachable at all, which is the whole point of the case.
  const target = tempRoot(t, "readback-oversized-");
  const elsewhere = tempRoot(t, "readback-elsewhere-");
  const home = tempRoot(t, "readback-home-");
  writeRunSession(elsewhere, join(elsewhere, "campaign-runtime.build.json"), "run-fixture-elsewhere-0001");
  const head =
    '{"schema_version":"campaign-runtime-build-packet/v0","generated_at":"2026-06-23T00:00:00Z",' +
    `"assembly":{"target_repo":${JSON.stringify(elsewhere)}},"pad":"`;
  const tail = '"}';
  const oversized = join(target, "oversized.build.json");
  writeFileSync(oversized, head + "a".repeat(MAX_ARTIFACT_BYTES + 1 - head.length - tail.length) + tail, "utf8");
  assert.equal(statSync(oversized).size, MAX_ARTIFACT_BYTES + 1);

  const { status, stdout, stderr } = runCli(["readback", target, "--packet", oversized, "--json"], {
    cwd: home,
    env: isolatedEnv(home),
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(status, 0, stderr);
  assert.ok(!stderr.includes("Conflicting active run session"), stderr);
  const packetRow = JSON.parse(stdout).artifacts[0];
  assert.equal(packetRow.key, "packet");
  assert.equal(packetRow.path, oversized);
  assert.equal(packetRow.state, "unreadable");
  assert.equal(packetRow.detail, `ReadLimitError: file exceeds the ${MAX_ARTIFACT_BYTES}-byte read limit`);
});

test("--packet projects the named packet even under a session bound to another", (t) => {
  // readback's --packet names the Build Packet to PROJECT; it is not a locator
  // for a Build Packet to act on. Resolving a run session from it refused this
  // invocation with exit 1 — the identical command succeeded whenever no
  // session happened to be open — which made a read-only projection depend on
  // lifecycle state it does not touch.
  const root = tempRoot(t);
  const home = tempRoot(t, "readback-home-");
  writePacket(root, "campaign-runtime.build.json", "2026-04-01T09:00:00Z", "session-bound-a7b8");
  writePacket(root, "campaign-runtime-second.build.json", "2026-05-02T11:30:00Z", "override-c9d0");
  writeRunSession(root, join(root, "campaign-runtime.build.json"), "run-fixture-readback-0002");
  const override = join(root, "campaign-runtime-second.build.json");

  const { status, stdout, stderr } = runCli(["readback", root, "--packet", override, "--json"], {
    cwd: root,
    env: isolatedEnv(home),
  });
  assert.equal(status, 0, stderr);
  assert.ok(!stderr.includes("Conflicting active run session"), stderr);
  const payload = JSON.parse(stdout);
  assert.equal(payload.packet_selection.mode, "explicit");
  assert.equal(payload.artifacts[0].path, override);
  assert.equal(payload.artifacts[0].state, "loaded");

  const text = runCli(["readback", root, "--packet", override], { cwd: root, env: isolatedEnv(home) });
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.includes("map_id = override-c9d0"), text.stdout);
  assert.ok(!text.stdout.includes("session-bound-a7b8"));
});

test("readback is a known command and appears in help", () => {
  const { status, stdout } = runCli(["help"]);
  assert.equal(status, 0);
  assert.ok(stdout.includes("campaigns-os readback"));
});
