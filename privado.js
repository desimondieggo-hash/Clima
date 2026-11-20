/* Parte privada: ingreso, reportes con foto, invitados y predios (usa window.FB de firebase.js). */
"use strict";

const REPORT_TYPES = [
  ["accidente", "🚨", "Accidente"], ["lluvia", "🌧️", "Lluvia fuerte"], ["granizo", "🧊", "Granizo"],
  ["viento", "💨", "Viento fuerte"], ["arbol", "🌳", "Árbol caído"], ["ruta", "⛔", "Ruta cortada"],
  ["camino", "🟫", "Camino intransitable"], ["humo", "🔥", "Humo / incendio"], ["agua", "🌊", "Anegamiento"], ["otro", "📌", "Otro"],
];
const typeOf = (id) => REPORT_TYPES.find((t) => t[0] === id) || REPORT_TYPES[REPORT_TYPES.length - 1];
const LS_SEEN = "clima.reportsSeen";

let me = null;            // {email, name, admin, user}
let reports = [];
let reportGroup = null;
let stopWatch = null;

const fbReady = () => new Promise((r) => (window.FB ? r() : window.addEventListener("fb-ready", r, { once: true })));

// ------------------------------------------------------------------ Ingreso
function gate(state) {
  const g = $("gate"), msg = $("gateMsg"), login = $("gateLogin"), acts = $("gateActions");
  if (state && state.ok) {
    g.classList.add("hidden");
    return;
  }
  g.classList.remove("hidden");
  login.classList.toggle("hidden", !!state);
  acts.classList.toggle("hidden", !state);
  if (!state) msg.textContent = "";
  else if (state.pending) msg.innerHTML = `Te mandamos un correo a <b>${esc(state.email)}</b> para confirmar que es tuyo. Abrilo, tocá el enlace y volvé acá.<br><a href="#" id="gResend">Reenviar el correo</a>`;
  else if (state.denied) msg.innerHTML = `La cuenta <b>${esc(state.email)}</b> todavía no está invitada. Pedile a Diego que te agregue y después tocá «reintentar».`;
  const rs = document.getElementById("gResend");
  if (rs) rs.onclick = async (e) => { e.preventDefault(); try { await FB.resendVerification(); rs.textContent = "Correo reenviado ✓"; } catch { rs.textContent = "Esperá un minuto y probá de nuevo"; } };
}

function authError(e) {
  const c = (e && e.code) || "";
  const t = {
    "auth/invalid-credential": "Correo o contraseña incorrectos.", "auth/wrong-password": "Contraseña incorrecta.",
    "auth/user-not-found": "No hay una cuenta con ese correo. Tocá «Crear mi contraseña».", "auth/email-already-in-use": "Ese correo ya tiene contraseña: usá «Ingresar».",
    "auth/weak-password": "La contraseña tiene que tener al menos 6 caracteres.", "auth/invalid-email": "Revisá el correo.",
    "auth/popup-closed-by-user": "", "auth/cancelled-popup-request": "", "auth/network-request-failed": "Sin conexión. Probá de nuevo con señal.",
    "auth/too-many-requests": "Demasiados intentos. Esperá unos minutos.", "auth/unauthorized-domain": "Falta autorizar este dominio en Firebase (Authentication → Configuración → Dominios autorizados).",
  }[c];
  $("gateMsg").textContent = t === undefined ? `No se pudo ingresar (${c || e}).` : t;
}

async function initPrivate() {
  await fbReady();
  $("gGoogle").onclick = () => FB.google().catch(authError);
  $("gLogin").onclick = () => FB.emailLogin($("gEmail").value, $("gPass").value).catch(authError);
  $("gSignup").onclick = () => FB.emailSignup($("gEmail").value, $("gPass").value).catch(authError);
  $("gReset").onclick = async () => {
    try { await FB.resetPassword($("gEmail").value); $("gateMsg").textContent = "Te mandamos un correo para elegir una contraseña nueva."; } catch (e) { authError(e); }
  };
  $("gRetry").onclick = async () => gateFor(await FB.reloadUser());
  $("gOut").onclick = () => FB.logout();
  $("logoutBtn").onclick = () => { $("adminDialog").close(); FB.logout(); };
  $("menuBtn").onclick = openAccount;
  $("fabReport").onclick = openReport;
  FB.onUser(gateFor);
}

