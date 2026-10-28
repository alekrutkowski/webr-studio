/**
 * Optional real-browser DNS recovery regression check. Requires Playwright,
 * Chromium, and internet access for webR/Ace's existing CDNs. The actual app,
 * controller, and UI run unchanged; only the Tailscale worker is a test fake.
 * No tailnet authentication or requests to the tested data URLs are made.
 *
 * node tests/browser-dns-recovery-check.mjs
 * PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node tests/browser-dns-recovery-check.mjs
 * BROWSER_IGNORE_HTTPS_ERRORS=1 is for an intercepting test proxy only.
 * SCREENSHOT_PATH=/path/to/recovery.png optionally saves the initial error UI.
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
const prefix = '/dns-recovery-regression/';
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json'
};
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://studio.invalid').pathname);
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
const ignoreTestCertificates = /^(1|true)$/i.test(process.env.BROWSER_IGNORE_HTTPS_ERRORS || '');
const diagnostics = [];
const pageErrors = [];
const unexpectedTransportRequests = [];
let browser;

async function waitForRuntime(page) {
  try {
    await page.waitForFunction(() => (
      globalThis.webRStudio && ['ready', 'error'].includes(document.querySelector('#r-status')?.dataset.state)
    ), null, { timeout: Number(process.env.BROWSER_BOOT_TIMEOUT_MS) || 180_000 });
  } catch (error) {
    console.error('Startup state:', await page.evaluate(() => ({
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
    isolated: crossOriginIsolated
  }));
  assert.equal(runtime.ready, true, JSON.stringify(runtime));
  assert.equal(runtime.bridge, true, JSON.stringify(runtime));
  console.log(`webR ${runtime.version} and the download bridge are ready.`);
}

async function installFakeWorker(page) {
  await page.evaluate(() => {
    const client = webRStudio.network;
    const fixture = { workers: [], events: [] };
    class FakeWorker extends EventTarget {
      constructor() {
        super();
        this.number = fixture.workers.length;
        this.prefs = { exitNodeId: 'fixture-exit', dnsMode: 'exit-node' };
        this.requests = [];
        this.heldDNS = [];
        this.holdDNS = false;
        this.mismatchDNS = false;
        this.terminated = false;
        fixture.workers.push(this);
      }
      snapshot() {
        return {
          ...this.prefs, ip: '100.64.0.2',
          exitNodes: [{ id: 'fixture-exit', hostName: 'Test exit node', tailscaleIP: '100.64.0.1', online: true }]
        };
      }
      reply(id, result, error) {
        this.dispatchEvent(new MessageEvent('message', { data: { id, result, error } }));
      }
      finishDNS(request) {
        if (!this.mismatchDNS) this.prefs.dnsMode = request.args.mode;
        fixture.events.push({ kind: 'dns-confirmation', worker: this.number, mode: this.prefs.dnsMode });
        this.reply(request.id, this.snapshot());
      }
      releaseDNS() {
        // A deliberate late reply also exercises the controller's old-worker
        // guard after termination. A real terminated worker cannot send it.
        for (const request of this.heldDNS.splice(0)) this.finishDNS(request);
      }
      postMessage(request) {
        const record = {
          kind: 'request', worker: this.number, ...request,
          runtimeDNSMode: this.prefs.dnsMode, controllerDNSMode: client.state.dnsMode
        };
        this.requests.push(record);
        fixture.events.push(record);
        queueMicrotask(() => {
          if (this.terminated) return;
          const { id, method, args } = request;
          if (method === 'connect' || method === 'status') this.reply(id, this.snapshot());
          else if (method === 'setDNSMode') {
            if (this.holdDNS) this.heldDNS.push(request);
            else this.finishDNS(request);
          } else if (method === 'setExitNode') {
            this.prefs.exitNodeId = args.id;
            if (!args.id) this.prefs.dnsMode = 'exit-node';
            this.reply(id, this.snapshot());
          } else if (method === 'download') {
            if (this.prefs.dnsMode === 'exit-node') {
              this.reply(id, null, '[EXIT_NODE_DNS_TIMEOUT] The DNS request through the exit node timed out. For public websites, choose "Cloudflare through exit node" in Networking. Original: context deadline exceeded.');
            } else {
              this.reply(id, { status: 200, statusText: 'OK', body: new Uint8Array([1, 2, 3]).buffer });
            }
          } else this.reply(id, null, `Unexpected mock worker method: ${method}`);
        });
      }
      terminate() { this.terminated = true; }
    }
    client.refreshInterval = 0;
    client.workerFactory = () => new FakeWorker();
    globalThis.__dnsRecoveryFixture = fixture;
  });
}

async function waitForTestIdle(page) {
  await page.waitForFunction(() => !document.querySelector('#network-test').disabled);
}

async function failTest(page, url) {
  await page.locator('#network-test-url').fill(url);
  await page.locator('#network-test').click();
  await page.waitForFunction(() => (
    document.querySelector('#network-test-result').dataset.state === 'error'
      && !document.querySelector('#network-dns-recovery').hidden
      && !document.querySelector('#network-test').disabled
  ));
}

async function resetDNS(page) {
  await page.evaluate(() => {
    const worker = webRStudio.network.worker;
    worker.holdDNS = false;
    worker.mismatchDNS = false;
  });
  await page.locator('#network-dns-mode').selectOption('exit-node');
  await page.waitForFunction(() => webRStudio.network.state.dnsMode === 'exit-node');
  await waitForTestIdle(page);
}

const downloads = page => page.evaluate(() => __dnsRecoveryFixture.events.filter(event => event.method === 'download'));

try {
  const origin = await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen(`http://127.0.0.1:${server.address().port}`));
  });
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...(ignoreTestCertificates ? ['--ignore-certificate-errors'] : [])]
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: ignoreTestCertificates
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => diagnostics.push(`${request.url()} ${request.failure()?.errorText || ''}`));
  page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.hostname === 'public.example.org' || url.pathname.includes('/vendor/tailscale-web/')) {
      unexpectedTransportRequests.push(url.href);
    }
  });
  await page.goto(`${origin}${prefix}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitForRuntime(page);
  await installFakeWorker(page);
  await page.locator('#network-button').click();
  await page.locator('#network-provider').selectOption('tailscale');
  await page.locator('#network-connect').click();
  await page.waitForFunction(() => webRStudio.network.state.phase === 'connected');

  const firstURL = 'https://public.example.org/data.csv?fixture=one';
  await failTest(page, firstURL);
  assert.match(await page.locator('#network-test-result').innerText(), /DNS setting: Exit node DNS/);
  assert.doesNotMatch(await page.locator('#network-test-result').innerText(), /\[EXIT_NODE_DNS_TIMEOUT\]/);
  assert.equal(await page.locator('#network-retry-dns').isVisible(), true);
  assert.equal((await downloads(page)).length, 1, 'A DNS timeout must not retry automatically.');
  assert.equal(await page.evaluate(() => webRStudio.network.state.dnsMode), 'exit-node');
  assert.equal(await page.evaluate(() => __dnsRecoveryFixture.events.filter(event => event.method === 'setDNSMode').length), 0);
  if (process.env.SCREENSHOT_PATH) {
    const screenshotPath = resolve(process.env.SCREENSHOT_PATH);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Recovery screenshot saved to ${screenshotPath}`);
  }
  await page.locator('#network-retry-dns').click();
  await page.waitForFunction(() => document.querySelector('#network-test-result').dataset.state === 'success');
  await waitForTestIdle(page);
  const firstDownloads = await downloads(page);
  assert.deepEqual(firstDownloads.map(request => request.args.url), [firstURL, firstURL]);
  assert.equal(firstDownloads[1].runtimeDNSMode, 'cloudflare');
  assert.equal(firstDownloads[1].controllerDNSMode, 'cloudflare', 'The controller must confirm the new mode before retrying.');
  const trace = await page.evaluate(() => __dnsRecoveryFixture.events);
  const confirmation = trace.findIndex(event => event.kind === 'dns-confirmation' && event.mode === 'cloudflare');
  const retried = trace.findIndex(event => event.method === 'download' && event.runtimeDNSMode === 'cloudflare');
  assert.ok(confirmation >= 0 && retried > confirmation);
  assert.match(await page.locator('#network-test-result').innerText(), /HTTP 200, 3 bytes.*DNS setting: Cloudflare through exit node/);
  assert.equal(await page.locator('#network-dns-recovery').isHidden(), true);
  console.log('Explicit recovery passed: confirmed DNS change precedes one retry of the exact failed URL.');

  await resetDNS(page);
  await failTest(page, 'https://public.example.org/held.csv');
  const beforeEditedRetry = (await downloads(page)).length;
  await page.evaluate(() => { webRStudio.network.worker.holdDNS = true; });
  await page.locator('#network-retry-dns').click();
  await page.waitForFunction(() => webRStudio.network.worker.heldDNS.length === 1);
  assert.equal(await page.locator('#network-test').isDisabled(), true);
  await page.locator('#network-test-url').fill('https://public.example.org/changed.csv');
  await page.evaluate(() => webRStudio.network.worker.releaseDNS());
  await page.waitForFunction(() => webRStudio.network.state.dnsMode === 'cloudflare');
  await waitForTestIdle(page);
  assert.equal((await downloads(page)).length, beforeEditedRetry, 'Editing the URL while the DNS RPC is held must cancel the retry.');
  assert.equal(await page.locator('#network-dns-recovery').isHidden(), true);
  assert.equal(await page.locator('#network-test-result').isHidden(), true);
  console.log('Input cancellation passed: the confirmed DNS choice remains, but neither data URL is retried.');

  await resetDNS(page);
  await failTest(page, 'https://public.example.org/unconfirmed.csv');
  const beforeMismatch = (await downloads(page)).length;
  await page.evaluate(() => { webRStudio.network.worker.mismatchDNS = true; });
  await page.locator('#network-retry-dns').click();
  await page.waitForFunction(() => document.querySelector('#network-action-error').textContent.includes('did not confirm'));
  await waitForTestIdle(page);
  assert.equal((await downloads(page)).length, beforeMismatch, 'An unconfirmed DNS change must never trigger a retry.');
  assert.equal(await page.locator('#network-action-error').isVisible(), true);
  assert.match(await page.locator('#network-test-result').innerText(), /did not confirm the requested DNS mode/);
  assert.equal(await page.locator('#network-dns-mode').inputValue(), 'exit-node');
  assert.equal(await page.locator('#network-dns-recovery').isHidden(), true);
  console.log('Confirmation mismatch passed: the previous DNS choice remains and the error is visible.');

  await page.locator('#network-disconnect').click();
  await page.waitForFunction(() => webRStudio.network.state.phase === 'disconnected');
  await page.locator('#network-provider').selectOption('tailscale');
  await page.locator('#network-connect').click();
  await page.waitForFunction(() => webRStudio.network.state.phase === 'connected');
  await failTest(page, 'https://public.example.org/old-session.csv');
  const beforeReconnect = (await downloads(page)).length;
  const oldWorkerNumber = await page.evaluate(() => {
    webRStudio.network.worker.holdDNS = true;
    return webRStudio.network.worker.number;
  });
  await page.locator('#network-retry-dns').click();
  await page.waitForFunction(() => webRStudio.network.worker.heldDNS.length === 1);
  await page.locator('#network-disconnect').click();
  await page.waitForFunction(() => webRStudio.network.state.phase === 'disconnected');
  await page.locator('#network-provider').selectOption('tailscale');
  await page.locator('#network-connect').click();
  await page.waitForFunction(() => webRStudio.network.state.phase === 'connected');
  await page.evaluate(number => __dnsRecoveryFixture.workers[number].releaseDNS(), oldWorkerNumber);
  await waitForTestIdle(page);
  assert.equal((await downloads(page)).length, beforeReconnect, 'A response from a closed session must not resume its old retry.');
  assert.equal(await page.evaluate(() => webRStudio.network.state.dnsMode), 'exit-node');
  assert.equal(await page.locator('#network-dns-recovery').isHidden(), true);
  assert.equal(await page.evaluate(number => __dnsRecoveryFixture.workers[number].terminated, oldWorkerNumber), true);
  await page.locator('#network-disconnect').click();
  await page.waitForFunction(() => webRStudio.network.state.phase === 'disconnected');
  assert.equal(await page.locator('#network-dns-mode').isDisabled(), true);
  assert.equal(await page.locator('#network-dns-mode').inputValue(), 'exit-node');
  assert.deepEqual(unexpectedTransportRequests, [], 'This regression check must not load Tailscale or contact the fixture data URLs.');
  assert.deepEqual(pageErrors, []);
  console.log('Disconnect/reconnect cancellation passed. Browser DNS recovery checks completed with the worker transport mocked throughout.');
} catch (error) {
  if (diagnostics.length) console.error(diagnostics.slice(-20).join('\n'));
  if (pageErrors.length) console.error(pageErrors.join('\n'));
  throw error;
} finally {
  await browser?.close();
  if (server.listening) {
    await new Promise(resolveClose => {
      server.close(resolveClose);
      server.closeAllConnections();
    });
  }
}
