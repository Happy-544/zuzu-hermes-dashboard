import json
import pathlib
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

import auth
import server


class SecurityHttpTests(unittest.TestCase):
    def test_local_enrollment_cookie_csrf_and_no_bearer_in_html(self):
        with tempfile.TemporaryDirectory() as folder:
            with mock.patch.object(auth, "FILE", pathlib.Path(folder) / "auth.json"):
                auth.SESSIONS.clear(); auth.ATTEMPTS.clear()
                http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
                port = http.server_address[1]
                old_port = server.PORT
                server.PORT = port
                thread = threading.Thread(target=http.serve_forever, daemon=True)
                thread.start()
                base = f"http://127.0.0.1:{port}"
                def post(path, body, headers=None):
                    return urllib.request.urlopen(urllib.request.Request(base + path,
                        data=json.dumps(body).encode(), method="POST",
                        headers={"Origin": base, "Content-Type": "application/json", **(headers or {})}))
                try:
                    with self.assertRaises(urllib.error.HTTPError) as denied:
                        post("/api/new", {})
                    self.assertEqual(denied.exception.code, 401)
                    with self.assertRaises(urllib.error.HTTPError) as denied:
                        post("/api/enroll", {"password": "long owner password"}, {"X-Forwarded-For": "198.51.100.2"})
                    self.assertEqual(denied.exception.code, 403)
                    with post("/api/enroll", {"password": "long owner password"}) as response:
                        cookie = response.headers["Set-Cookie"].split(";", 1)[0]
                        csrf = json.load(response)["csrf"]
                    with self.assertRaises(urllib.error.HTTPError) as denied:
                        post("/api/new", {}, {"Cookie": cookie})
                    self.assertEqual(denied.exception.code, 403)
                    with urllib.request.urlopen(urllib.request.Request(base + "/", headers={"Cookie": cookie})) as response:
                        html = response.read().decode()
                    self.assertIn(csrf, html)
                    self.assertNotIn("jarvis-token", html)
                    with mock.patch.object(server.hermes_api, "configured", return_value=True), \
                         mock.patch.object(server.hermes_api, "health", return_value={"connected": True, "pending": False, "detail": "ready"}), \
                         mock.patch.object(server.hermes_api, "toolsets", return_value=["web"]):
                        with urllib.request.urlopen(urllib.request.Request(base + "/api/status", headers={"Cookie": cookie})) as response:
                            self.assertTrue(json.load(response)["hermes_connected"])
                    self.assertIn("HttpOnly", post("/api/logout", {}, {"Cookie": cookie, "X-Zuzu-CSRF": csrf}).headers["Set-Cookie"])
                finally:
                    http.shutdown(); http.server_close(); server.PORT = old_port


if __name__ == "__main__":
    unittest.main()
