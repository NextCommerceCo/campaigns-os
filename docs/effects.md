# Declared command effects

`contracts/effects.v1.json` states, for every supported invocation of this
toolkit, what it **writes** and what it **sends**. It is the file to read before
you let an agent run a command it has not run before, and it is the file a tool
face would read to decide whether an invocation needs a human in the loop.

The point of the file is not the prose. It is that **every row is proved by a
test** (`src/effects.test.mjs`), and a row without its test cannot be published:
`npm run check:effects` refuses it.

- The contract: [`contracts/effects.v1.json`](../contracts/effects.v1.json)
- Its shape: [`schemas/campaigns-os-effects.v1.schema.json`](../schemas/campaigns-os-effects.v1.schema.json)
- The proof: `src/effects.test.mjs`
- The gate: `scripts/check-effects.mjs` (`npm run check:effects`)

## The vocabulary

### Annotations

Four booleans per row, spelled the way an MCP tool face spells them, so a host
that already understands those hints needs no translation layer.

| Annotation | Meaning |
| --- | --- |
| `readOnlyHint` | The invocation changes **nothing**: no file under the target, the working directory or your machine, and no request off the machine. |
| `destructiveHint` | The invocation can overwrite, clear or discard state that existed before it ran. Only meaningful when `readOnlyHint` is false. |
| `openWorldHint` | The invocation can contact an endpoint off this machine. True exactly when the row declares at least one send. |
| `idempotentHint` | Repeating the invocation with the same arguments adds no effect beyond the first run. |

**`readOnlyHint` counts the command-lifecycle journal.** A journal append is a
write like any other, so every `readOnlyHint: true` row is an invocation the
CLI exempts from lifecycle capture (the converse does not hold: `demo` and the
`--no-write` forms skip the journal but still write other declared files): `help`, `readback`,
`run status`, `doctor` inspection, `doctor --no-write`, `sdk storage-check`,
`tooling diagnose`, a refused invocation, `run-record --no-write`, and every
`--dry-run` form on the commands that implement the flag. Everything else
appends an entry when a journal is selected — an active run session,
`--lifecycle-journal`, or `CAMPAIGNS_OS_LIFECYCLE_LOG` — and is therefore not
read-only, even when the command writes no artifact of its own. `standardize`
and `bundle check` are tier `B` for exactly that reason and nothing else; their
rows say so.

### Tiers

| Tier | Meaning |
| --- | --- |
| `none` | No effect: nothing written anywhere, nothing sent. |
| `B` | Writes files under the target, the working directory or your machine. Nothing leaves the machine. |
| `A` | Can contact an endpoint off this machine (it may write locally too). |
| `C` | Destructive: overwrites, clears or discards state that was already there (it may send too). |

A row carries the **highest** tier it can reach, ranked `none < B < A < C`.

### Location tokens

A write path is a glob (`*` within one segment, `**` across segments) that opens
with one of these:

| Token | Resolves to |
| --- | --- |
| `{target}` | The target the invocation names: the directory given to `--target`, or the Page Kit target repository the Build Packet points at. |
| `{cwd}` | The working directory the invocation runs in. |
| `{spec}` | The CampaignSpec file the Build Packet names (`spec.local_path`), which need not live inside the target repository. |
| `{home}` | Your machine: the home directory and the config root under it (`XDG_CONFIG_HOME` when set). |
| `{packet}` | The Build Packet the invocation names (`--packet`), wherever it lives — it need not be the copy inside the target repository. |
| `{lifecycle-journal}` | The command-lifecycle journal wherever it was selected for this invocation. |
| `{proxy-base}` | The endpoint `--proxy-base` names, or the canonical NEXT endpoint when it does not. |
| `{base-url}` | The campaign under test, as `--base-url` names it or as the packet derives it. |
| `{playwright-download-host}` | Where Playwright fetches browser builds from: `PLAYWRIGHT_DOWNLOAD_HOST` when set, else the Playwright CDN. The one destination in the file that is not a Campaigns OS endpoint — `qa install-browser` is the one supported invocation that downloads from a third party. |

The tokens matter because effects are not all under the target. `install-skills`
writes your **home** directory, not the campaign. `telemetry on` writes your
**machine** config. `run-record` writes beside the **working directory**, not the
target repo. A row that said "writes the target" would be wrong about all three.

## How to read a row

```jsonc
{
  "command": "page-kit",
  "subcommand": "sync",
  "flags": [],                       // the base form; --dry-run is its own row
  "annotations": { "readOnlyHint": false, "destructiveHint": false,
                   "openWorldHint": false, "idempotentHint": true },
  "tier": "B",
  "writes": [
    { "path": "{target}/_data/campaigns.json",
      "when": "one of the ten Store Profile / SDK-pin fields is usable and differs from the entry",
      "observed_in": ["no_session", "ambient_session", "stale_session", "lifecycle_log"] }
    // …
  ],
  "sends": [],
  "effect_test": "effects: page-kit sync",
  "test_scope": "full",
  "notes": "Writes only those ten fields of the packet's route entry…"
}
```

