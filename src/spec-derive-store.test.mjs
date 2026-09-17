import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { specDeriveCommand, specDeriveFromStoreCommand, specDeriveTextLines } from "./cli.mjs";
import { applySpecDerive } from "./spec-derive.mjs";
import {
  ADMIN_API_PAGES_VERSION,
  ADMIN_API_STORE_VERSION,
  adminApiBaseForStore,
  defaultStoreTokenEnvVar,
  matchStorePages,
  normalizeStoreSubdomain,
  parseStoreTokenSource,
  planStoreProfileDerive,
  readStoreProfile,
  SPEC_DERIVE_STORE_FIELDS,
  STORE_PAGES_MAX_REQUESTS,
  storeUrlFromDomain,
  telUriFromPhone,
} from "./spec-derive-store.mjs";

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

function specFixture(patch = null) {
  const spec = readJson(new URL("campaignspec.v42.basic.json", EXAMPLES));
  if (patch) patch(spec);
  return spec;
}

// What a merchant store answers: the documented `/store/` object and a
// storefront with one page per policy, one of them covering two.
const STORE = Object.freeze({
  name: "Acme Outdoors",
  tagline: "",
  timezone: "UTC",
  contact_address: { company_name: "Acme", line1: "", line2: "", postcode: "", city: "", state: "", country: null, phone_number: "(833) 555-0142" },
  primary_domain: "shop.acme.example",
  tax_id: "",
  available_languages: [],
  available_currencies: [],
  payments: {},
});
const PAGES = Object.freeze([
  { slug: "about-us", title: "About Us" },
  { slug: "contact", title: "Contact Us" },
  { slug: "privacy-policy", title: "Privacy Policy" },
  { slug: "shipping-returns", title: "Shipping & Returns" },
  { slug: "terms", title: "Terms & Conditions" },
]);

// A fake Admin API: `/store/` and a two-cursor `/pages/`, recording every
// request so the test can assert on headers, versions and the cursor rule.
function fakeAdminApi({ store = STORE, pages = PAGES, storeStatus = 200, pagesStatus = 200, subdomain = "acme", pageSize = 3, offOriginCursor = false } = {}) {
  const base = adminApiBaseForStore(subdomain);
  const calls = [];
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, init });
    if (url === `${base}store/`) return storeStatus === 200 ? json(200, store) : json(storeStatus, { detail: "nope" });
    if (url.startsWith(`${base}pages/`)) {
      if (pagesStatus !== 200) return json(pagesStatus, { detail: "nope" });
      const cursor = Number(new URL(url).searchParams.get("cursor") || 0);
      const slice = pages.slice(cursor, cursor + pageSize);
      const more = cursor + pageSize < pages.length;
      const next = more ? (offOriginCursor ? `https://evil.example/api/admin/pages/?cursor=${cursor + pageSize}` : `${base}pages/?cursor=${cursor + pageSize}`) : null;
      return json(200, { next, previous: null, results: slice });
    }
    return json(404, {});
  };
  return { fetchImpl, calls, base };
}

test("store flag helpers: subdomain shape, default token env var, env:-only token source, URL and tel forms", () => {
  assert.equal(normalizeStoreSubdomain(" Acme "), "acme");
  assert.equal(normalizeStoreSubdomain("my-store"), "my-store");
  assert.equal(normalizeStoreSubdomain("acme.29next.store"), null);
  assert.equal(normalizeStoreSubdomain("https://acme.29next.store/"), null);
  assert.equal(normalizeStoreSubdomain("-acme"), null);
  assert.equal(normalizeStoreSubdomain(""), null);
  assert.equal(adminApiBaseForStore("acme"), "https://acme.29next.store/api/admin/");
  assert.equal(defaultStoreTokenEnvVar("my-store"), "MY_STORE_ADMIN_TOKEN");
  assert.equal(defaultStoreTokenEnvVar("7summits"), "_7SUMMITS_ADMIN_TOKEN");
  assert.deepEqual(parseStoreTokenSource("env:_7SUMMITS_ADMIN_TOKEN"), { env: "_7SUMMITS_ADMIN_TOKEN" });
  assert.deepEqual(parseStoreTokenSource("env:ACME_ADMIN_TOKEN"), { env: "ACME_ADMIN_TOKEN" });
  assert.match(parseStoreTokenSource("sk_live_abc").problem, /must be env:<VAR>.*never written on the command line/);
  assert.match(parseStoreTokenSource("env:not valid").problem, /invalid environment variable/);
  assert.match(parseStoreTokenSource("").problem, /is empty/);
  assert.equal(storeUrlFromDomain("shop.acme.example"), "https://shop.acme.example");
  assert.equal(storeUrlFromDomain("https://Shop.Acme.Example/"), "https://shop.acme.example");
  assert.equal(storeUrlFromDomain("not a host"), null);
  assert.equal(storeUrlFromDomain("localhost"), null);
  assert.equal(telUriFromPhone("(833) 555-0142"), "tel:8335550142");
  assert.equal(telUriFromPhone("+1 800 555 0100"), "tel:+18005550100");
  assert.equal(telUriFromPhone("123"), null);
  assert.deepEqual(SPEC_DERIVE_STORE_FIELDS, [
    "campaign.store_name", "campaign.store_url", "campaign.store_terms", "campaign.store_privacy", "campaign.store_contact",
    "campaign.store_returns", "campaign.store_shipping", "campaign.store_phone", "campaign.store_phone_tel",
  ]);
});

test("matchStorePages binds a policy by slug or title words, and one page may carry two policies", () => {
  assert.deepEqual(matchStorePages("store_terms", PAGES).map((page) => page.slug), ["terms"]);
  assert.deepEqual(matchStorePages("store_privacy", PAGES).map((page) => page.slug), ["privacy-policy"]);
  assert.deepEqual(matchStorePages("store_returns", PAGES).map((page) => page.slug), ["shipping-returns"]);
  assert.deepEqual(matchStorePages("store_shipping", PAGES).map((page) => page.slug), ["shipping-returns"]);
  // Title words count when the slug does not name the policy; substrings
  // do not ("privacy" is not in "privacyfirst").
  assert.deepEqual(matchStorePages("store_returns", [{ slug: "policy-2", title: "Refund Policy" }]).map((page) => page.slug), ["policy-2"]);
  assert.deepEqual(matchStorePages("store_privacy", [{ slug: "privacyfirst", title: "Our promise" }]), []);
  assert.deepEqual(matchStorePages("store_name", PAGES), []);
});

