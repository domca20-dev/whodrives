'use strict';
/* =====================================================================
   WhoDrives v2
   - Every group is a set of small documents (settings, members, routes,
     rides, payments, today's availability). Each document syncs on its
     own (last write wins), so two people editing different things never
     overwrite each other.
   - Without a backend configured in config.js the app is local-only.
   ===================================================================== */

const CONF = window.WHODRIVES_CONFIG || {};
const SYNC_ON = !!(CONF.supabaseUrl && CONF.supabaseKey);
const MAPY_ON = !!CONF.mapyKey;
const STORE_KEY = 'whodrives.v3';
const BONUS = { night: 1.2, sober: 1.5 };
const DEFAULT_RATES = { fuel: 2.6, amort: 1.4 };
const PALETTE = ['#1D5FA8', '#C4332C', '#2F7D4E', '#D97706', '#6B4FA0', '#BE185D', '#047857', '#7C3AED', '#0E7490', '#9A3412', '#4D7C0F', '#475569'];
const KINDS = ['Sportovní tým', 'Denní dojíždění', 'Parta přátel', 'Rodina', 'Jiné'];

/* =====================================================================
   Small helpers
   ===================================================================== */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (x, d = 1) => (+x).toLocaleString('cs-CZ', { minimumFractionDigits: d, maximumFractionDigits: d });
const plural = (n, one, few, many) => n === 1 ? one : (n >= 2 && n <= 4 ? few : many);
const pad = (n, l = 2) => String(n).padStart(l, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function rid(len = 10) {
  const a = 'abcdefghijkmnopqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(b, x => a[x % a.length]).join('');
}
function newSecret() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const SECRET_RE = /^[A-Za-z0-9_-]{32}$/;

const icons = {
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4-4 4M12 2v13"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'
};

/* =====================================================================
   Bank accounts: Czech "123-456789/0800" or IBAN → validated IBAN
   ===================================================================== */
function mod97(digits) {
  let r = 0;
  for (let i = 0; i < digits.length; i += 7) r = +(String(r) + digits.slice(i, i + 7)) % 97;
  return r;
}
const ibanDigits = s => s.replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
function ibanValid(iban) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  if (iban.startsWith('CZ') && iban.length !== 24) return false;
  return mod97(ibanDigits(iban.slice(4) + iban.slice(0, 4))) === 1;
}
function czWeights(s, w) { let t = 0; for (let i = 0; i < s.length; i++) t += +s[i] * w[i]; return t % 11 === 0; }
/** Returns { iban } on success, { error } on failure, {} for empty input. */
function parseAccount(input) {
  const s = String(input || '').replace(/\s+/g, '').toUpperCase();
  if (!s) return {};
  if (/^[A-Z]{2}/.test(s)) return ibanValid(s) ? { iban: s } : { error: 'IBAN nesedí – zkontroluj ho, prosím.' };
  const m = s.match(/^(?:(\d{1,6})-)?(\d{2,10})\/(\d{4})$/);
  if (!m) return { error: 'Zadej číslo účtu ve tvaru 123456789/0800 nebo IBAN.' };
  const prefix = (m[1] || '').padStart(6, '0'), number = m[2].padStart(10, '0'), bank = m[3];
  if (!czWeights(prefix, [10, 5, 8, 4, 2, 1]) || !czWeights(number, [6, 3, 7, 9, 10, 5, 8, 4, 2, 1])) return { error: 'Číslo účtu neprošlo kontrolou – asi je v něm překlep.' };
  const bban = bank + prefix + number;
  const check = 98 - mod97(bban + '123500');
  return { iban: `CZ${pad(check)}${bban}` };
}
function ibanToLocal(iban) {
  if (!iban || !iban.startsWith('CZ') || iban.length !== 24) return iban || '';
  const bank = iban.slice(4, 8), prefix = iban.slice(8, 14).replace(/^0+/, ''), number = iban.slice(14).replace(/^0+/, '');
  return `${prefix ? prefix + '-' : ''}${number}/${bank}`;
}

/* =====================================================================
   Validation of documents (data from other devices is untrusted)
   ===================================================================== */
const ID_RE = /^[a-z0-9]{1,24}$/;
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const n = (v, a, b, d) => { const x = +v; return Number.isFinite(x) ? clamp(x, a, b) : d; };
const ts = v => n(v, 0, 4102444800000, Date.now());
function cleanPlace(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = +p.lat, lon = +p.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { label: str(p.label, 120) || 'Místo', lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 };
}
const withPlace = (o, p) => { const pl = cleanPlace(p); if (pl) o.place = pl; return o; };
const cleanRiders = (list, driver) => {
  const riders = Array.isArray(list) ? [...new Set(list.filter(x => ID_RE.test(x)))].slice(0, 30) : [];
  if (!riders.includes(driver)) riders.unshift(driver);
  return riders;
};
const NAVS = ['mapy', 'google', 'apple', 'waze'];

function cleanDoc(key, d) {
  if (!d || typeof d !== 'object') return null;
  const [kind] = key.split(':');
  switch (kind) {
    case 'settings': {
      const r = d.rates || {};
      return { title: str(d.title, 60) || 'Skupina', kind: str(d.kind, 40), rates: { fuel: n(r.fuel, 0, 50, DEFAULT_RATES.fuel), amort: n(r.amort, 0, 50, DEFAULT_RATES.amort) } };
    }
    case 'm': {
      const name = str(d.name, 30);
      if (!name) return null;
      const iban = str(d.iban, 34).toUpperCase();
      return withPlace({ name, color: /^#[0-9a-fA-F]{6}$/.test(d.color) ? d.color : '#475569', car: !!d.car, iban: ibanValid(iban) ? iban : '', order: n(d.order, 0, 1e13, 0) }, d.place);
    }
    case 'pr': {
      const label = str(d.label, 40);
      return label ? withPlace({ label, km: Math.round(n(d.km, 1, 5000, 10)), order: n(d.order, 0, 1e13, 0) }, d.place) : null;
    }
    case 'r': {
      if (!ID_RE.test(d.driver)) return null;
      const r = { driver: d.driver, riders: cleanRiders(d.riders, d.driver), km: Math.round(n(d.km, 1, 5000, 1)), label: str(d.label, 40) || 'Jízda', night: !!d.night, sober: !!d.sober, ts: ts(d.ts) };
      if (d.auto) r.auto = true;
      return r;
    }
    case 't': { // a ride in progress (planned route, navigation running)
      if (!ID_RE.test(d.driver)) return null;
      const end = cleanPlace(d.end);
      if (!end) return null;
      const stops = (Array.isArray(d.stops) ? d.stops : []).slice(0, 12)
        .map(s => (s && ID_RE.test(s.id) && cleanPlace(s)) ? { id: s.id, ...cleanPlace(s), eta: Math.round(n(s.eta, 0, 6000, 0) * 10) / 10 } : null).filter(Boolean);
      const t0 = ts(d.ts);
      return {
        dep: n(d.dep, 0, 4102444800000, t0), planned: !!d.planned,
        driver: d.driver, riders: cleanRiders(d.riders, d.driver), start: cleanPlace(d.start), stops, end,
        km: Math.round(n(d.km, 0, 5000, 0) * 10) / 10, mins: Math.round(n(d.mins, 0, 6000, 0) * 10) / 10, back: !!d.back,
        label: str(d.label, 40) || 'Jízda', night: !!d.night, sober: !!d.sober,
        nav: NAVS.includes(d.nav) ? d.nav : 'mapy', legs: !!d.legs, leg: Math.round(n(d.leg, 0, 20, 0)), ts: ts(d.ts)
      };
    }
    case 'p': {
      if (!ID_RE.test(d.from) || !ID_RE.test(d.to) || d.from === d.to) return null;
      return { from: d.from, to: d.to, km: n(d.km, 0, 100000, 0), kc: Math.round(n(d.kc, 0, 1e7, 0)), ts: ts(d.ts) };
    }
    case 'off': case 'c': return { on: !!d.on };
    default: return null;
  }
}
const validKey = k => typeof k === 'string' && k.length <= 64 && /^(settings|(m|pr|r|p|c|t):[a-z0-9]{1,24}|off:\d{4}-\d{2}-\d{2}:[a-z0-9]{1,24})$/.test(k);

/* =====================================================================
   Storage
   ===================================================================== */
// store = { current, groups: { [gid]: { id, secret, created, demo, rev, syncedAt, docs: { [key]: { d, del, dirty } } } } }
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.groups && typeof s.groups === 'object') return s;
  } catch (e) {}
  return { current: null, groups: {} };
}
let store = loadStore();
let saveFailed = false;
function persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); saveFailed = false; }
  catch (e) { if (!saveFailed) toast('⚠️ Nepodařilo se uložit data do prohlížeče.'); saveFailed = true; }
}

const grp = () => store.groups[store.current] || null;
function docsOf(g, prefix) {
  const out = [];
  for (const [k, v] of Object.entries(g.docs)) if (!v.del && v.d && k.startsWith(prefix)) out.push({ k, id: k.slice(prefix.length), ...v.d });
  return out;
}
function put(key, data, g = grp()) {
  const d = cleanDoc(key, data);
  if (!d) return;
  g.docs[key] = { d, del: false, dirty: true };
  persist(); scheduleSync();
}
function del(key, g = grp()) {
  g.docs[key] = { d: null, del: true, dirty: true };
  persist(); scheduleSync();
}

/* ---------- Derived group data ---------- */
const settings = () => grp().docs.settings?.d || { title: 'Skupina', kind: '', rates: { ...DEFAULT_RATES } };
const rates = () => { const r = settings().rates; return { ...r, total: r.fuel + r.amort }; };
const members = () => docsOf(grp(), 'm:').sort((a, b) => a.order - b.order);
const presets = () => docsOf(grp(), 'pr:').sort((a, b) => a.order - b.order);
const rides = () => docsOf(grp(), 'r:');
const payments = () => docsOf(grp(), 'p:');
const GHOST = { id: '?', name: 'Neznámý', color: '#94A3B8', car: false };
const M = id => members().find(m => m.id === id) || { ...GHOST, id };
const offToday = () => new Set(docsOf(grp(), `off:${ymd()}:`).filter(x => x.on).map(x => x.id));
const committed = () => new Set(docsOf(grp(), 'c:').filter(x => x.on).map(x => x.id));

