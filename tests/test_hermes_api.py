import io
import json
import os
import unittest
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


class HermesApiTests(unittest.TestCase):
    def test_empty_api_base_uses_loopback_default(self):
        with mock.patch.dict(os.environ, {"HERMES_API_BASE": ""}, clear=False):
            self.assertEqual(hermes_api._base(), "http://127.0.0.1:8642")

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
