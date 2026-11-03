"""Site templates (Phase 3 X4): saved geometry and settings, applied to a new survey with one reconfirmation."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from backend.app import store, template_store
from backend.app.main import Settings, create_app
from backend.tests.test_counts import gate_value, tracked
from backend.tests.test_import import HEADERS, TOKEN
from backend.tests.test_tracking import scenario

SETTINGS = {"target_px": 6, "polarity": "light", "exclusions": [[[0, 80], [128, 80], [128, 96], [0, 96]]]}


def test_a_template_places_gates_that_wait_for_one_reconfirmation(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, run_id, _summary = tracked(client, tmp_path, scenario("two_dots"))
        saved = client.post("/api/site-templates", headers=HEADERS, json={"name": "Church north gable", "actor": "Reviewer One",
                            "frame_w": 128, "frame_h": 96, "settings": SETTINGS, "gates": [gate_value()]})
        assert saved.status_code == 200, saved.text
        template = saved.json()
        assert template["format"] == "bat-site-template-v1" and template["gates"][0]["name"] == "Roost gap"
        assert [item["id"] for item in client.get("/api/site-templates", headers=HEADERS).json()] == [template["id"]]
        wrong = client.post(f"/api/site-templates/{template['id']}/apply", headers=HEADERS,
                            json={"actor": "Reviewer One", "session_id": session_id, "frame_w": 1920, "frame_h": 1080})
        assert wrong.status_code == 409 and wrong.json()["detail"]["code"] == "template_frame"
        applied = client.post(f"/api/site-templates/{template['id']}/apply", headers=HEADERS,
                              json={"actor": "Reviewer One", "session_id": session_id, "frame_w": 128, "frame_h": 96}).json()
        (gate,) = applied["gates"]
        assert gate["template_id"] == template["id"] and applied["template"]["settings"]["target_px"] == 6
        url = f"/api/tracking/{run_id}/gates/{gate['id']}"
        counts = client.get(f"{url}/counts", headers=HEADERS).json()
        assert [span["reason"] for span in counts["invalid_spans"]] == ["template"] and counts["crossings"] == []
        span = counts["invalid_spans"][0]
        resumed = client.post(f"{url}/reconfirm", headers=HEADERS, json={"actor": "Reviewer One", "anchor_kind": span["anchor_kind"],
                              "anchor_id": span["anchor_id"], "points": None, "note": "Same view as last year"}).json()
        assert resumed["invalid_spans"] == [] and len(resumed["crossings"]) == 2
        retired = client.post(f"/api/site-templates/{template['id']}/retire", headers=HEADERS).json()
        assert retired["retired"] and client.get("/api/site-templates", headers=HEADERS).json() == []


def test_template_files_are_checked_on_import(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        tracked(client, tmp_path, scenario("two_dots"))
        good = {"format": "bat-site-template-v1", "name": "Bridge east", "frame_w": 128, "frame_h": 96, "settings": SETTINGS, "gates": [gate_value()]}
        imported = client.post("/api/site-templates/import", headers=HEADERS, json={"actor": "Reviewer Two", "data": good})
        assert imported.status_code == 200 and imported.json()["actor"] == "Reviewer Two"
        for bad in ({**good, "format": "other"}, {**good, "settings": {"sensitivity": 12}}, {**good, "gates": [gate_value(frame_w=640)]},
                    {**good, "gates": [gate_value(entry_direction="out_to_in")]}):
            refused = client.post("/api/site-templates/import", headers=HEADERS, json={"actor": "Reviewer Two", "data": bad})
            assert refused.status_code == 422 and refused.json()["detail"]["code"] == "template_invalid", bad


def test_template_upgrade_from_v14(tmp_path: Path) -> None:
    from backend.app import audio_store, candidate_store, count_store, proxy_store, sample_store, tracking_store
    from backend.tests.test_thermal import legacy_v5

    db_path = legacy_v5(tmp_path)
    for step in (store.upgrade_modality, tracking_store.upgrade, count_store.upgrade, candidate_store.upgrade, audio_store.upgrade,
                 proxy_store.upgrade, tracking_store.upgrade_v2, count_store.upgrade_spans, sample_store.upgrade):
        step(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE site_template (conflict TEXT)")
    with pytest.raises(sqlite3.OperationalError):
        template_store.upgrade(db_path)
    assert store.schema_version(db_path) == store.SAMPLE_CHECK_SCHEMA_VERSION
    with sqlite3.connect(db_path) as connection:
        connection.execute("DROP TABLE site_template")
    template_store.upgrade(db_path)
    assert store.schema_version(db_path) == store.TEMPLATE_SCHEMA_VERSION
