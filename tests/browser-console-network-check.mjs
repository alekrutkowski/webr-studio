/**
 * Optional real-browser regression for R download progress in the console.
 * Requires Playwright, Chromium, and access to webR/Ace's existing CDNs.
 * The real R console, download bridge, and networking controller are used.
 * Only the Tailscale worker is replaced by an explicit local test transport.
 *
 * node tests/browser-console-network-check.mjs
 * PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node tests/browser-console-network-check.mjs
 * BROWSER_IGNORE_HTTPS_ERRORS=1 is for an intercepting test proxy only.
 * SCREENSHOT_PATH=/path/to/console.png optionally saves successful progress.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? require(resolve(process.env.PLAYWRIGHT_MODULE))
  : await import('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = '/console-network-regression/';
const csv = 'id,value\n1,17\n2,23\n';
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json'
};
const listen = server => new Promise((done, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`));
});
const close = server => new Promise(done => {
  if (!server.listening) { done(); return; }
  server.close(done);
  server.closeAllConnections();
});
const fixture = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  // No CORS permission: a direct browser read cannot supply the fixture CSV.
  if (new URL(request.url, 'http://fixture.invalid').pathname === '/data.csv') {
    response.setHeader('Content-Type', 'text/csv');
    response.end(csv);
  } else {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('The fixture was not found.');
  }
});
let fixtureOrigin;
const transportedURLs = [];
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://studio.invalid').pathname);
    if (path === `${prefix}__test_tunnel__` && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const target = new URL(data.url);
      if (target.origin !== fixtureOrigin) throw new Error('The test transport only accepts its local fixture server.');
      transportedURLs.push(target.href);
      const remote = await fetch(target, { headers: data.headers, signal: AbortSignal.timeout(10_000) });
      response.setHeader('X-Test-Upstream-Status', String(remote.status));
      response.end(Buffer.from(await remote.arrayBuffer()));
      return;
    }
    if (!path.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
    const local = resolve(root, path.slice(prefix.length) || 'index.html');
    if (local !== root && !local.startsWith(`${root}${sep}`)) throw new Error('Invalid path.');
    response.setHeader('Content-Type', types[extname(local)] || 'application/octet-stream');
    response.end(await readFile(local));
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 400);
    response.end(error.message);
  }
});
const ignoreTestCertificates = /^(1|true)$/i.test(process.env.BROWSER_IGNORE_HTTPS_ERRORS || '');
const diagnostics = [];
const pageErrors = [];
const tailscaleRequests = [];
let browser;

async function waitForRuntime(page) {
  try {
    await page.waitForFunction(() => (
      globalThis.webRStudio && ['ready', 'error'].includes(document.querySelector('#r-status')?.dataset.state)
    ), null, { timeout: Number(process.env.BROWSER_BOOT_TIMEOUT_MS) || 180_000 });
  } catch (error) {
    console.error('Startup state:', await page.evaluate(() => ({
      ready: globalThis.webRStudio?.engine?.ready,
      network: globalThis.webRStudio?.network?.state,
      status: document.querySelector('#r-status')?.textContent,
      boot: document.querySelector('#boot-message')?.textContent
    })).catch(() => 'Page unavailable.'));
    throw error;
  }
  const runtime = await page.evaluate(() => ({
    ready: webRStudio.engine.ready, bridge: webRStudio.network.state.bridgeReady,
    bridgeError: webRStudio.network.state.bridgeError, version: webRStudio.engine.version
  }));
  assert.equal(runtime.ready, true, JSON.stringify(runtime));
  assert.equal(runtime.bridge, true, JSON.stringify(runtime));
  console.log(`webR ${runtime.version} and the download bridge are ready.`);
}

async function installFakeWorker(page, tunnelURL) {
  await page.evaluate(tunnelURL => {
    const calls = [];
    class FakeWorker extends EventTarget {
      constructor() {
        super();
        this.prefs = { exitNodeId: 'initial-exit', dnsMode: 'exit-node' };
        this.terminated = false;
      }
      snapshot() {
        return { ...this.prefs, ip: '100.64.0.2', exitNodes: [
          { id: 'initial-exit', hostName: 'Initial exit', tailscaleIP: '100.64.0.1', online: true },
          { id: 'working-exit', hostName: 'Working exit', tailscaleIP: '100.64.0.3', online: true }
        ] };
      }
      reply(id, result, error) { this.dispatchEvent(new MessageEvent('message', { data: { id, result, error } })); }
      postMessage({ id, method, args }) {
        calls.push({ id, method, args, exitNodeId: this.prefs.exitNodeId });
        queueMicrotask(async () => {
          if (this.terminated) return;
          try {
            if (method === 'setExitNode') this.prefs.exitNodeId = args.id;
            if (method === 'setDNSMode') this.prefs.dnsMode = args.mode;
            if (method === 'download') {
              const response = await fetch(tunnelURL, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args)
              });
              if (!response.ok) throw new Error(await response.text());
              this.reply(id, {
                status: Number(response.headers.get('X-Test-Upstream-Status')),
                statusText: 'Fixture response', body: await response.arrayBuffer()
              });
            } else this.reply(id, this.snapshot());
          } catch (error) { this.reply(id, null, error.message); }
        });
      }
      terminate() { this.terminated = true; }
    }
    globalThis.__consoleNetworkCalls = calls;
    webRStudio.network.refreshInterval = 0;
    webRStudio.network.workerFactory = () => new FakeWorker();
  }, tunnelURL);
  assert.equal(await page.evaluate(() => Object.hasOwn(webRStudio.network, 'download')), false,
    'The actual networking controller download method must remain in use.');
}

async function execute(page, code, { file = '', resultVariable = '' } = {}) {
  return page.evaluate(async ({ code, file, resultVariable }) => {
    webRStudio.console.clear();
    const start = __consoleNetworkCalls.length;
    const result = await webRStudio.executeCode(code);
    let contents = null;
    if (file) {
      try { contents = Array.from(await webRStudio.engine.webR.FS.readFile(file)); }
      catch { /* A real failed download need not create a destination. */ }
    }
    return {
      ok: result.ok, error: result.error,
      returnStatus: resultVariable ? await webRStudio.engine.webR.evalRNumber(resultVariable) : null,
      contents,
      entries: webRStudio.console.transcript.map(({ type, text }) => ({ type, text })),
      cards: [...document.querySelectorAll('#console-output .console-entry')].map(element => ({
        classes: element.className,
        label: element.querySelector('.console-entry-label')?.textContent,
        text: element.querySelector('.console-entry-body')?.textContent
      })),
      calls: __consoleNetworkCalls.slice(start)
    };
  }, { code, file, resultVariable });
}

