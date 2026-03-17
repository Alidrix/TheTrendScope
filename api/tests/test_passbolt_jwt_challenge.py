import json
import os
import sys
import unittest
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
