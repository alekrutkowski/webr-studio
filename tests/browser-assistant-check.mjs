/**
 * Actual-app browser regression for the local assistant, Ace, and real webR.
 * By default only the external WebLLM module and GPU capability probe are
 * substituted. The production assistant UI, worker protocol, R inspection,
 * editor actions, and R execution all run unchanged.
 *
 * PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium \
 *   node tests/browser-assistant-check.mjs
 *
 * ASSISTANT_REAL_WEBGPU=1 opts into downloading the actual 0.5B model and a
 * genuine WebGPU load/generation smoke test. It needs a working browser GPU,
 * network access to model hosts, and enough disk/GPU memory. No code generated
 * by the real model is executed. BROWSER_HEADLESS=0 uses a visible browser.
 * BROWSER_IGNORE_HTTPS_ERRORS=1 is only for an intercepting development proxy.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEBLLM_MODULE_URL } from '../js/assistant-client.js';

const require = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? require(resolve(process.env.PLAYWRIGHT_MODULE)) : await import('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const realGPU = /^(1|true)$/i.test(process.env.ASSISTANT_REAL_WEBGPU || '');
const ignoreHTTPS = /^(1|true)$/i.test(process.env.BROWSER_IGNORE_HTTPS_ERRORS || '');
const bootTimeout = Number(process.env.BROWSER_BOOT_TIMEOUT_MS) || 180_000;
const stepTimeout = Number(process.env.BROWSER_STEP_TIMEOUT_MS) || 30_000;
const modelTimeout = Number(process.env.ASSISTANT_MODEL_TIMEOUT_MS) || 600_000;
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json'
};
let workerRequests = 0;
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  try {
    const relative = decodeURIComponent(new URL(request.url, 'http://fixture.invalid').pathname).replace(/^\//, '') || 'index.html';
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep)) throw new Error('Invalid fixture path.');
    response.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    let body = await readFile(file);
    if (relative === 'js/assistant-worker.js') {
      workerRequests += 1;
      if (!realGPU) body = Buffer.concat([
        Buffer.from('/* Test-only WebGPU capability stub; inference module is mocked. */\nObject.defineProperty(self.navigator, "gpu", { configurable: true, value: {} });\n'),
        body
      ]);
    }
    response.end(body);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 400);
    response.end(error.message);
  }
});

const deterministicModule = `
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export class MLCEngine {
  constructor(options) {
    this.options = options;
    this.stopped = false;
    this.chat = {completions: {create: args => this.generate(args)}};
  }
  async reload(model, options) {
    if (options.context_window_size !== 2048) throw new Error('Test expected a bounded model context.');
    this.options.initProgressCallback({progress: 0.5, text: 'Deterministic test model'});
    await wait(30);
    this.options.initProgressCallback({progress: 1, text: 'Test model ready'});
  }
  async resetChat() { this.stopped = false; }
  async interruptGenerate() { this.stopped = true; }
  async *generate(args) {
    const input = args.messages.at(-1).content;
    const suggestion = input.includes('Suggest a short R continuation');
    const code = suggestion ? '# local suggestion' : 'ai_ran <- sum(ai_fixture$x)\\nai_ran';
    yield {choices: [{delta: {content: suggestion ? '' : 'Proposed R code:\\n'}}]};
    await wait(input.includes('DELAY_RESPONSE') ? 700 : 35);
    if (this.stopped) return;
    yield {choices: [{delta: {content: '\\x60\\x60\\x60r\\n' + code + '\\n\\x60\\x60\\x60'}}]};
    yield {choices: [], usage: {prompt_tokens: 100, completion_tokens: 20}};
  }
}
`;

let browser;
let page;
let stage = 'startup';
const errors = [];
const diagnostics = [];
const dependencies = [];
const weights = [];

async function idleR() {
  await page.waitForFunction(() => globalThis.webRStudio?.engine.ready
    && !webRStudio.engine.running && !webRStudio.console.busy
    && document.querySelector('#r-status').dataset.state === 'ready', null, { timeout: stepTimeout });
}

