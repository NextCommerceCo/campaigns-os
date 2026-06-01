# Campaigns OS Session Intake

Use this reference when a Campaigns OS session begins without an already-clear
Build Packet, QA verdict, or promotion task. The goal is to make the operator
separate intent, source truth, runtime truth, change policy, and proof policy.

## Intake Envelope

Return this compact brief before running a specialist skill or command:

```text
Mode:
Intent:
Source truth:
Runtime truth:
Change policy:
Proof policy:
Next skill/command:
Missing inputs:
```

Definitions:

- Intent: what the user wants done, such as build, update, QA, repair, or promote.
- Source truth: CampaignSpec/Map Builder export, Figma/design file, prepared HTML, existing campaign, target repo, or deployed URL.
- Runtime truth: Build Packet, Build Context, Assembly Report, doctor JSON, repo state, deployed preview/production URL, Campaigns API key source, SDK origin allowlist (so the SDK loads), and test-order depth choice.
- Change policy: what may change and what must be preserved, especially checkout, offer logic, live campaign routes, and legal/merchant copy.
- Proof policy: visual preview, doctor, browser QA, posted verdict, typed-card test-order depth, market coverage, and repair routing.

Ask only for the fields needed by the selected mode. Do not force a full-funnel
build prompt when the user only needs QA, a partial page update, or repair from
an existing verdict.

## Starting Paths

### Full Campaign Build

Use when the user has CampaignSpec plus source/design material and wants an
end-to-end campaign.

Required before build:

- Map ID or CampaignSpec path/URL.
- Public route slug and target repo/output directory.
- Source type and source files: Figma, exported HTML, prepared HTML, existing campaign, or other.
- Pages in scope and any pages to preserve.
- Template family if known; otherwise infer and ask before locking commerce surfaces.
- Proof policy, including browser QA and the typed-card test-order depth to run.

Route to Build Packet preparation, doctor, setup when scaffold is missing,
build, polish, then QA.

### Design Or Source Assembly

Use when design/source material exists but repo/tooling context is incomplete.

Collect:

- Source authority: Figma link/file, exported HTML, AI-generated HTML, existing campaign, or assets folder.
- Intended page map and any commerce surfaces represented in the source.
- CampaignSpec or Map Builder status, if available.
- Target implementation uncertainty: repo, template family, public route, deployment target.

Output a Build Packet or source-adapter findings. Ask before changing checkout,
offer, upsell, or receipt behavior when template family or runtime contracts are
unknown.

### Partial Page Build

Use when only landing, presell, checkout skin, upsell, downsell, receipt, or a
specific component is in scope.

Collect:

- Page(s) in scope and pages explicitly out of scope.
- Whether commerce logic, SDK attributes, routing, checkout submit behavior, or offer logic may change.
- Source authority for the selected page(s).
- Proof needed for affected surfaces.

Route to build or polish for scoped changes, then QA only the affected page
paths plus downstream runtime paths that may have been affected.

### Existing Campaign Update

Use when a deployed or repo-backed campaign already exists.

Collect:

- Existing repo/branch and preview/production URL.
- Current Build Packet, pass log, Assembly Report, or doctor output if present.
- Exact allowed changes and preservation rules.
- Whether live offer logic, checkout, routes, tracking, or legal copy may change.

Run doctor when a packet exists. If no packet exists, reconstruct enough runtime
truth before editing. Do not infer permission to alter commerce logic from a
visual update request.

### QA Only

Use when the user wants evidence on a deployed campaign and no source edit.

Collect:

- Map ID and deployed base URL.
- Build Packet path if local; otherwise enough info to resolve topology.
- Whether browser QA should run.
- Whether verdict must post to the QA dashboard.
- Typed-card test-order depth (`common`/explicit/`full`).

Route to QA. Do not patch campaign code from the QA-only path.

### Repair From QA Verdict

Use when a posted/local verdict or QA dashboard run exists.

Collect:

- Verdict path or dashboard URL/run ID.
- Build Packet and Assembly Report paths when local.
- Whether repair may edit source, and which surfaces are protected.
- The typed-card test-order depth to re-run for the retest.

The public verdict is the source of repair truth. Route repairable items to
specialist skills, ask only the needed clarification questions, and keep
typed-card order failures as manual/specialist handoffs unless the owner and
the test-order depth to re-run are clear.

### Promotion Or Experiment

Use when the user wants to interpret performance evidence or promote a funnel.

Collect:

- CampaignSpec path and funnel IDs.
- Performance by Page evidence or date range.
- Winner, confidence notes, and any exceptions.
- Deployment/routing target and whether config changes should become a PR.

Route through decision creation, promotion, and generated routing config. Do not
hand-edit deployed routing config as the primary promotion path.

## Test-Order Proof Policy

Treat test orders as cheap, repeatable proof: global test cards bypass the
gateway and create no transactions, so they need no permission or approval. The
only real choice is depth. Record:

- Depth: `common` (default 3-5 shape sample), `off`, `checkout`, `decline`, `accept`, `both`, `full`, or explicit paths such as `decline-decline-accept`.
- Cart matrix: base cart, base plus bump, specific package refs/quantities.
- SDK origin allowlisted (so the SDK loads): yes/no/unknown — separate from test-order permission.
- Max order cap: the accidental-flood guard; raise `--max-test-orders` for exhaustive proof.
- Market coverage: default market only or at least one non-default country/currency path.
- Customer email: reuse one inbox via `--test-email`/`CAMPAIGNS_OS_QA_TEST_EMAIL` (the customer record is not deletable).

`--test-order common` covers the typical checkout-plus-accept/decline sample
automatically. Use `full` when you want every generated permutation.
