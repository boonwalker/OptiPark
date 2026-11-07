// Sprachen der Oberfläche: Deutsch (Grundsprache) und Englisch.
// Texte stehen im Code auf Deutsch mit {platzhaltern}: t('{car} steht auf {spot}', { car, spot }).
// Fehlt eine Übersetzung, erscheint der deutsche Text.
// Sprache: von Hand gewählt (Profil) oder die des Geräts – Englisch, wenn das Gerät Englisch spricht, sonst Deutsch.
// Wird auch in die Artefakt-Seite eingebaut (artifact/build.py).

const LANG = (() => {
  try {
    const s = localStorage.getItem('park.lang');
    if (s === 'de' || s === 'en') return s;
  } catch { /* privat */ }
  return /^en\b/i.test(navigator.language || '') ? 'en' : 'de';
})();

function setLang(lang) {
  try { localStorage.setItem('park.lang', lang); } catch { /* privat */ }
}

function t(de, params) {
  let s = LANG === 'en' ? (I18N_EN[de] ?? de) : de;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
  return s;
}

const WD_SHORT = LANG === 'en' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Tag als Wort („morgen“) oder kurz mit Datum („Mo 10.11.“ / „Mon 10 Nov“). wd: 0 = Montag. */
function fmtDay(diff, wd, day, month) {
  const word = { 0: 'heute', 1: 'morgen', 2: 'übermorgen' }[diff];
  if (word) return t(word);
  const pad = (n) => String(n).padStart(2, '0');
  return LANG === 'en' ? `${WD_SHORT[wd]} ${day} ${MONTHS_EN[month - 1]}` : `${WD_SHORT[wd]} ${pad(day)}.${pad(month)}.`;
}

/** Feste Texte in der HTML-Seite: data-i18n (Inhalt) und data-i18n-aria (aria-label). */
function translateStatic(root = document) {
  document.documentElement.lang = LANG;
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.textContent.trim()); });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.getAttribute('aria-label'))));
}

