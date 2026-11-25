'use strict';
/* =====================================================================
   Maps & trips
   - Mapy.com REST API: address search, distance matrix, route length
   - Best pickup order: exact search over all orders (≤ 8 pickups)
   - Deep links into Mapy.com / Google Maps / Apple Maps / Waze
   - A trip in progress is a synced document "t:<id>"; when the phone that
     started it comes back to the app at the destination, the ride logs itself.
   Loaded before app.js; uses its helpers only at call time.
   ===================================================================== */

const MAPY_API = 'https://api.mapy.com/v1';
const NAV_NAMES = { mapy: 'Mapy.com', google: 'Google Maps', apple: 'Apple Mapy', waze: 'Waze' };
const CZ_BBOX = '12.09,48.55,18.86,51.06';
const MAX_PICKUPS = 8;

/* ---------- Mapy.com client ---------- */
async function mapy(path, params) {
  const key = (window.WHODRIVES_CONFIG || {}).mapyKey;
  if (!key) throw new Error('no_key');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    (Array.isArray(v) ? v : [v]).forEach(x => qs.append(k, x));
  }
  qs.set('apikey', key);
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 12000);
  try {
    // Mapy.com checks the key against our domain, so send the origin (never the path or #fragment).
    const res = await fetch(`${MAPY_API}${path}?${qs}`, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'strict-origin', cache: 'no-store' });
    const body = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error('mapy_' + res.status); e.status = res.status; e.body = body; throw e; }
    return body;
  } finally { clearTimeout(to); }
}
function mapyErr(e) {
  if (e?.message === 'no_key') return 'Chybí klíč k Mapy.com – plánování tras zatím nejde.';
  if (e?.status === 401 || e?.status === 403) return 'Mapy.com odmítly klíč aplikace.';
  if (e?.status === 429) return 'Moc požadavků najednou – zkus to za chvilku.';
  if (e?.status === 404 || e?.status === 422) return 'Mezi těmi místy se nepodařilo najít cestu autem.';
  return navigator.onLine ? 'Mapy.com teď neodpovídají – zkus to za chvilku.' : 'Jsi offline – trasu teď spočítat nejde.';
}
const fix5 = x => (Math.round(+x * 1e5) / 1e5).toString();
const ll = p => `${fix5(p.lon)},${fix5(p.lat)}`;
const latlng = p => `${fix5(p.lat)},${fix5(p.lon)}`;

function placeFromItem(it) {
  const lat = +it?.position?.lat, lon = +it?.position?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const name = String(it.name || '').slice(0, 80), sub = String(it.location || '').slice(0, 80);
  return { name, sub, label: [name, sub].filter(Boolean).join(', ').slice(0, 120), lat, lon };
}
const PLACE_TYPES = ['regional.address', 'regional.street', 'regional.municipality_part', 'regional.municipality', 'poi'];
async function suggestPlaces(q) {
  const r = await mapy('/suggest', { query: q.slice(0, 150), lang: 'cs', limit: 6, preferBBox: CZ_BBOX, type: PLACE_TYPES });
  return (r?.items || []).map(placeFromItem).filter(Boolean);
}
async function geocodePlace(q) {
  const r = await mapy('/geocode', { query: q.slice(0, 150), lang: 'cs', limit: 1, preferBBox: CZ_BBOX, type: PLACE_TYPES });
  return placeFromItem(r?.items?.[0]);
}
async function reverseGeocode(p) {
  const r = await mapy('/rgeocode', { lon: p.lon, lat: p.lat, lang: 'cs' });
  const it = placeFromItem(r?.items?.[0]);
  return it ? it.label : 'Moje poloha';
}
async function matrixM(starts, ends) {
  const r = await mapy('/routing/matrix-m', { starts: starts.map(ll).join(';'), ends: ends.map(ll).join(';'), routeType: 'car_fast_traffic' });
  if (!Array.isArray(r?.matrix)) throw new Error('bad_matrix');
  return r.matrix; // [start][end] → { length (m), duration (s) }
}
const isoLocal = t => { const d = new Date(t); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
async function routeM(start, end, via, dep) {
  const r = await mapy('/routing/route', {
    start: ll(start), end: ll(end), waypoints: via.length ? via.map(ll).join(';') : null,
    routeType: 'car_fast_traffic', format: 'polyline', lang: 'cs',
    departure: dep && dep - Date.now() > 10 * 60e3 ? isoLocal(dep) : null
  });
  if (!Number.isFinite(+r?.length) || !Number.isFinite(+r?.duration)) throw new Error('bad_route');
  return r;
}

/* ---------- Geometry & best order ---------- */
function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** cost(from, to): 0 = start, 1..n = pickups, n+1 = destination. Exact branch & bound, fine for n ≤ 8. */
function bestOrder(n, cost) {
  let best = Infinity, bestPath = null;
  const used = new Array(n + 1).fill(false), path = [];
  (function dfs(last, acc) {
    if (acc >= best) return;
    if (path.length === n) {
      const total = acc + cost(last, n + 1);
      if (total < best) { best = total; bestPath = [...path]; }
      return;
    }
    for (let i = 1; i <= n; i++) {
      if (used[i]) continue;
      used[i] = true; path.push(i);
      dfs(i, acc + cost(last, i));
      path.pop(); used[i] = false;
    }
  })(0, 0);
  return bestPath || Array.from({ length: n }, (_, i) => i + 1);
}
async function planRoute(start, picks, end, dep) {
  const n = picks.length;
  if (n > MAX_PICKUPS) throw new Error('too_many');
  let order = picks.map((_, i) => i + 1);
  if (n >= 2) {
    let cost;
    try {
      const m = await matrixM([start, ...picks], [...picks, end]);
      cost = (a, b) => { const c = m[a]?.[b - 1]; return c && c.duration >= 0 ? c.duration : Infinity; };
    } catch (e) {
      if (e.message === 'no_key' || e.status === 401 || e.status === 403) throw e;
      const pts = [start, ...picks, end]; // fallback: straight-line distances
      cost = (a, b) => haversine(pts[a], pts[b]);
    }
    order = bestOrder(n, cost);
  }
  const ordered = order.map(i => picks[i - 1]);
  const r = await routeM(start, end, ordered, dep);
  return {
    order: ordered.map(p => p.id),
    km: +r.length / 1000,
    mins: +r.duration / 60,
    legs: Array.isArray(r.parts) ? r.parts.map(p => (+p.duration || 0) / 60) : []
  };
}

/* ---------- Times & the message for the group ---------- */
const hm = t => new Date(t).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
function dayWord(t) {
  const d = new Date(t), today = new Date(), tm = new Date(); tm.setDate(today.getDate() + 1);
  if (ymd(d) === ymd(today)) return '';
  if (ymd(d) === ymd(tm)) return 'zítra ';
  return d.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'numeric' }) + ' ';
}
const whenText = t => `${dayWord(t)}v ${hm(t)}`;
const isFuture = t => t - Date.now() > 10 * 60e3;

