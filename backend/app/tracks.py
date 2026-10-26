"""Individual target tracking for bat video review (tracks-v2, Phase 2 W2).

Pipeline per segment, in source pixels:
1. Block-mean pooling to an analysis grid on which the expected target is at least about three cells wide.
2. A centred temporal median background (samples a quarter second apart, processed with a short lookahead), so a
   target is compared with the empty scene rather than with the previous frame.
3. Foreground by polarity and sensitivity inside the detection area and outside exclusion zones; a closing joins
   wings and body; components outside the target size range are rejected and counted.
4. Disturbances (a large part of the area changing at once) are frame gaps and are classified when they settle:
   camera moved (the scene shifted or no longer matches), lighting change, or a short glitch.
5. A constant-velocity Kalman filter per track with a Mahalanobis and size cost, optimal one-to-one assignment,
   tentative tracks confirmed after three hits, then tracklet joining across short losses and a quality class.

A track is a review aid: never an identified animal and never a count of bats on its own.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from hashlib import sha256
from math import ceil, floor, log, pi
import zlib

import numpy as np
from scipy import ndimage, optimize

from . import windows

ALGORITHM_VERSION = "tracks-v2"
POINT_FORMAT = "trk1"
POINT_DTYPE = np.dtype([("pts", "<i8"), ("x", "<f4"), ("y", "<f4"), ("area", "<u4")])
ACTIVITY_LIMITS = {"sparse": 32, "normal": 128, "dense": 512}
DEFAULT_SETTINGS = {"target_px": 12, "polarity": "both", "sensitivity": 12, "activity": "normal", "detection_area": [],
                    "exclusions": [], "max_gap_s": 0.4, "min_track_s": 0.2, "join_gap_s": 1.0, "min_displacement_targets": 2}
# Fixed method constants; part of the parameter hash, not user settings.
CONSTANTS = {"analysis_max": [640, 360], "background_samples": 9, "samples_per_second": 4, "disturbance_fraction": 0.25,
             "settle_frames": 3, "scene_residual_of_sensitivity": 0.5, "chi2_gate": 13.8, "max_area_ratio": 4, "size_weight": 1.0,
             "confirm_hits": 3, "tentative_misses": 2, "join_max_area_ratio": 3, "join_min_cos": 0.5,
             "size_range_targets": [0.25, 4], "coherent_min_points": 5, "coherent_max_gap_ratio": 0.3, "coherent_max_size_cv": 0.6}
MAX_EVENT_SECONDS = 600


def settings_with_defaults(settings: dict | None) -> dict:
    merged = {**DEFAULT_SETTINGS, **(settings or {})}
    if set(merged) != set(DEFAULT_SETTINGS):
        raise ValueError("Unknown tracking setting")
    return merged


def parameters(settings: dict | None = None) -> dict:
    """Versioned parameters; every value that changes a track is part of the hash."""
    values = windows.parameters()
    return {"algorithm_version": ALGORITHM_VERSION, "settings": settings_with_defaults(settings), "constants": CONSTANTS,
            "toolchain": {**values["toolchain"], "scipy": _version("scipy")}}


def _version(name: str) -> str:
    from importlib.metadata import version
    return version(name)


def parameter_hash(values: dict) -> str:
    return windows.parameter_hash(values)


@dataclass
class Detection:
    x: float
    y: float
    area: int
    box: tuple[int, int, int, int]  # x0, y0, x1, y1 in source pixels (exclusive end)
    contrast: float


@dataclass
class Track:
    points: list[tuple[int, float, float, int]] = field(default_factory=list)
    box: list[int] = field(default_factory=lambda: [2 ** 31, 2 ** 31, -1, -1])
    contrast: list[float] = field(default_factory=list)
    epoch: int = 0
    joins: int = 0
    quality: str = "uncertain"
    metrics: dict = field(default_factory=dict)

    def add(self, pts: int, item: Detection) -> None:
        self.points.append((pts, item.x, item.y, item.area))
        self.contrast.append(item.contrast)
        self.box = [min(self.box[0], item.box[0]), min(self.box[1], item.box[1]),
                    max(self.box[2], item.box[2]), max(self.box[3], item.box[3])]


@dataclass
class SceneEvent:
    kind: str  # camera_moved, lighting_change or glitch
    start_pts: int
    end_pts: int
    details: dict


class _Live:
    """Constant-velocity Kalman state of one track, in source pixels per frame."""

    F = np.array([[1, 0, 1, 0], [0, 1, 0, 1], [0, 0, 1, 0], [0, 0, 0, 1]], dtype=float)
    H = np.array([[1, 0, 0, 0], [0, 1, 0, 0]], dtype=float)

    def __init__(self, item: Detection, pts: int, epoch: int, measure: float, speed: float, accel: float) -> None:
        self.x = np.array([item.x, item.y, 0.0, 0.0])
        self.P = np.diag([measure ** 2, measure ** 2, speed ** 2, speed ** 2])
        self.R = np.eye(2) * measure ** 2
        g = np.array([[0.5, 0], [0, 0.5], [1, 0], [0, 1]])
        self.Q = g @ g.T * accel ** 2
        self.track = Track(epoch=epoch)
        self.track.add(pts, item)
        self.area = float(item.area)
        self.hits, self.misses = 1, 0

    def predict(self) -> None:
        self.x = self.F @ self.x
        self.P = self.F @ self.P @ self.F.T + self.Q

    def innovation(self) -> tuple[np.ndarray, np.ndarray]:
        S = self.H @ self.P @ self.H.T + self.R
        return self.H @ self.x, np.linalg.inv(S)

    def update(self, pts: int, item: Detection) -> None:
        S = self.H @ self.P @ self.H.T + self.R
        K = self.P @ self.H.T @ np.linalg.inv(S)
        self.x = self.x + K @ (np.array([item.x, item.y]) - self.H @ self.x)
        self.P = (np.eye(4) - K @ self.H) @ self.P
        self.area = 0.7 * self.area + 0.3 * item.area
        self.track.add(pts, item)
        self.hits += 1
        self.misses = 0


def _disk(radius: int) -> np.ndarray:
    y, x = np.ogrid[-radius:radius + 1, -radius:radius + 1]
    return x * x + y * y <= radius * radius


def _phase_shift(a: np.ndarray, b: np.ndarray) -> tuple[float, float]:
    """Translation (dy, dx) of b relative to a by phase correlation, and the peak strength."""
    window = np.outer(np.hanning(a.shape[0]), np.hanning(a.shape[1]))
    fa, fb = np.fft.fft2((a - a.mean()) * window), np.fft.fft2((b - b.mean()) * window)
    cross = fb * np.conj(fa)
    cross /= np.abs(cross) + 1e-9
    response = np.real(np.fft.ifft2(cross))
    peak = np.unravel_index(int(np.argmax(response)), response.shape)
    dy = peak[0] if peak[0] <= a.shape[0] // 2 else peak[0] - a.shape[0]
    dx = peak[1] if peak[1] <= a.shape[1] // 2 else peak[1] - a.shape[1]
    return float(dy), float(dx)


class Analyzer:
    """Feed decoded grey frames of one segment in order; `finish()` returns tracks, scene events and statistics."""

    def __init__(self, width: int, height: int, fps: float, tick_seconds: float, settings: dict,
                 record_detections: tuple[int, int] | None = None):
        if fps <= 0 or tick_seconds <= 0:
            raise ValueError("unknown_timing")
        self.tick_seconds = tick_seconds
        self.settings = s = settings_with_defaults(settings)
        self.width, self.height, self.fps = width, height, fps
        target = float(s["target_px"])
        coarse = max(ceil(width / CONSTANTS["analysis_max"][0]), ceil(height / CONSTANTS["analysis_max"][1]))
        self.step = max(1, min(coarse, floor(target / 3)))
        self.grid = (height // self.step, width // self.step)
        self.mask = self._mask()
        self.mask_cells = int(self.mask.sum())
        if self.mask_cells == 0:
            raise ValueError("tracking_settings")
        low, high = CONSTANTS["size_range_targets"]
        self.min_area, self.max_area = pi / 4 * (low * target) ** 2, pi / 4 * (high * target) ** 2
        self.closing = _disk(max(1, round(target / (4 * self.step))))
        self.limit = ACTIVITY_LIMITS[s["activity"]]
        self.spacing = max(1, round(fps / CONSTANTS["samples_per_second"]))
        self.half = CONSTANTS["background_samples"] // 2 * self.spacing
        self.max_gap = max(1, round(s["max_gap_s"] * fps))
        self.measure = max(1.0, target / 4)
        self.speed = max(4 * target, width / 8)
        self.accel = max(1.0, target / 2)
        self.record = record_detections
        self.detections: list[dict] = []
        self.pending: deque[tuple[int, int, np.ndarray]] = deque()
        self.samples: deque[tuple[int, np.ndarray]] = deque()
        self.index = -1
        self.background: np.ndarray | None = None
        self.background_key: tuple[int, ...] = ()
        self.epoch = 0
        self.live: list[_Live] = []
        self.done: list[Track] = []
        self.events: list[SceneEvent] = []
        self.event: dict | None = None
        self.previous: np.ndarray | None = None
        self.stats = {"frames": 0, "detections": 0, "rejected_size": 0, "limit_frames": 0, "disturbed_frames": 0,
                      "analysis_step": self.step, "background_spacing_frames": self.spacing}

    # -- geometry -------------------------------------------------------------------------------------------
    def _mask(self) -> np.ndarray:
        from PIL import Image, ImageDraw

        rows, columns = self.grid
        area = self.settings["detection_area"]
        image = Image.new("1", (columns, rows), 0 if area else 1)
        draw = ImageDraw.Draw(image)
        scaled = lambda polygon: [(x / self.step, y / self.step) for x, y in polygon]
        for polygon in area:
            draw.polygon(scaled(polygon), fill=1)
        for polygon in self.settings["exclusions"]:
            draw.polygon(scaled(polygon), fill=0)
        return np.array(image, dtype=bool)

    def pool(self, gray: np.ndarray) -> np.ndarray:
        rows, columns = self.grid
        cropped = gray[:rows * self.step, :columns * self.step].astype(np.float32)
        return cropped.reshape(rows, self.step, columns, self.step).mean(axis=(1, 3))

    # -- feeding --------------------------------------------------------------------------------------------
    def feed(self, pts: int, gray: np.ndarray) -> None:
        if gray.shape != (self.height, self.width):
            raise ValueError("unsupported_codec")
        self.index += 1
        image = self.pool(gray)
        self.pending.append((self.index, pts, image))
        if self.index % self.spacing == 0:
            self.samples.append((self.index, image.astype(np.uint8) if self.step == 1 else np.round(image).astype(np.uint8)))
        while self.pending and self.pending[0][0] <= self.index - self.half:
            self._process(*self.pending.popleft())

    def _background(self, index: int) -> np.ndarray:
        while self.samples and self.samples[0][0] < index - self.half:
            self.samples.popleft()
        chosen = [image for at, image in self.samples if at <= index + self.half]
        key = tuple(at for at, _ in self.samples if at <= index + self.half)
        if key != self.background_key or self.background is None:
            self.background = np.median(np.stack(chosen), axis=0).astype(np.float32) if chosen else self.previous
            self.background_key = key
        return self.background

    def _foreground(self, image: np.ndarray, background: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        diff = image - background
        threshold = self.settings["sensitivity"]
        polarity = self.settings["polarity"]
        strength = diff if polarity == "light" else -diff if polarity == "dark" else np.abs(diff)
        return (strength >= threshold) & self.mask, np.abs(diff)

    def _disturbed(self, foreground: np.ndarray) -> bool:
        return int(foreground.sum()) >= CONSTANTS["disturbance_fraction"] * self.mask_cells

    def _process(self, index: int, pts: int, image: np.ndarray) -> None:
        self.stats["frames"] += 1
        if self.event is not None:
            self._continue_event(index, pts, image)
            self.previous = image
            return
        background = self._background(index)
        foreground, strength = self._foreground(image, background)
        if self._disturbed(foreground):
            # The scene before the disturbance: past samples only, since the centred window already sees later frames.
            past = [image_ for at, image_ in self.samples if at < index]
            before = np.median(np.stack(past), axis=0).astype(np.float32) if past else background.copy()
            foreground, strength = self._foreground(image, before)
        if self._disturbed(foreground):
            self.event = {"start": pts, "last": pts, "frames": 1, "stable": [], "before": before}
            self.stats["disturbed_frames"] += 1
            self._coast()
        else:
            found = self._detect(foreground, strength, pts)
            if found is None:
                self.stats["limit_frames"] += 1
                self._coast()
            else:
                self._associate(pts, found)
        self.previous = image

    # -- scene disturbances ---------------------------------------------------------------------------------
    def _continue_event(self, index: int, pts: int, image: np.ndarray) -> None:
        event = self.event
        assert event is not None
        foreground, strength = self._foreground(image, event["before"])
        if not self._disturbed(foreground):
            # The scene returned to the earlier background: a passing glitch or a temporary lighting change.
            self._close_event("glitch" if event["frames"] <= 2 else "lighting_change", pts, {"duration_frames": event["frames"]})
            found = self._detect(foreground, strength, pts)
            self._associate(pts, found) if found is not None else self._coast()
            return
        self.stats["disturbed_frames"] += 1
        event["frames"] += 1
        event["last"] = pts
        moving = self.previous is not None and self._disturbed(np.abs(image - self.previous) >= self.settings["sensitivity"])
        event["stable"] = [] if moving else [*event["stable"], image][-CONSTANTS["settle_frames"]:]
        self._coast()
        too_long = event["frames"] > MAX_EVENT_SECONDS * self.fps
        if len(event["stable"]) < CONSTANTS["settle_frames"] and not too_long:
            return
        # The settled scene: later samples already read ahead when there are enough, else the settled frames.
        later = [image_ for at, image_ in self.samples if at > index]
        after = np.median(np.stack(later if len(later) >= 3 else event["stable"] or [image]), axis=0).astype(np.float32)
        before = event["before"]
        normalised = lambda image_: image_ - image_.mean()
        residual = float(np.mean(np.abs(normalised(after) - normalised(before))))
        # A scene that still matches after removing a brightness change did not move; otherwise the camera is
        # treated as moved, also when no clean shift can be measured (rotation, zoom, a new view).
        moved = residual >= self.settings["sensitivity"] * CONSTANTS["scene_residual_of_sensitivity"] or too_long
        dy, dx = _phase_shift(before, after) if moved else (0.0, 0.0)
        details = {"shift_px": [round(dx * self.step, 1), round(dy * self.step, 1)], "residual": round(residual, 2),
                   "brightness_change": round(float(after.mean() - before.mean()), 2), "duration_frames": event["frames"]}
        self._close_event("camera_moved" if moved else "lighting_change", pts, details)
        if moved:
            for live in self.live:
                self._end(live)
            self.live = []
            self.epoch += 1
        # Restart the background from the settled scene; samples taken during the disturbance are discarded.
        self.samples = deque((at, image_) for at, image_ in self.samples if at > index)
        if len(self.samples) < 3:
            self.samples.appendleft((index, np.round(after).astype(np.uint8)))
        self.background_key = ()

    def _close_event(self, kind: str, pts: int, details: dict) -> None:
        assert self.event is not None
        self.events.append(SceneEvent(kind, self.event["start"], max(self.event["last"], pts), details))
        self.event = None

    # -- detection and association -------------------------------------------------------------------------
    def _detect(self, foreground: np.ndarray, strength: np.ndarray, pts: int) -> list[Detection] | None:
        closed = ndimage.binary_erosion(ndimage.binary_dilation(foreground, self.closing), self.closing, border_value=1) & self.mask
        labels, count = ndimage.label(closed, structure=np.ones((3, 3), dtype=bool))
        if count > self.limit:
            return None
        found: list[Detection] = []
        rejected: list[list] = []
        cell = self.step * self.step
        for index, region in enumerate(ndimage.find_objects(labels), start=1):
            if region is None:
                continue
            component = labels[region] == index
            weights = strength[region] * component
            area = int(component.sum()) * cell
            y0, x0 = region[0].start, region[1].start
            box = (x0 * self.step, y0 * self.step, region[1].stop * self.step, region[0].stop * self.step)
            if not self.min_area <= area <= self.max_area:
                self.stats["rejected_size"] += 1
                rejected.append([*box, "size"])
                continue
            total = float(weights.sum()) or float(component.sum())
            ys, xs = np.nonzero(component)
            w = weights[ys, xs] if weights.sum() > 0 else np.ones(len(xs))
            x = (float((xs * w).sum() / w.sum()) + x0 + 0.5) * self.step
            y = (float((ys * w).sum() / w.sum()) + y0 + 0.5) * self.step
            found.append(Detection(x, y, area, box, total / max(1, int(component.sum()))))
        self.stats["detections"] += len(found)
        if self.record is not None and self.record[0] <= pts <= self.record[1]:
            self.detections.append({"pts": str(pts), "accepted": [list(item.box) for item in found], "rejected": rejected[:64]})
        return found

    def _coast(self) -> None:
        for live in self.live:
            live.predict()
            live.misses += 1
        self._prune()

    def _prune(self) -> None:
        kept = []
        for live in self.live:
            confirmed = live.hits >= CONSTANTS["confirm_hits"]
            if (confirmed and live.misses > self.max_gap) or (not confirmed and live.misses >= CONSTANTS["tentative_misses"]):
                self._end(live)
            else:
                kept.append(live)
        self.live = kept

    def _associate(self, pts: int, found: list[Detection]) -> None:
        for live in self.live:
            live.predict()
        matched_live: set[int] = set()
        matched_found: set[int] = set()
        if self.live and found:
            cost = np.full((len(self.live), len(found)), 1e9)
            for row, live in enumerate(self.live):
                predicted, inverse = live.innovation()
                for column, item in enumerate(found):
                    residual = np.array([item.x, item.y]) - predicted
                    distance = float(residual @ inverse @ residual)
                    ratio = max(item.area, 1) / max(live.area, 1)
                    if distance <= CONSTANTS["chi2_gate"] and 1 / CONSTANTS["max_area_ratio"] <= ratio <= CONSTANTS["max_area_ratio"]:
                        cost[row, column] = distance + CONSTANTS["size_weight"] * log(ratio) ** 2
            for row, column in zip(*optimize.linear_sum_assignment(cost)):
                if cost[row, column] < 1e9:
                    self.live[row].update(pts, found[column])
                    matched_live.add(row)
                    matched_found.add(column)
        for row, live in enumerate(self.live):
            if row not in matched_live:
                live.misses += 1
        self._prune()
        for column, item in enumerate(found):
            if column not in matched_found:
                self.live.append(_Live(item, pts, self.epoch, self.measure, self.speed, self.accel))

    def _end(self, live: _Live) -> None:
        if live.hits >= CONSTANTS["confirm_hits"]:
            self.done.append(live.track)

    # -- finishing ------------------------------------------------------------------------------------------
    def finish(self) -> tuple[list[Track], list[SceneEvent], dict]:
        while self.pending:
            self._process(*self.pending.popleft())
        if self.event is not None:
            # A disturbance that never settled cannot show the camera stayed put.
            self._close_event("camera_moved", self.event["last"], {"duration_frames": self.event["frames"], "settled": False})
        for live in self.live:
            self._end(live)
        self.live = []
        joined = join_tracklets(self.done, self.fps, self.settings, self._seconds)
        for track in joined:
            classify(track, self.fps, self.settings, self._seconds)
        joined.sort(key=lambda track: track.points[0][0])
        qualities = [track.quality for track in joined]
        self.stats.update({"tracks": len(joined), "coherent": qualities.count("coherent"), "uncertain": qualities.count("uncertain"),
                           "noise": qualities.count("noise"), "joins": sum(track.joins for track in joined),
                           "events": {kind: sum(event.kind == kind for event in self.events) for kind in ("camera_moved", "lighting_change", "glitch")}})
        return joined, self.events, self.stats

    def _seconds(self, ticks: int) -> float:
        return ticks * self.tick_seconds


def _velocity(track: Track, end: bool) -> tuple[float, float, float]:
    """Mean velocity in pixels per tick over up to five points at the track's end (or start), and its area."""
    points = track.points[-5:] if end else track.points[:5]
    areas = float(np.median([point[3] for point in points]))
    if len(points) < 2 or points[-1][0] == points[0][0]:
        return 0.0, 0.0, areas
    ticks = points[-1][0] - points[0][0]
    return (points[-1][1] - points[0][1]) / ticks, (points[-1][2] - points[0][2]) / ticks, areas


