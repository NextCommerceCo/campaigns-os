import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function runCliJson(args) {
  const output = execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CAMPAIGNS_API_KEY: "" },
  });
  return JSON.parse(output);
}

function withIntakeFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-source-intake-"));
  try {
    const sourceRoot = resolve(dir, "source-html");
    const targetRepo = resolve(dir, "target-page-kit");
    mkdirSync(resolve(sourceRoot, ".campaigns-os"), { recursive: true });
    mkdirSync(targetRepo, { recursive: true });
    writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));

    const files = {
      "figma/landing-page.html": "<section>landing</section>",
      "checkout/index.html": "<section>checkout</section>",
      "ai/upsell-offer.html": "<section>upsell</section>",
      "template/thanks.html": "<section>receipt</section>",
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(resolve(sourceRoot, path, ".."), { recursive: true });
      writeFileSync(resolve(sourceRoot, path), content);
    }

    writeJson(resolve(sourceRoot, ".campaigns-os", "source-html-manifest.json"), {
      schema_version: "source-html-manifest/v0",
      generated_at: "2026-06-08T00:00:00.000Z",
      generator: "source-html-intake-test@1.0.0",
      campaign_slug: "runtime-packet-demo",
      root: ".",
      pages: [
        { page_id: "landing", path: "figma/landing-page.html", page_type: "landing" },
        { page_id: "checkout", path: "checkout/index.html", page_type: "checkout" },
        { page_id: "upsell", path: "ai/upsell-offer.html", page_type: "upsell" },
        { page_id: "receipt", path: "template/thanks.html", page_type: "thankyou" },
      ],
    });

    const spec = readJson(resolve(ROOT, "examples/campaignspec.v42.basic.json"));
    const checkout = spec.funnels[0].pages.find((page) => page.id === "checkout");
    checkout.page_url = "checkout/step-1/";
    const specPath = resolve(dir, "campaignspec.json");
    writeJson(specPath, spec);

    return run({ dir, sourceRoot, targetRepo, specPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("prepare-build separates source manifest paths from Page Kit target projection", () => {
  withIntakeFixture(({ sourceRoot, targetRepo, specPath }) => {
    const result = runCliJson([
      "prepare-build",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--json",
    ]);

    const pages = new Map(result.packet.source_html.pages.map((page) => [page.page_id, page]));
    const checkout = pages.get("checkout");
    assert.equal(checkout.path, "checkout/index.html");
    assert.equal(checkout.page_kit.target_path, "step-1.html");
    assert.equal(checkout.page_kit.output_path, "src/runtime-packet-demo/step-1.html");
    assert.equal(checkout.page_kit.public_route, "/runtime-packet-demo/checkout/step-1/");
    assert.equal(checkout.page_kit.page_type, "checkout");
    assert.equal(checkout.page_kit.permalink_required, true);
    assert.equal(checkout.page_kit.frontmatter.permalink, "/runtime-packet-demo/checkout/step-1/");

    const landing = pages.get("landing");
    assert.equal(landing.path, "figma/landing-page.html");
    assert.equal(landing.page_kit.target_path, "landing.html");
    assert.equal(landing.page_kit.page_type, "product");
    assert.equal(landing.page_kit.frontmatter.next_url, "/runtime-packet-demo/checkout/step-1/");

    const receipt = pages.get("receipt");
    assert.equal(receipt.path, "template/thanks.html");
    assert.equal(receipt.page_type, "thankyou");
    assert.equal(receipt.page_kit.page_type, "receipt");
    assert.equal(receipt.page_kit.target_path, "receipt.html");

    const contextCheckout = result.context.page_map.find((page) => page.page_id === "checkout");
    assert.equal(contextCheckout.source_path, "checkout/index.html");
    assert.equal(contextCheckout.output_path, "./src/runtime-packet-demo/step-1.html");
    assert.equal(contextCheckout.page_kit.target_path, "step-1.html");

    const projectionDecisions = result.context.decisions.filter((decision) => decision.id.startsWith("dec_page_kit_target_"));
    assert.equal(projectionDecisions.length, 4);
  });
});
