"""Counting-gate geometry with hysteresis (feature expansion E3). Pure functions, source pixel coordinates.

A line gate has side A on the left of its first-to-last point direction and side B on the right. An area gate
(rectangle or polygon) has inside and outside. A point is only *confirmed* on a side when it is at least
`hysteresis` pixels from the boundary, so jitter on the boundary never produces a crossing. A crossing is the
first confirmed point on the new side; for a line, the path between the last confirmed point on the old side and
that point must also intersect the drawn line segment, so passing beyond its ends is not counted.
"""

from __future__ import annotations

from math import hypot

ALGORITHM_VERSION = "gate-hysteresis-v1"
DIRECTIONS = {"line": ("A_to_B", "B_to_A"), "area": ("out_to_in", "in_to_out")}

Point = tuple[float, float]


def _segment_distance(p: Point, a: Point, b: Point) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
    return hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def _cross(o: Point, a: Point, b: Point) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _intersects(p1: Point, p2: Point, q1: Point, q2: Point) -> bool:
    d1, d2 = _cross(q1, q2, p1), _cross(q1, q2, p2)
    d3, d4 = _cross(p1, p2, q1), _cross(p1, p2, q2)
    return (d1 * d2 <= 0) and (d3 * d4 <= 0) and not (d1 == d2 == 0)


def _inside(p: Point, polygon: list[Point]) -> bool:
    inside = False
    j = len(polygon) - 1
    for i, (xi, yi) in enumerate(polygon):
        xj, yj = polygon[j]
        if (yi > p[1]) != (yj > p[1]) and p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _edges(points: list[Point], closed: bool) -> list[tuple[Point, Point]]:
    pairs = list(zip(points, points[1:]))
    return pairs + [(points[-1], points[0])] if closed else pairs


def side(p: Point, gate: dict) -> int:
    """+1 (side A or inside), -1 (side B or outside) or 0 when within the hysteresis band."""
    points = [tuple(item) for item in gate["points"]]
    h = gate["hysteresis_px"]
    if gate["kind"] == "line":
        a, b = points[0], points[-1]
        length = hypot(b[0] - a[0], b[1] - a[1])
        signed = _cross(a, b, p) / length
        # Image y grows downwards, so a positive cross product is on the visual right; A is the visual left.
        return -1 if signed >= h else 1 if signed <= -h else 0
    distance = min(_segment_distance(p, a, b) for a, b in _edges(points, True))
    if distance < h:
        return 0
    return 1 if _inside(p, points) else -1


def crossings(track: list[tuple[int, float, float]], gate: dict) -> list[tuple[int, str]]:
    """(source PTS, direction) for each confirmed side change along one track."""
    kind = "line" if gate["kind"] == "line" else "area"
    forward, backward = DIRECTIONS[kind]
    points = [tuple(item) for item in gate["points"]]
    result: list[tuple[int, str]] = []
    confirmed = 0
    anchor: Point | None = None
    for pts, x, y in track:
        current = side((x, y), gate)
        if current == 0:
            continue
        if confirmed and current != confirmed:
            if kind == "area" or _intersects(anchor, (x, y), points[0], points[-1]):
                if kind == "line":
                    result.append((pts, forward if confirmed == 1 else backward))
                else:
                    result.append((pts, forward if current == 1 else backward))
        confirmed, anchor = current, (x, y)
    return result


def validate(gate: dict) -> None:
    """Reject geometry that cannot define a gate (degenerate, out of frame or self-overlapping band)."""
    points = gate["points"]
    if gate["kind"] == "line" and len(points) != 2:
        raise ValueError("A line gate needs exactly two points.")
    if gate["kind"] == "rect" and len(points) != 4:
        raise ValueError("A rectangle gate needs four corners.")
    if gate["kind"] == "polygon" and not 3 <= len(points) <= 32:
        raise ValueError("A polygon gate needs 3 to 32 points.")
    if any(not (0 <= x <= gate["frame_w"] and 0 <= y <= gate["frame_h"]) for x, y in points):
        raise ValueError("Gate points must lie inside the video frame.")
    if gate["kind"] == "line" and hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]) < 2 * gate["hysteresis_px"] + 1:
        raise ValueError("The line is too short for its hysteresis band.")
    if gate["kind"] != "line":
        area = abs(sum(_cross((0.0, 0.0), tuple(a), tuple(b)) for a, b in _edges(points, True))) / 2
        if area < (2 * gate["hysteresis_px"] + 1) ** 2:
            raise ValueError("The area is too small for its hysteresis band.")
