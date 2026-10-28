/**
 * Real-webR regression for failed lazy package metadata downloads.
 * Exercises SharedArrayBuffer and PostMessage workers. Only the deliberate
 * package-download failure and the success fixture's library path are injected;
 * filesystem access, R package inspection, output, and restart are real.
 *
 * PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node tests/browser-package-inspection-check.mjs
 * BROWSER_IGNORE_HTTPS_ERRORS=1 is only for an intercepting development proxy.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? require(resolve(process.env.PLAYWRIGHT_MODULE)) : await import('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://fixture.invalid').pathname;
  if (path.startsWith('/isolated/')) {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  response.setHeader('Cache-Control', 'no-store');
  const relative = decodeURIComponent(path).replace(/^\/(?:isolated|postmessage)\//, '');
  if (!relative || relative === 'index.html') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Package inspection regression</title>');
    return;
  }
  try {
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep)) throw new Error('Invalid fixture path.');
    response.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 400);
    response.end(error.message);
  }
});

async function bounded(promise, label, timeout = 20_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout / 1000} seconds.`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

let browser;
try {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ignoreHTTPS = /^(1|true)$/i.test(process.env.BROWSER_IGNORE_HTTPS_ERRORS || '');
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...(ignoreHTTPS ? ['--ignore-certificate-errors'] : [])]
  });

  for (const channel of ['isolated', 'postmessage']) {
    const context = await browser.newContext({ ignoreHTTPSErrors: ignoreHTTPS });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${origin}/${channel}/`);
    await page.evaluate(() => {
      import('./js/webr-engine.js').then(async ({ WebREngine }) => {
        globalThis.engine = new WebREngine();
        await engine.initialize();
        globalThis.ready = true;
      }).catch(error => { globalThis.startupError = error.message; });
    });
    await page.waitForFunction(() => globalThis.ready || globalThis.startupError, null, {
      timeout: Number(process.env.BROWSER_BOOT_TIMEOUT_MS) || 180_000
    });
    assert.deepEqual(await page.evaluate(() => ({ ready: globalThis.ready, error: globalThis.startupError })), {
      ready: true, error: undefined
    });
    assert.equal(await page.evaluate(() => engine.interruptSupported), channel === 'isolated');

    const result = await bounded(page.evaluate(async () => {
      const uncaptured = { captureStreams: false };
      const first = await engine.execute('saved_scalar <- 42; print(1 + 1)');
      const checkpoint = await engine.checkpointEnvironment();
      await engine.restart();
      await engine.restoreEnvironment(checkpoint);
      await engine.execute('options(warn = 2)');

      // This is the same status-0 primitive result returned by the download
      // bridge on transport failure. The real lazy VFS mount then throws.
      const hook = `(() => {
        const download = Module.downloadFileContent;
        Module.packageFailureFixture = [];
        Module.downloadFileContent = function(url, ...args) {
          if (String(url).endsWith('/parallel.js.metadata')) {
            Module.packageFailureFixture.push(String(url));
            return { status: 0, response: 'Deliberate package metadata download failure' };
          }
          return download.call(this, url, ...args);
        };
        return true;
      })()`;
      await engine.webR.evalRVoid(`webr::eval_js(${JSON.stringify(hook)})`, uncaptured);
      const snapshot = () => engine.webR.evalRString(
        'paste(sink.number(), sink.number(type="message"), nrow(showConnections(all=TRUE)), getwd(), saved_scalar, collapse="|")',
        uncaptured
      );
      const initial = await snapshot();
      await engine.webR.evalRVoid(`
        user_stdout <- file('/project/user-output.txt', 'w')
        user_stderr <- file('/project/user-message.txt', 'w')
        sink(user_stdout)
        sink(user_stderr, type = 'message')
      `, uncaptured);
      const before = await snapshot();
      let failure = '';
      try { await engine.getPackages(); }
      catch (error) { failure = error.message; }
      const after = await snapshot();
      await engine.webR.evalRVoid(`
        cat('user stdout preserved\\n')
        cat('user stderr preserved\\n', file = stderr())
        sink()
        sink(type = 'message')
        close(user_stdout)
        close(user_stderr)
      `, uncaptured);
      const restored = await snapshot();
      const stdout = new TextDecoder().decode(await engine.webR.FS.readFile('/project/user-output.txt'));
      const stderr = new TextDecoder().decode(await engine.webR.FS.readFile('/project/user-message.txt'));
      const attempts = await engine.webR.evalRNumber('webr::eval_js("Module.packageFailureFixture.length")', uncaptured);
      // Interactive execution observes the persistent warn option. evalR*
      // would temporarily set warn=1 while measuring it and mask a regression.
      const next = await engine.execute('print(getOption("warn")); print(saved_scalar); print(1 + 1)');

      // Use an explicit, local metadata library for a deterministic successful
      // inspection. Only discovery of its path is injected; installed.packages
      // reads actual RDS files and returns the real R records.
      const library = '/project/package-fixture';
      await engine.webR.evalRVoid(`
        dir.create('${library}/base/Meta', recursive = TRUE)
        dir.create('${library}/webrStudioFixture/Meta', recursive = TRUE)
        saveRDS(list(DESCRIPTION = c(Package = 'base', Version = '9.8.7', Priority = 'base')), '${library}/base/Meta/package.rds')
        saveRDS(list(DESCRIPTION = c(Package = 'webrStudioFixture', Version = '1.2.3', Priority = 'optional')), '${library}/webrStudioFixture/Meta/package.rds')
      `, uncaptured);
      const evalRaw = engine.webR.evalRRaw.bind(engine.webR);
      const readFile = engine.webR.FS.readFile.bind(engine.webR.FS);
      const metadataReads = [];
      engine.webR.evalRRaw = (code, ...args) => code === 'base::.libPaths()'
        ? Promise.resolve([library]) : evalRaw(code, ...args);
      engine.webR.FS.readFile = (path, ...args) => {
        metadataReads.push(path);
        return readFile(path, ...args);
      };
      let packages;
      try { packages = await engine.getPackages(); }
      finally {
        engine.webR.evalRRaw = evalRaw;
        engine.webR.FS.readFile = readFile;
      }
      const final = await engine.execute('print(getOption("warn")); print(1 + 1)');
      return { first, initial, before, after, restored, failure, stdout, stderr, attempts, next, packages, metadataReads, final };
    }), `${channel} package failure and restart`, 90_000);

    assert.equal(result.first.ok, true);
    assert.match(result.failure, /filesystem image metadata/i);
    assert.equal(result.attempts, 1);
    assert.equal(result.before, result.after, 'User sinks, connection count, working directory and R objects must survive the failed query.');
    assert.equal(result.initial, result.restored, 'Closing only the fixture user sinks must return to the original state.');
    assert.equal(result.stdout, 'user stdout preserved\n');
    assert.equal(result.stderr, 'user stderr preserved\n');
    assert.equal(result.next.ok, true, result.next.error);
    assert.equal(result.next.outputs.map(item => item.text).join('\n'), '[1] 2\n[1] 42\n[1] 2');
    assert.deepEqual(result.packages, [
      { name: 'base', version: '9.8.7', loaded: true, bundled: true },
      { name: 'webrStudioFixture', version: '1.2.3', loaded: false, bundled: false }
    ]);
    assert.deepEqual(result.metadataReads, [
      '/project/package-fixture/base/Meta/package.rds',
      '/project/package-fixture/webrStudioFixture/Meta/package.rds'
    ]);
    assert.equal(result.final.ok, true, result.final.error);
    assert.equal(result.final.outputs.map(item => item.text).join('\n'), '[1] 2\n[1] 2');
    assert.deepEqual(pageErrors, []);
    console.log(`${channel}: failed lazy package download preserved R sinks, warning option, connection count and objects; restart/output and successful metadata listing passed.`);
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise(done => { server.close(done); server.closeAllConnections(); });
}
