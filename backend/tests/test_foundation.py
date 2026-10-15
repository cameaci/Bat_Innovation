"""Slice 0: local authenticated API, storage and explicit failure handling."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.main import Settings, create_app
from backend.app.store import initialise

TOKEN = "a-private-local-launch-token-that-is-long-enough"


def test_session_persists_between_app_restarts(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path, api_token=TOKEN)
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/health").status_code == 401
        assert client.get("/api/sessions").status_code == 401
        headers = {"X-Bat-Token": TOKEN}
        assert client.get("/api/health", headers=headers).json() == {
            "status": "ok", "storage": "ready", "media_tools": "ready"
        }
        res = client.post("/api/sessions", headers=headers, json={
            "display_name": "Synthetic survey", "camera_ref": "Test camera"
        })
        assert res.status_code == 201
        created = res.json()
        assert created["display_name"] == "Synthetic survey"
        assert len(client.get("/api/sessions", headers=headers).json()) == 1

    with TestClient(create_app(settings)) as reopened:
        records = reopened.get("/api/sessions", headers={"X-Bat-Token": TOKEN}).json()
        assert len(records) == 1
        assert records[0]["id"] == created["id"]


def test_blank_session_and_wrong_token_are_rejected(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(tmp_path, TOKEN)))
    assert client.post("/api/sessions", headers={"X-Bat-Token": "x"}, json={
        "display_name": "Foo", "camera_ref": "Camera"
    }).status_code == 401
    assert client.post("/api/sessions", headers={"X-Bat-Token": TOKEN}, json={
        "display_name": "   ", "camera_ref": "Camera"
    }).status_code == 422
    assert client.get("/api/sessions", headers={"X-Bat-Token": TOKEN}).json() == []


def test_unknown_schema_refused_without_mutation(tmp_path: Path) -> None:
    file = tmp_path / "database.sqlite3"
    with sqlite3.connect(file) as conn:
        conn.execute("PRAGMA user_version=99")
    with pytest.raises(RuntimeError, match="Unsupported database schema"):
        initialise(file)
    with sqlite3.connect(file) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 99


def test_unversioned_database_is_refused(tmp_path: Path) -> None:
    file = tmp_path / "database.sqlite3"
    with sqlite3.connect(file) as conn:
        conn.execute("CREATE TABLE legacy (id INTEGER)")
    with pytest.raises(RuntimeError, match="unversioned database"):
        initialise(file)


def test_missing_media_tool_is_explicit(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="Required media tool is unavailable"):
        create_app(Settings(tmp_path, TOKEN, ffprobe="a-nonexistent-ffprobe-command"))


def test_missing_config_is_explicit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BAT_APP_DATA_DIR", raising=False)
    monkeypatch.delenv("BAT_API_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="BAT_APP_DATA_DIR"):
        Settings.from_environment()
