"""Real synthetic imports, explicit schema transition and atomic failure behavior."""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import sqlite3
from threading import Event, Lock
import time
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from backend.app import imports, media, store
from backend.app.main import Settings, create_app
from backend.tests.media_fixtures import generate_media

TOKEN = "synthetic-private-per-launch-token-long-enough"
HEADERS = {"X-Bat-Token": TOKEN}


@pytest.fixture(scope="module")
def videos(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    return generate_media(tmp_path_factory.mktemp("import-sources"))


def session(client: TestClient) -> str:
    response = client.post("/api/sessions", headers=HEADERS,
                           json={"display_name": "Synthetic camera session", "camera_ref": "Test camera"})
    assert response.status_code == 201
    return response.json()["id"]


def upgraded(client: TestClient) -> None:
    response = client.post("/api/media/upgrade", headers=HEADERS)
    assert response.status_code == 200 and response.json() == {"schema_version": 2}


def inventory(client: TestClient, session_id: str) -> dict:
    response = client.get(f"/api/sessions/{session_id}/media", headers=HEADERS)
    assert response.status_code == 200
    return response.json()


def import_files(client: TestClient, session_id: str, paths: list[Path]) -> dict:
    response = client.post("/api/media/import", headers=HEADERS,
                           json={"session_id": session_id, "paths": [str(path) for path in paths]})
    assert response.status_code == 202, response.text
    return finish(client, response.json()["id"])


def finish(client: TestClient, job_id: str) -> dict:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = client.get(f"/api/media/import/{job_id}", headers=HEADERS)
        assert response.status_code == 200
        job = response.json()
        if job["state"] != "running":
            return job
        time.sleep(0.01)
    pytest.fail("Synthetic import did not finish within ten seconds")


def order_payload(ids: list[str], anchor: dict | None = None) -> dict:
    return {"segment_ids": ids, "continuity": [
        {"segment_id": segment_id, "status": "unknown", "provenance": None} for segment_id in ids
    ], "clock_anchor": anchor}


def test_explicit_upgrade_preserves_sessions_and_existing_review_data(tmp_path: Path) -> None:
    database = tmp_path / "existing.sqlite3"
    store.initialise(database)
    existing = store.create_session(database, "Old synthetic session", "Synthetic camera")
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE review_action (id TEXT PRIMARY KEY, note TEXT)")
        connection.execute("INSERT INTO review_action VALUES ('original', 'Retain this review')")
    store.initialise(database)
    assert store.schema_version(database) == 1
    store.upgrade_media(database)
    store.initialise(database)
    assert store.schema_version(database) == 2
    assert store.list_sessions(database) == [existing]
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT * FROM review_action").fetchall() == [("original", "Retain this review")]
    store.upgrade_media(database)
    assert store.schema_version(database) == 2


@pytest.mark.parametrize("version", [0, 99])
def test_upgrade_refuses_unknown_or_unversioned_database_unchanged(tmp_path: Path, version: int) -> None:
    database = tmp_path / "existing.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE legacy (id TEXT)")
        connection.execute(f"PRAGMA user_version={version}")
    original = database.read_bytes()
    with pytest.raises(store.DatabaseSchemaError):
        store.upgrade_media(database)
    assert database.read_bytes() == original


def test_upgrade_rolls_back_every_ddl_statement_when_a_later_statement_fails(tmp_path: Path) -> None:
    database = tmp_path / "existing.sqlite3"
    store.initialise(database)
    record = store.create_session(database, "Unchanged session", "Test camera")
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE session_media (existing_review TEXT)")
        connection.execute("INSERT INTO session_media VALUES ('preserve')")
    with pytest.raises(sqlite3.DatabaseError):
        store.upgrade_media(database)
    assert store.schema_version(database) == 1 and store.list_sessions(database) == [record]
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT name FROM sqlite_master WHERE name='segment'").fetchall() == []
        assert connection.execute("SELECT * FROM session_media").fetchall() == [("preserve",)]


