import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { getHookSource, NetworkBridge } from '../js/network-bridge.js';

const endpoint = 'https://studio.example/repository/__webr_studio_network__/';
const token = 'a'.repeat(48);
const payload = new Uint8Array([0, 255, 128, 65, 10]).buffer;
const requests = [];
const errors = [];
let returnedStatus = 200;
let returnedProtocol = '1';
let returnedBody = payload;
const runtime = {
  downloadFileContent(...args) { return { original: true, receiver: this, args }; }
};
class FakeXHR {
  open(method, url, asynchronous) { this.method = method; this.url = url; this.asynchronous = asynchronous; }
  setRequestHeader(name, value) { this.header = [name, value]; }
  send(body) { requests.push({ xhr: this, body: JSON.parse(body) }); this.response = returnedBody; }
  getResponseHeader(name) {
    if (name === 'X-WebR-Network-Protocol') return returnedProtocol;
    if (name === 'X-WebR-Network-Status') return String(returnedStatus);
    return null;
  }
}
const hookContext = vm.createContext({
  Module: runtime, URL, XMLHttpRequest: FakeXHR, ArrayBuffer, TextDecoder,
  console: { error: message => errors.push(message) }
});
const hook = getHookSource({ endpoint, clientId: 'tab-a', token });
vm.runInContext(hook, hookContext);
const result = runtime.downloadFileContent('https://data.example/file.bin?x=1', ['Authorization: Bearer a:b:c', 'X-Custom: one: two'], 7);
assert.equal(result.status, 200);
assert.deepEqual(new Uint8Array(result.response), new Uint8Array(payload), 'binary bytes must reach R unchanged');
assert.deepEqual(requests[0].body.headers, [['Authorization', 'Bearer a:b:c'], ['X-Custom', 'one: two']], 'header values containing colons must survive');
assert.equal(requests[0].body.maxRedirects, 7);
assert.equal(requests[0].body.clientId, 'tab-a');
assert.equal(requests[0].body.token, token);
assert.equal(requests[0].xhr.method, 'POST');
assert.equal(requests[0].xhr.url, endpoint, 'target URLs and credentials must not enter the bridge URL');
assert.equal(requests[0].xhr.asynchronous, false);
assert.equal(requests[0].xhr.timeout, 135_000);
assert.equal(requests[0].xhr.responseType, 'arraybuffer');

const local = runtime.downloadFileContent('file:///project/local.csv', ['X-Test: yes'], 2);
assert.equal(local.original, true);
assert.equal(local.receiver, runtime);
assert.deepEqual(local.args, ['file:///project/local.csv', ['X-Test: yes'], 2]);
const firstOriginal = runtime.__webrStudioNetworkDownload.original;
vm.runInContext(hook, hookContext);
assert.equal(runtime.__webrStudioNetworkDownload.original, firstOriginal, 'installing twice must not wrap the previous bridge');
returnedStatus = 404;
assert.equal(runtime.downloadFileContent('https://data.example/missing').status, 404, 'HTTP errors must remain errors for R');
returnedStatus = 0;
returnedBody = new TextEncoder().encode('Exit node is offline.').buffer;
assert.equal(runtime.downloadFileContent('https://data.example/offline').response, 'Exit node is offline.');
returnedProtocol = null;
assert.match(runtime.downloadFileContent('https://data.example/no-worker').response, /bridge is unavailable/i, 'a static-host fallback page must never become downloaded data');
const beforeInvalid = requests.length;
assert.equal(runtime.downloadFileContent('https://data.example', ['X-Test: good\r\nInjected: bad']).status, 0);
assert.equal(runtime.downloadFileContent('https://data.example', [], 0).status, 400);
assert.equal(requests.length, beforeInvalid, 'invalid requests must not reach the transport');
assert.throws(() => getHookSource({ endpoint, clientId: 'tab-a', token: '' }), /not initialized/);

