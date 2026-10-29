"""Playback copies (Phase 2 W1): exact frame map, seekable range responses, refusals and explicit upgrade."""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from backend.app import audio_store, candidate_store, count_store, proxy_store, proxy_worker, store, tracking_store
from backend.app.main import Settings, create_app
from backend.tests.summary_fixtures import encode_frames
from backend.tests.test_import import HEADERS, TOKEN, import_files, session
from backend.tests.test_thermal import legacy_v5
from backend.tests.test_tracking import scenario


def wait_copies(client: TestClient, session_id: str, seconds: float = 60) -> dict:
    deadline = time.monotonic() + seconds
    while (value := client.get(f"/api/proxy?session_id={session_id}", headers=HEADERS).json())["active"]:
        assert time.monotonic() < deadline
        time.sleep(0.1)
    return value


def imported(client: TestClient, tmp_path: Path, times: list[int]) -> tuple[str, Path]:
    source = tmp_path / "copy.mp4"
    frames = scenario("two_dots")[:len(times)]
    encode_frames(source, frames, times)
    session_id = session(client)
    assert import_files(client, session_id, [source])["state"] == "complete"
    return session_id, source


def test_copy_maps_every_frame_to_its_source_pts_and_serves_ranges(tmp_path: Path) -> None:
    times = [index * 40 for index in range(20)]
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, _ = imported(client, tmp_path, times)
        started = client.post("/api/proxy", headers=HEADERS, json={"session_id": session_id})
        assert started.status_code == 202, started.text
        status = wait_copies(client, session_id)
        (copy,) = status["proxies"]
        assert copy["state"] == "ready" and copy["frame_count"] == 20 and copy["error"] is None
        frames = client.get(f"/api/proxy/{copy['id']}/frames", headers=HEADERS).json()
        assert frames["proxy_ms"] == times
        segment = store.segment_by_id(tmp_path / "app-data" / "bat_innovation.sqlite3", copy["segment_id"])
        first = int(__import__("json").loads(segment["metadata_json"])["first_pts"])
        assert int(frames["source_pts"][0]) == first and len(set(frames["source_pts"])) == 20
        whole = client.get(f"/api/proxy/{copy['id']}/video", headers=HEADERS)
        assert whole.status_code == 200 and whole.headers["content-type"] == "video/webm" and whole.content[:4] == b"\x1aE\xdf\xa3"
        part = client.get(f"/api/proxy/{copy['id']}/video", headers={**HEADERS, "Range": "bytes=0-99"})
        assert part.status_code == 206 and len(part.content) == 100
        # A second start reuses the ready copy instead of encoding again.
        again = client.post("/api/proxy", headers=HEADERS, json={"session_id": session_id}).json()
        assert again["proxies"][0]["id"] == copy["id"] and not again["active"]
        assert client.get(f"/api/proxy/{copy['id']}/video").status_code == 401


