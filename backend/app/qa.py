"""Independent human QA, reusing the original review evidence/preview validator."""

from __future__ import annotations

from contextlib import closing
import json
import sqlite3
from typing import Literal
from uuid import UUID

from fastapi import Body, Depends, FastAPI, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import Field, ValidationError, model_validator

from . import qa_store, review_store, store, summary_store
from .reviews import Change, MAX_ACTION_BYTES, MAX_REVISION, ReviewService, StrictModel


class Suggestion(StrictModel):
    observation_id: UUID
    observation_revision: int = Field(ge=1, le=MAX_REVISION, strict=True)
    note: str = Field(min_length=1, max_length=2000, strict=True)
    category: Literal["bat", "insect", "bird", "other", "uncertain"] | None
    count: int | None = Field(ge=0, le=100000, strict=True)


class QAChange(Change):
    expected_first_review_revision: int = Field(ge=0, le=MAX_REVISION, strict=True)
    expected_evidence_revision: int = Field(ge=0, le=MAX_REVISION, strict=True)
    action: Literal["set_decision", "retract"]
    decision: Literal["agree", "disagree", "needs_clarification", "unassessable"] | None
    note: str = Field(max_length=2000, strict=True)
    suggestion: Suggestion | None
    preview_id: UUID | None
    confirmed: bool = Field(strict=True)

    @model_validator(mode="after")
    def explicit_action(self):
        if not self.confirmed or (self.action == "retract") != (self.decision is None):
            raise ValueError("Explicitly confirm a QA decision or retraction")
        if self.decision != "agree" and not self.note.strip():
            raise ValueError("A written reason is required")
        if self.suggestion and (self.decision not in {"disagree", "needs_clarification"} or not self.suggestion.note.strip()):
            raise ValueError("Suggestions require disagreement/clarification and a written note")
        if self.action == "retract" and (self.suggestion is not None or self.preview_id is not None):
            raise ValueError("Retraction cannot assert new evidence or suggestions")
        return self


