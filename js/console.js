import {
  debounce, escapeHtml, expressionState, formatDuration, mistralErrorUrl,
  safeOpen, copyText, smartIndentR
} from './utils.js';
import { acceptAceCompletionOrIndent, EditorManager } from './editor.js';

const CONSOLE_KEYWORDS = [
  'if', 'else', 'for', 'while', 'repeat', 'function', 'return', 'next', 'break',
  'TRUE', 'FALSE', 'NULL', 'NA', 'NaN', 'Inf', 'library', 'require', 'source',
  'print', 'str', 'summary', 'head', 'tail', 'plot', 'hist', 'data.frame', 'list',
  'lapply', 'sapply', 'vapply', 'Reduce', 'seq_len', 'seq_along', 'read.csv'
];

function iconMarkup(id) {
  return `<svg class="ui-icon" aria-hidden="true"><use href="#${id}"></use></svg>`;
}

function groupedOutputs(outputs) {
  const groups = [];
  for (const item of outputs) {
    const normalizedType = item.type === 'stderr' ? 'error' : item.type === 'stdout' ? 'output' : item.type;
    const previous = groups.at(-1);
    if (previous?.type === normalizedType) previous.text += `${previous.text ? '\n' : ''}${item.text}`;
    else groups.push({ type: normalizedType, text: item.text });
  }
  return groups.filter(group => group.text !== '');
}

function symbolInAce(editor) {
  const selected = editor.getSelectedText().trim();
  if (selected) return selected;
  const position = editor.getCursorPosition();
  const line = editor.session.getLine(position.row);
  let start = position.column;
  let end = position.column;
  while (start > 0 && /[A-Za-z0-9._]/.test(line[start - 1])) start -= 1;
  while (end < line.length && /[A-Za-z0-9._]/.test(line[end])) end += 1;
  return line.slice(start, end);
}

export class ConsoleManager extends EventTarget {
  constructor({ host, fallback, output, prompt, engine, settings, callbacks = {} }) {
    super();
    this.host = host;
    this.fallback = fallback;
    this.output = output;
    this.prompt = prompt;
    this.engine = engine;
    this.settings = settings;
    this.callbacks = callbacks;
    this.ace = globalThis.ace || null;
    this.editor = null;
    this.fallbackMode = !this.ace;
    this.history = [];
    this.historyIndex = 0;
    this.historyDraft = '';
    this.transcript = [];
    this.theme = 'crimson_editor';
    this.busy = false;
    // Invalidates stale submit-finally handlers when the runtime is restarted.
    this.submissionEpoch = 0;
    // Rendering command syntax highlighting is asynchronous. Keep output
    // writes ordered, while an epoch invalidates work queued before Clear.
    this.renderEpoch = 0;
    this.renderQueue = Promise.resolve();
    this.completionRequest = 0;
    this.completionTimer = 0;
    this.completionCallback = null;
    this.completionCache = new Map();
    this.persistDraft = debounce(() => this.callbacks.onDraftChange?.(this.getValue()), 250);
  }

  async initialize({ history = [], transcript = [], draft = '' } = {}) {
    this.history = Array.isArray(history) ? history : [];
    this.historyIndex = this.history.length;
    this.transcript = Array.isArray(transcript) ? transcript.slice(-500) : [];
    if (this.ace) {
      try {
        this.editor = this.ace.edit(this.host);
        this.editor.session.setMode('ace/mode/r');
        this.editor.session.setUseWorker(false);
        this.editor.session.setUseSoftTabs(true);
        this.editor.session.setTabSize(this.settings.tabSize || 2);
        this.editor.renderer.setShowGutter(false);
        this.editor.setShowPrintMargin(false);
        this.editor.setHighlightActiveLine(false);
        this.editor.setHighlightGutterLine(false);
        this.editor.setOptions({
          minLines: 1,
          maxLines: 8,
          enableBasicAutocompletion: true,
          enableLiveAutocompletion: true,
          enableSnippets: true,
          showFoldWidgets: false,
          behavioursEnabled: true,
          wrapBehavioursEnabled: true,
          scrollPastEnd: 0
        });
        this.registerCommands();
        this.registerCompleter();
        this.editor.on('change', () => {
          this.updatePrompt();
          this.resizeInput();
          this.persistDraft();
        });
        this.editor.on('focus', () => this.callbacks.onFocus?.('console'));
        this.editor.setValue(draft || '', 1);
      } catch {
        this.enableFallback(draft);
      }
    } else {
      this.enableFallback(draft);
    }
    this.applySettings(this.settings);
    await this.renderTranscript();
    this.updatePrompt();
  }

