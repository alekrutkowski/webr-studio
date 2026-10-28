import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TailscaleNetwork } from '../js/network.js';
import {
  validateDownloadUrl, validateLoginUrl, validateDNSMode, normalizeNetworkHeaders,
  normalizeNetworkSnapshot, describeNetworkConnection, describeNetworkError, networkErrorCode,
  normalizeNetworkDiagnostics
} from '../js/network-common.js';

assert.equal(validateDownloadUrl('https://example.org/data.csv#section'), 'https://example.org/data.csv');
assert.throws(() => validateDownloadUrl('file:///private/data.csv'), /HTTP/);
assert.throws(() => validateDownloadUrl('https://user:secret@example.org/'), /Authorization/);
assert.throws(() => validateLoginUrl('javascript:alert(1)'), /sign-in/);
assert.throws(() => validateLoginUrl('https://login.tailscale.com.evil.example/'), /sign-in/);
assert.equal(validateLoginUrl('https://login.tailscale.com/a/test'), 'https://login.tailscale.com/a/test');
assert.deepEqual(normalizeNetworkHeaders(['Authorization: Bearer one:two', ['X-Data', 'value']]), {
  authorization: 'Bearer one:two', 'x-data': 'value'
});
assert.throws(() => normalizeNetworkHeaders([['X-Data', 'hello\r\nInjected: yes']]), /line breaks/);
assert.match(describeNetworkConnection({ exitNodeId: 'gone', exitNodes: [] }), /offline or unavailable/);
assert.equal(validateDNSMode('exit-node'), 'exit-node');
assert.equal(validateDNSMode('cloudflare'), 'cloudflare');
for (const value of ['', 'browser', undefined, { toString: () => 'cloudflare' }]) {
  assert.throws(() => validateDNSMode(value), /Unknown DNS mode/);
}
assert.equal(normalizeNetworkSnapshot().dnsMode, 'exit-node');
assert.equal(normalizeNetworkSnapshot({ exitNodeId: 'exit-1' }).dnsMode, 'exit-node');
assert.equal(normalizeNetworkSnapshot({ exitNodeId: 'exit-1', dnsMode: 'cloudflare' }).dnsMode, 'cloudflare');
assert.equal(normalizeNetworkSnapshot({ dnsMode: 'cloudflare' }).dnsMode, 'exit-node');
assert.throws(() => normalizeNetworkSnapshot({ exitNodeId: 'exit-1', dnsMode: 'browser' }), /Unknown DNS mode/);
const expiredSnapshot = normalizeNetworkSnapshot({ exitNodeId: 'expired', exitNodes: [{ id: 'expired', online: true, expired: true, os: 'linux' }] });
assert.equal(expiredSnapshot.exitNodes[0].os, 'linux');
assert.equal(expiredSnapshot.exitNodes[0].expired, true);
assert.match(describeNetworkConnection(expiredSnapshot), /expired device key/);

const diagnosticFixture = {
  exitNodeId: 'exit-1', exitNodeName: 'my-exit', exitNodeIP: '100.100.0.2',
  exitNodeOS: 'linux', exitNodeOnline: true, exitNodeExpired: false,
  checks: ['exit', 'route', 'peer', 'peerapi', 'tcp', 'tls', 'http'].map(id => ({
    id, label: id, status: ['tcp'].includes(id) ? 'fail' : ['tls', 'http'].includes(id) ? 'skip' : 'pass',
    elapsedMs: id === 'tcp' ? 10_000 : 0, message: id === 'tcp' ? 'TCP to 1.1.1.1:443 timed out.' : 'Fixture result.'
  }))
};
const cleanDiagnostic = normalizeNetworkDiagnostics({ ...diagnosticFixture, logs: 'not for display', body: 'trace contents' });
assert.equal(cleanDiagnostic.exitNodeOS, 'linux');
assert.equal(cleanDiagnostic.logs, undefined);
assert.equal(cleanDiagnostic.body, undefined);
assert.equal(cleanDiagnostic.checks.find(check => check.id === 'tcp').status, 'fail');
assert.equal(cleanDiagnostic.checks.find(check => check.id === 'tls').status, 'skip');
for (const alter of [
  report => { report.checks.pop(); },
  report => { report.checks[1].id = 'exit'; },
  report => { report.checks[1].id = 'unknown'; },
  report => { report.checks[1].status = 'success'; },
  report => { report.checks[1].elapsedMs = NaN; },
  report => { report.checks[1].elapsedMs = -1; }
]) {
  const invalid = structuredClone(diagnosticFixture);
  alter(invalid);
  assert.throws(() => normalizeNetworkDiagnostics(invalid), /incomplete connection diagnostic/);
}