def test_real_import_reorder_and_anchor_survive_restart_without_invented_time(tmp_path: Path, videos: dict[str, Path]) -> None:
    settings = Settings(tmp_path / "app-data", TOKEN)
    with TestClient(create_app(settings)) as client:
        session_id = session(client)
        assert inventory(client, session_id) == {"session_id": session_id, "schema_version": 1,
                                                  "segments": [], "clock_anchor": None, "active_import": None}
        refused = client.post("/api/media/import", headers=HEADERS,
                              json={"session_id": session_id, "paths": [str(videos["cfr_mp4"])]})
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "schema_upgrade_required"
        upgraded(client)
        job = import_files(client, session_id, [videos["cfr_mp4"], videos["nonzero_mts"], videos["irregular_mp4"]])
        assert job["state"] == "complete" and job["files_done"] == job["files_total"] == 3
        before = inventory(client, session_id)
        assert before["clock_anchor"] is None
        assert [item["metadata"]["filename"] for item in before["segments"]] == ["cfr.mp4", "nonzero.mts", "irregular.mp4"]
        assert all(item["source_state"] == "ready" and item["continuity"] == "unknown" for item in before["segments"])
        assert str(videos["cfr_mp4"].parent) not in json.dumps(before)
        assert "_identity" not in json.dumps(before) and "source_path" not in json.dumps(before)
        mts = before["segments"][1]["metadata"]
        assert mts["first_pts"] == "129600" and mts["first_time"] == {"num": "36", "den": "25"}
        reversed_ids = [item["id"] for item in reversed(before["segments"])]
        saved = client.put(f"/api/sessions/{session_id}/media", headers=HEADERS, json=order_payload(reversed_ids))
        assert saved.status_code == 200
        assert [item["id"] for item in saved.json()["segments"]] == reversed_ids
        assert saved.json()["clock_anchor"] is None
        for old, new in zip(reversed(before["segments"]), saved.json()["segments"]):
            assert old["metadata"] == new["metadata"]

    with TestClient(create_app(settings)) as reopened:
        after = inventory(reopened, session_id)
        assert [item["id"] for item in after["segments"]] == reversed_ids
        assert after["clock_anchor"] is None
        anchor = {"segment_id": after["segments"][1]["id"], "utc": "2026-10-15T20:00:00+01:00",
                  "provenance": "Synthetic manually recorded clock observation"}
        response = reopened.put(f"/api/sessions/{session_id}/media", headers=HEADERS,
                                json=order_payload(reversed_ids, anchor))
        assert response.status_code == 200
        assert response.json()["clock_anchor"] == {**anchor, "utc": "2026-10-15T19:00:00Z",
            "source_pts": "129600", "time_base": {"num": "1", "den": "90000"},
            "source_time": {"num": "36", "den": "25"}}


def test_corrupt_batch_and_duplicate_source_never_partially_commit(tmp_path: Path, videos: dict[str, Path]) -> None:
    corrupt = tmp_path / "corrupt.mp4"
    corrupt.write_bytes(b"not a valid video")
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id = session(client)
        upgraded(client)
        result = import_files(client, session_id, [videos["cfr_mp4"], corrupt])
        assert result["state"] == "failed" and result["error"]["code"] == "unreadable_metadata"
        assert inventory(client, session_id)["segments"] == []
        copy = tmp_path / "identical.mp4"
        shutil.copyfile(videos["cfr_mp4"], copy)
        result = import_files(client, session_id, [videos["cfr_mp4"], copy])
        assert result["state"] == "failed" and result["error"]["code"] == "duplicate_source"
        assert inventory(client, session_id)["segments"] == []
        assert import_files(client, session_id, [videos["cfr_mp4"]])["state"] == "complete"
        assert import_files(client, session_id, [copy])["error"]["code"] == "duplicate_source"
        assert len(inventory(client, session_id)["segments"]) == 1


