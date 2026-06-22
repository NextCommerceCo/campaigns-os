# Campaigns OS Context

Campaigns OS coordinates campaign build, proof, and learning work around a
CampaignSpec-driven workflow. This glossary keeps the public workflow language
separate from internal orchestration, QA defects, and implementation artifacts.

## Language

**Certified Template Family**:
A template family present in the commerce surface catalog AND carrying a
template brand contract — the set the OS can automate end-to-end with
deterministic assembly, residue QA, and pricing contracts. `start`/
`prepare-build` accept only certified families by default; building on
anything else requires `--allow-uncertified-template "<reason>"`, recorded on
the Build Packet as `assembly.template_certification.waiver`. NEXT provides
the rails: the certified set grows by shipping new contracted families, not
by loosening the gate.
_Avoid_: supported template, known family, template allowlist

**Theme Gate**:
The deterministic decision point that blocks `next polish|deploy|qa` and
`qa run` when theme inspect proved a brand theme is generatable, the campaign
ships commerce pages, and the brand layer is neither applied (after
`next-core.css`) nor explicitly waived. Evaluated once in the doctor
(`derived.theme_gate`) and consumed identically by `next` and QA. A waiver
(`theme waive` / `--theme-waive`) is the only sanctioned bypass and is recorded
on the Assembly Report with a reason.
_Avoid_: advisory warning, recommendation, soft check

**Template Brand Contract**:
A per-family contract file (`contracts/template-brand-contract.<family>.v0.json`)
declaring required `--brand--*` token overrides, starter defaults that count as
shipped residue (palette hexes, starter logo, unsupported payment chrome), the
CSS load-order rule for the brand layer, the selectors browser QA inspects for
applied brand tokens, and pricing-surface modes. QA reads it to fail "still
visually the starter template" deterministically.
_Avoid_: style guide, design tokens doc, theme report

**Template Reference**:
The canonical baseline for a template family: its safe runtime structure,
expected screenshots or render references, default assets, starter residue
signatures, and family-specific comparison anchors. Template Reference is
declared by the Template Brand Contract and may be supported by captured
reference artifacts; the normal authority is template-versioned, while campaign
runs may capture or refresh references for provenance when needed. Template
Reference informs Build and Polish about the selected template family without
becoming campaign creative intent.
_Avoid_: design source, starter inspiration, visual target

**Pricing Mode**:
The declarative way a pricing surface (checkout bundle, bump, upsell) renders
its price rows: `full_price`, `discounted`, `compare_at`, `unit_total`, or
`unit_only`. Partials render the right rows for the mode; campaign CSS must
never hide price rows with `display:none`. A full-price upsell shows exactly
one visible price row; zero visible price rows is a QA blocker.
_Avoid_: CSS cleanup, price hiding, discount styling

**Deviation Telemetry**:
The sidecar journal (`.campaign-runtime/agent-deviations.jsonl`) that records
when a pipeline-advancing command does not match the last `campaigns-os next`
recommendation on an active run session: recommended stage/commands, actual
command, and an optional `--deviation-reason`. It measures "the agent ignored
the orchestrator"; hard enforcement lives in the gates, not here.
_Avoid_: audit log, compliance gate, blocker

**Run Telemetry**:
The Campaigns OS surface that captures what happened on each run and, with
consent, remits it to NEXT so the toolchain improves over time. Capture is
always local; consent gates remit only. Run Telemetry is the umbrella that
Workflow Findings now sit inside as one channel — it is not a separate product
from the findings work, it is its grown-up form.
_Avoid_: analytics SDK, crash reporter, separate feedback product

**Run Record**:
The per-run manifest Run Telemetry produces, keyed by one canonical `run_id` and
written to `.campaign-runtime/run-records/<run_id>.json`. It carries a stable
envelope, run identity, source-artifact references (`{path, schema_version,
sha256, material_fingerprint}` where available), normalized observation arrays
(doctor codes, spec-rule fires, adapter decisions, QA disposition), and a
snapshot of this run's Workflow Findings. It may snapshot the Campaign Readiness
Readback for audit, but it references the proof trail; it does not re-embed or
replace it.
_Avoid_: unified mega-artifact, log dump, proof artifact

