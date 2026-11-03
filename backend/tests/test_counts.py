"""Gates, crossings, validity spans and three-layer counts (feature expansion E3, Phase 2 W4)."""

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


def test_a_polyline_counts_each_pass_once_even_over_a_vertex() -> None:
    # A bent line: down from the top to (64, 48), then on to the bottom-right corner.
    bent = {**LINE, "points": [[64, 0], [64, 48], [120, 96]]}
    assert gates.crossings(walk([10 + 8 * i for i in range(12)], y=20), bent) == [(8, "B_to_A")]
    assert gates.crossings(walk([10 + 8 * i for i in range(15)], y=80), bent) == [(12, "B_to_A")]
    # Exactly through the vertex, and across the bend near it: one side change, one crossing each.
    assert gates.crossings(walk([10 + 8 * i for i in range(14)], y=48), bent) == [(8, "B_to_A")]
    assert [direction for _, direction in gates.crossings([(i, 100 - 6 * i, 20 + 6 * i) for i in range(14)], bent)] == ["A_to_B"]
    # Back again over the second segment counts the opposite way.
    assert [item[1] for item in gates.crossings(walk([60, 110, 60], y=80), bent)] == ["B_to_A", "A_to_B"]


def test_area_entry_and_exit() -> None:
    assert gates.crossings(walk([10 + 8 * i for i in range(14)], y=45), BOX) == [(6, "out_to_in"), (9, "in_to_out")]


