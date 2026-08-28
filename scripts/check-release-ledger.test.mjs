import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  LEDGER_PATH,
  LIMITS_PATH,
  POLICY_PATH,
  REASON_CODES_PATH,
  SURFACE_PATH,
  LEDGER_SCHEMA_PATH,
  ORIENTATION_SCHEMA_PATH,
  canonicalJson,
  classifyPath,
  classifyPaths,
  deriveIntroducingCommits,
  entryHash,
  evaluateLimits,
  newEntriesSince,
  parseChangelogSections,
  validateAppendOnly,
  validateConsumerDependencies,
  validateContractConsistency,
  validateLedgerStructure,
  validateTwoWayGate,
} from "./orientation-contract.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

const policy = readJson(POLICY_PATH);
const limits = readJson(LIMITS_PATH);
const reasonCodes = readJson(REASON_CODES_PATH);
const surface = readJson(SURFACE_PATH);
const ledgerSchema = readJson(LEDGER_SCHEMA_PATH);
const orientationSchema = readJson(ORIENTATION_SCHEMA_PATH);
const cases = readJson("contracts/fixtures/orientation/release-gate/cases.json");

const validateLedgerDocument = new Ajv2020({ strict: true, allErrors: true }).compile(ledgerSchema);

/* ------------------------------------------------------------------ */
/* Fixture harness                                                     */
/* ------------------------------------------------------------------ */

/**
 * Fill the content hashes a case did not author by hand. A case that wants a
 * WRONG hash sets hash_mode: "as_written" and writes it; "@computed" inside
 * such a case means "this one is honest, only the other is tampered".
 */
function materialize(testCase) {
  const caseSurface = { ...cases.default_surface, ...(testCase.surface ?? {}) };
  const changelog = testCase.changelog ?? cases.default_changelog;
  const sections = parseChangelogSections(changelog);
  const sectionById = new Map(sections.map((section) => [section.section_id, section]));
  const asWritten = testCase.hash_mode === "as_written";

  const fill = (entry) => {
    const filled = { ...entry };
    const section = sectionById.get(entry.changelog_section);
    if (!asWritten || filled.changelog_sha256 === "@computed") {
      filled.changelog_sha256 = section?.body_sha256 ?? "0".repeat(64);
    }
    if (!asWritten || filled.entry_sha256 === "@computed") {
      delete filled.entry_sha256;
      filled.entry_sha256 = entryHash(filled);
    }
    return filled;
  };

  const baseEntries = (testCase.base_entries ?? []).map(fill);
  const headEntries = (testCase.head_entries ?? [])
    .flatMap((entry) => (entry === "@base" ? baseEntries : [fill(entry)]));

  return { caseSurface, changelog, sections, baseEntries, headEntries };
}

function runGate(testCase) {
  const { caseSurface, sections, baseEntries, headEntries } = materialize(testCase);
  const ledger = { schema_version: "campaigns-os-release-ledger/v1", entries: headEntries };
  const errors = [];

  if (!validateLedgerDocument(ledger)) {
    errors.push(...validateLedgerDocument.errors.map((e) => `${LEDGER_PATH}${e.instancePath}: ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ""}`));
  }
  errors.push(...validateLedgerStructure(ledger, { policy, surface: caseSurface, sections }));
  if (testCase.base_entries) errors.push(...validateAppendOnly(baseEntries, headEntries));

  const classified = classifyPaths(testCase.changed_paths ?? [], { policy, surface: caseSurface });
  const surfaceBumped =
    !testCase.surface_version_unchanged && cases.default_base_surface_version !== caseSurface.surface_version;
  errors.push(
    ...validateTwoWayGate({
      classified,
      newEntries: newEntriesSince(baseEntries, headEntries),
      surfaceBumped,
      surfaceVersion: caseSurface.surface_version,
    }),
  );
  return errors;
}

