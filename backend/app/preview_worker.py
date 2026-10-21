"""Isolated, resource-limited PyAV source seeking and bounded WebM encoding."""

from __future__ import annotations

from fractions import Fraction
import json
import os
from pathlib import Path
import sys

from . import workers

MAX_BYTES = 8 * 1024 * 1024
MAX_MANIFEST_BYTES = 128 * 1024
MAX_REQUEST_BYTES = 256 * 1024
MAX_FRAMES = 300
MAX_DECODED = 1000
CLIP_SECONDS = 2
PRE_ROLL_SECONDS = 2
MAX_PRE_ROLL_SECONDS = 10


def rational(value: Fraction) -> dict[str, str]:
    return {"num": str(value.numerator), "den": str(value.denominator)}


def limits(parent_pid: int) -> None:
    """Fail closed where hard process limits and a parent-death guard are unavailable."""
    if sys.platform == "win32":
        workers.require_limits(RuntimeError("preview_limits_unavailable"))
        return
    if sys.platform != "linux":
        raise RuntimeError("preview_limits_unavailable")
    import ctypes
    import resource

    if ctypes.CDLL(None, use_errno=True).prctl(1, 9, 0, 0, 0) != 0 or os.getppid() != parent_pid:
        raise RuntimeError("preview_limits_unavailable")
    for kind, amount in ((resource.RLIMIT_AS, 1024 ** 3), (resource.RLIMIT_CPU, 20),
                         (resource.RLIMIT_FSIZE, MAX_BYTES), (resource.RLIMIT_CORE, 0)):
        _, hard = resource.getrlimit(kind)
        bound = amount if hard == resource.RLIM_INFINITY else min(amount, hard)
        resource.setrlimit(kind, (bound, bound))


