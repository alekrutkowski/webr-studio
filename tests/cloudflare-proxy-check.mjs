import assert from 'node:assert/strict';
import { CloudflareProxyClient } from '../js/cloudflare-proxy.js';
import { TailscaleNetwork } from '../js/network.js';
import { validateNetworkMode, validateProxyUrl, validateProxyToken } from '../js/network-common.js';

const endpoint = 'https://downloads.example.org/';
const secondEndpoint = 'https://other-proxy.example.org/';
const token = 'test-shared-token-with-at-least-32-characters';
const secondToken = 'another-test-shared-token-with-at-least-32-characters';
const binary = Uint8Array.from([0, 127, 128, 255, 10, 13]);
const health = () => new Response(JSON.stringify({ service: 'webr-studio-cors-proxy', protocol: 1 }), {
  headers: { 'X-WebR-Proxy-Version': '1', 'Content-Type': 'application/json' }
});
const data = (status = 200, body = binary) => new Response([204, 205, 304].includes(status) ? null : body, {
  status, headers: { 'X-WebR-Proxy-Version': '1', 'X-WebR-Upstream-Status': String(status) }
});
const failure = (message, status = 401) => new Response(JSON.stringify({ error: message, code: 'AUTH_REQUIRED' }), {
  status, headers: { 'X-WebR-Proxy-Version': '1', 'X-WebR-Proxy-Error': 'AUTH_REQUIRED' }
});
const pending = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

for (const mode of ['browser', 'tailscale', 'cloudflare']) assert.equal(validateNetworkMode(mode), mode);
assert.throws(() => validateNetworkMode('automatic'), /Choose Browser/);
for (const url of [endpoint, 'https://example.workers.dev/', 'http://localhost:8787/', 'http://127.0.0.2:8787/', 'http://[::1]:8787/']) {
  assert.equal(validateProxyUrl(url), url);
}
assert.equal(validateProxyUrl('https://downloads.example.org'), endpoint);
for (const url of [
  'http://downloads.example.org/', 'file:///tmp/proxy', 'ftp://example.org/',
  'https://user:password@example.org/', 'https://example.org/?token=secret',
  'https://example.org/#secret', 'https://example.org/?', 'https://example.org/#',
  'https://example.org/incorrect-path', 'not a URL'
]) assert.throws(() => validateProxyUrl(url));
assert.equal(validateProxyToken(token), token);
for (const bad of ['', 'short', ` ${token}`, `${token} `, `${token} contains spaces`, `${token}\n`, `${token}é`, 'x'.repeat(257), null, 123]) {
  assert.throws(() => validateProxyToken(bad), /shared token/);
}
assert.throws(() => new CloudflareProxyClient({ url: `https://${token}.example.org/`, token }), /Keep the shared token out/);