for (const testCase of cases.cases) {
  test(`release gate fixture: ${testCase.id}`, () => {
    const errors = runGate(testCase);
    if (testCase.expect === "pass") {
      assert.deepEqual(errors, [], `expected a clean gate for ${testCase.id}`);
      return;
    }
    assert.ok(errors.length > 0, `expected ${testCase.id} to fail the gate`);
    assert.ok(
      errors.some((error) => new RegExp(testCase.expect_error_matching).test(error)),
      `expected an error matching /${testCase.expect_error_matching}/ for ${testCase.id}; got:\n  ${errors.join("\n  ")}`,
    );
  });
}

test("A1-orientation-incomplete: an uncovered agent-relevant change is the condition a consumer refuses on", () => {
  // The reason code campaigns-os owns for an incomplete release. The gate is
  // what a consumer's `orientation_incomplete` refusal is asserting about the
  // target commit, so the code and this failure are the same fact.
  const forward = runGate(cases.cases.find((c) => c.id === "agent-relevant-path-with-no-ledger-item"));
  assert.ok(forward.some((error) => /with no release-ledger change item/.test(error)));

  const backward = runGate(cases.cases.find((c) => c.id === "ledger-item-with-no-classified-path"));
  assert.ok(backward.some((error) => /did not change in this range and is not a\s+reviewed amendment/.test(error)));

  assert.equal(reasonCodes.codes.orientation_incomplete.owner, "campaigns-os");
  assert.deepEqual(reasonCodes.codes.orientation_incomplete.outcomes, ["refused"]);
});

test("release gate fixtures cover both directions and both verdicts", () => {
  const ids = cases.cases.map((testCase) => testCase.id);
  assert.equal(new Set(ids).size, ids.length, "fixture ids must be unique");
  assert.ok(cases.cases.some((c) => c.expect === "pass"), "matrix needs passing cases");
  assert.ok(cases.cases.some((c) => c.expect === "fail"), "matrix needs failing cases");
});

test("a ledger entry naming its containing commit fails schema validation, not only the structural check", () => {
  const testCase = cases.cases.find((c) => c.id === "entry-storing-a-containing-commit-oid");
  const { headEntries } = materialize(testCase);
  const ledger = { schema_version: "campaigns-os-release-ledger/v1", entries: headEntries };
  assert.equal(validateLedgerDocument(ledger), false);
  assert.ok(
    validateLedgerDocument.errors.some((error) => error.params?.additionalProperty === "introducing_commit"),
    "the schema must reject the commit property outright",
  );
});

/* ------------------------------------------------------------------ */
/* Classifier                                                          */
/* ------------------------------------------------------------------ */

test("every path tracked in this repository classifies; the classifier fails closed on anything else", () => {
  const tracked = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
  const { unclassified } = classifyPaths(tracked, { policy, surface });
  assert.deepEqual(
    unclassified,
    [],
    `these tracked paths match no rule, no supported-surface entry, and no ignore in ${POLICY_PATH}`,
  );
});

test("a path newly added to the supported surface is classified before any broad ignore prefix can swallow it", () => {
  const widened = { ...surface, named: [...surface.named, "docs/some-brand-new-contract.md"] };
  const verdict = classifyPath("docs/some-brand-new-contract.md", { policy, surface: widened });
  assert.equal(verdict.relevant, true);
  assert.equal(verdict.class, policy.derived_from_supported_surface.named_class);
  assert.equal(verdict.source, "derived_named");

  const notOnSurface = classifyPath("docs/some-brand-new-contract.md", { policy, surface });
  assert.equal(notOnSurface.relevant, false);
  assert.ok(notOnSurface.reason, "an ignored path must carry an asserted reason, never a bare omission");
});

test("the ledger and the changelog are exempt from owing change items, and say why", () => {
  for (const path of [LEDGER_PATH, "CHANGELOG.md"]) {
    const verdict = classifyPath(path, { policy, surface });
    assert.equal(verdict.relevant, false);
    assert.equal(verdict.source, "self_referential_exemption");
    assert.ok(verdict.reason.length > 0);
  }
});

