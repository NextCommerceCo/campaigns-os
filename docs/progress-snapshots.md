# Minimal progress observations

Release **1.36.0** adds the portable `@nextcommerce/campaigns-os/progress`
export and `schemas/campaigns-os-progress-snapshot.v0.schema.json`; it ships in
1.37.1 and later, the first published releases to carry it. Progress is a compact
observation of the existing lifecycle, not a second workflow or proof of readiness.

`next --packet <packet>` records the canonical picker result after the same doctor
checks that supply its continuation and gates. Agents run `next` after setup,
assembly, polish and preview deployment so those committed stage reports become
visible. The CLI `build` command prepares inputs and runs doctor; it does not build
or deploy the campaign. Preview's existing stage is `deploy`. Arbitrary edits are
not tracked. `qa run --packet <packet>` observes its successfully committed or
unchanged QA report before the existing closeout: ready QA closes its run once,
blocked QA keeps it open. A progress delivery cannot close a run.

## What is shared

The strict v0 object carries its schema, package version, observation timestamp,
producer (`next` or `qa`), opaque progress stream and sequence, prior snapshot ID,
content digest, Map ID and separate revision/spec/build hashes. Six independent
stage records retain observed status and explicit build binding. Continuation
retains the canonical stage, blocked/divergent flags, fixed action IDs and gate
states. Preview carries only presence and a hash of the URL. An optional QA block
retains the exact verdict ID, disposition (including `ready_with_exceptions`),
binding and publication state. Publication failure does not invalidate a locally
retained verdict; recovery uses `qa publish`, without repeating an order.

No commands, prompts, free text, content, local paths, URLs, query strings,
credentials, order values or customer payloads enter the wire. Unknown vocabulary
becomes a fixed `unknown` marker and cannot imply a passing continuation. A
stage's observed `completed` status is a ledger claim, not independent verification.
Only matching fingerprints carry `matching`; absent or unverifiable binding is
`unconfirmed`. A current local output hash never proves a deployment is current.

The identity algorithms are deliberately different:

- `map-store-v1` retains the original saved Map hash. A fresh Map fetch records
  that hash and the fetched local semantic baseline in Build Context intake.
  Saved revision alignment is `aligned` only while the local spec still matches
  that baseline and the context names this packet and Map. Existing contexts,
  offline caches and local exports without that provenance remain `unconfirmed`.
  The saved hash may still be retained as identity; it alone proves no alignment.
- `campaign-spec-material-v1` hashes recursively key-sorted JSON after removing
  top-level `spec_identity`, `slug`, `map_id` and `saved_at`, as existing
  `specMaterialHash` does. It includes lifecycle and parent Map fields that the
  saved Map producer excludes. It must never be compared as a Map-store hash.
  Assembly Report `identity.spec_hash` is a raw-byte hash and is not this value.
- `sha256-manifest/v1` is the existing doctor's output fingerprint: SHA-256 of
  the sorted relative-path and file-SHA-256 manifest under the built route.
  Reported assembly/QA binding uses the doctor's actual observed output and its
  recorded-fingerprint comparison. Missing output remains nullable/unconfirmed.

Different Map revisions, local specs, builds, packet/context/report bindings and
endpoint scopes have independent streams. Completed stages cannot be combined
across them. A progress stream is independent of a run-session ID.

## Capture and delivery

Sanitized immutable snapshots are written under the target repository's
`.campaign-runtime/progress/` before any request. Allocation uses an exclusive
local lock with a process owner. Dead owners are recovered through an exclusive
recovery claim and an atomic rename; a live process is never evicted. An ownerless
crash gap is recoverable after ten seconds. If recovery itself is interrupted,
capture fails closed: stop all Campaigns OS writers for that target, then remove
the abandoned `.allocation-lock` directory in the affected progress scope before
retrying `next`. Do not remove a lock while a writer is active.

