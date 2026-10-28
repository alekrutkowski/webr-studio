import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = path => readFileSync(join(root, path), 'utf8');
const html = read('index.html');

const ids = [...html.matchAll(/\bid="([A-Za-z][\w:.-]*)"/g)].map(match => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepEqual([...new Set(duplicateIds)], [], `Duplicate HTML ids: ${[...new Set(duplicateIds)].join(', ')}`);
const idSet = new Set(ids);

const walk = directory => readdirSync(directory).flatMap(name => {
  const absolute = join(directory, name);
  if (name === '.git') return [];
  return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
});

const jsFiles = walk(join(root, 'js')).filter(path => path.endsWith('.js'));
for (const file of [...jsFiles, join(root, 'coi-serviceworker.js')]) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

const missingIds = new Map();
for (const file of jsFiles) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/['"`]#([A-Za-z][\w:-]*)/g)) {
    const id = match[1];
    if (!idSet.has(id) && !id.startsWith('i-') && !id.endsWith('-') && !/^[0-9a-f]{3,8}$/i.test(id)) {
      const list = missingIds.get(id) || [];
      list.push(relative(root, file));
      missingIds.set(id, list);
    }
  }
}
assert.equal(missingIds.size, 0, `JavaScript references missing HTML ids: ${[...missingIds].map(([id, files]) => `${id} (${[...new Set(files)].join(', ')})`).join('; ')}`);

