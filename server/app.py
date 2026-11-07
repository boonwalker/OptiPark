"""HTTP-Server: JSON-API unter /api, statische Dateien aus /web.

Start:  .venv.nosync/bin/python -m server.app   (Port über PARK_PORT, Standard 8080)
"""
import json
import logging
import mimetypes
import os
import re
import secrets
import threading
import time
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import conflicts, db, i18n, leave_requests, push, rules
from .db import iso, parse_iso, utcnow
from .departures import next_departures

WEB_DIR = db.ROOT / "web"
INVITE_CODE = os.environ.get("PARK_INVITE_CODE")   # optional: Registrierung nur mit Code
TICK_SECONDS = 60
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
TIME_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

log = logging.getLogger("app")


class ApiError(Exception):
    """message ist der deutsche Text (mit {platzhaltern}); übersetzt wird beim Antworten."""
    def __init__(self, status, message, **values):
        super().__init__(message)
        self.status, self.message, self.values = status, message, values


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

ROUTES = []


def route(method, pattern, auth=True):
    regex = re.compile("^" + re.sub(r"<(\w+)>", r"(?P<\1>[^/]+)", pattern) + "$")

    def deco(fn):
        ROUTES.append((method, regex, fn, auth))
        return fn
    return deco


def mutation(fn):
    """Führt fn in einer Transaktion aus, berechnet danach Konflikte neu und
    verschickt Benachrichtigungen erst nach dem Commit."""
    def wrapper(ctx, **kw):
        now = utcnow()
        with db.tx() as conn:
            ctx["conn"], ctx["now"] = conn, now
            result = fn(ctx, **kw)
            notes = ctx.pop("notes", []) + housekeeping(conn, now)
            db.bump_version(conn)
        push.send_async(notes)
        return result
    wrapper.__name__ = fn.__name__
    return wrapper


def housekeeping(conn, now):
    """Nach jeder Änderung und jede Minute: Konflikte und Rausfahr-Anfragen nachziehen."""
    return conflicts.recompute(conn, now) + leave_requests.reconcile(conn, now)


def require(cond, status, message, **values):
    if not cond:
        raise ApiError(status, message, **values)


def own_car(ctx, car_id):
    car = ctx["conn"].execute("SELECT * FROM car WHERE id = ? AND active = 1", (car_id,)).fetchone()
    require(car and car["resident_id"] == ctx["me"]["id"], 404, "Auto nicht gefunden")
    return car


def text(body, key, max_len=60, required=False):
    v = (body.get(key) or "").strip()
    require(v or not required, 400, "„{key}“ fehlt", key=key)
    return v[:max_len] or None


# ---------------------------------------------------------------------------
# Lesen
# ---------------------------------------------------------------------------

@route("GET", "/api/version", auth=False)
def get_version(ctx):
    with db.read() as conn:
        return {"version": int(conn.execute("SELECT value FROM meta WHERE key='version'").fetchone()[0])}


