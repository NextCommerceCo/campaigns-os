---
name: next-campaigns-os
description: Coordinate Campaigns OS lifecycle workflows from CampaignSpec, Build Packet, starter-template contracts, stage reports, deploy evidence, and QA proof depth.
---

# Campaigns OS

Use this skill to orient a campaign build, run preflight, decide the next stage, and keep the lifecycle honest.

## Public Lifecycle Boundary

The public `campaigns-os` package owns portable workflow semantics: Build
Packet generation, Build Context, Assembly Report validation, doctor/readiness
decisions, public build/polish/QA guidance, and browser QA runner behavior.
It also owns CampaignSpec validation through the public
`@nextcommerce/campaigns-os/campaign-spec` subpath; Map Builder, the public
doctor, and agency tooling should consume that same rule registry instead of
vendoring or reimplementing spec rules.
Internal orchestration may wrap this workflow for the Map Builder,
issue-tracker projection, QA routing, dashboards, and promotion decisions,
but those wrappers should not redefine the public contract.

Workflow:

1. Confirm the campaign was configured in Campaigns App and exported from Campaign Map Builder as current CampaignSpec JSON. Current authoring is v4.3+ while preserving the v4.2 `funnels[]` topology as the compatibility shape.
2. Run `campaigns-os start` or `campaigns-os prepare-build` with a local CampaignSpec, prepared HTML/assets source, target page-kit repo, and explicit template family. The family must be certified (commerce catalog + brand contract; the CLI lists them on rejection) — an uncertified/custom family requires `--allow-uncertified-template "<reason>"` and forfeits deterministic assembly, residue QA, and pricing contracts. The entry point auto-opens the run session in the target repo; do not skip `campaigns-os run end` at the finish.
3. Brand-theme discovery runs in inspect-only mode by default and records `context.theme`. When it proves a brand theme is generatable and the campaign ships commerce pages, the theme gate BLOCKS polish/deploy/QA until the brand layer is applied after `next-core.css` or explicitly waived (`campaigns-os theme waive --packet <p> --reason "<why>"`). Run `campaigns-os theme generate` and apply it during build; do not defer the decision.
4. Run `campaigns-os doctor --packet <packet>`.
5. If doctor returns `collect-inputs`, stop and resolve the named blockers.
6. If doctor returns `assembly`, hand off with `campaigns-os next build --packet <packet>`.
7. After build, require polish and a preview deploy before QA.
8. Run the package-owned proof path in sequence: `npm run qa:install-browser`, `campaigns-os qa resolve --packet <packet>`, then `campaigns-os qa run --packet <packet> --base-url <url> --browser --test-order common`.
9. Treat typed-card proof depth as the control. Global test cards bypass the gateway and create no transactions, so no permission/approval is needed (`common` by default, `full` for every permutation). Localhost on any port is a Campaigns App Development domain for SDK QA with analytics suppressed; non-localhost preview/production origins still need SDK origin allowlist confirmation.
10. Discuss launch only from recorded build, polish, deploy, browser QA, and test-order evidence, or from explicit blockers.

## Session Intake

When a Campaigns OS session starts, classify the starting path before handing
off to setup, build, polish, QA, or promotion. The operator should separate:

- Intent: build, partial page update, existing campaign update, QA only, repair from verdict, design/source assembly, or promotion.
- Source truth: CampaignSpec/Map Builder export, Figma/design file, prepared HTML, existing campaign repo, deployed URL, or target deployment system.
- Runtime truth: Build Packet, Build Context, Assembly Report, doctor JSON, tested URL, API key source, and SDK origin allowlist state (localhost is already a Development domain; non-localhost origins still need confirmation).
- Change policy: what may change and what must be preserved, especially checkout, offer logic, routes, legal copy, and live campaign behavior.
- Proof depth: visual preview, doctor, browser QA, QA portal/local verdict policy, typed-card test-order depth, market coverage, and repair routing.

Return a compact brief before acting:

```text
Mode:
Intent:
Source truth:
Runtime truth:
Change policy:
Proof depth:
Next skill/command:
Missing inputs:
```

