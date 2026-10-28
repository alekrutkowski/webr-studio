/*
 * webR Studio CORS proxy
 * Copyright (c) 2026 Alek Rutkowski
 *
 * MIT License
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Paste this whole ES module into a Cloudflare Worker. Set PROXY_TOKEN as a
// Secret and ALLOWED_ORIGINS as a Text variable in Settings > Variables and Secrets.
// The password belongs to this proxy; do not use a Cloudflare account API token.
// Keep a current compatibility date (2024-11-11 or later for cache: no-store).
// Ordinary external public downloads need no extra compatibility flags.
// wrangler.jsonc enables optional own-zone routing and cancellation features;
// if those flags are absent from the dashboard, see the README's optional setup.
const PROTOCOL_VERSION = '1';
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_TARGET_LENGTH = 16 * 1024;
const MAX_REDIRECTS = 5;
const PREFLIGHT_HEADERS = new Set(['content-type', 'x-webr-proxy-token']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const CROSS_ORIGIN_HEADERS = new Set(['accept', 'accept-language', 'range']);
const RESPONSE_HEADERS = [
  'content-type', 'content-disposition', 'content-encoding', 'content-language',
  'content-range', 'accept-ranges', 'etag', 'last-modified'
];
const BLOCKED_REQUEST_HEADERS = new Set([
  'cookie', 'cookie2', 'host', 'origin', 'referer', 'referrer',
  'connection', 'keep-alive', 'content-length', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
  'forwarded', 'via', 'true-client-ip', 'accept-encoding'
]);
const LOCAL_SUFFIXES = [
  'localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home',
  'corp', 'invalid', 'test', 'onion', 'home.arpa', 'in-addr.arpa', 'ip6.arpa'
];

class ProxyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) { throw new ProxyError(status, code, message); }

function validToken(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{32,256}$/.test(value);
}

function tokensMatch(received, expected) {
  // Compare every expected character, without an early exit at a matching prefix.
  if (typeof received !== 'string') return false;
  let difference = received.length ^ expected.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ (received.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function allowedOrigins(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const origins = value.split(',').map(origin => origin.trim());
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (origin.includes('*') || !['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin
        || parsed.username || parsed.password) return null;
    } catch { return null; }
  }
  return new Set(origins);
}

function responseHeaders(origin) {
  const headers = new Headers({
    'X-WebR-Proxy-Version': PROTOCOL_VERSION,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
  });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Expose-Headers',
      'X-WebR-Proxy-Version, X-WebR-Upstream-Status, X-WebR-Proxy-Error, Content-Disposition');
  }
  return headers;
}

function errorResponse(error, origin = '') {
  const headers = responseHeaders(origin);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('X-WebR-Proxy-Error', error.code);
  return new Response(JSON.stringify({ error: error.message, code: error.code }), {
    status: error.status, headers
  });
}

function publicIPv4(host) {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99) || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

function publicIPv6(host) {
  // URL has already parsed and normalized the address, including mapped IPv4.
  const halves = host.slice(1, -1).split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = (halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left).map(part => Number.parseInt(part, 16));
  if (words.length !== 8 || words.some(part => !Number.isInteger(part))) return false;
  // Conservatively allow ordinary global unicast only. This also excludes
  // loopback, link-local, ULA, multicast, IPv4-mapped, and NAT64 address forms.
  if ((words[0] & 0xe000) !== 0x2000) return false;
  return !((words[0] === 0x2001 && (words[1] <= 0x01ff || words[1] === 0x0db8))
    || words[0] === 0x2002 || words[0] === 0x3ffe
    || (words[0] === 0x3fff && (words[1] & 0xf000) === 0));
}

function publicTarget(value, workerURL) {
  if (typeof value !== 'string' || !value || value.length > MAX_TARGET_LENGTH
    || /[\x00-\x20\x7f\\]/.test(value)) {
    fail(400, 'INVALID_TARGET', 'Use a complete public HTTP or HTTPS data URL.');
  }
  let url;
  try { url = new URL(value); }
  catch { fail(400, 'INVALID_TARGET', 'Use a complete public HTTP or HTTPS data URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    fail(400, 'INVALID_TARGET', 'Only HTTP or HTTPS targets without embedded login credentials are supported.');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const validHost = host.startsWith('[') ? publicIPv6(host)
    : /^[\d.]+$/.test(host) ? publicIPv4(host)
      : host.length <= 253 && host.includes('.')
        && host.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))
        && !LOCAL_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  if (!validHost || host === workerURL.hostname.toLowerCase().replace(/\.$/, '')) {
    fail(400, 'INVALID_TARGET', 'This proxy accepts public internet destinations only. Use Tailscale for private-network data.');
  }
  url.hostname = host;
  url.hash = '';
  return url;
}

function targetHeaders(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(400, 'INVALID_HEADERS', 'Upstream headers must be an object of header names and string values.');
  }
  const entries = Object.entries(value);
  if (entries.length > 64) fail(400, 'INVALID_HEADERS', 'Too many upstream request headers.');
  const headers = new Headers();
  let totalLength = 0;
  for (const [rawName, content] of entries) {
    const name = rawName.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rawName)) {
      fail(400, 'INVALID_HEADERS', 'An upstream request header name is not a valid HTTP token.');
    }
    if (typeof content !== 'string' || /[\r\n]/.test(content)) {
      fail(400, 'INVALID_HEADERS', 'Upstream headers must be strings without line breaks.');
    }
    totalLength += rawName.length + content.length;
    if (totalLength > 16 * 1024) fail(400, 'INVALID_HEADERS', 'Upstream request headers are too large.');
    if (BLOCKED_REQUEST_HEADERS.has(name)
      || /^(?:x-webr-|x-forwarded-|cf-|sec-|access-control-)/.test(name)) continue;
    try { headers.append(rawName, content); }
    catch { fail(400, 'INVALID_HEADERS', 'An upstream request header is not a valid HTTP header.'); }
  }
  return headers;
}

async function readMessage(request) {
  const length = Number(request.headers.get('Content-Length'));
  if (length > MAX_REQUEST_BYTES) fail(413, 'REQUEST_TOO_LARGE', 'The proxy request exceeds 64 KiB.');
  if (!request.body) fail(400, 'INVALID_REQUEST', 'Send a JSON object with an action.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => {});
        fail(413, 'REQUEST_TOO_LARGE', 'The proxy request exceeds 64 KiB.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let message;
  try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(400, 'INVALID_REQUEST', 'Send a valid UTF-8 JSON object with an action.'); }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    fail(400, 'INVALID_REQUEST', 'Send a JSON object with an action.');
  }
  return message;
}

async function closeBody(response) {
  if (response.body) await response.body.cancel().catch(() => {});
}

async function fetchTarget(message, request, workerURL, origin, fetcher) {
  let target = publicTarget(message.url, workerURL);
  let headers = targetHeaders(message.headers);
  for (let redirects = 0; ; redirects += 1) {
    let upstream;
    try {
      // Never copy request.headers: browser cookies and the proxy password are
      // credentials for this hop only. All target requests are GET requests.
      upstream = await fetcher(target.href, {
        method: 'GET', headers, redirect: 'manual', cache: 'no-store',
        credentials: 'omit', referrerPolicy: 'no-referrer', signal: request.signal
      });
    } catch {
      fail(502, 'UPSTREAM_FETCH_FAILED', 'The Worker could not reach the data server. Check the URL and whether that server accepts requests from Cloudflare.');
    }
    if (!upstream || upstream.status < 200 || upstream.status > 599) {
      if (upstream?.body) await closeBody(upstream);
      fail(502, 'INVALID_UPSTREAM_RESPONSE', 'The data server returned an unsupported response.');
    }
    const location = upstream.headers.get('Location');
    if (REDIRECT_STATUSES.has(upstream.status) && location) {
      await closeBody(upstream);
      if (redirects >= MAX_REDIRECTS) fail(502, 'REDIRECT_LIMIT', 'The data URL redirected more than five times.');
      let next;
      try { next = publicTarget(new URL(location, target).href, workerURL); }
      catch { fail(502, 'INVALID_REDIRECT', 'The data server redirected to an unsupported or private destination.'); }
      if (next.origin !== target.origin) {
        headers = new Headers([...headers].filter(([name]) => CROSS_ORIGIN_HEADERS.has(name)));
      }
      target = next;
      continue;
    }
    const resultHeaders = responseHeaders(origin);
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) resultHeaders.set(name, value);
    }
    resultHeaders.set('X-WebR-Upstream-Status', String(upstream.status));
    // Pass the stream through unchanged. Do not buffer data files in Worker RAM.
    const body = NULL_BODY_STATUSES.has(upstream.status) ? null : upstream.body;
    if (!body && upstream.body) await closeBody(upstream);
    return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: resultHeaders });
  }
}

// Dependency injection is only for tests; a deployed Worker uses native fetch.
export function createProxyWorker({ fetcher = (...args) => fetch(...args) } = {}) {
  return {
    async fetch(request, env = {}) {
      const origins = allowedOrigins(env.ALLOWED_ORIGINS);
      if (!origins) {
        return errorResponse(new ProxyError(503, 'PROXY_NOT_CONFIGURED',
          'Set ALLOWED_ORIGINS to your app\'s exact origin as a Text variable, then deploy the Worker.'));
      }
      const origin = request.headers.get('Origin') || '';
      if (!origins.has(origin)) {
        return errorResponse(new ProxyError(403, 'ORIGIN_NOT_ALLOWED',
          'This webR Studio origin is not in the Worker ALLOWED_ORIGINS setting.'));
      }
      try {
        const workerURL = new URL(request.url);
        const localHTTP = workerURL.protocol === 'http:'
          && (['localhost', '[::1]'].includes(workerURL.hostname)
            || /^127(?:\.\d{1,3}){3}$/.test(workerURL.hostname));
        if (workerURL.protocol !== 'https:' && !localHTTP) {
          fail(400, 'HTTPS_REQUIRED', 'Use the HTTPS address of your Worker.');
        }
        if (workerURL.pathname !== '/' || workerURL.search) {
          fail(404, 'INVALID_ENDPOINT', 'Use the Worker root URL without a path or query string.');
        }
        if (request.method === 'OPTIONS') {
          const method = request.headers.get('Access-Control-Request-Method');
          const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') || '')
            .split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
          if (method !== 'POST' || requestedHeaders.some(name => !PREFLIGHT_HEADERS.has(name))) {
            fail(403, 'PREFLIGHT_REJECTED', 'Use POST with Content-Type and X-WebR-Proxy-Token headers.');
          }
          const headers = responseHeaders(origin);
          headers.set('Access-Control-Allow-Methods', 'POST');
          headers.set('Access-Control-Allow-Headers', 'Content-Type, X-WebR-Proxy-Token');
          headers.set('Access-Control-Max-Age', '600');
          return new Response(null, { status: 204, headers });
        }
        if (request.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', 'Send a POST request from webR Studio.');
        if (!validToken(env.PROXY_TOKEN)) {
          fail(503, 'PROXY_NOT_CONFIGURED', 'Set PROXY_TOKEN to a random 32-256 character password as a Secret, then deploy the Worker.');
        }
        if (!tokensMatch(request.headers.get('X-WebR-Proxy-Token'), env.PROXY_TOKEN)) {
          fail(401, 'AUTH_REQUIRED', 'The proxy password is missing or incorrect. Enter the same password stored as the Worker PROXY_TOKEN Secret.');
        }
        if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
          fail(415, 'INVALID_CONTENT_TYPE', 'Send the proxy request as application/json.');
        }
        const message = await readMessage(request);
        if (message.action === 'check') {
          const headers = responseHeaders(origin);
          headers.set('Content-Type', 'application/json; charset=utf-8');
          return new Response(JSON.stringify({ service: 'webr-studio-cors-proxy', protocol: 1 }), { headers });
        }
        if (message.action !== 'fetch') fail(400, 'INVALID_ACTION', 'The supported actions are check and fetch.');
        return await fetchTarget(message, request, workerURL, origin, fetcher);
      } catch (error) {
        // Do not expose a thrown fetch error: it can include signed URLs or other
        // target credentials. This Worker never logs URLs, headers, or passwords.
        return errorResponse(error instanceof ProxyError ? error
          : new ProxyError(502, 'PROXY_FAILED', 'The Worker could not complete this request. Retry or inspect the Worker configuration.'), origin);
      }
    }
  };
}

export default createProxyWorker();
