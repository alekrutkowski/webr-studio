import assert from 'node:assert/strict';
import {
  aceModeFromPath, currentRExpression, debounce, expressionState, extractHelpRequest, inlineRCodeSource, parseDelimited,
  resolveRMarkdownFigureOptions, smartIndentR, splitRMarkdown
} from '../js/utils.js';
import {
  acceptAceCompletionOrIndent, assignmentEqualsPositions, defineRMarkdownMode, EditorManager,
  outlineFromSource, rMarkdownChunkRanges, rMarkdownCode, rParserUnits, staticDiagnostics
} from '../js/editor.js';
import {
  normalizeRSource, normalizeVirtualPath, parseCapturedOutput, stripTerminalControlSequences, WebREngine
} from '../js/webr-engine.js';
import { ConsoleManager } from '../js/console.js';
import {
  normalizeWebRVersion, webRBaseUrl, webRModuleUrl
} from '../js/config.js';
import {
  evaluateInlineRMarkdown, gfmBundleFiles, gfmCodeFence, RMarkdownGfmBuilder
} from '../js/rmd-gfm.js';

assert.equal(normalizeWebRVersion('v0.6.0'), '0.6.0');
assert.equal(normalizeWebRVersion(' latest '), 'latest');
assert.throws(() => normalizeWebRVersion('main'), /latest.*release/i);
assert.equal(webRBaseUrl('0.6.0'), 'https://webr.r-wasm.org/v0.6.0/');
assert.equal(webRModuleUrl('latest'), 'https://webr.r-wasm.org/latest/webr.mjs');
assert.equal(stripTerminalControlSequences('\x1b[?25h[1] 1'), '[1] 1');
assert.equal(normalizeRSource('\uFEFFx <- 1\r\ny <- 2\rz <- 3\u2028z'), 'x <- 1\ny <- 2\nz <- 3\nz');
assert.equal(normalizeVirtualPath('project\\results/../plots'), '/project/plots');
assert.equal(normalizeVirtualPath('/../../project'), '/project');
assert.equal(aceModeFromPath('report.Rmd'), 'webr_rmarkdown');

assert.equal(expressionState('mean(c(1, 2,').complete, false);
assert.equal(expressionState('mean(c(1, 2))').complete, true);
assert.equal(expressionState('if (TRUE)').complete, false);
assert.equal(expressionState('if (TRUE) 1 else 2').complete, true);
assert.equal(expressionState('x <- 1 +').complete, false);

const source = `alpha <- function(x) {\n  x + 1\n}\n\nbeta <- alpha(2)\nif (beta > 2) {\n  beta\n} else {\n  0\n}`;
assert.equal(currentRExpression(source, 1, 3).text, 'alpha <- function(x) {\n  x + 1\n}');
assert.equal(currentRExpression(source, 7, 2).text, 'if (beta > 2) {\n  beta\n} else {\n  0\n}');

const rmd = `# Report\n\nThis prose has T and x == NA but must not be linted.\n\n\`\`\`{r}\nx = T\ny <- 1:length(x)\n\`\`\`\n\nMore prose.`;
const masked = rMarkdownCode(rmd);
assert.equal(masked.split('\n')[2], '');
assert.equal(masked.split('\n')[5], 'x = T');
const units = rParserUnits(rmd, 'report.Rmd');
assert.deepEqual(units, [{ code: 'x = T\ny <- 1:length(x)', rowOffset: 5 }]);
assert.deepEqual(rMarkdownChunkRanges(rmd), [{ startRow: 4, endRow: 7 }]);
assert.deepEqual(rMarkdownChunkRanges([
  '    ```{r literal}',
  '    x <- 1',
  '    ```',
  '~~~{R actual, echo=FALSE}',
  'x <- 2',
  '~~~~',
  '```{r unfinished}',
  'y <- 3'
].join('\n')), [
  { startRow: 3, endRow: 5 },
  { startRow: 6, endRow: 7 }
]);

