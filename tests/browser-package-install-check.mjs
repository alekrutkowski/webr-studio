/**
 * Real-webR regression for console install.packages() startup routing.
 * Exercises isolated and PostMessage runtimes through the real interactive
 * evaluator. A temporary webr::install spy checks argument forwarding; the
 * original official installer then exercises missing-package warnings and a
 * controlled local HTTP 404. A local binary repository verifies that the
 * download.packages() adapter saves archives without installing them.
 *
 * PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node tests/browser-package-install-check.mjs
 * BROWSER_IGNORE_HTTPS_ERRORS=1 is only for an intercepting development proxy.
 * BROWSER_LIVE_PACKAGE_INSTALL=1 also downloads, installs, and uses real data.table once.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? require(resolve(process.env.PLAYWRIGHT_MODULE)) : await import('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const liveInstall = /^(1|true)$/i.test(process.env.BROWSER_LIVE_PACKAGE_INSTALL || '');
const bootTimeout = Number(process.env.BROWSER_BOOT_TIMEOUT_MS) || 180_000;
const stepTimeout = Number(process.env.BROWSER_STEP_TIMEOUT_MS) || 30_000;
const fixtureRequests = [];
const downloadRequests = [];
function packageArchive(name) {
  const contents = Buffer.from(`Package: ${name}\nVersion: 1.2.3\nTitle: Download-only fixture\nDescription: A controlled package archive.\nLicense: MIT\n`);
  const header = Buffer.alloc(512);
  header.write(`${name}/DESCRIPTION`);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(contents.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, contents, Buffer.alloc((512 - contents.length % 512) % 512 + 1024)]));
}
const archiveBytes = packageArchive('webrStudioArchiveFixture');
const archiveFileBytes = packageArchive('webrStudioFileFieldFixture');
const packageIndex = [
  'Package: webrStudioArchiveFixture\nVersion: 1.2.3\nLicense: MIT\nNeedsCompilation: no',
  'Package: webrStudioFileFieldFixture\nVersion: 1.2.3\nLicense: MIT\nNeedsCompilation: no\nFile: custom-archive.tgz'
].join('\n\n') + '\n';
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://fixture.invalid').pathname;
  response.setHeader('Cache-Control', 'no-store');
  if (path.startsWith('/download-fixture/')) {
    downloadRequests.push({ path, headers: request.headers });
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader('Content-Type', 'application/octet-stream');
    const filename = path.slice(path.lastIndexOf('/') + 1);
    if (filename === 'PACKAGES.gz') response.end(gzipSync(packageIndex));
    else if (filename === 'PACKAGES') response.end(packageIndex);
    else if (filename === 'webrStudioArchiveFixture_1.2.3.tgz') response.end(archiveBytes);
    else if (filename === 'custom-archive.tgz') response.end(archiveFileBytes);
    else { response.writeHead(404); response.end('Deliberate missing package fixture.'); }
    return;
  }
  if (path.startsWith('/package-fixture/')) {
    // The official installer must reach this real 404 through webR's download
    // path, rather than a mock throwing before the transfer is attempted.
    fixtureRequests.push(path);
    response.writeHead(404, {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    });
    response.end('Deliberate missing webR binary package fixture.');
    return;
  }
  if (path.startsWith('/isolated/')) {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  const relative = decodeURIComponent(path).replace(/^\/(?:isolated|postmessage)\//, '');
  if (!relative || relative === 'index.html') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Console package installation regression</title>');
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

async function bounded(promise, label, timeout = stepTimeout) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout / 1000} seconds.`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

const spyCode = `local({
  fixture <- new.env(parent = emptyenv())
  fixture$calls <- list()
  fixture$original <- webr::install
  installer <- function(packages, repos = NULL, info = NULL, lib = NULL, quiet = FALSE, mount = TRUE) {
    fixture$calls[[length(fixture$calls) + 1L]] <- list(
      packages = packages, repos = repos, info = info, lib = lib, quiet = quiet, mount = mount
    )
    invisible(NULL)
  }
  formals(installer) <- formals(fixture$original)
  namespace <- asNamespace('webr')
  locked <- bindingIsLocked('install', namespace)
  if (locked) unlockBinding('install', namespace)
  assign('install', installer, envir = namespace)
  if (locked) lockBinding('install', namespace)
  assign('.packageInstallFixture', fixture, envir = .GlobalEnv)
})`;

const restoreCode = `local({
  namespace <- asNamespace('webr')
  locked <- bindingIsLocked('install', namespace)
  if (locked) unlockBinding('install', namespace)
  assign('install', .packageInstallFixture$original, envir = namespace)
  if (locked) lockBinding('install', namespace)
})`;

let browser;
let page;
let channelName = '';
let activeStep = '';
const diagnostics = [];

async function execute(code, label, timeout = stepTimeout) {
  activeStep = label;
  return bounded(page.evaluate(async code => {
    const result = await engine.execute(code);
    globalThis.lastInstallTestResult = result;
    return result;
  }, code), `${channelName}: ${label}`, timeout);
}

async function checkR(code, label) {
  const result = await execute(`stopifnot(${code})`, label);
  assert.equal(result.ok, true, `${label}: ${result.error}`);
}

async function callCount() {
  return bounded(page.evaluate(() => engine.webR.evalRNumber('length(.packageInstallFixture$calls)')), 'Read installer call count');
}

async function checkLastPackages(names, label) {
  const actual = await bounded(page.evaluate(() => engine.webR.evalRRaw(
    'as.character(tail(.packageInstallFixture$calls, 1L)[[1L]]$packages)', 'string[]'
  )), 'Read forwarded package names');
  assert.deepEqual(actual, names, label);
}

async function checkStartup() {
  await checkR(`
    !exists('install.packages', envir = .GlobalEnv, inherits = FALSE),
    !exists('download.packages', envir = .GlobalEnv, inherits = FALSE),
    identical(install.packages, utils::install.packages),
    identical(download.packages, utils::download.packages),
    identical(names(formals(install.packages)), c('pkgs', 'lib', 'repos', 'quiet', 'info', 'mount')),
    identical(names(formals(download.packages)), c('pkgs', 'destdir', 'available', 'repos', 'contriburl', 'method', 'type', '...')),
    bindingIsLocked('install.packages', asNamespace('utils')),
    bindingIsLocked('download.packages', asNamespace('utils')),
    identical(library, base::library), identical(require, base::require),
    identical(requireNamespace, base::requireNamespace)
  `, 'startup installer and unchanged loading functions');
}

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
    channelName = channel;
    const context = await browser.newContext({ ignoreHTTPSErrors: ignoreHTTPS });
    page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
    console.log(`${channel}: starting real webR and its production startup helpers.`);
    await page.goto(`${origin}/${channel}/`);
    activeStep = 'runtime startup';
    await bounded(page.evaluate(async () => {
      const { WebREngine } = await import('./js/webr-engine.js');
      globalThis.engine = new WebREngine();
      await engine.initialize();
    }), `${channel}: runtime startup`, bootTimeout);
    assert.equal(await page.evaluate(() => engine.interruptSupported), channel === 'isolated');
    await checkStartup();
    await bounded(page.evaluate(code => engine.webR.evalRVoid(code), spyCode), 'Install official-installer argument spy');

    for (const [label, code, names] of [
      ['ordinary call', 'install.packages("fixtureOrdinary")', ['fixtureOrdinary']],
      ['named pkgs', 'install.packages(pkgs = "fixtureNamed")', ['fixtureNamed']],
      ['literal vector', 'install.packages(c("fixtureVectorA", "fixtureVectorB"))', ['fixtureVectorA', 'fixtureVectorB']],
      ['variable vector', 'wanted_packages <- c("fixtureVariableA", "fixtureVariableB"); install.packages(wanted_packages)', ['fixtureVariableA', 'fixtureVariableB']],
      ['qualified utils call', 'utils::install.packages(pkgs = "fixtureQualified")', ['fixtureQualified']]
    ]) {
      const before = await callCount();
      const result = await execute(code, label);
      assert.equal(result.ok, true, `${label}: ${result.error}`);
      assert.equal(await callCount(), before + 1, `${label} must invoke the official installer exactly once.`);
      await checkLastPackages(names, label);
    }
    await checkR(`{
      fixture_info <- matrix('fixture', nrow = 1L, dimnames = list('fixtureOptions', 'Package'))
      install.packages(pkgs = 'fixtureOptions', lib = '/project/fixture-library',
        repos = c('https://first.example/repository', 'https://second.example/repository'),
        quiet = TRUE, info = fixture_info, mount = FALSE)
      actual <- tail(.packageInstallFixture$calls, 1L)[[1L]]
      identical(actual$packages, 'fixtureOptions') && identical(actual$lib, '/project/fixture-library') &&
        identical(actual$repos, c('https://first.example/repository', 'https://second.example/repository')) &&
        identical(actual$quiet, TRUE) && identical(actual$info, fixture_info) && identical(actual$mount, FALSE)
    }`, 'all supported arguments forwarded unchanged');

    await bounded(page.evaluate(async () => {
      const source = 'script_packages <- c("fixtureScriptA", "fixtureScriptB")\ninstall.packages(script_packages, quiet = TRUE)\n';
      await engine.webR.FS.writeFile('/project/install-fixture.R', new TextEncoder().encode(source));
    }), 'Write sourced R fixture');
    const sourced = await execute('source("/project/install-fixture.R")', 'scripted source call');
    assert.equal(sourced.ok, true, sourced.error);
    await checkLastPackages(['fixtureScriptA', 'fixtureScriptB'], 'Sourced R code must use the same installer.');
    await bounded(page.evaluate(() => engine.installPackages(['fixturePaneA', 'fixturePaneB'])), 'Packages-pane engine API');
    await checkLastPackages(['fixturePaneA', 'fixturePaneB'], 'The existing Packages-pane API must reach the same official installer.');

    const beforeUnsupported = await callCount();
    for (const argument of ['dependencies = TRUE', 'type = "source"']) {
      const rejected = await execute(`install.packages('fixtureUnsupported', ${argument})`, `unsupported ${argument}`);
      assert.equal(rejected.ok, false);
      assert.match(rejected.error, /unused argument/i);
      assert.ok(rejected.outputs.some(item => item.type === 'error'));
    }
    assert.equal(await callCount(), beforeUnsupported, 'Unsupported native-R arguments must not be silently dropped.');

    const missingLibrary = await execute('library("webrStudioNoAutoInstallFixture", character.only = TRUE)', 'missing library must remain a real error');
    assert.equal(missingLibrary.ok, false);
    assert.match(missingLibrary.error, /webrStudioNoAutoInstallFixture/);
    await checkR(`
      !require('webrStudioNoAutoInstallFixture', character.only = TRUE, quietly = TRUE),
      !requireNamespace('webrStudioNoAutoInstallFixture', quietly = TRUE)
    `, 'require and requireNamespace do not auto-install');
    assert.equal(await callCount(), beforeUnsupported, 'Library loading functions must not call the installer.');
    console.log(`${channel}: ordinary, named, vector, variable, source, qualified, and Packages-pane calls use the official installer; argument and library behavior passed.`);

    await bounded(page.evaluate(code => engine.webR.evalRVoid(code), restoreCode), 'Restore the real official installer');
    const missing = await execute(`
      empty_package_info <- matrix(character(), nrow = 0L, ncol = 5L,
        dimnames = list(NULL, c('Package', 'Version', 'Depends', 'Imports', 'Repository')))
      install.packages('webrStudioMissingBinaryFixture', info = empty_package_info, repos = character())
    `, 'real installer missing-package warning');
    assert.equal(missing.ok, true, missing.error);
    assert.ok(missing.outputs.some(item => item.type === 'warning'
      && /webrStudioMissingBinaryFixture.*not found in webR binary repo/i.test(item.text)));
    const fixtureCount = fixtureRequests.length;
    const transfer = await execute(`
      binary_package_info <- cbind(Package = 'webrStudioTransferFailureFixture', Version = '9.9.9',
        Depends = NA_character_, Imports = NA_character_, Repository = ${JSON.stringify(`${origin}/package-fixture`)})
      rownames(binary_package_info) <- 'webrStudioTransferFailureFixture'
      utils::install.packages('webrStudioTransferFailureFixture', info = binary_package_info,
        repos = character(), mount = FALSE)
    `, 'real installer HTTP 404 transfer error');
    assert.equal(transfer.ok, false);
    assert.ok(transfer.outputs.some(item => item.type === 'error'));
    assert.match(transfer.error, /download|cannot open|404/i);
    assert.ok(fixtureRequests.slice(fixtureCount).includes('/package-fixture/webrStudioTransferFailureFixture_9.9.9.tgz'),
      'The official installer must attempt the controlled binary archive URL.');
    const next = await execute('print(1 + 1)', 'console remains usable after installer error');
    assert.equal(next.ok, true, next.error);
    assert.ok(next.outputs.some(item => item.text === '[1] 2'));
    console.log(`${channel}: the unmodified official installer preserved its missing-package warning and genuine HTTP 404 error; subsequent R execution passed.`);

    const requestsBeforeMissingDestination = downloadRequests.length;
    for (const code of [
      'download.packages("data.table")',
      'utils::download.packages("data.table", repos = stop("repository must not be forced"), contriburl = stop("index must not be forced"))',
      'download.packages("data.table", destdir = "/missing-package-destination", available = stop("metadata must not be forced"))'
    ]) {
      const rejected = await execute(code, 'download destination validated before repository lookup');
      assert.equal(rejected.ok, false);
      assert.match(rejected.error, /destdir/);
      assert.doesNotMatch(rejected.error, /must not be forced/);
      assert.ok(!rejected.outputs.some(item => /select a CRAN mirror/i.test(item.text)));
    }
    assert.equal(downloadRequests.length, requestsBeforeMissingDestination);
    const rejectedSource = await execute('download.packages("data.table", destdir = getwd(), type = "source")', 'source archive type rejected clearly');
    assert.equal(rejectedSource.ok, false);
    assert.match(rejectedSource.error, /WebAssembly.*type/i);

    const downloadStart = downloadRequests.length;
    const downloaded = await execute(`
      dir.create('/project/package-downloads', showWarnings = FALSE)
      package_library_before <- .libPaths()
      package_repos_before <- getOption('repos')
      local({
        previous <- options(webr_pkg_repos = ${JSON.stringify(`${origin}/download-fixture`)})
        on.exit(options(previous))
        result <- download.packages(c('webrStudioArchiveFixture', 'webrStudioFileFieldFixture', 'webrStudioArchiveFixture'),
          destdir = '/project/package-downloads', quiet = TRUE)
        stopifnot(is.matrix(result), identical(dim(result), c(2L, 2L)),
          identical(result[, 1L], c('webrStudioArchiveFixture', 'webrStudioFileFieldFixture')),
          identical(result[, 2L], c('/project/package-downloads/webrStudioArchiveFixture_1.2.3.tgz',
            '/project/package-downloads/custom-archive.tgz')))
      })
      stopifnot(identical(.libPaths(), package_library_before),
        identical(getOption('repos'), package_repos_before),
        !length(find.package('webrStudioArchiveFixture', quiet = TRUE)),
        !length(find.package('webrStudioFileFieldFixture', quiet = TRUE)),
        identical(utils::untar('/project/package-downloads/webrStudioArchiveFixture_1.2.3.tgz',
          list = TRUE, tar = 'internal'), 'webrStudioArchiveFixture/DESCRIPTION'))
    `, 'default binary repository downloads actual archives without installation');
    assert.equal(downloaded.ok, true, downloaded.error);
    assert.ok(!downloaded.outputs.some(item => /select a CRAN mirror/i.test(item.text)));
    const savedBytes = await bounded(page.evaluate(async () => [
      Array.from(await engine.webR.FS.readFile('/project/package-downloads/webrStudioArchiveFixture_1.2.3.tgz')),
      Array.from(await engine.webR.FS.readFile('/project/package-downloads/custom-archive.tgz'))
    ]), 'Read downloaded archive bytes');
    assert.deepEqual(Buffer.from(savedBytes[0]), archiveBytes);
    assert.deepEqual(Buffer.from(savedBytes[1]), archiveFileBytes);
    const archiveRequests = downloadRequests.slice(downloadStart).filter(request => request.path.endsWith('.tgz'));
    assert.equal(archiveRequests.length, 2, 'Repeated package names must be downloaded once.');
    assert.ok(archiveRequests.every(request => /\/bin\/emscripten\/contrib\/\d+\.\d+\//.test(request.path)),
      'The default index must use the running R version and WebAssembly package layout.');

    const partial = await execute(`
      local({
        fixture <- cbind(Package = c('webrStudioArchiveFixture', 'webrStudioArchiveFixture', 'webrStudioDownloadFailureFixture'),
          Version = c('1.0.0', '1.2.3', '1.2.3'), Repository = ${JSON.stringify(`${origin}/download-fixture/direct`)})
        result <- utils::download.packages(c('webrStudioArchiveFixture', 'webrStudioDownloadFailureFixture', 'webrStudioMissingDownloadFixture'),
          destdir = '/project/package-downloads', available = fixture,
          repos = stop('supplied metadata must not read repos'),
          contriburl = stop('supplied metadata must not read an index'),
          type = 'emscripten.binary', quiet = TRUE,
          headers = c('X-Package-Fixture' = 'archive-header'))
        stopifnot(identical(dim(result), c(1L, 2L)), result[1L, 1L] == 'webrStudioArchiveFixture',
          basename(result[1L, 2L]) == 'webrStudioArchiveFixture_1.2.3.tgz')
        empty <- download.packages(character(), destdir = getwd(), repos = stop('empty vector must not read repos'))
        stopifnot(is.character(empty), identical(dim(empty), c(0L, 2L)))
      })
      print(1 + 1)
    `, 'qualified downloads preserve partial success, missing-package warnings, headers, and empty matrix');
    assert.equal(partial.ok, true, partial.error);
    assert.ok(partial.outputs.some(item => item.type === 'warning' && /webrStudioDownloadFailureFixture.*failed/i.test(item.text)));
    assert.ok(partial.outputs.some(item => item.type === 'warning' && /webrStudioMissingDownloadFixture.*repositories/i.test(item.text)));
    assert.ok(partial.outputs.some(item => item.text === '[1] 2'));
    assert.ok(downloadRequests.some(request => request.path === '/download-fixture/direct/webrStudioArchiveFixture_1.2.3.tgz'
      && request.headers['x-package-fixture'] === 'archive-header'));
    assert.ok(!downloadRequests.some(request => request.path.endsWith('/webrStudioArchiveFixture_1.0.0.tgz')),
      'The newest available version must be selected.');
    const customIndex = await execute(`
      local({
        result <- download.packages('webrStudioArchiveFixture', destdir = '/project/package-downloads',
          contriburl = ${JSON.stringify(`${origin}/download-fixture/custom-index`)},
          repos = stop('explicit index must override repos'), quiet = TRUE)
        stopifnot(identical(dim(result), c(1L, 2L)))
      })
    `, 'explicit binary contriburl overrides repository default');
    assert.equal(customIndex.ok, true, customIndex.error);
    assert.ok(downloadRequests.some(request => request.path === '/download-fixture/custom-index/webrStudioArchiveFixture_1.2.3.tgz'));
    console.log(`${channel}: download.packages validates destination before lookup, downloads exact archive bytes without installation, and preserves File metadata, deduplication, headers, overrides, and partial-success warnings.`);

    if (liveInstall && channel === 'isolated') {
      console.log('isolated: downloading, then separately installing and using real data.table from the official webR binary repository.');
      const live = await execute(`
        stopifnot(!length(find.package('data.table', quiet = TRUE)))
        live_archives <- download.packages('data.table', destdir = '/project/package-downloads')
        stopifnot(identical(dim(live_archives), c(1L, 2L)), file.info(live_archives[1L, 2L])$size > 0,
          !length(find.package('data.table', quiet = TRUE)))
        install.packages('data.table')
        library(data.table)
        installed_total <- data.table::data.table(x = 1:3)[, sum(x)]
        stopifnot(identical(installed_total, 6L))
        cat('data.table version: ', as.character(packageVersion('data.table')), '; computed sum: ', installed_total, '\\n', sep = '')
      `, 'live data.table installation and computation', Number(process.env.BROWSER_LIVE_TIMEOUT_MS) || 180_000);
      assert.equal(live.ok, true, live.error);
      const version = live.outputs.find(item => /data\.table version:.*computed sum: 6/.test(item.text));
      assert.ok(version, 'The live package must load and perform the expected computation.');
      console.log(version.text);
    }

    activeStep = 'runtime restart';
    await bounded(page.evaluate(() => engine.restart()), `${channel}: runtime restart`, bootTimeout);
    await checkStartup();
    const missingAfterRestart = await execute('utils::download.packages("data.table")', 'download adapter reapplied after restart');
    assert.equal(missingAfterRestart.ok, false);
    assert.match(missingAfterRestart.error, /needs 'destdir'/);
    assert.ok(!missingAfterRestart.outputs.some(item => /select a CRAN mirror/i.test(item.text)));
    await bounded(page.evaluate(code => engine.webR.evalRVoid(code), spyCode), 'Install argument spy after real restart');
    const restarted = await execute('install.packages("fixtureAfterRestart"); utils::install.packages(pkgs = "fixtureQualifiedAfterRestart")', 'startup installer reapplied after restart');
    assert.equal(restarted.ok, true, restarted.error);
    assert.equal(await callCount(), 2);
    await checkLastPackages(['fixtureQualifiedAfterRestart'], 'The qualified installer must survive restart.');
    await checkR(`
      identical(library, base::library), identical(require, base::require),
      identical(requireNamespace, base::requireNamespace)
    `, 'library functions unchanged after restart');
    assert.deepEqual(pageErrors, []);
    console.log(`${channel}: restart reapplies installer and download entry points without changing library/require/requireNamespace.`);
    await bounded(page.evaluate(() => engine.close()), `${channel}: close R worker`);
    await context.close();
    page = null;
  }
  if (!liveInstall) console.log('Live package download/installation skipped; set BROWSER_LIVE_PACKAGE_INSTALL=1 to download, install, and use data.table.');
  console.log('Console package installer browser regression passed.');
} catch (error) {
  console.error(`Failure in ${channelName || 'setup'}: ${activeStep || 'browser startup'}`);
  if (page) console.error('Runtime state:', await bounded(page.evaluate(() => ({
    ready: globalThis.engine?.ready, running: globalThis.engine?.running,
    phase: globalThis.engine?.executionPhase, last: globalThis.lastInstallTestResult
  })), 'Read failure state', 5000).catch(() => 'Page unavailable.'));
  if (diagnostics.length) console.error(diagnostics.slice(-8).join('\n'));
  throw error;
} finally {
  await browser?.close();
  await new Promise(done => { server.close(done); server.closeAllConnections(); });
}
