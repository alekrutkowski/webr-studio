import { AssistantClient, ASSISTANT_MODELS, DEFAULT_ASSISTANT_MODEL, assistantCapability } from './assistant-client.js?v=1.6.0';
import {
  boundedText, buildAssistantMessages, cachedObjectContext, captureTarget,
  executionContext, insertAtSnapshot, relevantObjectNames, replyParts,
  sourceContext, suggestionCode, targetMatches
} from './assistant-context.js?v=1.6.0';
import { copyText } from './utils.js?v=1.6.0';

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

export class AssistantPanel {
  constructor(app, { client = new AssistantClient(), capability = assistantCapability() } = {}) {
    this.app = app;
    this.client = client;
    this.capability = capability;
    this.root = document.getElementById('panel-assistant');
    this.elements = Object.fromEntries([
      'model', 'model-details', 'load', 'unload', 'status', 'progress',
      'objects', 'use-objects', 'values', 'functions', 'source', 'output',
      'refresh-context', 'context-preview', 'messages', 'form', 'prompt',
      'send', 'suggest', 'stop', 'clear'
    ].map(key => [key, document.getElementById(`assistant-${key}`)]));
    this.history = [];
    this.lastOutput = '';
    this.busy = false;
    this.epoch = 0;
    this.abort = null;
    this.disposed = false;
    this.domListeners = [];
    this.progressText = '';
    this.bind();
    this.refreshObjectChoices();
    this.updateState();
  }

