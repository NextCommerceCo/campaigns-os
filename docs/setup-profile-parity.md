# Setup Profile Parity

Campaigns OS should define neutral setup concepts without owning private browser
automation. Browser harnesses, account-specific setup flows, and internal
dogfood scripts stay outside the public package unless they are sanitized and
promoted as reusable contracts.

A setup profile is the public description of what must be true before build/QA:

- CampaignSpec exported and cached locally.
- Campaign App campaign identity and public route slug known.
- Campaigns API key source recorded.
- SDK origin allowlist state recorded.
- Target page-kit repo and output directory known.
- Selected template family locked.
- Store Profile fields present for page-kit `_data/campaigns.json`.

Parity means the packet and stage reports can explain whether the tested local,
preview, or production origin matches that setup profile:

- localhost origins are Development domains for SDK initialization and analytics
  suppression;
- non-localhost preview/production origins require SDK allowlist confirmation;
- typed-card proof depth is recorded in `qa.proof_policy`, not negotiated in
  chat;
- setup automation evidence is referenced by path or command, not embedded in
  public artifacts.

## Store Profile checkpoint

For page-kit packets, doctor and direct QA compare the CampaignSpec to the target
campaign entry across one fixed matrix: `store_name`, `store_url`,
`store_terms`, `store_privacy`, `store_contact`, `store_returns`,
`store_shipping`, `store_phone`, and `store_phone_tel`. Known demo URLs and both
demo phone spellings are blockers. Target-only values remain visible warnings.
Missing target data is `not_applicable` only before scaffold; it blocks without
a waiver lane when setup/assembly is terminal or output already exists.

Repair is preferred. When an exact, valid mismatch is intentionally accepted,
use the registered checkpoint command with a named human, a reason, and at least
one decision bound:

```bash
campaigns-os checkpoint waive \
  --packet campaign-runtime.build.json \
  --gate page_kit.store_profile \
  --reason "<why>" \
  --waived-by "<named human>" \
  --expires-at 2026-09-01T00:00:00.000Z
```

`--review-condition "<trigger>"` may replace or accompany the expiry. The
waiver is exact-state evidence in the Assembly Report's top-level `waivers[]`:
changing the spec or target discrepancy makes it stale. Missing/malformed
evidence and non-string governed values are not waivable. Doctor and `next`
report `ready_with_waivers`, not clean readiness; QA keeps the attributed
warning and reports `ready_with_exceptions`.

`checkpoint waive` is deliberately a staged registry. Store Profile is the
only registered gate in this release; future SDK/polish gates may extend it.
Source, theme, and QA waiver lanes keep their existing artifact/commands until
registered. Do not route an unregistered gate through Store Profile or claim the
generic command already owns every waiver.

The campaigns loader may inspect the raw entry for these checks, but public
doctor/next/sidecar/QA artifacts expose only loader status, normalized route
slug, relative target path, and the governed nine-field matrix. Emails,
analytics IDs, pixels, and arbitrary entry fields stay private to validation.

Public Campaigns OS can add schema fields, doctor checks, and docs for these
concepts. It should not include account-specific login flows, private browser
recordings, or internal dogfood lifecycle automation.
