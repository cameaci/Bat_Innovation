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
SUMMARY_SCHEMA_VERSION = 3
REVIEW_SCHEMA_VERSION = 4
QA_SCHEMA_VERSION = 5
# Feature expansion steps (implementation/feature-expansion.md); each requires the previous version.
MODALITY_SCHEMA_VERSION = 6
TRACKING_SCHEMA_VERSION = 7
COUNT_SCHEMA_VERSION = 8
CANDIDATE_SCHEMA_VERSION = 9
AUDIO_SCHEMA_VERSION = 10
PROXY_SCHEMA_VERSION = 11
TRACKS_V2_SCHEMA_VERSION = 12
GATE_SPAN_SCHEMA_VERSION = 13
SAMPLE_CHECK_SCHEMA_VERSION = 14
TEMPLATE_SCHEMA_VERSION = 15
EXPANSION_SCHEMA_VERSIONS = (MODALITY_SCHEMA_VERSION, TRACKING_SCHEMA_VERSION, COUNT_SCHEMA_VERSION, CANDIDATE_SCHEMA_VERSION,
                             AUDIO_SCHEMA_VERSION, PROXY_SCHEMA_VERSION, TRACKS_V2_SCHEMA_VERSION, GATE_SPAN_SCHEMA_VERSION,
                             SAMPLE_CHECK_SCHEMA_VERSION, TEMPLATE_SCHEMA_VERSION)
