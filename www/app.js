// PC Remote — klien aplikasi untuk server API pc-remote-bot (src/app/server.js).
// Aplikasi ini hanya "chat": menampilkan pesan bot, mengirim teks / tap tombol / file. Semua logika ada di PC.
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------- Penyimpanan lokal (alamat server + token) ----------
const local = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* abaikan */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* abaikan */ } },
};

// Token tidak pernah disimpan polos: dienkripsi AES-GCM dengan kunci dari PIN (PBKDF2), disimpan sebagai "vault".
// Selama aplikasi terbuka & tidak terkunci, token hanya ada di memori.
const cfg = { server: local.get('server') || '', token: '' };
const vault = {
  key: null, // CryptoKey dari PIN (tidak bisa diekspor), ada selama sesi berjalan
  read: () => { try { return JSON.parse(local.get('vault') || 'null'); } catch { return null; } },
};
const PBKDF2_ITER = 310000;
const LOCK_AFTER_MS = 60 * 1000; // ditinggal ke background lebih dari ini → terkunci
const MAX_PIN_TRIES = 5; // salah PIN sebanyak ini → token dihapus dari HP
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pinKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function sealToken(token, key, salt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token));
  local.set('vault', JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
}
async function openVault(pin) {
  const v = vault.read();
  const key = await pinKey(pin, unb64(v.salt));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.iv) }, key, unb64(v.ct)); // PIN salah → gagal
  vault.key = key;
  return new TextDecoder().decode(plain);
}
async function createVault(pin, token) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  vault.key = await pinKey(pin, salt);
  await sealToken(token, vault.key, salt);
  local.del('token'); // versi lama menyimpan token polos
}
const state = {
  messages: new Map(), // id → pesan
  seq: 0,
  info: null,
  tab: 'home',
  unread: 0,
  conn: 'wait',
  stream: null, // AbortController SSE
  lastBeat: 0,
  retry: 0,
};

// ---------- API ----------
function normalizeServer(s) {
  s = s.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!u.port && u.protocol === 'http:') u.port = '8787';
    return u.origin;
  } catch { return s; }
}