const I18N_EN = {
  // Allgemein & Seite
  'Parkplatz': 'Parking',
  'Profil': 'Profile',
  'Dein Auto': 'Your car',
  'Frei – antippen zum Parken': 'Free – tap to park',
  'Konflikt': 'Conflict',
  'Tür 1 · links': 'Door 1 · left',
  'Tür 2 · rechts': 'Door 2 · right',
  'Fehler {n}': 'Error {n}',
  'Server nicht erreichbar: {msg}': 'Server not reachable: {msg}',
  'Das hat nicht geklappt': 'That didn’t work',
  'Gespeichert': 'Saved',
  'Speichern': 'Save',
  'Hinzugefügt': 'Added',
  'Gelöscht': 'Deleted',
  'Entfernt': 'Removed',
  'Löschen': 'Delete',
  'Schließen': 'Close',
  'Weiter': 'Next',
  'Später': 'Later',

  // Zeit
  'unbekannt': 'unknown',
  'heute': 'today',
  'morgen': 'tomorrow',
  'übermorgen': 'day after tomorrow',
  'täglich': 'daily',
  'Mo–Fr': 'Mon–Fri',
  'Sa–So': 'Sat–Sun',
  'keine Ausfahrt bekannt': 'no departure known',
  'zu unbekannter Zeit': 'at an unknown time',

  // Wege
  'rückwärts über {via} auf {to}': 'reverse via {via} onto {to}',
  'rückwärts auf {to}': 'reverse onto {to}',
  ', dann über {via} hinaus': ', then out via {via}',
  ', dann hinaus': ', then out',
  'direkt': 'directly',
  'direkt oder über {via}': 'directly or via {via}',
  'über {via}': 'via {via}',
  ' oder ': ' or ',
  ' und ': ' and ',

  // Stellplätze
  'Platz {spot}, belegt von {name}': 'Spot {spot}, taken by {name}',
  'Platz {spot}, belegt': 'Spot {spot}, taken',
  'Platz {spot}, frei': 'Spot {spot}, free',
  'Patio-Platz': 'Patio spot',
  'Ausfahrt': 'Way out',
  'Ausfahrt über': 'Way out via',
  'Ausfahrt über (einer muss frei sein)': 'Way out via (one must be free)',
  'Fährt über diesen Platz raus': 'Drives out across this spot',
  'frei': 'free',
  'fährt {when}': 'leaves {when}',

  // Status
  'Willkommen!': 'Welcome!',
  'Melde dich an, um Plätze zu belegen und Konflikte zu sehen.': 'Sign up to take spots and see conflicts.',
  'Trag dich ein, um Plätze zu belegen und Konflikte zu sehen.': 'Sign up to take spots and see conflicts.',
  'Loslegen': 'Get started',
  'Noch kein Auto': 'No car yet',
  'Leg dein Auto an, dann kannst du parken.': 'Add your car, then you can park.',
  'Auto anlegen': 'Add car',
  '{car} steht auf {spot}': '{car} is on {spot}',
  'Nächste Ausfahrt: {dep}': 'Next departure: {dep}',
  '{car} ist unterwegs': '{car} is out',
  'Zurück? Tippe auf einen freien Platz.': 'Back? Tap a free spot.',
  'Losgefahren': 'I’ve left',
  '🚗 Ich will gleich rausfahren': '🚗 I want to leave now',
  'Gute Fahrt! 👋': 'Have a good trip! 👋',

  // Rausfahr-Anfrage
  'Danke! Bescheid gegeben 👍': 'Thanks! They’ve been told 👍',
  'Bescheid gegeben': 'They’ve been told',
  'Nochmal geklingelt 🔔': 'Rang again 🔔',
  'Anfrage beendet': 'Request ended',
  '{names} wurde benachrichtigt': '{names} has been notified',
  '{names} wurden benachrichtigt': '{names} have been notified',
  '{names} sieht deine Anfrage': '{names} can see your request',
  '{names} sehen deine Anfrage': '{names} can see your request',
  'Anfrage gestartet': 'Request started',
  'dein eigenes Auto': 'your own car',
  '✓ kommt sofort': '✓ coming right away',
  '⏱ in ~{n} Min.': '⏱ in ~{n} min.',
  '… noch keine Antwort': '… no answer yet',
  'Bei mehreren Wegen reicht es, wenn einer davon Platz macht.': 'If there are several ways out, it’s enough for one of them to make room.',
  'Du willst raus – Anfrage läuft': 'You want to leave – request running',
  '{car} auf {spot} · seit {n} Min.': '{car} on {spot} · for {n} min.',
  ' · mehrere müssen nacheinander weg': ' · several have to move one after another',
  '🔔 Nochmal klingeln': '🔔 Ring again',
  'Hat sich erledigt': 'No longer needed',
  'Nachklingeln ab {time} möglich. Ist der Weg frei, bekommst du Bescheid.': 'You can ring again from {time}. You’ll be told when the way is clear.',
  'Nachklingeln ab {time} möglich. Ist der Weg frei, endet die Anfrage von selbst.': 'You can ring again from {time}. The request ends by itself once the way is clear.',
  'Du hast geantwortet: kommst sofort.': 'You answered: coming right away.',
  'Du hast geantwortet: in ~{n} Min.': 'You answered: in ~{n} min.',
  '🚗 {name} will gleich rausfahren': '🚗 {name} wants to leave now',
  'Dein {car} auf {spot} steht im Weg ({their_spot}). Bitte kurz umparken.': 'Your {car} on {spot} is in the way ({their_spot}). Please move it briefly.',
  'Alternativ könnte auch {who} Platz machen.': 'Alternatively, {who} could make room.',
  'Komme sofort': 'Coming right away',
  'Dauert ~15 Min.': 'About 15 min.',

  // Patio-Notweg
  'Notlösung übers Patio?': 'Fallback via the patio?',
  'Gerade steht dir jemand im Weg. Ohne einen Nachbarn zu stören, kämst du so raus:': 'Someone is in your way right now. Without bothering a neighbour, you could get out like this:',
  'Das Patio ist schmal und braucht etwas Rangieren. Nimm den Weg nur, wenn dein Auto passt und du das magst.': 'The patio is narrow and takes some manoeuvring. Only take this way if your car fits and you’re comfortable with it.',
  'Ja, ich fahre übers Patio': 'Yes, I’ll go via the patio',
  'Nein, Nachbarn fragen': 'No, ask the neighbours',
  'Kommt für mein Auto nie in Frage': 'Never an option for my car',
  'Gute Fahrt übers Patio! Tippe danach auf „Losgefahren“.': 'Have a good trip via the patio! Tap “I’ve left” afterwards.',
  'Gemerkt: kein Patio-Notweg': 'Noted: no patio escape route',
  'Alles klar – gute Fahrt übers Patio': 'All right – have a good trip via the patio',

  // Konflikte
  'Tausch vereinbart 🤝': 'Swap agreed 🤝',
  'Tausch-Wunsch gesendet': 'Swap request sent',
  'Tausch-Wunsch gespeichert': 'Swap request saved',
  'Plätze getauscht 🎉': 'Spots swapped 🎉',
  '{a} steht vor {b}': '{a} is in front of {b}',
  'Du stehst dir selbst im Weg': 'You’re blocking yourself',
  '{b_car} ({b_spot}) muss {b_when} raus, {a_car} ({a_spot}) steht davor.': '{b_car} ({b_spot}) has to leave {b_when}, {a_car} ({a_spot}) is in front of it.',
  'Umgeparkt ✓': 'Moved ✓',
  'Du fährst übers Patio raus': 'You’re getting out via the patio',
  'Zugesagt: {route}. Parkt bis {when} jemand auf diesem Weg, sagt dir die App Bescheid.': 'Agreed: {route}. If someone parks on this way before {when}, the app will tell you.',
  'Zugesagt: {route}. Parkt bis {when} jemand auf diesem Weg, zeigt dir die App das hier an.': 'Agreed: {route}. If someone parks on this way before {when}, the app will show it here.',
  'Doch nicht': 'Changed my mind',
  '{name} weicht übers Patio aus': '{name} will get out via the patio',
  'Du musst nichts tun. Wird der Patio-Weg zugeparkt, meldet sich die App wieder.': 'You don’t need to do anything. If the patio way gets blocked, the app will let you know.',
  '{name} steht vor dir': '{name} is parked in front of you',
  'Du musst {b_when} raus, {name} fährt erst {a_when}.': 'You have to leave {b_when}, {name} isn’t leaving until {a_when}.',
  '{name} muss {b_when} raus, du fährst erst {a_when}.': '{name} has to leave {b_when}, you’re not leaving until {a_when}.',
  'Notlösung ohne {name}:': 'Fallback without {name}:',
  'Das Patio ist schmal und braucht etwas Rangieren. Der Weg ist jetzt frei; parkt bis dahin jemand darauf, sagt dir die App Bescheid.': 'The patio is narrow and takes some manoeuvring. The way is free now; if someone parks on it before then, the app will tell you.',
  'Das Patio ist schmal und braucht etwas Rangieren. Der Weg ist jetzt frei; parkt bis dahin jemand darauf, zeigt dir die App das an.': 'The patio is narrow and takes some manoeuvring. The way is free now; if someone parks on it before then, the app will show you.',
  'Kommt das für dich in Frage?': 'Does that work for you?',
  'Nein, kommt nicht in Frage': 'No, that doesn’t work',
  '{name} wird gerade gefragt, ob der Patio-Notweg in Frage kommt. Du kannst trotzdem schon einen Tausch anbieten.': '{name} is being asked whether the patio escape route works for them. You can still offer a swap already.',
  '{name} wird gefragt, ob der Patio-Notweg in Frage kommt. Du kannst trotzdem schon einen Tausch anbieten.': '{name} is being asked whether the patio escape route works for them. You can still offer a swap already.',
  'Tausch vereinbart mit {name}': 'Swap agreed with {name}',
  '{a} ↔ {b}: Parkt heute noch um und tippt dann hier.': '{a} ↔ {b}: Swap spots today, then tap here.',
  'Getauscht ✓': 'Swapped ✓',
  'Du lässt {name} raus': 'You’re letting {name} out',
  'Zugesagt: Du fährst {when} rechtzeitig zur Seite. Du bekommst vorher eine Erinnerung.': 'Agreed: you’ll move out of the way in time {when}. You’ll get a reminder beforehand.',
  'Zugesagt: Du fährst {when} rechtzeitig zur Seite.': 'Agreed: you’ll move out of the way in time {when}.',
  'Doch lieber heute tauschen': 'Rather swap today after all',
  '{name} lässt dich raus': '{name} will let you out',
  '{name} fährt {when} rechtzeitig zur Seite.': '{name} will move out of the way in time {when}.',
  'Lieber heute tauschen': 'Rather swap today',
  '{name} möchte heute Abend tauschen': '{name} would like to swap this evening',
  'Einverstanden': 'OK',
  'Nein, ich fahre zur Seite': 'No, I’ll move out of the way',
  'Nein danke': 'No thanks',
  'Warte auf {name}': 'Waiting for {name}',
  'Du hast einen Tausch vorgeschlagen ({a} ↔ {b}). {name} wurde benachrichtigt.': 'You suggested a swap ({a} ↔ {b}). {name} has been notified.',
  'Du hast einen Tausch vorgeschlagen ({a} ↔ {b}). {name} sieht den Vorschlag beim nächsten Öffnen.': 'You suggested a swap ({a} ↔ {b}). {name} will see it next time they open the app.',
  'Doch nicht – ich fahre zur Seite': 'Changed my mind – I’ll move out of the way',
  'Du blockierst {name}': 'You’re blocking {name}',
  'Heute Abend tauschen': 'Swap this evening',
  'Ich fahre {time} zur Seite': 'I’ll move at {time}',
  'Tausch vorschlagen': 'Suggest a swap',
  'Wir klären das morgens': 'We’ll sort it out in the morning',
  'Angemeldet als {name}': 'Signed in as {name}',

  // Parken
  'Auf {spot} parken': 'Park on {spot}',
  '{where} · Ausfahrt {way}': '{where} · way out {way}',
  'Welches Auto?': 'Which car?',
  'Wann fährst du als Nächstes?': 'When are you leaving next?',
  'Datum & Uhrzeit': 'Date & time',
  'in 1 Std.': 'in 1 hr',
  'morgen 7:00': 'tomorrow 7:00',
  'morgen 9:00': 'tomorrow 9:00',
  'Hier geparkt': 'Parked here',
  'Wie geplant · {when}': 'As planned · {when}',
  'Wie üblich · {when}': 'As usual · {when}',
  'Andere Zeit': 'Other time',
  'Weiß ich noch nicht': 'Don’t know yet',
  'Von {spot} hierher umparken': 'Move here from {spot}',
  '⚠️ Du würdest {who} zuparken.': '⚠️ You would block {who}.',
  ', käme nur noch über den Patio-Notweg raus': ', could only get out via the patio escape route',
  '⚠️ {name} will {when} über diesen Platz übers Patio raus ({route}). Wenn du hier parkst, ist dieser Notweg zu.': '⚠️ {name} wants to get out via the patio across this spot {when} ({route}). If you park here, that escape route is blocked.',
  '⚠️ {who} steht vor dir.': '⚠️ {who} is parked in front of you.',
  '⚠️ {who} stehen vor dir – einer davon müsste vorher weg.': '⚠️ {who} are parked in front of you – one of them would have to move first.',
  'Ohne Ausfahrzeit giltst du für Autos hinter dir als Blockierer.': 'Without a departure time, you count as blocking the cars behind you.',
  'Tipp: Auf {spot} gäbe es keinen Konflikt.': 'Tip: on {spot} there would be no conflict.',
  'Dorthin': 'Go there',
  '✓ Kein Konflikt mit deinen Nachbarn.': '✓ No conflict with your neighbours.',
  'Bitte eine Uhrzeit wählen': 'Please choose a time',

  // Eigenes / fremdes Auto
  'Geparkt {when}': 'Parked {when}',
  'geparkt {when}': 'parked {when}',
  'Nächste Ausfahrt': 'Next departure',
  'einmalig': 'one-off',
  'üblich': 'usual',
  'Andere Ausfahrt': 'Other departure',
  'Andere Ausfahrzeit eintragen': 'Enter another departure time',
  'Übliche Fahrt {day} fällt aus': 'Usual trip {day} is cancelled',
  'Geplante Fahrt löschen': 'Delete planned trip',
  'Ausfahrt gespeichert': 'Departure saved',
  'Übliche Fahrt ausgelassen': 'Usual trip skipped',

  // Profil
  'Hallo {name}': 'Hi {name}',
  'Dein Profil': 'Your profile',
  'Name': 'Name',
  'Wohnung / Klingel': 'Flat / doorbell',
  'Deine Autos': 'Your cars',
  'Keine übliche Ausfahrzeit': 'No usual departure time',
  '+ Auto hinzufügen': '+ Add car',
  'Sprache': 'Language',
  'Benachrichtigungen': 'Notifications',
  'Push ist auf dem Server nicht eingerichtet.': 'Push isn’t set up on the server.',
  'Dieser Browser kann keine Push-Nachrichten. Auf dem iPhone: Teilen → „Zum Home-Bildschirm“, dann die App von dort öffnen.': 'This browser can’t receive push notifications. On iPhone: Share → “Add to Home Screen”, then open the app from there.',
  'Aktiv auf {n} Gerät(en).': 'Active on {n} device(s).',
  'Noch nicht aktiviert.': 'Not turned on yet.',
  'Auf diesem Gerät aktivieren': 'Turn on for this device',
  'Test senden': 'Send test',
  'Test gesendet': 'Test sent',
  'Weitere Geräte': 'Other devices',
  'Öffne diesen Link auf einem anderen Gerät, um dich dort anzumelden. Nicht weitergeben!': 'Open this link on another device to sign in there. Don’t share it!',
  'Anmelde-Link kopieren': 'Copy sign-in link',
  'Link kopiert': 'Link copied',
  'Anmelde-Link:': 'Sign-in link:',
  'Auf diesem Gerät abmelden': 'Sign out on this device',
  'Abmelden? Ohne Anmelde-Link kommst du nicht mehr in dieses Profil.': 'Sign out? Without the sign-in link you can’t get back into this profile.',
  'Diese Version der App kann keine Push-Nachrichten schicken. Solange die Seite offen ist, siehst du neue Konflikte und Anfragen sofort, und der Tab-Titel zeigt die Anzahl.': 'This version of the app can’t send push notifications. While the page is open, you see new conflicts and requests right away, and the tab title shows how many.',
  'Nachbarn einladen': 'Invite neighbours',
  'Teile diese Seite über „Teilen“ mit deinen Nachbarn. Damit sie parken und antworten können, brauchen sie Bearbeitungsrechte, sonst können sie nur zuschauen.': 'Share this page with your neighbours via “Share”. To park and reply, they need edit rights, otherwise they can only watch.',
  'Demo': 'Demo',
  'Das ist eine Demo: Die Nachbarn sind Beispiele, und was du einträgst, bleibt nur in diesem Fenster. Lädst du die Seite neu, beginnt die Demo von vorn.': 'This is a demo: the neighbours are examples, and what you enter stays in this window only. If you reload the page, the demo starts over.',

  // Auto-Editor
  'Neues Auto': 'New car',
  'Auto & Ausfahrzeiten': 'Car & departure times',
  'So erkennen dich die Nachbarn auf dem Parkplatz.': 'This is how your neighbours recognise you in the car park.',
  'Name des Autos': 'Name of the car',
  'z. B. Roter Golf': 'e.g. Red Golf',
  'Kennzeichen (optional)': 'Number plate (optional)',
  'Farbe': 'Colour',
  'Farbe {c}': 'Colour {c}',
  'Übliche Ausfahrzeiten': 'Usual departure times',
  'Fällt aus: {dates}': 'Cancelled: {dates}',
  'rückgängig': 'undo',
  'Noch keine – z. B. Mo–Fr 07:30 zur Arbeit.': 'None yet – e.g. Mon–Fri 07:30 to work.',
  'Anlass (Arbeit)': 'Purpose (work)',
  '+ Übliche Zeit hinzufügen': '+ Add usual time',
  'Einmalige Ausfahrten': 'One-off departures',
  'Keine geplant.': 'None planned.',
  'Notiz': 'Note',
  '+ Einmalige Ausfahrt': '+ One-off departure',
  'Patio-Notweg': 'Patio escape route',
  'Rückwärts aufs schmale Patio rangieren und darüber rausfahren. Die App schlägt das nur als Notlösung vor und fragt dich jedes Mal vorher.': 'Reverse onto the narrow patio and drive out across it. The app only suggests this as a fallback and asks you first every time.',
  'Bei Bedarf fragen': 'Ask when needed',
  'Kommt nie in Frage': 'Never an option',
  'Auto entfernen': 'Remove car',
  '{car} wirklich entfernen?': 'Really remove {car}?',
  '{car} wirklich entfernen? Nochmal tippen': 'Really remove {car}? Tap again',
  'Auto angelegt': 'Car added',
  'Bitte Datum wählen': 'Please choose a date',

  // Anmeldung
  'Willkommen auf dem Parkplatz 👋': 'Welcome to the car park 👋',
  'Trag ein, wo du stehst und wann du losfährst – die App sagt dir, wenn ihr euch zuparkt.': 'Enter where you’re parked and when you’re leaving – the app tells you when you block each other.',
  'Trag ein, wo du stehst und wann du losfährst. Die App zeigt dir, wenn ihr euch zuparkt.': 'Enter where you’re parked and when you’re leaving. The app shows you when you block each other.',
  'Dein Name': 'Your name',
  'Dein Name, wie ihn die Nachbarn sehen': 'Your name, as your neighbours see it',
  'z. B. Anna': 'e.g. Anna',
  'Wohnung / Klingel (optional)': 'Flat / doorbell (optional)',
  'z. B. 2. OG links': 'e.g. 2nd floor left',
  'Einladungscode': 'Invite code',
  'Wann fährst du normalerweise los?': 'When do you usually leave?',
  'Zum Beispiel morgens zur Arbeit. Das kannst du später jederzeit ändern.': 'For example in the morning to work. You can change this any time.',
  'Uhrzeit': 'Time',
  'Anlass': 'Purpose',
  'Arbeit': 'Work',
  'Keine feste Zeit': 'No fixed time',
  'Damit du erfährst, wenn du jemanden zuparkst – oder zugeparkt wirst.': 'So you find out when you block someone – or get blocked.',
  'Auf dem iPhone: Teilen → „Zum Home-Bildschirm“, dann die App von dort öffnen und hier aktivieren.': 'On iPhone: Share → “Add to Home Screen”, then open the app from there and turn it on here.',
  'Benachrichtigungen erlauben': 'Allow notifications',
  'Fertig! Tippe auf deinen Stellplatz.': 'Done! Tap your parking spot.',

  // Push
  'Push ist auf dem Server nicht eingerichtet': 'Push isn’t set up on the server',
  'Dieser Browser unterstützt keine Push-Nachrichten': 'This browser doesn’t support push notifications',
  'Benachrichtigungen wurden nicht erlaubt': 'Notifications weren’t allowed',
  'Benachrichtigungen aktiv 🔔': 'Notifications on 🔔',

  // Artefakt-Version: Hinweise, Speicher, Fehler
  'Lade den Parkplatz …': 'Loading the car park …',
  'Die Daten sind gerade nicht erreichbar. Die Anzeige kann veraltet sein.': 'The data can’t be reached right now. What you see may be out of date.',
  '<b>Demo</b> · Hier ist kein gemeinsamer Speicher verfügbar. Du siehst Beispiel-Nachbarn, Änderungen bleiben nur in diesem Fenster.': '<b>Demo</b> · No shared storage is available here. You see example neighbours, and changes stay in this window only.',
  'Melde dich bei Claude an, um einen Stellplatz zu belegen.': 'Sign in to Claude to take a parking spot.',
  'Melde dich bei Claude an, um mitzumachen.': 'Sign in to Claude to take part.',
  'Bitte bei Claude anmelden, um mitzumachen.': 'Please sign in to Claude to take part.',
  'Du kannst nur zuschauen. Bitte den Besitzer, dich als Bearbeiter einzuladen.': 'You can only watch. Ask the owner to invite you as an editor.',
  'Du kannst hier nur zuschauen. Bitte den Besitzer, dich als Bearbeiter einzuladen.': 'You can only watch here. Ask the owner to invite you as an editor.',
  'Der Speicher ist voll. Bitte alte Einträge löschen.': 'Storage is full. Please delete old entries.',
  'Speichern hat nicht geklappt. Bitte gleich nochmal versuchen.': 'Saving didn’t work. Please try again in a moment.',
  'Auto nicht gefunden': 'Car not found',
  'Bitte gib deinen Namen ein': 'Please enter your name',
  'Bitte gib dem Auto einen Namen': 'Please give the car a name',
  'Mindestens einen Wochentag wählen': 'Choose at least one weekday',
  'Uhrzeit als HH:MM angeben': 'Enter the time as HH:MM',
  'Ausfahrzeit muss in der Zukunft liegen': 'Departure time must be in the future',
  'Gerade parkt dort jemand anderes. Bitte gleich nochmal versuchen.': 'Someone else is parking there right now. Please try again in a moment.',
  'Der Platz ist schon belegt': 'That spot is already taken',
  'Konflikt nicht mehr aktiv': 'Conflict is no longer active',
  'Der Patio-Notweg steht hier nicht zur Wahl': 'The patio escape route isn’t an option here',
  'Beide müssen dem Tausch zustimmen': 'Both of you have to agree to the swap',
  'Das Auto ist gerade nicht geparkt': 'The car isn’t parked right now',
  'Deine Anfrage läuft schon': 'Your request is already running',
  'Du kommst raus – niemand steht im Weg': 'You can get out – nobody is in the way',
  'Bitte noch {n} Min. warten': 'Please wait {n} more min.',
  '1. OG': '1st floor',
  '2. OG': '2nd floor',
  'EG links': 'Ground floor left',
  'EG rechts': 'Ground floor right',
  'Schule': 'School',
  'Ausflug': 'Day trip',
  'Frühschicht': 'Early shift',

  // Hinweise in der offenen Seite (Artefakt)
  'Patio-Notweg ist versperrt – bitte klärt den Konflikt': 'Patio escape route is blocked – please sort out the conflict',
  '{name} weicht übers Patio aus – du musst nichts tun': '{name} will get out via the patio – you don’t need to do anything',
  'Du blockierst {name} ({spot})': 'You’re blocking {name} ({spot})',
  '🚗 {name} will gleich rausfahren!': '🚗 {name} wants to leave now!',
  '🔔 Erinnerung: {name} wartet': '🔔 Reminder: {name} is waiting',
  '{name} kommt sofort': '{name} is coming right away',
  '{name} braucht noch ~15 Min.': '{name} needs about 15 more min.',
  'Weg ist frei 🚗 Du kannst jetzt rausfahren.': 'The way is clear 🚗 You can drive out now.',
};
