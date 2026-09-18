import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptCatalogForCampaignsOs,
  adaptFixtureForCampaignsOs,
  fetchWithTimeout,
  mergeLocalQaStructure,
  mergeTemplateVerification,
  preserveLocalOnlyFamilies,
  resolveSnapshotSource,
} from "./refresh-starter-template-catalog.mjs";

test("fixture refresh preserves the established two-step select role and unrelated source changes", () => {
  const path = "docs/fixtures/campaign-specs/olympus-mv-two-step-configurable.json";
  const page = { id: "select", type: "landing", template: "src/olympus-mv-two-step/select.html", sdk_hints: { sdk_page_type: "product", template_family: "olympus-mv-two-step", added_hint: true }, next_page: "checkout.html", label: "Updated source label" };
  const source = { global_config: { sdk_version: "0.4.38" }, funnels: [{ pages: [page, { id: "checkout", type: "checkout" }] }] };
  const text = `${JSON.stringify(source, null, 2)}\n`;
  const adapted = adaptFixtureForCampaignsOs(path, text);
  assert.deepEqual(JSON.parse(adapted), { ...source, funnels: [{ pages: [{ ...page, type: "select" }, source.funnels[0].pages[1]] }] });
  assert.equal(adaptFixtureForCampaignsOs(path, adapted), adapted, "refresh is idempotent");
  assert.equal(adaptFixtureForCampaignsOs("docs/fixtures/campaign-specs/another-family.json", text), text);
  for (const change of [{ id: "another-page" }, { type: "checkout" }, { template: "src/another/select.html" }, { next_page: "another-checkout.html" }, { sdk_hints: { sdk_page_type: "landing" } }, { sdk_hints: { sdk_page_type: "product", template_family: "another-family" } }]) {
    const future = JSON.stringify({ ...source, funnels: [{ pages: [{ ...page, ...change }] }] });
    assert.equal(adaptFixtureForCampaignsOs(path, future), future, "a distinct upstream contract stays unchanged");
  }
});

test("fixture refresh keeps known forward edges on their authored routes without changing future contracts", () => {
  const fixtures = [
    ["apollo-tiered-apollo-layout", "apollo"], ["demeter-editorial-tiered", "demeter"],
    ["olympus-tiered-standard-free", "olympus"], ["shop-single-step-upsell-receipt", "shop-single-step"],
    ["shop-three-step-dynamic-shipping", "shop-three-step"],
  ];
  for (const [fixture, family] of fixtures) {
    const path = `docs/fixtures/campaign-specs/${fixture}.json`;
    const id = family === "shop-three-step" ? "billing" : "checkout";
    const page = { id, type: "checkout", template: `src/${family}/${id}.html`, next_page: "upsell-bundle-stepper.html", label: "New upstream label" };
    if (family === "shop-three-step") page.sdk_hints = { template_family: family, sdk_page_type: "checkout", frontmatter: { next_url: "upsell-bundle-stepper.html", new_field: true } };
    const target = { id: "upsell-stepper", type: "upsell", template: `src/${family}/upsell-bundle-stepper.html`, page_url: "/upsell-stepper/" };
    const source = { global_config: { sdk_version: "0.4.38" }, funnels: [{ pages: [page, target] }] };
    const text = JSON.stringify(source);
    const adapted = adaptFixtureForCampaignsOs(path, text);
    const expectedPage = { ...page, next_page: "upsell-stepper.html" };
    if (page.sdk_hints) expectedPage.sdk_hints = { ...page.sdk_hints, frontmatter: { ...page.sdk_hints.frontmatter, next_url: "upsell-stepper.html" } };
    assert.deepEqual(JSON.parse(adapted), { ...source, funnels: [{ pages: [expectedPage, target] }] }, fixture);
    assert.equal(adaptFixtureForCampaignsOs(path, adapted), adapted);
    assert.equal(adaptFixtureForCampaignsOs(`other/${fixture}.json`, text), text);
    for (const changed of [{ ...target, page_url: "/different/" }, { ...target, template: "src/other/upsell.html" }, { ...target, type: "landing" }]) {
      const future = JSON.stringify({ ...source, funnels: [{ pages: [page, changed] }] });
      assert.equal(adaptFixtureForCampaignsOs(path, future), future);
    }
    for (const next_page of [undefined, "new-upsell.html"]) {
      const future = JSON.stringify({ ...source, funnels: [{ pages: [{ ...page, next_page }, target] }] });
      assert.equal(adaptFixtureForCampaignsOs(path, future), future);
    }
    if (page.sdk_hints) {
      const future = JSON.stringify({ ...source, funnels: [{ pages: [{ ...page, next_page: "upsell-stepper.html", sdk_hints: { ...page.sdk_hints, frontmatter: { next_url: "new-upsell.html" } } }, target] }] });
      assert.equal(adaptFixtureForCampaignsOs(path, future), future, "distinct frontmatter edge stays source-owned");
    }
  }
});

