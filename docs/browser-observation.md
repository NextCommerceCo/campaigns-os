# Browser runtime observation

Browser QA currently collects main-page errors while running its DOM checks and
then a separate debugger-page navigation. The main error window therefore varies
with both pages' work. Debugger readiness is not an error-observation deadline.

The current sequence is deliberately preserved. Browser-load evidence now includes
an `observation` object with policy `legacy-sequential-v1`. Phase durations are
`navigation_ms`, `settle_ms`, `inspection_ms`, and `debugger_ms`. Error sample times
(`page_errors_sampled_after_ms`, `console_errors_sampled_after_ms`, and
`failed_requests_sampled_after_ms`) are measured from just before main navigation,
after its event listeners are attached. Inspection excludes the title/body probe;
these phase values are not a complete additive partition of elapsed time.

Debugger evidence carries policy `networkidle-plus-1000ms-v1`: navigation, network
idle wait, and post-settle wait durations plus `errors_sampled_after_ms`, measured
from just before debugger navigation. These relative timings use a monotonic clock,
rounded to milliseconds. They do not contain URLs, wall-clock dates, credentials,
or a new guarantee about errors that occur after sampling. Failure paths include
`failed_after_ms` and whichever phases completed; main navigation failures retain
the existing behavior of not opening the debugger page.

Use the opt-in loopback regression to collect representative timings:

```
node scripts/performance/runtime-observation-smoke.mjs
```

It requires the repository's Playwright Chromium and tests late main/debugger
errors, console errors, request failures, delayed debugger navigation, persistent
background traffic, missing readiness, and navigation failure. It preserves the
five-second network-idle timeout and debugger's extra one-second wait. No browser
launch is added to default CI.

Before overlapping or shortening these waits, define independent page observation
windows and explicitly accept the coverage boundary. Compare the measured windows
and error evidence, including late events near those boundaries. The timing fields
make this decision reviewable; this change itself makes no speedup claim.
