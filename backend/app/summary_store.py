"""Transactional source-window plans and durable, backend-private image references."""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
from uuid import uuid4

from . import store, windows, workers

MAX_IMAGE_BYTES = 4 * 1024 * 1024
RUN_STATES = {"queued", "running", "complete", "incomplete", "failed", "cancelled", "interrupted"}
WINDOW_STATES = {"planned", "running", "complete", "incomplete", "failed"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def upgrade(db_path: Path) -> None:
    """Explicit v2 -> v3; SQLite rolls back all tables and the version on failure."""
    if not db_path.is_file():
        raise store.DatabaseSchemaError("Summary upgrade requires an existing version 2 database")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version in store.SUMMARY_SCHEMA_VERSIONS:
            return
        if version != store.MEDIA_SCHEMA_VERSION:
            raise store.DatabaseSchemaError("Summary upgrade requires database schema version 2")
        connection.execute("SELECT id, metadata_json FROM segment LIMIT 1")
        connection.execute("""CREATE TABLE processing_run (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES recording_session(id),
            state TEXT NOT NULL CHECK(state IN
                ('queued','running','complete','incomplete','failed','cancelled','interrupted')),
            algorithm_version TEXT NOT NULL,
            parameters_json TEXT NOT NULL,
            parameter_hash TEXT NOT NULL,
            source_snapshots_json TEXT NOT NULL,
            expected_windows INTEGER NOT NULL CHECK(expected_windows > 0 AND expected_windows <= 2000),
            started_at_utc TEXT NOT NULL,
            finished_at_utc TEXT,
            error_code TEXT
        )""")
        connection.execute("""CREATE TABLE summary_window (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES processing_run(id),
            segment_id TEXT NOT NULL REFERENCES segment(id),
            window_index INTEGER NOT NULL CHECK(window_index >= 0),
            interval_json TEXT NOT NULL,
            source_sha256 TEXT NOT NULL,
            time_base_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('planned','running','complete','incomplete','failed')),
            stats_json TEXT NOT NULL DEFAULT '{}',
            flags_json TEXT NOT NULL DEFAULT '[]',
            error_code TEXT,
            image_path TEXT,
            image_sha256 TEXT,
            image_bytes INTEGER NOT NULL DEFAULT 0 CHECK(image_bytes >= 0),
            UNIQUE(run_id, segment_id, window_index)
        )""")
        connection.execute(f"PRAGMA user_version={store.SUMMARY_SCHEMA_VERSION}")


def create_run(db_path: Path, session_id: str, window_seconds: int = 30) -> str:
    params = windows.parameters(window_seconds)
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("PRAGMA busy_timeout=1000")
        connection.execute("BEGIN IMMEDIATE")
        if connection.execute("PRAGMA user_version").fetchone()[0] not in store.SUMMARY_SCHEMA_VERSIONS:
            raise store.DatabaseSchemaError("Explicit summary schema upgrade is required")
        if connection.execute("SELECT id FROM recording_session WHERE id=?", (session_id,)).fetchone() is None:
            raise ValueError("The recording session does not exist")
        sources = [dict(row) for row in connection.execute(
            "SELECT * FROM segment WHERE session_id=? ORDER BY position", (session_id,)).fetchall()]
        if not sources:
            raise ValueError("The recording session has no imported source segments")
        plan = [(row, interval) for row in sources for interval in
                windows.plan_source(json.loads(row["metadata_json"]), window_seconds)]
        if len(plan) > windows.MAX_WINDOWS:
            raise ValueError(f"The run exceeds the {windows.MAX_WINDOWS}-window resource limit")
        run_id = str(uuid4())
        connection.execute("""INSERT INTO processing_run
            (id,session_id,state,algorithm_version,parameters_json,parameter_hash,
             source_snapshots_json,expected_windows,started_at_utc)
            VALUES (?,?,?,?,?,?,?,?,?)""",
            (run_id, session_id, "queued", windows.ALGORITHM_VERSION, json.dumps(params),
             windows.parameter_hash(params), json.dumps(sources), len(plan), _now()))
        for source, interval in plan:
            metadata = json.loads(source["metadata_json"])
            unknown = interval["end_time"] is None
            connection.execute("""INSERT INTO summary_window
                (id,run_id,segment_id,window_index,interval_json,source_sha256,time_base_json,status,error_code)
                VALUES (?,?,?,?,?,?,?,?,?)""",
                (str(uuid4()), run_id, source["id"], interval["index"], json.dumps(interval),
                 source["sha256"], json.dumps(metadata["time_base"]),
                 "incomplete" if unknown else "planned", "unknown_end" if unknown else None))
    return run_id


def _decode_window(row: sqlite3.Row | dict) -> dict:
    item = dict(row)
    item.update(interval=json.loads(item.pop("interval_json")), stats=json.loads(item.pop("stats_json")),
                flags=json.loads(item.pop("flags_json")), time_base=json.loads(item.pop("time_base_json")))
    item["index"] = item["window_index"]
    return item


def private_run(db_path: Path, run_id: str) -> dict | None:
    if store.schema_version(db_path) not in store.SUMMARY_SCHEMA_VERSIONS:
        return None
    with closing(store.connect(db_path)) as connection:
        run = connection.execute("SELECT * FROM processing_run WHERE id=?", (run_id,)).fetchone()
        if run is None:
            return None
        rows = connection.execute("SELECT * FROM summary_window WHERE run_id=? ORDER BY rowid", (run_id,)).fetchall()
    result = dict(run)
    result["parameters"] = json.loads(result["parameters_json"])
    return {"run": result, "windows": [_decode_window(row) for row in rows],
            "sources": json.loads(result["source_snapshots_json"])}


def private_window(db_path: Path, window_id: str) -> dict | None:
    if store.schema_version(db_path) not in store.SUMMARY_SCHEMA_VERSIONS:
        return None
    with closing(store.connect(db_path)) as connection:
        row = connection.execute("SELECT * FROM summary_window WHERE id=?", (window_id,)).fetchone()
        if row is None:
            return None
        run = connection.execute("SELECT source_snapshots_json FROM processing_run WHERE id=?", (row["run_id"],)).fetchone()
    item = _decode_window(row)
    item["source"] = next(source for source in json.loads(run[0]) if source["id"] == row["segment_id"])
    return item


def _error(code: str | None) -> dict | None:
    return {"code": code, "message": f"Summary coverage is unavailable or incomplete ({code})."} if code else None


def _public_window(row: dict) -> dict:
    # Keep all windows below the desktop JSON cap. The private manifest retains
    # up to 64 gap examples; public inspection includes two and the full count.
    stats = dict(row["stats"])
    if len(stats.get("gaps", [])) > 2:
        stats["gap_examples_recorded"] = len(stats["gaps"])
        stats["gaps"] = stats["gaps"][:2]
    return {"id": row["id"], "run_id": row["run_id"], "segment_id": row["segment_id"], "index": row["index"],
            "interval": row["interval"], "status": row["status"], "source_sha256": row["source_sha256"],
            "time_base": row["time_base"], "stats": stats, "flags": row["flags"],
            "error": _error(row["error_code"]), "preview_pts": row["stats"].get("preview_pts"),
            "image": {"sha256": row["image_sha256"], "bytes": row["image_bytes"]} if row["image_path"] else None}


def _public_run(private: dict) -> dict:
    run, rows = private["run"], private["windows"]
    counts = {state: sum(row["status"] == state for row in rows) for state in WINDOW_STATES}
    counts["planned"] = run["expected_windows"]
    counts["pending"] = sum(row["status"] == "planned" for row in rows)
    return {"id": run["id"], "session_id": run["session_id"], "state": run["state"],
            "algorithm_version": run["algorithm_version"], "parameters": run["parameters"],
            "parameter_hash": run["parameter_hash"], "started_at_utc": run["started_at_utc"],
            "finished_at_utc": run["finished_at_utc"], "error": _error(run["error_code"]), "counts": counts}


def get_run(db_path: Path, run_id: str) -> dict | None:
    result = private_run(db_path, run_id)
    if result is None:
        return None
    return {**_public_run(result), "windows": [_public_window(row) for row in result["windows"]]}


def list_runs(db_path: Path, session_id: str) -> list[dict]:
    """List bounded run headers in one query; never deserialize their windows."""
    if store.schema_version(db_path) not in store.SUMMARY_SCHEMA_VERSIONS:
        return []
    with closing(store.connect(db_path)) as connection:
        rows = connection.execute(
            """SELECT r.id, r.session_id, r.state, r.algorithm_version,
                      r.parameters_json, r.parameter_hash, r.started_at_utc,
                      r.finished_at_utc, r.error_code, r.expected_windows,
                      COUNT(CASE WHEN w.status='planned' THEN 1 END) AS pending_count,
                      COUNT(CASE WHEN w.status='running' THEN 1 END) AS running_count,
                      COUNT(CASE WHEN w.status='complete' THEN 1 END) AS complete_count,
                      COUNT(CASE WHEN w.status='incomplete' THEN 1 END) AS incomplete_count,
                      COUNT(CASE WHEN w.status='failed' THEN 1 END) AS failed_count
               FROM processing_run AS r
               LEFT JOIN summary_window AS w ON w.run_id=r.id
               WHERE r.session_id=?
               GROUP BY r.id
               ORDER BY r.rowid DESC""", (session_id,)
        ).fetchall()
    return [{
        "id": row["id"], "session_id": row["session_id"],
        "state": row["state"], "algorithm_version": row["algorithm_version"],
        "parameters": json.loads(row["parameters_json"]),
        "parameter_hash": row["parameter_hash"],
        "started_at_utc": row["started_at_utc"], "finished_at_utc": row["finished_at_utc"],
        "error": _error(row["error_code"]),
        "counts": {
            "planned": row["expected_windows"], "pending": row["pending_count"],
            "running": row["running_count"], "complete": row["complete_count"],
            "incomplete": row["incomplete_count"], "failed": row["failed_count"],
        },
    } for row in rows]


def set_running(db_path: Path, run_id: str) -> None:
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("UPDATE processing_run SET state='running' WHERE id=? AND state='queued'", (run_id,))


def start_window(db_path: Path, window_id: str) -> None:
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("""UPDATE summary_window SET status='running' WHERE id=? AND image_path IS NULL
            AND (status='planned' OR (status='incomplete' AND error_code='unknown_end'))""", (window_id,))


def _valid_image(row: dict) -> bool:
    path, checksum, amount = row.get("image_path"), row.get("image_sha256"), row.get("image_bytes", 0)
    if not path or not checksum or len(checksum) != 64 or not 0 < amount <= MAX_IMAGE_BYTES:
        return False
    candidate = Path(path)
    try:
        if not candidate.is_absolute() or workers.is_link(candidate) or not candidate.is_file() or candidate.stat().st_size != amount:
            return False
        digest = sha256()
        with candidate.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest() == checksum
    except OSError:
        return False


def record_window(db_path: Path, window_id: str, stats: dict, status: str,
                  image_path: str | Path | None = None, image_sha256: str | None = None,
                  image_bytes: int = 0, error_code: str | None = None, flags: list[str] | None = None) -> None:
    if status not in WINDOW_STATES - {"planned", "running"}:
        raise ValueError("Window result must have a terminal status")
    if len(stats.get("gaps", [])) > 64:
        raise ValueError("Timestamp-gap examples exceed the manifest limit")
    image = {"image_path": str(image_path) if image_path is not None else None,
             "image_sha256": image_sha256, "image_bytes": image_bytes}
    if image_path is not None and not _valid_image(image):
        raise ValueError("Summary image checksum or size is invalid")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("PRAGMA busy_timeout=1000")
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT interval_json,status,image_path FROM summary_window WHERE id=?", (window_id,)).fetchone()
        if row is None:
            raise ValueError("Summary window does not exist")
        if row["status"] == "complete" or row["image_path"] is not None:
            raise ValueError("Successful summary outputs are immutable; start a new run")
        if json.loads(row["interval_json"])["end_time"] is None:
            status, error_code = "incomplete", error_code or "unknown_end"
        if status == "complete" and (image_path is None or not stats.get("frame_count", 0)):
            raise ValueError("A complete window requires decoded frames and a valid image")
        connection.execute("""UPDATE summary_window SET stats_json=?,status=?,image_path=?,image_sha256=?,
            image_bytes=?,error_code=?,flags_json=? WHERE id=?""",
            (json.dumps(stats), status, image["image_path"], image_sha256, image_bytes,
             error_code, json.dumps(flags or []), window_id))


def finish_run(db_path: Path, run_id: str, state: str, error_code: str | None = None) -> None:
    if state not in RUN_STATES - {"queued", "running"}:
        raise ValueError("Run result must have a terminal state")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("PRAGMA busy_timeout=1000")
        connection.execute("BEGIN IMMEDIATE")
        run = connection.execute("SELECT expected_windows FROM processing_run WHERE id=?", (run_id,)).fetchone()
        if run is None:
            raise ValueError("Processing run does not exist")
        # The run's fatal cause does not prove that an untouched segment failed
        # decoding. Keep its own window error separate from the run error.
        unfinished_code = error_code if error_code in {"cancelled", "interrupted"} else "incomplete_run"
        connection.execute("""UPDATE summary_window SET status='incomplete',error_code=COALESCE(error_code,?)
            WHERE run_id=? AND status IN ('planned','running')""", (unfinished_code, run_id))
        rows = [dict(row) for row in connection.execute("SELECT * FROM summary_window WHERE run_id=?", (run_id,)).fetchall()]
        if state == "complete":
            for row in rows:
                if row["status"] == "complete" and not _valid_image(row):
                    connection.execute("UPDATE summary_window SET status='incomplete',error_code='image_unavailable' WHERE id=?", (row["id"],))
                    row["status"] = "incomplete"
            valid = len(rows) == run[0] and all(
                row["status"] == "complete" and json.loads(row["interval_json"])["end_time"] is not None
                and _valid_image(row) for row in rows)
            if not valid:
                state, error_code = "incomplete", error_code or "incomplete_coverage"
        connection.execute("UPDATE processing_run SET state=?,finished_at_utc=?,error_code=? WHERE id=?",
                           (state, _now(), error_code, run_id))


def recover(db_path: Path) -> None:
    """A restart never resumes silently or converts interrupted work to success."""
    if store.schema_version(db_path) not in store.SUMMARY_SCHEMA_VERSIONS:
        return
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("""UPDATE summary_window SET status='incomplete',error_code=COALESCE(error_code,'interrupted')
            WHERE status IN ('planned','running') AND run_id IN
            (SELECT id FROM processing_run WHERE state IN ('queued','running'))""")
        connection.execute("""UPDATE processing_run SET state='interrupted',finished_at_utc=?,error_code='interrupted'
            WHERE state IN ('queued','running')""", (_now(),))
        for row in connection.execute("SELECT * FROM summary_window WHERE image_path IS NOT NULL").fetchall():
            if not _valid_image(dict(row)):
                connection.execute("UPDATE summary_window SET status='incomplete',error_code='image_unavailable' WHERE id=?", (row["id"],))
                connection.execute("""UPDATE processing_run SET state='incomplete',error_code='image_unavailable'
                    WHERE id=? AND state='complete'""", (row["run_id"],))


def image_references(db_path: Path) -> set[str]:
    if store.schema_version(db_path) not in store.SUMMARY_SCHEMA_VERSIONS:
        return set()
    with closing(store.connect(db_path)) as connection:
        return {row[0] for row in connection.execute(
            "SELECT image_path FROM summary_window WHERE image_path IS NOT NULL").fetchall()}


def invalidate_window(db_path: Path, window_id: str, code: str) -> None:
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT run_id FROM summary_window WHERE id=?", (window_id,)).fetchone()
        if row is None:
            return
        connection.execute("UPDATE summary_window SET status='incomplete',error_code=? WHERE id=?", (code, window_id))
        connection.execute("""UPDATE processing_run SET state='incomplete',error_code=?
            WHERE id=? AND state='complete'""", (code, row[0]))
