// Parkoptimierer – Frontend (ohne Build-Schritt)

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privat */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* privat */ } },
};

const COLORS = ['#5b8cff', '#ff6b5b', '#3ecf8e', '#ffb547', '#b57cff', '#ff7ab6', '#2ec4d6', '#e9ecf2', '#7c8594', '#2b3240'];
const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

let token = store.get('park.token');
let S = null;            // aktueller Server-Zustand
let selectedSpot = null;

// ── API ─────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { token = null; store.del('park.token'); }
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

async function act(fn, okMsg) {
  try {
    const r = await fn();
    await refresh();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

// ── Zeit ────────────────────────────────────────────────────────────
const tz = () => S?.lot.timezone || 'Europe/Berlin';
function parts(date) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  return Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
}
const localDate = (d) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
function fmtWhen(iso) {
  if (!iso) return 'unbekannt';
  const d = new Date(iso), p = parts(d);
  const diff = Math.round((Date.parse(localDate(d)) - Date.parse(localDate(new Date()))) / 864e5);
  const day = { 0: 'heute', 1: 'morgen', 2: 'übermorgen' }[diff]
    ?? `${WD[(new Date(localDate(d)).getUTCDay() + 6) % 7]} ${p.day}.${p.month}.`;
  return `${day} ${p.hour}:${p.minute}`;
}
function fmtDays(mask) {
  if (mask === 127) return 'täglich';
  if (mask === 31) return 'Mo–Fr';
  if (mask === 96) return 'Sa–So';
  return WD.filter((_, i) => mask & (1 << i)).join(', ');
}
function depText(dep) {
  if (!dep) return 'keine Ausfahrt bekannt';
  const lbl = dep.label ? ` · ${dep.label}` : '';
  return `${fmtWhen(dep.at)}${lbl}`;
}
function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function tomorrowAt(h, m = 0) { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, m, 0, 0); return d; }

// ── Zustand ─────────────────────────────────────────────────────────
const spotById = (id) => S.spots.find((s) => s.id === id);
const spotByCode = (code) => S.spots.find((s) => s.code === code);
const myCars = () => S.me?.cars ?? [];
const myCarIds = () => new Set(myCars().map((c) => c.id));
const myUnparkedCar = () => myCars().find((c) => !c.spot_id);
// Wegenetz: [von, nach] – nach = null heißt „direkt hinaus“
const movesFrom = (id) => S.exits.filter(([f]) => f === id).map(([, t]) => t);
const movesInto = (id) => S.exits.filter(([, t]) => t === id).map(([f]) => f);
const aheadOf = (id) => movesFrom(id).filter((t) => t !== null);

/** Wie server/rules.py: über freie Plätze nach draußen? Sonst: erste Hindernisse. */
function explore(start, obstacles) {
  const seen = new Set([start]), stack = [start], frontier = new Set();
  let out = false;
  while (stack.length) {
    for (const t of movesFrom(stack.pop())) {
      if (t === null) out = true;
      else if (obstacles.has(t)) frontier.add(t);
      else if (!seen.has(t)) { seen.add(t); stack.push(t); }
    }
  }
  return out ? new Set() : frontier;
}

/** Steht das Auto auf spotId gerade (jetzt, ohne Zeitbezug) fest? */
function blockedNow(spotId) {
  const occupied = new Set(S.spots.filter((s) => s.occupant && s.id !== spotId).map((s) => s.id));
  return explore(spotId, occupied).size > 0;
}
const myRequest = (carId) => (S.leave_requests ?? []).find((r) => r.role === 'requester' && r.requester_car_id === carId);

const patioIds = () => new Set(S.spots.filter((s) => s.kind === 'patio').map((s) => s.id));

/** Notweg wie server/rules.py: rückwärts über freie Plätze aufs Patio, dann normal hinaus. */
function patioRoute(start, obstacles) {
  const patios = patioIds();
  if (patios.has(start) || explore(start, obstacles).size === 0) return null;
  const back = new Map([[start, null]]), queue = [start], reached = [];
  while (queue.length) {
    const s = queue.shift();
    for (const y of movesInto(s)) {
      if (obstacles.has(y) || back.has(y)) continue;
      back.set(y, s); queue.push(y);
      if (patios.has(y)) reached.push(y);
    }
  }
  const chain = (parent, end) => { const out = []; for (let x = end; x != null; x = parent.get(x)) out.push(x); return out.reverse(); };
  for (const p of reached) {
    const fwd = new Map([[p, null]]), q = [p];
    while (q.length) {
      const s = q.shift();
      for (const t of movesFrom(s)) {
        if (t === null) return { reverse: chain(back, p).slice(1), forward: chain(fwd, s).slice(1) };
        if (obstacles.has(t) || fwd.has(t)) continue;
        fwd.set(t, s); q.push(t);
      }
    }
  }
  return null;
}
/** {reverse: [Codes], forward: [Codes]} → „rückwärts auf P1, dann über P2 → L7 hinaus“ */
function fmtRoute(r) {
  if (!r) return '';
  const b = r.reverse;
  const head = b.length > 1 ? `rückwärts über ${b.slice(0, -1).join(' → ')} auf ${b[b.length - 1]}` : `rückwärts auf ${b[0]}`;
  return head + (r.forward.length ? `, dann über ${r.forward.join(' → ')} hinaus` : ', dann hinaus');
}

/** Wie server/conflicts.py: occ = Map(spotId → {carId, dep: ms|null}) → [{blocker, blocked}] */
function findBlockings(occ) {
  const now = Date.now(), horizon = (S.horizon_hours ?? 36) * 3600e3, res = [];
  for (const [bSpot, b] of occ) {
    if (b.dep === null || b.dep - now > horizon) continue;
    const still = new Set([...occ].filter(([s, a]) => s !== bSpot && (a.dep === null || a.dep > b.dep)).map(([s]) => s));
    for (const a of explore(bSpot, still)) res.push({ blocker: a, blocked: bSpot });
  }
  return res;
}

async function refresh() {
  const st = await api('GET', '/api/state');
  apply(st);
}

function apply(st) {
  const prev = S;
  S = st;
  if (!prev) renderDeco();
  renderBays();
  renderCars(prev);
  renderLinks();
  renderStatus();
  renderConflicts();
  renderAvatar();
  document.body.classList.toggle('can-park', !!myUnparkedCar());
  if (!prev) {
    handleHash();
    if (!S.me) setTimeout(openOnboarding, 1100);
  }
}

// Billiges Polling: nur Versionsnummer, voller Abruf bei Änderung
setInterval(async () => {
  if (document.hidden || !S) return;
  try { const { version } = await api('GET', '/api/version'); if (version !== S.version) refresh(); } catch { /* offline */ }
}, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S) refresh().catch(() => {}); });
window.addEventListener('hashchange', handleHash);

// ── Parkplatz: Dekoration ───────────────────────────────────────────
function g(el, x, y, w, h) {
  el.classList.add('g');
  el.style.cssText += `--x:${x};--y:${y};--w:${w};--h:${h}`;
  return el;
}
function div(cls, html = '') { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; }

