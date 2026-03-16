import csv
import io
import json
import os
import re
import shlex
import time
import uuid
from urllib.parse import urljoin
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from queue import Queue
from threading import Lock, Thread
from typing import Any

import docker
import gnupg
import pyotp
import requests
from flask import Flask, Response, jsonify, request, stream_with_context

from db import (
    create_import_batch,
    finalize_import_batch,
    get_batch,
    get_batch_users,
    get_db_summary,
    get_deletable_users_for_batch,
    get_last_import_batch,
    get_logs_summary,
    init_db,
    is_latest_batch,
    list_logs,
    list_import_batches,
    log_delete_event,
    purge_logs,
    save_log,
    save_imported_user,
    update_user_delete_state,
)

from passbolt_api import (
    PassboltApiAuthService as PassboltApiAuthServiceV2,
    PassboltDeleteService as PassboltDeleteServiceV2,
    PassboltGroupService as PassboltGroupServiceV2,
)

app = Flask(__name__)
init_db()


PASSBOLT_CONTAINER = os.getenv("PASSBOLT_CONTAINER", "passbolt-passbolt-1")
PASSBOLT_CLI_PATH = os.getenv("PASSBOLT_CLI_PATH", "/usr/share/php/passbolt/bin/cake")
IMPORT_COMMAND_TIMEOUT = int(os.getenv("IMPORT_COMMAND_TIMEOUT", "60"))
IMPORT_TOTAL_TIMEOUT = int(os.getenv("IMPORT_TOTAL_TIMEOUT", "60"))
ROLLBACK_COMMAND = os.getenv("PASSBOLT_ROLLBACK_COMMAND", "")
PASSBOLT_URL = os.getenv("PASSBOLT_URL", "").rstrip("/")
PASSBOLT_VERIFY_TLS = os.getenv("PASSBOLT_VERIFY_TLS", "true").lower() not in {"0", "false", "no"}
PASSBOLT_API_BASE_URL = os.getenv("PASSBOLT_API_BASE_URL", "").rstrip("/")
PASSBOLT_API_AUTH_MODE = (os.getenv("PASSBOLT_API_AUTH_MODE", "jwt") or "jwt").strip().lower()
PASSBOLT_API_USER_ID = os.getenv("PASSBOLT_API_USER_ID", "").strip()
PASSBOLT_API_PRIVATE_KEY_PATH = os.getenv("PASSBOLT_API_PRIVATE_KEY_PATH", "/app/keys/admin-private.asc").strip()
PASSBOLT_API_PASSPHRASE = os.getenv("PASSBOLT_API_PASSPHRASE", "")
PASSBOLT_API_VERIFY_TLS = os.getenv("PASSBOLT_API_VERIFY_TLS", str(PASSBOLT_VERIFY_TLS).lower()).lower() not in {"0", "false", "no"}
PASSBOLT_API_CA_BUNDLE = os.getenv("PASSBOLT_API_CA_BUNDLE", "").strip()
PASSBOLT_API_MFA_PROVIDER = (os.getenv("PASSBOLT_API_MFA_PROVIDER", "totp") or "totp").strip().lower()
PASSBOLT_API_TOTP_SECRET = os.getenv("PASSBOLT_API_TOTP_SECRET", "").strip()
PASSBOLT_API_TIMEOUT = int(os.getenv("PASSBOLT_API_TIMEOUT", "30"))
PASSBOLT_API_DEBUG = os.getenv("PASSBOLT_API_DEBUG", "false").lower() in {"1", "true", "yes"}

DELETE_ALLOWED_PENDING_STATES = {"pending", "unknown", "", None}
DELETE_ACTIVE_STATES = {"active", "activated", "setup_completed", "enabled"}

docker_client = docker.from_env()

SAFE_FIELD = re.compile(r"^[A-Za-z0-9@._+\-']+$")
SAFE_GROUP = re.compile(r"^[A-Za-z0-9 _@.\-']+$")
SAFE_ROLE = {"user", "admin"}
PENDING_ASSIGNMENTS: list[dict[str, Any]] = []
PENDING_LOCK = Lock()


def validate_startup_configuration() -> list[str]:
    required = {
        "PASSBOLT_API_BASE_URL": os.getenv("PASSBOLT_API_BASE_URL", "") or os.getenv("PASSBOLT_URL", ""),
        "PASSBOLT_API_USER_ID": os.getenv("PASSBOLT_API_USER_ID", ""),
        "PASSBOLT_API_PRIVATE_KEY_PATH": os.getenv("PASSBOLT_API_PRIVATE_KEY_PATH", ""),
        "PASSBOLT_API_PASSPHRASE": os.getenv("PASSBOLT_API_PASSPHRASE", ""),
    }
    issues: list[str] = []
    for key, value in required.items():
        if not value:
            issues.append(f"missing env: {key}")
    key_path = required.get("PASSBOLT_API_PRIVATE_KEY_PATH")
    if key_path and not os.path.exists(str(key_path)):
        issues.append(f"private key file not found: {key_path}")
    ca_bundle = os.getenv("PASSBOLT_API_CA_BUNDLE", "")
    if ca_bundle and not os.path.exists(ca_bundle):
        issues.append(f"CA bundle not found: {ca_bundle}")
    return issues


for _issue in validate_startup_configuration():
    print(f"[WARNING] Startup config validation: {_issue}")

def _sanitize_value(name: str, value: str) -> str:
    cleaned = (value or "").strip()
    if not cleaned:
        raise ValueError(f"{name} is empty")
    if not SAFE_FIELD.match(cleaned):
        raise ValueError(f"{name} contains invalid characters")
    return cleaned


def _sanitize_group_name(value: str) -> str:
    cleaned = (value or "").strip()
    if not cleaned:
        raise ValueError("group is empty")
    if not SAFE_GROUP.match(cleaned):
        raise ValueError("group contains invalid characters")
    return cleaned


def _sanitize_role(value: str) -> str:
    role = (value or "").strip().lower()
    if role not in SAFE_ROLE:
        raise ValueError("role must be user or admin")
    return role


def _decode_output(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace").strip()
    return str(value).strip()


def _list_container_names() -> list[str]:
    containers = docker_client.containers.list()
    return [container.name for container in containers]


def _detect_container() -> str:
    try:
        names = _list_container_names()
    except Exception:
        return PASSBOLT_CONTAINER

    if PASSBOLT_CONTAINER in names:
        return PASSBOLT_CONTAINER

    candidates = [n for n in names if "passbolt" in n and "db" not in n and "traefik" not in n]
    return candidates[0] if candidates else PASSBOLT_CONTAINER


def _detect_cli_path(container_name: str) -> str:
    candidates = [
        PASSBOLT_CLI_PATH,
        "/usr/share/php/passbolt/bin/cake",
        "/var/www/passbolt/bin/cake",
    ]
    try:
        container = docker_client.containers.get(container_name)
    except Exception:
        return PASSBOLT_CLI_PATH

    for path in candidates:
        try:
            exec_result = container.exec_run(["test", "-x", path], stdout=False, stderr=False)
            if exec_result.exit_code == 0:
                return path
        except Exception:
            continue
    return PASSBOLT_CLI_PATH


def diagnose_environment() -> dict[str, Any]:
    diagnostics: dict[str, Any] = {
        "configured_container": PASSBOLT_CONTAINER,
        "configured_cli_path": PASSBOLT_CLI_PATH,
        "checks": [],
        "recommendations": [],
    }

    try:
        names = _list_container_names()
        diagnostics["checks"].append(
            {
                "name": "docker_sdk",
                "ok": True,
                "visible_containers": len(names),
                "containers": names,
            }
        )

        resolved_container = PASSBOLT_CONTAINER if PASSBOLT_CONTAINER in names else _detect_container()
        container_found = resolved_container in names
        diagnostics["resolved_container"] = resolved_container
        diagnostics["checks"].append(
            {
                "name": "container_selection",
                "ok": container_found,
                "selected": resolved_container,
                "auto_selected": resolved_container != PASSBOLT_CONTAINER,
            }
        )

        if not container_found:
            diagnostics["recommendations"].append("Le conteneur Passbolt cible est introuvable")
            diagnostics["resolved_cli_path"] = PASSBOLT_CLI_PATH
            diagnostics["checks"].append({"name": "cli_path_check", "ok": False, "selected": PASSBOLT_CLI_PATH})
            return diagnostics

        resolved_cli_path = _detect_cli_path(resolved_container)
        cli_found = resolved_cli_path != ""
        diagnostics["resolved_cli_path"] = resolved_cli_path
        diagnostics["checks"].append(
            {
                "name": "cli_path_check",
                "ok": cli_found,
                "selected": resolved_cli_path,
                "auto_selected": resolved_cli_path != PASSBOLT_CLI_PATH,
            }
        )

        if resolved_cli_path != PASSBOLT_CLI_PATH:
            diagnostics["recommendations"].append(
                f"PATH CLI ajusté automatiquement vers {resolved_cli_path}"
            )

    except Exception as error:
        diagnostics["checks"].append(
            {
                "name": "docker_sdk",
                "ok": False,
                "stderr": f"docker sdk error: {error}",
            }
        )
        diagnostics["resolved_container"] = PASSBOLT_CONTAINER
        diagnostics["resolved_cli_path"] = PASSBOLT_CLI_PATH
        diagnostics["recommendations"].append("Erreur pendant l'auto-diagnostic")

    return diagnostics


def _run_shell_command(container_name: str, cli_path: str, shell_command: str) -> dict[str, Any]:
    command = ["su", "-m", "-c", shell_command, "-s", "/bin/sh", "www-data"]
    command_str = (
        f"docker-sdk exec {shlex.quote(container_name)} -- "
        f"su -m -c {shlex.quote(shell_command)} -s /bin/sh www-data"
    )

    try:
        container = docker_client.containers.get(container_name)

        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(
                container.exec_run,
                command,
                demux=True,
                tty=False,
                stdout=True,
                stderr=True,
            )
            try:
                run = future.result(timeout=IMPORT_COMMAND_TIMEOUT)
            except TimeoutError:
                return {
                    "returncode": -2,
                    "stdout": "",
                    "stderr": f"command timeout after {IMPORT_COMMAND_TIMEOUT}s",
                    "command": command_str,
                }

        stdout, stderr = run.output if isinstance(run.output, tuple) else (run.output, b"")
        return {
            "returncode": run.exit_code,
            "stdout": _decode_output(stdout),
            "stderr": _decode_output(stderr),
            "command": command_str,
        }
    except Exception as error:
        return {
            "returncode": -3,
            "stdout": "",
            "stderr": f"unexpected execution error: {error}",
            "command": command_str,
        }


def parse_groups(raw_value: str) -> list[str]:
    unique_groups: list[str] = []
    seen: set[str] = set()
    for item in (raw_value or "").split(";"):
        cleaned = item.strip()
        if not cleaned:
            continue
        lowered = cleaned.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        unique_groups.append(cleaned)
    return unique_groups


def parse_csv_rows(file_storage: Any) -> tuple[list[dict[str, Any]], Any]:
    if not file_storage:
        return [], (jsonify({"error": "missing file field"}), 400)

    if not file_storage.filename or not file_storage.filename.lower().endswith(".csv"):
        return [], (jsonify({"error": "please upload a .csv file"}), 400)

    decoded = file_storage.read().decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(decoded))

    required = {"email", "firstname", "lastname", "role"}
    normalized_headers = {h.strip().lower() for h in (reader.fieldnames or []) if h}
    if not required.issubset(normalized_headers):
        return [], (jsonify({"error": "csv headers must include email, firstname, lastname, role"}), 400)

    rows: list[dict[str, Any]] = []
    for raw_row in reader:
        normalized: dict[str, Any] = {}
        for key, value in raw_row.items():
            normalized[(key or "").strip().lower()] = (value or "").strip()
        normalized["groups"] = parse_groups(normalized.get("groups", ""))
        rows.append(normalized)
    return rows, None


