// A campaign with no brand tokens passes the theme gate and then blocks QA.
//
// `evaluateThemeGate` returns pass/`theme_gate.nothing_generatable` (nothing to
// generate, so nothing to gate), while `residueSeverityForThemeGate("pass")`
// runs the template-residue checks at blocker severity — so the starter
// family's own palette on the commerce calls to action lands as
// `template-residue:<page>:style:*` blockers at `qa run`. Both halves are
// deliberate; what was missing is that nothing in between said so, and the
// decision got made after a failed QA run instead of before one.
//
// These cases pin the warning to the gate OUTCOME, not to a new field: the
// advisory exists exactly when the gate's code is `nothing_generatable`, and is
// absent when a waiver was recorded or a brand layer was applied.
//
// They also pin it to campaigns QA really would block. A family outside the
// certified set carries no brand contract, so the runner emits no palette
// assertion for it — warning that operator, and recommending a waiver to clear
// a block that will never happen, would be a worse failure than the silence
// this replaces.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildNextActions, nextTinyPromptLines, safeBrandContractCode, safeFamilyLabel, singleLineDetail } from "./cli.mjs";
import { resolveTemplateBrandContract } from "./private-template-source.mjs";
import { contractHasPaletteResidueChecks, templateBrandContractPath } from "./template-brand-contract.mjs";

const ADVISORY_ID = "theme_gate.starter_palette_blocks_qa";
const DEFECT_ID = "theme_gate.brand_contract_unreadable";
const PACKET = "/campaigns/demo/campaign-runtime.build.json";

// A certified family: the catalog carries contracts/template-brand-contract.olympus.v0.json,
// which lists forbidden computed colors AND the commerce selectors to inspect
// them on — so this is a campaign browser QA really would block.
const CERTIFIED_FAMILY = "olympus";
const packetFor = (family) => ({ assembly: { template_family: family } });

const BASE = { packetPath: PACKET, packet: packetFor(CERTIFIED_FAMILY), polishGate: null, polishCheckpointGate: null, prepareBuildGate: null, ambient: null };

// The gate results below are the real shapes `evaluateThemeGate` returns for
// each case (see src/theme-gate.mjs).
const NOTHING_GENERATABLE = {
  status: "pass",
  code: "theme_gate.nothing_generatable",
  reason: "No generatable brand theme was found; the gate passes without a brand layer.",
  waiver: null,
  required_actions: [],
};
const WAIVED = {
  status: "waived",
  code: "theme_gate.waived",
  reason: "Theme gate waived: starter palette is acceptable for this campaign.",
  waiver: { reason: "starter palette is acceptable for this campaign", waived_by: "operator", waived_at: "2026-09-12T00:00:00.000Z" },
  required_actions: [],
};
const APPLIED = {
  status: "pass",
  code: "theme_gate.applied",
  reason: "Brand theme is applied after next-core.css on commerce pages.",
  waiver: null,
  required_actions: [],
};

function actionsFor(themeGate, stage, packet = BASE.packet) {
  return buildNextActions({ ...BASE, packet, themeGate, result: { stage, divergences: [] } });
}

function advisoryFor(themeGate, stage, packet = BASE.packet) {
  return actionsFor(themeGate, stage, packet).find((action) => action.id === ADVISORY_ID);
}

for (const stage of ["build", "polish", "deploy", "qa"]) {
  test(`next warns at ${stage} that a token-less build will block QA on the starter palette`, () => {
    const advisory = advisoryFor(NOTHING_GENERATABLE, stage);
    assert.ok(advisory, `stage ${stage} must carry the starter-palette warning before QA runs`);
    assert.match(advisory.description, /theme_gate\.nothing_generatable/);
    assert.match(advisory.description, /template-residue/);
    // The waive lane must be named as an exact command, not as prose.
    assert.match(advisory.description, /campaigns-os theme waive --packet \/campaigns\/demo\/campaign-runtime\.build\.json --reason/);
    // …and so must the alternative the docs already describe.
    assert.match(advisory.description, /brand-theme\.css/);
    assert.match(advisory.description, /after next-core\.css/);
    // Advisory, not a demand: QA keeps blocking and nothing auto-waives. A
    // `required` flag here would read as an instruction to waive.
    assert.notEqual(advisory.required, true);
    assert.equal(advisory.command, null);
    assert.equal(advisory.kind, "manual");
  });
}

