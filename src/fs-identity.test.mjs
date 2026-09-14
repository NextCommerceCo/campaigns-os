import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { absentOrMalformed, canonicalPath, sameFile } from "./fs-identity.mjs";

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "fs-identity-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("canonicalPath is the real path when it exists and the resolved spelling when it does not", () => withDir((dir) => {
  const file = join(dir, "packet.json");
  writeFileSync(file, "{}\n");
  const link = join(dir, "link.json");
  symlinkSync(file, link);
  assert.equal(canonicalPath(link), realpathSync(file));
  assert.equal(canonicalPath(join(dir, "missing.json")), join(realpathSync(dir), "missing.json"));
  assert.equal(canonicalPath(join(dir, "a", "..", "packet.json")), realpathSync(file));
  // A missing tail below a symlinked directory resolves through the link.
  const real = join(dir, "real");
  mkdirSync(real);
  symlinkSync(real, join(dir, "dirlink"));
  assert.equal(canonicalPath(join(dir, "dirlink", "later", "packet.json")), join(realpathSync(real), "later", "packet.json"));
}));

test("sameFile: one file behind a symlink; a missing path compares by spelling unless both must exist", () => withDir((dir) => {
  const file = join(dir, "packet.json");
  writeFileSync(file, "{}\n");
  const link = join(dir, "link.json");
  symlinkSync(file, link);
  const missing = join(dir, "missing.json");

  assert.equal(sameFile(file, link), true);
  assert.equal(sameFile(file, link, { requireExisting: true }), true);
  assert.equal(sameFile(file, join(dir, "other.json")), false);

  // Lexically equal spellings are one path whether or not they exist.
  assert.equal(sameFile(missing, join(dir, ".", "missing.json")), true);
  assert.equal(sameFile(missing, join(dir, ".", "missing.json"), { requireExisting: true }), true);

  // A missing path reached through a symlinked directory: the default policy
  // resolves the directory link and calls the two spellings one path; the
  // strict one refuses to call two absent spellings one file. Once the file
  // is there, both do.
  const real = join(dir, "real");
  mkdirSync(real);
  const dirLink = join(dir, "dirlink");
  symlinkSync(real, dirLink);
  assert.equal(sameFile(join(real, "later.json"), join(dirLink, "later.json")), true);
  assert.equal(sameFile(join(real, "later.json"), join(dirLink, "later.json"), { requireExisting: true }), false);

  writeFileSync(join(real, "later.json"), "{}\n");
  assert.equal(sameFile(join(real, "later.json"), join(dirLink, "later.json")), true);
  assert.equal(sameFile(join(real, "later.json"), join(dirLink, "later.json"), { requireExisting: true }), true);

}));

test("absentOrMalformed names absence and bad JSON only", () => {
  assert.equal(absentOrMalformed(Object.assign(new Error("x"), { code: "ENOENT" })), true);
  assert.equal(absentOrMalformed(Object.assign(new Error("x"), { code: "ENOTDIR" })), true);
  assert.equal(absentOrMalformed(new SyntaxError("Unexpected token")), true);
  assert.equal(absentOrMalformed(Object.assign(new Error("x"), { code: "EACCES" })), false);
  assert.equal(absentOrMalformed(Object.assign(new Error("x"), { code: "EISDIR" })), false);
  assert.equal(absentOrMalformed(new Error("plain")), false);
  assert.equal(absentOrMalformed(null), false);
});
