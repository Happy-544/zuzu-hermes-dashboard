import os
import unittest
from unittest import mock

import phone_calls


class PhoneCallTests(unittest.TestCase):
    def test_phone_number_validation(self):
        self.assertTrue(phone_calls.valid_number("+15551234567"))
        for number in ("5551234567", "+012345678", "+123", "+1234567890123456", "tel:+15551234567"):
            self.assertFalse(phone_calls.valid_number(number))

    def test_outbound_requires_confirmation_and_verified_hermes_brain(self):
        with mock.patch.dict(os.environ, {"VAPI_API_KEY": "test", "VAPI_ASSISTANT_ID": "assistant",
                                      "VAPI_PHONE_NUMBER_ID": "number", "JARVIS_PUBLIC_ORIGIN": "https://example.ngrok-free.dev",
                                      "VAPI_LLM_TOKEN": "token", "HERMES_PHONE_API_KEY": "private", "HERMES_PHONE_API_BASE": "http://127.0.0.1:8642/p/phone"}):
            with mock.patch.object(phone_calls, "_api", return_value={"model": {"provider": "openai"}, "maxDurationSeconds": 300}) as api:
                with self.assertRaises(ValueError):
                    phone_calls.outbound("+15551234567", False, "request123456")
                with self.assertRaises(RuntimeError):
                    phone_calls.outbound("+15551234567", True, "request123456")
                api.assert_called_once()

    def test_duplicate_call_id_returns_original_result(self):
        phone_calls._RECENT.clear()
        def response(method, path, payload=None):
            if method == "GET":
                return {"model": {"provider": "custom-llm", "url": "https://example.ngrok-free.dev/v1"},
                        "maxDurationSeconds": 300}
            return {"id": "call-1", "status": "queued"}
        with mock.patch.dict(os.environ, {"VAPI_API_KEY": "test", "VAPI_ASSISTANT_ID": "assistant",
                                      "VAPI_PHONE_NUMBER_ID": "number", "JARVIS_PUBLIC_ORIGIN": "https://example.ngrok-free.dev",
                                      "VAPI_LLM_TOKEN": "token", "HERMES_PHONE_API_KEY": "private", "HERMES_PHONE_API_BASE": "http://127.0.0.1:8642/p/phone"}):
            with mock.patch.object(phone_calls, "_api", side_effect=response) as api:
                first = phone_calls.outbound("+15551234567", True, "request123456")
                second = phone_calls.outbound("+15551234567", True, "request123456")
                self.assertEqual(first, second)
                self.assertEqual(len([c for c in api.call_args_list if c.args[0] == "POST"]), 1)


if __name__ == "__main__":
    unittest.main()