test("planStoreProfileDerive derives all nine fields from a complete store, compares URLs without a trailing slash, and flags a domain move", () => {
  const plan = planStoreProfileDerive({ spec: specFixture(), store: STORE, pages: PAGES, pagesStatus: "ok", subdomain: "acme" });
  assert.deepEqual(plan.changes.map((row) => [row.field, row.before, row.after]), [
    ["campaign.store_name", "Example Store", "Acme Outdoors"],
    ["campaign.store_url", "https://store.example.com", "https://shop.acme.example"],
    ["campaign.store_terms", "https://store.example.com/terms", "https://shop.acme.example/terms/"],
    ["campaign.store_privacy", "https://store.example.com/privacy", "https://shop.acme.example/privacy-policy/"],
    ["campaign.store_contact", "https://store.example.com/contact", "https://shop.acme.example/contact/"],
    ["campaign.store_returns", "https://store.example.com/returns", "https://shop.acme.example/shipping-returns/"],
    ["campaign.store_shipping", "https://store.example.com/shipping", "https://shop.acme.example/shipping-returns/"],
    ["campaign.store_phone", "1-800-555-0100", "(833) 555-0142"],
    ["campaign.store_phone_tel", "tel:+18005550100", "tel:8335550142"],
  ]);
  assert.equal(plan.changes[0].source, "https://acme.29next.store/api/admin/store/ name");
  assert.equal(plan.changes[2].source, "https://acme.29next.store/api/admin/pages/ slug \"terms\"");
  assert.equal(plan.changes[8].source, "https://acme.29next.store/api/admin/store/ contact_address.phone_number (as tel: URI)");
  assert.deepEqual(plan.not_derived, []);
  assert.deepEqual(plan.domain_changed, { before: "store.example.com", after: "shop.acme.example" });

  // A spec that already carries the store's values (trailing slash or not)
  // is unchanged, and the domain did not move.
  const settled = specFixture((draft) => {
    Object.assign(draft.campaign, {
      store_name: "Acme Outdoors", store_url: "https://shop.acme.example/", store_phone: "(833) 555-0142", store_phone_tel: "tel:8335550142",
      store_terms: "https://shop.acme.example/terms", store_privacy: "https://shop.acme.example/privacy-policy/", store_contact: "https://shop.acme.example/contact/",
      store_returns: "https://shop.acme.example/shipping-returns/", store_shipping: "https://shop.acme.example/shipping-returns",
    });
  });
  const again = planStoreProfileDerive({ spec: settled, store: STORE, pages: PAGES, subdomain: "acme" });
  assert.deepEqual(again.changes, []);
  assert.equal(again.unchanged.length, 9);
  assert.equal(again.domain_changed, null);

  // Every row applies under spec-derive's own guard.
  const spec = specFixture();
  applySpecDerive(spec, plan);
  assert.equal(spec.campaign.store_returns, "https://shop.acme.example/shipping-returns/");
  assert.equal(spec.campaign.name, specFixture().campaign.name);
});

test("planStoreProfileDerive never empties a spec value: an empty store field, no page or several is not derived with its reason", () => {
  const sparse = { ...STORE, name: "  ", primary_domain: null, contact_address: { ...STORE.contact_address, phone_number: "" } };
  const plan = planStoreProfileDerive({ spec: specFixture(), store: sparse, pages: PAGES, subdomain: "acme" });
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.not_derived.map((row) => [row.field, row.reason]), [
    ["campaign.store_name", "store_field_missing"],
    ["campaign.store_url", "store_field_missing"],
    ["campaign.store_terms", "store_domain_missing"],
    ["campaign.store_privacy", "store_domain_missing"],
    ["campaign.store_contact", "store_domain_missing"],
    ["campaign.store_returns", "store_domain_missing"],
    ["campaign.store_shipping", "store_domain_missing"],
    ["campaign.store_phone", "store_field_missing"],
    ["campaign.store_phone_tel", "store_field_missing"],
  ]);
  assert.match(plan.not_derived[0].detail, /left as it is/);

  const pages = [
    { slug: "contact", title: "Contact" },
    { slug: "privacy", title: "Privacy" },
    { slug: "privacy-policy", title: "Privacy Policy" },
    { slug: "bad slug", title: "Terms" },
  ];
  const bound = planStoreProfileDerive({ spec: specFixture(), store: STORE, pages, subdomain: "acme" });
  assert.deepEqual(bound.not_derived.map((row) => [row.field, row.reason]), [
    ["campaign.store_terms", "target_invalid"],
    ["campaign.store_privacy", "store_page_ambiguous"],
    ["campaign.store_returns", "store_page_not_found"],
    ["campaign.store_shipping", "store_page_not_found"],
  ]);
  assert.match(bound.not_derived[1].detail, /"privacy", "privacy-policy"/);
  assert.deepEqual(bound.changes.map((row) => row.field), ["campaign.store_name", "campaign.store_url", "campaign.store_contact", "campaign.store_phone", "campaign.store_phone_tel"]);

  // Pages the store could not list, or too many to list, block only the
  // five link fields.
  for (const [status, reason] of [["unavailable", "store_pages_unavailable"], ["truncated", "store_pages_truncated"]]) {
    const plan2 = planStoreProfileDerive({ spec: specFixture(), store: STORE, pages: null, pagesStatus: status, subdomain: "acme" });
    assert.deepEqual([...new Set(plan2.not_derived.map((row) => row.reason))], [reason]);
    assert.equal(plan2.not_derived.length, 5);
    assert.equal(plan2.changes.length, 4);
  }
});

