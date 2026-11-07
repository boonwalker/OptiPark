# Parkoptimierer – Bauanleitung zum Nachbauen

## 0. Start auf dem iPhone (Claude-App → Claude Code)

Claude Code in der iPhone-App arbeitet in einer **Cloud-Umgebung (Linux)**, die mit einem **GitHub-Repository** verbunden ist. Es gibt dort keinen Zugriff auf deinen Mac und kein Browser-Fenster, um die App anzusehen.

1. **Repository anlegen** (in Safari auf github.com): neues, privates, leeres Repository, z. B. `parkoptimierer`. „Add a README file“ ankreuzen, damit es nicht ganz leer ist.
2. **Diese Datei hochladen:** im Repository „Add file“ → „Upload files“ → `REPRODUKTION.md` (z. B. aus der Dateien-App/iCloud Drive) → „Commit changes“.
3. **Claude-App öffnen** → Claude Code → GitHub verbinden (einmalig) → das Repository wählen. Bei der Umgebung den Netzwerkzugriff auf der Standardstufe lassen (Paketquellen wie PyPI müssen erreichbar sein).
4. **Auftrag eingeben:**
   > *Baue die App exakt nach REPRODUKTION.md. Halte dich wörtlich an Datenmodell, Layout, Regeln, Texte und Design. Prüfe am Ende mit allen beschriebenen Tests (Abschnitt 12), committe alles und pushe den Branch.*
5. Das Ergebnis liegt danach als Branch im Repository (auf Wunsch als Pull Request). Wie man die App dann **benutzt**, steht in Abschnitt 13.

Falls die Sitzung zwischendurch stoppt: einfach „Mach weiter nach REPRODUKTION.md“ schreiben, der bisherige Stand liegt ja im Branch.

Stand: 07.11.2026. Sprache der App und aller Texte: **Deutsch** (Du-Form).

---

## 1. Worum es geht

Am Wohnhaus gibt es einen Anwohner-Parkplatz, auf dem manche Autos andere zuparken. Jeder Nachbar tippt nach dem Heimkommen auf seinen Stellplatz und hinterlegt, wann er wieder losfährt (übliche Zeiten wie „Mo–Fr 07:30“ plus einmalige Fahrten). Die App erkennt daraus automatisch Konflikte („A steht vor B, B muss um 7 raus, A fährt erst um 9“), benachrichtigt beide per Push und lässt sie einen Tausch am Vorabend vereinbaren. Wer gerade zugeparkt ist, kann über „Ich will gleich rausfahren“ alle Blockierer sofort anpingen.

Die Startseite ist ein **animierter Parkplatz in Draufsicht**, die Stellplätze sind anklickbare Rechtecke.

---

## 2. Technik und Umgebung

- **Umgebung:** Claude Code in der Cloud (Linux-Container, Zeitzone UTC), Arbeitsordner = GitHub-Repository. Kein Browser-Fenster, kein macOS-Werkzeug (`sips` usw.). Ob Node.js vorhanden ist, egal: die App braucht es nicht.
- **Backend:** Python **3.9 oder neuer** (was im Container da ist; Code muss mit 3.9 kompatibel bleiben, also z. B. kein `match`, keine `X | Y`-Typannotationen). Fast nur Standardbibliothek (`http.server.ThreadingHTTPServer`, `sqlite3`, `zoneinfo`). Abhängigkeiten in `requirements.txt`:
  ```
  pywebpush>=2.0
  tzdata
  ```
  `pywebpush` bringt `py_vapid` und `cryptography` mit. `tzdata` stellt sicher, dass `ZoneInfo("Europe/Berlin")` auch in schlanken Containern funktioniert. Die App muss auch **ohne** `pywebpush` starten (dann ohne Push, mit Warnung im Log) – falls die Installation im Container scheitert, trotzdem weiterbauen und testen.
- **Frontend:** reines HTML/CSS/JS als PWA, **kein Build-Schritt**, ES-Module, keine externen Bibliotheken, keine externen Fonts.
- **Ordner:** virtuelle Umgebung `.venv/`, Daten `data/` (Datenbank + VAPID-Schlüssel). Beides in `.gitignore`, **der private VAPID-Schlüssel darf nie ins Repository**. `.gitignore`:
  ```
  .venv/
  data/
  __pycache__/
  *.pyc
  .DS_Store
  ```
  (Wer das Repository später auf einem Mac in iCloud Drive auscheckt, setzt `PARK_DATA_DIR=data.nosync`, damit iCloud die Datenbank nicht synchronisiert.)
- Start:
  ```bash
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
  .venv/bin/python -m server.app        # http://localhost:8080
  .venv/bin/python -m server.demo       # Demo-Nachbarn + Anmelde-Links
  .venv/bin/python -m unittest discover tests -v
  ```
- Umgebungsvariablen: `PARK_PORT` (8080), `PARK_HOST` (`0.0.0.0`), `PARK_DATA_DIR` (`data/`), `PARK_INVITE_CODE` (optional, Registrierung nur mit Code), `PARK_VAPID_SUB` (Standard `mailto:parkplatz@example.com`).
- **Prüfen ohne Browser:** Da es in der Cloud-Sitzung kein Browser-Fenster gibt, wird alles über Tests geprüft (Abschnitt 12): Regel-Tests, Rausfahr-Tests und ein API-Durchlauf gegen den echten Server. Zusätzlich, falls `node` vorhanden: `node --check web/app.js web/sw.js` für Syntaxfehler im Frontend.

### Dateien

```
.gitignore, README.md, requirements.txt
tools/make_icons.py      erzeugt die PNG-Icons (ohne Zusatzpakete)
server/__init__.py
server/schema.sql        Datenmodell (wörtlich unten)
server/layout.py         Parkplatz nach Skizze + Wegenetz EXITS (wörtlich unten)
server/rules.py          Wegenetz laden/prüfen, Wegsuche
server/departures.py     nächste Ausfahrt je Auto
server/conflicts.py      Konflikterkennung + Nachrichtentexte + Erinnerungen
server/leave_requests.py „Ich will gleich rausfahren“
server/push.py           Web-Push mit VAPID
server/db.py             Verbindung, Transaktionen, Init + Seed
server/app.py            HTTP-API, statische Dateien, Minuten-Ticker
server/demo.py           Demo-Daten
web/index.html, styles.css, app.js, sw.js, manifest.webmanifest, icon.svg, icon-180/192/512.png
tests/__init__.py, tests/test_rules.py, tests/test_leave_requests.py, tests/test_api.py
```

---

## 3. Datenmodell (`server/schema.sql`, wörtlich)

Zeiten in UTC als `YYYY-MM-DDTHH:MM:SSZ`, wiederkehrende Uhrzeiten lokal (`Europe/Berlin`) als `HH:MM`. Wochentage als Bitmaske Mo=1 … So=64 (Mo–Fr = 31, täglich = 127, Sa–So = 96).

