import * as DB from './db.js';
import * as C from './compute.js';
import { SEED_DATA } from './seed-data.js';

/* ===================== Utilities ===================== */
const fmtRp = (n) => (n === null || n === undefined || isNaN(n)) ? '—' : 'Rp ' + Math.round(n).toLocaleString('id-ID');
const fmtRpShort = (n) => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (Math.abs(n) >= 1e9) return 'Rp ' + (n / 1e9).toFixed(2).replace('.', ',') + ' M';
  if (Math.abs(n) >= 1e6) return 'Rp ' + (n / 1e6).toFixed(1).replace('.', ',') + ' Jt';
  return fmtRp(n);
};
const fmtPct = (n) => (n === null || n === undefined || isNaN(n)) ? '—' : (n * 100).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + '%';
const fmtDate = (v) => {
  const d = C.toDate(v);
  if (!d) return '—';
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
};
const toInputDate = (v) => {
  const d = C.toDate(v);
  if (!d) return '';
  return d.toISOString().slice(0, 10);
};
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function toast(msg, kind = 'info') {
  const el = qs('#toast');
  el.textContent = msg;
  el.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, 4200);
}

/* ===================== State ===================== */
let RAW_PROJECTS = [];
let SETTINGS = { ...C.DEFAULT_SETTINGS };
let COMPUTED = [];
let CHARTS = {};
let TABLE_SORT = { key: 'tanggalTransfer', dir: 'desc' };
// Urutan prioritas status dana investor — dipakai untuk sort kolom "Status" di
// tab Investor (angka lebih besar = lebih urgent/bermasalah).
const STATUS_RANK = { critical: 6, overdue: 5, danger: 4, warn: 3, ok: 2, neutral: 1, info: 0 };
let INVESTOR_SORT = { key: 'tanggalTransfer', dir: 'desc' };
let EDITING_ID = null; // null = mode tambah baru
let unsubProjects = null, unsubSettings = null;
let FORECAST_DIRTY = new Set(); // field biaya yang sudah diubah manual - jangan ditimpa forecast
let IS_VIEWER = false; // true = mode Investor/Stakeholder (lihat saja, tanpa login) - lihat wireInstall di bawah untuk deteksi ?viewer=1

/** Blokir aksi tulis di sisi tampilan untuk mode Investor (lihat saja). Ini cuma
 *  lapisan kenyamanan UI - pengaman sesungguhnya ada di firestore.rules (koleksi admins/),
 *  supaya walau seseorang mengakali tampilan, Firestore tetap menolak tulisannya. */
function blockIfViewer() {
  if (!IS_VIEWER) return false;
  toast('Mode Investor: lihat saja, tidak bisa mengedit.', 'error');
  return true;
}

/** Sembunyikan tombol/aksi tulis untuk mode Investor. Sudah dibantu CSS (.viewer-mode),
 *  fungsi ini untuk elemen yang butuh disentuh lewat JS juga. */
function applyViewerRestrictions() {
  if (!IS_VIEWER) return;
  const del = qs('#formDeleteBtn');
  if (del) del.style.display = 'none';
}

const KNOWN_INVESTORS = ['Vares', 'Kang Fajar', 'Kas Dacin', 'Gana'];
const KNOWN_JOBS = ['Kalibrasi Timbangan', 'Kalibrasi Tangki', 'Kalibrasi Flowmeter', 'Kalibrasi Suhu', 'Kalibrasi Pressure', 'Kalibrasi Vacum Gauge', 'Check Weigher', 'Repair Timbangan', 'Pengadaan Barang', 'Training', 'Subkon', 'Kalibrasi Batching Plant', 'Kalibrasi Anak Timbangan'];

/* ===================== Boot ===================== */
async function boot() {
  const init = DB.initFirebase();
  if (!init.ok) {
    showConfigError(init.error);
    return;
  }
  wireLoginForm();
  wireInstall();

  // Link ?viewer=1 = mode Investor/Stakeholder: masuk otomatis sebagai tamu (anonim),
  // tanpa perlu email/password. Kalau provider Anonymous belum diaktifkan di Firebase
  // Console, tampilkan pesan yang jelas alih-alih macet di layar kosong.
  const isViewerLink = new URLSearchParams(location.search).get('viewer') === '1';
  if (isViewerLink) {
    try {
      await DB.loginAnonymous();
    } catch (err) {
      showConfigError('Mode Investor (lihat saja) belum aktif. Admin Dacin Mas perlu mengaktifkan provider "Anonymous" di Firebase Console > Authentication > Sign-in method. (' + err.message + ')');
      return;
    }
  }

  DB.watchAuth((user) => {
    if (user) {
      showApp(user);
    } else {
      showLogin();
    }
  });
  if ('serviceWorker' in navigator) {
    // updateViaCache:'none' — paksa browser SELALU cek sw.js langsung ke jaringan
    // (bypass HTTP cache) tiap kali halaman dimuat. Tanpa ini, browser bisa terus
    // memakai byte sw.js lama dari cache biasa sehingga bump versi CACHE_NAME di
    // dalam sw.js tidak pernah terdeteksi — inilah sumber "belum ada perubahan"
    // yang berulang kali muncul walau file sudah ter-upload & Vercel sudah deploy.
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});

    // Bagian KEDUA dari fix ini: walau Service Worker baru terdeteksi & ter-install,
    // ia baru benar-benar "mengambil alih" kontrol setelah event ini menyala - dan
    // halaman yang SEDANG terbuka saat itu tetap dilayani oleh SW versi LAMA untuk
    // semua file (app.js, style.css, dst) sampai di-reload ulang. Tanpa baris ini,
    // pemuatan pertama setelah ada update bisa diam-diam memakai app.js versi lama
    // (HTML-nya sudah baru, tapi skrip di dalamnya masih lama) - reload sekali otomatis
    // di sini memastikan device selalu langsung dapat versi terbaru tanpa perlu
    // trik manual (Incognito / hapus cache) tiap kali ada update baru.
    let swReloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (swReloaded) return;
      swReloaded = true;
      window.location.reload();
    });
  }
  window.addEventListener('online', updateOnlineBadge);
  window.addEventListener('offline', updateOnlineBadge);
  updateOnlineBadge();
}
document.addEventListener('DOMContentLoaded', boot);

function showConfigError(msg) {
  qs('#configError').style.display = 'flex';
  qs('#configErrorMsg').textContent = msg;
  qs('#loginScreen').style.display = 'none';
  qs('#appRoot').style.display = 'none';
}

function updateOnlineBadge() {
  const el = qs('#onlineBadge');
  if (!el) return;
  if (navigator.onLine) {
    el.textContent = '';
    el.style.display = 'none';
  } else {
    el.textContent = '⚠ Offline — perubahan akan tersimpan otomatis saat online kembali';
    el.style.display = 'flex';
  }
}

/* ===================== Auth screens ===================== */
function showLogin() {
  if (unsubProjects) { unsubProjects(); unsubProjects = null; }
  if (unsubSettings) { unsubSettings(); unsubSettings = null; }
  qs('#loginScreen').style.display = 'flex';
  qs('#appRoot').style.display = 'none';
  qs('#configError').style.display = 'none';
}