def test_missing_and_changed_originals_are_visible_without_replacing_metadata(tmp_path: Path, videos: dict[str, Path]) -> None:
    source = tmp_path / "original.mp4"
    shutil.copyfile(videos["cfr_mp4"], source)
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id = session(client)
        upgraded(client)
        assert import_files(client, session_id, [source])["state"] == "complete"
        original = inventory(client, session_id)["segments"][0]
        with source.open("ab") as changed:
            changed.write(b"changed original")
        mutated = inventory(client, session_id)["segments"][0]
        assert mutated["source_state"] == "changed_source" and mutated["metadata"] == original["metadata"]
        source.unlink()
        assert inventory(client, session_id)["segments"][0]["source_state"] == "missing_source"


def blocking_inspection(monkeypatch: pytest.MonkeyPatch) -> Event:
    entered = Event()
    inspect = media.inspect_source

    def blocked(path: Path, progress, cancelled):
        def pause(phase: str, amount: int) -> None:
            progress(phase, amount)
            if phase == "decoding":
                entered.set()
                deadline = time.monotonic() + 5
                while not cancelled() and time.monotonic() < deadline:
                    time.sleep(0.005)
        return inspect(path, pause, cancelled)

    monkeypatch.setattr(media, "inspect_source", blocked)
    return entered