async function api(path, { method = 'GET', body, headers = {}, timeout = 15000, server = cfg.server, token = cfg.token } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(server + path, {
      method,
      body,
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${token}`, ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token === cfg.token && cfg.token) logout('Token ditolak PC (mungkin sudah diganti). Sambungkan ulang.');
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('PC tidak menjawab (timeout)');
    if (e instanceof TypeError) throw new Error('PC tidak bisa dihubungi');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
const post = (path, data) => api(path, { method: 'POST', body: JSON.stringify(data || {}) });
// URL file memakai tanda tangan per file dari PC, bukan token.
const fileUrl = (f) => `${cfg.server}/api/files/${encodeURIComponent(f.id)}?sig=${encodeURIComponent(f.sig || '')}`;

// ---------- Ikon menu ----------
const ICONS = [
  [/status|pc$/, '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'],
  [/internet|wifi/, '<path d="M5 12.6a11 11 0 0 1 14 0M1.4 9a16 16 0 0 1 21.2 0M8.5 16.1a6 6 0 0 1 7 0M12 20h.01"/>'],
  [/ai/, '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>'],
  [/db|database/, '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>'],
  [/workspace/, '<path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>'],
  [/wordpress|wp/, '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'],
  [/close/, '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 9l6 6M15 9l-6 6"/>'],
  [/project|untitled/, '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'],
  [/dev/, '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>'],
  [/browser/, '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>'],
  [/screenshot/, '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'],
  [/shutdown|power/, '<path d="M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10"/>'],
  [/restart/, '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>'],
];
const iconFor = (command) => {
  const name = command.replace(/^\//, '').split(/\s/)[0].toLowerCase();
  const hit = ICONS.find(([re]) => re.test(name));
  return `<svg viewBox="0 0 24 24">${hit ? hit[1] : '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'}</svg>`;
};
const DANGER = /^\/(shutdown)$/;

// ---------- HTML Telegram → DOM (hanya tag yang aman) ----------
const TAGS = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', INS: 'u', S: 's', STRIKE: 's', DEL: 's', CODE: 'code', PRE: 'pre', A: 'a', BLOCKQUOTE: 'blockquote', BR: 'br', 'TG-SPOILER': 'spoiler', SPAN: 'span' };
function richText(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  const frag = document.createDocumentFragment();
  copy(doc.body, frag);
  return frag;
}
function copy(src, dst) {
  for (const n of src.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) { dst.appendChild(document.createTextNode(n.nodeValue)); continue; }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = TAGS[n.tagName];
    const spoiler = tag === 'spoiler' || (tag === 'span' && n.classList.contains('tg-spoiler'));
    if (!tag || (tag === 'span' && !spoiler)) { copy(n, dst); continue; }
    let el;
    if (spoiler) {
      el = document.createElement('span');
      el.className = 'spoiler';
      el.addEventListener('click', () => el.classList.toggle('open'));
    } else {
      el = document.createElement(tag);
    }
    if (tag === 'a') {
      const href = n.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) { el.href = href; el.target = '_blank'; el.rel = 'noopener'; }
    }
    copy(n, el);
    dst.appendChild(el);
  }
}
const plain = (html) => (new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html').body.textContent || '').replace(/\s+/g, ' ').trim();

// ---------- Tampilan pesan ----------
const feed = $('#feed');
const feedView = $('#tabFeed');
const fmtTime = (t) => new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
const dayKey = (t) => new Date(t).toDateString();
function dayLabel(t) {
  const d = new Date(t);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Hari ini';
  if (d.toDateString() === y.toDateString()) return 'Kemarin';
  return d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });
}
const isMainMenu = (m) => m.menu && /^📋/.test(m.text || '');

function buildMessage(m) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${m.from === 'me' ? 'me' : 'bot'}`;
  if (/^⏳/.test(m.text || '')) wrap.classList.add('progress');
  wrap.dataset.id = m.id;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (m.file) {
    const url = fileUrl(m.file);
    if (m.file.kind === 'photo' || m.file.kind === 'image') {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = url;
      img.alt = m.file.name || 'foto';
      img.addEventListener('click', () => openViewer(url));
      // Gambar memanjangkan chat setelah dimuat → tetap di bawah jika pengguna memang di bawah.
      img.addEventListener('load', () => { if (atBottom && state.tab === 'feed') scrollBottom(false); });
      bubble.appendChild(img);
    } else {
      const a = document.createElement('a');
      a.className = 'doc';
      a.href = url;
      a.target = '_blank';
      a.innerHTML = `<span class="ti"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg></span>`;
      const meta = document.createElement('span');
      meta.innerHTML = '<strong></strong><small></small>';
      meta.querySelector('strong').textContent = m.file.name || 'file';
      meta.querySelector('small').textContent = `${Math.max(1, Math.round((m.file.size || 0) / 1024))} KB`;
      a.appendChild(meta);
      bubble.appendChild(a);
    }
    if (m.caption) bubble.appendChild(document.createTextNode(m.caption));
  }

  if (isMainMenu(m)) {
    // Menu utama sudah ada di Beranda → cukup kartu ringkas.
    bubble.classList.add('menu-card');
    bubble.innerHTML = '<span>📋 Menu utama ada di Beranda</span>';
    const b = document.createElement('button');
    b.className = 'btn btn-primary btn-sm';
    b.textContent = 'Buka Beranda';
    b.addEventListener('click', () => switchTab('home'));
    bubble.appendChild(b);
    wrap.appendChild(bubble);
    return wrap;
  }

  // Ketikan sendiri ditampilkan apa adanya (bukan HTML); pesan bot = HTML Telegram yang disaring.
  if (m.text) bubble.appendChild(m.from === 'me' ? document.createTextNode(m.text) : richText(m.text));
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtTime(m.date);
  bubble.appendChild(time);
  wrap.appendChild(bubble);

  // PC ON (menu: true tapi bukan "📋 Menu") → tombol menu diganti satu tombol ke Beranda.
  const rows = m.menu ? [] : m.rows || [];
  if (rows.length) {
    const kb = document.createElement('div');
    kb.className = 'kb';
    const last = rows.length - 1;
    rows.forEach((row, i) => {
      const r = document.createElement('div');
      r.className = 'kb-row';
      for (const btn of row) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = btn.text;
        if (btn.command === 'noop') b.className = 'noop';
        else if (i === last && rows.length > 1 && /^\/help$|Kembali|Menu$/.test(btn.command + btn.text)) b.className = 'nav';
        b.addEventListener('click', () => tapButton(m.id, btn, kb));
        r.appendChild(b);
      }
      kb.appendChild(r);
    });
    wrap.appendChild(kb);
    wrap.classList.add('has-kb'); // lebar penuh: ukuran tombol tidak bergantung panjang label
  }
  return wrap;
}

function nearBottom() {
  return feedView.scrollHeight - feedView.scrollTop - feedView.clientHeight < 140;
}
// "Menempel di bawah" dicatat dari posisi gulir terakhir, bukan diukur saat pesan datang:
// saat smooth-scroll masih berjalan atau gambar baru dimuat, posisi sesaat bisa belum di bawah.
let atBottom = true;
let autoScrollUntil = 0; // selama smooth-scroll otomatis, posisi antara diabaikan
function scrollBottom(smooth) {
  atBottom = true;
  autoScrollUntil = smooth ? Date.now() + 800 : 0;
  feedView.scrollTo({ top: feedView.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  $('#newPill').hidden = true;
}
feedView.addEventListener('scroll', () => {
  const bottom = nearBottom();
  if (!bottom && Date.now() < autoScrollUntil) return;
  atBottom = bottom;
  if (bottom) $('#newPill').hidden = true;
}, { passive: true });
// Pengguna menyentuh / menggulir sendiri → hentikan anggapan "sedang auto-scroll".
for (const ev of ['touchstart', 'wheel']) feedView.addEventListener(ev, () => { autoScrollUntil = 0; }, { passive: true });

// Menu utama lama disembunyikan, hanya yang terakhir tampil.
function hideOldMenus() {
  const menus = [...state.messages.values()].filter(isMainMenu).sort((a, b) => a.id - b.id);
  const keep = menus.length ? menus[menus.length - 1].id : null;
  for (const m of menus) {
    const el = feed.querySelector(`.msg[data-id="${m.id}"]`);
    if (el) el.hidden = m.id !== keep;
  }
}

function renderAll() {
  feed.textContent = '';
  let lastDay = null;
  const list = [...state.messages.values()].sort((a, b) => a.id - b.id);
  for (const m of list) {
    if (dayKey(m.date) !== lastDay) {
      lastDay = dayKey(m.date);
      feed.appendChild(daySep(m.date));
    }
    feed.appendChild(buildMessage(m));
  }
  if (!list.length) {
    const e = document.createElement('p');
    e.className = 'empty';
    e.style.marginTop = '30vh';
    e.textContent = 'Belum ada aktivitas. Pilih menu di Beranda.';
    feed.appendChild(e);
  }
  hideOldMenus();
  scrollBottom(false);
}
function daySep(t) {
  const d = document.createElement('div');
  d.className = 'day';
  d.textContent = dayLabel(t);
  return d;
}

function applyMessage(m, live) {
  const existing = feed.querySelector(`.msg[data-id="${m.id}"]`);
  if (m.deleted) {
    state.messages.delete(m.id);
    existing?.remove();
    return;
  }
  const isNew = !state.messages.has(m.id);
  state.messages.set(m.id, m);
  const stick = atBottom || nearBottom();
  const el = buildMessage(m);
  if (existing) {
    existing.replaceWith(el);
  } else {
    feed.querySelector('.empty')?.remove();
    const prevIds = [...state.messages.keys()].filter((id) => id < m.id);
    const prev = prevIds.length ? state.messages.get(Math.max(...prevIds)) : null;
    if (!prev || dayKey(prev.date) !== dayKey(m.date)) feed.appendChild(daySep(m.date));
    feed.appendChild(el);
  }
  if (isMainMenu(m)) hideOldMenus();
  if (stick) scrollBottom(true);
  else if (isNew && state.tab === 'feed') $('#newPill').hidden = false;

  if (live && isNew && m.from !== 'me' && !isMainMenu(m) && !/^⏳/.test(m.text || '')) {
    if (state.tab !== 'feed') {
      state.unread += 1;
      updateUnread();
      toast(plain(m.text) || (m.file ? '📷 Foto dari PC' : 'Pesan baru'));
    }
    if (navigator.vibrate) navigator.vibrate(20);
  }
}

function updateUnread() {
  const b = $('#unread');
  b.textContent = state.unread > 99 ? '99+' : String(state.unread);
  b.hidden = state.unread === 0;
}

// ---------- Sinkronisasi ----------
async function sync() {
  const r = await api(`/api/messages?since=${state.seq}`);
  if (r.full) {
    state.messages.clear();
    for (const m of r.messages) state.messages.set(m.id, m);
    state.seq = r.seq;
    renderAll();
  } else {
    for (const m of r.messages) applyMessage(m, false);
    state.seq = Math.max(state.seq, r.seq);
  }
}

let infoTimer = null;
const refreshInfoSoon = () => { clearTimeout(infoTimer); infoTimer = setTimeout(() => loadInfo().catch(() => {}), 400); };
async function loadInfo() {
  const info = await api('/api/info');
  state.info = info;
  $('#hostName').textContent = info.host || 'PC';
  $('#heroHost').textContent = info.host || 'PC';
  $('#setHost').textContent = info.host || '—';
  renderMenu(info.menu || []);
  const dev = info.devmode;
  $('#devBanner').hidden = !dev;
  $('#devProject').textContent = dev ? dev.project : '';
  $('#input').placeholder = dev ? `Prompt untuk Claude Code · ${dev.project}` : 'Ketik balasan…';
  updateHero();
}

function renderMenu(menu) {
  const grid = $('#menuGrid');
  grid.textContent = '';
  $('#menuEmpty').hidden = menu.length > 0;
  for (const item of menu) {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = `tile${item.wide ? ' wide' : ''}${DANGER.test(item.command) ? ' danger' : ''}`;
    t.innerHTML = `<span class="ti">${iconFor(item.command)}</span><strong></strong>`;
    t.querySelector('strong').textContent = item.text;
    t.addEventListener('click', () => runCommand(item.command, item.text, t));
    grid.appendChild(t);
  }
}

function updateHero() {
  const h = new Date().getHours();
  $('#greeting').textContent = h < 11 ? 'Selamat pagi' : h < 15 ? 'Selamat siang' : h < 19 ? 'Selamat sore' : 'Selamat malam';
  const hero = $('.hero');
  const dev = state.info?.devmode;
  hero.classList.toggle('off', state.conn !== 'ok');
  $('#heroStatus').textContent = state.conn === 'ok'
    ? (dev ? `Dev mode aktif · ${dev.project}` : 'PC online dan siap menerima perintah')
    : state.conn === 'wait' ? 'Menghubungkan ke PC…' : 'PC offline atau tidak terjangkau';
}

function setConn(c) {
  state.conn = c;
  const el = $('#conn');
  el.className = `conn conn-${c}`;
  el.querySelector('span').textContent = c === 'ok' ? 'Online' : c === 'wait' ? 'Menyambung…' : 'Offline';
  $('#setConn').textContent = el.querySelector('span').textContent;
  updateHero();
}

// SSE lewat fetch (bisa memakai header Authorization). Putus → sambung lagi dengan jeda bertahap.
async function openStream() {
  state.stream?.abort();
  const ctl = new AbortController();
  state.stream = ctl;
  try {
    const res = await fetch(`${cfg.server}/api/events`, { headers: { Authorization: `Bearer ${cfg.token}` }, signal: ctl.signal });
    if (res.status === 401) { logout('Token ditolak PC. Sambungkan ulang.'); return; }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    state.lastBeat = Date.now();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      state.lastBeat = Date.now();
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        await onEvent(ev, data ? JSON.parse(data) : {});
      }
    }
    throw new Error('stream selesai');
  } catch (e) {
    if (ctl.signal.aborted && state.stream !== ctl) return; // diganti stream baru
    if (!cfg.token) return;
    setConn(state.retry > 0 ? 'off' : 'wait');
    const wait = Math.min(10000, 1000 * 2 ** state.retry);
    state.retry += 1;
    setTimeout(() => { if (state.stream === ctl) openStream(); }, wait);
  }
}

async function onEvent(ev, data) {
  if (ev === 'hello') {
    state.retry = 0;
    setConn('ok');
    if (data.seq !== state.seq) await sync().catch(() => {});
    loadInfo().catch(() => {});
  } else if (ev === 'change') {
    state.seq = Math.max(state.seq, data.rev || 0);
    applyMessage(data, true);
    refreshInfoSoon();
  } else if (ev === 'reset') {
    state.messages.clear();
    renderAll();
  }
}

// Server mengirim ping tiap 20 detik; diam > 45 detik → sambungan dianggap mati.
setInterval(() => {
  if (cfg.token && state.conn === 'ok' && Date.now() - state.lastBeat > 45000) openStream();
}, 5000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cfg.token) {
    if (state.conn !== 'ok' || Date.now() - state.lastBeat > 25000) { state.retry = 0; openStream(); }
    updateHero();
  }
});
window.addEventListener('online', () => { if (cfg.token) { state.retry = 0; openStream(); } });

