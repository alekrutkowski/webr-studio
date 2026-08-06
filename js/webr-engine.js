import {
  WEBR_VERSION, normalizeWebRVersion, webRBaseUrl, webRModuleUrl
} from './config.js';
import { rString, rVector, rName, normalizePath, dirname, formatBytes } from './utils.js';

const MARKER_LINE = /^<<WEBRSTUDIO:(MESSAGE|WARNING|ERROR|INFO|VIEW|ECHO)>>(.*)$/;
const RUNTIME_CANCELLATION = 'WebRRuntimeCancellation';
const INTERRUPT_ERROR_PATTERN = /(?:execution (?:was )?interrupted|user interrupt|non-local transfer of control|^interrupt(?:ed)?[.!]?$)/i;

export function normalizeRSource(value = '') {
  return String(value)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?|\u2028|\u2029/g, '\n');
}

export function normalizeVirtualPath(value = '/project') {
  const source = String(value || '/project').trim().replaceAll('\\', '/');
  const parts = [];
  for (const part of `${source.startsWith('/') ? '' : '/'}${source}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}` || '/';
}

function isInterruptLikeError(error) {
  return INTERRUPT_ERROR_PATTERN.test(error?.message || String(error || ''));
}

function scheduleOutputFrame(callback) {
  const handle = { active: true, frameId: 0, timeoutId: 0 };
  const run = () => {
    if (!handle.active) return;
    handle.active = false;
    if (handle.frameId && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(handle.frameId);
    }
    globalThis.clearTimeout(handle.timeoutId);
    callback();
  };
  handle.timeoutId = globalThis.setTimeout(run, 16);
  if (typeof globalThis.requestAnimationFrame === 'function') {
    handle.frameId = globalThis.requestAnimationFrame(run);
  }
  return handle;
}

function cancelOutputFrame(handle) {
  if (!handle?.active) return;
  handle.active = false;
  if (handle.frameId && typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(handle.frameId);
  }
  globalThis.clearTimeout(handle.timeoutId);
}

function runtimeCancellationError(message = 'Execution stopped because the webR runtime was restarted.') {
  const error = new Error(message);
  error.name = RUNTIME_CANCELLATION;
  error.webrStudioCancelled = true;
  return error;
}

function isRuntimeCancellation(error) {
  return Boolean(error?.webrStudioCancelled || error?.name === RUNTIME_CANCELLATION);
}

export function stripTerminalControlSequences(value = '') {
  return String(value)
    // Operating System Command and other string-style terminal sequences.
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[P^_][\s\S]*?\x1B\\/g, '')
    // ANSI/ECMA-48 Control Sequence Introducer sequences, including private
    // cursor visibility commands such as ESC[?25h emitted by interactive R.
    .replace(/(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[@-_]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F-\u009F]/g, '');
}

function decodeRField(value = '') {
  try { return decodeURIComponent(value); } catch { return value; }
}

function parseDelimitedRecords(records, separator = '\u001f') {
  return records.map(record => String(record).split(separator).map(decodeRField));
}

function appendOutputItem(outputs, item) {
  const previous = outputs.at(-1);
  // Keep contiguous stream lines in one logical output block so document
  // renderers do not create a padded, bordered <pre> for every displayed row.
  if (previous?.type === item.type && (item.type === 'stdout' || item.type === 'stderr')) {
    previous.text += `\n${item.text}`;
  } else {
    outputs.push(item);
  }
}

function parseCapturedOutput(items = []) {
  const outputs = [];
  const appendStream = (type, text) => appendOutputItem(outputs, { type, text });

  for (const item of items) {
    const fallbackType = item.type === 'stderr' ? 'stderr' : 'stdout';
    const data = stripTerminalControlSequences(
      typeof item.data === 'string' ? item.data : String(item.data ?? '')
    );
    if (!data) continue;
    const lines = data.split(/\r?\n/);
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    let ordinary = [];
    const flushOrdinary = () => {
      if (!ordinary.length) return;
      appendStream(fallbackType, ordinary.join('\n'));
      ordinary = [];
    };
    for (const line of lines) {
      const marker = line.match(MARKER_LINE);
      if (!marker) {
        ordinary.push(line);
        continue;
      }
      flushOrdinary();
      const markerType = marker[1].toLowerCase();
      const markerText = markerType === 'echo' ? decodeRField(marker[2].trim()) : marker[2].trim();
      outputs.push({ type: markerType === 'echo' ? 'command' : markerType, text: markerText });
    }
    flushOrdinary();
  }
  return outputs;
}

