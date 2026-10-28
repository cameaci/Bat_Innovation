"""Individual target tracking for bat video review (tracks-v3, Phase 3 X3; tracks-v2 was Phase 2 W2).

Pipeline per segment, in source pixels:
1. Block-mean pooling to an analysis grid on which the expected target is at least about three cells wide. A frame
   that repeats the previous one (frame-rate conversion, a camera shutter freeze) carries no new information and is
   skipped; motion uses the real time between frames, so repeats and variable frame rates do not distort speeds.
2. A centred temporal median background (samples a quarter second apart, processed with a short lookahead) and,
   from the same samples, each cell's temporal noise (MAD): textured stone flickers more than sky, so a fixed
   grey-level threshold cannot suit both. A per-frame gain and offset fit to the background absorbs camera gain
   changes; the steps are counted and reported.
3. Contrast in noise units, in the chosen polarity, smoothed by a Gaussian of about a quarter target (a matched
   filter that lifts small faint targets above speckle and joins wings to the body). Components are grown from
   seeds at the threshold down to half of it; components outside the target size range are rejected and counted.
   Cells that stay foreground for seconds are a static spot and cannot start tracks.
4. Disturbances (a large part of the area changing at once) are frame gaps and are classified when they settle:
   camera moved (the scene shifted or no longer matches), lighting change, or a short glitch.
5. A constant-velocity Kalman filter per track in pixels per second with a hard speed limit, candidates found with a
   KD-tree, optimal one-to-one assignment in two stages (confirmed tracks take strong detections first, then weak
   ones; weak detections never start a track), new tracks born with the local flow of recent tracks, three hits to
   confirm, then tracklet joining across short losses and a quality class.

A track is a review aid: never an identified animal and never a count of bats on its own.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from hashlib import sha256
from math import ceil, floor, log, pi, sqrt
import zlib

import numpy as np
from scipy import ndimage, optimize, spatial

from . import windows

ALGORITHM_VERSION = "tracks-v3"
POINT_FORMAT = "trk1"
POINT_DTYPE = np.dtype([("pts", "<i8"), ("x", "<f4"), ("y", "<f4"), ("area", "<u4")])
ACTIVITY_LIMITS = {"sparse": 32, "normal": 128, "dense": 512}
DEFAULT_SETTINGS = {"target_px": 12, "polarity": "both", "threshold": 7.0, "target_speed": 4.0, "activity": "normal",
                    "detection_area": [], "exclusions": [], "max_gap_s": 0.4, "min_track_s": 0.2, "join_gap_s": 1.0,
                    "min_displacement_targets": 2}
# Fixed method constants; part of the parameter hash, not user settings.
CONSTANTS = {"analysis_max": [640, 360], "background_samples": 9, "samples_per_second": 4, "disturbance_fraction": 0.25,
             "settle_frames": 3, "scene_residual_of_noise_threshold": 0.5, "chi2_gate": 13.8, "max_area_ratio": 4, "size_weight": 1.0,
             "confirm_hits": 3, "tentative_misses": 2, "join_max_area_ratio": 3, "join_min_cos": 0.5,
             "size_range_targets": [0.25, 4], "coherent_min_points": 5, "coherent_max_gap_ratio": 0.3, "coherent_max_size_cv": 0.6,
             "repeat_level": 2.0, "noise_floor": 1.0, "filter_sigma_targets": 0.25, "weak_ratio": 0.75,
             "gain_step_noise": 2.0, "max_gain_change": 10.0, "size_level": 0.5, "static_seconds": 2.0, "flow_grid": [8, 6], "flow_memory": 0.9,
             "cells_per_target": 8}
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
    contrast: float  # peak smoothed contrast in noise units
    strong: bool = True
    static: bool = False


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
    """Constant-velocity Kalman state of one track, in source pixels and pixels per second."""

    H = np.array([[1, 0, 0, 0], [0, 1, 0, 0]], dtype=float)

    def __init__(self, item: Detection, pts: int, epoch: int, measure: float, velocity: tuple[float, float], speed_sigma: float,
                 accel: float) -> None:
        self.x = np.array([item.x, item.y, velocity[0], velocity[1]])
        self.P = np.diag([measure ** 2, measure ** 2, speed_sigma ** 2, speed_sigma ** 2])
        self.R = np.eye(2) * measure ** 2
        self.accel = accel
        self.track = Track(epoch=epoch)
        self.track.add(pts, item)
        self.area = float(item.area)
        self.hits = 1
        self.last_pts = pts
        self.state_pts = pts
        self.misses = 0

    def predict(self, pts: int, tick_seconds: float) -> None:
        """Advance the state to `pts` (the time since the state was last advanced, so a coast is one long step)."""
        dt = (pts - self.state_pts) * tick_seconds
        self.state_pts = pts
        F = np.array([[1, 0, dt, 0], [0, 1, 0, dt], [0, 0, 1, 0], [0, 0, 0, 1]], dtype=float)
        g = np.array([[0.5 * dt * dt, 0], [0, 0.5 * dt * dt], [dt, 0], [0, dt]])
        self.x = F @ self.x
        self.P = F @ self.P @ F.T + g @ g.T * self.accel ** 2

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
        self.last_pts = pts
        self.state_pts = pts


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


def _disk(radius: int) -> np.ndarray:
    y, x = np.ogrid[-radius:radius + 1, -radius:radius + 1]
    return x * x + y * y <= radius * radius


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
        # A target spans at least three cells, and need not span more than about eight: finer cells only cost time
        # (large targets close to the camera otherwise mean a wide filter on a fine grid).
        self.step = max(1, min(coarse, floor(target / 3)), floor(target / CONSTANTS["cells_per_target"]))
        self.grid = (height // self.step, width // self.step)
        self.mask = self._mask()
        self.mask_cells = int(self.mask.sum())
        if self.mask_cells == 0:
            raise ValueError("tracking_settings")
        low, high = CONSTANTS["size_range_targets"]
        self.min_area, self.max_area = pi / 4 * (low * target) ** 2, pi / 4 * (high * target) ** 2
        self.sigma = max(0.5, CONSTANTS["filter_sigma_targets"] * target / self.step)
        self.threshold = float(s["threshold"])
        self.limit = ACTIVITY_LIMITS[s["activity"]]
        self.spacing = max(1, round(fps / CONSTANTS["samples_per_second"]))
        self.half = CONSTANTS["background_samples"] // 2 * self.spacing
        self.measure = max(1.0, target / 4)
        # Speeds in source pixels per second: the gate never reaches further than the target speed allows.
        self.max_speed = float(s["target_speed"]) * target * fps
        self.accel = max(1.0, target / 2) * fps * fps
        self.record = record_detections
        self.detections: list[dict] = []
        self.pending: deque[tuple[int, int, np.ndarray, bool]] = deque()
        self.samples: deque[tuple[int, np.ndarray]] = deque()
        self.index = -1
        self.background: np.ndarray | None = None
        self.noise: np.ndarray | None = None
        self.background_key: tuple[int, ...] = ()
        self.epoch = 0
        self.live: list[_Live] = []
        self.done: list[Track] = []
        self.events: list[SceneEvent] = []
        self.event: dict | None = None
        self.previous: np.ndarray | None = None
        self.raw_previous: np.ndarray | None = None
        self.last_pts: int | None = None
        self.first_pts: int | None = None
        self.persist = np.zeros(self.grid, dtype=np.float32)
        self.signed = np.zeros(self.grid, dtype=np.float32)
        columns, rows = CONSTANTS["flow_grid"]
        self.flow = np.zeros((rows, columns, 3))  # vx, vy, weight per coarse cell
        self.gain = (1.0, 0.0)
        self.stats = {"frames": 0, "detections": 0, "rejected_size": 0, "limit_frames": 0, "disturbed_frames": 0,
                      "repeated_frames": 0, "gain_jumps": 0, "static_detections": 0, "analysis_step": self.step,
                      "background_spacing_frames": self.spacing}

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

    def seconds(self, ticks: int) -> float:
        return ticks * self.tick_seconds

    # -- feeding --------------------------------------------------------------------------------------------
    def feed(self, pts: int, gray: np.ndarray) -> None:
        if gray.shape != (self.height, self.width):
            raise ValueError("unsupported_codec")
        image = self.pool(gray)
        # A repeated frame shows nothing new: it still belongs to the scene (background samples, disturbances), but
        # tracks skip it, since treating it as a new frame would make every target stop and then jump.
        repeated = self.raw_previous is not None and float(np.abs(image - self.raw_previous).max()) <= CONSTANTS["repeat_level"]
        self.raw_previous = image
        self.index += 1
        if self.first_pts is None:
            self.first_pts = pts
        self.last_pts = pts
        self.pending.append((self.index, pts, image, repeated))
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
            if chosen:
                stack = np.stack(chosen).astype(np.float32)
                self.background = np.median(stack, axis=0)
                self.noise = self._noise(stack) if len(chosen) >= 3 else np.full(self.grid, CONSTANTS["noise_floor"], np.float32)
            else:
                self.background, self.noise = self.previous, np.full(self.grid, CONSTANTS["noise_floor"], np.float32)
            self.background_key = key
        return self.background

    def _noise(self, stack: np.ndarray) -> np.ndarray:
        """Each cell's temporal spread of the smoothed image over the samples: the matched filter's own noise,
        including the spatial correlation that compression adds."""
        smoothed = ndimage.gaussian_filter(stack, (0, self.sigma, self.sigma))
        # Two robust estimates, each blind to one confusion: the deviation from the median ignores a target present in
        # one or two samples (a slow bat) but not a lighting step; successive differences ignore a step but not a slow
        # target. The smaller of the two, then the largest nearby, since nine samples give a rough per-cell value and
        # an underestimate is a false target.
        deviation = np.median(np.abs(smoothed - np.median(smoothed, axis=0)), axis=0) * 1.4826
        steps = np.median(np.abs(np.diff(smoothed, axis=0)), axis=0) * 1.4826 / sqrt(2)
        spread = ndimage.maximum_filter(np.minimum(deviation, steps), size=5)
        typical = float(np.median(spread[self.mask]))
        return np.maximum(spread, max(CONSTANTS["noise_floor"] * 0.25, 0.5 * typical))

    def _compensate(self, image: np.ndarray, background: np.ndarray) -> np.ndarray:
        """Fit image = gain * background + offset on quiet cells, and undo it; report steps between frames."""
        noise = self.noise if self.noise is not None else np.ones(self.grid, np.float32)
        difference = image - background
        quiet = self.mask & (np.abs(difference - np.median(difference[self.mask])) < 3 * noise)
        if int(quiet.sum()) < 50:
            return image
        b, d = background[quiet], image[quiet]
        variance = float(b.var())
        gain = float(((b - b.mean()) * (d - d.mean())).mean() / variance) if variance > 1e-6 else 1.0
        gain = min(1.5, max(0.67, gain))
        offset = float(d.mean() - gain * b.mean())
        if abs(gain - 1) * float(b.mean()) + abs(offset) > CONSTANTS["max_gain_change"]:
            # Too large for camera gain drift: a flash, a lighting change or a moved view, left to the disturbance rules.
            return image
        typical = float(np.median(noise[self.mask]))
        previous_gain, previous_offset = self.gain
        change = abs(gain - previous_gain) * float(b.mean()) + abs(offset - previous_offset)
        if change > CONSTANTS["gain_step_noise"] * typical:
            self.stats["gain_jumps"] += 1
        self.gain = (gain, offset)
        return (image - offset) / gain

    def _score(self, image: np.ndarray, background: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Smoothed contrast in units of the cell's own noise of that smoothed contrast, and the unsmoothed difference
        (for the target's own size and position), both in the chosen polarity."""
        noise = self.noise if self.noise is not None else np.ones(self.grid, np.float32)
        difference = image - background
        self.signed = difference
        z = ndimage.gaussian_filter(difference, self.sigma) / noise
        polarity = self.settings["polarity"]
        if polarity == "light":
            return z, difference
        if polarity == "dark":
            return -z, -difference
        return np.abs(z), np.abs(difference)

    def _disturbed(self, foreground: np.ndarray) -> bool:
        return int((foreground & self.mask).sum()) >= CONSTANTS["disturbance_fraction"] * self.mask_cells

    def _process(self, index: int, pts: int, image: np.ndarray, repeated: bool = False) -> None:
        self.stats["frames"] += 1
        if repeated and self.event is None:
            self.stats["repeated_frames"] += 1
            self.previous = image
            return
        if self.event is not None:
            self._continue_event(index, pts, image)
            self.previous = image
            return
        background = self._background(index)
        corrected = self._compensate(image, background)
        score, raw = self._score(corrected, background)
        foreground = score >= self.threshold
        before = None
        if self._disturbed(foreground):
            # The scene before the disturbance: past samples only, since the centred window already sees later frames.
            past = [image_ for at, image_ in self.samples if at < index]
            before = np.median(np.stack(past), axis=0).astype(np.float32) if past else background.copy()
            score, raw = self._score(corrected, before)
            foreground = score >= self.threshold
        if self._disturbed(foreground):
            self.event = {"start": pts, "last": pts, "frames": 1, "stable": [], "before": before}
            self.stats["disturbed_frames"] += 1
            self._coast(pts)
        else:
            found = self._detect(score, raw, pts)
            if found is None:
                self.stats["limit_frames"] += 1
                self._coast(pts)
            else:
                self._associate(pts, found)
        self.previous = image

    # -- scene disturbances ---------------------------------------------------------------------------------
    def _continue_event(self, index: int, pts: int, image: np.ndarray) -> None:
        event = self.event
        assert event is not None
        noise = self.noise if self.noise is not None else np.ones(self.grid, np.float32)
        typical = float(np.median(noise[self.mask]))
        score, raw = self._score(image, event["before"])
        if not self._disturbed(score >= self.threshold):
            # The scene returned to the earlier background: a passing glitch or a temporary lighting change.
            self._close_event("glitch" if event["frames"] <= 2 else "lighting_change", pts, {"duration_frames": event["frames"]})
            found = self._detect(score, raw, pts)
            self._associate(pts, found) if found is not None else self._coast(pts)
            return
        self.stats["disturbed_frames"] += 1
        event["frames"] += 1
        event["last"] = pts
        moving = self.previous is not None and self._disturbed(np.abs(image - self.previous) / noise >= self.threshold)
        event["stable"] = [] if moving else [*event["stable"], image][-CONSTANTS["settle_frames"]:]
        self._coast(pts)
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
        moved = residual >= self.threshold * typical * CONSTANTS["scene_residual_of_noise_threshold"] or too_long
        dy, dx = _phase_shift(before, after) if moved else (0.0, 0.0)
        details = {"shift_px": [round(dx * self.step, 1), round(dy * self.step, 1)], "residual": round(residual, 2),
                   "brightness_change": round(float(after.mean() - before.mean()), 2), "duration_frames": event["frames"]}
        self._close_event("camera_moved" if moved else "lighting_change", pts, details)
        if moved:
            for live in self.live:
                self._end(live)
            self.live = []
            self.epoch += 1
            self.flow[:] = 0
        # Restart the background from the settled scene; samples taken during the disturbance are discarded.
        self.samples = deque((at, image_) for at, image_ in self.samples if at > index)
        if len(self.samples) < 3:
            self.samples.appendleft((index, np.round(after).astype(np.uint8)))
        self.background_key = ()
        self.gain = (1.0, 0.0)
        self.persist[:] = 0

    def _close_event(self, kind: str, pts: int, details: dict) -> None:
        assert self.event is not None
        self.events.append(SceneEvent(kind, self.event["start"], max(self.event["last"], pts), details))
        self.event = None

    # -- detection --------------------------------------------------------------------------------------------
    def _detect(self, score: np.ndarray, raw: np.ndarray, pts: int) -> list[Detection] | None:
        """Blobs at local maxima of the smoothed contrast (one per target even when neighbours touch), each measured
        on the unsmoothed difference: its own pixels above half its peak, connected to the peak."""
        weak_level = self.threshold * CONSTANTS["weak_ratio"]
        radius = max(1, round(float(self.settings["target_px"]) / (2 * self.step)))
        peaks_mask = (score >= weak_level) & self.mask & (score >= ndimage.maximum_filter(score, size=2 * radius + 1))
        ys, xs = np.nonzero(peaks_mask)
        # The activity limit applies to targets that could start tracks; weak ones only extend confirmed tracks.
        if int((score[ys, xs] >= self.threshold).sum()) > self.limit:
            return None
        # Cells that stay foreground for seconds are a static spot (a hot fixture, a hanging bat), not a flight.
        seeds = score >= self.threshold
        self.persist = np.where(seeds, self.persist + 1, 0)
        static_frames = CONSTANTS["static_seconds"] * self.fps
        found: list[Detection] = []
        rejected: list[list] = []
        measures: list[list] = []
        cell = self.step * self.step
        rows, columns = self.grid
        reach = 2 * radius
        closing = _disk(max(1, round(float(self.settings["target_px"]) / (4 * self.step))))
        claimed = np.zeros(self.grid, dtype=bool)
        for y, x in sorted(zip(ys.tolist(), xs.tolist()), key=lambda point: -score[point]):
            y0, y1, x0, x1 = max(0, y - reach), min(rows, y + reach + 1), max(0, x - reach), min(columns, x + reach + 1)
            if claimed[y, x]:
                continue  # a weaker peak on a target already measured (a wing beside the body)
            window = raw[y0:y1, x0:x1]
            level = CONSTANTS["size_level"] * max(float(raw[y, x]), float(window.max()) if window.size else 0.0, 1e-6)
            # A closing of about a quarter target joins wings and body before the target's pixels are measured.
            above = window >= level
            joined = ndimage.binary_erosion(ndimage.binary_dilation(above, closing), closing, border_value=1)
            labels, _ = ndimage.label(joined, structure=np.ones((3, 3), dtype=bool))
            label = labels[y - y0, x - x0]
            if label == 0:
                # The peak of the smoothed contrast lies beside the target's own pixels: take the nearest component.
                hits = np.argwhere(labels > 0)
                distances = np.hypot(hits[:, 0] - (y - y0), hits[:, 1] - (x - x0))
                if len(hits) == 0 or distances.min() > radius:
                    continue
                nearest = hits[np.argmin(distances)]
                label = labels[nearest[0], nearest[1]]
            region = labels == label
            if not (region & above).any():
                continue  # only fill from the closing, no pixels of its own: not a target
            claimed[y0:y1, x0:x1] |= ndimage.binary_dilation(region, closing)
            claimed[max(0, y - radius):y + radius + 1, max(0, x - radius):x + radius + 1] = True
            body = region & above
            area = int(body.sum()) * cell
            by, bx = np.nonzero(body)
            box = ((x0 + int(bx.min())) * self.step, (y0 + int(by.min())) * self.step,
                   (x0 + int(bx.max()) + 1) * self.step, (y0 + int(by.max()) + 1) * self.step)
            if not self.min_area <= area <= self.max_area:
                self.stats["rejected_size"] += 1
                rejected.append([*box, "size"])
                continue
            w = window[by, bx]
            w = w if w.sum() > 0 else np.ones(len(bx))
            cx = (float((bx * w).sum() / w.sum()) + x0 + 0.5) * self.step
            cy = (float((by * w).sum() / w.sum()) + y0 + 0.5) * self.step
            peak = float(score[y, x])
            static = bool(self.persist[y, x] >= static_frames)
            measures.append([area, round(peak, 1), 1 if float(self.signed[y, x]) >= 0 else -1])
            self.stats["static_detections"] += int(static)
            found.append(Detection(cx, cy, area, box, round(peak, 2), strong=peak >= self.threshold, static=static))
        self.stats["detections"] += len(found)
        if self.record is not None and self.record[0] <= pts <= self.record[1]:
            # measures: [area in source pixels, peak contrast in noise units, +1 lighter / -1 darker] per accepted box.
            self.detections.append({"pts": str(pts), "accepted": [list(item.box) for item in found], "rejected": rejected[:64],
                                    "measures": measures})
        return found

    # -- association --------------------------------------------------------------------------------------------
    def _coast(self, pts: int) -> None:
        for live in self.live:
            live.misses += 1
        self._prune(pts)

    def _prune(self, pts: int) -> None:
        kept = []
        margin = float(self.settings["target_px"])
        for live in self.live:
            confirmed = live.hits >= CONSTANTS["confirm_hits"]
            lost = self.seconds(pts - live.last_pts)
            # A target predicted to have left the frame has ended; it must not take a newcomer at the edge.
            outside = live.misses > 0 and not (-margin <= live.x[0] <= self.width + margin and -margin <= live.x[1] <= self.height + margin)
            if outside or (confirmed and lost > self.settings["max_gap_s"]) or (not confirmed and live.misses >= CONSTANTS["tentative_misses"]):
                self._end(live)
            else:
                kept.append(live)
        self.live = kept

    def _flow_cell(self, x: float, y: float) -> tuple[int, int]:
        columns, rows = CONSTANTS["flow_grid"]
        return min(rows - 1, max(0, int(y / self.height * rows))), min(columns - 1, max(0, int(x / self.width * columns)))

    def _birth_velocity(self, x: float, y: float) -> tuple[tuple[float, float], float]:
        """The local flow of recent confirmed tracks when it is consistent, else unknown within the speed limit."""
        row, column = self._flow_cell(x, y)
        vx, vy, weight = self.flow[row, column]
        if weight >= 1.0:
            mean = (vx / weight, vy / weight)
            if np.hypot(*mean) > 0:
                return mean, self.max_speed / 4
        return (0.0, 0.0), self.max_speed / 2

    def _learn_flow(self) -> None:
        self.flow *= CONSTANTS["flow_memory"]
        for live in self.live:
            if live.hits >= CONSTANTS["confirm_hits"]:
                row, column = self._flow_cell(live.x[0], live.x[1])
                self.flow[row, column] += (live.x[2], live.x[3], 1.0)

    def _match(self, rows: list[int], columns: list[int], found: list[Detection], radius: dict[int, float]) -> list[tuple[int, int]]:
        if not rows or not columns:
            return []
        points = np.array([[found[column].x, found[column].y] for column in columns])
        tree = spatial.cKDTree(points)
        cost = np.full((len(rows), len(columns)), 1e9)
        for r, row in enumerate(rows):
            live = self.live[row]
            predicted, inverse = live.innovation()
            for c in tree.query_ball_point(predicted, radius[row]):
                item = found[columns[c]]
                residual = np.array([item.x, item.y]) - predicted
                distance = float(residual @ inverse @ residual)
                ratio = max(item.area, 1) / max(live.area, 1)
                if distance <= CONSTANTS["chi2_gate"] and 1 / CONSTANTS["max_area_ratio"] <= ratio <= CONSTANTS["max_area_ratio"]:
                    cost[r, c] = distance + CONSTANTS["size_weight"] * log(ratio) ** 2
        return [(rows[r], columns[c]) for r, c in zip(*optimize.linear_sum_assignment(cost)) if cost[r, c] < 1e9]

    def _associate(self, pts: int, found: list[Detection]) -> None:
        target = float(self.settings["target_px"])
        radius: dict[int, float] = {}
        self._prune(pts)
        for row, live in enumerate(self.live):
            live.predict(pts, self.tick_seconds)
            radius[row] = self.max_speed * max(self.seconds(pts - live.last_pts), 1 / self.fps) + target
        matched_live: set[int] = set()
        matched_found: set[int] = set()
        confirmed = [row for row, live in enumerate(self.live) if live.hits >= CONSTANTS["confirm_hits"]]
        tentative = [row for row, live in enumerate(self.live) if live.hits < CONSTANTS["confirm_hits"]]
        strong = [column for column, item in enumerate(found) if item.strong]
        weak = [column for column, item in enumerate(found) if not item.strong]
        for rows, columns in ((confirmed, strong), (confirmed, weak), (tentative, strong)):
            pairs = self._match([row for row in rows if row not in matched_live], [column for column in columns if column not in matched_found],
                                found, radius)
            for row, column in pairs:
                self.live[row].update(pts, found[column])
                matched_live.add(row)
                matched_found.add(column)
        for row, live in enumerate(self.live):
            if row not in matched_live:
                live.misses += 1
        self._prune(pts)
        for column, item in enumerate(found):
            if column in matched_found or not item.strong or item.static:
                continue
            velocity, sigma = self._birth_velocity(item.x, item.y)
            self.live.append(_Live(item, pts, self.epoch, self.measure, velocity, sigma, self.accel))
        self._learn_flow()

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
        span = self.seconds(self.last_pts - self.first_pts) if self.first_pts is not None and self.last_pts is not None else 0.0
        effective = ((self.index - self.stats["repeated_frames"]) / span) if span > 0 else self.fps
        joined = join_tracklets(self.done, effective, self.settings, self.seconds)
        for track in joined:
            classify(track, effective, self.settings, self.seconds)
        joined.sort(key=lambda track: track.points[0][0])
        qualities = [track.quality for track in joined]
        self.stats.update({"tracks": len(joined), "coherent": qualities.count("coherent"), "uncertain": qualities.count("uncertain"),
                           "noise": qualities.count("noise"), "joins": sum(track.joins for track in joined),
                           "effective_fps": round(effective, 2),
                           "events": {kind: sum(event.kind == kind for event in self.events) for kind in ("camera_moved", "lighting_change", "glitch")}})
        return joined, self.events, self.stats


