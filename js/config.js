export const APP_VERSION = '1.2.9';
export const WEBR_VERSION = '0.6.0';
export const WEBR_VERSION_SUGGESTIONS = Object.freeze([
  'latest', '0.6.0', '0.5.9', '0.5.8', '0.5.7', '0.5.6'
]);
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_EDITOR_BYTES = 4 * 1024 * 1024;
export const MAX_URL_STATE_CHARS = 24_000;

export function normalizeWebRVersion(value = WEBR_VERSION) {
  const version = String(value || '').trim().replace(/^v(?=\d)/i, '');
  if (!version) return WEBR_VERSION;
  if (version.toLowerCase() === 'latest') return 'latest';
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Enter “latest” or a webR release such as 0.6.0.');
  }
  return version;
}

export function webRBaseUrl(version = WEBR_VERSION) {
  const normalized = normalizeWebRVersion(version);
  const directory = normalized === 'latest' ? 'latest' : `v${normalized}`;
  return `https://webr.r-wasm.org/${directory}/`;
}

export function webRModuleUrl(version = WEBR_VERSION) {
  return `${webRBaseUrl(version)}webr.mjs`;
}

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',
  webrVersion: WEBR_VERSION,
  editorTheme: 'crimson_editor',
  darkEditorTheme: 'one_dark',
  fontFamily: 'Ubuntu Mono',
  fontSize: 14,
  fontWeight: 400,
  ligatures: true,
  density: 'comfortable',
  tabSize: 2,
  wordWrap: false,
  printMargin: true,
  highlightActiveLine: true,
  rainbowDelimiters: true,
  lint: true,
  autocomplete: true,
  typeHints: true,
  consoleHeight: 38,
  consoleHistoryLimit: 1000,
  autoTraceback: true,
  consoleFollow: true,
  pipe: '|>',
  timing: false,
  checkpointEnvironment: true,
  restoreEnvironment: true,
  plotWidth: 7,
  plotHeight: 5,
  autosaveDelay: 700,
  sidebarWidth: 244,
  rightWidth: 390,
  dockRatio: 51,
  activeSidebar: 'explorer',
  dockPanels: {
    top: ['environment', 'files', 'outline', 'packages'],
    bottom: ['plots', 'help', 'data', 'preview']
  },
  activeDock: { top: 'environment', bottom: 'plots' },
  gistTokenPersisted: false,
  lastProjectName: 'project'
});

export const SAMPLE_FILES = [
  {
    path: 'welcome.R',
    type: 'text',
    content: `# Welcome to webR Studio\n# Run a line or selection with Ctrl+Enter.\n\nset.seed(42)\npoints <- data.frame(\n  x = rnorm(250),\n  y = rnorm(250),\n  group = sample(c("A", "B", "C"), 250, replace = TRUE)\n)\n\nsummary(points)\n\nplot(\n  points$x, points$y,\n  col = as.integer(factor(points$group)),\n  pch = 19,\n  xlab = "x", ylab = "y",\n  main = "A plot rendered as SVG"\n)\n\nhead(points)\n`,
    mime: 'text/x-r-source'
  },
  {
    path: 'report.Rmd',
    type: 'text',
    content: `# Browser-native R Markdown\n\nThis lightweight preview executes R chunks directly in webR and renders Markdown locally.\n\n\`\`\`{r summary, echo=TRUE}\nvalues <- rnorm(100)\nsummary(values)\n\`\`\`\n\n## Plot\n\n\`\`\`{r chart, echo=TRUE}\nhist(values, col = "#9f1239", border = "white", main = "Distribution")\n\`\`\`\n`,
    mime: 'text/x-r-markdown'
  },
  {
    path: 'data/example.csv',
    type: 'text',
    content: `id,category,value,active\n1,A,12.5,true\n2,B,8.1,false\n3,A,19.2,true\n4,C,4.8,true\n5,B,11.0,false\n`,
    mime: 'text/csv'
  }
];
