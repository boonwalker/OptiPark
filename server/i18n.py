"""Sprachen: Deutsch (Grundsprache), Englisch und Spanisch.

Texte stehen im Code auf Deutsch, mit {platzhaltern}. t(lang, text, **werte)
liefert die Übersetzung (oder den deutschen Text, wenn keine da ist) und setzt
die Werte ein. Jeder Nachbar hat eine eigene Sprache (resident.lang); seine
Benachrichtigungen werden in dieser Sprache geschrieben. Fehlermeldungen der
API richten sich nach dem Header X-Lang der Anfrage.
"""

LANGS = ("de", "en", "es")

EN = {
    # Zeitangaben
    "unbekannt": "unknown",
    "heute": "today",
    "morgen": "tomorrow",
    "übermorgen": "day after tomorrow",
    "zu unbekannter Zeit": "an unknown time",
    # Patio-Notweg
    "rückwärts über {via} auf {to}": "reverse via {via} onto {to}",
    "rückwärts auf {to}": "reverse onto {to}",
    ", dann über {via} hinaus": ", then out via {via}",
    ", dann hinaus": ", then out",
    # Konflikte
    "Du stehst dir selbst im Weg": "You're blocking yourself",
    "{b_car} ({b_spot}) muss {b_when} raus, {a_car} ({a_spot}) steht davor.":
        "{b_car} ({b_spot}) has to leave {b_when}, {a_car} ({a_spot}) is in front of it.",
    "Du blockierst {name}": "You're blocking {name}",
    "{b_name} muss {b_when} raus ({b_spot}), du fährst erst {a_when}.":
        "{b_name} has to leave {b_when} ({b_spot}), you're not leaving until {a_when}.",
    "{name} wird gefragt, ob der Patio-Notweg in Frage kommt.":
        "{name} is being asked whether the patio escape route works for them.",
    "{name} steht vor dir": "{name} is parked in front of you",
    "Du musst {b_when} raus, {a_name} ({a_spot}) fährt erst {a_when}.":
        "You have to leave {b_when}, {a_name} ({a_spot}) isn't leaving until {a_when}.",
    "Notlösung: {route}. Kommt das für dich in Frage?": "Fallback: {route}. Does that work for you?",
    "Heute Abend tauschen?": "Swap spots this evening?",
    "{name} weicht übers Patio aus": "{name} will get out via the patio",
    "Du musst nichts tun.": "You don't need to do anything.",
    "{name} kann nicht übers Patio ausweichen": "{name} can't get out via the patio",
    "{a_spot} steht vor {b_spot}. Heute Abend tauschen?": "{a_spot} is in front of {b_spot}. Swap spots this evening?",
    "{name} kommt nicht mehr übers Patio raus. Bitte klärt den Konflikt ({a_spot} ↔ {b_spot}).":
        "{name} can no longer get out via the patio. Please sort out the conflict ({a_spot} ↔ {b_spot}).",
    "Patio-Notweg ist versperrt": "Patio escape route is blocked",
    "Tausch vereinbart": "Swap agreed",
    "{a_spot} ↔ {b_spot}: Bitte heute noch umparken und in der App „Getauscht“ tippen.":
        "{a_spot} ↔ {b_spot}: Please swap spots today and tap “Swapped” in the app.",
    "{name} möchte tauschen": "{name} would like to swap",
    "{a_spot} ↔ {b_spot} – bist du einverstanden?": "{a_spot} ↔ {b_spot} – is that OK with you?",
    "{name} lässt dich raus": "{name} will let you out",
    "{name} fährt {when} rechtzeitig zur Seite.": "{name} will move out of the way in time {when}.",
    "Gleich: {name} muss raus": "Soon: {name} has to leave",
    "{b_car} auf {b_spot} fährt {when} – dein Auto auf {a_spot} steht davor.":
        "{b_car} on {b_spot} leaves {when} – your car on {a_spot} is in front of it.",
    # „Ich will gleich rausfahren“
    "Dein {car} auf {spot} steht {name} ({their_spot}) im Weg. Bitte kurz umparken.":
        "Your {car} on {spot} is in the way of {name} ({their_spot}). Please move it briefly.",
    " Alternativ könnte auch {who} Platz machen.": " Alternatively, {who} could make room.",
    " oder ": " or ",
    "Erinnerung: {name} wartet": "Reminder: {name} is waiting",
    "{name} will gleich rausfahren": "{name} wants to leave now",
    "Deine Anfrage läuft schon": "Your request is already running",
    "Das Auto ist gerade nicht geparkt": "The car isn't parked right now",
    "Du kommst raus – niemand steht im Weg": "You can get out – nobody is in the way",
    "Anfrage nicht (mehr) offen": "Request is no longer open",
    "Bitte noch {n} Min. warten": "Please wait {n} more min.",
    "Du stehst bei dieser Anfrage nicht im Weg": "You're not in the way for this request",
    "{name} kommt sofort": "{name} is coming right away",
    "{name} braucht noch ~{n} Min.": "{name} needs about {n} more min.",
    "Auto auf {spot} wird umgeparkt.": "The car on {spot} is being moved.",
    "Weg ist frei 🚗": "The way is clear 🚗",
    "Du kannst jetzt rausfahren.": "You can drive out now.",
    # API-Fehler
    "Auto nicht gefunden": "Car not found",
    "„{key}“ fehlt": "“{key}” is missing",
    "Einladungscode stimmt nicht": "Invite code is wrong",
    "Ungültige Farbe": "Invalid colour",
    "Ungültige Einstellung": "Invalid setting",
    "Ungültige Sprache": "Invalid language",
    "Mindestens einen Wochentag wählen": "Choose at least one weekday",
    "Uhrzeit als HH:MM angeben": "Enter the time as HH:MM",
    "Nicht gefunden": "Not found",
    "Datum als JJJJ-MM-TT angeben": "Enter the date as YYYY-MM-DD",
    "Ausfahrzeit muss in der Zukunft liegen": "Departure time must be in the future",
    "Stellplatz nicht gefunden": "Parking spot not found",
    "Der Platz ist schon belegt": "That spot is already taken",
    "Konflikt nicht (mehr) aktiv": "Conflict is no longer active",
    "Nicht dein Konflikt": "Not your conflict",
    "Ungültige Auswahl": "Invalid choice",
    "Der Patio-Notweg steht hier nicht zur Wahl": "The patio escape route isn't an option here",
    "Beide müssen dem Tausch zustimmen": "Both of you have to agree to the swap",
    "Anfrage nicht gefunden": "Request not found",
    "Ungültige Antwort": "Invalid answer",
    "Nicht dein Auto": "Not your car",
    "Ungültiges Push-Abo": "Invalid push subscription",
    "Methode nicht erlaubt": "Method not allowed",
    "Bitte zuerst anmelden": "Please sign in first",
    "Unbekannter Endpunkt": "Unknown endpoint",
    "Interner Fehler": "Internal error",
    "Ungültiges JSON": "Invalid JSON",
    "Du bist dann nicht da – bitte vorher umparken oder einen Tausch vereinbaren.": "You'll be away then – please move your car beforehand or arrange a swap.",
    "{a_name} ist bis {away_until} nicht da und kann das Auto nicht wegfahren.": "{a_name} is away until {away_until} and can't move the car.",
    "Rückkehr muss in der Zukunft liegen": "Return must be in the future",
    "Beginn muss vor der Rückkehr liegen": "Start must be before the return",
    "Höchstens 60 Tage im Voraus": "At most 60 days ahead",
    # Push-Test
    "Push-Nachrichten funktionieren.": "Push notifications are working.",
}

