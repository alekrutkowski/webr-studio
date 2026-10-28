/*
 * webR's synchronous download primitive runs in its dedicated worker. A private
 * same-origin service-worker route lets it wait for an asynchronous transport
 * without blocking the editor or changing R's download.file()/url() functions.
 */
const PROTOCOL = 1;
const REGISTER_MESSAGE = 'webr-studio:network-register';
const DOWNLOAD_MESSAGE = 'webr-studio:network-download';
const REQUEST_TIMEOUT = 134_000;

function makeToken() {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure random numbers are unavailable. Open webR Studio over HTTPS or localhost.');
  }
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Keep this function self-contained: its source is evaluated inside webR.
function installDownloadHook(configuration) {
  const runtime = typeof Module !== 'undefined' ? Module : globalThis.Module;
  if (!runtime || typeof runtime.downloadFileContent !== 'function') {
    throw new Error('This webR version does not expose its download bridge. Use webR 0.6.0 or a compatible release.');
  }
  const original = runtime.__webrStudioNetworkDownload?.original || runtime.downloadFileContent;
  runtime.__webrStudioNetworkDownload = { original, configuration };
  runtime.downloadFileContent = function studioDownloadContent(url, headers = [], maxRedirects = 10) {
    if (!/^https?:/i.test(String(url))) return original.call(this, url, headers, maxRedirects);
    if (maxRedirects <= 0) return { status: 400, response: 'Too many redirects' };
    try {
      const target = new URL(String(url));
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only HTTP and HTTPS downloads can use this connection.');
      const requestHeaders = headers.map(header => {
        const line = String(header);
        const separator = line.indexOf(':');
        if (separator <= 0 || /[\r\n]/.test(line)) throw new Error('Invalid download request header.');
        const name = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error('Invalid download request header name.');
        return [name, value];
      });
      const request = new XMLHttpRequest();
      request.open('POST', configuration.endpoint, false);
      request.responseType = 'arraybuffer';
      request.timeout = 135_000;
      request.setRequestHeader('Content-Type', 'application/json');
      request.send(JSON.stringify({
        protocol: 1,
        clientId: configuration.clientId,
        token: configuration.token,
        url: target.href,
        method: 'GET',
        headers: requestHeaders,
        maxRedirects
      }));
      if (request.getResponseHeader('X-WebR-Network-Protocol') !== '1') {
        throw new Error('The download bridge is unavailable. Reload webR Studio and reconnect.');
      }
      const status = Number(request.getResponseHeader('X-WebR-Network-Status'));
      if (!Number.isInteger(status) || status < 0 || status > 599) throw new Error('Invalid download bridge response.');
      const body = request.response || new ArrayBuffer(0);
      if (status === 0) {
        const message = new TextDecoder().decode(body) || 'The network download failed.';
        console.error(message);
        return { status: 0, response: message };
      }
      return { status, response: body };
    } catch (error) {
      const message = error?.message || String(error);
      console.error(`webR Studio network: ${message}`);
      return { status: 0, response: message };
    }
  };
  return true;
}

export function getHookSource({ endpoint, clientId, token }) {
  const address = new URL(endpoint);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
    throw new Error('The download bridge must use a local HTTP(S) endpoint.');
  }
  if (!clientId || typeof clientId !== 'string' || !/^[a-f0-9]{48}$/.test(token || '')) {
    throw new Error('The download bridge is not initialized.');
  }
  return `(${installDownloadHook.toString()})(${JSON.stringify({ endpoint: address.href, clientId, token })})`;
}

function waitForController(container, timeout = 10_000) {
  if (container.controller) return Promise.resolve(container.controller);
  return new Promise((resolve, reject) => {
    const finish = (error, controller) => {
      clearTimeout(timer);
      container.removeEventListener('controllerchange', check);
      if (error) reject(error);
      else resolve(controller);
    };
    const check = () => {
      if (container.controller) finish(null, container.controller);
    };
    const timer = setTimeout(() => finish(new Error('The networking service worker is not controlling this page yet. Reload webR Studio, then reconnect.')), timeout);
    container.addEventListener('controllerchange', check);
    Promise.resolve(container.ready).then(check, error => finish(error));
    check();
  });
}

function registerOwner(controller) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (error, result) => {
      clearTimeout(timer);
      channel.port1.close();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('The networking service worker needs an update. Reload webR Studio, then reconnect.')), 5_000);
    channel.port1.onmessage = event => {
      const message = event.data;
      if (message?.protocol !== PROTOCOL || !message.clientId || !message.endpoint) {
        finish(new Error(message?.error || 'The networking service worker returned an invalid response.'));
      } else {
        finish(null, message);
      }
    };
    channel.port1.onmessageerror = () => finish(new Error('Could not communicate with the networking service worker.'));
    try { controller.postMessage({ type: REGISTER_MESSAGE, protocol: PROTOCOL }, [channel.port2]); }
    catch (error) { channel.port2.close(); finish(error); }
  });
}

