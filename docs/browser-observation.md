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

After the settle wait, a page that loads the Campaign Cart SDK gets up to 15 s
more to report itself rendered (`data-next-sdk-loading="false"` on the body, or
`next-display-ready` on `<html>`, the readiness rule of the contrast checks)
before QA reads it. The SDK counts as loaded when the body carries
`data-next-sdk-loading` or the loader script sits in the document or an open
shadow root. `sdk_display` records the outcome: `not_declared` (no SDK, no
wait), `ready`, `timeout`, or `unreadable` (the page could not be read during
the wait); `sdk_display_ms` is how long the wait took. A page that never
reports ready is read after the cap, so its checks still report what they see.
Test-order page loads take the same wait, capped by the step's remaining time
less the 5 s settle allowance. The checkout's card check then waits up to 8 s
more, once, for the card iframe to attach and `next-loading-spreedly` to clear
before it measures the fields.

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
background traffic, missing readiness, and main/debugger navigation failures. It preserves the
five-second network-idle timeout and debugger's extra one-second wait. No browser
launch is added to default CI.

Before overlapping or shortening these waits, define independent page observation
windows and explicitly accept the coverage boundary. Compare the measured windows
and error evidence, including late events near those boundaries. The timing fields
make this decision reviewable; this change itself makes no speedup claim.
