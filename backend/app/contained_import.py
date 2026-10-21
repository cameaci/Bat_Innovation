"""Disposable-worker media inspection: one source, one contained process, one validated JSON result.

The backend remains the only SQLite writer. The worker receives a bounded request file, inspects the
original read-only through backend.app.media, and writes one bounded response file. Windows media
import is still rejected by the ImportJobs platform guard, so no application request reaches this
path until separate native-media and scratch-capacity acceptance passes.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
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
SAFE_CODE = re.compile(r"[a-z_]{1,64}")
# Provisional budgets, not measured on real media: Windows import stays disabled until they are validated.
IMPORT_MEMORY_BYTES, IMPORT_CPU_SECONDS, IMPORT_WALL_SECONDS = 1024 ** 3, 1800, 3600


class Rejected(Exception):
    """A malformed or oversize worker response."""


def _rational(value: Any, nullable: bool = False) -> None:
    if value is None and nullable:
        return
    if not (isinstance(value, dict) and set(value) == {"num", "den"}
            and all(isinstance(value[k], str) and re.fullmatch(r"-?\d{1,40}", value[k]) for k in value)
            and int(value["den"]) > 0):
        raise Rejected


def validate_inspection(path: Path, result: Any) -> dict[str, Any]:
    """Accept only the exact metadata shape Linux import commits, bound to the requested filename."""
    if not isinstance(result, dict) or set(result) != RESPONSE_KEYS or result["filename"] != path.name:
        raise Rejected
    identity = result["_identity"]
    if not (isinstance(identity, dict) and set(identity) == IDENTITY_KEYS
            and all(type(v) is int for v in identity.values())):
        raise Rejected
    if type(result["size_bytes"]) is not int or result["size_bytes"] != identity["size_bytes"]:
        raise Rejected
    if not (isinstance(result["sha256"], str) and re.fullmatch(r"[0-9a-f]{64}", result["sha256"])):
        raise Rejected
    for key in ("first_pts", "last_pts"):
        if not (isinstance(result[key], str) and re.fullmatch(r"-?\d{1,20}", result[key])):
            raise Rejected
    _rational(result["time_base"])
    for key in ("first_time", "last_time", "elapsed_last_time", "end_time", "elapsed_end", "reported_duration",
                "average_rate", "base_rate"):
        _rational(result[key], nullable=True)
    if not all(type(result[k]) is int and result[k] > 0 for k in ("width", "height", "frame_count")):
        raise Rejected
    if not (isinstance(result["streams"], list) and isinstance(result["warnings"], list)
            and all(isinstance(w, str) for w in result["warnings"]) and isinstance(result["interlaced"], bool)):
        raise Rejected
    return result


def _no_constants(_: str) -> None:
    raise Rejected


def _read_bounded(path: Path, limit: int) -> bytes:
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
        (scratch / "request.json").write_text(json.dumps({"source_path": str(path)}), encoding="utf-8")
        try:
            outcome = winjob.run(command(scratch), Path(__file__).resolve().parents[2], limits, cancelled)
        except winjob.ContainmentError:
            raise failed from None
        if outcome.state == "cancelled":
            raise media.MediaError("cancelled", "Source inspection was cancelled. No media was imported.")
        if outcome.state == "deadline":
            raise media.MediaError("import_timeout", "Inspection exceeded its time budget. No sources were added.")
        try:
            body = json.loads(_read_bounded(scratch / "response.json", MAX_RESPONSE_BYTES), parse_constant=_no_constants)
            if outcome.exit_code == 0 and isinstance(body, dict) and set(body) == {"ok"}:
                progress("inspecting", 100)
                return validate_inspection(path, body["ok"])
            error = body.get("error") if isinstance(body, dict) and set(body) == {"error"} else None
            if outcome.exit_code == 2 and isinstance(error, dict) and set(error) == {"code", "message"} \
                    and isinstance(error["code"], str) and SAFE_CODE.fullmatch(error["code"]) \
                    and isinstance(error["message"], str) and len(error["message"]) <= 300:
                raise media.MediaError(error["code"], error["message"])
        except (OSError, ValueError, Rejected):
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
    temporary.write_text(json.dumps(body, allow_nan=False), encoding="utf-8")
    os.replace(temporary, scratch / "response.json")
    return code


if __name__ == "__main__":
    raise SystemExit(_worker(Path(sys.argv[1])) if len(sys.argv) == 2 else 3)
