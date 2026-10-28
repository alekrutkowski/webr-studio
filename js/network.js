import {
  NETWORK_TIMEOUT_MS, NETWORK_AUTH_TIMEOUT_MS, NETWORK_DIAGNOSTIC_TIMEOUT_MS, validateDownloadUrl, validateLoginUrl,
  validateDNSMode, validateNetworkMode, networkErrorCode, normalizeNetworkHeaders, normalizeNetworkSnapshot,
  describeNetworkConnection, describeNetworkError, normalizeNetworkDiagnostics
} from './network-common.js?v=1.5.4';
import { CloudflareProxyClient } from './cloudflare-proxy.js?v=1.5.4';

/** A per-tab, explicit download route. The Go/Wasm client only loads on Connect. */
export class TailscaleNetwork extends EventTarget {
  #proxyClient = null;
  #browserRequests = new Set();

  constructor({
    workerFactory = () => new Worker(new URL('./tailscale-worker.js?v=1.5.4', import.meta.url), {
      type: 'module', name: 'webR Studio Tailscale'
    }),
    fetcher = (...args) => globalThis.fetch(...args),
    requestTimeout = NETWORK_TIMEOUT_MS,
    refreshInterval = 10_000
  } = {}) {
    super();
    this.workerFactory = workerFactory;
    this.fetcher = fetcher;
    this.requestTimeout = requestTimeout;
    this.refreshInterval = refreshInterval;
    this.worker = null;
    this.requests = new Map();
    this.sequence = 0;
    this.routeRevision = 0;
    this.poll = null;
    this.refreshing = null;
    this.connecting = null;
    this.state = {
      phase: 'disconnected', mode: 'browser', bridgeReady: false,
      message: 'Browser downloads are active. Choose Tailscale or a Cloudflare Worker proxy for downloads without CORS restrictions.',
      loginUrl: '', ip: '', exitNodes: [], exitNodeId: '', dnsMode: 'exit-node', proxyUrl: '', error: ''
    };
  }

  update(changes) {
    const next = { ...this.state, ...changes };
    if (['mode', 'dnsMode', 'exitNodeId', 'proxyUrl'].some(key => next[key] !== this.state[key])) {
      this.routeRevision += 1;
    }
    this.state = next;
    this.dispatchEvent(new CustomEvent('change', { detail: this.state }));
  }

  setBridgeReady(ready, error = '') {
    this.update({ bridgeReady: Boolean(ready), bridgeError: error });
  }

  selectMode(mode) {
    mode = validateNetworkMode(mode);
    if (mode === this.state.mode) return this.state;
    this.stopTransports('The download route changed.');
    this.connecting = null;
    this.update({
      phase: 'disconnected', mode, loginUrl: '', ip: '', exitNodes: [], exitNodeId: '', dnsMode: 'exit-node', error: '',
      message: mode === 'browser'
        ? 'Browser downloads are active and remain subject to CORS.'
        : mode === 'cloudflare'
          ? 'Enter your Worker URL and shared token, then connect to the proxy.'
          : 'Connect and sign in to Tailscale to use this download route.'
    });
    return this.state;
  }

  connect() {
    if (this.state.mode === 'tailscale' && this.connecting) return this.connecting;
    if (this.state.mode === 'tailscale' && this.state.phase === 'connected') return Promise.resolve(this.state);
    if (!this.state.bridgeReady) {
      return Promise.reject(new Error(this.state.bridgeError || 'Wait for R and the download bridge to start.'));
    }
    const attempt = this.startConnection();
    this.connecting = attempt;
    attempt.finally(() => {
      if (this.connecting === attempt) this.connecting = null;
    }).catch(() => {});
    return attempt;
  }

