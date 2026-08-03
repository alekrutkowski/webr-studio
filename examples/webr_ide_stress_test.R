# =============================================================================
# webR IDE stress test
# =============================================================================
# Purpose:
#   Exercise editor, console, plotting, files, data viewing, environment
#   inspection, diagnostics, help, persistence, interruption, and recovery.
#
# Usage:
#   1. Open this file in the IDE.
#   2. Run the whole script.
#   3. Re-run individual sections and selections with Ctrl+Enter.
#   4. Change PROFILE to "smoke", "standard", or "heavy".
#   5. Enable opt-in destructive or long-running tests only when needed.
#
# This script uses base and recommended R packages only. Defaults are intended
# to be demanding enough to expose UI/runtime defects without freezing a
# typical modern browser tab.
# =============================================================================

PROFILE <- "standard"   # "smoke", "standard", or "heavy"

CREATE_100MB_FILE    <- FALSE  # Tests large-file handling; consumes memory.
RUN_CANCELLATION_TEST <- FALSE # Use the IDE's Stop button while it is running.
RUN_UNCAUGHT_ERROR    <- FALSE # Deliberately ends the script with an error.
CLEAN_OUTPUT_FIRST    <- TRUE

options(
  width = 100,
  digits = 6,
  warn = 0,
  stringsAsFactors = FALSE
)

set.seed(20260722)

# ---- Configuration ----------------------------------------------------------

profiles <- list(
  smoke = list(
    n_rows = 20L * 1000L,
    matrix_rows = 300L,
    matrix_cols = 40L,
    bootstrap_reps = 25L,
    plot_points = 5L * 1000L
  ),
  standard = list(
    n_rows = 250L * 1000L,
    matrix_rows = 1200L,
    matrix_cols = 100L,
    bootstrap_reps = 150L,
    plot_points = 40L * 1000L
  ),
  heavy = list(
    n_rows = 1L * 1000L * 1000L,
    matrix_rows = 3000L,
    matrix_cols = 250L,
    bootstrap_reps = 500L,
    plot_points = 200L * 1000L
  )
)

stopifnot(PROFILE %in% names(profiles))
cfg <- profiles[[PROFILE]]

output_dir <- file.path(getwd(), "webr-stress-output")

if (CLEAN_OUTPUT_FIRST && dir.exists(output_dir)) {
  unlink(output_dir, recursive = TRUE, force = TRUE)
}
dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)

# ---- Utilities --------------------------------------------------------------

section <- function(title) {
  rule <- paste(rep("=", 78L), collapse = "")
  cat("\n", rule, "\n", title, "\n", rule, "\n", sep = "")
  invisible(title)
}

format_bytes <- function(x) {
  units <- c("B", "KiB", "MiB", "GiB")
  i <- min(length(units), floor(log(max(x, 1), 1024)) + 1L)
  sprintf("%.2f %s", x / 1024^(i - 1L), units[[i]])
}

format_integer <- function(x) {
  format(as.numeric(x), big.mark = ",", scientific = FALSE, trim = TRUE)
}

timed <- function(label, expr) {
  start <- proc.time()
  value <- force(expr)
  elapsed <- unname((proc.time() - start)[["elapsed"]])
  cat(sprintf("[timing] %-38s %8.3f s\n", label, elapsed))
  if (is.null(value)) return(invisible(NULL))
  attr(value, "elapsed_seconds") <- elapsed
  value
}

assert <- function(ok, label) {
  if (!isTRUE(ok)) {
    stop("Assertion failed: ", label, call. = FALSE)
  }
  cat("[ok] ", label, "\n", sep = "")
  invisible(TRUE)
}

capture_condition <- function(expr) {
  messages <- character()
  warnings <- character()

  value <- withCallingHandlers(
    tryCatch(
      expr,
      error = function(e) structure(
        list(message = conditionMessage(e), call = conditionCall(e)),
        class = "captured_error"
      )
    ),
    message = function(m) {
      messages <<- c(messages, conditionMessage(m))
      invokeRestart("muffleMessage")
    },
    warning = function(w) {
      warnings <<- c(warnings, conditionMessage(w))
      invokeRestart("muffleWarning")
    }
  )

  list(value = value, messages = messages, warnings = warnings)
}

# ---- 0. Real-time source output ---------------------------------------------

section("0. Real-time source output")

cat(
  "When using Source with Echo, each heartbeat below should appear before the next one,\n",
  "rather than all four appearing only after this loop finishes.\n",
  sep = ""
)

