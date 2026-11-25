/* Service worker: guarda la app para abrirla sin señal.
   El pronóstico y las alertas van siempre primero a la red; si no hay, usa lo último guardado. */
const VERSION = "clima-v13";
const TILE_CACHE = "campo-teselas"; // mapa Sentinel-2 guardado para usar sin señal (no se borra al actualizar)
const SHELL = ["./", "index.html", "styles.css", "app.js", "privado.js", "campo.js", "firebase.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && !k.startsWith("campo-")).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Sentinel-2 de Campo: primero lo guardado; lo que se mira con señal también queda guardado.
  if (url.host === "tiles.maps.eox.at") {
    e.respondWith(caches.open(TILE_CACHE).then((c) => c.match(req.url).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === "cors") c.put(req.url, res.clone());
      return res;
    }))));
    return;
  }
  // Teselas de mapa, radar y satélite: no se guardan (cambian todo el tiempo y ocupan mucho).
  if (/tile\.openstreetmap|gibs\.earthdata|tilecache\.rainviewer|arcgisonline\.com/.test(url.host)) return;
  const sameOrigin = url.origin === self.location.origin;
  const isData = url.pathname.endsWith("alerts.json") || url.pathname.endsWith("gibs.json") || url.pathname.endsWith("fires.json") || /open-meteo\.com|rainviewer\.com/.test(url.host);
  if (isData) {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res; })
      .catch(() => caches.match(req, { ignoreSearch: url.pathname.endsWith("alerts.json") })));
    return;
  }
  // La base de Firebase y el ingreso manejan su propia red: no se tocan.
  if (/googleapis\.com|firebaseapp\.com|firebaseio\.com/.test(url.host)) return;
  if (sameOrigin || url.host === "unpkg.com" || (url.host === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/"))) {
    // App: lo guardado al instante y se actualiza por detrás.
    e.respondWith(caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
