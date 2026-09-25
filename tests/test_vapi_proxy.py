import json
import os
import unittest
from unittest import mock

import vapi_proxy


class VapiProxyTests(unittest.TestCase):
    def test_requires_distinct_phone_credentials(self):
        with mock.patch.dict(os.environ, {"VAPI_LLM_TOKEN": "", "HERMES_PHONE_API_KEY": "", "HERMES_PHONE_API_BASE": ""}):
            self.assertFalse(vapi_proxy.authorized("Bearer anything"))
            with self.assertRaises(RuntimeError):
                vapi_proxy.upstream({"messages": [{"role": "user", "content": "Hi"}]})

    def test_only_messages_reach_restricted_hermes_profile(self):
        with mock.patch.dict(os.environ, {"VAPI_LLM_TOKEN": "token", "HERMES_PHONE_API_KEY": "private",
                                      "HERMES_PHONE_API_BASE": "http://127.0.0.1:8642/p/phone"}):
            with mock.patch.object(vapi_proxy.urllib.request, "urlopen") as open_url:
                vapi_proxy.upstream({"model": "attacker", "provider": "other", "tools": [{"name": "terminal"}],
                                     "messages": [{"role": "user", "content": "Hello"}], "stream": True})
                request = open_url.call_args.args[0]
                self.assertEqual(request.full_url, "http://127.0.0.1:8642/p/phone/v1/chat/completions")
                body = json.loads(request.data)
                self.assertEqual(body, {"model": "hermes-agent", "messages": [{"role": "user", "content": "Hello"}], "stream": True})
                self.assertTrue(vapi_proxy.authorized("Bearer token"))
                self.assertFalse(vapi_proxy.authorized("Bearer wrong"))


if __name__ == "__main__":
    unittest.main()
