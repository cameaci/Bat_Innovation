"""Versioned provisional CSV schemas, reversible spreadsheet text and snapshot rows."""

from __future__ import annotations

from contextlib import closing
import csv
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import re
import sqlite3
from threading import Lock

LABEL = "PROVISIONAL — NOT ECOLOGICALLY FINALISED"
SCHEMA = "bat-provisional-csv-v4"
MAX_CSV_BYTES = 8 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
MAX_ROWS = 50000
MAX_ROW_BYTES = 64 * 1024
MAX_SECONDS = 30
FILES = {"observations": "provisional-observations.csv", "audit": "technical-window-audit.csv", "tracks": "provisional-tracks.csv",
         "counts": "provisional-counts.csv", "manifest": "manifest.json"}
COMMON = ["schema_version", "provisional_label", "as_of_utc", "run_id", "session_id", "summary_window_id", "segment_id",
          "segment_order", "window_index", "source_sha256", "source_filename", "time_base_num", "time_base_den",
          "first_review_revision", "first_review_actor", "first_review_decision", "first_review_effective_decision",
          "first_review_needs_reverification", "first_review_reason", "qa_revision", "qa_actor", "qa_decision", "qa_effective_status",
          "qa_needs_reverification", "qa_reason", "qa_note", "has_disagreement", "has_clarification"]
OBS_COLUMNS = COMMON + ["observation_id", "observation_revision", "start_pts", "end_pts_exclusive", "category", "activity",
                        "count", "uncertain", "notes", "start_utc", "end_utc_exclusive", "clock_provenance", "canonical_json"]
AUDIT_COLUMNS = COMMON + ["source_state", "evidence_revision", "evidence_fingerprint", "processing_status", "processing_error", "quality_flags", "algorithm_version", "parameter_sha256",
    "window_start_pts_num", "window_start_pts_den", "window_end_pts_num", "window_end_pts_den",
    "source_start_seconds_num", "source_start_seconds_den", "source_end_seconds_num", "source_end_seconds_den",
    "elapsed_start_seconds_num", "elapsed_start_seconds_den", "elapsed_end_seconds_num", "elapsed_end_seconds_den",
    "image_sha256", "image_bytes", "frame_count", "motion_pixels", "timestamp_gap_count", "continuity_before",
    "observation_count", "start_utc", "end_utc_exclusive", "clock_provenance", "clock_reason",
    "first_history_endpoint", "first_history_through_revision", "qa_history_endpoint", "qa_history_through_revision", "modality", "canonical_json"]
# Feature expansion (E2/E3): derived tracks and gate counts of the latest complete tracking run of this summary run.
TRACKING = ["schema_version", "provisional_label", "as_of_utc", "run_id", "tracking_run_id", "tracking_algorithm_version", "tracking_parameter_sha256"]
TRACK_COLUMNS = TRACKING + ["track_id", "segment_id", "source_sha256", "track_index", "first_pts", "last_pts", "point_count", "bbox_json",
                            "points_sha256", "quality", "metrics_json", "label_category", "label_species", "label_comment", "label_actor",
                            "label_event_id", "canonical_json"]
COUNT_COLUMNS = TRACKING + ["gate_id", "gate_name", "gate_revision", "gate_kind", "gate_points_json", "gate_frame_w", "gate_frame_h",
    "label_a", "label_b", "entry_direction", "hysteresis_px", "gate_algorithm_version", "row_kind", "layer", "crossing_key", "track_id",
    "segment_id", "source_pts", "direction", "track_quality", "review_action", "flipped", "count", "reviewer", "rationale",
    "span_reason", "reviewer_state", "qa_decision", "qa_actor", "qa_stale", "entered", "exited", "net", "canonical_json"]
