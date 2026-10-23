"""Gate and count routes (feature expansion E3). All writes are explicit, attributed and optimistic."""

from __future__ import annotations

from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import Depends, FastAPI
from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import count_store, store

Text = Field(min_length=1, max_length=60)


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GateValue(Strict):
    name: str = Text
    kind: Literal["line", "rect", "polygon"]
    points: list[tuple[float, float]] = Field(min_length=2, max_length=32)
    frame_w: int = Field(ge=1, le=8192)
    frame_h: int = Field(ge=1, le=8192)
    label_a: str = Text
    label_b: str = Text
    entry_direction: Literal["A_to_B", "B_to_A", "out_to_in"]
    hysteresis_px: float = Field(ge=0, le=200)

    @model_validator(mode="after")
    def entry_matches_kind(self) -> GateValue:
        if (self.kind == "line") != (self.entry_direction in ("A_to_B", "B_to_A")):
            raise ValueError("A line enters A_to_B or B_to_A; an area enters out_to_in")
        return self


class GateChange(Strict):
    actor: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)
    value: GateValue | None


class ReviewAction(Strict):
    actor: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)
    action: Literal["confirm", "reject", "clear", "add_missed"]
    key: UUID | None = None
    flipped: bool = False
    count: int = Field(default=1, ge=0, le=10000)
    direction: Literal["A_to_B", "B_to_A", "out_to_in", "in_to_out"] | None = None
    segment_id: UUID | None = None
    pts: str | None = Field(default=None, pattern=r"^-?\d{1,19}$")
    rationale: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def shape(self) -> ReviewAction:
        if (self.action == "add_missed") != (self.key is None):
            raise ValueError("A missed crossing has no key; other actions name one crossing")
        if self.action == "add_missed" and (self.direction is None or self.segment_id is None or self.pts is None):
            raise ValueError("A missed crossing needs its direction, segment and source PTS")
        return self


class QAAction(Strict):
    actor: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)
    review_revision: int = Field(ge=0)
    decision: Literal["approve", "reject"]
    note: str = Field(default="", max_length=2000)


def install_routes(app: FastAPI, db_path: Path, authenticate) -> None:
    @app.get("/api/sessions/{session_id}/gates", dependencies=[Depends(authenticate)])
    def list_gates(session_id: UUID) -> list[dict]:
        return count_store.list_gates(db_path, str(session_id))

    @app.post("/api/sessions/{session_id}/gates", dependencies=[Depends(authenticate)])
    def create_gate(session_id: UUID, change: GateChange) -> dict:
        return count_store.save_gate(db_path, str(session_id), None, change.expected_revision, change.actor,
                                     change.value.model_dump() if change.value else None)

    @app.put("/api/sessions/{session_id}/gates/{gate_id}", dependencies=[Depends(authenticate)])
    def change_gate(session_id: UUID, gate_id: UUID, change: GateChange) -> dict:
        return count_store.save_gate(db_path, str(session_id), str(gate_id), change.expected_revision, change.actor,
                                     change.value.model_dump() if change.value else None)

    @app.get("/api/gates/{gate_id}/history", dependencies=[Depends(authenticate)])
    def gate_history(gate_id: UUID) -> list[dict]:
        count_store.get_gate(db_path, str(gate_id))
        return count_store.gate_history(db_path, str(gate_id))

    @app.get("/api/tracking/{run_id}/gates/{gate_id}/counts", dependencies=[Depends(authenticate)])
    def counts(run_id: UUID, gate_id: UUID) -> dict:
        result = count_store.counts(db_path, str(run_id), str(gate_id))
        result["revision"] = count_store.latest_revision(db_path, str(run_id), str(gate_id))
        return result

    @app.post("/api/tracking/{run_id}/gates/{gate_id}/review", dependencies=[Depends(authenticate)])
    def review(run_id: UUID, gate_id: UUID, action: ReviewAction) -> dict:
        value = action.model_dump(mode="json", exclude={"actor", "expected_revision"})
        result = count_store.record(db_path, str(run_id), str(gate_id), action.actor, action.expected_revision, "review", value)
        result["revision"] = count_store.latest_revision(db_path, str(run_id), str(gate_id))
        return result

    @app.post("/api/tracking/{run_id}/gates/{gate_id}/qa", dependencies=[Depends(authenticate)])
    def qa(run_id: UUID, gate_id: UUID, action: QAAction) -> dict:
        value = action.model_dump(mode="json", exclude={"actor", "expected_revision"})
        result = count_store.record(db_path, str(run_id), str(gate_id), action.actor, action.expected_revision, "qa", value)
        result["revision"] = count_store.latest_revision(db_path, str(run_id), str(gate_id))
        return result

    @app.get("/api/tracking/{run_id}/gates/{gate_id}/history", dependencies=[Depends(authenticate)])
    def history(run_id: UUID, gate_id: UUID) -> list[dict]:
        if store.schema_version(db_path) < store.COUNT_SCHEMA_VERSION:
            return []
        return count_store.history(db_path, str(run_id), str(gate_id))