// ---------- Aksi ----------
async function runCommand(command, label, tile) {
  tile?.classList.add('busy');
  setTimeout(() => tile?.classList.remove('busy'), 1500);
  switchTab('feed');
  try {
    await post('/api/tap', { command, label });
  } catch (e) {
    toast(`❌ ${e.message}`);
  }
}

async function tapButton(messageId, btn, kb) {
  if (btn.command === 'noop') return;
  kb.classList.add('busy');
  setTimeout(() => kb.classList.remove('busy'), 6000);
  try {
    await post('/api/tap', { messageId, command: btn.command, label: btn.text });
  } catch (e) {
    kb.classList.remove('busy');
    toast(`❌ ${e.message}`);
  }
}

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  const btn = $('#sendBtn');
  btn.disabled = true;
  try {
    await post('/api/send', { text });
    input.value = '';
    autosize();
    scrollBottom(true);
  } catch (err) {
    toast(`❌ ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

const input = $('#input');
function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(160, input.scrollHeight)}px`;
}
input.addEventListener('input', autosize);
input.addEventListener('focus', () => { $('#main').classList.add('typing'); setTimeout(() => scrollBottom(true), 250); });
input.addEventListener('blur', () => $('#main').classList.remove('typing'));

$('#fileInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const caption = input.value.trim();
  toast(`⬆️ Mengirim ${file.name}…`);
  try {
    await api('/api/upload', {
      method: 'POST',
      body: file,
      timeout: 120000,
      headers: { 'X-File-Name': encodeURIComponent(file.name || 'foto.jpg'), 'X-Caption': encodeURIComponent(caption), 'Content-Type': 'application/octet-stream' },
    });
    input.value = '';
    autosize();
  } catch (err) {
    toast(`❌ ${err.message}`);
  }
});