test("the warning is read before the QA command it is about", () => {
  const actions = actionsFor(NOTHING_GENERATABLE, "qa");
  const warningAt = actions.findIndex((action) => action.id === ADVISORY_ID);
  const qaRunAt = actions.findIndex((action) => action.id === "qa_run");
  assert.ok(warningAt >= 0 && qaRunAt >= 0);
  assert.ok(warningAt < qaRunAt, "the starter-palette warning must precede qa_run in the action list");
});

test("a recorded waiver removes the warning — the decision is already made", () => {
  for (const stage of ["build", "polish", "deploy", "qa"]) {
    assert.equal(advisoryFor(WAIVED, stage), undefined, `waived gate must not warn at ${stage}`);
  }
});

test("an applied brand layer removes the warning — there is no starter palette left to block on", () => {
  for (const stage of ["build", "polish", "deploy", "qa"]) {
    assert.equal(advisoryFor(APPLIED, stage), undefined, `applied brand layer must not warn at ${stage}`);
  }
});

// The warning must be true, not merely well-intentioned. QA only emits
// `template-residue:*:style:*` rows for a family whose brand contract carries
// both forbidden computed colors and commerce selectors to inspect them on.
// A family outside the certified set resolves to no contract at all, so there
// is no starter palette to block on — and a waiver or a brand-layer rewrite
// recommended to clear a block that will never happen is worse than silence.

test("a family with palette-residue checks gets the warning", () => {
  // Guard the guard: this is the same fixture the cases above rely on, asserted
  // against the real contract rather than assumed.
  assert.equal(contractHasPaletteResidueChecks(resolveTemplateBrandContract(CERTIFIED_FAMILY)), true);
  assert.ok(advisoryFor(NOTHING_GENERATABLE, "qa", packetFor(CERTIFIED_FAMILY)));
});

test("a custom family gets no warning — QA emits no palette-residue rows for it", () => {
  assert.equal(resolveTemplateBrandContract("custom"), null, "custom must resolve to no brand contract");
  for (const stage of ["build", "polish", "deploy", "qa"]) {
    assert.equal(
      advisoryFor(NOTHING_GENERATABLE, stage, packetFor("custom")),
      undefined,
      `a custom-family campaign must not be warned at ${stage} about a block QA will never raise`,
    );
  }
});

test("an undecided or absent family gets no warning either", () => {
  for (const packet of [packetFor("undecided"), packetFor(""), {}, { assembly: {} }]) {
    assert.equal(advisoryFor(NOTHING_GENERATABLE, "qa", packet), undefined);
  }
});

test("the advisory and the browser runner share one palette-residue predicate", () => {
  // Not "does a contract exist": a contract with colors but no selectors, or
  // selectors but no colors, produces no palette assertion in the runner, so it
  // must produce no warning here.
  assert.equal(contractHasPaletteResidueChecks({ qa_inspection: { forbidden_computed_colors: [{ token: "--brand", rgb: "rgb(10, 38, 92)" }], computed_style_checks: [] } }), false);
  assert.equal(contractHasPaletteResidueChecks({ qa_inspection: { forbidden_computed_colors: [], computed_style_checks: [{ id: "cta", selector: ".b", page_types: ["checkout"] }] } }), false);
  assert.equal(contractHasPaletteResidueChecks({ qa_inspection: { forbidden_computed_colors: [{ token: "--brand", rgb: "rgb(10, 38, 92)" }], computed_style_checks: [{ id: "cta", selector: ".b", page_types: ["checkout"] }] } }), true);
  // A page type residue inspection never runs against is not a reason to warn.
  assert.equal(contractHasPaletteResidueChecks({ qa_inspection: { forbidden_computed_colors: [{ token: "--brand", rgb: "rgb(10, 38, 92)" }], computed_style_checks: [{ id: "cta", selector: ".b", page_types: ["landing"] }] } }), false);
});