/* ---------- Who is holding this phone (stored only on this device) ---------- */
const ME_KEY = 'whodrives.me', ME_SKIP = 'whodrives.meSkip';
const readMap = k => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch (e) { return {}; } };
const writeMap = (k, m) => { try { localStorage.setItem(k, JSON.stringify(m)); } catch (e) {} };
function meId(g = grp()) {
  const id = g && readMap(ME_KEY)[g.id];
  return id && g.docs['m:' + id]?.d && !g.docs['m:' + id].del ? id : null;
}
function setMe(id, g = grp()) {
  const m = readMap(ME_KEY);
  if (id) m[g.id] = id; else delete m[g.id];
  writeMap(ME_KEY, m);
}
const meSkipped = (g = grp()) => !!readMap(ME_SKIP)[g.id];
const youTag = id => (id && id === meId() ? ' <span class="tag you">ty</span>' : '');

/* =====================================================================
   Domain logic
   ===================================================================== */
const value = r => r.km * (r.night ? BONUS.night : 1) * (r.sober ? BONUS.sober : 1);
const kcVal = v => Math.round(Math.abs(v) * rates().total);
const kc = v => `${kcVal(v).toLocaleString('cs-CZ')} Kč`;
const kcFmt = x => `${Math.round(x).toLocaleString('cs-CZ')} Kč`;
function kmFmt(v, sign = true) {
  const r = Math.round(Math.abs(v));
  const prefix = sign && r > 0 ? (v > 0 ? '+' : '−') : '';
  return `${prefix}${r} km`;
}

function balances() {
  const b = {};
  members().forEach(m => (b[m.id] = 0));
  rides().forEach(r => {
    const v = value(r);
    if (r.riders.length < 2) return;
    b[r.driver] = (b[r.driver] || 0) + v;
    r.riders.forEach(id => (b[id] = (b[id] || 0) - v / r.riders.length));
  });
  payments().forEach(p => { b[p.from] = (b[p.from] || 0) + p.km; b[p.to] = (b[p.to] || 0) - p.km; });
  return b;
}

function nextDriver() {
  const b = balances(), off = offToday();
  return members().filter(m => m.car && !off.has(m.id)).sort((x, y) => b[x.id] - b[y.id] || x.order - y.order)[0];
}

function reason(m) {
  const b = balances();
  const parts = [`Má nejnižší bilanci ze všech, kdo dnes můžou (${kmFmt(b[m.id])}).`];
  const out = members().filter(x => offToday().has(x.id)).map(x => x.name);
  if (out.length) parts.push(`${out.join(' a ')} dnes ${out.length > 1 ? 'nemůžou' : 'nemůže'}.`);
  return parts.join(' ');
}

function ecoStats() {
  const rs = rides().filter(r => r.riders.length >= 2), ms = members();
  const totalKm = rs.reduce((a, r) => a + r.km, 0);
  let savedTrips = 0, savedKm = 0;
  rs.forEach(r => {
    const extra = Math.max(0, r.riders.filter(id => ms.find(m => m.id === id)?.car).length - 1);
    savedTrips += extra; savedKm += extra * r.km;
  });
  return { totalKm, savedTrips, savedCo2: Math.round(savedKm * 0.14) };
}

function plan() {
  const b = balances(), ms = members();
  const deb = ms.filter(m => b[m.id] < -0.5).map(m => ({ id: m.id, v: -b[m.id] })).sort((x, y) => y.v - x.v);
  const cre = ms.filter(m => b[m.id] > 0.5).map(m => ({ id: m.id, v: b[m.id] })).sort((x, y) => y.v - x.v);
  const out = [];
  let i = 0, j = 0;
  while (i < deb.length && j < cre.length) {
    const v = Math.min(deb[i].v, cre[j].v);
    if (v >= 0.5) out.push({ from: deb[i].id, to: cre[j].id, v });
    deb[i].v -= v; cre[j].v -= v;
    if (deb[i].v < 0.5) i++;
    if (cre[j].v < 0.5) j++;
  }
  return out;
}

function dateLabel(t) {
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  const showTime = !(d.getHours() === 12 && d.getMinutes() === 0);
  if (ymd(d) === ymd(now)) return showTime ? `Dnes ${time}` : 'Dnes';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (ymd(d) === ymd(y)) return showTime ? `Včera ${time}` : 'Včera';
  return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/* =====================================================================
   Groups: create, demo, leave
   ===================================================================== */
function newGroup({ demo = false } = {}) {
  const id = 'g' + rid(8);
  const shared = SYNC_ON && !demo;
  const g = { id, secret: shared ? newSecret() : null, enc: shared, created: !shared, demo, rev: 0, syncedAt: 0, docs: {} };
  store.groups[id] = g;
  return g;
}

function createGroup({ title, kind, myName, myCar }) {
  const g = newGroup();
  const ord = Date.now();
  g.docs.settings = { d: cleanDoc('settings', { title, kind, rates: DEFAULT_RATES }), dirty: true };
  const myId = rid();
  g.docs['m:' + myId] = { d: cleanDoc('m:x', { name: myName, color: PALETTE[0], car: myCar, order: ord }), dirty: true };
  store.current = g.id;
  setMe(myId, g);
  persist(); scheduleSync();
  return g;
}

function createDemo() {
  const day = 864e5, now = Date.now();
  const noon = dAgo => { const d = new Date(now - dAgo * day); d.setHours(dAgo ? 12 : d.getHours(), 0, 0, 0); return d.getTime(); };
  const make = (title, kind, ms, prs, rs, off) => {
    const g = newGroup({ demo: true });
    const docs = g.docs, ids = {};
    docs.settings = { d: cleanDoc('settings', { title, kind, rates: DEFAULT_RATES }) };
    ms.forEach(([key, name, color, car, place], i) => { ids[key] = rid(); docs['m:' + ids[key]] = { d: cleanDoc('m:x', { name, color, car, order: i, iban: car ? 'CZ6508000000192000145399' : '', place }) }; });
    prs.forEach(([label, km, place], i) => { docs['pr:' + rid()] = { d: cleanDoc('pr:x', { label, km, order: i, place }) }; });
    rs.forEach(([ago, label, km, drv, riders, night, sober]) => {
      docs['r:' + rid()] = { d: cleanDoc('r:x', { label, km, driver: ids[drv], riders: riders.map(x => ids[x]), night, sober, ts: noon(ago) }) };
    });
    off.forEach(k => { docs[`off:${ymd()}:${ids[k]}`] = { d: { on: true } }; });
    setMe(ids.dom, g);
    return g;
  };
  const a = make('Florbal – Trénink čtvrtek', 'Sportovní tým',
    [['dom', 'Adam', '#1D5FA8', true, { label: 'Náměstí Míru, Praha', lat: 50.07548, lon: 14.43754 }],
     ['dav', 'Tomáš', '#C4332C', true, { label: 'Anděl, Praha', lat: 50.07106, lon: 14.40363 }],
     ['mic', 'Michal', '#2F7D4E', true, { label: 'Dejvická, Praha', lat: 50.10027, lon: 14.39303 }],
     ['ste', 'Ondra', '#D97706', true, { label: 'Palmovka, Praha', lat: 50.10431, lon: 14.47474 }],
     ['jan', 'Jakub', '#6B4FA0', false, { label: 'Florenc, Praha', lat: 50.09051, lon: 14.43853 }]],
    [['Trénink hala', 24, { label: 'Sportovní hala, Strahov', lat: 50.08063, lon: 14.38757 }], ['Venkovní zápas', 68], ['Soustředění', 145], ['Týmová večeře', 18]],
    [[0, 'Trénink hala', 24, 'dom', ['dom', 'dav', 'mic', 'jan']], [3, 'Venkovní zápas', 68, 'dom', ['dom', 'dav', 'ste', 'jan']],
     [7, 'Týmová oslava', 28, 'dom', ['dom', 'mic', 'ste', 'jan'], true, true], [14, 'Trénink hala', 24, 'ste', ['ste', 'dav', 'mic', 'jan']],
     [21, 'Trénink hala', 24, 'dav', ['dav', 'dom', 'mic', 'ste', 'jan']]],
    ['dav']);
  make('Dojíždění do školy a práce', 'Denní dojíždění',
    [['dom', 'Adam', '#1D5FA8', true], ['kl', 'Klára', '#BE185D', true], ['ma', 'Matěj', '#047857', true], ['lu', 'Lukáš', '#7C3AED', false]],
    [['Domů → škola', 22], ['Návrat večer', 25], ['Knihovna', 30]],
    [[1, 'Domů → škola', 22, 'kl', ['kl', 'dom', 'ma', 'lu']], [2, 'Domů → škola', 22, 'kl', ['kl', 'dom', 'lu']], [4, 'Návrat večer', 25, 'dom', ['dom', 'kl', 'ma'], true]],
    []);
  store.current = a.id;
  persist();
}

function leaveGroup(id) {
  delete store.groups[id];
  if (store.current === id) store.current = Object.keys(store.groups)[0] || null;
  persist();
}

/* =====================================================================
   Sync (Supabase RPC over plain fetch – no third-party JS)
   ===================================================================== */
const sync = { state: 'idle', timer: null, running: false, again: false };

/* ---------- End-to-end encryption ----------
   The invite secret itself never reaches the server. From it we derive
   (HKDF-SHA256) a login token for the server and an AES-GCM key for the
   documents, so the database only ever stores ciphertext.
   Groups created before this (g.enc falsy) keep working unencrypted. */
const te = new TextEncoder(), td = new TextDecoder();
const b64u = buf => { let s = ''; new Uint8Array(buf).forEach(b => (s += String.fromCharCode(b))); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const keyCache = new Map();
async function groupKeys(g) {
  if (!g.enc) return { auth: g.secret, key: null };
  if (keyCache.has(g.secret)) return keyCache.get(g.secret);
  const base = await crypto.subtle.importKey('raw', te.encode(g.secret), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const salt = te.encode('whodrives/v2');
  const auth = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('auth') }, base, 192);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('data') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const out = { auth: b64u(auth), key };
  keyCache.set(g.secret, out);
  return out;
}
async function seal(keys, k, d) {
  if (!keys.key || d == null) return d;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // the document key is bound as associated data, so ciphertexts can't be swapped between documents
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(k) }, keys.key, te.encode(JSON.stringify(d))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return { e: b64u(out) };
}
async function unseal(keys, k, d) {
  if (!keys.key) return d;
  if (!d || typeof d.e !== 'string' || d.e.length > 8000) return null;
  try {
    const raw = unb64u(d.e);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: te.encode(k) }, keys.key, raw.slice(12));
    return JSON.parse(td.decode(pt));
  } catch (e) { return null; } // tampered or foreign data – ignore
}

