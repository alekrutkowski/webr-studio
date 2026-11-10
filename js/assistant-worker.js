import {
  ASSISTANT_CONTEXT_TOKENS, ASSISTANT_MAX_OUTPUT_CHARS, WEBLLM_MODULE_URL,
  assistantErrorMessage, normalizeAssistantRequest, validateAssistantModel
} from './assistant-client.js?v=1.6.0';

let engine = null;
let modelId = '';
let busy = false;
let active = null;

function reply(id, result) { self.postMessage({ id, result }); }

async function load(id, requestedModel) {
  validateAssistantModel(requestedModel);
  if (engine) throw new Error('This worker already has a model. Unload it before loading another.');
  if (!self.isSecureContext || !self.navigator?.gpu) {
    throw new Error('WebGPU is unavailable in the local AI worker. Use HTTPS or localhost with a WebGPU-capable browser.');
  }
  // Keep all parsing, model downloads, shader compilation, and inference away
  // from the IDE's UI thread. This import is never reached before explicit Load.
  const { MLCEngine } = await import(WEBLLM_MODULE_URL);
  engine = new MLCEngine({
    logLevel: 'WARN',
    initProgressCallback: progress => self.postMessage({
      id, event: 'progress', progress: progress.progress, text: progress.text
    })
  });
  await engine.reload(requestedModel, {
    context_window_size: ASSISTANT_CONTEXT_TOKENS
  });
  modelId = requestedModel;
  reply(id, { modelId });
}

async function generate(id, request) {
  if (!engine || !modelId) throw new Error('Load a local model before asking for assistance.');
  const args = normalizeAssistantRequest(request);
  const operation = { id, cancelled: false };
  active = operation;
  let text = '';
  let usage = null;
  let buffered = '';
  let flushTimer = 0;
  const flush = () => {
    clearTimeout(flushTimer);
    flushTimer = 0;
    if (buffered && !operation.cancelled) self.postMessage({ id, event: 'delta', delta: buffered });
    buffered = '';
  };
  try {
    // A request carries its full, bounded history. Keeping no implicit context
    // prevents a previous suggestion or a cleared conversation from leaking in.
    await engine.resetChat();
    if (!operation.cancelled) {
      const chunks = await engine.chat.completions.create({
        ...args, stream: true, stream_options: { include_usage: true }
      });
      if (!operation.cancelled) {
        for await (const chunk of chunks) {
          if (operation.cancelled) { await engine.interruptGenerate(); break; }
          if (chunk.usage) usage = chunk.usage;
          const incoming = chunk.choices?.[0]?.delta?.content || '';
          const delta = String(incoming).slice(0, Math.max(0, ASSISTANT_MAX_OUTPUT_CHARS - text.length));
          text += delta;
          buffered += delta;
          if (buffered && !flushTimer) flushTimer = setTimeout(flush, 40);
          if (text.length >= ASSISTANT_MAX_OUTPUT_CHARS) { await engine.interruptGenerate(); break; }
        }
      }
    }
    flush();
    reply(id, { text, usage, interrupted: operation.cancelled });
  } catch (error) {
    if (!operation.cancelled) throw error;
    reply(id, { text, usage, interrupted: true });
  } finally {
    clearTimeout(flushTimer);
    if (active === operation) active = null;
  }
}

self.addEventListener('message', event => {
  const { id, method, args = {}, targetId } = event.data || {};
  if (method === 'interrupt') {
    if (active?.id === targetId) {
      active.cancelled = true;
      // The client also has a hard termination deadline for a stalled GPU or
      // prefill operation. Never leave an unhandled rejection in the worker.
      Promise.resolve(engine?.interruptGenerate()).catch(() => {});
    }
    return;
  }
  if (!Number.isSafeInteger(id)) return;
  if (busy) { self.postMessage({ id, error: 'The local AI worker is busy.' }); return; }
  busy = true;
  (async () => {
    try {
      if (method === 'load') await load(id, args.modelId);
      else if (method === 'generate') await generate(id, args);
      else throw new Error('Unknown local AI request.');
    } catch (error) {
      self.postMessage({ id, error: assistantErrorMessage(error) });
    } finally { busy = false; }
  })();
});