```sql
-- Parkoptimierer – Datenmodell
-- Zeiten werden als ISO-8601 in UTC gespeichert ("2026-11-08T06:00:00Z"),
-- wiederkehrende Uhrzeiten als lokale Zeit "HH:MM" in der Zeitzone des Parkplatzes.

PRAGMA foreign_keys = ON;

------------------------------------------------------------------------------
-- Ort: Parkplatz -> Bereiche -> Stellplätze
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lot (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    timezone    TEXT    NOT NULL DEFAULT 'Europe/Berlin',
    grid_w      INTEGER NOT NULL,            -- Breite des Rasters (Einheiten) für die Darstellung
    grid_h      INTEGER NOT NULL
);

-- Ein Bereich, z. B. "Tür 1 · links". Bereiche gruppieren Stellplätze optisch.
CREATE TABLE IF NOT EXISTS zone (
    id          INTEGER PRIMARY KEY,
    lot_id      INTEGER NOT NULL REFERENCES lot(id) ON DELETE CASCADE,
    code        TEXT    NOT NULL,            -- stabiler Schlüssel, z. B. 'L'
    name        TEXT    NOT NULL,
    grid_x      INTEGER NOT NULL,
    grid_y      INTEGER NOT NULL,
    grid_w      INTEGER NOT NULL,
    grid_h      INTEGER NOT NULL,
    UNIQUE (lot_id, code)
);

-- Ein Stellplatz. Lage im Raster (x/y/w/h) dient der Darstellung UND der
-- Ableitung von Blockierungen (siehe spot_block).
CREATE TABLE IF NOT EXISTS spot (
    id          INTEGER PRIMARY KEY,
    zone_id     INTEGER NOT NULL REFERENCES zone(id) ON DELETE CASCADE,
    code        TEXT    NOT NULL UNIQUE,     -- z. B. 'L1', 'P2'
    kind        TEXT    NOT NULL DEFAULT 'regular' CHECK (kind IN ('regular', 'patio')),
    grid_x      INTEGER NOT NULL,
    grid_y      INTEGER NOT NULL,
    grid_w      INTEGER NOT NULL,
    grid_h      INTEGER NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1
);

-- Wegenetz: Von from_spot kann ein Auto direkt weiterfahren nach to_spot
-- (dieser Platz muss dafür frei sein) oder – bei to_spot NULL – direkt hinaus.
-- Mehrere Zeilen pro from_spot = alternative Wege ("über L3 ODER über L4").
-- Ein Auto kommt raus, wenn es einen Weg zur Ausfahrt über freie Plätze gibt.
-- Gepflegt in server/layout.py (EXITS), geladen über server/rules.py.
DROP TABLE IF EXISTS spot_block;   -- Vorgänger-Modell
CREATE TABLE IF NOT EXISTS spot_exit (
    id           INTEGER PRIMARY KEY,
    from_spot_id INTEGER NOT NULL REFERENCES spot(id) ON DELETE CASCADE,
    to_spot_id   INTEGER REFERENCES spot(id) ON DELETE CASCADE,   -- NULL = hinaus
    CHECK (from_spot_id <> to_spot_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_spot_exit ON spot_exit(from_spot_id, IFNULL(to_spot_id, 0));

------------------------------------------------------------------------------
-- Menschen und Autos
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS resident (
    id            INTEGER PRIMARY KEY,
    lot_id        INTEGER NOT NULL REFERENCES lot(id) ON DELETE CASCADE,
    display_name  TEXT    NOT NULL,
    unit          TEXT,                       -- Wohnung / Klingel, optional
    auth_token    TEXT    NOT NULL UNIQUE,    -- persönlicher Geräteschlüssel
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS car (
    id           INTEGER PRIMARY KEY,
    resident_id  INTEGER NOT NULL REFERENCES resident(id) ON DELETE CASCADE,
    nickname     TEXT    NOT NULL,            -- "Der rote Golf"
    plate        TEXT,
    color        TEXT    NOT NULL DEFAULT '#4f7cff',
    -- Patio-Notweg (rückwärts aufs Patio rangieren): 'ask' = bei Bedarf fragen,
    -- 'never' = kommt für dieses Auto/diesen Nachbarn nie in Frage.
    patio_route  TEXT    NOT NULL DEFAULT 'ask' CHECK (patio_route IN ('ask', 'never')),
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS ix_car_resident ON car(resident_id);

------------------------------------------------------------------------------
-- Ausfahrzeiten
------------------------------------------------------------------------------

-- Übliche Ausfahrzeit, z. B. Mo–Fr 07:00. weekdays ist eine Bitmaske:
-- Mo=1, Di=2, Mi=4, Do=8, Fr=16, Sa=32, So=64  (Mo–Fr = 31).
CREATE TABLE IF NOT EXISTS recurring_departure (
    id           INTEGER PRIMARY KEY,
    car_id       INTEGER NOT NULL REFERENCES car(id) ON DELETE CASCADE,
    weekdays     INTEGER NOT NULL CHECK (weekdays BETWEEN 1 AND 127),
    depart_time  TEXT    NOT NULL CHECK (depart_time GLOB '[0-2][0-9]:[0-5][0-9]'),
    label        TEXT,                        -- "Arbeit"
    active       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_recurring_car ON recurring_departure(car_id);

-- Ausnahme: an diesem (lokalen) Datum fällt die übliche Fahrt aus (Urlaub, Homeoffice).
CREATE TABLE IF NOT EXISTS recurring_skip (
    recurring_departure_id INTEGER NOT NULL REFERENCES recurring_departure(id) ON DELETE CASCADE,
    skip_date              TEXT    NOT NULL,  -- 'YYYY-MM-DD' lokal
    PRIMARY KEY (recurring_departure_id, skip_date)
) WITHOUT ROWID;

-- Einmalige, bekannte nächste Ausfahrt ("Samstag 10:30 Einkaufen").
CREATE TABLE IF NOT EXISTS planned_departure (
    id          INTEGER PRIMARY KEY,
    car_id      INTEGER NOT NULL REFERENCES car(id) ON DELETE CASCADE,
    depart_at   TEXT    NOT NULL,             -- UTC
    note        TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS ix_planned_car_time ON planned_departure(car_id, depart_at);

------------------------------------------------------------------------------
-- Belegung (mit Historie)
------------------------------------------------------------------------------

-- Ein Parkvorgang. Aktuell geparkt = left_at IS NULL.
CREATE TABLE IF NOT EXISTS parking (
    id         INTEGER PRIMARY KEY,
    car_id     INTEGER NOT NULL REFERENCES car(id) ON DELETE CASCADE,
    spot_id    INTEGER NOT NULL REFERENCES spot(id) ON DELETE CASCADE,
    parked_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    left_at    TEXT
);
-- Ein Platz kann nur von einem Auto, ein Auto nur auf einem Platz belegt sein.
CREATE UNIQUE INDEX IF NOT EXISTS ux_parking_spot_active ON parking(spot_id) WHERE left_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_parking_car_active  ON parking(car_id)  WHERE left_at IS NULL;

------------------------------------------------------------------------------
-- Konflikte und Benachrichtigungen
------------------------------------------------------------------------------

-- Ein Konflikt: Auto auf blocker_parking steht noch, wenn das Auto auf
-- blocked_parking ausfahren muss. Pro Parkpaar und Ausfahrzeit genau einmal.
CREATE TABLE IF NOT EXISTS conflict (
    id                  INTEGER PRIMARY KEY,
    blocker_parking_id  INTEGER NOT NULL REFERENCES parking(id) ON DELETE CASCADE,
    blocked_parking_id  INTEGER NOT NULL REFERENCES parking(id) ON DELETE CASCADE,
    blocked_departs_at  TEXT    NOT NULL,     -- wann B raus muss
    blocker_departs_at  TEXT,                 -- wann A voraussichtlich fährt (NULL = unbekannt)
    status              TEXT    NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'swap_agreed', 'acknowledged', 'patio', 'resolved', 'obsolete')),
    blocker_choice      TEXT CHECK (blocker_choice IN ('swap', 'manual')),
    blocked_choice      TEXT CHECK (blocked_choice IN ('swap', 'manual')),
    -- Patio-Notweg für B (frei, ohne dass jemand umparken muss) als JSON
    -- {"reverse": [Platz-Codes], "forward": [...]}; NULL = kein Notweg möglich.
    patio_route         TEXT,
    patio_choice        TEXT CHECK (patio_choice IN ('yes', 'no')),   -- Bs Antwort auf die Rückfrage
    notified_at         TEXT,
    reminded_at         TEXT,
    created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    closed_at           TEXT,
    UNIQUE (blocker_parking_id, blocked_parking_id, blocked_departs_at)
);
CREATE INDEX IF NOT EXISTS ix_conflict_status ON conflict(status);

-- "Ich will gleich rausfahren": spontane Anfrage eines zugeparkten Autos.
-- Offen, bis der Weg frei ist (cleared), der Fragende abbricht oder sie nach
-- einer Stunde verfällt. Pro Parkvorgang höchstens eine offene Anfrage.
CREATE TABLE IF NOT EXISTS leave_request (
    id              INTEGER PRIMARY KEY,
    parking_id      INTEGER NOT NULL REFERENCES parking(id) ON DELETE CASCADE,
    status          TEXT    NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'cleared', 'cancelled', 'expired')),
    created_at      TEXT    NOT NULL,
    last_pinged_at  TEXT    NOT NULL,     -- letzte Benachrichtigung (Nachklingeln)
    closed_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_leave_request_open ON leave_request(parking_id) WHERE status = 'open';

-- Wer für eine Anfrage Platz machen muss, und was er geantwortet hat.
CREATE TABLE IF NOT EXISTS leave_request_blocker (
    request_id     INTEGER NOT NULL REFERENCES leave_request(id) ON DELETE CASCADE,
    parking_id     INTEGER NOT NULL REFERENCES parking(id) ON DELETE CASCADE,
    response       TEXT CHECK (response IN ('coming', 'later')),
    eta_minutes    INTEGER,
    responded_at   TEXT,
    PRIMARY KEY (request_id, parking_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS push_subscription (
    id          INTEGER PRIMARY KEY,
    resident_id INTEGER NOT NULL REFERENCES resident(id) ON DELETE CASCADE,
    endpoint    TEXT    NOT NULL UNIQUE,
    p256dh      TEXT    NOT NULL,
    auth        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS ix_push_resident ON push_subscription(resident_id);

-- Einfacher Änderungszähler, damit Clients billig auf Updates prüfen können.
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;
INSERT OR IGNORE INTO meta(key, value) VALUES ('version', '0');
```