**Workflow Finding**:
A human- or agent-observed gap, friction, or positive signal about the Campaigns
OS workflow itself. A Workflow Finding may cite a Build Packet, Assembly Report,
doctor output, or QA Verdict as evidence, but it does not replace those artifacts.
_Avoid_: QA defect, bug report, friction log

**Findings Sidecar**:
The local Workflow Finding capture channel — the human/agent lane within Run
Telemetry, distinct from the automatic system-signal lane. It records local
findings (append-only journal) and is not the owner of remit, Linear routing,
team assignment, or internal prioritization. "Sidecar" now names this channel,
not the whole telemetry surface (that is Run Telemetry / the Run Record).
_Avoid_: the telemetry surface, Linear sync, feedback dashboard, QA reporter

**Observation Stage**:
The lifecycle moment where a Workflow Finding was noticed. Observation Stage is
broader than the orchestration stage picker: it includes `overall`, `intake`,
`start`, `doctor`, `setup`, `build`, `polish`, `deploy`, `qa`, `test-order`, and
`next`.
_Avoid_: status, owner, milestone

**Findings Journal**:
The append-only local record of Workflow Findings for a campaign run. The
Findings Journal preserves observed workflow signals; summaries, deduplication,
and routing are derived later by internal aggregation.
_Avoid_: current summary, backlog, dashboard state

**Finding Capture**:
The act of adding a Workflow Finding to the local Learning Trail. Finding
Capture should be available to both Campaigns OS Operators and agents without
requiring internal NEXT systems.
_Avoid_: submission, sync, issue creation

**Learning Trail**:
The accumulating record of workflow signals that helps Campaigns OS improve over
time, now realized as Run Telemetry's Run Records (system signal + the findings
channel). The Learning Trail is separate from the formal proof trail recorded in
the Assembly Report, doctor output, and QA Verdict.
_Avoid_: launch evidence, stage proof, assembly status

**Campaign Run Identity**:
The context that ties a Run Record and its Workflow Findings to one campaign run.
A canonical `run_id` is the correlation and idempotency key, minted at the run
boundary and threaded through the run (and onto findings) so a run's signal is
exact, not time-inferred. Best-effort descriptive identity — Map ID, campaign
slug, target repo, packet path, Assembly Report path, QA run ID, source type,
template family — travels alongside it and may be incomplete; missing identity
never prevents capture.
_Avoid_: required metadata, primary key, campaign record

**Run Session**:
An ambient `run_id` resolved once for a run so that the commands a run touches
(doctor, harvest, findings add, run-record) share one identity without each call
re-specifying it. An explicit `--run-id` always wins over the session.
_Avoid_: global mutable state, per-command id reinvention

**Readiness Checkpoint**:
A durable lifecycle boundary that lets Campaigns OS say whether a campaign can
proceed, is blocked, or is ready with explicit gaps or waivers. `ready_with_gaps`
is a valid checkpoint outcome when known Source Gaps are present but the work is
ready enough for the next stage; unfinished TODOs remain blocking unless
explicitly waived. A Readiness Checkpoint is artifact-backed and resumable across
turns, sessions, or machines; a one-shot campaign run is only the best-case path
where every checkpoint is already satisfied. Checkpoints expose what was
handled, what was not handled, and what must be resolved next without relying on
chat history.
_Avoid_: launch readiness, session transcript, vague status

**Checkpoint Status**:
The shared small vocabulary used to summarize Readiness Checkpoints across
Campaigns OS stages: `pending`, `blocked`, `ready`, `ready_with_gaps`,
`ready_with_waivers`, `completed`, `completed_with_warnings`, and `skipped`.
`ready_with_waivers` is only a summary state; the actual accepted exception must
be carried as a structured Checkpoint Waiver. Stage-specific nuance belongs in
evidence, Source Gaps, Source TODOs, waivers, findings, and next actions rather
than in one-off status names.
_Avoid_: stage-specific status dialect, prose-only state, hidden blocker

**Checkpoint Waiver**:
A structured, attributed exception that lets a Readiness Checkpoint proceed
despite a known gap, TODO, or gate that would otherwise block the next stage. A
Checkpoint Waiver carries who accepted it, why, its scope, what it applies to,
when it was created, and either an expiry or review condition. Waivers are
operational and time-bound; they summarize into `ready_with_waivers` but do not
replace the underlying evidence, gap, TODO, or gate result. A lifecycle stage may
recommend or draft a waiver with evidence, but approval belongs to an
operator/run decision rather than the stage that found the exception.
_Avoid_: waived status only, permanent approval, hidden exception

