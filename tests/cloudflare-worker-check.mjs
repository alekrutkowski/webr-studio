import assert from 'node:assert/strict';
import proxyWorker, { createProxyWorker } from '../cloudflare-worker/worker.js';

const appOrigin = 'https://studio.example.com';
const otherOrigin = 'http://localhost:8000';
const endpoint = 'https://webr-proxy.example.workers.dev/';
// A deterministic test fixture only. Deployment configuration contains no token.
const password = 'fixture-only-random-looking-password-0123456789abcdef';
const env = { ALLOWED_ORIGINS: `${appOrigin}, ${otherOrigin}`, PROXY_TOKEN: password };
const dataURL = 'https://data.webr-test.example/data.csv';
const binary = Uint8Array.of(0, 1, 255, 128, 13, 10, 65, 0);
const calls = [];
let responder = async () => new Response(binary.slice(), {
  status: 200, headers: { 'Content-Type': 'application/octet-stream' }
});
const worker = createProxyWorker({ fetcher: async (url, options) => {
  calls.push({ url, options });
  return responder(url, options);
} });
assert.equal(typeof proxyWorker.fetch, 'function');

function request(message = { action: 'check' }, options = {}) {
  const headers = new Headers({
    Origin: appOrigin, 'Content-Type': 'application/json', 'X-WebR-Proxy-Token': password
  });
  for (const [name, value] of Object.entries(options.headers || {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  const method = options.method || 'POST';
  const body = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? undefined
    : options.rawBody !== undefined ? options.rawBody : JSON.stringify(message);
  return new Request(options.url || endpoint, {
    method, headers, body, signal: options.signal,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {})
  });
}

async function failure(message, options, expectedStatus, expectedCode, runtimeEnv = env) {
  const before = calls.length;
  const response = await worker.fetch(request(message, options), runtimeEnv);
  assert.equal(response.status, expectedStatus);
  assert.equal(response.headers.get('X-WebR-Proxy-Version'), '1');
  assert.equal(response.headers.get('X-WebR-Proxy-Error'), expectedCode);
  assert.equal(response.headers.get('X-WebR-Upstream-Status'), null);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const result = await response.json();
  assert.equal(result.code, expectedCode);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length < 400);
  assert.equal(calls.length, before, 'Rejected client input must not reach an upstream server.');
  return response;
}

// Both configuration values are mandatory. A partially invalid origin list
// fails closed, rather than silently allowing whichever entries happen to work.
for (const runtimeEnv of [
  {}, { PROXY_TOKEN: password }, { ALLOWED_ORIGINS: appOrigin },
  { ...env, PROXY_TOKEN: '' }, { ...env, PROXY_TOKEN: 'short' },
  { ...env, PROXY_TOKEN: 'x'.repeat(257) }, { ...env, PROXY_TOKEN: ' '.repeat(32) },
  { ...env, PROXY_TOKEN: 'é'.repeat(32) },
  ...['', '*', 'https://*.example.com', 'null', 'https://studio.example.com/', `${appOrigin},*`,
    `${appOrigin},`, 'https://studio.example.com/path', 'file://',
    'https://name:password@studio.example.com', 'https://studio.example.com?query']
    .map(ALLOWED_ORIGINS => ({ ...env, ALLOWED_ORIGINS }))
]) {
  const response = await failure(undefined, {}, 503, 'PROXY_NOT_CONFIGURED', runtimeEnv);
  const trustedOrigin = [appOrigin, env.ALLOWED_ORIGINS].includes(runtimeEnv.ALLOWED_ORIGINS);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), trustedOrigin ? appOrigin : null);
}
for (const origin of [null, 'null', 'https://unlisted.example.com', 'https://studio.example.com.evil.example']) {
  const response = await failure(undefined, { headers: { Origin: origin } }, 403, 'ORIGIN_NOT_ALLOWED');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
}
for (const token of [null, '', 'incorrect', `${password}x`, `${password.slice(0, -1)}z`]) {
  const response = await failure(undefined, { headers: { 'X-WebR-Proxy-Token': token } }, 401, 'AUTH_REQUIRED');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), appOrigin);
}

