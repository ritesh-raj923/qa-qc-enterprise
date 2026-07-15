const CACHE_NAME = 'qaqc-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json'
  // Add any other static assets (fonts, icons) here
];

// Install event – cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
  // Activate immediately
  self.skipWaiting();
});

// Activate event – clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  // Take control of all open clients immediately
  return self.clients.claim();
});

// Fetch event – serve from cache, fall back to network
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Cache hit – return the cached version
        if (response) {
          return response;
        }
        // Otherwise, fetch from network
        return fetch(event.request).then(
          response => {
            // Check if we received a valid response
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            // Clone the response and cache it for next time
            const responseToCache = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => {
                cache.put(event.request, responseToCache);
              });
            return response;
          }
        );
      })
  );
});
// ============================================================
// PUSH NOTIFICATIONS HANDLERS (ADDED)
// ============================================================

self.addEventListener('push', event => {
  try {
    const data = event.data.json();
    const options = {
      body: data.body || 'New notification',
      icon: data.icon || '/icon.png',
      badge: '/badge.png',
      vibrate: [200, 100, 200],
      data: data.data || {},
      actions: [
        { action: 'open', title: 'Open App' },
        { action: 'dismiss', title: 'Dismiss' }
      ]
    };
    event.waitUntil(
      self.registration.showNotification(data.title || 'QA/QC Suite', options)
    );
  } catch (error) {
    console.error('Push notification error:', error);
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const action = event.action;
  const rfiId = event.notification.data?.rfi_id || 
                event.notification.data?.rfiId || 
                event.notification.data?.id;
  if (action === 'dismiss') return;
  
  let url = '/';
  if (rfiId) {
    // If your app uses hash routing (e.g., /#record/123):
    url = `/#record/${rfiId}`;
    // If it uses query params, use: url = `/?record=${rfiId}`;
  }
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientsArr => {
        for (const client of clientsArr) {
          if (client.url.includes(url) && 'focus' in client) {
            return client.focus();
          }
        }
        return clients.openWindow(url);
      })
  );
});
