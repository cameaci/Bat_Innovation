"""Emergence profile and flow metrics of one gate, and the survey's typed sunset (schema v18, Phase 3 X7).

The profile bins each count layer's crossings per minute of each video (entries and exits), and reports first and last
exit, the peak minute and the busiest second. Time after sunset is given only for crossings in the video that carries
the declared recording clock, with the sunset the reviewer typed for that clock's date: no sunset is computed and no
clock is extended to other videos. Everything here is derived from the count layers and never changes them.
"""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timedelta, timezone
from fractions import Fraction
import json
from pathlib import Path
import re

from . import store
from .imports import ImportErrorResponse

# Local sunset with its UTC offset, e.g. 21:04+01:00: the declared clock is stored in UTC, so the zone must be explicit.
SUNSET = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)([+-])(0\d|1[0-4]):([0-5]\d)$")


class SunsetError(ImportErrorResponse):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(code, message, status)


def upgrade(db_path: Path) -> None:
    """Explicit v17 -> v18 transition."""
    if not db_path.is_file():
        raise store.DatabaseSchemaError("Sunset upgrade requires an existing version 17 database")
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version >= store.SUNSET_SCHEMA_VERSION:
            return
        if version != store.LABEL_SCHEMA_VERSION:
            raise store.DatabaseSchemaError("Sunset upgrade requires database schema version 17")
        connection.execute("""CREATE TABLE sunset_event (
            session_id TEXT NOT NULL REFERENCES recording_session(id),
            revision INTEGER NOT NULL CHECK(revision > 0),
            actor TEXT NOT NULL,
            sunset TEXT NOT NULL,
            source TEXT NOT NULL,
            utc TEXT NOT NULL,
            PRIMARY KEY(session_id, revision)
        )""")
        for operation in ("UPDATE", "DELETE"):
            connection.execute(f"""CREATE TRIGGER sunset_event_no_{operation.lower()} BEFORE {operation} ON sunset_event
                BEGIN SELECT RAISE(ABORT, 'append-only'); END""")
        connection.execute(f"PRAGMA user_version={store.SUNSET_SCHEMA_VERSION}")


def sunset(db_path: Path, session_id: str) -> dict | None:
    """The latest typed sunset of a survey (local time with its UTC offset, on the declared clock's evening), or None; an empty entry clears it."""
    if store.schema_version(db_path) < store.SUNSET_SCHEMA_VERSION:
        return None
    with closing(store.connect(db_path)) as connection:
        row = connection.execute("SELECT * FROM sunset_event WHERE session_id=? ORDER BY revision DESC LIMIT 1", (session_id,)).fetchone()
    if row is None or not row["sunset"]:
        return None
    return {"sunset": row["sunset"], "source": row["source"], "actor": row["actor"], "revision": row["revision"], "utc": row["utc"]}


