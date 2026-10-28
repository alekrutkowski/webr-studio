/**
 * Optional real-browser connection diagnostic regression check. Requires
 * Playwright, Chromium, and access to webR/Ace's existing CDNs. The app,
 * controller, and UI are real; the Tailscale worker and clipboard are test
 * fixtures. No tailnet login or real diagnostic probes are performed.
 *
 * node tests/browser-network-diagnostic-check.mjs
 * PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node tests/browser-network-diagnostic-check.mjs
 * BROWSER_IGNORE_HTTPS_ERRORS=1 is for an intercepting test proxy only.
 * SCREENSHOT_PATH=/path/to/diagnostic.png optionally saves the mixed report UI.
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
const prefix = '/network-diagnostic-regression/';
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
    bridgeError: webRStudio.network.state.bridgeError
  }));
  assert.equal(runtime.ready, true, JSON.stringify(runtime));
  assert.equal(runtime.bridge, true, JSON.stringify(runtime));
  console.log(`webR ${runtime.version} and the download bridge are ready.`);
}

async function installFakeWorker(page) {
  await page.evaluate(() => {
    const fixture = { workers: [], requests: [], copied: '' };
    const client = webRStudio.network;
    class FakeWorker extends EventTarget {
      constructor() {
        super();
        this.number = fixture.workers.length;
        this.prefs = { exitNodeId: 'fixture-exit', dnsMode: 'exit-node' };
        this.nodes = [
          { id: 'fixture-exit', hostName: 'Test exit node', tailscaleIP: '100.64.0.1', os: 'linux', online: true, expired: false },
          { id: 'other-exit', hostName: 'Other test exit', tailscaleIP: '100.64.0.3', os: 'windows', online: true, expired: false }
        ];
        this.holdDiagnose = false;
        this.held = [];
        this.reportKind = 'mixed';
        this.terminated = false;
        fixture.workers.push(this);
      }
      snapshot() { return { ...this.prefs, ip: '100.64.0.2', exitNodes: structuredClone(this.nodes) }; }
      report() {
        const node = this.nodes.find(item => item.id === this.prefs.exitNodeId);
        const ids = ['exit', 'route', 'peer', 'peerapi', 'tcp', 'tls', 'http'];
        const statuses = node.expired ? ['fail', 'skip', 'skip', 'skip', 'skip', 'skip', 'skip']
          : this.reportKind === 'success' ? ids.map(() => 'pass')
            : ['pass', 'pass', 'pass', 'fail', 'fail', 'skip', 'skip'];
        const messages = {
          exit: node.expired ? 'The selected exit has an expired device key.' : 'The selected exit is available for checks.',
          route: 'The selected route includes 1.1.1.1.',
          peer: 'The selected exit responded to an encrypted connection check.',
          peerapi: this.reportKind === 'success' ? 'The exit node service responded.' : 'The selected exit node service did not respond.',
          tcp: this.reportKind === 'success' ? 'Connected to 1.1.1.1:443.' : 'TCP to 1.1.1.1:443 timed out.',
          tls: 'The certificate for 1.1.1.1 was verified.',
          http: 'HTTPS to 1.1.1.1 returned HTTP 200.'
        };
        return {
          exitNodeId: node.id, exitNodeName: node.hostName, exitNodeIP: node.tailscaleIP,
          exitNodeOS: node.os, exitNodeOnline: node.online, exitNodeExpired: node.expired,
          checks: ids.map((id, index) => ({
            id, label: id, status: statuses[index], elapsedMs: statuses[index] === 'skip' ? 0 : 12 + index,
            message: statuses[index] === 'skip' ? 'Skipped because an earlier required check did not pass.' : messages[id]
          })),
          traceBody: 'DO_NOT_COPY_TRACE_BODY', token: 'DO_NOT_COPY_TOKEN', logs: ['DO_NOT_COPY_LOGS']
        };
      }
      reply(id, result, error) {
        this.dispatchEvent(new MessageEvent('message', { data: { id, result, error } }));
      }
      release() {
        // Deliver even after termination to exercise stale-worker protection.
        for (const held of this.held.splice(0)) this.reply(held.id, held.report);
      }
      postMessage(request) {
        fixture.requests.push({ worker: this.number, ...request });
        queueMicrotask(() => {
          if (this.terminated) return;
          const { id, method, args } = request;
          if (method === 'connect' || method === 'status') this.reply(id, this.snapshot());
          else if (method === 'setDNSMode') {
            this.prefs.dnsMode = args.mode;
            this.reply(id, this.snapshot());
          } else if (method === 'setExitNode') {
            this.prefs.exitNodeId = args.id;
            if (!args.id) this.prefs.dnsMode = 'exit-node';
            this.reply(id, this.snapshot());
          } else if (method === 'diagnose') {
            const report = this.report();
            if (this.holdDiagnose) this.held.push({ id, report });
            else this.reply(id, report);
          } else if (method === 'download') {
            this.reply(id, { status: 200, statusText: 'OK', body: new Uint8Array([1, 2, 3]).buffer });
          } else this.reply(id, null, `Unexpected mock worker method: ${method}`);
        });
      }
      terminate() { this.terminated = true; }
    }
    client.refreshInterval = 0;
    client.workerFactory = () => new FakeWorker();
    // Capture the actual Copy report action without depending on an operating
    // system clipboard or browser permission prompt in headless CI.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async text => { fixture.copied = text; } }
    });
    globalThis.__networkDiagnosticFixture = fixture;
  });
}

const diagnosticCalls = page => page.evaluate(() => __networkDiagnosticFixture.requests.filter(request => request.method === 'diagnose').length);
const waitForIdle = page => page.waitForFunction(() => !document.querySelector('#network-diagnose').disabled);
const waitForReport = page => page.waitForFunction(() => (
  !document.querySelector('#network-diagnostics').hidden
    && !document.querySelector('#network-copy-diagnostic').hidden
    && !document.querySelector('#network-diagnose').disabled
));

async function holdDiagnostic(page) {
  await page.evaluate(() => { webRStudio.network.worker.holdDiagnose = true; });
  await page.locator('#network-diagnose').click();
  await page.waitForFunction(() => webRStudio.network.worker.held.length === 1);
}

async function releaseStaleDiagnostic(page) {
  await page.evaluate(() => webRStudio.network.worker.release());
  await page.waitForFunction(() => webRStudio.network.requests.size === 0);
  assert.equal(await page.locator('#network-diagnostics').isHidden(), true);
  assert.equal(await page.locator('#network-copy-diagnostic').isHidden(), true);
}

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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: ignoreTestCertificates });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => diagnostics.push(`${request.url()} ${request.failure()?.errorText || ''}`));
  page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (['1.1.1.1', 'public.example.org'].includes(url.hostname) || url.pathname.includes('/vendor/tailscale-web/')) {
      unexpectedTransportRequests.push(url.href);
    }
  });
  await page.goto(`${origin}${prefix}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitForRuntime(page);
  await installFakeWorker(page);
  await page.locator('#network-button').click();
  assert.equal(await page.locator('#network-diagnose').isDisabled(), true);
  await page.locator('#network-provider').selectOption('tailscale');
  await page.locator('#network-connect').click();
  await page.waitForFunction(() => webRStudio.network.state.phase === 'connected');
  await page.locator('#network-exit-node').selectOption('');
  await page.waitForFunction(() => webRStudio.network.state.exitNodeId === '');
  assert.equal(await page.locator('#network-diagnose').isDisabled(), true);
  await page.locator('#network-exit-node').selectOption('fixture-exit');
  await waitForIdle(page);
  await page.locator('#network-dns-mode').selectOption('cloudflare');
  await page.waitForFunction(() => webRStudio.network.state.dnsMode === 'cloudflare');
  await page.locator('#network-refresh').click();
  await waitForIdle(page);
  await page.locator('#network-test-url').fill('https://public.example.org/data.csv');
  await page.locator('#network-test').click();
  await page.waitForFunction(() => document.querySelector('#network-test-result').dataset.state === 'success');
  assert.equal(await diagnosticCalls(page), 0, 'Opening, connecting, changing settings, refreshing, and testing must not start diagnostics.');
  console.log('No automatic diagnostics; the action requires a connected session and selected exit.');

  await holdDiagnostic(page);
  assert.equal(await diagnosticCalls(page), 1);
  assert.equal(await page.locator('#network-diagnostics').getAttribute('aria-busy'), 'true');
  for (const selector of ['#network-diagnose', '#network-test', '#network-exit-node', '#network-dns-mode', '#network-refresh']) {
    assert.equal(await page.locator(selector).isDisabled(), true, `${selector} must be disabled during a diagnostic.`);
  }
  assert.equal(await page.locator('#network-disconnect').isEnabled(), true);
  await page.evaluate(() => webRStudio.network.worker.release());
  await waitForReport(page);
  assert.equal(await page.locator('#network-diagnostics').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#network-diagnostic-checks > li').count(), 7);
  assert.equal(await page.locator('#network-diagnostic-checks > [data-status="pass"]').count(), 3);
  assert.equal(await page.locator('#network-diagnostic-checks > [data-status="fail"]').count(), 2);
  assert.equal(await page.locator('#network-diagnostic-checks > [data-status="skip"]').count(), 2);
  assert.match(await page.locator('#network-diagnostic-status').innerText(), /selected exit and 1\.1\.1\.1: 3 passed, 2 failed, 2 skipped/);
  assert.match(await page.locator('#network-diagnostic-exit').innerText(), /OS: linux.*Advertised online: yes.*Key expired: no/);
  assert.equal(await page.locator('#network-status-title').innerText(), 'Tailscale ready to test');
  if (process.env.SCREENSHOT_PATH) {
    const screenshotPath = resolve(process.env.SCREENSHOT_PATH);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await page.locator('#network-diagnostics').scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Diagnostic screenshot saved to ${screenshotPath}`);
  }
  await page.locator('#network-copy-diagnostic').click();
  const copied = await page.evaluate(() => __networkDiagnosticFixture.copied);
  assert.match(copied, /App version: \d+\.\d+\.\d+/);
  assert.match(copied, /Completed at: \d{4}-\d{2}-\d{2}T[\d:.]+Z/);
  assert.match(copied, /Operating system: linux/);
  assert.match(copied, /DNS setting: Cloudflare through exit node \(unchanged\)/);
  assert.match(copied, /FAILED: TCP to 1\.1\.1\.1:443/);
  assert.match(copied, /SKIPPED: TLS handshake and certificate/);
  assert.doesNotMatch(copied, /DO_NOT_COPY/);
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.locator('#network-diagnostics').evaluate(element => element.scrollWidth > element.clientWidth);
  assert.equal(overflow, false, 'Diagnostic rows must wrap inside the narrow dialog.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log('Passed, failed, and skipped stages render clearly; copied reports contain scoped metadata without trace bodies, tokens, or logs.');

  await page.evaluate(() => {
    webRStudio.network.worker.holdDiagnose = false;
    webRStudio.network.worker.reportKind = 'success';
  });
  await page.locator('#network-diagnose').click();
  await waitForReport(page);
  assert.match(await page.locator('#network-diagnostic-status').innerText(), /1\.1\.1\.1: 7 passed, 0 failed, 0 skipped/);
  assert.match(await page.locator('[data-check="http"] p').innerText(), /HTTPS to 1\.1\.1\.1 returned HTTP 200/);
  assert.deepEqual(await page.evaluate(() => ({
    exit: webRStudio.network.state.exitNodeId, dns: webRStudio.network.state.dnsMode, mode: webRStudio.network.state.mode
  })), { exit: 'fixture-exit', dns: 'cloudflare', mode: 'tailscale' });
  await page.locator('#network-dns-mode').selectOption('exit-node');
  await page.waitForFunction(() => webRStudio.network.state.dnsMode === 'exit-node');
  assert.equal(await page.locator('#network-diagnostics').isHidden(), true, 'A DNS change must invalidate a visible report.');

  await holdDiagnostic(page);
  await page.evaluate(() => webRStudio.network.setDNSMode('cloudflare'));
  await releaseStaleDiagnostic(page);
  await waitForIdle(page);
  await holdDiagnostic(page);
  await page.evaluate(() => webRStudio.network.setExitNode('other-exit'));
  await releaseStaleDiagnostic(page);
  await waitForIdle(page);
  await holdDiagnostic(page);
  await page.evaluate(() => webRStudio.network.update({ mode: 'browser' }));
  await releaseStaleDiagnostic(page);
  assert.equal(await page.locator('#network-diagnose').isDisabled(), true);
  await page.evaluate(() => webRStudio.network.update({ mode: 'tailscale' }));
  await waitForIdle(page);
  console.log('Changing DNS, exit node, or transport mode discards an in-flight diagnostic and prevents stale report display.');

  await holdDiagnostic(page);
  const oldWorker = await page.evaluate(() => webRStudio.network.worker.number);
  await page.locator('#network-disconnect').click();
  await page.waitForFunction(() => webRStudio.network.state.phase === 'disconnected');
  assert.equal(await page.locator('#network-diagnostics').isHidden(), true);
  await page.locator('#network-provider').selectOption('tailscale');
  await page.locator('#network-connect').click();
  await page.waitForFunction(() => webRStudio.network.state.phase === 'connected');
  await page.evaluate(number => __networkDiagnosticFixture.workers[number].release(), oldWorker);
  await waitForIdle(page);
  assert.equal(await page.locator('#network-diagnostics').isHidden(), true);
  assert.equal(await page.evaluate(number => __networkDiagnosticFixture.workers[number].terminated, oldWorker), true);

  await page.evaluate(async () => {
    const node = webRStudio.network.worker.nodes[0];
    node.online = false;
    node.expired = true;
    await webRStudio.network.refresh();
  });
  assert.equal(await page.locator('#network-status').getAttribute('data-state'), 'attention');
  assert.match(await page.locator('#network-status-message').innerText(), /expired device key/);
  assert.doesNotMatch(await page.locator('#network-status-message').innerText(), /is offline/);
  assert.match(await page.locator('#network-exit-node option[value="fixture-exit"]').innerText(), /\(key expired\)/);
  assert.equal(await page.locator('#network-exit-node option[value="fixture-exit"]').isDisabled(), true);
  assert.equal(await page.locator('#network-diagnose').isEnabled(), true, 'A selected expired exit must still allow a local diagnostic report.');
  await page.locator('#network-diagnose').click();
  await waitForReport(page);
  assert.match(await page.locator('#network-diagnostic-exit').innerText(), /Key expired: yes/);
  assert.match(await page.locator('#network-diagnostic-status').innerText(), /0 passed, 1 failed, 6 skipped/);
  assert.deepEqual(unexpectedTransportRequests, [], 'The fake worker must not load Tailscale or issue any real probes.');
  assert.deepEqual(pageErrors, []);
  console.log('Reconnect cancellation and expired exit reporting passed. Browser diagnostic checks completed with the transport mocked throughout.');
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
