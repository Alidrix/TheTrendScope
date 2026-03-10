import csv
import io
import json
import os
import re
import shlex
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from threading import Lock
from typing import Any

import docker
from flask import Flask, Response, jsonify, request, stream_with_context

app = Flask(__name__)

PASSBOLT_CONTAINER = os.getenv("PASSBOLT_CONTAINER", "passbolt-passbolt-1")
PASSBOLT_CLI_PATH = os.getenv("PASSBOLT_CLI_PATH", "/usr/share/php/passbolt/bin/cake")
IMPORT_COMMAND_TIMEOUT = int(os.getenv("IMPORT_COMMAND_TIMEOUT", "60"))
IMPORT_TOTAL_TIMEOUT = int(os.getenv("IMPORT_TOTAL_TIMEOUT", "60"))
GROUP_LIST_COMMAND = os.getenv("PASSBOLT_GROUP_LIST_COMMAND", "passbolt list_groups")
GROUP_CREATE_COMMAND = os.getenv("PASSBOLT_GROUP_CREATE_COMMAND", "passbolt create_group -n {group}")
GROUP_ASSIGN_COMMAND = os.getenv("PASSBOLT_GROUP_ASSIGN_COMMAND", "passbolt add_user_to_group -u {email} -g {group}")
ROLLBACK_COMMAND = os.getenv("PASSBOLT_ROLLBACK_COMMAND", "")
DELETE_USER_COMMAND = os.getenv("PASSBOLT_DELETE_USER_COMMAND", "passbolt delete_user -u {email}")

docker_client = docker.from_env()

SAFE_FIELD = re.compile(r"^[A-Za-z0-9@._+\-']+$")
SAFE_GROUP = re.compile(r"^[A-Za-z0-9 _@.\-']+$")
SAFE_ROLE = {"user", "admin"}
PENDING_ASSIGNMENTS: list[dict[str, Any]] = []
PENDING_LOCK = Lock()
LAST_IMPORTED_USERS: list[str] = []
LAST_IMPORTED_USERS_LOCK = Lock()


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
    if not emit:
        return
    payload = {"level": level, "code": code, "message": message, **extra}
    emit({"type": "audit", "payload": payload})


def _set_last_imported_users(users: list[str]) -> None:
    with LAST_IMPORTED_USERS_LOCK:
        LAST_IMPORTED_USERS.clear()
        LAST_IMPORTED_USERS.extend(users)

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


def _process_rows(rows: list[dict[str, Any]], container: str, cli_path: str, rollback_on_error: bool, emit: Any = None) -> dict[str, Any]:
    started = time.time()
    group_service = GroupService(container, cli_path)
    preview = preview_rows(rows)

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
            _emit_structured(emit, "info", "user.create.success", "User created", row=index, email=email)
        else:
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

        results.append(user_payload)

        if rollback_on_error and critical_error:
            break

    rollback = None
    final_status = "success"
    errors_count = sum(1 for item in results if item.get("user_create_status") != "success")

    _set_last_imported_users(created_users)

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

    return {
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
        return error
    return jsonify(preview_rows(rows))


@app.route("/import", methods=["POST"])
def import_csv() -> Any:
    rows, error = parse_csv_rows(request.files.get("file"))
    if error:
        return error

    rollback_on_error = str(request.form.get("rollback_on_error", "false")).lower() == "true"
    diagnostics = diagnose_environment()
    container = diagnostics.get("resolved_container", PASSBOLT_CONTAINER)
    cli_path = diagnostics.get("resolved_cli_path", PASSBOLT_CLI_PATH)

    payload = _process_rows(rows, container, cli_path, rollback_on_error=rollback_on_error)
    payload["diagnostics"] = diagnostics
    return jsonify(payload)


@app.route("/import-stream", methods=["POST"])
def import_csv_stream() -> Any:
    rows, error = parse_csv_rows(request.files.get("file"))
    if error:
        return error

    rollback_on_error = str(request.form.get("rollback_on_error", "false")).lower() == "true"
    diagnostics = diagnose_environment()
    container = diagnostics.get("resolved_container", PASSBOLT_CONTAINER)
    cli_path = diagnostics.get("resolved_cli_path", PASSBOLT_CLI_PATH)

    @stream_with_context
    def generate() -> Any:
        yield json.dumps({"type": "log", "message": f"Import started for {len(rows)} row(s)"}, ensure_ascii=False) + "\n"
        yield json.dumps({"type": "debug", "payload": diagnostics}, ensure_ascii=False) + "\n"

        events: list[dict[str, Any]] = []

        def emit(event: dict[str, Any]) -> None:
            events.append(event)

        payload = _process_rows(rows, container, cli_path, rollback_on_error=rollback_on_error, emit=emit)

        for event in events:
            yield json.dumps(event, ensure_ascii=False) + "\n"

        payload["diagnostics"] = diagnostics
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
    diagnostics = diagnose_environment()
    container = diagnostics.get("resolved_container", PASSBOLT_CONTAINER)
    cli_path = diagnostics.get("resolved_cli_path", PASSBOLT_CLI_PATH)

    with LAST_IMPORTED_USERS_LOCK:
        target_users = list(LAST_IMPORTED_USERS)

    if not target_users:
        return jsonify({"status": "no-op", "message": "no users from latest import", "deleted": [], "errors": []})

    deleted: list[str] = []
    errors: list[dict[str, str]] = []

    for email in target_users:
        shell_command = f"{shlex.quote(cli_path)} {DELETE_USER_COMMAND.format(email=shlex.quote(email))}"
        result = _run_shell_command(container, cli_path, shell_command)
        if result.get("returncode") == 0:
            deleted.append(email)
        else:
            errors.append({"email": email, "error": result.get("stderr", "delete failed")})

    if deleted:
        with LAST_IMPORTED_USERS_LOCK:
            LAST_IMPORTED_USERS[:] = [email for email in LAST_IMPORTED_USERS if email not in deleted]

    status = "success" if not errors else "partial"
    return jsonify({"status": status, "deleted": deleted, "errors": errors, "total_requested": len(target_users)})


@app.errorhandler(Exception)
def handle_exception(error: Exception) -> Any:
    return jsonify({"error": str(error), "type": error.__class__.__name__}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=9090)
