import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { assertNoNetworkAttempts, readJson, ROOT, runCli, writeJson } from "./qc-test-factories.mjs";
import { parseArgs, prepareBuildRerunCommand, specFetchCommand } from "./cli.mjs";
import { runReadbackCommand } from "./readback.mjs";
import { validateRouteSlugIdentity, validateBuiltSdkMetaTags, validateSpecRoutingHintsCurrent } from "./doctor/checks.mjs";
import { __qaNodeTestHooks } from "./qa-node.mjs";
import { projectPageKitTargets } from "./source-html-intake.mjs";
import { planSpecDerive, staleRoutingHints } from "./spec-derive.mjs";

process.env.CAMPAIGNS_OS_TELEMETRY = "off";
afterEach(assertNoNetworkAttempts);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-route-binding-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "target");
  const source = join(target, "src/short");
  cpSync(join(ROOT, "examples/source-html"), source, { recursive: true });
  writeJson(join(target, "package.json"), { private: true, devDependencies: { "next-campaign-page-kit": "0.2.0" } });
  const spec = readJson(join(ROOT, "examples/campaignspec.v42.basic.json"));
  spec.spec_identity.public_route_slug = "long-campaign-name";
  spec.campaign.slug = "long-campaign-name";
  for (const funnel of spec.funnels) for (const page of funnel.pages) delete page.sdk_hints;
  const specPath = join(dir, "spec.json");
  writeJson(specPath, spec);
  return { dir, target, source, spec, specPath };
}

async function intake(p, extra) {
  return runCli(["prepare-build", "--spec", p.specPath, "--target", p.target,
    "--template-family", "olympus", "--no-run-session", "--no-remit", ...extra, "--json"]);
}

function sourceTree(p, paths) {
  rmSync(p.source, { recursive: true, force: true });
  mkdirSync(p.source, { recursive: true });
  for (const path of paths) {
    mkdirSync(dirname(join(p.source, path)), { recursive: true });
    writeFileSync(join(p.source, path), "<html><body>Example page</body></html>");
  }
  writeJson(join(p.target, "package.json"), { private: true, devDependencies: { "next-campaign-page-kit": "0.3.0" } });
  writeJson(join(p.target, "node_modules/next-campaign-page-kit/package.json"), { version: "0.3.0" });
}

for (const flags of [["--route", "short"], ["--adopt", "src/short"], ["--public-route-slug", "short"]]) {
test(`route binding: existing pages keep their route and own records with ${flags[0]}`, async (t) => {
  const p = fixture(t);
  const result = await intake(p, [...flags, ...(flags[0] === "--adopt" ? [] : ["--source", p.source])]);
  assert.equal(result.error, null, result.error?.stack);
  assert.equal(result.exitCode, 0, result.stdout);
  const { packet, context, packetPath } = result.json;
  assert.equal(packet.campaign.public_route_slug, "short");
  assert.equal(packet.campaign.map_public_route_slug, "long-campaign-name");
  assert.equal(packet.assembly.output_dir, "src/short");
  assert.equal(packet.assembly.runtime_dir, ".campaign-runtime/funnels/short");
  assert.equal(context.scaffold.required, false);
  assert.ok(existsSync(packetPath));
  assert.ok(existsSync(join(p.target, ".campaign-runtime/funnels/short/assembly-report.json")));
  for (const path of ["src/long-campaign-name", "campaign-runtime-long-campaign-name.build.json", ".campaign-runtime/funnels/long-campaign-name"]) {
    assert.equal(existsSync(join(p.target, path)), false, path);
  }
  assert.equal(readJson(p.specPath).spec_identity.public_route_slug, "long-campaign-name", "the Map is unchanged");
  const rerun = prepareBuildRerunCommand({ packet, packetPath, context, targetRepo: p.target });
  assert.match(rerun.command, flags[0] === "--adopt" ? /--adopt src\/short/ : /--route short/);
  const inspected = await runCli(["doctor", "--packet", packetPath, "--no-live-refs", "--json"]);
  assert.equal(inspected.error, null);
  const codes = [...inspected.json.errors, ...inspected.json.warnings].map((issue) => issue.code);
  assert.ok(!codes.includes("campaign.route_slug_identity"), JSON.stringify(codes));
  assert.ok(!codes.includes("page_kit.scaffold_required"), JSON.stringify(codes));
  assert.equal(inspected.json.derived.public_route_slug, "short");
  const next = await runCli(["next", "--packet", packetPath, "--no-write", "--no-remit", "--json"]);
  assert.equal(next.error, null);
  assert.ok(next.json.ready.some((line) => /Map slug "long-campaign-name" → bound route "short"/.test(line)));
  const readback = runReadbackCommand(parseArgs(["readback", p.target, "--packet", packetPath]));
  assert.match(readback.text, /Map slug "long-campaign-name" → bound route "short"/);
  t.diagnostic(`campaign: ${JSON.stringify(packet.campaign)}`);
});
}

