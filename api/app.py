import csv
import json
import os
import re
import shlex
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from typing import Any

import docker
from flask import Flask, Response, jsonify, request, stream_with_context

app = Flask(__name__)

PASSBOLT_CONTAINER = os.getenv("PASSBOLT_CONTAINER", "passbolt-passbolt-1")
PASSBOLT_CLI_PATH = os.getenv("PASSBOLT_CLI_PATH", "/usr/share/php/passbolt/bin/cake")
IMPORT_COMMAND_TIMEOUT = int(os.getenv("IMPORT_COMMAND_TIMEOUT", "60"))
IMPORT_TOTAL_TIMEOUT = int(os.getenv("IMPORT_TOTAL_TIMEOUT", "60"))

docker_client = docker.from_env()

SAFE_FIELD = re.compile(r"^[A-Za-z0-9@._+\-']+$")
SAFE_ROLE = {"user", "admin"}


def _sanitize_value(name: str, value: str) -> str:
    cleaned = (value or "").strip()
    if not cleaned:
        raise ValueError(f"{name} is empty")
    if not SAFE_FIELD.match(cleaned):
        raise ValueError(f"{name} contains invalid characters")
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
                    "email": email,
                    "returncode": -2,
                    "stdout": "",
                    "stderr": f"command timeout after {IMPORT_COMMAND_TIMEOUT}s",
                    "command": command_str,
                }

        stdout, stderr = run.output if isinstance(run.output, tuple) else (run.output, b"")
        return {
            "email": email,
            "returncode": run.exit_code,
            "stdout": _decode_output(stdout),
            "stderr": _decode_output(stderr),
            "command": command_str,
        }
    except Exception as error:
        return {
            "email": email,
            "returncode": -3,
            "stdout": "",
            "stderr": f"unexpected execution error: {error}",
            "command": command_str,
        }


def _parse_rows() -> tuple[list[dict[str, str]], Any]:
    if "file" not in request.files:
        return [], (jsonify({"error": "missing file field"}), 400)

    file = request.files["file"]
    if not file.filename or not file.filename.lower().endswith(".csv"):
        return [], (jsonify({"error": "please upload a .csv file"}), 400)

    decoded = file.read().decode("utf-8", errors="replace").splitlines()
    reader = csv.DictReader(decoded)

    required = {"email", "firstname", "lastname", "role"}
    if not reader.fieldnames or not required.issubset({h.strip().lower() for h in reader.fieldnames}):
        return [], (jsonify({"error": "csv headers must include email, firstname, lastname, role"}), 400)

    rows = [{k.strip().lower(): (v or "") for k, v in raw_row.items()} for raw_row in reader]
    return rows, None


def _process_rows(rows: list[dict[str, str]], container: str, cli_path: str, emit: Any = None) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    success = 0
    started = time.time()

    for index, row in enumerate(rows, start=1):
        if time.time() - started > IMPORT_TOTAL_TIMEOUT:
            timeout_message = f"global import timeout after {IMPORT_TOTAL_TIMEOUT}s"
            if emit:
                emit({"type": "stderr", "message": timeout_message})
            results.append(
                {
                    "email": row.get("email", ""),
                    "returncode": -4,
                    "stderr": timeout_message,
                    "stdout": "",
                    "command": "",
                }
            )
            break

        email = row.get("email", "")
        if emit:
            emit({"type": "log", "message": f"[{index}/{len(rows)}] Start: {email}"})

        try:
            result = create_user(
                email,
                row.get("firstname", ""),
                row.get("lastname", ""),
                row.get("role", ""),
                container,
                cli_path,
            )
            if emit:
                emit({"type": "command", "message": result["command"]})
            if result.get("stdout"):
                emit({"type": "stdout", "message": result["stdout"]})
            if result.get("stderr"):
                emit({"type": "stderr", "message": result["stderr"]})

            if result["returncode"] == 0:
                success += 1

            results.append(result)

        except Exception as error:
            message = str(error)
            if emit:
                emit({"type": "stderr", "message": message})
            results.append({"email": email, "returncode": -1, "stderr": message, "stdout": "", "command": ""})

    return {"status": "import finished", "total": len(results), "success": success, "results": results}


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


@app.route("/import", methods=["POST"])
def import_csv() -> Any:
    rows, error = _parse_rows()
    if error:
        return error

    diagnostics = diagnose_environment()
    container = diagnostics.get("resolved_container", PASSBOLT_CONTAINER)
    cli_path = diagnostics.get("resolved_cli_path", PASSBOLT_CLI_PATH)

    payload = _process_rows(rows, container, cli_path)
    payload["diagnostics"] = diagnostics
    return jsonify(payload)


@app.route("/import-stream", methods=["POST"])
def import_csv_stream() -> Any:
    rows, error = _parse_rows()
    if error:
        return error

    diagnostics = diagnose_environment()
    container = diagnostics.get("resolved_container", PASSBOLT_CONTAINER)
    cli_path = diagnostics.get("resolved_cli_path", PASSBOLT_CLI_PATH)

    @stream_with_context
    def generate() -> Any:
        started = time.time()
        results: list[dict[str, Any]] = []
        success = 0

        yield json.dumps({"type": "log", "message": f"Import started for {len(rows)} row(s)"}, ensure_ascii=False) + "\n"
        yield json.dumps({"type": "log", "message": f"Container: {container}"}, ensure_ascii=False) + "\n"
        yield json.dumps({"type": "log", "message": f"CLI path: {cli_path}"}, ensure_ascii=False) + "\n"
        yield json.dumps({"type": "debug", "payload": diagnostics}, ensure_ascii=False) + "\n"

        for index, row in enumerate(rows, start=1):
            if time.time() - started > IMPORT_TOTAL_TIMEOUT:
                timeout_message = f"global import timeout after {IMPORT_TOTAL_TIMEOUT}s"
                yield json.dumps({"type": "stderr", "message": timeout_message}, ensure_ascii=False) + "\n"
                break

            email = row.get("email", "")
            yield json.dumps({"type": "log", "message": f"[{index}/{len(rows)}] Start: {email}"}, ensure_ascii=False) + "\n"

            try:
                result = create_user(
                    email,
                    row.get("firstname", ""),
                    row.get("lastname", ""),
                    row.get("role", ""),
                    container,
                    cli_path,
                )
                yield json.dumps({"type": "command", "message": result["command"]}, ensure_ascii=False) + "\n"

                if result.get("stdout"):
                    yield json.dumps({"type": "stdout", "message": result["stdout"]}, ensure_ascii=False) + "\n"
                if result.get("stderr"):
                    yield json.dumps({"type": "stderr", "message": result["stderr"]}, ensure_ascii=False) + "\n"

                if result["returncode"] == 0:
                    success += 1

                results.append(result)

            except Exception as error:
                message = str(error)
                yield json.dumps({"type": "stderr", "message": message}, ensure_ascii=False) + "\n"
                results.append({"email": email, "returncode": -1, "stderr": message, "stdout": "", "command": ""})

        payload = {
            "status": "import finished",
            "total": len(results),
            "success": success,
            "results": results,
            "diagnostics": diagnostics,
        }
        yield json.dumps({"type": "final", "payload": payload}, ensure_ascii=False) + "\n"

    return Response(generate(), mimetype="application/x-ndjson")


@app.errorhandler(Exception)
def handle_exception(error: Exception) -> Any:
    return jsonify({"error": str(error), "type": error.__class__.__name__}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=9090)
