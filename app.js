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
  if (window.onTab) window.onTab(name);
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
    latitude: place.lat, longitude: place.lon, timezone: "auto", forecast_days: "7", past_days: "10", wind_speed_unit: "kmh",
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day",
    hourly: "temperature_2m,precipitation_probability,precipitation,weather_code,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_gusts_10m_max,sunrise,sunset,et0_fao_evapotranspiration,relative_humidity_2m_min",
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
  const c = d.current, h = d.hourly, all = d.daily;
  // Con past_days la serie diaria trae los últimos 10 días: se separa desde hoy para mostrar.
  let today = all.time.indexOf(c.time.slice(0, 10));
  if (today < 0) today = 0;
  const dl = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, Array.isArray(v) ? v.slice(today, today + 7) : v]));
  renderMonte(all, today);
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

  fc = { d, h, dl, start: hourIndex(h, c.time) };
  selDay = null;
  drawWeek();
  drawHours();
}

// ---------------------------------------------------------------- Gráficos: semana (tocás un día) y hora por hora
let fc = null, selDay = null;
const SVGNS = "http://www.w3.org/2000/svg";
function sv(parent, tag, attrs, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  parent.appendChild(e);
  return e;
}
const linePath = (pts) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
function hourIndex(h, iso) {
  const k = iso.slice(0, 13);
  const i = h.time.findIndex((t) => t.slice(0, 13) >= k);
  return i < 0 ? 0 : i;
}
const chartDay = (iso, i) => i === 0 ? ["Hoy", ""] : (() => {
  const dt = new Date(iso + "T12:00");
  const w = dt.toLocaleDateString("es-AR", { weekday: "short" }).replace(".", "");
  return [w.charAt(0).toUpperCase() + w.slice(1, 3), String(dt.getDate())];
})();
const mmTxt = (v) => v >= 10 ? Math.round(v) : v.toFixed(1);

function drawWeek() {
  const box = $("weekChart");
  box.innerHTML = "";
  if (!fc) return;
  const { dl } = fc, n = dl.time.length, W = 340, H = 254, cw = W / n;
  const s = sv(box, "svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Pronóstico de 7 días" });
  const mx = dl.temperature_2m_max, mn = dl.temperature_2m_min, mm = dl.precipitation_sum.map((v) => v || 0), pp = dl.precipitation_probability_max.map((v) => v || 0);
  const hi = Math.max(...mx), lo = Math.min(...mn), span = Math.max(4, hi - lo);
  const ty = (t) => 50 + ((hi - t) / span) * 62;              // 50..112
  const mmMax = Math.max(15, ...mm), ry = (v) => 200 - (v / mmMax) * 50; // barras 150..200
  const py = (v) => 200 - v * 0.5;
  const cx = (i) => cw * i + cw / 2;
  if (selDay != null) sv(s, "rect", { class: "d-sel", x: cw * selDay + 1, y: 0, width: cw - 2, height: H, rx: 8 });
  for (let i = 1; i < n; i++) sv(s, "line", { class: "g-line", x1: cw * i, x2: cw * i, y1: 8, y2: 204 });
  sv(s, "line", { class: "g-line", x1: 0, x2: W, y1: 200.5, y2: 200.5 });
  dl.time.forEach((t, i) => {
    sv(s, "text", { x: cx(i), y: 22, "text-anchor": "middle", "font-size": 17 }, wmoIcon(dl.weather_code[i]));
    if (mm[i] > 0.05) {
      sv(s, "rect", { class: "b-mm", x: cx(i) - 11, y: ry(mm[i]), width: 22, height: Math.max(2, 200 - ry(mm[i])), rx: 3 });
      sv(s, "text", { class: "t-mm", x: cx(i), y: ry(mm[i]) - 4, "text-anchor": "middle", "font-size": 11 }, mmTxt(mm[i]));
    }
    const [a, b] = chartDay(t, i);
    sv(s, "text", { class: "t-lbl", x: cx(i), y: 232, "text-anchor": "middle", "font-size": 12 }, a);
    if (b) sv(s, "text", { class: "t-mut", x: cx(i), y: 246, "text-anchor": "middle", "font-size": 11 }, b);
    sv(s, "text", { class: "t-pp", x: cx(i), y: 214, "text-anchor": "middle", "font-size": 10, "font-weight": 700 }, pp[i] ? `${pp[i]}%` : "");
    sv(s, "text", { class: "t-max", x: cx(i), y: ty(mx[i]) - 7, "text-anchor": "middle", "font-size": 11, "font-weight": 700 }, fmtTemp(mx[i]));
    sv(s, "text", { class: "t-min", x: cx(i), y: ty(mn[i]) + 15, "text-anchor": "middle", "font-size": 11, "font-weight": 700 }, fmtTemp(mn[i]));
  });
  sv(s, "path", { class: "c-pp", d: linePath(pp.map((v, i) => [cx(i), py(v)])) });
  sv(s, "path", { class: "c-max", d: linePath(mx.map((v, i) => [cx(i), ty(v)])) });
  sv(s, "path", { class: "c-min", d: linePath(mn.map((v, i) => [cx(i), ty(v)])) });
  dl.time.forEach((t, i) => {
    const r = sv(s, "rect", { class: "d-hit", x: cw * i, y: 0, width: cw, height: H });
    sv(r, "title", {}, `${dayName(t, i)}: ${wmoText(dl.weather_code[i])}, ${fmtTemp(mn[i])} a ${fmtTemp(mx[i])}, lluvia ${pp[i]}% (${mm[i].toFixed(1)} mm), ráfagas ${Math.round(dl.wind_gusts_10m_max[i])} km/h`);
    r.addEventListener("click", () => { selDay = selDay === i ? null : i; drawWeek(); drawHours(); });
  });
}

