import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeBinding, bindingAssertion, expectedBinding, createBindingScriptLoader, BINDING_LIMITS } from './qa-binding-evidence.mjs';
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
  for (const src of ['https://other.test/config.js', 'https://user:password@fixture.example.test/x', 'file:///tmp/config.js']) assert.equal((await load(src, page.url)).ok, false);
  assert.equal(calls, 0);
  await Promise.all([load('/config.js', page.url), load('/config.js', page.url)]);
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

test('credential meta hints are never duplicated into ordinary assertions', async () => {
  const { assertions } = await __qaNodeTestHooks.runPageChecks({ ...page, expected_meta_tags: {'next-api-key': key} }, {}, {
    sourceLoader: async () => ({ok:true,status:200,status_text:'OK',html:`<meta name="next-api-key" content="${key}">`}),
    bindingExpected: {value:key},
  });
  assert.equal(assertions.find(a => a.id === 'page-binding:checkout').status, 'pass');
  assert.equal(JSON.stringify(assertions).includes(key), false);
  assert.equal(JSON.stringify(assertions).includes(key.slice(-8)), false);
});

test('event handlers and redirected pages cannot silently certify the wrong source', async () => {
  assert.equal((await observe(inline(key) + '<body onload="changeConfig()">')).reason, 'dynamic_unresolved');
  assert.equal((await observe('', {source:{ok:true,html:inline(key),final_url:'https://other.test/'}})).reason, 'page_unavailable');
  let base;
  const result = await observe('', {source:{ok:true,html:'<script src="config.js"></script>',final_url:'https://fixture.example.test/new/checkout'},scriptLoader:async (_src,url)=>{base=url;return {ok:true,html:`window.nextConfig={apiKey:'${key}'}`};}});
  assert.equal(result.outcome,'match'); assert.equal(base,'https://fixture.example.test/new/checkout');
});
