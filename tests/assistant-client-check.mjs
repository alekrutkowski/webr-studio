import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as shared from '../js/assistant-client.js';

const {
  AssistantClient, ASSISTANT_MODELS, DEFAULT_ASSISTANT_MODEL, ASSISTANT_CONTEXT_TOKENS,
  ASSISTANT_MAX_INPUT_CHARS, assistantCapability, normalizeAssistantRequest
} = shared;
const chat = { messages: [{ role: 'user', content: 'Explain mean(x).' }] };
const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
};

class FakeWorker extends EventTarget {
  constructor() { super(); this.sent = []; this.terminated = false; }
  postMessage(message) { this.sent.push(structuredClone(message)); }
  terminate() { this.terminated = true; }
  receive(data) {
    const event = new Event('message');
    Object.defineProperty(event, 'data', { value: data });
    this.dispatchEvent(event);
  }
  fail(message = 'GPU device lost') {
    const event = new Event('error', { cancelable: true });
    Object.defineProperty(event, 'message', { value: message });
    this.dispatchEvent(event);
  }
  reply(result, request = this.sent.at(-1)) { this.receive({ id: request.id, result }); }
}

function fixture(options = {}) {
  const workers = [];
  const states = [];
  const client = new AssistantClient({
    capabilityCheck: () => ({ supported: true, reason: '' }),
    workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    idleTimeoutMs: 0,
    ...options
  });
  client.addEventListener('state', event => states.push(event.detail));
  return { client, workers, states };
}

async function ready(test) {
  const promise = test.client.load();
  const worker = test.workers.at(-1);
  worker.reply({ modelId: DEFAULT_ASSISTANT_MODEL });
  await promise;
  assert.equal(test.client.state, 'ready');
  return worker;
}

assert.equal(assistantCapability({}).supported, false);
assert.match(assistantCapability({ isSecureContext: true, Worker() {}, navigator: {} }).reason, /WebGPU/);
assert.equal(assistantCapability({ isSecureContext: true, Worker() {}, navigator: { gpu: {} } }).supported, true);
assert.equal(ASSISTANT_MODELS.length, 2);
assert.equal(normalizeAssistantRequest({ ...chat, max_tokens: 999999 }).max_tokens, 384);
assert.equal(normalizeAssistantRequest({ ...chat, max_tokens: -3 }).max_tokens, 1);
assert.equal(normalizeAssistantRequest(chat).max_tokens, 256);
assert.throws(() => normalizeAssistantRequest({ messages: [{ role: 'tool', content: 'run()' }] }), /text system/);
assert.throws(() => normalizeAssistantRequest({ messages: [{ role: 'user', content: () => {} }] }), /text system/);
assert.throws(() => normalizeAssistantRequest({ messages: [{ role: 'user', content: 'x'.repeat(ASSISTANT_MAX_INPUT_CHARS + 1) }] }), /too large/);

// No worker, model, or dependency may be loaded merely by constructing the UI.
const lazy = fixture();
assert.equal(lazy.workers.length, 0);
assert.equal(lazy.client.state, 'unloaded');
await assert.rejects(lazy.client.generate(chat), /Load a local model/);
await assert.rejects(lazy.client.load('untrusted/model'), /supported/);
assert.equal(lazy.workers.length, 0);
lazy.client.dispose();
const unsupported = fixture({ capabilityCheck: () => ({ supported: false, reason: 'No WebGPU.' }) });
await assert.rejects(unsupported.client.load(), /No WebGPU/);
assert.equal(unsupported.workers.length, 0);
unsupported.client.dispose();

// Share identical concurrent loads; reject a second model and overlapping work.
const stream = fixture();
const loading = stream.client.load();
const sameLoad = stream.client.load();
const worker = stream.workers[0];
assert.equal(worker.sent.length, 1);
await assert.rejects(stream.client.load(ASSISTANT_MODELS[1].id), /busy/);
const progress = [];
stream.client.addEventListener('progress', event => progress.push(event.detail));
worker.receive({ id: worker.sent[0].id, event: 'progress', progress: 0.5, text: 'Downloading' });
assert.deepEqual(progress, [{ progress: 0.5, text: 'Downloading' }]);
worker.reply({ modelId: DEFAULT_ASSISTANT_MODEL });
await Promise.all([loading, sameLoad]);
assert.equal(stream.client.modelId, DEFAULT_ASSISTANT_MODEL);
await assert.rejects(stream.client.generate({ messages: [] }), /between/);
assert.equal(stream.client.state, 'ready');
const deltas = [];
const generation = stream.client.generate(chat, { onDelta: delta => deltas.push(delta) });
const generationRequest = worker.sent.at(-1);
await assert.rejects(stream.client.generate(chat), /already generating/);
await assert.rejects(stream.client.load(), /busy/);
worker.receive({ id: generationRequest.id, event: 'delta', delta: 'A mean' });
worker.receive({ id: generationRequest.id, event: 'delta', delta: ' is an average.' });
worker.reply({ text: 'A mean is an average.', usage: { completion_tokens: 6 } }, generationRequest);
assert.deepEqual(await generation, { text: 'A mean is an average.', usage: { completion_tokens: 6 }, interrupted: false });
assert.deepEqual(deltas, ['A mean', ' is an average.']);
assert.equal(stream.client.state, 'ready');