test("route binding: built-output gates use the bound root", async (t) => {
  const p = fixture(t);
  const result = await intake(p, ["--adopt", "src/short"]);
  assert.equal(result.error, null);
  const { packetPath } = result.json;
  mkdirSync(join(p.target, "_site/short"), { recursive: true });
  writeFileSync(join(p.target, "_site/short/index.html"), "<html><head><title>Example</title></head><body>Example</body></html>");
  const inspected = await runCli(["doctor", "--packet", packetPath, "--no-live-refs", "--json"]);
  assert.ok(inspected.json.ready.includes("Built output root found at _site/short/"));
  rmSync(join(p.target, "_site/short"), { recursive: true });
  mkdirSync(join(p.target, "_site/long-campaign-name"), { recursive: true });
  const missing = await runCli(["doctor", "--packet", packetPath, "--no-live-refs", "--json"]);
  const gate = [...missing.json.errors, ...missing.json.warnings].find((issue) => issue.code === "built_output.target_root");
  assert.equal(gate?.detail.expected_root, "_site/short/", "Map-route output cannot satisfy the bound root gate");
});

test("route binding: --route short --source src/short works from the Page Kit target", async (t) => {
  const p = fixture(t);
  const cwd = process.cwd();
  try {
    process.chdir(p.target);
    const result = await intake(p, ["--route", "short", "--source", "src/short"]);
    assert.equal(result.error, null, result.error?.stack);
    assert.equal(result.json.packet.campaign.map_public_route_slug, "long-campaign-name");
    assert.equal(result.json.context.scaffold.required, false);
  } finally {
    process.chdir(cwd);
  }
});

test("route binding: --adopt accepts matching explicit route and source", async (t) => {
  const p = fixture(t);
  const result = await intake(p, ["--adopt", "src/short", "--route", "short", "--source", p.source]);
  assert.equal(result.error, null, result.error?.stack);
  assert.equal(result.json.packet.campaign.public_route_slug, "short");
});

for (const command of ["start", "build"]) {
  test(`route binding: ${command} shares --adopt intake`, async (t) => {
    const p = fixture(t);
    const result = await runCli([command, "--spec", p.specPath, "--target", p.target, "--adopt", "src/short",
      "--template-family", "olympus", "--no-run-session", "--no-remit", "--json"]);
    assert.equal(result.error, null, result.error?.stack);
    assert.equal(result.json.packet.campaign.public_route_slug, "short");
    assert.equal(result.json.packet.campaign.map_public_route_slug, "long-campaign-name");
    assert.ok(!result.json.doctor.errors.some((issue) => issue.code === "campaign.route_slug_identity"));
  });
}

test("route binding: a declared Map root is translated and record spec keeps it bound", async (t) => {
  const p = fixture(t);
  p.spec.spec_identity.route_root = "/long-campaign-name/";
  writeJson(p.specPath, p.spec);
  const prepared = await intake(p, ["--adopt", "src/short"]);
  assert.equal(prepared.error, null, prepared.error?.stack);
  assert.equal(prepared.json.packet.campaign.route_root, "/short/");
  p.spec.funnels[0].pages.find((page) => page.type === "upsell").page_url = "upsell-moved/";
  writeJson(p.specPath, p.spec);
  const recorded = await runCli(["record", "spec", "--packet", prepared.json.packetPath, "--dry-run", "--json"]);
  assert.equal(recorded.error, null, recorded.error?.stack);
  assert.equal(recorded.exitCode, 0, recorded.stdout);
});

