import { createCredentialStore } from './credential-store.mjs';
import { GATEWAY, CLIENT_ID, RESOURCE, SCOPE, canonicalLoginStore, gatewayRequest, credentialFromResponse } from './login.mjs';

const MAX_BYTES = 10 * 1048576; // custody consolidates at most ten bounded pages
const MAX_ROWS = 2000;
const REQUEST_MS = 15000, BUDGET_MS = 45000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/u.test(value);
class ReadFailure extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}
const storageUnavailable = () => new ReadFailure('credential_unavailable', 'Gateway credential storage is unavailable or busy. Check your user credential directory permissions and keychain access; wait for another campaigns-os process to finish. For an interrupted process, confirm no campaigns-os process is running before removing its stale .lock directory. No environment fallback was attempted.');
const loginRequired = () => new ReadFailure('unauthorized', 'Gateway login is expired, revoked, or needs recovery. Run campaigns-os login --store <subdomain>.');
const bindingFor = store => ({ gateway: GATEWAY, client_id: CLIENT_ID, store });
function validate(record, binding) {
  if (!record) throw new ReadFailure('credential_missing', 'No gateway login for this store. Run campaigns-os login --store <subdomain>.');
  if (record.gateway !== binding.gateway || record.client_id !== binding.client_id || record.store !== binding.store || record.resource !== RESOURCE || record.scope !== SCOPE || record.schema_version !== 1 || record.token_type !== 'Bearer' || !opaque(record.access_token) || !opaque(record.refresh_token) || !opaque(record.grant_id) || !Number.isFinite(record.access_expires_at) || record.refresh_pending) throw loginRequired();
  return record;
}
async function readJson(route, token, { fetchImpl, timeoutMs }) {
  const controller = new AbortController(); let timer, reader;
  const run = async () => {
    const response = await fetchImpl(GATEWAY + route, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, redirect: 'error', signal: controller.signal });
    if (response.redirected || (response.url && response.url !== GATEWAY + route)) throw new ReadFailure('invalid', 'Gateway returned an unexpected redirect.');
    if (response.status === 401) throw Object.assign(loginRequired(), { httpStatus: 401 });
    if (response.status === 403) throw loginRequired();
    if (response.status === 404) throw new ReadFailure('not_found', 'Gateway read route or store is unavailable.');
    if (!response.ok) throw new ReadFailure('unreachable', 'Gateway read failed. No environment credential fallback was attempted.');
    if (response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new ReadFailure('invalid', 'Gateway did not return a JSON profile.');
    reader = response.body?.getReader(); if (!reader) throw new ReadFailure('invalid', 'Gateway returned an empty profile.');
    const chunks = []; let size = 0;
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) throw new ReadFailure('invalid', 'Gateway response exceeded the read bound.'); chunks.push(value); }
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ReadFailure('invalid', 'Gateway response was not valid JSON.'); }
    if (!object(body)) throw new ReadFailure('invalid', 'Gateway response was not the documented object.');
    return body;
  };
  try {
    if (timeoutMs <= 0) throw new ReadFailure('unreachable', 'Gateway read budget expired.');
    return await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ReadFailure('unreachable', 'Gateway read timed out.')); }, Math.min(REQUEST_MS, timeoutMs)); })]);
  } catch (error) { throw error instanceof ReadFailure ? error : new ReadFailure('unreachable', 'Gateway is unreachable. No environment credential fallback was attempted.'); }
  finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); }
}

// Caller owns the exclusive credential transaction. Logout uses this same
// durable consumption boundary, including when interrupted before cleanup.
export async function rotateLockedCredential(storage, current, { fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = REQUEST_MS } = {}) {
  if (current.refresh_pending) throw loginRequired();
  storage.write({ ...current, refresh_pending: true });
  try {
    const started = now();
    const data = await gatewayRequest('/token', { fetchImpl, timeoutMs, form: { grant_type: 'refresh_token', client_id: CLIENT_ID, resource: RESOURCE, refresh_token: current.refresh_token } });
    if (data.expires_in === 0) throw new ReadFailure('unauthorized', 'Gateway grant has expired. Run campaigns-os login --store <subdomain>.');
    if (data.grant_id !== current.grant_id) throw loginRequired();
    const next = credentialFromResponse(data, current.store, started);
    storage.write(next);
    return next;
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    const failure = loginRequired(); failure.httpStatus = error?.status; throw failure;
  }
}

