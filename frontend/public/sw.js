const CACHE = 'offline-todos-v1'

self.addEventListener('install', (event) => {
   event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/'])))
   self.skipWaiting()
})

self.addEventListener('activate', (event) => {
   event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
   if (event.request.method !== 'GET') return
   const url = new URL(event.request.url)
   if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
   event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
         const copy = response.clone()
         caches.open(CACHE).then((cache) => cache.put(event.request, copy))
         return response
      })),
   )
})