async function idleAssistant(timeout = stepTimeout) {
  await page.waitForFunction(() => webRStudio.assistant && !webRStudio.assistant.busy
    && ['ready', 'error', 'unloaded'].includes(webRStudio.assistant.client.state), null, { timeout });
  const status = await page.evaluate(() => ({ state: webRStudio.assistant.client.state, error: webRStudio.assistant.client.error }));
  assert.equal(status.state, 'ready', JSON.stringify(status));
}

async function execute(code) {
  await idleR();
  const result = await page.evaluate(code => webRStudio.executeCode(code), code);
  assert.equal(result?.ok, true, JSON.stringify(result));
  return result;
}

async function clearChat() {
  await page.locator('#assistant-clear').click();
  await idleAssistant();
}

async function setEditor(source) {
  await page.evaluate(source => {
    webRStudio.editor.editor.setValue(source, 1);
    webRStudio.editor.editor.navigateFileEnd();
    webRStudio.editor.editor.clearSelection();
    webRStudio.editor.focus();
  }, source);
}

try {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: process.env.BROWSER_HEADLESS !== '0',
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...(ignoreHTTPS ? ['--ignore-certificate-errors'] : [])]
  });
  const context = await browser.newContext({
    viewport: { width: 1480, height: 1050 }, ignoreHTTPSErrors: ignoreHTTPS,
    // The server already supplies isolation headers. Block only the isolation
    // service worker so Playwright can observe every dependency request.
    serviceWorkers: 'block'
  });
  context.on('request', request => {
    const url = request.url();
    if (url === WEBLLM_MODULE_URL) dependencies.push(url);
    if (/https:\/\/(?:[^/]+\.)?(?:huggingface\.co|hf\.co|hf\.space)\//i.test(url)) weights.push(url);
  });
  if (!realGPU) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: {} });
    });
    await context.route(/https:\/\/(?:[^/]+\.)?(?:huggingface\.co|hf\.co|hf\.space)\//i, route => route.abort());
    await context.route(WEBLLM_MODULE_URL, route => route.fulfill({
      status: 200, body: deterministicModule,
      headers: { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' }
    }));
  }
  page = await context.newPage();
  page.setDefaultTimeout(stepTimeout);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded', timeout: bootTimeout });
  await page.waitForFunction(() => globalThis.webRStudio && ['ready', 'error'].includes(document.querySelector('#r-status')?.dataset.state), null, { timeout: bootTimeout });
  assert.equal(await page.evaluate(() => webRStudio.engine.ready), true);
  assert.equal(await page.evaluate(() => Boolean(webRStudio.editor.editor && webRStudio.console.editor)), true, 'This regression requires actual Ace.');
  assert.equal(workerRequests, 0, 'App startup must not create an AI worker.');
  assert.equal(dependencies.length, 0, 'App startup must not import WebLLM.');
  assert.equal(weights.length, 0, 'App startup must not download model weights.');
  await page.evaluate(async () => {
    webRStudio.settings.checkpointEnvironment = false;
    webRStudio.settings.restoreEnvironment = false;
    webRStudio.pendingPlotReflow = false;
    webRStudio.plotResizeDebounced.cancel();
    await webRStudio.createFile('assistant-test.R', '# Inspect ai_fixture\n');
  });
  await execute('ai_fixture <- data.frame(x = c(1, 2, 3), note = c("ROW_VALUE_NOT_IN_METADATA", "b", "c")); ai_helper <- function(x) sum(x); invisible(NULL)');

  stage = 'opening the lazy pane and inspecting actual R metadata';
  await page.locator('.dock-tabs [data-panel="assistant"]').click();
  await page.waitForFunction(() => Boolean(webRStudio.assistant));
  assert.equal(workerRequests, 0);
  assert.equal(dependencies.length, 0, 'Opening the assistant must not import WebLLM.');
  assert.equal(weights.length, 0);
  assert.equal(await page.locator('#assistant-values').isChecked(), false);
  assert.equal(await page.locator('#assistant-functions').isChecked(), false);
  await page.locator('#assistant-context-details').evaluate(element => { element.open = true; });
  await page.locator('#assistant-objects').selectOption(['ai_fixture', 'ai_helper']);
  await page.locator('#assistant-refresh-context').click();
  await page.waitForFunction(() => !webRStudio.assistant.busy);
  const preview = await page.locator('#assistant-context-preview').textContent();
  assert.match(preview, /ai_fixture/);
  assert.match(preview, /ai_helper/);
  assert.match(preview, /\bx\b/);
  assert.ok(!preview.includes('ROW_VALUE_NOT_IN_METADATA'), 'Metadata-only context must not copy data samples.');
  assert.equal(dependencies.length, 0, 'Preview context must work without a loaded model.');

  stage = realGPU ? 'loading the actual WebGPU model (explicit opt-in)' : 'loading the deterministic WebLLM fixture';
  if (realGPU) assert.equal(await page.evaluate(() => Boolean(navigator.gpu)), true, 'The real smoke test requires WebGPU.');
  await page.locator('#assistant-load').click();
  await page.waitForFunction(() => ['ready', 'error'].includes(webRStudio.assistant.client.state), null,
    { timeout: realGPU ? modelTimeout : stepTimeout });
  await idleAssistant();
  assert.equal(workerRequests, 1);
  assert.equal(dependencies.length, 1, 'Only explicit Load should import WebLLM.');

  if (realGPU) {
    stage = 'actual model generation without automatic R execution';
    await page.locator('#assistant-prompt').fill('Write one short R expression that computes the mean of ai_fixture$x. Do not execute it.');
    await page.locator('#assistant-send').click();
    await idleAssistant(180_000);
    const result = await page.evaluate(() => webRStudio.assistant.history.at(-1));
    assert.equal(result?.role, 'assistant');
    assert.ok(result.content.trim().length > 0, 'The real model must produce a nonempty response.');
    assert.equal(await page.evaluate(() => webRStudio.engine.webR.evalRBoolean('exists("ai_ran", envir = .GlobalEnv, inherits = FALSE)')), false);
    console.log('Actual WebLLM/WebGPU smoke test passed: explicit model load and nonempty generation; generated R was not executed.');
  } else {
    stage = 'editor suggestion and guarded insertion';
    await setEditor('# Inspect ai_fixture\n');
    const initialSource = await page.evaluate(() => webRStudio.editor.getValue());
    await page.locator('#assistant-editor-suggest').click();
    await idleAssistant();
    await page.getByRole('button', { name: 'Insert suggestion', exact: true }).click();
    assert.equal(await page.evaluate(() => webRStudio.editor.getValue()), initialSource + '# local suggestion');
    assert.equal(await page.evaluate(() => webRStudio.engine.webR.evalRBoolean('exists("ai_ran", envir = .GlobalEnv, inherits = FALSE)')), false);

    stage = 'explicit chat Run action in the actual R console';
    await clearChat();
    await page.locator('#assistant-prompt').fill('Compute the total of ai_fixture$x.');
    await page.locator('#assistant-prompt').press('Control+Enter');
    await idleAssistant();
    assert.equal(await page.evaluate(() => webRStudio.engine.webR.evalRBoolean('exists("ai_ran", envir = .GlobalEnv, inherits = FALSE)')), false,
      'Generated R code must wait for a Run click.');
    await page.getByRole('button', { name: 'Run in R', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#assistant-messages').textContent.includes('R execution result'));
    await idleR();
    assert.equal(await page.evaluate(() => webRStudio.engine.webR.evalRNumber('ai_ran')), 6);

    stage = 'busy R and interactive console input';
    await page.evaluate(() => {
      globalThis.aiBusyRun = webRStudio.executeCode('invisible(readline("Assistant busy fixture: "))');
    });
    await page.waitForFunction(() => Boolean(webRStudio.engine.pendingConsoleInput));
    assert.equal(await page.locator('#assistant-send').isDisabled(), true);
    assert.equal(await page.locator('#assistant-suggest').isDisabled(), true);
    const requestCount = await page.evaluate(() => webRStudio.assistant.history.length);
    await page.evaluate(() => { webRStudio.console.setValue('PRIVATE_INTERACTIVE_REPLY'); webRStudio.console.focus(); });
    await page.keyboard.press('Alt+Backslash');
    assert.equal(await page.evaluate(() => webRStudio.assistant.history.length), requestCount);
    assert.ok(!(await page.locator('#assistant-context-preview').textContent()).includes('PRIVATE_INTERACTIVE_REPLY'));
    await page.locator('#stop-button').click();
    await page.evaluate(() => globalThis.aiBusyRun);
    await idleR();

    stage = 'stale document guard';
    await clearChat();
    await setEditor('# DELAY_RESPONSE\nai_fixture$x\n');
    await page.locator('#assistant-editor-suggest').click();
    await page.waitForFunction(() => webRStudio.assistant.client.state === 'generating');
    await setEditor('# Changed during generation\n');
    await idleAssistant();
    assert.equal(await page.getByRole('button', { name: 'Insert suggestion', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => webRStudio.editor.getValue()), '# Changed during generation\n');

    stage = 'Stop and Clear reject stale streamed output';
    await clearChat();
    await page.locator('#assistant-prompt').fill('DELAY_RESPONSE Explain ai_fixture.');
    await page.locator('#assistant-send').click();
    await page.waitForFunction(() => webRStudio.assistant.client.state === 'generating');
    await page.locator('#assistant-stop').click();
    await idleAssistant();
    assert.equal(await page.locator('#assistant-messages button').count(), 0);
    assert.equal(await page.evaluate(() => webRStudio.assistant.history.length), 0);
    await page.locator('#assistant-prompt').fill('DELAY_RESPONSE Explain ai_fixture.');
    await page.locator('#assistant-send').click();
    await page.waitForFunction(() => webRStudio.assistant.client.state === 'generating');
    await page.locator('#assistant-clear').click();
    await idleAssistant();
    assert.equal(await page.locator('#assistant-messages > *').count(), 1);
    assert.match(await page.locator('#assistant-messages').textContent(), /^Conversation cleared/);

    stage = 'Ace and fallback keyboard suggestions';
    await setEditor('# Keyboard ai_fixture\n');
    await page.keyboard.press('Alt+Backslash');
    await page.getByRole('button', { name: 'Insert suggestion', exact: true }).waitFor();
    await idleAssistant();
    assert.equal(await page.locator('#assistant-messages article.assistant-user').count(), 1);
    await clearChat();
    await page.evaluate(() => {
      webRStudio.currentFocus = 'editor';
      webRStudio.console.enableFallback('# Console ai_fixture\n');
      webRStudio.console.fallback.setSelectionRange(webRStudio.console.getValue().length, webRStudio.console.getValue().length);
      webRStudio.console.focus();
    });
    await page.locator('#fallback-console').press('Alt+Backslash');
    await page.getByRole('button', { name: 'Insert suggestion', exact: true }).waitFor();
    await idleAssistant();
    assert.match(await page.locator('#assistant-messages').textContent(), /Suggest code in console/);
    await page.getByRole('button', { name: 'Insert suggestion', exact: true }).click();
    assert.equal(await page.evaluate(() => webRStudio.console.getValue()), '# Console ai_fixture\n# local suggestion');
    assert.equal(await page.evaluate(() => webRStudio.engine.webR.evalRNumber('ai_ran')), 6);
    assert.deepEqual(weights, [], 'The deterministic test must not download model weights.');
    console.log('Assistant browser regression passed with real webR/Ace and a deterministic WebLLM fixture.');
  }
  await page.locator('#assistant-model-details').evaluate(element => { element.open = true; });
  await page.locator('#assistant-unload').click();
  assert.equal(await page.evaluate(() => webRStudio.assistant.client.state), 'unloaded');
  assert.deepEqual(errors, [], 'No uncaught browser errors are expected.');
  await context.close();
} catch (error) {
  console.error(`Failed stage: ${stage}`);
  if (page) console.error('Assistant state:', await page.evaluate(() => ({
    ready: globalThis.webRStudio?.engine.ready,
    running: globalThis.webRStudio?.engine.running,
    model: globalThis.webRStudio?.assistant?.client.state,
    status: document.querySelector('#assistant-status')?.textContent,
    context: document.querySelector('#assistant-context-preview')?.textContent?.slice(0, 500),
    boot: document.querySelector('#boot-message')?.textContent
  })).catch(() => 'Page unavailable.'));
  console.error(diagnostics.slice(-10).join('\n'));
  throw error;
} finally {
  await browser?.close();
  await new Promise(done => { server.close(done); server.closeAllConnections(); });
}
