/**
 * Real-app regression for content-aware Explorer Open. Exercises uploads,
 * R-written files, legacy saved byte records, explicit viewers/downloads,
 * and a fresh webR session after page reload. No file IO is mocked.
 *
 * PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node tests/browser-file-open-check.mjs
 * BROWSER_IGNORE_HTTPS_ERRORS=1 is only for an intercepting development proxy.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_EDITOR_BYTES } from '../js/config.js';

const require = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? require(resolve(process.env.PLAYWRIGHT_MODULE)) : await import('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = '/file-open-regression/';
const bootTimeout = Number(process.env.BROWSER_BOOT_TIMEOUT_MS) || 180_000;
const stepTimeout = Number(process.env.BROWSER_STEP_TIMEOUT_MS) || 30_000;
const ignoreHTTPS = /^(1|true)$/i.test(process.env.BROWSER_IGNORE_HTTPS_ERRORS || '');
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json'
};
const encoder = new TextEncoder();
const uploaded = new Map([
  ['README', 'Uploaded text without a suffix.\n'],
  ['events.LOG', 'UTF-8 café 日本語 🧪\n'],
  ['.Rprofile', 'options(width = 90)\n'],
  ['settings.json', '{"answer":42}\n'],
  ['table.CSV', 'name,value\neditor,42\n'],
  ['utf8-bom.DATA', '\uFEFFfirst,second\r\n1,2\r\n']
]);
const generated = new Map([
  ['from-R', 'R-created text without a suffix.\n'],
  ['from-R.LOG', 'R-created log café\n'],
  ['.runtime-settings', 'runtime=true\n'],
  ['r-config.json', '{"created":"in R"}\n'],
  ['r-table.CSV', 'name,value\nfrom-r,17\n'],
  ['r-unknown.blob', 'Text despite an unfamiliar extension.\n'],
  ['r-bom.odd', '\uFEFFsaved BOM\r\n'],
  ['literal\\name.DATA', 'Literal POSIX backslash filename.\n']
]);
const legacyText = 'A legacy saved byte record is still UTF-8 text.\n';
const binary = Uint8Array.from([0, 1, 2, 127, 128, 255, 10, 13]);
const utf16 = Uint8Array.from([0xff, 0xfe, 0x48, 0, 0x69, 0, 0x0a, 0]);
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://fixture.invalid').pathname);
    if (!path.startsWith(prefix)) throw new Error('Unknown test path.');
    if (path === `${prefix}seed.html`) {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>File Open regression setup</title>');
      return;
    }
    const file = resolve(root, path.slice(prefix.length) || 'index.html');
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
const downloads = [];

async function bounded(promise, label, timeout = stepTimeout) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout / 1000} seconds.`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function ready() {
  await page.waitForFunction(() => globalThis.webRStudio
    && ['ready', 'error'].includes(document.querySelector('#r-status')?.dataset.state), null, { timeout: bootTimeout });
  assert.equal(await page.evaluate(() => webRStudio.engine.ready), true);
  await page.waitForFunction(() => !webRStudio.engine.running && !webRStudio.runtimeFilesLoading && !webRStudio.fileMutationPending);
}

const row = path => page.locator(`#file-tree .file-row[data-path=${JSON.stringify(path)}]`);
async function menuAction(path, label) {
  await page.waitForFunction(() => !webRStudio.engine.running && !webRStudio.runtimeFilesLoading && !webRStudio.fileMutationPending);
  await row(path).click({ button: 'right' });
  await page.locator('#context-menu').getByRole('button', { name: label, exact: true }).click();
}

async function openText(path, text) {
  stage = `Open ${path}`;
  await menuAction(path, 'Open');
  await page.waitForFunction(path => webRStudio.activePath === path && webRStudio.editor.activePath === path
    && !webRStudio.runtimeFilesLoading && !webRStudio.fileMutationPending, path);
  const state = await page.evaluate(path => ({
    text: webRStudio.editor.getValue(), type: webRStudio.files.get(path).type,
    dirty: webRStudio.files.get(path).dirty
  }), path);
  assert.equal(state.text, text.replace(/\r\n?/g, '\n'), `${path} must display decoded text, never a byte-number list.`);
  assert.equal(state.type, 'text');
  assert.equal(state.dirty, false, 'Opening a text file must not change its saved content.');
}

async function savedAndRuntimeBytes(path) {
  return bounded(page.evaluate(async path => {
    const { APP_VERSION } = await import('./js/config.js');
    const { workspaceDB } = await import(`./js/db.js?v=${APP_VERSION}`);
    const stored = await workspaceDB.getFile(path);
    const saved = stored && (typeof stored.content === 'string'
      ? new TextEncoder().encode(stored.content) : new Uint8Array(stored.content));
    return { saved: saved ? Array.from(saved) : null,
      runtime: Array.from(await webRStudio.engine.webR.FS.readFile(`/project/${path}`)) };
  }, path), `Read exact bytes for ${path}`);
}

async function assertExactBytes(path, bytes) {
  const actual = await savedAndRuntimeBytes(path);
  assert.deepEqual(actual.saved, Array.from(bytes), `${path}: persisted bytes must be unchanged.`);
  assert.deepEqual(actual.runtime, Array.from(bytes), `${path}: R filesystem bytes must be unchanged.`);
}

async function blockedOpen(path, message) {
  const active = await page.evaluate(() => webRStudio.activePath);
  const downloadCount = downloads.length;
  await menuAction(path, 'Open');
  await page.waitForFunction(({ path, message }) => [...document.querySelectorAll('#toast-region .toast')]
    .some(toast => toast.textContent.includes(path) && toast.textContent.includes(message)), { path, message });
  assert.equal(await page.evaluate(() => webRStudio.activePath), active);
  assert.equal(downloads.length, downloadCount, 'Open must not start a surprise download.');
}

try {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...(ignoreHTTPS ? ['--ignore-certificate-errors'] : [])]
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: ignoreHTTPS, acceptDownloads: true });
  page = await context.newPage();
  page.setDefaultTimeout(stepTimeout);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.goto(`${origin}${prefix}seed.html`);
  await bounded(page.evaluate(async legacyText => {
    const { APP_VERSION } = await import('./js/config.js');
    const { workspaceDB } = await import(`./js/db.js?v=${APP_VERSION}`);
    await workspaceDB.set('settings', { checkpointEnvironment: false, restoreEnvironment: false });
    const content = new TextEncoder().encode(legacyText);
    await workspaceDB.putFile({ path: 'legacy.UNKNOWN', content, type: 'binary',
      mime: 'application/octet-stream', size: content.byteLength, updatedAt: Date.now() });
  }, legacyText), 'Seed legacy saved byte record');
  console.log('Starting actual webR Studio for content-aware file Open checks.');
  await page.goto(`${origin}${prefix}`, { waitUntil: 'domcontentloaded', timeout: bootTimeout });
  await ready();
  await openText('legacy.UNKNOWN', legacyText);

  stage = 'Upload text and misleading binary files';
  await page.locator('#file-input').setInputFiles([
    ...[...uploaded].map(([name, text]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(encoder.encode(text)) })),
    { name: 'pretend.txt', mimeType: 'text/plain', buffer: Buffer.from(binary) },
    { name: 'utf16.txt', mimeType: 'text/plain', buffer: Buffer.from(utf16) }
  ]);
  await row('utf16.txt').waitFor({ state: 'visible' });
  for (const [path, text] of uploaded) await openText(path, text);
  await blockedOpen('pretend.txt', 'is binary or is not valid UTF-8 text');
  await blockedOpen('utf16.txt', 'uses UTF-16 LE');
  await assertExactBytes('utf8-bom.DATA', encoder.encode(uploaded.get('utf8-bom.DATA')));
  await assertExactBytes('pretend.txt', binary);
  await assertExactBytes('utf16.txt', utf16);
  assert.deepEqual(downloads, []);
  console.log('Uploads: no suffix, uppercase .LOG/.CSV, dotfile, JSON, UTF-8 BOM and Unicode open as text; binary and UTF-16 explain the limitation without downloading.');

  stage = 'Write files using real R';
  const code = [...generated].map(([path, text]) =>
    `writeBin(as.raw(c(${[...encoder.encode(text)].join(',')})), ${JSON.stringify(path)})`
  ).join('\n') + `\nwriteBin(as.raw(c(${[...binary].join(',')})), "r-pretend.txt")`
    + `\nwriteBin(charToRaw(strrep("L", ${MAX_EDITOR_BYTES + 1})), "too-large.log")`;
  const result = await bounded(page.evaluate(code => webRStudio.executeCode(code), code), stage);
  assert.equal(result?.ok, true, JSON.stringify(result));
  for (const [path, text] of generated) {
    await openText(path, text);
    await assertExactBytes(path, encoder.encode(text));
  }
  await blockedOpen('r-pretend.txt', 'is binary or is not valid UTF-8 text');
  await blockedOpen('too-large.log', 'File too large for the editor');
  await assertExactBytes('r-pretend.txt', binary);
  assert.deepEqual(downloads, []);
  console.log('R-generated text uses the editor for ordinary Open, including CSV and exact POSIX names; original bytes are backed up and the 4 MB editor limit is explicit.');

  stage = 'Explicit data viewer and Download remain available';
  await menuAction('r-table.CSV', 'Open in data viewer');
  await page.waitForFunction(() => document.querySelector('#panel-data').classList.contains('active')
    && document.querySelector('#data-viewer').textContent.includes('from-r'));
  const downloadEvent = page.waitForEvent('download');
  await menuAction('pretend.txt', 'Download');
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), 'pretend.txt');
  assert.deepEqual(Array.from(await readFile(await download.path())), Array.from(binary));
  assert.deepEqual(downloads, ['pretend.txt']);

  stage = 'Reload and restore saved content';
  console.log('Reloading the actual app to verify saved text classification and exact BOM/binary restoration.');
  await page.waitForFunction(() => !webRStudio.hasUnsavedProjectChanges());
  await page.reload({ waitUntil: 'domcontentloaded', timeout: bootTimeout });
  await ready();
  for (const [path, text] of [
    ['legacy.UNKNOWN', legacyText], ['README', uploaded.get('README')],
    ['utf8-bom.DATA', uploaded.get('utf8-bom.DATA')],
    ['from-R', generated.get('from-R')], ['r-table.CSV', generated.get('r-table.CSV')],
    ['r-bom.odd', generated.get('r-bom.odd')], ['.runtime-settings', generated.get('.runtime-settings')],
    ['literal\\name.DATA', generated.get('literal\\name.DATA')]
  ]) {
    await openText(path, text);
    await assertExactBytes(path, encoder.encode(text));
  }
  await blockedOpen('pretend.txt', 'is binary or is not valid UTF-8 text');
  await blockedOpen('utf16.txt', 'uses UTF-16 LE');
  await assertExactBytes('pretend.txt', binary);
  await assertExactBytes('utf16.txt', utf16);
  assert.deepEqual(downloads, ['pretend.txt']);
  assert.deepEqual(pageErrors, [], 'No uncaught browser errors are expected.');
  console.log('Content-aware file Open browser regression passed.');
} catch (error) {
  console.error(`Failed stage: ${stage}`);
  if (page) console.error('File Open state:', await bounded(page.evaluate(() => ({
    ready: globalThis.webRStudio?.engine.ready, running: globalThis.webRStudio?.engine.running,
    activePath: globalThis.webRStudio?.activePath,
    files: globalThis.webRStudio ? [...webRStudio.files.keys()] : [],
    status: document.querySelector('#r-status')?.textContent,
    explorer: document.querySelector('#explorer-file-status')?.textContent,
    toasts: document.querySelector('#toast-region')?.textContent
  })), 'Read failure diagnostics', 5000).catch(() => 'Page unavailable.'));
  console.error(diagnostics.slice(-10).join('\n'));
  throw error;
} finally {
  await browser?.close();
  await new Promise(done => { server.close(done); server.closeAllConnections(); });
}