$('#devBanner [data-command]').addEventListener('click', (e) => runCommand(e.currentTarget.dataset.command, 'Keluar dev mode'));
$('#newPill').addEventListener('click', () => scrollBottom(true));

// ---------- Navigasi (tab, sheet, viewer) + tombol Back Android ----------
// Lapisan yang terbuka dicatat di history → tombol Back menutupnya satu per satu.
const layers = [];
function pushLayer(name) { layers.push(name); history.pushState({ layer: name }, ''); }
function closeTop() { if (layers.length) history.back(); }
window.addEventListener('popstate', () => {
  const top = layers.pop();
  if (top === 'viewer') closeViewerNow();
  else if (top === 'sheet') $('#sheet').hidden = true;
  else if (top === 'feed') showTab('home');
});

// Dipanggil MainActivity.java saat tombol Back Android ditekan (seperti navigate(-1)).
// true  → ada lapisan yang ditutup, aplikasi tetap terbuka;
// false → tidak ada yang bisa ditutup, Android menjalankan Back bawaan (keluar ke layar utama HP).
window.pcHandleBack = function () {
  if ($('#main').hidden) return false;
  if (layers.length) { closeTop(); return true; }
  if (state.tab === 'feed') { showTab('home'); return true; } // mis. setelah buka kunci, catatan lapisan kosong
  return false;
};