def preview_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    preview: list[dict[str, Any]] = []
    valid_count = 0

    for idx, row in enumerate(rows, start=1):
        errors: list[str] = []

        for field in ("email", "firstname", "lastname"):
            if not (row.get(field) or "").strip():
                errors.append(f"{field} is empty")

        role = (row.get("role") or "").strip().lower()
        if role not in SAFE_ROLE:
            errors.append("role must be user or admin")

        groups = row.get("groups", [])
        safe_groups: list[str] = []
        for group in groups:
            try:
                safe_groups.append(_sanitize_group_name(group))
            except ValueError as error:
                errors.append(str(error))

        valid = len(errors) == 0
        if valid:
            valid_count += 1

        preview.append(
            {
                "line": idx,
                "email": row.get("email", ""),
                "firstname": row.get("firstname", ""),
                "lastname": row.get("lastname", ""),
                "role": row.get("role", ""),
                "groups": safe_groups,
                "valid": valid,
                "errors": errors,
            }
        )

    return {
        "total_rows": len(rows),
        "valid_rows": valid_count,
        "invalid_rows": len(rows) - valid_count,
        "rows": preview,
    }


def create_user(email: str, first: str, last: str, role: str, container_name: str, cli_path: str) -> dict[str, Any]:
    email = _sanitize_value("email", email)
    first = _sanitize_value("firstname", first)
    last = _sanitize_value("lastname", last)
    role = _sanitize_role(role)

    shell_command = (
        f"{shlex.quote(cli_path)} passbolt register_user "
        f"-u {shlex.quote(email)} "
        f"-f {shlex.quote(first)} "
        f"-l {shlex.quote(last)} "
        f"-r {shlex.quote(role)}"
    )
    result = _run_shell_command(container_name, cli_path, shell_command)
    result["email"] = email
    return result


