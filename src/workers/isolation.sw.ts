/// <reference lib="webworker" />
/**
 * Cross-origin isolation on a static host (GitHub Pages). SharedArrayBuffer needs the COOP and COEP headers
 * (plan principle 6). `pnpm dev` and `pnpm start` send them (vite.config.ts), but a static host can't. This service
 * worker re-serves every same-origin response with the headers added. The build emits it as `coi-sw.js` next to
 * index.html (vite.config.ts), and src/app/isolation.ts registers it only when the page isn't isolated already.
 */
export {};

const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener('install', () => void sw.skipWaiting());
sw.addEventListener('activate', (event) => event.waitUntil(sw.clients.claim()));

sw.addEventListener('fetch', (event) => {
  const request = event.request;
  // Chrome rejects these when they're re-fetched (a devtools quirk); leave them to the browser.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  if (new URL(request.url).origin !== sw.location.origin) return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }),
  );
});
