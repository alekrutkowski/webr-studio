export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function debounce(fn, wait = 250) {
  let timer = 0;
  let lastArgs = [];
  const wrapped = (...args) => {
    lastArgs = args;
    globalThis.clearTimeout(timer);
    timer = globalThis.setTimeout(() => {
      timer = 0;
      const invokeArgs = lastArgs;
      lastArgs = [];
      fn(...invokeArgs);
    }, wait);
  };
  wrapped.cancel = () => {
    globalThis.clearTimeout(timer);
    timer = 0;
    lastArgs = [];
  };
  wrapped.flush = (...args) => {
    if (!timer) return undefined;
    globalThis.clearTimeout(timer);
    timer = 0;
    const invokeArgs = args.length ? args : lastArgs;
    lastArgs = [];
    return fn(...invokeArgs);
  };
  wrapped.pending = () => Boolean(timer);
  return wrapped;
}

export function throttle(fn, wait = 100) {
  let pending = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (pending) return;
    pending = true;
    globalThis.setTimeout(() => {
      pending = false;
      fn(...lastArgs);
    }, wait);
  };
}

export const sleep = (ms) => new Promise(resolve => globalThis.setTimeout(resolve, ms));

export function idle(callback, timeout = 800) {
  if ('requestIdleCallback' in window) return window.requestIdleCallback(callback, { timeout });
  return window.setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), 1);
}

export function uid(prefix = 'id') {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatBytes(bytes = 0, decimals = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : decimals)} ${units[index]}`;
}

export function formatDuration(ms = 0) {
  if (ms < 1) return `${Math.round(ms * 1000)} µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60000);
  return `${minutes} min ${((ms % 60000) / 1000).toFixed(1)} s`;
}

export function formatDate(timestamp = Date.now()) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(timestamp));
}

export function normalizePath(path = '') {
  return String(path)
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '') || 'untitled.R';
}

