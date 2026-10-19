"""Manual review audit invariants, exact source bounds and transaction failures."""

from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
import json
from pathlib import Path
import sqlite3
from threading import Barrier

import pytest

from backend.app import review_store, store, summary_store
from backend.tests.test_summary_store import metadata, prepared


def ready(tmp_path: Path, sources: list[dict] | None = None) -> tuple[Path, str, str, list[dict]]:
    database, session = prepared(tmp_path, sources)
    run = summary_store.create_run(database, session)
    review_store.upgrade(database)
    return database, session, run, summary_store.get_run(database, run)["windows"]


def observation(window: dict, start: str = "0", end: str = "1", **changes: object) -> dict:
    return {"segment_id": window["segment_id"], "start_pts": start, "end_pts": end,
            "category": "uncertain", "activity": None, "count": None, "uncertain": True,
            "notes": "Synthetic uncertain visual record", **changes}


def receipt(window: dict) -> dict:
    # Store unit tests check the transaction, not a successful source verification.
    # The real source/preview receipt is validated by service integration tests.
    return {"preview_id": "synthetic-store-only", "segment_id": window["segment_id"]}


def save(database: Path, window: dict, revision: int, action: str, **kwargs: object) -> dict:
    return review_store.apply(database, window["id"], revision, " Synthetic reviewer ", action, **kwargs)


def test_v4_upgrade_preserves_media_runs_and_is_explicit(tmp_path: Path) -> None:
    database, session = prepared(tmp_path)
    run = summary_store.create_run(database, session)
    before_sources, before_run = store.private_segments(database, session), summary_store.private_run(database, run)
    store.initialise(database)
    assert store.schema_version(database) == 3
    with pytest.raises(review_store.ReviewError, match="upgrade"):
        review_store.get(database, before_run["windows"][0]["id"])
    review_store.upgrade(database)
    review_store.upgrade(database)
    store.initialise(database)
    store.upgrade_media(database)
    summary_store.upgrade(database)
    assert store.schema_version(database) == 4
    assert store.private_segments(database, session) == before_sources
    migrated_run = summary_store.private_run(database, run)
    for row in migrated_run["windows"]:
        assert row.pop("evidence_revision") == 0 and row.pop("evidence_warning") is None
    assert migrated_run == before_run
    assert summary_store.private_window(database, before_run["windows"][0]["id"]) is not None
    assert summary_store.list_runs(database, session)[0]["id"] == run
    assert summary_store.create_run(database, session) != run
    assert store.segment_by_id(database, before_sources[0]["id"]) == before_sources[0]
    store.update_media(database, session, [before_sources[0]["id"]],
                       [{"segment_id": before_sources[0]["id"], "status": "unknown", "provenance": None}], None)


def test_upgrade_failure_rolls_back_all_added_tables_and_version(tmp_path: Path) -> None:
    database, session = prepared(tmp_path)
    before = store.private_segments(database, session)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE review_event (old TEXT)")
    with pytest.raises(sqlite3.DatabaseError):
        review_store.upgrade(database)
    assert store.schema_version(database) == 3
    assert store.private_segments(database, session) == before
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT name FROM sqlite_master WHERE name='review_window'").fetchone() is None
        assert connection.execute("PRAGMA table_info(review_event)").fetchone()[1] == "old"
        columns = {row[1] for row in connection.execute("PRAGMA table_info(summary_window)")}
        assert "evidence_revision" not in columns and "evidence_warning" not in columns


@pytest.mark.parametrize("version", [1, 2, 99])
def test_upgrade_refuses_wrong_schema_without_rewrite(tmp_path: Path, version: int) -> None:
    database = tmp_path / "versions.sqlite3"
    store.initialise(database)
    if version == 2:
        store.upgrade_media(database)
    elif version == 99:
        with sqlite3.connect(database) as connection:
            connection.execute("PRAGMA user_version=99")
    with pytest.raises(store.DatabaseSchemaError):
        review_store.upgrade(database)
    assert store.schema_version(database) == version


