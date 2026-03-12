import csv
import io
import json
import os
import re
import shlex
import time
import uuid
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from threading import Lock
from typing import Any

import docker
import requests
from flask import Flask, Response, jsonify, request, stream_with_context

from db import (
    create_import_batch,
    finalize_import_batch,
    get_batch,
    get_batch_user_records,
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

app = Flask(__name__)
init_db()


PASSBOLT_CONTAINER = os.getenv("PASSBOLT_CONTAINER", "passbolt-passbolt-1")
PASSBOLT_CLI_PATH = os.getenv("PASSBOLT_CLI_PATH", "/usr/share/php/passbolt/bin/cake")
IMPORT_COMMAND_TIMEOUT = int(os.getenv("IMPORT_COMMAND_TIMEOUT", "60"))
IMPORT_TOTAL_TIMEOUT = int(os.getenv("IMPORT_TOTAL_TIMEOUT", "60"))
GROUP_LIST_COMMAND = os.getenv("PASSBOLT_GROUP_LIST_COMMAND", "passbolt list_groups")
GROUP_CREATE_COMMAND = os.getenv("PASSBOLT_GROUP_CREATE_COMMAND", "passbolt create_group -n {group}")
GROUP_ASSIGN_COMMAND = os.getenv("PASSBOLT_GROUP_ASSIGN_COMMAND", "passbolt add_user_to_group -u {email} -g {group}")
ROLLBACK_COMMAND = os.getenv("PASSBOLT_ROLLBACK_COMMAND", "")
DELETE_USER_COMMAND = os.getenv("PASSBOLT_DELETE_USER_COMMAND", "passbolt delete_user -u {email}")
PASSBOLT_URL = os.getenv("PASSBOLT_URL", "").rstrip("/")
PASSBOLT_API_TOKEN = os.getenv("PASSBOLT_API_TOKEN", "")
PASSBOLT_VERIFY_TLS = os.getenv("PASSBOLT_VERIFY_TLS", "true").lower() not in {"0", "false", "no"}

DELETE_ALLOWED_PENDING_STATES = {"pending", "unknown", "", None}
DELETE_ACTIVE_STATES = {"active", "activated", "setup_completed", "enabled"}

docker_client = docker.from_env()

SAFE_FIELD = re.compile(r"^[A-Za-z0-9@._+\-']+$")
SAFE_GROUP = re.compile(r"^[A-Za-z0-9 _@.\-']+$")
SAFE_ROLE = {"user", "admin"}
PENDING_ASSIGNMENTS: list[dict[str, Any]] = []
PENDING_LOCK = Lock()


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


class GroupService:
    def __init__(self, container_name: str, cli_path: str) -> None:
        self.container_name = container_name
        self.cli_path = cli_path

    def list_groups(self) -> dict[str, Any]:
        shell_command = f"{shlex.quote(self.cli_path)} {GROUP_LIST_COMMAND}"
        result = _run_shell_command(self.container_name, self.cli_path, shell_command)
        groups: set[str] = set()
        if result["returncode"] == 0:
            out = result.get("stdout", "")
            try:
                payload = json.loads(out) if out else []
                if isinstance(payload, list):
                    for item in payload:
                        name = (item.get("name") if isinstance(item, dict) else "") or ""
                        if name:
                            groups.add(name.strip())
            except Exception:
                for line in out.splitlines():
                    guess = line.strip(" -\t")
                    if guess:
                        groups.add(guess)
        return {"result": result, "groups": groups}

    def create_group(self, group_name: str) -> dict[str, Any]:
        group_name = _sanitize_group_name(group_name)
        shell_command = f"{shlex.quote(self.cli_path)} {GROUP_CREATE_COMMAND.format(group=shlex.quote(group_name))}"
        return _run_shell_command(self.container_name, self.cli_path, shell_command)

    def assign_user_to_group(self, email: str, group_name: str) -> dict[str, Any]:
        group_name = _sanitize_group_name(group_name)
        email = _sanitize_value("email", email)
        shell_command = (
            f"{shlex.quote(self.cli_path)} "
            f"{GROUP_ASSIGN_COMMAND.format(email=shlex.quote(email), group=shlex.quote(group_name))}"
        )
        return _run_shell_command(self.container_name, self.cli_path, shell_command)


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

class PassboltDeleteService:
    def __init__(self) -> None:
        self.base_url = PASSBOLT_URL
        self.api_token = PASSBOLT_API_TOKEN

    def enabled(self) -> bool:
        return bool(self.base_url and self.api_token)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def _request(self, method: str, path: str) -> tuple[int, dict[str, Any], str]:
        if not self.enabled():
            return 500, {}, "PASSBOLT_URL/PASSBOLT_API_TOKEN are not configured"
        try:
            response = requests.request(
                method,
                f"{self.base_url}{path}",
                headers=self._headers(),
                timeout=30,
                verify=PASSBOLT_VERIFY_TLS,
            )
            payload: dict[str, Any] = {}
            try:
                payload = response.json() if response.text else {}
            except Exception:
                payload = {}
            message = ""
            if isinstance(payload, dict):
                for key in ("message", "error"):
                    if payload.get(key):
                        message = str(payload[key])
                        break
                body = payload.get("body")
                if not message and isinstance(body, dict):
                    message = str(body.get("message") or body.get("error") or "")
            if not message:
                message = response.text.strip()[:500]
            return response.status_code, payload, message
        except requests.RequestException as error:
            return 502, {}, str(error)

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

    def delete_user_real(self, user_id: str) -> tuple[bool, str, dict[str, Any]]:
        status, payload, message = self._request("DELETE", f"/users/{user_id}.json")
        return status < 300, message, payload


def _build_delete_result(email: str, batch_uuid: str, status: str, message: str = "", found: bool = False, user_id: str = "", actual_role: str = "", activation_state: str = "") -> dict[str, Any]:
    return {
        "email": email,
        "batch_uuid": batch_uuid,
        "found": found,
        "user_id": user_id,
        "actual_role": actual_role,
        "activation_state": activation_state,
        "status": status,
        "message": message,
    }


def process_delete_batch(batch_uuid: str, dry_run_only: bool = False, emit: Any = None) -> dict[str, Any]:
    batch = get_batch(batch_uuid)
    if not batch:
        return {"error": "batch not found", "batch_uuid": batch_uuid}

    users = get_batch_user_records(batch_uuid)
    total = len(users)
    service = PassboltDeleteService()
    results: list[dict[str, Any]] = []

    if emit:
        emit({"type": "log", "message": f"Delete batch {batch_uuid} started ({total} user(s))"})
        emit({"type": "progress", "payload": {"current": 0, "total": max(total, 1), "percent": 0, "stage": "load-batch"}})
    _save_live_log("delete", "info", f"Delete batch {batch_uuid} started ({total} user(s))", batch_uuid=batch_uuid, event_code="delete.start")

    log_delete_event(batch_uuid, "batch_selected", status="info", message=f"dry_run_only={dry_run_only}")

    if not service.enabled():
        message = "Passbolt delete API is not configured"
        if emit:
            emit({"type": "stderr", "message": message})
        _save_live_log("delete", "error", message, batch_uuid=batch_uuid, event_code="delete.config.missing")
        return {"batch_uuid": batch_uuid, "status": "error", "message": message, "results": []}

    latest_batch = is_latest_batch(batch_uuid)

    for index, user in enumerate(users, start=1):
        email = (user.get("email") or "").strip().lower()
        created_by_tool = int(user.get("created_by_tool") or 0) == 1
        activation_state_local = (user.get("last_known_activation_state") or "unknown").lower()

        if emit:
            emit({"type": "progress", "payload": {"current": index, "total": max(total, 1), "percent": round((index / max(total, 1)) * 100, 2), "stage": "lookup"}})

        if not created_by_tool:
            row = _build_delete_result(email, batch_uuid, "SKIPPED_NOT_TOOL_MANAGED", message="User not created by tool")
            results.append(row)
            log_delete_event(batch_uuid, "filter", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "warning", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.filter.not_tool")
            continue

        if (not latest_batch) and activation_state_local not in DELETE_ALLOWED_PENDING_STATES:
            row = _build_delete_result(email, batch_uuid, "SKIPPED_ACTIVE_USER", message="Old batches can only delete pending users", activation_state=activation_state_local)
            results.append(row)
            log_delete_event(batch_uuid, "filter", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "warning", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.filter.active")
            continue

        try:
            passbolt_user = service.find_user_by_email(email)
        except Exception as error:
            row = _build_delete_result(email, batch_uuid, "ERROR", message=str(error))
            results.append(row)
            log_delete_event(batch_uuid, "lookup", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "error", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.lookup.error")
            continue

        if not passbolt_user:
            row = _build_delete_result(email, batch_uuid, "NOT_FOUND", message="User not found in Passbolt")
            results.append(row)
            log_delete_event(batch_uuid, "lookup", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "warning", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.lookup.not_found")
            continue

        user_id = str(passbolt_user.get("id") or passbolt_user.get("user_id") or "")
        actual_role = service._resolve_role(passbolt_user)
        activation_state = service._resolve_activation_state(passbolt_user, activation_state_local)

        if actual_role == "admin":
            row = _build_delete_result(email, batch_uuid, "SKIPPED_ADMIN", message="Admin users are always protected", found=True, user_id=user_id, actual_role=actual_role, activation_state=activation_state)
            results.append(row)
            log_delete_event(batch_uuid, "filter", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "warning", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.filter.admin")
            continue

        if actual_role != "user":
            row = _build_delete_result(email, batch_uuid, "ERROR", message=f"Unsupported role: {actual_role}", found=True, user_id=user_id, actual_role=actual_role, activation_state=activation_state)
            results.append(row)
            log_delete_event(batch_uuid, "filter", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "error", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.filter.role")
            continue

        if activation_state in DELETE_ACTIVE_STATES:
            row = _build_delete_result(email, batch_uuid, "SKIPPED_ACTIVE_USER", message="Activated account cannot be deleted", found=True, user_id=user_id, actual_role=actual_role, activation_state=activation_state)
            results.append(row)
            log_delete_event(batch_uuid, "filter", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "warning", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.filter.activated")
            continue

        if emit:
            emit({"type": "progress", "payload": {"current": index, "total": max(total, 1), "percent": round((index / max(total, 1)) * 100, 2), "stage": "dry-run"}})
        dry_ok, dry_message, _ = service.delete_user_dry_run(user_id)
        if not dry_ok:
            row = _build_delete_result(email, batch_uuid, "BLOCKED_BY_PASSBOLT", message=dry_message or "Dry-run rejected by Passbolt", found=True, user_id=user_id, actual_role=actual_role, activation_state=activation_state)
            results.append(row)
            log_delete_event(batch_uuid, "dry_run", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "warning", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.dry_run.blocked")
            continue

        log_delete_event(batch_uuid, "dry_run", status="ok", message="dry-run success", email=email)
        _save_live_log("delete", "audit", "dry-run success", batch_uuid=batch_uuid, email=email, event_code="delete.dry_run.success")
        if dry_run_only:
            row = _build_delete_result(email, batch_uuid, "DELETED", message="Dry-run ok (preview only)", found=True, user_id=user_id, actual_role=actual_role, activation_state=activation_state)
            results.append(row)
            continue

        if emit:
            emit({"type": "progress", "payload": {"current": index, "total": max(total, 1), "percent": round((index / max(total, 1)) * 100, 2), "stage": "delete"}})
        delete_ok, delete_message, _ = service.delete_user_real(user_id)
        if not delete_ok:
            row = _build_delete_result(email, batch_uuid, "ERROR", message=delete_message or "Delete failed", found=True, user_id=user_id, actual_role=actual_role, activation_state=activation_state)
            results.append(row)
            log_delete_event(batch_uuid, "delete", status=row["status"], message=row["message"], email=email)
            _save_live_log("delete", "error", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.execute.error")
            continue

        update_user_delete_state(batch_uuid=batch_uuid, email=email, activation_state="deleted", deletable_candidate=0)
        row = _build_delete_result(email, batch_uuid, "DELETED", message="User deleted", found=True, user_id=user_id, actual_role=actual_role, activation_state="deleted")
        results.append(row)
        log_delete_event(batch_uuid, "delete", status=row["status"], message=row["message"], email=email)
        _save_live_log("delete", "audit", row["message"], batch_uuid=batch_uuid, email=email, event_code="delete.execute.success")

    status = "success" if all(item["status"] in {"DELETED", "SKIPPED_ADMIN", "SKIPPED_NOT_TOOL_MANAGED", "SKIPPED_ACTIVE_USER", "NOT_FOUND", "BLOCKED_BY_PASSBOLT"} for item in results) else "partial"
    if emit:
        emit({"type": "progress", "payload": {"current": total, "total": max(total, 1), "percent": 100, "stage": "done"}})
    result_payload = {
        "batch_uuid": batch_uuid,
        "status": status,
        "dry_run_only": dry_run_only,
        "total": total,
        "results": results,
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
    group_service = GroupService(container, cli_path)
    preview = preview_rows(rows)
    batch_uuid = str(uuid.uuid4())
    create_import_batch(batch_uuid=batch_uuid, filename=source_filename, total_rows=len(rows), status="running")
    _save_live_log("import", "info", "Import batch record created", batch_uuid=batch_uuid, event_code="import.batch.created", payload={"filename": source_filename, "total_rows": len(rows)})

    valid_rows = [row for row in preview["rows"] if row["valid"]]
    total_valid = len(valid_rows)
    results: list[dict[str, Any]] = []
    created_users: list[str] = []
    created_groups_in_batch: set[str] = set()
    known_groups: set[str] = set()
    groups_created_total = 0
    groups_assigned_total = 0
    groups_deferred_total = 0

    _emit_structured(emit, "info", "import.start", "Import batch started", total_rows=len(rows), rollback_on_error=rollback_on_error)
    list_result = group_service.list_groups()
    if list_result["result"]["returncode"] == 0:
        known_groups = {g.lower(): g for g in list_result["groups"]}
    elif emit:
        emit({"type": "stderr", "message": "Impossible de lister les groupes, création best effort"})
        _emit_structured(emit, "warning", "groups.list.failed", "Failed to list groups, using best effort")

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
            if normalized not in known_groups:
                if emit:
                    emit({"type": "progress", "payload": {"current": index, "total": len(rows), "percent": int((index / max(len(rows), 1)) * 100), "stage": "create-group"}})
                create_result = group_service.create_group(group)
                if create_result["returncode"] == 0 or "already" in (create_result.get("stderr", "").lower()):
                    if create_result["returncode"] == 0:
                        groups_created_total += 1
                        user_payload["groups_created"].append(group)
                        created_groups_in_batch.add(group)
                        _emit_structured(emit, "info", "group.create.success", "Group created", row=index, group=group, email=email)
                    known_groups[normalized] = group
                else:
                    user_payload["errors"].append(f"group {group}: {create_result.get('stderr', 'creation failed')}")
                    _emit_structured(emit, "error", "group.create.failed", "Group creation failed", row=index, group=group, email=email, stderr=create_result.get("stderr", ""))
                    if _critical_error(create_result):
                        critical_error = True
                    continue

            if emit:
                emit({"type": "progress", "payload": {"current": index, "total": len(rows), "percent": int((index / max(len(rows), 1)) * 100), "stage": "assign-group"}})

            if user_result["returncode"] != 0:
                user_payload["groups_deferred"].append(group)
                groups_deferred_total += 1
                _append_pending({"email": email, "group": group, "reason": "user creation failed", "status": "deferred"})
                continue

            assign_result = group_service.assign_user_to_group(email, group)
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

        events: list[dict[str, Any]] = []

        def emit(event: dict[str, Any]) -> None:
            events.append(event)

        payload = _process_rows(
            rows,
            container,
            cli_path,
            rollback_on_error=rollback_on_error,
            source_filename=source_filename,
            emit=emit,
        )

        for event in events:
            yield json.dumps(event, ensure_ascii=False) + "\n"

        payload["diagnostics"] = diagnostics
        _save_live_log("import", "info", "Import stream completed", batch_uuid=payload.get("batch_uuid"), event_code="import.stream.done", payload={"status": payload.get("status"), "total": payload.get("total")})
        yield json.dumps({"type": "final", "payload": payload}, ensure_ascii=False) + "\n"

    return Response(generate(), mimetype="application/x-ndjson")


@app.route("/pending-group-assignments", methods=["GET"])
def pending_group_assignments() -> Any:
    with PENDING_LOCK:
        payload = list(PENDING_ASSIGNMENTS)
    return jsonify({"total": len(payload), "items": payload})


@app.route("/retry-pending-group-assignments", methods=["POST"])
def retry_pending_group_assignments() -> Any:
    diagnostics = diagnose_environment()
    container = diagnostics.get("resolved_container", PASSBOLT_CONTAINER)
    cli_path = diagnostics.get("resolved_cli_path", PASSBOLT_CLI_PATH)
    group_service = GroupService(container, cli_path)

    retried: list[dict[str, Any]] = []
    still_pending: list[dict[str, Any]] = []
    with PENDING_LOCK:
        current = list(PENDING_ASSIGNMENTS)
        PENDING_ASSIGNMENTS.clear()

    for item in current:
        result = group_service.assign_user_to_group(item["email"], item["group"])
        if result["returncode"] == 0:
            retried.append({"email": item["email"], "group": item["group"], "status": "assigned"})
        else:
            item["reason"] = result.get("stderr") or item.get("reason", "retry failed")
            still_pending.append(item)

    with PENDING_LOCK:
        PENDING_ASSIGNMENTS.extend(still_pending)

    return jsonify({"retried": retried, "pending": still_pending, "pending_total": len(still_pending)})


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


@app.route("/logs", methods=["GET", "DELETE"])
def logs_collection() -> Any:
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


@app.route("/logs/summary", methods=["GET"])
def logs_summary() -> Any:
    batch_uuid, scope, level = _logs_filters_from_request()
    payload = get_logs_summary(batch_uuid=batch_uuid, scope=scope, level=level)
    payload["filters"] = {"batch_uuid": batch_uuid, "scope": scope, "level": level}
    return jsonify(payload)


@app.route("/logs/export.csv", methods=["GET"])
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

def batches() -> Any:
    return jsonify({"items": list_import_batches()})


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
    users = get_deletable_users_for_batch(batch_uuid)
    return jsonify({"batch_uuid": batch_uuid, "total": len(users), "items": users})


@app.route("/db/summary", methods=["GET"])
def db_summary() -> Any:
    return jsonify(get_db_summary())


@app.errorhandler(Exception)
def handle_exception(error: Exception) -> Any:
    return jsonify({"error": str(error), "type": error.__class__.__name__}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=9090)
