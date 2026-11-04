// Throwaway Mail service worker.
// Caches the app shell only (index.html, hashed assets, icons) so the app opens and installs offline-capable.
// API responses (/v1/*) and anything else dynamic are never cached: they always go to the network.
// Also shows Web Push notifications (new code, leak alert...).
"use strict";

const CACHE = "tm-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isShellAsset = (url) =>
  url.pathname.startsWith("/assets/") ||
  /^\/(favicon\.svg|icon-[\w-]+\.png|apple-touch-icon\.png|manifest\.webmanifest)$/.test(url.pathname);
const isApi = (url) =>
  url.pathname.startsWith("/v1/") || ["/openapi.json", "/docs", "/healthz", "/metrics", "/api"].some((p) => url.pathname.startsWith(p));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || isApi(url)) return; // network only, never cached
  if (req.mode === "navigate") {
    // Network first so a new deployment is picked up; the cached shell when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && (res.headers.get("content-type") || "").includes("text/html")) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/").then((r) => r || Response.error())),
    );
    return;
  }
  if (isShellAsset(url)) {
    // Hashed assets are immutable: cache first.
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Throwaway Mail", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Throwaway Mail";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: data.tag || undefined,
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  // Only ever open pages of this app.
  const href = target.origin === self.location.origin ? target.href : self.location.origin + "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.navigate?.(href);
          return c.focus();
        }
      }
      return self.clients.openWindow(href);
    }),
  );
});