def test_reads_and_quiet_failed_incomplete_windows_never_review_automatically(tmp_path: Path) -> None:
    database, _, run, rows = ready(tmp_path)
    summary_store.record_window(database, rows[0]["id"], {"motion_pixels": 0}, "incomplete", error_code="no_decoded_frames")
    summary_store.record_window(database, rows[1]["id"], {}, "failed", error_code="decode_failed")
    for _ in range(3):
        assert all(review_store.get(database, item["id"])["decision"] == "unreviewed" for item in rows)
        assert all(item["revision"] == 0 for item in review_store.headers(database, run).values())
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT count(*) FROM review_event").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM review_window").fetchone()[0] == 0
    assert summary_store.get_run(database, run)["counts"]["planned"] == 3


def test_zero_one_many_unknown_count_edit_delete_and_event_replay(tmp_path: Path) -> None:
    database, _, _, rows = ready(tmp_path)
    window = rows[0]
    initial = save(database, window, 0, "set_decision", decision="reviewed_no_discernible_event", verification=receipt(window))
    assert initial["decision"] == "reviewed_no_discernible_event"
    one = save(database, window, 1, "add_observation", observation=observation(window))
    first_id = one["observations"][0]["id"]
    assert one["decision"] == "unreviewed" and one["verification"] is None
    assert one["observations"][0]["count"] is None and one["observations"][0]["uncertain"] is True
    two = save(database, window, 2, "add_observation", observation=observation(window, "4", "8", category="insect", count=2))
    second_id = two["observations"][1]["id"]
    reviewed = save(database, window, 3, "set_decision", decision="reviewed_with_observations", verification=receipt(window))
    assert reviewed["decision"] == "reviewed_with_observations"
    edited = save(database, window, 4, "update_observation", observation_id=first_id,
                  observation=observation(window, "1", "3", category="bat", notes="Provisional, not a species determination"))
    assert edited["decision"] == "unreviewed" and edited["observations"][0]["id"] == first_id
    deleted = save(database, window, 5, "delete_observation", observation_id=second_id)
    assert len(deleted["observations"]) == 1
    final = save(database, window, 6, "unable_to_assess", note="Cannot establish enough visual detail")
    assert final["decision"] == "unreviewed" and final["unable_note"]
    events = review_store.history(database, window["id"])["events"]
    assert len(events) == 7 and [item["revision"] for item in events] == list(range(1, 8))
    assert events[5]["before"]["observation"]["id"] == second_id and events[5]["after"]["observation"] is None
    folded = {"decision": "unreviewed", "unable_note": "", "verification": None}
    live = {}
    for event in events:
        assert event["actor"] == "Synthetic reviewer" and event["utc"].endswith("+00:00")
        assert event["window_id"] == window["id"] and event["source_sha256"] == window["source_sha256"]
        assert event["parameter_hash"] and event["time_base"] == window["time_base"]
        assert "source_path" not in json.dumps(event) and "identity_json" not in json.dumps(event)
        for field in folded:
            assert event["before"][field] == folded[field]
            folded[field] = event["after"][field]
        if event["observation_id"]:
            if event["after"]["observation"] is None:
                live.pop(event["observation_id"])
            else:
                live[event["observation_id"]] = event["after"]["observation"]
    assert list(live.values()) == final["observations"]
    assert all(final[key] == value for key, value in folded.items())
    store.initialise(database)
    assert review_store.get(database, window["id"]) == final
    assert review_store.history(database, window["id"])["events"] == events


@pytest.mark.parametrize("operation", [
    "UPDATE review_event SET actor='overwritten'", "DELETE FROM review_event",
    """INSERT OR REPLACE INTO review_event SELECT window_id,run_id,revision,utc,'overwritten',action,
        binding_json,before_json,after_json,observation_id,span_json FROM review_event""",
])
def test_audit_rows_are_append_only(tmp_path: Path, operation: str) -> None:
    database, _, _, rows = ready(tmp_path)
    save(database, rows[0], 0, "unable_to_assess", note="Synthetic unresolved")
    before = review_store.history(database, rows[0]["id"])
    with sqlite3.connect(database) as connection, pytest.raises(sqlite3.IntegrityError, match="append-only"):
        connection.execute(operation)
    assert review_store.history(database, rows[0]["id"]) == before


