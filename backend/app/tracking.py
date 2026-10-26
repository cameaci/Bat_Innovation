"""Tracking runs: one contained worker per run, sharing the single media activity lock (E2)."""

from __future__ import annotations

from _thread import LockType
import os
from pathlib import Path
from threading import Event, Lock, Thread
from uuid import UUID, uuid4

from fastapi import Body, Depends, FastAPI
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from . import candidate_store, store, summary_store, tracking_store, workers
from .imports import ImportErrorResponse, source_state
from .track_worker import CPU_SECONDS, ERRORS as WORKER_ERRORS, MAX_REQUEST_BYTES, MAX_TEST_RESULT_BYTES, MEMORY_BYTES

WALL_SECONDS = 900
MAX_RESULT_BYTES = 256 * 1024
MESSAGES = {
    "tracking_busy": "Another media operation is running. Wait for it or cancel it before tracking.",
    "tracking_missing": "The selected tracking or summary run does not exist.",
    "tracking_upgrade_required": "Upgrade storage before tracking.",
    "tracking_summary_running": "Wait for the summary run to finish before tracking it.",
    "tracking_limit": "Tracking exceeded a configured time, memory, frame or track limit. No partial segment was saved.",
    "tracking_limits_unavailable": "Hard process limits are unavailable on this platform. Only Linux and Windows are supported.",
    "tracking_failed": "Tracking failed. Completed segments remain; the run is marked failed.",
    "tracking_integrity": "Stored track points failed their integrity check.",
    "tracking_settings": "The tracking settings leave no area to search. Check the detection area and exclusion zones.",
    "tracking_test_missing": "The test run does not exist or has been replaced by a newer one.",
    "track_limit": "Too many tracks overlap this interval to return at once.",
    "missing_source": "The original recording is missing. Restore it before tracking.",
    "unreadable_source": "The original recording cannot be read.",
    "changed_source": "The original recording changed since it was summarised. Tracks are not computed on different bytes.",
    "unsupported_codec": "The original codec or stream layout cannot be processed reliably.",
    "decode_failed": "The original recording could not be decoded reliably.",
    "unknown_timing": "Original source timestamps could not be verified.",
    "cancelled": "Tracking was cancelled. Completed segments remain; the run is marked cancelled.",
    "interrupted": "Tracking was interrupted. Start a new tracking run.",
}


class TrackingError(ImportErrorResponse):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code, MESSAGES.get(code, MESSAGES["tracking_failed"]), status)


