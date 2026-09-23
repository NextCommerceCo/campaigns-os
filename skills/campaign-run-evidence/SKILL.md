---
name: campaign-run-evidence
version: 1.0.3
description: Interpret existing Campaigns OS doctor, QA and proof-depth evidence without claiming more proof than the artifacts contain.
---

Bundle revision: 1.41.2+skills.1
Run `npx --no-install campaigns-os tooling status --skills-revision 1.41.2+skills.1`
from the campaign's Page Kit folder, where it runs the project's pinned copy and
never installs one, at the start of each task. Start a fresh session if it
reports `mismatch`: this text is already in your context and is never re-read
while the CLI on disk can move under it. If the output has no `Skills revision:`
line (no `revision_check` under `--json`), a campaigns-os older than this check
answered; follow none of its actions and run the pinned copy.

# Campaign run evidence

Use this skill when the question is "is this enough evidence?" — reading a
doctor result, a QA verdict, or the proof depth a run actually reached. It
interprets artifacts that already exist. It does not produce evidence, and
nothing in it authorizes a command that would.

The effect class in each parenthetical below is the declared row of
`contracts/effects.v1.json` (`none` < `B` writes < `A` sends < `C`
destructive).

## Count artifacts, not impressions

A **proof contract** is the specific evidence a decision requires. A run passes
one only when Campaigns OS has written machine-readable evidence saying so: an
OK doctor result, and a QA verdict whose `disposition` is not `blocked`.
Visual confidence substitutes for neither. Doctor and QA remain the
authorities for those decisions (`docs/qa-and-test-orders.md`).

Read what is already recorded before producing anything.
`campaigns-os readback <target-repo-root> --json` (tier `none`: writes nothing,
starts no process, touches no network) projects the artifact set and its
freshness; `campaigns-os doctor --packet <packet> --json` (tier `none`:
inspection is the default and leaves the target byte-identical) re-reads a
packet without recording anything.

## Read evidence depth in order

Evidence gets stronger as the runner moves from deployed HTTP and metadata
assertions, to rendered-browser structure checks, to the Campaign Cart SDK
debugger overlay, and finally to a payment order driven end to end by browser
automation. **Typed-card** means the runner enters a platform test card in the
hosted payment fields; read `docs/qa-and-test-orders.md` for the platform-owned
card data rather than copying card numbers into a handoff.

The `proof_policy` setting defines the required browser and typed-card depth.
It appears in the Build Packet as `qa.proof_policy` and on the Assembly Report
as `proof_policy`, and the `--test-order` mode selects the recorded order-path
sample. Report those choices; do not renegotiate them in conversation.

Depth is a property of the run that happened, not of the policy that was asked
for. A packet demanding typed-card depth whose verdict records no order proves
nothing about ordering — it records a policy and an unmet one.

## Interpret the verdict exactly

Only a JSON QA verdict is a verdict. The runner writes its full verdict and
attempts to publish it to the QA portal; a publication failure does not erase
the local one. The readback projects `.campaign-runtime/qa-verdict.json` when
that sidecar has been copied into the campaign repository. A markdown QA
report, a ledger or a gate script is not a verdict and must not be scanned for
a disposition, a run id or a blocker. Where two JSON verdicts exist, interpret
the one the projection loaded; do not walk a report looking for a later rerun.

`disposition` takes one of three values — `ready`, `ready_with_exceptions` or
`blocked` — derived from assertion status and severity: a failed blocker
produces `blocked`; warnings, manual review and warning-severity failures
produce `ready_with_exceptions`; otherwise it is `ready`.

Two statements an earlier version of this text carried were removed rather than
re-sourced, and the removal is the point: the derivation function's name and
the exit code `blocked` maps to are knowable only from implementation files
this skill may not cite. Read the disposition itself.

Silence is not success. A **template-family contract** declares the browser
structure expected from a family of campaign templates; where it declares no
machine-checkable structure, the corresponding assertion is `manual_review`,
not `pass`. `ready_with_exceptions` likewise identifies evidence that still
needs reading — it is not an approval label.

## Separate commerce proof from weaker signals

For a committed cart and an accepted upsell, persisted order read-back is the
authoritative evidence. Client-side cart state is not a stable proof contract,
and rendered selection state proves selection rather than commitment. The
documented QA contract rejects reliance on the unstable `cartLines` field and
directs the harness to receipt line items or the documented event and DOM
signals. **Commercial-parity** QA is the documented check that a campaign's
commerce behaviour matches the platform's own, read from that contract rather
than inferred from a run.

An offline build cannot prove commerce behaviour. The Campaign Cart SDK, remote
assets, a deployed preview, the browser runtime and a typed-card order all
require outbound network access. Air-gapped evidence is limited to markup,
build and stylesheet validation and must not be reported as commerce QA.

A `ready` verdict proves the tested funnel contract, not the merchant's full
production readiness. Live payment methods, production URLs, supported markets,
legal and support details, analytics expectations and merchant configuration
belong to a separate launch-readiness question outside this skill's scope
(`docs/campaigns-os-build-flow.md`).

## Read repair evidence conservatively

A blocked verdict should lead an authorized owner through a bounded repair
cycle: classify the evidence gap, make one scoped attempt, rerun the owning
check, compare the new artifact, and stop for handoff when another attempt
makes no progress. This skill observes the resulting artifacts; it neither runs
repairs nor teaches a repair command surface.

Be precise about what the toolkit enforces. It records repeated lifecycle
commands and carries blockers, warnings and evidence on stage artifacts
(`docs/workflow-findings-sidecar.md`,
`schemas/campaigns-os-run-record.v0.schema.json`). It defines no append-only
attempt ledger and no no-progress stopping rule, so state those two as human
handoff discipline rather than as a platform guarantee.

## Handle a root 404 precisely

A campaign root can legitimately return HTTP 404 when the funnel begins on a
deeper route. Accept that only when entry-URL resolution names at least one
entry and the verdict shows a pass on the `http:<page_id>` check for one of
those entries. The resolver and the HTTP assertion decide this, not the root
response alone.

## Capability boundary

This skill conveys interpretation knowledge only. It authorizes no lifecycle
command and no change to campaign state. In particular `campaigns-os qa run`
(tier `C`: it overwrites the stored verdict and can POST it off the machine)
and `campaigns-os checkpoint waive` (tier `C`: it records a waiver over a
blocking gate) are work for an authorized human, and urgency does not widen
that. What any supported invocation may do is declared per row in
`contracts/effects.v1.json` and explained in `docs/effects.md`; widening it is
a pull request that changes a row of that file, never a session decision.