for (step in seq_len(4L)) {
  cat(sprintf("[stream] source heartbeat %d/4\n", step))
  flush.console()
  Sys.sleep(0.20)
}

assert(TRUE, "real-time source heartbeat")

# ---- 1. Parser, syntax highlighting, folding, and delimiters ----------------

section("1. Parser, syntax highlighting, folding, and delimiters")

special_values <- c(
  integer = 42L,
  double = pi,
  hexadecimal = 0xBEEF,
  scientific = 6.02214076e23,
  complex = 3 + 4i,
  missing = NA_real_,
  positive_infinity = Inf,
  negative_infinity = -Inf,
  not_a_number = NaN
)

escaped_text <- "quotes: \"double\", 'single'; tab:\t; newline:\n"
raw_pattern <- r"(^[[:alpha:]_][[:alnum:]_.]*$)"
unicode_text <- "λ → μ ± σ; café; naïve; 中文; العربية; 🙂"

nested_expression <- (
  ((1L + 2L) * (3L + 4L)) /
    sqrt((5L^2L) + (12L^2L))
)

rainbow_pairs <- list(
  round = (((((((1 + 2))))))),
  square = matrix(c(1, 2, 3, 4), nrow = 2)[, c(2, 1), drop = FALSE],
  curly = local({
    z <- list(alpha = 1, beta = list(gamma = 2))
    z[["beta"]][["gamma"]]
  })
)

assert(grepl(raw_pattern, "valid_name_2"), "raw string and regular expression")
assert(is.finite(nested_expression), "nested delimiter expression")

# Foldable function with nested local functions and several branches.
make_transformer <- function(center = TRUE, scale = TRUE, na.rm = TRUE) {
  validate <- function(x) {
    if (!is.numeric(x)) {
      stop("`x` must be numeric.", call. = FALSE)
    }
    if (!length(x)) {
      stop("`x` must not be empty.", call. = FALSE)
    }
    invisible(TRUE)
  }

  function(x) {
    validate(x)

    location <- if (center) {
      mean(x, na.rm = na.rm)
    } else {
      0
    }

    spread <- if (scale) {
      stats::sd(x, na.rm = na.rm)
    } else {
      1
    }

    if (!is.finite(spread) || spread == 0) {
      spread <- 1
    }

    (x - location) / spread
  }
}

standardize <- make_transformer()
assert(abs(mean(standardize(1:20))) < 1e-12, "nested function definition")

# ---- 2. Autocompletion and object-member discovery --------------------------

section("2. Autocompletion and object-member discovery")

completion_fixture <- list(
  customer = list(
    identifier = sprintf("C%05d", 1:8),
    profile = list(
      display_name = paste("Customer", LETTERS[1:8]),
      active = rep(c(TRUE, FALSE), 4L),
      preferences = list(
        editor_theme = "crimson_editor",
        font_family = "Ubuntu Mono",
        ligatures = TRUE
      )
    )
  ),
  metrics = list(
    revenue = c(125.5, 204.0, 98.25),
    conversion_rate = c(0.031, 0.044, 0.028),
    last_updated = as.POSIXct("2026-07-22 12:00:00", tz = "UTC")
  ),
  methods = list(
    refresh = function() message("Refresh requested"),
    summarize = function(x) summary(x)
  )
)

# Put the cursor after a `$` or partial name to test completion:
# completion_fixture$
# completion_fixture$customer$profile$pref
# stats::appro
# utils::head(

assert(
  identical(completion_fixture$customer$profile$preferences$font_family, "Ubuntu Mono"),
  "deep object-member access"
)

# ---- 3. S3 classes, printing, and jump-to-definition ------------------------

section("3. S3 classes, printing, and jump-to-definition")

new_stress_result <- function(name, value, elapsed, details = list()) {
  structure(
    list(
      name = name,
      value = value,
      elapsed = elapsed,
      details = details,
      created_at = Sys.time()
    ),
    class = "webr_stress_result"
  )
}

print.webr_stress_result <- function(x, ...) {
  cat("<webr_stress_result>\n")
  cat("  name:    ", x$name, "\n", sep = "")
  cat("  elapsed: ", sprintf("%.3f s", x$elapsed), "\n", sep = "")
  cat("  value:   ")
  print(x$value)
  invisible(x)
}

summary.webr_stress_result <- function(object, ...) {
  list(
    name = object$name,
    elapsed_seconds = object$elapsed,
    value_class = class(object$value),
    details = object$details
  )
}

jump_target <- function(x, power = 2L) {
  stopifnot(is.numeric(x), length(power) == 1L)
  x^power
}