def test_cancel_real_decoding_discards_all_sources_and_allows_next_job(tmp_path: Path, videos: dict[str, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    entered = blocking_inspection(monkeypatch)
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id = session(client)
        upgraded(client)
        response = client.post("/api/media/import", headers=HEADERS,
                               json={"session_id": session_id, "paths": [str(videos["cfr_mp4"])]})
        assert response.status_code == 202
        assert entered.wait(timeout=2)
        job_id = response.json()["id"]
        active = inventory(client, session_id)["active_import"]
        assert active is not None and active["id"] == job_id and active["state"] == "running"
        second = client.post("/api/media/import", headers=HEADERS,
                             json={"session_id": session_id, "paths": [str(videos["short_mp4"])]})
        assert second.status_code == 409 and second.json()["detail"]["code"] == "import_busy"
        assert client.post(f"/api/media/import/{job_id}/cancel", headers=HEADERS).status_code == 200
        assert finish(client, job_id)["state"] == "cancelled"
        assert inventory(client, session_id)["segments"] == []
        assert inventory(client, session_id)["active_import"] is None
        monkeypatch.undo()
        assert import_files(client, session_id, [videos["short_mp4"]])["state"] == "complete"


def test_shutdown_cancels_and_joins_the_inspection_worker(tmp_path: Path, videos: dict[str, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    entered = blocking_inspection(monkeypatch)
    database = tmp_path / "app-data" / "bat_innovation.sqlite3"
    store.initialise(database)
    store.upgrade_media(database)
    session_id = store.create_session(database, "Synthetic shutdown", "Test camera")["id"]
    jobs = imports.ImportJobs(database, database.parent)
    job = jobs.start(session_id, [str(videos["cfr_mp4"])])
    assert entered.wait(timeout=2)
    jobs.close()
    assert jobs.get(job["id"])["state"] == "cancelled"
    assert jobs._thread is not None and not jobs._thread.is_alive()
    assert store.private_segments(database, session_id) == []


def test_timeline_validation_rejects_foreign_ids_duplicate_ids_and_invented_clock(tmp_path: Path, videos: dict[str, Path]) -> None:
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        session_id = session(client)
        upgraded(client)
        assert import_files(client, session_id, [videos["cfr_mp4"], videos["nonzero_mts"]])["state"] == "complete"
        original = inventory(client, session_id)
        ids = [item["id"] for item in original["segments"]]
        route = f"/api/sessions/{session_id}/media"
        assert client.put(route, headers=HEADERS, json=order_payload([ids[0], ids[0]])).status_code == 400
        assert client.put(route, headers=HEADERS, json=order_payload([ids[0], str(uuid4())])).status_code == 400
        invalid = order_payload(ids)
        invalid["continuity"][0].update(status="known_contiguous", provenance="Synthetic observation")
        assert client.put(route, headers=HEADERS, json=invalid).status_code == 400
        invalid["continuity"][0].update(status="unknown", provenance=None)
        invalid["continuity"][1]["status"] = "known_gap"
        assert client.put(route, headers=HEADERS, json=invalid).status_code == 422
        invalid = order_payload(ids, {"segment_id": ids[0], "utc": "2026-10-15T20:00:00", "provenance": "No timezone"})
        assert client.put(route, headers=HEADERS, json=invalid).status_code == 422
        invalid["clock_anchor"]["utc"] = 1792094400
        assert client.put(route, headers=HEADERS, json=invalid).status_code == 422
        for numeric_string in ("0", "123"):
            invalid["clock_anchor"]["utc"] = numeric_string
            assert client.put(route, headers=HEADERS, json=invalid).status_code == 422
        assert inventory(client, session_id) == original
        valid = order_payload(ids)
        valid["continuity"][1].update(status="known_gap", provenance="Synthetic confirmed recording pause")
        assert client.put(route, headers=HEADERS, json=valid).json()["segments"][1]["continuity"] == "known_gap"


def test_authentication_path_injection_and_sensitive_validation_errors(tmp_path: Path, videos: dict[str, Path]) -> None:
    data_dir = tmp_path / "app-data"
    with TestClient(create_app(Settings(data_dir, TOKEN))) as client:
        session_id = session(client)
        for method, route in [("post", "/api/media/upgrade"), ("get", f"/api/sessions/{session_id}/media"),
                              ("post", "/api/media/import"), ("get", f"/api/media/import/{uuid4()}"),
                              ("post", f"/api/media/import/{uuid4()}/cancel"), ("put", f"/api/sessions/{session_id}/media")]:
            assert getattr(client, method)(route, headers={"X-Bat-Token": "wrong"}, **({} if method == "get" else {"json": {}})).status_code == 401
        upgraded(client)
        private = "/private/confidential/source.mp4"
        for route, payload in [("/api/sessions", {"display_name": "Synthetic", "camera_ref": "Camera", "path": private}),
                               ("/api/media/upgrade", {"path": private}),
                               ("/api/media/import", {"session_id": session_id, "paths": [str(videos["cfr_mp4"])], "unexpected_path": private})]:
            response = client.post(route, headers=HEADERS, json=payload)
            assert response.status_code == 422 and private not in response.text
        response = client.put(f"/api/sessions/{session_id}/media", headers=HEADERS,
                              json={**order_payload([]), "paths": [private]})
        assert response.status_code == 422 and private not in response.text
        for path in ["relative.mp4", "https://example.invalid/source.mp4", str(data_dir / "internal.mp4"), str(Path(__file__).resolve())]:
            response = client.post("/api/media/import", headers=HEADERS, json={"session_id": session_id, "paths": [path]})
            assert response.status_code == 400 and path not in response.text
        response = client.get(f"/api/sessions/{uuid4()}/media", headers=HEADERS)
        assert response.status_code == 404 and str(data_dir) not in response.text


def test_same_original_cannot_be_attributed_to_two_camera_sessions(
    tmp_path: Path, videos: dict[str, Path],
) -> None:
    copy = tmp_path / "same-recording.mp4"
    shutil.copyfile(videos["cfr_mp4"], copy)
    with TestClient(create_app(Settings(tmp_path / "app-data", TOKEN))) as client:
        first = session(client)
        second = session(client)
        upgraded(client)
        assert import_files(client, first, [videos["cfr_mp4"]])["state"] == "complete"

        for source in (videos["cfr_mp4"], copy):
            attempted = import_files(client, second, [source])
            assert attempted["state"] == "failed"
            assert attempted["error"]["code"] == "duplicate_source"
            assert inventory(client, second)["segments"] == []

        # Another recording with distinct content is a legitimate second camera source.
        assert import_files(client, second, [videos["short_mp4"]])["state"] == "complete"
        assert len(inventory(client, first)["segments"]) == 1
        assert len(inventory(client, second)["segments"]) == 1
        with sqlite3.connect(tmp_path / "app-data" / "bat_innovation.sqlite3") as connection:
            assert connection.execute("SELECT COUNT(DISTINCT session_id) FROM segment").fetchone()[0] == 2
            with pytest.raises(sqlite3.IntegrityError):
                connection.execute(
                    "UPDATE segment SET sha256 = (SELECT sha256 FROM segment WHERE session_id=?) "
                    "WHERE session_id=?", (first, second),
                )


def test_unreadable_original_is_not_reported_as_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = tmp_path / "existing.mp4"
    original.write_bytes(b"synthetic content")
    identity = media.identity_info(original)
    row = {"source_path": str(original), "identity_json": json.dumps(identity)}

    def inaccessible(_path: Path) -> dict:
        raise media.MediaError("unreadable_metadata", "Access denied")

    monkeypatch.setattr(media, "identity_info", inaccessible)
    assert imports.source_state(row) == "unreadable_source"
    monkeypatch.undo()

    actual_open = Path.open

    def forbidden_open(path: Path, *args, **kwargs):
        if path == original:
            raise PermissionError("Synthetic access denied")
        return actual_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", forbidden_open)
    assert imports.source_state(row) == "unreadable_source"
    # Permission changes can also change ctime; unreadability must remain actionable.
    row["identity_json"] = json.dumps({**identity, "ctime_ns": identity["ctime_ns"] - 1})
    assert imports.source_state(row) == "unreadable_source"
    monkeypatch.undo()
    original.unlink()
    assert imports.source_state(row) == "missing_source"


@pytest.mark.parametrize("outcome", ["complete", "cancelled", "failed"])
def test_terminal_import_status_releases_processing_reservation_atomically(
    tmp_path: Path, videos: dict[str, Path], monkeypatch: pytest.MonkeyPatch, outcome: str,
) -> None:
    database = tmp_path / "data" / "bat_innovation.sqlite3"
    store.initialise(database)
    store.upgrade_media(database)
    session_id = store.create_session(database, "Synthetic reservation", "Test camera")["id"]
    released_under_status_lock: list[bool] = []

    class Reservation:
        def __init__(self):
            self.lock = Lock()

        def acquire(self, blocking=True):
            return self.lock.acquire(blocking=blocking)

        def release(self):
            released_under_status_lock.append(jobs._lock.locked())
            self.lock.release()

    reservation = Reservation()
    jobs = imports.ImportJobs(database, database.parent, reservation)
    if outcome != "complete":
        def unsuccessful(*args, **kwargs):
            raise media.MediaError("cancelled" if outcome == "cancelled" else "decode_failed", "Synthetic failure")
        monkeypatch.setattr(media, "inspect_source", unsuccessful)
    try:
        job = jobs.start(session_id, [str(videos["short_mp4"])])
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and jobs.get(job["id"])["state"] == "running":
            time.sleep(0.005)
        assert jobs.get(job["id"])["state"] == outcome
        assert released_under_status_lock == [True]
        assert reservation.acquire(blocking=False)
        reservation.lock.release()
    finally:
        jobs.close()


def test_import_thread_start_failure_leaves_no_running_job_or_reservation(
    tmp_path: Path, videos: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "data" / "bat_innovation.sqlite3"
    store.initialise(database)
    store.upgrade_media(database)
    session_id = store.create_session(database, "Synthetic startup failure", "Test camera")["id"]
    reservation = Lock()
    jobs = imports.ImportJobs(database, database.parent, reservation)

    def cannot_start(_thread):
        raise RuntimeError("Synthetic thread startup failure with private details")

    monkeypatch.setattr(imports.Thread, "start", cannot_start)
    with pytest.raises(imports.ImportErrorResponse) as error:
        jobs.start(session_id, [str(videos["short_mp4"])])
    assert error.value.code == "import_failed"
    assert "private details" not in error.value.message
    assert jobs.active(session_id) is None and jobs._jobs == {} and jobs._thread is None
    assert reservation.acquire(blocking=False)
    reservation.release()
    jobs.close()


@pytest.mark.parametrize('platform_name', ['win32', 'darwin'])
def test_import_limits_guard_precedes_sources_workers_and_reservation(tmp_path, monkeypatch, platform_name):
    from types import SimpleNamespace
    from unittest.mock import Mock

    database = tmp_path / 'data' / 'bat_innovation.sqlite3'
    store.initialise(database)
    store.upgrade_media(database)
    session_id = store.create_session(database, 'Synthetic blocked import', 'Synthetic camera')['id']
    original = database.read_bytes()
    reservation = Lock()
    jobs = imports.ImportJobs(database, database.parent, reservation)
    # Replace only this module's platform view, never the host Python platform.
    monkeypatch.setattr(imports, 'sys', SimpleNamespace(platform=platform_name))
    forbidden = Mock(side_effect=AssertionError('Import must reject before source access or worker creation'))
    monkeypatch.setattr(imports, 'selected_sources', forbidden)
    monkeypatch.setattr(imports, 'Thread', forbidden)
    monkeypatch.setattr(imports, 'Event', forbidden)
    monkeypatch.setattr(media, 'identity_info', forbidden)
    monkeypatch.setattr(media, 'inspect_source', forbidden)
    monkeypatch.setattr(store, 'commit_segments', forbidden)
    try:
        with pytest.raises(imports.ImportErrorResponse) as error:
            jobs.start(session_id, [r'C:\synthetic-private\nonexistent.mp4'])
        assert error.value.code == 'import_limits_unavailable' and error.value.status == 409
        assert 'synthetic-private' not in error.value.message
        forbidden.assert_not_called()
        assert jobs._jobs == {} and jobs._cancel == {} and jobs._thread is None
        assert jobs.active(session_id) is None
        assert reservation.acquire(blocking=False)
        reservation.release()
        assert database.read_bytes() == original
    finally:
        jobs.close()


@pytest.mark.parametrize('existing_media', [False, True])
def test_windows_authenticated_import_api_is_fail_closed_and_preserves_records(
    tmp_path, videos, monkeypatch, existing_media,
):
    from types import SimpleNamespace
    from unittest.mock import Mock

    settings = Settings(tmp_path / 'data', TOKEN)
    database = settings.data_dir / 'bat_innovation.sqlite3'
    with TestClient(create_app(settings)) as client:
        session_id = session(client)
        upgraded(client)
        if existing_media:
            assert import_files(client, session_id, [videos['cfr_mp4']])['state'] == 'complete'
        before = inventory(client, session_id)
        original_database = database.read_bytes()
        with monkeypatch.context() as patch:
            patch.setattr(imports, 'sys', SimpleNamespace(platform='win32'))
            forbidden = Mock(side_effect=AssertionError('Windows import reached source or worker code'))
            patch.setattr(imports, 'selected_sources', forbidden)
            patch.setattr(imports, 'Thread', forbidden)
            patch.setattr(imports, 'Event', forbidden)
            patch.setattr(media, 'identity_info', forbidden)
            patch.setattr(media, 'inspect_source', forbidden)
            patch.setattr(store, 'commit_segments', forbidden)
            for paths in ([str(videos['cfr_mp4'])], [str(tmp_path / 'missing.mp4')], [r'C:\synthetic-private\missing.MTS']):
                payload = {'session_id': session_id, 'paths': paths}
                assert client.post('/api/media/import', json=payload).status_code == 401
                response = client.post('/api/media/import', headers=HEADERS, json=payload)
                assert response.status_code == 409, response.text
                assert response.json()['detail'] == {
                    'code': 'import_limits_unavailable',
                    'message': 'Media import process limits are unavailable on this platform. Only Linux development imports are verified.',
                }
                assert str(tmp_path) not in response.text and 'synthetic-private' not in response.text
            forbidden.assert_not_called()
            assert database.read_bytes() == original_database
        assert inventory(client, session_id) == before
        # Rejection cannot poison the shared reservation or the existing Linux path.
        assert import_files(client, session_id, [videos['short_mp4']])['state'] == 'complete'
        assert len(inventory(client, session_id)['segments']) == int(existing_media) + 1