export function basename(path = '') {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function dirname(path = '') {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

export function extname(path = '') {
  const base = basename(path);
  const index = base.lastIndexOf('.');
  return index <= 0 ? '' : base.slice(index + 1).toLowerCase();
}

export function modeFromPath(path = '') {
  switch (extname(path)) {
    case 'r': return 'r';
    case 'rmd': return 'rmarkdown';
    case 'md':
    case 'markdown': return 'markdown';
    case 'json': return 'json';
    case 'csv': return 'csv';
    case 'tsv': return 'tsv';
    case 'yaml':
    case 'yml': return 'yaml';
    case 'html':
    case 'htm': return 'html';
    case 'js': return 'javascript';
    case 'css': return 'css';
    default: return 'text';
  }
}

export function aceModeFromPath(path = '') {
  const mode = modeFromPath(path);
  if (mode === 'rmarkdown') return 'webr_rmarkdown';
  if (mode === 'csv' || mode === 'tsv') return 'text';
  return mode;
}

export function mimeFromPath(path = '') {
  switch (extname(path)) {
    case 'r': return 'text/x-r-source';
    case 'rmd': return 'text/x-r-markdown';
    case 'md':
    case 'markdown': return 'text/markdown';
    case 'csv': return 'text/csv';
    case 'tsv': return 'text/tab-separated-values';
    case 'json': return 'application/json';
    case 'html':
    case 'htm': return 'text/html';
    case 'svg': return 'image/svg+xml';
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

export function isTextPath(path = '') {
  return ['r', 'rmd', 'md', 'markdown', 'csv', 'tsv', 'txt', 'json', 'yaml', 'yml', 'html', 'htm', 'css', 'js', 'svg'].includes(extname(path));
}

export function isPreviewable(path = '') {
  return ['md', 'markdown', 'rmd'].includes(extname(path));
}

export function isDataPath(path = '') {
  return ['csv', 'tsv'].includes(extname(path));
}

export function rString(value = '') {
  return `"${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')}"`;
}

export function rVector(values = []) {
  if (!values.length) return 'character()';
  return `c(${values.map(rString).join(', ')})`;
}

export function rName(value = '') {
  return /^[A-Za-z.][A-Za-z0-9._]*$/.test(value) && !/^\.[0-9]/.test(value)
    ? value
    : `\`${String(value).replaceAll('`', '\\`')}\``;
}

export function bytesToBase64Url(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function streamToUint8Array(stream) {
  const response = new Response(stream);
  return new Uint8Array(await response.arrayBuffer());
}

export async function encodeWorkspaceState(value) {
  const source = new TextEncoder().encode(JSON.stringify(value));
  if ('CompressionStream' in window) {
    const stream = new Blob([source]).stream().pipeThrough(new CompressionStream('gzip'));
    return `gz.${bytesToBase64Url(await streamToUint8Array(stream))}`;
  }
  return `js.${bytesToBase64Url(source)}`;
}

export async function decodeWorkspaceState(value) {
  const [kind, payload] = String(value).split('.', 2);
  if (!payload) throw new Error('Invalid workspace state');
  const bytes = base64UrlToBytes(payload);
  let decoded = bytes;
  if (kind === 'gz') {
    if (!('DecompressionStream' in window)) throw new Error('This browser cannot decompress the URL state');
    decoded = await streamToUint8Array(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
  }
  return JSON.parse(new TextDecoder().decode(decoded));
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function downloadText(text, filename, type = 'text/plain;charset=utf-8') {
  downloadBlob(new Blob([text], { type }), filename);
}

export async function readFileAsBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

export async function readFileAsText(file) {
  return file.text();
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

export function safeOpen(url) {
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (opened) opened.opener = null;
  return opened;
}

export function mistralCodeUrl(code) {
  const query = `Check my R code:\n\n${code}`;
  return `https://chat.mistral.ai/chat?q=${encodeURIComponent(query)}`;
}

export function mistralErrorUrl(error) {
  const query = `Explain the following error from R console:\n\n${error}`;
  return `https://chat.mistral.ai/chat?q=${encodeURIComponent(query)}`;
}

export function sanitizeHtml(html) {
  if (globalThis.DOMPurify) {
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
      ADD_ATTR: ['target', 'rel', 'viewBox'],
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style']
    });
  }
  const documentFragment = new DOMParser().parseFromString(String(html), 'text/html');
  documentFragment.querySelectorAll('script, iframe, object, embed').forEach(node => node.remove());
  documentFragment.querySelectorAll('*').forEach(node => {
    [...node.attributes].forEach(attribute => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (/^on/i.test(name) || name === 'style') {
        node.removeAttribute(attribute.name);
        return;
      }
      if (['href', 'src', 'xlink:href', 'formaction'].includes(name)) {
        const dangerous = /^(?:javascript|vbscript):/i.test(value)
          || (/^data:/i.test(value) && !(name === 'src' && /^data:image\/(?:png|gif|jpeg|webp|svg\+xml);/i.test(value)));
        if (dangerous) node.removeAttribute(attribute.name);
      }
    });
  });
  return documentFragment.body.innerHTML;
}



export function sanitizeSvg(svg) {
  const source = String(svg || '');
  if (!source.includes('<svg')) return '';
  let clean;
  if (globalThis.DOMPurify) {
    clean = DOMPurify.sanitize(source, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ['style', 'symbol', 'use'],
      ADD_ATTR: ['viewBox', 'preserveAspectRatio', 'xmlns', 'xmlns:xlink', 'vector-effect', 'href', 'xlink:href'],
      FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed']
    });
  } else {
    const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
    parsed.querySelectorAll('script, foreignObject, iframe, object, embed').forEach(node => node.remove());
    parsed.querySelectorAll('*').forEach(node => {
      [...node.attributes].forEach(attribute => {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim();
        if (/^on/i.test(name)) node.removeAttribute(attribute.name);
        if (['href', 'xlink:href'].includes(name) && /^(?:javascript|https?:|data:(?!image\/))/i.test(value)) {
          node.removeAttribute(attribute.name);
        }
      });
    });
    clean = new XMLSerializer().serializeToString(parsed.documentElement);
  }
  const documentFragment = new DOMParser().parseFromString(clean, 'image/svg+xml');
  const root = documentFragment.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') return '';
  root.querySelectorAll('*').forEach(node => {
    [...node.attributes].forEach(attribute => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (/^on/i.test(name)) node.removeAttribute(attribute.name);
      if (['href', 'xlink:href'].includes(name) && /^(?:javascript|https?:|data:(?!image\/))/i.test(value)) {
        node.removeAttribute(attribute.name);
      }
    });
  });

  // Cairo SVG files frequently reuse glyph and clip-path IDs. Prefixing every
  // local fragment keeps multiple inline R plots independent in one document.
  const prefix = `${uid('r-svg')}-`;
  const identifiers = new Map();
  root.querySelectorAll('[id]').forEach(node => {
    const previous = node.getAttribute('id');
    if (!previous) return;
    const next = `${prefix}${previous}`;
    identifiers.set(previous, next);
    node.setAttribute('id', next);
  });
  const localReference = value => String(value || '').replace(
    /url\(\s*(["']?)#([^\s)"']+)\1\s*\)/g,
    (match, quote, id) => identifiers.has(id) ? `url(${quote}#${identifiers.get(id)}${quote})` : match
  );
  root.querySelectorAll('*').forEach(node => {
    [...node.attributes].forEach(attribute => {
      const name = attribute.name.toLowerCase();
      if (name === 'id') return;
      if (['aria-labelledby', 'aria-describedby'].includes(name)) {
        node.setAttribute(attribute.name, attribute.value.split(/\s+/).map(id => identifiers.get(id) || id).join(' '));
      } else if (['href', 'xlink:href'].includes(name) && attribute.value.startsWith('#')) {
        const id = attribute.value.slice(1);
        if (identifiers.has(id)) node.setAttribute(attribute.name, `#${identifiers.get(id)}`);
      } else if (attribute.value.includes('url(')) {
        node.setAttribute(attribute.name, localReference(attribute.value));
      }
    });
  });
  root.querySelectorAll('style').forEach(style => {
    style.textContent = localReference(style.textContent);
  });
  return new XMLSerializer().serializeToString(root);
}

function mathMatches(text) {
  const matches = [];
  const pattern = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<!\\)\$([^\n$]+?)(?<!\\)\$/g;
  let match;
  while ((match = pattern.exec(text))) {
    matches.push({
      start: match.index,
      end: pattern.lastIndex,
      source: match[1] ?? match[2] ?? '',
      display: match[1] != null
    });
  }
  return matches;
}

export function renderMathInElement(container) {
  if (!container || !globalThis.katex?.renderToString) return false;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('pre, code, script, style, textarea, .katex, math')) return NodeFilter.FILTER_REJECT;
      return node.nodeValue?.includes('$') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let rendered = false;
  for (const node of nodes) {
    const text = node.nodeValue || '';
    const matches = mathMatches(text);
    if (!matches.length) {
      if (text.includes('\\$')) node.nodeValue = text.replaceAll('\\$', '$');
      continue;
    }
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const item of matches) {
      if (item.start > cursor) fragment.append(document.createTextNode(text.slice(cursor, item.start).replaceAll('\\$', '$')));
      const holder = document.createElement(item.display ? 'div' : 'span');
      holder.className = item.display ? 'math-display' : 'math-inline';
      try {
        const html = globalThis.katex.renderToString(item.source, {
          displayMode: item.display,
          output: 'mathml',
          throwOnError: false,
          strict: 'ignore'
        });
        holder.innerHTML = globalThis.DOMPurify
          ? DOMPurify.sanitize(html, {
              USE_PROFILES: { html: true, mathMl: true },
              ADD_TAGS: ['semantics', 'annotation'],
              ADD_ATTR: ['encoding']
            })
          : html;
      } catch {
        holder.textContent = item.display ? `$$${item.source}$$` : `$${item.source}$`;
      }
      fragment.append(holder);
      cursor = item.end;
      rendered = true;
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor).replaceAll('\\$', '$')));
    node.replaceWith(fragment);
  }
  return rendered;
}

export function inlineRCodeSource(text) {
  const match = String(text || '').match(/^r[ \t]+([\s\S]*?\S)[ \t]*$/);
  return match ? match[1] : '';
}

export function extractHelpRequest(source) {
  let code = String(source || '').trim();
  if (!code) return null;
  code = code.replace(/;\s*$/, '').trim();
  if (!code || /[\r\n]/.test(code)) return null;

  const name = '[A-Za-z.][A-Za-z0-9._]*';
  let match = code.match(new RegExp(`^\\?\\s*(?:(${name})\\s*:{2,3}\\s*)?(${name})$`));
  if (match) return { topic: match[2], package: match[1] || '' };

  match = code.match(new RegExp(`^(${name})\\s*\\?\\s*(${name})$`));
  if (match) return { topic: match[2], package: match[1] };

  match = code.match(/^(?:utils:{2,3})?help\s*\(([\s\S]*)\)$/i);
  if (!match) return null;

  const argumentsText = match[1].trim();
  if (!argumentsText) return null;
  const argumentsList = splitTopLevel(argumentsText, ',');
  let topic = '';
  let packageName = '';
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index].trim();
    const named = argument.match(/^([A-Za-z.][A-Za-z0-9._]*)\s*=\s*([\s\S]+)$/);
    const key = named?.[1]?.toLowerCase() || '';
    const rawValue = (named?.[2] || argument).trim();
    const value = unquoteSimpleRValue(rawValue);
    if (key === 'package') packageName = value;
    else if (key === 'topic' || (!key && index === 0)) topic = value;
  }
  if (!new RegExp(`^${name}$`).test(topic)) return null;
  if (packageName && !new RegExp(`^${name}$`).test(packageName)) packageName = '';
  return { topic, package: packageName };
}

