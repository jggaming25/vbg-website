"use strict";
// VBG Orga – Service Worker für System-/Desktop-Benachrichtigungen (Web Push)

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener("push", (event) => {
  let data = { title: "VBG Orga", body: "", url: "/" };
  try {
    if (event.data) data = Object.assign({}, data, event.data.json());
  } catch (e) {}
  const opts = {
    body: data.body || "",
    url: data.url || "/",
    tag: data.tag || "vbg",
    renotify: data.renotify === true,
    data: { url: data.url || "/" },
  };
  event.waitUntil(
    self.registration.showNotification(data.title || "VBG Orga", opts)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.navigate(target);
          return c.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});