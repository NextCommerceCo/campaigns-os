---
name: next-campaigns-qa
description: Run spec-aware QA from a Campaign Map ID and deployed campaign URL after build, polish, and deploy evidence exist, including SDK-driven test-order proof when requested.
---

# Next Campaigns QA

Use this after the campaign has a preview or production URL and the assembly report records build and polish status. The public v0 runner is Node/npm-based:

```bash
npm run campaigns-os -- qa resolve --packet campaign-runtime.build.json
npm run campaigns-os -- qa run --packet campaign-runtime.build.json --base-url <preview-url>
```

Inputs:

- Campaign Map ID from the Build Packet
- deployed base URL
- assembly report
- QA/test-order policy and sandbox routing confirmation

Rules:

- Use the public Node/npm `campaigns-os qa` commands for campaign QA runs.
- Test orders must exercise the deployed campaign through the Campaign Cart SDK, not a hand-built backend API request.
- Current SDK test-order automation uses the checkout page event `document.dispatchEvent(new CustomEvent("next:test-mode-activated", { detail: { method: "konami" } }))`. This fills test data, sets `paymentToken="test_card"`, calls the SDK checkout test-order path, emits `order:completed`, and redirects with `ref_id`.
- Prefer dispatching that CustomEvent over simulating the 10-key Konami sequence; keyboard automation has proven unreliable. The `detail.method = "konami"` discriminator is required.
- After the base checkout test order redirects to upsell, click the rendered SDK upsell accept/decline controls to prove the live upsell path. Do not fabricate upsell lines with a direct API call.
- Do not fire SDK test orders unless the preview/production domain is allowed for the campaign API key and `test_card` sandbox routing is confirmed for that merchant.
- Treat missing deploy URL, missing polish status, or unresolved doctor blockers as launch blockers.
- Report blockers, warnings, and residual risks.
- QA follows build and polish; it does not edit campaign code.

Canonical test-order flow:

1. Open the deployed checkout URL in a browser automation session.
2. Select the intended bundle/cart using the rendered campaign controls.
3. Dispatch the SDK test-mode event on `document`:

   ```js
   document.dispatchEvent(new CustomEvent("next:test-mode-activated", {
     detail: { method: "konami" }
   }));
   ```

4. Wait for the SDK to create the test order and redirect with `ref_id`.
5. On upsell pages, click the actual accept or decline button for the target path.
6. Verify receipt/order evidence and summarize order number, `ref_id`, selected cart, upsell path, and line-item result.

Do not use the legacy `campaigns-os qa --test-order` direct backend mode as the canonical proof path. It bypasses the deployed campaign page and the SDK checkout/upsell surfaces; keep it only as a diagnostic fallback when explicitly requested.
