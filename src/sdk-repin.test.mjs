import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadSdkSupportPolicy } from "./campaign-ecosystem.mjs";
import { SDK_REPIN_RECORD_REL_PATH, SDK_REPIN_SCHEMA, planSdkRepin, runSdkRepin } from "./sdk-repin.mjs";

const CLI = fileURLToPath(new URL("../bin/campaigns-os.mjs", import.meta.url));
const CDN = "https://cdn.jsdelivr.net/gh/NextCommerceCo/campaign-cart";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-sdk-repin-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(path, body) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

const loader = (ref) => `<script src="${CDN}@${ref}/dist/loader.js" type="module"></script>`;
const css = (ref) => `<link rel="stylesheet" href="${CDN}@${ref}/dist/campaign-cart.css">`;
const page = (...head) => `<!doctype html>\n<html>\n<head>\n  ${head.join("\n  ")}\n</head>\n<body></body>\n</html>\n`;

// A static funnel: three pages and a script, pinned across files, plus the refs
// repin must leave alone (an @latest, a commit, a prerelease, a commented-out
// loader, and an incidental campaign-cart@ URL that is not a loader or dist file).
function writeStaticRepo(root) {
  write(join(root, "index.html"), page(css("v0.4.20"), loader("v0.4.20")));
  write(join(root, "checkout", "index.html"), page(css("v0.4.20"), loader("v0.4.20"), `<!-- ${loader("v0.4.10")} -->`));
  write(join(root, "upsell", "index.html"), page(loader("0.4.25"), loader("latest")));
  write(join(root, "receipt", "index.html"), page(loader("main"), loader("3f2a9c1"), loader("v0.4.30-beta.1")));
  write(join(root, "js", "inject.js"), `const s = document.createElement("script");\ns.src = "${CDN}@v0.4.20/dist/loader.js";\n// docs: ${CDN}@v0.4.20/README.md\n`);
}

function snapshot(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return files;
}

function cli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off", CAMPAIGNS_OS_LIFECYCLE_LOG: "" },
  });
}

test("sdk repin: preview reports every rewrite and writes nothing", () => withTempDir((dir) => {
  writeStaticRepo(dir);
  const before = snapshot(dir);
  const result = runSdkRepin({ targetRepo: dir, targetSdk: "0.4.38" });
  assert.deepEqual(snapshot(dir), before);
  assert.equal(result.mode, "preview");
  assert.equal(result.status, "changes");
  assert.equal(result.applied, false);
  assert.equal(result.change_record.written, false);
  assert.equal(existsSync(join(dir, SDK_REPIN_RECORD_REL_PATH)), false);
  assert.deepEqual(
    result.rewrites.map(({ path, line, artifact, ref, new_ref }) => `${path}:${line} ${artifact} ${ref}->${new_ref}`).sort(),
    [
      "checkout/index.html:4 css v0.4.20->v0.4.38",
      "checkout/index.html:5 loader v0.4.20->v0.4.38",
      "index.html:4 css v0.4.20->v0.4.38",
      "index.html:5 loader v0.4.20->v0.4.38",
      "js/inject.js:2 loader v0.4.20->v0.4.38",
      "upsell/index.html:4 loader 0.4.25->0.4.38",
    ],
  );
  const one = result.rewrites.find((entry) => entry.path === "index.html" && entry.artifact === "loader");
  assert.equal(one.url, `${CDN}@v0.4.20/dist/loader.js`);
  assert.equal(one.new_url, `${CDN}@v0.4.38/dist/loader.js`);
  // The record a write would produce is previewed too.
  assert.equal(result.change_record.record.reference_count, 6);
}));