def test_failed_projection_write_rolls_back_the_appended_event(tmp_path: Path) -> None:
    database, _, _, rows = ready(tmp_path)
    with sqlite3.connect(database) as connection:
        connection.execute("""CREATE TRIGGER simulated_disk_failure BEFORE INSERT ON review_window
            BEGIN SELECT RAISE(ABORT,'Injected failed projection'); END""")
    with pytest.raises(sqlite3.IntegrityError, match="Injected"):
        save(database, rows[0], 0, "unable_to_assess", note="Synthetic unresolved")
    assert review_store.get(database, rows[0]["id"])["revision"] == 0
    assert review_store.history(database, rows[0]["id"])["events"] == []


def test_concurrent_and_stale_revisions_never_overwrite_audit(tmp_path: Path) -> None:
    database, _, _, rows = ready(tmp_path)
    gate = Barrier(2)
    def write(label: str) -> str:
        gate.wait()
        try:
            review_store.apply(database, rows[0]["id"], 0, label, "unable_to_assess", note=label)
            return "saved"
        except review_store.ReviewError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(write, ["Synthetic reviewer A", "Synthetic reviewer B"]))
    assert sorted(results) == ["review_conflict", "saved"]
    before = review_store.get(database, rows[0]["id"])
    with pytest.raises(review_store.ReviewError) as error:
        save(database, rows[0], 0, "add_observation", observation=observation(rows[0]))
    assert error.value.status == 409 and error.value.code == "review_conflict"
    assert review_store.get(database, rows[0]["id"]) == before
    assert len(review_store.history(database, rows[0]["id"])["events"]) == 1


def test_first_review_transitions_require_explicit_consistent_decisions(tmp_path: Path) -> None:
    database, _, _, rows = ready(tmp_path)
    for kwargs in [{"decision": "reviewed_with_observations", "verification": receipt(rows[0])},
                   {"decision": "reviewed_no_discernible_event"}]:
        with pytest.raises(review_store.ReviewError):
            save(database, rows[0], 0, "set_decision", **kwargs)
    added = save(database, rows[0], 0, "add_observation", observation=observation(rows[0]))
    with pytest.raises(review_store.ReviewError):
        save(database, rows[0], 1, "set_decision", decision="reviewed_no_discernible_event", verification=receipt(rows[0]))
    assert review_store.get(database, rows[0]["id"]) == added
    assert save(database, rows[0], 1, "set_decision", decision="unreviewed")["decision"] == "unreviewed"


@pytest.mark.parametrize("changes", [
    {"start_pts": "0.0"}, {"start_pts": 0}, {"end_pts": "0"}, {"start_pts": "-1"},
    {"end_pts": "751"}, {"start_pts": "750", "end_pts": "751"},
    {"start_pts": "9223372036854775808"}, {"count": True}, {"count": -1},
    {"count": 1.5}, {"count": 100001}, {"uncertain": 1}, {"category": "confirmed_bat"},
    {"activity": "x" * 121}, {"notes": "x" * 2001}, {"segment_id": "different-source"},
])
def test_observation_validation_is_exact_and_bounded(tmp_path: Path, changes: dict) -> None:
    database, _, _, rows = ready(tmp_path)
    with pytest.raises(review_store.ReviewError) as error:
        save(database, rows[0], 0, "add_observation", observation=observation(rows[0], **changes))
    assert error.value.code == "review_invalid" and error.value.status == 422
    assert review_store.history(database, rows[0]["id"])["events"] == []


