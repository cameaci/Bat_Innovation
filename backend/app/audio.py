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

from fastapi import Depends, FastAPI, Query
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
ACTIVITY_WALL_SECONDS = 1800
# Call activity needs the ultrasonic band, so only full-spectrum recordings are analysed.
ACTIVITY_BAND_HZ = (15_000.0, 120_000.0)


def proposed_anchor(source: dict, segments: list[dict], clock: dict | None, utc_offset: str | None = None) -> dict:
    """A sync anchor from the file clocks (the audio file's claimed start and the declared camera clock): unverified,
    shown for one confirmation and never applied by itself. Returns the proposal or the reason there is none.

    Detector clocks usually write local time without a zone; such a time needs the UTC offset the reviewer states."""
    from datetime import datetime, timedelta, timezone

    claimed = source["metadata"].get("file_clock")
    if not claimed:
        return {"proposal": None, "reason": "The audio file states no start time (no GUANO Timestamp or time in its name)."}
    by_id = {segment["id"]: segment for segment in segments}
    if not clock or not clock.get("provenance", "").strip() or clock.get("segment_id") not in by_id:
        return {"proposal": None, "reason": "Declare the recording clock of a video on the Process page first."}
    metadata = json.loads(by_id[clock["segment_id"]]["metadata_json"])
    try:
        video_start = datetime.fromisoformat(clock["utc"])
        audio_start = datetime.fromisoformat(claimed["timestamp"].replace(" ", "T", 1))
    except ValueError:
        return {"proposal": None, "reason": f"The file time {claimed['timestamp']!r} could not be read."}
    if clock.get("source_pts") != metadata["first_pts"] or video_start.tzinfo is None:
        return {"proposal": None, "reason": "The declared recording clock is not bound to its video's first frame."}
    stated_zone = audio_start.tzinfo is None
    if stated_zone:
        if utc_offset is None:
            return {"proposal": None, "needs_offset": True,
                    "reason": f"The audio file time {claimed['timestamp']} has no time zone. Enter its UTC offset (for example +01:00)."}
        sign, hours, minutes = utc_offset[0], int(utc_offset[1:3]), int(utc_offset[4:6])
        audio_start = audio_start.replace(tzinfo=timezone((1 if sign == "+" else -1) * timedelta(hours=hours, minutes=minutes)))
    base = Fraction(int(metadata["time_base"]["num"]), int(metadata["time_base"]["den"]))
    rate, frames = source["metadata"]["sample_rate"], source["metadata"]["frames"]
    delta = Fraction(str((audio_start - video_start).total_seconds()))
    first, last = int(metadata["first_pts"]), int(metadata["last_pts"])
    if delta >= 0:
        video_pts, audio_sample = first + round(delta / base), 0
    else:
        video_pts, audio_sample = first, round(-delta * rate)
    if video_pts > last or audio_sample >= frames:
        return {"proposal": None, "reason": "By the file clocks the audio and this video do not overlap."}
    return {"proposal": {"segment_id": clock["segment_id"], "video_pts": str(video_pts), "audio_sample": audio_sample,
                         "basis": claimed["source"], "timestamp": claimed["timestamp"], "stated_offset": utc_offset if stated_zone else None,
                         "offset_seconds": float(delta)}, "reason": None}


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
                if old["path"]:
                    Path(old["path"]).unlink(missing_ok=True)
        return {key: item for key, item in record.items() if key != "path"}

    def propose(self, audio_id: str, utc_offset: str | None = None) -> dict:
        audio_store.require_schema(self.db_path)
        source = audio_store.get_source(self.db_path, audio_id)
        segments = store.private_segments(self.db_path, source["session_id"])
        return proposed_anchor(source, segments, store.clock_anchor(self.db_path, source["session_id"]), utc_offset)

    def activity(self, audio_id: str, low_hz: float, high_hz: float, margin_db: float) -> dict:
        """Call marks of the whole recording (cached per recording and parameters), in audio samples."""
        audio_store.require_schema(self.db_path)
        source = audio_store.get_source(self.db_path, audio_id, private=True)
        if not source["retunable"]:
            raise error("not_retunable")
        key = f"activity:{audio_id}:{source['sha256']}:{low_hz}:{high_hz}:{margin_db}"
        with self._guard:
            if key in self.derived:
                return self.derived[key]["value"]
        try:
            if media.identity_info(Path(source["source_path"])) != source["identity"]:
                raise error("changed_source")
        except FileNotFoundError:
            raise error("missing_source") from None
        if not self.lock.acquire(blocking=False):
            raise error("audio_busy")
        partial = self.directory / f"{uuid4()}.json.part"
        seconds = source["metadata"]["frames"] / source["metadata"]["sample_rate"]
        try:
            if not workers.supported():
                raise error("audio_limits_unavailable")
            cpu = int(60 + seconds * 0.25)
            status, body = workers.supervise("audio_worker", {"parent_pid": os.getpid(), "operation": "activity", "source_path": source["source_path"],
                                             "sha256": source["sha256"], "channel": source["channel"], "sample_rate": source["metadata"]["sample_rate"],
                                             "low_hz": low_hz, "high_hz": high_hz, "margin_db": margin_db, "output_path": str(partial), "cpu_seconds": cpu},
                                             lambda: False, min(ACTIVITY_WALL_SECONDS, 2 * cpu), MEMORY_BYTES, cpu, MAX_REQUEST_BYTES, 64 * 1024)
            if status != "ok" or not isinstance(body, dict):
                raise error("audio_limit" if status == "limit" else "audio_failed")
            if body["error"] is not None:
                raise error(body["error"] if body["error"] in WORKER_ERRORS else "audio_failed")
            data = json.loads(partial.read_text())
        finally:
            partial.unlink(missing_ok=True)
            self.lock.release()
        value = {"audio_id": audio_id, "sample_rate": source["metadata"]["sample_rate"], "frames": source["metadata"]["frames"],
                 "parameters": body["value"]["parameters"], **data}
        with self._guard:
            self.derived[key] = {"path": "", "value": value}
        return value

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


