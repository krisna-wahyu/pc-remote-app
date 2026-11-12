# PC Remote (Android)

Aplikasi Android untuk mengendalikan PC lewat **pc-remote-bot**, tanpa lewat server Telegram.
Isinya hanya tampilan: semua logika (Open Project, Dev Mode, DB App, WordPress, …) tetap di
`C:\laragon\www\pc-remote-bot`. Aplikasi berbicara dengan server API bot (`src/app/server.js`, port 8787).

## Cara kerja

- **Beranda**: kartu menu = menu utama bot.
- **Aktivitas**: seperti chat Telegram. Balasan bot, tombol pilihan, screenshot, dan laporan Claude Code
  muncul langsung (Server-Sent Events). Saat dev mode aktif, ketikan dikirim sebagai prompt ke Claude Code,
  dan foto/file ikut diteruskan.
- HP terhubung ke PC lewat **Tailscale** (dari mana saja) atau WiFi rumah. Server hanya menerima jaringan
  lokal/Tailscale dan wajib token.

## Sambungkan

1. Di PC, lihat alamat & token: kirim `/app_pair` ke bot Telegram, atau `node bot.js --run app_pair`
   di folder `pc-remote-bot`.
2. Buka aplikasi, isi **Alamat server** (mis. `http://100.x.x.x:8787`) dan **Token**.

## Build APK

Butuh JDK 21 dan Android SDK (platform 35, build-tools 35).

```powershell
npm install
npm run build:apk   # sinkron www/ ke project Android lalu build APK debug
npm run apk         # salin hasilnya ke dist\PC-Remote.apk
```

Setelah mengubah file di `www/`, cukup jalankan `npm run build:apk` lagi.
