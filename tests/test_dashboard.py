import os
import pathlib
import time
import unittest
from unittest import mock

import commands
import runtime


ROOT = pathlib.Path(__file__).resolve().parents[1]


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        runtime._TOOL_CACHE = []
        runtime._TOOL_CACHE_AT = 0.0
        runtime._TOOL_REFRESHING = False

    def test_tool_discovery_does_not_block_status_rendering(self):
        def slow_tools(limit=36):
            time.sleep(0.35)
            return ["web", "browser"]

        with mock.patch.object(runtime, "_collect_hermes_tools", side_effect=slow_tools):
            started = time.perf_counter()
            self.assertEqual(runtime.hermes_tools_snapshot(), [])
            self.assertLess(time.perf_counter() - started, 0.15)
            deadline = time.time() + 1
            while not runtime.hermes_tools_snapshot() and time.time() < deadline:
                time.sleep(0.02)
            self.assertEqual(runtime.hermes_tools_snapshot(), ["web", "browser"])

    def test_windows_hermes_path_keeps_backslashes(self):
        path = r"C:\Users\Test User\hermes.exe"
        with mock.patch.dict(os.environ, {"HERMES_CMD": f'"{path}"'}):
            with mock.patch.object(runtime.os, "name", "nt"):
                self.assertEqual(runtime._hermes_base(), [path])
            with mock.patch.object(commands.os, "name", "nt"):
                self.assertEqual(commands._hermes_command("tools", "list"), [path, "tools", "list"])


class InterfaceTests(unittest.TestCase):
    def test_primary_views_and_mobile_navigation_exist(self):
        html = (ROOT / "ui" / "index.html").read_text(encoding="utf-8")
        for name in ("chat", "tools", "missions", "activity"):
            self.assertIn(f'data-view-panel="{name}"', html)
            self.assertGreaterEqual(html.count(f'data-view="{name}"'), 2)
        self.assertIn('aria-label="Message JARVIS"', html)

    def test_mobile_layout_has_no_fixed_desktop_width(self):
        css = (ROOT / "ui" / "styles.css").read_text(encoding="utf-8")
        self.assertIn("@media(max-width:700px)", css)
        self.assertIn(".app-shell{display:block", css)
        self.assertIn("grid-template-columns:repeat(4,1fr)", css)
        self.assertIn("overflow-x:hidden", css)


if __name__ == "__main__":
    unittest.main()