function responseBuffer(body) {
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  if (typeof body === 'string') return new TextEncoder().encode(body).buffer;
  if (body == null) return new ArrayBuffer(0);
  throw new Error('The network transport returned an invalid response body.');
}

export class NetworkBridge extends EventTarget {
  constructor({ download } = {}) {
    super();
    if (typeof download !== 'function') throw new TypeError('NetworkBridge requires a download callback.');
    this.download = download;
    this.initialized = false;
    this.initializing = null;
    this.disposed = false;
    this.token = '';
    this.clientId = '';
    this.endpoint = '';
    this.container = null;
    this.pending = new Set();
    this.onMessage = event => this.handleMessage(event);
  }

  async initialize() {
    if (this.disposed) throw new Error('This network bridge has been closed.');
    if (this.initialized) return this;
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeOwner();
    try { return await this.initializing; }
    finally { this.initializing = null; }
  }

  async initializeOwner() {
    if (!globalThis.isSecureContext || !globalThis.navigator?.serviceWorker) {
      throw new Error('R download networking requires HTTPS or localhost and a browser with service workers.');
    }
    this.container = navigator.serviceWorker;
    const controller = await waitForController(this.container);
    const registration = await registerOwner(controller);
    if (this.disposed) throw new Error('This network bridge has been closed.');
    const endpoint = new URL(registration.endpoint);
    if (endpoint.origin !== globalThis.location.origin) throw new Error('The networking service worker returned an invalid endpoint.');
    this.clientId = registration.clientId;
    this.endpoint = endpoint.href;
    this.token = makeToken();
    this.container.addEventListener('message', this.onMessage);
    this.initialized = true;
    return this;
  }

  getHookSource() {
    if (!this.initialized) throw new Error('The download bridge is not initialized.');
    return getHookSource(this);
  }

  async install(webR) {
    await this.initialize();
    // A JSON string literal is also an R string literal for this generated code.
    const source = JSON.stringify(this.getHookSource()).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    await webR.evalRVoid(`webr::eval_js(${source})`);
    return this;
  }

  handleMessage(event) {
    const message = event.data;
    if (message?.type !== DOWNLOAD_MESSAGE) return;
    const port = event.ports?.[0];
    if (!port) return;
    if (this.disposed || !this.initialized || message.protocol !== PROTOCOL
        || message.token !== this.token || message.clientId !== this.clientId
        || (event.origin && event.origin !== globalThis.location.origin)
        || event.source?.scriptURL !== this.container.controller?.scriptURL) {
      port.postMessage({ protocol: PROTOCOL, status: 0, error: 'The download connection belongs to a different or closed tab.' });
      port.close();
      return;
    }
    const controller = new AbortController();
    let complete = false;
    let timer;
    const finish = result => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      this.pending.delete(cancel);
      try {
        const body = responseBuffer(result.body ?? (result.error || ''));
        port.postMessage({ protocol: PROTOCOL, status: result.status, statusText: result.statusText || '', body }, [body]);
      } catch (error) {
        try { port.postMessage({ protocol: PROTOCOL, status: 0, error: error.message || String(error) }); } catch { /* Owner has gone away. */ }
      }
      port.close();
    };
    const cancel = (reason = 'The download was cancelled.') => {
      controller.abort(new Error(reason));
      finish({ status: 0, error: reason });
    };
    this.pending.add(cancel);
    timer = setTimeout(() => cancel('The download timed out. Check the selected connection in Networking and try again.'), REQUEST_TIMEOUT);
    port.onmessage = event => {
      if (event.data?.type === 'cancel') cancel('The download was cancelled.');
    };
    port.onmessageerror = () => cancel('The download connection was interrupted.');
    Promise.resolve().then(() => this.download({
      url: message.url,
      method: 'GET',
      headers: message.headers,
      maxRedirects: message.maxRedirects,
      signal: controller.signal
    })).then(result => {
      if (!result || !Number.isInteger(result.status) || result.status < 0 || result.status > 599) {
        throw new Error('The network transport returned an invalid HTTP status.');
      }
      finish(result);
    }).catch(error => {
      if (complete) return;
      finish({ status: 0, error: error?.message || String(error) });
      this.dispatchEvent(new CustomEvent('error', { detail: { error, url: message.url } }));
    });
  }

  dispose() {
    this.disposed = true;
    this.initialized = false;
    this.container?.removeEventListener('message', this.onMessage);
    for (const cancel of [...this.pending]) cancel('The download connection was closed.');
    this.token = '';
  }
}
