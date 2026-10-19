// The SDK bump skill (#677) carries the steps an agent cannot discover from
// the toolkit alone. Each is checked whitespace-normalised, so rewrapping a
// line passes and dropping a step fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const skill = readFileSync(join(ROOT, "skills/next-campaigns-sdk-bump/SKILL.md"), "utf8").replace(/\s+/g, " ");

test("the SDK bump skill names each step the bump needs", () => {
  for (const step of [
    "Stop and say so if you find a 0.3.x pin",
    'grep -rn "campaign-cart@v" src',
    "campaign-cart@v{{ campaign.sdk_version }}",
    "sdk repin --target <funnel folder>",
    "Scope it to the funnel folder, not the repository root.",
    "Read the release notes and the source diff between the two Campaign Cart tags.",
    "Trace where the funnel's purchase event comes from before the bump.",
    "sdk storage-check --target <git root>",
    "at the highest version its supported range declares",
    "doctor --built <repo> --family <family> --slug <slug>",
    "Pin the browser to the store's main market",
    "Ask before every push, before opening the pull request, and before test orders.",
    "Never write evidence or notes into the served tree",
    "what is not proven, and which orders to cancel",
  ]) {
    assert.ok(skill.includes(step), `missing: ${step}`);
  }
});