@route("GET", "/api/state", auth=False)
def get_state(ctx):
    now = utcnow()
    me = ctx["me"]
    with db.read() as conn:
        version = int(conn.execute("SELECT value FROM meta WHERE key='version'").fetchone()[0])
        lot = dict(conn.execute("SELECT name, timezone, grid_w, grid_h FROM lot LIMIT 1").fetchone())
        zones = [dict(r) for r in conn.execute("SELECT id, code, name, grid_x, grid_y, grid_w, grid_h FROM zone")]
        spots = [dict(r) for r in conn.execute(
            "SELECT id, zone_id, code, kind, grid_x, grid_y, grid_w, grid_h FROM spot WHERE active = 1 ORDER BY code")]
        exits = [list(r) for r in conn.execute("SELECT from_spot_id, to_spot_id FROM spot_exit ORDER BY id")]
        occ = conn.execute("""
            SELECT p.id AS parking_id, p.spot_id, p.parked_at, c.id AS car_id, c.nickname, c.color, c.patio_route,
                   r.id AS resident_id, r.display_name AS resident_name
            FROM parking p JOIN car c ON c.id = p.car_id JOIN resident r ON r.id = c.resident_id
            WHERE p.left_at IS NULL""").fetchall()

        my_cars = []
        if me:
            my_cars = [dict(r) for r in conn.execute(
                "SELECT id, nickname, plate, color, patio_route FROM car WHERE resident_id = ? AND active = 1 ORDER BY id",
                (me["id"],))]
        nd = next_departures(conn, list({o["car_id"] for o in occ} | {c["id"] for c in my_cars}), now)

        def dep(car_id):
            d = nd.get(car_id)
            return {"at": iso(d["at"]), "source": d["source"], "label": d["label"]} if d else None

        by_spot = {}
        for o in occ:
            entry = {"parking_id": o["parking_id"], "car_id": o["car_id"], "color": o["color"],
                     "patio_route": o["patio_route"],
                     "parked_at": o["parked_at"], "next_departure": dep(o["car_id"])}
            if me:  # Namen nur für angemeldete Nachbarn
                entry.update(nickname=o["nickname"], resident_id=o["resident_id"],
                             resident_name=o["resident_name"])
            by_spot[o["spot_id"]] = entry
        for s in spots:
            s["occupant"] = by_spot.get(s["id"])

        result = {"version": version, "now": iso(now), "lot": lot, "zones": zones, "spots": spots,
                  "exits": exits, "horizon_hours": conflicts.HORIZON.total_seconds() / 3600,
                  "me": None, "conflicts": [], "other_conflicts": [], "leave_requests": [], "patio_reservations": [],
                  "push": {"public_key": push.public_key()}, "invite_required": bool(INVITE_CODE)}
        if not me:
            return result

        parked = {o["car_id"]: o["spot_id"] for o in occ}
        moves, patios = rules.graph(conn), rules.patio_spots(conn)
        codes = {sp["id"]: sp["code"] for sp in spots}
        for c in my_cars:
            c["spot_id"] = parked.get(c["id"])
            c["next_departure"] = dep(c["id"])
            # Patio-Notweg jetzt (für „Ich will gleich rausfahren“): nur wenn frei und erwünscht
            c["patio_now"] = None
            if c["spot_id"] and c["patio_route"] != "never":
                r = rules.patio_route(moves, c["spot_id"], set(parked.values()) - {c["spot_id"]}, patios)
                if r:
                    c["patio_now"] = {k: [codes[s] for s in v] for k, v in r.items()}
            c["recurring"] = [dict(r) for r in conn.execute(
                "SELECT id, weekdays, depart_time, label FROM recurring_departure WHERE car_id = ? AND active = 1 ORDER BY depart_time",
                (c["id"],))]
            for r in c["recurring"]:
                r["skips"] = [s[0] for s in conn.execute(
                    "SELECT skip_date FROM recurring_skip WHERE recurring_departure_id = ? AND skip_date >= date('now','-1 day') ORDER BY skip_date",
                    (r["id"],))]
            c["planned"] = [dict(r) for r in conn.execute(
                "SELECT id, depart_at, note FROM planned_departure WHERE car_id = ? AND depart_at > ? ORDER BY depart_at",
                (c["id"], iso(now)))]
        result["me"] = {"id": me["id"], "display_name": me["display_name"], "unit": me["unit"], "lang": me["lang"],
                        "cars": my_cars,
                        "push_subscriptions": conn.execute(
                            "SELECT COUNT(*) FROM push_subscription WHERE resident_id = ?", (me["id"],)).fetchone()[0]}

        ids = [r[0] for r in conn.execute(f"""
            SELECT c.id FROM conflict c
            JOIN parking pa ON pa.id = c.blocker_parking_id JOIN car ca ON ca.id = pa.car_id
            JOIN parking pb ON pb.id = c.blocked_parking_id JOIN car cb ON cb.id = pb.car_id
            WHERE c.status IN ({','.join('?' * len(conflicts.ACTIVE))})
              AND (ca.resident_id = ? OR cb.resident_id = ?)
            ORDER BY c.blocked_departs_at""", (*conflicts.ACTIVE, me["id"], me["id"]))]
        for cid in ids:
            d = dict(conflicts.conflict_details(conn, cid))
            d["role"] = "blocker" if d["blocker_resident_id"] == me["id"] else "blocked"
            d["patio_text"] = conflicts.fmt_route(d["patio_route"], ctx["lang"])
            result["conflicts"].append(d)
        # Offene Konflikte anderer Nachbarn: nur zur Anzeige auf der Grafik (graue Linie)
        result["other_conflicts"] = []
        for (cid,) in conn.execute(f"""
                SELECT c.id FROM conflict c
                JOIN parking pa ON pa.id = c.blocker_parking_id JOIN car ca ON ca.id = pa.car_id
                JOIN parking pb ON pb.id = c.blocked_parking_id JOIN car cb ON cb.id = pb.car_id
                WHERE c.status = 'open' AND ca.resident_id != ? AND cb.resident_id != ?
                ORDER BY c.blocked_departs_at""", (me["id"], me["id"])).fetchall():
            d = conflicts.conflict_details(conn, cid)
            result["other_conflicts"].append({k: d[k] for k in (
                "blocker_spot", "blocker_name", "blocker_departs_at", "blocked_spot", "blocked_name", "blocked_departs_at")})
        result["leave_requests"] = leave_requests.for_resident(conn, me["id"], now)
        # Zugesagte Patio-Notwege: wer hier parkt, versperrt sie
        result["patio_reservations"] = []
        for r in conn.execute("""
                SELECT c.patio_route, c.blocked_departs_at, rb.id AS resident_id, rb.display_name AS name, sb.code AS spot
                FROM conflict c JOIN parking pb ON pb.id = c.blocked_parking_id
                JOIN car cb ON cb.id = pb.car_id JOIN resident rb ON rb.id = cb.resident_id
                JOIN spot sb ON sb.id = pb.spot_id
                WHERE c.status = 'patio'"""):
            route = json.loads(r["patio_route"])
            result["patio_reservations"].append({"resident_id": r["resident_id"], "name": r["name"], "from_spot": r["spot"], "at": r["blocked_departs_at"],
                                                 "spots": route["reverse"] + route["forward"],
                                                 "text": conflicts.fmt_route(route, ctx["lang"])})
        return result


