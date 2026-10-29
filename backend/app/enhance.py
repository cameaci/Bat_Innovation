"""The enhanced display ("motion boost", Phase 3 X5): faint and fast targets drawn as fading coloured trails over a
dimmed scene, after DarkFlight UltraVision. A display aid derived from the original, never evidence.

Per frame, in the copy's resolution: a background as the median of recent samples (a quarter second apart) and each
pixel's temporal noise from the same samples (the smaller of the deviation from the median and the successive
differences, so neither a slow target nor a lighting step inflates it); contrast in noise units after a light
Gaussian; a persistence trail per polarity that keeps the strongest contrast and fades with a fixed half-life. The
output is the scene at a third of its brightness in grey, with lighter-than-scene trails in orange and
darker-than-scene trails in blue. Camera gain drift is fitted and undone first, and a frame where much of the image
changes at once (a lighting jump, a keyframe, a camera move) adds nothing to the trails. Every constant is versioned in
PARAMETERS.
"""

from __future__ import annotations

from collections import deque

import numpy as np
from scipy import ndimage

PARAMETERS = {"version": "enhance-v2", "samples": 9, "samples_per_second": 4, "sigma_px": 1.5, "floor": 0.5,
              "start_z": 5.0, "full_z": 12.0, "disturbed_fraction": 0.03, "max_gain_change": 10.0, "half_life_s": 1.0, "scene_level": 0.35,
              "warm_rgb": [255, 150, 30], "cold_rgb": [60, 170, 255]}


def _median(stack: np.ndarray) -> np.ndarray:
    """Median along the first axis of a few samples: sorting nine values per pixel is faster than a partition."""
    ordered = np.sort(stack, axis=0)
    middle = len(stack) // 2
    return ordered[middle] if len(stack) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


class Enhancer:
    def __init__(self, fps: float):
        self.spacing = max(1, round(fps / PARAMETERS["samples_per_second"]))
        self.decay = 0.5 ** (1 / (PARAMETERS["half_life_s"] * max(fps, 1e-6)))
        self.samples: deque[np.ndarray] = deque(maxlen=PARAMETERS["samples"])
        self.index = 0
        self.background: np.ndarray | None = None
        self.noise: np.ndarray | None = None
        self.light: np.ndarray | None = None
        self.dark: np.ndarray | None = None

    def _model(self) -> None:
        stack = np.stack(self.samples)
        self.background = _median(stack)
        if len(self.samples) >= 3:
            # The noise map is coarse (the largest nearby value), so it is estimated on every second pixel: the same
            # map at a quarter of the cost, scaled back to the frame.
            rows, columns = stack.shape[1:]
            half = stack[:, ::2, ::2]
            smoothed = ndimage.gaussian_filter(half, (0, PARAMETERS["sigma_px"] / 2, PARAMETERS["sigma_px"] / 2))
            deviation = _median(np.abs(smoothed - _median(smoothed))) * 1.4826
            steps = _median(np.abs(np.diff(smoothed, axis=0))) * 1.4826 / np.sqrt(2)
            coarse = ndimage.maximum_filter(np.minimum(deviation, steps), size=3)
            self.noise = np.maximum(np.repeat(np.repeat(coarse, 2, axis=0), 2, axis=1)[:rows, :columns], PARAMETERS["floor"]).astype(np.float32)
        else:
            self.noise = np.full(stack.shape[1:], 4.0 * PARAMETERS["floor"], np.float32)

    def _compensated(self, image: np.ndarray) -> np.ndarray:
        """Undo a camera gain or offset drift against the background (fitted on quiet pixels), as the tracker does;
        larger changes are left visible."""
        assert self.background is not None and self.noise is not None
        difference = image - self.background
        # The typical offset from a regular 1-in-16 sample of pixels: the same estimate at a sixteenth of the cost.
        quiet = np.abs(difference - float(np.median(difference[::4, ::4]))) < 3 * self.noise
        if int(quiet.sum()) < 100:
            return image
        b, d = self.background[quiet], image[quiet]
        variance = float(b.var())
        gain = min(1.5, max(0.67, float(((b - b.mean()) * (d - d.mean())).mean() / variance) if variance > 1e-6 else 1.0))
        offset = float(d.mean() - gain * b.mean())
        if abs(gain - 1) * float(b.mean()) + abs(offset) > PARAMETERS["max_gain_change"]:
            return image
        return (image - offset) / gain

    def frame(self, gray: np.ndarray) -> np.ndarray:
        """RGB uint8 of the enhanced view for one grey frame (frames must arrive in order)."""
        image = gray.astype(np.float32)
        if self.index % self.spacing == 0:
            self.samples.append(image)
            self._model()
        self.index += 1
        assert self.background is not None and self.noise is not None
        z = ndimage.gaussian_filter((self._compensated(image) - self.background).astype(np.float32), PARAMETERS["sigma_px"]) / self.noise
        span = PARAMETERS["full_z"] - PARAMETERS["start_z"]
        light = np.clip((z - PARAMETERS["start_z"]) / span, 0, 1)
        dark = np.clip((-z - PARAMETERS["start_z"]) / span, 0, 1)
        if float(((light > 0) | (dark > 0)).mean()) > PARAMETERS["disturbed_fraction"]:
            # A lighting jump, a keyframe or a camera move lights up much of the frame: no target stands out there,
            # so the frame adds nothing to the trails rather than flooding the view.
            light = dark = np.zeros_like(z)
        self.light = light if self.light is None else np.maximum(self.light * self.decay, light)
        self.dark = dark if self.dark is None else np.maximum(self.dark * self.decay, dark)
        scene = image * PARAMETERS["scene_level"] * (1 - np.maximum(self.light, self.dark))
        out = np.empty((*image.shape, 3), np.uint8)
        for channel, (warm, cold) in enumerate(zip(PARAMETERS["warm_rgb"], PARAMETERS["cold_rgb"])):
            out[..., channel] = np.clip(scene + self.light * np.float32(warm) + self.dark * np.float32(cold), 0, 255)
        return out