// Stop rejects late output but retains already displayed text and the model.
const stoppedDeltas = [];
const stopped = stream.client.generate(chat, { onDelta: delta => stoppedDeltas.push(delta) });
const stoppedRequest = worker.sent.at(-1);
worker.receive({ id: stoppedRequest.id, event: 'delta', delta: 'partial' });
assert.equal(stream.client.interrupt(), true);
assert.equal(stream.client.interrupt(), false);
assert.deepEqual(worker.sent.at(-1), { method: 'interrupt', targetId: stoppedRequest.id });
worker.receive({ id: stoppedRequest.id, event: 'delta', delta: ' stale' });
worker.reply({ text: 'partial stale', interrupted: true }, stoppedRequest);
assert.deepEqual(await stopped, { text: 'partial', usage: null, interrupted: true });
assert.deepEqual(stoppedDeltas, ['partial']);
assert.equal(stream.client.state, 'ready');

// AbortSignal uses the same Stop path, and already-aborted work never starts.
const preAborted = AbortSignal.abort();
const beforeAbort = worker.sent.length;
await assert.rejects(stream.client.generate(chat, { signal: preAborted }), { name: 'AbortError' });
assert.equal(worker.sent.length, beforeAbort);
const controller = new AbortController();
const aborted = stream.client.generate(chat, { signal: controller.signal });
const abortedRequest = worker.sent.at(-1);
controller.abort();
worker.reply({ text: '', interrupted: true }, abortedRequest);
assert.equal((await aborted).interrupted, true);

// Recoverable request errors leave a loaded model available for a shorter retry.
const tooLong = stream.client.generate(chat);
const tooLongRejection = assert.rejects(tooLong, /context window/);
worker.receive({ id: worker.sent.at(-1).id, error: 'prompt exceeds context window' });
await tooLongRejection;
assert.equal(stream.client.state, 'ready');

// Unload must settle pending promises and ignore all messages from old workers.
const inFlight = stream.client.generate(chat);
const inFlightRejection = assert.rejects(inFlight, { name: 'AbortError' });
const oldRequest = worker.sent.at(-1);
await stream.client.unload();
await inFlightRejection;
assert.equal(worker.terminated, true);
assert.equal(stream.client.state, 'unloaded');
assert.equal(stream.client.pending.size, 0);
const replacement = await ready(stream);
worker.reply({ text: 'old reply' }, oldRequest);
worker.fail('old worker error');
assert.equal(stream.client.state, 'ready');
assert.equal(stream.client.worker, replacement);
stream.client.dispose();
await assert.rejects(stream.client.load(), /disposed/);

const loadStopped = fixture();
const pendingLoad = loadStopped.client.load();
const pendingLoadRejection = assert.rejects(pendingLoad, { name: 'AbortError' });
loadStopped.client.interrupt();
await pendingLoadRejection;
assert.equal(loadStopped.client.state, 'unloaded');
assert.equal(loadStopped.workers[0].terminated, true);
loadStopped.client.dispose();

const loadFailed = fixture();
const rejectedLoad = loadFailed.client.load();
const loadRejection = assert.rejects(rejectedLoad, /Download failed/);
loadFailed.workers[0].receive({ id: loadFailed.workers[0].sent[0].id, error: 'Download failed' });
await loadRejection;
assert.equal(loadFailed.client.state, 'error');
assert.equal(loadFailed.workers[0].terminated, true);
loadFailed.client.dispose();

const crashed = fixture();
const crashWorker = await ready(crashed);
const lost = crashed.client.generate(chat);
const lostRejection = assert.rejects(lost, /device lost/);
crashWorker.fail();
await lostRejection;
assert.equal(crashed.client.state, 'error');
assert.equal(crashed.client.pending.size, 0);
crashed.client.dispose();

// An unresponsive decoder must not trap Stop or strand a loading promise.
const hardStop = fixture({ interruptTimeoutMs: 10 });
const hardWorker = await ready(hardStop);
const hardResult = hardStop.client.generate(chat);
hardWorker.receive({ id: hardWorker.sent.at(-1).id, event: 'delta', delta: 'kept' });
hardStop.client.interrupt();
assert.deepEqual(await hardResult, { text: 'kept', usage: null, interrupted: true });
assert.equal(hardWorker.terminated, true);
assert.equal(hardStop.client.state, 'unloaded');
assert.equal(hardStop.states.at(-1).reason, 'interrupted');
hardStop.client.dispose();

