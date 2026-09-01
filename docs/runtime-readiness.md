<!--
  GENERATED FILE — do not edit.
  Source: contracts/runtime-recipe.campaigns-os-node-v1.json
  Regenerate: node ./scripts/generate-runtime-readiness.mjs --write
-->

# Runtime readiness

How a checkout of this repository at one commit becomes a usable installed runtime, and how a consumer decides whether a prepared one is still trustworthy. Everything below is generated from `contracts/runtime-recipe.campaigns-os-node-v1.json`, which is the only authority for these values.

Recipe kind `campaigns-os-node-v1`, revision `1.0.1`, validated by `schemas/campaigns-os-runtime-recipe.v1.schema.json` (`Campaigns OS Runtime Recipe v1`). Supported surface at generation time: `1.17.0`.

## What this is

A recipe is data, not code. A consumer executes exactly the commands enumerated here and never a command assembled from repository data. This repository publishes the recipe; the installed consumer bootstrap executes it, using its own released parser rather than anything loaded from the checkout under evaluation.

Enforcement is fail-closed. Every field is normative: `fail_closed` is `true` and a check that cannot be performed counts as `failed`, never as skipped. A refusal carries the stable reason code `runtime_recipe_refused`.

## What a prepared runtime can and cannot do

What a generation prepared by this recipe can and cannot do. Stated explicitly because 'runtime ready' invites the wrong reading: the same flag that makes the install safe also means the prepared generation has no browser to drive. Preparing a runtime and being able to run browser QA are different readiness questions, and this recipe answers only the first.

| Capability | Available |
|---|---|
| `type_check` | yes |
| `build_spec` | yes |
| `browser_qa` | **no** |

## Preconditions

All four must already hold before any step runs. They are fixed booleans because a precondition a document could switch off is not a precondition.

- `target_oid_resolved`
- `lockfile_present`
- `clean_staging_generation`
- `input_fingerprint_recorded`

## Tool versions

| Tool | Accepted range | Verified against | Rationale |
|---|---|---|---|
| Node | `>=20.19.0 <25` | `22.23.1` | The lower bound is the target's own declared minimum. The upper bound is the recipe's, not the target's: the target declares an open-ended minimum, and an open-ended range is not a bound. Delegating the ceiling to the checkout under evaluation would let that checkout widen the accepted runtime of the consumer evaluating it. Qualifying a new Node major is a one-line revision plus a ledger entry, which is the intended cost. |
| npm | `10 || 11` | `10.9.8`, `11.19.1` | Both majors were run end to end against this recipe and produced byte-identical output, and together they are exactly the set that supported Node release lines ship by default. Later majors are opt-in installs rather than what the ecosystem is running, so they stay outside the range until a Node line bundles one; that trigger is an external fact rather than a taste call. |

The contract declares its own ranges rather than inheriting the target's. It records the target's `engines.node` as `>=20.19.0`; on disagreement the disposition is `refuse`. The exact value this revision was authored against. A consumer compares the target's live value to this string and refuses on any difference, per on_disagreement. That is deliberately strict: a widened engines range in the target is precisely the silent widening this contract exists to catch, and re-agreeing is a one-line revision.

## Network

Two independent bounds that must both hold. The per-step policy bounds WHERE bytes may come from; the integrity digests recorded in the lockfile bound WHICH bytes are acceptable — that second bound is declared at `target_expectations.lockfile.integrity_pinned`, over the file at `target_expectations.lockfile.path`, which is also listed in `inputs.files`. Neither bound substitutes for the other. WHO ENFORCES THIS, PRECISELY: this object is a declaration the CONSUMER enforces. The argv in `steps[].args` deliberately does not carry it — there is no `--registry` and no offline flag there, and no `env` field on a step. A conforming consumer constructs the process environment for each step so that its package manager resolves only from that step's declared `hosts` (and from nothing at all where the policy is `deny`), owns the cache and both npmrc paths per `cache_ownership`, and refuses inherited npmrc, proxy, and credential configuration per the three `inherit_*` fields above. Carrying the pin in argv instead would change the recipe's commands, which is a new recipe KIND rather than a revision; it is a legitimate future design, not a silent fix. WHAT THAT GUARANTEES: a package-manager configuration bound, not a host-level network sandbox. It cannot stop a process from opening a socket to some other address. What bounds that is the other half of the recipe: `--ignore-scripts` on both steps means no third-party dependency code executes during preparation at all, so the only programs that run are the package manager and the compiler. Read each step's policy as 'the consumer configures this step's process to resolve packages only from that step's declared hosts, which for a `deny` step is none at all, and no third-party code runs that could disregard it' — which is true and checkable. Do not read it as 'the host is prevented from reaching anything else', which would require a sandbox this contract does not specify. A consumer that adds a real network sandbox strengthens this bound without changing a field below, and is encouraged to; a consumer that treats the declared hosts as advisory violates it.