function renderDeco() {
  const lot = $('#lot');
  lot.style.setProperty('--gw', S.lot.grid_w);
  lot.style.setProperty('--gh', S.lot.grid_h);
  const deco = $('#lotDeco');
  deco.innerHTML = '';
  const zones = [...S.zones].sort((a, b) => a.grid_x - b.grid_x);

  zones.forEach((z) => {
    const spots = S.spots.filter((s) => s.zone_id === z.id);
    const patio = spots.filter((s) => s.kind === 'patio');
    if (patio.length) {
      const top = Math.min(...patio.map((s) => s.grid_y)) - 1.5;
      const p = g(div('patio'), z.grid_x, top, z.grid_w, z.grid_y + z.grid_h - top);
      p.append(div('patio-label', 'Patio'));
      deco.append(p);
    }
    deco.append(g(div('gate', `<span class="gate-label">${esc(z.name)}</span>`), z.grid_x, 0, z.grid_w, 1.8));

    // Fahrspur-Pfeile in freien Flächen oberhalb der Stellplätze
    const placed = [];
    const overlaps = (a, b) => a.x < b.grid_x + b.grid_w && b.grid_x < a.x + a.w && a.y < b.grid_y + b.grid_h && b.grid_y < a.y + a.h;
    const regular = spots.filter((s) => s.kind === 'regular');
    const ys = [...new Set(regular.map((s) => s.grid_y))].sort((a, b) => a - b);
    const w = 4, h = 6;
    for (const y of ys) {
      for (const dx of [Math.round((z.grid_w - w) / 2), 1, z.grid_w - w - 1]) {
        const c = { x: z.grid_x + dx, y, w, h, grid_x: z.grid_x + dx, grid_y: y, grid_w: w, grid_h: h };
        if (regular.some((s) => overlaps(c, s)) || placed.some((p) => overlaps(c, p))) continue;
        placed.push(c);
      }
    }
    placed.forEach((c, i) => {
      const a = g(div('arrow', '<svg viewBox="0 0 24 40"><path d="M12 2v30M4 24l8 10 8-10" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'), c.x, c.y, c.w, c.h);
      a.querySelector('svg').style.animationDelay = `${i * 0.35}s`;
      deco.append(a);
    });
  });

  // Mittelstreifen zwischen den Bereichen
  for (let i = 0; i < zones.length - 1; i++) {
    const a = zones[i], b = zones[i + 1];
    const gap = b.grid_x - (a.grid_x + a.grid_w);
    // Die Trennwand endet vor dem Patio – dort ist ein Wechsel zwischen den Seiten möglich
    const patioTop = Math.min(S.lot.grid_h, ...S.spots.filter((s) => s.kind === 'patio').map((s) => s.grid_y - 1.5));
    deco.append(g(div('median'), a.grid_x + a.grid_w + gap * 0.3, 0, gap * 0.4, patioTop));
    if (patioTop < S.lot.grid_h) deco.append(g(div('patio passage'), a.grid_x + a.grid_w, patioTop, gap, S.lot.grid_h - patioTop));
  }
}

// ── Parkplatz: Stellplätze ──────────────────────────────────────────
function renderBays() {
  const host = $('#bays');
  const mine = myCarIds();
  const conflictSpots = new Set(S.conflicts.filter((c) => c.status === 'open').flatMap((c) => [c.blocker_spot, c.blocked_spot]));
  const waitSpots = new Set((S.leave_requests ?? []).map((r) => r.requester_spot));
  const moveSpots = new Set((S.leave_requests ?? []).flatMap((r) => r.blockers.map((b) => b.spot)));
  const sel = selectedSpot ? spotById(selectedSpot) : null;
  const relBlocks = new Set(sel ? movesInto(sel.id) : []);
  const relBlockedBy = new Set(sel ? aheadOf(sel.id) : []);

  [...S.spots].sort((a, b) => a.grid_y - b.grid_y || a.grid_x - b.grid_x).forEach((s, i) => {
    let el = host.querySelector(`[data-spot="${s.id}"]`);
    if (!el) {
      el = g(document.createElement('button'), s.grid_x, s.grid_y, s.grid_w, s.grid_h);
      el.classList.add('bay');
      if (s.kind === 'patio') el.classList.add('patio-bay');
      el.dataset.spot = s.id;
      el.style.setProperty('--i', i);
      el.innerHTML = `<span class="code">${esc(s.code)}</span>`;
      el.addEventListener('click', () => openSpot(s.id));
      host.append(el);
    }
    const o = s.occupant;
    el.classList.toggle('occupied', !!o);
    el.classList.toggle('mine', !!o && mine.has(o.car_id));
    el.classList.toggle('selected', selectedSpot === s.id);
    el.classList.toggle('rel-blocks', relBlocks.has(s.id));
    el.classList.toggle('rel-blocked-by', relBlockedBy.has(s.id));
    el.classList.toggle('conflict-bay', conflictSpots.has(s.code));
    el.classList.toggle('wait-bay', waitSpots.has(s.code));
    el.classList.toggle('move-bay', moveSpots.has(s.code));
    el.setAttribute('aria-label', o
      ? `Platz ${s.code}, belegt${o.resident_name ? ` von ${o.resident_name}` : ''}`
      : `Platz ${s.code}, frei`);
  });
}

