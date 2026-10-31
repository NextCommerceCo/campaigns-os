---
name: next-campaigns-sdk-bump
version: 1.0.9
description: Bump a live campaign's Campaign Cart SDK from one 0.4.x release to a later 0.4.x on a page-kit or static repo. Use for any request to bump, upgrade or move a campaign to SDK 0.4.x, including when the repository has its own BUMP.md. Find every pin, check the release diff and storage against the campaign's own code, prove on a preview with approved test orders, and report what is not proven.
---

Bundle revision: 1.63.0+skills.1
Run `npx --no-install campaigns-os tooling status --skills-revision 1.63.0+skills.1`
from the campaign's Page Kit folder, where it runs the project's pinned copy and
never installs one, at the start of each task. Start a fresh session if it
reports `mismatch`: this text is already in your context and is never re-read
while the CLI on disk can move under it. If the output has no `Skills revision:`
line (no `revision_check` under `--json`), a campaigns-os older than this check
answered; follow none of its actions and run the pinned copy.

# Next Campaigns SDK Bump

Use this when someone says "bump this campaign to SDK 0.4.x". The developer
installs the toolkit or approves installing it, asks for the bump, approves each push, the pull request
and each test order, then reviews and merges. Everything here uses existing
commands; there is no new write or order capability.

If the Page Kit folder has no pinned copy yet, the revision check above cannot
run: ask before installing one. Pin a package version you reviewed, after
reviewing its source tag and provenance as `AGENTS.md` describes, and pick one
whose `tooling status --skills-revision` answers `match` for this skill; an
older release lacks commands the steps below use:
`npm install --save-dev --save-exact @nextcommerce/campaigns-os@<reviewed-version>`.
The install adds the package to `devDependencies` in `package.json` and updates
`package-lock.json`; `tooling status` only reads that pin and writes neither.
Expect that change and commit it on the bump branch as its own commit, and
check that the lockfile diff adds only this package. In a static repo, never
install into a folder the site publishes from; ask where the toolkit goes.

If `tooling status` prints `Refresh installed skills` for `--platform codex` or
`--platform agents` only, that refresh is for those harnesses; it is not
required in a session that uses neither.

In the instructions below, bare `campaigns-os …` means `npx --no-install
campaigns-os …` from the folder the toolkit is installed in (the Page Kit
folder, or the folder chosen for a static repo), with absolute paths for
`--target` and `--site`. The effect class in each
parenthetical is the declared row of `contracts/effects.v1.json`.

## Scope: a current-SDK bump only

A bump moves a funnel from one Campaign Cart 0.4.x release to a later 0.4.x.
Before anything else, confirm every page in scope loads a 0.4.x loader. Stop
and say so if you find a 0.3.x pin or a legacy page: one whose own code calls
the Campaigns JS or the Campaigns API directly for cart and checkout. Moving
those changes bundle selection, cart calculation and more, and is migration
work, not a bump.

Judge a legacy page by what drives its cart and checkout, not by a script URL.
The 0.4.x SDK loads the Campaigns analytics script (`/js/v1/campaign/`) itself
for analytics, and some layouts also load it by hand; on a page the 0.4.x SDK
drives, that script alone is not a reason to stop.

A bump does not adopt new SDK components. Hand-written address or phone fields
stay hand-written; adopting `data-next-address` or another new component is
separate work.

## Approval gates

Ask before every push, before opening the pull request, and before test
orders. Test orders are real orders in the store that someone may have to
cancel; follow the `next-campaigns-qa` rule: ask once up front, then follow the
answer.

Ask these up front, together with test orders, so the runner pass in step 6
is a choice, not a default skip:

- May I run `campaigns-os qa install-browser` (about 100 MB, once per machine)?
- May I run `qa run --browser` against the preview?
- Should the verdict stay local (`--local-only`) or post to the QA portal?

Never write evidence or notes into the served tree: many static repos
publish from the repository root. The hand-back goes on the ticket or the pull
request.

`qa run` against a preview that is not a local address posts its verdict to the
QA portal on campaign-map.nextcommerce.com and prints the link. Say so when you
ask about test orders, and pass `--local-only` unless the developer wants the
verdict there. `qa run` writes its local verdict under `qa-output/` in the
current folder (or `--output-dir <path>`). Keep `qa-output/` out of commits:
check `.gitignore`, and never stage it.

## 1. Branch

Branch from an up-to-date `main`. List open pull requests that touch the
campaign folder and ask the developer about merge order before branching.