test("planStoreProfileDerive refuses the demo store, malformed values and a broken campaign block, and truncates echoed values", () => {
  const demo = { ...STORE, primary_domain: "demo.29next.com", contact_address: { ...STORE.contact_address, phone_number: "1-888-831-6810" } };
  const plan = planStoreProfileDerive({ spec: specFixture(), store: demo, pages: PAGES, subdomain: "demo" });
  const reasons = Object.fromEntries(plan.not_derived.map((row) => [row.field, row.reason]));
  assert.equal(reasons["campaign.store_url"], "target_invalid");
  assert.equal(reasons["campaign.store_phone"], "target_invalid");
  assert.equal(reasons["campaign.store_terms"], "target_invalid");
  assert.match(plan.not_derived.find((row) => row.field === "campaign.store_url").detail, /demo store/);
  assert.deepEqual(plan.changes.map((row) => row.field), ["campaign.store_name"]);

  const bad = { ...STORE, primary_domain: "not a domain", name: `CtrlName`, contact_address: { phone_number: "12" } };
  const plan2 = planStoreProfileDerive({ spec: specFixture(), store: bad, pages: PAGES, subdomain: "acme" });
  const reasons2 = Object.fromEntries(plan2.not_derived.map((row) => [row.field, row.reason]));
  assert.equal(reasons2["campaign.store_name"], "target_invalid");
  assert.equal(reasons2["campaign.store_url"], "target_invalid");
  assert.equal(reasons2["campaign.store_phone_tel"], "target_invalid");
  assert.equal(reasons2["campaign.store_terms"], "store_domain_missing");
  assert.deepEqual(plan2.changes.map((row) => row.field), ["campaign.store_phone"]);

  const broken = planStoreProfileDerive({ spec: { campaign: "nope" }, store: STORE, pages: PAGES, subdomain: "acme" });
  assert.deepEqual([...new Set(broken.not_derived.map((row) => row.reason))], ["spec_container_invalid"]);
  const absent = planStoreProfileDerive({ spec: {}, store: STORE, pages: PAGES, subdomain: "acme" });
  assert.equal(absent.changes.length, 9);
  assert.equal(absent.changes[0].before, undefined);

  const long = { ...STORE, name: "x".repeat(200), primary_domain: null };
  const plan3 = planStoreProfileDerive({ spec: specFixture(), store: long, pages: null, pagesStatus: "ok", subdomain: "acme" });
  assert.deepEqual(plan3.changes.map((row) => row.field), ["campaign.store_name", "campaign.store_phone", "campaign.store_phone_tel"]);
  const url = planStoreProfileDerive({ spec: specFixture(), store: { ...STORE, primary_domain: `${"y".repeat(120)}.example` }, pages: PAGES, subdomain: "acme" });
  const echoed = url.not_derived.find((row) => row.field === "campaign.store_url");
  assert.equal(echoed.reason, "target_invalid");
  assert.ok(echoed.detail.length < 260, "an over-long store value is quoted short");
});

test("readStoreProfile sends the bearer token and pinned versions, follows same-origin cursors only, and maps failures to statuses", async () => {
  const api = fakeAdminApi();
  const read = await readStoreProfile({ subdomain: "acme", token: "secret-token", fetchImpl: api.fetchImpl });
  assert.equal(read.status, "ok");
  assert.equal(read.pages_status, "ok");
  assert.deepEqual(read.pages.map((page) => page.slug), PAGES.map((page) => page.slug));
  assert.equal(read.store.name, "Acme Outdoors");
  assert.deepEqual(api.calls.map((call) => call.url), [
    `${api.base}store/`, `${api.base}pages/`, `${api.base}pages/?cursor=3`,
  ]);
  assert.deepEqual(api.calls[0].headers, { Authorization: "Bearer secret-token", "X-29next-API-Version": ADMIN_API_STORE_VERSION, Accept: "application/json" });
  assert.equal(api.calls[0].init.redirect, "error", "a redirect off the store is refused, not followed with the bearer");
  assert.equal(api.calls[1].headers["X-29next-API-Version"], ADMIN_API_PAGES_VERSION);

  // A cursor that points off the store's origin is not followed: the token
  // would travel with it. The pages are then reported unavailable.
  const hostile = fakeAdminApi({ offOriginCursor: true });
  const partial = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: hostile.fetchImpl });
  assert.equal(partial.status, "ok");
  assert.equal(partial.pages_status, "unavailable");
  assert.equal(partial.pages, null);
  assert.equal(hostile.calls.length, 2);

  const many = fakeAdminApi({ pages: Array.from({ length: 40 }, (_, index) => ({ slug: `page-${index}`, title: `Page ${index}` })), pageSize: 1 });
  const truncated = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: many.fetchImpl });
  assert.equal(truncated.pages_status, "truncated");
  assert.equal(many.calls.length, 1 + STORE_PAGES_MAX_REQUESTS);

  assert.equal((await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: fakeAdminApi({ storeStatus: 401 }).fetchImpl })).status, "unauthorized");
  assert.equal((await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: fakeAdminApi({ storeStatus: 403 }).fetchImpl })).status, "unauthorized");
  assert.equal((await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: fakeAdminApi({ storeStatus: 404 }).fetchImpl })).status, "not_found");
  assert.equal((await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: fakeAdminApi({ storeStatus: 503 }).fetchImpl })).status, "unreachable");
  const down = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { cause: { code: "ENOTFOUND" } }); } });
  assert.equal(down.status, "unreachable");
  assert.match(down.detail, /ENOTFOUND/);
  const redirected = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: new Error("unexpected redirect") }); } });
  assert.equal(redirected.status, "unreachable");
  assert.match(redirected.detail, /unexpected redirect/);
  assert.doesNotMatch(JSON.stringify(down), /secret|Bearer/);
  const array = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
  assert.equal(array.status, "invalid");
  const pagesDown = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: fakeAdminApi({ pagesStatus: 404 }).fetchImpl });
  assert.equal(pagesDown.status, "ok");
  assert.equal(pagesDown.pages_status, "unavailable");
  assert.equal((await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: null })).status, "unreachable");
});

// A campaign folder with a target page-kit repo whose entry and page tree
// match the example spec, so the repo half of derive is a no-op and the
// store half is what the run shows.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "spec-derive-store-"));
  for (const file of ["build-packet.basic.json", "campaignspec.v42.basic.json"]) cpSync(new URL(file, EXAMPLES), join(dir, file));
  cpSync(new URL("source-html", EXAMPLES), join(dir, "source-html"), { recursive: true });
  cpSync(new URL("target-page-kit", EXAMPLES), join(dir, "target-page-kit"), { recursive: true });
  mkdirSync(join(dir, "contracts"), { recursive: true });
  cpSync(new URL("../contracts/commerce-surface-catalog.json", import.meta.url), join(dir, "contracts/commerce-surface-catalog.json"));
  const packetPath = join(dir, "build-packet.basic.json");
  const packet = readJson(packetPath);
  packet.assembly.commerce_catalog.path = "contracts/commerce-surface-catalog.json";
  packet.assembly.commerce_catalog.required = false;
  writeJson(packetPath, packet);
  const specPath = join(dir, "campaignspec.v42.basic.json");
  const spec = readJson(specPath);
  const slug = packet.campaign.public_route_slug;
  const targetRepo = join(dir, "target-page-kit");
  const campaignsPath = join(targetRepo, "_data/campaigns.json");
  const campaigns = readJson(campaignsPath);
  campaigns[slug] = { name: "Runtime Packet Demo", entry_url: "landing", sdk_version: spec.global_config.sdk_version, ...spec.campaign, gtm_id: "", fb_pixel_id: "" };
  writeJson(campaignsPath, campaigns);
  const pageTree = join(targetRepo, "src", slug);
  mkdirSync(pageTree, { recursive: true });
  for (const name of ["landing", "checkout", "upsell", "receipt"]) writeFileSync(join(pageTree, `${name}.html`), `---\npage_layout: base.html\n---\n<h1>${name}</h1>\n`);
  return { dir, packetPath, specPath, campaignsPath, slug };
}

