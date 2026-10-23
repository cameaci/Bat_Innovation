"""Motion candidates and their association into tracks (feature expansion E2).

Candidates are connected components of a causal double difference: a pixel counts only when the current frame
differs from both previous frames, which removes the "ghost" left where a target was one frame earlier.
Positions are measured in source pixels.
Association uses a constant-velocity prediction and an optimal one-to-one assignment within a gate.
A track is a review aid: it is not an individual animal and never a count of bats.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from fractions import Fraction
from hashlib import sha256
import zlib

import numpy as np
from scipy import ndimage, optimize

from . import motion, windows

ALGORITHM_VERSION = "tracks-v1"
POINT_FORMAT = "trk1"
POINT_DTYPE = np.dtype([("pts", "<i8"), ("x", "<f4"), ("y", "<f4"), ("area", "<u4")])
MAX_CANDIDATES = 64  # per frame; more is reported as a candidate-limit frame, never silently cut


def parameters() -> dict:
    """Versioned parameters; every value that changes a track is part of the hash."""
    values = windows.parameters()
    return {"algorithm_version": ALGORITHM_VERSION, "difference": "causal-double", "threshold": 12, "min_area": 1, "max_area_fraction": "1/16",
            "framewide_fraction": "1/4", "max_gap_frames": 3, "min_points": 3, "gate_fraction": "1/12", "gate_min_px": 12,
            "max_width": motion.MAX_WIDTH, "max_height": motion.MAX_HEIGHT, "connectivity": 8,
            "toolchain": {**values["toolchain"], "scipy": _version("scipy")}}


def _version(name: str) -> str:
    from importlib.metadata import version
    return version(name)


def parameter_hash(values: dict) -> str:
    return windows.parameter_hash(values)


@dataclass
class Candidate:
    x: float
    y: float
    area: int
    box: tuple[int, int, int, int]  # x0, y0, x1, y1 in source pixels (exclusive end)


def difference(current: np.ndarray, earlier: np.ndarray) -> np.ndarray:
    return np.abs(current.astype(np.int16) - earlier.astype(np.int16)).astype(np.uint8)


def candidates(recent: np.ndarray, older: np.ndarray, step: int, values: dict) -> tuple[list[Candidate], str | None]:
    """Connected regions changed against both previous frames. Returns a frame flag instead of guessing."""
    changed = motion.max_pool(recent, step) >= values["threshold"]
    if np.count_nonzero(changed) >= changed.size * Fraction(values["framewide_fraction"]):
        return [], "framewide_change"
    mask = motion.max_pool(np.minimum(recent, older), step) >= values["threshold"]
    labels, count = ndimage.label(mask, structure=np.ones((3, 3), dtype=bool))
    if count > MAX_CANDIDATES:
        return [], "candidate_limit"
    found: list[Candidate] = []
    max_area = mask.size * Fraction(values["max_area_fraction"])
    for index, region in enumerate(ndimage.find_objects(labels), start=1):
        if region is None:
            continue
        component = labels[region] == index
        area = int(component.sum())
        if area < values["min_area"] or area > max_area:
            continue
        ys, xs = np.nonzero(component)
        y0, x0 = region[0].start, region[1].start
        found.append(Candidate(float((xs.mean() + x0 + 0.5) * step), float((ys.mean() + y0 + 0.5) * step), area * step * step,
                               (x0 * step, y0 * step, region[1].stop * step, region[0].stop * step)))
    return found, None


@dataclass
class Track:
    points: list[tuple[int, float, float, int]] = field(default_factory=list)
    box: list[int] = field(default_factory=lambda: [2 ** 31, 2 ** 31, -1, -1])
    velocity: tuple[float, float] = (0.0, 0.0)
    missed: int = 0

    def predict(self) -> tuple[float, float]:
        _, x, y, _ = self.points[-1]
        return x + self.velocity[0] * (self.missed + 1), y + self.velocity[1] * (self.missed + 1)

    def add(self, pts: int, item: Candidate) -> None:
        if self.points:
            _, x, y, _ = self.points[-1]
            gap = self.missed + 1
            self.velocity = ((item.x - x) / gap, (item.y - y) / gap)
        self.points.append((pts, item.x, item.y, item.area))
        self.box = [min(self.box[0], item.box[0]), min(self.box[1], item.box[1]),
                    max(self.box[2], item.box[2]), max(self.box[3], item.box[3])]
        self.missed = 0


class Tracker:
    """Frame-by-frame association for one segment; tracks never cross segments."""

    def __init__(self, width: int, values: dict) -> None:
        self.values = values
        self.gate = max(values["gate_min_px"], float(width * Fraction(values["gate_fraction"])))
        self.active: list[Track] = []
        self.finished: list[Track] = []

    def update(self, pts: int, found: list[Candidate]) -> None:
        matched_tracks: set[int] = set()
        matched_found: set[int] = set()
        if self.active and found:
            predicted = np.array([track.predict() for track in self.active])
            observed = np.array([(item.x, item.y) for item in found])
            cost = np.linalg.norm(predicted[:, None, :] - observed[None, :, :], axis=2)
            for row, column in zip(*optimize.linear_sum_assignment(cost)):
                if cost[row, column] <= self.gate:
                    self.active[row].add(pts, found[column])
                    matched_tracks.add(row)
                    matched_found.add(column)
        survivors = []
        for index, track in enumerate(self.active):
            if index not in matched_tracks:
                track.missed += 1
            if track.missed > self.values["max_gap_frames"]:
                self._end(track)
            else:
                survivors.append(track)
        self.active = survivors
        for index, item in enumerate(found):
            if index not in matched_found:
                track = Track()
                track.add(pts, item)
                self.active.append(track)

    def gap(self) -> None:
        """A frame without usable candidates (e.g. frame-wide change) still advances missed counts."""
        for track in self.active:
            track.missed += 1
        ended = [track for track in self.active if track.missed > self.values["max_gap_frames"]]
        for track in ended:
            self._end(track)
        self.active = [track for track in self.active if track not in ended]

    def _end(self, track: Track) -> None:
        if len(track.points) >= self.values["min_points"]:
            self.finished.append(track)

    def finish(self) -> list[Track]:
        for track in self.active:
            self._end(track)
        self.active = []
        return sorted(self.finished, key=lambda track: track.points[0][0])


def pack(points: list[tuple[int, float, float, int]]) -> bytes:
    array = np.array(points, dtype=POINT_DTYPE)
    return POINT_FORMAT.encode() + zlib.compress(array.tobytes(), 6)


def unpack(blob: bytes) -> np.ndarray:
    if not blob.startswith(POINT_FORMAT.encode()):
        raise ValueError("Unknown track point format")
    return np.frombuffer(zlib.decompress(blob[len(POINT_FORMAT):]), dtype=POINT_DTYPE)


def digest(blob: bytes) -> str:
    return sha256(blob).hexdigest()


def summary(track: Track) -> dict:
    return {"first_pts": str(track.points[0][0]), "last_pts": str(track.points[-1][0]),
            "point_count": len(track.points), "bbox": track.box}