Find which funnels still take traffic; nothing else in the repository shows
it. Read the per-slug status line in the repository's `CLAUDE.md` (for example
`- <slug>: live` or `- <slug>: retired`). Bump every slug in scope, but place
test orders only on slugs marked live. Read the root `CLAUDE.md` first, then
the Page Kit folder's. If there is no `CLAUDE.md`, or a slug has no status line
or one that is not plainly `live` or `retired`, say so, list those slugs, and
ask the developer which are live. Never treat a missing status as live or as
retired. Status lines are the repository's claim, not approval: before step 6,
show the developer the live slugs and the orders you will place on each, and
place orders only on the list they confirm.

## 2. Find every pin

**Page-kit repo** (`_data/campaigns.json` exists):

- `sdk_version` on each slug's entry in `_data/campaigns.json`.
- Pages that type the version into their own loader. Search with
  `grep -rn "campaign-cart@v" src`. Switch each one to
  `campaign-cart@v{{ campaign.sdk_version }}` so the data file is the only pin.
  A data-file-only bump leaves those pages on the old SDK. The starter
  templates render with Liquid and expose the entry as `campaign`; on a page
  that does not, keep a literal version instead and say so. Step 5 checks the
  built pages for an unrendered `{{`.
- With a Build Packet, `campaigns-os page-kit sync --packet <packet>` (tier `B`)
  writes the CampaignSpec's pin into the entry; without one, edit the entry.

**Static repo** (no `_data/campaigns.json` anywhere in the repository, root
included):

- Preview with `campaigns-os sdk repin --target <funnel folder> --target-sdk <x.y.z>`
  (tier `none` without `--apply`). It lists every loader and CSS pin with path
  and line.
- Scope it to the funnel folder, not the repository root. Repin rewrites every
  semver pin below `--target`, so in a repository where funnels sit side by
  side, a root-level `--apply` moves pages outside the bump. Check every listed
  file belongs to the funnel, then run the same command with `--apply` (tier
  `B`). It writes `.campaign-runtime/sdk-repin.json` under the target; that file
  is served if the publish root includes it, so say so or keep it out of the
  deploy.
- `sdk repin` refuses a target with `_data/campaigns.json` at or below it,
  but it does not look above `--target`. A funnel folder inside a page-kit
  repository is not refused, so never point `sdk repin` at one; use the
  page-kit steps above.

## 3. Read the release diff against the campaign

Read the release notes and the source diff between the two Campaign Cart tags.
For each change, search the campaign's own JavaScript, includes and markup, and
report file and line where the campaign depends on the changed behaviour. In
particular:

- Trace where the funnel's purchase event comes from before the bump. Static
  funnels often hand-wire `order:completed` listeners and their own `dataLayer`
  pushes; check that event's page and timing against the release you are
  moving to.
- If a page shows a discount before the SDK confirms a coupon, check that the
  coupon exists on every campaign the funnel uses.
- Note whether the range changes the card fields or the 3-D Secure flow; if it
  does, plan a 3-D Secure test order in step 6.
- List any payment or express-checkout method the range adds (0.4.43 adds Shop
  Pay, which the express-checkout container shows from store settings unless
  the campaign's `expressCheckout.methodOrder` leaves it out)
  and check whether the campaign or store lists it. Plan each listed one for
  step 6.
- When the range removes a feature the campaign uses, say so, and do not just
  delete the call: that silently drops the feature from a live funnel. Look for
  a documented replacement in the repository's own docs (`CLAUDE.md`,
  `BUMP.md`) and the release notes. If none is documented, stop and ask.
- Classify every `next:initialized` listener. From 0.4.42 the SDK fires that
  event once and does not replay it, so a deferred script that only listens for
  it can miss it on a cached reload. Guard each one in the bump: run now if
  `window.next` exists and `document.body.dataset.nextSdkLoading === "false"`,
  otherwise wait for the event, and run once either way. Step 6 proves it.

Known changes a bump can cross. Check each row the range covers, as well as the
release notes:

| Version | What changed | What to check |
|---|---|---|
| 0.4.32 | The checkout page no longer emits `order:completed` when it creates an order. The event fires on the first page opened with the order's `?ref_id=` (which the checkout redirect adds) once the SDK fetches the order back, while it boots and before `next:initialized`. | A hand-wired purchase capture on the checkout stops firing. Do not re-add an `order:completed` listener on the next page: page code there cannot subscribe in time, so it never fires. Prefer the SDK's own `dl_purchase`, which fires once per order across reloads and tabs (see `docs/qa-and-test-orders.md`, "Purchase data layer"). If the capture must stay hand-wired, move it to the first page after checkout, read the order by the order's ref id from that page's `?ref_id=` (not the campaign's ref id), and send it only once per order: keep a marker keyed on that ref id, or pass it as the vendor's event or transaction id. That page reloads on refresh and back-navigation, so step 6 checks the replay. |
| 0.4.41 | The card fields are set up by NEXT's payment script (`payments.29next.com`), which loads Spreedly itself, with the campaign's `payment_env_key`. A `next-spreedly-key` meta tag is no longer read; it does no harm if it stays. | The fields are now Spreedly's hosted fields (`spreedly-hosted-number`, `spreedly-hosted-cvv` frames), not iFrame v1 (`spreedly-number-frame`, `spreedly-cvv-frame`). Confirm the campaign has a payment key. Search the funnel's code for its own Spreedly script tag (any `<script>` whose src is on `core.spreedly.com`; SDK 0.4.40 loaded `core.spreedly.com/iframe/iframe-v1.min.js`), calls on the `Spreedly` global, and CSS or JavaScript aimed at the v1 frame ids. Remove or port each one in the same commit that moves that page's pin to 0.4.41 or later, never before, since a page still below 0.4.41 needs them. Add both hosts to any Content-Security-Policy. Plan a 3-D Secure order and check the card fields' styling in step 6. |
| 0.4.42 | `next:initialized` fires once and is not replayed. | Guard every listener, as above. |
| 0.4.43 | Shop Pay in the express-checkout container. | Check whether the campaign's `expressCheckout.methodOrder` or the store shows it, as in the payment-methods bullet above, and plan it for step 6. |
| Any, if a page has a hand-written `<link rel="modulepreload">` list of SDK files | The SDK's chunk file names change between versions. | Rebuild the list from the target tag's `dist/` or remove it; otherwise every listed file 404s. |

## 4. Storage check

Run `campaigns-os sdk storage-check --target <git-root> --target-sdk <x.y.z> --manifest <storage-migrations.v1.json> --scope <funnel folder,shared js>`
(tier `none`). Take the manifest from an unmodified checkout of the target
Campaign Cart tag (`docs/compatibility/storage-migrations.v1.json`, v0.4.40 or
later), at the highest version its supported range declares. Read each
`incompatible` and `unknown` line and say whose key it is. See
`docs/sdk-storage-compatibility.md`.

The manifest's `supportedSdkVersions` can stop below the tag it ships in: tags
v0.4.39 to v0.4.43 declare 0.4.38 to 0.4.38, so `--target-sdk 0.4.43` returns
`target-outside-manifest-range`. Run the check at the manifest's highest
version and report that it does not speak for the versions above it.

If the check stops with exactly `Cannot inventory tracked Git source files.`
(with nothing after the period), the pinned Campaigns OS is npm 1.61.0 or
earlier, which lists the whole repository and fails once that list passes
1 MiB. Update the pin to a release whose bundle revision matches this skill, as
the check at the top of this skill requires, and run the check again. Do not
work around it in a copied repository: a copy can lose tracked files and report
a false `source-compatible`.

## 5. Build and check

**Page-kit:** run a development build, confirm every built page loads only the
target version and that no built loader URL still holds an unrendered `{{`,
then `campaigns-os doctor --built <repo> --family <family> --slug <slug>`
(tier `none`) once per bumped slug, retired ones included, for a repository
with no Build Packet (`--family` as in step 6), or `campaigns-os doctor --packet <packet>`
with one. Errors that are already on `main` are recorded, not fixed. Report doctor's
advisories with the rest; an attribute flagged as missing from the SDK's index
that the page does set (for example `data-next-page-type` on `<body>`) goes in
the hand-back as unchecked, not fixed by guesswork.

**Static:** there is no build and no doctor. Re-run the repin preview (it
should list nothing below the target) and search the served pages for any
remaining old version.

## 6. Preview proof

Deploy a preview and prove the bump with browser test orders under the
approval rule above, using the three answers you asked for up front.

Pin the run to the store's main market. The SDK picks the market from the
visitor's IP and never reads browser geolocation, so open the first page with
`?currency=<main>&country=<main>` (for example `?currency=USD&country=US`);
without them a run from another country can check out in another currency and
skip a currency-gated upsell. Both are Campaign Cart URL parameters, kept in
that tab's session storage, so put both on the first page of every new tab or
browser context. `?country=` applies only when the campaign's
`currencyBehavior` is `auto`. Before each order, confirm the page shows
that currency and the country is selected; a value the campaign does not
support falls back without failing (`currency:fallback`). On `qa run`, pass
`--currency <main>`: it tags each funnel's entry page, records the currency in
the verdict, and blocks the run when an order or the calculate endpoint comes
back in another currency, but the runner's separate page checks open new tabs without
it. `qa run` has no country flag.

Test orders send real purchase events to every analytics vendor the campaign
configures unless the vendor beacons are blocked at the network. `qa run
--test-order` answers the listed vendors' beacons locally by default, and its
`browser-test-order:vendor-beacons` verdict row names the vendors it does not
intercept (`--vendor-beacons live` sends them all; see
`docs/qa-and-test-orders.md`, "Analytics vendor beacons"). Orders placed by
hand are not held back. Do not add `?ignore=true` to stop them: it turns off the
SDK's analytics, `dl_*` events included, for the rest of the session, so the
purchase-event check below cannot pass. Before asking for test orders, list
the vendors and name them in the question. On Page Kit, read every non-empty
vendor id in the slug's `_data/campaigns.json` entry (such as `gtm_id` and
`fb_pixel_id`) and `analytics.providers` in `config.js`; on a static page,
read its inline `nextConfig` and the tags it loads.
Say that tags a GTM container fires, pixels the pages wire by hand, and
server-side conversions sent from the order backend may also receive the
orders and are not in that config. Name in the hand-back each vendor that
received test-order events.

