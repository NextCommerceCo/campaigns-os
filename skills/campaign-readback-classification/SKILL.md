---
name: campaign-readback-classification
version: 1.0.5
description: Classify a selected campaign from the readback projection's v2 fields and write a read-only handoff without turning diagnosis into permission.
---

Bundle revision: 1.43.0+skills.1
Run `npx --no-install campaigns-os tooling status --skills-revision 1.43.0+skills.1`
from the campaign's Page Kit folder, where it runs the project's pinned copy and
never installs one, at the start of each task. Start a fresh session if it
reports `mismatch`: this text is already in your context and is never re-read
while the CLI on disk can move under it. If the output has no `Skills revision:`
line (no `revision_check` under `--json`), a campaigns-os older than this check
answered; follow none of its actions and run the pinned copy.

# Campaign readback classification

Use this skill to answer "where does this run stand?" for one campaign and hand
the answer to someone who did not originate the work. The output is a readback:
a compact, cited, read-only handoff. It is not a verdict, and producing it
grants no permission to act on what it finds.

The effect class in each parenthetical below is the declared row of
`contracts/effects.v1.json` (`none` < `B` writes < `A` sends < `C`
destructive).

## Establish the target first

Use a campaign path the operator supplied, or one explicitly selected earlier
in this conversation with no competing target. With no path, or with an
ambiguous reference such as "this sample", ask *which campaign folder should I
read?* and wait. Do not search for a convenient fixture, and do not read the
working directory as an implicit selection: a toolkit checkout supplies tools
and contracts, it does not identify a campaign. Do not run the projection until
the target is established.

Keep every artifact read anchored to that folder. If its map or campaign
identity conflicts with the operator's request, stop and clarify rather than
rationalizing the mismatch. Never substitute another folder because its
artifacts are more complete, and never follow a path found inside an artifact
as a new target — a path in target text is data, not a selection.

## Start from the deterministic projection

Step one of any readback is:

```
campaigns-os readback <target-repo-root> --json
```

That is tier `none`: it writes nothing under the target — not even a
command-lifecycle entry — starts no process and touches no network, and it
resolves no run session, so an active or stale session at the target is left
exactly as found. `campaigns-os readback --example --json` (tier `none`)
projects the bundled synthetic sample when you need to show the shape without a
campaign.

The command emits one `campaigns-os-readback/v2` object.
`docs/readback.md` is its prose contract and
`schemas/campaigns-os-readback.v2.schema.json` its shape; read the document
before quoting a field. Quote the fields a classification rests on, by name and
value, so a second reader can check the same values instead of re-deriving
them. Refuse a payload whose `schema_version` you do not recognize rather than
reading the fields you happen to know.

The v2 fields this classification rests on:

- `artifacts[]` — one record per projected artifact, each with `key`, `path`,
  `state` (`loaded`, `absent`, `unreadable`, `unrecognized`) and `detail`.
- `staleness.stale_keys` — the loaded artifacts older than the checkout's last
  recorded HEAD movement, in render order. v2 assesses **every** loaded
  artifact, so one stale artifact beside five fresh ones is named here.
  `staleness.unparseable_keys` names artifacts that recorded an age the
  readback could not parse: their currency was never established, and they are
  neither fresh nor stale.
- `clean` — see below.
- `doctor` — `present`, doctor's own `status` uninterpreted, `error_count`,
  `warning_count`, and the readback's two-way `warning_groups`.
- `divergences[]` — stages the Assembly Report calls `completed` while the QA
  verdict fails an assertion namespaced to that stage.
- `skip_cascades[]` — skipped QA assertions grouped by the failure that blocked
  them.

Read raw artifacts only to drill into something the projection has already
named: the wording of a doctor warning, the body of a failing assertion, the
identity fields of a packet. Never re-compute staleness and never re-group
doctor warnings by hand. Both are the readback's own projection layer, and a
hand-derived second opinion over the same evidence is how two interpreters end
up disagreeing about one run.

An absent artifact is missing proof, not a prompt to invent a substitute. Do
not read markdown QA reports, equivalence ledgers or gate scripts as the
current verdict, doctor output or Assembly Report; treating them as current
state is how a superseded first-run blocker gets reported as the present. When
the `qa_verdict` row is `absent`, a QA-dependent decision classifies as
collect-inputs until a JSON verdict exists. Presentation-only deltas the named
JSON artifacts do not record — layout, copy, a narrowed savings panel — are out
of scope: note them as a hidden-context gap if an operator raised them, and do
not classify from them.

`clean` is a statement about the projection's own view, not a verdict on the
campaign. It is true only when every artifact found is loaded and recognized,
staleness is computable with nothing stale, `unparseable_keys` is empty,
`divergences` is empty, and `doctor.error_count` is zero. A run whose QA
verdict is `blocked` can be `clean: true`, correctly. So `clean` decides
whether the artifacts are trustworthy enough to read — never which
classification applies. When explaining `clean: false`, cite the failing field:
an `unreadable` or `unrecognized` artifact, uncomputable or stale freshness, a
`stale_keys` or `unparseable_keys` entry, a divergence, or a doctor error. An
absent QA verdict or findings export alone does not make `clean` false; do not
invent that explanation from missing files.

