import os
import pathlib
import tempfile
import time
import unittest
from unittest import mock

import commands
import runtime
import workspace


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
        for name in ("chat", "projects", "models", "tools", "memory", "studio", "missions", "activity", "settings"):
            self.assertIn(f'data-view-panel="{name}"', html)
            self.assertGreaterEqual(html.count(f'data-view="{name}"'), 1)
        self.assertIn('aria-label="Message JARVIS"', html)

    def test_mobile_layout_has_no_fixed_desktop_width(self):
        css = (ROOT / "ui" / "styles.css").read_text(encoding="utf-8")
        self.assertIn("@media(max-width:700px)", css)
        self.assertIn(".app-shell{display:block", css)
        self.assertIn("grid-template-columns:repeat(5,1fr)", css)
        self.assertIn("overflow-x:hidden", css)

    def test_workspace_features_are_wired(self):
        html = (ROOT / "ui" / "index.html").read_text(encoding="utf-8")
        js = (ROOT / "ui" / "app.js").read_text(encoding="utf-8")
        for element in ("providerSelect", "personaText", "memoryCanvas", "fileUpload", "imagePrompt", "videoPrompt", "computerControl", "mobileControl"):
            self.assertIn(f'id="{element}"', html)
        self.assertIn("/api/workspace", js)
        self.assertIn("/api/upload", js)
        self.assertIn("/api/live-token", js)


class WorkspaceTests(unittest.TestCase):
    def test_projects_sessions_skills_and_memory_round_trip(self):
        with tempfile.TemporaryDirectory() as folder:
            old_file = workspace.FILE
            try:
                workspace.FILE = pathlib.Path(folder) / "workspace.json"
                state = workspace.action({"action": "add_project", "name": "Demo", "folder": folder})
                project = state["projects"][-1]
                state = workspace.action({"action": "add_session", "projectId": project["id"], "name": "Chat"})
                self.assertEqual(state["projects"][-1]["sessions"][-1]["name"], "Chat")
                state = workspace.action({"action": "add_skill", "name": "Research", "instructions": "Verify sources"})
                self.assertEqual(state["skills"][-1]["name"], "Research")
                state = workspace.action({"action": "add_memory", "label": "Preference", "value": "Be concise"})
                self.assertEqual(state["memory"][-1]["value"], "Be concise")
            finally:
                workspace.FILE = old_file


if __name__ == "__main__":
    unittest.main()