An unchanged projection reuses its ID, timestamp and sequence. Identity
changes start a new stream. Each local scope retains at most 32 snapshots and
separate remit metadata; retention can leave an incomplete history. There is no
daemon. A later observation retries its current pending delivery; old pending
snapshots remain in the bounded local history, without background sends.

`--no-write` disables both capture and delivery. `--no-remit` keeps capture local.
`--no-run-session` does not start a session. A missing/invalid Map ID keeps the
observation local with `map_id_missing`; a missing campaign key similarly yields
`campaign_key_missing`. Capture or delivery failures never alter the lifecycle
result or exit status.
Capture may wait up to 1.5 seconds for allocation. Delivery is awaited within
its separate two-second network budget. Unchanged lifecycle results mean the
command's output and status remain unchanged; these bounded waits can add latency.

The planned ops receiver is `POST /api/progress`. Destination precedence is an
explicit `--proxy-base`, then the bound Build Context's `intake.proxy_base`, then
the canonical NEXT endpoint only when there is no source binding. An invalid or
foreign source binding fails closed, including a context without a nonempty
matching packet pointer. An explicit endpoint override remains independent of
that context, and cannot confirm its saved revision.

HTTPS and plain HTTP loopback are accepted;
userinfo, query, fragment and other protocols are refused. Redirects are refused.
The existing campaign-key resolver supplies `X-Campaign-Key`; keys never enter
snapshots or metadata.

The same telemetry on/off choice governs sharing. Canonical delivery defaults on;
explicit off, malformed environment/configuration and scope mismatch keep delivery
off. Consent off still permits the sanitized local capture and sends no request.
Noncanonical progress delivery requires an explicit matching scoped file
opt-in (`telemetry on --proxy-base <endpoint>`). Unlike existing Run Record remit,
unscoped environment ON cannot bypass scope for progress; it yields
`scoped_consent_required`. Minimal stage observations are intended to be visible
in Workspace. This producer does not implement the receiver or Workspace UI.

Delivery uses a total two-second budget, at most one initial request and one retry
for transport errors, 429 or 5xx. Both requests use identical canonical JSON bytes,
ID and timestamp. A response body is bounded to 4 KiB. A 2xx or 409 succeeds only
with `{ "ok": true, "snapshot_id": "<id>", "digest": "<same-id>" }`. Other
400/401/403/409 answers and nonmatching acknowledgments remain failed; a conflict
never silently counts as stored. Response error text is never copied to metadata.

## Portable consumption

```js
import {
  verifyProgressSnapshot, groupProgressHistories, progressStorageKey,
} from '@nextcommerce/campaigns-os/progress';

const checked = await verifyProgressSnapshot(snapshot);
const histories = await groupProgressHistories(snapshots);
const key = progressStorageKey(snapshot, scopeHash);
```

The export uses standard Web Crypto and TextEncoder; it has no Node, filesystem
or network dependency. `validateProgressSnapshot` checks bounded strict shape and
binding invariants; `verifyProgressSnapshot` also verifies the content digest.
`snapshot_id` hashes recursively key-sorted JSON of every field except itself.
Canonical transport JSON includes the ID, with no whitespace or newline.
The exported schema and supported example fixture agree byte-for-byte in tests.

`groupProgressHistories` accepts at most 256 snapshots, groups whole observations
by complete identity plus stream, removes exact duplicate IDs and sorts sequences.
Groups are `conflicted`, `incomplete`, `unconfirmed` or `observed`. It neither
chooses a lifecycle stage nor merges completion claims. `observed` confers no
receiver trust or readiness. Invalid members are rejected with fixed reason codes.

The planned immutable receiver key is
`progress:v0:<scope-hex>:<map-id>:<revision-hex>:<stream>:<sequence>:<digest-hex>`.
`progressStorageKey` returns null without a valid shape, scope hash, Map or saved
revision. A key match identifies scope; it is not authentication or trust. The
receiver must verify the digest and authorized Map scope and stamp its own trust.
Unknown, incomplete or conflicted histories must never yield a ready workspace.
