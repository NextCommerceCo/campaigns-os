# Activation, access, and evidence

Start a real campaign with a Campaigns App configuration, a saved Campaign Map
or local CampaignSpec export, a Page Kit project, and prepared source pages.
Run `start`, then follow `next` and its named owner, inputs, and gates. These
commands use the existing Build Packet and Assembly Report lifecycle; the
milestones below describe evidence, not a second state machine.

| Milestone | What it establishes | What is still needed |
|---|---|---|
| Toolkit installed | The selected package can run and its agent skills can be checked with `tooling status`. | Campaign inputs and workflow evidence. Installation needs npm access; it does not grant store, Map, deploy, or QA access. |
| Demo preview | Pinned sample pages can be opened locally for a visual walkthrough; candidate 1.37.0 provides `demo --target <new-directory>`. | A separate real campaign folder, configuration, replaced demo values, and the ordinary build and proof gates. Demo behavior is not live commerce proof. |
| Map saved | Campaign Map Builder has retained the authored campaign plan. A local export is an alternative build input. | Export/revision agreement and resolution of live campaign data. Saving a Map does not establish Campaigns App or store access. |
| Campaign resolved | The package-owned resolver has read the campaign's live configuration and produced resolution evidence. | Build, preview, and runtime proof. Confirm Campaigns App keys and allowed domains; store Admin API reads need their own read token. |
| Preview observed | A browser has inspected the served current build at the tested URL. | Retained package-owned Polish capture and QA evidence tied to that build. A deployed URL alone is not an observation. |
| QA recorded | The package-owned verdict records the tested URL, build, checks, and exercised order-path depth. | Any recorded blockers, waived exceptions, publication recovery, and run closeout. A verdict's presence does not imply a pass or launch approval. |

Access is supplied by the operator or the named workflow owner. When an input
is missing, keep the stage blocked and collect that input; do not substitute a
demo value or infer access from an earlier milestone. `doctor` inspects local
evidence without writing by default. `tooling diagnose --packet <packet>`
exports only a small, redacted support summary; normal `doctor` and `next`
remain the detailed local recovery instructions.

Trust, freshness, and revision agreement are independent of these milestones.
Orient on declarative Git objects at one reviewed commit before executing the
toolkit. An exact installed version and lockfile identify the runtime; they do
not establish that it is the newest release or trusted. A saved Map, exported
spec, assembled build, and retained verdict can each refer to a different
revision. Reconcile them through the existing producer and freshness gates,
never by treating a later milestone as proof that earlier evidence is current.

If QA has finished testing but verdict publication failed, use `qa publish`
on the existing verdict as the local recovery instructions direct. Publication
recovery sends retained evidence; it must not rerun checkout or create another
test order. A diagnostic inspection performs no installation, write, publish,
deploy, browser run, or order placement.
