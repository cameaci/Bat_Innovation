"""Gates, crossings and three-layer counts (schema v8, feature expansion E3; validity spans v13, Phase 2 W4).

Gates are human-drawn, revisioned and audited. Crossings are derived on demand from stored tracks and one gate
revision, with deterministic keys, so they are never a competing source of truth. Reviewer and QA actions are
append-only. The algorithm, reviewer and QA layers are reported separately and never merged.

A gate is valid only while the camera is known not to have moved: a classified camera move, or a following video
not marked contiguous, ends the valid span and asks for one reconfirmation (same or redrawn geometry) instead of
producing crossings against a gate that may no longer sit on the roost. Only coherent tracks feed the algorithm
proposal; crossings of uncertain tracks wait for a reviewer decision; noise tracks never cross a gate.
"""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
from uuid import NAMESPACE_URL, uuid4, uuid5

from . import gates, store, summary_store, tracks
from .imports import ImportErrorResponse

REVIEW_ACTIONS = {"confirm", "reject", "add_missed", "clear", "accept"}


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


def upgrade_spans(db_path: Path) -> None:
    """Explicit v12 -> v13 transition: append-only gate reconfirmations after a camera move or a new video."""
    if not db_path.is_file():
        raise store.DatabaseSchemaError("Gate span upgrade requires an existing version 12 database")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version >= store.GATE_SPAN_SCHEMA_VERSION:
            return
        if version != store.TRACKS_V2_SCHEMA_VERSION:
            raise store.DatabaseSchemaError("Gate span upgrade requires database schema version 12")
        connection.execute("SELECT id FROM tracking_event LIMIT 1")
        connection.execute("""CREATE TABLE gate_reconfirm (
            gate_id TEXT NOT NULL REFERENCES gate(id),
            tracking_run_id TEXT NOT NULL REFERENCES tracking_run(id),
            revision INTEGER NOT NULL CHECK(revision > 0),
            gate_revision INTEGER NOT NULL,
            anchor_kind TEXT NOT NULL CHECK(anchor_kind IN ('camera_moved', 'segment_start')),
            anchor_id TEXT NOT NULL,
            points_json TEXT,
            actor TEXT NOT NULL,
            note TEXT NOT NULL,
            utc TEXT NOT NULL,
            PRIMARY KEY(gate_id, tracking_run_id, revision)
        )""")
        for operation in ("UPDATE", "DELETE"):
            connection.execute(f"""CREATE TRIGGER gate_reconfirm_no_{operation.lower()} BEFORE {operation} ON gate_reconfirm
                BEGIN SELECT RAISE(ABORT, 'append-only'); END""")
        connection.execute(f"PRAGMA user_version={store.GATE_SPAN_SCHEMA_VERSION}")


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


def _reconfirmations(connection, run_id: str, gate: dict) -> dict[tuple[str, str], dict]:
    """Latest reconfirmation per anchor for the current gate revision; earlier revisions are history only."""
    if store.schema_version_of(connection) < store.GATE_SPAN_SCHEMA_VERSION:
        return {}
    rows = connection.execute("""SELECT * FROM gate_reconfirm WHERE gate_id=? AND tracking_run_id=? AND gate_revision=?
        ORDER BY revision""", (gate["id"], run_id, gate["revision"])).fetchall()
    return {(row["anchor_kind"], row["anchor_id"]): {"points": json.loads(row["points_json"]) if row["points_json"] else None,
                                                    "actor": row["actor"], "utc": row["utc"], "revision": row["revision"]}
            for row in rows}


