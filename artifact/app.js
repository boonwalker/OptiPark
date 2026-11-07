// Parkoptimierer – Artefakt-Version
// Gemeinsame Daten im Artefakt-Speicher (db), Identität über das Claude-Konto (user).
// Ohne Speicher (Vorschau, abgemeldet) läuft eine lokale Demo.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── Parkplatz nach Skizze ───────────────────────────────────────────
// Raster: 1 Einheit ≈ 0,5 m, Stellplatz 4 × 6. Zufahrt oben, Patio unten.
const TZ = 'Europe/Berlin';
const HORIZON_MS = 36 * 3600e3;      // so weit im Voraus wird gewarnt
const PING_COOLDOWN_MS = 3 * 60e3;   // Nachklingeln frühestens alle 3 Min.
const REQUEST_EXPIRE_MS = 3600e3;    // Rausfahr-Anfrage verfällt nach 1 Std.
const ETA_LATER = 15;

const LOT = { name: 'Parkplatz', grid_w: 26, grid_h: 45 };
const ZONES = [
  { id: 'L', name: 'Tür 1 · links', grid_x: 0, grid_y: 0, grid_w: 12, grid_h: 45 },
  { id: 'R', name: 'Tür 2 · rechts', grid_x: 14, grid_y: 0, grid_w: 12, grid_h: 45 },
];
const ROW_Y = [2, 9, 16, 23, 30], PATIO_Y = 38, COL_L = 1, COL_R = 7, COL_C = 4;
const sp = (zone, code, x, y, kind = 'regular') => ({
  id: code, code, zone_id: zone, kind,
  grid_x: ZONES.find((z) => z.id === zone).grid_x + x, grid_y: y, grid_w: 4, grid_h: 6,
});
const SPOTS = [
  sp('L', 'L1', COL_R, ROW_Y[0]), sp('L', 'L2', COL_R, ROW_Y[1]), sp('L', 'L3', COL_R, ROW_Y[2]),
  sp('L', 'L4', COL_L, ROW_Y[3]), sp('L', 'L5', COL_R, ROW_Y[3]),
  sp('L', 'L6', COL_L, ROW_Y[4]), sp('L', 'L7', COL_R, ROW_Y[4]),
  sp('L', 'P1', COL_L, PATIO_Y, 'patio'), sp('L', 'P2', COL_R, PATIO_Y, 'patio'),
  sp('R', 'R1', COL_C, ROW_Y[2]),
  sp('R', 'R2', COL_L, ROW_Y[3]), sp('R', 'R3', COL_R, ROW_Y[3]),
  sp('R', 'R4', COL_L, ROW_Y[4]), sp('R', 'R5', COL_R, ROW_Y[4]),
  sp('R', 'P3', COL_L, PATIO_Y, 'patio'), sp('R', 'P4', COL_R, PATIO_Y, 'patio'),
];

// Wegenetz: über welche Plätze kommt ein Auto raus? null = direkt hinaus.
// Mehrere Einträge = alternative Wege (über A ODER über B).
// Autos parken rückwärts ein und fahren vorwärts hinaus.
const EXITS = {
  L1: [null], L2: [null], L3: [null], L4: [null],   // Fahrspur links neben L1–L3
  L5: ['L3', 'L4'],
  L6: ['L4', 'L7'],                                 // über L4 oder seitlich auf L7, dann über L5
  L7: ['L5', 'L6'],                                 // gerade über L5 oder schräg über L6
  R1: [null],                                       // steht mittig vor beiden Spalten
  R2: ['R1'], R3: ['R1'],
  R4: ['R2', 'R5'], R5: ['R3', 'R4'],               // seitlich auf den Nachbarplatz, dann gerade hinaus
  P1: ['L6', 'P2'],                                 // Trennwand endet vor dem Patio
  P2: ['L7', 'P1', 'P3'],
  P3: ['R4', 'P2', 'P4'],
  P4: ['R5', 'P3'],
};
const EXIT_LIST = Object.entries(EXITS).flatMap(([f, ts]) => ts.map((t) => [f, t]));

const COLORS = ['#5b8cff', '#ff6b5b', '#3ecf8e', '#ffb547', '#b57cff', '#ff7ab6', '#2ec4d6', '#e9ecf2', '#7c8594', '#2b3240'];
const WD = WD_SHORT;   // aus i18n.js

// ── Datenhaltung ────────────────────────────────────────────────────
// Sammlungen im Artefakt-Speicher:
//   residents/{nutzer-id}  Name, Wohnung, Autos mit üblichen und einmaligen Ausfahrten
//                          (jeder schreibt nur seinen eigenen Eintrag)
//   spots/{platz}          aktuelle Belegung {car_id, resident_id, parked_at}
//   decisions/{schlüssel}  Tausch-Entscheidungen zu einem Konflikt
//   requests/{id}          „Ich will gleich rausfahren“-Anfragen
const R = { residents: {}, spots: {}, decisions: {}, requests: {} };
let db = null, userApi = null, uid = null, mode = 'loading', canWrite = null, readOnly = false;
let S = null, selectedSpot = null, loadedOnce = false;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const rid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
const clone = (o) => JSON.parse(JSON.stringify(o ?? null));
const safeColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : '#7c8594');   // Daten anderer: nur echte Farben
/** Plätze, auf denen gerade ein (noch existierendes) Auto steht. */
function occupiedCodes() {
  const cars = new Set(Object.values(R.residents).flatMap((r) => (r.cars || []).filter((c) => c.active !== false).map((c) => c.id)));
  return new Set(SPOTS.map((s) => s.id).filter((code) => R.spots[code] && cars.has(R.spots[code].car_id)));
}

const queues = {};
function serial(path, fn) {   // eine Schreiboperation pro Dokument gleichzeitig
  const next = (queues[path] || Promise.resolve()).catch(() => {}).then(fn);
  queues[path] = next;
  return next;
}
function deepMerge(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  return out;
}
const P = {
  async set(path, data) {
    const [coll, id] = path.split('/');
    if (mode === 'demo') { R[coll][id] = clone(data); render(); return; }
    return serial(path, () => db.doc(path).set(data)).catch(writeFailed);
  },
  async update(path, patch) {
    const [coll, id] = path.split('/');
    if (mode === 'demo') { R[coll][id] = deepMerge(R[coll][id], clone(patch)); render(); return; }
    return serial(path, () => db.doc(path).update(patch)).catch(writeFailed);
  },
  async del(path) {
    const [coll, id] = path.split('/');
    if (mode === 'demo') { delete R[coll][id]; render(); return; }
    return serial(path, () => db.doc(path).delete()).catch(writeFailed);
  },
};
function writeFailed(e) {
  if (e?.code === 'invalid_argument') {
    readOnly = true; render();
    throw new Error(t('Du kannst hier nur zuschauen. Bitte den Besitzer, dich als Bearbeiter einzuladen.'));
  }
  if (e?.code === 'quota_exceeded') throw new Error(t('Der Speicher ist voll. Bitte alte Einträge löschen.'));
  throw new Error(t('Speichern hat nicht geklappt. Bitte gleich nochmal versuchen.'));
}

// ── Zeit (immer in der Zeitzone des Parkplatzes) ─────────────────────
const fmtParts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function parts(date) { return Object.fromEntries(fmtParts.formatToParts(date).map((p) => [p.type, p.value])); }
const localDate = (d) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
function zonedToUtc(y, mo, d, h, mi) {   // Wanduhrzeit in TZ → Zeitpunkt
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess));
    guess += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return guess;
}
function fmtWhen(isoStr) {
  if (!isoStr) return t('unbekannt');
  const d = new Date(isoStr), p = parts(d);
  const diff = Math.round((Date.parse(localDate(d)) - Date.parse(localDate(new Date()))) / 864e5);
  return `${fmtDay(diff, (new Date(localDate(d)).getUTCDay() + 6) % 7, +p.day, +p.month)} ${p.hour}:${p.minute}`;
}
function fmtDays(mask) {
  if (mask === 127) return t('täglich');
  if (mask === 31) return t('Mo–Fr');
  if (mask === 96) return t('Sa–So');
  return WD.filter((_, i) => mask & (1 << i)).join(', ');
}
const depText = (dep) => (dep ? `${fmtWhen(dep.at)}${dep.label ? ` · ${dep.label}` : ''}` : t('keine Ausfahrt bekannt'));
function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function tomorrowAt(h, m = 0) { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, m, 0, 0); return d; }

/** Nächste bekannte Ausfahrt: einmalige + übliche (8 Tage voraus, ohne ausgelassene Tage). */
function nextDeparture(car, now) {
  let best = null;
  const offer = (at, source, label) => { if (!best || at < best.at) best = { at, source, label: label || null }; };
  for (const p of car.planned || []) { const t = Date.parse(p.at); if (t > now) offer(t, 'planned', p.note); }
  const t0 = parts(new Date(now));
  const base = Date.UTC(+t0.year, +t0.month - 1, +t0.day);
  for (const r of car.recurring || []) {
    const [hh, mm] = r.time.split(':').map(Number);
    for (let i = 0; i < 8; i++) {
      const day = new Date(base + i * 864e5);
      const wd = (day.getUTCDay() + 6) % 7;
      if (!((r.weekdays >> wd) & 1)) continue;
      if ((r.skips || []).includes(day.toISOString().slice(0, 10))) continue;
      const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm);
      if (at > now) { offer(at, 'recurring', r.label); break; }
    }
  }
  return best && { at: iso(best.at), source: best.source, label: best.label, recurring_id: null };
}

// ── Wegsuche (Blockierungsregeln) ───────────────────────────────────
const movesFrom = (id) => EXITS[id] || [];
const movesInto = (id) => EXIT_LIST.filter(([, t]) => t === id).map(([f]) => f);
const aheadOf = (id) => movesFrom(id).filter((t) => t !== null);

