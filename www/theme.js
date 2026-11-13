// Tema terang / gelap. Dimuat di <head> supaya tema terpasang sebelum halaman tampil (tanpa kedipan).
// Pilihan disimpan di localStorage 'theme': 'auto' (ikuti sistem, default) | 'light' | 'dark'.
'use strict';

// Akses plugin native tanpa @capacitor/core (aplikasi ini JS polos, tanpa bundler).
// Bridge Android hanya menyediakan Capacitor.nativePromise / Capacitor.addListener — BUKAN registerPlugin.
// Mengembalikan null di browser biasa atau jika plugin tidak terdaftar.
window.pcNative = function (name) {
  const cap = window.Capacitor;
  if (!cap || typeof cap.nativePromise !== 'function') return null;
  if (typeof cap.isNativePlatform === 'function' && !cap.isNativePlatform()) return null;
  const headers = cap.PluginHeaders;
  if (Array.isArray(headers) && !headers.some((h) => h && h.name === name)) return null;
  return {
    call: (method, options) => cap.nativePromise(name, method, options || {}),
    addListener: (event, cb) => cap.addListener(name, event, cb),
  };
};

(function () {
  const COLORS = { dark: '#0b0b0d', light: '#f6f6f8' };
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  let native = null;
  try { native = window.pcNative('SystemBars'); } catch { native = null; }

  function getPref() {
    try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; }
  }
  function resolve(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return media && media.matches ? 'light' : 'dark';
  }
  function apply() {
    const theme = resolve(getPref());
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = COLORS[theme];
    const scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.content = theme;
    // Status bar & navigation bar Android ikut warna tema.
    if (native) {
      try { Promise.resolve(native.call('setStyle', { dark: theme === 'dark', color: COLORS[theme] })).catch(() => {}); } catch { /* abaikan */ }
    }
    return theme;
  }

  window.pcTheme = {
    get: getPref,
    set(pref) {
      try { localStorage.setItem('theme', pref); } catch { /* abaikan */ }
      return apply();
    },
    apply,
  };

  if (media) {
    const onChange = () => { if (getPref() === 'auto') apply(); };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }
  apply();
})();