const calls = [];
let reply = payload => payload.action === 'check' ? health() : data();
const fetcher = async (url, options) => {
  const payload = JSON.parse(options.body);
  calls.push({ url, options, payload });
  return reply(payload, options, url);
};
const controller = new TailscaleNetwork({ fetcher, refreshInterval: 0 });
await assert.rejects(controller.useCloudflare({ url: endpoint, token }), /Wait for R/);
assert.equal(controller.state.mode, 'cloudflare');
assert.equal(controller.state.phase, 'error');
assert.equal(calls.length, 0, 'No proxy connection starts before the R bridge is ready.');
controller.setBridgeReady(true);
await controller.useCloudflare({ url: endpoint, token });
assert.equal(controller.state.mode, 'cloudflare');
assert.equal(controller.state.phase, 'connected');
assert.equal(controller.state.proxyUrl, endpoint);
assert.equal(controller.worker, null);
assert.equal(controller.state.dnsMode, 'exit-node');
assert.deepEqual(calls[0].payload, { action: 'check' });
const result = await controller.download({
  url: 'https://data.example.org/file.bin',
  headers: [['Authorization', 'Bearer upstream:a:b'], ['X-Data', 'a:b:c']]
});
assert.deepEqual(new Uint8Array(result.body), binary);
const request = calls.at(-1);
assert.equal(request.url, endpoint);
assert.equal(request.options.method, 'POST');
assert.equal(request.options.credentials, 'omit');
assert.equal(request.options.referrerPolicy, 'no-referrer');
assert.equal(request.options.cache, 'no-store');
assert.equal(request.options.redirect, 'error');
assert.equal(request.options.headers['X-WebR-Proxy-Token'], token);
assert.equal(request.options.headers['Content-Type'], 'application/json');
assert.equal(request.options.headers.Authorization, undefined, 'Target authorization must not authenticate the Worker.');
assert.deepEqual(request.payload, {
  action: 'fetch', url: 'https://data.example.org/file.bin',
  headers: { authorization: 'Bearer upstream:a:b', 'x-data': 'a:b:c' }
});
assert.ok(!request.options.body.includes(token), 'The proxy token must not enter the upstream request payload.');
assert.ok(!request.url.includes(token));
assert.ok(!JSON.stringify(controller).includes(token), 'Public controller state must never serialize the private token.');
assert.equal(Object.hasOwn(controller.state, 'token'), false);
assert.equal((await controller.test('https://data.example.org/file.bin')).bytes, binary.length);
await controller.refresh();
assert.equal(calls.at(-1).payload.action, 'fetch', 'Proxy refresh must not issue a Tailscale status RPC.');
await assert.rejects(controller.setDNSMode('cloudflare'), /Connect to Tailscale/);
await assert.rejects(controller.setExitNode('exit-1'), /Connect to Tailscale/);
await assert.rejects(controller.diagnose(), /Connect to Tailscale/);

reply = () => data(404, 'upstream not found');
const notFound = await controller.download({ url: 'https://data.example.org/missing' });
assert.equal(notFound.status, 404, 'An upstream HTTP failure is data for R, not a proxy connection failure.');
assert.equal(new TextDecoder().decode(notFound.body), 'upstream not found');
assert.equal(controller.state.phase, 'connected');
await assert.rejects(controller.test('https://data.example.org/missing'), /HTTP 404/);
for (const status of [204, 205, 304]) {
  reply = () => data(status);
  const empty = await controller.download({ url: 'https://data.example.org/empty' });
  assert.equal(empty.status, status);
  assert.equal(empty.body.byteLength, 0);
}

for (const badResponse of [
  () => new Response('<!doctype html>Static fallback page'),
  () => new Response(binary, { headers: { 'X-WebR-Proxy-Version': '2', 'X-WebR-Upstream-Status': '200' } }),
  () => new Response(binary, { headers: { 'X-WebR-Proxy-Version': '1' } }),
  () => new Response(binary, { headers: { 'X-WebR-Proxy-Version': '1', 'X-WebR-Upstream-Status': '404' } }),
  () => new Response(binary, { headers: { 'X-WebR-Proxy-Version': '1', 'X-WebR-Upstream-Status': '0200' } })
]) {
  reply = badResponse;
  const before = calls.length;
  await assert.rejects(controller.download({ url: 'https://data.example.org/data' }), /proxy protocol|invalid upstream/);
  assert.equal(calls.length, before + 1, 'A malformed proxy result must not retry through another provider.');
  assert.equal(controller.state.mode, 'cloudflare');
}
reply = () => failure(`Rejected private token ${token}`);
await assert.rejects(controller.download({ url: 'https://data.example.org/data' }), error => {
  assert.ok(!error.message.includes(token));
  assert.match(error.message, /\[redacted\]/);
  assert.equal(error.cause, undefined, 'Errors must not retain an unsanitized cause.');
  return true;
});
assert.ok(!JSON.stringify(controller.state).includes(token));
reply = () => { throw new Error(`An injected fetch failure echoed ${token}`); };
await assert.rejects(controller.download({ url: 'https://data.example.org/data' }), error => {
  assert.ok(!error.message.includes(token));
  assert.match(error.message, /ALLOWED_ORIGINS/);
  return true;
});

