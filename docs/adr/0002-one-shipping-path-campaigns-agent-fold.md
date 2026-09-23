# ADR 0002: One shipping path: fold Campaigns Agent into Campaigns OS

- Status: Accepted
- Date: 2026-09-22

## Context

Campaigns Agent has been a separate product with its own repository, its own launcher and its own session-binding machinery. Its one durable asset is the set of skills and the charter that make an agent trustworthy about campaign state.

Campaigns OS is already public, already on npm, and already ships skills and per-harness entry files.

Campaigns Agent's earlier records assumed a launcher. ADR 0002 of that repository bound each session to one verified Campaigns OS generation, and the mechanical per-command controls of its outer runner — a fixed argv and flag allowlist, forced `--no-write` on inspection commands, a two-variable child environment, a journal destination the caller could not choose, refusal of ambient sessions — were enforced by that runner. Once there is no launcher, quarantine and binding logic have no referent and each of those controls needs somewhere else to live or an honest statement that it is gone.

The postures that cannot be served locally at all are a separate matter. Unattended or hosted use by a bot with its own terminal, and clients whose users will not run a CLI, cannot be trusted to self-limit on the developer's machine; there the enforcement must sit on the other side of the network. That is the hosted gateway track, a sibling decision with its own review ledger.

## Decision

Campaigns Agent stops being a separate product. The skills and the charter move into Campaigns OS, and Campaigns OS gains an agent surface that is always shipped and optionally activated. The surface is only files, so it is always in the tarball, and it is activated by subcommands; a developer who never runs them has exactly the CLI they have today. There is no mode flag, no second package and no optional dependency.

"Campaigns Agent" survives as the name of the agent surface: Campaigns Agent is what makes your agent a Campaigns agent. It is not an agent.

### The kernel/agent boundary

The kernel (`src/`) decides campaign truth: lifecycle order, doctor, verdicts, Run Records, contracts. The agent surface decides two things only: how an agent should behave around that truth, which is the skills and the charter, and where its files land in a given harness, which is the adapters. If a piece of code decides campaign truth it is kernel; if it decides agent behaviour or file placement it is the agent surface. Effect declarations are kernel, because they describe what the kernel does for any caller. `src/agent/` may import only the exported command functions the CLI itself dispatches to, never kernel internals, and one import-boundary test enforces this. A tool face, if it is ever built, spawns the CLI rather than calling handlers, because a direct handler import can skip behaviour the CLI wrapper adds: lifecycle capture, stale-session closeout and journal persistence.

### Layout

After the fold the repository holds `src/agent/` for the installer, the per-harness adapters and a tool face if one is built; `contracts/effects.v1.json` on the supported surface; `skills/` holding the kernel's five lifecycle skills plus four re-authored skills, with `skills.json` gaining a `bundle_revision`; `agents/` holding the generated adapters, committed, classified as agent-relevant and declared on the supported surface in the first pull request that introduces agent files; the charter merged into `AGENTS.md`; `docs/harness-matrix.md` recording what each harness consumes with a verified-on date per cell; and this record under `docs/adr/`.

### New subcommands

`campaigns-os readback <target> [--json] [--packet <path>] [--example]` is unconditional: it is the port of the Python artifact readback into the kernel, with its known freshness defect fixed and its output contract versioned, and `--example` runs it over a bundled, clearly synthetic evidence-bearing sample.

`campaigns-os agent install [--platform <p>|all] [--project] [--dry-run] [--remove]` is unconditional: it writes the generated adapters into each detected harness's documented primary skill directory once, never into every compatible directory, registers a tool face where one is configured, and prints exactly what it wrote. `--project` writes the charter as an owned section of a campaign repository's instruction file.

`install-skills` becomes an alias of `agent install --skills-only` and keeps its existing `--target`, `--platform agents`, default-platform and `--dry-run` behaviour under compatibility tests.

`campaigns-os login` is the credential flow the gateway track builds; this decision consumes it. `campaigns-os agent mcp` is conditional, on the terms below.

### The capability boundary

