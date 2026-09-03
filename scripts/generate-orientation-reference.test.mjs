import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { knownCommands } from "../src/cli.mjs";
import {
  canonicalJson,
  canonicalEntryJson,
  entryHash,
  LEDGER_SCHEMA_PATH,
  ORIENTATION_SCHEMA_PATH,
  parseChangelogSections,
  REASON_CODES_PATH,
  SURFACE_PATH,
} from "./orientation-contract.mjs";
import {
  CANONICALIZATION_FIXTURE_PATH,
  ENVELOPE_FIXTURE_DIR,
  REFERENCE_PATH,
  generate,
} from "./generate-orientation-reference.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const readText = (path) => readFileSync(join(root, path), "utf8");

const orientationSchema = readJson(ORIENTATION_SCHEMA_PATH);
const ledgerSchema = readJson(LEDGER_SCHEMA_PATH);
const reasonCodes = readJson(REASON_CODES_PATH);
const surface = readJson(SURFACE_PATH);

const reference = readText(REFERENCE_PATH);
// The inventory is the section that must contain each enum value exactly once.
// Counting over the whole document would be meaningless: the outcome examples
// legitimately repeat values, and a reason code legitimately appears in its own
// table row and nowhere else.
const inventory = reference.slice(
  reference.indexOf("## Schema enum inventory"),
  reference.indexOf("## Supported CLI commands"),
);
const reasonCodeTable = reference.slice(
  reference.indexOf("## Stable reason codes"),
  reference.indexOf("## Size bounds"),
);

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

