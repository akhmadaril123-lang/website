# Backend autentikasi SpeakUp

## Menjalankan lokal

Perlu Node.js 22.13 atau lebih baru. Salin `.env.example` menjadi `.env`, lalu jalankan:

```powershell
npm install
npm start
```

Buka `http://localhost:3000`. Data akun dan sesi disimpan di `data/speakup.sqlite`; kata sandi disimpan sebagai hash scrypt. Jangan unggah `.env` atau database ke Git.

## API autentikasi

- `POST /api/auth/register` - membuat akun dari nama, email atau nomor HP, kata sandi, dan jenjang.
- `POST /api/auth/login` - masuk dengan email/nomor HP dan kata sandi.
- `GET /api/auth/me` - memulihkan sesi dari cookie HttpOnly.
- `PUT /api/auth/profile` - menyimpan pilihan onboarding.
- `POST /api/auth/logout` - mengakhiri sesi.

Login nomor HP menerima format Indonesia seperti `081234567890` atau format internasional `+6281234567890`. Saat ini nomor HP belum diverifikasi melalui SMS. OTP belum aktif; aktifkan setelah memilih provider SMS dan menambahkan kredensialnya ke environment server.

Untuk produksi, gunakan HTTPS, atur `NODE_ENV=production` dan `APP_ORIGIN` ke origin HTTPS aplikasi, serta gunakan penyimpanan database persisten yang memiliki backup. Jangan jalankan server ini dengan `file://` atau server statis saja.
