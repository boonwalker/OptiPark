"""Web-Push (VAPID). Schlüssel werden beim ersten Start erzeugt und im Datenordner abgelegt."""
import base64
import json
import logging
import os
import threading

from .db import DATA_DIR, read, tx

log = logging.getLogger("push")

try:
    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid
    from pywebpush import WebPushException, webpush
    AVAILABLE = True
except ImportError:  # App läuft auch ohne Push
    AVAILABLE = False

KEY_FILE = DATA_DIR / "vapid_private.pem"
VAPID_SUB = os.environ.get("PARK_VAPID_SUB", "mailto:parkplatz@example.com")
_vapid = None
_public_key = None


def init():
    global _vapid, _public_key
    if not AVAILABLE:
        log.warning("pywebpush nicht installiert – Push deaktiviert")
        return
    if KEY_FILE.exists():
        _vapid = Vapid.from_file(str(KEY_FILE))
    else:
        _vapid = Vapid()
        _vapid.generate_keys()
        _vapid.save_key(str(KEY_FILE))
    raw = _vapid.public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    _public_key = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def public_key():
    return _public_key


def send_async(messages):
    if messages and _vapid:
        threading.Thread(target=_send_all, args=(messages,), daemon=True).start()


def _send_all(messages):
    with read() as conn:
        for m in messages:
            subs = conn.execute(
                "SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE resident_id = ?",
                (m["resident_id"],)).fetchall()
            payload = json.dumps({k: m[k] for k in ("title", "body", "url", "tag")})
            for s in subs:
                try:
                    webpush({"endpoint": s["endpoint"], "keys": {"p256dh": s["p256dh"], "auth": s["auth"]}},
                            payload, vapid_private_key=_vapid, vapid_claims={"sub": VAPID_SUB}, ttl=6 * 3600)
                except WebPushException as e:
                    status = getattr(e.response, "status_code", None)
                    if status in (404, 410):  # Abo abgelaufen
                        with tx() as w:
                            w.execute("DELETE FROM push_subscription WHERE id = ?", (s["id"],))
                    else:
                        log.warning("Push fehlgeschlagen (%s): %s", status, e)
                except Exception as e:
                    log.warning("Push fehlgeschlagen: %s", e)
