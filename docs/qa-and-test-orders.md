# QA And Test Orders

The public v0 QA runner is Node/npm-based and does not require access to a private runtime repo.

## Resolve

Use resolve before a full run:

```bash
npm run campaigns-os -- qa resolve --packet campaign-runtime.build.json
```

Resolve reads the packet, loads the local CampaignSpec when available, derives deployed page URLs from the packet deploy URL or `--base-url`, and prints the funnel topology. It does not create a verdict.

## Run

```bash
npm run campaigns-os -- qa run \
  --packet campaign-runtime.build.json \
  --base-url https://preview.example.com/campaign/
```

The runner fetches deployed pages, checks route availability, verifies CampaignSpec `sdk_hints.meta_tags`, writes a local verdict JSON under `qa-output/<map-id>/<run-id>.json`, and returns exit code `4` when the verdict is blocked.

Add `--post-verdict` only when the operator intentionally wants to POST the verdict to the configured Campaign Map proxy:

```bash
npm run campaigns-os -- qa run \
  --packet campaign-runtime.build.json \
  --base-url https://preview.example.com/campaign/ \
  --post-verdict
```

## Test Orders

Backend test orders are opt-in and guarded. They require all of:

- Build Packet `qa.test_orders_allowed=true`
- Build Packet `qa.sandbox_test_card_confirmed=true`
- CLI `--allow-test-orders`
- CLI `--sandbox-test-card-confirmed`
- `--api-key` or `QA_CAMPAIGNS_API_KEY`
- `--campaigns-api-base` or `CAMPAIGNS_API_BASE`
- `--cart <package-ref:qty,...>`

Example:

```bash
npm run campaigns-os -- qa run \
  --packet campaign-runtime.build.json \
  --base-url https://preview.example.com/campaign/ \
  --test-order both \
  --allow-test-orders \
  --sandbox-test-card-confirmed \
  --cart 123:1 \
  --campaigns-api-base "$CAMPAIGNS_API_BASE"
```

Never run backend test orders against an unconfirmed production payment path.