# ---------------------------------------------------------------------------
# Nachbarn & Autos
# ---------------------------------------------------------------------------

@route("POST", "/api/register", auth=False)
@mutation
def register(ctx):
    body = ctx["body"]
    if INVITE_CODE:
        require(body.get("invite_code") == INVITE_CODE, 403, "Einladungscode stimmt nicht")
    name = text(body, "display_name", 40, required=True)
    token = secrets.token_urlsafe(24)
    lot_id = ctx["conn"].execute("SELECT id FROM lot LIMIT 1").fetchone()[0]
    rid = ctx["conn"].execute(
        "INSERT INTO resident(lot_id, display_name, unit, auth_token, lang) VALUES (?,?,?,?,?)",
        (lot_id, name, text(body, "unit", 30), token, i18n.norm(body.get("lang") or ctx["lang"]))).lastrowid
    return {"id": rid, "token": token}


@route("PATCH", "/api/me")
@mutation
def update_me(ctx):
    b = ctx["body"]
    if "lang" in b:   # nur die Sprache ändern (die App gleicht sie beim Start ab)
        require(b["lang"] in i18n.LANGS, 400, "Ungültige Sprache")
        ctx["conn"].execute("UPDATE resident SET lang = ? WHERE id = ?", (b["lang"], ctx["me"]["id"]))
    if "display_name" in b or "unit" in b:
        ctx["conn"].execute("UPDATE resident SET display_name = COALESCE(?, display_name), unit = ? WHERE id = ?",
                            (text(b, "display_name", 40), text(b, "unit", 30), ctx["me"]["id"]))
    return {"ok": True}


def _car_fields(b):
    color = b.get("color") or "#4f7cff"
    require(HEX_COLOR.match(color), 400, "Ungültige Farbe")
    return text(b, "nickname", 30, required=True), text(b, "plate", 15), color


@route("POST", "/api/cars")
@mutation
def create_car(ctx):
    nickname, plate, color = _car_fields(ctx["body"])
    cid = ctx["conn"].execute("INSERT INTO car(resident_id, nickname, plate, color) VALUES (?,?,?,?)",
                              (ctx["me"]["id"], nickname, plate, color)).lastrowid
    return {"id": cid}


