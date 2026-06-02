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
Internal orchestration may wrap this workflow for Map Builder,
Linear projection, QA Supervisor routing, dashboards, and promotion decisions,
but those wrappers should not redefine the public contract.

Workflow:

1. Confirm the campaign was configured in Campaigns App and exported from Campaign Map Builder as current CampaignSpec JSON. Current authoring is v4.3+ while preserving the v4.2 `funnels[]` topology as the compatibility shape.
2. Run `campaigns-os start` or `campaigns-os prepare-build` with a local CampaignSpec, prepared HTML/assets source, target page-kit repo, and explicit template family.
3. Run `campaigns-os doctor --packet <packet>`.
4. If doctor returns `collect-inputs`, stop and resolve the named blockers.
5. If doctor returns `assembly`, hand off with `campaigns-os next build --packet <packet>`.
6. After build, require polish and a preview deploy before QA.
7. Run the package-owned proof path in sequence: `npm run qa:install-browser`, `campaigns-os qa resolve --packet <packet>`, then `campaigns-os qa run --packet <packet> --base-url <url> --browser --test-order common`.
8. Treat typed-card proof depth as the control. Global test cards bypass the gateway and create no transactions, so no permission/approval is needed (`common` by default, `full` for every permutation). Localhost on any port is a Campaigns App Development domain for SDK QA with analytics suppressed; non-localhost preview/production origins still need SDK origin allowlist confirmation.
9. Discuss launch only from recorded build, polish, deploy, browser QA, and test-order evidence, or from explicit blockers.

## Session Intake

When a Campaigns OS session starts, classify the starting path before handing
off to setup, build, polish, QA, or promotion. The operator should separate:

- Intent: build, partial page update, existing campaign update, QA only, repair from verdict, design/source assembly, or promotion.
- Source truth: CampaignSpec/Map Builder export, Figma/design file, prepared HTML, existing campaign repo, deployed URL, or target deployment system.
- Runtime truth: Build Packet, Build Context, Assembly Report, doctor JSON, tested URL, API key source, and SDK origin allowlist state (localhost is already a Development domain; non-localhost origins still need confirmation).
- Change policy: what may change and what must be preserved, especially checkout, offer logic, routes, legal copy, and live campaign behavior.
- Proof depth: visual preview, doctor, browser QA, posted verdict, typed-card test-order depth, market coverage, and repair routing.

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
- CampaignSpec/API own live commerce values.
- Treat checkout `exit_intent` and `promo_code_input` as optional CampaignSpec launch contracts. If present, build must wire the mapped offer surface and QA must exercise the accept/apply path.
- Keep offer application surfaces out of pricing logic: they validate/apply codes through SDK/API, while Campaigns API/SDK own repricing, totals, and discount rows.
- Starter-template `agentContract` owns reusable commerce structure and protected SDK surfaces.
- Designed source owns visual composition and page-level content.
- Do not copy demo refs or unsupported optional surfaces into the target campaign.
- Use SDK conditionals such as `cart.hasCoupon("CODE")` for code-specific presentation; do not mutate visible prices from campaign-specific JavaScript.
- Build Packet, context, and assembly-report paths should be repo-relative when possible so handoff artifacts can be committed without machine-local absolute paths.
- Store Profile fields are operator-entered storefront/legal metadata for page-kit `campaigns.json`; they do not come from the Campaigns API and should be collected in the CampaignSpec before build.
- Keep the lifecycle in a tight sequence. Pause only for missing inputs, doctor blockers, deploy blockers, out-of-scope runtime pages, or merchant-specific uncertainty.
- Launch readiness is separate from Campaigns OS proof. Surface production storefront URL, live payment methods, shipping markets, legal/support URLs, analytics expectations, and merchant-side configuration as real-shopper readiness items, not Campaigns OS build blockers.
- Browser QA and test-order proof are owned by Campaigns OS through Playwright. Do not route the core QA path through external browser skills or hand-built backend orders.
