const normalizeLineEndings = value => String(value ?? '').replace(/\r\n?/g, '\n');

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeInlineValue(value = '') {
  const escaped = escapeHtml(String(value).replace(/\s*\n\s*/g, ' '));
  return escaped.replace(/[\\`*_{}\[\]()#+.!|~-]/g, character => `&#${character.codePointAt(0)};`);
}

function escapeAttribute(value = '') {
  return escapeHtml(String(value).replace(/\s*\n\s*/g, ' '));
}

function inlineRSource(value = '') {
  const match = String(value).match(/^r[ \t]+([\s\S]*?\S)[ \t]*$/);
  return match ? match[1] : '';
}

function markdownContainerContent(line = '') {
  let content = String(line);
  while (true) {
    const quote = content.match(/^ {0,3}>[ \t]?/);
    if (!quote) break;
    content = content.slice(quote[0].length);
  }
  const list = content.match(/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/);
  return list ? content.slice(list[0].length) : content;
}

function fenceOpening(line = '') {
  const match = markdownContainerContent(line).match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  return match ? { character: match[1][0], length: match[1].length } : null;
}

function fenceClosing(line = '', opening = null) {
  if (!opening) return false;
  const match = markdownContainerContent(line).match(/^ {0,3}(`{3,}|~{3,})\s*$/);
  return Boolean(match && match[1][0] === opening.character && match[1].length >= opening.length);
}

async function replaceInlineRCodeSpans(line, evaluator) {
  let preview = '';
  let gfm = '';
  let cursor = 0;
  let evaluated = 0;

  while (cursor < line.length) {
    const openingIndex = line.indexOf('`', cursor);
    if (openingIndex < 0) {
      preview += line.slice(cursor);
      gfm += line.slice(cursor);
      break;
    }

    preview += line.slice(cursor, openingIndex);
    gfm += line.slice(cursor, openingIndex);

    let openingLength = 1;
    while (line[openingIndex + openingLength] === '`') openingLength += 1;
    let search = openingIndex + openingLength;
    let closingIndex = -1;

    while (search < line.length) {
      const candidate = line.indexOf('`', search);
      if (candidate < 0) break;
      let candidateLength = 1;
      while (line[candidate + candidateLength] === '`') candidateLength += 1;
      if (candidateLength === openingLength) {
        closingIndex = candidate;
        break;
      }
      search = candidate + candidateLength;
    }

    if (closingIndex < 0) {
      preview += line.slice(openingIndex);
      gfm += line.slice(openingIndex);
      break;
    }

    const closingEnd = closingIndex + openingLength;
    const original = line.slice(openingIndex, closingEnd);
    let code = line.slice(openingIndex + openingLength, closingIndex);
    if (/^\s[\s\S]*\s$/.test(code) && /\S/.test(code)) code = code.slice(1, -1);
    const source = inlineRSource(code);

    if (!source || typeof evaluator !== 'function') {
      preview += original;
      gfm += original;
      cursor = closingEnd;
      continue;
    }

    try {
      const value = await evaluator(source);
      const encoded = escapeInlineValue(value);
      preview += `<span class="inline-r-output" title="R: ${escapeAttribute(source)}">${encoded}</span>`;
      gfm += encoded;
    } catch (error) {
      const message = `🧯 ${error?.message || String(error)}`;
      const encoded = escapeInlineValue(message);
      preview += `<span class="inline-r-error" title="R: ${escapeAttribute(source)}">${encoded}</span>`;
      gfm += encoded;
    }
    evaluated += 1;
    cursor = closingEnd;
  }

  return { preview, gfm, evaluated };
}

export async function evaluateInlineRMarkdown(markdown, evaluator) {
  const lines = normalizeLineEndings(markdown).split('\n');
  const preview = [];
  const gfm = [];
  let fenced = null;
  let evaluated = 0;

  for (const line of lines) {
    if (fenced) {
      preview.push(line);
      gfm.push(line);
      if (fenceClosing(line, fenced)) fenced = null;
      continue;
    }

    const opening = fenceOpening(line);
    if (opening) {
      fenced = opening;
      preview.push(line);
      gfm.push(line);
      continue;
    }

    // Four-space-indented Markdown is a literal code block. Inline R examples
    // inside it must remain source text rather than being evaluated.
    if (/^(?: {4}|\t)/.test(markdownContainerContent(line))) {
      preview.push(line);
      gfm.push(line);
      continue;
    }

    const replacement = await replaceInlineRCodeSpans(line, evaluator);
    preview.push(replacement.preview);
    gfm.push(replacement.gfm);
    evaluated += replacement.evaluated;
  }

  return { preview: preview.join('\n'), gfm: gfm.join('\n'), evaluated };
}

export function gfmCodeFence(content, language = '') {
  const text = normalizeLineEndings(content).replace(/\n+$/, '');
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${String(language || '').trim()}\n${text}\n${fence}`;
}

export function gfmDocumentStem(path = 'document.Rmd') {
  const base = String(path).replaceAll('\\', '/').split('/').pop() || 'document.Rmd';
  const withoutExtension = base.replace(/\.(?:rmd|md|markdown)$/i, '') || 'document';
  return withoutExtension
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'document';
}

function assetSlug(value = '') {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'plot';
}

function escapeImageAlt(value = '') {
  return String(value || '').replace(/\s+/g, ' ').replaceAll('\\', '\\\\').replaceAll(']', '\\]').trim();
}

function normalizedOptions(raw = {}) {
  return Object.fromEntries(Object.entries(raw || {}).map(([key, value]) => [String(key).toLowerCase(), value]));
}

function resultsMode(options = {}) {
  return String(options.results ?? 'markup').toLowerCase();
}

function figuresVisible(options = {}) {
  return !/^(?:hide|none|false)$/i.test(String(options['fig.show'] ?? ''));
}

function formattedOutput(item = {}) {
  const text = normalizeLineEndings(item.text || '').replace(/\n+$/, '');
  if (!text) return '';
  const type = String(item.type || 'stdout').toLowerCase();
  const prefix = type === 'warning'
    ? 'Warning: '
    : type === 'error'
      ? 'Error: '
      : type === 'message'
        ? 'Message: '
        : '';
  return `${prefix}${text}`;
}

export class RMarkdownGfmBuilder {
  constructor({ stem = 'document', title = '' } = {}) {
    this.stem = gfmDocumentStem(stem);
    this.title = String(title || '').replace(/\s+/g, ' ').trim();
    this.parts = [];
    this.assets = [];
    this.assetNames = new Set();
    this.chunkNumber = 0;
    this.plotNumbers = new Map();
    this.assetDirectory = `${this.stem}_files/figure-gfm`;
  }

  appendBlock(value) {
    const block = normalizeLineEndings(value).replace(/^\n+|\n+$/g, '');
    if (block) this.parts.push(block);
  }

  appendMarkdown(markdown) {
    this.appendBlock(markdown);
  }

  appendTextOutput(lines) {
    const text = lines.filter(Boolean).join('\n');
    if (text) this.appendBlock(gfmCodeFence(text, 'text'));
  }

  addPlot(svg, { label = '', caption = '' } = {}) {
    const chunkName = assetSlug(label || `unnamed-chunk-${this.chunkNumber || 1}`);
    const next = (this.plotNumbers.get(chunkName) || 0) + 1;
    this.plotNumbers.set(chunkName, next);
    let name = `${this.assetDirectory}/${chunkName}-${next}.svg`;
    let suffix = next;
    while (this.assetNames.has(name)) {
      suffix += 1;
      name = `${this.assetDirectory}/${chunkName}-${suffix}.svg`;
    }
    this.assetNames.add(name);
    this.assets.push({ name, data: normalizeLineEndings(svg).trim(), mime: 'image/svg+xml' });

    const alt = escapeImageAlt(caption || `Plot from ${label || `R chunk ${this.chunkNumber || 1}`}`);
    this.appendBlock(`![${alt}](${name})`);
    if (caption) this.appendBlock(`*${String(caption).trim()}*`);
    return name;
  }

  appendChunk({ label = '', code = '', options: rawOptions = {}, result = null, plots = [], caption = '' } = {}) {
    this.chunkNumber += 1;
    const options = normalizedOptions(rawOptions);
    if (options.include === false) return;

    if (options.echo !== false) this.appendBlock(gfmCodeFence(code, 'r'));
    if (!result) return;

    const mode = resultsMode(options);
    const regular = [];
    const asis = [];
    const flushRegular = () => {
      this.appendTextOutput(regular);
      regular.length = 0;
    };
    const flushAsis = () => {
      if (asis.length) this.appendBlock(asis.join('\n'));
      asis.length = 0;
    };

    for (const item of result.outputs || []) {
      const type = String(item.type || 'stdout').toLowerCase();
      if (type === 'message' && options.message === false) continue;
      if (type === 'warning' && options.warning === false) continue;
      if (['stdout', 'stderr', 'error'].includes(type) && ['hide', 'false'].includes(mode)) continue;

      if (type === 'stdout' && mode === 'asis') {
        flushRegular();
        const text = normalizeLineEndings(item.text || '').replace(/\n+$/, '');
        if (text) asis.push(text);
        continue;
      }

      flushAsis();
      const output = formattedOutput(item);
      if (output) regular.push(output);
    }
    flushAsis();
    flushRegular();

    if (!result.ok && result.traceback?.length) {
      this.appendTextOutput([`Traceback:\n${result.traceback.join('\n')}`]);
    }

    if (figuresVisible(options)) {
      for (const plot of plots || []) {
        const svg = typeof plot === 'string' ? plot : plot?.svg;
        if (svg) this.addPlot(svg, { label, caption });
      }
    }
  }

  build() {
    const parts = [...this.parts];
    const first = parts.find(value => value.trim()) || '';
    if (this.title && !/^ {0,3}#\s+/m.test(first)) parts.unshift(`# ${this.title}`);
    return {
      stem: this.stem,
      markdown: `${parts.join('\n\n')}\n`,
      assets: this.assets.map(asset => ({ ...asset }))
    };
  }
}

export function gfmBundleFiles(bundle = {}) {
  const stem = gfmDocumentStem(bundle.stem || 'document');
  return [
    { name: `${stem}.md`, data: String(bundle.markdown || '') },
    ...(bundle.assets || []).map(asset => ({ name: asset.name, data: asset.data }))
  ];
}