function collectEnums(schema, path = "", found = []) {
  if (!schema || typeof schema !== "object") return found;
  if (Array.isArray(schema.enum)) found.push({ path: path || "(root)", values: schema.enum });
  for (const [key, value] of Object.entries(schema)) {
    if (key !== "enum" && value && typeof value === "object") collectEnums(value, path ? `${path}.${key}` : key, found);
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* A3 — documentation precision                                        */
/* ------------------------------------------------------------------ */

test("the generated reference and envelope fixtures are current", () => {
  const stale = [];
  for (const [path, expected] of generate()) {
    if (readText(path) !== expected) stale.push(path);
  }
  assert.deepEqual(stale, [], "run `node ./scripts/generate-orientation-reference.mjs --write` and commit the result");
});

test("the supported canonicalization vector reproduces both ledger digests", () => {
  const fixture = readJson(CANONICALIZATION_FIXTURE_PATH);
  assert.equal(fixture.fixture_version, "campaigns-os-release-ledger-canonicalization-example/v1");
  const validateLedger = new Ajv2020({ strict: true, allErrors: true }).compile(ledgerSchema);
  assert.ok(
    validateLedger({ schema_version: "campaigns-os-release-ledger/v1", entries: [fixture.entry_sha256.input_entry] }),
    JSON.stringify(validateLedger.errors),
  );
  assert.equal(canonicalEntryJson(fixture.entry_sha256.input_entry), fixture.entry_sha256.canonical_utf8);
  assert.equal(entryHash(fixture.entry_sha256.input_entry), fixture.entry_sha256.digest);
  assert.equal(fixture.entry_sha256.input_entry.entry_sha256, fixture.entry_sha256.digest);

  const sections = parseChangelogSections(fixture.changelog_sha256.input_utf8);
  const section = sections.find((candidate) => candidate.section_id === fixture.changelog_sha256.section_id);
  assert.ok(section, "worked changelog section must parse");
  assert.equal(section.body, fixture.changelog_sha256.section_body_utf8);
  assert.equal(section.body_sha256, fixture.changelog_sha256.digest);
  assert.match(fixture.changelog_sha256.input_utf8, /Canonicalization example\. {2}\n/);
  assert.ok(reference.includes(fixture.entry_sha256.canonical_utf8));
  assert.ok(reference.includes(fixture.entry_sha256.digest));
  assert.ok(reference.includes(fixture.changelog_sha256.section_body_utf8));
  assert.ok(reference.includes(fixture.changelog_sha256.digest));
  assert.ok(reference.includes("\\u0020\\u0020"));
});

test("the documented non-JSON scalar fallbacks match canonicalization", () => {
  assert.equal(
    canonicalJson({ negativeZero: -0, notANumber: Number.NaN, positiveInfinity: Number.POSITIVE_INFINITY, presentUndefined: undefined }),
    '{"negativeZero":0,"notANumber":null,"positiveInfinity":null,"presentUndefined":null}',
  );
});

test("every schema enum appears exactly once in the generated inventory, with every one of its values", () => {
  // Uniqueness is per enum LOCATION, not per bare string: `unknown` is a
  // legitimate value of four different enums, and collapsing them would hide
  // three of the four rather than prove the inventory complete.
  for (const [label, schema] of [[ORIENTATION_SCHEMA_PATH, orientationSchema], [LEDGER_SCHEMA_PATH, ledgerSchema]]) {
    const rows = inventory.slice(inventory.indexOf(`### \`${label}\``)).split("\n### ")[0].split("\n");
    for (const found of collectEnums(schema)) {
      const matching = rows.filter((row) => row.startsWith(`| \`${found.path}\` |`));
      assert.equal(matching.length, 1, `${label}: enum at ${found.path} appears ${matching.length} times in the inventory, expected exactly once`);
      for (const value of found.values) {
        const count = occurrences(matching[0], `\`${value}\``);
        assert.equal(count, 1, `${label}: ${found.path} value ${value} appears ${count} times in its inventory row, expected exactly once`);
      }
      const listed = [...matching[0].matchAll(/`([^`]+)`/g)].map((match) => match[1]).slice(1);
      assert.deepEqual(listed, found.values, `${label}: the inventory row for ${found.path} does not list exactly the schema's values`);
    }
  }
});

test("every stable reason code appears exactly once in the generated reason-code table", () => {
  for (const code of Object.keys(reasonCodes.codes)) {
    const count = occurrences(reasonCodeTable, `\`${code}\``);
    assert.equal(count, 1, `reason code ${code} appears ${count} times in the reason-code table, expected exactly once`);
  }
});

test("every reason code has a deterministic remedy and a test id, and both reach the reference", () => {
  for (const [code, definition] of Object.entries(reasonCodes.codes)) {
    assert.ok(definition.remedy?.trim().length > 0, `${code} has no remedy`);
    assert.ok(definition.test_id?.trim().length > 0, `${code} has no test_id`);
    assert.ok(reference.includes(`\`${definition.test_id}\``), `${code}: test id ${definition.test_id} is missing from ${REFERENCE_PATH}`);
    assert.ok(reference.includes(definition.remedy.split("\n")[0].slice(0, 40)), `${code}: remedy text is missing from ${REFERENCE_PATH}`);
  }
});

test("a reason code this repository owns is exercised by a test in this repository", () => {
  const testSources = readdirSync(join(root, "scripts"))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => readText(`scripts/${name}`))
    .join("\n");
  const owned = Object.entries(reasonCodes.codes).filter(([, definition]) => definition.owner === "campaigns-os");
  assert.ok(owned.length > 0, "this repository must own at least one reason code it can actually exercise");
  for (const [code, definition] of owned) {
    assert.ok(
      testSources.includes(definition.test_id),
      `${code} is owned by campaigns-os but no test in scripts/*.test.mjs carries its test id ${definition.test_id}`,
    );
  }
});

test("every reason code owned by the consumer is declared as such rather than silently unexercised", () => {
  for (const [code, definition] of Object.entries(reasonCodes.codes)) {
    assert.ok(["campaigns-os", "campaigns-agent"].includes(definition.owner), `${code} has no owner`);
  }
  const owners = new Set(Object.values(reasonCodes.codes).map((definition) => definition.owner));
  assert.ok(owners.has("campaigns-agent"), "the split only means something if some codes are declared downstream");
});

test("every command documented in the reference resolves in the real CLI dispatch", () => {
  const dispatched = new Set(knownCommands());
  assert.ok(dispatched.size > 0, "knownCommands() derivation broke; fix that before trusting this test");
  const documented = [...reference.matchAll(/^- `campaigns-os ([a-z-]+)`$/gm)].map((match) => match[1]);
  assert.deepEqual(documented, surface.cli_commands, "the reference must document exactly the declared argv surface");
  for (const command of documented) {
    assert.ok(dispatched.has(command), `the reference documents \`campaigns-os ${command}\`, which the CLI does not dispatch`);
  }
});

test("every terminal outcome has a generated example envelope that validates against the schema", () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(orientationSchema);
  const dispositions = orientationSchema.$defs.disposition.enum;
  const files = readdirSync(join(root, ENVELOPE_FIXTURE_DIR)).sort();
  assert.deepEqual(files, [...dispositions].sort().map((d) => `${d}.json`), "one fixture per terminal outcome, no more and no fewer");
  for (const disposition of dispositions) {
    const envelope = readJson(`${ENVELOPE_FIXTURE_DIR}/${disposition}.json`);
    assert.ok(validate(envelope), `${disposition}: ${JSON.stringify(validate.errors)}`);
    assert.equal(envelope.outcome.disposition, disposition);
    assert.ok(
      Object.keys(reasonCodes.codes).includes(envelope.outcome.reason_code),
      `${disposition}: reason code ${envelope.outcome.reason_code} is not in the vocabulary`,
    );
    assert.ok(
      (reasonCodes.codes[envelope.outcome.reason_code].outcomes ?? []).includes(disposition),
      `${disposition}: reason code ${envelope.outcome.reason_code} does not declare this outcome`,
    );
    assert.ok(reference.includes(`### \`${disposition}\``), `${disposition} has no example section in ${REFERENCE_PATH}`);
  }
});

