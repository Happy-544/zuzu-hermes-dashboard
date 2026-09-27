import pathlib
import tempfile
import unittest
from unittest import mock

import calm
import media
import server
import workspace


class CalmTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        folder = pathlib.Path(self.tmp.name)
        self.patches = [mock.patch.object(calm, "FILE", folder / "calm.json"),
                        mock.patch.object(workspace, "FILE", folder / "workspace.json")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_crisis_detection_english_and_arabic(self):
        for text in ("I want to die", "sometimes I think about suicide", "I keep hurting myself",
                     "مش عايز اعيش خلاص", "بفكر انتحر"):
            self.assertTrue(calm.crisis(text), text)
        for text in ("this deadline is killing me", "I'm tired of the client", "the cut on the wood is fine"):
            self.assertFalse(calm.crisis(text), text)

    def test_voice_whitelist(self):
        self.assertEqual(calm.pick_voice("Sulafat"), "Sulafat")
        self.assertEqual(calm.pick_voice("Fenrir"), calm.DEFAULT_VOICE)
        self.assertEqual(calm.pick_voice(None), "Achernar")

    def test_persona_has_safety_lines_and_memory(self):
        workspace.action({"action": "add_memory", "label": "Wife", "value": "Sara"})
        text = calm.persona()
        self.assertIn("800 4673", text)
        self.assertIn("16328", text)
        self.assertIn("not a licensed", text)
        self.assertIn("Wife", text)

    def test_mood_log_is_bounded_and_validated(self):
        with self.assertRaises(ValueError):
            calm.log_mood(9)
        entry = calm.log_mood(2, ["tired", "stressed"], "long site day")
        self.assertEqual(entry["mood"], 2)
        self.assertEqual(calm.state()["moods"][-1]["words"], ["tired", "stressed"])

    def test_text_chat_uses_calm_persona_and_flags_crisis(self):
        reply = {"candidates": [{"content": {"parts": [{"text": "I'm here with you."}]}}]}
        with mock.patch.object(media, "_call", return_value=reply) as call:
            out = calm.chat([{"role": "you", "text": "I don't want to live anymore"}])
        body = call.call_args[0][1]
        self.assertIn("Calm mode", body["systemInstruction"]["parts"][0]["text"])
        self.assertEqual(body["contents"][0]["role"], "user")
        self.assertTrue(out["crisis"])
        self.assertEqual(out["reply"], "I'm here with you.")

    def test_calm_voice_tools_are_declared(self):
        names = {t["name"] for t in server.CALM_TOOLS}
        self.assertEqual(names, {"add_reminder", "start_breathing", "set_calm_scene", "log_mood", "leave_calm_mode"})


if __name__ == "__main__":
    unittest.main()
