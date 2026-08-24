const CACHE = "cooper2talk-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(["/", "/manifest.webmanifest", "/app-icon.svg"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "show-notification") return;
  const { title, body, tag } = event.data;
  event.waitUntil(self.registration.showNotification(title, { body, tag, icon: "/app-icon.svg", badge: "/app-icon.svg" }));
});