for (const origin of [appOrigin, otherOrigin]) {
  const response = await worker.fetch(request(undefined, { headers: { Origin: origin } }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-WebR-Proxy-Version'), '1');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(response.headers.get('X-WebR-Upstream-Status'), null);
  assert.deepEqual(await response.json(), { service: 'webr-studio-cors-proxy', protocol: 1 });
}
assert.equal(calls.length, 0, 'A health check must not request any external data.');

const preflight = await worker.fetch(request(undefined, {
  method: 'OPTIONS', headers: {
    'X-WebR-Proxy-Token': null,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type, X-WebR-Proxy-Token'
  }
}), env);
assert.equal(preflight.status, 204);
assert.equal(await preflight.text(), '');
assert.equal(preflight.headers.get('X-WebR-Proxy-Version'), '1');
assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), appOrigin);
assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST');
assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Content-Type, X-WebR-Proxy-Token');
assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null);
const withoutSecret = { ALLOWED_ORIGINS: appOrigin };
const configurationPreflight = await worker.fetch(request(undefined, {
  method: 'OPTIONS', headers: {
    'X-WebR-Proxy-Token': null,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type, x-webr-proxy-token'
  }
}), withoutSecret);
assert.equal(configurationPreflight.status, 204, 'Trusted pages can preflight and read a missing-secret explanation.');
assert.equal(configurationPreflight.headers.get('Access-Control-Allow-Origin'), appOrigin);
const configurationFailure = await failure(undefined, {}, 503, 'PROXY_NOT_CONFIGURED', withoutSecret);
assert.equal(configurationFailure.headers.get('Access-Control-Allow-Origin'), appOrigin);
assert.ok(configurationFailure.headers.get('Access-Control-Expose-Headers').includes('X-WebR-Proxy-Error'));
const deniedConfigurationPreflight = await worker.fetch(request(undefined, {
  method: 'OPTIONS', headers: { Origin: 'https://unlisted.example.com', 'Access-Control-Request-Method': 'POST' }
}), withoutSecret);
assert.equal(deniedConfigurationPreflight.status, 403);
assert.equal(deniedConfigurationPreflight.headers.get('Access-Control-Allow-Origin'), null);
assert.equal(calls.length, 0, 'Configuration errors and preflights never send upstream requests.');
for (const headers of [
  { 'Access-Control-Request-Method': 'GET' },
  { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization' },
  { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'X-Unknown' }
]) await failure(undefined, { method: 'OPTIONS', headers }, 403, 'PREFLIGHT_REJECTED');
await failure(undefined, { method: 'GET' }, 405, 'METHOD_NOT_ALLOWED');
await failure(undefined, { url: `${endpoint}proxy` }, 404, 'INVALID_ENDPOINT');
await failure(undefined, { url: `${endpoint}?url=data` }, 404, 'INVALID_ENDPOINT');
await failure(undefined, { url: endpoint.replace('https:', 'http:') }, 400, 'HTTPS_REQUIRED');
for (const url of ['http://localhost:8787/', 'http://127.0.0.1:8787/', 'http://127.0.0.2:8787/', 'http://[::1]:8787/']) {
  assert.equal((await worker.fetch(request(undefined, { url }), env)).status, 200);
}

await failure(undefined, { headers: { 'Content-Type': 'text/plain' } }, 415, 'INVALID_CONTENT_TYPE');
for (const rawBody of ['', 'not json', 'null', '[]', '"check"']) {
  await failure(undefined, { rawBody }, 400, 'INVALID_REQUEST');
}
await failure(undefined, { rawBody: Uint8Array.of(0xff, 0xfe) }, 400, 'INVALID_REQUEST');
await failure({ action: 'unknown' }, {}, 400, 'INVALID_ACTION');
await failure(undefined, { headers: { 'Content-Length': String(64 * 1024 + 1) } }, 413, 'REQUEST_TOO_LARGE');
await failure(undefined, { rawBody: ' '.repeat(64 * 1024 + 1) }, 413, 'REQUEST_TOO_LARGE');

const blockedTargets = [
  undefined, null, 42, '', 'not-a-url', 'ftp://data.example.com/a', 'file:///etc/passwd',
  'data:text/plain,hello', 'https://person:password@data.example.com/',
  'http://localhost/', 'http://LOCALHOST./', 'http://db/', 'http://db.internal/',
  'http://metadata.google.internal/', 'http://my-router.local/', 'http://router.home.arpa/',
  'http://host.lan/', 'http://invalid/', 'http://host.invalid/', 'http://host.onion/',
  'http://0.0.0.0/', 'http://10.1.2.3/', 'http://100.64.0.1/', 'http://100.127.255.254/',
  'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/',
  'http://0177.0.0.1/', 'http://%31%32%37.0.0.1/', 'http://169.254.169.254/',
  'http://172.16.0.1/', 'http://172.31.255.1/', 'http://192.168.1.2/',
  'http://192.0.0.1/', 'http://192.0.2.1/', 'http://192.88.99.1/',
  'http://198.18.0.1/', 'http://198.19.255.1/', 'http://198.51.100.1/',
  'http://203.0.113.1/', 'http://224.0.0.1/', 'http://240.1.1.1/', 'http://255.255.255.255/',
  'http://[::]/', 'http://[::1]/', 'http://[fc00::1]/', 'http://[fd00:ec2::254]/',
  'http://[fe80::1]/', 'http://[ff02::1]/', 'http://[::ffff:127.0.0.1]/',
  'http://[::ffff:7f00:1]/', 'http://[64:ff9b::7f00:1]/',
  'http://[2001::1]/', 'http://[2001:db8::1]/', 'http://[2002:7f00:1::]/',
  'http://[3fff::1]/', 'http://[3ffe::1]/',
  endpoint, `${endpoint}somewhere`, 'https://data..example.com/',
  'https://-data.example.com/', 'https://data.example.com/\nsecret',
  'https://data.example.com/\\path', `https://data.example.com/${'x'.repeat(16 * 1024)}`
];
for (const url of blockedTargets) await failure({ action: 'fetch', url }, {}, 400, 'INVALID_TARGET');
for (const url of [
  dataURL, 'https://1.1.1.1/data', 'http://8.8.8.8/data',
  'https://[2606:4700:4700::1111]/data', 'https://[2001:4860:4860::8888]/data',
  'https://bücher.de/data', 'https://data.example.com./data#fragment'
]) {
  const response = await worker.fetch(request({ action: 'fetch', url }), env);
  assert.equal(response.status, 200, url);
  assert.equal(response.headers.get('X-WebR-Upstream-Status'), '200');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), binary);
  assert.equal(calls.at(-1).options.method, 'GET');
  assert.equal(calls.at(-1).options.redirect, 'manual');
  assert.equal(calls.at(-1).options.cache, 'no-store');
  assert.equal(new URL(calls.at(-1).url).hash, '');
}

