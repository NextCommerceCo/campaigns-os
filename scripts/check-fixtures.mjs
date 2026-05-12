#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(root, "bin/campaigns-os.mjs");
const packet = resolve(root, "examples/build-packet.basic.json");
const catalogPath = resolve(root, "contracts/commerce-surface-catalog.json");

if (!existsSync(packet)) {
  throw new Error(`Missing fixture packet: ${packet}`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${relative(root, path)} is not valid JSON: ${error.message}`);
  }
}

function hasPath(obj, dotted) {
  const parts = dotted.split(".");
  let current = obj;

  for (const part of parts) {
    if (part.endsWith("[]")) {
      const key = part.slice(0, -2);
      if (!Array.isArray(current?.[key])) return false;
      current = current[key][0];
      continue;
    }

    if (current == null || !(part in current)) return false;
    current = current[part];
  }

  return true;
}

function validateCatalogFixtures() {
  if (!existsSync(catalogPath)) {
    throw new Error(`Missing contract catalog: ${relative(root, catalogPath)}`);
  }

  const catalog = readJson(catalogPath);
  if (!catalog.sharedFrontmatterVocabulary || typeof catalog.sharedFrontmatterVocabulary !== "object") {
    throw new Error("contracts/commerce-surface-catalog.json is missing sharedFrontmatterVocabulary");
  }

  const families = Object.entries(catalog.families ?? {});
  if (families.length === 0) {
    throw new Error("contracts/commerce-surface-catalog.json has no families");
  }

  for (const [family, entry] of families) {
    const fixtures = entry.agentContract?.fixtures;
    if (!Array.isArray(fixtures) || fixtures.length === 0) {
      throw new Error(`contracts catalog family ${family} has no agentContract.fixtures`);
    }

    for (const fixture of fixtures) {
      const fixturePath = resolve(root, fixture);
      const relativeFixture = relative(root, fixturePath);
      if (relativeFixture.startsWith("..")) {
        throw new Error(`contracts catalog family ${family} points outside repo: ${fixture}`);
      }
      if (!existsSync(fixturePath)) {
        throw new Error(`contracts catalog family ${family} references missing fixture: ${fixture}`);
      }

      const spec = readJson(fixturePath);
      for (const required of ["campaign.id", "campaign.name", "campaign.currency", "campaign.language", "funnels[]"]) {
        if (!hasPath(spec, required)) {
          throw new Error(`${relativeFixture} is missing ${required}`);
        }
      }

      for (const [funnelIndex, funnel] of (spec.funnels ?? []).entries()) {
        if (!Array.isArray(funnel.pages) || funnel.pages.length === 0) {
          throw new Error(`${relativeFixture} funnels[${funnelIndex}].pages must be a non-empty array`);
        }

        for (const [pageIndex, page] of funnel.pages.entries()) {
          for (const required of ["id", "type", "order", "label"]) {
            if (!(required in page)) {
              throw new Error(`${relativeFixture} funnels[${funnelIndex}].pages[${pageIndex}] missing ${required}`);
            }
          }

          if (page.sdk_hints?.template_family && page.sdk_hints.template_family !== family) {
            throw new Error(
              `${relativeFixture} page ${page.id} sdk_hints.template_family=${page.sdk_hints.template_family} does not match catalog family ${family}`,
            );
          }

          if (typeof page.page_url === "string" && /\.html(?:[?#].*)?$/i.test(page.page_url.trim())) {
            throw new Error(`${relativeFixture} page ${page.id} page_url must be a Page Kit public route, not a source filename: ${page.page_url}`);
          }
        }
      }
    }
  }
}

function envWithout(...keys) {
  const env = { ...process.env };
  for (const key of keys) delete env[key];
  return env;
}

function runCliJson(args, env = process.env) {
  const output = execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env,
    encoding: "utf8",
  });
  return JSON.parse(output);
}

validateCatalogFixtures();

const doctor = runCliJson(["doctor", "--packet", packet, "--json"], envWithout("CAMPAIGNS_API_KEY"));
if (doctor.warnings?.some((issue) => issue.code === "campaign.api_key_source")) {
  throw new Error("Doctor should accept CampaignSpec campaign.campaigns_api_key without requiring CAMPAIGNS_API_KEY.");
}

execFileSync(process.execPath, [cli, "next", "build", "--packet", packet, "--json"], {
  cwd: root,
  stdio: "pipe",
  env: { ...process.env, CAMPAIGNS_API_KEY: "fixture-key" },
});

execFileSync(process.execPath, [cli, "qa", "resolve", "--packet", packet, "--json"], {
  cwd: root,
  stdio: "pipe",
  env: { ...process.env, CAMPAIGNS_API_KEY: "fixture-key" },
});

const resolvedQa = runCliJson(["qa", "resolve", "--packet", packet, "--base-url", "https://preview.example.com", "--json"], {
  ...process.env,
  CAMPAIGNS_API_KEY: "fixture-key",
});
const pages = resolvedQa.funnels?.[0]?.pages ?? [];
const checkout = pages.find((page) => page.page_id === "checkout");
const upsell = pages.find((page) => page.page_id === "upsell");
if (resolvedQa.base_url !== "https://preview.example.com/runtime-packet-demo/") {
  throw new Error(`QA base URL should resolve to campaign root, got ${resolvedQa.base_url}`);
}
if (checkout?.url !== "https://preview.example.com/runtime-packet-demo/checkout/") {
  throw new Error(`QA checkout URL should include campaign slug, got ${checkout?.url}`);
}
if (checkout?.expected_meta_tags?.["next-success-url"] !== "/runtime-packet-demo/upsell/") {
  throw new Error(`QA should expect runtime-rooted next-success-url, got ${checkout?.expected_meta_tags?.["next-success-url"]}`);
}
if (upsell?.expected_meta_tags?.["next-upsell-accept-url"] !== "/runtime-packet-demo/receipt/") {
  throw new Error(`QA should expect runtime-rooted next-upsell-accept-url, got ${upsell?.expected_meta_tags?.["next-upsell-accept-url"]}`);
}

console.log("Fixture checks passed");