function unquoteSimpleRValue(value) {
  const text = String(value || '').trim();
  const quoted = text.match(/^(["'])([\s\S]*)\1$/);
  return quoted ? quoted[2] : text.replace(/^`|`$/g, '');
}

function splitTopLevel(source, separator = ',') {
  const parts = [];
  let start = 0;
  let quote = '';
  let escaped = false;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') round += 1;
    else if (character === ')') round = Math.max(0, round - 1);
    else if (character === '[') square += 1;
    else if (character === ']') square = Math.max(0, square - 1);
    else if (character === '{') curly += 1;
    else if (character === '}') curly = Math.max(0, curly - 1);
    else if (character === separator && round === 0 && square === 0 && curly === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function parseChunkOptionValue(raw) {
  const value = String(raw).trim();
  if (/^(?:true|t)$/i.test(value)) return true;
  if (/^(?:false|f)$/i.test(value)) return false;
  if (/^(?:null|none)$/i.test(value)) return null;
  if (/^na$/i.test(value)) return Number.NaN;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number(value);
  const quoted = value.match(/^(["'])([\s\S]*)\1$/);
  if (quoted) return quoted[2].replace(/\\([\\"'])/g, '$1');
  const vector = value.match(/^c\s*\(([\s\S]*)\)$/i);
  if (vector) return splitTopLevel(vector[1], ',').filter(part => part.trim()).map(parseChunkOptionValue);
  return value;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(50, Math.max(.25, number)) : fallback;
}

function safeCssLength(value) {
  if (value == null || value === false) return '';
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return `${value}px`;
  const text = String(value).trim();
  if (/^(?:\d+(?:\.\d+)?|\.\d+)(?:px|%|em|rem|in|cm|mm|pt|pc|vw|vh|vmin|vmax)$/i.test(text)) return text;
  if (/^auto$/i.test(text)) return 'auto';
  return '';
}

export function resolveRMarkdownFigureOptions(options = {}, fallbackWidth = 7, fallbackHeight = 5) {
  let width = positiveNumber(options['fig.width'], positiveNumber(fallbackWidth, 7));
  let height = positiveNumber(options['fig.height'], positiveNumber(fallbackHeight, 5));
  const dimensions = Array.isArray(options['fig.dim']) ? options['fig.dim'] : null;
  if (dimensions?.length >= 2) {
    width = positiveNumber(dimensions[0], width);
    height = positiveNumber(dimensions[1], height);
  } else if (options['fig.asp'] != null && options['fig.height'] == null) {
    height = positiveNumber(width * Number(options['fig.asp']), height);
  }

  const outWidth = safeCssLength(options['out.width']) || `${Math.round(width * 96)}px`;
  const outHeight = safeCssLength(options['out.height']);
  const align = /^(?:left|right|center)$/i.test(String(options['fig.align'] || ''))
    ? String(options['fig.align']).toLowerCase()
    : 'center';
  return {
    width,
    height,
    outWidth,
    outHeight,
    align,
    caption: typeof options['fig.cap'] === 'string' ? options['fig.cap'] : ''
  };
}

export function renderMarkdown(markdown) {
  if (globalThis.marked?.parse) {
    marked.setOptions({ gfm: true, breaks: false });
    return sanitizeHtml(marked.parse(markdown));
  }
  return `<pre>${escapeHtml(markdown)}</pre>`;
}

export function textFromHtml(html) {
  const parsed = new DOMParser().parseFromString(String(html), 'text/html');
  return parsed.body.textContent || '';
}

export function makeUniqueName(name, existingNames) {
  const normalized = normalizePath(name);
  if (!existingNames.has(normalized)) return normalized;
  const directory = dirname(normalized);
  const base = basename(normalized);
  const extension = extname(base);
  const stem = extension ? base.slice(0, -(extension.length + 1)) : base;
  let index = 2;
  while (true) {
    const candidateBase = `${stem}-${index}${extension ? `.${extension}` : ''}`;
    const candidate = directory ? `${directory}/${candidateBase}` : candidateBase;
    if (!existingNames.has(candidate)) return candidate;
    index += 1;
  }
}

export function stripRCommentsAndStrings(source) {
  const output = [];
  let quote = null;
  let escaped = false;
  let comment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (comment) {
      output.push(character === '\n' ? '\n' : ' ');
      if (character === '\n') comment = false;
      continue;
    }
    if (quote) {
      output.push(character === '\n' ? '\n' : ' ');
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '#') {
      comment = true;
      output.push(' ');
    } else if (character === '"' || character === "'" || character === '`') {
      quote = character;
      output.push(' ');
    } else {
      output.push(character);
    }
  }
  return { text: output.join(''), openQuote: quote };
}

export function expressionState(source) {
  const { text, openQuote } = stripRCommentsAndStrings(source);
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let mismatch = false;
  for (const character of text) {
    if ('([{'.includes(character)) stack.push(character);
    else if (')]}'.includes(character)) {
      if (stack.at(-1) === pairs[character]) stack.pop();
      else mismatch = true;
    }
  }
  const trimmed = text.trimEnd();
  const trailingOperator = /(?:<-|<<-|->>|->|\|>|\+|-|\*|\/|\^|&|&&|\||\|\||~|\?|:|::|:::|\$|@|=|,|%[^%\n]*%)\s*$/.test(trimmed);
  const trailingControl = /\b(?:if|else|for|while|repeat|function)\s*$/.test(trimmed)
    || /(?:^|[;\n])\s*(?:if|for|while|function)\b[\s\S]*\)\s*$/.test(trimmed);
  const complete = !openQuote && stack.length === 0 && !trailingOperator && !trailingControl && !mismatch;
  return { complete, depth: stack.length, stack, openQuote, mismatch, trailingOperator };
}

export function currentRExpression(source, row, column) {
  source = String(source);
  const lines = source.split('\n');
  const targetRow = clamp(Number(row) || 0, 0, Math.max(0, lines.length - 1));
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  const ranges = [];
  let startRow = null;
  let buffer = [];
  const nextCodeLine = index => {
    for (let next = index + 1; next < lines.length; next += 1) {
      if (lines[next].trim()) return lines[next].trim();
    }
    return '';
  };

  const commit = endRow => {
    if (startRow == null) return;
    const start = offsets[startRow];
    const end = offsets[endRow] + lines[endRow].length;
    ranges.push({ startRow, endRow, start, end, text: source.slice(start, end).trim() });
    startRow = null;
    buffer = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (startRow == null && !line.trim()) continue;
    if (startRow == null) startRow = index;
    buffer.push(line);
    const state = expressionState(buffer.join('\n'));
    const continuesWithElse = state.complete && /^else\b/.test(nextCodeLine(index));
    if (state.complete && !continuesWithElse) commit(index);
  }
  if (startRow != null) commit(lines.length - 1);

  const range = ranges.find(item => targetRow >= item.startRow && targetRow <= item.endRow);
  if (range) return { text: range.text, start: range.start, end: range.end };

  const line = lines[targetRow] || '';
  const cursor = clamp(Number(column) || 0, 0, line.length);
  return { text: line.trim(), start: offsets[targetRow], end: offsets[targetRow] + line.length };
}

export function smartIndentR(source, tabSize = 2) {
  const lines = source.split('\n');
  let indent = 0;
  let continuation = 0;
  const result = [];
  for (const rawLine of lines) {
    const content = rawLine.trim();
    if (!content) {
      result.push('');
      continue;
    }
    const { text } = stripRCommentsAndStrings(content);
    const closes = (text.match(/^[}\])]+/)?.[0].length || 0);
    if (closes) indent = Math.max(0, indent - closes);
    const applied = Math.max(0, indent + continuation);
    result.push(`${' '.repeat(applied * tabSize)}${content}`);

    let delta = 0;
    for (const char of text) {
      if ('({['.includes(char)) delta += 1;
      else if (')}]'.includes(char)) delta -= 1;
    }
    indent = Math.max(0, indent + delta + closes);
    const trimmed = text.trimEnd();
    continuation = /(?:<-|=|\+|-|\*|\/|\^|,|\|>|%[^%]*%|&&|\|\|)\s*$/.test(trimmed) && delta <= 0 ? 1 : 0;
    if (/^else\b/.test(content) && indent === 0) continuation = 0;
  }
  return result.join('\n');
}

export function parseDelimited(text, delimiter = ',', maxRows = Infinity) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
      if (rows.length >= maxRows) break;
    } else {
      field += character;
    }
  }
  if ((field || row.length) && rows.length < maxRows) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

export function inferColumnType(values) {
  const nonEmpty = values.filter(value => value !== '' && value != null && !/^NA$/i.test(value));
  if (!nonEmpty.length) return 'empty';
  if (nonEmpty.every(value => /^(true|false|t|f)$/i.test(value))) return 'logical';
  if (nonEmpty.every(value => /^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(value))) return 'numeric';
  if (nonEmpty.every(value => /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?/.test(value))) return 'date';
  return 'character';
}

export async function ensureFontLoaded(fontFamily) {
  const webFonts = new Set([
    'Ubuntu Mono', 'JetBrains Mono', 'Fira Code', 'IBM Plex Mono', 'Source Code Pro',
    'Inconsolata', 'Roboto Mono', 'Victor Mono', 'Space Mono', 'Recursive Mono'
  ]);
  if (!webFonts.has(fontFamily)) return;
  const id = `font-${fontFamily.toLowerCase().replace(/\W+/g, '-')}`;
  if (document.getElementById(id)) return;
  const family = encodeURIComponent(fontFamily).replaceAll('%20', '+');
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.crossOrigin = 'anonymous';
  link.href = `https://fonts.googleapis.com/css2?family=${family}:wght@300;400;500;600;700&display=swap`;
  document.head.append(link);
  try { await document.fonts.load(`400 14px "${fontFamily}"`); } catch { /* Local fallback remains usable. */ }
}

function crc32Table() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[n] = value >>> 0;
  }
  return table;
}
const CRC_TABLE = crc32Table();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function writeUint16(view, offset, value) { view.setUint16(offset, value, true); }
function writeUint32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

export function createZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  const now = dosDateTime();

  for (const file of files) {
    const nameBytes = encoder.encode(normalizePath(file.name));
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : new Uint8Array(file.data);
    const checksum = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0x0800);
    writeUint16(localView, 8, 0);
    writeUint16(localView, 10, now.dosTime);
    writeUint16(localView, 12, now.dosDate);
    writeUint32(localView, 14, checksum);
    writeUint32(localView, 18, data.length);
    writeUint32(localView, 22, data.length);
    writeUint16(localView, 26, nameBytes.length);
    writeUint16(localView, 28, 0);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0x0800);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, now.dosTime);
    writeUint16(centralView, 14, now.dosDate);
    writeUint32(centralView, 16, checksum);
    writeUint32(centralView, 20, data.length);
    writeUint32(centralView, 24, data.length);
    writeUint16(centralView, 28, nameBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, localOffset);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);
    localOffset += localHeader.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 4, 0);
  writeUint16(endView, 6, 0);
  writeUint16(endView, 8, files.length);
  writeUint16(endView, 10, files.length);
  writeUint32(endView, 12, centralSize);
  writeUint32(endView, 16, localOffset);
  writeUint16(endView, 20, 0);
  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}

