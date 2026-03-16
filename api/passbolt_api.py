from __future__ import annotations

import json
import os
import secrets
import shutil
import stat
import subprocess
import tempfile
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

import gnupg
import pyotp
import requests


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _now_plus(minutes: int) -> str:
    return (_utc_now() + timedelta(minutes=minutes)).isoformat()


def _extract_message(payload: Any, fallback: str = "") -> str:
    if isinstance(payload, dict):
        for key in ("message", "error", "detail"):
            if payload.get(key):
                return str(payload.get(key))
        body = payload.get("body")
        if isinstance(body, dict):
            for key in ("message", "error", "detail"):
                if body.get(key):
                    return str(body.get(key))
    return fallback


def parse_dry_run_message(payload: dict[str, Any], fallback: str = "Dry-run rejected") -> str:
    body = payload.get("body") if isinstance(payload, dict) else None
    candidates: list[str] = []
    if isinstance(body, dict):
        for key in ("message", "error", "reason"):
            if body.get(key):
                candidates.append(str(body.get(key)))
        errors = body.get("errors")
        if isinstance(errors, dict):
            for value in errors.values():
                if isinstance(value, list):
                    candidates.extend(str(v) for v in value if v)
                elif value:
                    candidates.append(str(value))
    candidates.append(_extract_message(payload, ""))
    normalized = " ".join(x for x in candidates if x).lower()
    if "sole" in normalized and "owner" in normalized:
        return "Suppression impossible : l'utilisateur/groupe est encore propriétaire unique de ressources"
    if "transfer" in normalized:
        return "Suppression impossible : des transferts de propriété sont nécessaires"
    if "depend" in normalized:
        return "Suppression impossible : des dépendances restantes bloquent l'opération"
    return next((x for x in candidates if x), fallback)


def parse_dry_run_details(payload: dict[str, Any]) -> dict[str, Any]:
    body = payload.get("body") if isinstance(payload, dict) else None
    if not isinstance(body, dict):
        return {}
    interesting = (
        "resources", "resources_count", "groups", "groups_to_delete", "ownership", "ownership_remaining",
        "dependencies", "blocking_reasons", "transfers", "required_actions", "errors",
    )
    result: dict[str, Any] = {}
    for key in interesting:
        if key in body:
            result[key] = body.get(key)
    return result


@dataclass
class DiagnosticStep:
    id: str
    label: str
    status: str = "skipped"
    started_at: str | None = None
    finished_at: str | None = None
    message: str = ""
    details: dict[str, Any] = field(default_factory=dict)
    http_status: int | None = None
    endpoint: str | None = None
    remediation: str | None = None

    def start(self) -> None:
        self.started_at = _utc_now().isoformat()

    def done(self, status: str, message: str, **kwargs: Any) -> None:
        self.status = status
        self.message = message
        self.finished_at = _utc_now().isoformat()
        for key, value in kwargs.items():
            setattr(self, key, value)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "message": self.message,
            "details": self.details,
            "http_status": self.http_status,
            "endpoint": self.endpoint,
            "remediation": self.remediation,
        }


