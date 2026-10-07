# Build Packet

The Build Packet is the campaign assembly handoff. It wraps, but does not replace, the CampaignSpec.

It answers:

- Which CampaignSpec and saved Map ID or local-spec ID are we building?
- Which public route slug and campaign directory are expected?
- Where are the prepared HTML/assets?
- Which Campaign Build Brief is the merchandising/design presentation truth?
- Which target page-kit repo should be updated?
- Which starter template family is locked?
- Which commerce catalog/contract should the agent read?
- Which deploy target, SDK origin state, and QA proof depth apply?

The current schema is `schemas/campaign-runtime-build-packet.v0.schema.json`.

## Local-spec entry

A saved Map is optional for a prepared-HTML build. The coding agent authors an
ordinary CampaignSpec from the brief, source design and configured campaign's
real commerce values, following `schemas/campaign-spec.v4.schema.json`. The
operator supplies the selected store/campaign, public Campaigns API key, intended
pages and commercial choices, plus store contact details and policy URLs. Verify
the store/campaign binding, and read the package, offer and shipping references
from the campaign itself (below); do not guess commerce values. No gateway or
Map provisioning is required for this entry.

Set `spec_identity.local_spec_id` to a new UUID once, commit it with the spec,
and keep it unchanged through revisions and fresh checkouts. It accepts 1–64
letters, digits, underscores or hyphens, with no surrounding whitespace. Local
IDs are checked exactly; the legacy normalization of saved Map IDs does not
apply. Malformed or conflicting local identities cannot be adopted into campaign
evidence; blocked diagnostic reports may still be written. Doctor reports local
identity failures as `spec.local_identity`, while
saved-Map failures retain `spec.map_id`. Set `spec_identity.public_route_slug`
to the intended route. Omit `map_id`, saved-Map URLs and saved-Map revision
metadata; a local ID is never a Map ID. A spec declaring both kinds is refused.
A separately authored campaign gets a new local ID even if its route matches.

```sh
npx --no-install campaigns-os start --spec campaign-spec.json --source source-html --target . --template-family <certified-family> --deploy-target local-serve
npx --no-install campaigns-os next --packet campaign-runtime.build.json
```

