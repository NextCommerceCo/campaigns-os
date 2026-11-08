# doctor golden outputs

Pre-refactor captures of doctor's complete output, for #730 (shared, bounded
inputs for the built-output checks). They were taken at base
`e1c5bc9c6dc2745d6f2bd54f37f89319ce7f915a` (campaigns-os 1.66.0), before any
of the refactor landed. `src/doctor-golden.test.mjs` regenerates each case
and compares it with its file here.

## Rules for refactor changes

- A #730 refactor change must reproduce every file exactly. Any diff is a
  regression in that change: fix the code, do not regenerate.
- Regenerate only for a behavior change that is reviewed separately from
  the refactor, and read the diff before committing it:

  ```
  UPDATE_GOLDEN=1 node --test src/doctor-golden.test.mjs
  ```

  Only the exact value `1` regenerates, and the suite refuses to run in
  that mode when `CI` is set or when non-test files under `src/` have
  uncommitted changes. Regenerated goldens name the commit they ran on
  (`HEAD`) as `base_sha`, and the suite fails until `BASE_SHA` in the test
  is moved to that commit.
- Do not edit a file by hand. A case removed from the test must have its
  file removed too; the suite fails on a file without a case.

## Layout

One file per case, `doctor/<entry>-<case>.json`:

```json
{ "base_sha": "...", "case": "<id>", "entry": "built|packet|ci", "description": "...", "output": { } }
```

| Entry | Call | `output` |
|---|---|---|
| `built` | `doctorBuiltOutput(args)` | the result object |
| `packet` | `doctorPacket(packetPath, { outputBaseDir: null, liveCampaign: disabledLiveRead() })` | the result object |
| `packet` (`strip-paths-*`) | the same with `outputBaseDir: dirname(packetPath)`, as `doctor --strip-paths` and `start` call it | the result object |
| `ci` | `doctorCommand({ packet, ci: true }, { liveCampaign: disabledLiveRead() })` | `{ result, markdown }`, where `markdown` is `formatDoctorCi(result)` |

The cases cover the classes #730 names:

- **Initial / pre-build:** built (missing directory, `_site` with no
  campaign), packet (plain `examples/` copy), ci (missing output, missing
  assembly fingerprint).
- **Partial / unreadable:** built (dangling symlink page, missing local
  script, a page nested past the bounded parser's depth limit, a chmod 000
  page, a chmod 000 local script) and packet (a route
  whose `index.html` is a dangling symlink). At base the EACCES read escapes
  `doctorBuiltOutput`, so the two chmod cases pin the thrown error. They are
  skipped when the suite runs as root, which can read the file.
- **Capped:** built (501 pages; 17 scripts on one page; a 6 MiB page; a
  local script of exactly 1 MiB beside one of 1 MiB + 1 byte; and, for both
  the smoke checks and the cart placeholder check, a page exactly at the
  per-page candidate cap and the result cap beside a page one past it, so
  the findings kept before a cap are pinned and a cap moved by one in either
  direction changes the output) and packet (a 6 MiB page, which exceeds the
  html-scan retention budget).
- **Conflicting role:** built (route inference against live and commented
  `next-page-type` metadata, including a route that infers nothing) and
  packet (an upsell route carrying a copied checkout meta; a CampaignSpec
  upsell page at a route that infers nothing; a CampaignSpec checkout page
  at a `checkout-oto` route).
- **Waived:** packet (the upsell selector-scope gate under a literal waiver
  record, `waived_at` before and `expires_at` after the frozen clock; the
  same record expiring exactly at the frozen clock; the same record after
  the page changed, so its state fingerprint is stale; the same record for
  another route slug, so its subject is foreign).
- **Failing:** built (script syntax, the five blocking sdk-markup shapes,
  campaign identity drift, upsell selector scope, blocked script-syntax and
  sdk-markup gates that also carry advisories) and packet (script syntax,
  cart placeholders b4, content residue once assembly is completed, a stale
  build fingerprint with more than 20 drifted paths).
- **Every committed doctor fixture, read in place:** all eight certified
  families with `--family`; every `fixtures/cart-placeholders` tree; every
  `fixtures/sdk-markup` shape, `bad` (the four warn shapes as `advisory-*`)
  and `good`; `fixtures/script-syntax` and `fixtures/campaign-identity`,
  failing and clean.
- **Smoke checks:** built (anchor targets missing, inside a `<template>`,
  named only by a local script, and resolved, on one page) and packet (a
  recorded production build and a recorded development build, with the
  Tailwind CDN, a loopback URL, the primary asset host, and relative and
  absolute og:image values whose files are present or missing).
