import copy
import io
import os
import pathlib
import tempfile
import unittest
from unittest import mock

import commands
import hermes_api
import server
import workspace


class AuditRegressionTests(unittest.TestCase):
    def test_pc_and_computer_commands_are_routed_to_hermes(self):
        for text in ("/pc open notepad", "/computer open notepad"):
            result = commands.handle(text)
            self.assertIsNotNone(result, text)
            self.assertIn("open notepad", result["message"])

    def test_sse_error_event_reports_once_without_crashing(self):
        stream = io.BytesIO(b'event: error\ndata: {"message": "boom"}\n\n')
        with mock.patch.dict(os.environ, {"HERMES_API_KEY": "test"}), \
             mock.patch.object(hermes_api, "_request", return_value=stream):
            events = list(hermes_api.run_hermes("Hi", "session_12345678"))
        errors = [e for e in events if e["t"] == "error"]
        self.assertEqual(errors, [{"t": "error", "message": "boom"}])

    def test_youtube_titles_keep_non_ascii_text(self):
        page = '"videoId":"abcdefghijk" "title":{"runs":[{"text":"\\u0639\\u0645\\u0631\\u0648 دياب \\"live\\""}]}'
        with mock.patch.object(server, "_fetch_text", return_value=page):
            result = server._youtube_search("amr diab")
        self.assertEqual(result["best"]["title"], 'عمرو دياب "live"')

    def test_deleting_last_project_does_not_mutate_defaults(self):
        before = copy.deepcopy(workspace.DEFAULT["projects"])
        with tempfile.TemporaryDirectory() as folder:
            old_file = workspace.FILE
            try:
                workspace.FILE = pathlib.Path(folder) / "workspace.json"
                state = workspace.load()
                for project in state["projects"]:
                    workspace.action({"action": "delete_project", "id": project["id"]})
                state = workspace.load()
                workspace.save(state)
                workspace.action({"action": "add_session", "projectId": state["projects"][0]["id"], "name": "Extra"})
            finally:
                workspace.FILE = old_file
        self.assertEqual(workspace.DEFAULT["projects"], before)

    def test_env_values_cannot_inject_extra_lines(self):
        with tempfile.TemporaryDirectory() as folder:
            old_root = workspace.ROOT
            try:
                workspace.ROOT = pathlib.Path(folder)
                with mock.patch.dict(os.environ, {}, clear=False):
                    workspace._env_update({"JARVIS_API_BASE": "http://x\nHERMES_CMD=evil"})
                    lines = (pathlib.Path(folder) / ".env").read_text().splitlines()
            finally:
                workspace.ROOT = old_root
        self.assertEqual(lines, ["JARVIS_API_BASE=http://xHERMES_CMD=evil"])


if __name__ == "__main__":
    unittest.main()