`db.py`:
- `connect()`: `isolation_level=None`, `row_factory=sqlite3.Row`, `PRAGMA foreign_keys=ON`, `journal_mode=WAL`.
- `tx()`: Kontextmanager mit globalem `threading.Lock`, `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`. `read()`: einfache Leseverbindung.
- `init()`: Ordner anlegen, Schema per `executescript`, dann `_migrate()` (ältere Datenbanken: Spalte `car.patio_route` per `ALTER TABLE` ergänzen; fehlt `conflict.patio_choice`, die abgeleitete Tabelle `conflict` löschen und neu anlegen), beim ersten Mal Seed aus `layout.py` (lot, zones, spots), danach **immer** `rules.load_exits(conn)`.
- `bump_version(conn)`: erhöht `meta.version` (Clients pollen das).
- Hilfen: `utcnow()` (ohne Mikrosekunden), `iso(dt)`, `parse_iso(s)`.

---

## 4. Parkplatz-Layout und Blockierungsregeln (`server/layout.py`, wörtlich)

Nach der Handskizze: zwei Bereiche „Tür 1 · links“ und „Tür 2 · rechts“, getrennt durch eine Trennwand, unten je zwei gestrichelte Patio-Plätze. **Zufahrt oben.** Die Autos **parken rückwärts ein und fahren vorwärts hinaus** (Front/Scheinwerfer zeigen nach oben). Links neben L1–L3 liegt eine freie Fahrspur. Die Trennwand endet **vor** dem Patio, dort können Autos zwischen links und rechts wechseln.

```python
"""Parkplatz-Layout nach der Skizze.

Raster: 1 Einheit ≈ 0,5 m. Ein Stellplatz ist 4 × 6 Einheiten (hochkant).
Die Zufahrt liegt oben (Seite mit "Tür 1" / "Tür 2"), die Patio-Plätze unten.

    Tür 1 · links             Tür 2 · rechts
    ┌───────────────┐ │ ┌───────────────┐
    │         [L1]  │ │ │               │
    │         [L2]  │ │ │               │
    │         [L3]  │ │ │     [R1]      │
    │  [L4]   [L5]  │ │ │ [R2]    [R3]  │
    │  [L6]   [L7]  │ │ │ [R4]    [R5]  │
    ├───────────────┤ │ ├───────────────┤
    │  (P1)   (P2)  │ │ │ (P3)    (P4)  │   Patio
    └───────────────┘ │ └───────────────┘
"""

LOT = {"name": "Parkplatz", "timezone": "Europe/Berlin", "grid_w": 26, "grid_h": 45}

ZONES = [
    {"code": "L", "name": "Tür 1 · links", "grid_x": 0, "grid_y": 0, "grid_w": 12, "grid_h": 45},
    {"code": "R", "name": "Tür 2 · rechts", "grid_x": 14, "grid_y": 0, "grid_w": 12, "grid_h": 45},
]

W, H = 4, 6                      # Stellplatzgröße
ROW_Y = [2, 9, 16, 23, 30]       # Reihen 1–5
PATIO_Y = 38
# x-Positionen innerhalb eines Bereichs (relativ zum Bereich)
COL_LEFT, COL_RIGHT, COL_CENTER = 1, 7, 4


def _spot(zone, code, x, y, kind="regular"):
    zx = next(z["grid_x"] for z in ZONES if z["code"] == zone)
    return {"zone": zone, "code": code, "kind": kind,
            "grid_x": zx + x, "grid_y": y, "grid_w": W, "grid_h": H}


SPOTS = [
    # Tür 1 · links – rechte Spalte durchgehend, linke Spalte nur unten
    _spot("L", "L1", COL_RIGHT, ROW_Y[0]),
    _spot("L", "L2", COL_RIGHT, ROW_Y[1]),
    _spot("L", "L3", COL_RIGHT, ROW_Y[2]),
    _spot("L", "L4", COL_LEFT, ROW_Y[3]),
    _spot("L", "L5", COL_RIGHT, ROW_Y[3]),
    _spot("L", "L6", COL_LEFT, ROW_Y[4]),
    _spot("L", "L7", COL_RIGHT, ROW_Y[4]),
    _spot("L", "P1", COL_LEFT, PATIO_Y, "patio"),
    _spot("L", "P2", COL_RIGHT, PATIO_Y, "patio"),
    # Tür 2 · rechts – ein mittiger Platz, darunter zwei Spalten
    _spot("R", "R1", COL_CENTER, ROW_Y[2]),
    _spot("R", "R2", COL_LEFT, ROW_Y[3]),
    _spot("R", "R3", COL_RIGHT, ROW_Y[3]),
    _spot("R", "R4", COL_LEFT, ROW_Y[4]),
    _spot("R", "R5", COL_RIGHT, ROW_Y[4]),
    _spot("R", "P3", COL_LEFT, PATIO_Y, "patio"),
    _spot("R", "P4", COL_RIGHT, PATIO_Y, "patio"),
]

# ---------------------------------------------------------------------------
# Blockierungsregeln als Wegenetz (festgelegt in Schritt 2)
#
# Für jeden Platz: über welche Plätze kann ein Auto rausfahren?
#   OUT       = direkt hinaus (Fahrspur / Zufahrt oben)
#   ["A","B"] = alternative Wege: über Platz A ODER über Platz B
# Ein Weg über einen Platz setzt voraus, dass dieser Platz frei ist; von dort
# geht es mit dessen eigenen Wegen weiter.
#
# Tür 1 · links: Links neben L1–L3 liegt eine Fahrspur. L1–L3 und L4 fahren
#   direkt hinaus. L5 kommt über L3 (gerade) oder über L4 (schräg in die Spur).
#   L6 nur über L4. L7 über L5 (gerade) oder schräg über L6 – von dort weiter
#   wie L5 bzw. L6, also auch L7 → L5 → L4, wenn L6 belegt ist. Patio dahinter.
# Tür 2 · rechts: R1 fährt direkt hinaus und steht mittig vor beiden Spalten.
# Patio: Die Trennwand endet vor dem Patio. Patio-Autos können seitlich über
#   freie Nachbar-Patioplätze fahren – auch über die Mitte (P2 ↔ P3) – und
#   so auf der anderen Seite hinaus.
# ---------------------------------------------------------------------------
OUT = None
EXITS = {
    "L1": [OUT], "L2": [OUT], "L3": [OUT], "L4": [OUT],
    "L5": ["L3", "L4"],
    "L6": ["L4"],
    "L7": ["L5", "L6"],
    "R1": [OUT],
    "R2": ["R1"], "R3": ["R1"],
    "R4": ["R2"], "R5": ["R3"],
    "P1": ["L6", "P2"],
    "P2": ["L7", "P1", "P3"],
    "P3": ["R4", "P2", "P4"],
    "P4": ["R5", "P3"],
}
```

### Regel-Logik (`server/rules.py`)

