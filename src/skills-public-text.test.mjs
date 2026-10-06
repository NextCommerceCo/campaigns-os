// The operator-decision instructions the stage skills and agent files ship
// word for word. Each is checked whitespace-normalised, so rewrapping a line
// passes and dropping or rewording a sentence fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const normalized = (text) => text.replace(/\s+/g, " ").trim();
const readNormalized = (path) => normalized(readFileSync(join(ROOT, path), "utf8"));

const READABILITY_REPAIR = "When a readability warning appears, report it with its colours, ratio, requirement and pages. Offer the operator options inside the brand palette (a darker or lighter shade of the same hue, the palette's text colour, or a larger, bold label where the design allows). Do not recolour the merchant's design until the operator chooses. Accept a warning only with the refs, reason and name the operator gives you at the QC handoff.";
const BUILD_DEVIATION = "If `next` reports that the build output is unchanged after a brief or CampaignSpec change, rebuild so the change reaches the pages. Pass `--deviation-reason` to `record build` only when the operator explicitly decides in this conversation that the change needs no change to the built pages, and quote their reason.";
const POLISH_SKIP = "Record Polish as `skipped` only when the operator decides in this conversation to skip it, and quote their reason as `skip_reason`.";
const AGENT_CONTEXT = "A NEXT campaign is one connected commerce journey: the pages the CampaignSpec declares, in its order, through product choice, checkout, post-purchase offers and receipt. Creative intent — audience, purpose, layout, imagery, approved copy, visual style — belongs to the operator, the Campaign Build Brief and the accepted design source. Commerce behaviour — products, package IDs, prices, offers, shipping, routes, cart, checkout, payment and post-purchase — belongs to CampaignSpec/API values and the SDK. Before changing a campaign, read the normalized brief at `.campaign-runtime/input/campaign-build-brief.normalized.json` and the recorded decisions: `adapter_decisions`, `decisions` and `theme` in `.campaign-runtime/assembly-report.json`, and `assembly.template_decision_notes` in the Build Packet. The setup, build, Polish and QA prompts begin with a campaign intent summary, and every `next` result carries it (`intent_summary` in JSON); treat it as orientation, never as a source of prices or behaviour. When a revision is narrow, keep the recorded intent and ask only about missing choices that affect that revision. Ask the operator before saving brief answers.";
const STAGE_INTENT = "The campaign intent summary at the top of the setup, build, Polish and QA prompts and in every `next` result is orientation, never a source of prices or commerce behaviour.";

const SHIPPED = [
  ["the readability repair guidance", READABILITY_REPAIR, ["skills/next-campaigns-polish/SKILL.md", "skills/next-campaigns-qa/SKILL.md"]],
  ["the build deviation-reason instruction", BUILD_DEVIATION, ["skills/next-campaigns-build/SKILL.md"]],
  ["the Polish skip instruction", POLISH_SKIP, ["skills/next-campaigns-polish/SKILL.md"]],
  ["the campaign intent summary sentence", STAGE_INTENT, ["skills/next-campaigns-os-setup/SKILL.md", "skills/next-campaigns-build/SKILL.md", "skills/next-campaigns-polish/SKILL.md", "skills/next-campaigns-qa/SKILL.md"]],
  ["the campaign context paragraph", AGENT_CONTEXT, ["agents/claude/CLAUDE.md", "agents/codex/AGENTS.md", "agents/copilot/copilot-instructions.md", "agents/cursor/campaigns-os.mdc"]],
];

test("skills and agent files keep the operator-decision instructions word for word", () => {
  const missing = SHIPPED.flatMap(([label, text, files]) => files.filter((file) => !readNormalized(file).includes(text)).map((file) => `${file}: ${label}`));
  assert.deepEqual(missing, [], "files missing a shipped instruction");
});
