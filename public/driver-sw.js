/* Only the driver navigation is handled. No orders, credentials or API data are cached. */
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.mode === 'navigate' && url.origin === self.location.origin
      && (url.pathname === '/driver' || url.pathname === '/driver/')) {
    event.respondWith(fetch(event.request));
  }
});
