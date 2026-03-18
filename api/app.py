import csv
import hashlib
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

PASSBOLT_API_MODULE_ERROR: str | None = None
try:
    from passbolt_api import (
        PassboltApiAuthService as PassboltApiAuthServiceV2,
        PassboltDeleteService as PassboltDeleteServiceV2,
        PassboltGroupService as PassboltGroupServiceV2,
        parse_dry_run_details as parse_dry_run_details_v2,
    )
except ImportError as error:
    PassboltApiAuthServiceV2 = None
    PassboltDeleteServiceV2 = None
    PassboltGroupServiceV2 = None
    parse_dry_run_details_v2 = None
    PASSBOLT_API_MODULE_ERROR = str(error)

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
PASSBOLT_API_GNUPGHOME = os.getenv("PASSBOLT_API_GNUPGHOME", "/tmp/gnupg-passbolt").strip()
PASSBOLT_API_PASSPHRASE = os.getenv("PASSBOLT_API_PASSPHRASE", "")
PASSBOLT_API_VERIFY_TLS = os.getenv("PASSBOLT_API_VERIFY_TLS", str(PASSBOLT_VERIFY_TLS).lower()).lower() not in {"0", "false", "no"}
PASSBOLT_API_CA_BUNDLE = os.getenv("PASSBOLT_API_CA_BUNDLE", "").strip()
PASSBOLT_API_MFA_PROVIDER = (os.getenv("PASSBOLT_API_MFA_PROVIDER", "totp") or "totp").strip().lower()
PASSBOLT_API_TOTP_SECRET = os.getenv("PASSBOLT_API_TOTP_SECRET", "").strip()
PASSBOLT_API_TIMEOUT = int(os.getenv("PASSBOLT_API_TIMEOUT", "30"))
PASSBOLT_API_DEBUG = os.getenv("PASSBOLT_API_DEBUG", "false").lower() in {"1", "true", "yes"}

DELETE_ALLOWED_PENDING_STATES = {"pending", "unknown", "", None}
DELETE_ACTIVE_STATES = {"active", "activated", "setup_completed", "enabled"}

try:
    docker_client = docker.from_env()
except Exception as error:
    docker_client = None
    print(f"[WARNING] Docker SDK unavailable at startup: {error}")

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
        "PASSBOLT_API_GNUPGHOME": os.getenv("PASSBOLT_API_GNUPGHOME", "/tmp/gnupg-passbolt"),
    }
    issues: list[str] = []
    for key, value in required.items():
        if not value:
            issues.append(f"missing env: {key}")
    key_path = required.get("PASSBOLT_API_PRIVATE_KEY_PATH")
    if key_path and not os.path.exists(str(key_path)):
        issues.append(f"private key file not found: {key_path}")
    gnupg_home = os.getenv("PASSBOLT_API_GNUPGHOME", "/tmp/gnupg-passbolt").strip()
    if gnupg_home and os.path.exists(gnupg_home) and not os.path.isdir(gnupg_home):
        issues.append(f"PASSBOLT_API_GNUPGHOME must be a directory: {gnupg_home}")
    ca_bundle = os.getenv("PASSBOLT_API_CA_BUNDLE", "")
    if ca_bundle and not os.path.exists(ca_bundle):
        issues.append(f"CA bundle not found: {ca_bundle}")
    return issues


for _issue in validate_startup_configuration():
    print(f"[WARNING] Startup config validation: {_issue}")


def _safe_secret_diagnostic(value: str) -> dict[str, Any]:
    secret = value or ""
    digest = hashlib.sha256(secret.encode("utf-8")).hexdigest()[:12] if secret else ""
    return {
        "present": bool(secret),
        "length": len(secret),
        "sha256_prefix": digest,
    }


def log_passphrase_diagnostic() -> None:
    diag = _safe_secret_diagnostic(os.getenv("PASSBOLT_API_PASSPHRASE", ""))
    print(
        "[INFO] PASSBOLT_API_PASSPHRASE diagnostic "
        f"present={diag['present']} length={diag['length']} sha256_prefix={diag['sha256_prefix']}"
    )