- `load_exits(conn)`: schreibt `layout.EXITS` in `spot_exit` (Zeile pro Weg, `to_spot_id NULL` = hinaus). Prüft: jeder aktive Platz hat eine Regel, keine unbekannten Codes, jeder Platz kommt bei leerem Parkplatz raus, sonst `ValueError`.
- `graph(conn)`: `{spot_id: [ziel_spot_id oder None, …]}`.
- `_explore(moves, start, obstacles)`: Tiefensuche von `start` über freie Plätze. Liefert `(kommt_raus, frontier)`. `frontier` = Hindernis-Plätze, an die man über freie Plätze direkt stößt.
- `can_leave(...)` → `kommt_raus`.
- `blockers(moves, start, obstacles)` → leere Menge, wenn raus, sonst `frontier`.
- `patio_spots(conn)` → IDs der Patio-Plätze.
- `patio_route(moves, start, obstacles, patios)` → **Patio-Notweg** oder `None`. Nur für Autos auf normalen Plätzen, die regulär nicht rauskommen. Phase 1: Breitensuche **rückwärts** (entgegen den Pfeilen des Wegenetzes, also über Plätze, die über den aktuellen Platz rausfahren würden) durch freie Plätze; jeder erreichte Patio-Platz wird gemerkt. Phase 2: von jedem erreichten Patio-Platz (in Reihenfolge des Erreichens) Breitensuche **vorwärts** auf den normalen Wegen durch freie Plätze bis hinaus. Ergebnis `{"reverse": [Plätze bis einschließlich Patio-Platz], "forward": [Plätze danach]}`. Beispiele: L6 mit belegtem L4 → `reverse [P1]`, `forward [P2, L7, L5, L3]`; ist zusätzlich L7 belegt → `forward [P2, P3, R4, R2, R1]`.
- `clearing_set(moves, start, obstacles)` → Liste von **Schichten**: erst `frontier`, dann so tun, als wären die weg, nächste `frontier` … bis ein Weg frei ist. Schichten mit mehreren Plätzen sind Alternativen.

---

## 5. Nächste Ausfahrt (`server/departures.py`)

`next_departures(conn, car_ids, now)` → `{car_id: {"at": datetime_utc, "source": "planned"|"recurring", "label": str|None}}`:
- früheste `planned_departure` mit `depart_at > now` (Label = `note`),
- übliche Fahrten: für die nächsten **8 Tage** in Lot-Zeitzone; Tag passt zur Bitmaske (`(weekdays >> weekday()) & 1`), nicht in `recurring_skip`, Zeitpunkt > now; erste Fundstelle je Regel,
- das Früheste gewinnt.

---

## 6. Konflikterkennung (`server/conflicts.py`)

Konstanten: `HORIZON = 36 h`, `REMIND_BEFORE = 45 min`, `ACTIVE = ("open","swap_agreed","acknowledged")`.

`find_blockings(conn, now)`:
- alle aktiven Parkvorgänge laden, nächste Ausfahrten berechnen.
- Für jedes Auto **B** mit Ausfahrt innerhalb des Horizonts: `still_there` = Plätze aller anderen Autos, deren Ausfahrt **später** ist oder unbekannt (gleichzeitig oder früher blockiert nicht).
- `rules.blockers(moves, B.spot, still_there)` → für jeden Platz ein Eintrag `(blocker_pid, blocked_pid, iso(B.at)) → iso(A.at)|None`.

`recompute(conn, now)` (gibt Benachrichtigungen zurück, verschickt wird erst nach dem Commit):
1. Aktive Konflikte, die nicht mehr gewünscht sind → `resolved` (wenn einer der Parkvorgänge beendet ist) sonst `obsolete`, `closed_at` setzen.
2. Neue → einfügen mit `notified_at` + Nachrichten an beide. `obsolete`, die wieder zutreffen → wieder `open`, Entscheidungen zurücksetzen, neu benachrichtigen. Bestehende → `blocker_departs_at` aktualisieren.
3. Erinnerungen: aktive Konflikte mit `reminded_at IS NULL` und Ausfahrt von B in ≤ 45 min (und noch nicht vorbei) → Nachricht an A, `reminded_at` setzen.

Zeitformat `fmt_when`: „heute 07:00“, „morgen 07:00“, „übermorgen 07:00“, sonst „Mo 10.11. 07:00“; `None` → „unbekannt“.

Nachrichten (`resident_id, title, body, url="/#konflikt-<id>", tag="conflict-<id>"`):
- An A: Titel „Du blockierst {B}“, Text „{B} muss {wann B} raus ({B-Platz}), du fährst erst {wann A}. Heute Abend tauschen?“
- An B: „{A} steht vor dir“, „Du musst {wann B} raus, {A} ({A-Platz}) fährt erst {wann A}. Heute Abend tauschen?“
- Gleicher Nachbar auf beiden Seiten: nur eine Nachricht „Du stehst dir selbst im Weg“.
- Nach einer Entscheidung (`choice_messages`): beide wollen tauschen → an beide „Tausch vereinbart“, „{A-Platz} ↔ {B-Platz}: Bitte heute noch umparken und in der App „Getauscht“ tippen.“; einer schlägt Tausch vor → an den anderen „{X} möchte tauschen“, „{A-Platz} ↔ {B-Platz} – bist du einverstanden?“; A wählt „manual“ → an B „{A} lässt dich raus“, „{A} fährt {wann B} rechtzeitig zur Seite.“
- Erinnerung an A: „Gleich: {B} muss raus“, „{B-Auto} auf {B-Platz} fährt {wann} – dein Auto auf {A-Platz} steht davor.“

Statuslogik bei `choice` (`swap`|`manual`): beide `swap` → `swap_agreed`; sonst Blocker `manual` → `acknowledged`; sonst `open`.
**Patio-Notweg** (Notlösung, nur mit Rückfrage):
- Rückwärts aufs schmale Patio rangieren geht nur mit manchen Autos und nicht jeder will das. Deshalb wird der Weg **nur** angeboten, wenn er komplett frei ist (niemand muss umparken), also als einzige Lösung ohne einen anderen Nachbarn, und B wird **immer vorher gefragt**.
- In `find_blockings`: Hat B Blockierer und ist `car.patio_route` von B nicht `never`, wird `rules.patio_route` **vorsichtig** berechnet: Hindernisse sind **alle jetzt geparkten Autos** außer B (auch solche, die vor B wegfahren, denn sie könnten zurückkommen). Der Weg wird als JSON mit Platz-Codes am Konflikt gespeichert (`patio_route`), sonst `NULL`. Der Wert in `wanted` ist `{"blocker_at", "patio_route"}`.
- `derive_status(blocker_choice, blocked_choice, patio_route, patio_choice)`: Notweg vorhanden und `patio_choice = 'yes'` → `patio`; sonst wie bisher (`swap_agreed` / `acknowledged` / `open`). `ACTIVE` enthält `patio`.
- Bei jeder Neuberechnung: Fällt der Notweg weg (jemand parkt darauf), wird `patio_choice` auf `NULL` gesetzt (wird er später wieder frei, fragt die App neu) und der Status neu bestimmt. War er `patio`, gehen an A und B: „Patio-Notweg ist versperrt“ – „{B} kommt nicht mehr übers Patio raus. Bitte klärt den Konflikt ({A-Platz} ↔ {B-Platz}).“
- Neue Konflikte mit Notweg: an A „Du blockierst {B}“ – „… {B} wird gefragt, ob der Patio-Notweg in Frage kommt.“ (A erfährt es **sofort**); an B „{A} steht vor dir“ – „Du musst … raus, {A} ({Platz}) fährt erst …. Notlösung: {Weg}. Kommt das für dich in Frage?“
- `fmt_route`: `rückwärts auf P1, dann über P2 → L7 → L5 → L3 hinaus` bzw. bei mehreren Rückwärts-Plätzen `rückwärts über L7 auf P2, dann über …`.
- Antwort von B (`patio_yes`/`patio_no`, nur die blockierte Seite, nur wenn ein Notweg gespeichert ist, sonst 409 „Der Patio-Notweg steht hier nicht zur Wahl“): Ja → an A „{B} weicht übers Patio aus“ – „Du musst nichts tun.“; Nein → an A „{B} kann nicht übers Patio ausweichen“ – „{A-Platz} steht vor {B-Platz}. Heute Abend tauschen?“.
- Im Status `patio` bekommt A **keine** 45-Minuten-Erinnerung.

**Tausch ausführen** (`/swap`, nur bei `swap_agreed` oder gleicher Nachbar): beide Parkvorgänge beenden, über Kreuz neu anlegen. Danach löst `recompute` den Konflikt automatisch auf.

---

## 7. „Ich will gleich rausfahren“ (`server/leave_requests.py`)

`PING_COOLDOWN = 3 min`, `EXPIRE_AFTER = 1 h`, `ETA_LATER = 15` Minuten. Eigene Ausnahme `RequestError(status, message)` (vom HTTP-Handler wie `ApiError` behandelt).

