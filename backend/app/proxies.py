"""Playback copy jobs and routes (Phase 2 W1): one contained worker per segment, one copy at a time.

Copies are prepared in the background next to other media work rather than under the shared activity lock, so
original previews, reviews and tracking stay available while a long survey is being copied.
"""

from __future__ import annotations

from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
from threading import Event, Lock, Thread
from uuid import UUID

from fastapi import Body, Depends, FastAPI
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict

from . import proxy_store, store, workers
from .imports import ImportErrorResponse, source_state
from .proxy_worker import ERRORS as WORKER_ERRORS, MAX_REQUEST_BYTES, MEMORY_BYTES, cpu_seconds, unpack_frames

MAX_RESULT_BYTES = 16 * 1024
# Owner decision 2026-10-24: watching the playback copy counts as review only at this speed or slower.
WATCH_MAX_RATE = 4
MESSAGES = {
    "proxy_busy": "Playback copies of another survey are being prepared. Wait for them to finish.",
    "proxy_missing": "The playback copy does not exist or is not ready.",
    "proxy_upgrade_required": "Upgrade storage before preparing playback copies.",
    "proxy_integrity": "The playback copy's frame map failed its integrity check. Prepare it again.",
    "proxy_limit": "The playback copy exceeded a time, memory, frame or size limit.",
    "proxy_limits_unavailable": "Hard process limits are unavailable on this platform. Only Linux and Windows are supported.",
    "proxy_failed": "The playback copy could not be made.",
    "session_missing": "The selected recording session does not exist.",
    "missing_source": "The original recording is missing.",
    "unreadable_source": "The original recording cannot be read.",
    "changed_source": "The original recording changed since import. No copy was made from different bytes.",
    "unsupported_codec": "The original codec or stream layout cannot be processed reliably.",
    "decode_failed": "The original recording could not be decoded reliably.",
    "unknown_timing": "The recording's end time is unknown, so its copy cannot be bounded.",
    "playback_unverified": "The watched playback does not match a ready copy of this video. Watch it again.",
    "playback_too_fast": "Watching faster than 4x does not count as review. Watch these parts again at 4x or slower.",
}


class ProxyError(ImportErrorResponse):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code, MESSAGES.get(code, MESSAGES["proxy_failed"]), status)


def _seconds(metadata: dict) -> float:
    end, time_base = metadata.get("end_time"), metadata["time_base"]
    if end is None:
        raise ValueError("unknown_timing")
    start = int(metadata["first_pts"]) * Fraction(int(time_base["num"]), int(time_base["den"]))
    return float(Fraction(int(end["num"]), int(end["den"])) - start)


