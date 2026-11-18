/* Clima personal — sin publicidad ni rastreadores.
   Datos: Open-Meteo (pronóstico y ciudades), NASA GIBS (satélite GOES-Este),
   RainViewer (radar), SMN (alertas, vía alerts.json que arma una tarea de GitHub). */
"use strict";

const DEFAULT_PLACE = { name: "Corrientes", admin: "Corrientes", country: "Argentina", lat: -27.4692, lon: -58.8306 };
// La app es solo para la provincia de Corrientes.
const PROV = { name: "Corrientes", bbox: { s: -30.8, n: -27.15, w: -59.75, e: -55.6 }, center: [-28.75, -57.9] };
const inProvince = (lat, lon) => lat >= PROV.bbox.s && lat <= PROV.bbox.n && lon >= PROV.bbox.w && lon <= PROV.bbox.e;
const TOWNS = [
  ["Corrientes", -27.4692, -58.8306], ["Goya", -29.1400, -59.2626], ["Paso de los Libres", -29.7128, -57.0877],
  ["Santo Tomé", -28.5494, -56.0411], ["Curuzú Cuatiá", -29.7917, -58.0546], ["Mercedes", -29.1818, -58.0794],
  ["Esquina", -30.0144, -59.5272], ["Bella Vista", -28.5096, -59.0434], ["Ituzaingó", -27.5872, -56.6888],
  ["Gobernador Virasoro", -28.0500, -56.0333], ["Monte Caseros", -30.2530, -57.6363], ["Saladas", -28.2539, -58.6250],
  ["Santa Lucía", -28.9871, -59.1030], ["Empedrado", -27.9516, -58.8059], ["Sauce", -30.0864, -58.7881],
];
const LS_PLACE = "clima.place";
const LS_FORECAST = "clima.forecast";
const STALE_MS = 15 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin espacio o bloqueado */ } },
};

let place = store.get(LS_PLACE);
let lastLoad = 0;
let alertsData = null;

// ---------------------------------------------------------------- Códigos WMO
const WMO = {
  0: ["Despejado", "☀️", "🌙"], 1: ["Mayormente despejado", "🌤️", "🌙"], 2: ["Parcialmente nublado", "⛅", "☁️"], 3: ["Nublado", "☁️", "☁️"],
  45: ["Niebla", "🌫️"], 48: ["Niebla con escarcha", "🌫️"],
  51: ["Llovizna débil", "🌦️"], 53: ["Llovizna", "🌦️"], 55: ["Llovizna intensa", "🌧️"], 56: ["Llovizna helada", "🌧️"], 57: ["Llovizna helada intensa", "🌧️"],
  61: ["Lluvia débil", "🌦️"], 63: ["Lluvia", "🌧️"], 65: ["Lluvia intensa", "🌧️"], 66: ["Lluvia helada", "🌧️"], 67: ["Lluvia helada intensa", "🌧️"],
  71: ["Nevada débil", "🌨️"], 73: ["Nevada", "🌨️"], 75: ["Nevada intensa", "❄️"], 77: ["Granos de nieve", "🌨️"],
  80: ["Chaparrones débiles", "🌦️"], 81: ["Chaparrones", "🌧️"], 82: ["Chaparrones fuertes", "⛈️"],
  85: ["Chaparrones de nieve", "🌨️"], 86: ["Chaparrones de nieve fuertes", "❄️"],
  95: ["Tormenta", "⛈️"], 96: ["Tormenta con granizo", "⛈️"], 99: ["Tormenta fuerte con granizo", "⛈️"],
};
const wmoText = (c) => (WMO[c] || ["—"])[0];
const wmoIcon = (c, isDay = 1) => { const w = WMO[c]; if (!w) return "·"; return !isDay && w[2] ? w[2] : w[1]; };

const fmtTemp = (t) => (t == null ? "--" : `${Math.round(t)}°`);
const hhmm = (iso) => iso ? iso.slice(11, 16) : "--";
const dayName = (iso, i) => i === 0 ? "Hoy" : i === 1 ? "Mañana" : new Date(iso + "T12:00").toLocaleDateString("es-AR", { weekday: "short", day: "numeric" });
const compass = (deg) => ["N", "NE", "E", "SE", "S", "SO", "O", "NO"][Math.round(((deg % 360) / 45)) % 8];

