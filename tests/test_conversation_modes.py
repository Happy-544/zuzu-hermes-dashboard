import io
import json
import pathlib
import unittest
import tempfile
from unittest import mock

import runtime
import server
import workspace


class ConversationModeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        patch = mock.patch.object(workspace, "FILE", pathlib.Path(self.temp.name) / "workspace.json")
        patch.start()
        self.addCleanup(patch.stop)
    def test_uncensored_provider_catalogue_has_live_venice_and_openrouter_ids(self):
        self.assertIn("venice-uncensored-1-2", workspace.MODELS["venice"])
        self.assertIn("e2ee-gemma-4-26b-a4b-uncensored-p", workspace.MODELS["venice"])
        self.assertIn("cognitivecomputations/dolphin-mistral-24b-venice-edition", workspace.MODELS["openrouter"])
        self.assertIn("thedrummer/cydonia-24b-v4.1", workspace.MODELS["openrouter"])

    def test_venice_uses_its_openai_compatible_api(self):
        with mock.patch.object(runtime, "PROVIDER", "venice"), \
             mock.patch.object(runtime, "MODEL", "venice-uncensored-1-2"), \
             mock.patch.dict("os.environ", {"VENICE_API_KEY": "private", "JARVIS_API_BASE": ""}, clear=False), \
             mock.patch("urllib.request.urlopen") as request:
            response = mock.MagicMock()
            response.__enter__.return_value.read.return_value = json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode()
            request.return_value = response
            events = list(runtime.run_provider("hello"))
        called = request.call_args.args[0]
        self.assertEqual(called.full_url, "https://api.venice.ai/api/v1/chat/completions")
        self.assertEqual(called.headers["Authorization"], "Bearer private")
        self.assertEqual(events[-1]["t"], "complete")

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

    def test_project_override_and_fallback_route_are_ordered(self):
        state = {
            "settings": {"provider": "gemini", "model": "gemini-2.5-flash",
                         "fallbacks": [{"provider": "openrouter", "model": "openrouter/auto"}],
                         "providerSettings": {"venice": {"endpoint": "https://api.venice.ai/api"}}},
            "selectedProject": "p1",
            "projects": [{"id": "p1", "modelOverride": {"provider": "venice", "model": "venice-uncensored-1-2"}}],
        }
        route = workspace.model_route(state)
        self.assertEqual(route[0], {"provider": "venice", "model": "venice-uncensored-1-2", "apiBase": "https://api.venice.ai/api"})
        self.assertEqual(route[1]["provider"], "openrouter")

    def test_model_console_contains_voice_fallback_project_and_provider_controls(self):
        html = pathlib.Path(server.UI / "index.html").read_text(encoding="utf-8")
        for control in ("voiceEngine", "fallbackChain", "projectProvider", "providerSettings"):
            self.assertIn(f'id="{control}"', html)

    def test_direct_mode_calls_selected_model_without_hermes_or_commands(self):
        handler = object.__new__(server.Handler)
        handler.wfile = io.BytesIO()
        handler.send_response = mock.Mock()
        handler.send_header = mock.Mock()
        handler.end_headers = mock.Mock()
        state = workspace.load()
        state["settings"]["conversationMode"] = "direct"
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
        self.assertIn('settings.get("voiceEngine", "gemini-live") == "gemini-live" and voice.live_available()', source)
        self.assertIn('tts=voice.tts_provider() if conversation_mode == "hybrid" else "browser"', source)
        self.assertIn('Gemini Live conversation is available only in Hybrid mode', source)


if __name__ == "__main__":
    unittest.main()
