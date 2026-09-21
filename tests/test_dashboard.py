import os
import pathlib
import tempfile
import time
import unittest
from unittest import mock

import commands
import runtime
import server
import workspace


ROOT = pathlib.Path(__file__).resolve().parents[1]


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        runtime._TOOL_CACHE = []
        runtime._TOOL_CACHE_AT = 0.0
        runtime._TOOL_REFRESHING = False
        runtime._HERMES_HEALTH = {"connected": False, "detail": "checking", "checked_at": 0.0}
        runtime._HERMES_HEALTH_REFRESHING = False

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
            with mock.patch.object(runtime, "PROFILE", "Ali"), mock.patch.object(runtime, "PROVIDER", "gemini"):
                command = runtime.build_command("Inspect the desktop", system="Be concise")
        self.assertEqual(command[:4], ["hermes", "chat", "-Q", "-q"])
        self.assertNotIn("--profile", command)
        self.assertIn("--model", command)
        self.assertEqual(command[command.index("--model") + 1], "gemini-2.5-flash")
        self.assertEqual(command[command.index("--provider") + 1], "google")
        self.assertIn("--source", command)

    def test_all_conversation_runs_use_hermes(self):
        events = [{"t": "delta", "text": "one agent"}]
        with mock.patch.object(runtime, "hermes_health_snapshot", return_value={"connected": True}), \
             mock.patch.object(runtime, "run_hermes", return_value=iter(events)) as hermes, \
             mock.patch.object(runtime, "run_gemini") as direct:
            self.assertEqual(list(runtime.run("hello")), events)
        hermes.assert_called_once()
        direct.assert_not_called()

    def test_hermes_health_is_cached(self):
        with mock.patch.object(runtime, "_can_launch_hermes", return_value=(True, "Hermes 0.21")) as probe:
            first = runtime.hermes_health_snapshot(wait=True)
            second = runtime.hermes_health_snapshot()
        self.assertTrue(first["connected"])
        self.assertFalse(first["pending"])
        self.assertTrue(second["connected"])
        probe.assert_called_once()

    def test_gemini_fallback_does_not_switch_to_36(self):
        self.assertEqual(runtime.GEMINI_MODEL, "gemini-2.5-flash")
        self.assertEqual(runtime.GEMINI_FALLBACK_MODEL, "gemini-2.5-flash")

    def test_public_tunnel_hosts_are_allowed(self):
        self.assertTrue(server._host_allowed("locate-weekends-think-rec.trycloudflare.com"))
        self.assertTrue(server._host_allowed("polyester-garden-twiddle.ngrok-free.dev"))
        self.assertTrue(server._origin_allowed("https://locate-weekends-think-rec.trycloudflare.com"))
        self.assertTrue(server._origin_allowed("https://polyester-garden-twiddle.ngrok-free.dev"))
        self.assertFalse(server._host_allowed("evil.example.com"))

    def test_laptop_screen_and_upload_display_endpoints_exist(self):
        server_source = (ROOT / "server.py").read_text(encoding="utf-8")
        workspace_source = (ROOT / "workspace.py").read_text(encoding="utf-8")
        self.assertIn("/api/laptop-screen", server_source)
        self.assertIn("capture_laptop_screen_jpeg", server_source)
        self.assertIn('p.startswith("/uploads/")', server_source)
        self.assertIn('"url": f"/uploads/{target.name}"', workspace_source)

    def test_self_modification_and_connector_commands_exist(self):
        commands_source = (ROOT / "commands.py").read_text(encoding="utf-8")
        server_source = (ROOT / "server.py").read_text(encoding="utf-8")
        self.assertIn("music|playlist|remind|reminder|followup", commands_source)
        self.assertIn("Zuzu system awareness", server_source)
        self.assertIn("_client_context_prompt", server_source)
        self.assertIn("Do not answer 'I cannot modify myself'", server_source)