test("route binding: downstream commands accept the binding and refuse an unbound mismatch", async (t) => {
  const p = fixture(t);
  const prepared = await intake(p, ["--adopt", "src/short"]);
  assert.equal(prepared.error, null);
  const { packetPath, packet } = prepared.json;
  writeJson(join(p.target, "_data/campaigns.json"), { short: { sdk_version: "0.4.37" } });
  // Moving one page exercises record spec's page-rebind identity gate.
  p.spec.funnels[0].pages.find((page) => page.type === "upsell").page_url = "upsell-moved/";
  writeJson(p.specPath, p.spec);
  for (const argv of [["page-kit", "sync"], ["spec", "derive"], ["record", "spec"]]) {
    const bound = await runCli([...argv, "--packet", packetPath, "--dry-run", "--json"]);
    assert.equal(bound.error, null, `${argv.join(" ")}: ${bound.error?.stack}`);
    assert.equal(bound.exitCode, 0, `${argv.join(" ")}: ${bound.stdout}`);
    delete packet.campaign.map_public_route_slug;
    writeJson(packetPath, packet);
    const unbound = await runCli([...argv, "--packet", packetPath, "--dry-run", "--json"]);
    const text = `${unbound.error?.message || ""} ${unbound.stdout}`;
    assert.match(text, argv[0] === "record" ? /route_root_changed/ : /spec_identity_mismatch/);
    packet.campaign.map_public_route_slug = "long-campaign-name";
    writeJson(packetPath, packet);
  }
});

test("route binding: every downstream read rejects invalid bindings without a page change", async (t) => {
  const p = fixture(t);
  const prepared = await intake(p, ["--adopt", "src/short"]);
  assert.equal(prepared.error, null);
  const { packetPath, packet } = prepared.json;
  writeJson(join(p.target, "_data/campaigns.json"), { short: { sdk_version: "0.4.37" } });
  for (const sdkChanged of [false, true]) {
    if (sdkChanged) {
      p.spec.global_config.sdk_version = "0.4.38";
      writeJson(p.specPath, p.spec);
    }
    for (const binding of [undefined, "stale-route", "long-campaign-name"]) {
      if (binding === undefined) delete packet.campaign.map_public_route_slug;
      else packet.campaign.map_public_route_slug = binding;
      writeJson(packetPath, packet);
      for (const argv of [["page-kit", "sync"], ["spec", "derive"], ["record", "spec"]]) {
        const result = await runCli([...argv, "--packet", packetPath, "--dry-run", "--json"]);
        if (binding === "long-campaign-name") {
          assert.equal(result.error, null, result.error?.stack);
          assert.equal(result.exitCode, 0, result.stdout);
        } else {
          assert.match(`${result.error?.message || ""} ${result.stdout}`, argv[0] === "record" ? /route_root_changed/ : /spec_identity_mismatch/,
            `${argv.join(" ")} sdkChanged=${sdkChanged} binding=${binding}`);
        }
      }
      const inspected = await runCli(["doctor", "--packet", packetPath, "--no-live-refs", "--json"]);
      assert.equal(inspected.json.errors.some((issue) => issue.code === "campaign.route_slug_identity"), binding !== "long-campaign-name");
    }
  }
});

for (const route of ["checkout/", "/long-campaign-name/checkout/", "long-campaign-name/checkout/", "long-campaign-name-v2/x/", "/long-campaign-name/"]) {
  test(`route binding: intake projects ${route} onto the bound output`, async (t) => {
    const p = fixture(t);
    const page = p.spec.funnels[0].pages.find((page) => page.type === "checkout");
    page.page_url = route;
    page.is_entry = route === "/long-campaign-name/";
    writeJson(p.specPath, p.spec);
    const result = await intake(p, ["--adopt", "src/short"]);
    assert.equal(result.error, null, result.error?.stack);
    const kit = result.json.packet.source_html.pages.find((entry) => entry.page_id === page.id).page_kit;
    const expected = route === "long-campaign-name-v2/x/" ? "/short/long-campaign-name-v2/x/"
      : route === "/long-campaign-name/" ? "/short/" : "/short/checkout/";
    assert.equal(kit.public_route, expected);
    if (kit.frontmatter.permalink) assert.equal(kit.frontmatter.permalink, expected);
    assert.equal(kit.spec_route, expected.slice("/short/".length));
    const topology = __qaNodeTestHooks.extractTopologies(p.spec, {
      publicRouteSlug: "short", mapPublicRouteSlug: "long-campaign-name", baseUrl: "https://example.test/short/",
    })[0];
    assert.equal(topology.pages.find((item) => item.page_id === page.id).url, `https://example.test${expected}`);
    assert.equal(existsSync(join(p.target, "src/long-campaign-name")), false);
  });
}