jump_caller <- function(x) {
  jump_target(x, power = 3L)
}

assert(identical(jump_caller(1:4), c(1, 8, 27, 64)), "jump-to-definition target")

# ---- 4. Console messages, warnings, errors, and condition capture -----------

section("4. Console messages, warnings, errors, and condition capture")

cat("Plain console output from cat().\n")
print(list(status = "printed object", profile = PROFILE))
message("ℹ️  Message test: an informational runtime condition.")
warning("⚠️  Warning test: this warning is deliberate and execution continues.", call. = FALSE)

condition_test <- capture_condition({
  message("Captured message")
  warning("Captured warning", call. = FALSE)
  stop("Captured nested error", call. = FALSE)
})

assert(length(condition_test$messages) == 1L, "message capture")
assert(length(condition_test$warnings) == 1L, "warning capture")
assert(inherits(condition_test$value, "captured_error"), "error capture")

# Use the IDE's error-explanation action on this realistic error string.
realistic_error_text <- paste(
  "Error in model.frame.default:",
  "variable lengths differ (found for 'group')"
)
cat(realistic_error_text, "\n")

# ---- 5. Large heterogeneous data.frame and data viewer ----------------------

section("5. Large heterogeneous data.frame and data viewer")

n <- cfg$n_rows

stress_data <- timed("Generate heterogeneous data.frame", {
  timestamp0 <- as.POSIXct("2020-01-01", tz = "UTC")
  group_levels <- sprintf("group_%02d", 1:24)

  out <- data.frame(
    row_id = seq_len(n),
    account_id = sprintf("ACC-%08d", sample.int(max(n * 2L, 100L), n, replace = TRUE)),
    group = factor(sample(group_levels, n, replace = TRUE), levels = group_levels),
    subgroup = sample(c(LETTERS, NA_character_), n, replace = TRUE),
    event_date = as.Date("2015-01-01") + sample.int(3650L, n, replace = TRUE),
    event_time = timestamp0 + sample.int(86400L * 365L, n, replace = TRUE),
    amount = round(exp(rnorm(n, log(75), 0.8)), 2),
    score = rnorm(n),
    count = rpois(n, lambda = 7),
    probability = stats::rbeta(n, 2, 8),
    enabled = sample(c(TRUE, FALSE, NA), n, replace = TRUE, prob = c(0.47, 0.47, 0.06)),
    note = sample(
      c("alpha", "beta", "contains,comma", "contains\ttab", "\"quoted\"", "", NA_character_),
      n,
      replace = TRUE
    ),
    stringsAsFactors = FALSE,
    check.names = FALSE
  )

  missing_rows <- sample.int(n, max(1L, n %/% 100L))
  out$amount[missing_rows] <- NA_real_
  out
})

attr(stress_data, "description") <- "Heterogeneous table for the webR IDE data viewer."
attr(stress_data, "profile") <- PROFILE

assert(nrow(stress_data) == n, "large data.frame row count")
assert(length(unique(stress_data$group)) <= 24L, "factor levels")

viewer_summary <- within(
  aggregate(
    cbind(amount, score, count, probability) ~ group,
    data = stress_data,
    FUN = function(x) mean(x, na.rm = TRUE)
  ),
  {
    amount <- round(amount, 2)
    score <- round(score, 4)
    probability <- round(probability, 4)
  }
)

viewer_filter_example <- subset(
  stress_data,
  enabled %in% TRUE &
    amount > stats::quantile(amount, 0.95, na.rm = TRUE) &
    grepl("^group_(0[1-9]|1[0-2])$", group)
)

cat("Open `stress_data`, `viewer_summary`, and `viewer_filter_example` in the data viewer.\n")
print(utils::head(viewer_summary, 8L))

# ---- 6. Matrices, arrays, time series, models, and environments -------------

section("6. Matrices, arrays, time series, models, and environments")

stress_matrix <- timed("Generate numeric matrix", {
  matrix(
    rnorm(cfg$matrix_rows * cfg$matrix_cols),
    nrow = cfg$matrix_rows,
    ncol = cfg$matrix_cols,
    dimnames = list(
      sprintf("r%05d", seq_len(cfg$matrix_rows)),
      sprintf("feature_%03d", seq_len(cfg$matrix_cols))
    )
  )
})

stress_array <- array(
  rnorm(12L * 8L * 5L),
  dim = c(month = 12L, region = 8L, metric = 5L),
  dimnames = list(
    month = month.abb,
    region = paste0("region_", 1:8),
    metric = paste0("metric_", 1:5)
  )
)

