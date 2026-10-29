"""The enhanced display (Phase 3 X5): faint movers become coloured trails, the static scene stays dim."""

from __future__ import annotations

import numpy as np

from backend.app.enhance import PARAMETERS, Enhancer


def scene(frames: int, contrast: float, seed: int = 3) -> list[np.ndarray]:
    rng = np.random.default_rng(seed)
    base = rng.integers(60, 140, size=(90, 160)).astype(np.float32)
    result = []
    for index in range(frames):
        image = base + rng.normal(0, 2, base.shape)
        x = 10 + 3 * index
        if index >= 30 and x < 150:
            image[40:43, x:x + 3] += contrast
        result.append(np.clip(image, 0, 255).astype(np.uint8))
    return result


def test_a_faint_mover_leaves_a_warm_trail_and_a_cold_one_a_blue_trail() -> None:
    for contrast, channel in ((14, 0), (-14, 2)):
        enhancer = Enhancer(25.0)
        out = [enhancer.frame(image) for image in scene(45, contrast)]
        last = out[-1].astype(int)
        trail = last[40:43, 60:140]
        quiet = last[70:85, 20:140]
        # The trail behind the target is coloured in its polarity; the scene elsewhere is dimmed grey.
        assert trail[..., channel].max() > 150, contrast
        assert quiet.max() <= 140 * PARAMETERS["scene_level"] + 10
        assert (np.abs(quiet[..., 0] - quiet[..., 2]) > 2).mean() < 0.01, "the static scene stays grey (rare noise blips aside)"



def test_a_lighting_jump_does_not_flood_the_view() -> None:
    frames = scene(30, 0)
    jumped = [np.clip(image.astype(int) + 40, 0, 255).astype(np.uint8) for image in scene(5, 0, seed=4)]
    enhancer = Enhancer(25.0)
    out = [enhancer.frame(image) for image in frames + jumped]
    coloured = np.abs(out[-1][..., 0].astype(int) - out[-1][..., 2].astype(int)) > 30
    assert coloured.mean() < 0.01