function showTab(tab) {
  state.tab = tab;
  $('#tabHome').hidden = tab !== 'home';
  $('#tabFeed').hidden = tab !== 'feed';
  $('#composer').hidden = tab !== 'feed';
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'feed') {
    state.unread = 0;
    updateUnread();
    requestAnimationFrame(() => scrollBottom(false));
  }
}
function switchTab(tab) {
  if (tab === state.tab) return;
  if (tab === 'feed') { pushLayer('feed'); showTab('feed'); } else if (layers.includes('feed')) closeTop(); else showTab('home');
}
$$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

$('#openSettings').addEventListener('click', () => { $('#sheet').hidden = false; pushLayer('sheet'); });
$$('#sheet [data-close]').forEach((el) => el.addEventListener('click', closeTop));
// ---------- Penampil foto: cubit dua jari, ketuk-ganda, geser ----------
// Zoom bawaan WebView dimatikan (Capacitor zoomEnabled=false + viewport user-scalable=no),
// jadi zoom foto dibuat sendiri dengan transform CSS.
const viewerEl = $('#viewer');
const viewerImg = $('#viewerImg');
const zoom = { s: 1, x: 0, y: 0, pts: new Map(), pinch: null, pan: null, moved: false, downAt: 0, lastTap: null };
const ZOOM_MAX = 5;
const ZOOM_DOUBLE = 2.5;

function applyZoom(animate) {
  viewerImg.style.transition = animate ? 'transform .22s ease' : 'none';
  viewerImg.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
}
function clampZoom() {
  const maxX = Math.max(0, (viewerImg.offsetWidth * zoom.s - viewerEl.clientWidth) / 2);
  const maxY = Math.max(0, (viewerImg.offsetHeight * zoom.s - viewerEl.clientHeight) / 2);
  zoom.x = Math.min(maxX, Math.max(-maxX, zoom.x));
  zoom.y = Math.min(maxY, Math.max(-maxY, zoom.y));
}
function resetZoom(animate) { zoom.s = 1; zoom.x = 0; zoom.y = 0; applyZoom(animate); }
// Ubah skala dengan titik (px, py) di layar tetap di bawah jari.
function zoomAt(newScale, px, py, base = zoom) {
  const s = Math.min(ZOOM_MAX, Math.max(1, newScale));
  const r = viewerEl.getBoundingClientRect();
  const fx = px - (r.left + r.width / 2);
  const fy = py - (r.top + r.height / 2);
  zoom.x = fx - (fx - base.x) * (s / base.s);
  zoom.y = fy - (fy - base.y) * (s / base.s);
  zoom.s = s;
  clampZoom();
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

viewerEl.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.viewer-close')) return;
  viewerEl.setPointerCapture(e.pointerId);
  zoom.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (zoom.pts.size === 1) {
    zoom.moved = false;
    zoom.downAt = Date.now();
    zoom.downOnImg = e.target === viewerImg; // target pointerup selalu viewerEl karena pointer capture
    zoom.pan = { px: e.clientX, py: e.clientY, x: zoom.x, y: zoom.y };
  } else if (zoom.pts.size === 2) {
    const [a, b] = [...zoom.pts.values()];
    zoom.pinch = { d: dist(a, b), m: mid(a, b), s: zoom.s, x: zoom.x, y: zoom.y };
    zoom.pan = null;
    zoom.moved = true;
  }
});
viewerEl.addEventListener('pointermove', (e) => {
  if (!zoom.pts.has(e.pointerId)) return;
  zoom.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (zoom.pinch && zoom.pts.size >= 2) {
    const [a, b] = [...zoom.pts.values()];
    const m = mid(a, b);
    // Skala mengikuti jarak jari; pergeseran titik tengah ikut menggeser gambar.
    zoomAt(zoom.pinch.s * (dist(a, b) / zoom.pinch.d), zoom.pinch.m.x, zoom.pinch.m.y, zoom.pinch);
    zoom.x += m.x - zoom.pinch.m.x;
    zoom.y += m.y - zoom.pinch.m.y;
    clampZoom();
    applyZoom(false);
  } else if (zoom.pan) {
    const dx = e.clientX - zoom.pan.px;
    const dy = e.clientY - zoom.pan.py;
    if (Math.hypot(dx, dy) > 8) zoom.moved = true;
    if (zoom.s > 1) {
      zoom.x = zoom.pan.x + dx;
      zoom.y = zoom.pan.y + dy;
      clampZoom();
      applyZoom(false);
    }
  }
});
function endPointer(e) {
  if (!zoom.pts.has(e.pointerId)) return;
  zoom.pts.delete(e.pointerId);
  if (zoom.pinch && zoom.pts.size < 2) {
    zoom.pinch = null;
    if (zoom.s < 1.05) resetZoom(true);
    // Satu jari masih menempel → lanjut geser dari posisi sekarang.
    const rest = [...zoom.pts.values()][0];
    zoom.pan = rest ? { px: rest.x, py: rest.y, x: zoom.x, y: zoom.y } : null;
    return;
  }
  if (zoom.pts.size || e.type === 'pointercancel') return;
  zoom.pan = null;
  const isTap = !zoom.moved && Date.now() - zoom.downAt < 300;
  if (!isTap) return;
  const now = Date.now();
  const last = zoom.lastTap;
  if (last && now - last.t < 320 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 40) {
    // Ketuk-ganda: perbesar di titik ketukan, atau kembali ke ukuran awal.
    zoom.lastTap = null;
    if (zoom.s > 1) resetZoom(true);
    else { zoomAt(ZOOM_DOUBLE, e.clientX, e.clientY); applyZoom(true); }
    return;
  }
  zoom.lastTap = { t: now, x: e.clientX, y: e.clientY };
  // Ketukan tunggal di luar gambar (saat tidak diperbesar) menutup penampil.
  if (!zoom.downOnImg && zoom.s === 1) closeTop();
}
viewerEl.addEventListener('pointerup', endPointer);
viewerEl.addEventListener('pointercancel', endPointer);
$('#viewer .viewer-close').addEventListener('click', closeTop);

