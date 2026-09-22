---
name: contribution-intake
version: 1.0.0
description: Turn a suggestion about the agent surface into a classified, evidence-checked proposal and, only with attended approval, one issue on this repository's tracker.
---

Bundle revision: 1.40.0+skills.2
Run `campaigns-os tooling status --skills-revision 1.40.0+skills.2` at the start of each
task and start a fresh session if it reports `mismatch`, because this text is
already in your context and is never re-read while the CLI on disk can move
under it.

# Contribution intake

When someone says the agent surface should change — a complaint, a wish, a "why
doesn't it" — fill in the template below instead of live-coding a response or
promising behaviour. Campaign work is not an intake trigger; it follows the
lifecycle skills.

Two classes end the filing path before the template is finished:

- **Lifecycle, stage readiness or verdict authority.** That belongs to
  Campaigns OS itself. Say where it goes and why this intake cannot own it.
- **A capability change.** Anything that would broaden what an invocation
  reads, writes, sends, or can do to merchant state is a change to a row of
  `contracts/effects.v1.json`, and a row is not publishable without its effect
  test (`docs/effects.md`). Say so plainly, record it as a capability change,
  and stop. It lands as a reviewed pull request, never as a session decision
  and never as an issue that implies one.

A suggestion that is really a one-off preference is situational judgment:
acknowledge it and file nothing.

## The proposal template

1. **Observation** — the task attempted, the behaviour observed, the behaviour
   expected. Keep this separate from any proposed fix; record both, conflate
   neither.
2. **Version in hand** — what `campaigns-os tooling status --json` (tier `B`:
   its only write is the command-lifecycle journal) reported, and the bundle
   revision on the first body line of the skill you loaded.
3. **Class** — exactly one: defect, missing explanation, workflow friction,
   lifecycle (route away), capability change (stop), situational judgment.
4. **Duplicate search** — what you searched and what you found, including a
   null result.
5. **Evidence** — the smallest reproduction there is, redacted per the
   paragraph below. An absent reproduction is stated as absent, not implied.
6. **Smallest test that would show it fixed.**
7. **Non-goals** — what this proposal is explicitly not asking for.
8. **Authority implications** — name them even when they are "none".

## Redaction is the control

This is the one part of the template that is not negotiable, because the filing
is public and a filed issue cannot be unpublished. Before anything is rendered
for approval, scrub the whole proposal: no merchant or store names, no customer
or order data, no card numbers, no credentials or credential-shaped values, no
machine-local or home-directory paths, no internal tracker ids, no private
repository or endpoint names, no operator-local source identities. Replace each
with a synthetic stand-in and say that you did.

The bar is the same as for committed text in this repository, which is enforced
by `npm run check:private-strings`. If you cannot redact an example and keep it
meaningful, file the proposal without that example and name the gap.

## Preview, then hand back the keyboard

Render the exact title and body, then ask for one of `discard`, `revise` or
`file`. Nothing is sent until they say `file`. A revision re-renders the
preview and resets approval. On `file`, use the harness's own connector for the
tracker, under the attended person's identity and permissions and never any
other credential: preview first, one operation, then read the result back and
compare it against the approved preview before reporting the URL. One approved
preview produces at most one issue; on an error, report it and ask before any
retry. If they cannot file on this repository, hand them the finished draft to
paste and record it as draft-only.

## After filing, stop

The issue enters maintainer triage. Do not apply labels, do not start a branch,
do not sketch the fix, and do not treat the filed issue as permission to
implement it.
