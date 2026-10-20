import io
import json
import os
import unittest
import threading
import time
from unittest import mock

import hermes_api


class _Response:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return json.dumps(self.body).encode()


class _HealthResponse(_Response):
    def __init__(self, body, content_type="application/json"):
        super().__init__(body)
        self.headers = {"Content-Type": content_type}

    def __iter__(self):
        return iter([self.read()])


class HermesApiTests(unittest.TestCase):
    def test_completion_does_not_wait_for_upstream_socket_to_close(self):
        release = threading.Event()
        class OpenStream:
            def __iter__(self):
                yield b'event: run.completed\n'
                yield b'data: {}\n'
                release.wait(5)
            def close(self):
                release.set()
        try:
            with mock.patch.object(hermes_api, "_request", return_value=OpenStream()):
                started = time.monotonic()
                events = list(hermes_api.run_hermes("Hi", "session_12345678"))
            self.assertLess(time.monotonic() - started, 1)
            self.assertEqual(events[-1]["t"], "complete")
        finally:
            release.set()

    def test_history_reads_every_page_in_chronological_order(self):
        first = [{"role": "user", "content": str(i)} for i in range(500)]
        second = [{"role": "assistant", "content": "last"}]
        with mock.patch.object(hermes_api, "_request", side_effect=[
                _Response({"data": first}), _Response({"data": second})]) as request:
            items = hermes_api.messages("session_12345678")
        self.assertEqual(len(items), 501)
        self.assertEqual(items[0]["content"], "0")
        self.assertEqual(items[-1]["content"], "last")
        self.assertIn("order=oldest&offset=500", request.call_args.args[0])

    def test_empty_api_base_uses_loopback_default(self):
        with mock.patch.dict(os.environ, {"HERMES_API_BASE": ""}, clear=False):
            self.assertEqual(hermes_api._base(), "http://127.0.0.1:8642")

    def test_health_rejects_dashboard_html_as_api(self):
        response = _HealthResponse("<html>dashboard</html>", "text/html; charset=utf-8")
        with mock.patch.dict(os.environ, {"HERMES_API_KEY": "test"}), \
             mock.patch.object(hermes_api, "_request", return_value=response):
            result = hermes_api.health()
        self.assertFalse(result["connected"])
        self.assertIn("returned a web page", result["detail"])

    def test_failed_run_surfaces_provider_message(self):
        frames = [
            ("assistant.completed", {"content": "Provider credits exhausted"}),
            ("run.failed", {}),
        ]
        stream = io.BytesIO("".join(f"event: {name}\ndata: {json.dumps(body)}\n\n" for name, body in frames).encode())
        with mock.patch.dict(os.environ, {"HERMES_API_KEY": "test"}), \
             mock.patch.object(hermes_api, "_request", return_value=stream):
            events = list(hermes_api.run_hermes("Hi", "session_12345678", "Be brief"))
        self.assertEqual(events[-1], {"t": "error", "message": "Provider credits exhausted"})

    def test_reused_ui_title_gets_unique_internal_hermes_titles(self):
        seen = []

        def request(_path, body=None, **_kwargs):
            seen.append(body["title"])
            return _Response({"session": {"id": f"api_{len(seen):08d}"}})

        with mock.patch.object(hermes_api, "_request", side_effect=request), \
             mock.patch.object(hermes_api.time, "time", return_value=1234), \
             mock.patch.object(hermes_api.secrets, "token_hex", side_effect=["abc123", "def456"]):
            hermes_api.create_session("General", "persona")
            hermes_api.create_session("General", "persona")
        self.assertEqual(seen, ["General · 1234-abc123", "General · 1234-def456"])

    def test_sse_maps_deltas_tools_and_completion(self):
        frames = [
            ("assistant.delta", {"delta": "Hello"}),
            ("tool.started", {"tool_name": "web_search", "preview": "query"}),
            ("tool.completed", {"tool_name": "web_search"}),
            ("assistant.completed", {"content": "Hello"}),
            ("run.completed", {"usage": {"total_tokens": 5}}),
        ]
        stream = io.BytesIO("".join(f"event: {name}\ndata: {json.dumps(body)}\n\n" for name, body in frames).encode())
        with mock.patch.dict(os.environ, {"HERMES_API_KEY": "test"}):
            with mock.patch.object(hermes_api, "_request", return_value=stream) as request:
                events = list(hermes_api.run_hermes("Hi", "session_12345678", "Be brief"))
        self.assertEqual([e["t"] for e in events], ["status", "latency", "delta", "tool", "tool", "usage", "complete"])
        self.assertEqual(events[-1]["session_id"], "session_12345678")
        self.assertIn("/api/sessions/session_12345678/chat/stream", request.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
