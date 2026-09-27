import base64
import io
import os
import pathlib
import tempfile
import time
import unittest
from unittest import mock

import creative
import media
import personal
import workspace

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


def image_reply(data=PNG, mime="image/png", text=""):
    parts = [{"inlineData": {"mimeType": mime, "data": base64.b64encode(data).decode()}}]
    if text:
        parts.append({"text": text})
    return {"candidates": [{"content": {"parts": parts}}]}


class CreativeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        folder = pathlib.Path(self.tmp.name)
        self.patches = [mock.patch.object(workspace, "UPLOADS", folder / "uploads"),
                        mock.patch.object(personal, "FILE", folder / "personal.json"),
                        mock.patch.object(personal, "_send_telegram", lambda *a: None)]
        for p in self.patches:
            p.start()
        personal.OUTBOX.clear()
        self.photo = workspace.store_upload("room.png", PNG)["url"]

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def wait(self, job_id, seconds=3):
        end = time.time() + seconds
        while time.time() < end:
            job = next(j for j in creative.jobs() if j["id"] == job_id)
            if job["status"] != "working":
                return job
            time.sleep(0.02)
        self.fail("job did not finish")

    def test_resin_quote_river_table(self):
        q = creative.resin_quote({"length": 180, "width": 90, "depth": 5, "fillPercent": 35, "resinPrice": 45,
                                  "woodCost": 600, "extrasCost": 350, "hours": 20, "hourlyRate": 50, "marginPercent": 60})
        self.assertAlmostEqual(q["resinLitres"], 31.19, places=2)      # 180*90*0.35*5/1000*1.1
        self.assertAlmostEqual(q["partA"] + q["partB"], q["resinLitres"], places=1)
        self.assertEqual(q["layers"], 1)
        self.assertAlmostEqual(q["costs"]["total"], q["costs"]["materials"] + 1000, places=1)
        self.assertAlmostEqual(q["price"], q["costs"]["total"] * 1.6, places=1)

    def test_resin_quote_round_coasters_and_deep_pours(self):
        q = creative.resin_quote({"shape": "round", "length": 10, "depth": 1, "pieces": 6, "wastePercent": 0})
        self.assertAlmostEqual(q["resinLitres"], 3.14159 * 25 * 6 / 1000, places=2)
        self.assertEqual(creative.resin_quote({"depth": 12, "maxPourCm": 5})["layers"], 3)

    def test_uploads_only_and_no_path_escape(self):
        with self.assertRaises(ValueError):
            creative._upload_file("/etc/passwd")
        with self.assertRaises(ValueError):
            creative._upload_file("/uploads/../../secret.txt")
        self.assertTrue(creative._upload_file(self.photo).is_file())

    def test_edit_sends_photo_and_saves_result(self):
        with mock.patch.object(media, "_call", return_value=image_reply()) as call:
            out = creative.edit_image(self.photo, "make the wall olive green")
        parts = call.call_args[0][1]["contents"][0]["parts"]
        self.assertIn("inlineData", parts[0])
        self.assertIn("olive green", parts[-1]["text"])
        self.assertTrue(out["url"].startswith("/uploads/") and out["source"] == self.photo)

    def test_room_redesign_uses_style_and_keeps_layout(self):
        with mock.patch.object(media, "_call", return_value=image_reply()) as call:
            creative.room_redesign(self.photo, "modern majlis", "walnut, brass", 1)
        prompt = call.call_args[0][1]["contents"][0]["parts"][-1]["text"]
        self.assertIn("majlis", prompt)
        self.assertIn("walnut, brass", prompt)
        self.assertIn("same furniture layout", prompt)

    def test_model_text_without_image_is_an_error(self):
        with mock.patch.object(media, "_call", return_value={"candidates": [{"content": {"parts": [{"text": "I can't edit that"}]}}]}):
            with self.assertRaisesRegex(RuntimeError, "can't edit"):
                creative.edit_image(self.photo, "x")

    def test_listing_cleans_hashtags(self):
        reply = {"title": "Ocean table", "en": "...", "ar": "...", "hashtags": ["#resin", "epoxy"], "price": {"low": 3000, "high": 3800}}
        with mock.patch.object(creative, "_gemini_json", return_value=reply) as ask:
            out = creative.listing(self.photo, "120x60", cost=2000)
        self.assertEqual(out["hashtags"], ["resin", "epoxy"])
        self.assertIn("never price below cost x1.5", ask.call_args[0][0][-1]["text"])

    def test_music_job_saves_audio_and_announces(self):
        reply = image_reply(b"ID3fake-mp3", "audio/mpeg", "[Verse] la la")
        with mock.patch.object(media, "_call", return_value=reply) as call:
            job = self.wait(creative.make_music("oud chill")["id"])
        self.assertEqual(call.call_args[0][0], f"models/{creative.MUSIC_CLIP_MODEL}:generateContent")
        self.assertEqual(job["status"], "done")
        self.assertTrue(job["url"].endswith(".mp3"))
        self.assertIn("la la", job["lyrics"])
        self.assertEqual(personal.take_outbox()[0]["payload"]["kind"], "music")

    def test_3d_needs_key_then_downloads_models(self):
        with mock.patch.dict(os.environ, {"MESHY_API_KEY": ""}):
            with self.assertRaisesRegex(RuntimeError, "MESHY_API_KEY"):
                creative.make_3d(prompt="coaster mould")
        replies = [{"result": "t1"}, {"status": "IN_PROGRESS", "progress": 40},
                   {"status": "SUCCEEDED", "model_urls": {"glb": "https://x/m.glb", "stl": "https://x/m.stl"}}]
        opened = []

        def fake_open(url, timeout=0):
            opened.append(url)
            return io.BytesIO(b"model-bytes")
        with mock.patch.dict(os.environ, {"MESHY_API_KEY": "k"}), \
                mock.patch.object(creative, "_meshy", side_effect=replies) as meshy, \
                mock.patch.object(creative.time, "sleep", lambda s: None), \
                mock.patch.object(creative.urllib.request, "urlopen", fake_open):
            job = self.wait(creative.make_3d(image_url=self.photo)["id"])
        self.assertEqual(job["status"], "done")
        self.assertTrue(job["glb"].endswith(".glb") and job["stl"].endswith(".stl"))
        self.assertTrue(meshy.call_args_list[0][0][1]["image_url"].startswith("data:image/png;base64,"))
        self.assertEqual(opened, ["https://x/m.glb", "https://x/m.stl"])

    def test_unknown_action(self):
        with self.assertRaises(ValueError):
            creative.action({"action": "nope"})


if __name__ == "__main__":
    unittest.main()
