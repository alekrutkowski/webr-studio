# Local R assistant

webR Studio 1.6.0 adds an optional coding assistant powered by
[WebLLM 0.2.87](https://github.com/mlc-ai/web-llm/releases/tag/v0.2.87).
It generates text on this device in a dedicated worker using WebGPU. It can use
a small snapshot of the live R session, explain code and errors, and propose
code for the editor or console.

The assistant starts unloaded. Opening its pane loads the small local UI
modules; **Load model** starts the WebLLM import and model downloads. Ordinary
R completion continues to work without a model. The implementation remains a
static application with no build step, inference server, or API key.

## Start using it

1. Serve the app over HTTPS, or run `python3 serve.py` and open
   `http://127.0.0.1:8000`. Use a current browser with WebGPU enabled; Chrome or
   Edge are practical starting points. Availability also depends on the device,
   graphics driver, and browser configuration.
2. Open the **Assistant** dock tab, or choose **Local R assistant** from the
   menus or command palette.
3. Select a model and click **Load model**. The first load downloads model
   assets and compiles GPU work. Progress is shown, and editing remains
   available. Subsequent loads can reuse browser-cached assets.
4. Ask a question, then click **Ask** or press **Ctrl+Enter** while the question
   box is focused. For example: `Which columns does sales contain?` or
   `Write data.table code to aggregate sales by region.`
5. Review any proposed code. The actions beside a complete R code block let
   you copy it, insert it into the captured editor location, append it to the
   console draft, or explicitly **Run in R**.

**Add to console** preserves the current draft and appends the proposal; it
does not execute it. **Run in R** runs the visible code through the IDE's normal
execution path. The resulting bounded text is shown in the assistant and
included in the next question, so you can ask for a correction or explanation.
Full output and plots remain in their usual IDE panes.

## Suggestions in the editor and console

Focus an R or R Markdown editor, or the idle R console, then press **Alt+\**
or click that pane's sparkle button. A selection requests a replacement; an
empty selection requests a continuation at the cursor. Click **Insert
suggestion** or **Replace selection** after reviewing the result.

Suggestions are requested explicitly. There is no background model request on
each keystroke and no automatic acceptance of generated code. Nearby source
must be enabled for cursor suggestions. If you turn that context option off,
the assistant asks you to enable it before making a suggestion request.

Insertion checks the document, selected range, cursor, and R session against
the state captured when the request began. If these have changed, request a
fresh suggestion or copy the text manually. This avoids applying a late reply
to a different location. Standard Ace completion and its existing keyboard
shortcuts remain independent of the assistant.

## What the model can see

Open the context settings and click **Preview context** to inspect the exact
bounded messages that would be sent to the local worker. The same preview is
updated for each request.

| Context | Default | What is included |
| --- | --- | --- |
| R object metadata | On | A capped inventory of object names, classes, and dimensions. Objects selected for detail, or named in the request or nearby source, receive a current inspection when R is idle. |
| Data values | Off | At most three storage values per inspected atomic column or vector. For a data frame this corresponds to up to three rows across the inspected columns. |
| Function bodies | Off | Argument names are metadata. Enabling bodies includes a bounded body for selected or relevant functions when its syntax fits the inspection limits. Defaults are omitted. |
| Nearby source | On | A short region around the editor or console cursor, including selected text. It is required for a suggestion. |
| Last R result | Off | Bounded text from the most recent execution observed after the assistant was opened. **Run in R** enables it for the next question. Plot pixels are not included. |

Select up to six objects with Ctrl+click. With no selection, the assistant
matches object names in the question and nearby source. If no relevant object
is identified, it uses the cached inventory without scanning the live session.
The inventory can be stale; naming or selecting a specific object requests
fresh details. Inspection uses exact global binding names, not an R expression
supplied by the model.

Current limits are deliberately small:

| Resource | Limit used by the UI |
| --- | --- |
| Objects shown in the picker | 100 |
| Cached inventory entries | 12 |
| Objects inspected per request | 6 |
| Columns or named elements per inspected object | 8 |
| Optional sample rows or values per column/vector | 3 |
| Collected R detail | 3,200 characters, reduced further when constructing the prompt |
| R context in a prompt | Up to 1,700 characters |
| Nearby source in a prompt | Up to 1,100 characters |
| Last execution result in a prompt | Up to 600 characters |
| User question | 1,200 characters |
| Combined prompt and retained history | 4,800 characters |
| Previous question/reply pairs in a request | At most 2, only if the remaining text budget permits |

Text limits are not tokenizer limits. An unusual or token-dense prompt can
still exceed the model context window; shorten the question, select fewer
objects, or clear chat if the engine reports that condition.

The inspector avoids active bindings and custom printing or indexing methods.
It omits S4 contents, environments, external pointers, and unsupported nested
contents. A normal delayed binding can still be forced when R retrieves the
selected object. For that reason, live inspection happens only for an explicit
question, suggestion, or preview, while R is idle. Samples expose storage
values: for example, a factor can appear as integer codes and a Date as its
numeric storage value. Classes are included to help interpret them.

## Models and memory

The model selector contains two pinned identifiers from WebLLM's
[0.2.87 model catalog](https://raw.githubusercontent.com/mlc-ai/web-llm/v0.2.87/src/config.ts):

| Model | Exact identifier | Upstream catalog GPU-memory estimate |
| --- | --- | --- |
| Lighter, selected initially | `Qwen2.5-Coder-0.5B-Instruct-q4f32_1-MLC` | 1,060.2 MB, about 1.06 GB |
| More capable option | `Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC` | 1,888.97 MB, about 1.89 GB |

These catalog figures describe the upstream prebuilt records with their
4,096-token context setting. This app requests a **2,048-token context**. The
figures are not measurements of this integration, estimates of total IDE
memory, or download sizes. Actual memory use and speed depend on the browser,
model, device, and other workloads. Download sizes have not been measured here.
The q4f32 variants avoid requiring the optional `shader-f16` GPU feature.

Start with the lighter model when responsiveness matters most. The larger
option offers more model capacity but needs more resources. Both are small
local coding models; their R suggestions still need review. This integration
does not claim Claude Code or Codex quality, project-wide understanding,
autonomous file editing, or an autonomous tool-execution loop.

## How responsiveness is protected

- WebLLM parsing, initialization, downloads, shader compilation, and inference
  run in a dedicated module worker created only after **Load model**.
- One model and one generation are active at a time. No inference is scheduled
  by normal typing or ordinary completion.
- Chat replies request at most 256 output tokens; cursor suggestions request
  at most 128. The model context is capped at 2,048 tokens.
- Streamed text is batched in the worker at roughly 40 ms intervals. The UI
  updates plain text while streaming and creates code actions after completion.
- Starting an R execution stops active assistant generation. New questions and
  context inspections wait until R is idle, including interactive R prompts.
- **Stop** requests generation interruption. If the worker has not responded
  within 2.5 seconds, the client terminates it and unloads the model. Stopping
  model loading terminates the worker immediately.
- A ready model unloads after five minutes without a model request. **Unload**
  is also available at any time. Browser-cached assets are retained for reuse.
- Model loading has a ten-minute timeout; generation has a two-minute timeout.
  A timeout tears down the worker and reports an error instead of queuing more
  work behind it.

These measures isolate model work and bound its workload. They do not eliminate
shared GPU, memory, thermal, or battery contention. In particular, a worker does
not guarantee a particular typing latency on every device. No latency or
tokens-per-second benchmark is claimed.

## Privacy, downloads, and storage

The integration sends no prompt, object snapshot, or generated answer to a
remote inference service. Those messages move between this page and its local
worker. Loading the model does make ordinary network requests:

| Source | Purpose |
| --- | --- |
| `cdn.jsdelivr.net` | The pinned WebLLM JavaScript distribution |
| Hugging Face and its download/storage hosts | Model configuration, tokenizer files, and weights |
| `raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/` | Compatible compiled model libraries |

These are browser requests and do not use the IDE's R-only Tailscale or
Cloudflare download route. WebLLM normally caches model artifacts in the
browser's Cache API. Quotas, private browsing, or eviction can require a new
download. A first load needs network access, and full offline operation is not
promised. See the upstream [cache and worker
documentation](https://webllm.mlc.ai/docs/user/advanced_usage.html).

Chat history, prompt context, and assistant output remain in page memory and
are not added to workspace exports, URL sharing, Gists, or IndexedDB by the
assistant. The chosen model identifier is saved as an IDE preference; it does
not cause automatic model loading on the next visit. Code you explicitly insert
or run becomes ordinary editor or console content and follows the IDE's usual
saving and sharing behaviour.

**Clear chat** clears the visible conversation, retained prompt history, and
last execution result. Each new model request resets the engine's implicit
chat state before passing the bounded messages. **Unload** terminates the worker
and releases its model context; it does not delete downloaded model files from
the browser cache. Clearing site data in the browser also clears those caches
and the IDE's other site storage, including saved projects.

## Validation and a manual smoke test

Validation completed for this source on 9 November 2026:

| Check | Result |
| --- | --- |
| `npm test`, including the existing IDE suite and four assistant suites | Passed |
| Actual R inspection through webR 0.6.0 / R 4.6.0 under Node | Nine scenarios passed |
| Thirty repeated context collections | No increase in retained R proxy handles |
| Optional live `data.table` scenario | Skipped because the package was absent from the test runtime |
| Browser regression script syntax | Passed |
| Browser UI and real WebGPU model inference | Not executed; Chromium could not start in this environment |

`npm test` includes deterministic assistant tests with simulated worker/R
boundaries. They exercise lifecycle errors, interruption, context bounds,
explicit actions, and stale-insertion protection without downloading models.
The optional `npm run test:assistant-webr` uses real webR under Node to exercise
the R inspection bridge. Install `webr@0.6.0` locally, or select its module:

```bash
WEBR_MODULE=/absolute/path/to/webr/dist/webr.mjs npm run test:assistant-webr
```

In PowerShell, set `$env:WEBR_MODULE` before running that command. The real-R
checks cover data-frame metadata and samples, function details, active bindings,
custom methods, masked base-function names, literal object names, large data,
and missing objects. This validates the R bridge independently of a language
model.

The optional `npm run test:browser-assistant` runs the real app, Ace, and webR
with a deterministic replacement for the external WebLLM module and GPU
capability check. It checks the UI and network boundaries without downloading
model weights. It needs the same optional Playwright/Chromium setup as the
other browser tests. `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` can select existing
installations.

To deliberately download the real 0.5B model and test actual GPU generation on
a suitable machine, use this opt-in mode. It does not execute model-generated
R code:

```bash
ASSISTANT_REAL_WEBGPU=1 BROWSER_HEADLESS=0 npm run test:browser-assistant
```

For PowerShell:

```powershell
$env:ASSISTANT_REAL_WEBGPU = "1"
$env:BROWSER_HEADLESS = "0"
npm run test:browser-assistant
```

Real browser/GPU inference was not validated in the implementation environment:
the downloaded Chromium executable exited before a browser session could be
established. The release therefore includes no measured GPU-memory or inference
performance result. Validate the full path on the target device:

1. Reload the app with Developer Tools open. Before **Load model**, confirm no
   WebLLM or model-weight request is made. Check that typing and standard R
   completion work.
2. Run a small fixture in the R console:

   ```r
   demo <- datasets::iris
   center <- function(x) x - mean(x, na.rm = TRUE)
   ```

3. Open **Assistant**, select `demo`, and choose **Preview context**. Confirm
   column names and types appear. Enable the small sample and preview again.
   Select `center` and enable function bodies to inspect the bounded definition.
4. Load the 0.5B model and observe progress. Ask for R code that calculates
   mean `Sepal.Length` by `Species` using the existing `demo` object. Check the
   returned code before choosing **Add to console** or **Run in R**.
5. Ask a follow-up about the result. Confirm the context preview contains only
   the bounded result when its checkbox is enabled.
6. Request **Alt+\** suggestions from both the editor and console. Confirm a
   proposal inserts only after clicking its action. Move the cursor or edit the
   source during generation and confirm the old insertion is rejected.
7. Start another question, then run R code. Confirm generation stops and the R
   console remains usable. Also test **Stop** during a response and during a
   load, then reload the model if needed.
8. Leave the model idle for five minutes and confirm its status changes to
   unloaded. Verify that a subsequent load can reuse retained cached assets.
9. Clear chat and reload the page. Confirm assistant conversation is absent,
   the model remains unloaded, and the normal project is still available.

If the pane reports unavailable WebGPU, check browser hardware acceleration,
graphics drivers, HTTPS or localhost, and whether `navigator.gpu.requestAdapter()`
returns an adapter. There is no automatic CPU or remote-API fallback. If loading
fails, check access to the model download hosts and available browser storage,
then retry with the lighter model. See [WebLLM getting
started](https://webllm.mlc.ai/docs/user/get_started.html) and the
[WebGPU adapter documentation](https://developer.mozilla.org/en-US/docs/Web/API/GPU/requestAdapter).

## Implementation map and acknowledgments

| File | Responsibility |
| --- | --- |
| `js/assistant.js` | Lazy pane, context controls, conversation, and explicit code actions |
| `js/assistant-context.js` | Prompt bounds, source snapshots, reply parsing, and guarded insertion |
| `js/assistant-client.js` | Pinned models, capability checks, worker lifecycle, timeouts, and cancellation |
| `js/assistant-worker.js` | Lazy WebLLM import and streamed local inference |
| `js/webr-engine.js` | Bounded `getAssistantContext()` inspection of actual R bindings |

Thanks to the [MLC AI / WebLLM contributors](https://github.com/mlc-ai/web-llm)
for the Apache-2.0 inference engine and MLC model conversions, and to the Qwen
team for [Qwen2.5-Coder-0.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct)
and [Qwen2.5-Coder-1.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct),
both Apache-2.0. Upstream distribution and model licences continue to apply.
webR Studio's integration code remains covered by its existing MIT licence.