class PassboltApiAuthService:
    def __init__(self, logger: Any | None = None) -> None:
        self.base_url = (os.getenv("PASSBOLT_API_BASE_URL", "") or os.getenv("PASSBOLT_URL", "")).rstrip("/")
        self.auth_mode = (os.getenv("PASSBOLT_API_AUTH_MODE", "jwt") or "jwt").strip().lower()
        self.user_id = (os.getenv("PASSBOLT_API_USER_ID", "") or "").strip()
        self.private_key_path = (os.getenv("PASSBOLT_API_PRIVATE_KEY_PATH", "/app/keys/admin-private.asc") or "").strip()
        self.gnupg_home = (os.getenv("PASSBOLT_API_GNUPGHOME", "/tmp/gnupg-passbolt") or "").strip()
        self.passphrase = os.getenv("PASSBOLT_API_PASSPHRASE", "")
        self.signing_fingerprint = (
            os.getenv("PASSBOLT_API_SIGNING_FINGERPRINT", "F5AA9480ABEFC0BB9B4D5FF73FB3F49967045860") or ""
        ).strip().replace(" ", "").upper()
        self.verify_tls = os.getenv("PASSBOLT_API_VERIFY_TLS", "true").lower() not in {"0", "false", "no"}
        self.ca_bundle = (os.getenv("PASSBOLT_API_CA_BUNDLE", "") or "").strip()
        self.mfa_provider = (os.getenv("PASSBOLT_API_MFA_PROVIDER", "totp") or "totp").strip().lower()
        self.totp_secret = (os.getenv("PASSBOLT_API_TOTP_SECRET", "") or "").strip()
        self.timeout = int(os.getenv("PASSBOLT_API_TIMEOUT", "30"))
        self._session = requests.Session()
        self._tokens: dict[str, Any] = {}
        self._logger = logger
        self._last_verify_token: str | None = None
        self._last_mfa_status = "not_required"

    def _resolve_signing_fingerprint(self, available_fingerprints: list[str]) -> str:
        normalized_available = [fp.strip().replace(" ", "").upper() for fp in available_fingerprints if fp]
        if not normalized_available:
            raise RuntimeError("Aucun fingerprint disponible pour la signature")
        if self.signing_fingerprint:
            if self.signing_fingerprint in normalized_available:
                return self.signing_fingerprint
            raise RuntimeError(
                f"Fingerprint de signature introuvable dans le homedir GPG: {self.signing_fingerprint}"
            )
        return normalized_available[0]

    def _sign_challenge_jwt(self, challenge_payload: dict[str, Any], gpg_home: str, available_fingerprints: list[str]) -> tuple[str, dict[str, Any]]:
        fingerprint = self._resolve_signing_fingerprint(available_fingerprints)
        json_payload = json.dumps(challenge_payload)
        gpg_path = shutil.which("gpg") or "gpg"

        command = [
            gpg_path,
            "--homedir",
            gpg_home,
            "--batch",
            "--yes",
            "--pinentry-mode",
            "loopback",
            "--status-fd",
            "2",
            "--no-tty",
            "--armor",
            "--detach-sign",
            "--local-user",
            fingerprint,
        ]
        stdin_data: bytes | None = None
        if self.passphrase:
            command.extend(["--passphrase-fd", "0"])
            stdin_data = f"{self.passphrase}\n".encode("utf-8")

        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False, suffix=".json") as challenge_file:
            challenge_file.write(json_payload)
            challenge_path = challenge_file.name

        sig_path = f"{challenge_path}.asc"
        command.append(challenge_path)

        details: dict[str, Any] = {
            "fingerprint": fingerprint,
            "method": "gpg_subprocess_detach_sign",
            "gpg_args": command[1:],
            "batch": True,
            "pinentry_mode": "loopback",
            "passphrase_provided": bool(self.passphrase),
            "passphrase_delivery": "passphrase-fd" if self.passphrase else "none",
            "gpg_home": gpg_home,
            "challenge_size": len(json_payload),
            "challenge_type": "application/json",
            "returncode": None,
            "stderr": "",
            "stdout": "",
            "status_fd": "2",
            "status_output": "",
            "output_size": 0,
            "output_type": "",
            "python_exception": "",
            "loopback_supported": True,
            "loopback_refused": False,
        }

        try:
            proc = subprocess.run(
                command,
                input=stdin_data,
                capture_output=True,
                timeout=max(self.timeout, 30),
                check=False,
            )
            details["returncode"] = proc.returncode
            details["stderr"] = (proc.stderr or b"").decode("utf-8", errors="replace").strip()
            details["stdout"] = (proc.stdout or b"").decode("utf-8", errors="replace").strip()
            details["status_output"] = "\n".join(
                line for line in details["stderr"].splitlines() if line.startswith("[GNUPG:]")
            )
            lower_stderr = details["stderr"].lower()
            if "pinentry mode 'loopback' failed" in lower_stderr or "not supported" in lower_stderr:
                details["loopback_supported"] = False
                details["loopback_refused"] = True
                details["remediation"] = "Vérifier gpg-agent.conf (allow-loopback-pinentry) puis recharger gpg-agent"
            elif "bad passphrase" in lower_stderr and "loopback" in lower_stderr:
                details["loopback_refused"] = True
                details["remediation"] = "Le mode loopback semble refusé: vérifier gpg-agent et la passphrase transmise en --passphrase-fd"

            if proc.returncode != 0:
                raise RuntimeError(details["stderr"] or f"gpg exited with code {proc.returncode}")
            if not os.path.exists(sig_path):
                raise RuntimeError("Fichier de signature introuvable après exécution gpg")

            with open(sig_path, "r", encoding="utf-8") as sig_handle:
                signature = sig_handle.read()

            details["output_size"] = len(signature)
            details["output_type"] = "armored_pgp_signature"
            if not signature.strip():
                raise RuntimeError("Signature vide générée par gpg")
            return signature, details
        except Exception as error:
            details["python_exception"] = f"{type(error).__name__}: {error}"
            tb = traceback.format_exc().strip()
            details["traceback"] = tb
            raise RuntimeError(f"Signature challenge JWT échouée: {error}")
        finally:
            for path in (challenge_path, sig_path):
                try:
                    if os.path.exists(path):
                        os.remove(path)
                except OSError:
                    pass

    def check_gpg_binary(self) -> dict[str, Any]:
        gpg_path = shutil.which("gpg")
        result: dict[str, Any] = {
            "found": bool(gpg_path),
            "path": gpg_path or "",
            "returncode": None,
            "version": "",
            "stderr": "",
        }
        if not gpg_path:
            result["stderr"] = "Binary 'gpg' not found in PATH"
            return result
        try:
            proc = subprocess.run([gpg_path, "--version"], capture_output=True, text=True, timeout=10, check=False)
            stdout = (proc.stdout or "").strip()
            first_line = stdout.splitlines()[0] if stdout else ""
            result.update({
                "returncode": proc.returncode,
                "version": first_line,
                "stderr": (proc.stderr or "").strip(),
            })
        except Exception as error:
            result.update({"returncode": -1, "stderr": str(error)})
        return result

    @property
    def verify_setting(self) -> bool | str:
        if self.ca_bundle:
            return self.ca_bundle
        return self.verify_tls

    def _log(self, level: str, message: str, **details: Any) -> None:
        if self._logger:
            self._logger(level, message, **details)

    def enabled(self) -> bool:
        status = self.config_status()
        return bool(status.get("configured"))

    def config_status(self) -> dict[str, Any]:
        ca_bundle_exists = bool(self.ca_bundle and os.path.exists(self.ca_bundle))
        ca_bundle_readable = bool(ca_bundle_exists and os.access(self.ca_bundle, os.R_OK))
        checks = {
            "base_url": bool(self.base_url),
            "auth_mode": self.auth_mode == "jwt",
            "user_id": bool(self.user_id),
            "private_key_path": bool(self.private_key_path),
            "private_key_exists": bool(self.private_key_path and os.path.exists(self.private_key_path)),
            "private_key_readable": bool(self.private_key_path and os.path.exists(self.private_key_path) and os.access(self.private_key_path, os.R_OK)),
            "gnupg_home": bool(self.gnupg_home),
            "passphrase": bool(self.passphrase),
            "mfa_provider": self.mfa_provider == "totp",
            "totp_secret": bool(self.totp_secret),
            "ca_bundle_configured": bool(self.ca_bundle),
            "ca_bundle_exists": ca_bundle_exists,
            "ca_bundle_readable": ca_bundle_readable,
            "verify_tls": self.verify_tls,
        }
        required = ("base_url", "auth_mode", "user_id", "private_key_path", "private_key_exists", "private_key_readable", "gnupg_home", "passphrase")
        configured = all(checks[k] for k in required)
        if checks["ca_bundle_configured"] and (not checks["ca_bundle_exists"] or not checks["ca_bundle_readable"]):
            configured = False
        message = "Configuration minimale détectée" if configured else "Configuration API Passbolt incomplète"
        return {"configured": configured, "checks": checks, "message": message}

    def _request_json(self, method: str, path: str, payload: dict[str, Any] | None = None) -> tuple[int, dict[str, Any], str, requests.Response | None]:
        url = f"{self.base_url}{path}"
        try:
            response = self._session.request(
                method,
                url,
                json=payload,
                timeout=self.timeout,
                verify=self.verify_setting,
                headers={"Accept": "application/json", "Content-Type": "application/json", **dict(self._session.headers)},
            )
            data: dict[str, Any] = {}
            if response.text:
                try:
                    data = response.json()
                except Exception:
                    data = {}
            return response.status_code, data, response.text[:2000], response
        except requests.RequestException as error:
            return 0, {}, str(error), None

    def _ensure_gpg_home(self) -> dict[str, Any]:
        if not self.gnupg_home:
            raise RuntimeError("PASSBOLT_API_GNUPGHOME is empty")

        expanded_home = os.path.abspath(os.path.expanduser(self.gnupg_home))
        if os.path.exists(expanded_home) and not os.path.isdir(expanded_home):
            raise RuntimeError(f"PASSBOLT_API_GNUPGHOME must be a directory, got file: {expanded_home}")

        os.makedirs(expanded_home, mode=0o700, exist_ok=True)
        if not os.path.isdir(expanded_home):
            raise RuntimeError(f"PASSBOLT_API_GNUPGHOME should be a directory (it isn't): {expanded_home}")
        if not os.access(expanded_home, os.R_OK | os.W_OK | os.X_OK):
            raise RuntimeError(f"PASSBOLT_API_GNUPGHOME is not readable/writable: {expanded_home}")

        current_mode = stat.S_IMODE(os.stat(expanded_home).st_mode)
        if current_mode != 0o700:
            os.chmod(expanded_home, 0o700)
            current_mode = stat.S_IMODE(os.stat(expanded_home).st_mode)

        return {
            "path": expanded_home,
            "exists": True,
            "is_dir": True,
            "readable": os.access(expanded_home, os.R_OK),
            "writable": os.access(expanded_home, os.W_OK),
            "executable": os.access(expanded_home, os.X_OK),
            "mode_octal": oct(current_mode),
        }

    def _read_private_key_source(self) -> str:
        if not self.private_key_path:
            raise RuntimeError("PASSBOLT_API_PRIVATE_KEY_PATH is empty")
        if not os.path.exists(self.private_key_path):
            raise RuntimeError(f"Clé privée API introuvable: {self.private_key_path}")
        if not os.path.isfile(self.private_key_path):
            raise RuntimeError(f"PASSBOLT_API_PRIVATE_KEY_PATH must be a file: {self.private_key_path}")
        if not os.access(self.private_key_path, os.R_OK):
            raise RuntimeError(f"Clé privée API illisible: {self.private_key_path}")
        with open(self.private_key_path, "r", encoding="utf-8") as handle:
            return handle.read()

    def _import_private_key(self, gpg: gnupg.GPG, private_key_data: str) -> dict[str, Any]:
        result = gpg.import_keys(private_key_data)
        fingerprints = list(result.fingerprints or [])
        if not fingerprints:
            raise RuntimeError("Import de la clé privée impossible")
        return {"fingerprints": fingerprints, "count": len(fingerprints)}

    def _assert_private_key_usable(self, gpg: gnupg.GPG) -> dict[str, Any]:
        private_keys = gpg.list_keys(secret=True)
        if not private_keys:
            raise RuntimeError("Aucune clé privée utilisable dans le homedir GPG")
        fingerprints = [str(key.get("fingerprint") or "") for key in private_keys if key.get("fingerprint")]
        if not fingerprints:
            raise RuntimeError("Clé privée importée sans fingerprint utilisable")
        return {"fingerprints": fingerprints, "count": len(fingerprints)}

    def _build_gpg_context(self) -> tuple[gnupg.GPG, dict[str, Any]]:
        gpg_binary = self.check_gpg_binary()
        if not gpg_binary.get("found") or gpg_binary.get("returncode") not in (0, None):
            raise RuntimeError(f"Binaire gpg indisponible: {gpg_binary.get('stderr') or 'gpg --version failed'}")
        gpg_home = self._ensure_gpg_home()
        gpg = gnupg.GPG(gnupghome=gpg_home["path"])
        private_key_data = self._read_private_key_source()
        imported = self._import_private_key(gpg, private_key_data)
        usable = self._assert_private_key_usable(gpg)
        context = {
            "gpg_binary": gpg_binary,
            "gpg_home": gpg_home,
            "private_key": {"path": self.private_key_path, "size": len(private_key_data)},
            "imported": imported,
            "usable": usable,
            "selected_signing_fingerprint": self._resolve_signing_fingerprint(usable["fingerprints"]),
        }
        return gpg, context

    def _gpg(self) -> gnupg.GPG:
        gpg, _ = self._build_gpg_context()
        return gpg

    @staticmethod
    def _extract_pgp_public_key(payload: dict[str, Any], response: requests.Response | None) -> str:
        body = payload.get("body") if isinstance(payload, dict) else None
        search = [payload]
        if isinstance(body, dict):
            search.append(body)
        for obj in search:
            for key in ("server_public_key", "public_key", "keydata", "armored_key"):
                value = obj.get(key)
                if isinstance(value, str) and "BEGIN PGP PUBLIC KEY BLOCK" in value:
                    return value
        if response is not None:
            for header in ("X-GPGAuth-Verify-Response", "X-GPGAuth-Pubkey"):
                header_url = response.headers.get(header)
                if header_url:
                    return header_url
        raise RuntimeError("Clé publique serveur introuvable dans /auth/verify.json")

    def _fetch_server_public_key(self) -> str:
        self._log("info", "Calling /auth/verify.json")
        status, payload, raw, response = self._request_json("GET", "/auth/verify.json")
        if status >= 400 or status == 0:
            raise RuntimeError(f"/auth/verify.json inaccessible: {_extract_message(payload, raw)}")
        key_or_url = self._extract_pgp_public_key(payload, response)
        if "BEGIN PGP PUBLIC KEY BLOCK" in key_or_url:
            self._log("info", "Server public key retrieved")
            return key_or_url
        key_resp = self._session.get(key_or_url, timeout=self.timeout, verify=self.verify_setting)
        if not key_resp.ok or "BEGIN PGP PUBLIC KEY BLOCK" not in key_resp.text:
            raise RuntimeError("Clé publique serveur introuvable")
        self._log("info", "Server public key retrieved")
        return key_resp.text

    def _encrypt_for_server(self, gpg: gnupg.GPG, plaintext: str, server_public_key: str) -> str:
        imported = gpg.import_keys(server_public_key)
        if not imported.fingerprints:
            raise RuntimeError("Import de la clé publique serveur impossible")
        encrypted = gpg.encrypt(plaintext, recipients=imported.fingerprints, always_trust=True)
        if not encrypted.ok:
            raise RuntimeError(f"Chiffrement challenge échoué: {encrypted.status}")
        return str(encrypted)

    def _decrypt_payload(self, gpg: gnupg.GPG, encrypted: str) -> str:
        decrypted = gpg.decrypt(encrypted, passphrase=self.passphrase)
        if not decrypted.ok:
            raise RuntimeError(f"Déchiffrement échoué: {decrypted.status}")
        return str(decrypted)

    def _extract_token_payload(self, gpg: gnupg.GPG, login_payload: dict[str, Any]) -> dict[str, Any]:
        body = login_payload.get("body") if isinstance(login_payload, dict) else None
        if isinstance(body, str) and "BEGIN PGP MESSAGE" in body:
            self._log("info", "JWT login response decrypted")
            return json.loads(self._decrypt_payload(gpg, body))
        if isinstance(body, dict):
            return body
        if isinstance(login_payload, dict):
            return login_payload
        raise RuntimeError("Réponse login inattendue")

    def _verify_mfa_if_required(self, token_payload: dict[str, Any]) -> str:
        providers = token_payload.get("mfa_providers")
        if not providers:
            body = token_payload.get("body") if isinstance(token_payload.get("body"), dict) else {}
            providers = body.get("mfa_providers")
        if not providers:
            self._last_mfa_status = "not_required"
            return "not_required"

        self._log("info", "MFA required", providers=providers)
        if self.mfa_provider != "totp":
            self._last_mfa_status = "failed"
            raise RuntimeError("MFA required but provider not supported")
        if not self.totp_secret:
            self._last_mfa_status = "failed"
            raise RuntimeError("MFA required but PASSBOLT_API_TOTP_SECRET is missing")

        self._log("info", "TOTP generated")
        code = pyotp.TOTP(self.totp_secret.replace(" ", "")).now()
        self._log("info", "Calling /mfa/verify/totp.json")
        status, payload, raw, _ = self._request_json("POST", "/mfa/verify/totp.json", {"totp": code})
        if status >= 400:
            self._last_mfa_status = "failed"
            self._log("error", "MFA verification failed: invalid TOTP", status=status)
            raise RuntimeError(_extract_message(payload, raw or "MFA verification failed: invalid TOTP"))
        self._last_mfa_status = "verified"
        self._log("info", "MFA verification succeeded")
        return "verified"

    def authenticate(self) -> dict[str, Any]:
        if self.auth_mode != "jwt":
            raise RuntimeError("Only PASSBOLT_API_AUTH_MODE=jwt is supported")
        if not self.enabled():
            raise RuntimeError("Passbolt API is not configured")

        self._log("info", "Starting Passbolt JWT authentication")
        gpg = self._gpg()

        server_public_key = self._fetch_server_public_key()

        verify_token = secrets.token_urlsafe(32)
        self._last_verify_token = verify_token
        challenge = {
            "version": "1.0.0",
            "domain": self.base_url,
            "verify_token": verify_token,
            "verify_token_expiry": _now_plus(5),
        }
        self._log("info", "JWT challenge generated")

        _, context = self._build_gpg_context()
        signature, sign_details = self._sign_challenge_jwt(challenge, context["gpg_home"]["path"], context["usable"]["fingerprints"])
        self._log("info", "JWT challenge signed", **sign_details)

        self._log("info", "JWT signing fingerprint selected", fingerprint=sign_details["fingerprint"])

        envelope = {"user_id": self.user_id, "challenge": challenge, "challenge_signature": signature}
        encrypted = self._encrypt_for_server(gpg, json.dumps(envelope), server_public_key)
        self._log("info", "JWT challenge encrypted")

        self._log("info", "JWT login request sent")
        status, login_payload, raw, _ = self._request_json("POST", "/auth/jwt/login.json", {"challenge": encrypted, "user_id": self.user_id})
        if status >= 400 or status == 0:
            raise RuntimeError(_extract_message(login_payload, raw or f"JWT login failed HTTP {status}"))

        token_payload = self._extract_token_payload(gpg, login_payload)
        returned_verify_token = token_payload.get("verify_token")
        if returned_verify_token != verify_token:
            raise RuntimeError("verify_token mismatch")
        self._log("info", "verify_token validated")

        access_token = token_payload.get("access_token") or token_payload.get("token")
        refresh_token = token_payload.get("refresh_token")
        if not access_token:
            raise RuntimeError("Missing access_token after JWT login")
        self._log("info", "access_token extracted")

        self._tokens = {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "mfa_status": self._verify_mfa_if_required(token_payload),
        }
        self._session.headers.update({"Authorization": f"Bearer {access_token}"})
        return self._tokens

    def run_diagnostic(self) -> dict[str, Any]:
        steps = [
            DiagnosticStep("config", "Présence de la configuration minimale"),
            DiagnosticStep("network", "Accessibilité réseau de l'URL Passbolt"),
            DiagnosticStep("tls", "Validation TLS / CA bundle"),
            DiagnosticStep("gpg_binary", "Binaire GPG disponible"),
            DiagnosticStep("healthcheck_status", "GET /healthcheck/status.json"),
            DiagnosticStep("verify", "GET /auth/verify.json"),
            DiagnosticStep("server_key", "Récupération de la clé publique serveur"),
            DiagnosticStep("gpg_home", "Validation du homedir GPG local"),
            DiagnosticStep("private_key_read", "Lecture du fichier de clé privée locale"),
            DiagnosticStep("private_key_import", "Import de la clé privée dans le homedir GPG"),
            DiagnosticStep("private_key_usable", "Validation de l'usage de la clé privée"),
            DiagnosticStep("challenge", "Génération du challenge JWT"),
            DiagnosticStep("sign", "Signature du challenge JWT"),
            DiagnosticStep("encrypt", "Chiffrement du challenge JWT"),
            DiagnosticStep("jwt_login", "Login JWT /auth/jwt/login.json"),
            DiagnosticStep("verify_token", "Validation du verify_token"),
            DiagnosticStep("mfa", "MFA requise ou non"),
            DiagnosticStep("mfa_totp", "MFA TOTP si nécessaire"),
            DiagnosticStep("authenticated", "GET /auth/is-authenticated.json"),
            DiagnosticStep("groups", "GET /groups.json"),
            DiagnosticStep("healthcheck", "GET /healthcheck.json"),
        ]
        report = {"overall_status": "error", "steps": []}

        def finalize() -> dict[str, Any]:
            report["steps"] = [s.to_dict() for s in steps]
            required_success = {"sign", "encrypt", "jwt_login", "verify_token", "authenticated", "groups", "mfa_totp"}
            required_statuses = {s.id: s.status for s in steps if s.id in required_success}
            if any(s.status == "error" for s in steps):
                report["overall_status"] = "error"
            elif any(required_statuses.get(step) != "success" for step in required_success):
                report["overall_status"] = "warning"
            elif any(s.status == "warning" for s in steps):
                report["overall_status"] = "warning"
            else:
                report["overall_status"] = "ok"
            return report

        try:
            s = steps[0]; s.start()
            cfg = self.config_status()
            if not cfg["configured"]:
                s.done("error", "Configuration minimale manquante", details=cfg, remediation="Configurer PASSBOLT_API_BASE_URL, PASSBOLT_API_USER_ID, PASSBOLT_API_PRIVATE_KEY_PATH, PASSBOLT_API_PASSPHRASE")
                return finalize()
            s.done("success", "Configuration minimale détectée", details=cfg)

            s = steps[1]; s.start()
            try:
                resp = self._session.get(self.base_url, timeout=self.timeout, verify=self.verify_setting)
                s.done("success", "Connectivité réseau OK", http_status=resp.status_code, endpoint=self.base_url)
            except requests.RequestException as error:
                s.done("error", "Connexion réseau impossible", details={"error": str(error)}, remediation="Vérifier DNS/pare-feu et PASSBOLT_API_BASE_URL")
                return finalize()

            s = steps[2]; s.start()
            if self.verify_setting is False:
                s.done("warning", "Validation TLS désactivée", details={"verify": False}, remediation="Activer PASSBOLT_API_VERIFY_TLS")
            elif isinstance(self.verify_setting, str):
                if not os.path.exists(self.verify_setting):
                    s.done("error", "CA bundle introuvable", details={"ca_bundle": self.verify_setting}, remediation="Corriger PASSBOLT_API_CA_BUNDLE")
                    return finalize()
                if not os.access(self.verify_setting, os.R_OK):
                    s.done("error", "CA bundle illisible", details={"ca_bundle": self.verify_setting}, remediation="Rendre le CA bundle lisible")
                    return finalize()
                s.done("success", "CA bundle valide", details={"ca_bundle": self.verify_setting})
            else:
                s.done("success", "Validation TLS système active", details={"verify": True})

            s = steps[3]; s.start()
            gpg_binary = self.check_gpg_binary()
            if not gpg_binary.get("found"):
                s.done("error", "Binaire gpg introuvable", details=gpg_binary, remediation="Installer gnupg dans le conteneur backend")
                return finalize()
            if gpg_binary.get("returncode") not in (0, None):
                s.done("error", "gpg --version échoué", details=gpg_binary, remediation="Vérifier l'installation de gnupg/gpg-agent/dirmngr")
                return finalize()
            s.done("success", "Binaire gpg disponible", details=gpg_binary)

            s = steps[4]; s.start()
            status, payload, raw, _ = self._request_json("GET", "/healthcheck/status.json")
            if status >= 400 or status == 0:
                s.done("error", "/healthcheck/status.json inaccessible", http_status=status or None, endpoint="/healthcheck/status.json", details={"error": _extract_message(payload, raw)})
                return finalize()
            s.done("success", "/healthcheck/status.json accessible", http_status=status, endpoint="/healthcheck/status.json")

            s = steps[5]; s.start()
            status, payload, raw, verify_response = self._request_json("GET", "/auth/verify.json")
            if status >= 400 or status == 0:
                s.done("error", "/auth/verify.json inaccessible", http_status=status or None, endpoint="/auth/verify.json", details={"error": _extract_message(payload, raw)})
                return finalize()
            s.done("success", "/auth/verify.json accessible", http_status=status, endpoint="/auth/verify.json")

            s = steps[6]; s.start()
            key_or_url = self._extract_pgp_public_key(payload, verify_response)
            if "BEGIN PGP PUBLIC KEY BLOCK" in key_or_url:
                server_key = key_or_url
            else:
                key_resp = self._session.get(key_or_url, timeout=self.timeout, verify=self.verify_setting)
                if not key_resp.ok:
                    s.done("error", "Récupération clé publique serveur impossible", endpoint=key_or_url, http_status=key_resp.status_code)
                    return finalize()
                server_key = key_resp.text
            s.done("success", "Clé publique serveur récupérée", details={"length": len(server_key)})

            s = steps[7]; s.start()
            gpg_home_info = self._ensure_gpg_home()
            s.done("success", "Homedir GPG valide", details=gpg_home_info)

            s = steps[8]; s.start()
            private_key_data = self._read_private_key_source()
            s.done("success", "Clé privée locale lue", details={"path": self.private_key_path, "size": len(private_key_data)})

            gpg = gnupg.GPG(gnupghome=gpg_home_info["path"])

            s = steps[9]; s.start()
            imported = self._import_private_key(gpg, private_key_data)
            s.done("success", "Clé privée importée", details=imported)

            s = steps[10]; s.start()
            usable = self._assert_private_key_usable(gpg)
            s.done("success", "Clé privée utilisable", details=usable)

            verify_token = secrets.token_urlsafe(32)
            challenge_payload = {"version": "1.0.0", "domain": self.base_url, "verify_token": verify_token, "verify_token_expiry": _now_plus(5)}
            s = steps[11]; s.start(); s.done("success", "Challenge JWT généré", details={"fields": list(challenge_payload.keys())})

            s = steps[12]; s.start()
            sign_details: dict[str, Any] = {}
            try:
                signature, sign_details = self._sign_challenge_jwt(challenge_payload, gpg_home_info["path"], usable["fingerprints"])
            except Exception as error:
                s.done("error", str(error), details=sign_details or {"python_exception": f"{type(error).__name__}: {error}"})
                return finalize()
            s.done("success", "Challenge JWT signé", details=sign_details)

            s = steps[13]; s.start()
            encrypted = self._encrypt_for_server(gpg, json.dumps({"user_id": self.user_id, "challenge": challenge_payload, "challenge_signature": signature}), server_key)
            s.done("success", "Challenge JWT chiffré", details={"size": len(encrypted)})

            s = steps[14]; s.start()
            status, login_payload, raw, _ = self._request_json("POST", "/auth/jwt/login.json", {"challenge": encrypted, "user_id": self.user_id})
            if status >= 400 or status == 0:
                s.done("error", "JWT login échoué", http_status=status or None, endpoint="/auth/jwt/login.json", details={"error": _extract_message(login_payload, raw)})
                return finalize()
            s.done("success", "JWT login réussi", http_status=status, endpoint="/auth/jwt/login.json")

            token_payload = self._extract_token_payload(gpg, login_payload)

            s = steps[15]; s.start()
            if token_payload.get("verify_token") != verify_token:
                s.done("error", "verify_token mismatch", details={"sent": verify_token, "received": token_payload.get("verify_token")})
                return finalize()
            access_token = token_payload.get("access_token") or token_payload.get("token")
            if not access_token:
                s.done("error", "Access token absent")
                return finalize()
            self._session.headers.update({"Authorization": f"Bearer {access_token}"})
            s.done("success", "verify_token validé")

            s = steps[16]; s.start()
            providers = token_payload.get("mfa_providers")
            if not providers:
                body = token_payload.get("body") if isinstance(token_payload.get("body"), dict) else {}
                providers = body.get("mfa_providers")
            if providers:
                s.done("success", "MFA requise", details={"providers": providers})
            else:
                s.done("success", "MFA non requise")

            s = steps[17]; s.start()
            try:
                mfa_result = self._verify_mfa_if_required(token_payload)
                if mfa_result == "not_required":
                    s.done("success", "MFA TOTP non exécutée (non requise)")
                else:
                    s.done("success", "MFA TOTP validée")
            except Exception as error:
                s.done("error", str(error), remediation="Configurer PASSBOLT_API_TOTP_SECRET et vérifier /mfa/verify/totp.json")
                return finalize()

            s = steps[18]; s.start()
            status, payload, raw, _ = self._request_json("GET", "/auth/is-authenticated.json")
            if status >= 400 or status == 0:
                s.done("error", "Session non authentifiée", http_status=status or None, endpoint="/auth/is-authenticated.json", details={"error": _extract_message(payload, raw)})
                return finalize()
            s.done("success", "Session authentifiée", http_status=status, endpoint="/auth/is-authenticated.json")

            s = steps[19]; s.start()
            status, payload, raw, _ = self._request_json("GET", "/groups.json")
            if status >= 400 or status == 0:
                s.done("error", "Accès /groups.json refusé", http_status=status or None, endpoint="/groups.json", details={"error": _extract_message(payload, raw)}, remediation="Vérifier permissions du compte API")
                return finalize()
            s.done("success", "/groups.json accessible", http_status=status, endpoint="/groups.json")

            s = steps[20]; s.start()
            status, payload, raw, _ = self._request_json("GET", "/healthcheck.json")
            if status in (401, 403):
                s.done("warning", "/healthcheck.json inaccessible pour ce rôle", http_status=status, endpoint="/healthcheck.json", details={"error": _extract_message(payload, raw)}, remediation="Utiliser un rôle administrateur si le healthcheck détaillé est requis")
            elif status >= 400 or status == 0:
                s.done("error", "/healthcheck.json inaccessible", http_status=status or None, endpoint="/healthcheck.json", details={"error": _extract_message(payload, raw)})
            else:
                s.done("success", "/healthcheck.json accessible", http_status=status, endpoint="/healthcheck.json")
        except Exception as error:
            for step in steps:
                if step.started_at and not step.finished_at:
                    step.done("error", str(error))
                    break
        return finalize()