Use `references/session-intake.md` when the mode, allowed changes, or proof
depth is unclear. Ask only for fields needed by the selected starting path; a
QA-only session should not require design files, and a partial landing update
should not force full checkout/test-order depth unless commerce or routing can be
affected.

Rules:

- This is contract-backed guidance and preflight, not full automated readiness.
- Preserve CampaignSpec as the source of truth. Do not make CampaignSpec absorb source-export paths, target repo paths, template decisions, deploy status, or test-order depth; those belong in the Build Packet and stage reports.
- Treat `spec.validation` doctor findings as public CampaignSpec rule findings. When JSON output carries `detail.ruleId`, `detail.path`, and `detail.data`, use those fields for UI/repair routing instead of parsing message text.
- CampaignSpec/API own live commerce values.
- Treat checkout `exit_intent` and `promo_code_input` as optional CampaignSpec launch contracts. If present, build must wire the mapped offer surface and QA must exercise the accept/apply path.
- Keep offer application surfaces out of pricing logic: they validate/apply codes through SDK/API, while Campaigns API/SDK own repricing, totals, and discount rows.
- Starter-template `agentContract` owns reusable commerce structure and protected SDK surfaces.
- Promoted starter-template families must also have `contracts/template-brand-contract.<family>.v0.json` with family inventory, brand/residue, pricing, and exit-pop rules. Missing family contracts are gates, not advisory gaps.
- Designed source owns visual composition and page-level content.
- Brand-theme evidence is workflow-order neutral. Do not assume a Figma export came first; consume `context.theme` and `.campaign-runtime/theme/theme-report.json` when present. A truly missing/ungeneratable theme stays a warning, but a generatable-and-unapplied theme on a commerce-page campaign is a gate: apply it or waive it explicitly before polish/deploy/QA.
- Follow `campaigns-os next` literally. Every `next` response carries `gates` (doctor, prepare_build, theme_gate) and `next_actions` with exact commands — execute those instead of improvising. With an active run session, pipeline-advancing commands that don't match the last `next` recommendation are recorded to `.campaign-runtime/agent-deviations.jsonl`; declare an intentional detour with `--deviation-reason "<why>"`.
- Close the loop: when `next` reports `done` (or QA has published its verdict and the PR is up), finish with `campaigns-os run end` so the Run Record is assembled and the run session clears. `campaigns-os run status` shows incomplete stages and the exact next command at any point.
- Do not copy demo refs or unsupported optional surfaces into the target campaign.
- Use SDK conditionals such as `cart.hasCoupon("CODE")` for code-specific presentation; do not mutate visible prices from campaign-specific JavaScript.
- Build Packet, Build Context, and Assembly Report paths should be repo-relative when possible so handoff artifacts can be committed without machine-local absolute paths.
- Preserve Build Context `theme` inspection state and Assembly Report `theme` application state when present; they are public v0 contract fields and should not be dropped by wrappers, setup reruns, or repair passes.
- Store Profile fields are operator-entered storefront/legal metadata for page-kit `campaigns.json`; they do not come from the Campaigns API and should be collected in the CampaignSpec before build.
- Keep the lifecycle in a tight sequence. Pause only for missing inputs, doctor blockers, deploy blockers, out-of-scope runtime pages, or merchant-specific uncertainty.
- `campaigns-os standardize` audits the campaign ecosystem read-only: it recognizes Page Kit roots and non-Page-Kit Campaign Cart applications (Vite/React/Express apps, static HTML funnels) via portable evidence, classifies each root (`implementation.kind`), validates checkout field bindings against the Campaign Cart field contract, and evaluates loader versions against the SDK support policy contract. Findings carry `confidence` (`static_contract`, `static_inference`, `runtime_proof_required`); treat `runtime_proof_required` findings as missing proof, never as confirmed defects, and route them to browser QA rather than static repair.
- Launch readiness is separate from Campaigns OS proof. Surface production storefront URL, live payment methods, shipping markets, legal/support URLs, analytics expectations, and merchant-side configuration as real-shopper readiness items, not Campaigns OS build blockers.
- Browser QA and test-order proof are owned by Campaigns OS through Playwright. Do not route the core QA path through external browser skills or hand-built backend orders.