test("dispatch provenance SHA also pins the content fetch without resolving a moving ref", async () => {
  const sha = "a".repeat(40);
  const result = await resolveSnapshotSource(
    { sourceRepo: "owner/templates", sourceRef: "main", syncedFromSha: sha },
    { resolveSha: () => assert.fail("an explicit dispatch SHA must not be resolved again") },
  );
  assert.deepEqual(result, { contentRef: sha, syncedFromSha: sha });
});

test("a manual moving ref is resolved once before any snapshot content is fetched", async () => {
  const sha = "b".repeat(40);
  const calls = [];
  const result = await resolveSnapshotSource(
    { sourceRepo: "owner/templates", sourceRef: "main", syncedFromSha: null },
    {
      token: "read-token",
      resolveSha: async (input) => {
        calls.push(input);
        return sha;
      },
    },
  );
  assert.deepEqual(calls, [{ repo: "owner/templates", ref: "main", token: "read-token" }]);
  assert.deepEqual(result, { contentRef: sha, syncedFromSha: sha });
});

test("a malformed dispatch SHA fails before ref resolution or content fetching", async () => {
  await assert.rejects(
    () =>
      resolveSnapshotSource(
        { sourceRepo: "owner/templates", sourceRef: "main", syncedFromSha: "not-a-sha" },
        { resolveSha: () => assert.fail("an explicit malformed SHA must fail without resolving the ref") },
      ),
    /expected a 40-char commit SHA/,
  );
});

test("catalog refresh rewrites Template Reference locations for the vendored checkout", () => {
  const sourceCatalog = {
    families: {
      apollo: {
        templateReference: {
          contract_path: "docs/commerce-surface-catalog.json",
          artifact_path: "docs/template-references/apollo",
          provenance_path: "docs/template-references/apollo/README.md",
          provenance_url: "https://raw.example.test/README.md",
          standard_viewport_refs: [{
            viewport: "desktop",
            path: "docs/template-references/apollo/checkout-desktop.png",
            url: "https://raw.example.test/checkout-desktop.png",
            sha256: "a".repeat(64),
          }],
        },
      },
    },
  };

  const adapted = adaptCatalogForCampaignsOs(sourceCatalog);
  const reference = adapted.families.apollo.templateReference;
  assert.equal(reference.contract_path, "contracts/commerce-surface-catalog.json");
  assert.equal(reference.artifact_path, undefined);
  assert.equal(reference.provenance_path, undefined);
  assert.equal(reference.provenance_url, "https://raw.example.test/README.md");
  assert.equal(reference.standard_viewport_refs[0].path, undefined);
  assert.equal(reference.standard_viewport_refs[0].url, "https://raw.example.test/checkout-desktop.png");
  assert.equal(reference.standard_viewport_refs[0].sha256, "a".repeat(64));
  assert.equal(sourceCatalog.families.apollo.templateReference.artifact_path, "docs/template-references/apollo");
});

test("catalog refresh preserves private families absent from the public source (no arjuna clobber)", () => {
  const sourceCatalog = {
    families: {
      olympus: { agentContract: { fixtures: [] } },
    },
  };
  const existingCatalog = {
    families: {
      olympus: { agentContract: { fixtures: [] } },
      arjuna: { description: "private family", agentContract: { status: "agent-ready", qaStructure: { checkout: {} } } },
    },
  };
  const adapted = preserveLocalOnlyFamilies(adaptCatalogForCampaignsOs(sourceCatalog), existingCatalog);
  assert.ok(adapted.families.arjuna, "arjuna survives a public refresh");
  assert.equal(adapted.families.arjuna.description, "private family");
  assert.equal(adapted.families.arjuna.agentContract.status, "agent-ready", "agentContract carried through");
  assert.deepEqual(
    adapted.families.arjuna.agentContract.qaStructure.checkout,
    {},
    "nested qaStructure survives the structuredClone deep-copy",
  );
  assert.ok(adapted.families.olympus, "public families still present");
});

