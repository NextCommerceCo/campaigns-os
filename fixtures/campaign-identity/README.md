# Campaign identity — built-output fixtures (#301)

Three built `_site/` trees for the `built_output.campaign_identity` doctor
check, which fails a built campaign whose pages disagree about which campaign
they belong to. Everything here is synthetic; the API keys are visibly fake.

Each tree has the same three pages (`checkout`, `upsell-1`, `receipt`) sharing
one `config.js`, the shape every certified starter family renders: the API key
lives in the shared `config.js`, not in the page.

| Tree | What it proves |
|---|---|
| `clean/` | Same key, same `next-funnel`, a `setAttribution` call that agrees with the tag. The gate must pass. |
| `key-drift/` | `upsell-1` carries a `<meta name="next-api-key">` naming another campaign's key. The meta beats `config.js` in the SDK, so this page silently acts on the other campaign. The gate must name both files and both keys. |
| `attribution-drift/` | `upsell-1` was copied from a V1A flow and still calls `setAttribution({ funnel: "Example V1A" })` under a V2 `next-funnel` tag — the field instance this check was written for. The gate must name the call and the tag. |

The reachability proof for this gate (that it passes on every certified
family's real rendered output) lives in `fixtures/certified-families/`.