@route("PATCH", "/api/cars/<car_id>")
@mutation
def update_car(ctx, car_id):
    own_car(ctx, car_id)
    b = ctx["body"]
    if set(b) == {"patio_route"}:   # nur die Notweg-Einstellung ändern
        require(b["patio_route"] in ("ask", "never"), 400, "Ungültige Einstellung")
        ctx["conn"].execute("UPDATE car SET patio_route=? WHERE id=?", (b["patio_route"], car_id))
        return {"ok": True}
    nickname, plate, color = _car_fields(b)
    ctx["conn"].execute("UPDATE car SET nickname=?, plate=?, color=? WHERE id=?", (nickname, plate, color, car_id))
    return {"ok": True}


@route("DELETE", "/api/cars/<car_id>")
@mutation
def delete_car(ctx, car_id):
    own_car(ctx, car_id)
    ctx["conn"].execute("UPDATE parking SET left_at=? WHERE car_id=? AND left_at IS NULL", (iso(ctx["now"]), car_id))
    ctx["conn"].execute("UPDATE car SET active = 0 WHERE id = ?", (car_id,))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Ausfahrzeiten
# ---------------------------------------------------------------------------

@route("POST", "/api/cars/<car_id>/recurring")
@mutation
def add_recurring(ctx, car_id):
    own_car(ctx, car_id)
    b = ctx["body"]
    weekdays, t = int(b.get("weekdays") or 0), b.get("depart_time") or ""
    require(1 <= weekdays <= 127, 400, "Mindestens einen Wochentag wählen")
    require(TIME_HHMM.match(t), 400, "Uhrzeit als HH:MM angeben")
    rid = ctx["conn"].execute(
        "INSERT INTO recurring_departure(car_id, weekdays, depart_time, label) VALUES (?,?,?,?)",
        (car_id, weekdays, t, text(b, "label", 30))).lastrowid
    return {"id": rid}


def _own_recurring(ctx, rid):
    r = ctx["conn"].execute("SELECT car_id FROM recurring_departure WHERE id = ?", (rid,)).fetchone()
    require(r, 404, "Nicht gefunden")
    own_car(ctx, r["car_id"])


@route("DELETE", "/api/recurring/<rid>")
@mutation
def delete_recurring(ctx, rid):
    _own_recurring(ctx, rid)
    ctx["conn"].execute("DELETE FROM recurring_departure WHERE id = ?", (rid,))
    return {"ok": True}


@route("POST", "/api/recurring/<rid>/skip")
@mutation
def skip_recurring(ctx, rid):
    _own_recurring(ctx, rid)
    date = ctx["body"].get("date") or ""
    require(re.match(r"^\d{4}-\d{2}-\d{2}$", date), 400, "Datum als JJJJ-MM-TT angeben")
    ctx["conn"].execute("INSERT OR IGNORE INTO recurring_skip VALUES (?, ?)", (rid, date))
    return {"ok": True}


@route("DELETE", "/api/recurring/<rid>/skip/<date>")
@mutation
def unskip_recurring(ctx, rid, date):
    _own_recurring(ctx, rid)
    ctx["conn"].execute("DELETE FROM recurring_skip WHERE recurring_departure_id=? AND skip_date=?", (rid, date))
    return {"ok": True}


def _insert_planned(ctx, car_id, depart_at_str, note=None):
    at = parse_iso(depart_at_str)
    require(at and at > ctx["now"], 400, "Ausfahrzeit muss in der Zukunft liegen")
    return ctx["conn"].execute("INSERT INTO planned_departure(car_id, depart_at, note) VALUES (?,?,?)",
                               (car_id, iso(at), note)).lastrowid


@route("POST", "/api/cars/<car_id>/planned")
@mutation
def add_planned(ctx, car_id):
    own_car(ctx, car_id)
    return {"id": _insert_planned(ctx, car_id, ctx["body"].get("depart_at"), text(ctx["body"], "note", 40))}


