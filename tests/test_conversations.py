import io
import json
import pathlib
import tempfile
import unittest
from unittest import mock

import conversations
import hermes_api
import server
import workspace


class ConversationPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        patch = mock.patch.object(workspace, "FILE", pathlib.Path(self.temp.name) / "workspace.json")
        patch.start()
        self.addCleanup(patch.stop)
        workspace.save(workspace.load())

    def handler(self, sink=None):
        handler = object.__new__(server.Handler)
        handler.wfile = sink if sink is not None else io.BytesIO()
        handler.send_response = mock.Mock()
        handler.send_header = mock.Mock()
        handler.end_headers = mock.Mock()
        return handler

    def run_events(self, events, payload=None, sink=None):
        handler = self.handler(sink)
        with mock.patch.object(hermes_api, "configured", return_value=True), \
             mock.patch.object(hermes_api, "run_hermes", return_value=iter(events)) as run, \
             mock.patch.object(server, "persona", return_value="persona"), \
             mock.patch.object(server.commands, "handle", return_value=None):
            handler._stream_run(json.dumps(payload or {
                "message": "remember this", "project_id": "home", "chat_id": "main",
            }).encode())
        return handler, run

    def test_error_preserves_created_session_and_transcript(self):
        self.run_events([
            {"t": "status", "runtime": "hermes-api", "session_id": "session_12345678"},
            {"t": "error", "message": "Provider unavailable"},
        ])
        self.assertEqual(workspace.selected_hermes_session()[2], "session_12345678")
        _, runner = self.run_events([{"t": "complete", "session_id": "session_12345678"}])
        self.assertEqual(runner.call_args.args[1], "session_12345678")
        self.assertEqual(len(conversations.history("home", "main")), 2)

    def test_disconnected_client_does_not_lose_action_result(self):
        class Disconnected:
            def write(self, _):
                raise BrokenPipeError()
        self.run_events([
            {"t": "status", "runtime": "hermes-api", "session_id": "session_12345678"},
            {"t": "delta", "text": "Actual tool result"},
            {"t": "complete", "session_id": "session_12345678"},
        ], sink=Disconnected())
        self.assertEqual(conversations.history("home", "main")[-1]["content"], "Actual tool result")
        self.assertEqual(conversations.runs("home", "main")[0]["state"], "complete")

    def test_request_id_is_idempotent_but_same_text_can_be_sent_again(self):
        payload = {"message": "hello", "request_id": "one"}
        self.run_events([{"t": "delta", "text": "hi"}, {"t": "complete"}], payload)
        handler, runner = self.run_events([], payload)
        runner.assert_not_called()
        self.assertIn("already accepted", handler.wfile.getvalue().decode())
        self.run_events([{"t": "complete"}], {**payload, "request_id": "two"})
        self.assertEqual(len(conversations.runs("home", "main")), 2)

    def test_explicit_chat_survives_selection_change_and_switch_back(self):
        state = workspace.action({"action": "add_session", "projectId": "home", "name": "B"})
        second = state["selectedSession"]
        self.run_events([{"t": "status", "runtime": "hermes-api", "session_id": "session_A123456"},
                         {"t": "complete", "session_id": "session_A123456"}])
        self.assertEqual(workspace.selected_hermes_session()[0:2], ("home", second))
        self.assertIsNone(workspace.selected_hermes_session()[2])
        workspace.action({"action": "select_session", "projectId": "home", "sessionId": "main"})
        self.assertEqual(workspace.selected_hermes_session()[2], "session_A123456")
        self.assertEqual(conversations.history("home", second), [])

    def test_voice_transcript_updates_once_and_returns_as_bounded_context(self):
        conversations.add("home", "main", "user", "My project is Cedar", "voice", "u1")
        conversations.add("home", "main", "assistant", "I remember", "voice", "a1")
        conversations.add("home", "main", "assistant", "I remember Cedar", "voice", "a1")
        self.assertEqual(len(conversations.history("home", "main")), 2)
        self.assertIn("Cedar", conversations.context("home", "main"))
        self.assertNotIn("Cedar", conversations.context("other", "chat"))
        _, runner = self.run_events([{"t": "complete"}])
        self.assertIn("My project is Cedar", runner.call_args.args[2])

    def test_restart_marks_pending_request_interrupted_without_repeating(self):
        conversations.start("home", "main", "pending", "send email")
        conversations.event("pending", {"t": "delta", "text": "Partial result"})
        conversations.recover()
        self.assertEqual(conversations.runs("home", "main")[0]["state"], "error")
        self.assertIn("may have run", conversations.runs("home", "main")[0]["detail"])
        self.assertFalse(conversations.start("home", "main", "pending", "send email"))
        self.assertEqual(conversations.history("home", "main")[-1]["content"], "Partial result")

    def test_direct_model_receives_its_own_previous_messages(self):
        state = workspace.load()
        state["settings"]["conversationMode"] = "direct"
        workspace.save(state)
        conversations.add("home", "main", "user", "My project is Cedar", "text")
        handler = self.handler()
        with mock.patch.object(server, "direct_model_persona", return_value="persona"), \
             mock.patch.object(server.runtime, "run_gemini", return_value=iter([
                 {"t": "delta", "text": "Cedar"}, {"t": "complete"}])) as runner, \
             mock.patch.object(hermes_api, "run_hermes") as hermes:
            handler._stream_run(b'{"message":"What project?"}')
        self.assertIn("Cedar", runner.call_args.args[1])
        hermes.assert_not_called()


if __name__ == "__main__":
    unittest.main()
