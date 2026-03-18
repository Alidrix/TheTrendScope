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
        self.assertEqual(service.user_id, service.MANUAL_JWT_USER_ID)

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
        self.assertEqual(sent["json"]["user_id"], service.MANUAL_JWT_USER_ID)
        self.assertEqual(sent["json"]["challenge"], encrypted)
        self.assertFalse(sent["data"])
        self.assertTrue(diagnostics["uses_json_parameter"])
        self.assertFalse(diagnostics["uses_data_parameter"])
        self.assertTrue(diagnostics["challenge_in_body_matches_dump"])


    def test_extract_response_challenge_reads_body_challenge(self) -> None:
        service = self._service()

        payload = {"body": {"challenge": "-----BEGIN PGP MESSAGE-----\nabc\n-----END PGP MESSAGE-----"}}

        self.assertIn("BEGIN PGP MESSAGE", service._extract_response_challenge(payload))

    def test_normalize_domain_ignores_trailing_slash(self) -> None:
        from passbolt_api import _normalize_domain

        self.assertEqual(_normalize_domain("https://example.test/"), _normalize_domain("https://example.test"))

    def test_sign_encrypt_uses_trust_model_always(self) -> None:
        service = self._service()

        with patch.object(service, '_import_server_public_key', return_value=(service.SERVER_VERIFY_FINGERPRINT, {'imported_fingerprints': [service.SERVER_VERIFY_FINGERPRINT], 'selected_fingerprint': service.SERVER_VERIFY_FINGERPRINT})), \
             patch.object(service, '_resolve_signing_fingerprint', return_value=service.CLIENT_SIGNING_FINGERPRINT), \
             patch('passbolt_api.subprocess.run') as run_mock:
            run_mock.return_value = SimpleNamespace(returncode=0, stdout=b'-----BEGIN PGP MESSAGE-----\nabc\n-----END PGP MESSAGE-----\n', stderr=b'')

            _, details = service._sign_and_encrypt_challenge_jwt(
                {'version': '1.0.0', 'domain': service.MANUAL_JWT_DOMAIN, 'verify_token': 'x', 'verify_token_expiry': 1},
                '/tmp',
                [service.CLIENT_SIGNING_FINGERPRINT],
                'PUBLIC_KEY',
            )

        args = run_mock.call_args.kwargs['args'] if 'args' in run_mock.call_args.kwargs else run_mock.call_args.args[0]
        self.assertIn('--trust-model', args)
        trust_index = args.index('--trust-model')
        self.assertEqual(args[trust_index + 1], 'always')
        self.assertEqual(details['trust_model_used'], 'always')

    def test_gpg_path_is_always_defined(self) -> None:
        with patch.dict(os.environ, {"PASSBOLT_GPG_PATH": "/custom/gpg"}, clear=False):
            service = self._service()
        self.assertEqual(service.gpg_path, "/custom/gpg")

    def test_decrypt_login_response_uses_configured_gpg_path(self) -> None:
        service = self._service()
        service.gpg_path = "/custom/gpg"

        with patch("passbolt_api.subprocess.run") as run_mock:
            run_mock.return_value = SimpleNamespace(returncode=0, stdout=b"{}", stderr=b"")
            service._decrypt_login_response_challenge("/tmp/gnupg", "-----BEGIN PGP MESSAGE-----")

        args = run_mock.call_args.kwargs['args'] if 'args' in run_mock.call_args.kwargs else run_mock.call_args.args[0]
        self.assertEqual(args[0], "/custom/gpg")
        self.assertIn("--homedir", args)


if __name__ == "__main__":
    unittest.main()
