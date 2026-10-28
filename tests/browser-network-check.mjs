/**
 * Optional real-browser regression test. Requires Playwright, Chromium, and
 * internet access for webR/Ace's existing CDNs. This test deliberately mocks
 * the Tailscale transport; it does not authenticate a tailnet or an exit node.
 *
 * npm run test:browser
 * PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium npm run test:browser
 * BROWSER_IGNORE_HTTPS_ERRORS=1 is available for an intercepting test proxy only.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? require(resolve(process.env.PLAYWRIGHT_MODULE))
  : await import('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = '/network-regression/';
const bytes = new Uint8Array([0, 1, 127, 128, 255, 10, 13]);
const csv = 'id,value\n1,17\n2,23\n';
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json'
};
const listen = server => new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolveListen(`http://127.0.0.1:${server.address().port}`));
});
const close = server => new Promise(resolveClose => {
  server.close(resolveClose);
  server.closeAllConnections();
});
const fixture = createServer((request, response) => {
  // No Access-Control-Allow-Origin: direct browser fetch must fail.
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  response.setHeader('Cache-Control', 'no-store');
  const path = new URL(request.url, 'http://fixture.invalid').pathname;
  if (path === '/data.csv') {
    response.setHeader('Content-Type', 'text/csv');
    response.end(csv);
  } else if (path === '/bytes.bin') {
    response.setHeader('Content-Type', 'application/octet-stream');
    response.end(bytes);
  } else if (path === '/header') {
    response.end(String(request.headers['x-bridge-test'] || 'missing'));
  } else if (path === '/tab') {
    response.end(String(request.headers['x-test-tab'] || 'missing'));
  } else if (path === '/redirect') {
    response.writeHead(302, { Location: '/data.csv' });
    response.end();
  } else {
    response.writeHead(404);
    response.end('fixture not found');
  }
});
const fixtureOrigin = await listen(fixture);
const proxyTargets = [];
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://studio.invalid').pathname);
    if (path === `${prefix}__mock_tunnel__` && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const target = new URL(data.url);
      if (target.origin !== fixtureOrigin) throw new Error('The test transport only accepts its own fixture server.');
      proxyTargets.push(target.href);
      const remote = await fetch(target, { headers: data.headers, signal: AbortSignal.timeout(10_000) });
      response.setHeader('X-Test-Upstream-Status', String(remote.status));
      response.end(Buffer.from(await remote.arrayBuffer()));
      return;
    }
    if (!path.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
    const local = resolve(root, path.slice(prefix.length) || 'index.html');
    if (local !== root && !local.startsWith(`${root}${sep}`)) throw new Error('Invalid path.');
    const contents = await readFile(local);
    response.setHeader('Content-Type', contentTypes[extname(local)] || 'application/octet-stream');
    response.end(contents);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 400);
    response.end(error.message);
  }
});
const origin = await listen(server);
const appUrl = `${origin}${prefix}`;
const ignoreTestCertificates = /^(1|true)$/i.test(process.env.BROWSER_IGNORE_HTTPS_ERRORS || '');
let browser;
const diagnostics = [];
const rQuote = value => JSON.stringify(value);

async function waitForRuntime(page, label) {
  try {
    await page.waitForFunction(() => (
      globalThis.webRStudio && ['ready', 'error'].includes(document.querySelector('#r-status')?.dataset.state)
    ), null, { timeout: Number(process.env.BROWSER_BOOT_TIMEOUT_MS) || 180_000 });
  } catch (error) {
    console.error(`${label} startup state:`, await page.evaluate(() => ({
      runtimeReady: globalThis.webRStudio?.engine?.ready,
      network: globalThis.webRStudio?.network?.state,
      status: document.querySelector('#r-status')?.textContent,
      boot: document.querySelector('#boot-message')?.textContent,
      controller: navigator.serviceWorker.controller?.scriptURL
    })).catch(() => 'Page unavailable.'));
    throw error;
  }
  const runtime = await page.evaluate(() => ({
    ready: webRStudio.engine.ready,
    version: webRStudio.engine.version,
    bridge: webRStudio.network.state.bridgeReady,
    bridgeError: webRStudio.network.state.bridgeError,
    isolated: crossOriginIsolated,
    interruptSupported: webRStudio.engine.interruptSupported
  }));
  assert.equal(runtime.ready, true, JSON.stringify(runtime));
  assert.equal(runtime.bridge, true, JSON.stringify(runtime));
  console.log(`${label}: webR ${runtime.version} ready; ${runtime.interruptSupported ? 'SharedArrayBuffer' : 'PostMessage'} channel.`);
  return runtime;
}

async function mockTunnel(page, label) {
  await page.evaluate(({ tunnelUrl, label }) => {
    // Explicit test injection. The production Tailscale client is not started.
    webRStudio.__testNetworkCalls = [];
    webRStudio.network.download = async ({ url, headers = [], signal }) => {
      webRStudio.__testNetworkCalls.push(url);
      const response = await fetch(tunnelUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, headers: [...headers, ['X-Test-Tab', label]] }), signal
      });
      if (!response.ok) throw new Error(await response.text());
      return {
        status: Number(response.headers.get('X-Test-Upstream-Status')),
        body: await response.arrayBuffer()
      };
    };
  }, { tunnelUrl: `${origin}${prefix}__mock_tunnel__`, label });
}

try {
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true,
    // An intercepting CI proxy can also affect service-worker fetches, which
    // are separate targets from the page. Never enable this in production.
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...(ignoreTestCertificates ? ['--ignore-certificate-errors'] : [])]
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: ignoreTestCertificates
  });
  const pageA = await context.newPage();
  pageA.on('pageerror', error => diagnostics.push(`tab A: ${error.message}`));
  pageA.on('requestfailed', request => diagnostics.push(`tab A request failed: ${request.url()} ${request.failure()?.errorText || ''}`));
  pageA.on('console', message => {
    if (message.type() === 'error') diagnostics.push(`tab A: ${message.text()}`);
  });
  await pageA.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const runtimeA = await waitForRuntime(pageA, 'Tab A');
  assert.equal(runtimeA.interruptSupported, true, 'the normal page must exercise SharedArrayBuffer');
  const corsBlocked = await pageA.evaluate(async url => {
    try { await fetch(url); return false; } catch { return true; }
  }, `${fixtureOrigin}/data.csv`);
  assert.equal(corsBlocked, true, 'the fixture must actually reject a direct cross-origin browser read');
  const browserModeFails = await pageA.evaluate(code => webRStudio.engine.webR.evalRBoolean(code),
    `inherits(try(download.file(${rQuote(`${fixtureOrigin}/data.csv`)}, tempfile(), quiet = TRUE), silent = TRUE), "try-error")`);
  assert.equal(browserModeFails, true, 'browser mode must retain normal CORS restrictions');
  await mockTunnel(pageA, 'tab-a');

  const sum = await pageA.evaluate(code => webRStudio.engine.webR.evalRNumber(code),
    `sum(read.csv(${rQuote(`${fixtureOrigin}/data.csv`)})$value)`);
  assert.equal(sum, 40, 'read.csv(url) must use the installed download bridge');
  const line = await pageA.evaluate(code => webRStudio.engine.webR.evalRString(code),
    `readLines(${rQuote(`${fixtureOrigin}/data.csv`)}, warn = FALSE)[1L]`);
  assert.equal(line, 'id,value');
  const downloadedBytes = await pageA.evaluate(async ({ code, path }) => {
    await webRStudio.engine.webR.evalRVoid(code);
    return Array.from(await webRStudio.engine.webR.FS.readFile(path));
  }, {
    code: `download.file(${rQuote(`${fixtureOrigin}/bytes.bin`)}, "/tmp/network-regression.bin", mode = "wb", quiet = TRUE)`,
    path: '/tmp/network-regression.bin'
  });
  assert.deepEqual(downloadedBytes, Array.from(bytes), 'download.file must preserve non-text bytes');
  const header = await pageA.evaluate(code => webRStudio.engine.webR.evalRString(code),
    `local({ path <- tempfile(); download.file(${rQuote(`${fixtureOrigin}/header`)}, path, quiet = TRUE, headers = c("X-Bridge-Test" = "a:b:c")); readLines(path, warn = FALSE)[1L] })`);
  assert.equal(header, 'a:b:c');
  const notFound = await pageA.evaluate(code => webRStudio.engine.webR.evalRBoolean(code),
    `inherits(try(download.file(${rQuote(`${fixtureOrigin}/missing`)}, tempfile(), quiet = TRUE), silent = TRUE), "try-error")`);
  assert.equal(notFound, true, 'HTTP failures must remain R errors');
  const redirected = await pageA.evaluate(code => webRStudio.engine.webR.evalRNumber(code),
    `sum(read.csv(${rQuote(`${fixtureOrigin}/redirect`)})$value)`);
  assert.equal(redirected, 40);
  console.log('Real webR passed: CORS failure in browser mode; read.csv, readLines, binary download.file, headers, redirects, and HTTP errors through the mocked tunnel.');

  const pageB = await context.newPage();
  pageB.on('pageerror', error => diagnostics.push(`tab B: ${error.message}`));
  pageB.on('requestfailed', request => diagnostics.push(`tab B request failed: ${request.url()} ${request.failure()?.errorText || ''}`));
  // Exercise the fallback channel in a second tab without changing production
  // code. webR's automatic channel chooser sees no main-thread SAB constructor.
  await pageB.addInitScript(() => Object.defineProperty(globalThis, 'SharedArrayBuffer', { configurable: true, value: undefined }));
  await pageB.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const runtimeB = await waitForRuntime(pageB, 'Tab B');
  assert.equal(runtimeB.interruptSupported, false, 'the second tab must exercise PostMessage');
  await mockTunnel(pageB, 'tab-b');
  const tabCode = `readLines(${rQuote(`${fixtureOrigin}/tab`)}, warn = FALSE)[1L]`;
  const [tabA, tabB] = await Promise.all([
    pageA.evaluate(code => webRStudio.engine.webR.evalRString(code), tabCode),
    pageB.evaluate(code => webRStudio.engine.webR.evalRString(code), tabCode)
  ]);
  assert.deepEqual([tabA, tabB], ['tab-a', 'tab-b'], 'simultaneous tabs must keep their own transport');
  const sumB = await pageB.evaluate(code => webRStudio.engine.webR.evalRNumber(code),
    `sum(read.csv(${rQuote(`${fixtureOrigin}/data.csv`)})$value)`);
  assert.equal(sumB, 40);
  console.log('Simultaneous tabs passed, including a real PostMessage webR session.');

  const restarted = await pageA.evaluate(() => webRStudio.restartRuntime(false));
  assert.equal(restarted, true);
  await waitForRuntime(pageA, 'Restarted tab A');
  const sumAfterRestart = await pageA.evaluate(code => webRStudio.engine.webR.evalRNumber(code),
    `sum(read.csv(${rQuote(`${fixtureOrigin}/data.csv`)})$value)`);
  assert.equal(sumAfterRestart, 40, 'a replacement R worker must receive the download hook');
  assert.ok(proxyTargets.length >= 10);
  assert.equal(await pageA.evaluate(() => webRStudio.network.worker === null), true, 'this test must not start a real Tailscale login');
  console.log('Runtime restart passed. Browser networking regression checks completed; Tailscale transport was mocked throughout.');
} catch (error) {
  if (diagnostics.length) console.error(diagnostics.slice(-20).join('\n'));
  throw error;
} finally {
  await browser?.close();
  await Promise.all([close(server), close(fixture)]);
}