@route("DELETE", "/api/planned/<pid>")
@mutation
def delete_planned(ctx, pid):
    r = ctx["conn"].execute("SELECT car_id FROM planned_departure WHERE id = ?", (pid,)).fetchone()
    require(r, 404, "Nicht gefunden")
    own_car(ctx, r["car_id"])
    ctx["conn"].execute("DELETE FROM planned_departure WHERE id = ?", (pid,))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Parken
# ---------------------------------------------------------------------------

@route("POST", "/api/park")
@mutation
def park(ctx):
    b, conn, now = ctx["body"], ctx["conn"], ctx["now"]
    car_id = b.get("car_id")
    own_car(ctx, car_id)
    spot = conn.execute("SELECT id FROM spot WHERE id = ? AND active = 1", (b.get("spot_id"),)).fetchone()
    require(spot, 404, "Stellplatz nicht gefunden")
    taken = conn.execute("SELECT car_id FROM parking WHERE spot_id = ? AND left_at IS NULL", (spot["id"],)).fetchone()
    require(not taken or taken["car_id"] == int(car_id), 409, "Der Platz ist schon belegt")
    if not taken:
        conn.execute("UPDATE parking SET left_at = ? WHERE car_id = ? AND left_at IS NULL", (iso(now), car_id))
        conn.execute("INSERT INTO parking(car_id, spot_id, parked_at) VALUES (?,?,?)", (car_id, spot["id"], iso(now)))
    if b.get("depart_at"):  # optional gleich die nächste Ausfahrt mitgeben
        _insert_planned(ctx, car_id, b["depart_at"], text(b, "note", 40))
    return {"ok": True}


@route("POST", "/api/leave")
@mutation
def leave(ctx):
    car_id = ctx["body"].get("car_id")
    own_car(ctx, car_id)
    ctx["conn"].execute("UPDATE parking SET left_at = ? WHERE car_id = ? AND left_at IS NULL",
                        (iso(ctx["now"]), car_id))
    # Erledigte einmalige Ausfahrten der nächsten Stunde gelten als gefahren
    ctx["conn"].execute("DELETE FROM planned_departure WHERE car_id = ? AND depart_at <= ?",
                        (car_id, iso(ctx["now"] + timedelta(hours=1))))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Konflikte
# ---------------------------------------------------------------------------

def _my_conflict(ctx, cid):
    d = conflicts.conflict_details(ctx["conn"], cid)
    require(d and d["status"] in conflicts.ACTIVE, 404, "Konflikt nicht (mehr) aktiv")
    me = ctx["me"]["id"]
    roles = [r for r in ("blocker", "blocked") if d[f"{r}_resident_id"] == me]
    require(roles, 403, "Nicht dein Konflikt")
    return d, roles


@route("POST", "/api/conflicts/<cid>/choice")
@mutation
def conflict_choice(ctx, cid):
    """choice: swap | manual (Tausch / zur Seite fahren), patio_yes | patio_no (Bs Antwort zum Notweg)."""
    choice = ctx["body"].get("choice")
    require(choice in ("swap", "manual", "patio_yes", "patio_no"), 400, "Ungültige Auswahl")
    d, roles = _my_conflict(ctx, cid)
    conn = ctx["conn"]
    if choice.startswith("patio_"):
        require("blocked" in roles and d["patio_route"], 409, "Der Patio-Notweg steht hier nicht zur Wahl")
        conn.execute("UPDATE conflict SET patio_choice = ? WHERE id = ?", (choice[6:], cid))
    else:
        for role in roles:
            conn.execute(f"UPDATE conflict SET {role}_choice = ? WHERE id = ?", (choice, cid))
    c = conn.execute("SELECT * FROM conflict WHERE id = ?", (cid,)).fetchone()
    status = conflicts.derive_status(c["blocker_choice"], c["blocked_choice"], c["patio_route"], c["patio_choice"])
    conn.execute("UPDATE conflict SET status = ? WHERE id = ?", (status, cid))
    ctx["notes"] = (conflicts.patio_messages(conn, cid) if choice.startswith("patio_")
                    else conflicts.choice_messages(conn, cid, roles[0], ctx["now"]))
    return {"status": status}