function openViewer(url) {
  resetZoom(false);
  zoom.pts.clear();
  zoom.pinch = null;
  zoom.pan = null;
  zoom.lastTap = null;
  viewerImg.src = url;
  viewerEl.hidden = false;
  pushLayer('viewer');
}
function closeViewerNow() {
  viewerEl.hidden = true;
  resetZoom(false);
  zoom.pts.clear();
}

$('#clearHistory').addEventListener('click', async () => {
  if (!confirm('Hapus semua riwayat aktivitas di aplikasi?')) return;
  try { await post('/api/clear'); toast('Riwayat dibersihkan'); closeTop(); } catch (e) { toast(`❌ ${e.message}`); }
});
$('#disconnect').addEventListener('click', () => { if (confirm('Putuskan dari PC ini?')) logout(); });

let toastTimer = null;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

// ---------- Tema (lihat theme.js) ----------
function renderThemePicker() {
  const pref = window.pcTheme ? window.pcTheme.get() : 'auto';
  $$('#themePicker button').forEach((b) => {
    const on = b.dataset.themePref === pref;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
}
$$('#themePicker button').forEach((b) => b.addEventListener('click', () => {
  window.pcTheme?.set(b.dataset.themePref);
  renderThemePicker();
}));
try { renderThemePicker(); } catch (e) { console.error(e); }

// ---------- Update aplikasi (GitHub Releases) ----------
// APK dibangun GitHub Actions dan dirilis sebagai vX.Y.N; plugin native AppUpdate mengunduh & membuka installer.
const UPDATE_REPO = 'krisna-wahyu/pc-remote-app';
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // cek otomatis maksimal tiap 6 jam (batas API GitHub)
const AppUpdate = (() => {
  let p = null;
  try { p = window.pcNative ? window.pcNative('AppUpdate') : null; } catch { p = null; }
  if (!p) return null;
  return {
    getInfo: () => p.call('getInfo'),
    canInstall: () => p.call('canInstall'),
    openInstallSettings: () => p.call('openInstallSettings'),
    downloadAndInstall: (opts) => p.call('downloadAndInstall', opts),
    addListener: (event, cb) => p.addListener(event, cb),
  };
})();
const upd = { current: '', latest: null, checking: false, installing: false, error: '' };

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
const hasUpdate = () => !!(upd.latest && upd.current && cmpVersion(upd.latest.version, upd.current) > 0);

function renderUpdate(percent) {
  const avail = hasUpdate();
  $('#appVersion').textContent = upd.current ? `v${upd.current}` : (AppUpdate ? '—' : 'versi web');
  $('#updateBadge').hidden = !avail;
  $('#updateDot').hidden = !avail;
  $('#updateCard').classList.toggle('has-update', avail);
  const btn = $('#updateBtn');
  const text = $('#updateText');
  const bar = $('#updateProgress');
  btn.classList.toggle('btn-primary', avail);
  btn.disabled = upd.checking || upd.installing || !AppUpdate;
  bar.hidden = !upd.installing;
  if (upd.installing) {
    $('#updateBar').style.width = `${percent || 0}%`;
    text.textContent = percent >= 100 ? 'Membuka installer…' : `Mengunduh v${upd.latest.version}… ${percent || 0}%`;
    btn.textContent = 'Mengunduh…';
  } else if (upd.checking) {
    text.textContent = 'Mengecek versi terbaru…';
    btn.textContent = 'Mengecek…';
  } else if (!AppUpdate) {
    text.textContent = 'Update hanya tersedia di aplikasi Android.';
    btn.textContent = 'Cek update';
  } else if (upd.error) {
    text.textContent = upd.error;
    btn.textContent = avail ? `Update sekarang (v${upd.latest.version})` : 'Cek update';
  } else if (avail) {
    const date = upd.latest.date ? ` · ${new Date(upd.latest.date).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}` : '';
    text.textContent = `Versi baru v${upd.latest.version} tersedia${date}.`;
    btn.textContent = `Update sekarang (v${upd.latest.version})`;
  } else if (upd.latest) {
    text.textContent = 'Aplikasi sudah versi terbaru.';
    btn.textContent = 'Cek update';
  } else {
    text.textContent = 'Belum dicek.';
    btn.textContent = 'Cek update';
  }
}

async function checkUpdate({ manual = false } = {}) {
  if (!AppUpdate || upd.checking || upd.installing) return;
  upd.checking = true;
  upd.error = '';
  renderUpdate();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' }, signal: ctl.signal, cache: 'no-store',
    }).finally(() => clearTimeout(timer));
    if (res.status === 404) throw new Error('Belum ada rilis di GitHub.');
    if (res.status === 403 || res.status === 429) throw new Error('Batas cek GitHub tercapai, coba lagi nanti.');
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
    const rel = await res.json();
    const asset = (rel.assets || []).find((a) => a.name === 'PC-Remote.apk') || (rel.assets || []).find((a) => /\.apk$/i.test(a.name));
    if (!asset) throw new Error('Rilis terbaru tidak berisi APK.');
    upd.latest = { version: String(rel.tag_name).replace(/^v/i, ''), url: asset.browser_download_url, date: rel.published_at };
    local.set('updateCheckedAt', String(Date.now()));
    local.set('updateLatest', JSON.stringify(upd.latest));
    if (manual && !hasUpdate()) toast('✅ Aplikasi sudah versi terbaru');
    else if (!manual && hasUpdate()) toast(`⬆️ Update v${upd.latest.version} tersedia di Pengaturan`);
  } catch (e) {
    upd.error = e.name === 'AbortError' ? 'Gagal mengecek: waktu habis.' : `Gagal mengecek: ${e.message}`;
  } finally {
    upd.checking = false;
    renderUpdate();
  }
}