NUMERIC = {"evidence_revision", "segment_order", "window_index", "time_base_num", "time_base_den", "first_review_revision", "qa_revision",
    "first_review_needs_reverification", "qa_needs_reverification", "has_disagreement", "has_clarification",
    "observation_revision", "start_pts", "end_pts_exclusive", "count", "uncertain", "image_bytes", "frame_count", "motion_pixels",
    "timestamp_gap_count", "observation_count", "first_history_through_revision", "qa_history_through_revision",
    "track_index", "first_pts", "last_pts", "point_count", "gate_revision", "gate_frame_w", "gate_frame_h", "source_pts",
    "flipped", "qa_stale", "entered", "exited", "net"} | {
    f"{field}_{part}" for field in ("window_start_pts", "window_end_pts", "source_start_seconds", "source_end_seconds",
                                     "elapsed_start_seconds", "elapsed_end_seconds") for part in ("num", "den")}


class ExportFailure(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def text_cell(value: str) -> str:
    """Every nonempty text cell starts with an Excel literal marker, reversibly.

    Backslashes double; C0/DEL except CR/LF become ASCII \u005cuXXXX. This retains
    real multiline CSV cells while avoiding NUL/tab parser-specific behavior.
    """
    if not value:
        return ""
    encoded = "".join("\\\\" if c == "\\" else f"\\u{ord(c):04x}" if (ord(c) < 32 and c not in "\r\n") or ord(c) == 127 else c for c in value)
    return "'" + encoded


def decode_text(value: str) -> str:
    if not value:
        return ""
    if not value.startswith("'"):
        raise ValueError("Not an encoded CSV text cell")
    return re.sub(r"\\\\|\\u([0-9a-f]{4})", lambda m: "\\" if m.group(1) is None else chr(int(m.group(1), 16)), value[1:])


def canonical_number(value: object) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, bool):
        return "1" if value else "0"
    result = str(value)
    if re.fullmatch(r"-?(0|[1-9][0-9]{0,79})", result) is None or str(int(result)) != result:
        raise ExportFailure("export_stale")
    return result


def readonly(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=1)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def snapshot(database: Path, target: Path, check) -> str:
    """Pin one read transaction, copy in 64-page steps, then release the live DB."""
    from . import store

    with closing(readonly(database)) as original, closing(sqlite3.connect(target)) as copy:
        original.execute("BEGIN")
        if original.execute("PRAGMA user_version").fetchone()[0] not in store.QA_SCHEMA_VERSIONS:
            raise ExportFailure("export_schema_required")
        if original.execute("PRAGMA page_count").fetchone()[0] * original.execute("PRAGMA page_size").fetchone()[0] > MAX_SNAPSHOT_BYTES:
            raise ExportFailure("export_too_large")
        as_of = datetime.now(timezone.utc).isoformat()
        original.backup(copy, pages=64, progress=lambda *_: check(), sleep=0.01)
        original.rollback()
        # Backup copies the source journal mode too. Normalize only this private
        # copy before read-only use, so WAL sidecars cannot enter the bundle.
        if copy.execute("PRAGMA journal_mode=DELETE").fetchone()[0] != "delete":
            raise ExportFailure("export_write_failed")
    return as_of


class CSVFile:
    def __init__(self, path: Path, columns: list[str], check):
        self.path, self.columns, self.check = path, columns, check
        self.handle = path.open("xb")
        self.rows, self.size, self.digest = 0, 0, sha256()
        try:
            self._write(columns)
        except BaseException:
            self.handle.close()
            raise

    def _write(self, cells: list[str]) -> None:
        self.check()
        buffer = io.StringIO(newline="")
        csv.writer(buffer, lineterminator="\r\n").writerow(cells)
        data = buffer.getvalue().encode("utf-8")
        if len(data) > MAX_ROW_BYTES or self.size + len(data) > MAX_CSV_BYTES:
            raise ExportFailure("export_too_large")
        self.handle.write(data)
        self.size += len(data)
        self.digest.update(data)

    def row(self, values: dict) -> None:
        if self.rows >= MAX_ROWS:
            raise ExportFailure("export_too_large")
        raw = {**values, "canonical_json": json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))}
        self._write([canonical_number(raw.get(key)) if key in NUMERIC else text_cell(str(raw.get(key) or "")) for key in self.columns])
        self.rows += 1

    def close(self) -> dict:
        self.handle.flush()
        os.fsync(self.handle.fileno())
        self.handle.close()
        return {"name": self.path.name, "bytes": self.size, "sha256": self.digest.hexdigest(), "rows": self.rows}


