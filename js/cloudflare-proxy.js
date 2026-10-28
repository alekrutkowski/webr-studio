import {
  NETWORK_TIMEOUT_MS, CLOUDFLARE_HEALTH_TIMEOUT_MS, validateProxyUrl, validateProxyToken
} from './network-common.js?v=1.5.4';

const PROTOCOL = '1';
const SERVICE = 'webr-studio-cors-proxy';

/** One explicit proxy connection. Its shared token is never public state. */
export class CloudflareProxyClient {
  #token;
  #closed = false;
  #controllers = new Set();

  constructor({ url, token, fetcher = (...args) => globalThis.fetch(...args), timeout = NETWORK_TIMEOUT_MS }) {
    this.url = validateProxyUrl(url);
    this.#token = validateProxyToken(token);
    let decodedUrl = this.url;
    try { decodedUrl = decodeURIComponent(this.url); } catch { /* Keep the original validated URL. */ }
    if (decodedUrl.includes(this.#token) || this.url.includes(encodeURIComponent(this.#token))) {
      this.#token = '';
      throw new Error('Keep the shared token out of the Worker address. Enter it only in the token field.');
    }
    this.fetcher = fetcher;
    this.timeout = timeout;
  }

  close() {
    this.#closed = true;
    this.#token = '';
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
  }

  check({ signal } = {}) {
    return this.#request({ action: 'check' }, { signal, timeout: Math.min(this.timeout, CLOUDFLARE_HEALTH_TIMEOUT_MS) });
  }

  download({ url, headers, signal }) {
    return this.#request({ action: 'fetch', url, headers }, { signal, timeout: this.timeout });
  }

  async #request(payload, { signal, timeout }) {
    if (this.#closed || signal?.aborted) throw new Error('Cloudflare proxy request cancelled.');
    const token = this.#token;
    const redact = value => {
      let text = String(value || 'The request failed.');
      for (const secret of [token, encodeURIComponent(token)]) {
        if (secret) text = text.split(secret).join('[redacted]');
      }
      return text.slice(0, 2000);
    };
    const controller = new AbortController();
    let timedOut = false;
    let rejectAbort;
    const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
    const abortMessage = () => timedOut
      ? 'Cloudflare proxy timed out. Check the Worker and try again.'
      : 'Cloudflare proxy request cancelled.';
    const onAbort = () => rejectAbort(new Error(abortMessage()));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    this.#controllers.add(controller);
    try {
      const request = (async () => {
        let response;
        try {
          response = await this.fetcher(this.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-WebR-Proxy-Token': token },
            body: JSON.stringify(payload),
            credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error',
            signal: controller.signal
          });
        } catch (error) {
          throw new Error(`Could not reach the Cloudflare Worker (${redact(error?.message || 'network error')}). Check its URL and ALLOWED_ORIGINS setting.`);
        }
        if (response.redirected || response.headers.get('X-WebR-Proxy-Version') !== PROTOCOL) {
          throw new Error('This address did not return the webR Studio proxy protocol. Check the deployed Worker URL.');
        }
        const proxyError = response.headers.get('X-WebR-Proxy-Error');
        if (proxyError) {
          let message = `The Worker rejected the request (HTTP ${response.status}).`;
          try {
            const body = await response.json();
            if (typeof body.error === 'string' && body.error) message = body.error;
          } catch { /* Use the HTTP status when an error body is unavailable. */ }
          throw new Error(`Cloudflare proxy: ${redact(message)}`);
        }
        if (payload.action === 'check') {
          if (!response.ok) throw new Error(`The Worker connection check returned HTTP ${response.status}.`);
          let body;
          try { body = await response.json(); }
          catch { throw new Error('The Worker returned an invalid connection check. Deploy the webR Studio proxy Worker.'); }
          if (body?.service !== SERVICE || body?.protocol !== Number(PROTOCOL)) {
            throw new Error('The Worker returned an incompatible connection check. Deploy the webR Studio proxy Worker.');
          }
          return true;
        }
        const statusHeader = response.headers.get('X-WebR-Upstream-Status');
        const status = Number(statusHeader);
        if (!/^\d{3}$/.test(statusHeader || '') || status < 200 || status > 599 || status !== response.status) {
          throw new Error('The Worker returned an invalid upstream response. Check the deployed proxy version.');
        }
        return { status, statusText: response.statusText, body: await response.arrayBuffer() };
      })();
      return await Promise.race([request, aborted]);
    } catch (error) {
      // Do not attach an unsanitized cause: fetch or a server error could echo
      // the private token, and UI/export code must never receive that value.
      if (controller.signal.aborted) throw new Error(abortMessage());
      throw new Error(redact(error?.message || 'The Cloudflare proxy request failed.'));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
      controller.signal.removeEventListener('abort', onAbort);
      this.#controllers.delete(controller);
      // Also stop unread response bodies when protocol validation fails.
      controller.abort();
    }
  }
}