// ── Parkplatz: Autos (mit Animationen) ──────────────────────────────
function renderCars(prev) {
  const host = $('#cars');
  const lotRect = $('#lot').getBoundingClientRect();
  const mine = myCarIds();
  const now = new Map(S.spots.filter((s) => s.occupant).map((s) => [s.occupant.car_id, s]));
  const before = new Map(prev ? prev.spots.filter((s) => s.occupant).map((s) => [s.occupant.car_id, s]) : []);
  const firstLoad = !prev;

  // Weggefahren
  for (const el of $$('.car', host)) {
    const id = Number(el.dataset.car);
    if (now.has(id) || el.classList.contains('leaving')) continue;
    el.classList.add('leaving', 'driving');
    const r = el.getBoundingClientRect();
    const dist = r.bottom - lotRect.top + 20;
    el.animate(
      [{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(6px)', offset: 0.15 }, { transform: `translateY(${-dist}px)`, opacity: 0 }],
      { duration: 900 + dist * 1.2, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' },
    ).finished.then(() => el.remove());
  }

  let n = 0;
  for (const [carId, spot] of now) {
    const o = spot.occupant;
    let el = host.querySelector(`.car[data-car="${carId}"]:not(.leaving)`);
    const isNew = !el;
    let oldRect = null;
    if (isNew) {
      el = g(div('car'), spot.grid_x, spot.grid_y, spot.grid_w, spot.grid_h);
      el.dataset.car = carId;
      el.append($('#carSvg').content.cloneNode(true));
      el.append(div('beam'), div('tag'));
      host.append(el);
    } else if (before.get(carId)?.id !== spot.id) {
      oldRect = el.getBoundingClientRect();
      el.style.setProperty('--x', spot.grid_x);
      el.style.setProperty('--y', spot.grid_y);
    }
    el.style.setProperty('--car', o.color);
    el.classList.toggle('mine', mine.has(carId));
    el.querySelector('.tag').textContent = o.resident_name ? o.resident_name.split(' ')[0] : '';

    if (isNew) {
      const r = el.getBoundingClientRect();
      const dist = r.bottom - lotRect.top + 10;
      const delay = firstLoad ? 700 + n++ * 140 : 0;
      el.classList.add('reversing'); // rückwärts einparken
      el.animate(
        [
          { transform: `translateY(${-dist}px)`, opacity: 0 },
          { opacity: 1, offset: 0.15 },
          { transform: 'translateY(5px)', offset: 0.82 },
          { transform: 'translateY(-1px)', offset: 0.92 },
          { transform: 'translateY(0)', opacity: 1 },
        ],
        { duration: 1000 + dist * 0.9, delay, easing: 'cubic-bezier(.2,.65,.25,1)', fill: 'backwards' },
      ).finished.then(() => setTimeout(() => el.classList.remove('reversing'), 400));
    } else if (oldRect) {
      const r = el.getBoundingClientRect();
      el.classList.add('driving');
      el.animate(
        [{ transform: `translate(${oldRect.left - r.left}px, ${oldRect.top - r.top}px)` }, { transform: 'translate(0,0)' }],
        { duration: 1400, easing: 'cubic-bezier(.45,0,.2,1)' },
      ).finished.then(() => el.classList.remove('driving'));
    }
  }
}

// ── Konfliktlinien ──────────────────────────────────────────────────
function renderLinks() {
  const svg = $('#links');
  const pct = (s) => [((s.grid_x + s.grid_w / 2) / S.lot.grid_w) * 100, ((s.grid_y + s.grid_h / 2) / S.lot.grid_h) * 100];
  svg.innerHTML = S.conflicts.filter((c) => c.status === 'open').map((c) => {
    const a = spotByCode(c.blocker_spot), b = spotByCode(c.blocked_spot);
    if (!a || !b) return '';
    const [x1, y1] = pct(a), [x2, y2] = pct(b);
    return `<line x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%"/><circle cx="${x2}%" cy="${y2}%" r="5"/>`;
  }).join('') + (S.leave_requests ?? []).flatMap((r) => r.blockers.map((b) => {
    const a = spotByCode(b.spot), w = spotByCode(r.requester_spot);
    if (!a || !w) return '';
    const [x1, y1] = pct(a), [x2, y2] = pct(w);
    return `<line class="req" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%"/><circle class="req" cx="${x2}%" cy="${y2}%" r="5"/>`;
  })).join('');
}

// ── Kopf, Status, Konflikte ─────────────────────────────────────────
function renderAvatar() {
  const btn = $('#profileBtn');
  btn.textContent = S.me ? S.me.display_name.trim()[0].toUpperCase() : '?';
  btn.style.setProperty('--avatar', myCars()[0]?.color || 'var(--line)');
  btn.onclick = () => (S.me ? openProfile() : openOnboarding());
}

function renderStatus() {
  const el = $('#status');
  if (!S.me) {
    el.innerHTML = `<div class="st-row"><div class="grow"><b>Willkommen!</b><small>Melde dich an, um Plätze zu belegen und Konflikte zu sehen.</small></div>
      <button class="btn primary small" id="stGo">Loslegen</button></div>`;
    $('#stGo').onclick = openOnboarding;
    return;
  }
  const cars = myCars();
  if (!cars.length) {
    el.innerHTML = `<div class="st-row"><div class="grow"><b>Noch kein Auto</b><small>Leg dein Auto an, dann kannst du parken.</small></div>
      <button class="btn primary small" id="stCar">Auto anlegen</button></div>`;
    $('#stCar').onclick = () => openCarEditor();
    return;
  }
  el.innerHTML = cars.map((c) => {
    const spot = c.spot_id ? spotById(c.spot_id) : null;
    return `<div class="st-row"><div class="swatch" style="background:${esc(c.color)}"></div>
      <div class="grow">${spot
        ? `<b>${esc(c.nickname)} steht auf ${esc(spot.code)}</b><small>Nächste Ausfahrt: ${esc(depText(c.next_departure))}</small>`
        : `<b>${esc(c.nickname)} ist unterwegs</b><small>Zurück? Tippe auf einen freien Platz.</small>`}</div>
      ${spot ? `<button class="btn small" data-leave="${c.id}">Losgefahren</button>` : ''}</div>
      ${spot && blockedNow(spot.id) && !myRequest(c.id)
        ? `<button class="btn primary block" data-wantout="${c.id}">🚗 Ich will gleich rausfahren</button>` : ''}`;
  }).join('');
  $$('[data-leave]').forEach((b) => (b.onclick = () => leave(Number(b.dataset.leave))));
  $$('[data-wantout]').forEach((b) => (b.onclick = () => wantOut(Number(b.dataset.wantout))));
}

function renderConflicts() {
  const host = $('#conflicts');
  host.innerHTML = (S.leave_requests ?? []).map(requestCard).join('') + S.conflicts.map(conflictCard).join('');
  $$('[data-respond]', host).forEach((b) => (b.onclick = () => act(
    () => api('POST', `/api/leave-requests/${b.dataset.rid}/respond`, { parking_id: Number(b.dataset.pid), response: b.dataset.respond }),
    b.dataset.respond === 'coming' ? 'Danke! Bescheid gegeben 👍' : 'Bescheid gegeben')));
  $$('[data-ping]', host).forEach((b) => (b.onclick = () => act(
    () => api('POST', `/api/leave-requests/${b.dataset.ping}/ping`), 'Nochmal geklingelt 🔔')));
  $$('[data-cancelreq]', host).forEach((b) => (b.onclick = () => act(
    () => api('POST', `/api/leave-requests/${b.dataset.cancelreq}/cancel`), 'Anfrage beendet')));
  $$('[data-choice]', host).forEach((b) => (b.onclick = async () => {
    const r = await act(() => api('POST', `/api/conflicts/${b.dataset.id}/choice`, { choice: b.dataset.choice }));
    toast(b.dataset.choice === 'patio_yes' ? 'Alles klar – gute Fahrt übers Patio'
      : r.status === 'swap_agreed' ? 'Tausch vereinbart 🤝' : b.dataset.choice === 'swap' ? 'Tausch-Wunsch gesendet' : 'Gespeichert');
  }));
  $$('[data-swap]', host).forEach((b) => (b.onclick = () => act(
    () => api('POST', `/api/conflicts/${b.dataset.swap}/swap`), 'Plätze getauscht 🎉')));
}

async function wantOut(carId, { skipPatio = false } = {}) {
  const car = myCars().find((c) => c.id === carId);
  if (car?.patio_now && !skipPatio) return askPatioNow(car);
  const r = await act(() => api('POST', `/api/cars/${carId}/leave-request`));
  const req = S.leave_requests.find((x) => x.id === r.id);
  const others = req ? req.blockers.filter((b) => b.resident_id !== S.me.id) : [];
  toast(others.length ? `${others.map((b) => b.name).join(', ')} ${others.length > 1 ? 'wurden' : 'wurde'} benachrichtigt` : 'Anfrage gestartet');
}

function askPatioNow(car) {
  const body = openSheet(`
    <h2>Notlösung übers Patio?</h2>
    <p class="sub">Gerade steht dir jemand im Weg. Ohne einen Nachbarn zu stören, kämst du so raus:</p>
    <div class="callout info">${esc(fmtRoute(car.patio_now))}</div>
    <p class="hint">Das Patio ist schmal und braucht etwas Rangieren. Nimm den Weg nur, wenn dein Auto passt und du das magst.</p>
    <div class="actions">
      <button class="btn primary block" id="pnYes">Ja, ich fahre übers Patio</button>
      <button class="btn block" id="pnNo">Nein, Nachbarn fragen</button>
      <button class="btn ghost block" id="pnNever">Kommt für mein Auto nie in Frage</button>
    </div>`);
  $('#pnYes', body).onclick = () => { closeSheet(); toast('Gute Fahrt übers Patio! Tippe danach auf „Losgefahren“.'); };
  $('#pnNo', body).onclick = () => { closeSheet(); wantOut(car.id, { skipPatio: true }); };
  $('#pnNever', body).onclick = async () => {
    await act(() => api('PATCH', `/api/cars/${car.id}`, { patio_route: 'never' }), 'Gemerkt: kein Patio-Notweg');
    closeSheet(); wantOut(car.id, { skipPatio: true });
  };
}

function minutesSince(iso) { return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); }

function requestCard(r) {
  const p = parts(new Date(r.next_ping_at));
  if (r.role === 'requester') {
    const rows = r.blockers.map((b) => {
      const own = b.resident_id === S.me.id;
      const state = own ? 'dein eigenes Auto'
        : b.response === 'coming' ? '✓ kommt sofort'
        : b.response === 'later' ? `⏱ in ~${b.eta_minutes} Min.`
        : '… noch keine Antwort';
      return `<div class="item"><div class="grow"><b>${esc(b.spot)} · ${own ? esc(b.car) : esc(b.name)}</b><small>${state}</small></div></div>`;
    }).join('');
    const layers = new Set(r.blockers.map((b) => b.layer)).size;
    const orHint = r.blockers.some((b, i, a) => a.findIndex((x) => x.layer === b.layer) !== i)
      ? '<p class="hint">Bei mehreren Wegen reicht es, wenn einer davon Platz macht.</p>' : '';
    return `<article class="conflict request" id="raus-${r.id}"><h3>Du willst raus – Anfrage läuft</h3>
      <div class="meta">${esc(r.requester_car)} auf ${esc(r.requester_spot)} · seit ${minutesSince(r.created_at)} Min.${layers > 1 ? ' · mehrere müssen nacheinander weg' : ''}</div>
      <div class="list">${rows}</div>${orHint}
      <div class="row"><button class="btn small" data-ping="${r.id}">🔔 Nochmal klingeln</button>
        <button class="btn small ghost" data-cancelreq="${r.id}">Hat sich erledigt</button></div>
      <p class="hint" style="margin:8px 0 0">Nachklingeln ab ${p.hour}:${p.minute} möglich. Ist der Weg frei, bekommst du Bescheid.</p></article>`;
  }
  const mine = r.blockers.filter((b) => b.resident_id === S.me.id);
  return mine.map((b) => {
    const alt = r.blockers.filter((o) => o.layer === b.layer && o.parking_id !== b.parking_id);
    const answered = b.response === 'coming' ? 'Du hast geantwortet: kommst sofort.'
      : b.response === 'later' ? `Du hast geantwortet: in ~${b.eta_minutes} Min.` : '';
    return `<article class="conflict request urgent" id="raus-${r.id}"><h3>🚗 ${esc(r.requester_name)} will gleich rausfahren</h3>
      <p>Dein ${esc(b.car)} auf <b>${esc(b.spot)}</b> steht im Weg (${esc(r.requester_spot)}). Bitte kurz umparken.</p>
      ${alt.length ? `<div class="meta">Alternativ könnte auch ${alt.map((o) => `${esc(o.name)} (${esc(o.spot)})`).join(' oder ')} Platz machen.</div>` : ''}
      ${answered ? `<div class="callout good">${answered}</div>` : ''}
      <div class="row">${b.response !== 'coming' ? `<button class="btn small primary" data-respond="coming" data-rid="${r.id}" data-pid="${b.parking_id}">Komme sofort</button>` : ''}
        ${b.response !== 'later' ? `<button class="btn small" data-respond="later" data-rid="${r.id}" data-pid="${b.parking_id}">Dauert ~15 Min.</button>` : ''}</div></article>`;
  }).join('');
}

function conflictCard(c) {
  const me = c.role, other = me === 'blocker' ? 'blocked' : 'blocker';
  const myChoice = c[`${me}_choice`], theirChoice = c[`${other}_choice`];
  const otherName = esc(c[`${other}_name`]);
  const bWhen = esc(fmtWhen(c.blocked_departs_at));
  const aWhen = c.blocker_departs_at ? esc(fmtWhen(c.blocker_departs_at)) : 'zu unbekannter Zeit';
  const btn = (choice, label, cls = '') => `<button class="btn small ${cls}" data-id="${c.id}" data-choice="${choice}">${label}</button>`;
  const meta = `<div class="meta">${esc(c.blocker_spot)} steht vor ${esc(c.blocked_spot)}</div>`;
  const self = c.blocker_resident_id === c.blocked_resident_id;

  if (self) {
    return `<article class="conflict" id="konflikt-${c.id}"><h3>Du stehst dir selbst im Weg</h3>
      <p>${esc(c.blocked_car)} (${esc(c.blocked_spot)}) muss ${bWhen} raus, ${esc(c.blocker_car)} (${esc(c.blocker_spot)}) steht davor.</p>
      <div class="row"><button class="btn small good" data-swap="${c.id}">Umgeparkt ✓</button></div></article>`;
  }
  if (c.status === 'patio') {
    return me === 'blocked'
      ? `<article class="conflict ok" id="konflikt-${c.id}"><h3>Du fährst übers Patio raus</h3>
          <p>Zugesagt: ${esc(c.patio_text)}. Parkt bis ${bWhen} jemand auf diesem Weg, sagt dir die App Bescheid.</p>
          <div class="row">${btn('patio_no', 'Doch nicht', 'ghost')}</div></article>`
      : `<article class="conflict ok" id="konflikt-${c.id}"><h3>${otherName} weicht übers Patio aus</h3>
          <p>Du musst nichts tun. Wird der Patio-Weg zugeparkt, meldet sich die App wieder.</p>${meta}</article>`;
  }
  if (c.patio_route && !c.patio_choice && me === 'blocked' && !myChoice && !theirChoice) {
    return `<article class="conflict" id="konflikt-${c.id}"><h3>${otherName} steht vor dir</h3>
      <p>Du musst <b>${bWhen}</b> raus, ${otherName} fährt erst ${aWhen}.</p>${meta}
      <div class="callout info"><b>Notlösung ohne ${otherName}:</b> ${esc(c.patio_text)}. Das Patio ist schmal und braucht etwas Rangieren. Der Weg ist jetzt frei; parkt bis dahin jemand darauf, sagt dir die App Bescheid.</div>
      <p><b>Kommt das für dich in Frage?</b></p>
      <div class="row">${btn('patio_yes', 'Ja, ich fahre übers Patio', 'primary')}${btn('patio_no', 'Nein, kommt nicht in Frage')}</div></article>`;
  }
  const patioHint = c.patio_route && !c.patio_choice && me === 'blocker'
    ? `<div class="callout info">${otherName} wird gerade gefragt, ob der Patio-Notweg in Frage kommt. Du kannst trotzdem schon einen Tausch anbieten.</div>` : '';
  if (c.status === 'swap_agreed') {
    return `<article class="conflict ok" id="konflikt-${c.id}"><h3>Tausch vereinbart mit ${otherName}</h3>
      <p>${esc(c.blocker_spot)} ↔ ${esc(c.blocked_spot)}: Parkt heute noch um und tippt dann hier.</p>
      <div class="row"><button class="btn small good" data-swap="${c.id}">Getauscht ✓</button></div></article>`;
  }
  if (c.status === 'acknowledged') {
    return me === 'blocker'
      ? `<article class="conflict ok" id="konflikt-${c.id}"><h3>Du lässt ${otherName} raus</h3>
          <p>Zugesagt: Du fährst ${bWhen} rechtzeitig zur Seite. Du bekommst vorher eine Erinnerung.</p>
          <div class="row">${btn('swap', 'Doch lieber heute tauschen', 'ghost')}</div></article>`
      : `<article class="conflict ok" id="konflikt-${c.id}"><h3>${otherName} lässt dich raus</h3>
          <p>${otherName} fährt ${bWhen} rechtzeitig zur Seite.</p>${meta}
          <div class="row">${btn('swap', 'Lieber heute tauschen', 'ghost')}</div></article>`;
  }
  // offen
  if (theirChoice === 'swap' && !myChoice) {
    return `<article class="conflict" id="konflikt-${c.id}"><h3>${otherName} möchte heute Abend tauschen</h3>
      <p>${me === 'blocker' ? `${otherName} muss ${bWhen} raus, du fährst erst ${aWhen}.` : `Du musst ${bWhen} raus, ${otherName} fährt erst ${aWhen}.`}</p>${meta}
      <div class="row">${btn('swap', 'Einverstanden', 'good')}${me === 'blocker' ? btn('manual', 'Nein, ich fahre zur Seite') : btn('manual', 'Nein danke')}</div></article>`;
  }
  if (myChoice === 'swap') {
    return `<article class="conflict" id="konflikt-${c.id}"><h3>Warte auf ${otherName}</h3>
      <p>Du hast einen Tausch vorgeschlagen (${esc(c.blocker_spot)} ↔ ${esc(c.blocked_spot)}). ${otherName} wurde benachrichtigt.</p>
      ${me === 'blocker' ? `<div class="row">${btn('manual', 'Doch nicht – ich fahre zur Seite', 'ghost')}</div>` : ''}</article>`;
  }
  return me === 'blocker'
    ? `<article class="conflict" id="konflikt-${c.id}"><h3>Du blockierst ${otherName}</h3>
        <p>${otherName} muss <b>${bWhen}</b> raus, du fährst erst ${aWhen}.</p>${meta}${patioHint}
        <div class="row">${btn('swap', 'Heute Abend tauschen', 'primary')}${btn('manual', `Ich fahre ${bWhen.split(' ')[1] ?? ''} zur Seite`)}</div></article>`
    : `<article class="conflict" id="konflikt-${c.id}"><h3>${otherName} steht vor dir</h3>
        <p>Du musst <b>${bWhen}</b> raus, ${otherName} fährt erst ${aWhen}.</p>${meta}
        <div class="row">${btn('swap', 'Tausch vorschlagen', 'primary')}${myChoice ? '' : btn('manual', 'Wir klären das morgens')}</div></article>`;
}

function handleHash() {
  const h = location.hash.slice(1);
  if (h.startsWith('login=')) {
    token = decodeURIComponent(h.slice(6));
    store.set('park.token', token);
    history.replaceState(null, '', '/');
    refresh().then(() => toast(`Angemeldet als ${S.me?.display_name ?? '…'}`));
  } else if (h.startsWith('konflikt-') || h.startsWith('raus-')) {
    const el = document.getElementById(h);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); }
  }
}