@route("POST", "/api/conflicts/<cid>/swap")
@mutation
def conflict_swap(ctx, cid):
    """Tausch ist erfolgt: beide Parkvorgänge beenden und über Kreuz neu anlegen."""
    d, _ = _my_conflict(ctx, cid)
    require(d["status"] == "swap_agreed" or d["blocker_resident_id"] == d["blocked_resident_id"],
            409, "Beide müssen dem Tausch zustimmen")
    conn, now = ctx["conn"], iso(ctx["now"])
    pa = conn.execute("SELECT car_id, spot_id FROM parking WHERE id = ?", (d["blocker_parking_id"],)).fetchone()
    pb = conn.execute("SELECT car_id, spot_id FROM parking WHERE id = ?", (d["blocked_parking_id"],)).fetchone()
    conn.execute("UPDATE parking SET left_at = ? WHERE id IN (?, ?)", (now, d["blocker_parking_id"], d["blocked_parking_id"]))
    conn.execute("INSERT INTO parking(car_id, spot_id, parked_at) VALUES (?,?,?)", (pa["car_id"], pb["spot_id"], now))
    conn.execute("INSERT INTO parking(car_id, spot_id, parked_at) VALUES (?,?,?)", (pb["car_id"], pa["spot_id"], now))
    return {"ok": True}


# ---------------------------------------------------------------------------
# „Ich will gleich rausfahren“
# ---------------------------------------------------------------------------

@route("POST", "/api/cars/<car_id>/leave-request")
@mutation
def create_leave_request(ctx, car_id):
    own_car(ctx, car_id)
    p = ctx["conn"].execute("SELECT id FROM parking WHERE car_id = ? AND left_at IS NULL", (car_id,)).fetchone()
    require(p, 409, "Das Auto ist gerade nicht geparkt")
    rid, ctx["notes"] = leave_requests.create(ctx["conn"], p["id"], ctx["now"])
    return {"id": rid}


def _own_request(ctx, rid):
    exists = ctx["conn"].execute("SELECT 1 FROM leave_request WHERE id = ?", (rid,)).fetchone()
    require(exists and leave_requests.requester_resident(ctx["conn"], rid) == ctx["me"]["id"],
            404, "Anfrage nicht gefunden")


@route("POST", "/api/leave-requests/<rid>/ping")
@mutation
def ping_leave_request(ctx, rid):
    _own_request(ctx, rid)
    ctx["notes"] = leave_requests.ping(ctx["conn"], rid, ctx["now"])
    return {"ok": True}


@route("POST", "/api/leave-requests/<rid>/cancel")
@mutation
def cancel_leave_request(ctx, rid):
    _own_request(ctx, rid)
    leave_requests.cancel(ctx["conn"], rid, ctx["now"])
    return {"ok": True}


@route("POST", "/api/leave-requests/<rid>/respond")
@mutation
def respond_leave_request(ctx, rid):
    b = ctx["body"]
    require(b.get("response") in ("coming", "later"), 400, "Ungültige Antwort")
    owner = ctx["conn"].execute(
        "SELECT c.resident_id FROM parking p JOIN car c ON c.id = p.car_id WHERE p.id = ?",
        (b.get("parking_id"),)).fetchone()
    require(owner and owner[0] == ctx["me"]["id"], 403, "Nicht dein Auto")
    ctx["notes"] = leave_requests.respond(ctx["conn"], rid, b["parking_id"], b["response"], ctx["now"])
    return {"ok": True}


# ---------------------------------------------------------------------------
# Push
# ---------------------------------------------------------------------------

@route("POST", "/api/push/subscribe")
@mutation
def push_subscribe(ctx):
    b = ctx["body"]
    keys = b.get("keys") or {}
    require(b.get("endpoint", "").startswith("https://") and keys.get("p256dh") and keys.get("auth"),
            400, "Ungültiges Push-Abo")
    ctx["conn"].execute(
        """INSERT INTO push_subscription(resident_id, endpoint, p256dh, auth) VALUES (?,?,?,?)
           ON CONFLICT(endpoint) DO UPDATE SET resident_id=excluded.resident_id,
               p256dh=excluded.p256dh, auth=excluded.auth""",
        (ctx["me"]["id"], b["endpoint"], keys["p256dh"], keys["auth"]))
    return {"ok": True}


