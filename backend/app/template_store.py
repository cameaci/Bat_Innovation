"""Site templates (schema v15, Phase 3 X4): a camera view's search areas, exclusions, gates and tracking settings,
saved by name so a site can be set up the same way next season (practitioners keep the counting box for year-to-year
replication). A template holds geometry and settings only, never media. Gates placed from a template keep its ID and
count nothing until a reviewer confirms they still sit on the roost in the new view.
"""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
from uuid import uuid4

from . import count_store, gates, store
from .imports import ImportErrorResponse

FORMAT = "bat-site-template-v1"


class TemplateError(ImportErrorResponse):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(code, message, status)


def upgrade(db_path: Path) -> None:
    """Explicit v14 -> v15 transition."""
    if not db_path.is_file():
        raise store.DatabaseSchemaError("Site template upgrade requires an existing version 14 database")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version >= store.TEMPLATE_SCHEMA_VERSION:
            return
        if version != store.SAMPLE_CHECK_SCHEMA_VERSION:
            raise store.DatabaseSchemaError("Site template upgrade requires database schema version 14")
        connection.execute("""CREATE TABLE site_template (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            frame_w INTEGER NOT NULL,
            frame_h INTEGER NOT NULL,
            value_json TEXT NOT NULL,
            actor TEXT NOT NULL,
            utc TEXT NOT NULL,
            retired_utc TEXT
        )""")
        connection.execute(f"PRAGMA user_version={store.TEMPLATE_SCHEMA_VERSION}")


def _require(db_path: Path) -> None:
    if store.schema_version(db_path) < store.TEMPLATE_SCHEMA_VERSION:
        raise TemplateError("template_upgrade_required", "Upgrade storage before saving site templates.")


def _checked(value: dict) -> dict:
    """Settings must be valid for the current tracker and every gate must be drawable on the template's frame."""
    try:
        from .counts import GateValue
        from .tracking import TrackingSettings

        TrackingSettings.model_validate(value["settings"]).checked()
        if len(value["gates"]) > 16:
            raise ValueError("A template holds at most 16 gates.")
        for gate in value["gates"]:
            GateValue.model_validate(gate)
            if (gate["frame_w"], gate["frame_h"]) != (value["frame_w"], value["frame_h"]):
                raise ValueError("A gate was drawn on a different frame size.")
            gates.validate(gate)
    except (ValueError, KeyError, TypeError, ImportErrorResponse):
        raise TemplateError("template_invalid", "The template's settings or gates are not valid for this version.", 422) from None
    return value


def save(db_path: Path, name: str, actor: str, frame_w: int, frame_h: int, settings: dict, gate_values: list[dict]) -> dict:
    _require(db_path)
    name, actor = " ".join(name.split()), " ".join(actor.split())
    if not name or not actor:
        raise TemplateError("template_invalid", "Give the template a name and enter your name.", 422)
    value = _checked({"frame_w": frame_w, "frame_h": frame_h, "settings": settings,
                      "gates": [{key: gate[key] for key in gate if key != "template_id"} for gate in gate_values]})
    row = {"id": str(uuid4()), "name": name, "actor": actor, "utc": datetime.now(timezone.utc).isoformat()}
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("INSERT INTO site_template (id, name, frame_w, frame_h, value_json, actor, utc) VALUES (?,?,?,?,?,?,?)",
                           (row["id"], name, frame_w, frame_h, json.dumps(value), actor, row["utc"]))
    return get(db_path, row["id"])


def get(db_path: Path, template_id: str) -> dict:
    _require(db_path)
    with closing(store.connect(db_path)) as connection:
        row = connection.execute("SELECT * FROM site_template WHERE id=?", (template_id,)).fetchone()
    if row is None:
        raise TemplateError("template_missing", "The site template does not exist.", 404)
    value = json.loads(row["value_json"])
    return {"format": FORMAT, "id": row["id"], "name": row["name"], "actor": row["actor"], "utc": row["utc"],
            "retired": row["retired_utc"] is not None, "frame_w": row["frame_w"], "frame_h": row["frame_h"],
            "settings": value["settings"], "gates": value["gates"]}


def list_templates(db_path: Path) -> list[dict]:
    if store.schema_version(db_path) < store.TEMPLATE_SCHEMA_VERSION:
        return []
    with closing(store.connect(db_path)) as connection:
        ids = [row["id"] for row in connection.execute("SELECT id FROM site_template WHERE retired_utc IS NULL ORDER BY utc DESC")]
    return [get(db_path, template_id) for template_id in ids]


def retire(db_path: Path, template_id: str) -> dict:
    get(db_path, template_id)
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("UPDATE site_template SET retired_utc=? WHERE id=? AND retired_utc IS NULL",
                           (datetime.now(timezone.utc).isoformat(), template_id))
    return get(db_path, template_id)


def apply(db_path: Path, template_id: str, session_id: str, actor: str, frame_w: int, frame_h: int) -> dict:
    """Place the template's gates in a survey. A different frame size is refused, never rescaled; every placed gate
    carries the template ID and waits for one reconfirmation. The settings are returned for the setup panel."""
    template = get(db_path, template_id)
    if template["retired"]:
        raise TemplateError("template_missing", "The site template was retired.", 404)
    if (frame_w, frame_h) != (template["frame_w"], template["frame_h"]):
        raise TemplateError("template_frame", f"The template was made for {template['frame_w']} x {template['frame_h']} video; this survey is {frame_w} x {frame_h}.")
    placed = [count_store.save_gate(db_path, session_id, None, 0, actor, {**gate, "template_id": template_id}) for gate in template["gates"]]
    return {"template": template, "gates": placed}


def from_file(db_path: Path, data: dict, actor: str) -> dict:
    """Import a template exported from another computer (geometry and settings only)."""
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise TemplateError("template_invalid", "This is not a Bat Innovation site template file.", 422)
    try:
        return save(db_path, str(data["name"]), actor, int(data["frame_w"]), int(data["frame_h"]), dict(data["settings"]), list(data["gates"]))
    except (KeyError, TypeError, ValueError):
        raise TemplateError("template_invalid", "The template file is incomplete.", 422) from None
