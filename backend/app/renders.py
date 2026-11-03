"""Rendered review videos (schema v19, Phase 3 X8): one contained worker per video, one render at a time.

A render records what it was made from (tracking run, gates and review revisions) and the SHA-256 of its file. It is
a derived, provisional deliverable: the original and the database are never changed. A failed or cancelled render
leaves no file; a render interrupted by a restart is marked so.
"""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Literal
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI
from pydantic import BaseModel, ConfigDict

from . import store, workers
from .imports import ImportErrorResponse, source_state
from .proxies import _seconds
from .render_worker import ERRORS as WORKER_ERRORS, MAX_REQUEST_BYTES, MEMORY_BYTES, cpu_seconds

MAX_RESULT_BYTES = 256 * 1024
MESSAGES = {
    "render_busy": "Another video is being rendered. Wait for it or cancel it.",
    "render_missing": "The rendered video does not exist or is not ready.",
    "render_upgrade_required": "Upgrade storage before rendering videos.",
    "render_limit": "The render exceeded a time, memory, frame or size limit. No file was kept.",
    "render_limits_unavailable": "Hard process limits are unavailable on this platform. Only Linux and Windows are supported.",
    "render_failed": "The video could not be rendered. No file was kept.",
    "render_integrity": "The rendered file does not match its recorded hash. Render it again.",
    "tracking_missing": "Render from a completed tracking run of this survey.",
    "tracking_integrity": "Stored track points failed their integrity check.",
    "missing_source": "The original recording is missing.",
    "unreadable_source": "The original recording cannot be read.",
    "changed_source": "The original recording changed since import. Nothing was rendered from different bytes.",
    "unsupported_codec": "The original codec or stream layout cannot be processed reliably.",
    "decode_failed": "The original recording could not be decoded reliably.",
    "unknown_timing": "The recording's timing is unknown, so the render cannot be bounded.",
    "cancelled": "The render was cancelled. No file was kept.",
    "interrupted": "The render was interrupted. Render it again.",
}


class RenderError(ImportErrorResponse):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code, MESSAGES.get(code, MESSAGES["render_failed"]), status)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def upgrade(db_path: Path) -> None:
    """Explicit v18 -> v19 transition."""
    if not db_path.is_file():
        raise store.DatabaseSchemaError("Render upgrade requires an existing version 18 database")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version >= store.RENDER_SCHEMA_VERSION:
            return
        if version != store.SUNSET_SCHEMA_VERSION:
            raise store.DatabaseSchemaError("Render upgrade requires database schema version 18")
        connection.execute("""CREATE TABLE render_job (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES recording_session(id),
            segment_id TEXT NOT NULL REFERENCES segment(id),
            tracking_run_id TEXT NOT NULL REFERENCES tracking_run(id),
            kind TEXT NOT NULL CHECK(kind IN ('overlay','highlights')),
            state TEXT NOT NULL CHECK(state IN ('queued','running','ready','failed','cancelled','interrupted')),
            error_code TEXT,
            result_json TEXT NOT NULL DEFAULT '{}',
            created_utc TEXT NOT NULL,
            finished_utc TEXT
        )""")
        connection.execute(f"PRAGMA user_version={store.RENDER_SCHEMA_VERSION}")


def _row(row) -> dict:
    return {"id": row["id"], "session_id": row["session_id"], "segment_id": row["segment_id"], "tracking_run_id": row["tracking_run_id"],
            "kind": row["kind"], "state": row["state"], "error": row["error_code"], "result": json.loads(row["result_json"]),
            "created_utc": row["created_utc"], "finished_utc": row["finished_utc"]}


