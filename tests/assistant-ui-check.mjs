import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AssistantPanel } from '../js/assistant.js';
import { DEFAULT_ASSISTANT_MODEL } from '../js/assistant-client.js';

// A small DOM surface for controller-level UI regression checks. It implements
// only ordinary DOM operations used by AssistantPanel; inference and the R
// runtime are explicit fakes. No browser or new application dependency is needed.
class Element extends EventTarget {
  constructor(tag, document) {
    super();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.className = '';
    this._text = '';
    this.value = '';
    this.checked = false;
    this.selected = false;
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.scrollHeight = 100;
    this.scrollTop = 0;
    this.clientHeight = 100;
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get firstElementChild() { return this.children[0] || null; }
  get selectedOptions() { return this.children.filter(child => child.selected); }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
  append(...nodes) {
    for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); }
  }
  replaceChildren(...nodes) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  querySelectorAll(selector) {
    const matches = child => selector.startsWith('.') ? child.className.split(/\s+/).includes(selector.slice(1))
      : child.tagName.toLowerCase() === selector.toLowerCase();
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  setRangeText(text, start, end) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.selectionStart = this.selectionEnd = start + text.length;
  }
}

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const panelMarkup = html.match(/<section id="panel-assistant"[\s\S]*?<\/section>/)?.[0];
assert.ok(panelMarkup, 'The Assistant pane must be present in deployed HTML.');

function createDOM() {
  const elements = new Map();
  const document = {
    createElement(tag) { return new Element(tag, document); },
    getElementById(id) { return elements.get(id) || null; }
  };
  document.body = document.createElement('body');
  const root = document.createElement('section');
  root.id = 'panel-assistant';
  elements.set(root.id, root);
  document.body.append(root);
  const scroll = document.createElement('div');
  scroll.className = 'assistant-scroll';
  root.append(scroll);
  for (const match of panelMarkup.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="(assistant-[^"]+)"[^>]*)>/g)) {
    const [, tag, attrs, id] = match;
    const element = document.createElement(tag);
    element.id = id;
    element.checked = /\bchecked\b/.test(attrs);
    element.disabled = /\bdisabled\b/.test(attrs);
    element.hidden = /\bhidden\b/.test(attrs);
    element.open = /\bopen\b/.test(attrs);
    elements.set(id, element);
    scroll.append(element);
  }
  const window = new EventTarget();
  Object.assign(window, { setTimeout, clearTimeout });
  return { document, window, elements };
}

function detailEvent(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, 'detail', { value: detail });
  return event;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

class FakeClient extends EventTarget {
  constructor() {
    super();
    this.state = 'unloaded';
    this.modelId = '';
    this.error = '';
    this.loads = [];
    this.requests = [];
    this.interruptions = 0;
    this.disposed = false;
  }
  setState(state) {
    this.state = state;
    this.dispatchEvent(detailEvent('state', { state, modelId: this.modelId, error: this.error }));
  }
  async load(model) { this.loads.push(model); this.modelId = model; this.setState('ready'); }
  generate(args, callbacks) {
    const pending = deferred();
    const request = { args, callbacks, pending };
    this.requests.push(request);
    this.setState('generating');
    return pending.promise.finally(() => { if (!this.disposed) this.setState('ready'); });
  }
  delta(text) { this.requests.at(-1).callbacks.onDelta(text); }
  finish(text, extra = {}) { this.requests.at(-1).pending.resolve({ text, usage: null, interrupted: false, ...extra }); }
  interrupt() { this.interruptions += 1; }
  async unload() { this.modelId = ''; this.setState('unloaded'); }
  dispose() { this.disposed = true; this.modelId = ''; this.setState('unloaded'); }
}

