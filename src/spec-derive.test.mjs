import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { checkpointWaive, doctorPacket, specDeriveCommand, specDeriveTextLines } from "./cli.mjs";
import { DOCTOR_SIDECAR_REL_PATH } from "./doctor-sidecar.mjs";
import { entryInScaffoldState, evaluatePageKitSdkVersion, SPEC_DERIVE_COMMAND } from "./page-kit-sdk-version.mjs";
import { stageRealPackageInstall } from "./package-install-fixture.mjs";
import {
  ANALYTICS_ID_FIELDS,
  applySpecDerive,
  formatDeriveValue,
  pageRouteForFile,
  planSpecDerive,
  SPEC_DERIVE_FIELDS,
} from "./spec-derive.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const EXAMPLES = new URL("../examples/", import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// A configured entry (no starter demo residue) whose pin and analytics ids
// the repo states; the example spec pins 0.4.18 and declares no analytics.
const CONFIGURED_ENTRY = Object.freeze({
  name: "Runtime Packet Demo",
  description: "Olympus checkout funnel",
  entry_url: "landing",
  sdk_version: "0.4.38",
  store_name: "Example Store",
  store_url: "https://store.example.com",
  store_terms: "https://store.example.com/terms",
  store_privacy: "https://store.example.com/privacy",
  store_contact: "https://store.example.com/contact",
  store_returns: "https://store.example.com/returns",
  store_shipping: "https://store.example.com/shipping",
  store_phone: "1-800-555-0100",
  store_phone_tel: "tel:+18005550100",
  gtm_id: "GTM-ABC1234",
  fb_pixel_id: "123456789012345",
  og_image: "",
});

// What campaign-init seeds: the starter's demo profile beside its pin.
const SCAFFOLD_ENTRY = Object.freeze({
  ...CONFIGURED_ENTRY,
  store_url: "https://demo.29next.com/",
  store_phone_tel: "tel:+18888316810",
  gtm_id: "",
  fb_pixel_id: "",
});

const PAGE_FILES = Object.freeze([
  { path: "checkout.html", basename: "checkout", route: "checkout/", permalink: null },
  { path: "landing.html", basename: "landing", route: "landing/", permalink: null },
  { path: "receipt.html", basename: "receipt", route: "receipt/", permalink: null },
  { path: "upsell.html", basename: "upsell", route: "upsell/", permalink: null },
]);

function specFixture(patch = null) {
  const spec = readJson(new URL("campaignspec.v42.basic.json", EXAMPLES));
  if (patch) patch(spec);
  return spec;
}

// The example spec's four pages carry the routes the tree states, so a
// plan against the configured entry moves only the pin and the two ids.
test("planSpecDerive diffs the pin and the analytics ids, and leaves routes the tree already states unchanged", () => {
  const plan = planSpecDerive({ spec: specFixture(), entry: CONFIGURED_ENTRY, pageFiles: PAGE_FILES, publicRouteSlug: "runtime-packet-demo" });
  assert.deepEqual(plan.changes.map((row) => [row.field, row.before, row.after]), [
    ["global_config.sdk_version", "0.4.18", "0.4.38"],
    ["analytics.providers.gtm.containerId", undefined, "GTM-ABC1234"],
    ["analytics.providers.facebook.pixelId", undefined, "123456789012345"],
  ]);
  assert.equal(plan.changes[0].source, "_data/campaigns.json[runtime-packet-demo].sdk_version");
  assert.equal(plan.changes[1].source, "_data/campaigns.json[runtime-packet-demo].gtm_id");
  assert.deepEqual(plan.unchanged.map((row) => row.field), [
    "funnels[0].pages[0].page_url", "funnels[0].pages[1].page_url", "funnels[0].pages[2].page_url", "funnels[0].pages[3].page_url",
  ]);
  assert.deepEqual(plan.unchanged.map((row) => row.source), ["landing.html", "checkout.html", "upsell.html", "receipt.html"]);
  assert.deepEqual(plan.not_derived, []);
  assert.deepEqual(plan.not_in_target, []);
  assert.deepEqual(plan.stale_hints, []);
});

test("planSpecDerive writes the alias pin too when the spec declares it, and reports a spec pin ahead of the repo as a downgrade", () => {
  const spec = specFixture((draft) => {
    draft.global_config.sdk_version = "0.4.40";
    draft.runtime = { sdk_version: "0.4.40" };
  });
  const plan = planSpecDerive({ spec, entry: CONFIGURED_ENTRY, pageFiles: PAGE_FILES });
  const pins = plan.changes.filter((row) => row.field.endsWith("sdk_version"));
  assert.deepEqual(pins.map((row) => [row.field, row.before, row.after, row.downgrade]), [
    ["global_config.sdk_version", "0.4.40", "0.4.38", { from: "0.4.40" }],
    ["runtime.sdk_version", "0.4.40", "0.4.38", { from: "0.4.40" }],
  ]);
  // A conflicting pair is resolved by the repo pin, not refused: both end equal.
  const conflicting = specFixture((draft) => { draft.runtime = { sdk_version: "0.4.20" }; });
  const resolved = planSpecDerive({ spec: conflicting, entry: CONFIGURED_ENTRY, pageFiles: PAGE_FILES });
  assert.deepEqual(resolved.changes.filter((row) => row.field.endsWith("sdk_version")).map((row) => [row.field, row.after, row.downgrade]), [
    ["global_config.sdk_version", "0.4.38", undefined],
    ["runtime.sdk_version", "0.4.38", undefined],
  ]);
});

test("planSpecDerive derives a renamed route from the tree, mirrors it into funnel_pages, and flags the routing hint that now points at the old route", () => {
  const spec = specFixture((draft) => {
    draft.funnel_pages = draft.funnels[0].pages.map((page) => ({ ...page, _funnel_id: draft.funnels[0].id }));
  });
  const tree = PAGE_FILES.map((file) => (file.path === "upsell.html" ? { ...file, route: "upsell-1/", permalink: "/runtime-packet-demo/upsell-1/" } : file));
  const plan = planSpecDerive({ spec, entry: CONFIGURED_ENTRY, pageFiles: tree, publicRouteSlug: "runtime-packet-demo" });
  const routes = plan.changes.filter((row) => row.field.endsWith("page_url"));
  assert.deepEqual(routes.map((row) => [row.field, row.page_id, row.before, row.after, row.source]), [
    ["funnels[0].pages[2].page_url", "upsell", "upsell/", "upsell-1/", "upsell.html (permalink)"],
    ["funnel_pages[2].page_url", "upsell", "upsell/", "upsell-1/", "mirror of funnels[0].pages[2].page_url"],
  ]);
  // The checkout's next-success-url hint names the upsell's old route.
  assert.deepEqual(plan.stale_hints, [{ page_id: "checkout", tag: "next-success-url", value: "upsell/", target_page_id: "upsell", derived_route: "upsell-1/" }]);
});

