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
const ll = p => `${p.lon},${p.lat}`;
const latlng = p => `${p.lat},${p.lon}`;

function placeFromItem(it) {
  const lat = +it?.position?.lat, lon = +it?.position?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const name = String(it.name || '').slice(0, 80), sub = String(it.location || '').slice(0, 80);
  return { name, sub, label: [name, sub].filter(Boolean).join(', ').slice(0, 120), lat, lon };
}
async function suggestPlaces(q) {
  const r = await mapy('/suggest', {
    query: q.slice(0, 150), lang: 'cs', limit: 6, preferBBox: CZ_BBOX,
    type: ['regional.address', 'regional.street', 'regional.municipality_part', 'regional.municipality', 'poi']
  });
  return (r?.items || []).map(placeFromItem).filter(Boolean);
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
async function routeM(start, end, via) {
  const r = await mapy('/routing/route', {
    start: ll(start), end: ll(end), waypoints: via.length ? via.map(ll).join(';') : null,
    routeType: 'car_fast_traffic', format: 'polyline', lang: 'cs'
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
async function planRoute(start, picks, end) {
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
  const r = await routeM(start, end, ordered);
  return {
    order: ordered.map(p => p.id),
    km: +r.length / 1000,
    mins: +r.duration / 60,
    legs: Array.isArray(r.parts) ? r.parts.map(p => (+p.duration || 0) / 60) : []
  };
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
    case 'apple': {
      const q = new URLSearchParams({ destination: latlng(dest), mode: 'driving' });
      via.forEach(p => q.append('waypoint', latlng(p)));
      return 'https://maps.apple.com/directions?' + q;
    }
    case 'waze':
      return `https://waze.com/ul?ll=${encodeURIComponent(latlng(dest))}&navigate=yes`;
    default: {
      const from = trip.leg ? trip.stops[trip.leg - 1] : trip.start;
      const q = new URLSearchParams({ end: ll(dest), routeType: 'car_fast_traffic', navigate: 'true' });
      if (from) q.set('start', ll(from));
      if (via.length) q.set('waypoints', via.map(ll).join(';'));
      return 'https://mapy.com/fnc/v1/route?' + q;
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
const placeState = {}, placeOpts = {}, placeTimers = {}, placeResults = {};
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
      placeResults[fid] = items;
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

/* ---------- Trip planner ("Vyrazit") ---------- */
let tp = null, tpTimer = null, tpSeq = 0;
const navPref = () => { try { const v = localStorage.getItem('whodrives.nav'); return NAVS.includes(v) ? v : 'mapy'; } catch (e) { return 'mapy'; } };
const shortLabel = s => String(s || '').split(',')[0];
const startPoint = () => !tp ? null : tp.from === 'home' ? (M(tp.driver).place || null) : tp.gps;
const pickups = () => tp.riders.filter(id => id !== tp.driver).map(id => M(id)).filter(m => m.place)
  .map(m => ({ id: m.id, lat: m.place.lat, lon: m.place.lon }));

function openTripSheet() {
  const ms = members(), off = offToday(), nd = nextDriver();
  const driver = (nd || ms.find(m => m.car))?.id;
  if (!driver) return toast('Nikdo s autem teď není k dispozici.');
  const pr = presets().find(p => p.place);
  const h = new Date().getHours();
  tp = {
    id: rid(), driver,
    riders: ms.filter(m => !off.has(m.id) || m.id === driver).map(m => m.id),
    from: M(driver).place ? 'home' : 'gps', gps: null,
    dest: pr ? { ...pr.place, label: pr.label, preset: pr.id } : null,
    back: true, night: h >= 21 || h < 4, sober: false, nav: navPref(),
    res: null, busy: false, err: '', sig: ''
  };
  openSheetShell('', 'trip');
  renderTripSheet();
  if (tp.from === 'gps') locateStart(false);
  planSoon(0);
}

async function locateStart(prompt) {
  const p = await currentPos({ prompt });
  if (!tp) return;
  if (!p) { if (prompt) toast('Polohu se nepodařilo zjistit – povol ji v prohlížeči, nebo vyber start z domova.'); return; }
  tp.gps = { label: 'Moje poloha', lat: p.lat, lon: p.lon };
  planSoon(0);
}

function planSoon(delay = 400) {
  if (!tp) return;
  clearTimeout(tpTimer);
  const start = startPoint(), picks = pickups();
  if (!tp.dest || !start) { tp.res = null; tp.sig = ''; tp.busy = false; return renderTripSheet(); }
  const sig = JSON.stringify([start.lat, start.lon, picks, tp.dest.lat, tp.dest.lon]);
  if (sig === tp.sig && (tp.res || tp.busy)) return renderTripSheet();
  tp.sig = sig; tp.res = null; tp.err = ''; tp.busy = true;
  renderTripSheet();
  tpTimer = setTimeout(computePlan, delay);
}

async function computePlan() {
  if (!tp) return;
  const seq = ++tpSeq, sig = tp.sig;
  let res = null, err = '';
  try { res = await planRoute(startPoint(), pickups(), tp.dest); }
  catch (e) { err = e.message === 'too_many' ? `Najednou zvládnu naplánovat nejvýš ${MAX_PICKUPS} zastávek.` : mapyErr(e); }
  if (!tp || seq !== tpSeq || tp.sig !== sig) return;
  tp.res = res; tp.err = err; tp.busy = false;
  renderTripSheet();
}

function buildTrip() {
  const start = startPoint(), r = tp.res;
  const stops = r.order.map(id => { const m = M(id); return { id, label: m.name, lat: m.place.lat, lon: m.place.lon }; });
  return {
    driver: tp.driver, riders: [...tp.riders],
    start: start ? { label: tp.from === 'home' ? 'Domov' : 'Start', lat: start.lat, lon: start.lon } : null,
    stops, end: { label: shortLabel(tp.dest.label), lat: tp.dest.lat, lon: tp.dest.lon },
    km: r.km, mins: r.mins, back: tp.back,
    label: tp.dest.preset ? tp.dest.label : shortLabel(tp.dest.label),
    night: tp.night, sober: tp.sober, nav: tp.nav, legs: needsLegs(tp.nav, stops.length), leg: 0, ts: Date.now()
  };
}

function tripResultHtml() {
  if (tp.riders.length < 2) return '<div class="preview warn">Vyber aspoň jednoho spolujezdce.</div>';
  if (!startPoint()) return `<div class="preview">${tp.from === 'gps' ? '📍 Zjišťuji tvoji polohu… (povol ji, nebo vyber start z domova)' : 'Řidič nemá uloženou adresu – vyber „Moje poloha“.'}</div>`;
  if (!tp.dest) return '<div class="preview">Vyber, kam jedete – oblíbenou trasu nebo adresu.</div>';
  if (tp.busy) return '<div class="preview">⏳ Hledám nejrychlejší pořadí vyzvednutí…</div>';
  if (tp.err) return `<div class="preview warn">${esc(tp.err)}</div>`;
  if (!tp.res) return '';
  const r = tp.res;
  let t = 0;
  const rows = r.order.map((id, i) => {
    t += r.legs[i] || 0;
    const m = M(id);
    return `<li>${av(m)}<span><b>${esc(m.name)}</b><small>${esc(shortLabel(m.place?.label))}</small></span><em>+${Math.max(1, Math.round(t))} min</em></li>`;
  }).join('');
  const total = Math.round(r.km * (tp.back ? 2 : 1));
  return `<ol class="stops">
      <li><span class="stop-ico">🏠</span><span><b>Start</b><small>${esc(tp.from === 'home' ? shortLabel(M(tp.driver).place?.label) : 'Moje poloha')}</small></span><em>0 min</em></li>
      ${rows}
      <li><span class="stop-ico">🏁</span><span><b>${esc(shortLabel(tp.dest.label))}</b><small>cíl</small></span><em>${Math.round(r.mins)} min</em></li>
    </ol>
    <div class="preview">🚗 <b>${num(r.km, 1)} km</b> za cca <b>${Math.round(r.mins)} min</b>${tp.back ? ` · do bilance se zapíše <b>${total} km</b> (i cesta zpět)` : ''}.
      <span class="note">Objížďky kvůli vyzvedávání se řidiči započítají.</span></div>`;
}

function renderTripSheet() {
  if (!tp || sheetKind !== 'trip') return;
  const sheet = $('#sheet'), sc = sheet.scrollTop;
  const active = document.activeElement;
  const typing = active?.dataset?.place === 'dest' ? active.value : null;
  const ms = members(), drv = M(tp.driver), prs = presets().filter(p => p.place);
  const others = ms.filter(m => m.id !== tp.driver);
  const noAddr = tp.riders.filter(id => id !== tp.driver && !M(id).place).map(id => M(id).name);
  const ready = tp.res && !tp.busy && !tp.err && tp.riders.length >= 2;
  const n = tp.riders.length - 1;
  sheet.innerHTML = `${sheetHead('Vyrazit')}
  <div class="sec">Kdo řídí?</div>
  <div class="chips" role="radiogroup" aria-label="Řidič">${ms.filter(m => m.car).map(m => `
    <button class="chip ${tp.driver === m.id ? 'on' : 'off'}" data-tp="driver" data-id="${m.id}" type="button" role="radio" aria-checked="${tp.driver === m.id}">${av(m)}<span class="nm">${esc(m.name)}</span></button>`).join('')}
  </div>

  <div class="sec">Odkud</div>
  <div class="chips" role="radiogroup" aria-label="Start">
    <button class="chip ${tp.from === 'home' ? 'on' : 'off'}" data-tp="from" data-v="home" type="button" role="radio" aria-checked="${tp.from === 'home'}" ${drv.place ? '' : 'disabled'}>🏠 <span class="nm">${drv.place ? esc(shortLabel(drv.place.label)) : 'Domov (bez adresy)'}</span></button>
    <button class="chip ${tp.from === 'gps' ? 'on' : 'off'}" data-tp="from" data-v="gps" type="button" role="radio" aria-checked="${tp.from === 'gps'}">📍 <span class="nm">Moje poloha</span></button>
  </div>

  <div class="sec"><span>Koho vyzvedneš?</span><small>${n} ${plural(n, 'člověk', 'lidé', 'lidí')}</small></div>
  <div class="chips">${others.map(m => `
    <button class="chip ${tp.riders.includes(m.id) ? 'on' : 'off'}" data-tp="rider" data-id="${m.id}" type="button" aria-pressed="${tp.riders.includes(m.id)}">${av(m)}<span class="nm">${esc(m.name)}</span>${m.place ? '' : '<span class="badge">bez adresy</span>'}</button>`).join('')}
  </div>
  ${noAddr.length ? `<span class="hint">${esc(noAddr.join(', '))} ${noAddr.length > 1 ? 'nemají' : 'nemá'} adresu – počítám, že ${noAddr.length > 1 ? 'nastoupí' : 'nastoupí'} rovnou u tebe.</span>` : ''}

  <div class="sec">Kam?</div>
  ${prs.length ? `<div class="presets" role="group" aria-label="Oblíbené cíle">${prs.map(p => `
    <button class="${tp.dest?.preset === p.id ? 'on' : ''}" data-tp="dest" data-id="${p.id}" type="button">${esc(p.label)}<small>${esc(shortLabel(p.place.label))}</small></button>`).join('')}
  </div>` : ''}
  ${placeFieldHtml('dest', tp.dest && !tp.dest.preset ? tp.dest : null, { label: prs.length ? 'Nebo jiná adresa' : 'Adresa cíle' })}

  <div class="sec">Do bilance</div>
  <div class="tog"><div id="lblBack"><b>↩️ Počítat i cestu zpět</b><small>Kilometry ×2, jako u oblíbených tras</small></div>
    <button class="sw2" data-tp="back" role="switch" aria-checked="${tp.back}" aria-labelledby="lblBack" type="button"></button></div>
  <div class="tog"><div id="lblTNight"><b>🌙 Noční návrat / únava</b><small>×1,2 km</small></div>
    <button class="sw2" data-tp="night" role="switch" aria-checked="${tp.night}" aria-labelledby="lblTNight" type="button"></button></div>
  <div class="tog"><div id="lblTSober"><b>🥤 Řidič na akci nepije</b><small>×1,5 km</small></div>
    <button class="sw2" data-tp="sober" role="switch" aria-checked="${tp.sober}" aria-labelledby="lblTSober" type="button"></button></div>

  <div class="sec">Trasa</div>
  ${tripResultHtml()}

  <div class="sec">Navigovat v</div>
  <div class="seg" role="radiogroup" aria-label="Navigace">${NAVS.map(k => `
    <button class="${tp.nav === k ? 'on' : ''}" data-tp="nav" data-v="${k}" type="button" role="radio" aria-checked="${tp.nav === k}">${NAV_NAMES[k]}</button>`).join('')}
  </div>
  ${tp.res && needsLegs(tp.nav, tp.res.order.length) ? `<span class="hint">${tp.nav === 'waze' ? 'Waze neumí víc zastávek najednou' : 'Google Maps v mobilu zvládne jen 3 zastávky'} – povedu tě po úsecích, další zastávku spustíš z appky.</span>` : ''}

  ${ready
    ? `<a class="btn primary block" style="margin-top:16px" data-act="start-trip" href="${esc(navUrl(buildTrip()))}" target="_blank" rel="noopener noreferrer">▶ Vyrazit · ${NAV_NAMES[tp.nav]}</a>
       ${geoPerm === 'granted' ? '<span class="hint ok">📍 Po příjezdu stačí otevřít appku – jízda se zapíše sama.</span>'
         : '<button class="link-btn" data-act="geo-allow" type="button">📍 Povolit polohu, ať se jízda v cíli zapíše sama</button>'}`
    : `<button class="btn primary" style="margin-top:16px" type="button" disabled>▶ Vyrazit</button>`}
  <span class="hint attrib">Trasy a adresy: © Mapy.com</span>`;
  sheet.scrollTop = sc;
  if (typing != null) { const el = sheet.querySelector('[data-place="dest"]'); if (el) { el.value = typing; el.focus(); } }
}

function tripClick(t) {
  if (!tp) return;
  const k = t.dataset.tp, id = t.dataset.id;
  if (k === 'driver') {
    tp.driver = id;
    if (!tp.riders.includes(id)) tp.riders.push(id);
    if (tp.from === 'home' && !M(id).place) { tp.from = 'gps'; if (!tp.gps) locateStart(true); }
    else if (M(id).place) tp.from = 'home';
  }
  if (k === 'from') { tp.from = t.dataset.v; if (tp.from === 'gps' && !tp.gps) locateStart(true); }
  if (k === 'rider') tp.riders = tp.riders.includes(id) ? tp.riders.filter(x => x !== id) : [...tp.riders, id];
  if (k === 'dest') { const p = presets().find(x => x.id === id); if (p?.place) tp.dest = { ...p.place, label: p.label, preset: p.id }; }
  if (k === 'back' || k === 'night' || k === 'sober') { tp[k] = !tp[k]; return renderTripSheet(); }
  if (k === 'nav') {
    tp.nav = t.dataset.v;
    try { localStorage.setItem('whodrives.nav', tp.nav); } catch (e) {}
    return renderTripSheet();
  }
  planSoon();
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
  return activeTrips().map(t => {
    const d = M(t.driver), pts = navTargets(t), next = pts[0];
    const pickLeft = t.leg < t.stops.length;
    const total = Math.round(t.km * (t.back ? 2 : 1));
    const old = Date.now() - t.ts > 12 * 3600e3;
    const nStops = t.stops.length;
    const sub = t.legs && pickLeft
      ? `Další zastávka: <b>${esc(next.name)}</b>`
      : `${nStops ? `${nStops} ${plural(nStops, 'zastávka', 'zastávky', 'zastávek')} · ` : ''}${total} km · cca ${Math.round(t.mins)} min`;
    return `<section class="trip-bar" aria-label="Probíhající jízda">
      <div class="tb-top"><span class="tb-lbl">${old ? '⏰ Jízda pořád běží' : '🚗 Jízda probíhá'}</span><small>${esc(dateLabel(t.ts))}</small></div>
      <b class="tb-title">${esc(d.name)} → ${esc(t.label)}</b>
      <small class="tb-sub">${sub}</small>
      <div class="tb-acts">
        <a class="btn sm accent" href="${esc(navUrl(t))}" target="_blank" rel="noopener noreferrer" data-act="trip-nav">Navigovat</a>
        ${t.legs && pickLeft ? `<button class="btn sm glass" data-act="trip-next" data-id="${t.id}" type="button">✓ Vyzvednuto: ${esc(next.name)}</button>` : ''}
        <button class="btn sm light" data-act="trip-done" data-id="${t.id}" type="button">🏁 Dojeli jsme</button>
        <button class="btn sm glass" data-act="trip-cancel" data-id="${t.id}" type="button" aria-label="Zrušit jízdu">✕</button>
      </div>
    </section>`;
  }).join('');
}

function finishTrip(id, auto) {
  const doc = grp()?.docs['t:' + id]?.d;
  if (!doc) return;
  const km = Math.max(1, Math.round(doc.km * (doc.back ? 2 : 1)));
  put('r:' + id, { driver: doc.driver, riders: doc.riders, km, label: doc.label, night: doc.night, sober: doc.sober, ts: Date.now(), auto });
  del('t:' + id);
  rememberTrip(id, false);
  if (committed().has(doc.driver)) put('c:' + doc.driver, { on: false });
  render();
  toast(`🏁 ${auto ? 'Jste v cíli – ' : ''}jízda zapsána (${km} km).`, {
    label: 'Vrátit', run: () => { del('r:' + id); put('t:' + id, doc); rememberTrip(id, true); render(); }
  });
}

let arrivalBusy = false;
async function checkArrival() {
  if (arrivalBusy || document.visibilityState !== 'visible') return;
  const mine = myTrips();
  if (!activeTrips().some(t => mine.has(t.id))) return; // only the phone that started the trip decides
  arrivalBusy = true;
  try {
    const pos = await currentPos();
    if (!pos) return;
    for (const t of activeTrips()) {
      if (!mine.has(t.id) || Date.now() - t.ts < 3 * 60e3) continue;
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
    if (!it) return;
    placeState[fid] = { label: it.label, lat: it.lat, lon: it.lon };
    refreshPlace(fid);
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
    const id = tp.id;
    put('t:' + id, buildTrip());
    rememberTrip(id, true);
    // let the browser follow the link first, then tidy up the UI
    setTimeout(() => { closeSheet(); tab = 'home'; render(); toast('🚗 Šťastnou cestu! V cíli otevři appku a jízda se zapíše sama.'); }, 80);
  },
  'trip-nav': () => {},
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
