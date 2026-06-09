import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { crawlSourceAssetPaths } from "./source-asset-crawl.mjs";

test("crawlSourceAssetPaths inventories source assets and Page Kit rewrite hints", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "campaigns-os-source-assets-"));
  try {
    const sourceRoot = resolve(dir, "source");
    mkdirSync(resolve(sourceRoot, "assets/css"), { recursive: true });
    mkdirSync(resolve(sourceRoot, "assets/products"), { recursive: true });
    mkdirSync(resolve(sourceRoot, "assets/fonts"), { recursive: true });

    writeFileSync(resolve(dir, "outside.webp"), "outside\n");
    writeFileSync(resolve(sourceRoot, "assets/config.js"), "window.__CONFIG__ = {};\n");
    writeFileSync(resolve(sourceRoot, "assets/products/hero.webp"), "hero\n");
    writeFileSync(resolve(sourceRoot, "assets/products/card.webp"), "card\n");
    writeFileSync(resolve(sourceRoot, "assets/fonts/body.woff2"), "font\n");
    writeFileSync(resolve(sourceRoot, "assets/css/more.css"), ".icon{background:url('../products/card.webp')}\n");
    writeFileSync(
      resolve(sourceRoot, "assets/css/site.css"),
      "@import './more.css'; .hero{background-image:url('../products/hero.webp')} @font-face{src:url('../fonts/body.woff2')}\n",
    );
    writeFileSync(
      resolve(sourceRoot, "landing.html"),
      [
        '<script src="/assets/config.js"></script>',
        '<link rel="stylesheet" href="./assets/css/site.css">',
        '<img src="assets/products/hero.webp">',
        '<img src="https://cdn.example.com/remote.webp">',
        '<img src="/assets/products/missing.webp">',
        '<img src="../outside.webp">',
      ].join("\n"),
    );

    const crawl = crawlSourceAssetPaths({
      sourceRoot,
      htmlFiles: [{ path: "landing.html" }],
      pageMappings: [{ page_id: "landing", path: "landing.html" }],
    });

    assert.equal(crawl.schema_version, "source-asset-crawl/v0");
    assert.equal(crawl.summary.scanned_file_count, 3);
    assert.equal(crawl.summary.root_assets_path_count, 2);
    assert.equal(crawl.summary.missing_count, 2);
    assert.equal(crawl.summary.outside_source_root_count, 1);

    const configRef = crawl.references.find((ref) => ref.raw === "/assets/config.js");
    assert.equal(configRef.source_path, "assets/config.js");
    assert.equal(configRef.pagekit_asset_path, "config.js");
    assert.equal(configRef.rewrite_required, true);
    assert.deepEqual(configRef.referenced_by[0].page_ids, ["landing"]);

    assert.ok(crawl.references.some((ref) => ref.source_path === "assets/products/card.webp"));
    assert.ok(crawl.references.some((ref) => ref.source_path === "assets/fonts/body.woff2"));
    assert.ok(crawl.references.some((ref) => ref.raw === "../outside.webp" && ref.outside_source_root === true && ref.source_exists === false));
    assert.ok(crawl.warnings.some((warning) => warning.code === "source_asset.root_assets_path"));
    assert.ok(crawl.warnings.some((warning) => warning.code === "source_asset.outside_source_root"));
    assert.ok(crawl.warnings.some((warning) => warning.code === "source_asset.missing_file"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