class PassboltGroupService:
    def __init__(self, auth_service: PassboltApiAuthService) -> None:
        self.auth = auth_service

    def enabled(self) -> bool:
        return self.auth.enabled()

    def authenticate(self) -> dict[str, Any]:
        return self.auth.authenticate()

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> tuple[int, dict[str, Any], str]:
        status, data, raw, _ = self.auth._request_json(method, path, payload)
        return status, data, _extract_message(data, raw)

    @staticmethod
    def _extract_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
        body = payload.get("body") if isinstance(payload, dict) else None
        if isinstance(body, list):
            return [x for x in body if isinstance(x, dict)]
        if isinstance(body, dict):
            for key in ("items", "data", "groups", "users"):
                if isinstance(body.get(key), list):
                    return [x for x in body.get(key) if isinstance(x, dict)]
        for key in ("items", "data", "groups", "users"):
            if isinstance(payload.get(key), list):
                return [x for x in payload.get(key) if isinstance(x, dict)]
        return []

    def list_groups(self) -> dict[str, Any]:
        status, payload, message = self._request("GET", "/groups.json")
        groups = self._extract_items(payload)
        if status >= 400:
            return {"result": {"returncode": 1, "stderr": message, "stdout": ""}, "groups": set(), "items": []}
        return {"result": {"returncode": 0, "stderr": "", "stdout": "ok"}, "groups": {str(g.get("name") or "") for g in groups if g.get("name")}, "items": groups}

    def get_group_by_name(self, name: str) -> dict[str, Any] | None:
        status, payload, message = self._request("GET", f"/groups.json?filter[search]={quote(name)}")
        if status >= 400:
            raise RuntimeError(message or f"group lookup failed HTTP {status}")
        for item in self._extract_items(payload):
            if str(item.get("name") or "").strip().lower() == name.lower():
                return item
        return None

    def create_group(self, group_name: str) -> dict[str, Any]:
        status, _, message = self._request("POST", "/groups.json", {"name": group_name})
        return {"returncode": 0 if status < 300 else 1, "stdout": "created" if status < 300 else "", "stderr": "" if status < 300 else message}

    def find_user_by_email(self, email: str) -> dict[str, Any] | None:
        status, payload, message = self._request("GET", f"/users.json?filter[search]={quote(email)}")
        if status >= 400:
            raise RuntimeError(message or f"user lookup failed HTTP {status}")
        for item in self._extract_items(payload):
            if str(item.get("username") or item.get("email") or "").lower() == email.lower():
                return item
        return None

    def assign_user_to_group(self, user_id: str, group_id: str, is_admin: bool = False) -> dict[str, Any]:
        status, payload, message = self._request("GET", f"/groups/{group_id}.json")
        if status >= 400:
            return {"returncode": 1, "stdout": "", "stderr": message}
        body = payload.get("body") if isinstance(payload, dict) and isinstance(payload.get("body"), dict) else payload
        members = body.get("groups_users") if isinstance(body, dict) and isinstance(body.get("groups_users"), list) else []

        existing_member: dict[str, Any] | None = None
        for member in members:
            if isinstance(member, dict) and str(member.get("user_id")) == str(user_id):
                existing_member = member
                break

        if existing_member and not existing_member.get("delete"):
            return {"returncode": 0, "stdout": "already assigned", "stderr": ""}

        if existing_member and existing_member.get("delete"):
            existing_member["delete"] = False
            existing_member["is_admin"] = bool(is_admin)
        else:
            members.append({"user_id": user_id, "is_admin": bool(is_admin)})

        update_payload = {"name": body.get("name"), "groups_users": members}
        status, _, message = self._request("PUT", f"/groups/{group_id}.json", update_payload)
        return {"returncode": 0 if status < 300 else 1, "stdout": "assigned" if status < 300 else "", "stderr": "" if status < 300 else message}