test("planSpecDerive binds a page by the packet projection first, then by route or id, and refuses an ambiguous or unbound page", () => {
  const spec = specFixture((draft) => { draft.funnels[0].pages[2].page_url = "offer/"; });
  // The packet says the upsell page was written to upsell-1.html.
  const tree = [...PAGE_FILES.filter((file) => file.path !== "upsell.html"), { path: "upsell-1.html", basename: "upsell-1", route: "upsell-1/", permalink: null }];
  const bound = planSpecDerive({ spec, entry: CONFIGURED_ENTRY, pageFiles: tree, packetBindings: new Map([["upsell", "upsell-1.html"]]) });
  assert.deepEqual(bound.changes.filter((row) => row.page_id).map((row) => [row.page_id, row.after, row.source]), [["upsell", "upsell-1/", "upsell-1.html"]]);
  // Without the projection nothing binds: not derived, page left as it is.
  const unbound = planSpecDerive({ spec, entry: CONFIGURED_ENTRY, pageFiles: tree });
  assert.deepEqual(unbound.not_derived.map((row) => [row.field, row.page_id, row.reason]), [["funnels[0].pages[2].page_url", "upsell", "page_file_not_found"]]);
  assert.match(unbound.not_derived[0].detail, /"offer\/"/);
  // Two files that could both be the page: refused by name.
  const twice = [...tree, { path: "offers/upsell.html", basename: "upsell", route: "offers/upsell/", permalink: null }];
  const ambiguous = planSpecDerive({ spec, entry: CONFIGURED_ENTRY, pageFiles: [...twice, { path: "offer.html", basename: "offer", route: "offer/", permalink: null }] });
  assert.deepEqual(ambiguous.not_derived.map((row) => [row.page_id, row.reason]), [["upsell", "page_file_ambiguous"]]);
  assert.match(ambiguous.not_derived[0].detail, /offer\.html, offers\/upsell\.html/);
  // A route that differs only in spelling is the same route: unchanged.
  const spelled = specFixture((draft) => { draft.funnels[0].pages[1].page_url = "/checkout"; });
  const same = planSpecDerive({ spec: spelled, entry: CONFIGURED_ENTRY, pageFiles: PAGE_FILES });
  assert.ok(same.unchanged.some((row) => row.page_id === "checkout"));
  // No page tree at all: every page is reported, none invented.
  const noTree = planSpecDerive({ spec: specFixture(), entry: CONFIGURED_ENTRY, pageFiles: null });
  assert.deepEqual(noTree.not_derived.map((row) => row.reason), ["page_tree_missing", "page_tree_missing", "page_tree_missing", "page_tree_missing"]);
});

test("planSpecDerive names why the pin cannot be derived: missing, unreleased, a scaffold's seed, or a named-human waiver", () => {
  const spec = specFixture();
  const missing = planSpecDerive({ spec, entry: { ...CONFIGURED_ENTRY, sdk_version: undefined }, pageFiles: PAGE_FILES });
  assert.deepEqual(missing.not_derived.map((row) => [row.field, row.reason]), [["global_config.sdk_version", "target_missing"]]);
  const invalid = planSpecDerive({ spec, entry: { ...CONFIGURED_ENTRY, sdk_version: "0.4.38-beta.1" }, pageFiles: PAGE_FILES });
  assert.deepEqual(invalid.not_derived.map((row) => row.reason), ["target_invalid"]);
  assert.ok(entryInScaffoldState(SCAFFOLD_ENTRY));
  const scaffold = planSpecDerive({ spec, entry: SCAFFOLD_ENTRY, pageFiles: PAGE_FILES });
  assert.deepEqual(scaffold.not_derived.map((row) => row.reason), ["scaffold_seed"]);
  assert.match(scaffold.not_derived[0].detail, /page-kit sync/);
  const waived = planSpecDerive({ spec, entry: CONFIGURED_ENTRY, pageFiles: PAGE_FILES, waivedGates: [{ scope: "page_kit.sdk_version", waived_by: "Jordan Lee" }] });
  assert.deepEqual(waived.not_derived.map((row) => row.reason), ["waived"]);
  assert.match(waived.not_derived[0].detail, /Jordan Lee/);
  assert.equal(waived.changes.some((row) => row.field.endsWith("sdk_version")), false);
});

test("planSpecDerive never deletes a spec analytics id, and refuses a malformed repo id", () => {
  const spec = specFixture((draft) => {
    draft.analytics = { providers: { gtm: { enabled: true, containerId: "GTM-OLD0000" }, facebook: { enabled: true, pixelId: "999999999" } } };
  });
  const empty = planSpecDerive({ spec, entry: { ...CONFIGURED_ENTRY, gtm_id: "", fb_pixel_id: "  " }, pageFiles: PAGE_FILES });
  assert.deepEqual(empty.not_derived.map((row) => [row.field, row.reason]), [
    ["analytics.providers.gtm.containerId", "target_empty"],
    ["analytics.providers.facebook.pixelId", "target_empty"],
  ]);
  assert.match(empty.not_derived[0].detail, /"GTM-OLD0000"/);
  const malformed = planSpecDerive({ spec, entry: { ...CONFIGURED_ENTRY, gtm_id: "not a container", fb_pixel_id: ["1"] }, pageFiles: PAGE_FILES });
  assert.deepEqual(malformed.not_derived.map((row) => [row.field, row.reason]), [
    ["analytics.providers.gtm.containerId", "target_invalid"],
    ["analytics.providers.facebook.pixelId", "target_invalid"],
  ]);
  assert.match(malformed.not_derived[1].detail, /is an array/);
  // An id the repo carries overwrites an authored-looking spec id: the
  // field is derived, and the diff line says so.
  const moved = planSpecDerive({ spec, entry: CONFIGURED_ENTRY, pageFiles: PAGE_FILES });
  assert.deepEqual(moved.changes.filter((row) => row.field.startsWith("analytics")).map((row) => [row.before, row.after]), [["GTM-OLD0000", "GTM-ABC1234"], ["999999999", "123456789012345"]]);
  // Absent on both sides: the field is simply not in the target.
  const neither = planSpecDerive({ spec: specFixture(), entry: { ...CONFIGURED_ENTRY, gtm_id: undefined, fb_pixel_id: null }, pageFiles: PAGE_FILES });
  assert.deepEqual(neither.not_in_target, ANALYTICS_ID_FIELDS.map((row) => `analytics.providers.${row.provider}.${row.property}`));
});

