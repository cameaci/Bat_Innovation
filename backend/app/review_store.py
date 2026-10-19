"""Append-only manual review events and their transactional SQLite projection."""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
from fractions import Fraction
import json
from pathlib import Path
import re
import sqlite3
from uuid import uuid4

from . import store, windows
from .imports import ImportErrorResponse

DECISIONS = {"unreviewed", "reviewed_with_observations", "reviewed_no_discernible_event"}
ACTIONS = {"add_observation", "update_observation", "delete_observation", "set_decision", "unable_to_assess"}
CATEGORIES = {"bat", "insect", "bird", "other", "uncertain"}
OBSERVATION_FIELDS = {"segment_id", "start_pts", "end_pts", "category", "activity", "count", "uncertain", "notes"}
MAX_OBSERVATIONS = 100


class ReviewError(ImportErrorResponse):
    """A bounded, path-free manual review error."""


def _invalid(message: str) -> ReviewError:
    return ReviewError("review_invalid", message, 422)


def _require_schema(connection: sqlite3.Connection) -> None:
    if connection.execute("PRAGMA user_version").fetchone()[0] != store.REVIEW_SCHEMA_VERSION:
        raise ReviewError("review_schema_required", "Explicit review schema upgrade is required.", 409)


def upgrade(db_path: Path) -> None:
    """Explicit v3 -> v4; all DDL and the version commit or roll back together."""
    if not db_path.is_file():
        raise store.DatabaseSchemaError("Review upgrade requires an existing version 3 database")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version == store.REVIEW_SCHEMA_VERSION:
            return
        if version != store.SUMMARY_SCHEMA_VERSION:
            raise store.DatabaseSchemaError("Review upgrade requires database schema version 3")
        connection.execute("SELECT id, run_id, interval_json FROM summary_window LIMIT 1")
        connection.execute("ALTER TABLE summary_window ADD COLUMN evidence_revision INTEGER NOT NULL DEFAULT 0 CHECK(evidence_revision >= 0)")
        connection.execute("ALTER TABLE summary_window ADD COLUMN evidence_warning TEXT")
        connection.execute("""CREATE TABLE review_window (
            window_id TEXT PRIMARY KEY REFERENCES summary_window(id),
            run_id TEXT NOT NULL REFERENCES processing_run(id),
            revision INTEGER NOT NULL CHECK(revision > 0),
            decision TEXT NOT NULL CHECK(decision IN
                ('unreviewed','reviewed_with_observations','reviewed_no_discernible_event')),
            observations_json TEXT NOT NULL CHECK(json_valid(observations_json)),
            unable_note TEXT NOT NULL,
            verification_json TEXT CHECK(verification_json IS NULL OR json_valid(verification_json)),
            actor TEXT NOT NULL CHECK(length(trim(actor)) BETWEEN 1 AND 120),
            updated_at_utc TEXT NOT NULL
        )""")
        connection.execute("""CREATE TABLE review_event (
            window_id TEXT NOT NULL REFERENCES summary_window(id),
            run_id TEXT NOT NULL REFERENCES processing_run(id),
            revision INTEGER NOT NULL CHECK(revision > 0),
            utc TEXT NOT NULL,
            actor TEXT NOT NULL CHECK(length(trim(actor)) BETWEEN 1 AND 120),
            action TEXT NOT NULL CHECK(action IN
                ('add_observation','update_observation','delete_observation','set_decision','unable_to_assess')),
            binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
            before_json TEXT NOT NULL CHECK(json_valid(before_json)),
            after_json TEXT NOT NULL CHECK(json_valid(after_json)),
            observation_id TEXT,
            span_json TEXT CHECK(span_json IS NULL OR json_valid(span_json)),
            PRIMARY KEY(window_id, revision)
        )""")
        connection.execute("CREATE INDEX review_window_run ON review_window(run_id)")
        # REPLACE can delete a conflicting row without firing DELETE triggers.
        connection.execute("""CREATE TRIGGER review_event_no_replace BEFORE INSERT ON review_event
            WHEN EXISTS(SELECT 1 FROM review_event WHERE window_id=NEW.window_id AND revision=NEW.revision)
            BEGIN SELECT RAISE(ABORT, 'Review history is append-only'); END""")
        connection.execute("""CREATE TRIGGER review_event_no_update BEFORE UPDATE ON review_event
            BEGIN SELECT RAISE(ABORT, 'Review history is append-only'); END""")
        connection.execute("""CREATE TRIGGER review_event_no_delete BEFORE DELETE ON review_event
            BEGIN SELECT RAISE(ABORT, 'Review history is append-only'); END""")
        connection.execute(f"PRAGMA user_version={store.REVIEW_SCHEMA_VERSION}")