test("spec derive --from-store writes the nine store fields, names the env var and never the token, and points at page-kit sync", async () => {
  const { dir, packetPath, specPath } = fixture();
  try {
    const api = fakeAdminApi();
    const env = { ACME_ADMIN_TOKEN: " secret-token " };
    const dry = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: packetPath, "from-store": "Acme", "dry-run": true }, { fetchImpl: api.fetchImpl, env });
    assert.equal(dry.ok, true, JSON.stringify(dry.errors));
    assert.equal(dry.status, "dry_run");
    assert.equal(dry.written, false);
    assert.deepEqual(dry.store, { subdomain: "acme", admin_api: "https://acme.29next.store/api/admin/", token_source: "env:ACME_ADMIN_TOKEN", store_read: "ok", pages_read: "ok", primary_domain: "shop.acme.example" });
    assert.deepEqual(dry.changes.map((row) => row.field), SPEC_DERIVE_STORE_FIELDS);
    assert.equal(api.calls[0].headers.Authorization, "Bearer secret-token", "the token is trimmed and sent once");
    assert.doesNotMatch(JSON.stringify(dry), /secret-token/);
    assert.doesNotMatch(specDeriveTextLines(dry).join("\n"), /secret-token/);
    assert.ok(dry.warnings.some((issue) => issue.code === "spec.derive.store_domain_changed"), "the domain moved from the example's host");
    assert.equal(dry.next, `campaigns-os doctor --packet ${packetPath}`);
    const lines = specDeriveTextLines(dry);
    assert.match(lines.find((line) => line.startsWith("Store:")), /^Store: https:\/\/acme\.29next\.store\/api\/admin\/ \(token env:ACME_ADMIN_TOKEN, primary domain shop\.acme\.example\)$/);
    assert.equal(readJson(specPath).campaign.store_name, "Example Store", "dry run wrote nothing");

    const written = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: packetPath, "from-store": "acme" }, { fetchImpl: fakeAdminApi().fetchImpl, env });
    assert.equal(written.status, "derived");
    assert.equal(written.written, true);
    assert.deepEqual(written.changes.map((row) => [row.field, row.after]), dry.changes.map((row) => [row.field, row.after]), "dry run and write plan the same rows");
    assert.equal(written.next, `campaigns-os page-kit sync --packet ${packetPath}, then campaigns-os doctor --packet ${packetPath}`);
    const spec = readJson(specPath);
    assert.equal(spec.campaign.store_name, "Acme Outdoors");
    assert.equal(spec.campaign.store_url, "https://shop.acme.example");
    assert.equal(spec.campaign.store_shipping, "https://shop.acme.example/shipping-returns/");
    assert.equal(spec.campaign.store_phone_tel, "tel:8335550142");
    assert.equal(spec.campaign.name, "Runtime Packet Demo", "a mirrored field beside the store block is untouched");

    const again = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: packetPath, "from-store": "acme" }, { fetchImpl: fakeAdminApi().fetchImpl, env });
    assert.equal(again.status, "unchanged");
    assert.equal(again.unchanged.filter((row) => row.field.startsWith("campaign.store_")).length, 9);
    assert.equal(again.next, `campaigns-os doctor --packet ${packetPath}`);
    assert.match(specDeriveTextLines(again).join("\n"), /every derived field the repo and the store states already matches/);

    // Partial: the store cannot state two fields; the spec keeps them.
    const sparse = fakeAdminApi({ store: { ...STORE, contact_address: { phone_number: "" } } });
    const partial = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: packetPath, "from-store": "acme" }, { fetchImpl: sparse.fetchImpl, env });
    assert.equal(partial.status, "partial");
    assert.deepEqual(partial.not_derived.map((row) => [row.field, row.reason]), [["campaign.store_phone", "store_field_missing"], ["campaign.store_phone_tel", "store_field_missing"]]);
    assert.ok(partial.warnings.some((issue) => issue.code === "spec.derive.store_field_missing"));
    assert.match(specDeriveTextLines(partial).join("\n"), /could not be derived from the repo or the store/);
    assert.equal(readJson(specPath).campaign.store_phone, "(833) 555-0142");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive --from-store refuses a missing credential, a bad token, an unknown store or an unreachable one before writing anything", async () => {
  const { dir, packetPath, specPath } = fixture();
  try {
    const before = readFileSync(specPath, "utf8");
    const missing = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: packetPath, "from-store": "acme" }, { fetchImpl: fakeAdminApi().fetchImpl, env: {} });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.errors.map((issue) => issue.code), ["spec.derive.store_credential_missing"]);
    assert.match(missing.errors[0].message, /ACME_ADMIN_TOKEN is not set.*--store-token-source env:<VAR>.*Nothing was written/);
    const empty = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: packetPath, "from-store": "acme", "store-token-source": "env:OTHER" }, { fetchImpl: fakeAdminApi().fetchImpl, env: { OTHER: "  " } });
    assert.deepEqual(empty.errors.map((issue) => issue.code), ["spec.derive.store_credential_missing"]);
    assert.equal(empty.store.token_source, "env:OTHER");
    for (const [status, code] of [[401, "spec.derive.store_unauthorized"], [404, "spec.derive.store_not_found"], [500, "spec.derive.store_unreachable"]]) {
      const result = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: packetPath, "from-store": "acme" }, { fetchImpl: fakeAdminApi({ storeStatus: status }).fetchImpl, env: { ACME_ADMIN_TOKEN: "t" } });
      assert.equal(result.ok, false);
      assert.deepEqual(result.errors.map((issue) => issue.code), [code]);
      assert.equal(result.written, false);
      assert.equal(result.store.store_read, null);
    }
    const invalid = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: packetPath, "from-store": "acme" }, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => null }), env: { ACME_ADMIN_TOKEN: "t" } });
    assert.deepEqual(invalid.errors.map((issue) => issue.code), ["spec.derive.store_response_invalid"]);
    // A local precondition still comes first: a bad packet is reported
    // without touching the network.
    let fetched = 0;
    const neverFetch = async () => { fetched += 1; throw new Error("must not be called"); };
    const local = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: join(dir, "nope.json"), "from-store": "acme" }, { fetchImpl: neverFetch, env: { ACME_ADMIN_TOKEN: "t" } });
    assert.deepEqual(local.errors.map((issue) => issue.code), ["spec.derive.packet_invalid"]);
    assert.equal(fetched, 0, "the token is not sent for a packet the command refuses");
    writeFileSync(specPath, "[]\n");
    const badSpec = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: packetPath, "from-store": "acme" }, { fetchImpl: neverFetch, env: { ACME_ADMIN_TOKEN: "t" } });
    assert.deepEqual(badSpec.errors.map((issue) => issue.code), ["spec.derive.spec_invalid"]);
    assert.equal(fetched, 0);
    assert.equal(badSpec.written, false);
    writeFileSync(specPath, before);
    // A boundary refusal (a spec path that resolves outside the campaign)
    // also precedes the read: it is checked after the packet and entry.
    const outside = join(dir, "..", `outside-${basename(dir)}.json`);
    writeFileSync(outside, before);
    rmSync(specPath);
    symlinkSync(outside, specPath);
    try {
      const escaped = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: packetPath, "from-store": "acme" }, { fetchImpl: neverFetch, env: { ACME_ADMIN_TOKEN: "t" } });
      assert.deepEqual(escaped.errors.map((issue) => issue.code), ["spec.derive.spec_escapes_boundary"]);
      assert.equal(fetched, 0);
    } finally {
      rmSync(specPath, { force: true });
      rmSync(outside, { force: true });
      writeFileSync(specPath, before);
    }
    assert.equal(readFileSync(specPath, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive store flags are validated before any read, and the sync command refuses --from-store without a read", () => {
  const { dir, packetPath } = fixture();
  try {
    const base = { _: ["spec", "derive"], packet: packetPath };
    assert.throws(() => specDeriveCommand({ ...base, "from-store": true }), /--from-store takes the store's subdomain/);
    assert.throws(() => specDeriveCommand({ ...base, "from-store": "https://acme.29next.store/" }), /--from-store takes the store's subdomain/);
    assert.throws(() => specDeriveCommand({ ...base, "store-token-source": "env:X" }), /--store-token-source only applies with --from-store/);
    assert.throws(() => specDeriveCommand({ ...base, "from-store": "acme", "store-token-source": "sk_live_x" }), /never written on the command line/);
    assert.throws(() => specDeriveCommand({ ...base, "from-store": "acme", "store-token-source": true }), /--store-token-source is empty/);
    assert.throws(() => specDeriveCommand({ ...base, "from-store": "acme" }), /must be dispatched through specDeriveFromStoreCommand/);
    assert.throws(() => specDeriveCommand({ ...base, "from-stor": "acme" }), /Unknown flag for spec derive: --from-stor\..*--from-store, --store-token-source/);
    // The offline run is unchanged: no store block, no network.
    const offline = specDeriveCommand({ ...base, "dry-run": true });
    assert.equal(offline.ok, true);
    assert.equal(offline.store, null);
    assert.doesNotMatch(specDeriveTextLines(offline).join("\n"), /^Store:/m);

    const run = spawnSync("node", [CLI, "spec", "derive", "--packet", packetPath, "--from-store", "acme", "--dry-run", "--json"], { encoding: "utf8", env: { ...process.env, ACME_ADMIN_TOKEN: "" } });
    assert.equal(run.status, 2, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(result.errors.map((issue) => issue.code), ["spec.derive.store_credential_missing"]);
    const text = spawnSync("node", [CLI, "spec", "derive", "--packet", packetPath, "--from-store", "acme"], { encoding: "utf8", env: { ...process.env, ACME_ADMIN_TOKEN: "" } });
    assert.equal(text.status, 2);
    assert.match(text.stdout, /^Store: https:\/\/acme\.29next\.store\/api\/admin\/ \(token env:ACME_ADMIN_TOKEN\)$/m);
    assert.match(text.stdout, /spec\.derive\.store_credential_missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A `fetch` whose every response is scripted, for the transport paths the
// fake Admin API above does not reach (bodies that are not JSON, a cursor
// body without `results`, a pages request that throws).
function scriptedFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (typeof next === "function") return next(url, init);
    return next;
  };
  return { fetchImpl, calls };
}

test("readStoreProfile reports a non-JSON store body as invalid, and a pages read that throws, is not JSON or lacks results as unavailable", async () => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const notJson = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token < in JSON"); } });

  const invalid = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: scriptedFetch([notJson()]).fetchImpl });
  assert.equal(invalid.status, "invalid");
  assert.match(invalid.detail, /did not return JSON; the subdomain may be wrong/);

  const throwing = scriptedFetch([ok(STORE), () => { throw new Error("socket hang up"); }]);
  const thrown = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: throwing.fetchImpl });
  assert.equal(thrown.status, "ok");
  assert.equal(thrown.pages_status, "unavailable");
  assert.equal(thrown.pages, null);
  assert.equal(throwing.calls.length, 2, "the pages loop stops at the first failure");

  const garbled = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: scriptedFetch([ok(STORE), notJson()]).fetchImpl });
  assert.equal(garbled.pages_status, "unavailable");

  for (const body of [[], { results: "nope" }, null]) {
    const shape = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: scriptedFetch([ok(STORE), ok(body)]).fetchImpl });
    assert.equal(shape.status, "ok");
    assert.equal(shape.pages_status, "unavailable", `a pages body of ${JSON.stringify(body)} is unavailable`);
  }

  // Malformed page rows are dropped on read; a non-string title reads as
  // empty rather than failing the page.
  const mixed = scriptedFetch([ok(STORE), ok({ next: null, results: [null, "terms", { title: "No slug" }, { slug: "  " }, { slug: "terms", title: 7 }, { slug: "privacy-policy", title: "Privacy" }] })]);
  const read = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: mixed.fetchImpl });
  assert.equal(read.pages_status, "ok");
  assert.deepEqual(read.pages, [{ slug: "terms", title: "" }, { slug: "privacy-policy", title: "Privacy" }]);
  assert.ok(mixed.calls.every((call) => call.init.signal instanceof AbortSignal), "every request carries the timeout signal");
});