test("applySpecDerive edits only the named paths, creates missing containers, and refuses anything outside the derived fields", () => {
  const spec = specFixture();
  delete spec.global_config;
  const before = JSON.stringify(spec);
  const plan = planSpecDerive({ spec: JSON.parse(before), entry: CONFIGURED_ENTRY, pageFiles: PAGE_FILES });
  applySpecDerive(spec, plan);
  assert.deepEqual(spec.global_config, { sdk_version: "0.4.38" });
  assert.deepEqual(spec.analytics, { providers: { gtm: { enabled: true, containerId: "GTM-ABC1234" }, facebook: { enabled: true, pixelId: "123456789012345" } } });
  // Key order of an existing page survives an in-place route write.
  const renamed = specFixture();
  const keys = Object.keys(renamed.funnels[0].pages[2]);
  applySpecDerive(renamed, { changes: [{ field: "funnels[0].pages[2].page_url", path: ["funnels", 0, "pages", 2, "page_url"], after: "upsell-1/" }] });
  assert.equal(renamed.funnels[0].pages[2].page_url, "upsell-1/");
  assert.deepEqual(Object.keys(renamed.funnels[0].pages[2]), keys);
  assert.throws(() => applySpecDerive(specFixture(), { changes: [{ field: "campaign.store_url", path: ["campaign", "store_url"], after: "https://x.example" }] }), /Refusing to write "campaign.store_url"/);
  assert.throws(() => applySpecDerive(specFixture(), { changes: [{ field: "funnels[0].pages[9].page_url", path: ["funnels", 0, "pages", 9, "page_url"], after: "x/" }] }), /is not an object/);
  assert.throws(() => applySpecDerive(specFixture((draft) => { draft.analytics = "off"; }), { changes: [{ field: "analytics.providers.gtm.containerId", path: ["analytics", "providers", "gtm", "containerId"], after: "GTM-ABC1234" }] }), /analytics is not an object/);
  assert.deepEqual(SPEC_DERIVE_FIELDS, ["global_config.sdk_version", "runtime.sdk_version", "funnels[].pages[].page_url", "funnel_pages[].page_url", "analytics.providers.gtm.containerId", "analytics.providers.facebook.pixelId"]);
  assert.equal(formatDeriveValue(undefined), "(absent)");
  assert.equal(formatDeriveValue(""), "\"\"");
});

test("pageRouteForFile follows page-kit's filename rule, honours a permalink, and skips what page-kit does not render", () => {
  assert.equal(pageRouteForFile("checkout.html"), "checkout/");
  assert.equal(pageRouteForFile("index.html"), "");
  assert.equal(pageRouteForFile("offers/index.html"), "offers/");
  assert.equal(pageRouteForFile("offers/upsell.html"), "offers/upsell/");
  assert.equal(pageRouteForFile("upsell.html", { permalink: "/acme/upsell-1/", publicRouteSlug: "acme" }), "upsell-1/");
  assert.equal(pageRouteForFile("upsell.html", { permalink: "upsell-1/index.html" }), "upsell-1/");
  assert.equal(pageRouteForFile("_includes/header.html"), null);
  assert.equal(pageRouteForFile("_layouts/base.html"), null);
  assert.equal(pageRouteForFile("assets/x.html"), null);
  assert.equal(pageRouteForFile("_draft.html"), null);
  assert.equal(pageRouteForFile("notes.md"), null);
});

// A campaign folder with a target page-kit repo whose page tree carries the
// example spec's four pages, a configured entry, and an assembly report.
function fixture({ entry = CONFIGURED_ENTRY, spec: specPatch = null, tree = ["landing", "checkout", "upsell", "receipt"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "spec-derive-"));
  for (const file of ["build-packet.basic.json", "campaignspec.v42.basic.json"]) {
    cpSync(new URL(file, EXAMPLES), join(dir, file));
  }
  cpSync(new URL("source-html", EXAMPLES), join(dir, "source-html"), { recursive: true });
  cpSync(new URL("target-page-kit", EXAMPLES), join(dir, "target-page-kit"), { recursive: true });
  mkdirSync(join(dir, "contracts"), { recursive: true });
  cpSync(new URL("../contracts/commerce-surface-catalog.json", import.meta.url), join(dir, "contracts/commerce-surface-catalog.json"));

  const packetPath = join(dir, "build-packet.basic.json");
  const packet = readJson(packetPath);
  packet.assembly.commerce_catalog.path = "contracts/commerce-surface-catalog.json";
  packet.assembly.commerce_catalog.required = false;
  packet.deploy.preview_url = "https://preview.merchant-shop.com/runtime-packet-demo/";
  const targetRepo = join(dir, "target-page-kit");
  const specPath = join(dir, "campaignspec.v42.basic.json");
  const spec = readJson(specPath);
  if (specPatch) specPatch(spec);
  writeJson(specPath, spec);

  const briefRelPath = "target-page-kit/.campaign-runtime/input/campaign-build-brief.normalized.json";
  packet.build_brief = { normalized_path: briefRelPath, status: "complete" };
  writeJson(packetPath, packet);
  writeJson(join(dir, briefRelPath), {
    schema_version: "campaigns-os-build-brief/v1",
    status: "complete",
    _meta: { mode: "guided_draft" },
    questions: [],
    gates: [],
    commerce_surfaces: { payment_methods_allowed: ["card"], hidden_payment_methods: [] },
    promo_urgency: { forbid_placeholders: true },
    template_residue_policy: { block_placeholders: true },
  });

  const slug = packet.campaign.public_route_slug;
  const campaignsPath = join(targetRepo, "_data/campaigns.json");
  const campaigns = readJson(campaignsPath);
  if (entry) campaigns[slug] = { ...entry };
  else delete campaigns[slug];
  campaigns["other-route"] = { name: "Other", store_url: "https://demo.29next.com/", sdk_version: "0.4.38" };
  writeJson(campaignsPath, campaigns);
  const pageTree = join(targetRepo, "src", slug);
  mkdirSync(join(pageTree, "_includes"), { recursive: true });
  writeFileSync(join(pageTree, "_includes", "header.html"), "<header></header>\n");
  for (const name of tree) writeFileSync(join(pageTree, `${name}.html`), `---\npage_layout: base.html\npage_type: product\n---\n<h1>${name}</h1>\n`);

  const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
  const report = readJson(new URL("assembly-report.example.json", EXAMPLES));
  report.identity.map_id = packet.spec.map_id;
  report.identity.public_route_slug = slug;
  report.stages.setup.status = "skipped";
  report.stages.deploy.status = "skipped";
  report.evidence = [];
  writeJson(reportPath, report);
  return { dir, packetPath, targetRepo, specPath, campaignsPath, pageTree, reportPath, slug };
}

