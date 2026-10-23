"""Disposable, OS-limited worker that turns one summary run's sources into persisted tracks (E2)."""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys

from . import workers

MAX_REQUEST_BYTES = 64 * 1024
MAX_FRAMES = 1_000_000
MAX_TRACKS = 20_000
MAX_POINTS = 2_000_000
MEMORY_BYTES = 1024 ** 3
CPU_SECONDS = 600
ERRORS = {"missing_source", "unreadable_source", "changed_source", "unsupported_codec", "decode_failed",
          "unknown_timing", "tracking_limit", "tracking_limits_unavailable", "tracking_failed"}

os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"


def limits(parent_pid: int) -> None:
    if sys.platform == "win32":
        workers.require_limits(ValueError("tracking_limits_unavailable"))
    elif sys.platform != "linux" or not workers.linux_limits(parent_pid, MEMORY_BYTES, CPU_SECONDS, 1024 * 1024):
        raise ValueError("tracking_limits_unavailable")


def render(payload: dict) -> dict:
    from . import media, motion, store, summary_store, tracking_store, tracks

    db = Path(payload["db_path"])
    run = tracking_store.get_run(db, payload["run_id"])
    summary = summary_store.private_run(db, run["summary_run_id"])
    values = run["parameters"]
    if tracks.parameter_hash(values) != run["parameter_hash"]:
        raise ValueError("tracking_failed")
    tracking_store.set_state(db, run["id"], "running")
    stats: dict[str, dict] = {}
    total_tracks = total_points = decoded = 0
    for snapshot in summary["sources"]:
        current = store.segment_by_id(db, snapshot["id"])
        # Tracks are tied to the exact bytes summarised by the selected run.
        if current is None or current["sha256"] != snapshot["sha256"]:
            raise ValueError("changed_source")
        with media.open_verified_source(current) as (container, stream, metadata):
            width, height = int(metadata["width"]), int(metadata["height"])
            step = max(1, -(-width // values["max_width"]), -(-height // values["max_height"]))
            tracker = tracks.Tracker(width, values)
            previous = before = None
            segment = {"frames": 0, "candidates": 0, "framewide_frames": 0, "candidate_limit_frames": 0}
            for frame in media.decoded_frames(container, stream):
                decoded += 1
                if decoded > MAX_FRAMES:
                    raise ValueError("tracking_limit")
                gray = frame.to_ndarray(format="gray")
                segment["frames"] += 1
                if before is not None:
                    found, flag = tracks.candidates(tracks.difference(gray, previous), tracks.difference(gray, before), step, values)
                    if flag:
                        segment[f"{'framewide' if flag == 'framewide_change' else 'candidate_limit'}_frames"] += 1
                        tracker.gap()
                    else:
                        segment["candidates"] += len(found)
                        tracker.update(int(frame.pts), found)
                previous, before = gray, previous
            finished = tracker.finish()
        total_tracks += len(finished)
        total_points += sum(len(track.points) for track in finished)
        if total_tracks > MAX_TRACKS or total_points > MAX_POINTS:
            raise ValueError("tracking_limit")
        tracking_store.record_segment(db, run["id"], snapshot["id"], finished)
        segment["tracks"] = len(finished)
        stats[snapshot["id"]] = segment
    return stats


def main() -> None:
    result: dict = {"error": None, "stats": None}
    try:
        raw = workers.read_request(MAX_REQUEST_BYTES)
        if len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("tracking_limit")
        payload = json.loads(raw)
        limits(payload["parent_pid"])
        result["stats"] = render(payload)
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error) in ERRORS else getattr(error, "code", None)
        code = code if code in ERRORS else None
        if isinstance(error, FileNotFoundError):
            code = "missing_source"
        elif isinstance(error, PermissionError):
            code = "unreadable_source"
        elif isinstance(error, MemoryError):
            code = "tracking_limit"
        result = {"error": code or "tracking_failed", "stats": None}
    workers.write_response(json.dumps(result))


if __name__ == "__main__":
    main()