async function rpc(fn, args) {
  const headers = { 'Content-Type': 'application/json', apikey: CONF.supabaseKey };
  if (CONF.supabaseKey.startsWith('eyJ')) headers.Authorization = `Bearer ${CONF.supabaseKey}`;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(`${CONF.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args), signal: ctl.signal, cache: 'no-store', referrerPolicy: 'no-referrer' });
    const body = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(body?.message || res.statusText); e.status = res.status; e.code = body?.code; throw e; }
    return body;
  } finally { clearTimeout(to); }
}

function scheduleSync(delay = 500) {
  if (!SYNC_ON) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(runSync, delay);
}

async function runSync() {
  if (!SYNC_ON) return;
  if (sync.running) { sync.again = true; return; }
  const g = grp();
  if (!g || !g.secret) return;
  sync.running = true;
  setSyncState('busy');
  let changed = false;
  try {
    const keys = await groupKeys(g);
    if (!g.created) {
      await rpc('wd_create_group', { p_secret: keys.auth });
      g.created = true; persist();
    }
    // push local changes
    const dirty = Object.entries(g.docs).filter(([, v]) => v.dirty);
    for (let i = 0; i < dirty.length; i += 100) {
      const chunk = dirty.slice(i, i + 100);
      const docs = await Promise.all(chunk.map(async ([k, v]) => ({ k, d: v.del ? null : await seal(keys, k, v.d), del: !!v.del })));
      await rpc('wd_push', { p_secret: keys.auth, p_docs: docs });
      chunk.forEach(([k, v]) => { if (g.docs[k] === v) v.dirty = false; });
      persist();
    }
    // pull everything newer than what we have
    for (let page = 0; page < 50; page++) {
      const res = await rpc('wd_pull', { p_secret: keys.auth, p_since: g.rev || 0 });
      for (const row of res.docs || []) {
        if (!validKey(row.k)) continue;
        const local = g.docs[row.k];
        if (local && local.dirty) continue; // our newer edit wins, it is pushed next round
        if (row.del) { if (local && !local.del) changed = true; g.docs[row.k] = { d: null, del: true }; continue; }
        const d = cleanDoc(row.k, await unseal(keys, row.k, row.d));
        if (!d) continue;
        if (!local || JSON.stringify(local.d) !== JSON.stringify(d)) changed = true;
        g.docs[row.k] = { d, del: false };
      }
      g.rev = Math.max(g.rev || 0, +res.rev || 0);
      if (!res.more) break;
    }
    g.syncedAt = Date.now();
    if (g.joining) { delete g.joining; changed = true; }
    persist();
    setSyncState('ok');
  } catch (e) {
    if (e.status === 404 || e.code === 'P0002') {
      if (g.joining) { leaveGroup(g.id); toast('Odkaz na skupinu je neplatný nebo skupina neexistuje.'); changed = true; }
      setSyncState('err', 'Skupina na serveru neexistuje');
    } else setSyncState('err', navigator.onLine ? 'Synchronizace selhala, zkusím to znovu' : 'Offline – změny se odešlou později');
    console.warn('sync', e);
  } finally {
    sync.running = false;
    if (changed) render();
    if (sync.again) { sync.again = false; scheduleSync(300); }
  }
}

function setSyncState(s, msg = '') {
  sync.state = s; sync.msg = msg;
  const el = document.getElementById('syncLine');
  if (el) el.outerHTML = syncLineHtml();
  renderHeader();
}
function syncLineHtml() {
  const g = grp();
  if (!g || !g.secret) return '';
  const dirty = Object.values(g.docs).some(v => v.dirty);
  let cls = 'ok', txt = g.syncedAt ? `Synchronizováno ${new Date(g.syncedAt).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}` : 'Zatím nesynchronizováno';
  if (sync.state === 'busy') { cls = 'busy'; txt = 'Synchronizuji…'; }
  else if (sync.state === 'err') { cls = 'err'; txt = sync.msg; }
  else if (dirty) { cls = 'busy'; txt = 'Čeká na odeslání'; }
  return `<div class="sync-line" id="syncLine"><span class="dot ${cls}"></span>${esc(txt)}</div>`;
}

if (SYNC_ON) {
  setInterval(() => { if (document.visibilityState === 'visible') runSync(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(50); });
  addEventListener('online', () => scheduleSync(50));
}

/* =====================================================================
   Sharing helpers
   ===================================================================== */
const inviteUrl = g => `${location.origin}${location.pathname}#${g.enc ? 'g' : 'join'}=${g.secret}`;
/** Addresses are only stored where they stay private: local/demo groups or end-to-end encrypted ones. */
const addrAllowed = (g = grp()) => !!g && (!g.secret || !!g.enc);
const mapsReady = (g = grp()) => MAPY_ON && addrAllowed(g);
const canShareLinks = () => SYNC_ON && /^https?:$/.test(location.protocol);

async function shareText({ title, text, url }) {
  const full = url ? `${text}\n${url}` : text;
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  openShareSheet(title, full);
  return false;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('📋 Zkopírováno'); }
  catch (e) { toast('Kopírování se nepovedlo – označ text a zkopíruj ručně.'); }
}

async function qrPng(svgText, caption) {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 720; c.height = 840;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.imageSmoothingEnabled = false;
  x.drawImage(img, 60, 50, 600, 600);
  x.fillStyle = '#1A1D21'; x.textAlign = 'center';
  x.font = '800 40px system-ui, sans-serif';
  x.fillText(caption[0], 360, 720);
  x.font = '500 28px system-ui, sans-serif'; x.fillStyle = '#5E6672';
  x.fillText(caption[1], 360, 770);
  return new Promise(r => c.toBlob(r, 'image/png'));
}

/* =====================================================================
   Views
   ===================================================================== */
let tab = 'home';
const av = (m, cls = '') => `<span class="av ${cls}" style="background:${esc(m.color)}" aria-hidden="true">${esc(m.name[0])}</span>`;

function renderHeader() {
  const g = grp();
  const list = Object.values(store.groups);
  $('#grpList').innerHTML = list.map(x => {
    const s = x.docs.settings?.d || { title: x.joining ? 'Načítám skupinu…' : 'Skupina', kind: '' };
    return `<button class="grp-opt" data-act="switch-grp" data-key="${esc(x.id)}" type="button" aria-current="${x.id === store.current}">
      <span>${esc(s.title)}</span><small>${x.demo ? 'ukázka' : esc(s.kind)}</small>
    </button>`;
  }).join('') + `<button class="grp-opt new" data-act="new-group" type="button">＋ Nová skupina</button>`;
  const dark = document.documentElement.dataset.theme === 'dark';
  $('#themeBtn').innerHTML = dark ? icons.sun : icons.moon;
  $('#themeBtn').setAttribute('aria-label', dark ? 'Přepnout na světlý režim' : 'Přepnout na tmavý režim');
  const cnt = $('#settleCount');
  if (!g || g.joining) {
    $('#grpTitle').textContent = g ? 'Načítám skupinu…' : 'WhoDrives';
    $('#grpSub').textContent = g ? 'Chvilku strpení' : 'Kdo dnes řídí';
    cnt.hidden = true;
    return;
  }
  const s = settings(), nm = members().length;
  $('#grpTitle').textContent = s.title;
  const extra = g.demo ? 'ukázka' : (g.secret && sync.state === 'err' ? 'offline' : s.kind);
  $('#grpSub').textContent = `${nm} ${plural(nm, 'člen', 'členové', 'členů')}${extra ? ' • ' + extra : ''}`;
  const pc = plan().length;
  cnt.hidden = !pc; cnt.textContent = pc;
}

function renderOnboard() {
  return `<div class="onboard">
    <div class="logo" aria-hidden="true"><svg class="wd-icon" viewBox="68 -724 476 476" aria-hidden="true"><g transform="scale(1 -1)"><path d="M174.9141 724L437.0859 724C496.133 724 544 676.133 544 617.0859L544 354.9141C544 295.867 496.133 248 437.0859 248L174.9141 248C115.867 248 68 295.867 68 354.9141L68 617.0859C68 676.133 115.867 724 174.9141 724Z" fill="#FF6B00"/><path d="M129.3594 557.5859L167.4394 557.5859L187.6694 464.7659L213.8494 557.5859L253.1194 557.5859L279.2994 464.7659L299.5294 557.5859L337.6094 557.5859L297.1494 414.7859L256.6894 414.7859L233.4844 504.0359L210.2794 414.7859L169.8194 414.7859Z" fill="#111111"/><path d="M345.9394 557.5859L411.3894 557.5859C450.8226 557.5859 482.7894 525.619 482.7894 486.1859C482.7894 446.7528 450.8226 414.7859 411.3894 414.7859L305.4794 414.7859ZM374.4994 524.2659L410.1994 524.2659C431.2304 524.2659 448.2794 507.217 448.2794 486.1859C448.2794 465.155 431.2304 448.1059 410.1994 448.1059L353.0794 448.1059Z" fill="#111111" fill-rule="evenodd"/></g></svg></div>
    <h2>Kdo dnes řídí?</h2>
    <p>Appka hlídá, kdo kolik odřídil, a férově vybere dalšího řidiče. Kdo nemá auto, dorovná to QR platbou.</p>
    <button class="btn primary" data-act="new-group" type="button">Založit skupinu</button>
    <button class="btn outline block" data-act="demo" type="button">Vyzkoušet na ukázkových datech</button>
    ${SYNC_ON ? '' : '<span class="hint" style="margin-top:16px">Data se zatím ukládají jen v tomhle prohlížeči.</span>'}
  </div>`;
}

function renderHome() {
  const ms = members();
  if (ms.length < 2 || !ms.some(m => m.car)) {
    return `<div class="empty"><span class="big">👋</span><b>Skupina je skoro připravená</b>
      ${ms.length < 2 ? 'Přidej ostatní členy party' : 'Aspoň jeden člen musí mít auto'} – pak appka začne vybírat řidiče.
      <div style="margin-top:16px"><button class="btn primary" data-act="add-member" type="button">＋ Přidat člena</button></div>
      ${grp().secret && canShareLinks() ? `<div style="margin-top:8px"><button class="btn outline block" data-act="invite" type="button">Pozvat ostatní odkazem</button></div>` : ''}
    </div>`;
  }
  const b = balances();
  const nd = nextDriver();
  const off = offToday();
  const max = Math.max(...Object.values(b).map(Math.abs), 1);
  const sorted = [...ms].sort((x, y) => b[y.id] - b[x.id]);
  const eco = ecoStats();

  const me = meId(), g = grp();
  const whoCard = !me && !g.demo && !meSkipped() ? `
  <section class="card me-card">
    <div class="me-head"><h4>👋 Kdo z vás jsi?</h4><button class="close-x" data-act="me-skip" type="button" aria-label="Teď ne">${icons.x}</button></div>
    <p>Appka ti pak ukáže tvoji bilanci a v kolik tě kdo vyzvedne. Uloží se jen v tomhle telefonu.</p>
    <div class="chips" style="margin-top:10px">${ms.map(m => `<button class="chip" data-act="set-me" data-id="${m.id}" type="button">${av(m)}<span class="nm">${esc(m.name)}</span></button>`).join('')}
      <button class="chip" data-act="me-new" type="button">＋ <span class="nm">Nejsem tu</span></button></div>
  </section>` : '';
  const hero = nd ? `
  <section class="today" aria-label="Dnešní řidič">
    <div class="lbl-row">
      <span class="lbl">🎯 Dnes bere auto</span>
      <button class="nudge-btn" data-act="nudge" data-id="${nd.id}" type="button">${icons.share} Poslat partě</button>
    </div>
    <div class="who">
      ${av(nd)}
      <div><span class="big">${nd.id === me ? 'Ty 🙂' : esc(nd.name)}</span><small>${nd.id === me ? `${esc(nd.name)}, jsi na řadě – férově podle ujetých km` : 'Férová volba podle ujetých km'}</small></div>
    </div>
    <p class="why">${esc(reason(nd))}</p>
    <div class="acts">
      ${mapsReady()
        ? `<button class="btn dark" data-act="trip" type="button">🧭 Vyrazit</button>
           <button class="btn ghost" data-act="log" type="button">Zapsat</button>`
        : `<button class="btn dark" data-act="log" type="button">＋ Zapsat dnešní jízdu</button>`}
      <button class="btn ghost" data-act="cant" data-id="${nd.id}" type="button">Nemůže</button>
    </div>
  </section>` : `
  <section class="today" aria-label="Dnešní řidič">
    <div class="lbl-row"><span class="lbl">⚠️ Dnes nikdo</span></div>
    <p class="why" style="margin:12px 0 0">Nikdo s autem není dostupný. Klepni níže na toho, kdo nakonec auto vzít může.</p>
  </section>`;

  return `
  ${whoCard}
  ${hero}
  <div class="eco-bar" title="Společný přínos skupiny díky tomu, že nejezdíte víc auty naráz">
    <div class="eco-item"><b>${eco.totalKm.toLocaleString('cs-CZ')} km</b><small>ujeto společně</small></div>
    <div class="eco-item"><b>${eco.savedTrips}×</b><small>auto zůstalo doma</small></div>
    <div class="eco-item"><b>−${eco.savedCo2} kg</b><small>CO₂ ušetřeno</small></div>
  </div>

  <div class="sec"><span>Kdo dnes může řídit</span><small>Klepni pro změnu</small></div>
  <div class="chips">${ms.map(m => m.car
    ? `<button class="chip strike ${off.has(m.id) ? 'off' : 'on'}" data-act="avail" data-id="${m.id}" type="button" aria-pressed="${!off.has(m.id)}">${av(m)}<span class="nm">${esc(m.name)}</span></button>`
    : `<span class="chip nocar">${av(m)}<span class="nm">${esc(m.name)}</span><span class="badge">bez auta</span></span>`).join('')}
  </div>

  <div class="sec"><span>Bilance kilometrů</span><small>Bez peněz a hádek</small></div>
  <div class="list">${sorted.map(m => {
    const v = b[m.id];
    const w = Math.abs(v) / max * 50;
    let status = 'Vyrovnané kilometry';
    if (v > 5) status = 'Odřízeno víc, než bylo nutné';
    else if (v < -5 && m.car) status = 'Má co dohánět za volantem';
    else if (v < -5) status = 'Bez auta → vyrovná přes QR';
    return `<div class="row${m.id === me ? ' me' : ''}">
      ${av(m)}
      <div class="main">
        <b>${esc(m.name)}${youTag(m.id)}${!m.car ? ' <span class="tag nocar">bez auta</span>' : ''}</b>
        <small>${status}</small>
        <div class="bar" aria-hidden="true"><i style="background:${v >= 0 ? 'var(--pos)' : 'var(--neg)'};${v >= 0 ? 'left' : 'right'}:50%;width:${w}%"></i></div>
      </div>
      <div class="val ${v > 0.5 ? 'pos' : v < -0.5 ? 'neg' : ''}">
        ${kmFmt(v)}
        <small>${v > 0.5 ? 'odřízeno navíc' : v < -0.5 ? (m.car ? 'má odřídit' : 'k vyrovnání') : 'na nule'}</small>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderRides() {
  const items = [
    ...rides().map(r => ({ t: 'r', ...r })),
    ...payments().map(p => ({ t: 'p', ...p }))
  ].sort((a, b) => b.ts - a.ts);
  if (!items.length) return `<div class="empty"><span class="big">🚗</span><b>Zatím žádné jízdy</b>Zapiš první jízdu tlačítkem dole.</div>`;
  return `
  <div class="sec"><span>Historie</span><small>Klepnutím upravíš</small></div>
  <div class="list">${items.map(r => {
    if (r.t === 'r') {
      const d = M(r.driver);
      const wKm = Math.round(value(r));
      const bonus = r.night || r.sober;
      const passengers = r.riders.filter(i => i !== r.driver);
      return `<button class="row row-btn" data-act="edit-ride" data-k="${esc(r.k)}" type="button">
        ${av(d)}
        <span class="main">
          <b>${esc(r.label)}${r.night ? ' <span class="tag">🌙 noc ×1,2</span>' : ''}${r.sober ? ' <span class="tag sober">🥤 nepil ×1,5</span>' : ''}</b>
          <small>${esc(dateLabel(r.ts))} • řidič ${esc(d.name)}${r.auto ? ' • 📍 zapsáno samo' : ''}</small>
        </span>
        <span class="val">
          <span class="stack" title="${esc(passengers.map(i => M(i).name).join(', '))}">${passengers.map(i => av(M(i))).join('')}</span>
          <small>${r.km} km${bonus ? ` → ${wKm} km` : ''}</small>
        </span>
      </button>`;
    }
    const f = M(r.from), to = M(r.to);
    return `<button class="row row-btn" data-act="edit-pay" data-k="${esc(r.k)}" type="button">
      ${av(f)}
      <span class="main">
        <b>Vyrovnáno přes QR <span class="tag ok">✓ zaplaceno</span></b>
        <small>${esc(dateLabel(r.ts))} • ${esc(f.name)} → ${esc(to.name)} (${kcFmt(r.kc)})</small>
      </span>
      <span class="val pos">${kmFmt(r.km)}</span>
    </button>`;
  }).join('')}</div>`;
}

function renderSettle() {
  const p = plan();
  if (!p.length) return `<div class="empty"><span class="big">🎉</span><b>Všechno je vyrovnané</b>Nikdo nikomu nedluží ani kilometr.</div>`;
  const com = committed();
  return `
  <div class="sec"><span>Jak srovnat kilometry</span><small>Řidiči odřídí, ostatní QR</small></div>
  ${p.map((s, idx) => {
    const f = M(s.from), to = M(s.to);
    return `<div class="settle">
      <div class="line">
        ${av(f)}<span class="nm">${esc(f.name)}</span>
        <span class="arrow">dluží <b>${kmFmt(s.v, false)}</b> →</span>
        <span class="nm">${esc(to.name)}</span>${av(to)}
      </div>
      ${f.car ? `
        <div class="sub-info">🚗 <b>${esc(f.name)} má auto</b> – dluh prostě odřídí při dalších jízdách.</div>
        <div class="opts">
          ${com.has(s.from)
            ? `<button class="done" type="button" disabled><b>✓ Domluveno</b>odřídí příště</button>`
            : `<button class="primary-opt" data-act="drive" data-i="${idx}" type="button"><b>🚗 Odřídí příště</b>${kmFmt(s.v, false)} za volantem</button>`}
          <button data-act="qr" data-i="${idx}" type="button" title="Jen pokud teď auto nemá (servis, prodej…)"><b>📱 Zaplatit QR</b>${kc(s.v)} • nouzově</button>
        </div>` : `
        <div class="sub-info">🎒 <b>${esc(f.name)} nemá auto</b> – kilometry vrátit nemůže, takže uhradí náklady.</div>
        <div class="opts">
          <button class="qr-opt" data-act="qr" data-i="${idx}" type="button"><b>📱 QR platba ${kc(s.v)}</b>palivo + amortizace za ${kmFmt(s.v, false)}</button>
        </div>`}
    </div>`;
  }).join('')}`;
}

function renderGroup() {
  const g = grp(), s = settings(), ms = members(), prs = presets(), r = rates();
  let share = '';
  if (g.demo) share = `<div class="card"><h4>🧪 Ukázková skupina</h4><p>Slouží jen k vyzkoušení a nesdílí se. Pro svou partu založ novou skupinu.</p>
      <div class="acts"><button class="btn primary" data-act="new-group" type="button">Založit vlastní skupinu</button></div></div>`;
  else if (canShareLinks() && g.secret) share = `<div class="card invite"><h4>🔗 Pozvat do skupiny</h4>
      <p>Pošli odkaz partě do WhatsAppu. Kdo ho otevře, uvidí stejná data a může zapisovat jízdy. Odkaz posílej jen lidem z party.</p>
      <div class="acts"><button class="btn primary" data-act="invite" type="button">${icons.share.replace('<svg', '<svg width="16" height="16" style="vertical-align:-3px;margin-right:6px"')}Sdílet odkaz</button></div>
      ${syncLineHtml()}</div>`;
  else share = `<div class="card"><h4>📱 Jen v tomhle zařízení</h4><p>${SYNC_ON ? 'Sdílení odkazem funguje, až bude appka nahraná na webu (https).' : 'Sdílení mezi telefony zatím není zapnuté. Data jsou uložená jen v tomhle prohlížeči.'}</p></div>`;
  if (g.secret && !g.enc) share += `<div class="card" style="margin-top:10px"><h4>🔒 Starší skupina bez šifrování</h4>
      <p>Adresy a plánování tras fungují jen v šifrovaných skupinách. Převodem vznikne kopie se šifrováním a novým odkazem, který pak pošleš partě.</p>
      <div class="acts"><button class="btn primary" data-act="convert-enc" type="button">Převést na šifrovanou</button></div></div>`;
  const showAddr = mapsReady(g) || ms.some(m => m.place);

  return `
  ${share}

  <div class="sec"><span>Skupina</span></div>
  <div class="list">
    <button class="row row-btn" data-act="edit-settings" type="button">
      <span class="main"><b>${esc(s.title)}</b><small>${esc(s.kind || 'Bez typu')}</small></span>${icons.chev}
    </button>
  </div>

  <div class="sec"><span>Členové party</span><small>${ms.length} ${plural(ms.length, 'člověk', 'lidé', 'lidí')}</small></div>
  <div class="list">${ms.map(m => `
    <button class="row row-btn" data-act="edit-member" data-id="${m.id}" type="button">
      ${av(m)}
      <span class="main">
        <b>${esc(m.name)}${youTag(m.id)}</b>
        <small>${m.car ? '🚗 Má auto' : '🎒 Bez auta'}${m.car ? (m.iban ? ' • účet vyplněný' : ' • <span class="neg">chybí účet pro QR</span>') : ''}${showAddr ? (m.place ? ' • 📍 adresa' : ' • bez adresy') : ''}</small>
      </span>${icons.chev}
    </button>`).join('')}
    <button class="row row-btn add" data-act="add-member" type="button">＋ Přidat člena</button>
  </div>

  <div class="sec"><span>Oblíbené trasy</span><small>Rychlý výběr při zápisu</small></div>
  <div class="list">${prs.map(p => `
    <button class="row row-btn" data-act="edit-preset" data-id="${p.id}" type="button">
      <span class="main"><b>${esc(p.label)}</b>${showAddr ? `<small>${p.place ? '📍 ' + esc(p.place.label) : 'bez adresy cíle'}</small>` : ''}</span><span class="val">${p.km} km</span>${icons.chev}
    </button>`).join('')}
    <button class="row row-btn add" data-act="add-preset" type="button">＋ Přidat trasu</button>
  </div>

  <div class="sec"><span>Pravidla férového počítání</span><small>Proti hádkám</small></div>
  <div class="list">
    <div class="row">
      <div class="main"><b>📏 Hlavní měna</b><small>Mezi řidiči se počítají čistě ujeté kilometry</small></div>
      <div class="val">km</div>
    </div>
    <div class="row">
      <div class="main"><b>⚖️ Bonus za únavu a oběť</b><small>Noční jízda ×1,2 • řidič na akci nepil ×1,5</small></div>
      <div class="val"><span class="tag ok">aktivní</span></div>
    </div>
    <button class="row row-btn" data-act="edit-rates" type="button">
      <span class="main"><b>🎒 Sazba pro členy bez auta</b><small>Palivo ${num(r.fuel, 2)} Kč + amortizace ${num(r.amort, 2)} Kč</small></span>
      <span class="val">${num(r.total, 2)} Kč/km</span>${icons.chev}
    </button>
  </div>

  <div class="sec"><span>Tohle zařízení</span></div>
  <div class="list">
    <button class="row row-btn" data-act="pick-me" type="button">
      <span class="main"><b>${meId() ? `Jsem ${esc(M(meId()).name)}` : 'Kdo jsem?'}</b><small>Podle toho appka ukazuje tvoje časy a bilanci. Ukládá se jen tady.</small></span>${icons.chev}
    </button>
    <div class="row">
      <div class="main"><b>${g.demo ? 'Smazat ukázku' : 'Odebrat skupinu z telefonu'}</b><small>${g.secret && !g.demo ? 'Ostatním zůstane. Vrátíš se přes pozvánku.' : 'Data jsou jen tady, smažou se natrvalo.'}</small></div>
      <button class="btn danger sm" data-act="leave" type="button">${g.demo ? 'Smazat' : 'Odebrat'}</button>
    </div>
  </div>`;
}

const views = { home: renderHome, rides: renderRides, settle: renderSettle, group: renderGroup };

function render({ animate = false } = {}) {
  renderHeader();
  const g = grp();
  const view = $('#view');
  const ready = g && !g.joining;
  $('#tabs').hidden = !ready;
  if (!g) view.innerHTML = renderOnboard();
  else if (g.joining) view.innerHTML = `<div class="loading">⏳ Načítám skupinu…</div>`;
  else view.innerHTML = tripBarsHtml() + views[tab]();
  if (animate) { view.classList.remove('view-enter'); void view.offsetWidth; view.classList.add('view-enter'); }
  document.querySelectorAll('#tabs button').forEach(b => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('#fab').classList.toggle('hide', !ready || tab === 'group' || members().length < 2 || !members().some(m => m.car));
}

/* =====================================================================
   Sheets
   ===================================================================== */
let draft = null, qrCtx = null, lastFocus = null, sheetKind = null, meNext = false;
const BG = ['#top', '#view', '#tabs', '#fab'];
const sheetHead = title => `<div class="grab" aria-hidden="true"></div>
  <div class="sheet-head"><h3 id="sheetTitle" tabindex="-1">${esc(title)}</h3>
  <button class="close-x" data-act="close-modal" type="button" aria-label="Zavřít">${icons.x}</button></div>`;

function openSheetShell(html, kind = 'generic') {
  lastFocus = document.activeElement;
  $('#toast').classList.remove('show'); toastAction = null;
  sheetKind = kind;
  $('#sheet').innerHTML = html;
  $('#sheet').scrollTop = 0;
  $('#app').classList.add('open');
  BG.forEach(s => $(s).setAttribute('inert', ''));
  setGroupPicker(false);
  requestAnimationFrame(() => (document.querySelector('#sheet [autofocus]') || $('#sheetTitle'))?.focus({ preventScroll: true }));
}
function closeSheet() {
  if (!$('#app').classList.contains('open')) return;
  $('#app').classList.remove('open');
  BG.forEach(s => $(s).removeAttribute('inert'));
  draft = null; qrCtx = null; sheetKind = null; tp = null; meNext = false;
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
}

/* ---------- Ride sheet (new + edit) ---------- */
function openRideSheet(key) {
  const ms = members();
  if (key) {
    const doc = grp().docs[key]?.d;
    if (!doc) return;
    draft = { key, ...doc, riders: [...doc.riders], date: ymd(new Date(doc.ts)) };
  } else {
    const nd = nextDriver(), off = offToday();
    const driver = nd ? nd.id : ms.find(m => m.car).id;
    const p0 = presets()[0];
    draft = {
      key: null, driver,
      riders: ms.filter(m => !off.has(m.id) || m.id === driver).map(m => m.id),
      km: p0 ? p0.km : 20, label: p0 ? p0.label : '', night: false, sober: false, date: ymd()
    };
  }
  openSheetShell('', 'ride');
  renderRideSheet();
}

function ridePreview() {
  const d = draft, dm = M(d.driver);
  if (d.riders.length < 2) return { warn: true, html: 'Vyber aspoň jednoho spolujezdce – jízda samotného řidiče se do bilance nepočítá.' };
  if (!d.km || d.km < 1) return { warn: true, html: 'Zadej počet kilometrů.' };
  const v = value(d), share = v / d.riders.length;
  return { warn: false, html: `
    <b>${esc(dm.name)}</b> si připíše <b class="pos">${kmFmt(v - share)}</b>,
    ${d.riders.length - 1 === 1 ? 'spolujezdci' : `každému z ${d.riders.length - 1} spolujezdců`} se odečte <b>${kmFmt(share, false)}</b>.
    ${(d.night || d.sober) ? `<span class="note">Započteno ${Math.round(v)} km místo ${d.km} km díky bonusu.</span>` : `<span class="note">🤝 Žádné peníze na očích – kdo má auto, příště prostě odřídí.</span>`}` };
}
function updateRidePreview() {
  const p = ridePreview();
  const el = $('#sheetPreview');
  el.className = 'preview' + (p.warn ? ' warn' : '');
  el.innerHTML = p.html;
  $('#saveBtn').disabled = p.warn;
  document.querySelectorAll('.presets button').forEach(b => b.classList.toggle('on', b.dataset.l === draft.label && +b.dataset.k === draft.km));
  const known = presets().some(p => p.label === draft.label.trim() && p.km === draft.km);
  const sp = $('#savePreset');
  if (sp) sp.hidden = known || !draft.label.trim();
}

function renderRideSheet() {
  const d = draft;
  const sc = $('#sheet').scrollTop;
  const prs = presets();
  $('#sheet').innerHTML = `
  ${sheetHead(d.key ? 'Upravit jízdu' : 'Zapsat jízdu')}

  <div class="sec">Kam jste jeli?</div>
  ${prs.length ? `<div class="presets" role="group" aria-label="Oblíbené trasy">${prs.map(p => `
    <button class="${d.label === p.label && d.km === p.km ? 'on' : ''}" data-s="preset" data-l="${esc(p.label)}" data-k="${p.km}" type="button">
      ${esc(p.label)}<small>${p.km} km</small>
    </button>`).join('')}
  </div>` : ''}
  <div class="label-row">
    <input class="inp" id="labelIn" type="text" maxlength="40" placeholder="Název (např. Trénink hala)" value="${esc(d.label)}" aria-label="Název jízdy">
    <button class="btn soft sm" id="savePreset" data-s="save-preset" type="button" hidden>☆ Uložit trasu</button>
  </div>

  <div class="sec"><span>Kilometrů celkem</span><small>tam i zpět</small></div>
  <div class="km">
    <button data-s="km" data-d="-2" type="button" aria-label="O 2 km méně">−</button>
    <div class="field">
      <input id="kmIn" type="number" inputmode="numeric" min="1" max="5000" value="${d.km}" aria-label="Počet kilometrů">
      <span class="unit" aria-hidden="true">km</span>
    </div>
    <button data-s="km" data-d="2" type="button" aria-label="O 2 km více">+</button>
  </div>

  <label class="fld"><span>Datum</span><input class="inp" id="dateIn" type="date" max="${ymd()}" value="${d.date}"></label>

  <div class="sec">Kdo řídil?</div>
  <div class="chips" role="radiogroup" aria-label="Řidič">${members().filter(m => m.car || m.id === d.driver).map(m => `
    <button class="chip ${d.driver === m.id ? 'on' : 'off'}" data-s="driver" data-id="${m.id}" type="button" role="radio" aria-checked="${d.driver === m.id}">
      ${av(m)}<span class="nm">${esc(m.name)}</span>
    </button>`).join('')}
  </div>

  <div class="sec"><span>Kdo seděl v autě?</span><small>${d.riders.length} ${plural(d.riders.length, 'člověk', 'lidé', 'lidí')}</small></div>
  <div class="chips">${members().map(m => m.id === d.driver
    ? `<span class="chip locked">${av(m)}<span class="nm">${esc(m.name)}</span><span class="badge">řidič</span></span>`
    : `<button class="chip ${d.riders.includes(m.id) ? 'on' : 'off'}" data-s="rider" data-id="${m.id}" type="button" aria-pressed="${d.riders.includes(m.id)}">
        ${av(m)}<span class="nm">${esc(m.name)}</span>
      </button>`).join('')}
  </div>

  <div class="sec">Bonus pro řidiče</div>
  <div class="tog">
    <div id="lblNight"><b>🌙 Noční návrat / únava</b><small>Započítá se ×1,2 km</small></div>
    <button class="sw2" data-s="night" role="switch" aria-checked="${d.night}" aria-labelledby="lblNight" type="button"></button>
  </div>
  <div class="tog">
    <div id="lblSober"><b>🥤 Řidič na akci nepil</b><small>Vzdal se pití kvůli ostatním, ×1,5 km</small></div>
    <button class="sw2" data-s="sober" role="switch" aria-checked="${d.sober}" aria-labelledby="lblSober" type="button"></button>
  </div>

  <div class="preview" id="sheetPreview" aria-live="polite"></div>
  <button class="btn primary" id="saveBtn" data-s="save" type="button">✓ ${d.key ? 'Uložit změny' : 'Uložit jízdu'}</button>
  ${d.key ? `<button class="btn danger block" style="margin-top:8px" data-s="delete" type="button">Smazat jízdu</button>` : ''}`;
  $('#sheet').scrollTop = sc;
  updateRidePreview();
}

function saveRide() {
  const d = draft;
  if (d.riders.length < 2) return;
  const label = d.label.trim() || 'Jízda';
  const today = ymd();
  let t;
  if (d.key) {
    const old = grp().docs[d.key]?.d;
    t = old && ymd(new Date(old.ts)) === d.date ? old.ts : new Date(`${d.date}T12:00:00`).getTime();
  } else t = d.date === today ? Date.now() : new Date(`${d.date}T12:00:00`).getTime();
  const key = d.key || 'r:' + rid();
  const prev = d.key ? grp().docs[d.key]?.d : null;
  put(key, { driver: d.driver, riders: [...d.riders], km: d.km, label, night: d.night, sober: d.sober, ts: t });
  if (committed().has(d.driver)) put('c:' + d.driver, { on: false });
  closeSheet(); render();
  if (prev) return toast('✓ Jízda upravena.', { label: 'Vrátit', run: () => { put(key, prev); render(); } });
  const nd = nextDriver();
  toast(`✓ Uloženo ${d.km} km. Příště řídí ${nd ? nd.name : 'někdo z dostupných'}.`, { label: 'Vrátit', run: () => { del(key); render(); } });
}

/* ---------- Generic form sheets ---------- */
function openSettingsSheet(first = false) {
  const s = first ? { title: '', kind: KINDS[0] } : settings();
  openSheetShell(`${sheetHead(first ? 'Nová skupina' : 'Upravit skupinu')}
    <label class="fld"><span>Název skupiny</span><input class="inp" id="fTitle" maxlength="60" placeholder="např. Florbal – čtvrtek" value="${esc(s.title)}" autofocus></label>
    <label class="fld"><span>Typ</span><select class="inp" id="fKind">${KINDS.map(k => `<option ${k === s.kind ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></label>
    ${first ? `
      <label class="fld"><span>Tvoje jméno</span><input class="inp" id="fMe" maxlength="30" placeholder="např. Adam"></label>
      <div class="sw-row"><div id="lblMeCar"><b>🚗 Mám auto</b><small>Můžu vozit ostatní</small></div>
      <button class="sw2" id="fMeCar" data-s="toggle" role="switch" aria-checked="true" aria-labelledby="lblMeCar" type="button"></button></div>
      <span class="hint">Ostatní přidáš v dalším kroku nebo je pozveš odkazem.</span>` : ''}
    <div class="sheet-acts">
      <button class="btn soft" data-act="close-modal" type="button">Zrušit</button>
      <button class="btn primary" data-act="${first ? 'create-group' : 'save-settings'}" type="button">${first ? 'Založit' : 'Uložit'}</button>
    </div>`, 'settings');
}

function openMemberSheet(id) {
  const m = id ? members().find(x => x.id === id) : null;
  if (id && !m) return;
  openSheetShell(`${sheetHead(m ? 'Upravit člena' : 'Nový člen')}
    <label class="fld"><span>Jméno</span><input class="inp" id="fName" maxlength="30" placeholder="např. Michal" value="${esc(m?.name || '')}" ${m ? '' : 'autofocus'}></label>
    <div class="sw-row"><div id="lblCar"><b>🚗 Má auto</b><small>Může být řidič a vyrovnává řízením</small></div>
    <button class="sw2" id="fCar" data-s="toggle" role="switch" aria-checked="${m ? m.car : true}" aria-labelledby="lblCar" type="button"></button></div>
    <label class="fld"><span>Číslo účtu pro QR platby</span>
      <input class="inp" id="fIban" inputmode="text" autocomplete="off" spellcheck="false" maxlength="42" placeholder="123456789/0800 nebo CZ…" value="${esc(ibanToLocal(m?.iban))}">
      <span class="hint" id="ibanHint">Na tenhle účet pošlou peníze ti, kdo nemají auto. Uvidí ho jen lidé ve skupině.</span>
    </label>
    ${mapsReady() ? placeFieldHtml('member', m?.place, {
      label: 'Kde nastupuje',
      hint: 'Stačí roh ulice nebo zastávka, kde ho můžou nabrat. Adresu vidí jen lidé ve skupině a je šifrovaná.',
      gps: true
    }) : ''}
    <div class="sheet-acts">
      ${m ? `<button class="btn danger" data-act="delete-member" data-id="${m.id}" type="button">Odebrat</button>` : `<button class="btn soft" data-act="close-modal" type="button">Zrušit</button>`}
      <button class="btn primary" data-act="save-member" data-id="${m ? m.id : ''}" type="button">Uložit</button>
    </div>`, 'member');
}

function openPresetSheet(id) {
  const p = id ? presets().find(x => x.id === id) : null;
  openSheetShell(`${sheetHead(p ? 'Upravit trasu' : 'Nová trasa')}
    <label class="fld"><span>Název</span><input class="inp" id="fLabel" maxlength="40" placeholder="např. Trénink hala" value="${esc(p?.label || '')}" ${p ? '' : 'autofocus'}></label>
    <label class="fld"><span>Kilometrů tam i zpět</span><input class="inp" id="fKm" type="number" inputmode="numeric" min="1" max="5000" value="${p ? p.km : ''}"></label>
    ${mapsReady() ? placeFieldHtml('preset', p?.place, { label: 'Adresa cíle', hint: 'Podle ní appka naplánuje cestu přes všechny, koho vezeš.' }) : ''}
    <div class="sheet-acts">
      ${p ? `<button class="btn danger" data-act="delete-preset" data-id="${p.id}" type="button">Smazat</button>` : `<button class="btn soft" data-act="close-modal" type="button">Zrušit</button>`}
      <button class="btn primary" data-act="save-preset" data-id="${p ? p.id : ''}" type="button">Uložit</button>
    </div>`, 'preset');
}

function openRatesSheet() {
  const r = rates();
  openSheetShell(`${sheetHead('Sazba za kilometr')}
    <p class="hint" style="margin-top:4px">Kolik zaplatí člen bez auta za 1 km. Typicky spotřeba × cena paliva / 100 a k tomu něco na opotřebení auta.</p>
    <div class="two">
      <label class="fld"><span>Palivo Kč/km</span><input class="inp" id="fFuel" type="number" inputmode="decimal" step="0.1" min="0" max="50" value="${r.fuel}"></label>
      <label class="fld"><span>Amortizace Kč/km</span><input class="inp" id="fAmort" type="number" inputmode="decimal" step="0.1" min="0" max="50" value="${r.amort}"></label>
    </div>
    <span class="hint">Příklad: 6,5 l/100 km × 40 Kč = 2,60 Kč/km paliva.</span>
    <div class="sheet-acts">
      <button class="btn soft" data-act="close-modal" type="button">Zrušit</button>
      <button class="btn primary" data-act="save-rates" type="button">Uložit</button>
    </div>`, 'rates');
}

function openPaySheet(key) {
  const p = grp().docs[key]?.d;
  if (!p) return;
  const f = M(p.from), to = M(p.to);
  openSheetShell(`${sheetHead('Platba')}
    <div class="qr-details">
      <div><span>Kdo platil</span><b>${esc(f.name)}</b></div>
      <div><span>Komu</span><b>${esc(to.name)}</b></div>
      <div><span>Kdy</span><span>${esc(dateLabel(p.ts))}</span></div>
      <div class="total"><span>Částka</span><span class="pos">${kcFmt(p.kc)} (${kmFmt(p.km, false)})</span></div>
    </div>
    <span class="hint">Platbu smaž, jen pokud peníze ve skutečnosti neodešly. Dluh se pak znovu objeví ve Vyrovnání.</span>
    <div class="sheet-acts">
      <button class="btn danger" data-act="delete-pay" data-k="${esc(key)}" type="button">Smazat platbu</button>
      <button class="btn soft" data-act="close-modal" type="button">Zavřít</button>
    </div>`, 'pay');
}

function openShareSheet(title, text) {
  openSheetShell(`${sheetHead(title)}
    <div class="share-grid">
      <a class="btn primary" style="text-align:center;text-decoration:none" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener noreferrer">Poslat přes WhatsApp</a>
      <button class="btn soft" data-act="copy" data-text="${esc(text)}" type="button">📋 Zkopírovat text</button>
    </div>
    <textarea class="inp" style="margin-top:12px;min-height:90px;font-size:.85rem" readonly>${esc(text)}</textarea>`, 'share');
}

/* ---------- QR ---------- */
function spaydMsg(s) {
  // SPAYD: '*' is the field separator; keep it ASCII-safe and short
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '').replace(/[*]/g, '').slice(0, 60);
}

function openQr(s) {
  const f = M(s.from), to = M(s.to), r = rates();
  const total = kcVal(s.v);
  const fuel = Math.round(s.v * r.fuel);
  const amort = total - fuel;
  qrCtx = { ...s, kc: total };
  if (!to.iban) {
    return openSheetShell(`${sheetHead(`QR platba ${total.toLocaleString('cs-CZ')} Kč`)}
      <div class="preview warn">${esc(to.name)} nemá vyplněné číslo účtu, takže QR kód nejde vytvořit.</div>
      <div class="sheet-acts">
        <button class="btn soft" data-act="confirm-qr" type="button">Zaplaceno jinak</button>
        <button class="btn primary" data-act="edit-member" data-id="${to.id}" type="button">Doplnit účet</button>
      </div>`, 'qr');
  }
  const spd = `SPD*1.0*ACC:${to.iban}*AM:${total}.00*CC:CZK*MSG:${spaydMsg(`WhoDrives ${Math.round(s.v)} km ${f.name}`)}`;
  let qr;
  try { qr = QR.svg(spd); qrCtx.svg = qr; } catch (e) { qr = '<p>QR kód se nepodařilo vytvořit.</p>'; }
  openSheetShell(`
    <div class="qr-box">
      ${sheetHead(`QR platba ${total.toLocaleString('cs-CZ')} Kč`)}
      <small class="qr-sub">${esc(f.name)} → ${esc(to.name)} za ${kmFmt(s.v, false)}</small>
      <div class="qr-frame">${qr}</div>
      <div class="qr-hint">Naskenuj v bankovní aplikaci (QR Platba)</div>
      <div class="qr-details">
        <div><span>Příjemce</span><b>${esc(to.name)}</b></div>
        <div><span>Účet</span><span>${esc(ibanToLocal(to.iban))}</span></div>
        <div><span>⛽ Palivo (${kmFmt(s.v, false)} × ${num(r.fuel, 2)} Kč)</span><span>${fuel} Kč</span></div>
        <div><span>🔧 Amortizace (pneu, brzdy, servis)</span><span>${amort} Kč</span></div>
        <div class="total"><span>Celkem</span><span class="pos">${total.toLocaleString('cs-CZ')} Kč</span></div>
      </div>
      <div class="qr-acts">
        <button class="btn soft" style="flex:1" data-act="share-qr" type="button">${icons.share.replace('<svg', '<svg width="15" height="15" style="vertical-align:-2px"')} Poslat</button>
        <button class="btn primary" style="flex:2" data-act="confirm-qr" type="button">✓ Zaplaceno</button>
      </div>
    </div>`, 'qr');
}

/* =====================================================================
   Toast
   ===================================================================== */
let toastAction = null;
function toast(text, action) {
  const e = $('#toast');
  $('#toastText').textContent = text;
  const b = $('#toastAct');
  toastAction = action ? action.run : null;
  b.hidden = !action;
  if (action) b.textContent = action.label;
  e.classList.add('show');
  clearTimeout(e._t);
  e._t = setTimeout(() => { e.classList.remove('show'); toastAction = null; }, action ? 6000 : 3200);
}

/* =====================================================================
   Events
   ===================================================================== */
function setGroupPicker(show) {
  $('#grpPicker').classList.toggle('show', show);
  $('#grpBtn').setAttribute('aria-expanded', show);
}
function setTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('whodrives.theme', dark ? 'dark' : 'light'); } catch (e) {}
  renderHeader();
}
function goTab(t) {
  if (t === tab) { $('#view').scrollTo({ top: 0, behavior: 'smooth' }); return; }
  tab = t;
  render({ animate: true });
  $('#view').scrollTop = 0;
}
function switchGroup(id) {
  if (!store.groups[id]) return;
  store.current = id; tab = 'home'; persist();
  render({ animate: true });
  scheduleSync(50);
}
const val = id => document.getElementById(id)?.value ?? '';
const checked = id => document.getElementById(id)?.getAttribute('aria-checked') === 'true';
async function withBusy(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; }
}
function fieldError(id, msg) {
  const el = document.getElementById(id);
  el.classList.add('bad'); el.focus();
  toast(msg);
}

const actions = {
  'close-modal': closeSheet,
  'switch-grp': t => { setGroupPicker(false); if (t.dataset.key !== store.current) switchGroup(t.dataset.key); },
  'new-group': () => { setGroupPicker(false); openSettingsSheet(true); },
  'demo': () => { createDemo(); tab = 'home'; render({ animate: true }); toast('Ukázková data – klidně cokoli zkoušej.'); },
  'create-group': () => {
    const title = val('fTitle').trim(), me = val('fMe').trim();
    if (!title) return fieldError('fTitle', 'Zadej název skupiny.');
    if (!me) return fieldError('fMe', 'Zadej svoje jméno.');
    createGroup({ title, kind: val('fKind'), myName: me, myCar: checked('fMeCar') });
    closeSheet(); tab = 'group'; render({ animate: true });
    toast('✓ Skupina založena. Teď přidej ostatní.');
  },
  'save-settings': () => {
    const title = val('fTitle').trim();
    if (!title) return fieldError('fTitle', 'Zadej název skupiny.');
    put('settings', { ...settings(), title, kind: val('fKind') });
    closeSheet(); render(); toast('✓ Uloženo');
  },
  'add-member': () => openMemberSheet(null),
  'edit-member': t => openMemberSheet(t.dataset.id),
  'save-member': async t => {
    const id = t.dataset.id, name = val('fName').trim();
    if (!name) return fieldError('fName', 'Zadej jméno.');
    const acc = parseAccount(val('fIban'));
    if (acc.error) { document.getElementById('ibanHint').className = 'hint err'; document.getElementById('ibanHint').textContent = acc.error; return fieldError('fIban', acc.error); }
    const ms = members();
    if (ms.some(m => m.id !== id && m.name.toLocaleLowerCase('cs') === name.toLocaleLowerCase('cs'))) return fieldError('fName', 'Takové jméno už ve skupině je – přidej třeba iniciálu.');
    if (mapsReady() && !(await withBusy(t, () => resolvePlace('member')))) return toast('Adresu se nepodařilo najít – oprav ji, nebo ji smaž.');
    const old = id ? ms.find(m => m.id === id) : null;
    const used = new Set(ms.map(m => m.color));
    const color = old?.color || PALETTE.find(c => !used.has(c)) || PALETTE[ms.length % PALETTE.length];
    const car = checked('fCar');
    const newId = id || rid();
    put('m:' + newId, { name, car, iban: acc.iban || '', color, order: old ? old.order : Date.now(), place: placeValue('member', old?.place) });
    if (!id && meNext) setMe(newId);
    meNext = false;
    const wasQr = qrCtx;
    closeSheet(); render();
    toast(old ? '✓ Uloženo' : `✓ ${name} je ve skupině.`);
    if (wasQr && old) { const p = plan().find(s => s.from === wasQr.from && s.to === wasQr.to); if (p) openQr(p); }
  },
  'delete-member': t => {
    const id = t.dataset.id;
    const used = rides().some(r => r.driver === id || r.riders.includes(id)) || payments().some(p => p.from === id || p.to === id);
    if (used) return toast('Tenhle člen je v historii jízd, takže ho nejde odebrat – bilance by přestala sedět.');
    const m = members().find(x => x.id === id);
    if (!confirm(`Odebrat ${m.name} ze skupiny?`)) return;
    const prev = grp().docs['m:' + id].d;
    del('m:' + id); closeSheet(); render();
    toast(`${m.name} odebrán ze skupiny.`, { label: 'Vrátit', run: () => { put('m:' + id, prev); render(); } });
  },
  'add-preset': () => openPresetSheet(null),
  'edit-preset': t => openPresetSheet(t.dataset.id),
  'save-preset': async t => {
    const label = val('fLabel').trim(), km = Math.round(+val('fKm'));
    if (!label) return fieldError('fLabel', 'Zadej název trasy.');
    if (!(km >= 1 && km <= 5000)) return fieldError('fKm', 'Zadej kilometry (1–5000).');
    if (mapsReady() && !(await withBusy(t, () => resolvePlace('preset')))) return toast('Adresu cíle se nepodařilo najít – oprav ji, nebo ji smaž.');
    const old = t.dataset.id ? presets().find(p => p.id === t.dataset.id) : null;
    put('pr:' + (t.dataset.id || rid()), { label, km, order: old ? old.order : Date.now(), place: placeValue('preset', old?.place) });
    closeSheet(); render(); toast('✓ Trasa uložena');
  },
  'delete-preset': t => { del('pr:' + t.dataset.id); closeSheet(); render(); toast('Trasa smazána.'); },
  'edit-rates': openRatesSheet,
  'save-rates': () => {
    const fuel = +String(val('fFuel')).replace(',', '.'), amort = +String(val('fAmort')).replace(',', '.');
    if (!(fuel >= 0 && fuel <= 50)) return fieldError('fFuel', 'Zadej číslo 0–50.');
    if (!(amort >= 0 && amort <= 50)) return fieldError('fAmort', 'Zadej číslo 0–50.');
    put('settings', { ...settings(), rates: { fuel, amort } });
    closeSheet(); render(); toast('✓ Sazba uložena');
  },
  'leave': () => {
    const g = grp(), title = settings().title;
    const msg = g.secret && !g.demo ? `Odebrat „${title}“ z tohohle telefonu? Ostatním skupina zůstane.` : `Smazat „${title}“? Data jsou jen v tomhle prohlížeči a smažou se natrvalo.`;
    if (!confirm(msg)) return;
    leaveGroup(g.id); tab = 'home'; render({ animate: true });
    toast(g.demo ? 'Ukázka smazána.' : 'Skupina odebrána z telefonu.');
  },
  'invite': () => {
    const g = grp();
    shareText({ title: 'Pozvánka do WhoDrives', text: `Přidej se do skupiny „${settings().title}“ ve WhoDrives – hlídá, kdo kdy řídí 🚗`, url: inviteUrl(g) });
  },
  'copy': t => copy(t.dataset.text),
  'nudge': t => {
    const m = M(t.dataset.id);
    shareText({ title: 'Kdo dnes řídí', text: `🚗 Dnes řídí ${m.name} (${settings().title}). Férově podle ujetých km – WhoDrives.` });
  },
  'log': () => openRideSheet(null),
  'edit-ride': t => openRideSheet(t.dataset.k),
  'edit-pay': t => openPaySheet(t.dataset.k),
  'delete-pay': t => {
    const key = t.dataset.k, prev = grp().docs[key]?.d;
    if (!prev || !confirm('Smazat tuhle platbu?')) return;
    del(key); closeSheet(); render();
    toast('Platba smazána.', { label: 'Vrátit', run: () => { put(key, prev); render(); } });
  },
  'cant': t => toggleAvail(t.dataset.id, true),
  'avail': t => toggleAvail(t.dataset.id, false),
  'drive': t => {
    const s = plan()[+t.dataset.i];
    if (!s) return;
    if (offToday().has(s.from)) put(`off:${ymd()}:${s.from}`, { on: false });
    put('c:' + s.from, { on: true });
    render();
    toast(`🚗 Domluveno – ${M(s.from).name} odřídí příští jízdy (${kmFmt(s.v, false)}).`);
  },
  'qr': t => { const s = plan()[+t.dataset.i]; if (s) openQr(s); },
  'share-qr': async () => {
    if (!qrCtx?.svg) return;
    const f = M(qrCtx.from), to = M(qrCtx.to);
    try {
      const blob = await qrPng(qrCtx.svg, [`${qrCtx.kc.toLocaleString('cs-CZ')} Kč → ${to.name}`, `${f.name} • ${kmFmt(qrCtx.v, false)} • WhoDrives`]);
      const file = new File([blob], `qr-platba-${qrCtx.kc}kc.png`, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'QR platba' }); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('QR kód uložen jako obrázek.');
    } catch (e) { if (e.name !== 'AbortError') toast('QR se nepodařilo poslat.'); }
  },
  'confirm-qr': () => {
    if (!qrCtx) return;
    const s = qrCtx, key = 'p:' + rid();
    put(key, { from: s.from, to: s.to, km: s.v, kc: s.kc, ts: Date.now() });
    if (committed().has(s.from)) put('c:' + s.from, { on: false });
    closeSheet(); render();
    toast(`✓ ${M(s.from).name} má vyrovnáno (${kcFmt(s.kc)}).`, { label: 'Vrátit', run: () => { del(key); render(); } });
  },
  'set-me': t => {
    setMe(t.dataset.id);
    closeSheet(); render();
    toast(`👋 Ahoj, ${M(t.dataset.id).name}!`);
  },
  'me-skip': () => { const m = readMap(ME_SKIP); m[grp().id] = 1; writeMap(ME_SKIP, m); render(); },
  'me-new': () => { meNext = true; openMemberSheet(null); },
  'pick-me': () => {
    const me = meId();
    openSheetShell(`${sheetHead('Kdo jsi?')}
      <p class="hint" style="margin-top:4px">Vyber sebe. Uloží se jen v tomhle telefonu, ostatní to neuvidí.</p>
      <div class="chips" style="margin-top:12px">${members().map(m => `<button class="chip ${m.id === me ? 'on' : ''}" data-act="set-me" data-id="${m.id}" type="button">${av(m)}<span class="nm">${esc(m.name)}</span></button>`).join('')}</div>
      <div class="sheet-acts"><button class="btn soft" data-act="close-modal" type="button">Zavřít</button><button class="btn outline" data-act="me-new" type="button">Nejsem v seznamu</button></div>`, 'me');
  },
  'convert-enc': () => {
    const old = grp(), oldMe = meId();
    if (!confirm('Vytvořit šifrovanou kopii skupiny s novým odkazem? Starý odkaz pak už nebude dostávat novinky – pošli partě ten nový.')) return;
    const g = newGroup();
    for (const [k, v] of Object.entries(old.docs)) if (!v.del && v.d) g.docs[k] = { d: v.d, dirty: true };
    store.current = g.id;
    delete store.groups[old.id];
    if (oldMe) setMe(oldMe, g);
    persist(); scheduleSync(50); render();
    toast('🔒 Hotovo – skupina je šifrovaná. Pošli partě nový odkaz.');
  },
  ...mapActions
};

function toggleAvail(id, fromHero) {
  const key = `off:${ymd()}:${id}`;
  const isOff = offToday().has(id);
  put(key, { on: !isOff });
  render();
  if (fromHero) {
    const nd = nextDriver();
    toast(nd ? `Dobře, dnes to bere ${nd.name}.` : 'Nikdo další s autem dnes nemůže.', { label: 'Zpět', run: () => { put(key, { on: false }); render(); } });
  }
}

document.addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!e.target.closest('#top')) setGroupPicker(false);
  if (!t || t.disabled) return;

  if (t.id === 'toastAct') { const fn = toastAction; $('#toast').classList.remove('show'); toastAction = null; fn && fn(); return; }
  if (t.id === 'themeBtn') return setTheme(document.documentElement.dataset.theme !== 'dark');
  if (t.id === 'grpBtn') return setGroupPicker(!$('#grpPicker').classList.contains('show'));
  if (t.dataset.tab) return goTab(t.dataset.tab);
  if (t.id === 'fab') return openRideSheet(null);

  const a = t.dataset.act;
  if (a && actions[a]) return actions[a](t);

  if (t.dataset.tp) return tripClick(t);
  const s = t.dataset.s;
  if (s === 'toggle') { t.setAttribute('aria-checked', t.getAttribute('aria-checked') !== 'true'); return; }
  if (!s || !draft) return;
  if (s === 'preset') { draft.label = t.dataset.l; draft.km = +t.dataset.k; }
  if (s === 'km') { draft.km = clamp((draft.km || 0) + +t.dataset.d, 1, 5000); $('#kmIn').value = draft.km; return updateRidePreview(); }
  if (s === 'driver') { draft.driver = t.dataset.id; if (!draft.riders.includes(draft.driver)) draft.riders.push(draft.driver); }
  if (s === 'rider') { const id = t.dataset.id; draft.riders = draft.riders.includes(id) ? draft.riders.filter(x => x !== id) : [...draft.riders, id]; }
  if (s === 'night' || s === 'sober') { draft[s] = !draft[s]; t.setAttribute('aria-checked', draft[s]); return updateRidePreview(); }
  if (s === 'save') return saveRide();
  if (s === 'save-preset') {
    const label = draft.label.trim();
    if (!label || !draft.km) return;
    put('pr:' + rid(), { label, km: draft.km, order: Date.now() });
    toast(`☆ „${label}“ uložena mezi oblíbené.`);
  }
  if (s === 'delete') {
    const key = draft.key, prev = grp().docs[key]?.d;
    if (!prev || !confirm('Smazat tuhle jízdu? Bilance se přepočítá.')) return;
    del(key); closeSheet(); render();
    return toast('Jízda smazána.', { label: 'Vrátit', run: () => { put(key, prev); render(); } });
  }
  renderRideSheet();
});
// Links that also do something in the app (e.g. "start navigation"): run the action, let the link open.
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-act]');
  if (a && actions[a.dataset.act]) actions[a.dataset.act](a);
});

document.addEventListener('input', e => {
  e.target.classList?.remove('bad');
  if (e.target.dataset?.place) return placeInput(e.target);
  if (!draft) return;
  if (e.target.id === 'kmIn') {
    const v = parseInt(e.target.value, 10);
    draft.km = isNaN(v) ? 0 : clamp(v, 1, 5000);
    updateRidePreview();
  }
  if (e.target.id === 'labelIn') { draft.label = e.target.value.slice(0, 40); updateRidePreview(); }
  if (e.target.id === 'dateIn' && /^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) draft.date = e.target.value > ymd() ? ymd() : e.target.value;
});
// time pickers: react when the picker is closed (iOS fires "change" then), not on every spin
document.addEventListener('change', e => { if (e.target.id === 'tpTime') tripTimeInput(e.target); });
document.addEventListener('focusout', e => { if (e.target.id === 'kmIn' && draft && draft.km) e.target.value = draft.km; });
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.dataset?.place) { e.preventDefault(); placeEnter(e.target); return; }
  if (e.key === 'Enter' && e.target.matches?.('#sheet input.inp:not(#labelIn):not([data-place])')) {
    const primary = document.querySelector('#sheet .sheet-acts .btn.primary');
    if (primary) { e.preventDefault(); primary.click(); }
  }
  if (e.key !== 'Escape') return;
  if ($('#app').classList.contains('open')) closeSheet();
  else setGroupPicker(false);
});
$('#scrim').addEventListener('click', closeSheet);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', ev => {
  try { if (localStorage.getItem('whodrives.theme')) return; } catch (e) {}
  document.documentElement.dataset.theme = ev.matches ? 'dark' : 'light'; renderHeader();
});

/* =====================================================================
   Start
   ===================================================================== */
function handleJoinLink() {
  const m = location.hash.match(/^#(join|g)=([A-Za-z0-9_-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search); // don't keep the secret in the address bar
  const secret = m[2], enc = m[1] === 'g';
  if (!SECRET_RE.test(secret)) return toast('Odkaz na skupinu je poškozený.');
  if (!SYNC_ON) return toast('Sdílení skupin tady není zapnuté.');
  const existing = Object.values(store.groups).find(g => g.secret === secret);
  if (existing) { store.current = existing.id; persist(); return; }
  const g = newGroup();
  g.secret = secret; g.enc = enc; g.created = true; g.joining = true;
  store.current = g.id;
  persist();
  tab = 'home';
}

// drop leftovers from the old single-file version
try { localStorage.removeItem('whodrives.state.v2'); } catch (e) {}
if (store.current && !store.groups[store.current]) store.current = Object.keys(store.groups)[0] || null;
handleJoinLink();
render();
scheduleSync(50);
startTripWatch();
addEventListener('hashchange', () => {
  if (!/^#(join|g)=/.test(location.hash)) return;
  closeSheet(); handleJoinLink(); render({ animate: true }); scheduleSync(50);
});

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
