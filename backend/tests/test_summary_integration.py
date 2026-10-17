"""Real HTTP/PyAV/SQLite summary coverage and durable output failure contracts."""

from __future__ import annotations

from fractions import Fraction
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import time
from types import SimpleNamespace

import av
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from backend.app import media, store, summary_store
from backend.app.main import Settings, create_app
from backend.tests.media_fixtures import generate_media
from backend.tests.summary_fixtures import generate_summary_media

TOKEN = "synthetic-summary-integration-launch-token-long-enough"
HEADERS = {"X-Bat-Token": TOKEN}


@pytest.fixture(scope="module")
def sources(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    root = tmp_path_factory.mktemp("summary-api-originals")
    return {**generate_summary_media(root / "summary"), **generate_media(root / "timing")}


def prepare(directory: Path, paths: list[Path], *, upgrade: bool = True) -> tuple[Path, str, list[dict]]:
    database = directory / "bat_innovation.sqlite3"
    store.initialise(database)
    store.upgrade_media(database)
    session_id = store.create_session(database, "Synthetic source coverage", "Synthetic camera")["id"]
    store.commit_segments(database, session_id, [(path, media.inspect_source(path)) for path in paths])
    if upgrade:
        summary_store.upgrade(database)
    return database, session_id, store.private_segments(database, session_id)


def fraction(value: dict) -> Fraction:
    return Fraction(int(value.get("numerator", value.get("num"))),
                    int(value.get("denominator", value.get("den"))))


def wait_run(client: TestClient, run_id: str) -> dict:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        response = client.get(f"/api/summaries/{run_id}", headers=HEADERS)
        assert response.status_code == 200, response.text
        run = response.json()
        if run["state"] not in {"queued", "running"}:
            return run
        time.sleep(0.01)
    pytest.fail("Tiny real summary job exceeded its test deadline")


def start_run(client: TestClient, session_id: str) -> dict:
    response = client.post("/api/summaries", headers=HEADERS,
                           json={"session_id": session_id, "window_seconds": 30})
    assert response.status_code == 202, response.text
    return wait_run(client, response.json()["id"])


def assert_private_paths_absent(value: object, directory: Path) -> None:
    serialized = json.dumps(value)
    assert str(directory) not in serialized
    assert "source_path" not in serialized and "image_path" not in serialized


def test_real_pts_ownership_partial_windows_images_and_reopening(
    tmp_path: Path, sources: dict[str, Path],
) -> None:
    paths = [sources[name] for name in ("quiet_65", "quiet_9", "nonzero_mts", "irregular_mp4")]
    original_hashes = [media.file_sha256(path) for path in paths]
    database, session_id, segments = prepare(tmp_path / "data", paths)
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        run = start_run(client, session_id)
        assert run["state"] == "complete", run
        assert run["counts"]["planned"] == run["counts"]["complete"] == 6
        assert len(run["windows"]) == 6
        assert_private_paths_absent(run, tmp_path)
        assert_private_paths_absent(run, paths[0].parent.parent)
        all_images = []
        for segment, path in zip(segments, paths, strict=True):
            metadata = json.loads(segment["metadata_json"])
            windows = [row for row in run["windows"] if row["segment_id"] == segment["id"]]
            assert fraction(windows[0]["interval"]["elapsed_start"]) == 0
            assert fraction(windows[-1]["interval"]["end_time"]) == fraction(metadata["end_time"])
            for left, right in zip(windows, windows[1:]):
                assert left["interval"]["end_pts"] == right["interval"]["start_pts"]
                assert left["interval"]["elapsed_end"] == right["interval"]["elapsed_start"]
            expected: dict[int, list[int]] = {row["index"]: [] for row in windows}
            first_time = fraction(metadata["first_time"])
            with av.open(str(path)) as container:
                for frame in media.decoded_frames(container, container.streams.video[0]):
                    matches = [row for row in windows if fraction(row["interval"]["start_time"])
                               <= frame.pts * frame.time_base < fraction(row["interval"]["end_time"])]
                    assert len(matches) == 1, "Every original PTS must own exactly one half-open window"
                    expected[matches[0]["index"]].append(frame.pts)
                    assert matches[0]["index"] == (frame.pts * frame.time_base - first_time) // 30
            assert sum(row["stats"]["frame_count"] for row in windows) == metadata["frame_count"]
            for window in windows:
                points = expected[window["index"]]
                assert window["stats"]["frame_count"] == len(points)
                assert window["stats"]["first_pts"] == str(points[0])
                assert window["stats"]["last_pts"] == str(points[-1])
                assert window["stats"]["pts_digest"] == sha256("".join(f"{pts}\n" for pts in points).encode("ascii")).hexdigest()
                assert window["preview_pts"] == str(points[0])
                response = client.get(f"/api/summary-windows/{window['id']}/image", headers=HEADERS)
                assert response.status_code == 200, response.text
                assert response.headers["content-type"] == "image/png"
                assert response.headers["cache-control"] == "no-store"
                assert len(response.content) == window["image"]["bytes"] <= 4 * 1024 * 1024
                assert sha256(response.content).hexdigest() == window["image"]["sha256"]
                with Image.open(BytesIO(response.content)) as image:
                    assert image.format == "PNG"
                    assert image.width <= 1280 and image.height <= 500
                all_images.append((window["id"], response.content))
            if path == sources["quiet_65"]:
                assert [fraction(row["interval"]["elapsed_end"])-fraction(row["interval"]["elapsed_start"]) for row in windows] == [30,30,5]
                assert [row["stats"]["motion_pixels"] for row in windows] == [0,0,0]
            if path == sources["quiet_9"]:
                assert len(windows) == 1 and fraction(windows[0]["interval"]["elapsed_end"]) == 9
            if path == sources["irregular_mp4"]:
                assert windows[0]["stats"]["gap_count"] == 2
                assert windows[0]["flags"], "Declared-duration timestamp gaps must remain visible"
        assert client.get(f"/api/summaries/{run['id']}").status_code == 401
        assert client.get(f"/api/summary-windows/{run['windows'][0]['id']}/image").status_code == 401
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        reopened = client.get(f"/api/summaries/{run['id']}", headers=HEADERS).json()
        assert reopened["state"] == "complete"
        assert reopened["windows"] == run["windows"]
        assert client.get(f"/api/sessions/{session_id}/summary-runs", headers=HEADERS).json()[0]["id"] == run["id"]
        for window_id, content in all_images:
            assert client.get(f"/api/summary-windows/{window_id}/image", headers=HEADERS).content == content
    assert [media.file_sha256(path) for path in paths] == original_hashes


def test_empty_window_stays_explicit_and_survives_backend_restart(tmp_path: Path, sources: dict[str, Path]) -> None:
    database, session_id, _ = prepare(tmp_path / "data", [sources["empty_middle"]])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        run = start_run(client, session_id)
        assert run["state"] == "incomplete", run
        assert run["counts"]["planned"] == 3 and len(run["windows"]) == 3
        middle = run["windows"][1]
        assert fraction(middle["interval"]["elapsed_start"]) == 30
        assert fraction(middle["interval"]["elapsed_end"]) == 60
        assert middle["status"] == "incomplete"
        assert middle["error"]["code"] == "no_decoded_frames"
        assert middle["image"] is None and middle["stats"]["frame_count"] == 0
        assert client.get(f"/api/summary-windows/{middle['id']}/image", headers=HEADERS).status_code == 409
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        persisted = client.get(f"/api/summaries/{run['id']}", headers=HEADERS).json()
        assert persisted["state"] == "incomplete" and persisted["windows"] == run["windows"]


def test_single_frame_unknown_final_duration_has_no_invented_end(
    tmp_path: Path, sources: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_decoder = media.decoded_frames

    def absent_duration(container, stream, cancelled=lambda: False):
        for frame in original_decoder(container, stream, cancelled):
            yield SimpleNamespace(pts=frame.pts, time_base=frame.time_base, width=frame.width,
                                  height=frame.height, rotation=frame.rotation,
                                  interlaced_frame=frame.interlaced_frame, duration=None)

    # Encoders ordinarily manufacture a final duration. Withhold only this field at
    # the real decoded-frame metadata boundary; summary worker and HTTP remain real.
    with monkeypatch.context() as patch:
        patch.setattr(media, "decoded_frames", absent_duration)
        database, session_id, _ = prepare(tmp_path / "data", [sources["single"]])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        run = start_run(client, session_id)
        assert run["state"] == "incomplete", run
        assert len(run["windows"]) == 1
        window = run["windows"][0]
        assert window["interval"]["elapsed_end"] is None
        assert window["interval"]["end_pts"] is None and window["interval"]["end_time"] is None
        assert window["status"] == "incomplete" and window["error"]["code"] == "unknown_end"
        assert window["image"] is None
        assert window["stats"]["frame_count"] == 1


@pytest.mark.parametrize("change", ["changed", "missing", "unreadable"])
def test_completed_summary_invalidates_original_unavailability(
    tmp_path: Path, sources: dict[str, Path], monkeypatch: pytest.MonkeyPatch, change: str,
) -> None:
    original = tmp_path / "original.mp4"
    original.write_bytes(sources["quiet_9"].read_bytes())
    database, session_id, _ = prepare(tmp_path / "data", [original])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        run = start_run(client, session_id)
        assert run["state"] == "complete", run
        window = run["windows"][0]
        if change == "changed":
            with original.open("ab") as handle:
                handle.write(b"synthetic changed source")
            expected = "changed_source"
        elif change == "missing":
            original.unlink()
            expected = "missing_source"
        else:
            real_open = Path.open

            def inaccessible(path: Path, *args, **kwargs):
                if path == original:
                    raise PermissionError("Synthetic permission test must not leak this path")
                return real_open(path, *args, **kwargs)

            monkeypatch.setattr(Path, "open", inaccessible)
            expected = "unreadable_source"
        result = client.get(f"/api/summary-windows/{window['id']}/image", headers=HEADERS)
        assert result.status_code == 409
        assert result.json()["detail"]["code"] == expected
        current = client.get(f"/api/summaries/{run['id']}", headers=HEADERS).json()
        assert current["state"] == "incomplete"
        assert current["windows"][0]["status"] == "incomplete"
        assert current["windows"][0]["error"]["code"] == expected
        assert_private_paths_absent(current, tmp_path)


@pytest.mark.parametrize("change", ["missing", "corrupt"])
def test_missing_or_corrupt_image_cannot_remain_complete_after_restart(
    tmp_path: Path, sources: dict[str, Path], change: str,
) -> None:
    database, session_id, _ = prepare(tmp_path / "data", [sources["quiet_9"]])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        run = start_run(client, session_id)
        assert run["state"] == "complete", run
    image = Path(summary_store.private_window(database, run["windows"][0]["id"])["image_path"])
    if change == "missing":
        image.unlink()
    else:
        image.write_bytes(b"synthetic corrupt derived image")
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        persisted = client.get(f"/api/summaries/{run['id']}", headers=HEADERS).json()
        assert persisted["state"] == "incomplete"
        assert persisted["windows"][0]["status"] == "incomplete"
        assert persisted["windows"][0]["error"]["code"] == "image_unavailable"
        assert client.get(f"/api/summary-windows/{run['windows'][0]['id']}/image", headers=HEADERS).status_code == 409


def test_summary_upgrade_is_explicit_and_request_boundaries_reject_paths(tmp_path: Path, sources: dict[str, Path]) -> None:
    database, session_id, _ = prepare(tmp_path / "data", [sources["quiet_9"]], upgrade=False)
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        assert store.schema_version(database) == 2
        refused = client.post("/api/summaries", headers=HEADERS, json={"session_id": session_id, "window_seconds": 30})
        assert refused.status_code == 409
        assert store.schema_version(database) == 2
        upgraded = client.post("/api/summaries/upgrade", headers=HEADERS, json={})
        assert upgraded.status_code == 200, upgraded.text
        assert upgraded.json() == {"schema_version": 3}
        assert client.post("/api/summaries", headers=HEADERS, json={"session_id": session_id, "window_seconds": 30,
                                                               "path": "/not-an-accepted-source.mp4"}).status_code == 422
        for seconds in (0, 121, 1.5, True):
            assert client.post("/api/summaries", headers=HEADERS,
                               json={"session_id": session_id, "window_seconds": seconds}).status_code == 422