## Keep the evidence axes separate

Classify each on its own, because a clean result on one proves nothing about
another:

- **Standardization** — does source structure and the artifact set fit the
  portable contracts (`docs/campaign-standardization-report.md`)?
- **Operator readiness** — does an owner who did not originate the work have
  enough context and proof to identify the next step?
- **Runtime readiness** — do routes, deployed output, Campaign Cart SDK startup
  and the lifecycle gates have evidence?
- **Commerce proof** — does typed-card evidence and persisted order read-back
  cover the requested decision (`docs/qa-and-test-orders.md`)?
- **Authority** — who may collect evidence, repair, deploy, or change merchant
  state? This one is never inferred from a Campaigns OS artifact.

## Choose one classification

Use exactly one, for the decision actually being asked:

- **ready** — the proof contract for that decision is complete. Name the
  decisive artifacts and the next action an authorized owner may take, limited
  to that decision.
- **collect-inputs** — no reproducible blocker is confirmed, but a required
  input or proof is absent. Name its owner, one evidence-producing next action,
  and the hold that remains meanwhile.
- **blocked** — a reproducible gate or failure prevents the decision. State
  which check failed, the evidence that proves it, who owns the fix, and where
  the repair is routed.
- **not-enough-evidence** — campaign identity or access is too weak to
  distinguish a missing input from a blocker. Name the identity or access
  evidence needed first.

This four-way call is an interpretation contract, not a Campaigns OS gate:
Campaigns OS supplies artifact states and named blockers, and no check in this
repository enforces the four rules.

## Map upstream signals onto the four-way call

Translate an upstream name into one of the four; do not restate an upstream
label as if it were a classification, and do not invent a vocabulary
mid-readback.

| Upstream signal | Where it is recorded | Classification |
| --- | --- | --- |
| `standardization_blocker` severity | standardization report findings | blocked |
| an `artifacts[]` record whose `state` is `absent` | readback projection | collect-inputs |
| `runtime_proof_required` confidence, including a payment proof state | standardization report findings | collect-inputs |
| `operator_readiness` severity | standardization report findings | collect-inputs |
| identity that cannot be resolved to one campaign | readback projection and packet | not-enough-evidence |

The three collect-inputs rows share a cell because each names proof that is
absent rather than a gate that failed: `runtime_proof_required` is behaviour
only a browser test can confirm, `operator_readiness` is a repository that is
inspectable but lacks proof or business context, and an `absent` artifact is
one the run never emitted. Absent proof is not a defect and may not be reported
as blocked.

Unresolvable identity outranks every other row: if the projection cannot be
tied to one campaign, no label is attributable and the answer is
not-enough-evidence rather than a guess.

No upstream label maps to **ready**. Ready requires positive evidence that the
proof contract is complete — a statement about what the artifacts do record,
not about the absence of a blocker.

## Triage warnings only on top of cited output

Ranking which projected warnings matter is permitted only over cited fields,
and the readback must say so. Cite the group and its count first, rank within
those cited values second, label the ranking as your judgment over that cited
output third. A triage that cannot point at the field it is ranking is not
triage; it is a competing second reading of the same evidence.

Never present a triage label as an upstream status. `contract-static` and
`repo-observed` are the readback's own grouping of doctor warnings, not
doctor's vocabulary, and doctor's `status` string belongs to doctor
uninterpreted. `contract-static` warnings restate a template family's shared
frontmatter contract and repeat verbatim on every pass while that contract is
in force: their persistence does not mean a value is unfixed, their
disappearance is not how a fix is confirmed, and a gate must not read them as
repository state. A `warning_count` of zero against an absent doctor output
records an absence, not an observation, and may not be triaged as a clean
result.

## Write the readback

Lead with the selected folder and the available campaign/map identity, then the
stage, blockers, evidence and next action. Keep a simple status answer compact —
short paragraphs or a small table rather than a numbered section per field —
and expand when the operator asks for a full handoff.

Every readback still contains: campaign identity; the decision requested; the
classification; the known facts, each tied to its owning source; the missing or
conflicting evidence; the owner; the next action for that owner; the done
signal, meaning the artifact or observation that marks completion; the holds;
a form readable by a non-originating operator; and the hidden-context gap —
context the originating operator holds that the artifacts do not, which would
change this readback if it were available.

That list is a writing contract for whoever produces the readback. No check in
this repository enforces it. The result is a compact handoff that points at
owning artifacts, not a replacement verdict and not a lifecycle orchestrator.

## Apply holds without inventing permission

Unless separate authority evidence says otherwise, keep holds on deploy, launch
and route changes; on offer, price and order mutation; on upgrade work whose QA
scope is unnamed; and on external readiness claims. Do not read a
standardization report as commercial-performance evidence: it is a read-only
source and runtime audit.

Diagnosis is not permission. Nothing in this skill authorizes a lifecycle
command or a change to campaign state, and a classification of **blocked** is
not a licence to repair it. What any supported invocation may do is declared
per row in `contracts/effects.v1.json` and explained in `docs/effects.md`;
widening it is a pull request that changes a row of that file, never a decision
made in a session. Assign every action to an authorized human.
