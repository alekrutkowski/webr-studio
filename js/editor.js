import {
  aceModeFromPath, basename, currentRExpression, debounce, escapeHtml,
  expressionState, extname, smartIndentR, stripRCommentsAndStrings
} from './utils.js?v=1.2.12';

const ACE_CDN = 'https://cdn.jsdelivr.net/npm/ace-builds@1.44.0/src-min-noconflict';
const R_MARKDOWN_MODE_ID = 'ace/mode/webr_rmarkdown';
const R_MARKDOWN_RULES_ID = 'ace/mode/webr_rmarkdown_highlight_rules';

const R_KEYWORDS = [
  'if', 'else', 'repeat', 'while', 'function', 'for', 'in', 'next', 'break',
  'TRUE', 'FALSE', 'NULL', 'Inf', 'NaN', 'NA', 'NA_integer_', 'NA_real_',
  'NA_complex_', 'NA_character_', 'return', 'switch', 'tryCatch', 'withCallingHandlers'
];

export function acceptAceCompletionOrIndent(editor) {
  const completer = editor?.completer;
  const popupState = completer?.popup?.isOpen;
  const popupOpen = typeof popupState === 'function'
    ? Boolean(popupState.call(completer.popup))
    : Boolean(popupState);
  if (completer && (completer.activated || popupOpen) && typeof completer.insertMatch === 'function') {
    completer.insertMatch();
    return true;
  }
  editor?.execCommand?.('indent');
  return false;
}

const R_BASE_COMPLETIONS = [
  'library', 'require', 'source', 'print', 'cat', 'message', 'warning', 'stop',
  'data.frame', 'matrix', 'list', 'c', 'seq', 'seq_len', 'seq_along', 'rep',
  'length', 'nrow', 'ncol', 'dim', 'names', 'colnames', 'rownames', 'class',
  'typeof', 'str', 'summary', 'head', 'tail', 'View', 'plot', 'hist', 'boxplot',
  'lm', 'glm', 'predict', 'mean', 'median', 'sd', 'var', 'sum', 'min', 'max',
  'apply', 'lapply', 'sapply', 'vapply', 'mapply', 'Reduce', 'Map', 'Filter',
  'read.csv', 'read.table', 'write.csv', 'saveRDS', 'readRDS', 'save', 'load',
  'set.seed', 'sample', 'rnorm', 'runif', 'dnorm', 'pnorm', 'qnorm', 'as.data.frame',
  'as.character', 'as.numeric', 'as.integer', 'as.logical', 'is.na', 'complete.cases'
];

function defineCrimsonTheme(ace) {
  try {
    if (ace.require('ace/theme/crimson_editor')) return;
  } catch {
    // The custom theme has not been registered yet.
  }
  ace.define('ace/theme/crimson_editor', ['require', 'exports', 'module', 'ace/lib/dom'], (require, exports) => {
    exports.isDark = false;
    exports.cssClass = 'ace-crimson-editor';
    exports.cssText = `
.ace-crimson-editor .ace_gutter {background:#f6f4f5;color:#9a9094;border-right:1px solid #e8e2e4}
.ace-crimson-editor {background:#fffdfd;color:#262124}
.ace-crimson-editor .ace_print-margin {width:1px;background:#f0e9ec}
.ace-crimson-editor .ace_cursor {color:#9f1239}
.ace-crimson-editor .ace_marker-layer .ace_selection {background:#f5c9d7}
.ace-crimson-editor.ace_multiselect .ace_selection.ace_start {box-shadow:0 0 3px 0 #fffdfd}
.ace-crimson-editor .ace_marker-layer .ace_step {background:#fff4c2}
.ace-crimson-editor .ace_marker-layer .ace_bracket {margin:0;border:0;background:#f3d7e0;border-radius:2px}
.ace-crimson-editor .ace_marker-layer .ace_active-line {background:#fff5f7}
.ace-crimson-editor .ace_gutter-active-line {background:#f4e9ed;color:#6f263d}
.ace-crimson-editor .ace_marker-layer .ace_selected-word {border:0;background:#fae8ee;border-radius:2px}
.ace-crimson-editor .ace_invisible {color:#d9cfd2}
.ace-crimson-editor .ace_keyword,.ace-crimson-editor .ace_meta {color:#a30f43;font-weight:600}
.ace-crimson-editor .ace_keyword.ace_operator {color:#bd2858;font-weight:500}
.ace-crimson-editor .ace_constant.ace_language {color:#7e3aaa}
.ace-crimson-editor .ace_constant.ace_numeric {color:#1d5d9a}
.ace-crimson-editor .ace_constant.ace_character {color:#7e3aaa}
.ace-crimson-editor .ace_invalid {color:#fff;background:#c32939}
.ace-crimson-editor .ace_support.ace_function,.ace-crimson-editor .ace_entity.ace_name.ace_function {color:#075c73}
.ace-crimson-editor .ace_support.ace_type,.ace-crimson-editor .ace_storage {color:#8b2a54}
.ace-crimson-editor .ace_string {color:#34743f}
.ace-crimson-editor .ace_comment {color:#8b8789;font-style:italic}
.ace-crimson-editor .ace_variable {color:#3c315e}
.ace-crimson-editor .ace_variable.ace_language {color:#8d2750}
.ace-crimson-editor .ace_markup.ace_heading {color:#8f1239;font-weight:700}
.ace-crimson-editor .ace_markup.ace_list {color:#a30f43;font-weight:600}
.ace-crimson-editor .ace_markup.ace_quote {color:#706b6e;font-style:italic}
.ace-crimson-editor .ace_markup.ace_bold {font-weight:700}
.ace-crimson-editor .ace_markup.ace_italic {font-style:italic}
.ace-crimson-editor .ace_markup.ace_raw {color:#36536b}
.ace-crimson-editor .ace_string.ace_other.ace_link,.ace-crimson-editor .ace_constant.ace_other.ace_reference.ace_link {color:#075c73;text-decoration:underline}
.ace-crimson-editor .ace_fold {background:#9f1239;border-color:#9f1239}
.ace-crimson-editor .ace_indent-guide {background:linear-gradient(to bottom,#ece6e8 50%,transparent 50%) right repeat-y;background-size:1px 4px}
.ace-crimson-editor .ace_gutter-cell.ace_breakpoint {border-left:3px solid #9f1239}
.ace-crimson-editor .ace_scrollbar-v,.ace-crimson-editor .ace_scrollbar-h {background:transparent}
`;
    const dom = require('../lib/dom');
    dom.importCssString(exports.cssText, exports.cssClass);
  });
}


