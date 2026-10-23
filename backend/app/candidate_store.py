"""Append-only human decisions on candidate tracks (schema v9, feature expansion E5).

A decision on a track never changes a window's first review or the all-window progress. Each decision carries a
receipt: a ready original preview of the same unchanged segment that overlaps the track's source PTS span.
"""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path

from . import store, summary_store
from .imports import ImportErrorResponse

DECISIONS = ("bat", "not_bat", "uncertain")


class CandidateError(ImportErrorResponse):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(code, message, status)


def upgrade(db_path: Path) -> None:
    """Explicit v8 -> v9 transition."""
    if not db_path.is_file():
        raise store.DatabaseSchemaError("Candidate upgrade requires an existing version 8 database")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version >= store.CANDIDATE_SCHEMA_VERSION:
            return
        if version != store.COUNT_SCHEMA_VERSION:
            raise store.DatabaseSchemaError("Candidate upgrade requires database schema version 8")
        connection.execute("SELECT gate_id FROM count_event LIMIT 1")
        connection.execute("""CREATE TABLE candidate_event (
            track_id TEXT NOT NULL REFERENCES track(id),
            revision INTEGER NOT NULL CHECK(revision > 0),
            actor TEXT NOT NULL,
            decision TEXT NOT NULL CHECK(decision IN ('bat', 'not_bat', 'uncertain')),
            note TEXT NOT NULL,
            receipt_json TEXT NOT NULL,
            utc TEXT NOT NULL,
            PRIMARY KEY(track_id, revision)
        )""")
        for operation in ("UPDATE", "DELETE"):
            connection.execute(f"""CREATE TRIGGER candidate_event_no_{operation.lower()} BEFORE {operation} ON candidate_event
                BEGIN SELECT RAISE(ABORT, 'append-only'); END""")
        connection.execute(f"PRAGMA user_version={store.CANDIDATE_SCHEMA_VERSION}")


def require_schema(db_path: Path) -> None:
    if store.schema_version(db_path) < store.CANDIDATE_SCHEMA_VERSION:
        raise CandidateError("candidate_upgrade_required", "Upgrade storage before reviewing candidates.")


def candidates(db_path: Path, run_id: str) -> list[dict]:
    """Every track of a tracking run in recording order, with its window and latest human decision."""
    require_schema(db_path)
    with closing(store.connect(db_path)) as connection:
        run = connection.execute("SELECT summary_run_id FROM tracking_run WHERE id=?", (run_id,)).fetchone()
        if run is None:
            raise CandidateError("tracking_missing", "The tracking run does not exist.", 404)
        rows = connection.execute("""SELECT t.id, t.segment_id, t.track_index, t.first_pts, t.last_pts, t.point_count, s.position
            FROM track t JOIN segment s ON s.id = t.segment_id WHERE t.run_id=?""", (run_id,)).fetchall()
        events = connection.execute("""SELECT e.* FROM candidate_event e JOIN track t ON t.id = e.track_id WHERE t.run_id=?
            ORDER BY e.track_id, e.revision""", (run_id,)).fetchall()
    latest = {row["track_id"]: row for row in events}
    windows = summary_store.private_run(db_path, run["summary_run_id"])["windows"]

    def window(segment: str, pts: int) -> str | None:
        for item in windows:
            start, end = item["interval"]["start_pts"], item["interval"]["end_pts"]
            if item["segment_id"] == segment and pts >= int(start["num"]) // int(start["den"]) and (end is None or pts < int(end["num"]) // int(end["den"])):
                return item["id"]
        return None

    result = []
    for row in sorted(rows, key=lambda item: (item["position"], int(item["first_pts"]), item["track_index"])):
        event = latest.get(row["id"])
        result.append({"track_id": row["id"], "segment_id": row["segment_id"], "track_index": row["track_index"],
                       "first_pts": row["first_pts"], "last_pts": row["last_pts"], "point_count": row["point_count"],
                       "window_id": window(row["segment_id"], int(row["first_pts"])),
                       "revision": event["revision"] if event else 0,
                       "decision": {"decision": event["decision"], "actor": event["actor"], "note": event["note"], "utc": event["utc"]} if event else None})
    return result


def decide(db_path: Path, run_id: str, track_id: str, actor: str, expected_revision: int, decision: str, note: str, preview: dict) -> dict:
    require_schema(db_path)
    actor = " ".join(actor.split())
    if not actor or decision not in DECISIONS:
        raise CandidateError("candidate_invalid", "Enter your name and choose bat, not a bat or uncertain.", 422)
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        track = connection.execute("""SELECT t.*, s.sha256 FROM track t JOIN segment s ON s.id = t.segment_id
            WHERE t.id=? AND t.run_id=?""", (track_id, run_id)).fetchone()
        if track is None:
            raise CandidateError("candidate_missing", "The candidate track does not exist.", 404)
        manifest = preview.get("manifest") or {}
        frames = manifest.get("frames") or []
        if (preview.get("state") != "ready" or manifest.get("segment_id") != track["segment_id"] or manifest.get("source_sha256") != track["sha256"]
                or not frames or int(frames[0]["source_pts"]) > int(track["last_pts"]) or int(frames[-1]["source_pts"]) < int(track["first_pts"])):
            raise CandidateError("candidate_unverified", "Watch an original preview that covers this candidate before deciding.")
        latest = connection.execute("SELECT COALESCE(MAX(revision), 0) FROM candidate_event WHERE track_id=?", (track_id,)).fetchone()[0]
        if latest != expected_revision:
            raise CandidateError("candidate_conflict", "This candidate changed since you loaded it. Reload before saving.")
        receipt = {"preview_id": preview["id"], "actual_pts": manifest["actual_pts"], "last_frame_pts": frames[-1]["source_pts"],
                   "source_sha256": manifest["source_sha256"]}
        connection.execute("INSERT INTO candidate_event VALUES (?,?,?,?,?,?,?)",
                           (track_id, latest + 1, actor, decision, note.strip(), json.dumps(receipt),
                            datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")))
    return next(item for item in candidates(db_path, run_id) if item["track_id"] == track_id)
