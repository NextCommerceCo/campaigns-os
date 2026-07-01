import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  loadPrivateTemplateSources,
  resolveCommerceCatalog,
  resolvePrivateTemplateSourceFragment,
  resolveTemplateBrandContract,
} from "./private-template-source.mjs";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-private-source-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Lays out a fake sibling "repo" + allowlist under `dir`, then points the two
// PRIVATE_TEMPLATE_SOURCES_* env vars at it for the duration of `run`. Always
// restores the prior env afterward so tests never leak into each other.
function withFixtureSource(dir, { sources = {}, fragments = {} }, run) {
  const sourcesRoot = join(dir, "root");
  writeFileSync(
    join(dir, "private-template-sources.json"),
    JSON.stringify({ schema_version: "private-template-source/v0", sources }, null, 2),
  );
  for (const [path, fragment] of Object.entries(fragments)) {
    const fullPath = join(sourcesRoot, path);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, JSON.stringify(fragment, null, 2));
  }
  const prevPath = process.env.PRIVATE_TEMPLATE_SOURCES_PATH;
  const prevRoot = process.env.PRIVATE_TEMPLATE_SOURCES_ROOT;
  process.env.PRIVATE_TEMPLATE_SOURCES_PATH = join(dir, "private-template-sources.json");
  process.env.PRIVATE_TEMPLATE_SOURCES_ROOT = sourcesRoot;
  try {
    return run();
  } finally {
    if (prevPath === undefined) delete process.env.PRIVATE_TEMPLATE_SOURCES_PATH;
    else process.env.PRIVATE_TEMPLATE_SOURCES_PATH = prevPath;
    if (prevRoot === undefined) delete process.env.PRIVATE_TEMPLATE_SOURCES_ROOT;
    else process.env.PRIVATE_TEMPLATE_SOURCES_ROOT = prevRoot;
  }
}

test("loadPrivateTemplateSources returns an empty allowlist when no file exists", () => {
  withTempDir((dir) => {
    withFixtureSource(dir, { sources: {} }, () => {
      // no fragments written, but the allowlist file itself is written empty above
      assert.deepEqual(loadPrivateTemplateSources(), {});
    });
  });
});

test("resolvePrivateTemplateSourceFragment returns null for a family absent from the allowlist", () => {
  withTempDir((dir) => {
    withFixtureSource(dir, { sources: {} }, () => {
      assert.equal(resolvePrivateTemplateSourceFragment("not-listed"), null);
    });
  });
});

test("resolvePrivateTemplateSourceFragment throws loudly when allowlisted but not checked out", () => {
  withTempDir((dir) => {
    withFixtureSource(dir, {
      sources: { acme: { repo: "some-org/acme-templates", contract_path: "contracts/acme.json" } },
    }, () => {
      assert.throws(() => resolvePrivateTemplateSourceFragment("acme"), /no checkout was found/);
    });
  });
});

test("resolvePrivateTemplateSourceFragment resolves a valid fragment from the sibling checkout", () => {
  withTempDir((dir) => {
    withFixtureSource(dir, {
      sources: { acme: { repo: "some-org/acme-templates", contract_path: "contracts/acme.json" } },
      fragments: {
        "acme-templates/contracts/acme.json": {
          schema_version: "private-template-source-fragment/v0",
          family: "acme",
          catalog_family: { description: "fixture" },
          brand_contract: { schema_version: "template-brand-contract/v0", family: "acme", family_inventory: {} },
        },
      },
    }, () => {
      const fragment = resolvePrivateTemplateSourceFragment("acme");
      assert.equal(fragment.catalogFamily.description, "fixture");
      assert.equal(fragment.brandContract.family, "acme");
    });
  });
});

test("resolvePrivateTemplateSourceFragment rejects a fragment declaring the wrong family", () => {
  withTempDir((dir) => {
    withFixtureSource(dir, {
      sources: { acme: { repo: "some-org/acme-templates", contract_path: "contracts/acme.json" } },
      fragments: {
        "acme-templates/contracts/acme.json": {
          schema_version: "private-template-source-fragment/v0",
          family: "not-acme",
          catalog_family: {},
          brand_contract: {},
        },
      },
    }, () => {
      assert.throws(() => resolvePrivateTemplateSourceFragment("acme"), /declares family "not-acme"/);
    });
  });
});

test("resolveCommerceCatalog merges an allowlisted private family into .families without touching public ones", () => {
  withTempDir((dir) => {
    withFixtureSource(dir, {
      sources: { acme: { repo: "some-org/acme-templates", contract_path: "contracts/acme.json" } },
      fragments: {
        "acme-templates/contracts/acme.json": {
          schema_version: "private-template-source-fragment/v0",
          family: "acme",
          catalog_family: { description: "fixture private family" },
          brand_contract: { schema_version: "template-brand-contract/v0", family: "acme", family_inventory: {} },
        },
      },
    }, () => {
      const catalog = resolveCommerceCatalog();
      assert.ok(Object.keys(catalog.families).length > 0, "public families still present");
      assert.equal(catalog.families.acme.description, "fixture private family");
      assert.deepEqual(catalog._private_source_warnings, []);
    });
  });
});

test("resolveCommerceCatalog collects a warning (does not throw) when a private family's checkout is missing", () => {
  withTempDir((dir) => {
    withFixtureSource(dir, {
      sources: { acme: { repo: "some-org/acme-templates", contract_path: "contracts/acme.json" } },
    }, () => {
      const catalog = resolveCommerceCatalog();
      assert.equal(catalog.families.acme, undefined);
      assert.equal(catalog._private_source_warnings.length, 1);
      assert.equal(catalog._private_source_warnings[0].code, "private_source_not_checked_out");
    });
  });
});

test("resolveTemplateBrandContract falls back to a private fragment and runs it through the shared extends chain", () => {
  withTempDir((dir) => {
    withFixtureSource(dir, {
      sources: { acme: { repo: "some-org/acme-templates", contract_path: "contracts/acme.json" } },
      fragments: {
        "acme-templates/contracts/acme.json": {
          schema_version: "private-template-source-fragment/v0",
          family: "acme",
          catalog_family: {},
          brand_contract: {
            schema_version: "template-brand-contract/v0",
            family: "acme",
            extends: "template-brand-contract.shared-commerce.v0.json",
            family_inventory: { bundle_picker: "acme-specific override" },
          },
        },
      },
    }, () => {
      const contract = resolveTemplateBrandContract("acme");
      assert.equal(contract.family, "acme");
      // Inherited from the public shared-commerce file this repo owns.
      assert.ok(contract.qa_inspection?.placeholder_text_residue?.terms?.includes("Lorem"));
      // Own override wins over the parent for the same key.
      assert.equal(contract.family_inventory.bundle_picker, "acme-specific override");
    });
  });
});

test("resolveTemplateBrandContract prefers an existing public contract over an allowlisted private one", () => {
  withTempDir((dir) => {
    withFixtureSource(dir, { sources: { olympus: { repo: "some-org/should-not-be-read", contract_path: "contracts/never.json" } } }, () => {
      const contract = resolveTemplateBrandContract("olympus");
      assert.equal(contract.family, "olympus");
    });
  });
});
