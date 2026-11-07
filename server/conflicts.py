"""Konflikterkennung.

Ein Konflikt liegt vor, wenn
  * Auto B eine bekannte nächste Ausfahrt innerhalb des Horizonts hat,
  * B zu diesem Zeitpunkt im Wegenetz (siehe rules.py) keinen freien Weg nach
    draußen hat, weil Autos im Weg stehen, die erst später (oder zu unbekannter
    Zeit) fahren, und
  * Auto A eines dieser Hindernisse ist – genauer: eines, an das B als Erstes stößt.
Pro Paar (A, B) und Ausfahrzeit entsteht genau ein Konflikt.

Patio-Notweg: Könnte B zu seiner Ausfahrzeit rückwärts aufs Patio und von dort
hinaus, ohne dass irgendwer umparken muss (rules.patio_route), und schließt Bs
Auto das nicht grundsätzlich aus (car.patio_route = 'never'), wird der Weg am
Konflikt gespeichert und B gefragt, ob er für ihn in Frage kommt. A sieht den
Konflikt trotzdem sofort, mit diesem Hinweis. Sagt B ja → Status 'patio'.
Der Notweg wird vorsichtig bewertet: Er muss jetzt frei sein (alle geparkten
Autos zählen als Hindernis). Bis zu Bs Ausfahrt kann ihn jemand zuparken; das
merkt die nächste Neuberechnung, der Status fällt zurück und beide erfahren es.

recompute() gleicht den gewünschten Zustand mit der Tabelle conflict ab und
liefert die zu verschickenden Benachrichtigungen zurück. Verschickt wird erst
nach dem Commit (siehe app.py), damit niemand über einen zurückgerollten
Zustand informiert wird.
"""
import json
from datetime import timedelta
from zoneinfo import ZoneInfo

from . import rules
from .db import iso, parse_iso
from .departures import next_departures

HORIZON = timedelta(hours=36)       # so weit im Voraus wird gewarnt
REMIND_BEFORE = timedelta(minutes=45)
ACTIVE = ("open", "swap_agreed", "acknowledged", "patio")

WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]


def fmt_when(dt, now, tz):
    if dt is None:
        return "unbekannt"
    local, today = dt.astimezone(tz), now.astimezone(tz).date()
    days = (local.date() - today).days
    prefix = {0: "heute", 1: "morgen", 2: "übermorgen"}.get(days, WEEKDAYS[local.weekday()] + " " + local.strftime("%d.%m."))
    return f"{prefix} {local:%H:%M}"


def fmt_route(route_json):
    """{"reverse": ["P1"], "forward": ["P2", "L7"]} → „rückwärts auf P1, dann über P2 → L7 hinaus“."""
    if not route_json:
        return ""
    r = json.loads(route_json) if isinstance(route_json, str) else route_json
    back = r["reverse"]
    text = "rückwärts " + (f"über {' → '.join(back[:-1])} auf {back[-1]}" if len(back) > 1 else f"auf {back[-1]}")
    return text + (f", dann über {' → '.join(r['forward'])} hinaus" if r["forward"] else ", dann hinaus")


def derive_status(blocker_choice, blocked_choice, patio_route, patio_choice):
    if patio_route and patio_choice == "yes":
        return "patio"
    if blocker_choice == blocked_choice == "swap":
        return "swap_agreed"
    if blocker_choice == "manual":
        return "acknowledged"
    return "open"


def find_blockings(conn, now):
    """{(blocker_parking_id, blocked_parking_id, blocked_departs_at): {"blocker_at", "patio_route"}}

    Für jedes Auto B mit Ausfahrt im Horizont: Welche Autos stehen zu Bs
    Ausfahrzeit noch da (spätere oder keine bekannte Ausfahrt)? Gibt es dann
    keinen freien Weg nach draußen, sind die Autos, an die B als Erste stößt,
    Blockierer.
    """
    parked = conn.execute("""
        SELECT p.id AS pid, p.car_id, p.spot_id, c.patio_route AS patio_pref
        FROM parking p JOIN car c ON c.id = p.car_id WHERE p.left_at IS NULL""").fetchall()
    if not parked:
        return {}
    nd = next_departures(conn, [p["car_id"] for p in parked], now)
    moves = rules.graph(conn)
    patios = rules.patio_spots(conn)
    codes = {r[0]: r[1] for r in conn.execute("SELECT id, code FROM spot")}
    by_spot = {p["spot_id"]: p for p in parked}

    wanted = {}
    for b in parked:
        b_dep = nd.get(b["car_id"])
        if not b_dep or b_dep["at"] - now > HORIZON:
            continue
        still_there = {
            p["spot_id"] for p in parked
            if p["pid"] != b["pid"]
            and (p["car_id"] not in nd or nd[p["car_id"]]["at"] > b_dep["at"])
        }
        found = rules.blockers(moves, b["spot_id"], still_there)
        route = None
        if found and b["patio_pref"] != "never":
            # Vorsichtig: Der Notweg muss JETZT frei sein. Auch Autos, die vor B
            # wegfahren, zählen als Hindernis (sie könnten zurückkommen). Parkt
            # später jemand auf dem Weg, fällt er bei der nächsten Neuberechnung weg.
            everyone_else = set(by_spot) - {b["spot_id"]}
            r = rules.patio_route(moves, b["spot_id"], everyone_else, patios)
            if r:
                route = json.dumps({k: [codes[s] for s in v] for k, v in r.items()})
        for spot in found:
            a = by_spot[spot]
            a_dep = nd.get(a["car_id"])
            wanted[(a["pid"], b["pid"], iso(b_dep["at"]))] = {
                "blocker_at": iso(a_dep["at"]) if a_dep else None, "patio_route": route}
    return wanted


