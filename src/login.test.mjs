import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, knownCommands } from './cli.mjs';
import { createCredentialStore, macKeychain } from './credential-store.mjs';
import { GATEWAY, CLIENT_ID, RESOURCE, SCOPE, gatewayRequest, credentialFromResponse } from './login.mjs';

const store = 'example.29next.store';
const binding = { gateway: GATEWAY, client_id: CLIENT_ID, store };
// Deliberately not the gateway implementation's current token alphabet.
const issued = { access_token: 'dummy-access.with+opaque/syntax=', refresh_token: 'dummy-refresh:opaque-value', token_type: 'Bearer', resource: RESOURCE, scope: SCOPE, expires_in: 3600, grant_id: 'dummy-grant', gateway_version: 'a3-offline' };
const device = { device_code: 'dummy-device-opaque', user_code: 'ABCDEF123456', verification_uri: GATEWAY + '/device', expires_in: 600, interval: 5 };
const response = (data, status = 200) => Response.json(data, { status });
function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-login-'));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const output = [], calls = [], delays = []; let time = 1700000000000;
  const credentials = createCredentialStore({ home, cwd: os.tmpdir(), keychain: { available: false }, ...options });
  const deps = { credentials, output: line => output.push(line), now: () => time, pause: async ms => { delays.push(ms); time += ms; } };
  const run = (command, fetchImpl) => main([command, '--store', store], { authentication: { ...deps, fetchImpl: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); } } });
  return { home, credentials, output, calls, delays, deps, run, advance: ms => { time += ms; }, clock: () => time };
}
async function seed(f, data = issued) {
  const record = credentialFromResponse(data, store, f.clock());
  await f.credentials.transaction(binding, storage => storage.write(record)); return record;
}
const loginReply = url => response(url.endsWith('/device/authorize') ? device : issued);

test('CLI device login persists only gateway credentials with pending/slow_down and secure user files', async t => {
  const f = fixture(t); let poll = 0;
  const result = await f.run('login', (url, init) => {
    assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    const fields = new URLSearchParams(init.body);
    assert.equal(fields.get('client_id'), CLIENT_ID); assert.equal(fields.get('resource'), RESOURCE);
    assert.ok(!init.headers.Authorization);
    if (url.endsWith('/device/authorize')) { assert.equal(fields.get('store'), store); assert.equal(fields.get('scope'), SCOPE); return response(device); }
    assert.equal(fields.get('device_code'), device.device_code);
    assert.equal(fields.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
    return ++poll === 1 ? response({ error: 'authorization_pending' }, 400) : poll === 2 ? response({ error: 'slow_down' }, 400) : response(issued);
  });
  assert.equal(result.ok, true); assert.deepEqual(f.delays, [5000, 5000, 10000]);
  const saved = await f.credentials.read(binding); assert.equal(saved.access_token, issued.access_token); assert.equal(saved.gateway_version, 'a3-offline');
  assert.equal(saved.store, store); assert.equal(saved.resource, RESOURCE);
  const dir = path.join(f.home, '.campaigns-os/credentials'); assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const files = fs.readdirSync(dir); assert.equal(files.length, 1); assert.match(files[0], /^[a-f0-9]{64}\.json$/); assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600);
  const printed = f.output.join('\n'); assert.match(printed, /ABCDEF123456/); assert.match(printed, /https:\/\/mcp.nextcommerce.com\/device/);
  for (const secret of [issued.access_token, issued.refresh_token, device.device_code]) assert.ok(!printed.includes(secret));
  assert.ok(knownCommands().includes('login')); assert.ok(knownCommands().includes('logout'));
});

