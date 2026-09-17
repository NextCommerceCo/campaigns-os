import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSdkStorageCompatibility } from './sdk-storage-compatibility.mjs';

// Synthetic tracked campaign sources, never merchant code or real order data.
// A source-compatible result covers source storage access, not runtime identity.
function fixture(t, source, { html = false, extra = {} } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'storage-acceptance-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', cwd]);
  const files = {
    'campaign-a/index.html': '<html></html>',
    'shared/placeholder.js': '// synthetic shared source',
    [html ? 'campaign-a/receipt.html' : 'shared/tracking.js']: source,
    ...extra,
  };
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), contents);
  }
  writeFileSync(join(cwd, 'synthetic-manifest.json'), JSON.stringify({
    schemaVersion: 1, sdkVersion: '0.4.38',
    supportedSdkVersions: { min: '0.4.38', max: '0.4.38' },
    provenance: { extractor: 'synthetic-extractor', registry: 'synthetic-registry', inputSha256: 'a'.repeat(64) },
    keys: [{ key: 'next-order{__scope}', pattern: 'next-order{}', areas: ['localStorage', 'sessionStorage'], scoped: true,
      migration: { since: '0.4.34', legacyKey: 'next-order', releaseEvidence: { commit: 'b'.repeat(40), tag: 'v0.4.34' } },
      replacement: { kind: 'public-store', export: 'useOrderStore', guide: 'docs/guides/reference/order-store.md' } }],
  }));
  execFileSync('git', ['-C', cwd, 'add', '.']);
  execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'synthetic fixture']);
  return cwd;
}

// Deliberately synthetic producer manifest; it is not a release compatibility claim.
const options = cwd => ({ cwd, targetSdkVersion: '0.4.38', manifestPath: join(cwd, 'synthetic-manifest.json'), scope: ['campaign-a', 'shared'], exclude: ['shared/archive'] });

for (const [label, source] of [
  ['bare read', "sessionStorage.getItem('next-order');"],
  ['bare write', "sessionStorage.setItem('next-order', '{}');"],
  ['bare remove', "sessionStorage.removeItem('next-order');"],
  ['bracket method', "sessionStorage['getItem']('next-order');"],
  ['constant key', "const KEY = 'next-order'; sessionStorage.getItem(KEY);"],
]) {
  test(`synthetic acceptance rejects ${label}`, t => {
    const report = scanSdkStorageCompatibility(options(fixture(t, source)));
    assert.equal(report.status, 'incompatible');
    assert.ok(report.findings.some(f => f.key === 'next-order' && f.status === 'incompatible'));
  });
}

test('prefix-first cross-campaign lookup never receives a source-compatible verdict', t => {
  const source = `const key = Object.keys(sessionStorage).find(key => key.startsWith('next-order__')); sessionStorage.getItem(key);`;
  const report = scanSdkStorageCompatibility(options(fixture(t, source)));
  assert.ok(['incompatible', 'unknown'].includes(report.status));
  assert.ok(report.findings.length > 0);
});

test('supported public store access is source compatible without claiming runtime verification', t => {
  const source = `const state = window.NextCommerce?.useOrderStore?.getState(); console.log(state?.order);`;
  const report = scanSdkStorageCompatibility(options(fixture(t, source)));
  assert.equal(report.status, 'source-compatible');
});

test('a shadowed synthetic storage object is not browser storage', t => {
  const source = `function synthetic(sessionStorage) { return sessionStorage.getItem('next-order'); }`;
  const report = scanSdkStorageCompatibility(options(fixture(t, source)));
  assert.equal(report.findings.some(f => f.status === 'incompatible'), false);
});

for (const [label, source] of [
  ['dynamic key', 'sessionStorage.getItem(window.syntheticKey);'],
  ['literal scoped guess', "sessionStorage.getItem('next-order__anothercampaign');"],
  ['malformed JS', "sessionStorage.getItem('next-order'"],
]) {
  test(`unresolved ${label} is unknown rather than compatible`, t => {
    const report = scanSdkStorageCompatibility(options(fixture(t, source)));
    assert.equal(report.status, 'unknown');
    assert.ok(report.findings.some(f => f.status === 'unknown'));
  });
}

