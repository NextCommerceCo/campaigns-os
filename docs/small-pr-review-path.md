# Small PR Review Path

Use this path for narrow review comments that do not change package contracts,
runtime behavior, schema semantics, or production deployment.

Compact loop:

1. Read the line comment and the surrounding code.
2. Patch only the commented behavior.
3. Run the smallest targeted test that covers the line.
4. Run `npm run check` only when the changed surface touches shared contracts,
   CLI behavior, QA runtime, CampaignSpec validation, schemas, or package
   fixtures.
5. Push the branch and reply with the changed file plus test evidence.

Do not invoke plan audits, artifact sync, Greptile review, release routing, or
private dogfood automation for a one-line cleanup unless the comment reveals a
larger contract or safety issue.

Escalate to the normal branch + draft PR workflow when the fix changes:

- public schemas or contract catalogs;
- doctor/build/QA behavior;
- CampaignSpec validation rules;
- package exports or install behavior;
- deploy/launch readiness policy.

## The fast gates, before every push

`npm run check:fast` runs, in under a minute, everything CI's types and
contracts lanes run plus the three PR-only gates below against a freshly
fetched `origin/main`. Those are the checks pull requests fail most often
(changelog structure, the release ledger, skill versions, surface hashes,
generated docs), and in CI each failure costs a ten-minute run. The unit and
browser lanes still run only in CI.

`npm run hooks:install` makes it a pre-push hook for the clone and all of its
worktrees: every push of a branch runs the gates on the commit being pushed
(in a temporary worktree when the checkout has other changes) and is refused
when one fails. `git push --no-verify`, or `CAMPAIGNS_OS_PREPUSH=skip`, skips
it for one push; CI runs the same gates regardless. When a pre-push hook that
runs `pre-push.local` is already installed, the gate installs as
`pre-push.local` beside it.

CI splits the unit and browser lanes into two shards each, balanced by the
per-file run times in `scripts/test-durations.json`, and each shard starts
its slowest files first. When one shard's job starts taking clearly longer
than the other's, refresh them with
`npm run check:tests -- --record-durations` and
`npm run check:browser -- --record-durations` and commit the file. A stale
entry only unbalances the shards; every test still runs.

## The PR-only gates, run locally

`npm run check` is the structural half of CI. Three gates need a comparison
point and run in CI only on pull requests, against the PR's base commit; a
green `npm run check` says nothing about them. `npm run check:fast` runs them;
to run them alone, against the branch you will merge into:

```bash
node ./scripts/check-skill-versions.mjs --base origin/main    # changed skill packages advance their version
node ./scripts/check-supported-surface.mjs --base origin/main # changed hashed surface advances surface_version
node ./scripts/check-release-ledger.mjs --base origin/main    # agent-relevant changed paths have a ledger entry
```

Fetch first (`git fetch origin main`) so `origin/main` is the base CI will
use. Pushes to `main` run none of the three (the checkout is shallow there),
so a direct-to-main commit is gated only by what its PR ran.
