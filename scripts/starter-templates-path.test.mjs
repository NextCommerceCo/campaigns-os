import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveStarterTemplatesSource } from "./starter-templates-path.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  }).trim();

// A fake workspace: <tmp>/campaigns-os is the checkout under test and
// <tmp>/campaign-cart-starter-templates is its sibling, a git repository with
// two commits that differ in src/.
function makeWorkspace(t) {
  const tmp = mkdtempSync(join(tmpdir(), "starter-templates-source-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = join(tmp, "campaigns-os");
  const sibling = join(tmp, "campaign-cart-starter-templates");
  mkdirSync(root);
  mkdirSync(join(sibling, "src"), { recursive: true });
  git(sibling, "init", "-q");
  writeFileSync(join(sibling, "src/partial.html"), "pinned\n");
  git(sibling, "add", ".");
  git(sibling, "commit", "-q", "-m", "pinned");
  const pinSha = git(sibling, "rev-parse", "HEAD");
  writeFileSync(join(sibling, "src/partial.html"), "ahead\n");
  git(sibling, "commit", "-q", "-am", "ahead");
  const headSha = git(sibling, "rev-parse", "HEAD");
  return { root, sibling, pinSha, headSha };
}

function withoutOverride(t) {
  const saved = process.env.STARTER_TEMPLATES_PATH;
  delete process.env.STARTER_TEMPLATES_PATH;
  t.after(() => {
    if (saved === undefined) delete process.env.STARTER_TEMPLATES_PATH;
    else process.env.STARTER_TEMPLATES_PATH = saved;
  });
}

test("a sibling ahead of the catalog pin is read at the pin without touching its working tree", (t) => {
  withoutOverride(t);
  const { root, sibling, pinSha, headSha } = makeWorkspace(t);
  const source = resolveStarterTemplatesSource(root, { pinSha });
  t.after(() => source.cleanup());
  assert.equal(source.kind, "pinned_archive");
  assert.equal(source.headSha, headSha);
  assert.notEqual(source.path, sibling);
  assert.equal(readFileSync(join(source.path, "src/partial.html"), "utf8"), "pinned\n");
  assert.equal(readFileSync(join(sibling, "src/partial.html"), "utf8"), "ahead\n");
  assert.equal(git(sibling, "status", "--porcelain"), "");
  source.cleanup();
  assert.equal(existsSync(source.path), false);
});

test("a sibling already at the pin with a clean src/ is used in place", (t) => {
  withoutOverride(t);
  const { root, sibling, headSha } = makeWorkspace(t);
  const source = resolveStarterTemplatesSource(root, { pinSha: headSha });
  assert.equal(source.kind, "sibling_at_pin");
  assert.equal(source.path, sibling);
});

test("a sibling at the pin with local edits under src/ is read from the commit, not the working tree", (t) => {
  withoutOverride(t);
  const { root, sibling, headSha } = makeWorkspace(t);
  writeFileSync(join(sibling, "src/partial.html"), "edited locally\n");
  writeFileSync(join(sibling, "src/untracked.html"), "untracked\n");
  const source = resolveStarterTemplatesSource(root, { pinSha: headSha });
  t.after(() => source.cleanup());
  assert.equal(source.kind, "pinned_archive");
  assert.equal(readFileSync(join(source.path, "src/partial.html"), "utf8"), "ahead\n");
  assert.equal(existsSync(join(source.path, "src/untracked.html")), false);
});

test("a pin the sibling does not have falls back to the sibling and says why", (t) => {
  withoutOverride(t);
  const { root, sibling, headSha } = makeWorkspace(t);
  const missing = "0123456789abcdef0123456789abcdef01234567";
  const source = resolveStarterTemplatesSource(root, { pinSha: missing });
  assert.equal(source.kind, "sibling_unpinned");
  assert.equal(source.path, sibling);
  assert.equal(source.headSha, headSha);
  assert.equal(source.pinSha, missing);
  assert.ok(source.reason, "the fallback carries git's reason");
});

test("STARTER_TEMPLATES_PATH is used as given, never re-pinned", (t) => {
  const { root, sibling, pinSha } = makeWorkspace(t);
  const saved = process.env.STARTER_TEMPLATES_PATH;
  process.env.STARTER_TEMPLATES_PATH = sibling;
  t.after(() => {
    if (saved === undefined) delete process.env.STARTER_TEMPLATES_PATH;
    else process.env.STARTER_TEMPLATES_PATH = saved;
  });
  const source = resolveStarterTemplatesSource(root, { pinSha });
  assert.equal(source.kind, "override");
  assert.equal(source.path, sibling);
  assert.equal(readFileSync(join(source.path, "src/partial.html"), "utf8"), "ahead\n");
});

test("no pin means the sibling as it stands", (t) => {
  withoutOverride(t);
  const { root, sibling } = makeWorkspace(t);
  const source = resolveStarterTemplatesSource(root, { pinSha: null });
  assert.equal(source.kind, "sibling");
  assert.equal(source.path, sibling);
});
