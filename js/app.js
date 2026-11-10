import {
  APP_VERSION, DEFAULT_SETTINGS, MAX_EDITOR_BYTES, MAX_FILE_BYTES,
  MAX_URL_STATE_CHARS, SAMPLE_FILES, WEBR_VERSION_SUGGESTIONS, normalizeWebRVersion
} from './config.js?v=1.6.0';
import { workspaceDB } from './db.js?v=1.6.0';
import {
  WebREngine, describeRuntime, environmentTypeLabel, explicitVirtualPath, normalizeVirtualPath,
  projectRelativePath, stripTerminalControlSequences
} from './webr-engine.js?v=1.6.0';
import { EditorManager } from './editor.js?v=1.6.0';
import { ConsoleManager } from './console.js?v=1.6.0';
import { DataViewer } from './data-viewer.js?v=1.6.0';
import { createGist, importGist } from './gist.js?v=1.6.0';
import { UI } from './ui.js?v=1.6.0';
import { TailscaleNetwork } from './network.js?v=1.6.0';
import { NetworkBridge } from './network-bridge.js?v=1.6.0';
import { NetworkUI } from './network-ui.js?v=1.6.0';
import {
  evaluateInlineRMarkdown, gfmBundleFiles, gfmDocumentStem, RMarkdownGfmBuilder
} from './rmd-gfm.js?v=1.6.0';
import {
  $, $$, basename, base64UrlToBytes, bytesToBase64Url, clamp, copyText, createZip,
  debounce, decodeFileText, decodeWorkspaceState, dirname, downloadBlob, downloadText,
  encodeWorkspaceState, ensureFontLoaded, escapeHtml, extname, extractHelpRequest, formatBytes,
  formatDate, idle, isDataPath, isPreviewable, localTimestampName,
  makeUniqueName, mimeFromPath, mistralCodeUrl, normalizePath, rasterizeSvg,
  readFileAsBytes, renderMarkdown, renderMathInElement, safeOpen, sanitizeHtml,
  resolveRMarkdownFigureOptions, sanitizeSvg, splitRMarkdown, textEncodingFromBOM, uid
} from './utils.js?v=1.6.0';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const NEW_RMD_TEMPLATE = `---
title: "Untitled"
output: html_document
---

`;


const DOCUMENT_EXPORT_CSS = `
:root{color-scheme:light;--ink:#18181b;--muted:#62636a;--border:#d9d9de;--soft:#f6f6f8;--accent:#9f1239;--danger:#b42336;--warning:#8a4b08}
*{box-sizing:border-box}html{background:#f1f1f3}body{margin:0;color:var(--ink);font:16px/1.68 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.document{width:min(960px,calc(100% - 32px));margin:32px auto;padding:48px 56px;background:#fff;border:1px solid var(--border);border-radius:14px;box-shadow:0 18px 55px rgba(20,20,24,.08)}
h1,h2,h3,h4,h5,h6{margin:1.35em 0 .55em;line-height:1.22;letter-spacing:-.025em}h1{margin-top:0;font-size:2.15em}h2{padding-bottom:.28em;border-bottom:1px solid var(--border);font-size:1.62em}h3{font-size:1.3em}
p{margin:.8em 0}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}strong{font-weight:720}em{font-style:italic}
ul,ol{margin:.75em 0;padding-left:1.7em}li+li{margin-top:.25em}blockquote{margin:1em 0;padding:.25em 1em;border-left:4px solid var(--accent);color:var(--muted);background:#fff9fb}
hr{margin:1.8em 0;border:0;border-top:1px solid var(--border)}code,pre{font-family:"Ubuntu Mono","Cascadia Code",Consolas,monospace}code{padding:.12em .34em;border-radius:4px;background:var(--soft);font-size:.92em}pre{overflow:auto;margin:1em 0;padding:14px 16px;border:1px solid var(--border);border-radius:8px;background:var(--soft);font-size:13px;line-height:1.5}pre code{padding:0;background:transparent}
table{width:100%;margin:1em 0;border-collapse:collapse}th,td{padding:8px 10px;border:1px solid var(--border);text-align:left;vertical-align:top}th{background:var(--soft);font-weight:680}
img,svg{display:block;max-width:100%;height:auto;margin-inline:auto}.math-display{margin:1.1em 0;overflow-x:auto;overflow-y:hidden;text-align:center}.math-inline{display:inline-block;vertical-align:-.08em}math{font-size:1.04em}
.r-chunk{margin:16px 0;border:1px solid var(--border);border-radius:9px;overflow:hidden}.r-chunk-header{display:flex;justify-content:space-between;gap:12px;padding:7px 10px;background:var(--soft);color:var(--muted);font-size:11px;font-weight:650}.r-chunk-source{margin:0;border:0;border-radius:0}.r-chunk-output{overflow:auto;margin:0;padding:8px 11px;border:0;border-top:1px solid var(--border);border-radius:0;white-space:pre;overflow-wrap:normal;tab-size:4;font:13px/1.35 "Ubuntu Mono","Cascadia Code",Consolas,monospace}.r-chunk-output.output-error{color:var(--danger);background:#fff3f4}.r-chunk-output.output-warning{color:var(--warning);background:#fff8ec}.r-chunk-output.output-message,.r-chunk-output.output-traceback{color:#334155;background:#f8fafc}.r-chunk-plot{margin:0;padding:12px;border-top:1px solid var(--border);background:#fff}.r-chunk-asis{padding:8px 11px;border-top:1px solid var(--border);background:#fff}.r-chunk-asis>:first-child{margin-top:0}.r-chunk-asis>:last-child{margin-bottom:0}.r-chunk-plot{display:block;box-sizing:border-box;width:auto;max-width:100%}.r-chunk-plot.align-left{margin-right:auto;margin-left:0}.r-chunk-plot.align-center{margin-right:auto;margin-left:auto}.r-chunk-plot.align-right{margin-right:0;margin-left:auto}.r-chunk-plot svg,.r-chunk-plot img{display:block;width:100%;max-width:100%;height:auto;margin:0 auto}.r-chunk-plot.has-output-height svg,.r-chunk-plot.has-output-height img{height:100%;object-fit:contain}.r-chunk-plot figcaption{margin-top:7px;color:var(--muted);font-size:12px;line-height:1.45;text-align:center}.r-plot-svg{color:#000;fill:#000;stroke:none;stroke-width:1;stroke-linecap:butt;stroke-linejoin:miter}.inline-r-output{display:inline;padding:0 .12em;border-radius:3px;background:#fff3f7}.inline-r-error{display:inline;padding:0 .2em;border-radius:3px;color:var(--danger);background:#fff1f2;font:13px "Ubuntu Mono","Cascadia Code",Consolas,monospace}.render-notice{margin:0 0 1em;padding:10px 12px;border:1px solid #f4c26b;border-radius:8px;background:#fff8e8;color:#6f4200}.missing-asset{display:block;padding:10px;border:1px dashed var(--border);color:var(--muted);background:var(--soft)}.embedded-svg{display:block;max-width:100%}
.ace_keyword,.ace_storage,.ace_support.ace_type{color:#9f1239;font-weight:650}.ace_string{color:#34743f}.ace_comment{color:#777;font-style:italic}.ace_constant.ace_numeric{color:#1d5d9a}.ace_support.ace_function,.ace_entity.ace_name.ace_function{color:#075c73}.ace_variable{color:#3c315e}
@media(max-width:720px){html{background:#fff}.document{width:100%;margin:0;padding:28px 20px;border:0;border-radius:0;box-shadow:none}h1{font-size:1.75em}h2{font-size:1.42em}}
@media print{html{background:#fff}.document{width:100%;margin:0;padding:0;border:0;box-shadow:none}a{color:inherit}}
`;

