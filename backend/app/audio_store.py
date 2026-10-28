"""Original full-spectrum WAV sources and their video sync anchors (schema v10, feature expansion E7)."""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
from uuid import uuid4

from . import store
from .imports import ImportErrorResponse

SOURCE_MODES = ("full_spectrum", "heterodyne", "frequency_division", "time_expansion", "unknown")


class AudioError(ImportErrorResponse):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(code, message, status)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def upgrade(db_path: Path) -> None:
    """Explicit v9 -> v10 transition."""
    if not db_path.is_file():
        raise store.DatabaseSchemaError("Audio upgrade requires an existing version 9 database")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version >= store.AUDIO_SCHEMA_VERSION:
            return
        if version != store.CANDIDATE_SCHEMA_VERSION:
            raise store.DatabaseSchemaError("Audio upgrade requires database schema version 9")
        connection.execute("SELECT track_id FROM candidate_event LIMIT 1")
        connection.execute("""CREATE TABLE audio_source (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES recording_session(id),
            source_path TEXT NOT NULL UNIQUE,
            sha256 TEXT NOT NULL,
            identity_json TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            source_mode TEXT NOT NULL CHECK(source_mode IN ('full_spectrum','heterodyne','frequency_division','time_expansion','unknown')),
            channel INTEGER NOT NULL CHECK(channel >= 0),
            created_at_utc TEXT NOT NULL
        )""")
        connection.execute("""CREATE TABLE audio_anchor_event (
            audio_source_id TEXT NOT NULL REFERENCES audio_source(id),
            revision INTEGER NOT NULL CHECK(revision > 0),
            actor TEXT NOT NULL,
            segment_id TEXT NOT NULL REFERENCES segment(id),
            video_pts TEXT NOT NULL,
            audio_sample INTEGER NOT NULL CHECK(audio_sample >= 0),
            note TEXT NOT NULL,
            utc TEXT NOT NULL,
            PRIMARY KEY(audio_source_id, revision)
        )""")
        for operation in ("UPDATE", "DELETE"):
            connection.execute(f"""CREATE TRIGGER audio_anchor_event_no_{operation.lower()} BEFORE {operation} ON audio_anchor_event
                BEGIN SELECT RAISE(ABORT, 'append-only'); END""")
        connection.execute(f"PRAGMA user_version={store.AUDIO_SCHEMA_VERSION}")


def upgrade_label(db_path: Path) -> None:
    """Explicit v19 -> v20 transition: each recording gets a label such as "detector at the roost" (Phase 3 X9)."""
    if not db_path.is_file():
        raise store.DatabaseSchemaError("Audio label upgrade requires an existing version 19 database")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version >= store.AUDIO_LABEL_SCHEMA_VERSION:
            return
        if version != store.RENDER_SCHEMA_VERSION:
            raise store.DatabaseSchemaError("Audio label upgrade requires database schema version 19")
        connection.execute("ALTER TABLE audio_source ADD COLUMN label TEXT NOT NULL DEFAULT ''")
        connection.execute(f"PRAGMA user_version={store.AUDIO_LABEL_SCHEMA_VERSION}")


def set_label(db_path: Path, audio_id: str, label: str) -> dict:
    if store.schema_version(db_path) < store.AUDIO_LABEL_SCHEMA_VERSION:
        raise AudioError("audio_upgrade_required", "Upgrade storage before labelling recordings.")
    get_source(db_path, audio_id)
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("UPDATE audio_source SET label=? WHERE id=?", (" ".join(label.split()), audio_id))
    return get_source(db_path, audio_id)


def require_schema(db_path: Path) -> None:
    if store.schema_version(db_path) < store.AUDIO_SCHEMA_VERSION:
        raise AudioError("audio_upgrade_required", "Upgrade storage before adding audio.")


