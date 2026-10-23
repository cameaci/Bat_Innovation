"""Full-spectrum audio evidence beside the video (feature expansion E7).

A WAV original is added by native selection, inspected in a contained worker and never written. One manual anchor
pairs a video frame with an audio sample; spectrograms and heterodyne clips are derived on demand for a video span.
Clock drift is not corrected (one anchor), and the UI says so.
"""

from __future__ import annotations

from _thread import LockType
from collections import OrderedDict
from fractions import Fraction
from hashlib import sha256
import json
import os
from pathlib import Path
from threading import Lock
from typing import Literal
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from . import audio_store, media, store, workers
from .audio_worker import CPU_SECONDS, ERRORS as WORKER_ERRORS, MAX_OUTPUT_BYTES, MAX_REQUEST_BYTES, MEMORY_BYTES
from .imports import selected_sources

WALL_SECONDS = 150
MESSAGES = {
    "audio_busy": "Another media operation is running. Wait for it before working with audio.",
    "audio_failed": "The audio operation failed. The original recording was not changed.",
    "audio_limit": "The audio operation exceeded a time, memory or size limit.",
    "audio_limits_unavailable": "Hard process limits are unavailable on this platform. Only Linux and Windows are supported.",
    "unsupported_audio": "Only uncompressed PCM WAV recordings with one audio stream are supported.",
    "decode_failed": "The audio recording could not be decoded reliably.",
    "changed_source": "The audio recording changed since it was added. Add it again.",
    "missing_source": "The audio recording is missing. Restore it.",
    "unreadable_source": "The audio recording cannot be read.",
    "outside_audio": "The audio recording does not cover this part of the video.",
    "not_retunable": "This recording is not full-spectrum (or its sample rate is too low for this tuning), so it cannot be retuned.",
    "audio_not_synchronised": "Set a sync anchor for this video before showing its audio.",
}


def error(code: str, status: int = 409) -> audio_store.AudioError:
    return audio_store.AudioError(code, MESSAGES.get(code, MESSAGES["audio_failed"]), status)


