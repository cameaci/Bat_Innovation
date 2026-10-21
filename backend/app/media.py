"""Read-only source identity and exact decoded presentation-time inspection."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from fractions import Fraction
import hashlib
import os
from pathlib import Path
import stat
from typing import Any, BinaryIO

import av


class MediaError(Exception):
    """An actionable media failure safe to show without disclosing source paths."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


Progress = Callable[[str, int], None]
Cancelled = Callable[[], bool]


def _no_progress(phase: str, amount: int) -> None:
    pass


def _not_cancelled() -> bool:
    return False


def _check_cancelled(cancelled: Cancelled) -> None:
    if cancelled():
        raise MediaError("cancelled", "Source inspection was cancelled. No media was imported.")


def _identity(status: os.stat_result) -> dict[str, int]:
    if not stat.S_ISREG(status.st_mode):
        raise MediaError("missing_source", "Select an existing regular source video file.")
    # On Windows, fstat().st_ctime is not stable against stat(); birthtime is.
    ctime_ns = getattr(status, "st_birthtime_ns", status.st_ctime_ns)
    return {"device": status.st_dev, "inode": status.st_ino, "size_bytes": status.st_size,
            "mtime_ns": status.st_mtime_ns, "ctime_ns": ctime_ns}


def identity_info(path: Path) -> dict[str, int]:
    """Private filesystem identity; it must never be returned to the renderer."""
    try:
        return _identity(path.stat())
    except FileNotFoundError:
        raise MediaError("missing_source", "The source file is missing. Locate the original and retry.") from None
    except OSError:
        raise MediaError("unreadable_metadata", "The source file cannot be read. Check local file permissions.") from None


def _hash_file(source: BinaryIO, progress: Progress, cancelled: Cancelled) -> str:
    digest = hashlib.sha256()
    amount = 0
    progress("hashing", amount)
    while True:
        _check_cancelled(cancelled)
        block = source.read(1024 * 1024)
        if not block:
            break
        digest.update(block)
        amount += len(block)
        progress("hashing", amount)
    return digest.hexdigest()


def file_sha256(path: Path, progress: Progress = _no_progress,
                cancelled: Cancelled = _not_cancelled) -> str:
    """Hash with bounded memory and detect replacement or mutation during hashing."""
    before = identity_info(path)
    try:
        with path.open("rb") as source:
            if _identity(os.fstat(source.fileno())) != before:
                raise MediaError("changed_source", "The source changed. Select the original again.")
            result = _hash_file(source, progress, cancelled)
            if _identity(os.fstat(source.fileno())) != before or identity_info(path) != before:
                raise MediaError("changed_source", "The source changed while hashing. Import was stopped.")
            return result
    except FileNotFoundError:
        raise MediaError("missing_source", "The source file is missing. Locate the original and retry.") from None
    except OSError:
        raise MediaError("unreadable_metadata", "The source file cannot be read. Check local file permissions.") from None


def _rational(value: Fraction | None) -> dict[str, str] | None:
    if value is None:
        return None
    return {"num": str(value.numerator), "den": str(value.denominator)}


def decoded_frames(container: av.container.InputContainer, stream: av.video.stream.VideoStream,
                   cancelled: Cancelled = _not_cancelled) -> Iterator[av.VideoFrame]:
    """One authoritative decoder yields pixels and PTS together, one frame at a time."""
    previous: Fraction | None = None
    for frame in container.decode(stream):
        _check_cancelled(cancelled)
        if frame.is_corrupt:
            raise MediaError("decode_failed", "A corrupt video frame was found. Check or replace the source.")
        if frame.pts is None or frame.time_base is None or frame.time_base <= 0:
            raise MediaError("unknown_timing", "Decoded frames lack valid source PTS. No timeline was invented.")
        timestamp = frame.pts * frame.time_base
        if previous is not None and timestamp <= previous:
            raise MediaError("unknown_timing", "Source presentation times are not strictly increasing. Import was stopped.")
        previous = timestamp
        yield frame
    _check_cancelled(cancelled)