def add_source(db_path: Path, session_id: str, path: Path, inspected: dict, source_mode: str, channel: int) -> dict:
    require_schema(db_path)
    if channel >= inspected["channels"]:
        raise AudioError("audio_invalid", "Choose a channel that exists in the recording.", 422)
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        if connection.execute("SELECT 1 FROM recording_session WHERE id=?", (session_id,)).fetchone() is None:
            raise AudioError("audio_missing", "The survey does not exist.", 404)
        if connection.execute("SELECT 1 FROM audio_source WHERE source_path=? OR sha256=?", (str(path), inspected["sha256"])).fetchone():
            raise AudioError("audio_duplicate", "This recording is already added.")
        audio_id = str(uuid4())
        metadata = {key: inspected[key] for key in ("sample_rate", "channels", "frames", "codec", "filename")}
        metadata["file_clock"] = inspected.get("file_clock")
        connection.execute("""INSERT INTO audio_source (id, session_id, source_path, sha256, identity_json, metadata_json, source_mode, channel,
            created_at_utc) VALUES (?,?,?,?,?,?,?,?,?)""",
                           (audio_id, session_id, str(path), inspected["sha256"], json.dumps(inspected["identity"]),
                            json.dumps(metadata), source_mode, channel, _now()))
    return get_source(db_path, audio_id)


def _public(row, anchor) -> dict:
    return {"id": row["id"], "session_id": row["session_id"], "metadata": json.loads(row["metadata_json"]), "sha256": row["sha256"],
            "source_mode": row["source_mode"], "channel": row["channel"], "retunable": row["source_mode"] == "full_spectrum",
            "label": row["label"] if "label" in row.keys() else "", "anchor": anchor}


def _anchor(connection, audio_id: str) -> dict | None:
    row = connection.execute("SELECT * FROM audio_anchor_event WHERE audio_source_id=? ORDER BY revision DESC LIMIT 1", (audio_id,)).fetchone()
    return None if row is None else {"revision": row["revision"], "actor": row["actor"], "segment_id": row["segment_id"],
                                     "video_pts": row["video_pts"], "audio_sample": row["audio_sample"], "note": row["note"], "utc": row["utc"]}


def get_source(db_path: Path, audio_id: str, private: bool = False) -> dict:
    with closing(store.connect(db_path)) as connection:
        row = connection.execute("SELECT * FROM audio_source WHERE id=?", (audio_id,)).fetchone()
        if row is None:
            raise AudioError("audio_missing", "The audio recording does not exist.", 404)
        result = _public(row, _anchor(connection, audio_id))
    if private:
        result.update(source_path=row["source_path"], identity=json.loads(row["identity_json"]))
    return result


def list_sources(db_path: Path, session_id: str) -> list[dict]:
    if store.schema_version(db_path) < store.AUDIO_SCHEMA_VERSION:
        return []
    with closing(store.connect(db_path)) as connection:
        rows = connection.execute("SELECT * FROM audio_source WHERE session_id=? ORDER BY created_at_utc, rowid", (session_id,)).fetchall()
        return [_public(row, _anchor(connection, row["id"])) for row in rows]


def set_anchor(db_path: Path, audio_id: str, actor: str, expected_revision: int, segment_id: str, video_pts: int,
               audio_sample: int, note: str) -> dict:
    require_schema(db_path)
    actor = " ".join(actor.split())
    if not actor:
        raise AudioError("audio_invalid", "Enter your name or initials.", 422)
    source = get_source(db_path, audio_id)
    segment = store.segment_by_id(db_path, segment_id)
    if segment is None or segment["session_id"] != source["session_id"]:
        raise AudioError("audio_invalid", "Anchor to a video of the same survey.", 422)
    metadata = json.loads(segment["metadata_json"])
    if not int(metadata["first_pts"]) <= video_pts <= int(metadata["last_pts"]) or not 0 <= audio_sample < source["metadata"]["frames"]:
        raise AudioError("audio_invalid", "The anchor must lie inside both the video and the audio recording.", 422)
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        latest = connection.execute("SELECT COALESCE(MAX(revision), 0) FROM audio_anchor_event WHERE audio_source_id=?", (audio_id,)).fetchone()[0]
        if latest != expected_revision:
            raise AudioError("audio_conflict", "The sync anchor changed. Reload before saving.")
        connection.execute("INSERT INTO audio_anchor_event VALUES (?,?,?,?,?,?,?,?)",
                           (audio_id, latest + 1, actor, segment_id, str(video_pts), audio_sample, note.strip(), _now()))
    return get_source(db_path, audio_id)