def _binding(connection: sqlite3.Connection, window_id: str) -> dict:
    row = connection.execute("""SELECT w.id,w.run_id,w.segment_id,w.source_sha256,w.time_base_json,w.evidence_revision,
        w.interval_json,r.parameter_hash,r.source_snapshots_json FROM summary_window AS w
        JOIN processing_run AS r ON r.id=w.run_id WHERE w.id=?""", (window_id,)).fetchone()
    if row is None:
        raise ReviewError("review_missing", "The summary window does not exist.", 404)
    source = next((item for item in json.loads(row["source_snapshots_json"])
                   if item["id"] == row["segment_id"]), None)
    if source is None:
        raise ReviewError("review_unavailable", "The immutable source snapshot is unavailable.", 409)
    return {"run_id": row["run_id"], "window_id": row["id"], "segment_id": row["segment_id"],
            "source_sha256": row["source_sha256"], "parameter_hash": row["parameter_hash"],
            "evidence_revision": row["evidence_revision"],
            "time_base": json.loads(row["time_base_json"]), "interval": json.loads(row["interval_json"]),
            "source_snapshot": source}


def binding(db_path: Path, window_id: str) -> dict:
    """Private evidence binding; source_snapshot contains a private local path."""
    with closing(store.connect(db_path)) as connection:
        _require_schema(connection)
        return _binding(connection, window_id)


def evidence_epoch(db_path: Path, window_id: str, warning: str | None) -> int:
    """Remember availability transitions without changing human decisions or history.

    Restoring identical files must not revive an old decision after observed evidence
    failure. Repeated validation of the same condition performs no UPDATE.
    """
    if warning is not None and (not isinstance(warning, str) or not 1 <= len(warning) <= 120):
        raise _invalid("Evidence warnings must be a bounded validation code or absent.")
    with closing(store.connect(db_path)) as connection:
        _require_schema(connection)
        row = connection.execute("SELECT evidence_revision,evidence_warning FROM summary_window WHERE id=?",
                                 (window_id,)).fetchone()
        if row is None:
            raise ReviewError("review_missing", "The summary window does not exist.", 404)
        if row["evidence_warning"] == warning:
            return row["evidence_revision"]
    try:
        with closing(store.connect(db_path)) as connection, connection:
            connection.execute("PRAGMA busy_timeout=1000")
            connection.execute("BEGIN IMMEDIATE")
            _require_schema(connection)
            row = connection.execute("SELECT evidence_revision,evidence_warning FROM summary_window WHERE id=?",
                                     (window_id,)).fetchone()
            if row is None:
                raise ReviewError("review_missing", "The summary window does not exist.", 404)
            revision = row["evidence_revision"]
            if row["evidence_warning"] != warning:
                revision += 1
                connection.execute("UPDATE summary_window SET evidence_revision=?,evidence_warning=? WHERE id=?",
                                   (revision, warning, window_id))
            return revision
    except sqlite3.OperationalError as error:
        if "locked" in str(error).lower() or "busy" in str(error).lower():
            raise ReviewError("review_busy", "The local review database is busy. Keep your draft and retry.", 409) from None
        raise


def _projection(row: sqlite3.Row | None) -> dict:
    if row is None:
        return {"revision": 0, "decision": "unreviewed", "observations": [], "unable_note": "",
                "verification": None, "actor": None, "updated_at_utc": None}
    return {"revision": row["revision"], "decision": row["decision"],
            "observations": json.loads(row["observations_json"]), "unable_note": row["unable_note"],
            "verification": json.loads(row["verification_json"]) if row["verification_json"] else None,
            "actor": row["actor"], "updated_at_utc": row["updated_at_utc"]}


def get(db_path: Path, window_id: str) -> dict:
    with closing(store.connect(db_path)) as connection:
        _require_schema(connection)
        _binding(connection, window_id)
        return _projection(connection.execute("SELECT * FROM review_window WHERE window_id=?", (window_id,)).fetchone())


def headers(db_path: Path, run_id: str) -> dict[str, dict]:
    """Load every window's small review header, never its observations or history."""
    with closing(store.connect(db_path)) as connection:
        _require_schema(connection)
        rows = connection.execute("""SELECT w.id,p.revision,p.decision,p.unable_note,p.verification_json,
            p.actor,p.updated_at_utc,json_array_length(p.observations_json) AS observation_count
            FROM summary_window AS w LEFT JOIN review_window AS p ON p.window_id=w.id
            WHERE w.run_id=? ORDER BY w.rowid""", (run_id,)).fetchall()
    return {row["id"]: {"revision": row["revision"] or 0, "decision": row["decision"] or "unreviewed",
            "observation_count": row["observation_count"] or 0, "unable_note": row["unable_note"] or "",
            "verification": json.loads(row["verification_json"]) if row["verification_json"] else None,
            "actor": row["actor"], "updated_at_utc": row["updated_at_utc"]} for row in rows}


