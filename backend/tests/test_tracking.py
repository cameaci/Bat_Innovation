"""Tracks from synthetic ground truth (feature expansion E2): IDs, dropouts, crossings, noise and storage."""

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


def frame(dots: list[tuple[int, int]], background: int = 40, noise: np.ndarray | None = None) -> np.ndarray:
    image = np.full((H, W), background, dtype=np.int16)
    if noise is not None:
        image += noise
    for x, y in dots:
        if 0 <= x < W - 2 and 0 <= y < H - 2:
            image[y:y + 3, x:x + 3] = 220
    return np.clip(image, 0, 255).astype(np.uint8)


def path(start: tuple[int, int], velocity: tuple[int, int], count: int) -> list[tuple[int, int]]:
    return [(start[0] + velocity[0] * index, start[1] + velocity[1] * index) for index in range(count)]


def run(frames: list[np.ndarray]) -> list[tracks.Track]:
    values = tracks.parameters()
    tracker = tracks.Tracker(W, values)
    previous = before = None
    for index, image in enumerate(frames):
        if before is not None:
            found, flag = tracks.candidates(tracks.difference(image, previous), tracks.difference(image, before), 1, values)
            tracker.gap() if flag else tracker.update(index * 40, found)
        previous, before = image, previous
    return tracker.finish()


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
    found = run(scenario("two_dots"))
    assert len(found) == 2
    assert all(len(track.points) >= 15 for track in found)
    xs = sorted(track.points[0][1] for track in found)
    assert xs[0] < 20 and xs[1] > 100


def test_short_dropout_does_not_split_a_track() -> None:
    found = run(scenario("dropout"))
    assert len(found) == 1


def test_crossing_paths_keep_their_direction() -> None:
    found = run(scenario("crossing"))
    assert len(found) == 2
    slopes = sorted((track.points[-1][2] - track.points[0][2]) for track in found)
    assert slopes[0] < 0 < slopes[1], "Each track continues in its own direction through the crossing"


def test_sensor_noise_alone_produces_no_tracks() -> None:
    assert run(scenario("noise")) == []


def test_framewide_flash_is_a_gap_not_a_burst_of_tracks() -> None:
    values = tracks.parameters()
    images = scenario("flash")
    flash = tracks.candidates(tracks.difference(images[10], images[9]), tracks.difference(images[10], images[8]), 1, values)
    assert flash == ([], "framewide_change")
    found = run(images)
    assert 1 <= len(found) <= 2 and all(len(track.points) >= 3 for track in found)


def test_target_leaving_the_frame_ends_its_track() -> None:
    found = run(scenario("edge_exit"))
    assert len(found) == 1 and found[0].points[-1][1] > 110


def test_slow_uniform_target_splits_into_edge_tracks_as_a_documented_limitation() -> None:
    """Change-based candidates see only the leading and trailing edges of a slow, uniform target.

    Bats usually move several body lengths per frame, where this does not occur; slow objects (insects close to
    the camera, a walking animal) can appear as two parallel tracks. Reviewers see both trails on the original.
    """
    found = run(scenario("slow_square"))
    assert len(found) == 2
    assert abs(found[0].points[0][2] - found[1].points[0][2]) < 1, "Both edges move together at the same height"


def test_points_round_trip_with_integrity() -> None:
    track = run(scenario("dropout"))[0]
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
        found = client.get(f"/api/tracking/{run['id']}/tracks", headers=HEADERS,
                           params={"segment_id": segment_id, "start_pts": 0}).json()
        assert len(found) == 2 and all(len(item["points"]) >= 15 for item in found)
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