For an attended developer working in their own harness on their own machine and checkout, the capability boundary is delegated developer authority over a documented surface whose declarations are honest, gated by the harness's permission rules and the developer's own account. This is how published agentic tools work: the provider declares, the harness gates, the developer's account scopes what the tool may reach, and a human can deny any call. The mechanical per-command limits the old outer runner enforced become developer or harness authorization plus guidance. The one posture that loses a mechanical control is an agent in a shell-capable harness whose permission mode does not prompt, and that posture is the developer's own choice for every tool on their machine.

### Declared effects are the contract

`contracts/effects.v1.json` states, for every command and effect-changing flag, its MCP tool-annotation values (`readOnlyHint`, `destructiveHint`, `openWorldHint`), the tier it maps to (none, A, B, C), what it writes and where, and what it sends and to whom. Every row is proved by an effect test: the command is run in a disposable target under no session, an ambient session, a stale session and with the lifecycle-journal variable set, and the declared file and network effects, and nothing else, are asserted. A row without its test is not published. The tool face's annotations, the CLI help, the skills' descriptions of the commands they use and the per-harness permission guidance are generated from the file. On the CLI path nothing consumes the file at permission time; the gate is the permission rules a developer installs, so permission coverage is published as manual per-harness guidance, not automatic gating. A false read-only declaration is the worst failure a provider can ship, because harnesses relax their prompting for tools a trusted server declares read-only.