def join_tracklets(found: list[Track], fps: float, settings: dict, seconds) -> list[Track]:
    """Join a track that ended to one that started shortly after where the first was heading (same epoch only)."""
    target = float(settings["target_px"])
    tracks_ = sorted(found, key=lambda track: track.points[0][0])
    if len(tracks_) < 2:
        return tracks_
    cost = np.full((len(tracks_), len(tracks_)), 1e9)
    for a, first in enumerate(tracks_):
        vxa, vya, area_a = _velocity(first, True)
        end_pts, ex, ey = first.points[-1][0], first.points[-1][1], first.points[-1][2]
        for b, second in enumerate(tracks_):
            if a == b or second.epoch != first.epoch:
                continue
            gap = second.points[0][0] - end_pts
            gap_s = seconds(gap)
            if gap <= 0 or gap_s > settings["join_gap_s"]:
                continue
            vxb, vyb, area_b = _velocity(second, False)
            # Speeds in pixels per frame; a tick is one unit of the source time base.
            per_frame = 1 / (fps * seconds(1))
            speed_a, speed_b = np.hypot(vxa, vya) * per_frame, np.hypot(vxb, vyb) * per_frame
            frames = gap_s * fps
            distance = float(np.hypot(ex + vxa * gap - second.points[0][1], ey + vya * gap - second.points[0][2]))
            if distance > max(2 * target, 0.5 * speed_a * frames + target):
                continue
            if speed_a > 0.5 and speed_b > 0.5:
                cosine = (vxa * vxb + vya * vyb) / (np.hypot(vxa, vya) * np.hypot(vxb, vyb))
                if cosine < CONSTANTS["join_min_cos"]:
                    continue
            ratio = max(area_a, area_b) / max(1.0, min(area_a, area_b))
            if ratio > CONSTANTS["join_max_area_ratio"]:
                continue
            cost[a, b] = distance + gap_s
    links: dict[int, int] = {}
    for a, b in zip(*optimize.linear_sum_assignment(cost)):
        if cost[a, b] < 1e9:
            links[int(a)] = int(b)
    targets = set(links.values())
    result = []
    for start in range(len(tracks_)):
        if start in targets:
            continue
        chain, current = tracks_[start], start
        while current in links:
            current = links[current]
            nxt = tracks_[current]
            chain.points.extend(nxt.points)
            chain.contrast.extend(nxt.contrast)
            chain.box = [min(chain.box[0], nxt.box[0]), min(chain.box[1], nxt.box[1]), max(chain.box[2], nxt.box[2]), max(chain.box[3], nxt.box[3])]
            chain.joins += 1 + nxt.joins
        result.append(chain)
    return result