def spans(db_path: Path, run_id: str, gate: dict) -> tuple[dict[str, list[dict]], list[dict]]:
    """Valid intervals per segment, each with its gate geometry, and the invalid spans that each need one action."""
    with closing(store.connect(db_path)) as connection:
        run = connection.execute("SELECT summary_run_id FROM tracking_run WHERE id=?", (run_id,)).fetchone()
        if run is None:
            raise CountError("tracking_missing", "The tracking run does not exist.", 404)
        confirmed = _reconfirmations(connection, run_id, gate)
        moves: list = []
        if store.schema_version_of(connection) >= store.TRACKS_V2_SCHEMA_VERSION:
            moves = connection.execute("""SELECT id, segment_id, start_pts, end_pts FROM tracking_event
                WHERE run_id=? AND kind='camera_moved' ORDER BY CAST(start_pts AS INTEGER)""", (run_id,)).fetchall()
    summary = summary_store.private_run(db_path, run["summary_run_id"])
    valid: dict[str, list[dict]] = {}
    invalid: list[dict] = []
    current: list | None = gate["points"]
    for position, source in enumerate(summary["sources"]):
        segment = store.segment_by_id(db_path, source["id"])
        intervals: list[dict] = []
        start: int | None = None
        if position > 0 and (segment is None or segment["continuity"] != "known_contiguous"):
            # A new video not marked contiguous may come from a moved or re-aimed camera.
            current = _resume(confirmed, ("segment_start", source["id"]), gate, invalid, source["id"], None, "new_video")
        for move in [item for item in moves if item["segment_id"] == source["id"]]:
            if current is not None:
                intervals.append({"from_pts": start, "to_pts": int(move["start_pts"]), "points": current})
            current = _resume(confirmed, ("camera_moved", move["id"]), gate, invalid, source["id"], move, "camera_moved")
            start = int(move["end_pts"])
        if current is not None:
            intervals.append({"from_pts": start, "to_pts": None, "points": current})
        valid[source["id"]] = intervals
    return valid, invalid


def _resume(confirmed: dict, anchor: tuple[str, str], gate: dict, invalid: list[dict], segment_id: str, move, reason: str):
    item = confirmed.get(anchor)
    if item is None:
        invalid.append({"segment_id": segment_id, "anchor_kind": anchor[0], "anchor_id": anchor[1], "reason": reason,
                        "from_pts": move["start_pts"] if move is not None else None,
                        "resume_pts": move["end_pts"] if move is not None else None})
        return None
    return item["points"] or gate["points"]