**Evidence Quality**:
The declared strength of evidence behind a Workflow Finding, such as operator
report, artifact reference, artifact attachment, or system observation. Evidence
Quality lets useful signals enter the Learning Trail without pretending all
signals are QA Verdicts.
_Avoid_: confidence score, proof status, launch readiness

**Tiny Prompt**:
A skippable one-line Campaigns OS prompt that helps the operator notice the next
expected proof step or optionally record a Workflow Finding. Tiny Prompts must
not block lifecycle progress or turn into surveys.
_Avoid_: required survey, gate, checklist

**Finding Kind**:
The small operator-facing classification for a Workflow Finding, such as
positive signal, friction, missing prompt, blocker, docs gap, automation gap, or
idea. Finding Kind helps later aggregation without asking the operator to choose
from product-management categories.
_Avoid_: issue type, Linear label, priority

**Finding Author**:
The source of a Workflow Finding: a Campaigns OS Operator, an agent observing
artifacts and commands, or the system recording a deterministic lifecycle signal.
Agents may record observed workflow gaps, but they must not invent subjective
operator feedback.
_Avoid_: assignee, reporter, owner

**Campaigns OS Operator**:
A person or agent using Campaigns OS to assemble, adapt, prove, or repair a
campaign. Operators include internal campaign team members and future agency
users; they do not include shoppers or ordinary merchant-facing campaign approval
viewers.
_Avoid_: end user, shopper, customer

**Spec-Driven Campaign Development**:
The Campaigns OS operating model where an accurate CampaignSpec preserves the
campaign's core logic and makes build, checkout, upsell, and QA behavior
verifiable. Workflow Findings should help improve this Spec-centered flow rather
than collect unrelated product complaints.
_Avoid_: asset-first build, page-only development

**Design Source**:
The upstream creative/provenance input for campaign page presentation, such as
Figma frames, prepared HTML, a figma-sections export, existing Page Kit pages, or
agency-produced static source. Design Source owns visual composition, content
hierarchy, imagery, page-level copy, and brand presentation intent; it does not
own CampaignSpec commerce truth or SDK/runtime contracts.
_Avoid_: source of truth, design artifact, creative vibes

**Design Source Package**:
The public normalized Campaigns OS representation of a Design Source that Build
and Polish consume across source kinds. Its schema identity is
`campaign-design-source-package/v0`, reflecting upstream creative/provenance
context rather than runtime assembly proof. Every normal build has a Design
Source Package, with source-kind-specific depth, and a package may aggregate
multiple Design Sources for one campaign; it preserves provenance, presentation
intent, Source Gaps, Source TODOs, and source-side comparison references without
replacing the CampaignSpec or template runtime contracts. Its freshness is tracked
independently from CampaignSpec and build fingerprints because campaign logic
and creative source can change on different timelines. It is separate from the
Campaign Build Brief, which captures merchandising interpretation and business
questions. Missing Design Source Package or page-level mapping blocks a normal
build; explicit Source Gaps may produce a `ready_with_gaps` source-readiness
checkpoint and travel forward as known constraints, while Source TODOs mark
unfinished preparation unless explicitly waived. Agencies may provide loose
creative inputs or a prebuilt package, but Build and Polish consume the
normalized package contract. It is a new public artifact alongside producer
manifests such as `source-html-manifest`; source manifests may seed the package,
but they do not become the broader Design Source Package. During v0
compatibility, source preparation may synthesize a package from legacy
`packet.source_html` and source-html manifest data, but downstream Build and
Polish still consume the synthesized package rather than falling back to a
separate legacy source model. The package is referenced by the Build Packet,
Build Context, and Assembly Report through artifact references and fingerprints
rather than embedded wholesale.
_Avoid_: handoff notes, source adapter output, design brief

**Source Package Fingerprint**:
The material freshness identity of a Design Source Package, distinct from the
full artifact hash used for audit. Material source changes create a new Source
Package Fingerprint; administrative edits that do not change source readiness or
the comparison basis may change the full hash without changing the freshness
identity.
_Avoid_: build fingerprint, timestamp, chat-state marker