test("sdk repin: --apply rewrites only the version segment of semver pins, across files, and writes a change record", () => withTempDir((dir) => {
  writeStaticRepo(dir);
  const before = snapshot(dir);
  const result = runSdkRepin({ targetRepo: dir, targetSdk: "0.4.38", apply: true, now: () => new Date("2026-10-06T12:00:00Z") });
  assert.equal(result.applied, true);
  assert.equal(result.verified, true);
  const after = snapshot(dir);

  // Every changed file differs from its original by the version segments alone.
  for (const [path, text] of Object.entries(before)) {
    const expected = text
      .replace(/(campaign-cart@)v0\.4\.20(\/dist\/)/g, "$1v0.4.38$2")
      .replace(/(campaign-cart@)0\.4\.25(\/dist\/)/g, "$10.4.38$2");
    assert.equal(after[path], expected, path);
  }
  // Left alone: the commented-out loader, the non-artifact URL, and every non-semver ref.
  assert.match(after["checkout/index.html"], /<!-- .*campaign-cart@v0\.4\.10\/dist\/loader\.js/);
  assert.match(after["js/inject.js"], /campaign-cart@v0\.4\.20\/README\.md/);
  for (const ref of ["latest", "main", "3f2a9c1", "v0.4.30-beta.1"]) assert.ok(after[relativeFor(ref)].includes(`campaign-cart@${ref}/`), ref);

  const record = JSON.parse(after[SDK_REPIN_RECORD_REL_PATH]);
  assert.equal(record.schema_version, SDK_REPIN_SCHEMA);
  assert.equal(record.generated_at, "2026-10-06T12:00:00.000Z");
  assert.equal(record.to_version, "0.4.38");
  assert.equal(record.to_version_source, "argument");
  assert.deepEqual(record.from_versions, ["0.4.20", "0.4.25"]);
  assert.deepEqual([...record.files_touched].sort(), ["checkout/index.html", "index.html", "js/inject.js", "upsell/index.html"]);
  assert.equal(record.reference_count, 6);
  assert.equal(record.left_alone.not_semver.length, 4);
  assert.match(result.change_record.sha256, /^[0-9a-f]{64}$/);
  // No absolute path in a record meant to be committed and cited.
  assert.doesNotMatch(after[SDK_REPIN_RECORD_REL_PATH], new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}));

function relativeFor(ref) {
  return { latest: "upsell/index.html", main: "receipt/index.html", "3f2a9c1": "receipt/index.html", "v0.4.30-beta.1": "receipt/index.html" }[ref];
}

test("sdk repin: @latest, @main, commit and prerelease refs are reported, never rewritten", () => withTempDir((dir) => {
  writeStaticRepo(dir);
  const result = runSdkRepin({ targetRepo: dir, targetSdk: "0.4.38" });
  assert.deepEqual(
    result.left_alone.not_semver.map(({ path, ref }) => `${path} ${ref}`).sort(),
    ["receipt/index.html 3f2a9c1", "receipt/index.html main", "receipt/index.html v0.4.30-beta.1", "upsell/index.html latest"],
  );
  for (const entry of result.left_alone.not_semver) {
    assert.equal(entry.action, "not_semver");
    assert.equal(entry.new_url, null);
  }
}));

test("sdk repin: a second run finds nothing to change and writes nothing", () => withTempDir((dir) => {
  writeStaticRepo(dir);
  runSdkRepin({ targetRepo: dir, targetSdk: "0.4.38", apply: true });
  const before = snapshot(dir);
  const again = runSdkRepin({ targetRepo: dir, targetSdk: "0.4.38", apply: true });
  assert.equal(again.status, "nothing_to_change");
  assert.equal(again.applied, false);
  assert.equal(again.change_record.written, false);
  assert.equal(again.rewrites.length, 0);
  assert.equal(again.left_alone.at_target.length, 6);
  assert.deepEqual(snapshot(dir), before);
}));

test("sdk repin: a pin newer than the target is never downgraded", () => withTempDir((dir) => {
  write(join(dir, "index.html"), page(loader("v0.4.38"), loader("v0.4.20")));
  const result = runSdkRepin({ targetRepo: dir, targetSdk: "0.4.30", apply: true });
  assert.deepEqual(result.rewrites.map((entry) => entry.ref), ["v0.4.20"]);
  assert.deepEqual(result.left_alone.newer_than_target.map((entry) => entry.ref), ["v0.4.38"]);
  const text = readFileSync(join(dir, "index.html"), "utf8");
  assert.ok(text.includes("campaign-cart@v0.4.38/dist/loader.js"));
  assert.ok(text.includes("campaign-cart@v0.4.30/dist/loader.js"));
}));

test("sdk repin: the target defaults to the support policy's preferred_minimum", () => withTempDir((dir) => {
  write(join(dir, "index.html"), page(loader("v0.4.0")));
  const result = planSdkRepin({ targetRepo: dir });
  assert.equal(result.to_version, loadSdkSupportPolicy().preferred_minimum);
  // The public plan carries no internal rewrite offsets.
  assert.deepEqual(Object.keys(result).filter((key) => /span/i.test(key)), []);
  for (const entry of result.rewrites) assert.equal("ref_start" in entry, false);
  assert.equal(result.to_version_source, "policy.preferred_minimum");
}));

test("sdk repin: a page-kit repo (_data/campaigns.json) is refused and left untouched", () => withTempDir((dir) => {
  writeStaticRepo(dir);
  write(join(dir, "_data", "campaigns.json"), JSON.stringify({ demo: { sdk_version: "0.4.20" } }));
  const before = snapshot(dir);
  const result = runSdkRepin({ targetRepo: dir, targetSdk: "0.4.38", apply: true });
  assert.equal(result.ok, false);
  assert.equal(result.status, "refused_page_kit");
  assert.match(result.message, /page-kit sync/);
  assert.deepEqual(result.page_kit_data, ["_data/campaigns.json"]);
  assert.deepEqual(snapshot(dir), before);
}));

test("sdk repin: a nested page-kit project is refused too", () => withTempDir((dir) => {
  writeStaticRepo(dir);
  write(join(dir, "campaigns", "spring", "_data", "campaigns.json"), "{}");
  const result = planSdkRepin({ targetRepo: dir, targetSdk: "0.4.38" });
  assert.equal(result.status, "refused_page_kit");
  assert.deepEqual(result.page_kit_data, ["campaigns/spring/_data/campaigns.json"]);
}));

test("sdk repin CLI: preview, --apply and --json, exit codes and refusals", () => withTempDir((dir) => {
  const repo = join(dir, "repo");
  writeStaticRepo(repo);

  const preview = cli(["sdk", "repin", "--target", repo, "--target-sdk", "0.4.38"], dir);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /preview \(nothing written; re-run with --apply to write\)/);
  assert.match(preview.stdout, /\bindex\.html:5 {2}https:\/\/\S+campaign-cart@v0\.4\.20\/dist\/loader\.js\n {4}-> https:\/\/\S+campaign-cart@v0\.4\.38\/dist\/loader\.js/);
  assert.match(preview.stdout, /Left alone, not semver-pinned \(4\)/);
  assert.equal(existsSync(join(repo, SDK_REPIN_RECORD_REL_PATH)), false);

  const applied = cli(["sdk", "repin", "--target", repo, "--target-sdk", "v0.4.38", "--apply", "--json"], dir);
  assert.equal(applied.status, 0, applied.stderr);
  const body = JSON.parse(applied.stdout);
  assert.equal(body.mode, "apply");
  assert.equal(body.change_record.written, true);
  assert.equal(body.change_record.path, SDK_REPIN_RECORD_REL_PATH);
  assert.equal(body.to_version, "0.4.38");
  assert.ok(existsSync(join(repo, SDK_REPIN_RECORD_REL_PATH)));

  write(join(repo, "_data", "campaigns.json"), "{}");
  const refusedRepo = cli(["sdk", "repin", "--target", repo, "--json"], dir);
  assert.equal(refusedRepo.status, 2);
  assert.equal(JSON.parse(refusedRepo.stdout).status, "refused_page_kit");

  const badVersion = cli(["sdk", "repin", "--target", repo, "--target-sdk", "latest"], dir);
  assert.equal(badVersion.status, 1);
  assert.match(badVersion.stderr, /not a released SDK version/);
  assert.doesNotMatch(badVersion.stderr, /\n\s+at /, "no stack trace");
  const badFlag = cli(["sdk", "repin", "--target", repo, "--write"], dir);
  assert.equal(badFlag.status, 1);
  assert.match(badFlag.stderr, /Unknown SDK repin flag: --write/);
}));

test("sdk repin: a missing or non-directory target is refused in one line", () => withTempDir((dir) => {
  const missing = join(dir, "no-such-repo");
  assert.throws(() => planSdkRepin({ targetRepo: missing }), (error) => error.code === "refused_invocation" && /does not exist/.test(error.message));
  const file = join(dir, "index.html");
  write(file, page(loader("v0.4.20")));
  assert.throws(() => runSdkRepin({ targetRepo: file, apply: true }), (error) => error.code === "refused_invocation" && /is not a directory/.test(error.message));

  for (const [target, pattern] of [[missing, /does not exist/], [file, /is not a directory/]]) {
    const run = cli(["sdk", "repin", "--target", target, "--apply"], dir);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, pattern);
    assert.doesNotMatch(run.stderr, /\n\s+at /, "no stack trace");
    assert.equal(run.stderr.trim().split("\n").length, 1, run.stderr);
  }
  assert.equal(readFileSync(file, "utf8"), page(loader("v0.4.20")));
}));
