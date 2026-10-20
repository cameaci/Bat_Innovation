"""Slice 0: local authenticated API, storage and explicit failure handling."""

from __future__ import annotations

import sqlite3
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.main import Settings, create_app

TOKEN = "a-private-local-launch-token-that-is-long-enough"


def test_session_persists_between_app_restarts_without_media_cli(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PATH", "")
    assert shutil.which("ffmpeg") is None
    assert shutil.which("ffprobe") is None
    settings = Settings(data_dir=tmp_path, api_token=TOKEN)
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/health").status_code == 401
        assert client.get("/api/sessions").status_code == 401
        headers = {"X-Bat-Token": TOKEN}
        assert client.get("/api/health", headers=headers).json() == {
            "status": "ok", "storage": "ready"
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
    file = tmp_path / "bat_innovation.sqlite3"
    with sqlite3.connect(file) as conn:
        conn.execute("PRAGMA user_version=99")
    original = file.read_bytes()
    with pytest.raises(RuntimeError, match="Unsupported database schema"):
        create_app(Settings(tmp_path, TOKEN))
    assert file.read_bytes() == original
    with sqlite3.connect(file) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 99


def test_unversioned_database_is_refused(tmp_path: Path) -> None:
    file = tmp_path / "bat_innovation.sqlite3"
    with sqlite3.connect(file) as conn:
        conn.execute("CREATE TABLE legacy (id INTEGER)")
    original = file.read_bytes()
    with pytest.raises(RuntimeError, match="unversioned database"):
        create_app(Settings(tmp_path, TOKEN))
    assert file.read_bytes() == original


@pytest.mark.parametrize("module,error_type", [
    ("av", "ModuleNotFoundError"), ("av", "ImportError"), ("av", "OSError"),
    ("fastapi", "ModuleNotFoundError"), ("pydantic", "ModuleNotFoundError"),
    ("pydantic_core", "ModuleNotFoundError"), ("uvicorn", "ModuleNotFoundError"),
])
def test_missing_startup_dependency_prevents_launch(module: str, error_type: str) -> None:
    result = subprocess.run([
        sys.executable, "-B", "-c", """
import builtins
import sys
from importlib.abc import MetaPathFinder
import runpy

class MissingDependency(MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == sys.argv[1] or fullname.startswith(sys.argv[1] + "."):
            raise getattr(builtins, sys.argv[2])("Required startup dependency is missing: " + sys.argv[1])

sys.meta_path.insert(0, MissingDependency())
runpy.run_module("backend.app", run_name="__main__")
""", module, error_type,
    ], cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True, timeout=15)
    assert result.returncode != 0
    assert "Required startup dependency is missing: " + module in result.stderr


@pytest.mark.parametrize("data_dir,token,message", [
    (Path("relative"), TOKEN, "Application data directory must be absolute"),
    (None, "short", "per-launch API token"),
])
def test_invalid_startup_settings_are_rejected(
    tmp_path: Path, data_dir: Path | None, token: str, message: str,
) -> None:
    with pytest.raises(RuntimeError, match=message):
        create_app(Settings(data_dir if data_dir is not None else tmp_path, token))
    assert not (tmp_path / "bat_innovation.sqlite3").exists()


def test_missing_config_is_explicit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BAT_APP_DATA_DIR", raising=False)
    monkeypatch.delenv("BAT_API_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="BAT_APP_DATA_DIR"):
        Settings.from_environment()
