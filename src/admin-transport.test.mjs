import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createCredentialStore } from './credential-store.mjs';
import { credentialFromResponse, GATEWAY, CLIENT_ID, RESOURCE, SCOPE, runAuthentication } from './login.mjs';
import { readGatewayStoreProfile, gatewayLoginStatus } from './admin-transport.mjs';
const store = 'example.29next.store', binding = { gateway: GATEWAY, client_id: CLIENT_ID, store };
const token = { access_token: 'dummy-access', refresh_token: 'dummy-refresh', grant_id: 'dummy-family', scope: SCOPE, resource: RESOURCE, token_type: 'Bearer', expires_in: 3600, gateway_version: 'a3-offline' };
const next = { ...token, access_token: 'dummy-new-access', refresh_token: 'dummy-new-refresh' };
const json = (data, status = 200) => Response.json(data, { status });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-transport-')); fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const credentials = createCredentialStore({ home, keychain: { available: false } });
  return { home, credentials, seed: record => credentials.transaction(binding, storage => storage.write(record ?? credentialFromResponse(token, store, Date.now()))) };
}
const profile = url => json(url.endsWith('/store/') ? { name: 'Example', primary_domain: 'shop.example.com', contact_address: { phone_number: '+1 555 555 0100' } } : { results: [{ slug: 'terms', title: 'Terms' }] });

