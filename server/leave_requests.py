"""„Ich will gleich rausfahren“ – spontane Anfrage eines zugeparkten Autos.

Ablauf:
  1. create():    Wer steht jetzt im Weg? (rules.clearing_set, ohne Zeitbezug)
                  → Anfrage + Blockierer speichern, alle Blockierer benachrichtigen.
  2. respond():   Blockierer antwortet „Komme sofort“ / „Dauert ~15 Min.“
                  → der Fragende wird benachrichtigt.
  3. ping():      Fragender klingelt nach (frühestens alle 3 Minuten).
  4. reconcile(): läuft nach jeder Änderung und jede Minute.
                  Weg frei → „cleared“ + Nachricht an den Fragenden.
                  Neue Hindernisse → nachtragen und benachrichtigen.
                  Ausgeparkt → „cleared“, nach 1 Stunde → „expired“.
"""
from datetime import timedelta

from . import rules
from .db import iso, parse_iso

PING_COOLDOWN = timedelta(minutes=3)
EXPIRE_AFTER = timedelta(hours=1)
ETA_LATER = 15  # Minuten für „Dauert etwas“


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def _parked(conn):
    rows = conn.execute("""
        SELECT p.id AS pid, p.spot_id, s.code AS spot, c.id AS car_id, c.nickname AS car,
               r.id AS resident_id, r.display_name AS name
        FROM parking p JOIN spot s ON s.id = p.spot_id
        JOIN car c ON c.id = p.car_id JOIN resident r ON r.id = c.resident_id
        WHERE p.left_at IS NULL""").fetchall()
    return {r["spot_id"]: dict(r) for r in rows}


def _needed(conn, parking_id, parked=None):
    """Liste von Schichten (Listen von Parkvorgängen), die jetzt weg müssten."""
    parked = parked or _parked(conn)
    me = next((p for p in parked.values() if p["pid"] == parking_id), None)
    if me is None:
        return None, []
    layers = rules.clearing_set(rules.graph(conn), me["spot_id"], set(parked) - {me["spot_id"]})
    return me, [[parked[s] for s in sorted(layer, key=lambda s: parked[s]["spot"])] for layer in layers]


def _msg(resident_id, title, body, rid):
    return {"resident_id": resident_id, "title": title, "body": body,
            "url": f"/#raus-{rid}", "tag": f"leave-{rid}"}


def _blocker_messages(me, layers, only_pids, rid, reminder=False):
    out = []
    for layer in layers:
        for b in layer:
            if b["pid"] not in only_pids or b["resident_id"] == me["resident_id"]:
                continue
            alt = [o for o in layer if o["pid"] != b["pid"]]
            body = (f"Dein {b['car']} auf {b['spot']} steht {me['name']} ({me['spot']}) im Weg. "
                    f"Bitte kurz umparken.")
            if alt:
                body += " Alternativ könnte auch " + " oder ".join(f"{o['name']} ({o['spot']})" for o in alt) + " Platz machen."
            title = f"Erinnerung: {me['name']} wartet" if reminder else f"{me['name']} will gleich rausfahren"
            out.append(_msg(b["resident_id"], title, body, rid))
    return out


def create(conn, parking_id, now):
    if conn.execute("SELECT 1 FROM leave_request WHERE parking_id = ? AND status = 'open'", (parking_id,)).fetchone():
        raise RequestError(409, "Deine Anfrage läuft schon")
    me, layers = _needed(conn, parking_id)
    if me is None:
        raise RequestError(409, "Das Auto ist gerade nicht geparkt")
    if not layers:
        raise RequestError(409, "Du kommst raus – niemand steht im Weg")
    rid = conn.execute(
        "INSERT INTO leave_request(parking_id, created_at, last_pinged_at) VALUES (?, ?, ?)",
        (parking_id, iso(now), iso(now))).lastrowid
    pids = {b["pid"] for layer in layers for b in layer}
    conn.executemany("INSERT INTO leave_request_blocker(request_id, parking_id) VALUES (?, ?)",
                     [(rid, p) for p in pids])
    return rid, _blocker_messages(me, layers, pids, rid)


def _open_request(conn, rid):
    r = conn.execute("SELECT * FROM leave_request WHERE id = ? AND status = 'open'", (rid,)).fetchone()
    if not r:
        raise RequestError(404, "Anfrage nicht (mehr) offen")
    return r


def requester_resident(conn, rid):
    return conn.execute("""SELECT c.resident_id FROM leave_request lr JOIN parking p ON p.id = lr.parking_id
                           JOIN car c ON c.id = p.car_id WHERE lr.id = ?""", (rid,)).fetchone()[0]