def render(payload: dict) -> dict:
    # Import native codecs only after the process limits and parent-death guard are in place.
    import av
    from . import media

    source_path, output_path = Path(payload["source_path"]), Path(payload["output_path"])
    expected, metadata = payload["identity"], payload["metadata"]
    requested = int(payload["source_pts"])
    time_base = Fraction(int(metadata["time_base"]["num"]), int(metadata["time_base"]["den"]))
    first, last = int(metadata["first_pts"]), int(metadata["last_pts"])

    def fail(code: str) -> None:
        raise media.MediaError(code, code)

    if source_path.suffix.lower() not in {".mp4", ".mts"}:
        fail("unsupported_codec")
    if not first <= requested <= last:
        fail("outside_source")
    if time_base <= 0 or metadata["end_time"] is None:
        fail("unknown_timing")
    if not 0 < metadata["width"] <= 4096 or not 0 < metadata["height"] <= 2160:
        fail("preview_limit")
    source_end = Fraction(int(metadata["end_time"]["num"]), int(metadata["end_time"]["den"]))
    if media.identity_info(source_path) != expected:
        fail("changed_source")
    display_base = Fraction(1, 1000)
    frames: list[dict] = []
    packet_durations: dict[int, int] = {}
    actual_time: Fraction | None = None
    clip_end: Fraction | None = None
    last_source_pts: int | None = None
    output_width = output_height = 0
    warnings = ["Derived silent VP9/WebM display preview; the unchanged original remains authoritative.",
                "Display pixels use yuv420p colour conversion; lossless VP9 encoding does not establish original-pixel fidelity.",
                "Display timing is quantized to milliseconds (at most 0.5 ms per frame); source labels use exact PTS.",
                "Original recording speed remains unverified."]
    try:
        with source_path.open("rb") as source:
            if media._identity(os.fstat(source.fileno())) != expected:
                fail("changed_source")
            with av.open(source, format="mp4" if source_path.suffix.lower() == ".mp4" else "mpegts", options={
                "protocol_whitelist": "file,pipe", "format_whitelist": "mov,mpegts", "err_detect": "explode",
                "enable_drefs": "0", "use_absolute_path": "0",
            }) as original:
                if len(original.streams.video) != 1:
                    fail("unsupported_codec")
                video = original.streams.video[0]
                if video.codec_context is None or video.time_base != time_base:
                    fail("unknown_timing")
                video.codec_context.thread_count = 1
                pre_roll = -(-Fraction(PRE_ROLL_SECONDS) // time_base)
                seek_offset = requested - int(pre_roll)
                if seek_offset < -(2 ** 63):
                    fail("outside_source")
                try:
                    original.seek(seek_offset, stream=video, backward=True, any_frame=False)
                except (av.error.FFmpegError, ValueError, OSError):
                    fail("unseekable_source")
                with av.open(str(output_path), "w", format="webm") as preview:
                    stream = preview.add_stream("libvpx-vp9")
                    scale = min(Fraction(960, metadata["width"]), Fraction(540, metadata["height"]), Fraction(1))
                    output_width = max(2, int(metadata["width"] * scale) // 2 * 2)
                    output_height = max(2, int(metadata["height"] * scale) // 2 * 2)
                    stream.width, stream.height, stream.pix_fmt = output_width, output_height, "yuv420p"
                    stream.time_base = stream.codec_context.time_base = display_base
                    stream.codec_context.thread_count = 1
                    stream.options = {"lossless": "1", "deadline": "realtime", "cpu-used": "8", "lag-in-frames": "0"}
                    if (output_width, output_height) != (metadata["width"], metadata["height"]):
                        warnings.append("Display pixels are resized to the bounded preview dimensions.")
                    if metadata.get("interlaced"):
                        warnings.append("Interlaced source pixels are displayed without deinterlacing; field-level timing is not shown.")
                    if metadata.get("rotation"):
                        warnings.append("Source rotation metadata is not applied to this display derivative.")

                    def encode(item: tuple, end: Fraction) -> None:
                        frame, pts, timestamp = item
                        nonlocal clip_end, last_source_pts
                        display_pts = round((timestamp - actual_time) / display_base)
                        end_ms = round((end - actual_time) / display_base)
                        if end_ms <= display_pts or (frames and display_pts <= frames[-1]["preview_ms"]):
                            fail("unknown_timing")
                        if len(frames) >= MAX_FRAMES:
                            fail("preview_limit")
                        frames.append({"source_pts": str(pts), "source_time": rational(timestamp),
                                       "elapsed": rational(timestamp - first * time_base), "preview_ms": display_pts})
                        packet_durations[display_pts] = end_ms - display_pts
                        converted = frame.reformat(width=output_width, height=output_height, format="yuv420p")
                        converted.pts, converted.time_base = display_pts, display_base
                        for packet in stream.encode(converted):
                            packet.duration = packet_durations[packet.pts]
                            preview.mux(packet)
                        clip_end, last_source_pts = end, pts

                    pending = None
                    decoded_count = 0
                    reached_bound = False
                    for frame in media.decoded_frames(original, video):
                        decoded_count += 1
                        if decoded_count > MAX_DECODED:
                            fail("preview_limit")
                        if frame.time_base != time_base:
                            fail("unknown_timing")
                        timestamp, pts = frame.pts * frame.time_base, frame.pts
                        if decoded_count == 1 and pts > requested:
                            fail("unseekable_source")
                        if timestamp < requested * time_base - MAX_PRE_ROLL_SECONDS:
                            fail("preview_limit")
                        if (frame.width, frame.height) != (metadata["width"], metadata["height"]):
                            fail("unsupported_codec")
                        if pts < requested:
                            continue
                        if actual_time is None:
                            actual_time = timestamp
                        deadline = actual_time + CLIP_SECONDS
                        if pending is not None:
                            encode(pending, min(timestamp, deadline, source_end))
                        if timestamp >= deadline:
                            reached_bound = True
                            break
                        pending = (frame, pts, timestamp)
                    if pending is None:
                        fail("unseekable_source")
                    if not reached_bound:
                        if pending[1] != last:
                            fail("decode_failed")
                        duration = pending[0].duration
                        if duration is None or duration <= 0:
                            fail("unknown_timing")
                        encode(pending, min(pending[2] + duration * time_base, deadline, source_end))
                    for packet in stream.encode():
                        packet.duration = packet_durations[packet.pts]
                        preview.mux(packet)
            if media._identity(os.fstat(source.fileno())) != expected or media.identity_info(source_path) != expected:
                fail("changed_source")
    except (av.error.DecoderNotFoundError, av.error.EncoderNotFoundError):
        fail("unsupported_codec")
    except av.error.FFmpegError:
        fail("decode_failed")
    if not frames or output_path.stat().st_size > MAX_BYTES:
        fail("preview_limit")
    manifest = {"segment_id": payload["segment_id"], "source_sha256": metadata["sha256"],
                "requested_pts": str(requested), "actual_pts": frames[0]["source_pts"], "time_base": rational(time_base),
                "seek_error": rational(actual_time - requested * time_base), "source_start": rational(actual_time),
                "source_last": rational(last_source_pts * time_base), "source_end": rational(clip_end),
                "elapsed_start": rational(actual_time - first * time_base),
                "elapsed_end": rational(clip_end - first * time_base),
                "preview_duration_ms": round((clip_end - actual_time) / display_base),
                "width": output_width, "height": output_height, "frames": frames, "warnings": warnings}
    if len(json.dumps(manifest).encode()) > MAX_MANIFEST_BYTES:
        fail("preview_limit")
    return manifest


def main() -> None:
    code = "preview_failed"
    try:
        raw = workers.read_request(MAX_REQUEST_BYTES)
        if len(raw) > MAX_REQUEST_BYTES:
            raise RuntimeError("preview_limit")
        payload = json.loads(raw)
        limits(payload["parent_pid"])
        result = {"manifest": render(payload), "error": None}
    except Exception as error:
        # Never print native errors, paths, input payloads or filenames.
        from .media import MediaError
        allowed = {"missing_source", "changed_source", "unreadable_metadata", "unsupported_codec", "decode_failed",
                   "unknown_timing", "outside_source", "unseekable_source", "preview_limit", "preview_limits_unavailable"}
        candidate = error.code if isinstance(error, MediaError) else str(error) if isinstance(error, RuntimeError) else code
        if isinstance(error, FileNotFoundError):
            candidate = "missing_source"
        elif isinstance(error, PermissionError):
            candidate = "unreadable_source"
        elif isinstance(error, MemoryError):
            candidate = "preview_limit"
        code = candidate if candidate in allowed | {"unreadable_source"} else code
        result = {"manifest": None, "error": code}
    workers.write_response(json.dumps(result))


if __name__ == "__main__":
    main()
