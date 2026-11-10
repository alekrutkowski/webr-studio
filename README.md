# webR Studio

A fast, browser-native R IDE for [webR](https://docs.r-wasm.org/webr/latest/), designed for direct deployment to GitHub Pages.

### You can use it at https://alekrutkowski.github.io/webr-studio/

The interface follows the visual system and interaction conventions popularised by [shadcn/ui](https://ui.shadcn.com/): neutral design tokens, compact toolbars, consistent controls, accessible focus states, restrained elevation, and first-class light and dark themes. It is implemented as a dependency-light static application rather than a generated React bundle, which keeps startup and GitHub Pages deployment simple.

Made with GPT-5.6-Sol-Pro and its successors.

<img width="3204" height="2167" alt="image" src="https://github.com/user-attachments/assets/8e03bfbe-fdcc-422a-be4a-ace393eec91f" />

<img width="3201" height="2167" alt="image" src="https://github.com/user-attachments/assets/c929425a-8cdb-41e7-8a68-b19461d32c95" />

## Highlights

### Editor and console

- Ace-powered R editor and R console with syntax highlighting, completions, current-line highlighting, code folding, matching pairs, rainbow delimiters, ligature control, and multiple themes.
- Crimson Editor-inspired light theme by default, with Monokai, Dracula, Tomorrow Night, One Dark, Nord Dark, and additional light choices.
- Multiline console expressions with continuation prompts and multiline command history.
- Interactive R prompts accept plain-text replies in the console, including menu choices and empty responses, with Stop available while waiting.
- Project-aware completion candidates from open files, the global environment, loaded packages, namespace expressions, and list or data-frame members.
- Optional local R assistant with WebLLM, streamed chat, bounded access to R objects, and explicit <kbd>Alt</kbd>+<kbd>\\</kbd> code suggestions in the editor and console. Model loading starts only when requested.
- Smart indentation, <kbd>Ctrl</kbd>+<kbd>I</kbd> formatting, advanced find and replace, undo and redo buttons, <kbd>Ctrl</kbd>+<kbd>Z</kbd> and <kbd>Ctrl</kbd>+<kbd>Y</kbd>, jump to definition with <kbd>F12</kbd>, and help for the symbol under the cursor with <kbd>F1</kbd>.
- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> inserts either the native `|>` pipe or `%>%`, according to the saved preference.
- Run selection or current expression with <kbd>Ctrl</kbd>+<kbd>Enter</kbd>, source the complete script with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd>, stop execution, restart webR, and optional execution timing.
- Diagnostics combine the live R parser with quick static checks and suggested one-click fixes.

### R session tools

- Optional Tailscale or Cloudflare Worker networking for HTTP(S) data downloads without destination-server CORS support. Choose a route in Networking; ordinary `download.file()` and base R URL reads use it without rewriting R code. The Cloudflare option includes a free-plan setup guide, Worker code, and a proxy-password generator.
- Structured console cards for output, messages, warnings, errors, tracebacks, and timings, including distinct icons, colour treatment, and links that open Mistral Chat with the relevant code or error text.
- Global Environment browser with type hints, dimensions, previews, approximate sizes, object removal, data-frame opening, and a guarded full cleanup command.
- Package manager for installation, loading, unloading, searching, and version inspection of webR-compatible binary packages.
- Ordinary `install.packages()` calls in the console or scripts use the same WebAssembly package installer as the Packages pane.
- Automatic `.RData` checkpoints, manual `.RData` import and export, session restart without closing the tab, and optional environment restoration on startup.
- SVG-first plot capture and display, plot history, and export as SVG, PNG, JPEG, or WebP.
- Pretty HTML R help, searchable inside the IDE, with <kbd>F1</kbd> lookup and back or forward navigation.

### Projects, data, and documents

- IndexedDB-backed project files, settings, tabs, console history, console transcript, pane state, plots, snapshots, and optional GitHub token persistence.
- Autosave protects work after a tab or browser closes unexpectedly. Browser storage persistence is requested where the platform supports it.
- Batch file and folder upload, drag and drop, multi-selection, rename and delete commands, individual downloads, and complete-project ZIP export.
- One Explorer for project files and files created or downloaded by R. Files under `/project` are saved automatically after R operations and restored after a page reload, with direct delete controls and current-byte downloads.
- Content-aware text editing: **Open** opens valid UTF-8 text in the editor, including unfamiliar extensions and extensionless files. Binary files keep an explicit **Download** action. Each local browser upload is capped at 100 MB; editing is limited to 4 MB per file.
- R-side paged data-frame viewer with sortable columns, global filtering, per-column filtering, type badges, row numbers, page-size control, copy, and CSV export. Paging and filtering happen in R rather than materialising a whole large data frame in the DOM.
- Markdown preview and an integrated lightweight R Markdown renderer that evaluates chunks through webR and embeds output and plots. Use e.g. https://gist.github.com/jeromyanglim/2716336 to test it.
- Workspace import and export as JSON, named local snapshots, compressed URL state, and URL restoration through `#workspace=...`.
- GitHub Gist import and export for one or several text files. GitHub offers **public** and **secret** Gists, not truly private Gists. Secret Gists are unlisted but remain accessible to anyone who has the URL. The 100 MB local upload ceiling does not override GitHub’s own Gist API and file-size limits.

### Workbench

- Explorer, project search, snapshots, and Gist panels in the left activity bar.
- Editor and console in the centre, with Environment, Outline, Packages, Plots, Help, Data, Preview, and Assistant docks on the right.
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
- **Optional local inference:** WebLLM `0.2.87`, dynamically imported inside a dedicated worker after **Load model**. The UI offers Qwen2.5 Coder 0.5B and 1.5B q4f32 models with a 2,048-token context; no model is loaded during ordinary startup.
- **Persistent browser state:** a local IndexedDB schema owned by the application. Every regular file under `/project`, together with empty directories, is backed up automatically after R operations and restored on startup. Runtime changes and deletions are reconciled while preserving unsaved editor changes. Files outside `/project` remain session files until explicitly copied into the project.
- **Interrupt support on GitHub Pages:** `coi-serviceworker.js` adds cross-origin isolation headers to same-origin responses after the first controlled reload. When isolation is unavailable, the IDE remains usable through webR's fallback communication channel, with hard restart as the fallback stop mechanism.
- **Build process:** none. The deployed files are ordinary HTML, CSS, JavaScript modules, and static assets.
- **Optional networking:** the same private per-tab R download bridge can use a locally shipped Tailscale WebAssembly client or a Cloudflare Worker you deploy. Tailscale loads only after Connect and uses official Tailscale `v1.96.0` with Go `1.26.10`; source, build script, checksums, and notices are included. The Cloudflare Worker is a separate, dependency-free JavaScript file and requires no Tailscale runtime.

## Use the local R assistant

Open **Assistant**, select a coding model, and click **Load model**. WebGPU and
HTTPS or localhost are required. The first load downloads assets from jsDelivr,
Hugging Face and its storage hosts, and MLC's model-library repository. Prompts,
selected R context, and responses stay on this device. Loading can reuse assets
that the browser has retained in its cache.

Ask about an object by name, or select up to six objects for detail. Metadata
is enabled initially; data samples and function bodies are separate opt-ins.
**Preview context** shows the bounded messages used for a request. Focus the
editor or idle console and press **Alt+\** for a continuation at the cursor or
a replacement for selected text. Suggestions do not run while typing.

Review generated R code before choosing **Insert in editor**, **Add to console**,
or **Run in R**. Adding code to the console appends it to the draft. Running a
visible code block uses the ordinary R execution path and makes a bounded result
available to the next question. A suggestion cannot insert into a document or
cursor position that changed during generation.

Inference runs in its own worker, uses short output budgets, stops when R starts
executing, and unloads after five idle minutes. **Stop** and **Unload** are also
available. The models still consume shared GPU and memory resources; speed is
device-dependent. The two upstream catalog GPU-memory estimates are about
1.06 GB and 1.89 GB at their default 4,096-token context, not measurements of
this app's 2,048-token configuration or download sizes.

Conversation history is kept only in page memory and can be cleared with
**Clear chat**. The small local models provide code proposals and explanations;
the integration has no autonomous tool loop and does not claim Claude Code or
Codex capability. See [ASSISTANT.md](ASSISTANT.md) for exact models, context
limits, privacy, lifecycle behaviour, validation, and a manual smoke test.

## Install R packages

Use the **Packages** pane or ordinary R code in the console, an editor selection,
or a sourced script:

```r
install.packages("data.table")
library(data.table)

data.table(value = 1:3)[, sum(value)]
# [1] 6
```

Both entry points use `webr::install()`, the official installer for precompiled
WebAssembly packages. Studio also adapts `utils::install.packages()`, so an
explicit namespace does not send the command to R's desktop source installer.
The adapter is installed whenever R starts or restarts and does not create an
`install.packages` object in your Global Environment.

Package names may be a character vector, a variable, or the named `pkgs`
argument. For example, `install.packages(pkgs = c("data.table", "magrittr"))`.
The supported arguments are `pkgs`, `lib`, `repos`, `quiet`, `info`, and `mount`;
the last two are advanced options of the webR installer. Desktop-only options
such as `type` and `dependencies` are not supported. The installer resolves
required `Depends` and `Imports` dependencies automatically.

The default repository is `https://repo.r-wasm.org/`, matching the Packages pane
at startup. For console calls, `options(webr_pkg_repos = ...)` changes this
default; an explicit `repos` argument selects a repository for that call. A
custom repository must provide compatible WebAssembly binaries. A native R
source repository does not provide those binaries, and installing an OS
`R-devel` package will not add source compilation to the browser runtime.

Installation progress and package warnings appear in the console. A package
that is absent from the binary repository produces the installer's warning;
download and extraction failures remain errors. Run `library(package_name)`
after installing to load a package. Open or refresh the Packages pane to inspect
the current library. Downloads use the selected Networking route, just as they
do when installation starts from the Packages pane.

See the [webR 0.6.0 package installation guide](https://docs.r-wasm.org/webr/v0.6.0/packages.html)
and [R API reference](https://docs.r-wasm.org/webr/v0.6.0/api/r.html) for the
underlying installer and its binary-package requirements.

### Download a package archive without installing it

`download.packages()` saves package archives. Supply an existing destination
directory in R's filesystem:

```r
download.packages("data.table", destdir = getwd())
```

Studio uses the webR binary repository and downloads compatible `.tgz` archives.
The return value is a two-column matrix of package names and saved paths.
This command does not install or load the package. Use `install.packages()`
when your goal is to make the package available to `library()`.

The initial working directory is `/project`, so archives saved there appear
in the Explorer and are automatically kept for the next page reload or restart.
Both `download.packages()` and `utils::download.packages()` use the selected
Networking route. A missing `destdir` gives an immediate explanation before
repository lookup, instead of opening a CRAN mirror menu.

The adapter retains the usual arguments `pkgs`, `destdir`, `available`, `repos`,
`contriburl`, `method`, `type`, and `...`. Its default repository comes from
`webr_pkg_repos`; `repos` and `contriburl` must identify compatible webR binary
repositories. The supported types are `"binary"` and `"emscripten.binary"`.
Missing packages and failed transfers produce warnings, and only successful
downloads appear in the returned matrix. Downloading archives does not download
dependencies automatically.

## Reply to interactive R prompts

When R calls `readline()` or opens a text menu, the console shows the actual
prompt and a **Send** control. Type one line and press Enter. The response is
sent to the waiting R command, and an empty response is allowed. For a menu,
enter the choice number; use **Stop** to interrupt the command while retaining
the current session. Once the command finishes, the console returns to ordinary
R input.

Prompt replies use a temporary plain-text editor and are excluded from console
history, saved drafts, and workspace-export metadata. If a script prompts while
you have an unfinished console command, that draft is restored afterwards.

Interactive prompts require webR's SharedArrayBuffer channel, available when the
page is cross-origin isolated. The included local server supplies the necessary
headers, and the GitHub Pages service worker enables isolation after its initial
reload. In the PostMessage fallback, webR reports that nested input is unsupported;
Studio keeps the console usable rather than presenting a response it cannot send.
Ordinary package installation and archive download do not need an interactive
prompt.

## Choose a download route

Open **Networking → Download route**:

| Route | What it needs | Intended use |
| --- | --- | --- |
| Browser direct (CORS) | No additional setup | Data servers that already permit browser reads. |
| Cloudflare Worker proxy | A free Cloudflare Workers account, the bundled Worker, and your proxy password | Public HTTP(S) data, including servers without browser CORS permission. No always-on exit device is needed. |
| Tailscale | A tailnet connection and, for public internet access, an exit node | Private tailnet services and public downloads through your selected device. |

Selecting a route is explicit. A failed proxy or Tailscale request does not
silently retry through another provider or directly through the browser.

### Cloudflare Worker setup

Select **Cloudflare Worker proxy**, then expand **Set up a free Worker, step by
step**. The panel provides the Worker code, a password generator, the exact
site origin to copy into Cloudflare, and a connection check. A complete
beginner-friendly walkthrough is in
[cloudflare-worker/README.md](cloudflare-worker/README.md), including the
dashboard route and optional Wrangler commands for Windows or Linux.

You deploy the included `cloudflare-worker/worker.js` into your own account.
Configure `PROXY_TOKEN` as a Secret and `ALLOWED_ORIGINS` as Text, then enter
the Worker's URL and the same password in webR Studio. This password is created
for your proxy; webR Studio does not ask for a Cloudflare account API token.

Use a current Worker compatibility date (2024-11-11 or later). Ordinary public
downloads require no extra compatibility flags. If the dashboard does not list
the advanced routing/cancellation flags, skip them; the detailed guide explains
their optional use through Wrangler.

Cloudflare currently includes **100,000 Worker requests per day** on its free
plan. Its **10 ms CPU** allowance measures code execution, not time waiting for
downloads; this Worker streams response bytes. See the
[official limits](https://developers.cloudflare.com/workers/platform/limits/).
These limits were checked on 27 October 2026.

The Worker fetches data from Cloudflare's network. It does not join your
tailnet or reach a private exit node. The existing **Cloudflare through exit
node** DNS setting belongs to Tailscale and has a different purpose.

## Download data through Tailscale

1. Have a Tailscale account and a device in your tailnet that can act as an **exit node**. For public internet downloads, advertise that device as an exit node and approve it in the Tailscale admin console. Follow the [official Windows or Linux setup instructions](https://tailscale.com/docs/features/exit-nodes). Private tailnet services do not require an exit node.
2. Open webR Studio over HTTPS or at `http://127.0.0.1:8000`, and wait for R to start.
3. Choose **Networking → Download route → Tailscale**, click **Connect to Tailscale**, then **Sign in to Tailscale**. Approve the new `webr-studio-…` device and return to the IDE.
4. If exactly one online exit node with an unexpired device key is available, it is selected automatically. Otherwise choose the desired machine under **Exit node**. An amber state means tailnet-only access or a connection that needs attention; selecting a node does not itself prove internet reachability.
5. Optionally paste a data URL into **Test a download**. A successful test reports the response status and byte count. Then use normal R code:

```r
# Replace this example address with your actual data URL.
data_url <- "https://your-data-server.example/data.csv"
download.file(data_url, "data.csv", mode = "wb")
data <- read.csv("data.csv")

# Base R URL connections also use the same download path.
data <- read.csv(data_url)
```

Normal download status such as `trying URL '…'` is shown as **Output**. R also
uses its stderr stream for progress, so stderr alone does not mean a download
failed. Actual R errors and warnings retain their distinct cards. This applies
to the console, R Markdown preview, and Markdown export.

## Manage files in the Explorer

The left **Explorer** is the single file browser. It combines project files with
files that R creates or downloads. The tree refreshes after R execution;
**Refresh** also updates it on demand. Use the path box, parent button, or
project button to browse another runtime directory or return to `/project`.

Every regular file in `/project` is automatically kept in the browser's project
storage, including nested, hidden, extensionless, and binary files. Empty
directories are retained too. A completed R operation triggers a backup even
when the operation ended with an error or was interrupted. Changes and deletions
made by R are reflected in the backup, so deleted files do not reappear after
reload. Startup restores the saved project before allowing a fresh backup.

Backups run while the page is open and finish before the project is reported as
saved. Wait for the saved status before refreshing. If R is still running or a
save is unfinished or failed, the page warns before leaving when the browser
supports that warning. Browser storage belongs to this site and browser profile;
export a project ZIP for a separate copy.

- Click a file's trash icon, choose **Delete** from its actions menu, or select
  files with <kbd>Ctrl</kbd>/Cmd-click and use **Delete selected**. Confirming removes the
  files from the R filesystem and any saved project copies, and closes their
  editor tabs. Deletion waits for pending saves and is disabled while R runs.
- **Open** uses the editor for valid UTF-8 text, regardless of its extension.
  This includes CSV/TSV, configuration files, logs, and files without extensions.
  Text detection preserves a UTF-8 byte-order mark and rejects binary content
  even if the filename ends in `.txt` or `.R`. Files with other encodings remain
  byte-for-byte intact and show a clear explanation when they cannot be edited.
- **Open in data viewer** and **Preview document** are separate actions for
  supported formats. The data viewer reads current runtime contents without
  overwriting them with an older saved copy.
- Files outside `/project` remain temporary. Choose **Keep in project** to copy
  one to a project-relative destination. Opening an outside text file also asks
  where to keep its editable project copy.
- **Download** reads current R bytes, or current unsaved editor contents when
  a buffer is dirty. Project exports and snapshots include automatically kept
  files. Gists contain text files, subject to GitHub's own format and size limits.

Automatic backup has no 100 MB per-file cutoff. Available browser memory and
storage quota still limit what can be saved; a failure leaves the previous
committed backup intact and reports that the newest changes are not yet saved.
The 100 MB local-upload limit and 4 MB editor limit are separate. **Open** does
not start an unexpected download when a file is binary or too large for the
editor; use **Download** explicitly. Delete acts on individual files; it does
not remove whole directories recursively through the GUI.

## Troubleshoot networking

If a download fails with `lookup ... /dns-query: context deadline exceeded`,
click **Use Cloudflare DNS and retry** beside the failed Networking test, or
select **DNS for public hostnames → Cloudflare through exit node** and start a
fresh test. The test result identifies the DNS setting it used. This explicit
option resolves public hostnames using encrypted DNS through your selected
exit node, avoiding its PeerAPI DNS service. The default is **Exit node DNS**.
Known tailnet names and configured private DNS suffixes keep the original DNS
route. Neither mode falls back to a direct browser download.

Reloading, reconnecting, or clearing the exit node restores **Exit node DNS**.
If the failure came from R, change the DNS setting and rerun that R command;
the Networking recovery button retries only its own failed test URL.

If downloads still time out, use **Networking → Diagnose connection**. It
separately checks the selected exit, the configured public route, encrypted peer
reachability, the exit's service, and TCP/TLS/HTTP to `1.1.1.1` without DNS.
Each network stage has a ten-second limit; independent checks run together.
Use **Copy report** to capture the result, including the exit's operating
system and key status. A failed check identifies the stage, not a proven
root cause or a verdict about every internet destination. These checks run
only when requested and do not change DNS or exit-node settings.

The Tailscale worker is independent of R, so **Restart R** preserves its current connection. **Disconnect** terminates the networking worker, cancels pending transport requests, forgets the tab's in-memory keys, and restores ordinary browser downloads. Reloading or closing the page also forgets the keys, so a new connection requires signing in again. The registered device can remain in the Tailscale admin console; remove unused browser devices there when desired.

The integration covers webR's HTTP(S) GET download primitive, including default `download.file()`, `url()`, `readLines()`, and `read.csv()` URL reads. It does not supply a general socket layer for `curl`, `httr`, `httr2`, database drivers, or arbitrary browser traffic. Those webR APIs can require a separate [WebSocket proxy](https://docs.r-wasm.org/webr/latest/networking.html). Website sign-in cookies are not copied into downloads; explicit request headers are supported. Responses are buffered in memory and have a 120-second transport timeout, so very large or slow downloads remain limited by browser memory and connection speed.

See [NETWORKING.md](NETWORKING.md) for routing, troubleshooting, validation, and implementation details.

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

This runs structural checks plus unit tests for expression parsing, R Markdown chunk isolation, assignment-lint context, completion acceptance, editor-session stability, traceback cleanup, outline extraction, smart indentation, debounce cancellation, delimited data parsing, and the new networking routes, binary responses, headers, cancellation, error handling, per-tab isolation, and service-worker restart behavior.

The assistant's deterministic tests cover worker lifecycle and cancellation,
bounded context, explicit actions, and stale-insertion protection with simulated
worker/R boundaries. `npm run test:assistant-webr` optionally exercises its R
inspection bridge with real webR under Node. It needs `webr@0.6.0` installed, or
`WEBR_MODULE` pointing to that package's `dist/webr.mjs`; it does not download a
language model. These checks do not measure browser/GPU inference performance.

`npm run test:browser-assistant` checks the real app, Ace, and webR in a browser
with a deterministic model substitute. The optional
`ASSISTANT_REAL_WEBGPU=1 BROWSER_HEADLESS=0 npm run test:browser-assistant`
deliberately downloads the 0.5B model and tests real GPU generation without
executing generated code. See [ASSISTANT.md](ASSISTANT.md) for setup and the
validation limits.

The optional browser regression suites run real webR against local fixtures. Install Playwright and its Chromium browser, then run `npm run test:browser`, `npm run test:browser-console`, `npm run test:browser-cloudflare`, and `npm run test:browser-files`. Tailscale tests use an explicitly simulated transport. The Cloudflare test runs the shipped Worker handler locally with a controlled upstream, and the file test exercises the real virtual filesystem, browser storage, and GUI. See [NETWORKING.md](NETWORKING.md) for details. Normal serving and deployment do not require npm installation or Go compilation.

`npm run test:browser-install` checks R-side package installation, argument
forwarding, genuine installer warnings and download errors, and restart. Set
`BROWSER_LIVE_PACKAGE_INSTALL=1` to also save a `data.table` archive from the public
webR repository, verify that it remains uninstalled, then install and load it and
perform a calculation. This optional live check
requires the repository to be reachable.

`npm run test:browser-input` checks the actual console editor with real webR:
menu choices, literal and empty replies, response privacy, Stop, restart, the
textarea fallback, and recovery when interactive input is unsupported. The
package suite also checks archive downloads, their return values, destination
validation, and partial-transfer warnings.

`npm run test:browser-open` checks content-based text opening, explicit data and
download actions, byte preservation, editor limits, and reload behavior.
`npm run test:browser-persistence` checks automatic `/project` backup, fresh-page
restore, runtime deletions, empty directories, editor conflicts, and recovery
from failed saves. Set `PROJECT_BACKUP_LARGE=1` to also verify the exact bytes of
a file larger than 100 MiB before and after a page reload. These tests use
isolated local browser profiles and fixtures.

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

The optional local assistant additionally needs a working WebGPU adapter in
both the page and its dedicated worker. Try a current Chrome or Edge release
with hardware acceleration enabled, and check the device and driver if no
adapter is available. Unsupported local inference does not disable the R IDE.

## Third-party services and privacy

R execution and ordinary project storage happen locally in the browser. Network requests are made for the pinned runtime and UI dependencies, webR package binaries, optional Google-hosted coding fonts, explicit GitHub Gist operations, and explicit Mistral Chat links. No analytics are included.

Choosing **Load model** additionally downloads WebLLM and model assets from
jsDelivr, Hugging Face and its download hosts, and MLC's GitHub-hosted model
libraries. These ordinary browser requests do not use the R-only networking
routes below. Assistant prompts and bounded R context are used in the local
worker, with no remote inference API. Assistant conversation is not persisted
or included in project exports; code explicitly inserted or run follows the
IDE's normal saving behaviour. See [ASSISTANT.md](ASSISTANT.md).

Choosing Connect additionally starts Tailscale coordination and encrypted relay connections. Only downloads using the webR download primitive are routed through the selected tailnet or exit node; the rest of the IDE's browser requests keep their existing routes. Tailscale credentials stay in the dedicated worker's memory, separate from workspace exports, URL sharing, Gists, and IndexedDB. A failed Tailscale download is reported as an error; it is never retried through an unrequested direct-browser route. HTTPS certificate verification remains enabled in the bundled networking runtime.

Choosing **Use proxy** checks the Cloudflare Worker and enables that route for
the same R download primitive. The proxy password stays in this tab's memory
and is excluded from browser storage and project exports. The browser sends
the target URL and explicitly supplied R request headers to your Worker;
Cloudflare handles those requests and data. The proxy password authenticates
only the Worker request and is never forwarded to the data server. Browser
cookies are not forwarded. Disconnect or reload to clear the active proxy
credentials. Target-site authentication and access rules still apply.

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
│   ├── assistant.js           # Lazy local-assistant pane and explicit actions
│   ├── assistant-context.js   # Prompt bounds and guarded code insertion
│   ├── assistant-client.js    # Worker lifecycle, pinned models, cancellation
│   ├── assistant-worker.js    # Lazy WebLLM loading and local GPU inference
│   ├── network.js             # Explicit browser, Tailscale, and Worker routing
│   ├── cloudflare-proxy.js    # Worker protocol and in-memory proxy credential
│   ├── network-ui.js          # Networking dialog and status
│   ├── network-bridge.js      # webR download hook and private per-tab bridge
│   ├── network-common.js      # Shared URL, header, and state validation
│   ├── tailscale-worker.js    # Isolated Tailscale client and HTTP transport
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
├── vendor/tailscale-web/       # Ready-to-serve networking runtime and notices
├── cloudflare-worker/          # Worker code, configuration, and setup tutorial
├── network-src/                # Retained networking source and provenance
├── scripts/build-tailscale.mjs # Optional reproducible runtime rebuild
├── NETWORKING.md               # Setup, implementation, and troubleshooting
├── ASSISTANT.md                # Local AI usage, bounds, privacy, and validation
└── .github/workflows/pages.yml
```

## Licence

MIT, copyright 2026 Alek Rutkowski.

## Acknowledgments and dependency licences

Author and maintainer: Alek Rutkowski <alek.rutkowski@gmail.com>.

The networking design follows the browser Tailscale and exit-node approach in [WebVM](https://github.com/leaningtech/webvm) by Leaning Technologies. This implementation uses webR's download bridge and does not bundle CheerpX or copy WebVM's Svelte components. The browser client is adapted from [tailscale-web](https://github.com/adrianosela/tailscale-web) by Adriano Sela Aviles (MIT), rebuilt against [official Tailscale](https://github.com/tailscale/tailscale) (BSD-3-Clause), the [Go runtime](https://go.dev/), [gVisor](https://gvisor.dev/) (Apache-2.0), and [Mozilla root certificates via rootcerts](https://github.com/breml/rootcerts). All compiled dependencies and full applicable notices are recorded in `vendor/tailscale-web/provenance.json` and `vendor/tailscale-web/THIRD-PARTY-LICENSES.txt`; their own licences continue to apply.

The additional Worker route uses the standard Fetch, Headers, Response, and
Streams APIs in [Cloudflare Workers](https://developers.cloudflare.com/workers/).
Cloudflare's [CORS proxy example](https://developers.cloudflare.com/workers/examples/cors-header-proxy/)
and [request API documentation](https://developers.cloudflare.com/workers/runtime-apis/request/)
inform the setup and redirect handling. The bundled Worker implementation is
part of this project's MIT-licensed source and has no third-party code dependency.

The existing IDE also depends on [webR](https://github.com/r-wasm/webr), [R](https://www.r-project.org/), [Ace](https://github.com/ajaxorg/ace), [Marked](https://github.com/markedjs/marked), [KaTeX](https://github.com/KaTeX/KaTeX), and [DOMPurify](https://github.com/cure53/DOMPurify). These projects are loaded from the pinned upstream distributions and retain their respective licences and acknowledgments. The visual conventions draw on [shadcn/ui](https://ui.shadcn.com/); the interface is implemented locally. Optional fonts are supplied by Google Fonts under each font's own licence. [Playwright](https://github.com/microsoft/playwright) is an optional development-only browser test dependency.

The optional local assistant adds the following upstream components:

| Component and contributors | Licence | Use |
| --- | --- | --- |
| [WebLLM 0.2.87, MLC AI and contributors](https://github.com/mlc-ai/web-llm/tree/v0.2.87) | [Apache-2.0](https://github.com/mlc-ai/web-llm/blob/v0.2.87/LICENSE) | Browser inference engine, worker APIs, compatible model catalog, and MLC model conversions |
| [Qwen2.5-Coder-0.5B-Instruct, Qwen team](https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct) | [Apache-2.0](https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct/blob/main/LICENSE) | Lighter coding model, loaded as its MLC q4f32 conversion |
| [Qwen2.5-Coder-1.5B-Instruct, Qwen team](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct) | [Apache-2.0](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct/blob/main/LICENSE) | Larger optional coding model, loaded as its MLC q4f32 conversion |

WebLLM's bundled dependencies retain their upstream licences and notices. Model
weights are fetched on demand and are not bundled in this repository. The
project's MIT licence covers its integration code and does not replace these
upstream licences. Exact model identifiers and primary documentation are in
[ASSISTANT.md](ASSISTANT.md).
