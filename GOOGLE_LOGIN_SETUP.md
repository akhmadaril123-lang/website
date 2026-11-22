# Panduan Login Google SpeakUp

Login Google **tidak bisa dibuka untuk semua origin hanya lewat kode**. Google mewajibkan setiap alamat aplikasi didaftarkan pada OAuth Client ID. Jika origin belum terdaftar, Google menampilkan:

```text
Error 400: origin_mismatch
```

## Ringkasan Cepat

1. Buat OAuth Client ID tipe **Web application** milik Anda sendiri.
2. Tambahkan origin aplikasi pada **Authorized JavaScript origins**.
3. Isi `GOOGLE_CLIENT_ID` di `.env`.
4. Publish OAuth consent screen agar semua orang (bukan hanya test user) bisa login.
5. Restart server dan buka aplikasi dari origin yang terdaftar.

---

## 1. Buat Project dan OAuth Consent Screen

1. Buka <https://console.cloud.google.com/>.
2. Buat project baru, misalnya `SpeakUp`.
3. Buka **APIs & Services → OAuth consent screen**.
4. Pilih **External**.
5. Isi:
   - **App name**: `SpeakUp`
   - **User support email**: email Anda
   - **Developer contact email**: email Anda
6. Pada **Scopes**, tambahkan:
   - `openid`
   - `email`
   - `profile`
7. Jika masih **Testing**, tambahkan akun Google penguji pada **Test users**. Hanya akun itu yang bisa login.
8. Agar **semua orang** bisa login, buka **Publishing status** lalu klik **Publish app** sampai status menjadi **In production**.

> Scope `openid`, `email`, dan `profile` termasuk non-sensitive. Biasanya tidak perlu verifikasi tambahan, tetapi status aplikasi tetap harus **In production** agar pengguna umum tidak diblokir.

## 2. Buat OAuth Client ID

1. Buka **APIs & Services → Credentials**.
2. Klik **Create credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Isi **Authorized JavaScript origins** dengan alamat aplikasi **tanpa path dan tanpa garis miring di akhir**:

```text
http://localhost:3000
http://127.0.0.1:3000
```

Jika port berbeda, daftarkan port yang benar-benar dipakai. Contoh:

```text
http://localhost:5500
http://192.168.1.10:3000
```

Untuk produksi:

```text
https://domain-anda.com
```

5. **Authorized redirect URIs** tidak wajib untuk tombol Google Identity Services, tetapi aman untuk ditambahkan:

```text
http://localhost:3000
http://localhost:3000/
https://domain-anda.com
https://domain-anda.com/
```

6. Simpan, lalu salin **Client ID**.

## 3. Isi Environment Variable

Buat file `.env` di folder proyek:

```env
NODE_ENV=development
PORT=3000
GOOGLE_CLIENT_ID=CLIENT_ID_ANDA.apps.googleusercontent.com
APP_ORIGIN=http://localhost:3000
```

Restart server:

```powershell
npm start
```

Buka:

```text
http://localhost:3000
```

Gunakan jendela incognito atau hapus cache jika tombol Google masih memakai konfigurasi lama.

## 4. Deploy ke Vercel

Tambahkan Environment Variables berikut di dashboard Vercel:

```env
GOOGLE_CLIENT_ID=CLIENT_ID_ANDA.apps.googleusercontent.com
APP_ORIGIN=https://domain-anda.com
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec
```

Lalu tambahkan juga `https://domain-anda.com` pada **Authorized JavaScript origins**.

## 5. Arti Error Google

| Error | Penyebab | Perbaikan |
| --- | --- | --- |
| `origin_mismatch` | Origin belum ada di Authorized JavaScript origins | Tambahkan origin persis, termasuk port |
| `redirect_uri_mismatch` | Redirect URI belum terdaftar | Tambahkan URI pada Authorized redirect URIs |
| `invalid_client` | Client ID salah atau bukan tipe Web application | Periksa `GOOGLE_CLIENT_ID` |
| `access_blocked` | OAuth consent screen belum dipublish / akun bukan test user | Publish app atau tambahkan test user |
| `idpiframe_initialization_failed` | Cookie pihak ketiga diblokir browser | Gunakan tombol popup Google, bukan iframe |

## 6. Catatan Client ID Demo

Kode ini masih menyimpan Client ID contoh milik proyek **Potato App**. Client ID tersebut bukan milik Anda dan kemungkinan besar tidak mengizinkan `localhost:3000`.

Jika muncul peringatan **Client ID demo terdeteksi** di aplikasi:

1. Buat OAuth Client ID sendiri seperti langkah di atas.
2. Isi `GOOGLE_CLIENT_ID` di `.env`.
3. Restart server.

Jangan memakai Client ID milik proyek orang lain untuk aplikasi produksi.
