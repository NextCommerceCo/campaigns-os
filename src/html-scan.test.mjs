import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { MAX_ELEMENT_DEPTH, TooDeep, htmlScanDigest, htmlScanDocuments, htmlScanMemo, htmlScanScriptPrograms, parseBounded, readHtmlScanText, withHtmlScanSnapshot } from './html-scan.mjs';

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

test('a snapshot shares one acorn program per held script and source type, failures included', t => {
  const path = fixture(t);
  // An HTML-like comment parses only in a classic script.
  writeFileSync(path, '<!-- legacy\nvar total = 1;');
  withHtmlScanSnapshot(() => {
    const text = readHtmlScanText(path);
    const programs = htmlScanScriptPrograms([{ path, module: false }, { path, module: true }]);
    const classic = programs(path, false, text);
    assert.equal(classic.sourceType, 'script');
    assert.equal(htmlScanScriptPrograms([{ path, module: false }])(path, false, text), classic);
    let failure;
    assert.throws(() => programs(path, true, text), (error) => (failure = error) instanceof SyntaxError);
    assert.throws(() => programs(path, true, text), (error) => error === failure);
    // A shared program is handed back only for the held text.
    assert.equal(programs(path, false, 'var edited;').body[0].declarations[0].id.name, 'edited');
  });
  const outside = htmlScanScriptPrograms([{ path, module: false }]);
  assert.notEqual(outside(path, false, 'var a;'), outside(path, false, 'var a;'));
});