function drawHours() {
  const box = $("hourChart");
  box.innerHTML = "";
  if (!fc) return;
  const { h, dl } = fc;
  let from = fc.start, count = 48;
  if (selDay != null) {
    from = Math.max(0, h.time.findIndex((t) => t.startsWith(dl.time[selDay])));
    count = 24;
    $("hourTitle").textContent = `${dayName(dl.time[selDay], selDay)} hora por hora`;
  } else $("hourTitle").textContent = "Próximas 48 horas";
  const idx = [];
  for (let i = from; i < Math.min(from + count, h.time.length); i++) idx.push(i);
  if (!idx.length) return;
  const dx = 24, W = idx.length * dx + 8, H = 230, x = (k) => 4 + k * dx + dx / 2;
  const T = idx.map((i) => h.temperature_2m[i]), R = idx.map((i) => h.precipitation[i] || 0), P = idx.map((i) => h.precipitation_probability[i] || 0);
  const hi = Math.max(...T), lo = Math.min(...T), span = Math.max(4, hi - lo);
  const ty = (t) => 46 + ((hi - t) / span) * 80;                     // 46..126
  const rMax = Math.max(4, ...R), ry = (v) => 200 - (v / rMax) * 52;  // 148..200
  const s = sv(box, "svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Pronóstico hora por hora" });
  const sel = sv(s, "rect", { class: "h-sel", x: -100, y: 0, width: dx, height: H });
  P.forEach((p, k) => p && sv(s, "rect", { class: "b-ppa", x: 4 + k * dx, y: 200 - p * 0.95, width: dx, height: p * 0.95 }));
  sv(s, "line", { class: "g-line", x1: 0, x2: W, y1: 200.5, y2: 200.5 });
  idx.forEach((i, k) => {
    const hr = Number(h.time[i].slice(11, 13));
    if (hr === 0 && k > 0) {
      sv(s, "line", { class: "g-line", x1: 4 + k * dx, x2: 4 + k * dx, y1: 4, y2: 204 });
      const d = dl.time.indexOf(h.time[i].slice(0, 10));
      sv(s, "text", { class: "t-lbl", x: 8 + k * dx, y: 14, "font-size": 11 }, d >= 0 ? dayName(dl.time[d], d) : "");
    }
    if (R[k] > 0.05) {
      sv(s, "rect", { class: "b-mm", x: 4 + k * dx + 3, y: ry(R[k]), width: dx - 6, height: Math.max(2, 200 - ry(R[k])), rx: 2 });
      if (R[k] >= 1) sv(s, "text", { class: "t-mm", x: x(k), y: ry(R[k]) - 3, "text-anchor": "middle", "font-size": 10 }, mmTxt(R[k]));
    }
    if (k % 3 === 0) {
      sv(s, "text", { x: x(k), y: 32, "text-anchor": "middle", "font-size": 15 }, wmoIcon(h.weather_code[i], h.is_day[i]));
      sv(s, "text", { class: "t-max", x: x(k), y: ty(T[k]) - 7, "text-anchor": "middle", "font-size": 11, "font-weight": 700 }, fmtTemp(T[k]));
      sv(s, "text", { class: "t-mut", x: x(k), y: 216, "text-anchor": "middle", "font-size": 11 }, i === fc.start ? "Ahora" : `${String(hr).padStart(2, "0")}h`);
    }
  });
  sv(s, "path", { class: "c-temp", d: linePath(T.map((t, k) => [x(k), ty(t)])) });
  if (selDay == null || idx.includes(fc.start)) {
    const k = idx.indexOf(fc.start);
    if (k >= 0) sv(s, "line", { class: "g-now", x1: x(k), x2: x(k), y1: 38, y2: 204 });
  }
  const info = (k) => {
    const i = idx[k];
    sel.setAttribute("x", 4 + k * dx);
    $("hourInfo").innerHTML = `<b>${dayName(h.time[i].slice(0, 10), dl.time.indexOf(h.time[i].slice(0, 10)))} ${hhmm(h.time[i])}</b> · ${wmoIcon(h.weather_code[i], h.is_day[i])} ${esc(wmoText(h.weather_code[i]))} · ${fmtTemp(T[k])} · 💧 ${P[k]}% · ${R[k].toFixed(1)} mm`;
  };
  idx.forEach((i, k) => sv(s, "rect", { class: "d-hit", x: 4 + k * dx, y: 0, width: dx, height: H }).addEventListener("click", () => info(k)));
  // Arranca mostrando la hora actual (o el mediodía del día elegido).
  const first = selDay == null ? 0 : Math.min(idx.length - 1, 12);
  info(selDay == null ? 0 : first);
  $("hourScroll").scrollLeft = selDay == null ? 0 : Math.max(0, x(6) - 20);
}

