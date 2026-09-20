import hashlib
import json
from pathlib import Path
import secrets
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

from ngrok_setup import SetupStore


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = SetupStore(self.temp.name)
        self.key = secrets.token_urlsafe(32)
        self.token = 'fake_test_token_' + 'a' * 30
        self.store.state.write_text(json.dumps({
            'key_hash': hashlib.sha256(self.key.encode()).hexdigest(),
            'expires': time.time() + 60,
        }), encoding='utf-8')

    def test_invalid_key_cannot_write(self):
        self.assertEqual(self.store.save('x' * 43, self.token)[1], 403)
        self.assertFalse(self.store.config.exists())

    def test_expired_link_cannot_write(self):
        data = json.loads(self.store.state.read_text())
        data['expires'] = time.time() - 1
        self.store.state.write_text(json.dumps(data))
        self.assertEqual(self.store.save(self.key, self.token)[1], 403)

    def test_one_use_and_no_token_in_response(self):
        body, status = self.store.save(self.key, self.token)
        self.assertEqual(status, 200)
        self.assertNotIn(self.token, json.dumps(body))
        self.assertFalse(self.store.active())
        self.assertFalse(self.store.state.exists())
        content = self.store.config.read_text()
        self.assertIn(self.token, content)
        self.assertEqual(self.store.save(self.key, 'b' * 40)[1], 403)
        self.assertEqual(self.store.config.read_text(), content)

    def test_existing_config_preserved(self):
        self.store.config.write_text('original-private-config')
        self.assertEqual(self.store.save(self.key, self.token)[1], 403)
        self.assertEqual(self.store.config.read_text(), 'original-private-config')

    def test_invalid_token_is_not_saved_or_consumed(self):
        for token in [None, {}, 'short', 'ngrok config add-authtoken ' + self.token, self.token + '\ninjected: true']:
            self.assertEqual(self.store.save(self.key, token)[1], 400)
            self.assertFalse(self.store.config.exists())
            self.assertTrue(self.store.active())

    def test_concurrent_submissions_only_one_save(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            statuses = list(pool.map(lambda _: self.store.save(self.key, self.token)[1], range(4)))
        self.assertEqual(statuses.count(200), 1)
        self.assertEqual(statuses.count(403), 3)


if __name__ == '__main__':
    unittest.main()
