# webR Studio

A fast, browser-native R IDE for [webR](https://docs.r-wasm.org/webr/latest/), designed for direct deployment to GitHub Pages.

### You can use it at https://alekrutkowski.github.io/webr-studio/

The interface follows the visual system and interaction conventions popularised by [shadcn/ui](https://ui.shadcn.com/): neutral design tokens, compact toolbars, consistent controls, accessible focus states, restrained elevation, and first-class light and dark themes. It is implemented as a dependency-light static application rather than a generated React bundle, which keeps startup and GitHub Pages deployment simple.

Made with GPT-5.6-Sol-Pro.

<img width="3204" height="2167" alt="image" src="https://github.com/user-attachments/assets/8e03bfbe-fdcc-422a-be4a-ace393eec91f" />

<img width="3201" height="2167" alt="image" src="https://github.com/user-attachments/assets/c929425a-8cdb-41e7-8a68-b19461d32c95" />

## Highlights

### Editor and console

- Ace-powered R editor and R console with syntax highlighting, completions, current-line highlighting, code folding, matching pairs, rainbow delimiters, ligature control, and multiple themes.
- Crimson Editor-inspired light theme by default, with Monokai, Dracula, Tomorrow Night, One Dark, Nord Dark, and additional light choices.
- Multiline console expressions with continuation prompts and multiline command history.
- Project-aware completion candidates from open files, the global environment, loaded packages, namespace expressions, and list or data-frame members.
- Smart indentation, Ctrl+I formatting, advanced find and replace, undo and redo buttons, Ctrl+Z and Ctrl+Y, jump to definition with F12, and help for the symbol under the cursor with F1.
- Ctrl+Shift+M inserts either the native `|>` pipe or `%>%`, according to the saved preference.
- Run selection or current expression with Ctrl+Enter, source the complete script with Ctrl+Shift+Enter, stop execution, restart webR, and optional execution timing.
- Diagnostics combine the live R parser with quick static checks and suggested one-click fixes.

### R session tools

- Structured console cards for output, messages, warnings, errors, tracebacks, and timings, including distinct icons, colour treatment, and links that open Mistral Chat with the relevant code or error text.
- Global Environment browser with type hints, dimensions, previews, approximate sizes, object removal, data-frame opening, and a guarded full cleanup command.
- Package manager for installation, loading, unloading, searching, and version inspection of webR-compatible binary packages.
- Automatic `.RData` checkpoints, manual `.RData` import and export, session restart without closing the tab, and optional environment restoration on startup.
- SVG-first plot capture and display, plot history, and export as SVG, PNG, JPEG, or WebP.
- Pretty HTML R help, searchable inside the IDE, with F1 lookup and back or forward navigation.

### Projects, data, and documents

- IndexedDB-backed project files, settings, tabs, console history, console transcript, pane state, plots, snapshots, and optional GitHub token persistence.
- Autosave protects work after a tab or browser closes unexpectedly. Browser storage persistence is requested where the platform supports it.
- Batch file and folder upload, drag and drop, multi-selection, rename and delete commands, individual downloads, and complete-project ZIP export.
- Editable `.R`, `.Rmd`, `.md`, `.csv`, `.tsv`, `.txt`, `.json`, `.yaml`, and related text formats. Each local browser upload is capped at 100 MB.
- R-side paged data-frame viewer with sortable columns, global filtering, per-column filtering, type badges, row numbers, page-size control, copy, and CSV export. Paging and filtering happen in R rather than materialising a whole large data frame in the DOM.
- Markdown preview and an integrated lightweight R Markdown renderer that evaluates chunks through webR and embeds output and plots. Use e.g. https://gist.github.com/jeromyanglim/2716336 to test it.
- Workspace import and export as JSON, named local snapshots, compressed URL state, and URL restoration through `#workspace=...`.
- GitHub Gist import and export for one or several text files. GitHub offers **public** and **secret** Gists, not truly private Gists. Secret Gists are unlisted but remain accessible to anyone who has the URL. The 100 MB local upload ceiling does not override GitHub’s own Gist API and file-size limits.

### Workbench

- Explorer, project search, snapshots, and Gist panels in the left activity bar.
- Editor and console in the centre, with Environment, Outline, Packages, Plots, Help, Data, and Preview docks on the right.
- Resizable sidebar, editor and console split, right dock, and upper or lower right dock split.
- Right-dock tabs can be dragged between the upper and lower panes.
- Balanced, code-focus, console-focus, and data-focus layout presets, plus per-pane maximisation.
- Command palette, menu bar, keyboard shortcut reference, responsive layout, system-theme default, high-contrast option, density choices, and persistent user settings.
- Ubuntu Mono is the default coding font. The settings include a broad set of coding fonts, independent size and weight controls, and a ligature toggle applied to both editor and console.

## Runtime architecture

- **webR:** pinned to `0.6.0` from `https://webr.r-wasm.org/v0.6.0/webr.mjs`.
- **Editor:** Ace `1.44.0`.
- **Markdown:** Marked `18.0.7` from its UMD browser build.
- **Math rendering:** KaTeX `0.18.1`, exported as self-contained MathML.
- **HTML sanitisation:** DOMPurify `3.2.7`.
- **Persistent browser state:** a local IndexedDB schema owned by the application. The webR virtual filesystem is treated as an execution mirror, while IndexedDB is the source of truth for projects.
- **Interrupt support on GitHub Pages:** `coi-serviceworker.js` adds cross-origin isolation headers to same-origin responses after the first controlled reload. When isolation is unavailable, the IDE remains usable through webR's fallback communication channel, with hard restart as the fallback stop mechanism.
- **Build process:** none. The deployed files are ordinary HTML, CSS, JavaScript modules, and static assets.

## Run locally

Python 3 is sufficient:

```bash
python3 serve.py
```

Then open `http://127.0.0.1:8000`. The local server emits the COOP and COEP headers required for interruptible SharedArrayBuffer mode.

A plain server such as `python3 -m http.server` also opens the UI, but webR normally uses its fallback channel because the isolation headers are absent.

Run the complete dependency-free verification suite:

```bash
npm test
```

This runs structural checks plus unit tests for expression parsing, R Markdown chunk isolation, assignment-lint context, completion acceptance, editor-session stability, traceback cleanup, outline extraction, smart indentation, debounce cancellation, and delimited data parsing.

## Deploy to GitHub Pages

1. Create a repository and copy this directory into its root.
2. Push it to the `main` branch.
3. In **Settings → Pages**, set the source to **GitHub Actions**.
4. The included `.github/workflows/pages.yml` verifies the project and deploys it.
5. Open the deployed URL once. The isolation service worker may trigger one automatic reload before `crossOriginIsolated` becomes available.

The workflow uses the current major releases of the official Pages actions at the time this project was prepared: `actions/checkout@v7`, `actions/configure-pages@v6`, `actions/upload-pages-artifact@v5`, and `actions/deploy-pages@v5`.

## GitHub Gist token

Creating a Gist requires a GitHub personal access token. Prefer a fine-grained token limited to the **Gists: write** permission. Paste it in the Gists sidebar and enable persistence only on a trusted personal device.

When persistence is enabled, the token is stored in this site's IndexedDB and is sent only to `api.github.com`. Truncated Gist files are downloaded separately from GitHub's validated raw-content host without forwarding the token. Browser storage is not a secrets vault: another script executing under the same origin could read it. A narrowly scoped token is therefore essential.

## URL state and size

The share command compresses the current workspace into the URL fragment. This is ideal for compact scripts and examples. Browser and messaging URL limits vary, so large projects should use JSON export, a project ZIP, or a Gist instead. The IDE warns when a generated URL is likely to be unwieldy.

The URL fragment is not sent to the web server during normal HTTP navigation, but anyone receiving the complete link can read the embedded project.

## R Markdown scope

The built-in renderer supports Markdown plus fenced R chunks and common chunk options such as `eval`, `echo`, `include`, `message`, and `warning`. It is intentionally lightweight and runs completely in the browser. It does not attempt to reproduce the full Pandoc, knitr, or Quarto toolchain.

## Browser support

Use a current Chromium, Firefox, or Edge release. Service workers require HTTPS outside `localhost`. Private browsing modes and browser storage quotas can limit persistence. Very large browser-side projects remain subject to the user's available memory and origin storage quota.

## Third-party services and privacy

R execution and ordinary project storage happen locally in the browser. Network requests are made for the pinned runtime and UI dependencies, webR package binaries, optional Google-hosted coding fonts, explicit GitHub Gist operations, and explicit Mistral Chat links. No analytics are included.

## Project structure

```text
.
├── index.html                  # Application shell and dialogs
├── styles.css                 # shadcn-inspired token and component system
├── coi-serviceworker.js       # GitHub Pages cross-origin isolation bootstrap
├── js/
│   ├── app.js                 # Workbench orchestration
│   ├── editor.js              # Editor, completion, folding, linting, navigation
│   ├── console.js             # Multiline console, history, structured output
│   ├── webr-engine.js         # webR lifecycle, R helpers, plots, data, packages
│   ├── data-viewer.js         # Paged data-frame grid
│   ├── db.js                  # IndexedDB persistence
│   ├── gist.js                # GitHub Gist API integration
│   ├── ui.js                  # Dialog, toast, prompt, and menu primitives
│   ├── utils.js               # Compression, ZIP, Markdown, file, and URL helpers
│   └── config.js              # Defaults and pinned versions
├── tests/
│   ├── static-check.mjs       # Dependency-free structural checks
│   └── unit-check.mjs         # Parser, linting, outline, and data tests
├── serve.py                   # Local isolation-aware development server
└── .github/workflows/pages.yml
```

## Licence

MIT, copyright 2026 Alek Rutkowski.