- **create**: Fehler 409, wenn schon offen („Deine Anfrage läuft schon“), Auto nicht geparkt oder frei („Du kommst raus – niemand steht im Weg“). Sonst `clearing_set` über **alle** jetzt geparkten Autos (ohne Zeitbezug), Anfrage + alle Blockierer aller Schichten speichern, Blockierer benachrichtigen. **Eigene Autos werden nicht benachrichtigt.**
  - Nachricht: Titel „{Name} will gleich rausfahren“, Text „Dein {Auto} auf {Platz} steht {Name} ({Platz}) im Weg. Bitte kurz umparken.“ + bei Alternativen in derselben Schicht „ Alternativ könnte auch {X} ({Platz}) oder … Platz machen.“ URL `/#raus-<id>`, tag `leave-<id>`.
- **respond** (`coming`|`later`): an den Fragenden „{Name} kommt sofort“ bzw. „{Name} braucht noch ~15 Min.“, Text „Auto auf {Platz} wird umgeparkt.“ Fehler 403, wenn man nicht Blockierer ist.
- **ping**: frühestens 3 Min. nach dem letzten Ping (sonst 429 „Bitte noch N Min. warten“). Erinnert alle, die nicht `coming` geantwortet haben. Titel „Erinnerung: {Name} wartet“.
- **cancel**: Status `cancelled`.
- **reconcile** (nach jeder Änderung und jede Minute): ausgeparkt → `cleared`; Weg frei → `cleared` + Nachricht „Weg ist frei 🚗“ / „Du kannst jetzt rausfahren.“; älter als 1 h → `expired`; sonst neu hinzugekommene Blockierer nachtragen und benachrichtigen.
- **for_resident**: offene Anfragen, bei denen der Nachbar fragt (`role: requester`) oder im Weg steht (`role: blocker`), mit `requester_name/car/spot/car_id`, `created_at`, `next_ping_at`, `blockers: [{parking_id, layer, name, car, spot, resident_id, response, eta_minutes, responded_at}]` (Blockierer jeweils aktuell berechnet).

---

## 8. Push (`server/push.py`)

- Beim Start VAPID-Schlüssel aus `<PARK_DATA_DIR>/vapid_private.pem` laden oder erzeugen (`py_vapid.Vapid`). Öffentlicher Schlüssel = base64url (ohne `=`) des unkomprimierten Punkts (X962).
- `send_async(messages)`: Thread; für jede Nachricht alle Abos des Nachbarn, `webpush(..., ttl=6h)`, Payload JSON `{title, body, url, tag}`. Antwort 404/410 → Abo löschen.

---

## 9. HTTP-API (`server/app.py`)

Eigener Mini-Router (`@route(method, pattern, auth=True)`, `<name>`-Platzhalter). Auth: `Authorization: Bearer <auth_token>`. Fehler als `{"error": "…"}` mit Status. JSON-Body max. 64 kB. Alle schreibenden Routen laufen über `@mutation`: Transaktion → Funktion → `housekeeping(conn, now)` (= `conflicts.recompute` + `leave_requests.reconcile`) → `bump_version` → nach Commit Push verschicken. Ein Hintergrund-Thread macht dasselbe **jede Minute** (Version nur erhöhen, wenn sich etwas geändert hat).

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/version` (ohne Auth) | `{version}` |
| GET | `/api/state` (Auth optional) | Gesamtzustand, s. u. |
| POST | `/api/register` (ohne Auth) | `{display_name, unit?, invite_code?}` → `{id, token}` |
| PATCH | `/api/me` | Name, Wohnung |
| POST / PATCH / DELETE | `/api/cars`, `/api/cars/<id>` | Auto anlegen/ändern/entfernen (`nickname` Pflicht ≤ 30, `plate` ≤ 15, `color` `#rrggbb`). Ein PATCH nur mit `{patio_route: "ask"|"never"}` ändert allein die Notweg-Einstellung. Löschen = `active=0` + Parkvorgang beenden |
| POST | `/api/cars/<id>/recurring` | `{weekdays 1–127, depart_time HH:MM, label?}` |
| DELETE | `/api/recurring/<id>` | |
| POST / DELETE | `/api/recurring/<id>/skip`, `/api/recurring/<id>/skip/<date>` | Tag auslassen / rückgängig |
| POST | `/api/cars/<id>/planned` | `{depart_at ISO, note?}` (muss in der Zukunft liegen) |
| DELETE | `/api/planned/<id>` | |
| POST | `/api/park` | `{car_id, spot_id, depart_at?, note?}`; belegt → 409 „Der Platz ist schon belegt“; Umparken beendet alten Parkvorgang |
| POST | `/api/leave` | `{car_id}`; beendet Parkvorgang, löscht einmalige Fahrten bis now+1 h |
| POST | `/api/conflicts/<id>/choice` | `{choice: swap|manual|patio_yes|patio_no}` → `{status}` |
| POST | `/api/conflicts/<id>/swap` | Tausch durchgeführt |
| POST | `/api/cars/<id>/leave-request` | „Ich will gleich rausfahren“ |
| POST | `/api/leave-requests/<id>/ping`, `/cancel` | nur der Fragende |
| POST | `/api/leave-requests/<id>/respond` | `{parking_id, response: coming|later}`, nur Besitzer dieses Parkvorgangs |
| POST | `/api/push/subscribe`, `/unsubscribe`, `/test` | Push-Abo (Endpoint muss `https://` sein) |

`/api/state` liefert: `version, now, lot{name,timezone,grid_w,grid_h}, zones[], spots[{id,zone_id,code,kind,grid_*, occupant|null}], exits[[from,to|null]], horizon_hours, push{public_key}, invite_required, me|null, conflicts[], leave_requests[]`.
- `occupant`: `parking_id, car_id, color, parked_at, next_departure{at,source,label}|null`; **nur für Angemeldete** zusätzlich `nickname, resident_id, resident_name`.
- `me`: `id, display_name, unit, push_subscriptions (Anzahl), cars[{id,nickname,plate,color,spot_id,next_departure,recurring[{id,weekdays,depart_time,label,skips[]}],planned[{id,depart_at,note}]}]`.
- `conflicts`: aktive Konflikte des Nachbarn (Details aus `conflict_details`: Status, Entscheidungen, Zeiten, Namen, Autos, Platz-Codes beider Seiten, `patio_route`, `patio_choice`) + `role: blocker|blocked` + `patio_text` (lesbarer Weg).
- `me.cars[]` zusätzlich `patio_route` (Einstellung) und `patio_now`: der Notweg **jetzt** (alle geparkten Autos als Hindernis) als `{reverse, forward}` mit Codes, nur wenn das Auto geparkt ist, die Einstellung nicht `never` ist und ein Notweg nötig und frei ist; sonst `null`.
- `occupant` zusätzlich `patio_route` (Einstellung des Autos).
- `patio_reservations`: alle Konflikte im Status `patio`: `{resident_id, name, from_spot, at, spots: [Codes des Wegs], text}`. Wer dort parkt, versperrt den Notweg.

Statische Dateien aus `web/` (Fallback `index.html`, Schutz gegen `..`), `Cache-Control: no-cache`, für `sw.js` zusätzlich `Service-Worker-Allowed: /`, `.webmanifest` als `application/manifest+json`.

---

## 10. Frontend

### Design
Dunkles Theme, mobil zuerst (max. 560 px breit, zentriert), Schrift `ui-rounded, "SF Pro Rounded", system-ui, …`. Tokens:

```css
--bg:#16191f; --panel:#1f232b; --panel-2:#272c36; --line:#333a46; --text:#eef1f6; --muted:#9aa3b2;
--accent:#5b8cff; --accent-2:#8fb0ff; --good:#3ecf8e; --warn:#ff6b5b; --amber:#ffb547;
--asphalt:#2a2e35; --asphalt-2:#24282e; --paint:rgba(255,255,255,.82); --radius:16px;
```
Autofarben zur Auswahl: `#5b8cff #ff6b5b #3ecf8e #ffb547 #b57cff #ff7ab6 #2ec4d6 #e9ecf2 #7c8594 #2b3240`.
`prefers-reduced-motion` schaltet alle Animationen ab.

