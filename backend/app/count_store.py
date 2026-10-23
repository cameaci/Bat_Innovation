"""Gates, crossings and three-layer counts (schema v8, feature expansion E3).

Gates are human-drawn, revisioned and audited. Crossings are derived on demand from stored tracks and one gate
revision, with deterministic keys, so they are never a competing source of truth. Reviewer and QA actions are
append-only. The algorithm, reviewer and QA layers are reported separately and never merged.
"""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
from uuid import NAMESPACE_URL, uuid4, uuid5

from . import gates, store, summary_store, tracks
from .imports import ImportErrorResponse

REVIEW_ACTIONS = {"confirm", "reject", "add_missed", "clear"}


class CountError(ImportErrorResponse):
    """Safe, actionable count and gate failures (no paths or native text)."""

    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(code, message, status)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def upgrade(db_path: Path) -> None:
    """Explicit v7 -> v8 transition."""
    if not db_path.is_file():
        raise store.DatabaseSchemaError("Count upgrade requires an existing version 7 database")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version >= store.COUNT_SCHEMA_VERSION:
            return
        if version != store.TRACKING_SCHEMA_VERSION:
            raise store.DatabaseSchemaError("Count upgrade requires database schema version 7")
        connection.execute("SELECT id FROM track LIMIT 1")
        connection.execute("""CREATE TABLE gate (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES recording_session(id),
            revision INTEGER NOT NULL CHECK(revision > 0),
            state TEXT NOT NULL CHECK(state IN ('active', 'retired')),
            value_json TEXT NOT NULL
        )""")
        connection.execute("""CREATE TABLE gate_event (
            gate_id TEXT NOT NULL REFERENCES gate(id),
            revision INTEGER NOT NULL,
            actor TEXT NOT NULL,
            action TEXT NOT NULL,
            before_json TEXT,
            after_json TEXT NOT NULL,
            utc TEXT NOT NULL,
            PRIMARY KEY(gate_id, revision)
        )""")
        connection.execute("""CREATE TABLE count_event (
            tracking_run_id TEXT NOT NULL REFERENCES tracking_run(id),
            gate_id TEXT NOT NULL REFERENCES gate(id),
            revision INTEGER NOT NULL CHECK(revision > 0),
            layer TEXT NOT NULL CHECK(layer IN ('review', 'qa')),
            actor TEXT NOT NULL,
            value_json TEXT NOT NULL,
            utc TEXT NOT NULL,
            PRIMARY KEY(tracking_run_id, gate_id, revision)
        )""")
        for table in ("gate_event", "count_event"):
            for operation in ("UPDATE", "DELETE"):
                connection.execute(f"""CREATE TRIGGER {table}_no_{operation.lower()} BEFORE {operation} ON {table}
                    BEGIN SELECT RAISE(ABORT, 'append-only'); END""")
        connection.execute(f"PRAGMA user_version={store.COUNT_SCHEMA_VERSION}")


def require_schema(db_path: Path) -> None:
    if store.schema_version(db_path) < store.COUNT_SCHEMA_VERSION:
        raise CountError("count_upgrade_required", "Upgrade storage before drawing gates.")


def _actor(value: str) -> str:
    actor = " ".join(value.split())
    if not actor:
        raise CountError("count_invalid", "Enter your name or initials.", 422)
    return actor


def list_gates(db_path: Path, session_id: str) -> list[dict]:
    if store.schema_version(db_path) < store.COUNT_SCHEMA_VERSION:
        return []
    with closing(store.connect(db_path)) as connection:
        rows = connection.execute("SELECT * FROM gate WHERE session_id=? ORDER BY rowid", (session_id,)).fetchall()
    return [{"id": row["id"], "session_id": row["session_id"], "revision": row["revision"], "state": row["state"],
             **json.loads(row["value_json"])} for row in rows]


def get_gate(db_path: Path, gate_id: str) -> dict:
    with closing(store.connect(db_path)) as connection:
        row = connection.execute("SELECT * FROM gate WHERE id=?", (gate_id,)).fetchone()
    if row is None:
        raise CountError("gate_missing", "The gate does not exist.", 404)
    return {"id": row["id"], "session_id": row["session_id"], "revision": row["revision"], "state": row["state"],
            **json.loads(row["value_json"])}