/* ------------------------------------------------------------------ */
/* Bounded reads                                                       */
/* ------------------------------------------------------------------ */

const LIMIT_TO_MEASURE = {
  max_source_bytes: "source_bytes",
  max_section_count: "section_count",
  max_section_bytes: "max_observed_section_bytes",
  max_envelope_bytes: "envelope_bytes",
  max_ledger_entries: "ledger_entries",
};

const withinLimits = () =>
  Object.fromEntries(Object.entries(LIMIT_TO_MEASURE).map(([limit, measure]) => [measure, limits.limits[limit].value]));

test("orientation source exactly at every declared limit is accepted", () => {
  const result = evaluateLimits(withinLimits(), limits);
  assert.deepEqual(result.exceeded, []);
  assert.equal(result.within_limits, true);
  assert.equal(result.reason_code, null);
});

for (const [limitName, measureName] of Object.entries(LIMIT_TO_MEASURE)) {
  test(`A1-orientation-too-large: exceeding ${limitName} refuses with the declared reason code and does not truncate`, () => {
    const measured = { ...withinLimits(), [measureName]: limits.limits[limitName].value + 1 };
    const result = evaluateLimits(measured, limits);
    assert.deepEqual(result.exceeded, [limitName]);
    assert.equal(result.reason_code, limits.refusal_reason_code);
    assert.equal(result.reason_code, "orientation_too_large");
    assert.equal(result.truncated, false, "orientation refuses; it never truncates");
    assert.match(result.detail[0], new RegExp(`${limitName}: \\d+ exceeds ${limits.limits[limitName].value}`));
  });
}

test("every exceeded limit is reported, not just the first", () => {
  const measured = Object.fromEntries(
    Object.entries(LIMIT_TO_MEASURE).map(([limit, measure]) => [measure, limits.limits[limit].value + 1]),
  );
  const result = evaluateLimits(measured, limits);
  assert.deepEqual(result.exceeded.sort(), Object.keys(LIMIT_TO_MEASURE).sort());
});