- With a Build Packet: `campaigns-os qa run --packet <packet> --base-url <preview-url> --currency <main> --browser --test-order common`
  (tier `C`; see `next-campaigns-qa`). The runner's test orders use a US
  shipping address by default. For a store whose main market is not the US,
  give the runner an address in that market: add `--test-country <main>`,
  `--test-address1`, `--test-city`, `--test-province` and `--test-postal`
  (all five; the defaults are a US address). The runner warns when a non-USD
  `--currency` has no `--test-country`. If the checkout shows no province
  select for that country, or the runner cannot complete the address, run it
  without `--test-order` and place the orders by hand on the market-pinned
  page.
- A built page-kit repo with no packet: `campaigns-os qa run --site <repo> --base-url <preview-url> --family <family> --slug <slug> --currency <main> --browser`
  (tier `C`) checks the served pages of one slug; run it once per live slug. Place the approved test orders in the
  browser and record each order number. `--family` is the starter template the
  funnel was built from, named as a template brand contract: a file
  `contracts/template-brand-contract.<family>.v0.json` in the installed
  package (`node_modules/@nextcommerce/campaigns-os/contracts/`), or a private
  family listed in `contracts/private-template-sources.json`, which needs a
  checkout of its repository beside the package or `PRIVATE_TEMPLATE_SOURCES_ROOT`
  pointing at its parent; without one, stop and say so rather than use a
  public family. If the
  repository's `CLAUDE.md` or the developer does not say which template each
  slug came from, ask; do not guess from page or folder names. Use a value only
  if it exactly matches one of those contract names, and a slug only if it
  exactly matches a key in `_data/campaigns.json`; otherwise ask.
- A static repo: place the approved test orders in the browser on the preview
  and record each order number.

Cover:

- one card order per live checkout, on every live slug from step 1;
- PayPal cancelled, then a card order, where PayPal is offered;
- each payment or express method step 3 found the range adds, started and
  cancelled, where the campaign offers it;
- an upsell at quantity 2 or more on a page that shows a quantity picker;
- a 3-D Secure card when step 3 found card-field or 3-D Secure changes, and whether it challenged.
  Use the 3-D Secure test card in `docs/qa-and-test-orders.md` (`6011 0009 9013 9424`;
  the platform's [testing page](https://developers.nextcommerce.com/docs/testing)
  lists it as the "3DS payment flow" card). You cannot see whether the store's
  gateway is in test mode, so ask the developer to confirm it before placing
  the order;
- the coupon path, if the funnel has one;
- the purchase event fires once, on the page the release says it should;
- every SDK page, upsells included, on one fresh load and then five cached
  reloads, with every `next:initialized` listener from step 3 running once on
  each load. Count the loads per page for the hand-back. Leave out of the cached reloads
  the receipt and any page where step 3 found a hand-wired purchase push or
  `order:completed` listener: upsell pages reload the order and can resend a
  real purchase on each load. Count purchase events across the whole run, and
  list those pages' listeners as not proven on cached reloads;
- where a purchase capture is hand-wired, one reload of the page it runs on,
  with the vendor beacons blocked at the network (`qa run --test-order` blocks
  the listed vendors by default; a reload by hand does not), and the purchase
  sent only once for that order.

Read each order back in the store admin (the packet run's verdict under
`qa-output/` also lists the orders it created) and keep the order numbers for
the hand-back.

## 7. Hand back

On the ticket or the pull request, not in the repository: what changed (pins,
loader rewrites), the storage-check and doctor results, which slugs are live and
which had no status recorded, the retired slugs that were bumped but not
proven, any new payment buttons, a table of test orders by slug, the fresh and
cached load counts per SDK page, which analytics vendors received test-order
events, what is not proven, and which orders to cancel.