  bind() {
    const e = this.elements;
    e.model.replaceChildren(...ASSISTANT_MODELS.map(model => {
      const option = node('option', '', `${model.label} (catalog GPU estimate ~${(model.vramMB / 1000).toFixed(1)} GB)`);
      option.value = model.id;
      return option;
    }));
    e.model.value = ASSISTANT_MODELS.some(model => model.id === this.app.settings.assistantModel)
      ? this.app.settings.assistantModel : DEFAULT_ASSISTANT_MODEL;
    this.listen(e.model, 'change', () => {
      this.app.settings.assistantModel = e.model.value;
      this.app.persistSettingsDebounced();
      this.updateState();
    });
    this.listen(e.load, 'click', () => this.load());
    this.listen(e.unload, 'click', () => this.unload());
    this.listen(e.form, 'submit', event => { event.preventDefault(); this.ask(); });
    this.listen(e.suggest, 'click', () => this.suggest(this.app.currentFocus));
    this.listen(e.stop, 'click', () => this.stop());
    this.listen(e.clear, 'click', () => this.clear());
    this.listen(e['refresh-context'], 'click', () => this.previewContext());
    this.listen(e.prompt, 'keydown', event => {
      if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); this.ask(); }
    });
    this.listen(e.objects, 'change', () => {
      const selected = [...e.objects.selectedOptions];
      selected.slice(6).forEach(option => { option.selected = false; });
      if (selected.length > 6) this.notice('Select at most six objects per request.');
    });
    this.stateListener = event => {
      if (event.detail.state === 'ready') e['model-details'].open = false;
      this.updateState(event.detail);
    };
    this.progressListener = event => {
      const progress = event.detail || {};
      this.progressText = boundedText(progress.text || 'Loading model…', 220);
      e.progress.value = Math.max(0, Math.min(1, Number(progress.progress) || 0));
      this.updateState();
    };
    this.client.addEventListener('state', this.stateListener);
    this.client.addEventListener('progress', this.progressListener);
    this.pagehideListener = event => event.persisted ? this.unload() : this.dispose();
    window.addEventListener('pagehide', this.pagehideListener);
  }

  listen(element, type, handler) {
    element.addEventListener(type, handler);
    this.domListeners.push([element, type, handler]);
  }

  runtimeBusy() {
    return Boolean(this.app.engine.running || this.app.fileMutationPending || this.app.console?.inputRequest);
  }

  updateState(detail = {}) {
    if (this.disposed) return;
    const e = this.elements;
    const state = this.client.state;
    const loading = state === 'loading';
    const generating = state === 'generating';
    const blocked = this.runtimeBusy();
    e.load.disabled = !this.capability.supported || loading || generating || this.busy || blocked
      || (state === 'ready' && this.client.modelId === e.model.value);
    e.load.textContent = state === 'ready' ? 'Load selected model' : 'Load model';
    e.unload.disabled = state === 'unloaded' && !this.busy;
    e.model.disabled = loading || generating || this.busy;
    e.send.disabled = state !== 'ready' || this.busy || blocked;
    e.suggest.disabled = e.send.disabled;
    e.stop.disabled = !loading && !generating && !this.busy;
    e['refresh-context'].disabled = this.busy || blocked;
    e.progress.hidden = !loading;
    this.root.setAttribute('aria-busy', String(this.busy || loading));
    let status = 'No model loaded. R editing and ordinary completion remain available.';
    if (!this.capability.supported) status = `${this.capability.reason} R remains available.`;
    else if (state === 'error') status = this.client.error || 'The model could not load. Try again.';
    else if (loading) status = this.progressText || 'Loading model assets… You can continue editing.';
    else if (generating) status = 'Generating locally… Stop cancels the response.';
    else if (this.busy) status = 'Preparing bounded R context…';
    else if (state === 'ready') status = blocked ? 'R is working. Local AI will wait until R is idle.' : 'Model ready on this device. Ask a question or request a suggestion.';
    if (detail.reason === 'idle') status = 'Model unloaded after five idle minutes. Load again to use cached weights.';
    e.status.textContent = status;
    e.status.dataset.state = state;
  }

  notice(message, error = false) {
    this.elements.status.textContent = boundedText(message, 700);
    this.elements.status.dataset.state = error ? 'error' : this.client.state;
  }

  async load() {
    if (this.runtimeBusy() || this.busy) return;
    this.progressText = '';
    try { await this.client.load(this.elements.model.value); }
    catch (error) { if (error.name !== 'AbortError') this.notice(error.message, true); }
  }

  unload() {
    this.stop();
    this.client.unload();
    this.updateState();
  }

  stop(message = '') {
    this.epoch += 1;
    this.abort?.abort();
    this.abort = null;
    this.busy = false;
    this.client.interrupt();
    this.updateState();
    if (message) this.notice(message);
  }

  onRuntimeState(detail) {
    if (detail.state === 'running' && (this.busy || this.client.state === 'generating')) {
      this.stop('Local generation stopped so R can run. Ask again when R is idle.');
    }
    if (['restarting', 'stopped', 'error'].includes(detail.state)) {
      this.stop();
      this.lastOutput = '';
      this.elements['context-preview'].textContent = 'R session changed. Context will be collected again on the next request.';
    }
    this.updateState();
  }

  recordExecution(result) {
    this.lastOutput = executionContext(result);
  }

  refreshObjectChoices() {
    const e = this.elements;
    const selected = new Set([...e.objects.selectedOptions].map(option => option.value));
    const objects = this.app.environment || [];
    // Keep selected objects accessible even in large sessions; never render an unbounded list.
    const chosen = [];
    const others = [];
    for (const item of objects) {
      if (selected.has(item.name)) chosen.push(item);
      else if (others.length < 100) others.push(item);
      if (others.length >= 100 && chosen.length >= selected.size) break;
    }
    const visible = [...chosen, ...others].slice(0, 100);
    e.objects.replaceChildren(...visible.map(item => {
      const option = node('option', '', `${boundedText(item.name, 100)} (${boundedText(item.className || item.type, 70)})`);
      option.value = item.name;
      option.selected = selected.has(item.name);
      return option;
    }));
  }

  async collectContext(question = '', snapshot = null) {
    const e = this.elements;
    if (!e['use-objects'].checked) return 'R object context is disabled.';
    const objects = this.app.environment || [];
    const selected = [...e.objects.selectedOptions].map(option => option.value);
    const names = relevantObjectNames(objects, `${question}\n${e.source.checked ? sourceContext(snapshot, 1100) : ''}`, selected);
    let text = cachedObjectContext(objects, names);
    if (names.length && this.app.engine.ready && !this.runtimeBusy()) {
      const context = await this.app.engine.getAssistantContext({
        names, includeValues: e.values.checked, includeFunctionBodies: e.functions.checked,
        maxObjects: 6, maxColumns: 8, maxRows: 3, maxChars: 3200
      });
      text = context.text;
    } else if (names.length) text += '\nDetailed R inspection is unavailable while R is busy or offline.';
    return boundedText(text, 3200);
  }

  async previewContext() {
    if (this.busy || this.runtimeBusy()) return;
    const token = ++this.epoch;
    this.busy = true;
    this.updateState();
    let failure = '';
    try {
      let snapshot = null;
      try { snapshot = captureTarget(this.app, this.app.currentFocus); } catch { /* Code context is optional. */ }
      const context = await this.collectContext(this.elements.prompt.value, snapshot);
      if (token !== this.epoch) return;
      const messages = this.makeMessages(this.elements.prompt.value || '(your next question)', context, snapshot);
      this.elements['context-preview'].textContent = messages.map(item => `${item.role.toUpperCase()}:\n${item.content}`).join('\n\n');
    } catch (error) { if (token === this.epoch && !this.disposed) failure = error.message; }
    finally { if (token === this.epoch && !this.disposed) { this.busy = false; this.updateState(); if (failure) this.notice(failure, true); } }
  }

  makeMessages(question, context, snapshot, suggestion = false) {
    return buildAssistantMessages({ question, context,
      source: this.elements.source.checked ? sourceContext(snapshot) : '',
      output: this.elements.output.checked ? this.lastOutput : '',
      history: suggestion ? [] : this.history, suggestion });
  }

  async suggest(target = 'editor') {
    if (!['editor', 'console'].includes(target)) target = 'editor';
    return this.ask({ suggestion: true, target });
  }

  async ask({ suggestion = false, target = this.app.currentFocus } = {}) {
    if (this.busy || this.client.state === 'generating') return;
    if (this.client.state !== 'ready') {
      this.elements['model-details'].open = true;
      this.notice(this.capability.supported ? 'Choose a model and click Load model first. Nothing downloads until you choose Load.' : this.capability.reason);
      return;
    }
    if (this.runtimeBusy()) { this.notice('Wait for R to finish before asking the local assistant.'); return; }
    if (suggestion && !this.elements.source.checked) {
      this.notice('Enable nearby code context under R context and privacy to request a suggestion at the cursor.');
      return;
    }
    const question = suggestion
      ? 'Suggest a short R continuation at the cursor, or a replacement for the selected text. Return only the code to insert.'
      : this.elements.prompt.value.trim();
    if (!question) { this.elements.prompt.focus(); return; }
    const token = ++this.epoch;
    this.busy = true;
    const abort = new AbortController();
    this.abort = abort;
    this.updateState();
    let responseNode;
    let responseText = '';
    let snapshot = null;
    let failed = false;
    try {
      try { snapshot = captureTarget(this.app, target); }
      catch (error) { if (suggestion) throw error; }
      if (suggestion && snapshot.target === 'editor' && !/\.(r|rmd)$/i.test(snapshot.path)) throw new Error('Code suggestions are available in R and R Markdown files.');
      const context = await this.collectContext(question, snapshot);
      if (abort.signal.aborted || token !== this.epoch) return;
      const messages = this.makeMessages(question, context, snapshot, suggestion);
      this.elements['context-preview'].textContent = messages.map(item => `${item.role.toUpperCase()}:\n${item.content}`).join('\n\n');
      this.appendMessage('user', suggestion ? `Suggest code in ${snapshot.path}` : question);
      responseNode = this.appendMessage('assistant', '');
      const streaming = node('div', 'assistant-message-text', 'Thinking…');
      responseNode.append(streaming);
      if (!suggestion) this.elements.prompt.value = '';
      const result = await this.client.generate({ messages, max_tokens: suggestion ? 128 : 256, temperature: suggestion ? 0.1 : 0.2 }, {
        signal: abort.signal,
        onDelta: delta => {
          if (token !== this.epoch || abort.signal.aborted) return;
          responseText += delta;
          streaming.textContent = responseText;
          this.scrollToLatest();
        }
      });
      if (abort.signal.aborted || token !== this.epoch || result.interrupted) {
        streaming.textContent = responseText ? `${responseText}\n\n[Stopped; partial response]` : 'Stopped.';
        return;
      }
      responseText = result.text;
      responseNode.replaceChildren(node('strong', 'assistant-role', 'Assistant'));
      if (suggestion) this.renderSuggestion(responseNode, responseText, snapshot);
      else {
        this.renderReply(responseNode, responseText, snapshot);
        this.history.push({ role: 'user', content: question }, { role: 'assistant', content: boundedText(responseText, 3000) });
        this.history = this.history.slice(-8);
      }
      this.scrollToLatest();
    } catch (error) {
      if (token !== this.epoch || abort.signal.aborted || this.disposed) return;
      if (responseNode) responseNode.append(node('p', 'assistant-note', error.name === 'AbortError' ? 'Stopped.' : `Could not complete: ${error.message}`));
      if (error.name !== 'AbortError') { failed = true; this.notice(error.message, true); }
    } finally {
      if (token === this.epoch) {
        this.busy = false;
        this.abort = null;
        if (!failed) this.updateState();
        else {
          const message = this.elements.status.textContent;
          this.updateState();
          this.notice(message, true);
        }
      }
    }
  }

  appendMessage(role, text) {
    const messages = this.elements.messages;
    messages.querySelector('.assistant-empty')?.remove();
    const article = node('article', `assistant-message assistant-${role}`);
    article.append(node('strong', 'assistant-role', role === 'user' ? 'You' : 'Assistant'));
    if (text) article.append(node('div', 'assistant-message-text', text));
    messages.append(article);
    while (messages.children.length > 16) messages.firstElementChild.remove();
    return article;
  }

  scrollToLatest() {
    // Scrolling one lightweight text node avoids Markdown/highlighting work per token.
    const scroll = this.root.querySelector('.assistant-scroll');
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 180) scroll.scrollTop = scroll.scrollHeight;
  }

  action(label, handler) {
    const button = node('button', 'button secondary compact', label);
    button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await handler(button); }
      catch (error) { this.notice(error.message, true); }
      finally { if (button.isConnected && !button.dataset.used) button.disabled = false; }
    });
    return button;
  }

  renderSuggestion(container, text, snapshot) {
    const code = suggestionCode(text);
    if (!code) { container.append(node('div', 'assistant-message-text', text), node('p', 'assistant-note', 'No complete single suggestion was returned. Try again.')); return; }
    container.append(node('pre', 'assistant-code', code));
    const actions = node('div', 'assistant-actions');
    const insert = this.action(snapshot.start !== snapshot.end ? 'Replace selection' : 'Insert suggestion', button => {
      insertAtSnapshot(this.app, snapshot, code);
      button.dataset.used = 'true';
      button.textContent = 'Inserted';
    });
    if (!targetMatches(this.app, snapshot)) {
      insert.disabled = true;
      insert.dataset.used = 'true';
      container.append(node('p', 'assistant-note', 'The document or cursor changed during generation. Request a fresh suggestion to insert.'));
    }
    actions.append(insert, this.action('Copy', () => copyText(code)));
    container.append(actions);
  }

  renderReply(container, text, snapshot) {
    for (const part of replyParts(text)) {
      if (part.type === 'text') { container.append(node('div', 'assistant-message-text', part.text)); continue; }
      container.append(node('pre', 'assistant-code', part.text));
      const actions = node('div', 'assistant-actions');
      actions.append(this.action('Copy', () => copyText(part.text)));
      if (part.type === 'r') {
        if (snapshot?.target === 'editor') actions.append(this.action('Insert in editor', button => {
          insertAtSnapshot(this.app, snapshot, part.text);
          button.dataset.used = 'true';
          button.textContent = 'Inserted';
        }));
        actions.append(this.action('Add to console', () => this.addToConsole(part.text)));
        actions.append(this.action('Run in R', () => this.runCode(part.text)));
      }
      container.append(actions);
    }
  }

  addToConsole(code) {
    if (this.runtimeBusy()) throw new Error('Wait until R is idle before adding code to the console.');
    const manager = this.app.console;
    const draft = manager.getValue();
    manager.setValue(draft ? `${draft.trimEnd()}\n${code}` : code);
    manager.persistDraft?.();
    manager.focus();
    this.notice('Code added to the console draft. Press Enter in the console when ready to run it.');
  }

  async runCode(code) {
    if (this.runtimeBusy() || !this.app.engine.ready) throw new Error('R must be ready and idle before running proposed code.');
    const token = this.epoch;
    // This method is reachable only from a button beside a complete visible R code block.
    const result = await this.app.executeCode(code, { echo: true });
    if (!result || token !== this.epoch || this.disposed) return;
    this.recordExecution(result);
    this.elements.output.checked = true;
    const message = this.appendMessage('assistant', 'R execution result');
    message.append(node('pre', 'assistant-code', this.lastOutput));
    message.append(node('p', 'assistant-note', 'This bounded result is included in your next question. Full output is in the R console.'));
  }

  clear() {
    this.stop();
    this.history = [];
    this.lastOutput = '';
    this.elements.output.checked = false;
    this.elements.messages.replaceChildren(node('p', 'assistant-empty', 'Conversation cleared. Ask about your R objects or request a code suggestion.'));
    this.elements['context-preview'].textContent = 'No request yet.';
    this.updateState();
  }

  dispose() {
    if (this.disposed) return;
    this.stop();
    this.client.dispose();
    this.client.removeEventListener('state', this.stateListener);
    this.client.removeEventListener('progress', this.progressListener);
    window.removeEventListener('pagehide', this.pagehideListener);
    this.domListeners.forEach(([element, type, handler]) => element.removeEventListener(type, handler));
    this.domListeners = [];
    this.elements.messages.replaceChildren();
    this.disposed = true;
  }
}
