// Runs one synthetic workload in a fresh process; never makes network requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..');
const dir = fs.mkdtempSync(join(tmpdir(), 'campaigns-os-perf-'));
const workload = process.argv[2];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  throw new Error(`Unexpected fetch during performance workload setup: ${url}`);
};
let reads = 0;
let bytes = 0;
let requests = 0;
let output;
try {
  // Imports and fixture setup are deliberately outside the operation timer.
  const cli = await import('../../src/cli.mjs');
  const qa = await import('../../src/qa-node.mjs');
  const { CycleDetection } = await import('../../campaign-spec/dist/rules/cycle-detection.js');
  fs.cpSync(join(root, 'examples'), dir, { recursive: true });
  const source = join(dir, 'source-html');
  const target = join(dir, 'target-page-kit/src/runtime-packet-demo');
  fs.mkdirSync(target, { recursive: true });
  const html = '<main>Made in USA. $29.99. Call 212-555-9999. Package Title. SAVE 90%.</main>\n'.repeat(128);
  for (let i = 0; i < 32; i++) {
    fs.writeFileSync(join(source, `perf-${i}.html`), html);
    fs.writeFileSync(join(target, `perf-${i}.html`), html);
  }
  const packetPath = join(dir, 'build-packet.basic.json');
  const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
  packet.assembly.target_repo = 'target-page-kit';
  packet.assembly.commerce_catalog.path = join(root, 'contracts/commerce-surface-catalog.json');
  fs.writeFileSync(packetPath, JSON.stringify(packet));
  const reportPath = join(dir, 'perf-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    schema_version: 'campaign-runtime-assembly-report/v0',
    stages: { assembly: { status: 'completed' } },
  }));
  const specPath = join(dir, packet.spec.local_path);
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  Object.assign(spec.campaign, { currency: 'GBP', available_shipping_countries: ['GB'], store_phone: '+44 20 7946 0000' });
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const pages = Array.from({ length: 16 }, (_, i) => ({
    page_id: `page-${i}`, page_type: 'landing', label: `Page ${i}`,
    url: `https://performance.example.test/page-${i}/`,
  }));
  const urls = new Set(pages.map(page => page.url));
  globalThis.fetch = async (url, options = {}) => {
    assert.ok(urls.has(String(url)) && !options.method, `Unexpected request: ${url}`);
    requests++;
    await delay(10);
    return new Response('<html><head><title>Fixture</title></head><body><main>Fixture</main></body></html>');
  };
  const readFile = fs.readFileSync;
  fs.readFileSync = function (...args) {
    const result = readFile.apply(this, args);
    // Count workload reads, not dependencies or module loader reads.
    const path = args[0] instanceof URL ? fileURLToPath(args[0]) :
      Buffer.isBuffer(args[0]) ? args[0].toString() : args[0];
    if (typeof path === 'string' && path.startsWith(dir + '/')) {
      reads++;
      bytes += Buffer.byteLength(result);
    }
    return result;
  };
  syncBuiltinESMExports();
  const start = performance.now();
  if (workload === 'doctor') {
    const result = cli.doctorPacket(packetPath, { reportPath });
    assert.ok(result.derived.doctor_checks.length > 0);
    output = result;
  } else if (workload === 'copy-scans') {
    const warnings = [], ready = [];
    cli.validateMarketSensitiveCopy(spec, warnings, ready, { source_root: source, target_output_dir: target });
    assert.ok(warnings.some(issue => issue.code === 'copy.hardcoded_currency_symbol'));
    assert.ok(warnings.some(issue => issue.code === 'copy.hardcoded_phone'));
    output = { warnings, ready };
  } else if (workload === 'static-qa') {
    const spec = { schema_version: '4.3', campaign: {}, funnels: [] };
    const result = await qa.__qaNodeTestHooks.runResolvedQa({
      'output-dir': join(dir, 'qa'), 'no-post-verdict': true,
      'analytics-correctness': 'false', 'test-order': 'off',
    }, {
      themeGate: { status: 'not_applicable', code: 'theme_gate.no_theme_context', reason: 'Synthetic benchmark' },
      polishGate: { status: 'not_applicable', code: 'polish.not_applicable', reason: 'Synthetic benchmark' },
      checkpointGates: [], qaWaivers: {}, analyticsCaptureTarget: { url: null, source: 'unresolved' },
      brandContract: null, brandContractStatus: 'not_evaluated', packetPath: null, packet: null,
      mapId: 'performance', publicRouteSlug: 'performance', proxyBase: 'https://performance.example.test',
      baseUrl: 'https://performance.example.test/', specPath: null, specSource: 'test',
      portalManaged: false, rawSpec: spec, spec, specVersion: '4.3', specHash: 'sha256:test',
      templateFamily: null, commerceStructureContract: null,
      topologies: [{ funnel_id: 'default', funnel_name: 'Default', weight: 100, pages }],
    });
    // A changed request count changes the workload: require an explicit new baseline.
    assert.equal(requests, pages.length);
    output = result.verdict.assertions;
  } else if (workload === 'cycle-chain') {
    const pages = Array.from({ length: 500 }, (_, i) => ({
      id: `p${i}`, type: 'landing', ...(i < 499 ? { next_page: `p${i + 1}` } : {}),
    }));
    output = CycleDetection.check({ funnels: [{ pages }] });
    assert.deepEqual(output, []);
  } else {
    throw new Error(`Unknown workload: ${workload}`);
  }
  const durationMs = performance.now() - start;
  // Ignore only volatile producer timestamps and the unique temporary root.
  const stable = JSON.stringify(output, (key, value) =>
    ['generated_at', 'checked_at'].includes(key) ? '<timestamp>' :
      typeof value === 'string' ? value.split(dir).join('<fixture>').split(root).join('<toolkit>') : value);
  console.log(JSON.stringify({ duration_ms: durationMs, reads, bytes, requests,
    output_sha256: createHash('sha256').update(stable).digest('hex') }));
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