### Seitenaufbau
- Sticky Kopfzeile (Blur): Logo „P“ + „Parkplatz“, rechts runder Avatar (Initiale, Ring in der Farbe des ersten Autos) → Profil bzw. Onboarding.
- **Statuskarte**: je eigenem Auto eine Zeile: Farbstreifen, „{Auto} steht auf {Platz}“ + „Nächste Ausfahrt: …“ + Button „Losgefahren“ oder „{Auto} ist unterwegs“ / „Zurück? Tippe auf einen freien Platz.“. Ist das Auto **jetzt** zugeparkt und keine Anfrage offen → großer Button „🚗 Ich will gleich rausfahren“. Ohne Anmeldung: „Willkommen!“ + „Loslegen“. Ohne Auto: „Noch kein Auto“ + „Auto anlegen“.
- **Kartenbereich**: zuerst Rausfahr-Anfragen, dann Konflikte (Details unten).
- **Parkplatz**, darunter Legende (Dein Auto / Frei – antippen zum Parken / Konflikt).

### Der Parkplatz
- Container mit Seitenverhältnis `grid_w:grid_h` (26:45), Breite 100 %, max. `(100dvh − 150px)·26/45`, mindestens 300 px, Ecken 22 px, Asphalt aus Verlauf + SVG-Rauschen + zwei warmen Laternen-Lichtflecken, oben ein „atmendes“ Laternenlicht (6 s). Einblend-Animation.
- Alles absolut im Raster positioniert über CSS-Variablen `--x/--y/--w/--h` (Prozent von `grid_w/grid_h`).
- Deko: oben je Bereich Torleiste mit Bereichsnamen (Großbuchstaben, gesperrt, gelb-schwarze Streifen links/rechts). Pfeile ↓ in freien Rasterzellen oberhalb der Stellplätze (sanftes Auf-und-ab, versetzt). Patio-Fläche als Pflastermuster ab 1,5 Einheiten über dem obersten Patio-Platz mit Beschriftung „PATIO“; zwischen den Bereichen ebenfalls Pflaster (Durchgang). Mittelstreifen (Bordstein + Hecke) zwischen den Bereichen **nur bis zum Patio**.
- **Stellplätze**: `<button>` mit weißer Linie (Patio: gestrichelt), Code unten (ausgeblendet, wenn belegt), gestaffeltes Einploppen beim Laden, Hover/Active-Effekt. Klassen: `occupied`, `mine`, `selected` (blauer Rahmen), `rel-blocks` (orange: fährt über diesen Platz raus), `rel-blocked-by` (blau: liegt auf dem Weg nach draußen), `conflict-bay` (rot pulsierend), `wait-bay` (wartet auf Rausfahren, gelb pulsierend), `move-bay` (muss Platz machen, gelb). Ist ein eigenes Auto unterwegs, pulsieren freie Plätze leicht blau (`body.can-park`).
- **Autos**: eigene Ebene, eine SVG-Draufsicht je Auto (viewBox 0 0 40 64, Front **oben**): Spiegel, Karosserie in Autofarbe mit Glanzverlauf, Windschutzscheibe oben (Trapez), Dach heller, Heckscheibe unten, Scheinwerfer oben (`#fff6d0`), Rückleuchten unten (rot). Vorname des Besitzers auf dem Dach (nur angemeldet). Eigene Autos mit farbigem Leuchten und pulsierendem Ring.
  - **Einparken**: von oberhalb des Parkplatzes nach unten zum Platz (rückwärts), mit leichtem Nachfedern; währenddessen leuchten die Rückfahrscheinwerfer weiß (`reversing`). Beim ersten Laden gestaffelt nach den Buchten.
  - **Ausfahren**: kurz anrucken, dann nach oben aus dem Bild, ausblenden, Scheinwerferkegel nach vorne (`driving`).
  - **Platzwechsel** (Tausch, Umparken): FLIP-Animation von alter zu neuer Position (1,4 s).
- **Linien** (SVG-Ebene, Prozentkoordinaten): offene Konflikte rot gestrichelt (laufend) vom Blocker zum Blockierten mit Punkt; Rausfahr-Anfragen gelb von jedem Blockierer zum Wartenden.

### Interaktion beim Antippen eines Platzes (Bottom-Sheet)
- Nicht angemeldet → Onboarding. Kein Auto → Auto anlegen.
- **Frei** → „Auf {Platz} parken“, Untertitel „{Bereich} · Ausfahrt {direkt | direkt oder über … | über L3 oder L4}“. Autoauswahl (bei mehreren). „Wann fährst du als Nächstes?“: Chips „Wie üblich · {wann}“ / „Wie geplant · {wann}“ (falls bekannt), „Andere Zeit“ (Datum/Uhrzeit + Schnellwahl „in 1 Std.“, „morgen 7:00“, „morgen 9:00“), „Weiß ich noch nicht“. **Live-Vorschau** mit derselben Wegsuche wie der Server: „⚠️ Du würdest {Name} ({Platz}, fährt …) zuparken.“, „⚠️ {Name} ({Platz}, fährt …) steht vor dir.“ bzw. bei mehreren „… und … stehen vor dir – einer davon müsste vorher weg.“, sonst „✓ Kein Konflikt mit deinen Nachbarn.“; gibt es Konflikte und einen konfliktfreien freien Platz: „Tipp: Auf {Platz} gäbe es keinen Konflikt.“ + „Dorthin“. Bei „Weiß ich noch nicht“ und Autos dahinter: Hinweis, dass man dann als Blockierer gilt. Käme ein zugeparkter Nachbar nur noch über den Notweg raus (Frontend-Kopie von `patio_route`, Einstellung nicht `never`), steht hinter seinem Namen „, käme nur noch über den Patio-Notweg raus“. Liegt der Platz auf einem zugesagten Notweg eines **anderen** Nachbarn (`patio_reservations`): „⚠️ {Name} will {wann} über diesen Platz übers Patio raus ({Weg}). Wenn du hier parkst, ist dieser Notweg zu.“ (zählt für den Tipp „konfliktfreier Platz“ als Konflikt). Button „Hier geparkt“ bzw. „Von {alt} hierher umparken“.
- **Eigenes Auto** → „{Auto} · {Platz}“, „Geparkt …“, nächste Ausfahrt (einmalig/üblich), Ausfahrt-Beschreibung, Listen „Ausfahrt über (einer muss frei sein)“ und „Fährt über diesen Platz raus“. Buttons: ggf. „🚗 Ich will gleich rausfahren“, „Losgefahren“, „Andere Ausfahrzeit eintragen“, „Übliche Fahrt {heute/morgen …} fällt aus“, „Geplante Fahrt löschen“.
- **Fremdes Auto** → Name, Auto, seit wann, nächste Ausfahrt, dieselben Weg-Listen.

### Konflikt-Karten
Rot getönt (offen), grün (vereinbart/zugesagt). Je nach Rolle und Entscheidung:
- Blocker, offen: „Du blockierst {B}“ – „{B} muss **{wann}** raus, du fährst erst {wann}.“ – „Heute Abend tauschen“ / „Ich fahre {HH:MM} zur Seite“.
- Blockierter, offen: „{A} steht vor dir“ – „Tausch vorschlagen“ / „Wir klären das morgens“.
- Gegenseite hat Tausch vorgeschlagen: „{X} möchte heute Abend tauschen“ – „Einverstanden“ / „Nein, ich fahre zur Seite“ bzw. „Nein danke“.
- Selbst vorgeschlagen: „Warte auf {X}“ (Blocker kann noch „Doch nicht – ich fahre zur Seite“).
- `swap_agreed`: „Tausch vereinbart mit {X}“ – „Getauscht ✓“.
- `acknowledged`: „Du lässt {B} raus“ / „{A} lässt dich raus“ – „Doch lieber heute tauschen“.
- Gleicher Nachbar: „Du stehst dir selbst im Weg“ – „Umgeparkt ✓“.
- Notweg gespeichert, B hat noch nicht geantwortet (und noch keine Tausch-Entscheidung): B sieht „{A} steht vor dir“, Info-Kasten „**Notlösung ohne {A}:** {Weg}. Das Patio ist schmal und braucht etwas Rangieren. Der Weg ist jetzt frei; parkt bis dahin jemand darauf, sagt dir die App Bescheid.“, dann „**Kommt das für dich in Frage?**“ – „Ja, ich fahre übers Patio“ / „Nein, kommt nicht in Frage“. A sieht die normale Karte mit Info-Kasten „{B} wird gerade gefragt, ob der Patio-Notweg in Frage kommt. Du kannst trotzdem schon einen Tausch anbieten.“
- `patio` (grün): B „Du fährst übers Patio raus“ – „Zugesagt: {Weg}. Parkt bis {wann} jemand auf diesem Weg, sagt dir die App Bescheid.“ – „Doch nicht“ (= `patio_no`); A „{B} weicht übers Patio aus“ – „Du musst nichts tun. Wird der Patio-Weg zugeparkt, meldet sich die App wieder.“
Darunter klein: „{A-Platz} steht vor {B-Platz}“. Toast nach „Ja“: „Alles klar – gute Fahrt übers Patio“. Toasts: „Tausch-Wunsch gesendet“, „Tausch vereinbart 🤝“, „Plätze getauscht 🎉“.

