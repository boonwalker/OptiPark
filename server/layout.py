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