test("readStoreProfile names a timeout as such and quotes a long transport error short, never the token", async () => {
  const timeout = await readStoreProfile({ subdomain: "acme", token: "secret-token", fetchImpl: async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); } });
  assert.equal(timeout.status, "unreachable");
  assert.equal(timeout.detail, "https://acme.29next.store/api/admin/store/ could not be reached (timed out).");
  const aborted = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); } });
  assert.match(aborted.detail, /\(timed out\)/);

  const long = await readStoreProfile({ subdomain: "acme", token: "secret-token", fetchImpl: async () => { throw new Error(`secret-token? no: ${"x".repeat(400)}\n\n  multi   line`); } });
  assert.equal(long.status, "unreachable");
  const quoted = long.detail.match(/\((.*)\)\.$/)[1];
  assert.equal(quoted.length, 158, "a long message is cut to 157 characters plus an ellipsis");
  assert.ok(quoted.endsWith("…"));
  assert.doesNotMatch(quoted, /\n|  /, "whitespace is collapsed to single spaces");
  assert.doesNotMatch(JSON.stringify(timeout), /secret-token|Bearer/);

  // The name-only branch of the transport detail: no cause code, message only.
  const plain = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: async () => { throw new Error("fetch failed"); } });
  assert.match(plain.detail, /\(fetch failed\)\.$/);
});

