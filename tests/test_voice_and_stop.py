import http.server
import json
import os
import pathlib
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

import auth
import hermes_api
import server
import voice
import workspace

ROOT = pathlib.Path(__file__).resolve().parents[1]


class StopTests(unittest.TestCase):
    def test_stop_ends_a_streaming_hermes_api_run(self):
        class SlowStream(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(b'event: assistant.delta\ndata: {"delta": "hi"}\n\n')
                self.wfile.flush()
                time.sleep(10)

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), SlowStream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        env = {"HERMES_API_KEY": "k", "HERMES_API_BASE": f"http://127.0.0.1:{upstream.server_port}"}
        try:
            with mock.patch.dict(os.environ, env):
                threading.Timer(0.5, hermes_api.cancel_active).start()
                started = time.monotonic()
                events = list(hermes_api.run_hermes("long task", "session_12345678"))
        finally:
            upstream.shutdown()
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(events[-1], {"t": "error", "message": "Stopped by user."})
        self.assertFalse(hermes_api.cancel_active())

    def test_stop_button_is_wired(self):
        html = (ROOT / "ui" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "ui" / "app.js").read_text(encoding="utf-8")
        self.assertIn('id="stopBtn"', html)
        self.assertIn("$('#stopBtn').onclick = stopEverything", script)
        self.assertIn("/api/cancel", script)


class CommandCenterTests(unittest.TestCase):
    def test_pc_snapshot_has_core_fields(self):
        info = server.system_snapshot()
        for key in ("host", "os", "cpus", "memory", "disk", "uptime"):
            self.assertIn(key, info)

    def test_main_page_cards_are_wired(self):
        html = (ROOT / "ui" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "ui" / "app.js").read_text(encoding="utf-8")
        for element in ("ccNow", "ccProject", "ccSessions", "ccBrain", "ccPc", "ccProfile", "ccFeed", "ccYou", "ccZuzu"):
            self.assertIn(f'id="{element}"', html)
        self.assertGreaterEqual(html.count("data-cc-run=") + html.count("data-cc-compose="), 7)
        self.assertIn("/api/system", script)


class NavigationTests(unittest.TestCase):
    def test_five_sections_reach_every_page(self):
        html = (ROOT / "ui" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "ui" / "app.js").read_text(encoding="utf-8")
        for group in ("home", "day", "work", "brain", "tools", "settings"):
            self.assertIn(f'data-group="{group}"', html)
        for page in ("chat", "reminders", "markets", "library", "projects", "missions", "studio", "memory", "skills", "tools", "calls", "settings", "models", "activity"):
            self.assertIn(f'data-view-panel="{page}"', html)
            self.assertIn(f"'{page}'", script.split("const VIEW_GROUPS", 1)[1].split("};", 1)[0])
        self.assertEqual(html.count('class="nav-item'), 6)


class ReadAloudTokenTests(unittest.TestCase):
    def test_speak_token_uses_live_model_and_voice_without_tools(self):
        with tempfile.TemporaryDirectory() as folder, \
             mock.patch.object(auth, "FILE", pathlib.Path(folder) / "auth.json"), \
             mock.patch.object(workspace, "FILE", pathlib.Path(folder) / "workspace.json"), \
             mock.patch.object(voice, "create_live_token", return_value={
                 "token": "t", "model": "gemini-2.5-flash-native-audio-preview-12-2025", "voice": "Kore"}):
            auth.SESSIONS.clear(); auth.ATTEMPTS.clear()
            http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            old_port, server.PORT = server.PORT, http.server_address[1]
            threading.Thread(target=http.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{server.PORT}"

            def post(path, body, headers=None):
                return urllib.request.urlopen(urllib.request.Request(base + path, data=json.dumps(body).encode(),
                    method="POST", headers={"Origin": base, "Content-Type": "application/json", **(headers or {})}))
            try:
                with post("/api/enroll", {"password": "long owner password"}) as response:
                    cookie = response.headers["Set-Cookie"].split(";", 1)[0]
                    csrf = json.load(response)["csrf"]
                with post("/api/live-token", {"purpose": "speak"}, {"Cookie": cookie, "X-Zuzu-CSRF": csrf}) as response:
                    data = json.load(response)
            finally:
                http.shutdown(); server.PORT = old_port
        self.assertEqual(data["model"], "gemini-2.5-flash-native-audio-preview-12-2025")
        self.assertEqual(data["voice"], workspace.DEFAULT["settings"]["voice"])
        self.assertEqual(data["tools"], [])
        self.assertIn("word for word", data["system"])


if __name__ == "__main__":
    unittest.main()