function tripShareText(t) {
  const mine = t.driver === meId(), d = M(t.driver);
  const when = isFuture(t.dep) || t.planned ? whenText(t.dep) : 'teď';
  const head = t.ret
    ? `🏠 ${mine ? 'Rozvážím' : `${d.name} rozváží`} domů ${when}${t.start?.label ? ` (${t.start.label})` : ''}`
    : `🚗 ${mine ? 'Vyrážím' : `${d.name} vyráží`} ${when} → ${t.label}`;
  const lines = t.stops.map(s => `📍 ${M(s.id).name} – ${hm(t.dep + s.eta * 60e3)}`);
  const onboard = t.riders.filter(id => id !== t.driver && !t.stops.some(s => s.id === id)).map(id => M(id).name);
  if (onboard.length) lines.push(`🙋 ${onboard.join(', ')} – ${t.ret ? 'vystoupí u řidiče' : 'nástup u řidiče'}`);
  if (!t.ret) lines.push(`🏁 ${t.label} – kolem ${hm(t.dep + t.mins * 60e3)}`);
  return `${head}\n${lines.join('\n')}`;
}
const shareFooter = ret => (ret ? '(WhoDrives)' : 'Kdo nemůže, napište. (WhoDrives)');
async function shareTrip(...trips) {
  trips = trips.filter(Boolean);
  if (!trips.length) return;
  const text = trips.map(tripShareText).join('\n\n') + '\n' + shareFooter(trips[0].ret);
  if (navigator.share) {
    try { await navigator.share({ title: 'Jízda', text }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  if (sheetKind === 'trip') { copy(text); return; } // keep the planner open; just copy
  openShareSheet('Poslat partě časy', text);
}

/* ---------- Navigation app links ---------- */
function navTargets(trip) {
  const pts = [...trip.stops.map(s => ({ ...s, name: M(s.id).name })), { ...trip.end, name: trip.label }];
  return pts.slice(Math.min(trip.leg || 0, pts.length - 1));
}
function navUrl(trip) {
  const pts = navTargets(trip);
  const dest = trip.legs ? pts[0] : pts[pts.length - 1];
  const via = trip.legs ? [] : pts.slice(0, -1);
  switch (trip.nav) {
    case 'google': {
      const q = new URLSearchParams({ api: '1', destination: latlng(dest), travelmode: 'driving', dir_action: 'navigate' });
      if (via.length) q.set('waypoints', via.map(latlng).join('|'));
      return 'https://www.google.com/maps/dir/?' + q;
    }
    case 'apple':
      return `https://maps.apple.com/directions?destination=${latlng(dest)}${via.map(p => '&waypoint=' + latlng(p)).join('')}&mode=driving`;
    case 'waze':
      return `https://waze.com/ul?ll=${latlng(dest)}&navigate=yes`;
    default: {
      // same order and format as the examples in the Mapy.com docs; coordinates are plain numbers, no encoding needed
      const from = trip.leg ? trip.stops[trip.leg - 1] : trip.start;
      const parts = [];
      if (from) parts.push('start=' + ll(from));
      parts.push('end=' + ll(dest), 'routeType=car_fast_traffic');
      if (via.length) parts.push('waypoints=' + via.map(ll).join(';'));
      parts.push('navigate=true');
      return 'https://mapy.com/fnc/v1/route?' + parts.join('&');
    }
  }
}
/** Waze can't take stops at all and Google Maps only ~3 on phones → go stop by stop. */
const needsLegs = (nav, stops) => nav === 'waze' || (nav === 'google' && stops > 3);

/* ---------- Location ---------- */
let geoPerm = 'unknown';
try {
  navigator.permissions?.query({ name: 'geolocation' })
    .then(s => { geoPerm = s.state; s.onchange = () => { geoPerm = s.state; }; })
    .catch(() => {});
} catch (e) {}
const geoOkBefore = () => { try { return localStorage.getItem('whodrives.geo') === '1'; } catch (e) { return false; } };
function currentPos({ prompt = false } = {}) {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    const silentOk = geoPerm === 'granted' || (geoPerm === 'unknown' && geoOkBefore());
    if (!prompt && !silentOk) return resolve(null);
    navigator.geolocation.getCurrentPosition(p => {
      geoPerm = 'granted';
      try { localStorage.setItem('whodrives.geo', '1'); } catch (e) {}
      resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy });
    }, () => resolve(null), { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
}

/* ---------- Address field with autocomplete ---------- */
const placeState = {}, placeOpts = {}, placeTimers = {}, placeResults = {}, placeQuery = {};
function placeFieldHtml(fid, place, { label, hint = '', gps = false } = {}) {
  placeState[fid] = place ? { label: place.label, lat: place.lat, lon: place.lon } : null;
  placeOpts[fid] = { gps };
  return `<div class="fld"><span>${esc(label)}</span>
    <div id="pf-${fid}">${placeInnerHtml(fid)}</div>
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
  </div>`;
}
function placeInnerHtml(fid) {
  const p = placeState[fid];
  if (p) return `<div class="place-chosen"><span>📍 ${esc(p.label)}</span><button class="link-btn" data-act="place-clear" data-f="${fid}" type="button">Změnit</button></div>`;
  return `<input class="inp" data-place="${fid}" type="search" enterkeyhint="search" autocomplete="off" spellcheck="false" maxlength="150" placeholder="Začni psát adresu nebo místo…" aria-label="Hledat adresu">
    ${placeOpts[fid]?.gps ? `<button class="link-btn" data-act="place-gps" data-f="${fid}" type="button">📍 Použít moji aktuální polohu</button>` : ''}
    <div class="sugg" id="sg-${fid}" role="listbox"></div>`;
}
function placeInput(el) {
  const fid = el.dataset.place, q = el.value.trim();
  clearTimeout(placeTimers[fid]);
  const box = document.getElementById('sg-' + fid);
  if (q.length < 3) { if (box) box.innerHTML = ''; return; }
  placeTimers[fid] = setTimeout(async () => {
    try {
      const items = await suggestPlaces(q);
      if (el.value.trim() !== q) return; // user kept typing
      placeResults[fid] = items; placeQuery[fid] = q;
      const b = document.getElementById('sg-' + fid);
      if (!b) return;
      b.innerHTML = items.length
        ? items.map((it, i) => `<button class="sugg-item" data-act="place-pick" data-f="${fid}" data-i="${i}" type="button" role="option"><b>${esc(it.name)}</b><small>${esc(it.sub)}</small></button>`).join('')
        : '<span class="hint">Nic jsem nenašel – zkus to napsat jinak.</span>';
    } catch (e) {
      const b = document.getElementById('sg-' + fid);
      if (b) b.innerHTML = `<span class="hint err">${esc(mapyErr(e))}</span>`;
    }
  }, 300);
}
function pickPlace(fid, it) {
  placeState[fid] = { label: it.label, lat: it.lat, lon: it.lon };
  refreshPlace(fid);
}
/** Turns text typed into an address field (but not picked from the list) into a place. Returns false if it can't. */
async function resolvePlace(fid) {
  const el = document.querySelector(`[data-place="${fid}"]`);
  const q = el?.value.trim();
  if (placeState[fid] || !q) return true;
  clearTimeout(placeTimers[fid]);
  let it = placeQuery[fid] === q ? placeResults[fid]?.[0] : null;
  const box = document.getElementById('sg-' + fid);
  try { if (!it) it = await geocodePlace(q); }
  catch (e) { if (box) box.innerHTML = `<span class="hint err">${esc(mapyErr(e))}</span>`; return false; }
  if (!it) {
    if (box) box.innerHTML = '<span class="hint err">Tuhle adresu Mapy.com neznají – zkus ji napsat jinak, nebo vyber ze seznamu.</span>';
    el?.classList.add('bad');
    return false;
  }
  pickPlace(fid, it);
  return true;
}
async function placeEnter(el) {
  if (await resolvePlace(el.dataset.place)) toast('📍 Adresa vybrána – zkontroluj, že sedí.');
}
function refreshPlace(fid) {
  const el = document.getElementById('pf-' + fid);
  if (el) el.innerHTML = placeInnerHtml(fid);
  if (fid === 'dest' && tp) {
    tp.dest = placeState.dest ? { ...placeState.dest, preset: null } : null;
    planSoon();
  }
}
/** Value to save for an address field; keeps the stored one when the field wasn't shown. */
const placeValue = (fid, fallback) => (mapsReady() ? placeState[fid] || null : fallback || null);

/* ---------- Trip planner ("Vyrazit") ----------
   dir 'to':   driver's home / GPS → pickups → destination
   dir 'back': event place / GPS → drop-offs → driver's home ("rozvoz")
   Optional second car (tp.car2) when everybody doesn't fit into one. */
let tp = null, tpTimer = null, tpSeq = 0;
const navPref = () => { try { const v = localStorage.getItem('whodrives.nav'); return NAVS.includes(v) ? v : 'mapy'; } catch (e) { return 'mapy'; } };
const shortLabel = s => String(s || '').split(',')[0];
const seatsOf = id => M(id).seats || 5;
/** Departure time chosen in the planner (ms). */
const tpDep = () => (!tp || tp.when === 'now' ? Date.now() : tp.at || Date.now());
function tripTimeInput(el) {
  if (!tp || !/^\d{2}:\d{2}$/.test(el.value)) return;
  const [h, m] = el.value.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  if (d.getTime() < Date.now() - 5 * 60e3) d.setDate(d.getDate() + 1); // a time that already passed means tomorrow
  tp.at = d.getTime();
  const lbl = document.getElementById('tpDay');
  if (lbl) lbl.textContent = dayWord(tp.at) ? '→ ' + dayWord(tp.at).trim() : '→ dnes';
  planSoon(700);
}
/** Start and end of the route for one car. */
function legEnds(driver) {
  if (tp.dir === 'back') return { start: tp.from === 'gps' ? tp.gps : (tp.dest || null), end: M(driver).place || null };
  const start = driver === tp.driver ? (tp.from === 'home' ? M(driver).place || null : tp.gps) : (M(driver).place || null);
  return { start, end: tp.dest || null };
}
const picksOf = (driver, riders) => riders.filter(id => id !== driver).map(id => M(id)).filter(m => m.place)
  .map(m => ({ id: m.id, lat: m.place.lat, lon: m.place.lon }));
const cars = () => [{ driver: tp.driver, riders: tp.riders }, ...(tp.car2 ? [tp.car2] : [])];
const overCap = c => c.riders.length > seatsOf(c.driver);
const splitCandidates = () => {
  const b = balances();
  return tp.riders.filter(id => id !== tp.driver).map(id => M(id)).filter(m => m.car && m.place)
    .sort((x, y) => (b[x.id] || 0) - (b[y.id] || 0) || x.order - y.order);
};

function openTripSheet(opts = {}) {
  const ms = members(), off = offToday(), nd = nextDriver();
  const meM = ms.find(m => m.id === meId());
  const driver = opts.driver && ms.some(m => m.id === opts.driver && m.car) ? opts.driver
    : (meM && meM.car && !off.has(meM.id) ? meM : (nd || ms.find(m => m.car)))?.id;
  if (!driver) return toast('Nikdo s autem teď není k dispozici.');
  const pr = presets().find(p => p.place);
  const h = new Date().getHours();
  const dir = opts.dir === 'back' ? 'back' : 'to';
  tp = {
    id: rid(), dir, driver,
    riders: opts.riders ? [...new Set([driver, ...opts.riders.filter(id => ms.some(m => m.id === id))])]
      : ms.filter(m => !off.has(m.id) || m.id === driver).map(m => m.id),
    car2: null,
    from: dir === 'back' ? 'event' : (M(driver).place ? 'home' : 'gps'), gps: null,
    dest: opts.dest || (pr ? { ...pr.place, label: pr.label, preset: pr.id } : null),
    back: dir === 'to', log: false, night: h >= 21 || h < 4, sober: false, nav: navPref(),
    when: 'now', at: null,
    res: null, res2: null, busy: false, err: '', sig: ''
  };
  openSheetShell('', 'trip');
  renderTripSheet();
  if (tp.from === 'gps') locateStart(false);
  planSoon(0);
}

async function locateStart(prompt) {
  const p = await currentPos({ prompt });
  if (!tp) return;
  if (!p) { if (prompt) toast('Polohu se nepodařilo zjistit – povol ji v prohlížeči, nebo vyber místo ručně.'); return; }
  tp.gps = { label: 'Moje poloha', lat: p.lat, lon: p.lon };
  planSoon(0);
}

function planSoon(delay = 400) {
  if (!tp) return;
  clearTimeout(tpTimer);
  const A = legEnds(tp.driver);
  if (!A.start || !A.end) { tp.res = tp.res2 = null; tp.sig = ''; tp.busy = false; return renderTripSheet(); }
  const dep = tpDep();
  const parts = cars().map(c => { const e = legEnds(c.driver); return [c.driver, e.start && [e.start.lat, e.start.lon], e.end && [e.end.lat, e.end.lon], picksOf(c.driver, c.riders)]; });
  const sig = JSON.stringify([tp.dir, parts, isFuture(dep) ? Math.round(dep / 300000) : 'now']);
  if (sig === tp.sig && (tp.res || tp.busy)) return renderTripSheet();
  tp.sig = sig; tp.res = tp.res2 = null; tp.err = ''; tp.busy = true;
  renderTripSheet();
  tpTimer = setTimeout(computePlan, delay);
}

async function computePlan() {
  if (!tp) return;
  const seq = ++tpSeq, sig = tp.sig, dep = tpDep();
  let res = null, res2 = null, err = '';
  try {
    const A = legEnds(tp.driver);
    res = await planRoute(A.start, picksOf(tp.driver, tp.riders), A.end, dep);
    if (tp.car2) {
      const B = legEnds(tp.car2.driver);
      if (!B.start || !B.end) throw new Error('car2_addr');
      res2 = await planRoute(B.start, picksOf(tp.car2.driver, tp.car2.riders), B.end, dep);
    }
  } catch (e) {
    err = e.message === 'too_many' ? `Najednou zvládnu naplánovat nejvýš ${MAX_PICKUPS} zastávek.`
      : e.message === 'car2_addr' ? `${M(tp.car2.driver).name} nemá uloženou adresu – druhé auto nejde naplánovat.`
      : mapyErr(e);
  }
  if (!tp || seq !== tpSeq || tp.sig !== sig) return;
  tp.res = res; tp.res2 = res2; tp.err = err; tp.busy = false;
  renderTripSheet();
}

function buildTripFor(c, r, { planned = false } = {}) {
  const { start, end } = legEnds(c.driver), back = tp.dir === 'back';
  let cum = 0;
  const stops = r.order.map((id, i) => { const m = M(id); cum += r.legs[i] || 0; return { id, label: m.name, lat: m.place.lat, lon: m.place.lon, eta: cum }; });
  const destLabel = tp.dest.preset ? tp.dest.label : shortLabel(tp.dest.label);
  const startLabel = back ? (tp.from === 'gps' ? 'Moje poloha' : shortLabel(tp.dest.label)) : (c.driver === tp.driver && tp.from === 'gps' ? 'Start' : 'Domov');
  return {
    driver: c.driver, riders: [...c.riders],
    start: start ? { label: startLabel, lat: start.lat, lon: start.lon } : null,
    stops, end: { label: back ? 'Domov' : shortLabel(tp.dest.label), lat: end.lat, lon: end.lon },
    km: r.km, mins: r.mins, back: back ? false : tp.back,
    label: back ? `Zpět: ${destLabel}`.slice(0, 40) : destLabel,
    night: tp.night, sober: tp.sober, nav: tp.nav, legs: needsLegs(tp.nav, stops.length), leg: 0, ts: Date.now(),
    dep: planned ? tpDep() : Date.now(), planned, ret: back, log: back ? tp.log : true
  };
}
const buildTrip = (opts = {}) => buildTripFor({ driver: tp.driver, riders: tp.riders }, tp.res, opts);
const buildTrip2 = (opts = {}) => (tp.car2 && tp.res2 ? buildTripFor(tp.car2, tp.res2, { ...opts, planned: true }) : null);

function carListHtml(c, r, title) {
  const dep = tpDep(), back = tp.dir === 'back';
  let t = 0;
  const rows = r.order.map((id, i) => {
    t += r.legs[i] || 0;
    const m = M(id);
    return `<li>${av(m)}<span><b>${esc(m.name)}${youTag(m.id)}</b><small>${esc(shortLabel(m.place?.label))}</small></span><em>${hm(dep + t * 60e3)}</em></li>`;
  }).join('');
  const startLabel = back ? (tp.from === 'gps' ? 'Moje poloha' : shortLabel(tp.dest.label))
    : (c.driver === tp.driver && tp.from === 'gps' ? 'Moje poloha' : shortLabel(M(c.driver).place?.label));
  const endLabel = back ? `Domů – ${shortLabel(M(c.driver).place?.label)}` : shortLabel(tp.dest.label);
  return `${title ? `<div class="car-title">${title}</div>` : ''}<ol class="stops">
      <li><span class="stop-ico">${back ? '🏟️' : '🏠'}</span><span><b>Odjezd</b><small>${esc(startLabel)}</small></span><em>${esc(dayWord(dep))}${hm(dep)}</em></li>
      ${rows}
      <li><span class="stop-ico">🏁</span><span><b>${esc(endLabel)}</b><small>${back ? 'řidič doma' : 'cíl'}</small></span><em>${hm(dep + r.mins * 60e3)}</em></li>
    </ol>`;
}

function capacityHtml() {
  const over = cars().filter(overCap);
  if (!over.length) return '';
  const c = over[0], d = M(c.driver);
  const canSplit = !tp.car2 && splitCandidates().length > 0;
  const st = seatsOf(c.driver);
  return `<div class="preview warn">Auto, které řídí ${esc(d.name)}, má ${st} ${plural(st, 'místo', 'místa', 'míst')} – jede vás ${c.riders.length}.
      ${canSplit ? 'Rozdělte se do dvou aut.' : tp.car2 ? 'Nevejdete se ani do dvou aut – někoho odeber.' : 'Nikdo další s autem (a adresou) nejede – někoho odeber.'}</div>
    ${canSplit ? '<button class="btn outline block" data-act="tp-split" type="button">🚗🚗 Rozdělit do dvou aut</button>' : ''}`;
}

function tripResultHtml() {
  const back = tp.dir === 'back';
  if (tp.riders.length < 2 && !tp.car2) return '<div class="preview warn">Vyber aspoň jednoho spolujezdce.</div>';
  const A = legEnds(tp.driver);
  if (!A.start) {
    if (tp.from === 'gps') return '<div class="preview">📍 Zjišťuji tvoji polohu… (povol ji, nebo vyber místo ručně)</div>';
    return back ? '<div class="preview">Vyber, odkud jedete – místo akce.</div>' : '<div class="preview">Řidič nemá uloženou adresu – vyber „Moje poloha“.</div>';
  }
  if (!A.end) return back ? `<div class="preview warn">${esc(M(tp.driver).name)} nemá uloženou adresu domova – doplň ji ve Skupině.</div>` : '<div class="preview">Vyber, kam jedete – oblíbenou trasu nebo adresu.</div>';
  if (tp.when === 'pick' && !tp.at) return '<div class="preview">Zadej čas odjezdu – podle něj spočítám, kdy koho vyzvedneš.</div>';
  const cap = capacityHtml();
  if (tp.busy) return cap + `<div class="preview">⏳ Hledám nejrychlejší pořadí ${back ? 'rozvozu' : 'vyzvednutí'}…</div>`;
  if (tp.err) return cap + `<div class="preview warn">${esc(tp.err)}</div>`;
  if (!tp.res) return cap;
  const r = tp.res, r2 = tp.res2;
  const t1 = tp.car2 ? `🚗 Řídí ${esc(M(tp.driver).name)} · obsazeno ${tp.riders.length}/${seatsOf(tp.driver)}` : '';
  const t2 = tp.car2 && r2 ? `🚗 Řídí ${esc(M(tp.car2.driver).name)} · obsazeno ${tp.car2.riders.length}/${seatsOf(tp.car2.driver)}` : '';
  const km = r.km + (r2 ? r2.km : 0);
  const note = back
    ? (tp.log ? 'Rozvoz se zapíše do bilance.' : 'Do bilance se nezapisuje – cesta zpět je už započtená u cesty tam (×2).')
    : (tp.back ? `Do bilance se zapíše <b>${Math.round(r.km * 2)} km</b>${r2 ? ` a <b>${Math.round(r2.km * 2)} km</b>` : ''} (i cesta zpět).` : 'Objížďky kvůli vyzvedávání se řidiči započítají.');
  return `${cap}${carListHtml({ driver: tp.driver, riders: tp.riders }, r, t1)}${r2 ? carListHtml(tp.car2, r2, t2) : ''}
    <div class="preview">🚗 <b>${num(km, 1)} km</b>${r2 ? ' dohromady' : ''} · cca <b>${Math.round(Math.max(r.mins, r2 ? r2.mins : 0))} min</b>.
      <span class="note">${note}</span></div>`;
}

function renderTripSheet() {
  if (!tp || sheetKind !== 'trip') return;
  const sheet = $('#sheet'), sc = sheet.scrollTop;
  const active = document.activeElement;
  const typing = active?.dataset?.place === 'dest' ? active.value : null;
  const back = tp.dir === 'back';
  const ms = members(), drv = M(tp.driver), prs = presets().filter(p => p.place);
  const inCar2 = new Set(tp.car2 ? tp.car2.riders : []);
  const others = ms.filter(m => m.id !== tp.driver);
  const noAddr = tp.riders.filter(id => id !== tp.driver && !M(id).place).map(id => M(id).name);
  const needTime = tp.when === 'pick' && !tp.at;
  const over = cars().some(overCap);
  const ready = tp.res && !tp.busy && !tp.err && (tp.riders.length >= 2 || tp.car2) && !needTime && !over && (!tp.car2 || tp.res2);
  const n = tp.riders.length - 1 + (tp.car2 ? tp.car2.riders.length : 0);
  const placeBlock = `
    ${prs.length ? `<div class="presets" role="group" aria-label="Oblíbená místa">${prs.map(p => `
      <button class="${tp.dest?.preset === p.id ? 'on' : ''}" data-tp="dest" data-id="${p.id}" type="button">${esc(p.label)}<small>${esc(shortLabel(p.place.label))}</small></button>`).join('')}
    </div>` : ''}
    ${placeFieldHtml('dest', tp.dest && !tp.dest.preset ? tp.dest : null, { label: prs.length ? 'Nebo jiná adresa' : (back ? 'Adresa akce' : 'Adresa cíle') })}`;
  sheet.innerHTML = `${sheetHead(back ? 'Rozvoz domů' : 'Vyrazit')}
  <div class="seg seg2" role="radiogroup" aria-label="Směr">
    <button class="${!back ? 'on' : ''}" data-tp="dir" data-v="to" type="button" role="radio" aria-checked="${!back}">🚗 Tam</button>
    <button class="${back ? 'on' : ''}" data-tp="dir" data-v="back" type="button" role="radio" aria-checked="${back}">🏠 Zpět – rozvoz</button>
  </div>

  <div class="sec">Kdo řídí?</div>
  <div class="chips" role="radiogroup" aria-label="Řidič">${ms.filter(m => m.car).map(m => `
    <button class="chip ${tp.driver === m.id ? 'on' : 'off'}" data-tp="driver" data-id="${m.id}" type="button" role="radio" aria-checked="${tp.driver === m.id}">${av(m)}<span class="nm">${esc(m.name)}</span></button>`).join('')}
  </div>

  ${back ? `
  <div class="sec">Odkud jedete?</div>
  ${placeBlock}
  <div class="chips" style="margin-top:8px"><button class="chip ${tp.from === 'gps' ? 'on' : 'off'}" data-tp="from" data-v="${tp.from === 'gps' ? 'event' : 'gps'}" type="button" aria-pressed="${tp.from === 'gps'}">📍 <span class="nm">Jsme jinde – moje poloha</span></button></div>` : `
  <div class="sec">Odkud</div>
  <div class="chips" role="radiogroup" aria-label="Start">
    <button class="chip ${tp.from === 'home' ? 'on' : 'off'}" data-tp="from" data-v="home" type="button" role="radio" aria-checked="${tp.from === 'home'}" ${drv.place ? '' : 'disabled'}>🏠 <span class="nm">${drv.place ? esc(shortLabel(drv.place.label)) : 'Domov (bez adresy)'}</span></button>
    <button class="chip ${tp.from === 'gps' ? 'on' : 'off'}" data-tp="from" data-v="gps" type="button" role="radio" aria-checked="${tp.from === 'gps'}">📍 <span class="nm">Moje poloha</span></button>
  </div>`}

  <div class="sec"><span>${back ? 'Koho rozvezeš?' : 'Koho vyzvedneš?'}</span><small>${n} ${plural(n, 'člověk', 'lidé', 'lidí')} · v autě ${tp.riders.length}/${seatsOf(tp.driver)}</small></div>
  <div class="chips">${others.map(m => inCar2.has(m.id)
    ? `<span class="chip off car2">${av(m)}<span class="nm">${esc(m.name)}</span><span class="badge">${m.id === tp.car2.driver ? '2. auto – řídí' : '2. auto'}</span></span>`
    : `<button class="chip ${tp.riders.includes(m.id) ? 'on' : 'off'}" data-tp="rider" data-id="${m.id}" type="button" aria-pressed="${tp.riders.includes(m.id)}">${av(m)}<span class="nm">${esc(m.name)}</span>${m.place ? '' : '<span class="badge">bez adresy</span>'}</button>`).join('')}
  </div>
  ${tp.car2 ? `<div class="car2-card"><span>🚗🚗 <b>2. auto řídí ${esc(M(tp.car2.driver).name)}</b> a veze ${esc(tp.car2.riders.filter(id => id !== tp.car2.driver).map(id => M(id).name).join(', ') || 'nikoho')}.</span>
    <button class="link-btn" data-act="tp-unsplit" type="button">Jet jedním autem</button></div>` : ''}
  ${noAddr.length ? `<span class="hint">${esc(noAddr.join(', '))} ${noAddr.length > 1 ? 'nemají' : 'nemá'} adresu – počítám, že ${back ? 'vystoupí' : 'nastoupí'} rovnou u řidiče.</span>` : ''}

  ${back ? '' : `<div class="sec">Kam?</div>${placeBlock}`}

  <div class="sec">Kdy vyrážíte?</div>
  <div class="seg" role="radiogroup" aria-label="Odjezd">${[['now', 'Teď'], ['15', 'Za 15 min'], ['30', 'Za 30 min'], ['pick', 'Jindy']].map(([k, l]) => `
    <button class="${tp.when === k ? 'on' : ''}" data-tp="when" data-v="${k}" type="button" role="radio" aria-checked="${tp.when === k}">${l}</button>`).join('')}
  </div>
  ${tp.when === 'pick' ? `<div class="label-row"><input class="inp" id="tpTime" type="time" step="300" value="${tp.at ? hm(tp.at) : ''}" aria-label="Čas odjezdu"><span class="hint" id="tpDay">${tp.at ? (dayWord(tp.at) ? '→ ' + dayWord(tp.at).trim() : '→ dnes') : 'Zadej čas'}</span></div>` : ''}

  <div class="sec">Do bilance</div>
  ${back ? `<div class="tog"><div id="lblLog"><b>📒 Zapsat rozvoz do bilance</b><small>Zapni, jen když u cesty tam nebylo „i cesta zpět ×2“</small></div>
    <button class="sw2" data-tp="log" role="switch" aria-checked="${tp.log}" aria-labelledby="lblLog" type="button"></button></div>`
  : `<div class="tog"><div id="lblBack"><b>↩️ Počítat i cestu zpět</b><small>Kilometry ×2, jako u oblíbených tras</small></div>
    <button class="sw2" data-tp="back" role="switch" aria-checked="${tp.back}" aria-labelledby="lblBack" type="button"></button></div>`}
  ${!back || tp.log ? `<div class="tog"><div id="lblTNight"><b>🌙 Noční návrat / únava</b><small>×1,2 km</small></div>
    <button class="sw2" data-tp="night" role="switch" aria-checked="${tp.night}" aria-labelledby="lblTNight" type="button"></button></div>
  <div class="tog"><div id="lblTSober"><b>🥤 Řidič na akci nepije</b><small>×1,5 km</small></div>
    <button class="sw2" data-tp="sober" role="switch" aria-checked="${tp.sober}" aria-labelledby="lblTSober" type="button"></button></div>` : ''}

  <div class="sec">Trasa</div>
  ${tripResultHtml()}

  <div class="sec">Navigovat v</div>
  <div class="seg" role="radiogroup" aria-label="Navigace">${NAVS.map(k => `
    <button class="${tp.nav === k ? 'on' : ''}" data-tp="nav" data-v="${k}" type="button" role="radio" aria-checked="${tp.nav === k}">${NAV_NAMES[k]}</button>`).join('')}
  </div>
  ${tp.res && needsLegs(tp.nav, tp.res.order.length) ? `<span class="hint">${tp.nav === 'waze' ? 'Waze neumí víc zastávek najednou' : 'Google Maps v mobilu zvládne jen 3 zastávky'} – povedu tě po úsecích, další zastávku spustíš z appky.</span>` : ''}

  ${ready
    ? (isFuture(tpDep())
      ? `<button class="btn primary" style="margin-top:16px" data-act="plan-trip" type="button">📌 Naplánovat na ${esc(dayWord(tpDep()))}${hm(tpDep())}</button>
         <button class="btn outline block" style="margin-top:8px" data-act="tp-share" type="button">📣 Poslat partě časy</button>
         <span class="hint">Jízda se uloží celé partě. Až budete vyrážet, klepni v liště na „Vyrazit“.</span>`
      : `<a class="btn primary block" style="margin-top:16px" data-act="start-trip" href="${esc(navUrl(buildTrip()))}" target="_blank" rel="noopener noreferrer">▶ ${back ? 'Rozvézt' : 'Vyrazit'} · ${NAV_NAMES[tp.nav]}</a>
         <button class="btn outline block" style="margin-top:8px" data-act="tp-share" type="button">📣 Poslat partě časy</button>
         ${geoPerm === 'granted' ? `<span class="hint ok">📍 ${back ? 'Doma' : 'Po příjezdu'} stačí otevřít appku – jízda se ukončí sama.</span>`
           : '<button class="link-btn" data-act="geo-allow" type="button">📍 Povolit polohu, ať se jízda v cíli ukončí sama</button>'}`)
      + (tp.car2 ? `<span class="hint">🚗 Druhé auto se uloží jako naplánovaná jízda – ${esc(M(tp.car2.driver).name)} ji spustí v liště.</span>` : '')
    : `<button class="btn primary" style="margin-top:16px" type="button" disabled>${needTime ? 'Zadej čas odjezdu' : over ? 'Nevejdete se do auta' : back ? '▶ Rozvézt' : '▶ Vyrazit'}</button>`}
  <span class="hint attrib">Trasy a adresy: © Mapy.com</span>`;
  sheet.scrollTop = sc;
  if (typing != null) { const el = sheet.querySelector('[data-place="dest"]'); if (el) { el.value = typing; el.focus(); } }
}

function splitCars() {
  const seatsA = seatsOf(tp.driver), cands = splitCandidates();
  if (!cands.length) return toast('Nikdo další s autem a uloženou adresou nejede.');
  const B = cands[0], seatsB = seatsOf(B.id);
  const refA = tp.dir === 'back' ? M(tp.driver).place : legEnds(tp.driver).start;
  const refB = B.place;
  // < 0 → lives closer to car 1; people without an address stay with car 1
  const score = id => { const p = M(id).place; return p && refA && refB ? haversine(p, refA) - haversine(p, refB) : -1e9; };
  const rest = tp.riders.filter(id => id !== tp.driver && id !== B.id).sort((x, y) => score(x) - score(y));
  const inA = [], inB = [], left = [];
  for (const id of rest) {
    const aFree = inA.length + 1 < seatsA, bFree = inB.length + 1 < seatsB;
    const prefs = score(id) <= 0 ? [[aFree, inA], [bFree, inB]] : [[bFree, inB], [aFree, inA]];
    const slot = prefs.find(([free]) => free);
    (slot ? slot[1] : left).push(id);
  }
  tp.riders = [tp.driver, ...inA, ...left];
  tp.car2 = { driver: B.id, riders: [B.id, ...inB] };
  planSoon(0);
  toast(left.length ? `${left.map(id => M(id).name).join(', ')} se nevejde ani do dvou aut.` : `Rozděleno: ${B.name} veze ${inB.map(id => M(id).name).join(', ') || 'jen sebe'}.`);
}
function unsplitCars() {
  if (!tp.car2) return;
  tp.riders = [...new Set([...tp.riders, ...tp.car2.riders])];
  tp.car2 = null; tp.res2 = null;
  planSoon(0);
}

function tripClick(t) {
  if (!tp) return;
  const k = t.dataset.tp, id = t.dataset.id;
  if (k === 'dir') {
    if (tp.dir === t.dataset.v) return;
    unsplitCars();
    tp.dir = t.dataset.v;
    tp.from = tp.dir === 'back' ? 'event' : (M(tp.driver).place ? 'home' : 'gps');
    tp.back = tp.dir === 'to';
    if (tp.from === 'gps' && !tp.gps) locateStart(false);
  }
  if (k === 'driver') {
    unsplitCars();
    tp.driver = id;
    if (!tp.riders.includes(id)) tp.riders.push(id);
    if (tp.dir === 'to') {
      if (tp.from === 'home' && !M(id).place) { tp.from = 'gps'; if (!tp.gps) locateStart(true); }
      else if (M(id).place) tp.from = 'home';
    }
  }
  if (k === 'from') { tp.from = t.dataset.v; if (tp.from === 'gps' && !tp.gps) locateStart(true); }
  if (k === 'rider') tp.riders = tp.riders.includes(id) ? tp.riders.filter(x => x !== id) : [...tp.riders, id];
  if (k === 'dest') { const p = presets().find(x => x.id === id); if (p?.place) { tp.dest = { ...p.place, label: p.label, preset: p.id }; if (tp.dir === 'back') tp.from = 'event'; } }
  if (k === 'back' || k === 'night' || k === 'sober' || k === 'log') { tp[k] = !tp[k]; return renderTripSheet(); }
  if (k === 'when') {
    tp.when = t.dataset.v;
    if (tp.when === '15' || tp.when === '30') tp.at = Math.ceil((Date.now() + +tp.when * 60e3) / 300000) * 300000;
    if (tp.when === 'pick' && !tp.at) tp.at = null;
    renderTripSheet();
    if (tp.when === 'pick') { document.getElementById('tpTime')?.focus(); if (!tp.at) return; }
    return planSoon(0);
  }
  if (k === 'nav') {
    tp.nav = t.dataset.v;
    try { localStorage.setItem('whodrives.nav', tp.nav); } catch (e) {}
    return renderTripSheet();
  }
  planSoon();
}

/* ---------- "Drive everybody home?" card after a trip ---------- */
const RET_KEY = 'whodrives.ret';
function rememberReturn(doc) {
  if (doc.ret) return;
  try { localStorage.setItem(RET_KEY, JSON.stringify({ g: grp().id, driver: doc.driver, riders: doc.riders, dest: { label: doc.label, lat: doc.end.lat, lon: doc.end.lon }, ts: Date.now() })); } catch (e) {}
}
function pendingReturn() {
  try {
    const r = JSON.parse(localStorage.getItem(RET_KEY));
    if (!r || r.g !== grp()?.id || Date.now() - r.ts > 10 * 3600e3) return null;
    if (activeTrips().some(t => t.ret)) return null;
    return r;
  } catch (e) { return null; }
}
function returnCardHtml() {
  const r = pendingReturn();
  if (!r || !mapsReady()) return '';
  return `<section class="card me-card">
    <div class="me-head"><h4>🏠 Rozvézt partu domů?</h4><button class="close-x" data-act="ret-skip" type="button" aria-label="Teď ne">${icons.x}</button></div>
    <p>Až budete odjíždět z „${esc(r.dest.label)}“, appka seřadí, koho vysadíš první, a nastaví navigaci.</p>
    <div class="acts"><button class="btn primary" data-act="ret-plan" type="button">🏠 Naplánovat rozvoz</button></div>
  </section>`;
}

/* ---------- Trips in progress ---------- */
const MY_TRIPS = 'whodrives.mytrips';
const myTrips = () => { try { return new Set(JSON.parse(localStorage.getItem(MY_TRIPS)) || []); } catch (e) { return new Set(); } };
function rememberTrip(id, on) {
  const s = myTrips();
  on ? s.add(id) : s.delete(id);
  try { localStorage.setItem(MY_TRIPS, JSON.stringify([...s].slice(-20))); } catch (e) {}
}
function activeTrips() {
  const g = grp();
  return g && !g.joining ? docsOf(g, 't:').sort((a, b) => b.ts - a.ts) : [];
}

function tripBarsHtml() {
  const me = meId();
  return activeTrips().map(t => {
    const d = M(t.driver), pts = navTargets(t), next = pts[0];
    const pickLeft = t.leg < t.stops.length;
    const total = Math.round(t.km * (t.back ? 2 : 1));
    const nStops = t.stops.length;
    const myStop = t.stops.find(s => s.id === me && me !== t.driver);
    const mine = myStop ? ` · <b>${t.ret ? 'vystoupíš' : 'u tebe'} ${hm(t.dep + myStop.eta * 60e3)}</b>` : '';
    const summary = `${nStops ? `${nStops} ${plural(nStops, 'zastávka', 'zastávky', 'zastávek')} · ` : ''}${total} km`;
    const share = `<button class="btn sm glass" data-act="trip-share" data-id="${t.id}" type="button" aria-label="Poslat partě časy">📣</button>`;
    const cancel = `<button class="btn sm glass" data-act="trip-cancel" data-id="${t.id}" type="button" aria-label="Zrušit jízdu">✕</button>`;
    const navLink = (cls, label, act) => `<a class="btn sm ${cls}" href="${esc(navUrl(t))}" target="_blank" rel="noopener noreferrer" data-act="${act}" data-id="${t.id}">${label}</a>`;
    if (t.planned) {
      const late = Date.now() - t.dep > 12 * 3600e3;
      return `<section class="trip-bar planned" aria-label="Naplánovaná jízda">
        <div class="tb-top"><span class="tb-lbl">${late ? '⏰ Jízda se nekonala?' : t.ret ? '🗓 Naplánovaný rozvoz' : '🗓 Naplánovaná jízda'}</span><small>odjezd ${esc(whenText(t.dep))}</small></div>
        <b class="tb-title">${esc(d.name)}${youTag(t.driver)} → ${esc(t.label)}</b>
        <small class="tb-sub">${summary} · ${t.ret ? 'řidič doma' : 'příjezd'} kolem ${hm(t.dep + t.mins * 60e3)}${mine}</small>
        <div class="tb-acts">${navLink('accent', '▶ Vyrazit', 'trip-go')}${share}${cancel}</div>
      </section>`;
    }
    const old = Date.now() - t.ts > 12 * 3600e3;
    const sub = t.legs && pickLeft
      ? `Další zastávka: <b>${esc(next.name)}</b>${mine}`
      : `${summary} · ${t.ret ? 'doma' : 'v cíli'} kolem ${hm(t.dep + t.mins * 60e3)}${mine}`;
    return `<section class="trip-bar" aria-label="Probíhající jízda">
      <div class="tb-top"><span class="tb-lbl">${old ? '⏰ Jízda pořád běží' : t.ret ? '🏠 Rozvoz probíhá' : '🚗 Jízda probíhá'}</span><small>${esc(dateLabel(t.ts))}</small></div>
      <b class="tb-title">${esc(d.name)}${youTag(t.driver)} → ${esc(t.label)}</b>
      <small class="tb-sub">${sub}</small>
      <div class="tb-acts">
        ${navLink('accent', 'Navigovat', 'trip-nav')}
        ${t.legs && pickLeft ? `<button class="btn sm glass" data-act="trip-next" data-id="${t.id}" type="button">✓ Vyzvednuto: ${esc(next.name)}</button>` : ''}
        <button class="btn sm light" data-act="trip-done" data-id="${t.id}" type="button">🏁 ${t.ret ? 'Hotovo' : 'Dojeli jsme'}</button>
        ${share}${cancel}
      </div>
    </section>`;
  }).join('');
}

function finishTrip(id, auto) {
  const doc = grp()?.docs['t:' + id]?.d;
  if (!doc) return;
  if (doc.ret && !doc.log) {
    del('t:' + id); rememberTrip(id, false); render();
    return toast(`🏠 ${auto ? 'Jsi doma – ' : ''}rozvoz hotový. Cesta zpět už je v bilanci.`, { label: 'Vrátit', run: () => { put('t:' + id, doc); rememberTrip(id, true); render(); } });
  }
  rememberReturn(doc);
  const km = Math.max(1, Math.round(doc.km * (doc.back ? 2 : 1)));
  put('r:' + id, { driver: doc.driver, riders: doc.riders, km, label: doc.label, night: doc.night, sober: doc.sober, ts: Date.now(), auto });
  del('t:' + id);
  rememberTrip(id, false);
  if (committed().has(doc.driver)) put('c:' + doc.driver, { on: false });
  render();
  toast(`🏁 ${auto ? 'Jste v cíli – jízda zapsána' : 'Jízda zapsána'} (${km} km).`, {
    label: 'Vrátit', run: () => { del('r:' + id); put('t:' + id, doc); rememberTrip(id, true); render(); }
  });
}

let arrivalBusy = false;
async function checkArrival() {
  if (arrivalBusy || document.visibilityState !== 'visible') return;
  const mine = myTrips();
  if (!activeTrips().some(t => mine.has(t.id) && !t.planned)) return; // only the phone that started the trip decides
  arrivalBusy = true;
  try {
    const pos = await currentPos();
    if (!pos) return;
    for (const t of activeTrips()) {
      if (!mine.has(t.id) || t.planned || Date.now() - t.ts < 3 * 60e3) continue;
      if (haversine(pos, t.end) <= 400) { finishTrip(t.id, true); continue; }
      if (t.legs && t.leg < t.stops.length && haversine(pos, t.stops[t.leg]) <= 250) {
        put('t:' + t.id, { ...t, leg: t.leg + 1 });
        render();
        toast(`✓ Vyzvednuto: ${M(t.stops[t.leg].id).name}. Navigace na další zastávku je připravená.`);
      }
    }
  } finally { arrivalBusy = false; }
}
function startTripWatch() {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(checkArrival, 800); });
  setInterval(checkArrival, 45000);
  setTimeout(checkArrival, 1500);
}

/* ---------- Actions (merged into app.js actions) ---------- */
const mapActions = {
  'trip': () => openTripSheet(),
  'place-pick': t => {
    const fid = t.dataset.f, it = placeResults[fid]?.[+t.dataset.i];
    if (it) pickPlace(fid, it);
  },
  'place-clear': t => {
    const fid = t.dataset.f;
    placeState[fid] = null;
    refreshPlace(fid);
    document.querySelector(`[data-place="${fid}"]`)?.focus();
  },
  'place-gps': async t => {
    const fid = t.dataset.f;
    t.disabled = true; t.textContent = '📍 Zjišťuji polohu…';
    const p = await currentPos({ prompt: true });
    if (!p) { t.disabled = false; t.textContent = '📍 Použít moji aktuální polohu'; return toast('Polohu se nepodařilo zjistit – povol ji v nastavení prohlížeče.'); }
    let label = 'Moje poloha';
    try { label = await reverseGeocode(p); } catch (e) {}
    placeState[fid] = { label, lat: p.lat, lon: p.lon };
    refreshPlace(fid);
  },
  'geo-allow': async () => {
    const p = await currentPos({ prompt: true });
    toast(p ? '📍 Díky! V cíli stačí otevřít appku.' : 'Poloha není povolená – v cíli pak klepni na „Dojeli jsme“.');
    renderTripSheet();
  },
  'start-trip': () => {
    if (!tp?.res) return;
    const id = tp.id, trip2 = buildTrip2();
    put('t:' + id, buildTrip());
    if (trip2) put('t:' + rid(), trip2);
    if (tp.dir === 'back') try { localStorage.removeItem(RET_KEY); } catch (e) {}
    rememberTrip(id, true);
    // let the browser follow the link first, then tidy up the UI
    setTimeout(() => { closeSheet(); tab = 'home'; render(); toast('🚗 Šťastnou cestu! V cíli otevři appku a jízda se zapíše sama.'); }, 80);
  },
  'trip-nav': () => {},
  'tp-share': () => { if (tp?.res) shareTrip({ ...buildTrip({ planned: isFuture(tpDep()) }), dep: tpDep() }, buildTrip2()); },
  'tp-split': () => tp && splitCars(),
  'tp-unsplit': () => tp && unsplitCars(),
  'ret-plan': () => { const r = pendingReturn(); if (r) openTripSheet({ dir: 'back', driver: r.driver, riders: r.riders, dest: { ...r.dest, preset: null } }); },
  'ret-skip': () => { try { localStorage.removeItem(RET_KEY); } catch (e) {} render(); },
  'trip-share': t => { const doc = grp().docs['t:' + t.dataset.id]?.d; if (doc) shareTrip(doc); },
  'plan-trip': () => {
    if (!tp?.res) return;
    const trip = buildTrip({ planned: true }), trip2 = buildTrip2();
    put('t:' + tp.id, trip);
    if (trip2) put('t:' + rid(), trip2);
    if (tp.dir === 'back') try { localStorage.removeItem(RET_KEY); } catch (e) {}
    closeSheet(); tab = 'home'; render();
    toast(`📌 Naplánováno na ${dayWord(trip.dep)}${hm(trip.dep)}${trip2 ? ' (2 auta)' : ''}. Pošli partě časy.`, { label: 'Poslat', run: () => shareTrip(trip, trip2) });
  },
  'trip-go': t => {
    const id = t.dataset.id, doc = grp().docs['t:' + id]?.d;
    if (!doc) return;
    put('t:' + id, { ...doc, planned: false, ts: Date.now(), dep: Date.now() });
    rememberTrip(id, true);
    setTimeout(() => { render(); toast('🚗 Šťastnou cestu! V cíli otevři appku a jízda se zapíše sama.'); }, 80);
  },
  'trip-next': t => {
    const doc = grp().docs['t:' + t.dataset.id]?.d;
    if (!doc) return;
    put('t:' + t.dataset.id, { ...doc, leg: Math.min(doc.leg + 1, doc.stops.length) });
    render();
  },
  'trip-done': t => finishTrip(t.dataset.id, false),
  'trip-cancel': t => {
    const id = t.dataset.id, doc = grp().docs['t:' + id]?.d;
    if (!doc || !confirm('Zrušit probíhající jízdu? Do bilance se nic nezapíše.')) return;
    del('t:' + id); rememberTrip(id, false); render();
    toast('Jízda zrušena.', { label: 'Vrátit', run: () => { put('t:' + id, doc); render(); } });
  }
};
