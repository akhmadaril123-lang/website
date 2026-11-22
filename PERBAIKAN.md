# Ringkasan Perbaikan Bug — SpeakUp

Tanggal: 2026-11-21. Semua perbaikan sudah diverifikasi dengan test suite (8/8 lulus) dan
script verifikasi end-to-end (19 pemeriksaan lulus: alur browser nyata + simulasi database
Google Sheets dengan banyak pengguna).

## 1. [KRITIS] Login Google bisa dipalsukan tanpa kredensial — DIPERBAIKI

**Sebelum:** endpoint `POST /api/auth/google` menerima `name` + `email` tanpa ID token.
Siapa pun bisa masuk sebagai email Google siapa pun (termasuk lewat form "Lanjutkan
dengan Akun Google Ini" di halaman depan). Verifikasi server dilompati total.

**Sesudah:**
- `server.js` — kredensial (ID token Google) kini **wajib**; token diverifikasi server
  (audience, issuer, kedaluwarsa, email terverifikasi) sebelum sesi dibuat. Tanpa
  kredensial → 401.
- `index.html` — form email manual dihapus. Satu-satunya jalur login Google adalah popup
  resmi Google Identity Services.
- Fallback `file://`/hosting statis juga wajib kredensial yang tervalidasi klaim-nya.

## 2. [KRITIS] Bisa login akun Google dengan mengetik `google-oauth` — DIPERBAIKI

**Sebelum:** di jalur fallback, kata sandi dibandingkan dengan `password_hash` secara
literal; akun Google dibuat dengan hash `google-oauth`, jadi siapa pun bisa masuk ke
akun Google mana pun dengan mengetik teks `google-oauth` sebagai kata sandi.

**Sesudah:** hanya hash `sha256$` yang diterima; akun Google diarahkan ke tombol
"Masuk dengan Google" dengan pesan yang jelas.

## 3. [BUG] Pengguna lama selalu dianggap "akun baru" saat login Google — DIPERBAIKI

**Sebelum:** keputusan "akun baru vs lama" diambil dari daftar akun di memori browser
(`state.accounts`) yang kosong setiap reload, sehingga pengguna lama selalu diminta
mengisi form "Buat Akun & Tautkan Google" setiap kali login.

**Sesudah:** kredensial langsung dikirim ke server; server menduplikasi berdasarkan
`google_sub` lalu email. Akun baru hanya diminta memilih jenjang (SMA/SMK) sekali,
pengguna lama langsung masuk ke beranda.

## 4. [BUG] Banyak pengguna di satu IP terblokir rate limit — DIPERBAIKI

**Sebelum:** 5 pendaftaran/jam dan 10 login/15 menit **per IP** — satu WiFi sekolah
memblokir siswa ke-6 pada jam pertama.

**Sesudah:** 60 pendaftaran/jam dan 30 login/15 menit per IP; brute force tetap
terkendali namun kelompok besar tidak lagi terblokir. Terverifikasi: pendaftaran ke-61
dari IP sama → 429.

## 5. [BUG] Login gagal acak karena timeout Apps Script 10 detik — DIPERBAIKI

**Sebelum:** cold start Google Apps Script sering lebih dari 10 detik → request dibatalkan
→ "Permintaan ke Google Apps Script gagal" tanpa alasan jelas.

**Sesudah:** timeout 30 detik (server & browser) + pesan ramah ketika timeout.

## 6. [BUG] `code.gs` lambat & rapuh saat sesi banyak — DIPERBAIKI

- Penghapusan baris kedaluwarsa (sessions / password_resets) kini **batch**
  (`deleteRows`) alih-alih satu per satu.
- `LockService.waitLock` dinaikkan 15 → 30 detik agar antrean login ramai tidak gagal.
- Body JSON tidak valid kini menghasilkan pesan error yang jelas, bukan stack error.

## 7. [BUG] Jalur fallback tidak lengkap — DIPERBAIKI

- `/api/auth/google/unlink` dan `/api/auth/reset-password` kini tersedia di fallback.
- `forgot-password` fallback membuat token reset nyata ke Sheets (token diambil dari
  halaman, karena `file://` tidak bisa mengirim email).
- Profil fallback kini juga menyimpan streak/newWords/weeklyProgress (sebelumnya hilang).

## 8. [RAPI] Pembersihan kecil

- Default nama `'Sania'` sisa demo pada registrasi dihapus.
- Nama akun Google tanpa `name` (klaim JWT) kini di-fallback ke awalan email.
- `BACKEND.md` ditulis ulang: langkah deploy Vercel, pendaftaran origin di Google Cloud
  Console (penyebab paling umum error `origin_mismatch`), catatan kapasitas Sheets.

## Cara memastikan login Google jalan di deployment Anda

1. Deploy repo ini ke Vercel; set env `GOOGLE_APPS_SCRIPT_URL` (URL Web App dari
   Spreadsheet + `code.gs`).
2. Di Google Cloud Console → Credentials → OAuth Client ID (Web application), tambahkan
   **Authorized JavaScript origins**: `http://localhost:3000` dan domain Vercel Anda
   (tanpa garis miring di akhir).
3. `GOOGLE_CLIENT_ID` bisa dibiarkan default atau diganti Client ID Anda.

## Hasil verifikasi

- `npm test` — 8/8 lulus (termasuk 3 test baru: tanpa kredensial ditolak, kredensial
  valid membuat/menduplikasi/menautkan akun, token salah ditolak).
- Script verifikasi (19 cek): register/login/me/profile/logout, CSRF 403, rate limit 429,
  kredensial Google palsu ditolak, dua pengguna bersamaan di Sheets dengan sesi
  terisolasi, duplikat ditolak 409, taut/lepas Google, forgot+reset password.
