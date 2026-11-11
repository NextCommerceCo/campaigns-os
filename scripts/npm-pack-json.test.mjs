import assert from "node:assert/strict";
import test from "node:test";
import { packedTarballName } from "./npm-pack-json.mjs";

const entry = { id: "@nextcommerce/campaigns-os@1.68.0", name: "@nextcommerce/campaigns-os", filename: "nextcommerce-campaigns-os-1.68.0.tgz" };

test("npm 11's array and npm 12's keyed object name the same tarball", () => {
  assert.equal(packedTarballName([entry]), entry.filename);
  assert.equal(packedTarballName({ [entry.name]: entry }), entry.filename);
});

test("output that names no tarball throws, whatever its shape", () => {
  for (const packed of [[], {}, null, [{ name: entry.name }], { [entry.name]: { name: entry.name } }]) {
    assert.throws(() => packedTarballName(packed), /npm pack --json named no tarball/);
  }
});