**Assembly Source Package Fingerprint**:
The Source Package Fingerprint recorded by Assembly for the design source
context used to produce the built campaign. If it differs from the current
Source Package Fingerprint, the build is stale before Polish begins.
_Avoid_: polish source proof, build hash, inferred source state

**Source Freshness Waiver**:
An exceptional Checkpoint Waiver that allows Polish to proceed when Assembly used
a stale or unrecorded Source Package Fingerprint. It must be explicit, scoped,
attributed, and visible in readiness readback; it does not waive missing Polish
Evidence.
_Avoid_: silent stale-source acceptance, permanent design waiver, implicit pass

**Material Source Change**:
A Design Source Package change that affects source readiness, Contribution
Coverage, provenance, presentation intent, accepted exceptions, or the visual
comparison basis for Build, Polish, or QA. Material Source Changes make evidence
against the prior Source Package Fingerprint stale.
_Avoid_: typo edit, generated readback rewrite, formatting churn

**Design Source Readback**:
A short human-readable summary carried with a Design Source Package so an
operator or future agent can quickly understand the package across sessions. The
readback summarizes included sources, Contribution Coverage, known Source Gaps
and Source TODOs, page mappings, screenshot/reference availability, and current
source-readiness state. It is owned by source preparation and generated from the
structured package fields; the structured fields remain authoritative. Later
lifecycle stages may reference it, but they do not rewrite it.
_Avoid_: authoritative prose, chat summary, replacement for structured package

**Source Readiness Summary**:
The generated top-level readiness summary carried by a Design Source Package. It
indexes the package's current source-readiness state, blocking reasons, gap/TODO
counts, waiver count, and generation time so `next`, status, and readback can
present source readiness consistently. Source readiness uses the sharper
checkpoint states `pending`, `blocked`, `ready`, `ready_with_gaps`, and
`ready_with_waivers`; it does not use `ready_with_warnings`. Source Gaps, Source
TODOs, proposed exceptions, and Checkpoint Waivers remain the authoritative
records; the summary is an index over them. Free-form notes may provide helpful
context, but notes do not affect readiness and must not hide blockers or
exceptions that should be typed. Low-confidence contribution mappings affect
readiness only when they undermine required page-level primary coverage; that
case becomes a Source TODO unless explicitly waived.
_Avoid_: authoritative duplicate, inferred-only readiness, prose-only readiness

**Stage Readback**:
A short human-readable summary owned by a lifecycle stage, such as Build,
Polish, Deploy, or QA, that explains that stage's evidence, unresolved work, and
next checkpoint implications. Stage Readbacks exist to feed the Campaign
Readiness Readback, not to become a patchwork of hidden artifacts. A Stage
Readback may reference the Design Source Readback, but it does not mutate source
preparation provenance.
_Avoid_: Design Source Readback edit, chat transcript, replacement for evidence

**Campaign Readiness Readback**:
The consolidated or just-in-time human presentation of a campaign's current
Readiness Checkpoint state. It draws from Design Source Readback, Stage
Readbacks, structured evidence, gaps, TODOs, waivers, proposed divergences,
deployment state, QA proof, and next actions so the operator can see what exists,
what matters now, and what remains blocked. Its primary form is generated live
from the latest authoritative artifacts; Run Records may snapshot it for audit.
`campaigns-os next` presents a concise just-in-time readback for the recommended
stage and blockers; run or campaign status presents the fuller campaign-level
readback. The readback has stable sections as well as prose, covering the current
checkpoint, readiness status, handled work, blockers, known gaps, proposed
exceptions, waivers, evidence references, and next actions. Evidence is
referenced and summarized, not embedded; detailed proof stays in the artifact
that owns it. Screenshots travel as references; UI surfaces may render thumbnails
or previews from those references, but the readback itself is not an image
bundle. It is a presentation layer over the authoritative artifacts, not another
independent source of truth.
_Avoid_: artifact pile, hidden sidecar, separate campaign journal

