import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCredentialStore } from './credential-store.mjs';
const binding = { gateway: 'https://mcp.nextcommerce.com', client_id: 'campaigns-os-owned-store-pilot', store: 'example.29next.store' };
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-store-')); fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { force: true, recursive: true }));
  return { home, provider: options => createCredentialStore({ home, cwd: os.tmpdir(), keychain: { available: false }, ...options }) };
}
test('fallback refuses symlink, shared permissions, wrong owner and unsafe credential leaf', async t => {
  for (const kind of ['symlink', 'permissions', 'owner', 'leaf']) {
    const f = fixture(t); let options = {};
    if (kind === 'symlink') fs.symlinkSync(os.tmpdir(), path.join(f.home, '.campaigns-os'));
    if (kind === 'permissions') { fs.mkdirSync(path.join(f.home, '.campaigns-os')); fs.chmodSync(path.join(f.home, '.campaigns-os'), 0o777); }
    if (kind === 'owner') options.uid = process.getuid() + 1;
    if (kind === 'leaf') { fs.mkdirSync(path.join(f.home, '.campaigns-os'), { mode: 0o755 }); fs.mkdirSync(path.join(f.home, '.campaigns-os/credentials'), { mode: 0o755 }); }
    await assert.rejects(f.provider(options).read(binding), /unsafe/);
  }
});
test('fallback rejects symlink credential and leaves its target intact', async t => {
  const f = fixture(t), provider = f.provider(); await provider.transaction(binding, s => s.write({ ...binding, dummy: true }));
  const dir = path.join(f.home, '.campaigns-os/credentials'), file = path.join(dir, fs.readdirSync(dir)[0]), target = path.join(f.home, 'target');
  fs.writeFileSync(target, 'untouched'); fs.unlinkSync(file); fs.symlinkSync(target, file);
  await assert.rejects(provider.read(binding), /unsafe/); assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
});
test('exclusive transaction rereads the winner and releases its lock on error', async t => {
  const f = fixture(t), provider = f.provider();
  await provider.transaction(binding, s => s.write({ ...binding, generation: 1 }));
  let release; const hold = new Promise(resolve => { release = resolve; });
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const first = provider.transaction(binding, async s => { entered(); await hold; s.write({ ...binding, generation: 2 }); });
  await ready;
  const second = provider.transaction(binding, s => { assert.equal(s.read().generation, 2); s.write({ ...binding, generation: 3 }); });
  release(); await Promise.all([first, second]); assert.equal((await provider.read(binding)).generation, 3);
  await assert.rejects(provider.transaction(binding, () => { throw new Error('dummy-private'); }), /unsafe/);
  assert.equal((await provider.read(binding)).generation, 3);
});
test('atomic replacement does not leave temporary files and rejects cross-store records', async t => {
  const f = fixture(t), provider = f.provider();
  await provider.transaction(binding, s => s.write({ ...binding, generation: 1 }));
  await assert.rejects(provider.transaction(binding, s => s.write({ ...binding, store: 'other.29next.store' })), /unsafe/);
  assert.equal((await provider.read(binding)).generation, 1);
  assert.equal(fs.readdirSync(path.join(f.home, '.campaigns-os/credentials')).length, 1);
});

test('home dotfiles markers and safe owner0755 parent do not block private credential storage', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.home, 'package.json'), '{}'); fs.mkdirSync(path.join(f.home, '.git'));
  fs.mkdirSync(path.join(f.home, '.campaigns-os'), { mode: 0o755 });
  const provider = f.provider({ cwd: f.home }); await provider.transaction(binding, s => s.write({ ...binding, generation: 1 }));
  assert.equal((await provider.read(binding)).generation, 1);
  assert.equal(fs.statSync(path.join(f.home, '.campaigns-os')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(f.home, '.campaigns-os/credentials')).mode & 0o777, 0o700);
});
test('unexpected lock cleanup failure exposes no raw filesystem error', async t => {
  const f = fixture(t), provider = f.provider();
  await assert.rejects(provider.transaction(binding, () => {
    const dir = path.join(f.home, '.campaigns-os/credentials');
    fs.rmdirSync(path.join(dir, fs.readdirSync(dir).find(name => name.endsWith('.lock'))));
  }), error => error.code === undefined && error.path === undefined && !error.message.includes(f.home));
});