test('inline script finding uses the HTML source location and excluded sources stay excluded', t => {
  const cwd = fixture(t, `<html>\n<body>\n<script>\nsessionStorage.getItem('next-order');\n</script>\n</body></html>`, {
    html: true,
    extra: {
      'shared/archive/tracking.js': "sessionStorage.getItem('next-checkout-store');",
      'unrelated/tracking.js': "sessionStorage.getItem('next-cart-state');",
    },
  });
  const report = scanSdkStorageCompatibility(options(cwd));
  assert.equal(report.status, 'incompatible');
  assert.ok(report.findings.some(f => f.path === 'campaign-a/receipt.html' && f.line === 4));
  assert.equal(report.findings.some(f => /archive|unrelated/.test(f.path)), false);
});

for (const [label, source] of [
  ['for initializer', "const KEY='next-order';for(const KEY='harmless';false;){}sessionStorage.getItem(KEY);"],
  ['for-in binding', "const KEY='next-order';for(const KEY in {}){}sessionStorage.getItem(KEY);"],
  ['for-of binding', "const KEY='next-order';for(const KEY of []){}sessionStorage.getItem(KEY);"],
  ['switch declaration', "const KEY='next-order';switch(0){case 1:const KEY='harmless';}sessionStorage.getItem(KEY);"],
  ['class static declaration', "const KEY='next-order';class Synthetic {static {const KEY='harmless';}}sessionStorage.getItem(KEY);"],
  ['class static var declaration', "const KEY='next-order';class Synthetic {static {var KEY='harmless';}}sessionStorage.getItem(KEY);"],
]) {
  test(`lexical ${label} preserves the outer legacy key finding`, t => {
    const report = scanSdkStorageCompatibility(options(fixture(t, source)));
    assert.equal(report.status, 'incompatible');
    assert.ok(report.findings.some(f => f.key === 'next-order' && f.status === 'incompatible'));
  });
}

test('a named class expression shadows the outer string inside its methods', t => {
  const source = "const KEY='next-order';const Synthetic=class KEY {method(){sessionStorage.getItem(KEY);}};";
  const report = scanSdkStorageCompatibility(options(fixture(t, source)));
  assert.equal(report.status, 'unknown');
  assert.equal(report.findings.some(f => f.status === 'incompatible'), false);
});

test('ordinary object keys and statement labels do not fabricate storage references', t => {
  const source = "const meta={sessionStorage:'metadata',localStorage:'metadata'};sessionStorage:for(;;){break sessionStorage;}";
  const report = scanSdkStorageCompatibility(options(fixture(t, source)));
  assert.equal(report.status, 'source-compatible');
  assert.deepEqual(report.findings, []);
});

for (const [label, source] of [
  ['constant browser global alias', "const browser=window;browser.sessionStorage.getItem('next-order');"],
  ['computed storage destructuring', "const {['sessionStorage']:storage}=window;storage.getItem('next-order');"],
]) {
  test(`bounded ${label} never silently receives compatible evidence`, t => {
    const report = scanSdkStorageCompatibility(options(fixture(t, source)));
    assert.ok(['unknown', 'incompatible'].includes(report.status));
    assert.ok(report.findings.length > 0);
  });
}

test('a local HTML base cannot conceal an omitted script dependency', t => {
  const cwd = fixture(t, '<base href="/campaign-b/"><script src="tracking.js"></script>', {
    html: true,
    extra: {
      'campaign-a/tracking.js': '// synthetic benign decoy',
      'campaign-b/tracking.js': "sessionStorage.getItem('next-order');",
    },
  });
  const report = scanSdkStorageCompatibility(options(cwd));
  assert.equal(report.status, 'unknown');
  assert.ok(report.findings.some(f => f.status === 'unknown'));
});
