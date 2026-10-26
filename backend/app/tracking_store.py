"""SQLite persistence for tracking runs and tracks (schema v7, feature expansion E2)."""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
from uuid import uuid4

from . import store, tracks

TERMINAL = {"complete", "failed", "cancelled", "interrupted"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def upgrade(db_path: Path) -> None:
    """Explicit v6 -> v7 transition; tracks are derived and never edit summary evidence."""
    if not db_path.is_file():
        raise store.DatabaseSchemaError("Tracking upgrade requires an existing version 6 database")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version >= store.TRACKING_SCHEMA_VERSION:
            return
        if version != store.MODALITY_SCHEMA_VERSION:
            raise store.DatabaseSchemaError("Tracking upgrade requires database schema version 6")
        connection.execute("SELECT modality FROM segment LIMIT 1")
        connection.execute("""CREATE TABLE tracking_run (
            id TEXT PRIMARY KEY,
            summary_run_id TEXT NOT NULL REFERENCES processing_run(id),
            session_id TEXT NOT NULL REFERENCES recording_session(id),
            state TEXT NOT NULL CHECK(state IN ('queued','running','complete','failed','cancelled','interrupted')),
            algorithm_version TEXT NOT NULL,
            parameters_json TEXT NOT NULL,
            parameter_hash TEXT NOT NULL,
            stats_json TEXT NOT NULL DEFAULT '{}',
            error_code TEXT,
            started_at_utc TEXT NOT NULL,
            finished_at_utc TEXT
        )""")
        connection.execute("""CREATE TABLE track (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES tracking_run(id),
            segment_id TEXT NOT NULL REFERENCES segment(id),
            track_index INTEGER NOT NULL CHECK(track_index >= 0),
            first_pts TEXT NOT NULL,
            last_pts TEXT NOT NULL,
            point_count INTEGER NOT NULL CHECK(point_count > 0),
            bbox_json TEXT NOT NULL,
            points BLOB NOT NULL,
            points_sha256 TEXT NOT NULL,
            UNIQUE(run_id, segment_id, track_index)
        )""")
        connection.execute("CREATE INDEX track_segment_time ON track(run_id, segment_id, first_pts)")
        connection.execute(f"PRAGMA user_version={store.TRACKING_SCHEMA_VERSION}")


def upgrade_v2(db_path: Path) -> None:
    """Explicit v11 -> v12 transition: per-track quality and metrics, and classified scene events (tracks-v2)."""
    if not db_path.is_file():
        raise store.DatabaseSchemaError("Tracks v2 upgrade requires an existing version 11 database")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version >= store.TRACKS_V2_SCHEMA_VERSION:
            return
        if version != store.PROXY_SCHEMA_VERSION:
            raise store.DatabaseSchemaError("Tracks v2 upgrade requires database schema version 11")
        connection.execute("SELECT id FROM proxy LIMIT 1")
        # Tracks of earlier runs keep 'unrated': tracks-v1 had no quality class.
        connection.execute("""ALTER TABLE track ADD COLUMN quality TEXT NOT NULL DEFAULT 'unrated'
            CHECK(quality IN ('unrated','coherent','uncertain','noise'))""")
        connection.execute("ALTER TABLE track ADD COLUMN metrics_json TEXT NOT NULL DEFAULT '{}'")
        connection.execute("""CREATE TABLE tracking_event (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES tracking_run(id),
            segment_id TEXT NOT NULL REFERENCES segment(id),
            kind TEXT NOT NULL CHECK(kind IN ('camera_moved','lighting_change','glitch')),
            start_pts TEXT NOT NULL,
            end_pts TEXT NOT NULL,
            details_json TEXT NOT NULL
        )""")
        connection.execute("CREATE INDEX tracking_event_segment ON tracking_event(run_id, segment_id, start_pts)")
        connection.execute(f"PRAGMA user_version={store.TRACKS_V2_SCHEMA_VERSION}")


def require_schema(db_path: Path) -> bool:
    return store.schema_version(db_path) >= store.TRACKS_V2_SCHEMA_VERSION


def create_run(db_path: Path, summary_run_id: str, settings: dict | None = None) -> str:
    values = tracks.parameters(settings)
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        run = connection.execute("SELECT session_id, state FROM processing_run WHERE id=?", (summary_run_id,)).fetchone()
        if run is None:
            raise LookupError("summary run")
        if run["state"] in ("queued", "running"):
            raise ValueError("summary_running")
        run_id = str(uuid4())
        connection.execute("""INSERT INTO tracking_run (id, summary_run_id, session_id, state, algorithm_version,
            parameters_json, parameter_hash, started_at_utc) VALUES (?,?,?,?,?,?,?,?)""",
            (run_id, summary_run_id, run["session_id"], "queued", tracks.ALGORITHM_VERSION,
             json.dumps(values), tracks.parameter_hash(values), _now()))
    return run_id


def set_state(db_path: Path, run_id: str, state: str, error: str | None = None, stats: dict | None = None) -> None:
    with closing(store.connect(db_path)) as connection, connection:
        if state in TERMINAL:
            connection.execute("""UPDATE tracking_run SET state=?, error_code=?, finished_at_utc=?,
                stats_json=COALESCE(?, stats_json) WHERE id=?""",
                (state, error, _now(), json.dumps(stats) if stats is not None else None, run_id))
        else:
            connection.execute("UPDATE tracking_run SET state=? WHERE id=?", (state, run_id))


def record_segment(db_path: Path, run_id: str, segment_id: str, found: list[tracks.Track],
                   events: list[tracks.SceneEvent] = ()) -> None:
    """All tracks and scene events of one segment commit together, so a partial segment is never presented."""
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        for index, track in enumerate(found):
            blob = tracks.pack(track.points)
            info = tracks.summary(track)
            connection.execute("""INSERT INTO track (id, run_id, segment_id, track_index, first_pts, last_pts,
                point_count, bbox_json, points, points_sha256, quality, metrics_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (str(uuid4()), run_id, segment_id, index, info["first_pts"], info["last_pts"], info["point_count"],
                 json.dumps(info["bbox"]), blob, tracks.digest(blob), track.quality, json.dumps(track.metrics)))
        for event in events:
            connection.execute("""INSERT INTO tracking_event (id, run_id, segment_id, kind, start_pts, end_pts, details_json)
                VALUES (?,?,?,?,?,?,?)""", (str(uuid4()), run_id, segment_id, event.kind, str(event.start_pts),
                                             str(event.end_pts), json.dumps(event.details)))


def recover(db_path: Path) -> None:
    if store.schema_version(db_path) < store.TRACKING_SCHEMA_VERSION:
        return
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("""UPDATE tracking_run SET state='interrupted', error_code='interrupted', finished_at_utc=?
            WHERE state IN ('queued','running')""", (_now(),))


def _run(row) -> dict:
    return {"id": row["id"], "summary_run_id": row["summary_run_id"], "session_id": row["session_id"], "state": row["state"],
            "algorithm_version": row["algorithm_version"], "parameter_hash": row["parameter_hash"],
            "parameters": json.loads(row["parameters_json"]), "stats": json.loads(row["stats_json"]),
            "error": row["error_code"], "started_at_utc": row["started_at_utc"], "finished_at_utc": row["finished_at_utc"]}


def get_run(db_path: Path, run_id: str) -> dict | None:
    with closing(store.connect(db_path)) as connection:
        row = connection.execute("SELECT * FROM tracking_run WHERE id=?", (run_id,)).fetchone()
        if row is None:
            return None
        counts = connection.execute("SELECT segment_id, COUNT(*) FROM track WHERE run_id=? AND quality != 'noise' GROUP BY segment_id",
                                    (run_id,)).fetchall()
    result = _run(row)
    result["track_counts"] = {segment: count for segment, count in counts}
    return result


def window_counts(db_path: Path, run_id: str, windows: list[dict]) -> dict[str, int]:
    """Number of tracks overlapping each summary window [start_pts, end_pts), per segment."""
    import numpy as np

    with closing(store.connect(db_path)) as connection:
        rows = connection.execute("SELECT segment_id, first_pts, last_pts FROM track WHERE run_id=? AND quality != 'noise'",
                                  (run_id,)).fetchall()
    spans: dict[str, tuple] = {}
    for segment in {row[0] for row in rows}:
        chosen = [row for row in rows if row[0] == segment]
        spans[segment] = (np.array([int(row[1]) for row in chosen]), np.array([int(row[2]) for row in chosen]))
    result = {}
    for window in windows:
        first, last = spans.get(window["segment_id"], (np.array([]), np.array([])))
        start = window["interval"]["start_pts"]
        start = int(start["num"]) // int(start["den"])
        end = window["interval"]["end_pts"]
        overlap = last >= start if end is None else (last >= start) & (first < int(end["num"]) // int(end["den"]))
        result[window["id"]] = int(np.count_nonzero(overlap))
    return result


def list_runs(db_path: Path, summary_run_id: str) -> list[dict]:
    if store.schema_version(db_path) < store.TRACKING_SCHEMA_VERSION:
        return []
    with closing(store.connect(db_path)) as connection:
        rows = connection.execute("SELECT * FROM tracking_run WHERE summary_run_id=? ORDER BY started_at_utc DESC, rowid DESC",
                                  (summary_run_id,)).fetchall()
    return [_run(row) for row in rows]


def tracks_between(db_path: Path, run_id: str, segment_id: str, start_pts: int, end_pts: int | None,
                   limit: int = 500) -> list[dict]:
    """Tracks overlapping [start_pts, end_pts) with all their points, integrity-checked."""
    with closing(store.connect(db_path)) as connection:
        rows = connection.execute("SELECT * FROM track WHERE run_id=? AND segment_id=? ORDER BY track_index",
                                  (run_id, segment_id)).fetchall()
    result = []
    for row in rows:
        if int(row["last_pts"]) < start_pts or (end_pts is not None and int(row["first_pts"]) >= end_pts):
            continue
        if tracks.digest(row["points"]) != row["points_sha256"]:
            raise ValueError("track_integrity")
        points = tracks.unpack(row["points"])
        result.append({"id": row["id"], "segment_id": segment_id, "track_index": row["track_index"],
                       "quality": row["quality"], "metrics": json.loads(row["metrics_json"]),
                       "first_pts": row["first_pts"], "last_pts": row["last_pts"], "point_count": row["point_count"],
                       "bbox": json.loads(row["bbox_json"]),
                       "points": [[str(int(p["pts"])), round(float(p["x"]), 2), round(float(p["y"]), 2), int(p["area"])]
                                  for p in points]})
        if len(result) > limit:
            raise OverflowError("track_limit")
    return result


HEATMAP_COLUMNS = 64


def heatmap(db_path: Path, run_id: str, segment_id: str, mode: str, confirmed: set[str]) -> dict:
    """Counts of track points per grid cell in source coordinates. Points are not individuals."""
    import numpy as np

    with closing(store.connect(db_path)) as connection:
        segment = connection.execute("SELECT metadata_json FROM segment WHERE id=?", (segment_id,)).fetchone()
        rows = connection.execute("""SELECT id, points, points_sha256 FROM track WHERE run_id=? AND segment_id=?
            AND quality != 'noise'""", (run_id, segment_id)).fetchall()
    if segment is None:
        raise LookupError("segment")
    metadata = json.loads(segment["metadata_json"])
    width, height = int(metadata["width"]), int(metadata["height"])
    columns = HEATMAP_COLUMNS
    rows_count = max(1, round(columns * height / width))
    grid = np.zeros((rows_count, columns), dtype=np.int64)
    included = 0
    for row in rows:
        if mode == "confirmed" and row["id"] not in confirmed:
            continue
        if tracks.digest(row["points"]) != row["points_sha256"]:
            raise ValueError("track_integrity")
        points = tracks.unpack(row["points"])
        if mode == "first":
            points = points[:1]
        xs = np.clip((points["x"] / width * columns).astype(int), 0, columns - 1)
        ys = np.clip((points["y"] / height * rows_count).astype(int), 0, rows_count - 1)
        np.add.at(grid, (ys, xs), 1)
        included += 1
    return {"segment_id": segment_id, "mode": mode, "width": width, "height": height, "columns": columns, "rows": rows_count,
            "cells": grid.flatten().tolist(), "points": int(grid.sum()), "tracks": included}


def events(db_path: Path, run_id: str) -> list[dict]:
    """Classified scene disturbances of a run, in segment and time order."""
    with closing(store.connect(db_path)) as connection:
        rows = connection.execute("""SELECT tracking_event.* FROM tracking_event JOIN segment ON segment.id = tracking_event.segment_id
            WHERE run_id=? ORDER BY segment.position, CAST(start_pts AS INTEGER)""", (run_id,)).fetchall()
    return [{"id": row["id"], "segment_id": row["segment_id"], "kind": row["kind"], "start_pts": row["start_pts"],
             "end_pts": row["end_pts"], "details": json.loads(row["details_json"])} for row in rows]


FLIGHT_BIN_SECONDS = 10


def flight_bins(db_path: Path, run_id: str, segment_id: str) -> dict:
    """Track points per grid cell in 10 s bins from the segment's first frame, so a map can build up with playback.

    Noise tracks are left out. Cells count track points, not individuals; sparse [cell, count] pairs per bin.
    """
    import numpy as np
    from fractions import Fraction

    with closing(store.connect(db_path)) as connection:
        segment = connection.execute("SELECT metadata_json FROM segment WHERE id=?", (segment_id,)).fetchone()
        rows = connection.execute("""SELECT points, points_sha256 FROM track WHERE run_id=? AND segment_id=? AND quality != 'noise'""",
                                  (run_id, segment_id)).fetchall()
    if segment is None:
        raise LookupError("segment")
    metadata = json.loads(segment["metadata_json"])
    width, height = int(metadata["width"]), int(metadata["height"])
    columns = HEATMAP_COLUMNS
    rows_count = max(1, round(columns * height / width))
    time_base = Fraction(int(metadata["time_base"]["num"]), int(metadata["time_base"]["den"]))
    ticks = int(Fraction(FLIGHT_BIN_SECONDS) / time_base)
    first = int(metadata["first_pts"])
    bins: dict[int, np.ndarray] = {}
    for row in rows:
        if tracks.digest(row["points"]) != row["points_sha256"]:
            raise ValueError("track_integrity")
        points = tracks.unpack(row["points"])
        cells = (np.clip((points["y"] / height * rows_count).astype(int), 0, rows_count - 1) * columns +
                 np.clip((points["x"] / width * columns).astype(int), 0, columns - 1))
        for index, cell in zip(((points["pts"].astype(np.int64) - first) // ticks).tolist(), cells.tolist()):
            grid = bins.setdefault(index, np.zeros(columns * rows_count, dtype=np.int64))
            grid[cell] += 1
    return {"segment_id": segment_id, "width": width, "height": height, "columns": columns, "rows": rows_count,
            "bin_seconds": FLIGHT_BIN_SECONDS, "first_pts": str(first),
            "bins": [{"index": index, "cells": [[int(cell), int(grid[cell])] for cell in np.flatnonzero(grid)]}
                     for index, grid in sorted(bins.items())]}
