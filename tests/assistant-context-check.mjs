import assert from 'node:assert/strict';
import { WebREngine } from '../js/webr-engine.js';
import { rVector } from '../js/utils.js';

const row = (...fields) => fields.map(value => encodeURIComponent(value)).join('\u001f');
const engine = new WebREngine();
let calls = 0;
let source = '';
let reply = [
  'META\u001fFALSE',
  row('sales', 'list', 'data.table, data.frame', '1000000 rows x 2 columns', 'country: character\namount: double'),
  row('clean', 'closure', 'function', '', 'function(x, ...); defaults omitted'),
  row('live', 'active binding', '', '', 'Skipped: inspecting this binding would run R code.')
];
const runtime = {
  async evalRRaw(code, type, options) {
    calls += 1;
    source = code;
    assert.equal(type, 'string[]');
    assert.deepEqual(options, { captureStreams: false });
    return reply;
  }
};
engine.webR = runtime;

await assert.rejects(engine.getAssistantContext(), /not ready/);
assert.equal(calls, 0, 'an offline assistant must not enqueue R inspection');
engine.ready = true;
engine.running = true;
await assert.rejects(engine.getAssistantContext(), /while R is executing/);
assert.equal(calls, 0, 'completion/context must yield to a running R task');
engine.running = false;

const context = await engine.getAssistantContext();
assert.equal(context.generation, 0);
assert.equal(context.truncated, false);
assert.equal(context.objects.length, 3);
assert.equal(context.objects[0].name, 'sales');
assert.equal(context.objects[0].dimensions, '1000000 rows x 2 columns');
assert.match(context.text, /country: character\namount: double/);
assert.match(context.text, /live: active binding/);
assert.ok(source.startsWith('base::eval(base::quote('));
assert.ok(source.endsWith('envir = base::new.env(parent = base::baseenv()))'));
assert.ok(source.includes('if (!FALSE || 3L == 0L) return("")'), 'data values are omitted by default');
assert.ok(source.includes('if (FALSE) details <- paste(details, bounded_code(body(object))'), 'function bodies require opt-in');
assert.ok(source.indexOf('bindingIsActive(name, globalenv())') < source.indexOf('object <- get(name,'));
assert.doesNotMatch(source, /object\.size\(|capture\.output\(|\bstr\(|\bsummary\(|\bprint\(/,
  'context inspection must not invoke user display methods or traverse whole objects for their size');
assert.ok(source.includes('nodes > 120L || depth > 10L'));
assert.ok(source.includes('nlines = 12L'));
assert.ok(source.includes('.subset2(object, index)'));
assert.ok(source.includes('count > 24L'));

const literal = 'data"; stop("must not run"); # \\ \n value';
reply = ['META\u001fFALSE', row(literal, 'integer', 'integer', 'length 3', '')];
const named = await engine.getAssistantContext({ names: [literal], includeValues: true, includeFunctionBodies: true });
assert.equal(named.objects[0].name, literal, 'non-syntactic R names round-trip unchanged');
assert.ok(source.includes(`requested <- ${rVector([literal])}`), 'names are data in a quoted vector, never substituted into get expressions');
assert.ok(source.includes('if (!TRUE || 3L == 0L) return("")'));
assert.ok(source.includes('if (TRUE) details <- paste(details, bounded_code(body(object))'));

const beforeInvalid = calls;
for (const names of ['sales', [null], [''], ['n\0ame'], ['x'.repeat(513)]]) {
  await assert.rejects(engine.getAssistantContext({ names }), /exact R object names/);
}
assert.equal(calls, beforeInvalid, 'invalid names must fail before contacting R');

reply = ['META\u001fFALSE', ...Array.from({ length: 80 }, (_, i) => row(`x${i}`, 'integer', 'integer', 'length 1', 'x'.repeat(9000)))];
const bounded = await engine.getAssistantContext({
  names: Array.from({ length: 80 }, (_, i) => `x${i}`),
  maxObjects: 2000, maxColumns: 2000, maxRows: 2000, maxChars: 512
});
assert.ok(bounded.text.length <= 512);
assert.equal(bounded.truncated, true);
assert.ok(bounded.objects.length <= 40);
assert.ok(bounded.objects.every(object => object.details.length <= 512));
assert.ok(source.includes('seq_len(min(length(pool), 40L))'));
assert.ok(source.includes('count = 16L'));
assert.ok(source.includes('lapply(seq_len(5L)'));
assert.ok(source.includes('used >= 512L'));
assert.ok(!source.includes('"x40"'), 'do not even transmit names outside the object budget');

reply = ['META\u001fTRUE', row('sales', 'list', 'data.frame', '', 'More columns omitted.')];
assert.equal((await engine.getAssistantContext()).truncated, true);
reply = ['META\u001fFALSE'];
const empty = await engine.getAssistantContext();
assert.equal(empty.text, '');
assert.deepEqual(empty.objects, []);

runtime.evalRRaw = async () => {
  engine.generation += 1;
  return reply;
};
await assert.rejects(engine.getAssistantContext(), /runtime changed/);
runtime.evalRRaw = async () => {
  engine.webR = {};
  return reply;
};
await assert.rejects(engine.getAssistantContext(), /runtime changed/);
engine.webR = runtime;
runtime.evalRRaw = async () => { throw new Error('R worker transport closed'); };
await assert.rejects(engine.getAssistantContext(), /R worker transport closed/);
assert.equal(engine.running, false, 'failed context collection must not leave the runtime busy');

console.log('Assistant context checks passed: idle guards, literal names, opt-in samples/bodies, capped transport and output, skipped active bindings, and stale-runtime rejection.');