def derived_crossings(db_path: Path, run_id: str, gate: dict) -> tuple[list[dict], list[dict], dict]:
    """Crossings of the run's tracks with one gate revision inside its valid spans (derived, reproducible)."""
    valid, invalid = spans(db_path, run_id, gate)
    with closing(store.connect(db_path)) as connection:
        quality = "quality" if store.schema_version_of(connection) >= store.TRACKS_V2_SCHEMA_VERSION else "'unrated' AS quality"
        rows = connection.execute(f"""SELECT id, segment_id, track_index, points, points_sha256, {quality} FROM track WHERE run_id=?
            ORDER BY segment_id, track_index""", (run_id,)).fetchall()
        algorithm = connection.execute("SELECT algorithm_version FROM tracking_run WHERE id=?", (run_id,)).fetchone()["algorithm_version"]
    rule, min_points = gates.version_for(algorithm)
    summary = tracks_summary_run(db_path, run_id)
    sizes = {source["id"]: (json.loads(source["metadata_json"])["width"], json.loads(source["metadata_json"])["height"])
             for source in summary["sources"]}
    by_segment: dict[str, list[dict]] = {}
    for window in summary["windows"]:
        by_segment.setdefault(window["segment_id"], []).append(window)
    result = []
    skipped_noise = 0
    for row in rows:
        if tracks.digest(row["points"]) != row["points_sha256"]:
            raise CountError("tracking_integrity", "Stored track points failed their integrity check.")
        if sizes[row["segment_id"]] != (gate["frame_w"], gate["frame_h"]):
            continue  # Reported as a skipped segment; never projected onto another frame size.
        points = [(int(p["pts"]), float(p["x"]), float(p["y"])) for p in tracks.unpack(row["points"])]
        for interval in valid.get(row["segment_id"], []):
            inside = [point for point in points if (interval["from_pts"] is None or point[0] >= interval["from_pts"])
                      and (interval["to_pts"] is None or point[0] < interval["to_pts"])]
            for pts, direction in gates.crossings(inside, {**gate, "points": interval["points"]}, min_points):
                if row["quality"] == "noise":
                    skipped_noise += 1
                    continue
                window = next((item for item in by_segment[row["segment_id"]] if _contains(item["interval"], pts)), None)
                result.append({"key": _key(run_id, gate, row["id"], pts), "track_id": row["id"], "track_index": row["track_index"],
                               "segment_id": row["segment_id"], "pts": str(pts), "direction": direction,
                               "window_id": window["id"] if window else None,
                               "quality": "coherent" if row["quality"] == "coherent" else "uncertain"})
    return result, invalid, {"noise_crossings": skipped_noise, "valid_spans": valid, "rule": rule}


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
    crossings, invalid, extra = derived_crossings(db_path, run_id, gate)
    with closing(store.connect(db_path)) as connection:
        events = _events(connection, run_id, gate_id)
    entry = gate["entry_direction"]
    reviews: dict[str, dict] = {}
    missed: dict[str, dict] = {}
    review_revision = 0
    accepted: dict | None = None
    for event in events:
        if event["layer"] != "review":
            continue
        review_revision = event["revision"]
        if event["gate_revision"] != gate["revision"]:
            continue  # Reviews of an earlier gate revision are history only.
        if event["action"] == "accept":
            accepted = event
        elif event["action"] == "clear":
            reviews.pop(event["key"], None)
            missed.pop(event["key"], None)
        else:
            (missed if event["action"] == "add_missed" else reviews)[event["key"]] = event
    for crossing in crossings:
        crossing["review"] = reviews.get(crossing["key"])
    algorithm = [(item["direction"], 1) for item in crossings if item["quality"] == "coherent"]
    # The reviewer layer starts from the algorithm proposal: coherent crossings count unless rejected, uncertain
    # ones only once a reviewer says they are bats.
    reviewed: list[tuple[str, int]] = []
    unresolved = rejected = 0
    for crossing in crossings:
        review = crossing["review"]
        if review is None:
            if crossing["quality"] == "coherent":
                reviewed.append((crossing["direction"], 1))
            else:
                unresolved += 1
            continue
        if review["action"] == "reject":
            rejected += 1
            continue
        reviewed.append((_flip(crossing["direction"]) if review["flipped"] else crossing["direction"], review["count"]))
    reviewed += [(item["direction"], item["count"]) for item in missed.values()]
    current_accept = accepted is not None and accepted["revision"] == review_revision
    state = "accepted" if current_accept else "unresolved" if unresolved or invalid else "ready"
    reviewers = {" ".join(event["actor"].lower().split()) for event in events if event["layer"] == "review"}
    qa = next((event for event in reversed(events) if event["layer"] == "qa"), None)
    qa_state = None
    if qa is not None:
        current = qa["review_revision"] == review_revision and qa["gate_revision"] == gate["revision"]
        qa_state = {"decision": qa["decision"], "actor": qa["actor"], "note": qa["note"], "utc": qa["utc"],
                    "review_revision": qa["review_revision"], "stale": not current,
                    "counts": _totals(reviewed, entry) if current and qa["decision"] == "approve" else None}
    return {"gate": gate, "tracking_run_id": run_id, "algorithm_version": extra["rule"],
            "crossings": crossings, "missed": list(missed.values()), "skipped_segments": skipped_segments(db_path, run_id, gate),
            "invalid_spans": invalid, "valid_spans": extra["valid_spans"],
            "review_revision": review_revision, "reviewers": sorted(reviewers),
            "layers": {"algorithm": {**_totals(algorithm, entry), "coherent": len(algorithm),
                                     "uncertain": sum(1 for item in crossings if item["quality"] != "coherent"),
                                     "noise_crossings": extra["noise_crossings"], "invalid_spans": len(invalid)},
                       "reviewer": {**_totals(reviewed, entry), "state": state, "unresolved": unresolved, "rejected": rejected,
                                    "reviewed": sum(1 for item in crossings if item["review"]), "crossings": len(crossings),
                                    "added": len(missed),
                                    "accepted": {"actor": accepted["actor"], "utc": accepted["utc"], "current": current_accept}
                                    if accepted else None},
                       "qa": qa_state}}


