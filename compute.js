// compute.js — Semua rumus keuangan dalam SATU tempat.
// Prinsip: field turunan (keuntungan, bagi hasil, pajak, margin, dst) TIDAK PERNAH
// disimpan di database — selalu dihitung ulang dari field mentah. Ini menghilangkan
// seluruh kelas bug "data tidak sinkron" yang dulu terjadi di file Excel.

export const DEFAULT_SETTINGS = {
  bagiHasilRate: 0.30,      // 30%
  pphFinalRate: 0.005,      // 0,5% (PP No. 20/2026)
  thresholdPKP: 4800000000, // Rp 4,8 miliar
  targetT1: 1500000000,     // Rp 1,5 M/tahun (konservatif)
  targetT2: 2400000000,     // Rp 2,4 M/tahun (optimistik)
  layakMinMargin: 0.10,     // margin minimum 10% dianggap "Layak"
};

/**
 * Hitung semua field turunan dari satu proyek mentah.
 * @param {object} p - proyek mentah: {nilaiKontrak, modalKerja, feeCB}
 * @param {object} settings
 */
export function computeProject(p, settings = DEFAULT_SETTINGS) {
  const nilaiKontrak = toNumber(p.nilaiKontrak);
  const modalKerja = toNumber(p.modalKerja);
  const feeCB = toNumber(p.feeCB);
  // Beberapa perusahaan klien memotong/membebankan PPh & PPN sendiri saat membayar ke
  // Dacin (bukan pajak Dacin ke negara — lihat computeProject settings.pphFinalRate untuk
  // itu). Nilainya berbeda-beda per proyek/klien, jadi diisi manual per proyek, bukan
  // dihitung otomatis dari satu tarif tetap (menghindari mengarang angka/regulasi).
  const pphPerusahaan = toNumber(p.pphPerusahaan);
  const ppnPerusahaan = toNumber(p.ppnPerusahaan);
  const pajakPerusahaan = pphPerusahaan + ppnPerusahaan;

  const keuntunganBersih = nilaiKontrak - modalKerja;
  const bagiHasil30 = keuntunganBersih * settings.bagiHasilRate;
  const totalPengembalian = modalKerja + bagiHasil30;
  const pphFinal = nilaiKontrak * settings.pphFinalRate;
  const keuntunganSetelahBHPajak = keuntunganBersih - bagiHasil30 - pphFinal;
  const keuntunganNet = keuntunganSetelahBHPajak - feeCB;
  const keuntunganNetSetelahPajakPerusahaan = keuntunganNet - pajakPerusahaan;
  const margin = nilaiKontrak > 0 ? keuntunganBersih / nilaiKontrak : 0;
  const hasilKelayakan = margin >= settings.layakMinMargin ? 'Layak' : 'Tidak Layak';

  return {
    nilaiKontrak, modalKerja, feeCB, pphPerusahaan, ppnPerusahaan, pajakPerusahaan,
    keuntunganNetSetelahPajakPerusahaan,
    keuntunganBersih, bagiHasil30, totalPengembalian, pphFinal,
    keuntunganSetelahBHPajak, keuntunganNet, margin, hasilKelayakan,
  };
}

/** Gabungkan array proyek + hasil hitung masing-masing. */
export function computeAll(projects, settings = DEFAULT_SETTINGS) {
  return projects.map((p) => ({ ...p, ...computeProject(p, settings) }));
}