**Design Source Contribution**:
One source-kind-specific contribution to a Design Source Package, such as Figma
frames, prepared HTML, a figma-sections export, existing Page Kit pages, or
agency-produced static source. A template-stock contribution can intentionally
point to the Template Reference when no bespoke design overlay exists. A
contribution usually represents one producer or source group and may cover
multiple pages, sections, or surfaces; it carries its own provenance, coverage,
confidence, and source gaps or TODOs. When the contribution is renderable, it
carries screenshot references for available viewports or explicitly records why
they are unavailable. Those screenshot references describe source or reference
availability, not built campaign output.
_Avoid_: input chunk, source blob, extraction source

**Source Screenshot Reference**:
A source-side or reference-side visual proof attached to a Design Source
Contribution or Template Reference. It records what visual source was available
for comparison before Build or Polish; it is not a screenshot of the built
campaign output.
_Avoid_: polish screenshot, QA proof, built render

**Viewport Key**:
The shared campaign evidence label for a responsive capture size, used across
Design Source Package records, Polish Evidence, and QA observations. A Viewport
Key names the comparison lane, while exact dimensions and device details stay in
artifact metadata.
_Avoid_: device nickname, stage-specific size name, raw width label

**Contribution Coverage**:
The explicit claim of what a Design Source Contribution handles, such as pages,
sections, checkout styling, brand tokens, assets, or a template-stock baseline.
Contribution Coverage is separate from Surface Identity mapping: coverage says
what the source claims to provide, while mappings say where those claims attach
to the campaign. Contribution mappings reference canonical Surface Identity IDs
and carry contribution-specific details such as coverage role, confidence,
source references, and notes; they do not redefine CampaignSpec, route, or Page
Kit projection mappings. Contribution coverage role uses a small stable
vocabulary, while notes explain unusual cases. Contribution mapping confidence
uses a coarse `high`, `medium`, `low`, or `unknown` scale to express confidence
that the contribution maps to that surface and coverage role; it is not source
trust, design quality, or approval. Low confidence blocks only when the mapping
is required page-level primary coverage; low confidence on brand tokens,
reference-only, or other non-primary coverage is carried as a gap, note, or
readback signal as appropriate. Coverage makes handled, unhandled, and
intentionally absent source areas readable during the process so gaps can be
audited and improved over time.
_Avoid_: inferred coverage, implied full-page ownership, hidden gap

**Required Page-Level Coverage**:
The minimum Design Source Coverage for each active or mapped page in the current
build scope. A page satisfies it through a non-low-confidence primary design
contribution, an explicit Template Reference-backed template-baseline
contribution for template-stock pages, or an attributed Source Gap or approved
Checkpoint Waiver explaining why no primary design source exists.
_Avoid_: implicit template default, unowned page, hidden missing source

**Contribution Trust**:
The declared machine-readability level of a Design Source Contribution, such as
native, structured, rendered, or opaque. Contribution Trust says how much the OS
can infer from the source shape before human review; it is not launch readiness
or visual quality.
_Avoid_: quality score, approval, fidelity

**Source Gap**:
An attributed absence in Design Source Coverage that is allowed to travel
forward as a known constraint, such as an agency providing brand tokens but no
checkout composition. A Source Gap describes what the source does not claim to
provide; it is not unfinished preparation work. Polish may reference an accepted
Source Gap that already exists in the Design Source Package. When Polish
discovers a new absence, it records a proposed Source Gap or Source TODO
candidate for confirmation rather than accepting it silently. Source Gaps carry
scope and applies-to references; they attach to Surface Identity when possible,
but campaign-level gaps are valid when the absence applies across the campaign
or no specific surface is appropriate.
_Avoid_: intake TODO, hidden omission, silent waiver

**Source TODO**:
An unfinished Design Source Package preparation task, such as a missing mobile
screenshot for a renderable source or an unreadable reference that should be
captured before Build. A Source TODO means the package is not ready for normal
Build unless the TODO is explicitly waived with attribution. Source TODOs carry
scope and applies-to references; they should name affected surfaces when
possible, but campaign-level TODOs are valid for package-wide preparation work.
_Avoid_: accepted gap, source limitation, downstream polish task

