# Artefakt-Version

Veröffentlicht unter https://claude.ai/artifact/HuJPxHfX9NL27MDB6Gu4zP

- `app.js`: Logik der Artefakt-Version (gemeinsamer Speicher statt Python-Server)
- `build.py`: setzt `parkplatz.html` aus `web/styles.css`, `web/index.html` und `app.js` zusammen:
  `python3 artifact/build.py web artifact/parkplatz.html`
- Speicher-Sammlungen: `residents/{nutzer}` (nur eigener Eintrag schreibbar), `spots/{platz}`, `decisions/{konflikt}`, `requests/{id}`

- Patio-Notweg: Entscheidungen in `decisions/{konflikt}` mit `patio_choice` und `patio_route` (die Antwort gilt nur für genau diesen Weg); Einstellung pro Auto `patio_route: ask|never` im eigenen `residents`-Eintrag.