  async startConnection() {
    this.stopTransports('Starting a new Tailscale connection.');
    this.update({
      phase: 'loading', mode: 'tailscale', loginUrl: '', ip: '', exitNodes: [], exitNodeId: '', dnsMode: 'exit-node', error: '',
      message: 'Loading the Tailscale client. The first connection downloads about 35 MB.'
    });
    let worker;
    try {
      worker = this.workerFactory();
      this.worker = worker;
      worker.addEventListener('message', event => this.onMessage(worker, event.data));
      worker.addEventListener('error', () => {
        if (this.worker === worker) this.fail(new Error('The Tailscale worker stopped. Reconnect to try again.'));
      });
      worker.addEventListener('messageerror', () => {
        if (this.worker === worker) this.fail(new Error('The Tailscale worker returned an unreadable response.'));
      });
      const snapshot = await this.rpc('connect', {}, { timeout: NETWORK_AUTH_TIMEOUT_MS });
      if (this.worker !== worker) throw new Error('Tailscale connection cancelled.');
      const clean = normalizeNetworkSnapshot(snapshot);
      this.update({
        ...clean, phase: 'connected', loginUrl: '', error: '',
        message: describeNetworkConnection(clean)
      });
      if (this.refreshInterval) {
        this.poll = setInterval(() => this.refresh().catch(() => {}), this.refreshInterval);
      }
      return this.state;
    } catch (error) {
      if ((!worker || this.worker === worker) && this.state.mode === 'tailscale') this.fail(error);
      throw error;
    }
  }

  useCloudflare(configuration = {}) {
    const attempt = this.startCloudflareConnection(configuration);
    this.connecting = attempt;
    attempt.finally(() => {
      if (this.connecting === attempt) this.connecting = null;
    }).catch(() => {});
    return attempt;
  }