function bytesToDataUrl(bytes, mime = 'application/octet-stream') {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let binary = '';
  for (let offset = 0; offset < input.length; offset += 0x8000) {
    binary += String.fromCharCode(...input.subarray(offset, offset + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function parseViewPayload(text = '') {
  const [encodedName = '', encodedTitle = ''] = String(text).split('|', 2);
  try {
    return { name: decodeURIComponent(encodedName), title: decodeURIComponent(encodedTitle) || decodeURIComponent(encodedName) };
  } catch {
    return { name: encodedName, title: encodedTitle || encodedName };
  }
}

function conciseRVersion(value = '') {
  const text = String(value || '').trim();
  const match = text.match(/(?:R version\s+)?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/i);
  return match?.[1] || text.replace(/^R\s+/i, '');
}

function splitDocumentFrontMatter(source = '') {
  const text = String(source).replace(/^\uFEFF/, '');
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { body: text, title: '' };
  const titleLine = match[1].match(/^title\s*:\s*(.+?)\s*$/im);
  const title = titleLine ? titleLine[1].replace(/^['"]|['"]$/g, '') : '';
  return { body: text.slice(match[0].length), title };
}

function resolveProjectReference(baseDirectory = '', reference = '') {
  const clean = decodeURIComponent(String(reference).split(/[?#]/, 1)[0]).replaceAll('\\', '/');
  const parts = `${baseDirectory ? `${baseDirectory}/` : ''}${clean}`.split('/');
  const resolved = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  return normalizePath(resolved.join('/'));
}

function normalizeRemoteAssetUrl(reference = '') {
  try {
    const url = new URL(String(reference), location.href);
    if (url.protocol === 'http:' && location.protocol === 'https:') url.protocol = 'https:';
    return url.href;
  } catch {
    return String(reference || '');
  }
}

function svg(id, className = '') {
  const classes = ['ui-icon', className].filter(Boolean).join(' ');
  return `<svg class="${classes}" aria-hidden="true"><use href="#${id}"></use></svg>`;
}

function deepSettings(stored = {}) {
  const migrated = { ...stored };
  if (migrated.printMargin == null && migrated.minimap != null) migrated.printMargin = Boolean(migrated.minimap);
  try { migrated.webrVersion = normalizeWebRVersion(migrated.webrVersion); }
  catch { migrated.webrVersion = DEFAULT_SETTINGS.webrVersion; }
  delete migrated.minimap;
  return {
    ...DEFAULT_SETTINGS,
    ...migrated,
    dockPanels: {
      ...DEFAULT_SETTINGS.dockPanels,
      ...(migrated.dockPanels || {})
    },
    activeDock: {
      ...DEFAULT_SETTINGS.activeDock,
      ...(migrated.activeDock || {})
    }
  };
}

function fileRecord(record) {
  const original = typeof record.content === 'string'
    ? record.content
    : ArrayBuffer.isView(record.content)
      ? new Uint8Array(record.content.buffer, record.content.byteOffset, record.content.byteLength)
      : new Uint8Array(record.content || []);
  const size = typeof original === 'string' ? textEncoder.encode(original).byteLength : original.byteLength;
  // Decode only files that fit the editor. Accepted UTF-8 text (including its
  // BOM) is byte-for-byte reversible; other file contents stay untouched.
  const text = size <= MAX_EDITOR_BYTES ? decodeFileText(original) : null;
  const content = text ?? (typeof original === 'string' && size <= MAX_EDITOR_BYTES ? textEncoder.encode(original) : original);
  const binary = typeof content !== 'string';
  return {
    path: projectRelativePath(record.path || 'untitled.R'),
    content,
    type: binary ? 'binary' : 'text',
    mime: record.mime || mimeFromPath(record.path),
    size,
    createdAt: record.createdAt || Date.now(),
    updatedAt: record.updatedAt || Date.now(),
    dirty: false,
    revision: Number(record.revision) || 0
  };
}

function isEditableFile(file) {
  if (!file || Number(file.size || 0) > MAX_EDITOR_BYTES) return false;
  return isTextFile(file);
}

function isTextFile(file) {
  return Boolean(file) && file.type === 'text' && typeof file.content === 'string';
}

class WebRStudioApp {
  constructor() {
    this.ui = new UI();
    this.network = new TailscaleNetwork();
    this.networkBridge = new NetworkBridge({ download: request => this.network.download(request) });
    this.engine = new WebREngine({ networkBridge: this.networkBridge });
    this.engine.addEventListener('network', event => {
      this.network.setBridgeReady(event.detail.ready, event.detail.error?.message || '');
    });
    this.network.addEventListener('change', event => {
      this.networkBridge.required = event.detail.mode !== 'browser';
    });
    this.networkUI = new NetworkUI(this.network, {
      toast: (title, message, type) => this.ui.toast(title, message, type)
    });
    window.addEventListener('pagehide', () => this.network.disconnect());
    this.settings = deepSettings();
    this.files = new Map();
    this.openTabs = [];
    this.activePath = null;
    this.selectedFiles = new Set();
    this.expandedFolders = new Set();
    this.folderExpansionInitialized = false;
    this.environment = [];
    this.packages = [];
    this.diagnostics = [];
    this.outline = [];
    this.plots = [];
    this.plotIndex = -1;
    this.snapshots = [];
    this.consoleState = { history: [], transcript: [], draft: '' };
    this.editor = null;
    this.console = null;
    this.dataViewer = null;
    this.assistant = null;
    this.assistantPromise = null;
    this.runtimeAvailable = false;
    this.initialized = false;
    this.currentFocus = 'editor';
    this.helpHistory = [];
    this.helpHistoryIndex = -1;
    this.currentHelpTopic = '';
    this.currentHelpPackage = '';
    this.previewObjectUrls = [];
    this.rMarkdownGfmArtifact = null;
    this.currentPlotUrl = '';
    this.plotResizeObserver = null;
    this.lastPlotDeviceSize = null;
    this.lastPlotViewerRect = null;
    this.pendingPlotReflow = false;
    this.maximizedPaneId = '';
    this.previewPath = '';
    this.environmentError = '';
    this.runtimeFilesPath = '/project';
    this.runtimeFiles = [];
    this.runtimeProjectFiles = new Map();
    this.runtimeFilesError = '';
    this.runtimeFilesLoading = false;
    this.runtimeFilesRefreshPending = true;
    this.runtimeFilesRequest = 0;
    this.pendingMirrors = new Set();
    this.pendingMirrorDeletes = new Set();
    this.fileSaveQueues = new Map();
    this.deletingFiles = new Set();
    this.syncingRuntimeFiles = new Set();
    this.fileMutationPending = false;
    this.mirrorOperationQueue = Promise.resolve();
    this.projectDirectories = new Set();
    this.runtimeKnownFiles = new Set();
    this.projectPersistenceReady = false;
    this.projectPersistencePending = false;
    this.projectPersistenceError = '';
    this.projectSnapshotInProgress = false;
    this.projectPersistenceEpoch = 0;
    this.projectRuntimeRevision = 0;
    this.erasingLocalData = false;
    this.commandItems = [];
    this.commandSelection = 0;
    this.persistWorkspaceDebounced = debounce(() => this.persistWorkspaceMeta(), 350);
    this.persistSettingsDebounced = debounce(() => workspaceDB.set('settings', this.settings), 300);
    this.checkpointDebounced = debounce(() => this.saveRCheckpoint(), 900);
    this.environmentDebounced = debounce(() => this.refreshEnvironment(), 240);
    this.packageFilterDebounced = debounce(() => this.renderPackages(), 100);
    this.searchDebounced = debounce(() => this.searchWorkspace(), 180);
    this.gistTokenDebounced = debounce(() => this.persistGistToken(), 300);
    this.autosaveDebounced = debounce(() => this.saveDirtyFiles(), this.settings.autosaveDelay);
    this.projectBackupDebounced = debounce(() => {
      if (this.projectPersistenceReady && !this.erasingLocalData) {
        this.refreshRuntimeFiles(this.runtimeFilesPath, { quiet: true });
      }
    }, 350);
    this.plotResizeDebounced = debounce(() => {
      this.syncPlotDeviceToViewer({ reflowCurrent: true }).catch(error => console.warn('Could not resize the R plot device:', error));
    }, 180);
    this.systemTheme = matchMedia('(prefers-color-scheme: dark)');
    this.bootSkipped = false;
  }

  async start() {
    try {
      this.setBoot(5, 'Opening local workspace…');
      await workspaceDB.open();
      await workspaceDB.persist().catch(() => false);
      await this.loadPersistentState();
      await this.restoreLocationState();
      this.applyAppearance();
      this.bindStaticEvents();
      await this.initializeWorkbench();
      this.initialized = true;
      this.renderAll();
      this.setBoot(18, 'Preparing the editor and console…');
      window.setTimeout(() => { if (!this.runtimeAvailable && !this.bootSkipped) $('#boot-skip').hidden = false; }, 4500);
      await this.initializeRuntime();
    } catch (error) {
      console.error(error);
      this.showWorkbench();
      this.setRuntimeState('error', 'R unavailable');
      this.ui.toast('Workspace opened without R', error.message || String(error), 'error', 0);
    }
  }

  async loadPersistentState() {
    const [storedSettings, records, workspace, snapshots, token, directories] = await Promise.all([
      workspaceDB.get('settings', {}),
      workspaceDB.listFiles(),
      workspaceDB.get('workspace', {}),
      workspaceDB.listSnapshots(),
      workspaceDB.get('gistToken', ''),
      workspaceDB.get('projectDirectories', [])
    ]);
    this.settings = deepSettings(storedSettings);
    this.autosaveDebounced = debounce(() => this.saveDirtyFiles(), this.settings.autosaveDelay);
    for (const record of records) this.files.set(record.path, fileRecord(record));
    this.projectDirectories = new Set((Array.isArray(directories) ? directories : []).map(projectRelativePath));
    this.openTabs = (workspace.openTabs || []).filter(path => this.files.has(path));
    this.activePath = this.files.has(workspace.activePath) ? workspace.activePath : this.openTabs[0] || null;
    this.consoleState = {
      history: workspace.consoleHistory || [],
      transcript: workspace.consoleTranscript || [],
      draft: workspace.consoleDraft || ''
    };
    this.plots = Array.isArray(workspace.plots) ? workspace.plots.slice(-30) : [];
    this.plotIndex = this.plots.length ? this.plots.length - 1 : -1;
    this.expandedFolders = new Set(workspace.expandedFolders || []);
    this.folderExpansionInitialized = Array.isArray(workspace.expandedFolders);
    this.snapshots = snapshots;
    if (token) {
      this.settings.gistTokenPersisted = true;
      window.setTimeout(() => {
        $('#gist-token').value = token;
        $('#persist-gist-token').checked = true;
      });
    }
  }

  async restoreLocationState() {
    const query = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const encoded = hash.get('workspace') || query.get('workspace');
    const snapshotId = hash.get('snapshot') || query.get('snapshot');
    if (encoded) {
      this.setBoot(10, 'Restoring workspace from URL…');
      const state = await decodeWorkspaceState(encoded);
      await this.applyWorkspaceState(state, { persist: true, live: false });
      return;
    }
    if (snapshotId) {
      const snapshot = this.snapshots.find(item => item.id === snapshotId);
      if (snapshot?.state) await this.applyWorkspaceState(snapshot.state, { persist: true, live: false });
    }
  }

  async initializeWorkbench() {
    this.editor = new EditorManager({
      host: $('#editor'),
      fallback: $('#fallback-editor'),
      engine: this.engine,
      settings: this.settings,
      callbacks: {
        onChange: (path, content) => this.onEditorChange(path, content),
        onCursor: position => this.updateCursorStatus(position),
        onOutline: outline => { this.outline = outline; this.renderOutline(); },
        onDiagnostics: diagnostics => { this.diagnostics = diagnostics.map(item => ({ ...item, path: this.activePath })); this.renderProblems(); },
        onRunSelection: code => this.executeCode(code, { echo: true }),
        onRunScript: () => this.sourceActiveFile({ echo: false }),
        onSuggest: () => this.showAssistant({ suggest: true, target: 'editor' }),
        onHelp: topic => this.openHelp(topic),
        onSave: path => this.saveFile(path),
        onOpenFile: (path, position) => this.openFile(path, position),
        onNotify: message => this.ui.toast('Editor', message, 'info'),
        onFallback: error => this.ui.toast('Basic editor mode', error.message, 'warning', 0),
        getEnvironment: () => this.environment,
        onFocus: focus => { this.currentFocus = focus; }
      }
    });
    await this.editor.initialize();
    for (const file of this.files.values()) if (isEditableFile(file)) this.editor.addOrUpdateFile(file);

    this.console = new ConsoleManager({
      host: $('#console-input'),
      fallback: $('#fallback-console'),
      output: $('#console-output'),
      prompt: $('#console-prompt'),
      inputRequest: $('#console-input-request'),
      inputMessage: $('#console-input-message'),
      inputError: $('#console-input-error'),
      runButton: $('#console-run-button'),
      engine: this.engine,
      settings: this.settings,
      callbacks: {
        onSubmit: code => this.executeCode(code, { echo: false }),
        onSuggest: () => this.showAssistant({ suggest: true, target: 'console' }),
        onHistoryChange: history => {
          this.consoleState.history = history;
          if (!this.erasingLocalData) this.persistWorkspaceDebounced();
        },
        onTranscriptChange: transcript => {
          this.consoleState.transcript = transcript;
          if (!this.erasingLocalData) this.persistWorkspaceDebounced();
        },
        onDraftChange: draft => {
          this.consoleState.draft = draft;
          if (!this.erasingLocalData) this.persistWorkspaceDebounced();
        },
        onPlot: plot => this.addPlot(plot),
        onHelp: topic => this.openHelp(topic),
        onNotify: message => this.ui.toast('R console', message, 'warning'),
        onFocus: focus => { this.currentFocus = focus; },
        getEnvironment: () => this.environment
      }
    });
    await this.console.initialize(this.consoleState);

    this.dataViewer = new DataViewer({
      container: $('#data-viewer'),
      engine: this.engine,
      callbacks: {
        onTitle: title => { $('#panel-data').dataset.title = title; },
        onNotify: message => this.ui.toast('Data viewer', message, 'success'),
        onError: error => this.ui.toast('Data viewer error', error.message, 'error')
      }
    });

    this.applyAppearance();
    this.restoreDockLayout();
    this.openInitialFile();
    this.buildCommandItems();
    this.bindPlotResizing();
  }

  async initializeRuntime() {
    this.projectPersistenceReady = false;
    this.projectPersistenceEpoch += 1;
    this.fileMutationPending = true;
    this.setRuntimeState('loading', 'Starting R…');
    try {
      await this.engine.initialize({
        version: this.settings.webrVersion,
        plotWidth: this.settings.plotWidth,
        plotHeight: this.settings.plotHeight,
        onProgress: (progress, message) => this.setBoot(18 + progress * .66, message)
      });
      this.runtimeAvailable = true;
      this.setBoot(87, 'Mounting project files…');
      await this.restoreProjectFiles((done, total, path) => {
        this.setBoot(87 + (done / Math.max(1, total)) * 7, `Mounting ${path}…`);
      });
      if (this.settings.restoreEnvironment) {
        const checkpoint = await workspaceDB.get('rCheckpoint', null);
        if (checkpoint?.length || checkpoint?.byteLength) {
          this.setBoot(95, 'Restoring the R environment…');
          await this.engine.restoreEnvironment(checkpoint).catch(error => {
            this.ui.toast('Environment checkpoint skipped', error.message, 'warning');
          });
        }
      }
      this.projectPersistenceReady = true;
      this.fileMutationPending = false;
      await Promise.all([
        this.refreshEnvironment(),
        this.refreshPackages(),
        this.refreshRuntimeFiles('/project', { quiet: true })
      ]);
      this.setRuntimeState('ready', this.runtimeReadyLabel());
      this.setBoot(100, 'Ready');
      this.showWorkbench();
      this.lastPlotDeviceSize = null;
      this.lastPlotViewerRect = null;
      this.pendingPlotReflow = true;
      requestAnimationFrame(() => this.plotResizeDebounced());
      if (!globalThis.crossOriginIsolated) {
        this.ui.toast('Limited interrupt support', 'Stop cannot interrupt this PostMessage session. Reload once after the isolation service worker activates; the app will not restart R automatically.', 'warning', 9000);
      }
    } catch (error) {
      this.fileMutationPending = false;
      this.runtimeAvailable = false;
      this.setRuntimeState('error', 'R unavailable');
      this.showWorkbench();
      throw error;
    }
  }

  setBoot(progress, message) {
    $('#boot-progress-bar').style.width = `${clamp(progress, 0, 100)}%`;
    $('#boot-message').textContent = message;
  }

  showWorkbench() {
    this.bootSkipped = true;
    $('#app').hidden = false;
    $('#boot-screen').hidden = true;
    requestAnimationFrame(() => {
      this.editor?.resize();
      this.console?.resize();
      this.plotResizeDebounced();
    });
  }

  applyAppearance() {
    const root = document.documentElement;
    const resolved = this.settings.theme === 'system'
      ? (this.systemTheme.matches ? 'dark' : 'light')
      : this.settings.theme;
    root.dataset.theme = this.settings.theme;
    root.dataset.resolvedTheme = resolved;
    root.dataset.density = this.settings.density;
    root.style.setProperty('--code-font', `"${this.settings.fontFamily}", "Ubuntu Mono", Consolas, monospace`);
    root.style.setProperty('--code-size', `${this.settings.fontSize}px`);
    root.style.setProperty('--code-weight', String(this.settings.fontWeight));
    root.style.setProperty('--ligatures', this.settings.ligatures ? 'normal' : 'none');
    root.style.setProperty('--sidebar-width', `${this.settings.sidebarWidth}px`);
    root.style.setProperty('--right-width', `${this.settings.rightWidth}px`);
    root.style.setProperty('--console-ratio', `${this.settings.consoleHeight}%`);
    root.style.setProperty('--dock-ratio', `${this.settings.dockRatio}%`);
    ensureFontLoaded(this.settings.fontFamily);
    const editorTheme = resolved === 'dark' || resolved === 'high-contrast'
      ? (['monokai', 'dracula', 'tomorrow_night', 'one_dark', 'nord_dark'].includes(this.settings.editorTheme) ? this.settings.editorTheme : this.settings.darkEditorTheme)
      : this.settings.editorTheme;
    this.editor?.applySettings(this.settings);
    this.console?.applySettings(this.settings);
    this.editor?.setTheme(editorTheme);
    this.console?.setTheme(editorTheme);
    $('#theme-button use')?.setAttribute('href', resolved === 'light' ? '#i-sun' : '#i-moon');
    $('#theme-button').title = resolved === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
    $('#font-status').textContent = `${this.settings.fontFamily} ${this.settings.fontSize}`;
    $('#pipe-status').textContent = `Pipe: ${this.settings.pipe}`;
    $('#indent-mode-button').textContent = `Spaces: ${this.settings.tabSize}`;
    $('#timing-button').setAttribute('aria-pressed', String(this.settings.timing));
    $('#timing-toggle-setting').checked = this.settings.timing;
    this.syncSettingsControls();
  }

  resolveActiveFile() {
    return this.activePath ? this.files.get(this.activePath) : null;
  }

  bindStaticEvents() {
    const on = (selector, event, handler, options) => $(selector)?.addEventListener(event, handler, options);

    on('#boot-skip', 'click', () => this.showWorkbench());
    on('#new-file-button', 'click', event => this.showNewFileMenu(event.currentTarget));
    on('#sidebar-new-file', 'click', event => this.showNewFileMenu(event.currentTarget));
    on('#upload-button', 'click', () => $('#file-input').click());
    on('#sidebar-upload', 'click', () => $('#file-input').click());
    on('#sidebar-upload-folder', 'click', () => $('#folder-input').click());
    on('#save-button', 'click', () => this.saveFile(this.activePath));
    on('#download-button', 'click', () => this.downloadSelection());
    on('#sidebar-download-all', 'click', () => this.downloadWorkspaceZip());
    on('#undo-button', 'click', () => this.editor.undo());
    on('#redo-button', 'click', () => this.editor.redo());
    on('#find-button', 'click', () => this.editor.findReplace());
    on('#format-button', 'click', () => this.editor.smartIndent());
    on('#run-selection-button', 'click', () => this.executeCode(this.editor.getRunText(), { echo: true }));
    on('#run-script-button', 'click', () => this.sourceActiveFile({ echo: false }));
    on('#source-options-button', 'click', event => this.showSourceOptionsMenu(event.currentTarget));
    on('#stop-button', 'click', () => this.stopExecution());
    on('#restart-r-button', 'click', () => this.restartRuntime(true));
    on('#apply-webr-version', 'click', () => this.applyWebRVersion());
    on('#webr-version-input', 'keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.applyWebRVersion();
    });
    on('#check-code-button', 'click', () => this.checkCodeWithMistral());
    on('#assistant-editor-suggest', 'click', () => this.showAssistant({ suggest: true, target: 'editor' }));
    on('#assistant-console-suggest', 'click', () => this.showAssistant({ suggest: true, target: 'console' }));
    on('#timing-button', 'click', () => this.updateSetting('timing', !this.settings.timing));
    on('#theme-button', 'click', () => this.cycleTheme());
    on('#settings-button', 'click', () => this.openSettings());
    on('#activity-settings-button', 'click', () => this.openSettings());
    on('#share-url-button', 'click', () => this.shareWorkspaceUrl());
    on('#command-palette-button', 'click', () => this.openCommandPalette());
    on('#clear-console-button', 'click', () => this.console.clear());
    on('#console-run-button', 'click', event => {
      // A second click on Send must not run the restored command draft if R
      // consumes its response and finishes between the two click events.
      if (event.detail > 1) return;
      this.console.submit();
    });
    on('#preview-active-button', 'click', () => this.previewActiveFile());
    on('#refresh-preview-button', 'click', () => this.previewActiveFile());
    on('#open-preview-window', 'click', () => this.openPreviewWindow());
    on('#download-preview-html', 'click', () => this.downloadRenderedDocument());
    on('#download-preview-gfm', 'click', () => this.downloadRMarkdownGfmBundle());
    on('#environment-clean-button', 'click', () => this.clearEnvironment());
    on('#refresh-active-panel', 'click', () => this.refreshActiveTopPanel());
    on('#install-package-button', 'click', () => this.installPackage());
    on('#plot-previous', 'click', () => this.navigatePlot(-1));
    on('#plot-next', 'click', () => this.navigatePlot(1));
    on('#plot-export-button', 'click', () => this.exportCurrentPlot());
    on('#clear-plots-button', 'click', () => this.clearPlots());
    on('#export-panel-button', 'click', () => this.exportActivePanel());
    on('#help-search-button', 'click', () => this.openHelp($('#help-search').value));
    on('#help-search', 'keydown', event => { if (event.key === 'Enter') this.openHelp(event.target.value); });
    on('#help-back', 'click', () => this.navigateHelp(-1));
    on('#help-forward', 'click', () => this.navigateHelp(1));
    on('#layout-button', 'click', event => this.showLayoutMenu(event.currentTarget));
    on('#runtime-status-detail', 'click', () => this.showRuntimeInfo());
    on('#language-mode-button', 'click', () => this.ui.toast('Language mode', 'Language mode is inferred from the active file extension.', 'info'));
    on('#encoding-button', 'click', () => this.ui.toast('Text encoding', 'Project text files are read and written as UTF-8.', 'info'));
    on('#indent-mode-button', 'click', () => this.openSettings('editor'));
    on('#pipe-status', 'click', () => this.updateSetting('pipe', this.settings.pipe === '|>' ? '%>%' : '|>'));
    on('#font-status', 'click', () => this.openSettings('appearance'));
    on('#editor-more-button', 'click', event => this.showEditorActionsMenu(event.currentTarget));
    on('#dock-more-top', 'click', event => this.showDockOptionsMenu(event.currentTarget, 'top'));
    on('#dock-more-bottom', 'click', event => this.showDockOptionsMenu(event.currentTarget, 'bottom'));
    $$('[data-maximize-pane]').forEach(button => button.addEventListener('click', () => this.togglePaneMaximize(button.dataset.maximizePane)));

    on('#file-input', 'change', event => { this.uploadFiles([...event.target.files]); event.target.value = ''; });
    on('#folder-input', 'change', event => { this.uploadFiles([...event.target.files]); event.target.value = ''; });
    on('#workspace-json-input', 'change', event => { this.importWorkspaceJson(event.target.files[0]); event.target.value = ''; });
    on('#rdata-input', 'change', event => { this.importRData(event.target.files[0]); event.target.value = ''; });

    on('#export-workspace-json', 'click', () => this.exportWorkspaceJson());
    on('#import-workspace-json', 'click', () => $('#workspace-json-input').click());
    on('#export-rdata', 'click', () => this.exportRData());
    on('#import-rdata', 'click', () => $('#rdata-input').click());
    on('#new-snapshot-button', 'click', () => this.createSnapshot());

    on('#workspace-search-input', 'input', this.searchDebounced);
    on('#search-regex', 'change', () => this.searchWorkspace());
    on('#search-case', 'change', () => this.searchWorkspace());
    on('#environment-filter', 'input', () => this.renderEnvironment());
    on('#outline-filter', 'input', () => this.renderOutline());
    on('#package-filter', 'input', this.packageFilterDebounced);
    on('#runtime-files-up', 'click', () => this.refreshRuntimeFiles(this.runtimeFilesParent(this.runtimeFilesPath)));
    on('#runtime-files-home', 'click', () => this.refreshRuntimeFiles('/project'));
    on('#runtime-files-refresh', 'click', () => this.refreshRuntimeFiles(this.runtimeFilesPath));
    on('#sidebar-delete-files', 'click', () => this.deleteFiles([...this.selectedFiles]));
    on('#runtime-files-path', 'keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.refreshRuntimeFiles(normalizeVirtualPath(event.currentTarget.value));
    });

    on('#gist-token', 'input', this.gistTokenDebounced);
    on('#persist-gist-token', 'change', () => this.persistGistToken());
    on('#toggle-token', 'click', () => {
      const input = $('#gist-token');
      input.type = input.type === 'password' ? 'text' : 'password';
    });
    on('#import-gist-button', 'click', () => this.importFromGist());
    on('#open-gist-export-button', 'click', () => this.openGistExport());
    on('#publish-gist-button', 'click', () => this.publishGist());

    $$('.activity-button[data-sidebar]').forEach(button => button.addEventListener('click', () => this.activateSidebar(button.dataset.sidebar)));
    $$('.section-header').forEach(button => button.addEventListener('click', () => button.closest('.sidebar-section').classList.toggle('open')));
    $$('.menu-trigger[data-menu]').forEach(button => button.addEventListener('click', event => this.openApplicationMenu(event.currentTarget)));
    $$('.settings-nav button').forEach(button => button.addEventListener('click', () => this.showSettingsSection(button.dataset.settingsSection)));
    $$('.tab[data-console-view]').forEach(button => button.addEventListener('click', () => {
      $$('.tab[data-console-view]').forEach(item => item.classList.toggle('active', item === button));
      if (button.dataset.consoleView === 'jobs') this.ui.toast('Background jobs', 'The browser executes one R task at a time. Long-running work can be stopped or the runtime can be restarted.', 'info');
    }));

    this.bindSettingsControls();
    this.bindDockEvents();
    this.bindResizers();
    this.bindCommandPalette();
    this.bindDragAndDrop();

    this.systemTheme.addEventListener('change', () => {
      if (this.settings.theme === 'system') this.applyAppearance();
    });

    document.addEventListener('keydown', event => this.handleGlobalKeydown(event));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && !this.erasingLocalData) {
        this.autosaveDebounced.flush();
        this.persistWorkspaceDebounced.flush();
        if (this.projectPersistenceReady && !this.engine.running) this.projectBackupDebounced();
      }
    });
    window.addEventListener('beforeunload', event => {
      if (this.erasingLocalData) return;
      this.autosaveDebounced.flush();
      this.persistWorkspaceDebounced.flush();
      if (this.hasUnsavedProjectChanges()) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    window.addEventListener('unhandledrejection', event => {
      const error = event.reason;
      console.error('Unhandled application error:', error);
      this.ui.toast('Unexpected IDE error', error?.message || String(error), 'error', 0);
      event.preventDefault();
    });

    this.engine.addEventListener('console-input', event => {
      const request = event.detail.request;
      if (request && this.maximizedPaneId && this.maximizedPaneId !== 'console-pane') this.restoreMaximizedPane();
      if (request) {
        $$('.tab[data-console-view]').forEach(item => item.classList.toggle('active', item.dataset.consoleView === 'console'));
      }
      this.console?.setConsoleInput(request);
    });
    this.engine.addEventListener('state', event => {
      const state = event.detail.state;
      this.assistant?.onRuntimeState(event.detail);
      if (state === 'running') {
        this.projectRuntimeRevision += 1;
        if (this.projectPersistenceReady) this.projectPersistencePending = true;
        const phase = event.detail.phase || '';
        const label = phase === 'preparing'
          ? 'Preparing R…'
          : phase === 'finalizing'
            ? 'R finalizing output…'
            : phase === 'waiting-input'
              ? 'R is waiting for input'
              : 'R running…';
        this.setRuntimeState('running', label, { canStop: phase === 'evaluating' || phase === 'waiting-input' });
      }
      else if (state === 'ready') {
        this.setRuntimeState('ready', this.runtimeReadyLabel());
        if (this.pendingPlotReflow) requestAnimationFrame(() => this.plotResizeDebounced());
        if (this.projectPersistenceReady) this.projectBackupDebounced();
      }
      else if (state === 'restarting') this.setRuntimeState('loading', 'Restarting R…');
    });
  }

  openApplicationMenu(anchor) {
    const name = anchor.dataset.menu;
    const groups = {
      file: [
        { label: 'New Rmd file', icon: 'i-book', action: () => this.createRMarkdownFile() },
        { label: 'New R script', icon: 'i-plus', shortcut: 'Ctrl Alt N', action: () => this.createFile() },
        { label: 'Upload files…', icon: 'i-upload', shortcut: 'Ctrl Alt O', action: () => $('#file-input').click() },
        { label: 'Upload folder…', icon: 'i-folder', action: () => $('#folder-input').click() },
        { type: 'separator' },
        { label: 'Save active file', icon: 'i-save', shortcut: 'Ctrl S', disabled: !this.activePath, action: () => this.saveFile(this.activePath) },
        { label: 'Download selection', icon: 'i-download', disabled: !this.files.size, action: () => this.downloadSelection() },
        { label: 'Download project ZIP', icon: 'i-folder', action: () => this.downloadWorkspaceZip() },
        { type: 'separator' },
        { label: 'Export project JSON…', icon: 'i-database', action: () => this.exportWorkspaceJson() },
        { label: 'Import project JSON…', icon: 'i-upload', action: () => $('#workspace-json-input').click() },
        { label: 'Share workspace URL', icon: 'i-link', action: () => this.shareWorkspaceUrl() }
      ],
      edit: [
        { label: 'Undo', icon: 'i-undo', shortcut: 'Ctrl Z', action: () => this.editor.undo() },
        { label: 'Redo', icon: 'i-redo', shortcut: 'Ctrl Y', action: () => this.editor.redo() },
        { type: 'separator' },
        { label: 'Find and replace', icon: 'i-search', shortcut: 'Ctrl F', action: () => this.editor.findReplace() },
        { label: 'Search project', icon: 'i-search', shortcut: 'Ctrl Shift F', action: () => this.activateSidebar('search') },
        { label: 'Smart indent', icon: 'i-code', shortcut: 'Ctrl I', action: () => this.editor.smartIndent() }
      ],
      code: [
        { label: 'Local R assistant', icon: 'i-sparkles', action: () => this.showAssistant() },
        { label: 'Suggest code locally', icon: 'i-sparkles', shortcut: 'Alt \\', action: () => this.showAssistant({ suggest: true, target: this.currentFocus }) },
        { label: 'Run selected', icon: 'i-play', shortcut: 'Ctrl Enter', action: () => this.executeCode(this.editor.getRunText(), { echo: true }) },
        { label: 'Source active script', icon: 'i-play', shortcut: 'Ctrl Shift Enter', action: () => this.sourceActiveFile({ echo: false }) },
        { label: 'Source with Echo', icon: 'i-terminal', action: () => this.sourceActiveFile({ echo: true }) },
        { label: `Insert ${this.settings.pipe} pipe`, icon: 'i-code', shortcut: 'Ctrl Shift M', action: () => this.currentFocus === 'console' ? this.console.insertPipe() : this.editor.insertPipe() },
        { type: 'separator' },
        { label: 'Jump to definition', icon: 'i-code', shortcut: 'F12', action: () => this.editor.jumpToDefinition() },
        { label: 'Function help', icon: 'i-help', shortcut: 'F1', action: () => this.openHelp(this.editor.getSymbolAtCursor()) },
        { label: 'Check my code with Mistral', icon: 'i-sparkles', action: () => this.checkCodeWithMistral() },
        { label: 'Render Markdown / R Markdown', icon: 'i-book', action: () => this.previewActiveFile() },
        { label: 'Export R Markdown as GFM ZIP', icon: 'i-download', disabled: extname(this.activePath || '') !== 'rmd', action: () => this.downloadRMarkdownGfmBundle() }
      ],
      session: [
        { label: 'Stop execution', icon: 'i-stop', disabled: !this.engine.running, action: () => this.stopExecution() },
        { label: 'Restart webR', icon: 'i-refresh', action: () => this.restartRuntime(true) },
        { type: 'separator' },
        { label: 'Save environment .RData', icon: 'i-download', action: () => this.exportRData() },
        { label: 'Load environment .RData', icon: 'i-upload', action: () => $('#rdata-input').click() },
        { label: 'Clear global environment', icon: 'i-trash', action: () => this.clearEnvironment() },
        { type: 'separator' },
        { label: 'Measure execution time', icon: 'i-clock', checked: this.settings.timing, action: () => this.updateSetting('timing', !this.settings.timing) }
      ],
      view: [
        { label: 'Local R assistant', icon: 'i-sparkles', action: () => this.showAssistant() },
        { label: 'Command palette', icon: 'i-command', shortcut: 'Ctrl Shift P', action: () => this.openCommandPalette() },
        { label: 'Explorer', icon: 'i-file', action: () => this.activateSidebar('explorer') },
        { label: 'Environment', icon: 'i-box', action: () => this.activatePanel('environment') },
        { label: 'Project files', icon: 'i-folder', action: () => this.activateSidebar('explorer') },
        { label: 'Packages', icon: 'i-box', action: () => this.activatePanel('packages') },
        { label: 'Plots', icon: 'i-chart', action: () => this.activatePanel('plots') },
        { label: 'Help', icon: 'i-help', action: () => this.activatePanel('help') },
        { label: 'Data viewer', icon: 'i-table', action: () => this.activatePanel('data') },
        { type: 'separator' },
        { label: 'Reset pane layout', icon: 'i-layout', action: () => this.applyLayoutPreset('reset') },
        { label: 'Settings', icon: 'i-settings', action: () => this.openSettings() }
      ],
      help: [
        { label: 'R help for cursor', icon: 'i-help', shortcut: 'F1', action: () => this.openHelp(this.editor.getSymbolAtCursor()) },
        { label: 'webR documentation', icon: 'i-external', action: () => safeOpen('https://docs.r-wasm.org/webr/latest/') },
        { label: 'Keyboard shortcuts', icon: 'i-command', action: () => this.openSettings('keyboard') },
        { type: 'separator' },
        { label: `About webR Studio ${APP_VERSION}`, icon: 'i-logo', action: () => this.showAbout() }
      ]
    };
    this.ui.showMenu(anchor, groups[name] || []);
  }

  handleGlobalKeydown(event) {
    const key = event.key.toLowerCase();
    if (!event.defaultPrevented && event.altKey && !event.ctrlKey && !event.metaKey && key === '\\'
        && event.target.closest?.('#editor, #console-input, #fallback-editor, #fallback-console')) {
      event.preventDefault();
      const target = event.target.closest('#console-input, #fallback-console') ? 'console' : 'editor';
      this.currentFocus = target;
      this.showAssistant({ suggest: true, target });
      return;
    }
    if (event.ctrlKey && event.shiftKey && key === 'p') {
      event.preventDefault();
      this.openCommandPalette();
      return;
    }
    if (event.ctrlKey && event.shiftKey && key === 'f') {
      event.preventDefault();
      this.activateSidebar('search');
      $('#workspace-search-input').focus();
      return;
    }
    if (event.ctrlKey && event.altKey && key === 'o') {
      event.preventDefault();
      $('#file-input').click();
      return;
    }
    if (event.ctrlKey && event.altKey && key === 'n') {
      event.preventDefault();
      this.createFile();
      return;
    }
    if (event.ctrlKey && key === 's') {
      event.preventDefault();
      this.saveFile(this.activePath);
      return;
    }
    if (event.key === 'Escape') {
      if (this.maximizedPaneId) this.restoreMaximizedPane();
      this.ui.hideMenus();
    }
  }

  renderAll() {
    this.renderFileTree();
    this.renderEditorTabs();
    this.renderProblems();
    this.renderOutline();
    this.renderEnvironment();
    this.renderRuntimeFiles();
    this.renderPackages();
    this.renderPlots();
    this.renderSnapshots();
    this.activateSidebar(this.settings.activeSidebar || 'explorer', false);
    this.updateActiveFileUi();
  }

  openInitialFile() {
    if (!this.files.size) {
      this.activePath = null;
      this.editor?.deactivate();
      $('#editor-welcome').hidden = false;
      return;
    }
    const candidate = [
      this.activePath,
      ...this.openTabs,
      ...[...this.files.values()].filter(isEditableFile).map(file => file.path)
    ].find(path => isEditableFile(this.files.get(path)));
    if (candidate) this.openFile(candidate, {}, false);
    else {
      this.activePath = null;
      this.editor?.deactivate();
      $('#editor-welcome').hidden = false;
    }
  }

  async createFile(suggestedName = '', initialContent = '') {
    const existing = new Set([...this.files.keys(), ...this.runtimeProjectFiles.keys()]);
    let name = suggestedName || makeUniqueName('untitled.R', existing);
    if (suggestedName) name = makeUniqueName(suggestedName, existing);
    const file = fileRecord({ path: name, content: initialContent, type: 'text', mime: mimeFromPath(name) });
    this.files.set(file.path, file);
    this.pendingMirrors.add(file.path);
    this.projectPersistencePending = true;
    this.editor.addOrUpdateFile(file);
    await workspaceDB.putFile(file);
    await this.mirrorFilesWhenIdle([file]);
    this.openFile(file.path);
    this.renderFileTree();
    this.ui.toast('New file', `${file.path} was created.`, 'success');
    return file;
  }

  async createRMarkdownFile() {
    return this.createFile('untitled.Rmd', NEW_RMD_TEMPLATE);
  }

  async loadSampleProject() {
    const existing = new Set([...this.files.keys(), ...this.runtimeProjectFiles.keys()]);
    const created = [];
    for (const sample of SAMPLE_FILES) {
      const path = makeUniqueName(sample.path, existing);
      existing.add(path);
      const file = fileRecord({ ...sample, path });
      this.files.set(path, file);
      this.pendingMirrors.add(path);
      this.projectPersistencePending = true;
      this.editor.addOrUpdateFile(file);
      created.push(file);
    }
    await workspaceDB.putFiles(created);
    this.openFile(created[0].path);
    this.renderFileTree();
    this.ui.toast('Sample project loaded', `${created.length} files are ready to explore.`, 'success');
    await this.mirrorFilesWhenIdle(created);
  }

  showFileOpenLimit(file) {
    const path = file.path;
    const size = Number(file.size || 0);
    if (size > MAX_EDITOR_BYTES) {
      const alternative = isDataPath(path) ? 'Download or Open in data viewer' : 'Download';
      this.ui.toast('File too large for the editor', `${path} is ${formatBytes(size)}. The editor supports files up to ${formatBytes(MAX_EDITOR_BYTES)}. Use ${alternative} from the file menu.`, 'info', 8000);
      return;
    }
    const encoding = textEncodingFromBOM(file.content);
    if (encoding && encoding !== 'UTF-8') {
      this.ui.toast('Text encoding not supported', `${path} uses ${encoding}. The editor supports UTF-8 text. Use Download from the file menu to save the original bytes, or convert a copy to UTF-8 before uploading it.`, 'info', 8000);
      return;
    }
    this.ui.toast('Cannot open as text', `${path} is binary or is not valid UTF-8 text. Use Download from the file menu to save the original bytes.`, 'info', 8000);
  }

  openFile(path, position = {}, persist = true) {
    const normalized = this.files.has(path) ? path : normalizePath(path);
    const file = this.files.get(normalized);
    if (!file) return;
    if (!isEditableFile(file)) {
      this.showFileOpenLimit(file);
      return;
    }
    if (!this.openTabs.includes(normalized)) this.openTabs.push(normalized);
    this.activePath = normalized;
    this.editor.addOrUpdateFile(file);
    this.editor.open(normalized, position);
    $('#editor-welcome').hidden = true;
    this.renderEditorTabs();
    this.renderFileTree();
    this.updateActiveFileUi();
    if (persist) this.persistWorkspaceDebounced();
  }

  async closeTab(path) {
    const file = this.files.get(path);
    if (file?.dirty) {
      await this.saveFile(path);
      if (file.dirty) {
        this.ui.toast('Tab kept open', `${path} could not be saved yet.`, 'warning', 7000);
        return;
      }
    }
    const index = this.openTabs.indexOf(path);
    this.openTabs = this.openTabs.filter(item => item !== path);
    if (this.activePath === path) {
      const next = this.openTabs[index] || this.openTabs[index - 1] || null;
      this.activePath = next;
      if (next) this.openFile(next, {}, false);
      else {
        this.editor.deactivate();
        $('#editor-welcome').hidden = false;
        this.updateActiveFileUi();
      }
    }
    this.renderEditorTabs();
    this.persistWorkspaceDebounced();
  }

  onEditorChange(path, content) {
    const file = this.files.get(path);
    if (!file || this.erasingLocalData || this.deletingFiles.has(path) || this.syncingRuntimeFiles.has(path)) return;
    file.content = content;
    file.updatedAt = Date.now();
    file.revision = (Number(file.revision) || 0) + 1;
    file.dirty = true;
    if (this.rMarkdownGfmArtifact?.sourcePath === path && this.rMarkdownGfmArtifact.sourceDocument !== content) {
      this.rMarkdownGfmArtifact = null;
      $('#download-preview-gfm').disabled = extname(path) !== 'rmd';
    }
    $('#save-status').textContent = 'Saving changes…';
    this.markFileDirtyUi(path);
    this.autosaveDebounced();
  }

  markFileDirtyUi(path) {
    for (const tab of $$('.editor-tab')) {
      if (tab.dataset.path === path) tab.classList.add('dirty');
    }
    for (const row of $$('#file-tree .file-row[data-path]')) {
      if (row.dataset.path !== path) continue;
      const meta = row.querySelector('.file-meta, .dirty-dot');
      if (meta) {
        meta.className = 'dirty-dot';
        meta.textContent = '';
      }
    }
  }

  markFileSavedUi(path) {
    for (const tab of $$('.editor-tab')) {
      if (tab.dataset.path === path) tab.classList.remove('dirty');
    }
    for (const row of $$('#file-tree .file-row[data-path]')) {
      if (row.dataset.path !== path) continue;
      const meta = row.querySelector('.dirty-dot');
      if (meta) {
        meta.className = 'file-meta';
        const file = this.files.get(path);
        meta.textContent = file ? formatBytes(file.size) : '';
      }
    }
  }

  async saveFile(path) {
    if (!path || this.erasingLocalData || this.deletingFiles.has(path)) return;
    const previous = this.fileSaveQueues.get(path) || Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(() => this.performSaveFile(path));
    this.fileSaveQueues.set(path, task);
    try {
      return await task;
    } finally {
      if (this.fileSaveQueues.get(path) === task) this.fileSaveQueues.delete(path);
      this.updateProjectSaveStatus();
      if (this.projectPersistenceReady && !this.erasingLocalData) this.projectBackupDebounced();
    }
  }

  async performSaveFile(path) {
    const file = this.files.get(path);
    if (!file || this.erasingLocalData || this.deletingFiles.has(path)) return;
    if (path === this.activePath && isEditableFile(file)) {
      const currentText = this.editor.getValue();
      if (currentText !== file.content) {
        file.content = currentText;
        file.revision = (Number(file.revision) || 0) + 1;
      }
    }
    const revision = Number(file.revision) || 0;
    const content = typeof file.content === 'string'
      ? file.content
      : new Uint8Array(file.content || []);
    const size = typeof content === 'string' ? textEncoder.encode(content).length : content.byteLength;
    const updatedAt = Date.now();
    const stored = { ...file, content, size, updatedAt };
    delete stored.dirty;
    delete stored.revision;

    try {
      await workspaceDB.putFile(stored);
      if (this.erasingLocalData || this.deletingFiles.has(path)) return;

      let mirrorError = null;
      if (this.engine.ready && !this.engine.running) {
        try {
          await this.queueMirrorOperation(async () => {
            if (!this.deletingFiles.has(path)) {
              await this.engine.mirrorFile(path, content);
              this.runtimeKnownFiles.add(path);
            }
          });
          this.pendingMirrors.delete(path);
          this.runtimeFilesRefreshPending = true;
        } catch (error) {
          mirrorError = error;
          this.pendingMirrors.add(path);
        }
      } else if (this.engine.ready) {
        this.pendingMirrors.add(path);
      }

      const current = this.files.get(path);
      if (current === file && (Number(current.revision) || 0) === revision) {
        current.size = size;
        current.updatedAt = updatedAt;
        current.dirty = false;
        this.markFileSavedUi(path);
      } else if (current) {
        current.dirty = true;
        this.pendingMirrors.add(path);
        this.autosaveDebounced();
      }

      this.updateProjectSaveStatus();
      this.persistWorkspaceDebounced();
      if (mirrorError) {
        this.ui.toast('Saved locally', `The R file mirror will retry later: ${mirrorError.message || String(mirrorError)}`, 'warning', 7000);
      }
    } catch (error) {
      $('#save-status').textContent = 'Save failed';
      this.ui.toast('Could not save file', error.message || String(error), 'error', 0);
      return false;
    }
  }

  async saveDirtyFiles() {
    const dirty = [...this.files.values()].filter(file => file.dirty);
    for (const file of dirty) await this.saveFile(file.path);
    this.updateProjectSaveStatus();
  }

  hasUnsavedProjectChanges() {
    return Boolean(this.engine.running || this.fileMutationPending || this.projectSnapshotInProgress || this.projectPersistencePending ||
      this.projectPersistenceError || this.pendingMirrors.size || this.pendingMirrorDeletes.size ||
      this.fileSaveQueues.size || [...this.files.values()].some(file => file.dirty));
  }

  updateProjectSaveStatus() {
    const status = $('#save-status');
    if (!status) return;
    if (this.projectPersistenceError) status.textContent = 'Project backup failed';
    else if (this.projectSnapshotInProgress) status.textContent = 'Saving project files…';
    else if (this.hasUnsavedProjectChanges()) status.textContent = 'Changes waiting to be saved';
    else status.textContent = 'All changes saved';
  }

  async flushProjectBackup() {
    this.projectBackupDebounced.cancel();
    if (this.engine.running) throw new Error('Wait for R to finish before saving the complete project.');
    await this.saveDirtyFiles();
    await Promise.allSettled([...this.fileSaveQueues.values()]);
    const canSnapshot = this.projectPersistenceReady && this.engine.ready;
    if (canSnapshot) {
      await this.flushPendingMirrors();
      await this.refreshRuntimeFiles(this.runtimeFilesPath, { quiet: true });
    }
    if ((canSnapshot && this.hasUnsavedProjectChanges()) || this.fileSaveQueues.size ||
        [...this.files.values()].some(file => file.dirty)) {
      throw new Error(this.projectPersistenceError || 'The project still has unsaved changes. Wait for saving to finish and try again.');
    }
  }

  async restoreProjectFiles(onProgress = () => {}) {
    await this.queueMirrorOperation(async () => {
      const records = [...this.files.values()];
      await this.engine.mirrorFiles(records, onProgress);
      for (const path of this.projectDirectories) await this.engine.ensureDirectory(`/project/${projectRelativePath(path)}`);
      this.runtimeKnownFiles = new Set(records.map(file => file.path));
      for (const file of records) this.pendingMirrors.delete(file.path);
      this.pendingMirrorDeletes.clear();
      await this.performPendingMirrors();
    });
  }

  async persistRuntimeProject(project, context) {
    const currentRuntime = () => this.projectPersistenceReady && !this.erasingLocalData &&
      context.epoch === this.projectPersistenceEpoch && context.runtime === this.engine.webR &&
      context.generation === this.engine.generation && context.revision === this.projectRuntimeRevision &&
      this.engine.ready && !this.engine.running;
    const changedError = () => Object.assign(new Error('The project changed during its backup; saving will retry when R is idle.'), {
      name: 'ProjectSnapshotChanged'
    });
    const assertCurrent = () => { if (!currentRuntime()) throw changedError(); };
    const protectedFile = (path, file) => Boolean(file?.dirty || this.pendingMirrors.has(path) ||
      this.pendingMirrorDeletes.has(path) || this.deletingFiles.has(path) || this.fileSaveQueues.has(path));
    const unchanged = item => this.files.get(item.path) === item.original &&
      (Number(item.original?.revision) || 0) === item.revision && !protectedFile(item.path, item.original);
    const equalBytes = (content, bytes) => {
      const previous = typeof content === 'string' ? textEncoder.encode(content) : content;
      if (!previous || previous.byteLength !== bytes.byteLength) return false;
      for (let index = 0; index < bytes.byteLength; index += 1) {
        if (previous[index] !== bytes[index]) return false;
      }
      return true;
    };
    const staged = [];
    const removed = [];
    const present = new Set();
    const directories = [];
    let deferred = false;
    assertCurrent();
    for (const entry of project.entries) {
      if (!entry.path.startsWith('/project/')) throw new Error('The project listing contains a path outside /project.');
      const path = projectRelativePath(entry.path.slice('/project/'.length));
      if (entry.isDirectory) { directories.push(path); continue; }
      present.add(path);
      const original = this.files.get(path);
      if (protectedFile(path, original)) { deferred = true; continue; }
      const candidate = { path, original, revision: Number(original?.revision) || 0 };
      // Read all regular files, including unchanged-size/timestamp files. No
      // size cutoff silently excludes a user's data from the project backup.
      const bytes = await this.engine.readVirtualFile(entry.path);
      assertCurrent();
      if (!unchanged(candidate)) { deferred = true; continue; }
      if (!original || !equalBytes(original.content, bytes)) {
        candidate.record = fileRecord({ path, content: bytes, createdAt: original?.createdAt,
          updatedAt: entry.modifiedAt || Date.now(), revision: candidate.revision });
        staged.push(candidate);
      }
    }
    for (const path of this.runtimeKnownFiles) {
      if (present.has(path)) continue;
      const original = this.files.get(path);
      if (!original) continue;
      if (protectedFile(path, original)) { deferred = true; continue; }
      removed.push({ path, original, revision: Number(original.revision) || 0 });
    }
    assertCurrent();
    const changes = staged.filter(item => {
      if (unchanged(item)) return true;
      deferred = true;
      return false;
    });
    const deletions = removed.filter(item => {
      if (unchanged(item)) return true;
      deferred = true;
      return false;
    });
    const records = changes.map(({ record }) => {
      const stored = { ...record };
      delete stored.dirty;
      delete stored.revision;
      return stored;
    });
    await workspaceDB.commitProjectSnapshot({ files: records,
      deletedPaths: deletions.map(item => item.path), directories }, () => {
      assertCurrent();
      if (![...changes, ...deletions].every(unchanged)) throw changedError();
      return true;
    });
    assertCurrent();
    for (const item of changes) {
      if (!unchanged(item)) { deferred = true; continue; }
      const file = item.original || item.record;
      if (item.original) Object.assign(file, item.record);
      this.files.set(item.path, file);
      this.syncingRuntimeFiles.add(item.path);
      try {
        if (isEditableFile(file)) {
          this.editor?.addOrUpdateFile(file, { syncContent: true });
          if (this.editor?.fallbackMode && this.activePath === item.path) this.editor.open(item.path);
        } else {
          this.editor?.removeFile(item.path);
          this.openTabs = this.openTabs.filter(path => path !== item.path);
        }
      } finally { this.syncingRuntimeFiles.delete(item.path); }
    }
    for (const item of deletions) {
      if (!unchanged(item)) { deferred = true; continue; }
      this.files.delete(item.path);
      this.runtimeKnownFiles.delete(item.path);
      this.selectedFiles.delete(item.path);
      this.editor?.removeFile(item.path);
      this.openTabs = this.openTabs.filter(path => path !== item.path);
    }
    for (const path of present) this.runtimeKnownFiles.add(path);
    this.projectDirectories = new Set(directories);
    this.projectPersistenceError = '';
    this.projectPersistencePending = deferred || Boolean(this.pendingMirrors.size || this.pendingMirrorDeletes.size ||
      this.fileSaveQueues.size || [...this.files.values()].some(file => file.dirty));
    if (this.activePath && !isEditableFile(this.files.get(this.activePath))) {
      this.activePath = this.openTabs.find(path => isEditableFile(this.files.get(path))) || null;
      if (this.activePath) this.openFile(this.activePath, {}, false);
      else {
        this.editor?.deactivate();
        $('#editor-welcome').hidden = false;
      }
    }
    if (changes.length || deletions.length) {
      this.renderEditorTabs();
      this.updateActiveFileUi();
      this.persistWorkspaceDebounced();
    }
    return { changed: changes.length + deletions.length, deferred: this.projectPersistencePending };
  }

  async flushPendingMirrors() {
    return this.queueMirrorOperation(() => this.performPendingMirrors());
  }

  queueMirrorOperation(action) {
    const epoch = this.projectPersistenceEpoch;
    const pending = this.mirrorOperationQueue.catch(() => {}).then(() => {
      if (epoch !== this.projectPersistenceEpoch || this.erasingLocalData) {
        throw Object.assign(new Error('The project changed before its file operation could finish.'), { name: 'ProjectSnapshotChanged' });
      }
      return action();
    });
    this.mirrorOperationQueue = pending.catch(() => {});
    return pending;
  }

  async performPendingMirrors() {
    if (!this.engine.ready || this.engine.running) return;
    const failures = [];
    let changed = false;
    for (const path of [...this.pendingMirrorDeletes]) {
      try {
        await this.engine.removeMirroredFile(path);
        this.pendingMirrorDeletes.delete(path);
        this.runtimeKnownFiles.delete(path);
        changed = true;
      } catch (error) {
        failures.push(`${path}: ${error.message || String(error)}`);
      }
    }
    for (const path of [...this.pendingMirrors]) {
      if (this.deletingFiles.has(path)) continue;
      const file = this.files.get(path);
      if (!file) {
        this.pendingMirrors.delete(path);
        continue;
      }
      try {
        await this.engine.mirrorFile(path, file.content);
        this.pendingMirrors.delete(path);
        this.runtimeKnownFiles.add(path);
        changed = true;
      } catch (error) {
        failures.push(`${path}: ${error.message || String(error)}`);
      }
    }
    if (failures.length) {
      console.warn('Some project files could not be mirrored into webR:', failures);
      this.ui.toast(
        'Project mirror incomplete',
        `${failures.length} file operation${failures.length === 1 ? '' : 's'} will be retried before the next run.`,
        'warning',
        7000
      );
    }
    if (changed) this.runtimeFilesRefreshPending = true;
  }

  async mirrorFilesWhenIdle(files) {
    const records = [...files].filter(Boolean);
    if (!records.length) return;
    records.forEach(file => this.pendingMirrors.add(file.path));
    this.projectPersistencePending = true;
    if (!this.engine.ready) return;
    if (this.engine.running) {
      records.forEach(file => this.pendingMirrors.add(file.path));
      return;
    }
    await this.queueMirrorOperation(async () => {
      const available = records.filter(file => !this.deletingFiles.has(file.path));
      if (this.engine.running) {
        available.forEach(file => this.pendingMirrors.add(file.path));
        return;
      }
      await this.engine.mirrorFiles(available);
      available.forEach(file => {
        this.pendingMirrors.delete(file.path);
        this.runtimeKnownFiles.add(file.path);
      });
      this.runtimeFilesRefreshPending = true;
    });
    if (this.projectPersistenceReady) this.projectBackupDebounced();
  }

  async removeMirroredFileWhenIdle(path) {
    if (!this.engine.ready) return;
    this.pendingMirrors.delete(path);
    if (this.engine.running) {
      this.pendingMirrorDeletes.add(path);
      return;
    }
    await this.queueMirrorOperation(() => this.engine.removeMirroredFile(path));
    this.pendingMirrorDeletes.delete(path);
    this.runtimeKnownFiles.delete(path);
  }

  async uploadFiles(fileList) {
    if (!fileList?.length) return;
    const existing = new Set([...this.files.keys(), ...this.runtimeProjectFiles.keys()]);
    const added = [];
    const skipped = [];
    for (const browserFile of fileList) {
      if (browserFile.size > MAX_FILE_BYTES) {
        skipped.push(`${browserFile.name} exceeds 100 MB`);
        continue;
      }
      try {
        const originalPath = browserFile.webkitRelativePath || browserFile.name;
        const path = makeUniqueName(normalizePath(originalPath), existing);
        existing.add(path);
        const content = await readFileAsBytes(browserFile);
        const record = fileRecord({
          path,
          content,
          mime: browserFile.type || mimeFromPath(path),
          size: browserFile.size,
          updatedAt: browserFile.lastModified || Date.now()
        });
        this.files.set(path, record);
        this.pendingMirrors.add(path);
        this.projectPersistencePending = true;
        this.updateProjectSaveStatus();
        if (isEditableFile(record)) this.editor.addOrUpdateFile(record);
        added.push(record);
      } catch (error) {
        skipped.push(`${browserFile.name}: ${error.message}`);
      }
    }
    if (added.length) {
      await workspaceDB.putFiles(added);
      await this.mirrorFilesWhenIdle(added);
      this.renderFileTree();
      const firstEditable = added.find(isEditableFile);
      const firstData = added.find(file => isDataPath(file.path));
      if (firstEditable) this.openFile(firstEditable.path);
      else if (firstData) this.openDataFile(firstData.path);
      this.ui.toast('Files uploaded', `${added.length} file${added.length === 1 ? '' : 's'} added to the project.`, 'success');
      if (this.projectPersistenceReady) this.projectBackupDebounced();
    }
    if (skipped.length) this.ui.toast('Some files were skipped', skipped.slice(0, 3).join('; '), 'warning', 0);
  }

  async renameFile(path) {
    const file = this.files.get(path);
    if (!file) return;
    if (this.engine.running || this.fileMutationPending) {
      this.ui.toast('Files are busy', 'Wait for the current operation before renaming files.', 'warning');
      return;
    }
    const proposed = await this.ui.prompt('Rename file', 'Enter a project-relative path.', { value: path, acceptLabel: 'Rename' });
    if (!proposed) return;
    const normalized = proposed === path ? path : normalizePath(proposed);
    if (normalized === path) return;
    if (this.files.has(normalized) || this.runtimeProjectFiles.has(normalized)) {
      this.ui.toast('Name already used', `${normalized} already exists.`, 'warning');
      return;
    }
    if (this.fileSaveQueues.has(path)) await this.fileSaveQueues.get(path).catch(() => {});
    if (this.engine.running || this.fileMutationPending) return;
    if (this.runtimeProjectFiles.has(path)) await this.refreshStoredFile(path, this.runtimeProjectFiles.get(path));
    if (this.files.get(path) !== file) return;
    if (file.dirty) {
      await this.saveFile(path);
      if (file.dirty) {
        this.ui.toast('Rename postponed', `${path} could not be saved safely.`, 'warning', 7000);
        return;
      }
    }
    this.files.delete(path);
    file.path = normalized;
    file.mime = mimeFromPath(normalized);
    file.updatedAt = Date.now();
    this.files.set(normalized, file);
    const stored = { ...file };
    delete stored.dirty;
    delete stored.revision;
    await workspaceDB.putFile(stored);
    await workspaceDB.deleteFile(path);
    this.editor.renameFile(path, normalized);
    this.openTabs = this.openTabs.map(item => item === path ? normalized : item);
    if (this.activePath === path) this.activePath = normalized;
    if (this.selectedFiles.delete(path)) this.selectedFiles.add(normalized);
    await this.removeMirroredFileWhenIdle(path);
    await this.mirrorFilesWhenIdle([file]);
    this.renderAll();
    this.openFile(normalized);
  }

  async deleteFiles(paths) {
    const unique = [...new Set(paths)].filter(path => this.explorerFile(path));
    if (!unique.length) return;
    if (this.engine.running || this.fileMutationPending) {
      this.ui.toast('Files are busy', 'Wait for the current R or file operation to finish before deleting files.', 'warning');
      return;
    }
    const accepted = await this.ui.confirm(
      `Delete ${unique.length === 1 ? basename(unique[0]) : `${unique.length} files`}?`,
      'The selected files will be removed from the R filesystem and any saved project copies. This cannot be undone.',
      { acceptLabel: 'Delete' }
    );
    if (!accepted) return;
    // R may have started while the confirmation dialog was open.
    if (this.engine.running || this.fileMutationPending) {
      this.ui.toast('Deletion postponed', 'R or another file operation started. Wait for it to finish, then delete the files again.', 'warning');
      return;
    }
    this.fileMutationPending = true;
    unique.forEach(path => this.deletingFiles.add(path));
    this.renderRuntimeFiles();
    const failures = [];
    let removed = 0;
    try {
      await Promise.allSettled(unique.map(path => this.fileSaveQueues.get(path)).filter(Boolean));
      // Let earlier mirror writes finish before removing their destinations.
      await this.mirrorOperationQueue;
      for (const path of unique) {
        const entry = this.explorerFile(path);
        if (!entry) continue;
        try {
          if (this.engine.ready) {
            const present = await this.engine.statVirtualFile(entry.virtualPath);
            if (present) await this.engine.deleteVirtualFile(entry.virtualPath);
          } else if (!this.files.has(path)) {
            throw new Error('Start R before deleting a file that exists only in the R session.');
          }
          if (this.files.has(path)) await workspaceDB.deleteFile(path);
          this.pendingMirrors.delete(path);
          this.pendingMirrorDeletes.delete(path);
          this.runtimeProjectFiles.delete(path);
          this.runtimeFiles = this.runtimeFiles.filter(item => item.path !== entry.virtualPath);
          this.files.delete(path);
          this.selectedFiles.delete(path);
          this.editor.removeFile(path);
          this.openTabs = this.openTabs.filter(item => item !== path);
          removed += 1;
        } catch (error) {
          failures.push(`${path}: ${error.message || String(error)}`);
        }
      }
    } finally {
      unique.forEach(path => this.deletingFiles.delete(path));
      this.fileMutationPending = false;
    }
    if (!this.files.has(this.activePath)) {
      this.activePath = this.openTabs.at(-1) || [...this.files.values()].find(isEditableFile)?.path || null;
      if (this.activePath) this.openFile(this.activePath, {}, false);
      else {
        this.editor.deactivate();
        $('#editor-welcome').hidden = false;
      }
    }
    this.renderAll();
    this.persistWorkspaceDebounced();
    await this.refreshRuntimeFiles(this.runtimeFilesPath, { quiet: true });
    if (failures.length) this.ui.toast('Some files could not be deleted', failures.join('\n'), 'error', 0);
    else if (removed) this.ui.toast('Files deleted', `${removed} file${removed === 1 ? '' : 's'} removed.`, 'success');
  }

  async downloadFile(path) {
    const file = this.explorerFile(path);
    if (!file) return;
    try {
      const content = await this.explorerFileContent(path);
      downloadBlob(new Blob([content], { type: mimeFromPath(path) }), file.name || basename(path));
    } catch (error) {
      this.ui.toast('Could not download file', error.message || String(error), 'error');
    }
  }

  downloadSelection() {
    const paths = this.selectedFiles.size ? [...this.selectedFiles] : this.activePath ? [this.activePath] : [];
    if (!paths.length) return this.ui.toast('Nothing selected', 'Select one or more files in the Explorer.', 'info');
    if (paths.length === 1) return this.downloadFile(paths[0]);
    this.downloadZip(paths, 'webr-studio-selection.zip');
  }

  async downloadZip(paths, filename) {
    try {
      const files = [];
      for (const path of paths) {
        if (!this.explorerFile(path)) continue;
        files.push({ name: path.replace(/^\/+/, ''), data: await this.explorerFileContent(path) });
      }
      downloadBlob(createZip(files), filename);
    } catch (error) {
      this.ui.toast('Could not export files', error.message || String(error), 'error');
    }
  }

  async downloadWorkspaceZip() {
    try { await this.flushProjectBackup(); }
    catch (error) { this.ui.toast('Project export is not ready', error.message, 'error'); return; }
    const paths = new Set([...this.files.keys(), ...[...this.runtimeProjectFiles].filter(([, entry]) => !entry.isDirectory).map(([path]) => path)]);
    if (!paths.size) return this.ui.toast('Project is empty', 'There are no files to download.', 'info');
    return this.downloadZip([...paths], localTimestampName('webr-studio-project', 'zip'));
  }

  explorerFile(path) {
    const stored = this.files.get(path);
    const runtime = this.runtimeProjectFiles.get(path)
      || this.runtimeFiles.find(entry => entry.path === path);
    if ((!stored && !runtime) || runtime?.isDirectory) return null;
    return {
      ...stored, ...runtime,
      path,
      virtualPath: runtime?.path || `/project/${path}`,
      size: stored?.dirty ? stored.size : runtime?.size ?? stored?.size ?? 0,
      dirty: Boolean(stored?.dirty),
      runtimeOnly: !stored,
      inRuntime: Boolean(runtime),
      stored
    };
  }

  async explorerFileContent(path) {
    const entry = this.explorerFile(path);
    if (!entry) throw new Error('The file is no longer available. Refresh the Explorer.');
    if (entry.stored?.dirty || this.pendingMirrors.has(path)) return entry.stored.content;
    if (entry.inRuntime) {
      if (!this.engine.ready || this.engine.running) throw new Error('Wait for R to be ready before reading this file.');
      return this.engine.readVirtualFile(entry.virtualPath);
    }
    if (entry.stored) return entry.stored.content;
    throw new Error('This file is no longer in the R session.');
  }

  async keepRuntimeFile(path, { open = false } = {}) {
    const entry = this.explorerFile(path);
    if (!entry) return null;
    if (!this.requireIdleRuntime('Saving a session file')) return null;
    let locked = false;
    try {
      let target = path;
      if (path.startsWith('/') || normalizePath(path) !== path) {
        const proposed = await this.ui.prompt('Keep in project', 'Choose a path inside /project for the saved copy. Backslashes are treated as folder separators in saved projects.', { value: normalizePath(path.startsWith('/') ? entry.name : path), acceptLabel: 'Keep file' });
        if (!proposed) return null;
        target = normalizePath(proposed);
        if (target.split('/').includes('..')) throw new Error('Choose a file path inside /project without parent-directory segments.');
        target = target.split('/').filter(part => part && part !== '.').join('/');
        if (!target) throw new Error('Choose a filename inside /project.');
        if (this.files.has(target) || this.runtimeProjectFiles.has(target)) throw new Error(`${target} already exists in /project. Choose a different name.`);
      }
      if (!this.requireIdleRuntime('Saving a session file') || this.deletingFiles.has(path)) return null;
      this.fileMutationPending = true;
      this.projectPersistencePending = true;
      locked = true;
      this.updateProjectSaveStatus();
      this.renderRuntimeFiles();
      const bytes = await this.explorerFileContent(path);
      const file = fileRecord({ path: target, content: bytes, updatedAt: entry.modifiedAt || Date.now() });
      await workspaceDB.putFile(file);
      this.files.set(target, file);
      if (target !== path) this.pendingMirrors.add(target);
      if (isEditableFile(file)) this.editor.addOrUpdateFile(file);
      if (target !== path) await this.mirrorFilesWhenIdle([file]);
      this.renderFileTree();
      if (open) this.openFile(target);
      this.ui.toast('File kept in project', `${target} will be available after restarting R or reloading this page.`, 'success');
      return file;
    } catch (error) {
      this.ui.toast('Could not keep file', error.message || String(error), 'error', 0);
      return null;
    } finally {
      if (locked) {
        this.fileMutationPending = false;
        this.renderRuntimeFiles();
        if (this.projectPersistenceReady) this.projectBackupDebounced();
      }
    }
  }

  async refreshStoredFile(path, runtime) {
    const file = this.files.get(path);
    if (!file || file.dirty || this.pendingMirrors.has(path) || this.deletingFiles.has(path) || this.fileSaveQueues.has(path)) return;
    const listing = await this.refreshRuntimeFiles(this.runtimeFilesPath, { quiet: true });
    if (!listing) throw new Error(this.projectPersistenceError || this.runtimeFilesError || 'Wait for the current file operation before opening the runtime version.');
    return listing;
  }

  async openExplorerFile(path, { data = false, preview = false } = {}) {
    const entry = this.explorerFile(path);
    if (!entry) return;
    try {
      if (data) return await this.openDataFile(path);
      if (entry.runtimeOnly) {
        if (entry.size > MAX_EDITOR_BYTES) {
          this.showFileOpenLimit(entry);
          return;
        }
        const content = await this.explorerFileContent(path);
        if (decodeFileText(content) === null) {
          this.showFileOpenLimit({ ...entry, content });
          return;
        }
        const file = await this.keepRuntimeFile(path, { open: true });
        if (file && preview && isEditableFile(file)) return this.previewActiveFile(file.path);
        return file;
      }
      if (entry.inRuntime && !this.engine.running && this.engine.ready) {
        await this.refreshStoredFile(path, { ...entry, path: entry.virtualPath });
      }
      if (preview && isEditableFile(this.files.get(path))) return this.previewActiveFile(path);
      this.openFile(path);
    } catch (error) {
      this.ui.toast('Could not open file', error.message || String(error), 'error');
    }
  }

  renderFileTree() {
    const tree = $('#file-tree');
    if (!tree) return;
    tree.replaceChildren();
    const inProject = this.runtimeFilesPath === '/project' || this.runtimeFilesPath.startsWith('/project/');
    const prefix = inProject ? this.runtimeFilesPath.slice('/project'.length).replace(/^\//, '') : '';
    const paths = inProject
      ? new Set([...this.files.keys(), ...this.runtimeProjectFiles.keys()])
      : new Set(this.runtimeFiles.filter(entry => !entry.isDirectory).map(entry => entry.path));
    const visiblePaths = [...paths].filter(path => !prefix || path.startsWith(`${prefix}/`));
    const files = visiblePaths.map(path => this.explorerFile(path)).filter(Boolean);
    const directories = inProject
      ? [...this.runtimeProjectFiles].filter(([path, entry]) => entry.isDirectory && (!prefix || path.startsWith(`${prefix}/`)))
      : this.runtimeFiles.filter(entry => entry.isDirectory).map(entry => [entry.path, entry]);
    $('#project-file-count').textContent = String(files.length);
    this.updateExplorerControls();
    if (!files.length && !directories.length) {
      tree.className = 'file-tree empty-state compact-empty';
      const detail = this.runtimeFilesError || (this.runtimeFilesLoading ? 'Reading files…' : inProject ? 'No files here. Upload files, create a script, or download data from R.' : 'This directory is empty.');
      tree.innerHTML = `${svg('i-folder')}<p>${escapeHtml(detail)}</p>`;
      return;
    }
    tree.className = 'file-tree';
    if (!inProject) {
      for (const [, entry] of directories) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'file-row folder-row';
        row.innerHTML = `${svg('i-folder')}<span class="file-name">${escapeHtml(entry.name)}</span>`;
        row.disabled = this.engine.running || this.fileMutationPending;
        row.addEventListener('click', () => this.refreshRuntimeFiles(entry.path));
        tree.append(row);
      }
      for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) tree.append(this.renderFileRow(file, 0));
      return;
    }
    const root = { folders: new Map(), files: [] };
    const ensureFolders = parts => {
      let node = root;
      for (const part of parts) {
        if (!node.folders.has(part)) node.folders.set(part, { name: part, folders: new Map(), files: [] });
        node = node.folders.get(part);
      }
      return node;
    };
    const localPath = path => prefix ? path.slice(prefix.length + 1) : path;
    for (const [path] of directories) ensureFolders(localPath(path).split('/'));
    for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
      const parts = localPath(file.path).split('/');
      ensureFolders(parts.slice(0, -1)).files.push(file);
    }
    const expandInitially = !this.folderExpansionInitialized;
    const renderNode = (node, prefix = '', depth = 0) => {
      for (const [name, folder] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
        const folderPath = prefix ? `${prefix}/${name}` : name;
        if (expandInitially) this.expandedFolders.add(folderPath);
        const open = this.expandedFolders.has(folderPath);
        const row = document.createElement('div');
        row.className = 'file-row folder-row';
        row.style.paddingLeft = `${8 + depth * 14}px`;
        row.innerHTML = `${svg('i-chevron', open ? '' : '')}${svg('i-folder')}<span class="file-name">${escapeHtml(name)}</span>`;
        row.firstElementChild.style.transform = open ? 'rotate(90deg)' : '';
        row.addEventListener('click', () => {
          if (open) this.expandedFolders.delete(folderPath); else this.expandedFolders.add(folderPath);
          this.renderFileTree();
          this.persistWorkspaceDebounced();
        });
        tree.append(row);
        if (open) renderNode(folder, folderPath, depth + 1);
      }
      for (const file of node.files) tree.append(this.renderFileRow(file, depth));
    };
    renderNode(root, prefix);
    this.folderExpansionInitialized = true;
  }

  renderFileRow(file, depth) {
    const row = document.createElement('div');
    const selected = this.selectedFiles.has(file.path);
    const active = this.activePath === file.path;
    row.className = `file-row${selected ? ' selected' : ''}${active ? ' active' : ''}`;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.dataset.path = file.path;
    row.setAttribute('role', 'treeitem');
    const extension = extname(file.path);
    const name = file.name || basename(file.path);
    const iconId = isDataPath(file.path) ? 'i-table' : ['md', 'markdown', 'rmd'].includes(extension) ? 'i-book' : extension === 'r' ? 'i-code' : 'i-file';
    const typeClass = isDataPath(file.path) ? 'file-type-data' : ['md', 'markdown', 'rmd'].includes(extension) ? 'file-type-md' : extension === 'r' ? 'file-type-r' : '';
    const unsavedProjectFile = file.runtimeOnly && file.virtualPath?.startsWith('/project/');
    const runtimeBadge = file.runtimeOnly
      ? `<span class="runtime-only" title="${unsavedProjectFile ? 'Automatic project backup has not completed for this file. Keep the page open and resolve any save error.' : 'Exists only in this R session. Use Keep in project to retain it after a restart.'}">${unsavedProjectFile ? 'Not saved' : 'R session'}</span>`
      : '';
    row.tabIndex = 0;
    row.setAttribute('aria-selected', String(selected));
    row.innerHTML = `${svg(iconId, typeClass)}<span class="file-name" title="${escapeHtml(file.virtualPath || file.path)}">${escapeHtml(name)}</span>${runtimeBadge}<span class="file-meta">${formatBytes(file.size)}</span><span class="file-actions"><button class="mini-icon" data-file-action="delete" title="Delete ${escapeHtml(name)}" aria-label="Delete ${escapeHtml(name)}">${svg('i-trash')}</button><button class="mini-icon" data-file-action="menu" title="File actions" aria-label="Actions for ${escapeHtml(name)}">${svg('i-more')}</button></span>`;
    if (file.dirty) {
      const meta = row.querySelector('.file-meta');
      meta.className = 'dirty-dot';
      meta.textContent = '';
    }
    row.addEventListener('click', event => {
      if (event.ctrlKey || event.metaKey) {
        if (this.selectedFiles.has(file.path)) this.selectedFiles.delete(file.path); else this.selectedFiles.add(file.path);
        this.renderFileTree();
      } else {
        this.selectedFiles = new Set([file.path]);
        this.renderFileTree();
        this.openExplorerFile(file.path);
      }
    });
    row.addEventListener('dblclick', event => {
      event.preventDefault();
      if (isDataPath(file.path)) this.openExplorerFile(file.path, { data: true });
      else if (isPreviewable(file.path)) this.openExplorerFile(file.path, { preview: true });
    });
    row.addEventListener('contextmenu', event => {
      event.preventDefault();
      if (!this.selectedFiles.has(file.path)) this.selectedFiles = new Set([file.path]);
      this.renderFileTree();
      this.showFileContextMenu(file.path, event.clientX, event.clientY);
    });
    row.addEventListener('keydown', event => {
      if (event.target !== row) return;
      if (event.key === 'Delete') {
        event.preventDefault();
        this.deleteFiles(this.selectedFiles.has(file.path) ? [...this.selectedFiles] : [file.path]);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        this.selectedFiles = new Set([file.path]);
        this.openExplorerFile(file.path);
      } else if (event.key === ' ') {
        event.preventDefault();
        if (this.selectedFiles.has(file.path)) this.selectedFiles.delete(file.path); else this.selectedFiles.add(file.path);
        this.renderFileTree();
      }
    });
    const deleteButton = row.querySelector('[data-file-action="delete"]');
    deleteButton.disabled = this.engine.running || this.fileMutationPending || this.runtimeFilesLoading;
    deleteButton.addEventListener('click', event => {
      event.stopPropagation();
      this.deleteFiles([file.path]);
    });
    row.querySelector('[data-file-action="menu"]').addEventListener('click', event => {
      event.stopPropagation();
      if (!this.selectedFiles.has(file.path)) this.selectedFiles = new Set([file.path]);
      this.renderFileTree();
      this.showFileContextMenu(file.path, event.clientX, event.clientY);
    });
    return row;
  }

  showFileContextMenu(path, x, y) {
    const file = this.explorerFile(path);
    if (!file) return;
    if (!this.selectedFiles.has(path)) this.selectedFiles = new Set([path]);
    const selected = [...this.selectedFiles].filter(item => this.explorerFile(item));
    const busy = this.engine.running || this.fileMutationPending || this.runtimeFilesLoading;
    this.ui.showMenu(null, [
      { label: 'Open', icon: 'i-file', disabled: file.runtimeOnly && busy, action: () => this.openExplorerFile(path) },
      { label: 'Open in data viewer', icon: 'i-table', disabled: !isDataPath(path) || busy, action: () => this.openDataFile(path) },
      { label: 'Preview document', icon: 'i-book', disabled: !isPreviewable(path) || busy, action: () => this.openExplorerFile(path, { preview: true }) },
      ...(file.runtimeOnly ? [{ label: 'Keep in project', icon: 'i-save', disabled: busy, action: () => this.keepRuntimeFile(path) }] : []),
      { type: 'separator' },
      { label: 'Rename…', icon: 'i-code', disabled: selected.length !== 1 || file.runtimeOnly || busy, action: () => this.renameFile(path) },
      { label: 'Download', icon: 'i-download', disabled: busy && file.inRuntime, action: () => selected.length > 1 ? this.downloadZip(selected, 'webr-studio-selection.zip') : this.downloadFile(path) },
      { label: 'Copy R path', icon: 'i-copy', action: () => copyText(file.virtualPath) },
      { type: 'separator' },
      { label: `Delete ${selected.length > 1 ? `${selected.length} files` : basename(path)}`, icon: 'i-trash', disabled: busy, action: () => this.deleteFiles(selected) }
    ], { context: true, x, y });
  }

  renderEditorTabs() {
    const tabs = $('#editor-tabs');
    tabs.replaceChildren();
    this.openTabs = this.openTabs.filter(path => this.files.has(path));
    for (const path of this.openTabs) {
      const file = this.files.get(path);
      const button = document.createElement('button');
      button.className = `tab editor-tab${this.activePath === path ? ' active' : ''}${file.dirty ? ' dirty' : ''}`;
      button.dataset.path = path;
      button.title = path;
      const iconId = isDataPath(path) ? 'i-table' : isPreviewable(path) ? 'i-book' : 'i-code';
      button.innerHTML = `${svg(iconId, 'tab-icon')}<span class="tab-name">${escapeHtml(basename(path))}</span><span class="tab-close" title="Close">${svg('i-x')}</span>`;
      button.addEventListener('click', event => {
        if (event.target.closest('.tab-close')) this.closeTab(path);
        else this.openFile(path);
      });
      button.addEventListener('auxclick', event => { if (event.button === 1) this.closeTab(path); });
      tabs.append(button);
    }
  }

  updateActiveFileUi() {
    const file = this.resolveActiveFile();
    const path = file?.path || 'No file';
    const parts = path.split('/');
    $('#editor-breadcrumbs').innerHTML = `<span>project</span>${parts.map(part => `${svg('i-chevron')}<span>${escapeHtml(part)}</span>`).join('')}`;
    $('#language-mode-button').textContent = file ? (extname(path) || 'Text').toUpperCase() : 'Text';
    const renderButton = $('#preview-active-button');
    const previewable = Boolean(file && isPreviewable(path));
    renderButton.hidden = !previewable;
    renderButton.disabled = !previewable;
    const gfmButton = $('#download-preview-gfm');
    const rMarkdown = Boolean(file && extname(path) === 'rmd');
    gfmButton.hidden = !rMarkdown;
    gfmButton.disabled = !rMarkdown;
    const sourceable = Boolean(file && extname(path) === 'r');
    $('#run-selection-button').disabled = !this.runtimeAvailable || !file;
    $('#run-script-button').disabled = !this.runtimeAvailable || !sourceable;
    $('#source-options-button').disabled = !this.runtimeAvailable || !sourceable;
  }

  updateCursorStatus(position = { row: 0, column: 0 }) {
    $('#cursor-position').textContent = `Ln ${position.row + 1}, Col ${position.column + 1}`;
  }

  requireIdleRuntime(action = 'This action', offlineDetail = 'Start or restart webR and try again.') {
    if (this.fileMutationPending) {
      this.ui.toast('Files are busy', `${action} is available after the current file operation finishes.`, 'warning');
      return false;
    }
    if (!this.engine.ready) {
      this.ui.toast('R is offline', offlineDetail, 'warning');
      return false;
    }
    if (!this.projectPersistenceReady) {
      this.ui.toast('Project files are not ready', 'Restart R to finish restoring the saved project before using the runtime.', 'warning');
      return false;
    }
    if (this.engine.running) {
      this.ui.toast('R is busy', `${action} is available after the current R operation finishes.`, 'warning');
      return false;
    }
    return true;
  }

  async finalizeExecution(result) {
    this.assistant?.recordExecution(result);
    await this.handleViewOutputs(result);
    await this.console.appendExecution(result, {
      showTiming: this.settings.timing,
      showTraceback: this.settings.autoTraceback
    });
    await this.flushPendingMirrors();
    await this.refreshEnvironment({ retry: true });
    this.runtimeFilesRefreshPending = true;
    await this.refreshRuntimeFiles(this.runtimeFilesPath, { quiet: true });
    if (result.ok && this.settings.checkpointEnvironment) this.checkpointDebounced();
    if (!result.ok) this.console.focus();
    return result;
  }

  async executeCode(code, { echo = true } = {}) {
    const source = String(code || '');
    if (!source.trim()) return;
    if (this.fileMutationPending) {
      this.ui.toast('Files are busy', 'Wait for the file operation to finish before running R code.', 'warning');
      return;
    }

    const helpRequest = extractHelpRequest(source);
    if (helpRequest) {
      if (echo) await this.console.appendEntry('command', source, { persist: true });
      await this.openHelp(helpRequest.topic, { package: helpRequest.package });
      return { ok: true, outputs: [], plots: [], traceback: [], error: '', elapsed: 0, help: true };
    }

    if (!this.engine.ready) {
      this.ui.toast('R is not ready', 'The editor remains available, but code execution requires the webR runtime.', 'warning');
      return;
    }
    if (!this.projectPersistenceReady) {
      this.ui.toast('Project files are not ready', 'Restart R to finish restoring the saved project before running code.', 'warning');
      return;
    }
    if (this.engine.running) {
      this.ui.toast('R is busy', 'Stop the current expression or wait for it to finish before running another.', 'warning');
      return;
    }
    try {
      await this.saveDirtyFiles();
      await this.flushPendingMirrors();
      await this.syncPlotDeviceToViewer({ reflowCurrent: false });
      if (echo) await this.console.appendEntry('command', source, { persist: true });
      const stream = this.console.beginStream();
      const pendingViews = [];
      let streamedConsoleOutput = false;
      let result;
      try {
        result = await this.engine.execute(source, {
          onOutput: async item => {
            if (item.type === 'view') {
              const request = parseViewPayload(item.text);
              if (request.name) pendingViews.push(request);
              return;
            }
            streamedConsoleOutput = true;
            await this.console.appendStreamItem(stream, item);
          }
        });
      } finally {
        this.console.endStream(stream);
      }
      result.streamed = streamedConsoleOutput;
      if (result.cancelled) return result;
      const finalized = await this.finalizeExecution(result);
      // Fetch Viewer data only after the REPL has returned. Querying R from a
      // View() stream callback would pause output consumption while R is busy.
      for (const request of pendingViews) {
        this.activatePanel('data');
        await this.dataViewer?.openObject(request.name, request.title || request.name);
      }
      return finalized;
    } catch (error) {
      this.ui.toast('R execution could not start', error.message || String(error), 'error', 0);
      await this.console.appendEntry('error', error.message || String(error), { persist: true });
      return { ok: false, outputs: [], plots: [], traceback: [], error: error.message || String(error), elapsed: 0 };
    }
  }

  async sourceActiveFile({ echo = false } = {}) {
    const file = this.resolveActiveFile();
    if (!file || extname(file.path) !== 'r') {
      this.ui.toast('No R script to source', 'Open an .R file first.', 'info');
      return;
    }
    if (!this.requireIdleRuntime('Sourcing')) return;
    try {
      await this.saveDirtyFiles();
      await this.flushPendingMirrors();
      await this.syncPlotDeviceToViewer({ reflowCurrent: false });
      const displayedPath = `/project/${projectRelativePath(file.path)}`;
      await this.console.appendEntry(
        'command',
        `source(${JSON.stringify(displayedPath)}, echo = ${echo ? 'TRUE' : 'FALSE'})`,
        { persist: true }
      );
      const stream = this.console.beginStream();
      const pendingViews = [];
      let result;
      try {
        result = await this.engine.sourceFile(file.path, {
          echo,
          onOutput: async item => {
            if (item.type === 'view') {
              const request = parseViewPayload(item.text);
              if (request.name) pendingViews.push(request);
              return;
            }
            await this.console.appendStreamItem(stream, item);
          }
        });
      } finally {
        this.console.endStream(stream);
      }
      if (result.cancelled) return result;
      const finalized = await this.finalizeExecution(result);
      // Fetch Viewer data only after the REPL has returned. Querying R from a
      // View() stream callback would pause output consumption while R is busy.
      for (const request of pendingViews) {
        this.activatePanel('data');
        await this.dataViewer?.openObject(request.name, request.title || request.name);
      }
      return finalized;
    } catch (error) {
      this.ui.toast('Could not source the script', error.message || String(error), 'error', 0);
      await this.console.appendEntry('error', error.message || String(error), { persist: true });
      return { ok: false, outputs: [], plots: [], traceback: [], error: error.message || String(error), elapsed: 0 };
    }
  }

  async handleViewOutputs(result) {
    const requests = (result?.outputs || []).filter(item => item.type === 'view').map(item => parseViewPayload(item.text));
    if (result?.outputs) result.outputs = result.outputs.filter(item => item.type !== 'view');
    for (const request of requests) {
      if (!request.name) continue;
      this.activatePanel('data');
      await this.dataViewer?.openObject(request.name, request.title || request.name);
    }
  }

  async stopExecution() {
    if (!this.engine.running) return;
    $('#stop-button').disabled = true;
    const request = this.engine.requestInterrupt();
    if (request.ok) {
      if (request.reason === 'requested') {
        await this.console.appendEntry(
          'message',
          'Interrupt requested. The current R session and its objects will be preserved.',
          { persist: true }
        );
      }
      return;
    }

    if (request.reason === 'preparing') {
      $('#stop-button').disabled = false;
      this.ui.toast('R is preparing the command', 'The interrupt was not sent before user-code evaluation began. Press Stop again once R is running.', 'info', 5000);
      return;
    }

    if (request.reason === 'finishing') {
      await this.console.appendEntry(
        'info',
        'R has already finished evaluating the expression and is finalizing its output. No interrupt was sent.',
        { persist: true }
      );
      return;
    }

    if (request.reason === 'unsupported') {
      // PostMessage cannot interrupt running R code. Never replace the worker as
      // an implicit Stop fallback because doing so destroys the user's R state.
      $('#stop-button').disabled = false;
      await this.console.appendEntry(
        'warning',
        'State-preserving interruption is unavailable in this session. The current command will continue, and the R worker was not restarted.',
        { persist: true }
      );
      this.ui.toast(
        'R could not be interrupted',
        'This page is using webR’s PostMessage channel. Reload after cross-origin isolation becomes active, or serve the app with COOP and COEP headers.',
        'warning',
        9000
      );
      return;
    }

    $('#stop-button').disabled = false;
    this.ui.toast('R could not be interrupted', request.error?.message || 'The interrupt request failed.', 'error', 7000);
  }


  async restartRuntime(confirm = false, {
    version = this.settings.webrVersion
  } = {}) {
    if (this.fileMutationPending) {
      this.ui.toast('Files are busy', 'Wait for the file operation to finish before restarting R.', 'warning');
      return false;
    }
    if (confirm) {
      const accepted = await this.ui.confirm(
        'Restart webR?',
        'The current R worker will be replaced. When R is idle, all /project files are saved first. If R is still running, changes made since the last completed backup may be lost. Files outside /project remain temporary. The latest environment checkpoint will be restored when available.',
        { acceptLabel: 'Restart R', danger: false }
      );
      if (!accepted) return;
    }
    this.console?.resetExecutionState();
    try {
      const wasRunning = this.engine.running;
      if (!wasRunning && this.engine.ready && this.projectPersistenceReady) await this.flushProjectBackup();
      else if (!wasRunning) await this.saveDirtyFiles();
      if (this.engine.ready && this.settings.checkpointEnvironment && !this.engine.running) await this.saveRCheckpoint();
      this.projectBackupDebounced.cancel();
      this.projectPersistenceReady = false;
      this.projectPersistenceEpoch += 1;
      this.runtimeFilesRequest += 1;
      this.projectSnapshotInProgress = false;
      this.fileMutationPending = true;
      if (wasRunning) {
        // Closing the old worker cancels its RPCs. Do not wait for filesystem
        // work queued behind a running expression or interactive prompt.
        this.mirrorOperationQueue = Promise.resolve();
        this.ui.toast('Restoring the last project backup', 'R was still running. Files written after the last completed backup may be lost.', 'warning', 8000);
      }
      const requestedVersion = normalizeWebRVersion(version);
      this.setRuntimeState('loading', 'Restarting R…');
      await this.engine.restart({
        version: requestedVersion,
        plotWidth: this.settings.plotWidth,
        plotHeight: this.settings.plotHeight,
        onProgress: (_progress, message) => this.setRuntimeState('loading', message)
      });
      await this.restoreProjectFiles();
      if (this.settings.restoreEnvironment) {
        const checkpoint = await workspaceDB.get('rCheckpoint', null);
        if (checkpoint?.length || checkpoint?.byteLength) await this.engine.restoreEnvironment(checkpoint);
      }
      this.runtimeAvailable = true;
      this.runtimeFilesPath = '/project';
      this.runtimeFiles = [];
      this.runtimeProjectFiles.clear();
      this.runtimeFilesError = '';
      this.runtimeFilesRefreshPending = true;
      this.projectPersistenceReady = true;
      this.fileMutationPending = false;
      await Promise.all([
        this.refreshEnvironment(),
        this.refreshPackages(),
        this.refreshRuntimeFiles('/project', { quiet: true })
      ]);
      this.setRuntimeState('ready', this.runtimeReadyLabel());
      this.lastPlotDeviceSize = null;
      this.lastPlotViewerRect = null;
      this.pendingPlotReflow = true;
      requestAnimationFrame(() => this.plotResizeDebounced());
      await this.console.appendEntry(
        'success',
        `webR ${this.engine.version} restarted. ${this.engine.rVersion}`,
        { persist: true }
      );
      return true;
    } catch (error) {
      this.fileMutationPending = false;
      this.runtimeAvailable = false;
      this.setRuntimeState('error', 'Restart failed');
      this.ui.toast('webR restart failed', error.message, 'error', 0);
      return false;
    } finally {
      // A cancelled console submission may never settle against the old
      // worker. Always restore editability after an explicit restart attempt.
      this.console?.resetExecutionState();
    }
  }

  runtimeReadyLabel() {
    const version = conciseRVersion(this.engine.rVersion);
    return version ? `R ready · R ${version}` : 'R ready';
  }

  setRuntimeState(state, label, { canStop = state === 'running' } = {}) {
    this.console?.setRuntimeBusy(state === 'running' || state === 'loading');
    const status = $('#r-status');
    status.dataset.state = state;
    status.querySelector('.runtime-label').textContent = label;
    $('#runtime-status-detail').dataset.state = state === 'ready' ? 'ready' : state;
    $('#stop-button').disabled = state !== 'running' || !canStop;
    const sourceable = Boolean(this.activePath && extname(this.activePath) === 'r');
    $('#run-selection-button').disabled = state !== 'ready' || !this.activePath;
    $('#run-script-button').disabled = state !== 'ready' || !sourceable;
    $('#source-options-button').disabled = state !== 'ready' || !sourceable;
    $('#restart-r-button').disabled = state === 'loading';
    $('#apply-webr-version').disabled = state === 'loading' || state === 'running';
    $('#webr-version-input').disabled = state === 'loading' || state === 'running';
    this.renderRuntimeFiles();
    this.assistant?.updateState();
  }

  async showRuntimeInfo() {
    if (!this.requireIdleRuntime('Runtime inspection', 'The R worker is offline.')) return;
    try {
      const info = await this.engine.getRuntimeInfo();
      this.ui.toast(
        `${info.R}`,
        `webR ${info.webR} · ${info.platform} · ${info.channel} channel · R heap ${info.memoryMb.toFixed(1)} MB`,
        'info',
        9000
      );
    } catch (error) {
      this.ui.toast('Runtime information unavailable', error.message, 'error');
    }
  }

  async saveRCheckpoint() {
    if (!this.engine.ready || this.engine.running || !this.settings.checkpointEnvironment) return;
    try {
      const bytes = await this.engine.checkpointEnvironment();
      await workspaceDB.set('rCheckpoint', bytes);
    } catch (error) {
      console.warn('Could not checkpoint R environment:', error);
    }
  }

  async exportRData() {
    if (!this.requireIdleRuntime('Environment export', 'Start or restart webR before exporting the environment.')) return;
    try {
      const bytes = await this.engine.exportEnvironment();
      downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), localTimestampName('webr-studio-environment', 'RData'));
      this.ui.toast('Environment exported', 'The global environment was saved as an .RData file.', 'success');
    } catch (error) {
      this.ui.toast('Could not export environment', error.message, 'error', 0);
    }
  }

  async importRData(file) {
    if (!file) return;
    if (!this.requireIdleRuntime('Environment import', 'Start or restart webR before loading an .RData file.')) return;
    try {
      const bytes = await readFileAsBytes(file);
      await this.engine.importEnvironment(bytes);
      await workspaceDB.set('rCheckpoint', bytes);
      await this.refreshEnvironment();
      this.ui.toast('Environment loaded', `${file.name} was restored into the global environment.`, 'success');
    } catch (error) {
      this.ui.toast('Could not load environment', error.message, 'error', 0);
    }
  }

  async refreshEnvironment({ retry = true } = {}) {
    if (!this.engine.ready || this.engine.running) return;
    try {
      this.environment = await this.engine.getEnvironment();
      this.environmentError = '';
      this.assistant?.refreshObjectChoices();
      this.renderEnvironment();
    } catch (error) {
      if (retry && this.engine.ready && !this.engine.running) {
        await new Promise(resolve => window.setTimeout(resolve, 80));
        return this.refreshEnvironment({ retry: false });
      }
      this.environmentError = error.message || String(error);
      this.renderEnvironment();
      console.warn('Environment refresh failed:', error);
    }
  }

  renderEnvironment() {
    const container = $('#environment-table');
    const query = ($('#environment-filter').value || '').toLocaleLowerCase();
    const objects = this.environment.filter(object => `${object.name} ${object.className} ${object.type}`.toLocaleLowerCase().includes(query));
    if (this.environmentError) {
      container.className = 'environment-table empty-state';
      container.innerHTML = `${svg('i-box')}<p>Environment refresh failed.<br><small>${escapeHtml(this.environmentError)}</small></p><button type="button" class="button secondary compact">Retry</button>`;
      container.querySelector('button').addEventListener('click', () => this.refreshEnvironment());
      return;
    }
    if (!objects.length) {
      container.className = 'environment-table empty-state';
      container.innerHTML = `${svg('i-box')}<p>${this.environment.length ? 'No objects match the filter.' : 'The global environment is empty.'}</p>`;
      return;
    }
    container.className = 'environment-table';
    container.innerHTML = '<div class="env-header"><span>Name</span><span>Class</span><span>Size</span><span></span></div>';
    for (const object of objects) {
      const row = document.createElement('div');
      row.className = 'env-row';
      row.dataset.name = object.name;
      const typeClass = object.isData ? 'data' : object.isFunction ? 'function' : '';
      row.innerHTML = `
        <div class="env-name"><span class="env-type-icon ${typeClass}">${escapeHtml(environmentTypeLabel(object))}</span><span title="${escapeHtml(object.name)}">${escapeHtml(object.name)}</span></div>
        <div class="env-class" title="${escapeHtml(object.className)}">${escapeHtml(object.className || object.type)}</div>
        <div class="env-size">${formatBytes(object.size)}</div>
        <button class="env-action" title="Remove object">${svg('i-x')}</button>
        <div class="env-preview" title="${escapeHtml(object.preview)}">${escapeHtml(object.dimensions ? `${object.dimensions} · ${object.preview}` : object.preview)}</div>`;
      row.querySelector('.env-action').addEventListener('click', event => {
        event.stopPropagation();
        this.removeEnvironmentObject(object.name);
      });
      row.addEventListener('click', () => {
        if (object.isFunction) this.editor.jumpToDefinition(object.name);
        else this.openDataObject(object.name);
      });
      row.addEventListener('dblclick', () => this.inspectObject(object));
      container.append(row);
    }
  }

  async inspectObject(object) {
    if (!object.isFunction) return this.openDataObject(object.name);
    if (!this.requireIdleRuntime('Object inspection')) return;
    try {
      const summary = await this.engine.getObjectSummary(object.name);
      await this.console.appendEntry('info', `${object.name}\n${summary}`, { persist: true });
      this.console.focus();
    } catch (error) {
      this.ui.toast('Inspection failed', error.message, 'error');
    }
  }

  async removeEnvironmentObject(name) {
    if (!this.requireIdleRuntime('Object removal')) return;
    const accepted = await this.ui.confirm(`Remove ${name}?`, 'The object will be deleted from the global R environment.', { acceptLabel: 'Remove' });
    if (!accepted) return;
    try {
      await this.engine.removeObject(name);
      await this.refreshEnvironment();
      this.checkpointDebounced();
    } catch (error) {
      this.ui.toast('Object removal failed', error.message, 'error');
    }
  }

  async clearEnvironment() {
    if (!this.requireIdleRuntime('Environment cleanup')) return;
    const accepted = await this.ui.confirm(
      'Clear the global environment?',
      'All user-created R objects will be removed. Project files and console history are not affected.',
      { acceptLabel: 'Clear all objects' }
    );
    if (!accepted) return;
    try {
      await this.engine.clearEnvironment();
      await workspaceDB.delete('rCheckpoint');
      await this.refreshEnvironment();
      await this.console.appendEntry('warning', 'The global R environment was cleared.', { persist: true });
    } catch (error) {
      this.ui.toast('Cleanup failed', error.message, 'error');
    }
  }

  runtimeFilesParent(path = this.runtimeFilesPath) {
    const normalized = String(path).replace(/\/+$/, '') || '/';
    if (normalized === '/') return '/';
    const parent = normalized.split('/').slice(0, -1).join('/');
    return parent || '/';
  }

  async refreshRuntimeFiles(path = this.runtimeFilesPath, { quiet = false } = {}) {
    const target = explicitVirtualPath(path);
    if (!this.engine.ready) {
      this.runtimeFilesRefreshPending = true;
      this.runtimeFilesPath = target;
      this.runtimeFilesError = '';
      this.renderRuntimeFiles();
      if (!quiet) this.ui.toast('R is offline', 'Start webR before browsing its virtual filesystem.', 'warning');
      return null;
    }
    if (!this.projectPersistenceReady) {
      this.runtimeFilesRefreshPending = true;
      return null;
    }
    if (this.engine.running || this.fileMutationPending) {
      this.runtimeFilesRefreshPending = true;
      if (!quiet) this.ui.toast('R is busy', 'Runtime files can be refreshed after the current expression finishes.', 'warning');
      this.renderRuntimeFiles();
      return null;
    }

    this.projectBackupDebounced.cancel();
    const request = ++this.runtimeFilesRequest;
    const epoch = this.projectPersistenceEpoch;
    this.runtimeFilesLoading = true;
    this.runtimeFilesError = '';
    this.projectPersistencePending = true;
    this.renderRuntimeFiles();
    let backupComplete = false;
    let retry = false;
    try {
      return await this.queueMirrorOperation(async () => {
        if (epoch !== this.projectPersistenceEpoch || !this.projectPersistenceReady ||
            !this.engine.ready || this.engine.running || this.fileMutationPending) {
          retry = true;
          return null;
        }
        this.fileMutationPending = true;
        this.projectSnapshotInProgress = true;
        this.updateProjectSaveStatus();
        try {
          await this.performPendingMirrors();
          const context = { epoch, runtime: this.engine.webR, generation: this.engine.generation,
            revision: this.projectRuntimeRevision };
          const project = await this.engine.listProjectFiles();
          if (request !== this.runtimeFilesRequest || epoch !== this.projectPersistenceEpoch) return null;
          const previous = this.runtimeProjectFiles;
          this.runtimeProjectFiles = new Map(project.entries.map(entry => [entry.path.slice('/project/'.length), entry]));
          for (const [relative, entry] of this.runtimeProjectFiles) {
            if (entry.isDirectory && !previous.has(relative)) this.expandedFolders.add(relative);
          }
          await this.persistRuntimeProject(project, context);
          backupComplete = true;
          const inProject = target === '/project' || target.startsWith('/project/');
          const directory = inProject && target !== '/project' &&
            !project.entries.some(entry => entry.path === target && entry.isDirectory) ? '/project' : target;
          const listing = inProject
            ? { path: directory, entries: project.entries.filter(entry => this.runtimeFilesParent(entry.path) === directory) }
            : await this.engine.listVirtualFiles(target);
          if (request !== this.runtimeFilesRequest || epoch !== this.projectPersistenceEpoch) return null;
          if (directory !== this.runtimeFilesPath) this.selectedFiles.clear();
          this.runtimeFilesPath = listing.path;
          this.runtimeFiles = listing.entries;
          this.runtimeFilesRefreshPending = this.projectPersistencePending;
          return listing;
        } finally {
          if (epoch === this.projectPersistenceEpoch) {
            this.projectSnapshotInProgress = false;
            this.fileMutationPending = false;
          }
        }
      });
    } catch (error) {
      if (request !== this.runtimeFilesRequest || epoch !== this.projectPersistenceEpoch) return null;
      if (error.name === 'ProjectSnapshotChanged') {
        this.projectPersistencePending = true;
        retry = true;
        return null;
      }
      this.runtimeFilesPath = target;
      this.runtimeFilesError = error.message || String(error);
      this.runtimeFilesRefreshPending = true;
      if (!backupComplete) {
        const notify = this.projectPersistenceError !== this.runtimeFilesError;
        this.projectPersistenceError = this.runtimeFilesError;
        this.projectPersistencePending = true;
        if (notify) this.ui.toast('Project backup could not be saved',
          `${this.runtimeFilesError} The previous backup is unchanged. Keep this page open and retry Refresh after resolving the problem.`, 'error', 0);
      } else if (!quiet) this.ui.toast('Could not open runtime directory', this.runtimeFilesError, 'error');
      return null;
    } finally {
      if (request === this.runtimeFilesRequest) {
        this.runtimeFilesLoading = false;
        this.updateProjectSaveStatus();
        this.renderRuntimeFiles();
      }
      if (retry && this.projectPersistenceReady && !this.engine.running && !this.erasingLocalData) this.projectBackupDebounced();
    }
  }

  updateExplorerControls() {
    const pathInput = $('#runtime-files-path');
    if (!pathInput) return;
    const busy = Boolean(this.engine.running || this.runtimeFilesLoading || this.fileMutationPending);
    const interactive = Boolean(this.engine.ready && !busy);
    if (document.activeElement !== pathInput) pathInput.value = this.runtimeFilesPath;
    pathInput.disabled = !interactive;
    $('#runtime-files-up').disabled = !interactive || this.runtimeFilesPath === '/';
    $('#runtime-files-home').disabled = busy || this.runtimeFilesPath === '/project';
    $('#runtime-files-refresh').disabled = !interactive;
    $('#sidebar-delete-files').disabled = busy || ![...this.selectedFiles].some(path => this.explorerFile(path));
    const status = $('#explorer-file-status');
    if (this.runtimeFilesError) status.textContent = `Could not refresh: ${this.runtimeFilesError}`;
    else if (this.projectPersistenceError) status.textContent = `Project backup failed: ${this.projectPersistenceError}`;
    else if (this.runtimeFilesLoading) status.textContent = 'Refreshing files…';
    else if (this.fileMutationPending) status.textContent = 'Updating files…';
    else if (this.engine.running) status.textContent = 'R is running. Files refresh when it finishes.';
    else if (!this.engine.ready) status.textContent = 'Saved project files. Start R to restore them.';
    else if (this.projectPersistencePending) status.textContent = 'Project changes are waiting to be saved. Keep this page open.';
    else if (this.runtimeFilesPath === '/project' || this.runtimeFilesPath.startsWith('/project/')) status.textContent = 'All /project files are saved in this browser. Files and folders restore after a page refresh.';
    else status.textContent = 'Files outside /project are temporary. Use Keep in project to retain them.';
  }

  renderRuntimeFiles() {
    this.renderFileTree();
  }


  async refreshPackages() {
    if (!this.engine.ready || this.engine.running) return;
    try {
      this.packages = await this.engine.getPackages();
      this.renderPackages();
    } catch (error) {
      console.warn(error);
    }
  }

  renderPackages() {
    const container = $('#packages-table');
    const query = ($('#package-filter').value || '').toLocaleLowerCase();
    const packages = this.packages.filter(item => item.name.toLocaleLowerCase().includes(query));
    if (!packages.length) {
      container.className = 'packages-table empty-state';
      container.innerHTML = `${svg('i-box')}<p>${this.packages.length ? 'No installed packages match the filter.' : 'Package library will appear after R starts.'}</p>`;
      return;
    }
    container.className = 'packages-table';
    container.innerHTML = '<div class="package-header"><span>Use</span><span>Package</span><span>Version</span></div>';
    for (const item of packages) {
      const row = document.createElement('div');
      row.className = 'package-row';
      row.innerHTML = `<input type="checkbox" aria-label="Load ${escapeHtml(item.name)}" ${item.loaded ? 'checked' : ''}><span class="package-name">${escapeHtml(item.name)}${item.bundled ? ' <span class="badge">base</span>' : ''}</span><span class="package-version">${escapeHtml(item.version)}</span>`;
      row.querySelector('input').addEventListener('change', async event => {
        if (!this.requireIdleRuntime('Package loading')) {
          event.target.checked = item.loaded;
          return;
        }
        event.target.disabled = true;
        try {
          await this.engine.setPackageLoaded(item.name, event.target.checked);
          item.loaded = event.target.checked;
          await this.refreshEnvironment();
        } catch (error) {
          event.target.checked = !event.target.checked;
          this.ui.toast('Package action failed', error.message, 'error');
        } finally {
          event.target.disabled = false;
        }
      });
      container.append(row);
    }
  }

  async installPackage() {
    if (!this.requireIdleRuntime('Package installation', 'Start webR before installing packages.')) return;
    const value = await this.ui.prompt('Install Wasm R packages', 'Enter one or more package names separated by commas or spaces.', { placeholder: 'ggplot2 data.table', acceptLabel: 'Install' });
    if (!value) return;
    const packages = value.split(/[\s,]+/).filter(Boolean);
    if (!packages.length) return;
    try {
      await this.console.appendEntry('info', `Installing ${packages.join(', ')} from the webR package repository…`, { persist: true });
      await this.engine.installPackages(packages);
      await this.refreshPackages();
      await this.console.appendEntry('success', `Installed ${packages.join(', ')}.`, { persist: true });
      this.ui.toast('Packages installed', packages.join(', '), 'success');
    } catch (error) {
      await this.console.appendEntry('error', error.message, { persist: true });
      this.ui.toast('Package installation failed', error.message, 'error', 0);
    }
  }

  async refreshPanel(panel) {
    if (panel === 'environment') return this.refreshEnvironment({ retry: true });
    if (panel === 'files') return this.refreshRuntimeFiles(this.runtimeFilesPath);
    if (panel === 'packages') return this.refreshPackages();
    if (panel === 'outline') return this.editor.updateOutline();
    if (panel === 'plots') {
      this.renderPlots();
      return this.plotResizeDebounced();
    }
    if (panel === 'preview') return this.previewActiveFile();
    if (panel === 'help' && this.currentHelpTopic) return this.openHelp(this.currentHelpTopic, { history: false, package: this.currentHelpPackage });
    if (panel === 'data') return this.dataViewer?.refresh();
  }

  async refreshActiveTopPanel() {
    const active = $('#right-top-pane .tab.active')?.dataset.panel;
    return this.refreshPanel(active);
  }

  renderOutline() {
    const container = $('#outline-list');
    const query = ($('#outline-filter').value || '').toLocaleLowerCase();
    const items = this.outline.filter(item => `${item.name} ${item.detail}`.toLocaleLowerCase().includes(query));
    if (!items.length) {
      container.className = 'outline-list empty-state';
      container.innerHTML = `${svg('i-list')}<p>${this.outline.length ? 'No symbols match the filter.' : 'No symbols in this file.'}</p>`;
      return;
    }
    container.className = 'outline-list';
    container.replaceChildren();
    const groups = [
      ['function', 'Functions'],
      ['object', 'Objects'],
      ['section', 'Sections']
    ];
    for (const [type, label] of groups) {
      const groupItems = items.filter(item => item.type === type);
      if (!groupItems.length) continue;
      const group = document.createElement('div');
      group.className = 'outline-group';
      group.innerHTML = `<div class="outline-group-title">${label}</div>`;
      for (const item of groupItems) {
        const button = document.createElement('button');
        button.className = `outline-item ${item.type}`;
        button.innerHTML = `<span class="outline-icon">${item.type === 'function' ? 'ƒ' : item.type === 'section' ? '§' : 'x'}</span><span class="symbol-name" title="${escapeHtml(item.detail)}">${escapeHtml(item.name)}</span><span class="line-number">${item.row + 1}</span>`;
        button.addEventListener('click', () => this.openFile(this.activePath, { row: item.row, column: item.column }));
        group.append(button);
      }
      container.append(group);
    }
  }

  renderProblems() {
    const container = $('#problems-list');
    $('#problem-count').textContent = String(this.diagnostics.length);
    if (!this.diagnostics.length) {
      container.className = 'problems-list empty-state compact-empty';
      container.innerHTML = `${svg('i-check')}<p>No diagnostics</p>`;
      return;
    }
    container.className = 'problems-list';
    container.replaceChildren();
    for (const diagnostic of this.diagnostics) {
      const row = document.createElement('div');
      row.className = `problem-row ${diagnostic.severity}`;
      row.innerHTML = `<header><span class="severity"></span><span class="message">${escapeHtml(diagnostic.message)}</span>${diagnostic.replacement != null ? '<button class="button ghost small">Fix</button>' : ''}</header><footer>${escapeHtml(basename(diagnostic.path || ''))}:${diagnostic.row + 1}:${diagnostic.column + 1} · ${escapeHtml(diagnostic.source)}</footer>`;
      row.addEventListener('click', () => this.openFile(diagnostic.path, { row: diagnostic.row, column: diagnostic.column }));
      row.querySelector('button')?.addEventListener('click', event => {
        event.stopPropagation();
        this.openFile(diagnostic.path, { row: diagnostic.row, column: diagnostic.column });
        if (this.editor.applyQuickFix(diagnostic)) this.ui.toast('Quick fix applied', diagnostic.message, 'success');
      });
      container.append(row);
    }
  }

  async highlightHelpCode(container) {
    if (!container) return;
    const blocks = [...container.querySelectorAll('pre')];
    for (const block of blocks) {
      const source = block.textContent || '';
      if (!source.trim()) continue;
      block.classList.add('help-code-block');
      try {
        block.innerHTML = await EditorManager.highlightR(source.replace(/^\n+|\n+$/g, ''));
      } catch {
        block.textContent = source;
      }
    }
  }

  async openHelp(topic, { history = true, package: packageName = '' } = {}) {
    let requested = String(topic || '').trim().replace(/\(.*$/, '').replace(/^`|`$/g, '');
    let requestedPackage = String(packageName || '').trim();
    const namespaced = requested.match(/^([A-Za-z.][A-Za-z0-9._]*)\s*:{2,3}\s*([A-Za-z.][A-Za-z0-9._]*)$/);
    if (namespaced) {
      requestedPackage ||= namespaced[1];
      requested = namespaced[2];
    }
    const cleanTopic = requested.replace(/^.*:::+/, '');
    const cleanPackage = /^[A-Za-z.][A-Za-z0-9._]*$/.test(requestedPackage) ? requestedPackage : '';
    if (!cleanTopic) return this.ui.toast('R help', 'Place the cursor on a function name or enter a topic in the Help pane.', 'info');
    if (!this.requireIdleRuntime('R help')) return;
    this.activatePanel('help');
    const viewer = $('#help-viewer');
    viewer.className = 'help-viewer prose empty-state';
    viewer.innerHTML = `<span class="status-dot"></span><p>Opening help for ${escapeHtml(cleanPackage ? `${cleanPackage}::${cleanTopic}` : cleanTopic)}…</p>`;
    $('#help-search').value = cleanPackage ? `${cleanPackage}::${cleanTopic}` : cleanTopic;
    try {
      const html = await this.engine.getHelp(cleanTopic, cleanPackage);
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const title = parsed.querySelector('title')?.textContent || cleanTopic;
      const body = parsed.body?.innerHTML || html;
      viewer.className = 'help-viewer prose';
      viewer.innerHTML = `<h1>${escapeHtml(title.replace(/\s+[\u2013\u2014].*$/, ''))}</h1>${sanitizeHtml(body)}`;
      viewer.querySelectorAll('a[href]').forEach(link => {
        const href = link.getAttribute('href') || '';
        const topicMatch = href.match(/([^/]+)\.html(?:#.*)?$/);
        const packageMatch = href.match(/(?:library\/|\.\.\/)([A-Za-z.][A-Za-z0-9._]*)\/html\/[^/]+\.html/i);
        if (topicMatch && !/^(https?:|mailto:)/i.test(href)) {
          link.addEventListener('click', event => {
            event.preventDefault();
            this.openHelp(topicMatch[1], { package: packageMatch?.[1] || cleanPackage });
          });
        } else if (/^https?:/i.test(href)) {
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
      });
      await this.highlightHelpCode(viewer);
      this.currentHelpTopic = cleanTopic;
      this.currentHelpPackage = cleanPackage;
      if (history) {
        const entry = { topic: cleanTopic, package: cleanPackage };
        this.helpHistory = this.helpHistory.slice(0, this.helpHistoryIndex + 1);
        const last = this.helpHistory.at(-1);
        if (!last || last.topic !== entry.topic || last.package !== entry.package) this.helpHistory.push(entry);
        this.helpHistoryIndex = this.helpHistory.length - 1;
      }
      this.updateHelpNavigation();
    } catch (error) {
      viewer.className = 'help-viewer prose empty-state';
      viewer.innerHTML = `${svg('i-help')}<p>${escapeHtml(error.message)}</p>`;
    }
  }

  navigateHelp(direction) {
    const target = this.helpHistoryIndex + direction;
    if (target < 0 || target >= this.helpHistory.length) return;
    this.helpHistoryIndex = target;
    const entry = this.helpHistory[target];
    this.openHelp(entry.topic, { history: false, package: entry.package || '' });
    this.updateHelpNavigation();
  }

  updateHelpNavigation() {
    $('#help-back').disabled = this.helpHistoryIndex <= 0;
    $('#help-forward').disabled = this.helpHistoryIndex >= this.helpHistory.length - 1;
  }

  async openDataObject(name) {
    if (!this.requireIdleRuntime('Data inspection')) return;
    this.activatePanel('data');
    await this.dataViewer.openObject(name);
  }

  async openDataFile(path) {
    const entry = this.explorerFile(path);
    const file = entry?.stored;
    if (!entry || !isDataPath(path)) return;
    this.activatePanel('data');
    const delimiter = extname(path) === 'tsv' ? '\t' : ',';
    if (this.engine.ready && !this.engine.running && !this.fileMutationPending) {
      try {
        // A clean saved copy may be older than a file R just wrote. Read the
        // runtime version without copying stale project bytes over it.
        if (file && (!entry.inRuntime || file.dirty || this.pendingMirrors.has(path))) {
          if (file.dirty) await this.saveFile(path);
          else await this.mirrorFilesWhenIdle([file]);
        }
        const objectName = await this.engine.loadDelimitedFile(entry.virtualPath, delimiter);
        await this.dataViewer.openObject(objectName, basename(path));
        return;
      } catch (error) {
        this.ui.toast('R data import fell back to a local preview', error.message, 'warning');
      }
    } else if (this.engine.running) {
      this.ui.toast('R is busy', 'Showing a local table preview. Reopen the file after execution to import it into R.', 'info');
    }
    try {
      const content = file?.dirty || this.engine.running ? file?.content : await this.explorerFileContent(path);
      if (content == null) throw new Error('Wait for R to finish before opening this session file.');
      const text = typeof content === 'string' ? content : textDecoder.decode(content);
      this.dataViewer.openDelimited(path, text, delimiter);
    } catch (error) {
      this.ui.toast('Could not open data file', error.message || String(error), 'warning');
    }
  }

  bindPlotResizing() {
    const viewer = $('#plot-viewer');
    if (!viewer) return;
    const schedule = () => {
      const rect = viewer.getBoundingClientRect();
      const previous = this.lastPlotViewerRect;
      this.lastPlotViewerRect = { width: rect.width, height: rect.height };
      if (!previous || Math.abs(previous.width - rect.width) > 1 || Math.abs(previous.height - rect.height) > 1) {
        this.pendingPlotReflow = true;
        this.plotResizeDebounced();
      }
    };
    if ('ResizeObserver' in window) {
      this.plotResizeObserver?.disconnect();
      this.plotResizeObserver = new ResizeObserver(() => requestAnimationFrame(schedule));
      this.plotResizeObserver.observe(viewer);
      this.plotResizeObserver.observe($('#right-bottom-pane'));
    } else {
      window.addEventListener('resize', schedule);
    }
    requestAnimationFrame(schedule);
  }

  responsivePlotDeviceSize() {
    const viewer = $('#plot-viewer');
    const rect = viewer?.getBoundingClientRect();
    const fallback = {
      width: Number(this.settings.plotWidth) || 7,
      height: Number(this.settings.plotHeight) || 5
    };
    if (!rect || rect.width < 120 || rect.height < 100) return fallback;
    const aspect = clamp(rect.width / rect.height, 0.5, 3.2);
    const area = clamp(fallback.width * fallback.height, 8, 180);
    let width = Math.sqrt(area * aspect);
    let height = Math.sqrt(area / aspect);
    width = clamp(width, 2, 20);
    height = clamp(height, 2, 20);
    return { width: Number(width.toFixed(2)), height: Number(height.toFixed(2)) };
  }

  async syncPlotDeviceToViewer({ reflowCurrent = true } = {}) {
    if (!this.engine.ready) return;
    if (this.engine.running) {
      if (reflowCurrent) this.pendingPlotReflow = true;
      return;
    }
    const next = this.responsivePlotDeviceSize();
    const previous = this.lastPlotDeviceSize;
    const sizeChanged = !previous || Math.abs(previous.width - next.width) >= 0.04 || Math.abs(previous.height - next.height) >= 0.04;
    if (sizeChanged) {
      await this.engine.setPlotSize(next.width, next.height);
      this.lastPlotDeviceSize = next;
    }

    const latestIsVisible = this.plots.length && this.plotIndex === this.plots.length - 1;
    if (!reflowCurrent || !latestIsVisible || (!sizeChanged && !this.pendingPlotReflow)) return;
    this.pendingPlotReflow = false;
    const replacement = await this.engine.replayLastPlot().catch(error => {
      console.warn('The current plot could not be reflowed:', error);
      return null;
    });
    if (!replacement || this.plotIndex !== this.plots.length - 1) return;
    const current = this.plots[this.plotIndex];
    this.plots[this.plotIndex] = {
      ...replacement,
      id: current.id,
      createdAt: current.createdAt,
      reflowedAt: Date.now(),
      deviceSize: next
    };
    this.renderPlots();
    this.persistWorkspaceDebounced();
  }

  addPlot(plot, { activate = true } = {}) {
    this.plots.push({ ...plot, id: plot.id || uid('plot') });
    if (this.plots.length > 30) this.plots = this.plots.slice(-30);
    this.plotIndex = this.plots.length - 1;
    this.renderPlots();
    if (activate) this.activatePanel('plots');
    this.persistWorkspaceDebounced();
  }

  renderPlots() {
    const viewer = $('#plot-viewer');
    $('#plot-count').textContent = String(this.plots.length);
    if (!this.plots.length || this.plotIndex < 0) {
      if (this.currentPlotUrl) URL.revokeObjectURL(this.currentPlotUrl);
      this.currentPlotUrl = '';
      viewer.className = 'plot-viewer empty-state';
      viewer.innerHTML = `${svg('i-chart')}<p>Plots appear here as scalable SVG.</p>`;
      $('#plot-position').textContent = 'No plots';
      $('#plot-previous').disabled = true;
      $('#plot-next').disabled = true;
      return;
    }
    this.plotIndex = clamp(this.plotIndex, 0, this.plots.length - 1);
    const plot = this.plots[this.plotIndex];
    if (this.currentPlotUrl) URL.revokeObjectURL(this.currentPlotUrl);
    this.currentPlotUrl = '';
    viewer.className = 'plot-viewer has-plot';
    viewer.replaceChildren();
    const frame = document.createElement('div');
    frame.className = 'plot-frame';
    const cleanSvg = sanitizeSvg(plot.svg);
    if (cleanSvg) {
      frame.innerHTML = cleanSvg;
      const graphic = frame.querySelector('svg');
      if (graphic) {
        graphic.removeAttribute('width');
        graphic.removeAttribute('height');
        graphic.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        graphic.classList.add('r-plot-svg');
        graphic.setAttribute('role', 'img');
        graphic.setAttribute('aria-label', `R plot ${this.plotIndex + 1}`);
        graphic.style.width = '100%';
        graphic.style.height = '100%';
      }
    } else {
      const image = document.createElement('img');
      this.currentPlotUrl = URL.createObjectURL(new Blob([plot.svg], { type: 'image/svg+xml' }));
      image.src = this.currentPlotUrl;
      image.alt = `R plot ${this.plotIndex + 1}`;
      image.draggable = false;
      frame.append(image);
    }
    viewer.append(frame);
    $('#plot-position').textContent = `${this.plotIndex + 1} of ${this.plots.length}`;
    $('#plot-previous').disabled = this.plotIndex <= 0;
    $('#plot-next').disabled = this.plotIndex >= this.plots.length - 1;
  }

  navigatePlot(direction) {
    if (!this.plots.length) return;
    this.plotIndex = clamp(this.plotIndex + direction, 0, this.plots.length - 1);
    this.renderPlots();
  }

  async exportCurrentPlot() {
    const plot = this.plots[this.plotIndex];
    if (!plot) return;
    const format = $('#plot-export-format').value;
    try {
      if (format === 'svg') {
        downloadText(plot.svg, localTimestampName('R-plot', 'svg'), 'image/svg+xml;charset=utf-8');
      } else {
        const blob = await rasterizeSvg(plot.svg, format, 2);
        downloadBlob(blob, localTimestampName('R-plot', format === 'jpeg' ? 'jpg' : format));
      }
    } catch (error) {
      this.ui.toast('Plot export failed', error.message, 'error');
    }
  }

  async clearPlots() {
    if (!this.plots.length) return;
    const accepted = await this.ui.confirm('Clear plot history?', 'All plots retained in this browser workspace will be removed.', { acceptLabel: 'Clear plots' });
    if (!accepted) return;
    this.plots = [];
    this.plotIndex = -1;
    this.renderPlots();
    this.persistWorkspaceDebounced();
  }

  async previewActiveFile(path = this.activePath) {
    const file = this.files.get(path);
    if (!file || !isPreviewable(path)) {
      this.ui.toast('No document to render', 'Open a Markdown or R Markdown file first.', 'info');
      return false;
    }
    if (path !== this.activePath) this.openFile(path);
    this.previewPath = path;
    this.activatePanel('preview');
    const source = path === this.activePath && this.editor ? this.editor.getValue() : String(file.content || '');
    const frontMatter = splitDocumentFrontMatter(source);
    const isRMarkdown = extname(path) === 'rmd';
    $('#preview-title').textContent = frontMatter.title || path;
    const preview = $('#document-preview');
    this.revokePreviewUrls();
    this.rMarkdownGfmArtifact = null;
    $('#download-preview-html').disabled = true;
    $('#download-preview-gfm').hidden = !isRMarkdown;
    $('#download-preview-gfm').disabled = true;
    try {
      if (isRMarkdown) {
        await this.renderRMarkdown(frontMatter.body, preview, {
          sourcePath: path,
          sourceDocument: source,
          title: frontMatter.title
        });
      } else {
        preview.className = 'document-preview prose';
        preview.innerHTML = renderMarkdown(frontMatter.body);
        renderMathInElement(preview);
        this.bindPreviewLinks(preview);
      }
      await this.hydratePreviewAssets(preview);
      return true;
    } finally {
      $('#download-preview-html').disabled = false;
      $('#download-preview-gfm').disabled = !isRMarkdown;
    }
  }

  async renderRMarkdown(source, preview, context = {}) {
    preview.className = 'document-preview prose';
    preview.replaceChildren();
    const blocks = splitRMarkdown(source);
    const sourcePath = context.sourcePath || this.previewPath || this.activePath || 'document.Rmd';
    const gfm = new RMarkdownGfmBuilder({
      stem: gfmDocumentStem(sourcePath),
      title: context.title || ''
    });
    const commitGfmArtifact = () => {
      this.rMarkdownGfmArtifact = {
        ...gfm.build(),
        sourcePath,
        sourceDocument: String(context.sourceDocument ?? source)
      };
    };
    const renderMarkdownBlock = async content => {
      const inline = await evaluateInlineRMarkdown(
        content,
        this.engine.ready && !this.engine.running ? expression => this.engine.evaluateInline(expression) : null
      );
      gfm.appendMarkdown(inline.gfm);
      const section = document.createElement('section');
      section.innerHTML = renderMarkdown(inline.preview);
      renderMathInElement(section);
      preview.append(...section.childNodes);
    };
    if (!blocks.some(block => block.type === 'r')) {
      await renderMarkdownBlock(source);
      this.bindPreviewLinks(preview);
      commitGfmArtifact();
      return;
    }

    const normalizedOptions = raw => Object.fromEntries(
      Object.entries(raw || {}).map(([key, value]) => [String(key).toLowerCase(), value])
    );
    const resultMode = options => String(options.results ?? 'markup').toLowerCase();
    const figureHidden = options => /^(?:hide|none|false)$/i.test(String(options['fig.show'] ?? ''));

    const appendSource = async (chunk, content) => {
      const pre = document.createElement('pre');
      pre.className = 'r-chunk-source';
      pre.innerHTML = await EditorManager.highlightR(content);
      chunk.append(pre);
    };

    const appendOutput = (chunk, item, options) => {
      // Raw stderr also carries progress; R conditions already have explicit
      // message, warning, and error types from the runtime helper.
      const kind = item.type;
      if (kind === 'message' && options.message === false) return;
      if (kind === 'warning' && options.warning === false) return;
      const mode = resultMode(options);
      if (['stdout', 'stderr'].includes(item.type) && (mode === 'hide' || mode === 'false')) return;
      const output = document.createElement('pre');
      output.className = `r-chunk-output output-${kind}`;
      const text = stripTerminalControlSequences(item.text || '');
      output.textContent = `${kind === 'warning' ? '⚠ ' : kind === 'error' ? '🧯 ' : kind === 'message' ? 'ℹ ' : ''}${text}`;
      chunk.append(output);
    };

    const appendAsisOutput = (chunk, text) => {
      const clean = stripTerminalControlSequences(text || '');
      if (!clean) return;
      const output = document.createElement('div');
      output.className = 'r-chunk-asis';
      output.innerHTML = renderMarkdown(clean);
      renderMathInElement(output);
      chunk.append(output);
    };

    const appendPlot = (chunk, plot, block, figure) => {
      const holder = document.createElement('figure');
      holder.className = `r-chunk-plot align-${figure.align}`;
      holder.style.width = figure.outWidth;
      holder.style.maxWidth = '100%';
      if (figure.outHeight) { holder.style.height = figure.outHeight; holder.classList.add('has-output-height'); }
      const cleanSvg = sanitizeSvg(plot.svg);
      if (cleanSvg) {
        holder.innerHTML = cleanSvg;
        const graphic = holder.querySelector('svg');
        if (graphic) {
          graphic.removeAttribute('width');
          graphic.removeAttribute('height');
          graphic.setAttribute('preserveAspectRatio', 'xMidYMid meet');
          graphic.classList.add('r-plot-svg');
          graphic.setAttribute('role', 'img');
          graphic.setAttribute('aria-label', `Plot from ${block.label || 'R chunk'}`);
          graphic.style.width = '100%';
          graphic.style.height = figure.outHeight ? '100%' : 'auto';
        }
      } else {
        const image = document.createElement('img');
        const url = URL.createObjectURL(new Blob([plot.svg], { type: 'image/svg+xml' }));
        this.previewObjectUrls.push(url);
        image.src = url;
        image.alt = `Plot from ${block.label || 'R chunk'}`;
        image.draggable = false;
        image.style.width = '100%';
        image.style.height = figure.outHeight ? '100%' : 'auto';
        image.style.objectFit = 'contain';
        holder.append(image);
      }
      if (figure.caption) {
        const caption = document.createElement('figcaption');
        caption.innerHTML = renderMarkdown(figure.caption).replace(/^<p>|<\/p>\s*$/g, '');
        holder.append(caption);
      }
      chunk.append(holder);
      this.addPlot(plot, { activate: false });
    };

    if (!this.engine.ready) {
      const note = document.createElement('aside');
      note.className = 'render-notice';
      note.textContent = 'R code chunks are shown but were not evaluated because the webR runtime is offline.';
      preview.append(note);
      for (const block of blocks) {
        if (block.type === 'markdown') {
          await renderMarkdownBlock(block.content);
          continue;
        }
        const options = normalizedOptions(block.options);
        gfm.appendChunk({
          label: block.label,
          code: block.content,
          options,
          result: null
        });
        if (options.include === false || options.echo === false) continue;
        const chunk = document.createElement('section');
        chunk.className = 'r-chunk';
        const header = document.createElement('div');
        header.className = 'r-chunk-header';
        header.innerHTML = `<span>${escapeHtml(block.label || 'R chunk')}</span><span>not evaluated</span>`;
        chunk.append(header);
        await appendSource(chunk, block.content);
        preview.append(chunk);
      }
      this.bindPreviewLinks(preview);
      commitGfmArtifact();
      return;
    }
    if (this.engine.running) {
      preview.className = 'document-preview prose empty-state';
      preview.innerHTML = `${svg('i-clock')}<p>R is busy. Render the document after the current operation finishes.</p>`;
      return;
    }

    $('#refresh-preview-button').disabled = true;
    try {
      for (const block of blocks) {
        if (block.type === 'markdown') {
          await renderMarkdownBlock(block.content);
          continue;
        }

        const options = normalizedOptions(block.options);
        const include = options.include !== false;
        const shouldEvaluate = options.eval !== false;
        const figure = resolveRMarkdownFigureOptions(options, 7, 5);
        const chunk = document.createElement('section');
        chunk.className = 'r-chunk';

        if (include) {
          const header = document.createElement('div');
          header.className = 'r-chunk-header';
          header.innerHTML = `<span>${escapeHtml(block.label || 'R chunk')}</span><span>${shouldEvaluate ? 'webR' : 'not evaluated'}</span>`;
          chunk.append(header);
          if (options.echo !== false) await appendSource(chunk, block.content);
        }

        let result = null;
        let gfmPlots = [];
        if (shouldEvaluate) {
          result = await this.engine.execute(block.content, {
            plotWidth: figure.width,
            plotHeight: figure.height
          });
          if (result.cancelled) return;
          await this.handleViewOutputs(result);
          gfmPlots = (result.plots || [])
            .map(plot => ({ svg: sanitizeSvg(plot.svg) }))
            .filter(plot => plot.svg);
          if (include) {
            const asis = [];
            const flushAsis = () => {
              if (!asis.length) return;
              appendAsisOutput(chunk, asis.join('\n'));
              asis.length = 0;
            };
            for (const item of result.outputs || []) {
              if (item.type === 'stdout' && resultMode(options) === 'asis') {
                asis.push(item.text || '');
                continue;
              }
              flushAsis();
              appendOutput(chunk, item, options);
            }
            flushAsis();
            if (!result.ok && result.traceback?.length) {
              const traceback = document.createElement('pre');
              traceback.className = 'r-chunk-output output-traceback';
              traceback.textContent = `🧭 Traceback\n${result.traceback.join('\n')}`;
              chunk.append(traceback);
            }
            if (!figureHidden(options)) {
              for (const plot of result.plots || []) appendPlot(chunk, plot, block, figure);
            }
          }
        }

        gfm.appendChunk({
          label: block.label,
          code: block.content,
          options,
          result: result ? {
            ...result,
            outputs: (result.outputs || []).map(item => ({
              ...item,
              text: stripTerminalControlSequences(item.text || '')
            }))
          } : null,
          plots: gfmPlots,
          caption: figure.caption
        });

        if (include) preview.append(chunk);
      }
      renderMathInElement(preview);
      this.bindPreviewLinks(preview);
      commitGfmArtifact();
      await this.refreshEnvironment();
      this.runtimeFilesRefreshPending = true;
      await this.refreshRuntimeFiles(this.runtimeFilesPath, { quiet: true });
      if (this.settings.checkpointEnvironment) this.checkpointDebounced();
    } catch (error) {
      const failure = document.createElement('section');
      failure.className = 'r-chunk r-chunk-error';
      const output = document.createElement('pre');
      output.className = 'r-chunk-output output-error';
      output.textContent = `🧯 ${error.message || String(error)}`;
      failure.append(output);
      preview.append(failure);
      this.ui.toast('R Markdown render failed', error.message || String(error), 'error', 0);
    } finally {
      $('#refresh-preview-button').disabled = false;
    }
  }
  bindPreviewLinks(container) {
    container.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href') || '';
      if (/^(?:https?:|mailto:)/i.test(href)) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    });
  }

  revokePreviewUrls() {
    this.previewObjectUrls.forEach(url => URL.revokeObjectURL(url));
    this.previewObjectUrls = [];
  }

  async hydratePreviewAssets(root) {
    const baseDirectory = dirname(this.previewPath || this.activePath || '');
    for (const image of [...root.querySelectorAll('img[src]')]) {
      const original = image.getAttribute('src') || '';
      if (!original || /^(?:data:|blob:)/i.test(original)) continue;
      if (/^https?:/i.test(original)) {
        image.src = normalizeRemoteAssetUrl(original);
        continue;
      }
      try {
        const projectPath = resolveProjectReference(baseDirectory, original);
        const file = this.files.get(projectPath);
        if (!file) continue;
        const mime = file.mime || mimeFromPath(file.path);
        const bytes = typeof file.content === 'string' ? textEncoder.encode(file.content) : new Uint8Array(file.content);
        if (mime.includes('svg') || /\.svg$/i.test(file.path)) {
          const cleanSvg = sanitizeSvg(textDecoder.decode(bytes));
          if (!cleanSvg) continue;
          const holder = document.createElement('span');
          holder.className = 'embedded-svg';
          holder.innerHTML = cleanSvg;
          const graphic = holder.querySelector('svg');
          if (graphic) {
            graphic.removeAttribute('width');
            graphic.removeAttribute('height');
            graphic.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            if (image.alt) graphic.setAttribute('aria-label', image.alt);
          }
          image.replaceWith(holder);
        } else {
          const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
          this.previewObjectUrls.push(url);
          image.src = url;
          image.removeAttribute('srcset');
        }
      } catch {
        // Leave unresolved references visible as broken images in the live preview.
      }
    }
  }

  async inlinePreviewAssets(root) {
    const baseDirectory = dirname(this.previewPath || this.activePath || '');
    for (const image of [...root.querySelectorAll('img[src]')]) {
      const original = image.getAttribute('src') || '';
      if (!original || original.startsWith('data:')) continue;
      try {
        let bytes;
        let mime = 'application/octet-stream';
        let sourceName = original;
        if (/^(?:blob:|https?:)/i.test(original)) {
          const remote = /^https?:/i.test(original) ? normalizeRemoteAssetUrl(original) : original;
          const response = await fetch(remote);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          bytes = new Uint8Array(await response.arrayBuffer());
          mime = response.headers.get('content-type')?.split(';')[0] || mime;
        } else {
          const projectPath = resolveProjectReference(baseDirectory, original);
          const file = this.files.get(projectPath);
          if (!file) throw new Error('Project image was not found');
          sourceName = file.path;
          mime = file.mime || mimeFromPath(file.path);
          bytes = typeof file.content === 'string' ? textEncoder.encode(file.content) : new Uint8Array(file.content);
        }
        if (mime.includes('svg') || /\.svg$/i.test(sourceName)) {
          const cleanSvg = sanitizeSvg(textDecoder.decode(bytes));
          if (!cleanSvg) throw new Error('SVG could not be sanitized');
          const holder = document.createElement('span');
          holder.className = 'embedded-svg';
          holder.innerHTML = cleanSvg;
          const graphic = holder.querySelector('svg');
          if (graphic) {
            graphic.removeAttribute('width');
            graphic.removeAttribute('height');
            graphic.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            if (image.alt) graphic.setAttribute('aria-label', image.alt);
          }
          image.replaceWith(holder);
        } else {
          image.src = bytesToDataUrl(bytes, mime);
          image.removeAttribute('srcset');
        }
      } catch (error) {
        const missing = document.createElement('span');
        missing.className = 'missing-asset';
        missing.textContent = `[Image omitted from self-contained export: ${image.alt || original}]`;
        image.replaceWith(missing);
      }
    }
  }

  async buildSelfContainedPreviewHtml() {
    const preview = $('#document-preview');
    if (!preview || !preview.childNodes.length) throw new Error('Render a Markdown or R Markdown document first.');
    const clone = preview.cloneNode(true);
    clone.removeAttribute('id');
    clone.classList.remove('empty-state');
    await this.inlinePreviewAssets(clone);
    clone.querySelectorAll('svg').forEach(graphic => {
      graphic.removeAttribute('width');
      graphic.removeAttribute('height');
      graphic.setAttribute('preserveAspectRatio', graphic.getAttribute('preserveAspectRatio') || 'xMidYMid meet');
    });
    const title = $('#preview-title').textContent || basename(this.previewPath || 'Rendered document');
    return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<meta name="generator" content="webR Studio ${APP_VERSION}">\n<title>${escapeHtml(title)}</title>\n<style>${DOCUMENT_EXPORT_CSS}</style>\n</head>\n<body>\n<main class="document">${clone.innerHTML}</main>\n</body>\n</html>`;
  }

  async openPreviewWindow() {
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      this.ui.toast('Preview window blocked', 'Allow pop-ups for this site, then try again.', 'warning');
      return;
    }
    popup.opener = null;
    popup.document.write('<!doctype html><title>Preparing preview…</title><p style="font:16px system-ui;padding:24px">Preparing the self-contained document…</p>');
    popup.document.close();
    try {
      const html = await this.buildSelfContainedPreviewHtml();
      popup.document.open();
      popup.document.write(html);
      popup.document.close();
    } catch (error) {
      popup.close();
      this.ui.toast('Could not open the rendered document', error.message || String(error), 'error');
    }
  }

  async downloadRenderedDocument() {
    try {
      if (!this.previewPath || this.previewPath !== this.activePath) {
        const rendered = await this.previewActiveFile();
        if (!rendered) return;
      }
      const html = await this.buildSelfContainedPreviewHtml();
      const sourceName = basename(this.previewPath || this.activePath || 'rendered-document');
      const stem = sourceName.replace(/\.(?:rmd|md|markdown)$/i, '') || 'rendered-document';
      downloadText(html, `${stem}.html`, 'text/html;charset=utf-8');
      this.ui.toast('Rendered HTML downloaded', `${stem}.html is self-contained, with styles and SVG graphics inline.`, 'success');
    } catch (error) {
      this.ui.toast('HTML export failed', error.message || String(error), 'error', 0);
    }
  }

  async downloadRMarkdownGfmBundle() {
    try {
      const path = this.activePath;
      const file = path ? this.files.get(path) : null;
      if (!file || extname(path) !== 'rmd') {
        this.ui.toast('No R Markdown document', 'Open an .Rmd file before exporting GitHub-flavored Markdown.', 'info');
        return;
      }

      const source = path === this.activePath && this.editor
        ? this.editor.getValue()
        : String(file.content || '');
      const artifact = this.rMarkdownGfmArtifact;
      if (!artifact || artifact.sourcePath !== path || artifact.sourceDocument !== source) {
        const rendered = await this.previewActiveFile(path);
        if (!rendered) return;
      }

      const bundle = this.rMarkdownGfmArtifact;
      if (!bundle || bundle.sourcePath !== path || bundle.sourceDocument !== source) {
        throw new Error('The R Markdown document could not be rendered into a GitHub Markdown bundle.');
      }

      const filename = `${bundle.stem}-gfm.zip`;
      downloadBlob(createZip(gfmBundleFiles(bundle)), filename);
      const imageCount = bundle.assets.length;
      this.ui.toast(
        'GitHub Markdown bundle downloaded',
        `${filename} contains ${bundle.stem}.md${imageCount ? ` and ${imageCount} generated image${imageCount === 1 ? '' : 's'}` : ''}.`,
        'success'
      );
    } catch (error) {
      this.ui.toast('GFM export failed', error.message || String(error), 'error', 0);
    }
  }

  async exportActivePanel(dock = 'bottom') {
    const active = $(`#right-${dock}-pane .tab.active`)?.dataset.panel;
    if (active === 'plots') return this.exportCurrentPlot();
    if (active === 'preview') return this.downloadRenderedDocument();
    if (active === 'help') {
      return downloadText($('#help-viewer').innerHTML, `${this.currentHelpTopic || 'R-help'}.html`, 'text/html;charset=utf-8');
    }
    if (active === 'data') return this.dataViewer?.exportCsv();
  }

  activateSidebar(name, persist = true) {
    this.settings.activeSidebar = name;
    $$('.activity-button[data-sidebar]').forEach(button => button.classList.toggle('active', button.dataset.sidebar === name));
    $$('.sidebar-view').forEach(view => view.classList.toggle('active', view.id === `sidebar-${name}`));
    if (persist) this.persistSettingsDebounced();
    if (name === 'workspace') this.renderSnapshots();
    if (name === 'gists') $('#gist-reference').focus();
    if (name === 'explorer' && persist && this.runtimeFilesRefreshPending && !this.runtimeFilesLoading && this.engine.ready && !this.engine.running) {
      this.refreshRuntimeFiles(this.runtimeFilesPath, { quiet: true });
    }
  }

  activatePanel(name, persist = true) {
    if (name === 'files') return this.activateSidebar('explorer', persist);
    const view = $(`#panel-${name}`);
    if (!view) return;
    const pane = view.closest('.dock-pane');
    const dock = pane.dataset.dock;
    $$('.panel-view', pane).forEach(item => item.classList.toggle('active', item === view));
    $$('.dock-tabs .tab', pane).forEach(button => button.classList.toggle('active', button.dataset.panel === name));
    this.settings.activeDock[dock] = name;
    if (persist) this.persistSettingsDebounced();
    if (name === 'assistant') this.ensureAssistant().then(panel => { panel.refreshObjectChoices(); panel.updateState(); }).catch(error => {
      $('#assistant-status').textContent = `The assistant could not open: ${error.message}`;
    });
    if (name === 'environment') this.refreshEnvironment();
    if (name === 'packages') this.refreshPackages();
    if (name === 'plots') {
      this.renderPlots();
      requestAnimationFrame(() => this.plotResizeDebounced());
    }
  }

  bindDockEvents() {
    document.addEventListener('click', event => {
      const tab = event.target.closest('.dock-tabs .tab[data-panel]');
      if (tab) this.activatePanel(tab.dataset.panel);
    });
    let dragged = null;
    document.addEventListener('dragstart', event => {
      const tab = event.target.closest('.dock-tabs .tab[draggable="true"]');
      if (!tab) return;
      dragged = { panel: tab.dataset.panel, source: tab.closest('.dock-pane').dataset.dock };
      tab.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', tab.dataset.panel);
    });
    document.addEventListener('dragend', event => {
      event.target.closest('.dock-tabs .tab')?.classList.remove('dragging');
      $$('.dock-tabs').forEach(tabs => tabs.classList.remove('drag-over'));
      dragged = null;
    });
    $$('.dock-tabs').forEach(tabs => {
      tabs.addEventListener('dragover', event => {
        event.preventDefault();
        tabs.classList.add('drag-over');
      });
      tabs.addEventListener('dragleave', () => tabs.classList.remove('drag-over'));
      tabs.addEventListener('drop', event => {
        event.preventDefault();
        tabs.classList.remove('drag-over');
        if (!dragged) return;
        const target = tabs.closest('.dock-pane').dataset.dock;
        this.movePanel(dragged.panel, dragged.source, target);
      });
    });
  }

  movePanel(panel, sourceDock, targetDock) {
    if (sourceDock === targetDock) return;
    const sourceTabs = $(`[data-dock-tabs="${sourceDock}"]`);
    if (!sourceTabs) {
      this.ui.toast('Panel move failed', 'The source dock is unavailable. Reset the pane layout and try again.', 'error');
      return;
    }
    if (sourceTabs.querySelectorAll('.tab').length <= 1) {
      this.ui.toast('Panel cannot move', 'Each dock must keep at least one panel.', 'warning');
      return;
    }
    const button = sourceTabs?.querySelector(`[data-panel="${panel}"]`);
    const view = $(`#panel-${panel}`);
    const targetTabs = $(`[data-dock-tabs="${targetDock}"]`);
    const targetContent = targetTabs?.closest('.dock-pane')?.querySelector('.dock-content');
    if (!sourceTabs || !button || !view || !targetTabs || !targetContent) {
      this.ui.toast('Panel move failed', 'The panel layout is inconsistent. Reset the pane layout and try again.', 'error');
      return;
    }
    targetTabs.append(button);
    targetContent.append(view);
    this.settings.dockPanels[sourceDock] = this.settings.dockPanels[sourceDock].filter(item => item !== panel);
    this.settings.dockPanels[targetDock] = [...this.settings.dockPanels[targetDock], panel];
    this.activatePanel(panel);
    const sourceActive = this.settings.dockPanels[sourceDock][0];
    if (sourceActive) this.activatePanel(sourceActive);
    this.persistSettingsDebounced();
    requestAnimationFrame(() => {
      this.editor?.resize();
      this.console?.resize();
      this.plotResizeDebounced();
    });
  }

  restoreDockLayout() {
    const validPanels = [...DEFAULT_SETTINGS.dockPanels.top, ...DEFAULT_SETTINGS.dockPanels.bottom];
    const assigned = new Set();
    const dockPanels = { top: [], bottom: [] };
    for (const dock of ['top', 'bottom']) {
      for (const panel of this.settings.dockPanels?.[dock] || []) {
        if (!validPanels.includes(panel) || assigned.has(panel)) continue;
        assigned.add(panel);
        dockPanels[dock].push(panel);
      }
    }
    for (const panel of validPanels) {
      if (assigned.has(panel)) continue;
      const defaultDock = DEFAULT_SETTINGS.dockPanels.top.includes(panel) ? 'top' : 'bottom';
      dockPanels[defaultDock].push(panel);
      assigned.add(panel);
    }
    if (!dockPanels.top.length) dockPanels.top.push(dockPanels.bottom.shift());
    if (!dockPanels.bottom.length) dockPanels.bottom.push(dockPanels.top.pop());
    this.settings.dockPanels = dockPanels;
    this.settings.activeDock = {
      top: dockPanels.top.includes(this.settings.activeDock?.top) ? this.settings.activeDock.top : dockPanels.top[0],
      bottom: dockPanels.bottom.includes(this.settings.activeDock?.bottom) ? this.settings.activeDock.bottom : dockPanels.bottom[0]
    };
    for (const dock of ['top', 'bottom']) {
      const tabs = $(`[data-dock-tabs="${dock}"]`);
      const content = tabs?.closest('.dock-pane')?.querySelector('.dock-content');
      if (!tabs || !content) continue;
      for (const panel of this.settings.dockPanels[dock] || []) {
        const button = document.querySelector(`.dock-tabs .tab[data-panel="${panel}"]`);
        const view = $(`#panel-${panel}`);
        if (button) tabs.append(button);
        if (view) content.append(view);
      }
      const active = this.settings.activeDock[dock] || this.settings.dockPanels[dock]?.[0];
      if (active) this.activatePanel(active, false);
    }
  }

  bindResizers() {
    const bind = (selector, orientation, handler) => {
      const resizer = $(selector);
      resizer.addEventListener('pointerdown', event => {
        event.preventDefault();
        resizer.setPointerCapture(event.pointerId);
        resizer.classList.add('dragging');
        document.body.classList.add(orientation === 'horizontal' ? 'resizing-horizontal' : 'resizing');
        const move = moveEvent => handler(moveEvent);
        const end = () => {
          resizer.classList.remove('dragging');
          document.body.classList.remove('resizing', 'resizing-horizontal');
          resizer.removeEventListener('pointermove', move);
          resizer.removeEventListener('pointerup', end);
          this.persistSettingsDebounced.flush();
          this.editor.resize();
          this.console.resize();
          this.plotResizeDebounced();
        };
        resizer.addEventListener('pointermove', move);
        resizer.addEventListener('pointerup', end);
      });
    };
    bind('#sidebar-resizer', 'vertical', event => {
      const workbench = $('#workbench').getBoundingClientRect();
      this.settings.sidebarWidth = Math.round(clamp(event.clientX - workbench.left - 47, 150, 430));
      document.documentElement.style.setProperty('--sidebar-width', `${this.settings.sidebarWidth}px`);
    });
    bind('#right-resizer', 'vertical', event => {
      this.settings.rightWidth = Math.round(clamp(window.innerWidth - event.clientX, 260, Math.min(760, window.innerWidth * .62)));
      document.documentElement.style.setProperty('--right-width', `${this.settings.rightWidth}px`);
    });
    bind('#center-resizer', 'horizontal', event => {
      const rect = $('#center-column').getBoundingClientRect();
      const bottom = rect.bottom - event.clientY;
      this.settings.consoleHeight = Math.round(clamp(bottom / rect.height * 100, 18, 76));
      document.documentElement.style.setProperty('--console-ratio', `${this.settings.consoleHeight}%`);
    });
    bind('#dock-resizer', 'horizontal', event => {
      const rect = $('#right-dock').getBoundingClientRect();
      this.settings.dockRatio = Math.round(clamp((event.clientY - rect.top) / rect.height * 100, 22, 78));
      document.documentElement.style.setProperty('--dock-ratio', `${this.settings.dockRatio}%`);
    });
  }

  showNewFileMenu(anchor) {
    this.ui.showMenu(anchor, [
      { type: 'label', label: 'New file' },
      { label: 'New Rmd file', icon: 'i-book', action: () => this.createRMarkdownFile() },
      { label: 'New R script', icon: 'i-plus', shortcut: 'Ctrl Alt N', action: () => this.createFile() }
    ]);
  }

  showSourceOptionsMenu(anchor) {
    const file = this.resolveActiveFile();
    const sourceable = Boolean(file && extname(file.path) === 'r' && this.engine.ready && !this.engine.running);
    this.ui.showMenu(anchor, [
      { type: 'label', label: 'Source active R script' },
      { label: 'Source', icon: 'i-play', shortcut: 'Ctrl Shift Enter', disabled: !sourceable, action: () => this.sourceActiveFile({ echo: false }) },
      { label: 'Source with Echo', icon: 'i-terminal', disabled: !sourceable, action: () => this.sourceActiveFile({ echo: true }) }
    ]);
  }

  showEditorActionsMenu(anchor) {
    const file = this.resolveActiveFile();
    this.ui.showMenu(anchor, [
      { type: 'label', label: 'Editor actions' },
      { label: 'Suggest R code locally', icon: 'i-sparkles', shortcut: 'Alt \\', disabled: !file, action: () => this.showAssistant({ suggest: true, target: 'editor' }) },
      { label: this.maximizedPaneId === 'editor-pane' ? 'Restore editor pane' : 'Maximize editor pane', icon: this.maximizedPaneId === 'editor-pane' ? 'i-restore' : 'i-maximize', action: () => this.togglePaneMaximize('editor-pane') },
      { label: 'Run selected', icon: 'i-play', shortcut: 'Ctrl Enter', disabled: !file || !this.engine.ready, action: () => this.executeCode(this.editor.getRunText(), { echo: true }) },
      { label: 'Source active script', icon: 'i-play', shortcut: 'Ctrl Shift Enter', disabled: !file || extname(file.path) !== 'r' || !this.engine.ready, action: () => this.sourceActiveFile({ echo: false }) },
      { label: 'Source with Echo', icon: 'i-terminal', disabled: !file || extname(file.path) !== 'r' || !this.engine.ready, action: () => this.sourceActiveFile({ echo: true }) },
      { type: 'separator' },
      { label: 'Advanced find and replace', icon: 'i-search', shortcut: 'Ctrl F', disabled: !file, action: () => this.editor.findReplace() },
      { label: 'Smart indent', icon: 'i-code', shortcut: 'Ctrl I', disabled: !file, action: () => this.editor.smartIndent() },
      { label: 'Jump to definition', icon: 'i-code', shortcut: 'F12', disabled: !file, action: () => this.editor.jumpToDefinition() },
      { label: 'Function help', icon: 'i-help', shortcut: 'F1', disabled: !file, action: () => this.openHelp(this.editor.getSymbolAtCursor()) },
      { type: 'separator' },
      { label: 'Check selected code with Mistral', icon: 'i-sparkles', disabled: !file, action: () => this.checkCodeWithMistral() },
      { label: 'Preview document', icon: 'i-book', disabled: !file || !isPreviewable(file.path), action: () => this.previewActiveFile() },
      { label: 'Save active file', icon: 'i-save', shortcut: 'Ctrl S', disabled: !file, action: () => this.saveFile(this.activePath) }
    ]);
  }

  showDockOptionsMenu(anchor, dock) {
    const labels = {
      environment: 'Environment', outline: 'Outline', packages: 'Packages',
      assistant: 'Local R assistant',
      plots: 'Plots', help: 'Help', data: 'Data viewer', preview: 'Document preview'
    };
    const active = this.settings.activeDock[dock] || this.settings.dockPanels[dock]?.[0];
    const otherDock = dock === 'top' ? 'bottom' : 'top';
    const items = [
      { type: 'label', label: `${dock === 'top' ? 'Upper' : 'Lower'} dock panels` },
      ...(this.settings.dockPanels[dock] || []).map(panel => ({
        label: labels[panel] || panel,
        icon: panel === 'plots' ? 'i-chart' : panel === 'data' ? 'i-table' : panel === 'files' ? 'i-folder' : panel === 'help' || panel === 'preview' ? 'i-book' : 'i-box',
        checked: panel === active,
        action: () => this.activatePanel(panel)
      })),
      { type: 'separator' },
      { label: this.maximizedPaneId === `right-${dock}-pane` ? 'Restore pane' : 'Maximize pane', icon: this.maximizedPaneId === `right-${dock}-pane` ? 'i-restore' : 'i-maximize', action: () => this.togglePaneMaximize(`right-${dock}-pane`) },
      { label: 'Refresh active panel', icon: 'i-refresh', action: () => this.refreshPanel(active) },
      { label: `Move ${labels[active] || active} to ${otherDock} dock`, icon: 'i-layout', disabled: (this.settings.dockPanels[dock] || []).length <= 1, action: () => this.movePanel(active, dock, otherDock) },
      { label: 'Export active panel', icon: 'i-download', disabled: !['plots', 'preview', 'help', 'data'].includes(active), action: () => this.exportActivePanel(dock) },
      { label: 'Reset pane layout', icon: 'i-layout', action: () => this.applyLayoutPreset('reset') }
    ];
    this.ui.showMenu(anchor, items);
  }

  showLayoutMenu(anchor) {
    this.ui.showMenu(anchor, [
      { type: 'label', label: 'Layout presets' },
      { label: 'Balanced', icon: 'i-layout', action: () => this.applyLayoutPreset('reset') },
      { label: 'Code focus', icon: 'i-code', action: () => this.applyLayoutPreset('code') },
      { label: 'Console focus', icon: 'i-terminal', action: () => this.applyLayoutPreset('console') },
      { label: 'Data and plots', icon: 'i-table', action: () => this.applyLayoutPreset('data') }
    ]);
  }

  applyLayoutPreset(preset) {
    const values = {
      reset: { sidebarWidth: 244, rightWidth: 390, consoleHeight: 38, dockRatio: 51 },
      code: { sidebarWidth: 190, rightWidth: 290, consoleHeight: 27, dockRatio: 55 },
      console: { sidebarWidth: 190, rightWidth: 300, consoleHeight: 68, dockRatio: 50 },
      data: { sidebarWidth: 210, rightWidth: Math.min(680, window.innerWidth * .48), consoleHeight: 28, dockRatio: 38 }
    }[preset] || {};
    Object.assign(this.settings, values);
    if (preset === 'reset') {
      this.settings.dockPanels = {
        top: [...DEFAULT_SETTINGS.dockPanels.top],
        bottom: [...DEFAULT_SETTINGS.dockPanels.bottom]
      };
      this.settings.activeDock = { ...DEFAULT_SETTINGS.activeDock };
      this.restoreDockLayout();
    }
    this.restoreMaximizedPane();
    this.applyAppearance();
    this.persistSettingsDebounced();
    requestAnimationFrame(() => {
      this.editor.resize();
      this.console.resize();
      this.plotResizeDebounced();
    });
  }

  togglePaneMaximize(paneId) {
    const target = paneId ? document.getElementById(paneId) : null;
    if (!target) return;
    if (this.maximizedPaneId === paneId) {
      this.restoreMaximizedPane();
      return;
    }
    this.restoreMaximizedPane({ resize: false });
    this.maximizedPaneId = paneId;
    target.classList.add('pane-maximized');
    document.body.classList.add('has-maximized-pane');
    this.updatePaneMaximizeButtons();
    this.resizeWorkbenchContent();
  }

  restoreMaximizedPane({ resize = true } = {}) {
    if (this.maximizedPaneId) document.getElementById(this.maximizedPaneId)?.classList.remove('pane-maximized');
    this.maximizedPaneId = '';
    document.body.classList.remove('has-maximized-pane');
    this.updatePaneMaximizeButtons();
    if (resize) this.resizeWorkbenchContent();
  }

  updatePaneMaximizeButtons() {
    $$('[data-maximize-pane]').forEach(button => {
      const active = button.dataset.maximizePane === this.maximizedPaneId;
      const label = button.dataset.maximizePane === 'sidebar' ? 'Project' :
        button.dataset.maximizePane === 'editor-pane' ? 'Editor' :
          button.dataset.maximizePane === 'console-pane' ? 'Console' :
            button.dataset.maximizePane === 'right-top-pane' ? 'upper' : 'lower';
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-label', `${active ? 'Restore' : 'Maximize'} ${label} pane`);
      button.title = `${active ? 'Restore' : 'Maximize'} ${label} pane`;
      button.querySelector('use')?.setAttribute('href', active ? '#i-restore' : '#i-maximize');
    });
  }

  resizeWorkbenchContent() {
    requestAnimationFrame(() => {
      this.editor?.resize();
      this.console?.resize();
      this.dataViewer?.refreshDebounced?.cancel?.();
      if (this.maximizedPaneId === 'right-bottom-pane' || !this.maximizedPaneId) this.plotResizeDebounced();
    });
  }

  toggleConsoleMaximize() {
    this.togglePaneMaximize('console-pane');
  }

  openSettings(section = 'appearance') {
    this.syncSettingsControls();
    this.showSettingsSection(section);
    $('#settings-dialog').showModal();
    this.updateStorageEstimate();
  }

  showSettingsSection(section) {
    $$('.settings-nav button').forEach(button => button.classList.toggle('active', button.dataset.settingsSection === section));
    $$('.settings-section').forEach(view => view.classList.toggle('active', view.dataset.settingsView === section));
  }

  bindSettingsControls() {
    const versionOptions = $('#webr-version-options');
    versionOptions.replaceChildren(...WEBR_VERSION_SUGGESTIONS.map(version => {
      const option = document.createElement('option');
      option.value = version;
      return option;
    }));
    const controls = {
      'theme-select': ['theme', 'string'],
      'editor-theme-select': ['editorTheme', 'string'],
      'font-family-select': ['fontFamily', 'string'],
      'font-size-input': ['fontSize', 'number'],
      'font-weight-select': ['fontWeight', 'number'],
      'ligatures-toggle': ['ligatures', 'boolean'],
      'density-select': ['density', 'string'],
      'tab-size-select': ['tabSize', 'number'],
      'wrap-toggle': ['wordWrap', 'boolean'],
      'print-margin-toggle': ['printMargin', 'boolean'],
      'active-line-toggle': ['highlightActiveLine', 'boolean'],
      'rainbow-toggle': ['rainbowDelimiters', 'boolean'],
      'lint-toggle': ['lint', 'boolean'],
      'autocomplete-toggle': ['autocomplete', 'boolean'],
      'type-hints-toggle': ['typeHints', 'boolean'],
      'console-height-select': ['consoleHeight', 'number'],
      'console-history-input': ['consoleHistoryLimit', 'number'],
      'console-traceback-toggle': ['autoTraceback', 'boolean'],
      'console-follow-toggle': ['consoleFollow', 'boolean'],
      'pipe-select': ['pipe', 'string'],
      'timing-toggle-setting': ['timing', 'boolean'],
      'checkpoint-toggle': ['checkpointEnvironment', 'boolean'],
      'restore-r-toggle': ['restoreEnvironment', 'boolean'],
      'plot-width': ['plotWidth', 'number'],
      'plot-height': ['plotHeight', 'number'],
      'autosave-delay': ['autosaveDelay', 'number']
    };
    for (const [id, [key, type]] of Object.entries(controls)) {
      const element = $(`#${id}`);
      element.addEventListener(element.type === 'range' ? 'input' : 'change', () => {
        const value = type === 'boolean' ? element.checked : type === 'number' ? Number(element.value) : element.value;
        this.updateSetting(key, value);
      });
    }
    $('#restore-default-settings').addEventListener('click', async () => {
      const accepted = await this.ui.confirm('Restore default settings?', 'Project files, console history, and the R checkpoint will be kept.', { acceptLabel: 'Restore defaults', danger: false });
      if (!accepted) return;
      this.autosaveDebounced?.cancel?.();
      this.persistSettingsDebounced?.cancel?.();
      this.plotResizeDebounced?.cancel?.();
      this.settings = deepSettings();
      this.autosaveDebounced = debounce(() => this.saveDirtyFiles(), this.settings.autosaveDelay);
      this.restoreMaximizedPane({ resize: false });
      this.applyAppearance();
      this.restoreDockLayout();
      this.lastPlotDeviceSize = null;
      this.lastPlotViewerRect = null;
      this.pendingPlotReflow = true;
      requestAnimationFrame(() => {
        this.editor?.resize();
        this.console?.resize();
        this.plotResizeDebounced();
      });
      await workspaceDB.set('settings', this.settings);
      this.ui.toast('Settings restored', 'Default IDE settings are active.', 'success');
    });
    $('#erase-local-data').addEventListener('click', async () => {
      const accepted = await this.ui.confirm('Erase all local IDE data?', 'This removes project files, settings, console input and output, history, snapshots, the GitHub token, plots, and R checkpoints from this browser.', { acceptLabel: 'Erase everything' });
      if (!accepted) return;
      this.erasingLocalData = true;
      this.projectPersistenceReady = false;
      this.projectPersistenceEpoch += 1;
      this.runtimeFilesRequest += 1;
      try {
        for (const task of [
          this.autosaveDebounced, this.persistWorkspaceDebounced, this.persistSettingsDebounced,
          this.checkpointDebounced, this.environmentDebounced, this.gistTokenDebounced,
          this.plotResizeDebounced, this.projectBackupDebounced
        ]) task?.cancel?.();
        this.console?.resetAll();
        this.assistant?.clear();
        this.assistant?.unload();
        this.consoleState = { history: [], transcript: [], draft: '' };
        this.files.clear();
        this.openTabs = [];
        this.activePath = null;
        this.folderExpansionInitialized = false;
        this.environment = [];
        this.packages = [];
        this.plots = [];
        this.snapshots = [];
        this.pendingMirrors.clear();
        this.pendingMirrorDeletes.clear();
        $('#gist-token').value = '';
        $('#persist-gist-token').checked = false;
        try { await this.engine.close(); } catch { /* The worker may already be stopped. */ }
        await Promise.allSettled([...this.fileSaveQueues.values()]);
        await this.mirrorOperationQueue;
        this.fileSaveQueues.clear();
        await workspaceDB.clearEverything();
        location.replace(location.pathname);
      } catch (error) {
        this.erasingLocalData = false;
        this.ui.toast('Local data could not be erased', error.message || String(error), 'error', 0);
      }
    });
  }

  updateSetting(key, value) {
    this.settings[key] = value;
    if (key === 'autosaveDelay') {
      this.autosaveDebounced?.flush?.();
      this.autosaveDebounced?.cancel?.();
      this.autosaveDebounced = debounce(() => this.saveDirtyFiles(), this.settings.autosaveDelay);
    }
    if (key === 'plotWidth' || key === 'plotHeight') {
      this.lastPlotDeviceSize = null;
      this.lastPlotViewerRect = null;
      this.pendingPlotReflow = true;
      this.plotResizeDebounced();
    }
    this.applyAppearance();
    this.persistSettingsDebounced();
  }

  syncSettingsControls() {
    const values = {
      'theme-select': this.settings.theme,
      'editor-theme-select': this.settings.editorTheme,
      'font-family-select': this.settings.fontFamily,
      'font-size-input': this.settings.fontSize,
      'font-weight-select': this.settings.fontWeight,
      'ligatures-toggle': this.settings.ligatures,
      'density-select': this.settings.density,
      'tab-size-select': this.settings.tabSize,
      'wrap-toggle': this.settings.wordWrap,
      'print-margin-toggle': this.settings.printMargin,
      'active-line-toggle': this.settings.highlightActiveLine,
      'rainbow-toggle': this.settings.rainbowDelimiters,
      'lint-toggle': this.settings.lint,
      'autocomplete-toggle': this.settings.autocomplete,
      'type-hints-toggle': this.settings.typeHints,
      'console-height-select': this.settings.consoleHeight,
      'console-history-input': this.settings.consoleHistoryLimit,
      'console-traceback-toggle': this.settings.autoTraceback,
      'console-follow-toggle': this.settings.consoleFollow,
      'pipe-select': this.settings.pipe,
      'timing-toggle-setting': this.settings.timing,
      'checkpoint-toggle': this.settings.checkpointEnvironment,
      'restore-r-toggle': this.settings.restoreEnvironment,
      'plot-width': this.settings.plotWidth,
      'plot-height': this.settings.plotHeight,
      'autosave-delay': this.settings.autosaveDelay
    };
    $('#webr-version-input').value = String(this.settings.webrVersion || '');
    for (const [id, value] of Object.entries(values)) {
      const element = $(`#${id}`);
      if (!element) continue;
      if (element.type === 'checkbox') element.checked = Boolean(value);
      else element.value = String(value);
    }
    $('#font-size-output').textContent = `${this.settings.fontSize} px`;
  }

  cycleTheme() {
    const resolved = document.documentElement.dataset.resolvedTheme ||
      (this.systemTheme.matches ? 'dark' : 'light');
    const next = resolved === 'light' ? 'dark' : 'light';
    this.updateSetting('theme', next);
    this.ui.toast('Color theme', `${next[0].toUpperCase()}${next.slice(1)} theme selected.`, 'info');
  }

  async applyWebRVersion() {
    const input = $('#webr-version-input');
    let requested;
    try {
      requested = normalizeWebRVersion(input.value);
    } catch (error) {
      input.setCustomValidity(error.message || String(error));
      input.reportValidity();
      input.setCustomValidity('');
      return;
    }

    const previous = this.settings.webrVersion;
    input.value = requested;
    const restarted = await this.restartRuntime(false, { version: requested });
    if (restarted) {
      this.settings.webrVersion = requested;
      await workspaceDB.set('settings', this.settings);
      this.ui.toast('webR version applied', `Using webR ${this.engine.version}.`, 'success');
      return;
    }

    input.value = previous;
    if (requested !== previous) {
      this.ui.toast('Restoring webR', `Could not start ${requested}. Restoring ${previous}.`, 'warning', 8000);
      await this.restartRuntime(false, { version: previous });
    }
  }

  async updateStorageEstimate() {
    const { usage = 0, quota = 0 } = await workspaceDB.estimate();
    $('#storage-usage').textContent = quota ? `${formatBytes(usage)} of ${formatBytes(quota)}` : formatBytes(usage);
    $('#storage-meter-fill').style.width = quota ? `${clamp(usage / quota * 100, 0, 100)}%` : '0%';
  }

  buildCommandItems() {
    this.commandItems = [
      { title: 'Local R assistant', detail: 'Local AI with R object context', icon: 'i-sparkles', action: () => this.showAssistant() },
      { title: 'Suggest R code locally', detail: 'Editor or console', icon: 'i-sparkles', shortcut: 'Alt \\', action: () => this.showAssistant({ suggest: true, target: this.currentFocus }) },
      { title: 'New Rmd file', detail: 'File', icon: 'i-book', action: () => this.createRMarkdownFile() },
      { title: 'New R script', detail: 'File', icon: 'i-plus', shortcut: 'Ctrl Alt N', action: () => this.createFile() },
      { title: 'Upload files', detail: 'File', icon: 'i-upload', shortcut: 'Ctrl Alt O', action: () => $('#file-input').click() },
      { title: 'Upload folder', detail: 'File', icon: 'i-folder', action: () => $('#folder-input').click() },
      { title: 'Save active file', detail: 'File', icon: 'i-save', shortcut: 'Ctrl S', action: () => this.saveFile(this.activePath) },
      { title: 'Run selected', detail: 'Code', icon: 'i-play', shortcut: 'Ctrl Enter', action: () => this.executeCode(this.editor.getRunText(), { echo: true }) },
      { title: 'Source active script', detail: 'Code', icon: 'i-play', shortcut: 'Ctrl Shift Enter', action: () => this.sourceActiveFile({ echo: false }) },
      { title: 'Source with Echo', detail: 'Code', icon: 'i-terminal', action: () => this.sourceActiveFile({ echo: true }) },
      { title: `Insert ${this.settings.pipe} pipe`, detail: 'Code', icon: 'i-code', shortcut: 'Ctrl Shift M', action: () => this.currentFocus === 'console' ? this.console.insertPipe() : this.editor.insertPipe() },
      { title: 'Smart indent R code', detail: 'Code', icon: 'i-code', shortcut: 'Ctrl I', action: () => this.editor.smartIndent() },
      { title: 'Open function help', detail: 'R', icon: 'i-help', shortcut: 'F1', action: () => this.openHelp(this.editor.getSymbolAtCursor()) },
      { title: 'Jump to function definition', detail: 'Code', icon: 'i-code', shortcut: 'F12', action: () => this.editor.jumpToDefinition() },
      { title: 'Check selected code with Mistral', detail: 'AI', icon: 'i-sparkles', action: () => this.checkCodeWithMistral() },
      { title: 'Restart webR', detail: 'Session', icon: 'i-refresh', action: () => this.restartRuntime(true) },
      { title: 'Networking', detail: 'Browser, Tailscale, or Cloudflare Worker downloads', icon: 'i-network', action: () => this.networkUI.open() },
      { title: 'Stop R execution', detail: 'Session', icon: 'i-stop', action: () => this.stopExecution() },
      { title: 'Clear global environment', detail: 'Session', icon: 'i-trash', action: () => this.clearEnvironment() },
      { title: 'Install R package', detail: 'Packages', icon: 'i-plus', action: () => this.installPackage() },
      { title: 'Browse runtime files', detail: 'webR filesystem', icon: 'i-folder', action: () => this.activatePanel('files') },
      { title: 'Render Markdown or R Markdown', detail: 'Preview', icon: 'i-book', action: () => this.previewActiveFile() },
      { title: 'Export R Markdown as GFM ZIP', detail: 'Document', icon: 'i-download', disabled: extname(this.activePath || '') !== 'rmd', action: () => this.downloadRMarkdownGfmBundle() },
      { title: 'Share workspace as URL', detail: 'Workspace', icon: 'i-link', action: () => this.shareWorkspaceUrl() },
      { title: 'Export project JSON', detail: 'Workspace', icon: 'i-download', action: () => this.exportWorkspaceJson() },
      { title: 'Create workspace snapshot', detail: 'Workspace', icon: 'i-database', action: () => this.createSnapshot() },
      { title: 'Open settings', detail: 'Preferences', icon: 'i-settings', action: () => this.openSettings() },
      { title: 'Reset pane layout', detail: 'View', icon: 'i-layout', action: () => this.applyLayoutPreset('reset') }
    ];
  }

  bindCommandPalette() {
    const dialog = $('#command-dialog');
    const input = $('#command-input');
    input.addEventListener('input', () => this.renderCommandResults());
    input.addEventListener('keydown', event => {
      const results = $$('.command-result', $('#command-results'));
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.commandSelection = Math.min(results.length - 1, this.commandSelection + 1);
        this.updateCommandSelection();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.commandSelection = Math.max(0, this.commandSelection - 1);
        this.updateCommandSelection();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        results[this.commandSelection]?.click();
      }
    });
    dialog.addEventListener('close', () => { input.value = ''; });
  }

  openCommandPalette() {
    this.buildCommandItems();
    this.commandSelection = 0;
    $('#command-dialog').showModal();
    $('#command-input').value = '';
    this.renderCommandResults();
    window.setTimeout(() => $('#command-input').focus(), 20);
  }

  renderCommandResults() {
    const query = $('#command-input').value.trim().toLocaleLowerCase();
    const commands = this.commandItems
      .filter(item => `${item.title} ${item.detail}`.toLocaleLowerCase().includes(query))
      .map(item => ({ ...item, kind: 'command' }));
    const files = [...this.files.values()]
      .filter(file => file.path.toLocaleLowerCase().includes(query))
      .slice(0, 20)
      .map(file => ({
        title: file.path,
        detail: 'Project file',
        icon: isDataPath(file.path) ? 'i-table' : isPreviewable(file.path) ? 'i-book' : 'i-file',
        kind: 'file',
        action: () => this.openFile(file.path)
      }));
    const items = [...commands.slice(0, 25), ...files];
    const container = $('#command-results');
    container.replaceChildren();
    if (!items.length) {
      container.innerHTML = '<div class="empty-state compact-empty"><p>No matching commands or files.</p></div>';
      return;
    }
    items.forEach((item, index) => {
      const button = document.createElement('button');
      button.className = `command-result${index === this.commandSelection ? ' active' : ''}`;
      button.innerHTML = `<span class="command-icon">${svg(item.icon)}</span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></span>${item.shortcut ? `<kbd>${escapeHtml(item.shortcut)}</kbd>` : '<span></span>'}`;
      button.addEventListener('mouseenter', () => { this.commandSelection = index; this.updateCommandSelection(); });
      button.addEventListener('click', () => {
        $('#command-dialog').close();
        item.action();
      });
      container.append(button);
    });
  }

  updateCommandSelection() {
    $$('.command-result', $('#command-results')).forEach((item, index) => item.classList.toggle('active', index === this.commandSelection));
    $$('.command-result', $('#command-results'))[this.commandSelection]?.scrollIntoView({ block: 'nearest' });
  }

  searchWorkspace() {
    const query = $('#workspace-search-input').value;
    const results = $('#workspace-search-results');
    if (!query) {
      results.className = 'search-results empty-state compact-empty';
      results.innerHTML = '<p>Type to search your project.</p>';
      return;
    }
    const caseSensitive = $('#search-case').checked;
    const regexMode = $('#search-regex').checked;
    let pattern;
    try {
      pattern = regexMode ? new RegExp(query, caseSensitive ? 'g' : 'gi') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
    } catch (error) {
      results.className = 'search-results empty-state compact-empty';
      results.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
      return;
    }
    const matches = [];
    let skippedLargeFiles = 0;
    let totalHits = 0;
    for (const file of this.files.values()) {
      if (typeof file.content !== 'string') continue;
      if (Number(file.size || file.content.length) > MAX_EDITOR_BYTES) {
        skippedLargeFiles += 1;
        continue;
      }
      const hits = [];
      file.content.split('\n').some((line, row) => {
        pattern.lastIndex = 0;
        const match = pattern.exec(line);
        if (match && hits.length < 50) hits.push({ row, column: match.index, length: match[0].length, line });
        return hits.length >= 50;
      });
      if (hits.length) {
        matches.push({ file, hits });
        totalHits += hits.length;
      }
      if (totalHits >= 250) break;
    }
    results.className = 'search-results';
    results.replaceChildren();
    if (!matches.length) {
      results.className = 'search-results empty-state compact-empty';
      results.innerHTML = '<p>No project matches.</p>';
      return;
    }
    for (const group of matches) {
      const node = document.createElement('div');
      node.className = 'search-result-group';
      node.innerHTML = `<div class="search-result-file">${svg('i-file')}<span>${escapeHtml(group.file.path)}</span><span class="badge count">${group.hits.length}</span></div>`;
      for (const hit of group.hits) {
        const button = document.createElement('button');
        button.className = 'search-result-hit';
        const before = hit.line.slice(0, hit.column);
        const matched = hit.line.slice(hit.column, hit.column + (hit.length || query.length));
        const after = hit.line.slice(hit.column + matched.length);
        button.innerHTML = `<span>${hit.row + 1}</span> ${escapeHtml(before)}<mark>${escapeHtml(matched)}</mark>${escapeHtml(after)}`;
        button.addEventListener('click', () => this.openFile(group.file.path, { row: hit.row, column: hit.column }));
        node.append(button);
      }
      results.append(node);
    }
    if (skippedLargeFiles) {
      const notice = document.createElement('p');
      notice.className = 'sidebar-note';
      notice.textContent = `${skippedLargeFiles} file${skippedLargeFiles === 1 ? '' : 's'} larger than ${formatBytes(MAX_EDITOR_BYTES)} skipped to keep search responsive.`;
      results.prepend(notice);
    }
  }

  bindDragAndDrop() {
    const workbench = $('#workbench');
    let depth = 0;
    workbench.addEventListener('dragenter', event => {
      if (![...event.dataTransfer.types].includes('Files')) return;
      event.preventDefault();
      depth += 1;
      workbench.style.boxShadow = 'inset 0 0 0 2px var(--primary)';
    });
    workbench.addEventListener('dragover', event => {
      if ([...event.dataTransfer.types].includes('Files')) event.preventDefault();
    });
    workbench.addEventListener('dragleave', () => {
      depth -= 1;
      if (depth <= 0) workbench.style.boxShadow = '';
    });
    workbench.addEventListener('drop', event => {
      if (![...event.dataTransfer.files].length) return;
      event.preventDefault();
      depth = 0;
      workbench.style.boxShadow = '';
      this.uploadFiles([...event.dataTransfer.files]);
    });
    $$('[data-welcome-action]').forEach(button => button.addEventListener('click', () => {
      const action = button.dataset.welcomeAction;
      if (action === 'new-rmd') this.createRMarkdownFile();
      if (action === 'new') this.createFile();
      if (action === 'upload') $('#file-input').click();
      if (action === 'command') this.openCommandPalette();
      if (action === 'sample') this.loadSampleProject();
    }));
  }

  async ensureAssistant() {
    if (this.assistant && !this.assistant.disposed) return this.assistant;
    if (!this.assistantPromise) {
      // Opening the pane loads only small UI modules, never the model or WebLLM.
      this.assistantPromise = import('./assistant.js?v=1.6.0').then(({ AssistantPanel }) => {
        this.assistant = new AssistantPanel(this);
        return this.assistant;
      }).finally(() => { this.assistantPromise = null; });
    }
    return this.assistantPromise;
  }

  async showAssistant({ suggest = false, target = this.currentFocus } = {}) {
    try {
      if (this.maximizedPaneId && this.maximizedPaneId !== $('#panel-assistant').closest('.dock-pane')?.id) this.restoreMaximizedPane();
      this.activatePanel('assistant');
      const assistant = await this.ensureAssistant();
      assistant.refreshObjectChoices();
      assistant.updateState();
      if (suggest) await assistant.suggest(target);
      else $('#assistant-prompt').focus();
    } catch (error) {
      this.ui.toast('Local R assistant', error.message || String(error), 'error');
    }
  }

  checkCodeWithMistral() {
    const code = this.editor.getSelection().trim() || this.editor.getRunText().trim();
    if (!code) return this.ui.toast('No R code selected', 'Highlight code or place the cursor in an expression first.', 'info');
    safeOpen(mistralCodeUrl(code));
  }

  async persistGistToken() {
    const persist = $('#persist-gist-token').checked;
    const token = $('#gist-token').value.trim();
    this.settings.gistTokenPersisted = persist;
    if (persist && token) await workspaceDB.set('gistToken', token);
    else await workspaceDB.delete('gistToken');
    this.persistSettingsDebounced();
  }

  async importFromGist() {
    const reference = $('#gist-reference').value.trim();
    const token = $('#gist-token').value.trim();
    if (!reference) return this.ui.toast('Gist reference required', 'Enter a Gist URL or ID.', 'info');
    try {
      $('#import-gist-button').disabled = true;
      const gist = await importGist(reference, token);
      const existing = new Set([...this.files.keys(), ...this.runtimeProjectFiles.keys()]);
      const oversized = gist.files.find(file => Number(file.size) > MAX_FILE_BYTES);
      if (oversized) throw new Error(`${oversized.path} exceeds the 100 MB import limit.`);
      const records = gist.files.map(file => {
        const path = makeUniqueName(file.path, existing);
        existing.add(path);
        return fileRecord({ ...file, path });
      });
      for (const record of records) {
        this.files.set(record.path, record);
        if (isEditableFile(record)) this.editor.addOrUpdateFile(record);
      }
      await workspaceDB.putFiles(records);
      await this.mirrorFilesWhenIdle(records);
      this.renderFileTree();
      const firstEditable = records.find(isEditableFile);
      const firstData = records.find(file => isDataPath(file.path));
      if (firstEditable) this.openFile(firstEditable.path);
      else if (firstData) this.openDataFile(firstData.path);
      const result = $('#gist-result');
      result.hidden = false;
      result.innerHTML = `<strong>${escapeHtml(gist.description || `Gist ${gist.id}`)}</strong><br>${records.length} files imported from ${escapeHtml(gist.owner || 'GitHub')}.`;
      this.ui.toast('Gist imported', `${records.length} file${records.length === 1 ? '' : 's'} added.`, 'success');
    } catch (error) {
      this.ui.toast('Gist import failed', error.message, 'error', 0);
    } finally {
      $('#import-gist-button').disabled = false;
    }
  }

  openGistExport() {
    const textFiles = [...this.files.values()].filter(file => typeof file.content === 'string');
    if (!textFiles.length) return this.ui.toast('No text files', 'Gists can include R scripts, Markdown, and text-based data files.', 'info');
    const list = $('#gist-file-list');
    list.replaceChildren();
    for (const file of textFiles) {
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" value="${escapeHtml(file.path)}" ${this.selectedFiles.has(file.path) || file.path === this.activePath ? 'checked' : ''}><code>${escapeHtml(file.path)}</code><span style="margin-left:auto;color:var(--text-subtle);font-size:10px">${formatBytes(file.size)}</span>`;
      list.append(label);
    }
    if (![...list.querySelectorAll('input:checked')].length) list.querySelector('input').checked = true;
    $('#gist-export-dialog').showModal();
  }

  async publishGist() {
    const token = $('#gist-token').value.trim();
    const paths = [...$('#gist-file-list').querySelectorAll('input:checked')].map(input => input.value);
    const files = paths.map(path => this.files.get(path)).filter(file => typeof file?.content === 'string');
    const isPublic = document.querySelector('input[name="gist-visibility"]:checked')?.value === 'public';
    try {
      $('#publish-gist-button').disabled = true;
      const gist = await createGist({
        description: $('#gist-description').value.trim() || 'R project from webR Studio',
        isPublic,
        files,
        token
      });
      $('#gist-export-dialog').close();
      const result = $('#gist-result');
      result.hidden = false;
      result.innerHTML = `<strong>Gist created</strong><br><a href="${escapeHtml(gist.html_url)}" target="_blank" rel="noopener noreferrer">Open ${escapeHtml(gist.id)} on GitHub</a>`;
      this.ui.toast('Gist published', `${files.length} file${files.length === 1 ? '' : 's'} saved to GitHub.`, 'success');
      await this.persistGistToken();
    } catch (error) {
      this.ui.toast('Gist publication failed', error.message, 'error', 0);
    } finally {
      $('#publish-gist-button').disabled = false;
    }
  }

  async serializeWorkspace({ includeCheckpoint = true } = {}) {
    await this.flushProjectBackup();
    const files = [...this.files.values()].map(file => ({
      path: file.path,
      type: file.type,
      mime: file.mime,
      size: file.size,
      updatedAt: file.updatedAt,
      encoding: typeof file.content === 'string' ? 'utf8' : 'base64url',
      content: typeof file.content === 'string' ? file.content : bytesToBase64Url(file.content)
    }));
    const checkpoint = includeCheckpoint ? await workspaceDB.get('rCheckpoint', null) : null;
    const clone = value => globalThis.structuredClone
      ? globalThis.structuredClone(value)
      : JSON.parse(JSON.stringify(value));
    return {
      format: 'webr-studio-workspace',
      version: 1,
      appVersion: APP_VERSION,
      createdAt: Date.now(),
      settings: clone(this.settings),
      files,
      directories: [...this.projectDirectories],
      openTabs: [...this.openTabs],
      activePath: this.activePath,
      console: {
        history: [...(this.console?.history || this.consoleState.history)],
        transcript: clone(this.console?.transcript || this.consoleState.transcript),
        draft: this.console?.getPersistableDraft?.() ?? this.consoleState.draft
      },
      plots: clone(this.plots),
      expandedFolders: [...this.expandedFolders],
      rCheckpoint: checkpoint ? bytesToBase64Url(new Uint8Array(checkpoint)) : null
    };
  }

  async applyWorkspaceState(state, { persist = true, live = true } = {}) {
    if (!state || state.format !== 'webr-studio-workspace' || !Array.isArray(state.files)) throw new Error('This is not a valid webR Studio workspace.');
    if (live && this.engine.running) throw new Error('Stop the current R expression before replacing the workspace.');
    if (this.fileMutationPending) throw new Error('Wait for the current file operation before replacing the workspace.');
    // Reject malformed imports before disabling the current project's backup.
    const newFiles = new Map();
    for (const item of state.files) {
      const content = item.encoding === 'base64url' ? base64UrlToBytes(item.content) : String(item.content || '');
      const record = fileRecord({ ...item, content });
      newFiles.set(record.path, record);
    }
    const directories = (Array.isArray(state.directories) ? state.directories : []).map(projectRelativePath);
    const checkpoint = state.rCheckpoint ? base64UrlToBytes(state.rCheckpoint) : null;
    const previousPersistence = {
      ready: this.projectPersistenceReady, pending: this.projectPersistencePending,
      error: this.projectPersistenceError, runtime: this.engine.webR, generation: this.engine.generation
    };
    let replacementCommitted = false;
    this.projectBackupDebounced.cancel();
    this.projectPersistenceReady = false;
    this.projectPersistenceEpoch += 1;
    this.runtimeFilesRequest += 1;
    this.autosaveDebounced?.cancel?.();
    this.persistWorkspaceDebounced?.cancel?.();
    this.persistSettingsDebounced?.cancel?.();
    this.checkpointDebounced?.cancel?.();
    this.environmentDebounced?.cancel?.();
    this.fileMutationPending = true;
    try {
      await Promise.allSettled([...this.fileSaveQueues.values()]);
      await this.mirrorOperationQueue;
      this.persistWorkspaceDebounced?.cancel?.();
      if (persist) {
        await workspaceDB.commitProjectSnapshot({ files: [...newFiles.values()],
          deletedPaths: [...this.files.keys()].filter(path => !newFiles.has(path)), directories });
      }
      replacementCommitted = true;
      this.assistant?.clear();
      this.fileSaveQueues.clear();
      this.deletingFiles.clear();
      this.pendingMirrors.clear();
      this.pendingMirrorDeletes.clear();
      this.runtimeProjectFiles.clear();
      this.runtimeFiles = [];
      this.runtimeFilesPath = '/project';
      this.runtimeFilesRefreshPending = true;
      this.settings = deepSettings(state.settings || {});
      this.files = newFiles;
      this.projectDirectories = new Set(directories);
      this.runtimeKnownFiles.clear();
      this.projectPersistenceError = '';
      this.projectPersistencePending = false;
      if (persist) {
        if (checkpoint) await workspaceDB.set('rCheckpoint', checkpoint);
        else await workspaceDB.delete('rCheckpoint');
      }
      this.openTabs = (state.openTabs || []).filter(path => newFiles.has(path));
      this.activePath = [state.activePath, ...this.openTabs, ...newFiles.keys()]
        .find(path => isEditableFile(newFiles.get(path))) || null;
      this.consoleState = {
        history: state.console?.history || [],
        transcript: state.console?.transcript || [],
        draft: state.console?.draft || ''
      };
      this.plots = Array.isArray(state.plots) ? state.plots.slice(-30) : [];
      this.plotIndex = this.plots.length ? this.plots.length - 1 : -1;
      this.expandedFolders = new Set(state.expandedFolders || []);
      this.folderExpansionInitialized = Array.isArray(state.expandedFolders);
      this.autosaveDebounced?.cancel?.();
      this.autosaveDebounced = debounce(() => this.saveDirtyFiles(), this.settings.autosaveDelay);
      if (persist) {
        await workspaceDB.set('settings', this.settings);
        await this.persistWorkspaceMeta();
      }
      if (live && this.editor) {
        for (const path of [...this.editor.files.keys()]) this.editor.removeFile(path);
        for (const file of this.files.values()) if (isEditableFile(file)) this.editor.addOrUpdateFile(file);
        this.console.history = [...this.consoleState.history];
        this.console.historyIndex = this.console.history.length;
        this.console.transcript = [...this.consoleState.transcript];
        this.console.setValue(this.consoleState.draft);
        await this.console.renderTranscript();
        this.applyAppearance();
        this.restoreDockLayout();
        this.renderAll();
        this.openInitialFile();
        if (this.engine.ready) {
          await this.engine.clearEnvironment().catch(() => {});
          await this.engine.clearMirroredFiles();
          await this.restoreProjectFiles();
          if (checkpoint) await this.engine.restoreEnvironment(checkpoint);
          this.projectPersistenceReady = true;
          await this.refreshEnvironment();
          this.fileMutationPending = false;
          await this.refreshRuntimeFiles('/project', { quiet: true });
        }
      }
    } catch (error) {
      if (!replacementCommitted && previousPersistence.runtime === this.engine.webR &&
          previousPersistence.generation === this.engine.generation) {
        this.projectPersistenceReady = previousPersistence.ready;
        this.projectPersistenceError = previousPersistence.error;
        this.projectPersistencePending = previousPersistence.pending || Boolean(this.pendingMirrors.size ||
          this.pendingMirrorDeletes.size || [...this.files.values()].some(file => file.dirty));
        this.runtimeFilesLoading = false;
        this.projectSnapshotInProgress = false;
        if (this.projectPersistenceReady && this.projectPersistencePending) this.projectBackupDebounced();
        if ([...this.files.values()].some(file => file.dirty)) this.autosaveDebounced();
      } else if (replacementCommitted) {
        this.projectPersistenceReady = false;
        this.projectPersistencePending = true;
        this.projectPersistenceError = `The imported files were saved, but project restoration did not finish: ${error.message || String(error)} Restart R to restore the saved project.`;
      }
      throw error;
    } finally {
      this.fileMutationPending = false;
      this.updateProjectSaveStatus();
    }
  }

  async exportWorkspaceJson() {
    try {
      await this.saveDirtyFiles();
      const state = await this.serializeWorkspace({ includeCheckpoint: true });
      downloadText(JSON.stringify(state, null, 2), localTimestampName('webr-studio-workspace', 'json'), 'application/json;charset=utf-8');
      this.ui.toast('Workspace exported', 'Files, settings, console state, plots, and the R checkpoint were included.', 'success');
    } catch (error) {
      this.ui.toast('Workspace export failed', error.message, 'error', 0);
    }
  }

  async importWorkspaceJson(file) {
    if (!file) return;
    try {
      const state = JSON.parse(await file.text());
      const accepted = await this.ui.confirm('Replace the current workspace?', 'The imported project will replace local files and settings. The current project can be exported first.', { acceptLabel: 'Import workspace' });
      if (!accepted) return;
      await this.applyWorkspaceState(state, { persist: true, live: true });
      this.ui.toast('Workspace imported', `${state.files.length} files restored.`, 'success');
    } catch (error) {
      this.ui.toast('Workspace import failed', error.message, 'error', 0);
    }
  }

  async shareWorkspaceUrl() {
    try {
      await this.saveDirtyFiles();
      const state = await this.serializeWorkspace({ includeCheckpoint: true });
      const estimatedPortableBytes = state.files.reduce((total, file) => total + Number(file.size || 0), 0)
        + (state.rCheckpoint ? Math.ceil(state.rCheckpoint.length * 0.75) : 0);
      const encoded = estimatedPortableBytes <= 1_000_000 ? await encodeWorkspaceState(state) : '';
      const url = new URL(location.href);
      url.search = '';
      if (encoded && encoded.length <= MAX_URL_STATE_CHARS) {
        url.hash = `workspace=${encoded}`;
        await copyText(url.toString());
        this.ui.toast('Workspace URL copied', 'Opening the URL restores files, settings, console state, plots, and a compact R checkpoint.', 'success', 8000);
      } else {
        const id = uid('snapshot');
        const snapshot = { id, name: `URL snapshot ${formatDate()}`, createdAt: Date.now(), state };
        await workspaceDB.putSnapshot(snapshot);
        this.snapshots.unshift(snapshot);
        url.hash = `snapshot=${id}`;
        await copyText(url.toString());
        this.renderSnapshots();
        this.ui.toast('Local snapshot URL copied', 'The workspace is too large for a portable URL. This shorter link restores it only in this browser profile.', 'warning', 10000);
      }
    } catch (error) {
      this.ui.toast('Could not create workspace URL', error.message, 'error', 0);
    }
  }

  async createSnapshot() {
    const name = await this.ui.prompt('Create workspace snapshot', 'Snapshots include project files, settings, console state, plots, and the R checkpoint.', { value: `Snapshot ${formatDate()}`, acceptLabel: 'Create snapshot' });
    if (!name) return;
    const state = await this.serializeWorkspace({ includeCheckpoint: true });
    const snapshot = { id: uid('snapshot'), name, createdAt: Date.now(), state };
    await workspaceDB.putSnapshot(snapshot);
    this.snapshots.unshift(snapshot);
    this.renderSnapshots();
    this.ui.toast('Snapshot created', name, 'success');
  }

  renderSnapshots() {
    const container = $('#snapshots-list');
    if (!this.snapshots.length) {
      container.className = 'snapshot-list empty-state compact-empty';
      container.innerHTML = '<p>No manual snapshots yet.</p>';
      return;
    }
    container.className = 'snapshot-list';
    container.replaceChildren();
    for (const snapshot of this.snapshots) {
      const card = document.createElement('article');
      card.className = 'snapshot-card';
      card.innerHTML = `<header>${svg('i-database')}<strong>${escapeHtml(snapshot.name)}</strong></header><p>${formatDate(snapshot.createdAt)} · ${snapshot.state.files?.length || 0} files</p><footer><button class="button secondary small" data-action="restore">Restore</button><button class="button ghost small" data-action="link">Copy link</button><button class="button danger-ghost small" data-action="delete">Delete</button></footer>`;
      card.querySelector('[data-action="restore"]').addEventListener('click', async () => {
        const accepted = await this.ui.confirm('Restore this snapshot?', 'The current browser workspace will be replaced.', { acceptLabel: 'Restore', danger: false });
        if (!accepted) return;
        await this.applyWorkspaceState(snapshot.state, { persist: true, live: true });
        this.ui.toast('Snapshot restored', snapshot.name, 'success');
      });
      card.querySelector('[data-action="link"]').addEventListener('click', async () => {
        const url = new URL(location.href);
        url.search = '';
        url.hash = `snapshot=${snapshot.id}`;
        await copyText(url.toString());
        this.ui.toast('Local snapshot link copied', 'This link works in the same browser profile.', 'success');
      });
      card.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        await workspaceDB.deleteSnapshot(snapshot.id);
        this.snapshots = this.snapshots.filter(item => item.id !== snapshot.id);
        this.renderSnapshots();
      });
      container.append(card);
    }
  }

  async persistWorkspaceMeta() {
    const meta = {
      openTabs: this.openTabs,
      activePath: this.activePath,
      consoleHistory: this.console?.history || this.consoleState.history,
      consoleTranscript: this.console?.transcript || this.consoleState.transcript,
      consoleDraft: this.console?.getPersistableDraft?.() ?? this.consoleState.draft,
      plots: this.plots.slice(-30),
      expandedFolders: [...this.expandedFolders],
      updatedAt: Date.now()
    };
    await workspaceDB.set('workspace', meta);
  }

  showAbout() {
    const runtime = this.engine.ready ? describeRuntime(this.engine) : 'R runtime offline';
    this.ui.toast(`webR Studio ${APP_VERSION}`, `${runtime}. Files remain in this browser unless you explicitly download or publish them.`, 'info', 10000);
  }
}

const app = new WebRStudioApp();
app.start();
globalThis.webRStudio = app;