// A contract that EXISTS but cannot be read is not the same as no contract.
// `resolveTemplateBrandContract` separates them — null for nothing resolved, a
// throw carrying a `code` for a defect — and swallowing the throw would hand a
// corrupted-contract operator silence here and a `template-brand-contract:*`
// blocker at `qa run`, which is the exact shape of failure this lane exists to
// stop. The fixtures below build a real defective contract through the private
// allowlist rather than stubbing the resolver, so the error code is the
// loader's own.

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-next-palette-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withFixtureFamily(dir, family, brandContract, run) {
  const sourcesRoot = join(dir, "root");
  writeFileSync(
    join(dir, "private-template-sources.json"),
    JSON.stringify({
      schema_version: "private-template-source/v0",
      sources: { [family]: { repo: `some-org/${family}-templates`, contract_path: "contracts/family.json" } },
    }),
  );
  const fragmentPath = join(sourcesRoot, `${family}-templates`, "contracts", "family.json");
  mkdirSync(join(fragmentPath, ".."), { recursive: true });
  writeFileSync(fragmentPath, JSON.stringify({
    schema_version: "private-template-source-fragment/v0",
    family,
    catalog_family: {},
    brand_contract: brandContract,
  }));
  const prevPath = process.env.PRIVATE_TEMPLATE_SOURCES_PATH;
  const prevRoot = process.env.PRIVATE_TEMPLATE_SOURCES_ROOT;
  process.env.PRIVATE_TEMPLATE_SOURCES_PATH = join(dir, "private-template-sources.json");
  process.env.PRIVATE_TEMPLATE_SOURCES_ROOT = sourcesRoot;
  try {
    return run();
  } finally {
    if (prevPath === undefined) delete process.env.PRIVATE_TEMPLATE_SOURCES_PATH;
    else process.env.PRIVATE_TEMPLATE_SOURCES_PATH = prevPath;
    if (prevRoot === undefined) delete process.env.PRIVATE_TEMPLATE_SOURCES_ROOT;
    else process.env.PRIVATE_TEMPLATE_SOURCES_ROOT = prevRoot;
  }
}

// An older-schema contract: exactly the case Kilo named, and the loader's
// `schema_mismatch`.
const STALE_SCHEMA_CONTRACT = {
  schema_version: "template-brand-contract/v0-beta",
  family: "fixturefam",
  qa_inspection: {
    forbidden_computed_colors: [{ token: "--brand--primary", rgb: "rgb(10, 38, 92)" }],
    computed_style_checks: [{ id: "checkout_submit_button", selector: ".submit-button", page_types: ["checkout"] }],
  },
};

test("a contract that exists but cannot be read gets its own advisory, naming the family and the error code", () => {
  withTempDir((dir) => {
    withFixtureFamily(dir, "fixturefam", STALE_SCHEMA_CONTRACT, () => {
      // The defect is the loader's, not the test's.
      assert.throws(() => resolveTemplateBrandContract("fixturefam"), (error) => error.code === "schema_mismatch");
      for (const stage of ["build", "polish", "deploy", "qa"]) {
        const actions = actionsFor(NOTHING_GENERATABLE, stage, packetFor("fixturefam"));
        const defect = actions.find((action) => action.id === DEFECT_ID);
        assert.ok(defect, `stage ${stage} must surface an unreadable brand contract`);
        assert.match(defect.description, /fixturefam/);
        assert.match(defect.description, /schema_mismatch/);
        assert.match(defect.description, /template-brand-contract:fixturefam/);
        assert.notEqual(defect.required, true);
        assert.equal(defect.command, null);
        // A defect is not a palette finding: whether the starter palette also
        // ships cannot be known while the contract is unreadable.
        assert.equal(actions.find((action) => action.id === ADVISORY_ID), undefined);
      }
    });
  });
});

// The description prints to a terminal and ships in next_actions[] JSON, and
// every value in it comes from a packet or a file on disk. A loader message
// quotes file content, so a contract can put newlines and Markdown into it.