def _text(value: object, field: str, maximum: int, *, required: bool = False) -> str:
    if not isinstance(value, str) or len(value) > maximum or (required and not value.strip()):
        raise _invalid(f"{field} must be {'non-empty text' if required else 'text'} of at most {maximum} characters.")
    return value.strip() if required else value


def _pts(value: object) -> int:
    if not isinstance(value, str) or re.fullmatch(r"-?(0|[1-9][0-9]{0,18})", value) is None:
        raise _invalid("Observation PTS must be exact integer source tick strings.")
    number = int(value)
    if not -(2 ** 63) <= number < 2 ** 63:
        raise _invalid("Observation PTS exceeds the supported signed 64-bit source range.")
    return number


def _observation(value: object, evidence: dict) -> dict:
    if not isinstance(value, dict) or set(value) != OBSERVATION_FIELDS:
        raise _invalid("Provide exactly the supported provisional observation fields.")
    item = dict(value)
    if item["segment_id"] != evidence["segment_id"]:
        raise _invalid("An observation must identify this window's original segment.")
    first, end = _pts(item["start_pts"]), _pts(item["end_pts"])
    metadata = json.loads(evidence["source_snapshot"]["metadata_json"])
    time_base = windows.fraction(evidence["time_base"])
    segment_end = (windows.fraction(metadata["end_time"]) / time_base if metadata["end_time"] is not None
                   else Fraction(int(metadata["last_pts"])))
    interval = evidence["interval"]
    window_start = windows.fraction(interval["start_pts"])
    window_end = windows.fraction(interval["end_pts"]) if interval["end_pts"] is not None else segment_end
    if not (int(metadata["first_pts"]) <= first < end <= segment_end and window_start <= first < end <= window_end):
        raise _invalid("The exact half-open observation span must stay within this source window and known source bounds.")
    if not isinstance(item["category"], str) or item["category"] not in CATEGORIES:
        raise _invalid("Choose a supported provisional visual category.")
    if item["activity"] is not None:
        item["activity"] = _text(item["activity"], "Activity", 120).strip() or None
    if item["count"] is not None and (type(item["count"]) is not int or not 0 <= item["count"] <= 100000):
        raise _invalid("Count must be an integer from 0 to 100000 or unknown.")
    if type(item["uncertain"]) is not bool:
        raise _invalid("Uncertainty must be explicitly true or false.")
    item["notes"] = _text(item["notes"], "Observation notes", 2000)
    item["start_pts"], item["end_pts"] = str(first), str(end)
    return item


def _delta(projection: dict, observation: dict | None) -> dict:
    return {"decision": projection["decision"], "unable_note": projection["unable_note"],
            "verification": projection["verification"], "observation": observation}


