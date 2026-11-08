"""Nächste bekannte Ausfahrzeit eines Autos.

Kandidaten:
  * einmalige Ausfahrten (planned_departure) in der Zukunft
  * übliche Ausfahrten (recurring_departure) der nächsten 8 Tage,
    abzüglich ausgelassener Tage (recurring_skip)
Die früheste gewinnt.

„Nicht da“ (resident.away_from/away_until): Der Nachbar ist weg, das Auto bleibt
stehen. Ausfahrten in dieser Zeit fallen weg; die nächste Ausfahrt ist die erste
nach der Rückkehr.
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .db import iso, parse_iso

LOOKAHEAD_DAYS = 8
MAX_AWAY_DAYS = 60


def _lot_tz(conn):
    return ZoneInfo(conn.execute("SELECT timezone FROM lot LIMIT 1").fetchone()[0])


def away_windows(conn, car_ids, now):
    """{car_id: (ab, bis)} für Autos, deren Besitzer jetzt oder später „nicht da“ ist."""
    if not car_ids:
        return {}
    out = {}
    for r in conn.execute(
            f"""SELECT c.id, r.away_from, r.away_until FROM car c JOIN resident r ON r.id = c.resident_id
                WHERE c.id IN ({",".join("?" * len(car_ids))}) AND r.away_until > ?""", (*car_ids, iso(now))):
        out[r[0]] = (parse_iso(r[1]) or now, parse_iso(r[2]))
    return out


def is_away(window, at):
    return bool(window) and window[0] <= at < window[1]


def next_departures(conn, car_ids, now):
    """Gibt {car_id: {"at": datetime_utc, "source": "planned"|"recurring", "label": str}} zurück."""
    if not car_ids:
        return {}
    tz = _lot_tz(conn)
    ph = ",".join("?" * len(car_ids))
    result = {}
    away = away_windows(conn, car_ids, now)

    def offer(car_id, at, source, label):
        if is_away(away.get(car_id), at):
            return False
        cur = result.get(car_id)
        if cur is None or at < cur["at"]:
            result[car_id] = {"at": at, "source": source, "label": label}
        return True

    for r in conn.execute(
            f"""SELECT car_id, depart_at AS at, note FROM planned_departure
                WHERE car_id IN ({ph}) AND depart_at > ? ORDER BY depart_at""",
            (*car_ids, iso(now))):
        if r["car_id"] not in result or result[r["car_id"]]["source"] != "planned":
            offer(r["car_id"], parse_iso(r["at"]), "planned", r["note"])

    rec = conn.execute(
        f"""SELECT id, car_id, weekdays, depart_time, label FROM recurring_departure
            WHERE active = 1 AND car_id IN ({ph})""", car_ids).fetchall()
    if rec:
        local_today = now.astimezone(tz).date()
        longest = max([(w[1] - now).days + 1 for w in away.values()] + [0])
        horizon = [local_today + timedelta(days=i) for i in range(LOOKAHEAD_DAYS + min(longest, MAX_AWAY_DAYS))]
        skips = {(s[0], s[1]) for s in conn.execute(
            f"""SELECT recurring_departure_id, skip_date FROM recurring_skip
                WHERE recurring_departure_id IN ({",".join("?" * len(rec))})""",
            [r["id"] for r in rec])}
        for r in rec:
            hh, mm = map(int, r["depart_time"].split(":"))
            for day in horizon:
                if not (r["weekdays"] >> day.weekday()) & 1:
                    continue
                if (r["id"], day.isoformat()) in skips:
                    continue
                at = datetime(day.year, day.month, day.day, hh, mm, tzinfo=tz).astimezone(timezone.utc)
                if at > now and offer(r["car_id"], at, "recurring", r["label"]):
                    break
    return result
