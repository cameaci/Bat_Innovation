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

PARAMETERS = {"version": "enhance-v1", "samples": 9, "samples_per_second": 4, "sigma_px": 1.5, "floor": 0.5,
              "start_z": 5.0, "full_z": 12.0, "disturbed_fraction": 0.03, "max_gain_change": 10.0, "half_life_s": 1.0, "scene_level": 0.35,
              "warm_rgb": [255, 150, 30], "cold_rgb": [60, 170, 255]}


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
        self.background = np.median(stack, axis=0)
        if len(self.samples) >= 3:
            smoothed = ndimage.gaussian_filter(stack, (0, PARAMETERS["sigma_px"], PARAMETERS["sigma_px"]))
            deviation = np.median(np.abs(smoothed - np.median(smoothed, axis=0)), axis=0) * 1.4826
            steps = np.median(np.abs(np.diff(smoothed, axis=0)), axis=0) * 1.4826 / np.sqrt(2)
            self.noise = np.maximum(ndimage.maximum_filter(np.minimum(deviation, steps), size=5), PARAMETERS["floor"])
        else:
            self.noise = np.full(stack.shape[1:], 4.0 * PARAMETERS["floor"], np.float32)

    def _compensated(self, image: np.ndarray) -> np.ndarray:
        """Undo a camera gain or offset drift against the background (fitted on quiet pixels), as the tracker does;
        larger changes are left visible."""
        assert self.background is not None and self.noise is not None
        difference = image - self.background
        quiet = np.abs(difference - np.median(difference)) < 3 * self.noise
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
        z = ndimage.gaussian_filter(self._compensated(image) - self.background, PARAMETERS["sigma_px"]) / self.noise
        span = PARAMETERS["full_z"] - PARAMETERS["start_z"]
        light = np.clip((z - PARAMETERS["start_z"]) / span, 0, 1)
        dark = np.clip((-z - PARAMETERS["start_z"]) / span, 0, 1)
        if float(((light > 0) | (dark > 0)).mean()) > PARAMETERS["disturbed_fraction"]:
            # A lighting jump, a keyframe or a camera move lights up much of the frame: no target stands out there,
            # so the frame adds nothing to the trails rather than flooding the view.
            light = dark = np.zeros_like(z)
        self.light = light if self.light is None else np.maximum(self.light * self.decay, light)
        self.dark = dark if self.dark is None else np.maximum(self.dark * self.decay, dark)
        scene = (image * PARAMETERS["scene_level"])[..., None]
        out = scene * (1 - np.maximum(self.light, self.dark))[..., None]
        out = out + self.light[..., None] * np.array(PARAMETERS["warm_rgb"], np.float32)
        out = out + self.dark[..., None] * np.array(PARAMETERS["cold_rgb"], np.float32)
        return np.clip(out, 0, 255).astype(np.uint8)