There is **one row per command and per effect-changing flag combination**. The
flags that change what the invocation does to the world are listed once, in
`vocabulary.effect_changing_flags`: `--browser`, `--built`, `--dry-run`,
`--emit-packet`, `--example`, `--force`, `--from-store`, `--list`,
`--no-post-verdict`, `--no-probe`, `--no-remit`, `--no-run-session`,
`--no-write`, `--republish`, `--test-order`, `--write`, `--write-map`. Flags
that only change the output shape (`--json`, `--report`) deliberately do not.

**"The help text" is every help block the CLI prints**, not one file's.
`campaigns-os qa` prints its own from `src/qa-node.mjs`, and while the coverage
scan read only `src/cli.mjs` the three subcommands documented there alone — `qa
parity`, `qa waive` and `qa install-browser` — owed no row, had none, and the
gate stayed green. Every module that owns a usage block is listed in
`HELP_SOURCE_PATHS` and scanned the same way; a test derives that list from the
source, so a command that grows its own help cannot quietly leave the scan.

**Every one of those flags that a help usage line carries owes a row**, and
`scripts/check-effects.mjs` fails when one does not have it. Coverage by command
alone was not enough: deleting the `page-kit sync --dry-run` row, or the
`doctor --write` row, left the gate green while the file lost an effect —
`doctor --write` writes the doctor sidecar, the assembly report and the packet
that plain `doctor` does not. A flag that appears in a usage line for a command
that has only a base row is now the loudest kind of failure this gate has.

One row is not a command at all: `{"command": "*refused*"}` is any invocation
refused before its handler runs — an unknown command, an unknown subcommand, or
a flag the command rejects up front. It writes nothing, journals nothing, and is
the row to read when you want to know what a typo costs. The one exception is
declared on the rows it belongs to: `start`, `prepare-build`, `build`,
`run start` and `run end` close out a **stale** run session at the root they are
about to act on *before* argv is refused.

## How a row is proved

`src/effects.test.mjs` runs the real CLI in a disposable target seeded from
`examples/`, under **five conditions**, and snapshots the whole tree (paths plus
sha256) before and after while a loopback `node:http` receiver counts requests.

| Condition | What it sets up |
| --- | --- |
| `no_session` | No run session at the target or the working directory. |
| `ambient_session` | An active ambient run session opened by `run start` at the target. |
| `stale_session` | A run session idle past the 12 h TTL, at the target and at the working directory. |
| `lifecycle_log` | `CAMPAIGNS_OS_LIFECYCLE_LOG` names a journal outside the runtime directory. |
| `persisted_consent` | Run Telemetry consent **persisted on the machine for the loopback receiver's scope**, a synthetic campaign key in the environment, no run session, and `--proxy-base <loopback>` wherever the command takes it. |

Five conditions rather than one, because the CLI's effects are not a function of
argv alone: an ambient session redirects the journal and is itself touched by
session resolution, and a stale session is closed out — Run Record assembled —
before some commands even read argv.

### Why the fifth condition exists

Under the first four, consent is `CAMPAIGNS_OS_TELEMETRY=off` unless the row
declares a consent-gated send it expects to see in that condition; then the row
runs with consent on and the loopback receiver as its endpoint, so "nothing was
sent" is not an artefact of consent being off **for a send that is declared**.

That took the row's word for which sends exist, and it hid real ones: `next` and
its five stage forms, and all three `qa run` rows, declared `sends: []` while
each of them POSTed — to `{proxy-base}/api/progress`, and for `qa run` to
`{proxy-base}/api/qa/verdicts` as well, on blocked attempts included.

`persisted_consent` does not read consent from the row. It persists consent the
way an operator does — `campaigns-os telemetry on --proxy-base <loopback>`,
which is a **scoped** record — and runs every row that way. An environment
override is not equivalent and is the reason the earlier probe found nothing: an
env grant carries no scope, so the remit refuses it for a non-canonical endpoint
(`scope_bypassed`) and delivers nothing. Any request the receiver sees that no
declared send covers fails the row.

The same scoping is what keeps the suite off the network. The remit endpoint is
a hard-coded constant with no environment override, so a command that falls back
to the canonical endpoint resolves consent **off** (the persisted grant covers
the loopback scope only) and sends nothing. That is asserted, not assumed: every
invocation in this condition runs under `NODE_DEBUG=net` and its connection log
must name no host but `127.0.0.1`, and one case states the claim directly for
`next` with no `--proxy-base` at all.

The assertion runs both ways, and that is what makes the file falsifiable:

1. **Nothing undeclared may change**, in any condition. A `readOnlyHint: true`
   row declares no writes, so any byte that moves fails it.
2. **Every declared effect whose `observed_in` names a condition must be seen**
   in it, so a row cannot be padded with effects that never happen.

`observed_in` is per effect, not per row: `install-agent-context` writes
`{target}/.gitignore` only when the target does not already ignore the runtime
directory, so that entry is observed in three conditions and not under
`ambient_session`, where `run start` has already added the line.

### Rows proved at the preflight

Some invocations cannot execute past their preflight with no network, no
browser, no renderer and no credentials. Those rows carry
`test_scope: "preflight"`. Their case proves the preflight refusal writes
nothing beyond what the row declares and — where a loopback receiver can stand
in for the destination — that the **declared destination is the one contacted**.