def analyzer(version: str, width: int, height: int, fps: float, tick_seconds: float, settings: dict,
             record_detections: tuple[int, int] | None = None) -> Analyzer:
    """The analyzer for one algorithm version; runs keep the version they were made with."""
    if version != ALGORITHM_VERSION:
        raise ValueError("tracking_settings")
    return Analyzer(width, height, fps, tick_seconds, settings, record_detections)


def noise_clusters(detections: list[dict], found: list[Track], width: int, height: int, target: float) -> list[dict]:
    """Places where detections of a test run kept appearing without belonging to any non-noise track (flicker,
    foliage, a lamp): proposed exclusion rectangles for the user to accept or ignore, never applied by themselves."""
    if not detections:
        return []
    size = max(2 * target, width / 32)
    columns, rows = ceil(width / size), ceil(height / size)
    counts = np.zeros((rows, columns), dtype=np.int64)
    points: dict[int, list[tuple[float, float]]] = {}
    for track in found:
        if track.quality == "noise":
            continue
        for pts, x, y, _area in track.points:
            points.setdefault(int(pts), []).append((x, y))
    for item in detections:
        near = points.get(int(item["pts"]), [])
        for x0, y0, x1, y1 in item["accepted"]:
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            if any(abs(cx - x) <= 1.5 * target and abs(cy - y) <= 1.5 * target for x, y in near):
                continue
            counts[min(rows - 1, int(cy / size)), min(columns - 1, int(cx / size))] += 1
    busy = counts >= max(5, 0.2 * len(detections))
    labels, count = ndimage.label(busy, structure=np.ones((3, 3), dtype=bool))
    result = []
    for index, region in enumerate(ndimage.find_objects(labels), start=1):
        if region is None:
            continue
        x0 = max(0.0, region[1].start * size - target)
        y0 = max(0.0, region[0].start * size - target)
        x1 = min(float(width), region[1].stop * size + target)
        y1 = min(float(height), region[0].stop * size + target)
        result.append({"points": [[round(x0, 1), round(y0, 1)], [round(x1, 1), round(y0, 1)], [round(x1, 1), round(y1, 1)], [round(x0, 1), round(y1, 1)]],
                       "detections": int(counts[region][labels[region] == index].sum())})
    return sorted(result, key=lambda item: -item["detections"])[:8]


