# Backend Autentikasi SpeakUp

Aplikasi SpeakUp dapat dijalankan dua cara:

1. **Server Node.js/Express** (lokal atau Vercel) — jalur utama untuk banyak pengguna.
2. **HTML langsung** (`file://` atau hosting statis seperti GitHub Pages) — fallback yang berbicara langsung ke Google Apps Script. Login Google hanya bekerja pada origin https yang terdaftar.

## 1. Menjalankan Lokal

Perlu Node.js 22.13 atau lebih baru. Salin `.env.example` menjadi `.env`, isi `GOOGLE_APPS_SCRIPT_URL`, lalu jalankan:

```bash
npm install
npm start
```

Buka `http://localhost:3000`.

Tanpa `GOOGLE_APPS_SCRIPT_URL`, server memakai SQLite lokal (`./data/speakup.sqlite`) — hanya untuk pengembangan.

## 2. Database Google Sheets dengan Google Apps Script (`code.gs`)

1. Buat atau buka Google Spreadsheet untuk database SpeakUp.
2. Klik menu **Extensions (Ekstensi) → Apps Script**.
3. Hapus kode bawaan di editor, lalu salin dan tempel seluruh kode dari file [`code.gs`](./code.gs).
4. Klik tombol **Run (Jalankan)** pada fungsi `setupSheets` sekali untuk membuat tab `users`, `sessions`, dan `password_resets` beserta baris header-nya.
5. Klik **Deploy → New deployment**:
   - **Select type**: **Web app**
   - **Execute as**: **Me**
   - **Who has access**: **Anyone**
   - Klik **Deploy**, lalu salin **Web app URL** (`https://script.google.com/macros/s/.../exec`).
6. Masukkan URL tersebut ke file `.env` (atau **Environment Variables** di Vercel):

```env
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/XXXX/exec
```

Header kolom baru ditambahkan otomatis saat request pertama, tanpa menghapus data lama.

### Catatan kapasitas (banyak pengguna)

- Setiap request diproses satu per satu (`LockService`) agar data di Sheets tidak rusak saat banyak orang login bersamaan.
- Tab `sessions` dibersihkan otomatis dari sesi kedaluwarsa setiap ada login baru; penghapusan dilakukan per blok baris agar cepat.
- Kuota Apps Script gratis (≈90 menit eksekusi/hari untuk akun pribadi) cukup untuk ratusan pengguna karena tiap request hanya butuh 1–2 detik. Jika kuota habis, gunakan akun Workspace atau tambah spreadsheet terpisah.

## 3. Format Kolom Spreadsheet

Tab `users`:

```text
id, name, email, phone, password_hash, education, level, reminder_time, mic_permission, privacy_agreed, parental_agreed, onboarding_complete, created_at, streak, new_words, weekly_progress, google_linked, google_email, google_sub
```

Tab `sessions`: `session_hash, user_id, expires_at`
Tab `password_resets`: `token_hash, user_id, expires_at, used_at, created_at`

## 4. Konfigurasi Login Google

Login Google **wajib melewati verifikasi server**: frontend memanggil popup Google (Google Identity Services), lalu ID token dikirim ke `POST /api/auth/google` untuk diverifikasi (audience, issuer, kedaluwarsa, email terverifikasi). Tidak ada lagi form "isi email manual" karena itu memungkinkan siapa pun masuk memakai email orang lain.

Agar popup Google berfungsi, setiap origin aplikasi harus didaftarkan di Google Cloud Console → **APIs & Services → Credentials** → OAuth Client ID tipe **Web application** → **Authorized JavaScript origins**:

```text
http://localhost:3000
http://127.0.0.1:3000
https://domain-aplikasi-anda.vercel.app
```

Set `GOOGLE_CLIENT_ID` ke Client ID yang sama pada server (atau biarkan memakai nilai bawaan di kode). Pengguna harus membuka aplikasi melalui origin yang didaftarkan; `file://`, port berbeda, atau domain yang belum didaftarkan menghasilkan `origin_mismatch`.

Semua akun Google yang valid dapat login setelah origin terdaftar. Akun baru langsung dibuat tanpa kata sandi; akun email/HP yang sudah ada dengan email sama otomatis ditautkan.

## 5. Deploy ke Vercel

1. **Import** repository ke Vercel (framework **Other**, tanpa build command).
2. Tambahkan **Environment Variables**:
   - `GOOGLE_APPS_SCRIPT_URL` — wajib (database Google Sheets).
   - `GOOGLE_CLIENT_ID` — opsional, jika memakai Client ID sendiri.
   - `APP_ORIGIN` — opsional, origin publik aplikasi untuk whitelist CSRF.
   - `GEMINI_API_KEY` — opsional, untuk terjemahan AI.
   - `RESEND_API_KEY` + `RESEND_FROM` — opsional, untuk email atur ulang sandi.
3. Deploy. `api/[...path].js` otomatis menjadi serverless API; `index.html` disajikan sebagai halaman utama.
4. Daftarkan domain Vercel hasil deploy ke **Authorized JavaScript origins** (langkah 4).
5. Jika `GOOGLE_APPS_SCRIPT_URL` lupa diisi, API akan gagal dengan pesan jelas di log Vercel.

Batas rate per IP sengaja longgar (30 login/15 menit, 60 pendaftaran/jam) karena pelajar satu sekolah biasa berbagi satu IP publik.

## 6. Endpoint API Autentikasi

- `POST /api/auth/register` - Membuat akun dari nama, email atau nomor HP, kata sandi, dan jenjang.
- `POST /api/auth/login` - Masuk dengan email/nomor HP dan kata sandi.
- `POST /api/auth/google` - Masuk/daftar dengan ID token Google (`credential`) yang diverifikasi server; token tanpa kredensial ditolak (401).
- `POST /api/auth/google/unlink` - Melepas tautan akun Google.
- `POST /api/auth/forgot-password` - Membuat tautan atur ulang kata sandi (dikirim via email bila Resend dikonfigurasi).
- `POST /api/auth/reset-password` - Menyimpan kata sandi baru dari token tautan.
- `GET /api/auth/me` - Memulihkan sesi dari cookie HttpOnly.
- `GET /api/config` - Memberi tahu frontend Client ID Google yang dipakai.
- `PUT /api/auth/profile` - Menyimpan persetujuan, level, jenjang, waktu pengingat, dan progres belajar.
- `POST /api/auth/logout` - Mengakhiri sesi.
- `POST /api/translate` - Terjemahan AI (butuh `GEMINI_API_KEY`; tanpa itu frontend memakai kamus offline).
