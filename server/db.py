import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from . import layout, rules

ROOT = Path(__file__).resolve().parent.parent
# ".nosync" hält die Datenbank aus der iCloud-Synchronisierung heraus.
DATA_DIR = Path(os.environ.get("PARK_DATA_DIR", ROOT / "data.nosync"))
DB_PATH = DATA_DIR / "parking.db"

_write_lock = threading.Lock()


def utcnow():
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def parse_iso(s):
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def tx():
    """Schreibtransaktion. Ein Prozess, mehrere Threads → serialisieren."""
    with _write_lock:
        conn = connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()


@contextmanager
def read():
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


def bump_version(conn):
    conn.execute("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version'")


def init():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    schema = (Path(__file__).parent / "schema.sql").read_text()
    conn = connect()
    conn.executescript(schema)
    _migrate(conn, schema)
    conn.close()
    with tx() as conn:
        if conn.execute("SELECT COUNT(*) FROM lot").fetchone()[0] == 0:
            _seed(conn)
        rules.load_exits(conn)


def _migrate(conn, schema):
    """Ältere Datenbanken auf den aktuellen Stand bringen."""
    cols = lambda table: {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
    if "patio_route" not in cols("car"):
        conn.execute("ALTER TABLE car ADD COLUMN patio_route TEXT NOT NULL DEFAULT 'ask' "
                     "CHECK (patio_route IN ('ask', 'never'))")
    if "patio_choice" not in cols("conflict"):
        # Konflikte sind abgeleitete Daten: Tabelle neu anlegen (neuer Status 'patio').
        conn.execute("DROP TABLE conflict")
        conn.executescript(schema)


def _seed(conn):
    l = layout.LOT
    lot_id = conn.execute(
        "INSERT INTO lot(name, timezone, grid_w, grid_h) VALUES (?, ?, ?, ?)",
        (l["name"], l["timezone"], l["grid_w"], l["grid_h"])).lastrowid
    zone_ids = {}
    for z in layout.ZONES:
        zone_ids[z["code"]] = conn.execute(
            "INSERT INTO zone(lot_id, code, name, grid_x, grid_y, grid_w, grid_h) VALUES (?,?,?,?,?,?,?)",
            (lot_id, z["code"], z["name"], z["grid_x"], z["grid_y"], z["grid_w"], z["grid_h"])).lastrowid
    for s in layout.SPOTS:
        conn.execute(
            "INSERT INTO spot(zone_id, code, kind, grid_x, grid_y, grid_w, grid_h) VALUES (?,?,?,?,?,?,?)",
            (zone_ids[s["zone"]], s["code"], s["kind"], s["grid_x"], s["grid_y"], s["grid_w"], s["grid_h"]))