/** Über freie Plätze nach draußen? Sonst: die Hindernisse, an die man zuerst stößt. */
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
/** Alle, die jetzt weg müssten – schichtweise (eine Schicht mit mehreren = Alternativen). */
function clearingLayers(start, obstacles) {
  const rest = new Set(obstacles), layers = [];
  for (;;) {
    const f = explore(start, rest);
    if (!f.size) return layers;
    layers.push([...f].sort());
    f.forEach((s) => rest.delete(s));
  }
}
const PATIO_IDS = new Set(SPOTS.filter((s) => s.kind === 'patio').map((s) => s.id));
/** Notweg: rückwärts über freie Plätze aufs Patio, dann auf normalen Wegen hinaus (nur wenn ganz frei). */
function patioRoute(start, obstacles) {
  if (PATIO_IDS.has(start) || explore(start, obstacles).size === 0) return null;
  const back = new Map([[start, null]]), queue = [start], reached = [];
  while (queue.length) {
    const s = queue.shift();
    for (const y of movesInto(s)) {
      if (obstacles.has(y) || back.has(y)) continue;
      back.set(y, s); queue.push(y);
      if (PATIO_IDS.has(y)) reached.push(y);
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
function fmtRoute(r) {
  if (!r) return '';
  const b = r.reverse;
  const head = b.length > 1 ? t('rückwärts über {via} auf {to}', { via: b.slice(0, -1).join(' → '), to: b[b.length - 1] }) : t('rückwärts auf {to}', { to: b[0] });
  return head + (r.forward.length ? t(', dann über {via} hinaus', { via: r.forward.join(' → ') }) : t(', dann hinaus'));
}

/** occ: Map(platz → {carId, dep: ms|null}) → [{blocker, blocked}] */
function findBlockings(occ) {
  const now = Date.now(), res = [];
  for (const [bSpot, b] of occ) {
    if (b.dep === null || b.dep - now > HORIZON_MS) continue;
    const still = new Set([...occ].filter(([s, a]) => s !== bSpot && (a.dep === null || a.dep > b.dep)).map(([s]) => s));
    for (const a of explore(bSpot, still)) res.push({ blocker: a, blocked: bSpot });
  }
  return res;
}
const blockedNow = (spotId) => explore(spotId, new Set(S.spots.filter((s) => s.occupant && s.id !== spotId).map((s) => s.id))).size > 0;

// ── Zustand ableiten ────────────────────────────────────────────────
function buildState() {
  const now = Date.now();
  const cars = {};
  for (const [rid_, r] of Object.entries(R.residents)) {
    for (const c of r.cars || []) if (c.active !== false && c.id) cars[c.id] = { car: { ...c, color: safeColor(c.color) }, resident_id: rid_, resident: r };
  }
  const spots = SPOTS.map((s) => {
    const o = R.spots[s.id];
    const entry = o && cars[o.car_id];
    return {
      ...s,
      occupant: entry ? {
        parking_id: `${s.id}@${o.parked_at}`, car_id: o.car_id, color: entry.car.color, parked_at: o.parked_at,
        next_departure: nextDeparture(entry.car, now), nickname: entry.car.nickname,
        patio_pref: entry.car.patio_route === 'never' ? 'never' : 'ask',
        resident_id: entry.resident_id, resident_name: entry.resident.display_name,
      } : null,
    };
  });
  const bySpot = Object.fromEntries(spots.map((s) => [s.id, s]));
  const parkedSpotOf = Object.fromEntries(spots.filter((s) => s.occupant).map((s) => [s.occupant.car_id, s.id]));

  const meDoc = uid && R.residents[uid];
  const me = meDoc ? {
    id: uid, display_name: meDoc.display_name, unit: meDoc.unit || null,
    cars: (meDoc.cars || []).filter((c) => c.active !== false).map((c) => ({
      ...c, color: safeColor(c.color), spot_id: parkedSpotOf[c.id] || null, next_departure: nextDeparture(c, now),
      recurring: c.recurring || [], planned: (c.planned || []).filter((p) => Date.parse(p.at) > now),
    })),
  } : null;

  // Konflikte
  const occ = new Map(spots.filter((s) => s.occupant).map((s) => [s.id, { carId: s.occupant.car_id, dep: s.occupant.next_departure ? Date.parse(s.occupant.next_departure.at) : null }]));
  const conflicts = [], other_conflicts = [], patio_reservations = [];
  const allOccupied = new Set(occ.keys());
  for (const { blocker, blocked } of findBlockings(occ)) {
    const a = bySpot[blocker].occupant, b = bySpot[blocked].occupant;
    const key = `${a.car_id}~${a.parked_at}~${b.car_id}~${b.parked_at}~${b.next_departure.at}`.replace(/[^A-Za-z0-9_\-.~:@+]/g, '');
    const d = R.decisions[key] || {};
    // Notweg vorsichtig: jetzt frei, alle geparkten Autos zählen als Hindernis
    const others = new Set(allOccupied); others.delete(blocked);
    const route = b.patio_pref !== 'never' ? patioRoute(blocked, others) : null;
    const routeKey = route ? JSON.stringify(route) : null;
    // Bs Antwort gilt nur für genau diesen Weg; ändert er sich oder fällt er weg, wird neu gefragt
    const patioChoice = routeKey && d.patio_route === routeKey ? d.patio_choice || null : null;
    const status = patioChoice === 'yes' ? 'patio'
      : d.blocker_choice === 'swap' && d.blocked_choice === 'swap' ? 'swap_agreed' : d.blocker_choice === 'manual' ? 'acknowledged' : 'open';
    if (status === 'patio') patio_reservations.push({ resident_id: b.resident_id, name: b.resident_name, from_spot: blocked, at: b.next_departure.at, spots: [...route.reverse, ...route.forward], text: fmtRoute(route) });
    const c = {
      id: key, status, blocker_choice: d.blocker_choice || null, blocked_choice: d.blocked_choice || null,
      blocked_departs_at: b.next_departure.at, blocker_departs_at: a.next_departure?.at || null,
      blocker_spot: blocker, blocker_car: a.nickname, blocker_car_id: a.car_id, blocker_name: a.resident_name, blocker_resident_id: a.resident_id,
      blocked_spot: blocked, blocked_car: b.nickname, blocked_car_id: b.car_id, blocked_name: b.resident_name, blocked_resident_id: b.resident_id,
      patio_route: routeKey, patio_text: fmtRoute(route), patio_choice: patioChoice,
    };
    if (uid && (c.blocker_resident_id === uid || c.blocked_resident_id === uid)) {
      c.role = c.blocker_resident_id === uid ? 'blocker' : 'blocked';
      conflicts.push(c);
    } else if (status === 'open') other_conflicts.push(c);   // nur als graue Linie auf der Grafik
  }
  conflicts.sort((x, y) => x.blocked_departs_at.localeCompare(y.blocked_departs_at));

  // Rausfahr-Anfragen (aktiv = offen, Auto steht noch da, Weg noch zu, nicht verfallen)
  const leave_requests = [];
  for (const [id, q] of Object.entries(R.requests)) {
    if (!isRequestActive(q, now)) continue;
    const occupied = new Set(spots.filter((s) => s.occupant && s.id !== q.spot).map((s) => s.id));
    const layers = clearingLayers(q.spot, occupied);
    const req = bySpot[q.spot].occupant;
    const blockers = layers.flatMap((layer, i) => layer.map((code) => {
      const o = bySpot[code].occupant, resp = (q.responses || {})[o.car_id] || {};
      return { parking_id: o.car_id, car_id: o.car_id, layer: i, name: o.resident_name, car: o.nickname, spot: code, resident_id: o.resident_id, response: resp.response || null, eta_minutes: resp.response === 'later' ? ETA_LATER : null };
    }));
    const role = q.requester_id === uid ? 'requester' : blockers.some((b) => b.resident_id === uid) ? 'blocker' : null;
    if (!role) continue;
    leave_requests.push({
      id, role, requester_name: req.resident_name, requester_car: req.nickname, requester_spot: q.spot, requester_car_id: q.car_id,
      created_at: q.created_at, last_pinged_at: q.last_pinged_at, next_ping_at: iso(Math.max(Date.parse(q.last_pinged_at) + PING_COOLDOWN_MS, now)), blockers,
    });
  }
  if (me) {
    for (const c of me.cars) {
      const others = new Set(allOccupied); others.delete(c.spot_id);
      c.patio_now = c.spot_id && c.patio_route !== 'never' ? patioRoute(c.spot_id, others) : null;
    }
  }
  return { lot: LOT, zones: ZONES, spots, exits: EXIT_LIST, me, conflicts, other_conflicts, leave_requests, patio_reservations };
}

function isRequestActive(q, now = Date.now()) {
  if (!q || q.status !== 'open' || !EXITS[q.spot] || !(now - Date.parse(q.created_at) <= REQUEST_EXPIRE_MS)) return false;
  const occupied = occupiedCodes();
  const o = R.spots[q.spot];
  if (!occupied.has(q.spot) || o.car_id !== q.car_id || o.parked_at !== q.parked_at) return false;
  occupied.delete(q.spot);
  return explore(q.spot, occupied).size > 0;
}

// ── Aktionen ────────────────────────────────────────────────────────
function myDoc() { return clone(R.residents[uid]) || { display_name: '', unit: '', cars: [] }; }
async function saveMe(mutate) {
  if (!uid) throw new Error(t('Bitte bei Claude anmelden, um mitzumachen.'));
  const doc = myDoc();
  mutate(doc);
  const now = Date.now();
  for (const c of doc.cars) c.planned = (c.planned || []).filter((p) => Date.parse(p.at) > now);
  doc.updated_at = iso(now);
  await P.set(`residents/${uid}`, doc);
}
const myCar = (doc, carId) => {
  const c = doc.cars.find((x) => x.id === carId && x.active !== false);
  if (!c) throw new Error(t('Auto nicht gefunden'));
  return c;
};

const API = {
  async register({ display_name, unit }) {
    const name = (display_name || '').trim().slice(0, 40);
    if (!name) throw new Error(t('Bitte gib deinen Namen ein'));
    await saveMe((d) => { d.display_name = name; d.unit = (unit || '').trim().slice(0, 30); d.created_at ||= iso(Date.now()); });
  },
  async updateMe({ display_name, unit }) {
    await saveMe((d) => { if (display_name?.trim()) d.display_name = display_name.trim().slice(0, 40); d.unit = (unit || '').trim().slice(0, 30); });
  },
  async saveCar(carId, { nickname, plate, color }) {
    const n = (nickname || '').trim().slice(0, 30);
    if (!n) throw new Error(t('Bitte gib dem Auto einen Namen'));
    let id = carId;
    await saveMe((d) => {
      if (carId) Object.assign(myCar(d, carId), { nickname: n, plate: (plate || '').trim().slice(0, 15), color });
      else { id = rid(); d.cars.push({ id, nickname: n, plate: (plate || '').trim().slice(0, 15), color, active: true, recurring: [], planned: [] }); }
    });
    return { id };
  },
  async deleteCar(carId) {
    const spot = Object.keys(R.spots).find((s) => R.spots[s]?.car_id === carId);
    if (spot) await P.del(`spots/${spot}`);
    await saveMe((d) => { myCar(d, carId).active = false; });
  },
  async setPatioPref(carId, pref) { await saveMe((d) => { myCar(d, carId).patio_route = pref === 'never' ? 'never' : 'ask'; }); },
  async addRecurring(carId, { weekdays, time, label }) {
    if (!(weekdays >= 1 && weekdays <= 127)) throw new Error(t('Mindestens einen Wochentag wählen'));
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')) throw new Error(t('Uhrzeit als HH:MM angeben'));
    await saveMe((d) => { myCar(d, carId).recurring.push({ id: rid(), weekdays, time, label: (label || '').trim().slice(0, 30) || null, skips: [] }); });
  },
  async deleteRecurring(carId, recId) { await saveMe((d) => { const c = myCar(d, carId); c.recurring = c.recurring.filter((r) => r.id !== recId); }); },
  async skipRecurring(carId, recId, date, undo = false) {
    await saveMe((d) => {
      const r = myCar(d, carId).recurring.find((x) => x.id === recId);
      r.skips = (r.skips || []).filter((x) => x !== date && x >= localDate(new Date(Date.now() - 864e5)));
      if (!undo) r.skips.push(date);
    });
  },
  async addPlanned(carId, atIso, note) {
    if (!atIso || Date.parse(atIso) <= Date.now()) throw new Error(t('Ausfahrzeit muss in der Zukunft liegen'));
    await saveMe((d) => { myCar(d, carId).planned.push({ id: rid(), at: iso(Date.parse(atIso)), note: (note || '').trim().slice(0, 40) || null }); });
  },
  async deletePlanned(carId, pid) { await saveMe((d) => { const c = myCar(d, carId); c.planned = c.planned.filter((p) => p.id !== pid); }); },

  async park(carId, spotId, departAt) {
    myCar(myDoc(), carId);
    if (mode === 'db') {
      const lease = await db.doc(`spots/${spotId}`).acquire({ holder: uid, ttlMs: 5000 });
      if (!lease.acquired) throw new Error(t('Gerade parkt dort jemand anderes. Bitte gleich nochmal versuchen.'));
      const snap = await db.doc(`spots/${spotId}`).get();
      if (snap.exists && snap.data().car_id && snap.data().car_id !== carId) throw new Error(t('Der Platz ist schon belegt'));
    } else if (R.spots[spotId] && R.spots[spotId].car_id !== carId) throw new Error(t('Der Platz ist schon belegt'));
    if (departAt) await API.addPlanned(carId, departAt);
    if (R.spots[spotId]?.car_id === carId) return;
    const old = Object.keys(R.spots).find((s) => R.spots[s]?.car_id === carId);
    if (old) await P.del(`spots/${old}`);
    await P.set(`spots/${spotId}`, { car_id: carId, resident_id: uid, parked_at: iso(Date.now()) });
    cleanup();
  },
  async leave(carId) {
    const spot = Object.keys(R.spots).find((s) => R.spots[s]?.car_id === carId);
    if (spot) await P.del(`spots/${spot}`);
    const soon = Date.now() + 3600e3;   // einmalige Fahrt der nächsten Stunde gilt als gefahren
    if ((myDoc().cars.find((c) => c.id === carId)?.planned || []).some((p) => Date.parse(p.at) <= soon)) {
      await saveMe((d) => { const c = myCar(d, carId); c.planned = c.planned.filter((p) => Date.parse(p.at) > soon); });
    }
    cleanup();
  },

  async choice(cid, choice) {
    const c = S.conflicts.find((x) => x.id === cid);
    if (!c) throw new Error(t('Konflikt nicht mehr aktiv'));
    const d = clone(R.decisions[cid]) || {};
    if (choice.startsWith('patio_')) {
      if (c.blocked_resident_id !== uid || !c.patio_route) throw new Error(t('Der Patio-Notweg steht hier nicht zur Wahl'));
      d.patio_choice = choice.slice(6);
      d.patio_route = c.patio_route;
    } else {
      if (c.blocker_resident_id === uid) d.blocker_choice = choice;
      if (c.blocked_resident_id === uid) d.blocked_choice = choice;
    }
    d.updated_at = iso(Date.now());
    await P.set(`decisions/${cid}`, d);
    return { status: d.blocker_choice === 'swap' && d.blocked_choice === 'swap' ? 'swap_agreed' : 'other' };
  },
  async swap(cid) {
    const c = S.conflicts.find((x) => x.id === cid);
    if (!c) throw new Error(t('Konflikt nicht mehr aktiv'));
    if (c.status !== 'swap_agreed' && c.blocker_resident_id !== c.blocked_resident_id) throw new Error(t('Beide müssen dem Tausch zustimmen'));
    const now = iso(Date.now());
    await P.set(`spots/${c.blocker_spot}`, { car_id: c.blocked_car_id, resident_id: c.blocked_resident_id, parked_at: now });
    await P.set(`spots/${c.blocked_spot}`, { car_id: c.blocker_car_id, resident_id: c.blocker_resident_id, parked_at: now });
    await P.del(`decisions/${cid}`);
  },

  async wantOut(carId) {
    const spot = Object.keys(R.spots).find((s) => R.spots[s]?.car_id === carId);
    if (!spot) throw new Error(t('Das Auto ist gerade nicht geparkt'));
    const o = R.spots[spot];
    if (Object.values(R.requests).some((q) => q.car_id === carId && q.parked_at === o.parked_at && isRequestActive(q))) throw new Error(t('Deine Anfrage läuft schon'));
    if (!blockedNow(spot)) throw new Error(t('Du kommst raus – niemand steht im Weg'));
    const id = rid(), now = iso(Date.now());
    await P.set(`requests/${id}`, { requester_id: uid, car_id: carId, spot, parked_at: o.parked_at, created_at: now, last_pinged_at: now, status: 'open', responses: {} });
    return { id };
  },
  async ping(id) {
    const q = R.requests[id];
    const wait = Date.parse(q.last_pinged_at) + PING_COOLDOWN_MS - Date.now();
    if (wait > 0) throw new Error(t('Bitte noch {n} Min. warten', { n: Math.ceil(wait / 60e3) }));
    await P.update(`requests/${id}`, { last_pinged_at: iso(Date.now()) });
  },
  async cancelRequest(id) { await P.update(`requests/${id}`, { status: 'cancelled' }); },
  async respond(id, carId, response) {
    await P.update(`requests/${id}`, { responses: { [carId]: { response, at: iso(Date.now()) } } });
  },
};

/** Aufräumen bei eigenen Aktionen: erledigte eigene Anfragen und verwaiste Entscheidungen löschen. */
function cleanup() {
  if (readOnly || !uid) return;
  setTimeout(() => {
    for (const [id, q] of Object.entries(R.requests)) if (q.requester_id === uid && !isRequestActive(q)) P.del(`requests/${id}`).catch(() => {});
    const live = new Set((S?.conflicts || []).map((c) => c.id));
    for (const [key] of Object.entries(R.decisions)) {
      const [ca, pa, cb, pb] = key.split('~');
      const parked = (car, at) => Object.values(R.spots).some((o) => o?.car_id === car && o.parked_at.replace(/[^A-Za-z0-9_\-.~:@+]/g, '') === at);
      if (!live.has(key) && !(parked(ca, pa) && parked(cb, pb))) P.del(`decisions/${key}`).catch(() => {});
    }
  }, 1500);
}

async function act(fn, okMsg) {
  try {
    if (readOnly) throw new Error(t('Du kannst hier nur zuschauen. Bitte den Besitzer, dich als Bearbeiter einzuladen.'));
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message || t('Das hat nicht geklappt'), true);
    throw e;
  }
}

// ── Rendern ─────────────────────────────────────────────────────────
const spotById = (id) => S.spots.find((s) => s.id === id);
const myCars = () => S.me?.cars ?? [];
const myCarIds = () => new Set(myCars().map((c) => c.id));
const myUnparkedCar = () => myCars().find((c) => !c.spot_id);
const myRequest = (carId) => S.leave_requests.find((r) => r.role === 'requester' && r.requester_car_id === carId);

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; apply(buildState()); }, 0);
}

