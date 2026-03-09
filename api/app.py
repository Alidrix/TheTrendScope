import csv
import json
import os
import re
import subprocess
from typing import Any, Callable

from flask import Flask, Response, jsonify, request, stream_with_context

app = Flask(__name__)

PASSBOLT_CONTAINER = os.getenv("PASSBOLT_CONTAINER", "passbolt-passbolt-1")
PASSBOLT_CLI_PATH = os.getenv("PASSBOLT_CLI_PATH", "/usr/share/php/passbolt/bin/cake")
IMPORT_COMMAND_TIMEOUT = int(os.getenv("IMPORT_COMMAND_TIMEOUT", "60"))

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


def create_user(email: str, first: str, last: str, role: str) -> dict[str, Any]:
    email = _sanitize_value("email", email)
    first = _sanitize_value("firstname", first)
    last = _sanitize_value("lastname", last)
    role = _sanitize_role(role)

    shell_command = (
        f"{PASSBOLT_CLI_PATH} passbolt register_user "
        f"-u {email} -f {first} -l {last} -r {role}"
    )

    command = [
        "docker",
        "exec",
        PASSBOLT_CONTAINER,
        "su",
        "-s",
        "/bin/bash",
        "-c",
        shell_command,
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


def _process_rows(rows: list[dict[str, str]], emit: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    success = 0

    for index, row in enumerate(rows, start=1):
        email = row.get("email", "")
        if emit:
            emit({"type": "log", "message": f"[{index}/{len(rows)}] Start: {email}"})
        try:
            result = create_user(
                email,
                row.get("firstname", ""),
                row.get("lastname", ""),
                row.get("role", ""),
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
        except ValueError as error:
            message = str(error)
            if emit:
                emit({"type": "stderr", "message": message})
            results.append({"email": email, "returncode": -1, "stderr": message, "stdout": "", "command": ""})

    return {"status": "import finished", "total": len(results), "success": success, "results": results}


@app.route("/health", methods=["GET"])
def health() -> Any:
    return jsonify(
        {
            "status": "ok",
            "container": PASSBOLT_CONTAINER,
            "cli_path": PASSBOLT_CLI_PATH,
            "timeout_seconds": IMPORT_COMMAND_TIMEOUT,
        }
    )


@app.route("/import", methods=["POST"])
def import_csv() -> Any:
    rows, error = _parse_rows()
    if error:
        return error
    payload = _process_rows(rows)
    return jsonify(payload)


@app.route("/import-stream", methods=["POST"])
def import_csv_stream() -> Any:
    rows, error = _parse_rows()
    if error:
        return error

    @stream_with_context
    def generate() -> Any:
        results: list[dict[str, Any]] = []
        success = 0
        yield json.dumps({"type": "log", "message": f"Import started for {len(rows)} row(s)"}, ensure_ascii=False) + "\n"

        for index, row in enumerate(rows, start=1):
            email = row.get("email", "")
            yield json.dumps({"type": "log", "message": f"[{index}/{len(rows)}] Start: {email}"}, ensure_ascii=False) + "\n"
            try:
                result = create_user(
                    email,
                    row.get("firstname", ""),
                    row.get("lastname", ""),
                    row.get("role", ""),
                )
                yield json.dumps({"type": "command", "message": result["command"]}, ensure_ascii=False) + "\n"
                if result.get("stdout"):
                    yield json.dumps({"type": "stdout", "message": result["stdout"]}, ensure_ascii=False) + "\n"
                if result.get("stderr"):
                    yield json.dumps({"type": "stderr", "message": result["stderr"]}, ensure_ascii=False) + "\n"
                if result["returncode"] == 0:
                    success += 1
                results.append(result)
            except ValueError as error:
                message = str(error)
                yield json.dumps({"type": "stderr", "message": message}, ensure_ascii=False) + "\n"
                results.append({"email": email, "returncode": -1, "stderr": message, "stdout": "", "command": ""})

        payload = {"status": "import finished", "total": len(results), "success": success, "results": results}
        yield json.dumps({"type": "final", "payload": payload}, ensure_ascii=False) + "\n"

    return Response(generate(), mimetype="application/x-ndjson")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=9090)