test("route binding: projection and derive compare Map routes with relative built routes", () => {
  const pages = [
    { id: "entry", type: "landing", order: 1, is_entry: true, page_url: "/long-campaign-name/", next_page: "checkout" },
    { id: "checkout", type: "checkout", order: 2, page_url: "/long-campaign-name/checkout/", next_page: "upsell",
      sdk_hints: { meta_tags: { "next-success-url": "/long-campaign-name/upsell/" } } },
    { id: "upsell", type: "upsell", order: 3, page_url: "long-campaign-name/upsell/", on_accept: "receipt", on_decline: "entry",
      sdk_hints: { meta_tags: { "next-upsell-accept-url": "long-campaign-name/receipt/", "next-upsell-decline-url": "/long-campaign-name/" } } },
    { id: "receipt", type: "thankyou", order: 4, page_url: "receipt/" },
  ];
  const spec = { spec_identity: { public_route_slug: "long-campaign-name" }, funnels: [{ id: "example", pages }] };
  const options = { publicRouteSlug: "short", mapPublicRouteSlug: "long-campaign-name" };
  const projections = projectPageKitTargets({ specPages: pages, ...options, outputDir: "src/short" });
  assert.equal(projections.get("entry").public_route, "/short/");
  assert.equal(projections.get("checkout").frontmatter.next_url, "/short/upsell/");
  assert.equal(projections.get("upsell").frontmatter.next_url, "/short/receipt/");
  assert.equal(projections.get("upsell").frontmatter.decline_url, "/short/");
  const relativeRoutes = new Map([...projections].map(([id, kit]) => [id, kit.spec_route]));
  assert.deepEqual(staleRoutingHints(spec, { ...options, routeByPageId: relativeRoutes }), []);
  const derived = planSpecDerive({ spec, entry: {}, ...options, pageFiles: [...projections].map(([, kit]) => ({
    path: kit.target_path, basename: kit.target_path.replace(/\.html$/, ""), route: kit.spec_route,
  })) });
  assert.deepEqual(derived.changes.filter((entry) => entry.field.endsWith(".page_url")), []);
  assert.deepEqual(derived.stale_hints, []);
  for (const baseUrl of ["https://example.test/short/", "https://example.test/"]) {
    const topology = __qaNodeTestHooks.extractTopologies(spec, { ...options, baseUrl })[0];
    const checkout = topology.pages.find((page) => page.page_id === "checkout");
    const upsell = topology.pages.find((page) => page.page_id === "upsell");
    assert.equal(checkout.url, `${baseUrl}checkout/`);
    assert.equal(checkout.expected_meta_tags["next-success-url"], new URL(`${baseUrl}upsell/`).pathname);
    assert.equal(upsell.expected_meta_tags["next-upsell-accept-url"], new URL(`${baseUrl}receipt/`).pathname);
    assert.equal(upsell.expected_meta_tags["next-upsell-decline-url"], new URL(baseUrl).pathname);
  }
  const pageFiles = [...projections].map(([id, kit]) => ({
    path: kit.target_path, basename: kit.target_path.replace(/\.html$/, ""), route: kit.spec_route,
    ...kit.frontmatter, ...(id === "upsell" ? { decline_url: "/short/new-offer/" } : {}),
  }));
  pageFiles.push({ path: "new-offer.html", basename: "new-offer", route: "new-offer/", page_type: "upsell", next_url: "/short/receipt/", decline_url: "/short/" });
  const repointed = planSpecDerive({ spec, entry: {}, ...options, pageFiles, handedOff: true,
    packetBindings: new Map([...projections].map(([id, kit]) => [id, kit.target_path])),
  });
  assert.equal(repointed.changes.find((row) => row.field.endsWith("next-upsell-decline-url"))?.after, "/long-campaign-name/new-offer/");
  const newPage = repointed.changes.find((row) => row.op === "insert")?.after;
  assert.equal(newPage.on_accept, "receipt");
  assert.equal(newPage.on_decline, "entry");
  assert.deepEqual(repointed.stale_hints, []);
});

