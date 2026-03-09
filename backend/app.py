from __future__ import annotations

import io
import os
import time
from typing import Any

import gnupg
import pandas as pd
import requests
from fastapi import FastAPI, File, HTTPException, UploadFile

app = FastAPI(title="Passbolt User Import API")

PASSBOLT_URL = os.getenv("PASSBOLT_URL", "").rstrip("/")
PASSBOLT_USER_ID = os.getenv("PASSBOLT_USER_ID", "")
PASSBOLT_PRIVATE_KEY_PATH = os.getenv("PASSBOLT_PRIVATE_KEY_PATH", "/app/keys/private.asc")
PASSBOLT_GPG_PASSPHRASE = os.getenv("PASSBOLT_GPG_PASSPHRASE", "")
PASSBOLT_VERIFY_TLS = os.getenv("PASSBOLT_VERIFY_TLS", "true").lower() not in {"0", "false", "no"}
PASSBOLT_STATIC_TOKEN = os.getenv("PASSBOLT_TOKEN", "")
CHALLENGE_ENDPOINT = os.getenv("PASSBOLT_AUTH_CHALLENGE_ENDPOINT", "/auth/jwt/rsa-challenge.json")
LOGIN_ENDPOINT = os.getenv("PASSBOLT_AUTH_LOGIN_ENDPOINT", "/auth/jwt/login.json")

JWT_CACHE: dict[str, Any] = {"token": None, "exp": 0}


def _extract_from_response(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if isinstance(payload, dict) and key in payload:
            return payload[key]
    body = payload.get("body") if isinstance(payload, dict) else None
    if isinstance(body, dict):
        for key in keys:
            if key in body:
                return body[key]
    return None


def _get_gpg() -> gnupg.GPG:
    gpg = gnupg.GPG(gnupghome="/tmp/gnupg")
    if not os.path.exists(PASSBOLT_PRIVATE_KEY_PATH):
        raise HTTPException(status_code=500, detail=f"Private key file not found: {PASSBOLT_PRIVATE_KEY_PATH}")

    with open(PASSBOLT_PRIVATE_KEY_PATH, "r", encoding="utf-8") as key_file:
        import_result = gpg.import_keys(key_file.read())

    if not import_result.fingerprints:
        raise HTTPException(status_code=500, detail="Failed to import private GPG key")

    return gpg


def _obtain_jwt() -> str:
    now = int(time.time())
    if JWT_CACHE["token"] and JWT_CACHE["exp"] > now + 60:
        return str(JWT_CACHE["token"])

    if PASSBOLT_STATIC_TOKEN:
        JWT_CACHE["token"] = PASSBOLT_STATIC_TOKEN
        JWT_CACHE["exp"] = now + 300
        return PASSBOLT_STATIC_TOKEN

    if not PASSBOLT_URL or not PASSBOLT_USER_ID:
        raise HTTPException(status_code=500, detail="PASSBOLT_URL and PASSBOLT_USER_ID must be configured")

    challenge_response = requests.get(
        f"{PASSBOLT_URL}{CHALLENGE_ENDPOINT}",
        params={"user_id": PASSBOLT_USER_ID},
        timeout=30,
        verify=PASSBOLT_VERIFY_TLS,
    )
    challenge_response.raise_for_status()
    challenge_data = challenge_response.json()

    challenge = _extract_from_response(challenge_data, "challenge", "challenge_token")
    challenge_id = _extract_from_response(challenge_data, "challenge_id", "id")

    if not challenge:
        raise HTTPException(status_code=500, detail="Unable to read challenge from Passbolt response")

    gpg = _get_gpg()
    signed = gpg.sign(challenge, clearsign=False, detach=True, passphrase=PASSBOLT_GPG_PASSPHRASE)

    if not signed:
        raise HTTPException(status_code=500, detail="Unable to sign Passbolt challenge with GPG key")

    payload: dict[str, Any] = {
        "user_id": PASSBOLT_USER_ID,
        "challenge": challenge,
        "challenge_signature": str(signed),
    }
    if challenge_id:
        payload["challenge_id"] = challenge_id

    login_response = requests.post(
        f"{PASSBOLT_URL}{LOGIN_ENDPOINT}",
        json=payload,
        timeout=30,
        verify=PASSBOLT_VERIFY_TLS,
    )
    login_response.raise_for_status()
    login_data = login_response.json()

    token = _extract_from_response(login_data, "token", "access_token", "jwt")
    if not token:
        raise HTTPException(status_code=500, detail="Unable to extract JWT token from Passbolt login response")

    expires_in = _extract_from_response(login_data, "expires_in") or 300
    JWT_CACHE["token"] = token
    JWT_CACHE["exp"] = now + int(expires_in)

    return str(token)


def _passbolt_request(method: str, path: str, **kwargs: Any) -> requests.Response:
    token = _obtain_jwt()
    headers = kwargs.pop("headers", {})
    headers["Authorization"] = f"Bearer {token}"

    response = requests.request(
        method,
        f"{PASSBOLT_URL}{path}",
        headers=headers,
        timeout=60,
        verify=PASSBOLT_VERIFY_TLS,
        **kwargs,
    )
    return response


@app.get("/health")
def healthcheck() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/users")
def list_users() -> Any:
    try:
        response = _passbolt_request("GET", "/users.json")
        return response.json()
    except requests.RequestException as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.post("/import")
async def import_csv(file: UploadFile = File(...)) -> list[dict[str, Any]]:
    if not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="Please upload a CSV file")

    contents = await file.read()
    try:
        df = pd.read_csv(io.BytesIO(contents))
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"Invalid CSV file: {error}") from error

    required_columns = {"Email", "FirstName", "LastName"}
    if not required_columns.issubset(df.columns):
        missing = ", ".join(sorted(required_columns - set(df.columns)))
        raise HTTPException(status_code=400, detail=f"Missing columns: {missing}")

    results: list[dict[str, Any]] = []

    for _, row in df.iterrows():
        payload = {
            "username": row["Email"],
            "profile": {
                "first_name": row["FirstName"],
                "last_name": row["LastName"],
            },
            "role": "user",
        }

        try:
            response = _passbolt_request(
                "POST",
                "/users.json",
                json=payload,
                headers={"Content-Type": "application/json"},
            )
            results.append({"email": row["Email"], "status": response.status_code, "response": response.json()})
        except requests.RequestException as error:
            results.append({"email": row["Email"], "status": "error", "error": str(error)})

    return results