def save_gate(db_path: Path, session_id: str, gate_id: str | None, expected_revision: int, actor: str,
              value: dict | None) -> dict:
    """Create (gate_id None), update (value) or retire (value None) with an optimistic revision check."""
    require_schema(db_path)
    actor = _actor(actor)
    if value is not None:
        try:
            gates.validate(value)
        except ValueError as error:
            raise CountError("gate_invalid", str(error), 422) from None
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        if gate_id is None:
            if connection.execute("SELECT 1 FROM recording_session WHERE id=?", (session_id,)).fetchone() is None:
                raise CountError("gate_missing", "The survey does not exist.", 404)
            if value is None or expected_revision != 0:
                raise CountError("gate_conflict", "A new gate starts at revision 0.")
            gate_id, before, revision, state, action = str(uuid4()), None, 1, "active", "create"
            connection.execute("INSERT INTO gate (id, session_id, revision, state, value_json) VALUES (?,?,?,?,?)",
                               (gate_id, session_id, revision, state, json.dumps(value)))
        else:
            row = connection.execute("SELECT * FROM gate WHERE id=? AND session_id=?", (gate_id, session_id)).fetchone()
            if row is None:
                raise CountError("gate_missing", "The gate does not exist.", 404)
            if row["revision"] != expected_revision or row["state"] != "active":
                raise CountError("gate_conflict", "The gate changed or was retired. Reload it before editing.")
            before = {"state": row["state"], **json.loads(row["value_json"])}
            revision = row["revision"] + 1
            state, action = ("retired", "retire") if value is None else ("active", "update")
            value = value if value is not None else json.loads(row["value_json"])
            connection.execute("UPDATE gate SET revision=?, state=?, value_json=? WHERE id=?",
                               (revision, state, json.dumps(value), gate_id))
        connection.execute("INSERT INTO gate_event VALUES (?,?,?,?,?,?,?)",
                           (gate_id, revision, actor, action, json.dumps(before) if before else None,
                            json.dumps({"state": state, **value}), _now()))
    return get_gate(db_path, gate_id)


def gate_history(db_path: Path, gate_id: str) -> list[dict]:
    with closing(store.connect(db_path)) as connection:
        rows = connection.execute("SELECT * FROM gate_event WHERE gate_id=? ORDER BY revision", (gate_id,)).fetchall()
    return [{"revision": row["revision"], "actor": row["actor"], "action": row["action"], "utc": row["utc"],
             "before": json.loads(row["before_json"]) if row["before_json"] else None, "after": json.loads(row["after_json"])}
            for row in rows]


def _key(run_id: str, gate: dict, track_id: str, pts: int) -> str:
    return str(uuid5(NAMESPACE_URL, f"bat-crossing:{run_id}:{gate['id']}:{gate['revision']}:{track_id}:{pts}"))


def derived_crossings(db_path: Path, run_id: str, gate: dict) -> list[dict]:
    """Crossings of every stored track of a tracking run with one gate revision (derived, reproducible)."""
    with closing(store.connect(db_path)) as connection:
        run = connection.execute("SELECT summary_run_id FROM tracking_run WHERE id=?", (run_id,)).fetchone()
        rows = connection.execute("SELECT id, segment_id, points, points_sha256 FROM track WHERE run_id=? ORDER BY segment_id, track_index",
                                  (run_id,)).fetchall()
    if run is None:
        raise CountError("tracking_missing", "The tracking run does not exist.", 404)
    summary = summary_store.private_run(db_path, run["summary_run_id"])
    sizes = {source["id"]: (json.loads(source["metadata_json"])["width"], json.loads(source["metadata_json"])["height"])
             for source in summary["sources"]}
    by_segment: dict[str, list[dict]] = {}
    for window in summary["windows"]:
        by_segment.setdefault(window["segment_id"], []).append(window)
    result = []
    for row in rows:
        if tracks.digest(row["points"]) != row["points_sha256"]:
            raise CountError("tracking_integrity", "Stored track points failed their integrity check.")
        if sizes[row["segment_id"]] != (gate["frame_w"], gate["frame_h"]):
            continue  # Reported as a skipped segment below; never projected onto another frame size.
        points = [(int(p["pts"]), float(p["x"]), float(p["y"])) for p in tracks.unpack(row["points"])]
        for pts, direction in gates.crossings(points, gate):
            windows = by_segment[row["segment_id"]]
            window = next((item for item in windows if _contains(item["interval"], pts)), None)
            # A frame-wide change at or before the crossing may mean the camera moved since the gate was drawn.
            scene_changed = any("framewide_change" in item["flags"] for item in windows
                                if window is not None and item["index"] <= window["index"])
            result.append({"key": _key(run_id, gate, row["id"], pts), "track_id": row["id"], "segment_id": row["segment_id"],
                           "pts": str(pts), "direction": direction, "window_id": window["id"] if window else None,
                           "scene_changed": scene_changed})
    return result