function gateFor(state) {
  gate(state);
  if (!state || !state.ok) {
    me = null;
    if (stopWatch) { stopWatch(); stopWatch = null; }
    return;
  }
  me = { email: state.email, name: state.name, admin: state.admin };
  bootApp();
  if (!stopWatch) stopWatch = FB.watchReports(onReports, () => { $("reportList").innerHTML = `<div class="card empty muted">No se pudieron leer los reportes.</div>`; });
  window.onTab(document.querySelector(".tab-btn.active").dataset.tab);
}

// ------------------------------------------------------------------ Reportes: lista, mapa y contador
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "recién";
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  return `hace ${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

function onReports(list) {
  reports = list.filter((r) => r.expira > Date.now()).sort((a, b) => b.creado - a.creado);
  renderReports();
  drawReports();
  updateBadge();
}

function renderReports() {
  const box = $("reportList");
  if (!reports.length) { box.innerHTML = `<div class="card empty muted">No hay reportes en las últimas 24 horas.<br>Usá el botón 📷 Reportar para avisar algo al grupo.</div>`; return; }
  box.innerHTML = reports.map((r) => {
    const [, ico, label] = typeOf(r.tipo);
    const km = place ? kmBetween(place.lat, place.lon, r.lat, r.lon) : null;
    const mine = r.uid === FB.uid();
    return `<div class="card rep" data-id="${esc(r.id)}">
      <img src="${esc(r.foto)}" alt="Foto del reporte" data-act="foto" loading="lazy">
      <div>
        <h3>${ico} ${esc(label)}</h3>
        ${r.nota ? `<p>${esc(r.nota)}</p>` : ""}
        <p class="muted">${esc(r.autor || "—")} · ${ago(r.creado)}${km != null ? ` · a ${km < 10 ? km.toFixed(1) : Math.round(km)} km de ${esc(place.name)}` : ""}${r.pending ? " · ⏳ enviando" : ""}</p>
        <div class="acts"><button type="button" data-act="mapa">🗺️ Ver en el mapa</button>${mine || (me && me.admin) ? `<button type="button" class="del" data-act="borrar">Borrar</button>` : ""}</div>
      </div></div>`;
  }).join("");
}

$("reportList").addEventListener("click", async (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const id = e.target.closest(".rep").dataset.id;
  const r = reports.find((x) => x.id === id);
  if (!r) return;
  if (act === "foto") showPhoto(r.foto);
  if (act === "mapa") { showTab("mapa"); setTimeout(() => { if (map) { map.setView([r.lat, r.lon], 12); openReportPopup(r.id); } }, 300); }
  if (act === "borrar" && confirm("¿Borrar este reporte para todos?")) {
    try { await FB.deleteReport(id); } catch { alert("No se pudo borrar. Probá de nuevo con señal."); }
  }
});

function showPhoto(src) {
  const d = document.createElement("div");
  d.className = "photo-full";
  d.innerHTML = `<img src="${esc(src)}" alt="Foto">`;
  d.onclick = () => d.remove();
  document.body.appendChild(d);
}

const reportMarkers = new Map();
function drawReports() {
  if (!reportGroup) return;
  reportGroup.clearLayers();
  reportMarkers.clear();
  for (const r of reports) {
    const [, ico, label] = typeOf(r.tipo);
    const m = L.marker([r.lat, r.lon], { icon: L.divIcon({ className: "rep-icon", html: ico, iconSize: [32, 32], iconAnchor: [16, 16] }), zIndexOffset: 1000 })
      .bindPopup(`<div class="rep-pop"><b>${ico} ${esc(label)}</b><br><small>${esc(r.autor || "")} · ${ago(r.creado)}</small>${r.nota ? `<br>${esc(r.nota)}` : ""}<img src="${esc(r.foto)}" alt=""></div>`, { maxWidth: 260 })
      .addTo(reportGroup);
    reportMarkers.set(r.id, m);
  }
}
function openReportPopup(id) { const m = reportMarkers.get(id); if (m) m.openPopup(); }

window.onMapReady = (m) => {
  reportGroup = L.layerGroup().addTo(m);
  layers.reportes = reportGroup;
  const bar = document.querySelector(".layer-bar");
  if (!bar.querySelector('[data-layer="reportes"]')) {
    const b = document.createElement("button");
    b.className = "chip on"; b.dataset.layer = "reportes"; b.textContent = "Reportes";
    b.addEventListener("click", () => toggleLayer(b));
    bar.appendChild(b);
  }
  drawReports();
};

function seenAt() { try { return Number(localStorage.getItem(LS_SEEN)) || 0; } catch { return 0; } }
function updateBadge() {
  const active = document.querySelector(".tab-btn.active");
  if (active && active.dataset.tab === "reportes") { try { localStorage.setItem(LS_SEEN, String(Date.now())); } catch { /* nada */ } }
  const n = reports.filter((r) => r.creado > seenAt() && r.uid !== FB.uid()).length;
  $("repDot").textContent = n > 9 ? "9+" : String(n);
  $("repDot").classList.toggle("hidden", !n);
}

window.onTab = (name) => {
  $("fabReport").classList.toggle("hidden", !me || !["hoy", "mapa", "reportes"].includes(name));
  if (name === "reportes") updateBadge();
};

// ------------------------------------------------------------------ Nuevo reporte
let draft = null;

function openReport() {
  draft = { tipo: null, foto: null, lat: null, lon: null, aprox: false };
  const types = $("rTypes");
  types.innerHTML = "";
  for (const [id, ico, label] of REPORT_TYPES) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = `${ico} ${label}`;
    b.onclick = () => { draft.tipo = id; types.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === b)); };
    types.appendChild(b);
  }
  $("rNote").value = "";
  $("rPreview").classList.add("hidden");
  $("rPhotoTxt").textContent = "📷 Sacar foto";
  $("rPhoto").value = "";
  $("rLoc").textContent = "Buscando tu ubicación…";
  $("rSend").disabled = false;
  $("reportDialog").showModal();
  navigator.geolocation.getCurrentPosition(
    (p) => { draft.lat = +p.coords.latitude.toFixed(5); draft.lon = +p.coords.longitude.toFixed(5); $("rLoc").textContent = `📍 Ubicación tomada del GPS (±${Math.round(p.coords.accuracy)} m).`; },
    () => { draft.lat = place.lat; draft.lon = place.lon; draft.aprox = true; $("rLoc").textContent = `📍 Sin GPS: se usa ${place.name} como ubicación aproximada.`; },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
}

/** Achica la foto hasta que pese menos de ~300 KB (para guardarla dentro de la base). */
async function compressPhoto(file) {
  const bmp = await createImageBitmap(file);
  let max = 1280, q = 0.7, out = "";
  for (let i = 0; i < 6; i++) {
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    out = c.toDataURL("image/jpeg", q);
    if (out.length < 300000) break;
    if (q > 0.5) q -= 0.1; else max = Math.round(max * 0.8);
  }
  return out;
}

$("rPhoto").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  $("rPhotoTxt").textContent = "Procesando…";
  try {
    draft.foto = await compressPhoto(f);
    $("rPreview").src = draft.foto;
    $("rPreview").classList.remove("hidden");
    $("rPhotoTxt").textContent = "";
  } catch { $("rPhotoTxt").textContent = "No se pudo leer la foto. Probá de nuevo."; }
});

$("rSend").addEventListener("click", () => {
  if (!draft.tipo) return alert("Elegí qué querés reportar.");
  if (!draft.foto) return alert("Sacá una foto.");
  if (draft.lat == null) return alert("Esperá un segundo a que tome la ubicación.");
  $("rSend").disabled = true;
  const nota = ($("rNote").value.trim() + (draft.aprox ? " (ubicación aproximada)" : "")).slice(0, 280);
  try {
    const { done } = FB.addReport({ tipo: draft.tipo, nota, lat: draft.lat, lon: draft.lon, foto: draft.foto, autor: (me.name || me.email).slice(0, 80) });
    done.catch(() => alert("El reporte no se pudo guardar. Revisá que tu cuenta siga invitada."));
    $("reportDialog").close();
    showTab("reportes");
  } catch {
    $("rSend").disabled = false;
    alert("No se pudo enviar. Probá de nuevo.");
  }
});

// ------------------------------------------------------------------ Mi cuenta / administración
async function openAccount() {
  if (!me) return;
  $("whoTitle").textContent = me.admin ? "Administración" : "Mi cuenta";
  $("whoMail").textContent = `${me.name} · ${me.email}`;
  $("adminBox").classList.toggle("hidden", !me.admin);
  $("adminDialog").showModal();
  if (me.admin) { refreshMembers(); $("pInfo").textContent = predios.length ? `Cargados: ${predios.length} contornos.` : "Todavía no hay predios cargados."; }
}

// ---- Compartir por WhatsApp
const APP_URL = "https://desimondieggo-hash.github.io/Clima/";
let lastInvited = "";
const waLink = (t) => "https://wa.me/?text=" + encodeURIComponent(t);
function inviteText(nombre, email) {
  const hola = nombre ? `Hola ${nombre.split(" ")[0]}!` : "Hola!";
  return `${hola} Te invité a *Clima Corrientes*, la app del clima para el monte: pronóstico, radar, alertas del SMN, riesgo de incendio y reportes con foto de los predios.\n\n` +
    `1. Abrí este link en el celular: ${APP_URL}\n` +
    `2. Entrá con Google usando *${email}* (o creá usuario con ese mismo correo y confirmalo desde el mail).\n` +
    `3. Para tenerla como app: menú del navegador ⋮ → "Agregar a pantalla de inicio" (en iPhone: Compartir → "Agregar a inicio").`;
}
function shareText() {
  return `Te paso *Clima Corrientes*, la app del clima para el monte: ${APP_URL}\n` +
    `Es privada: para entrar, pedile a Diego que te invite con tu correo de Gmail.`;
}
$("shareBtn").addEventListener("click", async () => {
  const text = shareText();
  if (navigator.share) { try { await navigator.share({ title: "Clima Corrientes", text }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
  window.open(waLink(text), "_blank", "noopener");
});

async function refreshMembers() {
  const ul = $("mList");
  ul.innerHTML = `<li class="muted">Cargando…</li>`;
  try {
    const list = await FB.listMembers();
    ul.innerHTML = list.length ? "" : `<li class="muted">Todavía no invitaste a nadie.</li>`;
    for (const m of list) {
      const li = document.createElement("li");
      li.innerHTML = `<span>${esc(m.nombre || "—")}<small>${esc(m.email)}</small></span>`;
      const w = document.createElement("a");
      w.className = "wa-btn"; w.target = "_blank"; w.rel = "noopener"; w.textContent = "WhatsApp";
      w.href = waLink(inviteText(m.nombre, m.email));
      li.appendChild(w);
      if (m.email === lastInvited) li.classList.add("just-added");
      const b = document.createElement("button");
      b.type = "button"; b.textContent = "Quitar";
      b.onclick = async () => { if (confirm(`¿Quitar a ${m.email}? Deja de poder entrar.`)) { await FB.removeMember(m.email); refreshMembers(); } };
      li.appendChild(b);
      ul.appendChild(li);
    }
  } catch { ul.innerHTML = `<li class="muted">No se pudo leer la lista (¿están publicadas las reglas?).</li>`; }
}

$("mAdd").addEventListener("click", async () => {
  const email = $("mEmail").value.trim().toLowerCase(), name = $("mName").value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return alert("Revisá el correo.");
  try { await FB.addMember(email, name); lastInvited = email; $("mEmail").value = ""; $("mName").value = ""; await refreshMembers(); $("mList").querySelector(".just-added")?.scrollIntoView({ block: "nearest" }); }
  catch { alert("No se pudo invitar. ¿Están publicadas las reglas de Firestore?"); }
});

// ---- Predios: leer KML / KMZ en el teléfono o la compu
async function unzipFirstKml(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("zip");
  let p = dv.getUint32(eocd + 16, true);
  const count = dv.getUint16(eocd + 10, true);
  for (let n = 0; n < count; n++) {
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), cmtLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + cmtLen;
    if (!/\.kml$/i.test(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = u8.subarray(start, start + size);
    if (method === 0) return new TextDecoder().decode(data);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return await new Response(stream).text();
  }
  throw new Error("Sin KML adentro");
}

function parseKml(text) {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  const out = [];
  const byTag = (el, t) => Array.from(el.getElementsByTagNameNS("*", t));
  const ring = (el) => {
    const c = byTag(el, "coordinates")[0];
    if (!c) return null;
    const pts = c.textContent.trim().split(/\s+/).map((s) => s.split(",")).filter((a) => a.length >= 2).map((a) => [+(+a[1]).toFixed(6), +(+a[0]).toFixed(6)]);
    return pts.length >= 4 ? pts : null;
  };
  byTag(xml, "Placemark").forEach((pm, i) => {
    const polys = byTag(pm, "Polygon").map((pg) => [
      ...byTag(pg, "outerBoundaryIs").map(ring), ...byTag(pg, "innerBoundaryIs").map(ring),
    ].filter(Boolean)).filter((r) => r.length);
    if (!polys.length) return;
    const nameEl = Array.from(pm.children).find((c) => c.localName === "name");
    const desc = (byTag(pm, "description")[0] || {}).textContent || "";
    const m = desc.match(/<td>\s*(Has|Sup)\s*<\/td>\s*<td>([\d.,]+)<\/td>/i);
    const item = { n: (nameEl && nameEl.textContent.trim()) || `Predio ${i + 1}`, p: polys };
    if (m) item.ha = Math.round(parseFloat(m[2].replace(",", ".")));
    out.push(item);
  });
  return out;
}

$("pFile").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const st = $("pStatus");
  st.textContent = "Leyendo el archivo…";
  try {
    const buf = await f.arrayBuffer();
    let list;
    if (/\.json$/i.test(f.name)) list = JSON.parse(new TextDecoder().decode(buf));
    else {
      const head = new Uint8Array(buf, 0, 2);
      const text = head[0] === 0x50 && head[1] === 0x4b ? await unzipFirstKml(buf) : new TextDecoder().decode(buf);
      list = parseKml(text);
    }
    if (!list.length) throw new Error("No encontré predios (polígonos) en el archivo.");
    if (!confirm(`Encontré ${list.length} contornos. ¿Reemplazar los predios cargados por estos?`)) { st.textContent = ""; return; }
    st.textContent = "Guardando en la base…";
    const r = await FB.savePredios(list);
    predios = list;
    drawPredios();
    renderAlerts();
    renderFiresSummary();
    st.textContent = `✓ Listo: ${list.length} contornos guardados (${(r.size / 1024).toFixed(0)} KB en ${r.n} parte/s). Ya los ven todos los invitados.`;
    $("pInfo").textContent = `Cargados: ${list.length} contornos.`;
  } catch (err) {
    st.textContent = `No se pudo cargar: ${err.message || err}`;
  } finally { e.target.value = ""; }
});

initPrivate();