function showApp(user) {
  qs('#loginScreen').style.display = 'none';
  qs('#appRoot').style.display = 'block';
  qs('#configError').style.display = 'none';
  IS_VIEWER = !!user.isAnonymous;
  qs('#userEmail').textContent = IS_VIEWER ? 'Mode Investor — Lihat Saja' : (user.email || '');
  qs('#appRoot').classList.toggle('viewer-mode', IS_VIEWER);

  wireTabs();
  wireTableControls();
  wireInvestorTableSort();
  wireForm();
  wireSeedBanner();
  wireLogout();
  wireSettingsForm();
  wireBackupExport();
  applyViewerRestrictions();

  unsubSettings = DB.watchSettings((s) => {
    SETTINGS = { ...C.DEFAULT_SETTINGS, ...(s || {}) };
    populateSettingsForm();
    recomputeAndRenderAll();
  });

  unsubProjects = DB.watchProjects((list) => {
    RAW_PROJECTS = list;
    recomputeAndRenderAll();
    checkSeedBanner();
  }, (err) => {
    toast('Gagal memuat data proyek: ' + err.message, 'error');
  });
}

function wireLoginForm() {
  const form = qs('#loginForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = qs('#loginEmail').value.trim();
    const password = qs('#loginPassword').value;
    const btn = qs('#loginSubmitBtn');
    const errEl = qs('#loginError');
    errEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Masuk…';
    try {
      await DB.login(email, password);
    } catch (err) {
      errEl.textContent = translateAuthError(err.code) || err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Masuk';
    }
  });
}

function translateAuthError(code) {
  const map = {
    'auth/invalid-email': 'Format email tidak valid.',
    'auth/user-not-found': 'Akun dengan email ini tidak ditemukan.',
    'auth/wrong-password': 'Password salah.',
    'auth/invalid-credential': 'Email atau password salah.',
    'auth/too-many-requests': 'Terlalu banyak percobaan gagal. Coba lagi beberapa menit lagi.',
    'auth/network-request-failed': 'Tidak ada koneksi internet.',
  };
  return map[code];
}

function wireLogout() {
  qs('#logoutBtn').addEventListener('click', async () => {
    if (!confirm('Keluar dari aplikasi?')) return;
    await DB.logout();
  });
}

/* ===================== Tabs ===================== */
function wireTabs() {
  qsa('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      qsa('.tab').forEach((b) => b.classList.remove('active'));
      qsa('.view').forEach((v) => v.classList.remove('active'));
      btn.classList.add('active');
      qs('#' + btn.dataset.target).classList.add('active');
      // Chart.js mengukur ukuran canvas saat dibuat; kalau tab-nya sedang tersembunyi
      // (display:none) waktu chart pertama kali dirender, ukurannya jadi 0 dan kosong
      // selamanya. Resize paksa setelah tab aktif (browser sudah selesai reflow) supaya
      // chart di tab Omset & Biaya ikut muncul begitu tab-nya dibuka.
      requestAnimationFrame(() => Object.values(CHARTS).forEach((c) => c && c.resize()));
    });
  });
}

/* ===================== Recompute + render ===================== */
function recomputeAndRenderAll() {
  COMPUTED = C.computeAll(RAW_PROJECTS, SETTINGS);
  const kpi = C.computeKPI(COMPUTED, SETTINGS);
  renderKPI(kpi);
  renderGauge(kpi);
  const perMonth = C.groupByMonth(COMPUTED);
  const perClient = C.groupByClient(COMPUTED);
  renderMonthlyChart(perMonth);
  renderClientChart(perClient);
  renderMonthlyTable(perMonth);
  renderClientTable(perClient);
  renderTargetProgress(kpi);
  renderInvestors(C.groupByInvestor(COMPUTED));
  renderComponentCost(C.computeAverageComponentCost(COMPUTED));
  populateFilterOptions();
  applyTableFilters();
}

/* ===================== Seed import banner ===================== */
function wireSeedBanner() {
  qs('#seedImportBtn').addEventListener('click', async () => {
    if (blockIfViewer()) return;
    if (!confirm('Impor 30 data proyek awal dari file Excel? Hanya lakukan ini SEKALI saat data masih kosong.')) return;
    const btn = qs('#seedImportBtn');
    btn.disabled = true;
    btn.textContent = 'Mengimpor…';
    try {
      await DB.seedProjects(SEED_DATA);
      toast('Berhasil mengimpor ' + SEED_DATA.length + ' proyek awal.', 'success');
      qs('#seedBanner').style.display = 'none';
    } catch (err) {
      toast('Gagal mengimpor data: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Impor Data Awal';
    }
  });
  qs('#seedDismissBtn').addEventListener('click', () => {
    qs('#seedBanner').style.display = 'none';
  });
}

async function checkSeedBanner() {
  if (RAW_PROJECTS.length === 0) {
    qs('#seedBanner').style.display = 'flex';
  } else {
    qs('#seedBanner').style.display = 'none';
  }
}

/* ===================== KPI ===================== */
function renderKPI(k) {
  const items = [
    { label: 'Total Proyek', value: k.totalProyek },
    { label: 'Omset YTD', value: fmtRpShort(k.totalOmset) },
    { label: 'Keuntungan Bersih Net', value: fmtRpShort(k.keuntunganBersihNet), cls: 'ok' },
    { label: 'Rata-rata / Proyek', value: fmtRpShort(k.rataRataKontrak) },
    { label: 'Gross Margin', value: fmtPct(k.grossMargin) },
    { label: 'Net Margin', value: fmtPct(k.netMargin) },
    { label: 'Total Bagi Hasil (30%)', value: fmtRpShort(k.totalBagiHasil) },
    { label: 'PPh Final 0,5%', value: fmtRpShort(k.totalPPhFinal), cls: 'warn' },
  ];
  qs('#kpiGrid').innerHTML = items.map((it) => `
    <div class="panel kpi">
      <div class="label">${it.label}</div>
      <div class="value small ${it.cls || ''}">${it.value}</div>
    </div>`).join('');
}

/* ===================== Signature gauge ===================== */
const GAUGE_START = -120, GAUGE_SWEEP = 240, GAUGE_CX = 130, GAUGE_CY = 130, GAUGE_R = 96;
function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function describeArc(cx, cy, r, startAngle, endAngle) {
  if (endAngle - startAngle < 0.01) return '';
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
  return ['M', start.x.toFixed(2), start.y.toFixed(2), 'A', r, r, 0, largeArc, 0, end.x.toFixed(2), end.y.toFixed(2)].join(' ');
}
function pctToAngle(pct) { return GAUGE_START + GAUGE_SWEEP * Math.max(0, Math.min(1, pct)); }

function buildGaugeFace(zoneAmberStart, zoneRedStart) {
  const arcsG = qs('#gaugeArcs'), ticksG = qs('#gaugeTicks');
  if (!arcsG || !ticksG) return;
  arcsG.innerHTML = ''; ticksG.innerHTML = '';
  const zones = [
    { from: 0, to: zoneAmberStart, color: '#3c5a49' },
    { from: zoneAmberStart, to: zoneRedStart, color: '#8a6a2e' },
    { from: zoneRedStart, to: 1, color: '#7a3733' },
  ];
  zones.forEach((z) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', describeArc(GAUGE_CX, GAUGE_CY, GAUGE_R, pctToAngle(z.from), pctToAngle(z.to)));
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', z.color);
    path.setAttribute('stroke-width', '14'); arcsG.appendChild(path);
  });
  for (let i = 0; i <= 12; i++) {
    const ang = pctToAngle(i / 12);
    const p1 = polarToCartesian(GAUGE_CX, GAUGE_CY, GAUGE_R - 12, ang);
    const p2 = polarToCartesian(GAUGE_CX, GAUGE_CY, GAUGE_R + 2, ang);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', p1.x.toFixed(2)); line.setAttribute('y1', p1.y.toFixed(2));
    line.setAttribute('x2', p2.x.toFixed(2)); line.setAttribute('y2', p2.y.toFixed(2));
    line.setAttribute('stroke', i % 3 === 0 ? '#ECE7DD' : '#5C6570');
    line.setAttribute('stroke-width', i % 3 === 0 ? '2' : '1');
    ticksG.appendChild(line);
  }
}

