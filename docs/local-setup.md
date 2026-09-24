# Local campaign setup

For a new campaign, choose its working folder and run this from that folder:

```sh
npm install --save-dev --save-exact @nextcommerce/campaigns-os@1.43.1 next-campaign-page-kit@0.2.0 && npx --no-install campaigns-os tooling setup --target . --platform claude
```

Review the release source/provenance before installation as described in
`AGENTS.md`. npm installs the dependencies first; `--no-install` then runs only
the project's installed CLI. Keep `package.json` and `package-lock.json` in
Git. For an existing project, preserve its reviewed pin: run `npm ci`, then
`npx --no-install campaigns-os tooling setup --target . --platform claude`
on a release that supports setup. Changing the pin is a separate update.

Setup checks the exact toolkit pin, its lockfile version and the installed
page-kit dependency before it changes files. It composes the existing
installers to:

1. Install the QA browser through this toolkit's own Playwright package.
2. Install the bundled skills into `~/.claude/skills` (same-name skills are
   refreshed just as with `install-skills`).
3. Install the four context files under `.campaign-runtime/agent-context`
   and the managed runtime ignore block.
4. Append one import to the project's `CLAUDE.md`, preserving existing text.

The import uses Claude Code's documented
[`@path` syntax](https://code.claude.com/docs/en/memory#import-additional-files).
Existing context that differs from the bundle and symlink destinations require
reconciliation before setup; setup does not overwrite them. A repeated run
preserves campaign pages, authored decisions and project instructions. If the
browser download fails, fix that error and rerun setup; shared skills and
project files have not been changed. If the runtime ignore block cannot be
written, setup reports `context_install_failed`; fix `.gitignore` and rerun.
`--dry-run --json` previews setup without any writes or browser download.

Restart Claude Code in the campaign folder. Use the `next-campaigns-os` skill
and provide the configured campaign details, HTML/assets and brief. The agent
authors a local CampaignSpec if there is no saved Map export; follow the
[local-spec entry](build-packet.md#local-spec-entry). The skill checks its
loaded bundle revision against the project copy.
`restart_required` means the files are installed; it does not prove that the
running agent has loaded them. Check Claude's `/context` view if the project
instructions are missing.

Setup does not scaffold template pages, create a CampaignSpec, connect the
gateway, change a saved Map, run a campaign session, remit telemetry, or prove
checkout. The agent performs intake and chooses the template before assembly.
A local spec uses `spec_identity.local_spec_id` and keeps its evidence in the
repository. Existing doctor/QA gates still apply. This entry is Claude Code first; other agents retain their existing
manual installation path.