try {
  fixtureOrigin = await listen(fixture);
  const origin = await listen(server);
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...(ignoreTestCertificates ? ['--ignore-certificate-errors'] : [])]
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: ignoreTestCertificates });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => diagnostics.push(`${request.url()} ${request.failure()?.errorText || ''}`));
  page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
  page.on('request', request => { if (new URL(request.url()).pathname.includes('/vendor/tailscale-web/')) tailscaleRequests.push(request.url()); });
  await page.goto(`${origin}${prefix}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitForRuntime(page);
  const dataURL = `${fixtureOrigin}/data.csv`;
  assert.equal(await page.evaluate(async url => {
    try { await fetch(url); return false; } catch { return true; }
  }, dataURL), true, 'The fixture must reject a direct cross-origin browser read.');
  await installFakeWorker(page, `${origin}${prefix}__test_tunnel__`);
  await page.locator('#network-button').click();
  await page.locator('#network-provider').selectOption('tailscale');
  await page.locator('#network-connect').click();
  await page.waitForFunction(() => webRStudio.network.state.phase === 'connected');
  await page.locator('#network-exit-node').selectOption('working-exit');
  await page.waitForFunction(() => webRStudio.network.state.exitNodeId === 'working-exit');
  await page.locator('#network-test-url').fill(dataURL);
  await page.locator('#network-test').click();
  await page.waitForFunction(() => document.querySelector('#network-test-result').dataset.state === 'success');
  assert.match(await page.locator('#network-test-result').innerText(), /HTTP 200, 19 bytes/);
  await page.locator('#network-dialog button[value="cancel"]').last().click();

  const quotedURL = JSON.stringify(dataURL);
  const expectedBytes = Array.from(new TextEncoder().encode(csv));
  const ordinary = await execute(page,
    `download_status <- download.file(${quotedURL}, "/project/console-network.csv"); print(download_status)`,
    { file: '/project/console-network.csv', resultVariable: 'download_status' });
  assert.equal(ordinary.ok, true, ordinary.error);
  assert.equal(ordinary.error, '');
  assert.equal(ordinary.returnStatus, 0);
  assert.deepEqual(ordinary.contents, expectedBytes, 'The successful file must contain the complete CSV, not just exist.');
  assert.equal(ordinary.calls.filter(call => call.method === 'download').length, 1);
  const progress = ordinary.entries.find(entry => entry.text.includes('trying URL'));
  assert.ok(progress, 'Default quiet=FALSE must exercise R progress written to stderr.');
  assert.equal(progress.type, 'output', 'Successful R download progress is ordinary output.');
  assert.equal(ordinary.cards.some(card => card.label === 'Error'), false, 'A successful download must not create an Error card.');
  assert.ok(ordinary.cards.some(card => card.label === 'Output' && card.text.includes('trying URL')));
  console.log('Default quiet=FALSE download passed: engine ok=true, R status 0, exact 19-byte CSV, and neutral progress output.');
  if (process.env.SCREENSHOT_PATH) {
    const screenshotPath = resolve(process.env.SCREENSHOT_PATH);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await page.locator('#console-pane').screenshot({ path: screenshotPath });
    console.log(`Console screenshot saved to ${screenshotPath}`);
  }

  const quiet = await execute(page,
    `quiet_status <- download.file(${quotedURL}, "/project/console-network-quiet.csv", quiet = TRUE); print(quiet_status)`,
    { file: '/project/console-network-quiet.csv', resultVariable: 'quiet_status' });
  assert.equal(quiet.ok, true, quiet.error);
  assert.equal(quiet.returnStatus, 0);
  assert.deepEqual(quiet.contents, expectedBytes);
  assert.equal(quiet.entries.some(entry => entry.text.includes('trying URL')), false);
  assert.equal(quiet.cards.some(card => card.label === 'Error'), false);
  const submitted = await page.evaluate(async url => {
    webRStudio.console.clear();
    webRStudio.console.setValue(`print(sum(read.csv(${JSON.stringify(url)})$value)); print(readLines(${JSON.stringify(url)}, warn = FALSE))`);
    await webRStudio.console.submit();
    return webRStudio.console.transcript.map(({ type, text }) => ({ type, text }));
  }, dataURL);
  assert.equal(submitted.some(entry => entry.type === 'error'), false);
  assert.ok(submitted.some(entry => entry.type === 'output' && entry.text.includes('[1] 40') && entry.text.includes('id,value')));
  console.log('quiet=TRUE and ordinary console read.csv/readLines passed through the actual controller and worker RPC.');

  const missing = await execute(page,
    `download.file(${JSON.stringify(`${fixtureOrigin}/missing.csv`)}, "/project/console-network-missing.csv")`,
    { file: '/project/console-network-missing.csv' });
  assert.equal(missing.ok, false, 'A real HTTP 404 must fail the R execution.');
  assert.ok(missing.error);
  assert.notDeepEqual(missing.contents, expectedBytes);
  assert.equal(missing.calls.filter(call => call.method === 'download').length, 1);
  assert.ok(missing.entries.some(entry => entry.type === 'error'));
  assert.ok(missing.cards.some(card => card.label === 'Error' && card.classes.split(' ').includes('error')));
  const stopped = await execute(page, 'stop("Expected console failure")');
  assert.equal(stopped.ok, false);
  assert.match(stopped.error, /Expected console failure/);
  assert.ok(stopped.cards.some(card => card.label === 'Error' && card.text.includes('Expected console failure')));
  const conditions = await execute(page, 'warning("Expected console warning"); message("Expected console message"); 1');
  assert.equal(conditions.ok, true, conditions.error);
  assert.ok(conditions.cards.some(card => card.label === 'Warning' && card.text.includes('Expected console warning')));
  assert.ok(conditions.cards.some(card => card.label === 'Message' && card.text.includes('Expected console message')));
  assert.equal(conditions.cards.some(card => card.label === 'Error'), false);
  const calls = await page.evaluate(() => __consoleNetworkCalls.filter(call => call.method === 'download'));
  assert.equal(calls.length, 6);
  assert.equal(calls.every(call => call.exitNodeId === 'working-exit'), true, 'Panel and R requests must follow the changed exit selection.');
  assert.equal(transportedURLs.length, 6);
  assert.deepEqual(tailscaleRequests, [], 'The test must not load the real Tailscale runtime.');
  assert.deepEqual(pageErrors, []);
  console.log('HTTP 404, stop(), warnings, and messages retain their real R condition labels. Browser console networking checks passed; Tailscale transport was mocked throughout.');
} catch (error) {
  if (diagnostics.length) console.error(diagnostics.slice(-20).join('\n'));
  if (pageErrors.length) console.error(pageErrors.join('\n'));
  throw error;
} finally {
  await browser?.close();
  await Promise.all([close(server), close(fixture)]);
}