// ---------------------------------------------------------------- Pestañas
document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  if (name === "mapa") initMap();
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- Lugar
function placeLabel(p) { return p.name; }

function setPlace(p) {
  place = p;
  store.set(LS_PLACE, p);
  $("placeName").textContent = placeLabel(p);
  loadAll(true);
  if (map) { map.setView([p.lat, p.lon], 8); placeMarker(); }
}

function locate() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = +pos.coords.latitude.toFixed(4), lon = +pos.coords.longitude.toFixed(4);
        // Fuera de la provincia no sirve: se vuelve a la capital.
        if (!inProvince(lat, lon)) return resolve(null);
        // Nombre de la localidad de la lista más cercana (Open-Meteo no da el nombre a partir de coordenadas).
        const near = TOWNS.map(([t, la, lo]) => [t, (la - lat) ** 2 + ((lo - lon) * Math.cos(lat * Math.PI / 180)) ** 2]).sort((a, b) => a[1] - b[1])[0];
        const km = Math.sqrt(near[1]) * 111;
        resolve({ name: km < 8 ? near[0] : `Cerca de ${near[0]}`, admin: "Corrientes", country: "Argentina", lat, lon, gps: true });
      },
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 30 * 60 * 1000 },
    );
  });
}

$("placeBtn").addEventListener("click", () => { $("placeDialog").showModal(); });
for (const [name, lat, lon] of TOWNS) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "chip"; b.textContent = name;
  b.addEventListener("click", () => { $("placeDialog").close(); setPlace({ name, admin: "Corrientes", country: "Argentina", lat, lon }); });
  $("towns").appendChild(b);
}
$("useGps").addEventListener("click", async () => {
  const p = await locate();
  if (p) { $("placeDialog").close(); setPlace(p); } else alert("No se pudo obtener tu ubicación dentro de Corrientes. Revisá el permiso de ubicación o elegí una localidad de la lista.");
});

let searchTimer;
$("searchInput").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { $("results").innerHTML = ""; return; }
  searchTimer = setTimeout(() => searchCity(q), 300);
});