def skipped_segments(db_path: Path, run_id: str, gate: dict) -> list[str]:
    summary_run = tracks_summary_run(db_path, run_id)
    return [source["id"] for source in summary_run["sources"]
            if (json.loads(source["metadata_json"])["width"], json.loads(source["metadata_json"])["height"]) != (gate["frame_w"], gate["frame_h"])]


def tracks_summary_run(db_path: Path, run_id: str) -> dict:
    with closing(store.connect(db_path)) as connection:
        run = connection.execute("SELECT summary_run_id FROM tracking_run WHERE id=?", (run_id,)).fetchone()
    if run is None:
        raise CountError("tracking_missing", "The tracking run does not exist.", 404)
    return summary_store.private_run(db_path, run["summary_run_id"])


def _contains(interval: dict, pts: int) -> bool:
    start = int(interval["start_pts"]["num"]) // int(interval["start_pts"]["den"])
    end = interval["end_pts"]
    return pts >= start and (end is None or pts < int(end["num"]) // int(end["den"]))


def _events(connection, run_id: str, gate_id: str) -> list[dict]:
    rows = connection.execute("SELECT * FROM count_event WHERE tracking_run_id=? AND gate_id=? ORDER BY revision",
                              (run_id, gate_id)).fetchall()
    return [{"revision": row["revision"], "layer": row["layer"], "actor": row["actor"], "utc": row["utc"],
             **json.loads(row["value_json"])} for row in rows]


def _flip(direction: str) -> str:
    return {"A_to_B": "B_to_A", "B_to_A": "A_to_B", "out_to_in": "in_to_out", "in_to_out": "out_to_in"}[direction]


def _totals(items: list[tuple[str, int]], entry: str) -> dict:
    entered = sum(count for direction, count in items if direction == entry)
    exited = sum(count for direction, count in items if direction == _flip(entry))
    return {"entered": entered, "exited": exited, "net": exited - entered}


def counts(db_path: Path, run_id: str, gate_id: str) -> dict:
    require_schema(db_path)
    gate = get_gate(db_path, gate_id)
    crossings = derived_crossings(db_path, run_id, gate)
    with closing(store.connect(db_path)) as connection:
        events = _events(connection, run_id, gate_id)
    entry = gate["entry_direction"]
    reviews: dict[str, dict] = {}
    missed: dict[str, dict] = {}
    review_revision = 0
    for event in events:
        if event["layer"] != "review":
            continue
        review_revision = event["revision"]
        if event["gate_revision"] != gate["revision"]:
            continue  # Reviews of an earlier gate revision are history only.
        target = missed if event["action"] == "add_missed" else reviews
        if event["action"] == "clear":
            reviews.pop(event["key"], None)
            missed.pop(event["key"], None)
        else:
            target[event["key"]] = event
    for crossing in crossings:
        crossing["review"] = reviews.get(crossing["key"])
    algorithm = [(item["direction"], 1) for item in crossings if not item["scene_changed"]]
    reviewed: list[tuple[str, int]] = []
    for crossing in crossings:
        review = crossing["review"]
        if review is None or review["action"] == "reject":
            continue
        direction = _flip(crossing["direction"]) if review["flipped"] else crossing["direction"]
        reviewed.append((direction, review["count"]))
    reviewed += [(item["direction"], item["count"]) for item in missed.values()]
    reviewers = {" ".join(event["actor"].lower().split()) for event in events if event["layer"] == "review"}
    qa = next((event for event in reversed(events) if event["layer"] == "qa"), None)
    qa_state = None
    if qa is not None:
        current = qa["review_revision"] == review_revision and qa["gate_revision"] == gate["revision"]
        qa_state = {"decision": qa["decision"], "actor": qa["actor"], "note": qa["note"], "utc": qa["utc"],
                    "review_revision": qa["review_revision"], "stale": not current,
                    "counts": _totals(reviewed, entry) if current and qa["decision"] == "approve" else None}
    return {"gate": gate, "tracking_run_id": run_id, "algorithm_version": gates.ALGORITHM_VERSION,
            "crossings": crossings, "missed": list(missed.values()), "skipped_segments": skipped_segments(db_path, run_id, gate),
            "review_revision": review_revision, "reviewers": sorted(reviewers),
            "layers": {"algorithm": {**_totals(algorithm, entry),
                                     "excluded_scene_changed": sum(1 for item in crossings if item["scene_changed"])},
                       "reviewer": {**_totals(reviewed, entry), "reviewed": sum(1 for item in crossings if item["review"]),
                                    "crossings": len(crossings), "added": len(missed)},
                       "qa": qa_state}}


def record(db_path: Path, run_id: str, gate_id: str, actor: str, expected_revision: int, layer: str, value: dict) -> dict:
    """Append one reviewer or QA action after an optimistic check against the latest count revision."""
    require_schema(db_path)
    actor = _actor(actor)
    current = counts(db_path, run_id, gate_id)
    gate = current["gate"]
    if gate["state"] != "active":
        raise CountError("gate_conflict", "The gate was retired.")
    if layer == "review":
        action = value["action"]
        changed = action in {"reject", "add_missed"} or (action == "confirm" and (value["flipped"] or value["count"] != 1))
        if changed and not value["rationale"].strip():
            raise CountError("count_invalid", "Give a reason when rejecting, flipping, changing a count or adding a missed crossing.", 422)
        if action == "add_missed":
            if value.get("direction") not in gates.DIRECTIONS["line" if gate["kind"] == "line" else "area"]:
                raise CountError("count_invalid", "Choose the direction of the missed crossing.", 422)
            if value["segment_id"] not in {source["id"] for source in tracks_summary_run(db_path, run_id)["sources"]}:
                raise CountError("count_invalid", "The missed crossing must be in a video of this run.", 422)
            value["key"] = str(uuid4())
        elif value.get("key") not in {item["key"] for item in current["crossings"]} | {item["key"] for item in current["missed"]}:
            raise CountError("count_conflict", "This crossing is not part of the current gate revision. Reload the counts.")
        value["gate_revision"] = gate["revision"]
    else:
        if " ".join(actor.lower().split()) in current["reviewers"]:
            raise CountError("count_same_actor", "QA must be done by a different person than the count reviewer.")
        if value.get("review_revision") != current["review_revision"]:
            raise CountError("count_conflict", "The reviewed counts changed. Reload before QA.")
        if value["decision"] == "reject" and not value["note"].strip():
            raise CountError("count_invalid", "Give a reason for rejecting the reviewed counts.", 422)
        value["gate_revision"] = gate["revision"]
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        latest = connection.execute("SELECT COALESCE(MAX(revision), 0) FROM count_event WHERE tracking_run_id=? AND gate_id=?",
                                    (run_id, gate_id)).fetchone()[0]
        if latest != expected_revision:
            raise CountError("count_conflict", "Counts changed since you loaded them. Reload before saving.")
        connection.execute("INSERT INTO count_event VALUES (?,?,?,?,?,?,?)",
                           (run_id, gate_id, latest + 1, layer, actor, json.dumps(value), _now()))
    return counts(db_path, run_id, gate_id)


def latest_revision(db_path: Path, run_id: str, gate_id: str) -> int:
    with closing(store.connect(db_path)) as connection:
        return connection.execute("SELECT COALESCE(MAX(revision), 0) FROM count_event WHERE tracking_run_id=? AND gate_id=?",
                                  (run_id, gate_id)).fetchone()[0]


def history(db_path: Path, run_id: str, gate_id: str) -> list[dict]:
    with closing(store.connect(db_path)) as connection:
        return _events(connection, run_id, gate_id)