// ── Sheet & Toast ───────────────────────────────────────────────────
function openSheet(html) {
  const sheet = $('#sheet'), bd = $('#backdrop');
  $('#sheetBody').innerHTML = html;
  sheet.classList.remove('closing'); bd.classList.remove('closing');
  sheet.hidden = false; bd.hidden = false;
  sheet.scrollTop = 0;
  return $('#sheetBody');
}
function closeSheet() {
  const sheet = $('#sheet'), bd = $('#backdrop');
  if (sheet.hidden) return;
  sheet.classList.add('closing'); bd.classList.add('closing');
  setTimeout(() => { sheet.hidden = true; bd.hidden = true; }, 200);
  if (selectedSpot) { selectedSpot = null; renderBays(); }
}
$('#backdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

let toastTimer;
function toast(msg, error = false) {
  const t = $('#toast');
  t.hidden = true; void t.offsetWidth;
  t.textContent = msg; t.className = `toast${error ? ' error' : ''}`; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2700);
}

// ── Stellplatz antippen ─────────────────────────────────────────────
function openSpot(spotId) {
  const spot = spotById(spotId);
  selectedSpot = spotId;
  renderBays();
  if (!S.me) return openOnboarding();
  const o = spot.occupant;
  if (!o) return myCars().length ? openPark(spot) : openCarEditor();
  if (myCarIds().has(o.car_id)) return openMyCar(spot);
  return openOther(spot);
}

