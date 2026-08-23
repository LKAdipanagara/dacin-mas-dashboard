// firebase-config.js
//
// GANTI nilai di bawah ini dengan konfigurasi project Firebase Anda sendiri.
// Cara mendapatkannya: buka console.firebase.google.com -> pilih project Anda
// -> klik ikon gerigi (⚙) di pojok kiri atas -> "Project settings" -> scroll ke
// bawah ke bagian "Your apps" -> pilih app web (</>) -> config akan tampil di sana.
//
// File ini AMAN untuk diunggah ke GitHub (nilai di bawah bukan rahasia/password —
// keamanan data diatur lewat "Firestore Security Rules" & Firebase Authentication,
// bukan lewat menyembunyikan nilai-nilai ini).

export const firebaseConfig = {
  apiKey: "GANTI_DENGAN_API_KEY_ANDA",
  authDomain: "GANTI_DENGAN_PROJECT_ID.firebaseapp.com",
  projectId: "GANTI_DENGAN_PROJECT_ID",
  storageBucket: "GANTI_DENGAN_PROJECT_ID.appspot.com",
  messagingSenderId: "GANTI_DENGAN_SENDER_ID",
  appId: "GANTI_DENGAN_APP_ID",
};