class TrackingJobs:
    def __init__(self, db_path: Path, activity_lock: LockType):
        self.db_path = db_path
        self._lock, self._activity_lock = Lock(), activity_lock
        self._cancel = Event()
        self._thread: Thread | None = None
        self._process = None
        self._run_id: str | None = None
        self._closed = False
        self._test: dict | None = None
        tracking_store.recover(db_path)

    def start(self, summary_run_id: str, settings: dict | None = None) -> dict:
        if not workers.supported():
            raise TrackingError("tracking_limits_unavailable")
        if not tracking_store.require_schema(self.db_path):
            raise TrackingError("tracking_upgrade_required")
        with self._lock:
            if self._closed or not self._activity_lock.acquire(blocking=False):
                raise TrackingError("tracking_busy")
            try:
                private = summary_store.private_run(self.db_path, summary_run_id)
                if private is None:
                    raise TrackingError("tracking_missing", 404)
                for source in private["sources"]:
                    current = store.segment_by_id(self.db_path, source["id"])
                    state = source_state(current) if current else "missing_source"
                    if state != "ready":
                        raise TrackingError(state)
                try:
                    run_id = tracking_store.create_run(self.db_path, summary_run_id, settings)
                except ValueError:
                    raise TrackingError("tracking_summary_running") from None
                self._run_id, self._cancel = run_id, Event()
                self._thread = Thread(target=self._run, args=(run_id, self._cancel), daemon=True)
                self._thread.start()
                return tracking_store.get_run(self.db_path, run_id)
            except BaseException:
                self._activity_lock.release()
                raise

    def _set_process(self, process) -> None:
        with self._lock:
            self._process = process

    def _run(self, run_id: str, cancelled: Event) -> None:
        code, stats = "tracking_failed", None
        try:
            payload = {"parent_pid": os.getpid(), "db_path": str(self.db_path), "run_id": run_id}
            status, body = workers.supervise("track_worker", payload, cancelled.is_set, WALL_SECONDS, MEMORY_BYTES,
                                             CPU_SECONDS, MAX_REQUEST_BYTES, MAX_RESULT_BYTES, self._set_process)
            if status == "ok" and isinstance(body, dict) and set(body) == {"error", "stats"}:
                code, stats = body["error"], body["stats"]
                if code is not None and code not in WORKER_ERRORS:
                    code = "tracking_failed"
            else:
                code = {"cancelled": "cancelled", "limit": "tracking_limit"}.get(status, "tracking_failed")
        except Exception:
            code = "tracking_failed"
        finally:
            with self._lock:
                code = "cancelled" if cancelled.is_set() or self._closed else code
                state = "complete" if code is None else "cancelled" if code == "cancelled" else "failed"
                try:
                    tracking_store.set_state(self.db_path, run_id, state, code, stats)
                finally:
                    self._run_id = None
                    self._activity_lock.release()

    def start_test(self, segment_id: str, start_pts: int, end_pts: int, settings: dict) -> dict:
        """A short calibration run held in memory only; one at a time, replacing the previous result."""
        if not workers.supported():
            raise TrackingError("tracking_limits_unavailable")
        if not tracking_store.require_schema(self.db_path):
            raise TrackingError("tracking_upgrade_required")
        segment = store.segment_by_id(self.db_path, segment_id)
        if segment is None:
            raise TrackingError("tracking_missing", 404)
        state = source_state(segment)
        if state != "ready":
            raise TrackingError(state)
        with self._lock:
            if self._closed or not self._activity_lock.acquire(blocking=False):
                raise TrackingError("tracking_busy")
            test_id = str(uuid4())
            self._test = {"id": test_id, "state": "running", "error": None, "result": None}
            payload = {"parent_pid": os.getpid(), "db_path": str(self.db_path), "mode": "test", "segment_id": segment_id,
                       "start_pts": str(start_pts), "end_pts": str(end_pts), "settings": settings}
            self._thread = Thread(target=self._run_test, args=(test_id, payload, self._cancel), daemon=True)
            self._thread.start()
            return dict(self._test)

    def _run_test(self, test_id: str, payload: dict, cancelled: Event) -> None:
        code, value = "tracking_failed", None
        try:
            status, body = workers.supervise("track_worker", payload, cancelled.is_set, 120, MEMORY_BYTES, 60,
                                             MAX_REQUEST_BYTES, MAX_TEST_RESULT_BYTES, self._set_process)
            if status == "ok" and isinstance(body, dict) and set(body) == {"error", "stats"}:
                code, value = body["error"], body["stats"]
                if code is not None and code not in WORKER_ERRORS:
                    code = "tracking_failed"
            else:
                code = {"cancelled": "cancelled", "limit": "tracking_limit"}.get(status, "tracking_failed")
        except Exception:
            code = "tracking_failed"
        finally:
            with self._lock:
                if self._test is not None and self._test["id"] == test_id:
                    self._test = {"id": test_id, "state": "complete" if code is None else "failed", "error": code, "result": value}
                self._activity_lock.release()

    def get_test(self, test_id: str) -> dict:
        with self._lock:
            if self._test is None or self._test["id"] != test_id:
                raise TrackingError("tracking_test_missing", 404)
            return dict(self._test)

    def events(self, run_id: str) -> list[dict]:
        self.get(run_id)
        return tracking_store.events(self.db_path, run_id)

    def get(self, run_id: str) -> dict:
        result = tracking_store.get_run(self.db_path, run_id)
        if result is None:
            raise TrackingError("tracking_missing", 404)
        windows = summary_store.private_run(self.db_path, result["summary_run_id"])["windows"]
        result["window_counts"] = tracking_store.window_counts(self.db_path, run_id, windows)
        return result

    def cancel(self, run_id: str) -> dict:
        with self._lock:
            if self._run_id == run_id:
                self._cancel.set()
                if self._process is not None:
                    try:
                        self._process.kill()
                    except ProcessLookupError:
                        pass
        return self.get(run_id)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._cancel.set()
            thread = self._thread
        if thread is not None:
            thread.join(timeout=10)


Point = tuple[float, float]


class TrackingSettings(BaseModel):
    """Visible tracking settings (tracks-v2). Defaults are starting values, not validated thresholds."""
    model_config = ConfigDict(extra="forbid")
    target_px: float = Field(default=12, ge=3, le=80)
    polarity: Literal["both", "light", "dark"] = "both"
    sensitivity: float = Field(default=12, ge=4, le=40)
    activity: Literal["sparse", "normal", "dense"] = "normal"
    detection_area: list[list[Point]] = Field(default_factory=list, max_length=4)
    exclusions: list[list[Point]] = Field(default_factory=list, max_length=8)
    max_gap_s: float = Field(default=0.4, ge=0.04, le=2)
    min_track_s: float = Field(default=0.2, ge=0, le=5)
    join_gap_s: float = Field(default=1.0, ge=0, le=5)
    min_displacement_targets: float = Field(default=2, ge=0, le=20)

    def checked(self) -> dict:
        for polygon in [*self.detection_area, *self.exclusions]:
            if not 3 <= len(polygon) <= 32 or any(x < 0 or y < 0 or x > 8192 or y > 8192 for x, y in polygon):
                raise TrackingError("tracking_settings", 422)
        return self.model_dump()


class NewTracking(BaseModel):
    model_config = ConfigDict(extra="forbid")
    summary_run_id: UUID
    settings: TrackingSettings = Field(default_factory=TrackingSettings)


class TrackingTest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    segment_id: UUID
    start_pts: int
    end_pts: int
    settings: TrackingSettings = Field(default_factory=TrackingSettings)


