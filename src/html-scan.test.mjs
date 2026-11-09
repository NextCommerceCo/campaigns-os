import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { htmlScanDigest, htmlScanDocuments, htmlScanMemo, readHtmlScanText, withHtmlScanSnapshot } from './html-scan.mjs';

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
  const { validateMarketSensitiveCopy } = await import('./doctor/checks.mjs');
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

test('a snapshot shares one tree per held file and profile across consumers, and expires it with its bytes', t => {
  const path = fixture(t);
  writeFileSync(path, '<meta name="next-page-type" content="upsell">');
  let first;
  withHtmlScanSnapshot(() => {
    const text = readHtmlScanText(path);
    first = htmlScanDocuments([path])(path, text);
    writeFileSync(path, '<p>changed</p>');
    assert.equal(htmlScanDocuments([path])(path, text), first);
    assert.equal(htmlScanDocuments([path], 'noloc')(path, text), first);
    assert.throws(() => htmlScanDocuments([path], 'loc'), /Unknown HTML parse profile: loc/);
  });
  withHtmlScanSnapshot(() => assert.notEqual(htmlScanDocuments([path])(path, readHtmlScanText(path)), first));
  const outside = htmlScanDocuments([path]);
  assert.notEqual(outside(path, '<p>a</p>'), outside(path, '<p>a</p>'));
});

test('a page set past the parse budget, or with a file the snapshot does not hold, is parsed per use from the text given', t => {
  const small = fixture(t);
  const pages = [small];
  writeFileSync(small, '<p>small</p>');
  // 4 x 1 MiB of bytes fits the byte budget; its estimated trees (120 MiB) do not fit the parse budget.
  for (let i = 0; i < 4; i += 1) {
    const page = join(dirname(small), `page-${i}.html`);
    writeFileSync(page, Buffer.alloc(1024 * 1024, 97));
    pages.push(page);
  }
  const big = join(dirname(small), 'big.html');
  writeFileSync(big, Buffer.alloc(6 * 1024 * 1024, 97));
  withHtmlScanSnapshot(() => {
    for (const page of pages) readHtmlScanText(page);
    const overBudget = htmlScanDocuments(pages);
    assert.notEqual(overBudget(small, '<p>small</p>'), overBudget(small, '<p>small</p>'));
    readHtmlScanText(big);
    const unheld = htmlScanDocuments([small, big]);
    assert.notEqual(unheld(small, '<p>small</p>'), unheld(small, '<p>small</p>'));
    assert.equal(unheld(small, '<p>given</p>').childNodes[0].childNodes[1].childNodes[0].childNodes[0].value, 'given');
    const alone = htmlScanDocuments([small]);
    assert.equal(alone(small, '<p>small</p>'), alone(small, '<p>small</p>'));
    // A shared tree is handed back only for the held text; other text is parsed as given.
    assert.notEqual(alone(small, '<p>edited</p>'), alone(small, '<p>small</p>'));
    assert.equal(alone(small, '<p>edited</p>').childNodes[0].childNodes[1].childNodes[0].childNodes[0].value, 'edited');
  });
});

test('a memo computes once per snapshot, read-only, and recomputes outside one', () => {
  let calls = 0;
  const compute = () => ({ calls: ++calls, pages: [{ id: 'a' }] });
  withHtmlScanSnapshot(() => {
    const value = htmlScanMemo('k', compute);
    assert.equal(htmlScanMemo('k', compute), value);
    assert.ok(Object.isFrozen(value) && Object.isFrozen(value.pages) && Object.isFrozen(value.pages[0]));
  });
  withHtmlScanSnapshot(() => assert.equal(htmlScanMemo('k', compute).calls, 2));
  assert.equal(htmlScanMemo('k', compute).calls, 3);
  assert.equal(htmlScanMemo('k', compute).calls, 4);
});

