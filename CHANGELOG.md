# Changelog

## 1.2.6 – 2026-08-03

- Removed every per-version release-note file from the distributable repository.
- Reduced hard-coded file-presence checks to runtime, test, and GitHub Pages deployment entry points.
- Added dynamic validation of local HTML assets and the JavaScript ES-module import graph.
- Made stress-test validation conditional so examples remain optional documentation rather than a deployment prerequisite.
- Verified that the test suite passes after optional documentation, examples, and development-server files are removed.

## 1.2.5 – 2026-08-03

- Removed historical release-note files from the deployment-critical required-file list.
- Derived the tested application version from `js/config.js`.
- Added consistency checks for `package.json` and cache-busting application assets.
- Kept current release-note validation optional so documentation cannot block GitHub Pages deployment.
- Added a regression run in which all older release-note files are absent.

## 1.2.4 – 2026-08-03

- Replaced capture-based file sourcing with an interactive webR REPL stream.
- Source output now reaches the visible console as R produces each stdout, stderr, message, warning, and error line.
- Source with Echo emits one syntax-highlighted command block per top-level R expression before evaluation.
- Consecutive streamed stdout and stderr lines update a live console entry without excessive cards or persistence churn.
- Preserved responsive Stop handling, plots, queued Viewer requests, tracebacks, execution timing, and post-run environment refresh.
- Finalized streamed runs at the returning primary R prompt so trailing queued output is not lost.
- Added a timed source-output heartbeat to the bundled stress test.
- Added regression coverage for REPL start/done signalling, echo-marker decoding, stream grouping, and live transcript updates.

## 1.2.3 – 2026-08-02

- Added a New Rmd file action above New R script throughout the file-creation UI.
- Added file-based Source and Source with Echo for `.R` scripts.
- Intercepted console help expressions and rendered help through `Rd2HTML()` with R syntax highlighting.
- Applied R Markdown figure dimensions and output sizing per chunk.
- Rendered `results='asis'` as Markdown and stopped executing four-space-indented chunk examples.
- Improved MathML sanitization and remote image handling.
- Removed visible `NULL` lines and internal wrapper noise from the bundled stress-test fixtures.

## 1.2.2 – 2026-08-02

### Fixed

- Combined adjacent line-oriented webR stdout and stderr entries before R Markdown rendering, preventing one padded and bordered output block per printed line.
- Preserved tabular R output spacing with non-wrapping preformatted layout and horizontal overflow.
- Reduced R chunk output padding and line height in the live preview and self-contained HTML export.
- Kept messages, warnings, errors, Viewer notifications, and tracebacks as distinct condition blocks.

## 1.2.1 – 2026-07-23

### Fixed

- Scoped SVG icon styling to `.ui-icon`, preventing inherited `fill: none` and icon stroke rules from hiding text and glyphs in R-generated SVG plots.
- Preserved SVG `symbol` and `use` glyph references, assigned unique fragment IDs to each inline plot, and added an image fallback if safe inline insertion is unavailable.
- Guarded the stress-test timing attribute so `write.csv()`, `write.table()`, and other `NULL`-returning side-effect functions complete normally.
- Removed the remaining unsupported `"crimson"` colour from the generated R Markdown fixture.
- Aligned expandable and leaf rows in the recursive list Viewer and removed the redundant internal temporary-object root.

### Added

- Inline R Markdown evaluation for code spans such as `` `r 2 + 2` ``.
- A bounded private store for temporary `View(expression)` values, separate from `.GlobalEnv`.

### Changed

- Shortened the primary action label to **Run selected**.


## 1.2.0 – 2026-07-22

### Fixed

- Corrected the Marked browser script path so headings, emphasis, lists, tables, blockquotes, and ordinary Markdown prose render instead of falling back to a code block.
- Added a dedicated Ace R Markdown mode that embeds R highlighting only inside fenced `{r}` chunks.
- Replayed the latest recorded R plot when the Plot pane changes aspect ratio and made inline SVG occupy the full viewer.
- Replaced the non-portable R colour name `"crimson"` in the stress test with `"#9F1239"`.
- Replaced ambiguous refresh glyphs with a clearer two-arrow circular refresh icon.

### Added

- Prominent Render controls for Markdown and R Markdown files.
- Pretty, self-contained single-file HTML export with all document CSS and generated SVG graphics inline.
- Dollar-delimited inline and display maths rendered as self-contained MathML.
- `View()` integration for R objects, Viewer back and forward history, and searchable recursive trees for lists, pairlists, and environments.
- Maximize and restore controls for the Project, Editor, Console, upper dock, and lower dock panes.

## 1.1.1 – 2026-07-22

### Fixed

- Prevented Ace sessions from being reset during ordinary file synchronization and autosave.
- Kept cursor, selection, and scroll state stable during explicit external content replacement.
- Added editor-local and console-local live completion, project-word completion, history completion, runtime completion, and reliable Tab acceptance.
- Replaced browser-reserved Ctrl+N and Ctrl+O with Ctrl+Alt+N and Ctrl+Alt+O.
- Made full local-data erasure clear console transcript, input, history, files, plots, settings, snapshots, tokens, checkpoints, and pending writes.
- Captured the submitted expression, condition call, and user call stack before R unwinds the error.
- Fixed Global Environment inspection and isolated failures to individual objects.
- Made plot output occupy the complete viewer and reflow the latest recorded plot when the pane aspect ratio changes.
- Wired the editor and right-dock overflow menus and protected menu actions from unhandled promise rejections.
- Removed wavy diagnostic decorations and fixed marker ownership across editor sessions.
- Corrected assignment linting so named arguments and function defaults are not reported as assignment style violations.
- Prevented the Project tree and editor tabs from being rebuilt on every keystroke.
- Preserved an intentionally fully collapsed Project tree.
- Serialized console rendering and invalidated output work queued before Clear.
- Serialized per-file saves and added revision checks to prevent stale autosaves from clearing newer dirty edits.
- Cleared stale virtual project files when replacing a workspace.
- Corrected the stress-test use of unsupported R `sprintf("%,d")` formatting.

### Added

- `examples/webr_ide_stress_test.R`.
- Regression coverage for editor-session stability, completion acceptance, lint context, traceback cleanup, console output ordering, marker ownership, panel actions, responsive plots, and persistence cancellation.