def test_nonzero_vfr_fractional_window_boundaries_and_final_partial(tmp_path: Path) -> None:
    database, _, _, rows = ready(tmp_path, [metadata(Fraction(65), first_pts=11, time_base=Fraction(7, 300))])
    # First exact 30-second boundary is 9077/7 ticks, between 1296 and 1297.
    assert save(database, rows[0], 0, "add_observation", observation=observation(rows[0], "11", "1296"))["revision"] == 1
    assert save(database, rows[1], 0, "add_observation", observation=observation(rows[1], "1297", "2582"))["revision"] == 1
    with pytest.raises(review_store.ReviewError):
        save(database, rows[1], 1, "add_observation", observation=observation(rows[1], "1296", "1297"))
    assert save(database, rows[2], 0, "add_observation", observation=observation(rows[2], "2583", "2796"))["revision"] == 1
    with pytest.raises(review_store.ReviewError):
        save(database, rows[2], 1, "add_observation", observation=observation(rows[2], "2796", "2797"))


def test_half_open_window_end_and_unknown_source_end_are_not_invented(tmp_path: Path) -> None:
    database, _, _, rows = ready(tmp_path)
    assert save(database, rows[0], 0, "add_observation", observation=observation(rows[0], "749", "750"))["revision"] == 1
    assert save(database, rows[1], 0, "add_observation", observation=observation(rows[1], "750", "751"))["revision"] == 1
    unknown_dir = tmp_path / "unknown"
    unknown_dir.mkdir()
    database, _, _, unknown = ready(unknown_dir, [metadata(None, first_pts=100, last_pts=165, time_base=Fraction(1))])
    tail = unknown[-1]
    assert save(database, tail, 0, "add_observation", observation=observation(tail, "164", "165"))["revision"] == 1
    with pytest.raises(review_store.ReviewError):
        save(database, tail, 1, "add_observation", observation=observation(tail, "165", "166"))
    with pytest.raises(review_store.ReviewError) as error:
        save(database, tail, 1, "set_decision", decision="reviewed_with_observations", verification=receipt(tail))
    assert error.value.code == "review_unavailable"


def test_independent_runs_segments_and_all_window_headers(tmp_path: Path) -> None:
    database, session, run_a, rows = ready(tmp_path, [metadata(), metadata(Fraction(9), first_pts=144000)])
    assert len(rows) == 4
    save(database, rows[0], 0, "set_decision", decision="reviewed_no_discernible_event", verification=receipt(rows[0]))
    run_b = summary_store.create_run(database, session)
    assert all(header["decision"] == "unreviewed" for header in review_store.headers(database, run_b).values())
    assert len(review_store.headers(database, run_a)) == len(review_store.headers(database, run_b)) == 4
    summary_store.record_window(database, rows[2]["id"], {}, "failed", error_code="decode_failed")
    summary_store.record_window(database, rows[3]["id"], {}, "incomplete", error_code="unknown_end")
    headers = review_store.headers(database, run_a)
    assert sum(header["decision"] != "unreviewed" for header in headers.values()) == 1
    assert summary_store.get_run(database, run_a)["counts"]["planned"] == 4
    assert headers[rows[2]["id"]]["decision"] == headers[rows[3]["id"]]["decision"] == "unreviewed"
    second = rows[-1]
    assert save(database, second, 0, "add_observation", observation=observation(second, "144000", "144001"))["revision"] == 1


def test_history_pagination_is_bounded_and_event_deltas_do_not_repeat_observations(tmp_path: Path) -> None:
    database, _, _, rows = ready(tmp_path)
    for revision in range(53):
        save(database, rows[0], revision, "unable_to_assess", note=f"Synthetic revision {revision}")
    page = review_store.history(database, rows[0]["id"])
    assert len(page["events"]) == 50 and page["next_after_revision"] == 50
    rest = review_store.history(database, rows[0]["id"], page["next_after_revision"])
    assert len(rest["events"]) == 3 and rest["next_after_revision"] is None
    assert all("observations" not in event["before"] and "observations" not in event["after"] for event in page["events"])
    with pytest.raises(review_store.ReviewError):
        review_store.history(database, rows[0]["id"], -1)
    with pytest.raises(review_store.ReviewError):
        review_store.history(database, rows[0]["id"], limit=51)


