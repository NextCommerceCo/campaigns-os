// Optional loopback browser regression. Requires the repository's Playwright Chromium.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { runBrowserChecks } from '../../src/qa-browser.mjs';

const ids = ['next-debug-overlay-host', 'debug-selectors-container', 'debug-currency-selector', 'debug-country-selector', 'debug-locale-selector'];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/failed' || url.pathname === '/navigation-failure') {
    req.socket.destroy();
    return;
  }
  if (url.pathname === '/pending') return; // Closed with the browser context/server.
  const debug = url.searchParams.has('debugger');
  if (url.pathname === '/delayed-debugger' && debug) await delay(400);
  res.setHeader('Content-Type', 'text/html');
  const late = ['/late-errors', '/delayed-debugger'].includes(url.pathname);
  const ready = url.pathname !== '/missing-readiness';
  res.end(`<html class="${ready ? 'next-display-ready' : ''}"><body>
    ${ready ? ids.map(id => `<div id="${id}"></div>`).join('') : ''}
    <script>
      ${late ? `setTimeout(() => { throw new Error('${debug ? 'LATE_DEBUGGER_PAGE_ERROR' : 'LATE_MAIN_PAGE_ERROR'}'); }, ${debug ? 1250 : 1800});
      setTimeout(() => console.error('${debug ? 'DEBUGGER_CONSOLE_ERROR' : 'MAIN_CONSOLE_ERROR'}'), 1000);
      ${debug ? '' : "setTimeout(() => fetch('/failed').catch(() => {}), 1000);"}` : ''}
      ${debug && url.pathname === '/pending-traffic' ? "fetch('/pending').catch(() => {});" : ''}
    </script>
  </body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const results = [];
  for (const name of ['late-errors', 'delayed-debugger', 'pending-traffic', 'missing-readiness', 'navigation-failure']) {
    const started = performance.now();
    const assertions = await runBrowserChecks([{ pages: [{
      page_id: 'receipt', page_type: 'receipt',
      url: `http://127.0.0.1:${server.address().port}/${name}`,
    }] }], { 'browser-timeout': 2000 });
    const load = assertions.find(item => item.id === 'browser-load:receipt');
    const debuggerResult = assertions.find(item => item.id === 'browser-sdk-debugger:receipt');
    assert.equal(load?.evidence.observation.policy, 'legacy-sequential-v1');
    if (name === 'navigation-failure') {
      assert.equal(load.status, 'fail');
      assert.ok(Number.isFinite(load.evidence.observation.failed_after_ms));
      assert.equal(debuggerResult, undefined);
    } else {
      const mainTiming = load.evidence.observation;
      const debugTiming = debuggerResult?.evidence.observation;
      assert.equal(debugTiming?.policy, 'networkidle-plus-1000ms-v1');
      assert.ok(debugTiming.post_settle_ms >= 950, 'Debugger observation was shortened');
      assert.ok(mainTiming.page_errors_sampled_after_ms >= mainTiming.debugger_ms);
      assert.ok(mainTiming.console_errors_sampled_after_ms >= mainTiming.page_errors_sampled_after_ms);
      assert.ok(mainTiming.failed_requests_sampled_after_ms >= mainTiming.console_errors_sampled_after_ms);
      assert.ok(Object.values(mainTiming).filter(value => typeof value === 'number').every(value => Number.isFinite(value) && value >= 0));
      if (['late-errors', 'delayed-debugger'].includes(name)) {
        const mainErrors = assertions.find(item => item.id === 'browser-page-errors:receipt');
        const consoleErrors = assertions.find(item => item.id === 'browser-console-errors:receipt');
        const failures = assertions.find(item => item.id === 'browser-request-failures:receipt');
        assert.ok(mainErrors?.evidence.messages.includes('LATE_MAIN_PAGE_ERROR'), 'Late main-page error disappeared');
        assert.ok(debuggerResult.evidence.page_errors.includes('LATE_DEBUGGER_PAGE_ERROR'), 'Late debugger error disappeared');
        assert.ok(consoleErrors?.evidence.messages.includes('MAIN_CONSOLE_ERROR'));
        assert.ok(debuggerResult.evidence.console_errors.includes('DEBUGGER_CONSOLE_ERROR'));
        assert.ok(failures?.evidence.failed_requests.some(item => item.url.endsWith('/failed')));
      }
      if (name === 'delayed-debugger') assert.ok(debugTiming.navigation_ms >= 350);
      if (name === 'pending-traffic') assert.ok(debugTiming.settle_ms >= 4900);
      if (name === 'missing-readiness') assert.equal(debuggerResult.status, 'warn');
    }
    results.push({ scenario: name, duration_ms: Math.round(performance.now() - started),
      main: load.evidence.observation, debugger: debuggerResult?.evidence.observation });
  }
  console.log(JSON.stringify({ node: process.version, scenarios: results }, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