function wayText(spot) {
  const codes = aheadOf(spot.id).map((id) => spotById(id).code);
  if (movesFrom(spot.id).includes(null)) return codes.length ? `direkt oder über ${codes.join(' / ')}` : 'direkt';
  return `über ${codes.join(' oder ')}`;
}

function relationsHtml(spot) {
  const line = (id) => {
    const s = spotById(id), o = s.occupant;
    return `<div class="item"><div class="car-pill" style="--c:${o ? esc(o.color) : 'transparent'};box-shadow:inset 0 0 0 1.5px var(--line)"></div>
      <div class="grow"><b>${esc(s.code)}${o ? ` · ${esc(o.resident_name)}` : ' · frei'}</b>${o ? `<small>fährt ${esc(depText(o.next_departure))}</small>` : ''}</div></div>`;
  };
  const ahead = aheadOf(spot.id);
  const behind = movesInto(spot.id);
  return `<dl class="kv"><dt>Ausfahrt</dt><dd>${esc(wayText(spot))}</dd></dl>`
    + (ahead.length ? `<h3>${ahead.length > 1 ? 'Ausfahrt über (einer muss frei sein)' : 'Ausfahrt über'}</h3><div class="list">${ahead.map(line).join('')}</div>` : '')
    + (behind.length ? `<h3>Fährt über diesen Platz raus</h3><div class="list">${behind.map(line).join('')}</div>` : '');
}

/** Welche Konflikte entstünden, wenn `car` mit Ausfahrt `depIso` auf `spot` parkt? */
function impact(spot, depIso, car) {
  const occ = new Map();
  for (const s of S.spots) {
    const o = s.occupant;
    if (!o || o.car_id === car.id) continue;
    occ.set(s.id, { carId: o.car_id, dep: o.next_departure ? Date.parse(o.next_departure.at) : null, o });
  }
  occ.set(spot.id, { carId: car.id, dep: depIso ? Date.parse(depIso) : null });
  const mine = myCarIds();
  const res = findBlockings(occ);
  const occupiedAll = new Set(occ.keys());
  const iBlock = res.filter((r) => r.blocker === spot.id && !mine.has(occ.get(r.blocked).carId))
    .map((r) => {
      const o = occ.get(r.blocked).o;
      const others = new Set(occupiedAll); others.delete(r.blocked);
      return { spot: spotById(r.blocked), o, patio: o.patio_route !== 'never' && !!patioRoute(r.blocked, others) };
    });
  const blockMe = res.filter((r) => r.blocked === spot.id && !mine.has(occ.get(r.blocker).carId))
    .map((r) => ({ spot: spotById(r.blocker), o: occ.get(r.blocker).o }));
  const reserved = (S.patio_reservations ?? []).filter((r) => r.spots.includes(spot.code) && r.resident_id !== S.me?.id);
  return { iBlock, blockMe, reserved, count: iBlock.length + blockMe.length + reserved.length };
}