test("store helpers answer null or empty for non-string and non-array input, and a missing store body derives nothing", () => {
  assert.equal(normalizeStoreSubdomain(null), null);
  assert.equal(normalizeStoreSubdomain(42), null);
  assert.equal(storeUrlFromDomain(undefined), null);
  assert.equal(storeUrlFromDomain({ host: "x.example" }), null);
  assert.equal(telUriFromPhone(8335550142), null);
  assert.deepEqual(matchStorePages("store_terms", null), []);
  assert.deepEqual(matchStorePages("store_terms", "terms"), []);
  assert.deepEqual(matchStorePages("store_terms", [null, "terms", { title: "Terms" }, { slug: "", title: "Terms" }, { slug: "terms" }]).map((page) => page.slug), ["terms"]);
  assert.match(parseStoreTokenSource(null).problem, /is empty/);
  assert.match(parseStoreTokenSource("env:").problem, /must be env:<VAR>/);

  // No store body at all: every field is a miss, none is a change, and the
  // link fields say the domain is what is missing.
  for (const store of [null, undefined, "store", ["store"]]) {
    const plan = planStoreProfileDerive({ spec: specFixture(), store, pages: PAGES, subdomain: "acme" });
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(plan.unchanged, []);
    assert.equal(plan.not_derived.length, 9);
    assert.deepEqual([...new Set(plan.not_derived.map((row) => row.reason))].sort(), ["store_domain_missing", "store_field_missing"]);
    assert.equal(plan.domain_changed, null);
  }
  // With no subdomain the sources still name a placeholder store, never an
  // empty host.
  const unnamed = planStoreProfileDerive({ spec: specFixture(), store: STORE, pages: PAGES });
  assert.equal(unnamed.changes[0].source, "https://<store>.29next.store/api/admin/store/ name");
});

test("planStoreProfileDerive skips the domain-move check when the spec's store_url is unusable, and reads an empty or non-object phone block as missing", () => {
  // A spec store_url that is the demo value, empty or not a URL cannot name
  // a host to compare against, so no domain_changed is raised.
  for (const before of ["", "   ", "not a url", "https://demo.29next.com", "ftp://store.example.com", 7]) {
    const plan = planStoreProfileDerive({ spec: specFixture((draft) => { draft.campaign.store_url = before; }), store: STORE, pages: PAGES, subdomain: "acme" });
    assert.equal(plan.domain_changed, null, `no domain move for spec store_url ${JSON.stringify(before)}`);
    assert.ok(plan.changes.some((row) => row.field === "campaign.store_url" && row.after === "https://shop.acme.example"));
  }
  // Same host, different path or case: the domain did not move.
  const same = planStoreProfileDerive({ spec: specFixture((draft) => { draft.campaign.store_url = "HTTPS://Shop.Acme.Example/some/path"; }), store: STORE, pages: PAGES, subdomain: "acme" });
  assert.equal(same.domain_changed, null);

  for (const contact of [undefined, null, "phone", { phone_number: 8335550142 }, {}]) {
    const plan = planStoreProfileDerive({ spec: specFixture(), store: { ...STORE, contact_address: contact }, pages: PAGES, subdomain: "acme" });
    assert.deepEqual(plan.not_derived.map((row) => [row.field, row.reason]), [["campaign.store_phone", "store_field_missing"], ["campaign.store_phone_tel", "store_field_missing"]]);
    assert.equal(plan.changes.length, 7);
  }
  // A whitespace-padded store name is trimmed before it is compared.
  const padded = planStoreProfileDerive({ spec: specFixture((draft) => { draft.campaign.store_name = "Acme Outdoors"; }), store: { ...STORE, name: "  Acme Outdoors  " }, pages: PAGES, subdomain: "acme" });
  assert.ok(padded.unchanged.some((row) => row.field === "campaign.store_name"));
});

