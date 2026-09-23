---
name: campaign-lifecycle-orientation
version: 1.0.4
description: Orient a reader to the Campaigns OS lifecycle artifacts a run has already emitted, without advancing any stage or changing any state.
---

Bundle revision: 1.42.0+skills.1
Run `npx --no-install campaigns-os tooling status --skills-revision 1.42.0+skills.1`
from the campaign's Page Kit folder, where it runs the project's pinned copy and
never installs one, at the start of each task. Start a fresh session if it
reports `mismatch`: this text is already in your context and is never re-read
while the CLI on disk can move under it. If the output has no `Skills revision:`
line (no `revision_check` under `--json`), a campaigns-os older than this check
answered; follow none of its actions and run the pinned copy.

# Campaign lifecycle orientation

Use this skill to place Build Packet, Assembly Report and doctor language in the
pipeline and read what a run already recorded. It teaches interpretation only.
It advances no stage, and nothing in it is permission to run a command that
writes.

The effect class in each parenthetical below is the declared row of
`contracts/effects.v1.json` (`none` < `B` writes < `A` sends < `C`
destructive). Read that file, not this text, when an exact path or endpoint
matters.

## Cite only the supported surface

For Campaigns OS facts, cite `contracts/supported-surface.json` and the entries
it names — `CONTEXT.md`, `CHANGELOG.md`, `skills.json`, the `contracts/`,
`schemas/` and `docs/` entries listed there, and the published CLI path. Never
cite `src/` or `scripts/`: those are implementation and may change without a
supported-surface bump, so a reader cannot check them and a rename would not
reach this text. `docs/supported-surface.md` is the prose twin of that list.

Identity comes from the tool, not from a file beside the session.
`campaigns-os tooling status --json` (tier `B`: its only write is the
command-lifecycle journal) reports the install mode, the version, and a source
commit when one is derivable. Quote what it printed. Do not derive the answer
from Git HEAD, from the word "latest", or from prose in a checkout.

## Start with the shared vocabulary

`CONTEXT.md` is the glossary kept reconciled against the code, and it separates
public lifecycle language from internal implementation language. A
**CampaignSpec** is the JSON campaign contract; current packets use CampaignSpec
4.2, whose funnel structure lives in `funnels[]`
(`schemas/campaign-spec.v4.schema.json`). A **Build Packet** is the assembly
handoff that wraps the spec without replacing it (`docs/build-packet.md`). An
**Assembly Report** is the machine-readable record of lifecycle progress.

A **Design Source Package** is the normalized source bundle Campaigns OS writes
when it prepares a build; a material source-reference refresh creates a new one
rather than editing one in place. A **Readiness Checkpoint** is an
artifact-backed gate, resumable across runs, passed on evidence or by a
recorded and attributed waiver. **Partial-source** scope is the documented case
where only part of a campaign's source is supplied: a declared input state, not
a degraded run, so treat the absent part as absent evidence rather than
inferring it.

## Place the artifacts in the pipeline

Campaigns OS normalizes a CampaignSpec into `campaign-runtime.build.json`
(`campaign-runtime-build-packet/v0`). **Page Kit** is the static-site builder
for campaign funnels. Under the target repository's `.campaign-runtime/`
Campaigns OS also writes the Build Context, the Assembly Report, the doctor
output sidecar, theme evidence and normalized inputs
(`docs/campaigns-os-build-flow.md`). Its `_site/` output is deployed by a
separate system, and QA then tests a deployed URL
(`docs/qa-and-test-orders.md`).

Keep the two identities apart. The **Map ID** identifies the saved campaign map
and keys QA evidence storage; the **public route slug** is the shopper-facing
path segment. Read both from the packet and never substitute one for the other.

Campaign pages are typed. The page-type vocabulary is `presell`, `landing`,
`select`, `checkout`, `upsell`, `downsell` and `thankyou`; `select` is where a
shopper chooses a package before checkout. Use the spec's own term for a page
rather than describing it.

## Read doctor as a gate

