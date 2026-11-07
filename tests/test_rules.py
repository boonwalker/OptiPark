"""Tests der Blockierungsregeln.   Start:  .venv.nosync/bin/python -m unittest discover tests

Jeder Fall: Wer steht wo, wer fährt in wie vielen Stunden → welche Konflikte (Blocker → Blockierter).
"""
import os
import tempfile
import unittest
from datetime import timedelta

os.environ["PARK_DATA_DIR"] = tempfile.mkdtemp(prefix="park-test-")

from server import conflicts, db, rules  # noqa: E402
from server.db import iso, utcnow  # noqa: E402

db.init()


class Rules(unittest.TestCase):
    def setUp(self):
        self.now = utcnow()
        self.conn = db.connect()
        self.conn.execute("BEGIN")
        lot = self.conn.execute("SELECT id FROM lot").fetchone()[0]
        self.rid = self.conn.execute(
            "INSERT INTO resident(lot_id, display_name, auth_token) VALUES (?, 'T', ?)",
            (lot, os.urandom(8).hex())).lastrowid

    def tearDown(self):
        self.conn.execute("ROLLBACK")
        self.conn.close()

    def park(self, **spots):
        """park(L1=9, L2=7, R1=None)  → Platz = Stunden bis zur Ausfahrt (None = unbekannt)."""
        for code, hours in spots.items():
            car = self.conn.execute("INSERT INTO car(resident_id, nickname) VALUES (?, ?)",
                                    (self.rid, code)).lastrowid
            sid = self.conn.execute("SELECT id FROM spot WHERE code = ?", (code,)).fetchone()[0]
            self.conn.execute("INSERT INTO parking(car_id, spot_id) VALUES (?, ?)", (car, sid))
            if hours is not None:
                self.conn.execute("INSERT INTO planned_departure(car_id, depart_at) VALUES (?, ?)",
                                  (car, iso(self.now + timedelta(hours=hours))))

    def conflicts(self):
        code = {}
        for r in self.conn.execute(
                "SELECT p.id, s.code FROM parking p JOIN spot s ON s.id = p.spot_id WHERE p.left_at IS NULL"):
            code[r[0]] = r[1]
        return {f"{code[a]}→{code[b]}" for a, b, _ in conflicts.find_blockings(self.conn, self.now)}

    # ── Tür 1 · links ──────────────────────────────────────────
    def test_l1_bis_l3_fahren_seitlich_in_die_spur(self):
        self.park(L1=12, L2=10, L3=8)
        self.assertEqual(self.conflicts(), set())

    def test_l5_kommt_ueber_l4_raus_wenn_l3_belegt(self):
        self.park(L5=7, L3=9)
        self.assertEqual(self.conflicts(), set())

    def test_l5_kommt_ueber_l3_raus_wenn_l4_belegt(self):
        self.park(L5=7, L4=9)
        self.assertEqual(self.conflicts(), set())

    def test_l5_steht_fest_wenn_l3_und_l4_belegt(self):
        self.park(L5=7, L3=9, L4=None)
        self.assertEqual(self.conflicts(), {"L3→L5", "L4→L5"})

    def test_kein_konflikt_wenn_einer_vorher_wegfaehrt(self):
        self.park(L5=7, L3=9, L4=6)
        self.assertEqual(self.conflicts(), set())

    def test_l6_ueber_l7_und_l5_wenn_l4_belegt(self):
        self.park(L6=7, L4=9)
        self.assertEqual(self.conflicts(), set())  # L6 → L7 → L5 → L3 → raus

    def test_l6_steht_fest_wenn_l4_und_l7_belegt(self):
        self.park(L6=7, L4=9, L7=9)
        self.assertEqual(self.conflicts(), {"L4→L6", "L7→L6"})

    def test_l6_ueber_freies_l7_stoesst_an_l5(self):
        self.park(L6=7, L4=9, L5=9)
        self.assertEqual(self.conflicts(), {"L4→L6", "L5→L6"})

    def test_l7_meldet_nur_das_erste_hindernis(self):
        # L7: gerade über L5 (belegt) oder schräg über L6 (frei) → dort stößt es an L4
        self.park(L7=7, L5=9, L3=9, L4=9)
        self.assertEqual(self.conflicts(), {"L5→L7", "L4→L7"})

    def test_l7_schraeg_ueber_l6(self):
        self.park(L7=7, L5=9)
        self.assertEqual(self.conflicts(), set())  # L7 → L6 → L4 → raus

    def test_l7_ueber_l5_und_l4_wenn_l6_belegt(self):
        self.park(L7=7, L6=9, L3=9)
        self.assertEqual(self.conflicts(), set())  # L7 → L5 → L4 → raus

    def test_l7_steht_fest_wenn_l5_und_l6_belegt(self):
        self.park(L7=7, L5=9, L6=9)
        self.assertEqual(self.conflicts(), {"L5→L7", "L6→L7"})

    def test_l7_ueber_freies_l5_dann_l3_oder_l4(self):
        self.park(L7=7, L3=9, L4=9)
        self.assertEqual(self.conflicts(), {"L3→L7", "L4→L7"})

    # ── Tür 2 · rechts ─────────────────────────────────────────
    def test_r1_blockiert_beide_spalten(self):
        self.park(R2=7, R5=8, R1=9)
        self.assertEqual(self.conflicts(), {"R1→R2", "R1→R5"})

    def test_r2_nur_ueber_r1(self):
        self.park(R2=7, R1=9)
        self.assertEqual(self.conflicts(), {"R1→R2"})

    def test_r4_ueber_r5_und_r3_wenn_r2_belegt(self):
        self.park(R4=7, R2=9)
        self.assertEqual(self.conflicts(), set())  # R4 → R5 → R3 → R1 → raus

    def test_r5_ueber_r4_und_r2_wenn_r3_belegt(self):
        self.park(R5=7, R3=9)
        self.assertEqual(self.conflicts(), set())  # R5 → R4 → R2 → R1 → raus

    def test_r4_steht_fest_wenn_r2_und_r5_belegt(self):
        self.park(R4=7, R2=9, R5=9)
        self.assertEqual(self.conflicts(), {"R2→R4", "R5→R4"})

    def test_r4_stoesst_auf_beiden_wegen_an_r1(self):
        self.park(R4=7, R2=9, R1=9)
        self.assertEqual(self.conflicts(), {"R2→R4", "R1→R4"})

    # ── Patio ──────────────────────────────────────────────────
    def test_patio_weicht_ueber_die_mitte_aus(self):
        self.park(P2=7, L7=9)
        self.assertEqual(self.conflicts(), set())  # P2 → P3 → R4 → R2 → R1 → raus

    def test_patio_steht_fest_wenn_alle_wege_zu(self):
        self.park(P2=7, L7=9, P1=9, P3=9)
        self.assertEqual(self.conflicts(), {"L7→P2", "P1→P2", "P3→P2"})

    def test_patio_links_ueber_p2_und_l7(self):
        self.park(P1=7, L6=9)
        self.assertEqual(self.conflicts(), set())  # P1 → P2 → L7 → L5 → L3 → raus

    def test_patio_rechts_ganz_hinten(self):
        self.park(P4=7, R5=9, P3=9)
        self.assertEqual(self.conflicts(), {"R5→P4", "P3→P4"})

    # ── Patio-Notweg (rückwärts aufs Patio, nur jetzt-Zustand) ──
    def route(self, code):
        """Notweg für das Auto auf `code`, wenn alle anderen geparkten Autos stehen bleiben."""
        ids = {r[1]: r[0] for r in self.conn.execute("SELECT id, code FROM spot")}
        codes = {v: k for k, v in ids.items()}
        occupied = {r[0] for r in self.conn.execute("SELECT spot_id FROM parking WHERE left_at IS NULL")} - {ids[code]}
        r = rules.patio_route(rules.graph(self.conn), ids[code], occupied, rules.patio_spots(self.conn))
        return None if r is None else ([codes[s] for s in r["reverse"]], [codes[s] for s in r["forward"]])

    def test_notweg_l6_rueckwaerts_auf_p1(self):
        self.park(L6=7, L4=9, L5=9)
        reverse, forward = self.route("L6")
        self.assertEqual(reverse, ["P1"])
        self.assertEqual(forward, ["P2", "P3", "R4", "R2", "R1"])

    def test_kein_notweg_noetig_wenn_l6_ueber_l7_raus_kann(self):
        self.park(L6=7, L4=9)
        self.assertIsNone(self.route("L6"))

    def test_notweg_r2_rueckwaerts_ueber_r4_auf_p3(self):
        self.park(R2=7, R1=9)
        reverse, forward = self.route("R2")
        self.assertEqual(reverse, ["R4", "P3"])
        self.assertEqual(forward, ["P2", "L7", "L5", "L3"])

    def test_notweg_ueber_die_andere_seite(self):
        self.park(L6=7, L4=9, L7=9)
        reverse, forward = self.route("L6")
        self.assertEqual(reverse, ["P1"])
        self.assertEqual(forward, ["P2", "P3", "R4", "R2", "R1"])

    def test_notweg_nicht_noetig_wenn_normal_frei(self):
        self.park(L5=7, L3=9)
        self.assertIsNone(self.route("L5"))

    def test_kein_notweg_wenn_patio_versperrt(self):
        self.park(L6=7, L4=9, P1=9, L7=9, P2=9)
        self.assertIsNone(self.route("L6"))

    def test_kein_notweg_fuer_patio_autos(self):
        self.park(P1=7, L6=9, P2=9)
        self.assertIsNone(self.route("P1"))

    def test_notweg_rechts_von_r4(self):
        self.park(R4=7, R2=9, R5=9)
        reverse, forward = self.route("R4")
        self.assertEqual(reverse, ["P3"])
        self.assertEqual(forward[-1:], ["L3"])  # P3 → P2 → L7 → L5 → L3 (kürzester freier Weg)

    # ── Allgemein ──────────────────────────────────────────────
    def test_unbekannte_ausfahrt_zaehlt_als_blockierer(self):
        self.park(R2=7, R1=None)
        self.assertEqual(self.conflicts(), {"R1→R2"})

    def test_ausserhalb_des_horizonts_keine_warnung(self):
        self.park(R2=40, R1=50)
        self.assertEqual(self.conflicts(), set())

    def test_beispiel_aus_der_aufgabe(self):
        # A blockiert B; B muss um 7, A erst um 9
        self.park(R1=9, R2=7)
        self.assertEqual(self.conflicts(), {"R1→R2"})


if __name__ == "__main__":
    unittest.main()
