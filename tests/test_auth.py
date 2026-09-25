import pathlib
import tempfile
import unittest
from unittest import mock

import auth


class AuthTests(unittest.TestCase):
    def test_enroll_login_logout_and_wrong_password(self):
        with tempfile.TemporaryDirectory() as folder:
            with mock.patch.object(auth, "FILE", pathlib.Path(folder) / "auth.json"):
                auth.SESSIONS.clear()
                auth.ATTEMPTS.clear()
                auth.enroll("long private password")
                self.assertTrue(auth.configured())
                self.assertIsNone(auth.login("wrong password"))
                sid, csrf = auth.login("long private password")
                self.assertEqual(auth.session(f"zuzu_session={sid}")["csrf"], csrf)
                auth.logout(f"zuzu_session={sid}")
                self.assertIsNone(auth.session(f"zuzu_session={sid}"))

    def test_short_password_and_double_enrollment_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            with mock.patch.object(auth, "FILE", pathlib.Path(folder) / "auth.json"):
                with self.assertRaises(ValueError):
                    auth.enroll("short")
                auth.enroll("at least twelve chars")
                with self.assertRaises(ValueError):
                    auth.enroll("another long password")


if __name__ == "__main__":
    unittest.main()