function openPark(spot) {
  const cars = myCars();
  let car = cars.find((c) => !c.spot_id) || cars[0];
  let mode = car.next_departure ? 'auto' : 'custom';

  const body = openSheet(`
    <h2>Auf ${esc(spot.code)} parken</h2>
    <p class="sub">${spot.kind === 'patio' ? 'Patio-Platz' : esc(S.zones.find((z) => z.id === spot.zone_id)?.name)} · Ausfahrt ${esc(wayText(spot))}</p>
    ${cars.length > 1 ? `<h3>Welches Auto?</h3><div class="chips" id="pkCars">${cars.map((c) => `<button class="chip" data-car="${c.id}">${esc(c.nickname)}</button>`).join('')}</div>` : ''}
    <h3>Wann fährst du als Nächstes?</h3>
    <div class="chips" id="pkMode"></div>
    <div id="pkCustom" hidden>
      <label class="field">Datum & Uhrzeit<input type="datetime-local" id="pkAt"></label>
      <div class="chips">
        <button class="chip" data-quick="1h">in 1 Std.</button>
        <button class="chip" data-quick="t7">morgen 7:00</button>
        <button class="chip" data-quick="t9">morgen 9:00</button>
      </div>
    </div>
    <div id="pkImpact"></div>
    <div class="actions"><button class="btn primary block" id="pkGo">Hier geparkt</button></div>`);

  const at = $('#pkAt', body);
  at.value = toLocalInput(tomorrowAt(8));

  const depIso = () => (mode === 'auto' ? car.next_departure?.at : mode === 'custom' && at.value ? new Date(at.value).toISOString() : null);

  function update() {
    $$('#pkCars .chip', body).forEach((b) => b.setAttribute('aria-pressed', Number(b.dataset.car) === car.id));
    const modes = [];
    if (car.next_departure) modes.push(['auto', `${car.next_departure.source === 'planned' ? 'Wie geplant' : 'Wie üblich'} · ${fmtWhen(car.next_departure.at)}`]);
    modes.push(['custom', 'Andere Zeit'], ['unknown', 'Weiß ich noch nicht']);
    if (mode === 'auto' && !car.next_departure) mode = 'custom';
    $('#pkMode', body).innerHTML = modes.map(([m, l]) => `<button class="chip" data-mode="${m}" aria-pressed="${m === mode}">${esc(l)}</button>`).join('');
    $$('#pkMode .chip', body).forEach((b) => (b.onclick = () => { mode = b.dataset.mode; update(); }));
    $('#pkCustom', body).hidden = mode !== 'custom';
    $('#pkGo', body).textContent = car.spot_id && car.spot_id !== spot.id ? `Von ${spotById(car.spot_id).code} hierher umparken` : 'Hier geparkt';

    const im = impact(spot, depIso(), car);
    let html = '';
    if (im.iBlock.length) html += `<div class="callout warn">⚠️ Du würdest ${im.iBlock.map((x) => `<b>${esc(x.o.resident_name)}</b> (${esc(x.spot.code)}, fährt ${esc(fmtWhen(x.o.next_departure.at))}${x.patio ? ', käme nur noch über den Patio-Notweg raus' : ''})`).join(', ')} zuparken.</div>`;
    for (const r of im.reserved) html += `<div class="callout warn">⚠️ <b>${esc(r.name)}</b> will ${esc(fmtWhen(r.at))} über diesen Platz übers Patio raus (${esc(r.text)}). Wenn du hier parkst, ist dieser Notweg zu.</div>`;
    if (im.blockMe.length) {
      const who = im.blockMe.map((x) => `<b>${esc(x.o.resident_name)}</b> (${esc(x.spot.code)}, fährt ${esc(fmtWhen(x.o.next_departure?.at))})`);
      html += im.blockMe.length === 1
        ? `<div class="callout warn">⚠️ ${who[0]} steht vor dir.</div>`
        : `<div class="callout warn">⚠️ ${who.join(' und ')} stehen vor dir – einer davon müsste vorher weg.</div>`;
    }
    if (mode === 'unknown' && movesInto(spot.id).some((id) => spotById(id).occupant)) html += '<div class="callout info">Ohne Ausfahrzeit giltst du für Autos hinter dir als Blockierer.</div>';
    if (im.count) {
      const better = S.spots.filter((s) => !s.occupant && s.id !== spot.id).map((s) => ({ s, n: impact(s, depIso(), car).count })).filter((x) => x.n === 0).sort((a, b) => a.s.grid_y - b.s.grid_y)[0];
      if (better) html += `<div class="callout good">Tipp: Auf <b>${esc(better.s.code)}</b> gäbe es keinen Konflikt. <button class="btn small ghost" id="pkBetter" data-spot="${better.s.id}">Dorthin</button></div>`;
    } else if (depIso()) {
      html += '<div class="callout good">✓ Kein Konflikt mit deinen Nachbarn.</div>';
    }
    $('#pkImpact', body).innerHTML = html;
    const bb = $('#pkBetter', body);
    if (bb) bb.onclick = () => openSpot(Number(bb.dataset.spot));
  }

  $$('#pkCars .chip', body).forEach((b) => (b.onclick = () => { car = cars.find((c) => c.id === Number(b.dataset.car)); mode = car.next_departure ? 'auto' : 'custom'; update(); }));
  $$('[data-quick]', body).forEach((b) => (b.onclick = () => {
    const q = b.dataset.quick;
    at.value = toLocalInput(q === '1h' ? new Date(Date.now() + 3600e3) : tomorrowAt(q === 't7' ? 7 : 9));
    update();
  }));
  at.addEventListener('input', update);
  $('#pkGo', body).onclick = async () => {
    const payload = { car_id: car.id, spot_id: spot.id };
    if (mode === 'custom') {
      if (!at.value) return toast('Bitte eine Uhrzeit wählen', true);
      payload.depart_at = new Date(at.value).toISOString();
    }
    await act(() => api('POST', '/api/park', payload), `${car.nickname} steht auf ${spot.code}`);
    closeSheet();
  };
  update();
}

function openMyCar(spot) {
  const o = spot.occupant;
  const car = myCars().find((c) => c.id === o.car_id);
  const dep = car.next_departure;
  const rec = dep?.source === 'recurring' ? car.recurring.find((r) => r.label === dep.label) || car.recurring[0] : null;
  const planned = dep?.source === 'planned' ? car.planned[0] : null;

  const body = openSheet(`
    <h2>${esc(car.nickname)} · ${esc(spot.code)}</h2>
    <p class="sub">Geparkt ${esc(fmtWhen(o.parked_at))}</p>
    <dl class="kv"><dt>Nächste Ausfahrt</dt><dd><b>${esc(depText(dep))}</b>${dep ? ` <small>(${dep.source === 'planned' ? 'einmalig' : 'üblich'})</small>` : ''}</dd></dl>
    <div id="mcExtra" hidden>
      <label class="field">Andere Ausfahrt<input type="datetime-local" id="mcAt"></label>
      <button class="btn primary block" id="mcSave">Speichern</button>
    </div>
    ${relationsHtml(spot)}
    <div class="actions">
      ${blockedNow(spot.id) && !myRequest(car.id) ? '<button class="btn primary block" id="mcWantOut">🚗 Ich will gleich rausfahren</button>' : ''}
      <button class="btn ${blockedNow(spot.id) ? '' : 'primary'} block" id="mcLeave">Losgefahren</button>
      <button class="btn block" id="mcOther">Andere Ausfahrzeit eintragen</button>
      ${rec ? `<button class="btn ghost block" id="mcSkip">Übliche Fahrt ${esc(fmtWhen(dep.at).split(' ')[0])} fällt aus</button>` : ''}
      ${planned ? `<button class="btn ghost block" id="mcDelPlanned">Geplante Fahrt löschen</button>` : ''}
    </div>`);

  $('#mcAt', body).value = toLocalInput(tomorrowAt(9));
  $('#mcLeave', body).onclick = () => { closeSheet(); leave(car.id); };
  const wo = $('#mcWantOut', body); if (wo) wo.onclick = () => { closeSheet(); wantOut(car.id); };
  $('#mcOther', body).onclick = () => { $('#mcExtra', body).hidden = false; $('#mcOther', body).hidden = true; $('#mcAt', body).focus(); };
  $('#mcSave', body).onclick = async () => {
    await act(() => api('POST', `/api/cars/${car.id}/planned`, { depart_at: new Date($('#mcAt', body).value).toISOString() }), 'Ausfahrt gespeichert');
    closeSheet();
  };
  if (rec) $('#mcSkip', body).onclick = async () => {
    await act(() => api('POST', `/api/recurring/${rec.id}/skip`, { date: localDate(new Date(dep.at)) }), 'Übliche Fahrt ausgelassen');
    closeSheet();
  };
  if (planned) $('#mcDelPlanned', body).onclick = async () => {
    await act(() => api('DELETE', `/api/planned/${planned.id}`), 'Gelöscht');
    closeSheet();
  };
}

function openOther(spot) {
  const o = spot.occupant;
  openSheet(`
    <h2>${esc(spot.code)} · ${esc(o.resident_name)}</h2>
    <p class="sub">${esc(o.nickname)} · geparkt ${esc(fmtWhen(o.parked_at))}</p>
    <dl class="kv"><dt>Nächste Ausfahrt</dt><dd><b>${esc(depText(o.next_departure))}</b></dd></dl>
    ${relationsHtml(spot)}
    <div class="actions"><button class="btn block" id="otClose">Schließen</button></div>`);
  $('#otClose').onclick = closeSheet;
}

