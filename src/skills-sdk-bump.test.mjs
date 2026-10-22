// The SDK bump skill (#677) carries the steps an agent cannot discover from
// the toolkit alone. Each is checked whitespace-normalised, so rewrapping a
// line passes and dropping a step fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const raw = readFileSync(join(ROOT, "skills/next-campaigns-sdk-bump/SKILL.md"), "utf8");
const skill = raw.replace(/\s+/g, " ");

test("the SDK bump skill names each step the bump needs", () => {
  for (const step of [
    "Stop and say so if you find a 0.3.x pin or a legacy page: one whose own code calls the Campaigns JS or the Campaigns API directly for cart and checkout.",
    "Judge a legacy page by what drives its cart and checkout, not by a script URL.",
    "When the range removes a feature the campaign uses, say so, and do not just delete the call",
    "If none is documented, stop and ask.",
    "Classify every `next:initialized` listener.",
    "every SDK page, upsells included, on one fresh load and then five cached reloads",
    "the fresh and cached load counts per SDK page",
    "report that it does not speak for the versions above it",
    "pass `--local-only` unless the developer wants the verdict there",
    "Keep `qa-output/` out of commits",
    "campaigns-os qa install-browser",
    'grep -rn "campaign-cart@v" src',
    "campaign-cart@v{{ campaign.sdk_version }}",
    "sdk repin --target <funnel folder>",
    "Scope it to the funnel folder, not the repository root.",
    "Read the release notes and the source diff between the two Campaign Cart tags.",
    "Trace where the funnel's purchase event comes from before the bump.",
    "sdk storage-check --target <git-root>",
    "it does not look above `--target`",
    "plan a 3-D Secure test order in step 6",
    "unrendered `{{`",
    "at the highest version its supported range declares",
    "doctor --built <repo> --family <family> --slug <slug>",
    "Pin the run to the store's main market.",
    "never reads browser geolocation",
    "confirm the page shows that currency and the country is selected",
    "`?currency=<main>&country=<main>`",
    "Do not add `?ignore=true` to stop them",
    "which analytics vendors received test-order events",
    "place test orders only on slugs marked live",
    "ask the developer which are live.",
    "Ask these up front, together with test orders",
    "contracts/template-brand-contract.<family>.v0.json",
    "do not guess from page or folder names",
    "Expect that change and commit it on the bump branch",
    "ask before installing one",
    "@nextcommerce/campaigns-os@<reviewed-version>",
    "If there is no `CLAUDE.md`, or a slug has no status line",
    "Never treat a missing status as live or as retired.",
    "pass `--currency <main>`: it tags each funnel's entry page",
    "show the developer the live slugs and the orders you will place on each",
    "name them in the question",
    "The runner's test orders use a US shipping address by default.",
    "add `--test-country <main>`, `--test-address1`, `--test-city`, `--test-province` and `--test-postal`",
    "The runner warns when a non-USD `--currency` has no `--test-country`.",
    "run it without `--test-order` and place the orders by hand on the market-pinned page.",
    "Leave out of the cached reloads the receipt and any page where step 3 found a hand-wired purchase push",
    "List any payment or express-checkout method the range adds",
    "exactly matches a key in `_data/campaigns.json`",
    "never install into a folder the site publishes from",
    "once per bumped slug, retired ones included",
    "run it once per live slug",
    "Ask before every push, before opening the pull request, and before test orders.",
    "Never write evidence or notes into the served tree",
    "what is not proven, and which orders to cancel",
  ]) {
    assert.ok(skill.includes(step), `missing: ${step}`);
  }
});

test("the SDK bump skill keeps its seven steps in order", () => {
  const headings = [...raw.matchAll(/^## (\d)\. (.+)$/gm)].map((match) => `${match[1]}. ${match[2]}`);
  assert.deepEqual(headings, [
    "1. Branch",
    "2. Find every pin",
    "3. Read the release diff against the campaign",
    "4. Storage check",
    "5. Build and check",
    "6. Preview proof",
    "7. Hand back",
  ]);
});