def reconfirm(db_path: Path, run_id: str, gate_id: str, actor: str, anchor_kind: str, anchor_id: str,
              points: list | None, note: str) -> dict:
    """Resume counting after a camera move or a new video, with the same or a redrawn geometry (append-only)."""
    require_schema(db_path)
    if store.schema_version(db_path) < store.GATE_SPAN_SCHEMA_VERSION:
        raise CountError("count_upgrade_required", "Upgrade storage before reconfirming gates.")
    actor = _actor(actor)
    gate = get_gate(db_path, gate_id)
    if gate["state"] != "active":
        raise CountError("gate_conflict", "The gate was retired.")
    _valid, invalid = spans(db_path, run_id, gate)
    anchors = {(item["anchor_kind"], item["anchor_id"]) for item in invalid}
    with closing(store.connect(db_path)) as connection:
        anchors |= set(_reconfirmations(connection, run_id, gate))
    if (anchor_kind, anchor_id) not in anchors:
        raise CountError("count_conflict", "This scene change is not part of the current gate and tracking run. Reload the counts.")
    if points is not None:
        try:
            gates.validate({**gate, "points": points})
        except ValueError as error:
            raise CountError("gate_invalid", str(error), 422) from None
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        latest = connection.execute("SELECT COALESCE(MAX(revision), 0) FROM gate_reconfirm WHERE gate_id=? AND tracking_run_id=?",
                                    (gate_id, run_id)).fetchone()[0]
        connection.execute("INSERT INTO gate_reconfirm VALUES (?,?,?,?,?,?,?,?,?,?)",
                           (gate_id, run_id, latest + 1, gate["revision"], anchor_kind, anchor_id,
                            json.dumps(points) if points is not None else None, actor, note.strip(), _now()))
    return counts(db_path, run_id, gate_id)


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
        crossing = next((item for item in current["crossings"] if item["key"] == value.get("key")), None)
        # Overriding the algorithm's proposal needs a reason; deciding an uncertain crossing is the reviewer's task.
        proposed = crossing is not None and crossing["quality"] == "coherent"
        changed = action == "add_missed" or (proposed and (action == "reject" or (action == "confirm" and (value["flipped"] or value["count"] != 1))))
        if changed and not value["rationale"].strip():
            raise CountError("count_invalid", "Give a reason when rejecting or changing a proposed crossing or adding a missed one.", 422)
        if action == "accept":
            reviewer = current["layers"]["reviewer"]
            if reviewer["unresolved"] or current["invalid_spans"]:
                raise CountError("count_unresolved", "Decide every uncertain crossing and reconfirm the gate after each camera move first.")
            value["snapshot"] = {key: reviewer[key] for key in ("entered", "exited", "net")}
        if action == "add_missed":
            if value.get("direction") not in gates.DIRECTIONS["line" if gate["kind"] == "line" else "area"]:
                raise CountError("count_invalid", "Choose the direction of the missed crossing.", 422)
            if value["segment_id"] not in {source["id"] for source in tracks_summary_run(db_path, run_id)["sources"]}:
                raise CountError("count_invalid", "The missed crossing must be in a video of this run.", 422)
            value["key"] = str(uuid4())
        elif action != "accept" and value.get("key") not in {item["key"] for item in current["crossings"]} | {item["key"] for item in current["missed"]}:
            raise CountError("count_conflict", "This crossing is not part of the current gate revision. Reload the counts.")
        value["gate_revision"] = gate["revision"]
    else:
        if " ".join(actor.lower().split()) in current["reviewers"]:
            raise CountError("count_same_actor", "QA must be done by a different person than the count reviewer.")
        if value.get("review_revision") != current["review_revision"]:
            raise CountError("count_conflict", "The reviewed counts changed. Reload before QA.")
        if current["layers"]["reviewer"]["state"] != "accepted":
            raise CountError("count_unresolved", "The reviewer has not accepted these counts yet.")
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
