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

## The PR-only gates, run locally

`npm run check` is the structural half of CI. Three gates need a comparison
point and run in CI only on pull requests, against the PR's base commit; a
green `npm run check` says nothing about them. Before opening or updating a
PR, run the same three against the branch you will merge into:

```bash
node ./scripts/check-skill-versions.mjs --base origin/main    # changed skill packages advance their version
node ./scripts/check-supported-surface.mjs --base origin/main # changed hashed surface advances surface_version
node ./scripts/check-release-ledger.mjs --base origin/main    # agent-relevant changed paths have a ledger entry
```

Fetch first (`git fetch origin main`) so `origin/main` is the base CI will
use. Pushes to `main` run none of the three (the checkout is shallow there),
so a direct-to-main commit is gated only by what its PR ran.
