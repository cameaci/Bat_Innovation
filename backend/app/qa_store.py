"""Separate append-only second-review history and its atomic projection."""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import unicodedata

from . import review_store, store

DECISIONS = {"agree", "disagree", "needs_clarification", "unassessable"}


class QAError(review_store.ReviewError):
    """A bounded path-free second-review error."""


def conflict() -> QAError:
    return QAError("qa_conflict", "QA, first review or evidence changed. Keep your draft; discard and reload before retrying.", 409)


def require_schema(connection: sqlite3.Connection) -> None:
    if connection.execute("PRAGMA user_version").fetchone()[0] not in store.QA_SCHEMA_VERSIONS:
        raise QAError("qa_schema_required", "Explicit QA schema upgrade is required.", 409)


def upgrade(db_path: Path) -> None:
    if not db_path.is_file():
        raise store.DatabaseSchemaError("QA upgrade requires an existing version 4 database")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version in store.QA_SCHEMA_VERSIONS:
            return
        if version != store.REVIEW_SCHEMA_VERSION:
            raise store.DatabaseSchemaError("QA upgrade requires database schema version 4")
        connection.execute("SELECT window_id,revision FROM review_window LIMIT 1")
        connection.execute("""CREATE TABLE qa_window (
            window_id TEXT PRIMARY KEY REFERENCES summary_window(id),
            run_id TEXT NOT NULL REFERENCES processing_run(id),
            revision INTEGER NOT NULL CHECK(revision > 0),
            value_json TEXT NOT NULL CHECK(json_valid(value_json))
        )""")
        connection.execute("""CREATE TABLE qa_event (
            window_id TEXT NOT NULL REFERENCES summary_window(id),
            run_id TEXT NOT NULL REFERENCES processing_run(id),
            revision INTEGER NOT NULL CHECK(revision > 0),
            utc TEXT NOT NULL,
            actor TEXT NOT NULL CHECK(length(trim(actor)) BETWEEN 1 AND 120),
            action TEXT NOT NULL CHECK(action IN ('set_decision','retract')),
            first_review_revision INTEGER NOT NULL CHECK(first_review_revision >= 0),
            evidence_revision INTEGER NOT NULL CHECK(evidence_revision >= 0),
            binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
            before_json TEXT NOT NULL CHECK(json_valid(before_json)),
            after_json TEXT NOT NULL CHECK(json_valid(after_json)),
            PRIMARY KEY(window_id,revision)
        )""")
        connection.execute("CREATE INDEX qa_window_run ON qa_window(run_id)")
        for action in ("UPDATE", "DELETE"):
            connection.execute(f"""CREATE TRIGGER qa_event_no_{action.lower()} BEFORE {action} ON qa_event
                BEGIN SELECT RAISE(ABORT, 'QA history is append-only'); END""")
        connection.execute("""CREATE TRIGGER qa_event_no_replace BEFORE INSERT ON qa_event
            WHEN EXISTS(SELECT 1 FROM qa_event WHERE window_id=NEW.window_id AND revision=NEW.revision)
            BEGIN SELECT RAISE(ABORT, 'QA history is append-only'); END""")
        connection.execute(f"PRAGMA user_version={store.QA_SCHEMA_VERSION}")


def empty() -> dict:
    return {"revision": 0, "decision": "pending", "note": "", "suggestion": None, "actor": None,
            "updated_at_utc": None, "first_review_revision": 0, "evidence_revision": 0,
            "fingerprint": None, "verification": None}


def _get(connection: sqlite3.Connection, window_id: str) -> dict:
    row = connection.execute("SELECT value_json FROM qa_window WHERE window_id=?", (window_id,)).fetchone()
    return json.loads(row[0]) if row else empty()


def get(db_path: Path, window_id: str) -> dict:
    with closing(store.connect(db_path)) as connection:
        require_schema(connection)
        review_store._binding(connection, window_id)
        return _get(connection, window_id)


def headers(db_path: Path, run_id: str) -> dict[str, dict]:
    with closing(store.connect(db_path)) as connection:
        require_schema(connection)
        rows = connection.execute("""SELECT q.window_id,q.value_json,EXISTS(SELECT 1 FROM qa_event AS e WHERE e.window_id=q.window_id
            AND json_extract(e.after_json,'$.decision')='disagree') AS has_disagreement FROM qa_window AS q WHERE q.run_id=?""", (run_id,)).fetchall()
    return {row[0]: {**{key: value for key, value in json.loads(row[1]).items()
                     if key not in {"note", "suggestion", "verification"}}, "has_disagreement": bool(row[2])} for row in rows}


def observation_revisions(connection: sqlite3.Connection, window_id: str) -> dict[str, int]:
    rows = connection.execute("""SELECT observation_id,MAX(revision) FROM review_event
        WHERE window_id=? AND action IN ('add_observation','update_observation') GROUP BY observation_id""",
        (window_id,)).fetchall()
    return dict(rows)


def normalized_actor(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).split()).casefold()