class ProxyJobs:
    def __init__(self, db_path: Path, data_dir: Path):
        self.db_path = db_path
        self.directory = data_dir / "playback"
        self.directory.mkdir(parents=True, exist_ok=True)
        self._lock, self._cancel = Lock(), Event()
        self._thread: Thread | None = None
        self._process = None
        self._session: str | None = None
        self._closed = False
        for proxy_id in proxy_store.recover(db_path):
            self._remove(proxy_id)

    def paths(self, proxy_id: str) -> tuple[Path, Path]:
        return self.directory / f"{proxy_id}.webm", self.directory / f"{proxy_id}.frames"

    def _remove(self, proxy_id: str) -> None:
        for path in self.paths(proxy_id):
            path.unlink(missing_ok=True)

    def status(self, session_id: str) -> dict:
        if not store.session_exists(self.db_path, session_id):
            raise ProxyError("session_missing", 404)
        return {"session_id": session_id, "active": self._session == session_id,
                "proxies": proxy_store.latest(self.db_path, session_id)}

    def start(self, session_id: str) -> dict:
        if not workers.supported():
            raise ProxyError("proxy_limits_unavailable")
        if not proxy_store.ready_schema(self.db_path):
            raise ProxyError("proxy_upgrade_required")
        if not store.session_exists(self.db_path, session_id):
            raise ProxyError("session_missing", 404)
        with self._lock:
            if self._session == session_id:
                return self.status(session_id)
            if self._closed or self._session is not None:
                raise ProxyError("proxy_busy")
            todo = []
            for segment in store.private_segments(self.db_path, session_id):
                if proxy_store.ready_for(self.db_path, segment) is None:
                    todo.append((proxy_store.create(self.db_path, segment["id"], segment["sha256"]), segment))
            if todo:
                self._session, self._cancel = session_id, Event()
                self._thread = Thread(target=self._run, args=(todo, self._cancel), daemon=True)
                self._thread.start()
        return self.status(session_id)

    def _set_process(self, process) -> None:
        with self._lock:
            self._process = process

    def _one(self, proxy_id: str, segment: dict, cancelled: Event) -> None:
        code, value = "proxy_failed", None
        try:
            state = source_state(segment)
            if state != "ready":
                code = state
                return
            cpu = cpu_seconds(_seconds(json.loads(segment["metadata_json"])))
            proxy_store.set_running(self.db_path, proxy_id)
            video, frames = self.paths(proxy_id)
            payload = {"parent_pid": os.getpid(), "db_path": str(self.db_path), "segment_id": segment["id"],
                       "output_path": str(video), "frames_path": str(frames), "cpu_seconds": cpu}
            status, body = workers.supervise("proxy_worker", payload, cancelled.is_set, 2 * cpu, MEMORY_BYTES, cpu,
                                             MAX_REQUEST_BYTES, MAX_RESULT_BYTES, self._set_process)
            if status == "ok" and isinstance(body, dict) and set(body) == {"error", "value"}:
                code, value = body["error"], body["value"]
                if code is not None and code not in WORKER_ERRORS:
                    code = "proxy_failed"
            else:
                code = {"cancelled": "cancelled", "limit": "proxy_limit"}.get(status, "proxy_failed")
        except ValueError as error:
            code = str(error) if str(error) in MESSAGES else "proxy_failed"
        except Exception:
            code = "proxy_failed"
        finally:
            code = "cancelled" if cancelled.is_set() or self._closed else code
            state = "ready" if code is None else "cancelled" if code == "cancelled" else "failed"
            if state != "ready":
                self._remove(proxy_id)
            proxy_store.finish(self.db_path, proxy_id, state, code, value)

    def _run(self, todo: list[tuple[str, dict]], cancelled: Event) -> None:
        try:
            for proxy_id, segment in todo:
                if cancelled.is_set() or self._closed:
                    proxy_store.finish(self.db_path, proxy_id, "cancelled", "cancelled")
                    continue
                self._one(proxy_id, segment, cancelled)
        finally:
            with self._lock:
                self._session = None

    def cancel(self, session_id: str) -> dict:
        with self._lock:
            if self._session == session_id:
                self._cancel.set()
                if self._process is not None:
                    try:
                        self._process.kill()
                    except ProcessLookupError:
                        pass
        return self.status(session_id)

    def ready(self, proxy_id: str) -> dict:
        row = proxy_store.get(self.db_path, proxy_id)
        if row is None or row["state"] != "ready":
            raise ProxyError("proxy_missing", 404)
        return row

    def frames(self, proxy_id: str) -> dict:
        row = self.ready(proxy_id)
        blob = self.paths(proxy_id)[1].read_bytes()
        if hashlib.sha256(blob).hexdigest() != row["frames_sha256"]:
            raise ProxyError("proxy_integrity")
        try:
            source_pts, proxy_ms = unpack_frames(blob)
        except (ValueError, OSError):
            raise ProxyError("proxy_integrity") from None
        if len(source_pts) != row["frame_count"]:
            raise ProxyError("proxy_integrity")
        return {"id": proxy_id, "segment_id": row["segment_id"], "width": row["width"], "height": row["height"],
                "duration_ms": row["duration_ms"], "source_pts": [str(value) for value in source_pts], "proxy_ms": proxy_ms}

    def receipt(self, proxy_id: str, segment: dict, intervals: list[list[int]], max_rate: float) -> dict:
        """Proof of continuous viewing in a ready playback copy: every interval starts and ends on a frame of the copy."""
        if max_rate > WATCH_MAX_RATE:
            raise ProxyError("playback_too_fast")
        try:
            row = self.ready(proxy_id)
            frames = set(self.frames(proxy_id)["source_pts"])
        except ProxyError:
            raise ProxyError("playback_unverified") from None
        if (row["segment_id"] != segment["id"] or row["source_sha256"] != segment["sha256"] or not intervals
                or any(start > end or str(start) not in frames or str(end) not in frames for start, end in intervals)):
            raise ProxyError("playback_unverified")
        return {"kind": "playback_copy", "proxy_id": proxy_id, "frames_sha256": row["frames_sha256"],
                "intervals": [[str(start), str(end)] for start, end in intervals], "max_rate": max_rate}

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._cancel.set()
            thread = self._thread
        if thread is not None:
            thread.join(timeout=10)


class SessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: UUID


def install_routes(app: FastAPI, jobs: ProxyJobs, authenticate) -> None:
    @app.post("/api/proxy", status_code=202, dependencies=[Depends(authenticate)])
    def start(payload: SessionRequest) -> dict:
        return jobs.start(str(payload.session_id))

    @app.get("/api/proxy", dependencies=[Depends(authenticate)])
    def status(session_id: UUID) -> dict:
        return jobs.status(str(session_id))

    @app.post("/api/proxy/cancel", dependencies=[Depends(authenticate)])
    def cancel(payload: SessionRequest = Body(...)) -> dict:
        return jobs.cancel(str(payload.session_id))

    @app.get("/api/proxy/{proxy_id}/frames", dependencies=[Depends(authenticate)])
    def frames(proxy_id: UUID) -> dict:
        return jobs.frames(str(proxy_id))

    @app.get("/api/proxy/{proxy_id}/video", dependencies=[Depends(authenticate)])
    def video(proxy_id: UUID) -> FileResponse:
        jobs.ready(str(proxy_id))
        # FileResponse answers Range requests with 206, which the player needs for seeking.
        return FileResponse(jobs.paths(str(proxy_id))[0], media_type="video/webm")
