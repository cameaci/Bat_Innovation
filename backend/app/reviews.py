"""Explicit manual review operations and current source-evidence verification."""

from __future__ import annotations

from _thread import LockType
from fractions import Fraction
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
from typing import Annotated, Literal, Protocol
from uuid import UUID

from fastapi import Body, Depends, FastAPI, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, field_validator

from . import review_store, store, summary_store, windows
from .imports import ImportErrorResponse, source_state
from .preview import PreviewJobs
from .summary_jobs import MAX_IMAGE_BYTES

MAX_ACTION_BYTES = 8192
MAX_REVISION = 2 ** 31 - 1
Decision = Literal["unreviewed", "reviewed_with_observations", "reviewed_no_discernible_event"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Observation(StrictModel):
    segment_id: UUID
    start_pts: str = Field(pattern=r"^-?(0|[1-9][0-9]{0,18})$", strict=True)
    end_pts: str = Field(pattern=r"^-?(0|[1-9][0-9]{0,18})$", strict=True)
    category: Literal["bat", "insect", "bird", "other", "uncertain"]
    activity: str | None = Field(max_length=120)
    count: int | None = Field(ge=0, le=100000, strict=True)
    uncertain: bool = Field(strict=True)
    notes: str = Field(max_length=2000, strict=True)


class Change(StrictModel):
    actor: str = Field(min_length=1, max_length=120, strict=True)
    expected_revision: int = Field(ge=0, le=MAX_REVISION, strict=True)

    @field_validator("actor")
    @classmethod
    def reviewer_label(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A local reviewer label is required")
        return value.strip()


class AddObservation(Change):
    action: Literal["add_observation"]
    observation: Observation


class UpdateObservation(Change):
    action: Literal["update_observation"]
    observation_id: UUID
    observation: Observation


class DeleteObservation(Change):
    action: Literal["delete_observation"]
    observation_id: UUID


class SetDecision(Change):
    action: Literal["set_decision"]
    decision: Decision
    preview_id: UUID | None


class UnableToAssess(Change):
    action: Literal["unable_to_assess"]
    note: str = Field(min_length=1, max_length=2000, strict=True)


ReviewChange = Annotated[AddObservation | UpdateObservation | DeleteObservation | SetDecision | UnableToAssess,
                         Field(discriminator="action")]
CHANGE_ADAPTER = TypeAdapter(ReviewChange)


def _error(code: str, message: str, status: int = 409) -> review_store.ReviewError:
    return review_store.ReviewError(code, message, status)


class SummaryEvidence(Protocol):
    def _image_path(self, row: dict) -> Path: ...


class ReviewService:
    def __init__(self, db_path: Path, summaries: SummaryEvidence, previews: PreviewJobs | None, activity_lock: LockType):
        self.db_path, self.summaries, self.previews = db_path, summaries, previews
        self.activity_lock = activity_lock

    def _schema(self) -> None:
        if store.schema_version(self.db_path) not in store.REVIEW_SCHEMA_VERSIONS:
            raise _error("review_schema_required", "Explicitly upgrade the local review database before recording review.")

    @staticmethod
    def _private_binding(private: dict, row: dict) -> dict:
        source = next(item for item in private["sources"] if item["id"] == row["segment_id"])
        return {"run_id": row["run_id"], "window_id": row["id"], "segment_id": row["segment_id"],
                "source_sha256": row["source_sha256"], "parameter_hash": private["run"]["parameter_hash"],
                "time_base": row["time_base"], "interval": row["interval"], "source_snapshot": source}

    @staticmethod
    def _source_binding(snapshot: dict, current: dict | None) -> tuple[str, bool]:
        state = source_state(snapshot)
        mismatch = current is None or any(current[key] != snapshot[key] for key in
                                         ("source_path", "sha256", "identity_json", "metadata_json"))
        return state, mismatch

    def _evidence(self, private: dict, row: dict, *, check_image: bool = True,
                  sources: dict | None = None, plans: dict | None = None, latch: bool = False) -> dict:
        """Validate evidence without rewriting a human decision or its audit history."""
        binding = self._private_binding(private, row)
        snapshot = binding["source_snapshot"]
        metadata = json.loads(snapshot["metadata_json"])
        public = {key: value for key, value in binding.items() if key != "source_snapshot"}
        public.update(source_first_pts=metadata["first_pts"], source_last_pts=metadata["last_pts"],
                      source_end_pts=(windows.rational(windows.fraction(metadata["end_time"]) /
                                                       windows.fraction(metadata["time_base"]))
                                      if metadata["end_time"] is not None else None))
        warning = None
        if sources is None:
            sources = {}
        if row["segment_id"] not in sources:
            current = store.segment_by_id(self.db_path, row["segment_id"])
            sources[row["segment_id"]] = self._source_binding(snapshot, current)
        state, mismatch = sources[row["segment_id"]]
        if state != "ready":
            warning = state
        elif mismatch:
            warning = "review_binding_mismatch"
        run = private["run"]
        if plans is None:
            plans = {}
        try:
            params = run["parameters"]
            if row["segment_id"] not in plans:
                plans[row["segment_id"]] = windows.plan_source(metadata, params["window_seconds"])
            plan = plans[row["segment_id"]]
            if (run["parameter_hash"] != windows.parameter_hash(params)
                    or run["algorithm_version"] != params["algorithm_version"]
                    or not 0 <= row["index"] < len(plan) or row["interval"] != plan[row["index"]]
                    or row["time_base"] != metadata["time_base"] or row["source_sha256"] != snapshot["sha256"]
                    or metadata["sha256"] != snapshot["sha256"]):
                warning = warning or "review_binding_mismatch"
        except (ValueError, KeyError, TypeError, ZeroDivisionError):
            warning = warning or "review_binding_mismatch"
        if check_image and row["image_path"]:
            try:
                path = self.summaries._image_path(row)
                with path.open("rb") as source:
                    image = source.read(MAX_IMAGE_BYTES + 1)
                if (len(image) != row["image_bytes"] or len(image) > MAX_IMAGE_BYTES
                        or sha256(image).hexdigest() != row["image_sha256"]):
                    warning = warning or "summary_image_invalid"
            except ImportErrorResponse as error:
                warning = warning or error.code
            except OSError:
                warning = warning or "summary_image_missing"
        if binding["interval"]["end_pts"] is None:
            warning = warning or "unknown_end"
        # Availability transitions belong to derived evidence metadata, not to
        # human review history. Restoration cannot silently re-sign an old review.
        epoch = (review_store.evidence_epoch(self.db_path, row["id"], warning) if latch
                 else row["evidence_revision"])
        # Hash private identity/path as well, while disclosing neither to the renderer.
        fingerprint = windows.parameter_hash({"binding": binding, "parameters": run["parameters"],
                                               "evidence_revision": epoch,
                                               "image_sha256": row["image_sha256"],
                                               "image_bytes": row["image_bytes"],
                                               "summary_status": row["status"],
                                               "summary_error": row["error_code"]})
        return {"binding": public, "source_state": state, "warning": warning, "fingerprint": fingerprint,
                "evidence_revision": epoch}

    @staticmethod
    def _header(projection: dict, evidence: dict) -> dict:
        recorded = projection["decision"] != "unreviewed"
        verification = projection["verification"] or {}
        warning = evidence["warning"]
        if recorded and verification.get("fingerprint") != evidence["fingerprint"]:
            warning = warning or "review_binding_mismatch"
        needs = recorded and warning is not None
        return {"revision": projection["revision"], "decision": projection["decision"],
                "effective_decision": "unreviewed" if needs else projection["decision"],
                "needs_reverification": needs, "verification_warning": warning,
                "observation_count": projection.get("observation_count", len(projection.get("observations", [])))}

    def _window(self, window_id: str) -> tuple[dict, dict]:
        self._schema()
        row = summary_store.private_window(self.db_path, window_id)
        if row is None:
            raise _error("review_missing", "The selected summary window does not exist.", 404)
        private = summary_store.private_run(self.db_path, row["run_id"])
        return private, row

    def get(self, window_id: str) -> dict:
        private, row = self._window(window_id)
        projection = review_store.get(self.db_path, window_id)
        evidence = self._evidence(private, row, latch=projection["decision"] != "unreviewed")
        return {**projection, **self._header(projection, evidence), "run_id": row["run_id"], "window_id": window_id,
                "source_state": evidence["source_state"], "can_verify": evidence["warning"] is None,
                "binding": evidence["binding"]}

    def augment_summary(self, detail: dict) -> dict:
        if store.schema_version(self.db_path) not in store.REVIEW_SCHEMA_VERSIONS:
            return detail
        private = summary_store.private_run(self.db_path, detail["id"])
        headers = review_store.headers(self.db_path, detail["id"])
        rows = {row["id"]: row for row in private["windows"]}
        sources: dict = {}
        plans: dict = {}
        reviewed, needs = 0, 0
        for window in detail["windows"]:
            projection = headers[window["id"]]
            recorded = projection["decision"] != "unreviewed"
            evidence = self._evidence(private, rows[window["id"]],
                                      check_image=recorded, sources=sources, plans=plans, latch=recorded)
            header = self._header(projection, evidence)
            window["review"] = header
            reviewed += header["effective_decision"] != "unreviewed"
            needs += header["needs_reverification"]
        total = private["run"]["expected_windows"]
        detail["review_progress"] = {"total": total, "reviewed": reviewed, "unreviewed": total - reviewed,
                                     "quality_flagged": sum(bool(row["flags"]) for row in private["windows"]),
                                     "failed": sum(row["status"] == "failed" for row in private["windows"]),
                                     "incomplete": sum(row["status"] == "incomplete" for row in private["windows"]),
                                     "needs_reverification": needs}
        return detail

    def _receipt(self, preview_id: str | None, row: dict, evidence: dict) -> dict:
        if evidence["warning"] is not None or preview_id is None or self.previews is None:
            raise _error("review_unavailable", "Verify this finite window against its available original preview before completing review.")
        try:
            preview = self.previews.get(preview_id)
            manifest = preview["manifest"]
            actual = Fraction(int(manifest["actual_pts"]))
            interval = row["interval"]
            if (preview["state"] != "ready" or preview["segment_id"] != row["segment_id"]
                    or manifest["segment_id"] != row["segment_id"]
                    or manifest["source_sha256"] != row["source_sha256"] or manifest["time_base"] != row["time_base"]
                    or not windows.fraction(interval["start_pts"]) <= actual < windows.fraction(interval["end_pts"])):
                raise ValueError("Preview does not verify the selected source window")
        except (ImportErrorResponse, TypeError, ValueError, KeyError, ZeroDivisionError):
            raise _error("review_unavailable", "The original preview is unavailable or does not verify this window. Request its source preview again.") from None
        return {"fingerprint": evidence["fingerprint"], "evidence_revision": evidence["evidence_revision"],
                "source_sha256": row["source_sha256"],
                "parameter_hash": evidence["binding"]["parameter_hash"], "interval": row["interval"],
                "image_sha256": row["image_sha256"], "preview": {"id": preview_id,
                    "segment_id": manifest["segment_id"], "source_sha256": manifest["source_sha256"],
                    "actual_pts": manifest["actual_pts"], "time_base": manifest["time_base"]}}

    def save(self, window_id: str, change: dict | Change) -> dict:
        if isinstance(change, dict):
            try:
                change = CHANGE_ADAPTER.validate_python(change)
            except ValidationError:
                raise _error("review_invalid", "Provide exactly the supported manual review action fields.", 422) from None
        payload = change.model_dump(mode="json")
        if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > MAX_ACTION_BYTES:
            raise _error("review_invalid", "Review actions must not exceed 8 KiB.", 413)
        if not self.activity_lock.acquire(blocking=False):
            raise _error("review_busy", "Wait for the active media operation before saving review. Your draft remains unsaved.")
        try:
            private, row = self._window(window_id)
            if private["run"]["state"] in {"queued", "running"}:
                raise _error("review_busy", "Wait for this summary run to stop before recording review.")
            preview_id = payload.pop("preview_id", None)
            verification = None
            if payload.get("decision", "unreviewed") != "unreviewed":
                verification = self._receipt(preview_id, row, self._evidence(private, row, latch=True))
            review_store.apply(self.db_path, window_id, **payload, verification=verification)
            return self.get(window_id)
        finally:
            self.activity_lock.release()

    def history(self, window_id: str, after_revision: int = 0) -> dict:
        self._schema()
        return review_store.history(self.db_path, window_id, after_revision=after_revision, limit=50)


def install_routes(app: FastAPI, service: ReviewService, authenticate) -> None:
    @app.post("/api/reviews/upgrade", dependencies=[Depends(authenticate)])
    def upgrade(_payload: StrictModel = Body(default_factory=StrictModel)) -> dict[str, int]:
        if not service.activity_lock.acquire(blocking=False):
            raise _error("review_busy", "Wait for the active media operation before upgrading review storage.")
        try:
            review_store.upgrade(service.db_path)
        except (store.DatabaseSchemaError, sqlite3.DatabaseError):
            raise _error("review_upgrade_failed", "The review schema upgrade failed; the existing database was preserved.") from None
        finally:
            service.activity_lock.release()
        return {"schema_version": store.schema_version(service.db_path)}

    @app.get("/api/summary-windows/{window_id}/review", dependencies=[Depends(authenticate)])
    def get(window_id: UUID) -> dict:
        return service.get(str(window_id))

    @app.post("/api/summary-windows/{window_id}/review-actions", dependencies=[Depends(authenticate)])
    async def save(window_id: UUID, request: Request) -> dict:
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > MAX_ACTION_BYTES:
                raise _error("review_invalid", "Review actions must not exceed 8 KiB.", 413)
            raw.extend(chunk)
        try:
            change = CHANGE_ADAPTER.validate_json(bytes(raw))
        except ValidationError:
            raise _error("review_invalid", "Provide exactly the supported manual review action fields.", 422) from None
        return await run_in_threadpool(service.save, str(window_id), change)

    @app.get("/api/summary-windows/{window_id}/review-history", dependencies=[Depends(authenticate)])
    def history(window_id: UUID, after_revision: int = Query(default=0, ge=0, le=MAX_REVISION)) -> dict:
        return service.history(str(window_id), after_revision)