CURRENT_SCHEMA_VERSION = EXPANSION_SCHEMA_VERSIONS[-1]
QA_SCHEMA_VERSIONS = (QA_SCHEMA_VERSION, *EXPANSION_SCHEMA_VERSIONS)
REVIEW_SCHEMA_VERSIONS = (REVIEW_SCHEMA_VERSION, *QA_SCHEMA_VERSIONS)
SUMMARY_SCHEMA_VERSIONS = (SUMMARY_SCHEMA_VERSION, *REVIEW_SCHEMA_VERSIONS)
MEDIA_SCHEMA_VERSIONS = (MEDIA_SCHEMA_VERSION, *SUMMARY_SCHEMA_VERSIONS)


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
        if version not in (0, SCHEMA_VERSION, *MEDIA_SCHEMA_VERSIONS):
            raise DatabaseSchemaError(
                f"Unsupported database schema version {version}; expected 1 to {CURRENT_SCHEMA_VERSION}"
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
        if version in MEDIA_SCHEMA_VERSIONS:
            connection.execute("SELECT id, source_path, metadata_json FROM segment LIMIT 1")
            connection.execute("SELECT session_id, clock_anchor_json FROM session_media LIMIT 1")
        if version in SUMMARY_SCHEMA_VERSIONS:
            connection.execute("SELECT id, state, source_snapshots_json FROM processing_run LIMIT 1")
            connection.execute("SELECT id, run_id, interval_json, image_sha256 FROM summary_window LIMIT 1")
        if version in REVIEW_SCHEMA_VERSIONS:
            connection.execute("SELECT evidence_revision,evidence_warning FROM summary_window LIMIT 1")
            connection.execute("SELECT window_id, revision, decision, observations_json FROM review_window LIMIT 1")
            connection.execute("SELECT window_id, revision, before_json, after_json FROM review_event LIMIT 1")

        if version in QA_SCHEMA_VERSIONS:
            connection.execute("SELECT window_id, revision, value_json FROM qa_window LIMIT 1")
            connection.execute("SELECT window_id, revision, before_json, after_json FROM qa_event LIMIT 1")
        if version >= MODALITY_SCHEMA_VERSION:
            connection.execute("SELECT modality, modality_provenance FROM segment LIMIT 1")
        if version >= TRACKING_SCHEMA_VERSION:
            connection.execute("SELECT id, summary_run_id, state FROM tracking_run LIMIT 1")
            connection.execute("SELECT id, run_id, points FROM track LIMIT 1")
        if version >= COUNT_SCHEMA_VERSION:
            connection.execute("SELECT id, revision, value_json FROM gate LIMIT 1")
            connection.execute("SELECT tracking_run_id, gate_id, revision FROM count_event LIMIT 1")
        if version >= CANDIDATE_SCHEMA_VERSION:
            connection.execute("SELECT track_id, revision, decision FROM candidate_event LIMIT 1")
        if version >= AUDIO_SCHEMA_VERSION:
            connection.execute("SELECT id, sha256, source_mode FROM audio_source LIMIT 1")
            connection.execute("SELECT audio_source_id, revision, audio_sample FROM audio_anchor_event LIMIT 1")
        if version >= SAMPLE_CHECK_SCHEMA_VERSION:
            connection.execute("SELECT id, presses_json, result_json FROM sample_check LIMIT 1")
        if version >= TEMPLATE_SCHEMA_VERSION:
            connection.execute("SELECT id, value_json, retired_utc FROM site_template LIMIT 1")


def schema_version(db_path: Path) -> int:
    with closing(connect(db_path)) as connection:
        return schema_version_of(connection)


def schema_version_of(connection: sqlite3.Connection) -> int:
    return int(connection.execute("PRAGMA user_version").fetchone()[0])


def upgrade_media(db_path: Path) -> None:
    """Explicit, transactional v1 -> v2 transition; never rebuild existing tables."""
    if not db_path.is_file():
        raise DatabaseSchemaError("Media upgrade requires an existing version 1 database")
    with closing(connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version in MEDIA_SCHEMA_VERSIONS:
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


MODALITIES = ("active_ir", "rendered_thermal")
THERMAL_LABEL = "Rendered thermal - no radiometric temperature analysis"


def upgrade_modality(db_path: Path) -> None:
    """Explicit v5 -> v6 transition: record each segment's declared visual modality."""
    if not db_path.is_file():
        raise DatabaseSchemaError("Modality upgrade requires an existing version 5 database")
    with closing(connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version >= MODALITY_SCHEMA_VERSION:
            return
        if version != QA_SCHEMA_VERSION:
            raise DatabaseSchemaError("Modality upgrade requires database schema version 5")
        connection.execute("SELECT window_id FROM qa_window LIMIT 1")
        connection.execute("""ALTER TABLE segment ADD COLUMN modality TEXT NOT NULL DEFAULT 'active_ir'
            CHECK(modality IN ('active_ir', 'rendered_thermal'))""")
        connection.execute("ALTER TABLE segment ADD COLUMN modality_provenance TEXT")
        connection.execute("UPDATE segment SET modality_provenance='recorded by the IR-only version'")
        connection.execute(f"PRAGMA user_version={MODALITY_SCHEMA_VERSION}")


def upgrade_expansion(db_path: Path) -> None:
    """Steps after the QA schema, run in order by one explicit storage upgrade action."""
    from . import audio_store, candidate_store, count_store, proxy_store, sample_store, template_store, tracking_store

    for step in (upgrade_modality, tracking_store.upgrade, count_store.upgrade, candidate_store.upgrade, audio_store.upgrade,
                 proxy_store.upgrade, tracking_store.upgrade_v2, count_store.upgrade_spans, sample_store.upgrade,
                 template_store.upgrade):
        step(db_path)


def session_exists(db_path: Path, session_id: str) -> bool:
    with closing(connect(db_path)) as connection:
        return connection.execute("SELECT 1 FROM recording_session WHERE id=?", (session_id,)).fetchone() is not None


def private_segments(db_path: Path, session_id: str) -> list[dict]:
    if schema_version(db_path) not in MEDIA_SCHEMA_VERSIONS:
        return []
    with closing(connect(db_path)) as connection:
        rows = connection.execute(
            "SELECT * FROM segment WHERE session_id=? ORDER BY position", (session_id,)
        ).fetchall()
    return [dict(row) for row in rows]


def segment_by_id(db_path: Path, segment_id: str) -> dict | None:
    if schema_version(db_path) not in MEDIA_SCHEMA_VERSIONS:
        return None
    with closing(connect(db_path)) as connection:
        row = connection.execute("SELECT * FROM segment WHERE id=?", (segment_id,)).fetchone()
    return dict(row) if row is not None else None


def clock_anchor(db_path: Path, session_id: str) -> dict | None:
    if schema_version(db_path) not in MEDIA_SCHEMA_VERSIONS:
        return None
    with closing(connect(db_path)) as connection:
        row = connection.execute("SELECT clock_anchor_json FROM session_media WHERE session_id=?", (session_id,)).fetchone()
    return json.loads(row[0]) if row and row[0] else None


def commit_segments(db_path: Path, session_id: str, sources: list[tuple[Path, dict]], modality: str = "active_ir") -> None:
    """Commit the whole inspected batch, with duplicate checks inside the transaction."""
    with closing(connect(db_path)) as connection, connection:
        # A busy database must not hold the job/shutdown lock for the default 30 seconds.
        connection.execute("PRAGMA busy_timeout=1000")
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version not in MEDIA_SCHEMA_VERSIONS:
            raise DatabaseSchemaError("Explicit media schema upgrade is required")
        if modality not in MODALITIES or (modality != "active_ir" and version < MODALITY_SCHEMA_VERSION):
            raise DatabaseSchemaError("Explicit storage upgrade is required to record a rendered thermal modality")
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
            values = (str(uuid4()), session_id, position, str(source_path), checksum, identity_json, json.dumps(metadata))
            if version >= MODALITY_SCHEMA_VERSION:
                connection.execute(
                    """INSERT INTO segment (id, session_id, position, source_path, sha256, identity_json, metadata_json,
                       modality, modality_provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'declared at import')""",
                    (*values, modality))
            else:
                connection.execute(
                    """INSERT INTO segment (id, session_id, position, source_path, sha256, identity_json, metadata_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""", values)
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