test("the limit values live only in the contract file, never as literals in the implementation", () => {
  const implementation = readFileSync(join(root, "scripts/orientation-contract.mjs"), "utf8");
  for (const limit of Object.values(limits.limits)) {
    // Word-boundary match so an incidental digit run (the "256" inside
    // "sha256") is not mistaken for a smuggled limit literal.
    assert.ok(
      !new RegExp(`(?<![\\w.])${limit.value}(?![\\w.])`).test(implementation),
      `the implementation must read ${limit.value} from ${LIMITS_PATH}, not carry it as a literal`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Introducing-commit derivation                                       */
/* ------------------------------------------------------------------ */

test("introducing commits are derived from an ordinary linear history", () => {
  const history = { c1: ["RL-0001"], c2: ["RL-0001", "RL-0002"], c3: ["RL-0001", "RL-0002", "RL-0003"] };
  const derived = deriveIntroducingCommits(["c1", "c2", "c3"], (commit) => history[commit] ?? null);
  assert.deepEqual([...derived], [["RL-0001", "c1"], ["RL-0002", "c2"], ["RL-0003", "c3"]]);
});

test("a commit before the ledger existed is skipped rather than credited", () => {
  const history = { c0: null, c1: ["RL-0001"] };
  const derived = deriveIntroducingCommits(["c0", "c1"], (commit) => history[commit] ?? null);
  assert.deepEqual([...derived], [["RL-0001", "c1"]]);
});

test("a range containing several entries credits each to its own commit", () => {
  const history = { a: ["RL-0001"], b: ["RL-0001", "RL-0002", "RL-0003"] };
  const derived = deriveIntroducingCommits(["a", "b"], (commit) => history[commit] ?? null);
  assert.equal(derived.get("RL-0002"), "b");
  assert.equal(derived.get("RL-0003"), "b");
  assert.equal(derived.size, 3);
});

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" },
  });
}

test("introducing commits are derived across ordinary commits AND a merge commit in a real repository", () => {
  const work = mkdtempSync(join(tmpdir(), "campaigns-os-ledger-"));
  try {
    git(work, "init", "-q", "-b", "main", ".");
    const writeLedger = (ids) =>
      writeFileSync(
        join(work, "ledger.json"),
        JSON.stringify({ entries: ids.map((id, index) => ({ id, sequence: index + 1 })) }, null, 2),
      );

    writeLedger(["RL-0001"]);
    git(work, "add", "ledger.json");
    git(work, "commit", "-qm", "first entry");
    const first = git(work, "rev-parse", "HEAD").trim();

    git(work, "checkout", "-q", "-b", "side");
    writeLedger(["RL-0001", "RL-0002"]);
    git(work, "commit", "-qam", "side entry");
    const side = git(work, "rev-parse", "HEAD").trim();

    git(work, "checkout", "-q", "main");
    // A merge with no competing change: the entry still arrived on the side
    // commit, and that is the commit the derivation must credit.
    git(work, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    writeLedger(["RL-0001", "RL-0002", "RL-0003"]);
    git(work, "commit", "-qam", "third entry");
    const third = git(work, "rev-parse", "HEAD").trim();

    const commits = git(work, "rev-list", "--reverse", "--topo-order", "HEAD", "--", "ledger.json").split("\n").filter(Boolean);
    const derived = deriveIntroducingCommits(commits, (commit) => {
      try {
        return JSON.parse(git(work, "show", `${commit}:ledger.json`)).entries.map((entry) => entry.id);
      } catch {
        return null;
      }
    });

    assert.equal(derived.get("RL-0001"), first);
    assert.equal(derived.get("RL-0002"), side, "the side-branch commit introduced RL-0002, not the merge");
    assert.equal(derived.get("RL-0003"), third);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("an entry first assembled while resolving a merge is credited to the merge commit", () => {
  const work = mkdtempSync(join(tmpdir(), "campaigns-os-ledger-merge-"));
  try {
    git(work, "init", "-q", "-b", "main", ".");
    const writeLedger = (ids) => writeFileSync(join(work, "ledger.json"), JSON.stringify({ entries: ids.map((id) => ({ id })) }, null, 2));

    writeLedger(["RL-0001"]);
    git(work, "add", "ledger.json");
    git(work, "commit", "-qm", "base");

    git(work, "checkout", "-q", "-b", "side");
    writeLedger(["RL-0001", "RL-0002"]);
    git(work, "commit", "-qam", "side");

    git(work, "checkout", "-q", "main");
    writeLedger(["RL-0001", "RL-0003"]);
    git(work, "commit", "-qam", "main");

    try {
      git(work, "merge", "-q", "--no-ff", "-m", "merge", "side");
    } catch {
      // Expected conflict: resolve it the way a human would, keeping both.
      writeLedger(["RL-0001", "RL-0002", "RL-0003", "RL-0004"]);
      git(work, "add", "ledger.json");
      git(work, "commit", "-qm", "merge with resolution");
    }
    const merge = git(work, "rev-parse", "HEAD").trim();

    const commits = git(work, "rev-list", "--reverse", "--topo-order", "HEAD", "--", "ledger.json").split("\n").filter(Boolean);
    const derived = deriveIntroducingCommits(commits, (commit) => {
      try {
        return JSON.parse(git(work, "show", `${commit}:ledger.json`)).entries.map((entry) => entry.id);
      } catch {
        return null;
      }
    });

    assert.equal(derived.get("RL-0004"), merge, "an entry that first exists at the merge is credited to the merge");
    assert.equal(derived.size, 4);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* The repository's own contract                                       */
/* ------------------------------------------------------------------ */

test("the shipped contract files agree with each other exactly", () => {
  assert.deepEqual(validateContractConsistency({ orientationSchema, ledgerSchema, policy, reasonCodes, limits }), []);
});

test("the shipped release ledger validates, is structurally intact, and links its changelog sections", () => {
  const ledger = readJson(LEDGER_PATH);
  assert.ok(validateLedgerDocument(ledger), JSON.stringify(validateLedgerDocument.errors));
  const sections = parseChangelogSections(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
  assert.deepEqual(validateLedgerStructure(ledger, { policy, surface, sections }), []);
});

test("every consumer-facing orientation artifact is on the supported surface", () => {
  const required = [
    LEDGER_PATH,
    POLICY_PATH,
    LIMITS_PATH,
    REASON_CODES_PATH,
    "CHANGELOG.md",
    "AGENTS.md",
    "docs/orientation-contract-reference.md",
    "docs/release-ledger-authoring-guide.md",
    ORIENTATION_SCHEMA_PATH,
    LEDGER_SCHEMA_PATH,
  ];
  assert.deepEqual(validateConsumerDependencies(required, surface), []);
});

test("a consumer manifest that depends on an implementation path is rejected", () => {
  const errors = validateConsumerDependencies(["src/cli.mjs", "scripts/check-release-ledger.mjs"], surface);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /src\/cli\.mjs is not on the supported surface/);
});

test("the hostile-target fixture ships every tripwire its manifest declares, with the declared mode", () => {
  const dir = "contracts/fixtures/orientation/hostile-target";
  const manifest = readJson(`${dir}/manifest.json`);
  assert.equal(manifest.expected_hit_count, 0);
  assert.ok(manifest.tripwires.length >= 4, "the fixture must carry hooks, an executable file, and lifecycle scripts");

  const kinds = new Set(manifest.tripwires.map((tripwire) => tripwire.kind));
  for (const kind of ["git_hook", "executable_file", "package_lifecycle_script"]) {
    assert.ok(kinds.has(kind), `the fixture must carry a ${kind} tripwire`);
  }

  for (const tripwire of manifest.tripwires) {
    const stats = statSync(join(root, dir, tripwire.path));
    assert.equal(
      (stats.mode & 0o777).toString(8),
      tripwire.mode,
      `${tripwire.path} is mode ${(stats.mode & 0o777).toString(8)} but the manifest declares ${tripwire.mode}`,
    );
  }
  for (const path of Object.values(manifest.orientation_data)) {
    assert.ok(statSync(join(root, dir, path)).isFile(), `${path} is missing from the fixture`);
  }

  // The npm lifecycle tripwires only trip something if they are really there.
  const fixturePackage = readJson(`${dir}/repo/package.json`);
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare", "prepack"]) {
    assert.ok(fixturePackage.scripts[lifecycle], `the fixture package must declare a ${lifecycle} script`);
  }

  // Every named tripwire path is supported surface, so a consumer's
  // no-execution test can depend on it existing.
  assert.deepEqual(
    validateConsumerDependencies(
      [`${dir}/manifest.json`, ...manifest.tripwires.map((t) => `${dir}/${t.path}`)],
      surface,
    ),
    [],
  );
});

test("the hostile fixture's own orientation data parses, so a zero hit count means the read actually completed", () => {
  const dir = "contracts/fixtures/orientation/hostile-target/repo";
  const fixtureLedger = readJson(`${dir}/contracts/release-ledger.json`);
  const fixtureSurface = readJson(`${dir}/contracts/supported-surface.json`);
  const sections = parseChangelogSections(readFileSync(join(root, dir, "CHANGELOG.md"), "utf8"));
  assert.ok(validateLedgerDocument(fixtureLedger), JSON.stringify(validateLedgerDocument.errors));
  assert.deepEqual(validateLedgerStructure(fixtureLedger, { policy, surface: fixtureSurface, sections }), []);
  assert.equal(fixtureLedger.entries.length, 2, "a multi-entry window is what makes the fixture worth reading");
});

test("canonical JSON is key-order independent, so reformatting an entry is not mistaken for tampering", () => {
  const a = { b: 1, a: [1, { y: 2, x: 3 }] };
  const b = { a: [1, { x: 3, y: 2 }], b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(entryHash({ ...a, entry_sha256: "ignored" }), entryHash(b));
});
