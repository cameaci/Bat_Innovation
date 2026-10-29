"""Sample checks (Phase 3 X2): a manual count of a span compared with the gate's proposal, append-only."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from backend.app import sample_store, store
from backend.app.main import Settings, create_app
from backend.tests.test_counts import gate_value, tracked
from backend.tests.test_import import HEADERS, TOKEN
from backend.tests.test_proxy import wait_copies
from backend.tests.test_tracking import scenario


def test_compare_matches_by_kind_within_the_tolerance() -> None:
    crossings = [{"key": "a", "pts": "1000", "direction": "B_to_A", "quality": "coherent", "track_index": 0},
                 {"key": "b", "pts": "3000", "direction": "A_to_B", "quality": "coherent", "track_index": 1},
                 {"key": "c", "pts": "5000", "direction": "A_to_B", "quality": "uncertain", "track_index": 2}]
    result = sample_store.compare([(1200, "entry"), (2000, "exit"), (8000, "exit")], crossings, "B_to_A", 500)
    assert [item["key"] for item in result["matched"]] == ["a"]
    assert [item["pts"] for item in result["missed_by_algorithm"]] == ["2000", "8000"]
    assert [item["key"] for item in result["extra_in_algorithm"]] == ["b"]
    assert result["manual"] == {"entry": 1, "exit": 2} and result["algorithm"] == {"entry": 1, "exit": 1}
    assert result["uncertain_in_span"] == 1


def test_sample_check_is_stored_with_its_receipt_and_refuses_fast_or_partial_viewing(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, run_id, summary = tracked(client, tmp_path, scenario("two_dots"))
        gate = client.post(f"/api/sessions/{session_id}/gates", headers=HEADERS,
                           json={"actor": "Reviewer One", "expected_revision": 0, "value": gate_value()}).json()
        client.post("/api/proxy", headers=HEADERS, json={"session_id": session_id})
        (copy,) = wait_copies(client, session_id)["proxies"]
        frames = client.get(f"/api/proxy/{copy['id']}/frames", headers=HEADERS).json()
        first, last = int(frames["source_pts"][0]), int(frames["source_pts"][-1])
        url = f"/api/tracking/{run_id}/gates/{gate['id']}"
        crossings = client.get(f"{url}/counts", headers=HEADERS).json()["crossings"]
        entering = next(item for item in crossings if item["direction"] == "B_to_A")
        body = {"actor": "Reviewer One", "segment_id": copy["segment_id"], "start_pts": first, "end_pts": last,
                "presses": [{"pts": int(entering["pts"]) + 1, "kind": "entry"}], "proxy_id": copy["id"],
                "intervals": [[first, last]], "max_rate": 1}
        fast = client.post(f"{url}/sample-checks", headers=HEADERS, json={**body, "max_rate": 2})
        assert fast.status_code == 409 and fast.json()["detail"]["code"] == "sample_too_fast"
        partial = client.post(f"{url}/sample-checks", headers=HEADERS, json={**body, "intervals": [[int(frames["source_pts"][3]), last]]})
        assert partial.status_code == 409 and partial.json()["detail"]["code"] == "sample_unwatched"
        outside = client.post(f"{url}/sample-checks", headers=HEADERS, json={**body, "presses": [{"pts": last + 1, "kind": "exit"}]})
        assert outside.status_code == 422
        saved = client.post(f"{url}/sample-checks", headers=HEADERS, json=body)
        assert saved.status_code == 200, saved.text
        result = saved.json()["result"]
        assert len(result["matched"]) == 1 and result["missed_by_algorithm"] == [] and len(result["extra_in_algorithm"]) == 1
        assert saved.json()["receipt"]["kind"] == "playback_copy"
        listed = client.get(f"{url}/sample-checks", headers=HEADERS).json()
        assert [item["id"] for item in listed] == [saved.json()["id"]]
        # Counts are untouched by a check.
        assert client.get(f"{url}/counts", headers=HEADERS).json()["layers"]["reviewer"]["entered"] == 1
        with sqlite3.connect(tmp_path / "app-data" / "bat_innovation.sqlite3") as connection, pytest.raises(sqlite3.IntegrityError):
            connection.execute("DELETE FROM sample_check")


def test_sample_check_upgrade_from_v13(tmp_path: Path) -> None:
    from backend.tests.test_thermal import legacy_v5

    db_path = legacy_v5(tmp_path)
    from backend.app import audio_store, candidate_store, count_store, proxy_store, tracking_store
    for step in (store.upgrade_modality, tracking_store.upgrade, count_store.upgrade, candidate_store.upgrade, audio_store.upgrade,
                 proxy_store.upgrade, tracking_store.upgrade_v2, count_store.upgrade_spans):
        step(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE sample_check (conflict TEXT)")
    with pytest.raises(sqlite3.OperationalError):
        sample_store.upgrade(db_path)
    assert store.schema_version(db_path) == store.GATE_SPAN_SCHEMA_VERSION
    with sqlite3.connect(db_path) as connection:
        connection.execute("DROP TABLE sample_check")
    sample_store.upgrade(db_path)
    assert store.schema_version(db_path) == store.SAMPLE_CHECK_SCHEMA_VERSION
