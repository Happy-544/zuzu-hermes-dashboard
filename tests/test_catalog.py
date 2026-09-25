import json
import unittest
from unittest import mock

import catalog


class CatalogueTests(unittest.TestCase):
    def test_search_uses_hermes_registry_json(self):
        result=mock.Mock(returncode=0, stdout=json.dumps([{"name":"Demo", "identifier":"official/demo",
            "source":"official", "trust_level":"builtin", "description":"Example"}]))
        with mock.patch.object(catalog.runtime, "_hermes_base", return_value=["hermes"]), \
             mock.patch.object(catalog.subprocess, "run", return_value=result) as run:
            items=catalog.search("browser", "official")
        self.assertEqual(items[0]["identifier"], "official/demo")
        self.assertEqual(run.call_args.args[0][:4], ["hermes", "skills", "search", "browser"])

    def test_install_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            catalog.install("../../outside")

    def test_plugin_search_and_disabled_install(self):
        skill_result = mock.Mock(returncode=0, stdout="[]")
        plugin_result = mock.Mock(returncode=0, stdout=json.dumps({"results": [
            {"name": "Example", "repo": "owner/example", "tier": "community", "description": "Demo"}]}))
        install_result = mock.Mock(returncode=0, stdout="Installed")
        with mock.patch.object(catalog.runtime, "_hermes_base", return_value=["hermes"]), \
             mock.patch.object(catalog.subprocess, "run", side_effect=[skill_result, plugin_result, install_result]) as run:
            items = catalog.search("example")
            installed = catalog.install(items[0]["identifier"], "plugin")
        self.assertEqual(items[0]["kind"], "plugin")
        self.assertTrue(installed["installed"])
        self.assertEqual(run.call_args.args[0], ["hermes", "plugins", "install", "owner/example", "--no-enable"])


if __name__ == "__main__":
    unittest.main()