| Step | Policy | Hosts | Rationale |
|---|---|---|---|
| `install` | `allowlist` | `registry.npmjs.org` | The install step is the only step that needs bytes it does not already have, and it needs them from exactly one place. Measured cold-cache install is a few seconds, so the network window is small. The cache is an optimisation and never a correctness input: an offline-after-warm policy would make a stale or poisoned cache silently change what gets built, with no fetch left to catch it. Note that `args` above carries no registry flag — the consumer is responsible for setting the package manager's registry to this host in the process environment before invoking that argv, and for refusing any inherited npmrc, proxy, or credential configuration that could redirect it. Combined with `--ignore-scripts`, nothing that runs during install is third-party code that could disregard the setting. The integrity digests remain the independent second bound, which is what makes a redirected or substituted byte stream fail even if the first bound were evaded. |
| `build` | `deny` | none | The build step is a local type-directed compile and needs no network at all. Declaring that turns an assumption into a check. As with install, `args` above carries no offline flag — the consumer puts the package manager into offline mode through the process environment it constructs for this step. `tsc` opens no sockets of its own, and `--ignore-scripts` keeps pre/post hooks from introducing any. |

Cache ownership is `consumer_profile`. Inherited proxy configuration: `false`. Inherited credentials: `false`. Inherited npm configuration file: `false`.

## Steps

### install

```
npm ci --ignore-scripts --no-audit --fund=false
```

Working directory `target_root`, stdin `closed`, lifecycle scripts `disabled`, bounded by `install_seconds`.

ci rather than install, so the lockfile is authoritative and the tree is reproducible. --ignore-scripts is the load-bearing flag: it suppresses every dependency lifecycle script and the target's own prepare. Exactly one dependency in the resolved tree declares an install script, and it ships a prebuilt binary in its published tarball, so nothing in the tree needs its scripts to function. --no-audit and --fund=false remove two network- and output-side effects that are not part of preparing a runtime.

### build

```
npm run --ignore-scripts build:spec
```

Working directory `target_root`, stdin `closed`, lifecycle scripts `disabled`, bounded by `build_seconds`.

Not redundant with the install step. Because install runs with lifecycle scripts disabled, the target's prepare script does not fire and the output directory is absent afterwards; this step is the only thing that builds the runtime under the recipe's own flags. --ignore-scripts here means the named script runs while its pre and post siblings do not, so the build is exactly one contracted command rather than an open-ended chain the target can extend.

## Inputs

The complete input set, enumerated explicitly rather than globbed. The compiler's configured include globs are NOT the input set: two root modules enter the compilation transitively through imports from the entry module and are emitted, so a fingerprint derived from the globs would cover 36 of the 38 compiled sources and miss one of the larger emitted surfaces. Test fixtures and the package's own tests are not inputs; nothing under them is emitted. A checker resolves the compiler's actual file list and asserts it equals this enumeration, so this list cannot rot silently.

Fingerprint algorithm `sha256`, over 42 enumerated files:

- `campaign-spec/analytics-vocabulary.ts`
- `campaign-spec/index.ts`
- `campaign-spec/normalize.ts`
- `campaign-spec/package.json`
- `campaign-spec/routing.ts`
- `campaign-spec/rules/analytics-contract-shape.ts`
- `campaign-spec/rules/assembly-hints-shape.ts`
- `campaign-spec/rules/campaign-metadata.ts`
- `campaign-spec/rules/checkout-has-success-url.ts`
- `campaign-spec/rules/cycle-detection.ts`
- `campaign-spec/rules/design-source-shape.ts`
- `campaign-spec/rules/downsell-without-upsell.ts`
- `campaign-spec/rules/exit-intent-validation.ts`
- `campaign-spec/rules/funnel-count.ts`
- `campaign-spec/rules/funnel-hypothesis-length.ts`
- `campaign-spec/rules/funnel-identity.ts`
- `campaign-spec/rules/funnel-weight-sum.ts`
- `campaign-spec/rules/index.ts`
- `campaign-spec/rules/offer-ref-integrity.ts`
- `campaign-spec/rules/package-pricing-sanity.ts`
- `campaign-spec/rules/page-count.ts`
- `campaign-spec/rules/page-id-uniqueness.ts`
- `campaign-spec/rules/promo-code-input-validation.ts`
- `campaign-spec/rules/promo-codes-shape.ts`
- `campaign-spec/rules/route-field-ignored-for-page-type.ts`
- `campaign-spec/rules/route-target-resolves.ts`
- `campaign-spec/rules/schema-version.ts`
- `campaign-spec/rules/sdk-version.ts`
- `campaign-spec/rules/shipping-countries-shape.ts`
- `campaign-spec/rules/shipping-methods-present.ts`
- `campaign-spec/rules/store-profile-shape.ts`
- `campaign-spec/rules/thank-you-requirement.ts`
- `campaign-spec/rules/unknown-top-level-fields.ts`
- `campaign-spec/rules/upsell-has-packages.ts`
- `campaign-spec/rules/upsell-routing-complete.ts`
- `campaign-spec/rules/upsell-without-checkout.ts`
- `campaign-spec/rules/variant-labels-shape.ts`
- `campaign-spec/sdk-version-parse.ts`
- `campaign-spec/tsconfig.build.json`
- `campaign-spec/types.ts`
- `package-lock.json`
- `package.json`

## Outputs

The output directory is a build product. It is untracked and git-ignored, no committed copy exists, and the copy in a published tarball exists only because packing runs the prepare script. There is therefore no baseline hash for its CONTENTS that this repository could publish, and any acceptance criterion phrased as 'output matches expected hashes' is not implementable as written. Verification is self-consistency instead: the inventory is complete and has nothing extra, the recorded hashes still hold, the entry module imports, the type entry is present, and the inputs that produced the output still match the inputs at the target commit. The build is deterministic — independent clean checkouts at one commit produce byte-identical output, and the compiler config emits neither source maps nor declaration maps, so no absolute paths or timestamps are embedded — which is what makes content hashing a sound strategy rather than a hopeful one.

Directory `campaign-spec/dist`. Committed: `false`. Type entry `campaign-spec/dist/index.d.ts`.

Expected inventory is derived, never listed twice. For every enumerated input under module_source_root whose path ends in .ts, the build is expected to emit campaign-spec/dist/<path relative to module_source_root, with .ts replaced> once per entry in emitted_extensions. The expected inventory is exactly that set: nothing missing, nothing extra. Emitted extensions: `.js`, `.d.ts`. At this revision that derivation yields 76 files.

### Mandatory checks

Every check below is mandatory; there is no optional check, because an optional check is an advisory bound under another name.

| Check | Kind | Detects | Applies to | Rationale |
|---|---|---|---|---|
| `dist_inventory` | `dist_inventory` | `absent`, `extra` | The set of files present under outputs.directory after the build step. | Catches both directions. A missing module is an incomplete emit; an unexpected file is as much a signal as a missing one, because it means something other than the declared build wrote into the output directory. |
| `content_hash_stability` | `content_hash_stability` | `corrupt` | The bytes of every file under outputs.directory, hashed with the inputs.fingerprint_algorithm digest and recorded in the generation manifest. | Detects any post-build modification of the prepared runtime. Costs single-digit milliseconds against an output measured in hundreds of kilobytes. It is a self-consistency check, not a comparison against a hash published here: no such hash can exist, because the output is not committed. |
| `module_import_smoke` | `module_import_smoke` (shallow) | `corrupt` | Importing the emitted package entry module once. | A file can hash cleanly and still be unloadable. Shallow for this revision: importing the entry module transitively loads most of the emitted graph for one import's cost. A per-module deep import is a revision, warranted if a partial emit is ever actually observed rather than in anticipation of one. |
| `type_entry_presence` | `type_entry_presence` | `absent` | outputs.type_entry. | Consumers resolve types for the package export through this file, and the pack check already asserts its presence in the published tarball. Cheap, and it guards a real declared contract rather than an internal detail. |
| `cli_skill_commit_agreement` | `cli_skill_commit_agreement` | `mismatched_generation` | The executable and the skills tree resolved by the running session. | Asserts that the executable a session runs and the skills tree it loads resolve below the same generation path and the same target OID. Two halves of a session drawn from different generations is the failure this catches, and neither hashes nor imports would notice it. |
| `tool_versions` | `tool_versions` | `unsupported_tooling` | The Node and npm versions that actually executed the steps, against tooling.node and tooling.npm. | Recorded after the fact as well as checked before, so a generation carries evidence of what built it rather than only of what was permitted to. |
| `input_fingerprint` | `input_fingerprint` | `stale` | The digest over the enumerated inputs.files recorded at build time, compared against the same digest computed at the target commit. | The one check that cannot be dropped. Stale output is internally consistent — its hashes are correct, it imports, its types are present — so it is invisible to every output-side check. Only comparing the inputs that produced it against the inputs at the target commit catches it. |