async function leave(carId) {
  await act(() => api('POST', '/api/leave', { car_id: carId }), 'Gute Fahrt! 👋');
}

// ── Profil ──────────────────────────────────────────────────────────
function openProfile() {
  const me = S.me;
  const pushOk = 'PushManager' in window && 'serviceWorker' in navigator;
  const body = openSheet(`
    <h2>Hallo ${esc(me.display_name)}</h2>
    <p class="sub">${me.unit ? esc(me.unit) : 'Dein Profil'}</p>
    <label class="field">Name<input type="text" id="pfName" value="${esc(me.display_name)}" maxlength="40"></label>
    <label class="field">Wohnung / Klingel<input type="text" id="pfUnit" value="${esc(me.unit ?? '')}" maxlength="30"></label>
    <button class="btn block" id="pfSave">Speichern</button>

    <h3>Deine Autos</h3>
    <div class="list">${myCars().map((c) => `
      <button class="item" style="border:0;text-align:left;cursor:pointer" data-car="${c.id}">
        <div class="car-pill" style="--c:${esc(c.color)}"></div>
        <div class="grow"><b>${esc(c.nickname)}</b>${c.plate ? ` <small style="display:inline">${esc(c.plate)}</small>` : ''}
          <small>${c.recurring.length ? c.recurring.map((r) => `${fmtDays(r.weekdays)} ${r.depart_time}`).join(' · ') : 'Keine übliche Ausfahrzeit'}</small></div>
        <span style="color:var(--muted)">›</span>
      </button>`).join('')}</div>
    <button class="btn ghost block" id="pfAddCar">+ Auto hinzufügen</button>

    <h3>Benachrichtigungen</h3>
    ${!S.push.public_key ? '<div class="callout info">Push ist auf dem Server nicht eingerichtet.</div>'
      : !pushOk ? '<div class="callout info">Dieser Browser kann keine Push-Nachrichten. Auf dem iPhone: Teilen → „Zum Home-Bildschirm“, dann die App von dort öffnen.</div>'
      : `<p class="hint">${me.push_subscriptions ? `Aktiv auf ${me.push_subscriptions} Gerät(en).` : 'Noch nicht aktiviert.'}</p>
         <div class="row"><button class="btn primary" id="pfPush">Auf diesem Gerät aktivieren</button>${me.push_subscriptions ? '<button class="btn" id="pfTest">Test senden</button>' : ''}</div>`}

    <h3>Weitere Geräte</h3>
    <p class="hint">Öffne diesen Link auf einem anderen Gerät, um dich dort anzumelden. Nicht weitergeben!</p>
    <button class="btn block" id="pfLink">Anmelde-Link kopieren</button>
    <div class="actions"><button class="btn danger block" id="pfLogout">Auf diesem Gerät abmelden</button></div>`);

  $('#pfSave', body).onclick = () => act(() => api('PATCH', '/api/me', { display_name: $('#pfName', body).value, unit: $('#pfUnit', body).value }), 'Gespeichert');
  $$('[data-car]', body).forEach((b) => (b.onclick = () => openCarEditor(myCars().find((c) => c.id === Number(b.dataset.car)))));
  $('#pfAddCar', body).onclick = () => openCarEditor();
  const pp = $('#pfPush', body); if (pp) pp.onclick = () => enablePush().then(() => openProfile());
  const pt = $('#pfTest', body); if (pt) pt.onclick = () => act(() => api('POST', '/api/push/test'), 'Test gesendet');
  $('#pfLink', body).onclick = async () => {
    const url = `${location.origin}/#login=${encodeURIComponent(token)}`;
    try { await navigator.clipboard.writeText(url); toast('Link kopiert'); } catch { prompt('Anmelde-Link:', url); }
  };
  $('#pfLogout', body).onclick = () => {
    if (!confirm('Abmelden? Ohne Anmelde-Link kommst du nicht mehr in dieses Profil.')) return;
    token = null; store.del('park.token'); closeSheet(); refresh();
  };
}

// ── Auto bearbeiten / anlegen ───────────────────────────────────────
function openCarEditor(car = null, { onDone } = {}) {
  let color = car?.color || COLORS[myCars().length % COLORS.length];
  let days = 31;
  const body = openSheet(`
    <h2>${car ? esc(car.nickname) : 'Neues Auto'}</h2>
    <p class="sub">${car ? 'Auto & Ausfahrzeiten' : 'So erkennen dich die Nachbarn auf dem Parkplatz.'}</p>
    <label class="field">Name des Autos<input type="text" id="ceName" placeholder="z. B. Roter Golf" value="${esc(car?.nickname ?? '')}" maxlength="30"></label>
    <label class="field">Kennzeichen (optional)<input type="text" id="cePlate" placeholder="HS-AB 123" value="${esc(car?.plate ?? '')}" maxlength="15"></label>
    <div class="field" style="margin-bottom:4px">Farbe</div>
    <div class="swatches" id="ceColors">${COLORS.map((c) => `<button style="--c:${c}" data-c="${c}" aria-label="Farbe ${c}"></button>`).join('')}</div>
    <button class="btn primary block" id="ceSave">${car ? 'Speichern' : 'Auto anlegen'}</button>
    ${car ? `
      <h3>Übliche Ausfahrzeiten</h3>
      <div class="list">${car.recurring.map((r) => `<div class="item"><div class="grow"><b>${fmtDays(r.weekdays)} · ${r.depart_time}</b>${r.label ? `<small>${esc(r.label)}</small>` : ''}
          ${r.skips.length ? `<small>Fällt aus: ${r.skips.map((d) => `${d.slice(8)}.${d.slice(5, 7)}. <a href="#" data-unskip="${r.id}|${d}" style="color:var(--accent-2)">rückgängig</a>`).join(', ')}</small>` : ''}</div>
          <button class="x" data-delrec="${r.id}" aria-label="Löschen">×</button></div>`).join('') || '<p class="hint">Noch keine – z. B. Mo–Fr 07:30 zur Arbeit.</p>'}</div>
      <div class="days" id="ceDays">${WD.map((d, i) => `<button class="chip" data-d="${i}">${d}</button>`).join('')}</div>
      <div class="row" style="flex-wrap:nowrap">
        <input type="time" id="ceTime" value="07:30" style="flex:1">
        <input type="text" id="ceLabel" placeholder="Anlass (Arbeit)" maxlength="30" style="flex:1.4">
      </div>
      <button class="btn block" id="ceAddRec" style="margin-top:8px">+ Übliche Zeit hinzufügen</button>

      <h3>Einmalige Ausfahrten</h3>
      <div class="list">${car.planned.map((p) => `<div class="item"><div class="grow"><b>${esc(fmtWhen(p.depart_at))}</b>${p.note ? `<small>${esc(p.note)}</small>` : ''}</div>
          <button class="x" data-delplan="${p.id}" aria-label="Löschen">×</button></div>`).join('') || '<p class="hint">Keine geplant.</p>'}</div>
      <div class="row" style="flex-wrap:nowrap">
        <input type="datetime-local" id="cePlanAt" style="flex:1.4">
        <input type="text" id="cePlanNote" placeholder="Notiz" maxlength="40" style="flex:1">
      </div>
      <button class="btn block" id="ceAddPlan" style="margin-top:8px">+ Einmalige Ausfahrt</button>

      <h3>Patio-Notweg</h3>
      <p class="hint">Rückwärts aufs schmale Patio rangieren und darüber rausfahren. Die App schlägt das nur als Notlösung vor und fragt dich jedes Mal vorher.</p>
      <div class="chips" id="cePatio">
        <button class="chip" data-p="ask" aria-pressed="${car.patio_route !== 'never'}">Bei Bedarf fragen</button>
        <button class="chip" data-p="never" aria-pressed="${car.patio_route === 'never'}">Kommt nie in Frage</button>
      </div>
      <div class="actions"><button class="btn danger block" id="ceDel">Auto entfernen</button></div>` : ''}`);

  const paint = () => {
    $$('#ceColors button', body).forEach((b) => b.setAttribute('aria-pressed', b.dataset.c === color));
    $$('#ceDays .chip', body).forEach((b) => b.setAttribute('aria-pressed', !!(days & (1 << b.dataset.d))));
  };
  $$('#ceColors button', body).forEach((b) => (b.onclick = () => { color = b.dataset.c; paint(); }));
  $$('#ceDays .chip', body).forEach((b) => (b.onclick = () => { days ^= 1 << b.dataset.d; paint(); }));
  paint();

  const reopen = () => openCarEditor(myCars().find((c) => c.id === car.id));
  $('#ceSave', body).onclick = async () => {
    const data = { nickname: $('#ceName', body).value, plate: $('#cePlate', body).value, color };
    if (car) { await act(() => api('PATCH', `/api/cars/${car.id}`, data), 'Gespeichert'); reopen(); return; }
    const r = await act(() => api('POST', '/api/cars', data), 'Auto angelegt');
    if (onDone) onDone(r.id); else openCarEditor(myCars().find((c) => c.id === r.id));
  };
  if (!car) return;
  $('#cePlanAt', body).value = toLocalInput(tomorrowAt(10));
  $('#ceAddRec', body).onclick = async () => {
    await act(() => api('POST', `/api/cars/${car.id}/recurring`, { weekdays: days, depart_time: $('#ceTime', body).value, label: $('#ceLabel', body).value }), 'Hinzugefügt');
    reopen();
  };
  $('#ceAddPlan', body).onclick = async () => {
    const v = $('#cePlanAt', body).value;
    if (!v) return toast('Bitte Datum wählen', true);
    await act(() => api('POST', `/api/cars/${car.id}/planned`, { depart_at: new Date(v).toISOString(), note: $('#cePlanNote', body).value }), 'Hinzugefügt');
    reopen();
  };
  $$('#cePatio .chip', body).forEach((b) => (b.onclick = async () => {
    await act(() => api('PATCH', `/api/cars/${car.id}`, { patio_route: b.dataset.p }), 'Gespeichert');
    reopen();
  }));
  $$('[data-delrec]', body).forEach((b) => (b.onclick = async () => { await act(() => api('DELETE', `/api/recurring/${b.dataset.delrec}`)); reopen(); }));
  $$('[data-delplan]', body).forEach((b) => (b.onclick = async () => { await act(() => api('DELETE', `/api/planned/${b.dataset.delplan}`)); reopen(); }));
  $$('[data-unskip]', body).forEach((a) => (a.onclick = async (e) => {
    e.preventDefault();
    const [rid, d] = a.dataset.unskip.split('|');
    await act(() => api('DELETE', `/api/recurring/${rid}/skip/${d}`)); reopen();
  }));
  $('#ceDel', body).onclick = async () => {
    if (!confirm(`${car.nickname} wirklich entfernen?`)) return;
    await act(() => api('DELETE', `/api/cars/${car.id}`), 'Entfernt');
    closeSheet();
  };
}

