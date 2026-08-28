import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { knownCommands } from "../src/cli.mjs";
import {
  LEDGER_SCHEMA_PATH,
  ORIENTATION_SCHEMA_PATH,
  REASON_CODES_PATH,
  SURFACE_PATH,
} from "./orientation-contract.mjs";
import { ENVELOPE_FIXTURE_DIR, REFERENCE_PATH, generate } from "./generate-orientation-reference.mjs";

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
});
