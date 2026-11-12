// Salin APK hasil build ke dist/PC-Remote.apk (lebih mudah ditemukan untuk dikirim ke HP).
const fs = require('fs');
const path = require('path');

// APK release, ditandatangani keystore pribadi (keystore/), tanpa mode debug.
const src = path.join(__dirname, '..', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const dest = path.join(__dirname, '..', 'dist', 'PC-Remote.apk');

if (!fs.existsSync(src)) {
  console.error('APK belum ada. Jalankan dulu: npm run build:apk');
  process.exit(1);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log(`APK siap: ${dest} (${Math.round(fs.statSync(dest).size / 1024)} KB)`);