test('gateway reads use fixed origin only, correct bound record and consolidated pages', async t => {
  const f = fixture(t); await f.seed(); const calls = [];
  const result = await readGatewayStoreProfile({ subdomain: 'example', credentials: f.credentials, fetchImpl: async (url, init) => { calls.push(url); assert.equal(init.redirect, 'error'); assert.equal(init.headers.Authorization, 'Bearer dummy-access'); return profile(url); } });
  assert.equal(result.status, 'ok'); assert.equal(result.pages_status, 'ok'); assert.deepEqual(calls, [GATEWAY + '/admin/store/', GATEWAY + '/admin/pages/']);
  assert.equal(result.pages.length, 1);
  let requests = 0;
  const wrong = await readGatewayStoreProfile({ subdomain: 'other', credentials: f.credentials, fetchImpl: () => { requests++; } });
  assert.equal(wrong.status, 'credential_missing'); assert.equal(requests, 0);
});
test('401 rotates once under lock and persists the winning pair', async t => {
  const f = fixture(t); await f.seed(); let refreshes = 0;
  const result = await readGatewayStoreProfile({ subdomain: 'example', credentials: f.credentials, fetchImpl: async (url, init) => {
    if (url.endsWith('/token')) { refreshes++; assert.equal(new URLSearchParams(init.body).get('refresh_token'), token.refresh_token); return json(next); }
    if (init.headers.Authorization === 'Bearer dummy-access') return json({ error: 'invalid_token' }, 401);
    return profile(url);
  } });
  assert.equal(result.status, 'ok'); assert.equal(refreshes, 1); assert.equal((await f.credentials.read(binding)).refresh_token, next.refresh_token);
  assert.equal((await f.credentials.read(binding)).refresh_pending, undefined);
});
test('consumed refresh timeout remains ineligible across a fresh store instance and logout', async t => {
  const f = fixture(t); await f.seed(); let refreshes = 0;
  const fetchImpl = async url => { if (url.endsWith('/token')) { refreshes++; return new Promise(() => {}); } return json({ error: 'invalid_token' }, 401); };
  for (let run = 0; run < 2; run++) {
    const credentials = createCredentialStore({ home: f.home, keychain: { available: false } });
    assert.equal((await readGatewayStoreProfile({ subdomain: 'example', credentials, fetchImpl, timeoutMs: 20 })).status, 'unauthorized');
  }
  assert.equal(refreshes, 1); assert.equal((await f.credentials.read(binding)).refresh_pending, true);
  const status = await gatewayLoginStatus({ credentials: f.credentials }); assert.equal(status.accounts[0].state, 'login_required');
  const out = [];
  await runAuthentication(['logout', '--store', 'example'], { credentials: f.credentials, fetchImpl, output: line => out.push(line) });
  assert.equal(refreshes, 1); assert.equal(await f.credentials.read(binding), null);
});
test('zero lifetime/revoked/malformed refresh forces re-login and never persists failed response', async t => {
  for (const variant of ['zero', 'revoked', 'malformed']) {
    const f = fixture(t); await f.seed(); let refreshes = 0;
    const fetchImpl = async url => {
      if (!url.endsWith('/token')) return json({}, 401);
      refreshes++; return variant === 'zero' ? json({ ...next, expires_in: 0 }) : variant === 'revoked' ? json({ error: 'invalid_grant' }, 401) : json({ ...next, resource: 'https://invalid.example' });
    };
    const result = await readGatewayStoreProfile({ subdomain: 'example', credentials: f.credentials, fetchImpl });
    assert.equal(result.status, 'unauthorized'); assert.match(result.detail, /login/);
    assert.equal((await f.credentials.read(binding)).access_token, token.access_token);
    assert.equal((await f.credentials.read(binding)).refresh_pending, true);
    await readGatewayStoreProfile({ subdomain: 'example', credentials: f.credentials, fetchImpl }); assert.equal(refreshes, 1);
  }
});
test('pages failures stay partial; next links and excessive rows are never followed', async t => {
  const f = fixture(t); await f.seed();
  for (const body of [{ results: [], next: 'https://evil.example/token' }, { results: Array.from({ length: 2001 }, () => ({ slug: 'p', title: 'P' })) }, { results: [null] }]) {
    const calls = [];
    const result = await readGatewayStoreProfile({ subdomain: 'example', credentials: f.credentials, fetchImpl: async url => { calls.push(url); return url.endsWith('/store/') ? profile(url) : json(body); } });
    assert.equal(result.status, 'ok'); assert.equal(result.pages_status, 'unavailable'); assert.equal(result.pages, null); assert.equal(calls.length, 2);
  }
});
test('redirects, malformed JSON, oversized and stalled bodies are bounded and sanitized', async t => {
  const f = fixture(t); await f.seed();
  const redirect = profile(GATEWAY + '/admin/store/'); Object.defineProperty(redirect, 'redirected', { value: true });
  for (const response of [redirect, new Response('not-json', { headers: { 'content-type': 'application/json' } }), json({ value: 'x'.repeat(10 * 1048576) }), new Response(new ReadableStream({}), { headers: { 'content-type': 'application/json' } })]) {
    const result = await readGatewayStoreProfile({ subdomain: 'example', credentials: f.credentials, timeoutMs: 20, fetchImpl: async () => response });
    assert.ok(['invalid', 'unreachable'].includes(result.status)); assert.ok(!JSON.stringify(result).includes(token.access_token));
  }
});
test('keychain transaction read/write/write/clear leaves no intermediate selected items', async t => {
  const f = fixture(t), values = new Map();
  const credentials = createCredentialStore({ home: f.home, keychain: { available: true, read: id => values.get(id) ?? null, write: (id, value) => values.set(id, value), clear: id => values.delete(id) } });
  await credentials.transaction(binding, storage => {
    storage.write(credentialFromResponse(token, store, Date.now())); assert.equal(storage.read().access_token, token.access_token);
    storage.write({ ...storage.read(), refresh_pending: true }); assert.equal(storage.read().refresh_pending, true); assert.equal(values.size, 1);
    storage.write(credentialFromResponse(next, store, Date.now())); assert.equal(storage.read().access_token, next.access_token); assert.equal(values.size, 1);
    storage.clear(); assert.equal(storage.read(), null); assert.equal(values.size, 0);
  });
});
test('local status exposes only allowed metadata; pending/expired/unavailable are distinct', async t => {
  const f = fixture(t); assert.equal((await gatewayLoginStatus({ credentials: f.credentials })).state, 'logged_out');
  await f.seed(); const result = await gatewayLoginStatus({ credentials: f.credentials });
  assert.equal(result.accounts[0].state, 'logged_in'); assert.equal(result.accounts[0].gateway_version, 'a3-offline');
  for (const secret of [token.access_token, token.refresh_token, token.grant_id]) assert.ok(!JSON.stringify(result).includes(secret));
  await f.seed(credentialFromResponse(token, store, Date.now() - 7200000)); assert.equal((await gatewayLoginStatus({ credentials: f.credentials })).accounts[0].state, 'access_expired');
  assert.equal((await gatewayLoginStatus({ credentials: { listBindings: async () => { throw new Error('dummy-secret'); } } })).state, 'unavailable');
});