test('401 and terminal device errors preserve existing login without fallback', async t => {
  for (const [error, status, match] of [['invalid_grant', 401, /refused authorization/], ['access_denied', 400, /declined/], ['expired_token', 400, /expired/]]) {
    await t.test(error, async t => {
      const f = fixture(t); const original = await seed(f);
      await assert.rejects(f.run('login', url => url.endsWith('/device/authorize') ? response(device) : response({ error, secret: issued.access_token }, status)), match);
      assert.deepEqual(await f.credentials.read(binding), original); assert.ok(f.calls.every(c => c.url.startsWith(GATEWAY + '/')));
      assert.ok(!f.output.join('').includes(issued.access_token));
    });
  }
});
test('fresh 401 writes no credential and pending polling terminates at the advertised deadline', async t => {
  const f = fixture(t);
  await assert.rejects(f.run('login', () => response({ error: 'invalid_request' }, 401)), /refused authorization/);
  assert.equal(await f.credentials.read(binding), null);
  await assert.rejects(f.run('login', url => response(url.endsWith('/device/authorize') ? { ...device, expires_in: 12 } : { error: 'authorization_pending' }, url.endsWith('/device/authorize') ? 200 : 400)), /expired/);
  assert.equal(await f.credentials.read(binding), null); assert.deepEqual(f.delays, [5000, 5000]);
});
test('wrong resource/scope/type/lifetime and hostile verification link never persist', async t => {
  for (const altered of [{ resource: 'https://example.com/' }, { scope: 'write' }, { token_type: 'Basic' }, { expires_in: 3601 }, { access_token: 'line\r\nbreak' }]) {
    const f = fixture(t);
    await assert.rejects(f.run('login', url => response(url.endsWith('/device/authorize') ? device : { ...issued, ...altered })), /Could not complete/);
    assert.equal(await f.credentials.read(binding), null);
  }
  const f = fixture(t); await assert.rejects(f.run('login', () => response({ ...device, verification_uri: 'https://example.com/?secret=dummy' })), /Could not complete/); assert.equal(f.output.length, 0);
});
test('network failures, oversized body, and stalled body are bounded and sanitized', async () => {
  await assert.rejects(gatewayRequest('/token', { fetchImpl: async () => { throw new Error(issued.access_token); } }), e => !e.message.includes(issued.access_token));
  await assert.rejects(gatewayRequest('/token', { fetchImpl: async () => response({ value: 'x'.repeat(40000) }) }), e => e.code === 'invalid_response');
  let canceled = false;
  await assert.rejects(gatewayRequest('/token', { timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'content-type': 'application/json' } }) }), e => e.code === 'unavailable');
  assert.equal(canceled, true);
  await assert.rejects(gatewayRequest('/token', { timeoutMs: 20, fetchImpl: () => new Promise(() => {}) }), e => e.code === 'unavailable');
});
test('logout revokes with empty-body access bearer then clears local state', async t => {
  const f = fixture(t); await seed(f);
  const result = await f.run('logout', (url, init) => { assert.equal(url, GATEWAY + '/revoke'); assert.equal(init.headers.Authorization, 'Bearer ' + issued.access_token); assert.equal(init.body, undefined); return response({ revoked: true }); });
  assert.equal(result.remote_revocation, 'revoked'); assert.equal(await f.credentials.read(binding), null);
});
test('expired logout refreshes under lock, then revokes; remote failures still clear locally', async t => {
  const f = fixture(t); await seed(f); f.advance(3600001);
  const next = { ...issued, access_token: 'new-dummy-access', refresh_token: 'new-dummy-refresh' };
  const result = await f.run('logout', (url, init) => {
    if (url.endsWith('/token')) { assert.equal(new URLSearchParams(init.body).get('refresh_token'), issued.refresh_token); return response(next); }
    assert.equal(init.headers.Authorization, 'Bearer ' + next.access_token); return response({ revoked: true });
  });
  assert.equal(result.remote_revocation, 'revoked'); assert.equal(await f.credentials.read(binding), null);
  for (const status of [401, 503]) {
    await seed(f); const failed = await f.run('logout', () => response({ error: 'invalid_token' }, status));
    assert.equal(failed.remote_revocation, status === 401 ? 'unrecognized' : 'unconfirmed'); assert.equal(await f.credentials.read(binding), null);
  }
});
test('concurrent credential replacement cannot be overwritten by finishing login', async t => {
  const f = fixture(t); const original = await seed(f); let newer;
  await assert.rejects(f.run('login', async url => {
    if (url.endsWith('/device/authorize')) return response(device);
    newer = { ...original, refresh_token: 'newer-dummy-refresh' };
    await f.credentials.transaction(binding, storage => storage.write(newer)); return response(issued);
  }), /changed during login/);
  assert.deepEqual(await f.credentials.read(binding), newer);
});
test('invalid flags or token inputs fail before networking and lifecycle writes', async t => {
  const f = fixture(t); let requested = false;
  for (const args of [['login', '--store', store, '--token', 'dummy-secret'], ['login', '--store', store, '--store', store], ['login', '--store', 'https://example.com'], ['logout']]) {
    await assert.rejects(main(args, { authentication: { ...f.deps, fetchImpl: async () => { requested = true; } } }), /Use:|Provide --store|Use --store/);
  }
  assert.equal(requested, false);
});
test('keychain provider uses stdin only for writes, verifies saved bytes, and never exposes errors', () => {
  let saved = null; const invocations = [];
  const provider = macKeychain({ platform: 'darwin', run: (_file, args, options) => {
    invocations.push({ args, options });
    if (args[0] === '-i') { const hex = options.input.match(/-X ([a-f0-9]+)\n$/)[1]; saved = Buffer.from(hex, 'hex').toString(); return { status: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'delete-generic-password') { saved = null; return { status: 0 }; }
    return saved === null ? { status: 44 } : { status: 0, stdout: saved + '\n' };
  } });
  const id = 'a'.repeat(64); const value = JSON.stringify(issued);
  assert.equal(provider.read(id), null); provider.write(id, value); assert.equal(provider.read(id), value); provider.clear(id); assert.equal(provider.read(id), null);
  assert.ok(invocations.every(x => !x.args.join(' ').includes(issued.access_token)));
  const denied = macKeychain({ run: () => ({ status: 36, stderr: issued.access_token }) });
  assert.throws(() => denied.read(id), e => !e.message.includes(issued.access_token));
});
test('keychain-backed complete login/logout stores no plaintext file', async t => {
  let saved = null;
  const f = fixture(t, { keychain: { available: true, read: () => saved, write: (_id, value) => { saved = value; }, clear: () => { saved = null; } } });
  await f.run('login', loginReply); assert.equal(JSON.parse(saved).access_token, issued.access_token);
  const dir = path.join(f.home, '.campaigns-os/credentials');
  const pointer = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
  assert.equal(JSON.parse(pointer).backend, 'keychain'); assert.ok(!pointer.includes(issued.access_token));
  await f.run('logout', () => response({ revoked: true })); assert.equal(saved, null);
});

test('failed keychain replacement preserves selected credential', async t => {
  const values = new Map(); let rejectWrite = false;
  const f = fixture(t, { keychain: { available: true, read: id => values.get(id) ?? null, write: (id, value) => { if (rejectWrite) throw new Error('dummy-provider-error'); values.set(id, value); }, clear: id => values.delete(id) } });
  await f.run('login', loginReply); const previous = await f.credentials.read(binding); rejectWrite = true;
  await assert.rejects(f.run('login', loginReply), /unsafe/);
  assert.deepEqual(await f.credentials.read(binding), previous); assert.equal(values.size, 1);
});

test('optional store prompts once; shorthand canonicalizes; noninteractive missing/invalid stores make no request', async t => {
  const f = fixture(t); let prompts = 0;
  const authentication = { ...f.deps, interactive: true, promptStore: async () => { prompts++; return 'example'; }, fetchImpl: async (url, init) => { if (url.endsWith('/device/authorize')) assert.equal(new URLSearchParams(init.body).get('store'), store); return loginReply(url); } };
  await main(['login'], { authentication }); assert.equal(prompts, 1); assert.equal((await f.credentials.read(binding)).store, store);
  await main(['login', '--store', 'EXAMPLE'], { authentication }); assert.equal(prompts, 1);
  let requests = 0;
  for (const args of [['login'], ['login', '--store', 'example.com'], ['login', '--store', 'example-'], ['login', '--store', 'example.29next.store.evil.test']]) {
    await assert.rejects(main(args, { authentication: { ...f.deps, interactive: false, fetchImpl: async () => { requests++; } } }), /--store/);
  }
  assert.equal(requests, 0);
});

test('gateway uppercase code is required, while an already-issued response at the deadline is retained', async t => {
  const f = fixture(t);
  await assert.rejects(f.run('login', () => response({ ...device, user_code: 'abcdef123456' })), /Could not complete/);
  assert.equal(await f.credentials.read(binding), null);
  await f.run('login', url => {
    if (url.endsWith('/device/authorize')) return response({ ...device, expires_in: 6 });
    f.advance(1000); return response(issued);
  });
  assert.equal((await f.credentials.read(binding)).access_token, issued.access_token);
});
test('logout uses the expiry margin once and never retries an uncertain refresh', async t => {
  const f = fixture(t); await seed(f, { ...issued, expires_in: 30 });
  const result = await f.run('logout', url => { assert.equal(url, GATEWAY + '/token'); throw new Error('dummy-uncertain'); });
  assert.equal(f.calls.length, 1); assert.equal(result.remote_revocation, 'unconfirmed'); assert.equal(result.local_cleared, true); assert.equal(await f.credentials.read(binding), null);
});
test('missing keychain item has recovery hint and logout distinguishes local failure', async t => {
  const values = new Map();
  const f = fixture(t, { keychain: { available: true, read: id => values.get(id) ?? null, write: (id, value) => values.set(id, value), clear: id => values.delete(id) } });
  await f.run('login', loginReply); values.clear();
  await assert.rejects(f.run('login', loginReply), /logout --store/);
  const result = await f.run('logout', () => { throw new Error('must not call gateway'); });
  assert.equal(result.remote_revocation, 'not_attempted'); assert.equal(result.local_cleared, true);
  assert.match(f.output.at(-1), /Local credentials could not be read/); assert.equal(await f.credentials.read(binding), null);
});
test('keychain deletion failure reports cleared selection and retained item without blaming gateway', async t => {
  const values = new Map();
  const f = fixture(t, { keychain: { available: true, read: id => values.get(id) ?? null, write: (id, value) => values.set(id, value), clear: () => { throw new Error('dummy-local-denial'); } } });
  await f.run('login', loginReply);
  const result = await f.run('logout', () => response({ revoked: true }));
  assert.equal(result.local_cleared, true); assert.equal(result.keychain_item_removed, false); assert.equal(result.remote_revocation, 'revoked');
  assert.equal(await f.credentials.read(binding), null); assert.match(f.output.at(-1), /unselected keychain item/);
});

test('native keychain hexadecimal Unicode JSON readback roundtrips; ASCII remains unchanged', () => {
  let nativeBytes = null;
  const provider = macKeychain({ run: (_file, args, options) => {
    if (args[0] === '-i') { nativeBytes = Buffer.from(options.input.match(/-X ([a-f0-9]+)\n$/)[1], 'hex'); return { status: 0 }; }
    if (!nativeBytes) return { status: 44 };
    const text = nativeBytes.toString('utf8');
    return { status: 0, stdout: (/[^\x00-\x7f]/.test(text) ? nativeBytes.toString('hex') : text) + '\n' };
  } });
  const id = 'b'.repeat(64);
  for (const value of [JSON.stringify({ ...issued, label: 'café' }), JSON.stringify(issued)]) {
    provider.write(id, value); assert.equal(provider.read(id), value);
  }
});
test('native hex decoding rejects arbitrary text, malformed UTF8/JSON, odd hex and oversize records', () => {
  for (const stdout of ['deadbeef', '7b7d0', '7b2261223a22ff227d', '7b6e6f74206a736f6e7d', '7b' + '20'.repeat(65536) + '7d', '{"a":"' + 'x'.repeat(65536) + '"}']) {
    const provider = macKeychain({ run: () => ({ status: 0, stdout: stdout + '\n' }) });
    assert.throws(() => provider.read('b'.repeat(64)), /Credential storage/);
  }
});
