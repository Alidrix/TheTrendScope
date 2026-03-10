import csv
import json
import os
import re
import shlex
import subprocess
import time
from typing import Any

from flask import Flask, Response, jsonify, request, stream_with_context

app = Flask(__name__)

PASSBOLT_CONTAINER = os.getenv("PASSBOLT_CONTAINER", "passbolt-passbolt-1")
PASSBOLT_CLI_PATH = os.getenv("PASSBOLT_CLI_PATH", "/usr/share/php/passbolt/bin/cake")
IMPORT_COMMAND_TIMEOUT = int(os.getenv("IMPORT_COMMAND_TIMEOUT", "60"))
IMPORT_TOTAL_TIMEOUT = int(os.getenv("IMPORT_TOTAL_TIMEOUT", "60"))
DOCKER_BIN = os.getenv("DOCKER_BIN", "/usr/bin/docker")
DOCKER_COMMAND_PREFIX = [DOCKER_BIN]

SAFE_FIELD = re.compile(r"^[A-Za-z0-9@._+\-']+$")
SAFE_ROLE = {"user", "admin"}


def _run_command(command: list[str], timeout: int = 10) -> tuple[int, str, str]:
    run = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    return run.returncode, run.stdout.strip(), run.stderr.strip()


def _docker_command(*args: str) -> list[str]:
    return [*DOCKER_COMMAND_PREFIX, *args]


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


def _detect_container() -> str:
    code, out, _ = _run_command(_docker_command("ps", "--format", "{{.Names}}"), timeout=10)
    if code != 0:
        return PASSBOLT_CONTAINER
    names = [line.strip() for line in out.splitlines() if line.strip()]
    if PASSBOLT_CONTAINER in names:
        return PASSBOLT_CONTAINER
    candidates = [n for n in names if "passbolt" in n and "db" not in n and "traefik" not in n]
    return candidates[0] if candidates else PASSBOLT_CONTAINER


def _detect_cli_path(container: str) -> str:
    candidates = [
        PASSBOLT_CLI_PATH,
        "/usr/share/php/passbolt/bin/cake",
        "/var/www/passbolt/bin/cake",
    ]
    for path in candidates:
        code, _, _ = _run_command(_docker_command("exec", container, "test", "-x", path), timeout=10)
        if code == 0:
            return path
    return PASSBOLT_CLI_PATH


def diagnose_environment() -> dict[str, Any]:
    diagnostics: dict[str, Any] = {
        "configured_container": PASSBOLT_CONTAINER,
        "configured_cli_path": PASSBOLT_CLI_PATH,
        "configured_docker_bin": DOCKER_BIN,
        "checks": [],
        "recommendations": [],
    }

    try:
        code, out, err = _run_command(_docker_command("ps", "--format", "{{.Names}}"), timeout=10)
        if code != 0:
            diagnostics["checks"].append({"name": "docker_ps", "ok": False, "stderr": err})
            diagnostics["recommendations"].append("docker ps ne répond pas dans le conteneur API")
            diagnostics["resolved_container"] = PASSBOLT_CONTAINER
            diagnostics["resolved_cli_path"] = PASSBOLT_CLI_PATH
            return diagnostics

        names = [line.strip() for line in out.splitlines() if line.strip()]
        diagnostics["checks"].append({"name": "docker_ps", "ok": True, "containers": names})

        resolved_container = PASSBOLT_CONTAINER if PASSBOLT_CONTAINER in names else _detect_container()
        diagnostics["resolved_container"] = resolved_container
        diagnostics["checks"].append(
            {
                "name": "container_selection",
                "ok": resolved_container in names,
                "selected": resolved_container,
                "auto_selected": resolved_container != PASSBOLT_CONTAINER,
            }
        )

        if resolved_container not in names:
            diagnostics["recommendations"].append("Le conteneur Passbolt cible est introuvable")
            diagnostics["resolved_cli_path"] = PASSBOLT_CLI_PATH
            return diagnostics

        resolved_cli_path = _detect_cli_path(resolved_container)
        diagnostics["resolved_cli_path"] = resolved_cli_path
        diagnostics["checks"].append(
            {
                "name": "cli_path_check",
                "ok": resolved_cli_path == PASSBOLT_CLI_PATH,
                "selected": resolved_cli_path,
                "auto_selected": resolved_cli_path != PASSBOLT_CLI_PATH,
            }
        )

        if resolved_cli_path != PASSBOLT_CLI_PATH:
            diagnostics["recommendations"].append(
                f"PATH CLI ajusté automatiquement vers {resolved_cli_path}"
            )

    except Exception as error:
        diagnostics["checks"].append({"name": "diagnostics_exception", "ok": False, "stderr": str(error)})
        diagnostics["resolved_container"] = PASSBOLT_CONTAINER
        diagnostics["resolved_cli_path"] = PASSBOLT_CLI_PATH
        diagnostics["recommendations"].append("Erreur pendant l'auto-diagnostic")

    return diagnostics


def create_user(email: str, first: str, last: str, role: str, container: str, cli_path: str) -> dict[str, Any]:
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

    command = [
        *_docker_command("exec", container),
        "su",
        "-m",
        "-c",
        shell_command,
        "-s",
        "/bin/sh",
        "www-data",
    ]

    try:
        run = subprocess.run(command, capture_output=True, text=True, timeout=IMPORT_COMMAND_TIMEOUT)
        return {
            "email": email,
            "returncode": run.returncode,
            "stdout": run.stdout.strip(),
            "stderr": run.stderr.strip(),
            "command": " ".join(command),
        }
    except subprocess.TimeoutExpired as error:
        return {
            "email": email,
            "returncode": -2,
            "stdout": (error.stdout or "").strip() if error.stdout else "",
            "stderr": f"command timeout after {IMPORT_COMMAND_TIMEOUT}s",
            "command": " ".join(command),
        }
    except Exception as error:
        return {
            "email": email,
            "returncode": -3,
            "stdout": "",
            "stderr": f"unexpected execution error: {error}",
            "command": " ".join(command),
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
    return jsonify(
        {
            "status": "ok",
            "container": diagnostics.get("resolved_container", PASSBOLT_CONTAINER),
            "cli_path": diagnostics.get("resolved_cli_path", PASSBOLT_CLI_PATH),
            "timeout_seconds": IMPORT_COMMAND_TIMEOUT,
            "total_timeout_seconds": IMPORT_TOTAL_TIMEOUT,
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
