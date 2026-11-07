# Artefakt-Version

Veröffentlicht unter https://claude.ai/artifact/64M4mtLXP2Mwj1XMfCZueu (Prototyp zum Teilen, Speicher-Regeln: `residents` lesen alle, schreiben nur der eigene Eintrag `residents/{self}`; `spots`, `decisions`, `requests` dürfen alle Mitnutzer schreiben).
Ältere Version (anderer Claude-Account): https://claude.ai/artifact/HuJPxHfX9NL27MDB6Gu4zP

- `app.js`: Logik der Artefakt-Version (gemeinsamer Speicher statt Python-Server)
- `build.py`: setzt `parkplatz.html` aus `web/styles.css`, `web/index.html` und `app.js` zusammen:
  `python3 artifact/build.py web artifact/parkplatz.html`
- Speicher-Sammlungen: `residents/{nutzer}` (nur eigener Eintrag schreibbar), `spots/{platz}`, `decisions/{konflikt}`, `requests/{id}`

- Patio-Notweg: Entscheidungen in `decisions/{konflikt}` mit `patio_choice` und `patio_route` (die Antwort gilt nur für genau diesen Weg); Einstellung pro Auto `patio_route: ask|never` im eigenen `residents`-Eintrag.

## Demo über GitHub Pages (`docs/`)

`docs/index.html` ist dieselbe Seite als normale Webseite, ohne Claude-Konto. Ohne Claude-Speicher läuft sie als **Demo** mit Beispiel-Nachbarn; Eintragungen bleiben nur im jeweiligen Browserfenster (nichts wird geteilt).

- Neu bauen: `python3 artifact/build.py web docs/index.html --standalone`
- Einschalten: auf GitHub unter **Settings → Pages** „Deploy from a branch“, Branch wählen, Ordner `/docs`.
- Link danach: `https://<github-name>.github.io/OptiPark/`
