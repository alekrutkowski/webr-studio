# Changes

## 1.6.0

- Add an optional local R assistant powered by pinned WebLLM 0.2.87 and Qwen2.5
  Coder 0.5B or 1.5B q4f32. Load the assistant UI on demand and import WebLLM
  inside a dedicated worker only after **Load model**.
- Add streamed chat and explicit **Alt+\** suggestions in the R editor and
  console. Review proposals before insertion, appending to the console draft,
  or running a visible R code block through the normal execution path.
- Collect bounded metadata from relevant or selected live R objects while R
  is idle. Make small data samples, function bodies, and the last execution
  result separately controllable, and expose the exact prompt in a context
  preview. Avoid active bindings and custom display methods during inspection.
- Preserve ordinary completion without a model. Bound context and generation,
  batch streamed updates, stop generation when R starts, terminate a stalled
  interruption after 2.5 seconds, and unload after five idle minutes.
- Reject stale suggestion insertion after document, selection, cursor, or R
  session changes. Keep model output as displayed text and proposals, with no
  autonomous tool calls or implicit code execution.
- Keep assistant chat in page memory, provide **Clear chat** and **Unload**,
  and document model downloads, cache behaviour, memory estimates, and WebGPU
  requirements in `ASSISTANT.md`.
- Add deterministic lifecycle, context, and UI tests plus an optional real-webR
  Node check of the inspection bridge. Include a browser regression with a
  deterministic model and an opt-in real WebGPU smoke test; document the
  target-device verification still needed without claiming measured inference
  performance.

## 1.5.4

- Make **Open** use content-based text detection instead of a filename extension
  whitelist. Open valid UTF-8 text, unfamiliar extensions, and extensionless files
  in the editor; preserve UTF-8 BOMs and reject disguised binary content.
- Keep data viewing and document preview as explicit actions. Binary files and
  files above the editor limit show an explanation instead of automatically
  starting a download.
- Automatically keep every regular file under `/project`, including hidden,
  nested, and binary files, plus empty directories. Restore them after a reload
  or R restart; keep manual copying for files outside `/project`.
- Reconcile runtime edits and deletions after completed R operations, including
  errors and interruptions. Preserve exact file bytes and POSIX names, detect
  same-size changes, and protect unsaved editor buffers.
- Commit file changes and the directory manifest together, preserve the previous
  backup on failure, show pending/failed backup status, and warn before leaving
  while work is not saved. Remove the old automatic-backup file-size exclusion.
- Add real-browser coverage for text opening and project backup/restore.

## 1.5.3

- Make R text menus and `readline()` prompts answerable in the console. Distinguish
  a command waiting for input from a finished command using execution markers,
  including prompts that are empty or begin with `>`.
- Send one raw response to the current prompt, accept empty replies, preserve
  unfinished console drafts, and keep replies out of saved history and workspace
  metadata. Reject stale, duplicate, and multiline responses.
- Allow Stop while waiting for input and clear pending replies on completion,
  cancellation, or restart. Do not offer unsupported nested input in webR's
  PostMessage fallback; preserve its error and restore normal console use.
- Add a download-only adapter for `download.packages()` and its `utils::` form.
  Require `destdir` before repository lookup, use compatible WebAssembly binary
  archives through the selected download route, and return successful package/path
  pairs without installing packages. Preserve missing-package and transfer warnings.
- Keep `install.packages()` routed to the same installer as the Packages pane.
  Add real-browser prompt regressions and package-archive download coverage.

## 1.5.2

- Route `install.packages()` and `utils::install.packages()` through the same
  `webr::install()` binary installer used by the Packages pane, replacing the
  incompatible desktop source-installation path in console and script execution.
- Support ordinary package-name vectors and the named `pkgs` argument, together
  with `lib`, `repos`, `quiet`, `info`, and `mount`. Preserve webR's installation
  warnings and errors; unsupported desktop-only options still raise errors.
- Apply the adapter at every R startup and restart without adding a user
  workspace object or changing ordinary package-loading functions.
- Document console installation, compatible repositories, and supported options.
- Add real-webR browser regression coverage for console, sourced-script, and
  Packages-pane installation, namespace-qualified calls, conditions, and restart.

## 1.5.1

- Correct the Cloudflare dashboard setup guide: the three routing/cancellation
  flags are optional for ordinary external public downloads. Missing dashboard
  entries no longer block the documented setup; Wrangler remains an option for
  enabling those advanced behaviors.
- Document the compatibility date required by the Worker's no-store requests:
  2024-11-11 or later. New dashboard Workers already use the current date.
- Keep the networking implementation and Worker download behavior from 1.5.0.

## 1.5.0

- Add Cloudflare Worker proxy as a third explicit download route alongside
  browser CORS and Tailscale. The same webR download bridge handles panel tests,
  download.file(), read.csv(URL), readLines(URL), and other base URL reads.
- Include a dependency-free streaming Worker, Wrangler configuration, and a
  pedagogical setup guide for the Workers Free plan. Add inline setup steps,
  code copy/download, a generated proxy password, and an exact-origin helper.
- Keep proxy credentials in memory, separate from data-server authentication.
  Require an authenticated Worker handshake, preserve upstream statuses, cancel
  requests on route changes, and never fall back to a different provider.
- Require Worker origin and password configuration; restrict forwarding to
  public HTTP(S) GET targets, validate redirects, and prevent proxy credentials
  and cross-origin sensitive headers from reaching data servers.
- Keep Tailscale's Cloudflare DNS option distinct from the standalone Worker
  route. Preserve the unified Explorer and corrected progress labels from 1.4.0.
- Read package metadata outside R output capture before refreshing Packages, so
  a failed lazy-package download does not trap later console output or change
  the user's R warning settings after a restart.
- Add Worker/controller regressions and a real-webR browser integration test.

## 1.4.0

- Fix successful R downloads incorrectly shown as errors: raw stderr is normal
  output; explicit R error, warning, and message conditions remain distinct.
  Apply the correction to streamed and batched console output, R Markdown
  preview, and Markdown export.
- Consolidate the right Files panel into the left Explorer. Saved project files
  and files created by R appear once in a shared tree, refreshed after execution.
- Add visible per-file deletion and a Delete selected toolbar action, with
  confirmation, runtime-busy guards, verified R filesystem removal, saved-copy
  removal, editor cleanup, and protection against pending saves recreating files.
- Keep directory navigation, downloads, CSV/TSV viewing, and keyboard/multiple
  selection in the Explorer. Label temporary files as R session and provide
  Keep in project for persistence. Opening session text in the editor keeps it.
- Read current runtime contents for previews and downloads. Refresh clean saved
  project files changed by R while preserving unsaved editor buffers. Include
  session files under /project in project ZIP downloads.
- Migrate previously saved dock layouts so the removed Files tab cannot leave
  an empty or invalid active panel.
- Add real-browser console and file-management regressions and focused runtime
  filesystem tests. The Tailscale transport and its shipped binary are unchanged
  from 1.3.3.

See NETWORKING.md for the earlier connection and DNS diagnostics.
