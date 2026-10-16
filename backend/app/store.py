"""Minimal SQLite persistence for local recording sessions."""

from __future__ import annotations

import sqlite3
import json
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

SCHEMA_VERSION = 1
MEDIA_SCHEMA_VERSION = 2


class DatabaseSchemaError(RuntimeError):
    """Refuse an unknown on-disk schema without changing user data."""


def connect(db_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(db_path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def initialise(db_path: Path) -> None:
    """Create the v1 schema or refuse an unrecognised database version."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect(db_path)) as connection, connection:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, SCHEMA_VERSION, MEDIA_SCHEMA_VERSION):
            raise DatabaseSchemaError(
                f"Unsupported database schema version {version}; expected {SCHEMA_VERSION} or {MEDIA_SCHEMA_VERSION}"
            )
        if version == 0:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchone()
            if existing is not None:
                raise DatabaseSchemaError("Existing unversioned database cannot be initialised safely")
            connection.execute(
                """CREATE TABLE recording_session (
                    id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
                    camera_ref TEXT NOT NULL CHECK (length(trim(camera_ref)) > 0),
                    created_at_utc TEXT NOT NULL
                )"""
            )
            connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        # An existing versioned file is not silently rewritten.
        connection.execute("SELECT 1 FROM recording_session LIMIT 1")
        if version == MEDIA_SCHEMA_VERSION:
            connection.execute("SELECT id, source_path, metadata_json FROM segment LIMIT 1")
            connection.execute("SELECT session_id, clock_anchor_json FROM session_media LIMIT 1")


def schema_version(db_path: Path) -> int:
    with closing(connect(db_path)) as connection:
        return int(connection.execute("PRAGMA user_version").fetchone()[0])


def upgrade_media(db_path: Path) -> None:
    """Explicit, transactional v1 -> v2 transition; never rebuild existing tables."""
    if not db_path.is_file():
        raise DatabaseSchemaError("Media upgrade requires an existing version 1 database")
    with closing(connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version == MEDIA_SCHEMA_VERSION:
            return
        if version != SCHEMA_VERSION:
            raise DatabaseSchemaError("Media upgrade requires database schema version 1")
        connection.execute("SELECT 1 FROM recording_session LIMIT 1")
        connection.execute("""CREATE TABLE segment (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES recording_session(id),
            position INTEGER NOT NULL CHECK(position >= 0),
            source_path TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            identity_json TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            continuity TEXT NOT NULL DEFAULT 'unknown'
                CHECK(continuity IN ('unknown', 'known_contiguous', 'known_gap')),
            continuity_provenance TEXT,
            UNIQUE(session_id, position), UNIQUE(source_path), UNIQUE(sha256), UNIQUE(identity_json)
        )""")
        connection.execute("""CREATE TABLE session_media (
            session_id TEXT PRIMARY KEY REFERENCES recording_session(id),
            clock_anchor_json TEXT
        )""")
        connection.execute(f"PRAGMA user_version={MEDIA_SCHEMA_VERSION}")


def session_exists(db_path: Path, session_id: str) -> bool:
    with closing(connect(db_path)) as connection:
        return connection.execute("SELECT 1 FROM recording_session WHERE id=?", (session_id,)).fetchone() is not None


def private_segments(db_path: Path, session_id: str) -> list[dict]:
    if schema_version(db_path) != MEDIA_SCHEMA_VERSION:
        return []
    with closing(connect(db_path)) as connection:
        rows = connection.execute(
            "SELECT * FROM segment WHERE session_id=? ORDER BY position", (session_id,)
        ).fetchall()
    return [dict(row) for row in rows]


def segment_by_id(db_path: Path, segment_id: str) -> dict | None:
    if schema_version(db_path) != MEDIA_SCHEMA_VERSION:
        return None
    with closing(connect(db_path)) as connection:
        row = connection.execute("SELECT * FROM segment WHERE id=?", (segment_id,)).fetchone()
    return dict(row) if row is not None else None


def clock_anchor(db_path: Path, session_id: str) -> dict | None:
    if schema_version(db_path) != MEDIA_SCHEMA_VERSION:
        return None
    with closing(connect(db_path)) as connection:
        row = connection.execute("SELECT clock_anchor_json FROM session_media WHERE session_id=?", (session_id,)).fetchone()
    return json.loads(row[0]) if row and row[0] else None


def commit_segments(db_path: Path, session_id: str, sources: list[tuple[Path, dict]]) -> None:
    """Commit the whole inspected batch, with duplicate checks inside the transaction."""
    with closing(connect(db_path)) as connection, connection:
        # A busy database must not hold the job/shutdown lock for the default 30 seconds.
        connection.execute("PRAGMA busy_timeout=1000")
        connection.execute("BEGIN IMMEDIATE")
        if connection.execute("PRAGMA user_version").fetchone()[0] != MEDIA_SCHEMA_VERSION:
            raise DatabaseSchemaError("Explicit media schema upgrade is required")
        if connection.execute("SELECT 1 FROM recording_session WHERE id=?", (session_id,)).fetchone() is None:
            raise ValueError("Session does not exist")
        existing = connection.execute("SELECT sha256, position, source_path, identity_json, session_id FROM segment").fetchall()
        hashes = {row[0] for row in existing}
        paths = {row[2] for row in existing}
        identities = {row[3] for row in existing}
        position = max((row[1] for row in existing if row[4] == session_id), default=-1) + 1
        for source_path, inspected in sources:
            metadata = dict(inspected)
            identity = metadata.pop("_identity")
            checksum = metadata["sha256"]
            identity_json = json.dumps(identity, sort_keys=True)
            if checksum in hashes or str(source_path) in paths or identity_json in identities:
                raise ValueError("This source is already present in the session or selected batch")
            hashes.add(checksum)
            paths.add(str(source_path))
            identities.add(identity_json)
            connection.execute(
                """INSERT INTO segment (id, session_id, position, source_path, sha256, identity_json, metadata_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (str(uuid4()), session_id, position, str(source_path), checksum, identity_json, json.dumps(metadata)),
            )
            position += 1
        connection.execute("INSERT OR IGNORE INTO session_media (session_id) VALUES (?)", (session_id,))


def update_media(db_path: Path, session_id: str, segment_ids: list[str], continuity: list[dict], anchor: dict | None) -> None:
    with closing(connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        rows = connection.execute("SELECT id FROM segment WHERE session_id=?", (session_id,)).fetchall()
        owned = {row[0] for row in rows}
        if len(segment_ids) != len(owned) or set(segment_ids) != owned:
            raise ValueError("Segment order must include each session segment exactly once")
        relations = {item["segment_id"]: item for item in continuity}
        if len(relations) != len(continuity) or set(relations) != owned:
            raise ValueError("Continuity must describe each session segment exactly once")
        if segment_ids and relations[segment_ids[0]]["status"] != "unknown":
            raise ValueError("The first segment has no preceding segment; its continuity must be unknown")
        if anchor is not None and anchor["segment_id"] not in owned:
            raise ValueError("Clock anchor must identify a segment in this session")
        if anchor is not None:
            row = connection.execute("SELECT metadata_json FROM segment WHERE id=?", (anchor["segment_id"],)).fetchone()
            metadata = json.loads(row[0])
            anchor = {**anchor, "source_pts": metadata["first_pts"], "time_base": metadata["time_base"],
                      "source_time": metadata["first_time"]}
        # Move into unused positive positions before assigning the new permutation.
        offset = len(owned) + 1
        connection.execute("UPDATE segment SET position=position+? WHERE session_id=?", (offset, session_id))
        for position, segment_id in enumerate(segment_ids):
            relation = relations[segment_id]
            connection.execute(
                "UPDATE segment SET position=?, continuity=?, continuity_provenance=? WHERE id=? AND session_id=?",
                (position, relation["status"], relation["provenance"], segment_id, session_id),
            )
        connection.execute(
            "INSERT INTO session_media (session_id, clock_anchor_json) VALUES (?, ?) "
            "ON CONFLICT(session_id) DO UPDATE SET clock_anchor_json=excluded.clock_anchor_json",
            (session_id, json.dumps(anchor) if anchor else None),
        )


def create_session(db_path: Path, display_name: str, camera_ref: str) -> dict[str, str]:
    record = {
        "id": str(uuid4()),
        "display_name": display_name.strip(),
        "camera_ref": camera_ref.strip(),
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
    }
    with closing(connect(db_path)) as connection, connection:
        connection.execute(
            "INSERT INTO recording_session (id, display_name, camera_ref, created_at_utc) VALUES (:id, :display_name, :camera_ref, :created_at_utc)",
            record,
        )
    return record


def list_sessions(db_path: Path) -> list[dict[str, str]]:
    with closing(connect(db_path)) as connection, connection:
        rows = connection.execute(
            "SELECT id, display_name, camera_ref, created_at_utc FROM recording_session ORDER BY created_at_utc, id"
        ).fetchall()
    return [dict(row) for row in rows]