// ── Onboarding ──────────────────────────────────────────────────────
function steps(n) { return `<div class="steps">${[1, 2, 3, 4].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>`; }

function openOnboarding() {
  if (S.me) return;
  const body = openSheet(`${steps(1)}
    <h2>Willkommen auf dem Parkplatz 👋</h2>
    <p class="sub">Trag ein, wo du stehst und wann du losfährst – die App sagt dir, wenn ihr euch zuparkt.</p>
    <label class="field">Dein Name<input type="text" id="obName" placeholder="z. B. Anna" maxlength="40" autocomplete="given-name"></label>
    <label class="field">Wohnung / Klingel (optional)<input type="text" id="obUnit" placeholder="z. B. 2. OG links" maxlength="30"></label>
    ${S.invite_required ? '<label class="field">Einladungscode<input type="text" id="obCode" autocomplete="off"></label>' : ''}
    <div class="actions"><button class="btn primary block" id="obGo">Weiter</button></div>`);
  $('#obGo', body).onclick = async () => {
    const r = await act(() => api('POST', '/api/register', {
      display_name: $('#obName', body).value, unit: $('#obUnit', body).value, invite_code: $('#obCode', body)?.value,
    }).then((res) => { token = res.token; store.set('park.token', token); return res; }));
    if (r) onboardCar();
  };
}

function onboardCar() {
  openCarEditor(null, { onDone: onboardRoutine });
  $('#sheetBody').insertAdjacentHTML('afterbegin', steps(2));
}

function onboardRoutine(carId) {
  let days = 31;
  const body = openSheet(`${steps(3)}
    <h2>Wann fährst du normalerweise los?</h2>
    <p class="sub">Zum Beispiel morgens zur Arbeit. Das kannst du später jederzeit ändern.</p>
    <div class="days" id="obDays">${WD.map((d, i) => `<button class="chip" data-d="${i}">${d}</button>`).join('')}</div>
    <label class="field">Uhrzeit<input type="time" id="obTime" value="07:30"></label>
    <label class="field">Anlass<input type="text" id="obLabel" value="Arbeit" maxlength="30"></label>
    <div class="actions"><button class="btn primary block" id="obSave">Speichern</button><button class="btn ghost block" id="obSkip">Keine feste Zeit</button></div>`);
  const paint = () => $$('#obDays .chip', body).forEach((b) => b.setAttribute('aria-pressed', !!(days & (1 << b.dataset.d))));
  $$('#obDays .chip', body).forEach((b) => (b.onclick = () => { days ^= 1 << b.dataset.d; paint(); }));
  paint();
  $('#obSave', body).onclick = async () => {
    await act(() => api('POST', `/api/cars/${carId}/recurring`, { weekdays: days, depart_time: $('#obTime', body).value, label: $('#obLabel', body).value }));
    onboardPush();
  };
  $('#obSkip', body).onclick = onboardPush;
}

function onboardPush() {
  const body = openSheet(`${steps(4)}
    <h2>Benachrichtigungen</h2>
    <p class="sub">Damit du erfährst, wenn du jemanden zuparkst – oder zugeparkt wirst.</p>
    ${'PushManager' in window ? '' : '<div class="callout info">Auf dem iPhone: Teilen → „Zum Home-Bildschirm“, dann die App von dort öffnen und hier aktivieren.</div>'}
    <div class="actions"><button class="btn primary block" id="obPush">Benachrichtigungen erlauben</button><button class="btn ghost block" id="obLater">Später</button></div>`);
  const done = () => { closeSheet(); toast('Fertig! Tippe auf deinen Stellplatz.'); };
  $('#obPush', body).onclick = () => enablePush().finally(done);
  $('#obLater', body).onclick = done;
}

// ── Push ────────────────────────────────────────────────────────────
function b64ToU8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush() {
  try {
    if (!S.push.public_key) throw new Error('Push ist auf dem Server nicht eingerichtet');
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Dieser Browser unterstützt keine Push-Nachrichten');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(S.push.public_key) });
    await api('POST', '/api/push/subscribe', sub.toJSON());
    await refresh();
    toast('Benachrichtigungen aktiv 🔔');
  } catch (e) {
    toast(e.message, true);
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ── Start ───────────────────────────────────────────────────────────
refresh().catch((e) => toast(`Server nicht erreichbar: ${e.message}`, true));