function renderGauge(k) {
  const threshold = k.thresholdPKP || 4800000000;
  const pct = Math.max(0, Math.min(1, k.omsetYTD / threshold));
  const zoneAmberStart = Math.max(0, Math.min(1, (threshold - 1000000000) / threshold));
  const zoneRedStart = Math.max(0, Math.min(1, (threshold - 500000000) / threshold));
  buildGaugeFace(zoneAmberStart, zoneRedStart);
  const needle = qs('#gaugeNeedle');
  if (needle) needle.style.transform = `rotate(${pctToAngle(pct)}deg)`;
  qs('#gaugeOmset').textContent = fmtRpShort(k.omsetYTD);
  qs('#gaugeThreshold').textContent = fmtRpShort(threshold);
  qs('#gaugeSisa').textContent = fmtRpShort(k.sisaThreshold);
  const badge = qs('#gaugeBadge');
  let level = 'ok';
  if (k.statusPKP.includes('⛔')) level = 'danger';
  else if (k.statusPKP.includes('🔴') || k.statusPKP.includes('🟡')) level = 'warn';
  badge.className = 'status-badge ' + level;
  badge.textContent = k.statusPKP.replace(/[🟢🟡🔴⛔]/g, '').trim();
}

/* ===================== Charts ===================== */
const CHART_INK = '#9AA3A8', CHART_GRID = 'rgba(255,255,255,.06)';
if (typeof Chart !== 'undefined') { Chart.defaults.font.family = "'IBM Plex Mono', monospace"; Chart.defaults.color = CHART_INK; }

function renderMonthlyChart(perMonth) {
  if (typeof Chart === 'undefined') return;
  const ctx = qs('#monthlyChart');
  if (CHARTS.monthly) CHARTS.monthly.destroy();
  CHARTS.monthly = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: perMonth.map((m) => m.bulan.replace(' ' + new Date().getFullYear(), '')),
      datasets: [
        { label: 'Omset', data: perMonth.map((m) => m.omset), backgroundColor: '#C69A52', borderRadius: 4, maxBarThickness: 34 },
        { label: 'Modal Kerja', data: perMonth.map((m) => m.modal), backgroundColor: '#3A4753', borderRadius: 4, maxBarThickness: 34 },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: (c) => c.dataset.label + ': ' + fmtRp(c.parsed.y) } } },
      scales: { x: { grid: { display: false } }, y: { grid: { color: CHART_GRID }, ticks: { callback: (v) => fmtRpShort(v) } } },
    },
  });
}

function renderClientChart(perClient) {
  if (typeof Chart === 'undefined') return;
  const ctx = qs('#clientChart');
  const top = perClient.slice(0, 7), rest = perClient.slice(7);
  const labels = top.map((c) => c.klien.replace('PT ', '').replace('PT. ', ''));
  const values = top.map((c) => c.omset);
  if (rest.length) { labels.push('Lainnya'); values.push(rest.reduce((a, c) => a + (c.omset || 0), 0)); }
  const palette = ['#C69A52', '#4F9D6E', '#D9A441', '#7C8F9E', '#8C723F', '#5B7A66', '#C25450', '#3A4753'];
  if (CHARTS.client) CHARTS.client.destroy();
  CHARTS.client = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: palette, borderColor: '#1B2126', borderWidth: 2 }] },
    options: { responsive: true, cutout: '62%', plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 10.5 }, color: CHART_INK } }, tooltip: { callbacks: { label: (c) => c.label + ': ' + fmtRp(c.parsed) } } } },
  });
}

/** Tabulasi Omset per Bulan — pelengkap chart batang, angka pasti untuk laporan/keputusan. */
function renderMonthlyTable(perMonth) {
  const body = qs('#monthlyBody');
  if (!body) return;
  const rows = [...perMonth].reverse(); // terbaru di atas
  body.innerHTML = rows.map((m) => `
    <tr>
      <td class="wrap">${m.bulan}</td>
      <td>${fmtRp(m.omset)}</td>
      <td>${fmtRp(m.modal)}</td>
      <td>${fmtRp(m.labaKotor)}</td>
      <td>${fmtPct(m.margin)}</td>
      <td>${m.jumlahProyek}</td>
    </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--ink-faint);padding:20px">Belum ada data.</td></tr>';
}

/**
 * Tabulasi Kontribusi Klien — plus catatan konsentrasi otomatis: kalau 1 klien menyumbang
 * porsi omset terlalu besar, itu risiko yang layak diketahui untuk keputusan (diversifikasi
 * klien, negosiasi kontrak, dsb), bukan cuma angka mentah.
 */
function renderClientTable(perClient) {
  const body = qs('#clientBody');
  const note = qs('#clientConcentrationNote');
  if (!body) return;
  body.innerHTML = perClient.map((c) => `
    <tr>
      <td class="wrap">${esc(c.klien)}</td>
      <td>${fmtRp(c.omset)}</td>
      <td>${c.jumlahProyek}</td>
      <td>${fmtPct(c.kontribusi)}</td>
    </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--ink-faint);padding:20px">Belum ada data.</td></tr>';

  if (!note) return;
  if (!perClient.length) { note.textContent = ''; return; }
  const top = perClient[0];
  if (top.kontribusi >= 0.4) {
    note.innerHTML = `⚠ <b>${esc(top.klien)}</b> menyumbang ${fmtPct(top.kontribusi)} dari total omset — konsentrasi tinggi pada satu klien, pertimbangkan diversifikasi klien untuk mengurangi risiko.`;
  } else if (perClient.length >= 3 && (perClient[0].kontribusi + perClient[1].kontribusi + perClient[2].kontribusi) >= 0.6) {
    note.textContent = '3 klien teratas menyumbang lebih dari 60% omset — cukup terkonsentrasi, layak dipantau.';
  } else {
    note.textContent = 'Distribusi omset antar klien relatif tersebar, tidak bergantung pada satu klien dominan.';
  }
}

/* ===================== Target progress ===================== */
function renderTargetProgress(k) {
  const rows = [
    { label: 'Target T1 (Konservatif)', target: SETTINGS.targetT1, value: k.totalOmset },
    { label: 'Target T2 (Optimistik)', target: SETTINGS.targetT2, value: k.totalOmset },
  ];
  qs('#targetProgress').innerHTML = rows.map((r) => {
    const pct = r.target > 0 ? Math.max(0, Math.min(1, r.value / r.target)) : 0;
    const ok = pct >= 1;
    return `<div class="target-row">
      <div class="t-label">${r.label}</div>
      <div class="t-track"><div class="t-fill ${ok ? 'ok' : ''}" style="width:${(pct*100).toFixed(1)}%"></div></div>
      <div class="t-pct">${fmtPct(pct)}</div>
      <div class="t-status">${fmtRpShort(r.target)}</div>
    </div>`;
  }).join('');

  const monthly = C.computeTargetMonthly(COMPUTED, SETTINGS);
  qs('#targetMonthlyBody').innerHTML = monthly.map((m) => `
    <tr>
      <td class="wrap">${m.bulan}</td>
      <td>${fmtRpShort(m.realisasi)}</td>
      <td>${fmtRpShort(m.targetT1)}</td>
      <td>${statusBadge(m.statusT1)}</td>
      <td>${fmtRpShort(m.targetT2)}</td>
      <td>${statusBadge(m.statusT2)}</td>
    </tr>`).join('');
}
function statusBadge(v) {
  if (v === null) return '<span class="badge">—</span>';
  return v ? '<span class="badge ok">TERCAPAI</span>' : '<span class="badge warn">BELUM</span>';
}