function manager(document, initial = '') {
  const fallback = document.createElement('textarea');
  fallback.value = initial;
  fallback.selectionStart = fallback.selectionEnd = initial.length;
  return {
    fallback, fallbackMode: true, busy: false, runtimeBusy: false, inputRequest: null,
    getValue() { return fallback.value; },
    setValue(value) { fallback.value = value; fallback.selectionStart = fallback.selectionEnd = value.length; },
    insertText(value) { fallback.setRangeText(value, fallback.selectionStart, fallback.selectionEnd, 'end'); },
    focus() { fallback.focus(); },
    persistDraft() {}
  };
}

function fixture() {
  const dom = createDOM();
  globalThis.document = dom.document;
  globalThis.window = dom.window;
  const client = new FakeClient();
  const contextCalls = [];
  const executions = [];
  const app = {
    settings: {}, persistSettingsDebounced() {}, currentFocus: 'editor', activePath: 'analysis.R',
    environment: [
      { name: 'df', className: 'data.frame', type: 'list', dimensions: '1000000 x 2', preview: 'SECRET_VALUE_123' },
      { name: 'f', className: 'function', type: 'closure', dimensions: '', preview: 'SECRET_FUNCTION_BODY' }
    ],
    fileMutationPending: false, projectRuntimeRevision: 0,
    engine: {
      ready: true, running: false, generation: 0,
      async getAssistantContext(options) {
        contextCalls.push(options);
        return { text: 'df: data.frame (1000000 x 2)\nColumns: value numeric, group character' };
      }
    },
    editor: manager(dom.document, 'df[, mean(value)]'),
    console: manager(dom.document, ''),
    async executeCode(code, options) {
      executions.push({ code, options });
      return { ok: true, outputs: [{ type: 'stdout', text: '[1] 3' }], plots: [] };
    }
  };
  const panel = new AssistantPanel(app, { client, capability: { supported: true, reason: '' } });
  return { ...dom, client, contextCalls, executions, app, panel, e: panel.elements };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
async function ask(test, question = 'Explain df') {
  test.e.prompt.value = question;
  const result = test.panel.ask();
  await tick();
  return { result };
}
const buttons = test => test.e.messages.querySelectorAll('button');
const button = (test, label) => buttons(test).find(item => item.textContent === label);
const savedGlobals = new Map(['document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

try {
  const lazy = fixture();
  assert.equal(lazy.client.loads.length, 0);
  assert.equal(lazy.client.requests.length, 0);
  assert.equal(lazy.contextCalls.length, 0);
  assert.equal(lazy.e.values.checked, false, 'Raw samples must be opt-in in the actual HTML.');
  assert.equal(lazy.e.functions.checked, false, 'Function bodies must be opt-in in the actual HTML.');
  assert.equal(lazy.e.output.checked, false, 'Console output must be opt-in in the actual HTML.');
  assert.equal(lazy.e['use-objects'].checked, true);
  assert.equal(lazy.e.source.checked, true);
  lazy.e.prompt.value = 'Explain df';
  lazy.e.prompt.dispatchEvent(Object.assign(new Event('keydown'), { key: 'x', ctrlKey: false }));
  assert.equal(lazy.client.requests.length, 0, 'Ordinary typing must not invoke inference.');
  await lazy.panel.ask();
  assert.equal(lazy.client.loads.length, 0, 'Asking must not implicitly download a model.');
  assert.match(lazy.e.status.textContent, /Load model first/);
  lazy.e.load.click();
  await tick();
  assert.deepEqual(lazy.client.loads, [DEFAULT_ASSISTANT_MODEL]);
  assert.equal(lazy.e.load.disabled, true);

  const first = await ask(lazy);
  assert.equal(lazy.contextCalls.length, 1);
  assert.deepEqual(lazy.contextCalls[0].names, ['df']);
  assert.equal(lazy.contextCalls[0].includeValues, false);
  assert.equal(lazy.contextCalls[0].includeFunctionBodies, false);
  assert.equal(lazy.contextCalls[0].maxRows, 3);
  assert.equal(lazy.contextCalls[0].maxObjects, 6);
  assert.ok(!JSON.stringify(lazy.client.requests[0].args).includes('SECRET'));
  lazy.client.delta('Use the mean.');
  assert.match(lazy.e.messages.textContent, /Use the mean/);
  lazy.client.finish('Use:\n```r\nmean(df$value)\n```');
  await first.result;
  assert.equal(lazy.executions.length, 0, 'Displaying a code block must never execute it.');
  assert.ok(button(lazy, 'Run in R'));
  assert.equal(lazy.panel.history.length, 2);
  button(lazy, 'Add to console').click();
  await tick();
  assert.equal(lazy.app.console.getValue(), 'mean(df$value)');
  assert.equal(lazy.executions.length, 0, 'Adding a console draft must never submit it.');
  button(lazy, 'Run in R').click();
  await tick();
  assert.deepEqual(lazy.executions, [{ code: 'mean(df$value)', options: { echo: true } }]);
  assert.match(lazy.e.messages.textContent, /R execution result/);
  assert.equal(lazy.e.output.checked, true);

  const beforeBusy = lazy.client.requests.length;
  const beforeContext = lazy.contextCalls.length;
  lazy.app.engine.running = true;
  lazy.panel.updateState();
  assert.equal(lazy.e.send.disabled, true);
  await lazy.panel.ask();
  assert.equal(lazy.client.requests.length, beforeBusy);
  assert.equal(lazy.contextCalls.length, beforeContext);
  lazy.app.engine.running = false;
  lazy.app.console.inputRequest = { prompt: 'Password: ' };
  await lazy.panel.suggest('console');
  assert.equal(lazy.client.requests.length, beforeBusy, 'Interactive R input must not become model source.');
  lazy.app.console.inputRequest = null;
  lazy.app.fileMutationPending = true;
  await lazy.panel.previewContext();
  assert.equal(lazy.contextCalls.length, beforeContext);
  lazy.app.fileMutationPending = false;
  lazy.panel.clear();
  assert.equal(lazy.e.output.checked, false, 'Clearing the chat must reset automatic result inclusion.');

  lazy.e.values.checked = true;
  lazy.e.functions.checked = true;
  lazy.e.prompt.value = 'Explain df';
  await lazy.panel.previewContext();
  assert.equal(lazy.contextCalls.at(-1).includeValues, true);
  assert.equal(lazy.contextCalls.at(-1).includeFunctionBodies, true);
  const afterOptInContext = lazy.contextCalls.length;

  lazy.e.source.checked = false;
  lazy.e.prompt.value = 'What objects exist?';
  await lazy.panel.previewContext();
  assert.equal(lazy.contextCalls.length, afterOptInContext, 'A cached inventory needs no R evaluation.');
  assert.match(lazy.e['context-preview'].textContent, /Cached R object inventory/);
  assert.ok(!lazy.e['context-preview'].textContent.includes('SECRET'));
  lazy.e['use-objects'].checked = false;
  lazy.e.prompt.value = 'Explain df';
  await lazy.panel.previewContext();
  assert.equal(lazy.contextCalls.length, afterOptInContext);
  assert.match(lazy.e['context-preview'].textContent, /object context is disabled/);
  assert.ok(!lazy.e['context-preview'].textContent.includes('mean(value)'), 'Source opt-out must exclude nearby code.');
  const requestsBeforeOptOut = lazy.client.requests.length;
  await lazy.panel.suggest('editor');
  assert.equal(lazy.client.requests.length, requestsBeforeOptOut, 'Suggestions must not silently override source opt-out.');
  assert.match(lazy.e.status.textContent, /Enable nearby code context/);
  lazy.panel.dispose();

  const preparing = fixture();
  await preparing.panel.load();
  const context = deferred();
  preparing.app.engine.getAssistantContext = () => context.promise;
  preparing.e.prompt.value = 'Explain df';
  const preparingRequest = preparing.panel.ask();
  assert.equal(preparing.panel.busy, true);
  preparing.panel.stop();
  assert.equal(preparing.panel.busy, false);
  context.resolve({ text: 'df metadata' });
  await preparingRequest;
  assert.equal(preparing.client.requests.length, 0, 'Stopping during context collection must prevent inference.');
  assert.equal(preparing.e.messages.children.length, 0);
  preparing.panel.dispose();

  const streaming = fixture();
  await streaming.panel.load();
  const partial = await ask(streaming);
  streaming.client.delta('Visible partial');
  streaming.panel.stop();
  streaming.client.delta(' STALE');
  streaming.client.finish('```r\nunlink("important")\n```', { interrupted: true });
  await partial.result;
  assert.match(streaming.e.messages.textContent, /Visible partial/);
  assert.ok(!streaming.e.messages.textContent.includes('STALE'));
  assert.equal(buttons(streaming).length, 0, 'A stopped response must not acquire executable actions.');
  assert.equal(streaming.panel.history.length, 0);

  const cleared = await ask(streaming);
  streaming.client.delta('Old answer');
  streaming.panel.clear();
  streaming.client.delta('Late answer');
  streaming.client.finish('```r\nprint("late")\n```');
  await cleared.result;
  assert.match(streaming.e.messages.textContent, /^Conversation cleared/);
  assert.equal(streaming.e.messages.children.length, 1);
  assert.equal(streaming.panel.history.length, 0);
  assert.equal(buttons(streaming).length, 0);
  const preempted = await ask(streaming);
  streaming.client.delta('Before R starts');
  streaming.app.engine.running = true;
  const interruptsBeforeR = streaming.client.interruptions;
  streaming.panel.onRuntimeState({ state: 'running', operation: 'execute' });
  assert.ok(streaming.client.interruptions > interruptsBeforeR, 'R execution must stop pending local generation.');
  assert.equal(streaming.panel.busy, false);
  streaming.client.finish('```r\nold_result <- 1\n```', { interrupted: true });
  await preempted.result;
  assert.equal(buttons(streaming).length, 0);
  assert.equal(streaming.panel.history.length, 0);
  assert.equal(streaming.e.send.disabled, true);
  streaming.app.engine.running = false;
  streaming.panel.dispose();

  // A context failure belonging to an old epoch must not replace current UI.
  const staleContext = fixture();
  await staleContext.panel.load();
  const oldContext = deferred();
  staleContext.app.engine.getAssistantContext = () => oldContext.promise;
  staleContext.e.prompt.value = 'Explain df';
  const oldAsk = staleContext.panel.ask();
  staleContext.panel.clear();
  const afterClearStatus = staleContext.e.status.textContent;
  oldContext.reject(new Error('OLD_CONTEXT_ERROR'));
  await oldAsk;
  assert.equal(staleContext.e.status.textContent, afterClearStatus, 'An old context error must not overwrite Clear.');
  assert.equal(staleContext.e.messages.children.length, 1);
  const oldPreview = deferred();
  staleContext.app.engine.getAssistantContext = () => oldPreview.promise;
  const preview = staleContext.panel.previewContext();
  staleContext.panel.clear();
  const afterPreviewClear = staleContext.e.status.textContent;
  oldPreview.reject(new Error('OLD_PREVIEW_ERROR'));
  await preview;
  assert.equal(staleContext.e.status.textContent, afterPreviewClear, 'An old preview error must not overwrite Clear.');
  staleContext.panel.dispose();

  const edits = fixture();
  await edits.panel.load();
  const staleSuggestion = edits.panel.suggest('editor');
  await tick();
  edits.app.editor.setValue('new_document <- 1');
  edits.client.finish('```r\n+ 1\n```');
  await staleSuggestion;
  assert.equal(button(edits, 'Insert suggestion').disabled, true);
  assert.match(edits.e.messages.textContent, /document or cursor changed/);
  assert.equal(edits.app.editor.getValue(), 'new_document <- 1');
  edits.panel.clear();
  const movedCursor = edits.panel.suggest('editor');
  await tick();
  edits.client.finish('```r\n + 2\n```');
  await movedCursor;
  edits.app.editor.fallback.selectionStart = edits.app.editor.fallback.selectionEnd = 0;
  button(edits, 'Insert suggestion').click();
  await tick();
  assert.equal(edits.app.editor.getValue(), 'new_document <- 1');
  assert.match(edits.e.status.textContent, /document.*cursor.*changed/);
  edits.panel.clear();
  const freshSuggestion = edits.panel.suggest('editor');
  await tick();
  edits.client.finish('```r\n# note\n```');
  await freshSuggestion;
  button(edits, 'Insert suggestion').click();
  await tick();
  assert.equal(edits.app.editor.getValue(), '# notenew_document <- 1');
  assert.equal(button(edits, 'Inserted').disabled, true);
  assert.equal(edits.executions.length, 0, 'Inserting a suggestion must not run it.');
  edits.panel.clear();
  const changedSession = edits.panel.suggest('editor');
  await tick();
  edits.app.engine.generation += 1;
  edits.client.finish('```r\n# old session\n```');
  await changedSession;
  assert.equal(button(edits, 'Insert suggestion').disabled, true, 'A suggestion from a restarted R session must be stale.');
  edits.panel.clear();
  const changedRuntime = edits.panel.suggest('editor');
  await tick();
  edits.app.projectRuntimeRevision += 1;
  edits.client.finish('```r\n# old data\n```');
  await changedRuntime;
  assert.equal(button(edits, 'Insert suggestion').disabled, true, 'A suggestion from a changed runtime revision must be stale.');
  edits.panel.dispose();

  const execution = fixture();
  await execution.panel.load();
  const code = await ask(execution);
  execution.client.finish('```r\n1 + 2\n```');
  await code.result;
  const running = deferred();
  execution.app.executeCode = () => running.promise;
  button(execution, 'Run in R').click();
  await tick();
  execution.panel.clear();
  running.resolve({ ok: true, outputs: [{ type: 'stdout', text: '[1] 3' }] });
  await tick();
  assert.match(execution.e.messages.textContent, /^Conversation cleared/);
  assert.equal(execution.e.messages.children.length, 1, 'A completed R command must not repopulate a cleared chat.');
  assert.equal(execution.panel.lastOutput, '');
  execution.panel.dispose();

  const cachedPage = fixture();
  await cachedPage.panel.load();
  const pagehide = Object.assign(new Event('pagehide'), { persisted: true });
  cachedPage.window.dispatchEvent(pagehide);
  assert.equal(cachedPage.panel.disposed, false, 'A cached page should retain usable UI listeners.');
  assert.equal(cachedPage.client.state, 'unloaded', 'A cached page should release its model.');
  cachedPage.e.load.click();
  await tick();
  assert.equal(cachedPage.client.loads.length, 2, 'The restored pane should load exactly once per click.');
  cachedPage.window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
  assert.equal(cachedPage.panel.disposed, true);
  const loadsAtDisposal = cachedPage.client.loads.length;
  cachedPage.e.load.click();
  await tick();
  assert.equal(cachedPage.client.loads.length, loadsAtDisposal, 'Disposed DOM listeners must not invoke an old client.');
  const restoredClient = new FakeClient();
  const restoredPanel = new AssistantPanel(cachedPage.app, { client: restoredClient, capability: { supported: true, reason: '' } });
  restoredPanel.elements.load.click();
  await tick();
  assert.equal(restoredClient.loads.length, 1);
  assert.equal(cachedPage.client.loads.length, loadsAtDisposal);
  restoredPanel.dispose();
} finally {
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}

console.log('Assistant UI checks passed: lazy loading, bounded context, explicit execution, cancellation, and stale edit guards.');
