import assert from 'node:assert/strict';
import {
  currentRExpression, debounce, expressionState, extractHelpRequest, inlineRCodeSource, parseDelimited,
  resolveRMarkdownFigureOptions, smartIndentR, splitRMarkdown
} from '../js/utils.js';
import {
  acceptAceCompletionOrIndent, assignmentEqualsPositions, EditorManager,
  outlineFromSource, rMarkdownCode, rParserUnits, staticDiagnostics
} from '../js/editor.js';
import { parseCapturedOutput, WebREngine } from '../js/webr-engine.js';
import { ConsoleManager } from '../js/console.js';

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
const rmdDiagnostics = staticDiagnostics(rmd, 'report.Rmd');
assert.equal(rmdDiagnostics.some(item => item.row === 2), false);
assert.equal(rmdDiagnostics.some(item => item.row === 5 && item.source === 'correctness/logical-shorthand'), true);
assert.equal(rmdDiagnostics.some(item => item.row === 6 && item.source === 'correctness/seq-along'), true);

assert.equal(inlineRCodeSource('r 2 + 2'), '2 + 2');
assert.equal(inlineRCodeSource(' r 2 + 2'), '');
assert.equal(inlineRCodeSource('python 2 + 2'), '');

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

const sourceEngine = new WebREngine();
let sourceExpression = '';
const streamedSourceItems = [];
sourceEngine.ready = true;
sourceEngine.emit = () => {};
sourceEngine.webR = {
  async evalRVoid() {},
  async evalRBoolean() { return true; },
  async evalRString() { return ''; }
};
sourceEngine.collectSvgPlots = async () => [];
sourceEngine.runReplCommand = async (expression, { token, onOutput }) => {
  sourceExpression = expression;
  assert.match(token, /^source_/);
  await onOutput({ type: 'command', text: 'x <- 1' });
  await onOutput({ type: 'stdout', text: '[1] 1' });
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
// The primary R prompt, rather than DONE, is the definitive completion event.
await replEngine.handleOutputMessage({ type: 'stdout', data: 'tail output' });
await replEngine.handleOutputMessage({ type: 'prompt', data: '> ' });
await replRun;
assert.match(replInput, /run_source/);
assert.deepEqual(replItems, [
  { type: 'command', text: 'x <- 1' },
  { type: 'stdout', text: '[1] 1' },
  { type: 'stdout', text: 'tail output' }
]);
assert.equal(replEngine.replOperation, null);

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

let debounceCalls = 0;
const debounced = debounce(value => { debounceCalls += value; }, 1000);
assert.equal(debounced.flush(), undefined);
debounced(2);
assert.equal(debounced.pending(), true);
debounced.flush();
assert.equal(debounceCalls, 2);
assert.equal(debounced.pending(), false);
debounced.cancel();

console.log('Unit checks passed: expressions, help interception, R Markdown chunk options and figure sizing, inline code, lint context, completion acceptance, editor session stability, real-time sourcing, captured output, traceback cleanup, debounce state, outline, indentation, and delimited parsing.');
