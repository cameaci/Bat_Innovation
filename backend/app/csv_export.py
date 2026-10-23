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
SCHEMA = "bat-provisional-csv-v1"
MAX_CSV_BYTES = 8 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
MAX_ROWS = 50000
MAX_ROW_BYTES = 64 * 1024
MAX_SECONDS = 30
FILES = {"observations": "provisional-observations.csv", "audit": "technical-window-audit.csv", "manifest": "manifest.json"}
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
    "first_history_endpoint", "first_history_through_revision", "qa_history_endpoint", "qa_history_through_revision", "canonical_json"]
NUMERIC = {"evidence_revision", "segment_order", "window_index", "time_base_num", "time_base_den", "first_review_revision", "qa_revision",
    "first_review_needs_reverification", "qa_needs_reverification", "has_disagreement", "has_clarification",
    "observation_revision", "start_pts", "end_pts_exclusive", "count", "uncertain", "image_bytes", "frame_count", "motion_pixels",
    "timestamp_gap_count", "observation_count", "first_history_through_revision", "qa_history_through_revision"} | {
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
        return {"schema_version": SCHEMA, "provisional_label": LABEL, "as_of_utc": as_of, "run_id": run_id,
                "counts": counts, "manifest_complete": counts["missing"] == 0, "processing_complete": run["state"] == "complete" and counts["processing"]["complete"] == counts["planned"],
                "source_continuity": [{"segment_id": s["id"], "continuity_before": s["continuity"]} for s in sources], "files": files,
                "columns": {"observations": OBS_COLUMNS, "audit": AUDIT_COLUMNS}, "numeric_columns": sorted(NUMERIC),
                "text_encoding": "apostrophe-backslash-v1: remove one leading apostrophe; decode doubled backslash and backslash-uXXXX; empty stays empty",
                "history": "Use existing authenticated history endpoints with after_revision pagination; include only revisions <= the exported through_revision. Append-only histories are immutable.",
                "limits": {"csv_bytes_each": MAX_CSV_BYTES, "rows_each": MAX_ROWS, "snapshot_bytes": MAX_SNAPSHOT_BYTES, "wall_seconds": MAX_SECONDS}}
    finally:
        observations.handle.close()
        if audit is not None:
            audit.handle.close()
