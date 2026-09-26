import io
import json
import pathlib
import tempfile
import unittest
from unittest import mock

import overlay
import personal
import screen_pointer
import skills_scout


class OverlayTests(unittest.TestCase):
    def test_normalised_points_map_to_pixels_and_clamp(self):
        self.assertEqual(overlay.to_pixels(0.5, 0.25, (0, 0, 1920, 1080)), (960, 270))
        self.assertEqual(overlay.to_pixels(1.4, -1, (0, 0, 1920, 1080)), (1920, 0))

    def test_arrow_starts_from_the_emptier_side(self):
        sx, sy = overlay.arrow_from(0.9, 0.1)
        self.assertLess(sx, 0.9)
        self.assertGreater(sy, 0.1)

    def test_commands_are_validated(self):
        cmd = screen_pointer.clean_command({"type": "path", "points": [[0.1, 0.2], [2, -1]], "ttl": 500})
        self.assertEqual(cmd, {"type": "path", "points": [[0.1, 0.2], [1.0, 0.0]], "ttl": 60.0})
        with self.assertRaises(ValueError):
            screen_pointer.clean_command({"type": "explode"})

    def test_locate_reads_gemini_box(self):
        reply = {"candidates": [{"content": {"parts": [{"text": json.dumps(
            {"found": True, "box_2d": [100, 200, 300, 400], "label": "Save button"})}]}}]}

        class Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False
        with mock.patch.object(screen_pointer.runtime, "gemini_api_key", return_value="k"), \
             mock.patch.object(screen_pointer.urllib.request, "urlopen", return_value=Resp(json.dumps(reply).encode())):
            spot = screen_pointer.locate(b"jpeg", "the save button")
        self.assertAlmostEqual(spot["x"], 0.3)
        self.assertAlmostEqual(spot["y"], 0.2)
        self.assertEqual(spot["label"], "Save button")


class SkillScoutTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patch = mock.patch.object(personal, "FILE", pathlib.Path(self.tmp.name) / "personal.json")
        self.patch.start()

    def tearDown(self):
        self.patch.stop(); self.tmp.cleanup()

    def test_scout_proposes_without_installing_and_skips_duplicates(self):
        results = [{"kind": "skill", "name": "Resin calc", "identifier": "hub/resin-calc", "description": "Epoxy volumes"}]
        with mock.patch.object(skills_scout.catalog, "install") as install:
            first = skills_scout.scout("resin", search=lambda q, s: results)
            second = skills_scout.scout("resin", search=lambda q, s: results)
            install.assert_not_called()
        self.assertEqual([p["name"] for p in first], ["Resin calc"])
        self.assertEqual(second, [])

    def test_approve_installs_and_dismiss_does_not(self):
        results = [{"kind": "skill", "name": "A", "identifier": "hub/a"}, {"kind": "skill", "name": "B", "identifier": "hub/b"}]
        found = skills_scout.scout("x", search=lambda q, s: results)
        with mock.patch.object(skills_scout.catalog, "install", return_value={"detail": "ok"}) as install:
            skills_scout.decide(found[0]["id"], True)
            skills_scout.decide(found[1]["id"], False)
        install.assert_called_once_with("hub/a", "skill")
        self.assertEqual([p["status"] for p in skills_scout.proposals()], ["installed", "dismissed"])


if __name__ == "__main__":
    unittest.main()
