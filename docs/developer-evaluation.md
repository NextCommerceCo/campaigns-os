# Developer Evaluation

Use a shared golden scenario before assigning individual edge cases.

Recommended shared scenario:

- Template family: `olympus`
- Source adapter: `html_funnel`
- Local exported CampaignSpec
- Prepared HTML/assets
- Test orders disabled unless the deployed domain is allowlisted and the approved order count/path depth is clear

For AI-generated or synthetic source exercises, explicitly tell evaluators that
the generated HTML is a source artifact, not final page-kit markup. They should
convert it before build by stripping document wrappers, adding frontmatter, and
extracting shared CSS/assets when useful. If the scenario does not have a real
Campaigns App campaign/store, assign a designated test store/API key or mark
checkout/runtime QA as intentionally blocked.

Round-two alternatives:

- `demeter`
- `shop-single-step`
- partial-scope builds where only presell/landing or only upsell/downsell pages
  are produced and the remaining CampaignSpec pages are marked with
  `source_html.pages[].skip_reason`

Capture friction as issues, not as side-channel notes. Use the issue templates in `.github/ISSUE_TEMPLATE`.

## First Prompt

Use `prompts/first-build.md` as the starting prompt for testers.
