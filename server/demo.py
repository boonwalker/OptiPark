"""Demo-Daten: ein paar Nachbarn mit Autos, Routinen und Belegung.

    .venv.nosync/bin/python -m server.demo        (gegen den Datenordner aus PARK_DATA_DIR)

Gibt Anmelde-Links für alle Demo-Nachbarn aus.
"""
import secrets
from datetime import timedelta

from . import conflicts, db
from .db import iso, utcnow

NEIGHBORS = [
    # Name,    Wohnung,     Auto,         Farbe,     Platz, Routine (Tage, Zeit, Anlass)
    ("Anna",   "EG links",  "Polo",       "#ff6b5b", "L1", (31, "09:00", "Arbeit")),
    ("Ben",    "EG rechts", "Golf",       "#3ecf8e", "L2", (31, "07:00", "Arbeit")),
    ("Clara",  "1. OG",     "Mini",       "#ffb547", "L4", (31, "08:15", "Schule")),
    ("Deniz",  "2. OG",     "Tesla",      "#e9ecf2", "R1", None),
    ("Emil",   "2. OG",     "Kombi",      "#b57cff", "R3", (62, "06:30", "Frühschicht")),
]


def main():
    db.init()
    now = utcnow()
    with db.tx() as conn:
        lot_id = conn.execute("SELECT id FROM lot").fetchone()[0]
        for name, unit, car, color, spot, routine in NEIGHBORS:
            if conn.execute("SELECT 1 FROM resident WHERE display_name = ?", (name,)).fetchone():
                continue
            rid = conn.execute("INSERT INTO resident(lot_id, display_name, unit, auth_token) VALUES (?,?,?,?)",
                               (lot_id, name, unit, secrets.token_urlsafe(24))).lastrowid
            cid = conn.execute("INSERT INTO car(resident_id, nickname, color) VALUES (?,?,?)",
                               (rid, car, color)).lastrowid
            if routine:
                conn.execute("INSERT INTO recurring_departure(car_id, weekdays, depart_time, label) VALUES (?,?,?,?)",
                             (cid, *routine))
            else:
                conn.execute("INSERT INTO planned_departure(car_id, depart_at, note) VALUES (?,?,?)",
                             (cid, iso(now + timedelta(hours=20)), "Ausflug"))
            sid = conn.execute("SELECT id FROM spot WHERE code = ?", (spot,)).fetchone()[0]
            conn.execute("INSERT INTO parking(car_id, spot_id, parked_at) VALUES (?,?,?)",
                         (cid, sid, iso(now - timedelta(hours=2))))
        conflicts.recompute(conn, now)
        db.bump_version(conn)
        for r in conn.execute("SELECT display_name, auth_token FROM resident ORDER BY id"):
            print(f"{r[0]:8} http://localhost:8080/#login={r[1]}")


if __name__ == "__main__":
    main()