test("route binding: root-served intake keeps built output bound and QA at the served root", async (t) => {
  const p = fixture(t);
  p.spec.spec_identity.route_root = "/";
  for (const page of p.spec.funnels[0].pages) page.page_url = `/long-campaign-name/${page.page_url}`;
  writeJson(p.specPath, p.spec);
  const prepared = await intake(p, ["--adopt", "src/short"]);
  assert.equal(prepared.error, null, prepared.error?.stack);
  assert.equal(prepared.json.packet.campaign.route_root, "/");
  assert.equal(prepared.json.packet.assembly.output_dir, "src/short");
  const recorded = await runCli(["record", "spec", "--packet", prepared.json.packetPath, "--dry-run", "--json"]);
  assert.equal(recorded.error, null, recorded.error?.stack);
  const topology = __qaNodeTestHooks.extractTopologies(p.spec, { publicRouteSlug: "short", mapPublicRouteSlug: "long-campaign-name", baseUrl: "https://example.test/" })[0];
  assert.equal(topology.pages.find((page) => page.page_type === "checkout").url, "https://example.test/checkout/");
  const resolved = await __qaNodeTestHooks.resolveQaInputs({ _: ["qa", "resolve"], packet: prepared.json.packetPath, "base-url": "https://example.test/" });
  assert.equal(resolved.topologies[0].pages.find((page) => page.page_type === "checkout").url, "https://example.test/checkout/");
});

for (const routeRoot of ["/short/", "/"]) {
  test(`route binding: doctor compares Map-prefixed routing metas at ${routeRoot}`, (t) => {
    const p = fixture(t);
    const packet = { campaign: { public_route_slug: "short", map_public_route_slug: "long-campaign-name", route_root: routeRoot } };
    const tags = { "next-success-url": "/long-campaign-name/checkout/", "next-upsell-accept-url": "long-campaign-name/receipt/", "next-upsell-decline-url": "/long-campaign-name/" };
    const spec = { funnels: [{ id: "example", pages: [
      { id: "entry", type: "upsell", is_entry: true, page_url: "/long-campaign-name/", sdk_hints: { meta_tags: tags }, on_accept: "receipt", on_decline: "entry" },
      { id: "receipt", type: "thankyou", page_url: "receipt/" },
    ] }] };
    const file = join(p.target, "_site/short/index.html");
    mkdirSync(join(p.target, "_site/short"), { recursive: true });
    const html = (root) => `<html><head>${Object.keys(tags).map((tag, index) => `<meta name="${tag}" content="${root}${["checkout/", "receipt/", ""][index]}">`).join("")}</head><body>Example</body></html>`;
    const check = () => {
      const errors = [], warnings = [], ready = [];
      validateBuiltSdkMetaTags({ spec, packet, errors, warnings, ready,
        derived: { target_repo: p.target, map_public_route_slug: "long-campaign-name" },
        buildState: { report: { stages: { assembly: { status: "completed" } } } } });
      return { errors, warnings, ready };
    };
    writeFileSync(file, html(routeRoot));
    const correct = check();
    assert.deepEqual(correct.errors, []);
    assert.ok(correct.ready.some((line) => /checked.*1 page/.test(line)), JSON.stringify(correct));
    const errors = [];
    validateSpecRoutingHintsCurrent(spec, packet, errors, []);
    assert.deepEqual(errors, []);
    writeFileSync(file, html("/long-campaign-name/"));
    const wrong = check();
    assert.equal(wrong.errors.filter((issue) => issue.code === "sdk_hints.meta_tags.route_mismatch").length, 3);
  });
}

