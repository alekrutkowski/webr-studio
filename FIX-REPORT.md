# webR Studio 1.1.1 fix report

Date: 2026-07-22

## Reported failures and resolutions

| Reported failure | Root cause | Resolution |
|---|---|---|
| Editor unusable, cursor jumping to the beginning | Routine synchronization called Ace `session.setValue()`, which replaces the document and resets editor state. Autosave also rebuilt tabs and the complete Project tree after each edit. | Live Ace sessions are authoritative. Ordinary synchronization updates metadata only. Explicit replacement preserves cursor, selection, and scroll. Typing no longer rebuilds tabs or the tree. |
| Autocompletion behaved strangely | Completion sources were not sufficiently isolated and Tab did not robustly detect all Ace popup states. Runtime requests could also outlive the file that initiated them. | Each editor has its own local, text, project/history, and runtime completers. Runtime requests are delayed, cached, canceled on session changes, and skipped while R is busy. Tab accepts active completion popups and otherwise indents. |
| Edge captured Ctrl+N and Ctrl+O | These are browser-reserved commands and cannot be reliably overridden by a page. | New and Open now use Ctrl+Alt+N and Ctrl+Alt+O, with updated menus, tooltips, command palette entries, and shortcut reference. |
| Erase everything left console state behind | The action cleared IndexedDB but did not synchronously reset the live console, and delayed persistence work could restore cleared data. | It now cancels delayed writes, resets console input, output, history, files, plots, tokens, and memory state, waits for in-flight saves, clears IndexedDB, closes webR, and reloads without query or fragment state. |
| Traceback showed only evaluator internals | The stack was collected after unwinding and generic webR/R evaluation frames were not removed reliably. | A calling error handler captures the source expression, condition call, and stack before unwinding. Generic evaluator frames are filtered and the console displays the source expression, failing call, and user call stack. |
| Stress test failed in section 8 | Base R `sprintf()` does not support the `%,d` grouping flag. | The script uses an explicit locale-independent integer formatter and contains no `%,d` format. |
| Run label was wrong | UI copy used the broader old wording. | The primary action is labeled `Run selected` throughout the toolbar, menus, command palette, and shortcut reference. With no selection, Ctrl+Enter still runs the current complete expression. |
| Global Environment was blank | The R query included a malformed escaped regular expression and a single difficult object could abort the whole inspection. | Hidden helper names use `startsWith()`. Every object is inspected inside its own `tryCatch()`, and refresh failures produce a retryable visible error instead of an empty pane. |
| Plot did not fit its viewer | The image used maximum dimensions rather than the pane's complete dimensions, and the R device retained a fixed aspect ratio. | The plot frame and image use the complete viewer. The device size follows the pane aspect ratio, and the latest recorded plot is replayed after meaningful pane-size changes when R can replay it. |
| Overflow buttons did nothing | The buttons had no handlers. A generic menu binding could also collide with specialized controls. | Editor and upper/lower dock menus are wired explicitly. The generic binding only targets named application menus. Menu action errors are caught and surfaced. |
| Curved marks reduced readability | Wavy lint markers and bracket/selected-word borders accumulated, including stale markers owned by previously active sessions. | Wavy and dotted underlines were removed. Errors and warnings use restrained background markers; suggestions stay in annotations and Problems. Marker IDs are removed from the session that owns them. |
| Named arguments were reported as assignments | A context-free equals-sign rule could not distinguish assignment from named arguments or function defaults. | A delimiter-aware scanner treats call arguments, subscripts, and function defaults as argument contexts while retaining assignment guidance in blocks and grouped expressions. |
| Project files temporarily disappeared | The tree was destroyed and reconstructed on each keystroke and all-collapsed state was interpreted as uninitialized. | Typing updates only dirty indicators. Folder initialization is explicit, so an intentionally collapsed tree remains collapsed. |

## Additional issues found during review

- Stale asynchronous console highlighting could restore output after Clear.
- Concurrent console appends could overwrite one another.
- A save that began before a newer edit could incorrectly clear the newer dirty state.
- An in-flight save could recreate a file after deletion or full workspace replacement.
- Replacing a workspace could leave deleted files in webR's `/project` mirror.
- Closing or deleting the final file could leave an orphaned editable Ace session.
- Lint and rainbow markers could remain attached to inactive sessions.
- Delayed completion callbacks could target a newly opened file.
- Duplicate or corrupted dock assignments could leave panels missing.
- Direct async menu actions could create unhandled promise rejections.
- An empty console draft could fall back to an older draft because persistence used truthiness rather than nullishness.

## Verification

- All JavaScript modules pass `node --check`.
- The GitHub Actions YAML and Python development server parse successfully.
- The dependency-free structural and unit suite passes.
- A headless Chromium interaction check passes for menu opening, action execution, ARIA state, dismissal, and rejected async action handling.
- ZIP integrity and SHA-256 verification are performed during release packaging.

A complete live webR execution session could not be run in the container browser because navigation and external module loading are administratively blocked. The webR-facing changes are therefore guarded by source-level regression checks and verified against the pinned public APIs, while the DOM menu behavior was exercised in Chromium with the actual project code.
