import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const cli = resolve(import.meta.dirname, '../bin/campaigns-os.mjs');
test('lightweight CLI commands do not load QA, while QA dispatch still does', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-loading-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const loader = join(dir, 'reject-qa.mjs');
  writeFileSync(loader, `export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/qa-node.mjs')) throw new Error('QA_MODULE_LOADED');
    return nextResolve(specifier, context);
  }`);
  const run = args => spawnSync(process.execPath, ['--loader', pathToFileURL(loader).href, cli, ...args], {
    cwd: dir, encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: dir, CAMPAIGNS_OS_TELEMETRY: 'off' },
  });
  const help = run(['help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /campaigns-os/);
  const doctor = run(['doctor', '--packet', join(dir, 'missing.json')]);
  assert.notEqual(doctor.status, 0);
  assert.match(doctor.stderr, /file not found/);
  assert.doesNotMatch(doctor.stderr, /QA_MODULE_LOADED/);
  const journal = join(dir, 'lifecycle.jsonl');
  const qa = run(['qa', '--help', '--lifecycle-journal', journal]);
  assert.notEqual(qa.status, 0);
  assert.match(qa.stderr, /QA_MODULE_LOADED/);
  const lifecycle = JSON.parse(readFileSync(journal, 'utf8').trim());
  assert.equal(lifecycle.command, 'qa');
  assert.equal(lifecycle.exit_status, 1);
  const ordinaryQa = spawnSync(process.execPath, [cli, 'qa', '--help'], {
    cwd: dir, encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: dir, CAMPAIGNS_OS_TELEMETRY: 'off' },
  });
  assert.equal(ordinaryQa.status, 0, ordinaryQa.stderr);
  assert.match(ordinaryQa.stdout, /campaigns-os qa/);
});
