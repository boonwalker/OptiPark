# Parkoptimierer

Nachbarn tippen nach dem Parken auf ihren Stellplatz und hinterlegen, wann sie wieder losfahren.
Die App erkennt, wer wen zuparkt, und schlägt per Push-Nachricht einen Tausch am Vorabend vor.

## Starten

```bash
python3 -m venv .venv.nosync
.venv.nosync/bin/pip install -r requirements.txt
.venv.nosync/bin/python -m server.app          # http://localhost:8080
```

Demo-Nachbarn anlegen (gibt Anmelde-Links aus):

```bash
.venv.nosync/bin/python -m server.demo
```

Einstellungen über Umgebungsvariablen:

| Variable | Bedeutung | Standard |
|---|---|---|
| `PARK_PORT` | Port | `8080` |
| `PARK_DATA_DIR` | Ordner für Datenbank & Push-Schlüssel | `data.nosync/` |
| `PARK_INVITE_CODE` | Registrierung nur mit diesem Code | aus |
| `PARK_VAPID_SUB` | Kontakt für Push-Dienste (`mailto:` oder `https:`) | `mailto:parkplatz@example.com` |

Ordner mit `.nosync` werden von iCloud nicht synchronisiert (wichtig für SQLite).

## Aufbau

```
server/
  schema.sql      Datenmodell (SQLite)
  layout.py       Parkplatz nach Skizze: Bereiche, Stellplätze, Rasterpositionen, Wegenetz (EXITS)
  rules.py        Wegenetz laden, Wegsuche (kommt ein Auto raus? wer steht im Weg?)
  departures.py   nächste Ausfahrt (übliche Zeiten + einmalige, minus Ausnahmen)
  conflicts.py    Konflikterkennung, Benachrichtigungstexte, Erinnerungen
  leave_requests.py  „Ich will gleich rausfahren“: Anfrage, Antworten, Nachklingeln
  push.py         Web-Push (VAPID-Schlüssel werden automatisch erzeugt)
  i18n.py         Englische und spanische Übersetzungen der Nachrichten und Fehlermeldungen
  app.py          HTTP-API + statische Dateien + Minuten-Ticker
web/              Frontend (PWA, ohne Build-Schritt); Übersetzungen in web/i18n.js
tests/            Regel-Tests: .venv.nosync/bin/python -m unittest discover tests
```

### Datenmodell

- **resident.away_from / away_until**: „Nicht da“ – der Nachbar ist weg, sein Auto bleibt stehen. Ausfahrten in der Zeit fallen weg; Konflikte mit einem abwesenden Blockierer werden für die ganze Abwesenheit erkannt.
- **lot → zone → spot**: Parkplatz, Bereiche („Tür 1 · links“), Stellplätze mit Rasterposition.
- **spot_exit**: Wegenetz – von Platz X kann man direkt hinaus oder über Platz Y weiterfahren. Mehrere Zeilen = alternative Wege.
- **resident → car**: Nachbarn und ihre Autos (mehrere pro Nachbar möglich).
- **recurring_departure** (+ **recurring_skip**): übliche Ausfahrt, z. B. Mo–Fr 07:00, mit ausgelassenen Tagen.
- **planned_departure**: einmalige bekannte Ausfahrt.
- **parking**: Parkvorgänge mit Historie; aktiv = `left_at IS NULL` (eindeutig pro Platz und pro Auto).
- **conflict**: Blocker-Parkvorgang, blockierter Parkvorgang, Ausfahrzeit, Status
  (`open` → `swap_agreed` / `acknowledged` → `resolved` / `obsolete`) und die Entscheidungen beider Seiten.
- **leave_request** (+ **leave_request_blocker**): spontane Rausfahr-Anfrage, wer Platz machen muss und was er geantwortet hat.
- **push_subscription**: Push-Abos pro Gerät.

### Blockierungsregeln

Ein Auto kommt raus, wenn es im Wegenetz einen Weg nach draußen gibt, der nur über freie Plätze führt.
Die Autos parken rückwärts ein und fahren vorwärts hinaus, die Zufahrt liegt oben.

| Platz | kommt raus … |
|---|---|
| L1, L2, L3, L4 | direkt (Fahrspur links neben L1–L3) |
| L5 | über L3 **oder** L4 |
| L6 | über L4 **oder** seitlich auf L7 und dann über L5 |
| L7 | über L5 **oder** schräg über L6 (weiter wie L5 / L6) |
| R1 | direkt |
| R2, R3 | über R1 (steht mittig vor beiden Spalten) |
| R4 | über R2 **oder** seitlich auf R5 und dann über R3 |
| R5 | über R3 **oder** seitlich auf R4 und dann über R2 |
| P1 | über L6 oder seitlich über P2 |
| P2 | über L7 oder seitlich über P1 / P3 (Wechsel zur rechten Seite) |
| P3 | über R4 oder seitlich über P2 / P4 |
| P4 | über R5 oder seitlich über P3 |

**Konflikt:** B hat innerhalb von 36 h eine bekannte Ausfahrt, und zu diesem Zeitpunkt gibt es keinen freien Weg,
weil Autos im Weg stehen, die später oder zu unbekannter Zeit fahren. Gemeldet werden die Autos, an die B als
Erste stößt. Beide Seiten werden benachrichtigt, 45 min vorher kommt eine Erinnerung an den Blockierer.
Wer gleichzeitig oder früher fährt, blockiert nicht.

### Patio-Notweg

Autos können auch rückwärts bis aufs Patio rangieren und von dort rausfahren, auch über die andere Seite.
Weil das Patio schmal ist, gilt das nur als **Notlösung**:
- Angeboten wird der Weg nur, wenn er **komplett frei** ist (niemand muss dafür umparken). Bewertet wird vorsichtig:
  alle jetzt geparkten Autos zählen als Hindernis, auch die, die vorher wegfahren (sie könnten zurückkommen).
- Die App **fragt immer vorher** („Kommt das für dich in Frage?“). Pro Auto lässt sich einstellen: „Bei Bedarf fragen“ oder „Kommt nie in Frage“.
- Bei einem Konflikt sieht A ihn sofort, mit dem Hinweis, dass B gefragt wird. Sagt B ja, muss A nichts tun.
- Parkt bis zur Ausfahrt jemand auf dem Weg, fällt die Zusage weg und beide bekommen Bescheid. Wer auf einen Platz eines
  zugesagten Notwegs tippt, wird vorher gewarnt.
- Bei „Ich will gleich rausfahren“ fragt die App zuerst, ob der freie Notweg in Frage kommt, bevor sie Nachbarn anpingt.
- Autos, die selbst auf dem Patio stehen, fahren wie bisher normal seitlich übers Patio.

### „Ich will gleich rausfahren“

Ist das eigene Auto **jetzt** zugeparkt, erscheint der Button. Alle, die Platz machen müssen, bekommen eine Push-Nachricht,
auch die in zweiter Reihe (L7 hinter L5 hinter L3/L4). Bei alternativen Wegen steht in der Nachricht, wer sonst noch
Platz machen könnte. Antworten: „Komme sofort“ oder „Dauert ~15 Min.“. Nachklingeln ist alle 3 Minuten möglich.
Ist der Weg frei, endet die Anfrage automatisch mit „Weg ist frei“, nach einer Stunde verfällt sie.

## Push auf Handys

Web-Push braucht HTTPS (außer auf `localhost`). Für echte Handys die App hinter HTTPS betreiben
(z. B. kleiner Server/VPS mit Caddy, oder ein Tunnel). Auf dem iPhone (ab iOS 16.4) muss die App
erst über Teilen → „Zum Home-Bildschirm“ installiert werden.
