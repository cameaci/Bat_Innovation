"""Rendered overlay and highlights videos (Phase 3 X8)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import av
import numpy as np
from fastapi.testclient import TestClient
import pytest

from backend.app import renders, store
from backend.app.main import Settings, create_app
from backend.tests.test_counts import gate_value, tracked
from backend.tests.test_import import HEADERS, TOKEN
from backend.tests.test_tracking import frame, path, scenario, wait


def render(client: TestClient, session_id: str, run_id: str, kind: str) -> dict:
    segment = client.get(f"/api/sessions/{session_id}/media", headers=HEADERS).json()["segments"][0]["id"]
    started = client.post("/api/renders", headers=HEADERS, json={"session_id": session_id, "segment_id": segment, "tracking_run_id": run_id, "kind": kind})
    assert started.status_code == 202, started.text
    return wait(client, f"/api/renders/{started.json()['id']}", ("queued", "running"), 120)


def frames_of(file: Path) -> list[np.ndarray]:
    with av.open(str(file)) as container:
        return [item.to_ndarray(format="rgb24") for item in container.decode(video=0)]


def test_the_overlay_video_draws_every_source_frame_with_the_watermark(tmp_path: Path) -> None:
    data = tmp_path / "app-data"
    with TestClient(create_app(Settings(data, TOKEN))) as client:
        session_id, run_id, _summary = tracked(client, tmp_path, scenario("two_dots"))
        client.post(f"/api/sessions/{session_id}/gates", headers=HEADERS, json={"actor": "Reviewer One", "expected_revision": 0, "value": gate_value()})
        done = render(client, session_id, run_id, "overlay")
        assert done["state"] == "ready", done
        result = done["result"]
        # One title card, then exactly one drawn frame per source frame.
        assert result["source_frames"] == result["drawn_source_frames"] == 20 and result["frames"] == 21 and result["skipped"] == []
        assert result["gates"][0]["gate_revision"] == 1
        file = data / "renders" / f"{done['id']}.webm"
        decoded = frames_of(file)
        assert len(decoded) == 21
        band = decoded[5][:12, :200].reshape(-1, 3).astype(int)
        assert ((band[:, 0] > 180) & (band[:, 1] > 130) & (band[:, 2] < 110)).any(), "the amber PROVISIONAL watermark is drawn"
        saved = client.get(f"/api/renders/{done['id']}/file", headers=HEADERS).json()
        assert saved["file_name"] == file.name and saved["bytes"] == file.stat().st_size
        assert [item["id"] for item in client.get(f"/api/renders?session_id={session_id}", headers=HEADERS).json()] == [done["id"]]
        # A changed file is refused rather than handed out.
        with file.open("r+b") as handle:
            handle.seek(200)
            handle.write(b"\x00\x01\x02")
        refused = client.get(f"/api/renders/{done['id']}/file", headers=HEADERS)
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "render_integrity"


def test_highlights_replace_every_skipped_span_with_a_card_of_its_exact_length(tmp_path: Path) -> None:
    data = tmp_path / "app-data"
    dot = path((4, 40), (5, 0), 20)
    quiet = [frame([]) for _ in range(30)]
    with TestClient(create_app(Settings(data, TOKEN))) as client:
        session_id, run_id, _summary = tracked(client, tmp_path, quiet + [frame([point]) for point in dot] + quiet)
        done = render(client, session_id, run_id, "highlights")
        assert done["state"] == "ready", done
        result = done["result"]
        # 80 frames at 25 fps; the target is seen from 1.2 s to 1.96 s and kept with a second either side.
        assert [item["seconds"] for item in result["skipped"]] == [0.2, 0.2]
        first = client.get(f"/api/sessions/{session_id}/media", headers=HEADERS).json()["segments"][0]["metadata"]["first_pts"]
        assert result["skipped"][0]["from_pts"] == first, "the first skipped span starts at the first frame"
        assert result["drawn_source_frames"] == 70 and result["frames"] == 1 + 70 + 2
        assert len(frames_of(data / "renders" / f"{done['id']}.webm")) == result["frames"]


def test_renders_need_a_complete_tracking_run_of_the_survey(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, _run, _summary = tracked(client, tmp_path, scenario("two_dots"))
        segment = client.get(f"/api/sessions/{session_id}/media", headers=HEADERS).json()["segments"][0]["id"]
        missing = client.post("/api/renders", headers=HEADERS, json={"session_id": session_id, "segment_id": segment,
                              "tracking_run_id": "00000000-0000-4000-8000-000000000000", "kind": "overlay"})
        assert missing.status_code == 404 and missing.json()["detail"]["code"] == "tracking_missing"
        assert client.get("/api/renders/00000000-0000-4000-8000-000000000000/file", headers=HEADERS).status_code == 404


def test_render_upgrade_from_v18(tmp_path: Path) -> None:
    from backend.app import audio_store, candidate_store, count_store, flow, label_store, proxy_store, sample_store, template_store, tracking_store
    from backend.tests.test_thermal import legacy_v5

    db_path = legacy_v5(tmp_path)
    for step in (store.upgrade_modality, tracking_store.upgrade, count_store.upgrade, candidate_store.upgrade, audio_store.upgrade,
                 proxy_store.upgrade, tracking_store.upgrade_v2, count_store.upgrade_spans, sample_store.upgrade,
                 template_store.upgrade, proxy_store.upgrade_kind, label_store.upgrade, flow.upgrade):
        step(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE render_job (conflict TEXT)")
    with pytest.raises(sqlite3.OperationalError):
        renders.upgrade(db_path)
    assert store.schema_version(db_path) == store.SUNSET_SCHEMA_VERSION
    with sqlite3.connect(db_path) as connection:
        connection.execute("DROP TABLE render_job")
    renders.upgrade(db_path)
    assert store.schema_version(db_path) == store.RENDER_SCHEMA_VERSION
    store.initialise(db_path)
