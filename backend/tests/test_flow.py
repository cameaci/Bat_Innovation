"""Several gates, the emergence profile and the typed sunset (Phase 3 X7)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from backend.app import flow, store
from backend.app.main import Settings, create_app
from backend.tests.test_counts import gate_value, tracked
from backend.tests.test_import import HEADERS, TOKEN
from backend.tests.test_tracking import scenario


def gate(client: TestClient, session_id: str, **changes) -> dict:
    created = client.post(f"/api/sessions/{session_id}/gates", headers=HEADERS,
                          json={"actor": "Reviewer One", "expected_revision": 0, "value": gate_value(**changes)})
    assert created.status_code == 200, created.text
    return created.json()


def test_two_gates_count_independently_and_the_profile_adds_up(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, run_id, _summary = tracked(client, tmp_path, scenario("two_dots"))
        whole = gate(client, session_id, name="Whole height")
        # A bent line over the top half only: dot A (y = 20) crosses it, dot B (y = 70) passes below its end.
        top = gate(client, session_id, name="Top half", points=[[64, 0], [64, 30], [70, 40]])
        a = client.get(f"/api/tracking/{run_id}/gates/{whole['id']}/counts", headers=HEADERS).json()
        b = client.get(f"/api/tracking/{run_id}/gates/{top['id']}/counts", headers=HEADERS).json()
        assert (a["layers"]["algorithm"]["entered"], a["layers"]["algorithm"]["exited"]) == (1, 1)
        assert (b["layers"]["algorithm"]["entered"], b["layers"]["algorithm"]["exited"]) == (1, 0)
        for counts in (a, b):
            for name in ("algorithm", "reviewer"):
                bins = counts["profile"]["layers"][name]["bins"]
                assert sum(row["entered"] for row in bins) == counts["layers"][name]["entered"]
                assert sum(row["exited"] for row in bins) == counts["layers"][name]["exited"]
            assert counts["profile"]["layers"]["qa"] is None, "QA flow appears only with a current approval"
        algorithm = a["profile"]["layers"]["algorithm"]
        assert algorithm["peak_minute"] == {"segment_id": algorithm["bins"][0]["segment_id"], "minute": 0, "exited": 1}
        assert algorithm["first_exit"] == algorithm["last_exit"] and 0 < algorithm["first_exit"]["seconds"] < 1
        assert algorithm["peak_exits_per_second"] == 1
        assert a["profile"]["minutes_after_sunset"] is None, "no sunset typed"
        from backend.app import csv_export
        directory = tmp_path / "bundle"
        directory.mkdir()
        info = csv_export.expansion_rows(tmp_path / "app-data" / "bat_innovation.sqlite3", directory, _summary["id"], "2026-10-28T00:00:00Z", lambda: None, {})
        exported = {item["gate_name"]: item for item in info["flow"]}
        assert exported["Whole height"]["layers"]["algorithm"]["peak_exits_per_second"] == 1 and exported["Top half"]["layers"]["qa"] is None


def test_minutes_after_sunset_need_a_declared_clock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, run_id, _summary = tracked(client, tmp_path, scenario("two_dots"))
        whole = gate(client, session_id)
        url = f"/api/sessions/{session_id}/sunset"
        for bad in ({"actor": "R", "sunset": "25:00+01:00", "source": "almanac"}, {"actor": "R", "sunset": "21:04", "source": "almanac"},
                    {"actor": "R", "sunset": "21:04+01:00", "source": " "}):
            refused = client.post(url, headers=HEADERS, json=bad)
            assert refused.status_code == 422 and refused.json()["detail"]["code"] == "sunset_invalid"
        saved = client.post(url, headers=HEADERS, json={"actor": "Reviewer One", "sunset": "21:04+01:00", "source": "HM Nautical Almanac"}).json()
        assert saved["sunset"] == "21:04+01:00" and saved["revision"] == 1
        counts = lambda: client.get(f"/api/tracking/{run_id}/gates/{whole['id']}/counts", headers=HEADERS).json()["profile"]
        assert counts()["minutes_after_sunset"] is None, "without a declared clock no time after sunset is given"
        segment = counts()["layers"]["algorithm"]["first_exit"]["segment_id"]
        first_pts = store.segment_by_id(tmp_path / "app-data" / "bat_innovation.sqlite3", segment)["metadata_json"]
        import json
        # The declared clock is stored in UTC (20:30Z is 21:30 in BST).
        anchor = {"segment_id": segment, "utc": "2026-08-10T20:30:00Z", "provenance": "camera overlay", "source_pts": json.loads(first_pts)["first_pts"]}
        monkeypatch.setattr(store, "clock_anchor", lambda _db, _session: anchor)
        profile = counts()
        assert profile["clock_segment_id"] == segment
        # The exit happens within the first second after 21:30 local time: 26 minutes after a 21:04 sunset.
        assert profile["minutes_after_sunset"]["algorithm"]["first_exit"] == 26.0
        assert profile["minutes_after_sunset"]["algorithm"]["peak_minute"] == 26.0
        cleared = client.post(url, headers=HEADERS, json={"actor": "Reviewer One", "sunset": ""})
        assert cleared.status_code == 200 and cleared.json() is None and counts()["minutes_after_sunset"] is None
        with sqlite3.connect(tmp_path / "app-data" / "bat_innovation.sqlite3") as connection, pytest.raises(sqlite3.IntegrityError):
            connection.execute("UPDATE sunset_event SET sunset='20:00'")


def test_sunset_upgrade_from_v17(tmp_path: Path) -> None:
    from backend.app import audio_store, candidate_store, count_store, label_store, proxy_store, sample_store, template_store, tracking_store
    from backend.tests.test_thermal import legacy_v5

    db_path = legacy_v5(tmp_path)
    for step in (store.upgrade_modality, tracking_store.upgrade, count_store.upgrade, candidate_store.upgrade, audio_store.upgrade,
                 proxy_store.upgrade, tracking_store.upgrade_v2, count_store.upgrade_spans, sample_store.upgrade,
                 template_store.upgrade, proxy_store.upgrade_kind, label_store.upgrade):
        step(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE sunset_event (conflict TEXT)")
    with pytest.raises(sqlite3.OperationalError):
        flow.upgrade(db_path)
    assert store.schema_version(db_path) == store.LABEL_SCHEMA_VERSION
    with sqlite3.connect(db_path) as connection:
        connection.execute("DROP TABLE sunset_event")
    flow.upgrade(db_path)
    assert store.schema_version(db_path) == store.SUNSET_SCHEMA_VERSION
    store.initialise(db_path)
