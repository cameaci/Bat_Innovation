"""QA migration, immutable history and atomic optimistic baselines."""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from threading import Barrier

import pytest

from backend.app import qa_store, review_store, store, summary_store
from backend.tests.test_review_store import ready


def prepared(tmp_path: Path):
    db, session, run, rows = ready(tmp_path)
    row = rows[0]
    review_store.apply(db, row["id"], 0, "First Reviewer", "set_decision",
                       decision="reviewed_no_discernible_event", verification={"fingerprint": "fp"})
    qa_store.upgrade(db)
    return db, session, run, row


def change(**fields):
    # Store-only receipts test transactions; integration tests validate real media.
    return {"actor": "Second Reviewer", "expected_revision": 0, "expected_first_review_revision": 1,
            "expected_evidence_revision": 0, "action": "set_decision", "decision": "agree",
            "note": "Synthetic second inspection", "suggestion": None, "preview_id": None,
            "confirmed": True, **fields}


def apply(db, row, **fields):
    return qa_store.apply(db, row["id"], change(**fields), "fp", {"fingerprint": "fp"})


def test_explicit_v5_upgrade_preserves_prior_records_and_compatible_operations(tmp_path):
    db, session, run, rows = ready(tmp_path)
    before = summary_store.private_run(db, run)
    first = review_store.get(db, rows[0]["id"])
    store.initialise(db)
    assert store.schema_version(db) == 4
    with pytest.raises(qa_store.QAError):
        qa_store.get(db, rows[0]["id"])
    qa_store.upgrade(db)
    qa_store.upgrade(db)
    store.initialise(db)
    store.upgrade_media(db)
    summary_store.upgrade(db)
    review_store.upgrade(db)
    assert store.schema_version(db) == 5
    assert summary_store.private_run(db, run) == before
    assert review_store.get(db, rows[0]["id"]) == first
    assert qa_store.get(db, rows[0]["id"])["decision"] == "pending"
    assert summary_store.create_run(db, session) != run


def test_v5_failed_migration_rolls_back_tables_and_version(tmp_path):
    db, _, run, _ = ready(tmp_path)
    before = summary_store.private_run(db, run)
    with sqlite3.connect(db) as c:
        c.execute("CREATE TABLE qa_event (existing TEXT)")
    with pytest.raises(sqlite3.DatabaseError):
        qa_store.upgrade(db)
    assert store.schema_version(db) == 4
    assert summary_store.private_run(db, run) == before
    with sqlite3.connect(db) as c:
        assert c.execute("SELECT name FROM sqlite_master WHERE name='qa_window'").fetchone() is None
        assert c.execute("PRAGMA table_info(qa_event)").fetchone()[1] == "existing"


@pytest.mark.parametrize("version", [1, 2, 3, 99])
def test_v5_refuses_wrong_versions_without_mutation(tmp_path, version):
    db, _, _, _ = ready(tmp_path)
    with sqlite3.connect(db) as c:
        c.execute(f"PRAGMA user_version={version}")
    with pytest.raises(store.DatabaseSchemaError):
        qa_store.upgrade(db)
    assert store.schema_version(db) == version


def test_qa_events_replay_retraction_and_reopen_without_first_review_mutation(tmp_path):
    db, _, _, row = prepared(tmp_path)
    first = review_store.get(db, row["id"])
    first_history = review_store.history(db, row["id"])
    saved = apply(db, row)
    assert saved["revision"] == 1
    saved = apply(db, row, expected_revision=1, decision="disagree", note="Synthetic unresolved uncertainty")
    saved = apply(db, row, expected_revision=2, action="retract", decision=None, note="Retract own assessment")
    store.initialise(db)
    events = qa_store.history(db, row["id"])["events"]
    assert [e["action"] for e in events] == ["set_decision", "set_decision", "retract"]
    assert [e["after"]["decision"] for e in events] == ["agree", "disagree", "pending"]
    replay = qa_store.empty()
    for event in events:
        assert event["before"] == replay
        replay = event["after"]
        assert event["run_id"] == row["run_id"] and event["window_id"] == row["id"]
        assert event["source_sha256"] == row["source_sha256"] and event["interval"] == row["interval"]
        assert event["first_review_revision"] == 1
    assert replay == saved == qa_store.get(db, row["id"])
    assert review_store.get(db, row["id"]) == first
    assert review_store.history(db, row["id"]) == first_history


@pytest.mark.parametrize("statement", ["UPDATE qa_event SET actor='changed'", "DELETE FROM qa_event",
                                      "INSERT OR REPLACE INTO qa_event SELECT * FROM qa_event"])