@route("POST", "/api/push/unsubscribe")
@mutation
def push_unsubscribe(ctx):
    ctx["conn"].execute("DELETE FROM push_subscription WHERE endpoint = ? AND resident_id = ?",
                        (ctx["body"].get("endpoint"), ctx["me"]["id"]))
    return {"ok": True}


@route("POST", "/api/push/test")
def push_test(ctx):
    push.send_async([{"resident_id": ctx["me"]["id"], "title": "Test 🚗",
                      "body": i18n.t(ctx["lang"], "Push-Nachrichten funktionieren."), "url": "/", "tag": "test"}])
    return {"ok": True}


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "Parkoptimierer/1.0"

    def log_message(self, fmt, *args):
        log.debug(fmt, *args)

    def do_GET(self): self._dispatch("GET")
    def do_POST(self): self._dispatch("POST")
    def do_PATCH(self): self._dispatch("PATCH")
    def do_DELETE(self): self._dispatch("DELETE")

    def _dispatch(self, method):
        path = urlparse(self.path).path
        # Sprache dieser Anfrage: Header der App, sonst die gespeicherte des Nachbarn, sonst Deutsch
        lang = self.headers.get("X-Lang")
        if not path.startswith("/api/"):
            return self._static(path) if method == "GET" else self._json(405, {"error": i18n.t(i18n.norm(lang), "Methode nicht erlaubt")})
        try:
            for m, regex, fn, auth in ROUTES:
                match = regex.match(path)
                if m == method and match:
                    me = self._auth()
                    lang = i18n.norm(lang if lang in i18n.LANGS else (me or {}).get("lang"))
                    ctx = {"me": me, "lang": lang}
                    ctx["body"] = self._body()
                    if auth and not ctx["me"]:
                        raise ApiError(401, "Bitte zuerst anmelden")
                    return self._json(200, fn(ctx, **match.groupdict()))
            raise ApiError(404, "Unbekannter Endpunkt")
        except (ApiError, leave_requests.RequestError) as e:
            self._json(e.status, {"error": i18n.t(i18n.norm(lang), e.message, **e.values)})
        except Exception:
            log.exception("Fehler bei %s %s", method, path)
            self._json(500, {"error": i18n.t(i18n.norm(lang), "Interner Fehler")})

    def _auth(self):
        h = self.headers.get("Authorization", "")
        if not h.startswith("Bearer "):
            return None
        with db.read() as conn:
            r = conn.execute("SELECT id, display_name, unit, lang FROM resident WHERE auth_token = ?", (h[7:],)).fetchone()
        return dict(r) if r else None

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            data = json.loads(self.rfile.read(min(n, 64_000)))
        except ValueError:
            raise ApiError(400, "Ungültiges JSON")
        require(isinstance(data, dict), 400, "JSON-Objekt erwartet")
        return data

    def _json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _static(self, path):
        rel = path.lstrip("/") or "index.html"
        f = (WEB_DIR / rel).resolve()
        if WEB_DIR.resolve() not in f.parents or not f.is_file():
            f = WEB_DIR / "index.html"
        data = f.read_bytes()
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if f.suffix == ".webmanifest":
            ctype = "application/manifest+json"
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith(("text/", "application/javascript")) else ""))
        self.send_header("Cache-Control", "no-cache")
        if f.name == "sw.js":
            self.send_header("Service-Worker-Allowed", "/")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _ticker():
    """Konflikte regelmäßig neu bewerten (Zeit vergeht!) und Erinnerungen senden."""
    while True:
        time.sleep(TICK_SECONDS)
        try:
            now = utcnow()
            with db.tx() as conn:
                before = conn.total_changes
                notes = housekeeping(conn, now)
                if conn.total_changes != before:
                    db.bump_version(conn)
            push.send_async(notes)
        except Exception:
            log.exception("Ticker-Fehler")


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    mimetypes.add_type("application/javascript", ".js")
    db.init()
    push.init()
    threading.Thread(target=_ticker, daemon=True).start()
    port = int(os.environ.get("PARK_PORT", "8080"))
    log.info("Parkoptimierer läuft auf http://localhost:%d", port)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
