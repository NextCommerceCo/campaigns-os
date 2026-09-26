import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeBinding, bindingAssertion, scriptParseAssertion, expectedBinding, createBindingScriptLoader, BINDING_LIMITS } from './qa-binding-evidence.mjs';
import { __qaNodeTestHooks } from './qa-node.mjs';
const key = 'binding-canary-7V4m9Q2z8P5';
const page = { page_id: 'checkout', page_type: 'checkout', url: 'https://fixture.example.test/checkout' };
async function observe(html, options = {}) {
  return observeBinding({ source: { ok: true, html }, page, expected: { value: key }, scriptLoader: async () => ({ ok: false }), ...options });
}
const inline = value => `<script>window.nextConfig = {apiKey: ${JSON.stringify(value)}};</script>`;
test('meta, literal inline and external declarations compare without credentials or identity guesses', async () => {
  for (const html of [`<meta content="${key}" name="next-api-key">`, inline(key), '<script src="/config.js"></script>']) {
    const evidence = await observe(html, { scriptLoader: async () => ({ ok: true, html: `window.nextConfig = {apiKey:'${key}', googleMaps:{apiKey:'maps'}};` }) });
    assert.equal(evidence.outcome, 'match');
    assert.equal(evidence.identity, 'not_verified');
    assert.equal(JSON.stringify(bindingAssertion(page, evidence)).includes(key), false);
    assert.equal(JSON.stringify(evidence).includes(key.slice(0, 8)), false);
  }
  assert.equal((await observe(inline('different'))).outcome, 'mismatch');
});
test('ambiguity stays unknown: conflicts, dynamic code, unrelated credentials, missing input and scripts', async () => {
  for (const [html, reason] of [
    [inline(key) + '<meta name="next-api-key" content="other">', 'conflicting_declarations'],
    ['<script>window.nextConfig = {apiKey: getKey()}</script>', 'dynamic_unresolved'],
    ['<script>if (false) window.nextConfig = {apiKey:"x"}</script>', 'dynamic_unresolved'],
    ['<script>window.nextConfig = {...config, apiKey:"x"}</script>', 'dynamic_unresolved'],
    ['<script>window.nextConfig = {googleMaps: {apiKey:"x"}}</script>', 'dynamic_unresolved'],
    ['<script src="/missing.js"></script>', 'script_unavailable_or_limit'],
    ['', 'no_source'],
    ['<!-- <meta name="next-api-key" content="x"> -->', 'no_source'],
    ['<template><meta name="next-api-key" content="x"></template>', 'no_source'],
  ]) {
    const result = await observe(html);
    assert.equal(result.outcome, 'unknown', html);
    assert.equal(result.reason, reason, html);
  }
  assert.equal((await observe(inline(key), { expected: { value: null } })).reason, 'expected_unavailable');
  assert.equal((await observe('', { source: { ok: false, error: key } })).reason, 'page_unavailable');
});
test('shared credential cannot establish which App ID; expected source conflicts are unknown', async () => {
  for (const id of [11, 22]) {
    const expected = expectedBinding({ spec: { campaign: { campaigns_api_key: key, campaign_app_ref_id: id } } });
    const result = await observe(inline(key), { expected });
    assert.equal(result.identity, 'not_verified');
    assert.equal('resource_id' in result, false);
  }
  const expected = expectedBinding({ packet: { campaign: { campaigns_api_key: key } }, spec: { campaign: { campaigns_api_key: 'other' } } });
  assert.equal((await observe(inline(key), { expected })).reason, 'conflicting_expected');
});
test('config loader enforces scope, redirect refusal, deduplication, byte and count limits without forwarding credentials', async () => {
  let calls = 0;
  const load = createBindingScriptLoader({ fetchImpl: async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Cookie, undefined);
    if (url.includes('redirect')) return new Response(null, { status: 302, headers: { location: 'https://other.test/' } });
    if (url.includes('large')) return new Response('x'.repeat(BINDING_LIMITS.script_bytes + 1));
    if (url.includes('error')) throw new Error(key + url);
    return new Response('window.nextConfig = {apiKey:"x"}');
  } });
  for (const src of ['https://other.test/config.js', 'https://user:password@fixture.example.test/x', 'file:///tmp/config.js', '/config.js#fragment', 'https://fixture.example.test/config.js#fragment']) assert.equal((await load(src, page.url)).ok, false);
  assert.equal(calls, 0);
  assert.equal(new URL('/config.js', page.url + '#page-fragment').hash, '');
  const sources = await Promise.all([load('/config.js', page.url), load('/config.js', page.url + '#page-fragment')]);
  assert.ok(sources.every(source => source.ok), 'both path references must reach the cache, not fragment refusal');
  assert.deepEqual(sources[0], sources[1]);
  assert.equal(calls, 1);
  for (const src of ['/redirect', '/large', '/error?credential=' + key]) assert.deepEqual(await load(src, page.url), { ok: false });
  for (let i = calls; i < BINDING_LIMITS.scripts_per_run; i++) await load('/c' + i, page.url);
  assert.deepEqual(await load('/over-budget', page.url), { ok: false });
  assert.equal(calls, BINDING_LIMITS.scripts_per_run);
});
test('canonical run emits real credential-free page evidence', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'binding-run-'));
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async url => { calls++; return String(url).endsWith('/unavailable') ? new Response('', {status:503}) : new Response(inline(String(url).endsWith('/mismatch') ? 'different-synthetic-value' : key)); };
  const spec = { schema_version: '4.3', campaign: { slug: 'binding-fixture', campaigns_api_key: key }, funnels: [] };
  try {
    const result = await __qaNodeTestHooks.runResolvedQa({ _: ['qa', 'run'], 'output-dir': outputDir, 'no-post-verdict': true, 'no-remit': true }, {
      themeGate: { status: 'not_applicable', code: 'theme_gate.no_theme_context', reason: 'Synthetic fixture.' },
      polishGate: { status: 'not_applicable', code: 'polish.not_applicable', reason: 'Synthetic fixture.' },
      checkpointGates: [], qaWaivers: {}, analyticsCaptureTarget: { url: null, source: 'unresolved' },
      brandContract: null, brandContractStatus: 'not_evaluated', packetPath: null, packet: null,
      mapId: 'binding-fixture', publicRouteSlug: 'binding-fixture', proxyBase: 'https://fixture.example.test',
      baseUrl: 'https://fixture.example.test/', specPath: null, specSource: 'test', portalManaged: false,
      rawSpec: spec, spec, specVersion: '4.3', specHash: 'sha256:fixture', templateFamily: null,
      commerceStructureContract: null, topologies: [{ funnel_id: 'default', pages: [page, {...page, page_id:'checkout-alternate/' + 'long-path/'.repeat(20), url:'https://fixture.example.test/mismatch'}, {...page, page_id:'receipt', url:'https://fixture.example.test/unavailable'}] }],
    });
    assert.equal(calls, 3);
    assert.deepEqual(result.verdict.assertions.filter(a => a.id.startsWith("page-binding:")).map(a => a.evidence.outcome), ["match", "mismatch", "unknown"]);
    const binding = result.verdict.assertions.find(a => a.id === 'page-binding:checkout');
    assert.equal(binding.evidence.outcome, 'match');
    assert.equal(JSON.stringify(result).includes(key), false);
    // Optional private evidence export is an actual producer result, never a hand-written verdict.
    if (process.env.BINDING_FIXTURE_OUT) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(process.env.BINDING_FIXTURE_OUT, JSON.stringify(result.verdict, null, 2) + '\n');
    }
  } finally { globalThis.fetch = previous; rmSync(outputDir, { recursive: true, force: true }); }
});