function sdkGate(result) {
  return result.derived.checkpoint_gates.find((gate) => gate.id === "page_kit.sdk_version");
}

test("spec derive writes the repo pin and ids into the spec, touches nothing else, and clears the repo_newer advisory", () => {
  const { dir, packetPath, specPath } = fixture();
  try {
    const original = readJson(specPath);
    const before = doctorPacket(packetPath);
    assert.equal(sdkGate(before).code, "page_kit.sdk_version.repo_newer", "a configured repo ahead of the spec is advisory (#413)");
    assert.deepEqual(sdkGate(before).advisory_actions.map((action) => [action.id, action.kind, action.command]), [["refresh_spec", "command", SPEC_DERIVE_COMMAND]]);

    const result = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.equal(result.ok, true);
    assert.equal(result.status, "derived");
    assert.equal(result.written, true);
    assert.deepEqual(result.changes.map((row) => [row.field, row.before, row.after]), [
      ["global_config.sdk_version", "0.4.18", "0.4.38"],
      ["analytics.providers.gtm.containerId", undefined, "GTM-ABC1234"],
      ["analytics.providers.facebook.pixelId", undefined, "123456789012345"],
    ]);
    assert.equal(result.spec_path, realpathSync(specPath));
    assert.equal(result.page_tree, "src/runtime-packet-demo");
    assert.equal(result.next, `campaigns-os doctor --packet ${packetPath}`);

    const written = readJson(specPath);
    assert.equal(written.global_config.sdk_version, "0.4.38");
    assert.deepEqual(written.analytics, { providers: { gtm: { enabled: true, containerId: "GTM-ABC1234" }, facebook: { enabled: true, pixelId: "123456789012345" } } });
    assert.deepEqual(Object.keys(written), [...Object.keys(original), "analytics"]);
    delete written.analytics;
    written.global_config.sdk_version = original.global_config.sdk_version;
    assert.deepEqual(written, original, "nothing outside the derived fields moved");

    const after = doctorPacket(packetPath);
    assert.equal(sdkGate(after).code, "page_kit.sdk_version.pass");
    const again = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.equal(again.status, "unchanged");
    assert.equal(again.written, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive --dry-run prints the diff and writes nothing; the CLI text and --json agree", () => {
  const { dir, packetPath, specPath } = fixture();
  try {
    const before = readFileSync(specPath, "utf8");
    const result = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath, "dry-run": true });
    assert.equal(result.status, "dry_run");
    assert.equal(result.written, false);
    assert.equal(result.changes.length, 3);
    assert.equal(readFileSync(specPath, "utf8"), before);
    const lines = specDeriveTextLines(result);
    assert.equal(lines[0], "Status: DRY RUN");
    assert.ok(lines.includes("Changes (dry run, nothing written): 3"));
    assert.ok(lines.includes("- global_config.sdk_version: \"0.4.18\" -> \"0.4.38\"  (from _data/campaigns.json[runtime-packet-demo].sdk_version)"));
    assert.ok(lines.some((line) => line.startsWith("Unchanged: funnels[0].pages[0].page_url")));

    const cli = execFileSync("node", [CLI, "spec", "derive", "--packet", packetPath, "--dry-run"], { encoding: "utf8" });
    assert.equal(cli, `${lines.join("\n")}\n`);
    const json = JSON.parse(execFileSync("node", [CLI, "spec", "derive", "--packet", packetPath, "--json", "--dry-run"], { encoding: "utf8" }));
    assert.equal(json.action, "spec derive");
    assert.equal(json.status, "dry_run");
    assert.deepEqual(json.changes.map((row) => row.field), result.changes.map((row) => row.field));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive exits 2 with a result document when the spec, the packet or the entry is missing, and writes nothing", () => {
  const { dir, packetPath, specPath, campaignsPath, slug } = fixture();
  try {
    const packet = readJson(packetPath);
    packet.spec.local_path = "missing.json";
    writeJson(packetPath, packet);
    const noSpec = spawnSync("node", [CLI, "spec", "derive", "--packet", packetPath, "--json"], { encoding: "utf8" });
    assert.equal(noSpec.status, 2);
    const parsed = JSON.parse(noSpec.stdout);
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.errors.map((issue) => issue.code), ["spec.derive.spec_missing"]);
    assert.match(parsed.errors[0].message, /missing\.json/);

    delete packet.spec.local_path;
    writeJson(packetPath, packet);
    const noPath = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.deepEqual(noPath.errors.map((issue) => issue.code), ["spec.derive.spec_missing"]);
    assert.match(noPath.errors[0].message, /spec\.local_path/);

    packet.spec.local_path = "campaignspec.v42.basic.json";
    writeJson(packetPath, packet);
    const before = readFileSync(specPath, "utf8");
    const campaigns = readJson(campaignsPath);
    delete campaigns[slug];
    writeJson(campaignsPath, campaigns);
    const noEntry = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.equal(noEntry.ok, false);
    assert.deepEqual(noEntry.errors.map((issue) => issue.code), ["spec.derive.entry_missing"]);
    assert.equal(noEntry.errors[0].detail.target_status, "entry_missing");
    assert.equal(readFileSync(specPath, "utf8"), before);

    writeFileSync(packetPath, "{not json");
    const bad = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.deepEqual(bad.errors.map((issue) => issue.code), ["spec.derive.packet_invalid"]);
    const text = specDeriveTextLines(bad);
    assert.equal(text[0], "Status: BLOCKED");
    assert.ok(text.includes("Errors:"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive refuses a spec that identifies another campaign, and a non-object spec, writing nothing", () => {
  const { dir, packetPath, specPath } = fixture({ spec: (spec) => { spec.spec_identity.public_route_slug = "someone-else"; } });
  try {
    const before = readFileSync(specPath, "utf8");
    const result = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((issue) => issue.code), ["spec.derive.spec_identity_mismatch"]);
    assert.match(result.errors[0].message, /"someone-else"/);
    assert.equal(readFileSync(specPath, "utf8"), before);

    writeFileSync(specPath, "[]\n");
    const array = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.deepEqual(array.errors.map((issue) => issue.code), ["spec.derive.spec_invalid"]);
    assert.match(array.errors[0].message, /not an array/);
    writeFileSync(specPath, "{\n");
    const broken = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.deepEqual(broken.errors.map((issue) => issue.code), ["spec.derive.spec_invalid"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive is partial, not blocked, when a page cannot be bound, and still writes what the repo states", () => {
  const { dir, packetPath, specPath } = fixture({ tree: ["landing", "checkout", "upsell-1", "receipt"] });
  try {
    const result = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.equal(result.ok, true);
    assert.equal(result.status, "partial");
    assert.equal(result.written, true);
    assert.deepEqual(result.not_derived.map((row) => [row.page_id, row.reason]), [["upsell", "page_file_not_found"]]);
    assert.deepEqual(result.warnings.map((issue) => issue.code), ["spec.derive.page_file_not_found"]);
    assert.equal(result.warnings[0].detail.page_id, "upsell");
    assert.equal(readJson(specPath).global_config.sdk_version, "0.4.38");
    assert.equal(readJson(specPath).funnels[0].pages[2].page_url, "upsell/", "the unbound page keeps its route");
    const lines = specDeriveTextLines(result);
    assert.equal(lines[0], "Status: PARTIAL");
    assert.ok(lines.some((line) => line.startsWith("Partial: funnels[0].pages[2].page_url could not be derived")));

    // The packet's own projection binds the renamed file, and the route moves.
    const packet = readJson(packetPath);
    packet.source_html.pages.find((page) => page.page_id === "upsell").page_kit.target_path = "upsell-1.html";
    writeJson(packetPath, packet);
    const bound = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.equal(bound.status, "derived");
    assert.deepEqual(bound.changes.map((row) => [row.field, row.before, row.after, row.source]), [["funnels[0].pages[2].page_url", "upsell/", "upsell-1/", "upsell-1.html"]]);
    assert.deepEqual(bound.warnings.map((issue) => issue.code), ["spec.derive.routing_hint_stale"]);
    assert.match(bound.warnings[0].message, /page "checkout" carries sdk_hints\.meta_tags\.next-success-url "upsell\/"/);
    assert.equal(readJson(specPath).funnels[0].pages[2].page_url, "upsell-1/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive reports a missing page tree per page and a scaffold's seeded pin, and writes the ids it can", () => {
  const { dir, packetPath, pageTree, specPath } = fixture({ entry: { ...SCAFFOLD_ENTRY, gtm_id: "GTM-ABC1234" } });
  try {
    rmSync(pageTree, { recursive: true, force: true });
    const result = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.equal(result.status, "partial");
    assert.deepEqual(result.not_derived.map((row) => row.reason), ["scaffold_seed", "page_tree_missing", "page_tree_missing", "page_tree_missing", "page_tree_missing"]);
    assert.deepEqual(result.changes.map((row) => row.field), ["analytics.providers.gtm.containerId"]);
    assert.deepEqual(result.not_in_target, ["analytics.providers.facebook.pixelId"]);
    assert.equal(readJson(specPath).global_config.sdk_version, "0.4.18", "the seeded pin never reaches the spec");
    assert.equal(readJson(specPath).analytics.providers.gtm.containerId, "GTM-ABC1234");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive leaves the pin alone while a named-human waiver covers it, and says who waived it", () => {
  // The repo is BEHIND the spec, so the gate is a waivable exact mismatch.
  const { dir, packetPath, specPath, targetRepo } = fixture({ entry: { ...CONFIGURED_ENTRY, sdk_version: "0.4.16" } });
  try {
    mkdirSync(join(targetRepo, ".campaign-runtime"), { recursive: true });
    const recorded = checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: packetPath,
      gate: "page_kit.sdk_version",
      reason: "Intentional pin for compatibility testing",
      "waived-by": "Jordan Lee",
      "review-condition": "Re-evaluate before production launch",
    });
    assert.equal(recorded.gate, "page_kit.sdk_version");
    const result = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.equal(result.status, "partial");
    assert.deepEqual(result.not_derived.map((row) => [row.field, row.reason]), [["global_config.sdk_version", "waived"]]);
    assert.match(result.not_derived[0].detail, /Jordan Lee/);
    assert.equal(readJson(specPath).global_config.sdk_version, "0.4.18", "the waived pair is exactly as the human accepted it");
    assert.ok(result.report_path.endsWith("assembly-report.json"));
    assert.equal(sdkGate(doctorPacket(packetPath)).status, "waived", "derive did not disturb the waiver");

    // Without the waiver the repo pin wins even though it is behind, and the
    // downgrade is flagged.
    writeJson(result.report_path, { ...readJson(result.report_path), waivers: [] });
    const derived = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.equal(derived.status, "derived");
    assert.deepEqual(derived.changes.map((row) => [row.field, row.before, row.after, row.downgrade]), [["global_config.sdk_version", "0.4.18", "0.4.16", { from: "0.4.18" }]]);
    assert.ok(derived.warnings.some((issue) => issue.code === "spec.derive.sdk_version_downgraded"));
    assert.equal(readJson(specPath).global_config.sdk_version, "0.4.16");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive keeps the file's indentation, line endings, trailing newline and permission bits", () => {
  const { dir, packetPath, specPath } = fixture();
  try {
    const spec = readJson(specPath);
    writeFileSync(specPath, JSON.stringify(spec, null, "\t").replace(/\n/g, "\r\n"));
    chmodSync(specPath, 0o600);
    const result = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.equal(result.status, "derived");
    assert.equal(result.warnings.some((issue) => issue.code === "spec.derive.file_reformatted"), false, "a tab-indented CRLF file round-trips exactly");
    const text = readFileSync(specPath, "utf8");
    assert.match(text, /^\{\r\n\t"schema_version"/);
    assert.ok(!text.includes("\n\n") && !/[^\r]\n/.test(text), "every line ending stays CRLF");
    assert.doesNotMatch(text, /\r\n$/, "no trailing newline was added");
    assert.equal(JSON.parse(text).global_config.sdk_version, "0.4.38");
    assert.equal(statSync(specPath).mode & 0o777, 0o600);
    assert.equal(JSON.parse(text).funnels[0].pages[2].page_url, "upsell/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive refuses to write through a symlink that leaves the campaign's boundary, and follows one that stays inside", () => {
  const { dir, packetPath, specPath, targetRepo } = fixture();
  try {
    const outside = mkdtempSync(join(tmpdir(), "spec-derive-outside-"));
    const outsideFile = join(outside, "spec.json");
    const original = readFileSync(specPath, "utf8");
    writeFileSync(outsideFile, original);
    rmSync(specPath);
    symlinkSync(outsideFile, specPath);
    const result = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((issue) => issue.code), ["spec.derive.spec_escapes_boundary"]);
    assert.equal(readFileSync(outsideFile, "utf8"), original);
    assert.ok(lstatSync(specPath).isSymbolicLink(), "the link itself is untouched");
    rmSync(outside, { recursive: true, force: true });

    // A link into the target repo is followed: the destination is rewritten
    // and the link stays a link.
    rmSync(specPath);
    const insideFile = join(targetRepo, ".campaigns-os", "campaign.spec.json");
    mkdirSync(dirname(insideFile), { recursive: true });
    writeFileSync(insideFile, original);
    symlinkSync(insideFile, specPath);
    const ok = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.equal(ok.status, "derived");
    assert.equal(ok.spec_path, realpathSync(insideFile));
    assert.ok(lstatSync(specPath).isSymbolicLink());
    assert.equal(readJson(insideFile).global_config.sdk_version, "0.4.38");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive stamps the retained doctor sidecar stale after a write, warns about a terminal build, and leaves both alone on dry-run", () => {
  const { dir, packetPath, targetRepo, reportPath } = fixture();
  try {
    const sidecarPath = join(targetRepo, DOCTOR_SIDECAR_REL_PATH);
    const sidecar = { schema_version: "campaigns-os-doctor-output/v1", ok: true, status: "ready_with_warnings", warnings: [{ code: "page_kit.sdk_version.repo_newer" }] };
    writeJson(sidecarPath, sidecar);
    const dry = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath, "dry-run": true });
    assert.equal(dry.status, "dry_run");
    assert.deepEqual(readJson(sidecarPath), sidecar, "a dry run changes no doctor input, so the snapshot stays as it was");

    const report = readJson(reportPath);
    report.stages.assembly.status = "completed";
    writeJson(reportPath, report);
    const result = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.equal(result.status, "derived");
    const stamped = readJson(sidecarPath);
    assert.equal(stamped.stale, true);
    assert.equal(stamped.stale_marked_by, "spec derive");
    assert.match(stamped.stale_reason, /spec derive rewrote the CampaignSpec/);
    assert.deepEqual(stamped.warnings, sidecar.warnings, "the original fields survive the stamp");
    assert.ok(result.warnings.some((issue) => issue.code === "spec.derive.build_stale"));
    assert.match(result.next, /then rebuild/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive rejects unknown flags and a valued --dry-run, and names the subcommand form", () => {
  const { dir, packetPath, specPath } = fixture();
  try {
    const before = readFileSync(specPath, "utf8");
    assert.throws(() => specDeriveCommand({ _: ["spec", "derive"], packet: packetPath, dryrun: true }), /Unknown flag for spec derive: --dryrun\..*Known flags: --packet, --dry-run, --json, --report/);
    assert.throws(() => specDeriveCommand({ _: ["spec", "derive"], packet: packetPath, "dry-run": "true" }), /--dry-run takes no value/);
    assert.throws(() => specDeriveCommand({ _: ["spec", "derive"] }), /Missing required --packet/);
    assert.equal(readFileSync(specPath, "utf8"), before);
    const bare = spawnSync("node", [CLI, "spec"], { encoding: "utf8" });
    assert.notEqual(bare.status, 0);
    assert.match(`${bare.stdout}${bare.stderr}`, /Unknown spec subcommand\. Use: campaigns-os spec derive --packet/);
    const explicit = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath, report: join(dir, "nope.json"), "dry-run": true });
    assert.ok(explicit.warnings.some((issue) => issue.code === "spec.derive.report_unreadable"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive spells its doctor pointer with the consumer install's npx prefix", () => {
  const installRoot = realpathSync(mkdtempSync(join(tmpdir(), "campaigns-os-pkg-derive-")));
  const { dir, packetPath } = fixture();
  try {
    const pkgCli = join(stageRealPackageInstall(installRoot), "bin", "campaigns-os.mjs");
    const env = { ...process.env, PATH: "/usr/bin:/bin" };
    const run = spawnSync(process.execPath, [pkgCli, "spec", "derive", "--packet", packetPath, "--dry-run"], { cwd: installRoot, encoding: "utf8", env });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^Next: npx campaigns-os doctor --packet /m);
    assert.doesNotMatch(run.stdout, /(?<!npx )campaigns-os doctor/);
    const checkout = spawnSync("node", [CLI, "spec", "derive", "--packet", packetPath, "--dry-run"], { encoding: "utf8" });
    assert.match(checkout.stdout, /^Next: campaigns-os doctor --packet /m);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the sdk gate's repo_newer advisory names spec derive as a command, and QA projects it unchanged", () => {
  const gate = evaluatePageKitSdkVersion({
    spec: { global_config: { sdk_version: "0.4.37" } },
    targetLoad: { status: "ok", public_route_slug: "demo", target_path: "_data/campaigns.json", entry: { ...CONFIGURED_ENTRY, sdk_version: "0.4.38" } },
  });
  assert.equal(gate.code, "page_kit.sdk_version.repo_newer");
  assert.deepEqual(gate.advisory_actions.map((action) => [action.id, action.kind, action.command]), [["refresh_spec", "command", SPEC_DERIVE_COMMAND]]);
  assert.match(gate.advisory_actions[0].description, /0\.4\.38/);
  assert.doesNotMatch(gate.reason, /campaigns-os /, "the printed reason carries no bare command; the action does");
});

// Second pass from the ship coverage audit: the branches the first suite left
// to inference.

test("planSpecDerive binds by terminal segment, falls through a packet binding that names no file, and skips disabled or id-less pages", () => {
  const nested = specFixture((draft) => { draft.funnels[0].pages[2].page_url = "offers/upsell/"; });
  const byTerminal = planSpecDerive({ spec: nested, entry: CONFIGURED_ENTRY, pageFiles: PAGE_FILES });
  assert.deepEqual(byTerminal.changes.filter((row) => row.page_id).map((row) => [row.page_id, row.before, row.after, row.source]), [["upsell", "offers/upsell/", "upsell/", "upsell.html"]]);
  const gone = planSpecDerive({ spec: specFixture(), entry: CONFIGURED_ENTRY, pageFiles: PAGE_FILES, packetBindings: new Map([["upsell", "gone.html"]]) });
  assert.equal(gone.unchanged.find((row) => row.page_id === "upsell").source, "upsell.html", "an absent projection target falls through to the tree");
  const skipped = specFixture((draft) => {
    draft.funnels[0].pages[2].enabled = false;
    draft.funnels[0].pages.push({ type: "landing", page_url: "nameless/" });
  });
  const plan = planSpecDerive({ spec: skipped, entry: CONFIGURED_ENTRY, pageFiles: PAGE_FILES.filter((file) => file.path !== "upsell.html") });
  assert.deepEqual(plan.not_derived, [], "a disabled page and a page without an id are not active pages");
  assert.deepEqual([...plan.changes, ...plan.unchanged].filter((row) => row.page_id).map((row) => row.page_id), ["landing", "checkout", "receipt"]);
});

test("planSpecDerive reads funnel_pages[] as the source only when funnels[] is absent, and skips a mirror that already matches", () => {
  const legacy = specFixture((draft) => {
    draft.funnel_pages = draft.funnels[0].pages.map((page) => ({ ...page, page_url: page.id === "upsell" ? "upsell/" : page.page_url }));
    delete draft.funnels;
  });
  const tree = PAGE_FILES.map((file) => (file.path === "upsell.html" ? { ...file, route: "upsell-1/", permalink: "upsell-1/" } : file));
  const plan = planSpecDerive({ spec: legacy, entry: CONFIGURED_ENTRY, pageFiles: tree });
  assert.deepEqual(plan.changes.filter((row) => row.page_id).map((row) => [row.field, row.after]), [["funnel_pages[2].page_url", "upsell-1/"]]);
  assert.ok(plan.unchanged.every((row) => !row.field.startsWith("funnels")));
  // With both blocks, a mirror already at the derived route gets no row.
  const both = specFixture((draft) => {
    draft.funnel_pages = draft.funnels[0].pages.map((page) => ({ ...page, page_url: page.id === "upsell" ? "upsell-1/" : page.page_url }));
  });
  const one = planSpecDerive({ spec: both, entry: CONFIGURED_ENTRY, pageFiles: tree });
  assert.deepEqual(one.changes.filter((row) => row.page_id).map((row) => row.field), ["funnels[0].pages[2].page_url"]);
  // A page with no page_url at all prints an (absent) before.
  const absent = specFixture((draft) => { delete draft.funnels[0].pages[1].page_url; });
  const row = planSpecDerive({ spec: absent, entry: CONFIGURED_ENTRY, pageFiles: PAGE_FILES }).unchanged.find((entry) => entry.page_id === "checkout");
  assert.equal(row, undefined);
  const written = planSpecDerive({ spec: absent, entry: CONFIGURED_ENTRY, pageFiles: PAGE_FILES }).changes.find((entry) => entry.page_id === "checkout");
  assert.equal(written.before, undefined);
  assert.equal(formatDeriveValue(written.before), "(absent)");
});

test("planSpecDerive flags accept/decline hints, skips a hint that already names the derived route, and trims or refuses analytics ids", () => {
  const spec = specFixture((draft) => {
    draft.funnels[0].pages[1].sdk_hints.meta_tags["next-success-url"] = "upsell-1/";
    draft.funnels[0].pages[2].sdk_hints.meta_tags["next-upsell-accept-url"] = "receipt/";
  });
  const tree = PAGE_FILES.map((file) => {
    if (file.path === "upsell.html") return { ...file, route: "upsell-1/", permalink: "upsell-1/" };
    if (file.path === "receipt.html") return { ...file, route: "thanks/", permalink: "thanks/" };
    return file;
  });
  const plan = planSpecDerive({ spec, entry: CONFIGURED_ENTRY, pageFiles: tree, publicRouteSlug: "runtime-packet-demo" });
  assert.deepEqual(plan.stale_hints.map((hint) => [hint.page_id, hint.tag, hint.derived_route]), [
    ["upsell", "next-upsell-accept-url", "thanks/"],
    ["upsell", "next-upsell-decline-url", "thanks/"],
  ], "the checkout hint already names upsell-1/ and is not stale");
  const trimmed = planSpecDerive({ spec: specFixture(), entry: { ...CONFIGURED_ENTRY, gtm_id: " GTM-ABC1234 ", fb_pixel_id: "1234567\n" }, pageFiles: PAGE_FILES });
  assert.equal(trimmed.changes.find((row) => row.field.endsWith("containerId")).after, "GTM-ABC1234");
  assert.deepEqual(trimmed.not_derived.map((row) => [row.field, row.reason]), [["analytics.providers.facebook.pixelId", "target_invalid"]]);
  assert.throws(() => applySpecDerive([], { changes: [] }), /must be a JSON object/);
  assert.throws(() => applySpecDerive({}, { changes: [{ field: "funnels[0].pages[0].page_url", path: ["funnels", 0, "pages", 0, "page_url"], after: "x/" }] }), /funnels is not an array/);
});

test("spec derive reads the page tree from assembly.output_dir, refuses a tree linked outside the repo, and reads a permalink from real frontmatter", () => {
  const { dir, packetPath, targetRepo, pageTree, slug } = fixture();
  try {
    const packet = readJson(packetPath);
    packet.assembly.output_dir = "pages/demo";
    writeJson(packetPath, packet);
    const moved = join(targetRepo, "pages", "demo");
    mkdirSync(dirname(moved), { recursive: true });
    cpSync(pageTree, moved, { recursive: true });
    mkdirSync(join(moved, "offers"));
    writeFileSync(join(moved, "offers", "index.html"), "---\npage_type: product\n---\n");
    writeFileSync(join(moved, "notes.md"), "not a page\n");
    mkdirSync(join(moved, "assets"));
    writeFileSync(join(moved, "assets", "x.html"), "<p/>\n");
    writeFileSync(join(moved, "upsell.html"), "---\npage_type: upsell\npermalink: \"/runtime-packet-demo/upsell-1/\"\n---\n<h1>upsell</h1>\n");
    const result = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath, "dry-run": true });
    assert.equal(result.page_tree, "pages/demo");
    assert.deepEqual(result.changes.filter((row) => row.page_id).map((row) => [row.page_id, row.after, row.source]), [["upsell", "upsell-1/", "upsell.html (permalink)"]]);
    assert.deepEqual(result.not_derived, [], "offers/index.html, assets/ and notes.md bind to nothing and break nothing");

    // The declared tree resolving outside the repo reads as no tree at all.
    rmSync(moved, { recursive: true, force: true });
    const outside = mkdtempSync(join(tmpdir(), "spec-derive-tree-"));
    cpSync(pageTree, outside, { recursive: true });
    symlinkSync(outside, moved);
    const escaped = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath, "dry-run": true });
    assert.ok(escaped.warnings.some((issue) => issue.code === "spec.derive.page_tree_escapes_repo"));
    assert.deepEqual(escaped.not_derived.map((row) => row.reason), ["page_tree_missing", "page_tree_missing", "page_tree_missing", "page_tree_missing"]);
    assert.equal(escaped.status, "partial");
    assert.equal(escaped.public_route_slug, slug);
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive names every malformed target state, a map_id mismatch, a missing route slug and a non-object packet", () => {
  const { dir, packetPath, campaignsPath, specPath, slug } = fixture();
  try {
    const before = readFileSync(specPath, "utf8");
    const original = readFileSync(campaignsPath, "utf8");
    const cases = [
      ["file_missing", () => rmSync(campaignsPath), /Scaffold the campaign first/],
      ["invalid_json", () => writeFileSync(campaignsPath, "{bad"), /not valid JSON/],
      ["root_not_object", () => writeFileSync(campaignsPath, "[]\n"), /root must be an object/],
      ["entry_not_object", () => writeJson(campaignsPath, { [slug]: "x" }), /must be an object/],
    ];
    for (const [status, mutate, pattern] of cases) {
      writeFileSync(campaignsPath, original);
      mutate();
      const result = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
      assert.deepEqual(result.errors.map((issue) => [issue.code, issue.detail.target_status]), [["spec.derive.entry_missing", status]]);
      assert.match(result.errors[0].message, pattern);
    }
    writeFileSync(campaignsPath, original);
    const packet = readJson(packetPath);
    packet.assembly.target_repo = "nowhere";
    writeJson(packetPath, packet);
    const noRepo = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.equal(noRepo.errors[0].detail.target_status, "target_repo_missing");
    assert.match(noRepo.errors[0].message, /Target repo does not exist: nowhere/);

    packet.assembly.target_repo = "target-page-kit";
    packet.spec.map_id = "another-map";
    writeJson(packetPath, packet);
    const mapId = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.deepEqual(mapId.errors.map((issue) => issue.code), ["spec.derive.spec_identity_mismatch"]);
    assert.match(mapId.errors[0].message, /spec_identity\.map_id/);

    delete packet.spec.map_id;
    delete packet.campaign.public_route_slug;
    writeJson(packetPath, packet);
    const noSlug = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.equal(noSlug.public_route_slug, null);
    assert.ok(noSlug.errors.some((issue) => issue.code === "spec.derive.route_slug_missing"));

    writeFileSync(packetPath, "[]\n");
    const array = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.deepEqual(array.errors.map((issue) => issue.code), ["spec.derive.packet_invalid"]);
    assert.match(array.errors[0].message, /must be a JSON object/);
    assert.equal(readFileSync(specPath, "utf8"), before, "no precondition failure touched the spec");
    assert.throws(() => specDeriveCommand({ _: ["spec", "derive"], packet: packetPath, "dry-run=true": true }), /A flag takes its value as the next argument/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive reports a lossy round trip, keeps dry-run partial and a no-change dry run unchanged, and prints every text line", () => {
  const { dir, packetPath, specPath } = fixture({ tree: ["landing", "checkout", "upsell-1", "receipt"] });
  try {
    // Inline arrays do not survive JSON.stringify: the write lands and says so.
    writeFileSync(specPath, readFileSync(specPath, "utf8").replace(/\[\n\s+"card"\n\s+\]/, "[\"card\"]"));
    const partialDry = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath, "dry-run": true });
    assert.equal(partialDry.status, "partial");
    assert.equal(partialDry.written, false);
    const beforeWrite = readFileSync(specPath, "utf8");
    const written = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.ok(written.warnings.some((issue) => issue.code === "spec.derive.file_reformatted"));
    assert.notEqual(readFileSync(specPath, "utf8"), beforeWrite);
    const lines = specDeriveTextLines(written);
    assert.ok(lines.includes("Changes written: 3"));
    assert.ok(lines.some((line) => line === "Warnings:"));
    assert.ok(lines.some((line) => line.startsWith("- [spec.derive.page_file_not_found]")));

    const again = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath, "dry-run": true });
    assert.equal(again.status, "partial", "the unbound page keeps the run partial");
    const packet = readJson(packetPath);
    packet.source_html.pages.find((page) => page.page_id === "upsell").page_kit.target_path = "upsell-1.html";
    writeJson(packetPath, packet);
    specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    const settled = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath, "dry-run": true });
    assert.equal(settled.status, "unchanged", "a dry run with nothing to write is unchanged, not dry_run");
    assert.equal(settled.dry_run, true);
    const settledLines = specDeriveTextLines(settled);
    assert.ok(settledLines.includes("Changes: none (every derived field the repo states already matches)"));
    assert.ok(settledLines.some((line) => line.startsWith("Unchanged: global_config.sdk_version")));

  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive prints the not-in-target line and survives an unreadable report or an unwritable doctor sidecar", { skip: process.getuid?.() === 0 ? "permission tests need a non-root user" : false }, () => {
  const unwritable = fixture({ entry: { ...CONFIGURED_ENTRY, gtm_id: "", fb_pixel_id: "" } });
  const unreadable = fixture();
  try {
    const first = specDeriveCommand({ _: ["spec", "derive"], packet: unwritable.packetPath, "dry-run": true });
    assert.ok(specDeriveTextLines(first).includes("Not in target (left as they are): analytics.providers.gtm.containerId, analytics.providers.facebook.pixelId"));

    // A sidecar that exists in a directory nobody may write to: the spec is
    // still written, and the failed stale stamp is a warning, not a crash.
    const sidecarPath = join(unwritable.targetRepo, DOCTOR_SIDECAR_REL_PATH);
    writeJson(sidecarPath, { schema_version: "campaigns-os-doctor-output/v1", ok: true, status: "ready" });
    chmodSync(dirname(sidecarPath), 0o555);
    try {
      const result = specDeriveCommand({ _: ["spec", "derive"], packet: unwritable.packetPath });
      assert.equal(result.written, true);
      assert.ok(result.warnings.some((issue) => issue.code === "spec.derive.doctor_sidecar_not_marked"), JSON.stringify(result.warnings));
    } finally {
      chmodSync(dirname(sidecarPath), 0o755);
    }

    // A runtime directory nobody may read: the Assembly Report (and its
    // waivers) cannot be consulted, and derive says so and proceeds.
    const runtimeDir = join(unreadable.targetRepo, ".campaign-runtime");
    chmodSync(runtimeDir, 0o000);
    try {
      const result = specDeriveCommand({ _: ["spec", "derive"], packet: unreadable.packetPath });
      assert.equal(result.written, true);
      assert.ok(result.warnings.some((issue) => issue.code === "spec.derive.report_unreadable"), JSON.stringify(result.warnings));
    } finally {
      chmodSync(runtimeDir, 0o755);
    }
  } finally {
    rmSync(unwritable.dir, { recursive: true, force: true });
    rmSync(unreadable.dir, { recursive: true, force: true });
  }
});