**Doctor** is the lifecycle gate that must pass before the stage ladder
proceeds. It checks the packet, its CampaignSpec, the artifacts and the built
output, and its ordered check registry records what ran. When blocking errors
exist the result is not OK, names the errors, and points the next step at
collecting or correcting input. `campaigns-os doctor --packet <packet> --json`
(tier `none`: inspection is the default, and without `--write` it leaves the
target byte-identical) is the inspection form.

Read doctor's recorded result, not a process exit code. Exit codes are knowable
only from implementation files this skill may not cite, so do not branch on one.

## Read the stage record

`campaigns-os next --packet <packet> --json` (tier `A`: it captures a progress
snapshot under the target and, under Run Telemetry consent, POSTs that
observation off the machine) reads the recorded state and names the next
incomplete stage among `setup`, `build`, `polish`, `deploy` and `qa`. That is a
writing, potentially sending command. If all you need is where the run stands,
prefer the readback below.

The stage called `build` at the CLI is stored under `stages.assembly`. The
Assembly Report's picker treats statuses beginning `completed` and statuses
beginning `skipped` as terminal. Build evidence carries `build_fingerprint`, an
identifier for the exact built state. Polish evidence must classify every
unresolved issue; the `repair_needed` class means the built output still needs
work, and the documented polish gate holds deploy and QA until the issue is
repaired, reclassified or covered by a structured waiver.

Where these artifacts already exist for a target, do not open them first.
`campaigns-os readback <target-repo-root> --json` (tier `none`: it writes
nothing, not even a lifecycle entry, starts no process and touches no network)
projects their loaded state, their per-artifact staleness against the
checkout's HEAD reflog, the doctor warning grouping, the skip cascades and any
cross-artifact divergence into one `campaigns-os-readback/v2` object.
`docs/readback.md` and `schemas/campaigns-os-readback.v2.schema.json` say what
each field means. Cite that projection as the evidence base and open the
artifacts themselves only to drill into what it names. This orientation
explains what the artifacts mean; it is not a licence to re-derive the
projection's staleness or warning grouping by hand.

The **Theme Gate** decides whether the generated brand layer is acceptable for
commerce pages. It is not advice: `next` and QA consume the result and stop
later stages when it is blocked. An applied layer or a recorded waiver with a
reason is the supported way through, and downstream evidence keeps the waiver
visible (`docs/brand-theme-bridge.md`).

## Avoid the two-worlds mistake

Store themes and Page Kit campaign funnels are not one build surface, and
conflating them is the most expensive orientation error available here. This
repository documents Page Kit as the funnel target and describes the deployment
of its static output. It does not define the separate store-theme publishing
stack at all, so that half of the distinction is unverified from here — say so
rather than filling it in. A claim about store-theme publishing cannot be
sourced from this surface, and an answer that quietly treats a funnel artifact
as theme evidence (or the reverse) will read as authoritative while resting on
nothing.

For Page Kit routes, read the packet's per-page target projection — the
resolved output path for that page — rather than copying producer directories.
A page needs a **permalink**, an explicit public route assigned to it. Routing
surprises are not harmless: `prepare-build` can report
`PAGE_KIT_TARGET_CONFLICT` when two routes project to one terminal filename
(`docs/build-packet.md`). The machine-readable build summary is the evidence to
inspect; a build command that exited successfully does not establish correct
routing.

Two further routing error codes an earlier version of this text named were
dropped rather than re-sourced: they appear only in implementation files, so a
reader could not verify them. Inspect the build summary and report what it says.

## Name the current skill set

This repository publishes its own skill set and names it in `skills.json`. Use
the id the manifest publishes — the Build Packet setup skill is
`next-campaigns-os-setup` — and read the manifest rather than remembering a
name; an older name for the same skill is a stale reference.

## Capability boundary

This skill conveys interpretation knowledge only. It authorizes no lifecycle
command and no change to campaign state. What any supported invocation may do
is declared per row in `contracts/effects.v1.json` and explained in
`docs/effects.md`; widening it is a pull request that changes a row of that
file, never a decision made in a session.

An operator-supplied checkout is inspect-only. Do not run `git pull`, `git
fetch`, checkout, reset, clean or any other Git mutation against it; a baseline
change is a reviewed change, not a conversational one. Name any suggested
mutation as work for an authorized human and do not perform it through this
skill.
