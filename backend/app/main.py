"""Single-machine, loopback-only API for Bat Innovation."""

from __future__ import annotations

import os
import json
import shutil
import sqlite3
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import Body, Depends, FastAPI, Header, HTTPException, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from . import store
from .imports import ImportErrorResponse, ImportJobs, source_state


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    api_token: str
    ffmpeg: str = "ffmpeg"
    ffprobe: str = "ffprobe"

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
    for executable in (settings.ffmpeg, settings.ffprobe):
        if shutil.which(executable) is None:
            raise RuntimeError(f"Required media tool is unavailable: {executable}")
    db_path = settings.data_dir / "bat_innovation.sqlite3"
    store.initialise(db_path)
    jobs = ImportJobs(db_path, settings.data_dir)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
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
        return {"status": "ok", "storage": "ready", "media_tools": "ready"}

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
        if store.schema_version(db_path) != store.MEDIA_SCHEMA_VERSION:
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
        return {"schema_version": store.MEDIA_SCHEMA_VERSION}

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

    return app
