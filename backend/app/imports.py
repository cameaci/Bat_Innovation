"""One cancelable, bounded-memory media inspection job; only complete batches persist."""

from __future__ import annotations

import json
from pathlib import Path
from threading import Event, Lock, Thread
from uuid import uuid4

from . import media, store


class ImportErrorResponse(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        self.code, self.message, self.status = code, message, status


def selected_sources(paths: list[str], data_dir: Path) -> list[Path]:
    """Trusted main-process input still receives strict local-file validation."""
    forbidden = (Path(__file__).resolve().parents[2], data_dir.resolve())
    sources: list[Path] = []
    for raw in paths:
        candidate = Path(raw)
        if not candidate.is_absolute() or raw.startswith(("//", "\\\\")):
            raise ImportErrorResponse("invalid_sources", "Choose absolute local video files using the native picker.")
        try:
            source = candidate.resolve(strict=True)
            if not source.is_file():
                raise ImportErrorResponse("invalid_sources", "Choose regular local video files.")
        except (OSError, ValueError):
            raise ImportErrorResponse("missing_source", "A selected source is missing or unreadable. Choose it again.") from None
        if source.suffix.lower() not in (".mts", ".mp4"):
            raise ImportErrorResponse("invalid_sources", "Only original .MTS and .MP4 files are supported.")
        if any(source.is_relative_to(root) for root in forbidden):
            raise ImportErrorResponse("invalid_sources", "Original videos must remain outside the repository and application data directory.")
        if source in sources:
            raise ImportErrorResponse("duplicate_source", "The selected batch includes the same source more than once.")
        sources.append(source)
    return sources


def source_state(row: dict) -> str:
    try:
        current = media.identity_info(Path(row["source_path"]))
    except (OSError, media.MediaError):
        return "missing_source"
    return "ready" if current == json.loads(row["identity_json"]) else "changed_source"


class ImportJobs:
    def __init__(self, db_path: Path, data_dir: Path):
        self.db_path, self.data_dir = db_path, data_dir
        self._lock = Lock()
        self._jobs: dict[str, dict] = {}
        self._cancel: dict[str, Event] = {}
        self._thread: Thread | None = None
        self._closed = False

    def start(self, session_id: str, paths: list[str]) -> dict:
        sources = selected_sources(paths, self.data_dir)
        with self._lock:
            if self._closed or any(job["state"] == "running" for job in self._jobs.values()):
                raise ImportErrorResponse("import_busy", "Another import is running. Wait for it or cancel it.", 409)
            # Retain only the last eight jobs, never an unbounded history of private metadata.
            while len(self._jobs) >= 8:
                oldest = next(iter(self._jobs))
                self._jobs.pop(oldest)
                self._cancel.pop(oldest)
            job_id, cancelled = str(uuid4()), Event()
            job = {"id": job_id, "session_id": session_id, "state": "running", "phase": "queued",
                   "filename": None, "files_done": 0, "files_total": len(sources), "progress_value": 0, "error": None}
            self._jobs[job_id], self._cancel[job_id] = job, cancelled
            self._thread = Thread(target=self._run, args=(job_id, session_id, sources, cancelled), daemon=True)
            self._thread.start()
            return dict(job)

    def get(self, job_id: str) -> dict:
        with self._lock:
            if job_id not in self._jobs:
                raise ImportErrorResponse("job_missing", "This import job is no longer available.", 404)
            return dict(self._jobs[job_id])

    def active(self, session_id: str) -> dict | None:
        with self._lock:
            return next((dict(job) for job in self._jobs.values()
                         if job["session_id"] == session_id and job["state"] == "running"), None)

    def cancel(self, job_id: str) -> dict:
        with self._lock:
            if job_id not in self._jobs:
                raise ImportErrorResponse("job_missing", "This import job is no longer available.", 404)
            if self._jobs[job_id]["state"] == "running":
                self._cancel[job_id].set()
            return dict(self._jobs[job_id])

    def close(self) -> None:
        with self._lock:
            self._closed = True
            for event in self._cancel.values():
                event.set()
            thread = self._thread
        if thread is not None:
            thread.join(timeout=5)

    def _run(self, job_id: str, session_id: str, sources: list[Path], cancelled: Event) -> None:
        def progress(phase: str, value: int) -> None:
            with self._lock:
                self._jobs[job_id].update(phase=phase, progress_value=value)

        try:
            inspected: list[tuple[Path, dict]] = []
            for source in sources:
                if cancelled.is_set():
                    raise media.MediaError("cancelled", "Import cancelled. No sources were added.")
                with self._lock:
                    self._jobs[job_id].update(filename=source.name, progress_value=0)
                inspected.append((source, media.inspect_source(source, progress, cancelled.is_set)))
                with self._lock:
                    self._jobs[job_id]["files_done"] += 1
            # Verify earlier files did not change while subsequent files were inspected.
            for source, metadata in inspected:
                try:
                    identity = media.identity_info(source)
                except OSError:
                    raise media.MediaError("missing_source", "A source became unavailable during import. No sources were added; select the originals again.") from None
                if identity != metadata["_identity"]:
                    raise media.MediaError("changed_source", "A source changed during import. No sources were added; select the originals again.")
            with self._lock:
                if cancelled.is_set():
                    raise media.MediaError("cancelled", "Import cancelled. No sources were added.")
                self._jobs[job_id]["phase"] = "saving"
                try:
                    store.commit_segments(self.db_path, session_id, inspected)
                except ValueError:
                    raise media.MediaError("duplicate_source", "A selected source is already present in this session or batch. No sources were added.") from None
                self._jobs[job_id].update(state="complete", phase="complete")
        except media.MediaError as error:
            with self._lock:
                self._jobs[job_id].update(state="cancelled" if error.code == "cancelled" else "failed",
                                         phase="cancelled" if error.code == "cancelled" else "failed",
                                         error={"code": error.code, "message": error.message})
        except Exception:
            # Decoder, SQLite and OS exception text can include confidential filesystem paths.
            with self._lock:
                self._jobs[job_id].update(state="failed", phase="failed", error={
                    "code": "import_failed", "message": "Import failed. No sources were added. Check source access and retry."})