// Run the actual service worker and page bridge together with real
// MessageChannels. Only the network transport is substituted.
const savedGlobals = new Map(['navigator', 'location', 'isSecureContext'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const listeners = new Map();
const clients = new Map();
let directFetches = 0;
const source = readFileSync(new URL('../coi-serviceworker.js', import.meta.url), 'utf8');
const serviceLocation = new URL('https://studio.example/repository/coi-serviceworker.js');
const service = {
  location: serviceLocation,
  addEventListener(name, callback) { listeners.set(name, callback); },
  clients: { get: async id => clients.get(id), claim: async () => {} },
  skipWaiting() {}
};
vm.runInNewContext(source, {
  self: service, URL, Response, Headers, Request, TextEncoder, ArrayBuffer, MessageChannel,
  setTimeout, clearTimeout,
  fetch: async () => { directFetches += 1; return new Response('ordinary asset'); },
  caches: { match: async () => undefined }
});
function makeContainer(id) {
  const container = new EventTarget();
  const client = {
    id,
    type: 'window',
    url: `https://studio.example/repository/index.html?tab=${id}`,
    postMessage(data, ports) {
      const event = new Event('message');
      Object.assign(event, { data: structuredClone(data), ports, source: container.controller, origin: serviceLocation.origin });
      container.dispatchEvent(event);
    }
  };
  container.controller = {
    scriptURL: serviceLocation.href,
    postMessage(data, ports) { listeners.get('message')({ data, ports, source: client }); }
  };
  container.ready = Promise.resolve({ active: container.controller });
  clients.set(id, client);
  return container;
}
function chooseContainer(container) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker: container } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('https://studio.example/repository/index.html') });
  Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });
}
function dispatchRequest(body, method = 'POST') {
  let response;
  listeners.get('fetch')({
    request: new Request(endpoint, { method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }),
    respondWith(value) { response = value; },
    waitUntil() {}
  });
  return response;
}
const networkBody = bridge => ({
  protocol: 1, clientId: bridge.clientId, token: bridge.token,
  url: 'https://no-cors.example/file.bin', method: 'GET', headers: [['X-Test', 'a:b']], maxRedirects: 10
});

