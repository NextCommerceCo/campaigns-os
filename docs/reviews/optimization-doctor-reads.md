# Slice 2 remote review disposition

Kilobot reviewed `5fedd06` on PR #286 and confirmed current doctor calls are
synchronous and read-only. The following dispositions cover its three comments.

- **Snapshot lifetime:** accepted as a hardening opportunity. AsyncLocalStorage
  propagates stores to queued callbacks even when the original operation returns
  synchronously. The store now expires and clears retained files in `finally`
  at synchronous return or throw. Async continuations read fresh bytes; reuse
  cannot reopen an expired store. Regression tests cover returned promises,
  nested reuse after an await, and queued work after an exception. Separate
  invocations already had separate stores; they did not share one global cache.
- **Three-times byte reservation:** retained deliberately. Reserving buffer plus
  worst-case decoded text at admission keeps later digest-to-text reads within
  the same budget without eviction or changing snapshot contents. This permits
  roughly 5.3 MiB of raw files, not 16 MiB; overflow intentionally reads normally.
  The reported read reduction is for the measured fixture, not every campaign.
  Incremental charging is a separate optimization requiring representative large
  campaign measurements and tests for text materialization at the budget edge.
- **Generic digest name:** clarified at the helper. It hashes raw bytes for any
  file type; only active read-only scan scopes cache. Artifact writes and hashes
  that must observe them belong outside such a scope. No HTML-extension filter
  or hashing semantics changed.