stress_ts <- ts(
  sin(seq(0, 8 * pi, length.out = 240L)) + rnorm(240L, sd = 0.15),
  start = c(2007, 1),
  frequency = 12
)

model_data <- transform(
  stress_data[seq_len(min(nrow(stress_data), 50L * 1000L)), ],
  log_amount = log1p(amount)
)

stress_model <- stats::lm(
  log_amount ~ score + probability + count + enabled + group,
  data = model_data,
  na.action = stats::na.exclude
)

stress_environment <- new.env(parent = emptyenv())
stress_environment$scalar <- 42
stress_environment$vector <- seq(-1, 1, length.out = 101L)
stress_environment$nested <- list(alpha = list(beta = list(gamma = "deep")))
stress_environment$function_object <- jump_target

sparse_like_list <- setNames(
  lapply(seq_len(250L), function(i) {
    list(index = i, payload = runif(i %% 17L + 1L))
  }),
  sprintf("item_%03d", seq_len(250L))
)

assert(nrow(stress_matrix) == cfg$matrix_rows, "matrix dimensions")
assert(inherits(stress_model, "lm"), "linear model")
assert(is.environment(stress_environment), "environment object")

# ---- 7. Compute and responsiveness ------------------------------------------

section("7. Compute and responsiveness")

matrix_result <- timed("Cross-product and eigenvalues", {
  small <- stress_matrix[
    seq_len(min(500L, nrow(stress_matrix))),
    seq_len(min(80L, ncol(stress_matrix))),
    drop = FALSE
  ]
  gram <- crossprod(scale(small))
  eigenvalues <- eigen(gram, symmetric = TRUE, only.values = TRUE)$values
  list(gram = gram, eigenvalues = eigenvalues)
})

bootstrap_means <- timed("Bootstrap calculation", {
  x <- stress_data$score
  reps <- cfg$bootstrap_reps

  replicate(
    reps,
    mean(sample(x, length(x), replace = TRUE), na.rm = TRUE),
    simplify = TRUE
  )
})

regex_hits <- timed("Vectorized regular-expression scan", {
  grepl(
    "^(ACC-[0-9]{8})$",
    stress_data$account_id,
    perl = TRUE
  )
})

split_summary <- timed("Split/apply/combine aggregation", {
  pieces <- split(stress_data$amount, stress_data$group, drop = TRUE)
  do.call(
    rbind,
    lapply(names(pieces), function(g) {
      x <- pieces[[g]]
      data.frame(
        group = g,
        n = length(x),
        missing = sum(is.na(x)),
        mean = mean(x, na.rm = TRUE),
        median = stats::median(x, na.rm = TRUE),
        p95 = unname(stats::quantile(x, 0.95, na.rm = TRUE)),
        row.names = NULL
      )
    })
  )
})

compute_result <- new_stress_result(
  name = "bootstrap mean",
  value = mean(bootstrap_means),
  elapsed = attr(bootstrap_means, "elapsed_seconds"),
  details = list(repetitions = length(bootstrap_means), profile = PROFILE)
)
print(compute_result)

assert(all(regex_hits), "regular-expression scan")
assert(nrow(split_summary) == nlevels(stress_data$group), "group aggregation")

# ---- 8. Plots and SVG export ------------------------------------------------

section("8. Plots and SVG export")

plot_n <- min(cfg$plot_points, nrow(stress_data))
plot_idx <- sample.int(nrow(stress_data), plot_n)

# Plot 1: scatterplot with transparent points.
plot(
  stress_data$score[plot_idx],
  log1p(stress_data$amount[plot_idx]),
  pch = 16,
  cex = 0.45,
  col = grDevices::adjustcolor("steelblue4", alpha.f = 0.18),
  xlab = "Score",
  ylab = "log(1 + amount)",
  main = sprintf("webR stress scatterplot – %s points", format_integer(plot_n))
)
grid()
abline(
  stats::lm(log1p(amount) ~ score, data = stress_data[plot_idx, ]),
  col = "#9F1239",
  lwd = 2
)

# Plot 2: histogram.
hist(
  stress_data$score,
  breaks = 80L,
  col = "grey80",
  border = "white",
  main = "Distribution of simulated scores",
  xlab = "score"
)
abline(v = mean(stress_data$score), col = "#9F1239", lwd = 2)