for (const headers of [
  null, [], 'Authorization: abc', { Authorization: 123 },
  { 'X-Test': 'first\r\nsecond' }, { 'Invalid Header': 'one' },
  { ' X-WebR-Proxy-Token': password }, { 'X-WebR-Proxy-Token ': password },
  { 'x-webr-bad header': 'one' }, { 'Host ': 'evil.example' },
  { 'X-Large': 'x'.repeat(16 * 1024) },
  Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`X-${index}`, 'one']))
]) await failure({ action: 'fetch', url: dataURL, headers }, {}, 400, 'INVALID_HEADERS');

const protectedHeaders = {
  Cookie: 'target-cookie=forbidden', Cookie2: 'legacy=forbidden', Host: 'evil.example',
  Origin: 'https://evil.example', Referer: 'https://evil.example/secret',
  'X-WebR-Proxy-Token': password, 'X-WebR-Proxy-Version': 'evil',
  'Proxy-Authorization': 'Basic forbidden', Connection: 'keep-alive',
  'Content-Length': '99999', 'Transfer-Encoding': 'chunked',
  'X-Forwarded-For': '127.0.0.1', 'CF-Connecting-IP': '127.0.0.1',
  'Sec-Fetch-Site': 'same-origin', 'Access-Control-Allow-Origin': '*'
};
const withHeaders = await worker.fetch(request({
  action: 'fetch', url: dataURL, method: 'POST', body: 'never-forwarded',
  headers: { ...protectedHeaders, Authorization: 'Bearer target-credential', 'X-Dataset-Key': 'dataset-secret', Accept: 'text/csv' }
}, { headers: { Cookie: 'browser-cookie=forbidden', Authorization: 'browser-auth-forbidden' } }), env);
assert.equal(withHeaders.status, 200);
assert.equal(calls.at(-1).options.method, 'GET');
assert.equal(calls.at(-1).options.body, undefined);
const forwarded = calls.at(-1).options.headers;
assert.equal(forwarded.get('Authorization'), 'Bearer target-credential');
assert.equal(forwarded.get('X-Dataset-Key'), 'dataset-secret');
assert.equal(forwarded.get('Accept'), 'text/csv');
for (const name of Object.keys(protectedHeaders)) assert.equal(forwarded.get(name), null, name);