export class WebREngine extends EventTarget {
  constructor({ version = WEBR_VERSION } = {}) {
    super();
    this.webR = null;
    this.module = null;
    this.ready = false;
    this.running = false;
    this.starting = false;
    this.restarting = false;
    this.generation = 0;
    this.requestedVersion = normalizeWebRVersion(version);
    this.version = this.requestedVersion;
    this.baseUrl = webRBaseUrl(this.requestedVersion);
    this.moduleUrl = webRModuleUrl(this.requestedVersion);
    this.rVersion = '';
    this.interruptSupported = false;
    this.plotWidth = 7;
    this.plotHeight = 5;
    this.outputPump = null;
    this.outputPumpGeneration = 0;
    this.replOperation = null;
    this.replAtPrompt = false;
    this.promptWaiters = new Set();
    this.executionPhase = 'idle';
    this.lastInterruptResult = { ok: false, reason: 'not-running' };
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setExecutionPhase(phase, operation = 'repl') {
    if (this.executionPhase === phase) return;
    this.executionPhase = phase;
    this.emit('state', { state: 'running', operation, phase });
  }

  async initialize({
    version = this.requestedVersion,
    plotWidth = 7,
    plotHeight = 5,
    onProgress = () => {}
  } = {}) {
    if (this.ready) return this;
    if (this.starting) {
      await new Promise((resolve, reject) => {
        this.addEventListener('ready', resolve, { once: true });
        this.addEventListener('error', event => reject(event.detail.error), { once: true });
      });
      return this;
    }

    this.starting = true;
    this.requestedVersion = normalizeWebRVersion(version);
    this.baseUrl = webRBaseUrl(this.requestedVersion);
    this.moduleUrl = webRModuleUrl(this.requestedVersion);
    this.plotWidth = plotWidth;
    this.plotHeight = plotHeight;
    try {
      onProgress(12, 'Loading the webR runtime…');
      this.module = await import(this.moduleUrl);
      const { WebR } = this.module;
      this.webR = new WebR({ interactive: true, baseUrl: this.baseUrl });
      onProgress(34, 'Starting R in a Web Worker…');
      await this.webR.init();
      this.startOutputPump();
      onProgress(62, 'Preparing the project filesystem…');
      await this.ensureDirectory('/project');
      await this.webR.evalRVoid(`dir.create("/project", recursive = TRUE, showWarnings = FALSE); setwd("/project")`);
      onProgress(74, 'Installing IDE helpers…');
      await this.installHelpers();
      await this.setPlotSize(plotWidth, plotHeight);
      this.version = String(this.webR.version || this.requestedVersion);
      this.rVersion = String(this.webR.versionR || await this.webR.evalRString('R.version.string'));
      this.interruptSupported = Boolean(
        globalThis.crossOriginIsolated && typeof globalThis.SharedArrayBuffer === 'function'
      );
      this.ready = true;
      this.starting = false;
      this.generation += 1;
      onProgress(100, 'R is ready');
      this.emit('ready', { version: this.version, rVersion: this.rVersion, generation: this.generation });
      return this;
    } catch (error) {
      this.stopOutputPump(error);
      this.starting = false;
      this.ready = false;
      this.emit('error', { error });
      throw error;
    }
  }

  async installHelpers() {
    const helperCode = `
local({
  if (exists(".webrStudio", envir = .GlobalEnv, inherits = FALSE)) {
    rm(".webrStudio", envir = .GlobalEnv)
  }
  e <- new.env(parent = baseenv())
  assign(".webrStudio", e, envir = .GlobalEnv)
  e$plot_serial <- 0L
  e$view_serial <- 0L
  e$views <- new.env(parent = emptyenv())
  e$view_order <- character()
  e$resolve <- function(name) {
    name <- as.character(name)[1L]
    prefix <- "@view:"
    if (startsWith(name, prefix)) {
      key <- substring(name, nchar(prefix) + 1L)
      if (!exists(key, envir = e$views, inherits = FALSE)) {
        stop("The temporary Viewer object is no longer available.", call. = FALSE)
      }
      return(get(key, envir = e$views, inherits = FALSE))
    }
    get(name, envir = .GlobalEnv, inherits = FALSE)
  }
  e$plot_width <- 7
  e$plot_height <- 5
  e$last_trace <- character()
  e$last_error <- ""
  e$last_expression <- ""
  e$last_error_call <- ""
  e$last_ok <- TRUE
  e$last_interrupted <- FALSE
  e$emit <- function(kind, text) {
    text <- paste(as.character(text), collapse = " ")
    text <- gsub("[\\r\\n]+", " ", text)
    cat(sprintf("<<WEBRSTUDIO:%s>>%s\\n", kind, text), file = stderr())
  }
  e$is_interrupt_condition <- function(condition) {
    message <- conditionMessage(condition)
    inherits(condition, "interrupt") ||
      grepl("non-local transfer of control", message, fixed = TRUE) ||
      grepl("execution interrupted", message, ignore.case = TRUE)
  }
  e$View <- function(x, title = deparse(substitute(x), width.cutoff = 110L)) {
    expression <- substitute(x)
    value <- x
    candidate <- if (is.symbol(expression)) as.character(expression) else ""
    if (nzchar(candidate) && exists(candidate, envir = .GlobalEnv, inherits = FALSE)) {
      object_name <- candidate
    } else {
      e$view_serial <- e$view_serial + 1L
      key <- sprintf("view_%06d", e$view_serial)
      assign(key, value, envir = e$views)
      e$view_order <- c(e$view_order, key)
      if (length(e$view_order) > 60L) {
        stale <- head(e$view_order, length(e$view_order) - 60L)
        rm(list = stale, envir = e$views)
        e$view_order <- tail(e$view_order, 60L)
      }
      object_name <- paste0("@view:", key)
    }
    title <- paste(as.character(title), collapse = " ")
    payload <- paste(
      utils::URLencode(enc2utf8(object_name), reserved = TRUE),
      utils::URLencode(enc2utf8(title), reserved = TRUE),
      sep = "|"
    )
    e$emit("VIEW", payload)
    invisible(value)
  }
  assign("View", e$View, envir = .GlobalEnv)
  e$device <- function(...) {
    e$plot_serial <- e$plot_serial + 1L
    filename <- sprintf("/tmp/webrstudio-plot-%06d-%%03d.svg", e$plot_serial)
    grDevices::svg(
      filename = filename,
      width = e$plot_width,
      height = e$plot_height,
      onefile = FALSE,
      bg = "transparent",
      pointsize = 11
    )
    try(grDevices::dev.control(displaylist = "enable"), silent = TRUE)
  }
  options(device = e$device)
  e$eval <- function(
    code,
    plot_width = NULL,
    plot_height = NULL,
    echo = FALSE,
    auto_print = TRUE,
    working_directory = NULL
  ) {
    previous_plot_width <- e$plot_width
    previous_plot_height <- e$plot_height
    previous_working_directory <- getwd()
    if (length(plot_width) && is.finite(plot_width[1L]) && plot_width[1L] > 0) {
      e$plot_width <- as.numeric(plot_width[1L])
    }
    if (length(plot_height) && is.finite(plot_height[1L]) && plot_height[1L] > 0) {
      e$plot_height <- as.numeric(plot_height[1L])
    }
    if (length(working_directory) && nzchar(as.character(working_directory)[1L])) {
      setwd(as.character(working_directory)[1L])
    }
    on.exit({
      e$plot_width <- previous_plot_width
      e$plot_height <- previous_plot_height
      try(setwd(previous_working_directory), silent = TRUE)
    }, add = TRUE)
    e$last_trace <- character()
    e$last_error <- ""
    e$last_expression <- ""
    e$last_error_call <- ""
    e$last_ok <- TRUE
    e$last_interrupted <- FALSE
    before <- grDevices::dev.list()
    on.exit({
      after <- grDevices::dev.list()
      before_ids <- if (is.null(before)) integer() else unname(before)
      after_ids <- if (is.null(after)) integer() else unname(after)
      new_ids <- setdiff(after_ids, before_ids)
      if (length(new_ids)) {
        try(e$last_plot <- grDevices::recordPlot(), silent = TRUE)
        for (id in rev(new_ids)) try(grDevices::dev.off(which = id), silent = TRUE)
      }
    }, add = TRUE)

    expressions <- tryCatch(
      parse(text = code, keep.source = TRUE),
      error = function(condition) {
        e$last_ok <- FALSE
        e$last_error <- conditionMessage(condition)
        e$last_expression <- paste(code, collapse = "\\n")
        e$last_error_call <- ""
        e$emit("ERROR", conditionMessage(condition))
        NULL
      }
    )
    if (is.null(expressions)) return(invisible(NULL))

    value <- NULL
    for (index in seq_along(expressions)) {
      expression_lines <- deparse(expressions[[index]], width.cutoff = 500L)
      expression_text <- paste(expression_lines, collapse = " ")
      if (isTRUE(echo)) {
        encoded_expression <- utils::URLencode(
          enc2utf8(paste(expression_lines, collapse = "\\n")),
          reserved = TRUE
        )
        e$emit("ECHO", encoded_expression)
      }
      evaluated <- tryCatch(
        withCallingHandlers(
          withVisible(eval(expressions[[index]], envir = .GlobalEnv)),
          message = function(condition) {
            e$emit("MESSAGE", conditionMessage(condition))
            invokeRestart("muffleMessage")
          },
          warning = function(condition) {
            e$emit("WARNING", conditionMessage(condition))
            invokeRestart("muffleWarning")
          },
          error = function(condition) {
            # A calling handler runs before stack unwinding, so user calls are
            # still available here. The outer tryCatch only converts the error
            # into a result that JavaScript can inspect.
            e$last_ok <- FALSE
            e$last_expression <- expression_text
            if (e$is_interrupt_condition(condition)) {
              e$last_interrupted <- TRUE
              e$last_error <- "Execution interrupted"
              e$last_error_call <- ""
              e$last_trace <- character()
              return(invisible(NULL))
            }
            e$last_error <- conditionMessage(condition)
            call_ <- conditionCall(condition)
            e$last_error_call <- if (is.null(call_)) "" else paste(deparse(call_, width.cutoff = 110), collapse = " ")
            calls <- sys.calls()
            calls_text <- vapply(
              calls,
              function(call) paste(deparse(call, width.cutoff = 110), collapse = " "),
              character(1)
            )
            # Keep the stack beginning with the expression submitted by the
            # user, rather than webR's evaluator and condition machinery.
            eval_frames <- which(startsWith(calls_text, "eval(expressions[[index]]"))
            if (length(eval_frames)) {
              first_user_frame <- tail(eval_frames, 1L) + 1L
              if (first_user_frame <= length(calls_text)) {
                calls_text <- calls_text[seq.int(first_user_frame, length(calls_text))]
              }
            }
            e$last_trace <- calls_text
          }
        ),
        error = function(condition) {
          interrupted <- isTRUE(e$last_interrupted) || e$is_interrupt_condition(condition)
          e$last_ok <- FALSE
          if (!nzchar(e$last_expression)) e$last_expression <- expression_text
          if (interrupted) {
            e$last_interrupted <- TRUE
            e$last_error <- "Execution interrupted"
            e$last_error_call <- ""
            e$last_trace <- character()
          } else {
            if (!nzchar(e$last_error)) e$last_error <- conditionMessage(condition)
            e$emit("ERROR", conditionMessage(condition))
          }
          structure(list(value = NULL, visible = FALSE), class = "webrstudio_error")
        },
        interrupt = function(condition) {
          e$last_ok <- FALSE
          e$last_interrupted <- TRUE
          e$last_error <- "Execution interrupted"
          e$last_expression <- expression_text
          e$last_error_call <- ""
          e$last_trace <- character()
          structure(list(value = NULL, visible = FALSE), class = "webrstudio_error")
        }
      )
      if (inherits(evaluated, "webrstudio_error")) break
      value <- evaluated$value
      if (isTRUE(auto_print) && isTRUE(evaluated$visible)) print(value)
    }
    invisible(value)
  }
  e$source <- function(path, echo = FALSE, chdir = TRUE, encoding = "UTF-8") {
    path <- normalizePath(as.character(path)[1L], mustWork = TRUE)
    source_lines <- readLines(path, warn = FALSE, encoding = encoding)
    source_code <- paste(source_lines, collapse = "\\n")
    working_directory <- if (isTRUE(chdir)) dirname(path) else NULL
    e$eval(
      source_code,
      echo = isTRUE(echo),
      auto_print = isTRUE(echo),
      working_directory = working_directory
    )
  }
  e$finish_run <- function(token) {
    # A stdout sentinel with a newline forces any final partial line from cat()
    # into the stream. JavaScript removes the sentinel while preserving the
    # user text that immediately precedes it.
    cat(sprintf("<<WEBRSTUDIO:FLUSH>>%s\\n", token), file = stdout())
    flush.console()
    cat(sprintf("<<WEBRSTUDIO:DONE>>%s\\n", token), file = stderr())
    flush(stderr())
  }
  e$run_eval <- function(code, plot_width = NULL, plot_height = NULL, token = "") {
    token <- gsub("[^A-Za-z0-9_-]", "", as.character(token)[1L])
    cat(sprintf("<<WEBRSTUDIO:START>>%s\\n", token), file = stderr())
    on.exit(e$finish_run(token), add = TRUE)
    e$eval(code, plot_width = plot_width, plot_height = plot_height)
  }
  e$run_eval_file <- function(path, plot_width = NULL, plot_height = NULL, token = "") {
    path <- normalizePath(as.character(path)[1L], mustWork = TRUE)
    on.exit(try(unlink(path), silent = TRUE), add = TRUE)
    source_lines <- readLines(path, warn = FALSE, encoding = "UTF-8")
    source_code <- paste(source_lines, collapse = "\n")
    e$run_eval(source_code, plot_width = plot_width, plot_height = plot_height, token = token)
  }
  e$run_source <- function(path, echo = FALSE, token = "") {
    token <- gsub("[^A-Za-z0-9_-]", "", as.character(token)[1L])
    cat(sprintf("<<WEBRSTUDIO:START>>%s\\n", token), file = stderr())
    on.exit(e$finish_run(token), add = TRUE)
    e$source(path, echo = echo, chdir = TRUE, encoding = "UTF-8")
  }
})`;
    await this.webR.evalRVoid(helperCode);
  }

  startOutputPump() {
    if (!this.webR || this.outputPump) return this.outputPump;
    const webR = this.webR;
    const generation = ++this.outputPumpGeneration;
    this.replAtPrompt = false;
    this.outputPump = (async () => {
      try {
        for (;;) {
          const first = await webR.read();
          if (generation !== this.outputPumpGeneration || webR !== this.webR) break;
          const messages = [first];
          if (first?.type !== 'closed' && typeof webR.flush === 'function') {
            try {
              const queued = await webR.flush();
              if (Array.isArray(queued)) messages.push(...queued);
            } catch { /* The channel may be closing. */ }
          }
          // Inspect control messages before rendering ordinary output. A fast
          // expression can finish while thousands of stdout messages are still
          // queued on the main thread. Recognising DONE and the prompt first
          // prevents Stop from interrupting the next R request by mistake.
          this.preflightOutputMessages(messages);
          for (let index = 0; index < messages.length; index += 1) {
            if (generation !== this.outputPumpGeneration || webR !== this.webR) break;
            const message = messages[index];
            this.handleOutputMessage(message);
            if (message?.type === 'closed') return;
            // Keep this drain atomic with respect to UI click handlers. The
            // renderer is already frame-batched, so processing the complete
            // queue here is cheap and prevents a Stop click from overtaking a
            // DONE marker that is waiting later in the same output batch.
          }
        }
      } catch (error) {
        if (generation === this.outputPumpGeneration && webR === this.webR) {
          this.abortReplOperation(error);
          console.warn('webR output stream stopped:', error);
        }
      } finally {
        if (generation === this.outputPumpGeneration) this.outputPump = null;
      }
    })();
    return this.outputPump;
  }

  preflightOutputMessages(messages = []) {
    const operation = this.replOperation;
    if (!operation || operation.settled) return;

    // Preview control-message order without mutating the operation itself.
    // handleOutputMessage() will apply the same messages in their real order.
    // Keeping preview and committed state separate is essential when a stale
    // prompt from the previous command and this command's START marker are
    // returned by the same flush() call: that old prompt must never count as
    // the prompt that completes the new command.
    let started = operation.started;
    let done = operation.done;
    let flushed = operation.flushed;
    let prompt = operation.prompt;
    let phase = this.executionPhase;

    for (const message of messages) {
      const type = String(message?.type || '');
      if (type === 'prompt') {
        const primaryPrompt = String(message.data || '').trimStart().startsWith('>');
        if (primaryPrompt && started) {
          prompt = true;
          if (done || flushed) phase = 'finalizing';
        }
        continue;
      }
      if (type !== 'stdout' && type !== 'stderr') continue;
      const raw = stripTerminalControlSequences(String(message.data ?? ''));
      if (raw.includes(`<<WEBRSTUDIO:FLUSH>>${operation.token}`)) flushed = true;
      const signal = raw.trim().match(/^<<WEBRSTUDIO:(START|DONE)>>([A-Za-z0-9_-]+)$/);
      if (!signal || signal[2] !== operation.token) continue;
      if (signal[1] === 'START') {
        started = true;
        prompt = false;
        phase = 'evaluating';
      } else {
        done = true;
        phase = 'finalizing';
      }
    }

    if (started && (done || (prompt && flushed))) phase = 'finalizing';
    if (phase !== this.executionPhase) this.setExecutionPhase(phase, operation.operationName);
  }

  handleOutputMessage(message = {}) {
    const type = String(message.type || '');
    if (type === 'prompt') {
      this.replAtPrompt = String(message.data || '').trimStart().startsWith('>');
      if (this.replAtPrompt) {
        for (const waiter of [...this.promptWaiters]) waiter.resolve();
        this.promptWaiters.clear();
        const operation = this.replOperation;
        if (operation) {
          if (operation.started) operation.prompt = true;
          if (operation.started) this.setExecutionPhase('finalizing', operation.operationName);
          this.maybeFinishReplOperation(operation);
        }
      }
      return;
    }

    if (type === 'closed') {
      this.replAtPrompt = false;
      this.abortReplOperation(new Error('The webR worker closed while R was running.'));
      for (const waiter of [...this.promptWaiters]) waiter.reject(new Error('The webR worker closed before an R prompt became available.'));
      this.promptWaiters.clear();
      return;
    }

    const operation = this.replOperation;
    if (!operation || (type !== 'stdout' && type !== 'stderr')) return;
    this.replAtPrompt = false;
    let raw = stripTerminalControlSequences(String(message.data ?? ''));
    const flushMarker = `<<WEBRSTUDIO:FLUSH>>${operation.token}`;
    if (raw.includes(flushMarker)) {
      operation.flushed = true;
      raw = raw.split(flushMarker).join('');
      if (/^(?:\r?\n)*$/.test(raw)) raw = '';
    }
    const signal = raw.trim().match(/^<<WEBRSTUDIO:(START|DONE)>>([A-Za-z0-9_-]+)$/);
    if (signal && signal[2] === operation.token) {
      if (signal[1] === 'START') {
        operation.started = true;
        operation.prompt = false;
        this.setExecutionPhase('evaluating', operation.operationName);
      }
      else {
        operation.done = true;
        this.setExecutionPhase('finalizing', operation.operationName);
      }
      this.maybeFinishReplOperation(operation);
      return;
    }

    for (const item of raw ? parseCapturedOutput([{ type, data: raw }]) : []) {
      if (operation.interruptRequested && isInterruptLikeError(item.text)) {
        operation.interruptObserved = true;
        // webR can report its internal long-jump wording when an interrupt
        // lands at an evaluation boundary. Do not expose that implementation
        // detail as an R error in the console.
        if (item.type === 'error' || item.type === 'stderr') continue;
      }
      this.enqueueReplOutput(operation, item);
    }
    this.maybeFinishReplOperation(operation);
  }

  enqueueReplOutput(operation, item = {}) {
    if (!operation || operation.settled || operation !== this.replOperation) return;
    const type = String(item.type || 'stdout');
    const text = String(item.text ?? '');
    const coalescible = type === 'stdout' || type === 'stderr';
    const previous = operation.outputQueue.at(-1);
    if (coalescible && previous?.type === type && previous.parts) {
      previous.parts.push(text);
    } else if (coalescible) {
      operation.outputQueue.push({ type, parts: [text] });
    } else {
      operation.outputQueue.push({ type, text });
    }
    this.scheduleReplOutput(operation);
  }

  scheduleReplOutput(operation) {
    if (
      !operation || operation.settled || operation !== this.replOperation ||
      operation.outputFrame || operation.outputTask
    ) return;
    operation.outputFrame = scheduleOutputFrame(() => {
      operation.outputFrame = null;
      if (operation.settled || operation !== this.replOperation) return;
      operation.outputTask = this.drainReplOutput(operation)
        .catch(error => console.warn('Could not render streamed R output:', error))
        .finally(() => {
          operation.outputTask = null;
          if (operation.settled || operation !== this.replOperation) return;
          if (operation.outputQueue.length) this.scheduleReplOutput(operation);
          else this.maybeFinishReplOperation(operation);
        });
    });
  }

  async drainReplOutput(operation) {
    while (!operation.settled && operation === this.replOperation && operation.outputQueue.length) {
      const pending = operation.outputQueue.splice(0);
      for (const record of pending) {
        const item = record.parts
          ? { type: record.type, text: record.parts.join('\n') }
          : { type: record.type, text: record.text };
        try {
          await operation.onOutput(item);
        } catch (error) {
          // Console rendering must never break the worker output pump. Keep R
          // running and surface the rendering problem in the browser console.
          console.warn('Could not render streamed R output:', error);
        }
      }
    }
  }

  maybeFinishReplOperation(operation = this.replOperation) {
    if (!operation || operation !== this.replOperation || operation.settled) return false;
    if (!(operation.started && operation.done && operation.flushed && operation.prompt)) return false;
    if (operation.outputQueue.length || operation.outputFrame || operation.outputTask) return false;
    operation.finish();
    return true;
  }

  waitForPrompt(timeoutMs = 1500) {
    if (this.replAtPrompt) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          globalThis.clearTimeout(waiter.timer);
          this.promptWaiters.delete(waiter);
          resolve();
        },
        reject: error => {
          globalThis.clearTimeout(waiter.timer);
          this.promptWaiters.delete(waiter);
          reject(error);
        },
        timer: 0
      };
      waiter.timer = globalThis.setTimeout(
        () => waiter.reject(new Error('The interactive R prompt did not become available in time.')),
        timeoutMs
      );
      this.promptWaiters.add(waiter);
    });
  }

  async runReplCommand(command, { token, onOutput = async () => {}, operationName = 'repl' } = {}) {
    this.assertReady();
    if (this.replOperation) throw new Error('Another interactive R command is already running.');
    // A stale API request may briefly delay the REPL prompt. Waiting is best
    // effort: stdin is queued safely even if the prompt arrives just after the
    // timeout, and the START marker prevents an old prompt completing the run.
    await this.waitForPrompt().catch(() => {});
    const operationToken = String(token || `operation_${Date.now()}_${Math.random().toString(36).slice(2)}`)
      .replace(/[^A-Za-z0-9_-]/g, '');

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        operation.settled = true;
        globalThis.clearTimeout(timeout);
        if (error) {
          cancelOutputFrame(operation.outputFrame);
          operation.outputFrame = null;
          operation.outputQueue.length = 0;
        }
        if (this.replOperation === operation) this.replOperation = null;
        const summary = {
          token: operation.token,
          started: operation.started,
          done: operation.done,
          prompt: operation.prompt,
          interruptRequested: operation.interruptRequested,
          interruptObserved: operation.interruptObserved
        };
        if (error) reject(error); else resolve(summary);
      };
      const operation = {
        token: operationToken,
        operationName,
        onOutput,
        started: false,
        done: false,
        flushed: false,
        prompt: false,
        interruptRequested: false,
        interruptObserved: false,
        interruptRequestedAt: 0,
        outputQueue: [],
        outputFrame: null,
        outputTask: null,
        settled: false,
        finish
      };
      const timeout = globalThis.setTimeout(
        () => finish(new Error('The R command did not return control to the console.')),
        24 * 60 * 60 * 1000
      );
      this.replOperation = operation;
      this.replAtPrompt = false;
      try {
        this.webR.writeConsole(command);
      } catch (error) {
        finish(error);
      }
    });
  }

  abortReplOperation(error = new Error('The interactive R operation was cancelled.')) {
    this.replOperation?.finish(error);
    this.replOperation = null;
  }

  stopOutputPump(error = new Error('The webR output stream was stopped.')) {
    this.outputPumpGeneration += 1;
    this.abortReplOperation(error);
    for (const waiter of [...this.promptWaiters]) waiter.reject(error);
    this.promptWaiters.clear();
    this.outputPump = null;
    this.replAtPrompt = false;
    this.executionPhase = 'idle';
  }

  async ensureDirectory(path) {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const segments = normalized.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current += `/${segment}`;
      try { await this.webR.FS.mkdir(current); } catch { /* Existing directories are expected. */ }
    }
  }

  async mirrorFile(path, content) {
    this.assertReady();
    const normalized = normalizePath(path);
    const target = `/project/${normalized}`;
    await this.ensureDirectory(dirname(target));
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
    await this.webR.FS.writeFile(target, bytes);
    return target;
  }

  async removeMirroredFile(path) {
    if (!this.ready) return;
    try { await this.webR.FS.unlink(`/project/${normalizePath(path)}`); } catch { /* File may not be mirrored yet. */ }
  }

  async clearMirroredFiles() {
    this.assertIdle('Project file replacement');
    await this.webR.evalRVoid('unlink("/project", recursive = TRUE, force = TRUE); dir.create("/project", recursive = TRUE, showWarnings = FALSE)');
  }

  async mirrorFiles(files, onProgress = () => {}) {
    if (!this.ready) return;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      await this.mirrorFile(file.path, file.content);
      onProgress(index + 1, files.length, file.path);
    }
  }

  async listVirtualFiles(directory = '/project') {
    this.assertIdle('Runtime file browsing');
    const path = normalizeVirtualPath(directory);
    const records = await this.evalStringArray(`local({
      path <- ${rString(path)}
      if (!dir.exists(path)) stop(sprintf("Directory does not exist: %s", path), call. = FALSE)
      names_ <- list.files(path, all.files = TRUE, full.names = FALSE, no.. = TRUE)
      if (!length(names_)) character() else {
        full <- file.path(path, names_)
        info <- file.info(full)
        is_dir <- !is.na(info$isdir) & info$isdir
        order_ <- order(!is_dir, tolower(names_), names_)
        sep <- intToUtf8(31)
        enc <- function(x) utils::URLencode(enc2utf8(as.character(x)), reserved = TRUE)
        vapply(order_, function(index) {
          values <- c(
            names_[index],
            full[index],
            is_dir[index],
            if (is_dir[index] || is.na(info$size[index])) 0 else info$size[index],
            if (is.na(info$mtime[index])) 0 else as.numeric(info$mtime[index])
          )
          paste(vapply(values, enc, character(1)), collapse = sep)
        }, character(1))
      }
    })`);
    return {
      path,
      entries: parseDelimitedRecords(records).map(fields => ({
        name: fields[0],
        path: normalizeVirtualPath(fields[1]),
        isDirectory: fields[2] === 'TRUE',
        size: Number(fields[3]) || 0,
        modifiedAt: (Number(fields[4]) || 0) * 1000
      }))
    };
  }

  async readVirtualFile(path) {
    this.assertIdle('Runtime file download');
    const target = normalizeVirtualPath(path);
    return new Uint8Array(await this.webR.FS.readFile(target));
  }

  async readLastRunState({ attempts = 4 } = {}) {
    let boundaryInterrupt = false;
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const state = await this.webR.evalRString(
          'paste(as.integer(c(isTRUE(.webrStudio$last_interrupted), isTRUE(.webrStudio$last_ok))), collapse = "|")'
        );
        const [interrupted = '0', ok = '0'] = String(state).split('|');
        return { interrupted: interrupted === '1', ok: ok === '1', boundaryInterrupt };
      } catch (error) {
        lastError = error;
        if (!isInterruptLikeError(error)) throw error;
        // An interrupt can race with the tiny interval after user evaluation
        // has completed. In that case it is consumed by this first inspection
        // request. Retry against the same worker and report it as late instead
        // of mislabelling a completed expression as interrupted.
        boundaryInterrupt = true;
        await new Promise(resolve => globalThis.setTimeout(resolve, 0));
      }
    }
    throw lastError || new Error('Could not inspect the completed R expression.');
  }

  async execute(code, { capturePlots = true, plotWidth = null, plotHeight = null, onOutput = null } = {}) {
    this.assertReady();
    const source = normalizeRSource(code);
    if (!source.trim()) return { ok: true, outputs: [], plots: [], traceback: [], elapsed: 0, streamed: false };
    if (this.running) throw new Error('The webR runtime is busy with another expression');
    const token = `execute_${Date.now()}_${Math.random().toString(36).slice(2)}`.replace(/[^A-Za-z0-9_-]/g, '');
    const commandPath = `/tmp/webrstudio-input-${token}.R`;
    const outputs = [];
    let errorMessage = '';
    const deliver = async item => {
      if (item.type === 'error') errorMessage = item.text;
      if (typeof onOutput === 'function') await onOutput(item);
      else appendOutputItem(outputs, item);
    };
    this.running = true;
    this.executionPhase = 'preparing';
    this.emit('state', { state: 'running', operation: 'execute', phase: this.executionPhase });
    const started = performance.now();
    let cancelled = false;
    try {
      if (capturePlots) {
        await this.webR.evalRVoid(`unlink(list.files("/tmp", pattern = "^webrstudio-plot-.*[.]svg$", full.names = TRUE))`);
      }
      await this.webR.FS.writeFile(commandPath, new TextEncoder().encode(source));
      const width = Number(plotWidth);
      const height = Number(plotHeight);
      const rPlotWidth = Number.isFinite(width) && width > 0 ? String(width) : 'NULL';
      const rPlotHeight = Number.isFinite(height) && height > 0 ? String(height) : 'NULL';
      const command = `.webrStudio$run_eval_file(${rString(commandPath)}, plot_width = ${rPlotWidth}, plot_height = ${rPlotHeight}, token = ${rString(token)})`;
      const replSummary = await this.runReplCommand(command, {
        token,
        onOutput: deliver,
        operationName: 'execute'
      });
      this.setExecutionPhase('finalizing', 'execute');
      const runState = await this.readLastRunState();
      const interrupted = runState.interrupted;
      const interruptLate = Boolean(replSummary.interruptRequested && !interrupted && runState.boundaryInterrupt);
      const ok = interrupted ? false : runState.ok;
      const [traceback, expression, errorCall] = ok || interrupted ? [[], '', ''] : await Promise.all([
        this.evalStringArray('if (length(.webrStudio$last_trace)) .webrStudio$last_trace else character()'),
        this.webR.evalRString('.webrStudio$last_expression'),
        this.webR.evalRString('.webrStudio$last_error_call')
      ]);
      const plots = capturePlots ? await this.collectSvgPlots() : [];
      return {
        ok,
        interrupted,
        interruptLate,
        outputs,
        plots,
        traceback: this.cleanTraceback(traceback, expression, errorCall),
        error: interrupted
          ? 'Execution interrupted.'
          : errorMessage || (ok ? '' : await this.webR.evalRString('.webrStudio$last_error')),
        elapsed: performance.now() - started,
        streamed: typeof onOutput === 'function'
      };
    } catch (error) {
      if (isRuntimeCancellation(error) || this.restarting) {
        cancelled = true;
        return {
          ok: false,
          cancelled: true,
          outputs,
          plots: [],
          traceback: [],
          error: 'Execution stopped.',
          elapsed: performance.now() - started,
          streamed: typeof onOutput === 'function'
        };
      }
      const message = error?.message || String(error);
      let interrupted = false;
      let interruptLate = false;
      let recoveredOk = false;
      if (this.lastInterruptResult.ok && isInterruptLikeError(error) && this.webR) {
        try {
          const runState = await this.readLastRunState();
          interrupted = runState.interrupted;
          interruptLate = !interrupted;
          recoveredOk = runState.ok;
        } catch { /* Fall through to the original worker error. */ }
      }
      if (!interrupted && !interruptLate) {
        await deliver({ type: 'error', text: message });
      }
      return {
        ok: interruptLate && recoveredOk,
        interrupted,
        interruptLate,
        outputs,
        plots: [],
        traceback: [],
        error: interrupted ? 'Execution interrupted.' : interruptLate ? '' : message,
        elapsed: performance.now() - started,
        streamed: typeof onOutput === 'function'
      };
    } finally {
      try { await this.webR?.FS.unlink(commandPath); } catch { /* The R helper normally removes it. */ }
      this.running = false;
      this.executionPhase = 'idle';
      this.lastInterruptResult = { ok: false, reason: 'not-running' };
      if (!cancelled && !this.restarting) {
        this.emit('state', { state: this.ready ? 'ready' : 'stopped', operation: 'execute', phase: this.executionPhase });
      }
    }
  }


  async sourceFile(path, { echo = false, onOutput = null } = {}) {
    this.assertReady();
    const normalized = normalizePath(path);
    if (!normalized || !/\.r$/i.test(normalized)) throw new Error('Open an R script before sourcing.');
    if (this.running) throw new Error('The webR runtime is busy with another expression');

    const target = `/project/${normalized}`;
    const echoValue = echo ? 'TRUE' : 'FALSE';
    const token = `source_${Date.now()}_${Math.random().toString(36).slice(2)}`.replace(/[^A-Za-z0-9_-]/g, '');
    const outputs = [];
    let errorMessage = '';
    const deliver = async item => {
      if (item.type === 'error') errorMessage = item.text;
      if (typeof onOutput === 'function') await onOutput(item);
      else appendOutputItem(outputs, item);
    };

    this.running = true;
    this.executionPhase = 'preparing';
    this.emit('state', { state: 'running', operation: echo ? 'source-echo' : 'source', phase: this.executionPhase });
    const started = performance.now();
    let cancelled = false;
    try {
      await this.webR.evalRVoid('unlink(list.files("/tmp", pattern = "^webrstudio-plot-.*[.]svg$", full.names = TRUE))');
      const command = `.webrStudio$run_source(${rString(target)}, ${echoValue}, ${rString(token)})`;
      const replSummary = await this.runReplCommand(command, {
        token,
        onOutput: deliver,
        operationName: echo ? 'source-echo' : 'source'
      });
      this.setExecutionPhase('finalizing', echo ? 'source-echo' : 'source');
      const runState = await this.readLastRunState();
      const interrupted = runState.interrupted;
      const interruptLate = Boolean(replSummary.interruptRequested && !interrupted && runState.boundaryInterrupt);
      const ok = interrupted ? false : runState.ok;
      const [traceback, expression, errorCall] = ok || interrupted ? [[], '', ''] : await Promise.all([
        this.evalStringArray('if (length(.webrStudio$last_trace)) .webrStudio$last_trace else character()'),
        this.webR.evalRString('.webrStudio$last_expression'),
        this.webR.evalRString('.webrStudio$last_error_call')
      ]);
      const plots = await this.collectSvgPlots();
      return {
        ok,
        interrupted,
        interruptLate,
        outputs,
        plots,
        traceback: this.cleanTraceback(traceback, expression, errorCall),
        error: interrupted
          ? 'Execution interrupted.'
          : errorMessage || (ok ? '' : await this.webR.evalRString('.webrStudio$last_error')),
        elapsed: performance.now() - started,
        streamed: typeof onOutput === 'function'
      };
    } catch (error) {
      if (isRuntimeCancellation(error) || this.restarting) {
        cancelled = true;
        return {
          ok: false,
          cancelled: true,
          outputs,
          plots: [],
          traceback: [],
          error: 'Execution stopped.',
          elapsed: performance.now() - started,
          streamed: typeof onOutput === 'function'
        };
      }
      const message = error?.message || String(error);
      let interrupted = false;
      let interruptLate = false;
      let recoveredOk = false;
      if (this.lastInterruptResult.ok && isInterruptLikeError(error) && this.webR) {
        try {
          const runState = await this.readLastRunState();
          interrupted = runState.interrupted;
          interruptLate = !interrupted;
          recoveredOk = runState.ok;
        } catch { /* Fall through to the original worker error. */ }
      }
      if (!interrupted && !interruptLate) await deliver({ type: 'error', text: message });
      return {
        ok: interruptLate && recoveredOk,
        interrupted,
        interruptLate,
        outputs,
        plots: [],
        traceback: [],
        error: interrupted ? 'Execution interrupted.' : interruptLate ? '' : message,
        elapsed: performance.now() - started,
        streamed: typeof onOutput === 'function'
      };
    } finally {
      this.running = false;
      this.executionPhase = 'idle';
      this.lastInterruptResult = { ok: false, reason: 'not-running' };
      if (!cancelled && !this.restarting) {
        this.emit('state', { state: this.ready ? 'ready' : 'stopped', operation: echo ? 'source-echo' : 'source', phase: this.executionPhase });
      }
    }
  }


  async evaluateInline(code) {
    this.assertReady();
    const source = String(code || '').trim();
    if (!source) return '';
    if (this.running) throw new Error('The webR runtime is busy with another expression');
    this.running = true;
    this.emit('state', { state: 'running', operation: 'inline-r' });
    try {
      const expression = `(function() {
        devices_before <- grDevices::dev.list()
        on.exit({
          devices_after <- grDevices::dev.list()
          before_ids <- if (is.null(devices_before)) integer() else unname(devices_before)
          after_ids <- if (is.null(devices_after)) integer() else unname(devices_after)
          for (device_id in rev(setdiff(after_ids, before_ids))) {
            try(grDevices::dev.off(which = device_id), silent = TRUE)
          }
        }, add = TRUE)
        expressions <- parse(text = ${rString(source)}, keep.source = FALSE)
        value <- NULL
        for (item in expressions) value <- eval(item, envir = .GlobalEnv)
        if (is.null(value) || length(value) == 0L) return("")
        if (is.atomic(value) && is.null(dim(value))) {
          formatted <- as.character(value)
          formatted[is.na(formatted)] <- "NA"
          return(paste(formatted, collapse = ", "))
        }
        paste(capture.output(print(value)), collapse = "\\n")
      })()`;
      return String(await this.webR.evalRString(expression));
    } finally {
      this.running = false;
      this.emit('state', { state: this.ready ? 'ready' : 'stopped', operation: 'inline-r' });
    }
  }

  cleanTraceback(traceback, expression = '', errorCall = '') {
    const internalFrame = line => (
      line.includes('.webrStudio$eval') ||
      /^\(?function\s*\(condition\)/.test(line) ||
      /^withCallingHandlers\(/.test(line) ||
      /^withVisible\(eval\(expressions/.test(line) ||
      /^eval\(expressions\[\[index\]\]/.test(line) ||
      /^tryCatch\(withCallingHandlers/.test(line) ||
      /^tryCatchList\(/.test(line) ||
      /^tryCatchOne\(/.test(line) ||
      /^doTryCatch\(/.test(line) ||
      /^eval\(expr,\s*(?:env|envir)\)/.test(line) ||
      /^eval\(expr,\s*envir,\s*enclos\)/.test(line) ||
      /^eval\(e,\s*x,\s*parent\.frame\(\)\)/.test(line) ||
      /^value\[\[3L?\]\]\(cond\)/.test(line) ||
      /^efun\(expr\)/.test(line) ||
      /^h\(simpleError\(/.test(line) ||
      /^\.handleSimpleError\(/.test(line)
    );
    const calls = traceback
      .map(line => String(line).trim())
      .filter(Boolean)
      .filter(line => !internalFrame(line))
      .filter((line, index, values) => index === 0 || line !== values[index - 1])
      .slice(-14);
    const lines = [];
    const normalizedExpression = String(expression || '').trim();
    const rawErrorCall = String(errorCall || '').trim();
    const normalizedCall = rawErrorCall && !internalFrame(rawErrorCall) ? rawErrorCall : '';
    if (normalizedExpression) lines.push(`Expression: ${normalizedExpression}`);
    const failingCall = normalizedCall || calls.at(-1) || '';
    if (failingCall && failingCall !== normalizedExpression) lines.push(`Failing call: ${failingCall}`);
    if (calls.length) {
      lines.push('Call stack:');
      calls.forEach((call, index) => lines.push(`${index + 1}. ${call}`));
    }
    return lines;
  }

  async collectSvgPlots() {
    const paths = await this.evalStringArray(`sort(list.files("/tmp", pattern = "^webrstudio-plot-.*[.]svg$", full.names = TRUE))`);
    const plots = [];
    for (const path of paths) {
      try {
        const bytes = await this.webR.FS.readFile(path);
        const svg = new TextDecoder().decode(bytes);
        if (svg.includes('<svg')) plots.push({ id: `${this.generation}:${path}`, path, svg, createdAt: Date.now() });
      } catch { /* A partially written plot is ignored. */ }
    }
    return plots;
  }

  async replayLastPlot() {
    this.assertReady();
    if (this.running) return null;
    const available = await this.webR.evalRBoolean(
      'exists("last_plot", envir = .webrStudio, inherits = FALSE) && inherits(.webrStudio$last_plot, "recordedplot")'
    );
    if (!available) return null;
    this.running = true;
    this.emit('state', { state: 'running', operation: 'plot-reflow' });
    try {
      await this.webR.evalRVoid('unlink(list.files("/tmp", pattern = "^webrstudio-plot-.*[.]svg$", full.names = TRUE))');
      await this.webR.evalRVoid(`local({
        .webrStudio$device()
        on.exit(try(grDevices::dev.off(), silent = TRUE), add = TRUE)
        grDevices::replayPlot(.webrStudio$last_plot)
      })`);
      const plots = await this.collectSvgPlots();
      return plots.at(-1) || null;
    } finally {
      this.running = false;
      this.emit('state', { state: this.ready ? 'ready' : 'stopped', operation: 'plot-reflow' });
    }
  }

  requestInterrupt() {
    let result;
    const operation = this.replOperation;
    if (!this.webR || !this.running) {
      result = { ok: false, reason: 'not-running' };
    } else if (!this.interruptSupported) {
      result = { ok: false, reason: 'unsupported' };
    } else if (this.executionPhase !== 'evaluating' || !operation) {
      result = { ok: false, reason: this.executionPhase === 'preparing' ? 'preparing' : 'finishing' };
    } else if (!operation.started) {
      result = { ok: false, reason: 'preparing' };
    } else if (operation.done || operation.prompt) {
      result = { ok: false, reason: 'finishing' };
    } else if (operation.interruptRequested) {
      result = { ok: true, reason: 'already-requested' };
    } else {
      operation.interruptRequested = true;
      operation.interruptRequestedAt = performance.now();
      try {
        this.webR.interrupt();
        result = { ok: true, reason: 'requested' };
      } catch (error) {
        operation.interruptRequested = false;
        operation.interruptRequestedAt = 0;
        result = { ok: false, reason: 'failed', error };
      }
    }
    this.lastInterruptResult = result;
    return result;
  }

  interrupt() {
    return this.requestInterrupt().ok;
  }

  setRequestedVersion(version = WEBR_VERSION) {
    this.requestedVersion = normalizeWebRVersion(version);
    this.baseUrl = webRBaseUrl(this.requestedVersion);
    this.moduleUrl = webRModuleUrl(this.requestedVersion);
    return this.requestedVersion;
  }

  async restart(options = {}) {
    this.restarting = true;
    this.emit('state', { state: 'restarting' });
    const previousRuntime = this.webR;
    this.webR = null;
    this.ready = false;
    this.interruptSupported = false;
    this.stopOutputPump(runtimeCancellationError());
    try {
      try { await previousRuntime?.close(); } catch { /* A terminated worker may already be closed. */ }
      this.running = false;
      this.starting = false;
      return await this.initialize(options);
    } finally {
      this.restarting = false;
    }
  }

  async close() {
    this.stopOutputPump(new Error('The webR runtime was closed.'));
    try { await this.webR?.close(); } finally {
      this.webR = null;
      this.ready = false;
      this.running = false;
      this.interruptSupported = false;
    }
  }

  async setPlotSize(width, height) {
    this.plotWidth = Number(width) || 7;
    this.plotHeight = Number(height) || 5;
    if (!this.ready && !this.webR) return;
    await this.webR.evalRVoid(`.webrStudio$plot_width <- ${this.plotWidth}; .webrStudio$plot_height <- ${this.plotHeight}`);
  }

  async parseDiagnostic(code) {
    if (!this.ready || !String(code).trim()) return null;
    const result = await this.webR.evalRString(`tryCatch({ parse(text = ${rString(code)}, keep.source = TRUE); "" }, error = function(e) conditionMessage(e))`);
    if (!result) return null;
    const location = result.match(/<text>:(\d+):(\d+)/);
    return {
      severity: 'error',
      message: result.replace(/^<text>:\d+:\d+:\s*/, ''),
      row: location ? Math.max(0, Number(location[1]) - 1) : 0,
      column: location ? Math.max(0, Number(location[2]) - 1) : 0,
      source: 'R parser'
    };
  }

  async getCompletions(prefix = '', context = '') {
    if (!this.ready || this.running) return [];
    const safePrefix = String(prefix).replace(/[^A-Za-z0-9._]/g, '');
    let expression;
    const member = String(context).match(/([A-Za-z.][A-Za-z0-9._]*)\$([A-Za-z0-9._]*)$/);
    const namespace = String(context).match(/([A-Za-z.][A-Za-z0-9._]*):::{0,1}([A-Za-z0-9._]*)$/);
    if (member) {
      expression = `local({ obj <- tryCatch(get(${rString(member[1])}, envir = .GlobalEnv), error = function(e) NULL); if (is.null(obj)) character() else sort(unique(names(obj)[startsWith(names(obj), ${rString(member[2])})])) })`;
    } else if (namespace) {
      expression = `local({ pkg <- ${rString(namespace[1])}; if (!requireNamespace(pkg, quietly = TRUE)) character() else { n <- getNamespaceExports(pkg); sort(unique(n[startsWith(n, ${rString(namespace[2])})])) } })`;
    } else {
      expression = `local({ p <- ${rString(safePrefix)}; pool <- unique(c(ls(envir = .GlobalEnv, all.names = TRUE), ls("package:base"), ls("package:stats"), ls("package:utils"), ls("package:graphics"), ls("package:grDevices"), apropos(p, mode = "any"))); sort(pool[startsWith(pool, p)])[seq_len(min(250L, sum(startsWith(pool, p))))] })`;
    }
    try { return await this.evalStringArray(expression); } catch { return []; }
  }

  async getEnvironment() {
    this.assertIdle('Environment inspection');
    const records = await this.evalStringArray(`local({
      sep <- intToUtf8(31)
      enc <- function(x) utils::URLencode(enc2utf8(as.character(x)), reserved = TRUE)
      names_ <- sort(ls(envir = .GlobalEnv, all.names = TRUE))
      names_ <- setdiff(names_, ".webrStudio")
      if ("View" %in% names_ && identical(get("View", envir = .GlobalEnv), .webrStudio$View)) names_ <- setdiff(names_, "View")
      names_ <- names_[!startsWith(names_, ".__webRStudio_")]
      records <- lapply(names_, function(name) {
        tryCatch({
          object <- get(name, envir = .GlobalEnv, inherits = FALSE)
          class_ <- paste(class(object), collapse = ", ")
          type_ <- typeof(object)
          is_data <- is.data.frame(object) || is.matrix(object)
          is_function <- is.function(object)
          dimensions <- if (is_data || !is.null(dim(object))) {
            paste(dim(object), collapse = " × ")
          } else if (length(object) != 1L) {
            paste0("length ", length(object))
          } else ""
          preview <- tryCatch({
            text <- paste(capture.output(str(object, max.level = 1L, give.attr = FALSE, vec.len = 4L)), collapse = " ")
            substr(gsub("[\\r\\n\\t]+", " ", text), 1L, 220L)
          }, error = function(condition) paste("Preview unavailable:", conditionMessage(condition)))
          size <- tryCatch(as.numeric(object.size(object)), error = function(condition) 0)
          values <- c(name, class_, type_, size, dimensions, preview, is_data, is_function)
          paste(vapply(values, enc, character(1)), collapse = sep)
        }, error = function(condition) {
          values <- c(name, "<unavailable>", "unknown", 0, "", paste("Inspection failed:", conditionMessage(condition)), FALSE, FALSE)
          paste(vapply(values, enc, character(1)), collapse = sep)
        })
      })
      unlist(records, use.names = FALSE)
    })`);
    return parseDelimitedRecords(records).map(fields => ({
      name: fields[0],
      className: fields[1],
      type: fields[2],
      size: Number(fields[3]) || 0,
      dimensions: fields[4],
      preview: fields[5],
      isData: fields[6] === 'TRUE',
      isFunction: fields[7] === 'TRUE'
    }));
  }

  async removeObject(name) {
    this.assertIdle('Object removal');
    await this.webR.evalRVoid(`if (exists(${rString(name)}, envir = .GlobalEnv, inherits = FALSE)) rm(list = ${rString(name)}, envir = .GlobalEnv)`);
  }

  async clearEnvironment() {
    this.assertIdle('Environment cleanup');
    await this.webR.evalRVoid(`local({ keep <- ".webrStudio"; if (exists("View", envir = .GlobalEnv, inherits = FALSE) && identical(get("View", envir = .GlobalEnv), .webrStudio$View)) keep <- c(keep, "View"); rm(list = setdiff(ls(envir = .GlobalEnv, all.names = TRUE), keep), envir = .GlobalEnv); invisible(gc()) })`);
  }

  async getPackages() {
    this.assertIdle('Package inspection');
    const records = await this.evalStringArray(`local({
      sep <- intToUtf8(31)
      enc <- function(x) utils::URLencode(enc2utf8(as.character(x)), reserved = TRUE)
      installed <- installed.packages()
      packages <- sort(rownames(installed))
      loaded <- sub("^package:", "", grep("^package:", search(), value = TRUE))
      vapply(packages, function(package) {
        values <- c(package, installed[package, "Version"], package %in% loaded, installed[package, "Priority"] %in% c("base", "recommended"))
        paste(vapply(values, enc, character(1)), collapse = sep)
      }, character(1))
    })`);
    return parseDelimitedRecords(records).map(fields => ({
      name: fields[0], version: fields[1], loaded: fields[2] === 'TRUE', bundled: fields[3] === 'TRUE'
    }));
  }

  async installPackages(packages) {
    this.assertIdle('Package installation');
    const names = Array.isArray(packages) ? packages : String(packages).split(/[\s,]+/).filter(Boolean);
    if (!names.length) return;
    await this.webR.installPackages(names);
  }

  async setPackageLoaded(packageName, loaded) {
    this.assertIdle('Package loading');
    if (loaded) {
      await this.webR.evalRVoid(`suppressPackageStartupMessages(library(${rString(packageName)}, character.only = TRUE))`);
    } else {
      await this.webR.evalRVoid(`local({ target <- paste0("package:", ${rString(packageName)}); if (target %in% search()) detach(target, unload = TRUE, character.only = TRUE) })`);
    }
  }

  async getHelp(topic, packageName = '') {
    this.assertIdle('R help');
    return this.webR.evalRString(`local({
      topic <- ${rString(topic)}
      package_ <- ${rString(packageName)}
      help_ <- if (nzchar(package_)) {
        suppressWarnings(utils::help(topic, package = package_, try.all.packages = FALSE))
      } else {
        suppressWarnings(utils::help(topic, try.all.packages = TRUE))
      }
      if (!length(help_)) {
        qualifier <- if (nzchar(package_)) sprintf(" in package '%s'", package_) else ""
        stop(sprintf("No R help topic found for '%s'%s.", topic, qualifier))
      }
      rd <- utils:::.getHelpFile(help_[1L])
      resolved_package <- if (nzchar(package_)) package_ else basename(dirname(dirname(help_[1L])))
      output <- tempfile(fileext = ".html")
      tools::Rd2HTML(rd, out = output, package = resolved_package)
      html <- paste(readLines(output, warn = FALSE, encoding = "UTF-8"), collapse = "\\n")
      unlink(output)
      html
    })`);
  }

  async checkpointEnvironment(filename = '/tmp/webrstudio-checkpoint.RData') {
    this.assertIdle('Environment checkpoint');
    await this.webR.evalRVoid(`local({ objects <- setdiff(ls(envir = .GlobalEnv, all.names = TRUE), ".webrStudio"); if ("View" %in% objects && identical(get("View", envir = .GlobalEnv), .webrStudio$View)) objects <- setdiff(objects, "View"); save(list = objects, file = ${rString(filename)}, envir = .GlobalEnv, compress = TRUE) })`);
    return this.webR.FS.readFile(filename);
  }

  async restoreEnvironment(bytes, filename = '/tmp/webrstudio-restore.RData') {
    this.assertIdle('Environment restore');
    await this.webR.FS.writeFile(filename, new Uint8Array(bytes));
    await this.webR.evalRVoid(`local({ load(${rString(filename)}, envir = .GlobalEnv); assign("View", .webrStudio$View, envir = .GlobalEnv) })`);
  }

  async exportEnvironment() {
    return this.checkpointEnvironment('/tmp/webrstudio-export.RData');
  }

  async importEnvironment(bytes) {
    return this.restoreEnvironment(bytes, '/tmp/webrstudio-import.RData');
  }

  async getViewerObjectInfo(name) {
    this.assertIdle('Object inspection');
    const records = await this.evalStringArray(`local({
      object <- .webrStudio$resolve(${rString(name)})
      sep <- intToUtf8(31)
      enc <- function(x) utils::URLencode(enc2utf8(as.character(x)), reserved = TRUE)
      kind <- if (is.data.frame(object) || is.matrix(object)) "data" else if (is.list(object) || is.environment(object) || is.pairlist(object)) "tree" else "value"
      dimensions <- if (!is.null(dim(object))) paste(dim(object), collapse = " × ") else if (length(object) != 1L) paste0("length ", length(object)) else ""
      paste(vapply(c(kind, paste(class(object), collapse = ", "), typeof(object), length(object), dimensions), enc, character(1)), collapse = sep)
    })`);
    const fields = parseDelimitedRecords(records)[0] || ['value', '', '', '0', ''];
    return {
      name,
      kind: fields[0] || 'value',
      className: fields[1] || '',
      type: fields[2] || '',
      length: Number(fields[3]) || 0,
      dimensions: fields[4] || ''
    };
  }

  async getObjectTree(name, { maxDepth = 7, maxNodes = 2500 } = {}) {
    this.assertIdle('List inspection');
    const depthLimit = Math.min(12, Math.max(1, Number(maxDepth) || 7));
    const nodeLimit = Math.min(10000, Math.max(50, Number(maxNodes) || 2500));
    const records = await this.evalStringArray(`local({
      root <- .webrStudio$resolve(${rString(name)})
      sep <- intToUtf8(31)
      enc <- function(x) utils::URLencode(enc2utf8(as.character(x)), reserved = TRUE)
      output <- character()
      count <- 0L
      seen_environments <- character()
      max_depth <- ${depthLimit}L
      max_nodes <- ${nodeLimit}L

      preview <- function(x) tryCatch({
        text <- paste(capture.output(str(x, max.level = 0L, give.attr = FALSE, vec.len = 5L)), collapse = " ")
        substr(gsub("[\\r\\n\\t]+", " ", text), 1L, 260L)
      }, error = function(condition) paste("Preview unavailable:", conditionMessage(condition)))

      child_names <- function(x) {
        if (is.environment(x)) return(sort(ls(envir = x, all.names = TRUE)))
        if (is.list(x) || is.pairlist(x)) {
          labels <- names(x)
          if (is.null(labels)) labels <- rep("", length(x))
          empty <- !nzchar(labels)
          labels[empty] <- sprintf("[[%d]]", which(empty))
          return(labels)
        }
        character()
      }

      child_at <- function(x, label, index) {
        if (is.environment(x)) return(get(label, envir = x, inherits = FALSE))
        x[[index]]
      }

      walk <- function(x, label, id, parent, depth) {
        if (count >= max_nodes) return(invisible(NULL))
        count <<- count + 1L
        container <- is.list(x) || is.environment(x) || is.pairlist(x)
        environment_key <- if (is.environment(x)) format(x) else ""
        cyclic <- is.environment(x) && environment_key %in% seen_environments
        if (is.environment(x) && !cyclic) seen_environments <<- c(seen_environments, environment_key)
        labels <- if (container && !cyclic) tryCatch(child_names(x), error = function(condition) character()) else character()
        child_count <- length(labels)
        expandable <- container && child_count > 0L && depth < max_depth && !cyclic
        dimensions <- if (!is.null(dim(x))) paste(dim(x), collapse = " × ") else if (!container && length(x) != 1L) paste0("length ", length(x)) else ""
        values <- c(
          id, parent, label, depth, typeof(x), paste(class(x), collapse = ", "),
          dimensions, preview(x), child_count, expandable, cyclic
        )
        output <<- c(output, paste(vapply(values, enc, character(1)), collapse = sep))
        if (!expandable) return(invisible(NULL))
        for (index in seq_along(labels)) {
          if (count >= max_nodes) break
          child <- tryCatch(child_at(x, labels[index], index), error = function(condition) structure(conditionMessage(condition), class = "webrstudio_unavailable"))
          walk(child, labels[index], paste0(id, "/", index), id, depth + 1L)
        }
        invisible(NULL)
      }

      walk(root, ${rString(name)}, "root", "", 0L)
      output
    })`);
    return parseDelimitedRecords(records).map(fields => ({
      id: fields[0],
      parent: fields[1],
      label: fields[2],
      depth: Number(fields[3]) || 0,
      type: fields[4],
      className: fields[5],
      dimensions: fields[6],
      preview: fields[7],
      childCount: Number(fields[8]) || 0,
      expandable: fields[9] === 'TRUE',
      cyclic: fields[10] === 'TRUE'
    }));
  }

  async getDataFrameInfo(name) {
    this.assertIdle('Data inspection');
    const records = await this.evalStringArray(`local({
      object <- .webrStudio$resolve(${rString(name)})
      if (is.matrix(object)) object <- as.data.frame(object, stringsAsFactors = FALSE)
      if (!is.data.frame(object)) stop("Object is not a data frame or matrix")
      enc <- function(x) utils::URLencode(enc2utf8(as.character(x)), reserved = TRUE)
      c(
        paste("META", nrow(object), ncol(object), sep = intToUtf8(31)),
        vapply(seq_along(object), function(index) paste("COL", enc(names(object)[index]), enc(paste(class(object[[index]]), collapse = ", ")), typeof(object[[index]]), sep = intToUtf8(31)), character(1))
      )
    })`);
    const parsed = parseDelimitedRecords(records);
    const meta = parsed.find(row => row[0] === 'META') || ['META', '0', '0'];
    return {
      name,
      rows: Number(meta[1]) || 0,
      columns: Number(meta[2]) || 0,
      columnInfo: parsed.filter(row => row[0] === 'COL').map(row => ({ name: row[1], className: row[2], type: row[3] }))
    };
  }

  async getDataFramePage(name, options = {}) {
    this.assertIdle('Data paging');
    const page = Math.max(1, Number(options.page) || 1);
    const pageSize = Math.min(500, Math.max(10, Number(options.pageSize) || 100));
    const globalFilter = String(options.globalFilter || '');
    const sortColumn = String(options.sortColumn || '');
    const sortDirection = options.sortDirection === 'desc' ? 'desc' : 'asc';
    const columnFilters = options.columnFilters || {};
    const filtersR = Object.entries(columnFilters)
      .filter(([, value]) => String(value).length)
      .map(([column, value]) => `if (${rString(column)} %in% names(object)) keep <- keep & grepl(${rString(value)}, as.character(object[[${rString(column)}]]), ignore.case = TRUE, fixed = TRUE)`)
      .join('\n');
    const result = await this.evalStringArray(`local({
      object <- .webrStudio$resolve(${rString(name)})
      if (is.matrix(object)) object <- as.data.frame(object, stringsAsFactors = FALSE)
      if (!is.data.frame(object)) stop("Object is not a data frame or matrix")
      keep <- rep(TRUE, nrow(object))
      global_filter <- ${rString(globalFilter)}
      if (nzchar(global_filter) && nrow(object)) {
        keep <- Reduce("|", lapply(object, function(column) grepl(global_filter, as.character(column), ignore.case = TRUE, fixed = TRUE)))
      }
      ${filtersR}
      indices <- which(keep)
      sort_column <- ${rString(sortColumn)}
      if (nzchar(sort_column) && sort_column %in% names(object) && length(indices)) {
        ordering <- order(object[[sort_column]][indices], na.last = TRUE, decreasing = ${sortDirection === 'desc' ? 'TRUE' : 'FALSE'})
        indices <- indices[ordering]
      }
      filtered_count <- length(indices)
      start <- (${page}L - 1L) * ${pageSize}L + 1L
      stop_ <- min(filtered_count, start + ${pageSize}L - 1L)
      page_indices <- if (start <= stop_ && filtered_count) indices[start:stop_] else integer()
      enc <- function(x) utils::URLencode(enc2utf8(as.character(x)), reserved = TRUE)
      records <- c(paste("META", nrow(object), filtered_count, ${page}, ${pageSize}, sep = intToUtf8(31)))
      if (length(page_indices)) {
        values <- lapply(object, function(column) {
          x <- column[page_indices]
          output <- format(x, trim = TRUE, digits = 12, na.encode = FALSE)
          output[is.na(x)] <- "NA"
          output
        })
        for (row_index in seq_along(page_indices)) {
          row <- vapply(values, function(column) enc(column[row_index]), character(1))
          records <- c(records, paste(c("ROW", page_indices[row_index], row), collapse = intToUtf8(31)))
        }
      }
      records
    })`);
    const records = parseDelimitedRecords(result);
    const meta = records.find(row => row[0] === 'META') || ['META', '0', '0', String(page), String(pageSize)];
    return {
      totalRows: Number(meta[1]) || 0,
      filteredRows: Number(meta[2]) || 0,
      page: Number(meta[3]) || page,
      pageSize: Number(meta[4]) || pageSize,
      rows: records.filter(row => row[0] === 'ROW').map(row => ({ index: Number(row[1]), values: row.slice(2) }))
    };
  }


  async loadDelimitedFile(path, delimiter = ',') {
    this.assertIdle('Data import');
    const objectName = '.__webRStudio_data_view__';
    const target = `/project/${normalizePath(path)}`;
    const separator = delimiter === '\t' ? '\t' : ',';
    await this.webR.evalRVoid(`assign(${rString(objectName)}, utils::read.table(${rString(target)}, header = TRUE, sep = ${rString(separator)}, quote = "\\"", comment.char = "", check.names = FALSE, stringsAsFactors = FALSE, fill = TRUE), envir = .GlobalEnv)`);
    return objectName;
  }

  async exportDataFrameCsv(name) {
    this.assertIdle('Data export');
    const path = '/tmp/webrstudio-data-export.csv';
    await this.webR.evalRVoid(`utils::write.csv(.webrStudio$resolve(${rString(name)}), file = ${rString(path)}, row.names = FALSE, na = "")`);
    return this.webR.FS.readFile(path);
  }

  async getObjectSummary(name) {
    this.assertIdle('Object inspection');
    const result = await this.execute(`summary(${rName(name)})`, { capturePlots: false });
    return result.outputs.map(output => output.text).join('\n');
  }

  async evalStringArray(code) {
    return this.webR.evalRRaw(code, 'string[]');
  }

  async getRuntimeInfo() {
    this.assertIdle('Runtime inspection');
    const platform = await this.webR.evalRString('R.version$platform');
    const memory = await this.webR.evalRNumber('sum(gc()[, 2])');
    return {
      webR: this.version,
      R: this.rVersion,
      platform,
      memoryMb: memory,
      isolated: this.interruptSupported,
      interruptible: this.interruptSupported,
      requestedWebR: this.requestedVersion,
      channel: this.interruptSupported ? 'SharedArrayBuffer' : 'PostMessage'
    };
  }

  assertReady() {
    if (!this.ready || !this.webR) throw new Error('The webR runtime is not ready');
  }

  assertIdle(action = 'This operation') {
    this.assertReady();
    if (this.running) throw new Error(`${action} is unavailable while R is executing`);
  }
}

export function describeRuntime(engine) {
  if (!engine.ready) return 'R is offline';
  return `${engine.rVersion || 'R'} · webR ${engine.version} · ${engine.interruptSupported ? 'interruptible' : 'PostMessage · interruption unavailable'}`;
}

export function environmentTypeLabel(object) {
  if (object.isFunction) return 'fn';
  if (object.isData) return 'df';
  if (object.type === 'double' || object.type === 'integer') return '#';
  if (object.type === 'character') return 'Aa';
  if (object.type === 'logical') return '✓';
  return 'R';
}

export function objectMeta(object) {
  const dimensions = object.dimensions ? ` · ${object.dimensions}` : '';
  return `${object.className || object.type}${dimensions} · ${formatBytes(object.size)}`;
}

export { parseCapturedOutput };