# Plot 3: image plot.
image(
  z = stress_matrix[
    seq_len(min(150L, nrow(stress_matrix))),
    seq_len(min(80L, ncol(stress_matrix))),
    drop = FALSE
  ],
  useRaster = TRUE,
  main = "Matrix heatmap"
)

# Plot 4: time series.
plot(
  stress_ts,
  type = "l",
  lwd = 1.4,
  main = "Synthetic monthly time series",
  ylab = "value",
  xlab = "year"
)
lines(stats::filter(stress_ts, rep(1 / 12, 12), sides = 2), col = "#9F1239", lwd = 2)

svg_file <- file.path(output_dir, "stress-plot.svg")
grDevices::svg(svg_file, width = 10, height = 6, pointsize = 11)
plot(
  stress_data$score[plot_idx],
  log1p(stress_data$amount[plot_idx]),
  pch = 16,
  cex = 0.35,
  col = grDevices::adjustcolor("navy", alpha.f = 0.15),
  main = "Exported SVG stress plot",
  xlab = "score",
  ylab = "log(1 + amount)"
)
lines(
  stats::lowess(
    stress_data$score[plot_idx],
    log1p(stress_data$amount[plot_idx]),
    f = 0.15
  ),
  col = "#9F1239",
  lwd = 2
)
grDevices::dev.off()

assert(file.exists(svg_file), "SVG plot export")

# ---- 9. File creation, upload/download fixtures, CSV, TSV, RDS, and RData ---

section("9. File creation and import/export fixtures")

csv_file <- file.path(output_dir, "stress-data.csv")
tsv_file <- file.path(output_dir, "stress-data.tsv")
rds_file <- file.path(output_dir, "stress-object.rds")
rdata_file <- file.path(output_dir, "stress-workspace.RData")
text_file <- file.path(output_dir, "unicode-and-long-lines.txt")

export_rows <- seq_len(min(nrow(stress_data), 100L * 1000L))

timed("Write CSV", {
  utils::write.csv(
    stress_data[export_rows, ],
    csv_file,
    row.names = FALSE,
    na = ""
  )
})

timed("Write TSV", {
  utils::write.table(
    stress_data[export_rows, ],
    tsv_file,
    sep = "\t",
    row.names = FALSE,
    col.names = TRUE,
    quote = TRUE,
    na = ""
  )
})

saveRDS(
  list(
    profile = PROFILE,
    config = cfg,
    summary = viewer_summary,
    model = stress_model,
    unicode = unicode_text
  ),
  rds_file,
  compress = "xz"
)

workspace_note <- "Reload this file to test .RData workspace restoration."
save(
  stress_data,
  viewer_summary,
  stress_matrix,
  stress_model,
  completion_fixture,
  workspace_note,
  file = rdata_file,
  compress = TRUE
)

writeLines(
  c(
    "Unicode fixture:",
    unicode_text,
    "",
    "Long line fixture:",
    paste(rep("0123456789abcdef", 40L), collapse = ""),
    "",
    "Mixed newlines and whitespace are useful for editor tests.",
    "\tindented with a tab",
    "    indented with spaces"
  ),
  text_file,
  useBytes = TRUE
)

roundtrip <- readRDS(rds_file)
assert(identical(roundtrip$profile, PROFILE), "RDS round trip")

csv_roundtrip <- utils::read.csv(
  csv_file,
  nrows = min(1000L, length(export_rows)),
  check.names = FALSE
)
assert(nrow(csv_roundtrip) > 0L, "CSV round trip")

if (CREATE_100MB_FILE) {
  large_file <- file.path(output_dir, "large-file-100MiB.bin")
  block <- as.raw(rep(0:255, length.out = 1024L * 1024L))

  local({
    con <- file(large_file, open = "wb")
    on.exit(close(con), add = TRUE)

    for (i in seq_len(100L)) {
      writeBin(block, con, useBytes = TRUE)
      if (i %% 10L == 0L) {
        cat(sprintf("Large-file progress: %d%%\n", i))
      }
    }
  })

  assert(file.info(large_file)$size == 100 * 1024^2, "100 MiB file creation")
}

# ---- 10. Markdown and R Markdown fixtures -----------------------------------

section("10. Markdown and R Markdown fixtures")

md_file <- file.path(output_dir, "stress-report.md")
rmd_file <- file.path(output_dir, "stress-report.Rmd")

