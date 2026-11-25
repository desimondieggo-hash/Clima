// Campo: GPS sobre satélite, tracks, puntos con foto y medición de distancias y áreas.
// Todo se guarda en el teléfono (IndexedDB) y funciona sin señal; el mapa Sentinel-2 se puede bajar antes.
(() => {
"use strict";
const $ = (id) => document.getElementById(id);
const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ------------------------------------------------------------------ Mapas de fondo
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const S2 = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg";
const S2_MAX = 15;                 // último nivel con detalle propio (10 m por píxel)
const TILE_CACHE = "campo-teselas"; // el service worker también la usa
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const LS_VIEW = "campo.view", LS_BASE = "campo.base";

const WP_TYPES = [
  ["mojon", "📍", "Mojón / límite"], ["tranquera", "🚧", "Tranquera"], ["alambrado", "〰️", "Alambrado"],
  ["camino", "🟫", "Camino / picada"], ["arbol", "🌳", "Árbol caído"], ["plaga", "🐜", "Hormiga / plaga"],
  ["fuego", "🔥", "Fuego / quema"], ["agua", "💧", "Agua / bañado"], ["dano", "⚠️", "Daño / problema"], ["otro", "📌", "Otro"],
];
const wpType = (k) => WP_TYPES.find((t) => t[0] === k) || WP_TYPES[WP_TYPES.length - 1];

// ------------------------------------------------------------------ Medidas en la Tierra
const R = 6371008.8, rad = (d) => d * Math.PI / 180;
function dist(a, b) {
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
const lengthOf = (pts, closed = false) => {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) d += dist(pts[pts.length - 1], pts[0]);
  return d;
};
/** Área de un polígono sobre la esfera, en m² (la misma fórmula que usa Leaflet.draw). */
function areaOf(pts) {
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i], p2 = pts[(i + 1) % pts.length];
    a += rad(p2[1] - p1[1]) * (2 + Math.sin(rad(p1[0])) + Math.sin(rad(p2[0])));
  }
  return Math.abs(a * R * R / 2);
}
const nf = (v, d) => v.toLocaleString("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtDist = (m) => m < 1000 ? `${nf(m, 0)} m` : `${nf(m / 1000, m < 10000 ? 2 : 1)} km`;
const fmtArea = (m2) => m2 < 10000 ? `${nf(m2 / 10000, 3)} ha (${nf(m2, 0)} m²)` : `${nf(m2 / 10000, 2)} ha`;
const fmtTime = (ms) => { const s = Math.round(ms / 1000), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60); return hh ? `${hh} h ${mm} min` : `${mm} min ${s % 60} s`; };
const fmtDate = (t) => new Date(t).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const coordTxt = (lat, lon) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