/** Ringkasan KPI dari daftar proyek yang sudah dihitung (computeAll). */
export function computeKPI(computedProjects, settings = DEFAULT_SETTINGS) {
  const withTransfer = computedProjects.filter((p) => p.tanggalTransfer);
  const sum = (key) => withTransfer.reduce((a, p) => a + (p[key] || 0), 0);

  const totalOmset = sum('nilaiKontrak');
  const totalModal = sum('modalKerja');
  const totalKeuntunganBersih = sum('keuntunganBersih');
  const totalBagiHasil = sum('bagiHasil30');
  const totalPPhFinal = sum('pphFinal');
  const totalFeeCB = sum('feeCB');
  const keuntunganBersihNet = sum('keuntunganNet');
  const totalProyek = withTransfer.length;

  const sisaThreshold = settings.thresholdPKP - totalOmset;
  let statusPKP = '🟢 AMAN – PPh Final 0,5% Berlaku';
  if (sisaThreshold < 0) statusPKP = '⛔ WAJIB PPh Normal – Melewati Threshold PKP';
  else if (sisaThreshold < 500000000) statusPKP = '🔴 HAMPIR BATAS (<Rp500Jt)';
  else if (sisaThreshold < 1000000000) statusPKP = '🟡 PANTAU (<Rp1M)';

  return {
    totalProyek,
    totalOmset,
    totalModal,
    totalKeuntunganBersih,
    totalBagiHasil,
    totalPPhFinal,
    totalFeeCB,
    keuntunganBersihNet,
    grossMargin: totalOmset > 0 ? totalKeuntunganBersih / totalOmset : 0,
    netMargin: totalOmset > 0 ? keuntunganBersihNet / totalOmset : 0,
    rataRataKontrak: totalProyek > 0 ? totalOmset / totalProyek : 0,
    omsetYTD: totalOmset,
    thresholdPKP: settings.thresholdPKP,
    sisaThreshold,
    statusPKP,
  };
}

export function groupByClient(computedProjects) {
  const map = new Map();
  computedProjects.filter((p) => p.tanggalTransfer).forEach((p) => {
    const key = normalizeCompanyName(p.perusahaan);
    if (!map.has(key)) map.set(key, { klien: p.perusahaan, omset: 0, jumlahProyek: 0 });
    const e = map.get(key);
    e.omset += p.nilaiKontrak || 0;
    e.jumlahProyek += 1;
  });
  const total = Array.from(map.values()).reduce((a, e) => a + e.omset, 0);
  const list = Array.from(map.values()).map((e) => ({ ...e, kontribusi: total > 0 ? e.omset / total : 0 }));
  list.sort((a, b) => b.omset - a.omset);
  return list;
}

export function groupByMonth(computedProjects) {
  const map = new Map(); // key: "2026-04" -> {...}
  const monthNames = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  computedProjects.filter((p) => p.tanggalTransfer).forEach((p) => {
    const d = toDate(p.tanggalTransfer);
    if (!d) return;
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    if (!map.has(key)) {
      map.set(key, { key, bulan: monthNames[d.getMonth()] + ' ' + d.getFullYear(), year: d.getFullYear(), month: d.getMonth(), omset: 0, modal: 0, labaKotor: 0, jumlahProyek: 0 });
    }
    const e = map.get(key);
    e.omset += p.nilaiKontrak || 0;
    e.modal += p.modalKerja || 0;
    e.labaKotor += p.keuntunganBersih || 0;
    e.jumlahProyek += 1;
  });
  const list = Array.from(map.values()).map((e) => ({ ...e, margin: e.omset > 0 ? e.labaKotor / e.omset : 0 }));
  list.sort((a, b) => (a.year - b.year) || (a.month - b.month));
  return list;
}

export function groupByInvestor(computedProjects) {
  const map = new Map();
  computedProjects.filter((p) => p.tanggalTransfer).forEach((p) => {
    const key = p.investor || 'Belum Ditentukan';
    if (!map.has(key)) map.set(key, { investor: key, omset: 0, bagiHasil: 0, modalKerja: 0, jumlahProyek: 0 });
    const e = map.get(key);
    e.omset += p.nilaiKontrak || 0;
    e.bagiHasil += p.bagiHasil30 || 0;
    e.modalKerja += p.modalKerja || 0;
    e.jumlahProyek += 1;
  });
  const list = Array.from(map.values());
  list.sort((a, b) => b.omset - a.omset);
  return list;
}

