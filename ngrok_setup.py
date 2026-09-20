"""Short-lived, one-use mobile setup. Never returns or logs the ngrok token."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time

LOCK = threading.Lock()
SETUP_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "ngrok"


class SetupStore:
    def __init__(self, directory=SETUP_DIR):
        self.directory = Path(directory)
        self.state = self.directory / "jarvis-setup.json"
        self.config = self.directory / "jarvis.yml"

    def active(self):
        try:
            state = json.loads(self.state.read_text(encoding="utf-8"))
            return not self.config.exists() and state["expires"] > time.time()
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def authorized(self, key):
        if not isinstance(key, str) or not 32 <= len(key) <= 128 or not self.active():
            return False
        try:
            expected = json.loads(self.state.read_text(encoding="utf-8"))["key_hash"]
            return secrets.compare_digest(hashlib.sha256(key.encode()).hexdigest(), expected)
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def save(self, key, token):
        with LOCK:
            if not self.authorized(key):
                return {"error": "This setup link is invalid, expired, or already used."}, 403
            if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{20,256}", token):
                return {"error": "Paste only your ngrok authtoken, not the install command."}, 400
            # The directory is provisioned with a private ACL before enabling setup.
            # Exclusive creation preserves any existing configuration on retries.
            try:
                with self.config.open("x", encoding="utf-8", newline="\n") as target:
                    target.write('version: "3"\nagent:\n  authtoken: ' + json.dumps(token)
                                 + '\n  web_addr: 127.0.0.1:4040\n  console_ui: false\n')
                    target.flush()
                    os.fsync(target.fileno())
            except FileExistsError:
                return {"error": "Already configured. Existing credentials were preserved."}, 409
            except OSError:
                # Do not expose filesystem exceptions or credential-bearing data.
                return {"error": "Could not save on the PC. Ask to check local setup."}, 503
            # Config presence also disables the capability if deletion fails.
            try:
                self.state.unlink(missing_ok=True)
            except OSError:
                pass
            return {"saved": True, "message": "Saved privately on your PC. Return to the chat and say Done."}, 200


STORE = SetupStore()


def handle_post(handler):
    # Require the one-time capability in addition to the server's exact origin check.
    handler.close_connection = True
    key = handler.headers.get("X-Setup-Key", "")
    if not STORE.authorized(key):
        return handler._json({"error": "Setup link is invalid, expired, or already used."}, 403)
    if handler.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json":
        return handler._json({"error": "JSON required"}, 415)
    try:
        body = json.loads(handler._read(2048))
        if not isinstance(body, dict):
            raise ValueError()
    except (ValueError, TypeError):
        return handler._json({"error": "Invalid setup request"}, 400)
    result, status = STORE.save(key, body.get("token"))
    return handler._json(result, status)