def classify(track: Track, fps: float, settings: dict, seconds) -> None:
    """Quality class and metrics. Rules are versioned parameters, not approved ecological thresholds."""
    points = np.array([(p[0], p[1], p[2], p[3]) for p in track.points], dtype=float)
    duration = seconds(int(points[-1, 0] - points[0, 0]))
    steps = np.hypot(np.diff(points[:, 1]), np.diff(points[:, 2]))
    path = float(steps.sum())
    displacement = float(np.hypot(points[-1, 1] - points[0, 1], points[-1, 2] - points[0, 2]))
    expected = max(1, round(duration * fps) + 1)
    gap_ratio = max(0.0, 1 - len(points) / expected)
    size_cv = float(points[:, 3].std() / max(1.0, points[:, 3].mean()))
    track.metrics = {"duration_s": round(duration, 3), "points": len(points), "displacement_px": round(displacement, 1),
                     "path_px": round(path, 1), "straightness": round(displacement / path, 3) if path > 0 else 0.0,
                     "size_cv": round(size_cv, 3), "gap_ratio": round(gap_ratio, 3), "joins": track.joins,
                     "contrast": round(float(np.mean(track.contrast)), 1) if track.contrast else 0.0}
    if displacement < settings["min_displacement_targets"] * settings["target_px"] or duration < settings["min_track_s"]:
        track.quality = "noise"
    elif len(points) >= CONSTANTS["coherent_min_points"] and gap_ratio <= CONSTANTS["coherent_max_gap_ratio"] and size_cv <= CONSTANTS["coherent_max_size_cv"]:
        track.quality = "coherent"
    else:
        track.quality = "uncertain"


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
