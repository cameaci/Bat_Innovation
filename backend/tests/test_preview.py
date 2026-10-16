"""Real limited-worker previews, exact original markers and atomic cleanup boundaries."""

from __future__ import annotations

from fractions import Fraction
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
from threading import Event, Lock
import time
from uuid import uuid4

import av
from fastapi.testclient import TestClient
import pytest

from backend.app import media, preview, preview_worker, store
from backend.app.main import Settings, create_app
from backend.tests.preview_fixtures import CASES, generate_marker_media

TOKEN = "synthetic-preview-test-launch-token-long-enough"
HEADERS = {"X-Bat-Token": TOKEN}


@pytest.fixture(scope="module")
def videos(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    return generate_marker_media(tmp_path_factory.mktemp("preview-original-markers"))


def prepared(directory: Path, source: Path) -> tuple[Path, dict]:
    database = directory / "bat_innovation.sqlite3"
    store.initialise(database)
    store.upgrade_media(database)
    session_id = store.create_session(database, "Synthetic marker session", "Synthetic camera")["id"]
    store.commit_segments(database, session_id, [(source, media.inspect_source(source))])
    return database, store.private_segments(database, session_id)[0]


def wait_job(get, job_id: str) -> dict:
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        job = get(job_id)
        if job["state"] != "running":
            return job
        time.sleep(0.005)
    pytest.fail("Bounded synthetic preview did not finish")


def api_job(client: TestClient, segment_id: str, pts: str) -> dict:
    response = client.post("/api/media/preview", headers=HEADERS, json={"segment_id": segment_id, "source_pts": pts})
    assert response.status_code == 202, response.text
    return wait_job(lambda key: client.get(f"/api/media/preview/{key}", headers=HEADERS).json(), response.json()["id"])


def rational(value: dict) -> Fraction:
    return Fraction(int(value["num"]), int(value["den"]))


@pytest.mark.parametrize("name", list(CASES))
@pytest.mark.parametrize("point", ["first", "middle", "last"])
def test_exact_markers_first_middle_last_and_bounded_source_mapping(
    tmp_path: Path, videos: dict[str, Path], name: str, point: str,
) -> None:
    source = videos[name]
    before = sha256(source.read_bytes()).hexdigest()
    database, row = prepared(tmp_path / "app-data", source)
    case = CASES[name]
    indices = case["indices"]
    index = {"first": 0, "middle": len(indices) // 2, "last": len(indices) - 1}[point]
    requested = case["origin"] + indices[index] * case["step"]
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        job = api_job(client, row["id"], str(requested))
        assert job["state"] == "ready", job
        manifest = job["manifest"]
        assert manifest["requested_pts"] == manifest["actual_pts"] == str(requested)
        assert rational(manifest["seek_error"]) == 0
        assert 0 < manifest["preview_duration_ms"] <= 2000
        assert rational(manifest["source_end"]) - rational(manifest["source_start"]) <= 2
        assert manifest["width"] <= 960 and manifest["height"] <= 540
        assert manifest["source_sha256"] == before
        assert len(manifest["frames"]) <= 300
        response = client.get(f"/api/media/preview/{job['id']}/content", headers=HEADERS)
        assert response.status_code == 200 and response.headers["content-type"] == "video/webm"
        assert response.headers["cache-control"] == "no-store"
        assert 0 < len(response.content) <= preview.MAX_BYTES
        with av.open(BytesIO(response.content)) as derived:
            decoded = list(derived.decode(video=0))
        assert len(decoded) == len(manifest["frames"])
        for frame, mapping in zip(decoded, manifest["frames"]):
            source_pts = int(mapping["source_pts"])
            source_time = Fraction(source_pts, case["denominator"])
            assert rational(mapping["source_time"]) == source_time
            assert rational(mapping["elapsed"]) == source_time - Fraction(case["origin"], case["denominator"])
            assert frame.pts * frame.time_base == Fraction(mapping["preview_ms"], 1000)
            assert abs(frame.pts * frame.time_base - (source_time - rational(manifest["source_start"]))) <= Fraction(1, 2000)
            marker_index = (source_pts - case["origin"]) // case["step"]
            gray = frame.reformat(format="gray")
            plane = bytes(gray.planes[0])
            visible = sum((plane[60 * gray.planes[0].line_size + 15 + bit * 20] > 128) << bit for bit in range(8))
            assert visible == marker_index
        last = manifest["frames"][-1]
        assert rational(manifest["source_last"]) == rational(last["source_time"])
        assert str(source.parent) not in json.dumps(job) and "source_path" not in json.dumps(job)
        # Repeated requests must not race a terminal job's processing reservation.
        replacement = api_job(client, row["id"], str(requested))
        assert replacement["state"] == "ready"
        assert client.get(f"/api/media/preview/{job['id']}/content", headers=HEADERS).status_code == 409
        assert len(list((database.parent / "previews").glob("*.webm"))) == 1
    assert list((database.parent / "previews").iterdir()) == []
    assert sha256(source.read_bytes()).hexdigest() == before


def test_irregular_nonframe_request_has_explicit_forward_seek_error(tmp_path: Path, videos: dict[str, Path]) -> None:
    database, row = prepared(tmp_path / "data", videos["irregular_mp4"])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        job = api_job(client, row["id"], "1024")
        assert job["state"] == "ready"
        assert job["manifest"]["actual_pts"] == "1536"
        assert rational(job["manifest"]["seek_error"]) == Fraction(1, 25)


@pytest.mark.parametrize("change", ["changed", "missing", "unreadable"])
def test_ready_status_and_content_invalidate_changed_or_unavailable_originals(
    tmp_path: Path, videos: dict[str, Path], monkeypatch: pytest.MonkeyPatch, change: str,
) -> None:
    source = tmp_path / "original.mp4"
    shutil.copyfile(videos["cfr_mp4"], source)
    database, row = prepared(tmp_path / "data", source)
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        job = api_job(client, row["id"], "0")
        assert job["state"] == "ready"
        if change == "changed":
            with source.open("ab") as handle:
                handle.write(b"changed original")
            expected = "changed_source"
        elif change == "missing":
            source.unlink()
            expected = "missing_source"
        else:
            real_open = Path.open

            def inaccessible(path, *args, **kwargs):
                if path == source:
                    raise PermissionError("Private source path must not escape")
                return real_open(path, *args, **kwargs)

            monkeypatch.setattr(Path, "open", inaccessible)
            expected = "unreadable_source"
        status = client.get(f"/api/media/preview/{job['id']}", headers=HEADERS).json()
        assert status["state"] == "failed" and status["manifest"] is None
        assert status["error"]["code"] == expected
        response = client.get(f"/api/media/preview/{job['id']}/content", headers=HEADERS)
        assert response.status_code == 409 and response.json()["detail"]["code"] == expected
        assert str(source) not in response.text
        assert list((database.parent / "previews").iterdir()) == []


def test_auth_paths_integer_bounds_unknown_timing_and_end_boundary(tmp_path: Path, videos: dict[str, Path]) -> None:
    database, row = prepared(tmp_path / "data", videos["short_mp4"])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        route = "/api/media/preview"
        payload = {"segment_id": row["id"], "source_pts": "0"}
        assert client.post(route, json=payload).status_code == 401
        for suffix in ("", "/content", "/cancel"):
            method = client.post if suffix == "/cancel" else client.get
            assert method(f"{route}/{uuid4()}{suffix}").status_code == 401
        for value in (0, "1.5", "1e2", "9223372036854775808", "-9223372036854775809", "0;bad"):
            assert client.post(route, headers=HEADERS, json={**payload, "source_pts": value}).status_code == 422
        private = "/confidential/arbitrary.mp4"
        response = client.post(route, headers=HEADERS, json={**payload, "path": private})
        assert response.status_code == 422 and private not in response.text
        for value in ("-1", "1025", "1536"):
            response = client.post(route, headers=HEADERS, json={**payload, "source_pts": value})
            assert response.status_code == 400 and response.json()["detail"]["code"] == "outside_source"
        missing = client.post(route, headers=HEADERS, json={**payload, "segment_id": str(uuid4())})
        assert missing.status_code == 404
        metadata = json.loads(row["metadata_json"])
        metadata["end_time"] = None
        with sqlite3.connect(database) as connection:
            connection.execute("UPDATE segment SET metadata_json=? WHERE id=?", (json.dumps(metadata), row["id"]))
        response = client.post(route, headers=HEADERS, json=payload)
        assert response.status_code == 409 and response.json()["detail"]["code"] == "unknown_timing"


def stopped_worker(jobs: preview.PreviewJobs, job: dict) -> int:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        process = jobs._process
        if process is not None and process.poll() is None:
            os.kill(process.pid, signal.SIGSTOP)
            return process.pid
        time.sleep(0.001)
    pytest.fail("Real preview worker did not start")


@pytest.mark.parametrize("stop", ["cancel", "timeout", "close"])
def test_real_worker_cancellation_timeout_shutdown_reap_and_clean(
    tmp_path: Path, videos: dict[str, Path], monkeypatch: pytest.MonkeyPatch, stop: str,
) -> None:
    database, row = prepared(tmp_path / "data", videos["long_mp4"])
    if stop == "timeout":
        monkeypatch.setattr(preview, "WALL_SECONDS", 0.15)
    activity = Lock()
    jobs = preview.PreviewJobs(database, database.parent, activity)
    job = jobs.start(row["id"], "0")
    pid = stopped_worker(jobs, job)
    assert not activity.acquire(blocking=False)
    if stop == "cancel":
        jobs.cancel(job["id"])
    elif stop == "close":
        jobs.close()
    completed = wait_job(jobs.get, job["id"])
    assert completed["state"] == ("failed" if stop == "timeout" else "cancelled")
    assert completed["error"]["code"] == ("preview_limit" if stop == "timeout" else "cancelled")
    assert not Path(f"/proc/{pid}").exists()
    assert list(jobs.directory.iterdir()) == []
    assert activity.acquire(blocking=False)
    activity.release()
    jobs.close()


def test_preview_worker_enforces_hard_linux_limits_and_no_launch_token(tmp_path: Path, videos: dict[str, Path]) -> None:
    database, row = prepared(tmp_path / "data", videos["long_mp4"])
    jobs = preview.PreviewJobs(database, database.parent, Lock())
    job = jobs.start(row["id"], "0")
    deadline = time.monotonic() + 2
    pid = None
    while time.monotonic() < deadline:
        process = jobs._process
        if process is not None:
            values = Path(f"/proc/{process.pid}/limits").read_text()
            if "Max address space         1073741824" in values:
                pid = process.pid
                os.kill(pid, signal.SIGSTOP)
                break
        time.sleep(0.001)
    assert pid is not None
    assert "Max cpu time              20" in values
    assert "Max file size             8388608" in values
    assert b"BAT_API_TOKEN=" not in Path(f"/proc/{pid}/environ").read_bytes()
    jobs.close()
    assert not Path(f"/proc/{pid}").exists()


def test_import_and_preview_share_one_atomic_processing_reservation(
    tmp_path: Path, videos: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    database, row = prepared(tmp_path / "data", videos["cfr_mp4"])
    entered, release = Event(), Event()
    real_inspect = media.inspect_source

    def paused(path, progress, cancelled):
        entered.set()
        while not release.wait(0.005):
            if cancelled():
                raise media.MediaError("cancelled", "Cancelled")
        return real_inspect(path, progress, cancelled)

    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        monkeypatch.setattr(media, "inspect_source", paused)
        imported = client.post("/api/media/import", headers=HEADERS,
                               json={"session_id": row["session_id"], "paths": [str(videos["short_mp4"])]}).json()
        assert entered.wait(2)
        response = client.post("/api/media/preview", headers=HEADERS, json={"segment_id": row["id"], "source_pts": "0"})
        assert response.status_code == 409 and response.json()["detail"]["code"] == "import_busy"
        client.post(f"/api/media/import/{imported['id']}/cancel", headers=HEADERS)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            state = client.get(f"/api/media/import/{imported['id']}", headers=HEADERS).json()["state"]
            if state != "running":
                break
            time.sleep(0.005)
        assert state == "cancelled"
        monkeypatch.undo()
        assert api_job(client, row["id"], "0")["state"] == "ready"


def test_worker_explicit_bounds_and_unseekable_state(tmp_path: Path, videos: dict[str, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    source = videos["cfr_mp4"]
    metadata = media.inspect_source(source)
    identity = metadata.pop("_identity")
    payload = {"source_path": str(source), "output_path": str(tmp_path / "bounded.webm"), "source_pts": "0",
               "segment_id": str(uuid4()), "identity": identity, "metadata": metadata}
    monkeypatch.setattr(preview_worker, "MAX_FRAMES", 1)
    with pytest.raises(media.MediaError) as error:
        preview_worker.render(payload)
    assert error.value.code == "preview_limit"
    monkeypatch.undo()
    actual_open = av.open

    class Unseekable:
        def __init__(self, original):
            self.original = original
            self.streams = original.streams

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.original.close()

        def seek(self, *args, **kwargs):
            raise OSError("Private filesystem information must not escape")

    monkeypatch.setattr(av, "open", lambda *args, **kwargs: Unseekable(actual_open(*args, **kwargs)))
    with pytest.raises(media.MediaError) as error:
        preview_worker.render(payload)
    assert error.value.code == "unseekable_source"


def test_non_millisecond_source_pts_keep_exact_labels_and_bounded_display_quantisation(tmp_path: Path) -> None:
    import subprocess
    from backend.tests.preview_fixtures import HEIGHT, WIDTH, marker_rgb

    source = tmp_path / "fractional-source.mp4"
    source_pts = [index * 1001 for index in range(8)]
    pixels = b"".join(marker_rgb(index, pts, 30000) for index, pts in enumerate(source_pts))
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "rawvideo",
        "-pixel_format", "rgb24", "-video_size", f"{WIDTH}x{HEIGHT}", "-framerate", "30000/1001",
        "-i", "pipe:0", "-c:v", "libx264", "-video_track_timescale", "30000", "-pix_fmt", "yuv420p", str(source),
    ], input=pixels, check=True, capture_output=True, timeout=30)
    metadata = media.inspect_source(source)
    identity = metadata.pop("_identity")
    assert rational(metadata["time_base"]) == Fraction(1, 30000)
    assert metadata["last_pts"] == "7007"
    # Nominal rates are deliberately wrong: only original decoded PTS may drive the mapping.
    metadata["average_rate"] = {"num": "1", "den": "1"}
    metadata["base_rate"] = {"num": "1", "den": "1"}
    output = tmp_path / "fractional-preview.webm"
    manifest = preview_worker.render({
        "source_path": str(source), "output_path": str(output), "source_pts": "0",
        "segment_id": str(uuid4()), "identity": identity, "metadata": metadata,
    })
    assert [int(frame["source_pts"]) for frame in manifest["frames"]] == source_pts
    assert rational(manifest["source_end"]) == Fraction(8008, 30000)
    with av.open(output) as derived:
        decoded = list(derived.decode(video=0))
    errors = []
    for index, (frame, mapping) in enumerate(zip(decoded, manifest["frames"], strict=True)):
        source_time = Fraction(source_pts[index], 30000)
        assert rational(mapping["source_time"]) == rational(mapping["elapsed"]) == source_time
        assert frame.pts * frame.time_base == Fraction(mapping["preview_ms"], 1000)
        error = abs(frame.pts * frame.time_base - source_time)
        assert error <= Fraction(1, 2000)
        errors.append(error)
        gray = frame.reformat(format="gray")
        plane = bytes(gray.planes[0])
        visible = sum((plane[60 * gray.planes[0].line_size + 15 + bit * 20] > 128) << bit for bit in range(8))
        assert visible == index
    assert any(error > 0 for error in errors), "This fixture must exercise actual millisecond quantisation."


def test_preview_missing_decoder_is_explicit_and_does_not_disclose_native_error(
    tmp_path: Path, videos: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = videos["cfr_mp4"]
    metadata = media.inspect_source(source)
    identity = metadata.pop("_identity")

    def unavailable_decoder(*args, **kwargs):
        raise av.error.DecoderNotFoundError(1128613112, "Private source filename must not escape")

    monkeypatch.setattr(av, "open", unavailable_decoder)
    with pytest.raises(media.MediaError) as error:
        preview_worker.render({
            "source_path": str(source), "output_path": str(tmp_path / "unsupported.webm"), "source_pts": "0",
            "segment_id": str(uuid4()), "identity": identity, "metadata": metadata,
        })
    assert error.value.code == "unsupported_codec"
    assert "Private" not in str(error.value)
    assert not (tmp_path / "unsupported.webm").exists()


def test_actual_corrupt_source_fails_decoder_instead_of_producing_preview(tmp_path: Path, videos: dict[str, Path]) -> None:
    metadata = media.inspect_source(videos["cfr_mp4"])
    metadata.pop("_identity")
    source = tmp_path / "corrupt-original.mp4"
    source.write_bytes(b"Synthetic invalid MP4: no container or video packets.")
    # Exercise the decoder failure boundary directly, independently of the earlier source-identity gate.
    with pytest.raises(media.MediaError) as error:
        preview_worker.render({
            "source_path": str(source), "output_path": str(tmp_path / "corrupt.webm"), "source_pts": "0",
            "segment_id": str(uuid4()), "identity": media.identity_info(source), "metadata": metadata,
        })
    assert error.value.code == "decode_failed"
    assert not (tmp_path / "corrupt.webm").exists()


def test_decoded_unknown_final_duration_never_uses_nominal_fps(
    tmp_path: Path, videos: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    from types import SimpleNamespace

    source = videos["short_mp4"]
    metadata = media.inspect_source(source)
    identity = metadata.pop("_identity")
    decoded_frames = media.decoded_frames

    def unknown_last_duration(container, stream, cancelled=lambda: False):
        for frame in decoded_frames(container, stream, cancelled):
            if str(frame.pts) == metadata["last_pts"]:
                yield SimpleNamespace(pts=frame.pts, time_base=frame.time_base, width=frame.width,
                                      height=frame.height, duration=None, reformat=frame.reformat)
            else:
                yield frame

    monkeypatch.setattr(media, "decoded_frames", unknown_last_duration)
    with pytest.raises(media.MediaError) as error:
        preview_worker.render({
            "source_path": str(source), "output_path": str(tmp_path / "unknown.webm"), "source_pts": "0",
            "segment_id": str(uuid4()), "identity": identity, "metadata": metadata,
        })
    assert error.value.code == "unknown_timing"


def test_actual_encoded_output_exceeding_byte_limit_is_rejected(
    tmp_path: Path, videos: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = videos["cfr_mp4"]
    metadata = media.inspect_source(source)
    identity = metadata.pop("_identity")
    output = tmp_path / "over-byte-limit.webm"
    monkeypatch.setattr(preview_worker, "MAX_BYTES", 1)
    with pytest.raises(media.MediaError) as error:
        preview_worker.render({
            "source_path": str(source), "output_path": str(output), "source_pts": "0",
            "segment_id": str(uuid4()), "identity": identity, "metadata": metadata,
        })
    assert error.value.code == "preview_limit"
    assert output.stat().st_size > 1


@pytest.mark.parametrize("kind", ["memory", "cpu", "file"])
def test_linux_guards_actually_reject_resource_exhaustion_with_lower_inherited_caps(tmp_path: Path, kind: str) -> None:
    import subprocess
    import sys

    script = """
import errno, os, resource, sys
from backend.app.preview_worker import limits
kind = sys.argv[2]
resource_kind, amount = {"memory": (resource.RLIMIT_AS, 64 * 1024 ** 2),
                         "cpu": (resource.RLIMIT_CPU, 1), "file": (resource.RLIMIT_FSIZE, 1024)}[kind]
resource.setrlimit(resource_kind, (amount, amount))
limits(int(sys.argv[1]))
assert resource.getrlimit(resource_kind) == (amount, amount)
if kind == "memory":
    try:
        bytearray(128 * 1024 ** 2)
    except MemoryError:
        sys.exit(0)
    raise AssertionError("Memory allocation exceeded hard limit")
elif kind == "cpu":
    while True:
        pass
else:
    with open(sys.argv[3], "wb", buffering=0) as output:
        try:
            output.write(b"x" * 2048)
            output.write(b"x")
        except OSError as error:
            assert error.errno == errno.EFBIG
            sys.exit(0)
    raise AssertionError("File write exceeded hard limit")
"""
    output = tmp_path / "bounded-output"
    result = subprocess.run([sys.executable, "-c", script, str(os.getpid()), kind, str(output)],
                            capture_output=True, timeout=5, check=False)
    assert result.returncode == (-signal.SIGKILL if kind == "cpu" else 0), result.stderr.decode()
    if kind == "file":
        assert output.stat().st_size == 1024


def test_running_real_preview_blocks_import_then_releases_reservation(tmp_path: Path, videos: dict[str, Path]) -> None:
    from backend.app.imports import ImportErrorResponse, ImportJobs

    database, row = prepared(tmp_path / "data", videos["long_mp4"])
    activity = Lock()
    previews = preview.PreviewJobs(database, database.parent, activity)
    imports = ImportJobs(database, database.parent, activity)
    try:
        job = previews.start(row["id"], "0")
        pid = stopped_worker(previews, job)
        with pytest.raises(ImportErrorResponse) as error:
            imports.start(row["session_id"], [str(videos["short_mp4"])])
        assert error.value.code == "preview_busy"
        previews.close()
        assert not Path(f"/proc/{pid}").exists()
        assert list(previews.directory.iterdir()) == []
        imported = imports.start(row["session_id"], [str(videos["short_mp4"])])
        assert wait_job(imports.get, imported["id"])["state"] == "complete"
    finally:
        previews.close()
        imports.close()