/* ===================== Investor ===================== */
function renderInvestors(list) {
  qs('#investorGrid').innerHTML = list.map((inv) => `
    <div class="panel investor-card">
      <div class="iname">${esc(inv.investor)}</div>
      <div class="irow"><span>Omset</span><b>${fmtRpShort(inv.omset)}</b></div>
      <div class="irow"><span>Bagi Hasil 30%</span><b>${fmtRpShort(inv.bagiHasil)}</b></div>
      <div class="irow"><span>Jumlah Proyek</span><b>${inv.jumlahProyek}</b></div>
    </div>`).join('') || '<p class="section-note">Belum ada data.</p>';

  const rows = COMPUTED.filter((p) => p.tanggalTransfer).map((p) => {
    const status = C.computeProgressStatus(p);
    const sudahTagih = !!(p.progress || {}).penagihan;
    return { ...p, status, statusRank: STATUS_RANK[status.level] ?? 0, tagihanRank: sudahTagih ? 1 : 0 };
  });
  rows.sort((a, b) => {
    let va = a[INVESTOR_SORT.key], vb = b[INVESTOR_SORT.key];
    if (INVESTOR_SORT.key === 'tanggalTransfer') { va = C.toDate(va)?.getTime() || 0; vb = C.toDate(vb)?.getTime() || 0; }
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return INVESTOR_SORT.dir === 'asc' ? -1 : 1;
    if (va > vb) return INVESTOR_SORT.dir === 'asc' ? 1 : -1;
    return 0;
  });
  qs('#progressBody').innerHTML = rows.map((p) => {
    const sudahTagih = !!(p.progress || {}).penagihan;
    const isCritical = p.status.level === 'critical';
    const rowClass = [p.feeCB > 0 ? 'row-cashback' : '', isCritical ? 'row-critical' : ''].filter(Boolean).join(' ');
    const rowTitle = isCritical
      ? `Bermasalah: belum lunas ${p.status.days} hari sejak dana masuk` + (p.feeCB > 0 ? ` | Fee CB: ${fmtRp(p.feeCB)}` : '')
      : (p.feeCB > 0 ? 'Fee CB (cashback): ' + fmtRp(p.feeCB) : '');
    return `
    <tr class="${rowClass}" title="${rowTitle}">
      <td class="wrap">${esc(p.perusahaan)}${p.feeCB > 0 ? ' <span class="badge cashback">💰</span>' : ''}</td>
      <td class="wrap">${esc(p.investor)}</td>
      <td>${fmtDate(p.tanggalTransfer)}</td>
      <td>${fmtRp(p.modalKerja)}</td>
      <td>${fmtRp(p.nilaiKontrak)}</td>
      <td>${fmtRp(p.keuntunganBersih)}</td>
      <td>${fmtRp(p.bagiHasil30)}</td>
      <td>${fmtRp(p.totalPengembalian)}</td>
      <td><span class="badge ${p.status.level}">${p.status.dot} ${p.status.label}</span></td>
      <td><span class="badge ${sudahTagih ? 'ok' : 'danger'}">${sudahTagih ? '🟢 Sudah Ditagih' : '🔴 Belum Tertagih'}</span></td>
      <td class="wrap">${esc(p.keterangan) || '—'}</td>
      <td class="wrap">${esc(p.kendala) || '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="12" style="text-align:center;color:var(--ink-faint);padding:20px">Belum ada data.</td></tr>';

  // Baris TOTAL KESELURUHAN di footer tabel — meniru baris total di file Excel.
  qs('#totalModalKerja').textContent = fmtRp(rows.reduce((a, p) => a + (p.modalKerja || 0), 0));
  qs('#totalNilaiKontrak').textContent = fmtRp(rows.reduce((a, p) => a + (p.nilaiKontrak || 0), 0));
  qs('#totalKeuntunganBersih').textContent = fmtRp(rows.reduce((a, p) => a + (p.keuntunganBersih || 0), 0));
  qs('#totalBagiHasil').textContent = fmtRp(rows.reduce((a, p) => a + (p.bagiHasil30 || 0), 0));
  qs('#totalKembaliInvestor').textContent = fmtRp(rows.reduce((a, p) => a + (p.totalPengembalian || 0), 0));

  // Baris ringkasan jumlah proyek per status — meniru baris "X proyek baru masuk,
  // Y dalam pengerjaan, ..." di file Excel, mengikuti tingkatan status yang sama
  // dengan yang dipakai untuk sort kolom Status.
  const STATUS_SUMMARY_LABELS = [
    ['ok', '🟢 Dana Baru Masuk'], ['warn', '🟡 Dalam Pengerjaan'], ['danger', '🔴 Perlu Percepatan'],
    ['overdue', '🟣 Sudah Jatuh Tempo'], ['critical', '⚫ Bermasalah (>4 Bulan)'],
    ['info', '🔵 Lunas'], ['neutral', '⚪ Belum Ada Dana'],
  ];
  const statusCounts = { ok: 0, warn: 0, danger: 0, overdue: 0, critical: 0, info: 0, neutral: 0 };
  rows.forEach((p) => { if (statusCounts[p.status.level] !== undefined) statusCounts[p.status.level] += 1; });
  qs('#statusSummaryRow').innerHTML = STATUS_SUMMARY_LABELS
    .map(([level, label]) => `<span class="status-count-item">${label}: <b>${statusCounts[level]}</b></span>`)
    .join('');

  const belumTertagih = rows.filter((p) => !(p.progress || {}).penagihan);
  const totalBelumTertagih = belumTertagih.reduce((a, p) => a + (p.nilaiKontrak || 0), 0);
  qs('#belumTertagihCount').textContent = belumTertagih.length;
  qs('#belumTertagihTotal').textContent = fmtRp(totalBelumTertagih);

  const bermasalah = C.computeBermasalahByClient(COMPUTED);
  qs('#bermasalahCount').textContent = bermasalah.reduce((a, e) => a + e.jumlahProyek, 0);
  qs('#bermasalahTotal').textContent = fmtRp(bermasalah.reduce((a, e) => a + e.totalNilaiKontrak, 0));
  qs('#bermasalahList').innerHTML = bermasalah.length
    ? bermasalah.map((e) => `
      <div class="bermasalah-row">
        <span class="b-name">⚫ ${esc(e.perusahaan)}</span>
        <span class="b-meta">${e.jumlahProyek} proyek · ${fmtRp(e.totalNilaiKontrak)} · maks ${e.maxHari} hari belum lunas</span>
      </div>`).join('')
    : '<p class="section-note">Tidak ada perusahaan dengan pembayaran macet &gt;4 bulan saat ini.</p>';
}

/* ===================== Component cost ===================== */
function renderComponentCost(avg) {
  qs('#avgPersonil').textContent = avg.avgPersonil.toLocaleString('id-ID', { maximumFractionDigits: 2 }) + '%';
  qs('#avgDokumen').textContent = avg.avgDokumen.toLocaleString('id-ID', { maximumFractionDigits: 2 }) + '%';
  qs('#avgOperasional').textContent = avg.avgOperasional.toLocaleString('id-ID', { maximumFractionDigits: 2 }) + '%';

  if (typeof Chart !== 'undefined') {
    const ctx = qs('#costChart');
    if (CHARTS.cost) CHARTS.cost.destroy();
    CHARTS.cost = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['Biaya Personil', 'Dokumen/Sertifikat', 'Operasional', 'Margin'],
        datasets: [{
          data: [avg.avgPersonil, avg.avgDokumen, avg.avgOperasional, Math.max(0, 100 - avg.avgPersonil - avg.avgDokumen - avg.avgOperasional)],
          backgroundColor: ['#C69A52', '#D9A441', '#7C8F9E', '#4F9D6E'], borderRadius: 4,
        }],
      },
      options: {
        indexAxis: 'y', responsive: true,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.parsed.x.toFixed(1) + '%' } } },
        scales: { x: { grid: { color: CHART_GRID }, ticks: { callback: (v) => v + '%' } }, y: { grid: { display: false } } },
      },
    });
  }

  const tbody = qs('#costBody');
  tbody.innerHTML = avg.rows.map((r) => `
    <tr>
      <td class="wrap">${esc(r.perusahaan)}</td>
      <td>${fmtRp(r.nilaiKontrak)}</td>
      <td>${r.pctPersonil.toFixed(1)}%</td>
      <td>${r.pctDokumen.toFixed(1)}%</td>
      <td>${r.pctOperasional.toFixed(1)}%</td>
      <td>${r.pctTotal.toFixed(1)}%</td>
    </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--ink-faint);padding:20px">Belum ada data komponen biaya.</td></tr>';
}

/* ===================== Projects table ===================== */
function populateFilterOptions() {
  const sel = qs('#filterInvestor');
  const current = sel.value;
  const investors = Array.from(new Set(RAW_PROJECTS.map((p) => p.investor).filter(Boolean))).sort();
  sel.innerHTML = '<option value="">Semua Investor</option>' + investors.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`).join('');
  sel.value = current || '';
}

function applyTableFilters() {
  const q = qs('#searchInput').value.trim().toLowerCase();
  const inv = qs('#filterInvestor').value;
  let rows = COMPUTED.filter((p) => {
    const matchesQ = !q || (p.perusahaan || '').toLowerCase().includes(q) || String(p.noPO).toLowerCase().includes(q) || (p.jenisPekerjaan || '').toLowerCase().includes(q);
    const matchesInv = !inv || p.investor === inv;
    return matchesQ && matchesInv;
  });
  rows.sort((a, b) => {
    let va = a[TABLE_SORT.key], vb = b[TABLE_SORT.key];
    if (TABLE_SORT.key === 'tanggalTransfer' || TABLE_SORT.key === 'tanggalPO') {
      va = C.toDate(va)?.getTime() || 0; vb = C.toDate(vb)?.getTime() || 0;
    }
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return TABLE_SORT.dir === 'asc' ? -1 : 1;
    if (va > vb) return TABLE_SORT.dir === 'asc' ? 1 : -1;
    return 0;
  });
  qs('#tableCount').textContent = rows.length + ' proyek';
  qs('#projectsBody').innerHTML = rows.map((p) => {
    const status = C.computeProgressStatus(p);
    const isCritical = status.level === 'critical';
    const rowClass = [p.feeCB > 0 ? 'row-cashback' : '', isCritical ? 'row-critical' : ''].filter(Boolean).join(' ');
    const rowTitle = isCritical
      ? `Bermasalah: belum lunas ${status.days} hari sejak dana masuk` + (p.feeCB > 0 ? ` | Fee CB: ${fmtRp(p.feeCB)}` : '')
      : (p.feeCB > 0 ? 'Fee CB (cashback): ' + fmtRp(p.feeCB) : '');
    return `
    <tr class="${rowClass}" title="${rowTitle}">
      <td>${fmtDate(p.tanggalTransfer)}</td>
      <td class="wrap">${esc(p.perusahaan)}${p.feeCB > 0 ? ' <span class="badge cashback">💰</span>' : ''}${isCritical ? ' <span class="badge critical">⚫ &gt;4 Bulan</span>' : ''}</td>
      <td class="wrap">${esc(p.jenisPekerjaan)}</td>
      <td>${fmtRp(p.nilaiKontrak)}</td>
      <td>${fmtRp(p.modalKerja)}</td>
      <td>${fmtRp(p.keuntunganNet)}</td>
      <td title="PPh: ${fmtRp(p.pphPerusahaan)} | PPN: ${fmtRp(p.ppnPerusahaan)}">${p.pajakPerusahaan ? fmtRp(p.pajakPerusahaan) : '—'}</td>
      <td class="wrap">${esc(p.investor)}</td>
      <td>${p.penawaranFile && p.penawaranFile.url
        ? `<a href="${esc(p.penawaranFile.url)}" target="_blank" rel="noopener" class="icon-btn" title="Buka ${esc(p.penawaranFile.label || 'Surat Penawaran')}">🔗</a>`
        : '<span style="color:var(--ink-faint)">—</span>'}</td>
      <td class="row-actions">
        <button class="icon-btn" data-edit="${p.id}" title="Ubah">✎</button>
        <button class="icon-btn danger" data-del="${p.id}" title="Hapus">🗑</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" style="text-align:center;color:var(--ink-faint);padding:24px">Tidak ada proyek yang cocok.</td></tr>';

  qsa('[data-edit]').forEach((btn) => btn.addEventListener('click', () => openForm(btn.dataset.edit)));
  qsa('[data-del]').forEach((btn) => btn.addEventListener('click', () => handleDelete(btn.dataset.del)));
}

function wireTableControls() {
  qs('#searchInput').addEventListener('input', applyTableFilters);
  qs('#filterInvestor').addEventListener('change', applyTableFilters);
  qsa('thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (TABLE_SORT.key === key) TABLE_SORT.dir = TABLE_SORT.dir === 'asc' ? 'desc' : 'asc';
      else { TABLE_SORT.key = key; TABLE_SORT.dir = 'desc'; }
      qsa('thead th[data-sort] .arrow').forEach((a) => (a.textContent = ''));
      qs('.arrow', th).textContent = TABLE_SORT.dir === 'asc' ? '↑' : '↓';
      applyTableFilters();
    });
  });
  qs('#addProjectBtn').addEventListener('click', () => openForm(null));
}