// Two actual Node processes use the same on-disk lock/record. IPC is the fake
// gateway; there is no listener, network, credential argv or environment input.
async function race(t, staleReadNegativeControl) {
  const f = fixture(t); await f.seed();
  const childFile = path.join(f.home, 'race.mjs');
  fs.writeFileSync(childFile, `import { createCredentialStore } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'credential-store.mjs')).href)};
import { readGatewayStoreProfile } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'admin-transport.mjs')).href)};
const credentials = createCredentialStore({home:process.argv[2],keychain:{available:false}});
const binding=${JSON.stringify(binding)};
if(process.argv[3]==='stale') { const stale=await credentials.read(binding), original=credentials.transaction.bind(credentials); credentials.transaction=(b,callback)=>original(b,s=>callback({...s,read:()=>stale})); }
let id=0;const pending=new Map(); process.on('message',m=>{const done=pending.get(m.id); if(done){pending.delete(m.id);done(Response.json(m.body,{status:m.status}));}});
const result=await readGatewayStoreProfile({subdomain:'example',credentials,fetchImpl:(url,init)=>new Promise(resolve=>{const n=++id;pending.set(n,resolve);process.send({id:n,url,auth:init.headers?.Authorization,body:init.body});})});
process.send({result:result.status});process.disconnect();`);
  let refreshes = 0; const initial = [], children = [], results = [];
  await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
    const child = fork(childFile, [f.home, staleReadNegativeControl ? 'stale' : 'safe'], { execPath: process.execPath, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: process.env.PATH, HOME: f.home } }); children.push(child);
    let stderr = ''; child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('race timed out')); }, 5000);
    child.on('error', reject); child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('race child failed: ' + stderr)); });
    child.on('message', message => {
      if (message.result) { results.push(message.result); return; }
      const reply = (body, status = 200) => child.send({ id: message.id, body, status });
      if (message.url.endsWith('/token')) { refreshes++; return reply(refreshes === 1 ? next : { error: 'invalid_grant' }, refreshes === 1 ? 200 : 401); }
      if (message.auth === 'Bearer dummy-access') { initial.push(() => reply({}, 401)); if (initial.length === 2) initial.splice(0).forEach(send => send()); return; }
      reply(message.url.endsWith('/store/') ? { name: 'Example' } : { results: [] });
    });
  })));
  t.after(() => children.forEach(child => child.kill()));
  return { refreshes, results };
}
test('two-process concurrent 401 refresh has one winner; stale-read negative control detects replay', async t => {
  const safe = await race(t, false); assert.equal(safe.refreshes, 1); assert.deepEqual(safe.results.sort(), ['ok', 'ok']);
  const broken = await race(t, true); assert.equal(broken.refreshes, 2); assert.ok(broken.results.includes('unauthorized'));
});

test('tooling status appends safe local login metadata without widening diagnose', async t => {
  const { toolingStatusCommand, toolingDiagnose } = await import('./cli.mjs');
  const f = fixture(t); await f.seed();
  const status = await toolingStatusCommand({ _: ['tooling', 'status'], target: path.join(f.home, 'skills'), platform: 'codex' }, { credentials: f.credentials });
  assert.equal(status.gateway_login.accounts[0].store, store); assert.equal(status.gateway_login.accounts[0].gateway_version, 'a3-offline');
  const diagnostic = toolingDiagnose({ platform: 'codex' }, { runTooling: () => status });
  assert.ok(!JSON.stringify(diagnostic).includes('gateway_login')); assert.ok(!JSON.stringify(diagnostic).includes(store));
  assert.ok(!JSON.stringify(status).includes(token.access_token)); assert.ok(!JSON.stringify(status).includes(token.refresh_token));
});
test('telemetry Admin env remains separate, warned and origin guarded', async t => {
  const { telemetryList } = await import('./cli.mjs');
  const before = process.env.CAMPAIGN_OPS_ADMIN_KEY; process.env.CAMPAIGN_OPS_ADMIN_KEY = 'dummy-ops-listing';
  t.after(() => { if (before === undefined) delete process.env.CAMPAIGN_OPS_ADMIN_KEY; else process.env.CAMPAIGN_OPS_ADMIN_KEY = before; });
  const warnings = []; t.mock.method(console, 'warn', value => warnings.push(value)); t.mock.method(console, 'log', () => {});
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(url); assert.equal(init.headers['X-Campaigns-Ops-Admin-Key'], 'dummy-ops-listing'); assert.equal(init.headers.Authorization, undefined); return Response.json({ runs: [], total: 0 }); };
  await telemetryList({ json: true }, { fetchImpl });
  assert.match(warnings.join(''), /break-glass.*campaigns-os login/); assert.equal(calls.length, 1); assert.ok(calls[0].endsWith('/api/runs')); assert.ok(!calls[0].startsWith(GATEWAY));
  await assert.rejects(telemetryList({ 'proxy-base': 'https://untrusted.example' }, { fetchImpl }), /refusing/); assert.equal(calls.length, 1);
});
test('interrupted logout records refresh pending before consumption', async t => {
  const f = fixture(t); await f.seed(credentialFromResponse(token, store, Date.now() - 3590000));
  let pendingSeen = false;
  // Inspect the actual selected record directly while logout owns the lock;
  // reacquiring that lock here would correctly block the caller.
  await runAuthentication(['logout', '--store', 'example'], { credentials: f.credentials, output() {}, fetchImpl: async url => {
    assert.equal(url, GATEWAY + '/token');
    const dir = path.join(f.home, '.campaigns-os/credentials');
    const file = fs.readdirSync(dir).find(name => name.endsWith('.json'));
    pendingSeen = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).refresh_pending;
    throw new Error('dummy interrupted response');
  } });
  assert.equal(pendingSeen, true); assert.equal(await f.credentials.read(binding), null);
});

