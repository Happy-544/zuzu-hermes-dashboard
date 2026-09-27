import datetime
import json
import pathlib
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

import auth
import personal
import server
import workspace

NOW = datetime.datetime(2026, 9, 26, 14, 0)   # a Saturday


class PersonalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = mock.patch.object(personal, "FILE", pathlib.Path(self.tmp.name) / "personal.json")
        self.file.start()
        personal.OUTBOX.clear()

    def tearDown(self):
        self.file.stop()
        self.tmp.cleanup()

    def test_natural_language_times(self):
        cases = {
            "call mom in 20 minutes": NOW + datetime.timedelta(minutes=20),
            "tomorrow at 9am gym": datetime.datetime(2026, 9, 27, 9, 0),
            "call Ahmed on monday at 10:30": datetime.datetime(2026, 9, 28, 10, 30),
            "ذكرني بكرة الساعة 8 اصحى": datetime.datetime(2026, 9, 27, 8, 0),
            "فكرني بعد ساعتين": NOW + datetime.timedelta(hours=2),
            "الخميس الساعة 7 م عشا": datetime.datetime(2026, 10, 1, 19, 0),
        }
        for text, expected in cases.items():
            self.assertEqual(personal.parse_when(text, NOW), expected, text)
        self.assertIsNone(personal.parse_when("buy resin", NOW))

    def test_due_reminders_announce_once_and_repeats_reschedule(self):
        personal.add_reminder("water plants", "2026-09-26T13:00", "daily", now=NOW)
        personal.add_reminder("call Sara", "2026-09-26T13:30", now=NOW)
        personal.add_reminder("later thing", "2026-09-26T18:00", now=NOW)
        with mock.patch.object(personal, "_send_telegram"):
            personal.tick(NOW)
            personal.tick(NOW)                       # second pass must not repeat
        texts = [item["text"] for item in personal.take_outbox()]
        self.assertEqual(sorted(texts), ["Reminder: call Sara", "Reminder: water plants"])
        plants = next(r for r in personal.load()["reminders"] if r["text"] == "water plants")
        self.assertEqual(plants["due"], "2026-09-27T13:00")

    def test_brief_survives_offline_sources_and_lists_reminders(self):
        personal.add_reminder("dentist", "2026-09-26T16:00", now=NOW)
        with mock.patch.object(personal, "_get", side_effect=OSError("offline")):
            brief = personal.build_brief("morning", NOW)
        self.assertEqual(brief["reminders"], [{"time": "16:00", "text": "dentist"}])
        self.assertIn("weather unavailable", " ".join(brief["errors"]))
        self.assertIn("dentist", brief["speech"])

    def test_brief_uses_weather_and_news(self):
        weather = json.dumps({"current": {"temperature_2m": 37.4, "weather_code": 0}, "daily": {
            "temperature_2m_max": [41], "temperature_2m_min": [30], "precipitation_probability_max": [0]}}).encode()
        rss = b"<rss><channel><item><title>Big story - Gulf News</title><source>Gulf News</source><link>https://x</link></item></channel></rss>"
        with mock.patch.object(personal, "_get", side_effect=lambda url, timeout=8: weather if "open-meteo" in url else rss):
            brief = personal.build_brief("morning", NOW)
        self.assertEqual(brief["weather"]["summary"], "clear sky")
        self.assertEqual(brief["news"][0], {"title": "Big story", "source": "Gulf News", "url": "https://x"})
        self.assertIn("37 degrees", brief["speech"])

    def test_calendar_events_for_today(self):
        ics = ("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260926T100000\r\nSUMMARY:Site visit\r\nEND:VEVENT\r\n"
               "BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260926\r\nSUMMARY:Mom's birthday\r\nEND:VEVENT\r\n"
               "BEGIN:VEVENT\r\nDTSTART:20260927T100000\r\nSUMMARY:Tomorrow\r\nEND:VEVENT\r\nEND:VCALENDAR")
        events = personal.calendar_events(ics, NOW.date())
        self.assertEqual(events, [{"time": "All day", "title": "Mom's birthday"}, {"time": "10:00", "title": "Site visit"}])

    def test_scheduled_brief_is_sent_once_per_day(self):
        personal.save_settings({"briefMorning": "08:00", "briefEvening": "20:00"})
        with mock.patch.object(personal, "build_brief", return_value={"speech": "hello"}) as build, \
             mock.patch.object(personal, "_send_telegram"):
            personal.tick(datetime.datetime(2026, 9, 26, 8, 1))
            personal.tick(datetime.datetime(2026, 9, 26, 8, 5))
            personal.tick(datetime.datetime(2026, 9, 26, 23, 30))   # evening brief too late -> skipped
        self.assertEqual(build.call_count, 1)

    def test_api_adds_reminder(self):
        with mock.patch.object(auth, "FILE", pathlib.Path(self.tmp.name) / "auth.json"), \
             mock.patch.object(workspace, "FILE", pathlib.Path(self.tmp.name) / "workspace.json"):
            auth.SESSIONS.clear(); auth.ATTEMPTS.clear()
            http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            old_port, server.PORT = server.PORT, http.server_address[1]
            threading.Thread(target=http.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{server.PORT}"

            def post(path, body, headers=None):
                return urllib.request.urlopen(urllib.request.Request(base + path, data=json.dumps(body).encode(),
                    method="POST", headers={"Origin": base, "Content-Type": "application/json", **(headers or {})}))
            try:
                with post("/api/enroll", {"password": "long owner password"}) as r:
                    cookie = r.headers["Set-Cookie"].split(";", 1)[0]; csrf = json.load(r)["csrf"]
                with post("/api/personal", {"action": "add_reminder", "text": "remind me to call mom tomorrow 6pm"},
                          {"Cookie": cookie, "X-Zuzu-CSRF": csrf}) as r:
                    data = json.load(r)
            finally:
                http.shutdown(); server.PORT = old_port
        self.assertEqual(data["item"]["text"], "call mom")
        self.assertTrue(data["item"]["due"].endswith("18:00"))


class VoiceToolTests(unittest.TestCase):
    def test_live_voice_declares_local_tools(self):
        names = {tool["name"] for tool in server.LOCAL_VOICE_TOOLS}
        self.assertEqual(names, {"add_reminder", "get_daily_brief", "play_music", "play_video", "switch_model", "sleep_mode",
                                 "get_markets", "set_price_alert", "create_image", "create_video", "find_books",
                                 "point_at", "clear_screen_drawing", "find_new_skills", "install_skill",
                                 "make_music", "resin_quote", "open_creative_studio"})


if __name__ == "__main__":
    unittest.main()