  enableFallback(draft = '') {
    this.fallbackMode = true;
    this.host.hidden = true;
    this.fallback.hidden = false;
    this.fallback.value = draft;
    this.fallback.addEventListener('input', () => {
      this.updatePrompt();
      this.persistDraft();
    });
    this.fallback.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || expressionState(this.fallback.value).complete) && !event.shiftKey) {
        event.preventDefault();
        this.submit();
      } else if (event.key === 'ArrowUp' && this.fallback.selectionStart === 0) {
        event.preventDefault();
        this.historyPrevious();
      } else if (event.key === 'ArrowDown' && this.fallback.selectionStart === this.fallback.value.length) {
        event.preventDefault();
        this.historyNext();
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        this.insertPipe();
      }
    });
  }

  registerCommands() {
    this.editor.commands.addCommand({
      name: 'consoleEnter',
      bindKey: { win: 'Enter', linux: 'Enter' },
      exec: () => {
        const value = this.getValue();
        const cursor = this.editor.getCursorPosition();
        const lastRow = this.editor.session.getLength() - 1;
        const atEnd = cursor.row === lastRow && cursor.column === this.editor.session.getLine(lastRow).length;
        if (expressionState(value).complete && atEnd) this.submit();
        else this.editor.insert('\n');
      }
    });
    this.editor.commands.addCommand({ name: 'consoleForceRun', bindKey: { win: 'Ctrl-Enter', linux: 'Ctrl-Enter' }, exec: () => this.submit() });
    this.editor.commands.addCommand({ name: 'consoleNewline', bindKey: { win: 'Shift-Enter', linux: 'Shift-Enter' }, exec: editor => editor.insert('\n') });
    this.editor.commands.addCommand({ name: 'consoleHistoryPrevious', bindKey: { win: 'Up', linux: 'Up' }, exec: editor => {
      const cursor = editor.getCursorPosition();
      if (cursor.row === 0) this.historyPrevious();
      else editor.navigateUp(1);
    }});
    this.editor.commands.addCommand({ name: 'consoleHistoryNext', bindKey: { win: 'Down', linux: 'Down' }, exec: editor => {
      const cursor = editor.getCursorPosition();
      if (cursor.row === editor.session.getLength() - 1) this.historyNext();
      else editor.navigateDown(1);
    }});
    this.editor.commands.addCommand({ name: 'consolePipe', bindKey: { win: 'Ctrl-Shift-M', linux: 'Ctrl-Shift-M' }, exec: () => this.insertPipe() });
    this.editor.commands.addCommand({ name: 'consoleClear', bindKey: { win: 'Ctrl-L', linux: 'Ctrl-L' }, exec: () => this.clear() });
    this.editor.commands.addCommand({ name: 'consoleHelp', bindKey: { win: 'F1', linux: 'F1' }, exec: () => this.callbacks.onHelp?.(symbolInAce(this.editor)) });
    this.editor.commands.addCommand({ name: 'consoleSmartIndent', bindKey: { win: 'Ctrl-I', linux: 'Ctrl-I' }, exec: () => this.setValue(smartIndentR(this.getValue(), this.settings.tabSize || 2)) });
    this.editor.commands.addCommand({
      name: 'consoleAcceptCompletionOrIndent',
      bindKey: { win: 'Tab', linux: 'Tab' },
      exec: editor => acceptAceCompletionOrIndent(editor)
    });
  }

  registerCompleter() {
    const languageTools = this.ace.require('ace/ext/language_tools');
    const manager = this;
    const identifierRegexps = [/[A-Za-z0-9._:$@%]/];
    const localCompleter = {
      identifierRegexps,
      getCompletions(editor, session, position, prefix, callback) {
        if (editor !== manager.editor || !manager.settings.autocomplete) return callback(null, []);
        if (!prefix) return callback(null, []);
        const words = new Set(CONSOLE_KEYWORDS);
        for (const command of manager.history.slice(-250)) {
          for (const match of String(command).matchAll(/\b[A-Za-z.][A-Za-z0-9._]{2,}\b/g)) words.add(match[0]);
          if (words.size >= 800) break;
        }
        const values = [...words]
          .filter(value => value.startsWith(prefix) && value !== prefix)
          .slice(0, 250)
          .map(value => ({ caption: value, value, meta: CONSOLE_KEYWORDS.includes(value) ? 'R' : 'history', score: CONSOLE_KEYWORDS.includes(value) ? 1100 : 850 }));
        callback(null, values);
      }
    };
    const runtimeCompleter = {
      identifierRegexps,
      getCompletions(editor, session, position, prefix, callback) {
        const line = session.getLine(position.row).slice(0, position.column);
        const memberContext = /(?:\$|:::{0,1})[A-Za-z0-9._]*$/.test(line);
        if (
          editor !== manager.editor ||
          !manager.settings.autocomplete ||
          !manager.engine?.ready ||
          manager.engine.running ||
          (!memberContext && prefix.length < 2)
        ) return callback(null, []);
        const request = ++manager.completionRequest;
        const cacheKey = `${line}\u0000${prefix}`;
        const cached = manager.completionCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < 5000) return callback(null, cached.values);
        let settled = false;
        const finish = (error, values) => {
          if (settled) return;
          settled = true;
          callback(error, values);
        };
        window.clearTimeout(manager.completionTimer);
        manager.completionCallback?.(null, []);
        manager.completionCallback = finish;
        manager.completionTimer = window.setTimeout(() => {
          manager.completionTimer = 0;
          manager.engine.getCompletions(prefix, line)
            .then(values => {
              if (request !== manager.completionRequest || editor !== manager.editor) return finish(null, []);
              const items = values
                .filter(value => value && value !== prefix)
                .map(value => ({ caption: value, value, meta: manager.typeMeta(value), score: 1000 }));
              manager.completionCache.set(cacheKey, { timestamp: Date.now(), values: items });
              if (manager.completionCache.size > 100) manager.completionCache.delete(manager.completionCache.keys().next().value);
              finish(null, items);
            })
            .catch(() => finish(null, []))
            .finally(() => {
              if (manager.completionCallback === finish) manager.completionCallback = null;
            });
        }, 110);
      }
    };
    this.editor.completers = [localCompleter, runtimeCompleter, languageTools.textCompleter].filter(Boolean);
  }

  typeMeta(name) {
    const object = (this.callbacks.getEnvironment?.() || []).find(item => item.name === name);
    return this.settings.typeHints && object ? object.className || object.type : 'R';
  }

  applySettings(settings) {
    this.settings = settings;
    if (this.editor) {
      this.editor.setFontSize(settings.fontSize);
      this.editor.setOption('fontFamily', settings.fontFamily);
      this.editor.setOption('enableBasicAutocompletion', settings.autocomplete);
      this.editor.setOption('enableLiveAutocompletion', settings.autocomplete);
      this.editor.setOption('enableSnippets', settings.autocomplete);
      this.editor.session.setTabSize(settings.tabSize || 2);
    }
    if (this.fallback) this.fallback.style.tabSize = String(settings.tabSize || 2);
  }

  async setTheme(theme) {
    const nextTheme = theme || 'crimson_editor';
    const changed = this.theme !== nextTheme;
    this.theme = nextTheme;
    if (this.editor) {
      try { await this.editor.setTheme(`ace/theme/${nextTheme}`); } catch { /* The editor keeps its current theme. */ }
    }
    if (changed && this.transcript.length) await this.renderTranscript();
  }

  getValue() { return this.editor ? this.editor.getValue() : this.fallback.value; }
  setValue(value) {
    if (this.editor) this.editor.setValue(value || '', 1);
    else this.fallback.value = value || '';
    this.updatePrompt();
  }

  insertPipe() {
    const pipe = this.settings.pipe || '|>';
    if (this.editor) this.editor.insert(` ${pipe} `);
    else {
      const start = this.fallback.selectionStart;
      this.fallback.setRangeText(` ${pipe} `, start, this.fallback.selectionEnd, 'end');
      this.fallback.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  updatePrompt() {
    const state = expressionState(this.getValue());
    this.prompt.textContent = state.complete ? '>' : '+';
    this.prompt.classList.toggle('continuation', !state.complete);
  }

  resizeInput() {
    if (!this.editor) return;
    const lines = Math.min(8, Math.max(1, this.editor.session.getScreenLength()));
    const height = Math.min(180, Math.max(44, lines * this.editor.renderer.lineHeight + 12));
    this.host.style.height = `${height}px`;
    this.editor.resize(true);
  }

  async submit() {
    if (this.busy) return;
    const code = this.getValue().replace(/\r\n?|\u2028|\u2029/g, '\n').trimEnd();
    if (!code.trim()) return;
    const submission = ++this.submissionEpoch;
    this.busy = true;
    try {
      this.pushHistory(code);
      this.setValue('');
      this.setReadOnly(true);
      await this.appendEntry('command', code, { persist: true });
      await this.callbacks.onSubmit?.(code);
    } finally {
      // A runtime restart explicitly resets the editor and advances the epoch.
      // Do not let a stale submission re-lock or unlock a newer submission.
      if (submission !== this.submissionEpoch) return;
      this.busy = false;
      this.setReadOnly(false);
      this.focus();
    }
  }

  pushHistory(code) {
    if (this.history.at(-1) !== code) this.history.push(code);
    const limit = Number(this.settings.consoleHistoryLimit) || 1000;
    if (this.history.length > limit) this.history = this.history.slice(-limit);
    this.historyIndex = this.history.length;
    this.historyDraft = '';
    this.callbacks.onHistoryChange?.(this.history);
  }

  historyPrevious() {
    if (!this.history.length) return;
    if (this.historyIndex === this.history.length) this.historyDraft = this.getValue();
    this.historyIndex = Math.max(0, this.historyIndex - 1);
    this.setValue(this.history[this.historyIndex] || '');
    this.moveToEnd();
  }

  historyNext() {
    if (!this.history.length) return;
    this.historyIndex = Math.min(this.history.length, this.historyIndex + 1);
    this.setValue(this.historyIndex === this.history.length ? this.historyDraft : this.history[this.historyIndex]);
    this.moveToEnd();
  }

  moveToEnd() {
    if (this.editor) this.editor.navigateFileEnd();
    else this.fallback.setSelectionRange(this.fallback.value.length, this.fallback.value.length);
  }

  setReadOnly(readOnly) {
    if (this.editor) this.editor.setReadOnly(readOnly);
    else this.fallback.disabled = readOnly;
  }

  resetExecutionState({ focus = false } = {}) {
    this.submissionEpoch += 1;
    this.busy = false;
    this.setReadOnly(false);
    if (focus) this.focus();
  }

  async appendExecution(result, { showTiming = this.settings.timing, showTraceback = this.settings.autoTraceback } = {}) {
    for (const group of groupedOutputs(result.outputs || [])) await this.appendEntry(group.type, group.text, { persist: true });
    for (const plot of result.plots || []) this.callbacks.onPlot?.(plot);
    if (result.interrupted) {
      await this.appendEntry('info', 'Execution interrupted.', { persist: true });
    } else if (result.interruptLate) {
      await this.appendEntry('info', 'The expression had already finished before the interrupt reached R.', { persist: true });
    }
    if (!result.ok && !result.interrupted && showTraceback && result.traceback?.length) {
      await this.appendEntry('traceback', result.traceback.join('\n'), { persist: true });
    }
    if (showTiming) await this.appendEntry('timing', `Elapsed: ${formatDuration(result.elapsed)}`, { persist: true });
    if (!result.streamed && result.ok && !(result.outputs || []).length && !(result.plots || []).length) {
      await this.appendEntry('success', 'Expression completed without visible output.', { persist: true });
    }
  }

  beginStream() {
    return { current: null, pendingBlankLines: 0, closed: false };
  }

  async appendStreamItem(session, item = {}) {
    if (!session || session.closed) return null;
    const rawType = String(item.type || 'stdout');
    const type = rawType === 'stdout' ? 'output' : rawType === 'stderr' ? 'error' : rawType;
    let text = String(item.text ?? '');
    const coalescible = rawType === 'stdout' || rawType === 'stderr';
    const forceNew = !coalescible || type === 'command';

    if (!text && coalescible && !session.current) {
      session.pendingBlankLines += 1;
      return null;
    }
    if (session.pendingBlankLines && coalescible && text) {
      text = `${'\n'.repeat(session.pendingBlankLines)}${text}`;
      session.pendingBlankLines = 0;
    } else if (!coalescible) {
      session.pendingBlankLines = 0;
    }

    if (!forceNew && session.current?.type === type) {
      const entry = session.current.entry;
      const node = this.output.querySelector(`[data-entry-id="${entry.id}"]`);
      const body = node?.querySelector('.console-entry-body');
      // Clear and Erase invalidate the live DOM entry while R may still be
      // producing output. Resume with a fresh entry rather than mutating an
      // invisible object that no longer belongs to the transcript.
      if (!body || !this.transcript.includes(entry)) {
        session.current = null;
        const replacement = await this.appendEntry(type, text, { persist: true });
        session.current = { type, entry: replacement };
        return replacement;
      }
      const addition = `${entry.text || text ? '\n' : ''}${text}`;
      entry.text += addition;
      if (typeof body.append === 'function' && globalThis.document?.createTextNode) {
        body.append(document.createTextNode(addition));
      } else {
        body.textContent = entry.text;
      }
      this.callbacks.onTranscriptChange?.(this.transcript);
      if (this.settings.consoleFollow) this.output.scrollTop = this.output.scrollHeight;
      return entry;
    }

    const entry = await this.appendEntry(type, text, { persist: true });
    session.current = coalescible ? { type, entry } : null;
    return entry;
  }

  endStream(session) {
    if (!session) return;
    session.closed = true;
    session.current = null;
    session.pendingBlankLines = 0;
  }

  async appendEntry(type, text, { persist = true, timestamp = Date.now() } = {}) {
    const entry = { id: `${timestamp}-${Math.random().toString(36).slice(2)}`, type, text: String(text), timestamp };
    if (persist) {
      this.transcript.push(entry);
      if (this.transcript.length > 500) this.transcript = this.transcript.slice(-500);
      this.callbacks.onTranscriptChange?.(this.transcript);
    }
    const epoch = this.renderEpoch;
    const render = async () => {
      const node = await this.renderEntry(entry);
      if (epoch !== this.renderEpoch) return;
      this.output.append(node);
      if (this.settings.consoleFollow) this.output.scrollTop = this.output.scrollHeight;
    };
    this.renderQueue = this.renderQueue.then(render, render);
    await this.renderQueue;
    return entry;
  }

  async renderEntry(entry) {
    const article = document.createElement('article');
    article.className = `console-entry ${entry.type}`;
    article.dataset.entryId = entry.id;
    const header = document.createElement('header');
    const icon = document.createElement('span');
    icon.className = 'console-entry-icon';
    const label = document.createElement('span');
    label.className = 'console-entry-label';
    const time = document.createElement('time');
    time.dateTime = new Date(entry.timestamp).toISOString();
    time.textContent = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(entry.timestamp);
    const actions = document.createElement('div');
    actions.className = 'console-entry-actions';
    const metadata = {
      command: ['›_', 'R input'], output: ['•', 'Output'], message: ['ℹ️', 'Message'], warning: ['⚠️', 'Warning'],
      error: ['🧯', 'Error'], traceback: ['🧭', 'Traceback'], timing: ['⏱️', 'Timing'], success: ['✅', 'Complete'], info: ['ℹ️', 'Info']
    }[entry.type] || ['•', entry.type];
    icon.textContent = metadata[0];
    label.textContent = metadata[1];
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.title = 'Copy';
    copy.innerHTML = iconMarkup('i-copy');
    copy.addEventListener('click', () => copyText(entry.text));
    actions.append(copy);
    if (entry.type === 'error') {
      const explain = document.createElement('button');
      explain.type = 'button';
      explain.title = 'Explain with Mistral';
      explain.innerHTML = iconMarkup('i-sparkles');
      explain.addEventListener('click', () => safeOpen(mistralErrorUrl(entry.text)));
      actions.append(explain);
    }
    header.append(icon, label, time, actions);
    const body = document.createElement('pre');
    body.className = 'console-entry-body';
    if (entry.type === 'command') {
      body.innerHTML = await EditorManager.highlightR(entry.text, this.theme);
    } else {
      body.textContent = entry.text;
    }
    article.append(header, body);
    return article;
  }

  async renderTranscript() {
    const epoch = ++this.renderEpoch;
    this.renderQueue = Promise.resolve();
    const entries = this.transcript.slice(-200);
    const render = async () => {
      const fragment = document.createDocumentFragment();
      fragment.append(this.createWelcomeNode());
      for (const entry of entries) {
        const node = await this.renderEntry(entry);
        if (epoch !== this.renderEpoch) return;
        fragment.append(node);
      }
      if (epoch !== this.renderEpoch) return;
      this.output.replaceChildren(fragment);
      this.output.scrollTop = this.output.scrollHeight;
    };
    this.renderQueue = this.renderQueue.then(render, render);
    await this.renderQueue;
  }

  createWelcomeNode() {
    const welcome = document.createElement('div');
    welcome.className = 'console-welcome';
    welcome.innerHTML = '<strong>webR Studio console</strong><br>Enter accepts a complete expression. Shift+Enter adds a line. Multiline history is available with ↑ and ↓.';
    return welcome;
  }

  showWelcomeOnly() {
    this.renderEpoch += 1;
    this.renderQueue = Promise.resolve();
    this.output.replaceChildren(this.createWelcomeNode());
  }

  clear() {
    this.transcript = [];
    this.callbacks.onTranscriptChange?.([]);
    this.showWelcomeOnly();
  }

  resetAll() {
    this.persistDraft.cancel();
    this.history = [];
    this.historyIndex = 0;
    this.historyDraft = '';
    this.transcript = [];
    this.setValue('');
    this.persistDraft.cancel();
    this.callbacks.onHistoryChange?.([]);
    this.callbacks.onTranscriptChange?.([]);
    this.callbacks.onDraftChange?.('');
    this.showWelcomeOnly();
  }

  focus() { (this.editor || this.fallback)?.focus(); }
  resize() { this.editor?.resize(true); this.resizeInput(); }
}