def clock(anchor: dict | None, source: dict, start: dict, end: dict | None) -> dict:
    from . import windows
    result = {"start_utc": "", "end_utc_exclusive": "", "clock_provenance": "", "clock_reason": "unknown_recording_clock"}
    if not anchor or anchor.get("segment_id") != source["id"] or not anchor.get("provenance", "").strip():
        return result
    metadata = json.loads(source["metadata_json"])
    try:
        if anchor["source_pts"] != metadata["first_pts"] or anchor["time_base"] != metadata["time_base"]:
            raise ValueError("Clock binding mismatch")
        origin = datetime.fromisoformat(anchor["utc"])
        if origin.tzinfo is None or origin.utcoffset() is None:
            raise ValueError("Unknown timezone")
        base = windows.fraction(metadata["time_base"])
        offsets = [(windows.fraction(value) - int(anchor["source_pts"])) * base if value is not None else None for value in (start, end)]
        result.update(clock_provenance=anchor["provenance"], clock_reason="anchored_exact_microseconds",
                      clock_anchor_utc=anchor["utc"], clock_anchor_source_pts=anchor["source_pts"],
                      clock_offset_seconds=[windows.rational(v) if v is not None else None for v in offsets])
        for key, offset in zip(("start_utc", "end_utc_exclusive"), offsets):
            if offset is not None:
                micros = offset * 1000000
                if micros.denominator == 1:
                    result[key] = (origin.astimezone(timezone.utc) + timedelta(microseconds=micros.numerator)).isoformat()
                else:
                    result["clock_reason"] = "exact_fractional_offset_only"
    except (ValueError, KeyError, TypeError, OverflowError, ZeroDivisionError):
        result["clock_reason"] = "invalid_clock_provenance"
    return result


