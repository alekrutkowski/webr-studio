/**
 * Real-app regression for interactive R stdin and console busy-state recovery.
 * Uses real webR and real Ace/textarea keyboard events; no evaluator is mocked.
 *
 * PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node tests/browser-console-input-check.mjs
 * BROWSER_IGNORE_HTTPS_ERRORS=1 is only for an intercepting development proxy.
 * SCREENSHOT_PATH=/path/to/prompt.png optionally saves the waiting-input UI.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? require(resolve(process.env.PLAYWRIGHT_MODULE)) : await import('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bootTimeout = Number(process.env.BROWSER_BOOT_TIMEOUT_MS) || 180_000;
const stepTimeout = Number(process.env.BROWSER_STEP_TIMEOUT_MS) || 30_000;
const ignoreHTTPS = /^(1|true)$/i.test(process.env.BROWSER_IGNORE_HTTPS_ERRORS || '');
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json'
};
const server = createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://fixture.invalid').pathname);
  response.setHeader('Cache-Control', 'no-store');
  if (path.startsWith('/isolated/')) {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  try {
    if (!/^\/(isolated|postmessage)\//.test(path)) throw new Error('Unknown test path.');
    const relative = path.replace(/^\/(isolated|postmessage)\//, '') || 'index.html';
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep)) throw new Error('Invalid test path.');
    response.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 400);
    response.end(error.message);
  }
});

let browser;
let page;
let stage = 'startup';
const diagnostics = [];
const pageErrors = [];

async function bounded(promise, label, timeout = stepTimeout) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout / 1000} seconds.`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function idle() {
  await page.waitForFunction(() => globalThis.webRStudio?.engine.ready
    && !webRStudio.engine.running && !webRStudio.console.busy
    && document.querySelector('#r-status').dataset.state === 'ready', null, { timeout: stepTimeout });
}

async function execute(code) {
  await idle();
  const result = await bounded(page.evaluate(code => webRStudio.executeCode(code), code), stage);
  assert.equal(result?.ok, true, JSON.stringify(result));
  return result;
}

async function startEditorCommand(code) {
  await idle();
  await page.evaluate(code => {
    globalThis.promptTestResult = null;
    globalThis.promptTestRun = webRStudio.executeCode(code).then(result => { globalThis.promptTestResult = result; });
  }, code);
}

async function enterText(text) {
  await page.evaluate(() => webRStudio.console.focus());
  await page.keyboard.insertText(text);
}

async function startConsoleCommand(code) {
  await idle();
  await page.evaluate(() => { globalThis.promptTestResult = null; webRStudio.console.setValue(''); });
  await enterText(code);
  await page.keyboard.press('Enter');
}

async function waiting(prompt) {
  await page.waitForFunction(() => Boolean(webRStudio.engine.pendingConsoleInput), null, { timeout: stepTimeout });
  assert.equal(await page.locator('#console-input-request').isVisible(), true);
  if (prompt !== undefined) assert.equal(await page.locator('#console-input-message').textContent(), prompt);
  assert.deepEqual(await page.evaluate(() => ({
    running: webRStudio.engine.running,
    phase: webRStudio.engine.executionPhase,
    readOnly: webRStudio.console.editor?.getReadOnly() ?? document.querySelector('#fallback-console').disabled,
    stopDisabled: document.querySelector('#stop-button').disabled,
    sendDisabled: document.querySelector('#console-run-button').disabled,
    editorRunDisabled: document.querySelector('#run-selection-button').disabled
  })), { running: true, phase: 'waiting-input', readOnly: false, stopDisabled: false, sendDisabled: false, editorRunDisabled: true });
  assert.equal(await page.locator('#console-run-button').getAttribute('aria-label'), 'Send response (Enter)');
}

async function finished({ interrupted = false } = {}) {
  await page.waitForFunction(() => globalThis.promptTestResult !== null, null, { timeout: stepTimeout });
  await idle();
  const result = await page.evaluate(() => promptTestResult);
  assert.equal(result?.ok, !interrupted, JSON.stringify(result));
  if (interrupted) assert.equal(result.interrupted, true, JSON.stringify(result));
  assert.equal(await page.locator('#console-input-request').isVisible(), false);
  assert.equal(await page.evaluate(() => webRStudio.console.inputRequest), null);
  return result;
}

async function assertReplyNotSaved(reply, expectedDraft) {
  const saved = await bounded(page.evaluate(async () => {
    webRStudio.console.persistDraft.flush();
    await webRStudio.persistWorkspaceMeta();
    const { workspaceDB } = await import(`./js/db.js?v=${(await import('./js/config.js')).APP_VERSION}`);
    const record = await workspaceDB.get('workspace');
    const running = webRStudio.engine.running;
    let exported = null;
    let exportError = '';
    try { exported = await webRStudio.serializeWorkspace({ includeCheckpoint: false }); }
    catch (error) { exportError = error.message; }
    return { record, console: exported?.console, callbackDraft: webRStudio.consoleState.draft, running, exportError };
  }), 'Read persisted console metadata');
  assert.equal(saved.record.consoleDraft, expectedDraft);
  if (saved.running) {
    assert.match(saved.exportError, /Wait for R|R.*(?:busy|execut|running)/i,
      'A complete project export must refuse while R is waiting for input.');
    assert.equal(saved.console, undefined);
  } else {
    assert.equal(saved.exportError, '');
    assert.equal(saved.console.draft, expectedDraft);
  }
  assert.equal(JSON.stringify(saved).includes(reply), false, 'Raw prompt replies must not enter saved/exported console history, transcript, or draft.');
}

try {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...(ignoreHTTPS ? ['--ignore-certificate-errors'] : [])]
  });

  for (const channel of ['isolated', 'postmessage']) {
    stage = `${channel}: app startup`;
    console.log(`${stage}; loading the actual app, Ace, and webR.`);
    // The app's isolation service worker is blocked so the second context
    // deliberately remains on the real PostMessage channel.
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: ignoreHTTPS, serviceWorkers: 'block' });
    page = await context.newPage();
    page.setDefaultTimeout(stepTimeout);
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
    await page.goto(`${origin}/${channel}/`, { waitUntil: 'domcontentloaded', timeout: bootTimeout });
    await page.waitForFunction(() => globalThis.webRStudio && ['ready', 'error'].includes(document.querySelector('#r-status')?.dataset.state), null, { timeout: bootTimeout });
    assert.equal(await page.evaluate(() => webRStudio.engine.ready), true);
    assert.equal(await page.evaluate(() => webRStudio.engine.interruptSupported), channel === 'isolated');
    assert.equal(await page.evaluate(() => Boolean(webRStudio.console.editor)), true, 'The main cases must exercise actual Ace keyboard input.');
    await page.evaluate(() => {
      // Avoid checkpoints unrelated to prompt privacy and make restart state
      // deterministic. All command execution and prompt IO remain production.
      webRStudio.settings.checkpointEnvironment = false;
      webRStudio.settings.restoreEnvironment = false;
      const submit = webRStudio.console.callbacks.onSubmit;
      globalThis.promptSubmitCalls = 0;
      webRStudio.console.callbacks.onSubmit = async code => {
        globalThis.promptSubmitCalls += 1;
        const result = await submit(code);
        globalThis.promptTestResult = result;
        return result;
      };
    });

    if (channel === 'postmessage') {
      stage = 'PostMessage unsupported nested input recovery';
      await startConsoleCommand('readline("Unsupported nested prompt: ")');
      await page.waitForFunction(() => globalThis.promptTestResult !== null, null, { timeout: stepTimeout });
      await idle();
      const failure = await page.evaluate(() => ({ result: promptTestResult, pending: webRStudio.engine.pendingConsoleInput,
        locked: webRStudio.console.editor.getReadOnly(), busy: webRStudio.console.busy }));
      assert.equal(failure.result.ok, false, JSON.stringify(failure));
      assert.match(failure.result.error, /interactive input|PostMessage/i);
      assert.equal(failure.pending, null);
      assert.equal(failure.locked, false);
      assert.equal(failure.busy, false);
      assert.equal(await page.locator('#console-input-request').isVisible(), false);
      await startConsoleCommand('print(6 * 7)');
      await finished();
      assert.match(await page.locator('#console-output').innerText(), /42/);
      console.log('postmessage: the actual unsupported nested-read error settles, unlocks the console, and the next keyboard command succeeds.');
      await context.close();
      continue;
    }

    stage = 'Ace raw reply and persistence';
    const secretReply = 'private reply 7351 with unmatched ("';
    await startConsoleCommand('prompt_answer <- readline("Your response: "); invisible(NULL)');
    await waiting('Your response: ');
    await enterText(secretReply);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Control+Shift+m');
    assert.equal(await page.evaluate(() => webRStudio.console.getValue()), secretReply, 'History and R pipe shortcuts must not change a raw reply.');
    assert.deepEqual(await page.evaluate(() => ({
      mode: webRStudio.console.editor.session.$modeId,
      completion: webRStudio.console.editor.getOption('enableLiveAutocompletion'),
      behavior: webRStudio.console.editor.getOption('behavioursEnabled')
    })), { mode: 'ace/mode/text', completion: false, behavior: false });
    await assertReplyNotSaved(secretReply, '');
    if (process.env.SCREENSHOT_PATH) {
      const path = resolve(process.env.SCREENSHOT_PATH);
      await mkdir(dirname(path), { recursive: true });
      await page.screenshot({ path });
    }
    await page.keyboard.press('Enter');
    await finished();
    assert.equal(await bounded(page.evaluate(() => webRStudio.engine.webR.evalRString('prompt_answer')), 'Read raw R response'), secretReply);
    await assertReplyNotSaved(secretReply, '');

    stage = 'menu prompt and editor draft preservation';
    const draft = 'draft_kept <- c(1, 2, 3)';
    await enterText(draft);
    await page.evaluate(() => {
      globalThis.promptOriginalSession = webRStudio.console.editor.session;
      globalThis.promptOriginalUndo = webRStudio.console.editor.session.getUndoManager();
      webRStudio.togglePaneMaximize('editor-pane');
    });
    await startEditorCommand('prompt_choice <- menu(c("first", "second"), title = "Choose a fixture", graphics = FALSE); invisible(NULL)');
    await waiting();
    assert.match(await page.locator('#console-input-message').textContent(), /Selection/);
    assert.equal(await page.evaluate(() => webRStudio.maximizedPaneId), '');
    const firstMenuRequest = await page.evaluate(() => webRStudio.engine.pendingConsoleInput.id);
    await enterText('9');
    await page.keyboard.press('Enter');
    await page.waitForFunction(id => webRStudio.engine.pendingConsoleInput?.id > id, firstMenuRequest);
    await waiting();
    assert.match(await page.locator('#console-input-message').textContent(), /Selection/);
    await enterText('2');
    await page.locator('#console-run-button').click();
    await finished();
    assert.equal(await bounded(page.evaluate(() => webRStudio.engine.webR.evalRNumber('prompt_choice')), 'Read menu choice'), 2);
    assert.equal(await page.evaluate(() => webRStudio.console.getValue()), draft);
    assert.deepEqual(await page.evaluate(() => ({
      session: webRStudio.console.editor.session === promptOriginalSession,
      undo: webRStudio.console.editor.session.getUndoManager() === promptOriginalUndo,
      completion: webRStudio.console.editor.getOption('enableLiveAutocompletion'),
      completers: webRStudio.console.editor.completers.length > 0
    })), { session: true, undo: true, completion: true, completers: true });
    const submittedBeforeDoubleClick = await page.evaluate(() => promptSubmitCalls);
    // Deliver the second click after the first reply has already completed,
    // which is the dangerous case for a restored nonempty command draft.
    await page.locator('#console-run-button').dispatchEvent('click', { detail: 2 });
    assert.equal(await page.evaluate(() => promptSubmitCalls), submittedBeforeDoubleClick);
    assert.equal(await bounded(page.evaluate(() => webRStudio.engine.webR.evalRBoolean('exists("draft_kept", envir = .GlobalEnv, inherits = FALSE)')), 'Check restored draft was not executed'), false);

    stage = 'primary-looking and empty prompts with empty replies';
    for (const prompt of ['> ', '']) {
      await startEditorCommand(`prompt_empty <- readline(${JSON.stringify(prompt)}); invisible(NULL)`);
      await waiting(prompt || 'R is waiting for a response.');
      assert.equal(await page.evaluate(() => webRStudio.engine.pendingConsoleInput.prompt), prompt);
      await page.keyboard.press('Enter');
      await finished();
      assert.equal(await bounded(page.evaluate(() => webRStudio.engine.webR.evalRString('prompt_empty')), 'Read empty response'), '');
      assert.equal(await page.evaluate(() => webRStudio.console.getValue()), draft);
    }

    stage = 'single-line validation and sequential prompts';
    await startEditorCommand('prompt_first <- readline("First: "); prompt_second <- readline("Second: "); invisible(NULL)');
    await waiting('First: ');
    await enterText('line one\nline two');
    await page.keyboard.press('Enter');
    assert.match(await page.locator('#console-input-error').textContent(), /single line/);
    assert.equal(await page.evaluate(() => webRStudio.engine.executionPhase), 'waiting-input');
    await page.keyboard.press('Control+a');
    await enterText('one');
    await page.keyboard.press('Enter');
    await waiting('Second: ');
    await enterText('two');
    await page.keyboard.press('Enter');
    await finished();
    await execute('stopifnot(identical(prompt_first, "one"), identical(prompt_second, "two"))');
    console.log('isolated: raw Ace replies, menu selection, > prompts, empty replies, single-line validation, sequential requests, draft restoration, and persistence privacy passed.');

    stage = 'Stop while waiting for input';
    await execute('prompt_kept <- 42');
    await startEditorCommand('invisible(readline("Cancel this prompt: "))');
    await waiting('Cancel this prompt: ');
    const cancelledReply = 'discarded prompt response 9271';
    await enterText(cancelledReply);
    await page.locator('#stop-button').click();
    await finished({ interrupted: true });
    assert.equal(await page.evaluate(() => webRStudio.console.getValue()), draft);
    await assertReplyNotSaved(cancelledReply, draft);
    await execute('stopifnot(identical(prompt_kept, 42)); print("after interruption")');

    stage = 'Restart while waiting for input';
    await startEditorCommand('invisible(readline("Restart this prompt: "))');
    await waiting('Restart this prompt: ');
    await enterText('discarded restart response 1634');
    await page.locator('#restart-r-button').click();
    await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
    await page.locator('#confirm-accept').click();
    await page.waitForFunction(() => webRStudio.engine.ready && !webRStudio.engine.running
      && document.querySelector('#r-status').dataset.state === 'ready'
      && webRStudio.console.transcript.some(entry => /webR .* restarted/.test(entry.text)), null, { timeout: bootTimeout });
    assert.equal(await page.locator('#console-input-request').isVisible(), false);
    assert.equal(await page.evaluate(() => webRStudio.console.getValue()), draft);
    await assertReplyNotSaved('discarded restart response 1634', draft);
    await startConsoleCommand('print(21 * 2)');
    await finished();
    console.log('isolated: Stop cancels the waiting read without losing existing R objects; explicit restart clears pending input and restores normal keyboard execution.');

    stage = 'textarea fallback prompt and recovery';
    await page.evaluate(() => webRStudio.console.enableFallback('fallback_draft <- 7'));
    await startEditorCommand('fallback_answer <- readline("Fallback response: "); invisible(NULL)');
    await waiting('Fallback response: ');
    assert.equal(await page.locator('#fallback-console').isVisible(), true);
    await page.locator('#fallback-console').fill('literal ( fallback');
    await page.locator('#fallback-console').press('Enter');
    await finished();
    assert.equal(await page.locator('#fallback-console').inputValue(), 'fallback_draft <- 7');
    assert.equal(await bounded(page.evaluate(() => webRStudio.engine.webR.evalRString('fallback_answer')), 'Read fallback reply'), 'literal ( fallback');
    await startConsoleCommand('print(7 * 6)');
    await finished();
    console.log('isolated: the basic textarea sends raw input, restores its draft, and executes the next R command normally.');
    await context.close();
  }
  assert.deepEqual(pageErrors, [], 'No uncaught browser errors are expected.');
  console.log('Interactive console input browser regression passed.');
} catch (error) {
  console.error(`Failed stage: ${stage}`);
  if (page) console.error('Prompt state:', await bounded(page.evaluate(() => ({
    ready: globalThis.webRStudio?.engine.ready, running: globalThis.webRStudio?.engine.running,
    phase: globalThis.webRStudio?.engine.executionPhase, pending: globalThis.webRStudio?.engine.pendingConsoleInput,
    status: document.querySelector('#r-status')?.textContent, boot: document.querySelector('#boot-message')?.textContent,
    result: globalThis.promptTestResult,
    consoleTail: globalThis.webRStudio?.console.transcript.slice(-5)
  })), 'Read failure diagnostics', 5000).catch(() => 'Page unavailable.'));
  console.error(diagnostics.slice(-10).join('\n'));
  throw error;
} finally {
  await browser?.close();
  await new Promise(done => { server.close(done); server.closeAllConnections(); });
}
