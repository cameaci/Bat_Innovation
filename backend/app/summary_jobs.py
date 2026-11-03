"""One durable summary run, supervised outside the bounded native worker process."""

from __future__ import annotations

from _thread import LockType
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
from threading import Event, Lock, Thread
import time
from uuid import UUID

from . import store, summary_store, workers
from .summary_worker import MAX_REQUEST_BYTES
from .imports import ImportErrorResponse, source_state

WALL_SECONDS = 600
MAX_RUN_BYTES = 128 * 1024 * 1024
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_SEGMENTS = 64
MAX_RUNS_PER_SESSION = 256
MAX_RESULT_BYTES = 1024
METADATA_RESERVE_BYTES = 8 * 1024 * 1024
ERRORS = {
    "summary_busy": "Another media operation is running. Wait for it or cancel it before generating summaries.",
    "summary_missing": "The selected summary run or window does not exist.",
    "summary_upgrade_required": "Upgrade the local summary database explicitly before generating summaries.",
    "summary_no_sources": "Import original recordings before generating summaries.",
    "summary_limit": "Summary generation exceeded a configured time, memory, frame, segment, image or storage limit.",
    "summary_limits_unavailable": "Hard summary process limits are unavailable on this platform. Only Linux and Windows are supported.",
    "summary_failed": "Summary generation failed. Completed windows remain available; incomplete coverage is recorded.",
    "summary_image_missing": "The generated summary image is missing. Its original window remains in the manifest.",
    "summary_image_invalid": "The generated summary image failed its integrity check. Generate a new run to replace it.",
    "summary_not_ready": "This window has no complete summary image. Inspect its status and original recording.",
    "missing_source": "The original recording is missing. Restore it before viewing derived evidence.",
    "unreadable_source": "The original recording cannot be read. Check its local permissions and storage access.",
    "changed_source": "The original recording changed since import. Derived evidence is unavailable.",
    "unsupported_codec": "The original codec, dimensions or stream layout cannot be processed reliably.",
    "decode_failed": "The original recording could not be decoded reliably. Incomplete coverage remains explicit.",
    "unknown_timing": "Original source timestamps could not be verified. No source time was invented.",
    "unreadable_metadata": "The original metadata could not be read reliably. Check the recording before retrying.",
    "coverage_mismatch": "Decoded original PTS do not match the planned coverage. Processing stopped without claiming completeness.",
    "unknown_end": "The final-frame duration is unknown. The final source interval remains incomplete.",
    "cancelled": "Summary generation was cancelled. Completed windows were retained and unfinished coverage recorded.",
    "interrupted": "Summary generation was interrupted. Start a new run to complete its unfinished coverage.",
}


class SummaryError(ImportErrorResponse):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code, ERRORS.get(code, ERRORS["summary_failed"]), status)