def recompute(conn, now):
    wanted = find_blockings(conn, now)

    notifications = []
    active = conn.execute(
        f"SELECT * FROM conflict WHERE status IN ({','.join('?' * len(ACTIVE))})", ACTIVE).fetchall()

    # 1) Nicht mehr zutreffende Konflikte schließen
    for c in active:
        key = (c["blocker_parking_id"], c["blocked_parking_id"], c["blocked_departs_at"])
        if key in wanted:
            continue
        ended = conn.execute(
            "SELECT COUNT(*) FROM parking WHERE id IN (?, ?) AND left_at IS NOT NULL",
            (c["blocker_parking_id"], c["blocked_parking_id"])).fetchone()[0]
        conn.execute("UPDATE conflict SET status = ?, closed_at = ? WHERE id = ?",
                     ("resolved" if ended else "obsolete", iso(now), c["id"]))

    # 2) Neue Konflikte anlegen, bestehende aktualisieren, veraltete wieder öffnen
    for (blocker_pid, blocked_pid, blocked_at), w in wanted.items():
        blocker_at, route = w["blocker_at"], w["patio_route"]
        row = conn.execute(
            "SELECT * FROM conflict WHERE blocker_parking_id=? AND blocked_parking_id=? AND blocked_departs_at=?",
            (blocker_pid, blocked_pid, blocked_at)).fetchone()
        if row is None:
            cid = conn.execute(
                """INSERT INTO conflict(blocker_parking_id, blocked_parking_id, blocked_departs_at,
                                        blocker_departs_at, patio_route, notified_at) VALUES (?,?,?,?,?,?)""",
                (blocker_pid, blocked_pid, blocked_at, blocker_at, route, iso(now))).lastrowid
            notifications += _new_conflict_messages(conn, cid, now)
        elif row["status"] == "obsolete":
            conn.execute(
                """UPDATE conflict SET status='open', blocker_departs_at=?, patio_route=?, closed_at=NULL,
                   blocker_choice=NULL, blocked_choice=NULL, patio_choice=NULL, notified_at=? WHERE id=?""",
                (blocker_at, route, iso(now), row["id"]))
            notifications += _new_conflict_messages(conn, row["id"], now)
        else:
            # Fällt der Notweg weg, gilt Bs Antwort nicht mehr: wird er später wieder
            # frei, fragt die App erneut, statt das alte „Ja“ stillschweigend zu nutzen.
            patio_choice = row["patio_choice"] if route else None
            status = derive_status(row["blocker_choice"], row["blocked_choice"], route, patio_choice)
            conn.execute("UPDATE conflict SET blocker_departs_at=?, patio_route=?, patio_choice=?, status=? WHERE id=?",
                         (blocker_at, route, patio_choice, status, row["id"]))
            if row["status"] == "patio" and status != "patio":
                notifications += _patio_lost_messages(conn, row["id"])

    notifications += _due_reminders(conn, now)
    return notifications


def conflict_details(conn, cid):
    return conn.execute("""
        SELECT c.*,
               ca.id AS blocker_car_id, ca.nickname AS blocker_car, ra.id AS blocker_resident_id,
               ra.display_name AS blocker_name, sa.code AS blocker_spot,
               cb.id AS blocked_car_id, cb.nickname AS blocked_car, rb.id AS blocked_resident_id,
               rb.display_name AS blocked_name, sb.code AS blocked_spot
        FROM conflict c
        JOIN parking pa ON pa.id = c.blocker_parking_id
        JOIN car ca ON ca.id = pa.car_id JOIN resident ra ON ra.id = ca.resident_id
        JOIN spot sa ON sa.id = pa.spot_id
        JOIN parking pb ON pb.id = c.blocked_parking_id
        JOIN car cb ON cb.id = pb.car_id JOIN resident rb ON rb.id = cb.resident_id
        JOIN spot sb ON sb.id = pb.spot_id
        WHERE c.id = ?""", (cid,)).fetchone()


def _tz(conn):
    return ZoneInfo(conn.execute("SELECT timezone FROM lot LIMIT 1").fetchone()[0])


def _msg(resident_id, title, body, cid):
    return {"resident_id": resident_id, "title": title, "body": body,
            "url": f"/#konflikt-{cid}", "tag": f"conflict-{cid}"}


