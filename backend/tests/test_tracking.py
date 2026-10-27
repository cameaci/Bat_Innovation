"""Individual tracks from synthetic ground truth (tracks-v2): IDs, wings, losses, size, polarity, masks and scene events."""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient
import pytest

from backend.app import store, tracking_store, tracks
from backend.app.main import Settings, create_app
from backend.tests.summary_fixtures import encode_frames
from backend.tests.test_import import HEADERS, TOKEN, import_files, session
from backend.tests.test_thermal import legacy_v5

W, H = 128, 96


def frame(dots: list[tuple[int, int]], background: int = 40, noise: np.ndarray | None = None, value: int = 220) -> np.ndarray:
    image = np.full((H, W), background, dtype=np.int16)
    if noise is not None:
        image += noise
    for x, y in dots:
        if 0 <= x < W - 2 and 0 <= y < H - 2:
            image[y:y + 3, x:x + 3] = value
    return np.clip(image, 0, 255).astype(np.uint8)


def path(start: tuple[int, int], velocity: tuple[int, int], count: int) -> list[tuple[int, int]]:
    return [(start[0] + velocity[0] * index, start[1] + velocity[1] * index) for index in range(count)]


def run(frames: list[np.ndarray], **settings) -> tuple[list[tracks.Track], list[tracks.SceneEvent], dict]:
    """25 fps frames with PTS in milliseconds."""
    analyzer = tracks.Analyzer(frames[0].shape[1], frames[0].shape[0], 25.0, 0.001, settings)
    for index, image in enumerate(frames):
        analyzer.feed(index * 40, image)
    return analyzer.finish()


def real(found: list[tracks.Track]) -> list[tracks.Track]:
    return [track for track in found if track.quality != "noise"]