const timedOut = fixture({ loadTimeoutMs: 10 });
await assert.rejects(timedOut.client.load(), /timed out/);
assert.equal(timedOut.client.state, 'error');
assert.equal(timedOut.workers[0].terminated, true);
timedOut.client.dispose();
const timedGeneration = fixture({ generateTimeoutMs: 10 });
await ready(timedGeneration);
await assert.rejects(timedGeneration.client.generate(chat), /timed out/);
assert.equal(timedGeneration.client.state, 'error');
timedGeneration.client.dispose();

const idle = fixture({ idleTimeoutMs: 10 });
await ready(idle);
await delay(25);
assert.equal(idle.client.state, 'unloaded');
assert.equal(idle.states.at(-1).reason, 'idle');
idle.client.dispose();

// Execute the real worker handler with only the external WebLLM dependency
// substituted. This checks RPC ordering, bounded options, cancellation, and
// streamed results without requiring a GPU or downloading model weights.
let workerHandler;
let imports = 0;
let engineInstance;
let chunksFactory = async function* () {
  yield { choices: [{ delta: { content: 'answer' } }] };
  yield { choices: [], usage: { completion_tokens: 1 } };
};
const workerMessages = [];
class FakeMLCEngine {
  constructor(options) {
    this.options = options;
    this.resetCount = 0;
    this.interruptCount = 0;
    this.chat = { completions: { create: async args => { this.request = args; return chunksFactory(); } } };
    engineInstance = this;
  }
  async reload(modelId, options) {
    this.modelId = modelId;
    this.loadOptions = options;
    this.options.initProgressCallback({ progress: 1, text: 'Ready' });
  }
  async resetChat() { this.resetCount += 1; }
  async interruptGenerate() { this.interruptCount += 1; }
}
const source = readFileSync(new URL('../js/assistant-worker.js', import.meta.url), 'utf8')
  .replace(/^import\s*\{([\s\S]*?)\}\s*from\s*'[^']+';/, 'const {$1} = shared;')
  .replace('await import(WEBLLM_MODULE_URL)', 'await importModule(WEBLLM_MODULE_URL)');
vm.runInNewContext(source, {
  shared, setTimeout, clearTimeout, console,
  self: {
    isSecureContext: true, navigator: { gpu: {} },
    addEventListener(type, callback) { if (type === 'message') workerHandler = callback; },
    postMessage(message) { workerMessages.push(structuredClone(message)); }
  },
  importModule: async url => {
    imports += 1;
    assert.equal(url, 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.87/lib/index.js');
    return { MLCEngine: FakeMLCEngine };
  }
});
assert.equal(imports, 0, 'Loading the worker itself must not fetch WebLLM.');
workerHandler({ data: { id: 1, method: 'load', args: { modelId: DEFAULT_ASSISTANT_MODEL } } });
await tick();
assert.equal(imports, 1);
assert.equal(engineInstance.loadOptions.context_window_size, ASSISTANT_CONTEXT_TOKENS);
assert.equal(workerMessages.find(message => message.id === 1 && message.result).result.modelId, DEFAULT_ASSISTANT_MODEL);
workerHandler({ data: { id: 2, method: 'generate', args: { ...chat, max_tokens: 99999 } } });
await tick();
assert.equal(engineInstance.resetCount, 1);
assert.equal(engineInstance.request.max_tokens, 384);
assert.equal(engineInstance.request.stream, true);
assert.deepEqual(workerMessages.find(message => message.id === 2 && message.result).result,
  { text: 'answer', usage: { completion_tokens: 1 }, interrupted: false });
assert.equal(workerMessages.find(message => message.id === 2 && message.event === 'delta').delta, 'answer');

const gate = deferred();
chunksFactory = async function* () {
  yield { choices: [{ delta: { content: 'first' } }] };
  await gate.promise;
  yield { choices: [{ delta: { content: 'late' } }] };
};
workerHandler({ data: { id: 3, method: 'generate', args: chat } });
await tick();
workerHandler({ data: { id: 4, method: 'generate', args: chat } });
assert.match(workerMessages.find(message => message.id === 4).error, /busy/);
await delay(55);
assert.equal(workerMessages.find(message => message.id === 3 && message.event === 'delta').delta, 'first');
workerHandler({ data: { method: 'interrupt', targetId: 3 } });
gate.resolve();
await tick();
const interruptedReply = workerMessages.find(message => message.id === 3 && message.result).result;
assert.equal(interruptedReply.text, 'first');
assert.equal(interruptedReply.interrupted, true);
assert.ok(engineInstance.interruptCount >= 1);
assert.ok(!workerMessages.some(message => message.id === 3 && message.delta?.includes('late')));
workerHandler({ data: { id: 5, method: 'generate', args: { messages: [{ role: 'tool', content: 'bad' }] } } });
await tick();
assert.match(workerMessages.find(message => message.id === 5).error, /text system/);
workerHandler({ data: { id: 6, method: 'executeR', args: { code: 'rm(list=ls())' } } });
await tick();
assert.match(workerMessages.find(message => message.id === 6).error, /Unknown/);

console.log('Assistant client and worker lifecycle checks passed.');
