/*
 * Cross-origin isolation bootstrap for static hosts such as GitHub Pages.
 * The same file runs once in the page and thereafter as a service worker.
 * Inspired by coi-serviceworker, implemented locally to keep deployment self-contained.
 */
(() => {
  const COOP = 'same-origin';
  const COEP = 'require-corp';

  if (typeof window !== 'undefined') {
    if (!('serviceWorker' in navigator) || window.crossOriginIsolated) return;

    navigator.serviceWorker.register('./coi-serviceworker.js', { scope: './' })
      .then(registration => {
        const reloadOnce = () => {
          if (navigator.serviceWorker.controller) return;
          const key = 'webr-studio-coi-reload';
          if (sessionStorage.getItem(key)) return;
          sessionStorage.setItem(key, '1');
          window.location.reload();
        };

        if (registration.active) reloadOnce();
        registration.addEventListener('updatefound', () => {
          registration.installing?.addEventListener('statechange', event => {
            if (event.target.state === 'activated') reloadOnce();
          });
        });
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
      let response;
      try {
        response = await fetch(request);
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
      headers.set('Cross-Origin-Resource-Policy', request.url.startsWith(self.location.origin) ? 'same-origin' : 'cross-origin');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    })());
  });
})();
