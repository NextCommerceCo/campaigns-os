import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PARITY_DIR, parityRefShapeOk, readParityFile, readParityFileForIdentity, writeParityFile } from "./snapshot.mjs";

const MANAGED = "# campaigns-os managed runtime state (synthetic)\n.campaign-runtime/*.json\n";
const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
function target(t) {
  const dir = mkdtempSync(join(tmpdir(), "parity-files-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(git(dir, "init", "-q").status, 0);
  writeFileSync(resolve(dir, ".gitignore"), MANAGED);
  return dir;
}

test("P2-W6: an upgraded target gains parity/.gitignore (*) before its first probe file; git ignores the files; the root .gitignore is unchanged", (t) => {
  const dir = target(t);
  assert.equal(existsSync(resolve(dir, PARITY_DIR)), false);
  const ref = writeParityFile(dir, { synthetic: "probe" });
  assert.equal(readFileSync(resolve(dir, PARITY_DIR, ".gitignore"), "utf8"), "*\n");
  assert.equal(git(dir, "check-ignore", "-q", ref.path).status, 0, "the probe file is ignored");
  assert.equal(git(dir, "check-ignore", "-q", `${PARITY_DIR}/.gitignore`).status, 0, "the directory ignores itself");
  assert.equal(readFileSync(resolve(dir, ".gitignore"), "utf8"), MANAGED);
});

test("P2-W6 variant: an existing parity/.gitignore with other content is never overwritten", (t) => {
  const dir = target(t);
  mkdirSync(resolve(dir, PARITY_DIR), { recursive: true });
  writeFileSync(resolve(dir, PARITY_DIR, ".gitignore"), "# operator content\n*\n");
  const ref = writeParityFile(dir, { synthetic: "probe" });
  assert.equal(readFileSync(resolve(dir, PARITY_DIR, ".gitignore"), "utf8"), "# operator content\n*\n");
  assert.equal(git(dir, "check-ignore", "-q", ref.path).status, 0);
  assert.equal(readFileSync(resolve(dir, ".gitignore"), "utf8"), MANAGED);
});

test("probe files are canonical, content-addressed and re-hashed on read: same value, same address; absent, invalid and ok", (t) => {
  const dir = target(t);
  const a = writeParityFile(dir, { b: 1, a: [2, { d: 3, c: 4 }] });
  const b = writeParityFile(dir, { a: [2, { c: 4, d: 3 }], b: 1 });
  assert.deepEqual(a, b); assert.ok(parityRefShapeOk(a));
  assert.equal(readFileSync(resolve(dir, a.path), "utf8"), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.deepEqual(readParityFile(a, dir), { status: "ok", value: { a: [2, { c: 4, d: 3 }], b: 1 } });
  assert.deepEqual(readParityFile({ path: `${PARITY_DIR}/${"0".repeat(64)}.json`, sha256: `sha256:${"0".repeat(64)}` }, dir), { status: "absent" });
  assert.equal(readParityFile({ path: a.path, sha256: `sha256:${"1".repeat(64)}` }, dir).status, "invalid");
  assert.equal(readParityFile({ ...a, extra: 1 }, dir).status, "invalid");
  writeFileSync(resolve(dir, a.path), '{"a":[2,{"c":4,"d":3}],"b":2}');
  assert.deepEqual(readParityFile(a, dir), { status: "invalid", detail: "hash_mismatch" });
  assert.deepEqual(readParityFileForIdentity(a, dir), { a: [2, { c: 4, d: 3 }], b: 2 });
  // A tampered file at the address is refused, not trusted, by the writer.
  assert.throws(() => writeParityFile(dir, { b: 1, a: [2, { d: 3, c: 4 }] }), /parity_write_verification_failed/);
});

test("probe file reads stay beneath the parity directory: a symlinked file reads invalid", (t) => {
  const dir = target(t);
  const ref = writeParityFile(dir, { synthetic: true });
  const outside = resolve(dir, "outside.json");
  writeFileSync(outside, readFileSync(resolve(dir, ref.path)));
  rmSync(resolve(dir, ref.path));
  symlinkSync(outside, resolve(dir, ref.path));
  assert.equal(readParityFile(ref, dir).status, "invalid");
  assert.equal(readParityFileForIdentity(ref, dir), null);
  assert.throws(() => writeParityFile(dir, { synthetic: true }));
});

for (const ancestor of [".campaign-runtime", ".campaign-runtime/polish", PARITY_DIR]) {
  test(`P2 containment: both readers and the writer refuse a pre-placed escaping ${ancestor} link`, (t) => {
    const dir = target(t), outside = target(t);
    const ref = writeParityFile(outside, { synthetic: "outside" });
    mkdirSync(resolve(dir, ancestor, ".."), { recursive: true });
    symlinkSync(resolve(outside, ancestor), resolve(dir, ancestor));
    assert.equal(readParityFile(ref, dir).status, "invalid");
    assert.equal(readParityFileForIdentity(ref, dir), null);
    assert.throws(() => writeParityFile(dir, { synthetic: "outside" }), /path_outside_target/);
  });
}

for (const kind of ["directory", "missing_star", "negation", "link"]) {
  test(`P2-W6 repair: ${kind} .gitignore refuses before any probe is written`, (t) => {
    const dir = target(t), ignore = resolve(dir, PARITY_DIR, ".gitignore");
    mkdirSync(resolve(dir, PARITY_DIR), { recursive: true });
    if (kind === "directory") mkdirSync(ignore);
    else if (kind === "link") {
      writeFileSync(resolve(dir, "operator-ignore"), "*\n");
      symlinkSync(resolve(dir, "operator-ignore"), ignore);
    } else writeFileSync(ignore, kind === "negation" ? "*\n!*.json\n" : "# operator content\n*.json\n");
    assert.throws(() => writeParityFile(dir, { synthetic: "must not write" }), /parity_ignore_invalid/);
    const status = git(dir, "status", "--porcelain", "--untracked-files=all");
    assert.equal(status.status, 0);
    assert.doesNotMatch(status.stdout, /parity\/[a-f0-9]{64}\.json/);
  });
}
