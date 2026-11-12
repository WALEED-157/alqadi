// Service worker: الشبكة أولاً، والكاش عند انقطاع الإنترنت
// (المخزون نفسه محفوظ في IndexedDB — هنا ملفات التطبيق بس)
// cache: "no-cache" = نسأل السيرفر كل مرة لو الملف تغيّر (ما ناخذ نسخة المتصفح القديمة)
const CACHE = "inv-v30";
const SHELL = ["./", "index.html", "styles.css", "app.js", "toyota.js", "db.js", "config.js", "vendor/supabase.js", "icon.svg", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;          // طلبات Supabase ما نتدخل فيها
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