class PassboltDeleteService:
    def __init__(self, auth_service: PassboltApiAuthService) -> None:
        self.auth = auth_service

    def enabled(self) -> bool:
        return self.auth.enabled()

    def authenticate(self) -> dict[str, Any]:
        return self.auth.authenticate()

    def _request(self, method: str, path: str) -> tuple[int, dict[str, Any], str]:
        status, payload, raw, _ = self.auth._request_json(method, path)
        return status, payload, _extract_message(payload, raw)

    @staticmethod
    def _extract_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
        body = payload.get("body") if isinstance(payload, dict) else None
        if isinstance(body, list):
            return [x for x in body if isinstance(x, dict)]
        if isinstance(body, dict):
            for key in ("items", "users", "data"):
                if isinstance(body.get(key), list):
                    return [x for x in body.get(key) if isinstance(x, dict)]
        for key in ("items", "users", "data"):
            if isinstance(payload.get(key), list):
                return [x for x in payload.get(key) if isinstance(x, dict)]
        return []

    def find_user_by_email(self, email: str) -> dict[str, Any] | None:
        status, payload, message = self._request("GET", f"/users.json?filter[search]={quote(email)}")
        if status >= 400:
            raise RuntimeError(message or f"lookup failed HTTP {status}")
        for item in self._extract_items(payload):
            username = str(item.get("username") or item.get("email") or "").lower()
            if username == email.lower():
                return item
        return None

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        status, payload, message = self._request("GET", f"/users/{user_id}.json")
        if status >= 400:
            raise RuntimeError(message or f"get user failed HTTP {status}")
        return payload.get("body") if isinstance(payload, dict) and isinstance(payload.get("body"), dict) else payload

    def _resolve_role(self, user_payload: dict[str, Any]) -> str:
        role = user_payload.get("role")
        if isinstance(role, dict):
            return str(role.get("name") or role.get("slug") or "unknown").lower()
        if isinstance(role, str):
            return role.lower()
        return str(user_payload.get("role_name") or user_payload.get("role_slug") or "unknown").lower()

    def _resolve_activation_state(self, user_payload: dict[str, Any], fallback: str | None = None) -> str:
        if user_payload.get("deleted") in (True, 1, "1"):
            return "deleted"
        if user_payload.get("disabled") in (True, 1, "1"):
            return "disabled"
        if user_payload.get("active") in (True, 1, "1"):
            return "active"
        if user_payload.get("active") in (False, 0, "0"):
            return "pending"
        return (fallback or "unknown").lower()

    def delete_user_dry_run(self, user_id: str) -> tuple[bool, str, dict[str, Any]]:
        status, payload, message = self._request("DELETE", f"/users/{user_id}/dry-run.json")
        return status < 300, parse_dry_run_message(payload, message), payload

    def delete_user(self, user_id: str) -> tuple[bool, str, dict[str, Any]]:
        status, payload, message = self._request("DELETE", f"/users/{user_id}.json")
        return status < 300, message, payload

    def delete_group_dry_run(self, group_id: str) -> tuple[bool, str, dict[str, Any]]:
        status, payload, message = self._request("DELETE", f"/groups/{group_id}/dry-run.json")
        return status < 300, parse_dry_run_message(payload, message), payload
