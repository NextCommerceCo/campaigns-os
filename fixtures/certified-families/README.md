# Certified families — rendered reachability fixtures

The rendered output (`*.html` and `config.js`) of every certified starter
family, built with page-kit from `NextCommerceCo/campaign-cart-starter-templates`
at the commit `manifest.json` names (`source_sha`, with `source_note` saying
why). The default is the commit the vendored commerce-surface catalog was
synced from (`_synced_from_sha`); when the two differ the reachability test
prints a diagnostic, which is the standing reminder to re-sync the catalog.

This tree exists for one reason (#206 ON-2 closeout, failure mode #5,
"gate-first, capability-later"): **a built-output doctor gate ships with proof
that it passes on real pages from every certified family before it is allowed
to block anything.** `polish.hidden_eager_media` shipped without that proof,
could never pass on a live-SDK page, and an operator had to patch the tool
mid-run to finish. `src/doctor-certified-family-reachability.test.mjs` runs
`doctor --built` over each family here and asserts every static built-output
gate is `pass` or `not_applicable`, never `blocked`. A new gate adds its
assertion there in the same PR that adds the gate.

Not a hand-authored fixture. Regenerate, never edit:

```bash
node scripts/refresh-certified-family-fixtures.mjs
```

It needs the templates checkout as a sibling (or `STARTER_TEMPLATES_PATH`)
with `next-campaign-page-kit` installed there; CI cannot render, which is why
the render is committed. One rewrite is applied and recorded in the manifest:
the `<link rel="dns-prefetch">` / `<link rel="preconnect">` resource hint for the campaign API host is dropped, because
that host is on this repository's private-string denylist and a resource hint
carries no SDK-markup meaning. Everything else is byte-for-byte the render.
