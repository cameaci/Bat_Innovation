"""Group labels on tracks (Phase 3 X6): one audited event per action, undo as a new event, counts untouched."""

from __future__ import annotations

import csv
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from backend.app import label_store, store
from backend.app.main import Settings, create_app
from backend.tests.test_counts import gate_value, tracked
from backend.tests.test_import import HEADERS, TOKEN
from backend.tests.test_tracking import scenario


def test_a_group_label_is_one_event_and_undo_restores_the_earlier_label(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, run_id, _summary = tracked(client, tmp_path, scenario("two_dots"))
        gate = client.post(f"/api/sessions/{session_id}/gates", headers=HEADERS, json={"actor": "Reviewer One", "expected_revision": 0, "value": gate_value()}).json()
        before = client.get(f"/api/tracking/{run_id}/gates/{gate['id']}/counts", headers=HEADERS).json()
        ids = [item["track_id"] for item in client.get(f"/api/tracking/{run_id}/candidates", headers=HEADERS).json()]
        assert len(ids) == 2
        url = f"/api/tracking/{run_id}/labels"
        first = client.post(url, headers=HEADERS, json={"actor": "Reviewer One", "track_ids": ids[:1], "category": "foraging",
                                                        "species": "Pipistrellus pygmaeus"}).json()
        group = client.post(url, headers=HEADERS, json={"actor": "Reviewer One", "track_ids": ids, "category": "exit",
                                                        "species": "  Pipistrellus   pipistrellus ", "comment": "left the gable"}).json()
        assert len(group["events"]) == 2 and group["events"][1]["track_ids"] == ids
        assert {group["tracks"][item]["category"] for item in ids} == {"exit"}
        assert group["tracks"][ids[0]]["species"] == "Pipistrellus pipistrellus"
        undone = client.post(f"{url}/{group['events'][1]['id']}/undo", headers=HEADERS, json={"actor": "Reviewer Two"}).json()
        assert len(undone["events"]) == 3 and undone["events"][2]["undoes"] == group["events"][1]["id"]
        assert undone["tracks"] == {ids[0]: {**first["tracks"][ids[0]]}}
        again = client.post(f"{url}/{group['events'][1]['id']}/undo", headers=HEADERS, json={"actor": "Reviewer Two"})
        assert again.status_code == 409 and again.json()["detail"]["code"] == "label_conflict"
        # Labels never move a count layer.
        after = client.get(f"/api/tracking/{run_id}/gates/{gate['id']}/counts", headers=HEADERS).json()
        assert after["layers"] == before["layers"] and after["revision"] == before["revision"]
        # Labels survive a restart of the backend.
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        assert client.get(f"/api/tracking/{run_id}/labels", headers=HEADERS).json()["tracks"] == undone["tracks"]


def test_labels_refuse_foreign_tracks_and_a_seventh_custom_label(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        _session, run_id, _summary = tracked(client, tmp_path, scenario("two_dots"))
        ids = [item["track_id"] for item in client.get(f"/api/tracking/{run_id}/candidates", headers=HEADERS).json()]
        url = f"/api/tracking/{run_id}/labels"
        foreign = client.post(url, headers=HEADERS, json={"actor": "R", "track_ids": [ids[0], "00000000-0000-4000-8000-000000000000"], "category": "exit"})
        assert foreign.status_code == 422 and foreign.json()["detail"]["code"] == "label_invalid"
        assert client.post(url, headers=HEADERS, json={"actor": "  ", "track_ids": ids, "category": "exit"}).status_code == 422
        for index in range(label_store.MAX_CUSTOM):
            assert client.post(url, headers=HEADERS, json={"actor": "R", "track_ids": ids, "category": f"custom {index}"}).status_code == 200
        reused = client.post(url, headers=HEADERS, json={"actor": "R", "track_ids": ids, "category": "custom 0"})
        assert reused.status_code == 200 and reused.json()["custom"] == [f"custom {index}" for index in range(label_store.MAX_CUSTOM)]
        seventh = client.post(url, headers=HEADERS, json={"actor": "R", "track_ids": ids, "category": "custom 6"})
        assert seventh.status_code == 422 and seventh.json()["detail"]["code"] == "label_custom_limit"
        with sqlite3.connect(tmp_path / "app-data" / "bat_innovation.sqlite3") as connection, pytest.raises(sqlite3.IntegrityError):
            connection.execute("DELETE FROM track_label_event")


def test_labels_reach_the_tracks_csv(tmp_path: Path) -> None:
    from backend.app import csv_export

    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        _session, run_id, summary = tracked(client, tmp_path, scenario("two_dots"))
        ids = [item["track_id"] for item in client.get(f"/api/tracking/{run_id}/candidates", headers=HEADERS).json()]
        client.post(f"/api/tracking/{run_id}/labels", headers=HEADERS, json={"actor": "Reviewer One", "track_ids": ids[:1],
                    "category": "exit", "species": "=cmd", "comment": "first out"})
        directory = tmp_path / "bundle"
        directory.mkdir()
        files: dict = {}
        info = csv_export.expansion_rows(tmp_path / "app-data" / "bat_innovation.sqlite3", directory, summary["id"], "2026-10-28T00:00:00Z", lambda: None, files)
        assert info is not None and info["labels"]["labelled_tracks"] == 1 and info["labels"]["events"] == 1
        with open(directory / csv_export.FILES["tracks"], newline="", encoding="utf-8") as handle:
            rows = {csv_export.decode_text(row["track_id"]): row for row in csv.DictReader(handle)}
        assert rows[ids[0]]["label_category"] == "'exit" and rows[ids[0]]["label_actor"] == "'Reviewer One"
        assert rows[ids[0]]["label_species"] == "'=cmd", "free text is neutralised against spreadsheet formulas"
        assert rows[ids[1]]["label_category"] == ""


def test_label_upgrade_from_v16(tmp_path: Path) -> None:
    from backend.app import audio_store, candidate_store, count_store, proxy_store, sample_store, template_store, tracking_store
    from backend.tests.test_thermal import legacy_v5

    db_path = legacy_v5(tmp_path)
    for step in (store.upgrade_modality, tracking_store.upgrade, count_store.upgrade, candidate_store.upgrade, audio_store.upgrade,
                 proxy_store.upgrade, tracking_store.upgrade_v2, count_store.upgrade_spans, sample_store.upgrade,
                 template_store.upgrade, proxy_store.upgrade_kind):
        step(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE track_label_event (conflict TEXT)")
    with pytest.raises(sqlite3.OperationalError):
        label_store.upgrade(db_path)
    assert store.schema_version(db_path) == store.ENHANCED_SCHEMA_VERSION
    with sqlite3.connect(db_path) as connection:
        connection.execute("DROP TABLE track_label_event")
    label_store.upgrade(db_path)
    assert store.schema_version(db_path) == store.LABEL_SCHEMA_VERSION
    store.initialise(db_path)