def expansion_rows(database: Path, directory: Path, run_id: str, as_of: str, check, files: dict) -> dict | None:
    """Tracks and three-layer gate counts; header-only files when no complete tracking run exists."""
    from . import count_store, label_store, sample_store, store, tracking_store

    tracks_file = CSVFile(directory / FILES["tracks"], TRACK_COLUMNS, check)
    counts_file = None
    try:
        counts_file = CSVFile(directory / FILES["counts"], COUNT_COLUMNS, check)
        info = None
        if store.schema_version(database) >= store.TRACKING_SCHEMA_VERSION:
            with closing(readonly(database)) as connection:
                run = connection.execute("""SELECT * FROM tracking_run WHERE summary_run_id=? AND state='complete'
                    ORDER BY started_at_utc DESC, rowid DESC LIMIT 1""", (run_id,)).fetchone()
                rows = connection.execute("""SELECT t.*, s.sha256 FROM track t JOIN segment s ON s.id = t.segment_id
                    WHERE t.run_id=? ORDER BY t.segment_id, t.track_index""", (run["id"],)).fetchall() if run else []
            if run is not None:
                base = {"schema_version": SCHEMA, "provisional_label": LABEL, "as_of_utc": as_of, "run_id": run_id,
                        "tracking_run_id": run["id"], "tracking_algorithm_version": run["algorithm_version"],
                        "tracking_parameter_sha256": run["parameter_hash"]}
                labelled = label_store.labels(database, run["id"])
                for row in rows:
                    check()
                    label = labelled["tracks"].get(row["id"]) or {}
                    tracks_file.row({**base, "track_id": row["id"], "segment_id": row["segment_id"], "source_sha256": row["sha256"],
                                     "track_index": row["track_index"], "first_pts": row["first_pts"], "last_pts": row["last_pts"],
                                     "point_count": row["point_count"], "bbox_json": row["bbox_json"], "points_sha256": row["points_sha256"],
                                     "quality": row["quality"] if "quality" in row.keys() else "unrated",
                                     "metrics_json": row["metrics_json"] if "metrics_json" in row.keys() else "{}",
                                     "label_category": label.get("category"), "label_species": label.get("species"),
                                     "label_comment": label.get("comment"), "label_actor": label.get("actor"), "label_event_id": label.get("event_id")})
                gates = count_store.list_gates(database, run["session_id"])
                for gate in gates:
                    if gate["state"] != "active":
                        continue
                    result = count_store.counts(database, run["id"], gate["id"])
                    head = {**base, "gate_id": gate["id"], "gate_name": gate["name"], "gate_revision": gate["revision"], "gate_kind": gate["kind"],
                            "gate_points_json": json.dumps(gate["points"]), "gate_frame_w": gate["frame_w"], "gate_frame_h": gate["frame_h"],
                            "label_a": gate["label_a"], "label_b": gate["label_b"], "entry_direction": gate["entry_direction"],
                            "hysteresis_px": str(gate["hysteresis_px"]), "gate_algorithm_version": result["algorithm_version"]}
                    for crossing in result["crossings"]:
                        review = crossing["review"] or {}
                        counts_file.row({**head, "row_kind": "crossing", "crossing_key": crossing["key"], "track_id": crossing["track_id"],
                                         "segment_id": crossing["segment_id"], "source_pts": crossing["pts"], "direction": crossing["direction"],
                                         "track_quality": crossing["quality"], "review_action": review.get("action"),
                                         "flipped": review.get("flipped"), "count": review.get("count"), "reviewer": review.get("actor"),
                                         "rationale": review.get("rationale")})
                    for added in result["missed"]:
                        counts_file.row({**head, "row_kind": "added", "layer": "reviewer", "crossing_key": added["key"], "segment_id": added["segment_id"],
                                         "source_pts": added["pts"], "direction": added["direction"], "review_action": "add_missed",
                                         "count": added["count"], "reviewer": added["actor"], "rationale": added["rationale"]})
                    for span in result["invalid_spans"]:
                        # A camera move or new video without a reconfirmed gate: nothing is counted from here on.
                        counts_file.row({**head, "row_kind": "invalid_span", "segment_id": span["segment_id"], "source_pts": span["from_pts"],
                                         "span_reason": span["reason"]})
                    qa = result["layers"]["qa"]
                    for layer, totals in (("algorithm", result["layers"]["algorithm"]), ("reviewer", result["layers"]["reviewer"]),
                                          ("qa", qa["counts"] if qa else None)):
                        counts_file.row({**head, "row_kind": "total", "layer": layer, "qa_decision": qa["decision"] if qa else None,
                                         "reviewer_state": result["layers"]["reviewer"]["state"] if layer == "reviewer" else None,
                                         "qa_actor": qa["actor"] if qa else None, "qa_stale": qa["stale"] if qa else None,
                                         **({key: totals[key] for key in ("entered", "exited", "net")} if totals else {})})
                settings = json.loads(run["parameters_json"]).get("settings")
                scene_events = tracking_store.events(database, run["id"]) if store.schema_version(database) >= store.TRACKS_V2_SCHEMA_VERSION else []
                info = {"tracking_run_id": run["id"], "algorithm_version": run["algorithm_version"], "parameter_sha256": run["parameter_hash"],
                        "settings": settings, "scene_events": [{key: event[key] for key in ("segment_id", "kind", "start_pts", "end_pts")} for event in scene_events],
                        "tracks": len(rows), "labels": {"events": len(labelled["events"]), "undone": sum(1 for event in labelled["events"] if event["undoes"]),
                                                         "labelled_tracks": len(labelled["tracks"]), "custom": labelled["custom"]},
                        "gates": sum(1 for gate in gates if gate["state"] == "active"),
                        "sample_checks": [{"gate_id": check_["gate_id"], "gate_revision": check_["gate_revision"], "actor": check_["actor"],
                                           "segment_id": check_["segment_id"], "start_pts": check_["start_pts"], "end_pts": check_["end_pts"],
                                           "manual": check_["result"]["manual"], "algorithm": check_["result"]["algorithm"],
                                           "matched": len(check_["result"]["matched"]), "missed_by_algorithm": len(check_["result"]["missed_by_algorithm"]),
                                           "extra_in_algorithm": len(check_["result"]["extra_in_algorithm"]), "max_rate": check_["receipt"]["max_rate"],
                                           "utc": check_["utc"]}
                                          for gate in gates for check_ in sample_store.checks(database, run["id"], gate["id"])],
                        "note": "Tracks and crossings are review candidates, not animals. Track labels and species are reviewer entries that never change a count. Layers: algorithm (unverified), reviewer, qa (null until approved)."}
        files["tracks"], files["counts"] = tracks_file.close(), counts_file.close()
        return info
    finally:
        tracks_file.handle.close()
        if counts_file is not None:
            counts_file.handle.close()