async function installUpdate() {
  if (!hasUpdate() || upd.installing) return;
  const { allowed } = await AppUpdate.canInstall();
  if (!allowed) {
    upd.error = 'Izinkan "Pasang aplikasi tak dikenal" untuk PC Remote, lalu kembali dan tekan Update sekarang lagi.';
    renderUpdate();
    await AppUpdate.openInstallSettings();
    return;
  }
  upd.installing = true;
  upd.error = '';
  renderUpdate(0);
  const sub = await AppUpdate.addListener('progress', ({ percent }) => renderUpdate(percent));
  try {
    await AppUpdate.downloadAndInstall({ url: upd.latest.url });
  } catch (e) {
    upd.error = e.message || 'Gagal update.';
  } finally {
    sub.remove();
    upd.installing = false;
    renderUpdate();
  }
}

$('#updateBtn').addEventListener('click', () => (hasUpdate() ? installUpdate() : checkUpdate({ manual: true })));

async function initUpdate() {
  if (AppUpdate) {
    try { upd.current = (await AppUpdate.getInfo()).versionName || ''; } catch { /* abaikan */ }
    try { upd.latest = JSON.parse(local.get('updateLatest') || 'null'); } catch { upd.latest = null; }
  }
  renderUpdate();
  const last = Number(local.get('updateCheckedAt')) || 0;
  if (AppUpdate && Date.now() - last > UPDATE_CHECK_EVERY_MS) checkUpdate();
}
initUpdate().catch((e) => console.error(e));

// ---------- Sambung / kunci PIN / putus ----------
function showOnly(id) {
  for (const s of ['connect', 'lock', 'main']) $(`#${s}`).hidden = s !== id;
}

function showConnect(error) {
  showOnly('connect');
  $('#cfServer').value = cfg.server;
  $('#cfToken').value = '';
  const err = $('#cfError');
  err.hidden = !error;
  err.textContent = error || '';
}

// Hapus token & PIN dari HP (putus, token ditolak, atau PIN salah terlalu sering).
function logout(reason) {
  state.stream?.abort();
  state.stream = null;
  cfg.token = '';
  vault.key = null;
  local.del('token');
  local.del('vault');
  local.del('pinFails');
  state.messages.clear();
  state.seq = 0;
  feed.textContent = '';
  showConnect(reason);
}

// --- Layar PIN: mode 'unlock' | 'create' | 'confirm' ---
const pin = { mode: 'unlock', value: '', first: '', pendingToken: '', busy: false };
const PIN_MIN = 4;
const PIN_MAX = 6;

function showLock(mode, sub) {
  pin.mode = mode;
  pin.value = '';
  showOnly('lock');
  $('#lockTitle').textContent = mode === 'unlock' ? 'Masukkan PIN' : mode === 'create' ? 'Buat PIN' : 'Ulangi PIN';
  $('#lockSub').textContent = sub || (mode === 'unlock'
    ? 'PC Remote terkunci'
    : `PIN ${PIN_MIN}–${PIN_MAX} angka untuk membuka aplikasi. Token PC disimpan terenkripsi dengan PIN ini.`);
  $('#lockError').hidden = true;
  renderDots();
}
function renderDots() {
  const dots = $('#pinDots');
  dots.textContent = '';
  const n = Math.max(PIN_MIN, pin.value.length);
  for (let i = 0; i < Math.min(PIN_MAX, n); i++) {
    const d = document.createElement('i');
    if (i < pin.value.length) d.className = 'on';
    dots.appendChild(d);
  }
}
function pinError(text) {
  const e = $('#lockError');
  e.textContent = text;
  e.hidden = false;
  const dots = $('#pinDots');
  dots.classList.remove('shake');
  void dots.offsetWidth;
  dots.classList.add('shake');
  if (navigator.vibrate) navigator.vibrate(120);
  pin.value = '';
  renderDots();
}

