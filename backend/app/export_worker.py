"""Short-lived Linux-bounded non-media worker for a read-only export snapshot."""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import errno
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import sqlite3
import time
from uuid import UUID


def limits(parent_pid: int) -> None:
    if sys.platform != "linux":
        raise RuntimeError("export_limits_unavailable")
    import ctypes
    import resource
    if ctypes.CDLL(None, use_errno=True).prctl(1, 9, 0, 0, 0) != 0 or os.getppid() != parent_pid:
        raise RuntimeError("export_limits_unavailable")
    for kind, amount in ((resource.RLIMIT_AS, 1024 ** 3), (resource.RLIMIT_CPU, 15),
                         (resource.RLIMIT_FSIZE, 64 * 1024 * 1024), (resource.RLIMIT_CORE, 0)):
        _, hard = resource.getrlimit(kind)
        bound = amount if hard == resource.RLIM_INFINITY else min(amount, hard)
        resource.setrlimit(kind, (bound, bound))


def evidence_version(database: Path, run_id: str, check) -> str:
    from .csv_export import readonly
    digest = sha256()
    with closing(readonly(database)) as connection:
        connection.execute("BEGIN")
        row = connection.execute("SELECT state,parameter_hash,source_snapshots_json,expected_windows FROM processing_run WHERE id=?", (run_id,)).fetchone()
        digest.update(json.dumps(tuple(row) if row else None).encode())
        cursor = connection.execute("SELECT * FROM summary_window WHERE run_id=? ORDER BY segment_id,window_index,id", (run_id,))
        while rows := cursor.fetchmany(128):
            check()
            for row in rows:
                digest.update(json.dumps(tuple(row)).encode())
    return digest.hexdigest()


def render(data_dir: Path, job_id: str, run_id: str) -> dict:
    from .csv_export import (ExportFailure, FILES, MAX_MANIFEST_BYTES, MAX_SECONDS,
                             export_rows, snapshot)
    begin = time.monotonic()
    def check() -> None:
        if time.monotonic() - begin > MAX_SECONDS:
            raise ExportFailure("export_too_large")
    root = data_dir / "exports"
    stage, target = root / f".{job_id}.part", root / job_id
    if root.is_symlink() or stage.exists() or target.exists():
        raise ExportFailure("export_write_failed")
    stage.mkdir(mode=0o700)
    database = stage / "snapshot.sqlite3"
    as_of = snapshot(data_dir / "bat_innovation.sqlite3", database, check)
    os.chmod(database, 0o400)
    version = evidence_version(database, run_id, check)
    manifest = export_rows(database, data_dir, run_id, stage, as_of, check)
    # Human review/QA writes may continue: their old immutable revisions belong
    # to this snapshot. Changed evidence epochs/coverage cannot be mixed with it.
    if version != evidence_version(data_dir / "bat_innovation.sqlite3", run_id, check):
        raise ExportFailure("export_stale")
    manifest["evidence_checked_at_utc"] = datetime.now(timezone.utc).isoformat()
    manifest["evidence_policy"] = "Read-only filesystem checks before/after rows; live evidence/coverage versions must still match. Review/QA values are as-of the DB snapshot, not live approval."
    encoded = json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8")
    if len(encoded) > MAX_MANIFEST_BYTES:
        raise ExportFailure("export_too_large")
    with (stage / FILES["manifest"]).open("xb") as handle:
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    database.unlink()
    directory = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    check()
    if target.exists():
        raise ExportFailure("export_write_failed")
    os.rename(stage, target)
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return {**manifest, "files": {**manifest["files"], "manifest": {"name": FILES["manifest"], "bytes": len(encoded), "sha256": sha256(encoded).hexdigest()}}}


def main() -> None:
    try:
        data_dir, job_id, run_id, parent_pid = sys.argv[1:]
        limits(int(parent_pid))
        if str(UUID(job_id)) != job_id or str(UUID(run_id)) != run_id or not Path(data_dir).is_absolute():
            raise ValueError("Invalid trusted export request")
        result = {"ok": True, "value": render(Path(data_dir), job_id, run_id)}
    except Exception as error:
        code = getattr(error, "code", None)
        if isinstance(error, MemoryError) or isinstance(error, OSError) and error.errno in {errno.ENOMEM, errno.EFBIG}:
            code = "export_too_large"
        if isinstance(error, sqlite3.OperationalError) and any(word in str(error).lower() for word in ("locked", "busy")):
            code = "export_busy"
        if code not in {"export_too_large", "export_busy", "export_stale", "export_missing", "export_schema_required", "export_write_failed", "export_limits_unavailable"}:
            code = str(error) if str(error) == "export_limits_unavailable" else "export_write_failed" if isinstance(error, OSError) else "export_stale"
        result = {"ok": False, "code": code}
    print(json.dumps(result, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