### Rausfahr-Karten (gelb getönt)
- Fragender: „Du willst raus – Anfrage läuft“, „{Auto} auf {Platz} · seit N Min.“, Liste der Blockierer mit Status („✓ kommt sofort“, „⏱ in ~15 Min.“, „… noch keine Antwort“, „dein eigenes Auto“), Hinweis bei Alternativen, „🔔 Nochmal klingeln“, „Hat sich erledigt“, „Nachklingeln ab HH:MM möglich. Ist der Weg frei, bekommst du Bescheid.“
- Blockierer (pulsierender gelber Rahmen): „🚗 {Name} will gleich rausfahren“, „Dein {Auto} auf **{Platz}** steht im Weg ({Platz}). Bitte kurz umparken.“, ggf. Alternativen, „Komme sofort“ / „Dauert ~15 Min.“, nach Antwort grüner Hinweis.
- Toast nach dem Start: „{Namen} wurde(n) benachrichtigt“.
- **Vorher Notweg-Rückfrage:** Hat das Auto `patio_now`, öffnet „Ich will gleich rausfahren“ zuerst ein Sheet „Notlösung übers Patio?“ – „Gerade steht dir jemand im Weg. Ohne einen Nachbarn zu stören, kämst du so raus:“ {Weg} – Hinweis zum schmalen Patio – Buttons „Ja, ich fahre übers Patio“ (Toast „Gute Fahrt übers Patio! Tippe danach auf „Losgefahren“.“, keine Anfrage), „Nein, Nachbarn fragen“ (Anfrage wie gewohnt), „Kommt für mein Auto nie in Frage“ (Einstellung auf `never`, dann Anfrage).

### Profil (Sheet)
Name, Wohnung, Speichern. Liste der Autos (Farbe, Name, Kennzeichen, übliche Zeiten) → Auto-Editor. „+ Auto hinzufügen“. Benachrichtigungen (Status, „Auf diesem Gerät aktivieren“, „Test senden“, Hinweis für iPhone: Teilen → „Zum Home-Bildschirm“). „Anmelde-Link kopieren“ (`/#login=<token>` für weitere Geräte). „Auf diesem Gerät abmelden“ (mit Rückfrage).

### Auto-Editor (Sheet)
Name, Kennzeichen, Farbkreise, Speichern. Bei bestehendem Auto zusätzlich: übliche Ausfahrzeiten (Liste mit ×, ausgelassene Tage mit „rückgängig“; neu: 7 Wochentags-Chips, Uhrzeit, Anlass), einmalige Ausfahrten (Liste mit ×; neu: Datum/Uhrzeit + Notiz), Abschnitt „Patio-Notweg“ („Rückwärts aufs schmale Patio rangieren und darüber rausfahren. Die App schlägt das nur als Notlösung vor und fragt dich jedes Mal vorher.“, Chips „Bei Bedarf fragen“ / „Kommt nie in Frage“), „Auto entfernen“.

### Onboarding (4 Schritte, Fortschrittsbalken)
1. „Willkommen auf dem Parkplatz 👋“ – Name, Wohnung (optional), ggf. Einladungscode → registrieren, Token in `localStorage` (`park.token`).
2. Auto anlegen (Auto-Editor).
3. „Wann fährst du normalerweise los?“ – Mo–Fr vorausgewählt, 07:30, Anlass „Arbeit“ – „Speichern“ / „Keine feste Zeit“.
4. „Benachrichtigungen“ – „Benachrichtigungen erlauben“ / „Später“ → Toast „Fertig! Tippe auf deinen Stellplatz.“
Öffnet sich automatisch ~1 s nach dem ersten Laden, wenn nicht angemeldet.

### Sonstiges Verhalten
- Polling alle 5 s auf `/api/version`, bei Änderung kompletter `/api/state`; beim Zurückkehren in den Tab sofort.
- Deep-Links: `#login=<token>` (anmelden, Hash entfernen), `#konflikt-<id>` / `#raus-<id>` (zur Karte scrollen, aufblinken).
- `localStorage` immer in try/catch. Alle Nutzertexte HTML-escapen.
- Zeiten im Frontend in der Zeitzone des Parkplatzes formatieren (wie `fmt_when`).

### PWA
- `manifest.webmanifest`: Name „Parkplatz“, `display: standalone`, Farben `#16191f`, Icons 192/512 PNG + SVG.
- `sw.js`: `skipWaiting`/`clients.claim`; `push` → `showNotification(title, {body, tag, renotify, icon:'/icon-192.png', data:{url}})`; `notificationclick` → vorhandenes Fenster fokussieren und zur URL navigieren, sonst neues öffnen.
- Icon, Motiv (viewBox 64×64): dunkles abgerundetes Quadrat `#2a2e35` (Radius 14), zwei weiße Stellplatz-Rahmen (x 9 und 35, y 12, 20×40, Linie 2, 80 % Deckkraft), darin ein blaues Auto (`#5b8cff`, x 12,5 y 16, 13×26, Radius 5) und ein rotes, tiefer stehendes (`#ff6b5b`, x 38,5 y 22, 13×26, Radius 5).
  - `web/icon.svg` mit genau diesem Motiv.
  - `web/icon-180.png`, `icon-192.png`, `icon-512.png` erzeugt `tools/make_icons.py` **ohne Zusatzpakete**: dasselbe Motiv mit einfacher Rasterung (abgerundete Rechtecke, Kantenglättung per 4×4-Supersampling) und eigenem PNG-Schreiber über `zlib` + `struct` (RGBA). Ist Pillow zufällig installiert, darf es stattdessen genutzt werden. Die PNGs werden committet.

---

## 11. Demo-Daten (`server/demo.py`)

Legt (falls noch nicht vorhanden) an und gibt Anmelde-Links `http://localhost:8080/#login=<token>` aus:

| Name | Wohnung | Auto | Farbe | Platz | Ausfahrt |
|---|---|---|---|---|---|
| Anna | EG links | Polo | #ff6b5b | L1 | Mo–Fr 09:00 Arbeit |
| Ben | EG rechts | Golf | #3ecf8e | L2 | Mo–Fr 07:00 Arbeit |
| Clara | 1. OG | Mini | #ffb547 | L4 | Mo–Fr 08:15 Schule |
| Deniz | 2. OG | Tesla | #e9ecf2 | R1 | einmalig in 20 h „Ausflug“ |
| Emil | 2. OG | Kombi | #b57cff | R3 | Di–Sa 06:30 Frühschicht (Maske 62) |

---

## 12. Tests (müssen alle grün sein, aktuell 41)

`tests/test_rules.py` (Hilfsmethode `park(L5=7, L3=9, L4=None)` = Platz → Stunden bis zur Ausfahrt, `None` = unbekannt; Ergebnis als Menge `"Blocker→Blockierter"`):

| Fall | Erwartung |
|---|---|
| L1=12, L2=10, L3=8 | kein Konflikt (Fahrspur) |
| L5=7, L3=9 | keiner (über L4) |
| L5=7, L4=9 | keiner (über L3) |
| L5=7, L3=9, L4=unbekannt | L3→L5, L4→L5 |
| L5=7, L3=9, L4=6 | keiner |
| L6=7, L4=9 | L4→L6 |
| L7=7, L5=9, L3=9, L4=9 | L5→L7, L4→L7 |
| L7=7, L5=9 | keiner (schräg über L6) |
| L7=7, L6=9, L3=9 | keiner (L5 → L4) |
| L7=7, L5=9, L6=9 | L5→L7, L6→L7 |
| L7=7, L3=9, L4=9 | L3→L7, L4→L7 |
| R2=7, R5=8, R1=9 | R1→R2, R1→R5 |
| R4=7, R2=9, R1=9 | R2→R4 |
| P2=7, L7=9 | keiner (über die Mitte nach rechts) |
| P2=7, L7=9, P1=9, P3=9 | L7→P2, P1→P2, P3→P2 |
| P1=7, L6=9 | keiner (P2 → L7 → …) |
| P4=7, R5=9, P3=9 | R5→P4, P3→P4 |
| L6=7, L4=unbekannt | L4→L6 |
| L6=40, L4=50 | keiner (außerhalb 36 h) |
| L4=9, L6=7 | L4→L6 (Beispiel aus der Aufgabe) |