markdown_text <- c(
  "# webR IDE stress report",
  "",
  "This file tests **Markdown rendering**, tables, lists, code, links, and Unicode.",
  "",
  "## Checklist",
  "",
  "- [x] Markdown file created",
  "- [x] Unicode: λ, μ, σ, café, 中文, 🙂",
  "- [ ] Inspect this file in the built-in viewer",
  "",
  "## Table",
  "",
  "| Metric | Value |",
  "|:--|--:|",
  sprintf("| Profile | `%s` |", PROFILE),
  sprintf("| Data rows | %s |", format_integer(nrow(stress_data))),
  sprintf("| Matrix | %d × %d |", nrow(stress_matrix), ncol(stress_matrix)),
  "",
  "## R code",
  "",
  "```r",
  "summary(stress_data$amount)",
  "plot(stress_data$score, stress_data$amount)",
  "```",
  "",
  "> This is a blockquote with `inline code`.",
  "",
  "---",
  "",
  "Generated by `webr-ide-stress-test.R`."
)
writeLines(markdown_text, md_file, useBytes = TRUE)

rmarkdown_text <- c(
  "---",
  "title: \"webR IDE R Markdown stress report\"",
  "output: html_document",
  "---",
  "",
  "# Runtime information",
  "",
  "Inline R result: `r 2 + 2`.",
  "",
  "```{r runtime}",
  "R.version.string",
  "Sys.time()",
  "```",
  "",
  "# Data summary",
  "",
  "```{r summary}",
  "summary(stress_data[, c(\"amount\", \"score\", \"count\", \"probability\")])",
  "```",
  "",
  "# Plot",
  "",
  "```{r plot}",
  "hist(stress_data$score, breaks = 60, col = \"grey80\", border = \"white\")",
  "abline(v = mean(stress_data$score), col = \"#9F1239\", lwd = 2)",
  "```",
  "",
  "# Deliberate condition",
  "",
  "```{r condition}",
  "message(\"R Markdown message fixture\")",
  "warning(\"R Markdown warning fixture\")",
  "```"
)
writeLines(rmarkdown_text, rmd_file, useBytes = TRUE)

assert(file.exists(md_file), "Markdown fixture")
assert(file.exists(rmd_file), "R Markdown fixture")

# ---- 11. Package and help-system inspection ---------------------------------

section("11. Package and help-system inspection")

installed <- as.data.frame(
  utils::installed.packages()[, c("Package", "Version", "Priority"), drop = FALSE],
  stringsAsFactors = FALSE
)
rownames(installed) <- NULL
installed <- installed[order(installed$Package), ]

loaded_namespaces <- sort(loadedNamespaces())
search_path <- search()

cat("Installed packages:", nrow(installed), "\n")
cat("Loaded namespaces:", paste(loaded_namespaces, collapse = ", "), "\n")
cat("Search path:", paste(search_path, collapse = " | "), "\n")

# Put the cursor on any function below and press F1:
help_targets <- list(
  mean = mean,
  linear_model = stats::lm,
  aggregate = stats::aggregate,
  read_csv = utils::read.csv,
  svg = grDevices::svg
)

# This opens standard R help when run directly. In the IDE, F1 should display
# contextual help in the Help pane without disturbing the editor.
help_result <- utils::help("lm", package = "stats")
assert(length(help_result) >= 1L, "R help lookup")

# ---- 12. Static-analysis and lint fixtures ----------------------------------

section("12. Static-analysis and lint fixtures")

# These are valid and are not executed. A smart linter may flag style,
# correctness, performance, or maintainability concerns.
if (FALSE) {
  lint_assignment = 1
  truth <- T
  falsehood <- F
  seq_bad <- 1:length(stress_data)
  partial_match <- stress_data$prob
  duplicated_work <- mean(stress_data$score) + mean(stress_data$score)
  vector_growth <- c()
  vector_growth <- c(vector_growth, 1)
  unused_variable <- "lint me"
  print(truth == falsehood)
}

# Positive examples that should not be flagged:
lint_assignment_fixed <- 1L
truth_fixed <- TRUE
seq_fixed <- seq_along(stress_data)
probability_fixed <- stress_data[["probability"]]
cached_mean <- mean(stress_data$score)
deduplicated_work <- cached_mean + cached_mean

assert(isTRUE(truth_fixed), "lint-positive fixture")

# ---- 13. Advanced find/replace and text-search fixtures ---------------------

section("13. Advanced find/replace and text-search fixtures")

search_fixture <- c(
  "alpha beta gamma",
  "Alpha BETA gamma",
  "alpha_beta_gamma",
  "invoice-2026-000123",
  "invoice-2025-999999",
  "email@example.test",
  "https://example.test/path?q=R",
  "TODO: replace this marker",
  "FIXME: another searchable marker",
  "amount <- amount * 1.20"
)