test("route binding: record spec reprojects Map-prefixed page moves onto the bound route", async (t) => {
  const p = fixture(t);
  const prepared = await intake(p, ["--adopt", "src/short"]);
  assert.equal(prepared.error, null);
  const page = p.spec.funnels[0].pages.find((page) => page.type === "upsell");
  page.page_url = "/long-campaign-name/nested/upsell/";
  writeJson(p.specPath, p.spec);
  const recorded = await runCli(["record", "spec", "--packet", prepared.json.packetPath, "--json"]);
  assert.equal(recorded.error, null, recorded.error?.stack);
  assert.equal(recorded.exitCode, 0, recorded.stdout);
  const updated = readJson(prepared.json.packetPath).source_html.pages.find((entry) => entry.page_id === page.id).page_kit;
  assert.equal(updated.public_route, "/short/nested/upsell/");
  assert.equal(updated.frontmatter.permalink, "/short/nested/upsell/");
});

test("route binding: spec fetch applies the binding rule before restoring the Map copy", async (t) => {
  const p = fixture(t);
  const prepared = await intake(p, ["--adopt", "src/short"]);
  assert.equal(prepared.error, null);
  const { packetPath, packet } = prepared.json;
  const cache = join(p.target, `.campaign-runtime/fetched-specs/${packet.spec.map_id}.json`);
  packet.spec.local_path = `.campaign-runtime/fetched-specs/${packet.spec.map_id}.json`;
  // Scoped packets still sit at the target root.
  for (const binding of [undefined, "stale-route", "long-campaign-name"]) {
    if (binding === undefined) delete packet.campaign.map_public_route_slug;
    else packet.campaign.map_public_route_slug = binding;
    writeJson(packetPath, packet);
    const result = await specFetchCommand({ _: ["spec", "fetch"], packet: packetPath }, {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: p.spec }) }),
    });
    assert.equal(result.ok, binding === "long-campaign-name", JSON.stringify(result));
    assert.equal(existsSync(cache), binding === "long-campaign-name");
    if (binding !== "long-campaign-name") assert.equal(result.errors[0].code, "spec.fetch.identity_mismatch");
  }
  for (const binding of [undefined, "stale-route", "long-campaign-name"]) {
    if (binding === undefined) delete packet.campaign.map_public_route_slug;
    else packet.campaign.map_public_route_slug = binding;
    writeJson(packetPath, packet);
    const result = await specFetchCommand({ _: ["spec", "fetch"], packet: packetPath }, {
      fetchImpl: async () => assert.fail("a present copy must not fetch"),
    });
    assert.equal(result.ok, binding === "long-campaign-name", JSON.stringify(result));
    if (binding !== "long-campaign-name") assert.equal(result.errors[0].code, "spec.fetch.identity_mismatch");
  }
});

test("unbound projection retains byte-for-byte output when no binding is supplied", () => {
  const input = { specPages: [{ id: "checkout", type: "checkout", page_url: "/short/checkout/", next_page: "receipt" },
    { id: "receipt", type: "thankyou", page_url: "receipt/" }], publicRouteSlug: "short", outputDir: "src/short" };
  assert.equal(JSON.stringify([...projectPageKitTargets(input)]), JSON.stringify([
    ["checkout", { target_path: "checkout.html", output_path: "src/short/checkout.html", public_route: "/short/checkout/", spec_route: "checkout/", page_type: "checkout", permalink_required: false, frontmatter: { page_type: "checkout", next_url: "/short/receipt/" } }],
    ["receipt", { target_path: "receipt.html", output_path: "src/short/receipt.html", public_route: "/short/receipt/", spec_route: "receipt/", page_type: "receipt", permalink_required: false, frontmatter: { page_type: "receipt" } }],
  ]));
});

test("route binding: doctor rejects undeclared, stale and Map-id bindings", () => {
  const spec = { spec_identity: { map_id: "example-map-id", public_route_slug: "long-campaign-name" } };
  for (const [campaign, message] of [
    [{ public_route_slug: "short" }, /does not match/],
    [{ public_route_slug: "short", map_public_route_slug: "other" }, /recorded campaign.map_public_route_slug/],
    [{ public_route_slug: "example-map-id", map_public_route_slug: "long-campaign-name" }, /equals the Map ID/],
    [{ public_route_slug: "long-campaign-name", map_public_route_slug: "other" }, /recorded campaign.map_public_route_slug/],
  ]) {
    const errors = [];
    validateRouteSlugIdentity(spec, { campaign }, errors, []);
    assert.equal(errors[0]?.code, "campaign.route_slug_identity");
    assert.match(errors[0].message, message);
  }
});