for (const badHealth of [
  () => new Response('<!doctype html>Static page'),
  () => new Response('not json', { headers: { 'X-WebR-Proxy-Version': '1' } }),
  () => new Response(JSON.stringify({ service: 'other', protocol: 1 }), { headers: { 'X-WebR-Proxy-Version': '1' } }),
  () => new Response(JSON.stringify({ service: 'webr-studio-cors-proxy', protocol: '1' }), { headers: { 'X-WebR-Proxy-Version': '1' } }),
  () => failure('The shared token is incorrect.')
]) {
  reply = badHealth;
  await assert.rejects(controller.useCloudflare({ url: endpoint, token }));
  assert.equal(controller.state.mode, 'cloudflare');
  assert.equal(controller.state.phase, 'error');
  const before = calls.length;
  await assert.rejects(controller.download({ url: 'https://data.example.org/data' }), /not connected/);
  assert.equal(calls.length, before, 'A failed handshake must never allow a data fetch or fallback.');
}
const beforeInvalid = calls.length;
await assert.rejects(controller.useCloudflare({ url: endpoint, token: 'short' }), /shared token/);
assert.equal(calls.length, beforeInvalid);
assert.equal(controller.state.mode, 'cloudflare');
assert.equal(controller.state.phase, 'error');

// Reconfiguration must cancel both a pending handshake and an in-flight body.
reply = () => health();
const oldHandshake = pending();
reply = () => oldHandshake.promise;
const staleConnection = controller.useCloudflare({ url: endpoint, token });
const oldHealthSignal = calls.at(-1).options.signal;
reply = () => health();
await controller.useCloudflare({ url: secondEndpoint, token: secondToken });
await assert.rejects(staleConnection, /cancelled/);
assert.equal(oldHealthSignal.aborted, true);
oldHandshake.resolve(failure('Old handshake failed.'));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(controller.state.phase, 'connected');
assert.equal(controller.state.proxyUrl, secondEndpoint);
assert.equal(controller.state.error, '');

const oldBody = pending();
reply = () => ({
  status: 200, statusText: 'OK', redirected: false,
  headers: new Headers({ 'X-WebR-Proxy-Version': '1', 'X-WebR-Upstream-Status': '200' }),
  arrayBuffer: () => oldBody.promise
});
const staleDownload = controller.download({ url: 'https://data.example.org/slow' });
const oldDataSignal = calls.at(-1).options.signal;
reply = () => health();
await controller.useCloudflare({ url: endpoint, token });
await assert.rejects(staleDownload, /cancelled/);
assert.equal(oldDataSignal.aborted, true);
reply = () => failure('The new route failed.');
await assert.rejects(controller.download({ url: 'https://data.example.org/new-route' }), /new route failed/);
oldBody.resolve(binary.buffer);
await new Promise(resolve => setTimeout(resolve, 0));
assert.match(controller.state.error, /new route failed/, 'Late data must not clear a newer route error.');

reply = () => new Promise(() => {});
const externalAbort = new AbortController();
const aborted = controller.download({ url: 'https://data.example.org/abort', signal: externalAbort.signal });
externalAbort.abort();
await assert.rejects(aborted, /cancelled/);
const routeDownload = controller.download({ url: 'https://data.example.org/change-route' });
const changedSignal = calls.at(-1).options.signal;
const revision = controller.routeRevision;
controller.selectMode('browser');
await assert.rejects(routeDownload, /cancelled/);
assert.equal(changedSignal.aborted, true);
assert.ok(controller.routeRevision > revision);
assert.equal(controller.state.mode, 'browser');
assert.equal(controller.state.error, '');
controller.selectMode('cloudflare');
assert.equal(controller.state.phase, 'disconnected');
assert.equal(controller.state.proxyUrl, endpoint, 'The non-secret URL may remain available for reconfiguration.');
await assert.rejects(controller.download({ url: 'https://data.example.org/no-secret' }), /not connected/);