def apply(db_path: Path, window_id: str, change: dict, fingerprint: str,
          verification: dict | None) -> dict:
    """Commit only against the exact QA, first-review and evidence revisions read."""
    actor = review_store._text(change["actor"], "QA reviewer label", 120, required=True)
    decision = "pending" if change["action"] == "retract" else change["decision"]
    if change["action"] not in {"set_decision", "retract"} or decision not in DECISIONS | {"pending"} or change["confirmed"] is not True:
        raise QAError("qa_invalid", "Confirm an explicit supported QA action.", 422)
    note = review_store._text(change["note"], "QA rationale", 2000, required=decision != "agree")
    for key in ("expected_revision", "expected_first_review_revision", "expected_evidence_revision"):
        if type(change[key]) is not int or not 0 <= change[key] < 2 ** 31:
            raise QAError("qa_invalid", "Provide bounded exact QA and baseline revisions.", 422)
    try:
        with closing(store.connect(db_path)) as connection, connection:
            connection.execute("PRAGMA busy_timeout=1000")
            connection.execute("BEGIN IMMEDIATE")
            require_schema(connection)
            binding = review_store._binding(connection, window_id)
            first = review_store._projection(connection.execute("SELECT * FROM review_window WHERE window_id=?", (window_id,)).fetchone())
            old = _get(connection, window_id)
            if (old["revision"] != change["expected_revision"] or first["revision"] != change["expected_first_review_revision"]
                    or binding["evidence_revision"] != change["expected_evidence_revision"]):
                raise conflict()
            if decision == "pending" and old["revision"] == 0:
                raise QAError("qa_invalid", "There is no saved QA action to retract.", 422)
            if first["actor"] and normalized_actor(first["actor"]) == normalized_actor(actor):
                raise QAError("qa_same_actor", "Independent QA must use a different normalized first-review label. Labels alone do not prove different humans.", 422)
            if decision in {"agree", "disagree", "needs_clarification"}:
                if first["decision"] == "unreviewed" or (first["verification"] or {}).get("fingerprint") != fingerprint:
                    raise QAError("qa_unavailable", "A current valid first review is required for this QA decision.", 409)
                if decision in {"agree", "disagree"} and not verification:
                    raise QAError("qa_unavailable", "A current verified original preview is required.", 409)
            suggestion = change["suggestion"]
            if suggestion is not None:
                if decision not in {"disagree", "needs_clarification"}:
                    raise QAError("qa_invalid", "Observation suggestions accompany disagreement or clarification only.", 422)
                revisions = observation_revisions(connection, window_id)
                original = next((item for item in first["observations"] if item["id"] == suggestion["observation_id"]), None)
                if original is None or revisions.get(original["id"]) != suggestion["observation_revision"]:
                    raise conflict()
                suggestion = {**suggestion, "original_observation": original}
            new = {"revision": old["revision"] + 1, "decision": decision, "note": note,
                   "suggestion": suggestion, "actor": actor, "updated_at_utc": datetime.now(timezone.utc).isoformat(),
                   "first_review_revision": first["revision"], "evidence_revision": binding["evidence_revision"],
                   "fingerprint": fingerprint, "verification": verification}
            public_binding = {key: value for key, value in binding.items() if key != "source_snapshot"}
            connection.execute("""INSERT INTO qa_event VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (window_id, binding["run_id"], new["revision"], new["updated_at_utc"], actor, change["action"],
                 first["revision"], binding["evidence_revision"], json.dumps(public_binding), json.dumps(old), json.dumps(new)))
            connection.execute("""INSERT INTO qa_window VALUES (?,?,?,?) ON CONFLICT(window_id) DO UPDATE SET
                revision=excluded.revision,value_json=excluded.value_json""",
                (window_id, binding["run_id"], new["revision"], json.dumps(new)))
            return new
    except sqlite3.OperationalError as error:
        if "locked" in str(error).lower() or "busy" in str(error).lower():
            raise QAError("qa_busy", "The local QA database is busy. Keep your draft and retry.", 409) from None
        raise


def history(db_path: Path, window_id: str, after_revision: int = 0, limit: int = 50) -> dict:
    if type(after_revision) is not int or not 0 <= after_revision < 2 ** 31 or type(limit) is not int or not 1 <= limit <= 50:
        raise QAError("qa_invalid", "QA history requires a bounded cursor and at most 50 events.", 422)
    with closing(store.connect(db_path)) as connection:
        require_schema(connection)
        review_store._binding(connection, window_id)
        rows = connection.execute("SELECT * FROM qa_event WHERE window_id=? AND revision>? ORDER BY revision LIMIT ?",
                                  (window_id, after_revision, limit + 1)).fetchall()
    events = [{"revision": row["revision"], "utc": row["utc"], "actor": row["actor"], "action": row["action"],
               "first_review_revision": row["first_review_revision"], "evidence_revision": row["evidence_revision"],
               **json.loads(row["binding_json"]), "before": json.loads(row["before_json"]),
               "after": json.loads(row["after_json"])} for row in rows[:limit]]
    return {"events": events, "next_after_revision": events[-1]["revision"] if len(rows) > limit else None}
