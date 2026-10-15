"""Minimal SQLite persistence for local recording sessions."""

from __future__ import annotations

import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

SCHEMA_VERSION = 1


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
        if version not in (0, SCHEMA_VERSION):
            raise RuntimeError(
                f"Unsupported database schema version {version}; expected {SCHEMA_VERSION}"
            )
        if version == 0:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchone()
            if existing is not None:
                raise RuntimeError("Existing unversioned database cannot be initialised safely")
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