// ------------------------------------------------------------------ Base del teléfono (IndexedDB)
let dbp = null;
function db() {
  return dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open("campo", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("items", { keyPath: "id" }); r.result.createObjectStore("fotos"); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
async function run(stores, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => res(req && "result" in req ? req.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const dbAll = () => run("items", "readonly", (t) => t.objectStore("items").getAll());
const dbPut = (it) => run("items", "readwrite", (t) => { t.objectStore("items").put(it); });
const dbPhoto = (id) => run("fotos", "readonly", (t) => t.objectStore("fotos").get(id));
const dbPutPhoto = (id, blob) => run("fotos", "readwrite", (t) => { t.objectStore("fotos").put(blob, id); });
const dbDel = (id) => run(["items", "fotos"], "readwrite", (t) => { t.objectStore("items").delete(id); t.objectStore("fotos").delete(id); });
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ------------------------------------------------------------------ Estado
let cmap = null, baseEsri, baseS2, prediosLayer, itemsLayer, liveLayer, meMarker, accCircle;
let gps = null, watchId = null, follow = true, wakeLock = null;
let items = [];
let track = null;   // { id, name, pts: [[lat, lon, t, acc]], start, paused, line }
let measure = null; // { mode: "linea" | "area", pts: [], markers: [], shape }
let pick = null;    // posición elegida para un punto nuevo

// ------------------------------------------------------------------ Mapa
function sizeMap() {
  const sec = $("tab-campo");
  if (!sec) return;
  const top = document.querySelector(".top").offsetHeight, nav = document.querySelector(".tabs").offsetHeight;
  sec.style.height = `${window.innerHeight - top - nav}px`;
  if (cmap) cmap.invalidateSize();
}

function initCampo() {
  document.body.classList.add("campo-on");
  sizeMap();
  if (cmap) { setTimeout(() => cmap.invalidateSize(), 50); startGps(); return; }
  if (!window.L) { $("campoMap").innerHTML = `<p class="pad muted">No se pudo cargar el mapa.</p>`; return; }
  const v = store.get(LS_VIEW);
  cmap = L.map("campoMap", { zoomControl: false, maxZoom: 20, minZoom: 5, attributionControl: true })
    .setView(v ? [v.lat, v.lon] : PROV.center, v ? v.z : 8);
  cmap.attributionControl.setPrefix(false);
  baseS2 = L.tileLayer(S2, {
    maxNativeZoom: S2_MAX, maxZoom: 20, crossOrigin: true, errorTileUrl: BLANK,
    attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX (Copernicus 2016-17)',
  }).addTo(cmap);
  baseEsri = L.tileLayer(ESRI, {
    maxNativeZoom: 19, maxZoom: 20, errorTileUrl: BLANK,
    attribution: '© Esri, Maxar, Earthstar Geographics',
  });
  if ((store.get(LS_BASE) || "esri") === "esri") baseEsri.addTo(cmap);
  updateBaseBtn();
  L.control.scale({ imperial: false, position: "bottomleft" }).addTo(cmap);
  prediosLayer = L.layerGroup().addTo(cmap);
  itemsLayer = L.layerGroup().addTo(cmap);
  liveLayer = L.layerGroup().addTo(cmap);
  drawCampoPredios();
  loadItems();

  cmap.on("dragstart", () => { if (follow) { follow = false; updateFollowBtn(); } });
  cmap.on("moveend", () => { const c = cmap.getCenter(); store.set(LS_VIEW, { lat: c.lat, lon: c.lng, z: cmap.getZoom() }); });
  cmap.on("click", (e) => { if (measure) addMeasurePoint([e.latlng.lat, e.latlng.lng]); });
  cmap.on("contextmenu", (e) => { if (!measure) openWp([e.latlng.lat, e.latlng.lng], "mapa"); });

  $("cFollow").onclick = () => { follow = true; updateFollowBtn(); if (gps) cmap.setView([gps.lat, gps.lon], Math.max(cmap.getZoom(), 16)); else startGps(); };
  $("cBase").onclick = toggleBase;
  $("cDatos").onclick = openDatos;
  $("cTrack").onclick = () => (track ? showTrackPanel() : startTrack());
  $("cPoint").onclick = () => openWp(gps ? [gps.lat, gps.lon] : null, "gps");
  $("cMeasure").onclick = () => (measure ? null : startMeasure());
  startGps();
  if (!v) setTimeout(() => { if (!gps && predios.length) fitPredios(); }, 1500);
}
function leaveCampo() {
  document.body.classList.remove("campo-on");
  if (!track) stopGps();
}
window.initCampo = initCampo;
window.leaveCampo = leaveCampo;
window.addEventListener("resize", () => { if (document.body.classList.contains("campo-on")) sizeMap(); });

function toggleBase() {
  if (cmap.hasLayer(baseEsri)) { cmap.removeLayer(baseEsri); store.set(LS_BASE, "s2"); toast("Fondo Sentinel-2 (el que se guarda para usar sin señal)"); }
  else { baseEsri.addTo(cmap); store.set(LS_BASE, "esri"); toast("Fondo satelital Esri (necesita señal)"); }
  updateBaseBtn();
}
function updateBaseBtn() { $("cBase").textContent = cmap && cmap.hasLayer(baseEsri) ? "🛰️" : "🌍"; }
function updateFollowBtn() { $("cFollow").classList.toggle("on", follow); }

function fitPredios() {
  if (!predios.length) return;
  cmap.fitBounds(L.latLngBounds(predios.flatMap((pr) => pr.p.flatMap((r) => r[0]))), { padding: [20, 20] });
}
function drawCampoPredios() {
  if (!prediosLayer) return;
  prediosLayer.clearLayers();
  for (const pr of predios) {
    L.polygon(pr.p, { color: "#111", weight: 5, opacity: 0.55, fill: false, interactive: false }).addTo(prediosLayer);
    L.polygon(pr.p, { color: "#ffe14d", weight: 2.2, fillOpacity: 0, interactive: false }).addTo(prediosLayer);
  }
}
window.onPrediosLoaded = () => { drawCampoPredios(); updateStatus(); };
function predioAt(lat, lon) {
  for (const pr of predios) for (const rings of pr.p) {
    if (pointInPolygon(lat, lon, rings[0]) && !rings.slice(1).some((hole) => pointInPolygon(lat, lon, hole))) return pr;
  }
  return null;
}

let toastTimer;
function toast(msg) {
  const t = $("cToast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// ------------------------------------------------------------------ GPS
function startGps() {
  if (watchId != null) return;
  if (!("geolocation" in navigator)) { $("cStatus").textContent = "Este teléfono no tiene GPS disponible."; return; }
  $("cStatus").textContent = "Buscando GPS…";
  watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 1000, timeout: 60000 });
}
function stopGps() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}
function onPosErr(e) {
  $("cStatus").textContent = e.code === 1
    ? "Sin permiso de ubicación: habilitalo para este sitio en el navegador."
    : "Sin señal de GPS todavía… (salí a cielo abierto)";
}
function onPos(p) {
  const c = p.coords;
  gps = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, head: c.heading, speed: c.speed, t: p.timestamp };
  const ll = [gps.lat, gps.lon];
  const moving = gps.head != null && !isNaN(gps.head) && (gps.speed || 0) > 0.6;
  const icon = L.divIcon({
    className: "c-me",
    html: moving ? `<div class="c-arrow" style="transform:rotate(${gps.head}deg)"></div>` : `<div class="c-dot"></div>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  });
  if (!meMarker) {
    accCircle = L.circle(ll, { radius: gps.acc, color: "#2f8cff", weight: 1, fillOpacity: 0.12, interactive: false }).addTo(liveLayer);
    meMarker = L.marker(ll, { icon, interactive: false, zIndexOffset: 1000 }).addTo(liveLayer);
    if (follow) cmap.setView(ll, Math.max(cmap.getZoom(), 16));
  } else {
    meMarker.setLatLng(ll).setIcon(icon);
    accCircle.setLatLng(ll).setRadius(gps.acc);
    if (follow) cmap.panTo(ll, { animate: true });
  }
  if (track && !track.paused) addTrackPoint(gps);
  updateStatus();
}
function updateStatus() {
  if (!gps) return;
  const pr = predios.length ? predioAt(gps.lat, gps.lon) : null;
  const q = gps.acc <= 10 ? "buena" : gps.acc <= 30 ? "regular" : "baja";
  $("cStatus").innerHTML = `<b>±${Math.round(gps.acc)} m</b> <span class="q-${q}">GPS ${q}</span>` +
    (pr ? ` · 🌲 <b>${h(pr.n)}</b>` : "") + `<br><small>${coordTxt(gps.lat, gps.lon)}</small>`;
}

// Mantiene la pantalla prendida mientras se graba (si se apaga, el navegador corta el GPS).
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator) { wakeLock = await navigator.wakeLock.request("screen"); }
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* no disponible */ }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && track && !track.paused) keepAwake(true); });

// ------------------------------------------------------------------ Tracks
function startTrack() {
  stopMeasure();
  const t0 = Date.now();
  track = { id: newId(), kind: "track", name: `Recorrido ${fmtDate(t0)}`, created: t0, pts: [], paused: false, line: null };
  track.line = L.polyline([], { color: "#ff5a1f", weight: 4 }).addTo(liveLayer);
  keepAwake(true);
  startGps();
  follow = true; updateFollowBtn();
  if (gps && Date.now() - gps.t < 15000) addTrackPoint(gps);
  showTrackPanel();
  toast("Grabando recorrido. Dejá la pantalla prendida.");
}
function addTrackPoint(p) {
  if (p.acc > 35) return; // descarta lecturas malas
  const last = track.pts[track.pts.length - 1];
  if (last && dist(last, [p.lat, p.lon]) < Math.max(3, p.acc / 3) && p.t - last[2] < 60000) return;
  track.pts.push([+p.lat.toFixed(7), +p.lon.toFixed(7), p.t, Math.round(p.acc)]);
  track.line.addLatLng([p.lat, p.lon]);
  if (track.pts.length % 10 === 0) saveTrackDraft();
  renderTrackPanel();
}
function trackItem() {
  return { id: track.id, kind: "track", name: track.name, created: track.created, pts: track.pts, dist: lengthOf(track.pts), dur: track.pts.length > 1 ? track.pts[track.pts.length - 1][2] - track.pts[0][2] : 0 };
}
function saveTrackDraft() { dbPut({ ...trackItem(), draft: true }).catch(() => {}); }
function showTrackPanel() {
  $("cPanel").classList.remove("hidden");
  renderTrackPanel();
}
function renderTrackPanel() {
  if (!track) return;
  const it = trackItem();
  $("cPanel").innerHTML = `
    <div class="c-ptitle">${track.paused ? "⏸ Recorrido en pausa" : "<span class=\"rec\"></span> Grabando recorrido"}</div>
    <div class="c-stats"><div><span>Distancia</span><b>${fmtDist(it.dist)}</b></div><div><span>Tiempo</span><b>${fmtTime(Date.now() - track.created)}</b></div><div><span>Puntos</span><b>${track.pts.length}</b></div></div>
    <div class="c-btns">
      <button type="button" class="btn ghost" id="tPause">${track.paused ? "▶ Seguir" : "⏸ Pausa"}</button>
      <button type="button" class="btn" id="tStop">⏹ Terminar y guardar</button>
    </div>
    <p class="muted small">Si la pantalla se apaga, el teléfono deja de grabar.</p>`;
  $("tPause").onclick = () => { track.paused = !track.paused; keepAwake(!track.paused); renderTrackPanel(); };
  $("tStop").onclick = finishTrack;
}
setInterval(() => { if (track && !track.paused && !$("cPanel").classList.contains("hidden") && document.body.classList.contains("campo-on")) renderTrackPanel(); }, 5000);
async function finishTrack() {
  if (track.pts.length < 2) {
    if (!confirm("El recorrido casi no tiene puntos. ¿Descartarlo?")) return;
    await dbDel(track.id).catch(() => {});
  } else {
    const name = await askName("Guardar recorrido", track.name);
    if (name == null) return;
    track.name = name;
    await dbPut(trackItem());
    toast("Recorrido guardado");
  }
  liveLayer.removeLayer(track.line);
  track = null;
  keepAwake(false);
  $("cPanel").classList.add("hidden");
  loadItems();
}

// ------------------------------------------------------------------ Medir
function startMeasure() {
  if (track) { toast("Terminá el recorrido antes de medir."); return; }
  measure = { mode: "area", pts: [], markers: [], shape: null };
  follow = false; updateFollowBtn();
  $("campoMap").classList.add("measuring");
  renderMeasure();
}
function stopMeasure() {
  if (!measure) return;
  measure.markers.forEach((m) => liveLayer.removeLayer(m));
  if (measure.shape) liveLayer.removeLayer(measure.shape);
  measure = null;
  $("campoMap").classList.remove("measuring");
  $("cPanel").classList.add("hidden");
}
function addMeasurePoint(ll) {
  const m = L.marker(ll, { draggable: true, icon: L.divIcon({ className: "c-vtx", iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(liveLayer);
  const i = measure.pts.length;
  measure.pts.push(ll);
  measure.markers.push(m);
  m.on("drag", (e) => { measure.pts[measure.markers.indexOf(m)] = [e.latlng.lat, e.latlng.lng]; renderMeasure(true); });
  m.on("click", () => { if (i === 0 && measure.pts.length > 2) toast("Área cerrada. Tocá Guardar."); });
  renderMeasure();
}
function renderMeasure(onlyShape = false) {
  if (!measure) return;
  if (measure.shape) liveLayer.removeLayer(measure.shape);
  const area = measure.mode === "area";
  measure.shape = measure.pts.length > 1
    ? (area ? L.polygon(measure.pts, { color: "#00e5ff", weight: 3, fillOpacity: 0.18, interactive: false }) : L.polyline(measure.pts, { color: "#00e5ff", weight: 3, interactive: false })).addTo(liveLayer)
    : null;
  const len = lengthOf(measure.pts, area), a = area ? areaOf(measure.pts) : 0;
  const res = measure.pts.length < 2 ? "Tocá el mapa para marcar puntos, o caminá y tocá «Mi posición»."
    : area ? (measure.pts.length > 2 ? `<b>${fmtArea(a)}</b> · perímetro ${fmtDist(len)}` : "Marcá un punto más para cerrar el área.") : `<b>${fmtDist(len)}</b>`;
  if (onlyShape) { $("mRes").innerHTML = res; return; }
  $("cPanel").classList.remove("hidden");
  $("cPanel").innerHTML = `
    <div class="c-seg"><button type="button" data-m="area" class="${area ? "on" : ""}">⬠ Área</button><button type="button" data-m="linea" class="${area ? "" : "on"}">📏 Distancia</button></div>
    <p id="mRes" class="c-res">${res}</p>
    <div class="c-btns">
      <button type="button" class="btn ghost" id="mGps">📍 Mi posición</button>
      <button type="button" class="btn ghost" id="mUndo" ${measure.pts.length ? "" : "disabled"}>↶ Deshacer</button>
    </div>
    <div class="c-btns">
      <button type="button" class="btn ghost" id="mCancel">Cancelar</button>
      <button type="button" class="btn" id="mSave" ${measure.pts.length > (area ? 2 : 1) ? "" : "disabled"}>Guardar</button>
    </div>`;
  $("cPanel").querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => { measure.mode = b.dataset.m; renderMeasure(); }));
  $("mGps").onclick = () => {
    if (!gps) { toast("Todavía no hay GPS."); startGps(); return; }
    if (gps.acc > 30) toast(`Ojo: el GPS tiene ±${Math.round(gps.acc)} m.`);
    addMeasurePoint([gps.lat, gps.lon]);
  };
  $("mUndo").onclick = () => { liveLayer.removeLayer(measure.markers.pop()); measure.pts.pop(); renderMeasure(); };
  $("mCancel").onclick = stopMeasure;
  $("mSave").onclick = saveMeasure;
}
async function saveMeasure() {
  const area = measure.mode === "area";
  const a = area ? areaOf(measure.pts) : 0, len = lengthOf(measure.pts, area);
  const name = await askName(area ? "Guardar área" : "Guardar distancia", `${area ? "Área" : "Distancia"} ${fmtDate(Date.now())}`);
  if (name == null) return;
  await dbPut({ id: newId(), kind: "medida", mode: measure.mode, name, created: Date.now(), pts: measure.pts.map(([la, lo]) => [+la.toFixed(7), +lo.toFixed(7)]), area: a, dist: len });
  stopMeasure();
  toast("Medición guardada");
  loadItems();
}

// ------------------------------------------------------------------ Puntos con foto
let wpDraft = null;
function openWp(ll, from) {
  stopMeasure();
  wpDraft = { tipo: null, foto: null, ll, from };
  $("wTypes").innerHTML = "";
  for (const [k, ic, label] of WP_TYPES) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = `${ic} ${label}`;
    b.onclick = () => { wpDraft.tipo = k; $("wTypes").querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === b)); };
    $("wTypes").appendChild(b);
  }
  $("wPreview").classList.add("hidden");
  $("wPhotoTxt").textContent = "📷 Sacar foto (opcional)";
  $("wPhoto").value = "";
  $("wNote").value = "";
  $("wName").value = "";
  wpLocText();
  $("wpDialog").showModal();
}
function wpLocText() {
  const ll = wpDraft.from === "gps" ? (gps ? [gps.lat, gps.lon] : null) : wpDraft.ll;
  wpDraft.ll = ll;
  $("wLoc").innerHTML = !ll ? "Esperando GPS… (o cerrá y mantené apretado el mapa en el lugar)"
    : wpDraft.from === "gps" ? `📍 Tu posición GPS (±${Math.round(gps.acc)} m)<br><small>${coordTxt(ll[0], ll[1])}</small>`
    : `📍 Lugar elegido en el mapa<br><small>${coordTxt(ll[0], ll[1])}</small>`;
}
$("wPhoto").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  $("wPhotoTxt").textContent = "Procesando…";
  try {
    wpDraft.foto = await photoBlob(f);
    $("wPreview").src = URL.createObjectURL(wpDraft.foto);
    $("wPreview").classList.remove("hidden");
    $("wPhotoTxt").textContent = "";
  } catch { $("wPhotoTxt").textContent = "No se pudo leer la foto."; }
});
async function photoBlob(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej()), "image/jpeg", 0.78));
}
$("wSave").addEventListener("click", async () => {
  if (wpDraft.from === "gps") wpLocText();
  if (!wpDraft.ll) { toast("Todavía no hay posición."); return; }
  const t = wpType(wpDraft.tipo || "otro");
  const id = newId();
  const it = {
    id, kind: "wp", name: $("wName").value.trim() || t[2], tipo: t[0], nota: $("wNote").value.trim(), created: Date.now(),
    lat: +wpDraft.ll[0].toFixed(7), lon: +wpDraft.ll[1].toFixed(7), acc: wpDraft.from === "gps" && gps ? Math.round(gps.acc) : null, foto: !!wpDraft.foto,
  };
  if (wpDraft.foto) await dbPutPhoto(id, wpDraft.foto);
  await dbPut(it);
  $("wpDialog").close();
  toast("Punto guardado");
  loadItems();
});

// ------------------------------------------------------------------ Lo guardado
async function loadItems() {
  try { items = (await dbAll()).sort((a, b) => b.created - a.created); } catch { items = []; }
  // Un recorrido que quedó a medias (se cerró la app) queda guardado como «sin terminar».
  drawItems();
}
function drawItems() {
  if (!itemsLayer) return;
  itemsLayer.clearLayers();
  for (const it of items) {
    let lyr;
    if (it.kind === "track") lyr = L.polyline(it.pts.map((p) => [p[0], p[1]]), { color: "#ff7a1a", weight: 3.5, opacity: 0.9 });
    else if (it.kind === "medida") lyr = it.mode === "area" ? L.polygon(it.pts, { color: "#00e5ff", weight: 2.5, fillOpacity: 0.12 }) : L.polyline(it.pts, { color: "#00e5ff", weight: 3, dashArray: "6 5" });
    else lyr = L.marker([it.lat, it.lon], { icon: L.divIcon({ className: "c-wp", html: wpType(it.tipo)[1], iconSize: [30, 30], iconAnchor: [15, 15] }) });
    lyr.bindPopup(() => popupFor(it), { maxWidth: 260, autoPanPaddingTopLeft: [20, 90], autoPanPaddingBottomRight: [20, 90] });
    lyr.on("popupopen", (e) => fillPopupPhoto(it, e.popup));
    lyr.addTo(itemsLayer);
    it._layer = lyr;
  }
}
function infoFor(it) {
  if (it.kind === "track") return `${fmtDist(it.dist)} · ${fmtTime(it.dur || 0)}${it.draft ? " · <i>sin terminar</i>" : ""}`;
  if (it.kind === "medida") return it.mode === "area" ? `${fmtArea(it.area)} · perímetro ${fmtDist(it.dist)}` : fmtDist(it.dist);
  return `${wpType(it.tipo)[2]}${it.acc ? ` · ±${it.acc} m` : ""}`;
}
function popupFor(it) {
  return `<b>${h(it.name)}</b><br><small>${infoFor(it)}<br>${fmtDate(it.created)}</small>` +
    (it.nota ? `<p class="c-pnote">${h(it.nota)}</p>` : "") +
    (it.kind === "wp" ? `<br><small>${coordTxt(it.lat, it.lon)}</small>` : "") +
    (it.foto ? `<div class="c-pphoto">${it._img ? `<img src="${it._img}" alt="Foto">` : "Cargando foto…"}</div>` : "");
}
async function fillPopupPhoto(it, popup) {
  if (!it.foto || it._img) return;
  const b = await dbPhoto(it.id).catch(() => null);
  it._img = b ? URL.createObjectURL(b) : "";
  if (!b) return;
  const img = new Image();
  img.onload = () => popup.update(); // vuelve a armar el globo con la foto ya cargada
  img.src = it._img;
}

// ------------------------------------------------------------------ Mis datos (lista, exportar, mapa sin señal)
const ICON = { track: "〰️", medida: "⬠" };
function openDatos() {
  renderDatos();
  $("datosDialog").showModal();
  storageInfo();
}
function renderDatos() {
  const list = $("dList");
  list.innerHTML = items.length ? "" : `<li class="muted small">Todavía no guardaste nada. Grabá un recorrido, marcá un punto o medí un área.</li>`;
  for (const it of items) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="d-ic">${it.kind === "wp" ? wpType(it.tipo)[1] : ICON[it.kind]}</span><span class="d-tx"><b>${h(it.name)}</b><small>${infoFor(it)} · ${fmtDate(it.created)}</small></span>`;
    const acts = document.createElement("span");
    acts.className = "d-acts";
    const mk = (txt, fn, title) => { const b = document.createElement("button"); b.type = "button"; b.textContent = txt; b.title = title; b.onclick = fn; acts.appendChild(b); };
    mk("👁", () => { $("datosDialog").close(); verItem(it); }, "Ver en el mapa");
    mk("📤", () => shareItems([it], it.name), "Compartir");
    mk("🗑", async () => { if (!confirm(`¿Borrar «${it.name}»? No se puede deshacer.`)) return; await dbDel(it.id); await loadItems(); renderDatos(); }, "Borrar");
    li.appendChild(acts);
    list.appendChild(li);
  }
  $("dExport").disabled = !items.length;
}
function verItem(it) {
  follow = false; updateFollowBtn();
  if (it.kind === "wp") cmap.setView([it.lat, it.lon], Math.max(cmap.getZoom(), 17));
  else cmap.fitBounds(it._layer.getBounds(), { padding: [30, 30], maxZoom: 18 });
  setTimeout(() => it._layer.openPopup(), 350);
}
$("dExport").addEventListener("click", () => shareItems(items, "Campo"));

// KML para Google Earth; con fotos va como KMZ (un zip con el KML y las fotos adentro).
function kmlDoc(list, name) {
  const pm = list.map((it) => {
    const desc = [infoFor(it).replace(/<[^>]+>/g, ""), fmtDate(it.created), it.nota || ""].filter(Boolean).join("\n");
    const img = it.foto ? `<![CDATA[<p>${h(desc).replace(/\n/g, "<br>")}</p><img src="fotos/${it.id}.jpg" width="400">]]>` : h(desc);
    const c = (pts) => pts.map((p) => `${p[1]},${p[0]},0`).join(" ");
    let geom;
    if (it.kind === "wp") geom = `<Point><coordinates>${it.lon},${it.lat},0</coordinates></Point>`;
    else if (it.kind === "medida" && it.mode === "area") geom = `<Polygon><outerBoundaryIs><LinearRing><coordinates>${c([...it.pts, it.pts[0]])}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
    else geom = `<LineString><tessellate>1</tessellate><coordinates>${c(it.pts)}</coordinates></LineString>`;
    const style = it.kind === "track" ? "#track" : it.kind === "medida" ? "#medida" : "#punto";
    return `<Placemark><name>${h(it.name)}</name><description>${img}</description><styleUrl>${style}</styleUrl>${geom}</Placemark>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${h(name)}</name>
<Style id="track"><LineStyle><color>ff1a7aff</color><width>4</width></LineStyle></Style>
<Style id="medida"><LineStyle><color>ffffe500</color><width>3</width></LineStyle><PolyStyle><color>40ffe500</color></PolyStyle></Style>
<Style id="punto"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/paddle/ylw-circle.png</href></Icon></IconStyle></Style>
${pm}
</Document></kml>`;
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipStore(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let off = 0, csize = 0;
  for (const f of files) {
    const nm = enc.encode(f.name), len = f.data.length, crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(12, 0x21, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, len, true); lh.setUint32(22, len, true); lh.setUint16(26, nm.length, true);
    parts.push(lh, nm, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(14, 0x21, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, len, true); ch.setUint32(24, len, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
    central.push(ch, nm);
    off += 30 + nm.length + len;
    csize += 46 + nm.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, end], { type: "application/vnd.google-earth.kmz" });
}
async function shareItems(list, name) {
  const safe = name.replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]+/g, "").trim().replace(/\s+/g, "_") || "campo";
  const kml = kmlDoc(list, name);
  let file;
  const withPhotos = list.filter((it) => it.foto);
  if (withPhotos.length) {
    const files = [{ name: "doc.kml", data: new TextEncoder().encode(kml) }];
    for (const it of withPhotos) {
      const b = await dbPhoto(it.id).catch(() => null);
      if (b) files.push({ name: `fotos/${it.id}.jpg`, data: new Uint8Array(await b.arrayBuffer()) });
    }
    file = new File([zipStore(files)], `${safe}.kmz`, { type: "application/vnd.google-earth.kmz" });
  } else {
    file = new File([kml], `${safe}.kml`, { type: "application/vnd.google-earth.kml+xml" });
  }
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e && e.name === "AbortError") return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ------------------------------------------------------------------ Mapa sin señal (Sentinel-2)
const tx = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const ty = (lat, z) => { const r = rad(lat); return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
function tilesFor(b, z0, z1, set) {
  for (let z = z0; z <= z1; z++) {
    for (let x = tx(b.w, z); x <= tx(b.e, z); x++) for (let y = ty(b.n, z); y <= ty(b.s, z); y++) set.add(`${z}/${y}/${x}`);
  }
}
function offlinePlan() {
  const set = new Set();
  tilesFor({ s: PROV.bbox.s, n: PROV.bbox.n, w: PROV.bbox.w, e: PROV.bbox.e }, 6, 11, set);
  const pad = 0.015; // ~1,5 km alrededor de cada predio
  for (const pr of predios) {
    const pts = pr.p.flatMap((r) => r[0]);
    const b = { s: Math.min(...pts.map((p) => p[0])) - pad, n: Math.max(...pts.map((p) => p[0])) + pad, w: Math.min(...pts.map((p) => p[1])) - pad, e: Math.max(...pts.map((p) => p[1])) + pad };
    tilesFor(b, 12, S2_MAX, set);
  }
  return [...set];
}
const tileUrl = (k) => { const [z, y, x] = k.split("/"); return S2.replace("{z}", z).replace("{y}", y).replace("{x}", x); };
let dl = null;
async function storageInfo() {
  let n = 0;
  try { const c = await caches.open(TILE_CACHE); n = (await c.keys()).length; } catch { /* nada */ }
  let used = "";
  try { const e = await navigator.storage.estimate(); used = ` · la app ocupa ${nf(e.usage / 1048576, 0)} MB`; } catch { /* nada */ }
  const plan = predios.length ? offlinePlan().length : 0;
  $("oInfo").textContent = dl ? "" : predios.length
    ? `${n ? `Guardadas ${n.toLocaleString("es-AR")} de ${plan.toLocaleString("es-AR")} imágenes` : `Son ${plan.toLocaleString("es-AR")} imágenes, unos ${nf(plan * 0.022, 0)} MB`}${used}.`
    : "Esperando que carguen los predios…";
  $("oBtn").textContent = n && n >= plan ? "✅ Mapa guardado (volver a revisar)" : n ? "⬇️ Completar descarga" : "⬇️ Guardar mapa de los predios";
}
$("oBtn").addEventListener("click", async () => {
  if (dl) { dl.cancel = true; return; }
  if (!predios.length) return;
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* nada */ }
  const keys = offlinePlan();
  dl = { cancel: false, done: 0, fail: 0, bytes: 0 };
  $("oBtn").textContent = "✋ Pausar descarga";
  const cache = await caches.open(TILE_CACHE);
  let i = 0;
  const show = () => { $("oInfo").textContent = `Bajando ${dl.done.toLocaleString("es-AR")} de ${keys.length.toLocaleString("es-AR")} (${nf(dl.bytes / 1048576, 0)} MB)${dl.fail ? ` · ${dl.fail} con error` : ""}…`; $("oBar").style.width = `${(dl.done / keys.length) * 100}%`; };
  async function worker() {
    while (!dl.cancel && i < keys.length) {
      const url = tileUrl(keys[i++]);
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url, { mode: "cors" });
          if (!res.ok) throw new Error(res.status);
          const b = await res.clone().blob();
          dl.bytes += b.size;
          await cache.put(url, res);
        }
      } catch { dl.fail++; }
      dl.done++;
      if (dl.done % 20 === 0) show();
    }
  }
  $("oProg").classList.remove("hidden");
  show();
  await Promise.all(Array.from({ length: 6 }, worker));
  const cancelled = dl.cancel, fail = dl.fail;
  dl = null;
  $("oProg").classList.add("hidden");
  await storageInfo();
  toast(cancelled ? "Descarga en pausa. Podés completarla después." : fail ? `Listo, faltaron ${fail} imágenes: tocá de nuevo para completarlas.` : "Mapa guardado: ya lo podés usar sin señal.");
});

// ------------------------------------------------------------------ Nombre al guardar
function askName(title, def) {
  return new Promise((res) => {
    $("nTitle").textContent = title;
    $("nInput").value = def;
    const d = $("nameDialog");
    const done = (v) => { d.onclose = null; d.close(); res(v); };
    $("nOk").onclick = () => done($("nInput").value.trim() || def);
    $("nCancel").onclick = () => done(null);
    d.onclose = () => res(null);
    d.showModal();
    setTimeout(() => $("nInput").select(), 50);
  });
}

})();
