/* Push only: no fetch handler or offline cache for authenticated content. */
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
function destination(value) {
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin === self.location.origin && (url.pathname === "/" || /^\/agents\/[1-9]\d{0,9}$/.test(url.pathname))) return url.href;
  } catch {}
  return self.location.origin + "/";
}
self.addEventListener("push", event => {
  let data = {};
  try { const value = event.data?.json(); if (value && typeof value === "object") data = value; } catch {}
  const title = typeof data.title === "string" && data.title.trim() ? Array.from(data.title.trim()).slice(0, 80).join("") : "Agent update";
  const body = typeof data.body === "string" ? Array.from(data.body).slice(0, 500).join("") : "An agent has an update. Open Corgi to check.";
  event.waitUntil(self.registration.showNotification(title, {
    body, tag: typeof data.tag === "string" ? data.tag.slice(0, 150) : "corgi-update",
    icon: "/apple-touch-icon.png", data: {url: destination(data.url)},
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = destination(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: "window", includeUncontrolled: true});
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try {
        const navigated = await client.navigate(url);
        if (navigated) { await navigated.focus(); return; }
      } catch {}
    }
    await self.clients.openWindow(url);
  })());
});
