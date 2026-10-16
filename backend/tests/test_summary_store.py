"""Exact metadata plans and transactional, restart-safe source-window manifests."""

from __future__ import annotations

import base64
from fractions import Fraction
from hashlib import sha256
import json
from pathlib import Path
import sqlite3

import pytest

from backend.app import store, summary_store, windows


def metadata(duration: Fraction | None = Fraction(65), *, first_pts: int = 0,
             last_pts: int | None = None, time_base: Fraction = Fraction(1, 25)) -> dict:
    if last_pts is None:
        last_pts = first_pts + int((duration or 65) / time_base) - 1
    return {"first_pts": str(first_pts), "last_pts": str(last_pts), "time_base": windows.rational(time_base),
            "end_time": windows.rational(first_pts * time_base + duration) if duration is not None else None}


def prepared(directory: Path, sources: list[dict] | None = None, *, upgraded: bool = True) -> tuple[Path, str]:
    database = directory / "ledger.sqlite3"
    store.initialise(database)
    store.upgrade_media(database)
    session = store.create_session(database, "Synthetic ledger", "Synthetic camera")["id"]
    inspected = []
    for index, item in enumerate(sources or [metadata()]):
        inspected.append((Path(f"/synthetic-only/source-{index}.mp4"), {
            **item, "sha256": sha256(str(index).encode()).hexdigest(),
            "_identity": {"device": 1, "inode": index, "size_bytes": index + 1, "mtime_ns": 1, "ctime_ns": 1},
        }))
    store.commit_segments(database, session, inspected)
    if upgraded:
        summary_store.upgrade(database)
    return database, session


def image(directory: Path, name: str = "derived.png") -> tuple[Path, str, int]:
    # A generated one-pixel PNG tests persistence, not a successful media decode.
    content = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
    path = directory / name
    path.write_bytes(content)
    return path, sha256(content).hexdigest(), len(content)


def complete_window(database: Path, window: dict, directory: Path) -> None:
    path, checksum, size = image(directory, window["id"] + ".png")
    summary_store.record_window(database, window["id"], {
        "frame_count": 1, "first_pts": "0", "last_pts": "0", "preview_pts": "0",
        "pts_digest": sha256(b"0").hexdigest(), "motion_pixels": 0, "comparison_count": 0,
        "gap_count": 0, "max_spacing": None, "gaps": [], "phase_pixels": [0, 0, 0],
    }, "complete", path, checksum, size)


@pytest.mark.parametrize(("duration", "count", "tail"), [(7200, 240, 30), (65, 3, 5), (9, 1, 9)])
def test_exact_metadata_plan_counts_and_half_open_partition(duration: int, count: int, tail: int) -> None:
    plan = windows.plan_source(metadata(Fraction(duration)))
    assert len(plan) == count
    assert windows.fraction(plan[0]["elapsed_start"]) == 0
    assert windows.fraction(plan[-1]["elapsed_end"]) == duration
    assert windows.fraction(plan[-1]["elapsed_end"]) - windows.fraction(plan[-1]["elapsed_start"]) == tail
    for left, right in zip(plan, plan[1:]):
        assert left["end_pts"] == right["start_pts"]
        assert left["end_time"] == right["start_time"]
        boundary = windows.fraction(right["start_pts"])
        if boundary.denominator == 1:
            assert windows.window_index(int(boundary), 0, Fraction(1, 25)) == right["index"]


def test_noninteger_pts_boundaries_and_vfr_pts_have_exactly_one_owner() -> None:
    item = metadata(Fraction(65), first_pts=11, time_base=Fraction(7, 300))
    plan = windows.plan_source(item)
    assert windows.fraction(plan[1]["start_pts"]) == Fraction(9077, 7)
    for pts in [11, 12, 51, 1000, 1296, 1297, 2000, int(item["last_pts"])]:
        owners = [row for row in plan if windows.fraction(row["start_pts"]) <= pts < windows.fraction(row["end_pts"])]
        assert len(owners) == 1
        assert owners[0]["index"] == windows.window_index(pts, 11, Fraction(7, 300))


