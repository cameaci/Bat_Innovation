"""One ephemeral export bundle, with bounded process, delivery and cleanup."""

from __future__ import annotations

from contextlib import closing
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
from threading import BoundedSemaphore, Event, Lock, Thread
from uuid import UUID, uuid4

from . import store, workers
from .csv_export import FILES, MAX_CSV_BYTES, MAX_MANIFEST_BYTES, MAX_SECONDS, readonly
from .export_worker import REQUEST_BYTES
from .imports import ImportErrorResponse

ERRORS = {
    "export_busy": "Another export or this processing run is active. Wait or cancel, then retry.",
    "export_too_large": "Export exceeds a configured row, byte, CPU, memory, snapshot or time limit. No partial export was published.",
    "export_stale": "Export evidence or coverage changed or is inconsistent. Refresh and retry; no inconsistent export was published.",
    "export_write_failed": "Export could not be written or published. Check local storage and retry; incomplete files were removed.",
    "export_missing": "This export or run is unavailable. Generate the provisional export again.",
    "export_schema_required": "Explicitly upgrade to QA schema 5 before exporting provisional CSVs.",
    "export_limits_unavailable": "Safe export process limits are unavailable on this platform. Only Linux and Windows are supported.",
    "export_cancelled": "Export cancelled. Incomplete managed files were removed.",
}


class ExportError(ImportErrorResponse):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code, ERRORS.get(code, ERRORS["export_write_failed"]), status)