const localReferences = [
  ...html.matchAll(/(?:src|href)="(?!https?:|data:|#|mailto:)([^"?]+)(?:\?[^"#]*)?"/g),
  ...read('manifest.webmanifest').matchAll(/"(?:src|start_url)"\s*:\s*"(?!https?:|data:)([^"?]+)(?:\?[^"#]*)?"/g)
].map(match => match[1].replace(/^\.\//, ''));
for (const reference of localReferences) {
  if (!reference || reference === '.') continue;
  assert.ok(existsSync(join(root, reference)), `Missing local asset referenced by markup: ${reference}`);
}

// Keep the hard-coded presence list deliberately minimal. Files referenced by
// index.html, the web manifest, or JavaScript imports are verified dynamically,
// so optional documentation and examples never gate deployment.
for (const required of [
  'index.html', 'package.json', '.github/workflows/pages.yml',
  'tests/unit-check.mjs', '.nojekyll', '404.html'
]) {
  assert.ok(existsSync(join(root, required)), `Required project file is missing: ${required}`);
}

// Verify local ES-module dependencies without maintaining a second hard-coded
// inventory of implementation files.
for (const file of jsFiles) {
  const source = readFileSync(file, 'utf8');
  const specifiers = [
    ...source.matchAll(/(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/g),
    ...source.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)
  ].map(match => match[1].split(/[?#]/, 1)[0]);

  for (const specifier of specifiers) {
    const dependency = resolve(dirname(file), specifier);
    assert.ok(
      existsSync(dependency),
      `Missing local module imported by ${relative(root, file)}: ${specifier}`
    );
  }
}

const config = read('js/config.js');
const versionMatch = config.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
assert.ok(versionMatch, 'js/config.js must declare APP_VERSION.');
const appVersion = versionMatch[1];
const packageMetadata = JSON.parse(read('package.json'));
assert.equal(packageMetadata.version, appVersion, 'package.json and APP_VERSION must agree.');
assert.match(config, /export const WEBR_VERSION_SUGGESTIONS\s*=/, 'The configuration module must export webR version suggestions.');

for (const file of jsFiles) {
  const source = readFileSync(file, 'utf8');
  const localImports = [
    ...source.matchAll(/(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+\.js(?:\?[^'"]*)?)['"]/g),
    ...source.matchAll(/import\(\s*['"](\.[^'"]+\.js(?:\?[^'"]*)?)['"]\s*\)/g)
  ].map(match => match[1]);
  for (const specifier of localImports) {
    assert.match(
      specifier,
      new RegExp(`\\?v=${appVersion.replaceAll('.', '\\.')}$`),
      `Local browser module imported by ${relative(root, file)} must be pinned to application version ${appVersion}: ${specifier}`
    );
  }
}
assert.match(html, new RegExp(`styles\\.css\\?v=${appVersion.replaceAll('.', '\\.')}`), 'CSS cache key must match APP_VERSION.');
assert.match(html, new RegExp(`js/app\\.js\\?v=${appVersion.replaceAll('.', '\\.')}`), 'Application module cache key must match APP_VERSION.');
assert.match(html, new RegExp(`coi-serviceworker\\.js\\?v=${appVersion.replaceAll('.', '\\.')}`), 'Service-worker bootstrap cache key must match APP_VERSION.');
const serviceWorkerSource = read('coi-serviceworker.js');
assert.match(serviceWorkerSource, /registration\.update\(\)/, 'The page bootstrap must check for service-worker updates even when already isolated.');
assert.match(serviceWorkerSource, /cache:\s*'no-store'/, 'Application shell requests must bypass stale browser caches.');
assert.match(serviceWorkerSource, /Cache-Control['"],\s*['"]no-store/, 'Application shell responses must not be cached across releases.');

assert.match(config, /WEBR_VERSION\s*=\s*['"]0\.6\.0['"]/, 'webR 0.6.0 should remain the default runtime.');
assert.match(config, /normalizeWebRVersion/, 'webR release identifiers must be validated.');
assert.match(config, /webRModuleUrl/, 'The selected webR release must resolve to a module URL.');
assert.match(html, /ace-builds@1\.44\.0/, 'Ace should be pinned to 1.44.0');
assert.match(html, /marked@18\.0\.7\/lib\/marked\.umd\.js/, 'Marked should use its published UMD browser bundle.');
assert.doesNotMatch(html, /marked@18\.0\.7\/marked\.min\.js/, 'Do not reference the nonexistent top-level Marked bundle.');
assert.match(html, /katex@0\.18\.1\/dist\/katex\.min\.js/, 'KaTeX should be pinned for maths rendering.');
assert.match(html, /dompurify@3\.2\.7/, 'DOMPurify should be pinned to 3.2.7');
assert.match(html, /Run selected<\/span>/, 'The primary run action should use the compact label.');
assert.doesNotMatch(html, /Run selected expression/, 'The old verbose run label should not remain.');
assert.match(html, /Ctrl(?:\+| )Alt(?:\+| )N/, 'New-file UI should avoid the browser-reserved Ctrl+N shortcut.');
assert.match(html, /Ctrl Alt O/, 'Open-file UI should avoid the browser-reserved Ctrl+O shortcut.');
assert.match(html, /id="new-file-button"[^>]*aria-haspopup="menu"/, 'The toolbar New button must expose file-type choices.');
assert.match(html, /id="sidebar-new-file"[^>]*aria-haspopup="menu"/, 'The Explorer New button must expose file-type choices.');
assert.match(html, /id="preview-active-button"[\s\S]*?>[\s\S]*?<span>Render<\/span>/, 'Markdown files need a clear editor Render button.');
assert.match(html, /id="download-preview-html"/, 'Rendered documents need a self-contained HTML download button.');
assert.match(html, /id="download-preview-gfm"/, 'R Markdown previews need a GitHub-flavored Markdown ZIP download button.');
assert.match(html, /id="webr-version-input"[^>]*list="webr-version-options"/, 'R execution settings need a webR version selector.');
assert.match(html, /id="apply-webr-version"/, 'The selected webR version needs an explicit restart action.');
assert.equal((html.match(/data-maximize-pane=/g) || []).length >= 8, true, 'Every major workbench pane needs a maximize control.');


for (const id of ['editor-more-button', 'dock-more-top', 'dock-more-bottom']) {
  assert.match(html, new RegExp(`id="${id}"[^>]*menu-trigger[^>]*aria-haspopup="menu"`), `${id} must be a functional menu trigger.`);
}
const appSource = read('js/app.js');
assert.match(appSource, /showNewFileMenu/, 'New-file buttons must open a menu.');
assert.match(appSource, /createRMarkdownFile/, 'The IDE must provide an Rmd creation action.');
assert.match(appSource, /downloadRMarkdownGfmBundle/, 'The IDE must export evaluated R Markdown as a GFM bundle.');
assert.match(appSource, /gfmBundleFiles/, 'The GFM export must package Markdown and generated images together.');
assert.ok(appSource.indexOf("label: 'New Rmd file'") < appSource.indexOf("label: 'New R script'"), 'New Rmd file must appear above New R script.');
assert.match(appSource, /NEW_RMD_TEMPLATE[\s\S]*output: html_document/, 'New Rmd files should start with a renderable header.');
assert.match(appSource, /\$\$\('\.menu-trigger\[data-menu\]'\)/, 'Only named application-menu buttons may receive the generic application-menu handler.');
assert.doesNotMatch(appSource, /\$\$\('\.menu-trigger'\)/, 'Generic menu binding must not hijack editor or dock overflow menus.');
const editorSource = read('js/editor.js');
const consoleSource = read('js/console.js');
const engineSource = read('js/webr-engine.js');
const styles = read('styles.css');
assert.match(appSource, /showEditorActionsMenu\(event\.currentTarget\)/, 'Editor actions button must have a handler.');
assert.match(appSource, /showDockOptionsMenu\(event\.currentTarget, 'top'\)/, 'Upper dock menu must have a handler.');
assert.match(appSource, /showDockOptionsMenu\(event\.currentTarget, 'bottom'\)/, 'Lower dock menu must have a handler.');
assert.match(editorSource, /enableLiveAutocompletion:\s*true/, 'Editor live completion should be enabled.');
assert.match(consoleSource, /enableLiveAutocompletion:\s*true/, 'Console live completion should be enabled.');
assert.match(editorSource, /acceptCompletionOrIndent/, 'Tab should explicitly accept editor completions.');
assert.match(consoleSource, /consoleAcceptCompletionOrIndent/, 'Tab should explicitly accept console completions.');
assert.match(editorSource, /defineRMarkdownMode/, 'The editor must register a dedicated R Markdown mode.');
assert.match(editorSource, /await Promise\.all\(\[[\s\S]*loadAceModule\(ace, 'ace\/mode\/markdown'\)[\s\S]*loadAceModule\(ace, 'ace\/mode\/r'\)/, 'The stock Markdown and R modes must load before the embedded R Markdown grammar is registered.');
assert.match(editorSource, /embedRules\(RHighlightRules, 'r-'/, 'R highlighting must be embedded only inside R Markdown chunks.');
assert.match(editorSource, /editorModeForPath\(path\)[\s\S]*return new Mode\(\)/, 'Rmd sessions must receive the already-registered custom mode rather than falling back to plain text.');
assert.match(editorSource, /rMarkdownChunkRanges[\s\S]*rmarkdown-chunk-background/, 'R Markdown chunks must receive dedicated full-line background markers.');
assert.match(styles, /\.ace_editor(?:\.ace_dark)? \.ace_marker-layer \.rmarkdown-chunk-background[\s\S]*background:/, 'R Markdown chunk backgrounds must be styled in the live editor.');
assert.match(appSource, /buildSelfContainedPreviewHtml/, 'Rendered Markdown must support self-contained HTML export.');
assert.match(appSource, /renderMathInElement/, 'Markdown rendering must process dollar-delimited maths.');
assert.match(appSource, /evaluateInlineR/, 'R Markdown rendering must evaluate inline R expressions.');
assert.match(html, /id="source-options-button"[^>]*aria-haspopup="menu"/, 'The Source control needs a visible options menu.');
assert.match(appSource, /showSourceOptionsMenu/, 'The Source split button must expose Source with Echo.');
assert.match(appSource, /sourceActiveFile\(\{ echo: true \}\)/, 'Source with Echo must be available from the UI.');
assert.match(engineSource, /async execute\(code, \{ capturePlots = true, plotWidth = null, plotHeight = null, onOutput = null \} = \{\}\)/, 'Ordinary console execution must accept a live output callback.');
assert.match(engineSource, /async sourceFile\(path, \{ echo = false, onOutput = null \} = \{\}\)/, 'The runtime must provide streamed file sourcing.');
assert.match(engineSource, /import\(this\.moduleUrl\)/, 'The webR module must be loaded from the selected release URL.');
assert.match(engineSource, /new WebR\(\{ interactive: true, baseUrl: this\.baseUrl \}\)/, 'Real-time output requires an interactive R REPL with a matching runtime base URL.');
assert.match(engineSource, /const first = await webR\.read\(\)[\s\S]*await webR\.flush\(\)/, 'The runtime must continuously drain and batch webR output messages as they are produced.');
assert.match(engineSource, /writeConsole\(command\)/, 'Interactive R operations must run through the console rather than captureR buffering.');
assert.match(engineSource, /e\$run_eval <- function/, 'The R helper must provide a guarded streaming evaluation entry point.');
assert.match(engineSource, /e\$run_source <- function/, 'The R helper must provide a guarded streaming source entry point.');
assert.match(engineSource, /\.webrStudio\$run_eval_file\(/, 'Ordinary execution must enter R through the file-backed streaming evaluation helper.');
assert.match(engineSource, /normalizeRSource[\s\S]*\\r\\n\?\|\\u2028\|\\u2029/, 'Submitted R code must normalize browser and Windows line endings before parsing.');
assert.match(engineSource, /FS\.writeFile\(commandPath[\s\S]*run_eval_file/, 'Multiline console input must be handed to R through a UTF-8 temporary file.');
assert.doesNotMatch(engineSource, /shelter\.captureR/, 'Ordinary execution must not buffer output with Shelter.captureR().');
assert.match(engineSource, /e\$emit\("ECHO"/, 'Source with Echo must emit one command event per top-level R expression.');
assert.match(appSource, /async executeCode[\s\S]*?this\.engine\.execute\(source,\s*\{[\s\S]*?onOutput:\s*async item[\s\S]*?appendStreamItem\(stream, item\)/, 'Ordinary console output must be appended while R is still executing.');
assert.match(appSource, /appendStreamItem\(stream, item\)/, 'Source output must be appended to the visible console during execution.');
assert.match(appSource, /result\.streamed = streamedConsoleOutput/, 'Silent console expressions must retain their completion card when nothing was streamed.');
assert.match(appSource, /const pendingViews = \[\]/, 'View() requests from streamed sources must be queued while R is busy.');
assert.match(appSource, /for \(const request of pendingViews\)/, 'Queued View() requests must open after source execution returns.');
assert.match(engineSource, /operation\.started && operation\.done && operation\.flushed && operation\.prompt/, 'Interactive operations must wait for completion, stdout flush, and the returning prompt.');
assert.match(engineSource, /<<WEBRSTUDIO:FLUSH>>/, 'The R helper must flush partial stdout at every execution boundary.');
assert.match(engineSource, /stripTerminalControlSequences/, 'Terminal control sequences must be removed from visible output.');
assert.match(consoleSource, /beginStream\(\)/, 'The console must support live output sessions.');
assert.match(consoleSource, /!result\.streamed/, 'A streamed run must not add a redundant silent-success card.');
assert.match(appSource, /extractHelpRequest\(source\)/, 'Console help expressions must be intercepted before R calls file.show().');
assert.match(appSource, /highlightHelpCode/, 'R help examples and usage blocks need syntax highlighting.');
assert.match(engineSource, /tools::Rd2HTML/, 'R help must be converted to HTML in the worker instead of using file.show().');
assert.match(appSource, /resolveRMarkdownFigureOptions/, 'R Markdown rendering must resolve chunk-level figure dimensions.');
assert.match(appSource, /plotWidth: figure\.width[\s\S]*plotHeight: figure\.height/, 'R Markdown chunk figures must use fig.width and fig.height at device creation time.');
assert.match(appSource, /appendAsisOutput[\s\S]*renderMarkdown\(clean\)/, "results='asis' must be passed back through the Markdown renderer as a complete block.");
assert.match(read('js/utils.js'), /CommonMark permits at most three leading spaces/, 'Indented fenced examples must not be executed as R chunks.');
assert.match(read('js/utils.js'), /ADD_TAGS:\s*\['semantics', 'annotation'\]/, 'MathML semantics and TeX annotations must survive sanitization.');
assert.match(engineSource, /previous\?\.type === item\.type[\s\S]*item\.type === 'stdout'[\s\S]*item\.type === 'stderr'/, 'Contiguous stream lines must be coalesced before R Markdown rendering.');
assert.match(styles, /\.prose \.r-chunk-output \{[^}]*white-space:\s*pre[^}]*line-height|\.prose \.r-chunk-output \{[^}]*font:\s*12px\/1\.35/s, 'Rendered R output should use compact, alignment-preserving preformatted layout.');
assert.match(styles, /\.console-entry\.command \.console-entry-body \{[^}]*display:\s*grid[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\)/s, 'Submitted console input must remain on the same line as the prompt.');
assert.match(styles, /\.prose \.math-display \{[^}]*overflow-y:\s*hidden/s, 'Display mathematics must not show a vertical scrollbar.');
assert.match(appSource, /const next = resolved === 'light' \? 'dark' : 'light'/, 'The title-bar theme action must toggle the visible light or dark theme in one click.');
const stopSource = appSource.slice(appSource.indexOf('  async stopExecution()'), appSource.indexOf('  async restartRuntime'));
assert.match(stopSource, /this\.engine\.requestInterrupt\(\)/, 'Stop must request webR interruption on the existing worker.');
assert.doesNotMatch(stopSource, /restartRuntime|engine\.restart/, 'Stop must never replace the R worker or destroy session state.');
assert.match(stopSource, /PostMessage channel/, 'Unavailable state-preserving interruption must explain the channel limitation.');
assert.match(engineSource, /preflightOutputMessages[\s\S]*operation\.done = true[\s\S]*setExecutionPhase\('finalizing'/, 'Completion markers must disable Stop before a browser-side output backlog is rendered.');
assert.match(engineSource, /scheduleReplOutput[\s\S]*drainReplOutput/, 'Large streamed output must be coalesced into browser render batches.');
assert.match(engineSource, /last_interrupted/, 'The result must distinguish a real R interrupt from a late boundary interrupt.');
assert.match(consoleSource, /submissionEpoch/, 'Console submissions need a generation guard across runtime restarts.');
assert.match(consoleSource, /resetExecutionState\([\s\S]*setReadOnly\(false\)/, 'The console must expose a reliable execution-lock reset.');
assert.match(appSource, /async restartRuntime[\s\S]*resetExecutionState\(\)[\s\S]*finally[\s\S]*resetExecutionState\(\)/, 'Explicit restart must restore console editability before and after the restart attempt.');
const coiSource = read('coi-serviceworker.js');
assert.match(coiSource, /controllerchange/, 'The isolation bootstrap must observe when the service worker gains control.');
assert.match(coiSource, /navigator\.serviceWorker\.controller[\s\S]*window\.location\.reload\(\)/, 'A newly controlled document must reload under the service worker headers.');
assert.match(engineSource, /cancelled:\s*true[\s\S]*Execution stopped\./, 'An explicit worker restart must resolve in-flight execution as an expected cancellation.');
assert.match(appSource, /if \(result\.cancelled\) return result;/, 'Cancelled console runs must skip post-run R queries while the worker restarts.');
assert.match(appSource, /if \(result\.cancelled\) return;/, 'Cancelled R Markdown chunks must stop rendering without querying the replacement worker.');
assert.match(appSource, /runtimeReadyLabel\(\)[\s\S]*R ready · R/, 'The ready status must include the active R version.');
for (const id of ['file-tree', 'runtime-files-path', 'runtime-files-up', 'runtime-files-home', 'runtime-files-refresh', 'sidebar-delete-files', 'explorer-file-status']) {
  assert.match(html, new RegExp(`id="${id}"`), `Unified Explorer UI is missing ${id}.`);
}
assert.doesNotMatch(html, /data-panel="files"|id="panel-files"|id="runtime-files-list"/, 'Files must have a single browser in the Explorer.');
assert.match(engineSource, /async listVirtualFiles\(directory = '\/project'\)/, 'The runtime must expose directory listings for generated files.');
assert.match(engineSource, /async readVirtualFile\(path\)[\s\S]*FS\.readFile/, 'Runtime files must be downloaded directly from webR FS bytes.');
assert.match(appSource, /async explorerFileContent\(path\)[\s\S]*readVirtualFile/, 'The Explorer must read generated files from the R filesystem.');
assert.match(engineSource, /async evaluateInline\(code\)/, 'The runtime must provide scalar inline-R evaluation.');
assert.match(appSource, /inlinePreviewAssets/, 'Document export must inline preview assets.');
assert.match(engineSource, /e\$View <- function/, 'The R runtime must install the IDE View() helper.');
assert.match(engineSource, /e\$views <- new\.env/, 'Temporary View() expressions should be kept outside the global environment.');
assert.match(engineSource, /object_name <- paste0\("@view:", key\)/, 'Temporary Viewer objects should use opaque internal handles.');
assert.match(engineSource, /e\$emit\("VIEW"/, 'View() must notify the JavaScript Viewer.');
assert.match(engineSource, /getObjectTree/, 'List-like R objects must support recursive Viewer inspection.');
assert.match(engineSource, /dev\.control\(displaylist = "enable"\)/, 'The SVG device must retain a display list for responsive plot replay.');
assert.match(appSource, /ResizeObserver/, 'Plot reflow must observe pane resizing.');
assert.match(read('js/data-viewer.js'), /navigateHistory/, 'The Viewer must implement back and forward history.');
assert.match(read('js/data-viewer.js'), /renderTree/, 'The Viewer must implement list and environment trees.');
assert.match(read('js/data-viewer.js'), /hideContainerRoot/, 'The recursive Viewer should hide redundant internal root rows.');
assert.match(read('js/data-viewer.js'), /this\.info\s*=\s*\{ \.\.\.objectInfo, name: displayName \}/, 'Viewer titles should expose the user expression rather than an internal object handle.');

assert.match(editorSource, /completer\.activated/, 'Tab completion acceptance must support Ace autocomplete activation state.');
assert.match(editorSource, /typeof popupState === 'function'/, 'Tab completion acceptance must tolerate Ace popup API variants.');
assert.match(consoleSource, /renderQueue\s*=\s*Promise\.resolve\(\)/, 'Console output must use an ordered asynchronous render queue.');
assert.match(consoleSource, /renderEpoch/, 'Clearing the console must invalidate stale asynchronous renders.');
assert.doesNotMatch(editorSource, /languageTools\.addCompleter/, 'Completers must not be registered globally.');
assert.match(engineSource, /startsWith\(names_, "\.__webRStudio_"\)/, 'Environment filtering must use a valid R expression.');
assert.doesNotMatch(styles, /border-bottom:\s*[^;]*(?:wavy|dotted)/, 'Editor overlays should not draw distracting curved or dotted underlines.');
assert.doesNotMatch(styles, /^svg\s*\{/m, 'Generic SVG rules must not override R plot text or glyph fills.');
assert.match(styles, /\.ui-icon\s*\{/, 'Application icon styling must be explicitly scoped.');
assert.match(styles, /\.r-plot-svg\s*\{[^}]*fill:\s*#000[^}]*stroke:\s*none/s, 'R plot SVGs need a paint reset independent of UI icon rules.');
assert.match(read('js/utils.js'), /ADD_TAGS:\s*\['style', 'symbol', 'use'\]/, 'SVG sanitization must preserve glyph symbols and use elements.');
const escapedAssetVersion = appVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
assert.match(html, new RegExp(`styles\\.css\\?v=${escapedAssetVersion}`), 'The stylesheet must use the current cache-busting version.');
assert.match(html, new RegExp(`js/app\\.js\\?v=${escapedAssetVersion}`), 'The application module must use the current cache-busting version.');
assert.match(styles, /grid-template-columns:\s*14px[^;]+/s, 'List tree rows need a dedicated disclosure column for alignment.');
assert.match(styles, /\.plot-viewer \.plot-frame img[^}]*width:\s*100%[^}]*height:\s*100%[^}]*object-fit:\s*contain/s, 'Plots must fill and reflow within the active viewer.');
assert.match(appSource, /this\.editor\.deactivate\(\)/, 'Closing or deleting the last file must deactivate the editor session.');
assert.match(appSource, /DEFAULT_SETTINGS\.dockPanels\.top/, 'Resetting the layout must restore the default panel assignment.');
assert.match(appSource, /fileSaveQueues/, 'File saves must be serialized.');
assert.match(appSource, /current\.revision[^\n]*=== revision/, 'A stale save must not clear a newer dirty revision.');
assert.match(appSource, /async executeCode[\s\S]*?const finalized = await this\.finalizeExecution\(result\)[\s\S]*?return finalized/, 'Ordinary execution must retain the shared post-run finalization path after streaming.');
assert.match(engineSource, /replayLastPlot\(\)/, 'The latest recorded plot must support responsive replay.');
assert.match(appSource, /#encoding-button/, 'The encoding control must be wired.');
assert.match(appSource, /#indent-mode-button/, 'The indentation control must be wired.');
const stressScriptPath = 'examples/webr_ide_stress_test.R';
if (existsSync(join(root, stressScriptPath))) {
  const stressScript = read(stressScriptPath);
  assert.doesNotMatch(stressScript, /%,d/, 'The stress test must not use unsupported R sprintf grouping flags.');
  assert.doesNotMatch(stressScript, /col\s*=\s*\\?["']crimson\\?["']/i, 'The stress test must not contain the unsupported R colour name.');
  assert.match(stressScript, /if \(is\.null\(value\)\) return\(invisible\(NULL\)\)/, 'The timing helper must suppress visible NULL results from side-effect functions.');
  assert.match(stressScript, /Inline R result: `r 2 \+ 2`/, 'The stress report should exercise inline R Markdown evaluation.');
  assert.match(stressScript, /\[stream\] source heartbeat %d\/4/, 'The stress test must visibly exercise line-by-line source streaming.');
  assert.match(stressScript, /user_calls <- calls\[grepl\("\^trace_level_\[123\]/, 'The stress-test traceback fixture must filter out webR wrapper frames.');
}


const allText = walk(root)
  .filter(path => !path.includes(`${join(root, '.git')}`))
  .filter(path => !/\.(png|jpg|jpeg|webp|ico|zip|wasm|tgz)$/i.test(path))
  .map(path => readFileSync(path, 'utf8'))
  .join('\n');
assert.ok(!allText.includes('\u2014'), 'Use spaced en dashes rather than em dashes in project text.');
assert.ok(!allText.includes('utm_' + 'source=chatgpt.com'), 'Tracking parameters must not be present.');

const buttons = [...html.matchAll(/<button\b([^>]*)>/g)].map(match => match[1]);
const unlabeledIconButtons = buttons.filter(attributes => {
  if (!/class="[^"]*icon-button/.test(attributes)) return false;
  return !/\b(?:title|aria-label)="[^"]+"/.test(attributes);
});
assert.equal(unlabeledIconButtons.length, 0, 'Every icon-only button needs a title or aria-label.');

console.log(`Static checks passed: ${jsFiles.length} JavaScript modules, ${ids.length} unique HTML ids, ${localReferences.length} local asset references.`);
