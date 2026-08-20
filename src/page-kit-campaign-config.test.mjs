import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadPageKitCampaignEntry,
  PAGE_KIT_CAMPAIGNS_REL_PATH,
} from "./page-kit-campaign-config.mjs";

test("campaigns.json loader resolves only the normalized public-route slug", () => {
  const targetRepo = mkdtempSync(join(tmpdir(), "page-kit-campaign-config-"));
  try {
    mkdirSync(join(targetRepo, "_data"), { recursive: true });
    writeFileSync(join(targetRepo, PAGE_KIT_CAMPAIGNS_REL_PATH), JSON.stringify({
      exact: { store_name: "Exact Merchant" },
      fallback: { store_name: "Wrong Merchant" },
    }));

    const loaded = loadPageKitCampaignEntry({ targetRepo, publicRouteSlug: " /exact/ " });
    assert.deepEqual(loaded, {
      status: "ok",
      public_route_slug: "exact",
      target_path: PAGE_KIT_CAMPAIGNS_REL_PATH,
      entry: { store_name: "Exact Merchant" },
    });

    const missing = loadPageKitCampaignEntry({ targetRepo, publicRouteSlug: "unknown" });
    assert.equal(missing.status, "entry_missing");
    assert.equal(missing.entry, null);
  } finally {
    rmSync(targetRepo, { recursive: true, force: true });
  }
});

test("campaigns.json loader returns stable status codes without leaking absolute paths", () => {
  const targetRepo = mkdtempSync(join(tmpdir(), "page-kit-campaign-config-status-"));
  try {
    const missingFile = loadPageKitCampaignEntry({ targetRepo, publicRouteSlug: "exact" });
    assert.deepEqual(missingFile, {
      status: "file_missing",
      public_route_slug: "exact",
      target_path: PAGE_KIT_CAMPAIGNS_REL_PATH,
      entry: null,
    });

    mkdirSync(join(targetRepo, "_data"), { recursive: true });
    writeFileSync(join(targetRepo, PAGE_KIT_CAMPAIGNS_REL_PATH), "not-json");
    assert.equal(loadPageKitCampaignEntry({ targetRepo, publicRouteSlug: "exact" }).status, "invalid_json");

    writeFileSync(join(targetRepo, PAGE_KIT_CAMPAIGNS_REL_PATH), "[]");
    assert.equal(loadPageKitCampaignEntry({ targetRepo, publicRouteSlug: "exact" }).status, "root_not_object");

    writeFileSync(join(targetRepo, PAGE_KIT_CAMPAIGNS_REL_PATH), JSON.stringify({ exact: "not-an-object" }));
    assert.equal(loadPageKitCampaignEntry({ targetRepo, publicRouteSlug: "exact" }).status, "entry_not_object");

    const serialized = JSON.stringify(loadPageKitCampaignEntry({ targetRepo, publicRouteSlug: "exact" }));
    assert.equal(serialized.includes(targetRepo), false);
  } finally {
    rmSync(targetRepo, { recursive: true, force: true });
  }
});

test("campaigns.json loader treats a missing or non-directory target as target_repo_missing", () => {
  const root = mkdtempSync(join(tmpdir(), "page-kit-target-status-"));
  try {
    const file = join(root, "target-file");
    writeFileSync(file, "file");
    assert.equal(loadPageKitCampaignEntry({ targetRepo: join(root, "absent"), publicRouteSlug: "exact" }).status, "target_repo_missing");
    assert.equal(loadPageKitCampaignEntry({ targetRepo: file, publicRouteSlug: "exact" }).status, "target_repo_missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
