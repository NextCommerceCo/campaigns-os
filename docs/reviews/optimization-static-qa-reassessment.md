# PR #288: ordered admission and concurrent fetching

Please reassess comment 3939162926 against `d9eaf40` and the existing regression
tests. The alleged deadlock or pre-budget serialization did not reproduce.

`load()` starts `fetchPage(page)` before awaiting the predecessor admission.
Requests overlap; retained bodies and returned results are admitted in invocation
order so the same pages cross the budget as in sequential execution. Even an early
budget return from fetchPage passes through load's finally, awaits the predecessor,
and releases its own turn. The queue dependency points only to earlier requests.

Suppressing new network work after the budget is exhausted preserves the existing
resource policy. Already-started responses may finish. Removing the budget gate
would fetch pages that cannot be retained and change that policy.

All 26 tests in src/qa-commercial-parity.test.mjs passed during remediation:

- Concurrent admission test starts three requests before releasing any response,
  then releases them in reverse order and verifies page-order budget outcomes.
- That test verifies duplicate URL promise identity and that a fourth request
  starts no network work after overflow.
- Failure and timeout tests prove predecessor errors release later admission.
- Exact-budget coverage preserves the sequential error outcome.
- Bounded mapper coverage proves four operations overlap and outputs keep order.

Please withdraw the warning if these semantics satisfy the contract, or provide a
failing request sequence. No executable code changes in this commit; the rationale
is committed so automatic review can reassess without account-linked bot mentions.
