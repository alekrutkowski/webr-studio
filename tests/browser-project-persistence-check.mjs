/**
 * Real-app regression for automatic /project backups. Uses real webR,
 * IndexedDB, Ace, and actual page reloads. Failure injection is confined to
 * filesystem reads, transaction cloning, and a runtime-generation boundary.
 * No R evaluator or backup implementation is mocked.
 *
 * PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node tests/browser-project-persistence-check.mjs
 * BROWSER_IGNORE_HTTPS_ERRORS=1 is only for an intercepting development proxy.
 * PROJECT_BACKUP_LARGE=1 also backs up and reloads a file larger than 100 MiB.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? require(resolve(process.env.PLAYWRIGHT_MODULE)) : await import('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = '/project-persistence-regression/';
const bootTimeout = Number(process.env.BROWSER_BOOT_TIMEOUT_MS) || 180_000;
const stepTimeout = Number(process.env.BROWSER_STEP_TIMEOUT_MS) || 60_000;
const ignoreHTTPS = /^(1|true)$/i.test(process.env.BROWSER_IGNORE_HTTPS_ERRORS || '');
const large = /^(1|true)$/i.test(process.env.PROJECT_BACKUP_LARGE || '');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json'
};
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://fixture.invalid').pathname);
    if (path === `${prefix}__seed__.html`) {
      response.setHeader('Content-Type', types['.html']);
      response.end('<!doctype html><title>Isolated project backup regression</title>');
      return;
    }
    if (!path.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
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
const pageErrors = [];
const diagnostics = [];
const unloadDialogs = [];
const bytesOf = value => Array.from(new TextEncoder().encode(value));
const quoteR = value => JSON.stringify(value);

async function bounded(promise, label = stage, timeout = stepTimeout) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout / 1000} seconds.`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function idle() {
  await page.waitForFunction(() => globalThis.webRStudio?.engine.ready
    && !webRStudio.engine.running && !webRStudio.fileMutationPending
    && !webRStudio.projectSnapshotInProgress && !webRStudio.runtimeFilesLoading,
  null, { timeout: stepTimeout });
}

async function backedUp(timeout = stepTimeout) {
  await page.waitForFunction(() => globalThis.webRStudio?.projectPersistenceReady
    && !webRStudio.hasUnsavedProjectChanges() && !webRStudio.runtimeFilesLoading,
  null, { timeout });
}

async function attachFixture() {
  await page.evaluate(async () => {
    const { APP_VERSION } = await import('./js/config.js');
    const { workspaceDB } = await import(`./js/db.js?v=${APP_VERSION}`);
    globalThis.__projectPersistenceQA = {
      db: workspaceDB,
      bytes: content => typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content)
    };
  });
}

async function waitForRuntime() {
  await page.waitForFunction(() => globalThis.webRStudio
    && document.querySelector('#boot-screen').hidden
    && (webRStudio.projectPersistenceReady || document.querySelector('#r-status').dataset.state === 'error'),
  null, { timeout: bootTimeout });
  const state = await page.evaluate(() => ({
    ready: webRStudio.engine.ready, backupReady: webRStudio.projectPersistenceReady,
    backupError: webRStudio.projectPersistenceError, isolated: crossOriginIsolated
  }));
  assert.equal(state.ready, true, JSON.stringify(state));
  assert.equal(state.backupReady, true, JSON.stringify(state));
  assert.equal(state.isolated, true, JSON.stringify(state));
  await idle();
  await backedUp(bootTimeout);
  await attachFixture();
}

async function runR(code, timeout = stepTimeout) {
  await idle();
  const result = await bounded(page.evaluate(code => webRStudio.executeCode(code), code), stage, timeout);
  assert.equal(result?.ok, true, JSON.stringify(result));
  await backedUp(timeout);
  return result;
}

async function runtimeBytes(path) {
  return bounded(page.evaluate(async path => {
    try { return Array.from(await webRStudio.engine.webR.FS.readFile(`/project/${path}`)); }
    catch { return null; }
  }, path), `Read runtime ${path}`);
}

async function storedBytes(path) {
  return bounded(page.evaluate(async path => {
    const record = await __projectPersistenceQA.db.getFile(path);
    return record ? Array.from(__projectPersistenceQA.bytes(record.content)) : null;
  }, path), `Read backup ${path}`);
}

async function backupState() {
  return bounded(page.evaluate(async () => ({
    files: (await __projectPersistenceQA.db.listFiles()).map(file => ({
      path: file.path, bytes: Array.from(__projectPersistenceQA.bytes(file.content))
    })),
    directories: (await __projectPersistenceQA.db.get('projectDirectories', [])).slice().sort()
  })), 'Inspect committed project backup');
}

async function refresh() {
  await idle();
  return bounded(page.evaluate(() => webRStudio.refreshRuntimeFiles('/project', { quiet: true })));
}

async function reload() {
  await idle();
  await backedUp();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: bootTimeout });
  await waitForRuntime();
  assert.deepEqual(unloadDialogs, [], 'A fully committed backup must not prompt on reload.');
}

async function assertUnloadWarning(expected) {
  const cancelled = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(cancelled, expected, 'The unload guard must reflect actual unsaved project work.');
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: ignoreHTTPS });
  page = await context.newPage();
  page.setDefaultTimeout(stepTimeout);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
  page.on('dialog', async dialog => {
    if (dialog.type() === 'beforeunload') unloadDialogs.push(dialog.message());
    await dialog.accept();
  });
  await page.goto(`${origin}${prefix}__seed__.html`);
  await page.evaluate(async () => {
    const request = indexedDB.open('webr-studio', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('kv', { keyPath: 'key' });
      db.createObjectStore('files', { keyPath: 'path' }).createIndex('updatedAt', 'updatedAt');
      db.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
    };
    const db = await new Promise((done, reject) => {
      request.onsuccess = () => done(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction('kv', 'readwrite');
    transaction.objectStore('kv').put({ key: 'settings', value: {
      checkpointEnvironment: false, restoreEnvironment: false, autosaveDelay: 700
    } });
    await new Promise((done, reject) => {
      transaction.oncomplete = done;
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  });
  await page.goto(`${origin}${prefix}`, { waitUntil: 'domcontentloaded', timeout: bootTimeout });
  await waitForRuntime();
  console.log('Real webR and automatic project backup initialized.');

  stage = 'all project file types and exact paths';
  const fixtures = new Map([
    ['generated/nested/no-extension', bytesOf('plain text without an extension\n')],
    ['generated/nested/settings.ini', bytesOf('[settings]\nanswer=42\n')],
    ['generated/nested/bytes.bin', [0, 1, 127, 128, 255, 10, 13]],
    ['generated/nested/empty-file', []],
    ['.hidden-project-file', bytesOf('hidden files also persist\n')],
    ['résumé/notes.data', bytesOf('café 日本語 🧪\r\n')],
    ['literal\\name.txt', bytesOf('literal backslash filename\n')],
    ['script\\identity.R', bytesOf('literal_source_result <- 739L\n')],
    ['utf8-bom.txt', bytesOf('\uFEFFfirst\r\nsecond\r\n')],
    ['utf16-bom.txt', [0xff, 0xfe, 0x41, 0, 0x0a, 0]],
    ['same-size.txt', bytesOf('AAAA\n')],
    ['remove-me.txt', bytesOf('remove after the first backup\n')],
    ['rename-me.txt', bytesOf('rename without changing bytes\n')],
    ['dirty.R', bytesOf('editor_value <- 1\n')],
    ['abort-delete.txt', bytesOf('must survive an aborted backup\n')],
    ['generation.txt', bytesOf('old generation\n')]
  ]);
  const directories = ['generated/nested/empty-directory', 'empty-root', 'résumé'];
  const create = directories.map(path => `dir.create(${quoteR(path)}, recursive = TRUE, showWarnings = FALSE)`);
  for (const [path, bytes] of fixtures) {
    create.push(`writeBin(${bytes.length ? `as.raw(c(${bytes.join(',')}))` : 'raw(0)'}, ${quoteR(path)})`);
  }
  await runR(create.join('\n'));
  for (const [path, bytes] of fixtures) assert.deepEqual(await storedBytes(path), bytes, `Automatic backup must contain ${path}.`);
  const savedDirectories = await page.evaluate(() => __projectPersistenceQA.db.get('projectDirectories', []));
  for (const path of directories) assert.ok(savedDirectories.includes(path), `Empty directory ${path} must be recorded.`);
  assert.equal(await storedBytes('literal/name.txt'), null, 'A literal backslash must not create a normalized alias.');
  await assertUnloadWarning(false);

  stage = 'source a file whose name contains a literal backslash';
  const sourced = await bounded(page.evaluate(async () => {
    webRStudio.openFile('script\\identity.R');
    return webRStudio.sourceActiveFile();
  }));
  assert.equal(sourced?.ok, true, JSON.stringify(sourced));
  await backedUp();
  assert.equal(await bounded(page.evaluate(() => webRStudio.engine.webR.evalRNumber('literal_source_result'))), 739);

  stage = 'actual page reload restores bytes and empty directories';
  await reload();
  for (const [path, bytes] of fixtures) assert.deepEqual(await runtimeBytes(path), bytes, `Reload must restore ${path} byte-for-byte.`);
  for (const path of directories) {
    assert.equal(await page.evaluate(async path => Boolean((await webRStudio.engine.statVirtualFile(`/project/${path}`))?.isDirectory), path), true);
  }
  assert.equal(await runtimeBytes('literal/name.txt'), null);
  console.log('Automatic backup and real reload preserved text, binary, empty files/directories, hidden files, UTF-8/UTF-16 bytes, Unicode, and literal backslashes.');

  stage = 'same-size timestamp-preserving writes and R-side delete/rename';
  await runR(`
    old_mtime <- file.info("same-size.txt")$mtime
    writeBin(charToRaw("BBBB\\n"), "same-size.txt")
    stopifnot(Sys.setFileTime("same-size.txt", old_mtime))
    unlink("remove-me.txt")
    stopifnot(file.rename("rename-me.txt", "renamed-by-R.txt"))
  `);
  assert.deepEqual(await storedBytes('same-size.txt'), bytesOf('BBBB\n'));
  assert.equal(await storedBytes('remove-me.txt'), null);
  assert.equal(await storedBytes('rename-me.txt'), null);
  assert.deepEqual(await storedBytes('renamed-by-R.txt'), fixtures.get('rename-me.txt'));
  await reload();
  assert.deepEqual(await runtimeBytes('same-size.txt'), bytesOf('BBBB\n'));
  assert.equal(await runtimeBytes('remove-me.txt'), null, 'Deleted runtime files must not return after reload.');
  assert.equal(await runtimeBytes('rename-me.txt'), null);
  assert.deepEqual(await runtimeBytes('renamed-by-R.txt'), fixtures.get('rename-me.txt'));
  console.log('Same-size/same-mtime replacements, R-side deletions, and renames survived reload.');

  stage = 'dirty editor priority during a runtime snapshot';
  const draft = 'editor_value <- 42\n';
  await page.evaluate(draft => {
    webRStudio.openFile('dirty.R');
    webRStudio.editor.setValue(draft);
    webRStudio.onEditorChange('dirty.R', draft);
    webRStudio.autosaveDebounced.cancel();
    webRStudio.projectBackupDebounced.cancel();
  }, draft);
  await bounded(page.evaluate(() => webRStudio.engine.webR.evalRVoid('writeLines("runtime_value <- 99", "dirty.R")')));
  await refresh();
  const dirty = await page.evaluate(() => ({ value: webRStudio.editor.getValue(), dirty: webRStudio.files.get('dirty.R').dirty }));
  assert.deepEqual(dirty, { value: draft, dirty: true });
  assert.deepEqual(await storedBytes('dirty.R'), fixtures.get('dirty.R'), 'A snapshot must not replace the protected draft with the runtime version.');
  await assertUnloadWarning(true);
  await bounded(page.evaluate(async () => {
    await webRStudio.saveFile('dirty.R');
    await webRStudio.flushProjectBackup();
  }));
  await backedUp();
  assert.deepEqual(await runtimeBytes('dirty.R'), bytesOf(draft));
  assert.deepEqual(await storedBytes('dirty.R'), bytesOf(draft));

  stage = 'failed filesystem read preserves old backup and refuses stale Open';
  const beforeReadFailure = await backupState();
  await bounded(page.evaluate(async () => {
    const app = webRStudio;
    app.projectBackupDebounced.cancel();
    await app.engine.webR.evalRVoid('writeLines("new runtime bytes", "same-size.txt"); dir.create("read-failure-new-directory")');
    __projectPersistenceQA.originalRead = app.engine.readVirtualFile;
    app.engine.readVirtualFile = async function(path) {
      if (path === '/project/same-size.txt') throw new Error('Deliberate project read failure');
      return __projectPersistenceQA.originalRead.call(this, path);
    };
    await app.refreshRuntimeFiles('/project', { quiet: true });
  }));
  assert.deepEqual(await backupState(), beforeReadFailure, 'A failed read must not partially publish file or directory changes.');
  assert.match(await page.evaluate(() => webRStudio.projectPersistenceError), /Deliberate project read failure/);
  await assertUnloadWarning(true);
  await bounded(page.evaluate(() => webRStudio.openExplorerFile('same-size.txt')));
  assert.equal(await page.evaluate(() => webRStudio.activePath), 'dirty.R', 'Open must not display stale saved bytes after a failed runtime refresh.');
  await page.evaluate(() => { webRStudio.engine.readVirtualFile = __projectPersistenceQA.originalRead; });
  await refresh();
  await backedUp();
  assert.deepEqual(await storedBytes('same-size.txt'), bytesOf('new runtime bytes\n'));

  stage = 'real IndexedDB cloning failure rolls back all snapshot changes';
  const beforeTransactionFailure = await backupState();
  await bounded(page.evaluate(async () => {
    const app = webRStudio;
    const fixture = __projectPersistenceQA;
    app.projectBackupDebounced.cancel();
    await app.engine.webR.evalRVoid('writeLines("atomic replacement", "same-size.txt"); writeLines("new file", "abort-new.txt"); unlink("abort-delete.txt"); dir.create("abort-new-directory")');
    fixture.originalCommit = fixture.db.commitProjectSnapshot;
    fixture.db.commitProjectSnapshot = function(snapshot, guard) {
      // The production transaction has already queued valid file deletions
      // and writes when this final uncloneable record raises DataCloneError.
      return fixture.originalCommit.call(this, {
        ...snapshot, files: [...snapshot.files, { path: 'uncloneable-fixture.bin', content: () => {} }]
      }, guard);
    };
    await app.refreshRuntimeFiles('/project', { quiet: true });
  }));
  assert.deepEqual(await backupState(), beforeTransactionFailure, 'The native transaction must roll back prior puts, deletes, and the directory manifest.');
  assert.ok(await page.evaluate(() => webRStudio.projectPersistenceError));
  await assertUnloadWarning(true);
  await page.evaluate(() => { __projectPersistenceQA.db.commitProjectSnapshot = __projectPersistenceQA.originalCommit; });
  await refresh();
  await backedUp();
  assert.equal(await storedBytes('abort-delete.txt'), null);
  assert.deepEqual(await storedBytes('abort-new.txt'), bytesOf('new file\n'));
  assert.deepEqual(await storedBytes('same-size.txt'), bytesOf('atomic replacement\n'));
  console.log('Dirty editor priority, failed-read retention, stale-Open prevention, real IndexedDB rollback, and successful retry passed.');

  stage = 'invalid workspace import leaves automatic backup active';
  const beforeImportFailure = await backupState();
  const invalidImport = await bounded(page.evaluate(async () => {
    const app = webRStudio;
    const runtime = app.engine.webR;
    const generation = app.engine.generation;
    let failure = '';
    try {
      await app.applyWorkspaceState({ format: 'webr-studio-workspace',
        files: [{ path: '../escape.txt', encoding: 'utf8', content: 'invalid replacement' }] });
    } catch (error) { failure = error.message; }
    return { failure, sameRuntime: runtime === app.engine.webR,
      sameGeneration: generation === app.engine.generation,
      backupReady: app.projectPersistenceReady, mutation: app.fileMutationPending };
  }));
  assert.match(invalidImport.failure, /canonical|inside \/project|parent-directory/i);
  assert.deepEqual({ ...invalidImport, failure: '' }, {
    failure: '', sameRuntime: true, sameGeneration: true, backupReady: true, mutation: false
  });
  assert.deepEqual(await backupState(), beforeImportFailure);

  stage = 'rejected workspace replacement leaves automatic backup active';
  const rejectedImport = await bounded(page.evaluate(async () => {
    const app = webRStudio;
    const fixture = __projectPersistenceQA;
    const runtime = app.engine.webR;
    const generation = app.engine.generation;
    const originalCommit = fixture.db.commitProjectSnapshot;
    app.projectBackupDebounced.cancel();
    fixture.db.commitProjectSnapshot = function(snapshot, guard) {
      return originalCommit.call(this, {
        ...snapshot, files: [...snapshot.files, { path: 'uncloneable-import.bin', content: () => {} }]
      }, guard);
    };
    let failure = '';
    try {
      await app.applyWorkspaceState({ format: 'webr-studio-workspace',
        files: [{ path: 'rejected-replacement.txt', encoding: 'utf8', content: 'must not replace the old project' }],
        directories: ['rejected-replacement-directory'] });
    } catch (error) { failure = error.name; }
    finally { fixture.db.commitProjectSnapshot = originalCommit; }
    return { failure, sameRuntime: runtime === app.engine.webR,
      sameGeneration: generation === app.engine.generation,
      backupReady: app.projectPersistenceReady, mutation: app.fileMutationPending };
  }));
  assert.deepEqual(rejectedImport, {
    failure: 'DataCloneError', sameRuntime: true, sameGeneration: true, backupReady: true, mutation: false
  });
  assert.deepEqual(await backupState(), beforeImportFailure, 'A rejected replacement must retain all original files and directory metadata.');
  assert.equal(await runtimeBytes('rejected-replacement.txt'), null);
  await runR('writeLines("automatic backup still works", "after-rejected-import.txt")');
  assert.deepEqual(await storedBytes('after-rejected-import.txt'), bytesOf('automatic backup still works\n'));
  assert.deepEqual(await runtimeBytes('dirty.R'), bytesOf(draft));
  assert.equal(await storedBytes('rejected-replacement.txt'), null);
  console.log('Invalid-path and native transaction failures during workspace import preserved the original runtime and its automatic backup.');

  stage = 'an obsolete runtime generation cannot publish a delayed snapshot';
  const beforeStaleSnapshot = await backupState();
  await bounded(page.evaluate(async () => {
    const app = webRStudio;
    const fixture = __projectPersistenceQA;
    app.projectBackupDebounced.cancel();
    await app.engine.webR.evalRVoid('writeLines("new generation bytes", "generation.txt")');
    fixture.originalRead = app.engine.readVirtualFile;
    fixture.blocked = false;
    fixture.release = null;
    app.engine.readVirtualFile = async function(path) {
      const bytes = await fixture.originalRead.call(this, path);
      if (path === '/project/generation.txt') {
        fixture.blocked = true;
        await new Promise(done => { fixture.release = done; });
      }
      return bytes;
    };
    fixture.delayedSnapshot = app.refreshRuntimeFiles('/project', { quiet: true });
  }));
  await page.waitForFunction(() => __projectPersistenceQA.blocked);
  await page.evaluate(() => {
    // Exercise the same generation guard used when a worker is replaced,
    // without waiting for another complete webR boot just for this boundary.
    webRStudio.projectPersistenceReady = false;
    webRStudio.engine.generation += 1;
    __projectPersistenceQA.release();
  });
  await bounded(page.evaluate(() => __projectPersistenceQA.delayedSnapshot));
  assert.deepEqual(await backupState(), beforeStaleSnapshot);
  await page.evaluate(() => {
    webRStudio.engine.readVirtualFile = __projectPersistenceQA.originalRead;
    webRStudio.projectPersistenceReady = true;
  });
  await refresh();
  await backedUp();
  assert.deepEqual(await storedBytes('generation.txt'), bytesOf('new generation bytes\n'));

  stage = 'idle restart restores the latest complete project';
  assert.equal(await bounded(page.evaluate(() => webRStudio.restartRuntime(false)), stage, bootTimeout), true);
  await waitForRuntime();
  assert.deepEqual(await runtimeBytes('dirty.R'), bytesOf(draft));
  assert.deepEqual(await runtimeBytes('generation.txt'), bytesOf('new generation bytes\n'));
  assert.equal(await runtimeBytes('abort-delete.txt'), null);
  assert.equal(await page.evaluate(async () => (await webRStudio.engine.statVirtualFile('/project/empty-root'))?.isDirectory), true);
  console.log('Obsolete-generation rejection, retry, and an actual idle restart passed.');

  if (large) {
    stage = 'file larger than 100 MiB is backed up and restored';
    const chunks = 101;
    const chunkBytes = 1024 * 1024;
    const tail = [17, 128, 254];
    const expectedHash = createHash('sha256');
    const chunk = Buffer.alloc(chunkBytes);
    for (let index = 1; index <= chunks; index += 1) {
      chunk[0] = index;
      expectedHash.update(chunk);
    }
    expectedHash.update(Buffer.from(tail));
    const expected = { size: chunks * chunkBytes + tail.length, hash: expectedHash.digest('hex') };
    await runR(`local({
      output <- file("over-100MiB.bin", "wb")
      on.exit(close(output))
      chunk <- raw(${chunkBytes})
      for (i in seq_len(${chunks})) {
        chunk[1L] <- as.raw(i)
        writeBin(chunk, output)
      }
      writeBin(as.raw(c(${tail.join(',')})), output)
    })`, bootTimeout);
    const digest = async () => bounded(page.evaluate(async () => {
      const hash = async bytes => ({ size: bytes.byteLength,
        hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('') });
      const stored = await __projectPersistenceQA.db.getFile('over-100MiB.bin');
      const backup = await hash(__projectPersistenceQA.bytes(stored.content));
      const runtime = await hash(await webRStudio.engine.webR.FS.readFile('/project/over-100MiB.bin'));
      return { backup, runtime };
    }), stage, bootTimeout);
    assert.deepEqual(await digest(), { backup: expected, runtime: expected });
    await reload();
    assert.deepEqual(await digest(), { backup: expected, runtime: expected });
    console.log(`Optional large-file check passed: ${expected.size} bytes retained the exact SHA-256 across backup and page reload.`);
  }

  await assertUnloadWarning(false);
  assert.deepEqual(pageErrors, [], 'No uncaught browser errors are expected.');
  console.log('Automatic project persistence browser regression passed.');
} catch (error) {
  console.error(`Failed stage: ${stage}`);
  if (page) console.error('Project persistence state:', await bounded(page.evaluate(() => ({
    ready: globalThis.webRStudio?.engine.ready,
    running: globalThis.webRStudio?.engine.running,
    generation: globalThis.webRStudio?.engine.generation,
    persistenceReady: globalThis.webRStudio?.projectPersistenceReady,
    pending: globalThis.webRStudio?.projectPersistencePending,
    persistenceError: globalThis.webRStudio?.projectPersistenceError,
    snapshot: globalThis.webRStudio?.projectSnapshotInProgress,
    mutation: globalThis.webRStudio?.fileMutationPending,
    loading: globalThis.webRStudio?.runtimeFilesLoading,
    status: document.querySelector('#save-status')?.textContent,
    boot: document.querySelector('#boot-message')?.textContent,
    files: globalThis.webRStudio ? [...webRStudio.files.keys()] : []
  })), 'Read failure state', 5000).catch(() => 'Page unavailable.'));
  console.error(diagnostics.slice(-10).join('\n'));
  if (pageErrors.length) console.error(pageErrors.join('\n'));
  throw error;
} finally {
  await browser?.close();
  await new Promise(done => { server.close(done); server.closeAllConnections(); });
}
