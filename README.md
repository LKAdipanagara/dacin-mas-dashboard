# Dacin Mas — Panel Kendali Proyek (v2: input langsung + database)

Aplikasi pencatatan proyek CV Dacin Mas Calibration Services. Ganti total dari Excel:
tambah/ubah/hapus proyek langsung dari HP atau komputer, tersimpan di database
(Firebase Firestore), dan **otomatis sinkron real-time** ke semua device begitu
disimpan — tidak perlu kirim-kirim file lagi.

Semua laporan (Ringkasan, Omset, Target, Investor, Biaya) dihitung otomatis dari
SATU sumber data (koleksi `proyek`), sehingga tidak akan pernah ada lagi data yang
tidak sinkron antar laporan seperti dulu di Excel.

## Yang perlu disiapkan (sekali saja)

1. **Akun Firebase** (gratis, pakai akun Google) — untuk database & login.
2. Edit file **`firebase-config.js`** dengan kunci project Firebase Anda.
3. Tempel isi **`firestore.rules`** ke tab Rules di Firebase Console.
4. Buat 1+ akun login (email & password) lewat tab Authentication di Firebase Console.
5. Deploy folder ini ke Vercel (seperti sebelumnya).

Panduan lengkap langkah-demi-langkah ada di percakapan dengan Claude.

## Struktur data

Koleksi `proyek` — satu dokumen = satu proyek/kontrak. Field mentah yang disimpan:
`tanggalPO, noPO, perusahaan, tanggalTransfer, nilaiKontrak, modalKerja, investor,
jenisPekerjaan, feeCB, biayaPersonil, biayaDokumen, biayaOperasional, keterangan,
kendala, progress{pengerjaan,submitDokumen,penagihan,pembayaran}`.

Field turunan (keuntungan, margin, bagi hasil, pajak, dst) **tidak disimpan** —
selalu dihitung ulang di `compute.js` dari field mentah di atas. Ini prinsip
"satu sumber kebenaran" yang menghilangkan seluruh kelas bug sinkronisasi data.

Dokumen `settings/config` — target omzet tahunan (T1/T2), threshold PKP, persentase
bagi hasil & pajak. Bisa diubah lewat tombol ⚙ di aplikasi.

## Menambahkan pengguna baru

Firebase Console → Authentication → Users → Add user. Tidak ada halaman daftar
sendiri di dalam aplikasi (sengaja, supaya orang asing tidak bisa membuat akun).

## Data awal dari Excel

Saat koleksi `proyek` masih kosong, aplikasi menampilkan banner "Impor Data Awal"
yang akan mengisi 30 proyek dari catatan Excel sebelumnya (file `seed-data.js`).
Jalankan hanya sekali.

## Offline

Aplikasi tetap bisa dipakai tanpa internet (data tersimpan sementara di HP/komputer
dan otomatis terkirim begitu online lagi) berkat fitur offline bawaan Firestore.
