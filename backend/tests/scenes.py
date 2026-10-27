"""Deterministic synthetic emergence scenes with exact ground truth (Phase 3 X2).

Each scene is a list of grey frames at 25 fps (PTS in milliseconds), the bats' true paths and a counting gate. The
generator reproduces the failure modes measured on the reference clips: textured backgrounds whose temporal noise
grows with texture, camera gain steps, repeated frames from frame-rate conversion, motion blur, dark (cold) targets,
a bat resting at the exit before leaving, and dense streams. Scenes are synthetic: they test the method, never the
ecological accuracy on real footage (E8).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from math import hypot

import numpy as np

from backend.app import gates

FPS = 25
W, H = 320, 240


@dataclass
class Bat:
    path: list[tuple[int, float, float]]  # frame index, x, y
    radius: float = 2.5
    contrast: float = 60.0  # grey levels above (or below, if negative) the local background


@dataclass
class Scene:
    name: str
    frames: list[np.ndarray]
    times_ms: list[int]
    bats: list[Bat]
    gate: dict
    settings: dict = field(default_factory=dict)

    def truth(self) -> list[tuple[int, str]]:
        """(frame index, direction) of every true crossing, using the app's own gate rule on the true paths."""
        result = []
        for bat in self.bats:
            path = [(frame, x, y) for frame, x, y in bat.path]
            result += gates.crossings(path, self.gate)
        return sorted(result)


def line_gate(x: float) -> dict:
    return {"kind": "line", "points": [[x, 10], [x, H - 10]], "hysteresis_px": 2, "frame_w": W, "frame_h": H}


def _background(kind: str, rng: np.random.Generator) -> np.ndarray:
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    if kind == "sky":
        return 40 + 25 * yy / H
    # Fractal "stone": octaves of smoothed noise, high local contrast like the O-GEO facade.
    image = np.zeros((H, W), np.float32)
    for scale, weight in ((32, 40), (16, 25), (8, 18), (4, 10)):
        coarse = rng.normal(0, 1, (H // scale + 2, W // scale + 2)).astype(np.float32)
        image += weight * np.kron(coarse, np.ones((scale, scale), np.float32))[:H, :W]
    base = 120 + image
    return np.clip(base if kind == "stone" else base + 40, 10, 245)


def _texture(background: np.ndarray) -> np.ndarray:
    """Local contrast, which sets the temporal flicker: compression and sensors are noisier on texture."""
    gy, gx = np.gradient(background)
    return np.clip(np.hypot(gx, gy), 0, 30)


def _draw(image: np.ndarray, bat: Bat, x: float, y: float, previous: tuple[float, float] | None) -> None:
    """A soft blob; with a previous position, a blur streak along the movement (a fast bat is a faint comet)."""
    steps = 1
    if previous is not None:
        steps = max(1, int(hypot(x - previous[0], y - previous[1]) / max(1.0, bat.radius)))
    r = int(bat.radius * 2 + 2)
    for step in range(steps):
        t = (step + 1) / steps
        cx = previous[0] + t * (x - previous[0]) if previous else x
        cy = previous[1] + t * (y - previous[1]) if previous else y
        x0, x1 = max(0, int(cx) - r), min(W, int(cx) + r + 1)
        y0, y1 = max(0, int(cy) - r), min(H, int(cy) + r + 1)
        if x0 >= x1 or y0 >= y1:
            continue
        yy, xx = np.mgrid[y0:y1, x0:x1]
        blob = np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * bat.radius ** 2)) * bat.contrast / steps ** 0.5
        image[y0:y1, x0:x1] += blob


