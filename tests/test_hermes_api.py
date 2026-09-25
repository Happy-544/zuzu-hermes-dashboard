import io
import json
import os
import unittest
from unittest import mock

import hermes_api


class HermesApiTests(unittest.TestCase):
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