export function computeTargetMonthly(computedProjects, settings = DEFAULT_SETTINGS, year = new Date().getFullYear()) {
  const byMonth = groupByMonth(computedProjects).filter((m) => m.year === year);
  const monthNames = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const t1 = settings.targetT1 / 12, t2 = settings.targetT2 / 12;
  return monthNames.map((nama, i) => {
    const found = byMonth.find((m) => m.month === i);
    const realisasi = found ? found.omset : 0;
    return {
      bulan: nama + ' ' + year,
      targetT1: t1, targetT2: t2, realisasi,
      statusT1: realisasi === 0 ? null : realisasi >= t1,
      statusT2: realisasi === 0 ? null : realisasi >= t2,
    };
  });
}

export function computeAverageComponentCost(computedProjects) {
  const rows = computedProjects.filter((p) =>
    p.nilaiKontrak > 0 && (toNumber(p.biayaPersonil) || toNumber(p.biayaDokumen) || toNumber(p.biayaOperasional))
  );
  if (!rows.length) return { rows: [], avgPersonil: 0, avgDokumen: 0, avgOperasional: 0 };
  const pct = rows.map((p) => {
    const personil = (toNumber(p.biayaPersonil) / p.nilaiKontrak) * 100;
    const dokumen = (toNumber(p.biayaDokumen) / p.nilaiKontrak) * 100;
    const operasional = (toNumber(p.biayaOperasional) / p.nilaiKontrak) * 100;
    return { ...p, pctPersonil: personil, pctDokumen: dokumen, pctOperasional: operasional, pctTotal: personil + dokumen + operasional };
  });
  const avg = (key) => pct.reduce((a, r) => a + r[key], 0) / pct.length;
  return {
    rows: pct,
    avgPersonil: avg('pctPersonil'),
    avgDokumen: avg('pctDokumen'),
    avgOperasional: avg('pctOperasional'),
  };
}

/**
 * Forecast kebutuhan modal kerja (personil/dokumen/operasional) untuk sebuah Nilai Kontrak
 * baru, berdasarkan rata-rata persentase historis (computeAverageComponentCost). Dipakai
 * di form "Tambah Proyek" supaya begitu Nilai Kontrak diisi, estimasi biaya langsung muncul.
 */
export function forecastComponentCost(nilaiKontrak, computedProjects) {
  const nk = toNumber(nilaiKontrak);
  const { avgPersonil, avgDokumen, avgOperasional, rows } = computeAverageComponentCost(computedProjects);
  if (!rows.length || !(nk > 0)) {
    return { available: false, personil: 0, dokumen: 0, operasional: 0, modalKerja: 0, sampleSize: rows.length };
  }
  const personil = nk * (avgPersonil / 100);
  const dokumen = nk * (avgDokumen / 100);
  const operasional = nk * (avgOperasional / 100);
  return {
    available: true,
    personil, dokumen, operasional,
    modalKerja: personil + dokumen + operasional,
    avgPersonil, avgDokumen, avgOperasional,
    sampleSize: rows.length,
  };
}

/**
 * Status dana investor per proyek — meniru persis skema warna & tenor 90 hari
 * (3 bulan) yang selama ini dipakai manual di file Excel pemantauan progres:
 *   BIRU  = selesai pekerjaan & dana sudah lunas dikembalikan ke investor
 *   HIJAU = dana baru masuk (0-30 hari sejak Tgl Transfer)
 *   KUNING = dalam pengerjaan, masih ada waktu (31-60 hari)
 *   MERAH = perlu percepatan, mendekati jatuh tempo (61-90 hari, belum lunas)
 *   UNGU  = sudah jatuh tempo / follow up urgent (>90 hari, belum lunas)
 *   ABU-ABU = belum ada dana masuk sama sekali (netral, belum berlaku status apapun)
 * Tenor 90 hari ini diturunkan dari pola tanggal transfer vs status yang sudah
 * ditandai manual oleh Lenggana di Excel (bukan angka bebas) — lihat riwayat proyek.
 */