test('page script count and request deadline failures are unknown and discard exception text', async () => {
  let calls = 0;
  const result = await observe('<script src="/c.js"></script>'.repeat(7), { scriptLoader: async () => { calls++; return {ok:true,html:`window.nextConfig={apiKey:'${key}'}`}; } });
  assert.equal(calls, BINDING_LIMITS.scripts_per_page);
  assert.equal(result.reason, 'script_unavailable_or_limit');
  const load = createBindingScriptLoader({ fetchImpl: (_url, {signal}) => new Promise((_resolve,reject) => signal.addEventListener('abort', () => reject(new Error(key)), {once:true})) });
  assert.deepEqual(await load('/timeout.js', page.url), {ok:false});
});

test('supported and legacy credential meta hints are never duplicated into ordinary assertions', async () => {
  for (const name of ['next-api-key', 'next-campaign-api-key']) {
    const { assertions } = await __qaNodeTestHooks.runPageChecks({ ...page, expected_meta_tags: {[name]: key} }, {}, {
      sourceLoader: async () => ({ok:true,status:200,status_text:'OK',html:`<meta name="${name}" content="${key}">`}),
      bindingExpected: {value:key},
    });
    const binding = assertions.find(a => a.id === 'page-binding:checkout');
    assert.equal(binding.status, name === 'next-api-key' ? 'pass' : 'manual_review');
    if (name === 'next-campaign-api-key') assert.equal(binding.evidence.reason, 'no_source');
    assert.equal(assertions.some(a => a.id.startsWith('meta:')), false);
    assert.equal(JSON.stringify(assertions).includes(key), false);
    assert.equal(JSON.stringify(assertions).includes(key.slice(-8)), false);
  }
});

