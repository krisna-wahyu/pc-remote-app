// Tema terang / gelap. Dimuat di <head> supaya tema terpasang sebelum halaman tampil (tanpa kedipan).
// Pilihan disimpan di localStorage 'theme': 'auto' (ikuti sistem, default) | 'light' | 'dark'.
'use strict';
(function () {
  const COLORS = { dark: '#0b0b0d', light: '#f6f6f8' };
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  const native = window.Capacitor?.isNativePlatform?.() ? window.Capacitor.registerPlugin('SystemBars') : null;

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
    if (native) native.setStyle({ dark: theme === 'dark', color: COLORS[theme] }).catch(() => {});
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
