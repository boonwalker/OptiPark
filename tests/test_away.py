"""Tests für „Nicht da“: Der Nachbar ist weg, sein Auto bleibt stehen."""
import os
import tempfile
import unittest
from datetime import timedelta

os.environ.setdefault("PARK_DATA_DIR", tempfile.mkdtemp(prefix="park-test-"))

from server import conflicts, db  # noqa: E402
from server.db import iso, utcnow  # noqa: E402
from server.departures import next_departures  # noqa: E402

db.init()


class NichtDa(unittest.TestCase):
    def setUp(self):
        self.now = utcnow().replace(second=0)
        self.conn = db.connect()
        self.conn.execute("BEGIN")
        self.lot = self.conn.execute("SELECT id FROM lot").fetchone()[0]
        self.rid, self.car = {}, {}

    def tearDown(self):
        self.conn.execute("ROLLBACK")
        self.conn.close()

    def h(self, hours):
        return iso(self.now + timedelta(hours=hours))

    def park(self, code, name, hours=None, away=None):
        """`hours`: einmalige Ausfahrt in so vielen Stunden; `away`: (ab, bis) in Stunden, ab=None = sofort."""
        self.rid[name] = self.conn.execute(
            "INSERT INTO resident(lot_id, display_name, auth_token, away_from, away_until) VALUES (?, ?, ?, ?, ?)",
            (self.lot, name, os.urandom(8).hex(),
             self.h(away[0]) if away and away[0] is not None else None, self.h(away[1]) if away else None)).lastrowid
        self.car[name] = self.conn.execute("INSERT INTO car(resident_id, nickname, patio_route) VALUES (?, ?, 'never')",
                                           (self.rid[name], f"Auto {name}")).lastrowid
        sid = self.conn.execute("SELECT id FROM spot WHERE code = ?", (code,)).fetchone()[0]
        self.conn.execute("INSERT INTO parking(car_id, spot_id) VALUES (?, ?)", (self.car[name], sid))
        if hours is not None:
            self.conn.execute("INSERT INTO planned_departure(car_id, depart_at) VALUES (?, ?)", (self.car[name], self.h(hours)))

    def pairs(self):
        return {(self.conn.execute("SELECT nickname FROM car c JOIN parking p ON p.car_id = c.id WHERE p.id = ?", (a,)).fetchone()[0],
                 self.conn.execute("SELECT nickname FROM car c JOIN parking p ON p.car_id = c.id WHERE p.id = ?", (b,)).fetchone()[0])
                for a, b, _ in conflicts.find_blockings(self.conn, self.now)}

    def test_ausfahrten_waehrend_abwesenheit_fallen_weg(self):
        self.park("L1", "Anna", away=(None, 50))
        for hours in (5, 30, 60):
            self.conn.execute("INSERT INTO planned_departure(car_id, depart_at) VALUES (?, ?)", (self.car["Anna"], self.h(hours)))
        dep = next_departures(self.conn, [self.car["Anna"]], self.now)[self.car["Anna"]]
        self.assertEqual(iso(dep["at"]), self.h(60))   # erste Fahrt nach der Rückkehr

    def test_uebliche_fahrt_nach_langer_abwesenheit(self):
        self.park("L1", "Anna", away=(None, 24 * 12))   # 12 Tage weg, länger als die üblichen 8 Tage Vorschau
        self.conn.execute("INSERT INTO recurring_departure(car_id, weekdays, depart_time) VALUES (?, 127, '07:00')", (self.car["Anna"],))
        dep = next_departures(self.conn, [self.car["Anna"]], self.now)[self.car["Anna"]]
        self.assertGreaterEqual(iso(dep["at"]), self.h(24 * 12))

    def test_spaetere_abwesenheit_laesst_fahrt_davor_stehen(self):
        self.park("L1", "Anna", 5, away=(10, 50))
        dep = next_departures(self.conn, [self.car["Anna"]], self.now)[self.car["Anna"]]
        self.assertEqual(iso(dep["at"]), self.h(5))

    def test_konflikt_ueber_die_ganze_abwesenheit(self):
        # Ben muss in 4 Tagen raus – jenseits von 36 h, aber Clara (davor) ist 5 Tage weg
        self.park("R2", "Ben", 96)
        self.park("R1", "Clara", away=(None, 120))
        self.assertEqual(self.pairs(), {("Auto Clara", "Auto Ben")})

    def test_ohne_abwesenheit_bleibt_es_bei_36_stunden(self):
        self.park("R2", "Ben", 96)
        self.park("R1", "Clara", None)
        self.assertEqual(self.pairs(), set())

    def test_weit_entfernt_zaehlt_nur_wer_nicht_da_ist(self):
        # Ben in 4 Tagen; vor ihm steht R1 (Clara, da, unbekannte Ausfahrt) – kein Grund für eine frühe Warnung
        self.park("R2", "Ben", 96)
        self.park("R1", "Clara", None)
        self.park("L1", "Deniz", away=(None, 120))   # jemand anderes ist weg, steht aber nicht im Weg
        self.assertEqual(self.pairs(), set())

    def test_nachricht_nennt_abwesenheit_und_keine_erinnerung(self):
        self.park("R2", "Ben", 0.5)
        self.park("R1", "Clara", away=(None, 48))
        notes = conflicts.recompute(self.conn, self.now - timedelta(hours=2))
        to_ben = next(n for n in notes if n["resident_id"] == self.rid["Ben"])
        to_clara = next(n for n in notes if n["resident_id"] == self.rid["Clara"])
        self.assertIn("ist bis", to_ben["body"])
        self.assertIn("nicht da und kann das Auto nicht wegfahren", to_ben["body"])
        self.assertIn("Du bist dann nicht da", to_clara["body"])
        notes = conflicts.recompute(self.conn, self.now)
        self.assertFalse([n for n in notes if n["title"].startswith("Gleich:")])

    def test_zurueck_vor_der_ausfahrt_normaler_konflikt(self):
        # Clara ist nur bis in 2 Stunden weg, Ben fährt in 7 Stunden, Clara erst in 9 → normaler Konflikt
        self.park("R2", "Ben", 7)
        self.park("R1", "Clara", 9, away=(None, 2))
        conflicts.recompute(self.conn, self.now)
        c = self.conn.execute("SELECT id FROM conflict").fetchone()
        self.assertIsNone(conflicts.blocker_away(conflicts.conflict_details(self.conn, c[0])))


if __name__ == "__main__":
    unittest.main()
