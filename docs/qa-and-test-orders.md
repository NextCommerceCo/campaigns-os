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

Canonical test-order proof is SDK-driven. The QA agent should open the deployed
campaign checkout, select the intended cart with the rendered Campaign Cart SDK
controls, and let the SDK create the test order. A hand-built backend API order
does not prove the deployed checkout/upsell surfaces.

Current Campaign Cart SDK builds expose this internal browser automation hook on
checkout pages:

```js
document.dispatchEvent(new CustomEvent("next:test-mode-activated", {
  detail: { method: "konami" }
}));
```

The checkout enhancer handles that event by filling test customer/address data,
setting `paymentMethod=credit-card`, setting `paymentToken="test_card"`,
selecting a shipping method from the current SDK state, creating the test order
through the SDK checkout path, emitting `order:completed`, and redirecting with
the returned `ref_id`.

For browser automation, dispatch the CustomEvent directly instead of simulating
the 10-key Konami sequence. Keyboard-event simulation has proven unreliable, and
the `detail.method = "konami"` discriminator is required by the SDK handler.

The intended QA order matrix is:

1. Checkout path with the target bundle/cart selected.
2. Upsell-decline path by clicking the rendered SDK decline/skip control.
3. Upsell-accept path by clicking the rendered SDK accept/add control.
4. Receipt/order verification from the resulting `ref_id`, including line items,
   selected packages, quantities, shipping method, vouchers, and upsell result.

Only fire SDK test orders when the campaign preview/production domain is
allowlisted for the campaign API key and `test_card` sandbox routing is confirmed
for that merchant. Test orders are QA evidence; they are not deleted as part of
the automated flow.

The older `campaigns-os qa --test-order` direct backend mode is legacy
diagnostic behavior. Do not use it as canonical launch proof because it bypasses
the deployed campaign page and the SDK checkout/upsell surfaces.
