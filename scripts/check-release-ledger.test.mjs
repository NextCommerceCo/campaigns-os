import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  LIMIT_MEASUREMENTS,
  ORIENTATION_SOURCE_PATHS,
  canonicalJson,
  classifyPath,
  classifyPaths,
  deriveIntroducingCommits,
  entryHash,
  evaluateBaselineFloor,
  evaluateLimits,
  loadArchive,
  newEntriesSince,
  parseChangelogSections,
  rotateLedger,
  sha256Hex,
  validateAppendOnly,
  validateConsumerDependencies,
  validateContractConsistency,
  validateLedgerStructure,
  validateTwoWayGate,
} from "./orientation-contract.mjs";
import { measureRepositorySource, unionSurface, validateSectionHistory } from "./check-release-ledger.mjs";
import { collectSectionIds } from "./check-changelog-structure.mjs";

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
  const newEntries = newEntriesSince(baseEntries, headEntries);

  if (!validateLedgerDocument(ledger)) {
    errors.push(...validateLedgerDocument.errors.map((e) => `${LEDGER_PATH}${e.instancePath}: ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ""}`));
  }
  errors.push(
    ...validateLedgerStructure(ledger, {
      policy,
      surface: caseSurface,
      sections,
      // Same scoping the real checker uses: only entries new in the range are
      // classified against the current policy and surface. A case with no
      // base_entries has nothing historical, so every entry is classified.
      classifiableEntryIds: new Set(newEntries.map((entry) => entry.id)),
    }),
  );
  if (testCase.base_entries) errors.push(...validateAppendOnly(baseEntries, headEntries));

  const classified = classifyPaths(testCase.changed_paths ?? [], { policy, surface: caseSurface });
  const surfaceBumped =
    !testCase.surface_version_unchanged && cases.default_base_surface_version !== caseSurface.surface_version;
  errors.push(
    ...validateTwoWayGate({
      classified,
      newEntries,
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
    validateLedgerDocument.errors.some(
      (error) =>
        error.instancePath === "/entries/0/introducing_commit" &&
        error.keyword === "false schema",
    ),
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

test("a rename of a supported path arrives as BOTH a delete and an add, so neither half escapes the gate", () => {
  // Git's default rename detection reports only the destination. Under it,
  // `git mv AGENTS.md docs/notes-archive.md` looks like one unclassified new
  // path and the disappearance of a named supported-surface entry is invisible.
  // The gate passes --no-renames for exactly this reason; this test fails if
  // that flag is ever dropped from the invocation.
  const work = mkdtempSync(join(tmpdir(), "campaigns-os-rename-"));
  try {
    git(work, "init", "-q", "-b", "main", ".");
    writeFileSync(join(work, "AGENTS.md"), "# entry point\n");
    git(work, "add", "AGENTS.md");
    git(work, "commit", "-qm", "add the agent entry point");
    const base = git(work, "rev-parse", "HEAD").trim();

    mkdirSync(join(work, "docs"), { recursive: true });
    git(work, "mv", "AGENTS.md", "docs/notes-archive.md");
    git(work, "commit", "-qm", "rename it away");

    const withDetection = git(work, "diff", "--name-only", `${base}..HEAD`).split("\n").filter(Boolean);
    const withoutDetection = git(work, "diff", "-z", "--no-renames", "--name-only", `${base}..HEAD`).split("\0").filter(Boolean);

    assert.deepEqual(withDetection, ["docs/notes-archive.md"], "default detection hides the disappearance");
    assert.deepEqual(withoutDetection.sort(), ["AGENTS.md", "docs/notes-archive.md"]);

    // And the half default detection hides is the agent-relevant one.
    const { relevant } = classifyPaths(withoutDetection, { policy, surface });
    assert.ok(relevant.some((item) => item.path === "AGENTS.md"), "the removed named surface entry must classify as agent-relevant");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a path removed from the supported surface still classifies, because the union of base and head is what gets classified", () => {
  // Deleting a named path AND its manifest entry in one change would, against
  // the head manifest alone, fall into a broad ignore prefix — a consumer's
  // pinned path disappearing in silence. The union classifies the removal as
  // what it is.
  const removed = "docs/build-packet.md";
  const baseSurface = { ...surface, named: [...surface.named, removed] };
  const headSurface = { ...surface, named: surface.named.filter((path) => path !== removed) };

  const againstHead = classifyPath(removed, { policy, surface: headSurface });
  assert.equal(againstHead.relevant, false, "the head manifest alone loses the removal");

  const againstUnion = classifyPath(removed, { policy, surface: unionSurface(baseSurface, headSurface) });
  assert.equal(againstUnion.relevant, true);
  assert.equal(againstUnion.class, policy.derived_from_supported_surface.named_class);
});

test("the union keeps every declared surface list, not only the named one", () => {
  const merged = unionSurface(
    { hashed: { "schemas/gone.v0.schema.json": { sha256: "a" } }, named: ["docs/gone.md"], cli_commands: ["retired"], package_exports: ["./gone"], bin: ["gone"] },
    surface,
  );
  assert.ok("schemas/gone.v0.schema.json" in merged.hashed);
  for (const [key, value] of [["named", "docs/gone.md"], ["cli_commands", "retired"], ["package_exports", "./gone"], ["bin", "gone"]]) {
    assert.ok(merged[key].includes(value), `${key} lost its base-side entry`);
    assert.ok(merged[key].length > 1, `${key} lost its head-side entries`);
  }
  assert.equal(merged.surface_version, surface.surface_version, "the head surface version is the current one");
});

/* ------------------------------------------------------------------ */
/* Bounded reads                                                       */
/* ------------------------------------------------------------------ */

// Read from the implementation's single map, never re-typed here: a second copy
// of the limit-to-measurement correspondence is exactly what the consistency
// check exists to prevent.
const LIMIT_TO_MEASURE = LIMIT_MEASUREMENTS;

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

for (const [label, broken] of [
  ["missing", undefined],
  ["null", null],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["a string", "12"],
]) {
  test(`a measurement that is ${label} counts as exceeded, because a bound nobody measured is a bound nobody enforced`, () => {
    const measured = { ...withinLimits(), source_bytes: broken };
    const result = evaluateLimits(measured, limits);
    assert.ok(result.exceeded.includes("max_source_bytes"), `expected max_source_bytes to fail closed on ${label}`);
    assert.equal(result.within_limits, false);
    assert.equal(result.reason_code, limits.refusal_reason_code);
    assert.equal(result.truncated, false);
    assert.match(result.detail.join(" "), /was not measured/);
  });
}

test("the limits contract declares exactly the bounds the implementation measures", () => {
  assert.deepEqual(Object.keys(limits.limits).sort(), Object.keys(LIMIT_MEASUREMENTS).sort());
});

test("a limit declared in the contract but measured by nothing is a consistency failure", () => {
  const widened = { ...limits, limits: { ...limits.limits, max_invented_bound: { value: 1, unit: "widgets", applies_to: "nothing", rationale: "nothing" } } };
  const errors = validateContractConsistency({ orientationSchema, ledgerSchema, policy, reasonCodes, limits: widened });
  assert.ok(errors.some((error) => /limits keys.*unexpected max_invented_bound/s.test(error)), errors.join("\n"));
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

    const commits = git(work, "rev-list", "--reverse", "--topo-order", "--full-history", "HEAD", "--", "ledger.json").split("\n").filter(Boolean);
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

    const commits = git(work, "rev-list", "--reverse", "--topo-order", "--full-history", "HEAD", "--", "ledger.json").split("\n").filter(Boolean);
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

/**
 * Mutation coverage for the consistency check. A green "everything agrees" test
 * proves nothing on its own — it also passes if the checker returns [] for a
 * contract set riddled with defects. Each case clones the SHIPPED contracts,
 * introduces exactly one defect on one branch of the checker, and asserts that
 * branch fires.
 */
const clone = (value) => JSON.parse(JSON.stringify(value));
const firstCode = () => Object.keys(reasonCodes.codes)[0];

const CONSISTENCY_MUTATIONS = [
  {
    label: "a reason code dropped from the schema's enum",
    mutate: (c) => {
      c.orientationSchema.$defs.reason_code.enum = c.orientationSchema.$defs.reason_code.enum.slice(1);
    },
    expect: /\$defs\.reason_code\.enum.*does not match its source of truth/,
  },
  {
    label: "a semantic class dropped from the ledger schema's class enum",
    mutate: (c) => {
      c.ledgerSchema.$defs.change.properties.class.enum = c.ledgerSchema.$defs.change.properties.class.enum.slice(1);
    },
    expect: /\$defs\.change\.properties\.class\.enum.*does not match its source of truth/,
  },
  {
    label: "a reason code with a blanked remedy",
    mutate: (c) => {
      c.reasonCodes.codes[firstCode()].remedy = "   ";
    },
    expect: /has no remedy/,
  },
  {
    label: "a reason code with a blanked meaning",
    mutate: (c) => {
      c.reasonCodes.codes[firstCode()].meaning = "";
    },
    expect: /has no meaning/,
  },
  {
    label: "two reason codes sharing one owning test id",
    mutate: (c) => {
      const [a, b] = Object.keys(c.reasonCodes.codes);
      c.reasonCodes.codes[b].test_id = c.reasonCodes.codes[a].test_id;
    },
    expect: /duplicate test_id values/,
  },
  {
    label: "a reason code owned by nobody this contract knows",
    mutate: (c) => {
      c.reasonCodes.codes[firstCode()].owner = "some-other-repo";
    },
    expect: /owner must be campaigns-os or campaigns-agent/,
  },
  {
    label: "a reason code naming an outcome that is not a disposition",
    mutate: (c) => {
      c.reasonCodes.codes[firstCode()].outcomes = ["not_a_disposition"];
    },
    expect: /which is not a disposition/,
  },
  {
    label: "a policy rule naming an undefined class",
    mutate: (c) => {
      c.policy.rules[0].class = "not_a_class";
    },
    expect: /names undefined class not_a_class/,
  },
  {
    label: "a derived-surface class that is not defined",
    mutate: (c) => {
      c.policy.derived_from_supported_surface.named_class = "not_a_class";
    },
    expect: /derived_from_supported_surface\.named_class names undefined class/,
  },
  {
    label: "an ignore rule with no stated reason",
    mutate: (c) => {
      c.policy.ignored[0].reason = "";
    },
    expect: /has no reason/,
  },
  {
    label: "a refusal reason code outside the vocabulary",
    mutate: (c) => {
      c.limits.refusal_reason_code = "not_a_reason_code";
    },
    expect: /refusal_reason_code not_a_reason_code is not in the reason-code vocabulary/,
  },
  {
    label: "truncation quietly permitted",
    mutate: (c) => {
      c.limits.truncation_allowed = true;
    },
    expect: /truncation_allowed must be false/,
  },
  {
    label: "a limit with no rationale",
    mutate: (c) => {
      c.limits.limits[Object.keys(c.limits.limits)[0]].rationale = "";
    },
    expect: /has no rationale/,
  },
];

for (const mutation of CONSISTENCY_MUTATIONS) {
  test(`validateContractConsistency catches ${mutation.label}`, () => {
    const contracts = clone({ orientationSchema, ledgerSchema, policy, reasonCodes, limits });
    mutation.mutate(contracts);
    const errors = validateContractConsistency(contracts);
    assert.ok(
      errors.some((error) => mutation.expect.test(error)),
      `expected an error matching ${mutation.expect} for "${mutation.label}"; got:\n  ${errors.join("\n  ") || "(none)"}`,
    );
  });
}

const readTextOrNull = (path) => {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
};

test("the shipped release ledger validates, is structurally intact, and links its changelog sections", () => {
  const ledger = readJson(LEDGER_PATH);
  assert.ok(validateLedgerDocument(ledger), JSON.stringify(validateLedgerDocument.errors));
  const sections = parseChangelogSections(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
  const { archive, errors } = loadArchive(ledger, readTextOrNull);
  assert.deepEqual(errors, []);
  for (const file of archive?.files ?? []) assert.ok(validateLedgerDocument(file.document), JSON.stringify(validateLedgerDocument.errors));
  assert.deepEqual(validateLedgerStructure(ledger, { policy, surface, sections, archive }), []);
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

test("every path the hostile fixture's manifest declares exists, and every hashed entry matches its file", () => {
  // The fixture promises a consumer that a conforming read of it COMPLETES and
  // produces a normal envelope. A declared path that is not in the tree, or a
  // recorded digest that does not match, turns that promise inside out: the
  // conforming behavior becomes refusal on integrity, and the fixture stops
  // testing the no-execution invariant it exists for. This test is what stops
  // that from happening again silently.
  const dir = "contracts/fixtures/orientation/hostile-target/repo";
  const fixtureSurface = readJson(`${dir}/contracts/supported-surface.json`);

  for (const [path, entry] of Object.entries(fixtureSurface.hashed ?? {})) {
    const bytes = readFileSync(join(root, dir, path));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      entry.sha256,
      `${dir}/${path} does not match the digest the fixture manifest records for it`,
    );
  }
  for (const path of fixtureSurface.named ?? []) {
    assert.ok(statSync(join(root, dir, path)).isFile(), `${dir}/${path} is declared by the fixture manifest but missing from the tree`);
  }

  // A file the fixture ships that its own manifest never declares is the same
  // kind of drift in the other direction.
  assert.ok(Object.keys(fixtureSurface.hashed ?? {}).length > 0, "the fixture must exercise the hashed-integrity path");
  assert.ok((fixtureSurface.named ?? []).length > 0, "the fixture must exercise the named-existence path");
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

/* ------------------------------------------------------------------ */
/* Baseline rotation                                                   */
/* ------------------------------------------------------------------ */

const ROTATION_CHANGELOG = [
  "# Changelog",
  "",
  "## [1.2.0] - 2026-02-04",
  "",
  "### Added",
  "",
  "- Fourth fixture release.",
  "",
  "## [1.1.0+agent.1] - 2026-02-03",
  "",
  "### Fixed",
  "",
  "- Third fixture change.",
  "",
  "## [1.1.0] - 2026-02-02",
  "",
  "### Added",
  "",
  "- Second fixture release.",
  "",
  "## [1.0.0] - 2026-02-01",
  "",
  "### Added",
  "",
  "- First fixture release.",
  "",
].join("\n");

function fixtureEntry(sections, { id, sequence, date, section, surfaceVersion = null, extra = {}, changes = null }) {
  const entry = {
    id,
    sequence,
    date,
    kind: "release",
    surface_version: surfaceVersion,
    changelog_section: section,
    changelog_sha256: sections.find((candidate) => candidate.section_id === section).body_sha256,
    agent_impact: `Fixture impact for ${id}.`,
    compatibility: "compatible",
    migration: "none",
    changes: changes ?? [{ class: "named_surface", path: "docs/build-packet.md", surface_entry: "docs/build-packet.md", summary: `Fixture change for ${id}.` }],
    ...extra,
  };
  return { ...entry, entry_sha256: entryHash(entry) };
}

function rotationBase(overrides = {}) {
  const changelog = overrides.changelog ?? ROTATION_CHANGELOG;
  const sections = parseChangelogSections(changelog);
  const entries = [
    fixtureEntry(sections, { id: "RL-0001", sequence: 1, date: "2026-02-01", section: "1.0.0", surfaceVersion: "1.0.0" }),
    fixtureEntry(sections, { id: "RL-0002", sequence: 2, date: "2026-02-02", section: "1.1.0", surfaceVersion: "1.1.0" }),
    fixtureEntry(sections, { id: "RL-0003", sequence: 3, date: "2026-02-03", section: "1.1.0+agent.1", ...(overrides.third ?? {}) }),
    fixtureEntry(sections, { id: "RL-0004", sequence: 4, date: "2026-02-04", section: "1.2.0", surfaceVersion: "1.2.0" }),
  ];
  return { ledger: { schema_version: "campaigns-os-release-ledger/v1", entries }, changelog, files: new Map() };
}

/** Rotate a fixture state at `cut` exactly the way a real rotation is authored. */
function rotate(state, { cut = "RL-0003", date = "2026-03-01", rotationId = "RL-0005", sectionId = "1.3.0" } = {}) {
  const ledgerArchivePath = `contracts/archive/release-ledger.${date}.json`;
  const changelogArchivePath = `contracts/archive/CHANGELOG.${date}.md`;
  const rotated = rotateLedger({
    ledger: state.ledger,
    changelogText: state.changelog,
    lastArchivedId: cut,
    ledgerArchivePath,
    changelogArchivePath,
    rotationEntryId: rotationId,
    refusalReasonCode: "baseline_below_floor",
    archiveNote: "Fixture archive.",
    changelogPreamble: "# Changelog archive",
  });
  const changelog = rotated.liveChangelogText.replace("## [", `## [${sectionId}] - ${date}\n\n### Changed\n\n- Rotate the fixture baseline.\n\n## [`);
  const sections = parseChangelogSections(changelog);
  const rotation = fixtureEntry(sections, {
    id: rotationId,
    sequence: rotated.liveLedger.entries.at(-1).sequence + 1,
    date,
    section: sectionId,
    changes: [ledgerArchivePath, changelogArchivePath].map((path) => ({ class: "named_surface", path, surface_entry: path, summary: "Archive rotated history." })),
  });
  const files = new Map([...state.files, [ledgerArchivePath, rotated.archiveLedgerText], [changelogArchivePath, rotated.archiveChangelogText]]);
  return { ledger: { ...rotated.liveLedger, entries: [...rotated.liveLedger.entries, rotation] }, changelog, files };
}

/** Everything the real checker runs over a base..head range, from fixture states. */
function rotationGate(base, head) {
  const { archive, errors } = loadArchive(head.ledger, (path) => head.files.get(path) ?? null);
  if (!validateLedgerDocument(head.ledger)) errors.push(...validateLedgerDocument.errors.map((error) => `schema ${error.instancePath} ${error.message}`));
  errors.push(
    ...validateLedgerStructure(head.ledger, {
      policy,
      surface,
      sections: parseChangelogSections(head.changelog),
      archive,
      classifiableEntryIds: new Set(),
    }),
  );
  errors.push(
    ...validateAppendOnly(base.ledger.entries, head.ledger.entries, {
      baseFloor: base.ledger.baseline_floor ?? null,
      headFloor: head.ledger.baseline_floor ?? null,
      headArchive: archive,
      baseSections: parseChangelogSections(base.changelog),
      existedAtBase: (path) => base.files.has(path),
    }),
  );
  const baseSectionIds = collectSectionIds(base.changelog, base.ledger, (path) => base.files.get(path) ?? null);
  errors.push(...validateSectionHistory(baseSectionIds, parseChangelogSections(head.changelog), archive));
  return errors;
}

/** Rewrite an archive file and re-record its hash in the floor, so only the identity checks can catch it. */
function tamperArchive(state, path, edit, { rehash = true } = {}) {
  const files = new Map(state.files);
  files.set(path, edit(files.get(path)));
  const floor = structuredClone(state.ledger.baseline_floor);
  if (rehash) {
    for (const record of floor.archives) {
      if (record.ledger_path === path) record.ledger_sha256 = sha256Hex(files.get(path));
      if (record.changelog_path === path) record.changelog_sha256 = sha256Hex(files.get(path));
    }
  }
  return { ...state, ledger: { ...state.ledger, baseline_floor: floor }, files };
}

const expectError = (errors, pattern) =>
  assert.ok(errors.some((error) => pattern.test(error)), `expected an error matching ${pattern}; got:\n  ${errors.join("\n  ") || "(none)"}`);

test("a baseline rotation moves entries and the changelog tail byte-for-byte and passes every gate, twice", () => {
  const base = rotationBase();
  const head = rotate(base);
  assert.deepEqual(rotationGate(base, head), []);

  const floor = head.ledger.baseline_floor;
  assert.equal(floor.last_archived_id, "RL-0003");
  assert.equal(floor.last_archived_sequence, 3);
  assert.equal(floor.first_kept_id, "RL-0004");
  assert.equal(head.ledger.entries[0].sequence, 4, "nothing is renumbered: the live file starts at floor + 1");
  const archived = JSON.parse(head.files.get(floor.archives[0].ledger_path)).entries;
  assert.deepEqual(archived.map(canonicalJson), base.ledger.entries.slice(0, 3).map(canonicalJson));
  const archiveText = head.files.get(floor.archives[0].changelog_path);
  assert.deepEqual(parseChangelogSections(archiveText).map((section) => section.section_id), ["1.1.0+agent.1", "1.1.0", "1.0.0"]);
  assert.ok(base.changelog.endsWith(archiveText.slice(archiveText.indexOf("## ["))), "the archive changelog is the base file's tail, verbatim");
  assert.deepEqual(parseChangelogSections(head.changelog).map((section) => section.section_id), ["1.3.0", "1.2.0"]);
  assert.ok(Object.prototype.hasOwnProperty.call(reasonCodes.codes, floor.refusal_reason_code));

  // A second rotation appends a new dated pair and leaves the first untouched.
  const second = rotate(head, { cut: "RL-0004", date: "2026-04-01", rotationId: "RL-0006", sectionId: "1.4.0" });
  assert.deepEqual(rotationGate(head, second), []);
  assert.equal(second.ledger.baseline_floor.archives.length, 2);
  assert.deepEqual(second.ledger.baseline_floor.archives[0], floor.archives[0]);
  assert.equal(second.files.get(floor.archives[0].ledger_path), head.files.get(floor.archives[0].ledger_path));
});

test("deleting entries without a floor and an archive that holds them still fails", () => {
  const base = rotationBase();
  const bare = { ...base, ledger: { ...base.ledger, entries: base.ledger.entries.slice(2) } };
  expectError(rotationGate(base, bare), /RL-0001: historical entry was deleted — the ledger is append-only/);

  // A floor that claims the entries while the archive does not hold one of them.
  const head = rotate(base);
  const archivePath = head.ledger.baseline_floor.archives[0].ledger_path;
  const dropped = tamperArchive(head, archivePath, (text) => {
    const document = JSON.parse(text);
    document.entries = document.entries.slice(1);
    return `${JSON.stringify(document, null, 2)}\n`;
  });
  expectError(rotationGate(base, dropped), /RL-0001: historical entry was deleted — the floor covers it but no archive file holds it/);
});

test("an archived copy that differs from the base entry fails, even with its own hashes recomputed", () => {
  const base = rotationBase();
  const head = rotate(base);
  const archivePath = head.ledger.baseline_floor.archives[0].ledger_path;
  const rewritten = tamperArchive(head, archivePath, (text) => {
    const document = JSON.parse(text);
    const { entry_sha256: _drop, ...entry } = { ...document.entries[0], agent_impact: "Quietly rewritten history." };
    document.entries[0] = { ...entry, entry_sha256: entryHash(entry) };
    return `${JSON.stringify(document, null, 2)}\n`;
  });
  const errors = rotationGate(base, rewritten);
  expectError(errors, /RL-0001: archived copy differs from the base entry/);
  expectError(errors, /RL-0001: historical entry was deleted — its archived copy differs from the base entry/);
});

test("a floor moved without a new rotation entry fails, and so does a floor removed or rewritten in place", () => {
  const base = rotationBase();
  const head = rotate(base);

  const oldEntryAsRotation = { ...head, ledger: { ...head.ledger, baseline_floor: { ...head.ledger.baseline_floor, rotation_entry: "RL-0004" } } };
  expectError(rotationGate(base, oldEntryAsRotation), /floor moved to RL-0003 without a new rotation entry/);

  const noRotationEntry = { ...head, ledger: { ...head.ledger, entries: head.ledger.entries.slice(0, -1) } };
  const errors = rotationGate(base, noRotationEntry);
  expectError(errors, /without a new rotation entry/);
  expectError(errors, /rotation_entry "RL-0005" names no live entry/);

  const removed = { ...head, ledger: { schema_version: head.ledger.schema_version, entries: head.ledger.entries } };
  expectError(rotationGate(head, removed), /the floor was removed/);

  const rewritten = { ...head, ledger: { ...head.ledger, baseline_floor: { ...head.ledger.baseline_floor, refusal_reason_code: "history_incomplete" } } };
  expectError(rotationGate(head, rewritten), /the floor was rewritten without moving/);
});

test("an existing archive file never changes: not in place, not re-hashed, not rewritten by a later rotation", () => {
  const base = rotationBase();
  const head = rotate(base);
  const changelogPath = head.ledger.baseline_floor.archives[0].changelog_path;
  const append = (text) => text.replace("- First fixture release.", "- First fixture release, amended later.");

  expectError(rotationGate(head, tamperArchive(head, changelogPath, append, { rehash: false })), /CHANGELOG\.2026-03-01\.md does not match its recorded sha256/);
  const rehashed = rotationGate(head, tamperArchive(head, changelogPath, append));
  expectError(rehashed, /archive record "contracts\/archive\/release-ledger\.2026-03-01\.json" changed or moved/);
  expectError(rehashed, /RL-0001: changelog_sha256 does not match the body of contracts\/archive\/CHANGELOG\.2026-03-01\.md/);

  // A second rotation that reuses the first one's dated path overwrites it.
  const reused = rotate(head, { cut: "RL-0004", date: "2026-03-01", rotationId: "RL-0006", sectionId: "1.4.0" });
  expectError(rotationGate(head, reused), /2026-03-01\.json already existed at base/);
});

test("archived entries' changelog hashes verify against the archive changelog, in the fixture and in the shipped archive", () => {
  const base = rotationBase();
  const head = rotate(base);
  const changelogPath = head.ledger.baseline_floor.archives[0].changelog_path;
  const errors = rotationGate(base, tamperArchive(head, changelogPath, (text) => text.replace("- Second fixture release.", "- Second fixture release, edited.")));
  expectError(errors, /RL-0002: changelog_sha256 does not match the body of contracts\/archive\/CHANGELOG\.2026-03-01\.md section "1\.1\.0"/);
  expectError(errors, /section "1\.1\.0" differs from the base CHANGELOG\.md/);

  const ledger = readJson(LEDGER_PATH);
  const { archive } = loadArchive(ledger, readTextOrNull);
  assert.ok(archive, "the shipped ledger declares a floor with a loadable archive");
  const archiveSections = new Map(archive.sections.map((section) => [section.section_id, section]));
  const liveSectionIds = new Set(parseChangelogSections(readFileSync(join(root, "CHANGELOG.md"), "utf8")).map((section) => section.section_id));
  const supersededBySameSection = new Set(
    archive.entries.map((row) => row.entry).filter((entry) => entry.kind === "amendment").map((entry) => `${entry.amends}|${entry.changelog_section}`),
  );
  for (const { entry } of archive.entries) {
    assert.ok(!liveSectionIds.has(entry.changelog_section), `${entry.changelog_section} must live only in the archive`);
    const section = archiveSections.get(entry.changelog_section);
    assert.ok(section, `${entry.id} links ${entry.changelog_section}, which the archive changelog must hold`);
    if (!supersededBySameSection.has(`${entry.id}|${entry.changelog_section}`)) assert.equal(section.body_sha256, entry.changelog_sha256, entry.id);
  }
});

test("source_bytes after rotation measures the mandatory reads only, never the archive", () => {
  const ledger = readJson(LEDGER_PATH);
  const archivePaths = ledger.baseline_floor.archives.flatMap((record) => [record.ledger_path, record.changelog_path]);
  for (const path of archivePaths) assert.ok(!ORIENTATION_SOURCE_PATHS.includes(path), `${path} must not be a mandatory read`);

  const bytes = (path) => readFileSync(join(root, path)).byteLength;
  const measured = measureRepositorySource();
  assert.equal(measured.source_bytes, ORIENTATION_SOURCE_PATHS.reduce((total, path) => total + bytes(path), 0));
  assert.equal(measured.ledger_entries, ledger.entries.length);
  assert.equal(measured.section_count, parseChangelogSections(readFileSync(join(root, "CHANGELOG.md"), "utf8")).length);
  assert.ok(evaluateLimits(measured, limits).within_limits, "the live orientation source fits the unchanged limits");
  const withArchive = measured.source_bytes + archivePaths.reduce((total, path) => total + bytes(path), 0);
  assert.ok(withArchive > limits.limits.max_source_bytes.value, "the archive is what would not have fit");

  // The gate reports the figure it enforced; it must be this same measurement.
  const output = execFileSync(process.execPath, [join(root, "scripts/check-release-ledger.mjs")], { encoding: "utf8" });
  const reported = output.match(/(\d+) source bytes within limits/);
  assert.ok(reported, `the gate reports its source bytes: ${output}`);
  assert.equal(Number(reported[1]), measured.source_bytes, "the gate measures source_bytes with measureRepositorySource");
});

test("A1-baseline-below-floor: a reviewed baseline older than the floor refuses with the floor's code and a newer-baseline remedy", () => {
  const floor = readJson(LEDGER_PATH).baseline_floor;
  const definition = reasonCodes.codes[floor.refusal_reason_code];
  assert.equal(definition.owner, "campaigns-os");
  assert.deepEqual(definition.outcomes, ["refused"]);
  assert.match(definition.remedy, /^Adopt a newer reviewed baseline/);

  const below = evaluateBaselineFloor(floor, floor.last_archived_sequence - 1);
  assert.equal(below.within_floor, false);
  assert.equal(below.reason_code, floor.refusal_reason_code);
  assert.match(below.detail, new RegExp(`adopt a newer reviewed baseline.*${floor.first_kept_id}`));
  for (const unmeasured of [undefined, null, Number.NaN, "124"]) assert.equal(evaluateBaselineFloor(floor, unmeasured).within_floor, false);

  assert.equal(evaluateBaselineFloor(floor, floor.last_archived_sequence).within_floor, true, "a window starting at the first kept entry reads from the live ledger");
  assert.equal(evaluateBaselineFloor(floor, readJson(LEDGER_PATH).entries.at(-1).sequence).within_floor, true);
  assert.equal(evaluateBaselineFloor(null, 1).within_floor, true);
});

test("a rotation refuses to split an amendment from the entry it amends, or a section from its entries", () => {
  const amendment = rotationBase({ third: { extra: { kind: "amendment", amends: "RL-0002", amendment_reason: "Fixture correction." } } });
  assert.throws(() => rotate(amendment, { cut: "RL-0002" }), /would split a pair \(RL-0003 amends archived RL-0002; .*\); move the cut earlier/);

  const relink = rotationBase({ third: { section: "1.1.0", extra: { kind: "amendment", amends: "RL-0002", amendment_reason: "Fixture re-hash." } } });
  assert.throws(() => rotate(relink, { cut: "RL-0002" }), /RL-0003 links archived section 1\.1\.0\b/);
});

test("a hand-authored rotation that archives an entry a kept base entry amends fails the gate with the helper's message", () => {
  const base = rotationBase({ third: { extra: { kind: "amendment", amends: "RL-0001", amendment_reason: "Fixture correction." } } });
  const refusal = "rotation at RL-0001 would split a pair (RL-0003 amends archived RL-0001); move the cut earlier";
  assert.throws(() => rotate(base, { cut: "RL-0001" }), { message: refusal });

  // The same cut written by hand: rotate with the amendment disguised, then put
  // the unchanged historical RL-0003 back in the live ledger.
  const original = base.ledger.entries.find((entry) => entry.id === "RL-0003");
  const disguised = { ...base, ledger: { ...base.ledger, entries: base.ledger.entries.map((entry) => (entry === original ? { ...entry, kind: "release" } : entry)) } };
  const rotated = rotate(disguised, { cut: "RL-0001" });
  const head = { ...rotated, ledger: { ...rotated.ledger, entries: rotated.ledger.entries.map((entry) => (entry.id === "RL-0003" ? original : entry)) } };
  assert.deepEqual(rotationGate(base, head), [`${LEDGER_PATH} baseline_floor: ${refusal}`]);
});

test("a hand-authored rotation that archives a section a kept base entry links fails the gate with the helper's message", () => {
  const base = rotationBase();
  const refusal = "rotation at RL-0002 would split a pair (RL-0003 links archived section 1.1.0+agent.1); move the cut earlier";
  assert.throws(() => rotate(base, { cut: "RL-0002" }), { message: refusal });

  // The same cut written by hand: rotate without RL-0003, then put the
  // unchanged historical RL-0003 back at the top of the live ledger.
  const original = base.ledger.entries.find((entry) => entry.id === "RL-0003");
  const without = { ...base, ledger: { ...base.ledger, entries: base.ledger.entries.filter((entry) => entry !== original) } };
  const rotated = rotate(without, { cut: "RL-0002" });
  const head = {
    ...rotated,
    ledger: { ...rotated.ledger, baseline_floor: { ...rotated.ledger.baseline_floor, first_kept_id: "RL-0003" }, entries: [original, ...rotated.ledger.entries] },
  };
  assert.deepEqual(rotationGate(base, head), [
    `${LEDGER_PATH} RL-0003: changelog_section "1.1.0+agent.1" has no matching section in CHANGELOG.md`,
    `${LEDGER_PATH} baseline_floor: ${refusal}`,
  ]);
});

test("the release-ledger gate reports a dropped archived section once, against CHANGELOG.md", () => {
  const unlinked = "## [0.9.0] - 2026-01-31\n\n### Added\n\n- Unlinked fixture release.\n";
  const base = rotationBase({ changelog: `${ROTATION_CHANGELOG}\n${unlinked}` });
  const head = rotate(base);
  const dropped = tamperArchive(head, head.ledger.baseline_floor.archives[0].changelog_path, (text) => text.replace(unlinked, ""));
  assert.deepEqual(rotationGate(base, dropped), [
    'CHANGELOG.md: section "0.9.0" was present at base but is in no changelog file now, live or archived — a section is never deleted; ' +
      "a baseline rotation moves it into a new archive file",
  ]);
});

test("a new entry that amends an archived entry passes, in the rotation's range and in a later one", () => {
  const base = rotationBase();
  const rotated = rotate(base);
  const changelog = rotated.changelog.replace("## [", "## [1.3.0+agent.1] - 2026-03-02\n\n### Fixed\n\n- Correct the first fixture release's record.\n\n## [");
  const amendment = fixtureEntry(parseChangelogSections(changelog), {
    id: "RL-0006",
    sequence: 6,
    date: "2026-03-02",
    section: "1.3.0+agent.1",
    extra: { kind: "amendment", amends: "RL-0001", amendment_reason: "RL-0001 understated its impact." },
  });
  const head = { ...rotated, changelog, ledger: { ...rotated.ledger, entries: [...rotated.ledger.entries, amendment] } };
  assert.deepEqual(rotationGate(rotated, head), []);
  assert.deepEqual(rotationGate(base, head), []);
});

test("the changelog cut takes the whole tail from the top of the first archived release group, linked or not", () => {
  // Cutting at RL-0002 archives release 1.1.0, so 1.1.0+agent.1 above it moves
  // too; RL-0003 still links it, so the cut must move earlier.
  assert.throws(() => rotate(rotationBase(), { cut: "RL-0002" }), /RL-0003 links archived section 1\.1\.0\+agent\.1\); move the cut earlier/);

  // With no entry linking 1.1.0+agent.1 it simply moves with its release.
  const base = rotationBase();
  const unlinked = { ...base, ledger: { ...base.ledger, entries: base.ledger.entries.filter((entry) => entry.id !== "RL-0003") } };
  const rotated = rotateLedger({
    ledger: unlinked.ledger,
    changelogText: unlinked.changelog,
    lastArchivedId: "RL-0002",
    ledgerArchivePath: "contracts/archive/release-ledger.2026-03-01.json",
    changelogArchivePath: "contracts/archive/CHANGELOG.2026-03-01.md",
    rotationEntryId: "RL-0005",
    refusalReasonCode: "baseline_below_floor",
    archiveNote: "Fixture archive.",
    changelogPreamble: "# Changelog archive",
  });
  assert.deepEqual(parseChangelogSections(rotated.archiveChangelogText).map((section) => section.section_id), ["1.1.0+agent.1", "1.1.0", "1.0.0"]);
  assert.deepEqual(parseChangelogSections(rotated.liveChangelogText).map((section) => section.section_id), ["1.2.0"]);
});

test("an unlinked archived section moved back to the end of the live changelog fails, even with the floor re-hashed", () => {
  const unlinked = "## [0.9.0] - 2026-01-31\n\n### Added\n\n- Unlinked fixture release.\n";
  const base = rotationBase({ changelog: `${ROTATION_CHANGELOG}\n${unlinked}` });
  const head = rotate(base);
  assert.deepEqual(rotationGate(base, head), []);

  const changelogPath = head.ledger.baseline_floor.archives[0].changelog_path;
  const tampered = tamperArchive(head, changelogPath, (text) => text.replace(unlinked, ""));
  const movedBack = { ...tampered, changelog: `${head.changelog}\n${unlinked}` };
  assert.deepEqual(rotationGate(base, movedBack), [
    `CHANGELOG.md: "0.9.0" is older than section "1.1.0+agent.1" in ${changelogPath} — every section in CHANGELOG.md is newer than every archived one, ` +
      "and a newer archive's than an older one's: a rotation archives one contiguous tail through the end of the file, and a section never moves back out of an archive",
  ]);
});
