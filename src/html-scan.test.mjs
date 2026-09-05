import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { htmlScanDigest, readHtmlScanText, withHtmlScanSnapshot } from './html-scan.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'html-scan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'page.html');
}

test('a snapshot shares bytes for text and digest, and expires between calls', t => {
  const path = fixture(t);
  writeFileSync(path, 'before');
  withHtmlScanSnapshot(() => {
    assert.equal(readHtmlScanText(path), 'before');
    writeFileSync(path, 'after');
    assert.equal(htmlScanDigest(path), createHash('sha256').update('before').digest('hex'));
    assert.equal(readHtmlScanText(path), 'before');
  });
  withHtmlScanSnapshot(() => assert.equal(readHtmlScanText(path), 'after'));
  assert.equal(readHtmlScanText(path), 'after');
  writeFileSync(path, 'outside');
  assert.equal(readHtmlScanText(path), 'outside');
});

test('nested doctor snapshots are isolated; reusable scan scopes share the outer snapshot', t => {
  const path = fixture(t);
  writeFileSync(path, 'outer');
  withHtmlScanSnapshot(() => {
    assert.equal(readHtmlScanText(path), 'outer');
    writeFileSync(path, 'inner');
    withHtmlScanSnapshot(() => assert.equal(readHtmlScanText(path), 'inner'));
    withHtmlScanSnapshot(() => assert.equal(readHtmlScanText(path), 'outer'), { reuse: true });
  });
});

test('failed reads are not cached and exceptions release the snapshot', t => {
  const path = fixture(t);
  assert.throws(() => withHtmlScanSnapshot(() => {
    assert.throws(() => readHtmlScanText(path), { code: 'ENOENT' });
    writeFileSync(path, 'created');
    assert.equal(readHtmlScanText(path), 'created');
    throw new Error('abort');
  }), /abort/);
  writeFileSync(path, 'next');
  assert.equal(readHtmlScanText(path), 'next');
});

test('malformed UTF-8 does not alter the raw-byte digest', t => {
  const path = fixture(t);
  const bytes = Buffer.from([0xff, 0x61, 0xc0]);
  writeFileSync(path, bytes);
  withHtmlScanSnapshot(() => {
    assert.equal(readHtmlScanText(path), bytes.toString('utf8'));
    assert.equal(htmlScanDigest(path), createHash('sha256').update(bytes).digest('hex'));
  });
});

test('oversize files are read normally without retaining their contents', t => {
  const path = fixture(t);
  writeFileSync(path, Buffer.alloc(6 * 1024 * 1024, 97));
  withHtmlScanSnapshot(() => {
    assert.equal(readHtmlScanText(path).length, 6 * 1024 * 1024);
    writeFileSync(path, 'updated');
    assert.equal(readHtmlScanText(path), 'updated');
  });
});

test('the public copy scanner refreshes files between repeated calls', async t => {
  const { validateMarketSensitiveCopy } = await import('./cli.mjs');
  const path = fixture(t);
  const { dirname } = await import('node:path');
  const spec = { campaign: { currency: 'GBP' } };
  const derived = { source_root: dirname(path) };
  writeFileSync(path, '<p>$29.99</p>');
  const first = [];
  validateMarketSensitiveCopy(spec, first, [], derived);
  assert.ok(first.some(issue => issue.code === 'copy.hardcoded_currency_symbol'));
  writeFileSync(path, '<p>£29.99</p>');
  const second = [];
  validateMarketSensitiveCopy(spec, second, [], derived);
  assert.deepEqual(second, []);
});


test('async continuations cannot retain or reuse an expired snapshot', async t => {
  const path = fixture(t);
  writeFileSync(path, 'before');
  const pending = withHtmlScanSnapshot(async () => {
    assert.equal(readHtmlScanText(path), 'before');
    await Promise.resolve();
    assert.equal(readHtmlScanText(path), 'after');
    withHtmlScanSnapshot(() => {
      assert.equal(readHtmlScanText(path), 'after');
      writeFileSync(path, 'next');
      assert.equal(readHtmlScanText(path), 'after');
    }, { reuse: true });
    assert.equal(readHtmlScanText(path), 'next');
  });
  writeFileSync(path, 'after');
  await pending;
});

test('queued reads after a throwing invocation observe fresh bytes', async t => {
  const path = fixture(t);
  writeFileSync(path, 'before');
  let pending;
  assert.throws(() => withHtmlScanSnapshot(() => {
    assert.equal(readHtmlScanText(path), 'before');
    pending = Promise.resolve().then(() => readHtmlScanText(path));
    throw new Error('abort');
  }), /abort/);
  writeFileSync(path, 'after');
  assert.equal(await pending, 'after');
});