@pytest.mark.parametrize("last", [0, 29, 30, 60, 65])
def test_unknown_final_duration_keeps_open_tail_and_boundary_frame(last: int) -> None:
    plan = windows.plan_source(metadata(None, first_pts=100, last_pts=100 + last, time_base=Fraction(1)))
    assert len(plan) == last // 30 + 1
    assert plan[-1]["end_time"] is None and plan[-1]["end_pts"] is None
    assert windows.fraction(plan[-1]["elapsed_start"]) == (last // 30) * 30
    assert windows.window_index(100 + last, 100, Fraction(1)) == plan[-1]["index"]
    assert all(left["end_time"] == right["start_time"] for left, right in zip(plan, plan[1:]))


def test_parameter_hash_is_canonical_and_records_toolchain_without_native_imports() -> None:
    params = windows.parameters()
    assert params["threshold"] == 3 and params["gain"] == 16
    assert params["toolchain"] == {"numpy": "2.4.2", "pillow": "12.1.1", "pyav": "19.0.1"}
    assert windows.parameter_hash(params) == windows.parameter_hash(dict(reversed(list(params.items()))))
    assert windows.parameter_hash(params) != windows.parameter_hash(windows.parameters(20))
    for bad in (0, 121, 30.0, True):
        with pytest.raises(ValueError):
            windows.parameters(bad)
    with pytest.raises(ValueError, match="resource limit"):
        windows.plan_source(metadata(Fraction(60001)))


def test_v2_upgrade_is_explicit_preserves_sources_and_other_tables(tmp_path: Path) -> None:
    database, session = prepared(tmp_path, upgraded=False)
    before = store.private_segments(database, session)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE review_example (value TEXT)")
        connection.execute("INSERT INTO review_example VALUES ('unchanged synthetic review')")
    store.initialise(database)
    assert store.schema_version(database) == 2
    summary_store.upgrade(database)
    summary_store.upgrade(database)
    store.initialise(database)
    store.upgrade_media(database)
    assert store.schema_version(database) == 3
    assert store.private_segments(database, session) == before
    assert store.segment_by_id(database, before[0]["id"]) == before[0]
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT value FROM review_example").fetchone()[0] == "unchanged synthetic review"
    # Existing import and timeline operations remain supported after v3.
    store.update_media(database, session, [before[0]["id"]], [{"segment_id": before[0]["id"], "status": "unknown", "provenance": None}], None)
    assert store.clock_anchor(database, session) is None


def test_v2_upgrade_failure_rolls_back_created_table_and_version(tmp_path: Path) -> None:
    database, session = prepared(tmp_path, upgraded=False)
    before = store.private_segments(database, session)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE summary_window (existing TEXT)")
    with pytest.raises(sqlite3.DatabaseError):
        summary_store.upgrade(database)
    assert store.schema_version(database) == 2
    assert store.private_segments(database, session) == before
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT name FROM sqlite_master WHERE name='processing_run'").fetchone() is None
        assert connection.execute("PRAGMA table_info(summary_window)").fetchone()[1] == "existing"


def test_plans_all_independent_segments_and_immutable_private_source_snapshots(tmp_path: Path) -> None:
    database, session = prepared(tmp_path, [metadata(), metadata(Fraction(9), first_pts=144000)])
    run_id = summary_store.create_run(database, session, 30)
    public, private = summary_store.get_run(database, run_id), summary_store.private_run(database, run_id)
    assert public["counts"]["planned"] == 4 and len(public["windows"]) == 4
    assert [row["interval"]["elapsed_start"] for row in public["windows"]] == [windows.rational(0), windows.rational(30), windows.rational(60), windows.rational(0)]
    assert public["state"] == "queued"
    assert all(row["status"] == "planned" for row in public["windows"])
    serialised = json.dumps(public)
    assert "source_path" not in serialised and "/synthetic-only" not in serialised and "identity_json" not in serialised
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE segment SET continuity='known_gap',continuity_provenance='synthetic gap'")
    assert summary_store.private_run(database, run_id)["sources"] == private["sources"]
    assert summary_store.list_runs(database, session)[0]["id"] == run_id
    assert summary_store.private_window(database, public["windows"][0]["id"])["source"] == private["sources"][0]


def test_plan_limit_rejects_whole_run_without_partial_rows(tmp_path: Path) -> None:
    database, session = prepared(tmp_path, [metadata(Fraction(33000)), metadata(Fraction(33000))])
    with pytest.raises(ValueError, match="resource limit"):
        summary_store.create_run(database, session)
    assert summary_store.list_runs(database, session) == []
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT count(*) FROM summary_window").fetchone()[0] == 0


def test_missing_or_failed_planned_window_cannot_complete(tmp_path: Path) -> None:
    database, session = prepared(tmp_path)
    run_id = summary_store.create_run(database, session)
    rows = summary_store.get_run(database, run_id)["windows"]
    complete_window(database, rows[0], tmp_path)
    with sqlite3.connect(database) as connection:
        connection.execute("DELETE FROM summary_window WHERE id=?", (rows[1]["id"],))
    summary_store.record_window(database, rows[2]["id"], {"frame_count": 0}, "failed", error_code="no_decoded_frames")
    summary_store.finish_run(database, run_id, "complete")
    result = summary_store.get_run(database, run_id)
    assert result["state"] == "incomplete" and result["counts"]["planned"] == 3
    assert result["counts"]["complete"] == 1 and result["counts"]["failed"] == 1


def test_unknown_end_remains_incomplete_even_with_an_image(tmp_path: Path) -> None:
    database, session = prepared(tmp_path, [metadata(None, last_pts=1500)])
    run_id = summary_store.create_run(database, session)
    rows = summary_store.get_run(database, run_id)["windows"]
    assert rows[-1]["status"] == "incomplete" and rows[-1]["error"]["code"] == "unknown_end"
    for row in rows:
        complete_window(database, row, tmp_path)
    summary_store.finish_run(database, run_id, "complete")
    result = summary_store.get_run(database, run_id)
    assert result["state"] == "incomplete"
    assert result["windows"][-1]["status"] == "incomplete"
    assert result["windows"][-1]["image"] is not None


def test_restart_and_cancel_keep_successful_images_stats_and_all_records(tmp_path: Path) -> None:
    database, session = prepared(tmp_path)
    run_id = summary_store.create_run(database, session)
    rows = summary_store.get_run(database, run_id)["windows"]
    summary_store.set_running(database, run_id)
    complete_window(database, rows[0], tmp_path)
    summary_store.start_window(database, rows[1]["id"])
    summary_store.recover(database)
    result = summary_store.get_run(database, run_id)
    assert result["state"] == "interrupted"
    assert [row["status"] for row in result["windows"]] == ["complete", "incomplete", "incomplete"]
    assert result["windows"][0]["stats"]["frame_count"] == 1
    assert result["windows"][1]["error"]["code"] == "interrupted"
    assert len(summary_store.image_references(database)) == 1
    summary_store.recover(database)
    assert summary_store.get_run(database, run_id) == result
    retry = summary_store.create_run(database, session)
    assert retry != run_id
    summary_store.finish_run(database, retry, "cancelled", "cancelled")
    cancelled = summary_store.get_run(database, retry)
    assert cancelled["state"] == "cancelled" and cancelled["counts"]["incomplete"] == 3
    assert summary_store.get_run(database, run_id) == result


def test_images_are_checksummed_successes_immutable_and_missing_images_invalidate_on_restart(tmp_path: Path) -> None:
    database, session = prepared(tmp_path, [metadata(Fraction(9))])
    run_id = summary_store.create_run(database, session)
    row = summary_store.get_run(database, run_id)["windows"][0]
    path, checksum, size = image(tmp_path)
    with pytest.raises(ValueError, match="checksum"):
        summary_store.record_window(database, row["id"], {"frame_count": 1}, "complete", path, "0" * 64, size)
    complete_window(database, row, tmp_path)
    with pytest.raises(ValueError, match="immutable"):
        complete_window(database, row, tmp_path)
    summary_store.finish_run(database, run_id, "complete")
    assert summary_store.get_run(database, run_id)["state"] == "complete"
    recorded = summary_store.private_window(database, row["id"])
    Path(recorded["image_path"]).unlink()
    summary_store.recover(database)
    result = summary_store.get_run(database, run_id)
    assert result["state"] == "incomplete"
    assert result["windows"][0]["error"]["code"] == "image_unavailable"
    assert result["windows"][0]["image"]["sha256"] == recorded["image_sha256"]
    assert recorded["image_path"] in summary_store.image_references(database)


def test_quality_gap_stats_survive_durable_read_and_explicit_source_invalidation(tmp_path: Path) -> None:
    database, session = prepared(tmp_path, [metadata(Fraction(9))])
    run_id = summary_store.create_run(database, session)
    row = summary_store.get_run(database, run_id)["windows"][0]
    path, checksum, size = image(tmp_path)
    stats = {"frame_count": 2, "first_pts": "0", "last_pts": "200", "preview_pts": "0",
             "pts_digest": "f" * 64, "comparison_count": 1, "motion_pixels": 4, "phase_pixels": [4, 0, 0],
             "gap_count": 1, "max_spacing": windows.rational(8),
             "gaps": [{"start": windows.rational(1), "end": windows.rational(8)}]}
    summary_store.record_window(database, row["id"], stats, "complete", path, checksum, size, flags=["declared_duration_gap"])
    summary_store.finish_run(database, run_id, "complete")
    assert summary_store.get_run(database, run_id)["windows"][0]["stats"] == stats
    summary_store.invalidate_window(database, row["id"], "changed_source")
    result = summary_store.get_run(database, run_id)
    assert result["state"] == "incomplete" and result["windows"][0]["status"] == "incomplete"
    assert result["windows"][0]["flags"] == ["declared_duration_gap"]
    assert result["windows"][0]["image"]["sha256"] == checksum


def test_maximum_public_manifest_fits_desktop_transport_without_losing_windows(tmp_path: Path) -> None:
    database, session = prepared(tmp_path, [metadata(Fraction(60000), first_pts=9000000000000000000)])
    run_id = summary_store.create_run(database, session)
    gaps = [{"start": windows.rational(Fraction(9000000000000000000 + index, 900000001)),
             "end": windows.rational(Fraction(9000000000000000001 + index, 900000001))} for index in range(64)]
    stats = {"frame_count": 1000000, "first_pts": "9000000000000000000", "last_pts": "9000000000000000001",
             "preview_pts": "9000000000000000000", "pts_digest": "f" * 64, "comparison_count": 999999,
             "motion_pixels": 230400, "phase_pixels": [230400] * 3, "gap_count": 1000,
             "max_spacing": windows.rational(30), "gaps": gaps}
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE summary_window SET stats_json=?, flags_json=?", (json.dumps(stats), json.dumps([
            "source_speed_unverified", "derived_grayscale_evidence", "rotation_not_applied", "field_order_unverified",
            "interlaced_not_deinterlaced", "framewide_change", "brightness_transition", "declared_timestamp_gap",
            "gap_examples_truncated"])))
    public = summary_store.get_run(database, run_id)
    assert len(public["windows"]) == public["counts"]["planned"] == 2000
    assert len(json.dumps(public).encode()) < 4 * 1024 * 1024
    assert len(public["windows"][0]["stats"]["gaps"]) == 2
    assert public["windows"][0]["stats"]["gap_examples_recorded"] == 64
    assert public["windows"][0]["stats"]["gap_count"] == 1000
    assert len(summary_store.private_run(database, run_id)["windows"][0]["stats"]["gaps"]) == 64
