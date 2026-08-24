import assert from "node:assert/strict";
import test from "node:test";

import {
  isUnresolvedTemplateFamily,
  resolveTemplateFamilyDesignSource,
  UNRESOLVED_TEMPLATE_FAMILIES,
} from "./template-reference.mjs";

test("unresolved family policy has one shared sentinel set", () => {
  assert.deepEqual(UNRESOLVED_TEMPLATE_FAMILIES, ["auto", "undecided"]);
  assert.equal(isUnresolvedTemplateFamily("auto"), true);
  assert.equal(isUnresolvedTemplateFamily("undecided"), true);
  assert.equal(isUnresolvedTemplateFamily("apollo"), false);
});

test("catalog Template Reference becomes DSP family input without sharing mutable state", () => {
  const catalog = {
    families: {
      apollo: {
        templateReference: {
          id: "template-reference-apollo",
          family: "apollo",
          version: "sdk-0.4.37-2026-08-21",
          contract_path: "docs/commerce-surface-catalog.json",
          standard_viewport_refs: [{ id: "desktop", viewport: "desktop", path: "desktop.png" }],
        },
      },
    },
  };

  const resolved = resolveTemplateFamilyDesignSource(catalog, "apollo");
  assert.equal(resolved.family, "apollo");
  assert.equal(resolved.version, "sdk-0.4.37-2026-08-21");
  assert.deepEqual(resolved.template_reference, catalog.families.apollo.templateReference);
  assert.notEqual(resolved.template_reference, catalog.families.apollo.templateReference);
});

test("family without published proof preserves the existing DSP blocker input", () => {
  assert.deepEqual(
    resolveTemplateFamilyDesignSource({ families: { olympus: {} } }, "olympus"),
    { family: "olympus" },
  );
  assert.equal(resolveTemplateFamilyDesignSource({ families: {} }, "undecided"), null);
});

test("mismatched catalog proof fails closed", () => {
  assert.throws(
    () => resolveTemplateFamilyDesignSource({
      families: { apollo: { templateReference: { family: "olympus", version: "1" } } },
    }, "apollo"),
    /does not match selected family/,
  );
});