def _inspect_open_source(source: BinaryIO, source_format: str,
                         progress: Progress, cancelled: Cancelled) -> dict[str, Any]:
    try:
        container = av.open(source, mode="r", format=source_format, options={
            "protocol_whitelist": "file,pipe", "format_whitelist": "mov,mpegts", "err_detect": "explode",
            "enable_drefs": "0", "use_absolute_path": "0",
        })
    except av.error.DecoderNotFoundError:
        raise MediaError("unsupported_codec", "A decoder is unavailable. Install a compatible local PyAV build.") from None
    except av.error.FFmpegError:
        raise MediaError("unreadable_metadata", "Cannot read MP4 or MPEG-TS metadata. Check that the source is valid and complete.") from None

    with container:
        if container.format.name not in {"mp4", "mov,mp4,m4a,3gp,3g2,mj2", "mpegts"}:
            raise MediaError("unsupported_codec", "Only MP4 and MPEG-TS source containers are supported in this slice.")
        if len(container.streams.video) != 1:
            raise MediaError("unsupported_codec", "Select a recording with exactly one video stream.")
        stream = container.streams.video[0]
        if stream.time_base is None or stream.time_base <= 0:
            raise MediaError("unknown_timing", "The video stream has no valid timebase. Import was stopped.")
        time_base = Fraction(stream.time_base)
        try:
            context = stream.codec_context
            codec = context.codec if context is not None else None
        except (av.error.DecoderNotFoundError, ValueError):
            raise MediaError("unsupported_codec", "The video codec has no available local decoder.") from None
        if codec is None or not codec.is_decoder:
            raise MediaError("unsupported_codec", "The video codec has no available local decoder.")
        stream_metadata = [{"index": item.index, "type": item.type,
                            "codec": item.codec_context.name if item.codec_context else None,
                            "time_base": _rational(item.time_base)} for item in container.streams]
        reported_duration = (stream.duration * time_base if stream.duration is not None else
                             Fraction(container.duration, av.time_base) if container.duration is not None else None)
        first_pts: int | None = None
        last_pts = 0
        last_duration = 0
        frame_count = 0
        width = height = 0
        rotation: int | None = None
        interlaced = False
        warnings = ["Original recording speed is unverified.", "No original-clock anchor is inferred from media metadata."]
        try:
            for frame in decoded_frames(container, stream, cancelled):
                if frame.time_base != time_base:
                    raise MediaError("unknown_timing", "Decoded frame and stream timebases differ. Import was stopped.")
                if first_pts is None:
                    first_pts = frame.pts
                    width, height = frame.width, frame.height
                    rotation = frame.rotation
                if (frame.width, frame.height) != (width, height):
                    raise MediaError("unsupported_codec", "Changing video dimensions are unsupported. The source was not imported.")
                if frame.rotation != rotation and "Video rotation changes within the source." not in warnings:
                    warnings.append("Video rotation changes within the source.")
                interlaced = interlaced or frame.interlaced_frame
                last_pts = frame.pts
                last_duration = frame.duration or 0
                frame_count += 1
                if frame_count == 1 or frame_count % 100 == 0:
                    progress("decoding", frame_count)
        except av.error.DecoderNotFoundError:
            raise MediaError("unsupported_codec", "The source codec is unavailable in this local PyAV build.") from None
        except av.error.FFmpegError:
            raise MediaError("decode_failed", "The video could not be fully decoded. Check that the source is complete and uncorrupted.") from None
        if first_pts is None:
            raise MediaError("decode_failed", "No decodable video frames were found. Check the source recording.")
        progress("decoding", frame_count)
        first_time = first_pts * time_base
        last_time = last_pts * time_base
        end_time = (last_pts + last_duration) * time_base if last_duration > 0 else None
        if end_time is None:
            warnings.append("The final decoded frame has no duration; the source end is unknown.")
        if interlaced:
            warnings.append("Interlaced frames detected; field order is unknown in this decoder API.")
        if reported_duration is None:
            warnings.append("The container and stream do not report a duration.")
        return {
            "container": container.format.name, "streams": stream_metadata,
            "video_stream_index": stream.index, "codec": context.name, "width": width, "height": height,
            "time_base": _rational(time_base), "first_pts": str(first_pts), "last_pts": str(last_pts),
            "first_time": _rational(first_time), "last_time": _rational(last_time),
            "elapsed_last_time": _rational(last_time - first_time), "end_time": _rational(end_time),
            "elapsed_end": _rational(end_time - first_time if end_time is not None else None),
            "frame_count": frame_count, "reported_duration": _rational(reported_duration),
            "average_rate": _rational(stream.average_rate), "base_rate": _rational(stream.base_rate),
            "rotation": rotation, "field_order": None, "interlaced": interlaced, "warnings": warnings,
        }


def inspect_source(path: Path, progress: Progress = _no_progress,
                   cancelled: Cancelled = _not_cancelled) -> dict[str, Any]:
    """Hash and decode an original read-only; nothing from the source is modified."""
    _check_cancelled(cancelled)
    if path.suffix.lower() not in {".mp4", ".mts"}:
        raise MediaError("unsupported_codec", "Select an MP4 or MTS recording. Other formats are unsupported in this slice.")
    before = identity_info(path)
    try:
        with path.open("rb") as source:
            if _identity(os.fstat(source.fileno())) != before:
                raise MediaError("changed_source", "The source changed. Select the original again.")
            digest = _hash_file(source, progress, cancelled)
            if _identity(os.fstat(source.fileno())) != before or identity_info(path) != before:
                raise MediaError("changed_source", "The source changed while hashing. Import was stopped.")
            source.seek(0)
            metadata = _inspect_open_source(source, "mp4" if path.suffix.lower() == ".mp4" else "mpegts",
                                            progress, cancelled)
            if _identity(os.fstat(source.fileno())) != before or identity_info(path) != before:
                raise MediaError("changed_source", "The source changed during decoding. Import was stopped.")
    except FileNotFoundError:
        raise MediaError("missing_source", "The source file is missing. Locate the original and retry.") from None
    except OSError:
        raise MediaError("unreadable_metadata", "The source file cannot be read. Check local file permissions.") from None
    _check_cancelled(cancelled)
    return {"filename": path.name, "size_bytes": before["size_bytes"], "sha256": digest,
            **metadata, "_identity": before}
