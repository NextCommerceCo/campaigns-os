import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {createHash} from 'node:crypto';
import { buildRunSession, writeRunSession } from './run-session.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { analyzeStorageJavaScript, scanSdkStorageCompatibility, readStorageManifest } from './sdk-storage-compatibility.mjs';
// Synthetic contract: deliberately not a second production SDK registry.
const manifest = { schemaVersion: 1, sdkVersion: '0.4.38', supportedSdkVersions: { min: '0.4.38', max: '0.4.38' }, provenance: { extractor: 'synthetic', registry: 'synthetic', inputSha256: 'a'.repeat(64) }, keys: [{ key: 'next-order{__scope}', pattern: 'next-order{}', areas: ['localStorage', 'sessionStorage'], scoped: true, migration: { since: '0.4.34', legacyKey: 'next-order', releaseEvidence: { commit: 'b'.repeat(40), tag: 'v0.4.34' } }, replacement: { kind: 'public-store', export: 'useOrderStore', guide: 'synthetic-guide' } }] };
const analyze = source => analyzeStorageJavaScript(source, { manifest, targetSdkVersion: '0.4.38' });
test('AST finds methods, property operations, lexical string and storage aliases', () => {
  const results = analyze(`const KEY='next-'+'order'; const storage=window['localStorage']; storage['getItem'](KEY); sessionStorage.setItem('next-order','x'); delete globalThis.localStorage['next-order']; localStorage['next-order']='x';`);
  assert.equal(results.length, 4);
  assert.deepEqual(results.map(f => f.operation), ['read', 'write', 'remove', 'write']);
  assert.ok(results.every(f => f.status === 'incompatible'));
  assert.equal(results[0].replacement.export, 'useOrderStore');
});
test('comments and public store access do not fabricate accesses', () => assert.deepEqual(analyze(`// localStorage.getItem('next-order')\nconst message="localStorage.getItem('next-order')";useOrderStore.getState();`), []));
test('shadowing, dynamic access, guessed prefixes and object escapes cannot give clean evidence', () => {
  for (const source of [`function f(localStorage){localStorage.getItem('next-order')}`, `localStorage.getItem(key)`, `localStorage.getItem('campaign:next-order')`, `localStorage.getItem('next-order__othercampaign')`, `let store=localStorage;store.getItem('next-order')`, `const {getItem}=localStorage;getItem('next-order')`, `const read=localStorage.getItem;read('next-order')`]) {
    const findings = analyze(source);
    assert.ok(findings.some(f => f.status === 'unknown'), source);
    assert.ok(!findings.some(f => f.status === 'incompatible'), source);
  }
});
test('nearby lexical constants do not override shadowed parameters', () => {
  const findings = analyze(`const key='next-order'; function f(key) { return localStorage.getItem(key); } localStorage.getItem(key);`);
  assert.deepEqual(findings.map(f => f.status), ['unknown', 'incompatible']);
});
test('invalid JS has explicit unknown with parser line', () => {
  const findings = analyze(`\nconst = ;`);
  assert.equal(findings[0].reason, 'parse-failure');
  assert.equal(findings[0].line, 2);
});
test('tracked scope, inline line offsets, shared dependencies, excludes and target bounds', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'storage-scan-'));
  try {
    const git = args => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
    git(['init']);
    for (const dir of ['a', 'b', 'shared', 'archive'])
      mkdirSync(join(cwd, dir));
    writeFileSync(join(cwd, 'a/index.html'), `<html>\n<body>\n<script>\nlocalStorage.getItem('next-order');\n</script><script src="../shared/store.js"></script>`);
    writeFileSync(join(cwd, 'shared/store.js'), `useOrderStore.getState();`);
    writeFileSync(join(cwd, 'b/index.html'), '<script type="application/json">bad{</script>');
    writeFileSync(join(cwd, 'archive/old.js'), `localStorage.getItem('next-order')`);
    writeFileSync(join(cwd, 'manifest.json'), JSON.stringify(manifest));
    git(['add', '.']);
    writeFileSync(join(cwd, 'shared/untracked.js'), `localStorage.getItem('next-order')`);
    const scan = options => scanSdkStorageCompatibility({ cwd, targetSdkVersion: '0.4.38', manifestPath: join(cwd, 'manifest.json'), scope: ['a', 'shared'], ...options });
    let report = scan();
    assert.equal(report.status, 'incompatible');
    assert.equal(report.findings[0].line, 4);
    assert.equal(report.files.length, 2);
    assert.equal(report.manifest.source.verification, 'unverified-local-file');
    report = scan({ scope: ['b'] });
    assert.equal(report.status, 'source-compatible');
    report = scan({ scope: ['a'] });
    assert.ok(report.findings.some(f => f.reason === 'shared-script-outside-scope'));
    report = scan({ scope: ['.'], exclude: ['a', 'archive'] });
    assert.equal(report.status, 'source-compatible');
    report = scan({ scope: ['b'], targetSdkVersion: '0.4.39' });
    assert.equal(report.status, 'unknown');
    assert.throws(() => scan({ scope: [] }), /explicit/);
    assert.throws(() => scan({ scope: ['../a'] }), /relative/);
    writeFileSync(join(cwd, 'b/index.html'), '<base href="/a/"><script src="index.js"></script>');
    report = scan({scope:['b']});
    assert.ok(report.findings.some(f=>f.reason==='html-base-script-resolution'));
    rmSync(join(cwd,'shared/store.js'));
    report = scan();
    assert.ok(report.findings.some(f=>f.reason==='source-unreadable'));
    const invalidBytes=Buffer.from([0xff]);
    writeFileSync(join(cwd,'shared/utf8.js'),invalidBytes);git(['add','shared/utf8.js']);
    report=scan({scope:['shared/utf8.js']});
    assert.equal(report.status,'unknown');
    assert.equal(report.findings[0].reason,'source-invalid-utf8');
    assert.equal(report.files[0].sha256,createHash('sha256').update(invalidBytes).digest('hex'));
  }
  finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
