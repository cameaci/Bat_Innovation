"""Playback copies of imported segments (schema v11, Phase 2 W1). Copies are derived display aids, never evidence."""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from . import store

ACTIVE = ("queued", "running")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def upgrade(db_path: Path) -> None:
    """Explicit v10 -> v11 transition."""
    if not db_path.is_file():
        raise store.DatabaseSchemaError("Playback copy upgrade requires an existing version 10 database")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version >= store.PROXY_SCHEMA_VERSION:
            return
        if version != store.AUDIO_SCHEMA_VERSION:
            raise store.DatabaseSchemaError("Playback copy upgrade requires database schema version 10")
        connection.execute("SELECT id FROM audio_source LIMIT 1")
        connection.execute("""CREATE TABLE proxy (
            id TEXT PRIMARY KEY,
            segment_id TEXT NOT NULL REFERENCES segment(id),
            source_sha256 TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('queued','running','ready','failed','cancelled','interrupted')),
            width INTEGER,
            height INTEGER,
            frame_count INTEGER,
            duration_ms INTEGER,
            bytes INTEGER,
            frames_sha256 TEXT,
            error_code TEXT,
            started_at_utc TEXT NOT NULL,
            finished_at_utc TEXT
        )""")
        connection.execute("CREATE INDEX proxy_segment ON proxy(segment_id, started_at_utc)")
        connection.execute(f"PRAGMA user_version={store.PROXY_SCHEMA_VERSION}")


def ready_schema(db_path: Path) -> bool:
    return store.schema_version(db_path) >= store.PROXY_SCHEMA_VERSION


def create(db_path: Path, segment_id: str, sha256: str) -> str:
    proxy_id = str(uuid4())
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("INSERT INTO proxy (id, segment_id, source_sha256, state, started_at_utc) VALUES (?,?,?,?,?)",
                           (proxy_id, segment_id, sha256, "queued", _now()))
    return proxy_id


def finish(db_path: Path, proxy_id: str, state: str, error: str | None = None, value: dict | None = None) -> None:
    value = value or {}
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("""UPDATE proxy SET state=?, error_code=?, width=?, height=?, frame_count=?, duration_ms=?, bytes=?,
            frames_sha256=?, finished_at_utc=? WHERE id=?""",
            (state, error, value.get("width"), value.get("height"), value.get("frame_count"), value.get("duration_ms"),
             value.get("bytes"), value.get("frames_sha256"), _now() if state not in ACTIVE else None, proxy_id))


def set_running(db_path: Path, proxy_id: str) -> None:
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("UPDATE proxy SET state='running' WHERE id=?", (proxy_id,))


def recover(db_path: Path) -> list[str]:
    """Mark copies left active by a previous launch as interrupted; returns their IDs so partial files can be removed."""
    if not ready_schema(db_path):
        return []
    with closing(store.connect(db_path)) as connection, connection:
        ids = [row[0] for row in connection.execute("SELECT id FROM proxy WHERE state IN ('queued','running')")]
        connection.execute("""UPDATE proxy SET state='interrupted', error_code='interrupted', finished_at_utc=?
            WHERE state IN ('queued','running')""", (_now(),))
    return ids


def _public(row) -> dict:
    return {key: row[key] for key in ("id", "segment_id", "state", "width", "height", "frame_count", "duration_ms", "bytes",
                                      "started_at_utc", "finished_at_utc")} | {"error": row["error_code"]}


def get(db_path: Path, proxy_id: str) -> dict | None:
    with closing(store.connect(db_path)) as connection:
        row = connection.execute("SELECT * FROM proxy WHERE id=?", (proxy_id,)).fetchone()
    return None if row is None else dict(row)


def latest(db_path: Path, session_id: str) -> list[dict]:
    """The newest copy per segment of the session, in segment order; segments without one are omitted."""
    if not ready_schema(db_path):
        return []
    with closing(store.connect(db_path)) as connection:
        rows = connection.execute("""SELECT proxy.* FROM proxy JOIN segment ON segment.id = proxy.segment_id
            WHERE segment.session_id=? ORDER BY segment.position, proxy.started_at_utc DESC, proxy.rowid DESC""",
            (session_id,)).fetchall()
    seen: dict[str, dict] = {}
    for row in rows:
        seen.setdefault(row["segment_id"], _public(row))
    return list(seen.values())


def ready_for(db_path: Path, segment: dict) -> dict | None:
    with closing(store.connect(db_path)) as connection:
        row = connection.execute("""SELECT * FROM proxy WHERE segment_id=? AND source_sha256=? AND state='ready'
            ORDER BY started_at_utc DESC, rowid DESC LIMIT 1""", (segment["id"], segment["sha256"])).fetchone()
    return None if row is None else dict(row)