function apply(st) {
  const prev = S;
  S = st;
  if (!prev) renderDeco();
  renderBanner();
  renderBays();
  renderCars(prev);
  renderLinks();
  renderStatus();
  renderConflicts();
  renderAvatar();
  document.body.classList.toggle('can-park', !!myUnparkedCar());
  if (loadedOnce) notifyChanges(prev, st);
  if (!prev) handleHash();
}

function renderBanner() {
  const el = $('#banner');
  let html = '';
  if (mode === 'loading') html = t('Lade den Parkplatz …');
  else if (mode === 'slow') html = t('Die Daten sind gerade nicht erreichbar. Die Anzeige kann veraltet sein.');
  else if (mode === 'demo') html = t('<b>Demo</b> · Hier ist kein gemeinsamer Speicher verfügbar. Du siehst Beispiel-Nachbarn, Änderungen bleiben nur in diesem Fenster.');
  else if (!uid) html = t('Melde dich bei Claude an, um einen Stellplatz zu belegen.');
  else if (readOnly) html = t('Du kannst nur zuschauen. Bitte den Besitzer, dich als Bearbeiter einzuladen.');
  el.innerHTML = html;
  el.hidden = !html;
}

function g(el, x, y, w, h) {
  el.classList.add('g');
  el.style.cssText += `--x:${x};--y:${y};--w:${w};--h:${h}`;
  return el;
}
function div(cls, html = '') { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; }

function renderDeco() {
  const deco = $('#lotDeco');
  deco.innerHTML = '';
  const overlaps = (a, b) => a.grid_x < b.grid_x + b.grid_w && b.grid_x < a.grid_x + a.grid_w && a.grid_y < b.grid_y + b.grid_h && b.grid_y < a.grid_y + a.grid_h;
  const patioTop = Math.min(...SPOTS.filter((s) => s.kind === 'patio').map((s) => s.grid_y)) - 1.5;
  ZONES.forEach((z) => {
    const p = g(div('patio'), z.grid_x, patioTop, z.grid_w, z.grid_y + z.grid_h - patioTop);
    p.append(div('patio-label', 'Patio'));
    deco.append(p);
    deco.append(g(div('gate', `<span class="gate-label">${esc(t(z.name))}</span>`), z.grid_x, 0, z.grid_w, 1.8));
    const regular = SPOTS.filter((s) => s.zone_id === z.id && s.kind === 'regular');
    const placed = [];
    for (const y of [...new Set(regular.map((s) => s.grid_y))].sort((a, b) => a - b)) {
      for (const dx of [4, 1, 7]) {
        const c = { grid_x: z.grid_x + dx, grid_y: y, grid_w: 4, grid_h: 6 };
        if (regular.some((s) => overlaps(c, s)) || placed.some((q) => overlaps(c, q))) continue;
        placed.push(c);
      }
    }
    placed.forEach((c, i) => {
      const a = g(div('arrow', '<svg viewBox="0 0 24 40"><path d="M12 2v30M4 24l8 10 8-10" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'), c.grid_x, c.grid_y, c.grid_w, c.grid_h);
      a.querySelector('svg').style.animationDelay = `${i * 0.35}s`;
      deco.append(a);
    });
  });
  // Trennwand bis vor das Patio, dort Durchgang zwischen den Seiten
  deco.append(g(div('median'), 12.6, 0, 0.8, patioTop));
  deco.append(g(div('patio passage'), 12, patioTop, 2, LOT.grid_h - patioTop));
}