test("specDeriveFromStoreCommand without --from-store is the offline run, and an unknown store status is reported as unreachable", async () => {
  const { dir, packetPath, specPath } = fixture();
  try {
    let fetched = 0;
    const offline = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: packetPath, "dry-run": true }, { fetchImpl: async () => { fetched += 1; }, env: { ACME_ADMIN_TOKEN: "t" } });
    assert.equal(offline.ok, true);
    assert.equal(offline.store, null);
    assert.equal(fetched, 0, "no --from-store, no network");

    // A store read with a status this toolkit does not know maps to the
    // transport error, never to a silent write.
    const before = readFileSync(specPath, "utf8");
    const odd = specDeriveCommand({ _: ["spec", "derive"], packet: packetPath, "from-store": "acme" }, { store: { subdomain: "acme", token_env: "ACME_ADMIN_TOKEN", status: "weird", detail: "Something new." } });
    assert.equal(odd.ok, false);
    assert.deepEqual(odd.errors.map((issue) => [issue.code, issue.message]), [["spec.derive.store_unreachable", "Something new. Nothing was written."]]);
    assert.deepEqual(odd.errors[0].detail, { subdomain: "acme", token_source: "env:ACME_ADMIN_TOKEN" });
    assert.equal(odd.written, false);
    assert.equal(readFileSync(specPath, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive --from-store on a store with no primary domain and unlistable pages is partial, keeps every link, and says so in the Store line", async () => {
  const { dir, packetPath, specPath } = fixture();
  try {
    const original = readJson(specPath).campaign;
    const api = fakeAdminApi({ store: { ...STORE, primary_domain: "" }, pagesStatus: 500 });
    const result = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: packetPath, "from-store": "acme" }, { fetchImpl: api.fetchImpl, env: { ACME_ADMIN_TOKEN: "t" } });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.status, "partial");
    assert.equal(result.written, true);
    assert.deepEqual(result.store, { subdomain: "acme", admin_api: "https://acme.29next.store/api/admin/", token_source: "env:ACME_ADMIN_TOKEN", store_read: "ok", pages_read: "unavailable", primary_domain: null });
    assert.deepEqual(result.changes.map((row) => row.field), ["campaign.store_name", "campaign.store_phone", "campaign.store_phone_tel"]);
    assert.deepEqual(result.not_derived.map((row) => row.reason), ["store_field_missing", "store_domain_missing", "store_domain_missing", "store_domain_missing", "store_domain_missing", "store_domain_missing"]);
    assert.ok(!result.warnings.some((issue) => issue.code === "spec.derive.store_domain_changed"), "no domain to compare, no domain-move warning");
    assert.equal(result.next, `campaigns-os page-kit sync --packet ${packetPath}, then campaigns-os doctor --packet ${packetPath}`);
    const lines = specDeriveTextLines(result);
    assert.equal(lines.find((line) => line.startsWith("Store:")), "Store: https://acme.29next.store/api/admin/ (token env:ACME_ADMIN_TOKEN, pages unavailable)");
    const spec = readJson(specPath).campaign;
    assert.equal(spec.store_name, "Acme Outdoors");
    for (const field of ["store_url", "store_terms", "store_privacy", "store_contact", "store_returns", "store_shipping"]) assert.equal(spec[field], original[field], `${field} kept`);

    // Pages listed but truncated: the same five links are kept, the Store
    // line says truncated, and the primary domain is shown.
    const many = fakeAdminApi({ pages: Array.from({ length: STORE_PAGES_MAX_REQUESTS + 1 }, (_, index) => ({ slug: `page-${index}`, title: `Page ${index}` })), pageSize: 1 });
    const truncated = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: packetPath, "from-store": "acme", "dry-run": true }, { fetchImpl: many.fetchImpl, env: { ACME_ADMIN_TOKEN: "t" } });
    assert.equal(truncated.status, "partial", "a dry run with a miss reports partial");
    assert.equal(truncated.written, false);
    assert.equal(truncated.dry_run, true);
    assert.equal(truncated.store.pages_read, "truncated");
    assert.deepEqual([...new Set(truncated.not_derived.map((row) => row.reason))], ["store_pages_truncated"]);
    assert.match(specDeriveTextLines(truncated).find((line) => line.startsWith("Store:")), /primary domain shop\.acme\.example, pages truncated\)$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec derive --from-store reports a local spec error before the store error, and a store error before any repo write", async () => {
  const { dir, packetPath, specPath } = fixture();
  try {
    // The spec file is gone: the local error is the only one, though the
    // store read also failed.
    rmSync(specPath);
    const local = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: packetPath, "from-store": "acme" }, { fetchImpl: fakeAdminApi({ storeStatus: 401 }).fetchImpl, env: { ACME_ADMIN_TOKEN: "t" } });
    assert.equal(local.ok, false);
    assert.equal(local.errors.length, 1);
    assert.doesNotMatch(local.errors[0].code, /store_/);
    assert.deepEqual(local.store, { subdomain: "acme", admin_api: "https://acme.29next.store/api/admin/", token_source: "env:ACME_ADMIN_TOKEN", store_read: null, pages_read: null, primary_domain: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The repo half has a real change to make, but the store cannot be read:
  // nothing is written, the repo change included.
  const second = fixture();
  try {
    const campaigns = readJson(second.campaignsPath);
    campaigns[second.slug].gtm_id = "GTM-ABC1234";
    writeJson(second.campaignsPath, campaigns);
    const before = readFileSync(second.specPath, "utf8");
    const result = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: second.packetPath, "from-store": "acme" }, { fetchImpl: fakeAdminApi({ storeStatus: 403 }).fetchImpl, env: { ACME_ADMIN_TOKEN: "t" } });
    assert.deepEqual(result.errors.map((issue) => issue.code), ["spec.derive.store_unauthorized"]);
    assert.equal(result.written, false);
    assert.deepEqual(result.changes, []);
    assert.equal(readFileSync(second.specPath, "utf8"), before, "the repo-derived GTM id was not written either");
    const offline = specDeriveCommand({ _: ["spec", "derive"], packet: second.packetPath, "dry-run": true });
    assert.ok(offline.changes.some((row) => row.field === "analytics.providers.gtm.containerId"), "the repo half would have changed");
  } finally {
    rmSync(second.dir, { recursive: true, force: true });
  }
});

test("readStoreProfile aborts a hung store read after timeoutMs, reads exactly the request cap without truncating, and percent-encodes a non-ASCII slug", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  // AbortSignal.timeout's timer does not keep the event loop alive; a real
  // fetch's socket does, so the test holds it open the way a socket would.
  const keepAlive = setTimeout(() => {}, 5_000);
  const read = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: hang, timeoutMs: 20 }).finally(() => clearTimeout(keepAlive));
  assert.equal(read.status, "unreachable");
  assert.match(read.detail, /timed out/);

  const api = fakeAdminApi({ pages: Array.from({ length: STORE_PAGES_MAX_REQUESTS }, (_, index) => ({ slug: `page-${index}`, title: `Page ${index}` })), pageSize: 1 });
  const exact = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: api.fetchImpl });
  assert.equal(exact.pages_status, "ok");
  assert.equal(exact.pages.length, STORE_PAGES_MAX_REQUESTS);
  assert.equal(api.calls.length, 1 + STORE_PAGES_MAX_REQUESTS);

  // The budget is shared: once it is spent, the next cursor is not requested
  // and the pages read as unavailable rather than the command waiting on.
  let slowCalls = 0;
  const slow = async (url, init) => {
    slowCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return api.fetchImpl(url, init);
  };
  const spent = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: slow, timeoutMs: 1_000, budgetMs: 40 });
  assert.equal(spent.status, "ok", "the store read itself fit the budget");
  assert.equal(spent.pages_status, "unavailable");
  assert.ok(slowCalls < 1 + STORE_PAGES_MAX_REQUESTS, "the loop stopped when the budget ran out");

  const pages = [{ slug: "política-de-privacidad", title: "Privacy Policy" }];
  const plan = planStoreProfileDerive({ spec: specFixture(), store: STORE, pages, subdomain: "acme" });
  const row = plan.changes.find((change) => change.field === "campaign.store_privacy");
  assert.equal(row.after, "https://shop.acme.example/pol%C3%ADtica-de-privacidad/");
});