test('a script set past the parse budget, or with a script the snapshot does not hold, is parsed per use', t => {
  const small = fixture(t);
  writeFileSync(small, 'var small;');
  const scripts = [{ path: small, module: false }];
  // 3 x 1 MiB of scripts: 96 MiB of estimated programs, past the 64 MiB parse budget.
  for (let i = 0; i < 3; i += 1) {
    const path = join(dirname(small), `script-${i}.js`);
    writeFileSync(path, `var x${i};${' '.repeat(1024 * 1024)}`);
    scripts.push({ path, module: false });
  }
  const unheld = join(dirname(small), 'unheld.js');
  writeFileSync(unheld, 'var unheld;');
  withHtmlScanSnapshot(() => {
    for (const { path } of scripts) readHtmlScanText(path);
    const overBudget = htmlScanScriptPrograms(scripts);
    assert.notEqual(overBudget(small, false, 'var small;'), overBudget(small, false, 'var small;'));
    const partial = htmlScanScriptPrograms([{ path: small, module: false }, { path: unheld, module: false }]);
    assert.notEqual(partial(small, false, 'var small;'), partial(small, false, 'var small;'));
    const alone = htmlScanScriptPrograms([{ path: small, module: false }]);
    assert.equal(alone(small, false, 'var small;'), alone(small, false, 'var small;'));
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

test('a snapshot opened inside an active one runs uncached at any depth', t => {
  const path = fixture(t);
  writeFileSync(path, 'before');
  const nest = (depth) => withHtmlScanSnapshot(() => (depth ? nest(depth - 1) : (() => {
    readHtmlScanText(path);
    writeFileSync(path, 'after');
    return readHtmlScanText(path);
  })()));
  withHtmlScanSnapshot(() => {
    for (const depth of [0, 1, 2]) {
      writeFileSync(path, 'before');
      assert.equal(nest(depth), 'after');
    }
  });
  writeFileSync(path, 'before');
  assert.equal(nest(0), 'before');
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

// The first element named `tag` in tree order, walked without recursion so a
// page nested past the depth bound does not exhaust the stack.
function findElement(root, tag) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node.tagName === tag) return node;
    stack.push(...[...(node.childNodes || [])].reverse());
  }
  return null;
}

test('noloc and located requests share the bounded tree, and a page past its depth bound gets their own unbounded parse', t => {
  const path = fixture(t);
  writeFileSync(path, '<p>a</p>');
  const deep = join(dirname(path), 'deep.html');
  writeFileSync(deep, `${'<div>'.repeat(MAX_ELEMENT_DEPTH + 1)}<script src="deep.js"></script>`);
  withHtmlScanSnapshot(() => {
    const text = readHtmlScanText(path);
    const deepText = readHtmlScanText(deep);
    const bounded = htmlScanDocuments([path, deep], 'bounded');
    const tree = bounded(path, text);
    assert.equal(htmlScanDocuments([path, deep], 'bounded')(path, text), tree);
    assert.equal(htmlScanDocuments([path, deep])(path, text), tree);
    assert.equal(htmlScanDocuments([path, deep], 'located')(path, text), tree);
    assert.ok(findElement(tree, 'p').sourceCodeLocation);
    // A bounded consumer gets the shared failure; the others parse the page their own way, per use.
    let first;
    assert.throws(() => bounded(deep, deepText), (error) => (first = error) instanceof TooDeep);
    assert.throws(() => htmlScanDocuments([path, deep], 'bounded')(deep, deepText), (error) => error === first);
    const noloc = htmlScanDocuments([path, deep]);
    const own = noloc(deep, deepText);
    assert.notEqual(noloc(deep, deepText), own);
    assert.equal(findElement(own, 'script').sourceCodeLocation, undefined);
    assert.ok(findElement(htmlScanDocuments([path, deep], 'located')(deep, deepText), 'script').sourceCodeLocation);
  });
  const outside = htmlScanDocuments([deep], 'bounded');
  assert.throws(() => outside(deep, '<div>'.repeat(MAX_ELEMENT_DEPTH + 1)), TooDeep);
  const located = htmlScanDocuments([path], 'located');
  assert.notEqual(located(path, '<p>a</p>'), located(path, '<p>a</p>'));
  assert.ok(findElement(located(path, '<p>a</p>'), 'p').sourceCodeLocation);
});

test('a page set too big to share as bounded trees shares noloc trees of its own, and parses bounded and located sets per use', t => {
  const small = fixture(t);
  writeFileSync(small, '<p>small</p>');
  const big = join(dirname(small), 'big.html');
  // 1.5 MiB: bounded trees (84 MiB estimated) exceed the parse budget; noloc trees (45 MiB) fit.
  writeFileSync(big, Buffer.alloc(1.5 * 1024 * 1024, 97));
  withHtmlScanSnapshot(() => {
    for (const path of [small, big]) readHtmlScanText(path);
    for (const profile of ['bounded', 'located']) {
      const documentOf = htmlScanDocuments([small, big], profile);
      assert.notEqual(documentOf(small, '<p>small</p>'), documentOf(small, '<p>small</p>'));
    }
    const noloc = htmlScanDocuments([small, big]);
    assert.equal(noloc(small, '<p>small</p>'), noloc(small, '<p>small</p>'));
    assert.equal(findElement(noloc(small, '<p>small</p>'), 'p').sourceCodeLocation, undefined);
  });
});

test('the cart placeholder and smoke checks read one shared bounded tree per built page', async t => {
  const { collectCartPlaceholderPages } = await import('./doctor/checks.mjs');
  const { evaluateCartPlaceholders } = await import('./cart-placeholders.mjs');
  const { evaluateSmokeQc } = await import('./built-smoke-qc.mjs');
  const repo = dirname(fixture(t));
  const siteRoot = join(repo, '_site', 'demo');
  mkdirSync(siteRoot, { recursive: true });
  writeFileSync(join(siteRoot, 'index.html'), '<!doctype html><title>a</title><p>{subtotal}</p>');
  withHtmlScanSnapshot(() => {
    const [cart] = collectCartPlaceholderPages(repo, 'demo');
    const [smoke] = collectCartPlaceholderPages(repo, 'demo');
    assert.equal(cart.content, smoke.content);
    assert.equal(cart.document(), smoke.document());
    // Both evaluators take the tree they are handed rather than parsing again.
    let calls = 0;
    const counted = (page) => ({ ...page, document: () => { calls += 1; return page.document(); } });
    evaluateCartPlaceholders({ pages: [counted(cart)] });
    evaluateSmokeQc({ pages: [counted(smoke)], siteRoot, targetDir: repo });
    assert.equal(calls, 2);
  });
  const [a] = collectCartPlaceholderPages(repo, 'demo');
  const [b] = collectCartPlaceholderPages(repo, 'demo');
  assert.notEqual(a.document(), b.document());
});

test('the live-ref, commerce-ref and script syntax checks read the tree the cart and smoke checks share', async t => {
  const { collectCartPlaceholderPages, liveRefBuiltPages } = await import('./doctor/checks.mjs');
  const { builtScriptReferences } = await import('./built-script-syntax.mjs');
  const { extractRenderedRefs } = await import('./live-campaign-refs.mjs');
  const repo = dirname(fixture(t));
  const siteRoot = join(repo, '_site', 'demo');
  mkdirSync(siteRoot, { recursive: true });
  const index = join(siteRoot, 'index.html');
  writeFileSync(index, '<!doctype html><script src="a.js"></script><p data-next-package-id="7">a</p>');
  // Past the depth bound: the syntax gate and the live-ref check still see what sits inside and after the nest.
  const deep = join(siteRoot, 'deep.html');
  const nest = '<div>'.repeat(MAX_ELEMENT_DEPTH + 8);
  writeFileSync(deep, `${nest}<script src="inner.js"></script><i data-next-package-id="8"></i>${'</div>'.repeat(MAX_ELEMENT_DEPTH + 8)}<script src="after.js"></script>`);
  const scope = { site_root: join(repo, '_site'), campaign_dir: siteRoot, pages: [{ page_id: 'index', built_path: index }, { page_id: 'deep', built_path: deep }] };
  withHtmlScanSnapshot(() => {
    const live = liveRefBuiltPages({}, { campaign: { public_route_slug: 'demo' } }, { target_repo: repo });
    assert.deepEqual(live.map(({ page_id }) => page_id), ['deep.html', 'index.html']);
    const [cart] = collectCartPlaceholderPages(repo, 'demo').filter(({ file }) => file.endsWith('index.html'));
    assert.equal(live[1].document(), cart.document());
    assert.deepEqual(live.map(({ content, document }) => [...extractRenderedRefs(content, document).package_refs]), [['8'], ['7']]);
    assert.deepEqual(builtScriptReferences(scope).refs.map(({ page_id, src }) => `${page_id}:${src}`), ['index:a.js', 'deep:inner.js', 'deep:after.js']);
  });
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

test('a memo that throws is computed again', () => {
  withHtmlScanSnapshot(() => {
    let attempts = 0;
    assert.throws(() => htmlScanMemo('x', () => { attempts += 1; throw new Error('boom'); }), /boom/);
    assert.equal(htmlScanMemo('x', () => ++attempts), 2);
    assert.equal(htmlScanMemo('x', () => ++attempts), 2);
  });
});

test('drift classification reads the tree the cart and smoke checks share', async t => {
  const { collectCartPlaceholderPages } = await import('./doctor/checks.mjs');
  const { campaignConfigFingerprint, classifyDrift, pageCommerceFacts } = await import('./change-scope.mjs');
  const repo = dirname(fixture(t));
  const outputRoot = join(repo, '_site', 'demo');
  mkdirSync(outputRoot, { recursive: true });
  mkdirSync(join(repo, '_data'), { recursive: true });
  writeFileSync(join(repo, '_data', 'campaigns.json'), JSON.stringify({ demo: { sdk_version: '0.4.40' } }));
  const html = '<!doctype html><meta name="next-page-type" content="upsell"><b data-next-package-id="12">a</b>';
  writeFileSync(join(outputRoot, 'index.html'), html);
  // Past the depth bound: the checkout markup after the nest still makes it a checkout page.
  const nest = '<div>'.repeat(MAX_ELEMENT_DEPTH + 8);
  writeFileSync(join(outputRoot, 'deep.html'), `${nest}${'</div>'.repeat(MAX_ELEMENT_DEPTH + 8)}<form data-next-checkout="form"></form>`);
  const pages = [{ page_id: 'index', built_path: 'index.html' }, { page_id: 'deep', built_path: 'deep.html' }];
  const classify = () => classifyDrift({
    changes: { status: 'known', changed_pages: pages, unmapped_files: [], extra: [], missing: [] },
    baseline: { commerce_signature: { algorithm: 'commerce-signature/v1', campaign_config: campaignConfigFingerprint(repo, 'demo'),
      pages: { 'index.html': pageCommerceFacts(html).signature, 'deep.html': 'sha256:old' } } },
    outputRoot, targetRepo: repo, publicRouteSlug: 'demo',
    pagePaths: pages.map(({ built_path }) => join(outputRoot, built_path)),
  });
  assert.deepEqual(classify().reasons, [{ code: 'checkout_page', path: 'deep.html' }]);
  // The baseline is hashed from a plain parse; the shared bounded tree gives the same signature.
  const rich = `<!doctype html><html><head><meta name="next-page-type" content="upsell"><meta name="next-upsell-accept-url" content="../r/">
<script src="loader.js"></script><script>window.nextConfig = { a: 1 };</script></head><body><template><a href="../x/" data-next-offer-id="4">t</a></template>
<form action="/pay" data-next-checkout="form"><button onclick="next.go()">Pay</button></form><svg><a href="#s"></a></svg><table><td data-next-package-id="9">x</table></body></html>`;
  assert.deepEqual(pageCommerceFacts(rich, parseBounded(rich)), pageCommerceFacts(rich));
  withHtmlScanSnapshot(() => {
    const [index] = collectCartPlaceholderPages(repo, 'demo').filter(({ file }) => file.endsWith('index.html'));
    assert.deepEqual(classify().reasons, [{ code: 'checkout_page', path: 'deep.html' }]);
    // Consumers never change a shared tree; this test does, to see which tree drift classification reads.
    findElement(index.document(), 'b').attrs[0].value = '13';
    assert.deepEqual(classify().reasons, [{ code: 'commerce_markup_changed', path: 'index.html' }, { code: 'checkout_page', path: 'deep.html' }]);
  });
});
