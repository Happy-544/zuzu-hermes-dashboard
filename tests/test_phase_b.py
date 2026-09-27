import base64
import json
import pathlib
import tempfile
import unittest
from unittest import mock

import books
import markets
import media
import workspace


def chart(price, prev, closes):
    return {"chart": {"result": [{"meta": {"regularMarketPrice": price, "chartPreviousClose": prev, "currency": "USD"},
                                  "indicators": {"quote": [{"close": closes}]}}]}}


class MarketsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patch = mock.patch.object(markets, "FILE", pathlib.Path(self.tmp.name) / "markets.json")
        self.patch.start()
        markets._CACHE.update(at=0.0, quotes={})

    def tearDown(self):
        self.patch.stop(); self.tmp.cleanup()

    def test_quote_computes_change_and_trend(self):
        with mock.patch.object(markets, "_chart", return_value=chart(110, 100, [100, 104, 108, 110])):
            q = markets.quote("GC=F")
        self.assertEqual((q["name"], q["price"], q["change"], q["trend5d"]), ("Gold", 110, 10.0, 10.0))

    def test_top5_ranks_biggest_movers(self):
        moves = {sym: chart(100 + i, 100, [100, 100 + i]) for i, sym in enumerate(markets.UNIVERSE)}
        with mock.patch.object(markets, "_chart", side_effect=lambda s: moves[s]):
            top = markets.state()["top5"]
        self.assertEqual(len(top), 5)
        self.assertEqual(top[0]["symbol"], list(markets.UNIVERSE)[-1])

    def test_price_alert_fires_once(self):
        with mock.patch.object(markets, "_chart", return_value=chart(2500, 2400, [2400, 2500])):
            markets.action({"action": "add_alert", "symbol": "GC=F", "direction": "above", "price": "2450"})
            first = markets.check_alerts()
            markets._CACHE.update(at=0.0, quotes={})
            second = markets.check_alerts()
        self.assertEqual([a["name"] for a in first], ["Gold"])
        self.assertEqual(second, [])


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.patches = [mock.patch.object(books, "CACHE", root / "books"), mock.patch.object(books, "STATE", root / "books.json")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_open_book_strips_licence_paginates_and_remembers_page(self):
        meta = {"id": 1342, "title": "Pride and Prejudice", "authors": [{"name": "Austen, Jane"}],
                "formats": {"text/plain; charset=utf-8": "https://x/1342.txt"}, "download_count": 9}
        body = ("Licence blah\n*** START OF THE PROJECT GUTENBERG EBOOK PRIDE ***\n"
                + "\n\n".join(f"Paragraph {i} " + "word " * 120 for i in range(30))
                + "\n*** END OF THE PROJECT GUTENBERG EBOOK ***\nMore licence")
        with mock.patch.object(books, "_get", side_effect=lambda url, **k: json.dumps(meta).encode() if "gutendex" in url else body.encode()):
            first = books.page(1342)
            books.page(1342, 2)
        self.assertNotIn("Licence", first["text"])
        self.assertTrue(first["text"].startswith("Paragraph 0"))
        self.assertGreater(first["pages"], 3)
        self.assertEqual(books.shelf()[0]["page"], 2)

    def test_search_maps_results(self):
        payload = {"results": [{"id": 1, "title": "Dracula", "authors": [{"name": "Stoker, Bram"}],
                                "formats": {"text/plain; charset=us-ascii": "u", "image/jpeg": "c"}, "download_count": 5}]}
        with mock.patch.object(books, "_get", return_value=json.dumps(payload).encode()):
            result = books.search("dracula")
        self.assertEqual(result[0]["title"], "Dracula")
        self.assertTrue(result[0]["readable"])


class MediaTests(unittest.TestCase):
    def test_create_image_saves_upload(self):
        png = base64.b64encode(b"\x89PNG fake").decode()
        response = {"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": png}}]}}]}
        with tempfile.TemporaryDirectory() as folder, \
             mock.patch.object(workspace, "UPLOADS", pathlib.Path(folder)), \
             mock.patch.object(media, "_call", return_value=response):
            result = media.create_image("a resin river table")
            self.assertTrue((pathlib.Path(folder) / pathlib.Path(result["path"]).name).exists())
        self.assertIn("resin_river_table", result["name"])


if __name__ == "__main__":
    unittest.main()