**Source HTML Intake**:
The Campaigns OS step that normalizes prepared source HTML into a Build Packet
mapping. Source HTML Intake keeps producer paths, CampaignSpec pages, and Page
Kit target shape distinct: `source_html.pages[].path` records source provenance,
while `source_html.pages[].page_kit` records the target page file, route, CPK
`page_type`, and frontmatter projection. CampaignSpec `page_url` and legacy
`url` values are interpreted as Page Kit public routes during projection, not as
source filenames or opaque preview URLs. Source HTML Intake can populate a
Design Source Contribution from a producer-authored source-html manifest, but
the manifest remains an adapter input rather than the normalized Design Source
Package.
_Avoid_: copying manifest paths directly into Page Kit target paths, replacing
CampaignSpec routes with source filenames

**Adapter Decision Contract**:
The machine-readable record of how prepared source HTML was adapted into Page Kit
shape. It includes wrapper stripping, frontmatter policy, asset strategy,
script/style references, CTA routing, layout choice, template slice copying, and
commerce shell adoption so doctor can validate assembly state without relying on
chat history.
_Avoid_: undocumented adapter prose, hidden source conversion choices

**Source Divergence**:
An intentional recorded difference between Design Source intent and the built
campaign, usually because CampaignSpec/API, Template Reference, or SDK runtime
contracts own the surface. Source Divergence prevents Build and Polish from
mistaking a platform-safe difference for an unresolved fidelity defect; entries
may be added during intake, Build, or Polish and carry the stage that recorded
or confirmed them, plus optional links to the Design Source, CampaignSpec,
Template Reference, or build fingerprint that makes the divergence valid. Polish
may propose a Source Divergence when the mismatch becomes visible during review,
but that proposal remains unaccepted until an operator/run decision or the
relevant Build or Design Source owner confirms it. Accepted gaps, divergences,
and waivers must be explicit and attributed; Polish must not silently waive
source fidelity.
_Avoid_: bug, warning, ignored source

**Surface Identity**:
The stable page, section, surface, and viewport naming used to join Design Source
Package records, built Page Kit output, Polish Evidence, and QA observations.
Surface Identity exists both as a campaign-level vocabulary and as contribution
mapping claims: contribution mappings say which source informs which pages,
sections, or surfaces, while the campaign-level identity lets Build, Polish, and
QA refer to the same surface. Surface Identity should preserve campaign/source
semantics while also mapping to the Campaign Page Kit output shape Campaigns OS
assembles toward: page-level Page Kit mapping is expected early, while section
and runtime-surface output mapping may mature during Build. Page-level identity
is established during source preparation; Build may refine child section or
runtime-surface identity under mapped pages, while Polish and QA attach evidence
or observations to known identities instead of inventing new pages. `campaign`
is a reserved Surface Identity with `kind: "campaign"` for campaign-level gaps,
TODOs, waivers, and readback references; it is not Page Kit output. Surface
Identity IDs are stable human-semantic strings with labels and aliases. Opaque
source, DOM, or Page Kit identifiers may be recorded as external references or
aliases, but they are not the primary campaign vocabulary. Page-level Surface
Identity is distinct from CampaignSpec or Map Builder page IDs, custom page
names, public routes, producer page types, and Campaign Page Kit runtime
`page_type`; those values should be preserved as mapped attributes or aliases.
When a CampaignSpec page ID is stable and human-readable it may seed the primary
page-level Surface Identity. Otherwise source preparation derives the primary ID
from normalized page role plus order, while preserving the original page ID,
label, route, and Page Kit projection separately. The package carries Surface
Identity as a structured catalog of identity records, not as a bare string list,
so each identity can preserve labels, aliases, and mappings to source, spec,
route, and Page Kit projection values.
_Avoid_: screenshot label, prose anchor, selector-only identity

**Telemetry Consent**:
The machine/user-level opt-OUT that decides whether Run Records are remitted.
Consent belongs to the operator, not the campaign: changeable any time
(`telemetry status|on|off`) and overridable by the `CAMPAIGNS_OS_TELEMETRY`
env var (unknown values fail closed). Consent gates **remit only** — capture
is always local. The default is ON for the canonical NEXT endpoint only,
announced at remit time with the endpoint and the opt-out command; any other
endpoint (staging, self-hosted) stays fail-closed until explicitly
consented, and a malformed config file resolves OFF rather than letting the
default override an unreadable prior choice.
_Avoid_: per-finding approval, campaign-scoped consent, SILENT default-on
(the default is announced, never quiet)

