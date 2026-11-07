"""Tests für den Patio-Notweg im Konflikt-Ablauf."""
import json
import os
import tempfile
import unittest
from datetime import timedelta

os.environ.setdefault("PARK_DATA_DIR", tempfile.mkdtemp(prefix="park-test-"))

from server import conflicts, db  # noqa: E402
from server.db import iso, utcnow  # noqa: E402

db.init()


class PatioRoute(unittest.TestCase):
    def setUp(self):
        self.now = utcnow()
        self.conn = db.connect()
        self.conn.execute("BEGIN")
        self.lot = self.conn.execute("SELECT id FROM lot").fetchone()[0]
        self.rid, self.car, self.pid = {}, {}, {}

    def tearDown(self):
        self.conn.execute("ROLLBACK")
        self.conn.close()

    def park(self, code, name, hours, patio="ask"):
        """Nachbar `name` parkt auf `code`, fährt in `hours` Stunden (None = unbekannt)."""
        if name not in self.rid:
            self.rid[name] = self.conn.execute(
                "INSERT INTO resident(lot_id, display_name, auth_token) VALUES (?, ?, ?)",
                (self.lot, name, os.urandom(8).hex())).lastrowid
        car = self.conn.execute("INSERT INTO car(resident_id, nickname, patio_route) VALUES (?, ?, ?)",
                                (self.rid[name], f"Auto {name}", patio)).lastrowid
        sid = self.conn.execute("SELECT id FROM spot WHERE code = ?", (code,)).fetchone()[0]
        self.pid[code] = self.conn.execute("INSERT INTO parking(car_id, spot_id) VALUES (?, ?)", (car, sid)).lastrowid
        if hours is not None:
            self.conn.execute("INSERT INTO planned_departure(car_id, depart_at) VALUES (?, ?)",
                              (car, iso(self.now + timedelta(hours=hours))))

    def conflict(self):
        return self.conn.execute("SELECT * FROM conflict WHERE status IN ('open','swap_agreed','acknowledged','patio')").fetchone()

    def test_notweg_wird_am_konflikt_gespeichert_und_b_gefragt(self):
        self.park("L6", "Ben", 7)
        self.park("L4", "Clara", 9)
        notes = conflicts.recompute(self.conn, self.now)
        c = self.conflict()
        self.assertEqual(json.loads(c["patio_route"])["reverse"], ["P1"])
        to_ben = next(n for n in notes if n["resident_id"] == self.rid["Ben"])
        self.assertIn("Kommt das für dich in Frage?", to_ben["body"])
        self.assertIn("rückwärts auf P1", to_ben["body"])
        to_clara = next(n for n in notes if n["resident_id"] == self.rid["Clara"])
        self.assertIn("wird gefragt", to_clara["body"])   # A erfährt es sofort, mit Hinweis

    def test_auto_ohne_notweg_wird_nicht_gefragt(self):
        self.park("L6", "Ben", 7, patio="never")
        self.park("L4", "Clara", 9)
        conflicts.recompute(self.conn, self.now)
        self.assertIsNone(self.conflict()["patio_route"])

    def test_vorsichtig_auch_fruehere_ausfahrer_sperren_den_notweg(self):
        # P1 und L7 fahren zwar vor Ben weg, könnten aber zurückkommen → kein Notweg
        self.park("L6", "Ben", 7)
        self.park("L4", "Clara", 9)
        self.park("P1", "Deniz", 5)
        self.park("L7", "Emil", 5)
        conflicts.recompute(self.conn, self.now)
        self.assertIsNone(self.conflict()["patio_route"])

    def test_zusage_und_wegfall_wenn_jemand_den_weg_zuparkt(self):
        self.park("L6", "Ben", 7)
        self.park("L4", "Clara", 9)
        conflicts.recompute(self.conn, self.now)
        c = self.conflict()
        self.conn.execute("UPDATE conflict SET patio_choice = 'yes', status = 'patio' WHERE id = ?", (c["id"],))
        self.assertEqual(conflicts.patio_messages(self.conn, c["id"])[0]["title"], "Ben weicht übers Patio aus")
        self.assertEqual(conflicts.recompute(self.conn, self.now), [])     # bleibt zugesagt
        self.assertEqual(self.conflict()["status"], "patio")

        self.park("P1", "Deniz", None)    # über Nacht parkt jemand aufs Patio …
        self.park("L7", "Emil", None)     # … und auf den Ausweichweg
        notes = conflicts.recompute(self.conn, self.now)
        self.assertEqual(self.conflict()["status"], "open")
        self.assertIsNone(self.conflict()["patio_route"])
        self.assertEqual({n["title"] for n in notes}, {"Patio-Notweg ist versperrt"})
        self.assertEqual({n["resident_id"] for n in notes}, {self.rid["Ben"], self.rid["Clara"]})
        self.assertIsNone(self.conflict()["patio_choice"])   # wird der Weg wieder frei, fragt die App neu

    def test_keine_erinnerung_an_a_wenn_b_uebers_patio_faehrt(self):
        self.park("L6", "Ben", 0.5)
        self.park("L4", "Clara", 9)
        conflicts.recompute(self.conn, self.now - timedelta(hours=2))
        c = self.conflict()
        self.conn.execute("UPDATE conflict SET patio_choice = 'yes', status = 'patio' WHERE id = ?", (c["id"],))
        notes = conflicts.recompute(self.conn, self.now)
        self.assertFalse([n for n in notes if n["title"].startswith("Gleich:")])

    def test_routentext(self):
        self.assertEqual(conflicts.fmt_route({"reverse": ["L7", "P2"], "forward": ["P3", "R4", "R2", "R1"]}),
                         "rückwärts über L7 auf P2, dann über P3 → R4 → R2 → R1 hinaus")


if __name__ == "__main__":
    unittest.main()