def test_maximum_observations_and_reviewer_label_validation(tmp_path: Path) -> None:
    database, _, _, rows = ready(tmp_path)
    for revision in range(100):
        save(database, rows[0], revision, "add_observation", observation=observation(rows[0]))
    with pytest.raises(review_store.ReviewError):
        save(database, rows[0], 100, "add_observation", observation=observation(rows[0]))
    assert review_store.headers(database, rows[0]["run_id"])[rows[0]["id"]]["observation_count"] == 100
    for actor in ["", "  ", "x" * 121, None]:
        with pytest.raises(review_store.ReviewError):
            review_store.apply(database, rows[0]["id"], 100, actor, "unable_to_assess", note="Synthetic")
    assert review_store.get(database, rows[0]["id"])["revision"] == 100


def test_evidence_epoch_transitions_persist_without_rewriting_terminal_errors_or_human_history(tmp_path: Path) -> None:
    database, _, _, rows = ready(tmp_path)
    window = rows[0]
    summary_store.record_window(database, window["id"], {}, "failed", error_code="decode_failed")
    reviewed = save(database, window, 0, "set_decision", decision="reviewed_no_discernible_event", verification=receipt(window))
    audit = review_store.history(database, window["id"])
    assert review_store.evidence_epoch(database, window["id"], None) == 0
    assert review_store.evidence_epoch(database, window["id"], "missing_source") == 1
    assert review_store.evidence_epoch(database, window["id"], "missing_source") == 1
    store.initialise(database)
    assert review_store.evidence_epoch(database, window["id"], "missing_source") == 1
    assert review_store.evidence_epoch(database, window["id"], "changed_source") == 2
    assert review_store.evidence_epoch(database, window["id"], None) == 3
    assert review_store.evidence_epoch(database, window["id"], None) == 3
    current = summary_store.private_window(database, window["id"])
    assert current["evidence_revision"] == 3 and current["evidence_warning"] is None
    assert current["status"] == "failed" and current["error_code"] == "decode_failed"
    assert review_store.binding(database, window["id"])["evidence_revision"] == 3
    assert review_store.get(database, window["id"]) == reviewed
    assert review_store.history(database, window["id"]) == audit


def test_repeated_evidence_validation_uses_read_only_fast_path(tmp_path: Path, monkeypatch) -> None:
    database, _, _, rows = ready(tmp_path)
    window = rows[0]
    statements = []
    original_connect = store.connect
    def traced_connect(path: Path):
        connection = original_connect(path)
        connection.set_trace_callback(statements.append)
        return connection
    monkeypatch.setattr(store, "connect", traced_connect)
    assert review_store.evidence_epoch(database, window["id"], None) == 0
    assert not any(statement.startswith(("UPDATE", "BEGIN")) for statement in statements)
    assert review_store.evidence_epoch(database, window["id"], "missing_source") == 1
    assert any(statement.startswith("BEGIN IMMEDIATE") for statement in statements)
    statements.clear()
    assert review_store.evidence_epoch(database, window["id"], "missing_source") == 1
    assert not any(statement.startswith(("UPDATE", "BEGIN")) for statement in statements)


def test_concurrent_identical_evidence_failures_increment_epoch_once(tmp_path: Path) -> None:
    database, _, _, rows = ready(tmp_path)
    gate = Barrier(2)
    def validate(_: int) -> int:
        gate.wait()
        return review_store.evidence_epoch(database, rows[0]["id"], "missing_source")
    with ThreadPoolExecutor(max_workers=2) as workers:
        assert list(workers.map(validate, range(2))) == [1, 1]
    assert review_store.binding(database, rows[0]["id"])["evidence_revision"] == 1
    assert review_store.get(database, rows[0]["id"])["revision"] == 0
    assert review_store.history(database, rows[0]["id"])["events"] == []