class Empty(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CandidateDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    actor: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)
    decision: Literal["bat", "not_bat", "uncertain"]
    note: str = Field(default="", max_length=2000)
    preview_id: UUID | None = None
    playback: "PlaybackProof | None" = None


class PlaybackProof(BaseModel):
    """Continuous viewing in the playback copy: frame PTS intervals and the fastest speed used."""
    model_config = ConfigDict(extra="forbid")
    proxy_id: UUID
    intervals: list[tuple[int, int]] = Field(min_length=1, max_length=50)
    max_rate: float = Field(gt=0, le=16)


CandidateDecision.model_rebuild()


def install_routes(app: FastAPI, jobs: TrackingJobs, authenticate, previews, proxies) -> None:
    @app.post("/api/tracking", status_code=202, dependencies=[Depends(authenticate)])
    def start(payload: NewTracking) -> dict:
        return jobs.start(str(payload.summary_run_id), payload.settings.checked())

    @app.post("/api/tracking-tests", status_code=202, dependencies=[Depends(authenticate)])
    def start_test(payload: TrackingTest) -> dict:
        return jobs.start_test(str(payload.segment_id), payload.start_pts, payload.end_pts, payload.settings.checked())

    @app.get("/api/tracking-tests/{test_id}", dependencies=[Depends(authenticate)])
    def get_test(test_id: UUID) -> dict:
        return jobs.get_test(str(test_id))

    @app.get("/api/tracking/{run_id}/events", dependencies=[Depends(authenticate)])
    def events(run_id: UUID) -> list[dict]:
        return jobs.events(str(run_id))

    @app.get("/api/summaries/{run_id}/tracking", dependencies=[Depends(authenticate)])
    def list_runs(run_id: UUID) -> list[dict]:
        return tracking_store.list_runs(jobs.db_path, str(run_id))

    @app.get("/api/tracking/{run_id}", dependencies=[Depends(authenticate)])
    def get(run_id: UUID) -> dict:
        return jobs.get(str(run_id))

    @app.post("/api/tracking/{run_id}/cancel", dependencies=[Depends(authenticate)])
    def cancel(run_id: UUID, _payload: Empty = Body(default_factory=Empty)) -> dict:
        return jobs.cancel(str(run_id))

    @app.get("/api/tracking/{run_id}/tracks", dependencies=[Depends(authenticate)])
    def tracks(run_id: UUID, segment_id: UUID, start_pts: int, end_pts: int | None = None) -> list[dict]:
        jobs.get(str(run_id))
        try:
            return tracking_store.tracks_between(jobs.db_path, str(run_id), str(segment_id), start_pts, end_pts)
        except OverflowError:
            raise TrackingError("track_limit") from None
        except ValueError:
            raise TrackingError("tracking_integrity") from None

    @app.get("/api/tracking/{run_id}/candidates", dependencies=[Depends(authenticate)])
    def list_candidates(run_id: UUID) -> list[dict]:
        return candidate_store.candidates(jobs.db_path, str(run_id))

    @app.post("/api/tracking/{run_id}/candidates/{track_id}/decision", dependencies=[Depends(authenticate)])
    def decide(run_id: UUID, track_id: UUID, payload: CandidateDecision) -> dict:
        if (payload.preview_id is None) == (payload.playback is None):
            raise candidate_store.CandidateError("candidate_unverified", "Give either an original preview or a playback viewing.", 422)
        if payload.playback is not None:
            track = next((item for item in candidate_store.candidates(jobs.db_path, str(run_id)) if item["track_id"] == str(track_id)), None)
            segment = store.segment_by_id(jobs.db_path, track["segment_id"]) if track else None
            if segment is None:
                raise candidate_store.CandidateError("candidate_missing", "The candidate track does not exist.", 404)
            spans = [list(span) for span in payload.playback.intervals]
            receipt = proxies.receipt(str(payload.playback.proxy_id), segment, spans, payload.playback.max_rate)
            return candidate_store.decide(jobs.db_path, str(run_id), str(track_id), payload.actor, payload.expected_revision,
                                          payload.decision, payload.note, None, {**receipt, "segment_id": segment["id"]})
        try:
            preview = previews.get(str(payload.preview_id))
        except ImportErrorResponse:
            raise candidate_store.CandidateError("candidate_unverified", "Watch an original preview that covers this candidate before deciding.") from None
        return candidate_store.decide(jobs.db_path, str(run_id), str(track_id), payload.actor, payload.expected_revision,
                                      payload.decision, payload.note, {**preview, "id": str(payload.preview_id)})

    @app.get("/api/tracking/{run_id}/flight-map", dependencies=[Depends(authenticate)])
    def flight_map(run_id: UUID, segment_id: UUID) -> dict:
        jobs.get(str(run_id))
        try:
            return tracking_store.flight_bins(jobs.db_path, str(run_id), str(segment_id))
        except LookupError:
            raise TrackingError("tracking_missing", 404) from None
        except ValueError:
            raise TrackingError("tracking_integrity") from None