export function splitRMarkdown(source) {
  const parseHeader = raw => {
    const options = {};
    const parts = splitTopLevel(String(raw), ',').map(value => value.trim());
    let label = '';
    if (parts[0] && !/[=:]/.test(parts[0])) label = parts.shift();
    for (const part of parts.filter(Boolean)) {
      const match = part.match(/^([^=:]+)\s*[=:]\s*([\s\S]*)$/);
      if (match) options[match[1].trim()] = parseChunkOptionValue(match[2]);
    }
    return { label, options };
  };

  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const markdown = [];
  const flushMarkdown = () => {
    if (!markdown.length) return;
    blocks.push({ type: 'markdown', content: markdown.join('\n') });
    markdown.length = 0;
  };

  for (let index = 0; index < lines.length;) {
    // CommonMark permits at most three leading spaces before a fenced block.
    // Four-space-indented fences are literal code examples and must never be
    // executed as R Markdown chunks.
    const opening = lines[index].match(/^ {0,3}(`{3,}|~{3,})[ \t]*\{r\b([^}]*)\}[ \t]*$/i);
    if (!opening) {
      markdown.push(lines[index]);
      index += 1;
      continue;
    }
    const fenceCharacter = opening[1][0];
    const fenceLength = opening[1].length;
    const closing = new RegExp(`^ {0,3}${fenceCharacter === '`' ? '`' : '~'}{${fenceLength},}[ \\t]*$`);
    let end = index + 1;
    while (end < lines.length && !closing.test(lines[end])) end += 1;
    if (end >= lines.length) {
      markdown.push(lines[index]);
      index += 1;
      continue;
    }

    flushMarkdown();
    const header = parseHeader(opening[2]);
    const codeLines = lines.slice(index + 1, end);
    while (codeLines.length) {
      const option = codeLines[0].match(/^\s*#\|\s*([^:]+):\s*(.*)$/);
      if (!option) break;
      const key = option[1].trim();
      const value = parseChunkOptionValue(option[2]);
      if (key === 'label') header.label = String(value || '');
      else header.options[key] = value;
      codeLines.shift();
    }
    blocks.push({
      type: 'r',
      label: header.label,
      options: header.options,
      content: codeLines.join('\n').trimEnd()
    });
    index = end + 1;
  }
  flushMarkdown();
  return blocks;
}

export function svgToDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export async function rasterizeSvg(svg, format = 'png', scale = 2) {
  const image = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Could not render SVG'));
      image.src = url;
    });
    const width = Math.max(1, image.naturalWidth || 900);
    const height = Math.max(1, image.naturalHeight || 650);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    if (format === 'jpeg') {
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, width, height);
    const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
    return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Export failed')), mime, .94));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function localTimestampName(prefix, extension) {
  const date = new Date();
  const stamp = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
    + `_${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}`;
  return `${prefix}-${stamp}.${extension}`;
}
