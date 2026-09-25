"""Single-owner dashboard login. Secrets never enter HTML or source control."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import threading
import time
from http.cookies import SimpleCookie

ROOT = Path(__file__).resolve().parent
FILE = ROOT / "auth.json"
LOCK = threading.RLock()
SESSIONS = {}
ATTEMPTS = []
SESSION_SECONDS = 12 * 60 * 60


def configured():
    return FILE.is_file()


def _derive(password, salt):
    return hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt), n=2**14, r=8, p=1).hex()


def enroll(password):
    if not isinstance(password, str) or len(password) < 12 or len(password) > 256:
        raise ValueError("Choose a password of at least 12 characters")
    with LOCK:
        if configured():
            raise ValueError("Owner login already configured")
        salt = secrets.token_hex(16)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        fd = os.open(FILE, flags, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as target:
                json.dump({"salt": salt, "hash": _derive(password, salt)}, target)
        except BaseException:
            FILE.unlink(missing_ok=True)
            raise


def login(password):
    now = time.monotonic()
    with LOCK:
        ATTEMPTS[:] = [at for at in ATTEMPTS if now - at < 60]
        if len(ATTEMPTS) >= 8:
            return None
        ATTEMPTS.append(now)
        try:
            stored = json.loads(FILE.read_text(encoding="utf-8"))
            correct = secrets.compare_digest(_derive(password, stored["salt"]), stored["hash"])
        except (OSError, ValueError, KeyError, TypeError):
            return None
        if not correct:
            return None
        ATTEMPTS.clear()
        sid = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(24)
        SESSIONS[sid] = {"csrf": csrf, "expires": now + SESSION_SECONDS}
        return sid, csrf


def session(cookie_header):
    jar = SimpleCookie()
    try:
        jar.load(cookie_header or "")
        sid = jar["zuzu_session"].value
    except (KeyError, ValueError):
        return None
    with LOCK:
        item = SESSIONS.get(sid)
        if item and item["expires"] > time.monotonic():
            return item
        SESSIONS.pop(sid, None)
    return None


def logout(cookie_header):
    jar = SimpleCookie()
    try:
        jar.load(cookie_header or "")
        sid = jar["zuzu_session"].value
    except (KeyError, ValueError):
        return
    with LOCK:
        SESSIONS.pop(sid, None)
