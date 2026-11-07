"""Tests für „Ich will gleich rausfahren“."""
import os
import tempfile
import unittest
from datetime import timedelta

os.environ.setdefault("PARK_DATA_DIR", tempfile.mkdtemp(prefix="park-test-"))

from server import db, leave_requests as lr, rules  # noqa: E402
from server.db import iso, utcnow  # noqa: E402

db.init()


class LeaveRequests(unittest.TestCase):
    def setUp(self):
        self.now = utcnow()
        self.conn = db.connect()
        self.conn.execute("BEGIN")
        self.lot = self.conn.execute("SELECT id FROM lot").fetchone()[0]
        self.pid, self.rid = {}, {}

    def tearDown(self):
        self.conn.execute("ROLLBACK")
        self.conn.close()

    def park(self, **spots):
        """park(L5="Ben", L3="Anna") – jeder Name ist ein eigener Nachbar mit einem Auto."""
        for code, name in spots.items():
            if name not in self.rid:
                self.rid[name] = self.conn.execute(
                    "INSERT INTO resident(lot_id, display_name, auth_token) VALUES (?, ?, ?)",
                    (self.lot, name, os.urandom(8).hex())).lastrowid
            car = self.conn.execute("INSERT INTO car(resident_id, nickname) VALUES (?, ?)",
                                    (self.rid[name], f"Auto {name}")).lastrowid
            sid = self.conn.execute("SELECT id FROM spot WHERE code = ?", (code,)).fetchone()[0]
            self.pid[code] = self.conn.execute(
                "INSERT INTO parking(car_id, spot_id) VALUES (?, ?)", (car, sid)).lastrowid

    def leave(self, code):
        self.conn.execute("UPDATE parking SET left_at = ? WHERE id = ?", (iso(self.now), self.pid[code]))

    def layers(self, code):
        spot = lambda c: self.conn.execute("SELECT id FROM spot WHERE code = ?", (c,)).fetchone()[0]
        codes = {r[0]: r[1] for r in self.conn.execute("SELECT id, code FROM spot")}
        occupied = {r[0] for r in self.conn.execute("SELECT spot_id FROM parking WHERE left_at IS NULL")} - {spot(code)}
        return [{codes[s] for s in layer} for layer in rules.clearing_set(rules.graph(self.conn), spot(code), occupied)]

    # ── Wer muss weg? ─────────────────────────────────────────
    def test_kette_l7_alle_schichten(self):
        # L7 → L5 → L3/L4 oder L7 → L6 → L4; L6 belegt → erst L5 und L6, dann L3 oder L4
        self.park(L7="Ben", L5="Anna", L6="Emil", L3="Clara", L4="Deniz")
        self.assertEqual(self.layers("L7"), [{"L5", "L6"}, {"L3", "L4"}])

    def test_kette_l7_mit_freiem_l3(self):
        self.park(L7="Ben", L5="Anna", L6="Emil", L4="Deniz")
        self.assertEqual(self.layers("L7"), [{"L5", "L6"}])

    def test_frei(self):
        self.park(L5="Ben", L3="Anna")
        self.assertEqual(self.layers("L5"), [])

    # ── Ablauf ────────────────────────────────────────────────
    def test_ablauf_bis_weg_frei(self):
        self.park(L5="Ben", L3="Anna", L4="Clara")
        rid, notes = lr.create(self.conn, self.pid["L5"], self.now)
        self.assertEqual({n["resident_id"] for n in notes}, {self.rid["Anna"], self.rid["Clara"]})
        self.assertIn("Alternativ", notes[0]["body"])

        notes = lr.respond(self.conn, rid, self.pid["L3"], "coming", self.now)
        self.assertEqual(notes[0]["resident_id"], self.rid["Ben"])
        self.assertIn("kommt sofort", notes[0]["title"])

        with self.assertRaises(lr.RequestError):  # Nachklingeln erst nach 3 Minuten
            lr.ping(self.conn, rid, self.now)
        notes = lr.ping(self.conn, rid, self.now + timedelta(minutes=4))
        self.assertEqual([n["resident_id"] for n in notes], [self.rid["Clara"]])  # Anna kommt ja schon

        self.leave("L3")
        notes = lr.reconcile(self.conn, self.now)
        self.assertEqual(notes[0]["title"], "Weg ist frei 🚗")
        status = self.conn.execute("SELECT status FROM leave_request WHERE id = ?", (rid,)).fetchone()[0]
        self.assertEqual(status, "cleared")

    def test_anfrage_wenn_frei_wird_abgelehnt(self):
        self.park(L1="Ben")
        with self.assertRaises(lr.RequestError):
            lr.create(self.conn, self.pid["L1"], self.now)

    def test_nur_eine_offene_anfrage(self):
        self.park(L6="Ben", L4="Anna")
        lr.create(self.conn, self.pid["L6"], self.now)
        with self.assertRaises(lr.RequestError):
            lr.create(self.conn, self.pid["L6"], self.now)

    def test_verfaellt_nach_einer_stunde(self):
        self.park(L6="Ben", L4="Anna")
        rid, _ = lr.create(self.conn, self.pid["L6"], self.now)
        lr.reconcile(self.conn, self.now + timedelta(minutes=61))
        status = self.conn.execute("SELECT status FROM leave_request WHERE id = ?", (rid,)).fetchone()[0]
        self.assertEqual(status, "expired")

    def test_eigenes_auto_wird_nicht_benachrichtigt(self):
        self.park(L6="Ben", L4="Ben")
        _, notes = lr.create(self.conn, self.pid["L6"], self.now)
        self.assertEqual(notes, [])

    def test_ansicht_fuer_blockierer(self):
        self.park(L6="Ben", L4="Anna")
        lr.create(self.conn, self.pid["L6"], self.now)
        view = lr.for_resident(self.conn, self.rid["Anna"], self.now)
        self.assertEqual(view[0]["role"], "blocker")
        self.assertEqual(view[0]["requester_name"], "Ben")
        self.assertEqual(lr.for_resident(self.conn, self.rid["Ben"], self.now)[0]["role"], "requester")


if __name__ == "__main__":
    unittest.main()