test("recognized v1 contracts accept unknown additive fields at every object depth", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validateOrientation = ajv.compile(orientationSchema);
  const validateLedger = ajv.compile(ledgerSchema);

  const envelope = structuredClone(readJson(`${ENVELOPE_FIXTURE_DIR}/orientation_available.json`));
  envelope.future_top_level = { introduced_by: "a later compatible producer" };
  envelope.request.future_request_fact = true;
  envelope.request.baseline.future_baseline_fact = "preserved but not interpreted";
  envelope.release_ledger.entries[0].future_entry_fact = 1;
  envelope.release_ledger.entries[0].changes[0].future_change_fact = ["additive"];
  assert.ok(validateOrientation(envelope), JSON.stringify(validateOrientation.errors));

  const ledger = structuredClone(readJson("contracts/release-ledger.json"));
  ledger.future_top_level = { introduced_by: "a later compatible producer" };
  ledger.entries[0].future_entry_fact = true;
  ledger.entries[0].changes[0].future_change_fact = "preserved but not interpreted";
  assert.ok(validateLedger(ledger), JSON.stringify(validateLedger.errors));
});

test("recognized v1 contracts still reject unknown schema ids, required-field gaps, invalid types, and unknown safety enums", () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(orientationSchema);
  const fixture = readJson(`${ENVELOPE_FIXTURE_DIR}/orientation_available.json`);

  const cases = [
    ["unknown schema id", (value) => { value.schema_version = "campaigns-os-tooling-orientation/v999"; }],
    ["missing required group", (value) => { delete value.request; }],
    ["invalid required type", (value) => { value.request.run_id = 42; }],
    ["unknown safety-critical enum", (value) => { value.outcome.disposition = "optimistically_ready"; }],
  ];

  for (const [label, mutate] of cases) {
    const candidate = structuredClone(fixture);
    mutate(candidate);
    assert.equal(validate(candidate), false, `${label} must fail closed`);
  }
});

test("the ten required semantic groups are all required by the orientation schema", () => {
  const required = new Set(orientationSchema.required);
  for (const group of [
    "request",
    "repository",
    "freshness",
    "surface",
    "release_ledger",
    "changelog",
    "runtime",
    "transaction",
    "outcome",
    "limits",
  ]) {
    assert.ok(required.has(group), `${group} must be a required semantic group`);
  }
});

test("the reference points at supported paths and never at implementation internals", () => {
  const links = [...reference.matchAll(/\]\(\.\.\/([^)]+)\)/g)].map((match) => match[1]);
  assert.ok(links.length > 0, "the reference must link its sources");
  for (const link of links) {
    assert.ok(!link.startsWith("src/"), `the reference links ${link}; a consumer must never be pointed at src/**`);
  }
});

test("the reference declares itself generated so nobody hand-edits it", () => {
  assert.match(reference, /GENERATED FILE — do not edit by hand/);
  assert.match(reference, /scripts\/generate-orientation-reference\.mjs/);
  assert.match(reference, /accepts and preserves unknown additive/);
  assert.match(reference, /unknown schema ID or/);
});
