# Gateway login and direct-token migration

The 1.38.0 candidate supports the admitted owned-store private gateway pilot
with the registered Campaigns OS CLI client. It is not general merchant
availability. Publication, external trials and additional clients are separately
gated. A successful owned-store drill does not prove automatic uninstall
handling or authorize other stores.

## Sign in

```sh
campaigns-os login --store example
# The equivalent canonical host is example.29next.store.
```

`--store` is optional in an interactive terminal: one prompt asks for the store.
There is no discovery or guess from the current project. Noninteractive calls
must supply `--store`. URLs, paths and unrelated hosts are refused before any
request. Login uses the fixed `https://mcp.nextcommerce.com` gateway.

Open the displayed device page in one browser tab and enter the displayed code.
Keep that tab: if installation is needed, follow its Install Campaigns link,
sign in to the store dashboard and launch Campaigns. Match the code and explicitly
allow reads. Return to the CLI. Pilot admission is operator controlled; knowing
the store host or device-page URL is not an invitation. Never paste a dashboard
or Admin token into the CLI. Login waits for browser consent within the device
code's expiry; denial, timeout and failed persistence preserve the prior login.

Gateway access and refresh credentials are stored outside the project. On macOS,
the CLI prefers the user keychain; when unavailable it uses private user files
under `~/.campaigns-os/credentials` (directory `0700`, files `0600`). Keychain
selection metadata lives there too. The parent must be owned by the user and
not group/other writable. Credential paths reject symlinks; a symlinked home is
not supported in this pilot. Do not copy these files into a repository, support
export or CI secret bundle. These are gateway credentials, not platform Admin
tokens; platform OAuth custody stays server side.

## Migrate store reads

The default changed. A command that formerly read `EXAMPLE_ADMIN_TOKEN`
automatically now requires a gateway login for the selected store:

```sh
campaigns-os login --store example
campaigns-os spec derive --packet campaign-runtime.build.json --from-store example --dry-run
```

Existing direct callers, including callers outside the admitted pilot, can retain
the direct path by explicitly naming their existing environment variable:

```sh
campaigns-os spec derive --packet campaign-runtime.build.json --from-store example --store-token-source env:EXAMPLE_ADMIN_TOKEN --dry-run
```

This break-glass path emits a warning and bypasses gateway custody. Its Admin
token needs `store:read` and `content:read`. Do not put its value in argv.
The default never checks that variable or falls back to it after a gateway error.
An unavailable gateway fails closed. Gateway reads use `/admin/store/` and
`/admin/pages/`; custody consolidates bounded upstream page results. Derivation
still uses the same nine Store Profile fields and leaves missing or ambiguous
values unchanged. The output distinguishes the actual gateway endpoint from
the logical store Admin API source. See [Store Profile derivation](build-packet.md).

Refresh is serialized per store binding. The CLI records a pending state before
sending a refresh, then atomically saves the confirmed winning pair. A lost
response, interrupted process or uncertain save requires a new login; the next
invocation must not replay an old refresh. An expired absolute grant also requires
login. A refresh may happen before access expires, or once after an unauthorized
read; it is not an unlimited retry loop.

## Inspect and recover

`campaigns-os tooling status --json` includes `gateway_login` metadata for saved
bindings, without `--store` or project inference. It shows store, local access
expiry/remaining time and the gateway version reported when credentials were
issued. It makes no gateway validity request and exports no credential values.
`logged_in` means the saved access expiry is in the future, not that the remote
grant is still valid. `access_expired` can still refresh on use; `login_required`
means reauthorize. A reported version such as `a3-offline` is metadata, not proof
of deployed source identity. `tooling diagnose` remains a separate redacted
support export and omits gateway login/store metadata.

Storage contention waits up to three seconds, then reports unavailable/busy.
Retry after the other CLI finishes; check user-directory permissions and keychain
access. One malformed or unreadable record makes the whole gateway status
unavailable in this pilot; it does not prove that all stores are logged out.
After a crash, confirm no Campaigns OS process is running before removing the
stale binding's `.lock` directory under `~/.campaigns-os/credentials`. Never
remove another live process's lock. If selection metadata is damaged, preserve
it privately and repair or move aside only that binding's broken selection file
before logging in again; this does not remotely revoke an old grant. Do not
bypass ownership or symlink checks by making the directory world writable.

## Sign out

```sh
campaigns-os logout --store example
```

Logout uses the same optional interactive store prompt. It attempts gateway
revocation and clears the local selected login. Its message distinguishes
confirmed remote revocation from an unrecognized grant, failed request or
unreadable local record. Local cleanup alone is not proof of remote revocation;
a failed keychain-item cleanup is reported separately. A pending/uncertain
refresh is never replayed during logout. If remote revocation is unconfirmed,
use the pilot operator's grant-revocation procedure; do not assume uninstall or
local file deletion revoked it.

Login, logout and the offline demo bypass lifecycle capture; login/logout do not
accept general lifecycle flags. `tooling diagnose` also bypasses lifecycle
capture. Gateway login does not grant telemetry administration:
`CAMPAIGN_OPS_ADMIN_KEY` remains a separate cross-tenant `/api/runs` credential,
with its existing trusted-origin safeguards and explicit warning.
