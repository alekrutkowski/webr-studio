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

  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', event => {
    const request = event.request;
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