// Upstream errors are data-server responses, distinct from proxy failures.
for (const status of [200, 206, 400, 401, 403, 404, 429, 500, 503]) {
  responder = async () => new Response(binary.slice(), { status, headers: {
    'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="data.bin"',
    'Set-Cookie': 'upstream-cookie=do-not-set', 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': 'true', 'X-WebR-Proxy-Version': 'invalid',
    'X-WebR-Upstream-Status': '999', 'X-WebR-Proxy-Error': 'SPOOFED',
    'Cache-Control': 'public, max-age=9999'
  } });
  const response = await worker.fetch(request({ action: 'fetch', url: dataURL }), env);
  assert.equal(response.status, status);
  assert.equal(response.headers.get('X-WebR-Upstream-Status'), String(status));
  assert.equal(response.headers.get('X-WebR-Proxy-Version'), '1');
  assert.equal(response.headers.get('X-WebR-Proxy-Error'), null);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), appOrigin);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  for (const name of ['X-WebR-Proxy-Version', 'X-WebR-Upstream-Status', 'X-WebR-Proxy-Error']) {
    assert.ok(response.headers.get('Access-Control-Expose-Headers').includes(name));
  }
  assert.equal(response.headers.get('Content-Disposition'), 'attachment; filename="data.bin"');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), binary);
}
for (const status of [204, 205, 304]) {
  responder = async () => new Response(null, { status });
  const response = await worker.fetch(request({ action: 'fetch', url: dataURL }), env);
  assert.equal(response.status, status);
  assert.equal(response.headers.get('X-WebR-Upstream-Status'), String(status));
  assert.equal(response.body, null);
  assert.equal((await response.arrayBuffer()).byteLength, 0);
}

// Five redirects may be followed, all as GET. Every hop is checked again;
// response bodies are cancelled so they do not exhaust connection slots.
let redirectCount = 0;
let cancellations = 0;
responder = async () => {
  if (redirectCount++ < 5) return new Response(new ReadableStream({ cancel() { cancellations++; } }), {
    status: 302, headers: { Location: `/step-${redirectCount}` }
  });
  return new Response(binary.slice());
};
let before = calls.length;
let response = await worker.fetch(request({ action: 'fetch', url: dataURL }), env);
assert.equal(response.status, 200);
assert.equal(calls.length - before, 6);
assert.equal(cancellations, 5);
assert.deepEqual(new Uint8Array(await response.arrayBuffer()), binary);
responder = async () => new Response('redirect', { status: 307, headers: { Location: '/again' } });
before = calls.length;
response = await worker.fetch(request({ action: 'fetch', url: dataURL }), env);
assert.equal(response.status, 502);
assert.equal(response.headers.get('X-WebR-Proxy-Error'), 'REDIRECT_LIMIT');
assert.equal(calls.length - before, 6);