writeLines(
  search_fixture,
  file.path(output_dir, "search-fixture.txt"),
  useBytes = TRUE
)

find_results <- grep(
  "(?i)alpha|invoice-[0-9]{4}-[0-9]{6}|TODO|FIXME",
  search_fixture,
  perl = TRUE,
  value = TRUE
)
print(find_results)

# Suggested editor tests:
#   Literal find:               stress_data
#   Case-sensitive find:        PROFILE
#   Whole-word find:            mean
#   Regular expression:         invoice-[0-9]{4}-[0-9]{6}
#   Replace with capture:       invoice-\1
#   Search across project:      TODO|FIXME

# ---- 14. Native and magrittr pipe editing fixtures --------------------------

section("14. Native and magrittr pipe editing fixtures")

native_pipe_result <-
  stress_data |>
  subset(enabled %in% TRUE & !is.na(amount)) |>
  head(1000L) |>
  transform(amount_z = as.numeric(scale(amount))) |>
  aggregate(cbind(amount, amount_z) ~ group, data = _, FUN = mean)

print(utils::head(native_pipe_result))

# Select either line and use Ctrl+Shift+M to test pipe insertion:
pipe_left_hand_side <- stress_data
pipe_right_hand_side <- head(10L)

# Optional magrittr fixture; it runs only when magrittr is installed.
if (requireNamespace("magrittr", quietly = TRUE)) {
  `%>%` <- magrittr::`%>%`
  magrittr_pipe_result <- stress_data %>%
    utils::head(100L) %>%
    summary()
} else {
  magrittr_pipe_result <- "magrittr is not installed; package-manager test available."
}

# ---- 15. Persistence, checkpoints, and state restoration --------------------

section("15. Persistence, checkpoints, and state restoration")

checkpoint_file <- file.path(output_dir, "checkpoint.RData")
checkpoint_manifest <- file.path(output_dir, "checkpoint-manifest.json")

checkpoint_objects <- c(
  "PROFILE",
  "cfg",
  "stress_data",
  "viewer_summary",
  "stress_matrix",
  "stress_model",
  "completion_fixture"
)

save(
  list = checkpoint_objects,
  file = checkpoint_file,
  compress = TRUE
)

json_escape <- function(x) {
  x <- gsub("\\\\", "\\\\\\\\", x)
  x <- gsub("\"", "\\\\\"", x)
  x <- gsub("\n", "\\\\n", x, fixed = TRUE)
  x
}

manifest_lines <- c(
  "{",
  sprintf('  "profile": "%s",', json_escape(PROFILE)),
  sprintf('  "created_at": "%s",', format(Sys.time(), tz = "UTC", usetz = TRUE)),
  sprintf('  "r_version": "%s",', json_escape(R.version.string)),
  sprintf('  "working_directory": "%s",', json_escape(getwd())),
  '  "objects": [',
  paste0(
    "    ",
    sprintf('"%s"', vapply(checkpoint_objects, json_escape, character(1))),
    collapse = ",\n"
  ),
  "  ]",
  "}"
)
writeLines(manifest_lines, checkpoint_manifest, useBytes = TRUE)

checkpoint_env <- new.env(parent = emptyenv())
load(checkpoint_file, envir = checkpoint_env)

assert(
  all(checkpoint_objects %in% ls(checkpoint_env, all.names = TRUE)),
  "checkpoint restoration into isolated environment"
)

# ---- 16. Cancellation and interrupt handling --------------------------------

section("16. Cancellation and interrupt handling")

cancellation_test <- function(seconds = 30) {
  deadline <- Sys.time() + seconds
  iterations <- 0L

  message(
    "Cancellation test started. Press the IDE's Stop button before it completes."
  )

  repeat {
    iterations <- iterations + 1L

    # Mix CPU work with frequent event-loop opportunities.
    invisible(sum(sqrt(seq_len(20L * 1000L))))

    if (iterations %% 10L == 0L) {
      cat(sprintf(
        "Cancellation heartbeat: iteration %d, %.1f seconds remaining\n",
        iterations,
        max(0, as.numeric(deadline - Sys.time(), units = "secs"))
      ))
    }

    if (Sys.time() >= deadline) {
      break
    }

    Sys.sleep(0.01)
  }

  invisible(iterations)
}

if (RUN_CANCELLATION_TEST) {
  cancellation_iterations <- cancellation_test(45)
}

# ---- 17. Nested traceback fixture -------------------------------------------

section("17. Nested traceback fixture")