test('data-block scripts are not fetched and do not exhaust the config request budget', async () => {
  let calls = 0;
  const dataBlocks = '<script type="application/ld+json" src="/data.json">{"apiKey":"irrelevant"}</script>'.repeat(BINDING_LIMITS.scripts_per_page + 1);
  const evidence = await observe(dataBlocks + '<script src="/config.js"></script>', {
    scriptLoader: async src => {
      calls++;
      assert.equal(src, '/config.js');
      return {ok:true,html:`window.nextConfig={apiKey:'${key}'}`};
    },
  });
  assert.equal(evidence.outcome, 'match');
  assert.equal(calls, 1);
});

test('event handlers and redirected pages cannot silently certify the wrong source', async () => {
  assert.equal((await observe(inline(key) + '<body onload="changeConfig()">')).reason, 'dynamic_unresolved');
  assert.equal((await observe('', {source:{ok:true,html:inline(key),final_url:'https://other.test/'}})).reason, 'page_unavailable');
  let base;
  const result = await observe('', {source:{ok:true,html:'<script src="config.js"></script>',final_url:'https://fixture.example.test/new/checkout'},scriptLoader:async (_src,url)=>{base=url;return {ok:true,html:`window.nextConfig={apiKey:'${key}'}`};}});
  assert.equal(result.outcome,'match'); assert.equal(base,'https://fixture.example.test/new/checkout');
});

// #480: a script that does not parse is its own state, not "dynamic".
const checkoutScript = 'document.addEventListener("DOMContentLoaded", () => {\n  init();\n});\n';
test('an unparsable page script is recorded with its position, never as dynamic', async () => {
  const parseFailures = [];
  const evidence = await observe(inline(key) + '<script defer src="/js/checkout.js?v=2#x"></script>', {
    parseFailures,
    scriptLoader: async () => ({ ok: true, html: checkoutScript + '});\n' }),
  });
  assert.equal(evidence.outcome, 'unknown');
  assert.notEqual(evidence.reason, 'dynamic_unresolved');
  assert.equal(evidence.reason, 'script_unavailable_or_limit');
  assert.deepEqual(parseFailures, [{ source_kind: 'config_script', script: '/js/checkout.js', line: 4, column: 1, message: 'Unexpected token' }]);
  const inlineFailures = [];
  await observe('<script>window.nextConfig = {apiKey: "x"};\n}</script>', { parseFailures: inlineFailures });
  assert.deepEqual(inlineFailures.map(f => [f.source_kind, f.script, f.line, f.column]), [['inline', null, 2, 1]]);
  // The same script without the stray bracket parses and records nothing.
  const clean = [];
  const ok = await observe(inline(key) + '<script src="/js/checkout.js"></script>', { parseFailures: clean, scriptLoader: async () => ({ ok: true, html: checkoutScript }) });
  assert.deepEqual(clean, []);
  assert.equal(ok.reason, 'dynamic_unresolved', 'a parsable non-declaration script is still dynamic');
  // A module script parses as a module: import is not a syntax error there.
  const modules = [];
  await observe('<script type="module" src="/js/app.js"></script>', { parseFailures: modules, scriptLoader: async () => ({ ok: true, html: 'import x from "./x.js"; export default x;' }) });
  assert.deepEqual(modules, []);
});

test('QA reports an unparsable page script as a blocker naming the script and position', async () => {
  const { assertions } = await __qaNodeTestHooks.runPageChecks(page, {}, {
    sourceLoader: async () => ({ ok: true, status: 200, status_text: 'OK', html: inline(key) + '<script src="/js/checkout.js"></script>' }),
    bindingExpected: { value: key },
    bindingScriptLoader: async () => ({ ok: true, html: checkoutScript + '});\n' }),
  });
  const parse = assertions.find(a => a.id === 'script-parse:checkout');
  assert.ok(parse, 'no script-parse assertion');
  assert.equal(parse.family, 'api-metadata');
  assert.equal(parse.status, 'fail');
  assert.equal(parse.severity, 'blocker');
  assert.equal(parse.actual, 'unparsable: /js/checkout.js:4:1');
  assert.equal(JSON.stringify(parse).includes(key), false);
  assert.equal(assertions.find(a => a.id === 'page-binding:checkout').evidence.reason, 'script_unavailable_or_limit');
  assert.equal(scriptParseAssertion(page, []), null);
  const clean = await __qaNodeTestHooks.runPageChecks(page, {}, {
    sourceLoader: async () => ({ ok: true, status: 200, status_text: 'OK', html: inline(key) + '<script src="/js/checkout.js"></script>' }),
    bindingExpected: { value: key },
    bindingScriptLoader: async () => ({ ok: true, html: checkoutScript }),
  });
  assert.equal(clean.assertions.some(a => a.id.startsWith('script-parse:')), false);
});

