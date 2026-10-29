"""Disposable, OS-limited worker that renders one video's overlay or highlights video (Phase 3 X8).

The original is decoded read-only and re-identified by SHA-256; every source frame of the video (overlay) or every
frame within a second of a tracked target (highlights) is drawn with the review overlay and encoded as VP9/WebM at
up to 960x540. A title card names the export, the tracking run and the gate states; in highlights, each skipped span
becomes a one-second card stating its exact length and that it is not verified absence. A failure leaves no file.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import sys

from . import workers

MAX_REQUEST_BYTES = 16 * 1024
MAX_RENDER_BYTES = 4 * 1024 ** 3
MAX_FRAMES = 2_000_000
MEMORY_BYTES = 1536 * 1024 ** 2
PAD_SECONDS = 1
CARD_MS = 1000
TITLE_MS = 2000
ERRORS = {"missing_source", "unreadable_source", "changed_source", "unsupported_codec", "decode_failed", "unknown_timing",
          "render_limit", "render_limits_unavailable", "render_failed", "tracking_integrity"}


def cpu_seconds(duration_seconds: float) -> int:
    """Drawing every frame costs about four times a playback copy."""
    return int(120 + 16 * duration_seconds)


def limits(parent_pid: int, cpu: int) -> None:
    if sys.platform == "win32":
        workers.require_limits(ValueError("render_limits_unavailable"))
    elif sys.platform != "linux" or not workers.linux_limits(parent_pid, MEMORY_BYTES, cpu, MAX_RENDER_BYTES):
        raise ValueError("render_limits_unavailable")


def spans(tracks: list[dict], pad: int) -> list[tuple[int, int]]:
    """Merged [first - pad, last + pad] spans of the tracks, in source PTS."""
    merged: list[tuple[int, int]] = []
    for start, end in sorted((int(track["first_pts"]) - pad, int(track["last_pts"]) + pad) for track in tracks):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def clock_text(anchor: dict | None, segment_id: str, metadata: dict, pts: int, base: Fraction) -> str:
    """The declared recording clock in the anchored video (same arithmetic as the export), otherwise elapsed time."""
    if anchor and anchor.get("segment_id") == segment_id and anchor.get("provenance", "").strip() and anchor.get("source_pts") == metadata["first_pts"]:
        try:
            moment = datetime.fromisoformat(anchor["utc"]) + timedelta(seconds=float((pts - int(anchor["source_pts"])) * base))
            return moment.strftime("%H:%M:%S.") + f"{moment.microsecond // 1000:03d} (declared clock)"
        except (ValueError, KeyError):
            pass
    elapsed = float((pts - int(metadata["first_pts"])) * base)
    return f"elapsed {int(elapsed // 60)}:{elapsed % 60:05.2f}"


def render(payload: dict) -> dict:
    import av
    from PIL import Image

    from . import count_store, media, overlay, preview_worker, store, tracking_store

    db_path = Path(payload["db_path"])
    segment = store.segment_by_id(db_path, payload["segment_id"])
    if segment is None:
        raise ValueError("missing_source")
    run_id, highlights = payload["tracking_run_id"], payload["kind"] == "highlights"
    try:
        found = tracking_store.tracks_between(db_path, run_id, segment["id"], 0, None, include_noise=False, point_budget=10 ** 9)["tracks"]
    except ValueError:
        raise ValueError("tracking_integrity") from None
    tracks = [overlay.Track(record) for record in found]
    session = segment["session_id"]
    order = {item["id"]: index for index, item in enumerate(store.private_segments(db_path, session))}
    gates = [count_store.counts(db_path, run_id, gate["id"]) for gate in count_store.list_gates(db_path, session) if gate["state"] == "active"]
    anchor = store.clock_anchor(db_path, session)
    output, progress = Path(payload["output_path"]), Path(payload["progress_path"])
    frames = kept = drawn = 0
    skipped: list[dict] = []
    digest = hashlib.sha256()
    try:
        with media.open_verified_source(segment) as (container, video, metadata):
            if not 0 < metadata["width"] <= 4096 or not 0 < metadata["height"] <= 2160:
                raise ValueError("render_limit")
            base = video.time_base
            ticks = float(1 / base)
            keep = spans(found, round(PAD_SECONDS * ticks)) if highlights else None
            expected = max(1, int(metadata.get("frame_count") or 1))
            with av.open(str(output), "w", format="webm") as target:
                stream = preview_worker.vp9_stream(target, metadata["width"], metadata["height"], lossless=False, threads=2)
                # Overlays need room to be legible: small sources are scaled up to fit 960x540 too.
                scale = min(960 / metadata["width"], 540 / metadata["height"])
                stream.width, stream.height = max(2, int(metadata["width"] * scale) // 2 * 2), max(2, int(metadata["height"] * scale) // 2 * 2)
                size = (stream.width, stream.height)
                clock_ms = 0
                pending: tuple | None = None

                def emit(image: Image.Image, duration: int) -> None:
                    nonlocal clock_ms, frames, pending
                    # Each frame is encoded once its successor's time is known, so durations are exact.
                    if pending is not None:
                        flush(*pending)
                    pending = (image, clock_ms, duration)
                    clock_ms += duration
                    frames += 1
                    if frames > MAX_FRAMES:
                        raise ValueError("render_limit")

                def flush(image: Image.Image, at: int, duration: int) -> None:
                    frame = av.VideoFrame.from_image(image).reformat(format="yuv420p")
                    frame.pts, frame.time_base = at, Fraction(1, 1000)
                    for packet in stream.encode(frame):
                        packet.duration = packet.duration or duration
                        target.mux(packet)

                gate_lines = [f"{item['gate']['name']}: gate revision {item['gate']['revision']}, review revision {item['review_revision']}, "
                              f"reviewer state {item['layers']['reviewer']['state']}" for item in gates] or ["No active gates"]
                emit(overlay.card(size, ["Bat Innovation - " + ("highlights" if highlights else "overlay") + " video", f"Export {payload['render_id']}",
                                         f"Video: {json.loads(segment['metadata_json']).get('filename', segment['id'])}",
                                         f"Tracking run {run_id} ({payload['algorithm_version']}, settings {payload['parameter_hash'][:12]})",
                                         *gate_lines, "Tracks and counts are candidates for review, not verified animals."]), TITLE_MS)
                skip_start = skip_end = None
                previous_pts = previous_ticks = None
                for decoded in media.decoded_frames(container, video):
                    if (decoded.width, decoded.height) != (metadata["width"], metadata["height"]):
                        raise ValueError("unsupported_codec")
                    pts = int(decoded.pts)
                    if previous_pts is not None and pts <= previous_pts:
                        raise ValueError("unknown_timing")
                    duration = round(float(decoded.duration * base) * 1000) if decoded.duration else None
                    interval = round(float((pts - previous_pts) * base) * 1000) if previous_pts is not None else None
                    # The frame's own length in source ticks (or the last interval) closes a span skipped to the end.
                    length = int(decoded.duration) if decoded.duration else previous_ticks if previous_ticks else 0
                    previous_ticks = pts - previous_pts if previous_pts is not None else None
                    previous_pts = pts
                    kept += 1
                    if kept % 25 == 0:
                        progress.write_text(f"{min(kept, expected)}/{expected}")
                    if keep is not None and not any(start <= pts <= end for start, end in keep):
                        skip_start = pts if skip_start is None else skip_start
                        skip_end = pts + length
                        continue
                    if skip_start is not None:
                        skipped.append(_skip(skip_start, pts, base))
                        emit(overlay.card(size, [f"Skipped {_mmss(skipped[-1]['seconds'])} with no tracker output", "not verified absence"]), CARD_MS)
                        skip_start = None
                    image = decoded.to_image().convert("RGB").resize(size)
                    overlay.draw(image, size[0] / metadata["width"], pts, ticks, tracks, gates, order, segment["id"],
                                 clock_text(anchor, segment["id"], metadata, pts, base))
                    digest.update(str(pts).encode() + b",")
                    drawn += 1
                    emit(image, max(1, duration or interval or 40))
                if kept == 0:
                    raise ValueError("decode_failed")
                if skip_start is not None:
                    # Skipped through the end: the span runs to the end of the last frame.
                    skipped.append(_skip(skip_start, skip_end, base))
                    emit(overlay.card(size, [f"Skipped {_mmss(skipped[-1]['seconds'])} with no tracker output to the end", "not verified absence"]), CARD_MS)
                flush(*pending)
                for packet in stream.encode():
                    target.mux(packet)
    except (av.error.DecoderNotFoundError, av.error.EncoderNotFoundError):
        raise ValueError("unsupported_codec") from None
    except av.error.FFmpegError:
        raise ValueError("decode_failed") from None
    if output.stat().st_size > MAX_RENDER_BYTES:
        raise ValueError("render_limit")
    sha = hashlib.sha256()
    with output.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            sha.update(block)
    return {"frames": frames, "source_frames": kept, "drawn_source_frames": drawn,
            "bytes": output.stat().st_size, "sha256": sha.hexdigest(), "duration_ms": clock_ms, "width": size[0], "height": size[1],
            "drawn_pts_sha256": digest.hexdigest(), "skipped": skipped,
            "gates": [{"gate_id": item["gate"]["id"], "gate_revision": item["gate"]["revision"], "review_revision": item["review_revision"]} for item in gates]}


def _skip(start: int, end: int, base: Fraction) -> dict:
    return {"from_pts": str(start), "to_pts": str(end), "seconds": round(float((end - start) * base), 3)}


def _mmss(seconds: float) -> str:
    return f"{int(seconds // 60):02d}:{seconds % 60:06.3f}"


def main() -> None:
    result: dict = {"error": None, "value": None}
    try:
        raw = workers.read_request(MAX_REQUEST_BYTES)
        if len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("render_limit")
        payload = json.loads(raw)
        limits(payload["parent_pid"], int(payload["cpu_seconds"]))
        os.environ["OMP_NUM_THREADS"] = "1"
        result["value"] = render(payload)
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error) in ERRORS else getattr(error, "code", None)
        code = code if code in ERRORS else None
        if isinstance(error, FileNotFoundError):
            code = "missing_source"
        elif isinstance(error, PermissionError):
            code = "unreadable_source"
        elif isinstance(error, (MemoryError, OSError)) and code is None:
            code = "render_limit" if isinstance(error, MemoryError) or getattr(error, "errno", None) == 27 else None
        result = {"error": code or "render_failed", "value": None}
    workers.write_response(json.dumps(result))


if __name__ == "__main__":
    main()
