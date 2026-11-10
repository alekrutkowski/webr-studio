/**
 * Optional integration checks using the actual R WebAssembly runtime under Node.
 * Install the official `webr@0.6.0` npm module separately, or point WEBR_MODULE
 * at its dist/webr.mjs file. The app itself has no npm runtime dependency.
 *
 * node tests/assistant-webr-check.mjs
 * WEBR_MODULE=/absolute/path/to/webr/dist/webr.mjs node tests/assistant-webr-check.mjs
 *
 * Does not download models, launch a browser, or require WebGPU. The optional
 * data.table case is explicitly skipped when absent. Timings are observations,
 * never pass/fail thresholds or browser responsiveness guarantees.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebREngine } from '../js/webr-engine.js';
import { rString } from '../js/utils.js';

const { WebR } = process.env.WEBR_MODULE
  ? await import(pathToFileURL(resolve(process.env.WEBR_MODULE)).href)
  : await import('webr');

const webR = new WebR();
await webR.init();
const engine = new WebREngine();
engine.webR = webR;
engine.ready = true;
engine.generation = 7;
const results = [];
const check = async (name, fn) => {
  await fn();
  console.log(`PASS ${name}`);
  results.push(name);
};
const maliciousName = 'name "; proof$injected <- TRUE; # \\ \n β';
const maliciousCell = '"; proof$injected <- TRUE; #\n\u001f<script>alert(1)</script>';

try {
  console.log(await webR.evalRString('R.version.string'));
  await webR.evalRVoid(`
    proof <- new.env(parent = emptyenv())
    proof$active <- 0L
    proof$methods <- 0L
    proof$injected <- FALSE
    sales <- data.frame(country = c("BE", "FR", "DE", "NL"), amount = c(10, 20, NA_real_, 40))
    clean <- function(x, trim = TRUE, ...) { x[!is.na(x)] }
    empty_fn <- function() 42
    one_date <- as.Date("2026-11-09")
    groups <- factor(c("a", "b", "a"))
    nothing <- NULL
    cyc <- new.env(parent = emptyenv()); cyc$self <- cyc
    hostile <- structure(1:4, class = "hostile")
    hostile_table <- structure(sales, class = c("hostile_table", "data.frame"))
    makeActiveBinding("live", function(value) { proof$active <- proof$active + 1L; stop("active binding invoked") }, .GlobalEnv)
    bad_method <- function(...) { proof$methods <- proof$methods + 1L; stop("custom method invoked") }
    print.hostile <- bad_method
    str.hostile <- bad_method
    summary.hostile <- bad_method
    length.hostile <- bad_method
    as.character.hostile <- bad_method
    assign("[.hostile", bad_method)
    assign("[[.hostile", bad_method)
    print.hostile_table <- bad_method
    str.hostile_table <- bad_method
    summary.hostile_table <- bad_method
    length.hostile_table <- bad_method
    dim.hostile_table <- bad_method
    names.hostile_table <- bad_method
    assign("[.hostile_table", bad_method)
    assign("[[.hostile_table", bad_method)
    assign(${rString(maliciousName)}, c(5L, 8L, 13L), .GlobalEnv)
    evil_cells <- c(${rString(maliciousCell)}, NA_character_, "ok", "must be omitted")
    long_cells <- rep(strrep("x", 1000000L), 2L)
    long_labels <- sales
    names(long_labels) <- c(strrep("label", 600L), "other")
    huge_fn <- function(x) x
    body(huge_fn) <- as.call(c(list(as.name("{")), rep(list(quote(x + 1)), 2000L)))
    literal_fn <- function() NULL
    body(literal_fn) <- as.call(list(as.name("paste"), strrep("z", 1000000L)))
    large <- data.frame(index = seq_len(1000000L), value = rep(2, 1000000L))
  `);

  await check('metadata and function signatures from real objects', async () => {
    const ctx = await engine.getAssistantContext({ names: ['sales', 'clean', 'empty_fn', 'nothing'], maxChars: 3200 });
    assert.match(ctx.text, /sales: data.frame \(4 rows x 2 columns\)/);
    assert.match(ctx.text, /country: character/);
    assert.match(ctx.text, /amount: double/);
    assert.match(ctx.text, /function\(x, trim, \.\.\.\)/);
    assert.match(ctx.text, /function\(\)/);
    assert.doesNotMatch(ctx.text, /Storage sample:|storage sample:/);
    assert.equal(ctx.objects.find(x => x.name === 'nothing').type, 'NULL');
    assert.equal(ctx.generation, 7);
  });

  await check('tiny samples, no padding, and bounded function bodies', async () => {
    const ctx = await engine.getAssistantContext({ names: ['sales', 'one_date', 'groups', 'clean'], includeValues: true, includeFunctionBodies: true, maxRows: 3, maxChars: 3200 });
    assert.match(ctx.text, /country: character; storage sample: BE, FR, DE/);
    assert.doesNotMatch(ctx.text, /FR, DE, NL/);
    assert.match(ctx.text, /amount: double; storage sample: 10, 20, NA/);
    assert.doesNotMatch(ctx.objects.find(x => x.name === 'one_date').details, /NA/);
    assert.match(ctx.objects.find(x => x.name === 'groups').details, /1, 2, 1/);
    assert.match(ctx.objects.find(x => x.name === 'clean').details, /x\[!is.na\(x\)\]/);
    assert.ok(ctx.text.length <= 3200);
  });

  await check('active bindings and S3 methods are not executed', async () => {
    const ctx = await engine.getAssistantContext({ names: ['live', 'hostile', 'hostile_table', 'cyc'], includeValues: true });
    assert.equal(ctx.objects.find(x => x.name === 'live').type, 'active binding');
    assert.match(ctx.objects.find(x => x.name === 'hostile').details, /1, 2, 3/);
    assert.match(ctx.objects.find(x => x.name === 'hostile_table').dimensions, /4 rows x 2 columns/);
    assert.equal(ctx.objects.find(x => x.name === 'cyc').details, 'Contents omitted.');
    assert.equal(await webR.evalRNumber('proof$active'), 0);
    assert.equal(await webR.evalRNumber('proof$methods'), 0);
  });

  await check('literal names and arbitrary character cells round-trip safely', async () => {
    const ctx = await engine.getAssistantContext({ names: [maliciousName, 'evil_cells'], includeValues: true });
    assert.equal(ctx.objects[0].name, maliciousName);
    assert.match(ctx.objects[0].details, /5, 8, 13/);
    assert.ok(ctx.objects[1].details.includes(maliciousCell));
    assert.ok(!ctx.objects[1].details.includes('must be omitted'));
    assert.equal(await webR.evalRBoolean('proof$injected'), false);
  });

  await check('large values, labels, syntax, and output remain bounded', async () => {
    const ctx = await engine.getAssistantContext({ names: ['long_cells', 'long_labels', 'huge_fn', 'literal_fn'], includeValues: true, includeFunctionBodies: true, maxChars: 3200 });
    assert.ok(ctx.text.length <= 3200);
    assert.ok(ctx.objects.find(x => x.name === 'long_cells').details.length < 300);
    assert.match(ctx.objects.find(x => x.name === 'huge_fn').details, /body omitted/);
    assert.match(ctx.objects.find(x => x.name === 'literal_fn').details, /body omitted/);
    const tiny = await engine.getAssistantContext({ names: ['long_cells', 'long_labels', 'sales'], includeValues: true, maxChars: 512 });
    assert.ok(tiny.text.length <= 512);
    assert.equal(tiny.truncated, true);
  });

  await check('million-row table yields bounded metadata and samples', async () => {
    const start = performance.now();
    const ctx = await engine.getAssistantContext({ names: ['large'], includeValues: true, maxChars: 3200 });
    const elapsed = performance.now() - start;
    assert.match(ctx.text, /1000000 rows x 2 columns/);
    assert.match(ctx.text, /index: integer; storage sample: 1, 2, 3/);
    assert.ok(ctx.text.length < 300);
    console.log(`Million-row snapshot: ${elapsed.toFixed(1)} ms, ${ctx.text.length} characters`);
  });

  await check('global helper masking cannot intercept the collector', async () => {
    await webR.evalRVoid('get <- length <- lapply <- format <- ls <- eval <- quote <- bad_method');
    const ctx = await engine.getAssistantContext({ names: ['sales', 'clean'], includeValues: true, includeFunctionBodies: true });
    assert.match(ctx.text, /country: character; storage sample: BE, FR, DE/);
    assert.match(ctx.text, /x\[!is.na\(x\)\]/);
    assert.equal(await webR.evalRNumber('proof$methods'), 0);
    await webR.evalRVoid('base::rm(list = c("get", "length", "lapply", "format", "ls", "eval", "quote"), envir = .GlobalEnv)');
  });

  await check('missing and reserved object handling', async () => {
    const ctx = await engine.getAssistantContext({ names: ['missingObject', '.__webRStudio_private', '.webrStudio'] });
    assert.equal(ctx.objects.length, 1);
    assert.equal(ctx.objects[0].type, 'missing');
  });

  await check('repeated context collection does not retain R proxy handles', async () => {
    const before = await webR.globalShelter.size();
    for (let i = 0; i < 30; i += 1) {
      const ctx = await engine.getAssistantContext({ names: ['large', 'clean'], includeValues: true, maxChars: 3200 });
      assert.ok(ctx.text.length <= 3200);
    }
    assert.equal(await webR.globalShelter.size(), before);
  });

  if (await webR.evalRBoolean('requireNamespace("data.table", quietly = TRUE)')) {
    await check('data.table schemas and bounded samples', async () => {
      await webR.evalRVoid('dt <- data.table::data.table(id = 1:5, label = letters[1:5])');
      const ctx = await engine.getAssistantContext({ names: ['dt'], includeValues: true, maxRows: 2 });
      assert.match(ctx.objects[0].className, /data.table/);
      assert.equal(ctx.objects[0].dimensions, '5 rows x 2 columns');
      assert.match(ctx.text, /id: integer; storage sample: 1, 2/);
      assert.match(ctx.text, /label: character; storage sample: a, b/);
      assert.doesNotMatch(ctx.text, /sample: 1, 2, 3/);
      assert.equal(await webR.evalRBoolean('identical(dt$id, 1:5)'), true);
    });
  } else {
    console.log('SKIP optional data.table scenario: data.table is not installed in this webR runtime.');
  }

  console.log(`${results.length} real webR context scenarios passed.`);
} finally {
  await webR.close();
}
