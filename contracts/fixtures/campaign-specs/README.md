# CampaignSpec Agent Fixtures

These JSON files are small CampaignSpec-shaped examples for agent reasoning and Sam review. They are not live Campaigns App exports and should not be used as production campaign data.

What they are for:

- Show which CampaignSpec/API values map into each starter template family's frontmatter.
- Give agents concrete examples for package refs, shipping refs, upsell vouchers, and receipt contracts.
- Keep template-family examples separate from readiness validation. These fixtures document the handoff shape; they do not prove a real campaign is launch-ready.

Fixture conventions:

- `sdk_hints.template_family` names the intended starter family for the fixture only.
- `sdk_hints.frontmatter` shows the frontmatter values an agent would write into the template.
- Numeric `ref_id` values are illustrative. Replace them from the target Campaigns API.
- `shipping_methods[].key` mirrors the starter frontmatter vocabulary, such as `standard` and `free`.

Run `npm run lint:agent-contracts` after changing these fixtures or `docs/commerce-surface-catalog.json`.
