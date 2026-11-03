"""Disposable, OS-limited worker that encodes one segment's lossy playback copy (Phase 2, W1), or its enhanced
display copy (Phase 3 X5: the same frames and frame map, drawn by `enhance.Enhancer`).

The copy is a display aid for continuous playback: VP9/WebM fitted to 960x540, timestamps in milliseconds from the
segment's first source PTS, and a sidecar mapping every copy frame back to its exact source PTS. The original is
opened read-only, re-identified by SHA-256 and never written.
"""

from __future__ import annotations

from fractions import Fraction
import json
import os
from pathlib import Path
import struct
import sys
import zlib

from . import workers

MAX_REQUEST_BYTES = 16 * 1024
MAX_PROXY_BYTES = 4 * 1024 ** 3
MAX_FRAMES = 2_000_000
MEMORY_BYTES = 1024 ** 3
FRAMES_TAG = b"prx1"
ERRORS = {"missing_source", "unreadable_source", "changed_source", "unsupported_codec", "decode_failed", "unknown_timing",
          "proxy_limit", "proxy_limits_unavailable", "proxy_failed"}


def cpu_seconds(duration_seconds: float) -> int:
    """CPU budget scales with source duration; encoding is expected to run faster than real time."""
    return int(60 + 4 * duration_seconds)


def limits(parent_pid: int, cpu: int) -> None:
    if sys.platform == "win32":
        workers.require_limits(ValueError("proxy_limits_unavailable"))
    elif sys.platform != "linux" or not workers.linux_limits(parent_pid, MEMORY_BYTES, cpu, MAX_PROXY_BYTES):
        raise ValueError("proxy_limits_unavailable")


def pack_frames(source_pts: list[int], proxy_ms: list[int]) -> bytes:
    count = len(source_pts)
    return FRAMES_TAG + zlib.compress(struct.pack(f"<I{count}q{count}q", count, *source_pts, *proxy_ms))


def unpack_frames(blob: bytes) -> tuple[list[int], list[int]]:
    if not blob.startswith(FRAMES_TAG):
        raise ValueError("proxy_integrity")
    raw = zlib.decompress(blob[len(FRAMES_TAG):])
    (count,) = struct.unpack_from("<I", raw)
    if len(raw) != 4 + 16 * count:
        raise ValueError("proxy_integrity")
    values = struct.unpack_from(f"<{2 * count}q", raw, 4)
    return list(values[:count]), list(values[count:])


def render(payload: dict) -> dict:
    import av

    from . import media, preview_worker, store

    segment = store.segment_by_id(Path(payload["db_path"]), payload["segment_id"])
    if segment is None:
        raise ValueError("missing_source")
    output, sidecar = Path(payload["output_path"]), Path(payload["frames_path"])
    source_pts: list[int] = []
    proxy_ms: list[int] = []
    try:
        with media.open_verified_source(segment) as (container, video, metadata):
            if not 0 < metadata["width"] <= 4096 or not 0 < metadata["height"] <= 2160:
                raise ValueError("proxy_limit")
            first = int(metadata["first_pts"])
            time_base = video.time_base
            enhancer = None
            if payload.get("kind") == "enhanced":
                from .enhance import Enhancer
                from .track_worker import _timing

                enhancer = Enhancer(_timing(metadata)[0])
            with av.open(str(output), "w", format="webm") as copy:
                stream = preview_worker.vp9_stream(copy, metadata["width"], metadata["height"], lossless=False, threads=2)
                durations: dict[int, int] = {}

                def mux(packets) -> None:
                    for packet in packets:
                        packet.duration = durations.pop(packet.pts)
                        copy.mux(packet)

                pending, last_duration = None, None
                for frame in media.decoded_frames(container, video):
                    if len(source_pts) >= MAX_FRAMES:
                        raise ValueError("proxy_limit")
                    if (frame.width, frame.height) != (metadata["width"], metadata["height"]):
                        raise ValueError("unsupported_codec")
                    pts = int(frame.pts)
                    millis = round((pts - first) * time_base * 1000)
                    if source_pts and millis <= proxy_ms[-1]:
                        raise ValueError("unknown_timing")
                    if pending is not None:
                        durations[proxy_ms[-1]] = millis - proxy_ms[-1]
                        mux(stream.encode(pending))
                    # reformat() may return the decoded frame itself, so its source PTS is read before retiming.
                    if enhancer is not None:
                        grey = frame.reformat(width=stream.width, height=stream.height, format="gray").to_ndarray()
                        converted = av.VideoFrame.from_ndarray(enhancer.frame(grey), format="rgb24").reformat(format="yuv420p")
                    else:
                        converted = frame.reformat(width=stream.width, height=stream.height, format="yuv420p")
                    converted.pts, converted.time_base = millis, Fraction(1, 1000)
                    source_pts.append(pts)
                    proxy_ms.append(millis)
                    pending, last_duration = converted, frame.duration
                if pending is None:
                    raise ValueError("decode_failed")
                # The last copy frame lasts its decoded duration, or the previous frame interval when none is known.
                last = round(last_duration * time_base * 1000) if last_duration else (proxy_ms[-1] - proxy_ms[-2] if len(proxy_ms) > 1 else 0)
                if last <= 0:
                    raise ValueError("unknown_timing")
                durations[proxy_ms[-1]] = last
                mux(stream.encode(pending))
                mux(stream.encode())
    except (av.error.DecoderNotFoundError, av.error.EncoderNotFoundError):
        raise ValueError("unsupported_codec") from None
    except av.error.FFmpegError:
        raise ValueError("decode_failed") from None
    blob = pack_frames(source_pts, proxy_ms)
    sidecar.write_bytes(blob)
    size = output.stat().st_size
    if size > MAX_PROXY_BYTES:
        raise ValueError("proxy_limit")
    import hashlib

    return {"width": stream.width, "height": stream.height, "frame_count": len(source_pts), "bytes": size,
            "frames_sha256": hashlib.sha256(blob).hexdigest(), "duration_ms": proxy_ms[-1] + durations.get(proxy_ms[-1], 0)}


def main() -> None:
    result: dict = {"error": None, "value": None}
    try:
        raw = workers.read_request(MAX_REQUEST_BYTES)
        if len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("proxy_limit")
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
            code = "proxy_limit" if isinstance(error, MemoryError) or getattr(error, "errno", None) == 27 else None
        result = {"error": code or "proxy_failed", "value": None}
    workers.write_response(json.dumps(result))


if __name__ == "__main__":
    main()
