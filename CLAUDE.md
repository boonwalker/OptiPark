# Parkoptimierer

App für den Anwohner-Parkplatz am Wohnhaus einer Bekannten des Nutzers. Autos parken teils hintereinander und blockieren sich. Jeder Nachbar tippt nach dem Parken auf seinen Stellplatz und hinterlegt, wann er wieder losfährt. Die App erkennt Konflikte („A steht vor B, B muss um 7 raus, A erst um 9“), benachrichtigt beide und lässt sie einen Tausch am Vorabend vereinbaren.

- **In erster Linie eine mobile App fürs Smartphone.** Alles zuerst für Handy-Breite (ca. 375 px) gestalten und dort prüfen; Bedienung mit dem Daumen (große Tippflächen, wichtige Knöpfe unten, Bottom-Sheets statt Dialoge), Rand-Abstände für Notch und Home-Leiste beachten. Heute ist es eine installierbare Web-App (PWA, „Zum Home-Bildschirm“); Desktop ist zweitrangig. Ob später eine native App für App Store / Play Store kommt, vorher mit dem Nutzer klären.
- **Sprache:** Oberfläche, Nachrichten, Kommentare und Kommunikation mit dem Nutzer auf **Deutsch**, Nutzer in der App per **Du**.
- **Nutzer:** kein Entwickler. Erklärungen einfach halten, Fachbegriffe vermeiden. Bei unklaren Parkplatz-Regeln **nachfragen statt raten**, mit kleinen Skizzen der Optionen. Der Nutzer kennt den Parkplatz, du nicht.

## Aufbau

```
server/          Python-Backend (fast nur Standardbibliothek, http.server + sqlite3)
  schema.sql       Datenmodell
  layout.py        Parkplatz nach Handskizze + Wegenetz EXITS (die Blockierungsregeln)
  rules.py         Wegsuche: kommt ein Auto raus? wer steht im Weg? Patio-Notweg
  departures.py    nächste Ausfahrt je Auto (übliche + einmalige Zeiten)
  conflicts.py     Konflikterkennung, Nachrichtentexte, Erinnerungen
  leave_requests.py  „Ich will gleich rausfahren“
  push.py          Web-Push (VAPID)
  app.py           HTTP-API, statische Dateien, Minuten-Ticker
  demo.py          Demo-Nachbarn
web/             Frontend als PWA ohne Build-Schritt (index.html, styles.css, app.js, sw.js)
tests/           unittest: test_rules.py, test_leave_requests.py, test_patio.py
artifact/        Version als claude.ai-Artefakt (siehe unten)
REPRODUKTION.md  vollständige Bauanleitung (Datenmodell und Layout wörtlich, alle Texte, alle Testfälle)
```

## Starten und testen

```bash
python3 -m venv .venv            # auf dem Mac im iCloud-Ordner: .venv.nosync
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m server.app   # http://localhost:8080
.venv/bin/python -m server.demo  # Demo-Nachbarn + Anmelde-Links (#login=<token>)
.venv/bin/python -m unittest discover tests -v
```

- Vor jeder Übergabe: **alle Tests grün** (aktuell 41). Neue Regeln bekommen neue Testfälle.
- Frontend-Syntax prüfen, falls `node` da ist: `node --check web/app.js artifact/app.js`.
- Datenordner: `PARK_DATA_DIR` (Standard `data.nosync/`). Ältere Datenbanken migriert `db._migrate()` beim Start.

## Parkplatz und Regeln (mit dem Nutzer festgelegt, nicht ohne Rückfrage ändern)

- Zwei Bereiche: **Tür 1 · links** (L1–L7, Patio P1/P2) und **Tür 2 · rechts** (R1–R5, Patio P3/P4). **Zufahrt oben**, Patio unten.
- Autos **parken rückwärts ein und fahren vorwärts hinaus**: Scheinwerfer zeigen in der Grafik nach oben.
- Blockierungen sind ein **Wegenetz** (`layout.EXITS`): pro Platz die Plätze, über die man rausfährt; mehrere = Alternativen (ODER).
  - L1–L4 direkt (links neben L1–L3 ist eine Fahrspur). L5 über L3 **oder** L4. L6 über L4. L7 über L5 **oder** schräg über L6.
  - R1 direkt (mittig vor beiden Spalten). R2, R3 über R1. R4 über R2, R5 über R3.
  - Patio: P1 über L6 oder P2; P2 über L7, P1 oder P3; P3 über R4, P2 oder P4; P4 über R5 oder P3. Die Trennwand endet vor dem Patio; Patio-Autos fahren **normal** seitlich, auch zur anderen Seite.
