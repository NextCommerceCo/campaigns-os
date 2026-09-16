import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BUILD_FINGERPRINT_ALGORITHM,
  computeBuildFingerprint,
  inferPageType,
  resolveBuiltSiteScope,
  synthesizeMinimalBuildPacket,
  topologiesFromBuiltSiteScope,
} from "./built-site-scope.mjs";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-built-site-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Lay out a page-kit-style built campaign: _site/<slug>/<route>/index.html.
function writeBuiltCampaign(repo, slug, routes) {
  for (const [route, html] of Object.entries(routes)) {
    const dir = route ? join(repo, "_site", slug, route) : join(repo, "_site", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), html);
  }
}

test("inferPageType maps routes/filenames to funnel page types", () => {
  assert.equal(inferPageType(""), "landing");
  assert.equal(inferPageType("index"), "landing");
  assert.equal(inferPageType("checkout"), "checkout");
  assert.equal(inferPageType("upsell-1"), "upsell");
  assert.equal(inferPageType("oto1"), "upsell");
  assert.equal(inferPageType("downsell"), "downsell");
  assert.equal(inferPageType("down-sell-2"), "downsell");
  assert.equal(inferPageType("thank-you"), "receipt");
  // Two-step bundle-selection step.
  assert.equal(inferPageType("select"), "select");
  assert.equal(inferPageType("select-bundle"), "select");
  assert.equal(inferPageType("choose-your-bundle"), "select");
  // Checkout/cart/order still win, and unrelated "select" copy stays generic.
  assert.equal(inferPageType("select-checkout"), "checkout");
  assert.equal(inferPageType("bundle-select"), "select");
  assert.equal(inferPageType("choose-package"), "select");
  assert.equal(inferPageType("/campaign/select/"), "select");
  // Narrow by design: the final route segment must BE the selector step, not
  // merely contain the words, so an unrelated page is never pulled into
  // commerce residue checking.
  assert.equal(inferPageType("selected-items"), "page");
  assert.equal(inferPageType("our-choose-bundle-guide"), "page");
  assert.equal(inferPageType("choose-bundle-guide"), "page");
  assert.equal(inferPageType("order-complete"), "receipt");
  assert.equal(inferPageType("presell"), "presell");
  assert.equal(inferPageType("advertorial"), "presell");
  assert.equal(inferPageType("faq"), "page");
});

test("inferPageType resolves downsell before upsell", () => {
  // "downsell" contains neither "upsell"; this guards the ordering intent.
  assert.equal(inferPageType("downsell-offer"), "downsell");
  assert.equal(inferPageType("upsell-then-downsell"), "downsell");
});

test("resolveBuiltSiteScope enumerates a single-slug campaign and infers types", () => {
  withTempDir((repo) => {
    writeBuiltCampaign(repo, "acme-launch", {
      "": "<h1>Landing</h1>",
      checkout: "<h1>Checkout</h1>",
      "upsell-1": "<h1>Upsell</h1>",
      "thank-you": "<h1>Thanks</h1>",
    });
    const scope = resolveBuiltSiteScope(repo);
    assert.equal(scope.ok, true);
    assert.equal(scope.slug, "acme-launch");
    assert.equal(scope.html_count, 4);
    const byRoute = Object.fromEntries(scope.pages.map((p) => [p.route, p.page_type]));
    assert.equal(byRoute[""], "landing");
    assert.equal(byRoute["checkout"], "checkout");
    assert.equal(byRoute["upsell-1"], "upsell");
    assert.equal(byRoute["thank-you"], "receipt");
    const landing = scope.pages.find((p) => p.route === "");
    assert.equal(landing.page_id, "index");
  });
});

test("resolveBuiltSiteScope errors with candidates when multiple slugs exist", () => {
  withTempDir((repo) => {
    writeBuiltCampaign(repo, "campaign-a", { "": "<h1>A</h1>" });
    writeBuiltCampaign(repo, "campaign-b", { "": "<h1>B</h1>" });
    const scope = resolveBuiltSiteScope(repo);
    assert.equal(scope.ok, false);
    assert.match(scope.error, /pass --slug/);
    assert.deepEqual(scope.slug_candidates.sort(), ["campaign-a", "campaign-b"]);

    const chosen = resolveBuiltSiteScope(repo, { slug: "campaign-b" });
    assert.equal(chosen.ok, true);
    assert.equal(chosen.slug, "campaign-b");
  });
});

