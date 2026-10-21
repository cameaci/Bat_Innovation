"""Disposable-worker media inspection: one source, one contained process, one validated JSON result.

The backend remains the only SQLite writer. The worker receives a bounded request file, inspects the
original read-only through backend.app.media, and serializes one size-checked response file. These
logical JSON limits are not a scratch/disk capacity boundary. Windows media
import is still rejected by the ImportJobs platform guard, so no application request reaches this
path until separate native-media and scratch-capacity acceptance passes.
"""

from __future__ import annotations

import json
from fractions import Fraction
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from collections.abc import Callable, Sequence
from typing import Any

MAX_REQUEST_BYTES = 16 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
RESPONSE_KEYS = {
    "filename", "size_bytes", "sha256", "container", "streams", "video_stream_index", "codec", "width", "height",
    "time_base", "first_pts", "last_pts", "first_time", "last_time", "elapsed_last_time", "end_time", "elapsed_end",
    "frame_count", "reported_duration", "average_rate", "base_rate", "rotation", "field_order", "interlaced",
    "warnings", "_identity",
}
IDENTITY_KEYS = {"device", "inode", "size_bytes", "mtime_ns", "ctime_ns"}
ERROR_MESSAGES = {
    "cancelled": "Source inspection was cancelled. No media was imported.",
    "changed_source": "The source changed during inspection. No sources were added; select the originals again.",
    "decode_failed": "The video could not be fully decoded. Check that the source is complete and uncorrupted.",
    "missing_source": "The source file is missing. Locate the original and retry.",
    "unknown_timing": "Source presentation times are invalid. No timeline was invented.",
    "unreadable_metadata": "The source cannot be read. Check the recording and local file permissions.",
    "unsupported_codec": "The source container or codec is unsupported by this local decoder.",
}
# Provisional budgets, not measured on real media: Windows import stays disabled until they are validated.
IMPORT_MEMORY_BYTES, IMPORT_CPU_SECONDS, IMPORT_WALL_SECONDS = 1024 ** 3, 1800, 3600


class Rejected(Exception):
    """A malformed or oversize worker response."""


def _rational(value: Any, nullable: bool = False) -> Fraction | None:
    if value is None and nullable:
        return
    if not (isinstance(value, dict) and set(value) == {"num", "den"}
            and all(isinstance(value[k], str) and re.fullmatch(r"-?[0-9]{1,40}", value[k]) for k in value)
            and int(value["den"]) > 0):
        raise Rejected
    return Fraction(int(value["num"]), int(value["den"]))


