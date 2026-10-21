"""One bounded, disposable preview artifact; original paths remain backend-private."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
from threading import Event, Lock, Thread
from _thread import LockType
import time
from uuid import uuid4

from . import media, store, workers
from .imports import ImportErrorResponse, source_state
from .preview_worker import MAX_BYTES, MAX_MANIFEST_BYTES, MAX_REQUEST_BYTES

WALL_SECONDS = 25
ERRORS = {
    "missing_source": "The original source is missing. Restore it before requesting another preview.",
    "changed_source": "The original changed since import. No preview of the changed source is available.",
    "unreadable_source": "The original cannot be read. Check local file permissions and storage access.",
    "unreadable_metadata": "The original metadata cannot be read. Check the source recording.",
    "unsupported_codec": "The source codec, dimensions or stream layout cannot be previewed.",
    "decode_failed": "The source could not be decoded reliably. Check that it is complete and uncorrupted.",
    "unknown_timing": "Reliable source timing or final-frame duration is unavailable. No preview time was invented.",
    "outside_source": "Choose an original PTS between the first and last decoded frame PTS.",
    "unseekable_source": "A safe source-time seek could not be established. This source cannot be previewed.",
    "preview_limit": "Preview generation exceeded a configured time, memory, frame, dimension or output-size limit.",
    "preview_limits_unavailable": "Preview process limits are unavailable on this platform. Only Linux and Windows are supported.",
    "preview_failed": "Preview generation failed. No partial preview is available.",
    "cancelled": "Preview cancelled. Its generated files were removed.",
}


def failure(code: str, status: int = 409) -> ImportErrorResponse:
    return ImportErrorResponse(code, ERRORS.get(code, "The requested preview is unavailable."), status)


def validate_source(row: dict) -> None:
    state = source_state(row)
    if state != "ready":
        raise failure(state)


class PreviewJobs:
    def __init__(self, db_path: Path, data_dir: Path, activity_lock: LockType):
        self.db_path = db_path
        self.directory = data_dir / "previews"
        self.directory.mkdir(parents=True, exist_ok=True)
        if workers.is_link(self.directory):
            raise RuntimeError("Managed preview directory must not be a symbolic link")
        self._lock, self._activity_lock = Lock(), activity_lock
        self._jobs: dict[str, dict] = {}
        self._sources: dict[str, dict] = {}
        self._cancel: dict[str, Event] = {}
        self._thread: Thread | None = None
        self._process: subprocess.Popen | None = None
        self._closed = False
        self._cleanup()

    def _cleanup(self, job_id: str | None = None) -> None:
        for path in self.directory.iterdir():
            if re.fullmatch(r"[0-9a-f-]{36}(?:\.part)?\.webm", path.name) and (job_id is None or path.name.startswith(job_id)):
                path.unlink(missing_ok=True)

    def start(self, segment_id: str, source_pts: str) -> dict:
        if not workers.supported():
            raise failure("preview_limits_unavailable")
        row = store.segment_by_id(self.db_path, segment_id)
        if row is None:
            raise ImportErrorResponse("segment_missing", "The selected source segment does not exist.", 404)
        validate_source(row)
        metadata = json.loads(row["metadata_json"])
        if not int(metadata["first_pts"]) <= int(source_pts) <= int(metadata["last_pts"]):
            raise failure("outside_source", 400)
        if metadata["end_time"] is None:
            raise failure("unknown_timing")
        with self._lock:
            if self._closed or any(job["state"] == "running" for job in self._jobs.values()):
                raise ImportErrorResponse("preview_busy", "A preview is running. Wait for it or cancel it.", 409)
            if not self._activity_lock.acquire(blocking=False):
                raise ImportErrorResponse("import_busy", "A media import is running. Wait for it or cancel it before previewing.", 409)
            try:
                self._cleanup()
                for old in self._jobs.values():
                    if old["state"] == "ready":
                        old.update(state="failed", phase="expired", manifest=None,
                                   error={"code": "preview_missing", "message": "This preview was replaced. Request it again."})
                while len(self._jobs) >= 8:
                    oldest = next(iter(self._jobs))
                    for records in (self._jobs, self._sources, self._cancel):
                        records.pop(oldest)
                job_id, cancelled = str(uuid4()), Event()
                job = {"id": job_id, "segment_id": segment_id, "state": "running", "phase": "generating", "error": None, "manifest": None}
                self._jobs[job_id], self._sources[job_id], self._cancel[job_id] = job, row, cancelled
                self._thread = Thread(target=self._run, args=(job_id, source_pts, cancelled), daemon=True)
                self._thread.start()
            except Exception:
                # Thread.start() can fail before a native thread is launched.
                # close() must never attempt to join an unstarted Thread.
                self._thread = None
                self._activity_lock.release()
                if "job_id" in locals():
                    for records in (self._jobs, self._sources, self._cancel):
                        records.pop(job_id, None)
                raise failure("preview_failed") from None
            return dict(job)

    def _invalidate(self, job_id: str, code: str) -> None:
        self._cleanup(job_id)
        self._jobs[job_id].update(state="cancelled" if code == "cancelled" else "failed", phase=code,
                                  manifest=None, error={"code": code, "message": ERRORS.get(code, "Preview unavailable.")})

    def _get(self, job_id: str) -> dict:
        if job_id not in self._jobs:
            raise ImportErrorResponse("preview_missing", "This preview is no longer available. Request it again.", 404)
        if self._jobs[job_id]["state"] == "ready":
            try:
                validate_source(self._sources[job_id])
            except ImportErrorResponse as error:
                self._invalidate(job_id, error.code)
        return dict(self._jobs[job_id])

    def get(self, job_id: str) -> dict:
        with self._lock:
            return self._get(job_id)

    def content(self, job_id: str) -> bytes:
        with self._lock:
            job = self._get(job_id)
            if job["state"] != "ready":
                if job["error"]:
                    raise failure(job["error"]["code"])
                raise ImportErrorResponse("preview_not_ready", "Wait until preview generation is complete.", 409)
            path = self.directory / f"{job_id}.webm"
            try:
                with path.open("rb") as source:
                    content = source.read(MAX_BYTES + 1)
                if not 0 < len(content) <= MAX_BYTES:
                    raise failure("preview_limit")
                validate_source(self._sources[job_id])
                return content
            except ImportErrorResponse as error:
                self._invalidate(job_id, error.code)
                raise
            except OSError:
                self._invalidate(job_id, "preview_failed")
                raise failure("preview_failed") from None

    def cancel(self, job_id: str) -> dict:
        with self._lock:
            self._get(job_id)
            self._cancel[job_id].set()
            if self._jobs[job_id]["state"] == "ready":
                self._invalidate(job_id, "cancelled")
            process = self._process if self._jobs[job_id]["state"] == "running" else None
        if process is not None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
        return self.get(job_id)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            for event in self._cancel.values():
                event.set()
            process, thread = self._process, self._thread
        if process is not None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        if thread is not None:
            thread.join(timeout=3)
        self._cleanup()

    @staticmethod
    def _contained(payload: dict, cancelled: Event) -> dict:
        """Windows: one worker in a Job Object (1 GiB, 20 CPU seconds, one process) with a parent wall deadline."""
        from . import winjob

        limits = winjob.Limits(1024 ** 3, 20, 1, WALL_SECONDS)
        try:
            status, result = workers.run_contained("preview_worker", payload, limits, cancelled.is_set,
                                                   MAX_REQUEST_BYTES, MAX_MANIFEST_BYTES + 1024)
        except workers.WorkerFailed:
            raise failure("preview_failed") from None
        if status != "ok":
            raise failure("cancelled" if status == "cancelled" else "preview_limit")
        return result

    def _run(self, job_id: str, source_pts: str, cancelled: Event) -> None:
        process = None
        manifest = None
        code = "preview_failed"
        try:
            row = self._sources[job_id]
            partial = self.directory / f"{job_id}.part.webm"
            payload = {"parent_pid": os.getpid(), "segment_id": row["id"], "source_pts": source_pts,
                       "source_path": row["source_path"], "output_path": str(partial),
                       "identity": json.loads(row["identity_json"]), "metadata": json.loads(row["metadata_json"])}
            if cancelled.is_set():
                raise failure("cancelled")
            if sys.platform == "win32":
                result = self._contained(payload, cancelled)
            else:
                process = subprocess.Popen(workers.command("preview_worker"),
                                           cwd=workers.working_directory(), stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                           env={key: value for key, value in os.environ.items() if key != "BAT_API_TOKEN"})
                with self._lock:
                    self._process = process
                incoming = json.dumps(payload).encode()
                deadline = time.monotonic() + WALL_SECONDS
                while True:
                    if cancelled.is_set():
                        raise failure("cancelled")
                    if time.monotonic() >= deadline:
                        raise failure("preview_limit")
                    try:
                        output, _ = process.communicate(input=incoming, timeout=0.05)
                        break
                    except subprocess.TimeoutExpired:
                        incoming = None
                if cancelled.is_set():
                    raise failure("cancelled")
                if process.returncode:
                    code = "preview_limit" if process.returncode in (-signal.SIGKILL, -signal.SIGXCPU, -signal.SIGXFSZ) else "preview_failed"
                    raise failure(code)
                if len(output) > MAX_MANIFEST_BYTES + 1024:
                    raise failure("preview_limit")
                result = json.loads(output)
            if result["error"]:
                raise failure(result["error"] if result["error"] in ERRORS else "preview_failed")
            if not 0 < partial.stat().st_size <= MAX_BYTES:
                raise failure("preview_limit")
            validate_source(row)
            manifest = result["manifest"]
        except ImportErrorResponse as error:
            code = error.code
        except Exception:
            code = "preview_failed"
        finally:
            if process is not None:
                if process.poll() is None:
                    process.kill()
                process.communicate()
            with self._lock:
                self._process = None
                try:
                    if manifest is not None and not cancelled.is_set() and not self._closed:
                        validate_source(self._sources[job_id])
                        partial.replace(self.directory / f"{job_id}.webm")
                        self._jobs[job_id].update(state="ready", phase="ready", manifest=manifest)
                    else:
                        self._invalidate(job_id, "cancelled" if cancelled.is_set() else code)
                except ImportErrorResponse as error:
                    self._invalidate(job_id, error.code)
                except OSError:
                    self._invalidate(job_id, "preview_failed")
                finally:
                    # Status/start share this lock, so a terminal status never precedes reservation release.
                    self._activity_lock.release()
