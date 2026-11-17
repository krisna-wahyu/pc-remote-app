// PC Remote — tab "Remote": remote desktop ala Chrome Remote Desktop.
// Gambar layar dikirim pc-remote-bot sebagai stream 30 fps (/api/remote/stream; layar diam = paket kecil "sama"),
// cadangan untuk bot lama: ambil per gambar (/api/remote/frame). Mouse/keyboard/clipboard dikirim lewat
// /api/remote/input & /api/remote/clipboard. Memakai helper global dari app.js
// ($, $$, cfg, api, toast, pushLayer, closeTop, layers, state, copyText).
'use strict';
(() => {
  const QUALITY = {
    hemat: { w: 960, q: 45 },
    seimbang: { w: 1280, q: 60 },
    tajam: { w: 1920, q: 70 },
    asli: { w: 0, q: 80 },
  };
  const MOD_VK = { ctrl: 17, alt: 18, shift: 16, win: 91 };
  const FPS_OPTIONS = [30, 24, 20, 15, 10, 5];
  const WORKERS = 2; // cadangan (bot lama): dua permintaan gambar bergantian → jeda jaringan tertutupi
  const STALL_MS = 6000; // stream tanpa paket selama ini → sambung ulang
  const SPEED_DEFAULT = 0.5; // kecepatan kursor trackpad (1 = selebar layar HP → selebar layar PC)
  const LONG_PRESS_MS = 450;
  const TAP_MS = 300;
  const MOVE_SLOP = 8;
  const MAX_ZOOM = 6;
  const KBD_SEED = '​​'; // penyangga supaya Backspace di kotak kosong tetap terdeteksi

  const pref = {
    get: (k, d) => { try { const v = localStorage.getItem(`rd.${k}`); return v === null ? d : v; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(`rd.${k}`, String(v)); } catch { /* abaikan */ } },
  };
  function clampSpeed(v) { return Number.isFinite(v) ? Math.min(1.5, Math.max(0.15, v)) : SPEED_DEFAULT; }

  const rd = {
    active: false,
    gen: 0,
    monitor: Number(pref.get('monitor', '1')) || 0,
    quality: QUALITY[pref.get('quality', 'seimbang')] ? pref.get('quality', 'seimbang') : 'seimbang',
    mode: pref.get('mode', 'trackpad') === 'touch' ? 'touch' : 'trackpad',
    cursor: pref.get('cursor', '1') === '1',
    speed: clampSpeed(Number(pref.get('speed', String(SPEED_DEFAULT)))),
    fps: FPS_OPTIONS.includes(Number(pref.get('fps', '30'))) ? Number(pref.get('fps', '30')) : 30,
    realCx: null, // posisi kursor sungguhan di PC (dari stream)
    realCy: null,
    lastLocalMove: 0,
    useStream: true,
    streamCtl: null,
    lastPacket: 0,
    restarting: false,
    decoding: false,
    byteLog: [],
    monitors: [],
    all: null,
    frame: null,
    fw: 0,
    fh: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
    cx: 0.5, // posisi kursor mode trackpad (0..1)
    cy: 0.5,
    reqSeq: 0,
    shownSeq: 0,
    stamps: [],
    bytes: 0,
    lastMs: 0,
    mods: new Set(),
    full: false,
    dragging: false,
  };

  const stage = $('#rdStage');
  const canvas = $('#rdCanvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const kbd = $('#rdKbd');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---------------------------------------------------------------- tampilan

  function setStatus(text) {
    const s = $('#rdStatus');
    s.textContent = text;
    s.hidden = !text;
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(stage.clientWidth * dpr));
    const h = Math.max(1, Math.round(stage.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    draw();
  }

  // Posisi gambar di layar HP (px CSS), dengan zoom & geser yang dibatasi agar tidak keluar.
  function geom() {
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    if (!rd.fw || !sw || !sh) return null;
    const s = Math.min(sw / rd.fw, sh / rd.fh) * rd.zoom;
    const w = rd.fw * s;
    const h = rd.fh * s;
    let ox = (sw - w) / 2 + rd.panX;
    let oy = (sh - h) / 2 + rd.panY;
    ox = w > sw ? clamp(ox, sw - w, 0) : (sw - w) / 2;
    oy = h > sh ? clamp(oy, sh - h, 0) : (sh - h) / 2;
    rd.panX = ox - (sw - w) / 2;
    rd.panY = oy - (sh - h) / 2;
    return { sw, sh, s, w, h, ox, oy };
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const g = geom();
    if (!g || !rd.frame) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = rd.zoom > 1.5 ? 'low' : 'high';
    // Tanpa penanda tambahan: yang terlihat hanya kursor Windows asli yang ikut tergambar di layar PC.
    ctx.drawImage(rd.frame, g.ox, g.oy, g.w, g.h);
  }

  // Titik di layar HP → koordinat PC (0..1).
  function toRemote(clientX, clientY) {
    const g = geom();
    if (!g) return null;
    const r = stage.getBoundingClientRect();
    return {
      x: clamp((clientX - r.left - g.ox) / g.w, 0, 1),
      y: clamp((clientY - r.top - g.oy) / g.h, 0, 1),
    };
  }

  // Mode trackpad saat diperbesar: geser tampilan supaya kursor tetap terlihat.
  function followCursor() {
    const g = geom();
    if (!g || rd.zoom <= 1) return;
    const margin = 48;
    const x = g.ox + rd.cx * g.w;
    const y = g.oy + rd.cy * g.h;
    if (x < margin) rd.panX += margin - x;
    if (x > g.sw - margin) rd.panX -= x - (g.sw - margin);
    if (y < margin) rd.panY += margin - y;
    if (y > g.sh - margin) rd.panY -= y - (g.sh - margin);
  }

  function resetView() {
    rd.zoom = 1;
    rd.panX = 0;
    rd.panY = 0;
    rd.cx = 0.5;
    rd.cy = 0.5;
  }

  // ---------------------------------------------------------------- gambar layar

  async function loadMonitors(gen) {
    try {
      const r = await api('/api/remote/monitors', { timeout: 30000 });
      if (gen !== rd.gen) return;
      rd.monitors = r.monitors || [];
      rd.all = r.all || null;
      rd.system = r.system === true ? true : r.system === false ? false : null; // null = bot lama (tidak melapor)
      if (rd.monitor > rd.monitors.length) setMonitor(1);
      renderMonitorLabel();
      renderMonitorList();
      renderSystemMode();
    } catch { /* gambar tetap dicoba; pesan error tampil dari sana */ }
  }

  // Mode SYSTEM (layanan PcRemoteSvc di PC): dialog UAC, layar kunci & Ctrl+Alt+Del bisa dikontrol.
  function renderSystemMode() {
    const box = $('#rdMode2');
    $('#rdSas').hidden = rd.system !== true;
    if (rd.system === null || rd.system === undefined) { box.hidden = true; return; }
    box.hidden = false;
    box.classList.toggle('on', rd.system);
    box.textContent = rd.system
      ? '🛡 Mode SYSTEM aktif — dialog UAC (Run as administrator), layar kunci & Ctrl+Alt+Del bisa dikontrol.'
      : 'ℹ️ Dialog UAC & layar kunci belum bisa dikontrol. Pasang layanan sekali di PC (sebagai Administrator): '
        + 'pc-remote-bot\\remote-service\\install.ps1';
  }

  async function worker(gen, delay) {
    await sleep(delay);
    while (rd.active && gen === rd.gen) {
      const seq = ++rd.reqSeq;
      const t0 = performance.now();
      const q = QUALITY[rd.quality];
      const url = `${cfg.server}/api/remote/frame?monitor=${rd.monitor}&w=${q.w}&q=${q.q}&cursor=${showCursor() ? 1 : 0}`;
      // Batas fps juga berlaku di mode cadangan (tiap pekerja paling cepat WORKERS/fps detik sekali).
      const minGap = (1000 * WORKERS) / rd.fps;
      const pace = sleep(minGap);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.token}` }, cache: 'no-store', signal: ctl.signal });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw Object.assign(new Error(d.error || `HTTP ${res.status}`), { status: res.status });
        }
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        if (gen !== rd.gen || seq < rd.shownSeq) { bmp.close?.(); continue; }
        rd.shownSeq = seq;
        if (rd.frame && rd.frame.close) rd.frame.close();
        rd.frame = bmp;
        if (rd.fw !== bmp.width || rd.fh !== bmp.height) { rd.fw = bmp.width; rd.fh = bmp.height; }
        rd.stamps.push(performance.now());
        rd.bytes = blob.size;
        rd.lastMs = performance.now() - t0;
        setStatus('');
        draw();
        await pace;
      } catch (e) {
        if (gen !== rd.gen) return;
        if (e.status === 401) { setStatus('Token ditolak PC. Sambungkan ulang.'); stop(); return; }
        const msg = e.name === 'AbortError' ? 'PC tidak menjawab' : e instanceof TypeError ? 'PC tidak bisa dihubungi' : e.message;
        setStatus(`${msg} · mencoba lagi…`);
        await sleep(1500);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // ---- Stream 30 fps ----
  function streamUrl() {
    const q = QUALITY[rd.quality];
    return `${cfg.server}/api/remote/stream?monitor=${rd.monitor}&w=${q.w}&q=${q.q}&cursor=${showCursor() ? 1 : 0}&fps=${rd.fps}`;
  }
  // Mode trackpad selalu menampilkan kursor PC (satu-satunya penunjuk posisi); mode sentuh ikut setelan.
  function showCursor() { return rd.mode === 'trackpad' || rd.cursor; }

  // Dekode hanya gambar terbaru: kalau HP lebih lambat dari stream, gambar di antaranya dilewati.
  // Salinan layar PC di HP. Gambar penuh menggambar ulang semuanya; potongan (paket 6) ditempel di posisinya.
  // Diproses berurutan (potongan tidak boleh dilewati), tapi gambar penuh membuang potongan lama yang masih antre.
  const screen = document.createElement('canvas');
  const sctx = screen.getContext('2d', { alpha: false });
  const applyQueue = [];
  let screenReady = false;
  let redrawQueued = false;
  const jpegBitmap = (bytes) => createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));

  function queueRedraw() {
    if (redrawQueued) return;
    redrawQueued = true;
    requestAnimationFrame(() => { redrawQueued = false; draw(); });
  }

  function enqueue(item, gen) {
    if (item.full) applyQueue.length = 0; // gambar penuh menggantikan potongan yang belum sempat ditempel
    applyQueue.push(item);
    if (!rd.decoding) processQueue(gen);
  }

  async function processQueue(gen) {
    rd.decoding = true;
    try {
      while (applyQueue.length && gen === rd.gen) {
        const item = applyQueue.shift();
        try {
          if (item.full) {
            const bmp = await jpegBitmap(item.jpeg);
            if (gen !== rd.gen) { bmp.close?.(); break; }
            if (screen.width !== bmp.width || screen.height !== bmp.height) { screen.width = bmp.width; screen.height = bmp.height; }
            sctx.drawImage(bmp, 0, 0);
            bmp.close?.();
            screenReady = true;
          } else {
            // Potongan hanya berlaku di atas gambar penuh dengan ukuran yang sama.
            if (!screenReady || item.w !== screen.width || item.h !== screen.height) continue;
            const bmps = await Promise.all(item.rects.map((r) => jpegBitmap(r.jpeg)));
            if (gen !== rd.gen) { bmps.forEach((b) => b.close?.()); break; }
            item.rects.forEach((r, i) => { sctx.drawImage(bmps[i], r.x, r.y, r.w, r.h); bmps[i].close?.(); });
          }
        } catch { continue; /* gambar rusak: lewati */ }
        if (rd.frame !== screen) {
          if (rd.frame && rd.frame.close) rd.frame.close();
          rd.frame = screen;
        }
        if (rd.fw !== screen.width || rd.fh !== screen.height) { rd.fw = screen.width; rd.fh = screen.height; }
        setStatus('');
        queueRedraw();
      }
    } finally {
      rd.decoding = false;
    }
  }

  // Paket 6: [u16 lebar][u16 tinggi][u16 jumlah] lalu tiap potongan [u16 x][u16 y][u16 w][u16 h][u32 panjang][JPEG]
  function parseDelta(body) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const w = dv.getUint16(0);
    const h = dv.getUint16(2);
    const n = dv.getUint16(4);
    const rects = [];
    let off = 6;
    for (let i = 0; i < n && off + 12 <= body.byteLength; i++) {
      const len = dv.getUint32(off + 8);
      rects.push({ x: dv.getUint16(off), y: dv.getUint16(off + 2), w: dv.getUint16(off + 4), h: dv.getUint16(off + 6), jpeg: body.slice(off + 12, off + 12 + len) });
      off += 12 + len;
    }
    return { full: false, w, h, rects };
  }

  async function streamLoop(gen) {
    while (rd.active && gen === rd.gen) {
      const ctl = new AbortController();
      rd.streamCtl = ctl;
      rd.restarting = false;
      rd.lastPacket = performance.now();
      try {
        const res = await fetch(streamUrl(), { headers: { Authorization: `Bearer ${cfg.token}` }, cache: 'no-store', signal: ctl.signal });
        if (res.status === 404) { rd.useStream = false; return pollFallback(gen); } // bot versi lama
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw Object.assign(new Error(d.error || `HTTP ${res.status}`), { status: res.status });
        }
        const reader = res.body.getReader();
        let buf = new Uint8Array(0);
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const now = performance.now();
          rd.lastPacket = now;
          rd.byteLog.push([now, value.length]);
          const merged = new Uint8Array(buf.length + value.length);
          merged.set(buf);
          merged.set(value, buf.length);
          buf = merged;
          let off = 0;
          while (buf.length - off >= 5) {
            const len = ((buf[off + 1] << 24) | (buf[off + 2] << 16) | (buf[off + 3] << 8) | buf[off + 4]) >>> 0;
            if (buf.length - off < 5 + len) break;
            const type = buf[off];
            const body = buf.subarray(off + 5, off + 5 + len);
            off += 5 + len;
            if (type === 1) { rd.stamps.push(now); enqueue({ full: true, jpeg: body.slice() }, gen); }
            else if (type === 6) { rd.stamps.push(now); enqueue(parseDelta(body), gen); }
            else if (type === 2) rd.stamps.push(now);
            else if (type === 5 && len === 8) {
              const dv = new DataView(body.buffer, body.byteOffset, 8);
              rd.realCx = dv.getFloat32(0);
              rd.realCy = dv.getFloat32(4);
            } else if (type === 3) {
              let msg = 'gagal menangkap layar';
              try { msg = JSON.parse(new TextDecoder().decode(body)).error || msg; } catch { /* biarkan */ }
              setStatus(`${msg} · mencoba lagi…`);
            }
          }
          buf = off ? buf.slice(off) : buf;
        }
        if (gen !== rd.gen) return;
        if (!rd.restarting) { setStatus('Sambungan layar terputus · menyambung ulang…'); await sleep(800); }
      } catch (e) {
        if (gen !== rd.gen) return;
        if (rd.restarting) continue; // ganti layar / kualitas → langsung sambung dengan setelan baru
        if (e.status === 401) { setStatus('Token ditolak PC. Sambungkan ulang.'); stop(); return; }
        const msg = e.name === 'AbortError' ? 'PC tidak mengirim gambar' : e instanceof TypeError ? 'PC tidak bisa dihubungi' : e.message;
        setStatus(`${msg} · mencoba lagi…`);
        await sleep(1500);
      }
    }
  }

  // Setelan gambar berubah → putus & sambung ulang stream dengan setelan baru.
  function restartStream() {
    if (!rd.active || !rd.useStream || !rd.streamCtl) return;
    rd.restarting = true;
    rd.streamCtl.abort();
  }

  function pollFallback(gen) {
    for (let i = 0; i < WORKERS; i++) worker(gen, i * 90);
  }

  function renderStats() {
    const now = performance.now();
    rd.stamps = rd.stamps.filter((t) => now - t < 2000);
    rd.byteLog = rd.byteLog.filter(([t]) => now - t < 2000);
    // Stream yang macet (tanpa paket, bukan sekadar layar diam) → sambung ulang.
    if (rd.active && rd.useStream && rd.streamCtl && now - rd.lastPacket > STALL_MS) rd.streamCtl.abort();
    const fps = rd.stamps.length / 2;
    const kbps = rd.byteLog.reduce((s, [, n]) => s + n, 0) / 2 / 1024;
    $('#rdStats').textContent = !rd.active || !rd.frame ? ''
      : rd.useStream ? `${Math.round(fps)} fps · ${kbps >= 1024 ? `${(kbps / 1024).toFixed(1)} MB` : `${Math.round(kbps)} KB`}/dtk`
        : `${fps.toFixed(fps < 10 ? 1 : 0)} fps · ${Math.round(rd.bytes / 1024)} KB · ${Math.round(rd.lastMs)} ms`;
  }

  function start() {
    if (rd.active) return;
    rd.active = true;
    const gen = ++rd.gen;
    if (!rd.frame) setStatus('Menghubungkan ke layar PC…');
    resizeCanvas();
    loadMonitors(gen);
    if (rd.useStream) streamLoop(gen); else pollFallback(gen);
  }

  function stop() {
    if (!rd.active) return;
    rd.active = false;
    rd.gen++;
    if (rd.streamCtl) { rd.streamCtl.abort(); rd.streamCtl = null; }
    applyQueue.length = 0;
    if (rd.dragging) { send({ t: 'up', b: 'left' }); rd.dragging = false; }
    clearMods();
    if (document.activeElement === kbd) kbd.blur();
  }

  // Jalan hanya saat tab Remote terlihat, aplikasi di depan & tidak terkunci.
  function shouldRun() {
    return state.tab === 'remote' && !$('#main').hidden && document.visibilityState === 'visible' && !!cfg.token;
  }
  function sync() {
    if (shouldRun()) start(); else stop();
  }
  setInterval(() => { sync(); renderStats(); }, 1000);
  document.addEventListener('visibilitychange', sync);
  new ResizeObserver(resizeCanvas).observe(stage);

  // ---------------------------------------------------------------- input ke PC

  const queue = [];
  let sending = false;
  let lastErrorToast = 0;

  function send(ev) {
    const last = queue[queue.length - 1];
    if (ev.t === 'move' && last && last.t === 'move') queue[queue.length - 1] = ev; // cukup posisi terakhir
    else queue.push(ev);
    flush();
  }
  function sendAll(events) { for (const e of events) send(e); }

  async function flush() {
    if (sending || !queue.length || !cfg.token) return;
    sending = true;
    const events = queue.splice(0);
    try {
      await api('/api/remote/input', { method: 'POST', body: JSON.stringify({ monitor: rd.monitor, events }), timeout: 10000 });
    } catch (e) {
      if (Date.now() - lastErrorToast > 4000) { lastErrorToast = Date.now(); toast(`❌ ${e.message}`); }
    } finally {
      sending = false;
      if (queue.length) flush();
    }
  }

  // Tombol pengubah (Ctrl/Alt/Shift/Win) "menempel" untuk satu aksi berikutnya.
  function modVks() { return [...rd.mods].map((m) => MOD_VK[m]); }
  function withMods(events) {
    const vks = modVks();
    if (!vks.length) return events;
    clearMods();
    return [...vks.map((vk) => ({ t: 'key', vk, down: true })), ...events, ...[...vks].reverse().map((vk) => ({ t: 'key', vk, down: false }))];
  }
  function clearMods() {
    rd.mods.clear();
    $$('#rdKeys .mod').forEach((b) => b.classList.remove('on'));
  }

  function click(b, pos, n = 1) {
    const evs = [];
    if (pos) evs.push({ t: 'move', x: pos.x, y: pos.y });
    sendAll(evs.concat(withMods([{ t: 'click', b, n }])));
    if (navigator.vibrate) navigator.vibrate(8);
  }

  function pressKey(vk) { sendAll(withMods([{ t: 'key', vk }])); }

  // ---------------------------------------------------------------- sentuhan

  const pts = new Map();
  let g1 = null; // gestur satu jari
  let g2 = null; // gestur dua jari
  let wheelAcc = 0;

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  // Menyentuh layar PC tidak boleh merebut fokus dari kotak ketik tersembunyi: kalau fokus pindah, keyboard HP
  // menutup padahal pengguna masih ingin mengetik. Keyboard hanya ditutup lewat tombol ⌨ atau Back.
  stage.addEventListener('mousedown', (e) => e.preventDefault());
  stage.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!rd.frame) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      g2 = null;
      // Trackpad melanjutkan dari posisi kursor sungguhan di PC (mis. setelah mouse PC digerakkan langsung),
      // kecuali baru saja digerakkan dari HP (posisi dari PC mungkin belum menyusul).
      if (rd.mode === 'trackpad' && rd.realCx !== null && performance.now() - rd.lastLocalMove > 600) {
        rd.cx = clamp(rd.realCx, 0, 1);
        rd.cy = clamp(rd.realCy, 0, 1);
      }
      g1 = { sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, lt: performance.now(), t0: Date.now(), moved: false, done: false };
      g1.long = setTimeout(onLongPress, LONG_PRESS_MS);
    } else if (pts.size === 2) {
      // Jari kedua: batalkan gestur satu jari.
      if (g1) {
        clearTimeout(g1.long);
        if (rd.dragging) { send({ t: 'up', b: 'left' }); rd.dragging = false; }
        g1 = null;
      }
      const [a, b] = [...pts.values()];
      const geo = geom();
      g2 = { d0: dist(a, b), m0: mid(a, b), lm: mid(a, b), t0: Date.now(), kind: null, zoom0: rd.zoom, ox0: geo.ox, oy0: geo.oy, s0: geo.s, ended: false };
      wheelAcc = 0;
    }
  });

  function onLongPress() {
    if (!g1 || g1.moved || g1.done) return;
    if (navigator.vibrate) navigator.vibrate(25);
    if (rd.mode === 'trackpad') {
      // Tahan lalu geser = drag (tombol kiri ditekan selama jari menempel).
      rd.dragging = true;
      sendAll([{ t: 'move', x: rd.cx, y: rd.cy }, { t: 'down', b: 'left' }]);
    } else {
      // Mode sentuh: tahan = klik kanan di titik itu.
      g1.done = true;
      click('right', toRemote(g1.sx, g1.sy));
    }
  }

  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (g2 && pts.size >= 2 && !g2.ended) {
      const [a, b] = [...pts.values()];
      const m = mid(a, b);
      const d = dist(a, b);
      if (!g2.kind) {
        if (Math.abs(d / g2.d0 - 1) > 0.12) g2.kind = 'pinch';
        else if (dist(m, g2.m0) > 12) g2.kind = 'scroll';
      }
      if (g2.kind === 'pinch') {
        // Zoom di sekitar titik tengah dua jari, sambil ikut bergeser.
        rd.zoom = clamp(g2.zoom0 * (d / g2.d0), 1, MAX_ZOOM);
        const r = stage.getBoundingClientRect();
        const px = (g2.m0.x - r.left - g2.ox0) / g2.s0;
        const py = (g2.m0.y - r.top - g2.oy0) / g2.s0;
        const sw = stage.clientWidth;
        const sh = stage.clientHeight;
        const s1 = Math.min(sw / rd.fw, sh / rd.fh) * rd.zoom;
        const ox = m.x - r.left - px * s1;
        const oy = m.y - r.top - py * s1;
        rd.panX = ox - (sw - rd.fw * s1) / 2;
        rd.panY = oy - (sh - rd.fh * s1) / 2;
        draw();
      } else if (g2.kind === 'scroll') {
        // Dua jari ke atas = gulir ke bawah (seperti touchpad laptop).
        wheelAcc += (m.y - g2.lm.y) * 3;
        const notch = Math.trunc(wheelAcc / 40) * 40;
        if (notch) { wheelAcc -= notch; send({ t: 'wheel', dy: notch, dx: 0 }); }
      }
      g2.lm = m;
      return;
    }

    if (!g1 || pts.size !== 1) return;
    const total = Math.hypot(e.clientX - g1.sx, e.clientY - g1.sy);
    if (!g1.moved && total > MOVE_SLOP) { g1.moved = true; clearTimeout(g1.long); }

    if (rd.mode === 'trackpad') {
      const geo = geom();
      if (!geo) return;
      const now = performance.now();
      const dx = e.clientX - g1.lx;
      const dy = e.clientY - g1.ly;
      // Akselerasi lembut: gerakan pelan = presisi, sapuan cepat = sedikit lebih jauh.
      const v = Math.hypot(dx, dy) / Math.max(1, now - g1.lt); // px/ms
      const accel = clamp(1 + (v - 0.3) * 0.6, 1, 2);
      // Relatif terhadap gambar utuh (zoom 1), bukan bagian yang diperbesar → kecepatan sama saat zoom.
      const s0 = Math.min(geo.sw / rd.fw, geo.sh / rd.fh);
      const k = accel * rd.speed;
      rd.cx = clamp(rd.cx + (dx * k) / (rd.fw * s0), 0, 1);
      rd.cy = clamp(rd.cy + (dy * k) / (rd.fh * s0), 0, 1);
      g1.lx = e.clientX; g1.ly = e.clientY; g1.lt = now;
      if (g1.moved) {
        send({ t: 'move', x: rd.cx, y: rd.cy });
        rd.lastLocalMove = performance.now();
        followCursor();
        draw();
      }
    } else if (g1.moved && !g1.done) {
      const p = toRemote(e.clientX, e.clientY);
      if (!rd.dragging) {
        // Mode sentuh: geser satu jari = drag dari titik awal.
        rd.dragging = true;
        const s = toRemote(g1.sx, g1.sy);
        sendAll([{ t: 'move', x: s.x, y: s.y }, { t: 'down', b: 'left' }]);
      }
      if (p) send({ t: 'move', x: p.x, y: p.y });
    }
  });

  function onPointerEnd(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    const cancelled = e.type === 'pointercancel';

    if (g2 && !g2.ended) {
      // Jari pertama dari gestur dua jari terangkat.
      g2.ended = true;
      if (!cancelled && !g2.kind && Date.now() - g2.t0 < TAP_MS) {
        // Ketuk dua jari = klik kanan.
        click('right', rd.mode === 'trackpad' ? { x: rd.cx, y: rd.cy } : toRemote(g2.m0.x, g2.m0.y));
      }
      return;
    }
    if (pts.size) return;
    if (g2) { g2 = null; return; }
    if (!g1) return;
    clearTimeout(g1.long);
    const g = g1;
    g1 = null;
    if (rd.dragging) {
      if (rd.mode === 'touch' && !cancelled) {
        const p = toRemote(e.clientX, e.clientY);
        if (p) send({ t: 'move', x: p.x, y: p.y });
      }
      send({ t: 'up', b: 'left' });
      rd.dragging = false;
      return;
    }
    if (cancelled || g.moved || g.done || Date.now() - g.t0 > LONG_PRESS_MS) return;
    // Ketuk = klik kiri (trackpad: di posisi kursor; sentuh: di titik yang diketuk).
    click('left', rd.mode === 'trackpad' ? { x: rd.cx, y: rd.cy } : toRemote(g.sx, g.sy));
  }
  stage.addEventListener('pointerup', onPointerEnd);
  stage.addEventListener('pointercancel', onPointerEnd);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  // Roda mouse (mis. dicoba dari browser PC).
  stage.addEventListener('wheel', (e) => { e.preventDefault(); send({ t: 'wheel', dy: -Math.sign(e.deltaY) * 120, dx: 0 }); }, { passive: false });

  // ---------------------------------------------------------------- keyboard HP

  let kbdLast = KBD_SEED;
  function seedKbd() { kbd.value = KBD_SEED; kbdLast = KBD_SEED; }
  const charVk = (c) => (/^[a-z]$/i.test(c) ? c.toUpperCase().charCodeAt(0) : /^[0-9]$/.test(c) ? c.charCodeAt(0) : 0);

  $('#rdKbdBtn').addEventListener('click', () => {
    if (document.activeElement === kbd) { kbd.blur(); return; }
    seedKbd();
    kbd.focus();
  });
  kbd.addEventListener('focus', () => { $('#rdKbdBtn').classList.add('on'); $('#main').classList.add('typing'); });
  kbd.addEventListener('blur', () => { $('#rdKbdBtn').classList.remove('on'); $('#main').classList.remove('typing'); });

  // Keyboard HP sering tidak mengirim keydown yang jelas (komposisi, saran kata) → bandingkan isi kotak:
  // huruf yang hilang = Backspace, huruf yang bertambah = diketik ke PC.
  kbd.addEventListener('input', () => {
    const v = kbd.value;
    let i = 0;
    while (i < v.length && i < kbdLast.length && v[i] === kbdLast[i]) i++;
    const removed = kbdLast.length - i;
    const added = v.slice(i);
    kbdLast = v;
    const evs = [];
    for (let k = 0; k < removed; k++) evs.push({ t: 'key', vk: 8 });
    if (added) {
      const vk = added.length === 1 ? charVk(added) : 0;
      const hasCombo = [...rd.mods].some((m) => m !== 'shift');
      if (hasCombo && vk) evs.push(...withMods([{ t: 'key', vk }])); // mis. Ctrl + C
      else { if (rd.mods.size) clearMods(); evs.push({ t: 'text', s: added }); }
    }
    sendAll(evs);
    if (v.length < KBD_SEED.length || v.length > 400) seedKbd();
  });
  kbd.addEventListener('keydown', (e) => {
    const special = { Escape: 27, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };
    if (special[e.key]) { e.preventDefault(); pressKey(special[e.key]); }
  });

  // ---------------------------------------------------------------- tombol khusus

  // Tombol khusus & toolbar tidak merebut fokus: keyboard HP tetap terbuka saat menekan Ctrl, Esc, panah, dst.
  $$('#rdKeys button, #rdBar button').forEach((b) => {
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('mousedown', (e) => e.preventDefault());
  });

  $('#rdKeysBtn').addEventListener('click', () => {
    const k = $('#rdKeys');
    k.hidden = !k.hidden;
    $('#rdKeysBtn').classList.toggle('on', !k.hidden);
  });
  $$('#rdKeys [data-mod]').forEach((b) => b.addEventListener('click', () => {
    const m = b.dataset.mod;
    if (rd.mods.has(m)) rd.mods.delete(m); else rd.mods.add(m);
    b.classList.toggle('on', rd.mods.has(m));
  }));
  $$('#rdKeys [data-vk]').forEach((b) => b.addEventListener('click', () => pressKey(Number(b.dataset.vk))));
  $$('#rdKeys [data-combo]').forEach((b) => b.addEventListener('click', () => {
    clearMods();
    send({ t: 'combo', vks: b.dataset.combo.split(',').map(Number) });
  }));
  // Ctrl+Alt+Del sungguhan (layanan SYSTEM); tidak bisa ditiru lewat kombinasi tombol biasa.
  $('#rdSas').addEventListener('click', () => {
    clearMods();
    send({ t: 'sas' });
    toast('Ctrl+Alt+Del dikirim');
  });

  // ---------------------------------------------------------------- layar penuh

  function setFull(on) {
    rd.full = on;
    $('#main').classList.toggle('rd-full', on);
    $('#rdFullIn').hidden = on;
    $('#rdFullOut').hidden = !on;
    requestAnimationFrame(resizeCanvas);
  }
  $('#rdFullBtn').addEventListener('click', () => setFull(!rd.full));

  // ---------------------------------------------------------------- mode input

  const MODE_HINT = {
    trackpad: 'Geser 1 jari = gerakkan kursor · ketuk = klik · ketuk 2 jari = klik kanan · tahan lalu geser = drag · geser 2 jari = scroll · cubit = zoom',
    touch: 'Ketuk = klik di titik itu · tahan = klik kanan · geser 1 jari = drag · geser 2 jari = scroll · cubit = zoom',
  };
  function setMode(m) {
    const cursorBefore = showCursor();
    rd.mode = m;
    pref.set('mode', m);
    $('#rdModeTrackpad').hidden = m !== 'trackpad';
    $('#rdModeTouch').hidden = m !== 'touch';
    $$('#rdMode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    $('#rdModeHint').textContent = MODE_HINT[m];
    renderCursorToggle();
    if (showCursor() !== cursorBefore) restartStream(); // kursor PC ikut / tidak ikut digambar
    draw();
  }
  // Di mode trackpad kursor PC selalu tampil, jadi saklarnya hanya berlaku untuk mode sentuh.
  function renderCursorToggle() {
    const t = $('#rdCursorToggle');
    t.checked = showCursor();
    t.disabled = rd.mode === 'trackpad';
    $('#rdCursorNote').textContent = rd.mode === 'trackpad'
      ? 'Selalu tampil di mode trackpad'
      : 'Kursor mouse ikut digambar di layar';
  }
  $('#rdModeBtn').addEventListener('click', () => {
    setMode(rd.mode === 'trackpad' ? 'touch' : 'trackpad');
    toast(rd.mode === 'trackpad' ? '🖱 Mode trackpad' : '👆 Mode sentuh langsung');
  });
  $$('#rdMode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  // ---------------------------------------------------------------- pengaturan

  function monitorName(i) {
    if (i === 0) return 'Semua layar';
    const m = rd.monitors.find((x) => x.i === i);
    return `Layar ${i}${m && m.primary ? ' (utama)' : ''}`;
  }
  function renderMonitorLabel() { $('#rdMonitorLabel').textContent = rd.monitor === 0 ? 'Semua' : `Layar ${rd.monitor}`; }
  function renderMonitorList() {
    const list = $('#rdMonitorList');
    list.textContent = '';
    const opts = rd.monitors.map((m) => ({ i: m.i, size: `${m.w}×${m.h}` }));
    if (rd.monitors.length > 1 && rd.all) opts.push({ i: 0, size: `${rd.all.w}×${rd.all.h}` });
    if (!opts.length) {
      const p = document.createElement('small');
      p.className = 'rd-hint';
      p.textContent = 'Daftar layar belum termuat.';
      list.appendChild(p);
      return;
    }
    for (const o of opts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `rd-option${o.i === rd.monitor ? ' active' : ''}`;
      b.innerHTML = '<strong></strong><small></small>';
      b.querySelector('strong').textContent = monitorName(o.i);
      b.querySelector('small').textContent = o.size;
      b.addEventListener('click', () => { setMonitor(o.i); renderMonitorList(); closeTop(); });
      list.appendChild(b);
    }
  }
  function setMonitor(i) {
    if (i === rd.monitor) return;
    rd.monitor = i;
    pref.set('monitor', i);
    resetView();
    rd.shownSeq = rd.reqSeq; // abaikan gambar layar lama yang masih di jalan
    renderMonitorLabel();
    setStatus('Mengganti layar…');
    restartStream();
  }
  function renderQuality() { $$('#rdQuality button').forEach((b) => b.classList.toggle('active', b.dataset.q === rd.quality)); }
  $$('#rdQuality button').forEach((b) => b.addEventListener('click', () => {
    if (rd.quality === b.dataset.q) return;
    rd.quality = b.dataset.q;
    pref.set('quality', rd.quality);
    renderQuality();
    restartStream();
  }));
  $('#rdCursorToggle').addEventListener('change', (e) => {
    rd.cursor = e.target.checked;
    pref.set('cursor', rd.cursor ? '1' : '0');
    restartStream();
  });
  // Kecepatan kursor trackpad (slider 15–150%).
  // Batas fps (30/24/20/15/10/5): lebih rendah = hemat data & CPU PC.
  function renderFps() { $$('#rdFps button').forEach((b) => b.classList.toggle('active', Number(b.dataset.fps) === rd.fps)); }
  $$('#rdFps button').forEach((b) => b.addEventListener('click', () => {
    const f = Number(b.dataset.fps);
    if (f === rd.fps) return;
    rd.fps = f;
    pref.set('fps', f);
    renderFps();
    restartStream();
  }));

  function renderSpeed() {
    $('#rdSpeed').value = String(Math.round(rd.speed * 100));
    $('#rdSpeedVal').textContent = `${Math.round(rd.speed * 100)}%`;
  }
  $('#rdSpeed').addEventListener('input', (e) => {
    rd.speed = clampSpeed(Number(e.target.value) / 100);
    pref.set('speed', rd.speed);
    $('#rdSpeedVal').textContent = `${Math.round(rd.speed * 100)}%`;
  });

  function openSheet() {
    renderMonitorList();
    renderQuality();
    renderSpeed();
    renderFps();
    setMode(rd.mode);
    $('#rdSheet').hidden = false;
    pushLayer('rdsheet');
    if (rd.active) loadMonitors(rd.gen); // monitor bisa saja dicolok/dicabut
  }
  $('#rdMenuBtn').addEventListener('click', openSheet);
  $('#rdMonitorBtn').addEventListener('click', openSheet);
  $$('#rdSheet [data-close]').forEach((el) => el.addEventListener('click', closeTop));

  // Clipboard
  $('#rdClipGet').addEventListener('click', async () => {
    try {
      const r = await api('/api/remote/clipboard');
      $('#rdClipText').value = r.text || '';
      if (r.text && (await copyText(r.text))) toast('📋 Clipboard PC disalin ke HP');
      else toast(r.text ? 'Clipboard PC ditampilkan' : 'Clipboard PC kosong');
    } catch (e) { toast(`❌ ${e.message}`); }
  });
  async function clipToPc(paste) {
    const text = $('#rdClipText').value;
    if (!text) { toast('Tulis atau tempel teksnya dulu'); return; }
    try {
      await api('/api/remote/clipboard', { method: 'POST', body: JSON.stringify({ text }) });
      if (paste) { closeTop(); send({ t: 'combo', vks: [17, 86] }); toast('📋 Ditempel di PC'); } else toast('📋 Clipboard PC diperbarui');
    } catch (e) { toast(`❌ ${e.message}`); }
  }
  $('#rdClipSet').addEventListener('click', () => clipToPc(false));
  $('#rdClipPaste').addEventListener('click', () => clipToPc(true));
  $('#rdLockPc').addEventListener('click', () => {
    if (!confirm('Kunci PC sekarang (Win+L)?')) return;
    send({ t: 'lock' });
    closeTop();
    toast('🔒 PC dikunci');
  });

  // ---------------------------------------------------------------- untuk app.js

  window.pcRemote = {
    onTab: () => sync(),
    stop: () => { stop(); if (rd.full) setFull(false); },
    // Back Android: keluar layar penuh / tutup keyboard dulu sebelum meninggalkan tab.
    handleBack() {
      if (state.tab !== 'remote') return false;
      if (document.activeElement === kbd) { kbd.blur(); return true; }
      if (rd.full) { setFull(false); return true; }
      return false;
    },
  };

  renderMonitorLabel();
  setMode(rd.mode);
  renderQuality();
})();
