"""Burnt-in review overlay for rendered videos (Phase 3 X8): the same marks as the Watch page, drawn with Pillow.

Rings with a one-second trail and the track number for every non-noise track at the frame, every active gate in its
colour (grey and dashed while paused), a circle where a crossing met the gate in the last 1.5 s, one count row per gate
(the reviewer layer as it stands: proposed and not rejected, or decided as a bat; undecided crossings are listed
apart), the clock and a fixed PROVISIONAL watermark. Rendered videos are derived, provisional review aids.
"""

from __future__ import annotations

from bisect import bisect_right
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont

WATERMARK = "PROVISIONAL - algorithm and review state at export, not final counts"
TRACK_COLOURS = ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#4C9BE8", "#D55E00", "#CC79A7", "#FFFFFF"]
GATE_COLOURS = ["#facc15", "#34d399", "#f472b6", "#60a5fa", "#fb923c", "#a78bfa"]
IN_COLOUR, OUT_COLOUR, UNDECIDED = "#22d3ee", "#e879f9", "#f59e0b"
FLIP = {"A_to_B": "B_to_A", "B_to_A": "A_to_B", "out_to_in": "in_to_out", "in_to_out": "out_to_in"}


@lru_cache(maxsize=8)
def font(size: int) -> ImageFont.ImageFont:
    return ImageFont.load_default(size=size)


class Track:
    """One track's points (source PTS, x, y, area) for per-frame lookup."""

    def __init__(self, record: dict):
        self.index = int(record["track_index"])
        self.uncertain = record.get("quality") == "uncertain"
        self.pts = [int(point[0]) for point in record["points"]]
        self.points = [(float(point[1]), float(point[2]), float(point[3])) for point in record["points"]]

    def at(self, now: int) -> tuple[float, float, float, int] | None:
        if not self.pts or now < self.pts[0] or now > self.pts[-1]:
            return None
        index = bisect_right(self.pts, now) - 1
        following = min(index + 1, len(self.pts) - 1)
        span = self.pts[following] - self.pts[index]
        t = (now - self.pts[index]) / span if span > 0 else 0.0
        (x0, y0, area), (x1, y1, _) = self.points[index], self.points[following]
        return x0 + t * (x1 - x0), y0 + t * (y1 - y0), area, index


def counted(crossing: dict) -> bool:
    review = crossing.get("review")
    return crossing["quality"] == "coherent" if review is None else review["action"] != "reject"


def tally(counts: dict, order: dict[str, int], segment_id: str, now: int) -> tuple[int, int, int]:
    """Entered, exited and undecided crossings of one gate up to the frame (earlier videos entirely)."""
    entered = exited = pending = 0
    current = order[segment_id]
    for crossing in counts["crossings"]:
        at = order.get(crossing["segment_id"], -1)
        if at > current or (at == current and int(crossing["pts"]) > now):
            continue
        review = crossing.get("review")
        if crossing["quality"] == "uncertain" and review is None:
            pending += 1
            continue
        if not counted(crossing):
            continue
        direction = FLIP[crossing["direction"]] if review and review.get("flipped") else crossing["direction"]
        amount = int(review["count"]) if review else 1
        if direction == counts["gate"]["entry_direction"]:
            entered += amount
        else:
            exited += amount
    for added in counts.get("missed", []):
        at = order.get(added["segment_id"], -1)
        if at < current or (at == current and int(added["pts"]) <= now):
            if added["direction"] == counts["gate"]["entry_direction"]:
                entered += int(added["count"])
            else:
                exited += int(added["count"])
    return entered, exited, pending


def _valid(counts: dict, segment_id: str, now: int) -> list | None:
    for span in counts["valid_spans"].get(segment_id, []):
        if (span["from_pts"] is None or now >= int(span["from_pts"])) and (span["to_pts"] is None or now < int(span["to_pts"])):
            return span["points"]
    return None