test('nested snapshots share one retention budget, and nesting past the depth limit runs uncached', t => {
  const big = fixture(t);
  const small = join(dirname(big), 'small.html');
  writeFileSync(big, Buffer.alloc(5 * 1024 * 1024, 97));
  writeFileSync(small, Buffer.alloc(1024 * 1024, 98));
  withHtmlScanSnapshot(() => {
    readHtmlScanText(big);
    withHtmlScanSnapshot(() => {
      // 15 MiB of the 16 MiB budget is held by the outer snapshot.
      assert.equal(readHtmlScanText(small)[0], 'b');
      writeFileSync(small, 'fresh');
      assert.equal(readHtmlScanText(small), 'fresh');
    });
  });
  writeFileSync(small, 'depth');
  const nest = (depth) => withHtmlScanSnapshot(() => (depth ? nest(depth - 1) : (() => {
    readHtmlScanText(small);
    writeFileSync(small, 'deeper');
    return readHtmlScanText(small);
  })()));
  // The outermost snapshot plus four nested levels are cached; a fifth nested level is not.
  assert.equal(nest(4), 'depth');
  writeFileSync(small, 'depth');
  assert.equal(nest(5), 'deeper');
});

test('the upsell selector-scope and SDK markup gates read one shared tree per built page', async t => {
  const { sharedBuiltPages } = await import('./doctor/checks.mjs');
  const { evaluateSdkMarkup } = await import('./sdk-markup.mjs');
  const { builtPageIsPostPurchase } = await import('./upsell-selector-scope.mjs');
  const built_path = fixture(t);
  writeFileSync(built_path, '<meta name="next-page-type" content="product"><p>a</p>');
  const scope = { pages: [{ page_id: 'index', route: '', page_type: 'landing', built_path }] };
  withHtmlScanSnapshot(() => {
    const [upsell] = sharedBuiltPages(scope, dirname(built_path));
    const [sdk] = sharedBuiltPages(scope, dirname(built_path));
    assert.equal(upsell.document(), sdk.document());
    // Both evaluators take the tree they are handed rather than parsing again.
    let calls = 0;
    const counted = (page) => ({ ...page, document: () => { calls += 1; return page.document(); } });
    builtPageIsPostPurchase(counted(upsell));
    evaluateSdkMarkup({ subject: {}, pages: [counted(sdk)] });
    assert.equal(calls, 2);
  });
  const [a] = sharedBuiltPages(scope, dirname(built_path));
  const [b] = sharedBuiltPages(scope, dirname(built_path));
  assert.notEqual(a.document(), b.document());
});

test('a symlink and its target are one held entry', t => {
  const real = fixture(t);
  const alias = join(dirname(real), 'alias.html');
  writeFileSync(real, 'before');
  symlinkSync(real, alias);
  withHtmlScanSnapshot(() => {
    assert.equal(readHtmlScanText(real), 'before');
    writeFileSync(real, 'after');
    assert.equal(readHtmlScanText(alias), 'before');
  });
});

test('a memo that throws is computed again, and memos past the cap are computed per use', () => {
  withHtmlScanSnapshot(() => {
    let attempts = 0;
    assert.throws(() => htmlScanMemo('x', () => { attempts += 1; throw new Error('boom'); }), /boom/);
    assert.equal(htmlScanMemo('x', () => ++attempts), 2);
    for (let i = 0; i < 255; i += 1) htmlScanMemo(`k${i}`, () => i);
    let over = 0;
    htmlScanMemo('over', () => ++over);
    htmlScanMemo('over', () => ++over);
    assert.equal(over, 2);
  });
});

test('a nested snapshot gives its retention back to the parent on return', t => {
  const big = fixture(t);
  const small = join(dirname(big), 'small.html');
  writeFileSync(big, Buffer.alloc(5 * 1024 * 1024, 97));
  writeFileSync(small, Buffer.alloc(1024 * 1024, 98));
  withHtmlScanSnapshot(() => {
    withHtmlScanSnapshot(() => readHtmlScanText(big));
    // 15 MiB came back when the inner snapshot returned, so 3 MiB more fits.
    assert.equal(readHtmlScanText(small)[0], 'b');
    writeFileSync(small, 'fresh');
    assert.equal(readHtmlScanText(small)[0], 'b');
  });
});
