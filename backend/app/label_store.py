"""Group labels on tracks (schema v17, Phase 3 X6): a reviewer's category, species and comment for one or many tracks.

Each action is one append-only event listing every track ID it labels; undoing is a new event that cancels an earlier
one. A track's label is the latest event naming it that has not been undone. Labels inform the reviewer and the
export; they never change a count layer, which still moves only through count actions. Species is free text typed by
a person and is never inferred.
"""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
from uuid import uuid4

from . import store
from .imports import ImportErrorResponse

CATEGORIES = ("exit", "entry", "fly_by", "foraging", "not_a_bat", "uncertain")
MAX_CUSTOM = 6
MAX_TRACKS = 5000


class LabelError(ImportErrorResponse):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(code, message, status)


def upgrade(db_path: Path) -> None:
    """Explicit v16 -> v17 transition."""
    if not db_path.is_file():
        raise store.DatabaseSchemaError("Track label upgrade requires an existing version 16 database")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version >= store.LABEL_SCHEMA_VERSION:
            return
        if version != store.ENHANCED_SCHEMA_VERSION:
            raise store.DatabaseSchemaError("Track label upgrade requires database schema version 16")
        connection.execute("""CREATE TABLE track_label_event (
            id TEXT PRIMARY KEY,
            tracking_run_id TEXT NOT NULL REFERENCES tracking_run(id),
            actor TEXT NOT NULL,
            track_ids_json TEXT NOT NULL,
            category TEXT,
            species TEXT NOT NULL,
            comment TEXT NOT NULL,
            undoes TEXT REFERENCES track_label_event(id),
            utc TEXT NOT NULL,
            CHECK((undoes IS NULL) = (category IS NOT NULL))
        )""")
        connection.execute("CREATE INDEX track_label_run ON track_label_event(tracking_run_id)")
        for operation in ("UPDATE", "DELETE"):
            connection.execute(f"""CREATE TRIGGER track_label_no_{operation.lower()} BEFORE {operation} ON track_label_event
                BEGIN SELECT RAISE(ABORT, 'append-only'); END""")
        connection.execute(f"PRAGMA user_version={store.LABEL_SCHEMA_VERSION}")


def _require(db_path: Path) -> None:
    if store.schema_version(db_path) < store.LABEL_SCHEMA_VERSION:
        raise LabelError("label_upgrade_required", "Upgrade storage before labelling tracks.")


def _event(row) -> dict:
    return {"id": row["id"], "actor": row["actor"], "track_ids": json.loads(row["track_ids_json"]), "category": row["category"],
            "species": row["species"], "comment": row["comment"], "undoes": row["undoes"], "utc": row["utc"]}


def _events(connection, run_id: str) -> list[dict]:
    rows = connection.execute("SELECT * FROM track_label_event WHERE tracking_run_id=? ORDER BY rowid", (run_id,)).fetchall()
    return [_event(row) for row in rows]


def _custom(events: list[dict]) -> list[str]:
    seen: list[str] = []
    for event in events:
        if event["category"] and event["category"] not in CATEGORIES and event["category"] not in seen:
            seen.append(event["category"])
    return seen


def labels(db_path: Path, run_id: str) -> dict:
    """Every label event of a run (oldest first), the current label per track and the run's custom categories."""
    if store.schema_version(db_path) < store.LABEL_SCHEMA_VERSION:
        return {"events": [], "tracks": {}, "custom": [], "categories": list(CATEGORIES)}
    with closing(store.connect(db_path)) as connection:
        events = _events(connection, run_id)
    undone = {event["undoes"] for event in events if event["undoes"]}
    current: dict[str, dict] = {}
    for event in events:
        if event["undoes"] or event["id"] in undone:
            continue
        for track_id in event["track_ids"]:
            current[track_id] = {"category": event["category"], "species": event["species"], "comment": event["comment"],
                                 "actor": event["actor"], "utc": event["utc"], "event_id": event["id"]}
    return {"events": events, "tracks": current, "custom": _custom(events), "categories": list(CATEGORIES)}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def label(db_path: Path, run_id: str, actor: str, track_ids: list[str], category: str, species: str, comment: str) -> dict:
    _require(db_path)
    actor, category, species = " ".join(actor.split()), " ".join(category.split()), " ".join(species.split())
    unique = list(dict.fromkeys(track_ids))
    if not actor:
        raise LabelError("label_invalid", "Enter your name or initials.", 422)
    if not unique or len(unique) > MAX_TRACKS:
        raise LabelError("label_invalid", f"Select between 1 and {MAX_TRACKS} tracks.", 422)
    if not category or len(category) > 30:
        raise LabelError("label_invalid", "Choose a category (custom labels up to 30 characters).", 422)
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        if connection.execute("SELECT 1 FROM tracking_run WHERE id=?", (run_id,)).fetchone() is None:
            raise LabelError("tracking_missing", "The tracking run does not exist.", 404)
        known = {row[0] for row in connection.execute("SELECT id FROM track WHERE run_id=?", (run_id,))}
        if any(track_id not in known for track_id in unique):
            raise LabelError("label_invalid", "Some selected tracks are not part of this tracking run. Reload the table.", 422)
        custom = _custom(_events(connection, run_id))
        if category not in CATEGORIES and category not in custom and len(custom) >= MAX_CUSTOM:
            raise LabelError("label_custom_limit", f"A survey takes at most {MAX_CUSTOM} custom labels. Reuse one of: {', '.join(custom)}.", 422)
        event_id = str(uuid4())
        connection.execute("""INSERT INTO track_label_event (id, tracking_run_id, actor, track_ids_json, category, species, comment, undoes, utc)
            VALUES (?,?,?,?,?,?,?,NULL,?)""", (event_id, run_id, actor, json.dumps(unique), category, species, comment.strip(), _now()))
    return labels(db_path, run_id)


def undo(db_path: Path, run_id: str, event_id: str, actor: str) -> dict:
    _require(db_path)
    actor = " ".join(actor.split())
    if not actor:
        raise LabelError("label_invalid", "Enter your name or initials.", 422)
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        events = _events(connection, run_id)
        target = next((event for event in events if event["id"] == event_id), None)
        if target is None or target["undoes"]:
            raise LabelError("label_missing", "That label action does not exist or is itself an undo.", 404)
        if any(event["undoes"] == event_id for event in events):
            raise LabelError("label_conflict", "That label action was already undone.")
        connection.execute("""INSERT INTO track_label_event (id, tracking_run_id, actor, track_ids_json, category, species, comment, undoes, utc)
            VALUES (?,?,?,?,NULL,'','',?,?)""", (str(uuid4()), run_id, actor, json.dumps(target["track_ids"]), event_id, _now()))
    return labels(db_path, run_id)
