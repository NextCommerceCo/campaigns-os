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

Public Campaigns OS can add schema fields, doctor checks, and docs for these
concepts. It should not include account-specific login flows, private browser
recordings, or internal dogfood lifecycle automation.