export async function readGatewayStoreProfile({ subdomain, credentials = createCredentialStore(), fetchImpl = globalThis.fetch, now = Date.now, budgetMs = BUDGET_MS, timeoutMs = REQUEST_MS } = {}) {
  let binding;
  try { binding = bindingFor(canonicalLoginStore(subdomain)); } catch { return { status: 'invalid', detail: 'Invalid store for gateway login.' }; }
  const deadline = now() + Math.min(BUDGET_MS, budgetMs);
  const remaining = () => Math.min(timeoutMs, deadline - now());
  let record, refreshUsed = false;
  const refresh = async loaded => {
    if (refreshUsed) throw loginRequired();
    refreshUsed = true;
    const outcome = await credentials.transaction(binding, async storage => {
      try {
        const current = validate(storage.read(), binding);
        if (current.refresh_token !== loaded.refresh_token || current.access_token !== loaded.access_token) return { record: current };
        if (remaining() <= 0) throw new ReadFailure('unreachable', 'Gateway read budget expired before refresh.');
        return { record: await rotateLockedCredential(storage, current, { fetchImpl, now, timeoutMs: remaining() }) };
      } catch (error) { return { failure: error instanceof ReadFailure ? error : storageUnavailable() }; }
    });
    if (outcome.failure) throw outcome.failure;
    return outcome.record;
  };
  const request = async route => {
    if (record.access_expires_at <= now() + 60000) record = await refresh(record);
    try { return await readJson(route, record.access_token, { fetchImpl, timeoutMs: remaining() }); }
    catch (error) {
      if (error.httpStatus !== 401) throw error;
      record = await refresh(record);
      return readJson(route, record.access_token, { fetchImpl, timeoutMs: remaining() });
    }
  };
  try {
    record = validate(await credentials.read(binding), binding);
    const store = await request('/admin/store/');
    // A projected sparse store is legitimate: pure derivation explains every
    // missing field. Do not invent required profile fields here.
    try {
      const body = await request('/admin/pages/');
      if (!Array.isArray(body.results) || body.results.length > MAX_ROWS || Object.hasOwn(body, 'next') || body.results.some(row => !object(row) || (row.slug != null && typeof row.slug !== 'string') || (row.title != null && typeof row.title !== 'string'))) throw new ReadFailure('invalid', 'Gateway returned an invalid consolidated page list.');
      return { status: 'ok', store, pages: body.results.filter(row => typeof row.slug === 'string' && row.slug.trim()).map(({ slug, title }) => ({ slug, title: typeof title === 'string' ? title : '' })), pages_status: 'ok', pages_detail: null };
    } catch (error) {
      return { status: 'ok', store, pages: null, pages_status: 'unavailable', pages_detail: error instanceof ReadFailure ? error.message : storageUnavailable().message };
    }
  } catch (error) {
    const failure = error instanceof ReadFailure ? error : storageUnavailable();
    return { status: failure.status, detail: failure.message };
  }
}

export async function gatewayLoginStatus({ credentials = createCredentialStore(), now = Date.now } = {}) {
  try {
    const bindings = await credentials.listBindings();
    const accounts = [];
    for (const binding of bindings) {
      if (binding.gateway !== GATEWAY || binding.client_id !== CLIENT_ID) continue;
      const record = await credentials.read(binding);
      try { validate(record, binding); }
      catch { accounts.push({ store: canonicalLoginStore(binding.store), state: 'login_required', access_expires_at: null, remaining_seconds: 0, gateway_version: null }); continue; }
      accounts.push({ store: binding.store, state: record.access_expires_at > now() ? 'logged_in' : 'access_expired', access_expires_at: record.access_expires_at, remaining_seconds: Math.max(0, Math.floor((record.access_expires_at - now()) / 1000)), gateway_version: typeof record.gateway_version === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(record.gateway_version) && ![record.access_token, record.refresh_token].some(token => record.gateway_version.includes(token)) ? record.gateway_version : null });
    }
    return { gateway: GATEWAY, checked: 'local_only', state: accounts.length ? 'available' : 'logged_out', accounts };
  } catch { return { gateway: GATEWAY, checked: 'local_only', state: 'unavailable', accounts: [] }; }
}
