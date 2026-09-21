import { createCredentialStore } from './credential-store.mjs';

export const GATEWAY = 'https://mcp.nextcommerce.com';
export const CLIENT_ID = 'campaigns-os-owned-store-pilot';
export const RESOURCE = GATEWAY + '/campaigns';
export const SCOPE = 'campaigns:read';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeString = (value, max = 8192) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
class GatewayError extends Error {
  constructor(code, status = 0) { super('Gateway request failed.'); this.code = code; this.status = status; }
}
export function canonicalLoginStore(value) {
  if (typeof value !== 'string') throw new Error('Provide --store <subdomain> or --store <subdomain.29next.store>.');
  const host = value.trim().toLowerCase();
  const label = host.endsWith('.29next.store') ? host.slice(0, -13) : host;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) throw new Error('Provide --store <subdomain> or --store <subdomain.29next.store>.');
  return label + '.29next.store';
}
export function authenticationArguments(argv) {
  const command = argv[0];
  if (!['login', 'logout'].includes(command) || !(argv.length === 1 || (argv.length === 3 && argv[1] === '--store'))) {
    throw new Error('Use: campaigns-os login [--store <subdomain>], or campaigns-os logout [--store <subdomain>]. No token arguments are accepted.');
  }
  return { command, store: argv.length === 3 ? canonicalLoginStore(argv[2]) : null };
}
async function askStore() {
  const { createInterface } = await import('node:readline/promises');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return await prompt.question('Store subdomain (or network domain): '); }
  finally { prompt.close(); }
}
const bindingFor = store => ({ gateway: GATEWAY, client_id: CLIENT_ID, store });

