# Backend Autentikasi SpeakUp

## 1. Menjalankan Lokal

Perlu Node.js 22.13 atau lebih baru. Salin `.env.example` menjadi `.env`, isi `GOOGLE_APPS_SCRIPT_URL`, lalu jalankan:

```powershell
npm install
npm start
```

Buka `http://localhost:3000`.

## 2. Database Google Sheets dengan Google Apps Script (`code.gs`)

1. Buat atau buka Google Spreadsheet untuk database SpeakUp.
2. Klik menu **Extensions (Ekstensi) - Apps Script**.
3. Hapus kode bawaan di editor, lalu salin dan tempel seluruh kode dari file [`code.gs`](./code.gs).
4. Klik tombol **Run (Jalankan)** pada fungsi `setupSheets` sekali untuk otomatis membuat tab `users` dan `sessions` beserta baris header-nya.
5. Klik **Deploy - New deployment**:
   - **Select type**: **Web app**
   - **Execute as**: **Me**
   - **Who has access**: **Anyone**
   - Klik **Deploy**, lalu salin **Web app URL** (`https://script.google.com/macros/s/.../exec`).
6. Masukkan URL tersebut ke file `.env` (atau **Environment Variables** di Vercel):

```env
NODE_ENV=development
PORT=3000
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/XXXX/exec
```

## 3. Format Kolom Spreadsheet

Tab `users` (baris pertama `A1:M1`):

```text
id, name, email, phone, password_hash, education, level, reminder_time, mic_permission, privacy_agreed, parental_agreed, onboarding_complete, created_at
```

Tab `sessions` (baris pertama `A1:C1`):

```text
session_hash, user_id, expires_at
```

## 4. Konfigurasi Login Google

Login Google tidak bisa dibuat terbuka hanya dari kode aplikasi. Google harus mengetahui setiap origin yang diizinkan pada OAuth Client ID.

Di Google Cloud Console → **APIs & Services → Credentials**, buka OAuth Client ID tipe **Web application**, lalu tambahkan pada **Authorized JavaScript origins**:

```text
http://localhost:3000
http://127.0.0.1:3000
```

Tambahkan juga origin produksi tanpa path, misalnya:

```text
https://speakup.example.com
```

Set `GOOGLE_CLIENT_ID` ke Client ID yang sama pada server. Setelah mengubah `.env`, restart server. Pengguna harus membuka aplikasi melalui origin yang didaftarkan; `file://`, Live Server port berbeda, dan URL dengan port berbeda akan tetap menghasilkan `origin_mismatch`.

Semua akun Google yang valid dapat login setelah origin tersebut terdaftar. Tidak perlu mendaftarkan email pengguna satu per satu.

## 5. Endpoint API Autentikasi

- `POST /api/auth/register` - Membuat akun dari nama, email atau nomor HP, kata sandi, dan jenjang.
- `POST /api/auth/login` - Masuk dengan email/nomor HP dan kata sandi.
- `POST /api/auth/google` - Masuk atau daftar menggunakan identitas Google.
- `POST /api/auth/forgot-password` - Mengirim permintaan tautan atur ulang kata sandi.
- `GET /api/auth/me` - Memulihkan sesi dari cookie HttpOnly.
- `PUT /api/auth/profile` - Menyimpan pilihan persetujuan, level, dan waktu pengingat.
- `POST /api/auth/logout` - Mengakhiri sesi.
