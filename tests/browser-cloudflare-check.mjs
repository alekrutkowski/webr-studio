/**
 * Real-browser regression for the Cloudflare Worker download route.
 * Runs real webR, the real app/controller/bridge, and the shipped Worker handler.
 * The Worker runs locally; only its outbound fetch maps public fixture URLs to
 * a local no-CORS origin. This does not deploy or contact a Cloudflare account.
 *
 * PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node tests/browser-cloudflare-check.mjs
 * BROWSER_IGNORE_HTTPS_ERRORS=1 is only for an intercepting development proxy.
 * SCREENSHOT_PATH optionally saves the actual setup panel for visual review.
 */
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createProxyWorker } from '../cloudflare-worker/worker.js';

const require = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? require(resolve(process.env.PLAYWRIGHT_MODULE)) : await import('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = '/cloudflare-regression/';
const publicOrigin = 'https://data.webr-test.example';
const proxyToken = 'fixture-proxy-password-0123456789-abcdef-0123456789';
const wrongToken = 'fixture-wrong-password-0123456789-abcdef-0123456789';
const csv = 'id,value\n1,17\n2,23\n';
const binary = Uint8Array.from([0, 1, 127, 128, 255, 10, 13]);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.md': 'text/markdown; charset=utf-8'
};
const listen = server => new Promise((done, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`));
});
const close = server => new Promise(done => {
  if (!server.listening) return done();
  server.close(done);
  server.closeAllConnections();
});
let fixtureOrigin, appOrigin, workerOrigin;
const upstreamRequests = [];
const fixture = createServer((request, response) => {
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  response.setHeader('Cache-Control', 'no-store');
  const path = new URL(request.url, 'http://fixture.invalid').pathname;
  upstreamRequests.push({ path, headers: { ...request.headers } });
  if (path === '/data.csv') {
    response.setHeader('Content-Type', 'text/csv');
    response.end(csv);
  } else if (path === '/compressed.csv') {
    response.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Encoding': 'gzip' });
    response.end(gzipSync(csv));
  } else if (path === '/bytes.bin') response.end(binary);
  else if (path === '/headers.txt') {
    response.end(`${request.headers.authorization || ''}|${request.headers['x-dataset-key'] || ''}`);
  } else if (path === '/redirect') {
    response.writeHead(302, { Location: `${publicOrigin}/data.csv` });
    response.end();
  } else if (path === '/slow.csv') {
    const timer = setTimeout(() => response.end(csv), 1500);
    response.once('close', () => clearTimeout(timer));
  } else {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('Fixture not found.');
  }
});
const appServer = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://app.invalid').pathname);
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
const workerRequests = [];
const upstreamErrors = [];
const upstreamTargets = [];
const runtimePackageMetadata = /^https:\/\/webr\.r-wasm\.org\/v0\.6\.0\/vfs\/usr\/lib\/R\/library\/[^/]+\.js\.metadata$/;
const proxyWorker = createProxyWorker({
  fetcher: async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    upstreamTargets.push(target.href);
    // A Packages-pane refresh after restart can request a lazy runtime package.
    // Its failure must not leave stdout captured or stop subsequent R commands.
    if (runtimePackageMetadata.test(target.href)) return new Response('Deliberate package fixture failure.', { status: 404 });
    assert.equal(target.origin, publicOrigin, 'The test Worker may fetch only its controlled public fixture name.');
    // Use raw HTTP here: Node fetch decompresses bodies while retaining their
    // Content-Encoding header. Workers' documented stream pass-through keeps
    // compressed bytes intact until the browser consumes the final response.
    return new Promise((done, reject) => {
      let receivedHeaders = false;
      const outgoing = httpRequest(`${fixtureOrigin}${target.pathname}${target.search}`, {
        method: init.method, headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal
      }, incoming => {
        receivedHeaders = true;
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        }
        const empty = [204, 205, 304].includes(incoming.statusCode);
        done(new Response(empty ? null : Readable.toWeb(incoming), {
          status: incoming.statusCode, statusText: incoming.statusMessage, headers
        }));
        if (empty) incoming.resume();
      });
      outgoing.once('error', error => {
        if (!receivedHeaders) upstreamErrors.push({ path: target.pathname, code: error.code, message: error.message, aborted: init.signal.aborted });
        reject(error);
      });
      outgoing.end();
    });
  }
});
const workerServer = createServer(async (request, response) => {
  const controller = new AbortController();
  response.once('close', () => { if (!response.writableEnded) controller.abort(); });
  try {
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = Buffer.concat(parts);
    workerRequests.push({ method: request.method, origin: request.headers.origin });
    const incoming = new Request(`${workerOrigin}${request.url}`, {
      method: request.method, headers: request.headers, signal: controller.signal,
      ...(!['GET', 'HEAD'].includes(request.method) ? { body } : {})
    });
    const result = await proxyWorker.fetch(incoming, {
      PROXY_TOKEN: proxyToken, ALLOWED_ORIGINS: appOrigin
    });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) {
      const stream = Readable.fromWeb(result.body);
      stream.on('error', error => response.destroy(error));
      response.once('close', () => stream.destroy());
      stream.pipe(response);
    } else response.end();
  } catch (error) {
    if (response.destroyed) return;
    response.writeHead(500, { 'Content-Type': 'text/plain' });
    response.end(error.message);
  }
});
const diagnostics = [];
const pageErrors = [];
const tailscaleAssets = [];
let browser;
let page;

async function bounded(promise, label, timeout = 45_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within ${timeout / 1000} seconds.`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function ready(page) {
  await page.waitForFunction(() => globalThis.webRStudio
    && ['ready', 'error'].includes(document.querySelector('#r-status')?.dataset.state), null,
  { timeout: Number(process.env.BROWSER_BOOT_TIMEOUT_MS) || 180_000 });
  const state = await page.evaluate(() => ({ ready: webRStudio.engine.ready, bridge: webRStudio.network.state.bridgeReady }));
  assert.deepEqual(state, { ready: true, bridge: true });
}

async function runR(page, code, path) {
  console.log(`R fixture: ${path || code.slice(0, 90)}`);
  return bounded(page.evaluate(async ({ code, path }) => {
    webRStudio.console.clear();
    const result = await webRStudio.executeCode(code);
    let bytes = null;
    if (path) {
      try { bytes = Array.from(await webRStudio.engine.webR.FS.readFile(path)); }
      catch { /* A failed transfer need not leave a file. */ }
    }
    return { ok: result.ok, error: result.error, bytes,
      outputs: webRStudio.console.transcript.map(({ type, text }) => ({ type, text })) };
  }, { code, path }), `R fixture ${path || code.slice(0, 90)}`);
}

try {
  fixtureOrigin = await listen(fixture);
  appOrigin = await listen(appServer);
  workerOrigin = await listen(workerServer);
  const ignoreHTTPS = /^(1|true)$/i.test(process.env.BROWSER_IGNORE_HTTPS_ERRORS || '');
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', ...(ignoreHTTPS ? ['--ignore-certificate-errors'] : [])]
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, ignoreHTTPSErrors: ignoreHTTPS });
  context.setDefaultTimeout(30_000);
  let directRequests = 0;
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
  page.on('request', request => {
    if (new URL(request.url()).origin === publicOrigin) directRequests += 1;
    if (new URL(request.url()).pathname.includes('/vendor/tailscale-web/')) tailscaleAssets.push(request.url());
  });
  await page.goto(`${appOrigin}${prefix}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await ready(page);
  assert.equal(await page.evaluate(async url => {
    try { await fetch(url); return false; } catch { return true; }
  }, `${fixtureOrigin}/data.csv`), true, 'The data fixture must not permit direct browser CORS reads.');
  assert.equal(directRequests, 0);

  await page.locator('#network-button').click();
  await page.locator('#network-provider').selectOption('cloudflare');
  assert.equal(await page.locator('#network-cloudflare-settings').isVisible(), true);
  assert.equal(await page.locator('#network-tailscale-settings').isVisible(), false);
  assert.equal(await page.locator('#network-proxy-origin').inputValue(), appOrigin);
  await page.locator('#network-proxy-generate-token').click();
  assert.ok((await page.locator('#network-proxy-token').inputValue()).length >= 32);
  await page.locator('#network-proxy-url').fill(`${workerOrigin}/`);
  await page.locator('#network-proxy-token').fill(proxyToken);
  await page.locator('#network-proxy-use').click();
  await page.waitForFunction(() => webRStudio.network.state.phase === 'connected');
  assert.equal(await page.evaluate(() => webRStudio.network.state.mode), 'cloudflare');
  assert.equal(await page.evaluate(() => webRStudio.networkBridge.required), true);
  assert.equal(await page.evaluate(() => Boolean(webRStudio.network.worker)), false);
  assert.ok(workerRequests.some(request => request.method === 'OPTIONS'), `The browser must exercise Worker CORS preflight: ${JSON.stringify(workerRequests)}`);
  await page.locator('#network-test-url').fill(`${publicOrigin}/data.csv`);
  await page.locator('#network-test').click();
  await page.waitForFunction(() => document.querySelector('#network-test-result').dataset.state === 'success');
  assert.match(await page.locator('#network-test-result').innerText(), /HTTP 200, 19 bytes/);
  assert.match(await page.locator('#network-test-result').innerText(), /Cloudflare Worker/i);
  if (process.env.SCREENSHOT_PATH) {
    const path = resolve(process.env.SCREENSHOT_PATH);
    await mkdir(dirname(path), { recursive: true });
    await page.locator('#network-dialog').screenshot({ path });
  }
  await page.locator('#network-dialog button[value="cancel"]').last().click();

  const data = await runR(page,
    `download_status <- download.file(${JSON.stringify(`${publicOrigin}/data.csv`)}, "/project/cloudflare.csv"); print(download_status)`,
    '/project/cloudflare.csv');
  assert.equal(data.ok, true, data.error);
  assert.deepEqual(data.bytes, [...new TextEncoder().encode(csv)]);
  assert.ok(data.outputs.some(item => item.type === 'output' && item.text.includes('trying URL')));
  assert.equal(data.outputs.some(item => item.type === 'error'), false);
  assert.equal(await page.locator('#file-tree .file-row[data-path="cloudflare.csv"]').count(), 1);
  assert.equal(await bounded(page.evaluate(() => webRStudio.engine.webR.evalRNumber('download_status')), 'R return status'), 0);
  const reads = await runR(page,
    `print(sum(read.csv(${JSON.stringify(`${publicOrigin}/data.csv`)})$value)); print(readLines(${JSON.stringify(`${publicOrigin}/data.csv`)}, warn = FALSE))`);
  assert.equal(reads.ok, true, reads.error);
  assert.ok(reads.outputs.some(item => item.text.includes('[1] 40')));
  assert.ok(reads.outputs.some(item => item.text.includes('id,value')));
  const bytes = await runR(page,
    `download.file(${JSON.stringify(`${publicOrigin}/bytes.bin`)}, "/project/cloudflare.bin", mode = "wb")`, '/project/cloudflare.bin');
  assert.equal(bytes.ok, true, bytes.error);
  assert.deepEqual(bytes.bytes, [...binary]);
  const compressed = await runR(page,
    `download.file(${JSON.stringify(`${publicOrigin}/compressed.csv`)}, "/project/cloudflare-compressed.csv")`, '/project/cloudflare-compressed.csv');
  assert.equal(compressed.ok, true, compressed.error);
  assert.deepEqual(compressed.bytes, data.bytes, 'HTTP gzip transfer encoding must decode once without changing the downloaded CSV.');
  const headers = await runR(page,
    `download.file(${JSON.stringify(`${publicOrigin}/headers.txt`)}, "/project/cloudflare-headers.txt", headers = c(Authorization = "Bearer fixture-upstream", "X-Dataset-Key" = "fixture-key"))`,
    '/project/cloudflare-headers.txt');
  assert.equal(headers.ok, true, headers.error);
  assert.equal(new TextDecoder().decode(Uint8Array.from(headers.bytes)), 'Bearer fixture-upstream|fixture-key');
  const redirected = await runR(page,
    `download.file(${JSON.stringify(`${publicOrigin}/redirect`)}, "/project/cloudflare-redirect.csv")`, '/project/cloudflare-redirect.csv');
  assert.equal(redirected.ok, true, redirected.error);
  assert.deepEqual(redirected.bytes, data.bytes);
  const failed = await runR(page,
    `download.file(${JSON.stringify(`${publicOrigin}/missing.csv`)}, "/project/cloudflare-missing.csv")`, '/project/cloudflare-missing.csv');
  assert.equal(failed.ok, false);
  assert.ok(failed.outputs.some(item => item.type === 'error'));
  assert.equal(directRequests, 0, 'Proxy requests must not fall back to direct browser downloads.');
  assert.equal(upstreamRequests.some(request => 'x-webr-proxy-token' in request.headers || 'cookie' in request.headers), false);
  console.log('Worker route passed: actual preflight, handshake, panel test, real R reads, exact binary bytes, redirects, headers, genuine HTTP errors, and Explorer visibility.');

  assert.equal(await bounded(page.evaluate(() => webRStudio.restartRuntime()), 'R restart', 120_000), true);
  assert.equal(await page.evaluate(() => webRStudio.network.state.mode), 'cloudflare');
  assert.ok(upstreamTargets.some(url => runtimePackageMetadata.test(url)), 'The selected proxy must handle the lazy package request during restart.');
  const restartExpression = await runR(page, 'print(1 + 1)');
  assert.equal(restartExpression.ok, true, restartExpression.error);
  const restarted = await runR(page, `print(sum(read.csv(${JSON.stringify(`${publicOrigin}/data.csv`)})$value))`);
  assert.equal(restarted.ok, true, restarted.error);
  assert.ok(restarted.outputs.some(item => item.text.includes('[1] 40')));
  await page.locator('#network-button').click();
  await page.locator('#network-proxy-token').fill(wrongToken);
  await page.locator('#network-proxy-use').click();
  await page.waitForFunction(() => webRStudio.network.state.phase === 'error');
  assert.equal(await page.evaluate(() => webRStudio.network.state.mode), 'cloudflare');
  const denied = await page.evaluate(async url => {
    try { await webRStudio.network.download({ url }); return false; } catch { return true; }
  }, `${publicOrigin}/data.csv`);
  assert.equal(denied, true);
  assert.equal(directRequests, 0, 'Rejected proxy authentication must not change the route or fetch directly.');
  await page.locator('#network-proxy-token').fill(proxyToken);
  await page.locator('#network-proxy-use').click();
  await page.waitForFunction(() => webRStudio.network.state.phase === 'connected');

  await page.evaluate(url => {
    globalThis.__slowProxy = webRStudio.network.download({ url }).then(() => 'resolved', () => 'rejected');
  }, `${publicOrigin}/slow.csv`);
  await page.locator('#network-provider').selectOption('browser');
  assert.equal(await bounded(page.evaluate(() => __slowProxy), 'Route-switch cancellation', 10_000), 'rejected');
  assert.equal(await page.evaluate(() => webRStudio.networkBridge.required), false);
  assert.equal(await page.evaluate(() => webRStudio.network.state.mode), 'browser');
  assert.equal(directRequests, 0);
  const exposed = await page.evaluate(async () => ({
    state: JSON.stringify(webRStudio.network.state),
    local: JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]))),
    session: JSON.stringify(Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)]))),
    workspace: JSON.stringify(await webRStudio.serializeWorkspace({ includeCheckpoint: false }))
  }));
  for (const [name, value] of Object.entries(exposed)) {
    assert.equal(value.includes(proxyToken) || value.includes(wrongToken), false, `${name} must not expose or persist the proxy password.`);
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
  await ready(page);
  assert.equal(await page.evaluate(() => webRStudio.network.state.mode), 'browser');
  assert.equal(await page.locator('#network-proxy-token').inputValue(), '');
  assert.deepEqual(tailscaleAssets, [], 'The Worker alternative must not load Tailscale assets.');
  assert.deepEqual(pageErrors, []);
  console.log('Worker route passed: R restart, rejected authentication, route-switch cancellation, no direct fallback, no stored token, and reload reset.');
} catch (error) {
  if (page && !page.isClosed()) {
    try {
      console.error(await bounded(page.evaluate(() => ({
        network: webRStudio?.network?.state,
        pending: webRStudio?.networkBridge?.pending?.size,
        engine: { running: webRStudio?.engine?.running, phase: webRStudio?.engine?.executionPhase,
          operation: webRStudio?.engine?.replOperation && { ...webRStudio.engine.replOperation, outputs: undefined, outputQueue: undefined, resolve: undefined, reject: undefined } },
        console: webRStudio?.console?.transcript?.slice(-8)
      })), 'Failure diagnostic', 2000));
    } catch { /* Preserve the original failure even if the page is unresponsive. */ }
  }
  console.error('Worker fixture requests:', workerRequests);
  console.error('Upstream fixture paths:', upstreamRequests.map(request => request.path));
  console.error('Upstream fixture errors:', upstreamErrors);
  console.error('Worker target URLs:', upstreamTargets);
  if (diagnostics.length) console.error(diagnostics.slice(-12).join('\n'));
  if (pageErrors.length) console.error(pageErrors.join('\n'));
  throw error;
} finally {
  await browser?.close();
  await Promise.all([close(appServer), close(workerServer), close(fixture)]);
}