test("adversarial guards: a malformed token is never sent or echoed, phone extensions and vanity numbers are not converted, canonical slugs outrank word matches, dot and lone-surrogate slugs are refused, off-endpoint cursors are not followed, and a swapped packet is refused", async () => {
  // A token with an embedded newline never reaches a header (whose validator
  // would quote it back), and nothing that carries "Bearer" echoes the value.
  let sent = 0;
  const bad = await readStoreProfile({ subdomain: "acme", token: "abc\nSECRETLINE2", fetchImpl: async () => { sent += 1; return { ok: true, status: 200, json: async () => STORE }; } });
  assert.equal(bad.status, "credential_invalid");
  assert.equal(sent, 0);
  assert.doesNotMatch(JSON.stringify(bad), /SECRETLINE2/);
  const echoed = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: async () => { throw new TypeError('Headers.append: "Bearer t-SECRET-VALUE" is an invalid header value.'); } });
  assert.equal(echoed.status, "unreachable");
  assert.doesNotMatch(echoed.detail, /SECRET-VALUE/);
  assert.match(echoed.detail, /Bearer \[redacted\]/);

  // Phones.
  assert.equal(telUriFromPhone("+1 800 555 0100 ext. 123"), null);
  assert.equal(telUriFromPhone("1-800-FLOWERS"), null);
  assert.equal(telUriFromPhone("(+44) 20 7946 0958"), "tel:+442079460958");
  assert.equal(telUriFromPhone("+1 555 0100 / +1 555 0101"), null);
  const ext = planStoreProfileDerive({ spec: specFixture(), store: { ...STORE, contact_address: { phone_number: "+1 800 555 0100 ext. 123" } }, pages: PAGES, subdomain: "acme" });
  assert.equal(ext.changes.find((row) => row.field === "campaign.store_phone").after, "+1 800 555 0100 ext. 123");
  assert.deepEqual(ext.not_derived.map((row) => [row.field, row.reason]), [["campaign.store_phone_tel", "target_invalid"]]);

  // Canonical slug first: a promo page with the word does not compete.
  const promo = [{ slug: "free-shipping-over-50", title: "Free shipping" }, { slug: "shipping-policy", title: "Policy" }, { slug: "contact-lens-care", title: "Care" }, { slug: "contact", title: "Reach us" }];
  assert.deepEqual(matchStorePages("store_shipping", promo).map((page) => page.slug), ["shipping-policy"]);
  assert.deepEqual(matchStorePages("store_contact", promo).map((page) => page.slug), ["contact"]);
  assert.deepEqual(matchStorePages("store_shipping", [promo[0]]).map((page) => page.slug), ["free-shipping-over-50"], "the word match still applies when no conventional slug exists");

  // Slugs that are not one honest path segment.
  for (const slug of [".", "..", "\ud800"]) {
    const plan = planStoreProfileDerive({ spec: specFixture(), store: STORE, pages: [{ slug, title: "Privacy Policy" }], subdomain: "acme" });
    const row = plan.not_derived.find((item) => item.field === "campaign.store_privacy");
    assert.equal(row.reason, "target_invalid", JSON.stringify(slug));
  }

  // A cursor that stays on the origin but climbs out of the endpoint.
  const climbing = fakeAdminApi();
  const climb = async (url, init) => {
    if (url.endsWith("/pages/")) return { ok: true, status: 200, json: async () => ({ next: "https://acme.29next.store/api/admin/../../some-route/?cursor=1", results: PAGES.slice(0, 1) }) };
    return climbing.fetchImpl(url, init);
  };
  const climbed = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: climb });
  assert.equal(climbed.pages_status, "unavailable");
  assert.match(climbed.pages_detail, /outside the store's pages endpoint/);
  const malformedNext = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: async (url, init) => (url.endsWith("/pages/") ? { ok: true, status: 200, json: async () => ({ next: 42, results: PAGES }) } : climbing.fetchImpl(url, init)) });
  assert.equal(malformedNext.pages_status, "unavailable");
  const forbidden = await readStoreProfile({ subdomain: "acme", token: "t", fetchImpl: fakeAdminApi({ pagesStatus: 403 }).fetchImpl });
  assert.match(forbidden.pages_detail, /content:read/);
  const scoped = planStoreProfileDerive({ spec: specFixture(), store: STORE, pages: null, pagesStatus: "unavailable", pagesDetail: forbidden.pages_detail, subdomain: "acme" });
  assert.match(scoped.not_derived[0].detail, /content:read/);

  // The packet swapped for another campaign's between the preflight and the
  // write is refused.
  const { dir, packetPath, specPath } = fixture();
  try {
    const packet = readJson(packetPath);
    const other = specFixture();
    const otherPath = join(dir, "other.spec.json");
    writeFileSync(otherPath, `${JSON.stringify(other, null, 2)}\n`);
    const swap = async (url, init) => {
      writeJson(packetPath, { ...packet, spec: { ...packet.spec, local_path: "other.spec.json" } });
      return fakeAdminApi().fetchImpl(url, init);
    };
    const result = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: packetPath, "from-store": "acme" }, { fetchImpl: swap, env: { ACME_ADMIN_TOKEN: "t" } });
    assert.deepEqual(result.errors.map((issue) => issue.code), ["spec.derive.packet_changed_underneath"]);
    assert.equal(result.written, false);
    assert.equal(readJson(otherPath).campaign.store_name, "Example Store");
    assert.equal(readJson(specPath).campaign.store_name, "Example Store");
    // A spec that vanishes during the read reports its own local error, not
    // a packet change.
    writeJson(packetPath, packet);
    const vanish = async (url, init) => {
      rmSync(specPath, { force: true });
      return fakeAdminApi().fetchImpl(url, init);
    };
    const gone = await specDeriveFromStoreCommand({ _: ["spec", "derive"], packet: packetPath, "from-store": "acme" }, { fetchImpl: vanish, env: { ACME_ADMIN_TOKEN: "t" } });
    assert.deepEqual(gone.errors.map((issue) => issue.code), ["spec.derive.spec_missing"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