const containerA = makeContainer('owner-a');
const containerB = makeContainer('owner-b');
const callsA = [];
const callsB = [];
let responseA = { status: 206, statusText: 'Partial Content', body: payload.slice(0) };
let pendingRequest = false;
const bridgeA = new NetworkBridge({ download: async request => {
  callsA.push(request);
  if (pendingRequest) return new Promise(() => {});
  return { ...responseA, body: responseA.body.slice(0) };
} });
const bridgeB = new NetworkBridge({ download: async request => {
  callsB.push(request);
  return { status: 200, body: new TextEncoder().encode('tab B') };
} });
try {
  chooseContainer(containerA);
  await bridgeA.initialize();
  assert.equal(bridgeA.endpoint, endpoint, 'GitHub Pages subdirectory must be preserved');
  assert.equal(bridgeA.clientId, 'owner-a');
  assert.match(bridgeA.token, /^[a-f0-9]{48}$/);
  chooseContainer(containerB);
  await bridgeB.initialize();
  const [downloadA, downloadB] = await Promise.all([dispatchRequest(networkBody(bridgeA)), dispatchRequest(networkBody(bridgeB))]);
  assert.equal(downloadA.headers.get('X-WebR-Network-Status'), '206');
  assert.equal(downloadA.status, 200, 'the private endpoint must not expose upstream redirects');
  assert.equal(downloadA.headers.get('Cache-Control'), 'no-store, private');
  assert.deepEqual(new Uint8Array(await downloadA.arrayBuffer()), new Uint8Array(payload));
  assert.equal(await downloadB.text(), 'tab B');
  assert.equal(callsA.length, 1);
  assert.equal(callsB.length, 1);
  assert.deepEqual(callsA[0].headers, [['X-Test', 'a:b']]);
  assert.equal(callsA[0].method, 'GET');
  assert.ok(callsA[0].signal instanceof AbortSignal);

  const wrongTab = await dispatchRequest({ ...networkBody(bridgeA), clientId: bridgeB.clientId });
  assert.equal(wrongTab.headers.get('X-WebR-Network-Status'), '0');
  assert.match(await wrongTab.text(), /different or closed tab/);
  assert.equal(callsB.length, 1, 'a token from another tab must not invoke the transport');

  const missingOwner = await dispatchRequest({ ...networkBody(bridgeA), clientId: 'closed-tab' });
  assert.equal(missingOwner.headers.get('X-WebR-Network-Status'), '0');
  assert.match(await missingOwner.text(), /owning this connection is closed/);
  const forbiddenProtocol = await dispatchRequest({ ...networkBody(bridgeA), url: 'file:///etc/passwd' });
  assert.equal(forbiddenProtocol.headers.get('X-WebR-Network-Status'), '0');
  assert.equal(callsA.length, 1);
  const invalidHeader = await dispatchRequest({ ...networkBody(bridgeA), headers: [['X-Test', 'ok\nBad: x']] });
  assert.equal(invalidHeader.headers.get('X-WebR-Network-Status'), '0');
  const wrongMethod = await dispatchRequest(undefined, 'GET');
  assert.equal(wrongMethod.headers.get('X-WebR-Network-Status'), '0');
  assert.equal(directFetches, 0, 'failed bridge requests must never leak to an origin server');

  responseA = { status: 404, statusText: 'Not Found', body: new TextEncoder().encode('not found').buffer };
  const notFound = await dispatchRequest(networkBody(bridgeA));
  assert.equal(notFound.headers.get('X-WebR-Network-Status'), '404');
  assert.equal(await notFound.text(), 'not found');
  responseA = { status: 302, statusText: 'Found', body: new ArrayBuffer(0), headers: [['Location', 'https://unexpected.example'], ['Set-Cookie', 'remote=secret']] };
  const redirect = await dispatchRequest(networkBody(bridgeA));
  assert.equal(redirect.headers.get('X-WebR-Network-Status'), '302');
  assert.equal(redirect.headers.get('Location'), null);
  assert.equal(redirect.headers.get('Set-Cookie'), null);

  // A service-worker restart loses all globals. The endpoint can still find
  // exactly the owner from the request without a broadcast or token database.
  vm.runInNewContext(source, {
    self: service, URL, Response, Headers, Request, TextEncoder, ArrayBuffer, MessageChannel,
    setTimeout, clearTimeout,
    fetch: async () => { directFetches += 1; return new Response('ordinary asset'); },
    caches: { match: async () => undefined }
  });
  responseA = { status: 200, body: payload.slice(0) };
  const afterRestart = await dispatchRequest(networkBody(bridgeA));
  assert.equal(afterRestart.headers.get('X-WebR-Network-Status'), '200');
  assert.deepEqual(new Uint8Array(await afterRestart.arrayBuffer()), new Uint8Array(payload));

  let installedRCode = '';
  await bridgeA.install({ evalRVoid: async code => { installedRCode = code; } });
  assert.match(installedRCode, /^webr::eval_js\(/);
  const installedJavaScript = JSON.parse(installedRCode.slice('webr::eval_js('.length, -1));
  assert.equal(installedJavaScript, bridgeA.getHookSource(), 'the R string must preserve the complete worker hook');

  pendingRequest = true;
  const pending = dispatchRequest(networkBody(bridgeA));
  await new Promise(resolve => setTimeout(resolve, 10));
  const lastCall = callsA.at(-1);
  bridgeA.dispose();
  const cancelled = await pending;
  assert.equal(cancelled.headers.get('X-WebR-Network-Status'), '0');
  assert.match(await cancelled.text(), /connection was closed/);
  assert.equal(lastCall.signal.aborted, true, 'closing the bridge must abort the transport');
  assert.equal(bridgeA.pending.size, 0);
  assert.equal(directFetches, 0);
} finally {
  bridgeA.dispose();
  bridgeB.dispose();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}

console.log('Network bridge checks passed: binary downloads, headers, errors, tab isolation, service-worker restart, and cancellation.');