class AudioService:
    def __init__(self, db_path: Path, data_dir: Path, activity_lock: LockType):
        self.db_path, self.data_dir, self.lock = db_path, data_dir, activity_lock
        self.directory = data_dir / "audio-derived"
        self.directory.mkdir(parents=True, exist_ok=True)
        if workers.is_link(self.directory):
            raise RuntimeError("Managed audio directory must not be a symbolic link")
        for leftover in self.directory.glob("*.part"):
            leftover.unlink()
        self.derived: OrderedDict[str, dict] = OrderedDict()
        self._guard = Lock()

    def _run(self, payload: dict) -> dict:
        if not workers.supported():
            raise error("audio_limits_unavailable")
        status, body = workers.supervise("audio_worker", {"parent_pid": os.getpid(), **payload}, lambda: False, WALL_SECONDS,
                                         MEMORY_BYTES, CPU_SECONDS, MAX_REQUEST_BYTES, 64 * 1024)
        if status != "ok" or not isinstance(body, dict):
            raise error("audio_limit" if status == "limit" else "audio_failed")
        if body["error"] is not None:
            raise error(body["error"] if body["error"] in WORKER_ERRORS else "audio_failed")
        return body["value"]

    def add(self, session_id: str, paths: list[str], source_mode: str, channel: int) -> list[dict]:
        audio_store.require_schema(self.db_path)
        sources = selected_sources(paths, self.data_dir, (".wav",))
        if not self.lock.acquire(blocking=False):
            raise error("audio_busy")
        try:
            added = []
            for path in sources:
                inspected = self._run({"operation": "inspect", "source_path": str(path)})
                added.append(audio_store.add_source(self.db_path, session_id, path, inspected, source_mode, channel))
            return added
        finally:
            self.lock.release()

    def derive(self, audio_id: str, segment_id: str, start_pts: int, seconds: int, kind: str, tune_hz: float | None) -> dict:
        audio_store.require_schema(self.db_path)
        source = audio_store.get_source(self.db_path, audio_id, private=True)
        anchor = source["anchor"]
        if anchor is None or anchor["segment_id"] != segment_id:
            raise error("audio_not_synchronised")
        if kind == "heterodyne" and not source["retunable"]:
            raise error("not_retunable")
        segment = store.segment_by_id(self.db_path, segment_id)
        time_base = Fraction(int(json.loads(segment["metadata_json"])["time_base"]["num"]), int(json.loads(segment["metadata_json"])["time_base"]["den"]))
        rate, frames = source["metadata"]["sample_rate"], source["metadata"]["frames"]
        # audio_time = video_time + b, from one anchor; the exact offset is floored to a whole sample.
        start = anchor["audio_sample"] + int((start_pts - int(anchor["video_pts"])) * time_base * rate // 1)
        end = start + seconds * rate
        first, last = max(0, start), min(frames, end)
        if last <= first:
            raise error("outside_audio")
        try:
            if media.identity_info(Path(source["source_path"])) != source["identity"]:
                raise error("changed_source")
        except FileNotFoundError:
            raise error("missing_source") from None
        if not self.lock.acquire(blocking=False):
            raise error("audio_busy")
        derived_id = str(uuid4())
        suffix, mime = (".png", "image/png") if kind == "spectrogram" else (".wav", "audio/wav")
        partial, target = self.directory / f"{derived_id}{suffix}.part", self.directory / f"{derived_id}{suffix}"
        try:
            value = self._run({"operation": kind, "source_path": source["source_path"], "sha256": source["sha256"], "channel": source["channel"],
                               "sample_rate": rate, "start": first, "count": last - first, "tune_hz": tune_hz, "output_path": str(partial)})
            os.replace(partial, target)
        finally:
            partial.unlink(missing_ok=True)
            self.lock.release()
        content = target.read_bytes()
        record = {"id": derived_id, "kind": kind, "audio_id": audio_id, "segment_id": segment_id, "mime": mime, "path": str(target),
                  "bytes": len(content), "sha256": sha256(content).hexdigest(), "sample_rate": rate, "start_sample": first,
                  "end_sample": last, "requested_start_sample": start, "requested_end_sample": end,
                  # Video time of the first returned sample, as an exact offset from the requested PTS.
                  "start_offset_seconds": float(Fraction(first - start, rate)), "covered_seconds": (last - first) / rate,
                  "anchor_revision": anchor["revision"], "drift_corrected": False, **value}
        with self._guard:
            self.derived[derived_id] = record
            while len(self.derived) > 8:
                _, old = self.derived.popitem(last=False)
                Path(old["path"]).unlink(missing_ok=True)
        return {key: item for key, item in record.items() if key != "path"}

    def content(self, derived_id: str) -> tuple[bytes, str]:
        with self._guard:
            record = self.derived.get(derived_id)
        if record is None:
            raise error("audio_failed", 404)
        content = Path(record["path"]).read_bytes()
        if len(content) != record["bytes"] or len(content) > MAX_OUTPUT_BYTES or sha256(content).hexdigest() != record["sha256"]:
            raise error("audio_failed")
        return content, record["mime"]


class NewAudio(BaseModel):
    model_config = ConfigDict(extra="forbid")
    paths: list[str] = Field(min_length=1, max_length=16)
    source_mode: Literal["full_spectrum", "heterodyne", "frequency_division", "time_expansion", "unknown"]
    channel: int = Field(default=0, ge=0, le=7)


class Anchor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    actor: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)
    segment_id: UUID
    video_pts: str = Field(pattern=r"^-?\d{1,19}$")
    audio_sample: int = Field(ge=0)
    note: str = Field(default="", max_length=2000)


class Derive(BaseModel):
    model_config = ConfigDict(extra="forbid")
    segment_id: UUID
    start_pts: str = Field(pattern=r"^-?\d{1,19}$")
    seconds: int = Field(ge=1, le=12)
    kind: Literal["spectrogram", "heterodyne"]
    tune_hz: float | None = Field(default=None, ge=10_000, le=150_000)


def install_routes(app: FastAPI, service: AudioService, authenticate) -> None:
    @app.get("/api/sessions/{session_id}/audio", dependencies=[Depends(authenticate)])
    def list_audio(session_id: UUID) -> list[dict]:
        return audio_store.list_sources(service.db_path, str(session_id))

    @app.post("/api/sessions/{session_id}/audio", dependencies=[Depends(authenticate)])
    def add_audio(session_id: UUID, payload: NewAudio) -> list[dict]:
        return service.add(str(session_id), payload.paths, payload.source_mode, payload.channel)

    @app.post("/api/audio/{audio_id}/anchor", dependencies=[Depends(authenticate)])
    def anchor(audio_id: UUID, payload: Anchor) -> dict:
        return audio_store.set_anchor(service.db_path, str(audio_id), payload.actor, payload.expected_revision, str(payload.segment_id),
                                      int(payload.video_pts), payload.audio_sample, payload.note)

    @app.post("/api/audio/{audio_id}/derive", dependencies=[Depends(authenticate)])
    def derive(audio_id: UUID, payload: Derive) -> dict:
        if payload.kind == "heterodyne" and payload.tune_hz is None:
            raise audio_store.AudioError("audio_invalid", "Choose a tuning frequency.", 422)
        return service.derive(str(audio_id), str(payload.segment_id), int(payload.start_pts), payload.seconds, payload.kind, payload.tune_hz)

    @app.get("/api/audio/derived/{derived_id}/content", dependencies=[Depends(authenticate)])
    def content(derived_id: UUID) -> Response:
        data, mime = service.content(str(derived_id))
        return Response(data, media_type=mime, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