const dnsDetails = 'lookup public.example.org on [::1]:53: Post "http://100.64.0.10:1/dns-query": context deadline exceeded';
const dnsFailure = `[EXIT_NODE_DNS_TIMEOUT] Exit node DNS timed out. Select "Cloudflare through exit node" and test again.\nDetails: ${dnsDetails}`;
assert.match(describeNetworkError(new Error(dnsFailure)), /^Exit node DNS timed out/);
assert.ok(describeNetworkError(new Error(dnsFailure)).includes(dnsDetails), 'Retain the original DNS failure details.');
assert.doesNotMatch(describeNetworkError(dnsFailure), /\[EXIT_NODE_DNS_TIMEOUT\]/);
assert.equal(describeNetworkError('[CLOUDFLARE_DNS_TIMEOUT] Cloudflare DNS timed out.'), 'Cloudflare DNS timed out.');
assert.equal(describeNetworkError(dnsDetails), dnsDetails, 'Do not invent public DNS advice for unclassified or protected-name errors.');
assert.equal(networkErrorCode(dnsFailure), 'EXIT_NODE_DNS_TIMEOUT');
assert.equal(networkErrorCode(new Error(dnsFailure)), 'EXIT_NODE_DNS_TIMEOUT');
assert.equal(networkErrorCode(' \n[CLOUDFLARE_DNS_TIMEOUT] Cloudflare DNS timed out.'), 'CLOUDFLARE_DNS_TIMEOUT');
assert.equal(networkErrorCode(Object.assign(new Error('Readable DNS failure'), { code: 'EXIT_NODE_DNS_TIMEOUT' })), 'EXIT_NODE_DNS_TIMEOUT');
assert.equal(networkErrorCode(new Error('Download failed', { cause: new Error(dnsFailure) })), 'EXIT_NODE_DNS_TIMEOUT');
assert.equal(networkErrorCode(Object.assign(new Error(dnsFailure), { code: 'CLOUDFLARE_DNS_TIMEOUT' })), 'CLOUDFLARE_DNS_TIMEOUT', 'An explicit known code takes precedence over the same error message.');
assert.equal(networkErrorCode(Object.assign(new Error(dnsFailure), { code: 'UNKNOWN_CODE' })), 'EXIT_NODE_DNS_TIMEOUT');
for (const error of [
  undefined, null, '', 'Ordinary failure', new Error(dnsDetails),
  '[UNKNOWN_CODE] DNS error', '[EXIT_NODE_DNS_TIMEOUT]not a marker',
  'Response text mentions [EXIT_NODE_DNS_TIMEOUT] later',
  { code: 'UNKNOWN_CODE', message: 'Failed' }, { code: 'EXIT_NODE_DNS_TIMEOUT extra' }
]) {
  assert.equal(networkErrorCode(error), '', 'Only known structured codes and leading markers identify the DNS failure.');
}
const cyclicCause = new Error('Unclassified failure');
cyclicCause.cause = cyclicCause;
assert.equal(networkErrorCode(cyclicCause), '', 'Cyclic causes must not hang error classification.');

