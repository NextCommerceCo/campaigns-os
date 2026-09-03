# Migration sidecar bundle v0

The migration sidecar bundle is the strict JSON boundary between a campaign
repository, its CI producer, and Campaigns Agent readback. It does not replace
the underlying artifacts and it does not create another manifest file. The
machine contract is
[`contracts/migration-sidecar-bundle.v0.json`](../contracts/migration-sidecar-bundle.v0.json),
and the conformance command is:

```bash
campaigns-os bundle check --packet campaign-runtime.build.json --json
```

Add `--require-qa` when the migration or campaign claims QA is complete.

## Canonical bundle

| Kind | Canonical path | Requirement | Schema/version | Freshness |
| --- | --- | --- | --- | --- |
| Build Packet | `campaign-runtime.build.json` | Required | `campaign-runtime-build-packet/v0` | Its `generated_at` is the bundle-selection authority. Never select a packet by mtime. |
| Build Context | `.campaign-runtime/build-context.json` | Required | `campaign-runtime-build-context/v0` | Producer-stamped `generated_at`; `packet_path` must point to the root packet. |
| Assembly Report | `.campaign-runtime/assembly-report.json` | Required | `campaign-runtime-assembly-report/v0` | Producer-stamped `generated_at`; authored stage evidence is preserved. |
| Doctor Output | `.campaign-runtime/doctor-output.json` | Required | `campaigns-os-doctor-output/v0` | Refresh after any doctor-input change; an explicit `stale: true` fails conformance. |
| QA Verdict projection | `.campaign-runtime/qa-verdict.json` | Required after QA | QA schema `1.0`, constrained by the sidecar projection schema | `generated_at` is the projection/promotion instant. |

The packet stays at repository root because that is the default discovery
contract. A packet found only at
`.campaign-runtime/campaign-runtime.build.json` is reported with a root-path
remedy; conformance does not silently widen discovery.

The checker validates canonical paths, declared schema versions, strict UTC
timestamps, cross-artifact Map ID, public slug, campaign directory, live URL
path, template family, and spec-hash identity, doctor freshness, and the
URL/order-free QA projection. A blocked doctor or QA verdict is still valid
evidence: conformance says the evidence is readable and coherent, not that the
campaign is ready.

## Headless CI producer

Resolve and check out one commit before producing anything. The initial
`campaigns-os start` run writes the packet, context, report, and doctor output
from explicit CampaignSpec/source/template inputs. `prepare-build` writes the
packet, context, and report; refresh Doctor output with the command below.
Later CI runs must preserve the authored packet, context, and Assembly Report
rather than recreating them with `--force` and erasing stage decisions.

Refresh generated evidence at that commit:

```bash
campaigns-os doctor \
  --packet campaign-runtime.build.json \
  --strip-paths \
  --json

# Only when carrying forward a named historical full verdict:
campaigns-os qa promote \
  --packet campaign-runtime.build.json \
  --verdict "$EXPLICIT_FULL_VERDICT" \
  --json

campaigns-os bundle check \
  --packet campaign-runtime.build.json \
  --require-qa \
  --json
```

`qa promote` requires one explicit full-verdict path. CI must not pick a verdict
by mtime, filename sort, or a directory's apparent “latest” entry. If there is
no historical verdict to promote, run QA and let `qa run` write the committed
projection.

The checker emits both exact per-file SHA-256 digests and one
`material_digest`. The material digest canonicalizes object-key order and
removes only the volatile fields declared in the machine contract (generation
timestamps and run IDs). Repeating the producer over the same substantive
evidence therefore keeps the material digest stable; changing a disposition,
identity, stage state, or assertion changes it.

## Consumer and compatibility fixture

The supported production-shaped fixture lives at
`contracts/fixtures/sidecar-bundle/production-shaped/`. It contains the root
packet and all four canonical sidecars, including a URL/order-free QA verdict.
Campaigns Agent can copy or read that tree in both its deterministic and
real-Campaigns-OS lanes without this public repository importing private Agent
code.

Markdown reports, equivalence ledgers, and migration-specific scripts may live
beside the bundle as supporting evidence. They never satisfy a missing JSON
artifact and are never substituted for current readback truth.