test("resolveBuiltSiteScope errors cleanly on a missing or empty campaign", () => {
  assert.equal(resolveBuiltSiteScope("/no/such/path").ok, false);
  withTempDir((repo) => {
    mkdirSync(join(repo, "_site", "empty"), { recursive: true });
    const scope = resolveBuiltSiteScope(repo, { slug: "empty" });
    assert.equal(scope.ok, false);
    assert.match(scope.error, /No built HTML pages/);
  });
});

test("resolveBuiltSiteScope treats a direct campaign directory as the campaign root", () => {
  withTempDir((campaignDir) => {
    mkdirSync(join(campaignDir, "checkout"), { recursive: true });
    writeFileSync(join(campaignDir, "checkout", "index.html"), "<h1>Checkout</h1>");
    const scope = resolveBuiltSiteScope(campaignDir);
    assert.equal(scope.ok, true);
    assert.equal(scope.slug, "");
    assert.equal(scope.campaign_dir, campaignDir);
    assert.equal(scope.pages.length, 1);
    assert.equal(scope.pages[0].route, "checkout");
    assert.equal(scope.pages[0].page_type, "checkout");

    const [topology] = topologiesFromBuiltSiteScope(scope, "http://localhost:8080");
    assert.equal(topology.topology_id, "campaign");
    assert.equal(topology.pages[0].url, "http://localhost:8080/checkout/");
  });
});

test("resolveBuiltSiteScope ignores includes/layouts and dotfiles", () => {
  withTempDir((repo) => {
    writeBuiltCampaign(repo, "acme", { "": "<h1>Landing</h1>", checkout: "<h1>Checkout</h1>" });
    const includes = join(repo, "_site", "acme", "_includes");
    mkdirSync(includes, { recursive: true });
    writeFileSync(join(includes, "head.html"), "<meta>");
    const scope = resolveBuiltSiteScope(repo, { slug: "acme" });
    assert.equal(scope.html_count, 2);
    assert.equal(scope.pages.some((p) => p.route.includes("_includes")), false);
  });
});

test("topologiesFromBuiltSiteScope builds fetchable URLs per route", () => {
  const scope = {
    slug: "acme",
    pages: [
      { page_id: "index", page_type: "landing", route: "" },
      { page_id: "checkout", page_type: "checkout", route: "checkout" },
    ],
  };
  const [topology] = topologiesFromBuiltSiteScope(scope, "http://localhost:8080/");
  assert.equal(topology.topology_id, "acme");
  assert.equal(topology.pages[0].url, "http://localhost:8080/");
  assert.equal(topology.pages[1].url, "http://localhost:8080/checkout/");
  assert.equal(topology.pages[1].page_type, "checkout");
});

test("topologiesFromBuiltSiteScope throws on an empty base URL (no silently-unfetchable topology)", () => {
  const scope = { slug: "acme", pages: [{ page_id: "index", page_type: "landing", route: "" }] };
  assert.throws(() => topologiesFromBuiltSiteScope(scope, ""), /base URL/);
  assert.throws(() => topologiesFromBuiltSiteScope(scope, null), /base URL/);
});

test("synthesizeMinimalBuildPacket marks itself synthetic and points at the built output", () => {
  withTempDir((repo) => {
    writeBuiltCampaign(repo, "acme", { "": "<h1>Landing</h1>", checkout: "<h1>Checkout</h1>" });
    const scope = resolveBuiltSiteScope(repo, { slug: "acme" });
    const packet = synthesizeMinimalBuildPacket({
      schemaVersion: "campaign-runtime-build-packet/v0",
      targetRepo: repo,
      scope,
      family: "olympus",
      baseUrl: "http://localhost:8080/",
    });
    assert.equal(packet.schema_version, "campaign-runtime-build-packet/v0");
    assert.equal(packet._synthesized.from, "built_site");
    assert.equal(packet.campaign.public_route_slug, "acme");
    assert.equal(packet.assembly.template_family, "olympus");
    assert.equal(packet.assembly.output_dir, "_site/acme");
    assert.equal(packet.deploy.preview_url, "http://localhost:8080/");
    assert.deepEqual(packet.qa, {});
    assert.equal(packet.pages.length, 2);
  });
});

// --- Build output fingerprint ---
// The value every later stage binds to; it must change exactly when the built
// output changes and never with the machine, the path, or the write order.

const FINGERPRINT_TREE = {
  "index.html": "<html><body>Landing</body></html>",
  "checkout/index.html": "<html><body>Checkout</body></html>",
  "assets/app.css": "body{margin:0}",
  "products/hero.png": "not-really-a-png",
};

function writeTree(root, files, order = Object.keys(files)) {
  for (const path of order) {
    mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...path.split("/")), files[path]);
  }
}

