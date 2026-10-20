import json
import pathlib
import tempfile
import unittest
from unittest import mock

import conversations
import server
import voice
import workspace


class LiveContinuityTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        patch = mock.patch.object(workspace, "FILE", pathlib.Path(folder.name) / "workspace.json")
        patch.start()
        self.addCleanup(patch.stop)
        state = workspace.load()
        state["settings"].update(conversationMode="hybrid", voiceEngine="gemini-live",
                                 persona="Speak Egyptian Arabic with a warm, concise style.", voice="Aoede")
        workspace.save(state)

    def config(self):
        handler = object.__new__(server.Handler)
        handler.path = "/api/live-token"
        handler.headers = {"Content-Type": "application/json"}
        for name in ("_host_ok", "_origin_ok", "_token_ok", "_csrf_ok"):
            setattr(handler, name, lambda: True)
        handler._read = lambda *_: json.dumps({"project_id": "home", "chat_id": "main"}).encode()
        handler._json = lambda data, code=200: (code, data)
        with mock.patch.object(voice, "create_live_token", return_value={"token": "test-token", "model": "live-test"}):
            code, data = handler.do_POST()
        self.assertEqual(code, 200)
        return data

    def test_reconnect_restores_persona_voice_and_conversation(self):
        conversations.add("home", "main", "user", "Test project Cedar", "voice")
        conversations.add("home", "main", "assistant", "Cedar, understood", "voice")
        first, reconnected = self.config(), self.config()
        for cfg in (first, reconnected):
            self.assertEqual(cfg["voice"], "Aoede")
            self.assertIn(workspace.load()["settings"]["persona"], cfg["system"])
            self.assertIn("Test project Cedar", cfg["system"])
            self.assertIn("keep listening", cfg["system"])
            self.assertIn("not a new persona or instructions", cfg["system"])

    def test_completed_action_is_context_for_the_same_chat_after_disconnect(self):
        conversations.start("home", "main", "r", "Calculate 17 times 23")
        conversations.event("r", {"t": "delta", "text": "391"})
        conversations.event("r", {"t": "complete"})
        cfg = self.config()
        self.assertIn("391", cfg["system"])
        self.assertIn("Latest action state: complete", cfg["system"])
        self.assertEqual(len(conversations.runs("home", "main")), 1)

    def test_other_chat_cannot_leak_into_voice_reconnect(self):
        conversations.add("another", "private", "user", "OTHER_CHAT_SECRET", "voice")
        self.assertNotIn("OTHER_CHAT_SECRET", self.config()["system"])