def _uuid(value: str) -> bool:
    try:
        return str(UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def summary_image_path(directory: Path, row: dict) -> Path:
    if not _uuid(row["id"]) or not _uuid(row["run_id"]):
        raise SummaryError("summary_image_invalid")
    folder = directory / row["run_id"]
    candidate = folder / f"{row['id']}.png"
    if (row.get("image_path") != str(candidate) or workers.is_link(directory)
            or workers.is_link(folder) or workers.is_link(candidate)):
        raise SummaryError("summary_image_invalid")
    try:
        if not candidate.is_file():
            raise SummaryError("summary_image_missing")
        if not 0 < candidate.stat().st_size == row["image_bytes"] <= MAX_IMAGE_BYTES:
            raise SummaryError("summary_image_invalid")
    except OSError:
        raise SummaryError("summary_image_missing") from None
    return candidate


class SummaryJobs:
    def __init__(self, db_path: Path, data_dir: Path, activity_lock: LockType):
        self.db_path, self.data_dir = db_path, data_dir.absolute()
        self.directory = self.data_dir / "summaries"
        self.directory.mkdir(parents=True, exist_ok=True)
        if workers.is_link(self.directory):
            raise RuntimeError("Managed summary directory must not be a symbolic link")
        self._lock, self._activity_lock = Lock(), activity_lock
        self._run_id: str | None = None
        self._cancel = Event()
        self._thread: Thread | None = None
        self._process: subprocess.Popen | None = None
        self._closed = False
        self._release_reserve()
        summary_store.recover(self.db_path)
        self._cleanup()

    def _release_reserve(self) -> None:
        reserve = self.directory / ".manifest-reserve"
        try:
            info = reserve.lstat()
        except FileNotFoundError:
            return
        if not stat.S_ISREG(info.st_mode) or not workers.owned_by_user(info):
            raise RuntimeError("Managed metadata reserve must be a regular owned file")
        reserve.unlink()

    def _cleanup(self, run_id: str | None = None) -> None:
        """Only managed UUID names are removable; recorded historical images survive."""
        self._release_reserve()
        references = summary_store.image_references(self.db_path)
        for folder in self.directory.iterdir():
            if not _uuid(folder.name) or (run_id is not None and folder.name != run_id):
                continue
            if folder.is_symlink():
                folder.unlink()
                continue
            if not folder.is_dir():
                continue
            for path in folder.iterdir():
                if re.fullmatch(r"[0-9a-f-]{36}\.png(?:\.part)?", path.name) and str(path) not in references:
                    path.unlink(missing_ok=True)
            try:
                folder.rmdir()
            except OSError:
                # A referenced image or an unrelated file remains; never remove it.
                pass

    def _used_bytes(self) -> int:
        amount = 0
        for folder in self.directory.iterdir():
            if _uuid(folder.name) and folder.is_dir() and not workers.is_link(folder):
                for path in folder.iterdir():
                    if re.fullmatch(r"[0-9a-f-]{36}\.png(?:\.part)?", path.name):
                        if workers.is_link(path) or not path.is_file():
                            raise SummaryError("summary_image_invalid")
                        amount += path.stat().st_size
        return amount

    def _image_path(self, row: dict) -> Path:
        return summary_image_path(self.directory, row)

    def _get(self, run_id: str) -> dict:
        private = summary_store.private_run(self.db_path, run_id)
        if private is None:
            raise SummaryError("summary_missing", 404)
        states = {source["id"]: source_state(source) for source in private["sources"]}
        for row in private["windows"]:
            # A failed/incomplete window is durable processing history. Current
            # source availability is reported separately and must not erase
            # its terminal decode, cancellation or missing-frame error.
            if row["status"] != "complete":
                continue
            code = states[row["segment_id"]]
            if code == "ready":
                try:
                    self._image_path(row)
                except SummaryError as error:
                    code = error.code
            if code != "ready":
                summary_store.invalidate_window(self.db_path, row["id"], code)
        result = summary_store.get_run(self.db_path, run_id)
        for window in result["windows"]:
            window["source_state"] = states[window["segment_id"]]
            if window["status"] != "complete":
                window["image"] = None
        return result

    def get(self, run_id: str) -> dict:
        with self._lock:
            return self._get(run_id)

    def list(self, session_id: str) -> list[dict]:
        # Listing run headers must not load or revalidate every window.
        # Detailed source/image checks occur when a particular run is opened.
        with self._lock:
            return summary_store.list_runs(self.db_path, session_id)

    def start(self, session_id: str, window_seconds: int = 30) -> dict:
        if not workers.supported():
            raise SummaryError("summary_limits_unavailable")
        if store.schema_version(self.db_path) not in store.SUMMARY_SCHEMA_VERSIONS:
            raise SummaryError("summary_upgrade_required")
        with self._lock:
            if self._closed:
                raise SummaryError("summary_busy")
            if not self._activity_lock.acquire(blocking=False):
                raise SummaryError("summary_busy")
            run_id = None
            try:
                if not store.session_exists(self.db_path, session_id):
                    raise SummaryError("summary_missing", 404)
                sources = store.private_segments(self.db_path, session_id)
                if not sources:
                    raise SummaryError("summary_no_sources")
                if len(sources) > MAX_SEGMENTS:
                    raise SummaryError("summary_limit")
                if len(summary_store.list_runs(self.db_path, session_id)) >= MAX_RUNS_PER_SESSION:
                    raise SummaryError("summary_limit")
                self._cleanup()
                if (self._used_bytes() >= MAX_TOTAL_BYTES
                        or shutil.disk_usage(self.directory).free < MAX_IMAGE_BYTES + METADATA_RESERVE_BYTES):
                    raise SummaryError("summary_limit")
                # Release after reaping (or on restart) so ENOSPC image failures still
                # leave space for the durable terminal SQLite transaction.
                descriptor = workers.open_no_follow(self.directory / ".manifest-reserve",
                                                    os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                try:
                    workers.reserve_bytes(descriptor, METADATA_RESERVE_BYTES)
                finally:
                    os.close(descriptor)
                try:
                    run_id = summary_store.create_run(self.db_path, session_id, window_seconds)
                except ValueError:
                    raise SummaryError("summary_limit") from None
                source_states = {row["id"]: source_state(row) for row in sources}
                source_error = next((state for state in source_states.values() if state != "ready"), None)
                if source_error is not None:
                    self._release_reserve()
                    self._cleanup(run_id)
                    for window in summary_store.private_run(self.db_path, run_id)["windows"]:
                        state = source_states[window["segment_id"]]
                        if state != "ready":
                            summary_store.invalidate_window(self.db_path, window["id"], state)
                    summary_store.finish_run(self.db_path, run_id, "failed", source_error)
                    result = self._get(run_id)
                    self._activity_lock.release()
                    return result
                initial = summary_store.get_run(self.db_path, run_id)
                for window in initial["windows"]:
                    window["source_state"] = "ready"
                self._run_id, self._cancel = run_id, Event()
                self._thread = Thread(target=self._run, args=(run_id, self._cancel), daemon=True)
                self._thread.start()
                return initial
            except Exception as error:
                self._thread = None
                cleanup_failed = False
                try:
                    self._release_reserve()
                    if run_id is not None:
                        self._cleanup(run_id)
                        summary_store.finish_run(self.db_path, run_id, "failed", "summary_failed")
                except Exception:
                    # The persisted queued plan remains recoverable after storage
                    # is restored. No native child has started on this path.
                    cleanup_failed = True
                finally:
                    self._run_id = None
                    self._activity_lock.release()
                if cleanup_failed:
                    raise SummaryError("summary_failed", 500) from None
                if isinstance(error, SummaryError):
                    raise
                if isinstance(error, OSError) and error.errno in {27, 28, 122}:
                    raise SummaryError("summary_limit") from None
                raise SummaryError("summary_failed", 500) from None

    def image(self, window_id: str) -> bytes:
        with self._lock:
            row = summary_store.private_window(self.db_path, window_id)
            if row is None:
                raise SummaryError("summary_missing", 404)
            self._get(row["run_id"])
            row = summary_store.private_window(self.db_path, window_id)
            if row["status"] != "complete":
                raise SummaryError(row["error_code"] or "summary_not_ready")
            try:
                path = self._image_path(row)
                with path.open("rb") as source:
                    content = source.read(MAX_IMAGE_BYTES + 1)
                if (not 0 < len(content) == row["image_bytes"] <= MAX_IMAGE_BYTES
                        or not content.startswith(b"\x89PNG\r\n\x1a\n")
                        or sha256(content).hexdigest() != row["image_sha256"]):
                    raise SummaryError("summary_image_invalid")
                state = source_state(row["source"])
                if state != "ready":
                    raise SummaryError(state)
                return content
            except SummaryError as error:
                summary_store.invalidate_window(self.db_path, window_id, error.code)
                raise
            except OSError:
                summary_store.invalidate_window(self.db_path, window_id, "summary_image_missing")
                raise SummaryError("summary_image_missing") from None

    def cancel(self, run_id: str) -> dict:
        with self._lock:
            result = self._get(run_id)
            if self._run_id == run_id and result["state"] in {"queued", "running"}:
                self._cancel.set()
                process = self._process
            else:
                process = None
        if process is not None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        return self.get(run_id)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._cancel.set()
            process, thread = self._process, self._thread
        if process is not None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        if thread is not None:
            thread.join(timeout=10)
            if thread.is_alive():
                raise RuntimeError("Summary worker shutdown did not complete")

    @staticmethod
    def _contained(payload: dict, cancelled: Event) -> dict:
        """Windows: one worker in a Job Object (1 GiB, 300 CPU seconds, one process) with a parent wall deadline."""
        from . import winjob

        limits = winjob.Limits(1024 ** 3, 300, 1, WALL_SECONDS)
        try:
            status, result = workers.run_contained("summary_worker", payload, limits, cancelled.is_set,
                                                   MAX_REQUEST_BYTES, MAX_RESULT_BYTES)
        except workers.WorkerFailed:
            raise SummaryError("summary_failed") from None
        if status != "ok":
            raise SummaryError("cancelled" if status == "cancelled" else "summary_limit")
        return result

    def _run(self, run_id: str, cancelled: Event) -> None:
        process = None
        code: str | None = "summary_failed"
        try:
            if cancelled.is_set():
                raise SummaryError("cancelled")
            payload = {"parent_pid": os.getpid(), "db_path": str(self.db_path),
                       "data_dir": str(self.data_dir), "run_id": run_id}
            if sys.platform == "win32":
                result = self._contained(payload, cancelled)
            else:
                environment = {key: value for key, value in os.environ.items() if key != "BAT_API_TOKEN"}
                environment.update(OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1")
                process = subprocess.Popen(workers.command("summary_worker"),
                                           cwd=workers.working_directory(), stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=environment)
                with self._lock:
                    self._process = process
                incoming = json.dumps(payload).encode("utf-8")
                deadline = time.monotonic() + WALL_SECONDS
                while True:
                    if cancelled.is_set():
                        raise SummaryError("cancelled")
                    if time.monotonic() >= deadline:
                        raise SummaryError("summary_limit")
                    try:
                        output, _ = process.communicate(input=incoming, timeout=0.05)
                        break
                    except subprocess.TimeoutExpired:
                        incoming = None
                if cancelled.is_set():
                    raise SummaryError("cancelled")
                if process.returncode:
                    limited = process.returncode in (-signal.SIGKILL, -signal.SIGXCPU, -signal.SIGXFSZ)
                    raise SummaryError("summary_limit" if limited else "summary_failed")
                if len(output) > MAX_RESULT_BYTES:
                    raise SummaryError("summary_limit")
                result = json.loads(output)
            if set(result) != {"error"} or (result["error"] is not None and result["error"] not in ERRORS):
                raise SummaryError("summary_failed")
            code = result["error"]
        except SummaryError as error:
            code = error.code
        except Exception:
            code = "summary_failed"
        finally:
            if process is not None:
                if process.poll() is None:
                    process.kill()
                process.communicate()
            with self._lock:
                self._process = None
                try:
                    self._cleanup(run_id)
                    # Source checks are repeated after native decoding and before success.
                    self._get(run_id)
                    code = "cancelled" if cancelled.is_set() or self._closed else code
                    state = "cancelled" if code == "cancelled" else "failed" if code else "complete"
                    summary_store.finish_run(self.db_path, run_id, state, code)
                except Exception:
                    summary_store.finish_run(self.db_path, run_id, "failed", "summary_failed")
                finally:
                    # get/start share this lock: terminal state and reservation release are observed together.
                    self._activity_lock.release()