function renderBays() {
  const host = $('#bays');
  const mine = myCarIds();
  const conflictSpots = new Set(S.conflicts.filter((c) => c.status === 'open').flatMap((c) => [c.blocker_spot, c.blocked_spot]));
  const waitSpots = new Set(S.leave_requests.map((r) => r.requester_spot));
  const moveSpots = new Set(S.leave_requests.flatMap((r) => r.blockers.map((b) => b.spot)));
  const relBlocks = new Set(selectedSpot ? movesInto(selectedSpot) : []);
  const relAhead = new Set(selectedSpot ? aheadOf(selectedSpot) : []);
  [...S.spots].sort((a, b) => a.grid_y - b.grid_y || a.grid_x - b.grid_x).forEach((s, i) => {
    let el = host.querySelector(`[data-spot="${s.id}"]`);
    if (!el) {
      el = g(document.createElement('button'), s.grid_x, s.grid_y, s.grid_w, s.grid_h);
      el.classList.add('bay');
      if (s.kind === 'patio') el.classList.add('patio-bay');
      el.dataset.spot = s.id;
      el.id = `bay-${s.id}`;
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
    el.classList.toggle('rel-blocked-by', relAhead.has(s.id));
    el.classList.toggle('conflict-bay', conflictSpots.has(s.code));
    el.classList.toggle('wait-bay', waitSpots.has(s.code));
    el.classList.toggle('move-bay', moveSpots.has(s.code));
    el.setAttribute('aria-label', o ? t('Platz {spot}, belegt von {name}', { spot: s.code, name: o.resident_name }) : t('Platz {spot}, frei', { spot: s.code }));
  });
}

function renderCars(prev) {
  const host = $('#cars');
  const lotRect = $('#lot').getBoundingClientRect();
  const mine = myCarIds();
  const now = new Map(S.spots.filter((s) => s.occupant).map((s) => [s.occupant.car_id, s]));
  const before = new Map(prev ? prev.spots.filter((s) => s.occupant).map((s) => [s.occupant.car_id, s]) : []);
  const firstLoad = !host.children.length;

  for (const el of $$('.car', host)) {
    if (now.has(el.dataset.car) || el.classList.contains('leaving')) continue;
    el.classList.add('leaving', 'driving');
    const r = el.getBoundingClientRect();
    const dist = r.bottom - lotRect.top + 20;
    el.animate(
      [{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(6px)', offset: 0.15 }, { transform: `translateY(${-dist}px)`, opacity: 0 }],
      { duration: 900 + dist * 1.2, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' },
    ).finished.then(() => el.remove(), () => el.remove());
  }
  let n = 0;
  for (const [carId, spot] of now) {
    const o = spot.occupant;
    let el = $$('.car', host).find((x) => x.dataset.car === carId && !x.classList.contains('leaving'));
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
    el.querySelector('.tag').textContent = (o.resident_name || '').split(' ')[0];
    if (isNew) {
      const r = el.getBoundingClientRect();
      const dist = r.bottom - lotRect.top + 10;
      el.classList.add('reversing');
      el.animate(
        [{ transform: `translateY(${-dist}px)`, opacity: 0 }, { opacity: 1, offset: 0.15 }, { transform: 'translateY(5px)', offset: 0.82 }, { transform: 'translateY(-1px)', offset: 0.92 }, { transform: 'translateY(0)', opacity: 1 }],
        { duration: 1000 + dist * 0.9, delay: firstLoad ? 700 + n++ * 140 : 0, easing: 'cubic-bezier(.2,.65,.25,1)', fill: 'backwards' },
      ).finished.then(() => setTimeout(() => el.classList.remove('reversing'), 400), () => {});
    } else if (oldRect) {
      const r = el.getBoundingClientRect();
      el.classList.add('driving');
      el.animate([{ transform: `translate(${oldRect.left - r.left}px, ${oldRect.top - r.top}px)` }, { transform: 'translate(0,0)' }], { duration: 1400, easing: 'cubic-bezier(.45,0,.2,1)' })
        .finished.then(() => el.classList.remove('driving'), () => {});
    }
  }
}

function renderLinks() {
  const pct = (s) => [((s.grid_x + s.grid_w / 2) / LOT.grid_w) * 100, ((s.grid_y + s.grid_h / 2) / LOT.grid_h) * 100];
  const line = (a, b, cls = '') => {
    const [x1, y1] = pct(spotById(a)), [x2, y2] = pct(spotById(b));
    return `<line class="${cls}" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%"/><circle class="${cls}" cx="${x2}%" cy="${y2}%" r="5"/>`;
  };
  $('#links').innerHTML = S.conflicts.filter((c) => c.status === 'open').map((c) => line(c.blocker_spot, c.blocked_spot)).join('')
    + S.other_conflicts.map((c) => line(c.blocker_spot, c.blocked_spot, 'other')).join('')
    + S.leave_requests.flatMap((r) => r.blockers.map((b) => line(b.spot, r.requester_spot, 'req'))).join('');
}

function renderAvatar() {
  const btn = $('#profileBtn');
  btn.textContent = S.me ? (S.me.display_name.trim()[0] || '?').toUpperCase() : '?';
  btn.style.setProperty('--avatar', myCars()[0]?.color || 'var(--line)');
}

function renderStatus() {
  const el = $('#status');
  if (mode === 'loading') { el.innerHTML = ''; return; }
  if (!S.me) {
    el.innerHTML = uid || mode === 'demo'
      ? `<div class="st-row"><div class="grow"><b>${t('Willkommen!')}</b><small>${t('Trag dich ein, um Plätze zu belegen und Konflikte zu sehen.')}</small></div><button class="btn primary small" id="stGo">${t('Loslegen')}</button></div>`
      : '';
    const go = $('#stGo'); if (go) go.onclick = openOnboarding;
    return;
  }
  if (!myCars().length) {
    el.innerHTML = `<div class="st-row"><div class="grow"><b>${t('Noch kein Auto')}</b><small>${t('Leg dein Auto an, dann kannst du parken.')}</small></div><button class="btn primary small" id="stCar">${t('Auto anlegen')}</button></div>`;
    $('#stCar').onclick = () => openCarEditor();
    return;
  }
  el.innerHTML = myCars().map((c) => {
    const spot = c.spot_id ? spotById(c.spot_id) : null;
    return `<div class="st-row"><div class="swatch" style="background:${esc(c.color)}"></div>
      <div class="grow">${spot
        ? `<b>${t('{car} steht auf {spot}', { car: esc(c.nickname), spot: esc(spot.code) })}</b><small>${t('Nächste Ausfahrt: {dep}', { dep: esc(depText(c.next_departure)) })}</small>`
        : `<b>${t('{car} ist unterwegs', { car: esc(c.nickname) })}</b><small>${t('Zurück? Tippe auf einen freien Platz.')}</small>`}</div>
      ${spot ? `<button class="btn small" data-leave="${esc(c.id)}">${t('Losgefahren')}</button>` : ''}</div>
      ${spot && blockedNow(spot.id) && !myRequest(c.id) ? `<button class="btn primary block" data-wantout="${esc(c.id)}">${t('🚗 Ich will gleich rausfahren')}</button>` : ''}`;
  }).join('');
  $$('[data-leave]', el).forEach((b) => (b.onclick = () => act(() => API.leave(b.dataset.leave), t('Gute Fahrt! 👋'))));
  $$('[data-wantout]', el).forEach((b) => (b.onclick = () => wantOut(b.dataset.wantout)));
}

async function wantOut(carId, { skipPatio = false } = {}) {
  const car = myCars().find((c) => c.id === carId);
  if (car?.patio_now && !skipPatio) return askPatioNow(car);
  await act(() => API.wantOut(carId));
  await new Promise((r) => setTimeout(r, 50));
  const req = buildState().leave_requests.find((x) => x.role === 'requester' && x.requester_car_id === carId);
  const others = req ? [...new Set(req.blockers.filter((b) => b.resident_id !== uid).map((b) => b.name))] : [];
  toast(others.length ? t(others.length > 1 ? '{names} sehen deine Anfrage' : '{names} sieht deine Anfrage', { names: others.join(', ') }) : t('Anfrage gestartet'));
}

function askPatioNow(car) {
  const body = openSheet(`
    <h2>${t('Notlösung übers Patio?')}</h2>
    <p class="sub">${t('Gerade steht dir jemand im Weg. Ohne einen Nachbarn zu stören, kämst du so raus:')}</p>
    <div class="callout info">${esc(fmtRoute(car.patio_now))}</div>
    <p class="hint">${t('Das Patio ist schmal und braucht etwas Rangieren. Nimm den Weg nur, wenn dein Auto passt und du das magst.')}</p>
    <div class="actions">
      <button class="btn primary block" id="pnYes">${t('Ja, ich fahre übers Patio')}</button>
      <button class="btn block" id="pnNo">${t('Nein, Nachbarn fragen')}</button>
      <button class="btn ghost block" id="pnNever">${t('Kommt für mein Auto nie in Frage')}</button>
    </div>`);
  $('#pnYes', body).onclick = () => { closeSheet(); toast(t('Gute Fahrt übers Patio! Tippe danach auf „Losgefahren“.')); };
  $('#pnNo', body).onclick = () => { closeSheet(); wantOut(car.id, { skipPatio: true }); };
  $('#pnNever', body).onclick = async () => {
    await act(() => API.setPatioPref(car.id, 'never'), t('Gemerkt: kein Patio-Notweg'));
    closeSheet(); setTimeout(() => wantOut(car.id, { skipPatio: true }), 60);
  };
}

function renderConflicts() {
  const host = $('#conflicts');
  host.innerHTML = S.leave_requests.map(requestCard).join('') + S.conflicts.map(conflictCard).join('');
  $$('[data-choice]', host).forEach((b) => (b.onclick = async () => {
    const r = await act(() => API.choice(b.dataset.id, b.dataset.choice));
    toast(t(b.dataset.choice === 'patio_yes' ? 'Alles klar – gute Fahrt übers Patio'
      : r.status === 'swap_agreed' ? 'Tausch vereinbart 🤝' : b.dataset.choice === 'swap' ? 'Tausch-Wunsch gespeichert' : 'Gespeichert'));
  }));
  $$('[data-swap]', host).forEach((b) => (b.onclick = () => act(() => API.swap(b.dataset.swap), t('Plätze getauscht 🎉'))));
  $$('[data-respond]', host).forEach((b) => (b.onclick = () => act(() => API.respond(b.dataset.rid, b.dataset.car, b.dataset.respond), t(b.dataset.respond === 'coming' ? 'Danke! Bescheid gegeben 👍' : 'Bescheid gegeben'))));
  $$('[data-ping]', host).forEach((b) => (b.onclick = () => act(() => API.ping(b.dataset.ping), t('Nochmal geklingelt 🔔'))));
  $$('[data-cancelreq]', host).forEach((b) => (b.onclick = () => act(() => API.cancelRequest(b.dataset.cancelreq), t('Anfrage beendet'))));
}

function minutesSince(isoStr) { return Math.max(0, Math.round((Date.now() - Date.parse(isoStr)) / 60000)); }

function requestCard(r) {
  if (r.role === 'requester') {
    const p = parts(new Date(r.next_ping_at));
    const rows = r.blockers.map((b) => {
      const own = b.resident_id === uid;
      const state = own ? t('dein eigenes Auto') : b.response === 'coming' ? t('✓ kommt sofort') : b.response === 'later' ? t('⏱ in ~{n} Min.', { n: b.eta_minutes }) : t('… noch keine Antwort');
      return `<div class="item"><div class="grow"><b>${esc(b.spot)} · ${own ? esc(b.car) : esc(b.name)}</b><small>${state}</small></div></div>`;
    }).join('');
    const layers = new Set(r.blockers.map((b) => b.layer)).size;
    const orHint = r.blockers.some((b, i, a) => a.findIndex((x) => x.layer === b.layer) !== i) ? `<p class="hint">${t('Bei mehreren Wegen reicht es, wenn einer davon Platz macht.')}</p>` : '';
    return `<article class="conflict request" id="raus-${esc(r.id)}"><h3>${t('Du willst raus – Anfrage läuft')}</h3>
      <div class="meta">${t('{car} auf {spot} · seit {n} Min.', { car: esc(r.requester_car), spot: esc(r.requester_spot), n: minutesSince(r.created_at) })}${layers > 1 ? t(' · mehrere müssen nacheinander weg') : ''}</div>
      <div class="list">${rows}</div>${orHint}
      <div class="row"><button class="btn small" data-ping="${esc(r.id)}">${t('🔔 Nochmal klingeln')}</button><button class="btn small ghost" data-cancelreq="${esc(r.id)}">${t('Hat sich erledigt')}</button></div>
      <p class="hint" style="margin:8px 0 0">${t('Nachklingeln ab {time} möglich. Ist der Weg frei, endet die Anfrage von selbst.', { time: `${p.hour}:${p.minute}` })}</p></article>`;
  }
  return r.blockers.filter((b) => b.resident_id === uid).map((b) => {
    const alt = r.blockers.filter((o) => o.layer === b.layer && o.car_id !== b.car_id);
    const answered = b.response === 'coming' ? t('Du hast geantwortet: kommst sofort.') : b.response === 'later' ? t('Du hast geantwortet: in ~{n} Min.', { n: b.eta_minutes }) : '';
    return `<article class="conflict request urgent" id="raus-${esc(r.id)}"><h3>${t('🚗 {name} will gleich rausfahren', { name: esc(r.requester_name) })}</h3>
      <p>${t('Dein {car} auf {spot} steht im Weg ({their_spot}). Bitte kurz umparken.', { car: esc(b.car), spot: `<b>${esc(b.spot)}</b>`, their_spot: esc(r.requester_spot) })}</p>
      ${alt.length ? `<div class="meta">${t('Alternativ könnte auch {who} Platz machen.', { who: alt.map((o) => `${esc(o.name)} (${esc(o.spot)})`).join(t(' oder ')) })}</div>` : ''}
      ${answered ? `<div class="callout good">${answered}</div>` : ''}
      <div class="row">${b.response !== 'coming' ? `<button class="btn small primary" data-respond="coming" data-rid="${esc(r.id)}" data-car="${esc(b.car_id)}">${t('Komme sofort')}</button>` : ''}
        ${b.response !== 'later' ? `<button class="btn small" data-respond="later" data-rid="${esc(r.id)}" data-car="${esc(b.car_id)}">${t('Dauert ~15 Min.')}</button>` : ''}</div></article>`;
  }).join('');
}

function conflictCard(c) {
  const me = c.role, other = me === 'blocker' ? 'blocked' : 'blocker';
  const myChoice = c[`${me}_choice`], theirChoice = c[`${other}_choice`];
  const otherName = esc(c[`${other}_name`]);
  const bWhen = esc(fmtWhen(c.blocked_departs_at));
  const aWhen = c.blocker_departs_at ? esc(fmtWhen(c.blocker_departs_at)) : t('zu unbekannter Zeit');
  const id = esc(c.id);
  const btn = (choice, label, cls = '') => `<button class="btn small ${cls}" data-id="${id}" data-choice="${choice}">${label}</button>`;
  const meta = `<div class="meta">${t('{a} steht vor {b}', { a: esc(c.blocker_spot), b: esc(c.blocked_spot) })}</div>`;
  const anchor = `konflikt-${esc(c.blocker_spot)}-${esc(c.blocked_spot)}`;
  if (c.blocker_resident_id === c.blocked_resident_id) {
    return `<article class="conflict" id="${anchor}"><h3>${t('Du stehst dir selbst im Weg')}</h3>
      <p>${t('{b_car} ({b_spot}) muss {b_when} raus, {a_car} ({a_spot}) steht davor.', { b_car: esc(c.blocked_car), b_spot: esc(c.blocked_spot), b_when: bWhen, a_car: esc(c.blocker_car), a_spot: esc(c.blocker_spot) })}</p>
      <div class="row"><button class="btn small good" data-swap="${id}">${t('Umgeparkt ✓')}</button></div></article>`;
  }
  if (c.status === 'patio') {
    return me === 'blocked'
      ? `<article class="conflict ok" id="${anchor}"><h3>${t('Du fährst übers Patio raus')}</h3>
          <p>${t('Zugesagt: {route}. Parkt bis {when} jemand auf diesem Weg, zeigt dir die App das hier an.', { route: esc(c.patio_text), when: bWhen })}</p>
          <div class="row">${btn('patio_no', t('Doch nicht'), 'ghost')}</div></article>`
      : `<article class="conflict ok" id="${anchor}"><h3>${t('{name} weicht übers Patio aus', { name: otherName })}</h3>
          <p>${t('Du musst nichts tun. Wird der Patio-Weg zugeparkt, meldet sich die App wieder.')}</p>${meta}</article>`;
  }
  if (c.patio_route && !c.patio_choice && me === 'blocked' && !myChoice && !theirChoice) {
    return `<article class="conflict" id="${anchor}"><h3>${t('{name} steht vor dir', { name: otherName })}</h3>
      <p>${t('Du musst {b_when} raus, {name} fährt erst {a_when}.', { b_when: `<b>${bWhen}</b>`, name: otherName, a_when: aWhen })}</p>${meta}
      <div class="callout info"><b>${t('Notlösung ohne {name}:', { name: otherName })}</b> ${esc(c.patio_text)}. ${t('Das Patio ist schmal und braucht etwas Rangieren. Der Weg ist jetzt frei; parkt bis dahin jemand darauf, zeigt dir die App das an.')}</div>
      <p><b>${t('Kommt das für dich in Frage?')}</b></p>
      <div class="row">${btn('patio_yes', t('Ja, ich fahre übers Patio'), 'primary')}${btn('patio_no', t('Nein, kommt nicht in Frage'))}</div></article>`;
  }
  const patioHint = c.patio_route && !c.patio_choice && me === 'blocker'
    ? `<div class="callout info">${t('{name} wird gefragt, ob der Patio-Notweg in Frage kommt. Du kannst trotzdem schon einen Tausch anbieten.', { name: otherName })}</div>` : '';
  if (c.status === 'swap_agreed') {
    return `<article class="conflict ok" id="${anchor}"><h3>${t('Tausch vereinbart mit {name}', { name: otherName })}</h3>
      <p>${t('{a} ↔ {b}: Parkt heute noch um und tippt dann hier.', { a: esc(c.blocker_spot), b: esc(c.blocked_spot) })}</p>
      <div class="row"><button class="btn small good" data-swap="${id}">${t('Getauscht ✓')}</button></div></article>`;
  }
  if (c.status === 'acknowledged') {
    return me === 'blocker'
      ? `<article class="conflict ok" id="${anchor}"><h3>${t('Du lässt {name} raus', { name: otherName })}</h3><p>${t('Zugesagt: Du fährst {when} rechtzeitig zur Seite.', { when: bWhen })}</p><div class="row">${btn('swap', t('Doch lieber heute tauschen'), 'ghost')}</div></article>`
      : `<article class="conflict ok" id="${anchor}"><h3>${t('{name} lässt dich raus', { name: otherName })}</h3><p>${t('{name} fährt {when} rechtzeitig zur Seite.', { name: otherName, when: bWhen })}</p>${meta}<div class="row">${btn('swap', t('Lieber heute tauschen'), 'ghost')}</div></article>`;
  }
  if (theirChoice === 'swap' && !myChoice) {
    return `<article class="conflict" id="${anchor}"><h3>${t('{name} möchte heute Abend tauschen', { name: otherName })}</h3>
      <p>${t(me === 'blocker' ? '{name} muss {b_when} raus, du fährst erst {a_when}.' : 'Du musst {b_when} raus, {name} fährt erst {a_when}.', { name: otherName, b_when: bWhen, a_when: aWhen })}</p>${meta}
      <div class="row">${btn('swap', t('Einverstanden'), 'good')}${me === 'blocker' ? btn('manual', t('Nein, ich fahre zur Seite')) : btn('manual', t('Nein danke'))}</div></article>`;
  }
  if (myChoice === 'swap') {
    return `<article class="conflict" id="${anchor}"><h3>${t('Warte auf {name}', { name: otherName })}</h3>
      <p>${t('Du hast einen Tausch vorgeschlagen ({a} ↔ {b}). {name} sieht den Vorschlag beim nächsten Öffnen.', { a: esc(c.blocker_spot), b: esc(c.blocked_spot), name: otherName })}</p>
      ${me === 'blocker' ? `<div class="row">${btn('manual', t('Doch nicht – ich fahre zur Seite'), 'ghost')}</div>` : ''}</article>`;
  }
  return me === 'blocker'
    ? `<article class="conflict" id="${anchor}"><h3>${t('Du blockierst {name}', { name: otherName })}</h3><p>${t('{name} muss {b_when} raus, du fährst erst {a_when}.', { name: otherName, b_when: `<b>${bWhen}</b>`, a_when: aWhen })}</p>${meta}${patioHint}
        <div class="row">${btn('swap', t('Heute Abend tauschen'), 'primary')}${btn('manual', t('Ich fahre {time} zur Seite', { time: bWhen.split(' ').pop() }))}</div></article>`
    : `<article class="conflict" id="${anchor}"><h3>${t('{name} steht vor dir', { name: otherName })}</h3><p>${t('Du musst {b_when} raus, {name} fährt erst {a_when}.', { b_when: `<b>${bWhen}</b>`, name: otherName, a_when: aWhen })}</p>${meta}
        <div class="row">${btn('swap', t('Tausch vorschlagen'), 'primary')}${myChoice ? '' : btn('manual', t('Wir klären das morgens'))}</div></article>`;
}

/** Hinweise in der Seite statt Push: was ist seit dem letzten Stand neu? */
function notifyChanges(prev, st) {
  if (!prev || !uid) return;
  const prevC = new Set(prev.conflicts.map((c) => c.id));
  const prevR = new Map(prev.leave_requests.map((r) => [r.id + r.role, r]));
  const msgs = [];
  for (const c of st.conflicts) {
    const old = prev.conflicts.find((x) => x.id === c.id);
    if (old?.status === 'patio' && !c.patio_route) msgs.push(t('Patio-Notweg ist versperrt – bitte klärt den Konflikt'));
    if (old && c.role === 'blocker' && old.patio_choice !== 'yes' && c.status === 'patio') msgs.push(t('{name} weicht übers Patio aus – du musst nichts tun', { name: c.blocked_name }));
  }
  for (const c of st.conflicts) if (!prevC.has(c.id)) msgs.push(c.role === 'blocker' ? t('Du blockierst {name} ({spot})', { name: c.blocked_name, spot: c.blocked_spot }) : t('{name} steht vor dir', { name: c.blocker_name }));
  for (const r of st.leave_requests) {
    const old = prevR.get(r.id + r.role);
    if (r.role === 'blocker' && !old) msgs.push(t('🚗 {name} will gleich rausfahren!', { name: r.requester_name }));
    else if (r.role === 'blocker' && old && old.last_pinged_at !== r.last_pinged_at) msgs.push(t('🔔 Erinnerung: {name} wartet', { name: r.requester_name }));
    if (r.role === 'requester' && old) {
      for (const b of r.blockers) {
        const ob = old.blockers.find((x) => x.car_id === b.car_id);
        if (b.response && b.response !== ob?.response) msgs.push(t(b.response === 'coming' ? '{name} kommt sofort' : '{name} braucht noch ~15 Min.', { name: b.name }));
      }
    }
  }
  for (const r of prev.leave_requests) {
    if (r.role === 'requester' && !st.leave_requests.some((x) => x.id === r.id)) {
      const q = R.requests[r.id];
      if (!q || q.status === 'open') msgs.push(t('Weg ist frei 🚗 Du kannst jetzt rausfahren.'));
    }
  }
  if (msgs.length) {
    toast(msgs.join(' · '));
    try { if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(200); } catch { /* nicht verfügbar */ }
  }
  const attention = st.leave_requests.filter((r) => r.role === 'blocker').length + st.conflicts.filter((c) => c.status === 'open').length;
  document.title = attention ? `(${attention}) ${t('Parkplatz')}` : t('Parkplatz');
}

function handleHash() {
  const h = location.hash.slice(1);
  if (!h) return;
  const el = document.getElementById(h);
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); }
}
window.addEventListener('hashchange', handleHash);

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
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

// ── Stellplatz antippen ─────────────────────────────────────────────
function openSpot(spotId) {
  const spot = spotById(spotId);
  selectedSpot = spotId;
  renderBays();
  const o = spot.occupant;
  if (o && myCarIds().has(o.car_id)) return openMyCar(spot);
  if (o) return openOther(spot);
  if (!S.me) return uid || mode === 'demo' ? openOnboarding() : toast(t('Melde dich bei Claude an, um mitzumachen.'), true);
  return myCars().length ? openPark(spot) : openCarEditor();
}

function wayText(spot) {
  const codes = aheadOf(spot.id);
  if (movesFrom(spot.id).includes(null)) return codes.length ? t('direkt oder über {via}', { via: codes.join(' / ') }) : t('direkt');
  return t('über {via}', { via: codes.join(t(' oder ')) });
}
function relationsHtml(spot) {
  const line = (id) => {
    const s = spotById(id), o = s.occupant;
    return `<div class="item"><div class="car-pill" style="--c:${o ? esc(o.color) : 'transparent'};box-shadow:inset 0 0 0 1.5px var(--line)"></div>
      <div class="grow"><b>${esc(s.code)} · ${o ? esc(o.resident_name) : t('frei')}</b>${o ? `<small>${t('fährt {when}', { when: esc(depText(o.next_departure)) })}</small>` : ''}</div></div>`;
  };
  const ahead = aheadOf(spot.id), behind = movesInto(spot.id);
  return `<dl class="kv"><dt>${t('Ausfahrt')}</dt><dd>${esc(wayText(spot))}</dd></dl>`
    + (ahead.length ? `<h3>${t(ahead.length > 1 ? 'Ausfahrt über (einer muss frei sein)' : 'Ausfahrt über')}</h3><div class="list">${ahead.map(line).join('')}</div>` : '')
    + (behind.length ? `<h3>${t('Fährt über diesen Platz raus')}</h3><div class="list">${behind.map(line).join('')}</div>` : '')
    + otherConflictsHtml(spot);
}

/** Offene Konflikte anderer Nachbarn an diesem Platz (graue Linien auf der Grafik). */
function otherConflictsHtml(spot) {
  const list = (S.other_conflicts ?? []).filter((c) => c.blocker_spot === spot.code || c.blocked_spot === spot.code);
  if (!list.length) return '';
  return `<h3>${t('Konflikte anderer hier')}</h3><div class="list">${list.map((c) => `<div class="item"><div class="grow">
      <b>${t('{a_name} ({a_spot}) steht vor {b_name} ({b_spot})', { a_name: esc(c.blocker_name), a_spot: esc(c.blocker_spot), b_name: esc(c.blocked_name), b_spot: esc(c.blocked_spot) })}</b>
      <small>${t('{b_name} muss {b_when} raus, {a_name} fährt erst {a_when}.', { b_name: esc(c.blocked_name), b_when: esc(fmtWhen(c.blocked_departs_at)), a_name: esc(c.blocker_name), a_when: c.blocker_departs_at ? esc(fmtWhen(c.blocker_departs_at)) : t('zu unbekannter Zeit') })}</small></div></div>`).join('')}</div>`;
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
  const iBlock = res.filter((r) => r.blocker === spot.id && !mine.has(occ.get(r.blocked).carId)).map((r) => {
    const o = occ.get(r.blocked).o;
    const others = new Set(occupiedAll); others.delete(r.blocked);
    return { spot: spotById(r.blocked), o, patio: o.patio_pref !== 'never' && !!patioRoute(r.blocked, others) };
  });
  const blockMe = res.filter((r) => r.blocked === spot.id && !mine.has(occ.get(r.blocker).carId)).map((r) => ({ spot: spotById(r.blocker), o: occ.get(r.blocker).o }));
  const reserved = (S.patio_reservations ?? []).filter((r) => r.spots.includes(spot.code) && r.resident_id !== uid);
  return { iBlock, blockMe, reserved, count: iBlock.length + blockMe.length + reserved.length };
}

function openPark(spot) {
  const cars = myCars();
  let car = cars.find((c) => !c.spot_id) || cars[0];
  let mode_ = car.next_departure ? 'auto' : 'custom';
  const body = openSheet(`
    <h2>${t('Auf {spot} parken', { spot: esc(spot.code) })}</h2>
    <p class="sub">${t('{where} · Ausfahrt {way}', { where: spot.kind === 'patio' ? t('Patio-Platz') : esc(t(ZONES.find((z) => z.id === spot.zone_id).name)), way: esc(wayText(spot)) })}</p>
    ${cars.length > 1 ? `<h3>${t('Welches Auto?')}</h3><div class="chips" id="pkCars">${cars.map((c) => `<button class="chip" data-car="${esc(c.id)}">${esc(c.nickname)}</button>`).join('')}</div>` : ''}
    <h3>${t('Wann fährst du als Nächstes?')}</h3>
    <div class="chips" id="pkMode"></div>
    <div id="pkCustom" hidden>
      <label class="field">${t('Datum & Uhrzeit')}<input type="datetime-local" id="pkAt"></label>
      <div class="chips"><button class="chip" data-quick="1h">${t('in 1 Std.')}</button><button class="chip" data-quick="t7">${t('morgen 7:00')}</button><button class="chip" data-quick="t9">${t('morgen 9:00')}</button></div>
    </div>
    <div id="pkImpact"></div>
    <div class="actions"><button class="btn primary block" id="pkGo">${t('Hier geparkt')}</button></div>`);
  const at = $('#pkAt', body);
  at.value = toLocalInput(tomorrowAt(8));
  const depIso = () => (mode_ === 'auto' ? car.next_departure?.at : mode_ === 'custom' && at.value ? new Date(at.value).toISOString() : null);
  function update() {
    $$('#pkCars .chip', body).forEach((b) => b.setAttribute('aria-pressed', b.dataset.car === car.id));
    const modes = [];
    if (car.next_departure) modes.push(['auto', t(car.next_departure.source === 'planned' ? 'Wie geplant · {when}' : 'Wie üblich · {when}', { when: fmtWhen(car.next_departure.at) })]);
    modes.push(['custom', t('Andere Zeit')], ['unknown', t('Weiß ich noch nicht')]);
    if (mode_ === 'auto' && !car.next_departure) mode_ = 'custom';
    $('#pkMode', body).innerHTML = modes.map(([m, l]) => `<button class="chip" data-mode="${m}" aria-pressed="${m === mode_}">${esc(l)}</button>`).join('');
    $$('#pkMode .chip', body).forEach((b) => (b.onclick = () => { mode_ = b.dataset.mode; update(); }));
    $('#pkCustom', body).hidden = mode_ !== 'custom';
    $('#pkGo', body).textContent = car.spot_id && car.spot_id !== spot.id ? t('Von {spot} hierher umparken', { spot: car.spot_id }) : t('Hier geparkt');
    const im = impact(spot, depIso(), car);
    let html = '';
    if (im.iBlock.length) html += `<div class="callout warn">${t('⚠️ Du würdest {who} zuparken.', { who: im.iBlock.map((x) => `<b>${esc(x.o.resident_name)}</b> (${esc(x.spot.code)}, ${t('fährt {when}', { when: esc(fmtWhen(x.o.next_departure.at)) })}${x.patio ? t(', käme nur noch über den Patio-Notweg raus') : ''})`).join(', ') })}</div>`;
    for (const r of im.reserved) html += `<div class="callout warn">${t('⚠️ {name} will {when} über diesen Platz übers Patio raus ({route}). Wenn du hier parkst, ist dieser Notweg zu.', { name: `<b>${esc(r.name)}</b>`, when: esc(fmtWhen(r.at)), route: esc(r.text) })}</div>`;
    if (im.blockMe.length) {
      const who = im.blockMe.map((x) => `<b>${esc(x.o.resident_name)}</b> (${esc(x.spot.code)}, ${t('fährt {when}', { when: esc(fmtWhen(x.o.next_departure?.at)) })})`);
      html += im.blockMe.length === 1 ? `<div class="callout warn">${t('⚠️ {who} steht vor dir.', { who: who[0] })}</div>` : `<div class="callout warn">${t('⚠️ {who} stehen vor dir – einer davon müsste vorher weg.', { who: who.join(t(' und ')) })}</div>`;
    }
    if (mode_ === 'unknown' && movesInto(spot.id).some((id) => spotById(id).occupant)) html += `<div class="callout info">${t('Ohne Ausfahrzeit giltst du für Autos hinter dir als Blockierer.')}</div>`;
    if (im.count) {
      const better = S.spots.filter((s) => !s.occupant && s.id !== spot.id).map((s) => ({ s, n: impact(s, depIso(), car).count })).filter((x) => x.n === 0).sort((a, b) => a.s.grid_y - b.s.grid_y)[0];
      if (better) html += `<div class="callout good">${t('Tipp: Auf {spot} gäbe es keinen Konflikt.', { spot: `<b>${esc(better.s.code)}</b>` })} <button class="btn small ghost" id="pkBetter" data-spot="${esc(better.s.id)}">${t('Dorthin')}</button></div>`;
    } else if (depIso()) html += `<div class="callout good">${t('✓ Kein Konflikt mit deinen Nachbarn.')}</div>`;
    $('#pkImpact', body).innerHTML = html;
    const bb = $('#pkBetter', body); if (bb) bb.onclick = () => openSpot(bb.dataset.spot);
  }
  $$('#pkCars .chip', body).forEach((b) => (b.onclick = () => { car = cars.find((c) => c.id === b.dataset.car); mode_ = car.next_departure ? 'auto' : 'custom'; update(); }));
  $$('[data-quick]', body).forEach((b) => (b.onclick = () => { const q = b.dataset.quick; at.value = toLocalInput(q === '1h' ? new Date(Date.now() + 3600e3) : tomorrowAt(q === 't7' ? 7 : 9)); update(); }));
  at.addEventListener('input', update);
  $('#pkGo', body).onclick = async () => {
    let dep = null;
    if (mode_ === 'custom') { if (!at.value) return toast(t('Bitte eine Uhrzeit wählen'), true); dep = new Date(at.value).toISOString(); }
    await act(() => API.park(car.id, spot.id, dep), t('{car} steht auf {spot}', { car: car.nickname, spot: spot.code }));
    closeSheet();
  };
  update();
}

function openMyCar(spot) {
  const o = spot.occupant;
  const car = myCars().find((c) => c.id === o.car_id);
  const dep = car.next_departure;
  const rec = dep?.source === 'recurring' ? car.recurring.find((r) => (r.label || null) === dep.label) || car.recurring[0] : null;
  const planned = dep?.source === 'planned' ? car.planned.slice().sort((a, b) => a.at.localeCompare(b.at))[0] : null;
  const stuck = blockedNow(spot.id);
  const body = openSheet(`
    <h2>${esc(car.nickname)} · ${esc(spot.code)}</h2>
    <p class="sub">${t('Geparkt {when}', { when: esc(fmtWhen(o.parked_at)) })}</p>
    <dl class="kv"><dt>${t('Nächste Ausfahrt')}</dt><dd><b>${esc(depText(dep))}</b>${dep ? ` <small>(${t(dep.source === 'planned' ? 'einmalig' : 'üblich')})</small>` : ''}</dd></dl>
    <div id="mcExtra" hidden><label class="field">${t('Andere Ausfahrt')}<input type="datetime-local" id="mcAt"></label><button class="btn primary block" id="mcSave">${t('Speichern')}</button></div>
    ${relationsHtml(spot)}
    <div class="actions">
      ${stuck && !myRequest(car.id) ? `<button class="btn primary block" id="mcWantOut">${t('🚗 Ich will gleich rausfahren')}</button>` : ''}
      <button class="btn ${stuck ? '' : 'primary'} block" id="mcLeave">${t('Losgefahren')}</button>
      <button class="btn block" id="mcOther">${t('Andere Ausfahrzeit eintragen')}</button>
      ${rec ? `<button class="btn ghost block" id="mcSkip">${t('Übliche Fahrt {day} fällt aus', { day: esc(fmtWhen(dep.at).replace(/ \S+$/, '')) })}</button>` : ''}
      ${planned ? `<button class="btn ghost block" id="mcDelPlanned">${t('Geplante Fahrt löschen')}</button>` : ''}
    </div>`);
  $('#mcAt', body).value = toLocalInput(tomorrowAt(9));
  $('#mcLeave', body).onclick = () => { closeSheet(); act(() => API.leave(car.id), t('Gute Fahrt! 👋')); };
  const wo = $('#mcWantOut', body); if (wo) wo.onclick = () => { closeSheet(); wantOut(car.id); };
  $('#mcOther', body).onclick = () => { $('#mcExtra', body).hidden = false; $('#mcOther', body).hidden = true; $('#mcAt', body).focus(); };
  $('#mcSave', body).onclick = async () => { await act(() => API.addPlanned(car.id, new Date($('#mcAt', body).value).toISOString()), t('Ausfahrt gespeichert')); closeSheet(); };
  if (rec) $('#mcSkip', body).onclick = async () => { await act(() => API.skipRecurring(car.id, rec.id, localDate(new Date(dep.at))), t('Übliche Fahrt ausgelassen')); closeSheet(); };
  if (planned) $('#mcDelPlanned', body).onclick = async () => { await act(() => API.deletePlanned(car.id, planned.id), t('Gelöscht')); closeSheet(); };
}

function openOther(spot) {
  const o = spot.occupant;
  openSheet(`
    <h2>${esc(spot.code)} · ${esc(o.resident_name)}</h2>
    <p class="sub">${esc(o.nickname)} · ${t('geparkt {when}', { when: esc(fmtWhen(o.parked_at)) })}</p>
    <dl class="kv"><dt>${t('Nächste Ausfahrt')}</dt><dd><b>${esc(depText(o.next_departure))}</b></dd></dl>
    ${relationsHtml(spot)}
    <div class="actions"><button class="btn block" id="otClose">${t('Schließen')}</button></div>`);
  $('#otClose').onclick = closeSheet;
}

// ── Profil ──────────────────────────────────────────────────────────
function openProfile() {
  if (!S.me) return uid || mode === 'demo' ? openOnboarding() : toast(t('Melde dich bei Claude an, um mitzumachen.'), true);
  const me = S.me;
  const body = openSheet(`
    <h2>${t('Hallo {name}', { name: esc(me.display_name) })}</h2>
    <p class="sub">${me.unit ? esc(t(me.unit)) : t('Dein Profil')}</p>
    <label class="field">${t('Name')}<input type="text" id="pfName" value="${esc(me.display_name)}" maxlength="40"></label>
    <label class="field">${t('Wohnung / Klingel')}<input type="text" id="pfUnit" value="${esc(me.unit ?? '')}" maxlength="30"></label>
    <button class="btn block" id="pfSave">${t('Speichern')}</button>
    <h3>${t('Sprache')}${LANG === 'en' ? '' : ' · Language'}</h3>
    <div class="chips" id="pfLang">${LANGS.map((l) => `<button class="chip" data-lang="${l}" aria-pressed="${LANG === l}">${LANG_NAMES[l]}</button>`).join('')}</div>
    <h3>${t('Deine Autos')}</h3>
    <div class="list">${myCars().map((c) => `
      <button class="item" style="border:0;text-align:left;cursor:pointer" data-car="${esc(c.id)}">
        <div class="car-pill" style="--c:${esc(c.color)}"></div>
        <div class="grow"><b>${esc(c.nickname)}</b>${c.plate ? ` <small style="display:inline">${esc(c.plate)}</small>` : ''}
          <small>${c.recurring.length ? c.recurring.map((r) => `${fmtDays(r.weekdays)} ${r.time}`).join(' · ') : t('Keine übliche Ausfahrzeit')}</small></div>
        <span style="color:var(--muted)">›</span></button>`).join('')}</div>
    <button class="btn ghost block" id="pfAddCar">${t('+ Auto hinzufügen')}</button>
    <h3>${t('Benachrichtigungen')}</h3>
    <p class="hint">${t('Diese Version der App kann keine Push-Nachrichten schicken. Solange die Seite offen ist, siehst du neue Konflikte und Anfragen sofort, und der Tab-Titel zeigt die Anzahl.')}</p>
    ${mode === 'demo' ? `<h3>${t('Demo')}</h3>
    <p class="hint">${t('Das ist eine Demo: Die Nachbarn sind Beispiele, und was du einträgst, bleibt nur in diesem Fenster. Lädst du die Seite neu, beginnt die Demo von vorn.')}</p>` : `<h3>${t('Nachbarn einladen')}</h3>
    <p class="hint">${t('Teile diese Seite über „Teilen“ mit deinen Nachbarn. Damit sie parken und antworten können, brauchen sie Bearbeitungsrechte, sonst können sie nur zuschauen.')}</p>`}`);
  $('#pfSave', body).onclick = () => act(() => API.updateMe({ display_name: $('#pfName', body).value, unit: $('#pfUnit', body).value }), t('Gespeichert'));
  $$('#pfLang .chip', body).forEach((b) => (b.onclick = () => { if (b.dataset.lang !== LANG) { setLang(b.dataset.lang); location.reload(); } }));
  $$('[data-car]', body).forEach((b) => (b.onclick = () => openCarEditor(myCars().find((c) => c.id === b.dataset.car))));
  $('#pfAddCar', body).onclick = () => openCarEditor();
}
$('#profileBtn').addEventListener('click', () => openProfile());

function openCarEditor(car = null, { onDone, step } = {}) {
  let color = car?.color || COLORS[myCars().length % COLORS.length];
  let days = 31, confirmDelete = false;
  const body = openSheet(`${step ? steps(step) : ''}
    <h2>${car ? esc(car.nickname) : t('Neues Auto')}</h2>
    <p class="sub">${car ? t('Auto & Ausfahrzeiten') : t('So erkennen dich die Nachbarn auf dem Parkplatz.')}</p>
    <label class="field">${t('Name des Autos')}<input type="text" id="ceName" placeholder="${t('z. B. Roter Golf')}" value="${esc(car?.nickname ?? '')}" maxlength="30"></label>
    <label class="field">${t('Kennzeichen (optional)')}<input type="text" id="cePlate" placeholder="HS-AB 123" value="${esc(car?.plate ?? '')}" maxlength="15"></label>
    <div class="field" style="margin-bottom:4px">${t('Farbe')}</div>
    <div class="swatches" id="ceColors">${COLORS.map((c) => `<button style="--c:${c}" data-c="${c}" aria-label="${t('Farbe {c}', { c })}"></button>`).join('')}</div>
    <button class="btn primary block" id="ceSave">${car ? t('Speichern') : t('Auto anlegen')}</button>
    ${car ? `
      <h3>${t('Übliche Ausfahrzeiten')}</h3>
      <div class="list">${car.recurring.map((r) => `<div class="item"><div class="grow"><b>${fmtDays(r.weekdays)} · ${esc(r.time)}</b>${r.label ? `<small>${esc(r.label)}</small>` : ''}
          ${(r.skips || []).length ? `<small>${t('Fällt aus: {dates}', { dates: r.skips.map((d) => `${fmtDay(99, (new Date(d).getUTCDay() + 6) % 7, +d.slice(8), +d.slice(5, 7))} <a href="#" data-unskip="${esc(r.id)}|${esc(d)}" style="color:var(--accent-2)">${t('rückgängig')}</a>`).join(', ') })}</small>` : ''}</div>
          <button class="x" data-delrec="${esc(r.id)}" aria-label="${t('Löschen')}">×</button></div>`).join('') || `<p class="hint">${t('Noch keine – z. B. Mo–Fr 07:30 zur Arbeit.')}</p>`}</div>
      <div class="days" id="ceDays">${WD.map((d, i) => `<button class="chip" data-d="${i}">${d}</button>`).join('')}</div>
      <div class="row" style="flex-wrap:nowrap"><input type="time" id="ceTime" value="07:30" style="flex:1"><input type="text" id="ceLabel" placeholder="${t('Anlass (Arbeit)')}" maxlength="30" style="flex:1.4"></div>
      <button class="btn block" id="ceAddRec" style="margin-top:8px">${t('+ Übliche Zeit hinzufügen')}</button>
      <h3>${t('Einmalige Ausfahrten')}</h3>
      <div class="list">${car.planned.map((p) => `<div class="item"><div class="grow"><b>${esc(fmtWhen(p.at))}</b>${p.note ? `<small>${esc(p.note)}</small>` : ''}</div>
          <button class="x" data-delplan="${esc(p.id)}" aria-label="${t('Löschen')}">×</button></div>`).join('') || `<p class="hint">${t('Keine geplant.')}</p>`}</div>
      <div class="row" style="flex-wrap:nowrap"><input type="datetime-local" id="cePlanAt" style="flex:1.4"><input type="text" id="cePlanNote" placeholder="${t('Notiz')}" maxlength="40" style="flex:1"></div>
      <button class="btn block" id="ceAddPlan" style="margin-top:8px">${t('+ Einmalige Ausfahrt')}</button>
      <h3>${t('Patio-Notweg')}</h3>
      <p class="hint">${t('Rückwärts aufs schmale Patio rangieren und darüber rausfahren. Die App schlägt das nur als Notlösung vor und fragt dich jedes Mal vorher.')}</p>
      <div class="chips" id="cePatio">
        <button class="chip" data-p="ask" aria-pressed="${car.patio_route !== 'never'}">${t('Bei Bedarf fragen')}</button>
        <button class="chip" data-p="never" aria-pressed="${car.patio_route === 'never'}">${t('Kommt nie in Frage')}</button>
      </div>
      <div class="actions"><button class="btn danger block" id="ceDel">${t('Auto entfernen')}</button></div>` : ''}`);
  const paint = () => {
    $$('#ceColors button', body).forEach((b) => b.setAttribute('aria-pressed', b.dataset.c === color));
    $$('#ceDays .chip', body).forEach((b) => b.setAttribute('aria-pressed', !!(days & (1 << b.dataset.d))));
  };
  $$('#ceColors button', body).forEach((b) => (b.onclick = () => { color = b.dataset.c; paint(); }));
  $$('#ceDays .chip', body).forEach((b) => (b.onclick = () => { days ^= 1 << b.dataset.d; paint(); }));
  paint();
  const reopen = () => setTimeout(() => openCarEditor(buildState().me.cars.find((c) => c.id === car.id)), 60);
  $('#ceSave', body).onclick = async () => {
    const data = { nickname: $('#ceName', body).value, plate: $('#cePlate', body).value, color };
    const r = await act(() => API.saveCar(car?.id, data), t(car ? 'Gespeichert' : 'Auto angelegt'));
    if (car) return reopen();
    setTimeout(() => (onDone ? onDone(r.id) : openCarEditor(buildState().me.cars.find((c) => c.id === r.id))), 60);
  };
  if (!car) return;
  $('#cePlanAt', body).value = toLocalInput(tomorrowAt(10));
  $('#ceAddRec', body).onclick = async () => { await act(() => API.addRecurring(car.id, { weekdays: days, time: $('#ceTime', body).value, label: $('#ceLabel', body).value }), t('Hinzugefügt')); reopen(); };
  $('#ceAddPlan', body).onclick = async () => {
    const v = $('#cePlanAt', body).value;
    if (!v) return toast(t('Bitte Datum wählen'), true);
    await act(() => API.addPlanned(car.id, new Date(v).toISOString(), $('#cePlanNote', body).value), t('Hinzugefügt')); reopen();
  };
  $$('#cePatio .chip', body).forEach((b) => (b.onclick = async () => { await act(() => API.setPatioPref(car.id, b.dataset.p), t('Gespeichert')); reopen(); }));
  $$('[data-delrec]', body).forEach((b) => (b.onclick = async () => { await act(() => API.deleteRecurring(car.id, b.dataset.delrec)); reopen(); }));
  $$('[data-delplan]', body).forEach((b) => (b.onclick = async () => { await act(() => API.deletePlanned(car.id, b.dataset.delplan)); reopen(); }));
  $$('[data-unskip]', body).forEach((a) => (a.onclick = async (e) => { e.preventDefault(); const [r, d] = a.dataset.unskip.split('|'); await act(() => API.skipRecurring(car.id, r, d, true)); reopen(); }));
  $('#ceDel', body).onclick = async () => {
    if (!confirmDelete) { confirmDelete = true; $('#ceDel', body).textContent = t('{car} wirklich entfernen? Nochmal tippen', { car: car.nickname }); return; }
    await act(() => API.deleteCar(car.id), t('Entfernt')); closeSheet();
  };
}

// ── Onboarding ──────────────────────────────────────────────────────
function steps(n) { return `<div class="steps">${[1, 2, 3].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>`; }
async function openOnboarding() {
  if (S.me) return;
  const suggested = mode === 'demo' ? '' : (await userApi?.name?.()) || '';
  const body = openSheet(`${steps(1)}
    <h2>${t('Willkommen auf dem Parkplatz 👋')}</h2>
    <p class="sub">${t('Trag ein, wo du stehst und wann du losfährst. Die App zeigt dir, wenn ihr euch zuparkt.')}</p>
    <label class="field">${t('Dein Name, wie ihn die Nachbarn sehen')}<input type="text" id="obName" placeholder="${t('z. B. Anna')}" maxlength="40" value="${esc(suggested.split(' ')[0])}"></label>
    <label class="field">${t('Wohnung / Klingel (optional)')}<input type="text" id="obUnit" placeholder="${t('z. B. 2. OG links')}" maxlength="30"></label>
    <div class="actions"><button class="btn primary block" id="obGo">${t('Weiter')}</button></div>`);
  $('#obGo', body).onclick = async () => {
    await act(() => API.register({ display_name: $('#obName', body).value, unit: $('#obUnit', body).value }));
    setTimeout(() => openCarEditor(null, { onDone: onboardRoutine, step: 2 }), 60);
  };
}
function onboardRoutine(carId) {
  let days = 31;
  const body = openSheet(`${steps(3)}
    <h2>${t('Wann fährst du normalerweise los?')}</h2>
    <p class="sub">${t('Zum Beispiel morgens zur Arbeit. Das kannst du später jederzeit ändern.')}</p>
    <div class="days" id="obDays">${WD.map((d, i) => `<button class="chip" data-d="${i}">${d}</button>`).join('')}</div>
    <label class="field">${t('Uhrzeit')}<input type="time" id="obTime" value="07:30"></label>
    <label class="field">${t('Anlass')}<input type="text" id="obLabel" value="${t('Arbeit')}" maxlength="30"></label>
    <div class="actions"><button class="btn primary block" id="obSave">${t('Speichern')}</button><button class="btn ghost block" id="obSkip">${t('Keine feste Zeit')}</button></div>`);
  const paint = () => $$('#obDays .chip', body).forEach((b) => b.setAttribute('aria-pressed', !!(days & (1 << b.dataset.d))));
  $$('#obDays .chip', body).forEach((b) => (b.onclick = () => { days ^= 1 << b.dataset.d; paint(); }));
  paint();
  const done = () => { closeSheet(); toast(t('Fertig! Tippe auf deinen Stellplatz.')); };
  $('#obSave', body).onclick = async () => { await act(() => API.addRecurring(carId, { weekdays: days, time: $('#obTime', body).value, label: $('#obLabel', body).value })); done(); };
  $('#obSkip', body).onclick = done;
}

// ── Start ───────────────────────────────────────────────────────────
function seedDemo() {
  const now = Date.now(), ago = iso(now - 2 * 3600e3);
  const mk = (id, name, unit, car, color, routine, planned) => {
    R.residents[id] = { display_name: name, unit, cars: [{ id: `car-${id}`, nickname: car, plate: '', color, active: true, recurring: routine ? [{ id: `r-${id}`, ...routine, skips: [] }] : [], planned: planned ? [planned] : [] }] };
  };
  mk('demo-anna', 'Anna', t('EG links'), 'Polo', '#ff6b5b', { weekdays: 127, time: '09:00', label: t('Arbeit') });
  mk('demo-katia', 'Katia', t('EG rechts'), 'Chirey', '#e9ecf2', { weekdays: 127, time: '07:00', label: t('Arbeit') });
  mk('demo-clara', 'Clara', t('1. OG'), 'Mini', '#ffb547', { weekdays: 127, time: '08:15', label: t('Schule') });
  mk('demo-deniz', 'Deniz', t('2. OG'), 'Tesla', '#7c8594', null, { id: 'p1', at: iso(now + 30 * 3600e3), note: t('Ausflug') });
  mk('demo-emil', 'Emil', t('2. OG'), 'Kombi', '#b57cff', { weekdays: 127, time: '06:30', label: t('Frühschicht') });
  mk('demo-fabian', 'Fabian', t('1. OG'), 'Fiat', '#2ec4d6', { weekdays: 127, time: '07:45', label: t('Arbeit') });
  mk('demo-greta', 'Greta', t('EG links'), 'Smart', '#ff7ab6', { weekdays: 127, time: '10:00', label: t('Arbeit') });
  const park = (spot, who) => { R.spots[spot] = { car_id: `car-${who}`, resident_id: who, parked_at: ago }; };
  // Katia (du) steht auf R2 hinter Deniz (R1), der erst übermorgen fährt → Konflikt mit Patio-Notweg als Beispiel
  // Links wird üblicherweise L1 → L2 → L3 → L5 → L7 aufgefüllt, L4 und L6 erst zuletzt
  park('L1', 'demo-anna'); park('L2', 'demo-fabian'); park('L3', 'demo-clara'); park('L5', 'demo-greta'); park('R2', 'demo-katia'); park('R1', 'demo-deniz'); park('R3', 'demo-emil');
  uid = 'demo-katia';   // in der Demo bist du Katia (weißer Chirey)
}

async function start() {
  translateStatic();
  render();
  const use = window.claude?.use?.bind(window.claude);
  const [dbNs, userNs] = use ? await Promise.all([use('db'), use('user')]) : [null, null];
  userApi = userNs;
  if (!dbNs) {
    mode = 'demo'; seedDemo(); loadedOnce = true; render();
    return;
  }
  db = dbNs;
  uid = (await userNs?.id?.()) ?? null;
  canWrite = (await userNs?.can?.('data.write')) ?? null;
  if (canWrite === false) readOnly = true;
  mode = 'db';
  const pending = new Set(['residents', 'spots', 'decisions', 'requests']);
  const slow = setTimeout(() => { if (pending.size) { mode = 'slow'; render(); } }, 10000);
  for (const coll of pending) {
    db.collection(coll).onSnapshot((snap) => {
      R[coll] = Object.fromEntries(snap.docs.filter((d) => d.exists).map((d) => [d.id, d.data()]));
      if (!snap.metadata.fromCache && pending.delete(coll) && !pending.size) {
        clearTimeout(slow);
        if (mode === 'slow') mode = 'db';
        setTimeout(() => { loadedOnce = true; if (!R.residents[uid] && uid && !readOnly) openOnboarding(); }, 900);
      }
      render();
    }, () => { clearTimeout(slow); mode = 'slow'; render(); });
  }
}
// Zeit vergeht: Konflikte und Ausfahrzeiten jede Minute neu bewerten
setInterval(() => { if (S) render(); }, 60e3);
start();
