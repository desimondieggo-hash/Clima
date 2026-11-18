// Parte privada de Clima Corrientes: ingreso con invitados, predios y reportes con foto (Firebase).
// Se carga como módulo y deja sus funciones en window.FB para app.js.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, getDoc, setDoc, deleteDoc,
  collection, getDocs, query, where, orderBy, onSnapshot, serverTimestamp, Timestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

const app = initializeApp({
  apiKey: "AIzaSyCTVir7WHyFOjVrtlYagvrsEz6FLsr6ro0",
  authDomain: "clima-corrientes.firebaseapp.com",
  projectId: "clima-corrientes",
  storageBucket: "clima-corrientes.firebasestorage.app",
  messagingSenderId: "1074699045278",
  appId: "1:1074699045278:web:75511a3ba8b35e342c6e8f",
});
const auth = getAuth(app);
auth.languageCode = "es";
// Guarda lo leído en el teléfono: la app abre sin señal con lo último que vio.
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

const ADMIN = "desimon.dieggo@gmail.com";
const REPORT_HOURS = 24;
const PART = 800_000; // caracteres por documento de predios (límite de Firestore: 1 MB)
const LS_MEMBER = "clima.member";

const lower = (e) => String(e || "").trim().toLowerCase();

/** Estado del usuario: null (sin sesión), {pending} (sin verificar), {denied}, o {ok, admin}. */
async function checkUser(user) {
  if (!user) return null;
  const email = lower(user.email);
  if (!user.emailVerified) return { user, email, pending: true };
  if (email === ADMIN) return { user, email, ok: true, admin: true, name: user.displayName || "Diego" };
  try {
    const snap = await getDoc(doc(db, "miembros", email));
    const ok = snap.exists();
    try { localStorage.setItem(LS_MEMBER, JSON.stringify({ email, ok })); } catch { /* nada */ }
    return ok ? { user, email, ok: true, admin: false, name: snap.data().nombre || user.displayName || email } : { user, email, denied: true };
  } catch {
    // Sin señal: se confía en la última respuesta guardada para ese correo.
    let last = null;
    try { last = JSON.parse(localStorage.getItem(LS_MEMBER)); } catch { /* nada */ }
    return last && last.email === email && last.ok ? { user, email, ok: true, admin: false, name: user.displayName || email, offline: true } : { user, email, denied: true };
  }
}

window.FB = {
  ADMIN, REPORT_HOURS,
  onUser(cb) { return onAuthStateChanged(auth, async (u) => cb(await checkUser(u))); },
  async google() {
    const p = new GoogleAuthProvider();
    p.setCustomParameters({ prompt: "select_account" });
    try { await signInWithPopup(auth, p); } catch (e) {
      if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) await signInWithRedirect(auth, p);
      else throw e;
    }
  },
  async emailLogin(email, pass) { await signInWithEmailAndPassword(auth, lower(email), pass); },
  async emailSignup(email, pass) {
    const c = await createUserWithEmailAndPassword(auth, lower(email), pass);
    await sendEmailVerification(c.user);
  },
  async resendVerification() { if (auth.currentUser) await sendEmailVerification(auth.currentUser); },
  async reloadUser() { if (auth.currentUser) { await auth.currentUser.reload(); await auth.currentUser.getIdToken(true); return checkUser(auth.currentUser); } return null; },
  async resetPassword(email) { await sendPasswordResetEmail(auth, lower(email)); },
  logout() { return signOut(auth); },

  // ---------------- Miembros (solo admin)
  async listMembers() {
    const s = await getDocs(collection(db, "miembros"));
    return s.docs.map((d) => ({ email: d.id, ...d.data() })).sort((a, b) => a.email.localeCompare(b.email));
  },
  addMember(email, nombre) { return setDoc(doc(db, "miembros", lower(email)), { nombre: String(nombre || "").slice(0, 80), agregado: serverTimestamp() }); },
  removeMember(email) { return deleteDoc(doc(db, "miembros", lower(email))); },

  // ---------------- Predios
  async loadPredios() {
    const s = await getDocs(collection(db, "predios"));
    const parts = s.docs.map((d) => d.data()).filter((d) => typeof d.data === "string").sort((a, b) => a.i - b.i);
    if (!parts.length) return [];
    return JSON.parse(parts.map((p) => p.data).join(""));
  },
  async savePredios(list) {
    const text = JSON.stringify(list);
    const n = Math.ceil(text.length / PART);
    const old = await getDocs(collection(db, "predios"));
    const b = writeBatch(db);
    for (let i = 0; i < n; i++) b.set(doc(db, "predios", `part${i}`), { i, n, data: text.slice(i * PART, (i + 1) * PART), actualizado: serverTimestamp() });
    old.docs.forEach((d) => { if (!/^part\d+$/.test(d.id) || Number(d.id.slice(4)) >= n) b.delete(d.ref); });
    await b.commit();
    return { n, size: text.length };
  },

  // ---------------- Reportes
  watchReports(cb, onError) {
    const q = query(collection(db, "reportes"), where("expira", ">", Timestamp.now()), orderBy("expira", "desc"));
    return onSnapshot(q, (s) => cb(s.docs.map((d) => {
      const r = d.data({ serverTimestamps: "estimate" });
      return { id: d.id, ...r, creado: r.creado ? r.creado.toMillis() : Date.now(), expira: r.expira.toMillis(), pending: d.metadata.hasPendingWrites };
    })), onError);
  },
  addReport(r) {
    const ref = doc(collection(db, "reportes"));
    // Sin esperar: con o sin señal queda en el teléfono y Firebase lo sube cuando hay conexión.
    const p = setDoc(ref, {
      tipo: r.tipo, nota: r.nota || "", lat: r.lat, lon: r.lon, foto: r.foto, autor: r.autor || "",
      uid: auth.currentUser.uid, creado: serverTimestamp(), expira: Timestamp.fromMillis(Date.now() + REPORT_HOURS * 3600e3),
    });
    return { id: ref.id, done: p };
  },
  deleteReport(id) { return deleteDoc(doc(db, "reportes", id)); },
  uid() { return auth.currentUser && auth.currentUser.uid; },
};
window.dispatchEvent(new Event("fb-ready"));
