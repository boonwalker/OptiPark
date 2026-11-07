"""Blockierungsregeln: Wegenetz laden und auswerten.

Ein Auto auf Platz S kommt raus, wenn es im Wegenetz (Tabelle spot_exit) einen
Weg von S nach draußen gibt, der nur über freie Plätze führt.

"Frei" ist relativ zu einem Zeitpunkt: Für die Konfliktprüfung zählen nur die
Autos als Hindernis, die zur Ausfahrzeit des betroffenen Autos noch dastehen.
"""
from collections import defaultdict

from . import layout


def load_exits(conn):
    """Schreibt layout.EXITS in spot_exit und prüft, dass jeder Platz rauskommt."""
    ids = {r["code"]: r["id"] for r in conn.execute("SELECT id, code FROM spot WHERE active = 1")}
    missing = set(ids) - set(layout.EXITS)
    unknown = {t for targets in layout.EXITS.values() for t in targets if t} | set(layout.EXITS)
    unknown -= set(ids)
    if missing or unknown:
        raise ValueError(f"Wegenetz unvollständig – ohne Regel: {sorted(missing)}, unbekannt: {sorted(unknown)}")

    rows = [(ids[f], ids[t] if t else None) for f, targets in layout.EXITS.items() for t in targets]
    conn.execute("DELETE FROM spot_exit")
    conn.executemany("INSERT INTO spot_exit(from_spot_id, to_spot_id) VALUES (?, ?)", rows)

    moves = graph(conn)
    stuck = [code for code, sid in ids.items() if not can_leave(moves, sid, set())]
    if stuck:
        raise ValueError(f"Diese Plätze haben keinen Weg nach draußen: {stuck}")
    return len(rows)


def graph(conn):
    """{spot_id: [nächster Platz oder None (= hinaus), ...]}"""
    moves = defaultdict(list)
    for f, t in conn.execute("SELECT from_spot_id, to_spot_id FROM spot_exit"):
        moves[f].append(t)
    return moves


def _explore(moves, start, obstacles):
    """Läuft von start über freie Plätze. Gibt (kommt_raus, berührte_Hindernisse) zurück."""
    seen, stack, frontier, out = {start}, [start], set(), False
    while stack:
        s = stack.pop()
        for t in moves.get(s, ()):
            if t is None:
                out = True
            elif t in obstacles:
                frontier.add(t)
            elif t not in seen:
                seen.add(t)
                stack.append(t)
    return out, frontier


def can_leave(moves, start, obstacles):
    return _explore(moves, start, obstacles)[0]


def patio_spots(conn):
    return {r[0] for r in conn.execute("SELECT id FROM spot WHERE kind = 'patio' AND active = 1")}


def patio_route(moves, start, obstacles, patios):
    """Notweg: rückwärts über freie Plätze bis aufs Patio, dann auf normalen Wegen hinaus.

    Nur für Autos auf normalen Plätzen, die regulär nicht rauskommen, und nur,
    wenn der ganze Weg frei ist (niemand muss dafür umparken). Rückwärts geht es
    entgegen den normalen Fahrtrichtungen des Wegenetzes.
    Gibt {"reverse": [...], "forward": [...]} (Platz-IDs in Fahrreihenfolge) oder None.
    """
    if start in patios or can_leave(moves, start, obstacles):
        return None
    rev = defaultdict(list)
    for f, targets in moves.items():
        for t in targets:
            if t is not None:
                rev[t].append(f)

    def chain(parent, end):
        out = []
        while end is not None:
            out.append(end)
            end = parent[end]
        return out[::-1]

    back, queue, reached = {start: None}, [start], []
    while queue:                                  # Phase 1: rückwärts bis aufs Patio
        s = queue.pop(0)
        for y in rev.get(s, ()):
            if y in obstacles or y in back:
                continue
            back[y] = s
            queue.append(y)
            if y in patios:
                reached.append(y)
    for p in reached:                             # Phase 2: vom Patio vorwärts hinaus
        fwd, q = {p: None}, [p]
        while q:
            s = q.pop(0)
            for t in moves.get(s, ()):
                if t is None:
                    return {"reverse": chain(back, p)[1:], "forward": chain(fwd, s)[1:]}
                if t in obstacles or t in fwd:
                    continue
                fwd[t] = s
                q.append(t)
    return None


def clearing_set(moves, start, obstacles):
    """Alle Hindernisse, die weg müssen, damit das Auto auf start jetzt rauskommt.

    Schichtweise: erst die direkt angrenzenden Hindernisse, dann – als wären die
    weg – die nächsten, bis ein Weg frei ist. Bei Alternativen (L5: über L3 oder
    L4) landen beide in derselben Schicht; einer von beiden würde genügen.
    Gibt eine Liste von Schichten (Mengen von Plätzen) zurück, leer = frei.
    """
    remaining, layers = set(obstacles), []
    while True:
        out, frontier = _explore(moves, start, remaining)
        if out or not frontier:
            return layers
        layers.append(frontier)
        remaining -= frontier


def blockers(moves, start, obstacles):
    """Hindernis-Plätze, die das Auto auf start festsetzen (leer, wenn es rauskommt).

    Gemeldet werden nur die Hindernisse, an die das Auto über freie Plätze
    direkt heranreicht – also die, die als Erste weg müssten.
    """
    out, frontier = _explore(moves, start, obstacles)
    return set() if out else frontier
