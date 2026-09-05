# PR #286: remaining review findings

Please reassess the two remaining comments against the current contract and
`docs/reviews/optimization-doctor-reads.md`. The async lifetime finding was fixed
in `6eade1b` and verified by the subsequent remote review.

## Reservation is conservative by design

The 16 MiB accounting limit reserves raw bytes plus worst-case decoded UTF-16
text at admission. This deliberately admits approximately 5.3 MiB of raw files.
A digest-only entry can later be decoded within the same invocation; reserving
that capacity avoids needing to evict its bytes or change snapshot contents when
text is requested. Overflow falls back to normal reads. The 833-to-77 reduction
is a measurement of a synthetic fixture, not a guarantee for every campaign.

Incremental charging is a possible follow-up optimization, but requires a policy
for text materialization when the budget is full and representative large-input
measurements. The present approach sacrifices hit rate for a simple conservative
bound; it does not exceed the reservation or return an incorrect digest for the
current synchronous read-only operation.

## Generic digest semantics

The helper hashes raw bytes regardless of file type. Its comment now explicitly
requires artifact-writing callers to hash outside the read-only scan scope. The
original review verified that current JSON write/hash sites are outside the scope
and doctor performs no writes. A hypothetical future call-site move is a review
constraint, not a current stale-read path. Eight helper tests and full checks
passed; read counts and output fingerprints remained unchanged after the fix.

Please distinguish these documented tradeoffs from current defects in the merge
recommendation, or provide a concrete counterexample. No executable code changes
in this commit; the commit triggers automatic review with this rationale available.
