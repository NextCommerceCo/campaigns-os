# Redacted support diagnostics

Requires Campaigns OS 1.35.0 or later. If that version is not yet published to
npm, install a reviewed full-SHA source pin as described in the quickstart.

From the campaign folder:

```bash
npx campaigns-os tooling diagnose --platform codex --packet campaign-runtime.build.json
npx campaigns-os tooling diagnose --platform codex --packet campaign-runtime.build.json --json > diagnostic.json
```

Omit `--packet` for installation and skill diagnostics only. Use `--platform
claude` for a Claude-only profile. `--context` and `--report` may select existing
local sidecars; `--target` selects a local skills directory. These inputs are
never included in the export. The text and JSON forms are suitable for review
and copying to a support request. The command itself sends nothing.

The `campaigns-os-diagnostic/v0` summary is an allowlist projection of existing
`tooling status` and read-only `doctor` producers. Its stage comes from doctor's
`next` block, which uses the existing lifecycle picker. It does not execute
`next`, install, fetch campaign data, run a browser, publish, remit, deploy,
create an order, sweep a stale run session, or write retained campaign evidence.
Mutation flags do not change that behavior. Export success means a summary was
produced, including when its inspection is unavailable; consult its statuses.

The only exported fields are the schema version; a numeric package version or
null; install mode (`checkout`, `node_modules`, `global`, `npx_cache`,
`package_directory`, or `unknown`); coarse selected agent profile; tooling and
doctor statuses; existing next stage; freshness; fixed accepted reason/action
IDs; and fixed human-readable recovery owner, action, and input-needed text.
Unknown enum values become `unknown` with `diagnostic.unsupported_value`.
Unrecognized reason/action IDs become `diagnostic.unsupported_reason` or
`diagnostic.unsupported_action`; they are never copied or given authority.
Unsupported IDs need detailed local review, not a guessed repair.

Toolkit freshness is `pinned` only when a producer identifies a source pin,
`local_ref_current`/`local_ref_behind` for a checkout's existing local upstream
comparison, otherwise `unknown`. This performs no network freshness check.
An exact registry version and lockfile still identify installed bytes when a
source commit is not derivable. Inspection `observed` means local doctor
inspection succeeded, not that the served build, deployed campaign, or saved
Map revision is current. Missing inspection is `not_requested` or `unavailable`.
The diagnostic is neither an orientation envelope nor launch evidence.

The export excludes absolute paths, URLs, argv, environment, source content,
prompts, free-text findings, credentials, campaign/customer identities, and
order values. Producer exceptions are summarized with fixed unavailable IDs;
their raw messages are not exported. Detailed `doctor`/`next` output stays local
and can contain campaign data, so it is not a substitute for this export.

Recovery names who supplies the missing input. Inspect the detailed local
producer for the exact command and any campaign-specific input. If a QA verdict
was recorded but publication failed, follow `qa publish` recovery for that
retained verdict; never rerun checkout or create an order to republish evidence.