// ---------------------------------------------------------------- Monte: caminos y riesgo de incendio (estimados)
const LEVELS = {
  verde: { cls: "lv-verde", dot: "🟢" }, amarillo: { cls: "lv-amarillo", dot: "🟡" },
  naranja: { cls: "lv-naranja", dot: "🟠" }, rojo: { cls: "lv-rojo", dot: "🔴" },
};
const shortDay = (iso, i) => i === 0 ? "Hoy" : new Date(iso + "T12:00").toLocaleDateString("es-AR", { weekday: "short" }).replace(".", "");

/** Caminos de tierra: «balde» de agua que se llena con la lluvia y se vacía con el sol y el viento (evapotranspiración). */
function roadStatus(all) {
  const rain = all.precipitation_sum, et0 = all.et0_fao_evapotranspiration;
  const out = [];
  let w = 0;
  for (let i = 0; i < all.time.length; i++) {
    w = Math.max(0, w * 0.75 - (et0[i] ?? 4) * 0.5) + (rain[i] ?? 0);
    out.push(w >= 20 ? { lv: "rojo", txt: "Barro: mejor no entrar" } : w >= 7 ? { lv: "amarillo", txt: "Húmedos: con precaución" } : { lv: "verde", txt: "Transitables" });
  }
  return out;
}

/** Riesgo de incendio: suma puntos por calor, aire seco, ráfagas y días sin lluvia. Estimación, no es el índice oficial. */
function fireRisk(all) {
  const out = [];
  let dry = 0;
  for (let i = 0; i < all.time.length; i++) {
    const r = all.precipitation_sum[i] ?? 0;
    dry = r >= 2 ? 0 : dry + 1;
    const t = all.temperature_2m_max[i] ?? 25, rh = all.relative_humidity_2m_min[i] ?? 50, g = all.wind_gusts_10m_max[i] ?? 20;
    let s = (t >= 35 ? 3 : t >= 30 ? 2 : t >= 25 ? 1 : 0) + (rh <= 20 ? 3 : rh <= 30 ? 2 : rh <= 40 ? 1 : 0)
      + (g >= 50 ? 3 : g >= 35 ? 2 : g >= 25 ? 1 : 0) + (dry >= 10 ? 3 : dry >= 5 ? 2 : dry >= 2 ? 1 : 0);
    if (r >= 5) s = Math.max(0, s - 4);
    out.push(s >= 10 ? { lv: "rojo", txt: "Extremo" } : s >= 7 ? { lv: "naranja", txt: "Alto" } : s >= 4 ? { lv: "amarillo", txt: "Moderado" } : { lv: "verde", txt: "Bajo" });
  }
  return out;
}

