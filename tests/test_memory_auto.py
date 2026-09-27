import pathlib
import tempfile
import unittest
from unittest import mock

import memory_auto
import personal
import workspace


class AutoMemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        folder = pathlib.Path(self.tmp.name)
        self.patches = [mock.patch.object(personal, "FILE", folder / "personal.json"),
                        mock.patch.object(workspace, "FILE", folder / "workspace.json"),
                        mock.patch.object(personal, "_send_telegram", lambda *a: None)]
        for p in self.patches:
            p.start()
        personal.OUTBOX.clear()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def memories(self):
        return workspace.load()["memory"]

    def test_explicit_remember_without_gemini(self):
        with mock.patch.object(memory_auto, "ai_ops", return_value=None):
            changes = memory_auto.observe("Remember that my car is a white Land Cruiser")
        self.assertEqual(changes, ["Saved: My car"])
        self.assertEqual(self.memories()[-1]["value"], "my car is a white Land Cruiser")
        self.assertTrue(self.memories()[-1]["auto"])
        self.assertEqual(personal.take_outbox()[0]["kind"], "memory")

    def test_fact_patterns_english_and_arabic(self):
        with mock.patch.object(memory_auto, "ai_ops", return_value=None):
            memory_auto.observe("By the way my wife's name is Sara and I live in Dubai Marina")
            memory_auto.observe("انا بحب القهوة التركي")
        labels = {m["label"]: m["value"] for m in self.memories()}
        self.assertEqual(labels["Wife"], "My wife is Sara and I live in Dubai Marina.")
        self.assertIn("Home city", labels)
        self.assertEqual(labels["Likes"], "بحب القهوة التركي")

    def test_questions_small_talk_and_secrets_are_not_saved(self):
        with mock.patch.object(memory_auto, "ai_ops", return_value=None):
            self.assertEqual(memory_auto.observe("Do you remember my wife's name?"), [])
            self.assertEqual(memory_auto.observe("what's the weather"), [])
            self.assertEqual(memory_auto.observe("remember my password is Hunter22"), [])
            self.assertEqual(memory_auto.observe("remember my card 4111 1111 1111 1111"), [])
        with mock.patch.object(memory_auto, "ai_ops", return_value=[{"op": "add", "label": "Bank", "value": "IBAN AE070331234567890123456"}]):
            self.assertEqual(memory_auto.observe("my iban is AE07…"), [])
        self.assertEqual(self.memories(), [])

    def test_ai_update_keeps_history_and_merges_tags(self):
        workspace.action({"action": "add_memory", "label": "Coffee", "value": "Flat white every morning", "tags": "habits"})
        mid = self.memories()[-1]["id"]
        ops = [{"op": "update", "id": mid, "label": "Coffee", "value": "Espresso now, no sugar", "tags": ["health"]}]
        with mock.patch.object(memory_auto, "ai_ops", return_value=ops):
            self.assertEqual(memory_auto.observe("I switched to espresso, no sugar", "Noted!"), ["Updated: Coffee"])
        memory = self.memories()[-1]
        self.assertEqual(memory["value"], "Espresso now, no sugar")
        self.assertEqual(memory["history"][0]["value"], "Flat white every morning")
        self.assertEqual(memory["tags"], ["habits", "health"])

    def test_same_title_becomes_update_and_duplicates_are_skipped(self):
        add = [{"op": "add", "label": "Gym", "value": "Mon and Wed", "tags": ["health"]}]
        with mock.patch.object(memory_auto, "ai_ops", return_value=add):
            memory_auto.observe("I go to the gym Monday and Wednesday")
            self.assertEqual(memory_auto.observe("gym is Monday and Wednesday"), [])      # same fact again
        with mock.patch.object(memory_auto, "ai_ops", return_value=[{"op": "add", "label": "gym", "value": "Mon, Wed and Fri"}]):
            self.assertEqual(memory_auto.observe("I added Friday to my gym days"), ["Updated: gym"])
        self.assertEqual(len(self.memories()), 1)

    def test_forget_removes_matching_memory(self):
        workspace.action({"action": "add_memory", "label": "Old car", "value": "Nissan Patrol 2015"})
        with mock.patch.object(memory_auto, "ai_ops") as ai:
            self.assertEqual(memory_auto.observe("forget the Nissan Patrol"), ["Forgot: Old car"])
            ai.assert_not_called()
        self.assertEqual(self.memories(), [])

    def test_disabled_and_commands_do_nothing(self):
        personal.save_settings({"autoMemory": False})
        with mock.patch.object(memory_auto, "ai_ops") as ai:
            self.assertEqual(memory_auto.observe("remember my son is Omar"), [])
            ai.assert_not_called()
        personal.save_settings({"autoMemory": True})
        self.assertEqual(memory_auto.observe("/music amr diab"), [])

    def test_ai_failure_falls_back_to_patterns(self):
        with mock.patch.object(memory_auto, "_gemini", side_effect=OSError("offline")):
            self.assertEqual(memory_auto.observe("call me Abu Omar"), ["Saved: Preferred name"])

    def test_context_prefers_relevant_memories(self):
        for i in range(40):
            workspace.action({"action": "add_memory", "label": f"Note {i}", "value": "x" * 200})
        workspace.action({"action": "add_memory", "label": "Wife", "value": "Sara, birthday 12 March"})
        for i in range(40, 60):
            workspace.action({"action": "add_memory", "label": f"Note {i}", "value": "x" * 200})
        self.assertIn("Sara, birthday 12 March", workspace.agent_context(limit=1400, query="when is Sara's birthday?"))
        self.assertNotIn("Sara, birthday", workspace.agent_context(limit=1400, query="weather"))


if __name__ == "__main__":
    unittest.main()
