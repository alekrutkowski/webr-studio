// This module is deliberately small. WebLLM and its model are imported only
// inside a dedicated worker after the user presses Load model.
export const WEBLLM_VERSION = '0.2.87';
export const WEBLLM_MODULE_URL = `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${WEBLLM_VERSION}/lib/index.js`;
export const ASSISTANT_MODELS = Object.freeze([
  Object.freeze({ id: 'Qwen2.5-Coder-0.5B-Instruct-q4f32_1-MLC', label: 'Qwen2.5 Coder 0.5B · lighter', vramMB: 1060.2 }),
  Object.freeze({ id: 'Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC', label: 'Qwen2.5 Coder 1.5B · more capable', vramMB: 1888.97 })
]);
export const DEFAULT_ASSISTANT_MODEL = ASSISTANT_MODELS[0].id;
export const ASSISTANT_CONTEXT_TOKENS = 2048;
export const ASSISTANT_MAX_INPUT_CHARS = 8000;
export const ASSISTANT_MAX_OUTPUT_CHARS = 16000;

export function assistantCapability(scope = globalThis) {
  if (!scope.isSecureContext) return { supported: false, reason: 'Local AI needs HTTPS or localhost.' };
  if (typeof scope.Worker !== 'function') return { supported: false, reason: 'This browser does not support dedicated workers.' };
  if (!scope.navigator?.gpu) return { supported: false, reason: 'WebGPU is unavailable. Use a browser and graphics driver with WebGPU enabled.' };
  return { supported: true, reason: '' };
}

export function validateAssistantModel(modelId) {
  if (!ASSISTANT_MODELS.some(model => model.id === modelId)) throw new Error('Select one of the supported local models.');
  return modelId;
}

// Validate at both ends of the worker boundary. Only plain chat messages are
// supported; model output can never request JavaScript or R execution here.
export function normalizeAssistantRequest(request = {}) {
  if (!Array.isArray(request.messages) || !request.messages.length || request.messages.length > 18) {
    throw new Error('Send between 1 and 18 chat messages. Clear chat to shorten the conversation.');
  }
  let total = 0;
  const messages = request.messages.map((message, index) => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role)
        || typeof message.content !== 'string' || (message.role === 'system' && index !== 0)) {
      throw new Error('Local AI accepts text system, user, and assistant messages only.');
    }
    total += message.content.length;
    if (total > ASSISTANT_MAX_INPUT_CHARS) throw new Error('The prompt is too large. Clear chat or include fewer objects.');
    return { role: message.role, content: message.content };
  });
  if (messages.at(-1).role !== 'user') throw new Error('The last chat message must be a user request.');
  const requestedTokens = Number(request.max_tokens ?? 256);
  const requestedTemperature = Number(request.temperature ?? 0.2);
  return {
    messages,
    max_tokens: Number.isFinite(requestedTokens) ? Math.max(1, Math.min(384, Math.floor(requestedTokens))) : 256,
    temperature: Number.isFinite(requestedTemperature) ? Math.max(0, Math.min(1.5, requestedTemperature)) : 0.2,
    top_p: 0.9
  };
}

export function assistantErrorMessage(error) {
  const message = String(error?.message || error || 'Local AI could not complete the request.');
  if (/context.window|context_window|prompt.{0,35}(?:too long|exceed)|(?:input|prompt).{0,20}tokens.{0,25}(?:exceed|maximum)/i.test(message)) {
    return 'The prompt exceeds this model\'s context window. Clear chat, shorten the request, or include fewer objects.';
  }
  return message.slice(0, 700);
}

function abortError(message = 'Local AI request cancelled.') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function detailEvent(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, 'detail', { value: detail });
  return event;
}

export class AssistantClient extends EventTarget {
  constructor({
    workerFactory = () => new Worker(new URL('./assistant-worker.js?v=1.6.0', import.meta.url), { type: 'module', name: 'webr-local-ai' }),
    capabilityCheck = assistantCapability,
    loadTimeoutMs = 10 * 60_000,
    generateTimeoutMs = 120_000,
    interruptTimeoutMs = 2500,
    idleTimeoutMs = 5 * 60_000
  } = {}) {
    super();
    this.workerFactory = workerFactory;
    this.capabilityCheck = capabilityCheck;
    this.loadTimeoutMs = loadTimeoutMs;
    this.generateTimeoutMs = generateTimeoutMs;
    this.interruptTimeoutMs = interruptTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.worker = null;
    this.state = 'unloaded';
    this.modelId = '';
    this.error = '';
    this.pending = new Map();
    this.sequence = 0;
    this.activeId = 0;
    this.idleTimer = 0;
    this.interruptTimer = 0;
    this.loadPromise = null;
    this.disposed = false;
  }

