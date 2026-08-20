/* 学员管理工作台 Service Worker —— 离线缓存 + 通知点击 */
const CACHE = "smw-v2";  // 版本升级：v2 强制旧缓存作废，部署后手机自动换新版
const ASSETS = [".", "index.html", "styles.css", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match("index.html")))
  );
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(cls => {
    for (const c of cls) if ("focus" in c) return c.focus();
    if (self.clients.openWindow) return self.clients.openWindow(".");
  }));
});

// 系统级推送（关屏/被杀也能到达）
self.addEventListener("push", e => {
  let data = { title: "学员提醒", body: "" };
  try { if (e.data) data = Object.assign(data, e.data.json()); } catch {}
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: "icon-192.png", badge: "icon-192.png",
    tag: data.tag || "smw", renotify: true, data: { url: "." }
  }));
});
