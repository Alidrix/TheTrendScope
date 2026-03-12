import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DB_PATH = os.getenv("SQLITE_DB_PATH", "/app/data/thetrendscope.db")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_db_directory() -> None:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)


@contextmanager
def _get_connection() -> Any:
    _ensure_db_directory()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.DatabaseError:
        pass
    conn.execute("PRAGMA synchronous = NORMAL")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with _get_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS import_batches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_uuid TEXT UNIQUE NOT NULL,
                filename TEXT NOT NULL,
                created_at TEXT NOT NULL,
                total_rows INTEGER NOT NULL DEFAULT 0,
                success_count INTEGER NOT NULL DEFAULT 0,
                error_count INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS imported_users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_uuid TEXT NOT NULL,
                email TEXT NOT NULL,
                firstname TEXT,
                lastname TEXT,
                requested_role TEXT,
                created_by_tool INTEGER NOT NULL DEFAULT 1,
                import_status TEXT NOT NULL,
                activation_link TEXT,
                passbolt_user_id TEXT,
                actual_role TEXT,
                last_known_activation_state TEXT,
                deletable_candidate INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                FOREIGN KEY (batch_uuid) REFERENCES import_batches(batch_uuid) ON DELETE CASCADE
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_imported_users_batch_uuid ON imported_users(batch_uuid)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_imported_users_email ON imported_users(email)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_imported_users_batch_email ON imported_users(batch_uuid, email)")


def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def create_import_batch(batch_uuid: str, filename: str, total_rows: int, status: str = "running") -> None:
    with _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO import_batches (batch_uuid, filename, created_at, total_rows, success_count, error_count, status)
            VALUES (?, ?, ?, ?, 0, 0, ?)
            """,
            (batch_uuid, filename, _utc_now_iso(), total_rows, status),
        )


def save_imported_user(
    batch_uuid: str,
    email: str,
    firstname: str = "",
    lastname: str = "",
    requested_role: str = "",
    import_status: str = "error",
    activation_link: str | None = None,
    created_by_tool: int = 1,
    passbolt_user_id: str | None = None,
    actual_role: str | None = None,
    last_known_activation_state: str | None = None,
    deletable_candidate: int = 0,
) -> None:
    with _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO imported_users (
                batch_uuid, email, firstname, lastname, requested_role, created_by_tool,
                import_status, activation_link, passbolt_user_id, actual_role,
                last_known_activation_state, deletable_candidate, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                batch_uuid,
                email,
                firstname,
                lastname,
                requested_role,
                created_by_tool,
                import_status,
                activation_link,
                passbolt_user_id,
                actual_role,
                last_known_activation_state,
                deletable_candidate,
                _utc_now_iso(),
            ),
        )


def finalize_import_batch(batch_uuid: str, success_count: int, error_count: int, status: str) -> None:
    with _get_connection() as conn:
        conn.execute(
            """
            UPDATE import_batches
            SET success_count = ?, error_count = ?, status = ?
            WHERE batch_uuid = ?
            """,
            (success_count, error_count, status, batch_uuid),
        )


def get_last_import_batch() -> dict[str, Any] | None:
    with _get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM import_batches ORDER BY datetime(created_at) DESC, id DESC LIMIT 1"
        ).fetchone()
    return _row_to_dict(row)


def list_import_batches() -> list[dict[str, Any]]:
    with _get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM import_batches ORDER BY datetime(created_at) DESC, id DESC"
        ).fetchall()
    return [dict(row) for row in rows]


def get_batch_users(batch_uuid: str) -> list[dict[str, Any]]:
    with _get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM imported_users WHERE batch_uuid = ? ORDER BY id ASC",
            (batch_uuid,),
        ).fetchall()
    return [dict(row) for row in rows]


def get_batch(batch_uuid: str) -> dict[str, Any] | None:
    with _get_connection() as conn:
        row = conn.execute("SELECT * FROM import_batches WHERE batch_uuid = ?", (batch_uuid,)).fetchone()
    return _row_to_dict(row)


def get_deletable_users_for_batch(batch_uuid: str) -> list[dict[str, Any]]:
    with _get_connection() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM imported_users
            WHERE batch_uuid = ?
              AND created_by_tool = 1
              AND deletable_candidate = 1
              AND lower(COALESCE(actual_role, requested_role, '')) != 'admin'
              AND COALESCE(last_known_activation_state, 'pending') IN ('pending', 'unknown', '')
            ORDER BY id ASC
            """,
            (batch_uuid,),
        ).fetchall()
    return [dict(row) for row in rows]


def get_db_summary() -> dict[str, Any]:
    with _get_connection() as conn:
        batches_count = conn.execute("SELECT COUNT(*) AS c FROM import_batches").fetchone()["c"]
        tracked_users_count = conn.execute("SELECT COUNT(*) AS c FROM imported_users").fetchone()["c"]
        tool_created_count = conn.execute(
            "SELECT COUNT(*) AS c FROM imported_users WHERE created_by_tool = 1"
        ).fetchone()["c"]
        deletable_count = conn.execute(
            "SELECT COUNT(*) AS c FROM imported_users WHERE created_by_tool = 1 AND deletable_candidate = 1"
        ).fetchone()["c"]

    return {
        "db_path": DB_PATH,
        "batches_count": batches_count,
        "tracked_users_count": tracked_users_count,
        "tool_created_count": tool_created_count,
        "deletable_candidates_count": deletable_count,
        "last_batch": get_last_import_batch(),
    }