for (const location of ['http://127.1/secret', 'http://[::ffff:7f00:1]/secret', 'http://metadata.google.internal/', 'ftp://data.example.com/a', 'https://user:secret@data.example.com/a']) {
  responder = async () => new Response(null, { status: 302, headers: { Location: location } });
  before = calls.length;
  response = await worker.fetch(request({ action: 'fetch', url: dataURL }), env);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('X-WebR-Proxy-Error'), 'INVALID_REDIRECT');
  assert.equal(calls.length - before, 1, 'A forbidden redirect target must never be fetched.');
  assert.equal(JSON.stringify(await response.json()).includes(location), false, 'Do not echo signed URLs or credentials.');
}

responder = async url => {
  if (url === dataURL) return new Response(null, { status: 301, headers: { Location: '/same-origin' } });
  if (url.endsWith('/same-origin')) return new Response(null, { status: 308, headers: { Location: 'https://cdn.example.com/data' } });
  return new Response(binary.slice());
};
before = calls.length;
response = await worker.fetch(request({ action: 'fetch', url: dataURL, headers: {
  Authorization: 'Bearer target-secret', 'X-Dataset-Key': 'custom-secret',
  Accept: 'text/csv', 'Accept-Language': 'en', Range: 'bytes=0-9'
} }), env);
assert.equal(response.status, 200);
const redirects = calls.slice(before);
assert.equal(redirects.length, 3);
assert.equal(redirects[1].options.headers.get('Authorization'), 'Bearer target-secret');
assert.equal(redirects[1].options.headers.get('X-Dataset-Key'), 'custom-secret');
assert.equal(redirects[2].options.headers.get('Authorization'), null);
assert.equal(redirects[2].options.headers.get('X-Dataset-Key'), null);
assert.equal(redirects[2].options.headers.get('Accept'), 'text/csv');
assert.equal(redirects[2].options.headers.get('Accept-Language'), 'en');
assert.equal(redirects[2].options.headers.get('Range'), 'bytes=0-9');

responder = async () => { throw new Error(`secret diagnostics: ${dataURL}?api_key=hidden ${password}`); };
response = await worker.fetch(request({ action: 'fetch', url: dataURL }), env);
assert.equal(response.status, 502);
assert.equal(response.headers.get('X-WebR-Proxy-Error'), 'UPSTREAM_FETCH_FAILED');
const errorText = await response.text();
assert.doesNotMatch(errorText, /api_key|hidden|fixture-only/);
assert.equal(response.headers.get('X-WebR-Upstream-Status'), null);

// A stream that remains open must return immediately from the Worker. This
// would deadlock if the handler attempted arrayBuffer(), text(), or JSON parsing.
let streamController;
const stream = new ReadableStream({ start(controller) {
  streamController = controller;
  controller.enqueue(binary.slice(0, 3));
} });
responder = async () => new Response(stream);
let timeout;
try {
  response = await Promise.race([
    worker.fetch(request({ action: 'fetch', url: dataURL }), env),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Worker buffered the upstream stream.')), 1000); })
  ]);
} finally { clearTimeout(timeout); }
assert.equal(response.body, stream);
const reader = response.body.getReader();
assert.deepEqual((await reader.read()).value, binary.slice(0, 3));
streamController.enqueue(binary.slice(3));
streamController.close();
assert.deepEqual((await reader.read()).value, binary.slice(3));
assert.equal((await reader.read()).done, true);

const abort = new AbortController();
let upstreamSignal;
responder = async (_url, options) => { upstreamSignal = options.signal; return new Response(binary.slice()); };
await worker.fetch(request({ action: 'fetch', url: dataURL }, { signal: abort.signal }), env);
abort.abort();
assert.equal(upstreamSignal.aborted, true, 'Forward client cancellation to the upstream fetch.');

console.log('Cloudflare Worker checks passed: authentication, exact CORS, public targets, safe headers, redirects, raw statuses/binary, streaming, and errors.');