class RenderJobs:
    def __init__(self, db_path: Path, data_dir: Path):
        self.db_path = db_path
        self.directory = data_dir / "renders"
        self.directory.mkdir(parents=True, exist_ok=True)
        self._lock, self._cancel = Lock(), Event()
        self._thread: Thread | None = None
        self._process = None
        self._active: str | None = None
        self._closed = False
        if store.schema_version(db_path) >= store.RENDER_SCHEMA_VERSION:
            with closing(store.connect(db_path)) as connection, connection:
                stale = [row[0] for row in connection.execute("SELECT id FROM render_job WHERE state IN ('queued','running')")]
                connection.execute("UPDATE render_job SET state='interrupted', error_code='interrupted', finished_utc=? WHERE state IN ('queued','running')", (_now(),))
            for render_id in stale:
                self._remove(render_id)

    def path(self, render_id: str) -> Path:
        return self.directory / f"{render_id}.webm"

    def _progress_path(self, render_id: str) -> Path:
        return self.directory / f"{render_id}.progress"

    def _remove(self, render_id: str) -> None:
        self.path(render_id).unlink(missing_ok=True)
        self._progress_path(render_id).unlink(missing_ok=True)

    def _require(self) -> None:
        if store.schema_version(self.db_path) < store.RENDER_SCHEMA_VERSION:
            raise RenderError("render_upgrade_required")

    def list(self, session_id: str) -> list[dict]:
        if store.schema_version(self.db_path) < store.RENDER_SCHEMA_VERSION:
            return []
        with closing(store.connect(self.db_path)) as connection:
            rows = connection.execute("SELECT * FROM render_job WHERE session_id=? ORDER BY created_utc DESC, rowid DESC", (session_id,)).fetchall()
        result = [_row(row) for row in rows]
        for item in result:
            if item["state"] == "running" and item["id"] == self._active:
                try:
                    done, total = self._progress_path(item["id"]).read_text().split("/")
                    item["progress"] = [int(done), int(total)]
                except (OSError, ValueError):
                    item["progress"] = None
        return result

    def get(self, render_id: str) -> dict:
        self._require()
        with closing(store.connect(self.db_path)) as connection:
            row = connection.execute("SELECT * FROM render_job WHERE id=?", (render_id,)).fetchone()
        if row is None:
            raise RenderError("render_missing", 404)
        return _row(row)

    def ready(self, render_id: str) -> tuple[dict, Path]:
        """A ready render whose file still matches its recorded hash."""
        item = self.get(render_id)
        path = self.path(render_id)
        if item["state"] != "ready" or not path.is_file():
            raise RenderError("render_missing", 404)
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != item["result"].get("sha256"):
            raise RenderError("render_integrity")
        return item, path

    def start(self, session_id: str, segment_id: str, tracking_run_id: str, kind: str) -> dict:
        if not workers.supported():
            raise RenderError("render_limits_unavailable")
        self._require()
        segment = store.segment_by_id(self.db_path, segment_id)
        with closing(store.connect(self.db_path)) as connection:
            run = connection.execute("SELECT * FROM tracking_run WHERE id=? AND session_id=? AND state='complete'", (tracking_run_id, session_id)).fetchone()
        if segment is None or segment["session_id"] != session_id or run is None:
            raise RenderError("tracking_missing", 404)
        with self._lock:
            if self._closed or self._active is not None:
                raise RenderError("render_busy")
            render_id = str(uuid4())
            with closing(store.connect(self.db_path)) as connection, connection:
                connection.execute("INSERT INTO render_job (id, session_id, segment_id, tracking_run_id, kind, state, created_utc) VALUES (?,?,?,?,?,'queued',?)",
                                   (render_id, session_id, segment_id, tracking_run_id, kind, _now()))
            self._active, self._cancel = render_id, Event()
            self._thread = Thread(target=self._run, args=(render_id, segment, dict(run), kind, self._cancel), daemon=True)
            self._thread.start()
        return self.get(render_id)

    def _set_process(self, process) -> None:
        with self._lock:
            self._process = process

    def _finish(self, render_id: str, state: str, code: str | None, value: dict | None) -> None:
        with closing(store.connect(self.db_path)) as connection, connection:
            connection.execute("UPDATE render_job SET state=?, error_code=?, result_json=?, finished_utc=? WHERE id=?",
                               (state, code, json.dumps(value or {}), _now(), render_id))

    def _run(self, render_id: str, segment: dict, run: dict, kind: str, cancelled: Event) -> None:
        code, value = "render_failed", None
        try:
            state = source_state(segment)
            if state != "ready":
                code = state
                return
            cpu = cpu_seconds(_seconds(json.loads(segment["metadata_json"])))
            with closing(store.connect(self.db_path)) as connection, connection:
                connection.execute("UPDATE render_job SET state='running' WHERE id=?", (render_id,))
            payload = {"parent_pid": os.getpid(), "db_path": str(self.db_path), "segment_id": segment["id"], "tracking_run_id": run["id"],
                       "algorithm_version": run["algorithm_version"], "parameter_hash": run["parameter_hash"], "kind": kind, "render_id": render_id,
                       "output_path": str(self.path(render_id)), "progress_path": str(self._progress_path(render_id)), "cpu_seconds": cpu}
            status, body = workers.supervise("render_worker", payload, cancelled.is_set, 2 * cpu, MEMORY_BYTES, cpu,
                                             MAX_REQUEST_BYTES, MAX_RESULT_BYTES, self._set_process)
            if status == "ok" and isinstance(body, dict) and set(body) == {"error", "value"}:
                code, value = body["error"], body["value"]
                if code is not None and code not in WORKER_ERRORS:
                    code = "render_failed"
            else:
                code = {"cancelled": "cancelled", "limit": "render_limit"}.get(status, "render_failed")
        except ValueError as error:
            code = str(error) if str(error) in MESSAGES else "render_failed"
        except Exception:
            code = "render_failed"
        finally:
            code = "cancelled" if cancelled.is_set() or self._closed else code
            state = "ready" if code is None else "cancelled" if code == "cancelled" else "failed"
            self._progress_path(render_id).unlink(missing_ok=True)
            if state != "ready":
                self.path(render_id).unlink(missing_ok=True)
            self._finish(render_id, state, code, value)
            with self._lock:
                self._active, self._process = None, None

    def cancel(self, render_id: str) -> dict:
        with self._lock:
            if self._active == render_id:
                self._cancel.set()
                if self._process is not None:
                    try:
                        self._process.kill()
                    except ProcessLookupError:
                        pass
        return self.get(render_id)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._cancel.set()
            thread = self._thread
        if thread is not None:
            thread.join(timeout=10)


class RenderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: UUID
    segment_id: UUID
    tracking_run_id: UUID
    kind: Literal["overlay", "highlights"]


def install_routes(app: FastAPI, jobs: RenderJobs, authenticate) -> None:
    @app.post("/api/renders", status_code=202, dependencies=[Depends(authenticate)])
    def start(payload: RenderRequest) -> dict:
        return jobs.start(str(payload.session_id), str(payload.segment_id), str(payload.tracking_run_id), payload.kind)

    @app.get("/api/renders", dependencies=[Depends(authenticate)])
    def list_renders(session_id: UUID) -> list[dict]:
        return jobs.list(str(session_id))

    @app.get("/api/renders/{render_id}", dependencies=[Depends(authenticate)])
    def get(render_id: UUID) -> dict:
        return jobs.get(str(render_id))

    @app.post("/api/renders/{render_id}/cancel", dependencies=[Depends(authenticate)])
    def cancel(render_id: UUID) -> dict:
        return jobs.cancel(str(render_id))

    @app.get("/api/renders/{render_id}/file", dependencies=[Depends(authenticate)])
    def file(render_id: UUID) -> dict:
        """The verified file's name inside the data folder, for the desktop shell to copy where the user chooses."""
        item, path = jobs.ready(str(render_id))
        return {"id": item["id"], "file_name": path.name, "bytes": item["result"]["bytes"], "sha256": item["result"]["sha256"]}