**Remit**:
The consent-gated send of a Run Record to NEXT, over the same rails as QA verdict
publishing. Remit is non-fatal (a failed send never blocks or fails a run) and
idempotent on `run_id` (the endpoint upserts, so reruns do not double-count); the
local Run Record records `remit_attempted` / `remit_ok` / `error` so a dropped
send is visible. With consent on, remit is automatic and unsurprising because the
consent was explicit and up front.
_Avoid_: per-item contribution, background retry daemon, fail-the-run-on-error

**Data Boundary**:
What a remitted Run Record carries versus withholds. Carried: run identity (Map
ID, slug, template family — the join keys that make telemetry useful), structural
signal (doctor codes, spec-rule IDs, adapter decisions, QA disposition, finding
IDs), and artifact references (path, schema_version, hash, material fingerprint
where available). Minimized or omitted: absolute local paths
(relativized/hashed) and OS username. Never carried: raw artifact bodies
(CampaignSpec JSON, source HTML, full verdict/doctor/report bodies). This is
data minimization, not a secret-defense allowlist — runs use a
synthetic test customer and a publishable client-side key.
_Avoid_: raw artifact upload, shipping local paths/usernames, secret allowlist framing

**Improvement Surface**:
The part of Campaigns OS a signal should improve: `skill`, `cli`, `template`,
`design-source`, `docs`, `spec-rule`, or `platform`. Recorded as a list
(`surfaces[]`) with an optional `primary_surface` and confidence, because one
observation often touches more than one surface. This is the grown-up form of a
finding's `suggested_owner`.
_Avoid_: single-owner enum, Linear label, routing decision

**Expected Proof Step**:
The next verification action Campaigns OS should make visible to the operator
after a lifecycle stage, such as polish after build, preview deploy before QA,
or browser QA after deploy evidence. An Expected Proof Step is guidance, not an
automatic execution grant.
_Avoid_: auto-run, hidden gate, silent proof

**Polish Stage**:
The constrained post-Build repair and evidence stage for SDK-safe presentation
surfaces. Polish may repair visual skinning, source-fidelity, responsive layout,
and residue defects, but it must not change CampaignSpec/API truth, SDK-owned
runtime behavior, route topology, template shell adoption, or source provenance.
Polish may draft or recommend a Checkpoint Waiver with supporting evidence, and
it may propose source-reference updates for source preparation to accept, but it
does not approve readiness exceptions itself.
_Avoid_: second build, QA, launch approval

**Polish Evidence Package**:
The detailed evidence artifact produced by the Polish Stage, containing
comparison references, screenshots, issues, commands, and source/template
findings for the current build. It owns built-output and comparison screenshots
for that build fingerprint while referencing source-side screenshots from the
Design Source Package and baseline references from Template Reference.
Polish Evidence is current only when it matches both the current build
fingerprint and the current Source Package Fingerprint, unless a waiver records
why stale evidence is acceptable.
Unresolved issues in the package must carry a Polish Issue Classification so the
next checkpoint can distinguish repair work, source limits, accepted divergence,
waiver candidates, and work outside Polish. It includes a Polish Stage Readback
for session pickup, and that readback must be
available through the Campaign Readiness Readback rather than hidden as a
disconnected artifact. The Assembly Report indexes and summarizes this package
for lifecycle gating, and QA consumes the package for freshness and linkage
rather than re-running the full design-fidelity comparison.
_Avoid_: QA verdict, screenshot dump, assembly report replacement

**Polish Issue Classification**:
The required category for any unresolved Polish finding: `repair_needed`,
`source_gap`, `source_divergence`, `waiver_recommended`, or `out_of_scope`.
Classification prevents unresolved presentation work from collapsing into a
vague issue bucket; it tells the next Readiness Checkpoint whether to repair,
carry a Source Gap, accept a Source Divergence, seek waiver approval, or route
the work outside Polish. `repair_needed` blocks deploy and QA until it is
repaired, reclassified, or covered by an approved Checkpoint Waiver. A
`source_divergence` classification from Polish is proposed until confirmed by an
operator/run decision or the relevant Build or Design Source owner; a newly
discovered `source_gap` from Polish is also proposed unless it traces to an
accepted Source Gap in the Design Source Package.
_Avoid_: unresolved bucket, generic polish issue, hidden next action