log_passphrase_diagnostic()

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
    if docker_client is None:
        raise RuntimeError('docker client unavailable')
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
    if docker_client is None:
        return PASSBOLT_CLI_PATH
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

    if docker_client is None:
        return {
            'returncode': -4,
            'stdout': '',
            'stderr': 'docker client unavailable',
            'command': command_str,
        }

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


def _coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off", ""}:
            return False
    return bool(value)




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
    mode: str = "dry-run",
    final_action: str = "simulation_only",
    endpoint_called: str = "",
    http_method: str = "",
    http_status: int | None = None,
    response_summary: str = "",
    user_exists_before: bool | None = None,
    user_exists_after: bool | None = None,
    delete_constraints_detected: str = "none",
    response_raw_path: str = "",
    debug_delete: dict[str, Any] | None = None,
    ui_dry_run_state: bool | None = None,
    backend_dry_run_state: bool | None = None,
    confirmation_checked: bool | None = None,
    eligible_count: int | None = None,
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
        "mode": mode,
        "final_action": final_action,
        "endpoint_called": endpoint_called,
        "http_method": http_method,
        "http_status": http_status,
        "response_summary": response_summary,
        "user_exists_before": user_exists_before,
        "user_exists_after": user_exists_after,
        "delete_constraints_detected": delete_constraints_detected,
        "response_raw_path": response_raw_path,
        "debug_delete": debug_delete or {},
        "ui_dry_run_state": ui_dry_run_state,
        "backend_dry_run_state": backend_dry_run_state,
        "confirmation_checked": confirmation_checked,
        "eligible_count": eligible_count,
    }


def _detect_delete_constraint(dry_message: str, dry_details: dict[str, Any]) -> str:
    normalized = f"{dry_message} {json.dumps(dry_details, ensure_ascii=False)}".lower()
    if "owner" in normalized or "propriét" in normalized:
        return "owner_block"
    if ("group" in normalized or "groupe" in normalized) and ("manager" in normalized or "gestionnaire" in normalized):
        return "group_manager_block"
    return "none"


def _extract_delete_debug(payload: dict[str, Any] | None) -> dict[str, Any]:
    if isinstance(payload, dict) and isinstance(payload.get("debug_delete"), dict):
        return payload.get("debug_delete") or {}
    return {}




def _passbolt_api_module_status() -> dict[str, Any]:
    available = PassboltApiAuthServiceV2 is not None and PassboltDeleteServiceV2 is not None and PassboltGroupServiceV2 is not None
    return {
        "available": bool(available),
        "error": PASSBOLT_API_MODULE_ERROR,
    }


def _passbolt_api_unavailable_response(feature: str, status: int = 503) -> Any:
    state = _passbolt_api_module_status()
    message = f"Passbolt API advanced module unavailable for {feature}"
    payload = {
        "error": message,
        "feature": feature,
        "module": state,
    }
    _save_live_log("system", "warning", message, event_code="passbolt.api.module.unavailable", payload=payload)
    return jsonify(payload), status


def _passbolt_api_services() -> tuple[Any, Any]:
    if PassboltApiAuthServiceV2 is None or PassboltDeleteServiceV2 is None:
        raise RuntimeError("passbolt_api module unavailable")
    auth_service = PassboltApiAuthServiceV2()
    service = PassboltDeleteServiceV2(auth_service)
    return auth_service, service

