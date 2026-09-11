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

    def test_windows_translates_wsl_hermes_path(self):
        with mock.patch.dict(os.environ, {"HERMES_CMD": "/mnt/c/Users/Test/hermes.exe"}):
            with mock.patch.object(runtime.os, "name", "nt"):
                self.assertEqual(runtime._hermes_base(), [r"C:\Users\Test\hermes.exe"])
                self.assertEqual(runtime._host_path("/mnt/d/Mark/config.json"), r"D:\Mark\config.json")

    def test_hermes_chat_uses_current_cli_flags(self):
        with mock.patch.object(runtime, "_hermes_base", return_value=["hermes"]):
            with mock.patch.object(runtime, "PROFILE", "Ali"):
                command = runtime.build_command("Inspect the desktop", system="Be concise")
        self.assertEqual(command[:4], ["hermes", "chat", "-Q", "-q"])
        self.assertNotIn("--profile", command)
        self.assertNotIn("--model", command)
        self.assertIn("--source", command)


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
        self.assertIn("payload instanceof Blob", js)
        self.assertIn("await payload.text()", js)

    def test_live_voice_supports_barge_in_and_saved_agent_context(self):
        js = (ROOT / "ui" / "app.js").read_text(encoding="utf-8")
        server = (ROOT / "server.py").read_text(encoding="utf-8")
        self.assertNotIn("!liveReady || liveSpeaking ||", js)
        self.assertIn("barge-in detected", js)
        self.assertIn("stopLivePlayback()", js)
        self.assertIn("auth.system ||", js)
        self.assertIn('auth["system"] = persona()', server)

    def test_installable_mobile_app_and_shortcuts_control_exist(self):
        html = (ROOT / "ui" / "index.html").read_text(encoding="utf-8")
        js = (ROOT / "ui" / "app.js").read_text(encoding="utf-8")
        self.assertIn('rel="manifest"', html)
        self.assertIn('id="runShortcut"', html)
        self.assertIn("shortcuts://run-shortcut", js)
        self.assertIn("visibilitychange", js)
        self.assertTrue((ROOT / "ui" / "service-worker.js").is_file())
        self.assertTrue((ROOT / "ui" / "manifest.webmanifest").is_file())

    def test_tool_cards_wait_for_details_and_assets_refresh(self):
        html = (ROOT / "ui" / "index.html").read_text(encoding="utf-8")
        js = (ROOT / "ui" / "app.js").read_text(encoding="utf-8")
        worker = (ROOT / "ui" / "service-worker.js").read_text(encoding="utf-8")
        self.assertIn('data-cmd="/pc"', html)
        self.assertIn("'/pc'", js)
        self.assertIn("is waiting for task details", js)
        self.assertIn("app.js?v=8", html)
        self.assertIn("jarvis-shell-v8", worker)
        self.assertIn("fetch(event.request).then", worker)


class WorkspaceTests(unittest.TestCase):
    def test_computer_actions_route_to_hermes_only_when_enabled(self):
        with mock.patch.object(workspace, "load", return_value={"settings": {"computerControl": True}}):
            self.assertTrue(workspace.computer_control_request("Open Chrome on my computer"))
            self.assertTrue(workspace.computer_control_request("Open Notepad"))
            self.assertTrue(workspace.computer_control_request("افتح كروم على الكمبيوتر"))
            self.assertFalse(workspace.computer_control_request("Tell me a joke"))
        with mock.patch.object(workspace, "load", return_value={"settings": {"computerControl": False}}):
            self.assertFalse(workspace.computer_control_request("Open Chrome on my computer"))

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