| Row | What the offline fixture cannot reach |
| --- | --- |
| `login` | A reachable login gateway and a human at a browser. Proved: the failure path writes nothing at all — no credential, no journal entry. |
| `logout` | A credential minted by a gateway login. Proved: the no-credential path writes nothing. |
| `page-kit parity` | A `local-serve` deploy target and a page-kit renderer to build the two renders with. Proved: the refusal writes nothing but the journal entry. |
| `polish capture` | An installed browser and a reachable `--base-url`. Proved: the refusal writes nothing but the journal entry and contacts nothing. |
| `qa install-browser` | The Playwright CDN, and the ~150 MB Chromium archive it serves. Proved: the failed download writes exactly one path under your machine — the registry's link entry — and nothing else anywhere, and leaves the machine zero times. |
| `qa parity` (and `--no-post-verdict`) | An installed Chromium and a reachable candidate funnel. Proved: the refusal writes nothing but the journal entry and contacts the stand-in for `--base-url` zero times. |
| `qa resolve` | A resolution that is not blocked before the probe. Proved: the blocked resolution contacts the stand-in zero times. |
| `qa run --browser` | An installed Chromium and a reachable campaign. Proved: the attempt is blocked at the same gate as the node run and writes exactly the blocked-attempt evidence. |
| `spec derive --from-store` | A live gateway and a real store credential. Proved: the credential refusal writes nothing under the target or the spec. |
| `spec derive --write-map` | A Map whose `spec_hash` precondition a loopback stand-in can satisfy, so the `PUT` is never reached. Proved: the declared destination **is** the one contacted (the receiver sees the Map read), and the refusal adds no report evidence. |
| `telemetry list` | A real ops admin key and a real endpoint. Proved: the receiver sees the declared `GET /api/runs`, and the refusal writes nothing but the journal entry. |

#### What a preflight row is allowed to touch

A preflight row declares its allowances **separately from its effects**, and the
test enforces them independently:

```jsonc
"preflight": {
  "may_write":   ["{lifecycle-journal}"],   // the ONLY paths the refusal may write
  "may_contact": ["/api/runs"]              // the exact request paths the receiver may see
}
```

Both halves close a hole that a declared effect used to open. `logout` declared
`{home}/**` for the credential a *completed* login writes — and that declaration
also licensed its refusal to write anywhere under the home directory, so a
home-directory write injected into the preflight passed. And a destination a
loopback receiver only stands in for (`{base-url}`, the login gateway) matched
**any** request path, so an injected endpoint passed too. Now:

- `may_write` is the whole permission. It may not name a whole location
  (`{target}`, `{target}/**`) and may not span segments under `{home}` — the
  skills directories, the credential store and the consent file all live there,
  under the temporary `HOME` the test sets, and a preflight that writes one of
  them has to say which.
- `may_contact` is matched literally against the request path, so an `/api/`
  call nobody declared fails the row even when the row declares a stand-in
  destination. (On a `full` row the same rule holds one step down: a stand-in
  destination never covers an `/api/` path, because every API endpoint in this
  contract is declared as `{proxy-base}/api/…`.)
- A write the row declares as observed must also be in `may_write`; the gate
  refuses the contradiction rather than letting the test find it.

A `full` row may still carry an individual effect the offline fixture cannot
reach — the Map Builder spec fetch behind `--map-id`, the `codex` and `agents`
destinations of `install-skills`. Each such entry has an empty `observed_in`
**and** a `not_observed_reason`, and `check-effects.mjs` refuses one without the
reason. What it may not be is silent.

## The rule

**A row without its test is not published.** `scripts/check-effects.mjs` (in
`npm run check` and `npm run check:contracts`) fails when:

- a command on the supported CLI surface, a subcommand any help block teaches
  (`src/cli.mjs` and `src/qa-node.mjs`), or an effect-changing flag a help usage
  line carries, has no row;
- a row names no `effect_test`, names one `src/effects.test.mjs` does not
  declare, or names one the per-row generator would not produce (the cases are
  generated from this file, so an unchecked name made the link vacuous);
- a row has no entry in the test's `INVOCATIONS` table, or the table has an
  entry no row claims — a generated case with no argv proves nothing;
- an effect declares no `observed_in` and no `not_observed_reason`;
- a `test_scope: "preflight"` row does not say in its own notes what it cannot
  reach, declares no `preflight` allowances, licenses a whole location or a
  home-directory subtree, names a `may_contact` entry that is not a request
  path, or has an observed write its `may_write` does not allow; a
  `test_scope: "full"` row carries allowances, or has no effect observed
  anywhere;
- the annotations disagree with the row (`readOnlyHint` with declared effects,
  `openWorldHint` without a send, `destructiveHint` off tier `C`);
- two rows claim the same invocation, or a write path opens with no known
  location token;
- `vocabulary.conditions` names a condition `src/effects.test.mjs` does not run.

## When you change a command

Change the effect, change the row, in the same PR. The effect test will tell you
which row is wrong before review does: it names the path that moved and the row
that failed to declare it.