- **Packet-only projections:** live-reference build-noise exclusion
  (`404.html`, a `_drafts/` page and an off-spec page, seen in
  `derived.live_campaign_refs.checked_pages`), a current build fingerprint,
  a packet declaring a Design Source Package with nothing binding it (`next`
  refuses to bypass prepare-build), and two `--strip-paths` cases.
- **Causes:** a packet with a prior Run Record, and a built-output packet
  whose prior run had one finding at another status (`status_changed`) and
  one unchanged (`pre_existing`).
- **CI evidence debt:** current, owed after a copy-only page edit
  (`page_only`), owed after commerce markup and checkout edits, owed after a
  commerce attribute inside a `<template>` (`commerce_affecting`), and a
  prepared `examples/` packet with a real CampaignSpec and a blocked upsell
  gate, so CI's doctor half is pinned with its debt half. Every recorded
  build is written as literal fingerprints, manifests and commerce
  signatures, so it does not move with the implementation.

Inputs are the repository's own fixtures and `examples/`, or synthetic
trees the test writes into a temp directory. Nothing here comes from a real
campaign.

## What is normalized, and why

The suite assumes POSIX paths. It runs on macOS and Linux, as CI does; on
Windows `path.relative()` emits backslashes and the path tokens below would
not match.

Only three things:

1. **The clock is frozen**, not rewritten afterwards. The test mocks `Date`
   to `2026-01-01T00:00:00.000Z`, so `generated_at`, every QC `measured_at`
   and waiver-expiry decisions are fixed when doctor runs.
2. **Paths.** Every temp fixture root is created as `<parent>/root` and
   handed to doctor through the symlink `<parent>/via-link`. The symlink
   form is written `<fixture>`, the real path `<fixture-real>`, and the
   repository root `<toolkit>`, in every string. Because the two forms
   differ on every platform, a change that starts or stops canonicalizing a
   path doctor prints fails on Linux and macOS alike. The test then fails if
   either form, or any temp-directory path, is still present anywhere in
   the output, keys included.
3. **The root-escape run, in the two `strip-paths-*` cases only.** With
   `outputBaseDir` set, base doctor relativizes every absolute-looking
   string against the real path of the packet directory, root-relative
   public routes and URLs included: `/runtime-packet-demo/landing` becomes
   `../../…/runtime-packet-demo/landing`, with one `../` per segment of the
   temp directory's real path, which differs between machines. Exactly that
   run (no longer, no shorter) is written `<fsroot>/`; paths inside the
   fixture carry fewer `../` and stay as they are. This pins a current base
   quirk, `relativizeDoctorOutput` treating root-relative public routes as
   local paths, which is out of scope for #730; fixing it later shows up as
   a reviewed diff here.

Everything else stays as doctor produced it: finding order, messages,
metadata, fingerprints, coverage, `ready[]`, `derived.doctor_checks`,
`checkpoint_gates`, waiver assessments, QC rows (ids, results, state
fingerprints), `cause`/`cause_reason`/`cause_summary` and `next`.

The run is also hermetic: `fetch` throws, `PRIVATE_TEMPLATE_SOURCES_ROOT`
points at an empty directory (sibling private template checkouts stay out),
and `PRIVATE_TEMPLATE_SOURCES_PATH` and `CAMPAIGNS_API_KEY` are unset.

Directory order cannot reorder the output: every built-site walker that
lists more than one entry sorts what it lists. Of the readers that do not
sort, the price CSS scan, slug discovery and brand layers are never reached
with more than one entry. The content-residue walker sees several pages only
in cases that mark assembly completed; in each of them at most one page holds
residue findings, so walk order cannot reorder them. The
suite passes with `readdirSync` results reversed and hash-shuffled.

## One compacted case

`built-capped-page-count.json` needs 501 pages, which yields about 4,000 QC
rows and 2,000 warnings, well past the 2,000,000-byte limit of the
private-strings scan. Its `warnings` and `derived.qc_results` are stored as
`{ "compacted": { length, sha256, kept } }`: the array length, the sha256 of
the array's full normalized JSON, and in full every entry that names only
the first page (`p000`), the last page under the cap (`p499`) or the capped
page (`p500`), or no page at all, each with its index. A change to any entry
still fails. To see which entry moved, run the suite with
`DOCTOR_GOLDEN_DUMP=<dir>` on both checkouts and diff the full outputs it
writes.