function existingAceModule(ace, id) {
  try {
    return ace.require(id) || null;
  } catch {
    return null;
  }
}

function loadAceModule(ace, id) {
  const existing = existingAceModule(ace, id);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    ace.config.loadModule(id, loaded => {
      const module = loaded || existingAceModule(ace, id);
      if (module) resolve(module);
      else reject(new Error(`Ace module could not be loaded: ${id}`));
    });
  });
}

async function defineRMarkdownMode(ace) {
  const existing = existingAceModule(ace, R_MARKDOWN_MODE_ID);
  if (existing?.Mode) return existing;

  // A custom Ace module does not automatically fetch unresolved dependencies.
  // Load the stock Markdown and R modes first so the embedded grammar is ready
  // before any .Rmd session is created.
  await Promise.all([
    loadAceModule(ace, 'ace/mode/markdown'),
    loadAceModule(ace, 'ace/mode/r')
  ]);

  ace.define(
    R_MARKDOWN_RULES_ID,
    [
      'require', 'exports', 'module', 'ace/lib/oop',
      'ace/mode/markdown_highlight_rules', 'ace/mode/r_highlight_rules'
    ],
    (require, exports) => {
      const oop = require('../lib/oop');
      const MarkdownHighlightRules = require('./markdown_highlight_rules').MarkdownHighlightRules;
      const RHighlightRules = require('./r_highlight_rules').RHighlightRules;

      const RMarkdownHighlightRules = function RMarkdownHighlightRules() {
        MarkdownHighlightRules.call(this);
        this.$rules.start.unshift({
          token: 'support.function.codebegin',
          regex: '^ {0,3}(?:`{3,}|~{3,})[ \\t]*\\{[rR](?:[ \\t,][^}]*)?\\}[ \\t]*$',
          next: 'r-start'
        });
        this.embedRules(RHighlightRules, 'r-', [{
          token: 'support.function.codeend',
          regex: '^ {0,3}(?:`{3,}|~{3,})\\s*$',
          next: 'start'
        }]);
        this.normalizeRules();
      };
      oop.inherits(RMarkdownHighlightRules, MarkdownHighlightRules);
      exports.RMarkdownHighlightRules = RMarkdownHighlightRules;
    }
  );

  ace.define(
    R_MARKDOWN_MODE_ID,
    [
      'require', 'exports', 'module', 'ace/lib/oop',
      'ace/mode/markdown', R_MARKDOWN_RULES_ID
    ],
    (require, exports) => {
      const oop = require('../lib/oop');
      const MarkdownMode = require('./markdown').Mode;
      const RMarkdownHighlightRules = require('./webr_rmarkdown_highlight_rules').RMarkdownHighlightRules;
      const Mode = function Mode() {
        MarkdownMode.call(this);
        this.HighlightRules = RMarkdownHighlightRules;
        this.$tokenizer = null;
        this.$id = R_MARKDOWN_MODE_ID;
      };
      oop.inherits(Mode, MarkdownMode);
      exports.Mode = Mode;
    }
  );

  const registered = existingAceModule(ace, R_MARKDOWN_MODE_ID);
  if (!registered?.Mode) throw new Error('The R Markdown editor mode could not be registered.');
  return registered;
}

function waitForAce(timeout = 8000) {
  if (globalThis.ace) return Promise.resolve(globalThis.ace);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (globalThis.ace) {
        window.clearInterval(timer);
        resolve(globalThis.ace);
      } else if (Date.now() - started > timeout) {
        window.clearInterval(timer);
        reject(new Error('Ace Editor could not be loaded'));
      }
    }, 50);
  });
}

function symbolAt(editor) {
  if (!editor) return '';
  const selection = editor.getSelectedText().trim();
  if (/^[A-Za-z.][A-Za-z0-9._]*$/.test(selection)) return selection;
  const position = editor.getCursorPosition();
  const line = editor.session.getLine(position.row);
  let start = position.column;
  let end = position.column;
  while (start > 0 && /[A-Za-z0-9._]/.test(line[start - 1])) start -= 1;
  while (end < line.length && /[A-Za-z0-9._]/.test(line[end])) end += 1;
  return line.slice(start, end);
}

function rMarkdownCode(source) {
  const lines = String(source).split('\n');
  let inRChunk = false;
  let fence = '';
  return lines.map(line => {
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})\s*\{r(?:[ ,}]|$)/i);
    if (!inRChunk && opening) {
      inRChunk = true;
      fence = opening[1][0];
      return '';
    }
    if (inRChunk && new RegExp(`^ {0,3}${fence}{3,}\\s*$`).test(line)) {
      inRChunk = false;
      fence = '';
      return '';
    }
    return inRChunk ? line : '';
  }).join('\n');
}