  async startCloudflareConnection({ url, token }) {
    this.stopTransports('Starting a new Cloudflare proxy connection.');
    this.update({
      mode: 'cloudflare', phase: 'disconnected', loginUrl: '', ip: '', exitNodes: [], exitNodeId: '', dnsMode: 'exit-node', error: '',
      message: 'Checking the Cloudflare Worker configuration.'
    });
    let revision = this.routeRevision;
    let client;
    try {
      if (!this.state.bridgeReady) throw new Error(this.state.bridgeError || 'Wait for R and the download bridge to start.');
      client = new CloudflareProxyClient({ url, token, fetcher: this.fetcher, timeout: this.requestTimeout });
      this.#proxyClient = client;
      this.update({ proxyUrl: client.url, phase: 'loading', message: 'Checking the Cloudflare Worker proxy.' });
      revision = this.routeRevision;
      await client.check();
      if (this.#proxyClient !== client || this.routeRevision !== revision || this.state.mode !== 'cloudflare') {
        throw new Error('Cloudflare proxy connection cancelled.');
      }
      this.update({
        phase: 'connected', error: '',
        message: 'Connected to your Cloudflare Worker proxy. Test a URL below to check downloads.'
      });
      return this.state;
    } catch (error) {
      if (this.routeRevision === revision && this.state.mode === 'cloudflare'
        && (!client || this.#proxyClient === client)) {
        client?.close();
        this.#proxyClient = null;
        this.update({
          phase: 'error', error: error.message || String(error),
          message: 'The Cloudflare Worker proxy is unavailable. Check its URL and shared token, then reconnect.'
        });
      }
      throw error;
    }
  }

  onMessage(worker, data) {
    if (worker !== this.worker || !data || typeof data !== 'object') return;
    if (data.event === 'auth') {
      try {
        const loginUrl = validateLoginUrl(data.url);
        this.update({ phase: 'login', loginUrl, message: 'Open the sign-in link below and approve this browser in Tailscale.' });
      } catch (error) { this.fail(error); }
      return;
    }
    if (data.event === 'progress') {
      this.update({ message: String(data.message || 'Connecting…') });
      return;
    }
    const request = this.requests.get(data.id);
    if (!request) return;
    request.finish();
    if (data.error) request.reject(new Error(String(data.error)));
    else request.resolve(data.result);
  }

  rpc(method, args = {}, { timeout = this.requestTimeout, signal } = {}) {
    if (!this.worker) return Promise.reject(new Error('Tailscale is disconnected.'));
    if (signal?.aborted) return Promise.reject(new Error('Download cancelled.'));
    const id = ++this.sequence;
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.requests.delete(id);
      };
      const abort = () => {
        finish();
        // This library has no per-request abort API. Ignore its eventual reply;
        // Go's HTTP timeout still bounds the underlying request to 120 seconds.
        reject(new Error('Download cancelled.'));
      };
      timer = setTimeout(() => {
        finish();
        reject(new Error(method === 'connect'
          ? 'Tailscale sign-in timed out. Click Connect to try again.'
          : method === 'diagnose'
            ? 'The connection diagnostic did not complete within 45 seconds.'
            : 'Tailscale timed out. Check the selected exit node and its internet connection.'));
      }, timeout);
      this.requests.set(id, { resolve, reject, finish });
      signal?.addEventListener('abort', abort, { once: true });
      try { worker.postMessage({ id, method, args }); }
      catch (error) { finish(); reject(error); }
    });
  }

  async refresh() {
    if (this.state.mode !== 'tailscale' || this.state.phase !== 'connected') return this.state;
    if (this.refreshing) return this.refreshing;
    const worker = this.worker;
    const operation = this.rpc('status').then(snapshot => {
      if (this.worker !== worker) return this.state;
      const clean = normalizeNetworkSnapshot(snapshot);
      this.update({ ...clean, message: describeNetworkConnection(clean) });
      return this.state;
    }).catch(error => {
      if (this.worker === worker) this.fail(error);
      throw error;
    }).finally(() => {
      if (this.refreshing === operation) this.refreshing = null;
    });
    this.refreshing = operation;
    return operation;
  }

  async setExitNode(id = '') {
    if (this.state.mode !== 'tailscale' || this.state.phase !== 'connected') throw new Error('Connect to Tailscale first.');
    const worker = this.worker;
    const snapshot = await this.rpc('setExitNode', { id: String(id) });
    if (this.worker !== worker) throw new Error('Tailscale connection changed.');
    const clean = normalizeNetworkSnapshot(snapshot);
    this.update({ ...clean, message: describeNetworkConnection(clean), error: '' });
    return this.state;
  }

  async setDNSMode(mode) {
    mode = validateDNSMode(mode);
    if (this.state.mode !== 'tailscale' || this.state.phase !== 'connected') throw new Error('Connect to Tailscale first.');
    if (mode === 'cloudflare' && !this.state.exitNodeId) {
      throw new Error('Select an exit node before using Cloudflare DNS.');
    }
    const worker = this.worker;
    const snapshot = await this.rpc('setDNSMode', { mode });
    if (this.worker !== worker) throw new Error('Tailscale connection changed.');
    const clean = normalizeNetworkSnapshot(snapshot);
    if (clean.dnsMode !== mode) {
      throw new Error('Tailscale did not confirm the requested DNS mode. Refresh the networking status and try again.');
    }
    this.update({ ...clean, message: describeNetworkConnection(clean), error: '' });
    return this.state;
  }

  async download({ url, headers = [], method = 'GET', signal } = {}) {
    url = validateDownloadUrl(url);
    if (method !== 'GET') throw new Error('R downloads use HTTP GET.');
    headers = normalizeNetworkHeaders(headers);
    if (this.state.mode === 'cloudflare') {
      const client = this.#proxyClient;
      if (this.state.phase !== 'connected' || !client) {
        throw new Error('The Cloudflare Worker proxy is not connected. Enter its URL and shared token, then connect.');
      }
      const revision = this.routeRevision;
      try {
        const result = await client.download({ url, headers, signal });
        if (this.#proxyClient !== client || this.routeRevision !== revision || this.state.mode !== 'cloudflare') {
          throw new Error('Cloudflare proxy request cancelled because the download route changed.');
        }
        this.update({ error: '' });
        return result;
      } catch (error) {
        if (this.#proxyClient === client && this.routeRevision === revision && this.state.mode === 'cloudflare') {
          this.update({ error: error.message || String(error) });
        }
        throw error;
      }
    }
    if (this.state.mode === 'tailscale') {
      if (this.state.phase !== 'connected') {
        throw new Error('Tailscale is not connected. Finish signing in, reconnect, or choose Disconnect to return to browser downloads.');
      }
      // A broken tunnel must never result in an unrequested direct download.
      const worker = this.worker;
      const routeRevision = this.routeRevision;
      try {
        const result = await this.rpc('download', { url, headers }, { signal });
        if (this.worker === worker && this.routeRevision === routeRevision && this.state.mode === 'tailscale') {
          this.update({ error: '' });
        }
        return result;
      }
      catch (error) {
        const message = describeNetworkError(error);
        const code = networkErrorCode(error);
        const failure = message === error.message ? error : new Error(message, { cause: error });
        if (code) failure.code = code;
        // A request started before a DNS/exit change must still reject for its
        // caller, but it must not overwrite the new route's status or errors.
        if (this.worker === worker && this.routeRevision === routeRevision && this.state.mode === 'tailscale') {
          this.update({ error: message });
        }
        throw failure;
      }
    }
    if (this.state.mode !== 'browser') throw new Error('Choose a download route in Networking.');
    const controller = new AbortController();
    if (signal?.aborted) throw new Error('Download cancelled.');
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let rejectAbort;
    const cancelled = new Promise((resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new Error('Download cancelled.'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    this.#browserRequests.add(controller);
    const revision = this.routeRevision;
    try {
      const request = (async () => {
        const response = await this.fetcher(url, {
          method, headers, signal: controller.signal, credentials: 'omit', redirect: 'follow', cache: 'no-store'
        });
        return {
          status: response.status, statusText: response.statusText,
          body: await response.arrayBuffer()
        };
      })();
      const result = await Promise.race([request, cancelled]);
      if (this.routeRevision !== revision || this.state.mode !== 'browser') throw new Error('Download cancelled.');
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Download cancelled.');
      throw new Error(`Browser download failed (${error.message || 'network error'}). If the server blocks CORS, choose Tailscale or a Cloudflare Worker proxy in Networking.`);
    } finally {
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
      this.#browserRequests.delete(controller);
      controller.abort();
    }
  }

  async test(url) {
    if (!['tailscale', 'cloudflare'].includes(this.state.mode) || this.state.phase !== 'connected') {
      throw new Error('Connect to Tailscale or a Cloudflare Worker proxy before testing downloads.');
    }
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeout);
    try {
      const response = await this.download({ url, signal: controller.signal });
      if (response.status < 200 || response.status >= 300) throw new Error(`The server returned HTTP ${response.status}.`);
      return { status: response.status, bytes: response.body.byteLength, elapsedMs: performance.now() - started };
    } finally { clearTimeout(timer); }
  }

  async diagnose() {
    if (this.state.mode !== 'tailscale' || this.state.phase !== 'connected') {
      throw new Error('Connect to Tailscale before diagnosing the connection.');
    }
    if (!this.state.exitNodeId) throw new Error('Select an exit node before diagnosing the connection.');
    const worker = this.worker;
    const revision = this.routeRevision;
    const exitNodeId = this.state.exitNodeId;
    const result = await this.rpc('diagnose', {}, { timeout: NETWORK_DIAGNOSTIC_TIMEOUT_MS });
    if (this.worker !== worker || this.routeRevision !== revision || this.state.phase !== 'connected') {
      throw new Error('The connection or network settings changed during the diagnostic. Run it again for the current connection.');
    }
    const report = normalizeNetworkDiagnostics(result);
    if (report.exitNodeId !== exitNodeId) {
      throw new Error('The diagnostic belongs to a different exit node. Refresh the exit list and run it again.');
    }
    // Diagnostic findings are distinct from an R download's result. They must
    // not clear a download failure or silently select another route/provider.
    return report;
  }

  fail(error) {
    this.stopWorker(error.message || String(error));
    this.update({
      phase: 'error', loginUrl: '', ip: '', exitNodes: [], exitNodeId: '', dnsMode: 'exit-node',
      error: error.message || String(error),
      message: 'Tailscale is unavailable. Reconnect, or Disconnect to use ordinary browser downloads.'
    });
  }

  stopWorker(reason) {
    this.routeRevision += 1;
    clearInterval(this.poll);
    this.poll = null;
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    for (const request of [...this.requests.values()]) {
      request.finish();
      request.reject(new Error(reason || 'Tailscale disconnected.'));
    }
    this.refreshing = null;
  }

  stopTransports(reason) {
    this.stopWorker(reason);
    this.#proxyClient?.close();
    this.#proxyClient = null;
    for (const controller of this.#browserRequests) controller.abort();
    this.#browserRequests.clear();
  }

  disconnect() {
    this.stopTransports('Networking disconnected.');
    this.connecting = null;
    this.update({
      phase: 'disconnected', mode: 'browser', loginUrl: '', ip: '', exitNodes: [], exitNodeId: '', dnsMode: 'exit-node', error: '',
      message: 'Disconnected. Browser downloads are active and remain subject to CORS.'
    });
  }
}