def test_qa_audit_rejects_update_delete_replace(tmp_path, statement):
    db, _, _, row = prepared(tmp_path)
    apply(db, row)
    before = qa_store.history(db, row["id"])
    with sqlite3.connect(db) as c, pytest.raises(sqlite3.DatabaseError):
        c.execute(statement)
    assert qa_store.history(db, row["id"]) == before


def test_qa_projection_failure_rolls_back_its_event(tmp_path):
    db, _, _, row = prepared(tmp_path)
    with sqlite3.connect(db) as c:
        c.execute("CREATE TRIGGER fail_qa BEFORE INSERT ON qa_window BEGIN SELECT RAISE(ABORT,'synthetic disk fault'); END")
    with pytest.raises(sqlite3.DatabaseError):
        apply(db, row)
    assert qa_store.get(db, row["id"])["revision"] == 0
    assert qa_store.history(db, row["id"])["events"] == []


@pytest.mark.parametrize("actor", ["first reviewer", " FIRST   Reviewer ", "Ｆｉｒｓｔ Reviewer", "First\tReviewer"])
def test_identical_normalized_actor_cannot_purport_independence(tmp_path, actor):
    db, _, _, row = prepared(tmp_path)
    with pytest.raises(qa_store.QAError, match="different normalized"):
        apply(db, row, actor=actor)
    assert qa_store.history(db, row["id"])["events"] == []


@pytest.mark.parametrize("field", ["expected_revision", "expected_first_review_revision", "expected_evidence_revision"])
def test_any_stale_revision_conflicts_without_qa_side_effects(tmp_path, field):
    db, _, _, row = prepared(tmp_path)
    with pytest.raises(qa_store.QAError) as e:
        apply(db, row, **{field: 8})
    assert e.value.code == "qa_conflict"
    assert qa_store.history(db, row["id"])["events"] == []


def test_concurrent_qa_writers_one_winner_one_conflict(tmp_path):
    db, _, _, row = prepared(tmp_path)
    barrier = Barrier(2)
    def save():
        barrier.wait()
        try:
            return apply(db, row)["revision"]
        except qa_store.QAError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: save(), range(2)))
    assert sorted(map(str, results)) == ["1", "qa_conflict"]
    assert len(qa_store.history(db, row["id"])["events"]) == 1


def test_history_pagination_is_bounded_and_ordered(tmp_path):
    db, _, _, row = prepared(tmp_path)
    for revision in range(52):
        apply(db, row, expected_revision=revision)
    page = qa_store.history(db, row["id"])
    assert len(page["events"]) == 50 and page["next_after_revision"] == 50
    tail = qa_store.history(db, row["id"], 50)
    assert [e["revision"] for e in tail["events"]] == [51, 52] and tail["next_after_revision"] is None
    assert len(json.dumps(page)) < 256000


@pytest.mark.skipif(sys.platform != 'linux', reason='Actual process-kill recovery exercised on Linux only')
def test_killed_writer_recovers_prior_qa_projection_and_history(tmp_path):
    db, _, _, row = prepared(tmp_path)
    apply(db, row)
    before = qa_store.get(db, row['id']), qa_store.history(db, row['id'])
    with sqlite3.connect(db) as c:
        c.execute("CREATE TRIGGER qa_test_interrupt BEFORE UPDATE ON qa_window BEGIN SELECT qa_test_kill(); END")
    # Only an OS failure is injected. The real production transaction has already
    # inserted its event when the projection's trigger kills the whole writer.
    script = '''import json,os,signal,sys
from pathlib import Path
from backend.app import store,qa_store
original=store.connect
def connect(path):
    c=original(path)
    c.create_function('qa_test_kill',0,lambda:os.kill(os.getpid(),signal.SIGKILL))
    return c
store.connect=connect
qa_store.apply(Path(sys.argv[1]),sys.argv[2],json.loads(sys.argv[3]),'fp',{'fingerprint':'fp'})
'''
    result = subprocess.run([sys.executable, '-c', script, str(db), row['id'], json.dumps(change(expected_revision=1))],
                            capture_output=True, timeout=10)
    assert result.returncode == -9, result.stderr.decode()
    store.initialise(db)
    assert (qa_store.get(db,row['id']),qa_store.history(db,row['id'])) == before
    with sqlite3.connect(db) as c:
        assert c.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        c.execute('DROP TRIGGER qa_test_interrupt')
    assert apply(db,row,expected_revision=1)['revision'] == 2