def test_changed_original_and_corrupt_frame_map_are_refused(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, source = imported(client, tmp_path, [index * 40 for index in range(8)])
        with source.open("r+b") as handle:
            handle.seek(-1, 2)
            last = handle.read(1)
            handle.seek(-1, 2)
            handle.write(bytes([last[0] ^ 0xFF]))
        client.post("/api/proxy", headers=HEADERS, json={"session_id": session_id})
        (copy,) = wait_copies(client, session_id)["proxies"]
        assert copy["state"] == "failed" and copy["error"] == "changed_source"
        assert not list((tmp_path / "app-data" / "playback").iterdir())
        missing = client.get(f"/api/proxy/{copy['id']}/video", headers=HEADERS)
        assert missing.status_code == 404 and missing.json()["detail"]["code"] == "proxy_missing"


def test_frame_map_integrity_is_checked(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, _ = imported(client, tmp_path, [index * 40 for index in range(6)])
        client.post("/api/proxy", headers=HEADERS, json={"session_id": session_id})
        (copy,) = wait_copies(client, session_id)["proxies"]
        sidecar = tmp_path / "app-data" / "playback" / f"{copy['id']}.frames"
        sidecar.write_bytes(proxy_worker.pack_frames([1, 2], [0, 40]))
        broken = client.get(f"/api/proxy/{copy['id']}/frames", headers=HEADERS)
        assert broken.status_code == 409 and broken.json()["detail"]["code"] == "proxy_integrity"


def test_frame_map_round_trip_and_tag() -> None:
    assert proxy_worker.unpack_frames(proxy_worker.pack_frames([5, 9], [0, 40])) == ([5, 9], [0, 40])
    with pytest.raises(ValueError):
        proxy_worker.unpack_frames(b"nope")


def test_proxy_upgrade_from_v10_and_rollback(tmp_path: Path) -> None:
    db_path = legacy_v5(tmp_path)
    for step in (store.upgrade_modality, tracking_store.upgrade, count_store.upgrade, candidate_store.upgrade, audio_store.upgrade):
        step(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE proxy (conflict TEXT)")
    with pytest.raises(sqlite3.OperationalError):
        proxy_store.upgrade(db_path)
    assert store.schema_version(db_path) == store.AUDIO_SCHEMA_VERSION
    with sqlite3.connect(db_path) as connection:
        connection.execute("DROP TABLE proxy")
    proxy_store.upgrade(db_path)
    assert store.schema_version(db_path) == store.PROXY_SCHEMA_VERSION


def test_watched_windows_are_marked_together_only_when_every_one_qualifies(tmp_path: Path) -> None:
    from backend.tests.test_tracking import wait

    quiet, busy = tmp_path / "quiet.mp4", tmp_path / "busy.mp4"
    encode_frames(quiet, scenario("noise"), [index * 40 for index in range(20)])
    encode_frames(busy, scenario("two_dots"), [index * 40 for index in range(20)])
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id = session(client)
        assert import_files(client, session_id, [quiet, busy])["state"] == "complete"
        summary = client.post("/api/summaries", headers=HEADERS, json={"session_id": session_id, "window_seconds": 30}).json()
        summary = wait(client, f"/api/summaries/{summary['id']}", ("queued", "running"))
        run = client.post("/api/tracking", headers=HEADERS, json={"summary_run_id": summary["id"]}).json()
        wait(client, f"/api/tracking/{run['id']}", ("queued", "running"))
        client.post("/api/proxy", headers=HEADERS, json={"session_id": session_id})
        copies = {item["segment_id"]: item for item in wait_copies(client, session_id)["proxies"]}
        windows = {window["segment_id"]: window for window in summary["windows"]}
        quiet_window, busy_window = list(windows.values())
        def item(window: dict, rate: float = 2, last: bool = True) -> dict:
            frames = client.get(f"/api/proxy/{copies[window['segment_id']]['id']}/frames", headers=HEADERS).json()
            end = frames["source_pts"][-1] if last else frames["source_pts"][5]
            return {"window_id": window["id"], "proxy_id": copies[window["segment_id"]]["id"],
                    "intervals": [[int(frames["source_pts"][0]), int(end)]], "max_rate": rate}
        post = lambda items: client.post("/api/reviews/watched", headers=HEADERS, json={"actor": "Reviewer One", "items": items})
        for bad, reason in (([item(quiet_window, rate=8)], "faster than 4x"), ([item(quiet_window, last=False)], "not watched end to end"),
                            ([item(quiet_window), item(busy_window)], "have tracks to decide")):
            refused = post(bad)
            assert refused.status_code == 409 and reason in refused.json()["detail"]["message"], refused.text
        assert client.get(f"/api/summary-windows/{quiet_window['id']}/review", headers=HEADERS).json()["decision"] == "unreviewed"
        saved = post([item(quiet_window)])
        assert saved.status_code == 200, saved.text
        review = client.get(f"/api/summary-windows/{quiet_window['id']}/review", headers=HEADERS).json()
        assert review["decision"] == "reviewed_no_discernible_event" and review["verification"]["playback"]["max_rate"] == 2
        assert review["verification"]["playback"]["kind"] == "playback_copy"
        again = post([item(quiet_window)])
        assert again.status_code == 409 and "already reviewed" in again.json()["detail"]["message"]
        # A track decision may be proven by watching it in the playback copy.
        track = client.get(f"/api/tracking/{run['id']}/candidates", headers=HEADERS).json()[0]
        proof = item(busy_window)
        decided = client.post(f"/api/tracking/{run['id']}/candidates/{track['track_id']}/decision", headers=HEADERS,
                              json={"actor": "Reviewer One", "expected_revision": 0, "decision": "bat",
                                    "playback": {"proxy_id": proof["proxy_id"], "intervals": proof["intervals"], "max_rate": 1}})
        assert decided.status_code == 200 and decided.json()["decision"]["decision"] == "bat", decided.text


def test_enhanced_copy_has_the_same_frame_map_and_is_prepared_per_video(tmp_path: Path) -> None:
    times = [index * 40 for index in range(20)]
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, _ = imported(client, tmp_path, times)
        client.post("/api/proxy", headers=HEADERS, json={"session_id": session_id})
        (standard,) = wait_copies(client, session_id)["proxies"]
        missing = client.post("/api/proxy", headers=HEADERS, json={"session_id": session_id, "kind": "enhanced",
                                                                   "segment_id": "00000000-0000-4000-8000-000000000000"})
        assert missing.status_code == 404
        started = client.post("/api/proxy", headers=HEADERS, json={"session_id": session_id, "kind": "enhanced", "segment_id": standard["segment_id"]})
        assert started.status_code == 202, started.text
        status = wait_copies(client, session_id)
        (enhanced,) = status["enhanced"]
        assert enhanced["kind"] == "enhanced" and enhanced["state"] == "ready" and [item["id"] for item in status["proxies"]] == [standard["id"]]
        a = client.get(f"/api/proxy/{standard['id']}/frames", headers=HEADERS).json()
        b = client.get(f"/api/proxy/{enhanced['id']}/frames", headers=HEADERS).json()
        assert a["source_pts"] == b["source_pts"] and a["proxy_ms"] == b["proxy_ms"]
        video = client.get(f"/api/proxy/{enhanced['id']}/video", headers=HEADERS)
        assert video.status_code == 200 and video.content[:4] == b"\x1aE\xdf\xa3"
        # Watching the enhanced copy is a receipt that names the view.
        from backend.app.proxies import ProxyJobs
        segment = store.segment_by_id(tmp_path / "app-data" / "bat_innovation.sqlite3", enhanced["segment_id"])
        receipt = ProxyJobs(tmp_path / "app-data" / "bat_innovation.sqlite3", tmp_path / "app-data").receipt(
            enhanced["id"], segment, [[int(b["source_pts"][0]), int(b["source_pts"][-1])]], 1)
        assert receipt["view"] == "enhanced"


def test_copy_kind_upgrade_from_v15_and_rollback(tmp_path: Path) -> None:
    from backend.app import sample_store, template_store

    db_path = legacy_v5(tmp_path)
    for step in (store.upgrade_modality, tracking_store.upgrade, count_store.upgrade, candidate_store.upgrade, audio_store.upgrade,
                 proxy_store.upgrade, tracking_store.upgrade_v2, count_store.upgrade_spans,
                 sample_store.upgrade, template_store.upgrade):
        step(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute("ALTER TABLE proxy ADD COLUMN kind TEXT")
    with pytest.raises(sqlite3.OperationalError):
        proxy_store.upgrade_kind(db_path)
    assert store.schema_version(db_path) == store.TEMPLATE_SCHEMA_VERSION