- **Konflikt:** B hat innerhalb von 36 h eine bekannte Ausfahrt und keinen freien Weg, weil Autos im Weg stehen, die später oder zu unbekannter Zeit fahren. Gemeldet werden die Autos, an die B **als Erste** stößt. Wer gleichzeitig oder früher fährt, blockiert nicht. 45 Min. vorher Erinnerung an den Blockierer.
- **Tausch** nur, wenn beide zustimmen; „Getauscht“ bucht die Autos über Kreuz um.
- **„Ich will gleich rausfahren“:** nur wenn das Auto jetzt zugeparkt ist; benachrichtigt alle, die schichtweise weg müssten (auch zweite Reihe). Antworten „Komme sofort“ / „Dauert ~15 Min.“, Nachklingeln alle 3 Min., endet von selbst, wenn der Weg frei ist, verfällt nach 1 h.
- **Patio-Notweg** (rückwärts aufs schmale Patio rangieren, dann darüber raus): nur **Notlösung**.
  - Nur anbieten, wenn er **komplett frei** ist (die einzige Lösung ohne einen anderen Nachbarn).
  - **Immer vorher fragen**, ob das für den Nachbarn in Frage kommt; pro Auto einstellbar „Bei Bedarf fragen“ / „Kommt nie in Frage“.
  - Vorsichtig bewerten: **alle jetzt geparkten Autos** sind Hindernisse (auch frühere Ausfahrer, sie könnten zurückkommen). Bis zur Ausfahrt kann jemand den Weg zuparken: dann fällt die Zusage weg, beide werden informiert, später wird **neu gefragt**.
  - A sieht den Konflikt sofort, mit dem Hinweis, dass B gefragt wird. Sagt B ja, muss A nichts tun.
  - Wer auf einen Platz eines zugesagten Notwegs parken will, wird vorher gewarnt.

## Konventionen

- **Python 3.9 kompatibel** halten (der Mac des Nutzers hat nur System-Python 3.9): kein `match`, keine `X | Y`-Typen.
- Backend nur mit Standardbibliothek plus `pywebpush`; App muss auch ohne `pywebpush` starten. Frontend ohne Build-Schritt und ohne externe Bibliotheken.
- **Niemals committen:** `data/`, `data.nosync/` (Datenbank mit Anmelde-Tokens, `vapid_private.pem`), virtuelle Umgebungen. Steht in `.gitignore`.
- Regeln existieren dreifach: `server/rules.py` + `conflicts.py`, Kopie in `web/app.js` (Park-Vorschau) und in `artifact/app.js`. **Änderungen immer an allen Stellen** nachziehen.
- Bei Regel- oder Datenmodell-Änderungen auch `README.md` und `REPRODUKTION.md` (Schema/Layout wörtlich, Testfälle) aktualisieren.
- Nachrichtentexte sind kurz, konkret und nennen Namen, Platz und Uhrzeit („Ben muss morgen 07:00 raus (L6), du fährst erst morgen 09:00.“).

## Artefakt-Version (`artifact/`)

Dieselbe Oberfläche als claude.ai-Artefakt, ohne Server: Daten im gemeinsamen Artefakt-Speicher (`residents/{nutzer-id}` nur selbst schreibbar, `spots`, `decisions`, `requests`), Identität über das Claude-Konto, alle Regeln in der Seite. Keine Push-Nachrichten (Hinweise nur in der offenen Seite). `python3 artifact/build.py web artifact/parkplatz.html` setzt die Seite aus `web/styles.css`, `web/index.html` und `artifact/app.js` zusammen. Das bisher veröffentlichte Artefakt gehört einem anderen Claude-Account; aus einem anderen Account entstünde ein neues Artefakt mit eigenem Link.

## Offene Punkte

- Push-Nachrichten sind auf echten Handys **ungetestet**. Dafür braucht es Hosting mit HTTPS und dauerhaftem Speicher (SQLite, VAPID-Schlüssel). Auf dem iPhone muss die App über „Zum Home-Bildschirm“ installiert sein.
- Anmeldung ist bewusst einfach (persönlicher Token-Link, optional `PARK_INVITE_CODE`).