function renderMonte(all, today) {
  if (!all.et0_fao_evapotranspiration) return;
  const road = roadStatus(all), fire = fireRisk(all);
  const days = all.time.slice(today, today + 7);
  const dots = (arr) => days.map((t, i) => `<span class="mday" title="${esc(arr[today + i].txt)}"><i>${LEVELS[arr[today + i].lv].dot}</i>${chartDay(t, i)}</span>`).join("");
  const rain3 = all.precipitation_sum.slice(Math.max(0, today - 3), today).reduce((a, b) => a + (b || 0), 0);
  const dry = (() => { let n = 0; for (let i = today - 1; i >= 0 && (all.precipitation_sum[i] ?? 0) < 2; i--) n++; return n; })();
  $("monte").innerHTML = `
    <div class="mrow"><div><b>Caminos de tierra</b> <span class="pill ${LEVELS[road[today].lv].cls}">${esc(road[today].txt)}</span>
      <p class="muted small">Llovió ${rain3.toFixed(0)} mm en los últimos 3 días.</p></div><div class="mdays">${dots(road)}</div></div>
    <div class="mrow"><div><b>Riesgo de incendio</b> <span class="pill ${LEVELS[fire[today].lv].cls}">${esc(fire[today].txt)}</span>
      <p class="muted small">${dry ? `${dry} día(s) sin lluvia.` : "Llovió ayer."} Estimación con temperatura, humedad, ráfagas y días secos.</p></div><div class="mdays">${dots(fire)}</div></div>
    <div class="mrow" id="firesRow"></div>`;
  renderFiresSummary();
}

// ---------------------------------------------------------------- Focos de calor (NASA FIRMS)
let firesData = null, fireGroup;
const kmBetween = (a, b, c, d) => { const x = (d - b) * Math.cos(((a + c) / 2) * Math.PI / 180), y = c - a; return Math.sqrt(x * x + y * y) * 111.2; };

async function loadFires() {
  try { firesData = await (await fetch(`fires.json?t=${Math.floor(Date.now() / 600000)}`, { cache: "no-store" })).json(); } catch { /* sin conexión */ }
  renderFiresSummary();
  drawFires();
}

/** Para cada foco: predio más cercano y distancia (0 si cae adentro). */
function firesNearPredios(maxKm = 5) {
  const out = [];
  for (const f of (firesData && firesData.fires) || []) {
    let best = null;
    for (const pr of predios) {
      for (const rings of pr.p) {
        const ring = rings[0];
        let d = pointInPolygon(f.lat, f.lon, ring) ? 0 : Infinity;
        if (d) for (let i = 0; i < ring.length; i += 2) d = Math.min(d, kmBetween(f.lat, f.lon, ring[i][0], ring[i][1]));
        if (!best || d < best.km) best = { km: d, predio: pr.n };
      }
    }
    if (best && best.km <= maxKm) out.push({ ...f, ...best });
  }
  return out.sort((a, b) => a.km - b.km);
}

function fireTime(t) { return new Date(t).toLocaleString("es-AR", { weekday: "short", hour: "2-digit", minute: "2-digit" }); }

function renderFiresSummary() {
  const row = document.getElementById("firesRow");
  const list = (firesData && firesData.fires) || [];
  const inProv = list.filter((f) => inProvince(f.lat, f.lon));
  const near = predios.length ? firesNearPredios() : [];
  if (row) {
    row.innerHTML = `<div><b>Focos de calor (48 h)</b> <span class="pill ${near.length ? "lv-rojo" : inProv.length ? "lv-amarillo" : "lv-verde"}">${near.length ? `${near.length} cerca de predios` : inProv.length ? `${inProv.length} en la provincia` : "Sin focos"}</span>
      <p class="muted small">${near.length ? `El más cercano: ${esc(near[0].predio)} (${near[0].km < 0.1 ? "adentro del predio" : `a ${near[0].km.toFixed(1)} km`}), ${fireTime(near[0].t)}.` : "Detectados por satélite (NASA FIRMS). Pueden ser quemas, no siempre incendios."}</p></div>
      <button class="chip" type="button" onclick="showTab('mapa');setTimeout(verFocos,300)">Ver en el mapa</button>`;
  }
  const box = $("firesNear");
  box.innerHTML = near.length
    ? near.slice(0, 30).map((f) => `<div class="card alert lv-${f.km < 1 ? "rojo" : "naranja"}"><span class="lvl lv-${f.km < 1 ? "rojo" : "naranja"}">foco de calor</span>
        <h3>${esc(f.predio)} · ${f.km < 0.1 ? "adentro del predio" : `a ${f.km.toFixed(1)} km`}</h3>
        <p class="small">${fireTime(f.t)} · ${esc(f.sat)} · confianza ${esc(f.conf)}</p></div>`).join("")
    : `<div class="card empty muted">Sin focos de calor a menos de 5 km de tus predios en las últimas 48 h.</div>`;
}

