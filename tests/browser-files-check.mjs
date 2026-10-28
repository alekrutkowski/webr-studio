/**
 * Optional real-browser regression for the unified Explorer. Requires
 * Playwright, Chromium, and access to webR/Ace's existing CDNs. IndexedDB,
 * editor buffers, the real R filesystem, and GUI actions are exercised.
 * No Tailscale connection or mocked download transport is used.
 *
 * node tests/browser-files-check.mjs
 * PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node tests/browser-files-check.mjs
 * BROWSER_IGNORE_HTTPS_ERRORS=1 is for an intercepting test proxy only.
 * SCREENSHOT_PATH=/path/to/explorer.png optionally saves the merged Explorer.
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
const prefix = '/files-regression/';
const csv = 'name,value\nfrom-download,42\n';
const binary = [0, 1, 127, 128, 255, 10, 13];
const types = {
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
    if (path === `${prefix}__seed__.html`) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><title>File manager regression setup</title>');
      return;
    }
    if (path === `${prefix}__fixture__/download.csv`) {
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.end(csv);
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
const listen = () => new Promise((done, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`));
});
const close = () => new Promise(done => {
  if (!server.listening) { done(); return; }
  server.close(done);
  server.closeAllConnections();
});
const ignoreTestCertificates = /^(1|true)$/i.test(process.env.BROWSER_IGNORE_HTTPS_ERRORS || '');
const diagnostics = [];
const pageErrors = [];
let browser;
let page;

async function waitForRuntime(page) {
  await page.waitForFunction(() => (
    globalThis.webRStudio && ['ready', 'error'].includes(document.querySelector('#r-status')?.dataset.state)
  ), null, { timeout: Number(process.env.BROWSER_BOOT_TIMEOUT_MS) || 180_000 });
  const state = await page.evaluate(() => ({
    ready: webRStudio.engine.ready,
    version: webRStudio.engine.version,
    bridge: webRStudio.network.state.bridgeReady,
    bridgeError: webRStudio.network.state.bridgeError,
    dockPanels: webRStudio.settings.dockPanels,
    activeDock: webRStudio.settings.activeDock
  }));
  assert.equal(state.ready, true, JSON.stringify(state));
  assert.equal(state.bridge, true, JSON.stringify(state));
  return state;
}

async function seedWorkspace(page) {
  await page.evaluate(async () => {
    const request = indexedDB.open('webr-studio', 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore('kv', { keyPath: 'key' });
      database.createObjectStore('files', { keyPath: 'path' }).createIndex('updatedAt', 'updatedAt');
      database.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
    };
    const database = await new Promise((done, reject) => {
      request.onsuccess = () => done(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['kv', 'files'], 'readwrite');
    // Old layouts may have Files as the only panel in one dock.
    transaction.objectStore('kv').put({ key: 'settings', value: {
      dockPanels: { top: ['files'], bottom: ['environment', 'outline', 'packages', 'plots', 'help', 'data', 'preview'] },
      activeDock: { top: 'files', bottom: 'plots' },
      checkpointEnvironment: false, restoreEnvironment: false, autosaveDelay: 700
    } });
    transaction.objectStore('kv').put({ key: 'workspace', value: {
      openTabs: ['saved-delete.R'], activePath: 'saved-delete.R'
    } });
    for (const [path, content] of [
      ['stale.csv', 'value\n1\n'], ['saved-delete.R', 'saved_value <- 1\n'],
      ['unsaved.R', 'original_value <- 1\n'], ['save-race.R', 'before_race <- 1\n'],
      ['delete-failure.R', 'retain_after_failure <- TRUE\n']
    ]) {
      transaction.objectStore('files').put({
        path, content, type: 'text', size: new TextEncoder().encode(content).length,
        mime: path.endsWith('.csv') ? 'text/csv' : 'text/x-r-source', updatedAt: Date.now()
      });
    }
    await new Promise((done, reject) => {
      transaction.oncomplete = done;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });
}

const rowFor = (page, path) => {
  const paths = path.startsWith('/') ? [path] : [path, `/project/${path}`];
  return page.locator(paths.map(value => `#file-tree .file-row[data-path=${JSON.stringify(value)}]`).join(', '));
};
async function startDeletion(page, path) {
  const row = rowFor(page, path);
  await row.hover();
  await row.locator('[data-file-action="delete"]').click();
}

async function expandProjectPath(page, path) {
  await page.evaluate(path => {
    const parts = path.split('/');
    for (let length = 1; length < parts.length; length += 1) {
      webRStudio.expandedFolders.add(parts.slice(0, length).join('/'));
    }
    webRStudio.renderFileTree();
  }, path);
}

async function runR(page, code) {
  const result = await page.evaluate(code => webRStudio.executeCode(code), code);
  assert.equal(result?.ok, true, JSON.stringify(result));
  return result;
}

async function runtimeBytes(page, path) {
  return page.evaluate(async path => {
    try { return Array.from(await webRStudio.engine.webR.FS.readFile(path)); }
    catch { return null; }
  }, path);
}

async function storedFile(page, path) {
  return page.evaluate(async path => {
    const request = indexedDB.open('webr-studio', 1);
    const database = await new Promise((done, reject) => {
      request.onsuccess = () => done(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = database.transaction('files', 'readonly').objectStore('files').get(path);
    const record = await new Promise((done, reject) => {
      read.onsuccess = () => done(read.result || null);
      read.onerror = () => reject(read.error);
    });
    database.close();
    if (record?.content && typeof record.content !== 'string') record.content = Array.from(record.content);
    return record;
  }, path);
}

async function contextAction(page, path, label) {
  await rowFor(page, path).click({ button: 'right' });
  await page.locator('#context-menu').getByRole('button', { name: label, exact: true }).click();
}

async function acceptDeletion(page, path) {
  await startDeletion(page, path);
  await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
  await page.locator('#confirm-accept').click();
  await rowFor(page, path).waitFor({ state: 'detached' });
}

try {
  const origin = await listen();
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...(ignoreTestCertificates ? ['--ignore-certificate-errors'] : [])]
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: ignoreTestCertificates, acceptDownloads: true });
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') diagnostics.push(message.text());
  });
  page.on('requestfailed', request => diagnostics.push(`${request.url()} ${request.failure()?.errorText || ''}`));
  await page.goto(`${origin}${prefix}__seed__.html`);
  await seedWorkspace(page);
  await page.goto(`${origin}${prefix}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const runtime = await waitForRuntime(page);
  assert.equal(await page.locator('#file-tree').count(), 1);
  assert.equal(await page.locator('.dock-tabs [data-panel="files"], #panel-files').count(), 0);
  assert.ok(runtime.dockPanels.top.length && runtime.dockPanels.bottom.length, 'migration must leave both docks usable');
  for (const dock of ['top', 'bottom']) {
    assert.ok(!runtime.dockPanels[dock].includes('files'));
    assert.ok(runtime.dockPanels[dock].includes(runtime.activeDock[dock]));
  }
  console.log(`webR ${runtime.version}: single Explorer and old Files-dock migration passed.`);

  await runR(page, `
    dir.create("generated/nested", recursive = TRUE, showWarnings = FALSE)
    writeLines("written by R", "generated/nested/note.txt")
    writeBin(as.raw(c(${binary.join(',')})), "generated/nested/bytes.bin")
    download.file(${JSON.stringify(`${origin}${prefix}__fixture__/download.csv`)}, "generated/nested/download.csv", quiet = TRUE)
    writeLines("temporary", "cancel-delete.txt")
    writeLines("busy", "busy-delete.txt")
    writeLines("multi one", "multi-one.txt")
    writeLines("multi two", "multi-two.txt")
    writeLines(c("value", "99"), "stale.csv")
    writeLines("outside project", "/tmp/explorer-outside.txt")
  `);
  await expandProjectPath(page, 'generated/nested/note.txt');
  for (const path of ['generated/nested/note.txt', 'generated/nested/bytes.bin', 'generated/nested/download.csv', 'stale.csv']) {
    await rowFor(page, path).waitFor({ state: 'visible' });
    assert.equal(await rowFor(page, path).count(), 1, `${path} must appear once`);
  }
  assert.doesNotMatch(await rowFor(page, 'generated/nested/download.csv').innerText(), /R session|Not saved/);
  assert.equal((await storedFile(page, 'generated/nested/download.csv')).content, csv, 'R-created project files must be saved automatically');
  assert.deepEqual(await runtimeBytes(page, '/project/generated/nested/download.csv'), Array.from(new TextEncoder().encode(csv)));

  // Opening a runtime CSV must not first mirror an older saved copy onto it.
  await contextAction(page, 'stale.csv', 'Open in data viewer');
  await page.waitForFunction(() => document.querySelector('#panel-data')?.classList.contains('active'));
  await page.waitForFunction(() => document.querySelector('#data-viewer')?.textContent.includes('99'));
  assert.deepEqual(await runtimeBytes(page, '/project/stale.csv'), Array.from(new TextEncoder().encode('value\n99\n')));

  const downloadEvent = page.waitForEvent('download');
  await contextAction(page, 'generated/nested/bytes.bin', 'Download');
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), 'bytes.bin');
  assert.deepEqual(Array.from(await readFile(await download.path())), binary);

  await page.waitForFunction(() => webRStudio.files.has('generated/nested/bytes.bin'));
  assert.deepEqual((await storedFile(page, 'generated/nested/bytes.bin')).content, binary);
  assert.deepEqual(await runtimeBytes(page, '/project/generated/nested/bytes.bin'), binary);
  await rowFor(page, 'generated/nested/note.txt').click();
  await page.waitForFunction(() => webRStudio.activePath === 'generated/nested/note.txt');
  assert.equal(await page.evaluate(() => webRStudio.editor.getValue()), 'written by R\n');
  assert.equal((await storedFile(page, 'generated/nested/note.txt')).content, 'written by R\n');
  console.log('R-created and downloaded nested files, automatic binary persistence, and current CSV preview passed.');

  await startDeletion(page, 'cancel-delete.txt');
  await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
  await page.locator('#confirm-cancel').click();
  assert.ok(await runtimeBytes(page, '/project/cancel-delete.txt'));
  assert.equal(await rowFor(page, 'cancel-delete.txt').count(), 1);

  // R may start after the dialog opens. Recheck idle state on confirmation.
  await startDeletion(page, 'busy-delete.txt');
  await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
  await page.evaluate(() => { globalThis.__fileBusyRun = webRStudio.executeCode('Sys.sleep(2)'); });
  await page.waitForFunction(() => webRStudio.engine.running);
  assert.equal(await page.locator('#sidebar-delete-files').isDisabled(), true);
  await page.locator('#confirm-accept').click();
  assert.equal((await page.evaluate(() => __fileBusyRun)).ok, true);
  assert.ok(await runtimeBytes(page, '/project/busy-delete.txt'), 'a busy confirmation must not delete a file');
  await runR(page, 'stopifnot(1 + 1 == 2)');

  await page.evaluate(() => { webRStudio.selectedFiles.clear(); webRStudio.renderFileTree(); });
  await rowFor(page, 'multi-one.txt').click({ modifiers: ['Control'] });
  await rowFor(page, 'multi-two.txt').click({ modifiers: ['Control'] });
  await page.locator('#sidebar-delete-files').click();
  await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
  await page.locator('#confirm-accept').click();
  await rowFor(page, 'multi-one.txt').waitFor({ state: 'detached' });
  await rowFor(page, 'multi-two.txt').waitFor({ state: 'detached' });
  assert.equal(await runtimeBytes(page, '/project/multi-one.txt'), null);
  assert.equal(await runtimeBytes(page, '/project/multi-two.txt'), null);

  await rowFor(page, 'delete-failure.R').click();
  await page.evaluate(() => {
    const original = webRStudio.engine.deleteVirtualFile.bind(webRStudio.engine);
    globalThis.__originalDeleteVirtualFile = original;
    webRStudio.engine.deleteVirtualFile = async path => {
      if (path === '/project/delete-failure.R') throw new Error('Intentional regression fixture deletion failure');
      return original(path);
    };
  });
  await startDeletion(page, 'delete-failure.R');
  await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
  await page.locator('#confirm-accept').click();
  await page.waitForFunction(() => document.querySelector('#toast-region')?.textContent.includes('Intentional regression fixture deletion failure'));
  assert.equal(await rowFor(page, 'delete-failure.R').count(), 1);
  assert.equal((await storedFile(page, 'delete-failure.R')).content, 'retain_after_failure <- TRUE\n');
  assert.ok(await runtimeBytes(page, '/project/delete-failure.R'));
  assert.equal(await page.evaluate(() => webRStudio.editor.files.has('delete-failure.R') && webRStudio.openTabs.includes('delete-failure.R')), true);
  await page.evaluate(() => { webRStudio.engine.deleteVirtualFile = __originalDeleteVirtualFile; });

  await rowFor(page, 'saved-delete.R').click();
  await page.waitForFunction(() => webRStudio.activePath === 'saved-delete.R');
  await acceptDeletion(page, 'saved-delete.R');
  assert.equal(await storedFile(page, 'saved-delete.R'), null);
  assert.equal(await runtimeBytes(page, '/project/saved-delete.R'), null);
  assert.equal(await page.evaluate(() => webRStudio.editor.files.has('saved-delete.R') || webRStudio.openTabs.includes('saved-delete.R')), false);
  await acceptDeletion(page, 'cancel-delete.txt');
  assert.equal(await runtimeBytes(page, '/project/cancel-delete.txt'), null);
  console.log('Delete cancellation, confirmation during R execution, failure retention, multi-select, runtime deletion, and saved/editor deletion passed.');

  // Pause a real pending save just before its filesystem write. Deletion must
  // wait for it, then remove both copies, and never resurrect the path later.
  await rowFor(page, 'save-race.R').click();
  await page.evaluate(() => {
    const app = webRStudio;
    const original = app.engine.mirrorFile.bind(app.engine);
    globalThis.__fileRace = { original, waiting: false };
    app.engine.mirrorFile = async (path, content) => {
      if (path === 'save-race.R') {
        __fileRace.waiting = true;
        await new Promise(done => { __fileRace.release = done; });
      }
      return original(path, content);
    };
    app.editor.setValue('after_race <- 2\n');
    app.onEditorChange('save-race.R', app.editor.getValue());
    globalThis.__fileSave = app.saveFile('save-race.R');
  });
  await page.waitForFunction(() => __fileRace.waiting);
  assert.equal(await rowFor(page, 'save-race.R').count(), 1, 'an unsaved editor buffer must remain visible in the Explorer');
  await startDeletion(page, 'save-race.R');
  await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
  await page.locator('#confirm-accept').click();
  await page.waitForFunction(() => webRStudio.deletingFiles.has('save-race.R'));
  await page.evaluate(() => { __fileRace.release(); webRStudio.engine.mirrorFile = __fileRace.original; });
  await rowFor(page, 'save-race.R').waitFor({ state: 'detached' });
  await page.evaluate(async () => { await __fileSave; await webRStudio.flushPendingMirrors(); });
  assert.equal(await storedFile(page, 'save-race.R'), null);
  assert.equal(await runtimeBytes(page, '/project/save-race.R'), null);
  assert.equal(await page.evaluate(() => webRStudio.pendingMirrors.has('save-race.R') || webRStudio.pendingMirrorDeletes.has('save-race.R')), false);
  await runR(page, 'stopifnot(!file.exists("save-race.R"))');

  // Runtime refresh must leave an unsaved live editor buffer intact.
  await rowFor(page, 'unsaved.R').click();
  await page.evaluate(async () => {
    webRStudio.editor.setValue('unsaved_value <- 123\n');
    webRStudio.onEditorChange('unsaved.R', webRStudio.editor.getValue());
    webRStudio.autosaveDebounced.cancel();
    await webRStudio.engine.webR.evalRVoid('writeLines("runtime_value <- 456", "/project/unsaved.R")');
    await webRStudio.refreshRuntimeFiles('/project', { quiet: true });
  });
  assert.equal(await page.evaluate(() => webRStudio.editor.getValue()), 'unsaved_value <- 123\n');
  assert.equal(await page.evaluate(() => webRStudio.files.get('unsaved.R').dirty), true);
  await page.evaluate(() => webRStudio.saveFile('unsaved.R'));

  await page.locator('#runtime-files-path').fill('/tmp');
  await page.locator('#runtime-files-path').press('Enter');
  await rowFor(page, '/tmp/explorer-outside.txt').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#runtime-files-path').inputValue(), '/tmp');
  await acceptDeletion(page, '/tmp/explorer-outside.txt');
  assert.equal(await runtimeBytes(page, '/tmp/explorer-outside.txt'), null);
  await page.locator('#runtime-files-up').click();
  await page.waitForFunction(() => document.querySelector('#runtime-files-path').value === '/');
  await page.locator('#runtime-files-home').click();
  await page.waitForFunction(() => document.querySelector('#runtime-files-path').value === '/project');
  await expandProjectPath(page, 'generated/nested/bytes.bin');
  console.log('Pending-save deletion, unsaved-buffer protection, and browsing/deleting outside /project passed.');

  if (process.env.SCREENSHOT_PATH) {
    await mkdir(dirname(resolve(process.env.SCREENSHOT_PATH)), { recursive: true });
    await page.screenshot({ path: resolve(process.env.SCREENSHOT_PATH), fullPage: true });
  }
  assert.equal(await page.evaluate(() => webRStudio.restartRuntime(false)), true);
  await waitForRuntime(page);
  await expandProjectPath(page, 'generated/nested/bytes.bin');
  assert.deepEqual(await runtimeBytes(page, '/project/generated/nested/bytes.bin'), binary);
  assert.equal(await storedFile(page, 'saved-delete.R'), null);
  assert.equal(await runtimeBytes(page, '/project/saved-delete.R'), null);
  assert.equal(await runtimeBytes(page, '/project/save-race.R'), null);
  assert.deepEqual(await runtimeBytes(page, '/project/generated/nested/download.csv'), Array.from(new TextEncoder().encode(csv)),
    'R-created project downloads must restore without a manual Keep action');
  assert.equal(await rowFor(page, 'generated/nested/bytes.bin').count(), 1);
  assert.equal(await page.evaluate(() => webRStudio.network.worker === null), true);
  assert.deepEqual(pageErrors, []);
  console.log('Restart preserved all project files and deletions without a manual Keep action. Unified Explorer browser checks passed.');
} catch (error) {
  console.error('File-manager state:', await page?.evaluate(() => ({path: webRStudio.runtimeFilesPath, running: webRStudio.engine.running, mutation: webRStudio.fileMutationPending, loading: webRStudio.runtimeFilesLoading, selected: [...webRStudio.selectedFiles], rows: [...document.querySelectorAll('#file-tree .file-row[data-path]')].map(row=>row.dataset.path), modal:document.querySelector('#confirm-dialog').open, status:document.querySelector('#explorer-file-status').textContent})).catch(() => null));
  if (diagnostics.length) console.error(diagnostics.slice(-20).join('\n'));
  if (pageErrors.length) console.error(pageErrors.join('\n'));
  throw error;
} finally {
  await browser?.close();
  await close();
}
