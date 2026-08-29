// db.js — lapisan akses data Firestore. Semua interaksi database lewat sini.
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js';
import {
  initializeFirestore, collection, doc, addDoc, updateDoc, deleteDoc, getDoc, getDocs,
  onSnapshot, query, orderBy, serverTimestamp, Timestamp, setDoc,
  persistentLocalCache, persistentMultipleTabManager, writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';
import {
  getStorage, ref, uploadBytes, getDownloadURL, deleteObject,
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-storage.js';

let app, db, auth, storage;
let firebaseReady = false;
let firebaseInitError = null;

export function initFirebase() {
  if (firebaseConfig.apiKey.startsWith('GANTI_DENGAN')) {
    firebaseInitError = 'Firebase belum dikonfigurasi. Edit file firebase-config.js dengan data project Firebase Anda.';
    return { ok: false, error: firebaseInitError };
  }
  try {
    app = initializeApp(firebaseConfig);
    try {
      // Cache offline persisten (bertahan antar sesi, mendukung banyak tab terbuka di device yang sama).
      db = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      });
    } catch (persistErr) {
      // Browser tidak mendukung (mis. private browsing) - lanjut tanpa cache offline penuh.
      console.warn('[db] Cache offline tidak aktif:', persistErr.message);
      db = initializeFirestore(app, {});
    }
    auth = getAuth(app);
    storage = getStorage(app);
    firebaseReady = true;
    return { ok: true };
  } catch (err) {
    firebaseInitError = err.message;
    return { ok: false, error: err.message };
  }
}

export function isReady() { return firebaseReady; }
export function getInitError() { return firebaseInitError; }

/* ===================== Auth ===================== */
export function login(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}
export function logout() {
  return signOut(auth);
}
export function watchAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

/* ===================== Proyek CRUD ===================== */
const PROJECTS_COL = 'proyek';
const SETTINGS_DOC = 'settings/config';

function toFirestoreDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return null;
  return Timestamp.fromDate(d);
}

/** Bersihkan field sebelum ditulis ke Firestore (jangan simpan field turunan / undefined). */
function sanitizeForWrite(p) {
  const clean = {
    tanggalPO: toFirestoreDate(p.tanggalPO),
    noPO: String(p.noPO || '').trim(),
    perusahaan: String(p.perusahaan || '').trim(),
    tanggalTransfer: toFirestoreDate(p.tanggalTransfer),
    nilaiKontrak: Number(p.nilaiKontrak) || 0,
    modalKerja: Number(p.modalKerja) || 0,
    investor: String(p.investor || '').trim(),
    jenisPekerjaan: String(p.jenisPekerjaan || '').trim(),
    feeCB: Number(p.feeCB) || 0,
    biayaPersonil: Number(p.biayaPersonil) || 0,
    biayaDokumen: Number(p.biayaDokumen) || 0,
    biayaOperasional: Number(p.biayaOperasional) || 0,
    keterangan: String(p.keterangan || '').trim(),
    progress: {
      pengerjaan: !!(p.progress && p.progress.pengerjaan),
      submitDokumen: !!(p.progress && p.progress.submitDokumen),
      penagihan: !!(p.progress && p.progress.penagihan),
      pembayaran: !!(p.progress && p.progress.pembayaran),
    },
    kendala: String(p.kendala || '').trim(),
    updatedAt: serverTimestamp(),
  };
  return clean;
}

export async function addProject(p) {
  const data = sanitizeForWrite(p);
  data.createdAt = serverTimestamp();
  const ref = await addDoc(collection(db, PROJECTS_COL), data);
  return ref.id;
}

export async function updateProject(id, p) {
  const data = sanitizeForWrite(p);
  await updateDoc(doc(db, PROJECTS_COL, id), data);
}

export async function deleteProject(id) {
  await deleteDoc(doc(db, PROJECTS_COL, id));
}

/* ===================== Surat Penawaran (file per proyek) ===================== */
/**
 * Upload file surat penawaran (PDF/Word) untuk satu proyek ke Firebase Storage,
 * lalu simpan metadata-nya (url, path, nama file) ke field `penawaranFile` pada
 * dokumen proyek. Pakai updateDoc (bukan sanitizeForWrite) supaya tidak menimpa
 * field lain proyek yang sedang tidak diedit.
 */
export async function uploadPenawaranFile(projectId, file) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `penawaran/${projectId}/${Date.now()}_${safeName}`;
  const fileRef = ref(storage, path);
  await uploadBytes(fileRef, file);
  const url = await getDownloadURL(fileRef);
  const meta = { url, path, fileName: file.name, uploadedAt: Timestamp.now() };
  await updateDoc(doc(db, PROJECTS_COL, projectId), { penawaranFile: meta });
  return meta;
}

/** Hapus file surat penawaran yang tersimpan (Storage + field-nya di Firestore). */
export async function deletePenawaranFile(projectId, storagePath) {
  if (storagePath) {
    try { await deleteObject(ref(storage, storagePath)); }
    catch (err) { console.warn('[db] Gagal hapus file di Storage (mungkin sudah terhapus):', err.message); }
  }
  await updateDoc(doc(db, PROJECTS_COL, projectId), { penawaranFile: null });
}

/** Real-time listener — otomatis re-render tiap ada perubahan dari device manapun. */
export function watchProjects(onChange, onError) {
  const q = query(collection(db, PROJECTS_COL), orderBy('tanggalTransfer', 'desc'));
  return onSnapshot(q, (snap) => {
    const list = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        tanggalPO: data.tanggalPO ? data.tanggalPO.toDate() : null,
        tanggalTransfer: data.tanggalTransfer ? data.tanggalTransfer.toDate() : null,
      };
    });
    onChange(list);
  }, (err) => {
    console.error('[db] watchProjects error:', err);
    if (onError) onError(err);
  });
}

/* ===================== Settings ===================== */
export async function getSettings() {
  const ref = doc(db, SETTINGS_DOC);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}
export async function saveSettings(settings) {
  const ref = doc(db, SETTINGS_DOC);
  await setDoc(ref, settings, { merge: true });
}
export function watchSettings(onChange) {
  const ref = doc(db, SETTINGS_DOC);
  return onSnapshot(ref, (snap) => onChange(snap.exists() ? snap.data() : null));
}

/* ===================== Import data awal (seed) ===================== */
export async function isProjectsEmpty() {
  const snap = await getDocs(collection(db, PROJECTS_COL));
  return snap.empty;
}

export async function seedProjects(seedList) {
  const batch = writeBatch(db);
  seedList.forEach((p) => {
    const ref = doc(collection(db, PROJECTS_COL));
    batch.set(ref, { ...sanitizeForWrite(p), createdAt: serverTimestamp() });
  });
  await batch.commit();
}