test('a parse failure in a script from another origin keeps its host, never the full URL', async () => {
  const parseFailures = [];
  await observe('<script src="https://cdn.fixture.test/lib/config.js?v=2#x"></script>', {
    parseFailures,
    scriptLoader: async () => ({ ok: true, html: 'window.nextConfig = {apiKey: "x"};\n}' }),
  });
  assert.equal(parseFailures.length, 1);
  assert.equal(parseFailures[0].script, 'cdn.fixture.test/lib/config.js');
});

// Review follow-ups on #480.
const canary = 'synthetic_canary_Zq81xT';
test('a <base href> resolves page scripts to the URL the browser loads', async () => {
  const requested = [];
  const parseFailures = [];
  await observe(`<base href="/shop/assets/">${inline(key)}<script src="checkout.js"></script>`, {
    parseFailures,
    scriptLoader: async (src, pageUrl) => { requested.push(new URL(src, pageUrl).href); return { ok: true, html: checkoutScript + '});\n' }; },
  });
  assert.deepEqual(requested, ['https://fixture.example.test/shop/assets/checkout.js']);
  assert.deepEqual(parseFailures.map(f => f.script), ['/shop/assets/checkout.js']);
  // A base on another origin: the real loader refuses the cross-origin script.
  const fetched = [];
  const loader = createBindingScriptLoader({ fetchImpl: async (url) => { fetched.push(url); return new Response('window.nextConfig = {apiKey: "x"};'); } });
  const remote = await observe(`<base href="https://cdn.fixture.test/lib/">${inline(key)}<script src="config.js"></script>`, { scriptLoader: loader });
  assert.deepEqual(fetched, []);
  assert.equal(remote.reason, 'script_unavailable_or_limit');
});

test('a nomodule script is never parsed or reported: module-capable browsers skip it', async () => {
  const parseFailures = [];
  let loads = 0;
  const evidence = await observe(`${inline(key)}<script nomodule src="/js/legacy.js"></script><script nomodule>}</script>`, {
    parseFailures,
    scriptLoader: async () => { loads += 1; return { ok: true, html: checkoutScript + '});\n' }; },
  });
  assert.deepEqual(parseFailures, []);
  assert.equal(loads, 0);
  assert.equal(evidence.reason, 'dynamic_unresolved');
});

test('a module script ignores nomodule, so QA still loads, parses and reports it', async () => {
  const parseFailures = [];
  let loads = 0;
  await observe(`${inline(key)}<script type="module" nomodule src="/js/app.js"></script><script type=" MODULE " nomodule>}</script>`, {
    parseFailures,
    scriptLoader: async () => { loads += 1; return { ok: true, html: checkoutScript + '});\n' }; },
  });
  assert.equal(loads, 1);
  assert.deepEqual(parseFailures.map(f => f.source_kind), ['config_script', 'inline']);
});

test('script types are ASCII-whitespace-trimmed and case-insensitive before QA classifies them', async () => {
  const parseFailures = [];
  await observe(`${inline(key)}<script type=" text/javascript ">}</script><script type="\tApplication/JavaScript\n">}</script><script type=" Module ">}</script>`, { parseFailures });
  assert.equal(parseFailures.length, 3);
  const skipped = [];
  await observe(`${inline(key)}<script type="\u00a0text/javascript">}</script><script type=" ">}</script><script type="application/ld+json">}</script>`, { parseFailures: skipped });
  assert.deepEqual(skipped, []);
});

test('parser messages never carry source text into QA evidence', async () => {
  for (const html of [
    `<script>var pattern = /${canary}(/;</script>`,
    `<script>let ${canary} = 1; let ${canary} = 2;</script>`,
    `<script src="/js/config.js"></script>`,
  ]) {
    const parseFailures = [];
    await observe(html, { parseFailures, scriptLoader: async () => ({ ok: true, html: `var a = 1;\n@${canary}\n` }) });
    assert.equal(parseFailures.length, 1, html);
    const assertion = scriptParseAssertion(page, parseFailures);
    assert.equal(JSON.stringify(assertion).includes(canary), false, JSON.stringify(assertion));
    assert.match(parseFailures[0].message, /^[A-Z][a-z]/);
  }
});

test('a data block carrying nomodule stays a data block; only a classic nomodule script leaves the binding unresolved', async () => {
  const dataBlock = await observe(`${inline(key)}<script type="application/ld+json" nomodule>{}</script>`);
  assert.equal(dataBlock.outcome, 'match');
  const classic = await observe(`${inline(key)}<script nomodule src="/legacy.js"></script>`);
  assert.equal(classic.outcome, 'unknown');
  assert.equal(classic.reason, 'dynamic_unresolved');
});

test('a language attribute with trailing whitespace is not run by the browser, so it cannot bind', async () => {
  const evidence = await observe(`<script language="JavaScript ">window.nextConfig = {apiKey: ${JSON.stringify(key)}};</script>`);
  assert.notEqual(evidence.outcome, 'match');
});
