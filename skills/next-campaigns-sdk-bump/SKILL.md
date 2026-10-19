---
name: next-campaigns-sdk-bump
version: 1.0.0
description: Bump a live campaign's Campaign Cart SDK from one 0.4.x release to a later 0.4.x on a page-kit or static repo — find every pin, check the release diff and storage against the campaign's own code, prove on a preview with approved test orders, and report what is not proven.
---

Bundle revision: 1.59.0+skills.4
Run `npx --no-install campaigns-os tooling status --skills-revision 1.59.0+skills.4`
from the campaign's Page Kit folder, where it runs the project's pinned copy and
never installs one, at the start of each task. Start a fresh session if it
reports `mismatch`: this text is already in your context and is never re-read
while the CLI on disk can move under it. If the output has no `Skills revision:`
line (no `revision_check` under `--json`), a campaigns-os older than this check
answered; follow none of its actions and run the pinned copy.

# Next Campaigns SDK Bump

Use this when someone says "bump this campaign to SDK 0.4.x". The developer
installs the toolkit, asks for the bump, approves each push, the pull request
and each test order, then reviews and merges. Everything here uses existing
commands; there is no new write or order capability.

In the instructions below, bare `campaigns-os …` means `npx --no-install
campaigns-os …` from the campaign folder. The effect class in each
parenthetical is the declared row of `contracts/effects.v1.json`.

## Scope: a current-SDK bump only

A bump moves a funnel from one Campaign Cart 0.4.x release to a later 0.4.x.
Before anything else, confirm every page in scope loads a 0.4.x loader. Stop
and say so if you find a 0.3.x pin, the legacy Campaigns JS, or a direct
Campaigns API script: moving those changes bundle selection, cart calculation
and more, and is migration work, not a bump.

A bump does not adopt new SDK components. Hand-written address or phone fields
stay hand-written; adopting `data-next-address` or another new component is
separate work.

## Approval gates

Ask before every push, before opening the pull request, and before test
orders. Test orders are real orders in the store that someone may have to
cancel; follow the `next-campaigns-qa` rule: ask once up front, then follow the
answer. Never write evidence or notes into the served tree: many static repos
publish from the repository root. The hand-back goes on the ticket or the pull
request.

## 1. Branch

Branch from an up-to-date `main`. List open pull requests that touch the
campaign folder and ask the developer about merge order before branching.

## 2. Find every pin

**Page-kit repo** (`_data/campaigns.json` exists):

- `sdk_version` on each slug's entry in `_data/campaigns.json`.
- Pages that type the version into their own loader. Search with
  `grep -rn "campaign-cart@v" src`. Switch each one to
  `campaign-cart@v{{ campaign.sdk_version }}` so the data file is the only pin.
  A data-file-only bump leaves those pages on the old SDK.
- With a Build Packet, `campaigns-os page-kit sync --packet <packet>` (tier `B`)
  writes the CampaignSpec's pin into the entry; without one, edit the entry.

**Static repo** (no `_data/campaigns.json`):

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
- `sdk repin` refuses a repository with `_data/campaigns.json` anywhere in the
  scan; that is a page-kit repo.

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

## 4. Storage check

Run `campaigns-os sdk storage-check --target <git root> --target-sdk <x.y.z> --manifest <storage-migrations.v1.json> --scope <funnel folder,shared js>`
(tier `none`). Take the manifest from an unmodified checkout of the target
Campaign Cart tag (`docs/compatibility/storage-migrations.v1.json`, v0.4.40 or
later), at the highest version its supported range declares. Read each
`incompatible` and `unknown` line and say whose key it is. See
`docs/sdk-storage-compatibility.md`.

## 5. Build and check

**Page-kit:** run a development build, confirm every built page loads only the
target version, then `campaigns-os doctor --built <repo> --family <family> --slug <slug>`
(tier `none`) for a repository with no Build Packet, or `campaigns-os doctor --packet <packet>`
with one. Errors that are already on `main` are recorded, not fixed.

**Static:** there is no build and no doctor. Re-run the repin preview (it
should list nothing below the target) and search the served pages for any
remaining old version.

## 6. Preview proof

Deploy a preview and prove the bump with browser test orders under the
approval rule above. Pin the browser to the store's main market: a run
geolocated elsewhere can order in another currency and skip a currency-gated
upsell.

- With a Build Packet: `campaigns-os qa run --packet <packet> --base-url <preview-url> --browser --test-order common`
  (tier `C`; see `next-campaigns-qa`).
- A built page-kit repo with no packet: `campaigns-os qa run --site <repo> --base-url <preview-url> --family <family> --browser`
  (tier `C`) checks the served pages. Place the approved test orders in the
  browser and record each order number.
- A static repo: place the approved test orders in the browser on the preview
  and record each order number.

Cover:

- one card order per live checkout;
- PayPal cancelled, then a card order, where PayPal is offered;
- an upsell at quantity 2 or more on a page that shows a quantity picker;
- a 3-D Secure card when card fields changed in the range, and whether it challenged;
- the coupon path, if the funnel has one;
- the purchase event fires once, on the page the release says it should.

Read the orders back.

## 7. Hand back

On the ticket or the pull request, not in the repository: what changed (pins,
loader rewrites), the storage-check and doctor results, a table of test orders,
what is not proven, and which orders to cancel.