Notweg (`rules.patio_route`, alle anderen geparkten Autos als Hindernis):

| Fall | Erwartung |
|---|---|
| L6, L4 belegt | rückwärts `[P1]`, vorwärts `[P2, L7, L5, L3]` |
| L6, L4 und L7 belegt | rückwärts `[P1]`, vorwärts `[P2, P3, R4, R2, R1]` |
| L5, L3 belegt | `None` (normal über L4 frei) |
| L6, L4, P1, L7, P2 belegt | `None` |
| P1, L6 und P2 belegt | `None` (Patio-Autos haben keinen Notweg) |
| R4, R2 belegt | rückwärts `[P3]`, vorwärts endet auf `L3` |

`tests/test_patio.py` (eigene Nachbarn je Name):
- Ben L6 (7 h), Clara L4 (9 h) → Konflikt mit `patio_route.reverse = [P1]`; Bens Nachricht enthält „rückwärts auf P1“ und „Kommt das für dich in Frage?“, Claras „wird gefragt“.
- Bens Auto `never` → `patio_route` ist `NULL`.
- Zusätzlich P1 und L7 belegt, die **vor** Ben wegfahren → trotzdem kein Notweg (vorsichtig).
- Zusage (`patio_choice yes`, Status `patio`) → `patio_messages` an Clara „Ben weicht übers Patio aus“; Neuberechnung ändert nichts; dann parken Deniz auf P1 und Emil auf L7 (unbekannte Ausfahrt) → Status `open`, `patio_route` und `patio_choice` `NULL`, Nachrichten „Patio-Notweg ist versperrt“ an genau Ben und Clara.
- Status `patio` und Bens Ausfahrt in 30 Min. → keine „Gleich:“-Erinnerung an Clara.
- `fmt_route({"reverse": ["L7","P2"], "forward": ["P3","R4","R2","R1"]})` = „rückwärts über L7 auf P2, dann über P3 → R4 → R2 → R1 hinaus“.

`tests/test_leave_requests.py`:
- Schichten: L7 mit L5, L6, L3, L4 belegt → `[{L5,L6},{L3,L4}]`; L7 mit L5, L6, L4 belegt → `[{L5,L6}]`; L5 mit nur L3 belegt → `[]`.
- Ablauf: Ben L5, Anna L3, Clara L4 → Anfrage benachrichtigt Anna + Clara (Text enthält „Alternativ“); Anna „coming“ → Nachricht an Ben „… kommt sofort“; sofortiges Nachklingeln → Fehler; nach 4 Min. → nur Clara; Anna fährt weg → `reconcile` liefert „Weg ist frei 🚗“, Status `cleared`.
- Anfrage bei freiem Weg → Fehler; zweite offene Anfrage → Fehler; nach 61 Min. → `expired`; eigenes Auto als Blocker → keine Nachricht; `for_resident` liefert Rolle `blocker`/`requester`.

Diese Tests nutzen ein temporäres `PARK_DATA_DIR` und rollen jede Transaktion zurück.

`tests/test_api.py` (**neu, ersetzt den Browser-Test**): startet den echten Server in einem Thread auf einem freien Port mit eigenem temporären Datenordner. Dafür stellt `server/app.py` neben `main()` eine Funktion `make_server(host, port)` bereit, die DB und Push initialisiert und den `ThreadingHTTPServer` zurückgibt, ohne `serve_forever` aufzurufen. Der Test spricht nur per `urllib` mit der API:
1. `GET /api/state` ohne Anmeldung: 16 Stellplätze, 24 Wege in `exits`, `me` ist `null`.
2. Statische Dateien: `/` enthält „Parkplatz“; `/sw.js` hat einen Content-Type, der mit `application/javascript` beginnt, und `Service-Worker-Allowed: /`; `/manifest.webmanifest` hat `application/manifest+json`.
3. Anna und Ben registrieren, je ein Auto. Ben parkt auf L6 (Ausfahrt in 10 h), Anna auf L4 (in 12 h). Anna will zusätzlich L6 → 409.
4. Ohne Anmeldung zeigt `/api/state` für L4 keinen `resident_name`.
5. Ben sieht einen Konflikt mit Rolle `blocked`, `blocker_spot` L4, `blocked_spot` L6.
6. `/swap` sofort → 409. Ben `choice: swap` → `open`, Anna `choice: swap` → `swap_agreed`, dann `/swap` → danach steht Bens Auto auf L4, Annas auf L6, keine Konflikte mehr.
7. Anna (L6, hinter Ben auf L4) startet `/leave-request` → Bens Zustand enthält eine Anfrage mit Rolle `blocker`. Annas sofortiges `/ping` → 429 (Nachklingeln erst nach 3 Min.). Ben antwortet `coming` → Annas Anfrage zeigt `response: coming`.
8. Ben fährt weg (`/api/leave`) → Annas `leave_requests` ist leer; in der Datenbank hat die Anfrage den Status `cleared`.
9. `/leave-request` für Anna jetzt → 409 („niemand steht im Weg“).

Ergänzend im API-Test: Nach Schritt 6 parkt Anna neu so, dass Ben auf L6 hinter Anna auf L4 steht; Bens Konflikt hat einen `patio_text`, Anna darf nicht `patio_yes` wählen (409), Ben schon (→ `patio`), danach enthält `patio_reservations` Bens Weg. (Die übrigen Schritte entsprechend anpassen.)

Am Ende: `python -m unittest discover tests -v` → **alle grün** (41 aus den Tabellen oben + der API-Test).

---

## 13. Ergebnis anschauen und benutzen

Die Cloud-Sitzung kann die App bauen und testen, aber **nicht anzeigen**: Der Server läuft dort nur kurz und ist vom iPhone aus nicht erreichbar. Um sie zu sehen oder zu benutzen:

- **Am Mac ausprobieren:** Repository herunterladen (GitHub Desktop oder `git clone`), dann die Startbefehle aus Abschnitt 2 ausführen und `http://localhost:8080` öffnen. Ein iPhone im selben WLAN kann `http://<IP-des-Macs>:8080` öffnen; Push funktioniert so aber nicht (braucht HTTPS).
- **Für die Nachbarn dauerhaft:** auf einem kleinen Server mit **HTTPS** betreiben (z. B. VPS mit Caddy als Reverse-Proxy) oder bei einem Anbieter, der Python-Apps mit **dauerhaftem Speicher** hostet (SQLite und der VAPID-Schlüssel müssen Neustarts überleben, `PARK_DATA_DIR` auf diesen Speicher zeigen lassen). Die Hosting-Dateien kann eine spätere Claude-Code-Sitzung auf Wunsch ergänzen.
- Auf dem iPhone muss die App für Push über Teilen → „Zum Home-Bildschirm“ installiert und von dort geöffnet werden (iOS 16.4+).

## 14. Artefakt-Version (optional)

Zusätzlich gibt es eine Version als claude.ai-Artefakt (`artifact/`): dieselbe Oberfläche, aber ohne Python-Server. Daten liegen im gemeinsamen Artefakt-Speicher (`residents/{nutzer-id}` mit Autos und Zeiten, nur selbst schreibbar; `spots/{platz}`; `decisions/{konflikt}`; `requests/{id}`), Identität über das Claude-Konto, alle Regeln (Wegenetz, Konflikte, Notweg) werden in der Seite berechnet. Keine Push-Nachrichten, stattdessen Hinweise in der offenen Seite. Ohne Speicher zeigt sie eine gekennzeichnete Demo. `artifact/build.py` setzt die Seite aus `web/styles.css`, `web/index.html` und `artifact/app.js` zusammen.

## 15. Offene Punkte

- Push auf echten Handys ist ungetestet.
- Anmeldung ist bewusst einfach (persönlicher Token-Link, optional Einladungscode).