const snapshot = {
  ip: '100.100.0.1', exitNodeId: 'exit-1', dnsMode: 'exit-node',
  exitNodes: [{ id: 'exit-1', hostName: 'my-exit', tailscaleIP: '100.100.0.2', online: true, active: true }]
};
const bytes = Uint8Array.of(0, 255, 128, 13, 10, 65);
class FakeWorker extends EventTarget {
  constructor({ auth = 'https://login.tailscale.com/a/test', hold = [] } = {}) {
    super();
    this.auth = auth;
    this.hold = new Set(hold);
    this.requests = [];
    this.terminated = false;
    this.downloadError = '';
    this.errors = new Map();
    this.state = structuredClone(snapshot);
  }
  emit(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
  reply(id, result, error) { this.emit({ id, result, error }); }
  postMessage(message) {
    this.requests.push(message);
    if (this.hold.has(message.method)) return;
    queueMicrotask(() => {
      if (this.errors.has(message.method)) {
        this.reply(message.id, null, this.errors.get(message.method));
        return;
      }
      if (message.method === 'connect') {
        this.emit({ event: 'auth', url: this.auth });
        this.reply(message.id, this.state);
      } else if (message.method === 'download') {
        this.reply(message.id, { status: 200, statusText: '200 OK', body: bytes.slice().buffer }, this.downloadError);
      } else if (message.method === 'setExitNode') {
        this.state = { ...this.state, exitNodeId: message.args.id };
        if (!message.args.id) this.state.dnsMode = 'exit-node';
        this.reply(message.id, this.state);
      } else if (message.method === 'setDNSMode') {
        this.state = { ...this.state, dnsMode: message.args.mode };
        this.reply(message.id, this.state);
      } else if (message.method === 'diagnose') {
        this.reply(message.id, structuredClone(diagnosticFixture));
      } else this.reply(message.id, this.state);
    });
  }
  terminate() { this.terminated = true; }
}

let directCalls = 0;
let lastDirect;
const workers = [];
const network = new TailscaleNetwork({
  workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
  fetcher: async (...args) => {
    directCalls++;
    lastDirect = args;
    return new Response(bytes, { status: 200 });
  },
  refreshInterval: 0
});

await assert.rejects(network.connect(), /Wait for R/);
await assert.rejects(network.diagnose(), /Connect to Tailscale/);
assert.equal(network.state.dnsMode, 'exit-node');
await assert.rejects(network.setDNSMode('cloudflare'), /Connect to Tailscale first/);
assert.equal(workers.length, 0, 'Tailscale must not load before the bridge is available.');
assert.deepEqual(new Uint8Array((await network.download({ url: 'https://data.example/input' })).body), bytes);
assert.equal(directCalls, 1);
assert.equal(lastDirect[1].credentials, 'omit');
network.setBridgeReady(true);
const connection = network.connect();
assert.equal(network.connect(), connection, 'Double-clicking Connect must reuse the in-progress attempt.');
await connection;
assert.equal(workers.length, 1);
assert.equal(network.state.phase, 'connected');
assert.equal(network.state.mode, 'tailscale');
assert.equal(network.state.dnsMode, 'exit-node');
assert.equal(network.state.loginUrl, '', 'Do not retain sign-in URLs after connection.');
assert.match(network.state.message, /is selected\. Test a URL/);
assert.equal(workers[0].requests.some(request => request.method === 'diagnose'), false, 'Connecting must not send public diagnostic probes automatically.');
network.update({ error: 'An earlier data download failed.' });
const diagnostic = await network.diagnose();
assert.equal(diagnostic.exitNodeId, 'exit-1');
assert.equal(diagnostic.checks.find(check => check.id === 'tcp').status, 'fail');
assert.equal(network.state.error, 'An earlier data download failed.', 'A diagnostic must not clear the download error.');
assert.equal(network.state.dnsMode, 'exit-node', 'Diagnostics must not change DNS preferences.');
assert.equal(directCalls, 1, 'Diagnostic probes must not use browser fetch.');
const result = await network.download({ url: 'https://data.example/input', headers: ['Authorization: Bearer a:b'] });
assert.deepEqual(new Uint8Array(result.body), bytes);
assert.equal(directCalls, 1, 'Connected downloads must bypass browser fetch.');
assert.equal(workers[0].requests.at(-1).args.headers.authorization, 'Bearer a:b');

const beforeInvalidMode = workers[0].requests.length;
await assert.rejects(network.setDNSMode('browser'), /Unknown DNS mode/);
assert.equal(workers[0].requests.length, beforeInvalidMode, 'Reject invalid DNS modes before sending an RPC.');
await network.setDNSMode('cloudflare');
assert.equal(workers[0].requests.at(-1).method, 'setDNSMode');
assert.deepEqual(workers[0].requests.at(-1).args, { mode: 'cloudflare' });
assert.equal(network.state.dnsMode, 'cloudflare');
await network.refresh();
assert.equal(network.state.dnsMode, 'cloudflare', 'Status refresh preserves the chosen DNS mode.');
workers[0].errors.set('setDNSMode', 'DNS update failed');
await assert.rejects(network.setDNSMode('exit-node'), /DNS update failed/);
assert.equal(network.state.dnsMode, 'cloudflare', 'A failed DNS update must not claim the new choice is active.');
workers[0].errors.delete('setDNSMode');
await network.setDNSMode('exit-node');
assert.equal(network.state.dnsMode, 'exit-node');

workers[0].downloadError = dnsFailure;
await assert.rejects(network.test('https://data.example/input'), error => {
  assert.match(error.message, /Cloudflare through exit node/);
  assert.ok(error.message.includes(dnsDetails));
  assert.doesNotMatch(error.message, /\[EXIT_NODE_DNS_TIMEOUT\]/);
  assert.equal(error.code, 'EXIT_NODE_DNS_TIMEOUT', 'Readable errors retain their machine-readable DNS code.');
  return true;
});
assert.match(network.state.error, /Exit node DNS timed out/);
assert.equal(network.state.dnsMode, 'exit-node', 'A DNS failure must never switch DNS providers automatically.');
assert.equal(directCalls, 1, 'A DNS failure must never use browser fetch as a fallback.');

workers[0].downloadError = 'Exit node is unreachable';
await assert.rejects(network.download({ url: 'https://data.example/input' }), /unreachable/);
assert.equal(directCalls, 1, 'A failed tunnel must never silently fall back to browser fetch.');
assert.match(network.state.error, /unreachable/);
workers[0].downloadError = '';
await network.download({ url: 'https://data.example/input' });
assert.equal(network.state.error, '');

await network.setDNSMode('cloudflare');
await network.setExitNode('');
assert.equal(network.state.exitNodeId, '');
assert.equal(network.state.dnsMode, 'exit-node', 'Removing the exit node resets its DNS override.');
assert.match(network.state.message, /Select an exit node/);
const beforeNoExit = workers[0].requests.length;
await assert.rejects(network.setDNSMode('cloudflare'), /Select an exit node/);
await assert.rejects(network.diagnose(), /Select an exit node/);
assert.equal(workers[0].requests.length, beforeNoExit);
await network.refresh();
assert.equal(network.state.exitNodeId, '', 'Refreshing must not restore an exit node the user removed.');
await network.setExitNode('exit-1');
assert.equal(network.state.exitNodeId, 'exit-1');
assert.equal(network.state.dnsMode, 'exit-node');
await network.setDNSMode('cloudflare');

workers[0].hold.add('download');
const aborter = new AbortController();
const aborted = network.download({ url: 'https://data.example/input', signal: aborter.signal });
aborter.abort();
await assert.rejects(aborted, /cancelled/);
assert.equal(network.requests.size, 0, 'Aborted RPCs must release listeners and map entries.');
const disconnectedDownload = network.download({ url: 'https://data.example/input' });
network.disconnect();
await assert.rejects(disconnectedDownload, /disconnected/);
assert.equal(workers[0].terminated, true);
assert.equal(network.state.mode, 'browser');
assert.equal(network.state.dnsMode, 'exit-node', 'Disconnect clears the DNS choice for the next session.');
assert.equal(network.state.error, '', 'A late rejected request must not overwrite disconnected state.');
await network.download({ url: 'https://data.example/input' });
assert.equal(directCalls, 2);

await network.connect();
assert.equal(workers.length, 2);
workers[0].emit({ event: 'auth', url: 'javascript:stale' });
assert.equal(network.state.phase, 'connected', 'Ignore messages from terminated sessions.');
assert.equal(network.state.dnsMode, 'exit-node');
workers[1].hold.add('status');
await assert.rejects(network.rpc('status', {}, { timeout: 5 }), /timed out/);
assert.equal(network.requests.size, 0);
network.disconnect();

await network.connect();
const oldWorker = workers.at(-1);
oldWorker.hold.add('setDNSMode');
const staleDNSChange = network.setDNSMode('cloudflare');
const staleRequest = oldWorker.requests.at(-1);
oldWorker.reply(staleRequest.id, { ...snapshot, dnsMode: 'cloudflare' });
network.disconnect();
await assert.rejects(staleDNSChange, /connection changed/);
assert.equal(network.state.dnsMode, 'exit-node', 'A completed RPC from a closed session must not restore the old DNS choice.');
assert.equal(network.state.error, '');

const invalidPrefsWorker = new FakeWorker();
invalidPrefsWorker.state.dnsMode = 'browser';
const invalidPrefs = new TailscaleNetwork({ workerFactory: () => invalidPrefsWorker, refreshInterval: 0 });
invalidPrefs.setBridgeReady(true);
await assert.rejects(invalidPrefs.connect(), /Unknown DNS mode/);
assert.equal(invalidPrefs.state.phase, 'error');
assert.equal(invalidPrefs.state.mode, 'tailscale', 'Unknown DNS modes fail closed.');
assert.equal(invalidPrefs.state.dnsMode, 'exit-node');
invalidPrefs.disconnect();

// A request can outlive the route that started it. Preserve that request's
// own result while keeping late replies out of the current route's banner.
async function connectedHeldNetwork() {
  const worker = new FakeWorker({ hold: ['download'] });
  const controller = new TailscaleNetwork({
    workerFactory: () => worker,
    fetcher: async () => { assert.fail('A routed request must not fall back to browser fetch.'); },
    refreshInterval: 0
  });
  controller.setBridgeReady(true);
  await controller.connect();
  return { controller, worker };
}

const routeScenario = await connectedHeldNetwork();
try {
  const { controller, worker } = routeScenario;
  const oldExitFailure = controller.download({ url: 'https://data.example/old-exit' });
  const oldExitRequest = worker.requests.at(-1);
  await controller.setDNSMode('cloudflare');
  assert.equal(controller.state.error, '');

  const freshCloudflareFailure = '[CLOUDFLARE_DNS_TIMEOUT] The current Cloudflare route timed out.';
  const newFailure = controller.download({ url: 'https://data.example/current-cloudflare' });
  worker.reply(worker.requests.at(-1).id, null, freshCloudflareFailure);
  await assert.rejects(newFailure, error => {
    assert.equal(error.code, 'CLOUDFLARE_DNS_TIMEOUT');
    return true;
  });
  const currentError = controller.state.error;
  assert.equal(currentError, 'The current Cloudflare route timed out.', 'New errors still update the active route.');
  worker.reply(oldExitRequest.id, null, dnsFailure);
  await assert.rejects(oldExitFailure, error => {
    assert.equal(error.code, 'EXIT_NODE_DNS_TIMEOUT', 'The original rejected request retains its DNS code after a route switch.');
    assert.ok(error.message.includes(dnsDetails));
    assert.doesNotMatch(error.message, /\[EXIT_NODE_DNS_TIMEOUT\]/);
    assert.equal(networkErrorCode(error), 'EXIT_NODE_DNS_TIMEOUT');
    return true;
  });
  assert.equal(controller.state.error, currentError, 'An old exit-DNS failure cannot replace the current Cloudflare route error.');
  assert.equal(controller.state.dnsMode, 'cloudflare');

  const oldSuccess = controller.download({ url: 'https://data.example/old-success' });
  const oldSuccessRequest = worker.requests.at(-1);
  await controller.setDNSMode('exit-node');
  const latestFailure = controller.download({ url: 'https://data.example/current-exit' });
  worker.reply(worker.requests.at(-1).id, null, 'The new exit route is unreachable.');
  await assert.rejects(latestFailure, /new exit route is unreachable/);
  worker.reply(oldSuccessRequest.id, { status: 200, statusText: '200 OK', body: bytes.slice().buffer });
  assert.deepEqual(new Uint8Array((await oldSuccess).body), bytes, 'The old successful caller still receives its response.');
  assert.equal(controller.state.error, 'The new exit route is unreachable.', 'An old success cannot clear a new route error.');

  const roundTripFailure = controller.download({ url: 'https://data.example/old-generation' });
  const roundTripRequest = worker.requests.at(-1);
  await controller.setDNSMode('cloudflare');
  await controller.setDNSMode('exit-node');
  worker.reply(roundTripRequest.id, null, dnsFailure);
  await assert.rejects(roundTripFailure, error => error.code === 'EXIT_NODE_DNS_TIMEOUT');
  assert.equal(controller.state.error, '', 'Switching away and back creates a new route even when its settings match the old request.');

  const sameRouteFailure = controller.download({ url: 'https://data.example/same-route' });
  const sameRouteRequest = worker.requests.at(-1);
  await controller.refresh();
  controller.setBridgeReady(true);
  await controller.setDNSMode('exit-node');
  worker.reply(sameRouteRequest.id, null, 'This route is still unavailable.');
  await assert.rejects(sameRouteFailure, /still unavailable/);
  assert.equal(controller.state.error, 'This route is still unavailable.', 'Status, bridge, and unchanged-mode updates must not invalidate an active route.');

  const removedExitFailure = controller.download({ url: 'https://data.example/removed-exit' });
  const removedExitRequest = worker.requests.at(-1);
  await controller.setExitNode('');
  worker.reply(removedExitRequest.id, null, dnsFailure);
  await assert.rejects(removedExitFailure, error => error.code === 'EXIT_NODE_DNS_TIMEOUT');
  assert.equal(controller.state.error, '', 'Removing an exit invalidates old errors even when DNS mode remains exit-node.');
  await controller.setExitNode('exit-1');

  const freshSuccess = controller.download({ url: 'https://data.example/current-success' });
  worker.reply(worker.requests.at(-1).id, { status: 200, statusText: '200 OK', body: bytes.slice().buffer });
  await freshSuccess;
  assert.equal(controller.state.error, '', 'A success on the active route still clears its error.');
} finally {
  routeScenario.controller.disconnect();
}

const confirmationScenario = await connectedHeldNetwork();
try {
  const { controller, worker } = confirmationScenario;
  worker.hold.add('setDNSMode');
  for (const runtimeSnapshot of [
    { ...snapshot, dnsMode: 'exit-node', ip: '100.100.0.99' },
    { ...snapshot, dnsMode: undefined },
    { ...snapshot, exitNodeId: '', dnsMode: 'cloudflare' }
  ]) {
    const before = controller.state;
    const selection = controller.setDNSMode('cloudflare');
    worker.reply(worker.requests.at(-1).id, runtimeSnapshot);
    await assert.rejects(selection, /confirm|requested DNS mode|active DNS mode/i);
    assert.equal(controller.state, before, 'An unconfirmed runtime preference must leave the current state unchanged.');
    assert.equal(controller.state.dnsMode, 'exit-node');
  }
  worker.hold.delete('setDNSMode');
  await controller.setDNSMode('cloudflare');
  worker.hold.add('setDNSMode');
  const before = controller.state;
  const selection = controller.setDNSMode('exit-node');
  worker.reply(worker.requests.at(-1).id, { ...snapshot, dnsMode: 'cloudflare' });
  await assert.rejects(selection, /confirm|requested DNS mode|active DNS mode/i);
  assert.equal(controller.state, before, 'Runtime confirmation is required when returning to exit-node DNS too.');
} finally {
  confirmationScenario.controller.disconnect();
}

const diagnosticScenario = await connectedHeldNetwork();
try {
  const { controller, worker } = diagnosticScenario;
  worker.hold.add('diagnose');
  const oldDiagnostic = controller.diagnose();
  const oldDiagnosticRequest = worker.requests.at(-1);
  await controller.setDNSMode('cloudflare');
  worker.reply(oldDiagnosticRequest.id, diagnosticFixture);
  await assert.rejects(oldDiagnostic, /settings changed during the diagnostic/);
  assert.equal(controller.state.dnsMode, 'cloudflare');
  assert.equal(controller.state.error, '');

  const unchangedDiagnostic = controller.diagnose();
  const unchangedRequest = worker.requests.at(-1);
  await controller.refresh();
  worker.reply(unchangedRequest.id, diagnosticFixture);
  assert.equal((await unchangedDiagnostic).exitNodeId, 'exit-1', 'An unchanged status refresh must not discard a valid report.');

  const wrongExit = controller.diagnose();
  worker.reply(worker.requests.at(-1).id, { ...diagnosticFixture, exitNodeId: 'another-exit' });
  await assert.rejects(wrongExit, /different exit node/);

  const roundTripDiagnostic = controller.diagnose();
  const roundTripRequest = worker.requests.at(-1);
  await controller.setExitNode('');
  await controller.setExitNode('exit-1');
  worker.reply(roundTripRequest.id, diagnosticFixture);
  await assert.rejects(roundTripDiagnostic, /settings changed during the diagnostic/);

  await assert.rejects(controller.rpc('diagnose', {}, { timeout: 5 }), /diagnostic did not complete/);
  assert.equal(controller.requests.size, 0, 'A diagnostic timeout must release the RPC state.');
  const disconnectedDiagnostic = controller.diagnose();
  const disconnectedRequest = worker.requests.at(-1);
  controller.disconnect();
  await assert.rejects(disconnectedDiagnostic, /disconnected/);
  worker.reply(disconnectedRequest.id, diagnosticFixture);
  assert.equal(controller.state.mode, 'browser');
  assert.equal(controller.state.error, '');
} finally {
  diagnosticScenario.controller.disconnect();
}

const failedWorker = new TailscaleNetwork({ workerFactory: () => { throw new Error('Worker blocked'); }, refreshInterval: 0 });
failedWorker.setBridgeReady(true);
await assert.rejects(failedWorker.connect(), /Worker blocked/);
assert.equal(failedWorker.state.phase, 'error');
assert.equal(failedWorker.state.mode, 'tailscale', 'A failed connect remains fail-closed until an explicit disconnect.');
await assert.rejects(failedWorker.download({ url: 'https://data.example/input' }), /not connected/);
failedWorker.disconnect();

const invalidAuthWorker = new FakeWorker({ auth: 'https://evil.example/sign-in' });
const invalidAuth = new TailscaleNetwork({ workerFactory: () => invalidAuthWorker, refreshInterval: 0 });
invalidAuth.setBridgeReady(true);
await assert.rejects(invalidAuth.connect(), /sign-in/);
assert.equal(invalidAuth.state.phase, 'error');
assert.equal(invalidAuthWorker.terminated, true);
assert.equal(invalidAuth.state.loginUrl, '');
invalidAuth.disconnect();

const noCors = new TailscaleNetwork({ fetcher: async () => { throw new TypeError('Failed to fetch'); } });
await assert.rejects(noCors.download({ url: 'https://data.example/input' }), /CORS.*Tailscale/);

// Run the actual worker dispatcher with an injected, in-memory runtime. No
// sockets, sign-in requests, or third-party DNS requests are made by this check.
const workerSource = await readFile(new URL('../js/tailscale-worker.js', import.meta.url), 'utf8');
const workerBody = workerSource
  .replace(/^import .* from '\.\/network-common\.js\?v=[^']+';\n/m, '')
  .replace(/import\('\.\.\/vendor\/tailscale-web\/tailscale-web\.es\.js\?v=[^']+'\)/, 'loadRuntime()');
assert.notEqual(workerBody, workerSource);
const workerReplies = [];
let dispatch;
let runtimePrefs = { exitNodeId: '', dnsMode: 'exit-node' };
const runtimeDNSCalls = [];
let runtimeDiagnostics = 0;
const runtimeNodes = snapshot.exitNodes.concat({ id: 'expired', hostName: 'Expired exit', online: true, expired: true, os: 'linux' });
const runtime = {
  init: async () => {},
  getPrefs: () => ({ ...runtimePrefs }),
  localIPv4: () => snapshot.ip,
  localIPv6: () => '',
  listExitNodes: () => runtimeNodes,
  setExitNode: async id => {
    runtimePrefs.exitNodeId = id;
    if (!id) runtimePrefs.dnsMode = 'exit-node';
  },
  setDNSMode: async mode => {
    runtimeDNSCalls.push(mode);
    runtimePrefs.dnsMode = mode;
  },
  diagnose: async () => {
    runtimeDiagnostics += 1;
    return structuredClone(diagnosticFixture);
  }
};
new Function('self', 'crypto', 'loadRuntime', 'validateDownloadUrl', 'validateDNSMode',
  'normalizeNetworkHeaders', 'normalizeNetworkSnapshot', workerBody)(
  {
    addEventListener: (type, handler) => { if (type === 'message') dispatch = handler; },
    postMessage: reply => workerReplies.push(reply)
  },
  { randomUUID: () => '12345678-1234-1234-1234-123456789abc' },
  async () => ({ network: runtime }), validateDownloadUrl, validateDNSMode,
  normalizeNetworkHeaders, normalizeNetworkSnapshot
);
let workerRequestID = 0;
async function workerRequest(method, args = {}) {
  const id = ++workerRequestID;
  await dispatch({ data: { id, method, args } });
  const reply = workerReplies.find(item => item.id === id);
  assert.ok(reply, `Worker must reply to ${method}.`);
  return reply;
}
assert.match((await workerRequest('setDNSMode', { mode: 'cloudflare' })).error, /not connected/);
assert.match((await workerRequest('diagnose')).error, /not connected/);
assert.equal((await workerRequest('connect')).result.dnsMode, 'exit-node');
assert.equal(runtimePrefs.exitNodeId, 'exit-1', 'Auto-selection must ignore expired exit nodes even if advertised online.');
assert.equal(runtimeDiagnostics, 0, 'Worker startup must not probe public endpoints automatically.');
assert.match((await workerRequest('setExitNode', { id: 'expired' })).error, /expired device key/);
assert.equal(runtimePrefs.exitNodeId, 'exit-1');
assert.equal((await workerRequest('diagnose')).result.exitNodeOS, 'linux');
assert.equal(runtimeDiagnostics, 1);
assert.equal((await workerRequest('setDNSMode', { mode: 'cloudflare' })).result.dnsMode, 'cloudflare');
assert.deepEqual(runtimeDNSCalls, ['cloudflare']);
assert.equal((await workerRequest('status')).result.dnsMode, 'cloudflare');
for (const mode of ['browser', '', null]) {
  assert.match((await workerRequest('setDNSMode', { mode })).error, /Unknown DNS mode/);
}
assert.deepEqual(runtimeDNSCalls, ['cloudflare'], 'The worker independently rejects unsupported DNS modes.');
assert.equal((await workerRequest('setExitNode', { id: '' })).result.dnsMode, 'exit-node');
assert.match((await workerRequest('diagnose')).error, /Select an exit node/);
assert.equal(runtimeDiagnostics, 1, 'No public diagnostics are allowed without a selected exit.');
assert.match((await workerRequest('setDNSMode', { mode: 'cloudflare' })).error, /Select an exit node/);
assert.deepEqual(runtimeDNSCalls, ['cloudflare'], 'The worker must not enable Cloudflare without an exit node.');
runtime.setDNSMode = async () => { throw new Error('Runtime DNS update failed'); };
assert.match((await workerRequest('setDNSMode', { mode: 'exit-node' })).error, /Runtime DNS update failed/);
assert.equal((await workerRequest('status')).result.dnsMode, 'exit-node');

console.log('Network checks passed: routing, confirmed DNS preferences, explicit staged diagnostics, expired-exit selection, stale-route isolation, coded DNS errors, worker validation, binary bodies, headers, login validation, cancellation, reconnect, and fail-closed errors.');