ES = {
    # Zeitangaben
    "unbekannt": "desconocido",
    "heute": "hoy",
    "morgen": "mañana",
    "übermorgen": "pasado mañana",
    "zu unbekannter Zeit": "una hora sin determinar",
    # Patio-Notweg
    "rückwärts über {via} auf {to}": "marcha atrás por {via} hasta {to}",
    "rückwärts auf {to}": "marcha atrás hasta {to}",
    ", dann über {via} hinaus": ", luego salir por {via}",
    ", dann hinaus": ", luego salir",
    # Konflikte
    "Du stehst dir selbst im Weg": "Te estás bloqueando a ti mismo/a",
    "{b_car} ({b_spot}) muss {b_when} raus, {a_car} ({a_spot}) steht davor.":
        "{b_car} ({b_spot}) tiene que salir {b_when}, {a_car} ({a_spot}) está delante.",
    "Du blockierst {name}": "Estás bloqueando a {name}",
    "{b_name} muss {b_when} raus ({b_spot}), du fährst erst {a_when}.":
        "{b_name} tiene que salir {b_when} ({b_spot}), tú no sales hasta {a_when}.",
    "{name} wird gefragt, ob der Patio-Notweg in Frage kommt.":
        "Se pregunta a {name} si le sirve la salida por el patio.",
    "{name} steht vor dir": "{name} está aparcado/a delante de ti",
    "Du musst {b_when} raus, {a_name} ({a_spot}) fährt erst {a_when}.":
        "Tienes que salir {b_when}, {a_name} ({a_spot}) no sale hasta {a_when}.",
    "Notlösung: {route}. Kommt das für dich in Frage?": "Salida de emergencia: {route}. ¿Te sirve esta opción?",
    "Heute Abend tauschen?": "¿Intercambiar plazas esta noche?",
    "{name} weicht übers Patio aus": "{name} saldrá por el patio",
    "Du musst nichts tun.": "No tienes que hacer nada.",
    "{name} kann nicht übers Patio ausweichen": "{name} no puede salir por el patio",
    "{a_spot} steht vor {b_spot}. Heute Abend tauschen?": "{a_spot} está delante de {b_spot}. ¿Intercambiar plazas esta noche?",
    "{name} kommt nicht mehr übers Patio raus. Bitte klärt den Konflikt ({a_spot} ↔ {b_spot}).":
        "{name} ya no puede salir por el patio. Resolved el conflicto, por favor ({a_spot} ↔ {b_spot}).",
    "Patio-Notweg ist versperrt": "La salida por el patio está bloqueada",
    "Tausch vereinbart": "Intercambio acordado",
    "{a_spot} ↔ {b_spot}: Bitte heute noch umparken und in der App „Getauscht“ tippen.":
        "{a_spot} ↔ {b_spot}: Cambiad hoy de plaza y tocad «Intercambiado» en la app, por favor.",
    "{name} möchte tauschen": "{name} quiere intercambiar",
    "{a_spot} ↔ {b_spot} – bist du einverstanden?": "{a_spot} ↔ {b_spot} – ¿estás de acuerdo?",
    "{name} lässt dich raus": "{name} te dejará salir",
    "{name} fährt {when} rechtzeitig zur Seite.": "{name} se apartará a tiempo {when}.",
    "Gleich: {name} muss raus": "En breve: {name} tiene que salir",
    "{b_car} auf {b_spot} fährt {when} – dein Auto auf {a_spot} steht davor.":
        "{b_car} en {b_spot} sale {when} – tu coche en {a_spot} está delante.",
    # „Ich will gleich rausfahren“
    "Dein {car} auf {spot} steht {name} ({their_spot}) im Weg. Bitte kurz umparken.":
        "Tu {car} en {spot} bloquea a {name} ({their_spot}). Por favor, muévelo un momento.",
    " Alternativ könnte auch {who} Platz machen.": " También podría dejar paso {who}.",
    " oder ": " o ",
    "Erinnerung: {name} wartet": "Recordatorio: {name} está esperando",
    "{name} will gleich rausfahren": "{name} quiere salir ahora",
    "Deine Anfrage läuft schon": "Tu solicitud ya está en curso",
    "Das Auto ist gerade nicht geparkt": "El coche no está aparcado ahora mismo",
    "Du kommst raus – niemand steht im Weg": "Puedes salir – nadie te bloquea",
    "Anfrage nicht (mehr) offen": "La solicitud ya no está abierta",
    "Bitte noch {n} Min. warten": "Espera {n} min más, por favor",
    "Du stehst bei dieser Anfrage nicht im Weg": "No estás bloqueando en esta solicitud",
    "{name} kommt sofort": "{name} viene enseguida",
    "{name} braucht noch ~{n} Min.": "{name} necesita unos {n} min más",
    "Auto auf {spot} wird umgeparkt.": "Se está moviendo el coche de {spot}.",
    "Weg ist frei 🚗": "El camino está libre 🚗",
    "Du kannst jetzt rausfahren.": "Ya puedes salir.",
    # API-Fehler
    "Auto nicht gefunden": "Coche no encontrado",
    "„{key}“ fehlt": "Falta «{key}»",
    "Einladungscode stimmt nicht": "El código de invitación no es correcto",
    "Ungültige Farbe": "Color no válido",
    "Ungültige Einstellung": "Ajuste no válido",
    "Ungültige Sprache": "Idioma no válido",
    "Mindestens einen Wochentag wählen": "Elige al menos un día de la semana",
    "Uhrzeit als HH:MM angeben": "Indica la hora como HH:MM",
    "Nicht gefunden": "No encontrado",
    "Datum als JJJJ-MM-TT angeben": "Indica la fecha como AAAA-MM-DD",
    "Ausfahrzeit muss in der Zukunft liegen": "La hora de salida tiene que ser en el futuro",
    "Stellplatz nicht gefunden": "Plaza no encontrada",
    "Der Platz ist schon belegt": "La plaza ya está ocupada",
    "Konflikt nicht (mehr) aktiv": "El conflicto ya no está activo",
    "Nicht dein Konflikt": "No es tu conflicto",
    "Ungültige Auswahl": "Opción no válida",
    "Der Patio-Notweg steht hier nicht zur Wahl": "La salida por el patio no es una opción aquí",
    "Beide müssen dem Tausch zustimmen": "Los dos tenéis que aceptar el intercambio",
    "Anfrage nicht gefunden": "Solicitud no encontrada",
    "Ungültige Antwort": "Respuesta no válida",
    "Nicht dein Auto": "No es tu coche",
    "Ungültiges Push-Abo": "Suscripción push no válida",
    "Methode nicht erlaubt": "Método no permitido",
    "Bitte zuerst anmelden": "Inicia sesión primero, por favor",
    "Unbekannter Endpunkt": "Dirección desconocida",
    "Interner Fehler": "Error interno",
    "Ungültiges JSON": "JSON no válido",
    "Du bist dann nicht da – bitte vorher umparken oder einen Tausch vereinbaren.": "Entonces no estarás – por favor, mueve el coche antes o acuerda un intercambio.",
    "{a_name} ist bis {away_until} nicht da und kann das Auto nicht wegfahren.": "{a_name} no está hasta {away_until} y no puede mover el coche.",
    "Rückkehr muss in der Zukunft liegen": "La vuelta tiene que ser en el futuro",
    "Beginn muss vor der Rückkehr liegen": "El inicio tiene que ser antes de la vuelta",
    "Höchstens 60 Tage im Voraus": "Como máximo 60 días por adelantado",
    # Push-Test
    "Push-Nachrichten funktionieren.": "Las notificaciones push funcionan.",
}

WEEKDAYS = {"de": ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
            "en": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
            "es": ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]}
MONTHS = {"en": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
          "es": ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]}


def norm(lang):
    """Unbekannte oder fehlende Angaben → Deutsch."""
    return lang if lang in LANGS else "de"


def t(lang, text, **values):
    table = {"en": EN, "es": ES}.get(lang)
    s = table.get(text, text) if table else text
    return s.format(**values) if values else s


def lang_of(conn, resident_id):
    row = conn.execute("SELECT lang FROM resident WHERE id = ?", (resident_id,)).fetchone()
    return norm(row[0] if row else None)


def fmt_day(lang, local_date, days_from_today):
    """Tag als Wort („morgen“) oder kurz mit Datum („Mo 10.11.“ / „Mon 10 Nov“ / „lun 10 nov“)."""
    word = {0: "heute", 1: "morgen", 2: "übermorgen"}.get(days_from_today)
    if word:
        return t(lang, word)
    wd = WEEKDAYS[lang][local_date.weekday()]
    if lang in MONTHS:
        return f"{wd} {local_date.day} {MONTHS[lang][local_date.month - 1]}"
    return f"{wd} {local_date:%d.%m.}"