trace_level_3 <- function(x) {
  stop(
    sprintf(
      "Deliberate uncaught error: expected a positive scalar, received `%s`.",
      paste(x, collapse = ", ")
    ),
    call. = FALSE
  )
}

trace_level_2 <- function(x) {
  transformed <- x - 10
  trace_level_3(transformed)
}

trace_level_1 <- function(x) {
  trace_level_2(log1p(x))
}

capture_trace_fixture <- function(expr) {
  captured <- NULL
  tryCatch(
    withCallingHandlers(
      expr,
      error = function(e) {
        calls <- vapply(sys.calls(), deparse1, character(1))
        user_calls <- calls[grepl("^trace_level_[123]\\(", calls)]
        captured <<- list(
          message = conditionMessage(e),
          calls = user_calls
        )
      }
    ),
    error = function(e) invisible(NULL)
  )
  captured
}

captured_traceback_fixture <- capture_trace_fixture(trace_level_1(4))
print(captured_traceback_fixture)

# ---- 18. Runtime and memory summary -----------------------------------------

section("18. Runtime and memory summary")

output_files <- list.files(
  output_dir,
  recursive = TRUE,
  full.names = TRUE,
  all.files = TRUE,
  no.. = TRUE
)

output_info <- file.info(output_files)
output_manifest <- data.frame(
  file = basename(output_files),
  path = output_files,
  bytes = output_info$size,
  size = vapply(output_info$size, format_bytes, character(1)),
  modified = output_info$mtime,
  row.names = NULL,
  check.names = FALSE
)

object_names <- ls(envir = .GlobalEnv, all.names = TRUE)
object_sizes <- vapply(
  object_names,
  function(name) object.size(get(name, envir = .GlobalEnv, inherits = FALSE)),
  numeric(1)
)

largest_objects <- head(
  sort(object_sizes, decreasing = TRUE),
  15L
)

runtime_summary <- list(
  profile = PROFILE,
  R = R.version.string,
  platform = R.version$platform,
  working_directory = getwd(),
  output_directory = output_dir,
  output_file_count = nrow(output_manifest),
  output_bytes = sum(output_manifest$bytes, na.rm = TRUE),
  global_object_count = length(object_names),
  largest_objects = largest_objects,
  session = utils::sessionInfo()
)

print(output_manifest)
cat("\nLargest global objects:\n")
print(
  data.frame(
    object = names(largest_objects),
    bytes = unname(largest_objects),
    size = vapply(largest_objects, format_bytes, character(1)),
    row.names = NULL
  )
)

cat("\nSession information:\n")
print(runtime_summary$session)

assert(length(output_files) >= 8L, "output fixture count")
assert(file.exists(checkpoint_file), "checkpoint file exists")

# ---- 19. Final status --------------------------------------------------------

section("19. Final status")

cat(
  paste(
    "✅ webR IDE stress test completed.",
    sprintf("Profile: %s.", PROFILE),
    sprintf("Rows: %s.", format_integer(nrow(stress_data))),
    sprintf("Matrix: %d × %d.", nrow(stress_matrix), ncol(stress_matrix)),
    sprintf("Objects in global environment: %d.", length(object_names)),
    sprintf(
      "Generated files: %d (%s).",
      nrow(output_manifest),
      format_bytes(sum(output_manifest$bytes, na.rm = TRUE))
    ),
    sprintf("Output directory: %s", output_dir),
    sep = "\n"
  ),
  "\n"
)

cat(
  "\nManual IDE checks still worth performing:\n",
  "  • Close and reopen the tab to verify autosave and session recovery.\n",
  "  • Resize and move panes, then reload to verify layout persistence.\n",
  "  • Open `stress_data` and exercise sorting, filtering, and pagination.\n",
  "  • Open the generated Markdown and R Markdown files in their viewers.\n",
  "  • Export displayed plots as SVG, PNG, JPEG, and WebP.\n",
  "  • Select code and use the Check my code action.\n",
  "  • Put the cursor on `lm` and press F1.\n",
  "  • Use F12 on `jump_target()` and `make_transformer()`.\n",
  "  • Enable RUN_CANCELLATION_TEST and press Stop during execution.\n",
  "  • Save state to JSON and URL, restart webR, and restore it.\n",
  "  • Import the generated `.RData`, CSV, TSV, Rmd, and Markdown files.\n",
  sep = ""
)

if (RUN_UNCAUGHT_ERROR) {
  message("💥 Triggering the final uncaught error and traceback test now.")
  trace_level_1(-2)
}