test('real CLI preserves active/stale sessions and ambient lifecycle journal byte-for-byte', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'storage-cli-'));
  try {
    execFileSync('git', ['-C', cwd, 'init'], { stdio: 'pipe' });
    mkdirSync(join(cwd, 'campaign'));
    writeFileSync(join(cwd, 'campaign/index.html'), '<script>useOrderStore.getState()</script>');
    writeFileSync(join(cwd, 'manifest.json'), JSON.stringify(manifest));
    execFileSync('git', ['-C', cwd, 'add', '.']);
    mkdirSync(join(cwd, '.campaign-runtime'));
    const journal = join(cwd, '.campaign-runtime/lifecycle.jsonl');
    writeFileSync(journal, 'previous proof\n');
    writeFileSync(join(cwd, '.campaign-runtime/assembly-report.json'), 'previous report');
    writeFileSync(join(cwd, '.campaign-runtime/agent-deviations.jsonl'), 'previous deviation\n');
    const snapshot = () => {
      const entries = [];
      function walk(path, prefix = '') { for (const name of readdirSync(path, { withFileTypes: true })) {
        if (name.name === '.git')
          continue;
        const next = join(path, name.name), key = prefix + name.name;
        if (name.isDirectory())
          walk(next, key + '/');
        else
          entries.push([key, readFileSync(next).toString('hex')]);
      } }
      walk(cwd);
      return entries.sort((a, b) => a[0].localeCompare(b[0]));
    };
    const cli = fileURLToPath(new URL('../bin/campaigns-os.mjs', import.meta.url));
    for (const now of [new Date(), new Date('2020-01-01')]) {
      const session = buildRunSession({ runId: 'synthetic-storage-readonly', lifecycleJournal: journal, now });
      session.last_recommendation = { stage: 'build', commands: ['build'], generated_at: now.toISOString() };
      writeRunSession(cwd, session);
      const before = snapshot();
      for (const [source, code] of [['useOrderStore.getState()', 0], ["sessionStorage.getItem('next-order')", 2], ['sessionStorage.getItem(key)', 2]]) {
        writeFileSync(join(cwd, 'campaign/source.js'), source);
        execFileSync('git', ['-C', cwd, 'add', 'campaign/source.js']);
        const unchanged = snapshot();
        for (const json of [true, false]) {
          const args = [cli, 'sdk', 'storage-check', '--target', cwd, '--target-sdk', '0.4.38', '--manifest', join(cwd, 'manifest.json'), '--scope', 'campaign', ...(json ? ['--json'] : [])];
          const child = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, CAMPAIGNS_OS_LIFECYCLE_LOG: journal, CAMPAIGNS_OS_TELEMETRY: 'off' } });
          assert.equal(child.status, code, child.stderr);
          assert.deepEqual(snapshot(), unchanged);
          if (json)
            assert.equal(JSON.parse(child.stdout).targetSdkVersion, '0.4.38');
          else
            assert.match(child.stdout, /Static tracked source compatibility/);
        }
      }
      // The scanner also remains read-only when dispatch rejects an invalid flag.
      const unchanged = snapshot();
      const child = spawnSync(process.execPath, [cli, 'sdk', 'storage-check', '--badflag'], { cwd, encoding: 'utf8', env: { ...process.env, CAMPAIGNS_OS_LIFECYCLE_LOG: journal, CAMPAIGNS_OS_TELEMETRY: 'off' } });
      assert.equal(child.status, 1);
      assert.deepEqual(snapshot(), unchanged);
      assert.ok(before.length > 0);
    }
  }
  finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