  setState(state, { error = '', reason = '' } = {}) {
    this.state = state;
    this.error = error;
    this.dispatchEvent(detailEvent('state', { state, modelId: this.modelId, error, reason }));
  }

  clearIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = 0;
  }

  scheduleIdleUnload() {
    this.clearIdleTimer();
    if (!(this.idleTimeoutMs > 0) || this.state !== 'ready') return;
    this.idleTimer = setTimeout(() => {
      if (this.state === 'ready') this.unload({ reason: 'idle' });
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  createWorker() {
    const worker = this.workerFactory();
    this.worker = worker;
    worker.addEventListener('message', event => {
      if (this.worker === worker) this.receive(event.data);
    });
    worker.addEventListener('error', event => {
      if (this.worker !== worker) return;
      event.preventDefault?.();
      this.fail(new Error(event.message || 'The local AI worker stopped. Load the model again to retry.'));
    });
    worker.addEventListener('messageerror', () => {
      if (this.worker === worker) this.fail(new Error('The local AI worker returned an unreadable message.'));
    });
    return worker;
  }

  request(method, args, { timeoutMs, onDelta = null } = {}) {
    const id = ++this.sequence;
    let record;
    const promise = new Promise((resolve, reject) => {
      record = { id, method, resolve, reject, onDelta, text: '', interrupted: false, cleanup: null, timer: 0 };
      this.pending.set(id, record);
      if (method === 'generate') this.activeId = id;
      if (timeoutMs > 0) record.timer = setTimeout(() => {
        if (this.pending.has(id)) this.fail(new Error(method === 'load'
          ? 'Model loading timed out. Check the connection and load the model again.'
          : 'Local AI timed out. The model was unloaded to keep the IDE responsive.'));
      }, timeoutMs);
      try { this.worker.postMessage({ id, method, args }); }
      catch (error) { this.fail(error); }
    });
    return { id, record, promise };
  }

  settle(record, error, result) {
    if (!this.pending.delete(record.id)) return;
    clearTimeout(record.timer);
    record.cleanup?.();
    if (this.activeId === record.id) {
      this.activeId = 0;
      clearTimeout(this.interruptTimer);
      this.interruptTimer = 0;
    }
    if (error) record.reject(error);
    else record.resolve(result);
  }

  receive(message) {
    if (!message || !Number.isSafeInteger(message.id)) return;
    const record = this.pending.get(message.id);
    if (!record) return;
    if (message.event === 'progress' && record.method === 'load') {
      this.dispatchEvent(detailEvent('progress', {
        progress: Math.max(0, Math.min(1, Number(message.progress) || 0)),
        text: String(message.text || '').slice(0, 500)
      }));
      return;
    }
    if (message.event === 'delta' && record.method === 'generate') {
      if (record.interrupted || typeof message.delta !== 'string') return;
      const delta = message.delta.slice(0, Math.max(0, ASSISTANT_MAX_OUTPUT_CHARS - record.text.length));
      record.text += delta;
      try { if (delta) record.onDelta?.(delta); }
      catch (error) { this.fail(error); }
      return;
    }
    if (message.event) return;
    if (message.error) {
      this.settle(record, new Error(assistantErrorMessage(message.error)));
    } else if (record.method === 'generate') {
      this.settle(record, null, {
        text: record.interrupted ? record.text : String(message.result?.text ?? record.text).slice(0, ASSISTANT_MAX_OUTPUT_CHARS),
        usage: message.result?.usage || null,
        interrupted: record.interrupted || Boolean(message.result?.interrupted)
      });
    } else this.settle(record, null, message.result);
  }

  terminate(error, { state = 'unloaded', reason = '', preserveInterrupted = false } = {}) {
    this.clearIdleTimer();
    clearTimeout(this.interruptTimer);
    this.interruptTimer = 0;
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    for (const record of [...this.pending.values()]) {
      if (preserveInterrupted && record.method === 'generate') {
        this.settle(record, null, { text: record.text, usage: null, interrupted: true });
      } else this.settle(record, error || abortError());
    }
    this.modelId = '';
    this.setState(state, { error: state === 'error' ? assistantErrorMessage(error) : '', reason });
  }

  fail(error) {
    this.terminate(new Error(assistantErrorMessage(error)), { state: 'error' });
  }

  async load(modelId = DEFAULT_ASSISTANT_MODEL) {
    if (this.disposed) throw new Error('This local AI client has been disposed.');
    validateAssistantModel(modelId);
    if (this.state === 'ready' && this.modelId === modelId) {
      this.scheduleIdleUnload();
      return { modelId };
    }
    if (this.state === 'loading' && this.modelId === modelId) return this.loadPromise;
    if (this.state === 'loading' || this.state === 'generating') throw new Error('Local AI is busy. Stop the current operation first.');
    const capability = this.capabilityCheck();
    if (!capability.supported) {
      this.setState('error', { error: capability.reason });
      throw new Error(capability.reason);
    }
    if (this.worker) this.terminate(abortError(), { reason: 'model-change' });
    let worker;
    try { worker = this.createWorker(); }
    catch (error) { this.fail(error); throw error; }
    this.modelId = modelId;
    this.setState('loading');
    const { promise } = this.request('load', { modelId }, { timeoutMs: this.loadTimeoutMs });
    this.loadPromise = promise.then(result => {
      if (this.worker === worker) {
        this.setState('ready');
        this.scheduleIdleUnload();
      }
      return result;
    }, error => {
      if (this.worker === worker) this.fail(error);
      throw error;
    }).finally(() => {
      if (this.worker === worker || !this.worker) this.loadPromise = null;
    });
    return this.loadPromise;
  }

  async generate(request, { onDelta = null, signal = null } = {}) {
    if (this.disposed) throw new Error('This local AI client has been disposed.');
    if (signal?.aborted) throw abortError();
    if (this.state !== 'ready' || !this.worker) throw new Error(this.state === 'generating'
      ? 'Local AI is already generating. Stop it before starting another request.'
      : 'Load a local model before asking for assistance.');
    const args = normalizeAssistantRequest(request);
    this.clearIdleTimer();
    const worker = this.worker;
    this.setState('generating');
    const { id, record, promise } = this.request('generate', args, { timeoutMs: this.generateTimeoutMs, onDelta });
    if (signal && this.pending.has(id)) {
      const abort = () => { if (this.pending.has(id)) this.interrupt(); };
      signal.addEventListener('abort', abort, { once: true });
      record.cleanup = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    }
    try {
      const result = await promise;
      if (this.worker === worker) {
        this.setState('ready');
        this.scheduleIdleUnload();
      }
      return result;
    } catch (error) {
      if (this.worker === worker) {
        this.setState('ready', { error: assistantErrorMessage(error) });
        this.scheduleIdleUnload();
      }
      throw error;
    }
  }

  interrupt() {
    if (this.state === 'loading') {
      this.terminate(abortError('Model loading cancelled.'), { reason: 'interrupted' });
      return true;
    }
    const record = this.pending.get(this.activeId);
    if (!record || record.interrupted) return false;
    record.interrupted = true;
    try { this.worker.postMessage({ method: 'interrupt', targetId: record.id }); }
    catch { this.terminate(null, { reason: 'interrupted', preserveInterrupted: true }); return true; }
    this.interruptTimer = setTimeout(() => {
      if (this.pending.has(record.id)) this.terminate(null, { reason: 'interrupted', preserveInterrupted: true });
    }, this.interruptTimeoutMs);
    return true;
  }

  // Terminating the dedicated worker cancels downloads as well as generation
  // and releases that worker's model/GPU context, even if initialization hung.
  async unload({ reason = 'user' } = {}) {
    this.terminate(abortError('Local model unloaded.'), { reason });
  }

  dispose() {
    this.disposed = true;
    this.terminate(abortError('Local AI client disposed.'), { reason: 'disposed' });
  }
}
