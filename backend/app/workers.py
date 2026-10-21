"""Worker launch and transport shared by import, preview, summary and export (Linux and native Windows).

Linux workers keep their stdin/stdout pipes and rlimits. A Windows worker runs inside a Job Object
(backend.app.winjob) and exchanges one size-bounded request file and one response file through a
private scratch directory. A frozen build re-enters its own executable with --worker <module>.
Job Objects bound memory, CPU and process count, not disk: logical output budgets stay in each worker.
"""

from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

MODULES = frozenset({"contained_import", "preview_worker", "summary_worker", "export_worker"})
# Windows NTSTATUS exit codes that mean a Job Object limit ended the worker.
JOB_CPU_QUOTA_EXIT, NO_MEMORY_EXIT = 0xC0000044, 0xC0000017
FROZEN = bool(getattr(sys, "frozen", False))


class Rejected(Exception):
    """A malformed or oversize worker request or response."""


class WorkerFailed(Exception):
    """The contained worker could not run or answer. Carries no native error text or path."""


def supported() -> bool:
    return sys.platform in {"linux", "win32"}


def command(module: str) -> list[str]:
    if module not in MODULES:
        raise ValueError("Unknown worker module")
    return [sys.executable, "--worker", module] if FROZEN else [sys.executable, "-m", f"backend.app.{module}"]


def working_directory() -> Path:
    return Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parents[2]


def is_link(path: Path) -> bool:
    """A symbolic link, or on Windows a junction: never followed inside managed storage."""
    return path.is_symlink() or path.is_junction()


def owned_by_user(info: os.stat_result) -> bool:
    """Linux checks the owner id. Windows has no uid; managed storage is per-user LocalAppData and reparse points are refused."""
    return sys.platform == "win32" or info.st_uid == os.getuid()


def no_constants(_: str) -> None:
    raise Rejected


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = dict(pairs)
    if len(result) != len(pairs):
        raise Rejected
    return result


def write_bounded(path: Path, body: Any, limit: int) -> None:
    data = bytearray()
    for chunk in json.JSONEncoder(allow_nan=False).iterencode(body):
        encoded = chunk.encode("utf-8")
        if len(data) + len(encoded) > limit:
            raise Rejected
        data.extend(encoded)
    path.write_bytes(data)


def read_bounded(path: Path, limit: int) -> bytes:
    if not stat.S_ISREG(path.lstat().st_mode):
        raise Rejected
    with path.open("rb") as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise Rejected
    return data


def run_contained(module: str, request: dict[str, Any], limits: Any, cancelled: Callable[[], bool],
                  max_request: int, max_response: int) -> tuple[str, Any]:
    """Run one Windows worker; return ("ok", body), ("cancelled" | "limit", None) or raise WorkerFailed."""
    from . import winjob

    with tempfile.TemporaryDirectory(prefix="bat-worker-") as private:
        scratch = Path(private)
        try:
            write_bounded(scratch / "request.json", request, max_request)
            # One BLAS/OpenMP thread: per-thread buffers on a many-core machine must not eat the job memory limit.
            environment = {**winjob.worker_environment(), "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"}
            outcome = winjob.run([*command(module), str(scratch)], working_directory(), limits, cancelled, environment)
            if outcome.state == "cancelled":
                return "cancelled", None
            if outcome.state == "deadline" or outcome.exit_code in {JOB_CPU_QUOTA_EXIT, NO_MEMORY_EXIT}:
                return "limit", None
            if outcome.exit_code != 0:
                raise WorkerFailed
            body = json.loads(read_bounded(scratch / "response.json", max_response),
                              parse_constant=no_constants, object_pairs_hook=unique_object)
        except (winjob.ContainmentError, OSError, ValueError, Rejected, RecursionError):
            raise WorkerFailed from None
    return "ok", body


def require_limits(error: Exception) -> None:
    """Worker side on Windows: refuse to decode unless the parent's Job Object limits are in force."""
    from . import winjob

    if not winjob.enforced():
        raise error


def read_request(max_bytes: int) -> bytes:
    """Worker side: at most max_bytes + 1 bytes so the caller can reject an oversize request itself."""
    if sys.platform == "win32":
        return read_bounded(Path(sys.argv[1]) / "request.json", max_bytes + 1)
    return sys.stdin.buffer.read(max_bytes + 1)


def write_response(text: str) -> None:
    if sys.platform == "win32":
        scratch = Path(sys.argv[1])
        (scratch / "response.tmp").write_text(text, encoding="utf-8")
        os.replace(scratch / "response.tmp", scratch / "response.json")
    else:
        sys.stdout.write(text)


def open_no_follow(path: Path, flags: int, mode: int = 0o600) -> int:
    """os.open that refuses a final symbolic link or Windows reparse point (junction, mount point)."""
    if sys.platform == "win32":
        if is_link(path) or path.exists() and path.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise PermissionError("reparse point refused")
        return os.open(path, flags | os.O_BINARY, mode)
    return os.open(path, flags | os.O_NOFOLLOW, mode)


def reserve_bytes(descriptor: int, size: int) -> None:
    """Allocate real storage for size bytes (posix_fallocate on Linux, written zeros then fsync on Windows)."""
    if sys.platform == "win32":
        block = bytes(1024 * 1024)
        for _ in range(size // len(block)):
            os.write(descriptor, block)
        os.write(descriptor, bytes(size % len(block)))
    else:
        os.posix_fallocate(descriptor, 0, size)
    os.fsync(descriptor)


def sync_directory(path: Path, follow: bool = False) -> None:
    """Flush a directory entry. NTFS journals directory metadata itself, so Windows has no directory fsync."""
    if sys.platform == "win32":
        return
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | (0 if follow else os.O_NOFOLLOW))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def make_writable(path: Path) -> None:
    """Windows cannot unlink a read-only file; Linux permissions on the file do not affect unlink."""
    if sys.platform == "win32":
        os.chmod(path, stat.S_IWRITE | stat.S_IREAD)