const aceModules = new Map();
const aceDefinitions = new Map();
const aceLoads = [];
const resolveAceId = (from, request) => {
  if (!request.startsWith('.')) return request;
  const parts = from.split('/');
  parts.pop();
  for (const part of request.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
};
const oop = {
  inherits(child, parent) {
    child.prototype = Object.create(parent.prototype);
    child.prototype.constructor = child;
  }
};
function MarkdownHighlightRules() {
  this.$rules = { start: [{ token: 'text', regex: '.+' }] };
  this.embedCalls = [];
}
MarkdownHighlightRules.prototype.embedRules = function embedRules(Rules, prefix, escapeRules) {
  this.embedCalls.push({ Rules, prefix, escapeRules });
  this.$rules[`${prefix}start`] = [];
};
MarkdownHighlightRules.prototype.normalizeRules = function normalizeRules() { this.normalized = true; };
function RHighlightRules() {}
function MarkdownMode() {
  this.HighlightRules = MarkdownHighlightRules;
  this.$tokenizer = { base: true };
}
const fakeAce = {
  define(id, dependencies, factory) {
    aceDefinitions.set(id, { dependencies, factory });
  },
  require(id) {
    if (aceModules.has(id)) return aceModules.get(id);
    const definition = aceDefinitions.get(id);
    if (!definition) return null;
    const exports = {};
    const module = { exports };
    aceModules.set(id, exports);
    const localRequire = request => fakeAce.require(resolveAceId(id, request));
    definition.factory(localRequire, exports, module);
    aceModules.set(id, module.exports);
    return module.exports;
  },
  config: {
    loadModule(id, callback) {
      aceLoads.push(id);
      aceModules.set('ace/lib/oop', oop);
      if (id === 'ace/mode/markdown') {
        aceModules.set('ace/mode/markdown_highlight_rules', { MarkdownHighlightRules });
        aceModules.set('ace/mode/markdown', { Mode: MarkdownMode });
      } else if (id === 'ace/mode/r') {
        aceModules.set('ace/mode/r_highlight_rules', { RHighlightRules });
        aceModules.set('ace/mode/r', { Mode: function RMode() {} });
      }
      callback(aceModules.get(id));
    }
  }
};
const rMarkdownAceModule = await defineRMarkdownMode(fakeAce);
assert.deepEqual(aceLoads, ['ace/mode/markdown', 'ace/mode/r']);
const rMarkdownAceMode = new rMarkdownAceModule.Mode();
assert.equal(rMarkdownAceMode.$id, 'ace/mode/webr_rmarkdown');
assert.equal(rMarkdownAceMode.$tokenizer, null, 'the inherited Markdown tokenizer must be rebuilt with embedded R rules');
const rMarkdownHighlightRules = new rMarkdownAceMode.HighlightRules();
assert.equal(rMarkdownHighlightRules.$rules.start[0].next, 'r-start');
assert.equal(rMarkdownHighlightRules.embedCalls[0].prefix, 'r-');
assert.equal(rMarkdownHighlightRules.embedCalls[0].escapeRules[0].next, 'start');
assert.equal(rMarkdownHighlightRules.normalized, true);
await defineRMarkdownMode(fakeAce);
assert.deepEqual(aceLoads, ['ace/mode/markdown', 'ace/mode/r'], 'a registered R Markdown mode must be reused');
const rmdDiagnostics = staticDiagnostics(rmd, 'report.Rmd');
assert.equal(rmdDiagnostics.some(item => item.row === 2), false);
assert.equal(rmdDiagnostics.some(item => item.row === 5 && item.source === 'correctness/logical-shorthand'), true);
assert.equal(rmdDiagnostics.some(item => item.row === 6 && item.source === 'correctness/seq-along'), true);

assert.equal(inlineRCodeSource('r 2 + 2'), '2 + 2');
assert.equal(inlineRCodeSource(' r 2 + 2'), '');
assert.equal(inlineRCodeSource('python 2 + 2'), '');

const inlineGfm = await evaluateInlineRMarkdown([
  'Inline result: `r 2 + 2`.',
  '',
  '```r',
  '`r must_not_run()`',
  '```',
  '    `r also_must_not_run()`',
  '> ```r',
  '> `r quoted_fence_must_not_run()`',
  '> ```'
].join('\n'), async source => {
  assert.equal(source, '2 + 2');
  return '4';
});
assert.equal(inlineGfm.evaluated, 1);
assert.match(inlineGfm.preview, /class="inline-r-output"[^>]*>4<\/span>/);
assert.match(inlineGfm.gfm, /Inline result: 4\./);
assert.match(inlineGfm.gfm, /`r must_not_run\(\)`/);
assert.match(inlineGfm.gfm, /`r also_must_not_run\(\)`/);
assert.match(inlineGfm.gfm, /`r quoted_fence_must_not_run\(\)`/);
assert.equal(gfmCodeFence('x <- "```"', 'r').startsWith('````r\n'), true, 'GFM code fences must expand around embedded backticks');

const blankLineBuilder = new RMarkdownGfmBuilder({ stem: 'spacing.Rmd' });
blankLineBuilder.appendChunk({
  code: 'cat("first\n\n\n\nsecond")',
  result: { ok: true, outputs: [{ type: 'stdout', text: 'first\n\n\n\nsecond' }] }
});
assert.match(blankLineBuilder.build().markdown, /first\n\n\n\nsecond/, 'GFM export must preserve intentional blank lines inside fenced code and output.');

const downloadOutputBuilder = new RMarkdownGfmBuilder({ stem: 'download.Rmd' });
downloadOutputBuilder.appendChunk({
  code: 'download.file(url, "data.csv")',
  options: { echo: false },
  result: {
    ok: false,
    outputs: [
      { type: 'stderr', text: "trying URL 'https://example.org/data.csv'" },
      { type: 'message', text: 'A structured R message' },
      { type: 'warning', text: 'A structured R warning' },
      { type: 'error', text: 'A structured R error' }
    ]
  }
});
const downloadOutputMarkdown = downloadOutputBuilder.build().markdown;
assert.match(downloadOutputMarkdown, /trying URL 'https:\/\/example\.org\/data\.csv'/);
assert.doesNotMatch(downloadOutputMarkdown, /(?:Error|Message|Warning): trying URL/, 'Raw stderr progress must not acquire an R condition label in GFM.');
assert.match(downloadOutputMarkdown, /Message: A structured R message/);
assert.match(downloadOutputMarkdown, /Warning: A structured R warning/);
assert.match(downloadOutputMarkdown, /Error: A structured R error/);

const gfmBuilder = new RMarkdownGfmBuilder({ stem: 'analysis.Rmd', title: 'Analysis' });
gfmBuilder.appendMarkdown('Intro with $x^2$.');
gfmBuilder.appendChunk({
  label: 'summary plot',
  code: 'print(summary(x))\nplot(x)',
  options: { message: false },
  result: {
    ok: true,
    outputs: [
      { type: 'stdout', text: '[1] 1 2 3' },
      { type: 'message', text: 'hidden message' },
      { type: 'warning', text: 'sample warning' }
    ],
    traceback: []
  },
  plots: [{ svg: '<svg viewBox="0 0 1 1"></svg>' }],
  caption: 'Summary figure'
});
gfmBuilder.appendChunk({
  label: 'asis',
  code: 'cat("| x | y |")',
  options: { echo: false, results: 'asis' },
  result: { ok: true, outputs: [{ type: 'stdout', text: '| x | y |\n|---|---|\n| 1 | 2 |' }] },
  plots: []
});
const gfmBundle = gfmBuilder.build();
assert.match(gfmBundle.markdown, /^# Analysis\n/);
assert.match(gfmBundle.markdown, /```r\nprint\(summary\(x\)\)\nplot\(x\)\n```/);
assert.match(gfmBundle.markdown, /Warning: sample warning/);
assert.doesNotMatch(gfmBundle.markdown, /hidden message/);
assert.match(gfmBundle.markdown, /\| x \| y \|\n\|---\|---\|/);
assert.match(gfmBundle.markdown, /!\[Summary figure\]\(analysis_files\/figure-gfm\/summary-plot-1\.svg\)/);
assert.equal(gfmBundle.assets.length, 1);
assert.equal(gfmBundle.assets[0].name, 'analysis_files/figure-gfm/summary-plot-1.svg');
assert.deepEqual(gfmBundleFiles(gfmBundle).map(file => file.name), [
  'analysis.md',
  'analysis_files/figure-gfm/summary-plot-1.svg'
]);

assert.deepEqual(extractHelpRequest('?lm'), { topic: 'lm', package: '' });
assert.deepEqual(extractHelpRequest('?stats::lm'), { topic: 'lm', package: 'stats' });
assert.deepEqual(extractHelpRequest('stats?lm'), { topic: 'lm', package: 'stats' });
assert.deepEqual(extractHelpRequest('help("source")'), { topic: 'source', package: '' });
assert.deepEqual(extractHelpRequest('help(topic = "lm", package = "stats")'), { topic: 'lm', package: 'stats' });
assert.equal(extractHelpRequest('x <- ?lm'), null);
assert.equal(extractHelpRequest('?lm\n?mean'), null);

const renderedBlocks = splitRMarkdown(`# Title

Text with $x^2$.

~~~{r setup, echo=FALSE}
#| message: false
x <- 1
~~~

End.`);
assert.equal(renderedBlocks.length, 3);
assert.equal(renderedBlocks[0].type, 'markdown');
assert.equal(renderedBlocks[1].type, 'r');
assert.equal(renderedBlocks[1].label, 'setup');
assert.equal(renderedBlocks[1].options.echo, false);
assert.equal(renderedBlocks[1].options.message, false);
assert.equal(renderedBlocks[1].content, 'x <- 1');
assert.equal(renderedBlocks[2].content.trim(), 'End.');

const indentedFence = [
  '# Example',
  '',
  '    ```{r illustrative}',
  '    x <- 1',
  '    ```',
  '',
  "```{r real, fig.width=3, fig.height=4, out.width='50%', results='asis'}",
  'cat("* rendered")',
  '```'
].join('\n');
const indentedBlocks = splitRMarkdown(indentedFence);
assert.equal(indentedBlocks.filter(block => block.type === 'r').length, 1, 'four-space-indented fenced examples must remain literal Markdown');
const realChunk = indentedBlocks.find(block => block.type === 'r');
assert.equal(realChunk.label, 'real');
assert.equal(realChunk.options['fig.width'], 3);
assert.equal(realChunk.options['fig.height'], 4);
assert.equal(realChunk.options.results, 'asis');
assert.equal(realChunk.options['out.width'], '50%');
assert.match(indentedBlocks[0].content, /illustrative/, 'the indented chunk example should stay in the Markdown block');

assert.deepEqual(resolveRMarkdownFigureOptions({ 'fig.width': 3, 'fig.height': 4, 'out.width': '50%', 'fig.align': 'right', 'fig.cap': 'Caption' }), {
  width: 3,
  height: 4,
  outWidth: '50%',
  outHeight: '',
  align: 'right',
  caption: 'Caption'
});
assert.deepEqual(resolveRMarkdownFigureOptions({ 'fig.dim': [5, 7] }), {
  width: 5,
  height: 7,
  outWidth: '480px',
  outHeight: '',
  align: 'center',
  caption: ''
});
assert.equal(resolveRMarkdownFigureOptions({ 'fig.width': 8, 'fig.asp': .5 }).height, 4);

assert.deepEqual(assignmentEqualsPositions('x = 1'), [{ row: 0, column: 2 }]);
assert.deepEqual(assignmentEqualsPositions('plot(x, col = "red")'), []);
assert.deepEqual(assignmentEqualsPositions('data.frame(a = 1, b = 2)'), []);
assert.deepEqual(assignmentEqualsPositions('f <- function(x = 1, y = list(a = 2)) x + y$a'), []);
assert.deepEqual(assignmentEqualsPositions('local({ x = 1 })'), [{ row: 0, column: 10 }]);
assert.deepEqual(assignmentEqualsPositions('(x = 1)'), [{ row: 0, column: 3 }]);
assert.deepEqual(assignmentEqualsPositions('if (x = 1) x'), [{ row: 0, column: 6 }]);
assert.deepEqual(assignmentEqualsPositions('x == 1\ny >= 2\nz != 3'), []);
assert.equal(staticDiagnostics('plot(x, col = "red")', 'script.R').some(item => item.source === 'style/assignment'), false);
assert.equal(staticDiagnostics('x = 1', 'script.R').some(item => item.source === 'style/assignment'), true);

const outline = outlineFromSource(source, 'script.R');
assert.equal(outline.some(item => item.name === 'alpha' && item.type === 'function'), true);
assert.equal(outline.some(item => item.name === 'beta' && item.type === 'object'), true);

assert.equal(smartIndentR('if (TRUE) {\nx <- 1\n}', 2), 'if (TRUE) {\n  x <- 1\n}');
assert.deepEqual(parseDelimited('a,b\n1,"x,y"\n'), [['a', 'b'], ['1', 'x,y']]);

const inlineEngine = new WebREngine();
let inlineExpression = '';
inlineEngine.ready = true;
inlineEngine.webR = {
  async evalRString(expression) {
    inlineExpression = expression;
    return '4';
  }
};
assert.equal(await inlineEngine.evaluateInline('2 + 2'), '4');
assert.match(inlineExpression, /parse\(text = "2 \+ 2"/);
assert.match(inlineExpression, /formatted <- as\.character\(value\)/);
assert.match(inlineExpression, /collapse = "\\n"/);
assert.equal(inlineEngine.running, false);

const executeEngine = new WebREngine();
let executeExpression = '';
let submittedSource = '';
const streamedExecuteItems = [];
let releaseExecution;
let resolveFirstOutput;
const executionGate = new Promise(resolve => { releaseExecution = resolve; });
const firstOutputSeen = new Promise(resolve => { resolveFirstOutput = resolve; });
executeEngine.ready = true;
executeEngine.emit = () => {};
executeEngine.webR = {
  FS: {
    async writeFile(_path, bytes) { submittedSource = new TextDecoder().decode(bytes); },
    async unlink() {}
  },
  async evalRVoid() {},
  async evalRString() { return ''; }
};
executeEngine.collectSvgPlots = async () => [];
executeEngine.readLastRunState = async () => ({ interrupted: false, ok: true, boundaryInterrupt: false });
executeEngine.runReplCommand = async (expression, { token, onOutput }) => {
  executeExpression = expression;
  assert.match(token, /^execute_/);
  await onOutput({ type: 'stdout', text: '[1] 1' });
  resolveFirstOutput();
  await executionGate;
  await onOutput({ type: 'stdout', text: '[1] 2' });
  return { interruptRequested: false };
};
const execution = executeEngine.execute('x <- 1\r\nfor (i in 1:2) print(i)\r', {
  onOutput: async item => { streamedExecuteItems.push(item); }
});
await firstOutputSeen;
assert.deepEqual(streamedExecuteItems, [{ type: 'stdout', text: '[1] 1' }], 'console output must arrive before execute() resolves');
releaseExecution();
const executeResult = await execution;
assert.equal(submittedSource, 'x <- 1\nfor (i in 1:2) print(i)\n', 'console source must reach R with normalized line endings');
assert.match(executeExpression, /\.webrStudio\$run_eval_file\(/);
assert.deepEqual(streamedExecuteItems, [
  { type: 'stdout', text: '[1] 1' },
  { type: 'stdout', text: '[1] 2' }
]);
assert.deepEqual(executeResult.outputs, []);
assert.equal(executeResult.streamed, true);
assert.equal(executeEngine.running, false);

const sourceEngine = new WebREngine();
let sourceExpression = '';
const streamedSourceItems = [];
sourceEngine.ready = true;
sourceEngine.emit = () => {};
sourceEngine.webR = {
  async evalRVoid() {},
  async evalRString() { return ''; }
};
sourceEngine.collectSvgPlots = async () => [];
sourceEngine.readLastRunState = async () => ({ interrupted: false, ok: true, boundaryInterrupt: false });
sourceEngine.runReplCommand = async (expression, { token, onOutput }) => {
  sourceExpression = expression;
  assert.match(token, /^source_/);
  await onOutput({ type: 'command', text: 'x <- 1' });
  await onOutput({ type: 'stdout', text: '[1] 1' });
  return { interruptRequested: false };
};
const sourceResult = await sourceEngine.sourceFile('scripts/analysis.R', {
  echo: true,
  onOutput: async item => { streamedSourceItems.push(item); }
});
assert.match(sourceExpression, /\.webrStudio\$run_source\(/);
assert.match(sourceExpression, /"\/project\/scripts\/analysis\.R"/);
assert.match(sourceExpression, /TRUE/);
assert.deepEqual(streamedSourceItems, [
  { type: 'command', text: 'x <- 1' },
  { type: 'stdout', text: '[1] 1' }
]);
assert.equal(sourceResult.streamed, true);
assert.equal(sourceEngine.running, false);

const replEngine = new WebREngine();
const replItems = [];
let replInput = '';
replEngine.ready = true;
replEngine.replAtPrompt = true;
replEngine.webR = { writeConsole(command) { replInput = command; } };
const replRun = replEngine.runReplCommand('.webrStudio$run_source("/project/test.R", TRUE, "abc")', {
  token: 'abc',
  onOutput: async item => { replItems.push(item); }
});
await new Promise(resolve => setImmediate(resolve));
await replEngine.handleOutputMessage({ type: 'stderr', data: '<<WEBRSTUDIO:START>>abc' });
await replEngine.handleOutputMessage({ type: 'stderr', data: '<<WEBRSTUDIO:ECHO>>x%20%3C-%201' });
await replEngine.handleOutputMessage({ type: 'stdout', data: '[1] 1' });
await replEngine.handleOutputMessage({ type: 'stderr', data: '<<WEBRSTUDIO:DONE>>abc' });
// Output queued immediately after the DONE boundary must still be delivered.
// Completion also waits for the explicit stdout flush sentinel, even if the
// primary prompt has already returned.
await replEngine.handleOutputMessage({ type: 'prompt', data: '> ' });
let replSettled = false;
replRun.finally(() => { replSettled = true; });
await new Promise(resolve => setImmediate(resolve));
assert.equal(replSettled, false);
await replEngine.handleOutputMessage({ type: 'stdout', data: '\x1b[?25htail output<<WEBRSTUDIO:FLUSH>>abc' });
await replRun;
assert.match(replInput, /run_source/);
assert.deepEqual(replItems, [
  { type: 'command', text: 'x <- 1' },
  { type: 'stdout', text: '[1] 1\ntail output' }
], 'contiguous stream lines should be delivered in a browser-friendly batch');
assert.equal(replEngine.replOperation, null);

const boundaryEngine = new WebREngine();
boundaryEngine.ready = true;
boundaryEngine.replAtPrompt = true;
boundaryEngine.webR = { writeConsole() {} };
const firstBoundaryItems = [];
const firstBoundary = boundaryEngine.runReplCommand('first', {
  token: 'first',
  onOutput: async item => firstBoundaryItems.push(item)
});
await new Promise(resolve => setImmediate(resolve));
await boundaryEngine.handleOutputMessage({ type: 'stderr', data: '<<WEBRSTUDIO:START>>first' });
await boundaryEngine.handleOutputMessage({ type: 'stdout', data: '* point 3<<WEBRSTUDIO:FLUSH>>first' });
await boundaryEngine.handleOutputMessage({ type: 'stderr', data: '<<WEBRSTUDIO:DONE>>first' });
await boundaryEngine.handleOutputMessage({ type: 'prompt', data: '> ' });
await firstBoundary;

const secondBoundaryItems = [];
const secondBoundary = boundaryEngine.runReplCommand('second', {
  token: 'second',
  onOutput: async item => secondBoundaryItems.push(item)
});
await new Promise(resolve => setImmediate(resolve));
await boundaryEngine.handleOutputMessage({ type: 'stderr', data: '<<WEBRSTUDIO:START>>second' });
await boundaryEngine.handleOutputMessage({ type: 'stdout', data: 'x | y\n--- | ---\n1 | 2<<WEBRSTUDIO:FLUSH>>second' });
await boundaryEngine.handleOutputMessage({ type: 'stderr', data: '<<WEBRSTUDIO:DONE>>second' });
await boundaryEngine.handleOutputMessage({ type: 'prompt', data: '> ' });
await secondBoundary;
assert.deepEqual(firstBoundaryItems, [{ type: 'stdout', text: '* point 3' }]);
assert.deepEqual(secondBoundaryItems, [{ type: 'stdout', text: 'x | y\n--- | ---\n1 | 2' }], 'partial stdout must not leak into the next R Markdown chunk');

const finishingEngine = new WebREngine();
let finishingInterruptCalls = 0;
finishingEngine.running = true;
finishingEngine.interruptSupported = true;
finishingEngine.executionPhase = 'evaluating';
finishingEngine.webR = { interrupt() { finishingInterruptCalls += 1; } };
finishingEngine.replOperation = {
  token: 'fast', operationName: 'execute', started: true, done: false,
  flushed: false, prompt: false, interruptRequested: false
};
finishingEngine.preflightOutputMessages([
  { type: 'stdout', data: '[1] 10000' },
  { type: 'stdout', data: '<<WEBRSTUDIO:FLUSH>>fast' },
  { type: 'stderr', data: '<<WEBRSTUDIO:DONE>>fast' },
  { type: 'prompt', data: '> ' }
]);
assert.equal(finishingEngine.executionPhase, 'finalizing');
assert.deepEqual(finishingEngine.requestInterrupt(), { ok: false, reason: 'finishing' });
assert.equal(finishingInterruptCalls, 0, 'Stop must not interrupt a completed expression while its output is still rendering');

const stalePromptEngine = new WebREngine();
stalePromptEngine.ready = true;
stalePromptEngine.replAtPrompt = true;
stalePromptEngine.webR = { writeConsole() {} };
const stalePromptItems = [];
const stalePromptRun = stalePromptEngine.runReplCommand('new-command', {
  token: 'new-command',
  onOutput: async item => stalePromptItems.push(item)
});
await new Promise(resolve => setImmediate(resolve));
const stalePromptBatch = [
  { type: 'prompt', data: '> ' },
  { type: 'stderr', data: '<<WEBRSTUDIO:START>>new-command' },
  { type: 'stdout', data: '[1] 1<<WEBRSTUDIO:FLUSH>>new-command' },
  { type: 'stderr', data: '<<WEBRSTUDIO:DONE>>new-command' }
];
stalePromptEngine.preflightOutputMessages(stalePromptBatch);
assert.equal(stalePromptEngine.replOperation.started, false, 'preflight must not commit START before ordered handling');
assert.equal(stalePromptEngine.replOperation.prompt, false, 'a stale prompt must remain uncommitted during preflight');
for (const message of stalePromptBatch) stalePromptEngine.handleOutputMessage(message);
let stalePromptSettled = false;
stalePromptRun.finally(() => { stalePromptSettled = true; });
await new Promise(resolve => setImmediate(resolve));
assert.equal(stalePromptSettled, false, 'a prompt queued before START must not complete the new command');
stalePromptEngine.handleOutputMessage({ type: 'prompt', data: '> ' });
await stalePromptRun;
assert.deepEqual(stalePromptItems, [{ type: 'stdout', text: '[1] 1' }]);

const inputEngine = new WebREngine();
inputEngine.ready = true;
inputEngine.running = true;
inputEngine.interruptSupported = true;
inputEngine.replAtPrompt = true;
const inputWrites = [];
inputEngine.webR = { writeConsole(value) { inputWrites.push(value); }, interrupt() {} };
const inputRun = inputEngine.runReplCommand('prompting-command', { token: 'input-flow' });
await new Promise(resolve => setImmediate(resolve));
inputEngine.handleOutputMessage({ type: 'stderr', data: '<<WEBRSTUDIO:START>>input-flow' });
inputEngine.preflightOutputMessages([{ type: 'prompt', data: '> ' }]);
assert.equal(inputEngine.executionPhase, 'waiting-input');
assert.equal(inputEngine.replOperation.prompt, false, 'An input prompt must not mark an operation complete.');
inputEngine.handleOutputMessage({ type: 'prompt', data: '> ' });
const firstInput = inputEngine.pendingConsoleInput;
assert.equal(firstInput.prompt, '> ', 'A readline prompt can look like the top-level R prompt.');
assert.equal(inputEngine.replAtPrompt, false);
assert.throws(() => inputEngine.submitConsoleInput('one\ntwo', firstInput.id), /single line/);
assert.equal(inputEngine.pendingConsoleInput.id, firstInput.id, 'Rejected multiline input must leave the prompt answerable.');
assert.equal(inputEngine.submitConsoleInput('', firstInput.id), true, 'An empty readline response is valid.');
assert.equal(inputEngine.pendingConsoleInput, null);
assert.equal(inputEngine.executionPhase, 'evaluating');
assert.throws(() => inputEngine.submitConsoleInput('stale', firstInput.id), /no longer waiting/);
inputEngine.handleOutputMessage({ type: 'prompt', data: '' });
const secondInput = inputEngine.pendingConsoleInput;
assert.notEqual(secondInput.id, firstInput.id);
assert.throws(() => inputEngine.submitConsoleInput('stale', firstInput.id), /no longer waiting/);
inputEngine.submitConsoleInput('  literal text  ', secondInput.id);
assert.deepEqual(inputWrites, ['prompting-command', '', '  literal text  '], 'Replies preserve whitespace and are written once as raw stdin.');
inputEngine.handleOutputMessage({ type: 'stdout', data: '<<WEBRSTUDIO:FLUSH>>input-flow' });
inputEngine.handleOutputMessage({ type: 'stderr', data: '<<WEBRSTUDIO:DONE>>input-flow' });
inputEngine.handleOutputMessage({ type: 'prompt', data: 'custom R prompt: ' });
await inputRun;
assert.equal(inputEngine.pendingConsoleInput, null);
assert.equal(inputEngine.replAtPrompt, true, 'A configured R prompt must still finish a marked operation.');

const cancelInputRun = inputEngine.runReplCommand('another-prompt', { token: 'cancel-input' });
const cancelledInput = assert.rejects(cancelInputRun, /fixture restart/);
await new Promise(resolve => setImmediate(resolve));
inputEngine.handleOutputMessage({ type: 'stderr', data: '<<WEBRSTUDIO:START>>cancel-input' });
inputEngine.handleOutputMessage({ type: 'prompt', data: 'Selection: ' });
const cancelledRequest = inputEngine.pendingConsoleInput;
inputEngine.abortReplOperation(new Error('fixture restart'));
await cancelledInput;
assert.equal(inputEngine.pendingConsoleInput, null);
assert.throws(() => inputEngine.submitConsoleInput('1', cancelledRequest.id), /no longer waiting/);
assert.equal(inputWrites.at(-1), 'another-prompt', 'A late reply after cancellation must never become a new R command.');

const unsupportedInputEngine = new WebREngine();
unsupportedInputEngine.executionPhase = 'evaluating';
unsupportedInputEngine.replOperation = {
  token: 'postmessage-input', operationName: 'execute', started: true,
  done: false, flushed: false, prompt: false, settled: false
};
unsupportedInputEngine.preflightOutputMessages([{ type: 'prompt', data: 'Selection: ' }]);
unsupportedInputEngine.handleOutputMessage({ type: 'prompt', data: 'Selection: ' });
assert.equal(unsupportedInputEngine.pendingConsoleInput, null, 'A channel without nested stdin support must not offer an unusable response input.');
assert.equal(unsupportedInputEngine.executionPhase, 'evaluating');

const interruptEngine = new WebREngine();
let interruptCalls = 0;
interruptEngine.running = true;
interruptEngine.executionPhase = 'evaluating';
interruptEngine.webR = { interrupt() { interruptCalls += 1; } };
assert.equal(interruptEngine.interrupt(), false, 'PostMessage sessions must not claim that an interrupt was delivered');
interruptEngine.interruptSupported = true;
interruptEngine.replOperation = {
  interruptRequested: false, started: true, done: false, prompt: false
};
assert.equal(interruptEngine.interrupt(), true);
assert.equal(interruptCalls, 1);
assert.equal(interruptEngine.replOperation.interruptRequested, true);

const interruptedStreamEngine = new WebREngine();
const interruptedStreamItems = [];
let statePreservingInterrupts = 0;
interruptedStreamEngine.ready = true;
interruptedStreamEngine.running = true;
interruptedStreamEngine.interruptSupported = true;
interruptedStreamEngine.replAtPrompt = true;
interruptedStreamEngine.webR = {
  writeConsole() {},
  interrupt() { statePreservingInterrupts += 1; }
};
const interruptedRun = interruptedStreamEngine.runReplCommand('long-running-command', {
  token: 'interrupt-stream',
  onOutput: async item => interruptedStreamItems.push(item)
});
await new Promise(resolve => setImmediate(resolve));
await interruptedStreamEngine.handleOutputMessage({ type: 'stderr', data: '<<WEBRSTUDIO:START>>interrupt-stream' });
await interruptedStreamEngine.handleOutputMessage({ type: 'stdout', data: '[1] output before stop' });
assert.equal(interruptedStreamEngine.interrupt(), true);
await interruptedStreamEngine.handleOutputMessage({ type: 'stdout', data: '[2] already queued after stop' });
await interruptedStreamEngine.handleOutputMessage({ type: 'stderr', data: '<<WEBRSTUDIO:ERROR>>Execution interrupted' });
await interruptedStreamEngine.handleOutputMessage({ type: 'stdout', data: '<<WEBRSTUDIO:FLUSH>>interrupt-stream' });
await interruptedStreamEngine.handleOutputMessage({ type: 'stderr', data: '<<WEBRSTUDIO:DONE>>interrupt-stream' });
await interruptedStreamEngine.handleOutputMessage({ type: 'prompt', data: '> ' });
await interruptedRun;
assert.equal(statePreservingInterrupts, 1);
assert.deepEqual(interruptedStreamItems, [
  { type: 'stdout', text: '[1] output before stop\n[2] already queued after stop' }
], 'interrupt must retain already-produced output while suppressing webR internal interrupt wording');
assert.equal(interruptedStreamEngine.webR !== null, true, 'interrupt must retain the same worker');

const stateInspectionEngine = new WebREngine();
let stateInspectionCalls = 0;
stateInspectionEngine.webR = {
  async evalRString() {
    stateInspectionCalls += 1;
    if (stateInspectionCalls === 1) throw new Error('A non-local transfer of control occurred during evaluation');
    return '0|1';
  }
};
assert.deepEqual(await stateInspectionEngine.readLastRunState(), {
  interrupted: false,
  ok: true,
  boundaryInterrupt: true
}, 'an interrupt consumed after user evaluation must be classified as a late boundary interrupt');

const virtualFilesEngine = new WebREngine();
virtualFilesEngine.ready = true;
virtualFilesEngine.evalStringArray = async expression => {
  assert.match(expression, /list\.files/);
  const record = fields => fields.map(value => encodeURIComponent(String(value))).join('\u001f');
  return [
    record(['plots', '/project/plots', 'TRUE', 0, 1700000000]),
    record(['result.csv', '/project/result.csv', 'FALSE', 12, 1700000001])
  ];
};
virtualFilesEngine.webR = {
  FS: { async readFile(path) { assert.equal(path, '/project/result.csv'); return Uint8Array.from([1, 2, 3]); } }
};
const virtualListing = await virtualFilesEngine.listVirtualFiles('project\\results/..');
assert.equal(virtualListing.path, '/project');
assert.deepEqual(virtualListing.entries, [
  { name: 'plots', path: '/project/plots', isDirectory: true, size: 0, modifiedAt: 1700000000000 },
  { name: 'result.csv', path: '/project/result.csv', isDirectory: false, size: 12, modifiedAt: 1700000001000 }
]);
assert.deepEqual([...await virtualFilesEngine.readVirtualFile('/project/result.csv')], [1, 2, 3]);

const submissionConsole = Object.create(ConsoleManager.prototype);
let submissionValue = 'first command';
let consoleReadOnly = false;
let submitCalls = 0;
const submitResolvers = [];
submissionConsole.busy = false;
submissionConsole.submissionEpoch = 0;
submissionConsole.getValue = () => submissionValue;
submissionConsole.setValue = value => { submissionValue = value; };
submissionConsole.pushHistory = () => {};
submissionConsole.appendEntry = async () => {};
submissionConsole.setReadOnly = value => { consoleReadOnly = value; };
submissionConsole.focus = () => {};
submissionConsole.callbacks = {
  onSubmit() {
    submitCalls += 1;
    return new Promise(resolve => submitResolvers.push(resolve));
  }
};
const firstSubmission = submissionConsole.submit();
await new Promise(resolve => setImmediate(resolve));
assert.equal(submissionConsole.busy, true);
assert.equal(consoleReadOnly, true);
submissionConsole.resetExecutionState();
assert.equal(submissionConsole.busy, false);
assert.equal(consoleReadOnly, false);
submissionValue = 'second command';
const secondSubmission = submissionConsole.submit();
await new Promise(resolve => setImmediate(resolve));
assert.equal(submitCalls, 2);
submitResolvers[0]();
await firstSubmission;
assert.equal(submissionConsole.busy, true, 'a stale submission must not unlock a newer one');
assert.equal(consoleReadOnly, true, 'a stale submission must not make a newer submission editable');
submitResolvers[1]();
await secondSubmission;
assert.equal(submissionConsole.busy, false);
assert.equal(consoleReadOnly, false);

const restartCancellationEngine = new WebREngine();
const cancellationItems = [];
restartCancellationEngine.ready = true;
restartCancellationEngine.replAtPrompt = true;
restartCancellationEngine.emit = () => {};
restartCancellationEngine.webR = {
  FS: {
    async writeFile() {},
    async unlink() {}
  },
  async evalRVoid() {},
  writeConsole() {},
  async close() {}
};
restartCancellationEngine.collectSvgPlots = async () => [];
restartCancellationEngine.initialize = async function initializeAfterCancellation() {
  this.ready = true;
  this.webR = { close() {} };
  return this;
};
const cancelledExecution = restartCancellationEngine.execute('while (TRUE) {}', {
  onOutput: async item => cancellationItems.push(item)
});
await new Promise(resolve => setImmediate(resolve));
await restartCancellationEngine.restart();
const cancelledResult = await cancelledExecution;
assert.equal(cancelledResult.cancelled, true);
assert.equal(cancelledResult.error, 'Execution stopped.');
assert.deepEqual(cancellationItems, [], 'An explicit restart must not print the internal worker-restart error.');
assert.equal(restartCancellationEngine.running, false);

const streamEntries = [];
const streamBodies = new Map();
const fakeConsole = Object.create(ConsoleManager.prototype);
fakeConsole.transcript = [];
fakeConsole.settings = { consoleFollow: false };
fakeConsole.callbacks = { onTranscriptChange() {} };
fakeConsole.output = {
  scrollTop: 0,
  scrollHeight: 0,
  querySelector(selector) {
    const id = selector.match(/data-entry-id="([^"]+)"/)?.[1];
    const body = streamBodies.get(id);
    return body ? { querySelector: () => body } : null;
  }
};
fakeConsole.appendEntry = async (type, text) => {
  const entry = { id: `entry-${streamEntries.length}`, type, text: String(text), timestamp: Date.now() };
  fakeConsole.transcript.push(entry);
  streamEntries.push(entry);
  streamBodies.set(entry.id, { textContent: entry.text });
  return entry;
};
const streamSession = fakeConsole.beginStream();
await fakeConsole.appendStreamItem(streamSession, { type: 'stdout', text: 'first' });
await fakeConsole.appendStreamItem(streamSession, { type: 'stdout', text: 'second' });
await fakeConsole.appendStreamItem(streamSession, { type: 'command', text: 'x <- 1' });
await fakeConsole.appendStreamItem(streamSession, { type: 'stdout', text: '[1] 1' });
fakeConsole.endStream(streamSession);
assert.deepEqual(streamEntries.map(({ type, text }) => ({ type, text })), [
  { type: 'output', text: 'first\nsecond' },
  { type: 'command', text: 'x <- 1' },
  { type: 'output', text: '[1] 1' }
]);

const downloadItems = [
  { type: 'stderr', text: "trying URL 'https://example.org/data.csv'" },
  { type: 'stdout', text: '[1] 0' },
  { type: 'message', text: 'Download message' },
  { type: 'warning', text: 'Download warning' },
  { type: 'error', text: 'Actual download failure' }
];
const expectedDownloadEntries = [
  { type: 'output', text: "trying URL 'https://example.org/data.csv'\n[1] 0" },
  { type: 'message', text: 'Download message' },
  { type: 'warning', text: 'Download warning' },
  { type: 'error', text: 'Actual download failure' }
];
const streamedDownloadStart = streamEntries.length;
const downloadStream = fakeConsole.beginStream();
for (const item of downloadItems) await fakeConsole.appendStreamItem(downloadStream, item);
fakeConsole.endStream(downloadStream);
assert.deepEqual(streamEntries.slice(streamedDownloadStart).map(({ type, text }) => ({ type, text })), expectedDownloadEntries,
  'Streamed raw stderr is ordinary output; structured R conditions retain their distinct types.');
const batchedDownloadStart = streamEntries.length;
await fakeConsole.appendExecution({ ok: false, outputs: downloadItems }, { showTiming: false, showTraceback: false });
assert.deepEqual(streamEntries.slice(batchedDownloadStart).map(({ type, text }) => ({ type, text })), expectedDownloadEntries,
  'Batched output must classify progress and structured R conditions consistently with streaming.');
const previousAce = globalThis.ace;
let highlightedTheme = '';
globalThis.ace = {
  config: {
    set() {},
    loadModule(id, callback) {
      assert.equal(id, 'ace/ext/static_highlight');
      callback({
        render(code, mode, theme, lineStart, disableGutter, done) {
          assert.equal(mode, 'ace/mode/r');
          assert.equal(lineStart, 1);
          assert.equal(disableGutter, true);
          highlightedTheme = theme;
          done({ html: `<span>${code}</span>` });
        }
      });
    }
  }
};
try {
  assert.equal(await EditorManager.highlightR('x <- 1', 'dracula'), '<span>x <- 1</span>');
  assert.equal(highlightedTheme, 'ace/theme/dracula');
} finally {
  if (previousAce === undefined) delete globalThis.ace;
  else globalThis.ace = previousAce;
}
const themedConsole = Object.create(ConsoleManager.prototype);
themedConsole.theme = 'crimson_editor';
themedConsole.transcript = [{ type: 'command', text: 'x <- 1' }];
let appliedConsoleTheme = '';
let transcriptRenders = 0;
themedConsole.editor = {
  async setTheme(theme) { appliedConsoleTheme = theme; }
};
themedConsole.renderTranscript = async () => { transcriptRenders += 1; };
await themedConsole.setTheme('dracula');
assert.equal(themedConsole.theme, 'dracula');
assert.equal(appliedConsoleTheme, 'ace/theme/dracula');
assert.equal(transcriptRenders, 1);
await themedConsole.setTheme('dracula');
assert.equal(transcriptRenders, 1);

const engine = new WebREngine();
const trace = engine.cleanTraceback([
  'doTryCatch(return(expr), name, parentenv, handler)',
  'efun(expr)',
  'eval(expr, env)',
  'trace_level_1(4)',
  'trace_level_2(log1p(x))',
  'trace_level_3(transformed)',
  'stop("Deliberate failure", call. = FALSE)',
  'value[[3L]](cond)'
], 'trace_level_1(4)', 'stop("Deliberate failure", call. = FALSE)');
assert.equal(trace[0], 'Expression: trace_level_1(4)');
assert.equal(trace[1], 'Failing call: stop("Deliberate failure", call. = FALSE)');
assert.equal(trace.some(line => line.includes('trace_level_2')), true);
assert.equal(trace.some(line => /doTryCatch|efun\(expr\)|value\[\[3L/.test(line)), false);

const traceWithInternalConditionCall = engine.cleanTraceback([
  'eval(expr, env)',
  'outer()',
  'inner()',
  'stop("boom", call. = FALSE)',
  '(function (condition) { value[[3L]](cond) })(structure(list()))'
], 'outer()', 'eval(expr, env)');
assert.equal(traceWithInternalConditionCall[1], 'Failing call: stop("boom", call. = FALSE)');
assert.equal(traceWithInternalConditionCall.some(line => line.includes('eval(expr, env)')), false);

let completionInserted = 0;
let indentCommands = 0;
assert.equal(acceptAceCompletionOrIndent({
  completer: { activated: true, insertMatch: () => { completionInserted += 1; } },
  execCommand: () => { indentCommands += 1; }
}), true);
assert.equal(completionInserted, 1);
assert.equal(indentCommands, 0);
assert.equal(acceptAceCompletionOrIndent({
  completer: { popup: { isOpen: () => true }, insertMatch: () => { completionInserted += 1; } },
  execCommand: () => { indentCommands += 1; }
}), true);
assert.equal(completionInserted, 2);
assert.equal(acceptAceCompletionOrIndent({
  completer: { activated: false, popup: { isOpen: false }, insertMatch: () => { completionInserted += 1; } },
  execCommand: command => { if (command === 'indent') indentCommands += 1; }
}), false);
assert.equal(indentCommands, 1);

const liveSession = {
  value: 'live text',
  setValueCalls: 0,
  getValue() { return this.value; },
  setValue(value) { this.value = value; this.setValueCalls += 1; },
  getScrollTop() { return 27; },
  setScrollTop(value) { this.restoredScrollTop = value; }
};
const fakeEditorManager = Object.create(EditorManager.prototype);
fakeEditorManager.files = new Map([['script.R', { path: 'script.R', content: 'old text' }]]);
fakeEditorManager.sessions = new Map([['script.R', {
  session: liveSession,
  file: { path: 'script.R', content: 'old text' },
  cursor: { row: 2, column: 4 },
  scrollTop: 27
}]]);
fakeEditorManager.activePath = 'script.R';
fakeEditorManager.fallbackMode = false;
fakeEditorManager.editor = {
  session: liveSession,
  getCursorPosition: () => ({ row: 2, column: 4 }),
  getSelectionRange: () => ({ isEmpty: () => true }),
  moveCursorTo(row, column) { this.restoredCursor = { row, column }; }
};
fakeEditorManager.addOrUpdateFile({ path: 'script.R', content: 'stale persistence value' });
assert.equal(liveSession.setValueCalls, 0, 'ordinary metadata sync must not reset a live Ace session');
assert.equal(fakeEditorManager.files.get('script.R').content, 'live text');
fakeEditorManager.addOrUpdateFile(
  { path: 'script.R', content: 'explicit external replacement' },
  { syncContent: true }
);
assert.equal(liveSession.setValueCalls, 1);
assert.deepEqual(fakeEditorManager.editor.restoredCursor, { row: 2, column: 4 });
assert.equal(liveSession.restoredScrollTop, 27);

const markerOwner = {
  annotations: null,
  removed: [],
  setAnnotations(value) { this.annotations = value; },
  removeMarker(value) { this.removed.push(value); }
};
const currentMarkerSession = {
  removed: [],
  setAnnotations() {},
  removeMarker(value) { this.removed.push(value); }
};
fakeEditorManager.lintMarkerSession = markerOwner;
fakeEditorManager.lintMarkers = [11, 12];
fakeEditorManager.editor.session = currentMarkerSession;
fakeEditorManager.clearDiagnostics();
assert.deepEqual(markerOwner.removed, [11, 12]);
assert.deepEqual(currentMarkerSession.removed, []);
fakeEditorManager.rainbowMarkerSession = markerOwner;
fakeEditorManager.rainbowMarkers = [21];
fakeEditorManager.clearRainbowMarkers();
assert.deepEqual(markerOwner.removed, [11, 12, 21]);

const rmdMarkerRanges = [];
const rmdMarkerSession = {
  removed: [],
  getLine(row) { return ['```{r}', 'x <- 1', '```'][row] || ''; },
  addMarker(range, className, type, inFront) {
    rmdMarkerRanges.push({
      start: { row: range.start.row, column: range.start.column },
      end: { row: range.end.row, column: range.end.column },
      className,
      type,
      inFront
    });
    return 31;
  },
  removeMarker(value) { this.removed.push(value); }
};
const rmdMarkerManager = Object.create(EditorManager.prototype);
rmdMarkerManager.fallbackMode = false;
rmdMarkerManager.activePath = 'report.Rmd';
rmdMarkerManager.rMarkdownChunkMarkers = [];
rmdMarkerManager.rMarkdownChunkMarkerSession = null;
rmdMarkerManager.ace = {
  require(id) {
    assert.equal(id, 'ace/range');
    return {
      Range: class Range {
        constructor(startRow, startColumn, endRow, endColumn) {
          this.start = { row: startRow, column: startColumn };
          this.end = { row: endRow, column: endColumn };
        }
      }
    };
  }
};
rmdMarkerManager.editor = {
  session: rmdMarkerSession,
  getValue: () => '```{r}\nx <- 1\n```'
};
rmdMarkerManager.updateRMarkdownChunkMarkers();
assert.deepEqual(rmdMarkerRanges, [{
  start: { row: 0, column: 0 },
  end: { row: 2, column: 3 },
  className: 'rmarkdown-chunk-background',
  type: 'fullLine',
  inFront: false
}]);
rmdMarkerManager.clearRMarkdownChunkMarkers();
assert.deepEqual(rmdMarkerSession.removed, [31]);

assert.deepEqual(parseCapturedOutput([
  { type: 'stdout', data: 'first line\nsecond line\n' },
  { type: 'stderr', data: 'ordinary stderr\n<<WEBRSTUDIO:MESSAGE>>hello\n<<WEBRSTUDIO:WARNING>>careful\n' },
  { type: 'stderr', data: '<<WEBRSTUDIO:ERROR>>failed' }
]), [
  { type: 'stdout', text: 'first line\nsecond line' },
  { type: 'stderr', text: 'ordinary stderr' },
  { type: 'message', text: 'hello' },
  { type: 'warning', text: 'careful' },
  { type: 'error', text: 'failed' }
]);

assert.deepEqual(parseCapturedOutput([
  { type: 'stderr', data: '<<WEBRSTUDIO:ECHO>>x%20%3C-%201%0Aprint(x)' }
]), [
  { type: 'command', text: 'x <- 1\nprint(x)' }
], 'source echo markers should become complete command blocks');

assert.deepEqual(parseCapturedOutput([
  { type: 'stdout', data: ' [1] 1 2 3 4 5' },
  { type: 'stdout', data: ' [6] 6 7 8 9 10' },
  { type: 'stdout', data: '[11] 11 12' }
]), [
  { type: 'stdout', text: ' [1] 1 2 3 4 5\n [6] 6 7 8 9 10\n[11] 11 12' }
], 'contiguous captureR lines should render as one R output block');

assert.deepEqual(parseCapturedOutput([
  { type: 'stderr', data: 'diagnostic line 1' },
  { type: 'stderr', data: 'diagnostic line 2' },
  { type: 'stderr', data: '<<WEBRSTUDIO:WARNING>>condition boundary' },
  { type: 'stderr', data: 'diagnostic line 3' }
]), [
  { type: 'stderr', text: 'diagnostic line 1\ndiagnostic line 2' },
  { type: 'warning', text: 'condition boundary' },
  { type: 'stderr', text: 'diagnostic line 3' }
], 'condition markers should split otherwise contiguous stream output');

assert.deepEqual(parseCapturedOutput([
  { type: 'stdout', data: '\x1b[?25h    x y' },
  { type: 'stdout', data: '\x1b[?25h1   1 2' }
]), [
  { type: 'stdout', text: '    x y\n1   1 2' }
], 'interactive cursor-control sequences must not reach console or R Markdown output');

let debounceCalls = 0;
const debounced = debounce(value => { debounceCalls += value; }, 1000);
assert.equal(debounced.flush(), undefined);
debounced(2);
assert.equal(debounced.pending(), true);
debounced.flush();
assert.equal(debounceCalls, 2);
assert.equal(debounced.pending(), false);
debounced.cancel();

console.log('Unit checks passed: expressions, help interception, R Markdown grammar loading, chunk highlighting, chunk options and figure sizing, GFM ZIP bundles, inline code, lint context, completion acceptance, editor session stability, normalized and real-time console execution, output batching, phase-aware state-preserving interruption, runtime file browsing, restart-safe console editing, captured output, traceback cleanup, debounce state, outline, indentation, and delimited parsing.');
