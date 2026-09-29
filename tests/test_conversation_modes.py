import io
import json
import pathlib
import unittest
from unittest import mock

import runtime
import server
import workspace


class ConversationModeTests(unittest.TestCase):
    def test_settings_persist_a_valid_mode_and_reject_direct_hermes(self):
        state = workspace.load()
        settings = {**state["settings"], "conversationMode": "hermes"}
        with mock.patch.object(workspace, "load", return_value=state), \
             mock.patch.object(workspace, "save") as save, \
             mock.patch.object(workspace, "_env_update"):
            workspace.action({"action": "save_settings", "settings": settings})
            self.assertEqual(save.call_args.args[0]["settings"]["conversationMode"], "hermes")

        settings.update(conversationMode="direct", provider="hermes")
        with mock.patch.object(workspace, "load", return_value=state):
            with self.assertRaisesRegex(ValueError, "configured model provider"):
                workspace.action({"action": "save_settings", "settings": settings})

    def test_direct_mode_calls_selected_model_without_hermes_or_commands(self):
        handler = object.__new__(server.Handler)
        handler.wfile = io.BytesIO()
        handler.send_response = mock.Mock()
        handler.send_header = mock.Mock()
        handler.end_headers = mock.Mock()
        state = {"settings": {"conversationMode": "direct", "provider": "gemini", "model": "gemini-2.5-flash"}}
        events = iter(({"t": "delta", "text": "direct answer"}, {"t": "complete", "ms": 1}))
        with mock.patch.object(workspace, "load", return_value=state), \
             mock.patch.object(runtime, "run_gemini", return_value=events) as direct, \
             mock.patch.object(server.hermes_api, "run_hermes") as hermes, \
             mock.patch.object(server.commands, "handle") as commands:
            handler._stream_run(json.dumps({"message": "hello"}).encode())
        direct.assert_called_once()
        hermes.assert_not_called()
        commands.assert_not_called()
        output = handler.wfile.getvalue().decode()
        self.assertIn("direct answer", output)

    def test_non_hybrid_status_disables_gemini_live_and_native_tts(self):
        source = pathlib.Path(server.__file__).read_text(encoding="utf-8")
        self.assertIn('live_enabled = conversation_mode == "hybrid" and voice.live_available()', source)
        self.assertIn('tts=voice.tts_provider() if conversation_mode == "hybrid" else "browser"', source)
        self.assertIn('Gemini Live conversation is available only in Hybrid mode', source)


if __name__ == "__main__":
    unittest.main()
