# Campaigns OS Context

Campaigns OS coordinates campaign build, proof, and learning work around a
CampaignSpec-driven workflow. This glossary keeps the public workflow language
separate from internal orchestration, QA defects, and implementation artifacts.

## Language

**Workflow Finding**:
A human- or agent-observed gap, friction, or positive signal about the Campaigns
OS workflow itself. A Workflow Finding may cite a Build Packet, Assembly Report,
doctor output, or QA Verdict as evidence, but it does not replace those artifacts.
_Avoid_: QA defect, bug report, friction log

**Findings Sidecar**:
The public Campaigns OS capture surface for Workflow Findings. It records local
workflow evidence for later aggregation; it is not the owner of Linear routing,
team assignment, or internal prioritization.
_Avoid_: Linear sync, feedback dashboard, QA reporter

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
The sidecar record of workflow signals that helps Campaigns OS improve over
time. The Learning Trail is separate from the formal proof trail recorded in the
Assembly Report, doctor output, and QA Verdict.
_Avoid_: launch evidence, stage proof, assembly status

**Campaign Run Identity**:
The best-effort context that ties a Workflow Finding to a campaign run, such as
Map ID, campaign slug, target repo, packet path, Assembly Report path, QA run ID,
source type, or template family. Campaign Run Identity may be incomplete; missing
identity should not prevent capture.
_Avoid_: required metadata, primary key, campaign record

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

**Finding Contribution**:
An explicit Campaigns OS Operator action that shares selected local Workflow
Findings beyond the current campaign workspace. A Finding Contribution is not
background telemetry and should not surprise the operator.
_Avoid_: phone-home, automatic upload, hidden telemetry

**Contribution Boundary**:
The default privacy boundary for a Finding Contribution: share Workflow Finding
summaries, classifications, commands, paths, hashes, and run IDs first; share
artifact contents only when the Campaigns OS Operator explicitly attaches them.
_Avoid_: raw artifact upload by default, implicit evidence sync

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

**Developer**: "Will Campaigns OS send findings to NEXT automatically?"

**Domain Expert**: "No. A Finding Contribution is explicit. The local sidecar
can capture first, and the operator chooses what to share."

**Developer**: "Should the contribution include my source HTML?"

**Domain Expert**: "Not by default. The Contribution Boundary shares references
and summaries first; artifact contents require explicit attachment."

**Developer**: "Should QA just run after build?"

**Domain Expert**: "No. Campaigns OS should show QA as the Expected Proof Step,
but browser QA and test orders still need the right URL and policy gates."

**Developer**: "Build and polish finished, but there is no QA verdict."

**Domain Expert**: "That is a Completeness Signal unless someone claimed launch
readiness. Record the missing proof without calling the build failed."
