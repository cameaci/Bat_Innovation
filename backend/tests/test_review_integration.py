"""Real local review actions: original PTS, preview receipts and durable audit."""

from __future__ import annotations

from fractions import Fraction
import json
from pathlib import Path
import sqlite3
import time
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from backend.app import media, store, summary_store
from backend.app.main import Settings, create_app
from backend.tests.media_fixtures import generate_media
from backend.tests.summary_fixtures import generate_summary_media

TOKEN = "synthetic-review-integration-launch-token-long-enough"
HEADERS = {"X-Bat-Token": TOKEN}
ACTOR = "Synthetic reviewer"


@pytest.fixture(scope="module")
def originals(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    directory = tmp_path_factory.mktemp("review-originals")
    return {**generate_summary_media(directory / "summary"), **generate_media(directory / "timing")}


def prepare(directory: Path, paths: list[Path]) -> tuple[Path, str]:
    database = directory / "bat_innovation.sqlite3"
    store.initialise(database)
    store.upgrade_media(database)
    session_id = store.create_session(database, "Synthetic review", "Synthetic camera")["id"]
    store.commit_segments(database, session_id, [(path, media.inspect_source(path)) for path in paths])
    summary_store.upgrade(database)
    return database, session_id


def run_summary(client: TestClient, session_id: str) -> dict:
    response = client.post("/api/summaries", headers=HEADERS,
                           json={"session_id": session_id, "window_seconds": 30})
    assert response.status_code == 202, response.text
    run_id = response.json()["id"]
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        response = client.get(f"/api/summaries/{run_id}", headers=HEADERS)
        assert response.status_code == 200, response.text
        result = response.json()
        if result["state"] not in {"queued", "running"}:
            return result
        time.sleep(0.01)
    pytest.fail("Tiny real summary job did not finish")


def upgrade(client: TestClient) -> None:
    response = client.post("/api/reviews/upgrade", headers=HEADERS, json={})
    assert response.status_code == 200, response.text
    assert response.json() == {"schema_version": 4}


def current(client: TestClient, window_id: str) -> dict:
    response = client.get(f"/api/summary-windows/{window_id}/review", headers=HEADERS)
    assert response.status_code == 200, response.text
    return response.json()


def history(client: TestClient, window_id: str, after_revision: int = 0) -> dict:
    response = client.get(f"/api/summary-windows/{window_id}/review-history",
                          headers=HEADERS, params={"after_revision": after_revision})
    assert response.status_code == 200, response.text
    return response.json()


def action(client: TestClient, window_id: str, revision: int, kind: str, **fields) -> dict:
    response = client.post(f"/api/summary-windows/{window_id}/review-actions", headers=HEADERS,
                           json={"actor": ACTOR, "expected_revision": revision, "action": kind, **fields})
    assert response.status_code == 200, response.text
    return response.json()


def preview_receipt(client: TestClient, window: dict, pts: str | None = None) -> dict:
    response = client.post("/api/media/preview", headers=HEADERS,
                           json={"segment_id": window["segment_id"], "source_pts": pts or window["preview_pts"]})
    assert response.status_code == 202, response.text
    job_id = response.json()["id"]
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        response = client.get(f"/api/media/preview/{job_id}", headers=HEADERS)
        assert response.status_code == 200, response.text
        job = response.json()
        if job["state"] != "running":
            assert job["state"] == "ready", job
            return job
        time.sleep(0.01)
    pytest.fail("Tiny real preview job did not finish")


def observation(window: dict, **changes) -> dict:
    start = int(window["preview_pts"])
    return {"segment_id": window["segment_id"], "start_pts": str(start), "end_pts": str(start + 1),
            "category": "uncertain", "activity": None, "count": None, "uncertain": True,
            "notes": "Synthetic provisional observation", **changes}


def event_count(database: Path) -> int:
    with sqlite3.connect(database) as connection:
        return connection.execute("SELECT COUNT(*) FROM review_event").fetchone()[0]


def test_quiet_windows_stay_unreviewed_until_explicit_receipted_decisions_and_restart(
    tmp_path: Path, originals: dict[str, Path],
) -> None:
    source = originals["quiet_65"]
    checksum = media.file_sha256(source)
    database, session_id = prepare(tmp_path / "data", [source])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        run = run_summary(client, session_id)
        upgrade(client)
        rows = run["windows"]
        assert len(rows) == 3 and all(row["stats"]["motion_pixels"] == 0 for row in rows)
        for _ in range(2):
            for row in rows:
                projection = current(client, row["id"])
                assert projection["decision"] == projection["effective_decision"] == "unreviewed"
                assert projection["revision"] == 0 and projection["observations"] == []
                assert history(client, row["id"])["events"] == []
            refreshed = client.get(f"/api/summaries/{run['id']}", headers=HEADERS).json()
            assert refreshed["review_progress"]["total"] == refreshed["review_progress"]["unreviewed"] == 3
            assert refreshed["review_progress"]["reviewed"] == 0
        assert event_count(database) == 0, "Reading, polling and navigation cannot create audit actions"
        refused = client.post(f"/api/summary-windows/{rows[0]['id']}/review-actions", headers=HEADERS,
                              json={"actor": ACTOR, "expected_revision": 0, "action": "set_decision",
                                    "decision": "reviewed_no_discernible_event", "preview_id": None})
        assert refused.status_code == 409, refused.text
        receipt = preview_receipt(client, rows[0])
        saved = action(client, rows[0]["id"], 0, "set_decision",
                       decision="reviewed_no_discernible_event", preview_id=receipt["id"])
        assert saved["decision"] == saved["effective_decision"] == "reviewed_no_discernible_event"
        assert saved["revision"] == 1 and saved["observations"] == []
        events = history(client, rows[0]["id"])["events"]
        assert len(events) == 1 and events[0]["actor"] == ACTOR
        assert receipt["id"] in json.dumps(events)
        progress = client.get(f"/api/summaries/{run['id']}", headers=HEADERS).json()["review_progress"]
        assert (progress["reviewed"], progress["total"], progress["unreviewed"]) == (1, 3, 2)
    # Preview clips are ephemeral; persisted verification of unchanged originals is not.
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        persisted = current(client, rows[0]["id"])
        assert persisted["revision"] == 1
        assert persisted["effective_decision"] == "reviewed_no_discernible_event"
        assert history(client, rows[0]["id"])["events"] == events
        second_run = run_summary(client, session_id)
        assert second_run["id"] != run["id"]
        assert second_run["review_progress"]["reviewed"] == 0
        assert all(current(client, row["id"])["revision"] == 0 for row in second_run["windows"])
        assert event_count(database) == 1
    assert media.file_sha256(source) == checksum


def test_zero_one_many_observations_edit_delete_uncertainty_and_stale_revision_are_audited(
    tmp_path: Path, originals: dict[str, Path],
) -> None:
    database, session_id = prepare(tmp_path / "data", [originals["quiet_9"]])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        upgrade(client)
        row = run_summary(client, session_id)["windows"][0]
        window_id = row["id"]
        first = action(client, window_id, 0, "add_observation", observation=observation(row))
        assert first["decision"] == "unreviewed" and len(first["observations"]) == 1
        first_id = first["observations"][0]["id"]
        assert first["observations"][0]["count"] is None
        assert first["observations"][0]["uncertain"] is True
        second = action(client, window_id, 1, "add_observation",
                        observation=observation(row, category="insect", activity="passing", count=0, uncertain=False))
        assert len(second["observations"]) == 2
        second_id = next(item["id"] for item in second["observations"] if item["id"] != first_id)
        receipt = preview_receipt(client, row)
        reviewed = action(client, window_id, 2, "set_decision", decision="reviewed_with_observations",
                          preview_id=receipt["id"])
        assert reviewed["effective_decision"] == "reviewed_with_observations"
        edited = action(client, window_id, 3, "update_observation", observation_id=first_id,
                        observation=observation(row, category="bat", count=None, notes="Still provisional"))
        assert edited["decision"] == "unreviewed", "Changing evidence requires another explicit review"
        assert len(edited["observations"]) == 2
        stale = client.post(f"/api/summary-windows/{window_id}/review-actions", headers=HEADERS,
                            json={"actor": "Another synthetic reviewer", "expected_revision": 3,
                                  "action": "delete_observation", "observation_id": second_id})
        assert stale.status_code == 409 and stale.json()["detail"]["code"] == "review_conflict"
        assert current(client, window_id) == edited
        assert len(history(client, window_id)["events"]) == 4
        removed = action(client, window_id, 4, "delete_observation", observation_id=first_id)
        assert [item["id"] for item in removed["observations"]] == [second_id]
        removed = action(client, window_id, 5, "delete_observation", observation_id=second_id)
        assert removed["observations"] == [] and removed["decision"] == "unreviewed"
        unable = action(client, window_id, 6, "unable_to_assess", note="Synthetic glare prevents assessment")
        assert unable["unable_note"] == "Synthetic glare prevents assessment"
        assert unable["effective_decision"] == "unreviewed"
        events = history(client, window_id)["events"]
        assert [event["revision"] for event in events] == list(range(1, 8))
        assert [event["action"] for event in events] == ["add_observation", "add_observation", "set_decision",
                                                         "update_observation", "delete_observation",
                                                         "delete_observation", "unable_to_assess"]
        assert all(event["actor"] == ACTOR and event["window_id"] == window_id for event in events)
        with sqlite3.connect(database) as connection:
            for statement in ("UPDATE review_event SET actor='rewritten'", "DELETE FROM review_event"):
                with pytest.raises(sqlite3.DatabaseError):
                    connection.execute(statement)
                connection.rollback()
        assert history(client, window_id)["events"] == events
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        assert current(client, window_id)["observations"] == []
        assert current(client, window_id)["unable_note"] == unable["unable_note"]
        assert history(client, window_id)["events"] == events


@pytest.mark.parametrize("name", ["quiet_65", "nonzero_mts", "irregular_mp4"])
def test_observation_ticks_are_exact_same_segment_and_inside_half_open_window(
    tmp_path: Path, originals: dict[str, Path], name: str,
) -> None:
    database, session_id = prepare(tmp_path / "data", [originals[name]])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        upgrade(client)
        run = run_summary(client, session_id)
        row = run["windows"][0]
        interval = row["interval"]
        start = Fraction(int(interval["start_pts"]["num"]), int(interval["start_pts"]["den"]))
        end = Fraction(int(interval["end_pts"]["num"]), int(interval["end_pts"]["den"]))
        assert start.denominator == end.denominator == 1
        exact = observation(row, start_pts=str(start.numerator), end_pts=str(end.numerator))
        saved = action(client, row["id"], 0, "add_observation", observation=exact)
        assert saved["observations"][0]["start_pts"] == str(start.numerator)
        assert saved["observations"][0]["end_pts"] == str(end.numerator)
        for invalid in ({"start_pts": str(end.numerator), "end_pts": str(end.numerator + 1)},
                        {"start_pts": str(start.numerator - 1)}, {"end_pts": str(end.numerator + 1)},
                        {"start_pts": "1.5"}, {"start_pts": "9223372036854775808"},
                        {"segment_id": str(uuid4())}, {"count": True}):
            response = client.post(f"/api/summary-windows/{row['id']}/review-actions", headers=HEADERS,
                                   json={"actor": ACTOR, "expected_revision": 1, "action": "add_observation",
                                         "observation": {**exact, **invalid}})
            assert response.status_code == 422, (invalid, response.text)
        assert current(client, row["id"])["revision"] == 1
        assert event_count(database) == 1


def test_preview_receipt_cannot_verify_another_window_or_missing_and_unknown_coverage(
    tmp_path: Path, originals: dict[str, Path],
) -> None:
    database, session_id = prepare(tmp_path / "data", [originals["empty_middle"]])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        upgrade(client)
        run = run_summary(client, session_id)
        assert len(run["windows"]) == 3 and run["windows"][1]["status"] == "incomplete"
        first, middle, final = run["windows"]
        receipt = preview_receipt(client, first)
        for row in (middle, final):
            response = client.post(f"/api/summary-windows/{row['id']}/review-actions", headers=HEADERS,
                                   json={"actor": ACTOR, "expected_revision": 0, "action": "set_decision",
                                         "decision": "reviewed_no_discernible_event", "preview_id": receipt["id"]})
            assert response.status_code == 409, response.text
            assert current(client, row["id"])["effective_decision"] == "unreviewed"
        action(client, middle["id"], 0, "unable_to_assess", note="No decoded imagery in this interval")
        progress = client.get(f"/api/summaries/{run['id']}", headers=HEADERS).json()["review_progress"]
        assert progress["total"] == progress["unreviewed"] == 3 and progress["reviewed"] == 0
        assert progress["incomplete"] >= 1


@pytest.mark.parametrize("change", ["missing_source", "changed_source", "missing_image", "corrupt_image"])
def test_unavailable_evidence_reverts_effective_progress_without_rewriting_history(
    tmp_path: Path, originals: dict[str, Path], change: str,
) -> None:
    source = tmp_path / "synthetic-original.mp4"
    source.write_bytes(originals["quiet_9"].read_bytes())
    database, session_id = prepare(tmp_path / "data", [source])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        upgrade(client)
        run = run_summary(client, session_id)
        row = run["windows"][0]
        receipt = preview_receipt(client, row)
        action(client, row["id"], 0, "set_decision", decision="reviewed_no_discernible_event", preview_id=receipt["id"])
        before = history(client, row["id"])["events"]
        if change == "missing_source":
            source.unlink()
        elif change == "changed_source":
            with source.open("ab") as output:
                output.write(b"Synthetic changed original")
        else:
            image = Path(summary_store.private_window(database, row["id"])["image_path"])
            image.unlink() if change == "missing_image" else image.write_bytes(b"Synthetic corrupt derived image")
        projection = current(client, row["id"])
        assert projection["decision"] == "reviewed_no_discernible_event"
        assert projection["effective_decision"] == "unreviewed" and projection["needs_reverification"]
        assert projection["verification_warning"]
        assert projection["revision"] == 1
        assert history(client, row["id"])["events"] == before
        progress = client.get(f"/api/summaries/{run['id']}", headers=HEADERS).json()["review_progress"]
        assert progress["total"] == progress["unreviewed"] == progress["needs_reverification"] == 1
        assert progress["reviewed"] == 0
        assert str(tmp_path) not in json.dumps(projection)
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        assert current(client, row["id"])["effective_decision"] == "unreviewed"
        assert history(client, row["id"])["events"] == before


def test_unknown_final_end_is_not_invented_for_annotations_or_review(
    tmp_path: Path, originals: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_decoder = media.decoded_frames

    def absent_duration(container, stream, cancelled=lambda: False):
        for frame in original_decoder(container, stream, cancelled):
            yield SimpleNamespace(pts=frame.pts, time_base=frame.time_base, width=frame.width,
                                  height=frame.height, rotation=frame.rotation,
                                  interlaced_frame=frame.interlaced_frame, duration=None)

    # Only withhold the unavailable metadata field; no successful processing is faked.
    with monkeypatch.context() as patch:
        patch.setattr(media, "decoded_frames", absent_duration)
        database, session_id = prepare(tmp_path / "data", [originals["single"]])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        upgrade(client)
        row = run_summary(client, session_id)["windows"][0]
        assert row["interval"]["end_pts"] is None
        assert current(client, row["id"])["can_verify"] is False
        response = client.post(f"/api/summary-windows/{row['id']}/review-actions", headers=HEADERS,
                               json={"actor": ACTOR, "expected_revision": 0, "action": "add_observation",
                                     "observation": observation(row)})
        assert response.status_code == 422, response.text
        assert event_count(database) == 0


def test_upgrade_auth_action_boundaries_and_history_pagination(
    tmp_path: Path, originals: dict[str, Path],
) -> None:
    database, session_id = prepare(tmp_path / "data", [originals["quiet_9"]])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        row = run_summary(client, session_id)["windows"][0]
        base = f"/api/summary-windows/{row['id']}"
        assert client.post("/api/reviews/upgrade", json={}).status_code == 401
        assert store.schema_version(database) == 3
        assert client.get(f"{base}/review", headers=HEADERS).status_code == 409
        upgrade(client)
        for suffix in ("review", "review-history"):
            assert client.get(f"{base}/{suffix}").status_code == 401
        assert client.post(f"{base}/review-actions", json={}).status_code == 401
        for bad in ({"actor": " "}, {"expected_revision": True}, {"path": "/not-an-accepted-source"},
                    {"note": "x" * 2001}, {"action": "finalise"}):
            response = client.post(f"{base}/review-actions", headers=HEADERS,
                                   json={"actor": ACTOR, "expected_revision": 0, "action": "unable_to_assess",
                                         "note": "Synthetic note", **bad})
            assert response.status_code == 422, response.text
        assert event_count(database) == 0
        for revision in range(52):
            action(client, row["id"], revision, "unable_to_assess", note=f"Synthetic note {revision}")
        page = history(client, row["id"])
        assert len(page["events"]) == 50
        assert page["next_after_revision"] == 50
        final = history(client, row["id"], page["next_after_revision"])
        assert [event["revision"] for event in final["events"]] == [51, 52]
        assert final["next_after_revision"] is None
        assert current(client, row["id"])["revision"] == 52


@pytest.mark.parametrize("change", ["window_interval", "time_base", "parameter_hash", "current_metadata"])
def test_exact_review_binding_changes_require_reverification_without_editing_audit(
    tmp_path: Path, originals: dict[str, Path], change: str,
) -> None:
    database, session_id = prepare(tmp_path / "data", [originals["quiet_9"]])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        upgrade(client)
        run = run_summary(client, session_id)
        row = run["windows"][0]
        receipt = preview_receipt(client, row)
        action(client, row["id"], 0, "set_decision", decision="reviewed_no_discernible_event", preview_id=receipt["id"])
        before = history(client, row["id"])["events"]
        with sqlite3.connect(database) as connection:
            if change == "window_interval":
                interval = row["interval"]
                interval["start_pts"] = {"num": str(int(interval["start_pts"]["num"]) + 1), "den": "1"}
                connection.execute("UPDATE summary_window SET interval_json=? WHERE id=?", (json.dumps(interval), row["id"]))
            elif change == "time_base":
                connection.execute("UPDATE summary_window SET time_base_json=? WHERE id=?", ('{"num":"1","den":"1"}', row["id"]))
            elif change == "parameter_hash":
                connection.execute("UPDATE processing_run SET parameter_hash=? WHERE id=?", ("0" * 64, run["id"]))
            else:
                segment = store.segment_by_id(database, row["segment_id"])
                metadata = json.loads(segment["metadata_json"])
                metadata["first_pts"] = str(int(metadata["first_pts"]) + 1)
                connection.execute("UPDATE segment SET metadata_json=? WHERE id=?", (json.dumps(metadata), row["segment_id"]))
        result = current(client, row["id"])
        assert result["decision"] == "reviewed_no_discernible_event"
        assert result["effective_decision"] == "unreviewed" and result["needs_reverification"]
        assert result["verification_warning"] == "review_binding_mismatch"
        assert history(client, row["id"])["events"] == before
        refused = client.post(f"/api/summary-windows/{row['id']}/review-actions", headers=HEADERS,
                              json={"actor": ACTOR, "expected_revision": 1, "action": "set_decision",
                                    "decision": "reviewed_no_discernible_event", "preview_id": receipt["id"]})
        assert refused.status_code == 409, refused.text
        assert event_count(database) == 1


def test_failed_image_less_windows_can_be_manually_reviewed_without_shrinking_denominator(
    tmp_path: Path, originals: dict[str, Path],
) -> None:
    database, session_id = prepare(tmp_path / "data", [originals["quiet_65"]])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        upgrade(client)
        run = run_summary(client, session_id)
        first, second, third = run["windows"]
        # Inject only durable failure/coverage-loss states. The original source and
        # successful source-preview decode below remain real, not fake media outputs.
        with sqlite3.connect(database) as connection:
            connection.execute("""UPDATE summary_window SET status='failed',error_code='decode_failed',
                image_path=NULL,image_sha256=NULL,image_bytes=0 WHERE id=?""", (first["id"],))
            connection.execute("""UPDATE summary_window SET status='incomplete',error_code='cancelled',
                image_path=NULL,image_sha256=NULL,image_bytes=0 WHERE id=?""", (second["id"],))
            connection.execute("DELETE FROM summary_window WHERE id=?", (third["id"],))
            connection.execute("UPDATE processing_run SET state='incomplete' WHERE id=?", (run["id"],))
        detail = client.get(f"/api/summaries/{run['id']}", headers=HEADERS).json()
        assert len(detail["windows"]) == 2
        progress = detail["review_progress"]
        assert (progress["total"], progress["unreviewed"], progress["failed"], progress["incomplete"]) == (3, 3, 1, 1)
        receipt = preview_receipt(client, first)
        reviewed = action(client, first["id"], 0, "set_decision",
                          decision="reviewed_no_discernible_event", preview_id=receipt["id"])
        assert reviewed["effective_decision"] == "reviewed_no_discernible_event"
        progress = client.get(f"/api/summaries/{run['id']}", headers=HEADERS).json()["review_progress"]
        assert (progress["reviewed"], progress["total"], progress["unreviewed"]) == (1, 3, 2)


@pytest.mark.parametrize("invalidate_via", ["summary", "review_only"])
def test_restoring_identical_image_does_not_resurrect_invalidated_historical_review(
    tmp_path: Path, originals: dict[str, Path], invalidate_via: str,
) -> None:
    database, session_id = prepare(tmp_path / "data", [originals["quiet_9"]])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        upgrade(client)
        run = run_summary(client, session_id)
        row = run["windows"][0]
        receipt = preview_receipt(client, row)
        action(client, row["id"], 0, "set_decision", decision="reviewed_no_discernible_event", preview_id=receipt["id"])
        before = history(client, row["id"])["events"]
        image = Path(summary_store.private_window(database, row["id"])["image_path"])
        original_bytes = image.read_bytes()
        image.unlink()
        if invalidate_via == "summary":
            invalidated = client.get(f"/api/summaries/{run['id']}", headers=HEADERS).json()
            assert invalidated["windows"][0]["status"] == "incomplete"
            assert invalidated["review_progress"]["reviewed"] == 0
        else:
            assert current(client, row["id"])["needs_reverification"]
        image.write_bytes(original_bytes)
        restored = current(client, row["id"])
        assert restored["decision"] == "reviewed_no_discernible_event"
        assert restored["effective_decision"] == "unreviewed" and restored["needs_reverification"]
        assert restored["verification_warning"] == "review_binding_mismatch"
        assert history(client, row["id"])["events"] == before
        fresh_receipt = preview_receipt(client, row)
        renewed = action(client, row["id"], 1, "set_decision",
                         decision="reviewed_no_discernible_event", preview_id=fresh_receipt["id"])
        assert renewed["revision"] == 2 and not renewed["needs_reverification"]
        assert renewed["effective_decision"] == "reviewed_no_discernible_event"
        assert history(client, row["id"])["events"][:1] == before


def test_restoring_metadata_of_image_less_failed_window_requires_another_explicit_review(
    tmp_path: Path, originals: dict[str, Path],
) -> None:
    database, session_id = prepare(tmp_path / "data", [originals["quiet_9"]])
    with TestClient(create_app(Settings(database.parent, TOKEN))) as client:
        upgrade(client)
        run = run_summary(client, session_id)
        row = run["windows"][0]
        # A failed summary is a legal review target through its real original.
        with sqlite3.connect(database) as connection:
            connection.execute("""UPDATE summary_window SET status='failed',error_code='decode_failed',
                image_path=NULL,image_sha256=NULL,image_bytes=0 WHERE id=?""", (row["id"],))
            connection.execute("UPDATE processing_run SET state='failed' WHERE id=?", (run["id"],))
        receipt = preview_receipt(client, row)
        action(client, row["id"], 0, "set_decision", decision="reviewed_no_discernible_event", preview_id=receipt["id"])
        before = history(client, row["id"])["events"]
        original = store.segment_by_id(database, row["segment_id"])["metadata_json"]
        changed = json.loads(original)
        changed["first_pts"] = str(int(changed["first_pts"]) + 1)
        with sqlite3.connect(database) as connection:
            connection.execute("UPDATE segment SET metadata_json=? WHERE id=?", (json.dumps(changed), row["segment_id"]))
        assert current(client, row["id"])["needs_reverification"]
        with sqlite3.connect(database) as connection:
            connection.execute("UPDATE segment SET metadata_json=? WHERE id=?", (original, row["segment_id"]))
        restored = current(client, row["id"])
        assert restored["decision"] == "reviewed_no_discernible_event"
        assert restored["effective_decision"] == "unreviewed" and restored["needs_reverification"]
        assert restored["revision"] == 1
        assert history(client, row["id"])["events"] == before
        fresh_receipt = preview_receipt(client, row)
        renewed = action(client, row["id"], 1, "set_decision",
                         decision="reviewed_no_discernible_event", preview_id=fresh_receipt["id"])
        assert renewed["effective_decision"] == "reviewed_no_discernible_event"
        assert renewed["revision"] == 2 and not renewed["needs_reverification"]
