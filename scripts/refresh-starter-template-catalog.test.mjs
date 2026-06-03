import assert from "node:assert/strict";
import test from "node:test";

import { adaptCatalogForCampaignsOs, mergeLocalQaStructure } from "./refresh-starter-template-catalog.mjs";

test("catalog refresh preserves local qaStructure when upstream catalog has none", () => {
  const sourceCatalog = {
    campaignSpecFixturePolicy: { directory: "docs/fixtures/campaign-specs" },
    families: {
      limos: {
        agentContract: {
          fixtures: ["docs/fixtures/campaign-specs/limos.json"],
        },
      },
    },
  };
  const existingCatalog = {
    families: {
      limos: {
        agentContract: {
          qaStructure: {
            checkout: {
              description: "local checkout structure",
              requiredVisibleSelectors: [{ name: "wrapper", selector: ".checkout-wrapper" }],
            },
          },
        },
      },
    },
  };

  const result = mergeLocalQaStructure(adaptCatalogForCampaignsOs(sourceCatalog), sourceCatalog, existingCatalog);

  assert.equal(result.campaignSpecFixturePolicy.directory, "contracts/fixtures/campaign-specs");
  assert.deepEqual(result.families.limos.agentContract.fixtures, ["contracts/fixtures/campaign-specs/limos.json"]);
  assert.equal(result.families.limos.agentContract.qaStructure.checkout.description, "local checkout structure");
});

test("catalog refresh lets upstream qaStructure override matching local pages", () => {
  const sourceCatalog = {
    families: {
      limos: {
        agentContract: {
          qaStructure: {
            checkout: {
              description: "upstream checkout structure",
              requiredVisibleSelectors: [{ name: "form", selector: '[data-next-checkout="form"]' }],
            },
          },
        },
      },
    },
  };
  const existingCatalog = {
    families: {
      limos: {
        agentContract: {
          qaStructure: {
            checkout: {
              description: "local checkout structure",
              requiredVisibleSelectors: [{ name: "wrapper", selector: ".checkout-wrapper" }],
            },
            upsell: {
              description: "local upsell structure",
              requiredVisibleSelectors: [{ name: "accept", selector: '[data-next-upsell-action="add"]' }],
            },
          },
        },
      },
    },
  };

  const result = mergeLocalQaStructure(adaptCatalogForCampaignsOs(sourceCatalog), sourceCatalog, existingCatalog);

  assert.equal(result.families.limos.agentContract.qaStructure.checkout.description, "upstream checkout structure");
  assert.equal(result.families.limos.agentContract.qaStructure.upsell.description, "local upsell structure");
});
