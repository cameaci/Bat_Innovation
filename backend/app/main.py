"""Single-machine, loopback-only API for Bat Innovation."""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field, field_validator

from .store import create_session, initialise, list_sessions


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
    initialise(db_path)

    app = FastAPI(title="Bat Innovation local API", docs_url=None, redoc_url=None, openapi_url=None)

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
        return list_sessions(db_path)

    @app.post("/api/sessions", response_model=Session, status_code=status.HTTP_201_CREATED, dependencies=[Depends(authenticate)])
    def post_session(payload: NewSession) -> dict[str, str]:
        return create_session(db_path, payload.display_name, payload.camera_ref)

    return app
