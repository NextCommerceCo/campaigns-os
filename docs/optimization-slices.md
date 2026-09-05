# Optimization slices

Each slice is a separate change with independent adversarial review. Performance
changes must retain issue ordering, checkpoint behavior, privacy boundaries, and
freshness between invocations. Review findings and measurements belong in each PR.

1. Establish repeatable baselines (scripts/performance).
2. Reuse doctor file reads within one invocation, starting with copy/residue scans.
3. Load CLI command implementations on demand.
4. Overlap independent static QA page requests with bounded concurrency and deterministic budgets.
5. Replace selected browser settling sleeps with observable readiness conditions.
6. Avoid repeated acyclic graph traversal in cycle detection.
7. Remove redundant CI compilation while preserving install and package checks.

## Baseline procedure

Use an isolated worktree, prepare dependencies and campaign-spec/dist using the
repository's runtime recipe, and use the same Node runtime on both revisions.
Do not run this script as part of trust orientation: it executes toolkit code.

```
node scripts/performance/baseline.mjs 5 > /tmp/campaigns-os-baseline.json
```

The runner rebuilds campaign-spec once before sampling to prevent stale generated
code from contaminating measurements. The optional argument is 1–30 samples per workload. JSON records the commit,
tracked diff digest, working-tree status, harness digest, runtime, CPU, all
samples, and min/median/max. Commit the harness before recording a comparison so
untracked source cannot be mistaken for commit-addressed evidence. Compare only
runs with the same harness and fixture definition. Do not treat noisy wall times
as hard CI thresholds.

- `help`: fresh CLI process wall time including imports. The OS file cache is
  not flushed; this is cold-process startup, not a cold-disk measurement.
- `doctor`: operation time and synchronous fixture file reads for the example
  packet, expanded with 32 HTML files per source/target directory. The synthetic
  assembly report intentionally lacks full proof; doctor findings are expected.
- `copy-scans`: isolates market/currency/phone checks on the same HTML corpus.
- `static-qa`: real resolved QA orchestration, 16 synthetic landing URLs with
  mocked 10 ms response delays. No browser, orders, price-preview, or publishing.
  This measures orchestration under controlled latency, not deployment speed.
- `cycle-chain`: 500-page acyclic chain, deliberately larger than normal funnels.
- `build-spec`: compiler process wall time only, not total hosted CI duration.

Workloads use temporary fixtures and a clean child environment. The runner does
not forward campaign credentials, ambient sessions, or telemetry settings.
QA fetch is mocked and rejects unexpected URLs/methods. Output fingerprints must
match across repeated samples; doctor fingerprints normalize producer timestamps
and temporary/toolkit roots. All fixture directories are removed on normal exit
or errors. A forcibly killed process may leave temporary files behind.

The compiler workload refreshes ignored campaign-spec/dist in the worktree.
Other workloads only write temporary fixtures. Filesystem counts cover successful
synchronous readFileSync calls under the temporary fixture, not module-loader I/O,
stat calls, directory walks, asynchronous reads, or failed reads. Their purpose is
comparison of the current doctor paths, not total system I/O accounting.

For hosted CI savings, compare Actions step durations on equivalent runners; this
local compiler baseline cannot establish them. Browser changes require separate
readiness regression tests and live/local fixture evidence in slice 5.

## Static QA concurrency

The static page loop uses the existing commercial-QA concurrency bound (four).
Unique URL responses may finish out of order, but retained-HTML admission and
assertions retain input order, including which page crosses the aggregate budget.
Already-started requests may complete after that budget is reached; no new request
starts after the limit is known. Transient in-flight bodies are additional to the
retained HTML budget and bounded by concurrency times the per-response limit.
Browser checks, analytics inventory, typed-card orders, and receipt assessment keep
their existing sequential stage order.