for (const [label, flags, message] of [
  ["conflicting route", ["--adopt", "src/short", "--route", "other"], /same route/],
  ["conflicting source", ["--adopt", "src/short", "--source", "."], /same folder/],
  ["outside src", ["--adopt", "../outside"], /Page Kit route folder/],
  ["no pages", ["--adopt", "src/empty"], /holding page files/],
  ["multiple slug segments", ["--route", "nested/short"], /single normalized slug/],
  ["unnormalized slug", ["--route", "/short/"], /single normalized slug/],
  ["alias conflict", ["--route", "short", "--public-route-slug", "other"], /same route/],
]) {
  test(`route binding refuses ${label} before creating records`, async (t) => {
    const p = fixture(t);
    mkdirSync(join(p.target, "src/empty"), { recursive: true });
    const result = await intake(p, flags);
    assert.match(result.error?.message || result.stdout, message);
    assert.equal(existsSync(join(p.target, ".campaign-runtime")), false);
  });
}

for (const [label, paths] of [
  ["includes only", ["_includes/fragment.html"]],
  ["layouts only", ["_layouts/base.html"]],
  ["assets HTML only", ["assets/fragment.html"]],
  ["empty folder", []],
]) {
  test(`route binding: --adopt refuses ${label} without writing anything`, async (t) => {
    const p = fixture(t);
    sourceTree(p, paths);
    const before = readdirSync(p.target, { recursive: true }).sort();
    const result = await intake(p, ["--adopt", "src/short"]);
    assert.match(result.error?.message || result.stdout, /holding page files/);
    assert.notEqual(result.exitCode, 0);
    assert.equal(existsSync(join(p.target, ".campaign-runtime")), false);
    assert.equal(existsSync(join(p.target, "campaign-runtime.build.json")), false);
    assert.equal(existsSync(join(p.target, "campaign-runtime-short.build.json")), false);
    assert.deepEqual(readdirSync(p.target, { recursive: true }).sort(), before);
  });
}

for (const page of ["index.html", "nested/page.html", "nested/assets/page.html", "linked.html"]) {
  test(`route binding: --adopt accepts one real Page Kit page at ${page}`, async (t) => {
    const p = fixture(t);
    sourceTree(p, page === "linked.html" ? ["_includes/fragment.html"] : [page]);
    if (page === "linked.html") symlinkSync("_includes/fragment.html", join(p.source, page));
    const result = await intake(p, ["--adopt", "src/short"]);
    assert.equal(result.error, null, result.error?.stack);
    assert.equal(result.exitCode, 0, result.stdout);
    assert.equal(result.json.packet.campaign.public_route_slug, "short");
    assert.equal(result.json.context.scaffold.required, false);
  });
}

test("route binding: --adopt follows the installed Page Kit version's assets discovery", async (t) => {
  const p = fixture(t);
  sourceTree(p, ["assets/page.html"]);
  writeJson(join(p.target, "package.json"), { private: true, devDependencies: { "next-campaign-page-kit": "0.2.0" } });
  writeJson(join(p.target, "node_modules/next-campaign-page-kit/package.json"), { version: "0.2.0" });
  const result = await intake(p, ["--adopt", "src/short"]);
  assert.equal(result.error, null, result.error?.stack);
  assert.equal(result.exitCode, 0, result.stdout);
});

for (const paths of [["_includes/fragment.html"], ["_layouts/base.html"], ["assets/fragment.html"], []]) {
  test(`route binding: Funnel does not offer a source without Page Kit pages (${paths[0] || "empty"})`, async (t) => {
    const p = fixture(t);
    sourceTree(p, paths);
    const result = await intake(p, ["--source", p.source]);
    assert.equal(result.error, null, result.error?.stack);
    assert.equal(result.json.funnelBindingOffer, undefined);
  });
}