function wireInvestorTableSort() {
  qsa('#view-investor thead th[data-isort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.isort;
      if (INVESTOR_SORT.key === key) INVESTOR_SORT.dir = INVESTOR_SORT.dir === 'asc' ? 'desc' : 'asc';
      else { INVESTOR_SORT.key = key; INVESTOR_SORT.dir = 'desc'; }
      qsa('#view-investor thead th[data-isort] .arrow').forEach((a) => (a.textContent = ''));
      qs('.arrow', th).textContent = INVESTOR_SORT.dir === 'asc' ? '↑' : '↓';
      renderInvestors(C.groupByInvestor(COMPUTED));
    });
  });
}

async function handleDelete(id) {
  if (blockIfViewer()) return;
  const p = RAW_PROJECTS.find((x) => x.id === id);
  const name = p ? p.perusahaan + ' (' + p.noPO + ')' : id;
  if (!confirm('Hapus proyek "' + name + '"? Tindakan ini tidak bisa dibatalkan.')) return;
  try {
    await DB.deleteProject(id);
    toast('Proyek dihapus.', 'success');
  } catch (err) {
    toast('Gagal menghapus: ' + err.message, 'error');
  }
}

/* ===================== Add/Edit form ===================== */
function wireForm() {
  const investorList = qs('#investorOptions');
  investorList.innerHTML = KNOWN_INVESTORS.map((i) => `<option value="${esc(i)}">`).join('');
  const jobList = qs('#jobOptions');
  jobList.innerHTML = KNOWN_JOBS.map((j) => `<option value="${esc(j)}">`).join('');

  qs('#formCancelBtn').addEventListener('click', closeForm);
  qs('#formOverlay').addEventListener('click', (e) => { if (e.target.id === 'formOverlay') closeForm(); });
  wirePenawaranLink();

  const form = qs('#projectForm');
  const forecastFieldIds = ['f_modalKerja', 'f_biayaPersonil', 'f_biayaDokumen', 'f_biayaOperasional'];
  form.addEventListener('input', (e) => {
    if (forecastFieldIds.includes(e.target.id)) FORECAST_DIRTY.add(e.target.id);
    if (e.target.id === 'f_nilaiKontrak') applyForecast();
    updateLivePreview();
  });
  form.addEventListener('submit', handleFormSubmit);
}

