# Backend autentikasi SpeakUp

## Menjalankan lokal

Perlu Node.js 22.13 atau lebih baru. Salin `.env.example` menjadi `.env`, lalu jalankan:

```powershell
npm install
npm start
```

Buka `http://localhost:3000`. Tanpa konfigurasi Google Sheets, data akun dan sesi disimpan di `data/speakup.sqlite`; kata sandi disimpan sebagai hash scrypt. Jangan unggah `.env` atau database ke Git.

## Deploy ke Vercel dengan Google Sheets

Vercel menjalankan Express app dari `index.js`. Untuk memakai Google Sheets, siapkan Google Cloud service account, aktifkan Google Sheets API, lalu bagikan spreadsheet kepada email service account sebagai Editor. Jangan pernah meletakkan private key di HTML atau Git.

Buat spreadsheet dengan dua tab bernama `users` dan `sessions`. Baris pertama tab `users` harus berisi kolom berikut, persis berurutan. Masukkan setiap nama sebagai sel terpisah dari kolom A ke kanan:

```text
id, name, email, phone, password_hash, education, level, reminder_time, mic_permission, privacy_agreed, parental_agreed, onboarding_complete, created_at
```

Baris pertama tab `sessions`:

```text
session_hash, user_id, expires_at
```

Di Vercel, buka **Project Settings → Environment Variables** dan atur:

- `GOOGLE_SHEETS_SPREADSHEET_ID`: ID di antara `/d/` dan `/edit` pada URL spreadsheet.
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`: email service account.
- `GOOGLE_PRIVATE_KEY`: nilai `private_key` dari file JSON service account; simpan hanya sebagai environment variable rahasia.
- `NODE_ENV`: `production`.

Deploy ulang setelah mengatur variabel. Saat konfigurasi Google Sheets tersedia, aplikasi tidak memakai SQLite. `APP_ORIGIN` tidak wajib untuk deployment Vercel standar; aplikasi memeriksa origin berdasarkan host permintaan HTTPS. Tab spreadsheet hanya untuk penggunaan kecil; Google Sheets tidak menyediakan transaksi/keunikan atomik seperti database dan dapat mencapai batas API. Gunakan database terkelola untuk aplikasi dengan banyak pengguna.

## API autentikasi

- `POST /api/auth/register` - membuat akun dari nama, email atau nomor HP, kata sandi, dan jenjang.
- `POST /api/auth/login` - masuk dengan email/nomor HP dan kata sandi.
- `GET /api/auth/me` - memulihkan sesi dari cookie HttpOnly.
- `PUT /api/auth/profile` - menyimpan pilihan onboarding.
- `POST /api/auth/logout` - mengakhiri sesi.

Login nomor HP menerima format Indonesia seperti `081234567890` atau format internasional `+6281234567890`. Saat ini nomor HP belum diverifikasi melalui SMS. OTP belum aktif; aktifkan setelah memilih provider SMS dan menambahkan kredensialnya ke environment server.

Untuk produksi, gunakan HTTPS, atur `NODE_ENV=production` dan `APP_ORIGIN` ke origin HTTPS aplikasi, serta gunakan penyimpanan database persisten yang memiliki backup. Jangan jalankan server ini dengan `file://` atau server statis saja.