The kernel as it stands does not yet satisfy that promise. Today `--no-write` does not cover the lifecycle journal (campaigns-os issue #459) and a refused or unknown command still writes a journal entry. Both are violations of the declaration promise rather than of a read-only CLI, and both are fixed before the corresponding rows are published; until then no command is declared read-only. A refused or unknown command is a row too. The kernel's own guards are stated accurately in the declarations rather than substituted for them: a checkpoint or theme waiver requires a named person and refuses placeholders, which is attribution and not proof of approval; typed-card QA has no approval step and coverage is its only control, so `qa run` is declared destructive and open-world; Run Record remit is declared open-world with its destination named on every remitting command; browser egress is declared open-world with its own scope.

### The tool face

The tool face is built only on evidence: the trial's fourth decision row, which is a reproducible tool-discovery or invocation limitation that remains in the participant's harness after using the documented CLI path, or a named user with a demonstrated no-shell need. If it is built, `agent mcp` is a stdio MCP server in which every tool spawns the kernel CLI and returns its JSON, carrying the command's declared effect class as annotations. It holds no logic of its own. There is no `--mode` flag and no server-side allowlist, because a server that hides tools instead of declaring them is one a harness cannot reason about. Commands whose exact operation needs a human to see the payload before it goes — `qa run` with test orders, waivers, `qa publish`, `spec derive --from-store` — are exposed only once a per-harness preview-and-approve contract for that operation exists; until then they are commands a developer types. A caller cannot pass `--proxy-base`, a consent override or a journal destination through a tool. Every exposed tool has its effect test.

### The mode gate

The mode gate — a project-declared observe-or-attended posture enforced as an argv allowlist in the dispatcher — is deferred, not rejected. It is built only if a project owner asks for it, and then with preconditions: the effective mode is resolved before stale-session closeout, lifecycle capture and dispatch; there is an ungated path with a documented return to it; project and environment precedence is defined and the effective mode is reported; and CLI permission stays distinct from tool-face exposure if their sets differ. Until then `effects.v1.json` is the seed such a gate would read.

### Capability promotion

Capability promotion is a pull request that changes a row of `effects.v1.json`, and the effect test and the change-policy classification fail when someone does it silently. This carries forward Campaigns Agent ADR 0003.

### Where the old controls live now

Command and flag allowlists are the rows of `effects.v1.json`, on which a harness's permission rules act. Forced `--no-write` on inspection commands becomes declared read-only rows, each proved by an effect test. The two-variable child environment is gone: the kernel refuses tokens on the command line and reads them only from a named variable, and `login` removes the token from the developer's hands. The journal destination is fixed in the tool definition if a tool face exists, and otherwise is the developer's choice, declared on the row. Refusal of ambient sessions is not carried; effect tests under ambient and stale sessions replace it. Quarantine on a missing session binding becomes the loaded-revision check, which answers "what am I bound to" from the text the session holds. Blob pins to a reviewed kernel commit become the npm version pin, `compatibility.json` and the binding contract. Hand-built approval prompts become the harness's own permission prompt. Personal or PR-gated capability grants become a pull request that edits `effects.v1.json` or the change policy, caught by tests.

### Installation and binding

`skills.json` gains a top-level `bundle_revision` of the form `<package version>+skills.<n>`, bumped whenever any skill changes, and each skill keeps its own version. Every skill body opens with `Bundle revision: <bundle_revision>` and the standing instruction to run `campaigns-os tooling status --skills-revision <that value>` at the start of each task. The command returns an explicit `revision_check: match | mismatch | unchecked` field in `--json` and a named line in text; a mismatch exits non-zero with the remedy "start a fresh session"; an absent argument reports `unchecked`, never silence; an on-disk revision is reported as exactly that. There is one executable per project: a project pin (devDependency) first, the packet's recorded kernel version second; both present and different is a `conflicting_pin` error; neither present is allowed but reported as `unpinned`; `--force` overrides a pin and is recorded. The minimal checker and the identity format ship in the first agent-files step, with the skill headers; the pin checks (`unpinned`, `conflicting_pin`, `--force` recorded) follow in their own pull request, tracked as campaigns-os#466, and must land before the trial; the general installer follows later.

### Preservation

Every write the installer makes into a shared instruction or configuration file is a delimited owned section or a namespaced key. Nothing outside the owned region is read back or modified. Repeat installs replace the owned region only and preserve a user edit inside it unless forced. An existing same-named skill directory not written by this installer is left alone and reported. `agent install --remove` deletes owned regions and copies and nothing else.

### Skills

Four Campaigns Agent skills are re-authored against the final kernel contract rather than copied: lifecycle orientation, run evidence, readback classification pointed at `campaigns-os readback --json`, and contribution intake, shrunk to a template with its redaction rule as the control on a public repository. Two are deleted, with their two good rules — provenance citation, and no private source to an unapproved provider — moved into the charter: the repository-context skill, and the write-back skill whose job every harness's own connector now does. The kernel's five lifecycle skills stay and their command references gain the declared effect class. Every skill names the tools it uses in its body, never in an `allowed-tools` field; generated adapters and skills carry no pre-approval configuration of any kind, and a generated-output assertion enforces that. Each re-authored skill ships in the same release as every command and document it names, and a clean-package installation exercise follows every reference and fails on a dangling one.

### The charter

The old profile charter merges into `AGENTS.md`: Campaigns OS is the authority; target text is data; select the campaign before reading it; cite the supported surface only; route intent to a skill; never widen capability in a session; cite implementation evidence as `repo@commit:path:line` and say dirty or stale beside it; return private source as tool output only to a provider the attended operator has approved. Quarantine and binding logic are dropped.

### Readback

The Python artifact readback is ported to the kernel as `campaigns-os readback`. The Python script is frozen at the port and changes no further, and it is deleted only at archive. Freshness becomes per-artifact: each loaded artifact carries its own staleness against the checkout's last HEAD movement, the aggregate is stale when any loaded artifact is stale, `clean` requires none, and the text view names which artifacts are stale. The output contract is versioned. The existing regression corpus is carried, plus mixed-age, tied-packet, unknown or missing, bounded-read and nested-worktree cases. A schema-valid payload alone is not proof.

### Telemetry

The onboarding skill requires an explicit telemetry choice before the first remitting command, and the CLI gains a first-run notice at minimum. Every remitting command is declared open-world with its destination named regardless.

### First-release harness set

The first release serves Claude Code, Codex and Cursor, through two skill placements, `.claude/skills` and `.agents/skills`, and instruction-file adapters for those three harnesses. Grok Build and Muse Code follow in a later release once verified first-party. For the trial, only the participant's harness is verified. A harness-matrix cell is "first-party" when the vendor documents it and "tested" only after an install exercise on a populated home; documented discovery is not an installation receipt. Demand beyond the first three harnesses is unknown rather than none, and expanding the set requires a named user.

The installed Hermes profile stays the fallback until archive. A generated Hermes adapter is a later, attended-only release with its own skill-path and provider test, and nothing unattended is claimed for it.

### Trial decision rules

The rules by which the content trial is read are written before the session, so that the result cannot be read as success whatever happens. Transport fit, answer quality, installation and the archive decision are separate observations and are recorded separately.

1. The selected campaign has no usable or current evidence and the agent says so accurately: that is correct limitation handling, with an artifact-production follow-up if useful; product utility and archive remain unproven, and there is no tool-face trigger.
2. Skills or charter fail to load, installation needs undocumented repair, or the selected executable or version is wrong: repair installation or binding and repeat the affected check.
3. The shell command runs correctly but the answer is materially wrong, stale evidence is stated as current, or the agent attempts an action outside the agreed task: revise skill or authority behaviour and repeat, do not label the transport inadequate, and record attempted effects and completed effects as separate observations, taken from the harness's own permission log.
4. The job is useful but a reproducible tool-discovery or invocation limitation remains in the participant's harness after using the documented CLI path: a bounded tool-face prototype for that limitation is justified, compared on the same job.
5. The developer completes a useful real task, corrections are recorded and the shell path suffices: continue with skills plus CLI and no tool face; archive still requires the released-path check and the migration decision, and voluntary reuse remains separate evidence.
6. The developer stops at a credential step, whether an API key, a store token or a deploy target: that is not a transport or skill finding but evidence for the credential handshake, and what was pasted and by whom is recorded.

### Build sequence

Each step carries its own proof.

- Step 1: this record.
- Step 2: the kernel items independent of the plan, which are issue #459 with the refused-command case under an effect test, the telemetry default documented where the agent surface states it, and the participant's harness cells verified first-party in `docs/harness-matrix.md` with the rest marked unverified.
- Step 3: the readback port with the freshness fix, plus `--dry-run` on the mutating commands that lack it.
- Step 3b: CLI credential transport, `login` and `logout`, built by the gateway track; already present at the commit that adds this record.
- Step 4: the first agent-files pull request, all in one — `effects.v1.json` with a row per command and its effect tests, `bundle_revision`, the minimal `--skills-revision` checker with match and mismatch tests, the four re-authored skills with the revision header and tools named in the body, the charter in `AGENTS.md`, the new paths classified and declared supported, the follow-every-reference exercise, and the generated-output assertion.
- Step 5: a content trial, skills plus CLI, no tool face, not the released installer, with the entry path recorded exactly, credentials via `login` and never a pasted token, and the harness's own permission prompts on.
- Step 6: decide the tool face from step 5's observation.
- Step 7: `agent install` under the installation, binding and preservation contracts, plus per-harness permission guidance generated from `effects.v1.json`.
- Step 8: the released-path check on a clean machine or home, credentials included.
- Step 9: downstream release consumers.
- Step 10: archive.

Step 5 needs the gateway track's proven revocation and audit, not merely a working login. Step 5 is the point of the exercise; steps 1 to 4 exist so that it costs a developer minutes and so that what they install is not lying about freshness or about what a command does. Step 5 is not a one-command install claim; step 8 is where that claim is earned.

### Archive

The `campaigns-agent` repository is archived, private, with a README pointer, only after the released install path has been checked on a clean machine and the migration of anyone still on the Hermes profile has been decided. Its issues are closed with a reason and its final release is tagged. It is never flipped public, because its history and tracker name merchants, staff and cost figures. Its changelog and its ADRs 0001 to 0003 stay there and are cited from this record. Nothing from it crosses except the re-authored skills and the allowlist tables, which are command names and become the first draft of the read-only rows.

### Lane 2

Lane 2 is a dependency, not part of this decision. The hosted posture routes to the hosted gateway track: a NEXT-hosted endpoint with server-held credentials, OAuth scopes and intent-level tools. This decision authorizes nothing hosted. It hands the gateway track the effect declarations, the `next` contract and, if one is built, the local tool face's shapes, and it takes `login` from it. There is no Grok Bot template port. `effects.v1.json` and a local tool face are natural prototypes of what a hosted gateway would expose; they are not evidence that hosting is cheap.

### Public surface

Campaigns OS is public under Apache-2.0. The re-authored skills pass the same extraction sweep as any team-to-public move: no merchant names, no private repository paths, no internal ticket identifiers. The kernel's readback fixture is synthetic and the `--example` sample is built from that shape. Effect declarations are public statements a harness will act on, so a wrong row is a public defect, and the effect test is what makes publishing one safe.

## Consequences

This decision removes a framework. It adds one surface unconditionally, `agent install`, justified by documented onboarding friction. Effect declarations are a documentation obligation the ecosystem imposes on any tool an agent runs, not a control loop. `agent mcp` is added only on evidence, and the mode gate is deferred because no active user has asked for it and the harnesses already do its job.

Some things become required. A published effect row requires its effect test, and a row without one is not published. No command is declared read-only until the lifecycle-journal coverage defect and the refused-command journal write are fixed. A change to a capability is a pull request that edits `effects.v1.json`, visible to the effect test and to the change-policy classifier. `src/agent/` may reach the kernel only through the exported command functions the CLI dispatches to. Skills carry their bundle revision in the body and the standing revision check, and ship in the same release as everything they name. Installer writes stay inside owned regions. Harness-matrix cells claim "tested" only after an install exercise on a populated home.

Some things become forbidden. There is no mode flag, no second package and no optional dependency for the agent surface. Skills and generated adapters carry no `allowed-tools` field and no pre-approval configuration of any kind. A tool face, if built, holds no logic of its own, exposes no server-side allowlist, and accepts no `--proxy-base`, consent override or journal destination from a caller. Nothing crosses from the archived repository except the re-authored skills and the allowlist tables. The `campaigns-agent` repository is never made public.

Some things are deliberately open. Whether a tool face is built, and when, is open and decided from the trial's observation. Whether the mode gate is built is open and waits on a project owner asking for it. The archive date, the trial date and the trial participant are open, as is which campaign the trial targets. Whether the CLI's telemetry default changes is open; what this decision settles is the explicit onboarding choice and the first-run notice. Grok Build and Muse Code support is open and follows a later release once verified first-party. Any activation of the hosted gateway is open and belongs to the hosted gateway track. The fate of the shelved observer work is open beyond its being archived with the repository. Demand beyond the first three harnesses is unknown, not none.

The attended local posture loses one mechanical control, for an agent in a shell-capable harness whose permission mode does not prompt. The remaining controls are the honesty of the declarations, the effect tests that prove them, the harness's permission rules, and the developer's own account scope.

## Evidence

This record relies on the following repository-relative artifacts. They are listed in two groups, because this record is step 1 of the build sequence and most of what it names does not exist yet.

Present in this repository at the commit that adds this record:

- `contracts/supported-surface.json` — the surface on which `contracts/effects.v1.json` and the generated adapters under `agents/` are declared in the first pull request that introduces agent files.
- `contracts/agent-relevant-change-policy.v1.json` — the change-policy classification that will classify the new agent paths and, with the effect test, fail a silent capability promotion.
- `skills.json` — the skill bundle manifest.
- `compatibility.json` — with the npm version pin, the binding contract that replaces the blob pin to a reviewed kernel commit.
- `AGENTS.md` — the charter's home once the charter is merged into it.
- campaigns-os issue #459 — `--no-write` coverage of the lifecycle journal, with the refused-command case.

Introduced by the build sequence, and not present here:

- `docs/harness-matrix.md`, recording what each harness consumes with a verified-on date per cell, is introduced by step 2.
- The readback regression corpus, carried forward and extended with its mixed-age, tied-packet, unknown or missing, bounded-read and nested-worktree cases, is introduced by step 3.
- `contracts/effects.v1.json` — the effect declarations, one row per command and effect-changing flag, each proved by its effect test — is introduced by step 4.
- `bundle_revision` in `skills.json`, and the `--skills-revision` match and mismatch tests, are introduced by step 4.
- The generated-output assertion and the follow-every-reference installation exercise are introduced by step 4.
- `src/agent/` and the import-boundary test over it, and the `install-skills` compatibility tests, are introduced by step 4 or step 7, with the installer of step 7 at the latest.

Campaigns Agent's own records stay in that repository and are cited from here.

- Campaigns Agent ADR 0001, "Begin every Campaigns OS stage at observe" — superseded.
- Campaigns Agent ADR 0002, "Bind each session to one verified Campaigns OS generation" — its launcher and session binding are replaced by the npm version pin, `compatibility.json` and the loaded-revision check.
- Campaigns Agent ADR 0003, "Capability promotion is a team decision made in a reviewed PR" — carried forward as the capability-promotion rule above.