class PassboltGroupService:
    def __init__(self, auth_service: "PassboltApiAuthService") -> None:
        self.auth = auth_service
        self.session = auth_service._session
        self.base_url = auth_service.base_url

    def enabled(self) -> bool:
        return self.auth.enabled()

    def authenticate(self) -> dict[str, Any]:
        return self.auth.authenticate()

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> tuple[int, dict[str, Any], str]:
        try:
            response = self.session.request(
                method,
                f"{self.base_url}{path}",
                json=payload,
                timeout=self.auth.timeout,
                verify=self.auth.verify_setting,
                headers={"Accept": "application/json", "Content-Type": "application/json", **dict(self.session.headers)},
            )
            data: dict[str, Any] = {}
            try:
                data = response.json() if response.text else {}
            except Exception:
                data = {}
            message = ""
            if isinstance(data, dict):
                message = str(data.get("message") or data.get("error") or "")
            if not message:
                message = response.text.strip()[:500]
            return response.status_code, data, message
        except requests.RequestException as error:
            return 502, {}, _classify_request_error(error)

    def _extract_items(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        if isinstance(payload, dict):
            body = payload.get("body")
            if isinstance(body, list):
                return [x for x in body if isinstance(x, dict)]
            if isinstance(body, dict):
                for key in ("items", "data", "groups", "users"):
                    value = body.get(key)
                    if isinstance(value, list):
                        return [x for x in value if isinstance(x, dict)]
            for key in ("items", "data", "groups", "users"):
                value = payload.get(key)
                if isinstance(value, list):
                    return [x for x in value if isinstance(x, dict)]
        return []

    def list_groups(self) -> dict[str, Any]:
        status, payload, message = self._request("GET", "/groups.json")
        groups = self._extract_items(payload)
        if status >= 400:
            return {"result": {"returncode": 1, "stderr": message, "stdout": ""}, "groups": set(), "items": []}
        names = set()
        for item in groups:
            name = str(item.get("name") or "").strip()
            if name:
                names.add(name)
        return {"result": {"returncode": 0, "stderr": "", "stdout": "ok"}, "groups": names, "items": groups}

    def get_group_by_name(self, name: str) -> dict[str, Any] | None:
        group_name = _sanitize_group_name(name)
        status, payload, message = self._request("GET", f"/groups.json?filter[search]={requests.utils.quote(group_name)}")
        if status >= 400:
            raise RuntimeError(message or f"group lookup failed HTTP {status}")
        for item in self._extract_items(payload):
            if str(item.get("name") or "").strip().lower() == group_name.lower():
                return item
        return None

    def create_group(self, group_name: str) -> dict[str, Any]:
        cleaned = _sanitize_group_name(group_name)
        status, _, message = self._request("POST", "/groups.json", {"name": cleaned})
        if status < 300:
            return {"returncode": 0, "stdout": "created", "stderr": ""}
        return {"returncode": 1, "stdout": "", "stderr": message or "creation failed"}

    def find_user_by_email(self, email: str) -> dict[str, Any] | None:
        address = _sanitize_value("email", email).lower()
        status, payload, message = self._request("GET", f"/users.json?filter[search]={requests.utils.quote(address)}")
        if status >= 400:
            raise RuntimeError(message or f"user lookup failed HTTP {status}")
        for item in self._extract_items(payload):
            username = str(item.get("username") or item.get("email") or "").lower()
            if username == address:
                return item
        return None

    def assign_user_to_group(self, user_id: str, group_id: str) -> dict[str, Any]:
        payload = {"user_id": user_id}
        status, _, message = self._request("POST", f"/groups/{group_id}/users.json", payload)
        if status < 300:
            return {"returncode": 0, "stdout": "assigned", "stderr": ""}
        return {"returncode": 1, "stdout": "", "stderr": message or "assignment failed"}


def _extract_activation_link(stdout: str) -> str | None:
    match = re.search(r"https?://\S+", stdout or "")
    return match.group(0) if match else None


def _critical_error(result: dict[str, Any]) -> bool:
    stderr = (result.get("stderr") or "").lower()
    return result.get("returncode", 1) not in (0,) and "already" not in stderr and "exists" not in stderr


def _append_pending(entry: dict[str, Any]) -> None:
    with PENDING_LOCK:
        PENDING_ASSIGNMENTS.append(entry)




def _emit_structured(emit: Any, level: str, code: str, message: str, **extra: Any) -> None:
    save_log(
        scope="import",
        level=level,
        event_code=code,
        message=message,
        batch_uuid=(extra.get("batch_uuid") or None),
        email=(extra.get("email") or None),
        row_number=extra.get("row"),
        payload=extra or None,
    )
    if not emit:
        return
    payload = {"level": level, "code": code, "message": message, **extra}
    emit({"type": "audit", "payload": payload})


def _save_live_log(scope: str, level: str, message: str, **extra: Any) -> None:
    save_log(
        scope=scope,
        level=level,
        message=message,
        event_code=extra.get("event_code"),
        batch_uuid=extra.get("batch_uuid"),
        email=extra.get("email"),
        row_number=extra.get("row_number"),
        payload=extra.get("payload"),
    )


def _logs_filters_from_request() -> tuple[str | None, str | None, str | None]:
    batch_uuid = (request.args.get("batch_uuid") or "").strip() or None
    scope = (request.args.get("scope") or "").strip() or None
    level = (request.args.get("level") or "").strip() or None
    return batch_uuid, scope, level


def _resolve_batch_status(import_status: str, success_count: int, error_count: int) -> str:
    if import_status == "success" and error_count == 0:
        return "completed"
    if success_count > 0 and error_count > 0:
        return "partial"
    if success_count > 0 and error_count == 0:
        return "completed"
    return "failed"

def rollback_batch(created_users: list[str], container: str, cli_path: str) -> dict[str, Any]:
    if not created_users:
        return {"status": "no-op", "rolled_back": [], "manual_required": False}

    if not ROLLBACK_COMMAND:
        return {
            "status": "manual-required",
            "rolled_back": [],
            "manual_required": True,
            "message": "rollback command not configured",
            "users": created_users,
        }

    rolled_back: list[str] = []
    errors: list[dict[str, str]] = []
    for email in created_users:
        shell_command = f"{shlex.quote(cli_path)} {ROLLBACK_COMMAND.format(email=shlex.quote(email))}"
        result = _run_shell_command(container, cli_path, shell_command)
        if result.get("returncode") == 0:
            rolled_back.append(email)
        else:
            errors.append({"email": email, "error": result.get("stderr", "rollback failed")})

    return {
        "status": "done" if not errors else "partial",
        "rolled_back": rolled_back,
        "manual_required": bool(errors),
        "errors": errors,
    }

def generate_totp_code(secret: str) -> str:
    cleaned = (secret or "").replace(" ", "")
    if not cleaned:
        raise RuntimeError("PASSBOLT_API_TOTP_SECRET is required for MFA TOTP")
    return pyotp.TOTP(cleaned).now()


def get_requests_verify_value() -> bool | str:
    if PASSBOLT_API_CA_BUNDLE and os.path.exists(PASSBOLT_API_CA_BUNDLE):
        return PASSBOLT_API_CA_BUNDLE
    if not PASSBOLT_API_VERIFY_TLS:
        return False
    return True


def get_tls_diagnostics() -> dict[str, Any]:
    ca_bundle_configured = bool(PASSBOLT_API_CA_BUNDLE)
    ca_bundle_exists = bool(PASSBOLT_API_CA_BUNDLE and os.path.exists(PASSBOLT_API_CA_BUNDLE))
    verify_value = get_requests_verify_value()
    verify_mode: str | bool
    if isinstance(verify_value, str):
        verify_mode = verify_value
    elif verify_value is False:
        verify_mode = "TLS verification disabled (debug mode)"
    else:
        verify_mode = "system"
    return {
        "ca_bundle_configured": ca_bundle_configured,
        "ca_bundle_exists": ca_bundle_exists,
        "verify_mode": verify_mode,
        "verify_value": verify_value,
    }


def _classify_request_error(error: Exception) -> str:
    raw = str(error)
    lowered = raw.lower()
    tls = get_tls_diagnostics()
    if "certificate verify failed" in lowered or "unable to get local issuer certificate" in lowered:
        if isinstance(tls["verify_value"], str):
            return f"TLS certificate validation failed (CA bundle: {tls['verify_value']}): {raw}"
        if tls["verify_value"] is True:
            return "TLS certificate validation failed. Configure PASSBOLT_API_CA_BUNDLE with the issuer CA chain or use a publicly trusted certificate."
        return f"TLS certificate validation failed while verification is disabled (debug mode): {raw}"
    return raw


class PassboltApiAuthService:
    def __init__(self) -> None:
        self.base_url = PASSBOLT_API_BASE_URL or PASSBOLT_URL
        self.auth_mode = PASSBOLT_API_AUTH_MODE
        self.user_id = PASSBOLT_API_USER_ID
        self.private_key_path = PASSBOLT_API_PRIVATE_KEY_PATH
        self.passphrase = PASSBOLT_API_PASSPHRASE
        self.verify_tls = PASSBOLT_API_VERIFY_TLS
        self.ca_bundle = PASSBOLT_API_CA_BUNDLE
        self.verify_setting = get_requests_verify_value()
        self.mfa_provider = PASSBOLT_API_MFA_PROVIDER
        self.totp_secret = PASSBOLT_API_TOTP_SECRET
        self.timeout = PASSBOLT_API_TIMEOUT
        self.debug = PASSBOLT_API_DEBUG
        self._session = requests.Session()
        self._server_fingerprint: str | None = None
        self._tokens: dict[str, Any] = {}

    def config_status(self) -> dict[str, Any]:
        tls = get_tls_diagnostics()
        checks = {
            "base_url": bool(self.base_url),
            "auth_mode": self.auth_mode == "jwt",
            "user_id": bool(self.user_id),
            "private_key_path": bool(self.private_key_path),
            "private_key_exists": bool(self.private_key_path and os.path.exists(self.private_key_path)),
            "passphrase": bool(self.passphrase),
            "mfa_provider": self.mfa_provider == "totp",
            "totp_secret": bool(self.totp_secret),
            "ca_bundle_configured": tls["ca_bundle_configured"],
            "ca_bundle_exists": tls["ca_bundle_exists"],
        }
        base_config_ok = all(checks[name] for name in (
            "base_url",
            "auth_mode",
            "user_id",
            "private_key_path",
            "private_key_exists",
            "passphrase",
            "mfa_provider",
            "totp_secret",
        ))
        tls_ok = checks["ca_bundle_exists"] or (not checks["ca_bundle_configured"] and self.verify_setting is not False) or (self.verify_setting is False)
        configured = base_config_ok and tls_ok
        missing = [name for name, ok in checks.items() if not ok]
        message = "Passbolt delete API is fully configured" if configured else (
            "Configuration incomplète: " + ", ".join(missing)
        )
        if self.verify_setting is False:
            message = f"{message}. TLS verification disabled (debug mode)"
        elif checks["ca_bundle_configured"] and not checks["ca_bundle_exists"]:
            message = f"{message}. CA bundle file not found: {self.ca_bundle}"

        return {
            "configured": configured,
            "checks": checks,
            "tls": {
                "verify_mode": tls["verify_mode"],
            },
            "message": message,
            "auth_mode_value": self.auth_mode,
            "private_key_path_value": self.private_key_path,
            "mfa_provider_value": self.mfa_provider,
            "verify_tls_value": self.verify_tls,
            "ca_bundle_path_value": self.ca_bundle,
            "timeout": self.timeout,
        }

    def enabled(self) -> bool:
        return bool(self.config_status().get("configured"))

    def _log_auth_event(self, level: str, message: str, **payload: Any) -> None:
        _save_live_log("auth", level, message, event_code="auth.debug", payload=payload or None)

    @staticmethod
    def _looks_like_pgp_public_key(value: Any) -> bool:
        return isinstance(value, str) and "BEGIN PGP PUBLIC KEY BLOCK" in value

    def _extract_server_public_key_from_payload(self, payload: dict[str, Any]) -> str | None:
        candidates: list[Any] = [payload, payload.get("body") if isinstance(payload, dict) else None]
        for candidate in candidates:
            if isinstance(candidate, dict):
                fingerprint = candidate.get("fingerprint")
                if isinstance(fingerprint, str) and fingerprint:
                    self._server_fingerprint = fingerprint
                for key in ("keydata", "public_key", "server_public_key", "armored_key", "key"):
                    value = candidate.get(key)
                    if self._looks_like_pgp_public_key(value):
                        self._log_auth_event("info", "Server public key found inline in /auth/verify.json payload", source_key=key)
                        return value
        return None

    def _download_server_public_key(self, pubkey_url: str) -> str | None:
        self._log_auth_event("info", "Downloading server public key from URL", strategy="header_pubkey_url", pubkey_url=pubkey_url)
        try:
            pubkey_response = self._session.get(
                pubkey_url,
                timeout=self.timeout,
                verify=self.verify_setting,
                headers={"Accept": "text/plain, application/pgp-keys, application/octet-stream"},
            )
        except requests.RequestException as error:
            message = _classify_request_error(error)
            self._log_auth_event("error", "Failed to download server public key from header URL", strategy="header_pubkey_url", pubkey_url=pubkey_url, error=message)
            raise RuntimeError(f"Unable to download Passbolt server public key from {pubkey_url}: {message}") from error

        self._log_auth_event("info", "Server public key URL response received", strategy="header_pubkey_url", pubkey_url=pubkey_url, status_code=pubkey_response.status_code)
        if pubkey_response.status_code >= 400:
            body = (pubkey_response.text or "")[:500]
            self._log_auth_event("error", "Server public key URL returned an error", strategy="header_pubkey_url", pubkey_url=pubkey_url, status_code=pubkey_response.status_code, body=body)
            return None

        pubkey_text = (pubkey_response.text or "").strip()
        if self._looks_like_pgp_public_key(pubkey_text):
            self._log_auth_event("info", "Server public key downloaded successfully", strategy="header_pubkey_url", pubkey_url=pubkey_url, key_size=len(pubkey_text))
            return pubkey_text

        self._log_auth_event("error", "Downloaded server public key does not contain an armored PGP key", strategy="header_pubkey_url", pubkey_url=pubkey_url, key_size=len(pubkey_text))
        return None

    def _request_json(self, method: str, path: str, json_payload: dict[str, Any] | None = None) -> tuple[int, dict[str, Any], str]:
        response = self._session.request(
            method,
            f"{self.base_url}{path}",
            json=json_payload,
            timeout=self.timeout,
            verify=self.verify_setting,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
        )
        data: dict[str, Any] = {}
        try:
            data = response.json() if response.text else {}
        except Exception:
            data = {}
        return response.status_code, data, response.text[:500]

    def _fetch_server_public_key(self) -> str:
        verify_url = f"{self.base_url}/auth/verify.json"
        self._log_auth_event("info", "Calling Passbolt auth verify endpoint", url=verify_url)

        try:
            response = self._session.get(
                verify_url,
                timeout=self.timeout,
                verify=self.verify_setting,
                headers={"Accept": "application/json"},
            )
        except requests.RequestException as error:
            message = _classify_request_error(error)
            self._log_auth_event("error", "Failed to call /auth/verify.json", error=message)
            raise RuntimeError(f"Unable to call /auth/verify.json: {message}") from error

        self._log_auth_event("info", "Received /auth/verify.json response", status_code=response.status_code)

        payload: dict[str, Any] = {}
        try:
            payload = response.json() if response.text else {}
        except Exception as error:
            self._log_auth_event("error", "Unable to parse /auth/verify.json response", error=str(error), raw_body=(response.text or "")[:500])
            payload = {}

        if response.status_code >= 400:
            error_msg = (response.text or "")[:500]
            self._log_auth_event("error", "Passbolt /auth/verify.json returned an error", status_code=response.status_code, body=error_msg)
            raise RuntimeError(error_msg or f"Unable to call /auth/verify.json HTTP {response.status_code}")

        body_payload = payload.get("body") if isinstance(payload, dict) and isinstance(payload.get("body"), dict) else {}
        fingerprint_present = bool(body_payload.get("fingerprint") or payload.get("fingerprint"))
        keydata_value = body_payload.get("keydata") if isinstance(body_payload, dict) else None
        keydata_present = self._looks_like_pgp_public_key(keydata_value)
        useful_headers = {
            "x-gpgauth-pubkey-url": response.headers.get("x-gpgauth-pubkey-url"),
            "x-gpgauth-pubkey": response.headers.get("X-GPGAuth-Pubkey"),
        }
        self._log_auth_event(
            "info",
            "Inspecting /auth/verify.json response for server public key",
            status_code=response.status_code,
            headers=useful_headers,
            fingerprint_present=fingerprint_present,
            keydata_present=keydata_present,
        )

        inline_pubkey = self._extract_server_public_key_from_payload(payload)
        if inline_pubkey:
            self._log_auth_event("info", "Using inline server public key from /auth/verify.json", strategy="inline_keydata", key_size=len(inline_pubkey))
            return inline_pubkey

        pubkey_header_url = (response.headers.get("x-gpgauth-pubkey-url") or response.headers.get("X-GPGAuth-Pubkey") or "").strip()
        self._log_auth_event(
            "info",
            "Checked verify headers for server public key URL",
            x_gpgauth_pubkey_url=response.headers.get("x-gpgauth-pubkey-url"),
            x_gpgauth_pubkey=response.headers.get("X-GPGAuth-Pubkey"),
            header_url_present=bool(pubkey_header_url),
        )

        if pubkey_header_url:
            pubkey_url = urljoin(f"{self.base_url}/", pubkey_header_url)
            downloaded_key = self._download_server_public_key(pubkey_url)
            if downloaded_key:
                return downloaded_key

        self._log_auth_event("error", "Unable to locate Passbolt server public key in verify header or payload", payload_keys=list(payload.keys()) if isinstance(payload, dict) else [])
        raise RuntimeError("Unable to retrieve Passbolt server public key after verify payload and header URL fallback attempts")

    def _get_gpg(self) -> gnupg.GPG:
        gpg = gnupg.GPG(gnupghome="/tmp/gnupg-api")
        if not self.private_key_path or not os.path.exists(self.private_key_path):
            raise RuntimeError(f"Private key file not found: {self.private_key_path}")
        with open(self.private_key_path, "r", encoding="utf-8") as key_file:
            import_result = gpg.import_keys(key_file.read())
        if not import_result.fingerprints:
            raise RuntimeError("Failed to import API private key")
        return gpg

    def _encrypt_for_server(self, gpg: gnupg.GPG, challenge_json: str, server_public_key: str) -> str:
        import_result = gpg.import_keys(server_public_key)
        if not import_result.fingerprints:
            self._log_auth_event("error", "Failed to import Passbolt server public key", import_results=str(import_result.results))
            raise RuntimeError("Failed to import Passbolt server public key")
        recipient = import_result.fingerprints[0]
        self._log_auth_event("info", "Passbolt server public key imported", fingerprint=recipient)
        encrypted = gpg.encrypt(challenge_json, recipients=[recipient], always_trust=True)
        if not encrypted.ok:
            self._log_auth_event("error", "Unable to encrypt challenge for server", status=str(encrypted.status))
            raise RuntimeError(f"Unable to encrypt challenge for server: {encrypted.status}")
        return str(encrypted)

    def _decrypt_payload(self, gpg: gnupg.GPG, armored_payload: str) -> str:
        decrypted = gpg.decrypt(armored_payload, passphrase=self.passphrase)
        if not decrypted.ok:
            raise RuntimeError(f"Unable to decrypt JWT login payload: {decrypted.status}")
        return str(decrypted)

    def _extract_challenge(self, payload: dict[str, Any]) -> tuple[str, str]:
        body = payload.get("body") if isinstance(payload, dict) else None
        source = body if isinstance(body, dict) else payload
        challenge = (source or {}).get("challenge") or (source or {}).get("challenge_token")
        challenge_id = (source or {}).get("challenge_id") or (source or {}).get("id")
        if not challenge:
            raise RuntimeError("JWT challenge missing in response")
        return str(challenge), str(challenge_id or "")

    def _verify_mfa_if_required(self, login_payload: dict[str, Any]) -> None:
        providers = None
        if isinstance(login_payload, dict):
            providers = login_payload.get("mfa_providers")
            body = login_payload.get("body")
            if not providers and isinstance(body, dict):
                providers = body.get("mfa_providers")
        if not providers:
            return
        if self.mfa_provider != "totp":
            raise RuntimeError(f"Unsupported MFA provider: {self.mfa_provider}")
        if "totp" not in [str(p).lower() for p in providers]:
            raise RuntimeError("Passbolt requires MFA but TOTP provider is unavailable")
        code = generate_totp_code(self.totp_secret)
        status, payload, raw = self._request_json("POST", "/mfa/verify/totp.json", {"totp": code})
        if status >= 400:
            message = payload.get("message") if isinstance(payload, dict) else ""
            raise RuntimeError(message or raw or f"MFA verify failed HTTP {status}")

    def authenticate(self) -> dict[str, Any]:
        if self.auth_mode != "jwt":
            raise RuntimeError("Only PASSBOLT_API_AUTH_MODE=jwt is supported")
        if not self.enabled():
            raise RuntimeError("Passbolt delete API is not configured")

        server_public_key = self._fetch_server_public_key()

        status, challenge_payload, raw = self._request_json("GET", f"/auth/jwt/rsa-challenge.json?user_id={requests.utils.quote(self.user_id)}")
        if status >= 400:
            raise RuntimeError(raw or f"Unable to request JWT challenge HTTP {status}")
        challenge, challenge_id = self._extract_challenge(challenge_payload)

        gpg = self._get_gpg()
        signed = gpg.sign(challenge, clearsign=False, detach=True, passphrase=self.passphrase)
        if not signed:
            raise RuntimeError("Unable to sign JWT challenge with API private key")

        challenge_document = {
            "version": "1.0.0",
            "domain": self.base_url,
            "verify_token": challenge,
            "verify_token_signature": str(signed),
            "user_id": self.user_id,
        }
        if challenge_id:
            challenge_document["challenge_id"] = challenge_id

        try:
            encrypted_challenge = self._encrypt_for_server(gpg, json.dumps(challenge_document), server_public_key)
            self._log_auth_event("info", "Challenge encrypted with Passbolt server public key")
        except Exception as error:
            self._log_auth_event("error", "Failed to encrypt challenge with Passbolt server public key", error=str(error))
            raise
        login_body = {"challenge": encrypted_challenge, "user_id": self.user_id}
        if challenge_id:
            login_body["challenge_id"] = challenge_id

        status, login_payload, raw = self._request_json("POST", "/auth/jwt/login.json", login_body)
        if status >= 400:
            message = login_payload.get("message") if isinstance(login_payload, dict) else ""
            raise RuntimeError(message or raw or f"JWT login failed HTTP {status}")

        decrypted_json = ""
        encrypted_response = login_payload.get("body") if isinstance(login_payload, dict) else None
        if isinstance(encrypted_response, str) and "BEGIN PGP MESSAGE" in encrypted_response:
            decrypted_json = self._decrypt_payload(gpg, encrypted_response)
        elif isinstance(login_payload.get("body"), dict):
            decrypted_json = json.dumps(login_payload.get("body"))
        else:
            decrypted_json = json.dumps(login_payload)

        try:
            token_payload = json.loads(decrypted_json)
        except Exception as error:
            raise RuntimeError(f"Unable to parse JWT login payload: {error}") from error

        self._tokens["access_token"] = token_payload.get("access_token") or token_payload.get("token")
        self._tokens["refresh_token"] = token_payload.get("refresh_token")
        if not self._tokens.get("access_token"):
            raise RuntimeError("Missing access_token after JWT login")

        self._session.headers.update({"Authorization": f"Bearer {self._tokens['access_token']}"})
        self._verify_mfa_if_required(token_payload)
        return {"access_token": self._tokens.get("access_token"), "refresh_token": self._tokens.get("refresh_token")}


class PassboltDeleteService:
    def __init__(self, auth_service: PassboltApiAuthService) -> None:
        self.auth = auth_service
        self.session = auth_service._session
        self.base_url = auth_service.base_url

    def enabled(self) -> bool:
        return self.auth.enabled()

    def authenticate(self) -> dict[str, Any]:
        return self.auth.authenticate()

    def _request(self, method: str, path: str) -> tuple[int, dict[str, Any], str]:
        try:
            response = self.session.request(
                method,
                f"{self.base_url}{path}",
                timeout=self.auth.timeout,
                verify=self.auth.verify_setting,
                headers={"Accept": "application/json", "Content-Type": "application/json", **dict(self.session.headers)},
            )
            payload: dict[str, Any] = {}
            try:
                payload = response.json() if response.text else {}
            except Exception:
                payload = {}
            message = ""
            if isinstance(payload, dict):
                message = str(payload.get("message") or payload.get("error") or "")
                body = payload.get("body")
                if not message and isinstance(body, dict):
                    message = str(body.get("message") or body.get("error") or "")
            if not message:
                message = response.text.strip()[:500]
            return response.status_code, payload, message
        except requests.RequestException as error:
            return 502, {}, _classify_request_error(error)

    def _extract_items(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        if isinstance(payload, list):
            return [x for x in payload if isinstance(x, dict)]
        if not isinstance(payload, dict):
            return []
        body = payload.get("body")
        if isinstance(body, list):
            return [x for x in body if isinstance(x, dict)]
        if isinstance(body, dict):
            for key in ("items", "users", "data"):
                value = body.get(key)
                if isinstance(value, list):
                    return [x for x in value if isinstance(x, dict)]
        for key in ("items", "users", "data"):
            value = payload.get(key)
            if isinstance(value, list):
                return [x for x in value if isinstance(x, dict)]
        return []

    def find_user_by_email(self, email: str) -> dict[str, Any] | None:
        status, payload, message = self._request("GET", f"/users.json?filter[search]={requests.utils.quote(email)}")
        if status >= 400:
            raise RuntimeError(message or f"lookup failed HTTP {status}")
        for item in self._extract_items(payload):
            username = (item.get("username") or item.get("email") or "").lower()
            if username == email.lower():
                return item
        return None

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        status, payload, message = self._request("GET", f"/users/{user_id}.json")
        if status >= 400:
            raise RuntimeError(message or f"get user failed HTTP {status}")
        body = payload.get("body") if isinstance(payload, dict) else None
        if isinstance(body, dict):
            return body
        return payload if isinstance(payload, dict) else None

    def _resolve_role(self, user_payload: dict[str, Any]) -> str:
        role = user_payload.get("role")
        if isinstance(role, dict):
            role_name = (role.get("name") or role.get("slug") or "").lower()
            if role_name:
                return role_name
        if isinstance(role, str):
            return role.lower()
        for key in ("role_name", "role_slug", "actual_role"):
            value = user_payload.get(key)
            if isinstance(value, str) and value:
                return value.lower()
        return "unknown"

    def _resolve_activation_state(self, user_payload: dict[str, Any], fallback: str | None = None) -> str:
        disabled = user_payload.get("disabled")
        active = user_payload.get("active")
        deleted = user_payload.get("deleted")
        if deleted in (True, 1, "1"):
            return "deleted"
        if disabled in (True, 1, "1"):
            return "disabled"
        if active in (True, 1, "1"):
            return "active"
        if active in (False, 0, "0"):
            return "pending"
        if fallback in DELETE_ACTIVE_STATES:
            return str(fallback)
        return (fallback or "unknown").lower()

    def delete_user_dry_run(self, user_id: str) -> tuple[bool, str, dict[str, Any]]:
        status, payload, message = self._request("DELETE", f"/users/{user_id}/dry-run.json")
        return status < 300, message, payload

    def delete_user(self, user_id: str) -> tuple[bool, str, dict[str, Any]]:
        status, payload, message = self._request("DELETE", f"/users/{user_id}.json")
        return status < 300, message, payload


def _build_delete_result(
    email: str,
    batch_uuid: str,
    status: str,
    message: str = "",
    found: bool = False,
    user_id: str = "",
    actual_role: str = "",
    activation_state: str = "",
    requested_role: str = "",
    eligible: bool = False,
    exclusion_reason: str = "",
    dry_run_status: str = "not_run",
    dry_run_details: str = "",
    final_action_allowed: bool = False,
) -> dict[str, Any]:
    role = (actual_role or requested_role or "unknown").lower()
    return {
        "email": email,
        "role": role,
        "batch_uuid": batch_uuid,
        "found": found,
        "user_id": user_id,
        "actual_role": actual_role,
        "requested_role": requested_role,
        "activation_state": activation_state,
        "status": status,
        "message": message,
        "eligible": bool(eligible),
        "exclusion_reason": exclusion_reason,
        "dry_run_status": dry_run_status,
        "dry_run_details": dry_run_details,
        "final_action_allowed": bool(final_action_allowed),
    }


def process_delete_batch(batch_uuid: str, dry_run_only: bool = False, emit: Any = None) -> dict[str, Any]:
    batch = get_batch(batch_uuid)
    if not batch:
        return {"error": "batch not found", "batch_uuid": batch_uuid}

    users = get_batch_users(batch_uuid)
    total = len(users)
    auth_service = PassboltApiAuthServiceV2()
    service = PassboltDeleteServiceV2(auth_service)
    results: list[dict[str, Any]] = []

    tls = get_tls_diagnostics()
    _save_live_log(
        "delete",
        "warning" if service.auth.verify_setting is False else "info",
        "Delete API TLS mode initialized",
        batch_uuid=batch_uuid,
        event_code="delete.tls.mode",
        payload={
            "verify_mode": tls["verify_mode"],
            "ca_bundle_configured": tls["ca_bundle_configured"],
            "ca_bundle_exists": tls["ca_bundle_exists"],
        },
    )

    if emit:
        emit({"type": "log", "message": f"Delete batch {batch_uuid} started ({total} user(s))"})
        emit({"type": "progress", "payload": {"current": 0, "total": max(total, 1), "percent": 0, "stage": "load-batch"}})
    _save_live_log("delete", "info", f"Delete batch {batch_uuid} started ({total} user(s))", batch_uuid=batch_uuid, event_code="delete.start")
    log_delete_event(batch_uuid, "batch_selected", status="info", message=f"dry_run_only={dry_run_only}")

    if not service.enabled():
        message = "Passbolt delete API is not configured"
        config_payload = auth_service.config_status()
        if emit:
            emit({"type": "stderr", "message": message})
        _save_live_log("delete", "error", message, batch_uuid=batch_uuid, event_code="delete.config.missing", payload=config_payload)
        log_delete_event(batch_uuid, "config", status="error", message=message)
        log_delete_event(batch_uuid, "batch_selected", status="info", message=f"selected_batch={batch_uuid}")
        return {"batch_uuid": batch_uuid, "status": "error", "message": message, "config": config_payload, "results": []}

    try:
        if emit:
            emit({"type": "progress", "payload": {"current": 0, "total": max(total, 1), "percent": 0, "stage": "jwt-login"}})
        service.authenticate()
        _save_live_log("delete", "audit", "JWT login success", batch_uuid=batch_uuid, event_code="delete.auth.jwt.success")
        log_delete_event(batch_uuid, "jwt_login", status="ok", message="JWT login success")
        if auth_service.config_status().get("checks", {}).get("totp_secret"):
            if emit:
                emit({"type": "progress", "payload": {"current": 0, "total": max(total, 1), "percent": 0, "stage": "mfa"}})
            _save_live_log("delete", "audit", "MFA TOTP configured and processed", batch_uuid=batch_uuid, event_code="delete.auth.mfa.info")
            log_delete_event(batch_uuid, "mfa", status="ok", message="MFA TOTP step processed")
    except Exception as error:
        message = _classify_request_error(error)
        if emit:
            emit({"type": "stderr", "message": message})
        _save_live_log("delete", "error", message, batch_uuid=batch_uuid, event_code="delete.auth.error")
        log_delete_event(batch_uuid, "jwt_login", status="error", message=message)
        return {"batch_uuid": batch_uuid, "status": "error", "message": message, "results": []}

    latest_batch = is_latest_batch(batch_uuid)

    for index, user in enumerate(users, start=1):
        email = (user.get("email") or "").strip().lower()
        created_by_tool = int(user.get("created_by_tool") or 0) == 1
        activation_state_local = (user.get("last_known_activation_state") or "unknown").lower()
        requested_role = (user.get("requested_role") or "").strip().lower()

        if emit:
            emit({"type": "progress", "payload": {"current": index, "total": max(total, 1), "percent": round((index / max(total, 1)) * 100, 2), "stage": "lookup"}})

        if not created_by_tool:
            row = _build_delete_result(email, batch_uuid, "SKIPPED_NOT_TOOL_MANAGED", message="User not created by tool", requested_role=requested_role, exclusion_reason="Utilisateur non créé par cet outil")
            results.append(row)
            log_delete_event(batch_uuid, "filter", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "warning", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.filter.not_tool")
            continue

        if (not latest_batch) and activation_state_local not in DELETE_ALLOWED_PENDING_STATES:
            row = _build_delete_result(email, batch_uuid, "SKIPPED_ACTIVE_USER", message="Anciens batches: seuls les comptes non activés sont supprimables", activation_state=activation_state_local, requested_role=requested_role, exclusion_reason="Compte actif d'un ancien batch")
            results.append(row)
            log_delete_event(batch_uuid, "filter", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "warning", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.filter.active")
            continue

        if requested_role == "admin":
            row = _build_delete_result(email, batch_uuid, "SKIPPED_ADMIN", message="Compte administrateur déclaré dans le CSV — suppression interdite", requested_role=requested_role, exclusion_reason="Admin protégé (CSV)", dry_run_status="skipped")
            results.append(row)
            log_delete_event(batch_uuid, "filter", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "warning", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.filter.admin_csv")
            continue

        try:
            passbolt_user = service.find_user_by_email(email)
        except Exception as error:
            row = _build_delete_result(email, batch_uuid, "ERROR", message=str(error), requested_role=requested_role, exclusion_reason="Erreur de recherche utilisateur", dry_run_status="error", dry_run_details=str(error))
            results.append(row)
            log_delete_event(batch_uuid, "lookup", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "error", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.lookup.error")
            continue

        if not passbolt_user:
            row = _build_delete_result(email, batch_uuid, "NOT_FOUND", message="User not found in Passbolt", requested_role=requested_role, exclusion_reason="Utilisateur introuvable dans Passbolt", dry_run_status="not_found")
            results.append(row)
            log_delete_event(batch_uuid, "lookup", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "warning", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.lookup.not_found")
            continue

        user_id = str(passbolt_user.get("id") or passbolt_user.get("user_id") or "")
        actual_role = service._resolve_role(passbolt_user)
        activation_state = service._resolve_activation_state(passbolt_user, activation_state_local)

        if actual_role == "admin":
            row = _build_delete_result(email, batch_uuid, "SKIPPED_ADMIN", message="Compte administrateur protégé — suppression interdite", found=True, user_id=user_id, actual_role=actual_role, activation_state=activation_state, requested_role=requested_role, exclusion_reason="Admin protégé", dry_run_status="skipped")
            results.append(row)
            log_delete_event(batch_uuid, "filter", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "warning", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.filter.admin")
            continue

        if activation_state in DELETE_ACTIVE_STATES:
            row = _build_delete_result(email, batch_uuid, "SKIPPED_ACTIVE_USER", message="Compte déjà activé/configuré — suppression interdite", found=True, user_id=user_id, actual_role=actual_role, activation_state=activation_state, requested_role=requested_role, exclusion_reason="Blocage métier Passbolt", dry_run_status="skipped")
            results.append(row)
            log_delete_event(batch_uuid, "filter", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "warning", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.filter.activated")
            continue

        if emit:
            emit({"type": "progress", "payload": {"current": index, "total": max(total, 1), "percent": round((index / max(total, 1)) * 100, 2), "stage": "dry-run"}})
        dry_ok, dry_message, _ = service.delete_user_dry_run(user_id)
        if not dry_ok:
            row = _build_delete_result(email, batch_uuid, "BLOCKED_BY_PASSBOLT", message=dry_message or "Dry-run rejected by Passbolt", found=True, user_id=user_id, actual_role=actual_role, activation_state=activation_state, requested_role=requested_role, eligible=False, exclusion_reason="Blocage métier Passbolt", dry_run_status="blocked", dry_run_details=dry_message or "Dry-run rejected by Passbolt")
            results.append(row)
            log_delete_event(batch_uuid, "dry_run", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "warning", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.dry_run.blocked")
            continue

        log_delete_event(batch_uuid, "dry_run", status="ok", message="dry-run success", email=email)
        _save_live_log("delete", "audit", "dry-run success", batch_uuid=batch_uuid, email=email, event_code="delete.dry_run.success")
        if emit:
            emit({"type": "stdout", "message": f"dry-run ok: {email}"})
        if dry_run_only:
            row = _build_delete_result(email, batch_uuid, "DRY_RUN_OK", message="Dry-run ok (preview only)", found=True, user_id=user_id, actual_role=actual_role, activation_state=activation_state, requested_role=requested_role, eligible=True, dry_run_status="ok", dry_run_details="Dry-run validé", final_action_allowed=True)
            results.append(row)
            continue

        if emit:
            emit({"type": "progress", "payload": {"current": index, "total": max(total, 1), "percent": round((index / max(total, 1)) * 100, 2), "stage": "delete"}})
        delete_ok, delete_message, _ = service.delete_user(user_id)
        if not delete_ok:
            row = _build_delete_result(email, batch_uuid, "ERROR", message=delete_message or "Delete failed", found=True, user_id=user_id, actual_role=actual_role, activation_state=activation_state, requested_role=requested_role, eligible=True, dry_run_status="ok", dry_run_details="Dry-run validé", final_action_allowed=False, exclusion_reason="Erreur suppression réelle")
            results.append(row)
            log_delete_event(batch_uuid, "delete", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "error", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.execute.error")
            continue

        update_user_delete_state(batch_uuid=batch_uuid, email=email, activation_state="deleted", deletable_candidate=0)
        row = _build_delete_result(email, batch_uuid, "DELETED", message="User deleted", found=True, user_id=user_id, actual_role=actual_role, activation_state="deleted", requested_role=requested_role, eligible=True, dry_run_status="ok", dry_run_details="Dry-run validé", final_action_allowed=False)
        results.append(row)
        log_delete_event(batch_uuid, "delete", status=row["status"], message=row["message"], email=email)
        _save_live_log("delete", "audit", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.execute.success")
        if emit:
            emit({"type": "stdout", "message": f"deleted: {email}"})

    status = "success" if all(item["status"] in {"DELETED", "DRY_RUN_OK", "SKIPPED_ADMIN", "SKIPPED_NOT_TOOL_MANAGED", "SKIPPED_ACTIVE_USER", "NOT_FOUND", "BLOCKED_BY_PASSBOLT"} for item in results) else "partial"
    if emit:
        emit({"type": "progress", "payload": {"current": total, "total": max(total, 1), "percent": 100, "stage": "done"}})
    summary = {
        "analyzed": len(results),
        "eligible": sum(1 for item in results if item.get("eligible")),
        "excluded": sum(1 for item in results if not item.get("eligible")),
        "admins_protected": sum(1 for item in results if item.get("status") == "SKIPPED_ADMIN"),
        "errors": sum(1 for item in results if item.get("status") in {"ERROR", "BLOCKED_BY_PASSBOLT"}),
    }
    result_payload = {
        "batch_uuid": batch_uuid,
        "status": status,
        "dry_run_only": dry_run_only,
        "total": total,
        "results": results,
        "summary": summary,
    }
    _save_live_log("delete", "info", "Delete batch finished", batch_uuid=batch_uuid, event_code="delete.done", payload={"status": status, "total": total, "dry_run_only": dry_run_only})
    return result_payload



def _process_rows(
    rows: list[dict[str, Any]],
    container: str,
    cli_path: str,
    rollback_on_error: bool,
    source_filename: str,
    emit: Any = None,
) -> dict[str, Any]:
    started = time.time()
    batch_uuid = str(uuid.uuid4())
    auth_service = PassboltApiAuthServiceV2()
    group_service = PassboltGroupServiceV2(auth_service)
    group_tls = get_tls_diagnostics()
    _emit_structured(
        emit,
        "warning" if auth_service.verify_setting is False else "info",
        "groups.tls.mode",
        "Groups and delete APIs share the same TLS verify mode",
        batch_uuid=batch_uuid,
        verify_mode=group_tls["verify_mode"],
        ca_bundle_configured=group_tls["ca_bundle_configured"],
        ca_bundle_exists=group_tls["ca_bundle_exists"],
    )
    preview = preview_rows(rows)
    create_import_batch(batch_uuid=batch_uuid, filename=source_filename, total_rows=len(rows), status="running")
    _save_live_log("import", "info", "Import batch record created", batch_uuid=batch_uuid, event_code="import.batch.created", payload={"filename": source_filename, "total_rows": len(rows)})

    valid_rows = [row for row in preview["rows"] if row["valid"]]
    total_valid = len(valid_rows)
    results: list[dict[str, Any]] = []
    created_users: list[str] = []
    created_groups_in_batch: set[str] = set()
    known_groups: dict[str, dict[str, Any]] = {}
    groups_created_total = 0
    groups_assigned_total = 0
    groups_deferred_total = 0

    _emit_structured(emit, "info", "import.start", "Import batch started", total_rows=len(rows), rollback_on_error=rollback_on_error)
    try:
        group_service.authenticate()
        _emit_structured(emit, "audit", "groups.auth.success", "JWT login success for groups API", batch_uuid=batch_uuid)
    except Exception as error:
        _emit_structured(emit, "error", "groups.auth.failed", "Groups API authentication failed", batch_uuid=batch_uuid, error=_classify_request_error(error))

    list_result = group_service.list_groups()
    if list_result["result"]["returncode"] == 0:
        for item in list_result.get("items", []):
            group_name = str(item.get("name") or "").strip()
            if group_name:
                known_groups[group_name.lower()] = item
        _emit_structured(emit, "info", "groups.list.success", "Groups list loaded", batch_uuid=batch_uuid, groups_count=len(known_groups))
    elif emit:
        emit({"type": "stderr", "message": "Impossible de lister les groupes, création best effort"})
        _emit_structured(emit, "warning", "groups.list.failed", "Failed to list groups, using best effort", batch_uuid=batch_uuid)

    if emit:
        emit({"type": "progress", "payload": {"current": 0, "total": max(total_valid, 1), "percent": 0, "stage": "preview"}})

    critical_error = False

    for index, row in enumerate(preview["rows"], start=1):
        if time.time() - started > IMPORT_TOTAL_TIMEOUT:
            critical_error = True
            _save_live_log("import", "error", f"global import timeout after {IMPORT_TOTAL_TIMEOUT}s", batch_uuid=batch_uuid, event_code="import.timeout", row_number=index, email=row.get("email", ""))
            results.append({
                "email": row.get("email", ""),
                "user_create_status": "error",
                "groups_requested": row.get("groups", []),
                "groups_created": [],
                "groups_assigned": [],
                "groups_deferred": row.get("groups", []),
                "errors": [f"global import timeout after {IMPORT_TOTAL_TIMEOUT}s"],
            })
            break

        if not row["valid"]:
            _save_live_log("import", "warning", "Invalid row skipped", batch_uuid=batch_uuid, row_number=index, email=row.get("email", ""), event_code="import.row.invalid", payload={"errors": row.get("errors", [])})
            save_imported_user(
                batch_uuid=batch_uuid,
                email=row.get("email", ""),
                firstname=row.get("firstname", ""),
                lastname=row.get("lastname", ""),
                requested_role=row.get("role", ""),
                import_status="skipped",
                created_by_tool=0,
                last_known_activation_state="unknown",
                deletable_candidate=0,
            )
            results.append({
                "email": row.get("email", ""),
                "user_create_status": "error",
                "groups_requested": row.get("groups", []),
                "groups_created": [],
                "groups_assigned": [],
                "groups_deferred": [],
                "errors": row.get("errors", []),
            })
            continue

        if emit:
            emit({"type": "progress", "payload": {"current": index, "total": len(rows), "percent": int((index / max(len(rows), 1)) * 100), "stage": "create-user"}})

        email = row["email"]
        _emit_structured(emit, "info", "user.create.start", "Creating user", row=index, email=email)
        user_result = create_user(email, row["firstname"], row["lastname"], row["role"], container, cli_path)

        user_payload: dict[str, Any] = {
            "email": email,
            "user_create_status": "success" if user_result["returncode"] == 0 else "error",
            "created_user_activation_link": _extract_activation_link(user_result.get("stdout", "")),
            "groups_requested": row.get("groups", []),
            "groups_created": [],
            "groups_assigned": [],
            "groups_deferred": [],
            "errors": [],
            "raw": user_result,
        }

        if user_result["returncode"] == 0:
            created_users.append(email)
            user_import_status = "pending_activation"
            _emit_structured(emit, "info", "user.create.success", "User created", row=index, email=email)
        else:
            user_import_status = "error"
            user_payload["errors"].append(user_result.get("stderr") or "user creation failed")
            _emit_structured(emit, "error", "user.create.failed", "User creation failed", row=index, email=email, stderr=user_result.get("stderr", ""))
            if _critical_error(user_result):
                critical_error = True

        for group in row.get("groups", []):
            normalized = group.lower()
            group_item = known_groups.get(normalized)
            if not group_item:
                if emit:
                    emit({"type": "progress", "payload": {"current": index, "total": len(rows), "percent": int((index / max(len(rows), 1)) * 100), "stage": "create-group"}})
                create_result = group_service.create_group(group)
                if create_result["returncode"] == 0:
                    groups_created_total += 1
                    user_payload["groups_created"].append(group)
                    created_groups_in_batch.add(group)
                    _emit_structured(emit, "info", "group.create.success", "Group created", row=index, group=group, email=email)
                elif "already" not in (create_result.get("stderr", "").lower()):
                    user_payload["errors"].append(f"group {group}: {create_result.get('stderr', 'creation failed')}")
                    _emit_structured(emit, "error", "group.create.failed", "Group creation failed", row=index, group=group, email=email, stderr=create_result.get("stderr", ""))
                    continue
                try:
                    lookup_group = group_service.get_group_by_name(group)
                except Exception as error:
                    user_payload["errors"].append(f"group {group}: {error}")
                    _emit_structured(emit, "error", "group.lookup.failed", "Group lookup failed", row=index, group=group, email=email, stderr=str(error))
                    continue
                if not lookup_group:
                    user_payload["errors"].append(f"group {group}: lookup failed after creation")
                    _emit_structured(emit, "error", "group.lookup.failed", "Group lookup failed", row=index, group=group, email=email)
                    continue
                group_item = lookup_group
                known_groups[normalized] = group_item

            if emit:
                emit({"type": "progress", "payload": {"current": index, "total": len(rows), "percent": int((index / max(len(rows), 1)) * 100), "stage": "assign-group"}})

            if user_result["returncode"] != 0:
                user_payload["groups_deferred"].append(group)
                groups_deferred_total += 1
                _append_pending({"email": email, "group": group, "reason": "user creation failed", "status": "deferred"})
                _emit_structured(emit, "warning", "group.defer", "Group assignment deferred", row=index, group=group, email=email, reason="user creation failed")
                continue

            try:
                user_obj = group_service.find_user_by_email(email)
            except Exception as error:
                reason = str(error)
                user_payload["groups_deferred"].append(group)
                groups_deferred_total += 1
                _append_pending({"email": email, "group": group, "reason": reason, "status": "deferred"})
                _emit_structured(emit, "warning", "group.assign.deferred", "Group assignment deferred", row=index, group=group, email=email, reason=reason)
                continue

            user_id = str((user_obj or {}).get("id") or "")
            group_id = str((group_item or {}).get("id") or "")
            if not user_id or not group_id:
                reason = "missing user_id/group_id"
                user_payload["groups_deferred"].append(group)
                groups_deferred_total += 1
                _append_pending({"email": email, "group": group, "reason": reason, "status": "deferred"})
                _emit_structured(emit, "warning", "group.assign.deferred", "Group assignment deferred", row=index, group=group, email=email, reason=reason)
                continue

            assign_result = group_service.assign_user_to_group(user_id, group_id)
            if assign_result["returncode"] == 0:
                user_payload["groups_assigned"].append(group)
                groups_assigned_total += 1
                _emit_structured(emit, "info", "group.assign.success", "Group assigned", row=index, group=group, email=email)
            else:
                reason = assign_result.get("stderr") or "user not active yet"
                _emit_structured(emit, "warning", "group.assign.deferred", "Group assignment deferred", row=index, group=group, email=email, reason=reason)
                user_payload["groups_deferred"].append(group)
                groups_deferred_total += 1
                _append_pending({"email": email, "group": group, "reason": reason, "status": "deferred"})

        if user_payload["user_create_status"] == "success" and user_payload["groups_deferred"]:
            user_payload["group_assignment_status"] = "deferred"
            user_payload["reason"] = "user not active yet"
        elif user_payload["user_create_status"] == "success":
            user_payload["group_assignment_status"] = "assigned"
        else:
            user_payload["group_assignment_status"] = "not-created"

        save_imported_user(
            batch_uuid=batch_uuid,
            email=email,
            firstname=row.get("firstname", ""),
            lastname=row.get("lastname", ""),
            requested_role=row.get("role", ""),
            import_status=user_import_status,
            activation_link=user_payload.get("created_user_activation_link"),
            created_by_tool=1 if user_result["returncode"] == 0 else 0,
            actual_role=row.get("role", ""),
            last_known_activation_state="pending" if user_result["returncode"] == 0 else "unknown",
            deletable_candidate=1 if user_result["returncode"] == 0 and row.get("role", "").lower() != "admin" else 0,
        )

        results.append(user_payload)

        if rollback_on_error and critical_error:
            break

    rollback = None
    final_status = "success"
    errors_count = sum(1 for item in results if item.get("user_create_status") != "success")


    if critical_error and rollback_on_error:
        rollback = rollback_batch(created_users, container, cli_path)
        if rollback.get("manual_required"):
            final_status = "rollback_required_manual"
        else:
            final_status = "rolled_back"
    elif errors_count:
        final_status = "partial"

    if emit:
        emit({"type": "progress", "payload": {"current": len(results), "total": max(len(rows), 1), "percent": 100, "stage": "done"}})

    _emit_structured(emit, "info", "import.done", "Import batch finished", status=final_status, users_created=len(created_users), errors=errors_count)
    batch_status = _resolve_batch_status(final_status, len(created_users), errors_count)
    finalize_import_batch(batch_uuid=batch_uuid, success_count=len(created_users), error_count=errors_count, status=batch_status)
    _save_live_log("import", "audit", "Import batch finalized", batch_uuid=batch_uuid, event_code="import.batch.finalized", payload={"status": batch_status, "users_created": len(created_users), "errors": errors_count})

    return {
        "batch_uuid": batch_uuid,
        "status": final_status,
        "total": len(results),
        "success": sum(1 for item in results if item.get("user_create_status") == "success"),
        "results": results,
        "preview": preview,
        "summary": {
            "users_created": len(created_users),
            "groups_created": groups_created_total,
            "groups_assigned": groups_assigned_total,
            "groups_deferred": groups_deferred_total,
            "errors": errors_count,
            "created_groups_in_batch": sorted(created_groups_in_batch),
        },
        "rollback": rollback,
    }


@app.route("/health", methods=["GET"])
def health() -> Any:
    diagnostics = diagnose_environment()
    checks = diagnostics.get("checks", [])
    docker_check = next((check for check in checks if check.get("name") == "docker_sdk"), {})
    container_check = next((check for check in checks if check.get("name") == "container_selection"), {})
    cli_check = next((check for check in checks if check.get("name") == "cli_path_check"), {})
    return jsonify(
        {
            "status": "ok",
            "container": diagnostics.get("resolved_container", PASSBOLT_CONTAINER),
            "cli_path": diagnostics.get("resolved_cli_path", PASSBOLT_CLI_PATH),
            "timeout_seconds": IMPORT_COMMAND_TIMEOUT,
            "total_timeout_seconds": IMPORT_TOTAL_TIMEOUT,
            "docker": {
                "sdk_ok": docker_check.get("ok", False),
                "visible_containers": docker_check.get("visible_containers", 0),
                "target_container_found": container_check.get("ok", False),
                "cli_path_found": cli_check.get("ok", False),
            },
            "diagnostics": diagnostics,
        }
    )


@app.route("/api/health", methods=["GET"])
def api_health() -> Any:
    return health()


@app.route("/debug/import", methods=["GET"])
def debug_import() -> Any:
    return jsonify({"status": "debug", "diagnostics": diagnose_environment()})


@app.route("/preview", methods=["POST"])
def preview_csv() -> Any:
    rows, error = parse_csv_rows(request.files.get("file"))
    if error:
        _save_live_log("import", "error", "Preview failed: invalid CSV payload", event_code="preview.invalid")
        return error
    payload = preview_rows(rows)
    _save_live_log("import", "info", "Preview generated", event_code="preview.done", payload={"total_rows": payload.get("total_rows", 0), "invalid_rows": payload.get("invalid_rows", 0)})
    return jsonify(payload)


@app.route("/import", methods=["POST"])
def import_csv() -> Any:
    file_storage = request.files.get("file")
    source_filename = (file_storage.filename if file_storage else "unknown.csv") or "unknown.csv"
    rows, error = parse_csv_rows(file_storage)
    if error:
        _save_live_log("import", "error", "Import rejected: invalid CSV payload", event_code="import.invalid")
        return error

    rollback_on_error = str(request.form.get("rollback_on_error", "false")).lower() == "true"
    diagnostics = diagnose_environment()
    container = diagnostics.get("resolved_container", PASSBOLT_CONTAINER)
    cli_path = diagnostics.get("resolved_cli_path", PASSBOLT_CLI_PATH)

    payload = _process_rows(rows, container, cli_path, rollback_on_error=rollback_on_error, source_filename=source_filename)
    payload["diagnostics"] = diagnostics
    return jsonify(payload)


@app.route("/import-stream", methods=["POST"])
@app.route("/api/import-stream", methods=["POST"])
def import_csv_stream() -> Any:
    file_storage = request.files.get("file")
    source_filename = (file_storage.filename if file_storage else "unknown.csv") or "unknown.csv"
    rows, error = parse_csv_rows(file_storage)
    if error:
        _save_live_log("import", "error", "Import-stream rejected: invalid CSV payload", event_code="import.stream.invalid")
        return error

    rollback_on_error = str(request.form.get("rollback_on_error", "false")).lower() == "true"
    diagnostics = diagnose_environment()
    container = diagnostics.get("resolved_container", PASSBOLT_CONTAINER)
    cli_path = diagnostics.get("resolved_cli_path", PASSBOLT_CLI_PATH)

    @stream_with_context
    def generate() -> Any:
        _save_live_log("import", "info", f"Import stream started for {len(rows)} row(s)", event_code="import.stream.start")
        yield json.dumps({"type": "log", "message": f"Import started for {len(rows)} row(s)"}, ensure_ascii=False) + "\n"
        yield json.dumps({"type": "debug", "payload": diagnostics}, ensure_ascii=False) + "\n"

        event_queue: Queue[Any] = Queue()
        done_marker = object()

        def emit(event: dict[str, Any]) -> None:
            event_queue.put(event)

        def worker() -> None:
            try:
                payload = _process_rows(
                    rows,
                    container,
                    cli_path,
                    rollback_on_error=rollback_on_error,
                    source_filename=source_filename,
                    emit=emit,
                )
                payload["diagnostics"] = diagnostics
                _save_live_log("import", "info", "Import stream completed", batch_uuid=payload.get("batch_uuid"), event_code="import.stream.done", payload={"status": payload.get("status"), "total": payload.get("total")})
                event_queue.put({"type": "final", "payload": payload})
            except Exception as error:
                event_queue.put({"type": "stderr", "message": f"Import stream error: {error}"})
            finally:
                event_queue.put(done_marker)

        Thread(target=worker, daemon=True).start()

        while True:
            event = event_queue.get()
            if event is done_marker:
                break
            yield json.dumps(event, ensure_ascii=False) + "\n"

    return Response(generate(), mimetype="application/x-ndjson")


@app.route("/pending-group-assignments", methods=["GET"])
def pending_group_assignments() -> Any:
    with PENDING_LOCK:
        payload = list(PENDING_ASSIGNMENTS)
    return jsonify({"total": len(payload), "items": payload})


@app.route("/retry-pending-group-assignments", methods=["POST"])
def retry_pending_group_assignments() -> Any:
    auth_service = PassboltApiAuthServiceV2()
    group_service = PassboltGroupServiceV2(auth_service)
    group_tls = get_tls_diagnostics()
    _save_live_log(
        "groups",
        "warning" if auth_service.verify_setting is False else "info",
        "Groups and delete APIs share the same TLS verify mode",
        event_code="groups.tls.mode",
        payload={
            "verify_mode": group_tls["verify_mode"],
            "ca_bundle_configured": group_tls["ca_bundle_configured"],
            "ca_bundle_exists": group_tls["ca_bundle_exists"],
        },
    )
    try:
        group_service.authenticate()
    except Exception as error:
        return jsonify({"error": f"Groups API authentication failed: {_classify_request_error(error)}"}), 500

    retried: list[dict[str, Any]] = []
    still_pending: list[dict[str, Any]] = []
    with PENDING_LOCK:
        current = list(PENDING_ASSIGNMENTS)
        PENDING_ASSIGNMENTS.clear()

    for item in current:
        try:
            user = group_service.find_user_by_email(item["email"])
            group = group_service.get_group_by_name(item["group"])
        except Exception as error:
            item["reason"] = str(error)
            still_pending.append(item)
            continue

        user_id = str((user or {}).get("id") or "")
        group_id = str((group or {}).get("id") or "")
        if not user_id or not group_id:
            item["reason"] = "missing user_id/group_id"
            still_pending.append(item)
            continue

        result = group_service.assign_user_to_group(user_id, group_id)
        if result["returncode"] == 0:
            retried.append({"email": item["email"], "group": item["group"], "status": "assigned"})
        else:
            item["reason"] = result.get("stderr") or item.get("reason", "retry failed")
            still_pending.append(item)

    with PENDING_LOCK:
        PENDING_ASSIGNMENTS.extend(still_pending)

    return jsonify({"retried": retried, "pending": still_pending, "pending_total": len(still_pending)})


@app.route("/delete-config-status", methods=["GET"])
def delete_config_status() -> Any:
    auth = PassboltApiAuthServiceV2()
    report = auth.run_diagnostic()
    groups_step = next((step for step in report.get("steps", []) if step.get("id") == "groups"), {})
    payload = {
        "configured": report.get("overall_status") == "ok",
        "message": groups_step.get("message") or "Diagnostic API Passbolt exécuté",
        "overall_status": report.get("overall_status"),
        "groups_status": groups_step.get("status", "skipped"),
    }
    _save_live_log(
        "delete",
        "info" if payload.get("configured") else "warning",
        payload.get("message") or "delete config status",
        event_code="delete.config.status",
        payload=payload,
    )
    return jsonify(payload)


@app.route("/passbolt/health", methods=["GET", "POST"])
@app.route("/api/passbolt/health", methods=["GET", "POST"])
def passbolt_health() -> Any:
    auth = PassboltApiAuthServiceV2()
    report = auth.run_diagnostic()
    _save_live_log(
        "groups",
        "info" if report.get("overall_status") == "ok" else "warning",
        "Passbolt API diagnostic completed",
        event_code="passbolt.health.diagnostic",
        payload={"overall_status": report.get("overall_status")},
    )
    return jsonify(report)


@app.route("/delete-last-import-users", methods=["POST"])
def delete_last_import_users() -> Any:
    latest = get_last_import_batch()
    if not latest:
        return jsonify({"status": "no-op", "message": "no batch found", "results": []})

    body = request.get_json(silent=True) or {}
    dry_run_only = bool(body.get("dry_run_only", False))
    payload = process_delete_batch(latest["batch_uuid"], dry_run_only=dry_run_only)
    return jsonify(payload)


@app.route("/delete-batch-users", methods=["POST"])
def delete_batch_users() -> Any:
    body = request.get_json(silent=True) or {}
    batch_uuid = (body.get("batch_uuid") or "").strip()
    if not batch_uuid:
        return jsonify({"error": "batch_uuid is required"}), 400
    dry_run_only = bool(body.get("dry_run_only", False))
    payload = process_delete_batch(batch_uuid, dry_run_only=dry_run_only)
    if payload.get("error"):
        return jsonify(payload), 404
    return jsonify(payload)


@app.route("/delete-users-stream", methods=["POST"])
def delete_users_stream() -> Any:
    body = request.get_json(silent=True) or {}
    batch_uuid = (body.get("batch_uuid") or "").strip()
    dry_run_only = bool(body.get("dry_run_only", False))

    if not batch_uuid:
        latest = get_last_import_batch()
        if not latest:
            return jsonify({"error": "no batch found"}), 404
        batch_uuid = latest["batch_uuid"]

    @stream_with_context
    def generate() -> Any:
        events: list[dict[str, Any]] = []

        def emit(event: dict[str, Any]) -> None:
            events.append(event)

        payload = process_delete_batch(batch_uuid, dry_run_only=dry_run_only, emit=emit)
        for event in events:
            yield json.dumps(event, ensure_ascii=False) + "\n"
        yield json.dumps({"type": "final", "payload": payload}, ensure_ascii=False) + "\n"

    return Response(generate(), mimetype="application/x-ndjson")


def _json_error(message: str, status: int = 500, **extra: Any) -> Any:
    payload: dict[str, Any] = {"error": message}
    if extra:
        payload.update(extra)
    return jsonify(payload), status


@app.route("/logs", methods=["GET", "DELETE"])
@app.route("/api/logs", methods=["GET", "DELETE"])
def logs_collection() -> Any:
    try:
        batch_uuid, scope, level = _logs_filters_from_request()
        if request.method == "DELETE":
            deleted_count = purge_logs(batch_uuid=batch_uuid)
            _save_live_log(
                "system",
                "audit",
                "Logs purged",
                batch_uuid=batch_uuid,
                event_code="logs.purge",
                payload={"deleted_count": deleted_count},
            )
            return jsonify({"status": "ok", "deleted_count": deleted_count, "batch_uuid": batch_uuid})

        limit_arg = request.args.get("limit", "200")
        try:
            limit = int(limit_arg)
        except ValueError:
            limit = 200
        items = list_logs(batch_uuid=batch_uuid, scope=scope, level=level, limit=limit)
        return jsonify({"items": items, "count": len(items), "filters": {"batch_uuid": batch_uuid, "scope": scope, "level": level}})
    except Exception as error:
        return _json_error("Unable to load logs", 500, details=str(error))


@app.route("/logs/summary", methods=["GET"])
@app.route("/api/logs/summary", methods=["GET"])
def logs_summary() -> Any:
    try:
        batch_uuid, scope, level = _logs_filters_from_request()
        payload = get_logs_summary(batch_uuid=batch_uuid, scope=scope, level=level)
        payload["filters"] = {"batch_uuid": batch_uuid, "scope": scope, "level": level}
        return jsonify(payload)
    except Exception as error:
        return _json_error("Unable to load logs summary", 500, details=str(error))


@app.route("/logs/export.csv", methods=["GET"])
@app.route("/api/logs/export.csv", methods=["GET"])
def logs_export_csv() -> Any:
    batch_uuid, scope, level = _logs_filters_from_request()
    items = list_logs(batch_uuid=batch_uuid, scope=scope, level=level, limit=2000)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["id", "created_at", "batch_uuid", "scope", "level", "event_code", "message", "email", "row_number", "payload_json"])
    for row in items:
        writer.writerow([
            row.get("id", ""),
            row.get("created_at", ""),
            row.get("batch_uuid", ""),
            row.get("scope", ""),
            row.get("level", ""),
            row.get("event_code", ""),
            row.get("message", ""),
            row.get("email", ""),
            row.get("row_number", ""),
            row.get("payload_json", ""),
        ])

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    filename = f"import_logs_{timestamp}.csv"
    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.route("/batches", methods=["GET"])
@app.route("/api/batches", methods=["GET"])

def batches() -> Any:
    try:
        return jsonify({"items": list_import_batches()})
    except Exception as error:
        return _json_error("Unable to load batches", 500, details=str(error))


@app.route("/batches/latest", methods=["GET"])
def latest_batch() -> Any:
    batch = get_last_import_batch()
    if not batch:
        return jsonify({"error": "no batch found"}), 404
    return jsonify(batch)


@app.route("/batches/<batch_uuid>", methods=["GET"])
def batch_details(batch_uuid: str) -> Any:
    batch = get_batch(batch_uuid)
    if not batch:
        return jsonify({"error": "batch not found"}), 404
    return jsonify({"batch": batch, "users": get_batch_users(batch_uuid)})


@app.route("/batches/<batch_uuid>/deletable-users", methods=["GET"])
def batch_deletable_users(batch_uuid: str) -> Any:
    batch = get_batch(batch_uuid)
    if not batch:
        return jsonify({"error": "batch not found"}), 404
    users = get_batch_users(batch_uuid)
    return jsonify({"batch_uuid": batch_uuid, "total": len(users), "items": users})


@app.route("/db/summary", methods=["GET"])
def db_summary() -> Any:
    return jsonify(get_db_summary())


@app.errorhandler(Exception)
def handle_exception(error: Exception) -> Any:
    return jsonify({"error": str(error), "type": error.__class__.__name__}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=9090)