### Prepared-runtime states

Declarative descriptions of the prepared-runtime states an output-check implementation must distinguish. A test builds each state from the accepted recipe rather than from paths written down here, so adding a module to the input set cannot leave a fixture describing an inventory that no longer exists.

| State | Expect | Detected as | Why it matters |
|---|---|---|---|
| `healthy` | pass | — | The control. Without it the four failure fixtures prove only that the checker fails, not that it discriminates. |
| `absent` | fail | `absent` | Nothing was built, or the output directory was removed after the build. The inventory check is the only one that can report this cleanly; every other check would report a cascade. |
| `extra` | fail | `extra` | Something other than the declared build wrote into the output directory. An unexpected file is as much a signal as a missing one. |
| `corrupt` | fail | `corrupt` | A file was modified after the build recorded its digest. Caught by hash stability; the import smoke is the second line for the case where the alteration also makes the module unloadable. |
| `stale` | fail | `stale` | The output is internally consistent — complete inventory, correct hashes, imports fine — but was produced from inputs that no longer match the target commit. Only the input fingerprint sees this. |

## What the recipe assumes about the target

What this revision assumes about the target, stated as values a checker can compare rather than as prose a reader has to trust. Each one is a thing that, if it changed without the recipe changing, would silently alter what preparation does: a widened engine range, a rewritten build script, a lockfile format the install step reads differently, or a new dependency that would execute code the moment the suppressing flag was dropped.

| Assumption | Value |
|---|---|
| Manifest | `package.json` |
| Lockfile | `package-lock.json`, version `3`, integrity pinned `true` |
| Script `build:spec` | `tsc -p campaign-spec/tsconfig.build.json` |
| Script `prepare` | `npm run build:spec` |
| Dependencies declaring an install script | `fsevents` |

## Bounds

| Bound | Value | Measured baseline | Applies to | Rationale |
|---|---|---|---|---|
| `install_seconds` | 180 seconds | about 3.2 seconds on a cold cache, about 0.3 seconds warm | Wall-clock duration of the install step. | Roughly 57x the measured cold-cache cost, and deliberately generous. The measurement is a fast local connection, which is the best case rather than the typical one; this bound has to hold on a cold cache, a congested network, a loaded machine, and in CI. A timeout that trips on a slow morning produces a refusal the operator cannot act on. |
| `build_seconds` | 90 seconds | about 0.8 seconds | Wall-clock duration of the build step and the output checks that follow it. | Roughly 115x the measured cost. The whole mandatory check set adds well under a second on top, so nothing here is deferred for cost. Generous for the same reason as the install bound. |
| `transaction_seconds` | 450 seconds | about 4 seconds end to end | Wall-clock duration of the whole preparation transaction: preconditions, both steps, and every output check. | Roughly 110x measured. It bounds the transaction as a whole rather than being the sum of its parts, so a phase that stalls short of its own bound still cannot hold a preparation open indefinitely. |
| `max_output_bytes` | 16777216 bytes | 240,359 bytes | Total bytes of all files under outputs.directory after the build step. | 16 MiB, roughly 70x the measured output. This bound does not exist in the performance budget it otherwise mirrors; it is added so that a build which goes haywire is a typed refusal rather than a filled disk. |
| `max_output_files` | 4096 files | 76 files | Count of files under outputs.directory after the build step. | Roughly 54x the measured count. Paired with max_output_bytes because the two catch different runaway shapes: many small files, and few enormous ones. |

When a bound below is genuinely reached, the answer is to find out why before raising it. A dependency install that exceeds its bound on a warm machine is a supply-chain change, not a slow morning; an output inventory that exceeds its file or byte bound is a build that went wrong, not a package that grew 50x overnight. Raising a bound is the fallback, it advances recipe_revision, and it owes a release-ledger entry. Widening the accepted npm range follows the same path, and its trigger is external and checkable: widen when a Node release line ships that npm major by default, not when a particular machine happens to have it installed.

