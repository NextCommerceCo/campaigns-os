import test from "node:test";
import assert from "node:assert/strict";

import { flatFrontmatterKeys, checkFamilyPages } from "./check-slot-manifest.mjs";
import { loadTemplateSlotManifest } from "../src/template-slot-manifest.mjs";

test("flatFrontmatterKeys reads column-0 keys between the fences only", () => {
  const page = [
    "---",
    'title: "Ten Reasons"',
    "styles:",
    "  - css/presell/tokens.css",
    "# Article header",
    'article_title: "Hook"',
    "---",
    "body_key_looking_line: not frontmatter",
  ].join("\n");
  assert.deepEqual(flatFrontmatterKeys(page), ["title", "styles", "article_title"]);
});

test("flatFrontmatterKeys surfaces no-space and odd-syntax keys instead of skipping them", () => {
  const page = ["---", "canonical:https://example.com/foo", "promo-headline: x", '"quoted": y', "---"].join("\n");
  assert.deepEqual(flatFrontmatterKeys(page), ["canonical", "promo-headline", "quoted"]);
});

test("checkFamilyPages flags undeclared keys and unmanifested pages", () => {
  const manifest = loadTemplateSlotManifest("apollo");
  const { violations } = checkFamilyPages(manifest, [
    { page: "presell", keys: ["title", "article_title", "totally_new_key"] },
    { page: "mystery-page", keys: ["anything"] },
    { page: "checkout", keys: ["bundles"] }, // commerce-owned → skipped
  ]);
  assert.deepEqual(
    violations.map((v) => `${v.page}:${v.key}`),
    ["presell:totally_new_key", "mystery-page:(page)"],
  );
});

test("checkFamilyPages reports manifest-ahead slots as notes, not violations", () => {
  const manifest = loadTemplateSlotManifest("apollo");
  const { violations, notes } = checkFamilyPages(manifest, [
    { page: "presell", keys: ["title", "article_title"] },
  ]);
  assert.equal(violations.length, 0);
  assert.ok(notes.some((n) => n.key === "article_rating_text"), "core runs ahead of a main checkout without the new slot");
});