function rMarkdownChunkRanges(source) {
  const lines = String(source).split('\n');
  const ranges = [];
  let openingRow = -1;
  let fenceCharacter = '';
  let fenceLength = 0;

  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row];
    if (openingRow < 0) {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*\{[rR](?:[ \t,][^}]*)?\}[ \t]*$/);
      if (!opening) continue;
      openingRow = row;
      fenceCharacter = opening[1][0];
      fenceLength = opening[1].length;
      continue;
    }

    const trimmed = line.replace(/^ {0,3}/, '');
    const closing = trimmed.match(/^(`+|~+)[ \t]*$/);
    if (!closing || closing[1][0] !== fenceCharacter || closing[1].length < fenceLength) continue;
    ranges.push({ startRow: openingRow, endRow: row });
    openingRow = -1;
    fenceCharacter = '';
    fenceLength = 0;
  }

  if (openingRow >= 0) ranges.push({ startRow: openingRow, endRow: Math.max(openingRow, lines.length - 1) });
  return ranges;
}

function rParserUnits(source, path = '') {
  if (extname(path) !== 'rmd') return [{ code: String(source), rowOffset: 0 }];
  const lines = String(source).split('\n');
  const units = [];
  let buffer = [];
  let startRow = 0;
  let fence = '';
  let inRChunk = false;
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row];
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})\s*\{r(?:[ ,}]|$)/i);
    if (!inRChunk && opening) {
      inRChunk = true;
      fence = opening[1][0];
      buffer = [];
      startRow = row + 1;
      continue;
    }
    if (inRChunk && new RegExp(`^ {0,3}${fence}{3,}\\s*$`).test(line)) {
      units.push({ code: buffer.join('\n'), rowOffset: startRow });
      buffer = [];
      inRChunk = false;
      fence = '';
      continue;
    }
    if (inRChunk) buffer.push(line);
  }
  if (inRChunk && buffer.length) units.push({ code: buffer.join('\n'), rowOffset: startRow });
  return units;
}

function assignmentEqualsPositions(source) {
  const sanitized = stripRCommentsAndStrings(String(source)).text;
  const positions = [];
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const controlHeads = new Set(['if', 'for', 'while']);
  let row = 0;
  let column = 0;

  const parenthesisKind = index => {
    let cursor = index - 1;
    while (cursor >= 0 && /\s/.test(sanitized[cursor])) cursor -= 1;
    if (cursor < 0) return 'group';
    if (')]}'.includes(sanitized[cursor])) return 'arguments';
    const end = cursor + 1;
    while (cursor >= 0 && /[A-Za-z0-9._]/.test(sanitized[cursor])) cursor -= 1;
    const head = sanitized.slice(cursor + 1, end);
    if (!head || controlHeads.has(head)) return 'group';
    return 'arguments';
  };

  for (let index = 0; index < sanitized.length; index += 1) {
    const character = sanitized[index];
    if (character === '\n') {
      row += 1;
      column = 0;
      continue;
    }
    if ('([{'.includes(character)) {
      stack.push({
        character,
        kind: character === '(' ? parenthesisKind(index) : character === '[' ? 'arguments' : 'block'
      });
      column += 1;
      continue;
    }
    if (')]}'.includes(character)) {
      if (stack.at(-1)?.character === pairs[character]) stack.pop();
      column += 1;
      continue;
    }
    if (character === '=') {
      const previous = sanitized[index - 1] || '';
      const next = sanitized[index + 1] || '';
      const operator = (previous && '<>!='.includes(previous)) || (next && '=<>'.includes(next));
      const namedArgumentContext = stack.at(-1)?.kind === 'arguments';
      if (!operator && !namedArgumentContext) positions.push({ row, column });
    }
    column += 1;
  }
  return positions;
}

function staticDiagnostics(source, path = '') {
  const diagnostics = [];
  const code = extname(path) === 'rmd' ? rMarkdownCode(source) : String(source);
  const lines = code.split('\n');
  lines.forEach((line, row) => {
    const stripped = stripRCommentsAndStrings(line).text;
    const add = (column, length, severity, message, rule, replacement = null) => diagnostics.push({
      row, column, endColumn: column + Math.max(1, length), severity, message, source: rule, replacement
    });

    const trailing = line.match(/\s+$/);
    if (trailing && trailing.index > 0) add(trailing.index, trailing[0].length, 'suggestion', 'Remove trailing whitespace.', 'style/trailing-whitespace', '');
    if (line.length > 120) add(120, line.length - 120, 'suggestion', 'Line is longer than 120 characters.', 'style/line-length');

    for (const match of stripped.matchAll(/(^|[^A-Za-z0-9._])(T|F)(?![A-Za-z0-9._])/g)) {
      const column = match.index + match[1].length;
      add(column, 1, 'warning', `Use ${match[2] === 'T' ? 'TRUE' : 'FALSE'} instead of the redefinable shorthand ${match[2]}.`, 'correctness/logical-shorthand', match[2] === 'T' ? 'TRUE' : 'FALSE');
    }
    for (const match of stripped.matchAll(/\b1\s*:\s*length\s*\(([^)]+)\)/g)) {
      add(match.index, match[0].length, 'warning', 'Use seq_along() to handle zero-length vectors safely.', 'correctness/seq-along', `seq_along(${match[1].trim()})`);
    }
    for (const match of stripped.matchAll(/\b1\s*:\s*nrow\s*\(([^)]+)\)/g)) {
      add(match.index, match[0].length, 'warning', 'Use seq_len(nrow(...)) to handle zero-row data safely.', 'correctness/seq-len', `seq_len(nrow(${match[1].trim()}))`);
    }
    for (const match of stripped.matchAll(/([^=!<>])==\s*NA\b|\bNA\s*==/g)) {
      add(match.index, match[0].length, 'error', 'Comparisons with NA are always missing. Use is.na().', 'correctness/na-comparison');
    }
    for (const match of stripped.matchAll(/\binstall\.packages\s*\(/g)) {
      add(match.index, match[0].length, 'suggestion', 'Use the Packages pane so webR installs a compatible Wasm binary.', 'webr/package-manager');
    }
    for (const match of stripped.matchAll(/\bsetwd\s*\(/g)) {
      add(match.index, match[0].length, 'suggestion', 'Prefer project-relative paths. The browser project is mounted at /project.', 'portability/project-paths');
    }
  });
  for (const position of assignmentEqualsPositions(code)) {
    diagnostics.push({
      row: position.row,
      column: position.column,
      endColumn: position.column + 1,
      severity: 'suggestion',
      message: 'Use <- for assignment outside function arguments.',
      source: 'style/assignment',
      replacement: '<-'
    });
  }
  return diagnostics;
}

function outlineFromSource(source, path = '') {
  const symbols = [];
  const lines = source.split('\n');
  const markdown = ['rmd', 'md', 'markdown'].includes(extname(path));
  lines.forEach((line, row) => {
    const functionMatch = line.match(/^\s*([A-Za-z.][A-Za-z0-9._]*)\s*(?:<-|=)\s*function\s*\(([^)]*)\)/);
    if (functionMatch) symbols.push({ type: 'function', name: functionMatch[1], detail: `function(${functionMatch[2]})`, row, column: line.indexOf(functionMatch[1]) });
    const objectMatch = line.match(/^\s*([A-Za-z.][A-Za-z0-9._]*)\s*(?:<-|<<-)\s*(?!function\b)/);
    if (objectMatch) symbols.push({ type: 'object', name: objectMatch[1], detail: 'assignment', row, column: line.indexOf(objectMatch[1]) });
    const sectionMatch = line.match(/^\s*#+'?\s*(.*?)\s*(?:-{3,}|={3,})\s*$/);
    if (sectionMatch && sectionMatch[1]) symbols.push({ type: 'section', name: sectionMatch[1], detail: 'section', row, column: line.indexOf('#') });
    if (markdown) {
      const heading = line.match(/^(#{1,6})\s+(.+)/);
      if (heading) symbols.push({ type: 'section', name: heading[2].replace(/\s+#+$/, ''), detail: `heading ${heading[1].length}`, row, column: 0 });
    }
  });
  return symbols;
}

export class EditorManager extends EventTarget {
  constructor({ host, fallback, engine, settings, callbacks = {} }) {
    super();
    this.host = host;
    this.fallback = fallback;
    this.engine = engine;
    this.settings = settings;
    this.callbacks = callbacks;
    this.ace = null;
    this.editor = null;
    this.sessions = new Map();
    this.files = new Map();
    this.activePath = null;
    this.rainbowMarkers = [];
    this.rainbowMarkerSession = null;
    this.rMarkdownChunkMarkers = [];
    this.rMarkdownChunkMarkerSession = null;
    this.lintMarkers = [];
    this.lintMarkerSession = null;
    this.parserLintToken = 0;
    this.fallbackMode = false;
    this.outline = [];
    this.projectSymbols = [];
    this.completionWords = [];
    this.completionRequest = 0;
    this.completionTimer = 0;
    this.completionCallback = null;
    this.completionCache = new Map();
    this.dormantSession = null;
    this.lintDebounced = debounce(() => this.runDiagnostics(), 420);
    this.completionIndexDebounced = debounce(() => this.rebuildProjectIndex(), 900);
    this.outlineDebounced = debounce(() => {
      this.updateOutline(false);
      this.completionIndexDebounced();
    }, 180);
    this.rainbowDebounced = debounce(() => this.updateRainbowMarkers(), 100);
    this.rMarkdownChunksDebounced = debounce(() => this.updateRMarkdownChunkMarkers(), 80);
  }

  async initialize() {
    try {
      this.ace = await waitForAce();
      this.ace.config.set('basePath', ACE_CDN);
      this.ace.config.set('modePath', ACE_CDN);
      this.ace.config.set('themePath', ACE_CDN);
      this.ace.config.set('workerPath', ACE_CDN);
      defineCrimsonTheme(this.ace);
      await defineRMarkdownMode(this.ace);
      await loadAceModule(this.ace, 'ace/ext/language_tools');
      this.editor = this.ace.edit(this.host);
      this.dormantSession = this.ace.createEditSession('', 'ace/mode/text');
      this.dormantSession.setUseWorker(false);
      this.editor.setOptions({
        showPrintMargin: true,
        printMarginColumn: 100,
        displayIndentGuides: true,
        fadeFoldWidgets: false,
        showFoldWidgets: true,
        highlightSelectedWord: true,
        animatedScroll: false,
        scrollPastEnd: .35,
        enableBasicAutocompletion: true,
        enableLiveAutocompletion: true,
        enableSnippets: true,
        useSoftTabs: true,
        behavioursEnabled: true,
        wrapBehavioursEnabled: true,
        autoScrollEditorIntoView: false
      });
      this.registerCommands();
      this.registerCompleter();
      this.bindEditorEvents();
      this.applySettings(this.settings);
      return true;
    } catch (error) {
      this.fallbackMode = true;
      this.host.hidden = true;
      this.fallback.hidden = false;
      this.bindFallbackEvents();
      this.callbacks.onFallback?.(error);
      return false;
    }
  }

  bindEditorEvents() {
    this.editor.on('change', () => {
      if (!this.activePath) return;
      const content = this.editor.getValue();
      const file = this.files.get(this.activePath);
      if (file) file.content = content;
      this.callbacks.onChange?.(this.activePath, content);
      this.lintDebounced();
      this.outlineDebounced();
      this.rainbowDebounced();
      this.rMarkdownChunksDebounced();
    });
    this.editor.selection.on('changeCursor', () => {
      const position = this.editor.getCursorPosition();
      this.callbacks.onCursor?.(position, this.activePath);
      this.rainbowDebounced();
    });
    this.editor.session.on('changeScrollTop', this.rainbowDebounced);
    this.editor.on('focus', () => this.callbacks.onFocus?.('editor'));
  }

  bindFallbackEvents() {
    this.fallback.addEventListener('input', () => {
      if (!this.activePath) return;
      const file = this.files.get(this.activePath);
      if (file) file.content = this.fallback.value;
      this.callbacks.onChange?.(this.activePath, this.fallback.value);
      this.lintDebounced();
      this.outlineDebounced();
    });
    this.fallback.addEventListener('keydown', event => {
      if (event.ctrlKey && event.shiftKey && event.key === 'Enter') {
        event.preventDefault();
        this.callbacks.onRunScript?.(this.getValue());
      } else if (event.ctrlKey && event.key === 'Enter') {
        event.preventDefault();
        this.callbacks.onRunSelection?.(this.getRunText());
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        this.insertText(` ${this.settings.pipe} `);
      }
      if (event.key === 'F1') {
        event.preventDefault();
        this.callbacks.onHelp?.(this.getSymbolAtCursor());
      }
    });
  }

  registerCommands() {
    const commands = [
      { name: 'runSelection', bindKey: { win: 'Ctrl-Enter', linux: 'Ctrl-Enter' }, exec: () => this.callbacks.onRunSelection?.(this.getRunText()) },
      { name: 'runScript', bindKey: { win: 'Ctrl-Shift-Enter', linux: 'Ctrl-Shift-Enter' }, exec: () => this.callbacks.onRunScript?.(this.getValue()) },
      { name: 'insertPipe', bindKey: { win: 'Ctrl-Shift-M', linux: 'Ctrl-Shift-M' }, exec: () => this.insertPipe() },
      { name: 'smartIndent', bindKey: { win: 'Ctrl-I', linux: 'Ctrl-I' }, exec: () => this.smartIndent() },
      { name: 'functionHelp', bindKey: { win: 'F1', linux: 'F1' }, exec: () => this.callbacks.onHelp?.(this.getSymbolAtCursor()) },
      { name: 'jumpDefinition', bindKey: { win: 'F12', linux: 'F12' }, exec: () => this.jumpToDefinition() },
      { name: 'saveFile', bindKey: { win: 'Ctrl-S', linux: 'Ctrl-S' }, exec: () => this.callbacks.onSave?.(this.activePath) },
      { name: 'redoWindows', bindKey: { win: 'Ctrl-Y', linux: 'Ctrl-Y' }, exec: editor => editor.redo() },
      {
        name: 'acceptCompletionOrIndent',
        bindKey: { win: 'Tab', linux: 'Tab' },
        exec: editor => acceptAceCompletionOrIndent(editor)
      }
    ];
    commands.forEach(command => this.editor.commands.addCommand(command));
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
        const candidates = [
          ...R_KEYWORDS,
          ...R_BASE_COMPLETIONS,
          ...manager.projectSymbols.map(symbol => symbol.name),
          ...manager.completionWords
        ];
        const seen = new Set();
        const items = [];
        for (const value of candidates) {
          if (!value || !value.startsWith(prefix) || seen.has(value) || value === prefix) continue;
          seen.add(value);
          const symbol = manager.projectSymbols.find(item => item.name === value);
          items.push({
            caption: value,
            value,
            meta: symbol?.type || (R_KEYWORDS.includes(value) ? 'keyword' : 'word'),
            score: symbol ? 1300 : R_KEYWORDS.includes(value) ? 1200 : 900,
            docHTML: symbol ? `<strong>${escapeHtml(value)}</strong><br>${escapeHtml(symbol.detail || symbol.type)}` : undefined
          });
          if (items.length >= 300) break;
        }
        callback(null, items);
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
        if (cached && Date.now() - cached.timestamp < 5000) {
          return callback(null, cached.values);
        }
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
                .map(value => ({ caption: value, value, meta: manager.typeMetaFor(value), score: 1100 }));
              manager.completionCache.set(cacheKey, { timestamp: Date.now(), values: items });
              if (manager.completionCache.size > 120) manager.completionCache.delete(manager.completionCache.keys().next().value);
              finish(null, items);
            })
            .catch(() => finish(null, []))
            .finally(() => {
              if (manager.completionCallback === finish) manager.completionCallback = null;
            });
        }, 110);
      }
    };

    // Ace falls back to a global completer registry unless an editor-specific
    // list is provided. Keep the editor and console isolated from each other.
    this.editor.completers = [localCompleter, runtimeCompleter, languageTools.textCompleter].filter(Boolean);
  }

  cancelCompletionRequests() {
    this.completionRequest += 1;
    window.clearTimeout(this.completionTimer);
    this.completionTimer = 0;
    this.completionCallback?.(null, []);
    this.completionCallback = null;
  }

  typeMetaFor(name) {
    const environment = this.callbacks.getEnvironment?.() || [];
    const object = environment.find(item => item.name === name);
    return this.settings.typeHints && object ? object.className || object.type : 'R';
  }

  applySettings(settings) {
    this.settings = settings;
    if (this.fallbackMode) {
      this.fallback.style.tabSize = String(settings.tabSize);
      this.fallback.wrap = settings.wordWrap ? 'soft' : 'off';
      return;
    }
    this.editor.setFontSize(settings.fontSize);
    this.editor.setOption('fontFamily', settings.fontFamily);
    this.editor.setOption('highlightActiveLine', settings.highlightActiveLine);
    this.editor.setOption('wrap', settings.wordWrap);
    this.editor.setOption('showPrintMargin', settings.printMargin);
    this.editor.setOption('enableBasicAutocompletion', settings.autocomplete);
    this.editor.setOption('enableLiveAutocompletion', settings.autocomplete);
    this.editor.setOption('enableSnippets', settings.autocomplete);
    for (const { session } of this.sessions.values()) {
      session.setTabSize(settings.tabSize);
      session.setUseSoftTabs(true);
      session.setUseWrapMode(settings.wordWrap);
    }
    this.updateRainbowMarkers();
    this.runDiagnostics();
  }

  async setTheme(theme) {
    if (this.fallbackMode || !this.editor) return;
    try { await this.editor.setTheme(`ace/theme/${theme}`); }
    catch { await this.editor.setTheme('ace/theme/crimson_editor'); }
  }

  editorModeForPath(path) {
    const mode = aceModeFromPath(path);
    if (mode !== 'webr_rmarkdown') return `ace/mode/${mode}`;
    const Mode = existingAceModule(this.ace, R_MARKDOWN_MODE_ID)?.Mode;
    if (!Mode) throw new Error('The R Markdown editor mode is unavailable.');
    return new Mode();
  }

  addOrUpdateFile(file, { syncContent = false, createSession = false } = {}) {
    const previous = this.files.get(file.path);
    this.files.set(file.path, { ...previous, ...file });
    if (this.fallbackMode) return;
    const existing = this.sessions.get(file.path);
    if (existing) {
      existing.file = { ...existing.file, ...file };
      if (syncContent && existing.session.getValue() !== String(file.content || '')) {
        const active = this.activePath === file.path && this.editor?.session === existing.session;
        const cursor = active ? this.editor.getCursorPosition() : existing.cursor;
        const selection = active ? this.editor.getSelectionRange() : null;
        const scrollTop = active ? existing.session.getScrollTop() : existing.scrollTop;
        existing.session.setValue(String(file.content || ''), -1);
        if (active) {
          if (selection && !selection.isEmpty()) this.editor.selection.setRange(selection, false);
          else this.editor.moveCursorTo(cursor?.row || 0, cursor?.column || 0);
          existing.session.setScrollTop(scrollTop || 0);
        }
      } else {
        // The live Ace session is authoritative while a document is open.
        this.files.get(file.path).content = existing.session.getValue();
      }
      return;
    }
    if (!createSession) return;
    const session = this.ace.createEditSession(String(file.content || ''), this.editorModeForPath(file.path));
    session.setTabSize(this.settings.tabSize);
    session.setUseSoftTabs(true);
    session.setUseWrapMode(this.settings.wordWrap);
    session.setNewLineMode('unix');
    this.sessions.set(file.path, { session, file: { ...file }, cursor: { row: 0, column: 0 }, scrollTop: 0 });
  }

  removeFile(path) {
    const item = this.sessions.get(path);
    if (item && this.activePath === path) this.deactivate();
    if (item?.session === this.lintMarkerSession) this.clearDiagnostics();
    if (item?.session === this.rainbowMarkerSession) this.clearRainbowMarkers();
    if (item?.session === this.rMarkdownChunkMarkerSession) this.clearRMarkdownChunkMarkers();
    try { item?.session?.destroy?.(); } catch { /* Session disposal is best effort. */ }
    this.sessions.delete(path);
    this.files.delete(path);
  }

  renameFile(oldPath, newPath) {
    const file = this.files.get(oldPath);
    if (!file) return;
    this.files.delete(oldPath);
    file.path = newPath;
    this.files.set(newPath, file);
    if (!this.fallbackMode) {
      const item = this.sessions.get(oldPath);
      if (item) {
        this.sessions.delete(oldPath);
        item.file.path = newPath;
        item.session.setMode(this.editorModeForPath(newPath));
        this.sessions.set(newPath, item);
      }
    }
    if (this.activePath === oldPath) {
      this.activePath = newPath;
      this.updateRMarkdownChunkMarkers();
    }
  }

  open(path, { row, column } = {}) {
    const file = this.files.get(path);
    if (!file) return false;
    this.cancelCompletionRequests();
    if (this.activePath && !this.fallbackMode) {
      const current = this.sessions.get(this.activePath);
      if (current) {
        current.cursor = this.editor.getCursorPosition();
        current.scrollTop = this.editor.session.getScrollTop();
      }
    }
    this.activePath = path;
    if (this.fallbackMode) {
      this.fallback.readOnly = false;
      this.fallback.value = file.content || '';
      this.fallback.focus();
      return true;
    }
    if (!this.sessions.has(path)) this.addOrUpdateFile(file, { createSession: true });
    const item = this.sessions.get(path);
    this.editor.setReadOnly(false);
    this.editor.setSession(item.session);
    this.bindSessionScroll(item.session);
    const target = row == null ? item.cursor : { row, column: column || 0 };
    this.editor.moveCursorTo(target.row || 0, target.column || 0);
    this.editor.session.setScrollTop(row == null ? item.scrollTop || 0 : Math.max(0, (row - 3) * this.editor.renderer.lineHeight));
    this.editor.clearSelection();
    this.editor.focus();
    this.updateOutline();
    this.runDiagnostics();
    this.updateRainbowMarkers();
    this.updateRMarkdownChunkMarkers();
    return true;
  }

  deactivate() {
    if (this.activePath && !this.fallbackMode) {
      const current = this.sessions.get(this.activePath);
      if (current) {
        current.cursor = this.editor.getCursorPosition();
        current.scrollTop = current.session.getScrollTop();
      }
    }
    this.activePath = null;
    this.cancelCompletionRequests();
    this.parserLintToken += 1;
    this.lintDebounced.cancel();
    this.outlineDebounced.cancel();
    this.completionIndexDebounced.cancel();
    this.rainbowDebounced.cancel();
    this.rMarkdownChunksDebounced.cancel();
    this.clearDiagnostics();
    this.clearRainbowMarkers();
    this.clearRMarkdownChunkMarkers();
    this.outline = [];
    this.callbacks.onOutline?.([]);
    this.callbacks.onDiagnostics?.([]);
    if (this.fallbackMode) {
      this.fallback.value = '';
      this.fallback.readOnly = true;
      return;
    }
    if (this.dormantSession) this.editor.setSession(this.dormantSession);
    this.editor.setReadOnly(true);
  }

  bindSessionScroll(session) {
    if (session.$webrStudioScrollBound) return;
    session.$webrStudioScrollBound = true;
    session.on('changeScrollTop', this.rainbowDebounced);
  }

  getValue() {
    if (!this.activePath) return '';
    return this.fallbackMode ? this.fallback.value : this.editor.getValue();
  }

  setValue(value, path = this.activePath) {
    if (!path) return;
    const file = this.files.get(path);
    if (file) file.content = value;
    if (this.fallbackMode) {
      if (path === this.activePath) this.fallback.value = value;
    } else {
      this.addOrUpdateFile(file || { path, content: value }, { syncContent: true, createSession: true });
    }
  }

  getSelection() {
    if (this.fallbackMode) return this.fallback.value.slice(this.fallback.selectionStart, this.fallback.selectionEnd);
    return this.editor?.getSelectedText() || '';
  }

  getRunText() {
    const selection = this.getSelection();
    if (selection.trim()) return selection;
    if (this.fallbackMode) {
      const before = this.fallback.value.slice(0, this.fallback.selectionStart);
      const row = before.split('\n').length - 1;
      const column = this.fallback.selectionStart - before.lastIndexOf('\n') - 1;
      return currentRExpression(this.fallback.value, row, column).text;
    }
    const position = this.editor.getCursorPosition();
    return currentRExpression(this.editor.getValue(), position.row, position.column).text;
  }

  getSymbolAtCursor() {
    if (this.fallbackMode) {
      const value = this.fallback.value;
      let start = this.fallback.selectionStart;
      let end = start;
      while (start > 0 && /[A-Za-z0-9._]/.test(value[start - 1])) start -= 1;
      while (end < value.length && /[A-Za-z0-9._]/.test(value[end])) end += 1;
      return value.slice(start, end);
    }
    return symbolAt(this.editor);
  }

  insertText(text) {
    if (this.fallbackMode) {
      const start = this.fallback.selectionStart;
      const end = this.fallback.selectionEnd;
      this.fallback.setRangeText(text, start, end, 'end');
      this.fallback.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    this.editor.insert(text);
  }

  insertPipe() {
    const pipe = this.settings.pipe || '|>';
    if (this.fallbackMode) return this.insertText(` ${pipe} `);
    const position = this.editor.getCursorPosition();
    const line = this.editor.session.getLine(position.row);
    const before = line.slice(0, position.column);
    const after = line.slice(position.column);
    const prefix = before && !/\s$/.test(before) ? ' ' : '';
    const suffix = after && !/^\s/.test(after) ? ' ' : ' ';
    this.editor.insert(`${prefix}${pipe}${suffix}`);
  }

  smartIndent() {
    const tabSize = Number(this.settings.tabSize) || 2;
    if (this.fallbackMode) {
      const start = this.fallback.selectionStart;
      const end = this.fallback.selectionEnd;
      this.fallback.value = smartIndentR(this.fallback.value, tabSize);
      this.fallback.setSelectionRange(Math.min(start, this.fallback.value.length), Math.min(end, this.fallback.value.length));
      this.fallback.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const Range = this.ace.require('ace/range').Range;
    const selection = this.editor.getSelectionRange();
    const hasSelection = !selection.isEmpty();
    const cursor = this.editor.getCursorPosition();
    const scrollTop = this.editor.session.getScrollTop();
    const startRow = hasSelection ? selection.start.row : 0;
    const endRow = hasSelection ? selection.end.row : this.editor.session.getLength() - 1;
    const oldLines = this.editor.session.getLines(startRow, endRow);
    const source = oldLines.join('\n');
    const formatted = smartIndentR(source, tabSize);
    const newLines = formatted.split('\n');
    const preserveColumn = (row, column) => {
      const localRow = Math.max(0, Math.min(oldLines.length - 1, row - startRow));
      const oldIndent = oldLines[localRow]?.match(/^\s*/)?.[0].length || 0;
      const newIndent = newLines[localRow]?.match(/^\s*/)?.[0].length || 0;
      return Math.max(0, newIndent + Math.max(0, column - oldIndent));
    };
    this.editor.session.replace(new Range(startRow, 0, endRow, this.editor.session.getLine(endRow).length), formatted);
    if (hasSelection) {
      const lastRow = startRow + newLines.length - 1;
      this.editor.selection.setRange(new Range(
        selection.start.row,
        Math.min(preserveColumn(selection.start.row, selection.start.column), this.editor.session.getLine(selection.start.row).length),
        Math.min(selection.end.row, lastRow),
        Math.min(preserveColumn(selection.end.row, selection.end.column), this.editor.session.getLine(Math.min(selection.end.row, lastRow)).length)
      ), false);
    } else {
      const targetRow = Math.min(cursor.row, startRow + newLines.length - 1);
      this.editor.moveCursorTo(targetRow, Math.min(preserveColumn(cursor.row, cursor.column), this.editor.session.getLine(targetRow).length));
      this.editor.clearSelection();
    }
    this.editor.session.setScrollTop(scrollTop);
  }

  undo() { if (this.fallbackMode) document.execCommand('undo'); else this.editor?.undo(); }
  redo() { if (this.fallbackMode) document.execCommand('redo'); else this.editor?.redo(); }
  findReplace() { if (this.fallbackMode) return; this.editor.execCommand('replace'); }
  focus() { (this.fallbackMode ? this.fallback : this.editor)?.focus(); }

  jumpTo(path, row = 0, column = 0) {
    this.callbacks.onOpenFile?.(path, { row, column });
  }

  jumpToDefinition(symbol = this.getSymbolAtCursor()) {
    symbol = String(symbol || '').trim();
    if (!symbol) return this.callbacks.onNotify?.('No symbol under the cursor.');
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`^\\s*${escaped}\\s*(?:<-|<<-|=)\\s*function\\b`),
      new RegExp(`^\\s*${escaped}\\s*(?:<-|<<-)`),
      new RegExp(`^\\s*${escaped}\\s*=\\s*`)
    ];
    for (const [path, file] of this.files) {
      const lines = String(file.content || '').split('\n');
      const row = lines.findIndex(line => patterns.some(pattern => pattern.test(stripRCommentsAndStrings(line).text)));
      if (row >= 0) {
        this.callbacks.onOpenFile?.(path, { row, column: Math.max(0, lines[row].indexOf(symbol)) });
        return;
      }
    }
    this.callbacks.onNotify?.(`No project definition found for ${symbol}.`);
  }

  updateOutline(reindex = true) {
    if (!this.activePath) return;
    this.outline = outlineFromSource(this.getValue(), this.activePath);
    this.callbacks.onOutline?.(this.outline);
    if (reindex) this.rebuildProjectIndex();
  }

  rebuildProjectIndex() {
    const symbols = [];
    for (const [path, file] of this.files) {
      if (!['r', 'rmd', 'md', 'markdown'].includes(extname(path))) continue;
      const source = String(file.content || '');
      if (source.length > 2_000_000) continue;
      for (const item of outlineFromSource(source, path)) symbols.push({ ...item, path });
    }
    this.projectSymbols = symbols;
    const words = new Set();
    for (const file of this.files.values()) {
      if (!['r', 'rmd'].includes(extname(file.path))) continue;
      const source = String(file.content || '');
      if (source.length > 2_000_000) continue;
      const clean = stripRCommentsAndStrings(source).text;
      for (const match of clean.matchAll(/\b[A-Za-z.][A-Za-z0-9._]{2,}\b/g)) {
        words.add(match[0]);
        if (words.size >= 1200) break;
      }
      if (words.size >= 1200) break;
    }
    this.completionWords = [...words];
  }

  async runDiagnostics() {
    const token = ++this.parserLintToken;
    if (!this.activePath || !this.settings.lint || !['r', 'rmd'].includes(extname(this.activePath))) {
      this.clearDiagnostics();
      this.callbacks.onDiagnostics?.([]);
      return;
    }
    const source = this.getValue();
    if (source.length > 1_000_000) {
      const diagnostic = {
        row: 0,
        column: 0,
        endColumn: 1,
        severity: 'suggestion',
        message: 'Live linting is paused for files larger than 1 MB to keep editing responsive.',
        source: 'performance/large-file'
      };
      this.applyDiagnostics([diagnostic]);
      this.callbacks.onDiagnostics?.([diagnostic]);
      return;
    }
    let diagnostics = staticDiagnostics(source, this.activePath);
    this.applyDiagnostics(diagnostics);
    this.callbacks.onDiagnostics?.(diagnostics);
    if (!this.engine?.ready || this.engine.running || !['r', 'rmd'].includes(extname(this.activePath)) || source.length > 500_000) return;
    let parserDiagnostic = null;
    for (const unit of rParserUnits(source, this.activePath)) {
      if (!unit.code.trim()) continue;
      const found = await this.engine.parseDiagnostic(unit.code).catch(() => null);
      if (found) {
        parserDiagnostic = { ...found, row: found.row + unit.rowOffset };
        break;
      }
    }
    if (token !== this.parserLintToken || source !== this.getValue()) return;
    if (parserDiagnostic) diagnostics = [parserDiagnostic, ...diagnostics];
    this.applyDiagnostics(diagnostics);
    this.callbacks.onDiagnostics?.(diagnostics);
  }

  clearDiagnostics() {
    if (this.fallbackMode || !this.editor) return;
    const session = this.lintMarkerSession || this.editor.session;
    session?.setAnnotations?.([]);
    this.lintMarkers.forEach(marker => session?.removeMarker?.(marker));
    this.lintMarkers = [];
    this.lintMarkerSession = null;
  }

  applyDiagnostics(diagnostics) {
    if (this.fallbackMode || !this.editor) return;
    const Range = this.ace.require('ace/range').Range;
    this.clearDiagnostics();
    this.lintMarkerSession = this.editor.session;
    this.editor.session.setAnnotations(diagnostics.map(diagnostic => ({
      row: diagnostic.row,
      column: diagnostic.column,
      type: diagnostic.severity === 'suggestion' ? 'info' : diagnostic.severity,
      text: `${diagnostic.message} [${diagnostic.source}]`
    })));
    for (const diagnostic of diagnostics.slice(0, 250)) {
      if (diagnostic.severity === 'suggestion') continue;
      const className = diagnostic.severity === 'error' ? 'lint-error' : 'lint-warning';
      this.lintMarkers.push(this.editor.session.addMarker(
        new Range(diagnostic.row, diagnostic.column, diagnostic.row, diagnostic.endColumn || diagnostic.column + 1),
        className,
        'text',
        false
      ));
    }
  }

  applyQuickFix(diagnostic) {
    if (!diagnostic?.replacement && diagnostic?.replacement !== '') return false;
    if (this.fallbackMode) return false;
    const Range = this.ace.require('ace/range').Range;
    this.editor.session.replace(new Range(diagnostic.row, diagnostic.column, diagnostic.row, diagnostic.endColumn), diagnostic.replacement);
    return true;
  }

  clearRMarkdownChunkMarkers() {
    const session = this.rMarkdownChunkMarkerSession || this.editor?.session;
    this.rMarkdownChunkMarkers.forEach(marker => session?.removeMarker?.(marker));
    this.rMarkdownChunkMarkers = [];
    this.rMarkdownChunkMarkerSession = null;
  }

  updateRMarkdownChunkMarkers() {
    if (this.fallbackMode || !this.editor) return;
    this.clearRMarkdownChunkMarkers();
    if (!this.activePath || extname(this.activePath) !== 'rmd') return;
    const ranges = rMarkdownChunkRanges(this.editor.getValue());
    if (!ranges.length) return;
    const Range = this.ace.require('ace/range').Range;
    this.rMarkdownChunkMarkerSession = this.editor.session;
    for (const { startRow, endRow } of ranges) {
      const endColumn = this.editor.session.getLine(endRow)?.length || 0;
      this.rMarkdownChunkMarkers.push(this.editor.session.addMarker(
        new Range(startRow, 0, endRow, endColumn),
        'rmarkdown-chunk-background',
        'fullLine',
        false
      ));
    }
  }

  clearRainbowMarkers() {
    const session = this.rainbowMarkerSession || this.editor?.session;
    this.rainbowMarkers.forEach(marker => session?.removeMarker?.(marker));
    this.rainbowMarkers = [];
    this.rainbowMarkerSession = null;
  }

  updateRainbowMarkers() {
    if (this.fallbackMode || !this.editor) return;
    this.clearRainbowMarkers();
    if (!this.settings.rainbowDelimiters) return;
    this.rainbowMarkerSession = this.editor.session;
    const Range = this.ace.require('ace/range').Range;
    const first = Math.max(0, this.editor.renderer.getFirstVisibleRow() - 80);
    const last = Math.min(this.editor.session.getLength() - 1, this.editor.renderer.getLastVisibleRow() + 80);
    const lines = this.editor.session.getLines(first, last);
    const stack = [];
    const pairs = { ')': '(', ']': '[', '}': '{' };
    let quote = null;
    let escaped = false;
    let markerCount = 0;
    for (let offset = 0; offset < lines.length; offset += 1) {
      const line = lines[offset];
      let comment = false;
      for (let column = 0; column < line.length; column += 1) {
        const character = line[column];
        if (comment) break;
        if (quote) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === quote) quote = null;
          continue;
        }
        if (character === '#') { comment = true; continue; }
        if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
        if ('([{'.includes(character)) {
          const depth = stack.length % 5;
          stack.push(character);
          this.rainbowMarkers.push(this.editor.session.addMarker(new Range(first + offset, column, first + offset, column + 1), `rainbow-delimiter-${depth}`, 'text', false));
          markerCount += 1;
        } else if (')]}'.includes(character)) {
          const depth = Math.max(0, stack.length - 1) % 5;
          if (stack.at(-1) === pairs[character]) stack.pop();
          this.rainbowMarkers.push(this.editor.session.addMarker(new Range(first + offset, column, first + offset, column + 1), `rainbow-delimiter-${depth}`, 'text', false));
          markerCount += 1;
        }
        if (markerCount >= 1500) return;
      }
    }
  }

  getExpressionState() {
    return expressionState(this.getValue());
  }

  getCursor() {
    if (this.fallbackMode) {
      const before = this.fallback.value.slice(0, this.fallback.selectionStart);
      return { row: before.split('\n').length - 1, column: this.fallback.selectionStart - before.lastIndexOf('\n') - 1 };
    }
    return this.editor?.getCursorPosition() || { row: 0, column: 0 };
  }

  resize() { this.editor?.resize(true); }

  static async highlightR(code, themeName = 'crimson_editor') {
    if (!globalThis.ace) return `<code>${escapeHtml(code)}</code>`;
    try {
      const ace = globalThis.ace;
      ace.config.set('basePath', ACE_CDN);
      const highlighter = await new Promise(resolve => ace.config.loadModule('ace/ext/static_highlight', resolve));
      const highlighted = await new Promise((resolve, reject) => {
        try {
          highlighter.render(
            code,
            'ace/mode/r',
            `ace/theme/${themeName || 'crimson_editor'}`,
            1,
            true,
            resolve
          );
        } catch (error) {
          reject(error);
        }
      });
      return highlighted.html;
    } catch {
      return `<code>${escapeHtml(code)}</code>`;
    }
  }
}

export {
  assignmentEqualsPositions, defineRMarkdownMode, outlineFromSource, rMarkdownChunkRanges, rMarkdownCode,
  rParserUnits, staticDiagnostics, symbolAt
};
