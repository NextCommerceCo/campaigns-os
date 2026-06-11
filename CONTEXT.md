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
sha256}`), normalized observation arrays (doctor codes, spec-rule fires, adapter
decisions, QA disposition), and a snapshot of this run's Workflow Findings. It
references the proof trail; it does not re-embed or replace it.
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

**Source HTML Intake**:
The Campaigns OS step that normalizes prepared source HTML into a Build Packet
mapping. Source HTML Intake keeps producer paths, CampaignSpec pages, and Page
Kit target shape distinct: `source_html.pages[].path` records source provenance,
while `source_html.pages[].page_kit` records the target page file, route, CPK
`page_type`, and frontmatter projection. CampaignSpec `page_url` and legacy
`url` values are interpreted as Page Kit public routes during projection, not as
source filenames or opaque preview URLs.
_Avoid_: copying manifest paths directly into Page Kit target paths, replacing
CampaignSpec routes with source filenames

**Adapter Decision Contract**:
The machine-readable record of how prepared source HTML was adapted into Page Kit
shape. It includes wrapper stripping, frontmatter policy, asset strategy,
script/style references, CTA routing, layout choice, template slice copying, and
commerce shell adoption so doctor can validate assembly state without relying on
chat history.
_Avoid_: undocumented adapter prose, hidden source conversion choices

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
IDs), and artifact references (path, schema_version, hash). Minimized or omitted:
absolute local paths (relativized/hashed) and OS username. Never carried: raw
artifact bodies (CampaignSpec JSON, source HTML, full verdict/doctor/report
bodies). This is data minimization, not a secret-defense allowlist — runs use a
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