class QAService:
    def __init__(self, reviews: ReviewService):
        self.reviews, self.db_path = reviews, reviews.db_path

    @staticmethod
    def header(projection: dict, first: dict, evidence: dict, row: dict) -> dict:
        unavailable = evidence["warning"] or ("summary_not_complete" if row["status"] != "complete" or not row.get("image_sha256") else None)
        changed = None
        if projection["revision"] and projection["decision"] != "pending":
            if projection["first_review_revision"] != first["revision"]:
                changed = "first_review_changed"
            elif (projection["evidence_revision"] != evidence["evidence_revision"] or projection["fingerprint"] != evidence["fingerprint"]):
                changed = "evidence_changed"
        valid_first = first["effective_decision"] != "unreviewed"
        status = ("unassessable" if unavailable else "pending" if changed else projection["decision"])
        if status in {"agree", "disagree", "needs_clarification"} and not valid_first:
            changed, status = "first_review_requires_verification", "pending"
        return {"revision": projection["revision"], "decision": projection["decision"], "status": status,
                "needs_reverification": changed is not None, "warning": unavailable or changed or (None if valid_first else "first_review_required"),
                "has_disagreement": projection.get("has_disagreement", False),
                "can_decide": not unavailable and valid_first, "current_evidence_revision": evidence["evidence_revision"]}

    def _context(self, window_id: str):
        with closing(store.connect(self.db_path)) as connection:
            qa_store.require_schema(connection)
        private, row = self.reviews._window(window_id)
        first = review_store.get(self.db_path, window_id)
        projection = qa_store.get(self.db_path, window_id)
        with closing(store.connect(self.db_path)) as connection:
            projection["has_disagreement"] = bool(connection.execute("SELECT 1 FROM qa_event WHERE window_id=? AND json_extract(after_json,'$.decision')='disagree' LIMIT 1", (window_id,)).fetchone())
        evidence = self.reviews._evidence(private, row, latch=first["decision"] != "unreviewed" or projection["decision"] != "pending")
        first.update(self.reviews._header(first, evidence))
        return private, row, first, projection, evidence

    def get(self, window_id: str) -> dict:
        _, row, first, projection, evidence = self._context(window_id)
        with closing(store.connect(self.db_path)) as connection:
            revisions = qa_store.observation_revisions(connection, window_id)
        return {**projection, **self.header(projection, first, evidence, row), "window_id": window_id, "run_id": row["run_id"],
                "binding": {**evidence["binding"], "evidence_revision": evidence["evidence_revision"]},
                "first_review": {"revision": first["revision"], "actor": first["actor"], "effective_decision": first["effective_decision"],
                                 "observations": [{**item, "revision": revisions[item["id"]]} for item in first["observations"]]}}

    def augment_summary(self, detail: dict) -> dict:
        if store.schema_version(self.db_path) != store.QA_SCHEMA_VERSION:
            return detail
        private = summary_store.private_run(self.db_path, detail["id"])
        rows = {row["id"]: row for row in private["windows"]}
        headers = qa_store.headers(self.db_path, detail["id"])
        counts = dict.fromkeys(("agree", "disagree", "needs_clarification", "pending", "unassessable"), 0)
        needs, sources, plans = 0, {}, {}
        for window in detail["windows"]:
            projection = headers.get(window["id"], qa_store.empty())
            evidence = self.reviews._evidence(private, rows[window["id"]], check_image=projection["decision"] != "pending",
                                              sources=sources, plans=plans, latch=projection["decision"] != "pending")
            header = self.header(projection, window["review"], evidence, rows[window["id"]])
            window["qa"] = header
            counts[header["status"]] += 1
            needs += header["needs_reverification"]
        total = private["run"]["expected_windows"]
        # Missing planned rows cannot make administrative coverage look complete.
        counts["pending"] += max(0, total - len(detail["windows"]))
        detail["qa_progress"] = {"total": total, **counts, "needs_reverification": needs}
        return detail

    def save(self, window_id: str, change: dict | QAChange) -> dict:
        if isinstance(change, dict):
            try:
                change = QAChange.model_validate(change)
            except ValidationError:
                raise qa_store.QAError("qa_invalid", "Provide exactly the supported confirmed QA action fields and written rationale.", 422) from None
        payload = change.model_dump(mode="json")
        if len(json.dumps(payload, ensure_ascii=False).encode()) > MAX_ACTION_BYTES:
            raise qa_store.QAError("qa_invalid", "QA actions must not exceed 8 KiB.", 413)
        if not self.reviews.activity_lock.acquire(blocking=False):
            raise qa_store.QAError("qa_busy", "An active media/review operation is running. Keep your QA draft and retry.", 409)
        try:
            private, row, first, projection, evidence = self._context(window_id)
            if (projection["revision"] != payload["expected_revision"] or first["revision"] != payload["expected_first_review_revision"]
                    or evidence["evidence_revision"] != payload["expected_evidence_revision"]):
                raise qa_store.conflict()
            if private["run"]["state"] in {"queued", "running"}:
                raise qa_store.QAError("qa_busy", "Wait for the summary run to stop before QA.", 409)
            header = self.header(projection, first, evidence, row)
            verification = None
            if payload["decision"] in {"agree", "disagree", "needs_clarification"}:
                if not header["can_decide"]:
                    raise qa_store.QAError("qa_unavailable", "Current complete evidence and a valid first review are required. Record an unassessable note instead.", 409)
                if payload["decision"] in {"agree", "disagree"}:
                    verification = self.reviews._receipt(payload["preview_id"], row, evidence)
            qa_store.apply(self.db_path, window_id, payload, evidence["fingerprint"], verification)
            return self.get(window_id)
        finally:
            self.reviews.activity_lock.release()


def install_routes(app: FastAPI, service: QAService, authenticate) -> None:
    @app.post("/api/qa/upgrade", dependencies=[Depends(authenticate)])
    def upgrade(_payload: StrictModel = Body(default_factory=StrictModel)) -> dict:
        if not service.reviews.activity_lock.acquire(blocking=False):
            raise qa_store.QAError("qa_busy", "Wait for the active operation before upgrading QA storage.", 409)
        try:
            qa_store.upgrade(service.db_path)
        except (store.DatabaseSchemaError, sqlite3.DatabaseError):
            raise qa_store.QAError("qa_upgrade_failed", "QA schema upgrade failed; the existing database was preserved.", 409) from None
        finally:
            service.reviews.activity_lock.release()
        return {"schema_version": store.QA_SCHEMA_VERSION}

    @app.get("/api/summary-windows/{window_id}/qa", dependencies=[Depends(authenticate)])
    def get(window_id: UUID) -> dict:
        return service.get(str(window_id))

    @app.post("/api/summary-windows/{window_id}/qa-actions", dependencies=[Depends(authenticate)])
    async def save(window_id: UUID, request: Request) -> dict:
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > MAX_ACTION_BYTES:
                raise qa_store.QAError("qa_invalid", "QA actions must not exceed 8 KiB.", 413)
            raw.extend(chunk)
        try:
            change = QAChange.model_validate_json(bytes(raw))
        except ValidationError:
            raise qa_store.QAError("qa_invalid", "Provide exactly the supported confirmed QA action fields.", 422) from None
        return await run_in_threadpool(service.save, str(window_id), change)

    @app.get("/api/summary-windows/{window_id}/qa-history", dependencies=[Depends(authenticate)])
    def history(window_id: UUID, after_revision: int = Query(default=0, ge=0, le=MAX_REVISION)) -> dict:
        return qa_store.history(service.db_path, str(window_id), after_revision)