def _ends(track: Track) -> tuple[float, float, float, float, float]:
    """Velocity in pixels per tick over up to five points at the end and at the start, and the median area."""
    def velocity(points):
        if len(points) < 2 or points[-1][0] == points[0][0]:
            return 0.0, 0.0
        ticks = points[-1][0] - points[0][0]
        return (points[-1][1] - points[0][1]) / ticks, (points[-1][2] - points[0][2]) / ticks
    end, start = velocity(track.points[-5:]), velocity(track.points[:5])
    return end[0], end[1], start[0], start[1], float(np.median([point[3] for point in track.points]))


def join_tracklets(found: list[Track], fps: float, settings: dict, seconds) -> list[Track]:
    """Join a track that ended to one that started shortly after where the first was heading (same epoch only)."""
    target = float(settings["target_px"])
    tracks_ = sorted(found, key=lambda track: track.points[0][0])
    if len(tracks_) < 2:
        return tracks_
    ends = [_ends(track) for track in tracks_]
    starts = np.array([[track.points[0][1], track.points[0][2]] for track in tracks_])
    tree = spatial.cKDTree(starts)
    per_tick = seconds(1)
    reach = settings["target_speed"] * target * fps * settings["join_gap_s"] + 2 * target
    cost: dict[tuple[int, int], float] = {}
    for a, first in enumerate(tracks_):
        vxa, vya, _, _, area_a = ends[a]
        end_pts, ex, ey = first.points[-1][0], first.points[-1][1], first.points[-1][2]
        for b in tree.query_ball_point([ex, ey], reach):
            second = tracks_[b]
            if a == b or second.epoch != first.epoch:
                continue
            gap = second.points[0][0] - end_pts
            gap_s = seconds(gap)
            if gap <= 0 or gap_s > settings["join_gap_s"]:
                continue
            _, _, vxb, vyb, area_b = ends[b]
            speed_a = np.hypot(vxa, vya) / (fps * per_tick)
            speed_b = np.hypot(vxb, vyb) / (fps * per_tick)
            frames = gap_s * fps
            distance = float(np.hypot(ex + vxa * gap - second.points[0][1], ey + vya * gap - second.points[0][2]))
            if distance > max(2 * target, 0.5 * speed_a * frames + target):
                continue
            if speed_a > 0.5 and speed_b > 0.5:
                cosine = (vxa * vxb + vya * vyb) / (np.hypot(vxa, vya) * np.hypot(vxb, vyb))
                if cosine < CONSTANTS["join_min_cos"]:
                    continue
            if max(area_a, area_b) / max(1.0, min(area_a, area_b)) > CONSTANTS["join_max_area_ratio"]:
                continue
            cost[(a, b)] = distance + gap_s
    links: dict[int, int] = {}
    if cost:
        rows = sorted({a for a, _ in cost})
        columns = sorted({b for _, b in cost})
        row_index, column_index = {a: i for i, a in enumerate(rows)}, {b: i for i, b in enumerate(columns)}
        matrix = np.full((len(rows), len(columns)), 1e9)
        for (a, b), value in cost.items():
            matrix[row_index[a], column_index[b]] = value
        for r, c in zip(*optimize.linear_sum_assignment(matrix)):
            if matrix[r, c] < 1e9:
                links[rows[r]] = columns[c]
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
    """Quality class and metrics at the effective frame rate (repeated frames excluded).

    Rules are versioned parameters, not approved ecological thresholds. A track must travel: its extent (the
    farthest point from its start) is used, so a bat that flies out and comes back is not mistaken for a static spot.
    """
    points = np.array([(p[0], p[1], p[2], p[3]) for p in track.points], dtype=float)
    duration = seconds(int(points[-1, 0] - points[0, 0]))
    steps = np.hypot(np.diff(points[:, 1]), np.diff(points[:, 2]))
    path = float(steps.sum())
    displacement = float(np.hypot(points[-1, 1] - points[0, 1], points[-1, 2] - points[0, 2]))
    extent = float(np.hypot(points[:, 1] - points[0, 1], points[:, 2] - points[0, 2]).max())
    expected = max(1, round(duration * fps) + 1)
    gap_ratio = max(0.0, 1 - len(points) / expected)
    size_cv = float(points[:, 3].std() / max(1.0, points[:, 3].mean()))
    track.metrics = {"duration_s": round(duration, 3), "points": len(points), "displacement_px": round(displacement, 1),
                     "extent_px": round(extent, 1), "path_px": round(path, 1),
                     "straightness": round(displacement / path, 3) if path > 0 else 0.0,
                     "size_cv": round(size_cv, 3), "gap_ratio": round(gap_ratio, 3), "joins": track.joins,
                     "contrast": round(float(np.mean(track.contrast)), 1) if track.contrast else 0.0}
    if extent < settings["min_displacement_targets"] * settings["target_px"] or duration < settings["min_track_s"]:
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
