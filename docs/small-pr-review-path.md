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