async function searchCity(q) {
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=40&language=es&format=json&countryCode=AR`);
    const j = await r.json();
    const list = (j.results || []).filter((c) => /corrientes/i.test(c.admin1 || "") || inProvince(c.latitude, c.longitude)).slice(0, 10);
    $("results").innerHTML = list.length ? "" : `<li class="muted empty">No encontré esa localidad en Corrientes</li>`;
    for (const c of list) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `${esc(c.name)}<small>${esc([c.admin2, "Corrientes"].filter(Boolean).join(", "))}</small>`;
      b.addEventListener("click", () => {
        $("placeDialog").close();
        setPlace({ name: c.name, admin: "Corrientes", country: "Argentina", lat: c.latitude, lon: c.longitude });
      });
      li.appendChild(b);
      $("results").appendChild(li);
    }
  } catch {
    $("results").innerHTML = `<li class="muted empty">Sin conexión</li>`;
  }
}

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---------------------------------------------------------------- Pronóstico
async function loadForecast() {
  const url = "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
    latitude: place.lat, longitude: place.lon, timezone: "auto", forecast_days: "7", wind_speed_unit: "kmh",
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day",
    hourly: "temperature_2m,precipitation_probability,precipitation,weather_code,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_gusts_10m_max,sunrise,sunset",
  });
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    store.set(LS_FORECAST, { key: `${place.lat},${place.lon}`, at: Date.now(), data });
    renderForecast(data, Date.now());
  } catch {
    const cached = store.get(LS_FORECAST);
    if (cached && cached.key === `${place.lat},${place.lon}`) renderForecast(cached.data, cached.at, true);
    else $("nowDesc").textContent = "Sin conexión. Probá de nuevo en un rato.";
  }
}

function renderForecast(d, at, offline = false) {
  const c = d.current, dl = d.daily, h = d.hourly;
  $("nowIcon").textContent = wmoIcon(c.weather_code, c.is_day);
  $("nowTemp").textContent = fmtTemp(c.temperature_2m);
  $("nowDesc").textContent = wmoText(c.weather_code);
  $("nowFeels").textContent = fmtTemp(c.apparent_temperature);
  $("nowHum").textContent = `${c.relative_humidity_2m}%`;
  $("nowWind").textContent = `${Math.round(c.wind_speed_10m)} km/h ${compass(c.wind_direction_10m)}`;
  $("nowGust").textContent = `${Math.round(c.wind_gusts_10m)} km/h`;
  $("nowRain").textContent = `${dl.precipitation_probability_max[0] ?? 0}% · ${(dl.precipitation_sum[0] ?? 0).toFixed(1)} mm`;
  $("nowSun").textContent = `${hhmm(dl.sunrise[0])} – ${hhmm(dl.sunset[0])}`;
  $("updated").textContent = `${offline ? "Sin conexión: datos guardados de las " : "Actualizado "}${new Date(at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`;

  // 24 horas desde la hora actual del lugar
  const nowKey = c.time.slice(0, 13);
  let start = h.time.findIndex((t) => t.slice(0, 13) >= nowKey);
  if (start < 0) start = 0;
  const hb = $("hourly");
  hb.innerHTML = "";
  for (let i = start; i < Math.min(start + 24, h.time.length); i++) {
    const p = h.precipitation_probability[i];
    const el = document.createElement("div");
    el.className = "hour" + (i === start ? " now-h" : "");
    el.setAttribute("role", "listitem");
    el.innerHTML = `<div class="h">${i === start ? "Ahora" : hhmm(h.time[i])}</div>
      <div class="i" title="${esc(wmoText(h.weather_code[i]))}">${wmoIcon(h.weather_code[i], h.is_day[i])}</div>
      <div class="t">${fmtTemp(h.temperature_2m[i])}</div>
      <div class="p">${p ? `💧${p}%` : ""}</div>`;
    hb.appendChild(el);
  }

  // 7 días con barra de mínima a máxima
  const lo = Math.min(...dl.temperature_2m_min), hi = Math.max(...dl.temperature_2m_max), span = Math.max(1, hi - lo);
  const db = $("daily");
  db.innerHTML = "";
  dl.time.forEach((t, i) => {
    const mn = dl.temperature_2m_min[i], mx = dl.temperature_2m_max[i], p = dl.precipitation_probability_max[i];
    const el = document.createElement("div");
    el.className = "day";
    el.setAttribute("role", "listitem");
    el.title = `${wmoText(dl.weather_code[i])} · lluvia ${p ?? 0}% (${(dl.precipitation_sum[i] ?? 0).toFixed(1)} mm) · ráfagas ${Math.round(dl.wind_gusts_10m_max[i])} km/h`;
    el.innerHTML = `<div class="n">${dayName(t, i)}</div>
      <div class="i">${wmoIcon(dl.weather_code[i])}</div>
      <div class="p">${p ? `💧${p}%` : ""}</div>
      <div class="bar"><i style="left:${((mn - lo) / span) * 100}%;right:${100 - ((mx - lo) / span) * 100}%"></i></div>
      <div class="mn">${fmtTemp(mn)}</div>
      <div class="mx">${fmtTemp(mx)}</div>`;
    db.appendChild(el);
  });
}

// ---------------------------------------------------------------- Alertas SMN
const LEVEL_ORDER = { rojo: 3, naranja: 2, amarillo: 1 };

function pointInPolygon(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const alertHere = (a) => (a.areas || []).some((ar) => (ar.polygons || []).some((pg) => pointInPolygon(place.lat, place.lon, pg)));

/** Deja solo las alertas con zonas de Corrientes (el SMN las nombra «CORRIENTES: GOYA - ...»). */
function onlyCorrientes(list) {
  return list.map((a) => ({ ...a, areas: (a.areas || []).filter((ar) => /^\s*CORRIENTES\b/i.test(ar.desc || "") || (ar.polygons || []).some((pg) => pg.some(([la, lo]) => inProvince(la, lo)) && /CORRIENTES/i.test(ar.desc || ""))) }))
    .filter((a) => a.areas.length);
}

// ---------------------------------------------------------------- Predios
let predios = [];          // [{n, ha, p: [[[lat,lon],...] (anillos)] por polígono]}
async function loadPredios() {
  try { predios = await (await fetch("predios.json")).json(); } catch { predios = []; }
  drawPredios();
}
/** Predios con algún vértice dentro de los polígonos de un aviso. */
function prediosEnAlerta(a) {
  const polys = (a.areas || []).flatMap((ar) => ar.polygons || []);
  if (!polys.length || !predios.length) return [];
  const hit = predios.filter((pr) => pr.p.some((rings) => rings[0].some(([la, lo], i) => i % 3 === 0 && polys.some((pg) => pointInPolygon(la, lo, pg)))));
  // Un mismo predio puede venir en varias partes: se cuenta una vez por nombre.
  return hit.filter((pr, i) => hit.findIndex((x) => x.n === pr.n) === i);
}
const nombres = (list, max = 6) => list.slice(0, max).map((p) => p.n).join(", ") + (list.length > max ? ` y ${list.length - max} más` : "");

async function loadAlerts() {
  try {
    const r = await fetch(`alerts.json?t=${Math.floor(Date.now() / 60000)}`, { cache: "no-store" });
    alertsData = await r.json();
  } catch { /* sin conexión: queda lo último */ }
  renderAlerts();
}

function alertCard(a) {
  const exp = a.expires ? new Date(a.expires).toLocaleString("es-AR", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const areas = (a.areas || []).map((x) => x.desc.replace(/^\s*CORRIENTES:\s*/i, "")).join(" · ");
  return `<div class="card alert lv-${a.level}">
    <span class="lvl lv-${a.level}">${esc(a.level)}</span>
    <h3>${esc(a.title)}</h3>
    ${exp ? `<p class="muted small">Vigente hasta ${esc(exp)}</p>` : ""}
    <p class="small">${esc(areas)}</p>
    ${a._predios && a._predios.length ? `<p class="small predios-hit">🌲 <b>${a._predios.length} predio(s) dentro del aviso:</b> ${esc(nombres(a._predios))}</p>` : ""}
    ${a.instruction ? `<details class="small"><summary><b>Qué hacer</b></summary><p>${esc(a.instruction)}</p></details>` : ""}
    ${a.web ? `<p class="small"><a href="${esc(a.web)}" target="_blank" rel="noopener">Ver aviso oficial del SMN ↗</a></p>` : ""}
  </div>`;
}

function renderAlerts() {
  const now = Date.now();
  const list = onlyCorrientes((alertsData && alertsData.alerts) || []).filter((a) => !a.expires || new Date(a.expires).getTime() > now)
    .sort((a, b) => (LEVEL_ORDER[b.level] || 0) - (LEVEL_ORDER[a.level] || 0));
  for (const a of list) a._predios = prediosEnAlerta(a);
  const here = list.filter(alertHere), other = list.filter((a) => !alertHere(a));
  const conPredios = list.filter((a) => a._predios.length);
  const nPred = new Set(conPredios.flatMap((a) => a._predios.map((p) => p.n))).size;
  $("prediosNote").textContent = nPred ? `🌲 ${nPred} predio(s) dentro de avisos del SMN (${conPredios.map((a) => a.level).filter((v, i, x) => x.indexOf(v) === i).join(", ")}). Tocá para ver.` : "";
  $("prediosNote").onclick = () => showTab("alertas");

  $("alertsHere").innerHTML = here.length ? here.map(alertCard).join("") : `<div class="card empty muted">No hay alertas del SMN para ${esc(placeLabel(place))}.</div>`;
  $("alertsOther").innerHTML = other.map(alertCard).join("") || `<p class="muted">Ninguna.</p>`;
  $("provAlertNote").textContent = !here.length && other.length ? `Hay ${other.length} aviso(s) del SMN en otras zonas de Corrientes.` : "";
  $("provAlertNote").onclick = () => showTab("alertas");
  $("alertsOtherCount").textContent = `(${other.length})`;
  $("alertsUpdated").textContent = alertsData && alertsData.generated
    ? `Datos del SMN consultados ${new Date(alertsData.generated).toLocaleString("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. Se revisan cada 15 minutos.`
    : "Todavía no hay datos de alertas.";

  const banner = $("alertBanner");
  if (here.length) {
    const top = here[0];
    banner.className = `alert-banner lv-${top.level}`;
    banner.innerHTML = `⚠️ ${esc(top.title)}${here.length > 1 ? ` (+${here.length - 1})` : ""} <u>Ver</u>`;
    banner.onclick = () => showTab("alertas");
    banner.setAttribute("role", "button");
  } else banner.className = "alert-banner hidden";
  $("alertDot").classList.toggle("hidden", !here.length);
  drawAlertPolygons(list);
}

// ---------------------------------------------------------------- Mapa
let prediosGroup, map, marker, layers = {}, radarFrames = [], radarHost = "", radarIdx = 0, radarTimer = null, alertGroup;
const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";

function initMap() {
  if (map) { setTimeout(() => map.invalidateSize(), 50); return; }
  if (!window.L) { $("map").innerHTML = `<p class="pad muted">No se pudo cargar el mapa (sin conexión).</p>`; return; }
  map = L.map("map", {
    zoomControl: true, attributionControl: true, minZoom: 6, maxZoom: 13,
    maxBounds: [[PROV.bbox.s - 3, PROV.bbox.w - 4], [PROV.bbox.n + 3, PROV.bbox.e + 4]], maxBoundsViscosity: 0.8,
  }).setView(PROV.center, 7);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 13, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  layers.geocolor = L.tileLayer(`${GIBS}/GOES-East_ABI_GeoColor/default/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`, {
    maxNativeZoom: 7, maxZoom: 13, opacity: 0.85, attribution: 'Satélite: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a> GOES-Este',
  });
  layers.ir = L.tileLayer(`${GIBS}/GOES-East_ABI_Band13_Clean_Infrared/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`, {
    maxNativeZoom: 6, maxZoom: 13, opacity: 0.7, attribution: 'Infrarrojo: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a> GOES-Este',
  });
  alertGroup = L.layerGroup();
  layers.alerts = alertGroup;
  prediosGroup = L.layerGroup();
  layers.predios = prediosGroup;
  prediosGroup.addTo(map);
  drawPredios();
  layers.geocolor.addTo(map);
  alertGroup.addTo(map);
  placeMarker();
  loadRadar();
  if (alertsData) renderAlerts();

  document.querySelectorAll(".layer-bar .chip").forEach((b) => b.addEventListener("click", () => toggleLayer(b)));
  $("playBtn").addEventListener("click", toggleRadarAnimation);
  $("satPlayBtn").addEventListener("click", toggleSatAnimation);
  $("prediosBtn").addEventListener("click", verPredios);
  map.on("zoomend", updatePredioLabels);
}

function placeMarker() {
  if (!map) return;
  if (marker) marker.remove();
  marker = L.circleMarker([place.lat, place.lon], { radius: 7, color: "#fff", weight: 2, fillColor: "#1f78b4", fillOpacity: 1 }).addTo(map).bindTooltip(placeLabel(place));
}

// ---------------------------------------------------------------- Animación del satélite (últimas 2 h)
const SAT = {
  ir: { id: "GOES-East_ABI_Band13_Clean_Infrared", tms: "GoogleMapsCompatible_Level6", z: 6, op: 0.7, label: "Infrarrojo" },
  geocolor: { id: "GOES-East_ABI_GeoColor", tms: "GoogleMapsCompatible_Level7", z: 7, op: 0.85, label: "Satélite" },
};
let satFrames = [], satTimer = null, satIdx = 0, satKey = null, gibsTimes = null;

async function latestSatTime(id) {
  if (!gibsTimes) { try { gibsTimes = await (await fetch(`gibs.json?t=${Math.floor(Date.now() / 600000)}`)).json(); } catch { gibsTimes = {}; } }
  const t = gibsTimes[id] ? new Date(gibsTimes[id]) : null;
  if (t && Date.now() - t.getTime() < 3 * 3600e3) return t;
  // Sin dato: unos 40 min atrás, redondeado a 10 min (la NASA publica con demora).
  const d = new Date(Date.now() - 40 * 60e3);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 10) * 10, 0, 0);
  return d;
}

async function toggleSatAnimation() {
  if (satTimer || satFrames.length) { stopSat(); return; }
  satKey = document.querySelector('.chip[data-layer="ir"]').classList.contains("on") ? "ir" : "geocolor";
  const s = SAT[satKey];
  if (!document.querySelector(`.chip[data-layer="${satKey}"]`).classList.contains("on")) {
    document.querySelector(`.chip[data-layer="${satKey}"]`).classList.add("on");
  }
  $("satPlayBtn").textContent = "⏳ Cargando…";
  const last = await latestSatTime(s.id);
  const times = Array.from({ length: 12 }, (_, i) => new Date(last.getTime() - (11 - i) * 10 * 60e3));
  satFrames = times.map((t) => ({
    t,
    layer: L.tileLayer(`${GIBS}/${s.id}/default/${t.toISOString().slice(0, 19)}Z/${s.tms}/{z}/{y}/{x}.png`, {
      maxNativeZoom: s.z, maxZoom: 13, opacity: 0, zIndex: 200, attribution: `${s.label}: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a> GOES-Este`,
    }).addTo(map),
  }));
  layers[satKey].remove();
  // Esperar a que se descarguen las imágenes antes de arrancar (máx. 8 s).
  await Promise.race([Promise.all(satFrames.map((f) => new Promise((r) => f.layer.once("load", r)))), new Promise((r) => setTimeout(r, 8000))]);
  if (!satFrames.length) return;
  $("satPlayBtn").textContent = "⏸ Pausar satélite";
  satIdx = 0;
  const step = () => {
    satFrames.forEach((f, i) => f.layer.setOpacity(i === satIdx ? s.op : 0));
    $("satTime").textContent = `${s.label}: ${satFrames[satIdx].t.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`;
    satIdx = (satIdx + 1) % satFrames.length;
  };
  step();
  satTimer = setInterval(step, 600);
}

function stopSat() {
  clearInterval(satTimer); satTimer = null;
  satFrames.forEach((f) => f.layer.remove());
  satFrames = [];
  $("satPlayBtn").textContent = "▶ Animar satélite";
  $("satTime").textContent = "";
  if (satKey && document.querySelector(`.chip[data-layer="${satKey}"]`).classList.contains("on")) layers[satKey].addTo(map);
}

function toggleLayer(btn) {
  const name = btn.dataset.layer;
  if ((name === "ir" || name === "geocolor") && (satTimer || satFrames.length)) stopSat();
  const on = !btn.classList.contains("on");
  btn.classList.toggle("on", on);
  if (name === "radar") { on ? showRadarFrame(radarIdx) : (layers.radar && layers.radar.remove(), stopRadar()); return; }
  // Satélite e infrarrojo se excluyen entre sí
  if (on && (name === "geocolor" || name === "ir")) {
    const other = name === "geocolor" ? "ir" : "geocolor";
    layers[other].remove();
    document.querySelector(`.chip[data-layer="${other}"]`).classList.remove("on");
  }
  on ? layers[name].addTo(map) : layers[name].remove();
}

async function loadRadar() {
  try {
    const r = await fetch("https://api.rainviewer.com/public/weather-maps.json", { cache: "no-store" });
    const j = await r.json();
    radarHost = j.host;
    radarFrames = (j.radar && j.radar.past) || [];
    radarIdx = radarFrames.length - 1;
    if (document.querySelector('.chip[data-layer="radar"]').classList.contains("on")) showRadarFrame(radarIdx);
  } catch { $("frameTime").textContent = "Radar no disponible"; }
}

function showRadarFrame(i) {
  if (!map || !radarFrames.length) return;
  const f = radarFrames[i];
  const next = L.tileLayer(`${radarHost}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
    maxNativeZoom: 7, maxZoom: 13, opacity: 0.75, zIndex: 400,
    attribution: 'Radar: <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>',
  });
  next.addTo(map);
  const prev = layers.radar;
  layers.radar = next;
  if (prev) setTimeout(() => prev.remove(), 250);
  $("frameTime").textContent = `Radar: ${new Date(f.time * 1000).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`;
}

function toggleRadarAnimation() {
  if (radarTimer) { stopRadar(); return; }
  if (!radarFrames.length) return;
  const chip = document.querySelector('.chip[data-layer="radar"]');
  if (!chip.classList.contains("on")) chip.classList.add("on");
  $("playBtn").textContent = "⏸ Pausar";
  radarIdx = 0;
  radarTimer = setInterval(() => {
    showRadarFrame(radarIdx);
    radarIdx = (radarIdx + 1) % radarFrames.length;
  }, 700);
}
function stopRadar() {
  clearInterval(radarTimer); radarTimer = null;
  $("playBtn").textContent = "▶ Animar radar";
  radarIdx = radarFrames.length - 1;
  if (layers.radar && document.querySelector('.chip[data-layer="radar"]').classList.contains("on")) showRadarFrame(radarIdx);
}

function drawPredios() {
  if (!prediosGroup || !predios.length) return;
  prediosGroup.clearLayers();
  // Doble trazo (borde oscuro + línea amarilla) para que se vea sobre el satélite, las nubes y el mapa.
  for (const pr of predios) {
    L.polygon(pr.p, { color: "#111", weight: 5, opacity: 0.55, fill: false, interactive: false }).addTo(prediosGroup);
    L.polygon(pr.p, { color: "#ffe14d", weight: 2.2, fillColor: "#ffe14d", fillOpacity: 0.08 })
      .bindPopup(`<b>${esc(pr.n)}</b>${pr.ha ? `<br><small>${pr.ha.toLocaleString("es-AR")} ha</small>` : ""}`)
      .bindTooltip(esc(pr.n), { permanent: true, direction: "center", className: "predio-label", opacity: 1 })
      .addTo(prediosGroup);
  }
  updatePredioLabels();
}
/** Nombres de los predios solo cuando hay zoom suficiente para leerlos. */
function updatePredioLabels() {
  if (!map || !prediosGroup) return;
  const show = map.getZoom() >= 11;
  document.getElementById("map").classList.toggle("show-predio-labels", show);
}
function verPredios() {
  if (!map || !predios.length) return;
  const b = L.latLngBounds(predios.flatMap((pr) => pr.p.flatMap((rings) => rings[0])));
  map.fitBounds(b, { padding: [20, 20] });
  const chip = document.querySelector('.chip[data-layer="predios"]');
  if (!chip.classList.contains("on")) { chip.classList.add("on"); prediosGroup.addTo(map); }
}

const LEVEL_COLOR = { amarillo: "#f4c20d", naranja: "#f08a00", rojo: "#d7263d" };
function drawAlertPolygons(list) {
  if (!alertGroup) return;
  alertGroup.clearLayers();
  for (const a of list) for (const ar of a.areas || []) for (const pg of ar.polygons || []) {
    L.polygon(pg, { color: LEVEL_COLOR[a.level] || "#888", weight: 2, fillOpacity: 0.25 })
      .bindPopup(`<b>${esc(a.title)}</b><br><small>${esc(ar.desc)}</small>`).addTo(alertGroup);
  }
}

// ---------------------------------------------------------------- Carga general
async function loadAll(force = false) {
  if (!force && Date.now() - lastLoad < STALE_MS) return;
  lastLoad = Date.now();
  $("refreshBtn").classList.add("spin");
  const pre = predios.length ? null : loadPredios();
  await Promise.all([loadForecast(), pre ? pre.then(loadAlerts) : loadAlerts(), map ? loadRadar() : null]);
  $("refreshBtn").classList.remove("spin");
}

$("refreshBtn").addEventListener("click", () => loadAll(true));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") loadAll(); });

(async function start() {
  if (!place) {
    $("placeName").textContent = "Buscando ubicación…";
    place = (await locate()) || DEFAULT_PLACE;
    store.set(LS_PLACE, place);
  }
  $("placeName").textContent = placeLabel(place);
  loadAll(true);
})();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