class ExportJobs:
    def __init__(self, database: Path, data_dir: Path):
        self.database, self.data_dir = database, data_dir
        self.directory = data_dir / "exports"
        self.directory.mkdir(mode=0o700, exist_ok=True)
        if workers.is_link(self.directory):
            raise RuntimeError("Managed exports must not be a symbolic link")
        self.lock, self.cancelled = Lock(), Event()
        self.delivery = BoundedSemaphore(1)
        self.job: dict | None = None
        self.thread: Thread | None = None
        self.process: subprocess.Popen | None = None
        self.closed = False
        self._cleanup()

    def _cleanup(self) -> None:
        for folder in self.directory.iterdir():
            name = folder.name.removeprefix('.').removesuffix('.part')
            try:
                owned = str(UUID(name)) == name
            except ValueError:
                owned = False
            if owned:
                if folder.is_symlink():
                    folder.unlink()
                elif folder.is_dir():
                    shutil.rmtree(folder)

    def start(self, run_id: str) -> dict:
        if not workers.supported():
            raise ExportError("export_limits_unavailable")
        with self.lock:
            if self.closed or self.job and self.job["state"] == "working":
                raise ExportError("export_busy")
            with closing(readonly(self.database)) as connection:
                if connection.execute("PRAGMA user_version").fetchone()[0] != store.QA_SCHEMA_VERSION:
                    raise ExportError("export_schema_required")
                run = connection.execute("SELECT state FROM processing_run WHERE id=?", (run_id,)).fetchone()
                if not run:
                    raise ExportError("export_missing", 404)
                if run[0] in {"queued", "running"}:
                    raise ExportError("export_busy")
            self._cleanup()
            self.cancelled.clear()
            self.job = {"id": str(uuid4()), "run_id": run_id, "state": "working", "error": None, "manifest": None}
            self.thread = Thread(target=self._run, args=(self.job["id"], run_id), daemon=True)
            try:
                self.thread.start()
            except BaseException:
                self.thread = None
                self.job.update(state="failed", error={"code": "export_write_failed", "message": ERRORS["export_write_failed"]})
                self._cleanup()
                raise ExportError("export_write_failed") from None
            return dict(self.job)

    def _contained(self, job_id: str, run_id: str) -> dict:
        """Windows: one worker in a Job Object (1 GiB, 15 CPU seconds, one process) with a parent wall deadline."""
        from . import winjob

        with self.lock:
            if self.closed or self.cancelled.is_set():
                raise ExportError("export_cancelled")
        limits = winjob.Limits(1024 ** 3, 15, 1, MAX_SECONDS + 2)
        try:
            status, result = workers.run_contained("export_worker", {"data_dir": str(self.data_dir), "job_id": job_id, "run_id": run_id},
                                                   limits, self.cancelled.is_set, REQUEST_BYTES, MAX_MANIFEST_BYTES * 2)
        except workers.WorkerFailed:
            raise ExportError("export_write_failed") from None
        if status != "ok":
            raise ExportError("export_cancelled" if status == "cancelled" else "export_too_large")
        return result

    def _run(self, job_id: str, run_id: str) -> None:
        manifest, code = None, None
        try:
            if sys.platform == "win32":
                result = self._contained(job_id, run_id)
            else:
                with self.lock:
                    if self.closed or self.cancelled.is_set():
                        raise ExportError("export_cancelled")
                    self.process = subprocess.Popen([*workers.command("export_worker"), str(self.data_dir), job_id, run_id, str(os.getpid())],
                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
                    process = self.process
                try:
                    output, _ = process.communicate(timeout=MAX_SECONDS + 2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                    raise ExportError("export_too_large") from None
                if len(output) > MAX_MANIFEST_BYTES * 2:
                    raise ExportError("export_too_large")
                if process.returncode:
                    raise ExportError("export_too_large" if process.returncode < 0 else "export_write_failed")
                result = json.loads(output)
            if not result["ok"]:
                raise ExportError(result["code"] if result["code"] in ERRORS else "export_write_failed")
            manifest = result["value"]
            if manifest["run_id"] != run_id or set(manifest["files"]) != set(FILES):
                raise ExportError("export_stale")
        except ExportError as error:
            code = error.code
        except Exception:
            code = "export_write_failed"
        finally:
            with self.lock:
                if self.process:
                    if self.process.poll() is None:
                        self.process.kill()
                    self.process.wait()
                self.process = None
                if self.cancelled.is_set() or self.closed:
                    code = "export_cancelled"
                if code:
                    try:
                        self._cleanup()
                    except OSError:
                        code = "export_write_failed"
                if self.job and self.job["id"] == job_id:
                    self.job.update(state="cancelled" if code == "export_cancelled" else "failed" if code else "ready",
                                    error={"code": code, "message": ERRORS[code]} if code else None, manifest=None if code else manifest)

    def get(self, job_id: str) -> dict:
        with self.lock:
            if not self.job or self.job["id"] != job_id:
                raise ExportError("export_missing", 404)
            return dict(self.job)

    def cancel(self, job_id: str) -> dict:
        with self.lock:
            if not self.job or self.job["id"] != job_id:
                raise ExportError("export_missing", 404)
            self.cancelled.set()
            if self.process and self.process.poll() is None:
                self.process.kill()
            if self.job["state"] != "working":
                self._cleanup()
                self.job.update(state="cancelled", manifest=None, error={"code": "export_cancelled", "message": ERRORS["export_cancelled"]})
            return dict(self.job)

    def content(self, job_id: str, kind: str):
        if kind not in FILES:
            raise ExportError("export_missing", 404)
        with self.lock:
            if not self.job or self.job["id"] != job_id or self.job["state"] != "ready":
                raise ExportError("export_missing", 404)
            descriptor = self.job["manifest"]["files"][kind]
            folder, path = self.directory / job_id, self.directory / job_id / FILES[kind]
            maximum = MAX_MANIFEST_BYTES if kind == "manifest" else MAX_CSV_BYTES
            handle = None
            try:
                if workers.is_link(self.directory) or workers.is_link(folder) or workers.is_link(path):
                    raise ExportError("export_stale")
                handle = os.fdopen(workers.open_no_follow(path, os.O_RDONLY), "rb")
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size == descriptor["bytes"] <= maximum:
                    raise ExportError("export_stale")
                digest = sha256()
                amount = 0
                while chunk := handle.read(65536):
                    amount += len(chunk)
                    if amount > maximum:
                        raise ExportError("export_stale")
                    digest.update(chunk)
                if digest.hexdigest() != descriptor["sha256"]:
                    raise ExportError("export_stale")
                handle.seek(0)
                if not self.delivery.acquire(blocking=False):
                    raise ExportError("export_busy")
            except (OSError, ExportError) as error:
                if handle:
                    handle.close()
                if isinstance(error, ExportError):
                    raise
                raise ExportError("export_stale") from None
        def chunks():
            try:
                left = descriptor["bytes"]
                while left > 0:
                    chunk = handle.read(min(65536, left))
                    if not chunk:
                        break
                    left -= len(chunk)
                    yield chunk
            finally:
                handle.close()
                self.delivery.release()
        return chunks(), descriptor["bytes"]

    def close(self) -> None:
        with self.lock:
            self.closed = True
            self.cancelled.set()
            if self.process and self.process.poll() is None:
                self.process.kill()
            thread = self.thread
        if thread and thread.ident is not None:
            thread.join(timeout=4)
        self._cleanup()