def set_sunset(db_path: Path, session_id: str, actor: str, value: str, source: str) -> dict | None:
    if store.schema_version(db_path) < store.SUNSET_SCHEMA_VERSION:
        raise SunsetError("sunset_upgrade_required", "Upgrade storage before entering a sunset time.")
    actor, source = " ".join(actor.split()), " ".join(source.split())
    if not actor or (value and (not SUNSET.match(value) or not source)):
        raise SunsetError("sunset_invalid", "Enter your name, the local sunset as HH:MM with its UTC offset (for example 21:04+01:00) and where it comes from.", 422)
    with closing(store.connect(db_path)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        if connection.execute("SELECT 1 FROM recording_session WHERE id=?", (session_id,)).fetchone() is None:
            raise SunsetError("session_missing", "The survey does not exist.", 404)
        latest = connection.execute("SELECT COALESCE(MAX(revision), 0) FROM sunset_event WHERE session_id=?", (session_id,)).fetchone()[0]
        connection.execute("INSERT INTO sunset_event VALUES (?,?,?,?,?,?)", (session_id, latest + 1, actor, value, source if value else "",
                           datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")))
    return sunset(db_path, session_id)


def _clock(anchor: dict | None, segments: dict[str, dict]):
    """Seconds from the anchored video's first frame to wall time, or None when no usable declared clock exists."""
    if not anchor or not anchor.get("provenance", "").strip() or anchor.get("segment_id") not in segments:
        return None
    metadata = segments[anchor["segment_id"]]
    try:
        origin = datetime.fromisoformat(anchor["utc"])
    except (ValueError, KeyError):
        return None
    if origin.tzinfo is None or anchor.get("source_pts") != metadata["first_pts"]:
        return None
    return anchor["segment_id"], origin


def _layer(items: list[tuple[str, int, str, int]], entry: str, segments: dict[str, dict], order: list[str]) -> dict:
    bins: dict[tuple[str, int], list[int]] = {}
    seconds: dict[tuple[str, int], int] = {}
    exits: list[tuple[int, Fraction, str]] = []
    for direction, count, segment_id, pts in items:
        metadata = segments.get(segment_id)
        if metadata is None:
            continue
        base = Fraction(int(metadata["time_base"]["num"]), int(metadata["time_base"]["den"]))
        elapsed = (int(pts) - int(metadata["first_pts"])) * base
        key = (segment_id, int(elapsed // 60))
        cell = bins.setdefault(key, [0, 0])
        if direction == entry:
            cell[0] += count
        else:
            cell[1] += count
            seconds[(segment_id, int(elapsed))] = seconds.get((segment_id, int(elapsed)), 0) + count
            exits.append((order.index(segment_id), elapsed, segment_id))
    rows = [{"segment_id": segment_id, "minute": minute, "entered": cell[0], "exited": cell[1]}
            for (segment_id, minute), cell in sorted(bins.items(), key=lambda item: (order.index(item[0][0]), item[0][1]))]
    exits.sort()
    point = lambda item: {"segment_id": item[2], "seconds": round(float(item[1]), 3)}
    peak = max(rows, key=lambda row: row["exited"], default=None)
    return {"bins": rows, "first_exit": point(exits[0]) if exits else None, "last_exit": point(exits[-1]) if exits else None,
            "peak_minute": {"segment_id": peak["segment_id"], "minute": peak["minute"], "exited": peak["exited"]} if peak and peak["exited"] else None,
            "peak_exits_per_second": max(seconds.values(), default=0)}


def profile(db_path: Path, gate: dict, algorithm: list, reviewed: list, qa_current: bool) -> dict:
    """Per-minute bins and flow metrics for the algorithm and reviewer layers (QA only when approved and current)."""
    with closing(store.connect(db_path)) as connection:
        rows = connection.execute("SELECT id, metadata_json FROM segment WHERE session_id=? ORDER BY position", (gate["session_id"],)).fetchall()
    segments = {row["id"]: json.loads(row["metadata_json"]) for row in rows}
    order = [row["id"] for row in rows]
    entry = gate["entry_direction"]
    layers = {"algorithm": _layer(algorithm, entry, segments, order), "reviewer": _layer(reviewed, entry, segments, order)}
    layers["qa"] = layers["reviewer"] if qa_current else None
    typed = sunset(db_path, gate["session_id"])
    clock = _clock(store.clock_anchor(db_path, gate["session_id"]), segments)
    after = None
    if typed and clock:
        anchored, origin = clock
        hour, minute, sign, offset_hours, offset_minutes = SUNSET.match(typed["sunset"]).groups()
        zone = timezone((1 if sign == "+" else -1) * timedelta(hours=int(offset_hours), minutes=int(offset_minutes)))
        sunset_at = origin.astimezone(zone).replace(hour=int(hour), minute=int(minute), second=0, microsecond=0)

        def minutes(point: dict | None, extra: float = 0) -> float | None:
            if point is None or point["segment_id"] != anchored:
                return None
            moment = origin + timedelta(seconds=point.get("seconds", 0) + extra)
            difference = (moment - sunset_at).total_seconds()
            # The typed time is the evening of the clock's date; a clock started after midnight refers to the day before.
            if difference > 12 * 3600:
                difference -= 24 * 3600
            elif difference < -12 * 3600:
                difference += 24 * 3600
            return round(difference / 60, 1)

        after = {name: {"first_exit": minutes(layer["first_exit"]),
                        "peak_minute": minutes({"segment_id": layer["peak_minute"]["segment_id"], "seconds": 0}, layer["peak_minute"]["minute"] * 60)
                        if layer["peak_minute"] else None}
                 for name, layer in layers.items() if layer is not None}
    return {"layers": layers, "sunset": typed, "clock_segment_id": clock[0] if clock else None, "minutes_after_sunset": after,
            "note": "Per minute of each video; time after sunset only in the video with the declared recording clock."}
