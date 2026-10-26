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
TEST_SECONDS = 12
WARM_SECONDS = 2
MAX_TEST_RESULT_BYTES = 4 * 1024 * 1024
CPU_SECONDS = 600
ERRORS = {"missing_source", "unreadable_source", "changed_source", "unsupported_codec", "decode_failed",
          "unknown_timing", "tracking_limit", "tracking_limits_unavailable", "tracking_failed", "tracking_settings"}

os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"


def limits(parent_pid: int) -> None:
    if sys.platform == "win32":
        workers.require_limits(ValueError("tracking_limits_unavailable"))
    elif sys.platform != "linux" or not workers.linux_limits(parent_pid, MEMORY_BYTES, CPU_SECONDS, 1024 * 1024):
        raise ValueError("tracking_limits_unavailable")


def _timing(metadata: dict) -> tuple[float, float]:
    """Frames per second from the decoded frame count and elapsed time, and seconds per source tick."""
    from fractions import Fraction

    time_base = Fraction(int(metadata["time_base"]["num"]), int(metadata["time_base"]["den"]))
    elapsed = metadata.get("elapsed_last_time")
    span = Fraction(int(elapsed["num"]), int(elapsed["den"])) if elapsed else Fraction(0)
    if metadata.get("frame_count", 0) < 2 or span <= 0:
        raise ValueError("unknown_timing")
    return float((metadata["frame_count"] - 1) / span), float(time_base)


def render(payload: dict) -> dict:
    from . import media, store, summary_store, tracking_store, tracks

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
            fps, tick = _timing(metadata)
            analyzer = tracks.Analyzer(int(metadata["width"]), int(metadata["height"]), fps, tick, values["settings"])
            for frame in media.decoded_frames(container, stream):
                decoded += 1
                if decoded > MAX_FRAMES:
                    raise ValueError("tracking_limit")
                analyzer.feed(int(frame.pts), frame.to_ndarray(format="gray"))
            finished, events, segment = analyzer.finish()
        total_tracks += len(finished)
        total_points += sum(len(track.points) for track in finished)
        if total_tracks > MAX_TRACKS or total_points > MAX_POINTS:
            raise ValueError("tracking_limit")
        tracking_store.record_segment(db, run["id"], snapshot["id"], finished, events)
        stats[snapshot["id"]] = segment
    return stats


def test(payload: dict) -> dict:
    """Track a short range of one segment with draft settings; nothing is stored (calibration, W3)."""
    from . import media, store, tracks

    segment = store.segment_by_id(Path(payload["db_path"]), payload["segment_id"])
    if segment is None:
        raise ValueError("missing_source")
    start, end = int(payload["start_pts"]), int(payload["end_pts"])
    with media.open_verified_source(segment) as (container, stream, metadata):
        fps, tick = _timing(metadata)
        if end <= start or (end - start) * tick > TEST_SECONDS:
            raise ValueError("tracking_limit")
        analyzer = tracks.Analyzer(int(metadata["width"]), int(metadata["height"]), fps, tick, payload["settings"], (start, end))
        warm = round(WARM_SECONDS / tick)
        try:
            container.seek(max(int(metadata["first_pts"]), start - warm), stream=stream, backward=True, any_frame=False)
        except Exception:
            raise ValueError("decode_failed") from None
        stop = end + warm
        for frame in media.decoded_frames(container, stream):
            if int(frame.pts) > stop:
                break
            analyzer.feed(int(frame.pts), frame.to_ndarray(format="gray"))
        found, events, stats = analyzer.finish()
    shown = [track for track in found if int(track.points[-1][0]) >= start and int(track.points[0][0]) <= end]
    return {"segment_id": segment["id"], "start_pts": str(start), "end_pts": str(end), "stats": stats,
            "detections": analyzer.detections,
            "tracks": [{"id": f"test-{index}", "segment_id": segment["id"], "track_index": index, "quality": track.quality,
                        "metrics": track.metrics, "first_pts": str(track.points[0][0]), "last_pts": str(track.points[-1][0]),
                        "point_count": len(track.points), "bbox": track.box,
                        "points": [[str(pts), round(x, 2), round(y, 2), int(area)] for pts, x, y, area in track.points]}
                       for index, track in enumerate(shown)],
            "events": [{"kind": event.kind, "start_pts": str(event.start_pts), "end_pts": str(event.end_pts), "details": event.details}
                       for event in events]}


def main() -> None:
    result: dict = {"error": None, "stats": None}
    try:
        raw = workers.read_request(MAX_REQUEST_BYTES)
        if len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("tracking_limit")
        payload = json.loads(raw)
        limits(payload["parent_pid"])
        result["stats"] = test(payload) if payload.get("mode") == "test" else render(payload)
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
