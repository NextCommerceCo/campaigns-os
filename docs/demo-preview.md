# Offline sample preview

`campaigns-os demo` ships in 1.37.0 and later; install an exact published
release at least 1.37.0 (or a reviewed full-SHA source pin).

From the folder containing your exact project-local toolkit installation:

```bash
npx --no-install campaigns-os demo --target ./apollo-sample
```

Open the printed `landing/index.html` file directly. No server or browser
installer is required. The command creates only a new directory whose parent
already exists; existing directories, files and symlinks are refused. Only
`--target` and `--help` are accepted. `--no-write`, `--dry-run`, force, merge
and overwrite flags are rejected before creation.

The banner links landing, checkout, upsell and receipt pages. Sample commerce
controls are disabled. This is a static visual projection: no SDK, JavaScript,
forms, live orders, campaign configuration, telemetry, sessions or evidence.
It remains sample-only even when invoked inside an active or stale campaign.
The command copies the reviewed bundled files without downloading a template
or running Page Kit or a CSS compiler. The bundle uses early restrictive CSP
and only local relative assets. No external resources are fetched.

To begin a real campaign, keep any sample edits and create a separate new Page
Kit folder. Follow [quickstart](quickstart.md) with a real saved Map or spec,
credentials and source pages. There is no automatic demo conversion. The demo
milestone grants neither saved-Map status nor build, preview or QA proof; see
[activation and evidence](activation-and-evidence.md).

## Provenance and regeneration

The projection uses NEXT's Apollo template at
`11352c30c596db258679fd3a552b906086b11bb9`, built by the published
`next-campaign-page-kit@0.2.0` CLI (source commit
`eed0679b1d02ef5cbe7f21964165c4202724d91d`) and `tailwindcss@3.4.17`.
Template design tokens are retained, with a deterministic `system-ui,
sans-serif` typography fallback. Swiper is projected to its first static slide.
Two obsolete stock CSS backgrounds with no files at the pinned commit are
removed. The receipt's runtime skeleton overlay is removed.

`demo/apollo-v0/provenance.json` records input hashes, exact pins, the toolchain
lock hash and every output file hash. `NOTICE.txt` retains factual template
attribution and Page Kit/Tailwind MIT notices; it grants no additional template
licence. The provenance manifest is a hashed supported artifact. Other static
files are internal to this fixed projection and validated against that manifest.

Maintainers regenerate from a disposable workspace using the pinned toolchain:

```bash
npm ci --ignore-scripts --prefix scripts/demo-toolchain
node scripts/regenerate-demo.mjs --write
```

The script invokes published `campaign-init` against the full Git ref, builds
only the four selected pages with `campaign-build`, transcribes the fixed
Tailwind theme without executing source configuration, and validates the inert
output before replacing the repository's bundle. Raw source, configuration,
data, JavaScript, Maps, QA/run files and source maps are excluded. Review changed
bytes, update the supported provenance hash and release ledger, then run the
required checks and file-based browser proof before accepting regeneration.
