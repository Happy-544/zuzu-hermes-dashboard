import pathlib
import tempfile
import unittest

import migrate_voice_mode


class VoiceMigrationTests(unittest.TestCase):
    def test_upgrades_legacy_local_mode_when_gemini_is_configured(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / ".env"
            path.write_text("GEMINI_API_KEY=private\nJARVIS_VOICE_MODE=local\n", encoding="utf-8")
            self.assertTrue(migrate_voice_mode.migrate(path))
            self.assertIn("JARVIS_VOICE_MODE=auto", path.read_text(encoding="utf-8"))

    def test_preserves_intent_without_gemini_credentials(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / ".env"
            original = "JARVIS_VOICE_MODE=local\n"
            path.write_text(original, encoding="utf-8")
            self.assertFalse(migrate_voice_mode.migrate(path))
            self.assertEqual(path.read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