@pytest.mark.parametrize("bad, message", [({**LINE, "points": [[64, 0]]}, "2 to 8 points"), ({**LINE, "points": [[64, 0], [64, 4]]}, "longer than its hysteresis"),
                                          ({**LINE, "points": [[64, 0]] * 9}, "2 to 8 points"),
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


def test_three_count_layers_with_proposal_acceptance_and_independent_qa(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, run_id, summary = tracked(client, tmp_path, scenario("two_dots"))
        created = client.post(f"/api/sessions/{session_id}/gates", headers=HEADERS,
                              json={"actor": "Reviewer One", "expected_revision": 0, "value": gate_value()})
        assert created.status_code == 200, created.text
        gate = created.json()
        url = f"/api/tracking/{run_id}/gates/{gate['id']}"
        counted = client.get(f"{url}/counts", headers=HEADERS).json()
        # Dot A moves left to right (B -> A, entering); dot B moves right to left (exiting).
        assert counted["layers"]["algorithm"] == {"entered": 1, "exited": 1, "net": 0, "coherent": 2, "uncertain": 0,
                                                  "noise_crossings": 0, "invalid_spans": 0}
        reviewer = counted["layers"]["reviewer"]
        assert (reviewer["state"], reviewer["entered"], reviewer["exited"], reviewer["unresolved"]) == ("ready", 1, 1, 0)
        assert counted["layers"]["qa"] is None and counted["invalid_spans"] == []
        first, second = counted["crossings"]
        post = lambda kind, body: client.post(f"{url}/{kind}", headers=HEADERS, json=body)
        early_qa = post("qa", {"actor": "QA Two", "expected_revision": 0, "review_revision": 0, "decision": "approve"})
        assert early_qa.status_code == 409 and early_qa.json()["detail"]["code"] == "count_unresolved"
        missing_reason = post("review", {"actor": "Reviewer One", "expected_revision": 0, "action": "reject", "key": first["key"]})
        assert missing_reason.status_code == 422
        result = post("review", {"actor": "Reviewer One", "expected_revision": 0, "action": "confirm", "key": second["key"],
                                 "count": 2, "rationale": "Two bats overlap in this crossing"}).json()
        stale = post("review", {"actor": "Reviewer One", "expected_revision": 0, "action": "clear", "key": second["key"]})
        assert stale.status_code == 409 and stale.json()["detail"]["code"] == "count_conflict"
        result = post("review", {"actor": "Reviewer One", "expected_revision": result["revision"], "action": "add_missed",
                                 "direction": "B_to_A", "segment_id": first["segment_id"], "pts": first["pts"], "count": 1,
                                 "rationale": "Faint bat missed by tracking"}).json()
        result = post("review", {"actor": "Reviewer One", "expected_revision": result["revision"], "action": "accept"}).json()
        reviewer = result["layers"]["reviewer"]
        weights = ((first["direction"], 1), (second["direction"], 2), ("B_to_A", 1))  # entering is B_to_A
        assert reviewer["state"] == "accepted" and reviewer["accepted"]["actor"] == "Reviewer One" and reviewer["added"] == 1
        assert (reviewer["entered"], reviewer["exited"]) == (sum(n for d, n in weights if d == "B_to_A"), sum(n for d, n in weights if d == "A_to_B"))
        assert result["layers"]["algorithm"]["entered"] == 1, "The algorithm layer never changes"
        same = post("qa", {"actor": " reviewer  one ", "expected_revision": result["revision"], "review_revision": result["review_revision"], "decision": "approve"})
        assert same.status_code == 409 and same.json()["detail"]["code"] == "count_same_actor"
        approved = post("qa", {"actor": "QA Two", "expected_revision": result["revision"], "review_revision": result["review_revision"], "decision": "approve"}).json()
        assert approved["layers"]["qa"]["counts"] == {"entered": reviewer["entered"], "exited": reviewer["exited"], "net": reviewer["net"]}
        changed = post("review", {"actor": "Reviewer One", "expected_revision": approved["revision"], "action": "clear", "key": second["key"]}).json()
        assert changed["layers"]["qa"]["stale"] is True and changed["layers"]["qa"]["counts"] is None
        assert changed["layers"]["reviewer"]["state"] == "ready", "A later change needs a new acceptance"
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


def moved_camera_frames() -> list:
    """A textured scene; one target crosses x=64 before the camera shifts by 6 px at frame 50, another after."""
    from backend.tests.test_tracking import H, W, textured

    scene = textured()
    first, second = path((4, 20), (3, 0), 41), path((4, 70), (3, 0), 41)
    images = []
    for index in range(110):
        offset = 0 if index < 50 else 6
        image = scene[offset:offset + H, offset:offset + W].copy()
        for dots, start in ((first, 0), (second, 62)):
            if start <= index < start + len(dots):
                x, y = dots[index - start]
                image[y:y + 3, x:x + 3] = 240
        images.append(image)
    return images


def test_a_camera_move_pauses_the_gate_with_one_action_until_reconfirmed(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, run_id, _summary = tracked(client, tmp_path, moved_camera_frames())
        events = client.get(f"/api/tracking/{run_id}/events", headers=HEADERS).json()
        assert [event["kind"] for event in events] == ["camera_moved"]
        gate = client.post(f"/api/sessions/{session_id}/gates", headers=HEADERS,
                           json={"actor": "Reviewer One", "expected_revision": 0, "value": gate_value()}).json()
        url = f"/api/tracking/{run_id}/gates/{gate['id']}"
        counted = client.get(f"{url}/counts", headers=HEADERS).json()
        # Acceptance rule: one scene change is at most one user action, never a burst of crossings to review.
        assert len(counted["invalid_spans"]) == 1 and counted["invalid_spans"][0]["reason"] == "camera_moved"
        assert len(counted["crossings"]) == 1 and int(counted["crossings"][0]["pts"]) < int(events[0]["start_pts"])
        assert counted["layers"]["reviewer"]["state"] == "unresolved"
        refused = client.post(f"{url}/review", headers=HEADERS, json={"actor": "Reviewer One", "expected_revision": 0, "action": "accept"})
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "count_unresolved"
        span = counted["invalid_spans"][0]
        bogus = client.post(f"{url}/reconfirm", headers=HEADERS, json={"actor": "Reviewer One", "anchor_kind": "camera_moved",
                                                                         "anchor_id": gate["id"]})
        assert bogus.status_code == 409
        resumed = client.post(f"{url}/reconfirm", headers=HEADERS, json={"actor": "Reviewer One", "anchor_kind": span["anchor_kind"],
                                                                           "anchor_id": span["anchor_id"], "note": "Roost gap still under the line"}).json()
        assert resumed["invalid_spans"] == [] and len(resumed["crossings"]) == 2
        redrawn = client.post(f"{url}/reconfirm", headers=HEADERS, json={"actor": "Reviewer One", "anchor_kind": span["anchor_kind"],
                                                                           "anchor_id": span["anchor_id"], "points": [[100, 0], [100, 96]]}).json()
        after = [item for item in redrawn["crossings"] if int(item["pts"]) > int(events[0]["start_pts"])]
        assert len(after) == 1 and after[0]["key"] != [item for item in resumed["crossings"] if int(item["pts"]) > int(events[0]["start_pts"])][0]["key"]
        tiny = client.post(f"{url}/reconfirm", headers=HEADERS, json={"actor": "Reviewer One", "anchor_kind": span["anchor_kind"],
                                                                        "anchor_id": span["anchor_id"], "points": [[64, 0], [64, 4]]})
        assert tiny.status_code == 422
        accepted = client.post(f"{url}/review", headers=HEADERS, json={"actor": "Reviewer One", "expected_revision": 0, "action": "accept"})
        assert accepted.status_code == 200 and accepted.json()["layers"]["reviewer"]["state"] == "accepted"
        with sqlite3.connect(tmp_path / "app-data" / "bat_innovation.sqlite3") as connection:
            with pytest.raises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM gate_reconfirm")


def test_uncertain_crossings_wait_for_a_reviewer_decision(tmp_path: Path) -> None:
    dots = path((4, 40), (3, 0), 40)
    # Seen in only half of its frames: a gappy, uncertain track.
    frames = [frame([dots[i]] if i % 2 == 0 or i > 36 else []) for i in range(40)]
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, run_id, _summary = tracked(client, tmp_path, frames)
        gate = client.post(f"/api/sessions/{session_id}/gates", headers=HEADERS,
                           json={"actor": "Reviewer One", "expected_revision": 0, "value": gate_value()}).json()
        url = f"/api/tracking/{run_id}/gates/{gate['id']}"
        counted = client.get(f"{url}/counts", headers=HEADERS).json()
        (crossing,) = counted["crossings"]
        assert crossing["quality"] == "uncertain"
        assert counted["layers"]["algorithm"]["entered"] == 0 and counted["layers"]["algorithm"]["uncertain"] == 1
        assert counted["layers"]["reviewer"]["unresolved"] == 1 and counted["layers"]["reviewer"]["state"] == "unresolved"
        # Deciding an uncertain crossing needs no reason; it is exactly what the reviewer is asked to do.
        decided = client.post(f"{url}/review", headers=HEADERS, json={"actor": "Reviewer One", "expected_revision": 0, "action": "confirm",
                                                                       "key": crossing["key"]}).json()
        assert decided["layers"]["reviewer"]["state"] == "ready" and decided["layers"]["reviewer"]["entered"] == 1


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


def wait_export(client: TestClient, run_id: str) -> dict:
    job = client.post("/api/exports", headers=HEADERS, json={"run_id": run_id}).json()
    return wait(client, f"/api/exports/{job['id']}", ("working",))


def test_export_v3_includes_tracks_quality_and_all_three_count_layers(tmp_path: Path) -> None:
    import csv
    import io

    from backend.app import csv_export

    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id, run_id, summary = tracked(client, tmp_path, scenario("two_dots"))
        gate = client.post(f"/api/sessions/{session_id}/gates", headers=HEADERS,
                           json={"actor": "Reviewer One", "expected_revision": 0, "value": gate_value()}).json()
        url = f"/api/tracking/{run_id}/gates/{gate['id']}"
        first = client.get(f"{url}/counts", headers=HEADERS).json()["crossings"][0]
        client.post(f"{url}/review", headers=HEADERS, json={"actor": "Reviewer One", "expected_revision": 0, "action": "confirm", "key": first["key"]})
        job = wait_export(client, summary["id"])
        assert job["manifest"]["schema_version"] == "bat-provisional-csv-v4"
        assert job["manifest"]["tracking"]["settings"]["target_px"] == 12 and job["manifest"]["tracking"]["scene_events"] == []
        assert job["manifest"]["tracking"]["tracking_run_id"] == run_id and job["manifest"]["tracking"]["tracks"] == 2

        def rows(kind: str, columns: list[str]) -> list[dict]:
            response = client.get(f"/api/exports/{job['id']}/files/{kind}", headers=HEADERS)
            reader = csv.DictReader(io.StringIO(response.content.decode("utf-8"), newline=""))
            assert reader.fieldnames == columns
            return [{k: v if k in csv_export.NUMERIC else csv_export.decode_text(v) for k, v in row.items()} for row in reader]

        tracks = rows("tracks", csv_export.TRACK_COLUMNS)
        assert len(tracks) == 2 and all(row["tracking_run_id"] == run_id and row["quality"] == "coherent" for row in tracks)
        counted = rows("counts", csv_export.COUNT_COLUMNS)
        totals = {row["layer"]: row for row in counted if row["row_kind"] == "total"}
        assert (totals["algorithm"]["entered"], totals["algorithm"]["exited"]) == ("1", "1")
        assert totals["reviewer"]["entered"] != "" and totals["qa"]["entered"] == "" and totals["qa"]["qa_decision"] == ""
        crossings = [row for row in counted if row["row_kind"] == "crossing"]
        assert len(crossings) == 2 and sorted(row["review_action"] for row in crossings) == ["", "confirm"]
        assert {row["track_quality"] for row in crossings} == {"coherent"} and totals["reviewer"]["reviewer_state"] == "ready"
        audit = rows("audit", csv_export.AUDIT_COLUMNS)
        assert {row["modality"] for row in audit} == {"active_ir"}


def test_export_without_tracking_has_header_only_track_files(tmp_path: Path) -> None:

    source = tmp_path / "quiet.mp4"
    encode_frames(source, scenario("noise"), [index * 40 for index in range(20)])
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id = session(client)
        assert import_files(client, session_id, [source])["state"] == "complete"
        summary = client.post("/api/summaries", headers=HEADERS, json={"session_id": session_id, "window_seconds": 30}).json()
        summary = wait(client, f"/api/summaries/{summary['id']}", ("queued", "running"))
        job = wait_export(client, summary["id"])
        assert job["manifest"]["tracking"] is None
        assert job["manifest"]["files"]["tracks"]["rows"] == 0 and job["manifest"]["files"]["counts"]["rows"] == 0


def test_candidate_decisions_need_a_covering_preview_and_are_append_only(tmp_path: Path) -> None:
    from backend.tests.test_tracking import wait as wait_state

    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        _session_id, run_id, _summary = tracked(client, tmp_path, scenario("two_dots"))
        items = client.get(f"/api/tracking/{run_id}/candidates", headers=HEADERS).json()
        assert len(items) == 2 and all(item["decision"] is None and item["window_id"] for item in items)
        track = items[0]
        url = f"/api/tracking/{run_id}/candidates/{track['track_id']}/decision"
        bogus = client.post(url, headers=HEADERS, json={"actor": "R", "expected_revision": 0, "decision": "not_bat", "preview_id": "12345678-1234-4234-8234-123456789abc"})
        assert bogus.status_code == 409 and bogus.json()["detail"]["code"] == "candidate_unverified"
        preview = client.post("/api/media/preview", headers=HEADERS, json={"segment_id": track["segment_id"], "source_pts": track["first_pts"], "clip_seconds": 6}).json()
        preview = wait_state(client, f"/api/media/preview/{preview['id']}", ("running",))
        assert preview["state"] == "ready" and preview["manifest"]["clip_seconds"] == 6
        saved = client.post(url, headers=HEADERS, json={"actor": "Reviewer One", "expected_revision": 0, "decision": "not_bat",
                                                         "note": "Moth near the light", "preview_id": preview["id"]})
        assert saved.status_code == 200, saved.text
        assert saved.json()["decision"]["decision"] == "not_bat" and saved.json()["revision"] == 1
        stale = client.post(url, headers=HEADERS, json={"actor": "Reviewer One", "expected_revision": 0, "decision": "bat", "preview_id": preview["id"]})
        assert stale.status_code == 409 and stale.json()["detail"]["code"] == "candidate_conflict"
        with sqlite3.connect(tmp_path / "app-data" / "bat_innovation.sqlite3") as connection:
            with pytest.raises(sqlite3.IntegrityError):
                connection.execute("UPDATE candidate_event SET decision='bat'")


def test_highlight_clip_lengths_are_bounded(tmp_path: Path) -> None:
    source = tmp_path / "clip.mp4"
    encode_frames(source, scenario("two_dots"), [index * 40 for index in range(20)])
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id = session(client)
        assert import_files(client, session_id, [source])["state"] == "complete"
        segment = client.get(f"/api/sessions/{session_id}/media", headers=HEADERS).json()["segments"][0]
        refused = client.post("/api/media/preview", headers=HEADERS, json={"segment_id": segment["id"], "source_pts": segment["metadata"]["first_pts"], "clip_seconds": 30})
        assert refused.status_code == 422