**Doctor Check Registry**:
The ordered Campaigns OS list of named doctor checks. The Doctor Check Registry
keeps check identity, execution order, and skip predicates explicit so agents add
or inspect doctor behavior by choosing a deterministic check slot instead of
re-reading a long validation chain.
_Avoid_: ad hoc doctor order, hidden validation side effect, LLM-chosen check path

**Completeness Signal**:
A Workflow Finding that notes an expected lifecycle step was not evidenced, such
as build/polish evidence existing without a QA Verdict. A Completeness Signal
does not by itself mean the build failed.
_Avoid_: defect, launch blocker, failed stage

## Example Dialogue

**Developer**: "The checkout worked because the CampaignSpec was accurate, but I
didn't realize I was supposed to run QA afterward."

**Domain Expert**: "Capture that as a Workflow Finding. The checkout behavior
belongs to the build and QA artifacts; the missing QA prompt is workflow
friction."

**Developer**: "Should the sidecar file create a Linear issue?"

**Domain Expert**: "No. The Findings Sidecar captures the local finding. Internal
ops can later aggregate and route it."

**Developer**: "This feedback is about the whole run, not one command."

**Domain Expert**: "Use Observation Stage `overall`. Most findings should name a
specific stage, but whole-workflow signals are allowed."

**Developer**: "Should I rewrite the findings file after I learn more?"

**Domain Expert**: "No. Add another entry to the Findings Journal. The journal is
append-only; later tooling can summarize it."

**Developer**: "Do I need Linear access to leave a finding?"

**Domain Expert**: "No. Finding Capture is local and public-package owned;
internal systems can ingest it later."

**Developer**: "Should this finding be an Assembly Report warning?"

**Domain Expert**: "Only if it is stage proof. Workflow observations belong in
the Learning Trail and can cross-reference formal artifacts."

**Developer**: "I only know the target repo and source type right now."

**Domain Expert**: "That's enough Campaign Run Identity for capture. Add more
context later if it becomes available."

**Developer**: "Brett reported the Spec-driven flow worked, but there is no
formal evidence packet."

**Domain Expert**: "Capture it with Evidence Quality `operator report`. Useful
human signal belongs in the Learning Trail."

**Developer**: "Can Campaigns OS ask for feedback after QA?"

**Domain Expert**: "Yes, as a Tiny Prompt. It should be one line and optional,
not another form to complete."

**Developer**: "Should skipping the prompt be recorded?"

**Domain Expert**: "No. Skipped Tiny Prompts are not Workflow Findings."

**Developer**: "How much classification do I need to do?"

**Domain Expert**: "Pick the closest Finding Kind and write a short summary.
The structure should prevent second-guessing, not create more of it."

**Developer**: "Can an agent add findings too?"

**Domain Expert**: "Yes, when it records observed workflow gaps. The Finding
Author should make clear whether the signal came from an operator, agent, or
system."

**Developer**: "Will agency users see this?"

**Domain Expert**: "Agency Campaigns OS Operators may see Tiny Prompts and
Workflow Findings. Shoppers and merchant-facing approval viewers should not."

**Developer**: "What made Brett's Vitae Charm run work?"

**Domain Expert**: "Spec-Driven Campaign Development. When the CampaignSpec was
accurate, the core checkout and upsell logic had rails."

**Developer**: "Will Campaigns OS send my run to NEXT automatically?"

**Domain Expert**: "Only if you've opted in. Run Telemetry asks once, up front,
and remits the Run Record when consent is on. Capture is always local; consent
gates remit only, and you can turn it off any time with `telemetry off`."

**Developer**: "Could it include my source HTML?"

**Domain Expert**: "No. The Data Boundary carries structured signal, identity,
and artifact references — never raw artifact bodies, and it scrubs local paths
and your username. The patterns are the value, not the raw dumps."

**Developer**: "Should QA just run after build?"

**Domain Expert**: "No. Campaigns OS should show QA as the Expected Proof Step.
Browser QA still needs the deployed URL (and SDK-origin allowlist confirmation
for non-localhost), but typed-card test orders have no approval gate — they use
global test cards that bypass the gateway; depth is the only control."

**Developer**: "Build and polish finished, but there is no QA verdict."

**Domain Expert**: "That is a Completeness Signal unless someone claimed launch
readiness. Record the missing proof without calling the build failed."