def render(name: str, bats: list[Bat], count: int, background: str = "sky", seed: int = 1, gain_steps: tuple[int, ...] = (),
           repeat_every: int = 0, gate_x: float = W / 2, settings: dict | None = None) -> Scene:
    rng = np.random.default_rng(seed)
    base = _background(background, rng)
    flicker = 1.5 + 0.12 * _texture(base)
    positions: dict[int, list[tuple[Bat, float, float, tuple[float, float] | None]]] = {}
    for bat in bats:
        previous = None
        for frame, x, y in bat.path:
            positions.setdefault(frame, []).append((bat, x, y, previous))
            previous = (x, y)
    frames: list[np.ndarray] = []
    gain, offset = 1.0, 0.0
    for index in range(count):
        if index in gain_steps:
            gain, offset = gain * 1.12, offset - 6
        if repeat_every and index % repeat_every == 1 and frames:
            frames.append(frames[-1].copy())  # a repeated frame, as after frame-rate conversion
            continue
        image = base + rng.normal(0, 1, (H, W)).astype(np.float32) * flicker
        for bat, x, y, previous in positions.get(index, []):
            _draw(image, bat, x, y, previous)
        frames.append(np.clip(image * gain + offset, 0, 255).astype(np.uint8))
    return Scene(name, frames, [index * 1000 // FPS for index in range(count)], bats, line_gate(gate_x), settings or {})


def _straight(start_frame: int, x0: float, y0: float, vx: float, vy: float, count: int, **kwargs) -> Bat:
    path = [(start_frame + i, x0 + vx * i, y0 + vy * i) for i in range(count)]
    return Bat([(f, x, y) for f, x, y in path if -10 <= x <= W + 10 and -10 <= y <= H + 10], **kwargs)


def trickle(rng: np.random.Generator, bats: int, frames: int, contrast: float = 60, speed: float = 6, radius: float = 2.5) -> list[Bat]:
    """Bats leaving left to right at random heights and times; every fifth one turns back (a re-entry)."""
    result = []
    for number in range(bats):
        start = int(rng.integers(0, frames - 60))
        y = float(rng.uniform(30, H - 30))
        vx, vy = speed * float(rng.uniform(0.8, 1.2)), float(rng.uniform(-1, 1))
        if number % 5 == 4:
            out = [(start + i, 20 + vx * i, y + vy * i) for i in range(30)]
            back = [(start + 30 + i, out[-1][1] - vx * i, out[-1][2]) for i in range(1, 30)]
            result.append(Bat(out + back, radius=radius, contrast=contrast))
        else:
            result.append(_straight(start, 10, y, vx, vy, 60, radius=radius, contrast=contrast))
    return result


def scenarios() -> dict[str, Scene]:
    """The benchmark set. Sizes and counts keep the whole set to seconds of CPU per tracker version."""
    rng = np.random.default_rng(11)
    frames = 200
    trickle_bats = trickle(rng, 10, frames)
    result = {
        "sky_trickle": render("sky_trickle", trickle_bats, frames, settings={"target_px": 6, "polarity": "light"}),
        "stone_trickle": render("stone_trickle", trickle(np.random.default_rng(12), 10, frames, contrast=45), frames, background="stone",
                                settings={"target_px": 6}),
        "gain_steps": render("gain_steps", trickle_bats, frames, gain_steps=(50, 110, 160), background="stone",
                             settings={"target_px": 6}),
        "repeated_frames": render("repeated_frames", trickle(np.random.default_rng(13), 10, frames, speed=4), frames, repeat_every=2,
                                  settings={"target_px": 6, "polarity": "light"}),
        "cold_bats": render("cold_bats", trickle(np.random.default_rng(14), 8, frames, contrast=-50), frames, background="wall",
                            settings={"target_px": 6, "polarity": "dark"}),
        "fast_blur": render("fast_blur", trickle(np.random.default_rng(15), 8, frames, contrast=50, speed=16, radius=2.0), frames,
                            settings={"target_px": 6, "polarity": "light"}),
        "empty_stone": render("empty_stone", [], frames, background="stone", gain_steps=(70, 140), settings={"target_px": 6}),
    }
    # A bat resting at the exit for two seconds, then leaving across the gate.
    rest = [(i, 120.0, 120.0) for i in range(20, 70)] + [(70 + i, 120 + 6.0 * i, 120.0) for i in range(1, 30)]
    result["resting_bat"] = render("resting_bat", [Bat(rest, contrast=70)], frames, gate_x=180,
                                   settings={"target_px": 6, "polarity": "light"})
    # A dense stream: 150 small bats in 4 s, flowing right with jitter, several in every frame.
    dense_rng = np.random.default_rng(16)
    stream = []
    for _ in range(150):
        start = int(dense_rng.integers(0, 100))
        y = float(dense_rng.uniform(20, H - 20))
        stream.append(_straight(start, 0, y, float(dense_rng.uniform(7, 10)), float(dense_rng.uniform(-1.5, 1.5)), 45,
                                radius=1.8, contrast=55))
    result["dense_stream"] = render("dense_stream", stream, 150, settings={"target_px": 5, "polarity": "light", "activity": "dense"})
    return result
