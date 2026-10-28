/* VELORI enhancement worker: public static assets and Web Push only. */
const WORKER_RELEASE =
  /(?:^|[?&])version=([^&]+)/.exec(self.location.search || "")?.[1] || "base";
const STATIC_CACHE = `velori-static-v3-${WORKER_RELEASE.replace(/[^a-z0-9._-]/gi, "_")}`;
const PUBLIC_FILES = new Set([
  "favicon.svg",
  "offline.html",
  "pwa-192x192.png",
  "pwa-512x512.png",
  "pwa-maskable-512x512.png",
  "apple-touch-icon.png",
  "velori-official.svg",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // Required: a new worker must not replace a usable one without its fallback.
      await cache.add(
        new Request(new URL("offline.html", self.registration.scope), { cache: "reload" }),
      );
      await Promise.all(
        [...PUBLIC_FILES]
          .filter((file) => file !== "offline.html")
          .map((file) => cache.add(new URL(file, self.registration.scope).href).catch(() => {})),
      );
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("velori-static-") && key !== STATIC_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        let response;
        try {
          response = await fetch(request, { signal: controller.signal });
          if (response.status < 500) return response;
        } catch {
          // Network rejection and timeout use the same self-contained recovery UI.
        } finally {
          clearTimeout(timer);
        }
        try {
          const cache = await caches.open(STATIC_CACHE);
          const offline = await cache.match(new URL("offline.html", self.registration.scope).href);
          if (offline)
            return new Response(await offline.text(), {
              status: 503,
              headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "Retry-After": "30",
              },
            });
        } catch {
          /* Storage can be unavailable; preserve any server response. */
        }
        return (
          response ||
          new Response("VELORI is unavailable. Please reconnect and try again.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          })
        );
      })(),
    );
    return;
  }
  if (url.search) return;

  const scopePath = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scopePath)) return;
  const relativePath = url.pathname.slice(scopePath.length);
  const publicFile = PUBLIC_FILES.has(relativePath);
  const builtAsset =
    relativePath.startsWith("assets/") &&
    /[-.][a-z0-9_-]{8,}\.(?:js|css|woff2?|ttf|otf|svg|png|webp|avif|jpg|jpeg)$/i.test(relativePath);
  if (!publicFile && !builtAsset) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      const contentType = response.headers.get("content-type") || "";
      if (
        response.ok &&
        response.type === "basic" &&
        /^(?:text\/css|text\/javascript|application\/javascript|font\/|image\/)/i.test(contentType)
      ) {
        await cache.put(request, response.clone()).catch(() => {});
        const keys = await cache.keys();
        if (keys.length > 120) {
          const disposable = keys.find(
            (key) => !PUBLIC_FILES.has(new URL(key.url).pathname.slice(scopePath.length)),
          );
          if (disposable) await cache.delete(disposable);
        }
      }
      return response;
    })(),
  );
});

function notificationTarget(value) {
  const fallback = new URL("notifications", self.registration.scope).pathname;
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  )
    return fallback;
  try {
    const target = new URL(value, self.registration.scope);
    if (
      target.origin !== self.location.origin ||
      !target.pathname.startsWith(new URL(self.registration.scope).pathname)
    )
      return fallback;
    return target.pathname + target.search + target.hash;
  } catch {
    return fallback;
  }
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "You have a new notification." };
  }

  const title =
    typeof payload.title === "string" && payload.title.trim() ? payload.title : "VELORI";
  const body = typeof payload.body === "string" ? payload.body : "You have a new notification.";
  const target = notificationTarget(payload.url);

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: new URL("pwa-192x192.png", self.registration.scope).href,
      badge: new URL("pwa-192x192.png", self.registration.scope).href,
      tag: typeof payload.tag === "string" ? payload.tag : undefined,
      data: { url: target },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const safeTarget = notificationTarget(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        const current = new URL(client.url);
        if (current.origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) await client.navigate(safeTarget);
          return;
        }
      }
      await self.clients.openWindow(safeTarget);
    })(),
  );
});
