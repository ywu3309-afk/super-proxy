"""Health handshake contract without importing/starting the gateway."""
import ast
import os
from pathlib import Path
import re
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


class DesktopHealthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tree = ast.parse((ROOT / 'hub/wb_proxy.py').read_text(encoding='utf-8'))
        handler = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Handler')
        method = next(n for n in handler.body if isinstance(n, ast.FunctionDef) and n.name == '_get_health')
        namespace = {'os': os, 're': re, 'current_account': lambda: None,
                     'CURRENT_REALM': 'cn', 'POOL': None, 'auth_required': lambda: True}
        exec(compile(ast.Module(body=[method], type_ignores=[]), '<health-handshake>', 'exec'), namespace)
        cls.health = namespace['_get_health']

    def _key_ok(self):
        return False

    def _json(self, status, payload):
        return status, payload

    def test_exact_launch_identity_is_returned(self):
        with mock.patch.dict(os.environ, {'WB_DESKTOP_INSTANCE_ID': 'a1' * 16}):
            status, payload = self.health()
        self.assertEqual(status, 200)
        self.assertEqual(payload['desktop_instance_id'], 'a1' * 16)
        self.assertTrue(payload['ok'])

    def test_unset_or_malformed_identity_is_not_exposed(self):
        for value in ('', 'secret', 'A1' * 16, 'a1' * 16 + '\n'):
            with self.subTest(value=value), mock.patch.dict(os.environ, {'WB_DESKTOP_INSTANCE_ID': value}):
                _, payload = self.health()
                self.assertNotIn('desktop_instance_id', payload)


if __name__ == '__main__':
    unittest.main()