function drawFires() {
  if (!fireGroup) return;
  fireGroup.clearLayers();
  for (const f of (firesData && firesData.fires) || []) {
    L.circleMarker([f.lat, f.lon], { radius: 6, color: "#fff", weight: 1.5, fillColor: f.conf === "alta" ? "#d7263d" : "#ff7a00", fillOpacity: 0.95 })
      .bindPopup(`<b>Foco de calor</b><br><small>${fireTime(f.t)} · ${esc(f.sat)}<br>Confianza ${esc(f.conf)} · potencia ${f.frp} MW</small>`)
      .addTo(fireGroup);
  }
}
function verFocos() {
  const list = (firesData && firesData.fires) || [];
  if (!map || !list.length) return;
  map.fitBounds(L.latLngBounds(list.map((f) => [f.lat, f.lon])), { padding: [30, 30], maxZoom: 11 });
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
  // Los predios son privados: vienen de la base de Firebase y solo los ven los invitados.
  try { predios = window.FB ? await window.FB.loadPredios() : []; } catch { predios = []; }
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
    zoomControl: true, attributionControl: true, minZoom: 6, maxZoom: 16,
    maxBounds: [[PROV.bbox.s - 3, PROV.bbox.w - 4], [PROV.bbox.n + 3, PROV.bbox.e + 4]], maxBoundsViscosity: 0.8,
  }).setView(PROV.center, 7);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 16, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  layers.geocolor = L.tileLayer(`${GIBS}/GOES-East_ABI_GeoColor/default/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`, {
    maxNativeZoom: 7, maxZoom: 16, opacity: 0.85, attribution: 'Satélite: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a> GOES-Este',
  });
  layers.ir = L.tileLayer(`${GIBS}/GOES-East_ABI_Band13_Clean_Infrared/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`, {
    maxNativeZoom: 6, maxZoom: 16, opacity: 0.7, attribution: 'Infrarrojo: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a> GOES-Este',
  });
  alertGroup = L.layerGroup();
  layers.alerts = alertGroup;
  fireGroup = L.layerGroup().addTo(map);
  layers.fires = fireGroup;
  drawFires();
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
  if (window.onMapReady) window.onMapReady(map);
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
      maxNativeZoom: s.z, maxZoom: 16, opacity: 0, zIndex: 200, attribution: `${s.label}: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a> GOES-Este`,
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
    maxNativeZoom: 7, maxZoom: 16, opacity: 0.75, zIndex: 400,
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
  // Un predio en varias partes lleva el nombre una sola vez, en la parte más grande.
  const size = (pr) => pr.p.reduce((n, rings) => n + rings[0].length, 0);
  const labeled = new Map();
  for (const pr of predios) if (!labeled.has(pr.n) || size(pr) > size(labeled.get(pr.n))) labeled.set(pr.n, pr);
  // Doble trazo (borde oscuro + línea amarilla) para que se vea sobre el satélite, las nubes y el mapa.
  for (const pr of predios) {
    L.polygon(pr.p, { color: "#111", weight: 5, opacity: 0.55, fill: false, interactive: false }).addTo(prediosGroup);
    L.polygon(pr.p, { color: "#ffe14d", weight: 2.2, fillColor: "#ffe14d", fillOpacity: 0.08 })
      .bindPopup(`<b>${esc(pr.n)}</b>${pr.ha ? `<br><small>${pr.ha.toLocaleString("es-AR")} ha</small>` : ""}`)
      .addTo(prediosGroup)
      .bindTooltip(labeled.get(pr.n) === pr ? esc(pr.n) : "", { permanent: labeled.get(pr.n) === pr, direction: "center", className: "predio-label", opacity: 1 });
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
  await Promise.all([loadForecast(), pre ? pre.then(loadAlerts).then(loadFires) : loadAlerts().then(loadFires), map ? loadRadar() : null]);
  $("refreshBtn").classList.remove("spin");
}

$("refreshBtn").addEventListener("click", () => loadAll(true));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") loadAll(); });

let booted = false;
/** Arranca la app cuando el usuario ya ingresó (lo llama privado.js). */
async function bootApp() {
  if (booted) return;
  booted = true;
  if (!place) {
    $("placeName").textContent = "Buscando ubicación…";
    place = (await locate()) || DEFAULT_PLACE;
    store.set(LS_PLACE, place);
  }
  $("placeName").textContent = placeLabel(place);
  loadAll(true);
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
