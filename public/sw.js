/* Gandhify service worker: app-shell cache, network-first HTML, offline start.
 *
 * versioned cache name — bumping it (or the hashed assets in the built
 * index.html) guarantees the previous build's stale shell is discarded on
 * activate. */
const CACHE = 'gandhify-shell-v3'
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './fonts/archivo-var.woff2', './fonts/archivo-italic-900.woff2', './fonts/spacemono-400.woff2', './fonts/spacemono-700.woff2']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

const isHtml = (request) =>
  request.mode === 'navigate' ||
  (request.headers.get('accept') || '').includes('text/html')

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (isHtml(request)) {
    // network-first so new builds actually reach users; cached copy is the
    // offline fallback, and successful responses refresh the cache.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone()
            caches.open(CACHE).then((cache) => cache.put(request, copy))
            return response
          }
          // online but the server erred — serve whatever shell we already have
          // rather than showing a hard error page
          return caches.match(request).then((cached) => cached || response)
        })
        .catch(() => caches.match(request).then((cached) => cached || Response.error())),
    )
    return
  }

  // hashed/immutable assets: cache-first is fine, they can only change when
  // the (network-fetched) index.html points at new hashes.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response && response.ok) {
            const copy = response.clone()
            caches.open(CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        }),
    ),
  )
})