const timeoutClient = new CloudflareProxyClient({
  url: endpoint, token, timeout: 5,
  fetcher: async () => ({
    status: 200, statusText: 'OK', headers: new Headers({ 'X-WebR-Proxy-Version': '1', 'X-WebR-Upstream-Status': '200' }),
    arrayBuffer: () => new Promise(() => {})
  })
});
await assert.rejects(timeoutClient.download({ url: 'https://data.example.org/slow', headers: {} }), /timed out/);
timeoutClient.close();
await assert.rejects(timeoutClient.check(), /cancelled/);

// Old Tailscale DNS preferences cannot leak into a proxy session or return
// when its worker sends a reply after an explicit route switch.
const workers = [];
class FixtureWorker extends EventTarget {
  constructor() {
    super();
    this.prefs = { ip: '100.64.0.2', exitNodeId: 'exit-1', dnsMode: 'exit-node', exitNodes: [{ id: 'exit-1', online: true }] };
    this.held = null;
    this.terminated = false;
  }
  reply(request, result) { this.dispatchEvent(new MessageEvent('message', { data: { id: request.id, result } })); }
  postMessage(request) {
    if (request.method === 'download') { this.held = request; return; }
    if (request.method === 'setDNSMode') this.prefs.dnsMode = request.args.mode;
    queueMicrotask(() => this.reply(request, this.prefs));
  }
  terminate() { this.terminated = true; }
}
const switching = new TailscaleNetwork({
  workerFactory: () => { const worker = new FixtureWorker(); workers.push(worker); return worker; },
  fetcher: async (url, options) => {
    assert.equal(url, endpoint, 'A routed request must not fall back to its data target.');
    return JSON.parse(options.body).action === 'check' ? health() : data();
  },
  refreshInterval: 0
});
switching.setBridgeReady(true);
await switching.connect();
await switching.setDNSMode('cloudflare');
const tailscaleDownload = switching.download({ url: 'https://data.example.org/tailscale' });
await switching.useCloudflare({ url: endpoint, token });
await assert.rejects(tailscaleDownload, /Cloudflare proxy connection/);
assert.equal(workers[0].terminated, true);
assert.equal(switching.worker, null);
assert.equal(switching.state.dnsMode, 'exit-node');
assert.equal(switching.state.exitNodeId, '');
workers[0].reply(workers[0].held, { status: 200, body: binary.buffer });
assert.equal(switching.state.mode, 'cloudflare');
await switching.connect();
assert.equal(workers.length, 2, 'connect() must start Tailscale even when the proxy is already connected.');
assert.equal(switching.state.mode, 'tailscale');
assert.equal(switching.state.dnsMode, 'exit-node');
switching.selectMode('cloudflare');
assert.equal(workers[1].terminated, true);
assert.equal(switching.state.phase, 'disconnected');
await assert.rejects(switching.download({ url: 'https://data.example.org/unconfigured' }), /not connected/);
await switching.useCloudflare({ url: endpoint, token });
switching.disconnect();
assert.equal(switching.state.mode, 'browser');
assert.ok(!JSON.stringify(switching).includes(token));

const browserRequest = pending();
const direct = new TailscaleNetwork({ fetcher: () => browserRequest.promise });
const browserDownload = direct.download({ url: 'https://data.example.org/direct' });
direct.selectMode('cloudflare');
await assert.rejects(browserDownload, /cancelled/, 'Selecting a proxy must cancel a pending browser route too.');
browserRequest.resolve(new Response(binary));
assert.equal(direct.state.mode, 'cloudflare');
direct.disconnect();
controller.disconnect();

console.log('Cloudflare proxy checks passed: explicit routes, private token, protocol/health validation, binary/status preservation, separated headers, body timeouts, cancellation, and stale reconfiguration.');
