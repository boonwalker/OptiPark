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
    lang          TEXT    NOT NULL DEFAULT 'de' CHECK (lang IN ('de', 'en', 'es')),  -- Sprache für Nachrichten
    away_from     TEXT,                       -- „Nicht da“: ab (NULL = sofort) …
    away_until    TEXT,                       -- … bis (NULL = keine Abwesenheit); das Auto bleibt stehen
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
