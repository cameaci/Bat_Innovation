"""Tiny generated summary sources; output belongs only in a caller's temp directory."""

from __future__ import annotations

from collections.abc import Sequence
from fractions import Fraction
import json
from pathlib import Path
import sys

import av
import numpy as np


def encode_frames(path: Path, arrays: Sequence[np.ndarray], times_ms: Sequence[int],
                  origin_ms: int = 4500) -> None:
    """Lossless H.264 synthetic pixels with explicit source PTS, never index/FPS time."""
    if not arrays or len(arrays) != len(times_ms):
        raise ValueError("Provide one explicit source timestamp for each synthetic frame")
    path.parent.mkdir(parents=True, exist_ok=True)
    height, width = arrays[0].shape[:2]
    with av.open(str(path), "w", format="mp4") as output:
        stream = output.add_stream("libx264", rate=25)
        stream.width, stream.height, stream.pix_fmt = width, height, "yuv420p"
        stream.time_base = stream.codec_context.time_base = Fraction(1, 1000)
        stream.options = {"crf": "0", "preset": "ultrafast", "bf": "0", "g": "1", "threads": "1"}
        for pixels, milliseconds in zip(arrays, times_ms, strict=True):
            if pixels.shape != arrays[0].shape:
                raise ValueError("Synthetic frames must have fixed dimensions")
            frame = av.VideoFrame.from_ndarray(pixels, format="gray" if pixels.ndim == 2 else "rgb24")
            frame.pts, frame.time_base, frame.duration = origin_ms + milliseconds, Fraction(1, 1000), 40
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode():
            output.mux(packet)


def generate_summary_media(directory: Path) -> dict[str, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    result: dict[str, Path] = {}
    specs = {
        "quiet_65": ([0, 29960, 30000, 59960, 60000, 64960], [32]*6),
        "quiet_9": ([0, 8960], [48]*2),
        "empty_middle": ([0, 64960], [64]*2),
        "brightness_9": ([0, 2000, 4000, 8960], [32,32,96,96]),
        "single": ([0], [80]),
    }
    for name, (times, levels) in specs.items():
        path = directory / f"summary-{name.replace('_', '-')}.mp4"
        encode_frames(path, [np.full((48, 64), level, dtype=np.uint8) for level in levels], times)
        result[name] = path
    return result


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python backend/tests/summary_fixtures.py TEMPORARY_DIRECTORY")
    print(json.dumps({name: str(path) for name, path in generate_summary_media(Path(sys.argv[1])).items()}))