def export_rows(database: Path, data_dir: Path, run_id: str, directory: Path, as_of: str, check) -> dict:
    from . import qa_store, review_store, summary_store, windows
    from .qa import QAService
    from .reviews import ReviewService
    from .summary_jobs import summary_image_path

    class Images:
        def _image_path(self, row: dict) -> Path:
            return summary_image_path(data_dir / "summaries", row)

    validator = ReviewService(database, Images(), None, Lock())
    seen_evidence: dict[str, str] = {}
    plans: dict = {}
    counts = {"planned": 0, "actual": 0, "missing": 0, "reviewed": 0, "first_stale": 0, "qa_stale": 0, "timestamp_gaps": 0, "evidence_flagged": 0,
              "processing": {k: 0 for k in ("planned", "running", "complete", "failed", "incomplete", "missing_manifest_record")},
              "qa": {k: 0 for k in ("agree", "disagree", "needs_clarification", "pending", "unassessable")}}
    observations = CSVFile(directory / FILES["observations"], OBS_COLUMNS, check)
    audit = None
    try:
        audit = CSVFile(directory / FILES["audit"], AUDIT_COLUMNS, check)
        with closing(readonly(database)) as connection:
            raw = connection.execute("SELECT * FROM processing_run WHERE id=?", (run_id,)).fetchone()
            if not raw:
                raise ExportFailure("export_missing")
            run = {**dict(raw), "parameters": json.loads(raw["parameters_json"])}
            if run["state"] in {"queued", "running"}:
                raise ExportFailure("export_busy")
            sources = json.loads(run["source_snapshots_json"])
            if not 0 < len(sources) <= 64 or run["parameter_hash"] != windows.parameter_hash(run["parameters"]):
                raise ExportFailure("export_stale")
            private = {"run": run, "sources": sources}
            anchor_row = connection.execute("SELECT clock_anchor_json FROM session_media WHERE session_id=?", (run["session_id"],)).fetchone()
            anchor = json.loads(anchor_row[0]) if anchor_row and anchor_row[0] else None
            actual = connection.execute("SELECT COUNT(*) FROM summary_window WHERE run_id=?", (run_id,)).fetchone()[0]
            if actual > windows.MAX_WINDOWS:
                raise ExportFailure("export_too_large")

            def rows():
                planned = 0
                for order, source in enumerate(sources):
                    metadata = json.loads(source["metadata_json"])
                    if source["id"] not in plans:
                        plans[source["id"]] = windows.plan_source(metadata, run["parameters"]["window_seconds"])
                    plan = plans[source["id"]]
                    planned += len(plan)
                    if planned > windows.MAX_WINDOWS:
                        raise ExportFailure("export_too_large")
                    for interval in plan:
                        check()
                        stored = connection.execute("SELECT * FROM summary_window WHERE run_id=? AND segment_id=? AND window_index=?",
                                                    (run_id, source["id"], interval["index"])).fetchone()
                        if stored:
                            row = summary_store._decode_window(stored)
                            if row["interval"] != interval:
                                raise ExportFailure("export_stale")
                        else:
                            row = {"id": "", "run_id": run_id, "segment_id": source["id"], "index": interval["index"], "interval": interval,
                                   "status": "missing_manifest_record", "error_code": "missing_manifest_record", "source_sha256": source["sha256"],
                                   "time_base": metadata["time_base"], "evidence_revision": 0, "stats": {}, "flags": [],
                                   "image_path": None, "image_sha256": None, "image_bytes": 0}
                        yield order, source, row
                if planned != run["expected_windows"]:
                    raise ExportFailure("export_stale")

            def effective(row):
                if row["id"]:
                    first = review_store._projection(connection.execute("SELECT * FROM review_window WHERE window_id=?", (row["id"],)).fetchone())
                    qa = qa_store._get(connection, row["id"])
                    qa["has_disagreement"] = bool(connection.execute("SELECT 1 FROM qa_event WHERE window_id=? AND json_extract(after_json,'$.decision')='disagree' LIMIT 1", (row["id"],)).fetchone())
                    clarification = bool(connection.execute("SELECT 1 FROM qa_event WHERE window_id=? AND json_extract(after_json,'$.decision')='needs_clarification' LIMIT 1", (row["id"],)).fetchone())
                else:
                    first, qa, clarification = review_store._projection(None), qa_store.empty(), False
                source = next(s for s in sources if s["id"] == row["segment_id"])
                current = connection.execute("SELECT * FROM segment WHERE id=?", (row["segment_id"],)).fetchone()
                evidence = validator._evidence(private, row, latch=False, plans=plans,
                    sources={row["segment_id"]: validator._source_binding(source, dict(current) if current else None)})
                if not row["id"]:
                    evidence["warning"] = "missing_manifest_record"
                header = validator._header(first, evidence)
                qheader = QAService.header(qa, header, evidence, row)
                return first, qa, header, qheader, clarification, evidence

            for order, source, row in rows():
                first, qa, header, qheader, clarification, evidence = effective(row)
                key = f"{source['id']}:{row['index']}"
                seen_evidence[key] = windows.parameter_hash(evidence)
                counts["evidence_flagged"] += evidence["warning"] is not None
                counts["planned"] += 1
                counts["actual"] += bool(row["id"])
                counts["missing"] += not row["id"]
                counts["processing"][row["status"]] += 1
                counts["reviewed"] += header["effective_decision"] != "unreviewed"
                counts["first_stale"] += header["needs_reverification"]
                counts["qa_stale"] += qheader["needs_reverification"]
                counts["qa"][qheader["status"]] += 1
                counts["timestamp_gaps"] += row["stats"].get("gap_count", 0)
                common = {"schema_version": SCHEMA, "provisional_label": LABEL, "as_of_utc": as_of, "run_id": run_id,
                    "session_id": run["session_id"], "summary_window_id": row["id"], "segment_id": source["id"],
                    "segment_order": order, "window_index": row["index"], "source_sha256": row["source_sha256"],
                    "source_filename": Path(source["source_path"]).name, "time_base_num": row["time_base"]["num"], "time_base_den": row["time_base"]["den"],
                    "first_review_revision": first["revision"], "first_review_actor": first["actor"], "first_review_decision": first["decision"],
                    "first_review_effective_decision": header["effective_decision"], "first_review_needs_reverification": header["needs_reverification"],
                    "first_review_reason": header["verification_warning"], "qa_revision": qa["revision"], "qa_actor": qa["actor"], "qa_decision": qa["decision"],
                    "qa_effective_status": qheader["status"], "qa_needs_reverification": qheader["needs_reverification"], "qa_reason": qheader["warning"],
                    "qa_note": qa.get("note", ""), "has_disagreement": qa.get("has_disagreement", False), "has_clarification": clarification}
                interval = row["interval"]
                values = {**common, "source_state": evidence["source_state"], "evidence_revision": evidence["evidence_revision"], "evidence_fingerprint": evidence["fingerprint"], "processing_status": row["status"], "processing_error": row["error_code"], "quality_flags": json.dumps(row["flags"]),
                          "algorithm_version": run["algorithm_version"], "parameter_sha256": run["parameter_hash"],
                          "image_sha256": row["image_sha256"], "image_bytes": row["image_bytes"], "frame_count": row["stats"].get("frame_count"),
                          "motion_pixels": row["stats"].get("motion_pixels"), "timestamp_gap_count": row["stats"].get("gap_count"),
                          "continuity_before": source["continuity"], "observation_count": len(first["observations"]),
                          "modality": source.get("modality", "active_ir"),
                          "first_history_endpoint": f"/api/summary-windows/{row['id']}/review-history" if row["id"] else "",
                          "first_history_through_revision": first["revision"], "qa_history_endpoint": f"/api/summary-windows/{row['id']}/qa-history" if row["id"] else "",
                          "qa_history_through_revision": qa["revision"], **clock(anchor, source, interval["start_pts"], interval["end_pts"])}
                for name, field in (("window_start_pts", "start_pts"), ("window_end_pts", "end_pts"), ("source_start_seconds", "start_time"),
                                    ("source_end_seconds", "end_time"), ("elapsed_start_seconds", "elapsed_start"), ("elapsed_end_seconds", "elapsed_end")):
                    for part in ("num", "den"):
                        values[f"{name}_{part}"] = interval[field][part] if interval[field] is not None else None
                audit.row(values)
                revisions = qa_store.observation_revisions(connection, row["id"]) if first["observations"] else {}
                for item in sorted(first["observations"], key=lambda v: v["id"]):
                    review_store._observation({k: v for k, v in item.items() if k != "id"}, {**evidence["binding"], "source_snapshot": source})
                    observations.row({**common, "observation_id": item["id"], "observation_revision": revisions[item["id"]],
                        "start_pts": item["start_pts"], "end_pts_exclusive": item["end_pts"], **{k: item[k] for k in ("category", "activity", "count", "uncertain", "notes")},
                        **clock(anchor, source, {"num": item["start_pts"], "den": "1"}, {"num": item["end_pts"], "den": "1"})})
            if counts["actual"] != actual:
                raise ExportFailure("export_stale")
            # Filesystem evidence is not transactional with SQLite. A second real
            # check must agree with the first before these snapshot rows publish.
            for _, source, row in rows():
                check()
                if seen_evidence[f"{source['id']}:{row['index']}"] != windows.parameter_hash(effective(row)[-1]):
                    raise ExportFailure("export_stale")
        files = {"observations": observations.close(), "audit": audit.close()}
        tracking = expansion_rows(database, directory, run_id, as_of, check, files)
        from . import audio_store
        audio = [{"audio_id": item["id"], "filename": item["metadata"]["filename"], "sha256": item["sha256"], "sample_rate": item["metadata"]["sample_rate"],
                  "source_mode": item["source_mode"], "channel": item["channel"], "anchor": item["anchor"], "drift_corrected": False}
                 for item in audio_store.list_sources(database, run["session_id"])]
        return {"schema_version": SCHEMA, "tracking": tracking, "audio_sync": audio, "provisional_label": LABEL, "as_of_utc": as_of, "run_id": run_id,
                "counts": counts, "manifest_complete": counts["missing"] == 0, "processing_complete": run["state"] == "complete" and counts["processing"]["complete"] == counts["planned"],
                "source_continuity": [{"segment_id": s["id"], "continuity_before": s["continuity"]} for s in sources], "files": files,
                "columns": {"observations": OBS_COLUMNS, "audit": AUDIT_COLUMNS, "tracks": TRACK_COLUMNS, "counts": COUNT_COLUMNS}, "numeric_columns": sorted(NUMERIC),
                "text_encoding": "apostrophe-backslash-v1: remove one leading apostrophe; decode doubled backslash and backslash-uXXXX; empty stays empty",
                "history": "Use existing authenticated history endpoints with after_revision pagination; include only revisions <= the exported through_revision. Append-only histories are immutable.",
                "limits": {"csv_bytes_each": MAX_CSV_BYTES, "rows_each": MAX_ROWS, "snapshot_bytes": MAX_SNAPSHOT_BYTES, "wall_seconds": MAX_SECONDS}}
    finally:
        observations.handle.close()
        if audit is not None:
            audit.handle.close()