## Changing the recipe

The line is consumer comprehension, not semantic significance. A NEW KIND is anything an installed consumer would have to newly understand in order to execute the document correctly: a different command or package manager, a changed network policy shape, a new KIND of output check, or a new required field. An older consumer must fail closed on it, and a consumer release comes first. A REVISION re-parameterises fields the consumer already understands: accepted version bounds, timeout values, the enumerated input set, the expected output inventory. An older consumer executes a revision correctly, with different numbers. Both owe a release-ledger entry; only a new kind gates on a consumer release. The test for which one applies is answerable in a fixture — does a consumer built against this schema parse and execute the document? — rather than by judgement about how big the change feels.

The recipe and its schema are both HASHED supported-surface entries, so changing either requires `surface_version` to advance in the same change. The single authority for how a checkout of this repository at one commit becomes a usable installed runtime. No checker, schema, document, or test may carry its own copy of a command, a version bound, a timeout, an input path, or an output rule stated here — every one of them is read from this file. It is data, never code: a consumer executes exactly the argv enumerated in steps[] and never a command assembled from repository data. Registered as a HASHED supported-surface entry rather than a named one, deliberately departing from the policy contracts introduced alongside it: a reason-code vocabulary grows additively and can safely live behind a named entry, but any change to the commands, network policy, accepted tool versions, inputs, or output verification here is an agent-relevant release event by the recipe's own rule. Only a hashed entry makes such a change require surface_version to advance in the same change (scripts/check-supported-surface.mjs --base). A recipe whose commands can change without a version bump is not a contract. Changing this file also owes a release-ledger entry.

## Refusals

These documents are refused. Each is a single-mutation fixture under `contracts/fixtures/runtime-recipe/reject/`, so a refusal is always attributable to one change.

| Fixture | Why it is refused |
|---|---|
| `reject/unknown-kind.json` | recipe_kind names a kind this schema version does not define. An installed consumer was not released knowing how to execute it, so it fails closed rather than guessing that a v2 is a v1 with extras. |
| `reject/unknown-revision.json` | recipe_revision leaves the major line the kind defines. A revision may only re-parameterise fields the consumer already understands; a different major is a shape change wearing a revision's clothes. |
| `reject/unknown-network-policy.json` | A safety-critical enum: the install step declares a network policy outside the defined set. There is no allow-all value, and an unrecognized one is refused rather than treated as permissive. |
| `reject/allowlist-without-hosts.json` | An allowlist with no hosts is not a bound, it is an empty declaration that reads like one. The schema requires a non-empty host list whenever the policy is an allowlist. |
| `reject/unknown-output-check.json` | A safety-critical enum: an output check names a kind the consumer cannot perform. A new KIND of check is a new recipe kind, because an installed consumer cannot perform a check it was not released knowing. |
| `reject/unknown-step-id.json` | A safety-critical enum: a step identity outside the defined set. Steps are identified rather than positional, so an unrecognized id is a command the consumer has no contract for. |
| `reject/lifecycle-scripts-enabled.json` | A safety-critical enum: a step that permits lifecycle scripts. Enabling them would let the target run arbitrary code during preparation, which is the single thing the recipe's flags exist to prevent. |
| `reject/engines-disagreement-warns.json` | A safety-critical enum: disagreement between the contract's tool range and the target's declared engines resolved as a warning. An accept-with-warning path produces a build made under conditions nobody approved. |
| `reject/advisory-enforcement.json` | fail_closed switched off. Advisory bounds record the right numbers and enforce nothing, so the first time a bound matters you discover it was decorative. |
| `reject/unperformable-check-skipped.json` | A safety-critical enum: a check that cannot be performed treated as skipped. A skipped check reports success it never established. |
| `reject/committed-output-claim.json` | The recipe claims its output directory is a committed artifact. It is not: the directory is git-ignored and untracked, so no baseline for its contents can exist here and verification must be self-consistency. |
| `reject/unpinned-lockfile.json` | The recipe claims its lockfile is not integrity-pinned. The network allowlist bounds where bytes may come from and the lockfile's digests bound which bytes are acceptable; dropping the second leaves the first standing alone, which it was never meant to do. |
| `reject/missing-required-field.json` | The enumerated input set is absent. Without it there is nothing to fingerprint, and staleness — the one failure mode no output-side check can see — becomes undetectable. |