/**
 * Isi otomatis Kebutuhan Modal Kerja + rincian Personil/Dokumen/Operasional begitu Nilai
 * Kontrak diisi pada proyek BARU, berdasarkan rata-rata historis (compute.js -
 * forecastComponentCost). Field yang sudah diubah manual oleh pengguna (FORECAST_DIRTY)
 * tidak akan ditimpa lagi.
 */
function applyForecast() {
  const hint = qs('#forecastHint');
  if (EDITING_ID) { hint.style.display = 'none'; return; } // jangan timpa data proyek yang sudah ada
  const nilaiKontrak = C.toNumber(qs('#f_nilaiKontrak').value);
  if (!(nilaiKontrak > 0)) { hint.style.display = 'none'; return; }

  const f = C.forecastComponentCost(nilaiKontrak, COMPUTED);
  if (!f.available) { hint.style.display = 'none'; return; }

  if (!FORECAST_DIRTY.has('f_biayaPersonil')) qs('#f_biayaPersonil').value = Math.round(f.personil);
  if (!FORECAST_DIRTY.has('f_biayaDokumen')) qs('#f_biayaDokumen').value = Math.round(f.dokumen);
  if (!FORECAST_DIRTY.has('f_biayaOperasional')) qs('#f_biayaOperasional').value = Math.round(f.operasional);
  if (!FORECAST_DIRTY.has('f_modalKerja')) qs('#f_modalKerja').value = Math.round(f.modalKerja);

  hint.style.display = 'block';
  hint.textContent = '🔮 Estimasi otomatis dari rata-rata ' + f.sampleSize + ' proyek historis ' +
    '(Personil ' + f.avgPersonil.toFixed(1) + '%, Dokumen ' + f.avgDokumen.toFixed(1) + '%, ' +
    'Operasional ' + f.avgOperasional.toFixed(1) + '% dari Nilai Kontrak) — silakan sesuaikan manual bila perlu.';
}

function openForm(id) {
  if (blockIfViewer()) return;
  EDITING_ID = id;
  const form = qs('#projectForm');
  form.reset();
  qsa('.field-error', form).forEach((el) => (el.textContent = ''));
  FORECAST_DIRTY = new Set();
  qs('#forecastHint').style.display = 'none';

  if (id) {
    const p = RAW_PROJECTS.find((x) => x.id === id);
    if (!p) { toast('Proyek tidak ditemukan (mungkin sudah dihapus dari device lain).', 'error'); return; }
    qs('#formTitle').textContent = 'Ubah Proyek';
    qs('#f_tanggalPO').value = toInputDate(p.tanggalPO);
    qs('#f_noPO').value = p.noPO || '';
    qs('#f_perusahaan').value = p.perusahaan || '';
    qs('#f_tanggalTransfer').value = toInputDate(p.tanggalTransfer);
    qs('#f_nilaiKontrak').value = p.nilaiKontrak || '';
    qs('#f_modalKerja').value = p.modalKerja || '';
    qs('#f_investor').value = p.investor || '';
    qs('#f_jenisPekerjaan').value = p.jenisPekerjaan || '';
    qs('#f_feeCB').value = p.feeCB || 0;
    qs('#f_pphPerusahaan').value = p.pphPerusahaan || 0;
    qs('#f_ppnPerusahaan').value = p.ppnPerusahaan || 0;
    qs('#f_biayaPersonil').value = p.biayaPersonil || '';
    qs('#f_biayaDokumen').value = p.biayaDokumen || '';
    qs('#f_biayaOperasional').value = p.biayaOperasional || '';
    qs('#f_keterangan').value = p.keterangan || '';
    qs('#f_kendala').value = p.kendala || '';
    const pr = p.progress || {};
    qs('#f_p_pengerjaan').checked = !!pr.pengerjaan;
    qs('#f_p_submit').checked = !!pr.submitDokumen;
    qs('#f_p_penagihan').checked = !!pr.penagihan;
    qs('#f_p_bayar').checked = !!pr.pembayaran;
    qs('#formDeleteBtn').style.display = 'inline-flex';
    renderPenawaranSection(p);
  } else {
    qs('#formTitle').textContent = 'Tambah Proyek Baru';
    qs('#f_feeCB').value = 0;
    qs('#f_pphPerusahaan').value = 0;
    qs('#f_ppnPerusahaan').value = 0;
    qs('#formDeleteBtn').style.display = 'none';
    qs('#penawaranEmptyNote').style.display = 'block';
    qs('#penawaranManager').style.display = 'none';
  }
  qs('#formDeleteBtn').onclick = () => { if (id) { closeForm(); handleDelete(id); } };

  updateLivePreview();
  qs('#formOverlay').style.display = 'flex';
  qs('#f_perusahaan').focus();
}

/** Tampilkan status link surat penawaran (ada/tidak) untuk proyek yang sedang diedit. */
function renderPenawaranSection(p) {
  qs('#penawaranEmptyNote').style.display = 'none';
  qs('#penawaranManager').style.display = 'block';
  qs('#penawaranError').textContent = '';
  qs('#penawaranUrlInput').value = '';
  qs('#penawaranLabelInput').value = '';
  const cur = qs('#penawaranCurrent');
  if (p.penawaranFile && p.penawaranFile.url) {
    cur.style.display = 'flex';
    qs('#penawaranDownloadLink').href = p.penawaranFile.url;
    qs('#penawaranFileName').textContent = p.penawaranFile.label || 'Buka Surat Penawaran';
  } else {
    cur.style.display = 'none';
  }
}

/** Surat penawaran disimpan sebagai LINK (mis. Google Drive), bukan file upload —
 *  Cloud Storage Firebase untuk project ini butuh paket Blaze (berbayar) yang belum
 *  diaktifkan, jadi pendekatan link ini tidak butuh upgrade apapun. */