class AudioLabel(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str = Field(max_length=60)


class Activity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    low_hz: float = Field(default=ACTIVITY_BAND_HZ[0], ge=1_000, le=200_000)
    high_hz: float = Field(default=ACTIVITY_BAND_HZ[1], ge=2_000, le=250_000)
    margin_db: float = Field(default=12.0, ge=3, le=40)


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

    @app.post("/api/audio/{audio_id}/label", dependencies=[Depends(authenticate)])
    def label(audio_id: UUID, payload: AudioLabel) -> dict:
        return audio_store.set_label(service.db_path, str(audio_id), payload.label)

    @app.get("/api/audio/{audio_id}/proposed-anchor", dependencies=[Depends(authenticate)])
    def proposed(audio_id: UUID, utc_offset: str | None = Query(default=None, pattern=r"^[+-](0\d|1[0-4]):[0-5]\d$")) -> dict:
        return service.propose(str(audio_id), utc_offset)

    @app.post("/api/audio/{audio_id}/activity", dependencies=[Depends(authenticate)])
    def activity(audio_id: UUID, payload: Activity) -> dict:
        return service.activity(str(audio_id), payload.low_hz, payload.high_hz, payload.margin_db)

    @app.post("/api/audio/{audio_id}/derive", dependencies=[Depends(authenticate)])
    def derive(audio_id: UUID, payload: Derive) -> dict:
        if payload.kind == "heterodyne" and payload.tune_hz is None:
            raise audio_store.AudioError("audio_invalid", "Choose a tuning frequency.", 422)
        return service.derive(str(audio_id), str(payload.segment_id), int(payload.start_pts), payload.seconds, payload.kind, payload.tune_hz)

    @app.get("/api/audio/derived/{derived_id}/content", dependencies=[Depends(authenticate)])
    def content(derived_id: UUID) -> Response:
        data, mime = service.content(str(derived_id))
        return Response(data, media_type=mime, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
