import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.append(str(Path(__file__).resolve().parents[1]))
from passbolt_api import PassboltApiAuthService


class PassboltJwtChallengeRegressionTests(unittest.TestCase):
    def _service(self) -> PassboltApiAuthService:
        env = {
            "PASSBOLT_API_BASE_URL": "https://example.passbolt.test",
            "PASSBOLT_API_USER_ID": "11111111-2222-3333-4444-555555555555",
            "PASSBOLT_API_PRIVATE_KEY_PATH": "/tmp/private.asc",
            "PASSBOLT_API_PASSPHRASE": "secret",
        }
        with patch.dict(os.environ, env, clear=False):
            return PassboltApiAuthService()

    def test_build_jwt_challenge_matches_manual_payload_shape(self) -> None:
        service = self._service()

        challenge = service._build_jwt_challenge()

        self.assertEqual(challenge["version"], "1.0.0")
        self.assertEqual(challenge["domain"], "https://passbolt.karapasse.fr")
        self.assertIsInstance(challenge["verify_token"], str)
        self.assertEqual(service._json_type_name(challenge["verify_token_expiry"]), "number")
        self.assertTrue(service._challenge_matches_manual_flow(challenge))

    def test_signed_payload_keeps_inline_signature_contract(self) -> None:
        service = self._service()
        signature = "-----BEGIN PGP SIGNED MESSAGE-----\n..."

        payload = service._build_signed_challenge_payload(signature)

        self.assertEqual(payload["user_id"], "11111111-2222-3333-4444-555555555555")
        self.assertEqual(payload["challenge"], signature)
        serialized = json.dumps(payload)
        self.assertIn('"challenge"', serialized)
        self.assertIn('"user_id"', serialized)

    def test_jwt_login_payload_contract_uses_json_and_writes_dumps(self) -> None:
        service = self._service()
        service.base_url = "https://example.passbolt.test"
        encrypted = "-----BEGIN PGP MESSAGE-----\nabc\n-----END PGP MESSAGE-----\n"

        sent = {}

        def fake_prepare(request):
            sent["json"] = request.json
            sent["data"] = request.data
            sent["url"] = request.url
            return SimpleNamespace(body=json.dumps(request.json), headers={})

        def fake_send(prepared, timeout, verify):
            sent["timeout"] = timeout
            sent["verify"] = verify
            return SimpleNamespace(text='{"body":"ok"}', status_code=200, json=lambda: {"body": "ok"})

        service._session.prepare_request = fake_prepare
        service._session.send = fake_send

        status, payload, _, _, diagnostics = service._send_jwt_login_request(encrypted)

        self.assertEqual(status, 200)
        self.assertEqual(payload.get("body"), "ok")
        self.assertEqual(sent["url"], "https://example.passbolt.test/auth/jwt/login.json")
        self.assertEqual(sent["json"]["user_id"], "11111111-2222-3333-4444-555555555555")
        self.assertEqual(sent["json"]["challenge"], encrypted)
        self.assertFalse(sent["data"])
        self.assertTrue(diagnostics["uses_json_parameter"])
        self.assertFalse(diagnostics["uses_data_parameter"])


if __name__ == "__main__":
    unittest.main()
