const CACHE_PREFIX = 'offline-todos-'
// Added a versioned offline-todos-v2 cache.
const CACHE = `${CACHE_PREFIX}v2`
const CACHEABLE_DESTINATIONS = new Set(['script', 'style', 'image', 'font', 'worker', 'manifest'])

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await cache.add('/')
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    // Deletes obsolete app caches during activation.
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE)
      .map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  // Excludes APIs, Electric, cross-origin requests, and other application-data fetches.
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return

  // Uses network-first loading for navigation, preventing stale HTML after deployment.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request))
    return
  }

  // Caches only same-origin static/build assets.
  // Preserves offline loading of PGlite .wasm and .data assets.
  const isBuildAsset = CACHEABLE_DESTINATIONS.has(request.destination) || /\.(?:wasm|data)$/.test(url.pathname)
  if (isBuildAsset) event.respondWith(cacheFirst(request))
})

async function networkFirst(request) {
  try {
    const response = await fetch(request)
    // Caches only successful responses.
    if (response.ok) {
      const cache = await caches.open(CACHE)
      // Awaits every cache write so the worker remains alive until completion.
      await cache.put(request, response.clone())
    }
    return response
  } catch (error) {
    // Falls back to cached navigation content while offline.
    const cached = await caches.match(request) || await caches.match('/')
    if (cached) return cached
    throw error
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(CACHE)
    await cache.put(request, response.clone())
  }
  return response
}
