import assert from "node:assert/strict";
import test from "node:test";

import { validateProvenance } from "./check-catalog-provenance.mjs";
import { stampProvenance } from "./refresh-starter-template-catalog.mjs";

const SHA = "38f1ba4bb24cf636791574b83e3eaffc7c45758b";

test("stampProvenance records repo, ref, and sha without mutating the input", () => {
  const input = { version: 2, families: { olympus: {} } };
  const out = stampProvenance(input, {
    repo: "NextCommerceCo/campaign-cart-starter-templates",
    ref: "main",
    sha: SHA,
  });
  assert.equal(out._synced_from_sha, SHA);
  assert.equal(out._synced_from_repo, "NextCommerceCo/campaign-cart-starter-templates");
  assert.equal(out._synced_from_ref, "main");
  assert.equal(out.version, 2, "existing fields preserved");
  assert.equal(input._synced_from_sha, undefined, "input not mutated");
});

test("stampProvenance rejects a non-SHA value", () => {
  assert.throws(() => stampProvenance({}, { repo: "r", ref: "main", sha: "main" }), /40-char commit SHA/);
});

test("stampProvenance rejects empty repo or ref", () => {
  assert.throws(() => stampProvenance({}, { repo: "", ref: "main", sha: SHA }), /repo must be a non-empty string/);
  assert.throws(() => stampProvenance({}, { repo: "r", ref: "", sha: SHA }), /ref must be a non-empty string/);
});

test("validateProvenance passes and warns for a legacy (unstamped) snapshot", () => {
  const { ok, errors, warnings } = validateProvenance({ version: 2 });
  assert.equal(ok, true);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
});

test("validateProvenance passes for a well-formed stamped snapshot", () => {
  const catalog = stampProvenance({ version: 2 }, {
    repo: "NextCommerceCo/campaign-cart-starter-templates",
    ref: "main",
    sha: SHA,
  });
  const { ok, errors } = validateProvenance(catalog);
  assert.equal(ok, true, errors.join("; "));
});

test("validateProvenance fails on a malformed sha", () => {
  const { ok, errors } = validateProvenance({ _synced_from_sha: "deadbeef", _synced_from_repo: "x/y" });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("40-char commit SHA")));
});

test("validateProvenance fails when sha is set but repo is missing", () => {
  const { ok, errors } = validateProvenance({ _synced_from_sha: SHA, _synced_from_ref: "main" });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("_synced_from_repo")));
});

test("validateProvenance fails when sha is set but ref is missing", () => {
  const { ok, errors } = validateProvenance({ _synced_from_sha: SHA, _synced_from_repo: "x/y" });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("_synced_from_ref")));
});