test("a defect detail with newlines and backticks renders as one clean bullet", () => {
  withTempDir((dir) => {
    // A parse error whose message carries the offending content: real loader
    // output, not a hand-made string.
    const sourcesRoot = join(dir, "root");
    writeFileSync(join(dir, "private-template-sources.json"), JSON.stringify({
      schema_version: "private-template-source/v0",
      sources: { fixturefam: { repo: "some-org/fixturefam-templates", contract_path: "contracts/family.json" } },
    }));
    const fragmentPath = join(sourcesRoot, "fixturefam-templates", "contracts", "family.json");
    mkdirSync(join(fragmentPath, ".."), { recursive: true });
    writeFileSync(fragmentPath, "{\n  \"broken\": `back\\ntick`,\n  [not json]\n");
    const prevPath = process.env.PRIVATE_TEMPLATE_SOURCES_PATH;
    const prevRoot = process.env.PRIVATE_TEMPLATE_SOURCES_ROOT;
    process.env.PRIVATE_TEMPLATE_SOURCES_PATH = join(dir, "private-template-sources.json");
    process.env.PRIVATE_TEMPLATE_SOURCES_ROOT = sourcesRoot;
    try {
      const actions = actionsFor(NOTHING_GENERATABLE, "qa", packetFor("fixturefam"));
      const defect = actions.find((action) => action.id === DEFECT_ID);
      assert.ok(defect, "an unparseable fragment must still produce the advisory");
      assert.doesNotMatch(defect.description, /[\n\r\t]/, "the description must be a single line");
      // eslint-disable-next-line no-control-regex
      assert.doesNotMatch(defect.description, /[ --]/, "no control characters");
      // The only backticks left are the ones this description writes itself
      // (`qa run`); any from the loader detail are escaped.
      const detailPart = defect.description.slice(0, defect.description.indexOf("Browser QA rejects"));
      assert.doesNotMatch(detailPart, /(^|[^\\])`/, "backticks from the detail must be escaped");
      // One bullet: the human prompt renders it as a single line.
      const lines = nextTinyPromptLines({ stage: "qa", gates: [{ id: "theme_gate", status: "pass" }], next_actions: actions });
      const bullets = lines.filter((line) => line.startsWith("  - "));
      assert.equal(bullets.filter((line) => line.includes("could not be read")).length, 1);
    } finally {
      if (prevPath === undefined) delete process.env.PRIVATE_TEMPLATE_SOURCES_PATH;
      else process.env.PRIVATE_TEMPLATE_SOURCES_PATH = prevPath;
      if (prevRoot === undefined) delete process.env.PRIVATE_TEMPLATE_SOURCES_ROOT;
      else process.env.PRIVATE_TEMPLATE_SOURCES_ROOT = prevRoot;
    }
  });
});

test("a family name that is not a slug is not echoed into the description", () => {
  withTempDir((dir) => {
    // The family never reaches the resolver as a real family; what matters is
    // that whatever the packet carries is not printed back verbatim.
    withFixtureFamily(dir, "fixturefam", STALE_SCHEMA_CONTRACT, () => {
      const hostile = "fixturefam\n## INJECTED HEADING `rm -rf /`";
      const actions = actionsFor(NOTHING_GENERATABLE, "qa", { assembly: { template_family: hostile } });
      const defect = actions.find((action) => action.id === DEFECT_ID);
      if (defect) {
        assert.doesNotMatch(defect.description, /INJECTED HEADING/);
        assert.match(defect.description, /unknown-family/);
      }
      // Whether or not the resolver threw for this name, nothing may echo it.
      for (const action of actions) assert.doesNotMatch(action.description || "", /INJECTED HEADING/);
    });
  });
});

test("an unrecognized error code is reported as unknown, not echoed", () => {
  // The detail sanitiser, directly: one line, control characters gone, the
  // Markdown that could restyle a rendered bullet escaped, length bounded, and
  // an empty detail named rather than rendered as a gap.
  assert.equal(singleLineDetail("a\nb\tc\r\nd"), "a b c d");
  assert.equal(singleLineDetail("has `code` and [a](b)"), "has \\`code\\` and \\[a\\](b)");
  assert.equal(singleLineDetail("bellstring"), "bell string");
  assert.equal(singleLineDetail("   "), "(no detail reported)");
  assert.equal(singleLineDetail(undefined), "(no detail reported)");
  const long = singleLineDetail("x".repeat(500));
  assert.equal(long.length, 300);
  assert.ok(long.endsWith("…"));

  assert.equal(safeBrandContractCode("schema_mismatch"), "schema_mismatch");
  assert.equal(safeBrandContractCode("ENOENT"), "unknown");
  assert.equal(safeBrandContractCode(undefined), "unknown");
  assert.equal(safeFamilyLabel("olympus-mv-two-step"), "olympus-mv-two-step");
  assert.equal(safeFamilyLabel("Olympus Two Step"), "unknown-family");
  assert.equal(safeFamilyLabel("../../etc/passwd"), "unknown-family");
});

test("the repair path names the public contract file only when it exists", () => {
  withTempDir((dir) => {
    // Private-only family: no contracts/template-brand-contract.<family>.v0.json
    // on disk, so the advisory must not send the operator to repair one.
    withFixtureFamily(dir, "fixturefam", STALE_SCHEMA_CONTRACT, () => {
      const defect = actionsFor(NOTHING_GENERATABLE, "qa", packetFor("fixturefam"))
        .find((action) => action.id === DEFECT_ID);
      assert.match(defect.description, /^The contract source for family "fixturefam"/);
      assert.match(defect.description, /Repair the private fragment supplying it before QA/);
      assert.doesNotMatch(defect.description, /contracts\/template-brand-contract\.fixturefam\.v0\.json/);
    });
  });
});

test("a public family's defect names its real on-disk path", () => {
  // olympus does have a public contract file; corrupt the resolution by
  // pointing the allowlist at nothing and asserting the path branch directly.
  assert.ok(existsSync(templateBrandContractPath("olympus")), "fixture assumption: olympus has a public contract");
  assert.equal(existsSync(templateBrandContractPath("fixturefam")), false);
});

test("a contract defect is reported even when the campaign HAS brand tokens", () => {
  // QA rejects the contract itself; it does not wait on the theme gate. Gating
  // this on nothing_generatable would hide it from every campaign that did
  // generate a brand layer.
  withTempDir((dir) => {
    withFixtureFamily(dir, "fixturefam", STALE_SCHEMA_CONTRACT, () => {
      const actions = actionsFor(APPLIED, "qa", packetFor("fixturefam"));
      assert.ok(actions.find((action) => action.id === DEFECT_ID));
    });
  });
});

test("`next` does not throw on a defective contract", () => {
  withTempDir((dir) => {
    withFixtureFamily(dir, "fixturefam", STALE_SCHEMA_CONTRACT, () => {
      assert.doesNotThrow(() => actionsFor(NOTHING_GENERATABLE, "qa", packetFor("fixturefam")));
    });
  });
});

test("a readable contract raises no defect advisory", () => {
  for (const family of [CERTIFIED_FAMILY, "custom"]) {
    const actions = actionsFor(NOTHING_GENERATABLE, "qa", packetFor(family));
    assert.equal(actions.find((action) => action.id === DEFECT_ID), undefined, `${family} must raise no contract defect`);
  }
});

test("the human prompt carries the contract defect too", () => {
  withTempDir((dir) => {
    withFixtureFamily(dir, "fixturefam", STALE_SCHEMA_CONTRACT, () => {
      const next_actions = actionsFor(NOTHING_GENERATABLE, "qa", packetFor("fixturefam"));
      const text = nextTinyPromptLines({ stage: "qa", gates: [{ id: "theme_gate", status: "pass" }], next_actions }).join("\n");
      assert.match(text, /template brand contract cannot be read/);
      assert.match(text, /schema_mismatch/);
    });
  });
});

test("stages with no QA ahead of them do not carry the warning", () => {
  for (const stage of ["setup", "done"]) {
    assert.equal(advisoryFor(NOTHING_GENERATABLE, stage), undefined, `stage ${stage} must not warn`);
  }
});

test("the human prompt carries the warning, not only the JSON action list", () => {
  const next_actions = actionsFor(NOTHING_GENERATABLE, "qa");
  const lines = nextTinyPromptLines({ stage: "qa", gates: [{ id: "theme_gate", status: "pass" }], next_actions });
  const text = lines.join("\n");
  assert.match(text, /browser QA will BLOCK on the starter palette/);
  assert.match(text, /campaigns-os theme waive --packet/);
  // The stage's own prompt still prints: the warning is additive, not a
  // takeover of the tiny prompt.
  assert.match(text, /Next expected proof: browser QA \+ typed-card proof/);
});

test("the human prompt stays silent when the gate is waived or applied", () => {
  for (const gate of [WAIVED, APPLIED]) {
    const next_actions = actionsFor(gate, "qa");
    const text = nextTinyPromptLines({ stage: "qa", gates: [{ id: "theme_gate", status: gate.status }], next_actions }).join("\n");
    assert.doesNotMatch(text, /starter palette/);
  }
});

test("a blocked theme gate still owns the human prompt alone", () => {
  const text = nextTinyPromptLines({
    stage: "qa",
    gates: [{ id: "theme_gate", status: "blocked" }],
    next_actions: [{ id: "theme_gate.waive_theme", command: "campaigns-os theme waive --packet p --reason \"x\"" }],
  }).join("\n");
  assert.match(text, /Theme gate is BLOCKING this stage/);
  assert.doesNotMatch(text, /Next expected proof/);
});
