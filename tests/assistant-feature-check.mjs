import assert from 'node:assert/strict';
import {
  ASSISTANT_PROMPT_CHARS, boundedText, buildAssistantMessages, cachedObjectContext,
  captureTarget, executionContext, insertAtSnapshot, relevantObjectNames,
  replyParts, sourceContext, suggestionCode, targetMatches
} from '../js/assistant-context.js';

const objects = [
  { name: 'dt', className: 'data.table, data.frame', dimensions: '1000000 × 3', preview: 'PRIVATE_VALUE' },
  { name: 'fit', className: 'function', preview: 'PRIVATE_BODY' },
  { name: 'strange[.+]', type: 'double' },
  { name: 'a', type: 'logical' }
];
const inventory = cachedObjectContext(objects);
assert.match(inventory, /1000000/);
assert.doesNotMatch(inventory, /PRIVATE/);
assert.deepEqual(relevantObjectNames(objects, 'Transform dt and call fit(dt)'), ['dt', 'fit']);
assert.deepEqual(relevantObjectNames(objects, 'strange[.+] then data'), ['strange[.+]']);
assert.deepEqual(relevantObjectNames(objects, 'dt', ['fit', 'unknown']), ['fit']);
assert.equal(relevantObjectNames(Array.from({ length: 100 }, (_, i) => ({ name: `x${i}` })), '', Array.from({ length: 100 }, (_, i) => `x${i}`)).length, 6);
assert.equal(cachedObjectContext(Array.from({ length: 100 }, (_, i) => ({ name: `x${i}`, type: 'double' }))).split('\n').length, 13);

for (const limit of [0, 1, 5, 12, 80]) assert.ok(boundedText('x'.repeat(1000), limit).length <= limit);
const huge = 'A'.repeat(100_000);
const question = 'Keep this exact user instruction. '.repeat(30);
for (const suggestion of [false, true]) {
  const messages = buildAssistantMessages({ question, context: huge, source: huge, output: huge,
    history: Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: huge })), suggestion });
  assert.ok(messages.reduce((n, message) => n + message.content.length, 0) <= ASSISTANT_PROMPT_CHARS);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages.at(-1).role, 'user');
  assert.ok(messages.at(-1).content.endsWith(question));
  assert.match(messages[0].content, /untrusted data/);
}
const withHistory = buildAssistantMessages({ question: 'Why?', history: [{ role: 'user', content: 'First' }, { role: 'assistant', content: 'Answer' }] });
assert.deepEqual(withHistory.map(item => item.role), ['system', 'user', 'assistant', 'user']);

const fallback = {
  value: 'sum(dt$x)', selectionStart: 4, selectionEnd: 8,
  dispatchEvent() {},
  setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); this.selectionStart = this.selectionEnd = start + text.length; }
};
const manager = { fallbackMode: true, fallback, getValue() { return fallback.value; }, focus() {},
  insertText(text) { fallback.setRangeText(text, fallback.selectionStart, fallback.selectionEnd); } };
const app = { activePath: 'test.R', engine: { running: false, generation: 1 }, projectRuntimeRevision: 2, editor: manager, console: manager };
let snapshot = captureTarget(app);
assert.equal(snapshot.source.slice(snapshot.start, snapshot.end), 'dt$x');
assert.match(sourceContext(snapshot), /Selected text:\ndt\$x/);
assert.ok(targetMatches(app, snapshot));
fallback.selectionStart = 5;
assert.ok(!targetMatches(app, snapshot));
assert.throws(() => insertAtSnapshot(app, snapshot, 'BAD'), /changed/);
fallback.selectionStart = 4;
app.activePath = 'other.R';
assert.ok(!targetMatches(app, snapshot));
app.activePath = 'test.R';
app.engine.generation++;
assert.ok(!targetMatches(app, snapshot));
app.engine.generation--;
app.projectRuntimeRevision++;
assert.ok(!targetMatches(app, snapshot));
app.projectRuntimeRevision--;
insertAtSnapshot(app, snapshot, 'dt$y');
assert.equal(fallback.value, 'sum(dt$y)');
assert.throws(() => insertAtSnapshot(app, snapshot, 'BAD'), /changed/);
manager.inputRequest = { id: 1 };
assert.throws(() => captureTarget(app, 'console'), /idle/);
delete manager.inputRequest;
app.engine.running = true;
assert.throws(() => captureTarget(app, 'console'), /idle/);
app.engine.running = false;
snapshot = captureTarget(app, 'console');
insertAtSnapshot(app, snapshot, 'z');
assert.equal(fallback.value, 'sum(dt$yz)');

const reply = 'Text <img src=x onerror=alert(1)>\n```r\nx <- mean(dt$x)\n```\n```js\nalert(1)\n```';
const parts = replyParts(reply);
assert.equal(parts.filter(item => item.type === 'r').length, 1);
assert.equal(parts.find(item => item.type === 'code').text, 'alert(1)');
assert.ok(parts[0].text.includes('<img'));
assert.equal(suggestionCode('```r\nx <- 1\n```'), 'x <- 1');
assert.equal(suggestionCode('```r\nx <- 1'), '');
assert.equal(suggestionCode('```r\nx\n```\n```r\ny\n```'), '');
assert.equal(suggestionCode('sum(dt$x)'), 'sum(dt$x)');
const result = executionContext({ ok: false, error: huge, outputs: Array.from({ length: 1000 }, () => ({ type: 'stdout', text: huge })), plots: [{}, {}] });
assert.ok(result.length <= 1400);
assert.match(result, /^R result: error/);

console.log('Assistant feature checks passed: bounded prompts and object metadata, literal names, exact edit snapshots, session changes, safe code-block parsing, and bounded execution feedback.');