// Deliberately no configurable origin/discovery and no response-body errors.
export async function gatewayRequest(route, { form, accessToken, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!['/device/authorize', '/token', '/revoke'].includes(route)) throw new GatewayError('invalid_request');
  const controller = new AbortController();
  let reader, timer;
  const work = async () => {
    const headers = { Accept: 'application/json' };
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const response = await fetchImpl(GATEWAY + route, { method: 'POST', headers, body: form ? new URLSearchParams(form).toString() : undefined, redirect: 'error', signal: controller.signal });
    if (response.redirected || (response.url && response.url !== GATEWAY + route)) throw new GatewayError('invalid_response');
    if (response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new GatewayError('invalid_response', response.status);
    reader = response.body?.getReader();
    if (!reader) throw new GatewayError('invalid_response', response.status);
    const chunks = []; let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > 32768) throw new GatewayError('invalid_response'); chunks.push(value);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new GatewayError('invalid_response', response.status); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GatewayError('invalid_response', response.status);
    if (!response.ok) {
      const code = ['authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_grant', 'invalid_token', 'invalid_request', 'temporarily_unavailable'].includes(data.error) ? data.error : 'request_refused';
      throw new GatewayError(code, response.status);
    }
    return data;
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new GatewayError('unavailable')); }, Math.max(1, Math.min(timeoutMs, 15000))); })]);
  } catch (error) { throw error instanceof GatewayError ? error : new GatewayError('unavailable'); }
  finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); }
}
export function credentialFromResponse(data, store, receivedAt) {
  if (!safeString(data.access_token) || !safeString(data.refresh_token) || data.access_token === data.refresh_token || data.token_type !== 'Bearer' || data.resource !== RESOURCE || data.scope !== SCOPE || !Number.isInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 3600 || !safeString(data.grant_id, 256) || !safeString(data.gateway_version, 128)) throw new GatewayError('invalid_response');
  return { schema_version: 1, ...bindingFor(store), resource: RESOURCE, scope: SCOPE, token_type: 'Bearer', access_token: data.access_token, refresh_token: data.refresh_token, access_expires_at: receivedAt + data.expires_in * 1000, received_at: receivedAt, grant_id: data.grant_id, gateway_version: data.gateway_version };
}
function validateStored(record) {
  if (record.schema_version !== 1 || record.resource !== RESOURCE || record.scope !== SCOPE || record.token_type !== 'Bearer' || !safeString(record.access_token) || !safeString(record.refresh_token) || !Number.isFinite(record.access_expires_at)) throw new GatewayError('invalid_response');
}
function loginFailure(error) {
  if (error?.status === 401) return new Error('Gateway refused authorization. No new credentials were saved. Run campaigns-os login again.');
  if (error?.code === 'access_denied') return new Error('Connection declined. No new credentials were saved.');
  if (error?.code === 'expired_token') return new Error('Connection code expired. Run campaigns-os login again.');
  if (error?.code === 'invalid_request') return new Error('Gateway refused this store or client. Check the network-domain store and gateway availability.');
  return new Error('Could not complete gateway login. Check gateway availability and retry; no new credentials were saved.');
}
export async function runAuthentication(argv, { fetchImpl = globalThis.fetch, credentials = createCredentialStore(), now = Date.now, pause = sleep, output = console.log, interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY), promptStore = askStore } = {}) {
  const args = authenticationArguments(argv);
  if (!args.store && !interactive) throw new Error("Use --store <subdomain> for noninteractive login or logout. No network request was made.");
  const command = args.command;
  const store = args.store ?? canonicalLoginStore(await promptStore());
  const binding = bindingFor(store);
  if (command === 'logout') {
    let remote = 'no_local_grant', localIssue = false;
    let cleanup = { local_cleared: false, keychain_item_removed: true };
    await credentials.transaction(binding, async storage => {
      try {
        let record;
        try { record = storage.read(); if (record) validateStored(record); }
        catch { localIssue = true; remote = 'not_attempted'; return; }
        if (!record) return;
        try {
          // Include network/clock skew in the decision; never retry a consumed
          // refresh blindly after an uncertain response.
          if (!record.refresh_pending && record.access_expires_at <= now() + 60000) {
            const { rotateLockedCredential } = await import('./admin-transport.mjs');
            record = await rotateLockedCredential(storage, record, { fetchImpl, now });
          }
          // Pending refresh means its outcome is unknown. Try access revocation
          // once, never replay that refresh, then clear the local selection.
          const result = await gatewayRequest('/revoke', { fetchImpl, accessToken: record.access_token });
          if (result.revoked !== true) throw new GatewayError('invalid_response');
          remote = 'revoked';
        } catch (error) { remote = error?.status === 401 || error?.httpStatus === 401 ? 'unrecognized' : 'unconfirmed'; }
      } finally { cleanup = storage.clear(); }
    });
    output(localIssue ? 'Local login selection cleared. Local credentials could not be read; remote revocation was not attempted.' : remote === 'revoked' ? 'Logged out. Gateway grant revoked and local login selection cleared.' : remote === 'unrecognized' ? 'Local login selection cleared. Gateway no longer recognizes this grant; remote revocation was not confirmed.' : remote === 'unconfirmed' ? 'Local login selection cleared. Remote revocation was not confirmed because the gateway request failed.' : 'No local login for this store.');
    if (!cleanup.keychain_item_removed) output('An unselected keychain item could not be deleted. Check the com.nextcommerce.campaigns-os items in Keychain Access.');
    return { ok: true, store, remote_revocation: remote, ...cleanup };
  }
  // Capture existing pair before network activity. Recheck under lock on save
  // so another process's successful login/refresh/logout cannot be overwritten.
  const previous = await credentials.read(binding);
  let record;
  try {
    const started = now();
    const device = await gatewayRequest('/device/authorize', { fetchImpl, form: { client_id: CLIENT_ID, resource: RESOURCE, scope: SCOPE, store } });
    if (!safeString(device.device_code) || !/^[A-F0-9]{12}$/.test(device.user_code) || device.verification_uri !== GATEWAY + '/device' || !Number.isInteger(device.expires_in) || device.expires_in <= 0 || device.expires_in > 600 || !Number.isInteger(device.interval) || device.interval < 5 || device.interval > 60) throw new GatewayError('invalid_response');
    output(`Open ${GATEWAY}/device in one browser tab and enter code ${device.user_code}.`);
    output(`Keep using that browser: if needed, use its Install Campaigns link (${GATEWAY}/install), then sign in to ${store}'s dashboard and launch Campaigns. Match the code and explicitly allow reads. Return here afterward. Never paste a dashboard token into the CLI.`);
    const deadline = started + device.expires_in * 1000; let interval = device.interval * 1000;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (now() + interval >= deadline) throw new GatewayError('expired_token');
      await pause(interval);
      const polledAt = now(); if (polledAt >= deadline) throw new GatewayError('expired_token');
      try {
        const data = await gatewayRequest('/token', { fetchImpl, timeoutMs: deadline - polledAt, form: { grant_type: DEVICE_GRANT, client_id: CLIENT_ID, resource: RESOURCE, device_code: device.device_code } });
        // A successful response means the authority issued this grant. Do not
        // abandon it merely because local time crossed the device deadline.
        record = credentialFromResponse(data, store, polledAt); break;
      } catch (error) {
        if (error.status === 401) throw error;
        if (error.code === 'authorization_pending') continue;
        if (error.code === 'slow_down') { interval = Math.min(60000, interval + 5000); continue; }
        throw error;
      }
    }
    if (!record) throw new GatewayError('expired_token');
  } catch (error) { throw loginFailure(error); }
  await credentials.transaction(binding, storage => {
    const current = storage.read();
    if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error('Credential storage changed during login. The existing login was preserved; retry.');
    storage.write(record);
  });
  output(`Logged in for ${store}. Gateway credentials saved to your user credential store.`);
  return { ok: true, store, access_expires_at: record.access_expires_at };
}