function wirePenawaranLink() {
  qs('#penawaranSaveBtn').addEventListener('click', async () => {
    if (!EDITING_ID) return;
    const errEl = qs('#penawaranError');
    errEl.textContent = '';
    const url = qs('#penawaranUrlInput').value.trim();
    const label = qs('#penawaranLabelInput').value.trim();
    if (!url) { errEl.textContent = 'Isi link Google Drive-nya dulu.'; return; }
    if (!/^https?:\/\//i.test(url)) { errEl.textContent = 'Link harus diawali http:// atau https://'; return; }
    try {
      const meta = await DB.savePenawaranLink(EDITING_ID, url, label);
      qs('#penawaranCurrent').style.display = 'flex';
      qs('#penawaranDownloadLink').href = meta.url;
      qs('#penawaranFileName').textContent = meta.label || 'Buka Surat Penawaran';
      qs('#penawaranUrlInput').value = '';
      qs('#penawaranLabelInput').value = '';
      toast('Link surat penawaran disimpan.', 'success');
    } catch (err) {
      errEl.textContent = 'Gagal menyimpan: ' + err.message;
    }
  });

  qs('#penawaranDeleteBtn').addEventListener('click', async () => {
    if (!EDITING_ID) return;
    if (!confirm('Hapus link surat penawaran ini?')) return;
    try {
      await DB.removePenawaranLink(EDITING_ID);
      qs('#penawaranCurrent').style.display = 'none';
      toast('Link surat penawaran dihapus.', 'success');
    } catch (err) {
      toast('Gagal menghapus: ' + err.message, 'error');
    }
  });
}

function closeForm() {
  qs('#formOverlay').style.display = 'none';
  EDITING_ID = null;
}

function readFormValues() {
  return {
    tanggalPO: qs('#f_tanggalPO').value || null,
    noPO: qs('#f_noPO').value,
    perusahaan: qs('#f_perusahaan').value,
    tanggalTransfer: qs('#f_tanggalTransfer').value || null,
    nilaiKontrak: qs('#f_nilaiKontrak').value,
    modalKerja: qs('#f_modalKerja').value,
    investor: qs('#f_investor').value,
    jenisPekerjaan: qs('#f_jenisPekerjaan').value,
    feeCB: qs('#f_feeCB').value || 0,
    pphPerusahaan: qs('#f_pphPerusahaan').value || 0,
    ppnPerusahaan: qs('#f_ppnPerusahaan').value || 0,
    biayaPersonil: qs('#f_biayaPersonil').value || 0,
    biayaDokumen: qs('#f_biayaDokumen').value || 0,
    biayaOperasional: qs('#f_biayaOperasional').value || 0,
    keterangan: qs('#f_keterangan').value,
    kendala: qs('#f_kendala').value,
    progress: {
      pengerjaan: qs('#f_p_pengerjaan').checked,
      submitDokumen: qs('#f_p_submit').checked,
      penagihan: qs('#f_p_penagihan').checked,
      pembayaran: qs('#f_p_bayar').checked,
    },
  };
}

function updateLivePreview() {
  const values = readFormValues();
  const computed = C.computeProject(values, SETTINGS);
  qs('#previewKeuntungan').textContent = fmtRp(computed.keuntunganBersih);
  qs('#previewMargin').textContent = fmtPct(computed.margin);
  qs('#previewBagiHasil').textContent = fmtRp(computed.bagiHasil30);
  qs('#previewPPh').textContent = fmtRp(computed.pphFinal);
  qs('#previewNet').textContent = fmtRp(computed.keuntunganNet);
  qs('#previewPajakPerusahaan').textContent = fmtRp(computed.pajakPerusahaan);
  qs('#previewNetFinal').textContent = fmtRp(computed.keuntunganNetSetelahPajakPerusahaan);
  const hasilEl = qs('#previewHasil');
  hasilEl.textContent = computed.hasilKelayakan;
  hasilEl.className = computed.hasilKelayakan === 'Layak' ? 'badge ok' : 'badge warn';

  const { errors } = C.validateProject(values);
  qsa('.field-error', qs('#projectForm')).forEach((el) => (el.textContent = ''));
  Object.entries(errors).forEach(([field, msg]) => {
    const el = qs('#err_' + field);
    if (el) el.textContent = msg;
  });

  const dupEl = qs('#dupWarning');
  const noPO = values.noPO.trim();
  if (noPO) {
    const dup = RAW_PROJECTS.find((p) => p.noPO === noPO && p.id !== EDITING_ID);
    dupEl.textContent = dup ? `⚠ No PO "${noPO}" sudah dipakai di proyek "${dup.perusahaan}". Ini boleh saja jika memang batch/termin baru dari PO yang sama.` : '';
  } else {
    dupEl.textContent = '';
  }
}

async function handleFormSubmit(e) {
  e.preventDefault();
  if (blockIfViewer()) return;
  const values = readFormValues();
  const { valid, errors } = C.validateProject(values);
  if (!valid) {
    qsa('.field-error', qs('#projectForm')).forEach((el) => (el.textContent = ''));
    Object.entries(errors).forEach(([field, msg]) => {
      const el = qs('#err_' + field);
      if (el) el.textContent = msg;
    });
    toast('Periksa kembali isian yang bertanda merah.', 'error');
    return;
  }

  const btn = qs('#formSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Menyimpan…';
  try {
    if (EDITING_ID) {
      await DB.updateProject(EDITING_ID, values);
      toast('Proyek berhasil diperbarui.', 'success');
    } else {
      await DB.addProject(values);
      toast('Proyek baru berhasil disimpan.', 'success');
    }
    closeForm();
  } catch (err) {
    toast('Gagal menyimpan ke database: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan';
  }
}

/* ===================== Settings form ===================== */
function wireSettingsForm() {
  qs('#settingsBtn').addEventListener('click', () => {
    populateSettingsForm();
    qs('#settingsOverlay').style.display = 'flex';
  });
  qs('#settingsCancelBtn').addEventListener('click', () => { qs('#settingsOverlay').style.display = 'none'; });
  qs('#settingsOverlay').addEventListener('click', (e) => { if (e.target.id === 'settingsOverlay') qs('#settingsOverlay').style.display = 'none'; });
  qs('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (blockIfViewer()) return;
    const newSettings = {
      targetT1: Number(qs('#s_targetT1').value) || C.DEFAULT_SETTINGS.targetT1,
      targetT2: Number(qs('#s_targetT2').value) || C.DEFAULT_SETTINGS.targetT2,
      thresholdPKP: Number(qs('#s_thresholdPKP').value) || C.DEFAULT_SETTINGS.thresholdPKP,
      bagiHasilRate: (Number(qs('#s_bagiHasilRate').value) || 30) / 100,
      pphFinalRate: (Number(qs('#s_pphFinalRate').value) || 0.5) / 100,
      layakMinMargin: (Number(qs('#s_layakMinMargin').value) || 10) / 100,
    };
    const btn = qs('#settingsSubmitBtn');
    btn.disabled = true; btn.textContent = 'Menyimpan…';
    try {
      await DB.saveSettings(newSettings);
      toast('Pengaturan disimpan.', 'success');
      qs('#settingsOverlay').style.display = 'none';
    } catch (err) {
      toast('Gagal menyimpan pengaturan: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Simpan Pengaturan';
    }
  });
}
function populateSettingsForm() {
  qs('#s_targetT1').value = SETTINGS.targetT1;
  qs('#s_targetT2').value = SETTINGS.targetT2;
  qs('#s_thresholdPKP').value = SETTINGS.thresholdPKP;
  qs('#s_bagiHasilRate').value = (SETTINGS.bagiHasilRate * 100).toFixed(2);
  qs('#s_pphFinalRate').value = (SETTINGS.pphFinalRate * 100).toFixed(2);
  qs('#s_layakMinMargin').value = (SETTINGS.layakMinMargin * 100).toFixed(2);
}

/* ===================== Backup Excel ===================== */
/** Ekspor seluruh data yang sedang termuat (proyek + hasil hitung + rekap) ke satu file
 *  .xlsx multi-sheet — jaga-jaga kalau platform bermasalah (crash/bug), jaringan mati,
 *  atau listrik padam. Berjalan dari data yang sudah ada di memori (COMPUTED), jadi tetap
 *  bisa dipakai selama halaman sudah pernah dimuat sebelumnya, walau sedang offline. */
function wireBackupExport() {
  const btn = qs('#backupBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (typeof XLSX === 'undefined') {
      toast('Modul Excel belum termuat (perlu koneksi internet minimal sekali). Coba lagi.', 'error');
      return;
    }
    try {
      exportBackupToExcel();
      toast('Backup Excel berhasil diunduh.', 'success');
    } catch (err) {
      toast('Gagal membuat file backup: ' + err.message, 'error');
    }
  });
}

function exportBackupToExcel() {
  const wb = XLSX.utils.book_new();

  const proyekRows = COMPUTED.map((p) => ({
    'Tgl PO': fmtDate(p.tanggalPO),
    'No PO': p.noPO || '',
    'Perusahaan': p.perusahaan || '',
    'Jenis Pekerjaan': p.jenisPekerjaan || '',
    'Investor': p.investor || '',
    'Tgl Transfer': fmtDate(p.tanggalTransfer),
    'Nilai Kontrak': p.nilaiKontrak || 0,
    'Modal Kerja': p.modalKerja || 0,
    'Keuntungan Bersih': p.keuntunganBersih || 0,
    'Bagi Hasil 30%': p.bagiHasil30 || 0,
    'Total Kembali ke Investor': p.totalPengembalian || 0,
    'PPh Final (Dacin)': p.pphFinal || 0,
    'Fee CB': p.feeCB || 0,
    'Keuntungan Net': p.keuntunganNet || 0,
    'PPh Dibebankan Perusahaan': p.pphPerusahaan || 0,
    'PPN Dibebankan Perusahaan': p.ppnPerusahaan || 0,
    'Net Setelah Pajak Perusahaan': p.keuntunganNetSetelahPajakPerusahaan || 0,
    'Margin': p.margin ? (p.margin * 100).toFixed(1) + '%' : '0%',
    'Status Kelayakan': p.hasilKelayakan || '',
    'Pengerjaan': p.progress?.pengerjaan ? 'Ya' : 'Belum',
    'Submit Dokumen': p.progress?.submitDokumen ? 'Ya' : 'Belum',
    'Penagihan': p.progress?.penagihan ? 'Sudah Ditagih' : 'Belum Tertagih',
    'Pembayaran (Lunas)': p.progress?.pembayaran ? 'Lunas' : 'Belum',
    'Status Progres Dana': p.tanggalTransfer ? C.computeProgressStatus(p).label : '',
    'Keterangan': p.keterangan || '',
    'Kendala': p.kendala || '',
    'Link Surat Penawaran': (p.penawaranFile && p.penawaranFile.url) || '',
  }));
  const wsProyek = XLSX.utils.json_to_sheet(proyekRows);
  XLSX.utils.book_append_sheet(wb, wsProyek, 'Proyek');

  const investorRows = C.groupByInvestor(COMPUTED).map((inv) => ({
    'Investor': inv.investor,
    'Omset': inv.omset,
    'Modal Kerja': inv.modalKerja,
    'Bagi Hasil 30%': inv.bagiHasil,
    'Jumlah Proyek': inv.jumlahProyek,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(investorRows), 'Investor');

  const belumTertagih = COMPUTED.filter((p) => p.tanggalTransfer && !(p.progress || {}).penagihan);
  const progresRows = COMPUTED.filter((p) => p.tanggalTransfer).map((p) => ({
    'Perusahaan': p.perusahaan || '',
    'Investor': p.investor || '',
    'Tgl Transfer': fmtDate(p.tanggalTransfer),
    'Modal Kerja': p.modalKerja || 0,
    'Nilai Kontrak': p.nilaiKontrak || 0,
    'Keuntungan Bersih': p.keuntunganBersih || 0,
    'Bagi Hasil 30%': p.bagiHasil30 || 0,
    'Total Kembali ke Investor': p.totalPengembalian || 0,
    'Status': C.computeProgressStatus(p).label,
    'Status Tagihan': (p.progress || {}).penagihan ? 'Sudah Ditagih' : 'Belum Tertagih',
    'Keterangan': p.keterangan || '',
    'Kendala': p.kendala || '',
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(progresRows), 'Progres Dana');

  const ringkasanTagihan = [{
    'Jumlah Proyek Belum Tertagih': belumTertagih.length,
    'Akumulasi Nilai Belum Tertagih': belumTertagih.reduce((a, p) => a + (p.nilaiKontrak || 0), 0),
  }];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ringkasanTagihan), 'Ringkasan Tagihan');

  const monthlyRows = C.groupByMonth(COMPUTED).map((m) => ({
    'Bulan': m.bulan,
    'Omset': m.omset,
    'Modal Kerja': m.modal,
    'Laba Kotor': m.labaKotor,
    'Margin': (m.margin * 100).toFixed(1) + '%',
    'Jumlah Proyek': m.jumlahProyek,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(monthlyRows), 'Omset Bulanan');

  const clientRows = C.groupByClient(COMPUTED).map((c) => ({
    'Klien': c.klien,
    'Omset': c.omset,
    'Jumlah Proyek': c.jumlahProyek,
    'Kontribusi': (c.kontribusi * 100).toFixed(1) + '%',
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(clientRows), 'Omset per Klien');

  const today = new Date();
  const stamp = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  XLSX.writeFile(wb, `Dacin-Mas-Backup-${stamp}.xlsx`);
}

/* ===================== Install prompt (Android/desktop + iOS) ===================== */
function wireInstall() {
  const btn = qs('#installBtn');
  let deferredPrompt = null;

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;

  if (isStandalone) return; // sudah terinstal, tidak perlu tombol apapun

  if (isIOS) {
    // Safari iOS tidak pernah mengirim 'beforeinstallprompt' — satu-satunya cara
    // instal adalah manual lewat menu Share bawaan Safari. Tombol Instal di sini
    // tidak memicu instal langsung, cuma membuka panduan langkah-langkahnya.
    btn.style.display = 'inline-flex';
    const overlay = qs('#iosInstallOverlay');
    const openHint = () => { overlay.style.display = 'flex'; };
    const closeHint = () => { overlay.style.display = 'none'; };
    btn.addEventListener('click', openHint);
    qs('#iosInstallCloseBtn').addEventListener('click', closeHint);
    qs('#iosInstallCloseBtn2').addEventListener('click', closeHint);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeHint(); });
    return;
  }

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; btn.style.display = 'inline-flex'; });
  btn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    btn.style.display = 'none';
  });
  window.addEventListener('appinstalled', () => { btn.style.display = 'none'; });
}