def apply(db_path: Path, window_id: str, expected_revision: int, actor: str, action: str,
          observation: dict | None = None, observation_id: str | None = None,
          decision: str | None = None, note: str | None = None, verification: dict | None = None) -> dict:
    """Append one explicit human action and atomically advance its projection."""
    actor = _text(actor, "Reviewer label", 120, required=True)
    if type(expected_revision) is not int or not 0 <= expected_revision < 2 ** 31 or not isinstance(action, str) or action not in ACTIONS:
        raise _invalid("Provide a valid review action and expected revision.")
    try:
        with closing(store.connect(db_path)) as connection, connection:
            connection.execute("PRAGMA busy_timeout=1000")
            connection.execute("BEGIN IMMEDIATE")
            _require_schema(connection)
            evidence = _binding(connection, window_id)
            old = _projection(connection.execute("SELECT * FROM review_window WHERE window_id=?", (window_id,)).fetchone())
            if old["revision"] != expected_revision:
                raise ReviewError("review_conflict", "This review changed. Keep your draft and reload the latest revision before saving.", 409)
            new = {**old, "observations": [dict(item) for item in old["observations"]]}
            affected_before, affected_after = None, None
            if action in {"add_observation", "update_observation", "delete_observation"}:
                if action == "add_observation":
                    if observation_id is not None or len(new["observations"]) >= MAX_OBSERVATIONS:
                        raise _invalid("This window supports at most 100 observations; new observations receive a generated ID.")
                    observation_id = str(uuid4())
                else:
                    affected_before = next((item for item in old["observations"] if item["id"] == observation_id), None)
                    if affected_before is None:
                        raise ReviewError("review_missing", "The provisional observation does not exist in this window.", 404)
                if action != "delete_observation":
                    affected_after = {**_observation(observation, evidence), "id": observation_id}
                new["observations"] = [item for item in new["observations"] if item["id"] != observation_id]
                if affected_after is not None:
                    # Preserve the position when an existing observation is edited.
                    position = next((index for index, item in enumerate(old["observations"]) if item["id"] == observation_id), len(new["observations"]))
                    new["observations"].insert(position, affected_after)
                new.update(decision="unreviewed", verification=None)
            elif action == "unable_to_assess":
                new.update(decision="unreviewed", unable_note=_text(note, "Unable-to-assess note", 2000, required=True), verification=None)
            else:
                if not isinstance(decision, str) or decision not in DECISIONS:
                    raise _invalid("Choose a supported first-review decision.")
                if decision == "reviewed_with_observations" and not new["observations"]:
                    raise _invalid("Review with observations requires at least one saved observation.")
                if decision == "reviewed_no_discernible_event" and new["observations"]:
                    raise _invalid("Review with no discernible event requires zero saved observations.")
                if decision != "unreviewed":
                    if evidence["interval"]["end_pts"] is None or not isinstance(verification, dict) or not verification:
                        raise ReviewError("review_unavailable", "A finite source window and verified original preview are required for review completion.", 409)
                    if len(json.dumps(verification)) > 4096:
                        raise _invalid("The source-verification receipt exceeds the supported size.")
                new.update(decision=decision, verification=verification if decision != "unreviewed" else None, unable_note="")
            new.update(revision=old["revision"] + 1, actor=actor, updated_at_utc=datetime.now(timezone.utc).isoformat())
            public_binding = {key: value for key, value in evidence.items() if key != "source_snapshot"}
            affected = affected_after or affected_before
            span = ({key: affected[key] for key in ("segment_id", "start_pts", "end_pts")} if affected else None)
            connection.execute("""INSERT INTO review_event
                (window_id,run_id,revision,utc,actor,action,binding_json,before_json,after_json,observation_id,span_json)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)""", (window_id, evidence["run_id"], new["revision"], new["updated_at_utc"], actor,
                action, json.dumps(public_binding), json.dumps(_delta(old, affected_before)), json.dumps(_delta(new, affected_after)),
                observation_id, json.dumps(span) if span else None))
            connection.execute("""INSERT INTO review_window
                (window_id,run_id,revision,decision,observations_json,unable_note,verification_json,actor,updated_at_utc)
                VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(window_id) DO UPDATE SET
                revision=excluded.revision,decision=excluded.decision,observations_json=excluded.observations_json,
                unable_note=excluded.unable_note,verification_json=excluded.verification_json,
                actor=excluded.actor,updated_at_utc=excluded.updated_at_utc""", (window_id, evidence["run_id"], new["revision"], new["decision"],
                json.dumps(new["observations"]), new["unable_note"], json.dumps(new["verification"]) if new["verification"] is not None else None,
                actor, new["updated_at_utc"]))
            return new
    except sqlite3.OperationalError as error:
        if "locked" in str(error).lower() or "busy" in str(error).lower():
            raise ReviewError("review_busy", "The local review database is busy. Keep your draft and retry.", 409) from None
        raise


def history(db_path: Path, window_id: str, after_revision: int = 0, limit: int = 50) -> dict:
    if type(after_revision) is not int or not 0 <= after_revision < 2 ** 31 or type(limit) is not int or not 1 <= limit <= 50:
        raise _invalid("Review history requires a non-negative revision cursor and at most 50 events.")
    with closing(store.connect(db_path)) as connection:
        _require_schema(connection)
        _binding(connection, window_id)
        rows = connection.execute("""SELECT * FROM review_event WHERE window_id=? AND revision>?
            ORDER BY revision LIMIT ?""", (window_id, after_revision, limit + 1)).fetchall()
    events = [{"revision": row["revision"], "utc": row["utc"], "actor": row["actor"], "action": row["action"],
               **json.loads(row["binding_json"]), "before": json.loads(row["before_json"]),
               "after": json.loads(row["after_json"]), "observation_id": row["observation_id"],
               "span": json.loads(row["span_json"]) if row["span_json"] else None} for row in rows[:limit]]
    return {"events": events, "next_after_revision": events[-1]["revision"] if len(rows) > limit else None}