def draw(image: Image.Image, scale: float, now: int, ticks_per_second: float, tracks: list[Track], gates: list[dict],
         order: dict[str, int], segment_id: str, clock: str) -> None:
    """Draw the overlay in place on an RGB image of the source frame scaled by `scale`."""
    canvas = ImageDraw.Draw(image)
    width, height = image.size
    small, large = font(max(10, round(height / 40))), font(max(12, round(height / 28)))
    for index, counts in enumerate(gates):
        colour = GATE_COLOURS[index % len(GATE_COLOURS)]
        points = _valid(counts, segment_id, now)
        shape = [(x * scale, y * scale) for x, y in (points or counts["gate"]["points"])]
        if counts["gate"]["kind"] != "line":
            shape.append(shape[0])
        canvas.line(shape, fill=colour if points else "#64748b", width=3 if points else 2)
    trail = ticks_per_second
    for track in tracks:
        at = track.at(now)
        if at is None:
            continue
        x, y, area, index = at
        colour = TRACK_COLOURS[track.index % len(TRACK_COLOURS)]
        start = max(0, bisect_right(track.pts, now - trail) - 1)
        path = [(px * scale, py * scale) for px, py, _ in track.points[start:index + 1]] + [(x * scale, y * scale)]
        if len(path) > 1:
            canvas.line(path, fill=colour, width=2)
        radius = max(6.0, (area ** 0.5) * scale)
        canvas.ellipse((x * scale - radius, y * scale - radius, x * scale + radius, y * scale + radius), outline=UNDECIDED if track.uncertain else colour, width=2)
        canvas.text((x * scale + radius + 2, y * scale - radius - 2), f"#{track.index + 1}", fill=colour, font=small)
    for counts in gates:
        for crossing in counts["crossings"]:
            age = now - int(crossing["pts"])
            if crossing["segment_id"] != segment_id or age < 0 or age > 1.5 * ticks_per_second:
                continue
            track = next((item for item in tracks if item.index == crossing["track_index"]), None)
            at = track.at(int(crossing["pts"])) if track else None
            if at is None:
                continue
            undecided = crossing["quality"] == "uncertain" and crossing.get("review") is None
            entering = crossing["direction"] == counts["gate"]["entry_direction"]
            r = 9
            cx, cy = at[0] * scale, at[1] * scale
            canvas.ellipse((cx - r, cy - r, cx + r, cy + r), outline=UNDECIDED if undecided else IN_COLOUR if entering else OUT_COLOUR, width=3)
    row = large.size + 10
    for index, counts in enumerate(reversed(gates)):
        entered, exited, pending = tally(counts, order, segment_id, now)
        top = height - (index + 1) * row
        canvas.rectangle((0, top, width, top + row), fill=(2, 6, 23))
        text = f"{counts['gate']['name']}   Entered {entered}   Exited {exited}   Net {exited - entered:+d}" + (f"   {pending} undecided" if pending else "")
        canvas.text((8, top + 4), text, fill=GATE_COLOURS[(len(gates) - 1 - index) % len(GATE_COLOURS)], font=large)
    canvas.rectangle((0, 0, width, row), fill=(2, 6, 23))
    canvas.text((8, 4), WATERMARK, fill="#fbbf24", font=small)
    clock_width = canvas.textlength(clock, font=small)
    canvas.text((width - clock_width - 8, 4), clock, fill="#fde047", font=small)


def card(size: tuple[int, int], lines: list[str]) -> Image.Image:
    """A plain title or skip card."""
    image = Image.new("RGB", size, (2, 6, 23))
    canvas = ImageDraw.Draw(image)
    points = max(12, round(size[1] / 24))
    # The longest line (a full ID) sets the size, so every line fits the frame.
    while points > 8 and max(canvas.textlength(line, font=font(points)) for line in lines) > size[0] - 16:
        points -= 1
    text = font(points)
    y = size[1] / 2 - len(lines) * (text.size + 6) / 2
    for line in lines:
        canvas.text(((size[0] - canvas.textlength(line, font=text)) / 2, y), line, fill="#e2e8f0", font=text)
        y += text.size + 6
    canvas.text((8, 4), WATERMARK, fill="#fbbf24", font=font(max(10, round(size[1] / 40))))
    return image