test("catalog refresh keeps the local private family when the public source redefines it (collision guard)", () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const sourceCatalog = {
      families: {
        arjuna: { description: "public arjuna (must NOT win)", agentContract: { status: "public" } },
      },
    };
    const existingCatalog = {
      families: {
        arjuna: {
          private: true,
          description: "Adsbranded internal",
          agentContract: { status: "agent-ready", qaStructure: { checkout: { description: "local" } } },
        },
      },
    };
    const adapted = preserveLocalOnlyFamilies(adaptCatalogForCampaignsOs(sourceCatalog), existingCatalog);
    assert.equal(adapted.families.arjuna.agentContract.status, "agent-ready", "local private family wins the collision");
    assert.equal(adapted.families.arjuna.agentContract.qaStructure.checkout.description, "local");
    assert.ok(
      warnings.some((w) => w.includes("arjuna") && w.includes("private")),
      "warns on the private-family collision",
    );
  } finally {
    console.warn = origWarn;
  }
});

test("catalog refresh drops public families that disappear from the source, and warns", () => {
  const sourceCatalog = {
    families: {
      olympus: { agentContract: { fixtures: [] } },
    },
  };
  const existingCatalog = {
    families: {
      olympus: { agentContract: { fixtures: [] } },
      demeter: { description: "public starter family", agentContract: { status: "agent-ready" } },
    },
  };

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  let adapted;
  try {
    adapted = preserveLocalOnlyFamilies(adaptCatalogForCampaignsOs(sourceCatalog), existingCatalog);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(adapted.families.olympus, "source family survives");
  assert.equal(adapted.families.demeter, undefined, "missing public family is not preserved as stale local state");
  // A maintainer must be told a public family was dropped, in case it carried
  // local-only customizations.
  assert.ok(warnings.some((msg) => msg.includes("demeter") && /dropped/.test(msg)), "drop is surfaced as a warning");
});

test("catalog refresh preserves local qaStructure when upstream catalog has none", () => {
  const sourceCatalog = {
    campaignSpecFixturePolicy: { directory: "docs/fixtures/campaign-specs" },
    families: {
      olympus: {
        agentContract: {
          fixtures: ["docs/fixtures/campaign-specs/olympus.json"],
        },
      },
    },
  };
  const existingCatalog = {
    families: {
      olympus: {
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
  assert.deepEqual(result.families.olympus.agentContract.fixtures, ["contracts/fixtures/campaign-specs/olympus.json"]);
  assert.equal(result.families.olympus.agentContract.qaStructure.checkout.description, "local checkout structure");
});

test("catalog refresh lets upstream qaStructure override matching local pages", () => {
  const sourceCatalog = {
    families: {
      olympus: {
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
      olympus: {
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

  assert.equal(result.families.olympus.agentContract.qaStructure.checkout.description, "upstream checkout structure");
  assert.equal(result.families.olympus.agentContract.qaStructure.upsell.description, "local upsell structure");
});

test("catalog refresh stamps per-family verification from the pinned manifest", () => {
  const adapted = {
    families: {
      olympus: { agentContract: {} },
      demeter: { agentContract: {} },
    },
  };
  const manifest = {
    schema_version: "template-verification-manifest/v1",
    evidence: {
      "sdk-0.4.37-2026-08-21": { sdk_version: "0.4.37", verified_at: "2026-08-21T15:26:00Z" },
      "sdk-0.4.34-2026-08-12": { sdk_version: "0.4.34", verified_at: "2026-08-12T06:12:06Z" },
    },
    families: {
      olympus: { evidence: "sdk-0.4.37-2026-08-21", campaigns_os_status: "certified" },
      demeter: { evidence: "sdk-0.4.34-2026-08-12", campaigns_os_status: "certified" },
      landing: { evidence: "sdk-0.4.37-2026-08-21", campaigns_os_status: "not_applicable" },
    },
  };
  const result = mergeTemplateVerification(adapted, manifest);
  assert.deepEqual(result.families.olympus.verification, {
    sdk_version: "0.4.37",
    verified_at: "2026-08-21T15:26:00Z",
    evidence: "sdk-0.4.37-2026-08-21",
    status: "certified",
    source: "template-verification.json",
  });
  assert.equal(result.families.demeter.verification.sdk_version, "0.4.34");
  assert.equal(result.families.landing, undefined, "manifest-only families are not invented in the catalog");
});

test("verification merge leaves families alone when the manifest cannot vouch for them", () => {
  const adapted = {
    families: {
      olympus: { agentContract: {} },
      arjuna: { private: true, agentContract: {} },
      apollo: { agentContract: {} },
    },
  };
  const manifest = {
    evidence: { "sdk-0.4.37-2026-08-21": { sdk_version: "0.4.37" } },
    families: {
      // apollo points at evidence that does not exist -> no block, not a crash.
      apollo: { evidence: "sdk-9.9.9-missing", campaigns_os_status: "certified" },
      olympus: { evidence: "sdk-0.4.37-2026-08-21", campaigns_os_status: "certified" },
    },
  };
  const result = mergeTemplateVerification(adapted, manifest);
  assert.ok(result.families.olympus.verification);
  assert.equal(result.families.apollo.verification, undefined, "dangling evidence refs stamp nothing");
  assert.equal(result.families.arjuna.verification, undefined, "families absent from the manifest stay unstamped");

  // A commit predating template-verification.json refreshes without stamping.
  const untouched = mergeTemplateVerification({ families: { olympus: {} } }, null);
  assert.equal(untouched.families.olympus.verification, undefined);
});

test("fetchWithTimeout reports only its own timer as a timeout", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("operation aborted")));
      });
    await assert.rejects(
      () =>
        fetchWithTimeout("https://example.test/slow", {
          headers: {},
          timeoutMs: 1,
          timeoutMessage: () => "timed out after 0.001s",
        }),
      /timed out after 0\.001s/,
    );

    const abortError = new Error("manual abort");
    abortError.name = "AbortError";
    globalThis.fetch = () => Promise.reject(abortError);
    await assert.rejects(
      () =>
        fetchWithTimeout("https://example.test/manual-abort", {
          headers: {},
          timeoutMs: 50,
          timeoutMessage: () => "should not appear",
        }),
      (error) => error === abortError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithTimeout bounds the response-body read, not just the request", async () => {
  // Headers arrive immediately, but the body read trickles/stalls until the
  // abort signal fires. Because `consume` runs inside the timed window, the
  // timer's abort cancels the in-flight read and the timeout message wins.
  const fetchImpl = (_url, { signal }) =>
    Promise.resolve({
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          if (signal.aborted) reject(new Error("aborted"));
          else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
  await assert.rejects(
    () =>
      fetchWithTimeout("https://example.test/trickle-body", {
        headers: {},
        timeoutMs: 5,
        timeoutMessage: () => "timed out during body read",
        consume: (response) => response.json(),
        fetchImpl,
      }),
    /timed out during body read/,
  );
});

test("fetchWithTimeout returns consume's result and propagates consume errors as-is", async () => {
  const okFetch = () => Promise.resolve({ ok: true, json: async () => ({ sha: "abc" }) });
  const sha = await fetchWithTimeout("https://example.test/ok", {
    headers: {},
    timeoutMessage: () => "should not appear",
    consume: async (response) => (await response.json()).sha,
    fetchImpl: okFetch,
  });
  assert.equal(sha, "abc");

  const notFound = () => Promise.resolve({ ok: false, status: 404, text: async () => "missing" });
  await assert.rejects(
    () =>
      fetchWithTimeout("https://example.test/404", {
        headers: {},
        timeoutMessage: () => "should not appear",
        consume: async (response) => {
          if (!response.ok) throw new Error(`Failed: ${response.status} ${await response.text()}`);
          return response.json();
        },
        fetchImpl: notFound,
      }),
    /Failed: 404 missing/,
  );
});