def _new_conflict_messages(conn, cid, now):
    d, tz = conflict_details(conn, cid), _tz(conn)
    b_when = fmt_when(parse_iso(d["blocked_departs_at"]), now, tz)
    a_when = fmt_when(parse_iso(d["blocker_departs_at"]), now, tz)
    if d["blocker_resident_id"] == d["blocked_resident_id"]:
        return [_msg(d["blocker_resident_id"], "Du stehst dir selbst im Weg",
                     f"{d['blocked_car']} ({d['blocked_spot']}) muss {b_when} raus, "
                     f"{d['blocker_car']} ({d['blocker_spot']}) steht davor.", cid)]
    if d["patio_route"]:
        return [
            _msg(d["blocker_resident_id"], f"Du blockierst {d['blocked_name']}",
                 f"{d['blocked_name']} muss {b_when} raus ({d['blocked_spot']}), du fährst erst {a_when}. "
                 f"{d['blocked_name']} wird gefragt, ob der Patio-Notweg in Frage kommt.", cid),
            _msg(d["blocked_resident_id"], f"{d['blocker_name']} steht vor dir",
                 f"Du musst {b_when} raus, {d['blocker_name']} ({d['blocker_spot']}) fährt erst {a_when}. "
                 f"Notlösung: {fmt_route(d['patio_route'])}. Kommt das für dich in Frage?", cid),
        ]
    return [
        _msg(d["blocker_resident_id"], f"Du blockierst {d['blocked_name']}",
             f"{d['blocked_name']} muss {b_when} raus ({d['blocked_spot']}), du fährst erst {a_when}. "
             f"Heute Abend tauschen?", cid),
        _msg(d["blocked_resident_id"], f"{d['blocker_name']} steht vor dir",
             f"Du musst {b_when} raus, {d['blocker_name']} ({d['blocker_spot']}) fährt erst {a_when}. "
             f"Heute Abend tauschen?", cid),
    ]


def patio_messages(conn, cid):
    """Nachricht an A, nachdem B die Patio-Rückfrage beantwortet hat."""
    d = conflict_details(conn, cid)
    if d["blocker_resident_id"] == d["blocked_resident_id"]:
        return []
    if d["patio_choice"] == "yes":
        return [_msg(d["blocker_resident_id"], f"{d['blocked_name']} weicht übers Patio aus",
                     "Du musst nichts tun.", cid)]
    return [_msg(d["blocker_resident_id"], f"{d['blocked_name']} kann nicht übers Patio ausweichen",
                 f"{d['blocker_spot']} steht vor {d['blocked_spot']}. Heute Abend tauschen?", cid)]


def _patio_lost_messages(conn, cid):
    d = conflict_details(conn, cid)
    body = (f"{d['blocked_name']} kommt nicht mehr übers Patio raus. "
            f"Bitte klärt den Konflikt ({d['blocker_spot']} ↔ {d['blocked_spot']}).")
    ids = {d["blocker_resident_id"], d["blocked_resident_id"]}
    return [_msg(r, "Patio-Notweg ist versperrt", body, cid) for r in ids]


def choice_messages(conn, cid, actor_role, now):
    """Nachrichten nachdem eine Partei sich entschieden hat."""
    d = conflict_details(conn, cid)
    other_id = d["blocked_resident_id"] if actor_role == "blocker" else d["blocker_resident_id"]
    actor = d["blocker_name"] if actor_role == "blocker" else d["blocked_name"]
    if d["blocker_resident_id"] == d["blocked_resident_id"]:
        return []
    if d["status"] == "swap_agreed":
        both = [d["blocker_resident_id"], d["blocked_resident_id"]]
        return [_msg(r, "Tausch vereinbart",
                     f"{d['blocker_spot']} ↔ {d['blocked_spot']}: Bitte heute noch umparken und "
                     f"in der App „Getauscht“ tippen.", cid) for r in both]
    choice = d[f"{actor_role}_choice"]
    if choice == "swap":
        return [_msg(other_id, f"{actor} möchte tauschen",
                     f"{d['blocker_spot']} ↔ {d['blocked_spot']} – bist du einverstanden?", cid)]
    if actor_role == "blocker" and choice == "manual":
        when = fmt_when(parse_iso(d["blocked_departs_at"]), now, _tz(conn))
        return [_msg(other_id, f"{actor} lässt dich raus",
                     f"{actor} fährt {when} rechtzeitig zur Seite.", cid)]
    return []


def _due_reminders(conn, now):
    due = conn.execute(
        """SELECT id FROM conflict
           WHERE status IN ('open','acknowledged','swap_agreed') AND reminded_at IS NULL
             AND blocked_departs_at <= ? AND blocked_departs_at > ?""",
        (iso(now + REMIND_BEFORE), iso(now))).fetchall()
    out = []
    for r in due:
        d = conflict_details(conn, r["id"])
        when = fmt_when(parse_iso(d["blocked_departs_at"]), now, _tz(conn))
        out.append(_msg(d["blocker_resident_id"], f"Gleich: {d['blocked_name']} muss raus",
                        f"{d['blocked_car']} auf {d['blocked_spot']} fährt {when} – "
                        f"dein Auto auf {d['blocker_spot']} steht davor.", r["id"]))
        conn.execute("UPDATE conflict SET reminded_at = ? WHERE id = ?", (iso(now), r["id"]))
    return out
