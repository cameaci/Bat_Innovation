"""Rendered thermal modality (feature expansion E1): explicit storage, declared modality and labelled evidence."""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import av
import numpy as np
from fastapi.testclient import TestClient
import pytest

from backend.app import media, motion, qa_store, review_store, store, summary_store, windows
from backend.app.main import Settings, create_app
from backend.tests.summary_fixtures import encode_frames
from backend.tests.test_import import HEADERS, TOKEN, import_files, inventory, session

TIMES = [0, 40, 80, 120, 160, 200]


def legacy_v5(data_dir: Path) -> Path:
    db_path = data_dir / "bat_innovation.sqlite3"
    store.initialise(db_path)
    for step in (store.upgrade_media, summary_store.upgrade, review_store.upgrade, qa_store.upgrade):
        step(db_path)
    assert store.schema_version(db_path) == store.QA_SCHEMA_VERSION
    return db_path


def dot_frames(palette: str) -> list[np.ndarray]:
    """A moving 3x3 target rendered white-hot, black-hot or with a false-colour palette."""
    frames = []
    for index in range(len(TIMES)):
        if palette == "false_colour":
            frame = np.zeros((48, 64, 3), dtype=np.uint8)
            frame[...] = (40, 0, 90)  # cool background (purple)
            frame[20:23, 8 + index * 8:11 + index * 8] = (255, 220, 0)  # warm target (yellow)
        else:
            frame = np.full((48, 64), 40 if palette == "white_hot" else 215, dtype=np.uint8)
            frame[20:23, 8 + index * 8:11 + index * 8] = 230 if palette == "white_hot" else 20
        frames.append(frame)
    return frames


@pytest.mark.parametrize("palette", ["white_hot", "black_hot", "false_colour"])
def test_rendered_thermal_motion_is_visible_and_labelled_not_temperature(tmp_path: Path, palette: str) -> None:
    source = tmp_path / f"{palette}.mp4"
    encode_frames(source, dot_frames(palette), TIMES)
    metadata = {**media.inspect_source(source), "modality": "rendered_thermal"}
    evidence = motion.Evidence(windows.plan_source(metadata)[0], windows.fraction(metadata["time_base"]), windows.parameters(), metadata)
    previous = None
    with av.open(str(source)) as container:
        for frame in media.decoded_frames(container, container.streams.video[0]):
            gray = frame.to_ndarray(format="gray")
            evidence.add(gray, frame.pts, previous)
            previous = gray
    assert int(evidence.planes.sum()) > 0, "Palette luminance must still show the moving target"
    assert {"rendered_thermal_display", "palette_luma_not_temperature"} <= evidence.flags
    image = evidence.png("33333333-3333-4333-8333-333333333333", windows.parameter_hash(windows.parameters()))
    assert image.startswith(b"\x89PNG")


def test_active_ir_evidence_has_no_thermal_flags(tmp_path: Path) -> None:
    source = tmp_path / "ir.mp4"
    encode_frames(source, dot_frames("white_hot"), TIMES)
    metadata = media.inspect_source(source)
    evidence = motion.Evidence(windows.plan_source(metadata)[0], windows.fraction(metadata["time_base"]), windows.parameters(), metadata)
    assert not {"rendered_thermal_display", "palette_luma_not_temperature"} & evidence.flags


def test_modality_upgrade_is_explicit_transactional_and_idempotent(tmp_path: Path) -> None:
    db_path = legacy_v5(tmp_path)
    store.upgrade_modality(db_path)
    store.upgrade_modality(db_path)
    assert store.schema_version(db_path) == store.MODALITY_SCHEMA_VERSION
    with sqlite3.connect(db_path) as connection:
        assert {row[1] for row in connection.execute("PRAGMA table_info(segment)")} >= {"modality", "modality_provenance"}


def test_failed_modality_upgrade_rolls_back_to_v5(tmp_path: Path) -> None:
    db_path = legacy_v5(tmp_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute("ALTER TABLE segment ADD COLUMN modality TEXT")  # conflicting earlier column
    with pytest.raises(sqlite3.OperationalError):
        store.upgrade_modality(db_path)
    assert store.schema_version(db_path) == store.QA_SCHEMA_VERSION


def test_thermal_import_requires_storage_upgrade_then_records_declared_modality(tmp_path: Path) -> None:
    data_dir = tmp_path / "app-data"
    data_dir.mkdir()
    legacy_v5(data_dir)
    source = tmp_path / "thermal.mp4"
    encode_frames(source, dot_frames("false_colour"), TIMES)
    with TestClient(create_app(Settings(data_dir, TOKEN))) as client:
        session_id = session(client)
        refused = client.post("/api/media/import", headers=HEADERS,
                              json={"session_id": session_id, "paths": [str(source)], "modality": "rendered_thermal"})
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "schema_upgrade_required"
        bad = client.post("/api/media/import", headers=HEADERS,
                          json={"session_id": session_id, "paths": [str(source)], "modality": "radiometric"})
        assert bad.status_code == 422
        upgrade = client.post("/api/storage/upgrade", headers=HEADERS)
        assert upgrade.status_code == 200 and upgrade.json()["schema_version"] == store.CURRENT_SCHEMA_VERSION
        response = client.post("/api/media/import", headers=HEADERS,
                               json={"session_id": session_id, "paths": [str(source)], "modality": "rendered_thermal"})
        assert response.status_code == 202
        deadline = time.monotonic() + 10
        while client.get(f"/api/media/import/{response.json()['id']}", headers=HEADERS).json()["state"] == "running":
            assert time.monotonic() < deadline
            time.sleep(0.05)
        segment = inventory(client, session_id)["segments"][0]
        assert segment["modality"] == "rendered_thermal" and segment["modality_provenance"] == "declared at import"
        started = client.post("/api/summaries", headers=HEADERS, json={"session_id": session_id, "window_seconds": 30})
        assert started.status_code == 202, started.text
        deadline = time.monotonic() + 30
        while (run := client.get(f"/api/summaries/{started.json()['id']}", headers=HEADERS).json())["state"] in ("queued", "running"):
            assert time.monotonic() < deadline
            time.sleep(0.1)
        assert run["state"] == "complete"
        assert "rendered_thermal_display" in run["windows"][0]["flags"]


def test_storage_upgrade_refuses_a_database_below_qa(tmp_path: Path) -> None:
    data_dir = tmp_path / "app-data"
    data_dir.mkdir()
    store.initialise(data_dir / "bat_innovation.sqlite3")
    with TestClient(create_app(Settings(data_dir, TOKEN))) as client:
        response = client.post("/api/storage/upgrade", headers=HEADERS)
        assert response.status_code == 409 and response.json()["detail"]["code"] == "schema_upgrade_required"


def test_default_import_stays_active_ir(tmp_path: Path) -> None:
    source = tmp_path / "ir.mp4"
    encode_frames(source, dot_frames("white_hot"), TIMES)
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id = session(client)
        assert import_files(client, session_id, [source])["state"] == "complete"
        assert inventory(client, session_id)["segments"][0]["modality"] == "active_ir"


def test_radiometric_thermal_files_are_refused_explicitly(tmp_path: Path) -> None:
    radiometric = tmp_path / "camera.seq"
    radiometric.write_bytes(b"synthetic radiometric container")
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        response = client.post("/api/media/import", headers=HEADERS, json={
            "session_id": session(client), "paths": [str(radiometric)], "modality": "rendered_thermal"})
        assert response.status_code == 400 and response.json()["detail"]["code"] == "invalid_sources"