test("route binding: Funnel text does not offer an include-only source route", async (t) => {
  const p = fixture(t);
  sourceTree(p, ["_includes/fragment.html"]);
  const result = await runCli(["prepare-build", "--spec", p.specPath, "--source", p.source, "--target", p.target,
    "--template-family", "olympus", "--no-run-session", "--no-remit"]);
  assert.equal(result.error, null, result.error?.stack);
  assert.doesNotMatch(result.stdout, /To bind this funnel|--adopt src\/short/);
});

for (const [label, paths, offered] of [
  ["includes only", ["_includes/fragment.html"], true],
  ["layouts only", ["_layouts/base.html"], true],
  ["assets HTML only", ["assets/fragment.html"], true],
  ["empty", [], true],
  ["one page", ["index.html"], false],
  ["symlinked page", ["_includes/fragment.html"], false],
]) {
  test(`route binding: Funnel checks Page Kit pages at the destination (${label})`, async (t) => {
    const p = fixture(t);
    sourceTree(p, ["index.html"]);
    const output = join(p.target, "src/long-campaign-name");
    mkdirSync(output, { recursive: true });
    for (const path of paths) {
      mkdirSync(dirname(join(output, path)), { recursive: true });
      writeFileSync(join(output, path), "<html><body>Example page</body></html>");
    }
    if (label === "symlinked page") symlinkSync("_includes/fragment.html", join(output, "linked.html"));
    const result = await intake(p, ["--source", p.source]);
    assert.equal(result.error, null, result.error?.stack);
    assert.equal(Boolean(result.json.funnelBindingOffer), offered);
    assert.equal(result.json.context.scaffold.required, false, "un-adopted scaffold rule still tests directory existence");
  });
}

test("route binding: Funnel offers this unclaimed source route instead of the first funnel's rename", async (t) => {
  const p = fixture(t);
  writeJson(join(p.target, "campaign-runtime.build.json"), { campaign: { public_route_slug: "first" }, assembly: {} });
  writeJson(join(p.target, ".campaign-runtime/assembly-report.json"), { identity: { public_route_slug: "first" } });
  const result = await runCli(["prepare-build", "--spec", p.specPath, "--source", p.source, "--target", p.target,
    "--template-family", "olympus", "--no-run-session", "--no-remit"]);
  assert.equal(result.error, null, result.error?.stack);
  const line = result.stdout.split("\n").find((line) => line.startsWith("Funnel:"));
  assert.match(line, /To bind this funnel/);
  assert.match(line, /--adopt src\/short/);
  assert.match(line, /delete .*campaign-runtime-long-campaign-name.build.json and .campaign-runtime\/funnels\/long-campaign-name\//);
  assert.doesNotMatch(line, /rename|--force|--out/);
  t.diagnostic(line);
  // JSON has the same command and cleanup, without relying on rendered prose.
  const json = await intake(p, ["--source", p.source, "--force"]);
  assert.equal(json.error, null, json.error?.stack);
  assert.equal(json.json.funnelBindingOffer.route, "short");
  assert.match(json.json.funnelBindingOffer.command, /--adopt src\/short/);
  const offer = json.json.funnelBindingOffer;
  assert.doesNotMatch(offer.command, /--route|--source/);
  for (const path of offer.deletePaths) rmSync(path, { recursive: true, force: true });
  const words = [...offer.command.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
  const argv = words.slice(words.indexOf("prepare-build"));
  for (let replay = 0; replay < 2; replay += 1) {
    const adopted = await runCli(argv);
    assert.equal(adopted.error, null, adopted.error?.stack);
    assert.equal(adopted.json.context.intake.adopt, "src/short");
    const dsp = readJson(join(dirname(adopted.json.packetPath), adopted.json.packet.design_source_package.path));
    assert.equal(dsp.source_kind, "built_first");
  }
});

test("route binding: a source route already claimed by a packet is not offered", async (t) => {
  const p = fixture(t);
  writeJson(join(p.target, "campaign-runtime.build.json"), { campaign: { public_route_slug: "short" }, assembly: {} });
  const result = await intake(p, ["--source", p.source]);
  assert.equal(result.error, null);
  assert.equal(result.json.funnelBindingOffer, undefined);
  assert.equal(result.json.funnelAddedBeside.route, "short");
});
