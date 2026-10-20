"""Single-machine, loopback-only API for Bat Innovation."""

from __future__ import annotations

import os
import json
import sqlite3
from threading import Lock
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import Body, Depends, FastAPI, Header, HTTPException, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from . import store, summary_store
from .imports import ImportErrorResponse, ImportJobs, source_state
from .preview import PreviewJobs
from .summary_jobs import SummaryJobs
from .reviews import ReviewService, install_routes as install_review_routes
from .qa import QAService, install_routes as install_qa_routes
from .export_jobs import ExportJobs


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    api_token: str

    @classmethod
    def from_environment(cls) -> Settings:
        raw_dir = os.environ.get("BAT_APP_DATA_DIR")
        token = os.environ.get("BAT_API_TOKEN", "")
        if not raw_dir:
            raise RuntimeError("BAT_APP_DATA_DIR must be configured")
        data_dir = Path(raw_dir)
        if not data_dir.is_absolute():
            raise RuntimeError("BAT_APP_DATA_DIR must be an absolute path")
        if len(token) < 32:
            raise RuntimeError("BAT_API_TOKEN must be a random token of at least 32 characters")
        return cls(data_dir=data_dir, api_token=token)


class NewSession(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str = Field(min_length=1, max_length=120)
    camera_ref: str = Field(min_length=1, max_length=120)

    @field_validator("display_name", "camera_ref")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Must not be blank")
        return value.strip()


class Session(BaseModel):
    id: str
    display_name: str
    camera_ref: str
    created_at_utc: str


class NewImport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: UUID
    paths: list[str] = Field(min_length=1, max_length=64)


class EmptyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NewExport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_id: UUID


class NewSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: UUID
    window_seconds: int = Field(default=30, ge=1, le=120, strict=True)


class NewPreview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    segment_id: UUID
    source_pts: str = Field(pattern=r"^-?\d{1,19}$", max_length=20)

    @field_validator("source_pts")
    @classmethod
    def signed_64_bit(cls, value: str) -> str:
        if not -(2 ** 63) <= int(value) < 2 ** 63:
            raise ValueError("Source PTS must fit a signed 64-bit integer")
        return str(int(value))


class Continuity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    segment_id: UUID
    status: Literal["unknown", "known_contiguous", "known_gap"]
    provenance: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def explicit_provenance(self) -> Continuity:
        self.provenance = self.provenance.strip() if self.provenance else None
        if self.status != "unknown" and not self.provenance:
            raise ValueError("Known continuity requires provenance")
        return self


class ClockAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    segment_id: UUID
    utc: datetime
    provenance: str = Field(min_length=1, max_length=500)

    @field_validator("utc", mode="before")
    @classmethod
    def iso_clock(cls, value: object) -> object:
        if not isinstance(value, str):
            raise ValueError("Clock anchor must be an ISO timestamp with an explicit timezone")
        # Pydantic also treats numeric strings as Unix seconds; the API accepts ISO clock observations only.
        try:
            datetime.fromisoformat(value)
        except ValueError:
            raise ValueError("Clock anchor must be an ISO timestamp with an explicit timezone") from None
        return value

    @field_validator("utc")
    @classmethod
    def absolute_time(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Clock anchor must include an explicit timezone")
        return value.astimezone(timezone.utc)

    @field_validator("provenance")
    @classmethod
    def provenance_nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Clock provenance must not be blank")
        return value.strip()


class MediaOrder(BaseModel):
    model_config = ConfigDict(extra="forbid")
    segment_ids: list[UUID] = Field(max_length=10000)
    continuity: list[Continuity] = Field(max_length=10000)
    clock_anchor: ClockAnchor | None


def create_app(settings: Settings) -> FastAPI:
    """Fail on missing prerequisites rather than masking runtime failures."""
    if not settings.data_dir.is_absolute():
        raise RuntimeError("Application data directory must be absolute")
    if len(settings.api_token) < 32:
        raise RuntimeError("A per-launch API token of at least 32 characters is required")
    db_path = settings.data_dir / "bat_innovation.sqlite3"
    store.initialise(db_path)
    activity_lock = Lock()
    jobs = ImportJobs(db_path, settings.data_dir, activity_lock)
    previews = PreviewJobs(db_path, settings.data_dir, activity_lock)
    summaries = SummaryJobs(db_path, settings.data_dir, activity_lock)
    reviews = ReviewService(db_path, summaries, previews, activity_lock)
    qa = QAService(reviews)
    exports = ExportJobs(db_path, settings.data_dir)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        exports.close()
        summaries.close()
        previews.close()
        jobs.close()

    app = FastAPI(title="Bat Innovation local API", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request, error: RequestValidationError):
        # Default validation responses echo input, which could expose selected private paths.
        return JSONResponse(status_code=422, content={"detail": [
            {"loc": item["loc"], "msg": item["msg"], "type": item["type"]} for item in error.errors()
        ]})

    @app.exception_handler(ImportErrorResponse)
    async def import_error(_request, error: ImportErrorResponse):
        return JSONResponse(status_code=error.status, content={"detail": {"code": error.code, "message": error.message}})

    def authenticate(x_bat_token: str | None = Header(default=None)) -> None:
        # Token is assigned by the desktop shell at launch and never bundled in JS.
        from secrets import compare_digest

        if x_bat_token is None or not compare_digest(x_bat_token, settings.api_token):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid local session token")

    @app.get("/api/health", dependencies=[Depends(authenticate)])
    def health() -> dict[str, str]:
        return {"status": "ok", "storage": "ready"}

    @app.get("/api/sessions", response_model=list[Session], dependencies=[Depends(authenticate)])
    def get_sessions() -> list[dict[str, str]]:
        return store.list_sessions(db_path)

    @app.post("/api/sessions", response_model=Session, status_code=status.HTTP_201_CREATED, dependencies=[Depends(authenticate)])
    def post_session(payload: NewSession) -> dict[str, str]:
        return store.create_session(db_path, payload.display_name, payload.camera_ref)

    def require_session(session_id: str) -> None:
        if not store.session_exists(db_path, session_id):
            raise ImportErrorResponse("session_missing", "The selected recording session does not exist.", 404)

    def require_media_schema() -> None:
        if store.schema_version(db_path) not in store.MEDIA_SCHEMA_VERSIONS:
            raise ImportErrorResponse("schema_upgrade_required", "Explicitly upgrade the local database before importing media.", 409)

    def media_inventory(session_id: str) -> dict:
        require_session(session_id)
        return {"session_id": session_id, "schema_version": store.schema_version(db_path),
                "segments": [{"id": row["id"], "position": row["position"], "continuity": row["continuity"],
                              "continuity_provenance": row["continuity_provenance"], "source_state": source_state(row),
                              "metadata": json.loads(row["metadata_json"])}
                             for row in store.private_segments(db_path, session_id)],
                "clock_anchor": store.clock_anchor(db_path, session_id), "active_import": jobs.active(session_id)}

    @app.post("/api/media/upgrade", dependencies=[Depends(authenticate)])
    def upgrade(_payload: EmptyRequest = Body(default_factory=EmptyRequest)) -> dict[str, int]:
        try:
            store.upgrade_media(db_path)
        except (store.DatabaseSchemaError, sqlite3.DatabaseError):
            raise ImportErrorResponse("schema_upgrade_failed", "The media schema upgrade failed; the existing database was preserved.", 409) from None
        return {"schema_version": store.schema_version(db_path)}

    @app.get("/api/sessions/{session_id}/media", dependencies=[Depends(authenticate)])
    def get_media(session_id: UUID) -> dict:
        return media_inventory(str(session_id))

    @app.put("/api/sessions/{session_id}/media", dependencies=[Depends(authenticate)])
    def put_media(session_id: UUID, payload: MediaOrder) -> dict:
        session = str(session_id)
        require_session(session)
        require_media_schema()
        try:
            store.update_media(db_path, session, [str(item) for item in payload.segment_ids],
                               [item.model_dump(mode="json") for item in payload.continuity],
                               payload.clock_anchor.model_dump(mode="json") if payload.clock_anchor else None)
        except ValueError as error:
            raise ImportErrorResponse("invalid_timeline", str(error)) from None
        return media_inventory(session)

    @app.post("/api/media/import", status_code=202, dependencies=[Depends(authenticate)])
    def post_import(payload: NewImport) -> dict:
        session = str(payload.session_id)
        require_session(session)
        require_media_schema()
        return jobs.start(session, payload.paths)

    @app.get("/api/media/import/{job_id}", dependencies=[Depends(authenticate)])
    def get_import(job_id: UUID) -> dict:
        return jobs.get(str(job_id))

    @app.post("/api/media/import/{job_id}/cancel", dependencies=[Depends(authenticate)])
    def cancel_import(job_id: UUID, _payload: EmptyRequest = Body(default_factory=EmptyRequest)) -> dict:
        return jobs.cancel(str(job_id))

    @app.post("/api/media/preview", status_code=202, dependencies=[Depends(authenticate)])
    def post_preview(payload: NewPreview) -> dict:
        return previews.start(str(payload.segment_id), payload.source_pts)

    @app.get("/api/media/preview/{preview_id}", dependencies=[Depends(authenticate)])
    def get_preview(preview_id: UUID) -> dict:
        return previews.get(str(preview_id))

    @app.post("/api/media/preview/{preview_id}/cancel", dependencies=[Depends(authenticate)])
    def cancel_preview(preview_id: UUID, _payload: EmptyRequest = Body(default_factory=EmptyRequest)) -> dict:
        return previews.cancel(str(preview_id))

    @app.get("/api/media/preview/{preview_id}/content", dependencies=[Depends(authenticate)])
    def preview_content(preview_id: UUID) -> Response:
        return Response(previews.content(str(preview_id)), media_type="video/webm", headers={"Cache-Control": "no-store"})

    @app.post("/api/summaries/upgrade", dependencies=[Depends(authenticate)])
    def upgrade_summaries(_payload: EmptyRequest = Body(default_factory=EmptyRequest)) -> dict[str, int]:
        if not activity_lock.acquire(blocking=False):
            raise ImportErrorResponse("summary_busy", "Wait for the active media operation before upgrading storage.", 409)
        try:
            summary_store.upgrade(db_path)
        except (store.DatabaseSchemaError, sqlite3.DatabaseError):
            raise ImportErrorResponse("summary_upgrade_failed", "The summary schema upgrade failed; the existing database was preserved.", 409) from None
        finally:
            activity_lock.release()
        return {"schema_version": store.schema_version(db_path)}

    @app.get("/api/sessions/{session_id}/summary-runs", dependencies=[Depends(authenticate)])
    def list_summaries(session_id: UUID) -> list[dict]:
        require_session(str(session_id))
        return summaries.list(str(session_id))

    @app.post("/api/summaries", status_code=202, dependencies=[Depends(authenticate)])
    def start_summaries(payload: NewSummary) -> dict:
        require_session(str(payload.session_id))
        return qa.augment_summary(reviews.augment_summary(summaries.start(str(payload.session_id), payload.window_seconds)))

    @app.get("/api/summaries/{run_id}", dependencies=[Depends(authenticate)])
    def get_summary(run_id: UUID) -> dict:
        return qa.augment_summary(reviews.augment_summary(summaries.get(str(run_id))))

    @app.post("/api/summaries/{run_id}/cancel", dependencies=[Depends(authenticate)])
    def cancel_summary(run_id: UUID, _payload: EmptyRequest = Body(default_factory=EmptyRequest)) -> dict:
        return qa.augment_summary(reviews.augment_summary(summaries.cancel(str(run_id))))

    @app.get("/api/summary-windows/{window_id}/image", dependencies=[Depends(authenticate)])
    def summary_image(window_id: UUID) -> Response:
        return Response(summaries.image(str(window_id)), media_type="image/png", headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    @app.post("/api/exports", status_code=202, dependencies=[Depends(authenticate)])
    def start_export(payload: NewExport) -> dict:
        return exports.start(str(payload.run_id))

    @app.get("/api/exports/{job_id}", dependencies=[Depends(authenticate)])
    def export_status(job_id: UUID) -> dict:
        return exports.get(str(job_id))

    @app.post("/api/exports/{job_id}/cancel", dependencies=[Depends(authenticate)])
    def cancel_export(job_id: UUID, _payload: EmptyRequest = Body(default_factory=EmptyRequest)) -> dict:
        return exports.cancel(str(job_id))

    @app.get("/api/exports/{job_id}/files/{kind}", dependencies=[Depends(authenticate)])
    def export_content(job_id: UUID, kind: Literal["observations", "audit", "manifest"]):
        chunks, size = exports.content(str(job_id), kind)
        mime = "application/json" if kind == "manifest" else "text/csv; charset=utf-8"
        return StreamingResponse(chunks, media_type=mime, headers={"Content-Length": str(size), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    install_review_routes(app, reviews, authenticate)
    install_qa_routes(app, qa, authenticate)
    return app
