import json
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
                import_job_id TEXT,
                batch_index INTEGER NOT NULL DEFAULT 1,
                total_batches INTEGER NOT NULL DEFAULT 1,
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
        conn.execute("CREATE INDEX IF NOT EXISTS idx_import_batches_import_job_id ON import_batches(import_job_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_imported_users_email ON imported_users(email)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_imported_users_batch_email ON imported_users(batch_uuid, email)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS delete_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_uuid TEXT NOT NULL,
                email TEXT,
                event_type TEXT NOT NULL,
                status TEXT,
                message TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_delete_events_batch_uuid ON delete_events(batch_uuid)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS import_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                batch_uuid TEXT,
                scope TEXT NOT NULL,
                level TEXT NOT NULL,
                event_code TEXT,
                message TEXT NOT NULL,
                email TEXT,
                row_number INTEGER,
                payload_json TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_import_logs_created_at ON import_logs(created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_import_logs_batch_uuid ON import_logs(batch_uuid)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_import_logs_scope ON import_logs(scope)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_import_logs_level ON import_logs(level)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS batch_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_uuid TEXT NOT NULL,
                group_name TEXT NOT NULL,
                group_id TEXT,
                group_created_by_batch INTEGER NOT NULL DEFAULT 0,
                service_account_added_as_temporary_manager INTEGER NOT NULL DEFAULT 0,
                service_account_removed_from_group INTEGER NOT NULL DEFAULT 0,
                user_promoted_to_group_manager INTEGER NOT NULL DEFAULT 0,
                promoted_user_id TEXT,
                final_group_state TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(batch_uuid, group_name),
                FOREIGN KEY (batch_uuid) REFERENCES import_batches(batch_uuid) ON DELETE CASCADE
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_batch_groups_batch_uuid ON batch_groups(batch_uuid)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_batch_groups_group_id ON batch_groups(group_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS pending_group_assignments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_uuid TEXT NOT NULL,
                email TEXT NOT NULL,
                user_id TEXT,
                group_name TEXT NOT NULL,
                group_id TEXT,
                status TEXT NOT NULL,
                deferred_reason TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(batch_uuid, email, group_name),
                FOREIGN KEY (batch_uuid) REFERENCES import_batches(batch_uuid) ON DELETE CASCADE
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pending_assignments_batch_uuid ON pending_group_assignments(batch_uuid)")
        _ensure_import_batches_columns(conn)


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {str(row["name"]) for row in rows}


def _ensure_import_batches_columns(conn: sqlite3.Connection) -> None:
    columns = _table_columns(conn, "import_batches")
    if "import_job_id" not in columns:
        conn.execute("ALTER TABLE import_batches ADD COLUMN import_job_id TEXT")
    if "batch_index" not in columns:
        conn.execute("ALTER TABLE import_batches ADD COLUMN batch_index INTEGER NOT NULL DEFAULT 1")
    if "total_batches" not in columns:
        conn.execute("ALTER TABLE import_batches ADD COLUMN total_batches INTEGER NOT NULL DEFAULT 1")
    conn.execute("UPDATE import_batches SET import_job_id = COALESCE(import_job_id, batch_uuid) WHERE import_job_id IS NULL OR import_job_id = ''")


def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def create_import_batch(
    batch_uuid: str,
    filename: str,
    total_rows: int,
    status: str = "running",
    import_job_id: str | None = None,
    batch_index: int = 1,
    total_batches: int = 1,
) -> None:
    with _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO import_batches (
                batch_uuid, import_job_id, batch_index, total_batches, filename, created_at, total_rows, success_count, error_count, status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
            """,
            (batch_uuid, import_job_id or batch_uuid, batch_index, total_batches, filename, _utc_now_iso(), total_rows, status),
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
    items = list_import_batches()
    return items[0] if items else None


def list_import_batches() -> list[dict[str, Any]]:
    with _get_connection() as conn:
        rows = conn.execute(
            """
            SELECT
                COALESCE(import_job_id, batch_uuid) AS import_job_id,
                MAX(filename) AS filename,
                MIN(created_at) AS created_at,
                SUM(total_rows) AS total_rows,
                SUM(success_count) AS success_count,
                SUM(error_count) AS error_count,
                MAX(total_batches) AS total_batches,
                COUNT(*) AS completed_batches,
                CASE
                    WHEN SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) > 0 THEN 'failed'
                    WHEN COUNT(*) = MAX(total_batches) AND SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) = COUNT(*) THEN 'completed'
                    WHEN COUNT(*) = MAX(total_batches) THEN 'partial'
                    ELSE 'running'
                END AS status,
                GROUP_CONCAT(batch_uuid, ',') AS batch_uuids
            FROM import_batches
            GROUP BY COALESCE(import_job_id, batch_uuid)
            ORDER BY datetime(MIN(created_at)) DESC, MAX(id) DESC
            """
        ).fetchall()
    payload: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["batch_uuid"] = item.get("import_job_id")
        item["batch_ids"] = [value for value in str(item.get("batch_uuids") or "").split(",") if value]
        payload.append(item)
    return payload


def list_batches_for_import_job(import_job_id: str) -> list[dict[str, Any]]:
    with _get_connection() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM import_batches
            WHERE COALESCE(import_job_id, batch_uuid) = ?
            ORDER BY batch_index ASC, id ASC
            """,
            (import_job_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def get_batch_users(batch_uuid: str) -> list[dict[str, Any]]:
    with _get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM imported_users WHERE batch_uuid = ? ORDER BY id ASC",
            (batch_uuid,),
        ).fetchall()
    return [dict(row) for row in rows]


def get_batch_user_records(batch_uuid: str) -> list[dict[str, Any]]:
    with _get_connection() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM imported_users
            WHERE batch_uuid = ?
            ORDER BY id ASC
            """,
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
        logs_count = conn.execute("SELECT COUNT(*) AS c FROM import_logs").fetchone()["c"]

    return {
        "db_path": DB_PATH,
        "batches_count": batches_count,
        "tracked_users_count": tracked_users_count,
        "tool_created_count": tool_created_count,
        "deletable_candidates_count": deletable_count,
        "logs_count": logs_count,
        "last_batch": get_last_import_batch(),
    }


def update_user_delete_state(batch_uuid: str, email: str, activation_state: str, deletable_candidate: int = 0) -> None:
    with _get_connection() as conn:
        conn.execute(
            """
            UPDATE imported_users
            SET last_known_activation_state = ?, deletable_candidate = ?
            WHERE batch_uuid = ? AND email = ?
            """,
            (activation_state, deletable_candidate, batch_uuid, email),
        )


def upsert_batch_group(
    batch_uuid: str,
    group_name: str,
    group_id: str | None = None,
    group_created_by_batch: int = 0,
    service_account_added_as_temporary_manager: int = 0,
    service_account_removed_from_group: int = 0,
    user_promoted_to_group_manager: int = 0,
    promoted_user_id: str | None = None,
    final_group_state: str | None = None,
) -> None:
    now = _utc_now_iso()
    with _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO batch_groups (
                batch_uuid, group_name, group_id, group_created_by_batch,
                service_account_added_as_temporary_manager, service_account_removed_from_group,
                user_promoted_to_group_manager, promoted_user_id, final_group_state, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(batch_uuid, group_name) DO UPDATE SET
                group_id = COALESCE(excluded.group_id, batch_groups.group_id),
                group_created_by_batch = MAX(batch_groups.group_created_by_batch, excluded.group_created_by_batch),
                service_account_added_as_temporary_manager = MAX(batch_groups.service_account_added_as_temporary_manager, excluded.service_account_added_as_temporary_manager),
                service_account_removed_from_group = MAX(batch_groups.service_account_removed_from_group, excluded.service_account_removed_from_group),
                user_promoted_to_group_manager = MAX(batch_groups.user_promoted_to_group_manager, excluded.user_promoted_to_group_manager),
                promoted_user_id = COALESCE(excluded.promoted_user_id, batch_groups.promoted_user_id),
                final_group_state = COALESCE(excluded.final_group_state, batch_groups.final_group_state),
                updated_at = excluded.updated_at
            """,
            (
                batch_uuid,
                group_name,
                group_id,
                group_created_by_batch,
                service_account_added_as_temporary_manager,
                service_account_removed_from_group,
                user_promoted_to_group_manager,
                promoted_user_id,
                final_group_state,
                now,
                now,
            ),
        )


def list_batch_groups(batch_uuid: str) -> list[dict[str, Any]]:
    with _get_connection() as conn:
        rows = conn.execute("SELECT * FROM batch_groups WHERE batch_uuid = ? ORDER BY id ASC", (batch_uuid,)).fetchall()
    return [dict(row) for row in rows]


def upsert_pending_group_assignment(
    batch_uuid: str,
    email: str,
    group_name: str,
    status: str,
    user_id: str | None = None,
    group_id: str | None = None,
    deferred_reason: str | None = None,
) -> None:
    now = _utc_now_iso()
    with _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO pending_group_assignments (
                batch_uuid, email, user_id, group_name, group_id, status, deferred_reason, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(batch_uuid, email, group_name) DO UPDATE SET
                user_id = COALESCE(excluded.user_id, pending_group_assignments.user_id),
                group_id = COALESCE(excluded.group_id, pending_group_assignments.group_id),
                status = excluded.status,
                deferred_reason = excluded.deferred_reason,
                updated_at = excluded.updated_at
            """,
            (batch_uuid, email, user_id, group_name, group_id, status, deferred_reason, now, now),
        )


def list_pending_group_assignments(batch_uuid: str | None = None) -> list[dict[str, Any]]:
    with _get_connection() as conn:
        if batch_uuid:
            rows = conn.execute(
                "SELECT * FROM pending_group_assignments WHERE batch_uuid = ? AND status LIKE 'pending%' ORDER BY id ASC",
                (batch_uuid,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM pending_group_assignments WHERE status LIKE 'pending%' ORDER BY id ASC"
            ).fetchall()
    return [dict(row) for row in rows]


def is_latest_batch(batch_uuid: str) -> bool:
    latest = get_last_import_batch()
    return bool(latest and latest.get("batch_uuid") == batch_uuid)


def log_delete_event(batch_uuid: str, event_type: str, status: str = "", message: str = "", email: str = "") -> None:
    with _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO delete_events (batch_uuid, email, event_type, status, message, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (batch_uuid, email, event_type, status, message, _utc_now_iso()),
        )


def save_log(
    scope: str,
    level: str,
    message: str,
    batch_uuid: str | None = None,
    event_code: str | None = None,
    email: str | None = None,
    row_number: int | None = None,
    payload: dict[str, Any] | list[Any] | None = None,
) -> None:
    payload_json = json.dumps(payload, ensure_ascii=False) if payload is not None else None
    with _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO import_logs (
                created_at, batch_uuid, scope, level, event_code, message, email, row_number, payload_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (_utc_now_iso(), batch_uuid, scope, level, event_code, message, email, row_number, payload_json),
        )


def list_logs(batch_uuid: str | None = None, scope: str | None = None, level: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []

    if batch_uuid:
        clauses.append("batch_uuid = ?")
        params.append(batch_uuid)
    if scope:
        clauses.append("scope = ?")
        params.append(scope)
    if level:
        clauses.append("level = ?")
        params.append(level)

    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with _get_connection() as conn:
        rows = conn.execute(
            f"""
            SELECT *
            FROM import_logs
            {where_sql}
            ORDER BY datetime(created_at) DESC, id DESC
            LIMIT ?
            """,
            (*params, max(1, min(limit, 2000))),
        ).fetchall()
    return [dict(row) for row in rows]


def purge_logs(batch_uuid: str | None = None) -> int:
    with _get_connection() as conn:
        if batch_uuid:
            cur = conn.execute("DELETE FROM import_logs WHERE batch_uuid = ?", (batch_uuid,))
        else:
            cur = conn.execute("DELETE FROM import_logs")
    return cur.rowcount


def get_logs_summary(batch_uuid: str | None = None, scope: str | None = None, level: str | None = None) -> dict[str, Any]:
    clauses: list[str] = []
    params: list[Any] = []

    if batch_uuid:
        clauses.append("batch_uuid = ?")
        params.append(batch_uuid)
    if scope:
        clauses.append("scope = ?")
        params.append(scope)
    if level:
        clauses.append("level = ?")
        params.append(level)

    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with _get_connection() as conn:
        total = conn.execute(f"SELECT COUNT(*) AS c FROM import_logs {where_sql}", params).fetchone()["c"]
        by_level_rows = conn.execute(
            f"SELECT level, COUNT(*) AS c FROM import_logs {where_sql} GROUP BY level ORDER BY c DESC",
            params,
        ).fetchall()
        by_scope_rows = conn.execute(
            f"SELECT scope, COUNT(*) AS c FROM import_logs {where_sql} GROUP BY scope ORDER BY c DESC",
            params,
        ).fetchall()
        last_log = conn.execute(
            f"SELECT * FROM import_logs {where_sql} ORDER BY datetime(created_at) DESC, id DESC LIMIT 1",
            params,
        ).fetchone()

    return {
        "total_logs": total,
        "by_level": {row["level"]: row["c"] for row in by_level_rows},
        "by_scope": {row["scope"]: row["c"] for row in by_scope_rows},
        "last_log": _row_to_dict(last_log),
    }
