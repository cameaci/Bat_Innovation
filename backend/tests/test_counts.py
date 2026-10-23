"""Gates, crossings and three-layer counts (feature expansion E3)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from backend.app import count_store, gates, store, tracking_store
from backend.app.main import Settings, create_app
from backend.tests.summary_fixtures import encode_frames
from backend.tests.test_import import HEADERS, TOKEN, import_files, session
from backend.tests.test_thermal import legacy_v5
from backend.tests.test_tracking import frame, path, scenario, wait

LINE = {"kind": "line", "points": [[64, 0], [64, 96]], "hysteresis_px": 3, "frame_w": 128, "frame_h": 96}
BOX = {"kind": "rect", "points": [[50, 30], [80, 30], [80, 60], [50, 60]], "hysteresis_px": 2, "frame_w": 128, "frame_h": 96}


def walk(xs: list[float], y: float = 40) -> list[tuple[int, float, float]]:
    return [(index, x, y) for index, x in enumerate(xs)]


def test_line_crossings_in_both_directions() -> None:
    assert gates.crossings(walk([10 + 8 * i for i in range(12)]), LINE) == [(8, "B_to_A")]
    assert gates.crossings(walk([110 - 8 * i for i in range(12)]), LINE) == [(7, "A_to_B")]


def test_jitter_inside_the_band_never_counts() -> None:
    assert gates.crossings(walk([63 + (i % 2) * 3 for i in range(30)]), LINE) == []


def test_back_and_forth_counts_twice_and_beyond_the_line_end_counts_nothing() -> None:
    assert [item[1] for item in gates.crossings(walk([40, 90, 40]), LINE)] == ["B_to_A", "A_to_B"]
    short = {**LINE, "points": [[64, 0], [64, 30]]}
    assert gates.crossings(walk([10 + 8 * i for i in range(12)], y=80), short) == []


def test_area_entry_and_exit() -> None:
    assert gates.crossings(walk([10 + 8 * i for i in range(14)], y=45), BOX) == [(6, "out_to_in"), (9, "in_to_out")]


@pytest.mark.parametrize("bad, message", [({**LINE, "points": [[64, 0]]}, "two points"), ({**LINE, "points": [[64, 0], [64, 4]]}, "too short"),
                                          ({**LINE, "points": [[64, 0], [200, 0]]}, "inside the video"), ({**BOX, "points": [[1, 1], [2, 1], [2, 2], [1, 2]]}, "too small")])
def test_degenerate_gates_are_refused(bad: dict, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        gates.validate(bad)


def test_count_upgrade_rolls_back(tmp_path: Path) -> None:
    db_path = legacy_v5(tmp_path)
    store.upgrade_modality(db_path)
    tracking_store.upgrade(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE gate (conflict TEXT)")
    with pytest.raises(sqlite3.OperationalError):
        count_store.upgrade(db_path)
    assert store.schema_version(db_path) == store.TRACKING_SCHEMA_VERSION


def tracked(client: TestClient, tmp_path: Path, frames) -> tuple[str, str, dict]:
    source = tmp_path / "gate.mp4"
    encode_frames(source, frames, [index * 40 for index in range(len(frames))])
    session_id = session(client)
    assert import_files(client, session_id, [source])["state"] == "complete"
    summary = client.post("/api/summaries", headers=HEADERS, json={"session_id": session_id, "window_seconds": 30}).json()
    summary = wait(client, f"/api/summaries/{summary['id']}", ("queued", "running"))
    run = client.post("/api/tracking", headers=HEADERS, json={"summary_run_id": summary["id"]}).json()
    run = wait(client, f"/api/tracking/{run['id']}", ("queued", "running"))
    assert run["state"] == "complete"
    return session_id, run["id"], summary


def gate_value(**changes) -> dict:
    return {"name": "Roost gap", "kind": "line", "points": [[64, 0], [64, 96]], "frame_w": 128, "frame_h": 96,
            "label_a": "Right of line", "label_b": "Left of line", "entry_direction": "B_to_A", "hysteresis_px": 3, **changes}


def test_three_count_layers_with_audit_and_independent_qa(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, run_id, summary = tracked(client, tmp_path, scenario("two_dots"))
        created = client.post(f"/api/sessions/{session_id}/gates", headers=HEADERS,
                              json={"actor": "Reviewer One", "expected_revision": 0, "value": gate_value()})
        assert created.status_code == 200, created.text
        gate = created.json()
        url = f"/api/tracking/{run_id}/gates/{gate['id']}"
        counted = client.get(f"{url}/counts", headers=HEADERS).json()
        # Dot A moves left to right (B -> A, entering); dot B moves right to left (exiting).
        assert counted["layers"]["algorithm"] == {"entered": 1, "exited": 1, "net": 0, "excluded_scene_changed": 0}
        assert counted["layers"]["reviewer"]["reviewed"] == 0 and counted["layers"]["qa"] is None
        first, second = counted["crossings"]
        post = lambda kind, body: client.post(f"{url}/{kind}", headers=HEADERS, json=body)
        missing_reason = post("review", {"actor": "Reviewer One", "expected_revision": 0, "action": "reject", "key": first["key"]})
        assert missing_reason.status_code == 422
        result = post("review", {"actor": "Reviewer One", "expected_revision": 0, "action": "confirm", "key": first["key"]}).json()
        result = post("review", {"actor": "Reviewer One", "expected_revision": result["revision"], "action": "confirm", "key": second["key"],
                                 "count": 2, "rationale": "Two bats overlap in this crossing"}).json()
        stale = post("review", {"actor": "Reviewer One", "expected_revision": 0, "action": "clear", "key": second["key"]})
        assert stale.status_code == 409 and stale.json()["detail"]["code"] == "count_conflict"
        result = post("review", {"actor": "Reviewer One", "expected_revision": result["revision"], "action": "add_missed",
                                 "direction": "B_to_A", "segment_id": first["segment_id"], "pts": first["pts"], "count": 1,
                                 "rationale": "Faint bat missed by tracking"}).json()
        reviewer = result["layers"]["reviewer"]
        entered, exited = (1, 2) if first["direction"] == "B_to_A" else (2, 1)
        assert (reviewer["entered"], reviewer["exited"]) == (entered + 1, exited) and reviewer["added"] == 1
        assert result["layers"]["algorithm"]["entered"] == 1, "The algorithm layer never changes"
        same = post("qa", {"actor": " reviewer  one ", "expected_revision": result["revision"], "review_revision": result["review_revision"], "decision": "approve"})
        assert same.status_code == 409 and same.json()["detail"]["code"] == "count_same_actor"
        approved = post("qa", {"actor": "QA Two", "expected_revision": result["revision"], "review_revision": result["review_revision"], "decision": "approve"}).json()
        assert approved["layers"]["qa"]["counts"] == {"entered": reviewer["entered"], "exited": reviewer["exited"], "net": reviewer["net"]}
        changed = post("review", {"actor": "Reviewer One", "expected_revision": approved["revision"], "action": "clear", "key": second["key"]}).json()
        assert changed["layers"]["qa"]["stale"] is True and changed["layers"]["qa"]["counts"] is None
        assert [event["layer"] for event in client.get(f"{url}/history", headers=HEADERS).json()] == ["review"] * 3 + ["qa", "review"]
        # Editing the gate makes earlier reviews history only.
        edited = client.put(f"/api/sessions/{session_id}/gates/{gate['id']}", headers=HEADERS,
                            json={"actor": "Reviewer One", "expected_revision": 1, "value": gate_value(hysteresis_px=4)}).json()
        assert edited["revision"] == 2
        after = client.get(f"{url}/counts", headers=HEADERS).json()
        assert after["layers"]["reviewer"]["reviewed"] == 0 and after["layers"]["qa"]["stale"] is True
        conflict = client.put(f"/api/sessions/{session_id}/gates/{gate['id']}", headers=HEADERS,
                              json={"actor": "Reviewer One", "expected_revision": 1, "value": None})
        assert conflict.status_code == 409
        assert [item["action"] for item in client.get(f"/api/gates/{gate['id']}/history", headers=HEADERS).json()] == ["create", "update"]
        with sqlite3.connect(tmp_path / "app-data" / "bat_innovation.sqlite3") as connection:
            with pytest.raises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM count_event")


def test_scene_change_excludes_crossings_from_the_algorithm_count(tmp_path: Path) -> None:
    dots = path((4, 40), (6, 0), 20)
    frames = [frame([dots[i]], background=200 if i == 3 else 40) for i in range(20)]
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, run_id, _summary = tracked(client, tmp_path, frames)
        gate = client.post(f"/api/sessions/{session_id}/gates", headers=HEADERS,
                           json={"actor": "Reviewer One", "expected_revision": 0, "value": gate_value()}).json()
        counted = client.get(f"/api/tracking/{run_id}/gates/{gate['id']}/counts", headers=HEADERS).json()
        assert counted["crossings"] and all(item["scene_changed"] for item in counted["crossings"])
        assert counted["layers"]["algorithm"]["entered"] == 0 and counted["layers"]["algorithm"]["excluded_scene_changed"] == len(counted["crossings"])


def test_gates_require_storage_upgrade_and_valid_geometry(tmp_path: Path) -> None:
    data_dir = tmp_path / "app-data"
    data_dir.mkdir()
    legacy_v5(data_dir)
    with TestClient(create_app(Settings(data_dir, TOKEN))) as client:
        session_id = session(client)
        refused = client.post(f"/api/sessions/{session_id}/gates", headers=HEADERS,
                              json={"actor": "R", "expected_revision": 0, "value": gate_value()})
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "count_upgrade_required"
        assert client.post("/api/storage/upgrade", headers=HEADERS).status_code == 200
        wrong = client.post(f"/api/sessions/{session_id}/gates", headers=HEADERS,
                            json={"actor": "R", "expected_revision": 0, "value": gate_value(entry_direction="out_to_in")})
        assert wrong.status_code == 422
        tiny = client.post(f"/api/sessions/{session_id}/gates", headers=HEADERS,
                           json={"actor": "R", "expected_revision": 0, "value": gate_value(points=[[64, 0], [64, 5]])})
        assert tiny.status_code == 422 and tiny.json()["detail"]["code"] == "gate_invalid"
