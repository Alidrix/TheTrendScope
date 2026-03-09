import csv
import os
import re
import subprocess
from typing import Any

from flask import Flask, jsonify, request

app = Flask(__name__)

PASSBOLT_CONTAINER = os.getenv("PASSBOLT_CONTAINER", "passbolt-passbolt-1")
PASSBOLT_CLI_PATH = os.getenv("PASSBOLT_CLI_PATH", "/usr/share/php/passbolt/bin/cake")

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

    command = [
        "docker",
        "exec",
        PASSBOLT_CONTAINER,
        "su",
        "-s",
        "/bin/bash",
        "-c",
        (
            f"{PASSBOLT_CLI_PATH} passbolt register_user "
            f"-u {email} -f {first} -l {last} -r {role}"
        ),
        "www-data",
    ]

    run = subprocess.run(command, capture_output=True, text=True)
    return {
        "email": email,
        "returncode": run.returncode,
        "stdout": run.stdout.strip(),
        "stderr": run.stderr.strip(),
    }


@app.route("/health", methods=["GET"])
def health() -> Any:
    return jsonify({"status": "ok", "container": PASSBOLT_CONTAINER, "cli_path": PASSBOLT_CLI_PATH})


@app.route("/import", methods=["POST"])
def import_csv() -> Any:
    if "file" not in request.files:
        return jsonify({"error": "missing file field"}), 400

    file = request.files["file"]
    if not file.filename or not file.filename.lower().endswith(".csv"):
        return jsonify({"error": "please upload a .csv file"}), 400

    decoded = file.read().decode("utf-8", errors="replace").splitlines()
    reader = csv.DictReader(decoded)

    required = {"email", "firstname", "lastname", "role"}
    if not reader.fieldnames or not required.issubset({h.strip().lower() for h in reader.fieldnames}):
        return jsonify({"error": "csv headers must include email, firstname, lastname, role"}), 400

    results = []
    success = 0

    for raw_row in reader:
        row = {k.strip().lower(): (v or "") for k, v in raw_row.items()}
        try:
            result = create_user(
                row.get("email", ""),
                row.get("firstname", ""),
                row.get("lastname", ""),
                row.get("role", ""),
            )
            if result["returncode"] == 0:
                success += 1
            results.append(result)
        except ValueError as error:
            results.append({"email": row.get("email", ""), "returncode": -1, "stderr": str(error), "stdout": ""})

    return jsonify({"status": "import finished", "total": len(results), "success": success, "results": results})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=9090)