def process_delete_batch(batch_uuid: str, dry_run_only: bool = False, emit: Any = None, ui_context: dict[str, Any] | None = None) -> dict[str, Any]:
    batch = get_batch(batch_uuid)
    if not batch:
        return {"error": "batch not found", "batch_uuid": batch_uuid}

    users = get_batch_users(batch_uuid)
    total = len(users)
    try:
        auth_service, service = _passbolt_api_services()
    except Exception:
        return {
            "batch_uuid": batch_uuid,
            "status": "error",
            "message": "Passbolt delete API module unavailable",
            "module": _passbolt_api_module_status(),
            "results": [],
        }
    results: list[dict[str, Any]] = []
    auth_service._logger = lambda level, message, **details: _save_live_log(  # noqa: SLF001
        "delete",
        "audit" if level == "info" else level,
        message,
        batch_uuid=batch_uuid,
        event_code="delete.auth.trace",
        payload=details or None,
    )

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

    mode_label = "dry-run" if dry_run_only else "real-delete"
    ui_context = ui_context or {}
    ui_dry_run_state = _coerce_bool(ui_context.get("ui_dry_run_state"), dry_run_only)
    backend_dry_run_state = bool(dry_run_only)
    confirmation_checked = _coerce_bool(ui_context.get("confirmation_checked"), False)
    eligible_count = int(ui_context.get("eligible_count", 0) or 0)
    blocking_errors = int(ui_context.get("blocking_errors", 0) or 0)
    should_execute_real_delete = (not backend_dry_run_state) and confirmation_checked
    requested_final_action = (
        "simulation_only"
        if backend_dry_run_state
        else ("real_delete_requested" if confirmation_checked else "real_delete_not_confirmed")
    )
    if emit:
        emit({"type": "log", "message": f"{'Dry-run' if dry_run_only else 'Suppression réelle'} démarré(e) pour batch {batch_uuid} ({total} user(s))"})
        emit(
            {
                "type": "log",
                "message": json.dumps(
                    {
                        "batch_id": batch_uuid,
                        "mode": mode_label,
                        "ui_dry_run_state": ui_dry_run_state,
                        "backend_dry_run_state": backend_dry_run_state,
                        "confirmation_checked": confirmation_checked,
                        "eligible_count": eligible_count,
                        "blocking_errors": blocking_errors,
                        "final_action": requested_final_action,
                    },
                    ensure_ascii=False,
                ),
            }
        )
        emit({"type": "progress", "payload": {"current": 0, "total": max(total, 1), "percent": 0, "stage": "load-batch"}})
    _save_live_log("delete", "info", f"{'Dry-run' if dry_run_only else 'Suppression réelle'} batch {batch_uuid} started ({total} user(s))", batch_uuid=batch_uuid, event_code="delete.start", payload={"mode": mode_label, "batch_id": batch_uuid})
    log_delete_event(batch_uuid, "batch_selected", status="info", message=f"mode={mode_label}")

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

    def _emit_delete_flow(
        *,
        target_user_email: str,
        target_user_id: str,
        final_action: str,
        endpoint_called: str,
        http_method: str,
        http_status: int | None,
        response_summary: str,
        user_exists_before: bool | None,
        user_exists_after: bool | None,
        delete_constraints_detected: str = "none",
        response_raw_path: str = "",
    ) -> None:
        flow_payload = {
            "batch_id": batch_uuid,
            "target_user_email": target_user_email,
            "target_user_id": target_user_id,
            "mode": mode_label,
            "ui_dry_run_state": ui_dry_run_state,
            "backend_dry_run_state": backend_dry_run_state,
            "confirmation_checked": confirmation_checked,
            "eligible_count": eligible_count,
            "final_action": final_action,
            "endpoint_called": endpoint_called,
            "http_method": http_method,
            "http_status": http_status,
            "response_summary": response_summary,
            "user_exists_before": user_exists_before,
            "user_exists_after": user_exists_after,
            "delete_constraints_detected": delete_constraints_detected,
            "response_raw_path": response_raw_path,
        }
        if emit:
            emit({"type": "log", "message": json.dumps(flow_payload, ensure_ascii=False)})
        _save_live_log(
            "delete",
            "info",
            f"Delete flow | {target_user_email} | {final_action}",
            batch_uuid=batch_uuid,
            email=target_user_email,
            event_code="delete.flow",
            payload=flow_payload,
        )

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

        if emit and backend_dry_run_state:
            emit({"type": "progress", "payload": {"current": index, "total": max(total, 1), "percent": round((index / max(total, 1)) * 100, 2), "stage": "dry-run"}})
        dry_debug: dict[str, Any] = {}
        dry_details: dict[str, Any] = {}
        delete_constraint = "none"
        if backend_dry_run_state:
            dry_ok, dry_message, dry_payload = service.delete_user_dry_run(user_id)
            dry_debug = _extract_delete_debug(dry_payload)
            dry_details = parse_dry_run_details_v2(dry_payload) if parse_dry_run_details_v2 else {}
            delete_constraint = _detect_delete_constraint(dry_message or "", dry_details)
            if not dry_ok:
                row = _build_delete_result(
                    email,
                    batch_uuid,
                    "BLOCKED_BY_PASSBOLT",
                    message=dry_message or "Dry-run rejected by Passbolt",
                    found=True,
                    user_id=user_id,
                    actual_role=actual_role,
                    activation_state=activation_state,
                    requested_role=requested_role,
                    eligible=False,
                    exclusion_reason="Blocage métier Passbolt",
                    dry_run_status="blocked",
                    dry_run_details=json.dumps(dry_details, ensure_ascii=False) if dry_details else (dry_message or "Dry-run rejected by Passbolt"),
                    mode=mode_label,
                    final_action="simulation_only",
                    endpoint_called=dry_debug.get("endpoint_called", f"/users/{user_id}/dry-run.json"),
                    http_method=dry_debug.get("http_method", "DELETE"),
                    http_status=dry_debug.get("http_status"),
                    response_summary=dry_message,
                    user_exists_before=True,
                    user_exists_after=True,
                    delete_constraints_detected=delete_constraint,
                    debug_delete=dry_debug,
                    ui_dry_run_state=ui_dry_run_state,
                    backend_dry_run_state=backend_dry_run_state,
                    confirmation_checked=confirmation_checked,
                    eligible_count=eligible_count,
                )
                results.append(row)
                _emit_delete_flow(
                    target_user_email=email,
                    target_user_id=user_id,
                    final_action=row["final_action"],
                    endpoint_called=row["endpoint_called"],
                    http_method=row["http_method"],
                    http_status=row["http_status"],
                    response_summary=row["response_summary"],
                    user_exists_before=True,
                    user_exists_after=True,
                    delete_constraints_detected=delete_constraint,
                )
                log_delete_event(batch_uuid, "dry_run", status=row["status"], message=row["message"], email=email)
                _save_live_log("delete", "warning", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.dry_run.blocked", payload=dry_details or None)
                continue

            groups_to_check = dry_details.get("groups_to_delete") or dry_details.get("groups") or []
            if isinstance(groups_to_check, list):
                for group in groups_to_check:
                    if not isinstance(group, dict):
                        continue
                    group_id = str(group.get("id") or group.get("group_id") or "")
                    if not group_id:
                        continue
                    group_ok, group_message, group_payload = service.delete_group_dry_run(group_id)
                    if not group_ok:
                        group_details = parse_dry_run_details_v2(group_payload) if parse_dry_run_details_v2 else {}
                        row = _build_delete_result(
                            email,
                            batch_uuid,
                            "BLOCKED_BY_PASSBOLT",
                            message=f"Dry-run groupe bloquant: {group_message}",
                            found=True,
                            user_id=user_id,
                            actual_role=actual_role,
                            activation_state=activation_state,
                            requested_role=requested_role,
                            eligible=False,
                            exclusion_reason="Blocage dry-run groupe",
                            dry_run_status="blocked",
                            dry_run_details=json.dumps({"user": dry_details, "group": group_details}, ensure_ascii=False),
                            ui_dry_run_state=ui_dry_run_state,
                            backend_dry_run_state=backend_dry_run_state,
                            confirmation_checked=confirmation_checked,
                            eligible_count=eligible_count,
                        )
                        results.append(row)
                        log_delete_event(batch_uuid, "dry_run_group", status=row["status"], message=row["message"], email=email)
                        _save_live_log("delete", "warning", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.dry_run.group.blocked", payload={"group_id": group_id, "details": group_details})
                        break
                if results and results[-1].get("email") == email and results[-1].get("status") == "BLOCKED_BY_PASSBOLT":
                    continue

            log_delete_event(batch_uuid, "dry_run", status="ok", message="dry-run success", email=email)
            _save_live_log("delete", "audit", "dry-run success", batch_uuid=batch_uuid, email=email, event_code="delete.dry_run.success")
            if emit:
                emit({"type": "stdout", "message": f"dry-run ok: {email}"})
            row = _build_delete_result(
                email,
                batch_uuid,
                "DRY_RUN_OK",
                message="Dry-run ok (preview only)",
                found=True,
                user_id=user_id,
                actual_role=actual_role,
                activation_state=activation_state,
                requested_role=requested_role,
                eligible=True,
                dry_run_status="ok",
                dry_run_details=json.dumps(dry_details, ensure_ascii=False) if dry_details else "Dry-run validé",
                final_action_allowed=True,
                mode=mode_label,
                final_action="simulation_only",
                endpoint_called=dry_debug.get("endpoint_called", f"/users/{user_id}/dry-run.json"),
                http_method=dry_debug.get("http_method", "DELETE"),
                http_status=dry_debug.get("http_status"),
                response_summary=dry_debug.get("response_summary", "Dry-run validé"),
                user_exists_before=True,
                user_exists_after=True,
                delete_constraints_detected=delete_constraint,
                debug_delete=dry_debug,
                ui_dry_run_state=ui_dry_run_state,
                backend_dry_run_state=backend_dry_run_state,
                confirmation_checked=confirmation_checked,
                eligible_count=eligible_count,
            )
            results.append(row)
            _emit_delete_flow(
                target_user_email=email,
                target_user_id=user_id,
                final_action="simulation_only",
                endpoint_called=row["endpoint_called"],
                http_method=row["http_method"],
                http_status=row["http_status"],
                response_summary=row["response_summary"],
                user_exists_before=True,
                user_exists_after=True,
                delete_constraints_detected=delete_constraint,
            )
            continue

        if not should_execute_real_delete:
            row = _build_delete_result(
                email,
                batch_uuid,
                "DRY_RUN_OK",
                message="Suppression réelle non demandée (confirmation absente)",
                found=True,
                user_id=user_id,
                actual_role=actual_role,
                activation_state=activation_state,
                requested_role=requested_role,
                eligible=True,
                dry_run_status="not_run",
                dry_run_details="Dry-run désactivé",
                final_action_allowed=False,
                mode=mode_label,
                final_action="real_delete_not_confirmed",
                endpoint_called="",
                http_method="",
                http_status=None,
                response_summary="Suppression réelle bloquée : confirmation non cochée",
                user_exists_before=True,
                user_exists_after=True,
                delete_constraints_detected=delete_constraint,
                ui_dry_run_state=ui_dry_run_state,
                backend_dry_run_state=backend_dry_run_state,
                confirmation_checked=confirmation_checked,
                eligible_count=eligible_count,
            )
            results.append(row)
            _emit_delete_flow(
                target_user_email=email,
                target_user_id=user_id,
                final_action=row["final_action"],
                endpoint_called="not_called",
                http_method="N/A",
                http_status=None,
                response_summary=row["response_summary"],
                user_exists_before=True,
                user_exists_after=True,
                delete_constraints_detected=delete_constraint,
            )
            continue

        if emit:
            emit({"type": "progress", "payload": {"current": index, "total": max(total, 1), "percent": round((index / max(total, 1)) * 100, 2), "stage": "delete"}})
        delete_ok, delete_message, delete_payload = service.delete_user(user_id)
        delete_debug = _extract_delete_debug(delete_payload)
        delete_constraint = _detect_delete_constraint(delete_message or "", delete_payload if isinstance(delete_payload, dict) else {})
        if not delete_ok:
            row = _build_delete_result(email, batch_uuid, "ERROR", message=delete_message or "Delete failed", found=True, user_id=user_id, actual_role=actual_role, activation_state=activation_state, requested_role=requested_role, eligible=True, dry_run_status="not_run", dry_run_details="Dry-run non exécuté en mode suppression réelle", final_action_allowed=False, exclusion_reason="Erreur suppression réelle", mode=mode_label, final_action="real_delete_requested", endpoint_called=delete_debug.get("endpoint_called", f"/users/{user_id}.json"), http_method=delete_debug.get("http_method", "DELETE"), http_status=delete_debug.get("http_status"), response_summary=delete_message or "Delete failed", user_exists_before=True, user_exists_after=True, delete_constraints_detected=delete_constraint, debug_delete=delete_debug, ui_dry_run_state=ui_dry_run_state, backend_dry_run_state=backend_dry_run_state, confirmation_checked=confirmation_checked, eligible_count=eligible_count)
            results.append(row)
            _emit_delete_flow(
                target_user_email=email,
                target_user_id=user_id,
                final_action="real_delete_requested",
                endpoint_called=row["endpoint_called"],
                http_method=row["http_method"],
                http_status=row["http_status"],
                response_summary=row["response_summary"],
                user_exists_before=True,
                user_exists_after=True,
                delete_constraints_detected=delete_constraint,
            )
            log_delete_event(batch_uuid, "delete", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "error", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.execute.error")
            continue

        post_status, post_payload, post_message = service.get_user_with_status(user_id)
        post_raw = json.dumps(post_payload, ensure_ascii=False)[:2000] if isinstance(post_payload, dict) else str(post_payload)[:2000]
        user_exists_after = post_status < 400
        confirmed_deleted = (post_status == 404) or ("not found" in (post_message or "").lower()) or ("not found" in post_raw.lower())
        final_action = "real_delete_confirmed" if confirmed_deleted else "real_delete_not_confirmed"
        if confirmed_deleted:
            update_user_delete_state(batch_uuid=batch_uuid, email=email, activation_state="deleted", deletable_candidate=0)
        row = _build_delete_result(email, batch_uuid, "DELETED" if confirmed_deleted else "ERROR", message="Suppression confirmée : utilisateur absent après contrôle." if confirmed_deleted else "Suppression demandée mais non confirmée côté Passbolt", found=True, user_id=user_id, actual_role=actual_role, activation_state="deleted" if confirmed_deleted else activation_state, requested_role=requested_role, eligible=True, dry_run_status="not_run", dry_run_details="Dry-run non exécuté en mode suppression réelle", final_action_allowed=False, exclusion_reason="" if confirmed_deleted else "Suppression demandée mais non confirmée côté Passbolt", mode=mode_label, final_action=final_action, endpoint_called=delete_debug.get("endpoint_called", f"/users/{user_id}.json"), http_method=delete_debug.get("http_method", "DELETE"), http_status=delete_debug.get("http_status"), response_summary=delete_debug.get("response_summary", delete_message), user_exists_before=True, user_exists_after=user_exists_after, delete_constraints_detected=delete_constraint, debug_delete={**delete_debug, "post_delete_check": {"endpoint_called": f"/users/{user_id}.json", "http_method": "GET", "http_status": post_status, "response_summary": post_message, "user_exists_after": user_exists_after, "confirmed_deleted": confirmed_deleted}}, ui_dry_run_state=ui_dry_run_state, backend_dry_run_state=backend_dry_run_state, confirmation_checked=confirmation_checked, eligible_count=eligible_count)
        results.append(row)
        _emit_delete_flow(
            target_user_email=email,
            target_user_id=user_id,
            final_action=final_action,
            endpoint_called=row["endpoint_called"],
            http_method=row["http_method"],
            http_status=row["http_status"],
            response_summary=row["response_summary"],
            user_exists_before=True,
            user_exists_after=user_exists_after,
            delete_constraints_detected=delete_constraint,
            response_raw_path="debug_delete.post_delete_check",
        )
        log_delete_event(batch_uuid, "delete", status=row["status"], message=row["message"], email=email)
        _save_live_log("delete", "audit", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.execute.success")
        if emit:
            emit({"type": "stdout", "message": f"{'deleted+confirmed' if confirmed_deleted else 'delete-not-confirmed'}: {email}"})

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
    done_message = "Dry-run terminé" if dry_run_only else "Suppression réelle terminée"
    if not dry_run_only:
        any_confirmed = any(item.get("final_action") == "real_delete_confirmed" for item in results)
        any_not_confirmed = any(item.get("final_action") == "real_delete_not_confirmed" for item in results)
        if any_confirmed and not any_not_confirmed:
            done_message = "Suppression réelle confirmée"
        elif any_not_confirmed:
            done_message = "Suppression réelle non confirmée"
    _save_live_log("delete", "info", done_message, batch_uuid=batch_uuid, event_code="delete.done", payload={"status": status, "total": total, "dry_run_only": dry_run_only, "mode": mode_label})
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
    response_payload = {
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
        "passbolt_api_module": _passbolt_api_module_status(),
    }
    raw_preview = json.dumps(
        {
            "status": response_payload.get("status"),
            "container": response_payload.get("container"),
            "cli_path": response_payload.get("cli_path"),
            "docker": response_payload.get("docker"),
        },
        ensure_ascii=False,
    )[:500]
    _save_live_log(
        "system",
        "info",
        "Dashboard/API import health probe served",
        event_code="dashboard.import.health.probe",
        payload={
            "endpoint": request.path,
            "http_status": 200,
            "response_raw_preview": raw_preview,
        },
    )
    return jsonify(response_payload)


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
    if PassboltApiAuthServiceV2 is None or PassboltGroupServiceV2 is None:
        return _passbolt_api_unavailable_response("retry-pending-group-assignments")
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
@app.route("/api/delete-config-status", methods=["GET"])
def delete_config_status() -> Any:
    if PassboltApiAuthServiceV2 is None:
        return _passbolt_api_unavailable_response("delete-config-status")
    auth = PassboltApiAuthServiceV2()
    report = auth.run_diagnostic()
    groups_step = next((step for step in report.get("steps", []) if step.get("id") == "groups"), {})
    sign_step = next((step for step in report.get("steps", []) if step.get("id") == "sign"), {})
    jwt_step = next((step for step in report.get("steps", []) if step.get("id") == "jwt_login"), {})
    overall_status = report.get("overall_status")

    message = groups_step.get("message") or "Diagnostic API Passbolt exécuté"
    if sign_step.get("status") == "error":
        message = sign_step.get("message") or "Déverrouillage de la clé privée échoué lors de la signature applicative"
    elif jwt_step.get("status") == "error":
        message = "Crypto locale OK / Login JWT rejeté par Passbolt"

    payload = {
        "configured": overall_status == "ok" and groups_step.get("status") == "success",
        "message": message,
        "overall_status": overall_status,
        "groups_status": groups_step.get("status", "skipped"),
        "sign_status": sign_step.get("status", "skipped"),
        "jwt_login_status": jwt_step.get("status", "skipped"),
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
@app.route("/api/passbolt/health/run", methods=["POST"])
@app.route("/api/passbolt/health", methods=["GET", "POST"])
def passbolt_health() -> Any:
    if PassboltApiAuthServiceV2 is None:
        return _passbolt_api_unavailable_response("passbolt-health")
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
    dry_run_only = _coerce_bool(body.get("dry_run_only"), False)
    ui_context = {
        "ui_dry_run_state": body.get("ui_dry_run_state"),
        "confirmation_checked": body.get("confirmation_checked"),
        "eligible_count": body.get("eligible_count"),
        "blocking_errors": body.get("blocking_errors"),
        "has_deletable_status": body.get("has_deletable_status"),
    }

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

        payload = process_delete_batch(batch_uuid, dry_run_only=dry_run_only, emit=emit, ui_context=ui_context)
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
