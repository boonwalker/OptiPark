"""Tests für die Sprachen: Jeder Nachbar bekommt Nachrichten in seiner Sprache."""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

os.environ.setdefault("PARK_DATA_DIR", tempfile.mkdtemp(prefix="park-test-"))

from server import conflicts, db, i18n, leave_requests  # noqa: E402
from server.db import iso, utcnow  # noqa: E402

db.init()


class Uebersetzung(unittest.TestCase):
    def test_platzhalter_und_fallback(self):
        self.assertEqual(i18n.t("en", "{name} steht vor dir", name="Ben"), "Ben is parked in front of you")
        self.assertEqual(i18n.t("de", "{name} steht vor dir", name="Ben"), "Ben steht vor dir")
        self.assertEqual(i18n.t("en", "Gibt es nicht"), "Gibt es nicht")   # keine Übersetzung → Deutsch
        self.assertEqual(i18n.norm("fr"), "de")

    def test_zeit_und_weg_auf_englisch(self):
        tz = ZoneInfo("Europe/Berlin")
        now = datetime(2026, 11, 9, 12, 0, tzinfo=timezone.utc)            # Montag
        self.assertEqual(conflicts.fmt_when(now + timedelta(days=1), now, tz, "en"), "tomorrow 13:00")
        self.assertEqual(conflicts.fmt_when(now + timedelta(days=4), now, tz, "en"), "Fri 13 Nov 13:00")
        self.assertEqual(conflicts.fmt_when(now + timedelta(days=4), now, tz, "de"), "Fr 13.11. 13:00")
        route = {"reverse": ["P1"], "forward": ["P2", "L7"]}
        self.assertEqual(conflicts.fmt_route(route, "en"), "reverse onto P1, then out via P2 → L7")
        self.assertEqual(conflicts.fmt_route(route), "rückwärts auf P1, dann über P2 → L7 hinaus")

    def test_jede_englische_vorlage_hat_dieselben_platzhalter(self):
        import re
        for de, en in i18n.EN.items():
            self.assertEqual(set(re.findall(r"\{(\w+)\}", de)), set(re.findall(r"\{(\w+)\}", en)), de)


class NachrichtenJeSprache(unittest.TestCase):
    def setUp(self):
        self.now = utcnow()
        self.conn = db.connect()
        self.conn.execute("BEGIN")
        self.lot = self.conn.execute("SELECT id FROM lot").fetchone()[0]
        self.rid, self.pid = {}, {}

    def tearDown(self):
        self.conn.execute("ROLLBACK")
        self.conn.close()

    def park(self, code, name, hours, lang="de", patio="never"):
        self.rid[name] = self.conn.execute(
            "INSERT INTO resident(lot_id, display_name, auth_token, lang) VALUES (?, ?, ?, ?)",
            (self.lot, name, os.urandom(8).hex(), lang)).lastrowid
        car = self.conn.execute("INSERT INTO car(resident_id, nickname, patio_route) VALUES (?, ?, ?)",
                                (self.rid[name], f"Auto {name}", patio)).lastrowid
        sid = self.conn.execute("SELECT id FROM spot WHERE code = ?", (code,)).fetchone()[0]
        self.pid[code] = self.conn.execute("INSERT INTO parking(car_id, spot_id) VALUES (?, ?)", (car, sid)).lastrowid
        if hours is not None:
            self.conn.execute("INSERT INTO planned_departure(car_id, depart_at) VALUES (?, ?)",
                              (car, iso(self.now + timedelta(hours=hours))))

    def test_konflikt_englisch_und_deutsch_gemischt(self):
        self.park("L6", "Ben", 7, lang="en")
        self.park("L4", "Clara", 9, lang="de")
        notes = conflicts.recompute(self.conn, self.now)
        to_ben = next(n for n in notes if n["resident_id"] == self.rid["Ben"])
        to_clara = next(n for n in notes if n["resident_id"] == self.rid["Clara"])
        self.assertEqual(to_ben["title"], "Clara is parked in front of you")
        self.assertIn("Swap spots this evening?", to_ben["body"])
        self.assertEqual(to_clara["title"], "Du blockierst Ben")
        self.assertIn("Heute Abend tauschen?", to_clara["body"])

    def test_patio_rueckfrage_auf_englisch(self):
        self.park("L6", "Ben", 7, lang="en", patio="ask")
        self.park("L4", "Clara", 9, lang="en")
        notes = conflicts.recompute(self.conn, self.now)
        to_ben = next(n for n in notes if n["resident_id"] == self.rid["Ben"])
        self.assertIn("Fallback: reverse onto P1", to_ben["body"])
        self.assertIn("Does that work for you?", to_ben["body"])

    def test_rausfahr_anfrage_auf_englisch(self):
        self.park("L6", "Ben", 7, lang="de")
        self.park("L4", "Clara", 9, lang="en")
        rid, notes = leave_requests.create(self.conn, self.pid["L6"], self.now)
        self.assertEqual(notes[0]["title"], "Ben wants to leave now")
        self.assertIn("Your Auto Clara on L4 is in the way of Ben (L6)", notes[0]["body"])
        with self.assertRaises(leave_requests.RequestError) as e:
            leave_requests.ping(self.conn, rid, self.now)
        self.assertRegex(i18n.t("en", e.exception.message, **e.exception.values), r"^Please wait \d+ more min\.$")


if __name__ == "__main__":
    unittest.main()