def ping(conn, rid, now):
    r = _open_request(conn, rid)
    wait = parse_iso(r["last_pinged_at"]) + PING_COOLDOWN - now
    if wait.total_seconds() > 0:
        raise RequestError(429, f"Bitte noch {int(wait.total_seconds() // 60) + 1} Min. warten")
    conn.execute("UPDATE leave_request SET last_pinged_at = ? WHERE id = ?", (iso(now), rid))
    me, layers = _needed(conn, r["parking_id"])
    coming = {row[0] for row in conn.execute(
        "SELECT parking_id FROM leave_request_blocker WHERE request_id = ? AND response = 'coming'", (rid,))}
    pids = {b["pid"] for layer in layers for b in layer} - coming
    return _blocker_messages(me, layers, pids, rid, reminder=True)


def cancel(conn, rid, now):
    _open_request(conn, rid)
    conn.execute("UPDATE leave_request SET status = 'cancelled', closed_at = ? WHERE id = ?", (iso(now), rid))


def respond(conn, rid, blocker_parking_id, response, now):
    _open_request(conn, rid)
    eta = ETA_LATER if response == "later" else None
    n = conn.execute("""UPDATE leave_request_blocker SET response = ?, eta_minutes = ?, responded_at = ?
                        WHERE request_id = ? AND parking_id = ?""",
                     (response, eta, iso(now), rid, blocker_parking_id)).rowcount
    if not n:
        raise RequestError(403, "Du stehst bei dieser Anfrage nicht im Weg")
    who = conn.execute("""SELECT r.display_name, s.code FROM parking p JOIN car c ON c.id = p.car_id
                          JOIN resident r ON r.id = c.resident_id JOIN spot s ON s.id = p.spot_id
                          WHERE p.id = ?""", (blocker_parking_id,)).fetchone()
    title = f"{who[0]} kommt sofort" if response == "coming" else f"{who[0]} braucht noch ~{ETA_LATER} Min."
    return [_msg(requester_resident(conn, rid), title, f"Auto auf {who[1]} wird umgeparkt.", rid)]


def reconcile(conn, now):
    notes = []
    parked = None
    for r in conn.execute("SELECT * FROM leave_request WHERE status = 'open'").fetchall():
        parked = parked or _parked(conn)
        me, layers = _needed(conn, r["parking_id"], parked)
        if me is None:  # ausgeparkt
            status = "cleared"
        elif not layers:
            status = "cleared"
            notes.append(_msg(me["resident_id"], "Weg ist frei 🚗", "Du kannst jetzt rausfahren.", r["id"]))
        elif now - parse_iso(r["created_at"]) > EXPIRE_AFTER:
            status = "expired"
        else:
            known = {row[0] for row in conn.execute(
                "SELECT parking_id FROM leave_request_blocker WHERE request_id = ?", (r["id"],))}
            new = {b["pid"] for layer in layers for b in layer} - known
            if new:
                conn.executemany("INSERT INTO leave_request_blocker(request_id, parking_id) VALUES (?, ?)",
                                 [(r["id"], p) for p in new])
                notes += _blocker_messages(me, layers, new, r["id"])
            continue
        conn.execute("UPDATE leave_request SET status = ?, closed_at = ? WHERE id = ?", (status, iso(now), r["id"]))
    return notes


def for_resident(conn, resident_id, now):
    """Offene Anfragen, bei denen der Nachbar fragt oder im Weg steht – für /api/state."""
    out = []
    parked = None
    for r in conn.execute("SELECT * FROM leave_request WHERE status = 'open' ORDER BY created_at").fetchall():
        parked = parked or _parked(conn)
        me, layers = _needed(conn, r["parking_id"], parked)
        if me is None:
            continue
        responses = {row["parking_id"]: dict(row) for row in conn.execute(
            "SELECT parking_id, response, eta_minutes, responded_at FROM leave_request_blocker WHERE request_id = ?",
            (r["id"],))}
        blockers = []
        for i, layer in enumerate(layers):
            for b in layer:
                resp = responses.get(b["pid"], {})
                blockers.append({"parking_id": b["pid"], "layer": i, "name": b["name"], "car": b["car"],
                                 "spot": b["spot"], "resident_id": b["resident_id"],
                                 "response": resp.get("response"), "eta_minutes": resp.get("eta_minutes"),
                                 "responded_at": resp.get("responded_at")})
        is_requester = me["resident_id"] == resident_id
        if not is_requester and not any(b["resident_id"] == resident_id for b in blockers):
            continue
        next_ping = parse_iso(r["last_pinged_at"]) + PING_COOLDOWN
        out.append({"id": r["id"], "role": "requester" if is_requester else "blocker",
                    "requester_name": me["name"], "requester_car": me["car"], "requester_spot": me["spot"],
                    "requester_car_id": me["car_id"], "created_at": r["created_at"],
                    "next_ping_at": iso(max(next_ping, now)), "blockers": blockers})
    return out
