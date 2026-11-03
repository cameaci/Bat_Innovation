"""Sample checks: a reviewer's manual count of a short span compared with the gate's crossings (schema v14, Phase 3 X2).

The reviewer plays a span of one video at normal speed or slower and presses a key each time a bat crosses the gate.
The comparison with the stored crossings (matched, missed by the algorithm, extra in the algorithm) is computed once,
stored with the presses and the playback receipt, and never changes a count. Rows are append-only.
"""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
from fractions import Fraction
import json
from pathlib import Path
from uuid import uuid4

from . import count_store, store
from .imports import ImportErrorResponse

SAMPLE_MAX_RATE = 1.0
TOLERANCE_SECONDS = Fraction(1, 2)
MAX_PRESSES = 5000


class SampleError(ImportErrorResponse):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(code, message, status)


def upgrade(db_path: Path) -> None:
    """Explicit v13 -> v14 transition."""
    if not db_path.is_file():
        raise store.DatabaseSchemaError("Sample check upgrade requires an existing version 13 database")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version >= store.SAMPLE_CHECK_SCHEMA_VERSION:
            return
        if version != store.GATE_SPAN_SCHEMA_VERSION:
            raise store.DatabaseSchemaError("Sample check upgrade requires database schema version 13")
        connection.execute("""CREATE TABLE sample_check (
            id TEXT PRIMARY KEY,
            tracking_run_id TEXT NOT NULL REFERENCES tracking_run(id),
            gate_id TEXT NOT NULL REFERENCES gate(id),
            gate_revision INTEGER NOT NULL,
            segment_id TEXT NOT NULL REFERENCES segment(id),
            start_pts TEXT NOT NULL,
            end_pts TEXT NOT NULL,
            actor TEXT NOT NULL,
            presses_json TEXT NOT NULL,
            receipt_json TEXT NOT NULL,
            result_json TEXT NOT NULL,
            utc TEXT NOT NULL
        )""")
        for operation in ("UPDATE", "DELETE"):
            connection.execute(f"""CREATE TRIGGER sample_check_no_{operation.lower()} BEFORE {operation} ON sample_check
                BEGIN SELECT RAISE(ABORT, 'append-only'); END""")
        connection.execute(f"PRAGMA user_version={store.SAMPLE_CHECK_SCHEMA_VERSION}")


def _direction_kind(direction: str, entry: str) -> str:
    return "entry" if direction == entry else "exit"


def compare(presses: list[tuple[int, str]], crossings: list[dict], entry: str, tolerance: int) -> dict:
    """Greedy nearest matching of presses to proposed crossings of the same kind within the tolerance (ticks).

    The proposal is what counts without a reviewer: coherent crossings. Uncertain crossings in the span are listed
    separately, since they wait for a person in any case.
    """
    proposed = [item for item in crossings if item["quality"] == "coherent"]
    used: set[int] = set()
    matched, missed = [], []
    for pts, kind in sorted(presses):
        best = None
        for index, crossing in enumerate(proposed):
            if index in used or _direction_kind(crossing["direction"], entry) != kind:
                continue
            gap = abs(int(crossing["pts"]) - pts)
            if gap <= tolerance and (best is None or gap < abs(int(proposed[best]["pts"]) - pts)):
                best = index
        if best is None:
            missed.append({"pts": str(pts), "kind": kind})
        else:
            used.add(best)
            matched.append({"pts": str(pts), "kind": kind, "key": proposed[best]["key"], "crossing_pts": proposed[best]["pts"]})
    extra = [{"key": item["key"], "pts": item["pts"], "kind": _direction_kind(item["direction"], entry), "track_index": item["track_index"]}
             for index, item in enumerate(proposed) if index not in used]
    tally = lambda items, kind: sum(1 for item in items if item == kind)
    return {"manual": {"entry": tally([kind for _, kind in presses], "entry"), "exit": tally([kind for _, kind in presses], "exit")},
            "algorithm": {"entry": tally([_direction_kind(item["direction"], entry) for item in proposed], "entry"),
                          "exit": tally([_direction_kind(item["direction"], entry) for item in proposed], "exit")},
            "matched": matched, "missed_by_algorithm": missed, "extra_in_algorithm": extra,
            "uncertain_in_span": sum(1 for item in crossings if item["quality"] != "coherent"),
            "tolerance_seconds": str(TOLERANCE_SECONDS)}


def record(db_path: Path, run_id: str, gate_id: str, segment: dict, start: int, end: int, actor: str,
           presses: list[tuple[int, str]], receipt: dict) -> dict:
    if store.schema_version(db_path) < store.SAMPLE_CHECK_SCHEMA_VERSION:
        raise SampleError("sample_upgrade_required", "Upgrade storage before checking a sample.")
    actor = " ".join(actor.split())
    if not actor:
        raise SampleError("sample_invalid", "Enter your name or initials.", 422)
    if end <= start or len(presses) > MAX_PRESSES or any(not start <= pts <= end or kind not in ("entry", "exit") for pts, kind in presses):
        raise SampleError("sample_invalid", "Every press must fall inside the checked span.", 422)
    if receipt["max_rate"] > SAMPLE_MAX_RATE:
        raise SampleError("sample_too_fast", "Count a sample at normal speed or slower.")
    if not any(int(first) <= start and int(last) >= end for first, last in receipt["intervals"]):
        raise SampleError("sample_unwatched", "Play the whole span without seeking before finishing the check.")
    gate = count_store.get_gate(db_path, gate_id)
    crossings, _invalid, _extra = count_store.derived_crossings(db_path, run_id, gate)
    inside = [item for item in crossings if item["segment_id"] == segment["id"] and start <= int(item["pts"]) <= end]
    base = json.loads(segment["metadata_json"])["time_base"]
    tolerance = int(TOLERANCE_SECONDS / Fraction(int(base["num"]), int(base["den"])))
    result = compare(presses, inside, gate["entry_direction"], tolerance)
    row = {"id": str(uuid4()), "tracking_run_id": run_id, "gate_id": gate_id, "gate_revision": gate["revision"], "segment_id": segment["id"],
           "start_pts": str(start), "end_pts": str(end), "actor": actor, "presses": [[str(pts), kind] for pts, kind in sorted(presses)],
           "receipt": receipt, "result": result, "utc": datetime.now(timezone.utc).isoformat()}
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("""INSERT INTO sample_check (id, tracking_run_id, gate_id, gate_revision, segment_id, start_pts, end_pts, actor,
            presses_json, receipt_json, result_json, utc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (row["id"], run_id, gate_id, row["gate_revision"], segment["id"], row["start_pts"], row["end_pts"], actor,
             json.dumps(row["presses"]), json.dumps(receipt), json.dumps(result), row["utc"]))
    return row


def checks(db_path: Path, run_id: str, gate_id: str) -> list[dict]:
    if store.schema_version(db_path) < store.SAMPLE_CHECK_SCHEMA_VERSION:
        return []
    with closing(store.connect(db_path)) as connection:
        rows = connection.execute("SELECT * FROM sample_check WHERE tracking_run_id=? AND gate_id=? ORDER BY utc DESC, rowid DESC",
                                  (run_id, gate_id)).fetchall()
    return [{"id": row["id"], "tracking_run_id": row["tracking_run_id"], "gate_id": row["gate_id"], "gate_revision": row["gate_revision"],
             "segment_id": row["segment_id"], "start_pts": row["start_pts"], "end_pts": row["end_pts"], "actor": row["actor"],
             "presses": json.loads(row["presses_json"]), "receipt": json.loads(row["receipt_json"]), "result": json.loads(row["result_json"]),
             "utc": row["utc"]} for row in rows]
