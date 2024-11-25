// service-worker.js

const CACHE_NAME = 'vibeai-cache-v1';
const URLs_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',  // Add your CSS files
  '/index.js',      // Add your main JavaScript file
  '/logo2.png', // Add other icons used in your app
  '/logo.jpg',
];

// Install the service worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Caching files...');
        return cache.addAll(URLs_TO_CACHE);
      })
  );
});

// Activate the service worker and clean up old caches
self.addEventListener('activate', (event) => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!cacheWhitelist.includes(cacheName)) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Fetch and serve cached files (offline support)
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;  // Return cached response if available
        }
        return fetch(event.request);  // Otherwise fetch from network
      })
  );
});