def validate_inspection(path: Path, result: Any) -> dict[str, Any]:
    """Accept only the exact metadata shape Linux import commits, bound to the requested filename."""
    if not isinstance(result, dict) or set(result) != RESPONSE_KEYS or result["filename"] != path.name:
        raise Rejected
    identity = result["_identity"]
    if not (isinstance(identity, dict) and set(identity) == IDENTITY_KEYS
            and all(type(v) is int for v in identity.values())):
        raise Rejected
    if (type(result["size_bytes"]) is not int or result["size_bytes"] <= 0
            or result["size_bytes"] != identity["size_bytes"]):
        raise Rejected
    if not (isinstance(result["sha256"], str) and re.fullmatch(r"[0-9a-f]{64}", result["sha256"])):
        raise Rejected
    for key in ("first_pts", "last_pts"):
        if not (isinstance(result[key], str) and re.fullmatch(r"-?[0-9]{1,20}", result[key])
                and -(2 ** 63) <= int(result[key]) < 2 ** 63):
            raise Rejected
    time_base = _rational(result["time_base"])
    first, last = int(result["first_pts"]), int(result["last_pts"])
    if time_base <= 0 or last < first:
        raise Rejected
    if (_rational(result["first_time"]) != first * time_base
            or _rational(result["last_time"]) != last * time_base
            or _rational(result["elapsed_last_time"]) != (last - first) * time_base):
        raise Rejected
    end = _rational(result["end_time"], nullable=True)
    if ((end is not None and end <= last * time_base)
            or _rational(result["elapsed_end"], nullable=True) != (end - first * time_base if end is not None else None)):
        raise Rejected
    for key in ("reported_duration", "average_rate", "base_rate"):
        _rational(result[key], nullable=True)
    if not all(type(result[k]) is int and result[k] > 0 for k in ("width", "height", "frame_count")):
        raise Rejected
    if (result["frame_count"] == 1) != (first == last):
        raise Rejected
    if (result["container"] not in ("mp4", "mov,mp4,m4a,3gp,3g2,mj2", "mpegts")
            or type(result["video_stream_index"]) is not int or result["video_stream_index"] < 0
            or not isinstance(result["codec"], str) or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,128}", result["codec"])
            or (result["rotation"] is not None and type(result["rotation"]) is not int)
            or result["field_order"] is not None):
        raise Rejected
    if not (isinstance(result["streams"], list) and isinstance(result["warnings"], list)
            and all(isinstance(w, str) for w in result["warnings"]) and isinstance(result["interlaced"], bool)):
        raise Rejected
    indices, videos = set(), []
    for stream in result["streams"]:
        if (not isinstance(stream, dict) or set(stream) != {"index", "type", "codec", "time_base"}
                or type(stream["index"]) is not int or stream["index"] < 0 or stream["index"] in indices
                or stream["type"] not in ("video", "audio", "data", "subtitle", "attachment", "unknown")
                or (stream["codec"] is not None and (not isinstance(stream["codec"], str)
                    or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,128}", stream["codec"])))):
            raise Rejected
        indices.add(stream["index"])
        _rational(stream["time_base"], nullable=True)
        if stream["type"] == "video":
            videos.append(stream)
    if (len(videos) != 1 or videos[0]["index"] != result["video_stream_index"]
            or videos[0]["codec"] != result["codec"] or _rational(videos[0]["time_base"]) != time_base):
        raise Rejected
    return result


def _no_constants(_: str) -> None:
    raise Rejected


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = dict(pairs)
    if len(result) != len(pairs):
        raise Rejected
    return result


def _write_bounded(path: Path, body: Any, limit: int) -> None:
    data = bytearray()
    for chunk in json.JSONEncoder(allow_nan=False).iterencode(body):
        encoded = chunk.encode("utf-8")
        if len(data) + len(encoded) > limit:
            raise Rejected
        data.extend(encoded)
    path.write_bytes(data)


def _read_bounded(path: Path, limit: int) -> bytes:
    if not stat.S_ISREG(path.lstat().st_mode):
        raise Rejected
    with path.open("rb") as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise Rejected
    return data


def default_command(scratch: Path) -> list[str]:
    return [sys.executable, "-m", "backend.app.contained_import", str(scratch)]


def inspect_source(path: Path, progress: Callable[[str, int], None], cancelled: Callable[[], bool],
                   command: Callable[[Path], Sequence[str]] = default_command) -> dict[str, Any]:
    """Inspect an original in a contained worker and return validated metadata, or raise MediaError."""
    from . import media, winjob

    limits = winjob.Limits(IMPORT_MEMORY_BYTES, IMPORT_CPU_SECONDS, 1, IMPORT_WALL_SECONDS)
    failed = media.MediaError("import_failed", "Import failed. No sources were added. Check source access and retry.")
    if cancelled():
        raise media.MediaError("cancelled", "Source inspection was cancelled. No media was imported.")
    progress("inspecting", 0)
    with tempfile.TemporaryDirectory(prefix="bat-import-") as private:
        scratch = Path(private)
        try:
            _write_bounded(scratch / "request.json", {"source_path": str(path)}, MAX_REQUEST_BYTES)
            outcome = winjob.run(command(scratch), Path(__file__).resolve().parents[2], limits, cancelled)
        except (winjob.ContainmentError, OSError, ValueError, Rejected):
            raise failed from None
        if outcome.state == "cancelled" or cancelled():
            raise media.MediaError("cancelled", "Source inspection was cancelled. No media was imported.")
        if outcome.state == "deadline":
            raise media.MediaError("import_timeout", "Inspection exceeded its time budget. No sources were added.")
        if outcome.state != "exited":
            raise failed
        try:
            body = json.loads(_read_bounded(scratch / "response.json", MAX_RESPONSE_BYTES),
                              parse_constant=_no_constants, object_pairs_hook=_unique_object)
            if outcome.exit_code == 0 and isinstance(body, dict) and set(body) == {"ok"}:
                result = validate_inspection(path, body["ok"])
                progress("inspecting", 100)
                return result
            error = body.get("error") if isinstance(body, dict) and set(body) == {"error"} else None
            if outcome.exit_code == 2 and isinstance(error, dict) and set(error) == {"code", "message"} \
                    and isinstance(error["code"], str) and error["code"] in ERROR_MESSAGES \
                    and isinstance(error["message"], str) and len(error["message"]) <= 300:
                raise media.MediaError(error["code"], ERROR_MESSAGES[error["code"]])
        except (OSError, ValueError, RecursionError, Rejected):
            pass
        raise failed


def _worker(scratch: Path) -> int:
    request = json.loads(_read_bounded(scratch / "request.json", MAX_REQUEST_BYTES))
    if not (isinstance(request, dict) and set(request) == {"source_path"} and isinstance(request["source_path"], str)):
        return 3
    from . import media

    try:
        body, code = {"ok": media.inspect_source(Path(request["source_path"]))}, 0
    except media.MediaError as error:
        body, code = {"error": {"code": error.code, "message": error.message}}, 2
    temporary = scratch / "response.tmp"
    _write_bounded(temporary, body, MAX_RESPONSE_BYTES)
    os.replace(temporary, scratch / "response.json")
    return code


if __name__ == "__main__":
    raise SystemExit(_worker(Path(sys.argv[1])) if len(sys.argv) == 2 else 3)