export function computeProgressStatus(p) {
  const progress = p.progress || {};
  if (progress.pembayaran) return { label: 'Lunas - Dana Kembali ke Investor', level: 'info', dot: '🔵' };
  if (!p.tanggalTransfer) return { label: 'Belum Ada Dana', level: 'neutral', dot: '⚪' };
  const d = toDate(p.tanggalTransfer);
  if (!d) return { label: 'Cek Tanggal', level: 'warn', dot: '🟡' };
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 30) return { label: 'Dana Baru Masuk', level: 'ok', dot: '🟢' };
  if (days <= 60) return { label: 'Dalam Pengerjaan', level: 'warn', dot: '🟡' };
  if (days <= 90) return { label: 'Perlu Percepatan', level: 'danger', dot: '🔴' };
  return { label: 'Sudah Jatuh Tempo - Follow Up Urgent', level: 'overdue', dot: '🟣' };
}

/* ===================== Validation ===================== */
export function validateProject(p) {
  const errors = {};
  if (!p.perusahaan || String(p.perusahaan).trim().length < 2) {
    errors.perusahaan = 'Nama perusahaan wajib diisi (minimal 2 huruf).';
  }
  if (!p.noPO || String(p.noPO).trim().length === 0) {
    errors.noPO = 'No PO wajib diisi.';
  }
  const nilaiKontrak = toNumber(p.nilaiKontrak);
  if (!(nilaiKontrak > 0)) {
    errors.nilaiKontrak = 'Nilai kontrak harus lebih dari 0.';
  }
  const modalKerja = toNumber(p.modalKerja);
  if (modalKerja < 0) {
    errors.modalKerja = 'Kebutuhan modal kerja tidak boleh negatif.';
  }
  if (nilaiKontrak > 0 && modalKerja >= nilaiKontrak) {
    errors.modalKerja = 'Modal kerja lebih besar atau sama dengan nilai kontrak — keuntungan akan nol/negatif. Periksa kembali angkanya.';
  }
  if (!p.investor || String(p.investor).trim().length === 0) {
    errors.investor = 'Pilih atau isi sumber dana / investor.';
  }
  if (p.tanggalTransfer && p.tanggalPO) {
    const dPO = toDate(p.tanggalPO), dTransfer = toDate(p.tanggalTransfer);
    if (dPO && dTransfer && dTransfer < dPO) {
      errors.tanggalTransfer = 'Tanggal transfer lebih awal dari tanggal PO — periksa kembali.';
    }
  }
  const feeCB = toNumber(p.feeCB);
  if (feeCB < 0) errors.feeCB = 'Fee CB tidak boleh negatif.';
  if (toNumber(p.pphPerusahaan) < 0) errors.pphPerusahaan = 'PPh tidak boleh negatif.';
  if (toNumber(p.ppnPerusahaan) < 0) errors.ppnPerusahaan = 'PPN tidak boleh negatif.';

  return { valid: Object.keys(errors).length === 0, errors };
}

/* ===================== Helpers ===================== */
export function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
  return isFinite(n) ? n : 0;
}
export function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (v && typeof v.toDate === 'function') return v.toDate(); // Firestore Timestamp
  const d = new Date(v);
  return isNaN(d) ? null : d;
}
function normalizeCompanyName(name) {
  if (!name) return '';
  let n = name.trim().toUpperCase();
  // Gabungkan varian nama yang sama (mengikuti pola yang ditemukan di data lama)
  if (/^PT\.?\s*SINAR\s*MAS(\s*\(SMART\))?$/i.test(n) || /^PT\s*SINARMAS(\s*\(SMART\))?$/i.test(n)) return 'PT SINARMAS (INCL. SMART & SINAR MAS)';
  n = n.replace(/^PT\.\s*/, 'PT ');
  return n;
}