class InterfaceTests(unittest.TestCase):
    def test_primary_views_and_mobile_navigation_exist(self):
        html = (ROOT / "ui" / "index.html").read_text(encoding="utf-8")
        for name in ("chat", "projects", "models", "tools", "memory", "studio", "missions", "activity", "settings"):
            self.assertIn(f'data-view-panel="{name}"', html)
            self.assertGreaterEqual(html.count(f'data-view="{name}"'), 1)
        self.assertIn('aria-label="Message Zuzu"', html)

    def test_mobile_layout_has_no_fixed_desktop_width(self):
        css = (ROOT / "ui" / "styles.css").read_text(encoding="utf-8")
        self.assertIn("@media(max-width:700px)", css)
        self.assertIn(".app-shell{display:block", css)
        self.assertIn("grid-template-columns:repeat(5,1fr)", css)
        self.assertIn("overflow-x:hidden", css)

    def test_workspace_features_are_wired(self):
        html = (ROOT / "ui" / "index.html").read_text(encoding="utf-8")
        js = (ROOT / "ui" / "app.js").read_text(encoding="utf-8")
        for element in ("providerSelect", "personaText", "memoryCanvas", "fileUpload", "imagePrompt", "videoPrompt", "computerControl", "mobileControl", "visualPreview", "dockCamera", "dockScreen", "flipCamera", "coreVisionBox", "chatFileUpload", "chatAttachments", "visualImage", "visualFrame", "dockLaptop", "dockBrowser", "skillSearch", "catalogueGrid", "brainDetail", "brainPrev", "brainNext"):
            self.assertIn(f'id="{element}"', html)
        self.assertIn("/api/workspace", js)
        self.assertIn("/api/upload", js)
        self.assertIn("/api/live-token", js)
        self.assertIn("getDisplayMedia", js)
        self.assertIn("getUserMedia", js)
        self.assertIn("captureVisualFrame", js)
        self.assertIn("attachVisualContext", js)
        self.assertIn("attachUploadedContext", js)
        self.assertIn("uploadFiles", js)
        self.assertIn("pendingLiveAttachmentParts", js)
        self.assertIn("autoRemember", js)
        self.assertIn("openBrowserPreview", js)
        self.assertIn("normalizeBrowserTarget", js)
        self.assertIn("googleSearchUrl", js)
        self.assertIn("youtubeSearchUrl", js)
        self.assertIn("showExternalLauncher", js)
        self.assertIn("openExternalUrl", js)
        self.assertIn("resolveAndShowYoutube", js)
        self.assertIn("resolveAndShowBrowser", js)
        self.assertIn("/api/youtube-search", (ROOT / "server.py").read_text(encoding="utf-8"))
        self.assertIn("/api/web-search", (ROOT / "server.py").read_text(encoding="utf-8"))
        self.assertIn("external-launcher", (ROOT / "ui" / "styles.css").read_text(encoding="utf-8"))
        self.assertIn("allow-popups", html)
        self.assertIn("clientDeviceContext", js)
        self.assertIn("client_context", js)
        self.assertIn("requestLaptopScreen", js)
        self.assertIn("startLaptopLive", js)
        self.assertIn("showLaptopSnapshot", js)
        self.assertIn("showMediaFromAnswer", js)
        self.assertIn("/api/laptop-screen", js)
        self.assertIn("CAPABILITY_CATALOG", js)
        self.assertIn("renderCapabilityCatalogue", js)
        self.assertIn("selectBrainNode", js)
        self.assertIn("Self modification protocol", js)
        self.assertIn("Spotify / Apple Music", js)
        self.assertIn("sendLiveVisualFrame", js)
        self.assertIn("payload instanceof Blob", js)
        self.assertIn("await payload.text()", js)

    def test_live_voice_supports_barge_in_and_saved_agent_context(self):
        js = (ROOT / "ui" / "app.js").read_text(encoding="utf-8")
        server = (ROOT / "server.py").read_text(encoding="utf-8")
        self.assertNotIn("!liveReady || liveSpeaking ||", js)
        self.assertIn("barge-in detected", js)
        self.assertIn("stopLivePlayback()", js)
        self.assertIn("auth.system ||", js)
        self.assertIn('auth["system"] = persona(client_extra)', server)
        self.assertIn("Zuzu-Hermes memory contract", server)
        self.assertIn("Zuzu durable memory brain", (ROOT / "workspace.py").read_text(encoding="utf-8"))

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
        self.assertIn('id="top-hermes"', html)
        self.assertIn('id="sy-hermes"', html)
        self.assertIn("app.js?v=29", html)
        self.assertIn("jarvis-shell-v29", worker)
        self.assertIn("fetch(event.request).then", worker)

    def test_job_polling_is_visibility_aware_and_quota_friendly(self):
        js = (ROOT / "ui" / "app.js").read_text(encoding="utf-8")
        self.assertIn("const JOB_POLL_IDLE_MS = 300000", js)
        self.assertIn("document.visibilityState === 'hidden'", js)
        self.assertIn("jobPollInFlight", js)
        self.assertNotIn("setInterval(pollJobs, 4000)", js)

    def test_active_operation_and_busy_command_are_wired(self):
        html = (ROOT / "ui" / "index.html").read_text(encoding="utf-8")
        js = (ROOT / "ui" / "app.js").read_text(encoding="utf-8")
        commands_source = (ROOT / "commands.py").read_text(encoding="utf-8")
        runtime_source = (ROOT / "runtime.py").read_text(encoding="utf-8")
        server_source = (ROOT / "server.py").read_text(encoding="utf-8")
        self.assertIn('data-cmd="/busy"', html)
        self.assertIn("describeActiveOperation", js)
        self.assertIn("active_operation", js)
        self.assertIn("busy|now", commands_source)
        self.assertIn("/busy or /now", commands_source)
        self.assertIn("active_operation_snapshot", runtime_source)
        self.assertIn("describe_active_operation", runtime_source)
        self.assertIn("active_operation", server_source)


    def test_zuzu_brand_and_face_visualizer_are_wired(self):
        html = (ROOT / "ui" / "index.html").read_text(encoding="utf-8")
        css = (ROOT / "ui" / "styles.css").read_text(encoding="utf-8")
        manifest = (ROOT / "ui" / "manifest.webmanifest").read_text(encoding="utf-8")
        persona = (ROOT / "persona.md").read_text(encoding="utf-8")
        self.assertIn("<title>Zuzu · Hermes</title>", html)
        self.assertIn('class="zuzu-core"', html)
        self.assertIn("signal-ellipses", html)
        self.assertIn('class="core-output"', html)
        self.assertIn('class="core-voice-btn"', html)
        self.assertIn('id="userText"', html)
        self.assertIn('id="brainDetail"', html)
        self.assertIn('id="catalogueGrid"', html)
        self.assertIn('Capability catalogue', html)
        self.assertIn('data-cmd="/connect"', html)
        self.assertIn('data-cmd="/music"', html)
        self.assertIn('data-cmd="/playlist"', html)
        self.assertIn('data-cmd="/remind"', html)
        self.assertNotIn('قولّي محتاج', html)
        self.assertNotIn('تفضّل، أنا معاك', html)
        self.assertNotIn('ZUZU CORE', html)
        self.assertIn("mouthTalk", css)
        self.assertIn(".listening .core-arc", css)
        self.assertIn("body:not(.speaking) .signal-ellipses", css)
        self.assertNotIn("Direct channel", html)
        self.assertNotIn("Zuzu response", html)
        self.assertIn('"short_name": "Zuzu"', manifest)
        self.assertIn("You are Zuzu", persona)


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