The packet and report retain `map_id: null` and carry `local_spec_id`. Doctor,
report writes, polish capture, progress, run closeout and QA compare that local
identity. Material spec hashes still bind the current revision; a changed ID or
content cannot reuse earlier proof. After a material revision, doctor and
`next` warn `spec.material_stale` (the spec no longer has the material hash
the Assembly Report binds, which QA refuses), and `next` routes to the build
and names the refresh: run `campaigns-os record spec --packet <packet>` to bind
the new content and keep stage history (see
[Refreshing after a CampaignSpec change](#refreshing-after-a-campaignspec-change)). Keep the spec, source, dependency
pins and canonical sidecars in Git. Use `readback` and `next` after a fresh
checkout; identity survives the move, but proof freshness is assessed again.

Run QA through `--packet`. Local verdicts use the storage key
`local-spec-<local_spec_id>` and carry the explicit ID in the full verdict and
committed sidecar. A matching route alone cannot adopt a verdict. Local QA is
never posted to the Map portal: `qa run` suppresses publication even with
`--post-verdict`, while `qa publish` refuses with `local_spec`. Progress remains
local with `map_id_missing`. Run Telemetry retains
its existing consent controls. `spec derive --write-map` requires a real saved
Map. Moving to a saved Map requires fresh preparation and evidence; this entry
does not claim saved-Map revision alignment.

Existing saved-Map specs and packets continue to work. The identity change does
not relax template certification, source proof, store/SDK parity, polish,
commerce checks, or typed-card checkout proof. Resolve their reported gates;
localhost readiness is not production approval.

### Reading package, offer and shipping refs

No command writes commerce refs into a local spec, and `login` does not read
them: a gateway login serves only the Store Profile fields that `spec derive
--from-store` fills. Read them with the campaign's public Campaigns API key,
through the request doctor and QA already make to check built pages against
the live campaign: one GET of NEXT's proxy with the key in the
`X-Campaign-Key` header. No store or Admin credential is involved.

```sh
CAMPAIGN_KEY='<public key>' node -e '
fetch("https://campaign-map.nextcommerce.com/api/campaign", {
  headers: { Accept: "application/json", "X-Campaign-Key": process.env.CAMPAIGN_KEY },
}).then(async (res) => console.log(res.status, JSON.stringify(await res.json(), null, 2)));
'
```

`curl -sS -H "Accept: application/json" -H "X-Campaign-Key: <public key>" https://campaign-map.nextcommerce.com/api/campaign`
returns the same. Add `?ref_id=<campaign id>` when one key serves several
campaigns. Other HTTP clients work with the same header, but the proxy refuses
some default user agents, Python `urllib`'s and Perl `libwww-perl`'s among
them, with a 403 whose body is `error code: 1010`; send another `User-Agent`
or use one of the commands above.

The answer is an envelope, `{ ok, status, endpoint, requested_ref_id,
retrieved_at, data }`, with `requested_ref_id` present only when `?ref_id=`
was sent; `ok: false` carries an `error` instead of a campaign. `data` is the
campaign retrieve body the Campaign Cart SDK reads in the browser: one
campaign, or an array of them, in which case use the entry whose `id` is the
selected campaign. Copy from it as follows:

| `data` field | CampaignSpec field |
|---|---|
| `id` | `campaign.ref_id` (doctor and QA send it as `?ref_id=`) |
| `name`, `currency`, `language`, `payment_env_key` | the `campaign` fields of the same name |
| `packages[]`: `ref_id`, `name`, `qty`, `price`, `price_retail`, `image`, the `product_*` fields and the recurring fields (`is_recurring`, `price_recurring`, `interval`, `interval_count`) | one `funnels[].pages[].packages[]` entry for each package the page sells |
| `offers[]`: `ref_id`, `name`, `type`, `code`, `condition`, `benefit`, `packages[]` (by `package_id`), `shipping_methods[]` | root `offers[]`, copied whole; a page that presents an offer lists it in `funnels[].pages[].offers[]` by `ref_id` |
| `shipping_methods[]`: `ref_id`, `code`, `price` | root `shipping_methods[]` |

A package's ref is its `ref_id`, numbered within the campaign. `external_id`,
`product_id` and `product_variant_id` are catalog ids, never package refs. The
same `ref_id` values are what pages render in `data-next-package-id` and
`data-next-shipping-id`. The read supplies refs and the values the campaign
serves, not the selection: which packages and offers each page carries, and
the role flags `is_upsell`, `is_order_bump` and `default_selected`, come from
the brief and the operator. Copy prices and availability from the read rather
than typing them from the brief. After the build, doctor and QA repeat this
read and block a page ref the live campaign does not serve (see
[the live campaign read](effects.md#the-live-campaign-read)).

## Root-Served Campaigns (`campaign.route_root`)

Most campaigns are served under a slug prefix (`/<public_route_slug>/...`), and
that stays the default. A campaign whose whole funnel is served from the **site
root** — pages at `/checkout-v2`, `/oto-rootfunnel`, `/receipt` with no slug prefix,
the normal shape for a single-campaign site or an in-place static deploy —
declares `campaign.route_root: "/"`. Rules:

- `public_route_slug` stays **required** either way: it is the campaign
  identity and the `_site/<public_route_slug>/` built-output directory name.
  `route_root` describes the *served* path shape only.
- When present, `route_root` must be `"/"` or `"/<public_route_slug>/"`; any
  other prefix is a doctor blocker (`campaign.route_root`) because it would
  contradict the slug identity the built-output checks root on. `qa run`
  reads the packet by the same rule: a value doctor blocks never roots a QA
  check either — QA audits the slug-prefixed default instead — so a
  hand-edited packet cannot pass QA at a root doctor refuses.
- Doctor's routing-meta checks (`routing_meta.runtime_root`,
  `sdk_hints.meta_tags.route_mismatch`) and route displays validate against the
  declared route root instead of assuming slug-as-prefix, so a root-served
  funnel's correct `/receipt`-style metas pass without waivers. A routing
  meta value with a bare or `//` host in front of its path is not a
  `runtime_root` warning; it is the `routing_meta.host_prefixed` blocker (see "Page Kit
  Target Projection" below).
- The CampaignSpec may carry the same declaration at `campaign.route_root` (or
  `spec_identity.route_root`); `prepare-build` copies it onto the packet and
  defaults `live_url_path` to `/`.
- Two `sdk_hints.meta_tags` keys older Map exports still carry, `next-currency`
  and `next-predictive-address`, are not read by the Campaign Cart SDK (the
  list is `src/sdk-meta-tags.mjs`; QA reads the same one). Doctor never
  requires them from the built page: a spec that lists one gets a single
  advisory warning per page, `sdk_hints.meta_tags.ignored_by_sdk`, naming the
  key and the reason (`remove from the Map's page hints; the SDK does not read
  it`), whether or not the tag rendered and before `_site/` exists. They are
  never `sdk_hints.meta_tags.missing` and never appear in the pre-build
  "CampaignSpec expects SDK meta tags (...)" list. The fix is an edit to the
  Map's page hints, not to the build.

Page-kit also needs `campaign.store_url` for `_data/campaigns.json`. Additional Store Profile fields live under `campaign.store_*` as optional storefront/legal metadata because they are not Campaigns API data: the operator enters them, or `spec derive --from-store` derives them from the store (see "Deriving the spec from the repo" below).

### Page Kit Store Profile checkpoint

Doctor compares the packet-local CampaignSpec to exactly nine governed fields
in `_data/campaigns.json[public_route_slug]`, in this order:
`store_name`, `store_url`, `store_terms`, `store_privacy`, `store_contact`,
`store_returns`, `store_shipping`, `store_phone`, and `store_phone_tel`.
Before scaffold, a missing target entry is `not_applicable`; once setup or
assembly is terminal, or the target output already exists, missing or malformed
target evidence is a non-waivable blocker. Target-only values remain warnings.
Mismatches, missing required target values, and known demo residue block.
An absent or null spec field means "not provided". An explicit empty (or
whitespace-only) string in one of the eight optional fields (`store_name`,
`store_terms`, `store_privacy`, `store_contact`, `store_returns`,
`store_shipping`, `store_phone`, `store_phone_tel`) means the merchant has no
such value: `page-kit sync` blanks a recognised starter demo value with it
(the placeholder storefront URLs and phone number; the starter's demo store
name is not recognised and stays a `target_only` warning), and a blank or
absent target field then reads as `intentionally_empty` (clean, and named in
the gate reason and the doctor line). `campaign.store_url` stays required: a
`""` there still raises doctor's `spec.store_profile` error, and the gate
reason says so. A real, non-demo target value against a spec `""` is left as
it is and stays a `target_only` warning, because Maps saved `""` for every
cleared store field before it meant empty; the warning and the sync output
(`spec_empty_not_applied[]`) say the `""` was not applied, so remove that value
by hand if the merchant has none. An empty string outside these fields
carries no such meaning.
Demo residue (a `demo.29next.com` URL or the demo phone number still in the
target) is never waivable: the gate names the residue fields, offers no waive
command for them, and `checkpoint waive` refuses with those fields until the
values are replaced.

The repair is a command. A fresh page-kit scaffold (`campaign-init`) seeds the
route's entry with the starter family's demo profile and pin, so this gate and
the SDK-version gate below block on every first run; the values that clear
them already exist in the CampaignSpec, and doctor and `next` print the
reconcile as the gate's `repair_target` action:

```bash
campaigns-os page-kit sync --packet campaign-runtime.build.json [--dry-run] [--json]
```

The CampaignSpec is the authority for the Store Profile: those values are
authored in the saved Map or the repository-owned local spec, so `page-kit sync` writes the nine
fields the spec carries (`campaign.store_*`) unconditionally. The SDK pin is
different. On an existing campaign the repo pin moves first and the Map/spec
is stale until someone re-saves it, so a spec → repo write would undo a bump
silently; sync therefore **seeds** `sdk_version` (`global_config.sdk_version`,
or the `runtime.sdk_version` alias when the canonical key is absent): it
writes the pin while the entry is still in scaffold state (the starter demo
store profile is still in it) or when the target pin is older than the
spec's, and refuses to move a configured campaign's pin backwards
(`not_synced`, reason `target_newer`, naming both versions and pointing at
re-saving the Map). The repo pin is the authority for what ships and the Map
field is a build hint, so that state is a doctor warning, not a blocker (see
the SDK version checkpoint below). Both go into `_data/campaigns.json[public_route_slug]`,
prints a field-by-field before/after diff, and touches nothing else: a
governed field the spec does not carry (absent or null) is left as it is
(doctor's `target_only` warning still applies), a field the spec sets to `""`
(or whitespace only) blanks a recognised starter demo value (the placeholder
storefront URLs and phone number; the starter's demo store name is not
recognised and stays a `target_only` warning) and otherwise leaves the target
value as it is (listed in `not_in_spec[]` as before and also in
`spec_empty_not_applied[]`, printed as `Spec "" not applied`), non-governed
keys keep their values and order, other routes and other files are not
written. The file is edited in
place and re-serialized with its own top-level indentation, line ending and
trailing newline; when that round trip would not have reproduced the file
byte for byte (a minified file, mixed indentation), a
`page_kit.sync.file_reformatted` warning says so, because the printed diff
covers only the governed fields. `--dry-run` prints the same diff without
writing. Exit 0 on success (including a no-op re-run); exit 2 with
`page_kit.sync.*` error codes and nothing written when the packet cannot be
read, the target entry or the spec is missing or not an object, the spec
identifies another campaign (`spec_identity.public_route_slug`, `map_id` or `local_spec_id`
disagreeing with the packet: `page_kit.sync.spec_identity_mismatch`), or the
resolved `_data/campaigns.json` lies outside the target repo through a symlink
(`page_kit.sync.target_escapes_repo`).

The spec is the authority, but the target is made authoritative only from a
usable spec value. States the target cannot be made authoritative for are
reported as `not_synced` with a reason, never written, and the run's status
is `partial` (exit 0, since the writes that could happen did; doctor will
still block): a conflicting or non-released spec pin; a spec field of the
wrong type (`spec_invalid_type`, doctor's own blocker); a URL field that is
not an http(s) URL or a `store_phone_tel` that is not a `tel:` URI of digits,
spaces, dashes, parens and dots (templates put both into `href` attributes,
where escaping does not neutralize another scheme); a value with control
characters; the starter demo value itself in the spec; and starter demo
residue in a governed field the spec does not carry (doctor blocks on that
residue without a waiver, and sync has no spec value to write over it). For
every one of those the gate's `repair_target` action is an edit naming the
spec field, not the sync command, so `next` never loops on a repair that
cannot make progress. Fix the spec, then sync again. (`store_contact` may
also be a `mailto:` address, the one non-http value templates render as a
contact link.) A gate under an active named-human waiver is a human decision
sync does not reverse: its fields are reported `not_synced` with reason
`waived` naming who waived, and the target stays as the waiver accepted it
until the waiver is withdrawn from the Assembly Report. Sync reads the report
doctor would (the one the Build Context binds, or `--report <path>`, which
doctor appends to the printed command when it inspected a non-default
report); unknown flags are rejected rather than ignored, so a mistyped
`--dry-run` cannot become a write. After a write the retained doctor
snapshot is marked stale; when the report records a terminal build, a
`page_kit.sync.build_stale` warning says the rendered `_site/` was built
from the old entry and points at the rebuild, because doctor's page-kit gates
read `_data/campaigns.json`, not the built output. Re-run `doctor` and both
gates report `pass` without a waiver.

An intentional, evidence-backed mismatch or missing value may be accepted with
the first gate in the staged checkpoint registry:

```bash
campaigns-os checkpoint waive \
  --packet campaign-runtime.build.json \
  --gate page_kit.store_profile \
  --reason "<why correction is intentionally deferred>" \
  --waived-by "<named human>" \
  --review-condition "<specific re-evaluation trigger>"
```

Use `--expires-at <canonical-ISO-timestamp>` instead of, or alongside,
`--review-condition`; at least one bound is required and an expiry must be later
than `waived_at`. The decision is appended to the Assembly Report's top-level
`waivers[]` and fingerprints the exact slug, relative target path, and governed
discrepant field/value set. Stale, foreign, expired, or malformed records are
inert. A current waiver produces checkpoint status `waived` and doctor/next
readiness `ready_with_waivers`; it never becomes a clean pass. Raw arbitrary
campaign entry fields are validation-private and never belong in doctor, next,
sidecar, or QA evidence. The same boundary applies to waiver history: public
gate/readback/QA output whitelists the active decision's scope, current safe
subject, fingerprint, attribution, timestamps, and bound, while inert history
is exposed only as stale/foreign/malformed/expired counts. Raw report records
remain private to evaluation. Once correction removes all blocker fields,
waiver history is not evaluated or surfaced as an inert warning.

### Page Kit SDK version checkpoint

The second registered checkpoint requires a canonical released semantic version
in CampaignSpec and a released target pin in
`_data/campaigns.json[public_route_slug].sdk_version`. CampaignSpec's
`global_config.sdk_version` is canonical, with `runtime.sdk_version` as an
accepted alias; declaring both is valid only when their released
versions are equal. Missing, malformed, present-but-empty, non-string,
prerelease, non-canonical, or conflicting dual declarations are non-waivable.
Missing or invalid target evidence is also non-waivable.

The two pins have a direction of authority. The repo pin is the version the
funnel serves, so it is the only value a bump can be proven against; the spec
field is a build hint whose job is to seed a fresh scaffold. The gate compares
them accordingly:

- **Equal** — pass.
- **Target newer than the spec, both released, entry configured** (the
  starter demo store profile is gone) — a completed bump the Map has not been
  re-saved for. Doctor passes the gate with the `page_kit.sdk_version.repo_newer`
  warning and a ready line naming what ships; QA projects it as a `warn`
  assertion; `next` does not stop. The gate's `advisory_actions` carry one
  `refresh_spec` command, `campaigns-os spec derive --packet <packet>`
  (below), which writes the repo pin into the spec; with `--write-map` it
  also records the pin in the Map's Build hints field (Campaign Cart SDK
  version), which is otherwise re-saved by hand to make the exported spec
  stop reading stale. Nothing in the repo needs to change, and there is
  nothing to waive.
- **Target behind the spec, or still the scaffold's seeded pin beside the demo
  store profile** — blocked, repaired by `page-kit sync` (below) or waived.
- **Target pin not a released version** — blocked, non-waivable, whatever the
  spec says.

Only the blocked mismatch between two valid released versions has a waiver
lane, and the decision fingerprints that exact expected/observed pair:

```bash
campaigns-os checkpoint waive \
  --packet campaign-runtime.build.json \
  --gate page_kit.sdk_version \
  --reason "<why this exact target pin is intentional>" \
  --waived-by "<named human>" \
  --review-condition "<specific re-evaluation trigger>"
```

Changing either version makes the decision stale. The same named-human,
bounded-decision, visibility, and privacy rules described for Store Profile
apply. A target pin that is missing, malformed, or behind a valid spec pin
(or still the scaffold's seeded pin beside the demo store profile) is repaired
by the same `campaigns-os page-kit sync --packet <campaign-runtime.build.json>`
described above, which doctor and `next` print as the gate's `repair_target`
action. A configured campaign whose pin is newer than the spec's is the
advisory case above: no required action, and sync never moves that pin
backwards; `spec derive` is the command that closes it from the spec side.

### Changing a campaign after handoff

For page-kit campaigns, the reviewed repository spec determines the next build.
New handoffs use `.campaigns-os/campaign.spec.json`; existing packets keep their
`spec.local_path` until a separate, reviewed migration. Static campaigns do not
need a spec or packet for an SDK upgrade. This procedure implements the operating
agreement in [#432](https://github.com/NextCommerceCo/campaigns-os/issues/432)
and [#447](https://github.com/NextCommerceCo/campaigns-os/issues/447). It is a
review procedure, not an automatic Map import or a portal editing lock.

A PM can keep using Map Builder to propose a change. Saving the Map does not
change the campaign repository or approve that change for the next build.

| Responsibility | Owner |
|---|---|
| Propose offers, copy, page sequence and other authored intent; confirm the intended result | Campaign PM or named campaign owner |
| Compare the proposal with the current repository, prepare the spec/code change and run checks | Developer, assisted by an agent where useful |
| Resolve competing edits to the same authored field | PM confirms intent; developer checks the resulting implementation |
| Review and merge the repository change | The campaign's existing authorized reviewer, under its normal PR rules |
| Refresh store-derived data requiring an Admin token | Authorized operator or PM; never a routine developer SDK-bump prerequisite |

Record the actual PM and developer/reviewer in the campaign change request. An
agent can prepare a diff and evidence, but cannot supply a missing human decision.
This procedure does not grant new merge, store-write or deployment authority.

#### Propose and reconcile a change

1. **Identify the starting revision.** Record the campaign repo, Git commit and
   packet's spec path that the PM reviewed. Keep that spec as the baseline. A Map
   ID identifies lineage, not the revision: also retain the proposed Map export
   and its save/hash evidence. Do not overwrite the repository spec with it.
2. **Compare three versions.** Compare the baseline with the PM's proposal, then
   with the current repository spec. Match pages and packages by their stable
   identifiers, not array position. Explain additions, removals and routing
   changes as well as changed values. The
   [field-class contract](https://github.com/NextCommerceCo/campaigns-os/issues/432#issuecomment-5707550439)
   identifies what a PM can author and what the repo, API or editor owns.
3. **Apply the intended change to the current spec on a branch.** Transfer only
   the PM's authored changes. Keep current repo-derived SDK pins, page URLs and
   analytics IDs; preserve API/store records and editor metadata under their own
   authority. An offer selection may change, but a proposed price does not
   rewrite an API-owned price: route that commercial setup change to its owner
   and obtain refreshed readback before building it.
4. **Resolve conflicts before accepting the change.** If PM and developer changed
   the same authored field differently, neither value wins automatically. Record
   the chosen value and PM confirmation in the PR. If the baseline is missing,
   pause the import: ask the PM to restate the change against the current spec.
   Do not infer intent from every difference in a stale export. If the repository
   advances during review, repeat the comparison against the new revision.
5. **Refresh and validate the result.** Preview `spec derive --dry-run`, inspect
   every refused or unresolved field, then apply the accepted derivation. Plain
   derive is local; it does not merge authored intent. Follow the packet's normal
   `page-kit sync`, build, doctor and relevant QA steps. Resolve stale routing
   hints and rebuild affected pages. A successful derive exit alone is not build
   or QA approval. After an authored-only edit, derive may return `unchanged`
   and leave the Assembly Report's spec hash at the previous build. Record fresh
   build evidence and verify its spec fingerprint before accepting it. A changed
   spec must not reuse evidence for the older build.
6. **Review the intended result and record the revision.** The PM confirms the
   commercial change and the developer supplies the checked diff and preview
   evidence. Record the reviewed spec's exact-byte SHA-256, the tested repository
   revision, and the doctor/QA evidence in the PR. Build or deploy from that
   reviewed revision under the campaign's existing rules; rerun affected checks
   if the spec or code changes afterwards. Tell the PM which proposal was accepted
   and identify any remaining Map differences, so the saved Map is not mistaken
   for a synchronized copy.

A change request needs only: baseline commit/spec path, the proposal or requested
field changes, current repository revision, conflict decisions, named reviewers,
and the final spec hash with build/QA evidence. Use existing PRs and campaign
records for this; there is no additional sidecar schema or new CLI command.

#### Example: the PM changes an upsell while the developer upgrades the SDK

The PM starts from reviewed revision A and replaces the first upsell's selected
package with package B, already present in the campaign API. Meanwhile the
repository reaches revision R with a newer SDK pin and a changed page permalink.
The PM's export still contains A's SDK pin and generated page URL.

| Value | PM proposal | Current repo R | Reviewed result |
|---|---|---|---|
| Selected upsell package (authored) | B | Original package | B, after PM confirmation |
| SDK pin (repo-derived) | Old pin from A | Newer pin | Newer pin |
| Page URL (repo-derived) | Old URL from A | New permalink | URL derived from the new permalink |
| Package price (API-owned) | Copied API value | Current API value | Current API value; selection does not change the price |

Start from R, change the selected package, and derive the repo-owned fields. Review
routing references and rebuild the affected upsell page. If the developer also
changed the selected package to C, record a conflict and obtain a choice before
merging. Do not apply B merely because the Map was saved later.

#### Map write-back and future portal saves

`spec derive --write-map` remains an explicit, pin-only action. A developer or
operator may request it when updating the Map's SDK hint is part of their task;
it is not a default SDK-bump or reconciliation step. It retains the existing
hash precondition and refusal to overwrite a newer Map pin. It does not mark a
PM proposal accepted or synchronize offers, routes or other authored content.
Store refresh through `--from-store` remains a separate authorized operator step.

A future Git-backed portal save can replace the manual transfer only when it
identifies the repository/spec and base revision, shows the authored diff,
preserves each field's authority, detects concurrent changes, and submits the
change through the same review process. It must show whether a change is merely
proposed, reviewed or used by a build. That is separate portal work; this
agreement does not enable portal writes.

### Deriving the spec from the repo (`spec derive`)

Every CampaignSpec field has a class: **authored** (a human writes it: offers,
funnel shape, copy intent), **mirrored** (pulled from the Campaigns API or the
store: packages, prices, shipping) or **derived** (the repo or the store
already states it: the SDK pin, page routes, the store profile, analytics
ids). The table is on #432. Derived fields are generated, never typed, and
this command generates the repo-derived ones so doctor compares generated
against generated instead of refereeing a hand-typed value against the repo:

```bash
campaigns-os spec derive --packet campaign-runtime.build.json [--dry-run] [--json] [--report <json>] [--from-store <subdomain> [--store-token-source env:<VAR>]] [--write-map] [--proxy-base <url>]
```

By default it reads the target repo only (no network unless `--from-store` or
`--write-map`, below) and writes into the packet's local spec (`spec.local_path`):

| Spec field | Repo authority |
|---|---|
| `global_config.sdk_version`, and `runtime.sdk_version` when the spec declares the alias (so the two never conflict) | `_data/campaigns.json[public_route_slug].sdk_version` |
| `funnels[].pages[].page_url` (the legacy `funnel_pages[].page_url` mirror, when present, is reconciled to the same route on every run) | the page tree under `assembly.output_dir` (default `src/<public_route_slug>/`), read by page-kit's own rule: the file's basename alone (`checkout.html` → `checkout/` wherever it sits; `index.html` → the entry route; a nested `index.html` collides with the root and is not read), or a frontmatter `permalink` in the `/<slug>/<route>/` form prepare-build writes (page-kit serves a permalink verbatim, so any other spelling is a repo defect, refused) |
| `analytics.providers.gtm.containerId` | `_data/campaigns.json[public_route_slug].gtm_id` |
| `analytics.providers.facebook.pixelId` | `_data/campaigns.json[public_route_slug].fb_pixel_id` |

Nothing else is written: not the store profile (store-derived; see
`--from-store` below), not any authored or mirrored field, not the packet,
not the repo. A
derived field the spec carries with a different, authored-looking value is
overwritten, and the printed `before -> after` line shows it: that is the
class doing its job. A block the spec lacks is created (`global_config`,
`analytics.providers.gtm` as `{ "enabled": true, "containerId": … }`); an
array element is never invented.

Each page is bound to one file: the packet's own projection first
(`source_html.pages[].page_kit.target_path`, the file the build stage wrote
for that page id), else a file whose route equals the page's current route,
whose terminal segment equals it, or whose filename is the page id. The
derived route is compared the way prepare-build projects a route
(normalized, slug prefix stripped), so a spelling that already resolves to
the tree's route (`checkout`, `/<slug>/checkout/`) is not a change, and a
value nested differently from the tree (`offers/upsell/` against
`upsell.html`) is. A routing hint in `sdk_hints.meta_tags` (`next-success-url`,
`next-upsell-accept-url`, `next-upsell-decline-url`) that no longer matches
the derived route of the page it names is reported as
`spec.derive.routing_hint_stale` on every run until the Map is re-saved;
hints are a Map projection the editor regenerates and are not rewritten.

What the repo cannot state is reported as `not_derived[]` with a reason and
the status is `partial` (exit 0; the fields it could derive are written):

| Reason | Meaning |
|---|---|
| `scaffold_seed` | the entry still carries the starter demo store profile, so its pin is the starter's seed, not a version anyone chose; `page-kit sync` seeds the pin from the spec in that state |
| `target_missing`, `target_invalid` | the entry has no `sdk_version`, or it is not a released `MAJOR.MINOR.PATCH`; for an analytics id, the value is not a GTM container id / a digits-only pixel id; for a route, the file's permalink is not in the `/<slug>/<route>/` form (no slug prefix, another prefix, `.html`, `..`, a control character), reported with the URL page-kit would serve |
| `waived` | an active named-human `page_kit.sdk_version` waiver covers the exact pair; derive leaves the spec as the waiver accepted it |
| `spec_ahead` | a released pin the spec declares (canonical or alias) is ahead of the repo pin: the state doctor blocks on with `page-kit sync` as its repair (#413); one command owns it, so derive never moves a spec pin backwards |
| `page_tree_missing`, `page_file_not_found`, `page_file_ambiguous` | no page tree, no file binds to the page, or more than one does |
| `entry_route_undeclared` | the page binds to the top-level `index.html` (the entry route, `""`) but is not flagged `is_entry`; doctor honours an empty `page_url` only on the entry page, so the flag is asked for in the Map rather than the route written |
| `waivers_unknown` | the Assembly Report could not be read, so a named-human `page_kit.sdk_version` waiver cannot be ruled out; the pin waits, routes and ids still derive |
| `page_id_duplicate` | the page id appears more than once; no single route can be derived for it |
| `spec_container_invalid` | `global_config`, `runtime`, `analytics`, `analytics.providers` or `analytics.providers.<provider>` exists in the spec but is not an object; reported by the plan so `--dry-run` and the write agree |
| `target_empty` | the entry's `gtm_id` / `fb_pixel_id` is empty while the spec declares an id; an empty repo value never deletes a spec id |

A placeholder id (`GTM-XXXXXXX`, a run of one digit) is `target_invalid`:
writing it would declare an analytics contract QA then blocks on. A derived
field the entry does not carry at all is listed under `not_in_target[]` and
left as it is.

`spec derive` writes the spec alone and no longer rebinds identity: the
Build Context's `spec.hash` / `spec.material_hash` and the Assembly Report's
`identity.spec_hash` / `identity.spec_material_hash` keep the spec they were
bound to, so every build, Polish and QA record made against the earlier
content reads owed again. Run `record spec` after it (the result's `next`
names it) to bind the derived spec; QA's verdict and `bundle check` correlate
against the bound material hash. A derived route change also warns
`spec.derive.projection_stale`: the packet's page-kit projection
(`source_html.pages[].page_kit`) and the Build Context page map were prepared
from the old routes, and `prepare-build` (or `start`) regenerates them. A
provider block derive creates warns `spec.derive.analytics_block_created`:
the spec then declares an analytics contract QA gates on. `--dry-run` carries
the same `file_reformatted`, `projection_stale` and `build_stale` warnings,
phrased as what a write would do.

Write discipline is `page-kit sync`'s: one read serves the plan and the
write; the file is edited in place and re-serialized with its own top-level
indentation, line ending and trailing newline (`spec.derive.file_reformatted`
when that round trip would not reproduce the file byte for byte); staged
through a temp file created with the spec's own mode bits and renamed over it,
after re-reading the spec and refusing (`spec.derive.spec_changed_underneath`,
exit 2) when it changed since the single read; written only at the path
the spec resolves to, which must lie inside the spec's own directory or the
target repo (`spec.derive.spec_escapes_boundary` otherwise, so a symlinked
`spec.local_path` cannot redirect the write); the retained doctor sidecar is
marked stale after a write, and a terminal build gets a
`spec.derive.build_stale` warning naming `record spec`, after which `next`
routes back to the build. `--dry-run` prints the
same diff and writes nothing; unknown flags and a valued `--dry-run` are
rejected. Exit 2 with `spec.derive.*` error codes and nothing written when the
packet cannot be read, `spec.local_path` is absent or not a file, the spec is
not a JSON object, the spec identifies another campaign
(`spec.derive.spec_identity_mismatch`), or the target entry is missing
(`spec.derive.entry_missing`; scaffold first).

#### Deriving the store profile from the store (`--from-store`)

The nine `campaign.store_*` Store Profile fields are derived too, and their
authority is the store: `page-kit sync` writes them spec → repo, and this is
the generator for the store → spec half. It needs a credential and the
network, which the default run never touches, so it is opt-in:

```bash
campaigns-os spec derive --packet campaign-runtime.build.json --from-store <subdomain> [--store-token-source env:<VAR>] [--dry-run] [--json]
```

`<subdomain>` is the store's `<store>.29next.store` subdomain. In the
1.38.0 candidate, the default read uses gateway credentials saved by
`campaigns-os login --store <subdomain>`, through
`https://mcp.nextcommerce.com/admin/`. This is an admitted owned-store
private pilot, not general merchant availability. Missing, expired or uncertain
credentials require login; gateway failure never falls back to an environment
token. See [gateway login and migration](gateway-login.md).

**Migration for existing direct callers:** add
`--store-token-source env:<VAR>` explicitly, naming your existing environment
variable (for example `EXAMPLE_ADMIN_TOKEN`). The former implicit
`<SUBDOMAIN>_ADMIN_TOKEN` lookup is removed. This break-glass path warns that it
bypasses gateway custody and contacts
`https://<subdomain>.29next.store/api/admin/` directly. A `store:read` and
`content:read` Admin token is sufficient. Tokens are never CLI arguments or
output; invalid bearer values are refused unsent. Both paths only read the store.
Gateway page pagination is consolidated by custody into a bounded list; the CLI
does not follow an upstream cursor on this path. The explicit direct path keeps
its existing bounded cursor traversal.

| Spec field | Store authority |
|---|---|
| `campaign.store_name` | `GET /store/` `name` (Admin API version `2024-04-01`) |
| `campaign.store_url` | `GET /store/` `primary_domain`, as `https://<primary_domain>` |
| `campaign.store_phone` | `GET /store/` `contact_address.phone_number`, verbatim |
| `campaign.store_phone_tel` | the same phone as a `tel:` URI (digits, a leading `+` kept), only when the display phone is one plain number: an extension, a second number or a vanity word would fold into the digits and dial something else, so those leave the field not derived (`target_invalid`) |
| `campaign.store_terms`, `store_privacy`, `store_contact`, `store_returns`, `store_shipping` | `GET /pages/` (Admin API version `unstable`, followed cursor by cursor under the store's own pages endpoint): the one storefront page that carries the policy, as `https://<primary_domain>/<slug>/`, which is where the storefront serves it. A page whose slug is one of the policy's conventional slugs (`terms`, `terms-of-service`, `privacy-policy`, `contact-us`, `return-policy`, `shipping-policy`, `shipping-returns`, …) binds first; only when no page has a conventional slug does the wider match by slug or title words apply (terms/tos/conditions; privacy; contact; return(s)/refund(s); shipping/delivery), so a "free shipping" promo page never outranks the policy. One page may carry two policies (`shipping-returns`) |

Rows join the same `before -> after` diff in the Store Profile's field
order, each with its store source, and are compared NFC-normalized and
trimmed as `page-kit sync` compares them, plus one leniency of derive's own:
URL fields compare without a trailing slash, so a spec that carries
`https://x.example/` is left alone when the store says `https://x.example`
rather than churned (sync then writes the spec's spelling into the repo as
it is). Every value
passes the Store Profile shape rule before it is planned: the starter demo
store's URL or phone, a non-http(s) URL, a malformed `tel:` or a control
character is `target_invalid`, never written. A field the store cannot state
is `not_derived[]` and **the spec's value is left as it is** (a store never
empties a spec field): `store_field_missing` (an empty name, domain or
phone), `store_domain_missing` (no primary domain, so no page URL can be
formed), `store_page_not_found`, `store_page_ambiguous` (several pages read
as the policy; the slugs are named), `store_pages_unavailable` (the pages
endpoint failed, with the reason: a token without `content:read`, a version
that does not serve `/pages/`, a body that is not the page list, a cursor
outside the store's pages endpoint that was not followed) and
`store_pages_truncated` (more pages than ten requests or two thousand rows
return). A slug that is not one honest path segment (a separator, `.` or
`..`, malformed text) is `target_invalid`. When the store's primary domain is not the host the spec's
`store_url` named, `spec.derive.store_domain_changed` says so: either the
spec was stale and the diff is the correction, or `--from-store` names
another merchant's store and the spec should be restored.

The result carries a `store` block (gateway reads add `transport: "gateway"`
and the actual gateway `endpoint`; `admin_api` remains the logical upstream
source), with `subdomain`, `admin_api`,
`token_source`, `store_read`, `pages_read`, `primary_domain`, and the text
output a `Store:` line. After a write that moved a store field, `next` is
`page-kit sync` first (doctor's `page_kit.store_profile` gate now sees the
spec ahead of the repo and names sync as its repair), then doctor. A store
that cannot be read is a refusal with nothing written, repo fields included,
exit 2: `spec.derive.store_credential_missing` (no gateway login, or the explicitly
selected variable is unset or empty), `store_credential_unavailable` (local
storage is busy or unavailable), `store_unauthorized` (401/403), `store_not_found` (404: no store at
that subdomain), `store_unreachable` (transport, timeout, 5xx) or
`store_response_invalid`. Local preconditions (packet, spec, target entry, spec boundary, page tree)
are checked before the store is contacted, and a packet that names another
spec or route by the time the read returns is refused
(`spec.derive.packet_changed_underneath`). `--store-token-source` without
`--from-store`, a subdomain that is not one (a URL, a path), or a token
source that is not `env:<VAR>` is rejected before anything is read.

#### Recording the pin in the Map (`--write-map`)

The local derive fixes the exported spec; the Map itself still shows the old
pin until someone re-saves Build hints, so anyone opening the Map or a fresh
export reads stale. `--write-map` closes that half (#415): after the local
write, the pin the plan derived is recorded into the saved Map's Build hints
field (Campaign Cart SDK version) through the proxy Worker, with the same
direction of authority as everything else on this gate: the write goes
forward or not at all.

```bash
campaigns-os spec derive --packet campaign-runtime.build.json --write-map [--dry-run] [--proxy-base <url>]
```

The Map named by the packet's `spec.map_id` is read back (`GET
/api/spec/<map-id>`) and re-stated with exactly the pin fields moved
(`global_config.sdk_version`, and `runtime.sdk_version` only when the Map
already declares the alias): every other field is the Map's own read-back,
never the local spec, so an authored field is not rewritten from a local copy
and the routes or analytics ids derive wrote locally do not travel. The `PUT
/api/maps/<map-id>` carries the packet's Campaigns API key as
`X-Campaign-Key` (the receiver refuses a key that is not the Map's; the key
is the public-by-design one the packet, its local spec or the declared env
source already holds) and the Map's `spec_hash` as `X-Spec-Hash`, so a save
that landed in between is a conflict, not an overwrite. The proxy base is the
canonical `https://campaign-map.nextcommerce.com` unless `--proxy-base` names
another; it must be https, or a loopback host over http (allowed for a local
receiver, with a stderr warning that the key travels in clear).

The decision, reported on the result's `map` object and as one text line:

| `map.status` | Meaning |
|---|---|
| `written` | the Map declared no pin, or one behind the repo pin; it now records the repo pin (`map.spec_identity.before` / `.after` carry the Map's `spec_hash` and `saved_at` either side) |
| `unchanged` | the Map already records the repo pin; nothing sent |
| `would_write` | `--dry-run`: the Map was read and the write previewed; nothing sent |
| `refused` | a warning, exit 0, the local derive stands: `ahead` (the Map pin is newer than the repo pin — a bump the repo never received, doctor's blocked state and `page-kit sync`'s repair; the Map is never moved backwards) or `pin_unreadable` (the Map's pin is not a released version, or two declarations disagree; a value the rule cannot order is not overwritten silently) |
| `skipped` | the pin was not derived (`pin_<reason>`, the `not_derived` reason: a scaffold's seed, a waiver, `spec_ahead`, …) or the local derive was blocked; nothing was read or sent |
| `failed` | an error, exit 2, the local derive stands: `key_missing` (no Campaigns API key anywhere), `key_mismatch` (403), `not_found` (404), `changed_underneath` (409: derive again against the current save), `rejected` (the proxy's spec validation refused the re-stated Map: re-save it in the builder first), `proxy_base_insecure`, `network_error`, `http_error`, `response_invalid` (an answer that says neither yes nor no: read the Map back before deriving again) |

A write is traceable from the campaign's own record: one line is appended to
the Assembly Report's `evidence[]` (`Map write-back: global_config.sdk_version
<before> -> <after> on Map <id> at <time> via spec derive --write-map (Map
spec_hash <before> -> <after>)`), the retained doctor sidecar is marked stale
by `spec derive --write-map`, and the run's lifecycle journal carries the
command with its argv shape, so the Run Record (which references the report by
hash) shows both that the write ran and what it changed. A report that does
not exist yet (a derive before `prepare-build`) leaves a
`spec.derive.map_not_recorded` warning carrying the same line; a report that
took the line while the doctor stamp failed leaves
`spec.derive.map_doctor_sidecar_not_marked` instead, and one that could not be
read back after the failure leaves `spec.derive.map_recorded_status_unknown`
(`map.recorded: "unknown"`) rather than a claim either way. A 403 on the read
is `key_mismatch`, as on the write. Without
`--write-map` nothing is read from or sent to the Map; `--proxy-base` is
refused on its own.

### Polish hidden eager-media checkpoint

The third registered checkpoint is package-owned page-load evidence recorded at
`stages.polish.evidence.visual_review.page_load`. Install the package-owned
browser, serve the current build, and run this producer before marking Polish
complete, deploying, or starting QA:

```bash
npm run qa:install-browser
campaigns-os polish capture \
  --packet campaign-runtime.build.json \
  --base-url <served-current-build-url>
```

The producer derives every mapped, non-skipped route from the packet and
captures desktop `1440x1200` and mobile `390x844`. It blocks when a
computed-hidden `video` or `audio` element transfers strictly more than
`1,048,576` bytes, unless its content attribute is exactly
ASCII-case-insensitive `none` or `metadata`. Evidence exactly at the byte
threshold passes. The command owns the versioned capture format and its
integrity binding; never hand-author or copy `page_load`.

The operator supplies the URL of the current served output. The evidence binds
to packet/report authority, but the URL itself is not cryptographic proof that
the server is hosting those exact build bytes. The durable field map, bounded
measurement semantics, and attachment race boundary are documented in
[Polish evidence](./polish-evidence.md#durable-page_load-field-map).

Missing, malformed, stale, incomplete, or contradictory measurement evidence
is nonwaivable. A complete real finding may receive an exact named-human
decision:

```bash
campaigns-os checkpoint waive \
  --packet campaign-runtime.build.json \
  --gate polish.hidden_eager_media \
  --reason "<why this exact finding is accepted>" \
  --waived-by "<named human>" \
  --review-condition "<specific re-evaluation trigger>"
```

The decision binds the build fingerprint, campaign slug, route scope, routes,
fixed viewports, and stable finding state. Any change makes it inert. Doctor and
`next` report `ready_with_waivers`; QA reports `ready_with_exceptions` and keeps
the warning visible.

QA evaluates all three registered gates from one packet/spec/target/report
snapshot; a waiver for one never hides a blocker in another. See
[QA checkpoint preflight](./qa-and-test-orders.md#packet-local-checkpoint-preflight)
for the downstream runtime boundary.

Every gate that still owes work carries `required_actions[]` — the exact repair
command or manual step, plus the waiver command. `campaigns-os doctor` prints
the same actions in its text report, under a `Required actions:` block below the
errors and warnings, so an operator reading stdout gets the remediation without
re-running with `--json`.

### Built-output campaign identity gate (`built_output.campaign_identity`)

Every doctor run that sees built output (the packet path and `doctor --built`
alike) checks that the pages agree about which campaign they belong to. The
SDK reads three identity signals per page and reconciles nothing across
pages: the API key (`<meta name="next-api-key">` beats `window.nextConfig.apiKey`,
whether inline or in the `config.js` the page loads), the `next-funnel` meta,
and any `setAttribution({ funnel })` call. A page copied from another funnel
that still carries the other campaign's key, tag, or attribution call binds,
builds, and renders without complaint, and creates or attributes the order
against the wrong campaign. It has shipped twice.

The gate blocks (not waivable — two identities on one funnel cannot both be
intended) when:

- any two observed API keys differ, from any source on any page, including a
  page whose meta names one key while its `config.js` names another
  (`built_output.campaign_identity.api_key_drift`);
- `next-funnel` differs across pages (`…funnel_drift`), or, once any page
  carries the tag, a page that declares `next-page-type` has no `next-funnel`
  (`…funnel_missing`; a campaign that tags no page at all is consistent, and
  the platform fills the campaign name when the tag is absent);
- a `setAttribution({ funnel })` string disagrees with the `next-funnel` of the
  page that calls it, or with the campaign's tag when that page has none
  (`…attribution_drift`).

One error per finding; each names the two files and the two values, so the
repair is a one-line edit. Every built HTML file under `_site/<slug>/` is
scanned, because every one is served. When doctor has the CampaignSpec, a
finding that names a file no active spec page builds to says so and lists it
under `stray_files`. Such a file is leftover output (page-kit does not prune
`_site/`) or an HTML file copied into the source, such as a design export's
`index.html` under `assets/`. The repair is to remove the source file if
there is one, delete the built file, and rebuild and record the build again,
not to retag it. Pages whose route contains a `-backup-` or `-old-`
segment are parked copies: skipped and listed on the gate as `pages_skipped`,
never scanned. Presence is not asserted: a campaign whose pages carry no key
at all, or no `setAttribution` anywhere, passes on the funnel tag alone.
`checkpoint waive` does not register this gate; the repair is the only route.

The gate's evidence lands beside the other checkpoint gates at
`derived.checkpoint_gates[]` (`id: built_output.campaign_identity`, status
`pass` | `blocked` | `not_applicable`, `identity: { api_key, api_key_source,
funnel }`, `findings[]`, `pages_scanned`, `pages_skipped`). It is proven to
pass on the canonical rendered output of every certified starter family
(`fixtures/certified-families/`), the reachability bar every static
built-output gate now carries.

### Built-output SDK markup gate (`built_output.sdk_markup`)

Every doctor run that sees built output also runs the static SDK markup
family: seven shapes of `data-next-*` markup that the Campaign Cart SDK binds
without complaint and that then either do nothing (a field that never reaches
the order, a button that never enables) or write the cart twice. They sit
beside `built_output.upsell_selector_scope`, which is the same kind of check
for one shape. The first six codes are the ones a partner Campaign Cart kit
used, kept so the two vocabularies line up; each doctor issue is
`built_output.sdk_markup.` plus the code lower-cased, and its message leads
with the code.

Blockers (not waivable — the markup provably does not do what it says):

- `SWAP_WITH_ADD_TO_CART` — a bundle selector in swap mode (explicit
  `data-next-selection-mode="swap"`, or the SDK default when the attribute is
  absent) with an `add-to-cart` button linked to it by `data-next-selector-id`.
  Both write the cart. An upsell-context selector is exempt: it is select mode
  by construction.
- `CHECKOUT_NOT_FORM` — `data-next-checkout` on an element that is not `<form>`.
- `WRONG_FIELD_NAME` — `data-next-checkout-field` with a value the SDK does not
  map. The set is vendored from the SDK at a named tag
  (`src/sdk-attribute-index.mjs`, currently v0.4.41: `email`, `fname`, `lname`,
  `phone`, `address1`, `address2`, `city`, `province`, `postal`, `country`,
  `payment-method`, `accepts_marketing`, `cc-number`, `cc-month`, `cc-year`,
  `exp-month`, `exp-year`, `cvv`, the legacy `card-*` spellings, and any
  `billing-` prefixed name). The message names the SDK spelling for the usual
  offenders (`firstName` → `fname`, `zip` → `postal`). Three names depend on
  the page's SDK version: `first_name` and `last_name` are mapped from v0.4.39
  and `phone_number` from v0.4.41. The version is the page's own exact loader
  pin, else the campaign's `sdk_version` in `_data/campaigns.json`. Below the
  name's version, or when neither gives an exact released version, the name
  blocks, and the message names `fname`, `lname` or `phone`, which every
  version maps. Each finding carries `sdk_version` and `sdk_version_source`
  (`loader` or `campaigns_json`) in its detail.
- `MISSING_SELECTOR_ID_MATCH` — an `add-to-cart` button whose
  `data-next-selector-id` names no selector on the page (an element that is a
  bundle, package, cart or upsell selector; another element echoing the id
  does not count). One finding per dead id, however many buttons link to it.
- `ORPHANED_UPSELL_ACTION` — an element carrying `data-next-upsell-action` with
  no ancestor carrying `data-next-upsell`. The SDK binds upsell actions only
  inside that container, so a "No thanks" link placed beside the offer
  container, not inside it, goes nowhere and the shopper cannot decline.
  Checked on every page type, not only upsell and downsell pages. Move the
  element inside its `data-next-upsell` container.

Warnings (advisory):

- `DOUBLE_SELECTED` — more than one `data-next-selected="true"` card inside one
  selector.
- `TEMPLATE_DOUBLE_BRACE` — `{{` inside an SDK-owned `<template>`: the direct
  child of a container the SDK clones from (`data-next-cart-summary`,
  `data-summary-lines`, `data-next-discounts`, `data-next-bundle-selector`,
  `data-next-bundle-slots`, `data-next-package-selector`,
  `data-next-package-toggle`), or one a `*-template-id` attribute points at.
  SDK tokens are single-brace; a template nothing in the SDK reads, including
  a vendor template nested deeper inside SDK chrome, may use any syntax.

Information: `data-next-*` names the vendored attribute index does not list are
collected on the gate (`unknown_attributes[]`) and printed as one advisory ready
line, never as a warning. That is where an invented attribute such as
`data-next-coupon-input` shows up; it is information rather than a warning
because the certified templates carry a handful of their own `data-next-*`
hooks the SDK never reads.

Markup inside SDK templates is scanned too, since the SDK clones it into the
live DOM. A gate reports one disposition: while blockers stand, advisories
stay on the gate's `warned[]` and become doctor warnings only once the
blockers clear; the gate `reason` names the first five findings and a count. The gate's evidence lands beside the other checkpoint gates at
`derived.checkpoint_gates[]` (`id: built_output.sdk_markup`, status `pass` |
`blocked` | `not_applicable`, `findings[]` for blockers, `warned[]` for
advisories, `unknown_attributes[]`, `pages_scanned`,
`sdk_attribute_index_version`). Fixtures: `fixtures/sdk-markup/<code>/{bad,good}`.
It passes, with no advisory, on the canonical rendered output of every
certified starter family (`fixtures/certified-families/`).

### Built-output script syntax gate (`built_output.script_syntax`)

Every doctor run that sees built output (the packet path and `doctor --built`
alike) parses each campaign-owned `.js` file a built page loads by a local
`<script src>`. A script that does not parse throws a `SyntaxError` on every
load of every page that references it, and nothing it defines runs; every
HTML-reading gate passes over it. The shape that shipped was a template-family
checkout script, copied and hand-edited, left with one closing `});` too many.

Parsing uses Acorn at the latest `ecmaVersion`: `sourceType: 'script'` for
classic scripts and `'module'` for `type="module"`, which is how the browser
reads each. Remote scripts (an `http(s):` URL, a protocol-relative `//` URL,
`data:`) are not campaign-owned and are not read, and neither are data blocks
such as JSON-LD. The type is compared as the browser compares it, with
surrounding ASCII whitespace stripped and case ignored. A classic `nomodule`
script is skipped: a module-capable browser never fetches or runs it. A
`type="module"` script ignores `nomodule` and is still parsed. Each src
resolves the way the browser resolves it: against the base in effect when the
parser prepares the script at its end tag, which is the first HTML `<base
href>` in tree order among those already parsed, or else the page. A `<base>`
parsed after a script does not move it, whether it is async, deferred or a
module: its URL is fixed when it is prepared, not when it is fetched. Parse
order decides, not final tree position, so a base that table foster parenting
moves ahead of an earlier script still does not apply to it. A `base` inside
SVG or MathML is not a base element, and only HTML-namespace `<script>`
elements are read: an SVG `<script>` never loads a `src` attribute. The href is read as the URL parser reads
it: only leading and trailing ASCII control characters and spaces are
stripped. A base
the browser refuses (one that does not parse, or a `data:` or `javascript:`
URL) falls back to the page, as the HTML "set the frozen base URL" steps
require. The percent-decoded path maps under the site root first, then the
campaign directory, never outside either. A base on another origin makes
relative srcs remote. Imports inside a module are not followed.

A parse failure blocks (not waivable — a script that cannot be parsed cannot be
intended to ship) under `built_output.script_syntax.parse_failure`, one error
per file. The message leads with `<file>:<line>:<column>` and a fixed
diagnostic category (for example `Unexpected token` or `Invalid regular
expression`), never text from the script, and names the pages that load the
file. A referenced local script that is not in the built output is a warning,
not a blocker, under `built_output.script_syntax.missing_script`, one warning
per src naming the pages that load it: the browser gets a 404 for it and
nothing it would define runs, but whether the page needs it is not known here.
Missing scripts are grouped by the URL the browser resolves, not the raw src,
so `check&#9;out.js` and `checkout.js` (the URL parser removes the tab) are one
warning; the src shown is the first spelling met.
The src is also listed in `scripts_unresolved[]`. While a parse failure blocks
the gate, the missing scripts stay on the gate's `warned[]` rather than also
surfacing as warnings.

A `<script>` the page ends inside, with no `</script>` before end of file, is
not parsed: the browser never runs a script element whose end tag never
arrives. Doctor warns about it under `built_output.script_syntax.unclosed_script`,
one warning per page, because a page that ends mid-script is usually truncated
output. QA neither fetches nor parses such a script.

**Symlinks under `_site`.** A script that is a symlink, or sits under a
symlinked directory, is read the way a static server serves it, by following
the link, as long as its real path stays inside the site root (`_site/`). A
parse failure in it is reported under the path the page loads. A script whose
real path resolves outside the site root is not read. Doctor warns, and does
not block, under `built_output.script_syntax.symlink_outside_site`, naming the
link (never its target) and saying the target is outside the site root. The
link is listed in `scripts_outside_site[]` with `file`, `src` and `pages`, not
in `scripts_unresolved[]`.

The gate's evidence lands beside the other checkpoint gates at
`derived.checkpoint_gates[]` (`id: built_output.script_syntax`, status `pass` |
`blocked` | `not_applicable`, `findings[]` with `file`, `line`, `column`,
`source_type` and `pages`, `warned[]` with `code`, `src` and `pages` (and
`file` for a symlink outside the site root), `scripts_scanned`,
`scripts_unresolved[]`, `scripts_outside_site[]`, `pages_scanned`). Fixtures: `fixtures/script-syntax/{good,bad}`. It passes, parsing every
local script the pages load and with no missing-script warning, on the
canonical rendered output of every certified starter family
(`fixtures/certified-families/`). QA applies the same rule to the page scripts
it reads for credential declarations (`script-parse:<page_id>`; see
[QA and test orders](qa-and-test-orders.md)).

### Built-output cart placeholder check (`built_output.cart_placeholders`)

**Raw cart placeholders (`built_output.cart_placeholders`).** Doctor warns when a known SDK placeholder, such as `{item.name}`, `{subtotal}` or `{package.name}`, appears in live built HTML text or in a text attribute (`alt`, `title`, `placeholder`, `aria-label`, button `value`), where it prints as raw text. Placeholders inside `<template>`, inside `data-next-cart-items`/`data-next-order-items` rows and their declared row templates, and SDK-substituted quantity text are expected. Brace strings that are not known SDK placeholders, including `{tax}`, are review results. The placeholder list is vendored from the SDK version pinned in `src/sdk-attribute-index.mjs`. Pages whose SDK loader does not name an exact version, or names a version the list was not verified against, are reported as unexercised rather than passing. These are warnings, never blockers.

### Built-output smoke checks (`built_output.smoke_qc`)

**Smoke checks (`built_output.smoke_qc`).** Doctor warns on built pages that have:

- an in-page `#link` with no matching `id` or `name` on the same page;
- no favicon link;
- no `og:title`, `og:description` or `og:image`;
- an `og:image` that is relative or points to a missing file;
- the Tailwind CDN script in a production build;
- references to the `cdn.29next.store` asset host in any attribute or `<style>` block (use `cdn.cachebucket.com`);
- `localhost` or loopback URLs in a production build.

Targets inside `<template>` or named in page scripts are review results, and pages whose scripts could not all be read are unexercised. Remote `og:image` URLs are not fetched by doctor. The Tailwind and loopback checks need a recorded production build: development builds (including local proof) and `doctor --built`, which cannot tell the environment, report them as unexercised. All are warnings, never blockers.

> **Where does the source HTML come from?** See [docs/entry-points.md](./entry-points.md) for the five recognized entry points (template-stock, Figma-driven, AI-generated, hand-authored, mixed) and how each populates `source_html.pages[]` + `design_source`.

## Artifact Locations

By default `campaigns-os start` writes into the target repo:

```text
campaign-runtime.build.json
.campaign-runtime/build-context.json
.campaign-runtime/assembly-report.json
.campaign-runtime/doctor-output.json
.campaign-runtime/theme/theme-report.json
.campaign-runtime/input/campaign-build-brief.normalized.json
.campaign-runtime/input/design-source-package.json
```

Those `.campaign-runtime/` paths are relative to the target repo
(`packet.assembly.target_repo`, resolved against the packet's directory) even
when `--out` keeps the packet somewhere else, and every stage — `doctor`
included — reads and writes them there. When `prepare-build --report-out`
puts the Assembly Report elsewhere, the Build Context records that path
(`report_path`, relative to the target repo) and `doctor`, `next`, `qa run`,
`qa waive` and the QA stage record follow it, so the report `next` reads is the
one QA writes into — provided the context's `packet_path` names that packet;
a context naming another packet binds nothing. `theme waive`, `checkpoint
waive`, `polish capture`,
`findings harvest`, `run-record` and `run status` act on the default location
unless `--report` names another. `run-record` keys its record on a `run_id`
resolved as `--run-id`, else the active run session, else the most recent Run
Record already on disk for this packet's campaign (re-emitted in place), else
a freshly minted id; `--new-run` mints on request and `--list` prints the ids
on disk without writing (see docs/workflow-findings-sidecar.md).

The packet's top-level `generated_at` (ISO-8601 UTC, `Z` suffix) is stamped by
`prepare-build` on every new packet. Downstream freshness — campaigns-agent's
readback staleness comparison and its multi-packet selection at the repository
root — reads this field, never file mtime. Packets generated before the field
existed remain schema-valid without it, but they cannot win freshness selection
and never satisfy a fresh-artifact readback on their own; regenerate rather
than hand-adding the field. Note that a committed artifact set always reads
stale to the readback once HEAD moves past it — freshness proof is a
regeneration at HEAD, not a property a commit can preserve.

Commit durable packet/context/report artifacts when they represent a real build handoff. The rest of `.campaign-runtime/` is machine-local and is not for the campaign repository: `run-session.json`, `command-lifecycle.jsonl`, `agent-deviations.jsonl`, `workflow-findings.jsonl`, `run-records/`, `fetched-specs/`, `polish-evidence/`, `evidence/`, and `*.log`/`*.tmp` are per-machine, append-only, or carry live URLs and absolute paths, and so are the full QA verdicts `qa run` writes under the target's `qa-output/`. `start`, `prepare-build`, `install-agent-context`, and `run start` write a managed ignore block for exactly that set into the target's `.gitignore` once (keyed on its marker line; edit the list beneath it freely). The readback bundle (`build-context.json`, `assembly-report.json`, `doctor-output.json`, `qa-verdict.json`), `input/`, `theme/`, `agent-context/`, and `setup-handoff.json` are deliberately not ignored. The Campaigns API key is a public, browser-side, domain-allowlisted key and may already be present in the local CampaignSpec as `campaign.campaigns_api_key`; do not duplicate it into the packet unless the spec is unavailable. Do not commit raw private API responses, backend secrets, or temporary media exports.

Packet-mode `doctor` is inspection-only by default and preserves retained evidence and active run journals, even when lifecycle capture is configured. Use `--write` to intentionally record fresh evidence; `--no-write` takes precedence. Inspection still reports current blockers and keeps the same exit status.

`campaigns-os doctor --packet <packet> --write` restates its outcome on the Assembly Report's `stages.doctor` (status, command, outputs, blockers, warnings, `checked_at`). A re-run that reaches the same outcome leaves the report's bytes unchanged rather than refreshing the timestamp alone, so a digest taken of the report — a Run Record's `assembly_report` sha256 — keeps verifying across repeated doctor runs; a changed outcome still rewrites the file.

`campaigns-os start` / `campaigns-os prepare-build` writes packet, context, report, and generated doctor-output paths as relative paths by default, including sibling CampaignSpec/source directories such as `../campaign-source`. `campaigns-os doctor` continues to accept older absolute-path packets; use `campaigns-os doctor --packet <packet> --write --strip-paths` when regenerating a commit-ready doctor output from an older packet. Committed handoff artifacts should not contain machine-local absolute paths unless no relative form is possible.

`start` / `prepare-build` also run the [Brand Theme Bridge](./brand-theme-bridge.md)
in `inspect_only` mode. The optional theme evidence lives in `context.theme`,
`report.theme`, and `.campaign-runtime/theme/theme-report.json`. The Build
Packet itself does not gain required theme fields in v0.

A campaign whose source carries no brand tokens has one more decision to make,
and it is due before QA rather than after it. With nothing to generate, the
theme gate passes (`theme_gate.nothing_generatable`) and no brand layer is
applied, so the commerce pages ship the starter family's own palette — and
browser QA, with the gate unwaived, runs the template-residue checks at blocker
severity, so `qa run` blocks on `template-residue:<page>:style:*` rows for the
starter call-to-action colour. That is deliberate on both sides: a passing gate
means "nothing could be generated", not "this palette was reviewed". Two lanes
clear it, and `campaigns-os next` names them from the build stage onward so the
choice is made before a blocked verdict forces it — for the families this
applies to. Palette residue is a certified-family check: it runs only where the
selected `template_family` has a brand contract listing both the starter colours
and the commerce selectors to inspect them on, so a `custom` or `undecided`
family produces no `template-residue:*:style:*` rows and `next` stays quiet
rather than asking for a waiver it does not need. Either record an explicit
operator waiver (`campaigns-os theme waive --packet <packet> --reason "<why the
starter palette is acceptable>" --waived-by "<named human>"`, optionally
`--expires-at <canonical ISO timestamp>`), which downgrades those rows to `warn`
(status and severity — never `fail`) and keeps the shipped palette visible in
the verdict; or hand-author the brand
layer — write `brand-theme.css`, list it after `next-core.css` in commerce-page
frontmatter styles, rebuild, `record build`, and `record theme`, which records
`report.theme.status: applied` with `load_order: after-next-core` from the
built pages. Nothing waives the gate on the operator's
behalf. See [Brand Theme Bridge](./brand-theme-bridge.md) for both lanes in
full.

`start` / `prepare-build` also accept `--brief <campaign-build-brief.yaml|json>`
and auto-discover `campaign-build-brief.yaml`, `.yml`, or `.json` from the
source root or target repo. When none is present, Campaigns OS creates a guided
draft at `.campaign-runtime/input/campaign-build-brief.normalized.json`.
A brief file is guided unless it sets `"brief_mode": "prepared"` (a campaign
whose Assembly Report already records a prepared brief stays prepared). Save
answers later with `record brief`, which keeps stage evidence unless the brief's
material content changes; a presentation change makes build, Polish and QA
owed again, and a `qa_policy` change makes QA alone owed again. See
[Campaign Build Brief](./campaign-build-brief.md) for the schema, the mode
rule and the stage map.

`start` / `prepare-build` also prepares the normalized Design Source Package at
`.campaign-runtime/input/design-source-package.json`. When that path is absent,
the command synthesizes and writes the package; when it exists, the command
validates it against the current campaign/page/source/template inputs and reuses
its exact bytes. It refuses stale or contradictory packages instead of silently
regenerating them. Its schema version is
`campaign-design-source-package/v0` (schema file:
`schemas/campaign-design-source-package.v0.schema.json`). The Build Packet,
Build Context, and Assembly Report reference that artifact by path, full artifact
hash, and material fingerprint instead of embedding it,
matching the normalized Build Brief handoff pattern. The full hash supports audit
and reproduction; the material fingerprint drives freshness gates. The package
includes a generated top-level `readiness` summary with
`status`, `blocking_reasons`, `gap_count`, `todo_count`, `waiver_count`, and
`generated_at`; detailed gaps, TODOs, and waivers remain authoritative.
See the dedicated [Design Source Package v0 guide](./design-source-package.md)
for the exact reference shape, material projection, emit/reuse/refusal boundary,
and lifecycle ownership contract. This section keeps the Build Packet handoff
context and does not replace that consumer guide.

`readiness.status` uses `pending`, `blocked`, `ready`, `ready_with_gaps`, or
`ready_with_waivers`, not `ready_with_warnings`. The package may include
free-form `notes`, but notes do not affect readiness; any concern that affects
whether Build or Polish can proceed must be typed as a gap, TODO, proposed
exception, or waiver. Source gaps and TODOs require `scope` and `applies_to`;
attach them to Surface Identity when possible. The package reserves a top-level
Surface Identity entry `campaign` with `kind: "campaign"`; use
`applies_to: ["campaign"]` for legitimate campaign-level gaps/TODOs. Surface
Identity IDs should be stable human-semantic strings such as `campaign`,
`landing`, `landing.hero`, `checkout`, `checkout.payment`, or
`upsell.offer-card`, with labels and aliases for source-specific, DOM, or Page
Kit names. v0 requires `campaign` plus page-level Surface Identities for active
or mapped CampaignSpec pages; section and runtime-surface IDs are optional until
Build or Polish needs them. Do not derive the primary Surface Identity solely
from CPK `page_type`, Map Builder custom labels, public routes, or producer page
types. Preserve those as mapped attributes or aliases alongside the Surface
Identity. For page-level IDs, prefer the CampaignSpec page ID when it is stable
and human-readable; otherwise derive from normalized page role plus order
(`landing`, `checkout`, `upsell-1`, `downsell-1`, `receipt`). Always preserve the
CampaignSpec page ID, Map Builder label/custom name, public route, source aliases,
and CPK `page_type` separately. `surface_identity[]` is a structured catalog,
not a simple list of strings. Minimum fields are `id`, `kind`, `label`,
`aliases`, and `mappings`; page-surface `mappings` preserve CampaignSpec page ID,
Map Builder label/custom name, public route, producer page type, and Page Kit
projection. Contribution mappings should reference `surface_identity[].id`
values and carry relationship metadata such as `coverage_role`, `confidence`,
`source_refs`, and `notes`. They should not define competing CampaignSpec route
or Page Kit projection maps. `coverage_role` is a small enum:
`primary_design`, `partial_design`, `brand_tokens`, `asset_source`,
`copy_source`, `template_baseline`, `reference_only`, or `fallback_legacy`;
use `notes` for unusual cases. Mapping `confidence` is also a coarse enum:
`high`, `medium`, `low`, or `unknown`. It describes confidence in the
surface/coverage mapping, not design quality or approval. Low confidence blocks
source readiness only when it affects required page-level `primary_design`
coverage; represent that as a Source TODO unless waived. Low confidence on
brand-token, reference-only, or other non-primary coverage does not by itself
block the v0 readiness evaluator; any gap or note is a separate explicit record.

Screenshot references in the Design Source Package are source-side or
reference-side proof only: canonical URLs, exports, captured source renders, or
explicit records that a render is unavailable. Built-output screenshots for the
current implementation belong in Polish Evidence or later QA evidence, tied to
the current build fingerprint. Polish should compare against Design Source
Package refs and Template Reference refs without mutating either source artifact.
If Polish can capture a missing canonical source render, it should emit a
proposed source-reference update or Source TODO rather than silently updating the
Design Source Package. Source preparation owns any package mutation and must
record it explicitly with attribution.
Material source-reference refreshes create a new Design Source Package
fingerprint. Any Build, Polish, or QA evidence tied to the previous source
fingerprint is stale until refreshed or explicitly waived. v0 determines
materiality through its explicit projection, not a marker in the package.
Top-level `generated_at`, generated readiness/readback, notes, visual
`captured_at` alone, formatting, key order, and normalized record/set order are
non-material; the exact artifact-byte hash still changes when their serialized
bytes change.
Polish Evidence must record both the current build fingerprint and the current
Design Source Package material fingerprint, conventionally as
`source_build_fingerprint` for the assembly/build artifact and
`source_package_material_fingerprint` for the design source context. Freshness
gates consider Polish current only when both match the latest artifacts;
if either changes materially, Polish is stale unless a structured waiver explains
the exception. During the v0 transition, the polish gate enforces
`source_package_material_fingerprint` only when the Assembly Report exposes a
current Design Source Package material fingerprint, such as
`design_source_package.material_fingerprint`. Legacy reports without a current
source package keep the build-fingerprint gate and emit a readiness warning
instead of blocking.

Build must also record the Design Source Package material fingerprint it
consumed on `stages.assembly.source_package_material_fingerprint`; Prepare does
not populate that consumption field. If the current
`design_source_package.material_fingerprint` is missing from Assembly or differs
from the Assembly-recorded value, `campaigns-os next` routes back to Build before
Polish. Polish must review a build made from the current material source context;
it should not repair or certify a build made from stale design inputs.

`stages.assembly.build_fingerprint` is the fingerprint of the built OUTPUT, not
of its inputs: it changes exactly when the bytes under `_site/<public_route_slug>/`
change, so a toolkit or template upgrade that renders different output from
identical source reads as a different build, and identical output on any machine
at any path yields the same value. The algorithm (`sha256-manifest/v1`): list every
file under the built route root, path relative to that root with `/` separators,
sorted by code point; for each file emit one `<path>\n<sha256-hex>\n` pair; the
fingerprint is `sha256:` plus the SHA-256 of that manifest. Nothing is excluded by
default (Page Kit writes only rendered HTML and copied assets into `_site/`, nothing
it timestamps); `.campaign-runtime/page-kit-build-summary.json` lives outside the
root and is not hashed. Build does not type the value: after page-kit build it runs
`campaigns-os record build --packet <packet>`, which stamps doctor's
`derived.build_output_fingerprint.value` onto `stages.assembly.build_fingerprint`
(see "Recording stage completion" below). Doctor recomputes the value on every run
(`built_output.fingerprint`): a match is a ready line, a missing record is the
warning `built_output.fingerprint_missing` carrying the value to record, and a
recorded value the output no longer matches is `built_output.fingerprint_stale`
(blocking once assembly is complete). The polish gate, QA, and `polish capture`
compare evidence against that recomputed value, so evidence bound to a build whose
output has since changed is `polish.output_drift` even when the recorded string
still matches (`polish.stale` stays the code for evidence stamped against an older
recorded build). `polish capture` refuses by name when the built route root is
missing, unreadable, or drifted; symbolic links are never build output and are
skipped by the walk.

A stale or missing Assembly Source Package Fingerprint is waivable only as an
exceptional Source Freshness Waiver. The waiver must be structured in
`waivers[]`, with `scope: "assembly_source_package_freshness"` or an
`applies_to` reference such as
`stages.assembly.source_package_material_fingerprint`, plus reason, owner or
waived_by, timestamp, and expiry/review condition. The waiver allows the
orchestration loop to proceed to Polish, but Polish still must record current
Polish Evidence, including `source_package_material_fingerprint` when a current
Design Source Package exists. The waiver must remain visible in Campaign
Readiness Readback and downstream QA evidence; it is not a silent pass.
In v0, write accepted Source Freshness Waivers directly into `waivers[]`.
`campaigns-os checkpoint waive` is a staged generic registry and currently
accepts five gates: `page_kit.store_profile`, `page_kit.sdk_version`,
`polish.hidden_eager_media`, `built_output.upsell_selector_scope`, and
`source_html.producer_provenance`, which is waived per page with
`--page <page_id>` (see the [Design Source Package](./design-source-package.md)
hand-written HTML route); an unregistered gate id is refused with that list. `theme waive` applies the same
attribution rule (a named human, no placeholder, an optional future
`--expires-at`) on its own lane. Within Polish, only the broader Source Freshness
waiver retains its existing report path; theme and QA decisions retain their
existing artifact or waiver paths until each is explicitly registered.

In v0, material source fingerprint fields include contribution identity/kind,
provenance, presentation intent, Surface Identity catalog and mappings,
contribution coverage roles, mapping confidence, source refs, source
screenshot/reference refs, Template Reference linkage, Source Gaps, Source
TODOs, accepted waivers, and any source divergence or proposed exception that
has `readiness_affecting: true`. Generated readback prose, formatting/key order,
and administrative notes are non-material when they do not alter readiness,
coverage, provenance, or comparison basis. Capture timestamps alone may be
non-material, but changing the viewport key, URL, dimensions, artifact path, or
visual artifact hash is material.

For renderable contributions that provide page-level `primary_design` coverage,
source readiness requires at least desktop and mobile screenshot refs. Tablet is
optional in v0. If a source is renderable but cannot be captured, record a
Source TODO unless the absence is explicitly accepted as a Source Gap or covered
by an approved Checkpoint Waiver. Template-baseline pages use the selected
Template Reference standard viewport refs rather than source-specific captures.
Use shared viewport keys across source refs, Polish Evidence, and QA evidence:
`mobile`, `desktop`, and optional `tablet` in v0. Exact width, height, device
profile, scale factor, browser, capture time, and URL are capture metadata, not
new viewport names. Avoid stage-specific aliases such as `iphone`, `small`,
`wide`, or `1440`; keep those details in metadata so cross-stage comparisons can
join on the same keys.

Required page-level coverage applies to every active or mapped page in the
current build scope. A page is covered by a non-low-confidence `primary_design`
contribution, an explicit `template_baseline` contribution for template-stock
pages, or an attributed Source Gap / approved Checkpoint Waiver explaining why
no primary design source exists. `template_baseline` must reference the selected
template family/version and Template Reference artifact or contract. If the
Template Reference proof is missing, record a Source TODO, Source Gap, or waiver
according to whether the missing proof represents unfinished preparation, an
accepted source absence, or an approved run exception. Missing page-level
coverage blocks source readiness.

## Adapter And Proof Fields

Fresh packets include `source_html.adapter_contract`. Build Context and
Assembly Report carry the same values as `adapter_decisions`. After building,
record the true scalar decisions with `record build --adapter-decision
<key>=<value>[,<key>=<value>...]` (one flag, comma-separated `key=value`
pairs). For example, set `raw_html_conversion_status=completed` after source
HTML conversion, or `not_required` when there is no source HTML to convert.
A repeated `--adapter-decision` flag keeps only the last list. The command
writes the Assembly Report only. Doctor's adapter gates and leftover-wrapper
check read the effective decisions in report → Build Context → packet order;
doctor still validates each copy's shape separately. Source preparation reads
the packet's `wrapper_policy`, which is selected at intake with
`prepare-build --wrapper-policy` or the source-html manifest's `wrapper_policy`
option. The record flag refuses that key, an unknown key, or a value outside
the allowed values below. The object-valued
`template_files_copied` has no flag: its `status`, `required_groups`, `groups`,
and `paths` remain required proof in the report and keep their existing doctor
checks.

Required adapter decisions:

| Field | Purpose | `record build` allowed values |
| --- | --- | --- |
| `raw_html_conversion_status` | Whether prepared HTML has been converted into page-kit-ready source. | `pending`, `in_progress`, `completed`, `not_required`, `blocked` |
| `source_asset_strategy` | How images/fonts/CSS/JS are moved and referenced. | `pagekit_campaign_asset_root`, `external_cdn`, `raw_passthrough`, `not_applicable`, `unknown` |
| `commerce_shell_adoption` | Whether checkout/upsell/downsell/receipt use a template-clone-first SDK surface. | `not_required`, `template_clone_first_required`, `template_clone_first_verified`, `sdk_surfaces_preserved`, `custom_html_experimental` |
| `route_rewrite_policy` | How page links, CTAs, and SDK routing values were rewritten from CampaignSpec routes. | `campaignspec_routes_via_campaign_link`, `pagekit_public_routes`, `raw_passthrough`, `not_applicable`, `unknown` |
| `template_files_copied` | Whether the selected template family was copied/verified as one atomic page-kit slice. | Object-valued proof; no flag |
| `config_script_strategy` | How campaign config scripts are loaded. | `campaign_asset`, `frontmatter_script`, `inline`, `not_required`, `unknown` |
| `wrapper_policy` | Whether document wrappers are stripped, preserved, or not required. | Intake only: `strip_document_wrappers`, `preserve_document_wrappers`, `not_required`, `unknown` |
| `frontmatter_policy` | How Page Kit YAML frontmatter is created or preserved. | `pagekit_yaml_frontmatter`, `raw_passthrough`, `not_required`, `unknown` |
| `script_style_reference_policy` | How scripts/styles move into frontmatter, campaign assets, inline blocks, or passthrough. | `frontmatter_or_campaign_asset`, `frontmatter`, `campaign_asset`, `inline`, `raw_passthrough`, `not_required`, `unknown` |
| `cta_rewrite_policy` | How CTA destinations are rewritten from CampaignSpec routes. | `campaignspec_routes_via_campaign_link`, `pagekit_public_routes`, `raw_passthrough`, `not_applicable`, `unknown` |
| `layout_choice` | Which Page Kit layout strategy wraps the prepared source. | `campaign_layout`, `page_layout`, `raw_passthrough`, `not_applicable`, `unknown` |

Fresh build context also includes `source.asset_crawl`
(`source-asset-crawl/v0`). `prepare-build` scans the source HTML files and
referenced local CSS, then records each local image/font/CSS/JS asset ref with:

- `raw` and `normalized` source refs;
- `source_path` / `source_exists` resolution under the source root;
- `pagekit_asset_path` for the campaign asset-root ref to use during assembly;
- summarized warnings for raw `/assets/...` refs, missing local files, and
  refs that escape the source root.

Use this inventory before moving assets into Page Kit. It is deliberately a
context/report aid, not part of `source_html.pages[]` page binding.

`template_files_copied` is intentionally group-based rather than prose-only:
`pages`, `_includes`, `_layouts`, `assets/css`, `assets/js`, and
`frontmatter_vocabulary`. Doctor warns when an assembly-complete report still
shows `pending`/`partial` template copying or misses one of those groups. When
the status is `complete` or `verified_existing_slice`, `paths` must name
target-repo-relative proof paths and doctor verifies those paths exist.

Fresh packets also include `qa.proof_policy`, mirrored into
`report.proof_policy`. It records browser QA requirement, typed-card depth,
localhost Development-domain behavior, non-localhost SDK allowlist requirement,
order path depth, and operator approval state. Test cards still need no
permission gate; the explicit field prevents agents from re-litigating proof
depth in chat. Doctor checks the full field set in both packet and report
artifacts when present. `order_path_depth` is seeded `common` and set with
`--order-path-depth <off|common|full>` on `prepare-build`/`start` or later
with `qa policy set --order-path-depth <depth>`, which also refreshes the
report mirror; a packet whose depth disagrees with its report mirror draws the
advisory `qa.proof_policy.order_path_depth_drift` warning naming that command
(see `docs/qa-and-test-orders.md`, "Purchase-proof coverage"). The `qa` block carries no permission booleans:
`qa.test_orders_allowed` and `qa.sandbox_test_card_confirmed`, which no command
read, were removed in supported surface 1.28.0, and doctor warns
(`qa.removed_policy_fields`) on a packet that still carries either.

### Deploy target

`deploy.target` names where the built `_site/` output is served for QA. The
schema enum is `netlify`, `cloudflare-pages`, `vercel`, `shopify-proxy`,
`agency-ci`, `local-serve` and `unknown`; doctor blocks (`deploy.target`) on
any other value. `prepare-build`/`start` take `--deploy-target <target>` and
default to `unknown`; `qa policy set --deploy-target <target>` changes it later.

`local-serve` (added in 1.28.0) is the localhost QA path: nothing is deployed,
the built output is served on localhost by any static server, and
`deploy.preview_url` records that origin. Localhost on any port is a Campaigns
App Development domain (SDK allowed, analytics suppressed), so under
`local-serve` doctor does not raise `campaign.allowed_domains_confirmed`, reads
a recorded localhost URL as the intended state (a `ready` line), accepts a
loopback host (`127.0.0.1`, `[::1]`) with a ready line naming the
`http://localhost:<port>/` fallback, and warns (`deploy.local_serve_url`) when
the recorded URL is neither.
`next` at the deploy stage then hands off a serve-locally prompt and action
instead of a ship-to-host one, and the served URL is recorded with
`campaigns-os record deploy --packet <p> --base-url <url>` (the record command
table below). The directory to serve is `_site/`; for a
root-served campaign (`campaign.route_root: "/"`) the handoff adds that pages
are served at site-root paths while assets keep the `/<public_route_slug>/`
prefix, so `_site/` needs the same rewrite of root-level page routes onto
`/<public_route_slug>/<route>` the production host applies — no single
directory serves both. The QA stage is unchanged and runs against the recorded
URL.

`local-serve` also selects **local proof mode** for the build stage: page-kit
is built in the development environment (`CPK_ENV=development npx
campaign-build --json > .campaign-runtime/page-kit-build-summary.json`) into
`_site/`, and `campaigns-os record build --packet <packet> --build-environment
development` records `stages.assembly.evidence.build_environment:
"development"` on the Assembly Report (a free-form stage field; no schema
change; never hand-edited). The starter templates gate every vendor loader on the environment,
and a production build's protocol-relative loaders (`//host/...`) fail over a
plain-HTTP local serve, voiding polish capture unwaivably; the SDK's `dl_*`
events still fire in development. Before commit, `campaigns-os page-kit parity
--packet <packet>` renders the current source in both environments to temp
directories and proves the served output is the current development render
and that production differs from it only in environment-gated output, with
the same page set, route slugs, Campaign Cart pin and `next-api-key`; the
result is recorded on `stages.assembly.evidence.local_proof.production_parity`
and doctor reports it as `local_proof.production_parity` (with
`local_proof.build_environment` for the build record). The PR preview is the
second check. The toolkit never proposes editing a generated include to make a
local capture pass. Details and the step order:
[qa-and-test-orders.md](./qa-and-test-orders.md#local-proof-mode-deploytarget-local-serve).

Campaign Build Brief `qa_policy` is deliberately scoped as
`documented_expectation` metadata. Use it to preserve business QA intent, but
do not treat it as the enforced gate; doctor/QA enforcement reads the packet
and report proof policy fields above.

## CampaignSpec Retrieval (`--map-id`)

`campaigns-os start` / `campaigns-os prepare-build` accept the CampaignSpec via either of two routes:

| Flag | Source | When to use |
| --- | --- | --- |
| `--spec <path>` | Local JSON file | Agent-authored local specs, saved-Map exports, offline work or CI fixtures |
| `--map-id <id>` | Map Builder proxy (KV-backed) | Saved-Map intake from the current KV revision |

When `--map-id <id>` is set, the CLI fetches `GET <proxy>/api/spec/<id>` (default `<proxy>` is `https://campaign-map.nextcommerce.com`) and caches the response to `<target>/.campaign-runtime/fetched-specs/<id>.json`. The cached file is what downstream stages read, so the packet's `spec.local_path` always resolves to an on-disk artifact regardless of intake mode. When the Map holds routes with a host in front of the path, the cached file holds the rooted routes and that run's Assembly Report `evidence[]` holds the values as fetched (see "Page Kit Target Projection" below). The cache is written only inside a real `fetched-specs/` directory: if `.campaign-runtime/`, `fetched-specs/` or the cache file is a symlink, the command stops with an error before fetching and writes nothing. Each write goes to a new file renamed over the cache file, so a hard link to the old file keeps its bytes.

Saved-Map retrieval behavior (`--map-id`):

- **Re-fetch by default.** Every `start` / `prepare-build` invocation re-fetches from KV. KV is the source of truth; the cache file is a debug/inspection artifact, not a performance optimization.
- **One writer at a time.** The fetch happens first, but the fetched spec is written to the cache file only once the run holds the per-target prepare-build lock. A second run against the same target, fetching a newer Map revision, waits for the lock before replacing the cache, so the run holding it records the hash of the revision it actually parsed.
- **`--cached-spec`** reuses the cache without a network call. Use for offline iteration or when the proxy is temporarily unreachable. The cached copy is read as it is and never rewritten.
- **`--proxy-base <url>`** overrides the default origin. Use for staging environments or local Worker dev (`wrangler dev`). Spec retrieval carries no credential, so any reachable origin works here — but the same flag also aims the credential-bearing rails (Run Telemetry remit, QA verdict publish, `telemetry list`), and those require `https:` unless the host is loopback (`localhost`, `127.0.0.1`, `[::1]`), which is allowed over plain http with a stderr warning. A plain-http remote proxy is refused before the request. See docs/workflow-findings-sidecar.md (Remit Channel).
- Failure modes (HTTP error, `{ok: false}` response, network timeout) surface as clean CLI errors before any packet is written.

The fetched spec is treated identically to a `--spec`-supplied local file from this point forward — same identity validation, same `prepareBuild` pipeline, same idempotency semantics. Re-running `start --map-id` on the same campaign re-fetches the spec, regenerates the packet, and re-runs doctor. If `design_source` was newly populated since the last run, the doctor's design_source-aware blocker logic surfaces it; if nothing changed, the run is a no-op as far as downstream stages are concerned.

## Source HTML Manifest Auto-Population

When the source HTML root carries a source-html manifest at `<source>/.campaigns-os/source-html-manifest.json` (schema `source-html-manifest/v0`, published at `schemas/source-html-manifest.v0.schema.json`) — or `--design-manifest <path>` names a manifest of that schema anywhere else, for a source root nobody can write to — `campaigns-os prepare-build` reads it and uses its `pages[]` block to populate `packet.source_html.pages[]` directly — bypassing the legacy filesystem-name slug matching. Wherever the manifest lives, its `pages[].path` entries stay relative to `--source`. Each `pages[]` entry carries exactly one of `path` or `skip_reason`: an entry with both is invalid, and an invalid entry makes prepare-build ignore the whole manifest and fall back to filesystem matching. A `pages[]` entry with `skip_reason` and no `path` declares a template-stock page: its assembly decision carries `template_stock: true` and the locked family, and intake demands no design source for it ([Template-stock pages](design-source-package.md#template-stock-pages-the-family-decides)).

The source-html manifest remains a producer/source-HTML adapter input. It is not
renamed into the Design Source Package. In the normalized source workflow,
`prepare-build` uses source-html manifests, filesystem fallback, template-stock
inputs, and other adapters to emit a separate public Design Source Package with
contributions, coverage, gaps/TODOs, Surface Identity, references, and readback.
When source-html data is the available input and the default package path is
missing, current v0 `prepare-build` synthesizes the package. If a package already
exists, it is validated against the current material inputs and reused byte for
byte or refused; it is never silently regenerated. The one exception is a stale
package an earlier `prepare-build` synthesized and nobody has changed since:
`--force` regenerates it from the current inputs
([Design Source Package: stale packages](design-source-package.md#prepare-build-emit-validate-or-refuse)). Downstream Build and Polish
consume the package concept rather than branching back to
`packet.source_html` as a second source model. The emitted package lives at
`.campaign-runtime/input/design-source-package.json` by default and is referenced
from packet/context/report by path, full artifact hash, and material fingerprint.

Behavior:

- The manifest is consumed only when it passes the `source-html-manifest/v0`
  validator. Unknown schema versions, missing `page_id`, entries with neither
  (or both) `path` and `skip_reason`, or malformed `source_hash` values log a
  warning and fall back to filesystem matching so out-of-band tools cannot
  silently corrupt the packet. Doctor also validates a present manifest at the
  source root.
- A partial-source build is declarable (#238). A page entry may carry
  `skip_reason` instead of `path` to declare that active page out of source
  scope (a template-derived page has no source HTML by design), and
  CampaignSpec `build_scope.mode: "partial"` declares the same thing as a
  blanket for active pages with no manifest entry and no `design_source`.
  Declared pages are recorded on the packet as `skip_reason` mappings and on
  the assembly report under `stages.prepare_build.declared_out_of_scope`;
  prepare-build reaches `completed_partial` instead of blocking on
  `MISSING_SOURCE_PAGE`, and the declaration regenerates identically on every
  `start`/`prepare-build` run because it derives from the spec and manifest.
  A page that declares `design_source` still blocks without a per-page skip
  entry, and full/undeclared scope keeps the blocking behavior exactly.
- The manifest's `page_id` must match an active CampaignSpec page id. Manifest entries with no matching spec page surface as a `MANIFEST_EXTRA_PAGE` prompt (analogous to the existing `MISSING_SOURCE_PAGE` prompt) so the operator reconciles either the spec or the manifest before build.
- Optional manifest `page_url` values must be unique after Page Kit route normalization. Duplicate values surface as `MANIFEST_DUPLICATE_PAGE_URL`; prepare-build keeps the first value for route fallback matching and asks the operator to deduplicate before build.
- Path values are relative to the source HTML root (`<source>`), not to the `.campaigns-os/` directory that contains the manifest. For example, use `checkout/index.html`, not `../checkout/index.html`.
- An optional top-level `wrapper_policy` key declares the document-wrapper policy for the handed-over source, in the same vocabulary the packet records at `source_html.adapter_contract.wrapper_policy`. prepare-build seeds the adapter contract from it; the `--wrapper-policy` flag overrides it, and with neither the default stays `strip_document_wrappers`. Unlike the keys above, a value outside the vocabulary does not invalidate the manifest — the key is ignored with a warning and the rest of the manifest is used as written. See [docs/source-adapters.md](source-adapters.md#selecting-the-wrapper-policy-at-intake).
- The build context records `source.manifest` with `schema_version`, `generator`, `generated_at`, and `page_count`, and the assembly decision log records evidence citing the manifest file.

When the manifest is absent, prepare-build falls back to filesystem-name slug
matching. If exactly one candidate matches an active page, the mapping is
recorded as before. If multiple HTML files can satisfy the same page, or if all
matching files were already assigned to sibling pages, prepare-build blocks with
`AMBIGUOUS_SOURCE_PAGE`, records `context.source.ambiguous_candidates`, and
drafts `context.source.manifest_draft` so the operator can write
`.campaigns-os/source-html-manifest.json` and choose the intended paths before
build.

### Page Kit Target Projection

`source_html.pages[].path` is source provenance. It names the producer/source-root-relative HTML file that should be consumed; it is not necessarily the file path to write under the Page Kit campaign directory.

Fresh `prepare-build` output also writes `source_html.pages[].page_kit` for mapped pages. This block is the Page Kit target projection:

- `target_path` is the page file relative to `assembly.output_dir` (`checkout.html`, `receipt.html`, etc.).
- `output_path` is the same target file relative to `assembly.target_repo`.
- `public_route` is the rendered campaign-rooted route Page Kit should produce.
- `page_type` is the CPK runtime/analytics vocabulary (`product`, `checkout`, `upsell`, `receipt`), not the richer CampaignSpec or producer page type. CampaignSpec `select` pages project as CPK `checkout` because they are pre-checkout runtime selection surfaces.
- `frontmatter` names the Page Kit frontmatter fields the build should write or preserve.
- `permalink_required` is true when Page Kit's filename-derived route would not match `public_route`.

The Design Source Package should reference this projection without confusing it
with Surface Identity. Surface Identity is the campaign-facing join key; Page Kit
`page_type`, public routes, output paths, CampaignSpec/Map Builder page IDs,
custom labels, and producer page types stay as mapped attributes or aliases.

`page_map[].output_path` in the Build Context is the same Page Kit target path,
not `source_html.pages[].path` appended under `assembly.output_dir`. Build agents
should read `source_path` for producer provenance and `page_kit.output_path` for
the file to write.

CampaignSpec `page_url` and legacy `url` values are interpreted as Page Kit
routes during projection. That normalization strips `.html`/`index.html`,
removes query/fragment values, converts absolute preview URLs to their path, and
normalizes trailing slashes before deriving target files and frontmatter routes.

A route value with a host in front of its path (an older saved Map stored
`shop.example.com/route/upsell/` where the route is `/route/upsell/`) is
reduced to its rooted path before anything reads a spec that `prepare-build`,
`start` or `build` fetched with `--map-id` in the same run. This covers every
`page_url` and every `next-success-url`, `next-upsell-accept-url` and
`next-upsell-decline-url` meta tag value in `funnels[].pages[]` and
`funnel_pages[]`:

- The host is removed and the path is kept with its query and fragment
  (`shop.example.com/route/x/?v=b#top` becomes `/route/x/?v=b#top`). An
  absolute `http(s)` `page_url` is rooted the same way; an absolute `http(s)`
  routing meta value is a valid SDK target and is kept.
- The fetched copy at `<target>/.campaign-runtime/fetched-specs/<map-id>.json`
  then holds the rooted values, not the bytes as fetched. It is replaced only
  after the Assembly Report recording the changes has been published, so if
  publishing fails the copy is left exactly as fetched. The rooted spec is
  written to a new file in `fetched-specs/` and renamed over the copy, so
  another name for the old file (a hard link) is never changed. A spec with
  no host-prefixed value is written exactly as fetched, as before.
- Each changed value is recorded on that run's Assembly Report `evidence[]` as
  `{ "code": "routing_meta.host_stripped", "page_id", "field", "from", "to" }`;
  `from` is the value exactly as the Map returned it. The raw values are kept
  only there and in the Map itself: a later run with `--cached-spec` reads the
  rooted copy, finds nothing to strip, and records no evidence. One line on
  stderr lists the changes.
- `intake.saved_map_revision.local_spec_material_hash` in the Build Context is
  the material hash of the rooted copy, while `hash` stays the fetched Map
  revision. A progress snapshot's `saved_revision_alignment: "aligned"`
  therefore means the local spec matches that Map revision after host
  stripping, not byte for byte.

A local `--spec` file and a copy reused with `--cached-spec` are never
rewritten. When either holds a value doctor blocks on (below), intake reads it
as it is and prints one line on stderr naming each value and its rooted form:
for a local file, that the file must be edited; for `--cached-spec`, to re-run
without `--cached-spec` so the Map is fetched and normalised.

A value reads as host-prefixed when it is one of:

- an `http://` or `https://` URL, with any host (stripped from a fresh fetch;
  never blocked);
- `//<host>/...`, where `<host>` is one of the bare host forms below;
- `<host>/...`, where `<host>` is `localhost`, a valid IPv4 address (four
  dot-separated numbers, each 0-255), any name with a `:port`
  (`localhost:8080`, `shop.example.com:8443`), or a dotted name whose last
  label is 2-63 letters and is not a page or script extension: `html`, `htm`,
  `shtml`, `php`, `asp`, `aspx`, `jsp` or `cgi` (`shop.example.com`,
  any case).

Everything else stays a route for the existing checks: a rooted `/...` value,
a first segment with no dot (`route/x/`), a dotted segment whose last label is
not all letters (`v1.2/offer/`), a dotted quad with a number over 255
(`300.1.2.3/offer/`), a page or script filename (`checkout.html`,
`index.php/checkout/`, `upsell.aspx/`), `//` followed by something that is not
a host (`//route/x/`), a bare host with no path, and an empty or missing value.

If a bare or `//` host-prefixed value still reaches doctor (a local spec that
holds one, a copy reused with `--cached-spec`, or a spec edited after intake),
doctor blocks with `routing_meta.host_prefixed`, naming each value and its
rooted form. An absolute `http(s)` value never raises it: projection converts
an absolute `page_url` to its path, as above. `page_url` is checked whether or
not the site is built; routing meta values follow the same built-output
deferral as `routing_meta.runtime_root`.

This prevents mixed-source manifests such as `checkout/index.html` from leaking producer folder structure into `src/<slug>/checkout/index.html`. Campaigns OS owns the Adapter from source/manifest/CampaignSpec into Page Kit shape; Page Kit remains the target.

`target_path` intentionally uses the terminal route segment (`checkout/step-1/`
projects to `step-1.html`). If two routes collapse to the same target filename,
prepare-build emits `PAGE_KIT_TARGET_CONFLICT`; change one CampaignSpec route
before build instead of letting an agent choose a destination.

### Per-page `source_hash` (Slice 6 drift detection)

Each `manifest.pages[]` entry MAY carry a `source_hash` field — the sha256 hex digest of the source HTML file's contents at the moment the producer wrote the manifest. When present, prepare-build threads the hash onto the matching `packet.source_html.pages[]` mapping. Doctor reads the packet mapping at validate time, computes the current on-disk sha256 of the same file, and warns (`source_html.pages.source_hash`) when they diverge.

Behavior:

- Optional on the producer side. Producers that don't emit `source_hash` (pre-Slice-6 manifests, template-stock, hand-authored) keep working; doctor's drift check is silent without a hash to compare.
- Warning severity only. A drift never blocks a build. The hash doctor compares is the one intake recorded in the packet, so editing the manifest alone does not clear the warning: re-running `start` or `prepare-build` with `--force` records the current file, and also clears recorded stage evidence. A revision made after build belongs in the page-kit source under `src/<route>/`; the source HTML stays the design provenance.
- The warning names the file path and includes both hashes (truncated to 12 chars) so the operator can confirm which file diverged without re-running the producer.

### Reference AI-generated producer

`scripts/reference-ai-producer.mjs` ships in this repo as the smallest possible producer reference. It walks a folder of HTML files (auto-discovery) or accepts explicit `--page page_id=path` mappings, computes sha256 per file, and emits the `source-html-manifest/v0` at the canonical location. Auto-discovery maps `landing.html` to `landing` and nested `checkout/index.html` to `checkout`; duplicate inferred page ids fail fast, so use explicit `--page` mappings for ambiguous layouts.

Usage:

```bash
node scripts/reference-ai-producer.mjs \
  --source <source-root> \
  --campaign-slug <slug> \
  [--generator <name@version>] \
  [--page landing=presell-a.html --page checkout=checkout/step.html]
```

Real AI agents (Claude, Codex, etc.) that produce campaign source HTML should adopt this manifest shape so doctor's design_source-aware error messages and Slice 6 drift detection work uniformly across producers. The script generates only the manifest; it does not write any HTML.

## Authoring-Time Hints (Template Family + Upsell Pattern)

The CampaignSpec carries two optional **hints** the build agent uses
as defaults. Both are hints, not contracts: CLI / operator overrides
always win.

**Campaign-level:** `campaign.preferred_template_family` declares
which starter family the campaign was authored against (one of
`apollo`, `apollo-mv-single-step`, `olympus`, `limos`, `demeter`,
`olympus-mv-single-step`, `olympus-mv-two-step`, `shop-single-step`,
`shop-three-step`). The
consumer (`preferredTemplateFamily()` in `src/cli.mjs`) reads this
at three spec locations and uses it as the default template family
when no `--template-family` CLI flag is given.

Resolution order:

1. `--template-family <family>` CLI flag (sets `template_lock.locked: true`).
2. `spec.spec_identity.preferred_template_family`.
3. `spec.campaign.preferred_template_family` (the canonical authoring location).
4. `spec.preferred_template_family` (legacy fallback).
5. `"undecided"`.

When the flag and the hint disagree, the flag wins and `prepare-build` says
so rather than resolving in silence: it prints one stderr line naming the
winning flag value, the overridden `preferred_template_family` value, and
which channel each came from, and records the same thing on the assembly
report as a `prepare_build` warning with code
`TEMPLATE_FAMILY_HINT_OVERRIDDEN`. An operator reading the report
therefore sees that the packet's family was an override rather than agreement
with the spec. A flag that merely repeats the hint is agreement, not an
override, and stays quiet. To build on the spec hint instead, re-run without
`--template-family`; to remove the disagreement, update the spec so the two
match.

When the hint wins, `template_lock.locked` stays `false` — the family is set as the default but not locked, so a downstream stage (or a follow-up operator pass) can override without contradiction. `template_decision_notes` records the hint source. `template.candidates` in the build context lists the hint with `source: "CampaignSpec preferred_template_family"` for provenance.

**Per-page:** `Page.upsell_template_pattern` declares the UI variant
for an upsell page (one of `mv`, `bundle_tier_pills`,
`bundle_tier_cards`, `single`). Flows from the spec page onto
`packet.source_html.pages[].upsell_template_pattern` so the build
stage can pick the right partial without re-parsing the spec.

The field is per-page; only upsell pages should carry it. Upstream
spec validation warns when it's set on non-upsell pages, but the
consumer surfaces it verbatim and lets the build stage decide what
to do with it.

## Commerce Catalog (`assembly.commerce_catalog`)

`assembly.commerce_catalog` names the commerce-surface catalog the build and
doctor read for the locked template family (`required`, `family`, `version`,
`path`).

- `path: null` means the toolkit's own catalog
  (`contracts/commerce-surface-catalog.json` of the `campaigns-os` that is
  running). This is what `prepare-build` records by default. The catalog
  travels with the toolkit, not with the campaign, so the packet does not
  record where one machine's checkout or package install kept it, and the
  same packet resolves on any machine and under `npx --no-install campaigns-os`.
- A string `path` is an operator-supplied `--commerce-catalog <path>`,
  recorded relative to the packet (keep it inside the campaign repo). Doctor
  resolves it against the packet's directory and blocks on
  `assembly.commerce_catalog.path` when it does not exist.
- Packets prepared before `null` was recorded carry the toolkit catalog as a
  packet-relative path that climbs into the checkout that ran `prepare-build`
  (`../../../campaigns-os/contracts/commerce-surface-catalog.json`). When such a
  path does not exist but its file name is `commerce-surface-catalog.json`,
  doctor and QA resolve it to the running toolkit's catalog and doctor prints
  a `ready` line saying the packet still carries a machine-local path. That
  is never a blocker; re-running `prepare-build` records `null`.

## Orchestration Loop (`campaigns-os next`)

`campaigns-os next` (no stage argument) is the agentic orchestration primitive. It reads the current packet, doctor, and assembly report state from disk and tells you which stage should run next. Each call re-reads state, so the loop is idempotent and recoverable across sessions / machines.

Treat the loop as a sequence of Readiness Checkpoints, not as a required one-shot
campaign build. A one-shot run is the best case where inputs are already complete
and every checkpoint can advance in one session; the normal path may take several
turns or sessions as source gaps, source TODOs, waivers, polish findings, deploy
state, and QA blockers are discovered and resolved.

For source preparation, the Design Source Package should carry a generated
readback summary that names included sources, coverage, gaps/TODOs, mappings,
reference availability, and readiness. The readback helps humans and agents pick
up the work later; structured package fields remain authoritative. Later stages
should write their own stage readbacks or evidence summaries rather than
rewriting the Design Source Readback. Those stage readbacks should be surfaced
through a consolidated or just-in-time Campaign Readiness Readback so the
operator is not expected to discover a patchwork of separate artifacts. Generate
that readiness readback from the latest artifacts as the primary behavior; Run
Records may snapshot it for audit. `campaigns-os next` should show the concise
current-stage readback, while run or campaign status should show the fuller
campaign-level readback. The readback should include readable prose plus stable
buckets: `current_checkpoint`, `readiness_status`, `handled`, `blocked_by`,
`known_gaps`, `proposed_exceptions`, `waivers`, `evidence_refs`, and
`next_actions`. `evidence_refs` should point to source package sections,
screenshots, Polish Evidence, Assembly Report stages, deploy URLs, QA verdicts,
or other owning artifacts; the readback summarizes evidence but does not embed
the detailed proof. UI surfaces may render screenshot thumbnails from refs, but
CLI/readback data should keep screenshots as references with a short statement of
what each proves.

Checkpoint status should stay boring and shared: `pending`, `blocked`, `ready`,
`ready_with_gaps`, `ready_with_waivers`, `completed`,
`completed_with_warnings`, or `skipped`. Put stage-specific detail in evidence,
gaps, TODOs, waivers, findings, and next actions. `ready_with_waivers` requires
structured waiver evidence: owner, reason, scope, applies-to references, created
time, and either an expiry or review condition. Stages such as polish may draft
or recommend waivers with evidence, but an operator/run decision approves them.
Polish must classify every unresolved issue as `repair_needed`, `source_gap`,
`source_divergence`, `waiver_recommended`, or `out_of_scope` so the next
checkpoint knows whether to fix, carry, approve, or route it. Unresolved
`repair_needed` issues block deploy and QA unless repaired, reclassified, or
covered by an approved waiver. A `source_divergence` raised by polish is
proposed until confirmed by an operator/run decision or the relevant Build or
Design Source owner. A `source_gap` raised by polish is proposed too, unless it
traces to an accepted Source Gap in the Design Source Package.

The motion:

```text
agent calls `next` → gets { stage, prompt, picked_reason } → does the work →
records it (`campaigns-os record setup|build|polish`; deploy and QA record their
own stages) → calls `next` again → repeat until stage="done"
```

### Refreshing after a CampaignSpec change

When the CampaignSpec's material content changes, every build, Polish and QA record made against the earlier content stops counting as current, in local-spec, saved-Map and gateway packets alike. For a saved Map or gateway packet, Campaigns OS compares the copy intake fetched; it does not check whether that copy is the latest remote revision, and reports the remote as unconfirmed. Doctor warns `spec.material_stale`, and `next`, progress, readback, the Assembly Report's own status and the QA gate show the stages that are owed again; `next` routes to the first one. Run `campaigns-os record spec --packet <packet>` to bind the new content: it updates the build context and report identity, re-reads the brief file last saved (by intake or `record brief`), keeps waivers, warning accepts, the applied theme and deploy settings, and moves each superseded stage record into that stage's `history`, which is never used as current proof. `spec derive` no longer rebinds identity; run `record spec` after it. A change to the set, order or routes of active pages still needs intake. Re-recording an unchanged build after a spec change keeps the build owed, because the change has not reached the pages, unless the operator records a reason with `--deviation-reason`; this holds even when `record spec` was not run, and that `record build` also marks Polish and QA owed again. Polish stays owed until a new `polish capture`, and QA must produce a new verdict against the current content. Polish measurements of byte-identical output keep their values, but the Polish stage is owed again. These checks are tamper evidence, not proof: a hand-written record that copies the current values, or a packet pointed at an older copy of the spec, is not detected.

The CampaignSpec's material content is the whole spec except `spec_identity`,
`slug`, `map_id` and `saved_at`; a page `label` edit is material. A spec
change affects the stages as follows:

| Stage | After a spec material change |
|---|---|
| `prepare_build` | unchanged (`record spec` refuses a page-scope change, which needs intake) |
| `doctor` | recomputed on every read |
| `setup` | kept |
| `assembly` | owed: `required`, `required_by: "spec"`, `required_for: ["polish", "qa"]` |
| `polish` | owed: `required`, `required_by: "spec"`, `required_for: ["qa"]` |
| `deploy` | kept |
| `qa` | owed: `required`, `required_by: "spec"`, `required_for: []` |

`record spec` refuses, writing nothing, in this order: `spec_unreadable` (the
spec does not parse), `spec_identity_changed` (its map id or local spec id
names another campaign than the packet or the report), `page_scope_changed`,
then, for the brief file last saved (by intake or `record brief`), `brief_too_large`,
`brief_source_is_package_artifact` and `brief_file_missing` (the recorded
path is missing or is not a readable regular file: a directory, a pipe or
socket, a symlink to nothing, or a file without read permission). When it must
re-derive the brief, it also refuses `brief_inputs_unavailable` (the Build
Context lacks an intake product re-deriving the brief needs). It reads
`unchanged` and writes nothing when the bound material equals the spec and no
stage's spec or brief stamp differs from the current content; a stage that
does not record which content it was made against is named in a
`binding_unknown` notice instead. Otherwise it refreshes, re-deriving the
normalized brief from the brief file last saved, so an edit made to the
normalized brief itself is replaced by what its source gives. A stage whose spec
stamp already equals the new content (a build recorded after the edit) is not
demoted. `record spec` does not write the Build Packet. `--dry-run` runs every
check and writes nothing.

### Recording stage completion

Setup, build and polish completion is recorded with one command each, never by
hand-editing `.campaign-runtime/` JSON:

| Command | Writes | Refused (nothing written) when |
|---|---|---|
| `campaigns-os record setup --packet <p>` | Build Context `scaffold.required=false` (`handoff_skill` next-campaigns-build) and `stages.setup` completed | the campaign output directory (`assembly.output_dir`) does not exist, or there is no Build Context or Assembly Report |
| `campaigns-os record build --packet <p> [--build-environment <development\|production>] [--adapter-decision <key>=<value>[,<key>=<value>...]]` | `stages.assembly` completed with `build_fingerprint` = doctor's `derived.build_output_fingerprint.value`, `source_package_material_fingerprint` = the report's Design Source Package material fingerprint when present, `evidence.build_environment` = the `--build-environment` value when given (kept from the last record otherwise), and the specified scalar `report.adapter_decisions`; all recordable decisions go in one comma-separated flag (a repeated flag keeps only the last list); `wrapper_policy` stays an intake choice. `stages.polish` resets to `required` (`required_by` build, `required_for` qa) unless its evidence is bound to this exact output; a completed `stages.deploy` whose `source_build_fingerprint` names other output resets to `required` the same way, without the old probe's `outputs` and `evidence`, and its prior record is kept in `stages.deploy.history` (a deploy with no `source_build_fingerprint`, recorded before deploy stamped it, is kept) | doctor cannot compute the fingerprint (no `_site/<public_route_slug>/`), setup is still required, `stages.setup` is not terminal, or an adapter decision key/value is invalid |
| `campaigns-os record polish --packet <p> --evidence <file>` | `stages.polish` from the file (`docs/polish-evidence.md` §7: completed, blocked or skipped), bound to doctor's current fingerprint; `report.theme.repair_loop_defect` when the file sets it | build is not recorded for the current output, the file has a shape error (named by field), or, for a completed status, the polish gate doctor evaluates would not pass on the result |
| `campaigns-os record theme --packet <p>` | `report.theme`: status `applied`, `load_order` `after-next-core`, `css_path`, `commerce_pages` and per-page evidence read from each built commerce page's stylesheet links; any earlier theme waiver is cleared | build is not recorded for the current output, the campaign ships no commerce pages, a built commerce page that loads `next-core.css` does not load `brand-theme.css` (or `checkout-brand.css`) after it or links one missing from the built output, or no built commerce page loads `next-core.css` |
| `campaigns-os record deploy --packet <p> --base-url <url>` | the packet's `deploy.preview_url` and `stages.deploy` completed with the URL in `outputs`, one evidence line per built page that answered (each page is requested under the URL first), and `source_build_fingerprint` = the recorded `stages.assembly.build_fingerprint` it probed, so a later `record build` of different output makes deploy owed again and `next` routes back to `record deploy` before QA; a byte-identical rebuild keeps it current | the packet is not `local-serve`, the URL is not a loopback origin naming the campaign's route root, a built page does not answer 2xx, polish is not recorded, the built output changed since build was recorded, or the theme gate is blocked |

Each command also refuses a stage `next` has not reached: while doctor's
prepare-build gate is set (`next` answers prepare-build) or while an earlier
stage in the order below is not terminal. The exception is the one `next`
makes: on the local preview, a polish doctor carries forward (never recorded
for this build) does not hold `record deploy` back, as it does not hold `next`;
polish stays owed and QA reports it.

Each command reads the same packet, Build Context and Assembly Report `next`
reads (`--context` / `--report` override them the same way), validates what it
would write against `schemas/campaign-runtime-build-context.v0.schema.json` and
`schemas/campaign-runtime-assembly-report.v0.schema.json` plus doctor's report
checks, and then writes under the target lock, stamping any retained doctor
output stale. The packet is read once first, only to name the target lock, and
re-read and re-checked under it: which report the Build Context binds, the
report itself, the Build Context and doctor's reading (the fingerprint and the
binding) are all read inside the same target lock as the write, and the
fingerprint is computed once more just before the write; output
that changed in between is refused, never recorded with the old value. Every
command refuses a report that is not bound to the packet: whenever doctor's
prepare-build binding gate fails (`next.prepare_build.context_missing`,
`context_packet_mismatch`, `context_dsp_mismatch`, `context_report_missing`,
`report_packet_mismatch`, `report_context_mismatch`, `report_campaign_mismatch`
or `report_dsp_mismatch`, the refusals `next` answers with prepare-build), and
whenever the report's campaign identity does not match the packet, including
for packets with no Design Source Package. Every command also adds
`recorded_by`, and `completed_at` unless it records a blocked Polish, to the
stage it records. `--dry-run` runs every check, takes no lock and writes nothing. A failed
check exits non-zero with the problems listed, one per line; a value outside a
schema enum (for example an `adapter_decisions` policy) is listed with the
values the schema allows and the value it got. Re-run `record
build` after every page-kit build; a rebuild that changes the output needs
`polish capture` and `record polish` again. After deploy is recorded for the
rebuilt output, `next` asks for QA again if the last QA record names the
previous build fingerprint, even while its stage status still says completed.

Stage order: `setup → build → polish → deploy → qa`. The picker walks this list and returns the first stage whose recorded status isn't terminal (`completed`, `completed_with_warnings`, `skipped`). During Polish, install the package-owned browser first, then run `campaigns-os polish capture` against the served current build before recording a terminal `stages.polish.status` or proceeding to deploy/QA; the producer attaches package-owned `visual_review.page_load` evidence and never marks the stage complete itself.

| Stage | Report key | Owner |
|---|---|---|
| setup | `stages.setup` | scaffold the page-kit campaign repo |
| build | `stages.assembly` | assemble the campaign (next-campaigns-build) |
| polish | `stages.polish` | source-design fidelity pass (next-campaigns-polish) |
| deploy | `stages.deploy` | ship `_site/` to Netlify / CF Pages / Vercel / etc. (out-of-band), or serve it locally under `deploy.target: local-serve` |
| qa | `stages.qa` | spec-aware QA (next-campaigns-qa) |

The CLI stage name is `build` but the report keys the same stage as `assembly` — the picker handles the translation. Both names refer to the same lifecycle step.

The Assembly Report's top-level `status`, `next` and `blockers` are derived from its `stages` on every write of the report (prepare-build's first write and every stage record after it), never carried forward from an earlier write. `status` is `blocked` while any recorded stage is blocked, `completed` only once every recorded stage (`prepare_build` and `doctor` included) is terminal, and `prepared` otherwise. `next.stage` is the first non-terminal stage in the order above, in the `next <stage>` vocabulary (`setup`, `build`, `polish`, `deploy`, `qa`, then `done`; a blocked prepare-build or doctor names `prepare-build` / `doctor-blocked`; a doctor that never recorded an outcome does not hold the ladder but is named `doctor` once the ladder is exhausted, so a `prepare-build --no-doctor` report never reads `completed`), `next.owner` is the skill that owns it, and `next.blocked` is present and true when that stage is the one holding the ladder. `blockers` is the union of the `blockers[]` of the stages currently blocked, so a blocker cleared by a re-run leaves the top level with its stage. The report's `next` is the ledger's own position; `campaigns-os next` additionally folds in live gates (doctor findings, purchase-proof coverage, the polish gate) and remains the authority for what runs next.

Result shape (with `--json`):

```jsonc
{
  "ok": true,
  "status": "ready",
  "stage": "build",
  "picked_reason": "Stage \"assembly\" has status \"pending\"; run \"build\" next.",
  "prompt": "Use next-campaigns-build for this Campaigns OS handoff. ...",
  "errors": [],
  "warnings": [],
  "ready": [],
  "stage_blocked": false  // present only when the recorded status is "blocked"
}
```

Terminal states:

- **`stage: "doctor-blocked"`** — doctor returned errors. Resolve the blockers and re-run `campaigns-os doctor` to confirm before calling `next` again.
- **`stage: "done"`** — every stage is in a terminal status. Pipeline is complete. To repeat build work, do the work and use `record build`; it makes downstream stages owed as needed. Use `record setup` or `record polish` after repeating those stages, and `qa run` for QA. `record deploy` records a local-serve target; for a hosted deploy, record the URL and stage outcome as the deploy prompt describes. Then call `next` again.
- **`stage_blocked: true`** — the picker returned a stage whose recorded status is `blocked`. Don't run the prompt as-is; clear the blocker first.

The legacy form `campaigns-os next <stage>` (e.g. `next build`) still works and is the way to force a specific stage when you want to override the picker.

## Design Source-Aware Coverage Error

CampaignSpec pages may carry an optional `design_source` block on `Page` — a pointer to the design artifact (Figma file + per-breakpoint selection URLs) that supplies prepared HTML for that page. When doctor detects an active spec page with no source mapping, the `source_html.pages.coverage` error now carries a hint that points the operator at the design source:

- `design_source.type === "figma"` with `file_url`: doctor calls out the Figma file and says the Figma provenance gate (`source_html.producer_provenance`) needs the figma-sections-export handoff manifest (`npm run handoff -- <slug>`); a hand-written manifest cannot pass that gate.
- `design_source` set without `file_url`: doctor flags the missing `file_url` so the spec can be corrected.
- `design_source` unset, `ai-generated`, or another producer type: the message names the manifest path (`<source-root>/.campaigns-os/source-html-manifest.json`), the schema, and a minimal page entry to write by hand (no exporter is needed), plus `"wrapper_policy": "preserve_document_wrappers"` for standalone documents kept whole. When any active page's `design_source` is Figma, it instead says the manifest must pass the Figma provenance gate.

The error code (`source_html.pages.coverage`) is unchanged so existing doctor consumers do not need to be updated; only the human-readable `message` and an optional `detail.design_source` payload are added.
