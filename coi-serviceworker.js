/*
 * Cross-origin isolation bootstrap for static hosts such as GitHub Pages.
 * The same file runs once in the page and thereafter as a service worker.
 * Inspired by coi-serviceworker, implemented locally to keep deployment self-contained.
 */
(() => {
  const COOP = 'same-origin';
  const COEP = 'require-corp';

  if (typeof window !== 'undefined') {
    if (!('serviceWorker' in navigator)) return;

    const reloadKey = 'webr-studio-coi-reload-v3';
    let reloadScheduled = false;
    const reloadUnderController = () => {
      // clients.claim() can install a controller for the current document, but
      // that document was loaded without COOP/COEP. Reload exactly once so the
      // navigation itself passes through the service worker and becomes
      // cross-origin isolated.
      if (window.crossOriginIsolated || reloadScheduled || !navigator.serviceWorker.controller) return;
      if (sessionStorage.getItem(reloadKey)) return;
      reloadScheduled = true;
      sessionStorage.setItem(reloadKey, '1');
      window.location.reload();
    };

    if (window.crossOriginIsolated) sessionStorage.removeItem(reloadKey);
    navigator.serviceWorker.addEventListener('controllerchange', reloadUnderController);
    navigator.serviceWorker.register('./coi-serviceworker.js', {
      scope: './',
      updateViaCache: 'none'
    })
      .then(async registration => {
        // Do not skip update checks merely because the current document is
        // already isolated. A stale worker can otherwise keep serving a mixed
        // set of application modules after a deployment.
        try { await registration.update(); } catch { /* Periodic checks remain available. */ }
        reloadUnderController();
        await navigator.serviceWorker.ready;
        reloadUnderController();
      })
      .catch(error => console.warn('Cross-origin isolation service worker was not registered:', error));
    return;
  }

  const NETWORK_PROTOCOL = 1;
  const NETWORK_ENDPOINT = new URL('./__webr_studio_network__/', self.location.href).href;
  const networkResponse = (status, body = new ArrayBuffer(0), statusText = '') => new Response(body, {
    // Preserve the target's status separately. A redirect or Set-Cookie from a
    // downloaded website must never become a redirect/cookie for the IDE.
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store, private',
      'Cross-Origin-Opener-Policy': COOP,
      'Cross-Origin-Embedder-Policy': COEP,
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-WebR-Network-Protocol': String(NETWORK_PROTOCOL),
      'X-WebR-Network-Status': String(status),
      'X-WebR-Network-Status-Text': encodeURIComponent(statusText)
    }
  });
  const networkError = message => networkResponse(0, new TextEncoder().encode(message));

  self.addEventListener('message', event => {
    if (event.data?.type !== 'webr-studio:network-register') return;
    const port = event.ports?.[0];
    if (!port) return;
    if (event.data.protocol !== NETWORK_PROTOCOL || event.source?.type !== 'window'
        || new URL(event.source.url).origin !== self.location.origin) {
      port.postMessage({ protocol: NETWORK_PROTOCOL, error: 'The networking client could not be registered.' });
    } else {
      port.postMessage({ protocol: NETWORK_PROTOCOL, clientId: event.source.id, endpoint: NETWORK_ENDPOINT });
    }
    port.close();
  });

  async function handleNetworkDownload(request) {
    if (request.method !== 'POST') return networkError('The private download endpoint requires POST.');
    try {
      const text = await request.text();
      if (text.length > 65_536) throw new Error('The download request is too large.');
      const data = JSON.parse(text);
      if (data.protocol !== NETWORK_PROTOCOL || typeof data.clientId !== 'string' || data.clientId.length > 256
          || !/^[a-f0-9]{48}$/.test(data.token || '') || data.method !== 'GET') {
        throw new Error('Invalid private download request.');
      }
      const target = new URL(data.url);
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only HTTP and HTTPS downloads are supported.');
      if (!Array.isArray(data.headers) || data.headers.length > 128 || data.headers.some(header => (
        !Array.isArray(header) || header.length !== 2 || typeof header[0] !== 'string' || typeof header[1] !== 'string'
        || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header[0]) || /[\r\n]/.test(header[1])
      ))) throw new Error('Invalid download request headers.');
      if (!Number.isInteger(data.maxRedirects) || data.maxRedirects <= 0 || data.maxRedirects > 100) {
        throw new Error('Invalid download redirect limit.');
      }
      // Resolve only the owning window. The token is checked again in that
      // window, so service-worker suspension/restart needs no saved sessions.
      const owner = await self.clients.get(data.clientId);
      if (!owner || owner.type !== 'window' || new URL(owner.url).origin !== self.location.origin) {
        throw new Error('The webR Studio tab owning this connection is closed.');
      }
      return await new Promise(resolve => {
        const channel = new MessageChannel();
        let settled = false;
        const finish = response => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', cancel);
          channel.port1.close();
          resolve(response);
        };
        const cancel = () => {
          try { channel.port1.postMessage({ type: 'cancel' }); } catch { /* The owner may already be closed. */ }
          finish(networkError('The download was cancelled or timed out.'));
        };
        const timer = setTimeout(cancel, 135_000);
        channel.port1.onmessage = event => {
          const response = event.data;
          if (response?.protocol !== NETWORK_PROTOCOL || !Number.isInteger(response.status)
              || response.status < 0 || response.status > 599) {
            finish(networkError('The download transport returned an invalid response.'));
            return;
          }
          try {
            finish(response.error
              ? networkError(String(response.error))
              : networkResponse(response.status, response.body, String(response.statusText || '')));
          } catch (error) { finish(networkError(error.message || String(error))); }
        };
        channel.port1.onmessageerror = () => finish(networkError('The download connection was interrupted.'));
        request.signal?.addEventListener('abort', cancel, { once: true });
        if (request.signal?.aborted) { cancel(); return; }
        try { owner.postMessage({ ...data, type: 'webr-studio:network-download', url: target.href }, [channel.port2]); }
        catch (error) { channel.port2.close(); finish(networkError(error.message || String(error))); }
      });
    } catch (error) {
      return networkError(error.message || String(error));
    }
  }

  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.url.split(/[?#]/, 1)[0] === NETWORK_ENDPOINT) {
      const response = handleNetworkDownload(request);
      event.respondWith(response);
      event.waitUntil(response.then(() => undefined));
      return;
    }
    if (request.method !== 'GET') return;
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

    event.respondWith((async () => {
      const sameOrigin = new URL(request.url).origin === self.location.origin;
      const shellRequest = sameOrigin && (
        request.mode === 'navigate'
        || ['document', 'script', 'style', 'worker', 'manifest'].includes(request.destination)
        || /\.(?:html?|js|css|webmanifest)(?:[?#]|$)/i.test(request.url)
      );
      let response;
      try {
        response = await fetch(shellRequest ? new Request(request, { cache: 'no-store' }) : request);
      } catch (error) {
        if (request.mode === 'navigate') {
          try { response = await caches.match('./index.html'); } catch { /* Continue with the original error. */ }
        }
        if (!response) throw error;
      }

      if (response.type === 'opaque' || response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', COOP);
      headers.set('Cross-Origin-Embedder-Policy', COEP);
      headers.set('Cross-Origin-Resource-Policy', sameOrigin ? 'same-origin' : 'cross-origin');
      if (shellRequest) headers.set('Cache-Control', 'no-store');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    })());
  });
})();