async function submitPin() {
  if (pin.busy) return;
  if (pin.value.length < PIN_MIN) return pinError(`PIN minimal ${PIN_MIN} angka`);
  const value = pin.value;
  if (pin.mode === 'create') {
    if (/^(\d)\1+$/.test(value) || '0123456789'.includes(value) || '9876543210'.includes(value)) {
      return pinError('PIN terlalu mudah ditebak (angka sama / berurutan)');
    }
    pin.first = value;
    return showLock('confirm', 'Ketik sekali lagi untuk memastikan.');
  }
  pin.busy = true;
  try {
    if (pin.mode === 'confirm') {
      if (value !== pin.first) { pin.first = ''; showLock('create'); return pinError('PIN tidak sama, ulangi'); }
      await createVault(value, pin.pendingToken);
      cfg.token = pin.pendingToken;
      pin.pendingToken = '';
      pin.first = '';
      startMain();
      return;
    }
    // unlock
    try {
      cfg.token = await openVault(value);
      local.del('pinFails');
      if (state.started) { showOnly('main'); resumeAfterUnlock(); } else startMain();
    } catch {
      const fails = Number(local.get('pinFails') || 0) + 1;
      local.set('pinFails', String(fails));
      if (fails >= MAX_PIN_TRIES) {
        logout(`PIN salah ${MAX_PIN_TRIES}×. Token dihapus dari HP ini demi keamanan, sambungkan ulang.`);
        return;
      }
      pinError(`PIN salah. Sisa ${MAX_PIN_TRIES - fails} percobaan sebelum token dihapus.`);
    }
  } finally {
    pin.busy = false;
  }
}

$('#keypad').addEventListener('click', (e) => {
  const k = e.target.closest('button')?.dataset.k;
  if (!k) return;
  if (k === 'del') pin.value = pin.value.slice(0, -1);
  else if (k === 'ok') return submitPin();
  else if (pin.value.length < PIN_MAX) pin.value += k;
  $('#lockError').hidden = true;
  renderDots();
  if (pin.value.length === PIN_MAX) submitPin();
});

// Kunci aplikasi: token dibuang dari memori, sambungan ditutup; buka lagi dengan PIN.
function lockApp() {
  if (!vault.read()) return;
  state.stream?.abort();
  state.stream = null;
  cfg.token = '';
  vault.key = null;
  closeAllLayers();
  showLock('unlock');
}
function resumeAfterUnlock() {
  setConn('wait');
  state.retry = 0;
  loadInfo().catch(() => {});
  sync().catch(() => {});
  openStream();
}
function closeAllLayers() {
  $('#sheet').hidden = true;
  closeViewerNow();
  // Entri history lama dibiarkan; pcHandleBack hanya mundur selama masih ada lapisan tercatat.
  layers.length = 0;
}

let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
  if (cfg.token && hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) lockApp();
  hiddenAt = 0;
});

$('#lockNow').addEventListener('click', lockApp);

$('#rotateToken').addEventListener('click', async () => {
  if (!confirm('Ganti token PC Remote? Perangkat lain yang memakai token lama langsung terputus.')) return;
  try {
    const r = await post('/api/token/rotate');
    const v = vault.read();
    cfg.token = r.token;
    await sealToken(r.token, vault.key, unb64(v.salt));
    toast('🔑 Token diganti dan disimpan terenkripsi');
    closeTop();
    state.retry = 0;
    openStream();
  } catch (e) {
    toast(`❌ ${e.message}`);
  }
});

$('#connectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const server = normalizeServer($('#cfServer').value);
  const token = $('#cfToken').value.trim();
  const btn = $('#cfSubmit');
  const err = $('#cfError');
  btn.disabled = true;
  btn.textContent = 'Menghubungkan…';
  err.hidden = true;
  try {
    const health = await api('/api/health', { server, token, timeout: 8000 });
    if (health.app !== 'pc-remote-bot') throw new Error('Alamat itu bukan server PC Remote');
    await api('/api/info', { server, token, timeout: 8000 }).catch((x) => {
      throw x.status === 401 ? new Error('Token salah') : x;
    });
    cfg.server = server;
    local.set('server', server);
    pin.pendingToken = token;
    $('#cfToken').value = '';
    showLock('create');
  } catch (x) {
    err.textContent = x.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sambungkan';
  }
});

function startMain() {
  state.started = true;
  showOnly('main');
  $('#setServer').textContent = cfg.server;
  showTab('home');
  resumeAfterUnlock();
}

// Awal: sudah ada vault → minta PIN; token polos dari versi lama → buat PIN dulu; belum ada → layar sambung.
if (cfg.server && vault.read()) showLock('unlock');
else if (cfg.server && local.get('token')) { pin.pendingToken = local.get('token'); showLock('create', 'Keamanan baru: buat PIN untuk mengunci aplikasi. Token PC akan disimpan terenkripsi.'); }
else showConnect();
