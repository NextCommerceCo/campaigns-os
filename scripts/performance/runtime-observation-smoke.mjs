// Optional browser regression. Requires the repository's Playwright Chromium.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runBrowserChecks } from '../../src/qa-browser.mjs';

const ids = ['next-debug-overlay-host', 'debug-selectors-container', 'debug-currency-selector', 'debug-country-selector', 'debug-locale-selector'];
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<html class="next-display-ready"><body>
    ${ids.map(id => `<div id="${id}"></div>`).join('')}
    <script>setTimeout(() => { throw new Error(location.search.includes('debugger')
      ? 'LATE_DEBUGGER_PAGE_ERROR' : 'LATE_MAIN_PAGE_ERROR'); }, 1000);</script>
  </body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const started = performance.now();
  const assertions = await runBrowserChecks([{ pages: [{
    page_id: 'receipt', page_type: 'receipt',
    url: `http://127.0.0.1:${server.address().port}/receipt`,
  }] }]);
  const main = assertions.find(item => item.id === 'browser-page-errors:receipt');
  const debuggerResult = assertions.find(item => item.id === 'browser-sdk-debugger:receipt');
  assert.ok(main?.evidence.messages.includes('LATE_MAIN_PAGE_ERROR'), 'Late main-page error disappeared');
  assert.ok(debuggerResult?.evidence.page_errors.includes('LATE_DEBUGGER_PAGE_ERROR'), 'Late debugger error disappeared');
  console.log(JSON.stringify({ node: process.version, duration_ms: performance.now() - started,
    main_page_error_retained: true, debugger_page_error_retained: true }, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