test("computeBuildFingerprint: byte-identical trees at different absolute paths share one value", () => {
  withTempDir((a) => withTempDir((b) => {
    writeTree(join(a, "_site", "one"), FINGERPRINT_TREE);
    writeTree(join(b, "nested", "elsewhere", "_site", "two"), FINGERPRINT_TREE);
    const left = computeBuildFingerprint(join(a, "_site", "one"));
    const right = computeBuildFingerprint(join(b, "nested", "elsewhere", "_site", "two"));
    assert.equal(left.ok, true);
    assert.equal(left.algorithm, BUILD_FINGERPRINT_ALGORITHM);
    assert.match(left.fingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.equal(left.fingerprint, right.fingerprint);
    assert.equal(left.file_count, 4);
    assert.deepEqual(left.excluded, []);
  }));
});

test("computeBuildFingerprint: one changed byte changes the value; an added file changes it too", () => {
  withTempDir((dir) => {
    const root = join(dir, "_site", "c");
    writeTree(root, FINGERPRINT_TREE);
    const before = computeBuildFingerprint(root).fingerprint;
    writeTree(root, { "assets/app.css": "body{margin:1}" });
    const changed = computeBuildFingerprint(root).fingerprint;
    assert.notEqual(changed, before);
    writeTree(root, { "assets/app.css": FINGERPRINT_TREE["assets/app.css"] });
    assert.equal(computeBuildFingerprint(root).fingerprint, before);
    writeTree(root, { "extra.txt": "" });
    assert.notEqual(computeBuildFingerprint(root).fingerprint, before);
  });
});

test("computeBuildFingerprint: write order does not matter and the manifest is the documented canonical form", () => {
  withTempDir((a) => withTempDir((b) => {
    writeTree(join(a, "_site", "s"), FINGERPRINT_TREE, Object.keys(FINGERPRINT_TREE));
    writeTree(join(b, "_site", "s"), FINGERPRINT_TREE, Object.keys(FINGERPRINT_TREE).reverse());
    const left = computeBuildFingerprint(join(a, "_site", "s"));
    const right = computeBuildFingerprint(join(b, "_site", "s"));
    assert.equal(left.fingerprint, right.fingerprint);
    // Recompute by hand from the documented algorithm: sorted root-relative
    // paths, each followed by the file's sha256, one `<path>\n<sha256>\n` pair
    // per file, sha256 over the whole manifest.
    const manifest = Object.keys(FINGERPRINT_TREE).sort()
      .map((path) => `${path}\n${createHash("sha256").update(FINGERPRINT_TREE[path]).digest("hex")}\n`)
      .join("");
    assert.equal(left.manifest, manifest);
    assert.equal(left.fingerprint, `sha256:${createHash("sha256").update(manifest).digest("hex")}`);
  }));
});

test("computeBuildFingerprint: exclusions are root-relative and reported; a missing root is not a fingerprint", () => {
  withTempDir((dir) => {
    const root = join(dir, "_site", "x");
    writeTree(root, FINGERPRINT_TREE);
    const full = computeBuildFingerprint(root);
    const partial = computeBuildFingerprint(root, { exclude: ["products/hero.png", "not/there.txt"] });
    assert.notEqual(partial.fingerprint, full.fingerprint);
    assert.equal(partial.file_count, 3);
    assert.deepEqual(partial.excluded, ["products/hero.png"]);
    const missing = computeBuildFingerprint(join(dir, "_site", "nope"));
    assert.equal(missing.ok, false);
    assert.equal(missing.fingerprint, null);
    assert.match(missing.error, /does not exist/);
  });
});

test("computeBuildFingerprint: symbolic links are not build output and are neither hashed nor followed", () => {
  withTempDir((dir) => {
    const root = join(dir, "_site", "s");
    writeTree(root, FINGERPRINT_TREE);
    const before = computeBuildFingerprint(root);
    // A link to a file outside the tree, a link to a directory outside the
    // tree, and a link loop back to the root: none changes the value or the
    // file count, and the loop does not hang the walk.
    mkdirSync(join(dir, "source"), { recursive: true });
    writeFileSync(join(dir, "source", "input.html"), "<html>input</html>");
    symlinkSync(join(dir, "source", "input.html"), join(root, "linked-file.html"));
    symlinkSync(join(dir, "source"), join(root, "linked-dir"));
    symlinkSync(root, join(root, "loop"));
    const after = computeBuildFingerprint(root);
    assert.equal(after.fingerprint, before.fingerprint);
    assert.equal(after.file_count, before.file_count);
    assert.equal(after.manifest.includes("linked-file.html"), false);
    assert.equal(after.manifest.includes("linked-dir"), false);
  });
});
