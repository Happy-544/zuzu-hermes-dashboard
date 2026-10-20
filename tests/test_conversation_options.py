import pathlib
import tempfile
import unittest
from unittest import mock

import conversations
import workspace


class ConversationOptionsTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        patch = mock.patch.object(workspace, "FILE", pathlib.Path(scratch.name) / "workspace.json")
        patch.start()
        self.addCleanup(patch.stop)
        memory = mock.patch.object(workspace, "hermes_memory_snapshot", return_value=[])
        memory.start()
        self.addCleanup(memory.stop)
        workspace.save(workspace.load())
        self.other = workspace.action({"action": "add_session", "projectId": "home", "name": "Other"})["selectedSession"]

    def test_rename_preserves_identity_history_and_current_selection(self):
        conversations.add("home", "main", "user", "Remember me", "voice")
        workspace.bind_hermes_session("home", "main", "original_hermes_session")
        workspace.action({"action": "rename_session", "projectId": "home", "id": "main", "name": "My call"})
        state = workspace.load()
        chat = next(s for p in state["projects"] for s in p["sessions"] if s["id"] == "main")
        self.assertEqual(chat["name"], "My call")
        self.assertEqual(chat["hermesSessionId"], "original_hermes_session")
        self.assertEqual(state["selectedSession"], self.other)
        self.assertEqual(conversations.history("home", "main")[0]["content"], "Remember me")

    def test_delete_removes_only_target_zuzu_history_and_retains_memories(self):
        conversations.start("home", "main", "one", "hello")
        conversations.event("one", {"t": "complete"})
        conversations.add("home", self.other, "user", "Other chat", "voice")
        workspace.action({"action": "add_memory", "label": "Shared", "value": "Keep this"})
        workspace.action({"action": "delete_session", "projectId": "home", "id": "main"})
        self.assertEqual(conversations.history("home", "main"), [])
        self.assertEqual(conversations.runs("home", "main"), [])
        self.assertEqual(len(conversations.history("home", self.other)), 1)
        self.assertEqual(workspace.load()["memory"][-1]["value"], "Keep this")
        self.assertEqual(workspace.load()["selectedSession"], self.other)
        with self.assertRaises(ValueError):
            conversations.resolve({"project_id": "home", "chat_id": "main"})

    def test_active_action_cannot_be_deleted_then_can_delete_after_completion(self):
        conversations.start("home", "main", "one", "working")
        with self.assertRaisesRegex(ValueError, "finish"):
            workspace.action({"action": "delete_session", "projectId": "home", "id": "main"})
        self.assertEqual(len(conversations.history("home", "main")), 1)
        conversations.event("one", {"t": "complete"})
        workspace.action({"action": "delete_session", "projectId": "home", "id": "main"})
        self.assertEqual(conversations.history("home", "main"), [])

    def test_wrong_project_and_empty_name_are_rejected(self):
        for payload in [
            {"action": "delete_session", "projectId": "wrong", "id": "main"},
            {"action": "rename_session", "projectId": "home", "id": "main", "name": " "},
        ]:
            with self.assertRaises(ValueError):
                workspace.action(payload)
        self.assertEqual(conversations.resolve({"project_id": "home", "chat_id": "main"})[:2], ("home", "main"))

    def test_deleting_selected_chat_selects_valid_replacement(self):
        state = workspace.action({"action": "delete_session", "projectId": "home", "id": self.other})
        self.assertEqual(state["selectedSession"], "main")