test('malformed manifest evidence cannot create a compatible result', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'storage-manifest-'));
  try {
    const path = join(cwd, 'manifest.json');
    const invalid = [
      value => value.schemaVersion = 2,
      value => value.provenance.inputSha256 = 'not-a-hash',
      value => value.keys[0].migration.releaseEvidence.commit = 'prefix' + 'b'.repeat(40) + 'suffix',
      value => value.keys[0].pattern = 'unrelated{}',
      value => value.keys[0].areas = [],
      value => value.keys[0].migration.legacyKey = 'unrelated',
      value => value.supportedSdkVersions.max = '0.4.39',
      value => value.keys[0].replacement = { kind: 'invented' },
    ];
    for (const mutate of invalid) {
      const value = structuredClone(manifest);
      mutate(value);
      writeFileSync(path, JSON.stringify(value));
      assert.throws(() => readStorageManifest(path));
    }
  }
  finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('loop and switch lexical declarations preserve outer SDK key bindings', () => {
  for (const inner of [
    "for (const key='harmless'; false;) {}",
    "for (const key of ['harmless']) {}",
    "for (const key in {harmless:1}) {}",
    "switch (0) { case 1: const key='harmless'; break; }",
    "class X { static { const key='harmless'; } }",
    "class X { static { var key='harmless'; } }",
  ]) {
    const findings = analyze(`const key='next-order'; ${inner} sessionStorage.getItem(key);`);
    assert.equal(findings.at(-1).status, 'incompatible', inner);
  }
});
test('plain property and label names are not storage references; bounded browser-global aliases resolve', () => {
  assert.deepEqual(analyze(`const object={sessionStorage:'metadata',localStorage(){}}; sessionStorage: for(;;){break sessionStorage;}`), []);
  for (const source of [
    "const global=window; global.sessionStorage.getItem('next-order')",
    "const {['sessionStorage']:storage}=window; storage.getItem('next-order')",
  ]) assert.ok(analyze(source).some(f=>f.status==='incompatible'), source);
});

test('named class expressions shadow outer constants within their own class', () => {
  const findings=analyze(`const key='next-order'; const X=class key { method() { sessionStorage.getItem(key); } }; sessionStorage.getItem(key);`);
  assert.deepEqual(findings.map(f=>f.status), ['unknown','incompatible']);
});
