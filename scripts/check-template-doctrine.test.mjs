import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const script = join(root, "scripts/check-template-doctrine.mjs");
const fixtures = join(root, "contracts/fixtures/template-residue");

// A templates tree with one real family carrying the shipped chrome assets
// (the committed starter fixtures), plus whatever extra directories a case
// wants under src/. Each extra directory ships a corrupted copy of one hashed
// asset, so if the check ever treats it as a family the hash disagrees.
function templatesTree(extraDirs) {
  const dir = mkdtempSync(join(tmpdir(), "doctrine-families-"));
  const family = join(dir, "src/demeter/assets/images");
  mkdirSync(family, { recursive: true });
  for (const name of readdirSync(fixtures)) copyFileSync(join(fixtures, name), join(family, name));
  for (const extra of extraDirs) {
    const images = join(dir, "src", extra, "assets/images");
    mkdirSync(images, { recursive: true });
    writeFileSync(join(images, "upsell-payment-logos.svg"), "<svg><!-- not the shipped bytes --></svg>\n");
  }
  return dir;
}

function runCheck(templatesPath) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, STARTER_TEMPLATES_PATH: templatesPath },
  });
}

test("payment-chrome hashes verify against the pinned tree; build output and hidden dirs under src/ are not families", () => {
  const dir = templatesTree(["node_modules", "_site", ".cache"]);
  try {
    const result = runCheck(dir);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /5 payment-chrome asset hash\(es\) verified across 1 family\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real family directory shipping different bytes fails the check and names the file", () => {
  const dir = templatesTree(["stray"]);
  try {
    const result = runCheck(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /1 payment-chrome asset hash\(es\) disagree/);
    assert.match(result.stderr, /src\/stray\/assets\/images\/upsell-payment-logos\.svg: sha256 [0-9a-f]{64} at the pin; contract records 54a8f046/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