test('failed save after confirmed rotation leaves durable pending state, never old-refresh retry', async t => {
  const f = fixture(t); await f.seed(); let refreshes = 0;
  const original = f.credentials.transaction.bind(f.credentials);
  f.credentials.transaction = (b, callback) => original(b, storage => callback({ ...storage, write: record => {
    if (record.access_token === next.access_token) throw new Error('dummy persistence failure');
    return storage.write(record);
  } }));
  const fetchImpl = async url => { if (url.endsWith('/token')) { refreshes++; return json(next); } return json({}, 401); };
  const failed = await readGatewayStoreProfile({ subdomain: 'example', credentials: f.credentials, fetchImpl });
  assert.equal(failed.status, 'unauthorized');
  const fresh = createCredentialStore({ home: f.home, keychain: { available: false } });
  assert.equal((await fresh.read(binding)).refresh_pending, true);
  await readGatewayStoreProfile({ subdomain: 'example', credentials: fresh, fetchImpl }); assert.equal(refreshes, 1);
});

test('projected pages may omit nullable title/slug; usable pages retain partial derivation semantics', async t => {
  const f = fixture(t); await f.seed();
  const result = await readGatewayStoreProfile({ subdomain: 'example', credentials: f.credentials, fetchImpl: async url => url.endsWith('/store/') ? profile(url) : json({ results: [{ slug: 'terms', title: null }, {}] }) });
  assert.equal(result.pages_status, 'ok'); assert.deepEqual(result.pages, [{ slug: 'terms', title: '' }]);
});

test('proactive near-expiry read rotates before sending any protected request', async t => {
  const f = fixture(t); await f.seed(credentialFromResponse({ ...token, expires_in: 30 }, store, Date.now()));
  const calls = [];
  const result = await readGatewayStoreProfile({ subdomain: 'example', credentials: f.credentials, fetchImpl: async (url, init) => {
    calls.push(url);
    if (url.endsWith('/token')) return json(next);
    assert.equal(init.headers.Authorization, 'Bearer ' + next.access_token); return profile(url);
  } });
  assert.equal(result.status, 'ok'); assert.deepEqual(calls, [GATEWAY + '/token', GATEWAY + '/admin/store/', GATEWAY + '/admin/pages/']);
});
test('unavailable and busy storage use actionable fixed guidance without propagating exceptions', async () => {
  for (const phase of ['read', 'lock', 'reread']) {
    let requests = 0;
    const credentials = { read: async () => { if (phase === 'read') throw new Error('dummy-secret-raw-path'); return credentialFromResponse(token, store, Date.now()); }, transaction: async (_binding, callback) => { if (phase === 'reread') return callback({ read() { throw new Error('dummy-secret-raw-path'); } }); throw new Error('dummy-secret-raw-path'); } };
    const result = await readGatewayStoreProfile({ subdomain: 'example', credentials, fetchImpl: async () => { requests++; return json({}, 401); } });
    assert.equal(result.status, 'credential_unavailable'); assert.match(result.detail, /permissions.*keychain.*stale .lock/); assert.ok(!result.detail.includes('dummy-secret')); assert.equal(requests, phase === 'read' ? 0 : 1);
  }
});