def textured(seed: int = 3) -> np.ndarray:
    rng = np.random.default_rng(seed)
    coarse = rng.integers(20, 90, size=(H // 8 + 2, W // 8 + 2))
    return np.kron(coarse, np.ones((8, 8), dtype=np.int64))[:H + 8, :W + 8].astype(np.uint8)


def scenario(name: str) -> list[np.ndarray]:
    if name == "two_dots":
        a, b = path((4, 20), (5, 0), 20), path((120, 70), (-5, 0), 20)
        return [frame([a[i], b[i]]) for i in range(20)]
    if name == "dropout":
        a = path((4, 40), (5, 1), 20)
        return [frame([] if i in (9, 10) else [a[i]]) for i in range(20)]
    if name == "crossing":
        a, b = path((4, 10), (5, 3), 20), path((4, 80), (5, -3), 20)
        return [frame([a[i], b[i]]) for i in range(20)]
    if name == "noise":
        rng = np.random.default_rng(7)
        return [frame([], noise=rng.integers(-3, 4, size=(H, W))) for _ in range(20)]
    if name == "flash":
        a = path((4, 40), (5, 0), 20)
        return [frame([a[i]], background=200 if i == 10 else 40) for i in range(20)]
    if name == "slow_square":
        frames = []
        for index in range(30):
            image = np.full((H, W), 40, dtype=np.uint8)
            image[40:48, 10 + index:18 + index] = 220
            frames.append(image)
        return frames
    if name == "edge_exit":
        a = path((90, 40), (6, 0), 12)
        return [frame([a[i]]) for i in range(12)]
    raise ValueError(name)


def test_two_targets_keep_one_track_each() -> None:
    found, events, _ = run(scenario("two_dots"))
    assert len(real(found)) == 2 and not events
    assert all(len(track.points) >= 15 for track in found)
    assert sorted(track.points[0][1] for track in found)[0] < 20


def test_flapping_wings_and_body_are_one_target() -> None:
    images = []
    for index in range(30):
        image = np.full((H, W), 40, dtype=np.uint8)
        x, y = 10 + 3 * index, 45
        image[y:y + 3, x:x + 4] = 220  # body
        lift = -3 if index % 2 else 2  # wings beat up and down, separated from the body by a gap
        image[y + lift:y + lift + 2, x - 5:x - 2] = 200
        image[y + lift:y + lift + 2, x + 6:x + 9] = 200
        images.append(image)
    found, _, _ = run(images)
    assert len(real(found)) == 1 and real(found)[0].quality == "coherent"


def test_short_dropout_coasts_and_a_longer_loss_is_joined() -> None:
    found, _, _ = run(scenario("dropout"))
    assert len(found) == 1 and found[0].joins == 0
    target = path((2, 50), (2, 0), 60)
    found, _, stats = run([frame([] if 20 <= i < 35 else [target[i]]) for i in range(60)])
    assert len(real(found)) == 1 and found[0].joins == 1 and stats["joins"] == 1


def test_slow_uniform_target_is_one_track() -> None:
    """The median background sees the whole square, not its leading and trailing edges (the tracks-v1 limitation)."""
    found, _, _ = run(scenario("slow_square"))
    assert len(found) == 1


def test_crossing_paths_keep_their_identity() -> None:
    found, _, _ = run(scenario("crossing"))
    assert len(found) == 2
    for track in found:
        ys = [point[2] for point in track.points]
        assert (ys[-1] - ys[0]) * (ys[1] - ys[0]) > 0, "Each track continues in its own direction through the crossing"
        assert np.all(np.sign(np.diff(ys)) == np.sign(ys[-1] - ys[0]))


def test_sensor_noise_and_a_tiny_insect_produce_no_tracks() -> None:
    found, _, _ = run(scenario("noise"))
    assert found == []
    insect = path((4, 30), (4, 1), 25)
    images = []
    for index in range(25):
        image = np.full((H, W), 40, dtype=np.uint8)
        image[insect[index][1], insect[index][0]] = 220
        images.append(image)
    found, _, stats = run(images)
    assert found == [] and stats["rejected_size"] > 0


def test_polarity_selects_dark_or_light_targets() -> None:
    dark = path((4, 40), (4, 0), 25)
    images = [frame([dark[i]], background=150, value=20) for i in range(25)]
    assert len(real(run(images, polarity="dark")[0])) == 1
    assert run(images, polarity="light")[0] == []


def test_exclusion_zone_and_detection_area_limit_where_targets_are_found() -> None:
    rng = np.random.default_rng(5)
    target = path((4, 70), (4, 0), 25)
    images = []
    for index in range(25):
        image = frame([target[index]])
        image[5:25, 90:120] = rng.integers(40, 250, size=(20, 30))  # flickering lamp or foliage
        images.append(image)
    assert any(track.box[0] >= 80 and track.box[1] < 30 for track in run(images)[0])
    excluded, _, _ = run(images, exclusions=[[[85, 0], [128, 0], [128, 30], [85, 30]]])
    assert len(excluded) == 1 and excluded[0].box[1] > 60
    outside, _, _ = run(images, detection_area=[[[0, 0], [128, 0], [128, 40], [0, 40]]], exclusions=[[[85, 0], [128, 0], [128, 30], [85, 30]]])
    assert outside == []


def test_one_frame_flash_is_a_glitch_and_the_track_continues() -> None:
    found, events, stats = run(scenario("flash"))
    assert [event.kind for event in events] == ["glitch"]
    assert len(found) == 1 and stats["disturbed_frames"] == 1


def test_lighting_step_keeps_tracks_and_resets_the_background() -> None:
    target = path((2, 40), (2, 0), 80)
    found, events, _ = run([frame([target[i]], background=40 if i < 45 else 80) for i in range(80)])
    assert [event.kind for event in events] == ["lighting_change"]
    assert len(real(found)) == 1 and found[0].points[0][1] < 10 and found[0].points[-1][1] > 100


def test_camera_shift_is_classified_and_ends_tracks() -> None:
    scene = textured()
    target = path((2, 40), (2, 0), 80)
    images = []
    for index in range(80):
        offset = 0 if index < 45 else 6
        image = scene[offset:offset + H, offset:offset + W].copy()
        x, y = target[index]
        image[y:y + 3, x:x + 3] = 240
        images.append(image)
    found, events, _ = run(images)
    assert [event.kind for event in events] == ["camera_moved"]
    assert abs(abs(events[0].details["shift_px"][0]) - 6) <= 1
    assert all(track.points[-1][0] < events[0].start_pts or track.points[0][0] > events[0].start_pts for track in found)
    assert {track.epoch for track in real(found)} == {0, 1}


def test_target_leaving_the_frame_ends_its_track() -> None:
    found = real(run(scenario("edge_exit"))[0])
    assert len(found) == 1 and found[0].points[-1][1] > 110


def test_dense_targets_stay_within_limits() -> None:
    rng = np.random.default_rng(11)
    starts = [(int(rng.integers(0, 40)), int(rng.integers(0, 90))) for _ in range(30)]
    images = [frame([(x + 3 * i, y) for x, y in starts]) for i in range(25)]
    found, _, stats = run(images, activity="dense")
    assert stats["limit_frames"] == 0 and 10 <= len(found) <= 40


def test_settings_are_validated_and_hashed() -> None:
    with pytest.raises(ValueError):
        tracks.settings_with_defaults({"unknown": 1})
    assert tracks.parameter_hash(tracks.parameters()) != tracks.parameter_hash(tracks.parameters({"target_px": 20}))
    with pytest.raises(ValueError):
        tracks.Analyzer(W, H, 25.0, 0.001, {"detection_area": [[[0, 0], [1, 0], [0, 1]]], "exclusions": [[[0, 0], [128, 0], [128, 96], [0, 96]]]})


def test_points_round_trip_with_integrity() -> None:
    track = run(scenario("dropout"))[0][0]
    blob = tracks.pack(track.points)
    restored = tracks.unpack(blob)
    assert [int(value) for value in restored["pts"]] == [point[0] for point in track.points]
    with pytest.raises(ValueError):
        tracks.unpack(b"xxxx" + blob[4:])


def test_tracking_upgrade_is_explicit_and_rolls_back(tmp_path: Path) -> None:
    db_path = legacy_v5(tmp_path)
    store.upgrade_modality(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE track (conflict TEXT)")
    with pytest.raises(sqlite3.OperationalError):
        tracking_store.upgrade(db_path)
    assert store.schema_version(db_path) == store.MODALITY_SCHEMA_VERSION


def wait(client: TestClient, url: str, active: tuple[str, ...], seconds: float = 60) -> dict:
    deadline = time.monotonic() + seconds
    while (value := client.get(url, headers=HEADERS).json())["state"] in active:
        assert time.monotonic() < deadline
        time.sleep(0.1)
    return value


def test_real_tracking_run_persists_tracks_for_a_summarised_video(tmp_path: Path) -> None:
    source = tmp_path / "two-dots.mp4"
    encode_frames(source, scenario("two_dots"), [index * 40 for index in range(20)])
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id = session(client)
        assert import_files(client, session_id, [source])["state"] == "complete"
        summary = client.post("/api/summaries", headers=HEADERS, json={"session_id": session_id, "window_seconds": 30}).json()
        summary = wait(client, f"/api/summaries/{summary['id']}", ("queued", "running"))
        response = client.post("/api/tracking", headers=HEADERS, json={"summary_run_id": summary["id"]})
        assert response.status_code == 202, response.text
        run = wait(client, f"/api/tracking/{response.json()['id']}", ("queued", "running"))
        assert run["state"] == "complete", run
        segment_id = summary["windows"][0]["segment_id"]
        assert run["track_counts"] == {segment_id: 2} and run["window_counts"] == {summary["windows"][0]["id"]: 2}
        assert run["stats"][segment_id]["tracks"] == 2 and run["parameter_hash"] == tracks.parameter_hash(run["parameters"])
        page = client.get(f"/api/tracking/{run['id']}/tracks", headers=HEADERS,
                          params={"segment_id": segment_id, "start_pts": 0}).json()
        found = page["tracks"]
        assert page["shown"] == page["total"] == 2 and page["noise_hidden"] == 0
        assert len(found) == 2 and all(len(item["points"]) >= 15 for item in found)
        assert {item["quality"] for item in found} == {"coherent"} and all("straightness" in item["metrics"] for item in found)
        assert run["parameters"]["algorithm_version"] == "tracks-v2" and run["parameters"]["settings"]["target_px"] == 12
        # Many more stored tracks than fit: coherent first within the points budget, noise hidden, and the cut reported.
        extra = []
        for index in range(30):
            track = tracks.Track(quality="noise" if index % 3 == 0 else "uncertain" if index % 3 == 1 else "coherent")
            for step in range(10):
                track.add(step * 40, tracks.Detection(10 + step, 10 + index, 9, (9, 9, 12, 12), 30.0))
            extra.append(track)
        db = tmp_path / "app-data" / "bat_innovation.sqlite3"
        with sqlite3.connect(db) as connection:
            for index, track in enumerate(extra, start=2):
                blob = tracks.pack(track.points)
                connection.execute("""INSERT INTO track (id, run_id, segment_id, track_index, first_pts, last_pts, point_count,
                    bbox_json, points, points_sha256, quality, metrics_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (f"extra-{index}", run["id"], segment_id, index, "0", "360", 10, "[9,9,12,12]", blob, tracks.digest(blob), track.quality, "{}"))
        real_points = sum(item["point_count"] for item in found)
        page = tracking_store.tracks_between(db, run["id"], segment_id, 0, None, point_budget=real_points + 150)
        assert page["total"] == 22 and page["shown"] == 17 and page["noise_hidden"] == 10
        assert sum(item["quality"] == "coherent" for item in page["tracks"]) == 12
        assert all(item["quality"] != "noise" for item in page["tracks"])
        assert tracking_store.tracks_between(db, run["id"], segment_id, 0, None, include_noise=True)["total"] == 32
        assert client.get(f"/api/tracking/{run['id']}/events", headers=HEADERS).json() == []
        assert client.get(f"/api/summaries/{summary['id']}/tracking", headers=HEADERS).json()[0]["id"] == run["id"]
        # Changed bytes after summarising are refused rather than tracked.
        with source.open("ab") as handle:
            handle.write(b"synthetic change")
        refused = client.post("/api/tracking", headers=HEADERS, json={"summary_run_id": summary["id"]})
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "changed_source"


def test_tracking_requires_storage_upgrade(tmp_path: Path) -> None:
    data_dir = tmp_path / "app-data"
    data_dir.mkdir()
    legacy_v5(data_dir)
    with TestClient(create_app(Settings(data_dir, TOKEN))) as client:
        response = client.post("/api/tracking", headers=HEADERS, json={"summary_run_id": "12345678-1234-4234-8234-123456789abc"})
        assert response.status_code == 409 and response.json()["detail"]["code"] == "tracking_upgrade_required"


def test_calibration_test_tracks_a_range_without_storing_anything(tmp_path: Path) -> None:
    source = tmp_path / "two-dots.mp4"
    encode_frames(source, scenario("two_dots"), [index * 40 for index in range(20)])
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id = session(client)
        assert import_files(client, session_id, [source])["state"] == "complete"
        segment = client.get(f"/api/sessions/{session_id}/media", headers=HEADERS).json()["segments"][0]
        first = int(segment["metadata"]["first_pts"])
        body = {"segment_id": segment["id"], "start_pts": first, "end_pts": first + 16000 * 2 // 5,
                "settings": {"target_px": 6, "exclusions": [[[100, 50], [128, 50], [128, 96], [100, 96]]]}}
        started = client.post("/api/tracking-tests", headers=HEADERS, json=body)
        assert started.status_code == 202, started.text
        result = wait(client, f"/api/tracking-tests/{started.json()['id']}", ("running",))
        assert result["state"] == "complete", result
        value = result["result"]
        assert len([track for track in value["tracks"] if track["quality"] != "noise"]) >= 1
        assert value["detections"] and all(set(item) == {"pts", "accepted", "rejected"} for item in value["detections"])
        assert value["stats"]["analysis_step"] == 1
        db = tmp_path / "app-data" / "bat_innovation.sqlite3"
        with sqlite3.connect(db) as connection:
            assert connection.execute("SELECT COUNT(*) FROM track").fetchone()[0] == 0
        too_long = client.post("/api/tracking-tests", headers=HEADERS, json={**body, "end_pts": first + 16000 * 20})
        failed = wait(client, f"/api/tracking-tests/{too_long.json()['id']}", ("running",))
        assert failed["state"] == "failed" and failed["error"] == "tracking_limit"
        everything = client.post("/api/tracking-tests", headers=HEADERS, json={**body, "settings": {"exclusions": [[[0, 0], [128, 0], [128, 96], [0, 96]]]}})
        refused = wait(client, f"/api/tracking-tests/{everything.json()['id']}", ("running",))
        assert refused["error"] == "tracking_settings"
        bad = client.post("/api/tracking-tests", headers=HEADERS, json={**body, "settings": {"target_px": 500}})
        assert bad.status_code == 422


def test_tracks_v2_upgrade_from_v11_and_rollback(tmp_path: Path) -> None:
    from backend.app import audio_store, candidate_store, count_store, proxy_store

    db_path = legacy_v5(tmp_path)
    for step in (store.upgrade_modality, tracking_store.upgrade, count_store.upgrade, candidate_store.upgrade, audio_store.upgrade,
                 proxy_store.upgrade):
        step(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE tracking_event (conflict TEXT)")
    with pytest.raises(sqlite3.OperationalError):
        tracking_store.upgrade_v2(db_path)
    assert store.schema_version(db_path) == store.PROXY_SCHEMA_VERSION
    with sqlite3.connect(db_path) as connection:
        assert "quality" not in [row[1] for row in connection.execute("PRAGMA table_info(track)")]
        connection.execute("DROP TABLE tracking_event")
    tracking_store.upgrade_v2(db_path)
    assert store.schema_version(db_path) == store.TRACKS_V2_SCHEMA_VERSION


def test_flight_map_bins_build_up_with_time_and_leave_out_noise(tmp_path: Path) -> None:
    target = [(2 + index // 3, 40) for index in range(300)]  # 12 s at 25 fps: two 10 s bins
    source = tmp_path / "long.mp4"
    encode_frames(source, [frame([target[i]]) for i in range(300)], [index * 40 for index in range(300)])
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id = session(client)
        assert import_files(client, session_id, [source])["state"] == "complete"
        summary = client.post("/api/summaries", headers=HEADERS, json={"session_id": session_id, "window_seconds": 30}).json()
        summary = wait(client, f"/api/summaries/{summary['id']}", ("queued", "running"))
        run = client.post("/api/tracking", headers=HEADERS, json={"summary_run_id": summary["id"]}).json()
        run = wait(client, f"/api/tracking/{run['id']}", ("queued", "running"))
        segment_id = summary["windows"][0]["segment_id"]
        bins = client.get(f"/api/tracking/{run['id']}/flight-map", headers=HEADERS, params={"segment_id": segment_id}).json()
        assert bins["bin_seconds"] == 10 and [item["index"] for item in bins["bins"]] == [0, 1]
        found = client.get(f"/api/tracking/{run['id']}/tracks", headers=HEADERS,
                           params={"segment_id": segment_id, "start_pts": 0, "include_noise": True}).json()["tracks"]
        kept = sum(item["point_count"] for item in found if item["quality"] != "noise")
        assert sum(count for item in bins["bins"] for _, count in item["cells"]) == kept
        assert bins["bins"][0]["cells"][0][0] < bins["bins"][1]["cells"][-1][0], "The target moved right across the map"
